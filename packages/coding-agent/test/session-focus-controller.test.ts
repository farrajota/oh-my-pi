import { describe, expect, it } from "bun:test";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface SessionStub {
	session: AgentSession;
	emit(event: AgentSessionEvent): Promise<void>;
	unsubscribeCalls(): number;
	setStreaming(streaming: boolean): void;
	setActiveRunStartedAt(startedAt: number | undefined): void;
	setSessionFile(sessionFile: string | undefined): void;
}

function makeSessionStub(
	opts: { activeRunStartedAt?: number; isStreaming?: boolean; sessionFile?: string } = {},
): SessionStub {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let unsubscribeCalls = 0;
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
	};
}

interface Harness {
	controller: SessionFocusController;
	registry: AgentRegistry;
	main: SessionStub;
	handledEvents: Array<{ source: AgentSession; event: AgentSessionEvent }>;
	rehydrated: AgentSession[];
	setSessionCalls: Array<[AgentSession, string | undefined]>;
	counts: {
		clearTransientSessionUi(): number;
		resetTranscriptAnchors(): number;
		renderInitialMessages(): number;
		mainUnsubscribe(): number;
	};
}

function makeHarness(ensureLive?: (id: string) => Promise<AgentSession>): Harness {
	const main = makeSessionStub({ sessionFile: "main.jsonl" });
	const handledEvents: Array<{ source: AgentSession; event: AgentSessionEvent }> = [];
	const rehydrated: AgentSession[] = [];
	const setSessionCalls: Array<[AgentSession, string | undefined]> = [];
	let clearTransientSessionUi = 0;
	let resetTranscriptAnchors = 0;
	let renderInitialMessages = 0;
	let mainUnsubscribe = 0;
	const ctx = {
		session: main.session,
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
		},
		renderInitialMessages: () => {
			renderInitialMessages++;
		},
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
		showStatus() {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	const registry = new AgentRegistry();
	const lifecycle = ensureLive
		? ({ ensureLive } as unknown as AgentLifecycleManager)
		: new AgentLifecycleManager(registry);
	const controller = new SessionFocusController(ctx, registry, () => lifecycle);
	return {
		controller,
		registry,
		main,
		handledEvents,
		rehydrated,
		setSessionCalls,
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

describe("SessionFocusController", () => {
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
		expect(h.setSessionCalls).toEqual([[worker.session, "Worker"]]);
	});

	it("rehydrates each streaming main, parent, and nested-child attachment independently", async () => {
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
