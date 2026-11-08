/**
 * Stats modules for extensions (`@oh-my-pi/pi-coding-agent/stats-runtime`). Extensions load
 * from the user's agent directory, where `@oh-my-pi/omp-stats` may not resolve, or may resolve to
 * a second copy with its own database handle; this loader imports the agent's own copies.
 */
import type * as StatsAggregator from "@oh-my-pi/omp-stats/aggregator";
import type * as StatsDb from "@oh-my-pi/omp-stats/db";
import type * as StatsRollup from "@oh-my-pi/omp-stats/rollup";

export interface StatsRuntime {
	aggregator: typeof StatsAggregator;
	db: typeof StatsDb;
	rollup: typeof StatsRollup;
}

/** Load the stats aggregator, database and rollup modules on first use. */
export async function loadStatsRuntime(): Promise<StatsRuntime> {
	const [aggregator, db, rollup] = await Promise.all([
		import("@oh-my-pi/omp-stats/aggregator"),
		import("@oh-my-pi/omp-stats/db"),
		import("@oh-my-pi/omp-stats/rollup"),
	]);
	return { aggregator, db, rollup };
}
