import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings, resetSettingsForTest } from "../../config/settings";
import { EventController } from "./event-controller";

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

function createContext(coreStreaming = false) {
	const calls = {
		beginRun: 0,
		endRun: 0,
		ensureLoader: 0,
		flushModelSwitch: 0,
		loaderStop: 0,
		render: 0,
		removeChild: 0,
		statusClear: 0,
		statusInvalidate: 0,
	};
	const fakeLoader = { stop: () => calls.loaderStop++ };
	const ctx = {
		isInitialized: true,
		ui: { requestRender: () => calls.render++ },
		settings: { get: () => false },
		hideThinkingBlock: false,
		statusLine: {
			invalidate: () => calls.statusInvalidate++,
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		updateEditorTopBorder: () => {},
		clearPinnedError: () => {},
		beginWorkingMessageRun: () => calls.beginRun++,
		endWorkingMessageRun: () => calls.endRun++,
		getWorkingMessageRunElapsedMs: () => undefined,
		setWorkingMessageRunTokenDelta: () => {},
		ensureLoadingAnimation: () => {
			calls.ensureLoader++;
			ctx.loadingAnimation ??= fakeLoader;
		},
		loadingAnimation: undefined as typeof fakeLoader | undefined,
		statusContainer: { clear: () => calls.statusClear++ },
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		chatContainer: { removeChild: () => calls.removeChild++ },
		flushPendingModelSwitch: async () => {
			calls.flushModelSwitch++;
		},
		viewSession: {
			isCompacting: true,
			getLastAssistantMessage: () => ({ stopReason: "aborted" }),
		},
		session: { agent: { state: { isStreaming: coreStreaming } } },
	};

	return { ctx: ctx as unknown as ConstructorParameters<typeof EventController>[0], calls };
}

describe("EventController agent_end working loader cleanup", () => {
	test("cleans the working loader for a mismatched idle agent_end", async () => {
		const { ctx, calls } = createContext(false);
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "agent_start" } as Parameters<EventController["handleEvent"]>[0]);
		await controller.handleEvent({
			type: "agent_end",
			messages: [assistantMessage(1)],
		} as Parameters<EventController["handleEvent"]>[0]);

		expect(calls.beginRun).toBe(1);
		expect(calls.ensureLoader).toBe(1);
		expect(calls.endRun).toBe(1);
		expect(calls.loaderStop).toBe(1);
		expect(calls.statusClear).toBe(1);
		expect(ctx.loadingAnimation).toBeUndefined();
	});

	test("does not stop a newer active turn for a mismatched agent_end", async () => {
		const { ctx, calls } = createContext(true);
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "agent_start" } as Parameters<EventController["handleEvent"]>[0]);
		await controller.handleEvent({
			type: "agent_end",
			messages: [assistantMessage(1)],
		} as Parameters<EventController["handleEvent"]>[0]);

		expect(calls.endRun).toBe(0);
		expect(calls.loaderStop).toBe(0);
		expect(calls.statusClear).toBe(0);
		expect(ctx.loadingAnimation).not.toBeUndefined();
	});

	test("keeps full cleanup for a non-mismatched agent_end", async () => {
		const { ctx, calls } = createContext(false);
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "agent_start" } as Parameters<EventController["handleEvent"]>[0]);
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
		} as Parameters<EventController["handleEvent"]>[0]);

		expect(calls.endRun).toBe(1);
		expect(calls.loaderStop).toBe(1);
		expect(calls.statusClear).toBe(1);
		expect(calls.flushModelSwitch).toBe(1);
		expect(calls.render).toBeGreaterThanOrEqual(2);
		expect(ctx.loadingAnimation).toBeUndefined();
	});
});
