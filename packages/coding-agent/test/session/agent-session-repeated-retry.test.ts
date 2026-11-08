import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type ExtensionRetryEvent = { type: string; [key: string]: unknown };

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const TIMER_MS = 60_000;
const TIMEOUT_MS = 3_600_000;
const SESSION_LIMIT = "stream_read_error: Claude session limit reached. Your quota will reset later.";

function failure(errorMessage: string, fields: Pick<MockResponse, "errorStatus" | "errorCode"> = {}): MockResponse {
	return { throw: errorMessage, ...fields };
}

const success: MockResponse = { content: ["ok"], stopReason: "stop" };

/**
 * Fake wall and monotonic clocks behind `scheduler.wait`. In `auto` mode every
 * wait elapses at once; otherwise waits stay pending until `advance` moves the
 * clock past their due time, so a test can act while a retry is sleeping.
 */
class FakeClock {
	now = NOW;
	auto = true;
	readonly #pending: { dueAt: number; resolve: () => void }[] = [];

	install(): void {
		const perfBase = performance.now();
		vi.spyOn(Date, "now").mockImplementation(() => this.now);
		vi.spyOn(performance, "now").mockImplementation(() => perfBase + (this.now - NOW));
		vi.spyOn(scheduler, "wait").mockImplementation((delayMs, options) => {
			const signal = options?.signal;
			if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
			const dueAt = this.now + Math.max(0, Number(delayMs) || 0);
			if (this.auto || dueAt <= this.now) {
				this.now = dueAt;
				return Promise.resolve(undefined);
			}
			const { promise, resolve, reject } = Promise.withResolvers<undefined>();
			const entry = { dueAt, resolve: () => resolve(undefined) };
			this.#pending.push(entry);
			signal?.addEventListener(
				"abort",
				() => {
					const index = this.#pending.indexOf(entry);
					if (index >= 0) this.#pending.splice(index, 1);
					reject(signal.reason ?? new Error("aborted"));
				},
				{ once: true },
			);
			return promise;
		});
	}

	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		for (;;) {
			await flush();
			this.#pending.sort((a, b) => a.dueAt - b.dueAt);
			const next = this.#pending[0];
			if (!next || next.dueAt > target) break;
			this.#pending.shift();
			this.now = next.dueAt;
			next.resolve();
		}
		this.now = target;
		await flush();
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

describe("AgentSession repeated retry (retry.repeated.*)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let clock: FakeClock;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-repeated-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(() => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		clock = new FakeClock();
	});

	afterEach(async () => {
		if (session) {
			session.abortRetry();
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function createHarness(responses: MockResponse[], overrides: Record<string, unknown> = {}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const providerAttempts: Array<number | undefined> = [];
		const agent = new Agent({
			getApiKey: requested => `${requested.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				providerAttempts.push(options?.providerMaxAttempts);
				return mock.stream(requested, context, options);
			},
		});
		const values: Record<string, unknown> = {
			"compaction.enabled": false,
			"retry.maxRetries": 0,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 300_000,
			"retry.modelFallback": false,
			"retry.repeated.enabled": true,
			"retry.repeated.timerMs": TIMER_MS,
			"retry.repeated.timeoutMs": TIMEOUT_MS,
			...overrides,
		};
		// An `undefined` override leaves the setting at its registered default.
		const settings = Settings.isolated(
			Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
		);
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const extensionEvents: ExtensionRetryEvent[] = [];
		const sessionManager = SessionManager.inMemory();
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("auto_retry_end", event => {
					extensionEvents.push({ ...event });
				});
				pi.on("auto_retry_recovered", event => {
					extensionEvents.push({ ...event });
				});
				pi.on("auto_retry_timeout", event => {
					extensionEvents.push({ ...event });
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"repeated-retry-listener",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		clock.install();

		const starts: RetryStart[] = [];
		const ends: RetryEnd[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") starts.push(event);
			if (event.type === "auto_retry_end") ends.push(event);
		});
		return { session, agent, starts, ends, providerAttempts, extensionEvents };
	}

	function repeatedStarts(starts: RetryStart[]): RetryStart[] {
		return starts.filter(event => event.repeated !== undefined);
	}

	async function waitForRepeatedStart(starts: RetryStart[], round = 1): Promise<RetryStart> {
		for (let i = 0; i < 200; i++) {
			const start = repeatedStarts(starts).find(event => event.repeated?.round === round);
			if (start) return start;
			await flush();
		}
		throw new Error(`No repeated retry round ${round}; starts: ${JSON.stringify(starts)}`);
	}

	it("keeps upstream exhaustion behavior when retry.repeated.enabled is off (the default)", async () => {
		const h = await createHarness([failure(SESSION_LIMIT), success], { "retry.repeated.enabled": undefined });

		await h.session.prompt("hit a session limit");

		expect(repeatedStarts(h.starts)).toEqual([]);
		expect(h.providerAttempts).toHaveLength(1);
		expect(h.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("waits on the repeated timer after the retry budget is spent, then resumes", async () => {
		clock.auto = false;
		const h = await createHarness([failure(SESSION_LIMIT), success]);

		const prompt = h.session.prompt("hit a session limit");
		const start = await waitForRepeatedStart(h.starts);
		expect(start.delayMs).toBe(TIMER_MS);
		expect(start.repeated).toEqual({
			round: 1,
			startedAtMs: NOW,
			deadlineMs: NOW + TIMEOUT_MS,
			timeoutMs: TIMEOUT_MS,
			resetAware: false,
		});
		expect(h.providerAttempts).toHaveLength(1);
		expect(h.session.isRetrying).toBe(true);

		await clock.advance(TIMER_MS + 1);
		expect(await prompt).toBe(true);

		expect(h.providerAttempts).toHaveLength(2);
		expect(h.ends).toHaveLength(1);
		expect(h.ends[0]).toMatchObject({ success: true, repeated: { reason: "success", round: 1 } });
		expect(h.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(h.session.isRetrying).toBe(false);
		// The generic end reaches extensions before the specialized recovery event.
		expect(h.extensionEvents.map(event => event.type)).toEqual(["auto_retry_end", "auto_retry_recovered"]);
		const recovered = h.extensionEvents[1]!;
		expect(recovered).toMatchObject({ round: 1, startedAtMs: NOW, deadlineMs: NOW + TIMEOUT_MS });
		expect(recovered.durationMs).toBeGreaterThanOrEqual(TIMER_MS);
		expect(recovered.durationMs).toBeLessThan(TIMER_MS + 1_000);
	});

	it("waits out a cliproxy cooldown whose Retry-After exceeds retry.maxDelayMs", async () => {
		const cooldown = failure(
			"429 All credentials for model gpt-6.1-sol are cooling down via provider codex (type=model_cooldown) retry-after-ms=7200000",
			{ errorStatus: 429 },
		);
		const h = await createHarness([cooldown, success], {
			"retry.maxRetries": 3,
			"retry.repeated.timeoutMs": 86_400_000,
		});
		h.agent.providerMaxAttempts = 4;

		expect(await h.session.prompt("wait for the proxy")).toBe(true);

		expect(h.starts).toHaveLength(1);
		expect(h.starts[0]).toMatchObject({ delayMs: 7_200_000, repeated: { round: 1, resetAware: true } });
		// The probe after a repeated wait is one provider request, then the cap is restored.
		expect(h.providerAttempts).toEqual([4, 1]);
		expect(h.agent.providerMaxAttempts).toBe(4);
		expect(h.ends[0]).toMatchObject({ success: true, repeated: { reason: "success" } });
	});

	it("probes a hintless model cooldown once per timer tick until it clears", async () => {
		// Codex hides the proxy text behind its friendly rewrite; only the code says cooldown.
		const cooldown = failure("429 ChatGPT rate limit exceeded.", { errorStatus: 429, errorCode: "model_cooldown" });
		const h = await createHarness([cooldown, cooldown, cooldown, success], { "retry.maxRetries": 1 });
		h.agent.providerMaxAttempts = 4;

		expect(await h.session.prompt("wait for the proxy")).toBe(true);

		const normalStarts = h.starts.filter(event => event.repeated === undefined);
		expect(normalStarts).toHaveLength(1);
		expect(repeatedStarts(h.starts).map(event => [event.repeated?.round, event.delayMs])).toEqual([
			[1, TIMER_MS],
			[2, TIMER_MS],
		]);
		expect(h.providerAttempts).toEqual([4, 4, 1, 1]);
		expect(h.agent.providerMaxAttempts).toBe(4);
		expect(h.ends).toHaveLength(1);
		expect(h.ends[0]).toMatchObject({ success: true, repeated: { reason: "success", round: 2 } });
		const recovered = h.extensionEvents.find(event => event.type === "auto_retry_recovered");
		expect(recovered).toMatchObject({ round: 2 });
	});

	it("uses a provider-stated reset instead of the timer", async () => {
		const resetIn =
			"stream_read_error: Claude session limit reached. Please try again in 2 minutes when your usage resets.";
		const h = await createHarness([failure(resetIn), success]);

		expect(await h.session.prompt("respect the reset")).toBe(true);

		expect(repeatedStarts(h.starts)[0]).toMatchObject({ delayMs: 120_000, repeated: { resetAware: true } });
	});

	it("gives up at retry.repeated.timeoutMs without another probe", async () => {
		const h = await createHarness([failure(SESSION_LIMIT), failure(SESSION_LIMIT)], {
			"retry.repeated.timeoutMs": TIMER_MS,
		});

		await h.session.prompt("eventually time out");

		expect(h.providerAttempts).toHaveLength(1);
		expect(h.ends).toHaveLength(1);
		expect(h.ends[0]).toMatchObject({
			success: false,
			finalError: SESSION_LIMIT,
			repeated: { reason: "timeout", round: 1 },
		});
		expect(h.session.isRetrying).toBe(false);
		expect(h.extensionEvents.map(event => event.type)).toEqual(["auto_retry_end", "auto_retry_timeout"]);
		expect(h.extensionEvents[1]).toMatchObject({
			round: 1,
			startedAtMs: NOW,
			timedOutAtMs: NOW + TIMER_MS,
			durationMs: TIMER_MS,
			deadlineMs: NOW + TIMER_MS,
			timeoutMs: TIMER_MS,
			finalError: SESSION_LIMIT,
		});
	});

	it.each([
		[
			"a per-minute rate limit",
			failure("429 Requests per minute limit reached", { errorStatus: 429, errorCode: "rate_limit_exceeded" }),
		],
		["usage_not_included text", failure("429 usage_not_included: this model is not included in your plan")],
		[
			"a usage_not_included code",
			failure("You have hit your ChatGPT usage limit (plus plan).", {
				errorStatus: 429,
				errorCode: "usage_not_included",
			}),
		],
		["a billing cap", failure("402 Insufficient balance, please top up your account", { errorStatus: 402 })],
	])("fails fast on %s", async (_name, response) => {
		const h = await createHarness([response, success]);

		await h.session.prompt("do not wait");

		expect(repeatedStarts(h.starts)).toEqual([]);
		expect(h.providerAttempts).toHaveLength(1);
		expect(h.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("abortRetry cancels a repeated wait once", async () => {
		clock.auto = false;
		const h = await createHarness([failure(SESSION_LIMIT), success]);

		const prompt = h.session.prompt("cancel the wait");
		await waitForRepeatedStart(h.starts);
		h.session.abortRetry();
		await prompt;
		await flush();

		expect(h.providerAttempts).toHaveLength(1);
		expect(h.ends).toHaveLength(1);
		expect(h.ends[0]).toMatchObject({ success: false, repeated: { reason: "cancelled", round: 1 } });
		expect(h.extensionEvents.map(event => event.type)).toEqual(["auto_retry_end"]);
		expect(h.session.isRetrying).toBe(false);
	});

	it("a message the user sends ends the repeated wait and is served", async () => {
		clock.auto = false;
		const h = await createHarness([failure(SESSION_LIMIT), { content: ["after input"], stopReason: "stop" }]);

		const first = h.session.prompt("wait on the limit");
		await waitForRepeatedStart(h.starts);
		const second = h.session.prompt("new direction", { streamingBehavior: "steer" });
		// The wait is over; let the steered turn's own scheduling run.
		clock.auto = true;
		await clock.advance(10);
		await Promise.all([first, second]);
		await h.session.waitForIdle();
		await flush();

		expect(h.ends[0]).toMatchObject({ success: false, repeated: { reason: "manual-input", endedAtMs: NOW } });
		// The user's turn is not a probe: no single-attempt cap.
		expect(h.providerAttempts).toEqual([undefined, undefined]);
		expect(h.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(h.session.isRetrying).toBe(false);
	});

	it("ends the repeated wait when a probe fails with an unrelated error", async () => {
		const h = await createHarness([
			failure(SESSION_LIMIT),
			failure("400 invalid_request_error: bad tool schema", { errorStatus: 400 }),
		]);
		h.agent.providerMaxAttempts = 4;

		await h.session.prompt("probe hits another error");

		expect(h.providerAttempts).toEqual([4, 1]);
		expect(h.agent.providerMaxAttempts).toBe(4);
		expect(h.ends).toHaveLength(1);
		expect(h.ends[0]).toMatchObject({ success: false, repeated: { reason: "not-recoverable" } });
		expect(h.ends[0]!.finalError).toContain("bad tool schema");
		expect(h.session.isRetrying).toBe(false);
	});

	it("starts a later limit at round 1 after a recovery", async () => {
		const h = await createHarness([failure(SESSION_LIMIT), success, failure(SESSION_LIMIT), success]);

		expect(await h.session.prompt("first limit")).toBe(true);
		expect(await h.session.prompt("second limit")).toBe(true);

		expect(repeatedStarts(h.starts).map(event => event.repeated?.round)).toEqual([1, 1]);
		expect(h.ends.map(event => event.repeated?.reason)).toEqual(["success", "success"]);
	});
});
