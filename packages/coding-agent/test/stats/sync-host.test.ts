import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SyncProgress, syncAllSessions, syncSessionTree, withStatsSyncLock } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb } from "@oh-my-pi/omp-stats/db";
import { installStatsSyncHost } from "@oh-my-pi/pi-coding-agent/stats/sync-host";
import { getAgentDir, getSessionsDir, getStatsDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const STATS_WORKER_SELECTOR = "__omp_worker_stats_activity";
const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

let tempDir: TempDir | undefined;
let restoreHost: (() => void) | undefined;
const originalAgentDir = getAgentDir();
const originalEnv: Record<string, string | undefined> = {};

// The stats worker subprocess resolves stats.db from the environment, so the
// isolated profile must live in env vars it inherits, not only in setAgentDir.
beforeEach(() => {
	tempDir = TempDir.createSync("@omp-stats-sync-host-");
	for (const key of ["PI_CONFIG_DIR", ...XDG_KEYS]) originalEnv[key] = process.env[key];
	for (const key of XDG_KEYS) delete process.env[key];
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	restoreHost?.();
	restoreHost = undefined;
	vi.restoreAllMocks();
	closeDb();
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = undefined;
});

function writeSession(name: string, entries: number): string {
	const file = path.join(getSessionsDir(), "--tmp--stats-sync-host", `${name}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines: string[] = [];
	for (let i = 0; i < entries; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `${name}-${i}`,
				parentId: null,
				timestamp: new Date().toISOString(),
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
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
					duration: 10,
					ttft: 5,
				},
			}),
		);
	}
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function storedMessageCount(): number {
	const db = new Database(getStatsDbPath(), { readonly: true });
	try {
		return (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
	} finally {
		db.close();
	}
}

function statsWorkerSpawns(spawn: { mock: { calls: unknown[][] } }): number {
	return spawn.mock.calls.filter(([options]) => {
		const cmd = (options as { cmd?: string[] }).cmd ?? [];
		return cmd.includes(STATS_WORKER_SELECTOR);
	}).length;
}

describe("interactive stats sync host", () => {
	it("runs a full session sync in the stats worker subprocess and forwards its progress", async () => {
		writeSession("first", 3);
		writeSession("second", 2);
		restoreHost = installStatsSyncHost();
		const spawn = vi.spyOn(Bun, "spawn");
		const progress: SyncProgress[] = [];

		const result = await syncAllSessions({ onProgress: event => progress.push(event) });

		expect(statsWorkerSpawns(spawn)).toBe(1);
		expect(result).toEqual({ processed: 5, files: 2 });
		expect(progress.at(-1)).toMatchObject({ current: 2, total: 2, processed: 5 });
		expect(storedMessageCount()).toBe(5);
	}, 30_000);

	it("runs a session-tree sync in the stats worker subprocess", async () => {
		const sessionFile = writeSession("tree", 4);
		restoreHost = installStatsSyncHost();
		const spawn = vi.spyOn(Bun, "spawn");

		const result = await syncSessionTree(sessionFile, { workers: 1 });

		expect(statsWorkerSpawns(spawn)).toBe(1);
		expect(result).toEqual({ processed: 4, files: 1 });
		expect(storedMessageCount()).toBe(4);
	});

	it("surfaces a failed subprocess sync as a rejection", async () => {
		writeSession("locked", 1);
		restoreHost = installStatsSyncHost();

		// Holding the cross-process sync lock here makes the worker's own acquisition time out.
		await withStatsSyncLock(getStatsDbPath(), async () => {
			await expect(syncAllSessions({ lockWaitMs: 0 })).rejects.toThrow("Failed to acquire lock");
		});
	});
});
