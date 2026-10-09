/** Regression tests for the fresh child-session option boundary.
 * Parent-discovered rules, extensions, and custom tools must be forwarded so
 * child sessions avoid repeating the parent's filesystem scans.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { LoadExtensionsResult, PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import { installSessionOperationLedger } from "@oh-my-pi/pi-coding-agent/registry/operation-lease";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, EffectivePermissionSummary } from "@oh-my-pi/pi-coding-agent/task/types";
import { resolveTaskEffortLevel } from "@oh-my-pi/pi-tui/thinking";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";
import { manyToolName } from "../fixtures/many-tools-mcp";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

import { cfgTierAnthropic, cfgTierGoogle, cfgTierOpenai } from "@oh-my-pi/pi-coding-agent/session/settings";

function createMockSession(
	onPrompt: (params: { text: string; emit: (event: AgentSessionEvent) => void }) => void | Promise<void>,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let workPoolYieldItems: Parameters<AgentSession["setWorkPoolYieldItems"]>[0] = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const sessionManager = SessionManager.inMemory("/tmp");
	installSessionOperationLedger(sessionManager);
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: {
			state: {
				systemPrompt: ["test"],
				tools: [{ name: "read" }, { name: "yield" }],
			},
		},
		model: undefined,
		extensionRunner: undefined,
		sessionManager,
		getActiveToolNames: () => ["read", "yield"],
		getPermissionSummary: () => undefined,
		getEnabledToolNames: () => ["read", "yield"],
		getWorkPoolYieldItems: () => workPoolYieldItems,
		setWorkPoolYieldItems: async (items: Parameters<AgentSession["setWorkPoolYieldItems"]>[0]) => {
			workPoolYieldItems = [...items];
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, _options?: PromptOptions) => {
			await onPrompt({ text, emit });
			return true;
		},
	};
	return session as unknown as AgentSession;
}

function emitYield(emit: (event: AgentSessionEvent) => void): void {
	emit({
		type: "tool_execution_end",
		toolCallId: "tool-pass-through",
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	});
}

function yieldEmittingSession(observePrompt?: (text: string) => void): AgentSession {
	return createMockSession(({ text, emit }) => {
		observePrompt?.(text);
		emitYield(emit);
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};
let registry: AgentRegistry;
let tempDir: TempDir;
const authorityRoots: AgentSession[] = [];
let createAuthoritySession: (
	options: CreateAgentSessionOptions & { agentId: string },
) => Promise<CreateAgentSessionResult>;

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	parentAgentId: "Main",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
	get createAuthoritySession() {
		return createAuthoritySession;
	},
	get agentRegistry() {
		return registry;
	},
};

function createModelRegistry(
	models: Model | Model[],
	getApiKey: (model: Model) => Promise<string | undefined> = async () => "test-key",
): ModelRegistry {
	const available = Array.isArray(models) ? models : [models];
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => available,
		getApiKey,
	} as unknown as ModelRegistry;
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-pass-through-");
	const rootSessionFile = tempDir.join("main.jsonl");
	await Bun.write(rootSessionFile, "");
	registry = new AgentRegistry({ durableState: registryDurableStateForSession(rootSessionFile) });
	const root = await createAgentRootSession(registry, { agentId: "Main" });
	authorityRoots.push(root.session);
	const authority = bindInternalAgentAuthoritySession(registry, root.session);
	if (!authority) throw new Error("Test fixture requires parent authority");
	createAuthoritySession = authority.create;
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of authorityRoots.splice(0)) await root.dispose();
	tempDir[Symbol.dispose]();
});
describe("runSubprocess fresh child-session boundary", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates the actual first child session and prompt from only approved explicit channels", async () => {
		let firstPrompt = "";
		const session = yieldEmittingSession(text => {
			firstPrompt = text;
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const extensionRoots = {
			explicit: ["/abs/parent/explicit-extension"],
			mode: "explicit-only" as const,
			configured: ["/abs/parent/configured-extension"],
			configuredLevel: "project" as const,
		};
		const customTools = [{ name: "explicit-tool", label: "explicit" }] as unknown as CustomTool[];
		const subagentEventBus = new EventBus();
		const getApiKey = async () => "child-account-key";
		const mcpManager = { getTools: () => [], addToolsChangedListener: () => () => {} } as never;

		const result = await runSubprocess({
			...baseOptions,
			context: "EXPLICIT_CONTEXT_SENTINEL",
			extensionRoots,
			customTools,
			subagentEventBus,
			additionalDirectories: ["/abs/shared-worktree"],
			getApiKey,
			enableMCP: true,
			mcpManager,
		});
		expect(result.exitCode).toBe(0);
		expect(firstPrompt).toBe("do work");
		const created = spy.mock.calls[0]?.[0];
		const frozenRoots = created?.extensionRoots?.();
		extensionRoots.explicit.push("/late/parent-extension");
		extensionRoots.configured.push("/late/parent-configured-extension");
		expect(frozenRoots).toEqual({
			explicit: ["/abs/parent/explicit-extension"],
			mode: "explicit-only",
			configured: ["/abs/parent/configured-extension"],
			configuredLevel: "project",
		});
		expect(Object.isFrozen(frozenRoots)).toBe(true);
		expect(Object.isFrozen(frozenRoots?.explicit)).toBe(true);
		expect(created?.customTools).toEqual(customTools);
		expect(created?.subagentEventBus).toBe(subagentEventBus);
		if (typeof created?.systemPrompt !== "function") throw new Error("Expected child-owned system prompt callback");
		const renderedSystemPrompt = created.systemPrompt(["SDK_BASE", "SDK_TAIL"]);
		const systemPrompt =
			typeof renderedSystemPrompt === "string" ? renderedSystemPrompt : renderedSystemPrompt.join("\n");
		expect(systemPrompt).toContain("EXPLICIT_CONTEXT_SENTINEL");
		expect(created?.additionalDirectories).toEqual(["/abs/shared-worktree"]);
		expect(created?.getApiKey).toBe(getApiKey);
		expect(created?.enableMCP).toBe(true);
		expect(created?.mcpManager).toBe(mcpManager);
		expect(systemPrompt).toContain(baseAgent.systemPrompt);
		expect(created?.eventBus).toBeUndefined();
		expect(created?.contextFiles).toBeUndefined();
		expect(created?.skills).toBeUndefined();
		expect(created?.promptTemplates).toBeUndefined();
		expect(created?.workspaceTree).toBeUndefined();
		expect(created?.rules).toBeUndefined();
		expect(created?.preloadedExtensionPaths).toBeUndefined();
		expect(created?.preloadedPreparedExtensions).toBeUndefined();
		expect(created?.preloadedCustomToolPaths).toBeUndefined();
		expect(created?.parentHindsightSessionState).toBeUndefined();
		expect(created?.parentMnemopiSessionState).toBeUndefined();
	});

	it("forwards an exact credential resolver without replacing it", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const getApiKey = async () => "exact-account-key";

		const result = await runSubprocess({ ...baseOptions, getApiKey });

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.getApiKey).toBe(getApiKey);
	});
	it("preserves empty and absent agent tool declarations through session creation", async () => {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockImplementation(async () => createSessionResult(yieldEmittingSession()));
		const emptyFields = parseAgentFields({ name: "quiet", description: "desc", tools: [] });
		const absentFields = parseAgentFields({ name: "default", description: "desc" });
		if (!emptyFields || !absentFields) throw new Error("agent fields did not parse");

		const emptyResult = await runSubprocess({
			...baseOptions,
			id: "empty-tools-child",
			restrictToolNames: true,
			agent: { ...baseAgent, ...emptyFields },
		});
		const absentResult = await runSubprocess({
			...baseOptions,
			id: "default-tools-child",
			restrictToolNames: true,
			agent: { ...baseAgent, ...absentFields },
		});

		expect(emptyResult.exitCode).toBe(0);
		expect(absentResult.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.toolNames).toEqual(["yield"]);
		expect(spy.mock.calls[1]?.[0]?.toolNames).toBeUndefined();
	});

	it("grants wait only to unrestricted subagents that can start background work, and requires write for peers", async () => {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockImplementation(async () => createSessionResult(yieldEmittingSession()));

		const readOnlyResult = await runSubprocess({
			...baseOptions,
			id: "read-only-child",
			agent: { ...baseAgent, tools: ["read", "grep", "glob"] },
		});
		const writableResult = await runSubprocess({
			...baseOptions,
			id: "writable-child",
			agent: { ...baseAgent, tools: ["read", "write", "bash"] },
		});
		const spawningResult = await runSubprocess({
			...baseOptions,
			id: "spawning-child",
			agent: { ...baseAgent, tools: ["read"], spawns: ["scout"] },
		});
		const restrictedResult = await runSubprocess({
			...baseOptions,
			id: "restricted-child",
			agent: { ...baseAgent, tools: ["read", "bash"] },
			restrictToolNames: true,
		});

		expect(readOnlyResult.exitCode).toBe(0);
		expect(writableResult.exitCode).toBe(0);
		expect(spawningResult.exitCode).toBe(0);
		expect(restrictedResult.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.toolNames).toEqual(["read", "grep", "glob"]);
		expect(spy.mock.calls[1]?.[0]?.toolNames).toEqual(["read", "write", "bash", "wait"]);
		expect(spy.mock.calls[2]?.[0]?.toolNames).toEqual(["read", "task", "wait"]);
		expect(spy.mock.calls[3]?.[0]?.toolNames).toEqual(["read", "bash"]);

		const promptText = (index: number): string => {
			const prompt = spy.mock.calls[index]?.[0]?.systemPrompt;
			const resolved = typeof prompt === "function" ? prompt(["default"]) : prompt;
			return Array.isArray(resolved) ? resolved.join("\n") : (resolved ?? "");
		};
		const readOnlyPrompt = promptText(0);
		const writablePrompt = promptText(1);
		const spawningPrompt = promptText(2);
		expect(readOnlyPrompt.includes("# Peers")).toBe(false);
		expect(writablePrompt.includes("# Peers")).toBe(true);
		expect(spawningPrompt.includes("# Peers")).toBe(false);
	});

	it("records the spawning agent as parentAgentId, distinct from the child's own id and prefix", async () => {
		const root = await createAgentRootSession(registry, { agentId: "SpawnerAgent" });
		authorityRoots.push(root.session);
		const authority = bindInternalAgentAuthoritySession(registry, root.session);
		if (!authority) throw new Error("Test fixture requires SpawnerAgent authority");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "ChildAgent",
			parentAgentId: "SpawnerAgent",
			createAuthoritySession: authority.create,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The registry parent is the spawning agent — never the child itself (the
		// self-parent bug). The child's own id still drives both its agent id and
		// its artifact/output-id prefix; those must not double as the parent link.
		expect(forwarded?.parentAgentId).toBe("SpawnerAgent");
		expect(forwarded?.agentId).toBe("ChildAgent");
		expect(forwarded?.parentTaskPrefix).toBe("ChildAgent");
	});

	it("removes MCP and fresh discovery sources for a restricted child", async () => {
		const session = yieldEmittingSession();
		const persistedInits: Array<{ restrictToolNames?: boolean; tools: string[] }> = [];
		vi.spyOn(session.sessionManager, "appendSessionInit").mockImplementation(init => {
			persistedInits.push(init);
			return "session-init";
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const getTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		const mcpManager = { getTools } as unknown as MCPManager;

		const result = await runSubprocess({
			...baseOptions,
			id: "restricted-child",
			restrictToolNames: true,
			mcpManager,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			outputSchemaMode: "strict",
		});

		expect(result.exitCode).toBe(0);
		const created = spy.mock.calls[0]?.[0];
		expect(created?.restrictToolNames).toBe(true);
		expect(created?.enableMCP).toBe(false);
		expect(created?.mcpManager).toBeUndefined();
		expect(created?.customTools).toBeUndefined();
		expect(created?.mcpTools).toBeUndefined();
		expect(created?.preloadedExtensionPaths).toEqual([]);
		expect(created?.preloadedPreparedExtensions).toEqual([]);
		expect(created?.preloadedCustomToolPaths).toEqual([]);
		expect(getTools).not.toHaveBeenCalled();
		expect(created?.outputSchemaMode).toBe("strict");
		expect(persistedInits).toHaveLength(1);
		expect(persistedInits[0]).toMatchObject({ restrictToolNames: true, tools: ["read", "yield"] });
	});

	it("persists bridge-only tools in the enabled Code Mode set", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getActiveToolNames").mockReturnValue(["eval", "yield"]);
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["eval", "read", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "code-mode-child" });

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["eval", "read", "yield"] }));
	});

	it("omits transport-only write from the persisted cold-revival contract", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "transport-only-child",
			agent: { ...baseAgent, tools: ["read"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "yield"] }));
	});

	it("persists write when the original subagent contract grants it", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "writable-child",
			agent: { ...baseAgent, tools: ["read", "write"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "write", "yield"] }));
	});

	it("retains inherited MCP proxy tools for normal children", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const mcpManager = {
			getTools: () => [{ name: "mcp__private_read", label: "private/read" }],
			addToolsChangedListener: () => () => {},
		} as unknown as MCPManager;

		const result = await runSubprocess({ ...baseOptions, id: "normal-child", mcpManager });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.enableMCP).toBe(true);
		expect(forwarded?.mcpManager).toBe(mcpManager);
		expect(forwarded?.mcpTools?.map(tool => tool.name)).toEqual(["mcp__private_read"]);
		expect(forwarded?.customTools).toBeUndefined();
	});

	it("preserves the legacy result shape when no output schema is selected", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "legacy-output-child" });

		expect(result.exitCode).toBe(0);
		expect(Object.hasOwn(result, "structuredOutput")).toBe(false);
	});

	it("lets caller effort win over configured task-role and agent thinking", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const expectedEffort = resolveTaskEffortLevel(model, "lo");
		if (!expectedEffort) throw new Error("Expected the bundled model to support task effort");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}:high`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-caller-effort-precedence",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Medium,
			effort: "lo",
		});

		expect(result.exitCode).toBe(0);
		// The task caller's coarse effort still takes priority after TaskTool
		// forwards it, ahead of both the explicit role suffix and agent default.
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(expectedEffort);
	});

	it("caps caller-requested effort at task.maxEffort", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// The ceiling itself rides into the session so retry-fallback recovery
		// can re-clamp to it after model swaps.
		expect(spy.mock.calls[0]?.[0]?.thinkingLevelCeiling).toBe(Effort.Low);
	});

	it("rejects a spawn when task.maxEffort is below the model floor", async () => {
		const baseModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!baseModel) throw new Error("Expected gpt-5.6-sol model to exist");
		const model = {
			...baseModel,
			id: "mock-high-only",
			provider: "mock",
			thinking: { mode: "effort", efforts: [Effort.High] },
		} as Model;
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const spy = vi.spyOn(sdkModule, "createAgentSession");

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling-below-floor",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"mock/mock-high-only has no supported thinking effort at or below task.maxEffort=low",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("preserves the model's full effort range by default", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-default-effort-ceiling",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Max);
	});

	it("resolves an explicit task-role effort suffix over the agent-definition default", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}:high`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-thinking-precedence",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The user's explicit `:high` suffix on the resolved role pattern wins over
		// the agent definition's default level (e.g. task's `auto`).
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("falls back to the agent-definition thinking level without an explicit suffix", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-thinking-default",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("fails an empty exact override before metadata can select a model", async () => {
		const metadataModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!metadataModel) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const spy = vi.spyOn(sdkModule, "createAgentSession");

		const result = await runSubprocess({
			...baseOptions,
			id: "exact-empty-selector",
			modelOverride: ["", "   "],
			requestedModel: `${metadataModel.provider}/${metadataModel.id}`,
			exactModelOverride: true,
			modelRegistry: createModelRegistry(metadataModel),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Exact model override is required");
		expect(result.requestedModel).toBe(`${metadataModel.provider}/${metadataModel.id}`);
		expect(spy).not.toHaveBeenCalled();
	});

	it("routes an exact override independently of requested-model audit metadata", async () => {
		const overrideModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!overrideModel) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const metadataModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!metadataModel) throw new Error("Expected gpt-5.6-sol model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const requestedModel = `${metadataModel.provider}/${metadataModel.id}`;

		const result = await runSubprocess({
			...baseOptions,
			id: "exact-mismatched-audit-metadata",
			modelOverride: `${overrideModel.provider}/${overrideModel.id}`,
			requestedModel,
			exactModelOverride: true,
			modelRegistry: createModelRegistry(overrideModel, async model =>
				model.provider === overrideModel.provider && model.id === overrideModel.id ? "test-key" : undefined,
			),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.model).toMatchObject({
			provider: overrideModel.provider,
			id: overrideModel.id,
		});
		expect(result.requestedModel).toBe(requestedModel);
	});

	it("fails an exact unresolved selector instead of using configured fallbacks", async () => {
		const fallback = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!fallback) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${fallback.provider}/${fallback.id}`);
		const spy = vi.spyOn(sdkModule, "createAgentSession");

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "exact-unresolved-selector",
			settings,
			modelRegistry: createModelRegistry(fallback),
			modelOverride: "missing/requested-model",
			requestedModel: `${fallback.provider}/${fallback.id}`,
			exactModelOverride: true,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toLowerCase()).toContain("missing/requested-model");
		expect(result.requestedModel).toBe(`${fallback.provider}/${fallback.id}`);
		expect(spy).not.toHaveBeenCalled();
	});

	it("ranks the agent-definition thinking level above the parent's inherited live effort", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		// An agent that inherits the session model receives the parent's live selector, `:high` included.
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-inherited-live-effort",
			modelOverride: [`${model.provider}/${model.id}:high`],
			modelInheritsLiveThinkingLevel: true,
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(result.resolvedModel).toBe(`${model.provider}/${model.id}:low`);
	});

	it("keeps the agent-definition thinking level when credentials fall back to the parent", async () => {
		const requested = getBundledModel("anthropic", "claude-sonnet-4-5");
		const parentModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!requested || !parentModel) throw new Error("Expected bundled models to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: [`${requested.provider}/${requested.id}`] },
			id: "subagent-auth-fallback-effort",
			parentActiveModelPattern: `${parentModel.provider}/${parentModel.id}:high`,
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry([requested, parentModel], async model =>
				model.provider === parentModel.provider ? "test-key" : undefined,
			),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.model?.provider).toBe(parentModel.provider);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
	});
	it("persists an explicit role from a caller model override", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated({
			modelRoles: { reviewer: `${model.provider}/${model.id}` },
		});
		const session = yieldEmittingSession();
		const initSpy = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-model-override-role",
			modelOverride: "@reviewer",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ modelRole: "reviewer" }));
	});

	it("persists requested and effective permission profile provenance in session init", async () => {
		const session = yieldEmittingSession();
		const initSpy = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const permissionSummary: EffectivePermissionSummary = {
			mode: "enforce",
			profiles: { items: ["read-only", "no-network", "focused-edit"], omittedCount: 0 },
			clauses: { items: [], omittedCount: 0 },
			denyTools: { items: ["browser"], omittedCount: 0 },
			denyPaths: { items: [], omittedCount: 0 },
			guardrails: { noNetwork: true, secretsBlind: false },
			intrinsicTools: { yield: true, reportToolIssue: false },
			recentDenials: { items: [], omittedCount: 0 },
		};
		vi.spyOn(session, "getPermissionSummary").mockReturnValue(permissionSummary);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-permission-provenance",
			requestedPermissionProfiles: ["no-network", "focused-edit"],
			effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
			permissionSummary,
		});

		expect(result.exitCode).toBe(0);
		expect(result.permissionSummary).toEqual(permissionSummary);
		expect(result.output).not.toContain("permissionSummary");
		expect(initSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				requestedPermissionProfiles: ["no-network", "focused-edit"],
				effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
				permissionSummary,
			}),
		);
	});
});

describe("runSubprocess per-agent compaction threshold overrides", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies the override to the named child only, not to agents that child spawns", async () => {
		const createSession = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(yieldEmittingSession()))
			.mockResolvedValueOnce(createSessionResult(yieldEmittingSession()));
		const rootSettings = Settings.isolated({ "compaction.thresholdTokens": 40_000 });

		const child = await runSubprocess({
			...baseOptions,
			id: "compaction-override-child",
			settings: rootSettings,
			compactionThresholdOverride: { thresholdPercent: 80, thresholdTokens: -1 },
		});
		expect(child.exitCode).toBe(0);
		const childSettings = createSession.mock.calls[0]?.[0]?.settings;
		if (!childSettings) throw new Error("Expected child settings");
		const childCompaction = cfgCompaction.get(childSettings);
		expect(resolveThresholdTokens(200_000, childCompaction)).toBe(160_000);
		expect(shouldCompact(50_000, 200_000, childCompaction)).toBe(false);
		expect(shouldCompact(160_001, 200_000, childCompaction)).toBe(true);

		// A grandchild without its own entry is spawned from the child's settings.
		const grandchild = await runSubprocess({
			...baseOptions,
			id: "compaction-override-grandchild",
			settings: childSettings,
		});
		expect(grandchild.exitCode).toBe(0);
		const grandchildSettings = createSession.mock.calls[1]?.[0]?.settings;
		if (!grandchildSettings) throw new Error("Expected grandchild settings");
		const grandchildCompaction = cfgCompaction.get(grandchildSettings);
		expect(resolveThresholdTokens(200_000, grandchildCompaction)).toBe(40_000);
		expect(shouldCompact(50_000, 200_000, grandchildCompaction)).toBe(true);
	});
});

describe("runSubprocess per-agent service-tier overrides", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The child session evaluates the resolver against its final model; the
	// tests evaluate it the same way, with the model dispatch handed over.
	function childTiers(
		sessionOptions: CreateAgentSessionOptions | undefined,
		model: Model | undefined = sessionOptions?.model,
	): ServiceTierByFamily {
		const resolve = sessionOptions?.resolveServiceTierByFamily;
		if (!resolve) throw new Error("Expected createAgentSession to receive a service-tier resolver");
		return resolve(model);
	}

	it("applies the dispatch-resolved override to the effective model selected by task policy", async () => {
		const effectiveModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		const definitionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!effectiveModel || !definitionModel) throw new Error("Expected bundled service-tier models to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${definitionModel.provider}/${definitionModel.id}`] },
			modelOverride: [`${effectiveModel.provider}/${effectiveModel.id}`],
			serviceTierOverride: "scale",
			id: "subagent-agent-service-tier-effective-model",
			settings: Settings.isolated({ "tier.subagent": "priority" }),
			modelRegistry: createModelRegistry(effectiveModel),
		});

		expect(result.exitCode).toBe(0);
		expect(childTiers(spy.mock.calls[0]?.[0])).toEqual({ openai: "scale" });
	});

	it("keeps tier.subagent when dispatch resolved no override for the agent", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${model.provider}/${model.id}`] },
			id: "subagent-agent-service-tier-absent",
			settings: Settings.isolated({ "tier.subagent": "flex" }),
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		const sessionOptions = spy.mock.calls[0]?.[0];
		expect(sessionOptions?.resolveServiceTierByFamily).toBeUndefined();
		expect([
			sessionOptions?.settings ? cfgTierOpenai.get(sessionOptions?.settings) : undefined,
			sessionOptions?.settings ? cfgTierAnthropic.get(sessionOptions?.settings) : undefined,
			sessionOptions?.settings ? cfgTierGoogle.get(sessionOptions?.settings) : undefined,
		]).toEqual(["flex", "none", "flex"]);
	});

	it("drops inherited live tiers a family can't realize instead of failing the spawn", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		// A resumed parent session file can carry a live tier its family never realizes.
		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${model.provider}/${model.id}`] },
			id: "subagent-inherited-unrealizable-tier",
			settings: Settings.isolated({ "tier.subagent": "inherit" }),
			parentServiceTier: { openai: "flex", anthropic: "flex" },
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		const childSettings = spy.mock.calls[0]?.[0]?.settings;
		if (!childSettings) throw new Error("Expected createAgentSession to receive settings");
		expect([
			cfgTierOpenai.get(childSettings),
			cfgTierAnthropic.get(childSettings),
			cfgTierGoogle.get(childSettings),
		]).toEqual(["flex", "none", "none"]);
	});

	it("lets an unsupported concrete override beat the global tier without crossing families", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "reviewer", model: [`${model.provider}/${model.id}`] },
			serviceTierOverride: "scale",
			id: "subagent-agent-service-tier-family-validation",
			settings: Settings.isolated({ "tier.subagent": "priority" }),
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(childTiers(spy.mock.calls[0]?.[0])).toEqual({});
	});

	it("resolves the override against the auth-fallback model rather than the requested one", async () => {
		const requested = getBundledModel("anthropic", "claude-sonnet-4-5");
		const parentModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!requested || !parentModel) throw new Error("Expected bundled service-tier models to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		// The requested Anthropic model has no working credentials; the parent's OpenAI model does.
		const modelRegistry = createModelRegistry([requested, parentModel], async model =>
			model.provider === parentModel.provider ? "test-key" : undefined,
		);

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${requested.provider}/${requested.id}`] },
			parentActiveModelPattern: `${parentModel.provider}/${parentModel.id}`,
			serviceTierOverride: "scale",
			id: "subagent-agent-service-tier-auth-fallback",
			settings: Settings.isolated({ "tier.subagent": "priority" }),
			modelRegistry,
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.model?.provider).toBe(parentModel.provider);
		// `scale` is an OpenAI-only tier: it lands on the fallback family and never on Anthropic.
		expect(childTiers(spy.mock.calls[0]?.[0])).toEqual({ openai: "scale" });
	});

	it("scopes a concrete override to the model the session resolves instead of broadcasting it", async () => {
		const openAIModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!openAIModel || !anthropicModel) throw new Error("Expected bundled service-tier models to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: ["extension/deferred-model"] },
			modelOverride: ["extension/deferred-model"],
			serviceTierOverride: "priority",
			id: "subagent-agent-service-tier-deferred-model",
			settings: Settings.isolated({ "tier.subagent": "none" }),
			modelRegistry: createModelRegistry([]),
		});

		expect(result.exitCode).toBe(0);
		const sessionOptions = spy.mock.calls[0]?.[0];
		expect(sessionOptions?.model).toBeUndefined();
		expect(sessionOptions?.modelPattern).toEqual(["extension/deferred-model"]);
		// Whichever family the session settles on gets the tier — and only that family.
		expect(childTiers(sessionOptions, anthropicModel)).toEqual({ anthropic: "priority" });
		expect(childTiers(sessionOptions, openAIModel)).toEqual({ openai: "priority" });
		expect(childTiers(sessionOptions, undefined)).toEqual({});
	});
});

describe("runSubprocess follows the parent's MCP manager", () => {
	const FIXTURE_PATH = path.join(import.meta.dir, "..", "fixtures", "many-tools-mcp.ts");
	const fixtureConfig = (): MCPStdioServerConfig => ({
		type: "stdio",
		command: process.execPath,
		args: [FIXTURE_PATH],
	});
	const toolOf = (server: string) => `mcp__${server}_${manyToolName(0)}`;
	let workDir: string;
	let manager: MCPManager;

	/**
	 * Connects and awaits the initial tool loads. `connectServers` alone returns after
	 * its startup window (250 ms by default), which a loaded runner outlasts while the
	 * stdio fixture spawns, leaving the server's tools unregistered.
	 */
	const connectReady = async (configs: Record<string, MCPStdioServerConfig>): Promise<void> => {
		await manager.connectServers(configs, {});
		expect(await manager.waitForStartup(0)).toEqual({ connected: Object.keys(configs), pending: [], failed: [] });
	};

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-subagent-mcp-follow-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	/** A live child that records MCP rebinds and the teardowns it registers. */
	function followingChild(onPrompt: (child: { refreshedWith: (names: string[]) => Promise<void> }) => Promise<void>) {
		const refreshed: string[][] = [];
		const disposers: Array<() => void> = [];
		const waiters: Array<{ names: string[]; resolve: () => void }> = [];
		const covers = (tools: string[], names: string[]) => names.every(name => tools.includes(name));
		/** Resolves once a rebind carries every name — awaits the signal, not a guessed delay. */
		const refreshedWith = (names: string[]): Promise<void> => {
			if (covers(refreshed.at(-1) ?? [], names)) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ names, resolve });
			return promise;
		};
		const session = createMockSession(async ({ emit }) => {
			await onPrompt({ refreshedWith });
			emitYield(emit);
		});
		Object.assign(session, {
			refreshMCPTools: async (tools: CustomTool[]) => {
				const names = tools.map(tool => tool.name);
				refreshed.push(names);
				for (const waiter of waiters.splice(0)) {
					if (covers(names, waiter.names)) waiter.resolve();
					else waiters.push(waiter);
				}
			},
			addDisposer: (dispose: () => void) => {
				disposers.push(dispose);
			},
		});
		return { session, refreshed, disposers };
	}

	// A startup wait of 0 makes connectServers wait for every server's tools instead of returning
	// after the default startup window, which a loaded host can exceed before the spawn snapshot.
	it("rebinds a live subagent's MCP tools when the parent adds a server and reloads mid-run", async () => {
		await connectReady({ alpha: fixtureConfig() });
		const child = followingChild(async ({ refreshedWith }) => {
			// `/mcp add bravo` then `/mcp reload` in the parent while the child runs.
			await manager.disconnectAll();
			await manager.connectServers({ alpha: fixtureConfig(), bravo: fixtureConfig() }, {}, undefined, 0);
			await refreshedWith([toolOf("alpha"), toolOf("bravo")]);
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(child.session));

		const result = await runSubprocess({ ...baseOptions, id: "mcp-follow-reload", mcpManager: manager });

		expect(result.exitCode).toBe(0);
		const spawnTools = spy.mock.calls[0]?.[0]?.mcpTools?.map(tool => tool.name) ?? [];
		expect(spawnTools).toContain(toolOf("alpha"));
		expect(spawnTools).not.toContain(toolOf("bravo"));

		// Session teardown releases the subscription: later reloads leave it alone.
		// disconnectAll emits synchronously, and a still-subscribed follower would
		// rebind in the microtask queued before this await resumes.
		for (const dispose of child.disposers) dispose();
		const refreshCount = child.refreshed.length;
		await manager.disconnectAll();
		expect(child.refreshed).toHaveLength(refreshCount);
	}, 20_000);

	it("replays a manager change that lands while the subagent session is still being created", async () => {
		const child = followingChild(async ({ refreshedWith }) => {
			await refreshedWith([toolOf("alpha")]);
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			// The server finishes connecting after proxies were minted but before bind.
			await connectReady({ alpha: fixtureConfig() });
			return createSessionResult(child.session);
		});

		const result = await runSubprocess({ ...baseOptions, id: "mcp-follow-startup", mcpManager: manager });

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.mcpTools).toBeUndefined();
		expect(child.refreshed.at(-1)).toContain(toolOf("alpha"));
	}, 20_000);

	it("never rebinds an MCP proxy over an explicitly supplied same-name child tool", async () => {
		// Kernel-defined (eval) tools reach children through `customTools` and may
		// carry `mcp__…` names; the child's own tool must keep the name on reload.
		const kernelTool: CustomTool = {
			name: toolOf("alpha"),
			label: toolOf("alpha"),
			description: "Kernel-defined tool sharing an MCP tool's minted name.",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "kernel" }] }),
		};
		const siblingProxy = `mcp__alpha_${manyToolName(1)}`;
		await connectReady({ alpha: fixtureConfig() });
		const child = followingChild(async ({ refreshedWith }) => {
			await manager.disconnectAll();
			await manager.connectServers({ alpha: fixtureConfig() }, {}, undefined, 0);
			await refreshedWith([siblingProxy]);
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(child.session));

		const result = await runSubprocess({
			...baseOptions,
			id: "mcp-follow-collision",
			mcpManager: manager,
			customTools: [kernelTool],
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.customTools).toEqual([kernelTool]);
		expect(child.refreshed.at(-1)).not.toContain(toolOf("alpha"));
	}, 20_000);
});
