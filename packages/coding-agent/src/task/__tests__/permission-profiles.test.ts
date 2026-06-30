import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BUILTIN_PERMISSION_PROFILES,
	composeEffectivePermissions,
	type EffectiveSubagentPermissions,
	evaluateSubagentPermission,
	loadPermissionProfiles,
	type PermissionProfile,
	type SubagentPermissionMode,
	type TaskPermissionRequest,
} from "../permission-profiles";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempCwd(): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "omp-permission-profiles-"));
	tempRoots.push(cwd);
	return cwd;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function enforceScope(input: {
	profiles?: string[];
	request?: TaskPermissionRequest;
	profilesMap?: Record<string, PermissionProfile>;
	mode?: SubagentPermissionMode;
	inherited?: EffectiveSubagentPermissions;
}): EffectiveSubagentPermissions {
	const request = input.request ?? (input.profiles ? { profiles: input.profiles } : undefined);
	const result = composeEffectivePermissions({
		mode: input.mode ?? "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "tester",
		actorKind: "sub",
		request,
		inherited: input.inherited,
		profiles: input.profilesMap ?? BUILTIN_PERMISSION_PROFILES,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

function evaluate(
	scope: EffectiveSubagentPermissions,
	toolName: string,
	toolInput: Record<string, unknown>,
	cwd: string,
) {
	return evaluateSubagentPermission({ scope, toolName, toolInput, cwd });
}

describe("permission profile loading", () => {
	test("loads built-in profiles when no config files exist", async () => {
		const cwd = await tempCwd();
		const loaded = await loadPermissionProfiles(cwd);

		expect(loaded.errors).toEqual([]);
		expect(Object.keys(loaded.profiles).sort()).toEqual(Object.keys(BUILTIN_PERMISSION_PROFILES).sort());
		expect(loaded.profiles["read-only"]?.tools).toContain("read");
		expect(loaded.profiles["read-only"]?.denyTools).toBeUndefined();
		expect(loaded.summaries.find(summary => summary.name === "focused-edit")?.source).toBe("built-in");
	});

	test("project profiles override built-ins and local profiles override project", async () => {
		const cwd = await tempCwd();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"read-only": {
					description: "Project read profile",
					useWhen: "Project override",
					tools: ["read"],
				},
				custom: {
					description: "Project custom",
					denyTools: ["bash"],
				},
			},
		});
		await writeJson(path.join(cwd, ".omp", "permissions.local.json"), {
			profiles: {
				custom: {
					description: "Local custom",
					tools: ["search"],
				},
			},
		});

		const loaded = await loadPermissionProfiles(cwd);

		expect(loaded.errors).toEqual([]);
		expect(loaded.profiles["read-only"]?.description).toBe("Project read profile");
		expect(loaded.profiles["read-only"]?.tools).toEqual(["read"]);
		expect(loaded.profiles.custom?.description).toBe("Local custom");
		expect(loaded.profiles.custom?.tools).toEqual(["search"]);
		expect(loaded.summaries.find(summary => summary.name === "read-only")?.source).toBe("project");
		expect(loaded.summaries.find(summary => summary.name === "custom")?.source).toBe("local");
	});

	test("parse errors are reported while built-ins remain available", async () => {
		const cwd = await tempCwd();
		await mkdir(path.join(cwd, ".omp"), { recursive: true });
		await writeFile(path.join(cwd, ".omp", "permissions.json"), "{ not json", "utf8");

		const loaded = await loadPermissionProfiles(cwd);

		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toContain(".omp/permissions.json");
		expect(loaded.profiles["read-only"]?.tools).toContain("read");
		expect(loaded.profiles["read-only"]?.denyTools).toBeUndefined();
		expect(loaded.profiles["focused-edit"]?.tools).toContain("edit");
	});
});

describe("permission profile composition and evaluation", () => {
	test("focused-edit and no-network union allows and denies with browser denied", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({ profiles: ["focused-edit", "no-network"] });

		expect(scope.tools).toEqual(expect.arrayContaining(["read", "edit", "write"]));
		expect(scope.denyTools).toEqual(expect.arrayContaining(["browser", "web_search"]));
		expect(evaluate(scope, "browser", {}, cwd)).toMatchObject({
			action: "deny",
			reason: "BLOCKED: Subagent permission profile denied tool 'browser'.",
			matched: "subagent:tool-deny:browser",
		});
	});

	test("modifier-only profiles require an allowlist in enforce mode", () => {
		const result = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "tester",
			actorKind: "sub",
			request: { profiles: ["no-network"] },
			profiles: BUILTIN_PERMISSION_PROFILES,
		});

		expect(result).toEqual({
			ok: false,
			error: "Subagent tool permissions require a concrete allowlist. Add permissions.tools or at least one role profile with tools; modifier-only profiles only add restrictions.",
		});
	});

	test("modifier-only profiles compose with inline tools", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({ request: { profiles: ["no-network"], tools: ["read"] } });

		expect(scope.tools).toEqual(["read"]);
		expect(scope.denyTools).toEqual(expect.arrayContaining(["browser", "web_search"]));
		expect(evaluate(scope, "read", {}, cwd).action).toBe("allow");
		expect(evaluate(scope, "write", {}, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:tool-allowlist",
		});
		expect(evaluate(scope, "browser", {}, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:tool-deny:browser",
		});
	});

	test("explicit empty tools is a concrete allowlist", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({ request: { tools: [] } });

		expect(scope.tools).toEqual([]);
		expect(evaluate(scope, "read", {}, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:tool-allowlist",
		});
	});

	test("normalizes profile tool aliases before enforcing tool allowlists", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({
			request: { profiles: ["read-only"] },
			mode: "enforce",
		});

		expect(scope.tools).toEqual(expect.arrayContaining(["grep", "glob"]));
		expect(scope.tools).not.toEqual(expect.arrayContaining(["search", "find"]));
		expect(evaluate(scope, "grep", {}, cwd).action).toBe("allow");
		expect(evaluate(scope, "edit", {}, cwd)).toMatchObject({ action: "deny" });
	});

	test("focused-edit with inline allowPaths allows scoped reads and denies out-of-scope reads", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({
			request: { profiles: ["focused-edit"], allowPaths: ["src/foo/**"] },
		});

		expect(evaluate(scope, "read", { path: "src/foo/a.ts" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "read", { path: "src/bar/a.ts" }, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:path-allowlist",
		});
	});

	test("inherited parent tool allowlist cannot be widened by a child", () => {
		const parent = enforceScope({ request: { tools: ["read"] } });
		const child = enforceScope({ request: { tools: ["read", "write"] }, inherited: parent });

		expect(child.tools).toEqual(["read"]);
	});

	test("suggest mode does not block the same denied tool and path that enforce mode blocks", async () => {
		const cwd = await tempCwd();
		const request = { profiles: ["read-only"], allowPaths: ["allowed/**"] };
		const suggest = enforceScope({ request, mode: "suggest" });
		const enforce = enforceScope({ request, mode: "enforce" });

		expect(evaluate(suggest, "write", { path: "blocked/secret.txt" }, cwd).action).toBe("allow");
		expect(evaluate(enforce, "write", { path: "blocked/secret.txt" }, cwd)).toMatchObject({ action: "deny" });
		expect(evaluate(enforce, "read", { path: "blocked/secret.txt" }, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:path-allowlist",
		});
	});

	test("yield and report_tool_issue are always allowed under restrictive allowlists", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({ request: { tools: ["read"], denyTools: ["yield", "report_tool_issue"] } });

		expect(evaluate(scope, "yield", {}, cwd).action).toBe("allow");
		expect(evaluate(scope, "report_tool_issue", {}, cwd).action).toBe("allow");
	});
});

describe("deterministic permission profile smoke fixture", () => {
	test("no-blocked profile allows allowed reads, denies blocked reads, and read-only denies writes", async () => {
		const cwd = await tempCwd();
		await mkdir(path.join(cwd, "allowed"), { recursive: true });
		await mkdir(path.join(cwd, "blocked"), { recursive: true });
		await writeFile(path.join(cwd, "allowed", "ok.txt"), "ok\n", "utf8");
		await writeFile(path.join(cwd, "blocked", "secret.txt"), "secret\n", "utf8");
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"no-blocked": {
					description: "Deny blocked fixture access.",
					useWhen: "Smoke-test path guardrails.",
					denyPaths: ["blocked/**"],
				},
			},
		});

		const loaded = await loadPermissionProfiles(cwd);
		const scope = enforceScope({ profiles: ["read-only", "no-blocked"], profilesMap: loaded.profiles });

		expect(evaluate(scope, "read", { path: "allowed/ok.txt" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "read", { path: "blocked/secret.txt" }, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:path-deny:blocked/**",
		});
		expect(evaluate(scope, "read", { path: "blocked/secret.txt" }, cwd).reason).toContain(
			"BLOCKED: Subagent permission profile denied path",
		);
		expect(evaluate(scope, "write", { path: "allowed/new.txt" }, cwd)).toMatchObject({
			action: "deny",
			reason: "BLOCKED: Subagent permission profile does not allow tool 'write'.",
			matched: "subagent:tool-allowlist",
		});
	});
});
