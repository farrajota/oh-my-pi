/**
 * Worker that plays a second stats.db writer (another omp process refreshing
 * rollups or syncing): it takes the WAL write lock, reports `locked`, holds it
 * across the parent's next statements, then commits and reports `committed`.
 */
import { Database } from "bun:sqlite";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ dbPath: string; holdMs: number }>) => {
	const db = new Database(event.data.dbPath);
	db.run("BEGIN IMMEDIATE");
	db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('write-lock-holder', '1')");
	self.postMessage("locked");
	await Bun.sleep(event.data.holdMs);
	db.run("COMMIT");
	db.close();
	self.postMessage("committed");
};
