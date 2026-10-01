import type * as StatsAggregator from "@oh-my-pi/omp-stats/aggregator";
import type * as StatsDb from "@oh-my-pi/omp-stats/db";
import type * as StatsRollup from "@oh-my-pi/omp-stats/rollup";

export interface StatsRuntime {
	aggregator: typeof StatsAggregator;
	db: typeof StatsDb;
	rollup: typeof StatsRollup;
}

/** Load stats modules relative to the coding-agent package, not the calling extension. */
export async function loadStatsRuntime(): Promise<StatsRuntime> {
	const [aggregator, db, rollup] = await Promise.all([
		import("@oh-my-pi/omp-stats/aggregator"),
		import("@oh-my-pi/omp-stats/db"),
		import("@oh-my-pi/omp-stats/rollup"),
	]);
	return { aggregator, db, rollup };
}
