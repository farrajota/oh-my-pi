export interface StatsRuntime {
	aggregator: typeof import("@oh-my-pi/omp-stats/aggregator");
	db: typeof import("@oh-my-pi/omp-stats/db");
}

/** Load stats modules relative to the coding-agent package, not the calling extension. */
export async function loadStatsRuntime(): Promise<StatsRuntime> {
	const [aggregator, db] = await Promise.all([
		import("@oh-my-pi/omp-stats/aggregator"),
		import("@oh-my-pi/omp-stats/db"),
	]);
	return { aggregator, db };
}
