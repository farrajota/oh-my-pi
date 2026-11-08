import { setSessionSyncHost } from "@oh-my-pi/omp-stats/sync-host";
import type { StatsSyncClient } from "./sync-client";

/**
 * Route every stats session sync requested in this process (the dashboard's live ingest,
 * extensions using the stats runtime) through one stats subprocess that lives as long as the
 * host, so the TUI thread never runs the synchronous SQLite ingest. Only the interactive TUI
 * installs it; one-shot commands sync inline. The subprocess glue loads on first sync, so
 * installing the host pulls in only the registry module. Returns the restore function, which
 * also kills the subprocess.
 */
export function installStatsSyncHost(): () => void {
	let client: StatsSyncClient | undefined;
	const restore = setSessionSyncHost({
		async syncAllSessions(opts) {
			if (!client) {
				const { StatsSyncClient } = await import("./sync-client");
				client ??= new StatsSyncClient();
			}
			return await client.syncAllSessions(opts);
		},
	});
	return () => {
		restore();
		// dispose() kills the child synchronously and never rejects.
		void client?.dispose();
	};
}
