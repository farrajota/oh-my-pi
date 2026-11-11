/**
 * Subagent termination on behalf of an owner that is not the agent hub: an extension's
 * `ctx.terminateSubagent` (the activity dashboard's stop control).
 */
import type { BackgroundControlResult } from "../session/agent-session-types";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type { AgentLifecycleApi } from "./agent-lifecycle";
import type { AgentRef, AgentRegistryApi } from "./agent-registry";
import { sessionFileBelongsToRoot } from "./persisted-agents";

export interface TerminateSubagentOptions {
	registry: AgentRegistryApi;
	lifecycle: AgentLifecycleApi;
	/** Registry id of the agent asking; only its descendants can be terminated. */
	ownerId: string;
	/**
	 * Transcript of the owner's session, undefined when it has none. A target with a transcript
	 * outside this session's artifacts tree belongs to another session.
	 */
	ownerSessionFile: string | undefined;
	targetId: string;
}

/**
 * The registry is process-global and every session's main agent is "Main", so lineage alone also
 * reaches an earlier session's parked subagents. A target with a transcript must also live in the
 * owner's artifacts tree (the agent hub roster's predicate); one without a transcript (a session
 * without a session file spawns those) is judged by lineage only.
 */
function inOwnerSession(ref: AgentRef, ownerSessionFile: string | undefined): boolean {
	if (!ref.sessionFile) return true;
	return ownerSessionFile !== undefined && sessionFileBelongsToRoot(ref.sessionFile, ownerSessionFile);
}

function isDescendant(registry: AgentRegistryApi, ref: AgentRef, ownerId: string): boolean {
	const visited = new Set<string>([ref.id]);
	for (let parentId = ref.parentId; parentId !== undefined; parentId = registry.get(parentId)?.parentId) {
		if (parentId === ownerId) return true;
		if (visited.has(parentId)) return false;
		visited.add(parentId);
	}
	return false;
}

/**
 * Kill one subagent below `ownerId`, the way the agent hub and RPC `cancel_subagent` do: release
 * the generation seen now as an `aborted` tombstone and abort its running turn. Targets outside
 * the owner's tree read as not found, like missing ones. Rejects when the tombstone cannot be
 * persisted or the abort fails.
 */
export async function terminateSubagent(options: TerminateSubagentOptions): Promise<BackgroundControlResult> {
	const { registry, lifecycle, ownerId, ownerSessionFile, targetId } = options;
	const notFound: BackgroundControlResult = {
		id: targetId,
		status: "not_found",
		message: `Subagent not found: ${targetId}`,
	};
	const ref = registry.get(targetId);
	if (
		!ref ||
		ref.kind !== "sub" ||
		ref.id === ownerId ||
		!isDescendant(registry, ref, ownerId) ||
		!inOwnerSession(ref, ownerSessionFile)
	) {
		return notFound;
	}
	if (ref.status === "aborted") {
		return { id: targetId, status: "already_completed", message: `Subagent ${targetId} is already stopped.` };
	}
	// Read the live session first: release detaches it from the ref.
	const liveSession = ref.status === "running" ? ref.session : null;
	// Release before aborting: it publishes the tombstone synchronously, so the run cannot hand
	// over a result (flipping the ref to idle) while the abort settles.
	const [released, aborted] = await Promise.allSettled([
		lifecycle.release(targetId, ref, { tombstone: true }),
		liveSession?.abort({ reason: USER_INTERRUPT_LABEL }),
	]);
	if (released.status === "rejected") throw released.reason;
	if (aborted.status === "rejected") throw aborted.reason;
	if (!released.value) {
		return {
			id: targetId,
			status: "already_completed",
			message: `Subagent ${targetId} changed before it could be terminated.`,
		};
	}
	return { id: targetId, status: "cancelled", message: `Terminated subagent ${targetId}.` };
}
