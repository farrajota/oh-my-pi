import { Database } from "bun:sqlite";
import { runAuthorityWorker } from "../../src/registry/authority/worker";

let commitCount = 0;
const originalExec = Database.prototype.exec;
Database.prototype.exec = new Proxy(originalExec, {
	apply(target, database, args) {
		const result = Reflect.apply(target, database, args);
		const sql = args[0];
		if (typeof sql === "string" && sql.trim().toUpperCase() === "COMMIT" && ++commitCount === 2) {
			throw new Error("Injected exception after the real SQLite authority-open COMMIT");
		}
		return result;
	},
});

void runAuthorityWorker();
