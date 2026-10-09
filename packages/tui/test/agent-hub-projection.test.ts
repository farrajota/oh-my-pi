import { expect, test } from "bun:test";
import { aggregateMetrics, progressMetrics } from "../src/overlays/agent-hub-projection";

function sessionWithEntries(entries: readonly unknown[]) {
	return {
		agent: { state: { messages: [] } },
		sessionManager: { getEntries: () => entries },
		getSessionStats: () => ({
			tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 999 },
			assistantMessages: 0,
			toolCalls: 0,
			cost: 999,
			contextUsage: { tokens: 12, contextWindow: 100 },
		}),
	};
}

test("prefers authoritative progress usage totals over legacy token snapshots", () => {
	const metrics = progressMetrics({
		progress: {
			usage: { input: 4, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 12 },
			tokens: 99,
			requests: 7,
			toolCount: 0,
			cost: 0,
			durationMs: 0,
		},
	} as never);
	expect(metrics?.tokens).toBe(12);
	expect(metrics?.requests).toBe(7);
});

test("projects direct assistant and model usage without nested task-result usage", () => {
	const session = sessionWithEntries([
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 4,
					output: 2,
					cacheRead: 3,
					cacheWrite: 1,
					totalTokens: 12,
					cost: { total: 0.12 },
				},
				content: [{ type: "toolCall", name: "task" }],
			},
		},
		{
			type: "model_usage",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.03 } },
		},
		{ type: "message", message: { role: "toolResult", toolName: "task", details: { usage: { totalTokens: 20 } } } },
	]);
	const ref = { id: "agent", session } as never;
	const result = aggregateMetrics({
		rows: [ref],
		observedById: new Map(),
		metricsFor: () => undefined,
		fallbackStatsSession: () => session as never,
		sessionMetrics: new WeakMap(),
		refreshFallback: true,
	});

	expect(result.metrics).toMatchObject({ tokens: 15, requests: 2, tools: 1, cost: 0.15 });
});

test("uses canonical total when direct entry details are unavailable", () => {
	const session = {
		getSessionStats: () => ({
			tokens: { input: 4, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 1, total: 12 },
			assistantMessages: 1,
			toolCalls: 0,
			cost: 0.12,
		}),
	};
	const ref = { id: "agent", session } as never;
	const result = aggregateMetrics({
		rows: [ref],
		observedById: new Map(),
		metricsFor: () => undefined,
		fallbackStatsSession: () => session as never,
		sessionMetrics: new WeakMap(),
		refreshFallback: true,
	});

	expect(result.metrics.tokens).toBe(12);
});

import { describe, it } from "bun:test";
import {
	type AgentMetrics,
	hubFallbackStatsSession,
	hubRowMetrics,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
function assistant(output: number) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		usage: { input: 10, output, cacheWrite: 0, cost: { total: output / 1000 } },
	};
}
describe("aggregateMetrics fallback reads", () => {
	it("refreshes when the streaming last message's usage changes in place", () => {
		const tail = assistant(5);
		const messages = [{ role: "user", content: "hi" }, tail];
		const session = { agent: { state: { messages } }, getSessionStats: () => ({ contextUsage: undefined }) };
		const ref = { id: "main", session } as unknown as AgentRecordLike;
		const sessionMetrics = new WeakMap<object, { metrics: AgentMetrics | undefined }>();
		const run = () =>
			aggregateMetrics({
				rows: [ref],
				observedById: new Map(),
				metricsFor: (row, observed) => hubRowMetrics(row, observed, sessionMetrics),
				fallbackStatsSession: hubFallbackStatsSession,
				sessionMetrics,
				refreshFallback: true,
			}).metrics.tokens;
		expect(run()).toBe(15);
		tail.usage.output = 40;
		expect(run()).toBe(50);
	});
});
