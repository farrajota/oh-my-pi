/**
 * A child spawned from a subagent that runs under a permission scope inherits that scope, whichever
 * route spawns it: the task tool, eval `agent()`, `workpool()`, or a path that skips composition and
 * reads its parent's settings through (vibe, the isolation runner). A request can only narrow the
 * inherited scope (C20), and a live mode change never lifts it. Design 7, step 14.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { isScopeNoBroader } from "@oh-my-pi/pi-coding-agent/task/permissions/compose";
import { activePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/guard";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPool, WorkPoolRegistry } from "@oh-my-pi/pi-coding-agent/task/workpool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../../helpers/session-defaults";
import { enforceScope, scopedSettings } from "./scope-fixtures";

const PARENT_ID = "ScopedParent";
const AGENT: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
};

/** The restricted parent: may read and delegate, nothing else, and never `secret`. */
const PARENT_SCOPE: PermissionScope = enforceScope({
	actorId: PARENT_ID,
	profiles: ["read-only"],
	tools: ["read", "task"],
	denyTools: ["web_search"],
	denyPathGroups: [["secret"]],
});

const roots: string[] = [];
const managers: AsyncJobManager[] = [];

beforeEach(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inherit-scope-"));
	roots.push(root);
	setAgentDir(path.join(root, "agent"));
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
	WorkPoolRegistry.resetForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	__resetDirsFromEnvForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function result(options: executorModule.ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
	};
}

function captureSpawns(): executorModule.ExecutorOptions[] {
	const spawns: executorModule.ExecutorOptions[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		spawns.push(options);
		return result(options);
	});
	return spawns;
}

function parentSession(settings: Settings, extra: Partial<ToolSession> = {}): ToolSession {
	const asyncJobManager = new AsyncJobManager({ retentionMs: 0 });
	managers.push(asyncJobManager);
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		taskDepth: 1,
		asyncJobManager,
		getAgentId: () => PARENT_ID,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "inherit-scope-test",
		...extra,
	} as ToolSession;
}

function restrictedParent(overrides: Record<string, unknown> = {}): Settings {
	return scopedSettings(PARENT_SCOPE, {
		"async.enabled": false,
		"task.batch": false,
		"task.isolation.enabled": false,
		"task.permissions.mode": "enforce",
		...overrides,
	});
}

function expectInherited(scope: PermissionScope | undefined, childId: string | undefined): void {
	expect(scope).toBeDefined();
	expect(scope?.mode).toBe("enforce");
	expect(scope?.inherited).toBe(true);
	expect(scope?.actorId).toBe(childId);
	expect(scope?.parentId).toBe(PARENT_ID);
	expect(isScopeNoBroader(PARENT_SCOPE, scope!)).toBe(true);
}

describe("a task spawn from a restricted subagent", () => {
	it("inherits the parent scope unchanged when the call names no permissions", async () => {
		const spawns = captureSpawns();
		const tool = await TaskTool.create(parentSession(restrictedParent()));

		await tool.execute("call", { agent: "task", task: "Look around." });

		const scope = spawns[0]?.permissionScope;
		expectInherited(scope, spawns[0]?.id);
		expect(scope?.tools).toEqual(["read", "task"]);
		expect(scope?.denyPathGroups).toEqual([["secret"]]);
		expect(scope?.profiles).toEqual(["read-only"]);
	});

	it("narrows a broader request to the parent's allowlist instead of widening it", async () => {
		const spawns = captureSpawns();
		const tool = await TaskTool.create(parentSession(restrictedParent()));

		await tool.execute("call", {
			agent: "task",
			task: "Edit things.",
			permissions: { tools: ["read", "write", "bash", "web_search"], allowPaths: ["src"] },
		});

		const scope = spawns[0]?.permissionScope;
		expectInherited(scope, spawns[0]?.id);
		expect(scope?.tools).toEqual(["read"]);
		expect(scope?.denyTools).toEqual(["web_search"]);
		expect(scope?.allowPathGroups).toEqual([["src"]]);
		expect(scope?.denyPathGroups).toEqual([["secret"]]);
	});

	it("keeps the parent's enforce scope when the live mode is suggest or off", async () => {
		const spawns = captureSpawns();
		for (const mode of ["suggest", "off"] as const) {
			const tool = await TaskTool.create(parentSession(restrictedParent({ "task.permissions.mode": mode })));

			await tool.execute("call", { agent: "task", task: "Look around." });
		}

		expect(spawns).toHaveLength(2);
		for (const spawn of spawns) expectInherited(spawn.permissionScope, spawn.id);
	});
});

describe("an eval agent() from a restricted subagent", () => {
	it("inherits the parent scope under its own id", async () => {
		const spawns = captureSpawns();
		const session = parentSession(restrictedParent());

		const handle = await runEvalAgent({ prompt: "Look around." }, { session });
		await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });

		expect(spawns).toHaveLength(1);
		expectInherited(spawns[0]?.permissionScope, handle.id);
		expect(spawns[0]?.permissionScope?.tools).toEqual(["read", "task"]);
	});
});

describe("a workpool() worker from a restricted subagent", () => {
	it("inherits the parent scope under its own id", async () => {
		const spawns = captureSpawns();
		const session = parentSession(restrictedParent({ "task.maxConcurrency": 1, "task.maxRuntimeMs": 0 }));
		AgentRegistry.global().register({
			id: PARENT_ID,
			displayName: PARENT_ID,
			kind: "sub",
			status: "running",
			session: { emitIrcRelayObservation: () => {} } as unknown as AgentSession,
		});
		const pool = new WorkPool(session, {
			name: "review",
			policy: {
				discovery: { agents: [AGENT], projectAgentsDir: null },
				agentName: "task",
				agent: AGENT,
				effectiveAgent: AGENT,
				structured: true,
				schema: { schema: undefined, source: "none", mode: "permissive", outputSchemaOverridesAgent: false },
				planMode: false,
				isIsolated: false,
				mergeMode: "patch",
				applyChanges: true,
				enableLsp: false,
				enableIrc: false,
			},
		});

		pool.push(["one"]);
		await session.asyncJobManager?.getJob(pool.name)?.promise;

		expect(spawns).toHaveLength(1);
		expectInherited(spawns[0]?.permissionScope, spawns[0]?.id);
	});
});

function yieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-1",
					toolName: "yield",
					result: { content: [{ type: "text", text: "done" }], details: { status: "success", data: {} } },
					isError: false,
				});
			}
			return true;
		},
	} as unknown as AgentSession;
}

describe("a spawn that skips composition (vibe, isolation runner)", () => {
	it("reads the parent's scope through its settings and starts narrowed to it", async () => {
		const created = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: yieldingSession(),
			extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);

		const run = await executorModule.runSubprocess({
			cwd: process.cwd(),
			agent: { ...AGENT, tools: ["read", "write", "bash", "task"] },
			task: "vibe worker",
			index: 0,
			id: "VibeWorker",
			settings: restrictedParent(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
		});

		expect(run.exitCode).toBe(0);
		const options = created.mock.calls[0]?.[0];
		const active = options?.settings ? activePermissionScope(options.settings) : undefined;
		expect(active?.ok && active.scope.tools).toEqual(["read", "task"]);
		expect(options?.toolNames).toEqual(["read", "task"]);
		expect(options?.restrictToolNames).toBe(true);
	});
});
