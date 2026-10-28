import * as path from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type ArchiveFormat,
	type ArchiveReader,
	type ArchiveNode,
	type ByteSource,
	archiveFormatFromPath,
	formatArchiveEntryLines,
	fileByteSource,
	openArchive,
	parseArchivePathCandidates,
} from "@oh-my-pi/pi-utils/ar";
import type { AuthorizedFilesystemTarget } from "../internal/session-path-scope";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { ToolSession } from "../sdk";
import { convertBufferWithMarkit } from "../utils/markit";
import { truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { applyListLimit } from "@oh-my-pi/pi-tui/tools/list-limit";
import { resolveReadPath } from "./path-utils";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import {
	buildInMemorySelectorResult,
	decodeUtf8Text,
	markMarkdownContentType,
	prependSuffixResolutionNotice,
	toReadTruncationStats,
} from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { isMultiRange, type ParsedSelector, parseSel, resolveTailSelector, selToOffsetLimit } from "./read-selector";
import { type PdfImageReadTarget, type PdfPageReadOptions, splitPdfImageReadPath } from "./read-pdf";
import { cfgReadRenderMarkdown } from "./settings";
import { formatBytes } from "@oh-my-pi/pi-tui/render/render-utils";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";

interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
	authorizedTarget?: AuthorizedFilesystemTarget;
}

/**
 * Formats whose reader retains only the member index: payloads are ranged
 * reads from disk. Stream containers buffer the whole archive and RAR/7z keep
 * decoded solid blocks, so caching those would pin up to their in-memory limit.
 */
const CACHEABLE_ARCHIVE_FORMATS: Partial<Record<ArchiveFormat, true>> = { tar: true, zip: true, asar: true, iso: true };

interface CachedArchiveReader {
	reader: ArchiveReader;
	ino: number;
	mtimeMs: number;
	/** Change time is an additional invalidation signal, not a content identity. */
	ctimeMs: number;
	size: number;
	contentFingerprint: string;
	indexReadRanges: [number, number][];
	entryCount: number;
}
/** Validate the exact byte ranges consumed to construct the retained reader's index. */
async function archiveIndexFingerprint(
	source: ByteSource,
	indexReadRanges: [number, number][],
): Promise<string | undefined> {
	try {
		const hasher = createHash("sha256");
		for (const [start, end] of indexReadRanges) {
			const bytes = await source.read(start, end);
			hasher.update(`${start}:${end}:`).update(bytes);
		}
		return hasher.digest("hex");
	} catch {
		// Let the ordinary opener report vanished, unreadable, or truncated archives.
		return undefined;
	}
}

/**
 * Recently opened archives, so paging through members can reuse their reader.
 * Validation rereads only the ranges consumed while constructing that index.
 * Bounded by count and total indexed entries; metadata and all bytes consumed
 * while building the retained index must match before reuse.
 */
const archiveReaderCache = new LRUCache<string, CachedArchiveReader>({
	max: 4,
	maxSize: 200_000,
	sizeCalculation: cached => Math.max(1, cached.entryCount),
});

async function openArchiveCached(absolutePath: string): Promise<ArchiveReader> {
	// A vanished or unreadable archive is reported by the opener, as it always has been.
	const file = Bun.file(absolutePath);
	const stat = await file.stat().catch(() => null);
	if (!stat) return openArchive(absolutePath);
	const format = archiveFormatFromPath(absolutePath) as ArchiveFormat | undefined;
	if (!format || !CACHEABLE_ARCHIVE_FORMATS[format]) {
		archiveReaderCache.delete(absolutePath);
		return openArchive(absolutePath);
	}
	const source = fileByteSource(absolutePath);
	const cached = archiveReaderCache.get(absolutePath);
	if (
		cached &&
		cached.ino === stat.ino &&
		cached.mtimeMs === stat.mtimeMs &&
		cached.ctimeMs === stat.ctimeMs &&
		cached.size === stat.size &&
		cached.size === source.size
	) {
		const contentFingerprint = await archiveIndexFingerprint(source, cached.indexReadRanges);
		if (contentFingerprint !== undefined && contentFingerprint === cached.contentFingerprint) return cached.reader;
	}
	const indexReadRanges: [number, number][] = [];
	let indexHasher: Hash | undefined = createHash("sha256");
	const reader = await openArchive({
		format,
		path: absolutePath,
		source: {
			size: source.size,
			async read(start, end) {
				const bytes = await source.read(start, end);
				if (indexHasher) {
					indexReadRanges.push([start, end]);
					indexHasher.update(`${start}:${end}:`).update(bytes);
				}
				return bytes;
			},
		},
	});
	const contentFingerprint = indexHasher.digest("hex");
	// Member sources retain this wrapper; payload reads must not enter the finalized index hash.
	indexHasher = undefined;
	let entryCount = 0;
	for (const _entry of reader.indexEntries()) entryCount++;
	archiveReaderCache.set(absolutePath, {
		reader,
		ino: stat.ino,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		size: source.size,
		contentFingerprint,
		indexReadRanges,
		entryCount,
	});
	return reader;
}
export async function resolveArchiveReadPath(
	session: ToolSession,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedArchiveReadPath | null> {
	const candidates = parseArchivePathCandidates(readPath);
	for (const candidate of candidates) {
		let absolutePath = resolveReadPath(candidate.archivePath, session.cwd);
		let authorizedTarget: AuthorizedFilesystemTarget | undefined;
		if (session.pathScope) {
			const probe = await session.pathScope.currentOperation().authorize(absolutePath, "probe");
			absolutePath = probe.canonicalTarget;
		}
		let suffixResolution: { from: string; to: string } | undefined;

		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory()) continue;
			if (session.pathScope) {
				authorizedTarget = await session.pathScope.currentOperation().authorize(absolutePath, "read");
				absolutePath = authorizedTarget.canonicalTarget;
			}
			return {
				absolutePath,
				archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
				suffixResolution,
				authorizedTarget,
			};
		} catch (error) {
			if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

			const suffixMatch = await findSuffixMatchCached(session, suffixCache, candidate.archivePath, signal);
			if (!suffixMatch) continue;

			try {
				const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
				if (retryStat.isDirectory()) continue;

				absolutePath = suffixMatch.absolutePath;
				if (session.pathScope) {
					const probe = await session.pathScope.currentOperation().authorize(absolutePath, "probe");
					absolutePath = probe.canonicalTarget;
				}
				suffixResolution = { from: candidate.archivePath, to: suffixMatch.displayPath };
				if (session.pathScope) {
					authorizedTarget = await session.pathScope.currentOperation().authorize(absolutePath, "read");
					absolutePath = authorizedTarget.canonicalTarget;
				}
				return {
					absolutePath,
					archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
					suffixResolution,
					authorizedTarget,
				};
			} catch (retryError) {
				if (!isNotFoundError(retryError)) {
					throw retryError;
				}
			}
		}
	}

	return null;
}
async function readArchiveDirectory(
	archive: ArchiveReader,
	archivePath: string,
	subPath: string,
	sel: ParsedSelector,
	details: ReadToolDetails,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const DEFAULT_LIMIT = 500;
	const allEntries = archive.listDirectory(subPath);
	for (const entry of allEntries) assertSafeArchiveNode(entry);
	// Selectors address entries with line semantics: `a.zip:dir:50` starts the
	// listing at the 50th entry, `a.zip:dir:-20` lists the last 20.
	const { offset, limit } = selToOffsetLimit(resolveTailSelector(sel, allEntries.length));
	const effectiveLimit = limit ?? DEFAULT_LIMIT;
	const entries = offset !== undefined && offset > 1 ? allEntries.slice(offset - 1) : allEntries;

	const listLimit = applyListLimit(entries, { limit: effectiveLimit });
	const limitedEntries = listLimit.items;
	const limitMeta = listLimit.meta;

	for (let index = 0; index < limitedEntries.length; index++) {
		throwIfAborted(signal);
	}
	const results = formatArchiveEntryLines(limitedEntries);

	const output = results.length > 0 ? results.join("\n") : "(empty archive directory)";
	const text = prependSuffixResolutionNotice(output, details.suffixResolution);
	const truncation = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
	const directoryDetails: ReadToolDetails = { ...details, isDirectory: true };
	const resultBuilder = toolResult<ReadToolDetails>(directoryDetails).text(truncation.content);
	resultBuilder.sourcePath(archivePath).limits({ resultLimit: limitMeta.resultLimit?.reached });
	if (truncation.truncated) {
		directoryDetails.truncation = toReadTruncationStats(truncation);
		resultBuilder.truncation(truncation, { direction: "head" });
	}
	return resultBuilder.done();
}

function assertSafeArchiveMemberPath(memberPath: string): void {
	const normalized = memberPath.replaceAll("\\", "/");
	if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(memberPath) || normalized.split("/").includes("..")) {
		throw new ToolError(`Archive member path escapes its container: ${memberPath}`);
	}
}

function assertSafeArchiveNode(node: ArchiveNode): void {
	assertSafeArchiveMemberPath(node.path);
	if (node.mode !== undefined && (node.mode & 0o170000) === 0o120000) {
		throw new ToolError(`Archive link entries are not readable: ${node.path}`);
	}
}

async function openResolvedArchive(
	session: ToolSession,
	resolved: ResolvedArchiveReadPath,
): Promise<{ archive: ArchiveReader; close(): Promise<void> }> {
	if (!session.pathScope) {
		return { archive: await openArchiveCached(resolved.absolutePath), close: async () => undefined };
	}
	if (!resolved.authorizedTarget) throw new Error("Missing authorized filesystem target for archive read");
	const operation = session.pathScope.currentOperation();
	const handle = await operation.openRead(resolved.authorizedTarget, "archive");
	try {
		const format = archiveFormatFromPath(resolved.absolutePath) as ArchiveFormat | undefined;
		if (!format) throw new ToolError(`Unsupported archive format: ${resolved.absolutePath}`);
		const size = Number(resolved.authorizedTarget.size);
		if (!Number.isSafeInteger(size)) throw new ToolError("Archive is too large to read safely");
		const source = {
			size,
			async read(start: number, end: number): Promise<Uint8Array> {
				if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) {
					throw new ToolError("Invalid archive range");
				}
				const bytes = Buffer.allocUnsafe(end - start);
				const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, start);
				if (bytesRead !== bytes.byteLength) throw new ToolError("Invalid archive: truncated data");
				return bytes;
			},
		};
		const archive = await openArchive({ source, format, path: resolved.absolutePath });
		return { archive, close: () => handle.close() };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

export async function readArchive(
	session: ToolSession,
	readPath: string,
	parsedSel: ParsedSelector,
	resolvedArchivePath: ResolvedArchiveReadPath,
	readPdfPage: (options: PdfPageReadOptions) => Promise<AgentToolResult<ReadToolDetails>>,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);
	assertSafeArchiveMemberPath(resolvedArchivePath.archiveSubPath);
	const opened = await openResolvedArchive(session, resolvedArchivePath);
	try {
		throwIfAborted(signal);
		const archive = opened.archive;
		const details: ReadToolDetails = markMarkdownContentType(
			session,
			{
				resolvedPath: resolvedArchivePath.absolutePath,
				suffixResolution: resolvedArchivePath.suffixResolution,
			},
			resolvedArchivePath.archiveSubPath,
		);

		let archiveSubPath = resolvedArchivePath.archiveSubPath;
		let sel = parsedSel;
		let pdfImageRead: PdfImageReadTarget | null = null;
		let node = archive.getNode(archiveSubPath);
		if (!node && archiveSubPath) {
			// Member names take precedence; otherwise a whole subPath can be a selector on the archive root.
			const wholeSel = parseSel(archiveSubPath);
			if (wholeSel.kind !== "none") {
				node = archive.getNode("");
				archiveSubPath = "";
				sel = wholeSel;
			}
		}
		if (!node && sel.kind === "none") {
			const candidate = splitPdfImageReadPath(archiveSubPath);
			const pdfNode = candidate ? archive.getNode(candidate.pdfPath) : undefined;
			if (candidate && pdfNode && !pdfNode.isDirectory) {
				pdfImageRead = candidate;
				archiveSubPath = candidate.pdfPath;
				node = pdfNode;
			}
		}
		if (!node) {
			throw new ToolError(`Path '${readPath}' not found inside archive`);
		}

		assertSafeArchiveNode(node);
		if (node.isDirectory) {
			if (isMultiRange(sel)) {
				throw new ToolError("Multi-range line selectors are not supported for archive directory listings.");
			}
			return await readArchiveDirectory(
				archive,
				resolvedArchivePath.absolutePath,
				archiveSubPath,
				sel,
				details,
				signal,
			);
		}

		const entry = await archive.readFile(archiveSubPath);
		throwIfAborted(signal);
		if (entry.path.toLowerCase().endsWith(".pdf")) {
			const memberPath = `${resolvedArchivePath.absolutePath}:${entry.path}`;
			const pdfDetails: ReadToolDetails = { ...details, resolvedPath: memberPath, fileSize: entry.size };
			if (pdfImageRead) {
				// Only the selected, extraction-bounded member is materialized, under
				// an owned name rather than any untrusted archive path.
				await using scratch = await TempDir.create("@omp-read-archive-pdf-");
				const pdfPath = scratch.join("member.pdf");
				await Bun.write(pdfPath, entry.bytes);
				throwIfAborted(signal);
				const result = await readPdfPage({
					readPath,
					absolutePdfPath: pdfPath,
					page: pdfImageRead.page,
					pdfFileSize: entry.size,
					suffixResolution: resolvedArchivePath.suffixResolution,
					signal,
				});
				return toolResult<ReadToolDetails>({ ...result.details, ...pdfDetails })
					.content(result.content)
					.sourcePath(memberPath)
					.done();
			}
			const converted = await convertBufferWithMarkit(entry.bytes, ".pdf", signal);
			if (!converted.ok) {
				return toolResult<ReadToolDetails>(pdfDetails)
					.text(
						prependSuffixResolutionNotice(
							`[Cannot read .pdf file: ${converted.error || "conversion failed"}]`,
							resolvedArchivePath.suffixResolution,
						),
					)
					.sourcePath(memberPath)
					.done();
			}
			pdfDetails.contentType = cfgReadRenderMarkdown.get(session.settings) ? "text/markdown" : undefined;
			const result = await buildInMemorySelectorResult(session, converted.content, sel, {
				details: pdfDetails,
				sourcePath: memberPath,
				entityLabel: "document",
				immutable: true,
			});
			const firstText = result.content.find((content): content is TextContent => content.type === "text");
			if (firstText) {
				firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
			}
			return result;
		}
		const text = decodeUtf8Text(entry.bytes);
		if (text === null) {
			return toolResult<ReadToolDetails>(details)
				.text(
					prependSuffixResolutionNotice(
						`[Cannot read binary archive entry '${entry.path}' (${formatBytes(entry.size)})]`,
						resolvedArchivePath.suffixResolution,
					),
				)
				.sourcePath(resolvedArchivePath.absolutePath)
				.done();
		}

		// Archive members are immutable: there is no edit path for bytes inside
		// an archive, and a hashline tag keyed to the archive file would invite
		// (and fail) edits while clobbering sibling members' snapshots.
		const result = await buildInMemorySelectorResult(session, text, sel, {
			details,
			sourcePath: resolvedArchivePath.absolutePath,
			entityLabel: "archive entry",
			immutable: true,
		});
		const firstText = result.content.find((content): content is TextContent => content.type === "text");
		if (firstText) {
			firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
		}
		return result;
	} finally {
		await opened.close();
	}
}
