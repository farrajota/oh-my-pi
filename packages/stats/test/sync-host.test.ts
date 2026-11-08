import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type SyncOptions, syncAllSessions, syncSessionTree } from "@oh-my-pi/omp-stats/aggregator";
import { StatsLive } from "@oh-my-pi/omp-stats/live";
import { type SessionSyncHost, setSessionSyncHost } from "@oh-my-pi/omp-stats/sync-host";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-host-");

let restoreHost: (() => void) | undefined;

afterEach(() => {
	restoreHost?.();
	restoreHost = undefined;
	vi.restoreAllMocks();
});

/** Run `request` and resolve once StatsLive reports the resulting sync finished (idle, newly synced). */
async function syncOnce(live: StatsLive, request: () => void): Promise<void> {
	const finished = Promise.withResolvers<void>();
	const before = live.status().sync.lastSyncedAt;
	const unsubscribe = live.subscribe(status => {
		if (status.sync.phase === "idle" && status.sync.lastSyncedAt !== before) finished.resolve();
	});
	try {
		request();
		await finished.promise;
	} finally {
		unsubscribe();
	}
}

function recordingHost(calls: (SyncOptions | undefined)[]): SessionSyncHost {
	return {
		async syncAllSessions(opts) {
			calls.push(opts);
			return { processed: 7, files: 3 };
		},
	};
}

function writeSession(name: string): string {
	const file = path.join(getSessionsDir(), "--tmp--sync-host", `${name}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const entry = {
		type: "message",
		id: `${name}-assistant`,
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
	};
	fs.writeFileSync(file, `${JSON.stringify(entry)}\n`);
	return file;
}

describe("session sync host", () => {
	it("hands a full sync to the registered host without opening stats.db in this process", async () => {
		writeSession("main");
		const calls: (SyncOptions | undefined)[] = [];
		restoreHost = setSessionSyncHost(recordingHost(calls));

		const result = await syncAllSessions({ freshnessMs: 30_000, skipIfBusy: true });

		expect(result).toEqual({ processed: 7, files: 3 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ freshnessMs: 30_000, skipIfBusy: true });
		expect(fs.existsSync(getStatsDbPath())).toBe(false);
	});

	it("hands a session-tree sync to the registered host without opening stats.db in this process", async () => {
		const sessionFile = writeSession("tree");
		const nested = path.join(sessionFile.slice(0, -".jsonl".length), "Worker.jsonl");
		fs.mkdirSync(path.dirname(nested), { recursive: true });
		fs.copyFileSync(sessionFile, nested);
		const calls: (SyncOptions | undefined)[] = [];
		restoreHost = setSessionSyncHost(recordingHost(calls));

		const result = await syncSessionTree(sessionFile, { workers: 1 });

		expect(result).toEqual({ processed: 7, files: 3 });
		expect(calls).toEqual([{ workers: 1, files: [sessionFile, nested] }]);
		expect(fs.existsSync(getStatsDbPath())).toBe(false);
	});

	it("syncs inline once the host registration is restored", async () => {
		writeSession("inline");
		const calls: (SyncOptions | undefined)[] = [];
		const restore = setSessionSyncHost(recordingHost(calls));
		restore();

		const result = await syncAllSessions({ workers: 1 });

		expect(calls).toHaveLength(0);
		expect(result).toEqual({ processed: 1, files: 1 });
		expect(fs.existsSync(getStatsDbPath())).toBe(true);
	});

	it("routes the dashboard's live full and targeted syncs through the registered host", async () => {
		// StatsLive drops a status identical to the last one it sent, and a targeted run changes only
		// `lastSyncedAt`. A clock that moves on every read makes each run's end a distinct event.
		let now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => (now += 10_000));
		const calls: (SyncOptions | undefined)[] = [];
		restoreHost = setSessionSyncHost(recordingHost(calls));
		const live = new StatsLive();
		try {
			await syncOnce(live, () => live.requestSync());
			await syncOnce(live, () => live.requestSync(["/sessions/changed.jsonl"]));
		} finally {
			live.stop();
		}

		expect(calls.map(call => call?.files)).toEqual([undefined, ["/sessions/changed.jsonl"]]);
	});
});
