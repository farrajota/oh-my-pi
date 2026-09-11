import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import {
	type ArchiveReader,
	type ArchiveFormat,
	type ArchiveNode,
	archiveFormatFromPath,
	formatArchiveEntryLines,
	openArchive,
	parseArchivePathCandidates,
} from "@oh-my-pi/pi-utils/ar";
import type { AuthorizedFilesystemTarget } from "../internal/session-path-scope";
import type { ToolSession } from "../sdk";
import { truncateHead } from "../session/streaming-output";
import { applyListLimit } from "./list-limit";
import { resolveReadPath } from "./path-utils";
import type { ReadToolDetails } from "./read";
import {
	buildInMemorySelectorResult,
	decodeUtf8Text,
	markMarkdownContentType,
	prependSuffixResolutionNotice,
} from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { isMultiRange, type ParsedSelector, parseSel, resolveTailSelector, selToOffsetLimit } from "./read-selector";
import { formatBytes } from "./render-utils";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
	authorizedTarget?: AuthorizedFilesystemTarget;
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
		directoryDetails.truncation = truncation;
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
	if (!session.pathScope || !resolved.authorizedTarget) {
		return { archive: await openArchive(resolved.absolutePath), close: async () => undefined };
	}
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
		let node = archive.getNode(archiveSubPath);
		if (!node && archiveSubPath) {
			const wholeSel = parseSel(archiveSubPath);
			if (wholeSel.kind !== "none") {
				node = archive.getNode("");
				archiveSubPath = "";
				sel = wholeSel;
			}
		}
		if (!node) throw new ToolError(`Path '${readPath}' not found inside archive`);

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

		const result = buildInMemorySelectorResult(session, text, sel, {
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
