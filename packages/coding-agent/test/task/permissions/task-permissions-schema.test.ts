/**
 * The task tool's permission fields follow `task.permissions.*`: `permissions` and `toolProfile` are
 * advertised only while the mode is not `off`, each permission dimension only while it is enabled,
 * a stale field is refused while the mode is `off`, and the description lists user-level profiles
 * only while the feature is on. Ported from the fork's task-permissions-schema suite.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import {
	cfgTaskPermissionsMode,
	cfgTaskPermissionsPathsEnabled,
	cfgTaskPermissionsToolsEnabled,
} from "@oh-my-pi/pi-coding-agent/task/permissions/settings";
import { type AgentDefinition, getTaskSchema, type TaskToolSchemaInstance } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const DISABLED_PERMISSIONS_ERROR =
	"Subagent permissions are disabled. Enable task.permissions.mode in /settings before using `permissions`.";
const DISABLED_TOOL_PROFILE_ERROR =
	"Subagent permissions are disabled. Enable task.permissions.mode in /settings before using `toolProfile`.";

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["pi/task"],
} satisfies AgentDefinition;

interface SchemaOptions {
	toolsEnabled: boolean;
	pathsEnabled: boolean;
	batchEnabled?: boolean;
}

function schemaWithPermissions(options: SchemaOptions) {
	return getTaskSchema({
		isolationEnabled: false,
		batchEnabled: options.batchEnabled ?? false,
		defaultAgent: "task",
		permissions: { enabled: true, toolsEnabled: options.toolsEnabled, pathsEnabled: options.pathsEnabled },
	});
}

function disabledSchema() {
	return getTaskSchema({
		isolationEnabled: false,
		batchEnabled: false,
		defaultAgent: "task",
		permissions: { enabled: false, toolsEnabled: true, pathsEnabled: true },
	});
}

function accepts(schema: TaskToolSchemaInstance, value: unknown): boolean {
	return !(schema(value) instanceof type.errors);
}

function parse(schema: TaskToolSchemaInstance, value: unknown): unknown {
	const result = schema(value);
	expect(result instanceof type.errors).toBe(false);
	return result;
}

function makeSession(settings: Settings, cwd = process.cwd()): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "task-permissions-schema-test",
		getEvalSessionId: () => "task-permissions-schema-eval-test",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
	};
}

async function makeTaskTool(settings: Settings, cwd?: string): Promise<TaskTool> {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	return TaskTool.create(makeSession(settings, cwd));
}

afterEach(() => {
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
});

describe("task permission settings", () => {
	it("keeps the fork's ids, values and defaults", () => {
		const settings = Settings.isolated();
		expect(cfgTaskPermissionsMode.get(settings)).toBe("off");
		expect(cfgTaskPermissionsMode.enumValues).toEqual(["off", "suggest", "enforce"]);
		expect(cfgTaskPermissionsToolsEnabled.get(settings)).toBe(true);
		expect(cfgTaskPermissionsPathsEnabled.get(settings)).toBe(true);
		const configured = Settings.isolated({
			"task.permissions.mode": "suggest",
			"task.permissions.tools.enabled": false,
			"task.permissions.paths.enabled": false,
		});
		expect(cfgTaskPermissionsMode.get(configured)).toBe("suggest");
		expect(cfgTaskPermissionsToolsEnabled.get(configured)).toBe(false);
		expect(cfgTaskPermissionsPathsEnabled.get(configured)).toBe(false);
	});

	it("describes suggest as advisory: offered and recorded, nothing restricted", () => {
		const options = cfgTaskPermissionsMode.ui?.options;
		if (!Array.isArray(options)) throw new Error("task.permissions.mode has no option list");
		const suggest = options.find(option => option.value === "suggest");
		expect(suggest?.description).toBe(
			"Advisory only: profiles are offered to the model and recorded on the spawn; nothing is restricted (no startup narrowing, no per-call checks)",
		);
		const enforce = options.find(option => option.value === "enforce");
		expect(enforce?.description).toContain("only subagents spawned with `permissions` or `toolProfile`");
	});
});

describe("task description permission profiles", () => {
	it("shows user-level profiles only while subagent permissions are enabled", async () => {
		const root = TempDir.createSync("@omp-task-user-profiles-");
		try {
			const cwd = root.join("project");
			const agentDir = root.join("agent");
			await fs.mkdir(cwd, { recursive: true });
			await Bun.write(
				path.join(agentDir, "permissions.json"),
				JSON.stringify({
					profiles: {
						"user-only-scout": { description: "User scout", tools: ["read"] },
						"no-network": { tools: ["browser"] },
					},
				}),
			);
			setAgentDir(agentDir);
			const settings = Settings.isolated({ "task.permissions.mode": "off" });
			const taskTool = await makeTaskTool(settings, cwd);

			expect(taskTool.description).not.toContain("user-only-scout");
			expect(taskTool.description).not.toContain("Profile config errors");
			expect(taskTool.description).not.toContain("`permissions`");

			cfgTaskPermissionsMode.override(settings, "enforce");

			expect(taskTool.description).toContain("# user-only-scout");
			expect(taskTool.description).toContain(
				'permissions.json: permission profile "no-network" is reserved and cannot be overridden',
			);
			expect(taskTool.description).toContain("`permissions`");
			expect(taskTool.description).toContain("`toolProfile`");
		} finally {
			root.removeSync();
		}
	});

	it("describes suggest as advisory and enforce as restricting only profiled spawns", async () => {
		const settings = Settings.isolated({ "task.permissions.mode": "suggest" });
		const taskTool = await makeTaskTool(settings);

		expect(taskTool.description).toContain("Mode `suggest`: advisory");
		cfgTaskPermissionsMode.override(settings, "enforce");
		expect(taskTool.description).toContain("Mode `enforce`");
		expect(taskTool.description).toContain("A spawn without `permissions` or `toolProfile` is not restricted.");
	});
});

describe("task permission schema", () => {
	it("omits permissions and toolProfile when disabled", () => {
		const schema = disabledSchema();

		expect(accepts(schema, { agent: "task", task: "read", solutionSpace: "focused" })).toBe(true);
		expect(
			parse(schema, {
				agent: "task",
				task: "read",
				solutionSpace: "focused",
				permissions: { profiles: ["read-only"] },
				toolProfile: "inspect",
			}),
		).toEqual({ agent: "task", task: "read", solutionSpace: "focused" });
	});

	it("includes profiles, tool fields, and path fields when both dimensions are enabled", () => {
		const schema = schemaWithPermissions({ toolsEnabled: true, pathsEnabled: true });

		expect(
			accepts(schema, {
				agent: "task",
				task: "read",
				solutionSpace: "focused",
				toolProfile: "inspect",
				permissions: {
					profiles: ["focused-edit"],
					tools: ["read"],
					denyTools: ["bash"],
					allowPaths: ["src/task/**"],
					denyPaths: [".taskmaster/**"],
				},
			}),
		).toBe(true);
		expect(
			accepts(schema, {
				agent: "task",
				task: "read",
				solutionSpace: "focused",
				permissions: { tools: "read" },
			}),
		).toBe(false);
		expect(accepts(schema, { agent: "task", task: "read", solutionSpace: "focused", toolProfile: "full" })).toBe(
			false,
		);
	});

	it("includes only profile and tool fields when paths are disabled", () => {
		const schema = schemaWithPermissions({ toolsEnabled: true, pathsEnabled: false });

		expect(
			parse(schema, {
				agent: "task",
				task: "read",
				solutionSpace: "focused",
				permissions: {
					profiles: ["focused-edit"],
					tools: ["read"],
					denyTools: ["bash"],
					allowPaths: ["src/task/**"],
					denyPaths: [".taskmaster/**"],
				},
			}),
		).toEqual({
			agent: "task",
			task: "read",
			solutionSpace: "focused",
			permissions: {
				profiles: ["focused-edit"],
				tools: ["read"],
				denyTools: ["bash"],
			},
		});
	});

	it("includes only profile and path fields, and no toolProfile, when tools are disabled", () => {
		const schema = schemaWithPermissions({ toolsEnabled: false, pathsEnabled: true });

		expect(
			parse(schema, {
				agent: "task",
				task: "read",
				solutionSpace: "focused",
				toolProfile: "inspect",
				permissions: {
					profiles: ["focused-edit"],
					tools: ["read"],
					denyTools: ["bash"],
					allowPaths: ["src/task/**"],
					denyPaths: [".taskmaster/**"],
				},
			}),
		).toEqual({
			agent: "task",
			task: "read",
			solutionSpace: "focused",
			permissions: {
				profiles: ["focused-edit"],
				allowPaths: ["src/task/**"],
				denyPaths: [".taskmaster/**"],
			},
		});
	});

	it("carries permissions and toolProfile on batch items, and an omitted toolProfile stays absent", () => {
		const schema = schemaWithPermissions({ toolsEnabled: true, pathsEnabled: true, batchEnabled: true });

		expect(
			parse(schema, {
				context: "Shared context",
				tasks: [
					{ task: "review", solutionSpace: "focused review", toolProfile: "review" },
					{ task: "read", solutionSpace: "focused", permissions: { profiles: ["read-only"] } },
				],
			}),
		).toEqual({
			context: "Shared context",
			tasks: [
				{ agent: "task", task: "review", solutionSpace: "focused review", toolProfile: "review" },
				{ agent: "task", task: "read", solutionSpace: "focused", permissions: { profiles: ["read-only"] } },
			],
		});
	});

	it("rejects stale flat permissions through TaskTool.execute when disabled", async () => {
		const taskTool = await makeTaskTool(
			Settings.isolated({
				"async.enabled": false,
				"task.batch": false,
				"task.isolation.enabled": false,
				"task.enableLsp": true,
				"task.permissions.mode": "off",
				"task.permissions.tools.enabled": true,
				"task.permissions.paths.enabled": true,
			}),
		);

		const result = await taskTool.execute("tool-call", {
			agent: "task",
			task: "read",
			solutionSpace: "focused",
			permissions: { profiles: ["read-only"] },
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: DISABLED_PERMISSIONS_ERROR }]);
		expect(result.details?.results).toEqual([]);
	});

	it("rejects stale batch item permissions through TaskTool.execute when disabled", async () => {
		const taskTool = await makeTaskTool(
			Settings.isolated({
				"async.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				"task.enableLsp": true,
				"task.permissions.mode": "off",
				"task.permissions.tools.enabled": true,
				"task.permissions.paths.enabled": true,
			}),
		);

		const result = await taskTool.execute("tool-call", {
			context: "Shared context",
			tasks: [{ agent: "task", task: "read", solutionSpace: "focused", permissions: { profiles: ["read-only"] } }],
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: DISABLED_PERMISSIONS_ERROR }]);
		expect(result.details?.results).toEqual([]);
	});

	it("rejects a stale toolProfile through TaskTool.execute when disabled", async () => {
		const taskTool = await makeTaskTool(
			Settings.isolated({
				"async.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				"task.permissions.mode": "off",
			}),
		);

		const result = await taskTool.execute("tool-call", {
			context: "Shared context",
			tasks: [{ agent: "task", task: "read", solutionSpace: "focused", toolProfile: "none" }],
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: DISABLED_TOOL_PROFILE_ERROR }]);
	});

	it("advertises the permission fields on the live tool only while the mode is not off", async () => {
		const settings = Settings.isolated({ "task.batch": false, "task.permissions.mode": "off" });
		const taskTool = await makeTaskTool(settings);
		const item = {
			agent: "task",
			task: "read",
			solutionSpace: "focused",
			toolProfile: "inspect",
			permissions: { profiles: ["read-only"] },
		};

		expect(parse(taskTool.parameters, item)).toEqual({ agent: "task", task: "read", solutionSpace: "focused" });
		cfgTaskPermissionsMode.override(settings, "suggest");
		expect(parse(taskTool.parameters, item)).toEqual(item);
	});
});
