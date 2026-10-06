/**
 * Process-wide placement of session sync work.
 *
 * `syncAllSessions` / `syncSessionTree` write stats.db through synchronous
 * `bun:sqlite` calls on the calling thread; a cold ingest of a large sessions
 * tree takes minutes. An interactive host (the coding-agent TUI) registers a
 * {@link SessionSyncHost} that runs those syncs in a process owning its own
 * SQLite handle, so every in-process caller (the dashboard's live ingest,
 * extensions loading the stats runtime) stays off the UI event loop without
 * each having to opt in. Hosts that are themselves the sync process (CLI
 * worker subprocesses, tests, standalone omp-stats) leave it unset and sync
 * inline.
 *
 * Kept free of runtime imports so registering a host costs nothing at CLI
 * startup.
 */
import type { SyncOptions } from "./aggregator";

export interface SessionSyncResult {
	processed: number;
	files: number;
}

export interface SessionSyncHost {
	syncAllSessions(opts?: SyncOptions): Promise<SessionSyncResult>;
	syncSessionTree(sessionFile: string, opts?: SyncOptions): Promise<SessionSyncResult>;
}

let activeHost: SessionSyncHost | null = null;

/** Route this process's session syncs through `host` (null syncs inline); returns a restore function. */
export function setSessionSyncHost(host: SessionSyncHost | null): () => void {
	const previous = activeHost;
	activeHost = host;
	return () => {
		activeHost = previous;
	};
}

/** The registered host, or null when syncs run inline on the calling thread. */
export function getSessionSyncHost(): SessionSyncHost | null {
	return activeHost;
}
