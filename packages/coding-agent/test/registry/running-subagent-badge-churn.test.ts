import { describe, expect, it } from "bun:test";
import { toAgentHubRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-hub-registry-adapter";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	getRunningSubagentBadgeAgentIds,
	getRunningSubagentBadgeRegistry,
} from "@oh-my-pi/pi-tui/overlays/running-subagent-badge";

/**
 * The `/quit` hang had a second face: teardown is only one of the registry's
 * dispatch sites, so any in-session event — a subagent registering, or going
 * running to idle — drove the same unbounded listener churn and locked the
 * session up mid-use. These cover the live-session triggers end to end, through
 * the real adapter and the real badge helpers rather than a stand-in listener.
 */

/** Replays `InteractiveMode.syncRunningSubagentBadge`'s subscribe-on-identity-change wiring. */
function createBadgeSync(source: AgentRegistry, budget: number) {
	const state = {
		syncs: 0,
		ids: [] as string[],
		target: undefined as unknown,
		unsubscribe: undefined as (() => void) | undefined,
	};
	const sync = (): void => {
		state.syncs++;
		// Bail out of the resubscribe cycle so a wedged dispatch fails the
		// assertion instead of hanging the suite.
		if (state.syncs > budget) return;
		const registry = getRunningSubagentBadgeRegistry(undefined, toAgentHubRegistry(source));
		if (state.target !== registry) {
			state.unsubscribe?.();
			state.target = registry;
			state.unsubscribe = registry.onChange(() => sync());
		}
		state.ids = getRunningSubagentBadgeAgentIds(registry);
	};
	return { state, sync };
}

describe("running subagent badge over a live registry", () => {
	it("settles after a subagent registers instead of resubscribing forever", () => {
		const registry = new AgentRegistry();
		const badge = createBadgeSync(registry, 50);
		badge.sync();

		registry.register({
			id: "sub-1",
			displayName: "Sub 1",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});

		expect(badge.state.syncs).toBe(2);
		expect(badge.state.ids).toStrictEqual(["sub-1"]);
	});

	it("settles after a running subagent goes idle mid-session", () => {
		const registry = new AgentRegistry();
		const badge = createBadgeSync(registry, 50);
		badge.sync();
		registry.register({
			id: "sub-1",
			displayName: "Sub 1",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		const afterRegister = badge.state.syncs;

		registry.setStatus("sub-1", "idle");

		expect(badge.state.syncs).toBe(afterRegister + 1);
		expect(badge.state.ids).toStrictEqual([]);
	});

	it("settles after a retired subagent is removed", () => {
		const registry = new AgentRegistry();
		const badge = createBadgeSync(registry, 50);
		badge.sync();
		registry.register({
			id: "sub-1",
			displayName: "Sub 1",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		const afterRegister = badge.state.syncs;

		registry.unregister("sub-1");

		expect(badge.state.syncs).toBe(afterRegister + 1);
		expect(badge.state.ids).toStrictEqual([]);
	});
});
