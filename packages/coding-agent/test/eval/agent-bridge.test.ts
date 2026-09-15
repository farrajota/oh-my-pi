import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	runEvalAgent,
	type EvalAgentBridgeOptions,
	type EvalAgentResult,
} from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import {
	disposeAgentLifecycle,
	getAgentLifecycleManager,
	registerToolSessionLifecycleAuthority,
	resetAgentLifecycleForTests,
} from "../../src/internal/agent-lifecycle-bridge";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	installSessionOperationLedger,
	markUnregisteredSessionOperationProjection,
} from "@oh-my-pi/pi-coding-agent/registry/operation-lease";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult, StructuredSubagentOutput } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";

interface SessionOperationLedgerControl {
	close(): Promise<void>;
}

const jobManagers = new Set<AsyncJobManager>();
const operationLedgers = new Set<SessionOperationLedgerControl>();
const lifecycleManagers = new Set<AgentLifecycleManager>();

function isEvalAgentResult(value: unknown): value is EvalAgentResult {
	return (
		value !== null &&
		typeof value === "object" &&
		"details" in value &&
		"text" in value &&
		typeof value.text === "string" &&
		value.details !== null &&
		typeof value.details === "object"
	);
}

async function runEvalAgentAndWait(args: unknown, options: EvalAgentBridgeOptions): Promise<EvalAgentResult> {
	const manager = options.session.asyncJobManager;
	if (!manager) throw new Error("Eval fixture requires a session async job manager");
	jobManagers.add(manager);
	const handle = await runEvalAgent(args, options);
	const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, options);
	const snapshot = waited.items[0];
	if (!snapshot || snapshot.status === "running") throw new Error(`Agent handle ${handle.id} did not settle`);
	if (snapshot.status === "failed" || snapshot.status === "cancelled") {
		throw new Error(snapshot.error || `Agent handle ${handle.id} failed`);
	}
	const result = manager.getJob(handle.id)?.latestDetails?.evalResult;
	if (!isEvalAgentResult(result)) throw new Error(`Agent handle ${handle.id} returned no eval result`);
	return result;
}

const authoritySessions = new Set<AgentSession>();

async function createFixtureSession(options: {
	sessionManager?: SessionManager;
	settings?: Settings;
	asyncJobManager?: AsyncJobManager;
} = {}): Promise<ToolSession> {
	const settings = options.settings ?? Settings.isolated({ "task.isolation.enabled": false });
	const sessionManager = options.sessionManager ?? SessionManager.inMemory("/tmp");
	const operationLedger = installSessionOperationLedger(sessionManager);
	operationLedgers.add(operationLedger);
	markUnregisteredSessionOperationProjection(sessionManager, false);
	const asyncJobManager = options.asyncJobManager ?? new AsyncJobManager({});
	jobManagers.add(asyncJobManager);
	const registry = new AgentRegistry();
	const lifecycleManager = getAgentLifecycleManager(registry);
	lifecycleManagers.add(lifecycleManager);
	const root = await createAgentRootSession(registry, {
		agentId: "Main",
		agentDisplayName: "Main",
		cwd: "/tmp",
		agentDir: "/tmp",
		settings,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
		skipPythonPreflight: true,
	});
	authoritySessions.add(root.session);
	const authorityBinding = bindInternalAgentAuthoritySession(registry, root.session);
	if (!authorityBinding) throw new Error("Eval fixture requires a live parent-bound authority session.");
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings,
		sessionManager,
		asyncJobManager,
		agentRegistry: registry,
		createAuthoritySession: (childOptions, reviveRef) => authorityBinding.create(childOptions, reviveRef),
		getSessionSpawns: () => "*",
		getSessionFile: () => null,
		getSessionId: () => "test-session",
		getAgentId: () => "Main",
	} satisfies ToolSession;
	registerToolSessionLifecycleAuthority(session, registry, root.session);
	return session;
}

function createResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Task",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function createUsage(output: number) {
	return {
		input: 9_000,
		output,
		cacheRead: 8_000,
		cacheWrite: 7_000,
		totalTokens: 24_000 + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function createBudgetSession(sessionManager: SessionManager, settings?: Settings): Promise<ToolSession> {
	const session = await createFixtureSession({ sessionManager, settings });
	Object.assign(session, {
		getTurnBudget: () => sessionManager.getTurnBudget(),
		recordEvalSubagentUsage: (output: number) => sessionManager.recordEvalSubagentOutput(output),
	});
	return session;
}

describe("runEvalAgent", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([...jobManagers].map(manager => manager.dispose()));
		jobManagers.clear();
		await Promise.all([...lifecycleManagers].map(manager => disposeAgentLifecycle(manager)));
		lifecycleManagers.clear();
		await Promise.all([...authoritySessions].map(session => session.dispose()));
		authoritySessions.clear();
		await Promise.all([...operationLedgers].map(ledger => ledger.close()));
		operationLedgers.clear();
		resetAgentLifecycleForTests();
	});

	it("forwards session-scoped MCP and local protocol options", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

		const mcpManager = { sentinel: "mcp" } as unknown as MCPManager;
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => "/tmp/parent-artifacts",
			getSessionId: () => "parent-session",
		};
		const session = await createFixtureSession();
		Object.assign(session, {
			mcpManager,
			localProtocolOptions,
			getAgentId: () => "BridgeParent",
		});

		await runEvalAgentAndWait({ prompt: "do work", agent: "task" }, { session });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const options = runSubprocessSpy.mock.calls[0]?.[0];
		expect(options?.mcpManager).toBe(mcpManager);
		expect(options?.localProtocolOptions).toBe(localProtocolOptions);
		expect(options?.parentAgentId).toBe("BridgeParent");
	});

	it("returns executor-parsed structured data through the public eval bridge", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
			output: { type: "object" },
		};
		const structuredOutput: StructuredSubagentOutput = {
			source: "agent",
			mode: "strict",
			status: "valid",
			data: { status: "ok" },
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ output: "not JSON", structuredOutput }));
		const session = await createFixtureSession();

		const result = await runEvalAgentAndWait({ prompt: "do work", agent: "task", schemaMode: "strict" }, { session });

		expect(result.data).toEqual({ status: "ok" });
		expect(result.details).toMatchObject({ structured: true, schemaSource: "agent", schemaMode: "strict" });
	});

	it("updates the real turn budget by output tokens only", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(100_000, true);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ usage: createUsage(1_234) }));

		await runEvalAgentAndWait({ prompt: "do work", agent: "task" }, { session: await createBudgetSession(sessionManager) });

		expect(sessionManager.getTurnBudget()).toEqual({
			total: 100_000,
			spent: 1_234,
			hard: true,
		});
	});

	it("charges output exactly once when an eval-spawned subagent returns an error", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(100_000, false);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(
			createResult({
				exitCode: 1,
				error: "agent failed",
				stderr: "agent failed",
				usage: createUsage(2_345),
			}),
		);

		await expect(
			runEvalAgentAndWait({ prompt: "do work", agent: "task" }, { session: await createBudgetSession(sessionManager) }),
		).rejects.toThrow("agent failed");

		expect(sessionManager.getTurnBudget().spent).toBe(2_345);
	});

	it("charges isolated output before a later cleanup failure", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const sessionManager = SessionManager.inMemory();
		sessionManager.beginTurnBudget(100_000, true);
		const session = await createBudgetSession(
			sessionManager,
			Settings.isolated({ "task.isolation.enabled": true }),
		);
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
			baseline: {
				root: {
					repoRoot: "/tmp",
					headCommit: "base",
					staged: "",
					unstaged: "",
					untracked: [],
					untrackedPatch: "",
				},
				nested: [],
			},
		});
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
			options.onSubprocessResult?.(createResult({ usage: createUsage(4_567) }));
			throw new Error("cleanup failed");
		});

		await expect(
			runEvalAgentAndWait({ prompt: "do work", agent: "task", isolated: true }, { session }),
		).rejects.toThrow("cleanup failed");

		expect(sessionManager.getTurnBudget().spent).toBe(4_567);
	});

	it("does not route ordinary task subagents through the eval budget accumulator", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		const recordEvalSubagentUsage = vi.fn();
		const session = await createFixtureSession();
		Object.assign(session, { recordEvalSubagentUsage });
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult({ usage: createUsage(3_456) }));

		await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "do work",
			agent: "task",
		});

		expect(recordEvalSubagentUsage).not.toHaveBeenCalled();
	});
});
