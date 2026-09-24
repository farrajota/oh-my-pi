import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	cloneAndFreezeStartupValue,
	deriveRestrictedStartupPolicy,
	evaluateRestrictedToolGuardrails,
} from "../src/internal/restricted-startup-policy";
import { SessionPathScope } from "../src/internal/session-path-scope";
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
	test("secrets-blind denies process task and thread environment targets", () => {
		const scope = permissionScope({ guardrails: { noNetwork: false, secretsBlind: true } });
		for (const path of ["/proc/123/task/456/environ", "/proc/thread-self/environ"]) {
			expect(evaluateRestrictedToolGuardrails({ scope, toolName: "read", toolInput: { path } }).action).toBe("deny");
			expect(
				evaluateRestrictedToolGuardrails({
					scope,
					toolName: "read",
					toolInput: { path },
					canonicalFilesystemTarget: true,
				}).action,
			).toBe("deny");
		}
	});

	test("secrets-blind ignores native mutation payloads and top-level tool instructions", () => {
		const scope = permissionScope({
			tools: ["write", "edit", "ast_edit", "read", "bash", "eval"],
			guardrails: { noNetwork: false, secretsBlind: true },
		});

		for (const request of [
			{
				toolName: "write",
				toolInput: {
					i: "Document secret and credential terms in this code change.",
					path: "src/notes.ts",
					content: "Discuss credentials, secrets, /docs/.env.production, and a private_key.",
				},
			},
			{
				toolName: "edit",
				toolInput: {
					i: "Describe the secret-handling change.",
					path: "src/notes.ts",
					input: '[src/notes.ts#A1B2]\nPUT 1.=1:\n+const credential = "secret";\n',
				},
			},
			{
				toolName: "ast_edit",
				toolInput: {
					i: "Explain the credential-related syntax change.",
					paths: ["src/notes.ts"],
					ops: [{ pat: "secretValue", out: "credentialValue" }],
				},
			},
		]) {
			expect(evaluateRestrictedToolGuardrails({ scope, ...request }).action).toBe("allow");
		}

		expect(
			evaluateRestrictedToolGuardrails({
				scope,
				toolName: "write",
				toolInput: { path: "config/.env.production", content: "ordinary text" },
			}).action,
		).toBe("deny");
		expect(
			evaluateRestrictedToolGuardrails({
				scope,
				toolName: "write",
				toolInput: {
					path: "src/notes.ts",
					content: "ordinary text",
					extensionOption: "credential-bearing unknown mutation field",
				},
			}).action,
		).toBe("deny");
		expect(
			evaluateRestrictedToolGuardrails({
				scope,
				toolName: "custom_extension",
				toolInput: { payload: "credential-bearing unknown-tool request" },
			}).action,
		).toBe("deny");
		expect(
			evaluateRestrictedToolGuardrails({
				scope,
				toolName: "custom_extension",
				toolInput: { i: "credential-bearing unknown-tool instructions" },
			}).action,
		).toBe("deny");
		expect(
			evaluateRestrictedToolGuardrails({
				scope,
				toolName: "write",
				toolInput: { path: "src/notes.ts", input: "credential text in a non-native field" },
			}).action,
		).toBe("deny");
		expect(
			evaluateRestrictedToolGuardrails({
				scope,
				toolName: "write",
				toolInput: { path: "src/notes.ts", metadata: { content: "credential text in an unknown nested field" } },
			}).action,
		).toBe("deny");
	});
	test("secrets-blind exempts only native edit source text, never targets or unknown fields", () => {
		const scope = permissionScope({ guardrails: { noNetwork: false, secretsBlind: true } });
		const check = (toolInput: Record<string, unknown>) =>
			evaluateRestrictedToolGuardrails({ scope, toolName: "edit", toolInput }).action;
		const source = "credential /proc/thread-self/environ";
		expect(check({ path: "src/notes.ts", old_string: source, new_string: source })).toBe("allow");
		expect(check({ path: "src/notes.ts", edits: [{ op: "update", diff: source }] })).toBe("allow");
		expect(
			check({
				path: "src/notes.ts",
				old_string: source,
				new_string: source,
				destination: "/proc/123/task/456/environ",
			}),
		).toBe("deny");
		expect(
			check({ path: "src/notes.ts", edits: [{ op: "update", diff: source, rename: "/proc/thread-self/environ" }] }),
		).toBe("deny");
		expect(
			check({ path: "src/notes.ts", edits: [{ op: "update", diff: source, metadata: { credential: source } }] }),
		).toBe("deny");
		expect(check({ path: "/proc/123/task/456/environ", edits: [{ diff: source }] })).toBe("deny");
		expect(check({ path: "src/notes.ts", metadata: { diff: source } })).toBe("deny");
		expect(check({ path: "src/notes.ts", metadata: { old_string: source } })).toBe("deny");
		expect(
			evaluateRestrictedToolGuardrails({
				scope,
				toolName: "custom_edit",
				toolInput: { path: "src/notes.ts", old_string: source },
			}).action,
		).toBe("deny");
	});

	test("secrets-blind checks canonical filesystem targets", async () => {
		const root = await mkdtemp(join(tmpdir(), "restricted-startup-guard-target-"));
		const envPath = join(root, ".env");
		const privateKeyPath = join(root, "private_key");
		const ordinaryPath = join(root, "notes.ts");
		const envAlias = join(root, "env-alias");
		const privateKeyAlias = join(root, "key-alias");

		try {
			await writeFile(envPath, "TOKEN=secret\n");
			await writeFile(privateKeyPath, "private key\n");
			await writeFile(ordinaryPath, "export const value = 1;\n");
			await symlink(envPath, envAlias);
			await symlink(privateKeyPath, privateKeyAlias);

			const sessionPathScope = new SessionPathScope({
				actorId: () => "RestrictedStartupTest",
				sessionId: () => "restricted-startup-secret-target",
				cwd: () => root,
				permissionScope: () =>
					permissionScope({
						tools: ["read"],
						guardrails: { noNetwork: false, secretsBlind: true },
					}),
			});

			await sessionPathScope.authorizeInput("read", { path: ordinaryPath });
			for (const target of [envPath, envAlias, privateKeyPath, privateKeyAlias]) {
				await expect(sessionPathScope.authorizeInput("read", { path: target })).rejects.toThrow(/secrets-blind/);
			}
			for (const canonicalProcPath of [
				"/proc/self/environ",
				"/proc/123/environ",
				"/proc/123/task/456/environ",
				"/proc/thread-self/environ",
			]) {
				expect(() => sessionPathScope.assertPermission("read", canonicalProcPath)).toThrow(/secrets-blind/);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("scoped mutation authorization rejects canonical symlink and out-of-scope targets", async () => {
		const root = await mkdtemp(join(tmpdir(), "restricted-startup-path-scope-"));
		const allowedDirectory = join(root, "allowed");
		const outsideDirectory = join(root, "outside");
		const outsideTarget = join(outsideDirectory, "target.ts");
		const allowedAlias = join(allowedDirectory, "alias.ts");

		try {
			await mkdir(allowedDirectory);
			await mkdir(outsideDirectory);
			await writeFile(outsideTarget, "export const value = 1;\n");
			await symlink(outsideTarget, allowedAlias);

			const sessionPathScope = new SessionPathScope({
				actorId: () => "RestrictedStartupTest",
				sessionId: () => "restricted-startup-path-scope",
				cwd: () => root,
				permissionScope: () =>
					permissionScope({
						tools: ["write"],
						allowPaths: [join(allowedDirectory, "**")],
					}),
			});

			await expect(sessionPathScope.authorizeInput("write", { path: allowedAlias })).rejects.toThrow(
				/does not allow path/,
			);
			await expect(sessionPathScope.authorizeInput("write", { path: outsideTarget })).rejects.toThrow(
				/does not allow path/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
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
