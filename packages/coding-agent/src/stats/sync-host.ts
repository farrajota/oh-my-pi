import { setSessionSyncHost } from "@oh-my-pi/omp-stats/sync-host";

/**
 * Route every stats session sync requested in this process (the dashboard's live ingest,
 * extensions using the stats runtime) through a one-shot stats subprocess. The subprocess glue
 * loads on first sync, so installing the host at CLI startup pulls in only the registry module.
 * Returns the restore function.
 */
export function installStatsSyncHost(): () => void {
	return setSessionSyncHost({
		async syncAllSessions(opts) {
			const { syncAllSessionsInSubprocess } = await import("./sync-client");
			return await syncAllSessionsInSubprocess(opts);
		},
	});
}
