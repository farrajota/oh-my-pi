import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type {
	AuthorizedFilesystemTarget,
	FilesystemOperation,
	FilesystemOperationKind,
	SessionPathScope,
} from "../internal/session-path-scope";
import { listAgentRefs } from "../internal/agent-registry-bridge";
import { AgentRegistry } from "../registry/agent-registry";
import {
	canonicalDurableSha256,
	durableBackingSha256,
	type DurableLocalBackingExpectation,
	type DurableLocalState,
} from "../registry/durable-state";
import localDoc from "../prompts/internal-urls/local.md" with { type: "text" };
import { isMarkdownPath } from "@oh-my-pi/pi-tui/lang-from-path";
import {
	buildDirectoryResource,
	containedRealPath,
	contentTypeForPath,
	ensureCreatableWithinRoot,
	ensureWithinRoot,
	validateRelativePath,
} from "./filesystem-resource";
import { parseInternalUrl } from "./parse";
import type {
	InternalResource,
	InternalUrl,
	LocateOptions,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";
import { formatByteSize } from "../utils/video";

export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string | null;
	/** Exact calling session's operation-local filesystem authority. */
	getPathScope?: () => SessionPathScope | undefined;
	/** Session-owned single-head W4 journal. The callback returns metadata authority only, never a backing path. */
	getDurableLocalState?: () => DurableLocalState | undefined;
	/** Caller-owned lookup that validates recovered bytes without exposing or persisting a backing path. */
	validateDurableLocalBacking?: (expectation: DurableLocalBackingExpectation) => boolean | Promise<boolean>;
}

const sessionLocalProtocolOptions = new WeakMap<object, LocalProtocolOptions>();

/** Bind the exact options snapshot owned by one session manager. */
export function bindSessionLocalProtocolOptions(sessionManager: object, options: LocalProtocolOptions): void {
	sessionLocalProtocolOptions.set(sessionManager, options);
}

/** Recover the exact local:// options owned by one session manager. */
export function getSessionLocalProtocolOptions(sessionManager: object): LocalProtocolOptions | undefined {
	return sessionLocalProtocolOptions.get(sessionManager);
}

const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;
const LOCAL_WRITE_NOTE = "local:// resources are writable files in the active session.";

function safeSessionId(options: LocalProtocolOptions): string {
	const raw = options.getSessionId?.() ?? "session";
	const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return safe.length > 0 ? safe : "session";
}

function shortLocalRoot(options: LocalProtocolOptions): string {
	// Derive the short root from the stable session id, never the artifact path,
	// so `SessionManager.moveTo()` and the resume-after-move flow keep finding
	// the same `local://` directory the session wrote pre-move.
	return path.join(os.tmpdir(), "omp-local", safeSessionId(options));
}

function assertLocalRootCurrent(options: LocalProtocolOptions, expectedRoot: string): void {
	const currentRoot = path.resolve(resolveLocalRoot(options));
	if (currentRoot === expectedRoot) return;
	throw new Error("local:// root changed during the operation");
}

function currentLocalOperation(options: LocalProtocolOptions): FilesystemOperation | undefined {
	return options.getPathScope?.()?.currentOperation();
}

async function authorizeLocalTarget(
	operation: FilesystemOperation,
	targetPath: string,
	kind: FilesystemOperationKind,
	localRoot: string,
): Promise<AuthorizedFilesystemTarget> {
	const target = await operation.authorizeLocal(targetPath, kind);
	ensureWithinRoot(target.canonicalTarget, localRoot, "local");
	ensureWithinRoot(target.canonicalParent, localRoot, "local");
	return target;
}

function getContentType(filePath: string): InternalResource["contentType"] {
	if (isMarkdownPath(filePath)) return "text/markdown";
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".json") return "application/json";
	return "text/plain";
}

const LOCAL_TEXT_SNIFF_BYTES = 8 * 1024;
const LOCAL_TEXT_RESOURCE_MAX_BYTES = 1024 * 1024;
const BINARY_FILE_EXTENSIONS = new Set([
	".7z",
	".avi",
	".bmp",
	".bz2",
	".db",
	".doc",
	".docx",
	".gif",
	".gz",
	".ico",
	".jpeg",
	".jpg",
	".m4v",
	".mkv",
	".mov",
	".mp4",
	".pdf",
	".png",
	".ppt",
	".pptx",
	".rar",
	".sqlite",
	".tgz",
	".webm",
	".webp",
	".wmv",
	".xls",
	".xlsx",
	".xz",
	".zip",
]);

function buildNonTextLocalResource(url: InternalUrl, filePath: string, size: number, reason: string): InternalResource {
	const content = `[Cannot read binary local:// file '${url.href}' (${formatByteSize(size)}): ${reason}. This resource is not text. Use a metadata/key-frame/video-specific workflow instead.]`;
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: filePath,
		notes: [LOCAL_WRITE_NOTE],
	};
}

function buildLargeLocalTextResource(url: InternalUrl, filePath: string, size: number): InternalResource {
	const content = `[Cannot materialize local:// file '${url.href}' as an internal text resource (${formatByteSize(size)} exceeds ${formatByteSize(LOCAL_TEXT_RESOURCE_MAX_BYTES)}). Use the read tool's filesystem path handling or a line selector so content is streamed with file-size safeguards.]`;
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: filePath,
		notes: [LOCAL_WRITE_NOTE],
	};
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<Uint8Array> {
	if (maxBytes <= 0) return new Uint8Array();
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

function isUtf8Text(bytes: Uint8Array): boolean {
	if (bytes.indexOf(0) !== -1) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

async function buildFileResource(
	url: InternalUrl,
	resolved: Extract<ResolvedLocalTarget, { kind: "file" }>,
	options?: LocalProtocolOptions,
): Promise<InternalResource> {
	const operation = options ? currentLocalOperation(options) : undefined;
	if (operation && resolved.authorizedTarget) {
		const handle = await operation.openRead(resolved.authorizedTarget, "local");
		try {
			if (BINARY_FILE_EXTENSIONS.has(path.extname(resolved.path).toLowerCase())) {
				return buildNonTextLocalResource(
					url,
					resolved.path,
					resolved.size,
					"extension is a known binary/container type",
				);
			}
			const sniffLength = Math.min(resolved.size, LOCAL_TEXT_SNIFF_BYTES);
			const sniffBytes = new Uint8Array(sniffLength);
			const { bytesRead } = await handle.read(sniffBytes, 0, sniffLength, 0);
			if (!isUtf8Text(sniffBytes.subarray(0, bytesRead))) {
				return buildNonTextLocalResource(url, resolved.path, resolved.size, "content is not valid UTF-8 text");
			}
			if (resolved.size > LOCAL_TEXT_RESOURCE_MAX_BYTES) {
				return buildLargeLocalTextResource(url, resolved.path, resolved.size);
			}
			const content = await handle.readFile({ encoding: "utf8" });
			return {
				url: url.href,
				content,
				contentType: getContentType(resolved.path),
				size: Buffer.byteLength(content, "utf-8"),
				sourcePath: resolved.path,
				notes: [LOCAL_WRITE_NOTE],
			};
		} finally {
			await handle.close();
		}
	}
	if (BINARY_FILE_EXTENSIONS.has(path.extname(resolved.path).toLowerCase())) {
		return buildNonTextLocalResource(url, resolved.path, resolved.size, "extension is a known binary/container type");
	}
	const sniffBytes = await readFilePrefix(resolved.path, Math.min(resolved.size, LOCAL_TEXT_SNIFF_BYTES));
	if (!isUtf8Text(sniffBytes)) {
		return buildNonTextLocalResource(url, resolved.path, resolved.size, "content is not valid UTF-8 text");
	}
	if (resolved.size > LOCAL_TEXT_RESOURCE_MAX_BYTES)
		return buildLargeLocalTextResource(url, resolved.path, resolved.size);
	const content = await Bun.file(resolved.path).text();
	return {
		url: url.href,
		content,
		contentType: contentTypeForPath(resolved.path),
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: resolved.path,
		notes: [LOCAL_WRITE_NOTE],
	};
}
async function listFilesRecursively(rootPath: string, options?: LocalProtocolOptions): Promise<string[]> {
	const pending = [""];
	const files: string[] = [];
	const operation = options ? currentLocalOperation(options) : undefined;
	const expectedRoot = options ? path.resolve(resolveLocalRoot(options)) : undefined;

	while (pending.length > 0) {
		const relativeDir = pending.pop();
		if (relativeDir === undefined) continue;
		const absoluteDir = path.join(rootPath, relativeDir);
		const directoryTarget = operation ? await operation.authorize(absoluteDir, "list") : undefined;
		const directoryHandle = directoryTarget ? await operation!.openRead(directoryTarget, "local") : undefined;
		try {
			const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
			if (options && expectedRoot) assertLocalRootCurrent(options, expectedRoot);

			for (const entry of entries) {
				const entryPath = path.join(relativeDir, entry.name);
				const absoluteEntry = path.join(rootPath, entryPath);
				if (operation) {
					try {
						await operation.authorize(absoluteEntry, entry.isDirectory() ? "list" : "search");
					} catch {
						continue;
					}
				}
				if (entry.isDirectory()) pending.push(entryPath);
				else if (entry.isFile()) files.push(entryPath.replaceAll(path.sep, "/"));
			}
		} finally {
			await directoryHandle?.close();
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

async function buildListing(
	url: InternalUrl,
	localRoot: string,
	options?: LocalProtocolOptions,
): Promise<InternalResource> {
	const files = await listFilesRecursively(localRoot, options);
	const listing = files.length === 0 ? "(empty)" : files.map(file => `- [${file}](local://${file})`).join("\n");
	const content =
		`# Local\n\n` +
		`Session-scoped scratch space for large intermediate data, subagent handoffs, and reusable planning artifacts.\n\n` +
		`Root: ${localRoot}\n\n` +
		`${files.length} file${files.length === 1 ? "" : "s"} available:\n\n` +
		`${listing}\n`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: localRoot,
		immutable: true,
	};
}

const LOCAL_AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

function extractRelativePath(url: InternalUrl): string {
	// The authority is the first path segment, decoded below with the rest, so take it as
	// written: `rawHost` is already decoded (a second decode corrupts names containing `%`),
	// and WHATWG `hostname` drops `user@` / `:port` parts of names like `a@b` or `a:1`.
	const host = url.rawHref?.match(LOCAL_AUTHORITY_RE)?.[1] ?? url.hostname;
	const pathname = url.rawPathname ?? url.pathname;

	const combined = host
		? pathname && pathname !== "/"
			? `${host}${pathname}`
			: host
		: pathname && pathname !== "/"
			? pathname.slice(1)
			: "";

	if (!combined) {
		return "";
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(combined.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${url.href}`);
	}
	validateRelativePath(decoded, "local");
	return decoded;
}

/** Resolve the session-scoped local:// root, shortening long Windows artifact paths before writes hit MAX_PATH. */
export function resolveLocalRoot(options: LocalProtocolOptions, platform: NodeJS.Platform = process.platform): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		const candidate = path.resolve(artifactsDir, "local");
		if (platform === "win32" && candidate.length >= WINDOWS_LOCAL_ROOT_MAX_CHARS) {
			return shortLocalRoot(options);
		}
		return candidate;
	}

	return path.join(os.tmpdir(), "omp-local", safeSessionId(options));
}

/**
 * Recursively copy every local:// artifact from one session-scoped root to
 * another. Used when a session transition mints a fresh local root (plan
 * approve-and-execute, handoff) so plans, scratch files, and research notes the
 * carried-forward context references stay readable in the replacement session.
 * No-op when the roots match or the source root is absent.
 */
export async function copyLocalArtifacts(sourceRoot: string, destinationRoot: string): Promise<void> {
	if (sourceRoot === destinationRoot) return;

	let sourceRootStat: { isDirectory(): boolean };
	try {
		sourceRootStat = await fs.lstat(sourceRoot);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (!sourceRootStat.isDirectory()) return;

	await fs.mkdir(destinationRoot, { recursive: true });
	await copyLocalArtifactEntries(sourceRoot, destinationRoot);
}

async function copyLocalArtifactEntries(sourceDir: string, destinationDir: string): Promise<void> {
	const entries = await fs.readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(sourceDir, entry.name);
		const destinationPath = path.join(destinationDir, entry.name);

		if (entry.isDirectory()) {
			await fs.mkdir(destinationPath, { recursive: true });
			await copyLocalArtifactEntries(sourcePath, destinationPath);
			continue;
		}

		if (entry.isFile()) {
			await fs.mkdir(path.dirname(destinationPath), { recursive: true });
			await fs.copyFile(sourcePath, destinationPath);
		}
	}
}

/** Resolve a local:// URL to an on-disk path under the active session's local root. */
export function resolveLocalUrlToPath(
	input: string | InternalUrl,
	options: LocalProtocolOptions,
	platform: NodeJS.Platform = process.platform,
): string {
	const url = typeof input === "string" ? parseInternalUrl(input) : input;
	const localRoot = path.resolve(resolveLocalRoot(options, platform));
	const relativePath = extractRelativePath(url);

	if (!relativePath) {
		return localRoot;
	}

	const resolved = path.resolve(localRoot, relativePath);
	ensureWithinRoot(resolved, localRoot, "local", url.href);
	return resolved;
}

/**
 * On-disk roots the eval helpers substitute for internal-URL schemes. These
 * roots are addressing hints only; restricted host operations still resolve
 * each local:// entry through the operation-local handler below.
 */
export function buildEvalUrlRoots(options: LocalProtocolOptions): Record<string, string> {
	return { local: resolveLocalRoot(options) };
}

type ResolvedLocalTarget =
	| { kind: "listing"; root: string; authorizedTarget?: AuthorizedFilesystemTarget }
	| { kind: "directory"; path: string; authorizedTarget?: AuthorizedFilesystemTarget }
	| { kind: "file"; path: string; size: number; authorizedTarget?: AuthorizedFilesystemTarget };

/**
 * Resolve a local:// URL to its on-disk target with realpath + containment
 * checks on the root, parent, and target so symlinks cannot escape the session
 * local root. Does NOT read or decode file contents — callers decide how to
 * consume the resolved path.
 */
async function resolveLocalTarget(url: InternalUrl, opts: LocalProtocolOptions): Promise<ResolvedLocalTarget> {
	const localRoot = path.resolve(resolveLocalRoot(opts));
	const operation = currentLocalOperation(opts);
	if (operation) await operation.authorizeLocal(localRoot, "probe");
	await fs.mkdir(localRoot, { recursive: true });
	assertLocalRootCurrent(opts, localRoot);

	let resolvedRoot: string;
	try {
		resolvedRoot = await fs.realpath(localRoot);
	} catch (error) {
		if (isEnoent(error)) throw new Error("Unable to initialize local:// root");
		throw error;
	}
	assertLocalRootCurrent(opts, localRoot);

	const relativePath = extractRelativePath(url);
	const targetPath = relativePath ? path.resolve(resolvedRoot, relativePath) : resolvedRoot;
	ensureWithinRoot(targetPath, resolvedRoot, "local", url.href);

	if (targetPath === resolvedRoot) {
		const authorizedTarget = operation
			? await authorizeLocalTarget(operation, resolvedRoot, "list", resolvedRoot)
			: undefined;
		return { kind: "listing", root: resolvedRoot, authorizedTarget };
	}

	const probe = operation ? await authorizeLocalTarget(operation, targetPath, "probe", resolvedRoot) : undefined;
	const canonicalTarget = probe?.canonicalTarget ?? targetPath;
	const realTargetPath = await containedRealPath(canonicalTarget, resolvedRoot, "local", url.href);
	if (realTargetPath === undefined) {
		throw new Error(`Local file not found: ${url.href}`);
	}
	assertLocalRootCurrent(opts, localRoot);
	const authorizedTarget = operation
		? await authorizeLocalTarget(operation, realTargetPath, "read", resolvedRoot)
		: undefined;
	const stat = await fs.stat(authorizedTarget?.canonicalTarget ?? realTargetPath);
	assertLocalRootCurrent(opts, localRoot);
	if (stat.isDirectory()) {
		const directoryTarget = operation
			? await authorizeLocalTarget(operation, realTargetPath, "list", resolvedRoot)
			: authorizedTarget;
		return { kind: "directory", path: realTargetPath, authorizedTarget: directoryTarget };
	}
	if (!stat.isFile()) throw new Error(`local:// URL must resolve to a file or directory: ${url.href}`);
	return { kind: "file", path: realTargetPath, size: stat.size, authorizedTarget };
}

/**
 * Locate a local:// URL without creating anything. With `create`, returns the
 * lexical path under the session root (writes land where `resolveLocalUrlToPath`
 * points) once creating it provably stays inside the root — the deepest existing
 * ancestor must realpath inside it and no entry may be a dangling symlink (the
 * root included; a merely missing root is created on write). Otherwise returns
 * the realpath of an existing target, else null.
 */
async function locateLocalTarget(
	url: InternalUrl,
	opts: LocalProtocolOptions,
	create: boolean,
): Promise<string | null> {
	const localRoot = path.resolve(resolveLocalRoot(opts));
	const relativePath = extractRelativePath(url);
	const targetPath = relativePath ? path.resolve(localRoot, relativePath) : localRoot;
	ensureWithinRoot(targetPath, localRoot, "local", url.href);

	let realRoot: string;
	try {
		realRoot = await fs.realpath(localRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		if (!create) return null;
		// Missing root: nothing to escape through unless the root itself is a dangling symlink.
		await ensureCreatableWithinRoot(targetPath, localRoot, "local", url.href);
		return targetPath;
	}
	const underRealRoot = relativePath ? path.resolve(realRoot, relativePath) : realRoot;
	if (create) {
		await ensureCreatableWithinRoot(underRealRoot, realRoot, "local", url.href);
		return targetPath;
	}
	return (await containedRealPath(underRealRoot, realRoot, "local", url.href)) ?? null;
}

interface PreparedLocalFileWrite {
	path: string;
	authorizedTarget?: AuthorizedFilesystemTarget;
	durable: boolean;
	commit<T>(content: string, effect: () => Promise<T>): Promise<T>;
}

export async function prepareLocalFileWrite(url: InternalUrl, context?: WriteContext): Promise<PreparedLocalFileWrite> {
	const opts = LocalProtocolHandler.resolveOptions(context);
	if (!opts) throw new Error("No session - local:// unavailable");
	const localRoot = path.resolve(resolveLocalRoot(opts));
	const targetPath = await locateLocalTarget(url, opts, true);
	if (targetPath === null) throw new Error(`Local file not found: ${url.href}`);
	if (targetPath === localRoot) throw new Error("local:// root is not a writable file");
	ensureWithinRoot(targetPath, localRoot, "local", url.href);
	const operation = currentLocalOperation(opts);
	if (operation) await fs.mkdir(path.dirname(targetPath), { recursive: true });
	assertLocalRootCurrent(opts, localRoot);
	if ((await locateLocalTarget(url, opts, true)) === null) throw new Error(`Local file not found: ${url.href}`);
	const exists = await fs.lstat(targetPath).then(
		() => true,
		error => {
			if (isEnoent(error)) return false;
			throw error;
		},
	);
	let authorizedTarget: AuthorizedFilesystemTarget | undefined;
	if (operation) {
		const resolvedRoot = await fs.realpath(localRoot);
		authorizedTarget = await authorizeLocalTarget(operation, targetPath, exists ? "write" : "create", resolvedRoot);
	}
	const durable = opts.getDurableLocalState?.();
	return {
		path: authorizedTarget?.canonicalTarget ?? targetPath,
		authorizedTarget,
		durable: durable !== undefined,
		async commit<T>(content: string, effect: () => Promise<T>): Promise<T> {
			const writeEffect = async (): Promise<T> => {
				assertLocalRootCurrent(opts, localRoot);
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				assertLocalRootCurrent(opts, localRoot);
				if ((await locateLocalTarget(url, opts, true)) === null)
					throw new Error(`Local file not found: ${url.href}`);
				const result = await effect();
				if (operation && authorizedTarget) await operation.verifyPostWrite(authorizedTarget);
				assertLocalRootCurrent(opts, localRoot);
				return result;
			};
			if (!durable) return writeEffect();
			assertLocalRootCurrent(opts, localRoot);
			const entryId = canonicalDurableSha256({ localId: safeSessionId(opts), url: url.href });
			await durable.ensureRecoveredBacking(async expectation => {
				if (opts.validateDurableLocalBacking) return await opts.validateDurableLocalBacking(expectation);
				if (expectation.entryId !== entryId) return false;
				try {
					return durableBackingSha256(await fs.readFile(targetPath)) === expectation.entryHash;
				} catch {
					return false;
				}
			});
			const expectedHeadHash = durable.current()?.headHash ?? "0".repeat(64);
			let result: T | undefined;
			let completed = false;
			await durable.publishWithEffect(entryId, durableBackingSha256(content), expectedHeadHash, async () => {
				result = await writeEffect();
				completed = true;
			});
			if (!completed) throw new Error("local:// write did not complete");
			return result as T;
		},
	};
}

/**
 * Protocol handler for local:// URLs.
 *
 * URL forms:
 * - local:// - Lists files at the session local root
 * - local://<path> - Reads a file under the session local root
 */
export class LocalProtocolHandler implements ProtocolHandler {
	readonly scheme = "local";
	/**
	 * Session scratch space: `write` persists through its file pipeline via `locate({ create })`.
	 * Fork contract: local:// is a writable handler, so its writes keep write-tier approval
	 * (fail-closed) instead of upstream's read tier.
	 */
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		immutable: false,
		pathAuthority: true,
		linkable: true,
		imageQuestion: true,
		singleSlashAlias: true,
		write: { via: "file", payload: "text", scope: "sandbox", tier: () => "write" },
	};

	static #override: LocalProtocolOptions | undefined;

	/**
	 * Install a process-global override that wins over the AgentRegistry-based
	 * derivation. Used by top-level SDK consumers that wire
	 * `localProtocolOptions` on `createAgentSession`; subagents keep their
	 * inherited mapping session-bound.
	 */
	static setOverride(value: LocalProtocolOptions | undefined): void {
		LocalProtocolHandler.#override = value;
	}

	/** Reset the process-global override. Test-only. */
	static resetOverrideForTests(): void {
		LocalProtocolHandler.#override = undefined;
	}

	/**
	 * Returns the active local-protocol options.
	 *
	 * Resolution order:
	 * 1. **Caller-supplied** `context.localProtocolOptions` (the actual session
	 *    that initiated the `read`/`find`/`search`/`router.resolve` call). This
	 *    is what keeps `local://` reads pinned to the calling session in
	 *    multi-session hosts (cmux/ACP, embedded SDK consumers) where every
	 *    session registers as `kind: "main"` and "first one wins" would route
	 *    to the wrong artifacts directory.
	 * 2. A supplied context without caller-specific options fails closed; it
	 *    never falls through to process-global or registry-derived options.
	 * 3. Explicit process-global override installed via {@link setOverride}, for
	 *    contextless SDK consumers and legacy callers without caller context.
	 * 4. The first `main`-kind session in `AgentRegistry.global()`, for
	 *    contextless callers without an explicit override. Its `SessionManager`
	 *    supplies both `getArtifactsDir` and `getSessionId`.
	 *    Last-resort fallback — callers with a session reference SHOULD thread
	 *    it through `context` so this branch is never taken in multi-session
	 *    setups.
	 */
	static resolveOptions(context?: ResolveContext | WriteContext): LocalProtocolOptions | undefined {
		const fromContext = context?.localProtocolOptions;
		if (fromContext) return fromContext;
		if (context) return undefined;
		const override = LocalProtocolHandler.#override;
		if (override) return override;
		const main = listAgentRefs(AgentRegistry.global()).find(ref => ref.kind === "main");
		const sessionManager = main?.session?.sessionManager;
		if (!sessionManager) return undefined;
		return (
			getSessionLocalProtocolOptions(sessionManager) ?? {
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			}
		);
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const opts = LocalProtocolHandler.resolveOptions(context);
		if (!opts) {
			throw new Error("No session - local:// unavailable");
		}

		const resolved = await resolveLocalTarget(url, opts);
		if (resolved.kind === "listing") {
			return buildListing(url, resolved.root, opts);
		}
		if (resolved.kind === "directory") {
			return buildListing(url, resolved.path, opts);
		}

		return buildFileResource(url, resolved, opts);
	}

	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const opts = LocalProtocolHandler.resolveOptions(context);
		if (!opts) {
			throw new Error("No session - local:// unavailable");
		}
		return locateLocalTarget(url, opts, options?.create === true);
	}

	locateSync(url: InternalUrl, context?: ResolveContext): string | undefined {
		const opts = LocalProtocolHandler.resolveOptions(context);
		if (!opts) return undefined;
		try {
			return resolveLocalUrlToPath(url, opts);
		} catch {
			return undefined;
		}
	}

	promptDoc(): string {
		return localDoc.trim();
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const opts = LocalProtocolHandler.resolveOptions(context);
		if (!opts) return [];
		const localRoot = path.resolve(resolveLocalRoot(opts));
		try {
			const files = await listFilesRecursively(localRoot, opts);
			return files.map(value => ({ value }));
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	}
}
