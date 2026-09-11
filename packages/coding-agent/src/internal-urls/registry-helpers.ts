/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { listAgentRefs, lookupAgentRef } from "../internal/agent-registry-bridge";
import { AgentRegistry } from "../registry/agent-registry";
import type { ResolveContext } from "./types";

const extraArtifactsDirs = new Set<string>();

export function registerArtifactsDir(dir: string): () => void {
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Collects TWO candidate dirs per ref, because a subagent reads from its
 * adopted (root-wide) `ArtifactManager.dir` but its own children are published
 * one level deeper, under `sessionFile.slice(0, -6)` (`task/index.ts`). A
 * depth-2+ subagent's output head therefore belongs to the write-time manager,
 * not the adopted one, so `agent://` must query both managers.
 * `addDir` dedup collapses the depth-0 case (both formulas agree) back to a
 * single entry.
 *
 * When `options.preferredDir` is supplied — the caller root's canonical
 * artifact directory, derived from the caller's session file — it is inserted
 * FIRST, ahead of every registry-derived dir. Under A/B same-id conflicts the
 * caller's own root must win even when the process-global registry's single
 * `Main` ref belongs to another root (or the caller's session is not
 * registered at all). Absent a preferred dir, the pre-existing process-global
 * ordering is preserved unchanged.
 */
export function artifactsDirsFromRegistry(options?: { preferredDir?: string }): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	if (options?.preferredDir) addDir(options.preferredDir);
	for (const ref of listAgentRefs(AgentRegistry.global())) {
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	return dirs;
}

/** Return only the artifact roots owned by a bound caller. */
export function artifactsDirsForContext(context?: ResolveContext): string[] {
	if (!context || !isBoundResourceContext(context)) return artifactsDirsFromRegistry();
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined): void => {
		if (dir && !dirs.includes(dir)) dirs.push(dir);
	};
	addDir(context.localProtocolOptions?.getArtifactsDir?.());
	if (context.agentRegistry) {
		const refs = listAgentRefs(context.agentRegistry);
		let scoped = refs;
		if (context.sessionFile || context.sessionId) {
			const caller = refs.find(
				ref =>
					(context.sessionFile !== undefined && ref.sessionFile === context.sessionFile) ||
					(context.sessionId !== undefined && ref.session?.sessionManager?.getSessionId?.() === context.sessionId),
			);
			if (!caller) {
				if (context.sessionFile) addDir(context.sessionFile.slice(0, -6));
				return dirs;
			}
			const rootId = caller.lineage?.rootId;
			if (rootId) scoped = refs.filter(ref => ref.lineage?.rootId === rootId);
		}
		for (const ref of scoped) {
			addDir(ref.session?.sessionManager?.getArtifactsDir());
			if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
		}
		return dirs;
	}
	if (context.sessionFile) addDir(context.sessionFile.slice(0, -6));
	return dirs;
}

/** Return only registry refs whose retained/live resources belong to a bound caller root. */
export function agentRefsForContext(registry: AgentRegistry, context?: ResolveContext) {
	const refs = listAgentRefs(registry);
	if (!isBoundResourceContext(context)) return refs;
	const dirs = artifactsDirsForContext(context);
	if (dirs.length === 0) return [];
	const owns = (candidate: string | null | undefined): boolean => {
		if (!candidate) return false;
		const resolved = path.resolve(candidate);
		return dirs.some(dir => {
			const root = path.resolve(dir);
			return resolved === root || resolved.startsWith(`${root}${path.sep}`);
		});
	};
	return refs.filter(ref => owns(ref.sessionFile) || owns(ref.session?.sessionManager?.getArtifactsDir?.()));
}

/** True for contexts that carry authority identity and therefore must fail closed. */
export function isBoundResourceContext(context?: ResolveContext): boolean {
	return Boolean(
		context && (context.agentRegistry || context.sessionFile || context.sessionId || context.localProtocolOptions),
	);
}

/**
 * Recursively scan artifacts dirs for agent session transcripts, keyed by
 * agent id (the `.jsonl` basename). Used by `history://` so transcripts of
 * agents no longer in the registry (unregistered one-shot helpers, released
 * agents, or any agent after session resume) remain reachable from their
 * retained session files.
 *
 * Layout follows `task/index.ts`: a subagent's transcript is
 * `<artifactsDir>/<AgentId>.jsonl`, and its own children nest one level deeper
 * under `<artifactsDir>/<AgentId>/<AgentId>.<ChildId>.jsonl`. Advisor
 * transcripts (`__advisor*.jsonl`) are observability-only and excluded;
 * EPERM-rewrite backups (`.bak`) are skipped. When the same id appears in
 * multiple dirs, the first hit wins (registry dirs are scanned first; a
 * `preferredDir` from the caller root is scanned before them).
 */
export async function sessionFilesFromDisk(preferredDir?: string): Promise<Map<string, string>> {
	const dirs = preferredDir ? [preferredDir, ...artifactsDirsFromRegistry()] : artifactsDirsFromRegistry();
	return sessionFilesFromDirs(dirs);
}

export async function sessionFilesFromContext(context?: ResolveContext): Promise<Map<string, string>> {
	return sessionFilesFromDirs(artifactsDirsForContext(context));
}

async function sessionFilesFromDirs(dirs: readonly string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const seenDirs = new Set<string>();
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > 8 || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await scan(path.join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const name = entry.name;
			if (!name.endsWith(".jsonl") || name.startsWith("__advisor")) continue;
			const id = name.slice(0, -".jsonl".length);
			if (!found.has(id)) found.set(id, path.join(dir, name));
		}
	};
	for (const dir of dirs) await scan(dir, 0);
	return found;
}

/**
 * Availability half of the `history://` resolution semantics: true when a
 * transcript for `agentId` can be served from a registered ref's live session
 * or retained session file, or from an on-disk `.jsonl` under a known
 * artifacts dir. Hint surfaces use this so they only advertise
 * `history://<agentId>` links that `HistoryProtocolHandler` can actually
 * resolve. A retained sessionFile path is verified on disk before it counts,
 * and probing never throws: a stale path or unreadable artifacts subtree
 * reads as unavailable instead of disturbing the caller's delivery path.
 */
export async function hasResolvableTranscript(agentId: string): Promise<boolean> {
	try {
		const registry = AgentRegistry.global();
		const lower = agentId.toLowerCase();
		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		ref ??= registry.list().find(candidate => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower);
		if (ref && lookupAgentRef(registry, ref.id)?.session) return true;
		if (ref?.sessionFile && (await isReadableFile(ref.sessionFile))) return true;
		const files = await sessionFilesFromDisk();
		for (const id of files.keys()) {
			if (id.toLowerCase() === lower) return true;
		}
	} catch {
		// Availability probing is advisory; any filesystem failure means the
		// transcript cannot be promised, never that delivery should fail.
	}
	return false;
}

/** True when `file` exists and is a regular file; never throws. */
async function isReadableFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile();
	} catch {
		return false;
	}
}
