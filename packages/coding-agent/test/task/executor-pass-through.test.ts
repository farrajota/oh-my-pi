/** Regression tests for the fresh child-session option boundary. */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { resolveTaskEffortLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

function createMockSession(
	onPrompt: (params: { text: string; emit: (event: AgentSessionEvent) => void }) => void,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
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
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, _options?: PromptOptions) => {
			onPrompt({ text, emit });
		},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(observePrompt?: (text: string) => void): AgentSession {
	return createMockSession(({ text, emit }) => {
		observePrompt?.(text);
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

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

function createModelRegistry(model: Model, ...additionalModels: Model[]): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => [model, ...additionalModels],
		getApiKey: async () => "test-key",
	} as unknown as ModelRegistry;
}

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
		const mcpManager = { getTools: () => [] } as never;

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
		expect(created?.parentEvalSessionId).toBeUndefined();
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
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
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
		expect(spy.mock.calls[0]?.[0]?.toolNames).toEqual([]);
		expect(spy.mock.calls[1]?.[0]?.toolNames).toBeUndefined();
	});

	it("records the spawning agent as parentAgentId, distinct from the child's own id and prefix", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "ChildAgent",
			parentAgentId: "SpawnerAgent",
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

	it("keeps a restricted child free of MCP capabilities and discovery preloads", async () => {
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
		expect(created?.preloadedExtensionPaths).toEqual([]);
		expect(created?.preloadedPreparedExtensions).toEqual([]);
		expect(created?.preloadedCustomToolPaths).toEqual([]);
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
		} as unknown as MCPManager;

		const result = await runSubprocess({ ...baseOptions, id: "normal-child", mcpManager });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.enableMCP).toBe(true);
		expect(forwarded?.mcpManager).toBe(mcpManager);
		expect(forwarded?.customTools?.map(tool => tool.name)).toEqual(["mcp__private_read"]);
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
			modelRegistry: createModelRegistry(overrideModel, metadataModel),
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

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-permission-provenance",
			requestedPermissionProfiles: ["no-network", "focused-edit"],
			effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
		});

		expect(result.exitCode).toBe(0);
		expect(initSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				requestedPermissionProfiles: ["no-network", "focused-edit"],
				effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
			}),
		);
	});
});
