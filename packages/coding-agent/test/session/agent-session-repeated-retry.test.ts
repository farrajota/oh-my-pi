import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

type SessionEvent = {
	type: string;
	success?: boolean;
	delayMs?: number;
	mode?: "normal" | "repeated";
	round?: number;
	deadlineMs?: number;
	timeoutMs?: number;
	reason?: string;
	resetAware?: boolean;
	errorMessage?: string;
};

type MockResponse = Record<string, unknown>;

type Harness = {
	session: AgentSession;
	settings: Settings;
	events: SessionEvent[];
	tempDir: string;
	authStorage: AuthStorage;
};

const NOW = new Date("2026-07-09T12:00:00.000Z");
const TIMER_MS = 60_000;
const TIMEOUT_MS = 3_600_000;
const SESSION_LIMIT = "stream_read_error: Claude session limit reached. Your quota will reset later.";
const USAGE_NOT_INCLUDED = "429 usage_not_included: this model is not included in your plan";

function repeatedStarts(events: SessionEvent[]): SessionEvent[] {
	return events.filter(event => event.type === "auto_retry_start" && event.mode === "repeated");
}

function repeatedEnds(events: SessionEvent[]): SessionEvent[] {
	return events.filter(event => event.type === "auto_retry_end" && event.mode === "repeated");
}
function errorResponse(errorMessage: string): MockResponse {
	return { throw: errorMessage };
}

function successResponse(text = "ok"): MockResponse {
	return { content: [text], stopReason: "stop" };
}

type ScheduledWait = {
	delayMs: number;
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
};

let currentTimeMs = NOW.getTime();
let scheduledWaits: ScheduledWait[] = [];
let originalDateNow: (() => number) | undefined;
let originalSchedulerWait: typeof scheduler.wait | undefined;
let holdLongWaits = true;

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	if (originalSchedulerWait) await originalSchedulerWait.call(scheduler, 0);
}
async function advance(ms: number): Promise<void> {
	currentTimeMs += ms;
	const waits = scheduledWaits.splice(0);
	for (const wait of waits) {
		wait.resolve();
	}
	await flushAsync();
}

async function waitForRepeatedStart(events: SessionEvent[]): Promise<SessionEvent> {
	for (let attempt = 0; attempt < 10; attempt++) {
		await flushAsync();
		const start = repeatedStarts(events)[0];
		if (start) return start;
		const wait = scheduledWaits[0];
		if (!wait) continue;
		await advance(wait.delayMs);
	}
	throw new Error("Repeated retry did not start");
}

function installFakeScheduler(): void {
	currentTimeMs = NOW.getTime();
	scheduledWaits = [];
	holdLongWaits = true;
	originalDateNow = Date.now;
	originalSchedulerWait = scheduler.wait;
	Date.now = () => currentTimeMs;
	scheduler.wait = ((delayMs: number, options?: { signal?: AbortSignal }) => {
		if (!holdLongWaits || delayMs <= 10) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const signal = options?.signal;
		if (signal?.aborted) {
			reject(new Error("AbortError"));
			return promise;
		}
		const scheduled: ScheduledWait = {
			delayMs,
			reject,
			resolve: () => {
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve();
			},
			signal,
		};
		const onAbort = () => {
			const index = scheduledWaits.indexOf(scheduled);
			if (index >= 0) scheduledWaits.splice(index, 1);
			reject(new Error("AbortError"));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		scheduledWaits.push(scheduled);
		return promise;
	}) as typeof scheduler.wait;
}

function restoreFakeScheduler(): void {
	if (originalDateNow) Date.now = originalDateNow;
	if (originalSchedulerWait) scheduler.wait = originalSchedulerWait;
	originalDateNow = undefined;
	originalSchedulerWait = undefined;
	scheduledWaits = [];
}

async function createHarness(responses: MockResponse[], configure?: (settings: Settings) => void): Promise<Harness> {
	const tempDir = path.join(os.tmpdir(), `pi-repeated-retry-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Test model not found");

	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const settings = Settings.isolated();
	settings.set("retry.enabled", true);
	settings.set("retry.maxRetries", 0);
	settings.set("retry.baseDelayMs", 1);
	settings.set("retry.maxDelayMs", 10_000);
	settings.set("retry.repeated.enabled", true);
	settings.set("retry.repeated.timerMs", TIMER_MS);
	settings.set("retry.repeated.timeoutMs", TIMEOUT_MS);
	configure?.(settings);

	const mockModel = createMockModel({ responses });
	const agent = new Agent({
		initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: mockModel.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
	const events: SessionEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
			events.push(event as SessionEvent);
		}
	});

	return { session, settings, events, tempDir, authStorage };
}

async function disposeHarness(harness: Harness | undefined): Promise<void> {
	if (!harness) return;
	harness.session.abortRetry();
	harness.authStorage.close();
	if (fs.existsSync(harness.tempDir)) {
		removeSyncWithRetries(harness.tempDir);
	}
}

describe("AgentSession repeated retry runtime", () => {
	let harness: Harness | undefined;

	beforeEach(() => {
		installFakeScheduler();
	});

	afterEach(async () => {
		restoreFakeScheduler();
		await disposeHarness(harness);
		harness = undefined;
	});

	test("leaves retry exhaustion behavior unchanged when repeated retry is disabled", async () => {
		harness = await createHarness([errorResponse("stream_read_error: temporary upstream failure")], settings => {
			settings.set("retry.repeated.enabled", false);
			settings.set("retry.maxRetries", 0);
		});
		holdLongWaits = false;

		const result = await harness.session.prompt("hit a session limit");

		expect(typeof result).toBe("boolean");
		expect(repeatedStarts(harness.events)).toEqual([]);
		expect(repeatedEnds(harness.events)).toEqual([]);
	});

	test("enters repeated wait after max-retries exhaustion", async () => {
		harness = await createHarness([errorResponse(SESSION_LIMIT), successResponse()]);

		const prompt = harness.session.prompt("hit a session limit");
		const start = await waitForRepeatedStart(harness.events);
		expect(start.deadlineMs).toBeGreaterThanOrEqual(NOW.getTime() + TIMEOUT_MS);
		expect(start.deadlineMs).toBeLessThan(NOW.getTime() + TIMEOUT_MS + 1_000);
		expect(start).toMatchObject({ mode: "repeated", round: 1, reason: "max-retries", delayMs: TIMER_MS });
		expect(start.timeoutMs).toBe(TIMEOUT_MS);

		harness.session.abortRetry();
		expect(typeof (await prompt)).toBe("boolean");
	});

	test("enters repeated wait when normal retry delay exceeds maxDelay", async () => {
		harness = await createHarness([errorResponse(SESSION_LIMIT), successResponse()], settings => {
			settings.set("retry.maxRetries", 3);
			settings.set("retry.baseDelayMs", 120_000);
			settings.set("retry.maxDelayMs", 1_000);
		});

		const prompt = harness.session.prompt("hit max delay");
		const start = await waitForRepeatedStart(harness.events);

		expect(start).toMatchObject({ mode: "repeated", round: 1, reason: "max-delay" });
		harness.session.abortRetry();
		expect(typeof (await prompt)).toBe("boolean");
	});

	test("uses provider reset duration instead of the fallback timer", async () => {
		const resetMessage =
			"stream_read_error: Claude session limit reached. Please try again in 2 minutes when your usage resets.";
		harness = await createHarness([errorResponse(resetMessage), successResponse()]);

		const prompt = harness.session.prompt("respect reset-after");
		const start = await waitForRepeatedStart(harness.events);

		expect(start).toMatchObject({ mode: "repeated", resetAware: true });
		expect(start.delayMs).toBeGreaterThanOrEqual(120_000);
		expect(start.delayMs).toBeLessThan(130_000);

		harness.session.abortRetry();
		expect(typeof (await prompt)).toBe("boolean");
	});

	test("uses provider reset timestamp instead of the fallback timer", async () => {
		const resetAt = new Date(NOW.getTime() + 10 * 60_000).toISOString();
		const resetMessage = `stream_read_error: Claude weekly usage limit reached. Your quota resets at ${resetAt}.`;
		harness = await createHarness([errorResponse(resetMessage), successResponse()]);

		const prompt = harness.session.prompt("respect reset-at");
		const start = await waitForRepeatedStart(harness.events);

		expect(start).toMatchObject({ mode: "repeated", resetAware: true });
		expect(start.delayMs).toBeGreaterThan(9 * 60_000);
		expect(start.delayMs).toBeLessThan(10 * 60_000 + 10_000);

		harness.session.abortRetry();
		expect(typeof (await prompt)).toBe("boolean");
	});

	test("falls back to the configured repeated retry timer when reset timing is unknown", async () => {
		harness = await createHarness([errorResponse(SESSION_LIMIT), successResponse()]);

		const prompt = harness.session.prompt("unknown reset");
		const start = await waitForRepeatedStart(harness.events);

		expect(start).toMatchObject({
			mode: "repeated",
			delayMs: TIMER_MS,
			resetAware: false,
		});

		harness.session.abortRetry();
		expect(typeof (await prompt)).toBe("boolean");
	});

	test("times out a repeated retry chain at the configured deadline", async () => {
		harness = await createHarness([errorResponse(SESSION_LIMIT), errorResponse(SESSION_LIMIT)], settings => {
			settings.set("retry.repeated.timeoutMs", TIMER_MS);
		});

		void harness.session.prompt("eventually timeout");
		const start = await waitForRepeatedStart(harness.events);
		expect(start).toMatchObject({ delayMs: TIMER_MS, timeoutMs: TIMER_MS });

		await advance(TIMER_MS + 1);
		await flushAsync();
		expect(repeatedEnds(harness.events)).toHaveLength(1);
		expect(repeatedEnds(harness.events)[0]).toMatchObject({ success: false, reason: "timeout" });
	});

	test("abortRetry cancels an active repeated wait once", async () => {
		harness = await createHarness([errorResponse(SESSION_LIMIT), successResponse()]);

		void harness.session.prompt("cancel repeated retry");
		await waitForRepeatedStart(harness.events);
		expect(repeatedStarts(harness.events)).toHaveLength(1);

		harness.session.abortRetry();
		await flushAsync();

		expect(repeatedEnds(harness.events)).toHaveLength(1);
		expect(repeatedEnds(harness.events)[0]).toMatchObject({ success: false, reason: "cancelled" });
	});

	test("user-authored input cancels an active repeated wait", async () => {
		harness = await createHarness([errorResponse(SESSION_LIMIT), successResponse("after manual input")]);

		void harness.session.prompt("wait on limit");
		await waitForRepeatedStart(harness.events);
		expect(repeatedStarts(harness.events)).toHaveLength(1);

		const second = harness.session.prompt("new user direction", { streamingBehavior: "followUp" });
		await flushAsync();

		expect(await second).toBe(true);
		expect(repeatedEnds(harness.events)).toHaveLength(1);
		expect(repeatedEnds(harness.events)[0]).toMatchObject({ success: false, reason: "manual-input" });
	});

	test("success after an immediate repeated wait emits terminal success and clears repeated state for a later chain", async () => {
		holdLongWaits = false;
		harness = await createHarness([
			errorResponse(SESSION_LIMIT),
			successResponse("recovered"),
			errorResponse(SESSION_LIMIT),
			successResponse("recovered again"),
		]);

		expect(await harness.session.prompt("first limit")).toBe(true);
		expect(repeatedEnds(harness.events)[0]).toMatchObject({ success: true, reason: "success" });

		expect(await harness.session.prompt("second limit")).toBe(true);
		expect(repeatedStarts(harness.events).at(-1)).toMatchObject({ mode: "repeated", round: 1 });
		expect(repeatedEnds(harness.events).at(-1)).toMatchObject({ success: true, reason: "success" });
	});
	test("non-recoverable usage_not_included fails fast without repeated wait", async () => {
		harness = await createHarness([errorResponse(USAGE_NOT_INCLUDED)], settings => {
			settings.set("retry.baseDelayMs", 120_000);
			settings.set("retry.maxDelayMs", 1_000);
		});
		holdLongWaits = false;

		const result = await harness.session.prompt("non recoverable usage limit");

		expect(typeof result).toBe("boolean");
		expect(repeatedStarts(harness.events)).toEqual([]);
		expect(repeatedEnds(harness.events)).toEqual([]);
	});
});
