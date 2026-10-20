/**
 * A background `task` job offers its live widget the subagent's finished tool
 * calls (`tools`), every source of the jobs the subagent started
 * (`<jobId>:<sourceId>`), and a brief read live from progress. Without them the
 * widget author sees nothing to chart while a subagent benchmarks in a
 * background bash job, and the brief misses the agent's own stage and watch hint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TextTap } from "@oh-my-pi/pi-coding-agent/job-widgets/text-tap";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentProgress, SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";

let authorityRoot: AgentSession | undefined;
let directory: TempDir;
let jobManager: AsyncJobManager | undefined;
let finishRun: (() => void) | undefined;

beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	directory = TempDir.createSync("@omp-task-widget-");
	const rootSessionFile = directory.join("main.jsonl");
	await Bun.write(rootSessionFile, "");
	AgentRegistry.installGlobal(new AgentRegistry({ durableState: registryDurableStateForSession(rootSessionFile) }));
	const root = await createAgentRootSession(AgentRegistry.global(), {
		agentId: "Main",
		cwd: directory.path(),
		agentDir: directory.join("agent"),
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
		restrictToolNames: true,
		skipPythonPreflight: true,
	});
	authorityRoot = root.session;
});

afterEach(async () => {
	finishRun?.();
	finishRun = undefined;
	await jobManager?.dispose({ timeoutMs: 1_000 });
	jobManager = undefined;
	await authorityRoot?.dispose();
	authorityRoot = undefined;
	directory.removeSync();
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("task job widget inputs", () => {
	it("exposes the subagent's tool results, its own jobs' sources and a live brief", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "test", systemPrompt: "test", source: "bundled" }],
			projectAgentsDir: null,
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		jobManager = manager;
		const childOut = new TextTap("out", "bench --stream");
		const midRun = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		finishRun = finish.resolve;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const progress: AgentProgress = {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: "bundled",
				status: "running",
				task: options.task,
				assignment: options.assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 2,
				requests: 1,
				tokens: 0,
				cost: 0,
				durationMs: 0,
				completionPercent: 40,
				stage: "benchmarking the decoder",
				watch: "BENCH lines in bench_1 out, tok_s higher is better",
			};
			options.onToolResult?.({ tool: "read", intent: "read the bench script", text: "#!/bin/sh", isError: false });
			options.onToolResult?.({
				tool: "bash",
				text: `${"x".repeat(70 * 1024)}BENCH tok_s=186`,
				isError: false,
			});
			// The subagent's own background job, registered under its id like a bash job would be.
			manager.register(
				"bash",
				"bench",
				async () => {
					await finish.promise;
					return "done";
				},
				{
					id: "bench_1",
					ownerId: options.id,
					widgetInputs: { sources: () => [childOut], brief: () => ({ kind: "bash", command: "bench --stream" }) },
				},
			);
			options.onProgress?.(progress);
			midRun.resolve();
			await finish.promise;
			const result: SingleResult = {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: "bundled",
				task: options.task,
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			};
			return result;
		});
		if (!authorityRoot) throw new Error("Task widget fixture requires a live parent session");
		const authority = bindInternalAgentAuthoritySession(AgentRegistry.global(), authorityRoot);
		if (!authority) throw new Error("Task widget fixture requires parent authority");
		const session = {
			cwd: directory.path(),
			hasUI: false,
			settings: authorityRoot.settings,
			agentRegistry: AgentRegistry.global(),
			createAuthoritySession: authority.create,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getToolCallIntent: (toolCallId: string) => (toolCallId === "tc-bench" ? "benchmark the decoder" : undefined),
			asyncJobManager: manager,
		} as unknown as ToolSession;
		const tool = await TaskTool.create(session);
		const started = await tool.execute("tc-bench", {
			context: "Decoder throughput work.",
			tasks: [{ name: "Bencher", task: "Benchmark the streaming decoder." }],
		} as TaskParams);
		const job = manager.getJob(started.details!.async!.jobId)!;
		await midRun.promise;

		const inputs = job.widgetInputs!;
		const sources = inputs.sources();
		expect(sources.map(source => source.id)).toEqual(["tools", "bench_1:out"]);
		const tools = sources[0]!.read(0);
		expect(tools.open).toBe(true);
		expect(tools.text.startsWith("\n» read read the bench script\n#!/bin/sh\n\n» bash\n")).toBe(true);
		// Each result keeps its newest 64 Ki characters.
		expect(tools.text.endsWith("BENCH tok_s=186\n")).toBe(true);
		expect(tools.text.length).toBe(
			"\n» read read the bench script\n#!/bin/sh\n".length + "\n» bash\n".length + 64 * 1024 + 1,
		);

		childOut.append("BENCH tok_s=190\n");
		expect(sources[1]!.read(0).text).toBe("BENCH tok_s=190\n");
		expect(inputs.brief()).toEqual({
			kind: "task",
			task: "Benchmark the streaming decoder.",
			intent: "benchmark the decoder",
			watch: "BENCH lines in bench_1 out, tok_s higher is better",
			stage: "benchmarking the decoder",
		});

		finish.resolve();
		await job.promise;
		expect(inputs.sources()[0]!.read(0).open).toBe(false);
	});
});
