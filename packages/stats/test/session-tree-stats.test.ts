/**
 * Per-session model usage for one session tree (the main transcript plus every subagent and
 * advisor transcript under its artifact directory), and the sync controls the activity
 * dashboard uses: a targeted tree sync, a freshness window and a busy-lock fallback.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions, syncSessionTree } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getSessionStatsByModelAndAgentType, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import type { AgentType, MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-session-tree-");

function stat(
	entryId: string,
	sessionFile: string,
	agentType: AgentType,
	model: string,
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): MessageStats {
	return {
		sessionFile,
		entryId,
		folder: "/work/project",
		model,
		provider: `${model}-provider`,
		api: "openai-responses",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			...tokens,
			totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
		agentType,
	};
}

function assistantEntry(entryId: string, model: string): object {
	return {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model,
			usage: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
}

async function writeJsonl(file: string, entries: readonly object[]): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("getSessionStatsByModelAndAgentType", () => {
	it("returns no rows without a database or for a path that is not a transcript", () => {
		closeDb();
		expect(getSessionStatsByModelAndAgentType("/tmp/session.jsonl")).toEqual([]);
		expect(getSessionStatsByModelAndAgentType("")).toEqual([]);
		expect(getSessionStatsByModelAndAgentType("/tmp/session.txt")).toEqual([]);
	});

	it("groups one session tree by model and actor, leaving sibling sessions out", async () => {
		await initDb();
		const project = path.join(getSessionsDir(), "--work--session-model");
		const mainFile = path.join(project, "1700000000000_root.jsonl");
		const artifacts = mainFile.slice(0, -6);
		const tokens = (n: number) => ({ input: 100 * n, output: 10 * n, cacheRead: n, cacheWrite: 2 * n });
		insertMessageStats([
			stat("main", mainFile, "main", "model-a", tokens(1)),
			stat("sub", path.join(artifacts, "Worker.jsonl"), "subagent", "model-b", tokens(2)),
			stat("advisor", path.join(artifacts, "__advisor.arch.jsonl"), "advisor", "model-b", tokens(3)),
			stat("nested-sub", path.join(artifacts, "Worker", "Nested.jsonl"), "subagent", "model-b", tokens(4)),
			stat("sibling", path.join(project, "1700000000000_root-sibling.jsonl"), "main", "model-c", tokens(9)),
		]);
		// A row whose agent_type predates the main/subagent/advisor labels counts as main.
		const raw = new Database(getStatsDbPath());
		raw.run("UPDATE messages SET agent_type = 'legacy' WHERE entry_id = 'main'");
		raw.close();

		const rows = getSessionStatsByModelAndAgentType(mainFile);

		expect(rows).toEqual([
			{
				model: "model-a",
				provider: "model-a-provider",
				agentType: "main",
				totalRequests: 1,
				totalInputTokens: 100,
				totalOutputTokens: 10,
				totalCacheReadTokens: 1,
				totalCacheWriteTokens: 2,
				totalTokens: 113,
				totalCost: 0.01,
			},
			{
				model: "model-b",
				provider: "model-b-provider",
				agentType: "advisor",
				totalRequests: 1,
				totalInputTokens: 300,
				totalOutputTokens: 30,
				totalCacheReadTokens: 3,
				totalCacheWriteTokens: 6,
				totalTokens: 339,
				totalCost: 0.01,
			},
			{
				model: "model-b",
				provider: "model-b-provider",
				agentType: "subagent",
				totalRequests: 2,
				totalInputTokens: 600,
				totalOutputTokens: 60,
				totalCacheReadTokens: 6,
				totalCacheWriteTokens: 12,
				totalTokens: 678,
				totalCost: 0.02,
			},
		]);
		expect(getSessionStatsByModelAndAgentType(path.join(artifacts, "Worker", "Nested.jsonl"))).toEqual(rows);
	});
});

describe("syncSessionTree", () => {
	it("skips empty and non-transcript paths", async () => {
		expect(await syncSessionTree("", { workers: 1 })).toEqual({ processed: 0, files: 0 });
		expect(await syncSessionTree("/tmp/session.txt", { workers: 1 })).toEqual({ processed: 0, files: 0 });
		await initDb();
		expect(getOverallStats().totalRequests).toBe(0);
	});

	it("syncs only the selected tree and leaves global backfill markers for a full sync", async () => {
		const project = path.join(getSessionsDir(), "--tmp--sync-tree");
		const mainFile = path.join(project, "session.jsonl");
		const artifacts = mainFile.slice(0, -6);
		await writeJsonl(mainFile, [assistantEntry("main", "model-main")]);
		await writeJsonl(path.join(artifacts, "Worker.jsonl"), [assistantEntry("child", "model-child")]);
		await writeJsonl(path.join(artifacts, "__advisor.arch.jsonl"), [assistantEntry("advisor", "model-advisor")]);
		await writeJsonl(path.join(artifacts, "Worker", "Nested.jsonl"), [assistantEntry("nested", "model-nested")]);
		await writeJsonl(path.join(project, "session-sibling.jsonl"), [assistantEntry("sibling", "model-sibling")]);
		await initDb();
		const raw = new Database(getStatsDbPath());
		raw.run("DELETE FROM meta WHERE key = 'tool_calls_v3'");
		raw.close();

		expect(await syncSessionTree(mainFile, { workers: 1 })).toEqual({ processed: 4, files: 4 });
		expect(await syncSessionTree(mainFile, { workers: 1 })).toEqual({ processed: 0, files: 0 });

		const check = new Database(getStatsDbPath());
		const models = check.query("SELECT model FROM messages ORDER BY model").all() as Array<{ model: string }>;
		const marker = check.query("SELECT value FROM meta WHERE key = 'tool_calls_v3'").get();
		check.close();
		expect(models.map(row => row.model)).toEqual(["model-advisor", "model-child", "model-main", "model-nested"]);
		expect(marker).toBeNull();
	});
});

describe("syncAllSessions controls", () => {
	it("skips the global scan when one completed within freshnessMs", async () => {
		await writeJsonl(path.join(getSessionsDir(), "--tmp--fresh", "session.jsonl"), [assistantEntry("a", "m")]);

		expect(await syncAllSessions({ workers: 1, freshnessMs: 60_000 })).toEqual({ processed: 1, files: 1 });
		await writeJsonl(path.join(getSessionsDir(), "--tmp--fresh", "later.jsonl"), [assistantEntry("b", "m")]);
		expect(await syncAllSessions({ workers: 1, freshnessMs: 60_000 })).toEqual({ processed: 0, files: 0 });
		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 1, files: 1 });
	});

	it("returns at once with nothing synced when skipIfBusy meets a held sync lock", async () => {
		await writeJsonl(path.join(getSessionsDir(), "--tmp--busy", "session.jsonl"), [assistantEntry("a", "m")]);
		await initDb();

		await withFileLock(
			`${getStatsDbPath()}.sync`,
			async () => {
				expect(await syncAllSessions({ workers: 1, lockWaitMs: 0, skipIfBusy: true })).toEqual({
					processed: 0,
					files: 0,
				});
			},
			{ retries: 1 },
		);
		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 1, files: 1 });
	});
});
