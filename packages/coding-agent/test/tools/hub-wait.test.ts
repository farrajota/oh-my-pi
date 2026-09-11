import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

function makeDirectSession(): ToolSession {
	const registry = new AgentRegistry();
	registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
	registry.register({ id: "Peer", displayName: "peer", kind: "sub", session: null, status: "idle" });
	return {
		cwd: process.cwd(),
		settings: { get: () => undefined },
		agentRegistry: registry,
		asyncJobManager: new AsyncJobManager({}),
		getAgentId: () => "Main",
		isDisposed: () => false,
	} as unknown as ToolSession;
}

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("hub unified wait authority isolation", () => {
	test("direct sessions cannot wait on peer messages or caller-owned jobs", async () => {
		const tool = new HubTool(makeDirectSession());
		const result = await tool.execute("direct-wait", { op: "wait", timeoutMs: 1 });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("unavailable");
	});
});
