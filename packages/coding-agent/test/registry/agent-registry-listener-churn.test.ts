import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/**
 * Regression guard for the `/quit` hang: `AgentRegistry` dispatch used to walk
 * the live listener `Set`. A listener that unsubscribes and resubscribes while
 * it handles an event (the running-subagents badge does exactly that) appended
 * a fresh entry behind the iterator, which `Set` iteration then visited — an
 * unbounded synchronous loop that pinned a core and starved the event loop, so
 * session teardown never resumed and the process never exited.
 */
describe("AgentRegistry listener dispatch", () => {
	it("delivers an event once to a listener that resubscribes itself during dispatch", () => {
		const registry = new AgentRegistry();
		let deliveries = 0;
		let unsubscribe: (() => void) | undefined;
		const subscribe = (): void => {
			unsubscribe = registry.onChange(() => {
				deliveries++;
				// Bail out of the resubscribe cycle so an unbounded dispatch fails
				// the assertion instead of hanging the suite.
				if (deliveries > 50) return;
				unsubscribe?.();
				subscribe();
			});
		};
		subscribe();

		registry.register({ id: "sub-1", displayName: "Sub 1", kind: "sub", parentId: "Main", session: null });

		expect(deliveries).toBe(1);
	});

	it("skips a listener that another listener unsubscribed during the same dispatch", () => {
		const registry = new AgentRegistry();
		const seen: string[] = [];
		const second: { unsubscribe?: () => void } = {};
		registry.onChange(() => {
			seen.push("first");
			second.unsubscribe?.();
		});
		second.unsubscribe = registry.onChange(() => {
			seen.push("second");
		});

		registry.register({ id: "sub-2", displayName: "Sub 2", kind: "sub", parentId: "Main", session: null });

		expect(seen).toStrictEqual(["first"]);
	});
});
