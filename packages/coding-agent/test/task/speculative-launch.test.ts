/**
 * Contracts: speculative subagent launch for streamed batch `task` calls.
 *
 * 1. The scanner surfaces a `tasks[]` item only once its object closes —
 *    braces/quotes inside strings never close it early.
 * 2. The host only authorizes launches under auto-allow approval with no
 *    extension lifecycle handlers.
 *
 * TaskTool also consumes streamed batch calls through its public speculation
 * stream; integration coverage below verifies a launched child is reused at
 * final dispatch.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSpeculativeToolExecutionConfig } from "@oh-my-pi/pi-coding-agent/speculation/host";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BatchArgsScanner } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";

const toolCall: AgentToolCall = { type: "toolCall", id: "tc-spec", name: "task", arguments: {} };

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(manager?: AsyncJobManager): ToolSession {
	const agentRegistry = new AgentRegistry();
	const operationLedger = new Map();
	const parentId = "parent";
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": manager !== undefined,
			"task.batch": true,
			"task.allowModelOverride": true,
			"tools.approvalMode": "yolo",
			"tools.speculativeExecution.enabled": true,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => parentId,
		agentRegistry,
		createAuthoritySession: () => ({ agentRegistry, operationLedger, parentId }),
		operationLedger,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do the streamed work.",
		assignment: "Do the streamed work.",
		exitCode: 0,
		output: `result for ${id}`,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

afterEach(() => vi.restoreAllMocks());

describe("BatchArgsScanner", () => {
	it("surfaces items only once their object closes, ignoring braces inside strings", () => {
		const raw =
			'{"context":"shared }\\" ctx","tasks":[{"name":"A","task":"use {x} and \\"}\\""},{"name":"B","task":"b"}]}';
		const scanner = new BatchArgsScanner();
		const seen: number[] = [];
		for (let end = 1; end <= raw.length; end++) {
			scanner.feed(raw.slice(0, end));
			seen.push(scanner.items.length);
		}

		expect(scanner.context).toBe('shared }" ctx');
		expect(scanner.items).toEqual([
			{ name: "A", task: 'use {x} and "}"' },
			{ name: "B", task: "b" },
		]);
		// Each item appears exactly at the byte that closes it.
		expect(seen.indexOf(1)).toBe(raw.indexOf('"},{"name":"B"') + 1);
		expect(seen.indexOf(2)).toBe(raw.length - 3);
	});
});

describe("speculative launch authorization", () => {
	it("allows launches only under auto-allow approval without lifecycle handlers", async () => {
		const launch = { tool: { name: "task", approval: "exec" as const }, toolCall, args: { context: "ctx" } };
		const authorize = (approvalMode: string, handlers: boolean) => {
			const settings = Settings.isolated({ "tools.approvalMode": approvalMode });
			const session = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings,
			};
			return createSpeculativeToolExecutionConfig(settings, session, {
				hasHandlers: event => handlers && event === "tool_call",
			}).host?.authorizeLaunch?.(launch);
		};

		expect(await authorize("yolo", false)).toMatchObject({ allowed: true });
		expect(await authorize("yolo", true)).toMatchObject({ allowed: false });
		expect(await authorize("always-ask", false)).toMatchObject({ allowed: false });
	});
});

describe("TaskTool streamed batch speculation", () => {
	it.each([false, true])("reuses the streamed child at final dispatch (async=%s)", async asyncEnabled => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const spawned: string[] = [];
		let resolveSpawned!: (id: string) => void;
		const spawnedOnce = new Promise<string>(resolve => (resolveSpawned = resolve));
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			spawned.push(id);
			resolveSpawned(id);
			return makeResult(id);
		});
		const manager = asyncEnabled ? new AsyncJobManager({ onJobComplete: () => {} }) : undefined;
		try {
			const tool = await TaskTool.create(createSession(manager));
			const stream = tool.speculation.stream;
			if (!stream?.open) throw new Error("TaskTool has no streamed speculation policy");
			const coordinator: SpeculativeOperationSink = {
				maxInFlight: 2,
				async admit() {
					return undefined;
				},
				close() {},
				async authorizeLaunch() {
					return { allowed: true };
				},
			};
			const session = await stream.open({ coordinator, parentToolCallId: "tc-spec-batch" });
			if (!session) throw new Error("TaskTool did not open a streamed speculation session");
			// This isolated session has no configured `task` model role; model selection is not under test.
			const args = {
				context: "Shared streamed context.",
				tasks: [{ name: "StreamedChild", agent: "task", task: "Do the streamed work." }],
			};
			const streamedCall: AgentToolCall = {
				type: "toolCall",
				id: "tc-spec-batch",
				name: "task",
				arguments: {},
			};
			const partialJson =
				'{"context":"Shared streamed context.","tasks":[{"name":"StreamedChild","agent":"task","task":"Do the streamed work."}';
			session.update(streamedCall, partialJson);
			await expect(spawnedOnce).resolves.toBe("StreamedChild");
			expect(spawned).toEqual(["StreamedChild"]);

			session.update(streamedCall, "]}");
			await session.finalize({ args, toolCall: { ...streamedCall, arguments: args } });

			const result = await tool.execute("tc-spec-batch", args as TaskParams);
			if (manager) {
				const jobId = result.details?.async?.jobId;
				expect(jobId).toBeTruthy();
				const job = manager.getJob(jobId!);
				await job?.promise;
				expect(job?.resultText).toContain("result for StreamedChild");
			} else {
				expect(result.content?.find(part => part.type === "text")?.text).toContain("result for StreamedChild");
			}
			expect(spawned).toEqual(["StreamedChild"]);
		} finally {
			await manager?.dispose({ timeoutMs: 1000 });
		}
	});
});
