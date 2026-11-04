import type { PermissionDenialDetails } from "@oh-my-pi/pi-wire";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseXdUrl } from "../internal-urls/xd-protocol";
import {
	assertActiveOperationLease,
	getActiveOperationDurability,
	getActiveOperationLease,
} from "../registry/operation-lease";
import { withAuthorityEffect } from "../registry/authority/client";
import { durableTargetHash, type DurableResourceClass, type DurableResourceRecord } from "../registry/durable-state";
import type { EffectiveSubagentPermissions } from "../task/permission-profiles";
import { evaluateSubagentPermission } from "../task/permission-profiles";
import { expandDelimitedPathEntries, isInternalUrlPath, resolveSyscallTarget } from "../tools/path-utils";
import { evaluateRestrictedToolGuardrails } from "./restricted-startup-policy";

const filesystemOperationContext = new AsyncLocalStorage<FilesystemOperation>();

/** Transitive readers use the invoking operation, including a revoked one that must fail closed. */
export function getCurrentFilesystemOperation(): FilesystemOperation | undefined {
	return filesystemOperationContext.getStore();
}

export interface SessionPathScopeOptions {
	readonly actorId: () => string | null | undefined;
	readonly sessionId: () => string | null | undefined;
	/** Session manager whose active effect lease must enclose restricted operations. */
	readonly operationManager?: () => object | undefined;
	readonly cwd: () => string;
	readonly permissionScope: () => EffectiveSubagentPermissions | undefined;
	readonly recordPermissionDenial?: (details: PermissionDenialDetails) => void;
}

export interface FilesystemOperationLease {
	readonly operationId: string;
	readonly actorId: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly effectClass?: string;
	readonly effectOwnerId?: string;
	readonly effectAcquiredAt?: number;
	readonly rootId?: string;
	readonly authorityGeneration?: number;
}

export interface DurableOpenResource {
	effect(): Promise<void>;
	complete(): Promise<void>;
	cancel(): Promise<void>;
}

/** Only a physical read-open denial, never an authority or terminal failure. */
export class FilesystemReadDeniedError extends Error {}

async function cancelDurableResource(resource: DurableOpenResource | undefined, cause: unknown): Promise<void> {
	try {
		await resource?.cancel();
	} catch (finalizeError) {
		throw new AggregateError(
			[cause, finalizeError],
			"Filesystem operation failed and durable resource cancellation did not complete.",
		);
	}
}

async function closeSearchResource(
	resource: { close(): Promise<void> },
	failure: { error: unknown } | undefined,
): Promise<void> {
	try {
		await resource.close();
	} catch (closeError) {
		if (failure)
			throw new AggregateError(
				[failure.error, closeError],
				"Search traversal failed and resource close did not complete.",
			);
		throw closeError;
	}
}

export type FilesystemOperationKind =
	| "probe"
	| "read"
	| "stat"
	| "list"
	| "search"
	| "write"
	| "create"
	| "rename"
	| "delete";

export interface FilesystemTargetCandidate {
	readonly path: string;
	readonly kind: FilesystemOperationKind;
}

export interface FilesystemIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
}

declare const authorizedFilesystemTargetBrand: unique symbol;

/** Opaque proof that one live operation authorized one canonical syscall target. */
export interface AuthorizedFilesystemTarget {
	readonly originalPath: string;
	readonly canonicalTarget: string;
	readonly canonicalParent: string;
	readonly kind: FilesystemOperationKind;
	readonly existed: boolean;
	readonly isFile: boolean;
	readonly size: bigint;
	readonly identity?: FilesystemIdentity;
	readonly parentIdentity: FilesystemIdentity;
	readonly [authorizedFilesystemTargetBrand]: true;
}
export interface AuthorizedSearchEntry {
	readonly path: string;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly size: bigint;
	readonly mtimeMs: number;
	readonly content?: string;
}

export interface AuthorizedSearchWalkOptions {
	readonly signal?: AbortSignal;
	readonly deadline?: number;
	readonly gitignore?: boolean;
	readonly readFiles?: boolean;
	readonly include?: (entry: Omit<AuthorizedSearchEntry, "content">) => boolean;
	readonly descend?: (entry: Omit<AuthorizedSearchEntry, "content">) => boolean;
	readonly visit?: (entry: AuthorizedSearchEntry) => void | Promise<void>;
	readonly stop?: () => boolean;
}

const PATH_KEYS = new Set([
	"path",
	"paths",
	"file",
	"files",
	"file_path",
	"relative_path",
	"dir",
	"directory",
	"target",
	"source",
	"destination",
	"from",
	"to",
]);
const operationConstructionKey = Symbol("FilesystemOperation");
const authorizedTargets = new WeakSet<object>();

function pathValues(value: unknown, key?: string, depth = 0): string[] {
	if (depth > 8) return [];
	if (typeof value === "string") return key !== undefined && PATH_KEYS.has(key.toLowerCase()) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap(item => pathValues(item, key, depth + 1));
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([entryKey, entryValue]) => pathValues(entryValue, entryKey, depth + 1));
}

function isNonFilesystemPath(pathArg: string): boolean {
	return isInternalUrlPath(pathArg) || parseXdUrl(pathArg) !== null;
}

function identityOf(stat: fs.BigIntStats): FilesystemIdentity {
	return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

interface GitignoreRule {
	readonly basePath: string;
	readonly negated: boolean;
	readonly directoryOnly: boolean;
	readonly exact: RegExp;
}

function escapeRegex(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function gitignoreGlobSource(pattern: string): string {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === "\\" && index + 1 < pattern.length) {
			source += escapeRegex(pattern[++index]);
			continue;
		}
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				while (pattern[index + 1] === "*") index++;
				if (pattern[index + 1] === "/") {
					index++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (character === "?") {
			source += "[^/]";
			continue;
		}
		if (character === "[") {
			const end = pattern.indexOf("]", index + 1);
			if (end !== -1) {
				let content = pattern.slice(index + 1, end);
				let negated = false;
				if (content.startsWith("!")) {
					negated = true;
					content = content.slice(1);
				}
				if (content.startsWith("^")) content = `\\${content}`;
				source += `[${negated ? "^" : ""}${content.replace(/\\/g, "\\\\")}]`;
				index = end;
				continue;
			}
		}
		source += character === "/" ? "/" : escapeRegex(character);
	}
	return source;
}

function trimUnescapedTrailingSpaces(pattern: string): string {
	let end = pattern.length;
	while (end > 0 && pattern[end - 1] === " ") {
		let backslashes = 0;
		for (let index = end - 2; index >= 0 && pattern[index] === "\\"; index--) backslashes++;
		if (backslashes % 2 === 1) break;
		end--;
	}
	return pattern.slice(0, end);
}

function parseGitignore(content: string, basePath: string): GitignoreRule[] {
	const rules: GitignoreRule[] = [];
	for (const rawLine of content.split("\n")) {
		let pattern = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		pattern = trimUnescapedTrailingSpaces(pattern);
		if (!pattern.trim() || pattern.startsWith("#")) continue;
		let negated = false;
		if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
			pattern = pattern.slice(1);
		} else if (pattern.startsWith("!")) {
			negated = true;
			pattern = pattern.slice(1);
		}
		if (!pattern) continue;
		const directoryOnly = pattern.endsWith("/");
		if (directoryOnly) pattern = pattern.slice(0, -1);
		const anchored = pattern.startsWith("/");
		if (anchored) pattern = pattern.slice(1);
		if (!pattern) continue;
		const source = gitignoreGlobSource(pattern);
		const prefix = anchored || pattern.includes("/") ? "^" : "(?:^|/)";
		rules.push({
			basePath,
			negated,
			directoryOnly,
			exact: new RegExp(`${prefix}${source}$`),
		});
	}
	return rules;
}

function isGitignored(entryPath: string, isDirectory: boolean, rules: readonly GitignoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		const relative = path.relative(rule.basePath, entryPath).replace(/\\/g, "/");
		if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
		if (rule.exact.test(relative) && (!rule.directoryOnly || isDirectory)) {
			ignored = !rule.negated;
		}
	}
	return ignored;
}

async function lstatIdentity(filePath: string): Promise<FilesystemIdentity | undefined> {
	try {
		return identityOf(await fs.promises.lstat(filePath, { bigint: true }));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function statIdentity(filePath: string): Promise<FilesystemIdentity> {
	return identityOf(await fs.promises.stat(filePath, { bigint: true }));
}

function heldParentChildPath(parentHandle: fs.promises.FileHandle, target: AuthorizedFilesystemTarget): string {
	if (process.platform !== "linux") {
		throw new Error("Exact parent-relative filesystem effects require Linux /proc/self/fd support.");
	}
	return `/proc/self/fd/${parentHandle.fd}/${path.basename(target.canonicalTarget)}`;
}

function operationKindForTool(toolName: string, followFinal: boolean): FilesystemOperationKind {
	if (toolName === "delete") return "delete";
	if (toolName === "write") return "write";
	if (toolName === "edit" || toolName === "ast_edit" || toolName === "lsp") return followFinal ? "write" : "create";
	if (toolName === "glob" || toolName === "grep" || toolName === "ast_grep") return "search";
	return followFinal ? "read" : "stat";
}

function followsFinal(kind: FilesystemOperationKind): boolean {
	return kind !== "delete" && kind !== "create" && kind !== "rename";
}

/** Independently minted, single-invocation filesystem capability. */
export class FilesystemOperation {
	readonly lease: FilesystemOperationLease;
	readonly #scope: SessionPathScope;
	readonly #toolName: string;
	readonly #usedEffects = new WeakSet<object>();
	#active = true;
	#nextResourceId = 1;
	readonly #openResources = new Set<DurableOpenResource>();
	readonly #effectResources = new Set<DurableOpenResource>();

	constructor(key: symbol, scope: SessionPathScope, toolName: string, lease: FilesystemOperationLease) {
		if (key !== operationConstructionKey)
			throw new Error("Filesystem operations can only be minted by SessionPathScope.");
		this.#scope = scope;
		this.#toolName = toolName;
		this.lease = lease;
	}

	get operationId(): string {
		return this.lease.operationId;
	}

	get actorId(): string {
		return this.lease.actorId;
	}

	get sessionId(): string {
		return this.lease.sessionId;
	}

	assertActive(): void {
		if (!this.#active) throw new Error("Filesystem operation is terminal or disposed.");
		this.#scope.assertOperationIdentity(this);
	}

	/**
	 * Traverse a search root without handing an un-authorized recursive path to
	 * a native scanner. Each child is authorized and opened before its metadata,
	 * name, or content is returned to the caller. The returned file contents are
	 * read from that opened handle and callers must not reopen them by path.
	 */
	async walkAuthorized(
		root: AuthorizedFilesystemTarget,
		options: AuthorizedSearchWalkOptions = {},
	): Promise<readonly AuthorizedSearchEntry[]> {
		this.assertTarget(root, "search");
		const entries: AuthorizedSearchEntry[] = [];
		const include = options.include ?? (() => true);
		const descend = options.descend ?? (() => true);
		const checkActive = (): void => {
			this.assertActive();
			if (options.signal?.aborted) throw new Error("Search traversal aborted.");
			if (options.deadline !== undefined && Date.now() >= options.deadline) {
				throw new Error("Search traversal timed out; narrow paths or pattern.");
			}
		};
		const visit = async (
			target: AuthorizedFilesystemTarget,
			rules: readonly GitignoreRule[],
			applyRules: boolean,
		): Promise<void> => {
			if (options.stop?.()) return;
			checkActive();
			const handle = await this.openRead(target);
			let traversalFailure: { error: unknown } | undefined;
			try {
				checkActive();
				const stat = await handle.stat({ bigint: true });
				checkActive();
				const base: Omit<AuthorizedSearchEntry, "content"> = Object.freeze({
					path: target.canonicalTarget,
					isFile: stat.isFile(),
					isDirectory: stat.isDirectory(),
					size: stat.size,
					mtimeMs: Number(stat.mtimeMs),
				});
				const ignored =
					options.gitignore === true && applyRules && isGitignored(base.path, base.isDirectory, rules);
				const selected = !ignored && include(base);
				if (selected && base.isFile) {
					checkActive();
					const content = options.readFiles ? await handle.readFile({ encoding: "utf8" }) : undefined;
					checkActive();
					const entry = content === undefined ? base : Object.freeze({ ...base, content });
					if (options.visit) await options.visit(entry);
					else entries.push(entry);
				} else if (selected) {
					if (options.visit) await options.visit(base);
					else entries.push(base);
				}
				checkActive();
				if (ignored || !base.isDirectory || !descend(base)) return;
				if (process.platform !== "linux") {
					throw new Error("Exact filesystem traversal requires Linux /proc/self/fd support.");
				}
				checkActive();
				const directoryPath = `/proc/self/fd/${handle.fd}`;
				let childRules = rules;
				let ignoreTarget: AuthorizedFilesystemTarget | undefined;
				if (options.gitignore === true) {
					const ruleDirectory = await fs.promises.opendir(directoryPath);
					let ruleFailure: { error: unknown } | undefined;
					try {
						for (;;) {
							if (options.stop?.()) return;
							checkActive();
							const child = await ruleDirectory.read();
							if (child === null) break;
							if (child.name !== ".gitignore") continue;
							try {
								ignoreTarget = await this.authorize(path.join(target.canonicalTarget, child.name), "search");
							} catch {
								break;
							}
							checkActive();
							const ignoreHandle = await this.openRead(ignoreTarget);
							let ignoreFailure: { error: unknown } | undefined;
							try {
								checkActive();
								const ignoreStat = await ignoreHandle.stat({ bigint: true });
								if (ignoreStat.isFile()) {
									checkActive();
									const ignoreContent = await ignoreHandle.readFile({ encoding: "utf8" });
									checkActive();
									childRules = [...rules, ...parseGitignore(ignoreContent, target.canonicalTarget)];
								}
							} catch (error) {
								ignoreFailure = { error };
								throw error;
							} finally {
								await closeSearchResource(ignoreHandle, ignoreFailure);
							}
							break;
						}
					} catch (error) {
						ruleFailure = { error };
						throw error;
					} finally {
						await closeSearchResource(ruleDirectory, ruleFailure);
					}
				}

				const directory = await fs.promises.opendir(directoryPath);
				let directoryFailure: { error: unknown } | undefined;
				try {
					for (;;) {
						if (options.stop?.()) return;
						checkActive();
						const child = await directory.read();
						if (child === null) break;
						const childPath = path.join(target.canonicalTarget, child.name);
						let authorized = child.name === ".gitignore" ? ignoreTarget : undefined;
						if (!authorized) {
							try {
								authorized = await this.authorize(childPath, "search");
							} catch {
								continue;
							}
						}
						await visit(authorized, childRules, true);
					}
				} catch (error) {
					directoryFailure = { error };
					throw error;
				} finally {
					await closeSearchResource(directory, directoryFailure);
				}
			} catch (error) {
				traversalFailure = { error };
				throw error;
			} finally {
				await closeSearchResource(handle, traversalFailure);
			}
		};
		await visit(root, [], false);
		return Object.freeze(entries);
	}

	/** Resolve and authorize every candidate before returning any executable proof. */
	async preflight(candidates: readonly FilesystemTargetCandidate[]): Promise<readonly AuthorizedFilesystemTarget[]> {
		this.assertActive();
		const resolved = await Promise.all(candidates.map(candidate => this.#resolveCandidate(candidate)));
		this.assertActive();
		for (const target of resolved) this.#scope.assertPermission(this.#toolName, target.canonicalTarget);
		this.assertActive();
		return Object.freeze(resolved);
	}

	async authorize(pathArg: string, kind: FilesystemOperationKind): Promise<AuthorizedFilesystemTarget> {
		const [target] = await this.preflight([{ path: pathArg, kind }]);
		if (!target) throw new Error("Filesystem authority received no target.");
		return target;
	}

	async authorizeLocal(pathArg: string, kind: FilesystemOperationKind): Promise<AuthorizedFilesystemTarget> {
		this.assertActive();
		this.#scope.assertLocalAuthority(this);
		const target = await this.#resolveCandidate({ path: pathArg, kind });
		this.assertActive();
		return target;
	}

	assertTarget(
		target: AuthorizedFilesystemTarget,
		expected?: FilesystemOperationKind | readonly FilesystemOperationKind[],
	): void {
		this.assertActive();
		if (!authorizedTargets.has(target as object))
			throw new Error("Filesystem target proof is invalid or caller-forged.");
		const owner = targetOwners.get(target as object);
		if (owner !== this) throw new Error("Filesystem target belongs to a different operation.");
		if (expected) {
			const allowed = Array.isArray(expected) ? expected : [expected];
			if (!allowed.includes(target.kind))
				throw new Error(`Filesystem target kind '${target.kind}' cannot perform this operation.`);
		}
	}

	async verify(target: AuthorizedFilesystemTarget): Promise<void> {
		this.assertTarget(target);
		const parentIdentity = await statIdentity(target.canonicalParent);
		if (!sameIdentity(parentIdentity, target.parentIdentity)) {
			throw new Error(`Filesystem target parent changed after authorization: ${target.originalPath}`);
		}
		const identity = await lstatIdentity(target.canonicalTarget);
		if (target.existed) {
			if (!identity || !target.identity || !sameIdentity(identity, target.identity)) {
				throw new Error(`Filesystem target changed after authorization: ${target.originalPath}`);
			}
		} else if (identity) {
			throw new Error(`Filesystem target appeared after authorization: ${target.originalPath}`);
		}
		this.assertActive();
	}

	/** Open a read target once and validate the opened inode against the authorization proof. */
	async openRead(
		target: AuthorizedFilesystemTarget,
		resourceClass: DurableResourceClass = "filesystem",
	): Promise<fs.promises.FileHandle> {
		this.assertTarget(target, ["read", "stat", "list", "search"]);
		await this.verify(target);
		const resource = await this.beginOpenResource(target, resourceClass);
		try {
			this.assertActive();
			await resource?.effect();
			this.assertActive();
			const handle = await fs.promises
				.open(target.canonicalTarget, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code === "EACCES" || error.code === "EPERM")
						throw new FilesystemReadDeniedError("Filesystem read is denied", { cause: error });
					throw error;
				});
			try {
				const opened = identityOf(await handle.stat({ bigint: true }));
				if (!target.identity || !sameIdentity(opened, target.identity)) {
					throw new Error(`Filesystem target changed while opening: ${target.originalPath}`);
				}
				this.assertActive();
				if (resource) {
					const close = handle.close.bind(handle);
					let closePromise: Promise<void> | undefined;
					handle.close = () => {
						closePromise ??= (async () => {
							try {
								await close();
								await resource.complete();
								this.assertActive();
							} catch (error) {
								await cancelDurableResource(resource, error);
								throw error;
							}
						})();
						return closePromise;
					};
				}
				return handle;
			} catch (error) {
				await handle.close();
				throw error;
			}
		} catch (error) {
			await cancelDurableResource(resource, error);
			throw error;
		}
	}

	async beginOpenResource(
		target: AuthorizedFilesystemTarget,
		resourceClass: DurableResourceClass,
	): Promise<DurableOpenResource | undefined> {
		this.assertTarget(target);
		const durability = getActiveOperationDurability(this.#scope.operationManager(), this.operationId);
		this.assertActive();
		if (!durability || durability.lease.actorId === undefined || durability.lease.generation === undefined)
			return undefined;
		const base: Omit<DurableResourceRecord, "at" | "phase"> = {
			kind: "resource",
			resourceId: `${this.operationId}:resource:${this.#nextResourceId++}`,
			resourceClass,
			operationId: this.operationId,
			actorId: durability.lease.actorId,
			...(durability.lease.rootId === undefined ? {} : { rootId: durability.lease.rootId }),
			generation: durability.lease.generation,
			targetHash: durableTargetHash({
				actorId: durability.lease.actorId,
				generation: durability.lease.generation,
				operationId: this.operationId,
				canonicalTarget: target.canonicalTarget,
				identity: target.identity,
			}),
		};
		let phase: "intent" | "effect" | "committed" | "terminal" | "uncertain" = "intent";
		const transition = async (next: DurableResourceRecord["phase"]): Promise<void> => {
			try {
				await durability.store.transition({ ...base, at: Date.now(), phase: next });
			} catch (error) {
				phase = "uncertain";
				throw error;
			}
			phase = next === "intent" || next === "effect" || next === "committed" ? next : "terminal";
		};
		await transition("intent");
		const control: DurableOpenResource = Object.freeze({
			effect: async () => {
				if (phase !== "intent") throw new Error("Durable resource effect was already recorded.");
				this.assertActive();
				await transition("effect");
				this.assertActive();
			},
			complete: async () => {
				if (phase === "terminal") return;
				if (phase !== "effect") throw new Error("Durable resource cannot complete before its effect.");
				await transition("committed");
				await transition("completed");
				this.#openResources.delete(control);
			},
			cancel: async () => {
				if (phase === "terminal" || phase === "uncertain") return;
				await transition("cancelled");
				this.#openResources.delete(control);
			},
		});
		this.#openResources.add(control);
		try {
			this.assertActive();
			return control;
		} catch (error) {
			await cancelDurableResource(control, error);
			throw error;
		}
	}

	async withResourceEffects<T>(
		targets: readonly AuthorizedFilesystemTarget[],
		resourceClass: DurableResourceClass,
		effect: () => Promise<T>,
	): Promise<T> {
		const durability = getActiveOperationDurability(this.#scope.operationManager(), this.operationId);
		const run = async (): Promise<T> => {
			const resources: Array<DurableOpenResource | undefined> = [];
			try {
				for (const target of targets) {
					this.assertTarget(target, ["write", "create", "delete", "rename"]);
					await this.verify(target);
					const resource = await this.beginOpenResource(target, resourceClass);
					resources.push(resource);
					if (resource) this.#effectResources.add(resource);
					this.assertActive();
				}
				for (const resource of resources) {
					this.assertActive();
					await resource?.effect();
					this.assertActive();
				}
				for (let index = targets.length - 1; index >= 0; index--) {
					const target = targets[index];
					if (target) await this.verify(target);
				}
				this.assertActive();
				const value = await effect();
				for (const resource of resources) await resource?.complete();
				this.assertActive();
				return value;
			} catch (error) {
				let failure = error;
				for (let index = resources.length - 1; index >= 0; index--) {
					try {
						await cancelDurableResource(resources[index], failure);
					} catch (cancelError) {
						failure = cancelError;
					}
				}
				throw failure;
			} finally {
				for (const resource of resources) {
					if (resource) this.#effectResources.delete(resource);
				}
			}
		};
		return filesystemOperationContext.run(this, () =>
			durability ? withAuthorityEffect(durability.store, run) : run(),
		);
	}

	async createDirectories(directoryPath: string, resourceClass: DurableResourceClass = "filesystem"): Promise<void> {
		this.assertActive();
		const missing: string[] = [];
		let current = path.resolve(directoryPath);
		for (;;) {
			let stat: fs.Stats | undefined;
			try {
				stat = await fs.promises.stat(current);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			this.assertActive();
			if (stat) {
				if (!stat.isDirectory()) throw new Error(`Filesystem parent is not a directory: ${current}`);
				break;
			}
			missing.push(current);
			const parent = path.dirname(current);
			if (parent === current) throw new Error(`Filesystem parent directory could not be created: ${directoryPath}`);
			current = parent;
		}
		for (const directory of missing.reverse()) {
			const target = await this.authorize(directory, "create");
			await this.createDirectory(target, resourceClass);
		}
	}

	async createDirectory(
		target: AuthorizedFilesystemTarget,
		resourceClass: DurableResourceClass = "filesystem",
	): Promise<void> {
		this.assertTarget(target, "create");
		if (target.existed) throw new Error(`Filesystem directory already exists: ${target.originalPath}`);
		if (this.#usedEffects.has(target as object))
			throw new Error("Filesystem target effect has already been consumed.");
		await this.withResourceEffects([target], resourceClass, async () => {
			const parentHandle = await fs.promises.open(
				target.canonicalParent,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
			);
			try {
				const heldParent = identityOf(await parentHandle.stat({ bigint: true }));
				this.assertActive();
				if (!sameIdentity(heldParent, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed before directory creation: ${target.originalPath}`);
				}
				const heldTarget = heldParentChildPath(parentHandle, target);
				this.assertActive();
				await fs.promises.mkdir(heldTarget);
				const created = await fs.promises.lstat(heldTarget, { bigint: true });
				if (!created.isDirectory() || (await fs.promises.realpath(heldTarget)) !== target.canonicalTarget) {
					throw new Error(`Filesystem directory creation produced an unsafe target: ${target.originalPath}`);
				}
				const heldAfter = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldAfter, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed during directory creation: ${target.originalPath}`);
				}
			} finally {
				await parentHandle.close();
			}
			this.#usedEffects.add(target as object);
		});
	}

	/** Validate the final name after an API that may replace the inode atomically. */
	async verifyPostWrite(target: AuthorizedFilesystemTarget): Promise<void> {
		this.assertTarget(target, ["write", "create"]);
		const parentIdentity = await statIdentity(target.canonicalParent);
		if (!sameIdentity(parentIdentity, target.parentIdentity)) {
			throw new Error(`Filesystem target parent changed during write: ${target.originalPath}`);
		}
		const canonicalAfter = await fs.promises.realpath(target.canonicalTarget);
		if (canonicalAfter !== target.canonicalTarget) {
			throw new Error(`Filesystem target redirected during write: ${target.originalPath}`);
		}
		const after = await fs.promises.lstat(canonicalAfter, { bigint: true });
		if (!after.isFile() || after.nlink > 1n) {
			throw new Error(`Filesystem write produced an unsafe target: ${target.originalPath}`);
		}
		this.assertActive();
	}

	/** Write through an opened handle; authorization is never followed by a second ordinary open. */
	async writeFile(
		target: AuthorizedFilesystemTarget,
		payload: string | Uint8Array,
		resourceClass: DurableResourceClass = "filesystem",
	): Promise<void> {
		this.assertTarget(target, ["write", "create"]);
		if (this.#usedEffects.has(target as object))
			throw new Error("Filesystem target effect has already been consumed.");
		await this.verify(target);
		const resource = await this.beginOpenResource(target, resourceClass);
		try {
			this.assertActive();
			const parentHandle = await fs.promises.open(
				target.canonicalParent,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
			);
			let parentFailure: unknown;
			let parentFailed = false;
			try {
				const heldParent = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldParent, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed before write: ${target.originalPath}`);
				}
				await resource?.effect();
				this.assertActive();
				const flags =
					fs.constants.O_WRONLY |
					fs.constants.O_CREAT |
					fs.constants.O_NOFOLLOW |
					fs.constants.O_NONBLOCK |
					(target.existed ? 0 : fs.constants.O_EXCL);
				const handle = await fs.promises.open(heldParentChildPath(parentHandle, target), flags);
				try {
					const openedStat = await handle.stat({ bigint: true });
					const opened = identityOf(openedStat);
					if (!openedStat.isFile())
						throw new Error(`Refusing to write a non-regular file: ${target.originalPath}`);
					if (openedStat.nlink > 1n)
						throw new Error(`Refusing to write a file with multiple hard links: ${target.originalPath}`);
					if (target.identity && !sameIdentity(opened, target.identity)) {
						throw new Error(`Filesystem target changed while opening for write: ${target.originalPath}`);
					}
					if (!target.identity && target.existed)
						throw new Error(`Filesystem target identity is unavailable: ${target.originalPath}`);
					this.assertActive();
					await handle.truncate(0);
					this.assertActive();
					await handle.writeFile(payload);
					this.assertActive();
					const after = identityOf(await handle.stat({ bigint: true }));
					this.assertActive();
					if (!sameIdentity(opened, after))
						throw new Error(`Filesystem target changed during write: ${target.originalPath}`);
					this.#usedEffects.add(target as object);
				} finally {
					await handle.close();
				}
				const heldAfter = identityOf(await parentHandle.stat({ bigint: true }));
				this.assertActive();
				if (!sameIdentity(heldAfter, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed during write: ${target.originalPath}`);
				}
			} catch (error) {
				parentFailure = error;
				parentFailed = true;
				throw error;
			} finally {
				try {
					await parentHandle.close();
				} catch (closeError) {
					if (parentFailed) {
						throw new AggregateError(
							[parentFailure, closeError],
							"Filesystem write and parent close both failed.",
						);
					}
					throw closeError;
				}
			}
			this.assertActive();
			await resource?.complete();
			this.assertActive();
		} catch (error) {
			await cancelDurableResource(resource, error);
			throw error;
		}
	}

	/** Produce a temp file and atomically replace a sibling through one held parent identity. */
	async replaceFile(
		target: AuthorizedFilesystemTarget,
		temporary: AuthorizedFilesystemTarget,
		produce: (authorizedTemporaryPath: string) => Promise<void>,
	): Promise<void> {
		this.assertTarget(target, ["write", "create"]);
		this.assertTarget(temporary, "create");
		if (target.canonicalParent !== temporary.canonicalParent) {
			throw new Error("Atomic replacement targets must share one authorized parent.");
		}
		if (this.#usedEffects.has(target as object) || this.#usedEffects.has(temporary as object)) {
			throw new Error("Filesystem target effect has already been consumed.");
		}
		await this.verify(target);
		await this.verify(temporary);
		const resource = await this.beginOpenResource(target, "filesystem");
		try {
			this.assertActive();
			await resource?.effect();
			this.assertActive();
			const parentHandle = await fs.promises.open(
				target.canonicalParent,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
			);
			let heldTemporaryPath: string | undefined;
			let parentFailure: unknown;
			let parentFailed = false;
			try {
				heldTemporaryPath = heldParentChildPath(parentHandle, temporary);
				try {
					const heldParent = identityOf(await parentHandle.stat({ bigint: true }));
					if (
						!sameIdentity(heldParent, target.parentIdentity) ||
						!sameIdentity(heldParent, temporary.parentIdentity)
					) {
						throw new Error(`Filesystem target parent changed before replacement: ${target.originalPath}`);
					}
					this.assertActive();
					await produce(heldTemporaryPath);
					this.assertActive();
					const temporaryStat = await fs.promises.lstat(heldTemporaryPath, { bigint: true });
					if (!temporaryStat.isFile() || temporaryStat.nlink > 1n) {
						throw new Error(`Filesystem replacement produced an unsafe temp file: ${temporary.originalPath}`);
					}
					this.assertActive();
					await fs.promises.rename(heldTemporaryPath, heldParentChildPath(parentHandle, target));
					this.assertActive();
					const finalStat = await fs.promises.lstat(heldParentChildPath(parentHandle, target), { bigint: true });
					this.assertActive();
					if (!finalStat.isFile() || finalStat.nlink > 1n) {
						throw new Error(`Filesystem replacement produced an unsafe target: ${target.originalPath}`);
					}
					const heldAfter = identityOf(await parentHandle.stat({ bigint: true }));
					this.assertActive();
					if (!sameIdentity(heldAfter, target.parentIdentity)) {
						throw new Error(`Filesystem target parent changed during replacement: ${target.originalPath}`);
					}
					this.#usedEffects.add(target as object);
					this.#usedEffects.add(temporary as object);
				} catch (error) {
					if (heldTemporaryPath) {
						try {
							await fs.promises.rm(heldTemporaryPath, { force: true });
						} catch (cleanupError) {
							throw new AggregateError(
								[error, cleanupError],
								"Filesystem replacement failed and temporary-file cleanup did not complete.",
							);
						}
					}
					throw error;
				}
			} catch (error) {
				parentFailure = error;
				parentFailed = true;
				throw error;
			} finally {
				try {
					await parentHandle.close();
				} catch (closeError) {
					if (parentFailed) {
						throw new AggregateError(
							[parentFailure, closeError],
							"Filesystem replacement and parent close both failed.",
						);
					}
					throw closeError;
				}
			}
			this.assertActive();
			await resource?.complete();
			this.assertActive();
		} catch (error) {
			await cancelDurableResource(resource, error);
			throw error;
		}
	}

	/** Delete a file after holding and checking its canonical parent identity. */
	async deleteFile(target: AuthorizedFilesystemTarget): Promise<void> {
		this.assertTarget(target, "delete");
		if (this.#usedEffects.has(target as object))
			throw new Error("Filesystem target effect has already been consumed.");
		await this.verify(target);
		const resource = await this.beginOpenResource(target, "filesystem");
		try {
			this.assertActive();
			await resource?.effect();
			this.assertActive();
			const parentHandle = await fs.promises.open(
				target.canonicalParent,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
			);
			try {
				const heldParent = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldParent, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed before delete: ${target.originalPath}`);
				}
				this.assertActive();
				const heldTargetPath = heldParentChildPath(parentHandle, target);
				await fs.promises.unlink(heldTargetPath);
				this.assertActive();
				this.#usedEffects.add(target as object);
				const targetStillExists = await lstatIdentity(heldTargetPath);
				this.assertActive();
				if (targetStillExists) {
					throw new Error(`Filesystem target still exists after delete: ${target.originalPath}`);
				}
				const heldAfter = identityOf(await parentHandle.stat({ bigint: true }));
				this.assertActive();
				if (!sameIdentity(heldAfter, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed during delete: ${target.originalPath}`);
				}
			} finally {
				await parentHandle.close();
			}
			this.assertActive();
			await resource?.complete();
			this.assertActive();
		} catch (error) {
			await cancelDurableResource(resource, error);
			throw error;
		}
	}

	async dispose(): Promise<void> {
		this.#active = false;
		const failures: unknown[] = [];
		for (const resource of this.#openResources) {
			if (this.#effectResources.has(resource)) continue;
			try {
				await resource.cancel();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "Multiple durable filesystem resources failed to cancel.");
	}

	async #resolveCandidate(candidate: FilesystemTargetCandidate): Promise<AuthorizedFilesystemTarget> {
		if (!candidate.path || isNonFilesystemPath(candidate.path)) {
			throw new Error(`Filesystem authority requires an ordinary path target, received '${candidate.path}'.`);
		}
		const canonicalTarget = await resolveSyscallTarget(candidate.path, followsFinal(candidate.kind));
		if (canonicalTarget === null) throw new Error(`Filesystem authority could not resolve path '${candidate.path}'.`);
		const canonicalParent = await fs.promises.realpath(path.dirname(canonicalTarget));
		const targetStat = await fs.promises
			.lstat(canonicalTarget, { bigint: true })
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
		const identity = targetStat ? identityOf(targetStat) : undefined;
		if (
			(candidate.kind === "read" ||
				candidate.kind === "stat" ||
				candidate.kind === "list" ||
				candidate.kind === "search" ||
				candidate.kind === "delete") &&
			!identity
		) {
			throw new Error(`Filesystem target does not exist: ${candidate.path}`);
		}
		const target = Object.freeze({
			originalPath: candidate.path,
			canonicalTarget,
			canonicalParent,
			kind: candidate.kind,
			existed: identity !== undefined,
			isFile: targetStat?.isFile() ?? false,
			size: targetStat?.size ?? 0n,
			...(identity ? { identity } : {}),
			parentIdentity: await statIdentity(canonicalParent),
		}) as AuthorizedFilesystemTarget;
		authorizedTargets.add(target as object);
		targetOwners.set(target as object, this);
		return target;
	}
}

const targetOwners = new WeakMap<object, FilesystemOperation>();

/** Session-owned mint for operation-local path authority. */
export class SessionPathScope {
	readonly #options: SessionPathScopeOptions;
	readonly #operations = new Set<FilesystemOperation>();
	readonly #context = new AsyncLocalStorage<FilesystemOperation>();
	#generation = 1;
	#identityKey = "";

	constructor(options: SessionPathScopeOptions) {
		this.#options = options;
		this.#identityKey = this.#currentIdentity().key;
	}

	get isRestricted(): boolean {
		return this.#options.permissionScope()?.mode === "enforce";
	}

	/** Compatibility observation: only the operation in this async invocation is visible. */
	get lease(): FilesystemOperationLease | undefined {
		return this.#context.getStore()?.lease;
	}

	currentOperation(): FilesystemOperation {
		const operation = this.#context.getStore();
		if (!operation) throw new Error("Filesystem authority requires an active operation.");
		operation.assertActive();
		return operation;
	}

	/** Internal durable-resource lookup; returns no capability or filesystem handle. */
	operationManager(): object | undefined {
		return this.#options.operationManager?.();
	}

	async withOperationLease<T>(operationId: string, run: (operation: FilesystemOperation) => Promise<T>): Promise<T> {
		const identity = this.#refreshIdentity();
		const activeEffectLease = getActiveOperationLease(this.#options.operationManager?.(), operationId);
		const effectLease =
			activeEffectLease?.effectClass === "filesystem" || activeEffectLease?.effectClass === "local"
				? activeEffectLease
				: undefined;
		const lease: FilesystemOperationLease = Object.freeze({
			operationId,
			actorId: identity.actorId,
			sessionId: identity.sessionId,
			generation: this.#generation,
			effectClass: effectLease?.effectClass,
			effectOwnerId: effectLease?.ownerId,
			effectAcquiredAt: effectLease?.acquiredAt,
			rootId: effectLease?.rootId,
			authorityGeneration: effectLease?.generation,
		});
		const operation = new FilesystemOperation(
			operationConstructionKey,
			this,
			operationId.split(":", 1)[0] || "filesystem",
			lease,
		);
		this.#operations.add(operation);
		try {
			const durability = getActiveOperationDurability(this.operationManager(), operationId);
			return await filesystemOperationContext.run(operation, () =>
				this.#context.run(operation, () =>
					durability ? withAuthorityEffect(durability.store, () => run(operation)) : run(operation),
				),
			);
		} finally {
			try {
				await operation.dispose();
			} finally {
				this.#operations.delete(operation);
			}
		}
	}

	assertOperationIdentity(operation: FilesystemOperation): void {
		const identity = this.#refreshIdentity();
		if (this.#options.permissionScope() !== undefined && !operation.lease.effectOwnerId) {
			throw new Error("Restricted filesystem authority requires an active session operation lease.");
		}
		if (operation.lease.generation !== this.#generation)
			throw new Error("Filesystem authority generation changed during the operation.");
		if (operation.actorId !== identity.actorId || operation.sessionId !== identity.sessionId) {
			throw new Error("Filesystem authority actor or session changed during the operation.");
		}
		if (operation.lease.effectOwnerId !== undefined) {
			const effectClass = operation.lease.effectClass;
			const acquiredAt = operation.lease.effectAcquiredAt;
			if (effectClass === undefined || acquiredAt === undefined) {
				throw new Error("Filesystem operation is missing its active session operation lease identity.");
			}
			assertActiveOperationLease(this.#options.operationManager?.(), {
				operationId: operation.lease.operationId,
				ownerId: operation.lease.effectOwnerId,
				effectClass,
				acquiredAt,
				actorId: operation.lease.authorityGeneration === undefined ? undefined : operation.actorId,
				rootId: operation.lease.rootId,
				generation: operation.lease.authorityGeneration,
			});
		}
	}

	assertPermission(toolName: string, canonicalPath: string): void {
		const scope = this.#options.permissionScope();
		const toolInput = { path: canonicalPath };
		const decision = evaluateSubagentPermission({
			scope,
			toolName,
			toolInput,
			cwd: this.#options.cwd(),
		});
		if (decision.action === "deny") {
			this.#options.recordPermissionDenial?.(decision.details);
			throw new Error(decision.reason);
		}
		const guardrailDecision = evaluateRestrictedToolGuardrails({
			scope,
			toolName,
			toolInput,
			canonicalFilesystemTarget: true,
		});
		if (guardrailDecision.action === "deny") {
			this.#options.recordPermissionDenial?.(guardrailDecision.details);
			throw new Error(guardrailDecision.reason);
		}
	}

	assertLocalAuthority(operation: FilesystemOperation): void {
		this.assertOperationIdentity(operation);
		if (this.#options.permissionScope()?.mode !== "enforce") return;
		if (operation.lease.effectClass !== "local") {
			throw new Error("Managed local authority requires an active local operation lease.");
		}
	}

	assertLease(): FilesystemOperationLease {
		return this.currentOperation().lease;
	}

	/** Authorize one target in the current invocation and return its canonical destination. */
	async authorizePath(toolName: string, rawPath: string, followFinal = true): Promise<string> {
		if (!rawPath || isNonFilesystemPath(rawPath)) return rawPath;
		const operation = this.currentOperation();
		const target = await operation.authorize(rawPath, operationKindForTool(toolName, followFinal));
		return target.canonicalTarget;
	}

	/** Compatibility admission precheck. Executable authority is minted only inside withOperationLease. */
	async authorizeInput(toolName: string, input: Record<string, unknown>): Promise<ReadonlyMap<string, string>> {
		this.#refreshIdentity();
		if (toolName === "hub" || toolName === "security_publish") return new Map();
		const replacements = new Map<string, string>();
		for (const rawPath of pathValues(input)) {
			const expandedPaths =
				toolName === "grep" ? await expandDelimitedPathEntries([rawPath], this.#options.cwd()) : [rawPath];
			for (const expandedPath of expandedPaths) {
				if (!expandedPath || isNonFilesystemPath(expandedPath)) continue;
				const requestedPath = path.isAbsolute(expandedPath)
					? expandedPath
					: path.resolve(this.#options.cwd(), expandedPath);
				const canonical = await resolveSyscallTarget(requestedPath, toolName !== "delete");
				if (canonical === null) throw new Error(`Filesystem authority could not resolve path '${expandedPath}'.`);
				this.assertPermission(toolName, canonical);
				if (expandedPaths.length === 1 && canonical !== rawPath) replacements.set(rawPath, canonical);
			}
		}
		return replacements;
	}

	#currentIdentity(): { actorId: string; sessionId: string; key: string } {
		const actorId = this.#options.actorId();
		const sessionId = this.#options.sessionId();
		if (!actorId || !sessionId) throw new Error("Filesystem authority requires a live actor and session.");
		return { actorId, sessionId, key: `${actorId}\0${sessionId}\0${path.resolve(this.#options.cwd())}` };
	}

	#refreshIdentity(): { actorId: string; sessionId: string; key: string } {
		const identity = this.#currentIdentity();
		if (identity.key !== this.#identityKey) {
			this.#generation++;
			this.#identityKey = identity.key;
		}
		return identity;
	}
}

/** Apply canonical path substitutions, preserving the original graph when nothing changes. */
export function rewriteAuthorizedInput<T>(input: T, replacements: ReadonlyMap<string, string>): T {
	if (replacements.size === 0) return input;
	if (typeof input === "string") return (replacements.get(input) ?? input) as T;
	if (Array.isArray(input)) {
		let changed = false;
		const output = input.map(value => {
			const rewritten = rewriteAuthorizedInput(value, replacements);
			if (rewritten !== value) changed = true;
			return rewritten;
		});
		return (changed ? output : input) as T;
	}
	if (!input || typeof input !== "object") return input;
	let changed = false;
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		const rewritten = rewriteAuthorizedInput(value, replacements);
		if (rewritten !== value) changed = true;
		output[key] = rewritten;
	}
	return (changed ? output : input) as T;
}
