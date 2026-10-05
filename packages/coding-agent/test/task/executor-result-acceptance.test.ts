/**
 * Acceptance-boundary contract (#11079): a subagent whose terminal `yield` was
 * accepted must leave `running` and carry its run lifecycle milestones without
 * any parent message or extra poll — on the initial run, on a follow-up turn,
 * and on an autonomous IRC wake turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	getAgentLifecycleManager,
	releaseAgent,
	resetAgentLifecycleForTests,
} from "../../src/internal/agent-lifecycle-bridge";
import { Settings } from "../../src/config/settings";
import { AgentRegistry, type AgentAuthoritySessionBinding } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	attachIrcWakeTurnMonitor,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
} from "../../src/internal/agent-registry-bridge";

const AGENT_ID = "accepted-result";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface SessionHarness {
	session: AgentSession;
	/** Resolves when the executor has dispatched the session's prompt. */
	promptEntered: Promise<void>;
	/** Emit a successful terminal `yield` tool result through the session event stream. */
	emitTerminalYield: (data: unknown) => void;
	/** The observer factory installed by {@link attachIrcWakeTurnMonitor}, if any. */
	wakeObserver: () =>
		| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
}

/**
 * Minimal session that satisfies the executor's run surface. `prompt` submits a
 * terminal `yield` (so `runSubprocess` / `runSubagentFollowUpTurn` settle), and
 * `subscribeRunState` never fires — the run-state mirror omits `idle`, which is
 * exactly the leak the acceptance boundary must cover.
 */
function createHarness(options?: {
	hangPrompt?: boolean;
	usageMessages?: AssistantMessage[];
	asyncJobManager?: AsyncJobManager;
}): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const promptEntered = Promise.withResolvers<void>();
	const hangingPrompt = Promise.withResolvers<void>();
	let yieldSeq = 0;
	let wakeObserver: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitTerminalYield = (data: unknown) => {
		yieldSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `yield-${yieldSeq}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
		} as AgentSessionEvent);
	};
	const session = {
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {}, getArtifactManager: () => undefined },
		settings: Settings.isolated(),
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getToolByName: () => undefined,
		getPermissionSummary: () => undefined,
		setActiveToolsByName: async () => {},
		setWorkPoolYieldItems: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			promptEntered.resolve();
			if (options?.hangPrompt) {
				await hangingPrompt.promise;
				return true;
			}
			if (options?.usageMessages) {
				for (const message of options.usageMessages) {
					messages.push(message);
					emit({ type: "message_end", message } as AgentSessionEvent);
					message.usage.input = -1;
				}
			} else {
				const message = assistantStopMessage("submitting");
				messages.push(message);
				emit({ type: "message_end", message } as AgentSessionEvent);
			}
			emitTerminalYield({ report: text });
			return true;
		},
		waitForIdle: async () => {},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: (
			observer: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined,
		) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		asyncJobManager: options?.asyncJobManager,
	};
	return {
		session: session as unknown as AgentSession,
		promptEntered: promptEntered.promise,
		emitTerminalYield,
		wakeObserver: () => wakeObserver,
	};
}

function registerRunning(session: AgentSession, modelRole?: string) {
	return AgentRegistry.global().register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		session,
		status: "running",
		...(modelRole ? { history: { modelRole } } : {}),
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

let createAuthoritySession: AgentAuthoritySessionBinding["create"];
let authorityRoot: AgentSession | undefined;

function authorityOptions() {
	return {
		agentRegistry: AgentRegistry.global(),
		createAuthoritySession,
		parentAgentId: "Main",
	};
}

describe("runSubprocess result acceptance", () => {
	beforeEach(async () => {
		resetAgentLifecycleForTests();
		AgentRegistry.resetGlobalForTests();
		const root = await createAgentRootSession(AgentRegistry.global(), { agentId: "Main" });
		authorityRoot = root.session;
		const authority = bindInternalAgentAuthoritySession(AgentRegistry.global(), root.session);
		if (!authority) throw new Error("Test fixture requires parent authority");
		createAuthoritySession = authority.create;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		resetAgentLifecycleForTests();
		await authorityRoot?.dispose();
		authorityRoot = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("terminalizes the ref and preserves the accepted result metadata", async () => {
		const harness = createHarness();
		const progress: AgentProgress[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: AGENT_ID,
			onProgress: snapshot => progress.push(snapshot),
			...authorityOptions(),
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ report: "do the work" });
		expect(result.startedAtMs).toBeNumber();
		expect(progress.some(snapshot => snapshot.startedAtMs === result.startedAtMs)).toBe(true);
		await harness.promptEntered;
		const ref = lookupAgentRef(AgentRegistry.global(), AGENT_ID);
		if (!ref || ref.session !== harness.session)
			throw new Error("Expected the committed child ref after prompt entry");
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
		expect(AgentRegistry.global().staleAcceptedRuns()).toEqual([]);
		expect(settled?.createdAt).toBe(ref.createdAt);
	});

	it("keeps usage snapshots immutable across progress updates", async () => {
		const first = assistantStopMessage("first");
		first.usage.input = 3;
		first.usage.output = 5;
		first.usage.cacheRead = 7;
		first.usage.cacheWrite = 11;
		first.usage.totalTokens = 26;
		first.usage.cost.input = 0.001;
		const second = assistantStopMessage("second");
		second.usage.input = 13;
		second.usage.output = 17;
		second.usage.cacheRead = 19;
		second.usage.cacheWrite = 23;
		second.usage.totalTokens = 72;
		second.usage.cost.input = 0.002;
		const harness = createHarness({ usageMessages: [first, second] });
		const snapshots: AgentProgress[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "usage",
			index: 0,
			id: AGENT_ID,
			onProgress: snapshot => snapshots.push(snapshot),
			...authorityOptions(),
		});

		const finalSnapshot = snapshots.at(-1);
		expect(finalSnapshot?.usage?.input).toBe(16);
		expect(finalSnapshot?.usage?.cacheRead).toBe(26);
		expect(finalSnapshot?.usage?.cacheWrite).toBe(34);
		expect(result.usage?.input).toBe(16);
		expect(result.usage?.cacheRead).toBe(26);
		expect(result.usage?.cacheWrite).toBe(34);
		expect(result.tokens).toBe(72);
		expect(finalSnapshot?.usage).not.toBe(result.usage);
		finalSnapshot!.usage!.input = 999;
		expect(result.usage?.input).toBe(16);
	});

	it("settles the owning task job when Agent Hub tombstones a running subagent", async () => {
		const harness = createHarness({ hangPrompt: true });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		const delivered = Promise.withResolvers<{ id: string; text: string }>();
		const manager = new AsyncJobManager({
			onJobComplete: (id, text) => delivered.resolve({ id, text }),
		});
		const jobId = manager.register("task", AGENT_ID, async ({ signal }) => {
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do the work",
				index: 0,
				id: AGENT_ID,
				signal,
				...authorityOptions(),
			});
			if (result.exitCode !== 0) throw new Error(result.abortReason ?? result.error ?? "Task failed");
			return result.output;
		});

		try {
			await harness.promptEntered;
			const ref = lookupAgentRef(AgentRegistry.global(), AGENT_ID);
			if (!ref || ref.session !== harness.session)
				throw new Error("Expected the committed child ref after prompt entry");
			await harness.session.abort();
			await releaseAgent(getAgentLifecycleManager(AgentRegistry.global()), AGENT_ID, ref, { tombstone: true });

			const job = manager.getJob(jobId);
			expect(job).toBeDefined();
			await flushMicrotasks();
			const settlement = job!.status === "running" ? ("still-running" as const) : ("settled" as const);
			if (settlement === "still-running") manager.cancel(jobId);
			await job!.promise;

			expect(settlement).toBe("settled");
			expect(job!.status).toBe("failed");
			expect(await delivered.promise).toMatchObject({ id: jobId });
		} finally {
			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("terminalizes an existing ref on a follow-up turn whose run-state mirror omits idle", async () => {
		const harness = createHarness();
		registerRunning(harness.session);

		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "continue",
			agentRegistry: AgentRegistry.global(),
			agentLifecycle: getAgentLifecycleManager(AgentRegistry.global()),
		});
		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("terminalizes an existing ref on a follow-up turn and preserves role display", async () => {
		const harness = createHarness();
		registerRunning(harness.session, "task");
		const roleDisplay: NonNullable<AgentProgress["modelRoleDisplay"]> = {
			tag: "TASK",
			name: "Subtask",
			color: "muted",
		};
		const progress: AgentProgress[] = [];

		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "continue",
			onProgress: snapshot => progress.push(snapshot),
			agentRegistry: AgentRegistry.global(),
			agentLifecycle: getAgentLifecycleManager(AgentRegistry.global()),
		});
		expect(result.exitCode).toBe(0);
		expect(result.modelRole).toBe("task");
		expect(result.modelRoleDisplay).toEqual(roleDisplay);
		expect(progress.map(snapshot => snapshot.modelRoleDisplay)).toContainEqual(roleDisplay);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("terminalizes the ref when an autonomous wake turn's yield is accepted", async () => {
		const harness = createHarness();
		registerRunning(harness.session);
		attachIrcWakeTurnMonitor(harness.session, {
			id: AGENT_ID,
			agent: baseAgent,
			agentRegistry: AgentRegistry.global(),
			ircBus: new IrcBus(),
		});
		const observer = harness.wakeObserver();
		expect(observer).toBeDefined();

		const finish = observer?.([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "wake",
				display: false,
				attribution: "user",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		expect(finish).toBeDefined();
		harness.emitTerminalYield({ report: "answered while woken" });
		await finish?.(undefined);

		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("delivers every yield of a woken agent to its parent as a job completion", async () => {
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, {
			id: AGENT_ID,
			agent: baseAgent,
			agentRegistry: AgentRegistry.global(),
			ircBus: new IrcBus(),
		});
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			for (const report of ["followup-done", "broadcast-ok"]) {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "follow up",
						display: false,
						details: { id: `msg-${report}`, from: "Parent", message: "follow up" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				harness.emitTerminalYield({ report });
				// Pending from acceptance until finalization: the parent's `wait` can block on it.
				const [job] = manager.getRunningJobs({ ownerId: "Parent" });
				expect(manager.getRunningJobs({ ownerId: "Parent" })).toHaveLength(1);
				expect(job).toMatchObject({ type: "task", agentId: AGENT_ID, ownerId: "Parent", status: "running" });
				await finish?.(undefined);
				await manager.waitForAll();
				expect(manager.getJob(job!.id)?.status).toBe("completed");
				await manager.drainDeliveries({ timeoutMs: 1000 });
			}

			expect(delivered).toHaveLength(2);
			expect(delivered[0]).toContain("followup-done");
			expect(delivered[1]).toContain("broadcast-ok");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
