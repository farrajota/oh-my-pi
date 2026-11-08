import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateSubagentPermission } from "@oh-my-pi/pi-coding-agent/task/permissions/evaluate";
import { evaluatePermissionGuardrails } from "@oh-my-pi/pi-coding-agent/task/permissions/guardrails";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";

function permissionScope(overrides: Partial<PermissionScope> = {}): PermissionScope {
	return {
		v: 2,
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "RestrictedStartupTest",
		actorKind: "sub",
		profiles: [],
		tools: ["read"],
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

describe("permission guardrails", () => {
	test("no-network denies network read, shell, eval, and MCP calls", () => {
		const scope = permissionScope({
			tools: ["read", "bash", "eval", "mcp__docs__search", "web_search"],
			guardrails: { noNetwork: true, secretsBlind: false },
		});

		for (const request of [
			{ toolName: "read", toolInput: { path: "https://example.com/data" } },
			{ toolName: "read", toolInput: { path: "localhost:8080/health" } },
			{ toolName: "bash", toolInput: { command: "curl https://example.com" } },
			{ toolName: "eval", toolInput: { code: "await fetch('https://example.com')" } },
			{ toolName: "mcp__docs__search", toolInput: { query: "guardrails" } },
		]) {
			expect(evaluatePermissionGuardrails({ scope, ...request })).toMatchObject({
				action: "deny",
				details: { code: "guardrail" },
			});
		}
		expect(evaluatePermissionGuardrails({ scope, toolName: "read", toolInput: { path: "src/a.ts" } }).action).toBe(
			"allow",
		);
	});

	test("secrets-blind denies canonical secret files and environment access", () => {
		const scope = permissionScope({
			tools: ["read", "bash", "eval"],
			guardrails: { noNetwork: false, secretsBlind: true },
		});

		for (const request of [
			{ toolName: "read", toolInput: { path: "/workspace/.env.production" } },
			{ toolName: "read", toolInput: { path: "/proc/self/environ" } },
			{ toolName: "bash", toolInput: { command: "printenv API_TOKEN" } },
			{ toolName: "eval", toolInput: { code: "process.env.API_TOKEN" } },
			{ toolName: "read", toolInput: { path: "/home/user/.ssh/private_key" } },
		]) {
			expect(evaluatePermissionGuardrails({ scope, ...request }).action).toBe("deny");
		}
	});

	test("secrets-blind denies process task and thread environment targets", () => {
		const scope = permissionScope({ guardrails: { noNetwork: false, secretsBlind: true } });
		for (const target of ["/proc/123/task/456/environ", "/proc/thread-self/environ"]) {
			expect(evaluatePermissionGuardrails({ scope, toolName: "read", toolInput: { path: target } }).action).toBe(
				"deny",
			);
			// The same target reported as a canonical filesystem target, behind an innocuous lexical path.
			expect(
				evaluateSubagentPermission({
					scope,
					toolName: "read",
					toolInput: { path: "notes.ts" },
					cwd: "/workspace",
					targets: [target],
				}),
			).toMatchObject({ action: "deny", details: { code: "guardrail" } });
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
			expect(evaluatePermissionGuardrails({ scope, ...request }).action).toBe("allow");
		}

		expect(
			evaluatePermissionGuardrails({
				scope,
				toolName: "write",
				toolInput: { path: "config/.env.production", content: "ordinary text" },
			}).action,
		).toBe("deny");
		expect(
			evaluatePermissionGuardrails({
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
			evaluatePermissionGuardrails({
				scope,
				toolName: "custom_extension",
				toolInput: { payload: "credential-bearing unknown-tool request" },
			}).action,
		).toBe("deny");
		expect(
			evaluatePermissionGuardrails({
				scope,
				toolName: "custom_extension",
				toolInput: { i: "credential-bearing unknown-tool instructions" },
			}).action,
		).toBe("deny");
		expect(
			evaluatePermissionGuardrails({
				scope,
				toolName: "write",
				toolInput: { path: "src/notes.ts", input: "credential text in a non-native field" },
			}).action,
		).toBe("deny");
		expect(
			evaluatePermissionGuardrails({
				scope,
				toolName: "write",
				toolInput: { path: "src/notes.ts", metadata: { content: "credential text in an unknown nested field" } },
			}).action,
		).toBe("deny");
	});

	test("secrets-blind exempts only native edit source text, never targets or unknown fields", () => {
		const scope = permissionScope({ guardrails: { noNetwork: false, secretsBlind: true } });
		const check = (toolInput: Record<string, unknown>) =>
			evaluatePermissionGuardrails({ scope, toolName: "edit", toolInput }).action;
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
			evaluatePermissionGuardrails({
				scope,
				toolName: "custom_edit",
				toolInput: { path: "src/notes.ts", old_string: source },
			}).action,
		).toBe("deny");
	});

	test("guardrails are advisory in suggest mode (P1)", () => {
		const scope = permissionScope({ mode: "suggest", guardrails: { noNetwork: true, secretsBlind: true } });
		expect(
			evaluatePermissionGuardrails({ scope, toolName: "read", toolInput: { path: "/workspace/.env" } }).action,
		).toBe("allow");
		expect(
			evaluatePermissionGuardrails({ scope, toolName: "read", toolInput: { path: "https://example.com" } }).action,
		).toBe("allow");
	});

	test("secrets-blind checks canonical filesystem targets", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "restricted-startup-guard-target-"));
		const envPath = path.join(root, ".env");
		const privateKeyPath = path.join(root, "private_key");
		const ordinaryPath = path.join(root, "notes.ts");
		const envAlias = path.join(root, "env-alias");
		const privateKeyAlias = path.join(root, "key-alias");

		try {
			await Bun.write(envPath, "TOKEN=fixture\n");
			await Bun.write(privateKeyPath, "fixture key\n");
			await Bun.write(ordinaryPath, "export const value = 1;\n");
			await fs.symlink(envPath, envAlias);
			await fs.symlink(privateKeyPath, privateKeyAlias);
			const scope = permissionScope({
				tools: ["read"],
				guardrails: { noNetwork: false, secretsBlind: true },
			});
			// The approval layer passes realpath-resolved targets; the evaluator judges whatever it is given.
			const readThrough = async (target: string) =>
				evaluateSubagentPermission({
					scope,
					toolName: "read",
					toolInput: { path: target },
					cwd: root,
					targets: [await fs.realpath(target)],
				});

			expect((await readThrough(ordinaryPath)).action).toBe("allow");
			for (const target of [envPath, envAlias, privateKeyPath, privateKeyAlias]) {
				const decision = await readThrough(target);
				expect(decision.action).toBe("deny");
				expect(decision.reason).toContain("secrets-blind");
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("scoped mutation rejects canonical symlink and out-of-scope targets", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "restricted-startup-path-scope-"));
		const allowedDirectory = path.join(root, "allowed");
		const outsideDirectory = path.join(root, "outside");
		const outsideTarget = path.join(outsideDirectory, "target.ts");
		const allowedAlias = path.join(allowedDirectory, "alias.ts");

		try {
			await fs.mkdir(allowedDirectory);
			await Bun.write(outsideTarget, "export const value = 1;\n");
			await fs.symlink(outsideTarget, allowedAlias);
			const scope = permissionScope({
				tools: ["write"],
				allowPathGroups: [[path.join(allowedDirectory, "**")]],
			});
			const writeThrough = async (target: string) =>
				evaluateSubagentPermission({
					scope,
					toolName: "write",
					toolInput: { path: target },
					cwd: root,
					targets: [await fs.realpath(target)],
				});

			for (const target of [allowedAlias, outsideTarget]) {
				const decision = await writeThrough(target);
				expect(decision.details?.code).toBe("path-not-allowed");
				expect(decision.reason).toContain("does not allow path");
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("keeps Linux path globs case-sensitive", () => {
		if (process.platform !== "linux") return;
		const scope = permissionScope({ tools: ["read"], allowPathGroups: [["src/**"]] });
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
});
