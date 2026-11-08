/**
 * The spawn side of subagent permission profiles: composing the scope a child runs under, the tools it
 * starts with, and what its prompt says about the scope.
 *
 * A scope reaches the child as a runtime override of `task.permissions.activeScope` in its settings
 * overlay. A child spawned without a scope of its own reads its parent's through, so every spawn path
 * inherits the parent's restrictions; the routes that compose (task, eval `agent()`, `workpool()`)
 * write the child's own copy under its id.
 */
import type { Settings } from "../../config/settings";
import { BUILTIN_TOOL_NAMES } from "../../tools/builtin-names";
import { composeEffectivePermissions, isScopeNoBroader } from "./compose";
import { evaluateSubagentPermission } from "./evaluate";
import { activePermissionScope } from "./guard";
import { loadPermissionProfiles } from "./profiles";
import { cfgTaskPermissionsMode, cfgTaskPermissionsPathsEnabled, cfgTaskPermissionsToolsEnabled } from "./settings";
import { resolveTaskToolProfile, type TaskToolProfileName } from "./tool-profiles";
import { MESSAGING_GRANT, permissionToolKey, uniquePermissionTools } from "./tool-names";
import type {
	DeepImmutable,
	PathConstraintGroup,
	PermissionScope,
	SubagentPermissionMode,
	TaskPermissionRequest,
} from "./types";

const MODE_RANK: Record<SubagentPermissionMode, number> = { off: 0, suggest: 1, enforce: 2 };

/**
 * `request` with `toolProfile` folded in as one more tool allowlist: the profile's tools, intersected
 * with any inline `tools`. A profile only narrows; `none` allows no tools.
 */
export function withToolProfile(
	request: TaskPermissionRequest | undefined,
	toolProfile: TaskToolProfileName | undefined,
): TaskPermissionRequest | undefined {
	if (toolProfile === undefined) return request;
	const profileTools = resolveTaskToolProfile(toolProfile);
	if (request?.tools === undefined) return { ...request, tools: profileTools };
	const allowed = new Set(profileTools.map(permissionToolKey));
	return {
		...request,
		tools: uniquePermissionTools(request.tools).filter(tool => allowed.has(permissionToolKey(tool))),
	};
}

export interface SpawnScopeInput {
	/** The spawning session's settings: live mode, enabled dimensions, and the scope it runs under. */
	readonly settings: Settings;
	readonly cwd: string;
	/** Registry id of the spawning agent. */
	readonly parentId: string;
	readonly permissions?: TaskPermissionRequest;
	readonly toolProfile?: TaskToolProfileName;
}

export type SpawnScopeResult =
	| { readonly ok: true; readonly scope: PermissionScope | undefined }
	| { readonly ok: false; readonly error: string };

/**
 * The scope a child spawned from `input.settings` runs under, or `undefined` when it runs unscoped
 * (no request and no scope to inherit, or a request that restricts nothing). Its `actorId` is empty:
 * the caller sets it once the child's id is allocated.
 *
 * An inherited scope is never widened (C20): the child composes on top of it, keeps its mode,
 * dimensions and guardrails even when the live settings have since been relaxed, and a result that
 * is still broader is refused.
 */
export async function composeSpawnScope(input: SpawnScopeInput): Promise<SpawnScopeResult> {
	const active = activePermissionScope(input.settings);
	if (active && !active.ok) return { ok: false, error: `Subagent permission scope is unreadable: ${active.error}` };
	const inherited = active?.scope as PermissionScope | undefined;
	const request = withToolProfile(input.permissions, input.toolProfile);
	if (request === undefined && inherited === undefined) return { ok: true, scope: undefined };

	const liveMode = cfgTaskPermissionsMode.get(input.settings);
	const mode = inherited && MODE_RANK[inherited.mode] > MODE_RANK[liveMode] ? inherited.mode : liveMode;
	if (mode === "off") {
		return {
			ok: false,
			error: "Subagent permissions are disabled. Enable task.permissions.mode in /settings before using `permissions`.",
		};
	}
	const toolsEnabled = cfgTaskPermissionsToolsEnabled.get(input.settings) || inherited?.toolsEnabled === true;
	const pathsEnabled = cfgTaskPermissionsPathsEnabled.get(input.settings) || inherited?.pathsEnabled === true;
	const loaded =
		(request?.profiles?.length ?? 0) > 0
			? await loadPermissionProfiles(input.cwd, { agentDir: input.settings.getAgentDir() })
			: undefined;
	const composed = composeEffectivePermissions({
		mode,
		toolsEnabled,
		pathsEnabled,
		actorId: "",
		actorKind: "sub",
		parentId: input.parentId,
		request,
		inherited,
		profiles: loaded?.profiles ?? {},
		profileIdentities: loaded?.profileIdentities,
	});
	if (!composed.ok) return composed;
	const scope = composed.value;
	if (inherited && !isScopeNoBroader(inherited, scope)) {
		return { ok: false, error: "The requested permissions would be broader than the spawning subagent's scope." };
	}
	return { ok: true, scope: scope.restricted ? scope : undefined };
}

/**
 * Whether a child running under `settings` starts restricted: its scope is enforced and restricted,
 * or it does not decode (then the child starts with no tools but `yield`).
 */
export function permissionRestrictsStartup(settings: Settings): boolean {
	const active = activePermissionScope(settings);
	if (active === undefined) return false;
	return !active.ok || (active.scope.mode === "enforce" && active.scope.restricted);
}

function grantsMessaging(scope: DeepImmutable<PermissionScope>): boolean {
	return scope.tools === undefined || scope.tools.some(tool => permissionToolKey(tool) === MESSAGING_GRANT);
}

/** The scope's allowlist as tool names: the messaging grant is `write` (to `agent://`) and `wait`. */
function allowlistTools(tools: readonly string[]): string[] {
	return tools.flatMap(tool => (permissionToolKey(tool) === MESSAGING_GRANT ? ["write", "wait"] : [tool]));
}

/**
 * The tools a child under an enforce-restricted scope in `settings` starts with: the agent's own list
 * (or, without one, the scope's allowlist, else every built-in) and `extra` tools, cut to what the
 * scope allows. `write` stays for a scope granting messaging, which needs it for `agent://`. An empty
 * result means no tools. A scope that does not decode yields none.
 */
export function permissionStartupToolNames(
	settings: Settings,
	requested: readonly string[] | undefined,
	extra: readonly string[] = [],
): string[] {
	const active = activePermissionScope(settings);
	if (active === undefined) return [...(requested ?? [])];
	if (!active.ok) return [];
	const { scope } = active;
	const candidates = requested ?? (scope.tools ? allowlistTools(scope.tools) : [...BUILTIN_TOOL_NAMES]);
	const messaging = grantsMessaging(scope);
	return [...new Set([...candidates, ...extra])].filter(name => {
		const decision = evaluateSubagentPermission({
			scope: scope as PermissionScope,
			toolName: name,
			toolInput: {},
			cwd: settings.getCwd(),
		});
		return decision.action === "allow" || (messaging && permissionToolKey(name) === "write");
	});
}

/** What the subagent prompt's Permissions section shows. */
export interface PermissionPromptView {
	readonly enforced: boolean;
	readonly profiles: string;
	readonly tools: string;
	readonly denyTools: string;
	readonly allowPaths: string;
	readonly denyPaths: string;
	/** The agent a blocked child asks, when its scope lets it message. */
	readonly askAgent?: string;
}

function listOr(values: readonly string[], empty: string): string {
	return values.length > 0 ? values.join(", ") : empty;
}

function groupsOr(groups: readonly PathConstraintGroup[], empty: string): string {
	return groups.length > 0 ? groups.map(group => group.join(" | ")).join("; ") : empty;
}

/**
 * The Permissions section for a child under the scope in `settings`, or `undefined` when it runs
 * unscoped (or under a scope that restricts nothing).
 */
export function permissionPromptView(settings: Settings): PermissionPromptView | undefined {
	const active = activePermissionScope(settings);
	if (!active?.ok) return undefined;
	const { scope } = active;
	if (scope.mode === "off" || !scope.restricted) return undefined;
	const tools =
		scope.tools === undefined
			? "any"
			: listOr(
					scope.tools.map(tool => (permissionToolKey(tool) === MESSAGING_GRANT ? "messaging" : tool)),
					"none",
				);
	return {
		enforced: scope.mode === "enforce",
		profiles: listOr(scope.profiles, "none"),
		tools,
		denyTools: listOr(scope.denyTools, "none"),
		allowPaths: scope.pathsEnabled ? groupsOr(scope.allowPathGroups, "any") : "any",
		denyPaths: scope.pathsEnabled ? groupsOr(scope.denyPathGroups, "none") : "none",
		askAgent: grantsMessaging(scope) ? scope.parentId : undefined,
	};
}

/**
 * Whether a streamed task item must wait for dispatch instead of starting speculatively: it carries
 * a permission request, or the calling session runs under an enforce scope (or one that does not
 * decode). Dispatch composes the child's scope from the finished call.
 */
export function permissionsBlockSpeculativeLaunch(
	settings: Settings,
	spawn: { readonly permissions?: unknown; readonly toolProfile?: unknown },
): boolean {
	if (spawn.permissions !== undefined || spawn.toolProfile !== undefined) return true;
	const active = activePermissionScope(settings);
	return active !== undefined && (!active.ok || active.scope.mode === "enforce");
}
