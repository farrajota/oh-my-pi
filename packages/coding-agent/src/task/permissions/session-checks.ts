/**
 * Checks of the session's subagent permission scope for effects that do not pass through one
 * approval resolve: spawning a subagent outside the `task` tool, the entries a recursive search
 * finds below the root the guard checked, and the file an internal URL resolves to.
 */
import * as path from "node:path";
import type { Settings } from "../../config/settings";
import { approvalCacheKeyForPath } from "../../tools/approval-cache";
import { evaluateInternalUrlFile, evaluatePermissionPath } from "./evaluate";
import { activePermissionScope, permissionApprovalGuard, unreadableScopeReason } from "./guard";
import { hasPathRules } from "./path-rules";

/**
 * Why the session's scope refuses to spawn a subagent, or `undefined`. A spawn through eval
 * `agent()` or `workpool()` is delegation exactly like a `task` call, so it needs the same grant
 * (`no-delegation` denies it; an allowlist must name `task`).
 */
export function permissionDelegationRefusal(settings: Settings, cwd: string): string | undefined {
	return permissionApprovalGuard(settings, cwd)?.check({ name: "task" }, {}, { tier: "exec" })?.reason;
}

/**
 * Which entries a recursive search (grep, glob, find, ast_grep) may report under the session's scope,
 * or `undefined` when the scope filters nothing. The approval guard sees only the search root; this
 * drops each found entry the deny paths, the allowlist or secrets-blind would refuse. An entry is
 * checked as found and, when it is a host path, by its real path too. A scope that does not decode
 * keeps nothing.
 */
export function permissionResultFilter(
	settings: Settings,
	cwd: string,
	toolName: string,
): ((entry: string) => boolean) | undefined {
	const active = activePermissionScope(settings);
	if (active === undefined) return undefined;
	if (!active.ok) return () => false;
	const { scope } = active;
	if (scope.mode !== "enforce" || !(hasPathRules(scope) || scope.guardrails.secretsBlind)) return undefined;
	const canonicalCwd = approvalCacheKeyForPath(cwd);
	return entry => {
		if (evaluatePermissionPath({ scope, toolName, path: entry, cwd }).action === "deny") return false;
		if (!path.isAbsolute(entry)) return true;
		const real = approvalCacheKeyForPath(entry);
		return (
			real === entry || evaluatePermissionPath({ scope, toolName, path: real, cwd: canonicalCwd }).action === "allow"
		);
	};
}

/**
 * Why the session's scope refuses `file`, the file the internal URL `url` resolved to, or `undefined`.
 * The approval guard sees only the URL; this applies the path rules and secrets-blind to the file
 * behind it (P7), as named and by its real path.
 */
export function internalUrlFileRefusal(
	settings: Settings | undefined,
	cwd: string | undefined,
	url: string,
	file: string,
): string | undefined {
	if (!settings) return undefined;
	const active = activePermissionScope(settings);
	if (active === undefined) return undefined;
	if (!active.ok) return unreadableScopeReason(active.error);
	const { scope } = active;
	if (scope.mode !== "enforce" || !(hasPathRules(scope) || scope.guardrails.secretsBlind)) return undefined;
	const base = cwd ?? settings.getCwd();
	const named = evaluateInternalUrlFile({ scope, url, path: file, cwd: base });
	if (named.action === "deny") return named.reason;
	const real = approvalCacheKeyForPath(file);
	if (real === file) return undefined;
	const resolved = evaluateInternalUrlFile({ scope, url, path: real, cwd: approvalCacheKeyForPath(base) });
	return resolved.action === "deny" ? resolved.reason : undefined;
}

/**
 * Whether a child running under `settings` must start without its parent's extension and custom-tool
 * code: its scope is enforce-restricted, or does not decode. Extension handlers run unconstrained by
 * the scope's tool rules, and custom tool modules execute as they load.
 */
export function permissionWithholdsExtensionCode(settings: Settings): boolean {
	const active = activePermissionScope(settings);
	if (active === undefined) return false;
	return !active.ok || (active.scope.mode === "enforce" && active.scope.restricted);
}
