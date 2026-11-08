import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	classifyTaskPermissionRequest,
	composeEffectivePermissions,
	isScopeNoBroader,
	preflightPermissionGuardrails,
} from "@oh-my-pi/pi-coding-agent/task/permissions/compose";
import { evaluateSubagentPermission } from "@oh-my-pi/pi-coding-agent/task/permissions/evaluate";
import {
	BUILTIN_PERMISSION_PROFILES,
	loadPermissionProfiles,
	permissionProfileConfigErrors,
} from "@oh-my-pi/pi-coding-agent/task/permissions/profiles";
import type {
	DeepImmutable,
	PathConstraintGroup,
	PermissionProfile,
	PermissionScope,
	SubagentPermissionMode,
	TaskPermissionRequest,
} from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils";
import userShapedPermissions from "./fixtures/user-shaped-permissions.json" with { type: "json" };

const immutablePathGroup: DeepImmutable<PathConstraintGroup> = ["src/**"] as const;
void immutablePathGroup;
// @ts-expect-error An empty tuple is not a valid path constraint group.
const emptyPathGroup: DeepImmutable<PathConstraintGroup> = [];
void emptyPathGroup;

function compileOnlyReadonlyScopeFixture(scope: PermissionScope): void {
	// @ts-expect-error Permission scopes cannot be widened after composition.
	scope.denyTools.push("write");
}
void compileOnlyReadonlyScopeFixture;

const PATH_RULE_WARNING_TAIL =
	"together with path rules; a subagent whose scope has path rules does not get tools whose effects reach beyond their path arguments (bash, eval, LSP, MCP, extension and custom tools, github, debug, ida, manage_skill, security_scan)";

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-permission-profiles-"));
	tempRoots.push(cwd);
	return cwd;
}

/** Agent dir with no user-level permissions.json, so the real ~/.omp/agent never leaks into a load. */
async function emptyAgentDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-permission-agent-"));
	tempRoots.push(dir);
	return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const BROWSER_READER_PROFILES: Record<string, PermissionProfile> = {
	"browser-reader": {
		description: "Read pages with the browser and inspect results.",
		tools: ["read", "browser"],
	},
};

function enforceScope(input: {
	profiles?: string[];
	request?: TaskPermissionRequest;
	profilesMap?: Record<string, PermissionProfile>;
	mode?: SubagentPermissionMode;
	inherited?: PermissionScope;
}): PermissionScope {
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

function evaluate(scope: PermissionScope, toolName: string, toolInput: Record<string, unknown>, cwd: string) {
	return evaluateSubagentPermission({ scope, toolName, toolInput, cwd });
}

function scopeFixture(overrides: Partial<PermissionScope> = {}): PermissionScope {
	return {
		v: 2,
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "parent",
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

describe("permission profile loading", () => {
	test("loads built-in profiles when no config files exist", async () => {
		const cwd = await tempCwd();
		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });

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

		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });

		expect(loaded.errors).toEqual([]);
		expect(loaded.profiles["read-only"]?.description).toBe("Project read profile");
		expect(loaded.profiles["read-only"]?.tools).toEqual(["read"]);
		expect(loaded.profiles.custom?.description).toBe("Local custom");
		expect(loaded.profiles.custom?.tools).toEqual(["search"]);
		expect(loaded.summaries.find(summary => summary.name === "read-only")?.source).toBe("project");
		expect(loaded.summaries.find(summary => summary.name === "custom")?.source).toBe("local");
	});

	test("browser-audit is no longer a built-in or reserved name", async () => {
		const cwd = await tempCwd();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"browser-audit": {
					description: "Project profile reusing the retired name",
					tools: ["read"],
				},
			},
		});
		const agentDir = await emptyAgentDir();

		expect(BUILTIN_PERMISSION_PROFILES["browser-audit"]).toBeUndefined();
		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toEqual([]);
		expect(loaded.profiles["browser-audit"]).toEqual({
			description: "Project profile reusing the retired name",
			tools: ["read"],
		});
		expect(loaded.profileIdentities["browser-audit"]?.source).toBe("project");
	});

	test("parse errors are reported while built-ins remain available", async () => {
		const cwd = await tempCwd();
		await Bun.write(path.join(cwd, ".omp", "permissions.json"), "{ not json");

		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });

		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toContain(".omp/permissions.json");
		expect(loaded.unreadableFile).toBe(true);
		expect(loaded.profiles["read-only"]?.tools).toContain("read");
		expect(loaded.profiles["read-only"]?.denyTools).toBeUndefined();
		expect(loaded.profiles["focused-edit"]?.tools).toContain("edit");
	});
});

describe("permission profile file validation", () => {
	test("a profile with an unknown field or a wrongly typed value is reported and not applied", async () => {
		const cwd = await tempCwd();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"NO-NETWORK": { denyTools: ["browser"] },
				// A misspelled denyPaths would otherwise load a silently broader profile.
				Misspelled: { tools: ["read"], denyPath: ["secret/**"] },
				"string-tools": { tools: "read" },
				"mixed-tools": { tools: ["read", 5] },
				"numeric-description": { description: 5, tools: ["read"] },
				scalar: "read-only",
				valid: { tools: ["read"], denyPaths: ["secret/**"] },
			},
		});

		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });

		// File order, normalized names, whichever kind of error each entry has.
		expect(loaded.errors).toEqual([
			'.omp/permissions.json: permission profile "no-network" is reserved and cannot be overridden',
			'.omp/permissions.json: permission profile "misspelled" has unknown field "denyPath"',
			'.omp/permissions.json: permission profile "string-tools" field "tools" must be an array of strings',
			'.omp/permissions.json: permission profile "mixed-tools" field "tools" must be an array of strings',
			'.omp/permissions.json: permission profile "numeric-description" field "description" must be a string',
			'.omp/permissions.json: permission profile "scalar" must be an object',
		]);
		expect(loaded.profiles.misspelled).toBeUndefined();
		expect(loaded.profiles["string-tools"]).toBeUndefined();
		expect(loaded.profiles["mixed-tools"]).toBeUndefined();
		expect(loaded.profiles.scalar).toBeUndefined();
		expect(loaded.profiles.valid).toEqual({ tools: ["read"], denyPaths: ["secret/**"] });
	});

	test("an invalid override stops the name resolving instead of falling back to a broader definition", async () => {
		const cwd = await tempCwd();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: { narrow: { tools: ["read", "write"] } },
		});
		await writeJson(path.join(cwd, ".omp", "permissions.local.json"), {
			profiles: {
				narrow: { tools: ["read"], denyPath: ["secret/**"] },
				"read-only": { tool: ["read"] },
				"secrets-blind": { tool: ["read"] },
			},
		});

		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });

		expect(loaded.errors).toHaveLength(3);
		expect(loaded.profiles.narrow).toBeUndefined();
		expect(loaded.profiles["read-only"]).toBeUndefined();
		// Reserved profiles always resolve to the built-in.
		expect(loaded.profiles["secrets-blind"]).toEqual(BUILTIN_PERMISSION_PROFILES["secrets-blind"]);
	});

	test("a file whose root or profiles value is not an object is reported; other top-level keys are ignored", async () => {
		const cwd = await tempCwd();
		const agentDir = await emptyAgentDir();
		await writeJson(path.join(agentDir, "permissions.json"), { defaultAction: "allow", bash: [] });
		await writeJson(path.join(cwd, ".omp", "permissions.json"), { profiles: ["read-only"] });
		await writeJson(path.join(cwd, ".omp", "permissions.local.json"), ["read-only"]);

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toEqual([
			'.omp/permissions.json: "profiles" must be an object',
			".omp/permissions.local.json: must contain a JSON object",
		]);
		expect(loaded.unreadableFile).toBe(true);
	});
});

describe("permission profile startup errors", () => {
	test("reports loader errors unless subagent permissions are off", async () => {
		const cwd = await tempCwd();
		const agentDir = await emptyAgentDir();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), { profiles: { bad: { denyPath: ["x"] } } });

		expect(await permissionProfileConfigErrors(cwd, { mode: "off", agentDir })).toEqual([]);
		expect(await permissionProfileConfigErrors(cwd, { mode: "enforce", agentDir })).toEqual([
			'.omp/permissions.json: permission profile "bad" has unknown field "denyPath"',
		]);
	});

	test("is empty when every profile file is valid", async () => {
		const cwd = await tempCwd();
		const agentDir = await emptyAgentDir();
		await writeJson(path.join(agentDir, "permissions.json"), { profiles: { scout: { tools: ["read"] } } });

		expect(await permissionProfileConfigErrors(cwd, { mode: "enforce", agentDir })).toEqual([]);
	});
});

describe("user-level permission profiles", () => {
	test("profiles from <agentDir>/permissions.json load with source user", async () => {
		const cwd = await tempCwd();
		const agentDir = await emptyAgentDir();
		await writeJson(path.join(agentDir, "permissions.json"), {
			defaultAction: "allow",
			profiles: { "repo-scout": { description: "User scout", tools: ["read", "search"] } },
		});

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toEqual([]);
		expect(loaded.profiles["repo-scout"]).toEqual({ description: "User scout", tools: ["read", "search"] });
		expect(loaded.summaries.find(summary => summary.name === "repo-scout")?.source).toBe("user");
		expect(loaded.profileIdentities["repo-scout"]?.source).toBe("user");
		expect(loaded.summaries.find(summary => summary.name === "read-only")?.source).toBe("built-in");
	});

	test("project and local files cannot redefine a user-level profile (P4)", async () => {
		const home = await tempCwd();
		const cwd = await tempCwd();
		const agentDir = path.join(home, ".omp", "agent");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await writeJson(path.join(agentDir, "permissions.json"), {
			profiles: {
				shared: { description: "User shared", tools: ["read"], denyPaths: ["vault/**"] },
				layered: { description: "User layered", tools: ["read"] },
				// A user entry that fails validation still claims its name.
				broken: { tools: ["read"], denyPath: ["vault/**"] },
			},
		});
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				shared: { description: "Project shared", tools: ["read", "write"] },
				broken: { tools: ["read", "write"] },
				"project-only": { description: "Project only", tools: ["find"] },
			},
		});
		await writeJson(path.join(cwd, ".omp", "permissions.local.json"), {
			profiles: {
				layered: { description: "Local layered", tools: ["read", "bash"] },
				"project-only": { description: "Local override of a project name", tools: ["grep"] },
			},
		});

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toEqual([
			'~/.omp/agent/permissions.json: permission profile "broken" has unknown field "denyPath"',
			'.omp/permissions.json: permission profile "shared" is defined in ~/.omp/agent/permissions.json and cannot be redefined',
			'.omp/permissions.json: permission profile "broken" is defined in ~/.omp/agent/permissions.json and cannot be redefined',
			'.omp/permissions.local.json: permission profile "layered" is defined in ~/.omp/agent/permissions.json and cannot be redefined',
		]);
		expect(loaded.profiles.shared).toEqual({ description: "User shared", tools: ["read"], denyPaths: ["vault/**"] });
		expect(loaded.profileIdentities.shared?.source).toBe("user");
		expect(loaded.profiles.layered?.description).toBe("User layered");
		expect(loaded.profileIdentities.layered?.source).toBe("user");
		expect(loaded.profiles.broken).toBeUndefined();
		// New names are still welcome, and local still overrides project for them.
		expect(loaded.profiles["project-only"]?.tools).toEqual(["grep"]);
		expect(loaded.profileIdentities["project-only"]?.source).toBe("local");
		// A rejected redefinition is a config error, not an unreadable file: revival is not blocked by it.
		expect(loaded.unreadableFile).toBe(false);
	});

	test("default agent dir follows PI_CODING_AGENT_DIR, not PI_CONFIG_DIR", async () => {
		const cwd = await tempCwd();
		const agentDir = await emptyAgentDir();
		const unrelatedConfigRoot = await emptyAgentDir();
		await writeJson(path.join(agentDir, "permissions.json"), {
			profiles: { "from-agent-dir": { tools: ["read"] } },
		});
		// Decoys at both locations a config-root based lookup would read.
		await writeJson(path.join(unrelatedConfigRoot, "permissions.json"), {
			profiles: { "from-config-root": { tools: ["read"] } },
		});
		await writeJson(path.join(unrelatedConfigRoot, "agent", "permissions.json"), {
			profiles: { "from-config-agent": { tools: ["read"] } },
		});
		const previous = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
		};
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_CONFIG_DIR = unrelatedConfigRoot;
		__resetDirsFromEnvForTests();
		try {
			const loaded = await loadPermissionProfiles(cwd);

			expect(loaded.profileIdentities["from-agent-dir"]?.source).toBe("user");
			expect(loaded.profiles["from-config-root"]).toBeUndefined();
			expect(loaded.profiles["from-config-agent"]).toBeUndefined();
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
		}
	});

	test("a malformed user file reports a home-relative error and other sources still load", async () => {
		const home = await tempCwd();
		const cwd = await tempCwd();
		const agentDir = path.join(home, ".omp", "agent");
		await Bun.write(path.join(agentDir, "permissions.json"), "{ not json");
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: { "project-only": { tools: ["read"] } },
		});
		vi.spyOn(os, "homedir").mockReturnValue(home);

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toStartWith("~/.omp/agent/permissions.json: ");
		expect(loaded.profileIdentities["project-only"]?.source).toBe("project");
		expect(loaded.profiles["read-only"]?.tools).toContain("read");
	});

	test("a user file cannot redefine a reserved profile", async () => {
		const home = await tempCwd();
		const cwd = await tempCwd();
		const agentDir = path.join(home, ".omp", "agent");
		await writeJson(path.join(agentDir, "permissions.json"), {
			profiles: {
				"no-network": { description: "User replacement", denyTools: ["browser"] },
				"secrets-blind": BUILTIN_PERMISSION_PROFILES["secrets-blind"],
			},
		});
		vi.spyOn(os, "homedir").mockReturnValue(home);

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toEqual([
			'~/.omp/agent/permissions.json: permission profile "no-network" is reserved and cannot be overridden',
		]);
		expect(loaded.profiles["no-network"]).toEqual(BUILTIN_PERMISSION_PROFILES["no-network"]);
		expect(loaded.profileIdentities["no-network"]?.source).toBe("built-in");
		expect(loaded.profileIdentities["secrets-blind"]?.source).toBe("built-in");
	});

	test("a project file that resolves to the user file loads once, as user", async () => {
		const cwd = await tempCwd();
		const agentDir = await emptyAgentDir();
		await writeJson(path.join(agentDir, "permissions.json"), {
			profiles: {
				"no-network": { denyTools: ["browser"] },
				shared: { tools: ["read"] },
			},
		});
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.symlink(path.join(agentDir, "permissions.json"), path.join(cwd, ".omp", "permissions.json"));

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		// A second load as "project" would repeat the reserved-name error and trip the P4 redefinition rule.
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.profileIdentities.shared?.source).toBe("user");
	});

	test("a file shaped like the user's permissions.json loads every profile", async () => {
		const cwd = await tempCwd();
		const home = await tempCwd();
		const agentDir = path.join(home, ".omp", "agent");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await writeJson(path.join(agentDir, "permissions.json"), userShapedPermissions);

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toEqual([]);
		expect(loaded.unreadableFile).toBe(false);
		// The user's secrets-blind is an exact duplicate of the reserved built-in.
		expect(loaded.profileIdentities["secrets-blind"]?.source).toBe("built-in");
		for (const name of ["fixture-reader", "fixture-editor", "fixture-debug-runner", "fixture-docs-researcher"]) {
			expect(loaded.profileIdentities[name]?.source).toBe("user");
			const scope = enforceScope({ profiles: [name, "secrets-blind"], profilesMap: loaded.profiles });
			// P3: `irc` grants messaging and `search` is grep.
			expect(evaluate(scope, "wait", {}, cwd).action).toBe("allow");
			expect(evaluate(scope, "write", { path: "agent://Main" }, cwd).action).toBe("allow");
			expect(evaluate(scope, "grep", { path: "src", pattern: "x" }, cwd).action).toBe("allow");
		}
		// P2: every listed tool the path-rule exclusion removes is named; irc (messaging) and search are kept.
		expect(loaded.warnings).toEqual([
			`~/.omp/agent/permissions.json: permission profile "fixture-reader" lists lsp ${PATH_RULE_WARNING_TAIL}`,
			`~/.omp/agent/permissions.json: permission profile "fixture-editor" lists lsp ${PATH_RULE_WARNING_TAIL}`,
			`~/.omp/agent/permissions.json: permission profile "fixture-debug-runner" lists lsp, bash ${PATH_RULE_WARNING_TAIL}`,
		]);
	});
});

describe("unprovable tools with path rules (P2)", () => {
	test("loading a profile with path rules warns once, naming every listed tool the rule removes", async () => {
		const cwd = await tempCwd();
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"shell-with-paths": { tools: ["read", "bash"], allowPaths: ["src/**"] },
				"eval-and-mcp-with-paths": { tools: ["read", "eval", "mcp__docs__search"], denyPaths: ["vault/**"] },
				"shell-without-paths": { tools: ["read", "bash"] },
				"lsp-with-paths": { tools: ["read", "lsp"], denyPaths: ["vault/**"] },
				"native-effects-with-paths": {
					tools: ["read", "github", "debug", "ida", "manage_skill", "security_scan", "edit"],
					allowPaths: ["src"],
				},
				"extension-with-paths": { tools: ["grep", "custom_extension_tool", "vibe_spawn"], denyPaths: ["vault"] },
				"messaging-with-paths": { tools: ["read", "search", "irc", "hub", "wait", "write"], denyPaths: ["vault"] },
			},
		});

		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });

		expect(loaded.errors).toEqual([]);
		expect(loaded.warnings).toEqual([
			`.omp/permissions.json: permission profile "shell-with-paths" lists bash ${PATH_RULE_WARNING_TAIL}`,
			`.omp/permissions.json: permission profile "eval-and-mcp-with-paths" lists eval, mcp__docs__search ${PATH_RULE_WARNING_TAIL}`,
			`.omp/permissions.json: permission profile "lsp-with-paths" lists lsp ${PATH_RULE_WARNING_TAIL}`,
			`.omp/permissions.json: permission profile "native-effects-with-paths" lists github, debug, ida, manage_skill, security_scan ${PATH_RULE_WARNING_TAIL}`,
			`.omp/permissions.json: permission profile "extension-with-paths" lists custom_extension_tool, vibe_spawn ${PATH_RULE_WARNING_TAIL}`,
		]);
		// The profiles still load; the rule is applied when a scope is evaluated.
		expect(loaded.profiles["shell-with-paths"]?.tools).toEqual(["read", "bash"]);
	});

	test("github, debug, ida, manage_skill, security_scan, lsp and extension tools are denied under path rules while messaging stays", async () => {
		const cwd = await tempCwd();
		const tools = [
			"read",
			"lsp",
			"github",
			"debug",
			"ida",
			"manage_skill",
			"security_scan",
			"custom_extension_tool",
			"irc",
			"wait",
		];
		const scope = enforceScope({ request: { tools, denyPaths: ["vault"] } });

		for (const tool of ["lsp", "github", "debug", "ida", "manage_skill", "security_scan", "custom_extension_tool"]) {
			expect(evaluate(scope, tool, {}, cwd).matched).toBe("guardrail:unprovable-effect");
		}
		for (const tool of ["read", "wait"]) expect(evaluate(scope, tool, {}, cwd).action).toBe("allow");
	});

	test("a scope with any path rule denies bash, eval and MCP even when listed", async () => {
		const cwd = await tempCwd();
		const tools = ["read", "bash", "eval", "mcp__docs__search"];
		const withPaths = enforceScope({ request: { tools, denyPaths: ["vault/**"] } });
		const withoutPaths = enforceScope({ request: { tools } });

		for (const tool of ["bash", "eval", "mcp__docs__search"]) {
			expect(evaluate(withPaths, tool, {}, cwd)).toMatchObject({
				action: "deny",
				matched: "guardrail:unprovable-effect",
				details: { code: "guardrail" },
			});
			expect(evaluate(withoutPaths, tool, {}, cwd).action).toBe("allow");
		}
		expect(evaluate(withPaths, "read", { path: "src/a.ts" }, cwd).action).toBe("allow");
	});
});

describe("messaging grant and tool aliases (P3)", () => {
	test("irc and hub grant wait plus write to agent:// targets, not filesystem writes", async () => {
		const cwd = await tempCwd();
		for (const alias of ["irc", "hub", "IRC"]) {
			const scope = enforceScope({ request: { tools: ["read", alias] } });

			expect(scope.tools).toEqual(["read", "hub"]);
			expect(evaluate(scope, "wait", {}, cwd).action).toBe("allow");
			expect(evaluate(scope, "write", { path: "agent://Main" }, cwd).action).toBe("allow");
			expect(evaluate(scope, "write", { path: "src/a.ts" }, cwd)).toMatchObject({
				action: "deny",
				details: { code: "tool-not-allowed" },
			});
		}
	});

	test("without a messaging grant a restricted subagent cannot wait or write agent:// targets", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({ request: { tools: ["read"] } });

		expect(evaluate(scope, "wait", {}, cwd)).toMatchObject({
			action: "deny",
			details: { code: "tool-not-allowed" },
		});
		expect(evaluate(scope, "write", { path: "agent://Main" }, cwd)).toMatchObject({
			action: "deny",
			details: { code: "tool-not-allowed" },
		});
	});

	test("denying hub withdraws messaging even when wait and write are allowed", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({ request: { tools: ["read", "write", "wait"], denyTools: ["irc"] } });

		expect(evaluate(scope, "wait", {}, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:tool-deny:hub",
			details: { code: "tool-deny" },
		});
		expect(evaluate(scope, "write", { path: "agent://Main" }, cwd)).toMatchObject({
			action: "deny",
			details: { code: "tool-deny" },
		});
		expect(evaluate(scope, "write", { path: "src/a.ts" }, cwd).action).toBe("allow");
	});

	test("search in a profile is the grep tool", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({
			request: { profiles: ["searcher"] },
			profilesMap: { searcher: { tools: ["read", "search"] } },
		});

		expect(scope.tools).toEqual(["read", "grep"]);
		expect(evaluate(scope, "grep", { path: "src", pattern: "x" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "search", { path: "src", pattern: "x" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "find", { path: "src" }, cwd).details?.code).toBe("tool-not-allowed");
	});
});

describe("directory entries in path rules (P8)", () => {
	test("an allowPaths entry naming a directory covers everything below it", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({ request: { tools: ["read"], allowPaths: ["src", `${cwd}/docs/`] } });

		expect(evaluate(scope, "read", { path: "src" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "read", { path: "src/deep/nested/a.ts" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "read", { path: `${cwd}/src/a.ts` }, cwd).action).toBe("allow");
		expect(evaluate(scope, "read", { path: "docs/guide.md" }, cwd).action).toBe("allow");
		// A sibling sharing the prefix is not below the directory.
		expect(evaluate(scope, "read", { path: "src-other/a.ts" }, cwd).details?.code).toBe("path-not-allowed");
		expect(evaluate(scope, "read", { path: "srcx" }, cwd).details?.code).toBe("path-not-allowed");
	});

	test("dir/** covers what is below dir but not dir itself; the plain entry covers both", async () => {
		const cwd = await tempCwd();
		const globbed = enforceScope({ request: { tools: ["grep"], allowPaths: ["src/**"] } });
		const plain = enforceScope({ request: { tools: ["grep"], allowPaths: ["src"] } });

		expect(evaluate(globbed, "grep", { path: "src/a.ts", pattern: "x" }, cwd).action).toBe("allow");
		expect(evaluate(globbed, "grep", { path: "src", pattern: "x" }, cwd).details?.code).toBe("path-not-allowed");
		expect(evaluate(plain, "grep", { path: "src", pattern: "x" }, cwd).action).toBe("allow");
		expect(evaluate(plain, "grep", { path: "src/a.ts", pattern: "x" }, cwd).action).toBe("allow");
	});

	test("a glob entry keeps its own meaning and a directory deny entry covers its contents", async () => {
		const cwd = await tempCwd();
		const scope = enforceScope({
			request: { tools: ["read"], allowPaths: ["src/*.ts"], denyPaths: ["src/vault"] },
		});

		expect(evaluate(scope, "read", { path: "src/a.ts" }, cwd).action).toBe("allow");
		expect(evaluate(scope, "read", { path: "src/a.js" }, cwd).details?.code).toBe("path-not-allowed");
		expect(evaluate(scope, "read", { path: "src/vault/key.ts" }, cwd)).toMatchObject({
			action: "deny",
			matched: "subagent:path-deny:src/vault",
			details: { code: "path-deny" },
		});
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

		expect(scope.tools).toEqual(expect.arrayContaining(["grep", "find"]));
		expect(scope.tools).not.toContain("search");
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

	test("a browser role profile keeps browser in suggest and enforce without inherited restrictions", async () => {
		const cwd = await tempCwd();

		for (const mode of ["suggest", "enforce"] as const) {
			const scope = enforceScope({
				mode,
				request: { profiles: ["browser-reader"] },
				profilesMap: BROWSER_READER_PROFILES,
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
			request: { profiles: ["browser-reader"] },
			profilesMap: BROWSER_READER_PROFILES,
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
			request: { profiles: ["browser-reader"] },
			profilesMap: BROWSER_READER_PROFILES,
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
		await Bun.write(path.join(cwd, "allowed", "ok.txt"), "ok\n");
		await Bun.write(path.join(cwd, "blocked", "secret.txt"), "secret\n");
		await writeJson(path.join(cwd, ".omp", "permissions.json"), {
			profiles: {
				"no-blocked": {
					description: "Deny blocked fixture access.",
					useWhen: "Smoke-test path guardrails.",
					denyPaths: ["blocked/**"],
				},
			},
		});

		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });
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

	test("canonicalizes permission-only irc to the messaging grant without changing builtin tool names", () => {
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

	test("an allowlist names eval and MCP routes; a route it omits is denied", () => {
		const permitted = enforceScope({ request: { tools: ["summarize_eval", "mcp__docs__search"] } });
		expect(evaluate(permitted, "summarize_eval", {}, "/tmp").action).toBe("allow");
		expect(evaluate(permitted, "mcp__docs__search", {}, "/tmp").action).toBe("allow");

		const narrower = enforceScope({ request: { tools: ["summarize_eval"] } });
		expect(evaluate(narrower, "summarize_eval", {}, "/tmp").action).toBe("allow");
		expect(evaluate(narrower, "mcp__docs__search", {}, "/tmp").details?.code).toBe("tool-not-allowed");
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
		const loaded = await loadPermissionProfiles(cwd, { agentDir: await emptyAgentDir() });
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
		// P2: a path rule makes eval and MCP effects unprovable, so both routes are denied.
		const pathOnly = preflightPermissionGuardrails({ ...base, request: { allowPaths: ["src/**"] } });
		if (!pathOnly.ok) throw new Error(pathOnly.error);
		for (const route of capabilities) {
			expect(evaluate(pathOnly.value, route.name, { path: "src/file.ts" }, "/tmp").details?.code).toBe("guardrail");
		}
		expect(evaluate(pathOnly.value, "read", { path: "src/file.ts" }, "/tmp").action).toBe("allow");
		expect(evaluate(pathOnly.value, "read", { path: "other/file.ts" }, "/tmp").action).toBe("deny");
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
		if (result.ok) expect(result.value.tools).toEqual(expect.arrayContaining(["read", "grep", "find", "hub"]));
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
			inherited: scopeFixture({ tools: ["read", "write"], allowPathGroups: [["src/**"]] }),
			profiles: BUILTIN_PERMISSION_PROFILES,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.allowPathGroups).toEqual([["src/**"], ["*.ts"]]);
			expect(result.value.inherited).toBe(true);
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
		});
		expect(parent.ok && child.ok).toBe(true);
		if (parent.ok && child.ok) {
			const narrowed: PermissionScope = {
				...child.value,
				allowPathGroups: [["*.ts"], ...parent.value.allowPathGroups],
				denyPathGroups: [["generated/**"], ...parent.value.denyPathGroups],
				guardrails: parent.value.guardrails,
				restricted: parent.value.restricted,
			};
			expect(isScopeNoBroader(parent.value, narrowed)).toBe(true);
			expect(isScopeNoBroader(parent.value, { ...narrowed, tools: ["read", "write"] })).toBe(true);
			const groupedParent: PermissionScope = { ...parent.value, allowPathGroups: [["src/**", "test/**"]] };
			expect(
				isScopeNoBroader(groupedParent, { ...narrowed, allowPathGroups: [["test/**", "src/**"], ["*.ts"]] }),
			).toBe(true);
			expect(
				isScopeNoBroader(groupedParent, { ...narrowed, allowPathGroups: [["src/**", "test/**", "other/**"]] }),
			).toBe(false);
			const broaderCases: PermissionScope[] = [
				{ ...narrowed, mode: "suggest" },
				{ ...narrowed, toolsEnabled: false },
				{ ...narrowed, pathsEnabled: false },
				{ ...narrowed, tools: ["read", "write", "browser"] },
				{ ...narrowed, tools: undefined },
				{ ...narrowed, denyTools: narrowed.denyTools.filter(name => name !== "bash") },
				{ ...narrowed, allowPathGroups: [["src/*.ts"]] },
				{ ...narrowed, denyPathGroups: [["generated/**"]] },
				{ ...narrowed, guardrails: { ...narrowed.guardrails, noNetwork: false } },
				{ ...narrowed, guardrails: { ...narrowed.guardrails, secretsBlind: false } },
				{ ...narrowed, restricted: false },
			];
			for (const broader of broaderCases) expect(isScopeNoBroader(parent.value, broader)).toBe(false);
			// Structural proof is deliberately exact: a semantically related glob never implies the persisted parent row.
			expect(isScopeNoBroader(parent.value, { ...narrowed, allowPathGroups: [["src/**/*.ts"]] })).toBe(false);
		}
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
			expect(Object.isFrozen(result.value.allowPathGroups[0])).toBe(true);
		}
	});

	test("provenance records each selected profile's source and content hash in order", async () => {
		const cwd = await tempCwd();
		const agentDir = await emptyAgentDir();
		await writeJson(path.join(agentDir, "permissions.json"), {
			profiles: { scout: { tools: ["read", "irc"], denyPaths: ["vault/**"] } },
		});
		const loaded = await loadPermissionProfiles(cwd, { agentDir });
		const parent = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "parent",
			actorKind: "sub",
			request: { profiles: ["scout", "secrets-blind"] },
			profiles: loaded.profiles,
			profileIdentities: loaded.profileIdentities,
		});
		if (!parent.ok) throw new Error(parent.error);
		const child = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "child",
			actorKind: "sub",
			parentId: "parent",
			request: { profiles: ["read-only"] },
			inherited: parent.value,
			profiles: loaded.profiles,
			profileIdentities: loaded.profileIdentities,
		});
		if (!child.ok) throw new Error(child.error);

		expect(child.value.profiles).toEqual(["scout", "secrets-blind", "read-only"]);
		expect(child.value.provenance.profiles.map(identity => [identity.name, identity.source])).toEqual([
			["scout", "user"],
			["secrets-blind", "built-in"],
			["read-only", "built-in"],
		]);
		expect(child.value.provenance.profiles[0]?.canonicalSha256).toBe(loaded.profileIdentities.scout?.canonicalSha256);
		expect(child.value.guardrails.secretsBlind).toBe(true);
	});
});
