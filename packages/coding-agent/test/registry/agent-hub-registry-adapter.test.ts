import { describe, expect, it } from "bun:test";
import { toAgentHubRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-hub-registry-adapter";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/**
 * `InteractiveMode.syncRunningSubagentBadge()` resubscribes whenever the badge
 * registry it is handed is not the one it already subscribed to. Handing it a
 * freshly allocated adapter on every call defeats that identity check and makes
 * the badge listener unsubscribe and resubscribe on every registry event.
 */
describe("toAgentHubRegistry", () => {
	it("returns the same adapter for the same source registry", () => {
		const registry = new AgentRegistry();

		expect(toAgentHubRegistry(registry)).toBe(toAgentHubRegistry(registry));
	});

	it("gives each source registry its own adapter", () => {
		expect(toAgentHubRegistry(new AgentRegistry())).not.toBe(toAgentHubRegistry(new AgentRegistry()));
	});

	it("reads live registry state through the cached adapter", () => {
		const registry = new AgentRegistry();
		const adapter = toAgentHubRegistry(registry);
		expect(adapter.list()).toHaveLength(0);

		registry.register({ id: "sub-1", displayName: "Sub 1", kind: "sub", parentId: "Main", session: null });

		expect(adapter.list().map(ref => ref.id)).toStrictEqual(["sub-1"]);
		expect(adapter.get("sub-1")?.displayName).toBe("Sub 1");
		expect(adapter.get("missing")).toBeUndefined();
	});

	it("detaches live sessions so hub consumers cannot reach session internals", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "sub-2",
			displayName: "Sub 2",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
		});

		expect(toAgentHubRegistry(registry).get("sub-2")?.session).toBeNull();
	});
});
