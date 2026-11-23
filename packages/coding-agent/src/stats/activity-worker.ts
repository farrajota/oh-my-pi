/**
 * Stats activity worker thread. Spawned by `activity-client.ts` /
 * `sync-client.ts` as a Bun `Worker` (re-entered through the agent CLI's hidden
 * `__omp_worker_stats_activity` selector, or loaded directly outside a CLI
 * host). Owns the stats DB handle for the `/usage` heatmap load and for session
 * syncs so the synchronous SQLite work never runs on the TUI thread. A heatmap
 * load is one-shot (the parent terminates the worker once `done` arrives); the
 * TUI's sync host keeps one worker and sends it every `sync` request. Module
 * state is per thread, so no session sync host is registered here and syncs
 * run inline.
 */
import { parentPort } from "node:worker_threads";
import { type SyncProgress, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getDailyActivity, readDailyActivity } from "@oh-my-pi/omp-stats/db";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { StatsActivityWorkerInbound, StatsActivityWorkerOutbound } from "./activity-protocol";

if (!parentPort) throw new Error("stats activity worker: missing parentPort");

const port = parentPort;

function send(message: StatsActivityWorkerOutbound): void {
	port.postMessage(message);
}

/**
 * The stored rows, read through a connection that never writes so another
 * process mid-write cannot hold back or fail the heatmap. Null when nothing is
 * readable yet (no database, or a read that fails on a schema this build does
 * not know); the sync's own open migrates it before the paint that follows.
 */
function readStoredActivity(): DailyActivityPoint[] | null {
	try {
		return readDailyActivity();
	} catch (error) {
		send({
			type: "log",
			level: "debug",
			msg: "stats activity cached paint skipped",
			meta: { error: error instanceof Error ? error.message : String(error) },
		});
		return null;
	}
}

async function handleLoad(id: string): Promise<void> {
	try {
		// The stored rows paint first; the incremental sync then converges the
		// heatmap on fresh session data.
		const cached = readStoredActivity();
		if (cached) send({ type: "activity", id, points: cached });
		await syncAllSessions();
		send({ type: "activity", id, points: await getDailyActivity() });
		send({ type: "done", id });
	} catch (error) {
		send({ type: "error", id, error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Files between progress events when nothing was committed. A cold scan reports once per
 * transcript (tens of thousands); relaying each one would make the parent's event loop pay
 * for the sync after all.
 */
const PROGRESS_SAMPLE_FILES = 64;

async function handleSync(message: Extract<StatsActivityWorkerInbound, { type: "sync" }>): Promise<void> {
	let lastProcessed = 0;
	const onProgress = (progress: SyncProgress): void => {
		const committed = progress.processed !== lastProcessed;
		const sampled = progress.current === progress.total || progress.current % PROGRESS_SAMPLE_FILES === 0;
		if (!committed && !sampled) return;
		lastProcessed = progress.processed;
		send({ type: "sync-progress", id: message.id, progress });
	};
	try {
		const { processed, files } = await syncAllSessions({ ...message.options, onProgress });
		send({ type: "synced", id: message.id, processed, files });
	} catch (error) {
		send({ type: "error", id: message.id, error: error instanceof Error ? error.message : String(error) });
	}
}

function handle(data: unknown): void {
	const message = data as StatsActivityWorkerInbound;
	switch (message.type) {
		case "ping":
			send({ type: "pong", id: message.id });
			return;
		case "load":
			void handleLoad(message.id);
			return;
		case "sync":
			void handleSync(message);
			return;
	}
}

const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else port.on("message", handle);
