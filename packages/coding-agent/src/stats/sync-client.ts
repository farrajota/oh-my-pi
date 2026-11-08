import type { SyncOptions } from "@oh-my-pi/omp-stats/aggregator";
import type { SessionSyncResult } from "@oh-my-pi/omp-stats/sync-host";
import { wrapRefCountedSubprocess } from "../subprocess/model-worker-host";
import {
	createWorkerSubprocess,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	type SpawnedSubprocess,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import {
	STATS_ACTIVITY_WORKER_ARG,
	type StatsActivityWorkerInbound,
	type StatsActivityWorkerOutbound,
} from "./activity-protocol";

type StatsSyncWorkerHandle = RefCountedWorkerHandle<StatsActivityWorkerInbound, StatsActivityWorkerOutbound>;

interface PendingSync {
	onProgress: SyncOptions["onProgress"];
	resolve(result: SessionSyncResult): void;
	reject(error: unknown): void;
}

interface LiveWorker {
	handle: StatsSyncWorkerHandle;
	proc: SpawnedSubprocess<StatsActivityWorkerOutbound>["proc"];
	unsubscribe: (() => void)[];
}

/**
 * Runs `syncAllSessions` requests in one long-lived stats subprocess (the activity worker),
 * spawned on the first sync and reused for every later one, so a TUI whose dashboard asks
 * for a targeted sync every few hundred milliseconds does not pay a process start each time.
 *
 * Progress streams back to each request's `onProgress`; a throwing callback rejects that
 * request, as it would inline (the child finishes the batch it is writing). The worker is
 * referenced only while a sync is in flight, so an idle one never holds the process open, and
 * it exits on its own when the parent goes away. A worker that dies or faults fails its
 * in-flight syncs and is replaced by the next sync. There is no inline fallback: syncing here
 * would put the SQLite ingest back on the caller's event loop.
 */
export class StatsSyncClient {
	#worker: LiveWorker | undefined;
	readonly #pending = new Map<string, PendingSync>();
	#nextId = 0;

	async syncAllSessions(opts: SyncOptions = {}): Promise<SessionSyncResult> {
		const { onProgress, ...options } = opts;
		const worker = this.#ensureWorker();
		const id = `sync-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<SessionSyncResult>();
		this.#pending.set(id, { onProgress, resolve, reject });
		if (this.#pending.size === 1) worker.handle.ref();
		try {
			worker.handle.send({ type: "sync", id, options });
			return await promise;
		} finally {
			this.#pending.delete(id);
			if (this.#pending.size === 0) this.#worker?.handle.unref();
		}
	}

	/** Fail in-flight syncs and kill the worker. */
	async dispose(): Promise<void> {
		const worker = this.#worker;
		this.#detach(new Error("stats sync host disposed"));
		await worker?.handle.terminate();
	}

	#ensureWorker(): LiveWorker {
		const current = this.#worker;
		// An exited worker drops requests silently, and its exit error can arrive after the
		// exit itself, so check the process rather than waiting for that error.
		if (current && current.proc.exitCode === null && current.proc.signalCode === null) return current;
		if (current) {
			this.#detach(new Error("stats sync subprocess exited"));
			void current.handle.terminate();
		}
		const spawned = createWorkerSubprocess<StatsActivityWorkerOutbound>({
			spawnCommand: resolveWorkerSpawnCmd(STATS_ACTIVITY_WORKER_ARG),
			env: workerEnvFromParent(),
			exitLabel: "stats sync subprocess",
		});
		const handle = wrapRefCountedSubprocess<StatsActivityWorkerInbound, StatsActivityWorkerOutbound>(
			spawned,
			"stats-sync",
		);
		const worker: LiveWorker = { handle, proc: spawned.proc, unsubscribe: [] };
		worker.unsubscribe = [
			handle.onMessage(message => this.#handleMessage(message)),
			handle.onError(error => {
				if (this.#worker !== worker) return;
				this.#detach(error);
				void handle.terminate();
			}),
		];
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
		const worker = this.#worker;
		this.#worker = undefined;
		if (worker) for (const unsubscribe of worker.unsubscribe) unsubscribe();
		for (const pending of this.#pending.values()) pending.reject(error);
	}
}
