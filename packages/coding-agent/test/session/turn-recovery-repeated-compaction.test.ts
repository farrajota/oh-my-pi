import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

// A repeated-retry probe that fails with a context overflow hands the turn to compaction,
// which schedules its own continuation. The retry saga must stay open for that
// continuation, as an ordinary retry saga does, instead of ending as "not-recoverable".

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const SESSION_LIMIT = "stream_read_error: Claude session limit reached. Your quota will reset later.";
const OVERFLOW = "400 prompt is too long: 250000 tokens > 200000 maximum";

type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function assistant(model: Model, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
		...fields,
	};
}

describe("TurnRecovery repeated retry with a compaction continuation", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-repeated-compaction-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createRecovery() {
		let now = NOW;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		// Every repeated wait elapses at once on the fake clock.
		vi.spyOn(scheduler, "wait").mockImplementation(async delayMs => {
			now += Math.max(0, Number(delayMs) || 0);
			return undefined;
		});
		const settings = Settings.isolated({
			"retry.maxRetries": 0,
			"retry.baseDelayMs": 1,
			"retry.modelFallback": false,
			"retry.repeated.enabled": true,
			"retry.repeated.timerMs": 60_000,
			"retry.repeated.timeoutMs": 3_600_000,
		});
		const agentState = { messages: [] as AgentMessage[] };
		const agent = {
			state: agentState,
			providerMaxAttempts: 4 as number | undefined,
			replaceMessages(messages: AgentMessage[]) {
				agentState.messages = messages;
			},
		};
		const ends: RetryEnd[] = [];
		const host: TurnRecoveryHost = {
			agent: agent as never,
			sessionManager: {
				getLastModelChangeRole: () => undefined,
				getBranch: () => [],
				getBranchView: () => [],
				getSessionId: () => "test-session",
			} as never,
			persistedAssistantEntryId: () => undefined,
			settings,
			modelRegistry,
			configWarnings: [],
			model: () => model,
			contextFitsModel: () => true,
			textOutputCommitted: () => false,
			thinkingLevel: () => undefined,
			configuredThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			thinkingLevelCeiling: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isCompacting: () => false,
			abortInProgress: () => false,
			streamingEditAbortTriggered: () => false,
			promptGeneration: () => 0,
			promptSequence: () => 0,
			sessionId: () => "test-session",
			emitSessionEvent: async event => {
				if (event.type === "auto_retry_end") ends.push(event);
			},
			// Dispatch the probe at once, as the agent loop does when it starts the continuation.
			scheduleAgentContinue: options => {
				options.shouldContinue?.();
			},
			waitForSessionMessagePersistence: async () => {},
			appendSessionMessage: () => {},
			sessionMessageAlreadyPersisted: () => false,
			setModelWithProviderSessionReset: async () => {},
			resolveActiveEditMode: () => "hashline",
			syncAfterModelChange: async () => {},
			resetCurrentResponsesProviderSession: () => {},
			maybeAutoRedeemReset: async () => ({ restored: false }),
			runAutoCompaction: async () => ({ continuationScheduled: false }),
			shakeForRequestBodyReadTimeout: async () => false,
			withBashBranchTransition: <T>(operation: () => T): T => operation(),
		};
		return { recovery: new TurnRecovery(host), agent, ends };
	}

	it("keeps the saga open for the continuation and ends it on the continuation's success", async () => {
		const { recovery, agent, ends } = createRecovery();
		const limit = assistant(model, { stopReason: "error", errorMessage: SESSION_LIMIT });

		expect(await recovery.handleRetryableError(limit)).toBe(true);
		expect(agent.providerMaxAttempts).toBe(1);

		const overflow = assistant(model, { stopReason: "error", errorMessage: OVERFLOW });
		await recovery.onErrorSettledWithoutRetry(overflow, { continuationScheduled: true });

		expect(ends).toEqual([]);
		// The continuation is a recovery turn, not a probe: it gets the normal attempt budget.
		expect(agent.providerMaxAttempts).toBe(4);

		await recovery.onAssistantSettledSuccessfully(
			assistant(model, { content: [{ type: "text", text: "ok" }], stopReason: "stop" }),
		);

		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ success: true, repeated: { reason: "success", round: 1 } });
	});

	it("still ends as not-recoverable when no continuation was scheduled", async () => {
		const { recovery, agent, ends } = createRecovery();
		const limit = assistant(model, { stopReason: "error", errorMessage: SESSION_LIMIT });
		expect(await recovery.handleRetryableError(limit)).toBe(true);

		const overflow = assistant(model, { stopReason: "error", errorMessage: OVERFLOW });
		await recovery.onErrorSettledWithoutRetry(overflow, { continuationScheduled: false });

		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ success: false, finalError: OVERFLOW, repeated: { reason: "not-recoverable" } });
		expect(agent.providerMaxAttempts).toBe(4);
	});
});
