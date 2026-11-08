import type { SyncOptions } from "@oh-my-pi/omp-stats/aggregator";
import type { SessionSyncResult } from "@oh-my-pi/omp-stats/sync-host";
import { logWorkerMessage } from "../subprocess/worker-client";
import { spawnStatsActivityWorker } from "./activity-client";

/**
 * Run `syncAllSessions(opts)` in a one-shot stats subprocess and resolve with its result.
 * Progress streams back to `opts.onProgress`; a throwing callback rejects the sync, as it would
 * inline. There is no inline fallback when the child cannot spawn or dies: syncing here would put
 * the SQLite ingest back on the caller's event loop. The child is SIGKILLed once the request
 * settles; per-batch writes are transactional and the OS-owned sync lock dies with the process.
 */
export async function syncAllSessionsInSubprocess(opts: SyncOptions = {}): Promise<SessionSyncResult> {
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
	worker.send({ type: "sync", id: requestId, options });
	try {
		return await promise;
	} finally {
		offMessage();
		offError();
		await worker.terminate();
	}
}
