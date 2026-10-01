import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { createHubAuthorityFixture, type HubAuthorityFixture } from "./hub-fixtures";

const SELF_ID = "Main";
let authorityFixture: HubAuthorityFixture;
const managers: AsyncJobManager[] = [];

function makeManager(): AsyncJobManager {
	const manager = new AsyncJobManager({});
	managers.push(manager);
	return manager;
}

function makeDirectSession(manager: AsyncJobManager): ToolSession {
	const registry = new AgentRegistry();
	registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null, status: "running" });
	return {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "launch.enabled") return false;
				return undefined;
			},
		},
		agentRegistry: registry,
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
		isDisposed: () => false,
	} as unknown as ToolSession;
}

function makeSession(manager: AsyncJobManager): ToolSession {
	const session = authorityFixture.createToolSession(SELF_ID) as ToolSession & {
		asyncJobManager?: AsyncJobManager;
	};
	session.asyncJobManager = manager;
	return session;
}

function registerSettledJob(
	manager: AsyncJobManager,
	agentId: string,
	text: string,
	structured: StructuredSubagentOutput,
	jobId = agentId,
): string {
	return manager.register("task", agentId, async () => ({ text, structured }), {
		ownerId: SELF_ID,
		agentId,
		id: jobId,
	});
}

beforeEach(async () => {
	const registry = new AgentRegistry();
	AgentRegistry.installGlobal(registry);
	authorityFixture = await createHubAuthorityFixture(registry, SELF_ID);
});

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 500 });
	await authorityFixture.dispose();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("hub structured wait results", () => {
	test("direct sessions cannot inspect or consume settled job results", async () => {
		const manager = makeManager();
		const jobId = manager.register("bash", "private", async () => "private result");
		await manager.getJob(jobId)?.promise;
		const tool = new HubTool(makeDirectSession(manager));
		const result = await tool.execute("direct-jobs", { op: "jobs" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.isError).toBe(true);
		expect(text).toContain("unavailable");
		expect(manager.isJobResultConsumed(jobId)).toBe(false);
	});

	test("direct sessions cannot cancel another owner's job by forged id", async () => {
		const manager = makeManager();
		const jobId = manager.register(
			"bash",
			"private",
			async ({ signal }) =>
				new Promise<string>(resolve => {
					signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
				}),
			{ ownerId: "Other" },
		);
		const tool = new HubTool(makeDirectSession(manager));
		const result = await tool.execute("direct-cancel", { op: "cancel", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.isError).toBe(true);
		expect(text).toContain("unavailable");
		expect(manager.getJob(jobId)?.status).toBe("running");
	});

	test("a schema-valid result advertises the agent:// pointer instead of inlining JSON", async () => {
		const manager = makeManager();
		const jobId = registerSettledJob(manager, "ValidJob", "<task-result>done</task-result>", {
			source: "agent",
			mode: "permissive",
			status: "valid",
			data: { ok: true, count: 7 },
		});
		await manager.getJob(jobId)!.promise;

		const result = await new HubTool(makeSession(manager)).execute("valid-wait", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema valid");
		expect(text).toContain("full payload at agent://ValidJob");
		expect(text).toContain("fields via agent://ValidJob/<field>");
		expect(text).not.toContain("```json");
		expect(manager.isJobResultConsumed(jobId)).toBe(true);
	});

	test("a schema-invalid result keeps the truncated JSON preview alongside the pointer", async () => {
		const manager = makeManager();
		const jobId = registerSettledJob(manager, "InvalidJob", "<task-result>done</task-result>", {
			source: "agent",
			mode: "permissive",
			status: "invalid",
			data: { wrong: "shape" },
			error: "missing field",
		});
		await manager.getJob(jobId)!.promise;

		const result = await new HubTool(makeSession(manager)).execute("invalid-wait", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema invalid: missing field");
		expect(text).toContain("full payload at agent://InvalidJob");
		expect(text).toContain("```json");
		expect(text).toContain('"wrong": "shape"');
		expect(manager.isJobResultConsumed(jobId)).toBe(true);
	});

	test("a run that failed before yielding reports the provider error, not a schema verdict", async () => {
		const manager = makeManager();
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		const jobId = registerSettledJob(
			manager,
			"DeadStream",
			'<task-result status="failed (exit 1)">partial</task-result>',
			{ source: "agent", mode: "permissive", status: "unavailable", error },
		);
		await manager.getJob(jobId)!.promise;

		const result = await new HubTool(makeSession(manager)).execute("unavailable-wait", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`Structured output: unavailable: ${error}`);
		expect(text).not.toContain("schema invalid");
		expect(text).not.toContain("schema unavailable");
		expect(text).not.toContain("full payload at");
		expect(text).not.toContain("```json");
		expect(manager.isJobResultConsumed(jobId)).toBe(true);
	});

	test("advertises the disambiguated agentId, not the collision-suffixed job id", async () => {
		const manager = makeManager();
		const firstJobId = manager.register(
			"task",
			"collider",
			async ({ signal }) =>
				new Promise<string>(resolve => {
					signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
				}),
			{ ownerId: SELF_ID, id: "Foo" },
		);
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

		const result = await tool.execute("collision-wait", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("full payload at agent://Foo,");

		const summary = await tool.execute("summary", { op: "jobs" });
		const summaryText = summary.content[0]?.type === "text" ? summary.content[0].text : "";
		expect(summaryText).toContain(`- \`${jobId}\` [task] — completed — Foo — delivery delivered — agent://Foo`);
		expect(summaryText).not.toContain("<task-result>done</task-result>");
		if (!summary.details || !("jobs" in summary.details)) throw new Error("Expected job summary details");
		expect(summary.details.jobs?.find(job => job.id === jobId)?.structured).toBeUndefined();
		expect(manager.isJobResultConsumed(jobId)).toBe(true);
		expect(manager.isJobResultConsumed(firstJobId)).toBe(false);
	});
});
