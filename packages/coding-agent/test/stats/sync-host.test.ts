import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
let restoreWorker: (() => void) | undefined;
const originalAgentDir = getAgentDir();
const originalEnv: Record<string, string | undefined> = {};

// The stats worker thread resolves stats.db from the environment it copies at spawn, so the
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
	restoreWorker?.();
	restoreWorker = undefined;
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

/** Records every stats activity worker thread this process constructs from now on. */
function recordStatsWorkers(): Worker[] {
	const Original = globalThis.Worker;
	const spawned: Worker[] = [];
	globalThis.Worker = class extends Original {
		constructor(url: string | URL, options?: WorkerOptions) {
			super(url, options);
			const argv = (options as { argv?: unknown[] } | undefined)?.argv ?? [];
			if (argv.includes(STATS_WORKER_SELECTOR) || String(url).endsWith("/activity-worker.ts")) spawned.push(this);
		}
	} as typeof Worker;
	restoreWorker = () => {
		globalThis.Worker = Original;
	};
	return spawned;
}

describe("interactive stats sync host", () => {
	it("runs a full session sync in the stats worker thread and forwards its progress", async () => {
		writeSession("first", 3);
		writeSession("second", 2);
		restoreHost = installStatsSyncHost();
		const spawned = recordStatsWorkers();
		const progress: SyncProgress[] = [];

		const result = await syncAllSessions({ onProgress: event => progress.push(event) });

		expect(spawned).toHaveLength(1);
		expect(result).toEqual({ processed: 5, files: 2 });
		expect(progress.at(-1)).toMatchObject({ current: 2, total: 2, processed: 5 });
		expect(storedMessageCount()).toBe(5);
	}, 30_000);

	it("runs a session-tree sync in the stats worker thread", async () => {
		const sessionFile = writeSession("tree", 4);
		restoreHost = installStatsSyncHost();
		const spawned = recordStatsWorkers();

		const result = await syncSessionTree(sessionFile, { workers: 1 });

		expect(spawned).toHaveLength(1);
		expect(result).toEqual({ processed: 4, files: 1 });
		expect(storedMessageCount()).toBe(4);
	});

	it("reuses one stats worker thread for every sync of a long-lived host", async () => {
		const first = writeSession("reuse-a", 2);
		restoreHost = installStatsSyncHost();
		const spawned = recordStatsWorkers();

		expect(await syncAllSessions()).toEqual({ processed: 2, files: 1 });
		const second = writeSession("reuse-b", 3);
		expect(await syncAllSessions({ files: [second] })).toEqual({ processed: 3, files: 1 });
		expect(await syncSessionTree(first, { workers: 1 })).toEqual({ processed: 0, files: 0 });

		expect(spawned).toHaveLength(1);
		expect(storedMessageCount()).toBe(5);
	}, 30_000);

	it("replaces a stats worker that died between syncs", async () => {
		writeSession("respawn-a", 1);
		restoreHost = installStatsSyncHost();
		const spawned = recordStatsWorkers();
		expect(await syncAllSessions()).toEqual({ processed: 1, files: 1 });

		const [worker] = spawned;
		const closed = new Promise<void>(resolve => worker.addEventListener("close", () => resolve(), { once: true }));
		worker.terminate();
		await closed;
		const second = writeSession("respawn-b", 2);

		expect(await syncAllSessions({ files: [second] })).toEqual({ processed: 2, files: 1 });
		expect(spawned).toHaveLength(2);
	}, 30_000);

	it("surfaces a failed worker sync as a rejection", async () => {
		writeSession("locked", 1);
		restoreHost = installStatsSyncHost();

		// Holding the cross-process sync lock here makes the worker's own acquisition time out.
		await withStatsSyncLock(getStatsDbPath(), async () => {
			await expect(syncAllSessions({ lockWaitMs: 0 })).rejects.toThrow("Failed to acquire lock");
		});
	});
});
