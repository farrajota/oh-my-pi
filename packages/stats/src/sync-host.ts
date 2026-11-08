/**
 * Where this process runs session syncs.
 *
 * `syncAllSessions` (and `syncSessionTree`, which goes through it) writes stats.db with
 * synchronous `bun:sqlite` calls on the calling thread; a cold ingest of a large sessions tree
 * takes minutes. An interactive host (the coding-agent TUI) registers a {@link SessionSyncHost}
 * that runs syncs in a process with its own SQLite handle, so every in-process caller (the live
 * dashboard ingest, extensions using the stats modules) stays off the UI event loop. Processes
 * that are themselves the sync process (worker subprocesses, tests, standalone embedding) leave
 * it unset and sync inline.
 *
 * Kept free of runtime imports so registering a host costs nothing at CLI startup.
 */
import type { SyncOptions } from "./aggregator";

export interface SessionSyncResult {
	processed: number;
	files: number;
}

export interface SessionSyncHost {
	syncAllSessions(opts?: SyncOptions): Promise<SessionSyncResult>;
}

let activeHost: SessionSyncHost | null = null;

/** Route this process's session syncs through `host` (null syncs inline); returns the restore function. */
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
