import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const progress = {
	round: 2,
	startedAtMs: 1_000,
	deadlineMs: 1_000 + 86_400_000,
	timeoutMs: 86_400_000,
	resetAware: false,
};

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function createFixture() {
	const ctx = createInteractiveModeContext({ session: { isStreaming: false } });
	const showError = vi.spyOn(ctx, "showError");
	return { ctx, showError, controller: new EventController(ctx) };
}

describe("EventController repeated retry", () => {
	it("labels a repeated wait as a limit wait with its round", async () => {
		const { ctx, controller } = createFixture();

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 3,
			maxAttempts: 3,
			delayMs: 900_000,
			errorMessage: "Claude session limit reached",
			repeated: progress,
		} satisfies RetryStart);

		const text = Bun.stripANSI(ctx.retryLoader?.render(120).join("\n") ?? "");
		expect(text).toContain("Waiting for limit reset (round 2)");
		expect(text).not.toContain("Retrying (3/3)");
		ctx.retryLoader?.stop();
	});

	it.each(["cancelled", "manual-input"] as const)(
		"reports no failure when the user ended the wait (%s)",
		async reason => {
			const { controller, showError } = createFixture();

			await controller.handleEvent({
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "Retry cancelled",
				repeated: { ...progress, reason, endedAtMs: 2_000 },
			} satisfies RetryEnd);

			expect(showError).not.toHaveBeenCalled();
		},
	);

	it("reports a repeated wait that timed out", async () => {
		const { controller, showError } = createFixture();

		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "Claude session limit reached",
			repeated: { ...progress, reason: "timeout", endedAtMs: progress.deadlineMs },
		} satisfies RetryEnd);

		expect(showError).toHaveBeenCalledWith("Retry failed after 3 attempts: Claude session limit reached");
	});
});
