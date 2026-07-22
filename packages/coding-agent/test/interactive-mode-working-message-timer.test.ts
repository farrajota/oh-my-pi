import { afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { WorkingMessageSuffixContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type TimerMode = {
	beginWorkingMessageRun(session: AgentSession, startedAt: number): void;
	rehydrateWorkingMessageRun(session: AgentSession, startedAt: number | undefined): boolean;
	endWorkingMessageRun(session: AgentSession): void;
	getWorkingMessageRunElapsedMs(session: AgentSession, now?: number): number | undefined;
	setWorkingMessageRunTokenDelta(session: AgentSession, tokenDelta: number): void;
};

type MutableSession = AgentSession & {
	sessionFile?: string;
	isStreaming: boolean;
	activeRunStartedAt?: number;
};

type Harness = {
	mode: InteractiveMode;
	timers: TimerMode;
	main: MutableSession;
	parent: MutableSession;
	child: MutableSession;
	setViewSession(session: MutableSession): void;
	contexts: WorkingMessageSuffixContext[];
	runnerCalls: string[];
	tempDir: TempDir;
};

let harnesses: Harness[] = [];

function makeSession(
	sessionManager: SessionManager,
	sessionFile: string,
	extensionRunner?: { renderWorkingMessageSuffix(message: string, context: WorkingMessageSuffixContext): string },
): MutableSession {
	return {
		sessionManager,
		settings,
		extensionRunner,
		agent: {
			state: { tools: [] },
			metadataForProvider: () => undefined,
		},
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		sessionFile,
		isStreaming: false,
	} as unknown as MutableSession;
}

async function createHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-working-message-timer-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Timer host", "user");
	const contexts: WorkingMessageSuffixContext[] = [];
	const runnerCalls: string[] = [];
	const hostRunner = {
		getRegisteredCommands: () => [],
		renderWorkingMessageSuffix(message: string, context: WorkingMessageSuffixContext): string {
			runnerCalls.push(`host:${message}`);
			contexts.push({ ...context });
			return " suffix";
		},
	};
	const main = makeSession(sessionManager, "main.jsonl", hostRunner);
	const parent = makeSession(sessionManager, "parent.jsonl", {
		renderWorkingMessageSuffix: () => {
			runnerCalls.push("parent");
			return " parent";
		},
	});
	const child = makeSession(sessionManager, "child.jsonl", {
		renderWorkingMessageSuffix: () => {
			runnerCalls.push("child");
			return " child";
		},
	});
	let viewSession = main;
	const mode = new InteractiveMode(main, "test");
	Object.defineProperty(mode, "viewSession", { configurable: true, get: () => viewSession });
	const harness = {
		mode,
		timers: mode as unknown as TimerMode,
		main,
		parent,
		child,
		setViewSession(session: MutableSession) {
			viewSession = session;
		},
		contexts,
		runnerCalls,
		tempDir,
	};
	harnesses.push(harness);
	return harness;
}

function renderSuffix(h: Harness): WorkingMessageSuffixContext {
	h.contexts.length = 0;
	h.mode.ensureLoadingAnimation();
	h.mode.statusContainer.render(120);
	expect(h.contexts).toHaveLength(1);
	return h.contexts[0]!;
}

afterEach(() => {
	for (const harness of harnesses) {
		harness.mode.stop();
		harness.tempDir.removeSync();
	}
	harnesses = [];
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("InteractiveMode per-session working-message timers", () => {
	it("keeps main and child elapsed time independent across focus navigation", async () => {
		const h = await createHarness();
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		h.timers.beginWorkingMessageRun(h.main, 0);
		now = 5_000;
		h.timers.beginWorkingMessageRun(h.child, 5_000);
		now = 20_000;
		h.setViewSession(h.child);
		expect(renderSuffix(h)).toMatchObject({ startedAt: 5_000, elapsedMs: 15_000 });
		now = 25_000;
		h.setViewSession(h.main);
		expect(renderSuffix(h)).toMatchObject({ startedAt: 0, elapsedMs: 25_000 });
	});

	it("keeps repeated main, parent, and child navigation monotonic", async () => {
		const h = await createHarness();
		h.timers.beginWorkingMessageRun(h.main, 1_000);
		h.timers.beginWorkingMessageRun(h.parent, 2_000);
		h.timers.beginWorkingMessageRun(h.child, 3_000);
		expect(h.timers.getWorkingMessageRunElapsedMs(h.main, 10_000)).toBe(9_000);
		expect(h.timers.getWorkingMessageRunElapsedMs(h.parent, 11_000)).toBe(9_000);
		expect(h.timers.getWorkingMessageRunElapsedMs(h.child, 12_000)).toBe(9_000);
		expect(h.timers.getWorkingMessageRunElapsedMs(h.main, 13_000)).toBe(12_000);
	});

	it("does not let ending a child erase the main run", async () => {
		const h = await createHarness();
		h.timers.beginWorkingMessageRun(h.main, 1_000);
		h.timers.beginWorkingMessageRun(h.child, 2_000);
		h.timers.endWorkingMessageRun(h.child);
		expect(h.timers.getWorkingMessageRunElapsedMs(h.main, 10_000)).toBe(9_000);
		expect(h.timers.getWorkingMessageRunElapsedMs(h.child, 10_000)).toBeUndefined();
	});

	it("keeps a pending main submission through focus changes until its real start replaces it", async () => {
		const h = await createHarness();
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		h.mode.startPendingSubmission({ text: "main pending", customType: "goal-continuation" });
		h.setViewSession(h.child);
		expect(h.timers.rehydrateWorkingMessageRun(h.main, undefined)).toBe(true);
		h.timers.beginWorkingMessageRun(h.main, 5_000);
		expect(h.timers.getWorkingMessageRunElapsedMs(h.main, 9_000)).toBe(4_000);
	});

	it("cleans an idle pending owner without tearing down a focused child's loader", async () => {
		const h = await createHarness();
		const pending = h.mode.startPendingSubmission({ text: "main pending" });
		const childComponent = {} as NonNullable<typeof h.mode.streamingComponent>;
		h.child.isStreaming = true;
		h.setViewSession(h.child);
		h.timers.beginWorkingMessageRun(h.child, 2_000);
		h.mode.streamingComponent = childComponent;
		h.mode.ensureLoadingAnimation();
		const childLoader = h.mode.loadingAnimation;
		expect(childLoader).toBeDefined();
		if (!childLoader) throw new Error("expected child loader");

		h.mode.finishPendingSubmission(pending);

		expect(h.timers.getWorkingMessageRunElapsedMs(h.main, 3_000)).toBeUndefined();
		expect(h.timers.rehydrateWorkingMessageRun(h.main, undefined)).toBe(false);
		expect(h.mode.optimisticUserMessageSignature).toBeUndefined();
		expect(h.mode.loadingAnimation).toBe(childLoader);
		expect(h.mode.statusContainer.children).toContain(childLoader);
		expect(h.mode.streamingComponent).toBe(childComponent);
	});

	it("drops a stale detached child run when no authoritative timestamp is available", async () => {
		const h = await createHarness();
		h.timers.beginWorkingMessageRun(h.child, 1_000);
		// The child completed while detached, so no local end cleared this prior run.
		h.child.isStreaming = true;
		h.child.activeRunStartedAt = undefined;
		h.setViewSession(h.child);
		expect(h.timers.rehydrateWorkingMessageRun(h.child, h.child.activeRunStartedAt)).toBe(false);
		expect(renderSuffix(h)).toMatchObject({ startedAt: undefined, elapsedMs: undefined });
	});

	it("has no active suffix when a detached child completed before refocus", async () => {
		const h = await createHarness();
		h.timers.beginWorkingMessageRun(h.child, 1_000);
		h.timers.endWorkingMessageRun(h.child);
		h.setViewSession(h.child);
		expect(renderSuffix(h)).toMatchObject({ startedAt: undefined, elapsedMs: undefined });
	});

	it("resets a real-to-real sessionFile rollover but preserves an undefined-to-real first save", async () => {
		const h = await createHarness();
		h.timers.beginWorkingMessageRun(h.main, 1_000);
		h.main.sessionFile = "main-restarted.jsonl";
		expect(h.timers.getWorkingMessageRunElapsedMs(h.main, 2_000)).toBeUndefined();
		h.child.sessionFile = undefined;
		h.timers.beginWorkingMessageRun(h.child, 3_000);
		h.child.sessionFile = "child-first-save.jsonl";
		expect(h.timers.getWorkingMessageRunElapsedMs(h.child, 5_000)).toBe(2_000);
	});

	it("does not overwrite token deltas between sessions", async () => {
		const h = await createHarness();
		h.timers.beginWorkingMessageRun(h.main, 0);
		h.timers.beginWorkingMessageRun(h.child, 0);
		h.timers.setWorkingMessageRunTokenDelta(h.main, 12);
		h.timers.setWorkingMessageRunTokenDelta(h.child, 34);
		h.setViewSession(h.main);
		expect(renderSuffix(h).runTokenDelta).toBe(12);
		h.setViewSession(h.child);
		expect(renderSuffix(h).runTokenDelta).toBe(34);
	});

	it("uses the interactive host extension runner even while rendering a child", async () => {
		const h = await createHarness();
		h.timers.beginWorkingMessageRun(h.child, 1_000);
		h.setViewSession(h.child);
		renderSuffix(h);
		expect(h.runnerCalls).toEqual(["host:Working… ⟦esc⟧"]);
	});
});
