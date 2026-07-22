import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "../../config/settings";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { EventController } from "./event-controller";

type SourceAwareController = {
	handleEvent(source: AgentSession, event: AgentSessionEvent, replicatedRunStartedAt?: number): Promise<void>;
	rehydrateActiveRun(source: AgentSession): Promise<void>;
};

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "completion.notify": "off" } });
});

afterAll(() => {
	resetSettingsForTest();
});

function assistantMessage(timestamp = 1): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		timestamp,
	} as AgentMessage;
}

function source(streaming = false, activeRunStartedAt: number | undefined = 1_000): AgentSession {
	return {
		activeRunStartedAt,
		isStreaming: streaming,
		agent: { state: { isStreaming: streaming } },
	} as unknown as AgentSession;
}

function createContext(viewSession = source()) {
	const calls = {
		activityEnd: 0,
		activityStart: 0,
		beginRun: [] as AgentSession[],
		elapsedLookups: [] as AgentSession[],
		endRun: [] as AgentSession[],
		ensureLoader: 0,
		flushModelSwitch: 0,
		init: 0,
		loaderStop: 0,
		rehydrateRun: [] as Array<[AgentSession, number | undefined]>,
		render: 0,
		removeChild: 0,
		statusClear: 0,
		statusDisposeChildren: 0,
		statusInvalidate: 0,
		terminalProgress: [] as boolean[],
		tokenUpdates: [] as Array<[AgentSession, number]>,
	};
	const fakeLoader = { stop: () => calls.loaderStop++ };
	const ctx = {
		isInitialized: true,
		init: async () => {
			calls.init++;
		},
		ui: {
			requestRender: () => calls.render++,
			requestComponentRender() {},
			terminal: { setProgress: (active: boolean) => calls.terminalProgress.push(active) },
		},
		settings: { get: () => false },
		effectiveHideThinkingBlock: false,
		hideThinkingBlock: false,
		proseOnlyThinking: true,
		statusLine: {
			invalidate: () => calls.statusInvalidate++,
			markActivityStart: () => calls.activityStart++,
			markActivityEnd: () => calls.activityEnd++,
		},
		updateEditorTopBorder() {},
		clearPinnedError() {},
		beginWorkingMessageRun: (session: AgentSession) => calls.beginRun.push(session),
		rehydrateWorkingMessageRun: (session: AgentSession, startedAt: number | undefined) => {
			calls.rehydrateRun.push([session, startedAt]);
			return startedAt !== undefined;
		},
		endWorkingMessageRun: (session: AgentSession) => calls.endRun.push(session),
		getWorkingMessageRunElapsedMs: (session: AgentSession) => {
			calls.elapsedLookups.push(session);
			return 500;
		},
		setWorkingMessageRunTokenDelta: (session: AgentSession, tokenDelta: number) =>
			calls.tokenUpdates.push([session, tokenDelta]),
		ensureLoadingAnimation: () => {
			calls.ensureLoader++;
			ctx.loadingAnimation ??= fakeLoader;
		},
		loadingAnimation: undefined as typeof fakeLoader | undefined,
		// This stale fixture omission previously failed agent_start cleanup before
		// the timer/source assertions could run.
		statusContainer: {
			clear: () => calls.statusClear++,
			disposeChildren: () => calls.statusDisposeChildren++,
		},
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		chatContainer: { children: [], removeChild: () => calls.removeChild++ },
		flushPendingModelSwitch: async () => {
			calls.flushModelSwitch++;
		},
		viewSession,
		session: viewSession,
	};
	return { ctx: ctx as unknown as ConstructorParameters<typeof EventController>[0], calls };
}

describe("EventController source-aware working-message lifecycle", () => {
	test("distinguishes real starts from focus rehydration", async () => {
		const active = source(true, 1_000);
		const { ctx, calls } = createContext(active);
		const controller = new EventController(ctx) as unknown as SourceAwareController;

		await controller.handleEvent(active, { type: "agent_start" });
		expect(calls.beginRun).toEqual([active]);
		expect(calls.rehydrateRun).toEqual([]);
		expect(calls.activityStart).toBe(1);
		expect(calls.ensureLoader).toBe(1);

		await controller.rehydrateActiveRun(active);
		expect(calls.beginRun).toEqual([active]);
		expect(calls.rehydrateRun).toEqual([[active, 1_000]]);
		expect(calls.activityStart).toBe(2);
		expect(calls.ensureLoader).toBe(2);
	});

	test("looks up completion elapsed time against the emitting session", async () => {
		const main = source(false, 1_000);
		const { ctx, calls } = createContext(main);
		const controller = new EventController(ctx) as unknown as SourceAwareController;

		// Completion processing must see the emitting session as the current view;
		// source guards reject detached events before elapsed lookup.
		await controller.handleEvent(main, { type: "agent_start" });
		const completed = {
			...assistantMessage(1),
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		} as AgentMessage;
		const completionContext = ctx as unknown as {
			streamingMessage: AgentMessage;
			streamingComponent: {
				updateContent(): void;
				markTranscriptBlockFinalized(): void;
				setCompletionFooter(): void;
			};
			noteDisplayableThinkingContent(): boolean;
		};
		completionContext.noteDisplayableThinkingContent = () => false;
		completionContext.streamingMessage = completed;
		completionContext.streamingComponent = {
			updateContent() {},
			markTranscriptBlockFinalized() {},
			setCompletionFooter() {},
		};
		await controller.handleEvent(main, { type: "message_end", message: completed } as AgentSessionEvent);
		expect(calls.elapsedLookups).toEqual([main]);
	});

	test("uses the emitting source streaming flag for a mismatched end", async () => {
		const endedIdle = source(false, 1_000);
		const { ctx, calls } = createContext(endedIdle);
		const controller = new EventController(ctx) as unknown as SourceAwareController;

		await controller.handleEvent(endedIdle, { type: "agent_start" });
		await controller.handleEvent(endedIdle, {
			type: "agent_end",
			messages: [assistantMessage(1)],
		} as AgentSessionEvent);

		expect(calls.endRun).toEqual([endedIdle]);
		expect(calls.loaderStop).toBe(1);
		expect(calls.statusClear).toBe(1);
	});

	test("rejects stale sources before initialization or timer dispatch", async () => {
		const focused = source(true, 2_000);
		const stale = source(true, 1_000);
		const { ctx, calls } = createContext(focused);
		(ctx as unknown as { isInitialized: boolean }).isInitialized = false;
		const controller = new EventController(ctx) as unknown as SourceAwareController;

		await controller.handleEvent(stale, { type: "agent_start" });

		expect(calls.init).toBe(0);
		expect(calls.beginRun).toEqual([]);
		expect(calls.ensureLoader).toBe(0);
		expect(calls.render).toBe(0);
	});

	test("abandons a source made stale while initialization is pending", async () => {
		const oldA = source(true, 1_000);
		const focusedB = source(true, 2_000);
		const { ctx, calls } = createContext(oldA);
		const initEntered = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		const mutableCtx = ctx as unknown as {
			isInitialized: boolean;
			init(): Promise<void>;
			viewSession: AgentSession;
		};
		mutableCtx.isInitialized = false;
		mutableCtx.init = async () => {
			calls.init++;
			initEntered.resolve();
			await releaseInit.promise;
		};
		const controller = new EventController(ctx) as unknown as SourceAwareController;

		const dispatch = controller.handleEvent(oldA, { type: "agent_start" });
		await initEntered.promise;
		mutableCtx.viewSession = focusedB;
		releaseInit.resolve();
		await dispatch;

		expect(calls.init).toBe(1);
		expect(calls.beginRun).toEqual([]);
		expect(calls.tokenUpdates).toEqual([]);
		expect(calls.activityStart).toBe(0);
		expect(calls.terminalProgress).toEqual([]);
		expect(calls.ensureLoader).toBe(0);
		expect(calls.render).toBe(0);
	});

	test("an old A end cannot stop or clear a newly focused B view", async () => {
		const oldA = source(false, 1_000);
		const focusedB = source(true, 2_000);
		const { ctx, calls } = createContext(focusedB);
		const controller = new EventController(ctx) as unknown as SourceAwareController;

		await controller.handleEvent(oldA, {
			type: "agent_end",
			messages: [assistantMessage(1)],
		} as AgentSessionEvent);

		expect(calls.endRun).toEqual([]);
		expect(calls.loaderStop).toBe(0);
		expect(calls.statusClear).toBe(0);
		expect(ctx.loadingAnimation).toBeUndefined();
	});

	test("does not let an old end continuation mutate B after a pending model switch", async () => {
		const oldA = source(false, 1_000);
		const focusedB = source(true, 2_000);
		const { ctx, calls } = createContext(oldA);
		const flushEntered = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		const mutableCtx = ctx as unknown as {
			viewSession: AgentSession;
			loadingAnimation: { stop(): void } | undefined;
			flushPendingModelSwitch(): Promise<void>;
		};
		mutableCtx.loadingAnimation = { stop: () => calls.loaderStop++ };
		mutableCtx.flushPendingModelSwitch = async () => {
			calls.flushModelSwitch++;
			flushEntered.resolve();
			await releaseFlush.promise;
		};
		const controller = new EventController(ctx) as unknown as SourceAwareController;

		const dispatch = controller.handleEvent(oldA, { type: "agent_end", messages: [] } as AgentSessionEvent);
		await flushEntered.promise;
		expect(calls.endRun).toEqual([oldA]);

		let focusedBLoaderStops = 0;
		mutableCtx.viewSession = focusedB;
		mutableCtx.loadingAnimation = { stop: () => focusedBLoaderStops++ };
		const loaderStopsBeforeFlushResolves = calls.loaderStop;
		const disposedBeforeFlushResolves = calls.statusDisposeChildren;
		const clearedBeforeFlushResolves = calls.statusClear;
		const rendersBeforeFlushResolves = calls.render;

		releaseFlush.resolve();
		await dispatch;

		expect(focusedBLoaderStops).toBe(0);
		expect(calls.loaderStop).toBe(loaderStopsBeforeFlushResolves);
		expect(calls.statusDisposeChildren).toBe(disposedBeforeFlushResolves);
		expect(calls.statusClear).toBe(clearedBeforeFlushResolves);
		expect(calls.render).toBe(rendersBeforeFlushResolves);
	});
});
