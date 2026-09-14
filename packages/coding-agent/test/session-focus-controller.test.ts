import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { disposeAgentLifecycle, getAgentLifecycleManager } from "../src/internal/agent-lifecycle-bridge";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

interface SessionStub {
	session: AgentSession;
	emit(event: AgentSessionEvent): Promise<void>;
	unsubscribeCalls(): number;
	setStreaming(streaming: boolean): void;
	setActiveRunStartedAt(startedAt: number | undefined): void;
	setSessionFile(sessionFile: string | undefined): void;
	setQueue(queue: { steering?: string[]; followUp?: string[] }): void;
}

function makeSessionStub(
	opts: { activeRunStartedAt?: number; isStreaming?: boolean; sessionFile?: string } = {},
): SessionStub {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let unsubscribeCalls = 0;
	let queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
	const stub = {
		activeRunStartedAt: opts.activeRunStartedAt,
		isStreaming: opts.isStreaming ?? false,
		sessionFile: opts.sessionFile,
		subscribe(fn: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = fn;
			return () => {
				unsubscribeCalls++;
			};
		},
		async settleInFlightMessagePersistence() {},
		activeToolExecutionUpdates: () => [],
		getQueuedMessages: () => queue,
	};
	return {
		session: stub as unknown as AgentSession,
		emit: async event => {
			if (!listener) throw new Error("no listener captured: subscribe() was never called");
			await listener(event);
		},
		unsubscribeCalls: () => unsubscribeCalls,
		setStreaming: streaming => {
			stub.isStreaming = streaming;
		},
		setActiveRunStartedAt: startedAt => {
			stub.activeRunStartedAt = startedAt;
		},
		setSessionFile: sessionFile => {
			stub.sessionFile = sessionFile;
		},
		setQueue: next => {
			queue = { steering: next.steering ?? [], followUp: next.followUp ?? [] };
		},
	};
}

interface Harness {
	controller: SessionFocusController;
	registry: AgentRegistry;
	lifecycle: AgentLifecycleManager;
	main: SessionStub;
	handledEvents: Array<{ source: AgentSession; event: AgentSessionEvent }>;
	rehydrated: AgentSession[];
	setSessionCalls: Array<[AgentSession, string | undefined]>;
	reloadTodoSessions: AgentSession[];
	pendingMessagesContainer: Container;
	counts: {
		clearTransientSessionUi(): number;
		resetTranscriptAnchors(): number;
		renderInitialMessages(): number;
		mainUnsubscribe(): number;
	};
}

function makeHarness(
	options:
		| { renderInitialMessages?: () => void | Promise<void>; ensureLive?: (id: string) => Promise<AgentSession> }
		| ((id: string) => Promise<AgentSession>) = {},
): Harness {
	const ensureLive = typeof options === "function" ? options : options.ensureLive;
	const renderInitialMessagesHook = typeof options === "function" ? undefined : options.renderInitialMessages;
	const main = makeSessionStub({ sessionFile: "main.jsonl" });
	const handledEvents: Array<{ source: AgentSession; event: AgentSessionEvent }> = [];
	const rehydrated: AgentSession[] = [];
	const setSessionCalls: Array<[AgentSession, string | undefined]> = [];
	const reloadTodoSessions: AgentSession[] = [];
	const pendingMessagesContainer = new Container();
	let clearTransientSessionUi = 0;
	let resetTranscriptAnchors = 0;
	let renderInitialMessages = 0;
	let mainUnsubscribe = 0;
	const ctx = {
		session: main.session,
		get viewSession() {
			return controller.target ?? main.session;
		},
		pendingMessagesContainer,
		compactionQueuedMessages: [],
		keybindings: { getDisplayString: () => "Alt+Up" },
		unsubscribe: () => {
			mainUnsubscribe++;
		},
		eventController: {
			handleEvent: async (source: AgentSession, event: AgentSessionEvent) => {
				handledEvents.push({ source, event });
			},
			rehydrateActiveRun: async (source: AgentSession) => {
				rehydrated.push(source);
			},
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		statusLine: {
			setSession: (session: AgentSession, focusedAgentId?: string) => {
				setSessionCalls.push([session, focusedAgentId]);
			},
			invalidate() {},
		},
		clearTransientSessionUi: () => {
			clearTransientSessionUi++;
			// Mirror interactive-mode.ts: focus teardown disposes the pending block.
			pendingMessagesContainer.disposeChildren();
		},
		renderInitialMessages: async () => {
			renderInitialMessages++;
			await renderInitialMessagesHook?.();
		},
		reloadTodos: async (source?: AgentSession) => {
			reloadTodoSessions.push(source ?? main.session);
		},
		updatePendingMessagesDisplay: () => uiHelpers.updatePendingMessagesDisplay(),
		updateEditorBorderColor() {},
		ui: { requestRender() {}, requestComponentRender() {} },
		showStatus() {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	const registry = new AgentRegistry();
	const lifecycle = getAgentLifecycleManager(registry);
	const controller = new SessionFocusController(ctx, registry, () =>
		ensureLive ? ({ ensureLive } as unknown as AgentLifecycleManager) : lifecycle,
	);
	const uiHelpers = new UiHelpers(ctx);
	lifecycles.push(lifecycle);
	return {
		controller,
		registry,
		lifecycle,
		main,
		handledEvents,
		rehydrated,
		setSessionCalls,
		reloadTodoSessions,
		pendingMessagesContainer,
		counts: {
			clearTransientSessionUi: () => clearTransientSessionUi,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			renderInitialMessages: () => renderInitialMessages,
			mainUnsubscribe: () => mainUnsubscribe,
		},
	};
}

function registerSub(registry: AgentRegistry, id: string, session: AgentSession, parentId = MAIN_AGENT_ID): void {
	registry.register({ id, displayName: id, kind: "sub", parentId, session, status: "running" });
}

async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

const lifecycles: AgentLifecycleManager[] = [];

afterEach(async () => {
	for (const lifecycle of lifecycles.splice(0).reverse()) await disposeAgentLifecycle(lifecycle);
});

describe("SessionFocusController", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("rehydrates a streaming attach rather than synthesizing agent_start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true, activeRunStartedAt: 1_000, sessionFile: "worker.jsonl" });
		registerSub(h.registry, "Worker", worker.session);

		await h.controller.focusAgent("Worker");

		expect(h.rehydrated).toEqual([worker.session]);
		expect(h.handledEvents).toEqual([]);
		expect(h.controller.target).toBe(worker.session);
		expect(h.counts.mainUnsubscribe()).toBe(1);
		expect(h.counts.clearTransientSessionUi()).toBe(1);
		expect(h.counts.resetTranscriptAnchors()).toBe(1);
		expect(h.counts.renderInitialMessages()).toBe(1);
	});

	it("does not rehydrate an idle attach", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ sessionFile: "worker.jsonl" });
		registerSub(h.registry, "Worker", worker.session);
		await h.controller.focusAgent("Worker");
		expect(h.rehydrated).toEqual([]);
		expect(h.reloadTodoSessions).toEqual([worker.session]);
		expect(h.setSessionCalls).toEqual([[worker.session, "Worker"]]);
	});

	it("re-attaching the main session refreshes the todo HUD so it can't freeze at the pre-focus snapshot (#9571)", async () => {
		// While a subagent is focused the main session's `todo` completions never
		// reach the HUD (the event subscription points at the subagent). Returning
		// to the main session rebuilds the transcript from committed messages but
		// must also reload the HUD, or it stays stuck on the pre-focus snapshot
		// (e.g. a `todo init` 0/N) while the transcript shows current progress.
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.reloadTodoSessions).toEqual([worker.session]);

		await h.controller.unfocus();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([worker.session, h.main.session]);
	});

	it("re-renders the pending steering block against the attached session's real queue on both focus directions (#11379)", async () => {
		// clearTransientSessionUi() disposes pendingMessagesContainer on every attach.
		// The queue survives, but nothing repainted it, so returning from a focused
		// agent left the steering block permanently blank. #attach() must rebuild the
		// real container from viewSession's queue in both directions: the subagent's
		// own queue on focus, main's queue on unfocus.
		const h = makeHarness();
		const worker = makeSessionStub();
		h.main.setQueue({ steering: ["main steer alpha"] });
		worker.setQueue({ steering: ["worker steer beta"] });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		const rendered = () => h.pendingMessagesContainer.render(80).join("\n");

		await h.controller.focusAgent("Worker");
		expect(rendered()).toContain("worker steer beta");
		expect(rendered()).not.toContain("main steer alpha");

		await h.controller.unfocus();
		expect(rendered()).toContain("main steer alpha");
		expect(rendered()).not.toContain("worker steer beta");
	});

	it("does not let a superseded focus attachment restore the worker todo HUD after unfocusing", async () => {
		let releaseWorkerRender: (() => void) | undefined;
		let markWorkerRenderStarted: (() => void) | undefined;
		const workerRender = new Promise<void>(resolve => {
			releaseWorkerRender = resolve;
		});
		const workerRenderStarted = new Promise<void>(resolve => {
			markWorkerRenderStarted = resolve;
		});
		let renderCalls = 0;
		const h = makeHarness({
			renderInitialMessages: () => {
				renderCalls++;
				if (renderCalls !== 1) return;
				markWorkerRenderStarted?.();
				return workerRender;
			},
		});
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		const focus = h.controller.focusAgent("Worker");
		await workerRenderStarted;
		await h.controller.unfocus();
		expect(h.reloadTodoSessions).toEqual([h.main.session]);

		releaseWorkerRender?.();
		await focus;
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
		expect(h.reloadTodoSessions).toEqual([h.main.session]);
	});

	it("mid-turn attach synthesizes agent_start, and an orphaned assistant message_update gets a synthesized message_start", async () => {
		const h = makeHarness();
		const parent = makeSessionStub({ isStreaming: true, activeRunStartedAt: 2_000 });
		const child = makeSessionStub({ isStreaming: true, activeRunStartedAt: 3_000 });
		(h.main.session as AgentSession & { isStreaming: boolean; activeRunStartedAt?: number }).isStreaming = true;
		(h.main.session as AgentSession & { activeRunStartedAt?: number }).activeRunStartedAt = 1_000;
		registerSub(h.registry, "Parent", parent.session);
		registerSub(h.registry, "Child", child.session, "Parent");

		await h.controller.focusAgent("Child");
		await h.controller.focusParent();
		await h.controller.focusParent();

		expect(h.rehydrated).toEqual([child.session, parent.session, h.main.session]);
		expect(h.setSessionCalls).toEqual([
			[child.session, "Child"],
			[parent.session, "Parent"],
			[h.main.session, undefined],
		]);
	});

	it("rehydrates a streaming session even when it has no published start time", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session);
		await h.controller.focusAgent("Worker");
		expect(h.rehydrated).toEqual([worker.session]);
	});

	it("drops obsolete detached subscription callbacks", async () => {
		const h = makeHarness();
		const first = makeSessionStub();
		const second = makeSessionStub();
		registerSub(h.registry, "First", first.session);
		registerSub(h.registry, "Second", second.session);
		await h.controller.focusAgent("First");
		await h.controller.focusAgent("Second");

		await first.emit({
			type: "message_start",
			message: { role: "user", content: [], timestamp: 1 },
		} as AgentSessionEvent);
		await second.emit({
			type: "message_start",
			message: { role: "user", content: [], timestamp: 2 },
		} as AgentSessionEvent);

		expect(h.handledEvents).toEqual([
			{
				source: second.session,
				event: { type: "message_start", message: { role: "user", content: [], timestamp: 2 } },
			},
		]);
	});

	it("uses the latest ensureLive focus request when races resolve out of order", async () => {
		const first = makeSessionStub();
		const second = makeSessionStub();
		const firstLive = Promise.withResolvers<AgentSession>();
		const secondLive = Promise.withResolvers<AgentSession>();
		const h = makeHarness(id => (id === "First" ? firstLive.promise : secondLive.promise));
		registerSub(h.registry, "First", first.session);
		registerSub(h.registry, "Second", second.session);

		const firstFocus = h.controller.focusAgent("First");
		const secondFocus = h.controller.focusAgent("Second");
		secondLive.resolve(second.session);
		await secondFocus;
		firstLive.resolve(first.session);
		await firstFocus;

		expect(h.controller.focusedAgentId).toBe("Second");
		expect(h.controller.target).toBe(second.session);
		expect(h.setSessionCalls).toEqual([[second.session, "Second"]]);
	});

	it("cancels a pending focus when unfocus is a no-op", async () => {
		const worker = makeSessionStub();
		const live = Promise.withResolvers<AgentSession>();
		const h = makeHarness(() => live.promise);
		registerSub(h.registry, "Worker", worker.session);

		const focus = h.controller.focusAgent("Worker");
		await h.controller.unfocus();
		live.resolve(worker.session);
		await focus;

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([]);
	});

	it("does not attach a session removed while ensureLive is pending", async () => {
		const worker = makeSessionStub();
		const live = Promise.withResolvers<AgentSession>();
		const h = makeHarness(() => live.promise);
		registerSub(h.registry, "Worker", worker.session);

		const focus = h.controller.focusAgent("Worker");
		h.registry.unregister("Worker");
		live.resolve(worker.session);
		await focus;

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([]);
		expect(h.counts.renderInitialMessages()).toBe(0);
	});

	it("returns to main when the viewed registry entry is removed during navigation", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session);
		await h.controller.focusAgent("Worker");
		h.registry.unregister("Worker");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[h.main.session, undefined],
		]);
	});
});
