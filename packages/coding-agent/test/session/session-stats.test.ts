import { expect, test } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { SessionStatsTracker } from "../../src/session/session-stats";

function usage(totalTokens: number, input: number, output: number, cacheRead: number, cacheWrite: number) {
	return {
		input,
		output,
		reasoningTokens: 1,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
const tokenizer = new Tokenizer();

test("uses provider totals once while retaining cache and reasoning breakdowns", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		usage: usage(12, 4, 2, 3, 1),
	};
	const tracker = new SessionStatsTracker({
		agent: { state: { messages: [assistant] }, tokenizer },
		sessionManager: {
			getBranch: () => [{ type: "model_usage", usage: usage(3, 1, 1, 0, 0) }],
			getSessionFile: () => "/tmp/session.jsonl",
		},
		session: {},
		sessionId: () => "session",
		modelRegistry: {},
		model: () => undefined,
	} as never);

	expect(tracker.getSessionStats().tokens).toMatchObject({
		input: 5,
		output: 3,
		reasoning: 2,
		cacheRead: 3,
		cacheWrite: 1,
		total: 15,
	});
});

test("does not add nested task-result usage to canonical session totals", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		usage: usage(12, 4, 2, 3, 1),
	};
	const taskResult = {
		role: "toolResult",
		toolName: "task",
		content: [],
		details: { usage: usage(10_000, 5_000, 2_000, 2_000, 1_000) },
	};
	const tracker = new SessionStatsTracker({
		agent: { state: { messages: [assistant, taskResult] }, tokenizer },
		sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/session.jsonl" },
		session: {},
		sessionId: () => "session",
		modelRegistry: {},
		model: () => undefined,
	} as never);

	expect(tracker.getSessionStats().tokens.total).toBe(12);
});
