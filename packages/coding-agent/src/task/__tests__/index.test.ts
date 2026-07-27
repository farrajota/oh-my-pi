import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type } from "arktype";
import { Settings } from "../../config/settings";
import type { SettingPath } from "../../config/settings-schema";
import type { PlanModeState } from "../../plan-mode/state";
import type { ToolSession } from "../../tools";
import { EventBus } from "../../utils/event-bus";
import * as executor from "../executor";
import { TaskTool } from "../index";
import { type AgentDefinition, getTaskSchema, type SingleResult, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../types";

const temporaryRoots: string[] = [];

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
	const root = await mkdtemp(path.join(os.tmpdir(), "task-index-test-"));
	temporaryRoots.push(root);
	const agentsDir = path.join(root, ".omp", "agents");
	await mkdir(agentsDir, { recursive: true });
	const tools = agent.tools?.length ? `tools:\n${agent.tools.map(tool => `- ${tool}`).join("\n")}\n` : "";
	await writeFile(
		path.join(agentsDir, "synthetic.md"),
		`---\nname: synthetic\ndescription: Synthetic test agent\n${tools}---\nDo the work.\n`,
	);
	return TaskTool.create({ ...session, cwd: root } as ToolSession);
}

describe("TaskTool toolProfile schema", () => {
	test("flat schema accepts toolProfile", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			defaultAgent: "task",
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});

		expect(schema({ agent: "synthetic", task: "read", toolProfile: "inspect" }) instanceof type.errors).toBe(false);
	});

	test("batch item schema accepts toolProfile", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: true,
			defaultAgent: "task",
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});

		expect(
			schema({
				agent: "synthetic",
				context: "Shared context",
				tasks: [{ task: "review", toolProfile: "review" }],
			}) instanceof type.errors,
		).toBe(false);
	});

	test("schema rejects unknown toolProfile values", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			defaultAgent: "task",
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});

		expect(schema({ agent: "synthetic", task: "read", toolProfile: "full" }) instanceof type.errors).toBe(true);
	});
});

describe("TaskTool toolProfile execution", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
	});

	test("plan mode intersects explicit agent tools with the plan profile", async () => {
		const agent = makeAgent(["read"]);
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(makeResult(agent));
		const taskTool = await makeTaskTool(
			agent,
			makeSession(undefined, { getPlanModeState: () => ({ enabled: true }) as PlanModeState }),
		);

		await taskTool.execute("tool-call", { agent: "synthetic", task: "read" });

		expect(runSpy.mock.calls[0]?.[0].agent.tools).toEqual(["read", "grep", "glob", "lsp", "web_search"]);
	});

	test("plan mode preserves base planning tools when explicit agent tools do not intersect", async () => {
		const agent = makeAgent(["write"]);
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(makeResult(agent));
		const taskTool = await makeTaskTool(
			agent,
			makeSession(undefined, { getPlanModeState: () => ({ enabled: true }) as PlanModeState }),
		);

		await taskTool.execute("tool-call", { agent: "synthetic", task: "read" });

		expect(runSpy.mock.calls[0]?.[0].agent.tools).toEqual(["read", "grep", "glob", "lsp", "web_search"]);
	});

	test("permissions narrow an edit toolProfile without re-adding edit or write", async () => {
		const agent = makeAgent();
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(makeResult(agent));
		const taskTool = await makeTaskTool(agent, makeSession({ "task.permissions.mode": "enforce" }));

		await taskTool.execute("tool-call", {
			agent: "synthetic",
			task: "read",
			toolProfile: "edit",
			permissions: { profiles: ["read-only"] },
		});

		const tools = runSpy.mock.calls[0]?.[0].agent.tools?.filter(tool => tool !== "irc");
		expect(tools).toEqual(["read", "grep", "glob", "hub"]);
		expect(tools).not.toEqual(expect.arrayContaining(["edit", "write"]));
	});

	test("permissions do not widen toolProfile none", async () => {
		const agent = makeAgent();
		const runSpy = vi.spyOn(executor, "runSubprocess").mockResolvedValue(makeResult(agent));
		const taskTool = await makeTaskTool(agent, makeSession({ "task.permissions.mode": "enforce" }));

		await taskTool.execute("tool-call", {
			agent: "synthetic",
			task: "read",
			toolProfile: "none",
			permissions: { profiles: ["focused-edit"] },
		});

		expect(runSpy.mock.calls[0]?.[0].agent.tools?.filter(tool => tool !== "irc")).toEqual(["hub"]);
	});

	test("forwards synchronous child lifecycle events to the parent event bus", async () => {
		const agent = makeAgent();
		const eventBus = new EventBus();
		const lifecycleEvents: unknown[] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			lifecycleEvents.push(payload);
		});
		const runSpy = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			options.eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { status: "started" });
			options.eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { status: "completed" });
			return makeResult(agent);
		});
		const taskTool = await makeTaskTool(
			agent,
			makeSession({ "async.enabled": false }, { eventBus, getArtifactsDir: () => "/tmp/task-artifacts" }),
		);

		await taskTool.execute("tool-call", { agent: "synthetic", task: "read" });

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0].artifactsDir).toBe("/tmp/task-artifacts");

		expect(lifecycleEvents).toEqual([{ status: "started" }, { status: "completed" }]);
	});
});
