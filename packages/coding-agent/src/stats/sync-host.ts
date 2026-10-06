import { type SessionSyncHost, setSessionSyncHost } from "@oh-my-pi/omp-stats/sync-host";

// The subprocess glue loads on first sync so registering the host at CLI
// startup pulls in nothing beyond the side-effect-free registry module.
const subprocessSessionSyncHost: SessionSyncHost = {
	async syncAllSessions(opts) {
		const { syncAllSessionsInSubprocess } = await import("./sync-client");
		return await syncAllSessionsInSubprocess(opts);
	},
	async syncSessionTree(sessionFile, opts) {
		const { syncSessionTreeInSubprocess } = await import("./sync-client");
		return await syncSessionTreeInSubprocess(sessionFile, opts);
	},
};

/**
 * Route every stats session sync requested in this process (the `/stats` and
 * `/trace` dashboard's live ingest, extensions using the stats runtime, `omp
 * stats`) through the stats worker subprocess. Returns a restore function.
 */
export function installStatsSyncHost(): () => void {
	return setSessionSyncHost(subprocessSessionSyncHost);
}
