import { register } from "../config/registry";

const ASYNC_POLL_WAIT_DURATIONS = ["5s", "10s", "30s", "1m", "5m", "smart"] as const;

export type AsyncPollWaitDuration = (typeof ASYNC_POLL_WAIT_DURATIONS)[number];

export const cfgAsyncPollWaitDuration = register({
	id: "async.pollWaitDuration",
	type: "enum",
	values: ASYNC_POLL_WAIT_DURATIONS,
	default: "smart",
	ui: {
		tab: "tools",
		group: "Execution",
		label: "Max Poll Time",
		description:
			"How long a `hub` wait watches background jobs before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 5s and lengthens with each back-to-back wait (up to 5m), then resets to 5s after about a minute without waiting.",
		options: [
			{ value: "5s", label: "5 seconds" },
			{ value: "10s", label: "10 seconds" },
			{ value: "30s", label: "30 seconds" },
			{ value: "1m", label: "1 minute" },
			{ value: "5m", label: "5 minutes" },
			{ value: "smart", label: "Smart", description: "Default — adaptive 5s→5m, resets when you stop polling" },
		],
	},
});
