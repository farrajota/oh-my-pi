/**
 * The approval guard of the subagent permission scope a session runs under.
 *
 * `approvalRestrictions` asks {@link permissionApprovalGuard} for it, so every site that resolves
 * approval through `resolveApproval` denies what the scope does not allow.
 */
import * as path from "node:path";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { ApprovalGuard, ApprovalSubject } from "../../tools/approval";
import { approvalCacheKeyForPath } from "../../tools/approval-cache";
import { approvalTargetKey, approvalTreeSearchFolderKey } from "../../tools/approval-targets";
import { evaluatePermissionPath, evaluateSubagentPermission, permissionPathArguments } from "./evaluate";
import { hasPathRules } from "./path-rules";
import { cfgTaskPermissionsActiveScope } from "./settings";
import { decodePermissionScope } from "./snapshot";
import type { DeepImmutable, PermissionScope } from "./types";

type ActiveScope =
	| { readonly ok: true; readonly scope: DeepImmutable<PermissionScope> }
	| { readonly ok: false; readonly error: string };

/** Decoded scopes kept: one per distinct encoded string, because the guard runs several times per call. */
const DECODED_SCOPE_LIMIT = 32;
const decodedScopes = new Map<string, ActiveScope>();

function decodeActiveScope(text: string): ActiveScope {
	const cached = decodedScopes.get(text);
	if (cached) return cached;
	const read = decodePermissionScope(text);
	const decoded: ActiveScope = read.ok ? { ok: true, scope: read.snapshot.scope } : { ok: false, error: read.error };
	if (!decoded.ok) {
		logger.error("Subagent permission scope is unreadable; every tool but yield is denied", { error: decoded.error });
	}
	if (decodedScopes.size >= DECODED_SCOPE_LIMIT) {
		const oldest = decodedScopes.keys().next();
		if (!oldest.done) decodedScopes.delete(oldest.value);
	}
	decodedScopes.set(text, decoded);
	return decoded;
}

/**
 * The guard for the scope in `settings`, or `undefined` when the session runs without one.
 *
 * Only a runtime override of `task.permissions.activeScope` counts: a subagent spawn writes it into
 * the child's settings overlay, and a child spawned without a scope of its own reads its parent's
 * through. A value from a config file is ignored. A scope outside `enforce` builds no guard (suggest
 * is advisory). A value that does not decode to a verified scope denies every tool but `yield`.
 */
export function permissionApprovalGuard(settings: Settings, cwd: string): ApprovalGuard | undefined {
	if (settings.getProvenance(cfgTaskPermissionsActiveScope) !== "runtime") return undefined;
	const active = decodeActiveScope(cfgTaskPermissionsActiveScope.get(settings) ?? "");
	if (!active.ok) return unreadableScopeGuard(active.error);
	if (active.scope.mode !== "enforce") return undefined;
	return scopeGuard(active.scope, cwd);
}

function unreadableScopeGuard(error: string): ApprovalGuard {
	return {
		check: tool =>
			tool.name === "yield"
				? undefined
				: { reason: `BLOCKED: Subagent permission scope is unreadable (${error}); only yield is allowed.` },
	};
}

function scopeGuard(scope: DeepImmutable<PermissionScope>, cwd: string): ApprovalGuard {
	// Path rules and secrets-blind also see each target's real path; nothing else needs it.
	const checksTargets = hasPathRules(scope) || scope.guardrails.secretsBlind;
	return {
		check(tool, args) {
			const toolInput = isRecord(args) ? args : {};
			const decision = evaluateSubagentPermission({ scope, toolName: tool.name, toolInput, cwd });
			if (decision.action === "deny") return { reason: decision.reason };
			if (!checksTargets) return undefined;
			// Canonical targets resolve symlinks, so relative rules resolve against the real cwd too.
			const canonicalCwd = approvalCacheKeyForPath(cwd);
			for (const target of canonicalTargets(tool, args, toolInput, cwd)) {
				const pathDecision = evaluatePermissionPath({
					scope,
					toolName: tool.name,
					path: target,
					cwd: canonicalCwd,
				});
				if (pathDecision.action === "deny") return { reason: pathDecision.reason };
			}
			return undefined;
		},
	};
}

/**
 * The real paths a call touches. Approval cache targets are canonical already (symlinks resolved,
 * internal URLs normalized); a recursive search's tree key stands for its folder. Paths a tool binds
 * for restriction (task files) are resolved here, and so are the path arguments of a tool that
 * reports no cache targets.
 */
function canonicalTargets(
	tool: ApprovalSubject,
	args: unknown,
	toolInput: Record<string, unknown>,
	cwd: string,
): string[] {
	const targets: string[] = [];
	const cacheTargets = (tool.approvalCacheTargets?.(args) ?? []).filter(
		target => typeof target === "string" && target.length > 0,
	);
	for (const target of cacheTargets) {
		const key = approvalTreeSearchFolderKey(target) ?? target;
		targets.push(path.isAbsolute(key) ? withoutTrailingSeparator(key) : key);
	}
	for (const target of tool.approvalRestrictionPaths?.(args) ?? []) {
		if (path.isAbsolute(target)) targets.push(approvalCacheKeyForPath(target));
	}
	if (cacheTargets.length === 0) {
		for (const value of permissionPathArguments(toolInput)) {
			const key = approvalTargetKey(cwd, value);
			if (key !== undefined) targets.push(key);
		}
	}
	return targets;
}

function withoutTrailingSeparator(target: string): string {
	return path.parse(target).root === target ? target : target.replace(/[\\/]+$/, "");
}
