/**
 * Approval guards: a restriction that denies a call outright, whatever the mode, a policy, or a
 * remembered grant says. The subagent permission scope is the guard `approvalRestrictions` builds.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import {
	type ApprovalGuard,
	type ApprovalMode,
	type ApprovalRestrictions,
	denyError,
	resolveApproval,
	sessionApprovalScope,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import { type ApprovalGrantStore, approvalGrantKey } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";

const MODES: readonly ApprovalMode[] = ["always-ask", "always-ask-cached", "write", "yolo"];
const REASON = "BLOCKED: Subagent permission profile does not allow tool 'probe'.";

function tool(approval: ToolApprovalDecision, targets?: string[]): AgentTool {
	return {
		name: "probe",
		label: "probe",
		description: "probe tool",
		parameters: {} as never,
		approval,
		...(targets ? { approvalCacheTargets: () => targets } : {}),
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

/** A guard that denies every call and records what it was asked about. */
function denyingGuard(): ApprovalGuard & { calls: Array<{ tool: string; tier: string; policyKey?: string }> } {
	const calls: Array<{ tool: string; tier: string; policyKey?: string }> = [];
	return {
		calls,
		check(subject, _args, call) {
			calls.push({ tool: subject.name, tier: call.tier, ...(call.policyKey ? { policyKey: call.policyKey } : {}) });
			return { reason: REASON };
		},
	};
}

function restrictedBy(guard: ApprovalGuard, restrictedFolders: string[] = []): ApprovalRestrictions {
	return { restrictedFolders, cwd: "/repo", guards: [guard] };
}

const presentGrants = (keys: string[]): ApprovalGrantStore => ({
	present: candidates => new Set(candidates.filter(key => keys.includes(key))),
});

describe("approval guard", () => {
	it("denies with source permission in every mode, never as a prompt", () => {
		for (const mode of MODES) {
			for (const tier of ["read", "write", "exec"] as const) {
				expect(resolveApproval(tool(tier), {}, mode, {}, undefined, restrictedBy(denyingGuard()))).toEqual({
					policy: "deny",
					tier,
					override: false,
					source: "permission",
					reason: REASON,
				});
			}
		}
	});

	it("outranks a tool allow policy, a user allow policy, a cached grant and yolo", () => {
		const toolAllow = tool({ tier: "exec", policy: "allow" });
		const userAllowed = { probe: "allow" };
		const grantedTarget = "/repo/src/a.ts";
		const grants = presentGrants([approvalGrantKey("write", grantedTarget)]);
		const cases: Array<[string, ApprovalMode, AgentTool, Record<string, unknown>]> = [
			["tool allow", "always-ask", toolAllow, {}],
			["user allow", "always-ask", tool("exec"), userAllowed],
			["cached grant", "always-ask-cached", tool("write", [grantedTarget]), {}],
			["yolo", "yolo", tool("exec"), {}],
		];
		for (const [label, mode, subject, userPolicies] of cases) {
			const unguarded = resolveApproval(subject, {}, mode, userPolicies, grants);
			expect({ label, policy: unguarded.policy }).toEqual({ label, policy: "allow" });
			const guarded = resolveApproval(subject, {}, mode, userPolicies, grants, restrictedBy(denyingGuard()));
			expect({ label, policy: guarded.policy, source: guarded.source }).toEqual({
				label,
				policy: "deny",
				source: "permission",
			});
		}
	});

	it("keeps a tool or user deny attributed to its own source", () => {
		const toolDeny = resolveApproval(
			tool({ tier: "write", policy: "deny", reason: "read-only target" }),
			{},
			"yolo",
			{},
			undefined,
			restrictedBy(denyingGuard()),
		);
		expect(toolDeny).toMatchObject({ policy: "deny", source: "tool", reason: "read-only target" });

		const userDeny = resolveApproval(
			tool("read"),
			{},
			"yolo",
			{ probe: "deny" },
			undefined,
			restrictedBy(denyingGuard()),
		);
		expect(userDeny).toMatchObject({ policy: "deny", source: "user", policyKey: "probe" });
	});

	it("denies where a restricted folder would only have asked", () => {
		const resolved = resolveApproval(
			tool("read", ["/repo/vault/key.pem"]),
			{},
			"yolo",
			{},
			undefined,
			restrictedBy(denyingGuard(), ["vault"]),
		);
		expect(resolved).toMatchObject({ policy: "deny", source: "permission", reason: REASON });
	});

	it("lets the call resolve normally when every guard passes", () => {
		const passing: ApprovalGuard = { check: () => undefined };
		expect(
			resolveApproval(tool("exec"), {}, "always-ask", {}, undefined, { restrictedFolders: [], guards: [passing] }),
		).toEqual({ policy: "prompt", tier: "exec", override: false, source: "mode" });
	});

	it("tells the guard the resolved tier and the keyed sub-tool of an xd:// dispatch", () => {
		const guard = denyingGuard();
		resolveApproval(tool({ tier: "write", policyKey: "xd_device" }), {}, "write", {}, undefined, restrictedBy(guard));
		expect(guard.calls).toEqual([{ tool: "probe", tier: "write", policyKey: "xd_device" }]);
	});

	it("reports the guard's reason as the error and is never session-grantable", () => {
		const resolved = resolveApproval(tool("exec"), {}, "always-ask", {}, undefined, restrictedBy(denyingGuard()));
		expect(denyError(resolved, "probe").message).toBe(REASON);
		expect(sessionApprovalScope(resolved, "probe")).toBeUndefined();
	});
});
