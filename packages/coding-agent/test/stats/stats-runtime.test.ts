/**
 * `@oh-my-pi/pi-coding-agent/stats-runtime` lets an extension load the stats modules the agent
 * itself uses, resolved from the coding-agent package rather than from the extension's directory.
 */
import { describe, expect, it } from "bun:test";
import * as aggregator from "@oh-my-pi/omp-stats/aggregator";
import * as db from "@oh-my-pi/omp-stats/db";
import * as rollup from "@oh-my-pi/omp-stats/rollup";
import { loadStatsRuntime } from "@oh-my-pi/pi-coding-agent/stats-runtime";

describe("loadStatsRuntime", () => {
	it("returns the agent's own stats module instances", async () => {
		const runtime = await loadStatsRuntime();

		// The same instances share one database handle: initDb through the runtime opens the
		// connection the aggregator and rollup queries read.
		expect(runtime.aggregator).toBe(aggregator);
		expect(runtime.db).toBe(db);
		expect(runtime.rollup).toBe(rollup);
		expect(runtime.aggregator.syncSessionTree).toBeFunction();
		expect(runtime.db.getSessionStatsByModelAndAgentType).toBeFunction();
	});
});
