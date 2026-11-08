/**
 * A streamed batch item does not start speculatively when it carries `permissions` or `toolProfile`,
 * or when the calling session runs under an enforce scope: those spawns wait for dispatch, which
 * composes and checks the scope against the finished call. Design 7, step 16.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const sink: SpeculativeOperationSink = {
	maxInFlight: 2,
	admit: async () => undefined,
	authorizeLaunch: async () => ({ allowed: true }),
	close: () => {},
};

const toolCall: AgentToolCall = { type: "toolCall", id: "tc-spec", name: "task", arguments: {} };
const managers: AsyncJobManager[] = [];
const roots: string[] = [];
let started: string[] = [];

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

beforeEach(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-refusal-"));
	roots.push(root);
	setAgentDir(path.join(root, "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	started = [];
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		started.push(options.id);
		return result(options.id);
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	__resetDirsFromEnvForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/**
 * Stream `args` in full, then adopt the launches as dispatch would for `spawns` (the call's spawn
 * params). Adoption waits for every queued launch, so the count is final: how many items started early.
 */
async function launchedEarly(
	settings: Settings,
	args: Record<string, unknown>,
	spawns: readonly Record<string, unknown>[],
): Promise<number> {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
	const tool = await TaskTool.create(session);
	const launch = (await tool.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id })) as
		| TaskLaunchSession
		| undefined;
	if (!launch) throw new Error("expected a task launch session");
	launch.update(toolCall, JSON.stringify(args));
	const adopted = await launch.adopt(spawns);
	// Let an adopted run finish here, so its executor call cannot land in a later test.
	for (const run of adopted.values()) await run.result;
	return adopted.size;
}

function batchSettings(mode: "off" | "suggest" | "enforce"): Settings {
	return Settings.isolated({ "async.enabled": true, "task.batch": true, "task.permissions.mode": mode });
}

const item = { name: "Alpha", agent: "task", task: "Do A.", solutionSpace: "s" };
const plain = { context: "ctx", tasks: [item] };
/** The spawn params dispatch derives from a one-item batch (see `spawnParamsFor`). */
const spawnOf = (extra: Record<string, unknown> = {}) => [{ ...item, context: "ctx", ...extra }];

describe("speculative launch under subagent permissions", () => {
	it("starts a plain streamed item early", async () => {
		expect(await launchedEarly(batchSettings("enforce"), plain, spawnOf())).toBe(1);
	});

	it("does not start an item that carries permissions, under enforce or suggest", async () => {
		const permissions = { profiles: ["read-only"] };
		for (const mode of ["enforce", "suggest"] as const) {
			const args = { context: "ctx", tasks: [{ ...item, permissions }] };
			expect(await launchedEarly(batchSettings(mode), args, spawnOf({ permissions }))).toBe(0);
		}
		expect(started).toEqual([]);
	});

	it("does not start an item that carries a toolProfile", async () => {
		const args = { context: "ctx", tasks: [{ ...item, toolProfile: "inspect" }] };
		expect(await launchedEarly(batchSettings("enforce"), args, spawnOf({ toolProfile: "inspect" }))).toBe(0);
		expect(started).toEqual([]);
	});

	it("does not start any item from a session under an enforce scope", async () => {
		const settings = scopedSettings(enforceScope({ tools: ["read", "task"] }), {
			"async.enabled": true,
			"task.batch": true,
			"task.permissions.mode": "enforce",
		});
		expect(await launchedEarly(settings, plain, spawnOf())).toBe(0);
		expect(started).toEqual([]);
	});
});
