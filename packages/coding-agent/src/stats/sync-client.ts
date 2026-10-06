import type { SyncOptions } from "@oh-my-pi/omp-stats/aggregator";
import type { SessionSyncResult } from "@oh-my-pi/omp-stats/sync-host";
import { logWorkerMessage } from "../subprocess/worker-client";
import { spawnStatsActivityWorker } from "./activity-client";
import type { StatsSyncTarget } from "./activity-protocol";

/**
 * Run one session sync in a one-shot stats subprocess and resolve with its
 * result. Progress events stream back to `opts.onProgress`; a throwing
 * callback aborts the sync like it does inline. There is deliberately no
 * inline fallback when the child cannot spawn or dies: syncing here would put
 * the multi-minute SQLite ingest back on the caller's event loop. The child is
 * SIGKILLed once the request settles — per-file writes are transactional and
 * the OS-owned sync lock is released with the process.
 */
async function syncInSubprocess(target: StatsSyncTarget, opts: SyncOptions = {}): Promise<SessionSyncResult> {
	const { onProgress, ...options } = opts;
	const worker = spawnStatsActivityWorker();
	const { promise, resolve, reject } = Promise.withResolvers<SessionSyncResult>();
	const requestId = "sync";
	const offMessage = worker.onMessage(message => {
		switch (message.type) {
			case "sync-progress":
				if (message.id !== requestId) return;
				try {
					onProgress?.(message.progress);
				} catch (error) {
					reject(error);
				}
				return;
			case "synced":
				if (message.id === requestId) resolve({ processed: message.processed, files: message.files });
				return;
			case "error":
				reject(new Error(message.error));
				return;
			case "log":
				logWorkerMessage(message);
				return;
		}
	});
	const offError = worker.onError(reject);
	worker.send({ type: "sync", id: requestId, target, options });
	try {
		return await promise;
	} finally {
		offMessage();
		offError();
		await worker.terminate();
	}
}

/** `syncAllSessions` executed in the stats subprocess. */
export function syncAllSessionsInSubprocess(opts?: SyncOptions): Promise<SessionSyncResult> {
	return syncInSubprocess({ kind: "all" }, opts);
}

/** `syncSessionTree` executed in the stats subprocess. */
export function syncSessionTreeInSubprocess(sessionFile: string, opts?: SyncOptions): Promise<SessionSyncResult> {
	return syncInSubprocess({ kind: "tree", sessionFile }, opts);
}
