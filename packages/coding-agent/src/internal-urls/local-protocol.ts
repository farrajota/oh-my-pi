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
import { isMarkdownPath } from "../utils/lang-from-path";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";

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

function parseLocalUrl(input: string): InternalUrl {
	return parseInternalUrl(input);
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("local:// URL escapes local root");
	}
}

function toLocalValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "local://"));
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
	ensureWithinRoot(target.canonicalTarget, localRoot);
	ensureWithinRoot(target.canonicalParent, localRoot);
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

function formatLocalByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${kib.toFixed(1)} KiB`;
	const mib = kib / 1024;
	if (mib < 1024) return `${mib.toFixed(1)} MiB`;
	return `${(mib / 1024).toFixed(1)} GiB`;
}

function buildNonTextLocalResource(url: InternalUrl, filePath: string, size: number, reason: string): InternalResource {
	const content = `[Cannot read binary local:// file '${url.href}' (${formatLocalByteSize(size)}): ${reason}. This resource is not text. Use a metadata/key-frame/video-specific workflow instead.]`;
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
	const content = `[Cannot materialize local:// file '${url.href}' as an internal text resource (${formatLocalByteSize(size)} exceeds ${formatLocalByteSize(LOCAL_TEXT_RESOURCE_MAX_BYTES)}). Use the read tool's filesystem path handling or a line selector so content is streamed with file-size safeguards.]`;
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
		contentType: getContentType(resolved.path),
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
	};
}

function extractRelativePath(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
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
	try {
		validateRelativePath(decoded);
	} catch (error) {
		throw toLocalValidationError(error);
	}
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
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const localRoot = path.resolve(resolveLocalRoot(options, platform));
	const relativePath = extractRelativePath(url);

	if (!relativePath) {
		return localRoot;
	}

	const resolved = path.resolve(localRoot, relativePath);
	ensureWithinRoot(resolved, localRoot);
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
	ensureWithinRoot(targetPath, resolvedRoot);

	if (targetPath === resolvedRoot) {
		const authorizedTarget = operation
			? await authorizeLocalTarget(operation, resolvedRoot, "list", resolvedRoot)
			: undefined;
		return { kind: "listing", root: resolvedRoot, authorizedTarget };
	}

	const probe = operation ? await authorizeLocalTarget(operation, targetPath, "probe", resolvedRoot) : undefined;
	const canonicalTarget = probe?.canonicalTarget ?? targetPath;
	const parentDir = path.dirname(canonicalTarget);
	try {
		const realParent = await fs.realpath(parentDir);
		ensureWithinRoot(realParent, resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	assertLocalRootCurrent(opts, localRoot);

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(canonicalTarget);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Local file not found: ${url.href}`);
		throw error;
	}
	ensureWithinRoot(realTargetPath, resolvedRoot);
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
 * Resolve a local:// URL to a regular on-disk file, applying the same
 * realpath + containment guarantees as {@link LocalProtocolHandler.resolve}
 * but WITHOUT reading or UTF-8-decoding its contents. Returns null when there
 * is no active session or when the URL targets the root listing or a directory;
 * throws the handler's not-found and "escapes local root" errors for missing
 * files and symlink escapes.
 *
 * Options are resolved via {@link LocalProtocolHandler.resolveOptions} so the
 * caller-options → override → registry order matches router resolution exactly.
 * The read tool uses this to detect and emit image files from their real path
 * before the text-only resource contract would decode the binary into mojibake.
 */
export async function resolveLocalUrlToFile(
	input: string | InternalUrl,
	context?: ResolveContext,
): Promise<{ path: string; size: number } | null> {
	const opts = LocalProtocolHandler.resolveOptions(context);
	if (!opts) return null;
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const resolved = await resolveLocalTarget(url, opts);
	return resolved.kind === "file" ? { path: resolved.path, size: resolved.size } : null;
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
	readonly immutable = false;

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
	 * 2. Explicit process-global override installed via {@link setOverride}
	 *    (used by SDK consumers with a custom artifacts/session-id mapping and
	 *    by code paths that do not have a calling session, e.g. TUI hyperlink
	 *    resolution).
	 * 3. The first `main`-kind session in `AgentRegistry.global()`. Its
	 *    `SessionManager` supplies both `getArtifactsDir` and `getSessionId`.
	 *    Last-resort fallback — every caller that has a session reference
	 *    SHOULD thread it through `context` so this branch is never taken in
	 *    multi-session setups.
	 */
	static resolveOptions(context?: ResolveContext | WriteContext): LocalProtocolOptions | undefined {
		const fromContext = context?.localProtocolOptions;
		if (fromContext) return fromContext;
		// A supplied caller context is an authority-bearing invocation. Missing
		// caller options must fail closed; stale process-global state is never a
		// valid substitute. Contextless display/hyperlink resolution retains the
		// legacy ambient fallback as a distinct non-authority branch.
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
		if (context?.pathOnly) {
			const sourcePath = resolved.kind === "listing" ? resolved.root : resolved.path;
			return {
				url: url.href,
				content: "",
				contentType: getContentType(sourcePath),
				sourcePath,
				size: resolved.kind === "file" ? resolved.size : undefined,
				isDirectory: resolved.kind !== "file",
			};
		}
		if (resolved.kind === "listing") {
			return buildListing(url, resolved.root, opts);
		}
		if (resolved.kind === "directory") {
			return buildListing(url, resolved.path, opts);
		}

		return buildFileResource(url, resolved, opts);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const opts = LocalProtocolHandler.resolveOptions(context);
		if (!opts) throw new Error("No session - local:// unavailable");
		const localRoot = path.resolve(resolveLocalRoot(opts));
		const targetPath = resolveLocalUrlToPath(url, opts);
		if (targetPath === localRoot) throw new Error("local:// root is not a writable file");
		ensureWithinRoot(targetPath, localRoot);
		const effect = async () => {
			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			assertLocalRootCurrent(opts, localRoot);
			const resolvedRoot = await fs.realpath(localRoot);
			const operation = currentLocalOperation(opts);
			if (!operation) {
				await fs.writeFile(targetPath, content, "utf8");
				return;
			}
			const exists = await fs.lstat(targetPath).then(
				() => true,
				error => {
					if (isEnoent(error)) return false;
					throw error;
				},
			);
			const target = await authorizeLocalTarget(operation, targetPath, exists ? "write" : "create", resolvedRoot);
			await operation.writeFile(target, content, "local");
			await operation.verifyPostWrite(target);
		};
		const durable = opts.getDurableLocalState?.();
		if (!durable) {
			await effect();
			return;
		}
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
		await durable.publishWithEffect(entryId, durableBackingSha256(content), expectedHeadHash, effect);
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
