import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	appendPermissionDenialToSummary,
	BUILTIN_PERMISSION_PROFILES,
	classifyTaskPermissionRequest,
	buildEffectivePermissionSummary,
	composeEffectivePermissions,
	evaluateSubagentPermission,
	freezePermissionScope,
	normalizeEffectivePermissionSummary,
	permissionScopeDrifted,
	isScopeNoBroader,
	loadPermissionProfiles,
	preflightPermissionGuardrails,
	type CompiledPermissionClause,
	type DeepImmutable,
	type PathConstraintGroup,
	type EffectiveSubagentPermissions,
	type PermissionProfile,
	type SubagentPermissionMode,
	type TaskPermissionRequest,
} from "../permission-profiles";
import type { PermissionDenialDetails } from "../types";

const immutablePathGroup: DeepImmutable<PathConstraintGroup> = ["src/**"] as const;
void immutablePathGroup;
// @ts-expect-error An empty tuple is not a valid path constraint group.
const emptyPathGroup: DeepImmutable<PathConstraintGroup> = [];
void emptyPathGroup;
const immutableEmptyTuple: DeepImmutable<readonly []> = [];
void immutableEmptyTuple;
// @ts-expect-error DeepImmutable preserves an empty tuple's arity.
const nonEmptyFromEmptyTuple: DeepImmutable<readonly []> = ["unexpected"];

function compileOnlyReadonlyScopeFixture(scope: EffectiveSubagentPermissions): void {
	// @ts-expect-error Permission scopes cannot be widened after composition.
	scope.denyTools.push("write");
}
void compileOnlyReadonlyScopeFixture;
void nonEmptyFromEmptyTuple;

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

const BROWSER_AUDIT_PROFILES: Record<string, PermissionProfile> = {
	"browser-audit": {
		description: "Read pages with the browser and inspect results.",
		tools: ["read", "browser"],
	},
};

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

	test("rejects attempts to override the reserved browser-audit profile", async () => {
		const cwd = await tempCwd();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"browser-audit": {
					description: "Unsafe replacement",
					tools: ["browser", "bash"],
				},
			},
		});
		const loaded = await loadPermissionProfiles(cwd);

		expect(loaded.errors).toContain(
			'.omp/permissions.json: permission profile "browser-audit" is reserved and cannot be overridden',
		);
		expect(loaded.profiles["browser-audit"]).toEqual(BUILTIN_PERMISSION_PROFILES["browser-audit"]);
		expect(loaded.summaries.find(summary => summary.name === "browser-audit")?.source).toBe("built-in");
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
		expect(evaluate(scope, "browser", {}, cwd).details?.code).toBe("tool-deny");
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
		expect(evaluate(scope, "read", { path: "src/bar/a.ts" }, cwd).details?.code).toBe("path-not-allowed");
	});

	test("enforce child routes local URIs to its session root while filesystem paths remain constrained", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({
			request: { profiles: ["focused-edit"], allowPaths: ["src/foo/**"] },
		});
		const artifactsDir = path.join(cwd, "child-artifacts");

		expect(resolveLocalUrlToPath("local://scratch/result.txt", { getArtifactsDir: () => artifactsDir })).toBe(
			path.join(artifactsDir, "local", "scratch", "result.txt"),
		);
		expect(evaluate(scope, "write", { path: "local://scratch/result.txt" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "write", { path: "private/result.txt" }, cwd).details?.code).toBe("path-not-allowed");
		expect(evaluate(scope, "write", { path: "artifact://other-session/result.txt" }, cwd).details?.code).toBe(
			"path-not-allowed",
		);
	});

	test("browser-audit keeps browser in suggest and enforce without inherited restrictions", async () => {
		const cwd = await tempCwd();

		for (const mode of ["suggest", "enforce"] as const) {
			const scope = enforceScope({
				mode,
				request: { profiles: ["browser-audit"] },
				profilesMap: BROWSER_AUDIT_PROFILES,
			});

			expect(scope.tools).toEqual(["read", "browser"]);
			expect(scope.denyTools).not.toContain("browser");
			expect(evaluate(scope, "browser", {}, cwd)).toMatchObject({ action: "allow" });
		}
	});

	test("inherited browser deny remains a permission limitation instead of widening the child", async () => {
		const cwd = await tempCwd();
		const parent = enforceScope({ request: { tools: ["read", "browser"], denyTools: ["browser"] } });
		const child = enforceScope({
			request: { profiles: ["browser-audit"] },
			profilesMap: BROWSER_AUDIT_PROFILES,
			inherited: parent,
		});

		expect(child.tools).toEqual(["read", "browser"]);
		expect(child.denyTools).toContain("browser");
		expect(evaluate(child, "browser", {}, cwd)).toMatchObject({
			action: "deny",
			reason: "BLOCKED: Subagent permission profile denied tool 'browser'.",
			matched: "subagent:tool-deny:browser",
		});
	});

	test("inherited allowlist without browser remains a permission limitation instead of widening the child", async () => {
		const cwd = await tempCwd();
		const parent = enforceScope({ request: { tools: ["read"] } });
		const child = enforceScope({
			request: { profiles: ["browser-audit"] },
			profilesMap: BROWSER_AUDIT_PROFILES,
			inherited: parent,
		});

		expect(child.tools).toEqual(["read"]);
		expect(evaluate(child, "browser", {}, cwd)).toMatchObject({
			action: "deny",
			reason: "BLOCKED: Subagent permission profile does not allow tool 'browser'.",
			matched: "subagent:tool-allowlist",
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
		expect(evaluate(scope, "read", { path: "blocked/secret.txt" }, cwd).details?.code).toBe("path-deny");
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

describe("W1 permission request truth table", () => {
	test("distinguishes omitted, empty, path-only, deny-only, and explicit empty tools", () => {
		expect(classifyTaskPermissionRequest(undefined)).toBe("omitted");
		expect(classifyTaskPermissionRequest({})).toBe("empty");
		expect(classifyTaskPermissionRequest({ allowPaths: [] })).toBe("empty");
		expect(classifyTaskPermissionRequest({ allowPaths: ["src/**"] })).toBe("path-only-ambient");
		expect(classifyTaskPermissionRequest({ denyTools: ["bash"] })).toBe("deny-only");
		expect(classifyTaskPermissionRequest({ tools: [] })).toBe("explicit-tools-allow-none");
	});

	test("canonicalizes permission-only irc to native hub without changing builtin tool names", () => {
		const result = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "tester",
			actorKind: "sub",
			request: { tools: ["irc"] },
			profiles: BUILTIN_PERMISSION_PROFILES,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.tools).toEqual(["hub"]);
	});

	test("preflight rejects an unclassified route under a restricted enforce scope", () => {
		const result = preflightPermissionGuardrails({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "tester",
			actorKind: "sub",
			request: { allowPaths: ["src/**"] },
			profiles: BUILTIN_PERMISSION_PROFILES,
			capabilities: [{ name: "custom_route", source: "custom" }],
		});
		expect(result).toMatchObject({ ok: false });
	});

	test("retains named eval and MCP routes only when explicitly allowed", () => {
		const capabilities = [
			{ name: "summarize_eval", source: "eval" as const },
			{ name: "mcp__docs__search", source: "mcp" as const },
		];
		const permitted = preflightPermissionGuardrails({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "tester",
			actorKind: "sub",
			request: { tools: ["summarize_eval", "mcp__docs__search"] },
			profiles: BUILTIN_PERMISSION_PROFILES,
			capabilities,
		});
		expect(permitted.ok).toBe(true);
		if (permitted.ok) {
			expect(permitted.value.availableTools).toEqual(["summarize_eval", "mcp__docs__search"]);
			expect(evaluate(permitted.value, "summarize_eval", {}, "/tmp").action).toBe("allow");
			expect(evaluate(permitted.value, "mcp__docs__search", {}, "/tmp").action).toBe("allow");
		}
		const denied = preflightPermissionGuardrails({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "tester",
			actorKind: "sub",
			request: { tools: ["summarize_eval"] },
			profiles: BUILTIN_PERMISSION_PROFILES,
			capabilities,
		});
		expect(denied.ok).toBe(true);
		if (denied.ok) expect(evaluate(denied.value, "mcp__docs__search", {}, "/tmp").action).toBe("deny");
	});
});

describe("W1 reserved profile migration", () => {
	test("accepts exact normalized duplicates but rejects differing reserved profiles", async () => {
		const cwd = await tempCwd();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"SECRETS-BLIND": BUILTIN_PERMISSION_PROFILES["secrets-blind"],
				"NO-NETWORK": { denyTools: ["browser"] },
			},
		});
		const loaded = await loadPermissionProfiles(cwd);
		expect(loaded.errors).toEqual([
			'.omp/permissions.json: permission profile "no-network" is reserved and cannot be overridden',
		]);
		expect(loaded.profiles["secrets-blind"]).toEqual(BUILTIN_PERMISSION_PROFILES["secrets-blind"]);
	});
});

describe("W2 permission clauses and structural proofs", () => {
	test("preserves ambient routes, narrows inherited authority, and distinguishes deny-only from allow-none", () => {
		const capabilities = [
			{ name: "summarize_eval", source: "eval" as const },
			{ name: "mcp__docs__search", source: "mcp" as const },
		];
		const base = {
			mode: "enforce" as const,
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "child",
			actorKind: "sub" as const,
			profiles: BUILTIN_PERMISSION_PROFILES,
			capabilities,
		};
		const inherited = composeEffectivePermissions({
			...base,
			actorId: "parent",
			request: { tools: ["summarize_eval"] },
		});
		if (!inherited.ok) throw new Error(inherited.error);
		for (const request of [undefined, {}, { allowPaths: [] }] satisfies Array<TaskPermissionRequest | undefined>) {
			const ambient = preflightPermissionGuardrails({ ...base, request });
			const child = preflightPermissionGuardrails({ ...base, request, inherited: inherited.value });
			if (!ambient.ok || !child.ok) throw new Error("Expected ambient and inherited composition");
			for (const route of capabilities) expect(evaluate(ambient.value, route.name, {}, "/tmp").action).toBe("allow");
			expect(evaluate(child.value, "summarize_eval", {}, "/tmp").action).toBe("allow");
			expect(evaluate(child.value, "mcp__docs__search", {}, "/tmp").action).toBe("deny");
			expect(isScopeNoBroader(inherited.value, child.value)).toBe(true);
		}
		const pathOnly = preflightPermissionGuardrails({ ...base, request: { allowPaths: ["src/**"] } });
		if (!pathOnly.ok) throw new Error(pathOnly.error);
		for (const route of capabilities) {
			expect(evaluate(pathOnly.value, route.name, { path: "src/file.ts" }, "/tmp").action).toBe("allow");
			expect(evaluate(pathOnly.value, route.name, { path: "other/file.ts" }, "/tmp").action).toBe("deny");
		}
		for (const request of [{ denyTools: ["mcp__docs__search"] }, { profiles: ["no-network"] }]) {
			expect(preflightPermissionGuardrails({ ...base, request }).ok).toBe(false);
		}
		const none = preflightPermissionGuardrails({ ...base, request: { tools: [] } });
		if (!none.ok) throw new Error(none.error);
		for (const route of capabilities) expect(evaluate(none.value, route.name, {}, "/tmp").action).toBe("deny");
	});

	test("intersects crossed positive profiles instead of synthesizing their union", () => {
		const result = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "child",
			actorKind: "sub",
			request: { profiles: ["read-only", "focused-edit"] },
			profiles: BUILTIN_PERMISSION_PROFILES,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.tools).toEqual(expect.arrayContaining(["read", "grep", "glob", "hub"]));
		if (result.ok) expect(result.value.tools).not.toContain("write");
	});

	test("concatenates path groups and requires every group to match", () => {
		const result = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "child",
			actorKind: "sub",
			request: { tools: ["read"], allowPaths: ["*.ts"] },
			inherited: {
				mode: "enforce",
				toolsEnabled: true,
				pathsEnabled: true,
				actorId: "parent",
				actorKind: "sub",
				profiles: [],
				tools: ["read", "write"],
				denyTools: [],
				allowPaths: ["src/**"],
				denyPaths: [],
				allowPathGroups: [["src/**"]],
				denyPathGroups: [],
			},
			profiles: BUILTIN_PERMISSION_PROFILES,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.allowPathGroups).toEqual([["src/**"], ["*.ts"]]);
			expect(
				evaluateSubagentPermission({
					scope: result.value,
					toolName: "read",
					toolInput: { path: "src/file.ts" },
					cwd: "/tmp",
				}).action,
			).toBe("allow");
			expect(
				evaluateSubagentPermission({
					scope: result.value,
					toolName: "read",
					toolInput: { path: "src/file.js" },
					cwd: "/tmp",
				}).action,
			).toBe("deny");
		}
	});

	test("structural no-broader proof covers every authority field without glob implication", () => {
		const parent = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "p",
			actorKind: "sub",
			request: {
				profiles: ["no-network", "secrets-blind"],
				tools: ["read", "write"],
				allowPaths: ["src/**"],
				denyTools: ["bash"],
				denyPaths: ["private/**"],
			},
			profiles: BUILTIN_PERMISSION_PROFILES,
			capabilities: [
				{ name: "read", source: "builtin" },
				{ name: "write", source: "builtin" },
			],
		});
		const child = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "c",
			actorKind: "sub",
			parentId: "p",
			inherited: parent.ok ? parent.value : undefined,
			request: { tools: ["read"], denyTools: ["bash", "write"] },
			profiles: BUILTIN_PERMISSION_PROFILES,
			capabilities: [{ name: "read", source: "builtin" }],
		});
		expect(parent.ok && child.ok).toBe(true);
		if (parent.ok && child.ok) {
			const narrowed = {
				...child.value,
				allowPathGroups: [["*.ts"], ...(parent.value.allowPathGroups ?? [])] as const,
				denyPathGroups: [["generated/**"], ...(parent.value.denyPathGroups ?? [])] as const,
				guardrails: parent.value.guardrails,
				intrinsicTools: parent.value.intrinsicTools,
			};
			expect(isScopeNoBroader(parent.value, narrowed)).toBe(true);
			expect(isScopeNoBroader(parent.value, { ...narrowed, tools: ["read", "write"] })).toBe(true);
			const groupedParent = { ...parent.value, allowPathGroups: [["src/**", "test/**"]] as const };
			expect(
				isScopeNoBroader(groupedParent, { ...narrowed, allowPathGroups: [["test/**", "src/**"], ["*.ts"]] }),
			).toBe(true);
			expect(
				isScopeNoBroader(groupedParent, { ...narrowed, allowPathGroups: [["src/**", "test/**", "other/**"]] }),
			).toBe(false);
			const broaderCases: EffectiveSubagentPermissions[] = [
				{ ...narrowed, mode: "suggest" },
				{ ...narrowed, toolsEnabled: false },
				{ ...narrowed, pathsEnabled: false },
				{ ...narrowed, tools: ["read", "write", "browser"] },
				{ ...narrowed, availableTools: ["read", "write", "browser"] },
				{ ...narrowed, denyTools: narrowed.denyTools.filter(name => name !== "bash") },
				{ ...narrowed, allowPathGroups: [["src/*.ts"]] },
				{ ...narrowed, denyPathGroups: [["generated/**"]] },
				{ ...narrowed, guardrails: { ...narrowed.guardrails, noNetwork: false } },
				{ ...narrowed, guardrails: { ...narrowed.guardrails, secretsBlind: false } },
				// @ts-expect-error persisted hostile input cannot remove the mandatory yield intrinsic
				{ ...narrowed, intrinsicTools: { ...narrowed.intrinsicTools, yield: false } },
				{ ...narrowed, intrinsicTools: { ...narrowed.intrinsicTools, reportToolIssue: false } },
			];
			for (const broader of broaderCases) expect(isScopeNoBroader(parent.value, broader)).toBe(false);
			// Structural proof is deliberately exact: a semantically related glob never implies the persisted parent row.
			expect(isScopeNoBroader(parent.value, { ...narrowed, allowPathGroups: [["src/**/*.ts"]] })).toBe(false);
		}
	});

	test("frozen scope snapshots own recursive state and detect canonical drift", () => {
		const original: EffectiveSubagentPermissions = {
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "a",
			actorKind: "sub",
			profiles: ["focused-edit"],
			tools: ["read"],
			denyTools: [],
			allowPaths: ["src/**"],
			denyPaths: [],
			allowPathGroups: [["src/**"]],
			denyPathGroups: [],
			provenance: { source: "request", profileNames: ["focused-edit"], profiles: [] },
		};
		const snapshot = freezePermissionScope(original);
		(original.tools as string[]).push("write");
		(original.allowPathGroups as PathConstraintGroup[])[0] = ["test/**"];
		expect(snapshot.scope.tools).toEqual(["read"]);
		expect(snapshot.scope.allowPathGroups).toEqual([["src/**"]]);
		expect(Object.isFrozen(snapshot.scope.allowPathGroups)).toBe(true);
		expect(permissionScopeDrifted(snapshot, original)).toBe(true);
		expect(snapshot.canonicalSha256).toMatch(/^[a-f0-9]{64}$/);
		const restored = freezePermissionScope(JSON.parse(JSON.stringify(snapshot.scope)));
		expect(restored.canonicalSha256).toBe(snapshot.canonicalSha256);
		expect(Object.isFrozen(restored.scope.provenance?.profileNames)).toBe(true);
		expect(permissionScopeDrifted(snapshot, { ...snapshot.scope, actorId: "other" })).toBe(true);
		expect(permissionScopeDrifted(snapshot, { ...snapshot.scope, parentId: "other" })).toBe(true);
		expect(
			permissionScopeDrifted(snapshot, {
				...snapshot.scope,
				provenance: { ...original.provenance!, profileNames: ["read-only"] },
			}),
		).toBe(true);
	});

	test("compilation owns profile loader values before later mutation", () => {
		const profile: PermissionProfile = { tools: ["read"], allowPaths: ["src/**"] };
		const result = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "child",
			actorKind: "sub",
			request: { profiles: ["loader"] },
			profiles: { loader: profile },
		});
		expect(result.ok).toBe(true);
		profile.tools?.push("write");
		profile.allowPaths?.push("test/**");
		if (result.ok) {
			expect(result.value.tools).toEqual(["read"]);
			expect(result.value.allowPathGroups).toEqual([["src/**"]]);
		}
	});
});

describe("effective permission display summary", () => {
	test("preserves stable order while applying every item and UTF-8 byte cap", () => {
		const shortExact = "é".repeat(64);
		const shortPlusOne = `${shortExact}a`;
		const pathExact = "🙂".repeat(128);
		const pathPlusOne = `${pathExact}a`;
		const profiles = [shortExact, shortPlusOne, ...Array.from({ length: 15 }, (_, index) => `profile-${index}`)];
		const denyTools = Array.from({ length: 33 }, (_, index) => `deny-tool-${index}`);
		const denyPaths = Array.from({ length: 33 }, (_, index) => `deny/path-${index}`);
		const clauseTools = [shortExact, shortPlusOne, ...Array.from({ length: 31 }, (_, index) => `tool-${index}`)];
		const pathPatterns: PathConstraintGroup = [
			pathExact,
			pathPlusOne,
			...Array.from({ length: 15 }, (_, index) => `path-${index}/**`),
		];
		const allowPathSets: PathConstraintGroup[] = Array.from({ length: 17 }, () => pathPatterns);
		const clauses: CompiledPermissionClause[] = Array.from({ length: 33 }, () => ({
			source: "inline",
			descriptorIds: clauseTools,
			allowPathSets,
		}));
		const denials: PermissionDenialDetails[] = Array.from({ length: 65 }, (_, index) => ({
			kind: "subagent_permission_denial",
			code: "path-deny",
			tool: shortPlusOne,
			targets: {
				items: [
					{ kind: "uri", display: "https://user:password@example.test/private?token=hidden#fragment" },
					...Array.from({ length: 16 }, targetIndex => ({
						kind: "path" as const,
						display: `${pathPlusOne}-${targetIndex}`,
					})),
				],
				omittedCount: 0,
			},
			matched: pathPlusOne,
			reason: `${"é".repeat(2048)}x-${index}`,
		}));
		const scope: EffectiveSubagentPermissions = {
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "child-private-id",
			actorKind: "sub",
			profiles,
			tools: ["read"],
			denyTools,
			allowPaths: [],
			denyPaths,
			clauses,
			guardrails: { noNetwork: true, secretsBlind: true },
			intrinsicTools: { yield: true, reportToolIssue: false },
			provenance: {
				source: "request",
				profileNames: ["private-profile"],
				profiles: [{ name: "private-profile", source: "request", canonicalSha256: "f".repeat(64) }],
			},
		};

		const summary = buildEffectivePermissionSummary(scope, denials);

		expect(summary.profiles.items).toEqual([shortExact, shortExact, ...profiles.slice(2, 16)]);
		expect(summary.profiles.omittedCount).toBe(1);
		expect(summary.clauses.items).toHaveLength(32);
		expect(summary.clauses.omittedCount).toBe(1);
		expect(summary.clauses.items[0]?.tools?.items).toHaveLength(32);
		expect(summary.clauses.items[0]?.tools?.omittedCount).toBe(1);
		expect(summary.clauses.items[0]?.allowPathSets?.items).toHaveLength(16);
		expect(summary.clauses.items[0]?.allowPathSets?.omittedCount).toBe(1);
		expect(summary.clauses.items[0]?.allowPathSets?.items?.[0]?.items?.[1]).toBe(pathExact);
		expect(summary.clauses.items[0]?.allowPathSets?.items?.[0]?.omittedCount).toBe(1);
		expect(summary.denyTools.items).toEqual(denyTools.slice(0, 32));
		expect(summary.denyTools.omittedCount).toBe(1);
		expect(summary.denyPaths.items).toEqual(denyPaths.slice(0, 32));
		expect(summary.denyPaths.omittedCount).toBe(1);
		expect(summary.recentDenials.items).toHaveLength(64);
		expect(summary.recentDenials.omittedCount).toBe(1);
		expect(summary.recentDenials.items[0]?.targets?.items?.[0]?.display).toBe("https://example.test/private");
		expect(summary.recentDenials.items[0]?.targets?.omittedCount).toBe(1);
		expect(new TextEncoder().encode(summary.recentDenials.items[0]?.tool).byteLength).toBe(128);
		expect(new TextEncoder().encode(summary.recentDenials.items[0]?.matched).byteLength).toBe(512);
		expect(new TextEncoder().encode(summary.recentDenials.items[0]?.reason).byteLength).toBe(4096);
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("child-private-id");
		expect(serialized).not.toContain("canonicalSha256");
		expect(serialized).not.toContain("private-profile");
	});

	test("normalizes hostile input into deeply owned frozen display data", () => {
		const source = {
			mode: "suggest",
			profiles: { items: ["first\nline", "second\u0000line"], omittedCount: 3 },
			clauses: {
				items: [{ tools: { items: ["read"], omittedCount: 0 }, allowPathSets: { items: [], omittedCount: 0 } }],
				omittedCount: 0,
			},
			denyTools: { items: [], omittedCount: 0 },
			denyPaths: { items: ["https://name:secret@example.test/a?api_key=hidden"], omittedCount: 0 },
			guardrails: { noNetwork: false, secretsBlind: true },
			intrinsicTools: { yield: true, reportToolIssue: true },
			recentDenials: { items: [], omittedCount: 0 },
		};
		const summary = normalizeEffectivePermissionSummary(source);
		if (!summary) throw new Error("Expected normalized permission summary");
		expect(summary.profiles.items).toEqual(["first line", "second line"]);
		expect(summary.denyPaths.items).toEqual(["https://example.test/a"]);
		expect(summary.profiles.omittedCount).toBe(3);
		expect(Object.isFrozen(summary)).toBe(true);
		expect(Object.isFrozen(summary.clauses.items[0]?.tools?.items)).toBe(true);
		source.profiles.items[0] = "mutated";
		expect(summary.profiles.items[0]).toBe("first line");
		expect(() => (summary.profiles.items as string[]).push("forbidden")).toThrow();
	});

	test("appends canonical frozen denials while retaining the newest 64", () => {
		const scope = enforceScope({ request: { tools: ["read"] } });
		let summary = buildEffectivePermissionSummary(scope);
		for (let index = 0; index < 65; index++) {
			summary = appendPermissionDenialToSummary(summary, {
				kind: "subagent_permission_denial",
				code: "tool-not-allowed",
				tool: `tool-${index}`,
				targets: { items: [{ kind: "path", display: `target-${index}` }], omittedCount: 0 },
				matched: "subagent:tool-allowlist",
				reason: `blocked-${index}`,
			});
		}
		expect(summary.recentDenials.items).toHaveLength(64);
		expect(summary.recentDenials.items[0]?.tool).toBe("tool-1");
		expect(summary.recentDenials.items[63]?.tool).toBe("tool-64");
		expect(summary.recentDenials.omittedCount).toBe(1);
		expect(Object.isFrozen(summary)).toBe(true);
		expect(Object.isFrozen(summary.recentDenials.items)).toBe(true);
		expect(Object.isFrozen(summary.recentDenials.items[0]?.targets?.items)).toBe(true);

		const afterInvalid = appendPermissionDenialToSummary(summary, { code: "invalid" } as never);
		expect(afterInvalid.recentDenials.items).toEqual(summary.recentDenials.items);
		expect(afterInvalid.recentDenials.omittedCount).toBe(2);
	});
});
