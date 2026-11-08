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
import type { PersistedSessionInit } from "../../session/session-manager";
import { isScopeNoBroader } from "./compose";
import { loadPermissionProfiles, permissionProfileDrift } from "./profiles";
import { permissionScopeHash, readPermissionSnapshot } from "./snapshot";
import type { DeepImmutable, PermissionScope } from "./types";

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

/** The `session_init` fields revival reads. */
export type PermissionInitFields = Pick<
	PersistedSessionInit,
	"requestedPermissionProfiles" | "effectivePermissionProfiles" | "permissionSnapshot"
>;

/** What the parent's transcript says about the child: the hash it recorded, or why it could not be read. */
export type ParentBindingState =
	| { readonly readable: true; readonly hash: string | undefined }
	| { readonly readable: false; readonly reason: string };

/** The scope the parent runs under now (`undefined` when none), or why it could not be read. */
export type ParentScopeState =
	| { readonly ok: true; readonly scope: DeepImmutable<PermissionScope> | undefined }
	| { readonly ok: false; readonly error: string };

export interface PermissionRevivalInput {
	readonly agentId: string;
	readonly parentId: string | undefined;
	readonly init: PermissionInitFields;
	readonly parentBinding: ParentBindingState;
	readonly parentScope: ParentScopeState;
	/** Where the profile files are looked up: the cwd the child was spawned in. */
	readonly cwd: string;
	readonly agentDir: string;
}

/** What the user can do about a refusal. */
export type PermissionRevivalRemedy = "fresh-subagent" | "restore-profile";

export type PermissionRevivalDecision =
	| {
			readonly ok: true;
			/** The scope to restore; `undefined` revives the child without one. */
			readonly scope: PermissionScope | undefined;
			/** The persisted snapshot's hash, which the transcript must still hold when it is reopened. */
			readonly persistedHash: string | undefined;
	  }
	| { readonly ok: false; readonly reason: string; readonly remedy: PermissionRevivalRemedy };

function refuse(reason: string, remedy: PermissionRevivalRemedy = "fresh-subagent"): PermissionRevivalDecision {
	return { ok: false, reason, remedy };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** A restricted parent scope that `child` (or no scope at all) would exceed. */
function broaderThanParent(
	parent: DeepImmutable<PermissionScope> | undefined,
	child: DeepImmutable<PermissionScope> | undefined,
): boolean {
	if (!parent?.restricted || parent.mode === "off") return false;
	return child === undefined || !isScopeNoBroader(parent as PermissionScope, child as PermissionScope);
}

/**
 * Decide whether a persisted subagent may revive and under which scope (design 4; P5).
 *
 * A transcript without permission fields, whose parent recorded nothing for it, revives without a
 * scope, as upstream does. A snapshot must verify, match the hash its parent recorded at spawn (a
 * fork-era v1 snapshot predates that record), name this agent and its parent, list the same profiles
 * as its provenance, and use profiles whose files did not change since. Whatever it restores must be
 * no broader than the scope the parent runs under now.
 */
export async function checkPermissionRevival(input: PermissionRevivalInput): Promise<PermissionRevivalDecision> {
	const { init, parentBinding, parentScope } = input;
	if (!parentScope.ok) return refuse(`its parent's permission scope is unreadable (${parentScope.error})`);
	const persisted = init.permissionSnapshot;
	if (persisted === undefined) {
		if (init.requestedPermissionProfiles !== undefined || init.effectivePermissionProfiles !== undefined) {
			return refuse("its session_init lists permission profiles but holds no permission snapshot");
		}
		if (parentBinding.readable && parentBinding.hash !== undefined) {
			return refuse("its parent recorded a permission scope for it, but its transcript holds none");
		}
		if (broaderThanParent(parentScope.scope, undefined)) {
			return refuse("it would revive with a broader permission scope than its parent now runs under");
		}
		return { ok: true, scope: undefined, persistedHash: undefined };
	}

	const read = readPermissionSnapshot(persisted);
	if (!read.ok) return refuse(`its permission snapshot does not verify (${read.error})`);
	if (!parentBinding.readable) return refuse(parentBinding.reason);
	if (parentBinding.hash === undefined) {
		// The fork bound fork-era (v1) scopes in its retired authority journal, never in the parent.
		if (read.version === 2) return refuse("its parent has no record of the permission scope it was spawned with");
	} else if (parentBinding.hash !== persisted.canonicalSha256) {
		return refuse("its permission snapshot does not match the scope its parent recorded when it spawned it");
	}

	const scope = read.snapshot.scope;
	if (scope.actorId !== input.agentId || scope.actorKind !== "sub" || scope.parentId !== input.parentId) {
		return refuse(
			`its permission snapshot was made for agent "${scope.actorId}" under "${scope.parentId ?? "none"}", not for this agent`,
		);
	}
	const provenanceNames = scope.provenance.profiles.map(identity => identity.name);
	if (
		!sameNames(provenanceNames, scope.profiles) ||
		(init.effectivePermissionProfiles !== undefined && !sameNames(init.effectivePermissionProfiles, scope.profiles))
	) {
		return refuse("its recorded permission profiles disagree with its permission snapshot");
	}
	if (scope.provenance.profiles.length > 0) {
		const drift = permissionProfileDrift(
			scope.provenance.profiles,
			await loadPermissionProfiles(input.cwd, { agentDir: input.agentDir }),
		);
		if (drift !== undefined) return refuse(drift, "restore-profile");
	}

	if (scope.inherited && parentScope.scope === undefined) {
		return refuse("it inherited its parent's permission scope, but its parent no longer runs under one");
	}
	if (broaderThanParent(parentScope.scope, scope)) {
		return refuse("it would revive with a broader permission scope than its parent now runs under");
	}
	// A scope recorded with mode off restricts nothing and revives as no scope.
	return {
		ok: true,
		scope: scope.mode === "off" ? undefined : (scope as PermissionScope),
		persistedHash: persisted.canonicalSha256,
	};
}

/** The error message for a refused revival: why, and what the user can do instead. */
export function permissionRevivalRefusal(
	agentId: string,
	decision: Extract<PermissionRevivalDecision, { ok: false }>,
): string {
	const fresh = `start a fresh subagent for the work; its transcript stays readable at history://${agentId}`;
	const remedy =
		decision.remedy === "restore-profile"
			? `Restore the permission profile file to what it held when the subagent was spawned and retry, or ${fresh}.`
			: `${fresh.charAt(0).toUpperCase()}${fresh.slice(1)}.`;
	return `Cannot revive subagent "${agentId}": ${decision.reason}. The agent was not revived. ${remedy}`;
}

/**
 * The scope a parent's `session_init` records for it, for a parent that is not live: `undefined` when
 * it ran without one (or with mode off), an error when its fields do not verify.
 */
export function persistedParentScope(init: PermissionInitFields | null | undefined): ParentScopeState {
	const persisted = init?.permissionSnapshot;
	if (persisted === undefined) {
		return init?.requestedPermissionProfiles !== undefined || init?.effectivePermissionProfiles !== undefined
			? { ok: false, error: "its session_init lists permission profiles but holds no permission snapshot" }
			: { ok: true, scope: undefined };
	}
	const read = readPermissionSnapshot(persisted);
	if (!read.ok) return { ok: false, error: read.error };
	return { ok: true, scope: read.snapshot.scope.mode === "off" ? undefined : read.snapshot.scope };
}
