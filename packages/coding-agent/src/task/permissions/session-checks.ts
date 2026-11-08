/**
 * Checks of the session's subagent permission scope for effects that do not pass through one
 * approval resolve: spawning a subagent outside the `task` tool, and the entries a recursive search
 * finds below the root the guard checked.
 */
import * as path from "node:path";
import type { Settings } from "../../config/settings";
import { approvalCacheKeyForPath } from "../../tools/approval-cache";
import { evaluatePermissionPath } from "./evaluate";
import { activePermissionScope, permissionApprovalGuard } from "./guard";
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
