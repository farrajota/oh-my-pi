import { parentPort } from "node:worker_threads";
import { Database } from "bun:sqlite";
import { runAuthorityWorker } from "../../src/registry/authority/worker";

if (!parentPort) throw new Error("Authority commit-failure test worker requires a parent port");

let failAuthorizationCommit = false;
const originalExec = Database.prototype.exec;
Database.prototype.exec = new Proxy(originalExec, {
	apply(target, database, args) {
		const result = Reflect.apply(target, database, args);
		const sql = args[0];
		if (failAuthorizationCommit && typeof sql === "string" && sql.trim().toUpperCase() === "COMMIT") {
			failAuthorizationCommit = false;
			throw new Error("Injected SQLite exception after a real authorization COMMIT");
		}
		return result;
	},
});

parentPort.on("message", (message: unknown) => {
	if (
		typeof message === "object" &&
		message !== null &&
		"kind" in message &&
		message.kind === "call" &&
		"method" in message &&
		message.method === "authorizeLocalEffect"
	) {
		failAuthorizationCommit = true;
	}
});

void runAuthorityWorker();
