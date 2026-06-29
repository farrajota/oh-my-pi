import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "arktype";
import { Settings } from "../../config/settings";
import * as taskDiscovery from "../discovery";
import { TaskTool } from "../index";
import { getTaskSchema, type AgentDefinition, type TaskToolSchemaInstance } from "../types";
import type { ToolSession } from "../../tools";

const DISABLED_PERMISSIONS_ERROR =
	"Subagent permissions are disabled. Enable task.permissions.mode in /settings before using `permissions`.";

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
}

function schemaWithPermissions(options: SchemaOptions) {
	return getTaskSchema({
		isolationEnabled: false,
		batchEnabled: false,
		permissions: {
			enabled: true,
			toolsEnabled: options.toolsEnabled,
			pathsEnabled: options.pathsEnabled,
		},
	});
}

function disabledSchema() {
	return getTaskSchema({
		isolationEnabled: false,
		batchEnabled: false,
		permissions: { enabled: false, toolsEnabled: false, pathsEnabled: false },
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

function makeSession(settings: Settings): ToolSession {
	return {
		cwd: process.cwd(),
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

async function makeTaskTool(settings: Settings): Promise<TaskTool> {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	return TaskTool.create(makeSession(settings));
}

describe("task permission schema", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits permissions when disabled", () => {
		const schema = disabledSchema();

		expect(accepts(schema, { agent: "task", assignment: "read" })).toBe(true);
		expect(
			parse(schema, {
				agent: "task",
				assignment: "read",
				permissions: { profiles: ["read-only"] },
			}),
		).toEqual({ agent: "task", assignment: "read" });
	});

	it("includes profiles, tool fields, and path fields when both dimensions are enabled", () => {
		const schema = schemaWithPermissions({ toolsEnabled: true, pathsEnabled: true });

		expect(
			accepts(schema, {
				agent: "task",
				assignment: "read",
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
				assignment: "read",
				permissions: { tools: "read" },
			}),
		).toBe(false);
	});

	it("includes only profile and tool fields when paths are disabled", () => {
		const schema = schemaWithPermissions({ toolsEnabled: true, pathsEnabled: false });

		expect(
			parse(schema, {
				agent: "task",
				assignment: "read",
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
			assignment: "read",
			permissions: {
				profiles: ["focused-edit"],
				tools: ["read"],
				denyTools: ["bash"],
			},
		});
	});

	it("includes only profile and path fields when tools are disabled", () => {
		const schema = schemaWithPermissions({ toolsEnabled: false, pathsEnabled: true });

		expect(
			parse(schema, {
				agent: "task",
				assignment: "read",
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
			assignment: "read",
			permissions: {
				profiles: ["focused-edit"],
				allowPaths: ["src/task/**"],
				denyPaths: [".taskmaster/**"],
			},
		});
	});

	it("rejects stale flat permissions through TaskTool.execute when disabled", async () => {
		const taskTool = await makeTaskTool(
			Settings.isolated({
				"async.enabled": false,
				"task.batch": false,
				"task.isolation.mode": "none",
				"task.enableLsp": true,
				"task.permissions.mode": "off",
				"task.permissions.tools.enabled": true,
				"task.permissions.paths.enabled": true,
			}),
		);

		const result = await taskTool.execute("tool-call", {
			agent: "task",
			assignment: "read",
			permissions: { profiles: ["read-only"] },
		});

		expect(result.content).toEqual([{ type: "text", text: DISABLED_PERMISSIONS_ERROR }]);
		expect(result.details?.results).toEqual([]);
	});

	it("rejects stale batch item permissions through TaskTool.execute when disabled", async () => {
		const taskTool = await makeTaskTool(
			Settings.isolated({
				"async.enabled": false,
				"task.batch": true,
				"task.isolation.mode": "none",
				"task.enableLsp": true,
				"task.permissions.mode": "off",
				"task.permissions.tools.enabled": true,
				"task.permissions.paths.enabled": true,
			}),
		);

		const result = await taskTool.execute("tool-call", {
			agent: "task",
			context: "Shared context",
			tasks: [{ assignment: "read", permissions: { profiles: ["read-only"] } }],
		});

		expect(result.content).toEqual([{ type: "text", text: DISABLED_PERMISSIONS_ERROR }]);
		expect(result.details?.results).toEqual([]);
	});
});
