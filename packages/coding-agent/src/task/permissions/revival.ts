/**
 * Revival of a persisted subagent under the permission scope it was spawned with.
 *
 * The child's `session_init` holds its scope snapshot. The spawning session also records the child's
 * scope hash in its own transcript (P5), because the child's transcript is the child's to write while
 * the parent's is not: both live under the agent dir, which an enforce-restricted child may not write.
 * Revival restores the snapshot only when it matches that record, still names the same actor, parent
 * and profiles, and is no broader than the scope the parent runs under now.
 */
import type { FileEntry } from "../../session/session-entries";
import type { PermissionScope } from "./types";
import { permissionScopeHash } from "./snapshot";

/** `customType` of the entry a spawning session appends for each scoped child. */
export const PERMISSION_BINDING_CUSTOM_TYPE = "subagent_permission_binding";

/** Data of a {@link PERMISSION_BINDING_CUSTOM_TYPE} entry. */
export interface SubagentPermissionBinding {
	readonly agentId: string;
	readonly canonicalSha256: string;
}

/**
 * Record in the spawning session's transcript that child `agentId` runs under `scope`. Call it once
 * the child's id is allocated and before it runs, so the record exists by the time it can park.
 */
export function recordPermissionBinding(
	sessionManager: { appendCustomEntry(customType: string, data?: unknown): unknown } | undefined,
	agentId: string,
	scope: PermissionScope,
): void {
	const binding: SubagentPermissionBinding = { agentId, canonicalSha256: permissionScopeHash(scope) };
	sessionManager?.appendCustomEntry(PERMISSION_BINDING_CUSTOM_TYPE, binding);
}

function bindingData(entry: FileEntry): SubagentPermissionBinding | undefined {
	if (entry.type !== "custom" || entry.customType !== PERMISSION_BINDING_CUSTOM_TYPE) return undefined;
	const data = entry.data as Partial<SubagentPermissionBinding> | undefined;
	return typeof data?.agentId === "string" && typeof data.canonicalSha256 === "string"
		? { agentId: data.agentId, canonicalSha256: data.canonicalSha256 }
		: undefined;
}

/** The scope hash `entries` last recorded for child `agentId`, or `undefined` when there is none. */
export function permissionBindingIn(entries: Iterable<FileEntry>, agentId: string): string | undefined {
	let hash: string | undefined;
	for (const entry of entries) {
		const binding = bindingData(entry);
		if (binding?.agentId === agentId) hash = binding.canonicalSha256;
	}
	return hash;
}
