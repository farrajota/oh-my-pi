import { afterEach, describe, expect, test, vi } from "bun:test";
import { type } from "arktype";
import { Settings } from "../../config/settings";
import type { SettingPath } from "../../config/settings-schema";
import type { PlanModeState } from "../../plan-mode/state";
import type { ToolSession } from "../../tools";
import * as taskDiscovery from "../discovery";
import * as executor from "../executor";
import { TaskTool } from "../index";
import { type AgentDefinition, getTaskSchema, type SingleResult } from "../types";

const PLAN_PROFILE_FAILURE =
	'Plan mode cannot spawn agent "synthetic" because its explicit tools do not intersect the plan profile.';

function makeAgent(tools?: string[]): AgentDefinition {
	return {
		name: "synthetic",
		description: "Synthetic test agent",
		systemPrompt: "Do the work.",
		source: "project",
		model: [],
		...(tools !== undefined ? { tools } : {}),
	};
}

function makeResult(agent: AgentDefinition): SingleResult {
	return {
		index: 0,
		id: "SyntheticChild",
		agent: agent.name,
		agentSource: agent.source,
		task: "Do the work.",
		assignment: "Do the work.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
	};
}

function makeSession(
	settingsOverrides: Partial<Record<SettingPath, unknown>> = {},
	sessionOverrides: Partial<ToolSession> = {},
): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": false,
		"task.enableLsp": true,
		"task.isolation.mode": "none",
		"task.maxConcurrency": 4,
		"task.permissions.mode": "off",
		"task.permissions.paths.enabled": true,
		"task.permissions.tools.enabled": true,
		...settingsOverrides,
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "task-index-test",
		getEvalSessionId: () => "task-index-eval-test",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		...sessionOverrides,
	} as ToolSession;
}

async function makeTaskTool(agent: AgentDefinition, session: ToolSession): Promise<TaskTool> {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	return TaskTool.create(session);
}

describe("TaskTool toolProfile schema", () => {
	test("flat schema accepts toolProfile", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});

		expect(schema({ agent: "synthetic", assignment: "read", toolProfile: "inspect" }) instanceof type.errors).toBe(
			false,
		);
	});

	test("batch item schema accepts toolProfile", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: true,
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});

		expect(
			schema({
				agent: "synthetic",
				context: "Shared context",
				tasks: [{ assignment: "review", toolProfile: "review" }],
			}) instanceof type.errors,
		).toBe(false);
	});

	test("schema rejects unknown toolProfile values", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});

		expect(schema({ agent: "synthetic", assignment: "read", toolProfile: "full" }) instanceof type.errors).toBe(true);
	});
});

describe("TaskTool toolProfile execution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("plan mode intersects explicit agent tools with the plan profile", async () => {
		const agent = makeAgent(["read"]);
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(makeResult(agent));
		const taskTool = await makeTaskTool(
			agent,
			makeSession(undefined, { getPlanModeState: () => ({ enabled: true }) as PlanModeState }),
		);

		await taskTool.execute("tool-call", { agent: "synthetic", assignment: "read" });

		expect(runSpy.mock.calls[0]?.[0].agent.tools).toEqual(["read"]);
	});

	test("plan mode fails when explicit agent tools do not intersect the plan profile", async () => {
		const taskTool = await makeTaskTool(
			makeAgent(["write"]),
			makeSession(undefined, { getPlanModeState: () => ({ enabled: true }) as PlanModeState }),
		);

		const result = await taskTool.execute("tool-call", { agent: "synthetic", assignment: "read" });

		expect(result.content).toEqual([{ type: "text", text: PLAN_PROFILE_FAILURE }]);
		expect(result.details?.results).toEqual([]);
	});

	test("permissions narrow an edit toolProfile without re-adding edit or write", async () => {
		const agent = makeAgent();
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(makeResult(agent));
		const taskTool = await makeTaskTool(agent, makeSession({ "task.permissions.mode": "enforce" }));

		await taskTool.execute("tool-call", {
			agent: "synthetic",
			assignment: "read",
			toolProfile: "edit",
			permissions: { profiles: ["read-only"] },
		});

		const tools = runSpy.mock.calls[0]?.[0].agent.tools?.filter(tool => tool !== "irc");
		expect(tools).toEqual(["read", "grep", "glob"]);
		expect(tools).not.toEqual(expect.arrayContaining(["edit", "write"]));
	});

	test("permissions do not widen toolProfile none", async () => {
		const agent = makeAgent();
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(makeResult(agent));
		const taskTool = await makeTaskTool(agent, makeSession({ "task.permissions.mode": "enforce" }));

		await taskTool.execute("tool-call", {
			agent: "synthetic",
			assignment: "read",
			toolProfile: "none",
			permissions: { profiles: ["focused-edit"] },
		});

		expect(runSpy.mock.calls[0]?.[0].agent.tools?.filter(tool => tool !== "irc")).toEqual([]);
	});
});
