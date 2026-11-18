/**
 * A task item's top-level `tools` names eval-defined functions, while `permissions.tools` is the
 * built-in allowlist. Models read the first as an allowlist and send `tools: ["read"]`; the task
 * tool must answer with a corrective error that names the right fields, before any child starts.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const scoutAgent = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "Inspect and report.",
	source: "bundled",
	spawns: "*",
} satisfies AgentDefinition;

const PERMISSION_FIELDS_ERROR =
	"Task execution failed: `tools` names built-in tool(s): read. `tools` only hands the child functions you defined with @tool (Python) or tool(fn, {…}) (JS) in an eval cell. To limit the child's built-in tools, use `permissions.tools` or `toolProfile` instead.";
const AGENT_DEFINITION_ERROR =
	"Task execution failed: `tools` names built-in tool(s): read. `tools` only hands the child functions you defined with @tool (Python) or tool(fn, {…}) (JS) in an eval cell. The child's built-in tools come from its agent definition; leave them out of `tools`.";

function makeSession(settings: Settings): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		taskDepth: 0,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "eval-tools-builtin-names-test",
		getEvalSessionId: () => "eval-tools-builtin-names-eval-test",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
	};
}

const agentDirs: TempDir[] = [];

async function makeTaskTool(overrides: Record<string, unknown>): Promise<TaskTool> {
	// An empty agent dir keeps the developer's own permissions.json out of the description.
	const agentDir = TempDir.createSync("@omp-eval-tools-builtin-");
	agentDirs.push(agentDir);
	setAgentDir(agentDir.path());
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [scoutAgent], projectAgentsDir: null });
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		"task.permissions.mode": "enforce",
		...overrides,
	});
	return TaskTool.create(makeSession(settings));
}

/** The scout item gpt-6.2-sol sent on 2026-11-18, abridged. */
const scoutItem = {
	agent: "scout",
	name: "RulesListing",
	task: "List the rule files.",
	solutionSpace: "one listing",
	tools: ["read"],
	toolProfile: "inspect",
	permissions: { profiles: ["read-only"], tools: ["read"] },
};

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map(part => part.text ?? "").join("");
}

afterEach(() => {
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
	for (const dir of agentDirs.splice(0)) dir.removeSync();
});

describe("built-in tool names in a task item's eval `tools`", () => {
	it("returns_permission_fields_correction_for_batch_item_without_spawning", async () => {
		const spawn = vi.spyOn(executorModule, "runSubprocess");
		const taskTool = await makeTaskTool({ "task.batch": true });

		const result = await taskTool.execute("tool-call", { context: "Release rules", tasks: [scoutItem] });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(PERMISSION_FIELDS_ERROR);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("returns_permission_fields_correction_for_single_task_call", async () => {
		const spawn = vi.spyOn(executorModule, "runSubprocess");
		const taskTool = await makeTaskTool({ "task.batch": false });

		const result = await taskTool.execute("tool-call", scoutItem);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(PERMISSION_FIELDS_ERROR);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("returns_correction_instead_of_disabled_error_when_eval_tools_are_off", async () => {
		// Lenient argument validation keeps an undeclared root `tools`, so a single-task call
		// still carries it after `eval.tools.enabled: false` stops advertising the field.
		const taskTool = await makeTaskTool({ "task.batch": false, "eval.tools.enabled": false });

		const result = await taskTool.execute("tool-call", scoutItem);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(PERMISSION_FIELDS_ERROR);
	});

	it("points_at_agent_definition_when_permission_tool_fields_are_not_offered", async () => {
		const taskTool = await makeTaskTool({ "task.batch": false, "task.permissions.mode": "off" });

		const result = await taskTool.execute("tool-call", {
			agent: "scout",
			task: "List the rule files.",
			solutionSpace: "one listing",
			tools: ["read"],
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(AGENT_DEFINITION_ERROR);
	});

	it("keeps_unknown_eval_tool_error_for_names_that_are_not_built_in", async () => {
		const taskTool = await makeTaskTool({ "task.batch": false });

		const result = await taskTool.execute("tool-call", {
			agent: "scout",
			task: "Count words.",
			solutionSpace: "one count",
			tools: ["word_count"],
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toStartWith("Task execution failed: Unknown eval tool(s): word_count.");
	});
});

describe("task description for the eval `tools` field", () => {
	it("tells_the_model_to_restrict_built_in_tools_through_permissions", async () => {
		const taskTool = await makeTaskTool({ "task.batch": true });

		expect(taskTool.description).toContain(
			"- `tools`: names of functions you defined with @tool (Python) or tool(fn, {…}) (JS) in an eval cell; they run in your kernel. Never built-in tools. To limit built-in tools, use `permissions.tools` or `toolProfile`.\n",
		);
	});

	it("omits_permission_advice_when_permissions_are_off", async () => {
		const taskTool = await makeTaskTool({ "task.batch": true, "task.permissions.mode": "off" });

		expect(taskTool.description).toContain(
			"- `tools`: names of functions you defined with @tool (Python) or tool(fn, {…}) (JS) in an eval cell; they run in your kernel. Never built-in tools.\n",
		);
		expect(taskTool.description).not.toContain("`permissions.tools`");
	});
});
