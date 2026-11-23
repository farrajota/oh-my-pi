import type { SyncOptions } from "@oh-my-pi/omp-stats/aggregator";
import type { SessionSyncResult } from "@oh-my-pi/omp-stats/sync-host";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { logWorkerMessage } from "../subprocess/worker-client";
import {
	STATS_ACTIVITY_WORKER_ARG,
	type StatsActivityWorkerInbound,
	type StatsActivityWorkerOutbound,
} from "./activity-protocol";

interface PendingSync {
	onProgress: SyncOptions["onProgress"];
	resolve(result: SessionSyncResult): void;
	reject(error: unknown): void;
}

function spawnStatsSyncWorker(): Worker {
	const hostEntry = workerHostEntry();
	return hostEntry
		? new Worker(hostEntry, { type: "module", argv: [STATS_ACTIVITY_WORKER_ARG] })
		: new Worker(new URL("./activity-worker.ts", import.meta.url).href, { type: "module" });
}

/**
 * Runs `syncAllSessions` requests in one long-lived stats activity worker thread, spawned on
 * the first sync and reused for every later one, so a TUI whose dashboard asks for a targeted
 * sync every few hundred milliseconds does not pay a worker start each time.
 *
 * Progress streams back to each request's `onProgress`; a throwing callback rejects that
 * request, as it would inline (the worker finishes the batch it is writing). The worker is
 * referenced only while a sync is in flight, so an idle one never holds the process open. A
 * worker that faults or exits fails its in-flight syncs and is replaced by the next sync. There
 * is no inline fallback: syncing here would put the SQLite ingest back on the caller's thread.
 */
export class StatsSyncClient {
	#worker: Worker | undefined;
	readonly #pending = new Map<string, PendingSync>();
	#nextId = 0;

	async syncAllSessions(opts: SyncOptions = {}): Promise<SessionSyncResult> {
		const { onProgress, ...options } = opts;
		const worker = this.#ensureWorker();
		const id = `sync-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<SessionSyncResult>();
		this.#pending.set(id, { onProgress, resolve, reject });
		if (this.#pending.size === 1) worker.ref();
		try {
			worker.postMessage({ type: "sync", id, options } satisfies StatsActivityWorkerInbound);
			return await promise;
		} finally {
			this.#pending.delete(id);
			if (this.#pending.size === 0) this.#worker?.unref();
		}
	}

	/** Fail in-flight syncs and terminate the worker. */
	dispose(): void {
		const worker = this.#worker;
		this.#detach(new Error("stats sync host disposed"));
		worker?.terminate();
	}

	#ensureWorker(): Worker {
		if (this.#worker) return this.#worker;
		const worker = spawnStatsSyncWorker();
		worker.addEventListener("message", (event: MessageEvent<StatsActivityWorkerOutbound>) =>
			this.#handleMessage(event.data),
		);
		worker.addEventListener("error", (event: ErrorEvent) => {
			if (this.#worker !== worker) return;
			this.#detach(event.error instanceof Error ? event.error : new Error(event.message));
			worker.terminate();
		});
		worker.addEventListener("close", () => {
			if (this.#worker === worker) this.#detach(new Error("stats sync worker exited unexpectedly"));
		});
		worker.unref();
		this.#worker = worker;
		return worker;
	}

	#handleMessage(message: StatsActivityWorkerOutbound): void {
		switch (message.type) {
			case "sync-progress": {
				const pending = this.#pending.get(message.id);
				if (!pending) return;
				try {
					pending.onProgress?.(message.progress);
				} catch (error) {
					pending.reject(error);
				}
				return;
			}
			case "synced":
				this.#pending.get(message.id)?.resolve({ processed: message.processed, files: message.files });
				return;
			case "error":
				this.#pending.get(message.id)?.reject(new Error(message.error));
				return;
			case "log":
				logWorkerMessage(message);
				return;
		}
	}

	/** Forget the current worker and fail every sync it was running. */
	#detach(error: Error): void {
		this.#worker = undefined;
		for (const pending of this.#pending.values()) pending.reject(error);
	}
}
