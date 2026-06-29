import { describe, expect, test, vi } from "bun:test";
import { type } from "arktype";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import type { MCPManager } from "../../mcp/manager";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import { createMCPProxyTools, runSubprocess } from "../executor";
import type { AgentDefinition } from "../types";

const emptyParams = type({});

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
		prompt: async () => {},
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

async function runWithAgentTools(agentTools: string[] | undefined): Promise<readonly string[] | undefined> {
	let capturedToolNames: readonly string[] | undefined;
	const createSpy = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedToolNames = options.toolNames;
		return {
			session: fakeSession(),
			sessionManager: {} as SessionManager,
		} as unknown as sdk.CreateAgentSessionResult;
	});

	await runSubprocess({
		cwd: process.cwd(),
		agent: fakeAgent(agentTools),
		task: "Do the task.",
		assignment: "Do the task.",
		index: 0,
		id: "ExecutorTest",
		settings: Settings.isolated({ "task.agentIdleTtlMs": 0 }),
		modelRegistry: fakeModelRegistry(),
	});

	createSpy.mockRestore();
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
	test("forwards explicit empty agent tools to child session creation with IRC coordination only", async () => {
		expect(await runWithAgentTools([])).toEqual(["irc"]);
	});

	test("forwards narrow explicit agent tools without treating them as defaults", async () => {
		expect(await runWithAgentTools(["read"])).toEqual(["read", "irc"]);
	});
});
