import { derivePermissionGuardrails } from "./guardrails";
import { flattenPathGroups, toPathConstraintGroup } from "./path-rules";
import { BUILTIN_PERMISSION_PROFILES, canonicalProfile, canonicalProfileName, profileContentHash } from "./profiles";
import { permissionToolKey, uniquePermissionTools } from "./tool-names";
import type {
	PathConstraintGroup,
	PermissionActorKind,
	PermissionCapability,
	PermissionProfile,
	PermissionProfileIdentity,
	PermissionScope,
	SubagentPermissionMode,
	TaskPermissionRequest,
	TaskPermissionRequestShape,
} from "./types";

export type PermissionComposeResult = { ok: true; value: PermissionScope } | { ok: false; error: string };

export interface PermissionComposeInput {
	readonly mode: SubagentPermissionMode;
	readonly toolsEnabled: boolean;
	readonly pathsEnabled: boolean;
	readonly actorId: string;
	readonly actorKind: PermissionActorKind;
	readonly parentId?: string;
	readonly request?: TaskPermissionRequest;
	/** Scope of the spawning subagent; a child is never broader than it. */
	readonly inherited?: PermissionScope;
	/** Profiles by canonical name, as {@link loadPermissionProfiles} returns them. */
	readonly profiles: Readonly<Record<string, PermissionProfile>>;
	/** Loader identities; a profile without one is recorded with source `request`. */
	readonly profileIdentities?: Readonly<Record<string, PermissionProfileIdentity>>;
}

export interface PermissionPreflightInput extends PermissionComposeInput {
	/** Every tool route the spawning session exposes. */
	readonly capabilities?: readonly PermissionCapability[];
}

/** Classify a request without changing it. */
export function classifyTaskPermissionRequest(
	request: TaskPermissionRequest | undefined,
	profiles: Readonly<Record<string, PermissionProfile>> = BUILTIN_PERMISSION_PROFILES,
): TaskPermissionRequestShape {
	if (request === undefined) return "omitted";
	const profileNames = request.profiles ?? [];
	const hasProfiles = profileNames.length > 0;
	const hasPositiveProfile = profileNames.some(name => {
		const profile = profiles[canonicalProfileName(name)] ?? profiles[name];
		return profile !== undefined && Object.hasOwn(profile, "tools");
	});
	const hasToolAllow = request.tools !== undefined;
	const hasToolDeny = (request.denyTools?.length ?? 0) > 0;
	const hasPath = (request.allowPaths?.length ?? 0) > 0 || (request.denyPaths?.length ?? 0) > 0;
	if (!hasProfiles && !hasToolAllow && !hasToolDeny && !hasPath) return "empty";
	if (hasToolAllow && request.tools?.length === 0) return "explicit-tools-allow-none";
	if (hasToolAllow) return hasPath || hasToolDeny || hasProfiles ? "mixed" : "explicit-tools-allowlist";
	if (hasProfiles && hasPositiveProfile) return hasPath || hasToolDeny ? "mixed" : "profile-positive";
	if (hasToolDeny && !hasProfiles && !hasPath) return "deny-only";
	if (hasPath && !hasProfiles && !hasToolDeny) return "path-only-ambient";
	if (hasProfiles || hasToolDeny) return "modifier-only";
	return "mixed";
}

function intersectTools(left: readonly string[], right: readonly string[]): string[] {
	const allowed = new Set(right.map(permissionToolKey));
	return uniquePermissionTools(left.filter(value => allowed.has(permissionToolKey(value))));
}

function requestNeedsToolAllowlist(request: TaskPermissionRequest | undefined): boolean {
	if (!request) return false;
	return (request.profiles?.length ?? 0) > 0 || request.tools !== undefined || (request.denyTools?.length ?? 0) > 0;
}

function freezeGroups(groups: readonly PathConstraintGroup[]): readonly PathConstraintGroup[] {
	return Object.freeze(groups.map(group => Object.freeze([...group]) as PathConstraintGroup));
}

/**
 * Compose a task request with the selected profiles and the inherited scope into the scope the
 * subagent runs under.
 *
 * - Role profiles grant tools only through their `tools` lists, which are intersected with each other,
 *   with an inline `tools` list and with an inherited allowlist. Modifier profiles only restrict.
 * - In enforce mode with tool permissions on, a request naming profiles or tools must end with a
 *   concrete allowlist.
 * - Deny tools are unioned. Each source contributes one path group: every allow group must match and
 *   any deny group denies.
 * - An omitted or empty request inherits the parent scope unchanged.
 */
export function composeEffectivePermissions(input: PermissionComposeInput): PermissionComposeResult {
	const requestShape = classifyTaskPermissionRequest(input.request, input.profiles);
	const selected: Array<{ name: string; profile: PermissionProfile; identity: PermissionProfileIdentity }> = [];
	for (const requestedName of input.request?.profiles ?? []) {
		const name = canonicalProfileName(requestedName);
		const profile = input.profiles[name] ?? input.profiles[requestedName];
		if (!profile) {
			return {
				ok: false,
				error: `Unknown permission profile "${requestedName}". Available: ${Object.keys(input.profiles).sort().join(", ")}`,
			};
		}
		const owned = canonicalProfile(profile);
		selected.push({
			name,
			profile: owned,
			identity: input.profileIdentities?.[name] ?? {
				name,
				source: "request",
				canonicalSha256: profileContentHash(owned),
			},
		});
	}
	const base = {
		mode: input.mode,
		toolsEnabled: input.toolsEnabled,
		pathsEnabled: input.pathsEnabled,
		actorId: input.actorId,
		actorKind: input.actorKind,
		parentId: input.parentId,
	};
	if (input.mode === "off") {
		return {
			ok: true,
			value: buildScope({
				...base,
				profiles: [],
				denyTools: [],
				allowPathGroups: [],
				denyPathGroups: [],
				restricted: false,
			}),
		};
	}

	const profiles = selected.map(entry => entry.profile);
	const request = input.request;
	const inherited = input.inherited;
	const hasToolControls =
		request?.tools !== undefined ||
		(request?.denyTools?.length ?? 0) > 0 ||
		profiles.some(profile => Object.hasOwn(profile, "tools") || (profile.denyTools?.length ?? 0) > 0);
	const hasPathControls =
		(request?.allowPaths?.length ?? 0) > 0 ||
		(request?.denyPaths?.length ?? 0) > 0 ||
		profiles.some(profile => (profile.allowPaths?.length ?? 0) > 0 || (profile.denyPaths?.length ?? 0) > 0);
	if (!input.toolsEnabled && hasToolControls) {
		return {
			ok: false,
			error: "Subagent tool permissions are disabled; remove tool clauses or enable task.permissions.tools.enabled.",
		};
	}
	if (!input.pathsEnabled && hasPathControls) {
		return {
			ok: false,
			error: "Subagent path permissions are disabled; remove path clauses or enable task.permissions.paths.enabled.",
		};
	}

	const restricted = !(requestShape === "omitted" || requestShape === "empty") || inherited !== undefined;
	if (inherited !== undefined && (requestShape === "omitted" || requestShape === "empty")) {
		return {
			ok: true,
			value: buildScope({
				...base,
				profiles: inherited.profiles,
				tools: inherited.tools,
				denyTools: inherited.denyTools,
				allowPathGroups: inherited.allowPathGroups,
				denyPathGroups: inherited.denyPathGroups,
				restricted,
				inherited,
			}),
		};
	}

	let tools: string[] | undefined;
	for (const profile of profiles) {
		if (!Object.hasOwn(profile, "tools")) continue;
		const row = uniquePermissionTools(profile.tools ?? []);
		tools = tools === undefined ? row : intersectTools(tools, row);
	}
	if (request?.tools !== undefined) {
		const row = uniquePermissionTools(request.tools);
		tools = tools === undefined ? row : intersectTools(tools, row);
	}
	if (inherited?.tools !== undefined)
		tools = tools === undefined ? [...inherited.tools] : intersectTools(tools, inherited.tools);
	if (input.mode === "enforce" && input.toolsEnabled && requestNeedsToolAllowlist(request) && tools === undefined) {
		return {
			ok: false,
			error: "Subagent tool permissions require a concrete allowlist. Add permissions.tools or at least one role profile with tools; modifier-only profiles only add restrictions.",
		};
	}
	const denyTools = input.toolsEnabled
		? uniquePermissionTools([
				...profiles.flatMap(profile => profile.denyTools ?? []),
				...(request?.denyTools ?? []),
				...(inherited?.denyTools ?? []),
			])
		: [];
	const groupsOf = (values: readonly (readonly string[] | undefined)[]): PathConstraintGroup[] =>
		values.flatMap(value => {
			const group = toPathConstraintGroup(value);
			return group ? [group] : [];
		});
	const allowPathGroups = input.pathsEnabled
		? [
				...(inherited?.allowPathGroups ?? []),
				...groupsOf([...profiles.map(profile => profile.allowPaths), request?.allowPaths]),
			]
		: [];
	const denyPathGroups = input.pathsEnabled
		? [
				...(inherited?.denyPathGroups ?? []),
				...groupsOf([...profiles.map(profile => profile.denyPaths), request?.denyPaths]),
			]
		: [];
	return {
		ok: true,
		value: buildScope({
			...base,
			profiles: [...new Set([...(inherited?.profiles ?? []), ...selected.map(entry => entry.name)])],
			tools,
			denyTools,
			allowPathGroups,
			denyPathGroups,
			restricted,
			inherited,
			selectedIdentities: selected.map(entry => entry.identity),
		}),
	};
}

function buildScope(input: {
	mode: SubagentPermissionMode;
	toolsEnabled: boolean;
	pathsEnabled: boolean;
	actorId: string;
	actorKind: PermissionActorKind;
	parentId?: string;
	profiles: readonly string[];
	tools?: readonly string[];
	denyTools: readonly string[];
	allowPathGroups: readonly PathConstraintGroup[];
	denyPathGroups: readonly PathConstraintGroup[];
	restricted: boolean;
	inherited?: PermissionScope;
	selectedIdentities?: readonly PermissionProfileIdentity[];
}): PermissionScope {
	const identities = [...(input.inherited?.provenance.profiles ?? []), ...(input.selectedIdentities ?? [])].filter(
		(identity, index, all) => all.findIndex(candidate => candidate.name === identity.name) === index,
	);
	return Object.freeze({
		v: 2,
		mode: input.mode,
		toolsEnabled: input.toolsEnabled,
		pathsEnabled: input.pathsEnabled,
		actorId: input.actorId,
		actorKind: input.actorKind,
		...(input.parentId === undefined ? {} : { parentId: input.parentId }),
		profiles: Object.freeze([...input.profiles]),
		...(input.tools === undefined ? {} : { tools: Object.freeze([...input.tools]) }),
		denyTools: Object.freeze([...input.denyTools]),
		allowPathGroups: freezeGroups(input.allowPathGroups),
		denyPathGroups: freezeGroups(input.denyPathGroups),
		guardrails: Object.freeze(derivePermissionGuardrails(input.denyTools, flattenPathGroups(input.denyPathGroups))),
		restricted: input.restricted,
		inherited: input.inherited !== undefined,
		provenance: Object.freeze({
			profiles: Object.freeze(identities.map(identity => Object.freeze({ ...identity }))),
		}),
	} satisfies PermissionScope);
}

/**
 * {@link composeEffectivePermissions}, then refuse an enforce scope that would expose custom or opaque
 * tool routes without a concrete allowlist: nothing would say which of them the subagent may call.
 */
export function preflightPermissionGuardrails(input: PermissionPreflightInput): PermissionComposeResult {
	const composed = composeEffectivePermissions(input);
	if (!composed.ok) return composed;
	const scope = composed.value;
	if (scope.mode !== "enforce" || !scope.restricted || scope.tools !== undefined) return composed;
	const unclassified = (input.capabilities ?? []).some(
		capability => capability.source === "custom" || capability.source === "opaque",
	);
	if (unclassified) {
		return {
			ok: false,
			error: "Cannot enforce subagent permissions while custom or opaque tool routes are exposed without a concrete tool allowlist.",
		};
	}
	return composed;
}

function isToolSubset(child: readonly string[] | undefined, parent: readonly string[] | undefined): boolean {
	if (parent === undefined) return true;
	if (child === undefined) return false;
	const parentKeys = new Set(parent.map(permissionToolKey));
	return child.every(value => parentKeys.has(permissionToolKey(value)));
}

function canonicalGroup(group: PathConstraintGroup): string {
	return JSON.stringify([...new Set(group.map(value => value.replaceAll("\\", "/")))].sort());
}

function containsExactGroups(
	candidates: readonly PathConstraintGroup[],
	required: readonly PathConstraintGroup[],
): boolean {
	const candidateGroups = new Set(candidates.map(canonicalGroup));
	return required.every(group => candidateGroups.has(canonicalGroup(group)));
}

/**
 * Structural, fail-closed check that `child` grants nothing `parent` does not. Path groups are compared
 * as exact rows: a related glob never counts as implying a parent row.
 */
export function isScopeNoBroader(parent: PermissionScope, child: PermissionScope): boolean {
	if (parent.mode === "enforce" && child.mode !== "enforce") return false;
	if (parent.toolsEnabled && !child.toolsEnabled) return false;
	if (parent.pathsEnabled && !child.pathsEnabled) return false;
	if (!isToolSubset(child.tools, parent.tools)) return false;
	const childDenies = new Set(child.denyTools.map(permissionToolKey));
	if (parent.denyTools.some(value => !childDenies.has(permissionToolKey(value)))) return false;
	if (!containsExactGroups(child.allowPathGroups, parent.allowPathGroups)) return false;
	if (!containsExactGroups(child.denyPathGroups, parent.denyPathGroups)) return false;
	if (parent.guardrails.noNetwork && !child.guardrails.noNetwork) return false;
	if (parent.guardrails.secretsBlind && !child.guardrails.secretsBlind) return false;
	if (parent.restricted && !child.restricted) return false;
	return true;
}
