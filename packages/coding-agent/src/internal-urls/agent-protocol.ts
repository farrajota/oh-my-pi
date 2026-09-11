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
import { ArtifactManager } from "../session/artifacts";
import { applyQuery, pathToQuery } from "./json-query";
import { agentRefsForContext, artifactsDirsForContext, isBoundResourceContext } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const urlPath = url.pathname;
		const queryParam = url.searchParams.get("q");
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";
		const hasQueryExtraction = queryParam !== null && queryParam !== "";

		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		const bound = isBoundResourceContext(context);
		const dirs = artifactsDirsForContext(context);
		if (bound && dirs.length === 0) throw new Error("No caller-owned agent outputs available");
		if (dirs.length === 0) throw new Error("No session - agent outputs unavailable");

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
		if (!scan.foundPath) {
			const target = nestedId ?? outputId;
			throw new Error(`Not found: ${target}`);
		}

		const rawContent = await Bun.file(scan.foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";
		const extract = hasQueryExtraction || (hasPathExtraction && scan.matchedId !== nestedId);
		let extractedFrom = scan.foundPath;
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
			if (parsed) notes.push(`Source: ${path.basename(extractedFrom!)}`);
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
		};
	}

	/**
	 * Resolve candidate logical ids only through each directory's durable named
	 * artifact head. Candidate priority remains global: a nested id in a later
	 * directory wins over a base id in an earlier directory.
	 */
	async #findOutput(
		dirs: string[],
		candidateIds: string[],
	): Promise<{
		foundPath?: string;
		matchedId?: string;
		jsonPath?: string;
		anyDirExists: boolean;
	}> {
		const { managers, anyDirExists } = await this.#artifactManagers(dirs);
		for (const id of candidateIds) {
			for (const manager of managers) {
				const foundPath = await manager.getNamedPath("agent-output", id);
				if (!foundPath) continue;
				return {
					foundPath,
					matchedId: id,
					jsonPath: (await manager.getNamedPath("agent-sidecar", id)) ?? undefined,
					anyDirExists,
				};
			}
		}
		return { anyDirExists };
	}

	async #artifactManagers(dirs: string[]): Promise<{
		managers: ArtifactManager[];
		anyDirExists: boolean;
	}> {
		const managers: ArtifactManager[] = [];
		for (const dir of dirs) {
			try {
				const handle = await fs.opendir(dir);
				await handle.close();
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			managers.push(new ArtifactManager(dir));
		}
		return { managers, anyDirExists: managers.length > 0 };
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
