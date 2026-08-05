import type { BackgroundControlResult } from "../async/job-manager";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type { AgentLifecycleManager } from "./agent-lifecycle";
import type { AgentRef, AgentRegistry } from "./agent-registry";
import { MAIN_AGENT_ID } from "./agent-registry";

export type AgentTerminationPolicy =
	| { scope: "unrestricted" }
	| { scope: "direct-child" | "descendant"; ownerId: string };

export interface TerminateSubagentOptions {
	registry: AgentRegistry;
	lifecycle?: AgentLifecycleManager;
	targetId: string;
	policy: AgentTerminationPolicy;
	/** Exact generation authorized by the caller; null means the caller observed no target. */
	expectedRef?: AgentRef | null;
}

function unavailable(id: string, message: string): BackgroundControlResult {
	return { id, status: "not_found", message };
}

function isDescendant(registry: AgentRegistry, ref: AgentRef, ownerId: string): boolean {
	const visited = new Set<string>([ref.id]);
	let parentId = ref.parentId;
	while (parentId) {
		if (parentId === ownerId) return true;
		if (visited.has(parentId)) return false;
		visited.add(parentId);
		const parent = registry.get(parentId);
		if (!parent) return false;
		parentId = parent.parentId;
	}
	return false;
}

function isAuthorized(registry: AgentRegistry, ref: AgentRef, policy: AgentTerminationPolicy): boolean {
	if (policy.scope === "unrestricted") return true;
	if (ref.id === policy.ownerId) return false;
	if (policy.scope === "direct-child") return ref.parentId === policy.ownerId;
	return isDescendant(registry, ref, policy.ownerId);
}

/**
 * Permanently terminate one subagent generation. Ordinary lifecycle races are
 * returned as stable control outcomes; authorization failures are deliberately
 * indistinguishable from missing targets.
 */
export async function terminateSubagent(options: TerminateSubagentOptions): Promise<BackgroundControlResult> {
	const { registry, lifecycle, targetId, policy, expectedRef } = options;
	const ref = registry.get(targetId);
	if (expectedRef !== undefined && ref !== expectedRef) {
		return unavailable(targetId, `Subagent not found: ${targetId}`);
	}
	if (ref?.kind !== "sub" || ref.id === MAIN_AGENT_ID) {
		return unavailable(targetId, `Subagent not found: ${targetId}`);
	}
	if (!isAuthorized(registry, ref, policy)) {
		return unavailable(targetId, `Subagent not found: ${targetId}`);
	}
	if (ref.status === "aborted") {
		return { id: targetId, status: "already_completed", message: `Subagent ${targetId} is already aborted.` };
	}
	if (!lifecycle) {
		return unavailable(targetId, "Subagent lifecycle control is unavailable in this session.");
	}

	let abortError: unknown;
	if (ref.status === "running" && ref.session) {
		try {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		} catch (error) {
			abortError = error;
		}
	}
	try {
		const released = await lifecycle.release(targetId, ref, { tombstone: true });
		if (!released || registry.get(targetId) !== ref || registry.get(targetId)?.status !== "aborted") {
			return {
				id: targetId,
				status: "already_completed",
				message: `Subagent ${targetId} changed before termination completed.`,
			};
		}
		return { id: targetId, status: "cancelled", message: `Terminated subagent ${targetId}.` };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const abortDetail =
			abortError === undefined
				? ""
				: ` Abort cleanup also failed: ${abortError instanceof Error ? abortError.message : String(abortError)}.`;
		return {
			id: targetId,
			status: "already_completed",
			message: `Subagent ${targetId} could not be terminated: ${detail}.${abortDetail}`,
		};
	}
}
