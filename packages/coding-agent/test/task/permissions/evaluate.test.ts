import { describe, expect, test } from "bun:test";
import {
	evaluatePermissionPath,
	evaluateSubagentPermission,
	hasUnprovableEffects,
} from "@oh-my-pi/pi-coding-agent/task/permissions/evaluate";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";

const CWD = "/repo";

function scope(overrides: Partial<PermissionScope> = {}): PermissionScope {
	return {
		v: 2,
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "EvaluateTest",
		actorKind: "sub",
		profiles: [],
		denyTools: [],
		allowPathGroups: [],
		denyPathGroups: [],
		guardrails: { noNetwork: false, secretsBlind: false },
		restricted: true,
		inherited: false,
		provenance: { profiles: [] },
		...overrides,
	};
}

function check(target: PermissionScope, toolName: string, toolInput: Record<string, unknown> = {}, targets?: string[]) {
	return evaluateSubagentPermission({ scope: target, toolName, toolInput, cwd: CWD, targets });
}

describe("unprovable effects (C29)", () => {
	const tools = ["read", "bash", "eval", "lsp", "mcp__docs__search", "custom_extension_tool", "vibe_spawn"];
	const unprovableScopes: Array<[string, PermissionScope]> = [
		["an allow path", scope({ tools, allowPathGroups: [["src/**"]] })],
		["a deny path", scope({ tools, denyPathGroups: [["vault/**"]] })],
		["no-network", scope({ tools, guardrails: { noNetwork: true, secretsBlind: false } })],
		["secrets-blind", scope({ tools, guardrails: { noNetwork: false, secretsBlind: true } })],
	];

	for (const [label, restricted] of unprovableScopes) {
		test(`a scope with ${label} denies tools whose effects cannot be checked by path`, () => {
			expect(hasUnprovableEffects(restricted)).toBe(true);
			for (const tool of ["bash", "eval", "lsp", "mcp__docs__search", "custom_extension_tool", "vibe_spawn"]) {
				expect(check(restricted, tool)).toMatchObject({
					action: "deny",
					reason: `BLOCKED: Subagent permission scope cannot verify the effects of tool '${tool}' while path rules or guardrails apply.`,
					matched: "guardrail:unprovable-effect",
					details: { code: "guardrail", tool },
				});
			}
			expect(check(restricted, "read", { path: "src/a.ts" }).action).toBe("allow");
		});
	}

	test("a scope without path rules or guardrails keeps every listed tool", () => {
		const open = scope({ tools });
		expect(hasUnprovableEffects(open)).toBe(false);
		for (const tool of tools) expect(check(open, tool).action).toBe("allow");
	});

	test("path rules disabled by settings do not make effects unprovable", () => {
		const disabled = scope({ tools, pathsEnabled: false, allowPathGroups: [["src/**"]] });
		expect(hasUnprovableEffects(disabled)).toBe(false);
		expect(check(disabled, "bash", { command: "ls" }).action).toBe("allow");
		expect(check(disabled, "read", { path: "docs/a.md" }).action).toBe("allow");
	});

	test("no-network also removes network tools that are otherwise allowed", () => {
		const offline = scope({
			tools: ["read", "github", "web_search", "browser", "computer", "generate_image"],
			guardrails: { noNetwork: true, secretsBlind: false },
		});
		for (const tool of ["github", "web_search"]) {
			expect(check(offline, tool)).toMatchObject({ action: "deny", details: { code: "guardrail" } });
		}
		expect(check(offline, "read", { path: "README.md" }).action).toBe("allow");
	});

	test("suggest mode is advisory and denies nothing (P1)", () => {
		const advisory = scope({
			mode: "suggest",
			tools: ["read"],
			denyTools: ["bash"],
			allowPathGroups: [["src/**"]],
			guardrails: { noNetwork: true, secretsBlind: true },
		});
		for (const [tool, input] of [
			["bash", { command: "printenv TOKEN" }],
			["write", { path: "/elsewhere/.env" }],
			["web_search", { query: "x" }],
		] as const) {
			expect(check(advisory, tool, input).action).toBe("allow");
		}
	});
});

describe("write as a transport", () => {
	const readOnly = scope({ tools: ["read"], allowPathGroups: [["src/**"]] });
	const messaging = scope({ tools: ["read", "hub"], allowPathGroups: [["src/**"]] });

	test("write without a write grant reaches local:// and xd:// targets only", () => {
		expect(check(readOnly, "write", { path: "local://notes/plan.md" }).action).toBe("allow");
		expect(check(readOnly, "write", { path: "xd://clipboard/text" }).action).toBe("allow");
		for (const target of ["src/a.ts", "/repo/src/a.ts", "agent://Main"]) {
			expect(check(readOnly, "write", { path: target })).toMatchObject({
				action: "deny",
				reason: "BLOCKED: Subagent permission profile does not allow tool 'write'.",
				details: { code: "tool-not-allowed" },
			});
		}
	});

	test("agent:// targets need the messaging grant", () => {
		expect(check(messaging, "write", { path: "agent://Main" }).action).toBe("allow");
		expect(check(messaging, "write", { path: "AGENT://Main/notes" }).action).toBe("allow");
	});

	test("a filesystem target among internal ones is still a filesystem write", () => {
		expect(check(messaging, "write", { path: "local://a.md" }, ["/repo/src/a.ts"]).details?.code).toBe(
			"tool-not-allowed",
		);
		expect(check(messaging, "write", {}).details?.code).toBe("tool-not-allowed");
	});

	test("with a write grant, internal transport targets skip filesystem path rules", () => {
		const writer = scope({ tools: ["read", "write"], allowPathGroups: [["src/**"]] });
		expect(check(writer, "write", { path: "local://a.md" }).action).toBe("allow");
		expect(check(writer, "write", { path: "agent://Main" }).action).toBe("allow");
		expect(check(writer, "write", { path: "src/a.ts" }).action).toBe("allow");
		expect(check(writer, "write", { path: "docs/a.md" }).details?.code).toBe("path-not-allowed");
		// Only writes are transports: reading another agent's output keeps the filesystem rules.
		expect(check(writer, "read", { path: "agent://Other" }).details?.code).toBe("path-not-allowed");
	});
});

describe("path targets", () => {
	test("extra canonical targets must satisfy deny and allow rules like lexical ones", () => {
		const scoped = scope({ tools: ["read"], allowPathGroups: [["/repo/src/**"]], denyPathGroups: [["**/vault/**"]] });
		expect(check(scoped, "read", { path: "src/link.ts" }, ["/repo/src/real.ts"]).action).toBe("allow");
		expect(check(scoped, "read", { path: "src/link.ts" }, ["/outside/real.ts"])).toMatchObject({
			action: "deny",
			details: { code: "path-not-allowed", targets: ["/outside/real.ts"] },
		});
		expect(check(scoped, "read", { path: "src/link.ts" }, ["/repo/src/vault/key.ts"]).details?.code).toBe(
			"path-deny",
		);
	});

	test("a single path is checked by the same rules a tool call uses", () => {
		const scoped = scope({
			tools: ["grep"],
			allowPathGroups: [["src/**"]],
			guardrails: { noNetwork: false, secretsBlind: true },
		});
		expect(evaluatePermissionPath({ scope: scoped, toolName: "grep", path: "/repo/src/a.ts", cwd: CWD }).action).toBe(
			"allow",
		);
		expect(
			evaluatePermissionPath({ scope: scoped, toolName: "grep", path: "/repo/src/.env", cwd: CWD }).details?.code,
		).toBe("guardrail");
		expect(
			evaluatePermissionPath({ scope: scoped, toolName: "grep", path: "/repo/docs/a.md", cwd: CWD }).details?.code,
		).toBe("path-not-allowed");
		expect(
			evaluatePermissionPath({ scope: undefined, toolName: "grep", path: "/repo/src/.env", cwd: CWD }).action,
		).toBe("allow");
	});
});
