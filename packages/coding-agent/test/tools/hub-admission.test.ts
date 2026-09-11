import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { beginHubAdmission } from "../../src/internal/hub-admission";
import { resolveHubSessionAccess } from "../../src/internal/hub-authority";

function makeDirectSession(manager: AsyncJobManager): ToolSession {
	const registry = new AgentRegistry();
	registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
	return {
		cwd: process.cwd(),
		settings: { get: () => undefined },
		agentRegistry: registry,
		asyncJobManager: manager,
		getAgentId: () => "Main",
		isDisposed: () => false,
	} as unknown as ToolSession;
}

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("Hub direct-session authority isolation", () => {
	test("caller-supplied registry and actor id do not create Hub authority", () => {
		const session = makeDirectSession(new AsyncJobManager({}));
		expect(resolveHubSessionAccess(session)).toEqual({ kind: "unavailable" });
	});

	test("forged admission input cannot mint a coordination capability", () => {
		const session = makeDirectSession(new AsyncJobManager({}));
		expect(() => beginHubAdmission({} as never, session, "hub-1", "jobs")).toThrow(
			"Hub admission requires an exact session authority",
		);
	});

	test("direct Hub sessions cannot message or inspect or mutate jobs", async () => {
		const manager = new AsyncJobManager({});
		const session = makeDirectSession(manager);
		const tool = new HubTool(session);
		const operations = [
			{ id: "list", params: { op: "list" as const } },
			{ id: "send", params: { op: "send" as const, to: "Main", message: "forged" } },
			{ id: "broadcast", params: { op: "send" as const, to: "all", message: "forged" } },
			{ id: "inbox", params: { op: "inbox" as const } },
			{ id: "wait", params: { op: "wait" as const, timeoutMs: 1 } },
			{ id: "jobs", params: { op: "jobs" as const } },
			{ id: "cancel", params: { op: "cancel" as const, ids: ["forged-job"] } },
		];

		for (const operation of operations) {
			const result = await tool.execute(operation.id, operation.params);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("unavailable");
		}
		expect(manager.getAllJobs()).toEqual([]);
	});

	test("direct session never consults a process-global bus for peer operations", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({ id: "Peer", displayName: "peer", kind: "sub", session: null, status: "idle" });
		const session = {
			cwd: process.cwd(),
			settings: { get: () => undefined },
			agentRegistry: registry,
			asyncJobManager: new AsyncJobManager({}),
			getAgentId: () => "Main",
			isDisposed: () => false,
		} as unknown as ToolSession;
		const tool = new HubTool(session);
		const result = await tool.execute("forged-list", { op: "list" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("unavailable");
	});
});
