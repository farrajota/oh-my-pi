import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import type { StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

function makeDirectSession(manager: AsyncJobManager): ToolSession {
	const registry = new AgentRegistry();
	registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
	return {
		cwd: process.cwd(),

		settings: {
			get(key: string): unknown {
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: registry,

		asyncJobManager: manager,
		getAgentId: () => "Main",
		isDisposed: () => false,
	} as unknown as ToolSession;
}

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager): ToolSession {
	const registry = new AgentRegistry();
	registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null, status: "running" });
	return {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: registry,
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
		getSessionFile: () => "structured-job-test",
		getSessionSpawns: () => "*",
		isDisposed: () => false,
	} as unknown as ToolSession;
}

function registerSettledJob(
	manager: AsyncJobManager,
	agentId: string,
	text: string,
	structured: StructuredSubagentOutput,
	jobId = agentId,
): string {
	return manager.register(
		"task",
		agentId,
		async ({ reportProgress }) => {
			await reportProgress(text, { structured });
			return text;
		},
		{ ownerId: SELF_ID, agentId, id: jobId },
	);
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

	test("a schema-valid result advertises the agent:// pointer instead of inlining JSON", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"ValidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true, count: 7 } },
			"ValidJob",
		);
		const tool = new HubTool(makeSession(manager));

		const result = await tool.execute("call_1", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema valid");
		expect(text).toContain("full payload at agent://ValidJob");
		expect(text).toContain("fields via agent://ValidJob/<field>");
		expect(text).not.toContain("```json");
	});

	test("a schema-invalid result keeps the truncated JSON preview alongside the pointer", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"InvalidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "invalid", data: { wrong: "shape" }, error: "missing field" },
			"InvalidJob",
		);
		const tool = new HubTool(makeSession(manager));

		const result = await tool.execute("call_2", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema invalid: missing field");
		expect(text).toContain("full payload at agent://InvalidJob");
		expect(text).toContain("```json");
		expect(text).toContain('"wrong": "shape"');
	});

	test("a run that failed before yielding reports the provider error, not a schema verdict", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		const jobId = registerSettledJob(
			manager,
			"DeadStream",
			'<task-result status="failed (exit 1)">partial</task-result>',
			{ source: "agent", mode: "permissive", status: "unavailable", error },
			"DeadStream",
		);
		const tool = new HubTool(makeSession(manager));

		const result = await tool.execute("call_4", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`Structured output: unavailable: ${error}`);
		expect(text).not.toContain("schema invalid");
		expect(text).not.toContain("schema unavailable");
		expect(text).not.toContain("full payload at");
		expect(text).not.toContain("```json");
	});

	test("advertises the disambiguated agentId, not the collision-suffixed job id", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise: hangs } = Promise.withResolvers<string>();
		manager.register("task", "collider", async () => hangs, { ownerId: SELF_ID, id: "Foo" });
		const jobId = registerSettledJob(
			manager,
			"Foo",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			"Foo",
		);
		expect(jobId).not.toBe("Foo");
		await manager.getJob(jobId)!.promise;
		const tool = new HubTool(makeSession(manager));
		const summary = await tool.execute("summary", { op: "jobs" });
		const summaryText = summary.content[0]?.type === "text" ? summary.content[0].text : "";
		expect(summaryText).toContain(`- \`${jobId}\` [task] — completed — Foo — delivery pending — agent://Foo`);
		expect(summaryText).not.toContain("<task-result>done</task-result>");
		if (!summary.details || !("jobs" in summary.details)) throw new Error("Expected job summary details");
		expect(summary.details.jobs?.find(job => job.id === jobId)?.structured).toBeUndefined();

		const result = await tool.execute("call_3", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`full payload at agent://Foo,`);
	});
});
