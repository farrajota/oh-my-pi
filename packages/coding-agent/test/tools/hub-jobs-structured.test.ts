import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

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

describe("hub direct-session job isolation", () => {
	test("direct sessions cannot inspect or consume settled job results", async () => {
		const manager = new AsyncJobManager({});
		const jobId = manager.register("bash", "private", async () => "private result");
		await manager.getJob(jobId)?.promise;
		const tool = new HubTool(makeDirectSession(manager));
		const result = await tool.execute("direct-jobs", { op: "jobs" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("unavailable");
		expect(manager.isJobResultConsumed(jobId)).toBe(false);
	});

	test("direct sessions cannot cancel another owner's job by forged id", async () => {
		const manager = new AsyncJobManager({});
		const jobId = manager.register("bash", "private", async () => new Promise<string>(() => {}), {
			ownerId: "Other",
		});
		const tool = new HubTool(makeDirectSession(manager));
		const result = await tool.execute("direct-cancel", { op: "cancel", ids: [jobId] });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("unavailable");
		expect(manager.getJob(jobId)?.status).toBe("running");
	});
});
