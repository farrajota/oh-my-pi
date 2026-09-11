import { describe, expect, test, vi } from "bun:test";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { type } from "arktype";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import type { MCPManager } from "../../mcp/manager";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import { EventBus } from "../../utils/event-bus";
import { AgentRegistry } from "../../registry/agent-registry";
import { createMCPProxyTools, runSubprocess } from "../executor";
import * as taskLabel from "../label";
import type { AgentDefinition } from "../types";

const emptyParams = type({}) as unknown as TSchema;

function fakeMcpTool(name: string): CustomTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: emptyParams,
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

function fakeManager(tools: CustomTool[]): MCPManager {
	return {
		getTools: () => tools,
	} as unknown as MCPManager;
}

function fakeAgent(tools: string[] | undefined): AgentDefinition {
	return {
		name: "test-agent",
		description: "Test agent",
		systemPrompt: "Run tests.",
		source: "project",
		model: [],
		...(tools !== undefined ? { tools } : {}),
	};
}

function fakeSession(): AgentSession {
	return {
		agent: { state: { systemPrompt: ["system"], tools: [] } },
		systemPrompt: ["system"],
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => [],
		setActiveToolsByName: async () => {},
		subscribe: () => () => {},
		setIrcWakeTurnObserver: () => {},
		prompt: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		waitForIdle: async () => {},
		getLastAssistantMessage: () => ({ stopReason: "error", errorMessage: "test stop" }),
		dispose: async () => {},
		isStreaming: false,
		queuedMessageCount: 0,
	} as unknown as AgentSession;
}

function fakeModelRegistry(): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getModels: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;
}

function createAuthorityFixture() {
	const agentRegistry = new AgentRegistry();
	const createAuthoritySession = (options: Parameters<typeof sdk.createAgentSession>[0]) =>
		sdk.createAgentSession({ ...options, agentRegistry });
	return { agentRegistry, createAuthoritySession };
}

async function runWithAgentTools(
	agentTools: string[] | undefined,
	settings = Settings.isolated({ "task.agentIdleTtlMs": 0 }),
): Promise<readonly string[] | undefined> {
	let capturedToolNames: readonly string[] | undefined;
	const createSpy = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedToolNames = options.toolNames;
		return {
			session: fakeSession(),
			sessionManager: {} as SessionManager,
		} as unknown as sdk.CreateAgentSessionResult;
	});

	try {
		const { agentRegistry, createAuthoritySession } = createAuthorityFixture();
		await runSubprocess({
			cwd: process.cwd(),
			agent: fakeAgent(agentTools),
			task: "Do the task.",
			assignment: "Do the task.",
			index: 0,
			id: "ExecutorTest",
			settings,
			modelRegistry: fakeModelRegistry(),
			agentRegistry,
			createAuthoritySession,
		});
	} finally {
		createSpy.mockRestore();
	}
	return capturedToolNames;
}

describe("createMCPProxyTools", () => {
	test("includes all parent MCP proxies when no allowed list is supplied", () => {
		const tools = createMCPProxyTools(fakeManager([fakeMcpTool("mcp__demo__safe"), fakeMcpTool("mcp__demo__other")]));

		expect(tools.map(tool => tool.name)).toEqual(["mcp__demo__safe", "mcp__demo__other"]);
	});

	test("includes no parent MCP proxies for an explicit empty allowed list", () => {
		const tools = createMCPProxyTools(fakeManager([fakeMcpTool("mcp__demo__safe")]), []);

		expect(tools.map(tool => tool.name)).toEqual([]);
	});

	test("includes only explicitly allowed MCP proxies", () => {
		const tools = createMCPProxyTools(
			fakeManager([fakeMcpTool("mcp__demo__safe"), fakeMcpTool("mcp__demo__other")]),
			["read", "mcp__demo__safe"],
		);

		expect(tools.map(tool => tool.name)).toEqual(["mcp__demo__safe"]);
	});
});

describe("runSubprocess explicit agent tools", () => {
	test("forwards explicit empty agent tools with legacy IRC and native Hub coordination", async () => {
		expect(await runWithAgentTools([])).toEqual(["irc", "hub"]);
	});

	test("forwards narrow explicit agent tools without treating them as defaults", async () => {
		expect(await runWithAgentTools(["read"])).toEqual(["read", "irc", "hub"]);
	});
});

describe("runSubprocess subagent event bus propagation", () => {
	test("forwards the lifecycle bus without forwarding a general session bus", async () => {
		const subagentEventBus = new EventBus();
		let capturedOptions: sdk.CreateAgentSessionOptions | undefined;
		const createSpy = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			return {
				session: fakeSession(),
				sessionManager: {} as SessionManager,
			} as unknown as sdk.CreateAgentSessionResult;
		});

		try {
			const { agentRegistry, createAuthoritySession } = createAuthorityFixture();
			await runSubprocess({
				cwd: process.cwd(),
				agent: fakeAgent([]),
				task: "Do the task.",
				assignment: "Do the task.",
				index: 0,
				id: "EventBusExecutorTest",
				settings: Settings.isolated({ "task.agentIdleTtlMs": 0, "task.generateLabels": false }),
				modelRegistry: fakeModelRegistry(),
				subagentEventBus,
				agentRegistry,
				createAuthoritySession,
			});
			expect(capturedOptions?.subagentEventBus).toBe(subagentEventBus);
			expect(Object.hasOwn(capturedOptions ?? {}, "eventBus")).toBe(false);
		} finally {
			createSpy.mockRestore();
		}
	});
});

describe("runSubprocess task label generation", () => {
	test("generates a task label by default when an assignment is supplied", async () => {
		const settings = Settings.isolated({ "task.agentIdleTtlMs": 0 });
		const labelSpy = vi.spyOn(taskLabel, "generateTaskLabel").mockResolvedValue(null);

		try {
			expect(settings.get("task.generateLabels")).toBe(true);
			await runWithAgentTools([], settings);
			expect(labelSpy).toHaveBeenCalledTimes(1);
			expect(labelSpy).toHaveBeenCalledWith(
				"Do the task.",
				expect.anything(),
				settings,
				"ExecutorTest",
				expect.any(AbortSignal),
			);
		} finally {
			labelSpy.mockRestore();
		}
	});

	test("does not create an auxiliary label-model request when the benchmark disables labels", async () => {
		const settings = Settings.isolated({ "task.agentIdleTtlMs": 0, "task.generateLabels": false });
		const labelSpy = vi.spyOn(taskLabel, "generateTaskLabel").mockResolvedValue(null);

		try {
			await runWithAgentTools([], settings);
			expect(labelSpy).not.toHaveBeenCalled();
		} finally {
			labelSpy.mockRestore();
		}
	});
});
