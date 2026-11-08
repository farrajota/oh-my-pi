/**
 * `getStatsByModel(cutoff, { exactWhenRollupsStale: true })` reads raw messages when the rollup
 * backlog is too large for exact rollup reads, so a long-window model breakdown (the activity
 * dashboard's 14 days) is complete while rollups are still being rebuilt.
 */
import { describe, expect, it } from "bun:test";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { getRollupStatus, getStatsByModel } from "@oh-my-pi/omp-stats/rollup";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-model-exact-");

const HOUR = 60 * 60 * 1000;

function message(entryId: string, timestamp: number, over: Partial<MessageStats> = {}): MessageStats {
	return {
		sessionFile: `/tmp/${entryId}.jsonl`,
		entryId,
		folder: "/work/a",
		model: "model-x",
		provider: "prov",
		api: "openai-responses",
		timestamp,
		duration: 2000,
		ttft: 300,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 60,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
		...over,
	};
}

/** 97 messages one hour apart: more dirty hours than rollup reads patch exactly. */
async function insertLargeBacklog(): Promise<number> {
	await initDb();
	const cutoff = Date.now() - 14 * 24 * HOUR;
	const start = Math.floor((Date.now() - 150 * HOUR) / HOUR) * HOUR;
	insertMessageStats(
		Array.from({ length: 97 }, (_, index) =>
			message(
				`backlog-${index}`,
				start + index * HOUR,
				index === 96 ? { model: "model-y", provider: "prov-y" } : {},
			),
		),
	);
	expect(getRollupStatus().dirtyHours).toBeGreaterThan(96);
	return cutoff;
}

describe("getStatsByModel with a large rollup backlog", () => {
	it("counts every message when exactWhenRollupsStale is set", async () => {
		const cutoff = await insertLargeBacklog();

		const models = getStatsByModel(cutoff, { exactWhenRollupsStale: true });

		expect(models).toHaveLength(2);
		expect(models[0]).toMatchObject({
			model: "model-x",
			provider: "prov",
			totalRequests: 96,
			totalInputTokens: 9600,
			totalOutputTokens: 3840,
			totalCacheReadTokens: 5760,
			totalCacheWriteTokens: 0,
		});
		expect(models[1]).toMatchObject({
			model: "model-y",
			provider: "prov-y",
			totalRequests: 1,
			totalInputTokens: 100,
			totalOutputTokens: 40,
			totalCacheReadTokens: 60,
		});
	});

	it("keeps reading the stale rollups without the option", async () => {
		const cutoff = await insertLargeBacklog();

		const requests = getStatsByModel(cutoff).reduce((sum, row) => sum + row.totalRequests, 0);

		expect(requests).toBeLessThan(97);
	});
});
