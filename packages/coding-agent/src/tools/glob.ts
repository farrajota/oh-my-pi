import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import * as natives from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { formatGroupedPaths, hasFsCode, isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { lookup as lookupSetting } from "../config/registry";
import { InternalUrlRouter, type ResolveContext, sessionResolveContext } from "../internal-urls";
import { InternalUrlFilesystem, type UrlFileStat } from "../internal-urls/url-filesystem";
import { artifactsDirsForContext, isBoundResourceContext } from "../internal-urls/registry-helpers";
import globDescription from "../prompts/tools/glob.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { sessionDelegationBias } from "../task/prompt-policy";
import { isScoutSpawnable } from "../task/spawn-policy";
import {
	Ellipsis,
	fileHyperlink,
	renderFileList,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render";
import type { ToolSession } from ".";
import { resolveToolTier } from "./approval";
import { isFindEnabled } from "./jfind";
import { applyListLimit } from "@oh-my-pi/pi-tui/tools/list-limit";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntries,
	formatPathRelativeToCwd,
	normalizePathLikeInput,
	parseFindPattern,
	partitionExistingPaths,
	resolveExplicitFindPatterns,
	resolveToCwd,
	toPathList,
	resolveSearchBase,
	resolveSearchResultPath,
} from "./path-utils";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { PREVIEW_LIMITS } from "./preview-limits";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

import { cfgTaskDisabledAgents } from "../task/settings";

const findSchema = type({
	"path?": "string",
	"hidden?": "boolean",
	"gitignore?": "boolean",
	"limit?": "number",
});

export type GlobToolInput = typeof findSchema.infer;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const DEFAULT_GLOB_TIMEOUT_MS = 5000;

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	/** The scan hit the tool deadline, so matches are incomplete. */
	timedOut?: boolean;
	error?: string;
	/** Working directory at search time. Used by the renderer to resolve relative
	 * file paths to absolute paths for OSC 8 hyperlinks. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface GlobOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: GlobOperationsOptions) => Promise<string[]> | string[];
}

/** Search policy the tool resolved for this call, plus the cancellation signal. */
export interface GlobOperationsOptions {
	/** Globs the tool always excludes. */
	ignore: string[];
	/** Effective result cap for this call, already clamped to the tool maximum. */
	limit: number;
	/** Include dotfiles. Resolved from the caller's `hidden`, defaulting to true. */
	hidden: boolean;
	/** Honour gitignore files. Resolved from the caller's `gitignore`, defaulting to true. */
	gitignore: boolean;
	/** Aborts when the caller cancels or when the tool's scan deadline expires.
	 * Backends are expected to stop on it; the tool does not wait for one that
	 * does not, but it still stops reporting at the deadline. */
	signal?: AbortSignal;
}

/**
 * Model-facing text for a scan that hit the tool deadline. Shared by the native
 * and custom backends so both describe the same failure the same way.
 */
function globTimeoutNotice(partialCount: number, timeoutMs: number): string {
	const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
	// Walk cost tracks directory-tree size, not pattern specificity: a
	// mtime-ranked scan cannot early-exit, so a "narrow" pattern over a
	// huge tree still times out. Say so instead of implying the pattern
	// was too broad.
	return partialCount > 0
		? `glob timed out after ${seconds}s; returning ${partialCount} partial matches — results are incomplete, scope to a deeper directory instead of retrying blindly`
		: `Glob timed out after ${seconds}s before finding any matches — the scan is incomplete, NOT proof of absence. The walk is bounded by directory size, not pattern width; scope the search to a deeper directory (e.g. \`sub/dir/*.ext\` instead of \`*.ext\` at a huge root).`;
}

export interface GlobToolOptions {
	/** Custom operations for find. Default: local filesystem + rg */
	operations?: GlobOperations;
	/** Remap slash-only paths to the session cwd before root-search validation. */
	rootPathAlias?: boolean;
	/** Native glob binding. Override only in tests. */
	nativeGlob?: typeof natives.glob;
	/** Filesystem stat used before native scans. Override only in tests. */
	stat?: typeof fs.promises.stat;
	/** Native and user-facing scan timeout. Override only in tests. */
	timeoutMs?: number;
}

interface GlobTarget {
	searchPath: string;
	globPattern: string;
	hasGlob: boolean;
}

interface NativePreparedTarget {
	target: GlobTarget;
	result?: Array<{ path: string; mtime: number }>;
}

export class GlobTool implements AgentTool<typeof findSchema, GlobToolDetails> {
	readonly name = "glob";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "Glob";
	get description(): string {
		const hasFind = this.session.isToolActive?.("find") ?? isFindEnabled(this.session);
		const eagerDelegation = sessionDelegationBias(this.session) === "eager";
		const scoutAvailable = isScoutSpawnable(
			cfgTaskDisabledAgents.get(this.session.settings),
			this.session.getSessionSpawns?.() ?? "*",
		);
		// Every render input is a boolean; pack them so repeat reads skip the template render.
		const key = (hasFind ? 1 : 0) | (eagerDelegation ? 2 : 0) | (scoutAvailable ? 4 : 0);
		if (key !== this.#descriptionKey) {
			this.#description = prompt.render(globDescription, { hasFind, eagerDelegation, scoutAvailable });
			this.#descriptionKey = key;
		}
		return this.#description;
	}
	readonly parameters = findSchema;

	readonly strict = true;

	readonly #customOps?: GlobOperations;
	readonly #rootPathAlias: boolean;
	readonly #nativeGlob: typeof natives.glob;
	readonly #stat: typeof fs.promises.stat;
	readonly #timeoutMs: number;
	#descriptionKey = -1;
	#description = "";

	constructor(
		private readonly session: ToolSession,
		options?: GlobToolOptions,
	) {
		this.#customOps = options?.operations;
		this.#rootPathAlias = options?.rootPathAlias === true;
		this.#nativeGlob = options?.nativeGlob ?? natives.glob;
		this.#stat = options?.stat ?? fs.promises.stat;
		this.#timeoutMs = options?.timeoutMs ?? DEFAULT_GLOB_TIMEOUT_MS;
		if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
			throw new TypeError("Glob timeout must be a positive number");
		}
	}

	async execute(
		_toolCallId: string,
		params: typeof findSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GlobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GlobToolDetails>> {
		const { path: pathInput, limit, hidden, gitignore } = params;

		throwIfAborted(signal);
		// Preparation still rejects immediately on caller abort. Once every
		// filesystem stat has settled, detach this proxy before launching native
		// scans so execute can drain each worker through the real caller signal.
		// Custom operations receive the combined signal via GlobOperationsOptions,
		// but keep immediate caller-abort coverage for their entire execution.
		const preparationController = !this.#customOps?.glob && signal ? new AbortController() : undefined;
		const abortPreparation = (): void => preparationController?.abort();
		if (preparationController && signal) {
			signal.addEventListener("abort", abortPreparation, { once: true });
		}
		const immediateAbortSignal = this.#customOps?.glob ? signal : preparationController?.signal;
		const execution = untilAborted(immediateAbortSignal, async () => {
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			const scopedPaths = toPathList(pathInput);
			const effectivePaths = scopedPaths.length > 0 ? scopedPaths : ["."];
			const rawPatternInputs = this.#customOps
				? effectivePaths
				: await expandDelimitedPathEntries(effectivePaths, this.session.cwd, { splitter: parseFindPattern });
			const rawPatterns = rawPatternInputs.map(input => normalizePathLikeInput(input).replace(/\\/g, "/"));
			const aliasResolvedPatterns = this.#rootPathAlias
				? rawPatterns.map(pattern => (/^\/+$/.test(pattern) ? "." : pattern))
				: rawPatterns;
			if (aliasResolvedPatterns.some(pattern => /^\/+$/.test(pattern))) {
				throw new ToolError("Searching from root directory '/' is not allowed");
			}
			const internalRouter = InternalUrlRouter.instance();
			// Internal URLs resolve inside the native walk, bounded by the tier this call was approved at.
			const memoryBackend = lookupSetting("memory.backend")?.get(this.session.settings);
			const resolveContext: ResolveContext = {
				...sessionResolveContext(this.session, { signal }),
				callerMemory: {
					backend: typeof memoryBackend === "string" ? memoryBackend : undefined,
					getMnemopiSessionState: this.session.getMnemopiSessionState,
				},
			};
			const urlFilesystem = new InternalUrlFilesystem({
				context: resolveContext,
				tier: resolveToolTier(this, params),
			});
			const routedPatterns = aliasResolvedPatterns.map(pattern => internalRouter.normalize(pattern));
			if (routedPatterns.some(pattern => pattern.length === 0)) {
				throw new ToolError("`path` must contain non-empty globs or paths");
			}
			// A path scope authorizes host paths only, so a scoped session pins each
			// internal URL root to its caller-bound backing path before preflight; an
			// unbacked URL fails with its handler's diagnosis instead of a path error.
			const normalizedPatterns = this.session.pathScope
				? await Promise.all(
						routedPatterns.map(async pattern => {
							if (!internalRouter.canHandle(pattern)) return pattern;
							const parsed = parseFindPattern(pattern);
							const hostBase = await internalRouter.requireLocal(parsed.basePath, "glob", resolveContext, {
								directory: true,
							});
							return parsed.hasGlob
								? path.join(hostBase.replace(/[*?[{]/g, "[$&]"), parsed.globPattern)
								: hostBase;
						}),
					)
				: routedPatterns;

			if (this.session.pathScope) {
				const operation = this.session.pathScope.currentOperation();
				await operation.preflight(
					normalizedPatterns.map(pattern => ({
						path: resolveToCwd(parseFindPattern(pattern).basePath, this.session.cwd),
						kind: "probe" as const,
					})),
				);
			}

			// Tolerate missing entries in a multi-path call: skip ones whose base
			// directory is gone, and only error if every entry is missing. Single
			// missing path keeps the original ENOENT semantics — the user explicitly
			// asked about that one path, so silent empty results would be misleading.
			let missingPaths: string[] = [];
			let effectivePatterns = normalizedPatterns;
			if (normalizedPatterns.length > 1 && !this.#customOps) {
				const partition = await partitionExistingPaths(
					normalizedPatterns,
					this.session.cwd,
					parseFindPattern,
					urlFilesystem,
				);
				if (partition.valid.length === 0) {
					throw new ToolError(`Path not found: ${partition.missing.join(", ")}`);
				}
				effectivePatterns = partition.valid;
				missingPaths = partition.missing;
			}

			const multiPattern = await resolveExplicitFindPatterns(effectivePatterns, this.session.cwd);
			const isSingle = !multiPattern;
			const targets: GlobTarget[] = multiPattern
				? multiPattern.targets.map(target => ({
						searchPath: target.basePath,
						globPattern: target.globPattern,
						hasGlob: target.hasGlob,
					}))
				: [
						(() => {
							const parsed = parseFindPattern(effectivePatterns[0] ?? ".");
							return {
								searchPath: resolveSearchBase(parsed.basePath, this.session.cwd),
								globPattern: parsed.globPattern,
								hasGlob: parsed.hasGlob,
							};
						})(),
					];
			const scopePath = multiPattern?.scopePath ?? formatScopePath(targets[0].searchPath);

			for (const target of targets) {
				if (target.searchPath === "/") {
					throw new ToolError("Searching from root directory '/' is not allowed");
				}
			}
			if (this.session.pathScope) {
				await this.session.pathScope
					.currentOperation()
					.preflight(targets.map(target => ({ path: target.searchPath, kind: "search" as const })));
			}

			const requestedLimit = limit ?? DEFAULT_LIMIT;
			if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
				throw new ToolError("Limit must be a positive number");
			}
			const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));
			// A request above the hard cap is silently reduced today; say so up
			// front so `limit=1000` no longer reads as "200 is all there is" (#13263).
			const clampNotice =
				requestedLimit > MAX_LIMIT
					? `Requested limit ${requestedLimit} clamped to the max of ${MAX_LIMIT}`
					: undefined;
			const includeHidden = hidden ?? true;
			const useGitignore = gitignore ?? true;
			const timeoutMs = this.#timeoutMs;
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const formatMatchPath = (matchPath: string, base: string, fileType?: natives.FileType): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				return formatPathRelativeToCwd(resolveSearchResultPath(base, matchPath), this.session.cwd, {
					trailingSlash: fileType === natives.FileType.Dir || hadTrailingSlash,
				});
			};
			const authorizeMatches = async (entries: string[]): Promise<string[]> => {
				if (!this.session.pathScope) return entries;
				const allowed: string[] = [];
				for (const entry of entries) {
					try {
						await this.session.pathScope.authorizePath("glob", path.resolve(this.session.cwd, entry), true);
						allowed.push(entry);
					} catch {
						// A recursive scan may discover entries outside the session scope;
						// prune the entry rather than leaking its name or metadata.
					}
				}
				return allowed;
			};

			const missingPathsNote =
				missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;

			const buildResult = (
				files: string[],
				opts?: { notice?: string; forceTruncated?: boolean; timedOut?: boolean },
			): AgentToolResult<GlobToolDetails> => {
				const notice = opts?.notice;
				const forceTruncated = opts?.forceTruncated ?? false;
				if (files.length === 0) {
					const details: GlobToolDetails = {
						scopePath,
						fileCount: 0,
						files: [],
						truncated: forceTruncated,
						timedOut: opts?.timedOut || undefined,
						cwd: this.session.cwd,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					// A timed-out empty result is an incomplete scan, not a verified
					// absence — never emit the definitive "No files found" claim next
					// to a timeout notice (the two statements contradict each other).
					const parts = opts?.timedOut ? [] : ["No files found matching pattern"];
					if (notice) parts.push(notice);
					if (missingPathsNote) parts.push(missingPathsNote);
					// Zero results is useless regardless of notices: the follow-up
					// call has already corrected course by the time compaction runs.
					return toolResult(details).text(parts.join("\n")).useless().done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const baseOutput = formatGroupedPaths(limited);
				const trailingNotes: string[] = [];
				if (notice) trailingNotes.push(notice);
				if (clampNotice) trailingNotes.push(clampNotice);
				if (missingPathsNote) trailingNotes.push(missingPathsNote);
				const rawOutput = trailingNotes.length > 0 ? `${baseOutput}\n\n${trailingNotes.join("\n")}` : baseOutput;
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				const details: GlobToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(forceTruncated || limitMeta.resultLimit || truncation.truncated),
					timedOut: opts?.timedOut || undefined,
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
					cwd: this.session.cwd,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};

				// Cap the doubled suggestion at MAX_LIMIT; once the reached count
				// is already the cap there is no larger usable limit, so suppress
				// the advice rather than recommend a value that clamps back (#13263).
				const reachedLimit = limitMeta.resultLimit;
				const cappedSuggestion =
					reachedLimit === undefined ? undefined : Math.min(reachedLimit.reached * 2, MAX_LIMIT);
				const resultLimitInput =
					reachedLimit === undefined
						? undefined
						: cappedSuggestion !== undefined && cappedSuggestion > reachedLimit.reached
							? { reached: reachedLimit.reached, suggestion: cappedSuggestion }
							: { reached: reachedLimit.reached, suggestion: null };
				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({ resultLimit: resultLimitInput });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			// Walk each user path as its own root and run the globs concurrently.
			// Collapsing multiple paths to a shared base would force the walker to
			// traverse and stat every unrelated sibling under that ancestor; per-path
			// roots keep each scan bounded to exactly what the user asked for.
			if (this.session.pathScope) {
				const operation = this.session.pathScope.currentOperation();
				const constrainedResults: string[] = [];
				for (const target of targets) {
					const rootTarget = await operation.authorize(target.searchPath, "search");
					const matcher = target.hasGlob ? new Bun.Glob(target.globPattern) : undefined;
					const walked = await operation.walkAuthorized(rootTarget, {
						signal: combinedSignal,
						include: entry => {
							if (!target.hasGlob) return entry.isFile && entry.path === rootTarget.canonicalTarget;
							const relative = path.relative(target.searchPath, entry.path).replace(/\\/g, "/");
							if (!relative || relative === ".") return false;
							if (!includeHidden && relative.split("/").some(segment => segment.startsWith("."))) return false;
							return Boolean(matcher?.match(relative) || matcher?.match(`${relative}/`));
						},
						descend: entry => {
							const relative = path.relative(target.searchPath, entry.path).replace(/\\/g, "/");
							if (!includeHidden && relative.split("/").some(segment => segment.startsWith("."))) return false;
							if (
								useGitignore &&
								relative.split("/").some(segment => segment === ".git" || segment === "node_modules")
							)
								return false;
							return true;
						},
					});
					for (const entry of walked) {
						if (!entry.isFile && !entry.isDirectory) continue;
						const relative = formatPathRelativeToCwd(entry.path, this.session.cwd, {
							trailingSlash: entry.isDirectory,
						});
						if (!constrainedResults.includes(relative)) constrainedResults.push(relative);
					}
				}
				return buildResult(constrainedResults);
			}

			if (this.#customOps?.glob) {
				const customOps = this.#customOps;
				let customTimedOut = false;
				// A custom backend is third-party code that may never settle and is
				// under no obligation to honour the signal, so never await one
				// outright: race every call against the tool deadline instead. The
				// detached operation keeps a settlement handler attached, so a late
				// rejection lands there instead of becoming an unhandled rejection
				// after we returned.
				//
				// An unanswered call resolves to `{ timedOut: true }` rather than to a
				// stand-in value. A stand-in is a lie the caller cannot see: reading
				// "the deadline fired" as "the path is absent" turned a slow `exists()`
				// into `Path not found: <root>`, telling the model a directory is gone
				// when the scan merely ran out of time. Absence and timeout are
				// different user-facing outcomes, so each call site decides.
				type CustomCall<T> = { timedOut: false; value: T } | { timedOut: true; value?: never };
				const runCustom = async <T>(operation: Promise<T>): Promise<CustomCall<T>> => {
					const settled = operation.then(
						value => ({ kind: "settled" as const, value }),
						(error: unknown) => ({ kind: "failed" as const, error }),
					);
					const ABORTED = Symbol("custom-glob-aborted");
					const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<typeof ABORTED>();
					const onAbort = (): void => resolveAborted(ABORTED);
					if (combinedSignal.aborted) resolveAborted(ABORTED);
					else combinedSignal.addEventListener("abort", onAbort, { once: true });
					try {
						const outcome = await Promise.race([settled, aborted]);
						if (outcome === ABORTED) {
							if (signal?.aborted) throw new ToolAbortError();
							customTimedOut = true;
							return { timedOut: true };
						}
						if (outcome.kind === "failed") throw outcome.error;
						return { timedOut: false, value: outcome.value };
					} finally {
						combinedSignal.removeEventListener("abort", onAbort);
					}
				};
				const perTarget = await Promise.all(
					targets.map(async target => {
						const exists = await runCustom(Promise.resolve(customOps.exists(target.searchPath)));
						if (exists.timedOut) return [] as string[];
						if (!exists.value) {
							if (isSingle) throw new ToolError(`Path not found: ${scopePath}`);
							return [] as string[];
						}
						if (!target.hasGlob && customOps.stat) {
							const stat = await runCustom(Promise.resolve(customOps.stat(target.searchPath)));
							if (stat.timedOut) return [] as string[];
							if (stat.value.isFile()) return authorizeMatches([formatScopePath(target.searchPath)]);
						}
						const results = await runCustom(
							Promise.resolve(
								customOps.glob(target.globPattern, target.searchPath, {
									ignore: ["**/node_modules/**", "**/.git/**"],
									limit: effectiveLimit,
									hidden: includeHidden,
									gitignore: useGitignore,
									signal: combinedSignal,
								}),
							),
						);
						if (results.timedOut) return [] as string[];
						return authorizeMatches(
							results.value.map(matchPath => formatMatchPath(matchPath, target.searchPath)),
						);
					}),
				);
				const seen = new Set<string>();
				const merged: string[] = [];
				for (const group of perTarget) {
					for (const entry of group) {
						if (seen.has(entry)) continue;
						seen.add(entry);
						merged.push(entry);
					}
				}
				if (customTimedOut) {
					// Roots that finished before the deadline still count: report them
					// as incomplete rather than throwing the partial work away.
					return buildResult(merged, {
						notice: globTimeoutNotice(merged.length, timeoutMs),
						forceTruncated: true,
						timedOut: true,
					});
				}
				return buildResult(merged);
			}

			const preparedTargets: NativePreparedTarget[] = await Promise.all(
				targets.map(async target => {
					throwIfAborted(signal);
					let stat: UrlFileStat;
					if (internalRouter.canHandle(target.searchPath)) {
						stat = await urlFilesystem.stat(target.searchPath).catch(async (err: unknown) => {
							const message = err instanceof Error ? err.message : String(err);
							const artifactPath = /^artifact:\/\/([^/]+)\/?$/i.exec(target.searchPath);
							const missingArtifactId = /^Artifact ([^ ]+) not found$/.exec(message)?.[1];
							if (artifactPath && missingArtifactId === artifactPath[1]) {
								await internalRouter.target(target.searchPath, resolveContext);
								let availableArtifactIds: string[] | undefined;
								if (isBoundResourceContext(resolveContext)) {
									try {
										const ids = new Set<string>();
										for (const dir of artifactsDirsForContext(resolveContext)) {
											let entries;
											try {
												entries = await fs.promises.readdir(dir, { withFileTypes: true });
											} catch (error) {
												if (isEnoent(error)) continue;
												throw error;
											}
											for (const entry of entries) {
												if (!entry.isFile()) continue;
												const match = /^(\d+)\.[^.]+\.log$/.exec(entry.name);
												if (match) ids.add(match[1]);
											}
										}
										availableArtifactIds = [...ids].sort();
									} catch {
										availableArtifactIds = undefined;
									}
								}
								if (availableArtifactIds) {
									const available =
										availableArtifactIds.length > 0 ? `. Available: ${availableArtifactIds.join(", ")}` : "";
									throw new ToolError(`Artifact ${artifactPath[1]} not found${available}`);
								}
							}
							throw new ToolError(`Cannot glob ${target.searchPath}: ${message}`);
						});
					} else {
						try {
							const hostStat = await this.#stat(target.searchPath);
							stat = {
								type: hostStat.isDirectory() ? "directory" : hostStat.isFile() ? "file" : "other",
								size: hostStat.size,
								mtimeMs: hostStat.mtimeMs,
							};
						} catch (err) {
							// ENAMETOOLONG can never name a real target; surface a clean
							// "Path not found" instead of leaking the raw errno (issue #7597).
							if (isEnoent(err) || hasFsCode(err, "ENAMETOOLONG")) {
								if (isSingle) throw new ToolError(`Path not found: ${scopePath}`);
								return { target, result: [] };
							}
							throw err;
						}
					}
					if (!target.hasGlob && stat.type === "file") {
						return {
							target,
							result: [{ path: formatScopePath(target.searchPath), mtime: stat.mtimeMs }],
						};
					}
					if (stat.type !== "directory") {
						if (isSingle) throw new ToolError(`Path is not a directory: ${target.searchPath}`);
						return { target, result: [] };
					}
					return { target };
				}),
			);
			const nativeScanPending = preparedTargets.some(prepared => prepared.result === undefined);
			if (nativeScanPending && preparationController && signal) {
				signal.removeEventListener("abort", abortPreparation);
			}
			throwIfAborted(signal);

			const onUpdateMatches: string[] = [];
			const onUpdateMtimes: number[] = [];
			const updateIntervalMs = 200;
			let lastUpdate = 0;
			const emitUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdate < updateIntervalMs) return;
				lastUpdate = now;
				const details: GlobToolDetails = {
					scopePath,
					fileCount: onUpdateMatches.length,
					files: onUpdateMatches.slice(),
					truncated: false,
				};
				onUpdate({
					content: [{ type: "text", text: onUpdateMatches.join("\n") }],
					details,
				});
			};
			const streamed = new Set<string>();
			const makeOnMatch =
				(formatTargetMatch: (match: natives.GlobMatch) => string) =>
				(err: Error | null, match: natives.GlobMatch | null): void => {
					if (err || combinedSignal.aborted || !match?.path) return;
					const relativePath = formatTargetMatch(match);
					if (streamed.has(relativePath)) return;
					streamed.add(relativePath);
					onUpdateMatches.push(relativePath);
					if (this.session.pathScope) return;
					emitUpdate();
				};

			let timedOut = false;
			const runTarget = async (prepared: NativePreparedTarget): Promise<Array<{ path: string; mtime: number }>> => {
				if (prepared.result) return prepared.result;
				const { target } = prepared;
				const out: Array<{ path: string; mtime: number }> = [];
				// Native streams exactly the matches it returns; the streamed update and
				// the final list share one formatting pass per raw path (a path's file
				// type is fixed within one walk).
				const formattedPaths = new Map<string, string>();
				const formatTargetMatch = (match: natives.GlobMatch): string => {
					let formatted = formattedPaths.get(match.path);
					if (formatted === undefined) {
						formatted = formatMatchPath(match.path, target.searchPath, match.fileType);
						formattedPaths.set(match.path, formatted);
					}
					return formatted;
				};
				try {
					const result = await this.#nativeGlob(
						{
							pattern: target.globPattern,
							path: target.searchPath,
							hidden: includeHidden,
							maxResults: effectiveLimit,
							sortByMtime: true,
							gitignore: useGitignore,
							// parseFindPattern explicitly prepends "**/" when the user's
							// pattern begins with a glob (so `*.ts` becomes `**/*.ts`).
							// Anything that arrives here without "**/" was scoped to a
							// single directory by the user (e.g. `dir/*`); disable the
							// native auto-recursion so `dir/*` does not silently match
							// `dir/sub/nested.ts`.
							recursive: false,
							signal: combinedSignal,
							timeoutMs,
							filesystem: urlFilesystem.shellFilesystem(),
						},
						makeOnMatch(formatTargetMatch),
					);
					throwIfAborted(signal);
					for (const match of result.matches) {
						if (!match.path) continue;
						const formatted = formatTargetMatch(match);
						if (this.session.pathScope) {
							try {
								await this.session.pathScope.authorizePath(
									"glob",
									path.resolve(this.session.cwd, formatted),
									true,
								);
							} catch {
								continue;
							}
						}
						out.push({ path: formatted, mtime: match.mtime ?? 0 });
					}
					return out;
				} catch (error) {
					const nativeAbort =
						error instanceof Error &&
						(error.name === "AbortError" || error.name === "TimeoutError" || error.message.includes("Aborted:"));
					if (nativeAbort) {
						if (
							!signal?.aborted &&
							(timeoutSignal.aborted || (error instanceof Error && error.message.includes("Aborted: Timeout")))
						) {
							timedOut = true;
							return [];
						}
						throw new ToolAbortError();
					}
					throw error;
				}
			};

			const settledTargets = await Promise.allSettled(preparedTargets.map(runTarget));
			const perTarget = settledTargets.map(result => {
				if (result.status === "rejected") throw result.reason;
				return result.value;
			});

			if (timedOut) {
				// Drain the partial matches accumulated during streaming and return them
				// instead of throwing — empty results after a multi-second wait force the
				// caller to retry blind, which is the worst possible outcome.
				const partial = onUpdateMatches.map((entry, index) => ({ p: entry, m: onUpdateMtimes[index] ?? 0 }));
				partial.sort((a, b) => b.m - a.m);
				const sortedPaths = partial.map(entry => entry.p);
				return buildResult(sortedPaths, {
					notice: globTimeoutNotice(sortedPaths.length, timeoutMs),
					forceTruncated: true,
					timedOut: true,
				});
			}

			// Merge per-target results: native glob already ranks each target's own
			// matches by mtime and caps them at the limit, so a global mtime re-sort
			// plus dedup yields the correct top-N across all roots.
			const seen = new Set<string>();
			const merged: Array<{ path: string; mtime: number }> = [];
			for (const group of perTarget) {
				for (const entry of group) {
					if (seen.has(entry.path)) continue;
					seen.add(entry.path);
					merged.push(entry);
				}
			}
			merged.sort((a, b) => b.mtime - a.mtime);
			return buildResult(merged.map(entry => entry.path));
		});
		return execution.finally(() => {
			signal?.removeEventListener("abort", abortPreparation);
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GlobRenderArgs {
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	limit?: number;
}

function formatGlobRenderPaths(args: GlobRenderArgs | undefined): string | undefined {
	const list = toPathList(args?.path ?? args?.paths);
	return list.length > 0 ? list.join(", ") : undefined;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function globStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const globToolRenderer = {
	inline: true,
	renderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args) || "*",
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GlobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GlobRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 1, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					iconOverride: globStatusIcon(uiTheme),
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `skipped missing: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk —
			// render "incomplete", not a definitive "No files found".
			const emptyLabel = truncated ? "No matches before timeout (scan incomplete)" : "No files found";
			const header = renderStatusLine(
				{
					icon: "warning",
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: truncated ? ["0 files", uiTheme.fg("warning", "timed out")] : ["0 files"],
				},
				uiTheme,
			);
			const lines = [header, formatEmptyMessage(emptyLabel, uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: globStatusIcon(uiTheme) }),
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args),
				meta,
			},
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const cwd = details?.cwd;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({
							path: entry,
							isDirectory: entry.endsWith("/"),
							absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						hyperlinkFn: fileHyperlink,
					},
					uiTheme,
				);
				return [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
};
