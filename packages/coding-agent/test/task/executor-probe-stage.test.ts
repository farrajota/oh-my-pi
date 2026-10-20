/**
 * What the executor does with a completion-probe estimate and with each
 * finished tool call: the estimate's percentage, stage and watch hint land on
 * the published `AgentProgress` (the wait/task rows and the job widget read
 * them), a probe that resolves after the terminal `yield` keeps the bar at 99%
 * and the stage unchanged, and every finished tool call reaches
 * `onToolResult` with its intent and result text (the task job's `tools`
 * widget source).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as probeModule from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import { runSubprocess, type SubagentToolResult } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeAgentLifecycle, getAgentLifecycleManager } from "../../src/internal/agent-lifecycle-bridge";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

/** A session double that replays `script` from `prompt()`; the executor reads only this subset. */
function scriptedSession(script: (emit: (event: AgentSessionEvent) => void) => Promise<void>): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners.slice()) listener(event);
	};
	let aborted = false;
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {}, getArtifactManager: () => undefined },
		getActiveToolNames: () => ["bash", "yield"],
		getEnabledToolNames: () => ["bash", "yield"],
		getToolByName: () => undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			await script(emit);
			return true;
		},
		abort: async () => {
			aborted = true;
		},
		isAborted: () => aborted,
	};
	// Structural test double, as in executor-recent-output.test.ts.
	return session as unknown as AgentSession;
}

function toolPair(id: string, toolName: string, intent: string | undefined, text: string): AgentSessionEvent[] {
	return [
		{ type: "tool_execution_start", toolCallId: id, toolName, args: {}, intent },
		{
			type: "tool_execution_end",
			toolCallId: id,
			toolName,
			result: { content: [{ type: "text", text }] },
			isError: false,
		},
	] as AgentSessionEvent[];
}

const yieldEvents = [
	{ type: "tool_execution_start", toolCallId: "final-yield", toolName: "yield", args: {} },
	{
		type: "tool_execution_end",
		toolCallId: "final-yield",
		toolName: "yield",
		result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success", data: "ok" } },
		isError: false,
	},
] as AgentSessionEvent[];

describe("executor completion-probe stage and tool results", () => {
	let tempDir: TempDir;
	let registry: AgentRegistry;
	let parent: AgentSession;
	let settings: Settings;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-probe-stage-");
		settings = Settings.isolated({}, { cwd: tempDir.path(), agentDir: tempDir.path() });
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, `${tempDir.path()}/models.yml`, { settings });
		modelRegistry.registerProvider("anthropic", {
			api: "anthropic-messages",
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			models: [
				{
					id: "claude-sonnet-4-5",
					name: "Probe stage fixture",
					reasoning: true,
					input: ["text"],
					supportsTools: true,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 8192,
				},
			],
		});
		registry = new AgentRegistry();
		({ session: parent } = await createAgentRootSession(registry, {
			agentId: "Main",
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			authStorage,
			modelRegistry,
			model: modelRegistry.find("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			toolNames: [],
			skipPythonPreflight: true,
			hasUI: false,
		}));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await disposeAgentLifecycle(getAgentLifecycleManager(registry));
		await parent.dispose();
		authStorage.close();
		tempDir[Symbol.dispose]();
	});

	it("publishes stage/watch from the probe, holds 99% and the stage after yield, and reports tool results", async () => {
		let onEstimate: probeModule.CompletionProbeOptions["onEstimate"] | undefined;
		vi.spyOn(probeModule, "startCompletionProbe").mockImplementation(options => {
			onEstimate = options.onEstimate;
		});
		const snapshots: AgentProgress[] = [];
		const toolResults: SubagentToolResult[] = [];
		const session = scriptedSession(async emit => {
			for (const event of toolPair("bench-1", "bash", "run the decoder bench", "BENCH tok_s=182\nBENCH tok_s=186"))
				emit(event);
			onEstimate?.(
				{ percent: 40, stage: "benchmarking the decoder", watch: "BENCH lines, tok_s higher is better" },
				0.01,
			);
			for (const event of yieldEvents) emit(event);
			// A probe that was in flight when the yield landed.
			onEstimate?.({ percent: 55, stage: "stale step", watch: "tok_s in bg_1 pipe:1" }, 0.02);
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		const authority = bindInternalAgentAuthoritySession(registry, parent);
		if (!authority) throw new Error("Expected the probe fixture's live parent authority");
		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent,
			task: "bench the decoder",
			description: "probe stage",
			index: 0,
			id: `probe-stage-${Math.random().toString(36).slice(2)}`,
			settings,
			authStorage,
			modelRegistry,
			agentRegistry: registry,
			parentAgentId: "Main",
			createAuthoritySession: authority.create,
			completionProbe: true,
			enableLsp: false,
			enableMCP: false,
			subagentEventBus: new EventBus(),
			onProgress: progress => snapshots.push({ ...progress, recentTools: progress.recentTools.slice() }),
			onToolResult: entry => toolResults.push(entry),
		});

		expect(result.exitCode).toBe(0);
		const probed = snapshots.find(progress => progress.stage !== undefined);
		expect(probed).toMatchObject({
			completionPercent: 40,
			stage: "benchmarking the decoder",
			watch: "BENCH lines, tok_s higher is better",
		});
		const last = snapshots.at(-1);
		expect(last?.completionPercent).toBe(99);
		expect(last?.stage).toBe("benchmarking the decoder");
		expect(last?.watch).toBe("tok_s in bg_1 pipe:1");
		expect(toolResults).toEqual([
			{ tool: "bash", intent: "run the decoder bench", text: "BENCH tok_s=182\nBENCH tok_s=186", isError: false },
			{ tool: "yield", intent: undefined, text: "Result submitted.", isError: false },
		]);
	});
});
