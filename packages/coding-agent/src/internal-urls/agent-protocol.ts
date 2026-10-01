/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
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
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { ArtifactManager } from "../session/artifacts";
import { executeSend, isIrcEnabled } from "../irc/messaging";
import { applyQuery, pathToQuery } from "./json-query";
import agentPromptDoc from "../prompts/internal-urls/agent.md" with { type: "text" };
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

/** Result of resolving candidates in the caller's artifact dirs. */
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
	 * rather than the file, so they locate to null, as do missing ids.
	 */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) throw new Error("agent:// URL requires an output ID: agent://<id>");
		if (outputId === "all" || isPathExtraction(url)) return null;
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
		if (dirs.length === 0) {
			if (bound) throw new Error("No caller-owned agent outputs available");
			throw new Error("No session - agent outputs unavailable");
		}

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
		if (!scan.anyDirExists) {
			throw new Error("No artifacts directory found");
		}
		const foundPath = scan.foundPath;
		if (!foundPath) {
			const target = nestedId ?? outputId;
			const available = scan.availableIds.size > 0 ? [...scan.availableIds].sort().join(", ") : "none";
			throw new Error(`Not found: ${target}\nAvailable: ${available}`);
		}

		const rawContent = await Bun.file(foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";
		const extract = hasQueryExtraction || (hasPathExtraction && scan.matchedId !== nestedId);
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
	 * Caller-owned artifact dirs win exclusively for bound callers; contextless
	 * and settings-only reads retain the process-global registry ordering.
	 */
	async #outputDirs(context: ResolveContext | undefined): Promise<string[]> {
		const registry = context?.agentRegistry ?? AgentRegistry.global();
		const rootSessionFile = context?.sessionFile
			? await ensurePersistedRoster(registry, context.sessionFile)
			: undefined;
		const contextDirs = artifactsDirsForContext(context);
		if (isBoundResourceContext(context)) return contextDirs;
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
