import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { HighlightStream } from "@oh-my-pi/pi-natives";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { isEnoent, isRecord, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import {
	type ArchiveMemberContent,
	archiveFormatFromPath,
	isWritableArchiveFormat,
	parseArchivePathCandidates,
	readArchiveEntries,
	writeArchive,
} from "@oh-my-pi/pi-utils/ar";
import type { AuthorizedFilesystemTarget } from "../internal/session-path-scope";
import { getEditStore } from "../edit/store";
import { normalizeToLF } from "../edit/normalize";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls/router";
import { sessionResolveContext, sessionWriteContext } from "../internal-urls/context";
import type { WriteToolDetails as PiTuiWriteToolDetails } from "@oh-my-pi/pi-tui/tools/write";

import { couldBecomeXdUrl, parseXdUrl } from "../internal-urls/xd-protocol";
import { prepareLocalFileWrite } from "../internal-urls/local-protocol";
import { createLspWritethrough, type WritethroughCallback, writethroughNoop } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import { createHighlightStream, getLanguageFromPath, highlightCode, type Theme } from "@oh-my-pi/pi-tui/theme";
import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import writeDeviceOnlyDescription from "../prompts/tools/write-device-only.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { fileHyperlink, renderStatusLine } from "@oh-my-pi/pi-tui/render";
import { framedToolCard } from "@oh-my-pi/pi-tui/render/tool-card";
import { routeWriteThroughBridge, shouldRouteWriteThroughBridge } from "./acp-bridge";
import { truncateForPrompt } from "./approval";
import { assertEditableFile } from "./auto-generated-guard";

import {
	formatHashlineHeader,
	isReadTruncationNotice,
	splitAddressableFileLines,
} from "@oh-my-pi/pi-tui/tools/hashline-format";
import {
	type ConflictEntry,
	conflictRegionPresent,
	conflictRegionsEqual,
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	recoverConflictUriPrefix,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { outputMeta } from "./output-meta";
import { formatPathRelativeToCwd, probeLiteralPathExists, splitPathAndSel } from "./path-utils";
import {
	enforcePlanModeWrite,
	resolvePlanPath,
	targetsLocalSandbox,
	unwrapHashlineHeaderPath,
} from "./plan-mode-guard";
import { decodeUtf8Text } from "./read-format";
import { routeReadThroughBridge } from "./read-summary";
import {
	cachedRenderedString,
	createRenderedStringCache,
	Ellipsis,
	formatDiagnostics,
	formatErrorDetail,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
	type RenderedStringCache,
} from "@oh-my-pi/pi-tui/render";
import type { ToolActivityContext, ToolActivitySummary } from "@oh-my-pi/pi-tui/tools";
import { getLspBatchRequest } from "../lsp/batch";
import { dispatchReportIssueDevice, REPORT_ISSUE_DEVICE_NAME, renderReportIssueDeviceCall } from "./report-tool-issue";
import { dispatchResolutionDevice, isResolutionDeviceName, renderResolutionDeviceCall } from "./resolve";
import {
	deleteRowByKey,
	deleteRowByRowId,
	insertRow,
	isSqliteFile,
	parseSqlitePathCandidates,
	resolveTableRowLookup,
	updateRowByKey,
	updateRowByRowId,
} from "./sqlite-reader";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { renderXdevCall, renderXdevResult, resolveXdevTool, xdevActivitySummary } from "./xdev";
import { maybeWriteSnapshotHeader, stripWriteContent } from "./write-content";
import { cfgLspDiagnosticsDeduplicate, cfgLspDiagnosticsOnWrite, cfgLspFormatOnWrite } from "../lsp/settings";

const EXECUTABLE_NOTICE = "[Notice: Made executable via chmod +x]";
const URI_LIKE_WRITE_PATH_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}(.*)$/i;
const MISSING_DELIMITER_RE = /^([a-z][a-z0-9+.-]*)\/+(.*)$/i;

/** True when `typo` is exactly one insertion, deletion, substitution, or adjacent swap away from `word`. */
function isOneEditAway(typo: string, word: string): boolean {
	if (typo === word || Math.abs(typo.length - word.length) > 1) return false;
	let common = 0;
	while (common < typo.length && common < word.length && typo[common] === word[common]) common++;
	const a = typo.slice(common);
	const b = word.slice(common);
	if (a.slice(1) === b.slice(1) || a.slice(1) === b || a === b.slice(1)) return true;
	return a.length >= 2 && a[0] === b[1] && a[1] === b[0] && a.slice(2) === b.slice(2);
}

function assertWriteTargetAddressable(target: string, router: InternalUrlRouter): void {
	const trimmed = target.trim();
	if (path.win32.isAbsolute(trimmed) || router.canHandle(trimmed)) return;

	// Tool-device transports get typo recovery: a bare `<device>/x` or a near-miss
	// scheme is a mistyped dispatch, never an intended filesystem path.
	const deviceSchemes: string[] = [];
	for (const [scheme, spec] of router.specs()) {
		if (spec.write?.scope === "device") deviceSchemes.push(scheme);
	}

	const missingDelimiter = trimmed.match(MISSING_DELIMITER_RE);
	if (missingDelimiter && deviceSchemes.includes(missingDelimiter[1]!.toLowerCase())) {
		throw new ToolError(
			`Unknown URI-like write target '${trimmed}'. Did you mean '${missingDelimiter[1]!.toLowerCase()}://${missingDelimiter[2]}'? Prefix the path with './' to write it as a filesystem path.`,
		);
	}

	const uriLike = trimmed.match(URI_LIKE_WRITE_PATH_RE);
	if (!uriLike) return;

	const scheme = uriLike[1]!.toLowerCase();
	const canonicalScheme = router.spec(scheme) ? scheme : deviceSchemes.find(device => isOneEditAway(scheme, device));
	const suggestion = canonicalScheme
		? ` Did you mean '${canonicalScheme}://${uriLike[2]}'?`
		: deviceSchemes.length > 0
			? ` Tool devices use '${deviceSchemes[0]}://<tool>'.`
			: "";
	throw new ToolError(
		`Unknown URI-like write target '${trimmed}'.${suggestion} Prefix the path with './' to write it as a filesystem path.`,
	);
}

/**
 * Fail closed when a local write target looks like a mis-dispatched read.
 *
 * A read-only step that selects `write` instead of `read` passes the full read
 * expression (`src/foo.tsx:1-260:raw`) as the target. Because a literal colon
 * filename is legal on POSIX (issue #4618), that request otherwise resolves to
 * filesystem creation and reports success, leaving a stray zero-byte file the
 * model cannot recover from — the local analogue of the device-scheme near-miss guard
 * ({@link assertWriteTargetAddressable}, issue #6123).
 *
 * Fires only on the high-confidence combination the report identifies: the tail
 * parses as a read-tool selector, the literal target is missing, and no content
 * was supplied. Non-empty content is the escape hatch — it is never blocked, so
 * a deliberate write to a selector-shaped filename still succeeds. An existing
 * literal path or an ambiguous stat (`"unknown"`: EACCES, transient I/O) also
 * passes through so a real file is never shadowed by the guard.
 */
function readSelectorForEmptyWrite(target: string, content: string): string | undefined {
	if (content.length > 0) return undefined;
	return splitPathAndSel(target).sel;
}

function throwReadSelectorMisfire(target: string, sel: string): never {
	throw new ToolError(
		`write target '${target}' ends with a read-tool selector ':${sel}' and no such file exists — refusing to create a literal file by that name. ` +
			`If you meant to read it, use read({ path: "${target}" }). ` +
			`If you truly intend to create this file, pass its contents in \`content\` (a non-empty write is never blocked).`,
	);
}

/**
 * Recognize a semicolon-joined list of read-tool selectors mis-dispatched as a
 * single write target — the multi-file read expression the scout emitted in
 * issue #6809 (`a.txt:1-2;b/c.txt:3-4`). Every `;`-segment must be non-empty and
 * carry its own read selector ({@link splitPathAndSel} peels a `:N-M`, `:raw`,
 * or `:conflicts` tail). No real call targets such a list: `read` accepts one
 * path, `write` writes one file. Unlike {@link readSelectorForEmptyWrite} this
 * fires regardless of `content` — the non-empty-content escape hatch exists for
 * a lone selector-shaped *filename*, never a `;`-list, and honoring it here
 * silently creates a nested directory tree (`a.txt:1-2;b/`) in the workspace.
 * The caller still probes the literal target first, so an existing POSIX file
 * by that exact name stays writable (same escape as the single-selector guard).
 */
function readSelectorListMisfire(target: string): number | undefined {
	if (!target.includes(";")) return undefined;
	const segments = target.split(";");
	if (segments.length < 2) return undefined;
	for (const segment of segments) {
		const trimmed = segment.trim();
		if (trimmed.length === 0 || splitPathAndSel(trimmed).sel === undefined) return undefined;
	}
	return segments.length;
}

function throwReadSelectorListMisfire(target: string, count: number): never {
	throw new ToolError(
		`write target '${target}' is a semicolon-joined list of ${count} read-tool selectors, not a filesystem path — refusing to create it. ` +
			`write creates a single file; issue one read() per path to read these ranges (e.g. read({ path: "<one path>:<range>" })).`,
	);
}

async function assertNotReadSelectorMisfire(target: string, content: string, cwd: string): Promise<void> {
	const listCount = readSelectorListMisfire(target);
	if (listCount !== undefined && (await probeLiteralPathExists(target, cwd)) === "missing") {
		throwReadSelectorListMisfire(target, listCount);
	}
	const sel = readSelectorForEmptyWrite(target, content);
	if (sel === undefined) return;
	if ((await probeLiteralPathExists(target, cwd)) !== "missing") return;
	throwReadSelectorMisfire(target, sel);
}

const writeSchema = type({
	path: "string",
	"content?": "string",
});

/** Write arguments; `content` may be omitted only where the target scheme's write policy allows it. */
export type WriteToolInput = typeof writeSchema.infer;

/** Details returned by the write tool for TUI rendering. */
export type WriteToolDetails = PiTuiWriteToolDetails;
function endsWithReadTruncationNotice(content: string): boolean {
	const lines = splitAddressableFileLines(normalizeToLF(content));
	const noticeIndex = lines.findLastIndex(line => line.trim().length > 0);
	return noticeIndex !== -1 && isReadTruncationNotice(lines[noticeIndex]!);
}

function readProjectionPayloadLength(content: string): number | undefined {
	const lines = splitAddressableFileLines(normalizeToLF(content));
	const noticeIndex = lines.findLastIndex(line => line.trim().length > 0);
	if (noticeIndex === -1 || !isReadTruncationNotice(lines[noticeIndex]!)) return undefined;
	let end = noticeIndex;
	while (end > 0 && lines[end - 1]!.trim().length === 0) end--;
	return lines.slice(0, end).join("\n").length;
}

function assertNotShorterReadProjection(
	displayPath: string,
	rawContent: string,
	currentContent: string | undefined,
	writeContent: string = rawContent,
): void {
	const rawPayloadLength = readProjectionPayloadLength(rawContent);
	if (rawPayloadLength === undefined || currentContent === undefined) return;
	const payloadLength = writeContent === rawContent ? rawPayloadLength : normalizeToLF(writeContent).length;
	if (payloadLength >= normalizeToLF(currentContent).length) return;
	throw new ToolError(
		`Refusing to overwrite '${displayPath}' with an incomplete read projection: the content ends with an omp read truncation notice and covers less than the current source, so it would discard unseen content. Re-read the omitted ranges and write the complete file, or use edit for a partial change.`,
	);
}

async function readCurrentWriteSource(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
): Promise<string | undefined> {
	const readDisk = async (): Promise<string | undefined> => {
		try {
			return await Bun.file(absolutePath).text();
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	};
	if (!(await shouldRouteWriteThroughBridge(session, requestedPath, absolutePath))) return readDisk();
	const bridgeRead = routeReadThroughBridge(session, absolutePath);
	if (!bridgeRead) return readDisk();
	try {
		return await bridgeRead;
	} catch {
		return readDisk();
	}
}

async function assertNotTruncatedFileReadProjection(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
	displayPath: string,
	rawContent: string,
	writeContent: string,
): Promise<void> {
	if (!endsWithReadTruncationNotice(rawContent)) return;
	const currentContent = await readCurrentWriteSource(session, requestedPath, absolutePath);
	assertNotShorterReadProjection(displayPath, rawContent, currentContent, writeContent);
}

/**
 * Append a trailing note line to the first text block of a tool result.
 * Mutates `result` in place (the result object is owned by this call).
 */
function appendNoteToResult(result: AgentToolResult<WriteToolDetails>, note: string): void {
	const firstText = result.content.find(
		(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
	);
	if (firstText) {
		firstText.text = firstText.text.length > 0 ? `${firstText.text}\n${note}` : note;
	} else {
		result.content.push({ type: "text", text: note });
	}
}

function emitWriteProgress(
	onUpdate: AgentToolUpdateCallback<WriteToolDetails> | undefined,
	content: string,
	displayPath: string,
	resolvedPath?: string,
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Writing ${Buffer.byteLength(content, "utf8")} bytes to ${shortenPath(displayPath)}...`,
			},
		],
		details: resolvedPath ? { resolvedPath } : {},
	});
}

/**
 * If `content` begins with a `#!` shebang, ensure the file is executable.
 *
 * Mirrors `chmod a+x` (adds user/group/other execute bits to existing mode).
 * Errors are swallowed: chmod failure (e.g. Windows ACL, read-only mount)
 * MUST NOT fail an otherwise successful write. Returns whether the mode
 * actually changed so the caller can surface a note.
 */
async function maybeMarkExecutableForShebang(absolutePath: string, content: string): Promise<boolean> {
	if (!content.startsWith("#!")) return false;
	try {
		const stat = await fs.stat(absolutePath);
		const currentMode = stat.mode & 0o7777;
		const newMode = currentMode | 0o111;
		if (newMode === currentMode) return false;
		await fs.chmod(absolutePath, newMode);
		return true;
	} catch {
		return false;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

function isArchivePathNotFound(error: unknown): boolean {
	if (isEnoent(error)) return true;
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

function normalizeArchiveWriteSubPath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}
	if (normalized.endsWith("/")) {
		throw new ToolError("Archive write path must target a file, not a directory");
	}

	const parts = normalized.split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			throw new ToolError("Archive path cannot contain '..'");
		}
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}

	return normalizedParts.join("/");
}

function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
	if (queryString.trim().length > 0) {
		throw new ToolError("SQLite write paths do not support query parameters");
	}

	const normalized = subPath.replace(/^:+/, "").trim();
	if (!normalized) {
		throw new ToolError("SQLite write path must target a table");
	}

	const separatorIndex = normalized.indexOf(":");
	const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite write path must target a table");
	}
	if (key !== undefined && key.length === 0) {
		throw new ToolError("SQLite row writes require a non-empty row key");
	}

	return { table, key };
}

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails> {
	readonly name = "write";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const { path: rawPath, content } = args as Partial<WriteParams>;
		if (typeof rawPath !== "string") return "write";
		// Unwrap a hashline `[path#TAG]` wrapper first (parity with execute) so a
		// wrapped `[scheme://h/x#ABCD]` gets the same tier as the bare URL.
		return InternalUrlRouter.instance().writeTier(
			unwrapHashlineHeaderPath(rawPath),
			typeof content === "string" ? content : undefined,
			this.session,
		);
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<WriteParams>;
		const targetPath = typeof params.path === "string" ? params.path : "(missing)";
		const content = typeof params.content === "string" ? params.content : "";
		return [`Path: ${truncateForPrompt(targetPath)}`, `Content:\n${truncateForPrompt(content)}`];
	};
	readonly label = "Write";
	get description(): string {
		const deviceOnly = this.session.deviceOnlyWrite === true && this.session.pendingFullWriteDescription !== true;
		return prompt.render(deviceOnly ? writeDeviceOnlyDescription : writeDescription);
	}
	readonly parameters = writeSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "essential";

	/** Stream matchers should see the real file content, not its JSON-escaped argument encoding. */
	matcherDigest(args: unknown): string | undefined {
		const content = (args as Partial<WriteParams>).content;
		return typeof content === "string" ? content : undefined;
	}

	readonly #deferredDiagnostics: DeferredDiagnostics | undefined;

	constructor(private readonly session: ToolSession) {
		this.#deferredDiagnostics = session.queueDeferredDiagnostics ? new DeferredDiagnostics(session) : undefined;
	}

	/** Resolves the LSP writethrough from the current `lsp.*` settings so changes apply to the next write. */
	#lspWritethrough(options?: { format?: boolean }): {
		writethrough: WritethroughCallback;
		deferred: DeferredDiagnostics | undefined;
	} {
		if (!(this.session.enableLsp ?? true)) return { writethrough: writethroughNoop, deferred: undefined };
		const { settings } = this.session;
		const enableDiagnostics = cfgLspDiagnosticsOnWrite.get(settings);
		const dedup = enableDiagnostics && cfgLspDiagnosticsDeduplicate.get(settings);
		const writethrough = createLspWritethrough(this.session.cwd, {
			enableFormat: options?.format ?? cfgLspFormatOnWrite.get(settings),
			enableDiagnostics,
			transformDiagnostics: dedup
				? (path, result) => getDiagnosticsLedger(this.session).reduce(path, result)
				: undefined,
		});
		return { writethrough, deferred: enableDiagnostics ? this.#deferredDiagnostics : undefined };
	}

	async #resolveArchiveWritePath(writePath: string, signal?: AbortSignal): Promise<ResolvedArchiveWritePath | null> {
		const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallback: ResolvedArchiveWritePath = {
			absolutePath: await resolvePlanPath(this.session, fallbackCandidate.archivePath, signal),
			archivePath: fallbackCandidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
			exists: false,
		};
		for (const candidate of candidates) {
			let absolutePath = await resolvePlanPath(this.session, candidate.archivePath, signal);
			if (this.session.pathScope) {
				absolutePath = (await this.session.pathScope.currentOperation().authorize(absolutePath, "probe"))
					.canonicalTarget;
			}
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) continue;
				return {
					absolutePath,
					archivePath: candidate.archivePath,
					archiveSubPath: normalizeArchiveWriteSubPath(candidate.subPath),
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) throw error;
			}
		}
		if (this.session.pathScope) {
			fallback.absolutePath = (
				await this.session.pathScope.currentOperation().authorize(fallback.absolutePath, "probe")
			).canonicalTarget;
		}

		return fallback;
	}

	async #writeArchiveEntry(
		content: string,
		rawContent: string,
		resolvedArchivePath: ResolvedArchiveWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// The resolver has already canonicalized and authorized the container candidate;
		// do not resolve the ordinary path again after admission.
		const finalPath = resolvedArchivePath.absolutePath;
		// A canonical target can lack an archive extension; a whole-archive
		// rewrite then defaults to an uncompressed tar.
		const inferredFormat = archiveFormatFromPath(finalPath);
		const format = inferredFormat ?? "tar";
		if (!isWritableArchiveFormat(format)) {
			throw new ToolError(`Writing entries inside ${format} archives is not supported (read-only format).`);
		}
		// Rewrites are whole-archive: write to a temp file and rename so a
		// crash/disk-full mid-write cannot destroy the original archive.
		const tmpPath = `${finalPath}.tmp-${process.pid}`;
		const operation = this.session.pathScope?.currentOperation();
		const authorizedTargets = operation
			? await operation.preflight([
					{ path: finalPath, kind: resolvedArchivePath.exists ? "write" : "create" },
					{ path: tmpPath, kind: "create" },
					...(resolvedArchivePath.exists ? [{ path: finalPath, kind: "read" as const }] : []),
				])
			: [];
		const authorizedArchiveTarget = authorizedTargets[0];
		const authorizedTempTarget = authorizedTargets[1];
		const authorizedReadTarget = authorizedTargets[2];

		const parentDir = path.dirname(resolvedArchivePath.absolutePath);
		if (!this.session.pathScope && parentDir && parentDir !== ".") {
			await fs.mkdir(parentDir, { recursive: true });
		}

		const entries = new Map<string, ArchiveMemberContent>();
		if (resolvedArchivePath.exists) {
			try {
				if (operation && authorizedReadTarget) {
					const handle = await operation.openRead(authorizedReadTarget);
					try {
						const size = Number(authorizedReadTarget.size);
						if (!Number.isSafeInteger(size)) throw new ToolError("Archive is too large to read safely");
						const source = {
							size,
							async read(start: number, end: number): Promise<Uint8Array> {
								if (
									!Number.isSafeInteger(start) ||
									!Number.isSafeInteger(end) ||
									start < 0 ||
									end < start ||
									end > size
								) {
									throw new ToolError("Invalid archive range");
								}
								const bytes = Buffer.allocUnsafe(end - start);
								const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, start);
								if (bytesRead !== bytes.byteLength) throw new ToolError("Invalid archive: truncated data");
								return bytes;
							},
						};
						const existing = await readArchiveEntries({ source, format, path: finalPath });
						for (const [entryPath, data] of existing) entries.set(entryPath, data);
					} finally {
						await handle.close();
					}
				} else {
					const existing = await readArchiveEntries({ path: finalPath, format });
					for (const [entryPath, data] of existing) entries.set(entryPath, data);
				}
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
		}
		const writeTarget = `${resolvedArchivePath.archivePath}:${resolvedArchivePath.archiveSubPath}`;
		const sel = readSelectorForEmptyWrite(writeTarget, content);
		if (sel !== undefined && !entries.has(resolvedArchivePath.archiveSubPath)) {
			throwReadSelectorMisfire(writeTarget, sel);
		}
		const existingTarget = entries.get(resolvedArchivePath.archiveSubPath);
		if (existingTarget !== undefined && endsWithReadTruncationNotice(rawContent)) {
			const existingBytes =
				existingTarget instanceof Blob ? new Uint8Array(await existingTarget.arrayBuffer()) : existingTarget;
			const existingText = typeof existingBytes === "string" ? existingBytes : decodeUtf8Text(existingBytes);
			assertNotShorterReadProjection(writeTarget, rawContent, existingText ?? undefined, content);
		}
		entries.set(resolvedArchivePath.archiveSubPath, content);

		try {
			if (operation && authorizedArchiveTarget && authorizedTempTarget) {
				await operation.replaceFile(authorizedArchiveTarget, authorizedTempTarget, authorizedPath =>
					writeArchive(authorizedPath, format, entries),
				);
			} else {
				await writeArchive(tmpPath, format, entries);
				await fs.rename(tmpPath, finalPath);
			}
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}

		invalidateFsScanAfterWrite(resolvedArchivePath.absolutePath);
		const outputPath = `${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
			resolvedArchivePath.archiveSubPath
		}`;
		return {
			content: [
				{ type: "text", text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${outputPath}` },
			],
			details: { resolvedPath: resolvedArchivePath.absolutePath },
		};
	}

	async #resolveSqliteWritePath(writePath: string, signal?: AbortSignal): Promise<ResolvedSqliteWritePath | null> {
		const candidates = parseSqlitePathCandidates(writePath).filter(candidate => candidate.sqlitePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString);
		const fallback: ResolvedSqliteWritePath = {
			absolutePath: await resolvePlanPath(this.session, fallbackCandidate.sqlitePath, signal),
			sqlitePath: fallbackCandidate.sqlitePath,
			table: fallbackTarget.table,
			key: fallbackTarget.key,
			exists: false,
		};

		let sawExistingNonSqlite = false;
		for (const candidate of candidates) {
			const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
			let absolutePath = await resolvePlanPath(this.session, candidate.sqlitePath, signal);
			if (this.session.pathScope) {
				absolutePath = (await this.session.pathScope.currentOperation().authorize(absolutePath, "probe"))
					.canonicalTarget;
			}
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}
				if (!(await isSqliteFile(absolutePath))) {
					sawExistingNonSqlite = true;
					continue;
				}

				return {
					absolutePath,
					sqlitePath: candidate.sqlitePath,
					table: target.table,
					key: target.key,
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		if (sawExistingNonSqlite) {
			return null;
		}

		return fallback;
	}

	async #writeSqliteRow(
		displayPath: string,
		content: string,
		resolvedSqlitePath: ResolvedSqliteWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		let db: Database | null = null;
		let authorizedTargets: readonly AuthorizedFilesystemTarget[] = [];
		try {
			if (!resolvedSqlitePath.exists) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}

			if (this.session.pathScope) {
				const operation = this.session.pathScope.currentOperation();
				const probes = await operation.preflight([
					{ path: resolvedSqlitePath.absolutePath, kind: "probe" },
					{ path: `${resolvedSqlitePath.absolutePath}-wal`, kind: "probe" },
					{ path: `${resolvedSqlitePath.absolutePath}-shm`, kind: "probe" },
				]);
				authorizedTargets = await operation.preflight(
					probes
						.filter((target, index) => index === 0 || target.existed)
						.map(target => ({ path: target.canonicalTarget, kind: "write" as const })),
				);
				for (const target of authorizedTargets) await operation.verify(target);
				resolvedSqlitePath.absolutePath = authorizedTargets[0]!.canonicalTarget;
			}
			db = new Database(resolvedSqlitePath.absolutePath, { create: false, strict: true });
			if (this.session.pathScope) {
				const operation = this.session.pathScope.currentOperation();
				for (const target of authorizedTargets) await operation.verify(target);
			}
			db.run("PRAGMA busy_timeout = 3000");

			const trimmedContent = content.trim();
			let resultText: string;
			if (trimmedContent.length === 0) {
				if (!resolvedSqlitePath.key) {
					throw new ToolError("SQLite deletes require a row key in the path");
				}

				const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
				const deleted =
					lookup.kind === "pk"
						? deleteRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key)
						: deleteRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key);
				resultText =
					deleted > 0
						? `Deleted row '${resolvedSqlitePath.key}' from ${resolvedSqlitePath.table}`
						: `No row deleted from ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
			} else {
				let parsedContent: unknown;
				try {
					parsedContent = Bun.JSON5.parse(content);
				} catch (error) {
					throw new ToolError(
						`SQLite write content must be valid JSON5: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				if (!isRecord(parsedContent)) {
					throw new ToolError("SQLite write content must be a JSON object");
				}

				if (resolvedSqlitePath.key) {
					const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
					const updated =
						lookup.kind === "pk"
							? updateRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key, parsedContent)
							: updateRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key, parsedContent);
					resultText =
						updated > 0
							? `Updated row '${resolvedSqlitePath.key}' in ${resolvedSqlitePath.table}`
							: `No row updated in ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
				} else {
					insertRow(db, resolvedSqlitePath.table, parsedContent);
					resultText = `Inserted row into ${resolvedSqlitePath.table}`;
				}
			}

			if (this.session.pathScope) {
				const operation = this.session.pathScope.currentOperation();
				for (const target of authorizedTargets) await operation.verify(target);
			}
			invalidateFsScanAfterWrite(resolvedSqlitePath.absolutePath);
			return toolResult<WriteToolDetails>({ resolvedPath: resolvedSqlitePath.absolutePath })
				.text(resultText)
				.sourcePath(resolvedSqlitePath.absolutePath)
				.done();
		} catch (error) {
			if (isEnoent(error)) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		} finally {
			db?.close();
		}
	}

	async execute(
		_toolCallId: string,
		{ path: rawPath, content: rawContent }: WriteParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Strip a hashline `[path#TAG]` wrapper up front so every downstream
		// decision (scheme routing, internal-URL handler dispatch, plan-mode
		// guard, plan path resolution, ACP bridge routing) sees the same
		// filesystem target. Without this, a model that pastes a `read`
		// header as the `path` arg would slip past internal-URL detection
		// (which fails on a leading `[`) and the bridge router would send a
		// `[local://scratch.md#ABCD]` write to the editor instead of the
		// session-local sandbox.
		// Peel a read-tool selector (`:raw`, `:1-20`, …) so the write target matches
		// what `read` resolves for the same URL; line-range/malformed selectors throw.
		// A `<file>:conflict://N` target is normalized to its URL; the note tells the model.
		const router = InternalUrlRouter.instance();
		const recovered = recoverConflictUriPrefix(router.peelWriteSelector(unwrapHashlineHeaderPath(rawPath), "write"));
		const path = recovered.path;
		const target = router.writeTarget(path);
		const policy = target?.spec.write;
		if (rawContent === undefined && !(target && policy?.contentOptional?.(target.url))) {
			throw new ToolError(`content is required for ${path}.`);
		}
		const content = rawContent ?? "";
		// A device-only session grants `write` purely as the device transport (see
		// createTools): device dispatches and coordination messages proceed, every
		// other target is rejected before any handler, guard, conflict resolver, or
		// bridge sees it. Active plan mode additionally permits its sandbox, but does
		// not relax the restriction for working-tree or other internal URLs.
		if (
			this.session.deviceOnlyWrite === true &&
			policy?.scope !== "device" &&
			policy?.scope !== "coordination" &&
			!(
				this.session.getPlanModeState?.()?.enabled === true &&
				(await targetsLocalSandbox(this.session, path, signal))
			)
		) {
			throw new ToolError(
				"This `write` tool is limited to the xd:// device transport: call it with path `xd://<tool>` and the device's JSON arguments in `content` (`read xd://` lists mounted devices). Active plan mode additionally permits local:// sandbox drafts. Filesystem writes are not available elsewhere.",
			);
		}
		return untilAborted(signal, async () => {
			// Text payloads get hashline display prefixes ([PATH#HASH] + LINE:) stripped if the model
			// copied them from read output. Verbatim payloads (messages, process stdin, setting
			// values, conflict directives) reach their handler exactly as the model wrote them.
			const verbatim = policy?.payload === "verbatim";
			const { text: cleanContent, stripped } = verbatim
				? { text: content, stripped: false }
				: stripWriteContent(this.session, content);
			assertWriteTargetAddressable(path, router);
			if (target) {
				if (policy?.via === "handler") {
					// Device payloads are dispatch arguments, not resource text, so only
					// non-device text writes are checked against a truncated read projection.
					if (!verbatim && target.spec.backing !== "device" && endsWithReadTruncationNotice(content)) {
						const currentResource = await router.resolve(path, sessionResolveContext(this.session, { signal }));
						assertNotShorterReadProjection(path, content, currentResource.content, cleanContent);
					}
					// Handler-owned writes mutate state outside the sandbox unless the
					// scheme is coordination (peer messages) or a device (which keeps each
					// dispatched tool's own tier and policy).
					if (policy?.scope !== "device") {
						if (policy?.scope !== "coordination") {
							await enforcePlanModeWrite(this.session, path, { op: "update", signal });
						}
						emitWriteProgress(onUpdate, cleanContent, path);
					}
					const handlerResult = await router.write(
						path,
						cleanContent,
						sessionWriteContext(this.session, {
							signal,
							toolCall: { id: _toolCallId, onUpdate, context },
						}),
					);
					if (handlerResult) {
						const result: AgentToolResult<WriteToolDetails> = {
							content: handlerResult.content,
							details: handlerResult.details ?? {},
							isError: handlerResult.isError,
							useless: handlerResult.useless,
						};
						if (recovered.note) appendNoteToResult(result, recovered.note);
						return result;
					}
					let resultText = `Successfully wrote ${Buffer.byteLength(cleanContent, "utf8")} bytes to ${path}`;
					if (stripped) {
						resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
					return { content: [{ type: "text", text: resultText }], details: {} };
				}
				// Read-only scheme: the router rejects the write with its uniform error.
				if (!policy) await router.write(path, cleanContent);
				// `via: "file"`: the pipeline below writes the located target (resolvePlanPath),
				// so write and read share one path.
			}

			const resolvedArchivePath = await this.#resolveArchiveWritePath(path, signal);
			if (resolvedArchivePath) {
				await enforcePlanModeWrite(this.session, resolvedArchivePath.archivePath, {
					op: resolvedArchivePath.exists ? "update" : "create",
					signal,
				});

				emitWriteProgress(
					onUpdate,
					cleanContent,
					`${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
						resolvedArchivePath.archiveSubPath
					}`,
					resolvedArchivePath.absolutePath,
				);
				const archiveResult = await this.#writeArchiveEntry(cleanContent, content, resolvedArchivePath);
				if (stripped) {
					const firstText = archiveResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
				}
				return archiveResult;
			}

			const resolvedSqlitePath = await this.#resolveSqliteWritePath(path, signal);
			if (resolvedSqlitePath) {
				await enforcePlanModeWrite(this.session, resolvedSqlitePath.sqlitePath, { op: "update", signal });

				emitWriteProgress(onUpdate, cleanContent, path, resolvedSqlitePath.absolutePath);
				const sqliteResult = await this.#writeSqliteRow(path, cleanContent, resolvedSqlitePath);
				if (stripped) {
					const firstText = sqliteResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
				}
				return sqliteResult;
			}

			await assertNotReadSelectorMisfire(path, cleanContent, this.session.cwd);
			await enforcePlanModeWrite(this.session, path, { op: "create", signal });
			let absolutePath = await resolvePlanPath(this.session, path, signal);
			const localWrite =
				target?.url.protocol === "local:"
					? await prepareLocalFileWrite(target.url, sessionWriteContext(this.session, { signal }))
					: undefined;
			if (localWrite) absolutePath = localWrite.path;
			const authorizedTarget = localWrite
				? (localWrite.authorizedTarget ??
					(this.session.pathScope
						? await this.session.pathScope.currentOperation().authorize(absolutePath, "write")
						: undefined))
				: this.session.pathScope
					? await this.session.pathScope.currentOperation().authorize(absolutePath, "write")
					: undefined;
			if (authorizedTarget) {
				absolutePath = authorizedTarget.canonicalTarget;
				await this.session.pathScope!.currentOperation().verify(authorizedTarget);
			}
			// A located URL write keeps its URL identity in progress, results, and the hashline header.
			const displayPath = target ? path : formatPathRelativeToCwd(absolutePath, this.session.cwd);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			const existing = await fs.stat(absolutePath).catch(() => undefined);
			if (target && existing?.isDirectory()) {
				throw new ToolError(`${target.url.protocol}// URL must resolve to a file: ${path}`);
			}
			// Check if file exists and is auto-generated before overwriting.
			if (existing) {
				await assertEditableFile(absolutePath, path, this.session.settings);
			}
			await assertNotTruncatedFileReadProjection(
				this.session,
				path,
				absolutePath,
				displayPath,
				content,
				cleanContent,
			);

			emitWriteProgress(onUpdate, cleanContent, displayPath, absolutePath);

			// Try ACP bridge first for editor-visible filesystem paths. Internal
			// artifacts such as local:// plans are owned by OMP, not the editor.
			if (authorizedTarget) await this.session.pathScope!.currentOperation().verify(authorizedTarget);
			const bridgeWrite = localWrite
				? undefined
				: await routeWriteThroughBridge(this.session, path, absolutePath, cleanContent, signal);
			if (bridgeWrite) {
				// `write` always replaces the whole file, so (unlike hashline's
				// hunk-scoped diff) there's no size cost to keying the header/
				// executable-bit check on the verified post-write content —
				// use it so a drifted write (e.g. client format-on-save) still
				// hands back a tag that matches what's actually on disk.
				if (authorizedTarget) await this.session.pathScope!.currentOperation().verifyPostWrite(authorizedTarget);
				const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, bridgeWrite.text);
				const header = maybeWriteSnapshotHeader(this.session, absolutePath, bridgeWrite.text, displayPath);
				const writeLine = `Successfully wrote ${Buffer.byteLength(cleanContent, "utf8")} bytes to ${displayPath}`;
				let resultText = header ? `${header}\n${writeLine}` : writeLine;
				if (stripped) {
					resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
				}
				if (madeExecutable) {
					resultText += `\n${EXECUTABLE_NOTICE}`;
				}
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			const { writethrough, deferred } = this.#lspWritethrough(localWrite?.durable ? { format: false } : undefined);
			const writeEffect = async () => {
				if (authorizedTarget) await this.session.pathScope!.currentOperation().verify(authorizedTarget);
				const diagnostics = await writethrough(absolutePath, cleanContent, signal, undefined, batchRequest, dst =>
					deferred?.begin(dst),
				);
				if (authorizedTarget && (!localWrite || !localWrite.authorizedTarget)) {
					await this.session.pathScope!.currentOperation().verifyPostWrite(authorizedTarget);
				}
				return diagnostics;
			};
			const diagnostics = localWrite ? await localWrite.commit(cleanContent, writeEffect) : await writeEffect();
			if (!deferred || batchRequest?.flush === false) {
				this.session.bumpFileMutationVersion?.(absolutePath);
			}
			const finalContent = diagnostics.finalContent;
			const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, finalContent);

			const header = maybeWriteSnapshotHeader(this.session, absolutePath, finalContent, displayPath);
			const writeLine = `Successfully wrote ${Buffer.byteLength(finalContent, "utf8")} bytes to ${displayPath}`;
			let resultText = header ? `${header}\n${writeLine}` : writeLine;
			if (stripped) {
				resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
			}
			if (madeExecutable) {
				resultText += `\n${EXECUTABLE_NOTICE}`;
			}
			if (!diagnostics.diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					resolvedPath: absolutePath,
					diagnostics: diagnostics.diagnostics,
					madeExecutable: madeExecutable || undefined,
					meta: outputMeta()
						.diagnostics(diagnostics.diagnostics.summary, diagnostics.diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** Bounded newline scan: whether `text` spans more than `maxLines` lines.
 *  Runs on every live compose (the repaint predicate below), so it must not
 *  materialize the split the way `countLines` does. */
function exceedsLineCount(text: string, maxLines: number): boolean {
	if (!text) return false;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		if (++lines > maxLines) return true;
	}
	return false;
}

function writeContentOf(args: unknown): string {
	if (args == null || typeof args !== "object" || !("content" in args)) return "";
	const content = args.content;
	return typeof content === "string" ? content : "";
}

function formatLineCountSuffix(lineCount: number, uiTheme: Theme): string {
	if (lineCount <= 0) return "";
	return uiTheme.fg("dim", ` · ${lineCount} line${lineCount === 1 ? "" : "s"}`);
}

function normalizeDisplayText(text: unknown): string {
	let displayText = "";
	if (typeof text === "string") {
		displayText = text;
	} else if (text !== undefined && text !== null) {
		displayText = String(text);
	}
	return displayText.replace(/\r/g, "");
}

/**
 * Minimum line-number gutter width for write previews. The streaming preview's
 * gutter must stay byte-stable as the line count grows: a width derived purely
 * from `String(totalLines).length` widens at the 10/100/1000-line crossings,
 * causing the live preview to jitter. Reserving 3 digits keeps the gutter
 * constant through 999 lines and keeps the streamed rows aligned with the
 * final result render.
 */
const WRITE_GUTTER_MIN_WIDTH = 3;

const writeStreamingPreviewStateKey = Symbol("writeStreamingPreviewState");

/**
 * Per-component state for incrementally rendering a streamed write.
 * The ToolExecutionComponent's persistent render options carry the state, so
 * it lives exactly as long as the component and cannot leak across tool calls.
 */
interface WriteStreamingPreviewState {
	/** Prior full content; append-only growth is validated with an exact prefix check. */
	previous: string;
	/** `1 + count("\n")` over the scanned content. */
	lineCount: number;
	/** Raw offset immediately after the last newline consumed by `highlighter`. */
	completeLength: number;
	/** Highlighted, complete logical lines; the unfinished trailing line is rendered plain. */
	highlightedLines: string[];
	/** Stateful parser carrying syntax scopes across appended complete lines. */
	highlighter: HighlightStream | null;
	language: string | undefined;
	uiTheme: Theme;
	/** Content length for which the trailing line was flushed as final (`argsComplete`); -1 when none. */
	finalFlushedLength: number;
	/** Highlighted trailing line from the final flush; rendered in place of the plain tail. */
	finalTrailing: string;
}

interface WriteStreamingPreviewStateCarrier {
	[writeStreamingPreviewStateKey]?: WriteStreamingPreviewState;
}

function createWriteStreamingPreviewState(language: string | undefined, uiTheme: Theme): WriteStreamingPreviewState {
	return {
		previous: "",
		lineCount: 1,
		completeLength: 0,
		highlightedLines: [],
		highlighter: createHighlightStream(language, uiTheme),
		language,
		uiTheme,
		finalFlushedLength: -1,
		finalTrailing: "",
	};
}

/**
 * Advance line counting and syntax highlighting only across newly appended
 * content. Complete lines are retained because Ctrl+O can expand the preview;
 * the current partial line stays plain until its terminating newline arrives.
 * Once args are final, the trailing line is flushed through the highlighter
 * (its only push without a trailing newline) so a settled-but-queued preview
 * keeps syntax colors, including for one-line files.
 */
function updateStreamingPreview(
	streamKey: WriteStreamingPreviewStateCarrier | undefined,
	content: string,
	language: string | undefined,
	uiTheme: Theme,
	argsComplete = false,
): WriteStreamingPreviewState | undefined {
	if (streamKey === undefined) return undefined;

	let state = streamKey[writeStreamingPreviewStateKey];
	if (
		state === undefined ||
		state.language !== language ||
		state.uiTheme !== uiTheme ||
		content.length < state.previous.length ||
		!content.startsWith(state.previous) ||
		// A final flush consumed the trailing partial line; later growth would
		// re-feed it, so restart the parser instead of corrupting its state.
		(state.finalFlushedLength !== -1 && content.length !== state.finalFlushedLength)
	) {
		state = createWriteStreamingPreviewState(language, uiTheme);
		streamKey[writeStreamingPreviewStateKey] = state;
	}

	let completeLength = state.completeLength;
	for (let i = state.previous.length; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			state.lineCount++;
			completeLength = i + 1;
		}
	}
	if (completeLength > state.completeLength) {
		const chunk = content.slice(state.completeLength, completeLength).replace(/\r/g, "");
		let chunkHighlighted = chunk;
		if (state.highlighter) {
			try {
				chunkHighlighted = state.highlighter.push(chunk);
			} catch {
				state.highlighter = null;
			}
		}
		const lines = chunkHighlighted.split("\n");
		lines.pop();
		state.highlightedLines.push(...lines);
		state.completeLength = completeLength;
	}
	if (argsComplete && state.finalFlushedLength !== content.length && !content.endsWith("\n")) {
		const trailing = content.slice(state.completeLength).replace(/\r/g, "");
		if (trailing.length > 0) {
			let trailingHighlighted = trailing;
			if (state.highlighter) {
				try {
					trailingHighlighted = state.highlighter.push(trailing);
				} catch {
					state.highlighter = null;
				}
			}
			state.finalTrailing = trailingHighlighted;
			state.finalFlushedLength = content.length;
		}
	}
	state.previous = content;
	return state;
}

function formatStreamingContent(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	spinnerFrame?: number,
	cache?: RenderedStringCache,
	streamKey?: WriteStreamingPreviewStateCarrier,
	argsComplete?: boolean,
): string {
	if (!content) return "";
	const bodyText = cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const state = updateStreamingPreview(streamKey, content, language, uiTheme, argsComplete === true);
		let totalLines: number;
		let startIndex: number;
		let visibleLines: string[];
		if (state) {
			totalLines = state.lineCount;
			startIndex = expanded ? 0 : Math.max(0, totalLines - WRITE_STREAMING_PREVIEW_LINES);
			const flushed = argsComplete === true && state.finalFlushedLength === content.length;
			const trailingLine = flushed ? state.finalTrailing : content.slice(state.completeLength).replace(/\r/g, "");
			if (totalLines === 1 && trailingLine.length === 0) return "";
			visibleLines = [...state.highlightedLines.slice(startIndex), trailingLine];
		} else {
			const normalized = normalizeDisplayText(content);
			if (normalized.length === 0) return "";
			const lines = normalized.split("\n");
			totalLines = lines.length;
			startIndex = expanded ? 0 : Math.max(0, totalLines - WRITE_STREAMING_PREVIEW_LINES);
			visibleLines = highlightCode(lines.slice(startIndex).join("\n"), language);
		}
		const hidden = startIndex;
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);

		let text = "\n\n";
		if (hidden > 0) {
			text += `${uiTheme.fg("dim", `… (${hidden} earlier line${hidden === 1 ? "" : "s"})`)}\n`;
		}
		for (let i = 0; i < visibleLines.length; i++) {
			const lineNum = startIndex + i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(visibleLines[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		return text;
	});
	if (bodyText.length === 0) return "";
	// The animated glyph lives on this trailing line — inside the transcript's
	// volatile-tail holdback — never in the header: an animating head row pins
	// the native-scrollback commit boundary at the top of the block, so a long
	// expanded preview could never scroll-append mid-stream.
	const spinner = spinnerFrame !== undefined ? `${formatStatusIcon("running", uiTheme, spinnerFrame)} ` : "";
	return `${bodyText}${spinner}${uiTheme.fg("dim", `… (streaming)`)}`;
}

function renderContentPreview(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	return cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const rawLines = normalizeDisplayText(content).split("\n");
		const totalLines = rawLines.length;
		const maxLines = expanded ? totalLines : Math.min(totalLines, WRITE_PREVIEW_LINES);
		const visibleLines = rawLines.slice(0, maxLines);
		const highlighted = highlightCode(visibleLines.join("\n"), language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
		const hidden = totalLines - maxLines;

		let text = "\n\n";
		for (let i = 0; i < highlighted.length; i++) {
			const lineNum = i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(highlighted[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		if (!expanded && hidden > 0) {
			const hint = formatExpandHint(uiTheme, expanded, hidden > 0);
			const moreLine = `${formatMoreItems(hidden, "line")}${hint ? ` ${hint}` : ""}`;
			text += uiTheme.fg("dim", moreLine);
		}
		return text.trimEnd();
	});
}

/** Render context for the write tool: resolves an `xd://`-mounted tool so its live renderer drives device dispatch previews. */
export interface WriteRenderContext {
	resolveXdevMounted?: (name: string) => AgentTool | undefined;
}

export const writeToolRenderer = {
	/** Compact one-line activity: device writes read as the mounted tool (`LSP · references foo`), file writes as `Write · <path>`. */
	activitySummary(args: unknown, context: ToolActivityContext): ToolActivitySummary {
		const writeArgs = (args ?? {}) as WriteRenderArgs;
		const rawPath =
			typeof writeArgs.file_path === "string"
				? writeArgs.file_path
				: typeof writeArgs.path === "string"
					? writeArgs.path
					: "";
		if (!rawPath) return { label: "Write" };
		const xdev = parseXdUrl(rawPath);
		if (xdev?.name) {
			const resolveMounted = (context.renderContext as WriteRenderContext | undefined)?.resolveXdevMounted;
			return xdevActivitySummary(xdev.name, writeArgs.content, resolveMounted);
		}
		return { label: "Write", detail: shortenPath(rawPath) };
	},

	renderCall(
		args: WriteRenderArgs,
		options: RenderResultOptions & WriteStreamingPreviewStateCarrier & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
	): Component | undefined {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		// Render NOTHING until the streamed path arrives and provably is not an
		// xd:// device. Device writes then render as queued until execution starts,
		// after which they delegate to the mounted tool's renderer.
		// A present-but-malformed path (array/object from a bad provider parse)
		// is definitively not xd:// — fall through to the legacy frame.
		if (args.path === undefined && args.file_path === undefined) return undefined;
		if (rawPath && couldBecomeXdUrl(rawPath)) {
			const xdev = parseXdUrl(rawPath);
			// The path string is settled once the content field started streaming.
			const pathSettled = args.content !== undefined;
			if (!xdev?.name || !pathSettled) return undefined;
			if (isResolutionDeviceName(xdev.name)) return renderResolutionDeviceCall(xdev.name, args.content, uiTheme);
			if (xdev.name === REPORT_ISSUE_DEVICE_NAME) return renderReportIssueDeviceCall(args.content, uiTheme);
			return renderXdevCall(xdev.name, args.content, options, uiTheme, options.renderContext?.resolveXdevMounted);
		}
		const filePath = shortenPath(rawPath);
		const lang = rawPath ? (getLanguageFromPath(rawPath) ?? "text") : "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		// No status icon on the head row: it's the head of the framed block, and
		// native-scrollback commits are prefix-only — an animated glyph would pin
		// the commit boundary at the top, and the pending hourglass just adds
		// noise. The liveness cue rides the trailing "(streaming)" line instead.
		const header = renderStatusLine(
			{
				title: "Write",
				description: `${langIcon} ${pathDisplay}`,
			},
			uiTheme,
		);
		// Raw content, not normalizeDisplayText(args.content): the collapsed
		// streaming path normalizes only its tail window, so a full-payload
		// normalize on every reveal tick would re-introduce the O(n²) streaming
		// cost formatStreamingContent avoids. Non-string content still falls
		// back to the normalizing stringify.
		const content = typeof args.content === "string" ? args.content : normalizeDisplayText(args.content);
		const streamingCache = createRenderedStringCache();
		return framedToolCard(uiTheme, () => {
			const body = content
				? formatStreamingContent(
						content,
						Boolean(options?.expanded),
						lang,
						uiTheme,
						options?.spinnerFrame,
						streamingCache,
						options,
						options?.argsComplete,
					)
				: "";
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ content: bodyLines }] : [],
				phase: "pending",
				borderColor: "borderMuted",
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		// xd:// dispatch results render as the mounted tool's own result.
		const xdev = result.details?.xdev;
		if (xdev) {
			const delegated = renderXdevResult(xdev, result, options, uiTheme, options.renderContext?.resolveXdevMounted);
			if (delegated) return delegated;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			return new Text(uiTheme.fg("toolOutput", replaceTabs(text)), 0, 0);
		}
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const filePath = shortenPath(rawPath);
		const fileContent = normalizeDisplayText(args?.content);
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		// The header shows the cwd-relative path but links to the absolute path the
		// write resolved to (args.path may be relative, which would yield a broken
		// `file://` URI). Falls back to plain text when the result lacks a path.
		const linkTarget = result.details?.resolvedPath;
		const styledPath = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const pathDisplay = filePath && linkTarget ? fileHyperlink(linkTarget, styledPath) : styledPath;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const header = renderStatusLine(
				{ icon: "error", title: "Write", description: `${langIcon} ${pathDisplay}` },
				uiTheme,
			);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [{ content: formatErrorDetail(errorText, uiTheme).split("\n") }],
				phase: "error",
				borderColor: "error",
			}));
		}
		const isPartial = options.isPartial === true;
		const progressText = result.content?.find(c => c.type === "text")?.text ?? "";
		const lineCount = countLines(fileContent);
		const lineSuffix = formatLineCountSuffix(lineCount, uiTheme);
		const execSuffix =
			!isPartial && result.details?.madeExecutable
				? `${uiTheme.fg("dim", " · ")}${uiTheme.fg("success", "made executable!")}`
				: "";
		const header = renderStatusLine(
			{
				icon: isPartial ? "running" : undefined,
				iconOverride: isPartial ? undefined : uiTheme.styledSymbol("tool.write", "accent"),
				spinnerFrame: options.spinnerFrame,
				title: "Write",
				description: `${langIcon} ${pathDisplay}${lineSuffix}${execSuffix}`,
			},
			uiTheme,
		);
		const diagnostics = result.details?.diagnostics;

		const previewCache = createRenderedStringCache();
		return framedToolCard(uiTheme, () => {
			const { expanded } = options;
			let body = renderContentPreview(fileContent, expanded, lang, uiTheme, previewCache);
			if (isPartial && progressText) {
				const safeProgressText = truncateToWidth(
					replaceTabs(progressText),
					TRUNCATE_LENGTHS.LINE,
					Ellipsis.Unicode,
				);
				body = `${uiTheme.fg("muted", safeProgressText)}${body ? `\n${body}` : ""}`;
			}
			if (!isPartial && diagnostics) {
				const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
					uiTheme.getLangIcon(getLanguageFromPath(fp)),
				);
				if (diagText.trim()) {
					const diagLines = diagText.split("\n");
					const firstNonEmpty = diagLines.findIndex(line => line.trim());
					if (firstNonEmpty >= 0) body += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
				}
			}
			const bodyLines = body.split("\n");
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ content: bodyLines }] : [],
				phase: isPartial ? "pending" : "success",
				borderColor: "borderMuted",
			};
		});
	},
	mergeCallAndResult: true,
	// The collapsed pending preview follows the streaming edge with a tail
	// window once the content outgrows it (`… (N earlier lines)` + last rows);
	// the first partial result re-anchors the frame to the top of the file, so
	// tail rows already committed to viewport/native scrollback would survive
	// as stale content above the new frame without a full replay. Expanded and
	// short previews stay top-anchored and skip the (scrollback-wiping) reset.
	forceFirstResultViewportRepaint: (args: unknown, options: RenderResultOptions) =>
		!options.expanded && exceedsLineCount(writeContentOf(args), WRITE_STREAMING_PREVIEW_LINES),
};
