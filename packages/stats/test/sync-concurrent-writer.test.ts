import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { applySessionParseResults, getMessageCount, initDb } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-concurrent-writer-");

function writeSession(): string {
	const file = path.join(getSessionsDir(), "--tmp--concurrent-writer", "session.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const entry = {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	fs.writeFileSync(file, `${JSON.stringify(entry)}\n`);
	return file;
}

describe("stats batch commit with a concurrent writer", () => {
	// Session syncs run in a subprocess while the dashboard host refreshes
	// rollups on its own connection, so a batch commit routinely starts while
	// another connection holds the write lock. It must wait for that writer
	// (busy_timeout) instead of failing with "database is locked".
	it("waits for another connection's write transaction instead of failing", async () => {
		const sessionFile = writeSession();
		await initDb();
		const result = await parseSessionFile(sessionFile, 0);
		const holder = new Worker(new URL("./helpers/write-lock-holder.ts", import.meta.url).href, { type: "module" });
		try {
			const locked = Promise.withResolvers<void>();
			const committed = Promise.withResolvers<void>();
			holder.onmessage = event => {
				if (event.data === "locked") locked.resolve();
				if (event.data === "committed") committed.resolve();
			};
			holder.postMessage({ dbPath: getStatsDbPath(), holdMs: 1000 });
			await locked.promise;

			const applied = applySessionParseResults([{ sessionFile, result, rebuild: true, replay: false }]);
			await committed.promise;

			expect(applied).toMatchObject({ processed: 1, files: 1 });
			expect(getMessageCount()).toBe(1);
		} finally {
			holder.terminate();
		}
	});
});
