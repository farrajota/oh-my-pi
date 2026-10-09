import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type ToolResultMessage, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAgentRootSession } from "../src/internal/agent-registry-bridge";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * An eval cell awaiting a subagent consumes the subagent's output after the
 * delivery sink parked an async-result for it on the yield queue. Once
 * consumed, that entry is stale and the step-boundary drain drops it, so a
 * peek that skips the staleness check acts on a notice that never arrives.
 */
describe("AgentSession peek at consumed background completions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager | undefined;
	let session: AgentSession | undefined;
	let gates: Array<PromiseWithResolvers<string>>;
	const mockApiSource = "test/agent-session-consumed-completion-peek";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-consumed-completion-peek-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		AsyncJobManager.resetForTests();
		AgentRegistry.resetGlobalForTests();
		manager = undefined;
		gates = [];
	});

	afterEach(async () => {
		for (const gate of gates) gate.resolve("released");
		await session?.dispose();
		session = undefined;
		manager = undefined;
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		unregisterCustomApis(mockApiSource);
	});

	/** Register a job owned by the session that runs until its gate resolves. */
	function gatedJob(id: string, type: "bash" | "task"): PromiseWithResolvers<string> {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		const jobs = manager;
		if (!jobs) throw new Error("Expected the root session to own an async job manager");
		jobs.register(type, id, async () => await gate.promise, { id, ownerId: "Main" });
		return gate;
	}

	async function createLiveRootSession(beforeToolResponse?: () => Promise<void>): Promise<AgentSession> {
		// The SDK dispatches by model.api, rather than calling the model's stream handle.
		registerMockApi(mockApiSource);
		const model = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				async () => {
					await beforeToolResponse?.();
					return {
						content: [{ type: "toolCall", id: "call-wait", name: "wait", arguments: {} }],
						stopReason: "toolUse",
					};
				},
				{ content: ["Done"] },
			],
		}).model;
		const registry = new AgentRegistry();
		const created = await createAgentRootSession(registry, {
			agentId: "Main",
			authStorage,
			model,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"launch.enabled": false,
				"todo.enabled": false,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			toolNames: ["wait"],
			disableExtensionDiscovery: true,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
		});
		session = created.session;
		const jobs = session.asyncJobManager;
		if (!jobs) throw new Error("Expected the root session to own an async job manager");
		manager = jobs;
		return session;
	}

	/** Resolves `queued` when the session's delivery sink parks an async-result on the yield queue. */
	function observeAsyncResultQueued(target: AgentSession, queued: PromiseWithResolvers<void>): void {
		const enqueue = target.yieldQueue.enqueueWithReceipt.bind(target.yieldQueue);
		vi.spyOn(target.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			const receipt = enqueue(kind, entry);
			if (kind === "async-result") queued.resolve();
			return receipt;
		});
	}

	it("does not interrupt a wait for a completion the eval cell already consumed", async () => {
		const queued = Promise.withResolvers<void>();
		const active = await createLiveRootSession(async () => {
			subagent.resolve("subagent report");
			await queued.promise;
			const jobs = manager;
			if (!jobs) throw new Error("Expected the root session to own an async job manager");
			jobs.consumeJobResults(["subagent"]);
		});
		const subagent = gatedJob("subagent", "task");
		const cell = gatedJob("cell", "bash");
		observeAsyncResultQueued(active, queued);
		// Pass-through hook that marks when the run loop has asked whether a
		// completion is queued, so the cell can finish only after that decision.
		const peek = active.agent.hasBackgroundCompletions;
		if (!peek) throw new Error("Expected the session to install a background-completion peek");
		const peeked = Promise.withResolvers<void>();
		active.agent.hasBackgroundCompletions = async () => {
			const pending = await peek();
			peeked.resolve();
			return pending;
		};
		const jobs = manager;
		if (!jobs) throw new Error("Expected the root session to own an async job manager");
		const watch = jobs.watchJobs.bind(jobs);
		vi.spyOn(jobs, "watchJobs").mockImplementation(ids => {
			const watched = watch(ids);
			// The cell finishes once the wait is blocked on it and the loop has peeked.
			if (ids.includes("cell")) void peeked.promise.then(() => cell.resolve("cell finished"));
			return watched;
		});

		await active.prompt("wait for the cell");
		await active.waitForIdle();

		const waitResult = active.agent.state.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "wait",
		);
		expect(JSON.stringify(waitResult?.content)).toContain("cell finished");
	});

	it("reports no pending async work once the only queued result was consumed", async () => {
		const active = await createLiveRootSession();
		const subagent = gatedJob("subagent", "task");
		const queued = Promise.withResolvers<void>();
		observeAsyncResultQueued(active, queued);

		subagent.resolve("subagent report");
		await queued.promise;
		const jobs = manager;
		if (!jobs) throw new Error("Expected the root session to own an async job manager");
		jobs.consumeJobResults(["subagent"]);

		expect(active.hasPendingAsyncWork()).toBe(false);
	});
});
