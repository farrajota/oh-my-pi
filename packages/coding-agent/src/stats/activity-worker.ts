/**
 * Stats activity worker. Loaded inside the subprocess spawned by
 * `activity-client.ts` / `sync-client.ts` (re-entered through the agent CLI's
 * hidden `__omp_worker_stats_activity` selector). Owns the stats DB handle for
 * the `/usage` heatmap load and for session syncs so the synchronous SQLite
 * work never runs on the TUI thread; the parent SIGKILLs the child once `done`
 * or `synced` arrives. Worker selectors dispatch before the CLI registers its
 * session sync host, so syncs here run inline in this process.
 */
import { type SyncProgress, syncAllSessions, syncSessionTree } from "@oh-my-pi/omp-stats/aggregator";
import { getDailyActivity } from "@oh-my-pi/omp-stats/db";
import type { StatsActivityTransport, StatsActivityWorkerInbound } from "./activity-protocol";

/**
 * Forward every committed batch plus a sparse sample of skipped files. A cold
 * scan reports once per transcript (tens of thousands), and relaying each one
 * would make the parent's event loop pay for the sync after all.
 */
const PROGRESS_SAMPLE_FILES = 64;

async function handleLoad(
	transport: StatsActivityTransport,
	message: Extract<StatsActivityWorkerInbound, { type: "load" }>,
): Promise<void> {
	try {
		// Whatever the DB already has paints first; the incremental sync then
		// converges the heatmap on fresh session data.
		transport.send({ type: "activity", id: message.id, points: await getDailyActivity() });
		await syncAllSessions();
		transport.send({ type: "activity", id: message.id, points: await getDailyActivity() });
		transport.send({ type: "done", id: message.id });
	} catch (error) {
		transport.send({
			type: "error",
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function handleSync(
	transport: StatsActivityTransport,
	message: Extract<StatsActivityWorkerInbound, { type: "sync" }>,
): Promise<void> {
	let lastProcessed = 0;
	const onProgress = (progress: SyncProgress): void => {
		const committed = progress.processed !== lastProcessed;
		if (!committed && progress.current !== progress.total && progress.current % PROGRESS_SAMPLE_FILES !== 0) return;
		lastProcessed = progress.processed;
		transport.send({ type: "sync-progress", id: message.id, progress });
	};
	try {
		const options = { ...message.options, onProgress };
		const { processed, files } =
			message.target.kind === "tree"
				? await syncSessionTree(message.target.sessionFile, options)
				: await syncAllSessions(options);
		transport.send({ type: "synced", id: message.id, processed, files });
	} catch (error) {
		transport.send({
			type: "error",
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function startStatsActivityWorker(transport: StatsActivityTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "load":
				void handleLoad(transport, message);
				return;
			case "sync":
				void handleSync(transport, message);
				return;
		}
	});
}
