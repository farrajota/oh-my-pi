/**
 * Protocol handler for history:// URLs.
 *
 * Exposes agent transcripts as concise markdown. Live refs render from the
 * in-memory message array; parked refs (session disposed, sessionFile
 * retained) load read-only from the JSONL session file — no writer, no lock.
 *
 * Agents that are no longer in the `AgentRegistry` — one-shot helpers
 * unregistered after `finalizeSubagentLifecycle` (`keepAlive: false`, e.g. the
 * `eval` `agent()` bridge), agents released via the Agent Hub / vibe kill, or
 * any agent after a session resume — remain reachable: `resolve`, `complete`,
 * and the index all fall back to scanning artifacts dirs for `<id>.jsonl`,
 * mirroring how `agent://` reads `.md` outputs straight off disk.
 *
 * URL forms:
- history:// - Index of visible registry + on-disk agents (id, status, kind, last activity)
- history://<agentId> - Concise markdown transcript of that agent within the caller root
 */
import { lookupAgentRef } from "../internal/agent-registry-bridge";
import type { AgentRef } from "../registry/agent-registry";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import {
	agentRefsForContext,
	artifactsDirsForContext,
	isBoundResourceContext,
	sessionFilesFromContext,
	sessionFilesFromDisk,
} from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/** Humanize a last-activity timestamp as `Ns/Nm/Nh/Nd ago`. */
function formatAgo(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const secs = Math.floor(diffMs / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** One row of the history index — either a registered ref or a disk-only transcript. */
interface IndexEntry {
	id: string;
	status: string;
	kind: string;
	parent: string;
	lastActivity: string;
}

/**
 * Handler for history:// URLs.
 *
 * Resolves agent ids through the caller-visible registry refs, then falls back
 * to on-disk `.jsonl` transcripts, serving read-only history for live, parked,
 * and unregistered agents alike.
 */
export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const agentId = url.rawHost || url.hostname;
		const bound = isBoundResourceContext(context);
		const registry = context?.agentRegistry ?? (bound ? undefined : AgentRegistry.global());
		const dirs = artifactsDirsForContext(context);
		if (bound && dirs.length === 0) throw new Error("No caller-owned history available");
		let rootSessionFile: string | undefined;
		if (agentId && registry && context?.sessionFile)
			rootSessionFile = await ensurePersistedRoster(registry, context.sessionFile);
		const preferredArtifactDir = rootSessionFile?.slice(0, -".jsonl".length);
		const visible = registry ? agentRefsForContext(registry, context).filter(ref => ref.kind !== "advisor") : [];

		if (!agentId) {
			const content = await this.#renderIndex(visible, context);
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		const ref =
			visible.find(candidate => candidate.id === agentId) ??
			visible.find(candidate => candidate.id.toLowerCase() === agentId.toLowerCase());

		if (!ref) {
			const disk = await this.#resolveFromDisk(agentId, context, preferredArtifactDir);
			if (disk) return { ...disk, url: url.href };
			throw new Error(`Unknown agent: ${agentId}`);
		}

		const notes: string[] = [];
		let messages: unknown[];
		const liveSession = registry ? lookupAgentRef(registry, ref.id)?.session : undefined;
		if (liveSession) {
			messages = liveSession.messages;
			notes.push("Source: live session");
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			notes.push(`Source: session file (read-only, ${ref.status})`);
		} else {
			const disk = await this.#resolveFromDisk(ref.id, context, preferredArtifactDir);
			if (disk) return { ...disk, url: url.href };
			throw new Error(`Agent ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		const content = formatSessionHistoryMarkdown(messages, { title: `${ref.id} (${ref.status})` });
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: ref.sessionFile ?? undefined,
			notes,
		};
	}

	/**
	 * Load a transcript for `agentId` from an on-disk `.jsonl` session file,
	 * matched case-insensitively. Returns `undefined` when no file is found.
	 * `preferredArtifactDir` — the caller root's artifact directory, when
	 * known — is scanned before every registry-derived dir, so a same-id
	 * transcript from another root cannot shadow the caller's own.
	 */
	async #resolveFromDisk(
		agentId: string,
		context: ResolveContext | undefined,
		preferredArtifactDir?: string,
	): Promise<InternalResource | undefined> {
		const files = isBoundResourceContext(context)
			? await sessionFilesFromContext(context)
			: await sessionFilesFromDisk(preferredArtifactDir);
		const lower = agentId.toLowerCase();
		let matchedId: string | undefined;
		let sessionFile: string | undefined;
		for (const [id, file] of files) {
			if (id === agentId || id.toLowerCase() === lower) {
				matchedId = id;
				sessionFile = file;
				if (id === agentId) break;
			}
		}
		if (!matchedId || !sessionFile) return undefined;
		const messages = await loadSessionMessagesReadOnly(sessionFile);
		const content = formatSessionHistoryMarkdown(messages, { title: `${matchedId} (on disk)` });
		return {
			url: "",
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: sessionFile,
			notes: ["Source: session file (read-only, unregistered)"],
		};
	}

	async #renderIndex(refs: AgentRef[], context?: ResolveContext): Promise<string> {
		const entries: IndexEntry[] = refs.map(ref => ({
			id: ref.id,
			status: ref.status,
			kind: ref.kind,
			parent: ref.parentId ?? "—",
			lastActivity: formatAgo(ref.lastActivity),
		}));
		const registered = new Set(refs.map(ref => ref.id));
		const disk = isBoundResourceContext(context)
			? await sessionFilesFromContext(context)
			: await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (registered.has(id)) continue;
			entries.push({ id, status: "on disk", kind: "—", parent: "—", lastActivity: "—" });
		}

		const lines: string[] = ["# Agents", ""];
		if (entries.length === 0) {
			lines.push("No agents registered.");
			return `${lines.join("\n")}\n`;
		}
		lines.push("| id | status | kind | parent | last activity |", "|---|---|---|---|---|");
		for (const entry of entries) {
			lines.push(`| ${entry.id} | ${entry.status} | ${entry.kind} | ${entry.parent} | ${entry.lastActivity} |`);
		}
		lines.push("", "Read a transcript with `read history://<id>`.");
		return `${lines.join("\n")}\n`;
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		const seen = new Set<string>();
		const registry = context?.agentRegistry ?? (isBoundResourceContext(context) ? undefined : AgentRegistry.global());
		const visible = registry ? agentRefsForContext(registry, context) : [];
		for (const ref of visible) {
			if (ref.kind === "advisor") continue;
			seen.add(ref.id);
			completions.push({
				value: ref.id,
				description: `${ref.status} · ${ref.kind}${ref.parentId ? ` · parent ${ref.parentId}` : ""}`,
			});
		}
		const disk = isBoundResourceContext(context)
			? await sessionFilesFromContext(context)
			: await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (seen.has(id)) continue;
			seen.add(id);
			completions.push({ value: id, description: "on disk" });
		}
		return completions;
	}
}
