/**
 * Wire types between the interactive process and the one-shot stats
 * subprocess. `bun:sqlite` is synchronous, so the daily-activity aggregate
 * (a scan over every `messages` row in the heatmap window) and session syncs
 * run in a child process — on a multi-GB stats database each query stalls the
 * event loop for seconds, and a cold ingest of the sessions tree for minutes,
 * which froze the TUI when it ran inline. See `activity-client.ts` (the
 * `/usage` heatmap) and `sync-client.ts` (session syncs requested anywhere in
 * the interactive process) for the spawn/kill glue.
 */
import type { SyncOptions, SyncProgress } from "@oh-my-pi/omp-stats/aggregator";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { WorkerLogMessage } from "../subprocess/worker-client";

export { STATS_ACTIVITY_WORKER_ARG } from "../cli/worker-selectors";

/** `SyncOptions` minus the callback, which cannot cross the IPC boundary; progress streams back instead. */
export type StatsSyncRequestOptions = Omit<SyncOptions, "onProgress">;

export type StatsActivityWorkerInbound =
	| { type: "ping"; id: string }
	/** Push cached activity, run an incremental session sync, push again, then `done`. */
	| { type: "load"; id: string }
	/** Run `syncAllSessions(options)`, streaming sampled `sync-progress`, then `synced`. */
	| { type: "sync"; id: string; options: StatsSyncRequestOptions };

export type StatsActivityWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "activity"; id: string; points: DailyActivityPoint[] }
	| { type: "done"; id: string }
	| { type: "sync-progress"; id: string; progress: SyncProgress }
	| { type: "synced"; id: string; processed: number; files: number }
	| { type: "error"; id: string; error: string }
	| WorkerLogMessage;

export interface StatsActivityTransport {
	send(message: StatsActivityWorkerOutbound): void;
	onMessage(handler: (message: StatsActivityWorkerInbound) => void): () => void;
}
