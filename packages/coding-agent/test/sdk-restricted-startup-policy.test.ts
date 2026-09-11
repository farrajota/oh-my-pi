import { describe, expect, test } from "bun:test";
import {
	cloneAndFreezeStartupValue,
	deriveRestrictedStartupPolicy,
	evaluateRestrictedToolGuardrails,
} from "../src/internal/restricted-startup-policy";
import { evaluateSubagentPermission } from "../src/task/permission-profiles";
import type { EffectiveSubagentPermissions } from "../src/task/permission-profiles";

function permissionScope(overrides: Partial<EffectiveSubagentPermissions> = {}): EffectiveSubagentPermissions {
	return {
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "RestrictedStartupTest",
		actorKind: "sub",
		profiles: [],
		tools: ["read"],
		denyTools: [],
		allowPaths: [],
		denyPaths: [],
		guardrails: { noNetwork: false, secretsBlind: false },
		...overrides,
	};
}

describe("restricted startup policy", () => {
	test("treats a compiled scope as restricted and leaves no ambient startup surfaces", () => {
		const policy = deriveRestrictedStartupPolicy({
			permissionScope: permissionScope({ tools: undefined }),
			enableMCP: true,
			enableLsp: true,
		});

		expect(policy).toEqual(
			expect.objectContaining({
				restricted: true,
				zeroTools: true,
				toolNames: [],
				allowExtensions: false,
				allowCustomTools: false,
				allowProviderDiscovery: false,
				enableMCP: false,
				enableLsp: false,
				hasPathConstraints: false,
				lspReadOnly: true,
			}),
		);
		expect(Object.isFrozen(policy)).toBe(true);
		expect(Object.isFrozen(policy.toolNames)).toBe(true);
	});

	test("no-network removes ambient routes and denies network read, shell, eval, and MCP calls", () => {
		const scope = permissionScope({
			tools: ["read", "bash", "eval", "mcp__docs__search", "web_search"],
			guardrails: { noNetwork: true, secretsBlind: false },
		});
		const policy = deriveRestrictedStartupPolicy({
			permissionScope: scope,
			toolNames: scope.tools,
			allowRestrictedCustomTools: true,
			enableMCP: true,
		});

		expect(policy.toolNames).toEqual(["read"]);
		expect(policy.hasPathConstraints).toBe(false);
		expect(policy.enableMCP).toBe(false);
		expect(policy.enableLsp).toBe(false);
		expect(policy.allowProviderDiscovery).toBe(false);
		expect(policy.allowCustomTools).toBe(false);

		for (const request of [
			{ toolName: "read", toolInput: { path: "https://example.com/data" } },
			{ toolName: "bash", toolInput: { command: "curl https://example.com" } },
			{ toolName: "eval", toolInput: { code: "await fetch('https://example.com')" } },
			{ toolName: "mcp__docs__search", toolInput: { query: "guardrails" } },
		]) {
			expect(evaluateRestrictedToolGuardrails({ scope, ...request }).action).toBe("deny");
		}
	});

	test("secrets-blind denies canonical secret files and environment access", () => {
		const scope = permissionScope({
			tools: ["read", "bash", "eval"],
			guardrails: { noNetwork: false, secretsBlind: true },
		});

		const policy = deriveRestrictedStartupPolicy({
			permissionScope: scope,
			toolNames: scope.tools,
			allowRestrictedCustomTools: true,
			enableMCP: true,
			enableLsp: true,
		});
		expect(policy.toolNames).toEqual(["read"]);
		expect(policy.enableMCP).toBe(false);
		expect(policy.enableLsp).toBe(false);
		expect(policy.allowCustomTools).toBe(false);
		for (const request of [
			{ toolName: "read", toolInput: { path: "/workspace/.env.production" } },
			{ toolName: "read", toolInput: { path: "/proc/self/environ" } },
			{ toolName: "bash", toolInput: { command: "printenv API_TOKEN" } },
			{ toolName: "eval", toolInput: { code: "process.env.API_TOKEN" } },
			{ toolName: "read", toolInput: { path: "/home/user/.ssh/private_key" } },
		]) {
			expect(evaluateRestrictedToolGuardrails({ scope, ...request }).action).toBe("deny");
		}
	});
	test("disables LSP when path constraints prevent exhaustive target proof", () => {
		const mutable = deriveRestrictedStartupPolicy({
			permissionScope: permissionScope({ tools: ["lsp", "edit"], allowPaths: ["src/**"] }),
			toolNames: ["lsp", "edit"],
			enableLsp: true,
		});
		const pathDenied = deriveRestrictedStartupPolicy({
			permissionScope: permissionScope({ tools: ["lsp", "edit"], denyPaths: ["**"] }),
			toolNames: ["lsp", "edit"],
			enableLsp: true,
		});

		expect(mutable.hasPathConstraints).toBe(true);
		expect(mutable.enableLsp).toBe(false);
		expect(mutable.lspReadOnly).toBe(true);
		expect(pathDenied.hasPathConstraints).toBe(true);
		expect(pathDenied.enableLsp).toBe(false);
		expect(pathDenied.lspReadOnly).toBe(true);
	});

	test("keeps Linux path globs case-sensitive", () => {
		if (process.platform !== "linux") return;
		const scope = permissionScope({ tools: ["read"], allowPaths: ["src/**"] });
		expect(
			evaluateSubagentPermission({
				scope,
				toolName: "read",
				toolInput: { path: "src/task/allowed.ts" },
				cwd: "/workspace",
			}).action,
		).toBe("allow");
		expect(
			evaluateSubagentPermission({
				scope,
				toolName: "read",
				toolInput: { path: "SRC/task/secret.ts" },
				cwd: "/workspace",
			}).action,
		).toBe("deny");
	});

	test("deep-clones and freezes startup metadata without retaining mutable aliases", () => {
		const source = {
			model: { provider: "test", id: "model-a" },
			fallbacks: [{ provider: "test", id: "model-b" }],
			schema: { type: "object", properties: { answer: { type: "string" } } },
		};
		const snapshot = cloneAndFreezeStartupValue(source);

		source.model.id = "mutated";
		source.fallbacks[0]!.id = "mutated";
		source.schema.properties.answer.type = "number";

		expect(snapshot).toEqual({
			model: { provider: "test", id: "model-a" },
			fallbacks: [{ provider: "test", id: "model-b" }],
			schema: { type: "object", properties: { answer: { type: "string" } } },
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.model)).toBe(true);
		expect(Object.isFrozen(snapshot.fallbacks)).toBe(true);
		expect(Object.isFrozen(snapshot.schema.properties.answer)).toBe(true);
	});
});
