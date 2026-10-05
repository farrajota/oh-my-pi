/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
 *
 * An id with no `<id>.md` yet (a running agent, including one that has only
 * submitted non-terminal `yield` sections) resolves through the same agent
 * registry `write agent://<id>` messages: the read returns the agent's status
 * and its progress so far instead of `Not found`.
 *
 * URL forms:
 * - agent://<id> - Full output content
 * - agent://<id>/<child> - Nested subagent output (hierarchy separator; the
 *   registry allocates a subagent's own children as dot-qualified ids, so
 *   `agent://Parent/Child` resolves `Parent.Child.md`)
 * - agent://<id>/<path> - JSON extraction via path form (fallback when no
 *   nested output matches the path)
 * - agent://<id>?q=<query> - JSON extraction via query form
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { fuzzyFilter } from "@oh-my-pi/pi-tui/fuzzy";
import { formatDuration, isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { lookupAgentRef } from "../internal/agent-registry-bridge";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { ArtifactManager } from "../session/artifacts";
import { executeSend, isIrcEnabled } from "../irc/messaging";
import { applyQuery, pathToQuery } from "./json-query";
import agentPromptDoc from "../prompts/internal-urls/agent.md" with { type: "text" };
import agentProgressTemplate from "../prompts/tools/agent-url-progress.md" with { type: "text" };
import agentSupersededTemplate from "../prompts/tools/agent-url-superseded.md" with { type: "text" };
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import {
	agentRefsForContext,
	artifactsDirsForContext,
	artifactsDirsFromRegistry,
	isBoundResourceContext,
} from "./registry-helpers";
import type {
	InternalResource,
	InternalWriteResult,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";

/** Upper bound on the ids a `Not found` error suggests. */
const MAX_ID_SUGGESTIONS = 5;

/** Result of scanning the caller's artifact dirs for `<id>.md`. */
interface OutputScan {
	foundPath?: string;
	matchedId?: string;
	jsonPath?: string;
	anyDirExists: boolean;
	availableIds: Set<string>;
}

/** True when the URL names a path extraction rather than a whole output. */
function isPathExtraction(url: InternalUrl): boolean {
	const pathname = url.rawPathname ?? url.pathname;
	return pathname !== "" && pathname !== "/";
}

/**
 * Ids a `Not found: <id>` error offers instead. Every `.md` in every
 * registered artifacts dir plus every registered agent is a candidate, which
 * in a long or resumed process is thousands of ids; only the closest few are
 * worth naming.
 */
function notFoundError(outputId: string, candidates: Iterable<string>): Error {
	const unique = [...new Set(candidates)].filter(id => id !== outputId);
	const suggestions = fuzzyFilter(unique, outputId, id => id).slice(0, MAX_ID_SUGGESTIONS);
	const hint = suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}` : "List agents with history://";
	return new Error(`Not found: ${outputId}\n${hint}`);
}

/** One accepted `yield` call recovered from an agent's transcript. */
interface YieldSection {
	labels?: string;
	data: string;
}

/** Accepted `yield` results in transcript order; error results and aborts are skipped. */
function yieldSections(messages: readonly AgentMessage[]): YieldSection[] {
	const sections: YieldSection[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "yield" || message.isError) continue;
		const details = message.details as { data?: unknown; status?: unknown; type?: unknown } | undefined;
		if (details?.status !== "success" || details.data === undefined) continue;
		const labels = Array.isArray(details.type) ? details.type.join(", ") : details.type;
		let data: string;
		try {
			data = JSON.stringify(details.data, null, 2) ?? "null";
		} catch {
			data = String(details.data);
		}
		sections.push({ labels: typeof labels === "string" && labels ? labels : undefined, data });
	}
	return sections;
}

/** Text of the newest assistant message that has any. */
function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const text = message.content
			.flatMap(block => (block.type === "text" ? [block.text] : []))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

/** Whether a caller-visible agent's published output predates its live turn. */
function isSuperseded(registry: AgentRegistry | undefined, outputId: string, context?: ResolveContext): boolean {
	if (!registry) return false;
	const ref = agentRefsForContext(registry, context).find(candidate => candidate.id === outputId);
	if (!ref || ref.kind === "advisor") return false;
	// isRunning authenticates public observations, not the scoped internal ref.
	const observation = registry.get(ref.id);
	return observation !== undefined && registry.isRunning(observation);
}

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		immutable: true,
		linkable: true,
		write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read" },
	};

	promptDoc(): string {
		return agentPromptDoc.trim();
	}

	/**
	 * The `<id>.md` output file. JSON-path URLs (`/<json-path>`) render a value
	 * rather than the file, so they locate to null, as do missing ids. So does an
	 * output superseded by a running turn: a located file is read directly by
	 * `read`, which would skip the previous-run banner {@link resolve} adds.
	 */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) throw new Error("agent:// URL requires an output ID: agent://<id>");
		if (outputId === "all" || isPathExtraction(url)) return null;
		const registry = context?.agentRegistry ?? AgentRegistry.global();
		if (isSuperseded(registry, outputId, context)) return null;
		const dirs = await this.#outputDirs(context);
		if (dirs.length === 0) return null;
		return (await this.#findOutput(dirs, [outputId])).foundPath ?? null;
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const session = context?.session;
		if (!session) throw new Error("agent:// messaging requires a tool session");
		const registry = session.agentRegistry;
		const senderId = session.getAgentId?.();
		if (
			!registry ||
			!senderId ||
			session.enableIrc === false ||
			!isIrcEnabled(session.settings, session.taskDepth ?? 0)
		) {
			throw new Error("Peer messaging is unavailable in this session.");
		}
		const to = url.rawHost || url.hostname;
		if (!to) throw new Error("agent:// URL requires a recipient: agent://<id>");
		if (isPathExtraction(url)) {
			throw new Error("agent:// message target cannot have a JSON-path suffix.");
		}
		if (!content.trim()) throw new Error("agent:// messages require non-empty content.");
		const result = await executeSend(
			{ registry, senderId, sessionFileHint: session.getSessionFile?.() },
			{ to, message: content },
		);
		return {
			content: [
				{
					type: "text",
					text: result.content.find(item => item.type === "text")?.text ?? "Message delivery failed.",
				},
			],
			details: { message: result.details },
			isError: result.isError,
		};
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (outputId === "all") throw new Error("agent://all is write-only; use it to broadcast a message.");
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const urlPath = url.rawPathname ?? url.pathname;
		const hasPathExtraction = isPathExtraction(url);
		const queryParam = url.searchParams.get("q");
		const hasQueryExtraction = queryParam !== null && queryParam !== "";
		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		const bound = isBoundResourceContext(context);
		const dirs = await this.#outputDirs(context);
		const registry = context?.agentRegistry ?? AgentRegistry.global();

		// A subagent allocates its own children as dot-qualified ids
		// (`Parent.Child`), so the slash path form is first tried as a hierarchy
		// separator: `agent://Parent/Child` resolves `Parent.Child.md`. Only when
		// no such nested output exists does the path fall back to jq-style JSON
		// extraction on `<outputId>.md`. Query form (`?q=`) is always extraction.
		const pathSegments = hasPathExtraction ? urlPath.split("/").filter(Boolean) : [];
		const decodedSegments = pathSegments.map(segment => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
		const nestedId =
			decodedSegments.length > 0 && decodedSegments.every(segment => !segment.includes("."))
				? [outputId, ...decodedSegments].join(".")
				: undefined;

		const scan = await this.#findOutput(dirs, nestedId ? [nestedId, outputId] : [outputId]);
		const extract = hasQueryExtraction || (hasPathExtraction && (!nestedId || scan.matchedId !== nestedId));
		if (!scan.foundPath) {
			const ref = registry && agentRefsForContext(registry, context).find(candidate => candidate.id === outputId);
			if (ref) return this.#resolveProgress(url, ref, registry, extract);
			if (!scan.anyDirExists) {
				if (bound) throw new Error("No caller-owned agent outputs available");
				throw new Error("No artifacts directory found");
			}
			throw notFoundError(outputId, [
				...scan.availableIds,
				...(registry ? agentRefsForContext(registry, context).map(candidate => candidate.id) : []),
			]);
		}
		const foundPath = scan.foundPath;
		const rawContent = await Bun.file(foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		// A published file belongs to a finished run. If the agent is streaming
		// again (follow-up or IRC wake), the file is the previous run's result;
		// unmarked, a reader takes it as the current state.
		if (!extract && isSuperseded(registry, outputId, context)) {
			const publishedAt = (await fs.stat(scan.foundPath)).mtimeMs;
			content = `${prompt.render(agentSupersededTemplate, {
				id: outputId,
				age: formatDuration(Math.max(0, Date.now() - publishedAt)),
			})}${rawContent}`;
			notes.push(`Superseded: ${outputId} is running a newer turn`);
		}
		let contentType: InternalResource["contentType"] = "text/markdown";
		let extractedFrom = foundPath;
		if (extract) {
			let jsonValue: unknown;
			let parsed = false;
			if (scan.jsonPath) {
				try {
					jsonValue = JSON.parse(await Bun.file(scan.jsonPath).text());
					extractedFrom = scan.jsonPath;
					parsed = true;
				} catch {
					// An unusable sidecar falls back to the manager-resolved output.
				}
			}
			if (!parsed) {
				try {
					jsonValue = JSON.parse(rawContent);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Output ${scan.matchedId} is not valid JSON: ${message}`);
				}
			}

			const query = hasQueryExtraction ? queryParam! : pathToQuery(urlPath);
			if (query) {
				const extracted = applyQuery(jsonValue, query);
				if (typeof extracted === "string") {
					// A string field (e.g. a scout's markdown `report`) reads as prose,
					// not as a JSON-escaped single line.
					content = extracted;
				} else {
					try {
						content = JSON.stringify(extracted, null, 2) ?? "null";
					} catch {
						content = String(extracted);
					}
					contentType = "application/json";
				}
				notes.push(`Extracted: ${query}`);
			} else {
				content = JSON.stringify(jsonValue, null, 2);
				contentType = "application/json";
			}
			if (parsed) notes.push(`Source: ${path.basename(extractedFrom)}`);
		}

		const sourcePath =
			context?.sessionFile && !path.isAbsolute(context.sessionFile)
				? path.relative(process.cwd(), extractedFrom)
				: extractedFrom;

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath,
			notes,
			shape: extract ? "value" : "document",
		};
	}

	/**
	 * Progress view of a registered agent that has not published `<id>.md`:
	 * its status, every accepted `yield` (non-terminal sections included), and
	 * its latest assistant text. Reads the live session's messages, else the
	 * retained session file. JSON-path extraction needs the published output.
	 */
	async #resolveProgress(
		url: InternalUrl,
		ref: AgentRef,
		registry: AgentRegistry,
		extraction: boolean,
	): Promise<InternalResource> {
		const currentRef = registry.get(ref.id) ?? ref;
		if (extraction) {
			throw new Error(
				`Output ${currentRef.id} is not published yet (status: ${currentRef.status}); read agent://${currentRef.id} for its progress.`,
			);
		}
		let messages: readonly AgentMessage[] = [];
		let source = "no transcript";
		const liveSession = lookupAgentRef(registry, ref.id)?.session;
		if (liveSession) {
			messages = liveSession.messages;
			source = "live session";
		} else if (currentRef.sessionFile) {
			messages = await loadSessionMessagesReadOnly(currentRef.sessionFile);
			source = "session file (read-only)";
		}
		const sections = yieldSections(messages);
		const lastText = lastAssistantText(messages);
		const content = `${prompt.render(agentProgressTemplate, {
			id: currentRef.id,
			status: currentRef.status,
			sections,
			lastText,
			empty: sections.length === 0 && !lastText,
		})}\n`;
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`No published output; progress from ${source} (${currentRef.status})`],
			shape: "document",
		};
	}

	/**
	 * Caller-owned artifact dirs win exclusively for bound callers; contextless
	 * and settings-only reads retain the process-global registry ordering.
	 * The caller root directory is preferred ahead of other registered roots.
	 */
	async #outputDirs(context: ResolveContext | undefined): Promise<string[]> {
		const bound = isBoundResourceContext(context);
		const rootSessionFile =
			context?.sessionFile && context.agentRegistry
				? await ensurePersistedRoster(context.agentRegistry, context.sessionFile)
				: undefined;
		const contextDirs = artifactsDirsForContext(context);
		if (bound) return contextDirs;
		const registryDirs = artifactsDirsFromRegistry(
			rootSessionFile ? { preferredDir: rootSessionFile.slice(0, -".jsonl".length) } : undefined,
		);
		return [...new Set([...contextDirs, ...registryDirs])];
	}

	/**
	 * Resolve candidate logical ids only through each directory's durable named
	 * artifact head. Candidate priority remains global: a nested id in a later
	 * directory wins over a base id in an earlier directory.
	 */
	async #findOutput(dirs: string[], candidateIds: string[]): Promise<OutputScan> {
		const { managers, anyDirExists, availableIds } = await this.#artifactManagers(dirs);
		for (const id of candidateIds) {
			for (const manager of managers) {
				const foundPath = await manager.getNamedPath("agent-output", id);
				if (!foundPath) continue;
				return {
					foundPath,
					matchedId: id,
					jsonPath: (await manager.getNamedPath("agent-sidecar", id)) ?? undefined,
					anyDirExists,
					availableIds,
				};
			}
		}
		return { anyDirExists, availableIds };
	}

	async #artifactManagers(dirs: string[]): Promise<{
		managers: ArtifactManager[];
		anyDirExists: boolean;
		availableIds: Set<string>;
	}> {
		const managers: ArtifactManager[] = [];
		const availableIds = new Set<string>();
		for (const dir of dirs) {
			let entries: string[];
			try {
				entries = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const entry of entries) {
				if (entry.endsWith(".md")) availableIds.add(entry.slice(0, -3));
			}
			managers.push(new ArtifactManager(dir));
		}
		return { managers, anyDirExists: managers.length > 0, availableIds };
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const registry = context?.agentRegistry ?? (isBoundResourceContext(context) ? undefined : AgentRegistry.global());
		const refs = registry ? agentRefsForContext(registry, context) : [];
		return refs
			.filter(ref => ref.kind === "sub")
			.map(ref => ref.id)
			.sort()
			.map(value => ({ value }));
	}
}
