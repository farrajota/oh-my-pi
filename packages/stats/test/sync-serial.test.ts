import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions, syncSessionTree } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats, initDb } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-serial-");

afterEach(() => {
	vi.restoreAllMocks();
});

async function writeSessionFile(options?: { includeCost?: boolean }): Promise<void> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const includeCost = options?.includeCost ?? true;
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				...(includeCost ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}),
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(sessionFile, `${JSON.stringify(assistant)}\n`);
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

function toolResultEntry(entryId: string): object {
	return {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: Date.now(),
		},
	};
}

async function writeJsonl(file: string, entries: readonly object[]): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("stats sync serial mode", () => {
	it("honors workers: 1 without spawning a worker", async () => {
		await writeSessionFile();
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("skips a fresh global scan after a prior process completed it", async () => {
		await writeSessionFile();

		expect(await syncAllSessions({ workers: 1, freshnessMs: 60_000 })).toEqual({
			processed: 1,
			files: 1,
		});
		expect(await syncAllSessions({ workers: 1, freshnessMs: 60_000 })).toEqual({
			processed: 0,
			files: 0,
		});
	});

	it("returns cached-data fallback immediately when the global lock is busy", async () => {
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
	});

	it("syncs legacy session usage without a cost breakdown", async () => {
		await writeSessionFile({ includeCost: false });

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced).toEqual({ processed: 1, files: 1 });
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeGreaterThan(0);
	});

	it("uses the serial parser by default on macOS", async () => {
		await writeSessionFile();
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions();
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("spawns a worker pool when callers explicitly request workers: 2 with a single file", async () => {
		await writeSessionFile();
		const workerProbe = new Error("worker probe");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw workerProbe;
		});

		await expect(syncAllSessions({ workers: 2 })).rejects.toBe(workerProbe);
		expect(workerSpy).toHaveBeenCalled();
	});
});

describe("syncSessionTree", () => {
	it("initializes but skips empty and non-transcript paths", async () => {
		expect(await syncSessionTree("", { workers: 1 })).toEqual({ processed: 0, files: 0 });
		expect(await syncSessionTree("/tmp/session.txt", { workers: 1 })).toEqual({ processed: 0, files: 0 });
		expect(getOverallStats().totalRequests).toBe(0);
	});

	it("syncs only the selected recursive tree without completing global backfills", async () => {
		const project = path.join(getSessionsDir(), "--tmp--sync-tree");
		const mainFile = path.join(project, "session.jsonl");
		const artifacts = mainFile.slice(0, -6);
		await writeJsonl(mainFile, [assistantEntry("main", "model-main")]);
		await writeJsonl(path.join(artifacts, "Worker.jsonl"), [
			assistantEntry("child", "model-child"),
			toolResultEntry("tool-result"),
		]);
		await writeJsonl(path.join(artifacts, "__advisor.arch.jsonl"), [assistantEntry("advisor", "model-advisor")]);
		await writeJsonl(path.join(artifacts, "Worker", "Nested.jsonl"), [assistantEntry("nested", "model-nested")]);
		await writeJsonl(path.join(artifacts, "Worker", "__advisor.security.jsonl"), [
			assistantEntry("nested-advisor", "model-nested-advisor"),
		]);
		await writeJsonl(path.join(project, "session-sibling.jsonl"), [assistantEntry("sibling", "model-sibling")]);

		await initDb();
		const markerKeys = [
			"user_messages_v8",
			"tool_calls_v1",
			"user_message_links_v1",
			"premium_requests_priority_v1",
		] as const;
		const raw = new Database(getStatsDbPath());
		const seedMarker = raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
		for (const key of markerKeys) seedMarker.run(key, `sentinel:${key}`);
		raw.close();

		expect(await syncSessionTree(mainFile, { workers: 1 })).toEqual({ processed: 5, files: 5 });
		expect(getOverallStats()).toMatchObject({
			totalRequests: 5,
			totalInputTokens: 5,
			totalOutputTokens: 10,
			totalCacheReadTokens: 15,
			totalCacheWriteTokens: 20,
		});
		expect(await syncSessionTree(mainFile, { workers: 1 })).toEqual({ processed: 0, files: 0 });

		const verification = new Database(getStatsDbPath());
		const models = verification.query("SELECT model FROM messages ORDER BY model").all() as Array<{ model: string }>;
		expect(models.map(row => row.model)).toEqual([
			"model-advisor",
			"model-child",
			"model-main",
			"model-nested",
			"model-nested-advisor",
		]);
		const markers = verification
			.query(
				"SELECT key, value FROM meta WHERE key IN ('user_messages_v8', 'tool_calls_v1', 'user_message_links_v1', 'premium_requests_priority_v1') ORDER BY key",
			)
			.all() as Array<{ key: string; value: string }>;
		expect(markers).toEqual([...markerKeys].sort().map(key => ({ key, value: `sentinel:${key}` })));
		verification.close();
	});
});
