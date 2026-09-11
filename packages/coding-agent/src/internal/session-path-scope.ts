import type { PermissionDenialDetails } from "@oh-my-pi/pi-wire";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseXdUrl } from "../internal-urls/xd-protocol";
import { getActiveOperationDurability, getActiveOperationLease } from "../registry/operation-lease";
import { durableTargetHash, type DurableResourceClass, type DurableResourceRecord } from "../registry/durable-state";
import type { EffectiveSubagentPermissions } from "../task/permission-profiles";
import { evaluateSubagentPermission } from "../task/permission-profiles";
import { isInternalUrlPath, resolveSyscallTarget } from "../tools/path-utils";
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
	effect(): void;
	complete(): void;
	cancel(): void;
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
	readonly readFiles?: boolean;
	readonly include?: (entry: Omit<AuthorizedSearchEntry, "content">) => boolean;
	readonly descend?: (entry: Omit<AuthorizedSearchEntry, "content">) => boolean;
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
		const visit = async (target: AuthorizedFilesystemTarget): Promise<void> => {
			this.assertActive();
			if (options.signal?.aborted) throw new Error("Search traversal aborted.");
			const handle = await this.openRead(target);
			try {
				const stat = await handle.stat({ bigint: true });
				const base: Omit<AuthorizedSearchEntry, "content"> = Object.freeze({
					path: target.canonicalTarget,
					isFile: stat.isFile(),
					isDirectory: stat.isDirectory(),
					size: stat.size,
					mtimeMs: Number(stat.mtimeMs),
				});
				const selected = include(base);
				if (selected && base.isFile) {
					const content = options.readFiles ? await handle.readFile({ encoding: "utf8" }) : undefined;
					entries.push(content === undefined ? base : Object.freeze({ ...base, content }));
				} else if (selected) {
					entries.push(base);
				}
				if (!base.isDirectory || !descend(base)) return;
				if (process.platform !== "linux") {
					throw new Error("Exact filesystem traversal requires Linux /proc/self/fd support.");
				}
				const directory = await fs.promises.opendir(`/proc/self/fd/${handle.fd}`);
				try {
					for (;;) {
						const child = await directory.read();
						if (child === null) break;
						if (options.signal?.aborted) throw new Error("Search traversal aborted.");
						const childPath = path.join(target.canonicalTarget, child.name);
						let authorized: AuthorizedFilesystemTarget;
						try {
							authorized = await this.authorize(childPath, "search");
						} catch {
							continue;
						}
						await visit(authorized);
					}
				} finally {
					await directory.close();
				}
			} finally {
				await handle.close();
			}
		};
		await visit(root);
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
		const resource = this.beginOpenResource(target, resourceClass);
		try {
			const handle = await fs.promises.open(
				target.canonicalTarget,
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
			);
			try {
				const opened = identityOf(await handle.stat({ bigint: true }));
				if (!target.identity || !sameIdentity(opened, target.identity)) {
					throw new Error(`Filesystem target changed while opening: ${target.originalPath}`);
				}
				this.assertActive();
				resource?.effect();
				if (resource) {
					const close = handle.close.bind(handle);
					let closed = false;
					handle.close = async () => {
						if (closed) return;
						try {
							await close();
							closed = true;
							resource.complete();
						} catch (error) {
							resource.cancel();
							throw error;
						}
					};
				}
				return handle;
			} catch (error) {
				await handle.close();
				resource?.cancel();
				throw error;
			}
		} catch (error) {
			resource?.cancel();
			throw error;
		}
	}

	beginOpenResource(
		target: AuthorizedFilesystemTarget,
		resourceClass: DurableResourceClass,
	): DurableOpenResource | undefined {
		this.assertTarget(target);
		const durability = getActiveOperationDurability(this.#scope.operationManager(), this.operationId);
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
		durability.store.append({ ...base, at: Date.now(), phase: "intent" });
		let phase: "intent" | "effect" | "terminal" = "intent";
		const control: DurableOpenResource = Object.freeze({
			effect: () => {
				if (phase !== "intent") throw new Error("Durable resource effect was already recorded.");
				durability.store.append({ ...base, at: Date.now(), phase: "effect" });
				phase = "effect";
			},
			complete: () => {
				if (phase === "terminal") return;
				if (phase !== "effect") throw new Error("Durable resource cannot complete before its effect.");
				durability.store.append({ ...base, at: Date.now(), phase: "committed" });
				durability.store.append({ ...base, at: Date.now(), phase: "completed" });
				phase = "terminal";
				this.#openResources.delete(control);
			},
			cancel: () => {
				if (phase === "terminal") return;
				durability.store.append({ ...base, at: Date.now(), phase: "cancelled" });
				phase = "terminal";
				this.#openResources.delete(control);
			},
		});
		this.#openResources.add(control);
		return control;
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
		const resource = this.beginOpenResource(target, resourceClass);
		try {
			const parentHandle = await fs.promises.open(
				target.canonicalParent,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
			);
			try {
				const heldParent = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldParent, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed before write: ${target.originalPath}`);
				}
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
					resource?.effect();
					await handle.truncate(0);
					await handle.writeFile(payload);
					const after = identityOf(await handle.stat({ bigint: true }));
					if (!sameIdentity(opened, after))
						throw new Error(`Filesystem target changed during write: ${target.originalPath}`);
					this.#usedEffects.add(target as object);
				} finally {
					await handle.close();
				}
				const heldAfter = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldAfter, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed during write: ${target.originalPath}`);
				}
			} finally {
				await parentHandle.close();
			}
			resource?.complete();
		} catch (error) {
			resource?.cancel();
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
		const resource = this.beginOpenResource(target, "filesystem");
		try {
			const parentHandle = await fs.promises.open(
				target.canonicalParent,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
			);
			resource?.effect();
			const heldTemporaryPath = heldParentChildPath(parentHandle, temporary);
			try {
				const heldParent = identityOf(await parentHandle.stat({ bigint: true }));
				if (
					!sameIdentity(heldParent, target.parentIdentity) ||
					!sameIdentity(heldParent, temporary.parentIdentity)
				) {
					throw new Error(`Filesystem target parent changed before replacement: ${target.originalPath}`);
				}
				await produce(heldTemporaryPath);
				const temporaryStat = await fs.promises.lstat(heldTemporaryPath, { bigint: true });
				if (!temporaryStat.isFile() || temporaryStat.nlink > 1n) {
					throw new Error(`Filesystem replacement produced an unsafe temp file: ${temporary.originalPath}`);
				}
				this.assertActive();
				await fs.promises.rename(heldTemporaryPath, heldParentChildPath(parentHandle, target));
				const finalStat = await fs.promises.lstat(heldParentChildPath(parentHandle, target), { bigint: true });
				if (!finalStat.isFile() || finalStat.nlink > 1n) {
					throw new Error(`Filesystem replacement produced an unsafe target: ${target.originalPath}`);
				}
				const heldAfter = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldAfter, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed during replacement: ${target.originalPath}`);
				}
				this.#usedEffects.add(target as object);
				this.#usedEffects.add(temporary as object);
			} catch (error) {
				await fs.promises.rm(heldTemporaryPath, { force: true }).catch(() => undefined);
				throw error;
			} finally {
				await parentHandle.close();
			}
			resource?.complete();
		} catch (error) {
			resource?.cancel();
			throw error;
		}
	}

	/** Delete a file after holding and checking its canonical parent identity. */
	async deleteFile(target: AuthorizedFilesystemTarget): Promise<void> {
		this.assertTarget(target, "delete");
		if (this.#usedEffects.has(target as object))
			throw new Error("Filesystem target effect has already been consumed.");
		await this.verify(target);
		const resource = this.beginOpenResource(target, "filesystem");
		try {
			const parentHandle = await fs.promises.open(
				target.canonicalParent,
				fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
			);
			resource?.effect();
			try {
				const heldParent = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldParent, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed before delete: ${target.originalPath}`);
				}
				this.assertActive();
				const heldTargetPath = heldParentChildPath(parentHandle, target);
				await fs.promises.unlink(heldTargetPath);
				this.#usedEffects.add(target as object);
				if (await lstatIdentity(heldTargetPath)) {
					throw new Error(`Filesystem target still exists after delete: ${target.originalPath}`);
				}
				const heldAfter = identityOf(await parentHandle.stat({ bigint: true }));
				if (!sameIdentity(heldAfter, target.parentIdentity)) {
					throw new Error(`Filesystem target parent changed during delete: ${target.originalPath}`);
				}
			} finally {
				await parentHandle.close();
			}
			resource?.complete();
		} catch (error) {
			resource?.cancel();
			throw error;
		}
	}

	dispose(): void {
		this.#active = false;
		for (const resource of this.#openResources) resource.cancel();
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
			return await this.#context.run(operation, () => run(operation));
		} finally {
			operation.dispose();
			this.#operations.delete(operation);
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
	}

	assertPermission(toolName: string, canonicalPath: string): void {
		const decision = evaluateSubagentPermission({
			scope: this.#options.permissionScope(),
			toolName,
			toolInput: { path: canonicalPath },
			cwd: this.#options.cwd(),
		});
		if (decision.action === "deny") {
			this.#options.recordPermissionDenial?.(decision.details);
			throw new Error(decision.reason);
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
		if (toolName === "hub") return new Map();
		const replacements = new Map<string, string>();
		for (const rawPath of pathValues(input)) {
			if (!rawPath || isNonFilesystemPath(rawPath)) {
				replacements.set(rawPath, rawPath);
				continue;
			}
			const canonical = await resolveSyscallTarget(rawPath, toolName !== "delete");
			if (canonical === null) throw new Error(`Filesystem authority could not resolve path '${rawPath}'.`);
			this.assertPermission(toolName, canonical);
			replacements.set(rawPath, canonical);
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
			for (const operation of this.#operations) operation.dispose();
			this.#operations.clear();
			this.#identityKey = identity.key;
		}
		return identity;
	}
}

/** Apply canonical path substitutions returned by SessionPathScope.authorizeInput. */
export function rewriteAuthorizedInput<T>(input: T, replacements: ReadonlyMap<string, string>): T {
	if (typeof input === "string") return (replacements.get(input) ?? input) as T;
	if (Array.isArray(input)) return input.map(value => rewriteAuthorizedInput(value, replacements)) as T;
	if (!input || typeof input !== "object") return input;
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		output[key] = rewriteAuthorizedInput(value, replacements);
	}
	return output as T;
}
