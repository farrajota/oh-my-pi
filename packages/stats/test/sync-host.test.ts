import { afterEach, describe, expect, it } from "bun:test";
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
});

interface HostCall {
	kind: "all" | "tree";
	sessionFile?: string;
	opts?: SyncOptions;
}

function recordingHost(calls: HostCall[], onCall?: () => void): SessionSyncHost {
	return {
		async syncAllSessions(opts) {
			calls.push({ kind: "all", opts });
			onCall?.();
			return { processed: 7, files: 3 };
		},
		async syncSessionTree(sessionFile, opts) {
			calls.push({ kind: "tree", sessionFile, opts });
			onCall?.();
			return { processed: 2, files: 1 };
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
		const calls: HostCall[] = [];
		restoreHost = setSessionSyncHost(recordingHost(calls));

		const result = await syncAllSessions({ freshnessMs: 30_000, skipIfBusy: true });

		expect(result).toEqual({ processed: 7, files: 3 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ kind: "all", opts: { freshnessMs: 30_000, skipIfBusy: true } });
		expect(fs.existsSync(getStatsDbPath())).toBe(false);
	});

	it("hands a session-tree sync to the registered host without opening stats.db in this process", async () => {
		const sessionFile = writeSession("tree");
		const calls: HostCall[] = [];
		restoreHost = setSessionSyncHost(recordingHost(calls));

		const result = await syncSessionTree(sessionFile, { workers: 1 });

		expect(result).toEqual({ processed: 2, files: 1 });
		expect(calls).toEqual([{ kind: "tree", sessionFile, opts: { workers: 1 } }]);
		expect(fs.existsSync(getStatsDbPath())).toBe(false);
	});

	it("syncs inline once the host registration is restored", async () => {
		writeSession("inline");
		const calls: HostCall[] = [];
		const restore = setSessionSyncHost(recordingHost(calls));
		restore();

		const result = await syncAllSessions({ workers: 1 });

		expect(calls).toHaveLength(0);
		expect(result).toEqual({ processed: 1, files: 1 });
		expect(fs.existsSync(getStatsDbPath())).toBe(true);
	});

	it("routes the dashboard's live full and targeted syncs through the registered host", async () => {
		const calls: HostCall[] = [];
		let notify: (() => void) | undefined;
		restoreHost = setSessionSyncHost(recordingHost(calls, () => notify?.()));
		const live = new StatsLive();
		try {
			const full = Promise.withResolvers<void>();
			notify = full.resolve;
			live.requestSync();
			await full.promise;

			const targeted = Promise.withResolvers<void>();
			notify = targeted.resolve;
			live.requestSync(["/sessions/changed.jsonl"]);
			await targeted.promise;

			// Let the targeted run settle before teardown closes the database.
			const settled = Promise.withResolvers<void>();
			const unsubscribe = live.subscribe(() => settled.resolve());
			await settled.promise;
			unsubscribe();
		} finally {
			live.stop();
		}

		expect(calls.map(call => ({ kind: call.kind, files: call.opts?.files }))).toEqual([
			{ kind: "all", files: undefined },
			{ kind: "all", files: ["/sessions/changed.jsonl"] },
		]);
	});
});
