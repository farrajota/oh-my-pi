/**
 * Structured metadata for tool outputs.
 *
 * Tools populate details.meta using the fluent OutputMetaBuilder.
 * The tool wrapper automatically formats and appends notices at message boundary.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolExecFn,
	AgentToolPreparedExecution,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { getDefault, type Settings } from "../config/settings";
import {
	type OutputArtifactError,
	type OutputSummary,
	type TruncationResult,
	truncateMiddle,
	truncateTail,
} from "@oh-my-pi/pi-tui/tools/streaming-output";
import { formatOutputNotice, type OutputMeta, type TruncationMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { runArtifactOperation } from "../registry/operation-lease";
import { renderError } from "./tool-errors";
export {
	formatArtifactErrorNotice,
	formatFullOutputReference,
	formatGroupedDiagnosticMessages,
	formatStyledArtifactReference,
	formatStyledTruncationWarning,
	formatTruncationMetaNotice,
	stripGeneratedOutputNotice,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
} from "@oh-my-pi/pi-tui/tools/output-meta";
export { formatOutputNotice };
export type { OutputMeta, TruncationMeta };

/** Input for {@link OutputMetaBuilder.limits}. `columnUnit` defaults to `chars`. */
export interface LimitsInput {
	matchLimit?: number;
	resultLimit?: number;
	headLimit?: number;
	columnMax?: number;
	columnUnit?: "bytes" | "chars";
	artifactId?: string;
}
// =============================================================================
// OutputMetaBuilder - Fluent API for building OutputMeta
// =============================================================================

/** Metadata supplied when recording a truncated tool result. */
export interface TruncationMetaInput {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
	artifactId?: string;
	/** Byte budget that stopped the read, when truncation is byte-limited. */
	maxBytes?: number;
	/** Override the derived continuation line; `null` suppresses an unsafe continuation hint. */
	nextOffset?: number | null;
}

export interface TruncationSummaryOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
}

export interface TruncationTextOptions {
	direction: "head" | "tail" | "middle";
	totalLines?: number;
	totalBytes?: number;
	maxBytes?: number;
}

/**
 * Fluent builder for OutputMeta.
 *
 * @example
 * ```ts
 * details.meta = outputMeta()
 *   .truncation(truncation, { direction: "head" })
 *   .matchLimit(limitReached ? effectiveLimit : 0)
 *   .columnTruncated(linesTruncated ? DEFAULT_MAX_COLUMN : 0)
 *   .get();
 * ```
 */
export class OutputMetaBuilder {
	#meta: OutputMeta = {};

	/** Add truncation info from TruncationResult. No-op if not truncated. */
	truncation(result: TruncationResult, options: TruncationMetaInput): this {
		if (!result.truncated) return this;

		const { direction, startLine = 1, totalFileLines, artifactId, maxBytes } = options;
		const outputLines = result.outputLines ?? result.totalLines;
		const outputBytes = result.outputBytes ?? result.totalBytes;
		const isMiddle = direction === "middle" || result.truncatedBy === "middle";
		const truncatedBy: "lines" | "bytes" | "middle" = isMiddle
			? "middle"
			: result.truncatedBy === "lines"
				? "lines"
				: "bytes";

		const effectiveTotalLines = totalFileLines ?? result.totalLines;

		if (result.firstLineExceedsLimit) {
			// The window collected no complete line; the body is a byte-capped
			// preview of one oversized line. Describe that partial line instead of
			// deriving an empty range that renders "Showing 0 of N lines".
			this.#meta.truncation = {
				direction,
				truncatedBy: "bytes",
				totalLines: effectiveTotalLines,
				totalBytes: result.totalBytes,
				outputLines,
				outputBytes,
				shownRange: { start: startLine, end: startLine },
				partialLine: true,
				artifactId,
			};
			return this;
		}

		if (isMiddle) {
			const elidedLines = result.elidedLines ?? Math.max(0, effectiveTotalLines - outputLines);
			const elidedBytes = result.elidedBytes ?? Math.max(0, result.totalBytes - outputBytes);
			// Reconstruct head/tail line ranges. The kept output spans the first
			// `headLines` lines and the last `tailLines` lines of the source; lines
			// in the middle (count == elidedLines) are dropped.
			const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
			const headLines = result.headLines ?? Math.ceil(keptLines / 2);
			const tailLines = result.tailLines ?? keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				totalLines: effectiveTotalLines,
				totalBytes: result.totalBytes,
				outputLines,
				outputBytes,
				...(effectiveTotalLines > 1 && !result.partialByteWindows
					? {
							headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
							tailRange:
								tailLines > 0
									? { start: effectiveTotalLines - tailLines + 1, end: effectiveTotalLines }
									: undefined,
						}
					: {}),
				elidedLines,
				elidedBytes,
				artifactId,
			};
			return this;
		}

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = result.totalLines - outputLines + 1;
			shownEnd = result.totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines: effectiveTotalLines,
			totalBytes: result.totalBytes,
			outputLines,
			outputBytes,
			maxBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset:
				direction === "head"
					? options.nextOffset === null
						? undefined
						: (options.nextOffset ?? shownEnd + 1)
					: undefined,
		};

		return this;
	}
	/** Add truncation, column limits, and capture failures from OutputSummary. */
	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		const artifactId = summary.artifactError ? undefined : summary.artifactId;
		if (summary.columnMax != null && summary.columnMax > 0 && (summary.columnTruncatedLines ?? 0) > 0) {
			this.columnTruncated(summary.columnMax, "bytes", artifactId);
		}
		if (summary.artifactError) {
			this.artifactError(summary.artifactError);
		}
		if (!summary.truncated) return this;

		const { direction, startLine = 1, totalFileLines } = options;
		const totalLines = totalFileLines ?? summary.totalLines;

		// Middle elision: the sink retained head + tail with an elision marker.
		if (summary.elidedBytes != null && summary.elidedBytes > 0) {
			const elidedLines = summary.elidedLines ?? Math.max(0, totalLines - summary.outputLines);
			const keptLines = Math.max(0, summary.outputLines - 1); // -1 for marker line
			const headLines = Math.ceil(keptLines / 2);
			const tailLines = keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
				tailRange: tailLines > 0 ? { start: totalLines - tailLines + 1, end: totalLines } : undefined,
				elidedBytes: summary.elidedBytes,
				elidedLines,
				artifactId,
			};
			return this;
		}

		const truncatedBy: "lines" | "bytes" =
			summary.outputBytes < summary.totalBytes
				? "bytes"
				: summary.outputLines < summary.totalLines
					? "lines"
					: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = totalLines - summary.outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + summary.outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from truncated output text. No-op if truncation not detected. */
	truncationFromText(text: string, options: TruncationTextOptions): this {
		const outputLines = text.length > 0 ? text.split("\n").length : 0;
		const outputBytes = Buffer.byteLength(text, "utf-8");
		const totalLines = options.totalLines ?? outputLines;
		const totalBytes = options.totalBytes ?? outputBytes;

		const truncated = totalLines > outputLines || totalBytes > outputBytes || false;
		if (!truncated) return this;

		const truncatedBy: "lines" | "bytes" =
			options.maxBytes && outputBytes >= options.maxBytes
				? "bytes"
				: totalBytes > outputBytes
					? "bytes"
					: totalLines > outputLines
						? "lines"
						: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (options.direction === "tail") {
			shownStart = totalLines - outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = 1;
			shownEnd = outputLines;
		}

		this.#meta.truncation = {
			direction: options.direction,
			truncatedBy,
			totalLines,
			totalBytes,
			outputLines,
			outputBytes,
			maxBytes: options.maxBytes,
			shownRange: { start: shownStart, end: shownEnd },
			nextOffset: options.direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add match limit notice. No-op if reached <= 0. */
	matchLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, matchLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notices in one call. */
	limits(limits: LimitsInput): this {
		if (limits.matchLimit !== undefined) {
			this.matchLimit(limits.matchLimit);
		}
		if (limits.resultLimit !== undefined) {
			this.resultLimit(limits.resultLimit);
		}
		if (limits.headLimit !== undefined) {
			this.headLimit(limits.headLimit);
		}
		if (limits.columnMax !== undefined) {
			this.columnTruncated(limits.columnMax, limits.columnUnit, limits.artifactId);
		}
		return this;
	}

	/** Add result limit notice. No-op if reached <= 0. */
	resultLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, resultLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notice for head truncation. No-op if reached <= 0. */
	headLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, headLimit: { reached, suggestion } };
		return this;
	}

	/** Add column truncation notice. No-op if maxColumn <= 0. */
	columnTruncated(maxColumn: number, unit?: "bytes" | "chars", artifactId?: string): this {
		if (maxColumn <= 0) return this;
		this.#meta.limits = {
			...this.#meta.limits,
			columnTruncated: { maxColumn, ...(unit ? { unit } : {}), ...(artifactId ? { artifactId } : {}) },
		};
		return this;
	}

	artifactError(error: OutputArtifactError): this {
		this.#meta.artifactError = error;
		return this;
	}

	/** Add source path info. */
	sourcePath(value: string): this {
		this.#meta.source = { type: "path", value };
		return this;
	}

	/** Add source URL info. */
	sourceUrl(value: string): this {
		this.#meta.source = { type: "url", value };
		return this;
	}

	/** Add internal URL source info (skill://, agent://, artifact://). */
	sourceInternal(value: string): this {
		this.#meta.source = { type: "internal", value };
		return this;
	}

	/** Add LSP diagnostics. No-op if no messages. */
	diagnostics(summary: string, messages: string[]): this {
		if (messages.length === 0) return this;
		this.#meta.diagnostics = { summary, messages };
		return this;
	}

	/** Get the built OutputMeta, or undefined if empty. */
	get(): OutputMeta | undefined {
		return Object.keys(this.#meta).length > 0 ? this.#meta : undefined;
	}
}

/** Create a new OutputMetaBuilder. */
export function outputMeta(): OutputMetaBuilder {
	return new OutputMetaBuilder();
}
// =============================================================================
// Tool wrapper
// =============================================================================

/**
 * Append output notice to tool result content if meta is present.
 */
function appendOutputNotice(
	content: (TextContent | ImageContent)[],
	meta: OutputMeta | undefined,
): (TextContent | ImageContent)[] {
	const notice = formatOutputNotice(meta);
	if (!notice) return content;

	const result = [...content];
	for (let i = result.length - 1; i >= 0; i--) {
		const item = result[i];
		if (item.type === "text") {
			result[i] = { ...item, text: item.text + notice };
			return result;
		}
	}

	result.push({ type: "text", text: notice.trim() });
	return result;
}

const kUnwrappedExecute = Symbol("OutputMeta.UnwrappedExecute");

// =============================================================================
// Centralized artifact spill for large tool results
// =============================================================================

/** Resolved artifact spill config sourced from the session settings (or schema defaults). */
function getSpillConfig(s: Settings | undefined) {
	type Path =
		| "tools.artifactSpillThreshold"
		| "tools.artifactTailBytes"
		| "tools.artifactTailLines"
		| "tools.artifactHeadBytes";
	const get = <P extends Path>(path: P) => s?.get(path) ?? getDefault(path);
	return {
		threshold: get("tools.artifactSpillThreshold") * 1024,
		tailBytes: get("tools.artifactTailBytes") * 1024,
		tailLines: get("tools.artifactTailLines"),
		headBytes: get("tools.artifactHeadBytes") * 1024,
	};
}

/**
 * Resolve the OutputSink `headBytes` budget from session settings.
 * Exposed so streaming executors (bash/python/ssh/eval) can opt into
 * middle elision with the same per-user configuration.
 */
export function resolveOutputSinkHeadBytes(s: Settings | undefined): number {
	return getSpillConfig(s).headBytes;
}

/**
 * Slack on top of the configured spill threshold before the final-defense
 * inline byte cap fires. The OutputSink already bounds inline bodies to the
 * threshold; only notice slop (wall time, exit code, elision marker,
 * `[raw output: artifact://N]` footer) rides above it. The slack keeps the
 * cap a genuine last resort for paths that bypass the sink (e.g. ACP
 * client-bridge terminals) instead of re-truncating — and re-saving — every
 * sink-elided result (the double-artifact `Artifact: N+1` vs `artifact://N`
 * mismatch).
 */
const INLINE_CAP_SLACK_BYTES = 2 * 1024;

/**
 * Resolve the `enforceInlineByteCap` budget for streaming tools (bash/ssh)
 * from session settings: the user's spill threshold plus notice slack.
 */
export function resolveInlineByteCapBudget(s: Settings | undefined): number {
	return getSpillConfig(s).threshold + INLINE_CAP_SLACK_BYTES;
}

/**
 * Resolve the per-line column cap from session settings. Shared by streaming
 * executors (bash/python/ssh/eval via OutputSink) and the `read` tool's
 * line-buffer post-processing, so one setting controls both surfaces.
 */
export function resolveOutputMaxColumns(s: Settings | undefined): number {
	return s?.get("tools.outputMaxColumns") ?? getDefault("tools.outputMaxColumns");
}

/**
 * If the tool result text exceeds the spill threshold, save the full output
 * as a session artifact and replace the content with a head+tail (middle
 * elision) view plus an artifact reference. When `tools.artifactHeadBytes`
 * is 0, falls back to tail-only truncation. Skips when the tool already
 * saved its own artifact (e.g. bash/python via OutputSink).
 */
async function spillLargeResultToArtifact(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
	operationId: string,
): Promise<AgentToolResult> {
	const sessionManager = context?.sessionManager;
	if (!sessionManager) return result;
	const { threshold, tailBytes, tailLines, headBytes } = getSpillConfig(context?.settings);

	// Skip if tool already saved an artifact
	const existingMeta: OutputMeta | undefined = result.details?.meta;
	const reportOnly =
		toolName === "hub" &&
		Array.isArray(result.details?.jobs) &&
		(existingMeta?.artifactError !== undefined ||
			result.details.jobs.some(
				(job: unknown) =>
					isRecord(job) &&
					(job.artifactError !== undefined || (isRecord(job.meta) && job.meta.artifactError !== undefined)),
			));
	if (existingMeta?.truncation?.artifactId) return result;

	// Reading an artifact already addresses recoverable full output. Spilling that
	// read would only create a redundant artifact containing another artifact's
	// page (and can repeat indefinitely on subsequent reads).
	if (
		toolName === "read" &&
		existingMeta?.source?.type === "internal" &&
		existingMeta.source.value.startsWith("artifact://")
	) {
		return result;
	}

	// Measure total text content
	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		}
	}
	if (textParts.length === 0) return result;

	const fullText = textParts.length === 1 ? textParts[0] : textParts.join("\n");
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= threshold) return result;

	// In a persistent session this hits `Bun.write`, which can throw (disk full,
	// permissions). The spill wraps arbitrary tools (built-in, MCP, extension,
	// RPC-host); a save failure must never convert a successful call into an
	// error, nor re-expose the full (possibly context-blowing) output. Mirror
	// `enforceInlineByteCap`: always truncate past the threshold, and only
	// attach the `artifact://` recovery link when the save actually succeeded.
	let artifactId: string | undefined;
	if (!existingMeta?.artifactError || reportOnly) {
		try {
			artifactId = await runArtifactOperation(
				context?.sessionManager,
				`artifact:${operationId}`,
				() => sessionManager.saveArtifact(fullText, toolName),
				context?.toolCall?.steeringSignal,
			);
		} catch (error) {
			logger.warn("Failed to spill large tool result to artifact", {
				tool: toolName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Truncate: middle elision when a head budget is configured, otherwise tail-only.
	const useMiddle = headBytes > 0;
	const truncated = useMiddle
		? truncateMiddle(fullText, {
				maxBytes: headBytes + tailBytes,
				maxLines: tailLines * 2,
				maxHeadBytes: headBytes,
				maxHeadLines: tailLines,
			})
		: truncateTail(fullText, {
				maxBytes: tailBytes,
				maxLines: tailLines,
			});

	// Replace text blocks with single truncated block, keep images
	const newContent: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		if (block.type !== "text") {
			newContent.push(block);
		}
	}
	newContent.push({
		type: "text",
		text: truncated.content + (reportOnly && artifactId ? `\n\nRead artifact://${artifactId} for full report.` : ""),
	});

	// Build truncation meta
	const outputLines = truncated.outputLines ?? truncated.totalLines;
	const outputBytes = truncated.outputBytes ?? truncated.totalBytes;
	let truncationMeta: TruncationMeta;
	if (truncated.truncatedBy === "middle") {
		const elidedLines = truncated.elidedLines ?? Math.max(0, truncated.totalLines - outputLines);
		const elidedBytes = truncated.elidedBytes ?? Math.max(0, truncated.totalBytes - outputBytes);
		const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
		const headLines = truncated.headLines ?? Math.ceil(keptLines / 2);
		const tailLineCount = truncated.tailLines ?? keptLines - headLines;
		truncationMeta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: headBytes + tailBytes,
			...(truncated.totalLines > 1 && !truncated.partialByteWindows
				? {
						headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
						tailRange:
							tailLineCount > 0
								? { start: truncated.totalLines - tailLineCount + 1, end: truncated.totalLines }
								: undefined,
					}
				: {}),
			elidedLines,
			elidedBytes,
			artifactId: reportOnly ? undefined : artifactId,
			nextOffset: existingMeta?.truncation?.nextOffset,
		};
	} else {
		const shownStart = truncated.totalLines - outputLines + 1;
		truncationMeta = {
			direction: "tail",
			truncatedBy: truncated.truncatedBy ?? "bytes",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: tailBytes,
			shownRange: { start: shownStart, end: truncated.totalLines },
			artifactId: reportOnly ? undefined : artifactId,
			nextOffset: existingMeta?.truncation?.nextOffset,
		};
	}

	const newMeta: OutputMeta = { ...existingMeta, truncation: truncationMeta };
	const newDetails = { ...result.details, meta: newMeta };

	// Prune the raw payload only MCP results duplicate into `details.rawContent`.
	// Identify them by the required `serverName` + `mcpToolName` markers (the same
	// signature the MCP renderer uses) so a property-name collision on an
	// SDK/extension tool's intentionally unconstrained details can never trigger
	// this transformation. Everything already stored elsewhere is dropped so
	// `rawContent` cannot re-inflate the on-disk size: text blocks and
	// `resource.text` are captured verbatim by the artifact, and image data
	// survives on the result content (and eval's `images`). Resource URI/MIME/blob
	// metadata has no other home, so it is retained.
	if (
		typeof newDetails.serverName === "string" &&
		typeof newDetails.mcpToolName === "string" &&
		Array.isArray(newDetails.rawContent)
	) {
		const structuredContent: unknown[] = [];
		for (const block of newDetails.rawContent) {
			if (!isRecord(block)) {
				structuredContent.push(block);
				continue;
			}
			// Text and image payloads live in the artifact / result content.
			if (block.type === "text" || block.type === "image") continue;
			// Resource text is folded into the artifact; keep the rest of the resource.
			if (block.type === "resource" && isRecord(block.resource) && "text" in block.resource) {
				const resource = { ...block.resource };
				delete resource.text;
				structuredContent.push({ ...block, resource });
				continue;
			}
			structuredContent.push(block);
		}
		if (structuredContent.length > 0) {
			newDetails.rawContent = structuredContent;
		} else {
			delete newDetails.rawContent;
		}
	}

	return { ...result, content: newContent, details: newDetails };
}

// =============================================================================
// Tool wrapper
// =============================================================================

export async function postProcessToolResult(
	result: AgentToolResult,
	toolName: string,
	context?: AgentToolContext,
	operationId: string = toolName,
): Promise<AgentToolResult> {
	const processed = await spillLargeResultToArtifact(result, toolName, context, operationId);
	const meta: OutputMeta | undefined = processed.details?.meta;
	return meta ? { ...processed, content: appendOutputNotice(processed.content, meta) } : processed;
}

async function wrappedExecute(
	this: AgentTool & { [kUnwrappedExecute]: AgentToolExecFn },
	toolCallId: string,
	params: any,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
	context?: AgentToolContext,
	preparedExecution?: AgentToolPreparedExecution,
): Promise<AgentToolResult> {
	const originalExecute = this[kUnwrappedExecute];

	try {
		let result = await originalExecute.call(this, toolCallId, params, signal, onUpdate, context, preparedExecution);

		// Spill large results to artifact, truncate to tail
		result = await spillLargeResultToArtifact(result, this.name, context, toolCallId);

		// Append notices from meta
		const meta: OutputMeta | undefined = result.details?.meta;
		if (meta) {
			return {
				...result,
				content: appendOutputNotice(result.content, meta),
			};
		}
		return result;
	} catch (e) {
		// Re-throw with formatted message so agent-loop sets isError flag
		throw new Error(renderError(e));
	}
}

/**
 * Wrap a tool to:
 * 1. Automatically append output notices based on details.meta
 * 2. Handle ToolError rendering
 */
export function wrapToolWithMetaNotice<T extends AgentTool<any, any, any>>(tool: T): T {
	if (kUnwrappedExecute in tool) {
		return tool;
	}

	const originalExecute = tool.execute;

	return Object.defineProperties(tool, {
		[kUnwrappedExecute]: {
			value: originalExecute,
			enumerable: false,
			configurable: true,
		},
		execute: {
			value: wrappedExecute,
			enumerable: false,
			configurable: true,
			writable: true,
		},
	});
}
