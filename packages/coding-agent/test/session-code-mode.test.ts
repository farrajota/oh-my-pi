import { afterEach, describe, expect, test, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import { cfgEvalJs } from "../src/eval/settings";
import { AgentSession } from "../src/session/agent-session";
import type { ToolNamespacesInfo } from "../src/session/code-mode";
import { buildToolNamespacesInfo, resolveCodeMode } from "../src/session/code-mode";
import { SessionManager } from "../src/session/session-manager";
import { cfgProvidersOpenaiCodexCodeMode } from "../src/session/settings";
import { EVAL_AGENT_BRIDGE_NAME } from "../src/eval/agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME } from "../src/eval/budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME } from "../src/eval/completion-bridge";
import { EVAL_CANCEL_BRIDGE_NAME, EVAL_STATUS_BRIDGE_NAME, EVAL_WAIT_BRIDGE_NAME } from "../src/eval/handle-bridge";
import { generateCodeModeDeclarations } from "@oh-my-pi/pi-tui/tools/eval-format/code-mode-declarations";

const ENABLED = ["eval", "ask", "todo", "yield", "think", "checkpoint", "rewind", "new_context", "read", "bash"];
const KEEP_DIRECT = ["ask", "checkpoint", "eval", "new_context", "rewind", "think", "todo", "yield"];

function model(provider: string, toolMode?: "code_mode_only"): Model {
	return buildModel({
		id: `${provider}-${toolMode ?? "direct"}`,
		name: provider,
		api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		toolMode,
	});
}

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

type RebuildSystemPrompt = (
	toolNames: string[],
	tools: Map<string, AgentTool>,
	options?: { directToolNames?: readonly string[] },
) => Promise<{ systemPrompt: string[] }>;

describe("resolveCodeMode", () => {
	test("off remains inactive regardless of catalog flag", () => {
		const result = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "off",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(result.active).toBe(false);
		expect(result.directToolNames).toEqual(new Set(ENABLED));
	});

	test("auto applies the exact keep-set only for code_mode_only models", () => {
		const result = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(result.active).toBe(true);
		expect([...result.directToolNames].sort()).toEqual(KEEP_DIRECT);
	});

	test("auto stays inactive without the catalog flag", () => {
		const result = resolveCodeMode({
			provider: "openai-codex",
			setting: "auto",
			enabledToolNames: ENABLED,
			evalTransportAvailable: true,
		});
		expect(result.active).toBe(false);
	});

	test("on activates without a catalog flag, but not outside Codex", () => {
		expect(
			resolveCodeMode({
				provider: "openai-codex",
				setting: "on",
				enabledToolNames: ENABLED,
				evalTransportAvailable: true,
			}).active,
		).toBe(true);
		expect(
			resolveCodeMode({
				provider: "anthropic",
				setting: "on",
				enabledToolNames: ENABLED,
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
	});

	test("fails closed without enabled eval or its transport capability", () => {
		expect(
			resolveCodeMode({
				provider: "openai-codex",
				setting: "on",
				enabledToolNames: ["read"],
				evalTransportAvailable: true,
			}).active,
		).toBe(false);
		expect(
			resolveCodeMode({
				provider: "openai-codex",
				setting: "on",
				enabledToolNames: ["eval", "read"],
				evalTransportAvailable: false,
			}).active,
		).toBe(false);
	});

	test("extra direct tools are intersected with enabled tools", () => {
		const result = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			extraDirectTools: ["read", "missing"],
			enabledToolNames: ["eval", "read", "toString", "__proto__"],
			evalTransportAvailable: true,
		});
		expect([...result.directToolNames]).toEqual(["eval", "read"]);
	});

	test("prototype-named tools are not implicit keep-set members", () => {
		const result = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ["eval", "toString", "__proto__"],
			evalTransportAvailable: true,
		});
		expect([...result.directToolNames]).toEqual(["eval"]);
	});

	test("explicit prototype-named extra tools remain direct", () => {
		const result = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			extraDirectTools: ["toString", "__proto__"],
			enabledToolNames: ["eval", "toString", "__proto__"],
			evalTransportAvailable: true,
		});
		expect([...result.directToolNames]).toEqual(["eval", "toString", "__proto__"]);
	});
	test("reserved eval bridge names stay direct", () => {
		const reserved = [
			EVAL_AGENT_BRIDGE_NAME,
			EVAL_BUDGET_BRIDGE_NAME,
			EVAL_COMPLETION_BRIDGE_NAME,
			EVAL_WAIT_BRIDGE_NAME,
			EVAL_STATUS_BRIDGE_NAME,
			EVAL_CANCEL_BRIDGE_NAME,
		];
		const result = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ["eval", "read", ...reserved],
			evalTransportAvailable: true,
		});
		expect([...result.directToolNames]).toEqual(["eval", ...reserved]);
	});
});

describe("buildToolNamespacesInfo", () => {
	test("preserves the complete wire shape, bridge names, source, and deferred status", () => {
		const info = buildToolNamespacesInfo({
			tools: [
				{ name: "eval", loadMode: "essential" },
				{ name: "read", loadMode: "essential" },
				{ name: "browser", loadMode: "discoverable" },
				{ name: "mcp__gmail__search", mcpServerName: "gmail" },
			],
			directToolNames: new Set(["eval"]),
		});
		expect(info.functions.name).toBe("functions");
		expect(info.functions.functions.eval).toEqual({
			name: "eval",
			direct: true,
			code_mode_name: "eval",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.read).toEqual({
			name: "read",
			direct: false,
			code_mode_name: "read",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.browser.deferred).toBe(true);
		expect(info.functions.functions.mcp__gmail__search.source).toEqual({ kind: "mcp", server_name: "gmail" });
	});

	test("maps directly exposed tools to their wire names", () => {
		const info = buildToolNamespacesInfo({
			tools: [{ name: "edit", customWireName: "apply_patch" }],
			directToolNames: new Set(["edit"]),
		});
		expect(info.functions.functions.apply_patch).toEqual({
			name: "apply_patch",
			direct: true,
			code_mode_name: "edit",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.edit).toBeUndefined();
	});

	test("a direct wire alias beats a bridged exact-name collision in either order", () => {
		const tools = [{ name: "edit", customWireName: "apply_patch" }, { name: "apply_patch" }];
		const direct = new Set(["edit"]);
		for (const ordered of [tools, [...tools].reverse()]) {
			expect(
				buildToolNamespacesInfo({ tools: ordered, directToolNames: direct }).functions.functions.apply_patch,
			).toEqual({
				name: "apply_patch",
				direct: true,
				code_mode_name: "edit",
				deferred: false,
				source: { kind: "harness" },
			});
		}
	});

	test("an exact direct name wins over a colliding direct alias", () => {
		const tools = [{ name: "edit", customWireName: "apply_patch" }, { name: "apply_patch" }];
		const direct = new Set(["edit", "apply_patch"]);
		for (const ordered of [tools, [...tools].reverse()]) {
			const info = buildToolNamespacesInfo({ tools: ordered, directToolNames: direct });
			expect(info.functions.functions.apply_patch?.code_mode_name).toBe("apply_patch");
		}
	});

	test("a wire-name loser remains reachable through its real bridge name", () => {
		const info = buildToolNamespacesInfo({
			tools: [{ name: "edit", customWireName: "apply_patch" }, { name: "apply_patch" }],
			directToolNames: new Set(["edit"]),
		});
		expect(Object.keys(info.functions.functions)).toEqual(["apply_patch"]);
		const declarations = generateCodeModeDeclarations([{ name: "apply_patch", parameters: undefined }]);
		expect(declarations).toContain("apply_patch(args: unknown): Promise<unknown>;");
	});

	test("prototype-named tools become own entries", () => {
		const info = buildToolNamespacesInfo({
			tools: [{ name: "toString" }, { name: "__proto__" }],
			directToolNames: new Set<string>(),
		});
		const wire = new Map<string, { code_mode_name: string }>(
			Object.entries(JSON.parse(JSON.stringify(info)).functions.functions),
		);
		expect([...wire.keys()].sort()).toEqual(["__proto__", "toString"]);
		expect(wire.get("toString")?.code_mode_name).toBe("toString");
		expect(wire.get("__proto__")?.code_mode_name).toBe("__proto__");
	});
});

describe("Code Mode session reconciliation", () => {
	const sessions: AgentSession[] = [];
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function createSession(
		settings: Settings,
		extraTools: AgentTool[] = [],
		evalCapability = true,
		options: {
			evalTool?: AgentTool;
			rebuildSystemPrompt?: RebuildSystemPrompt;
			setActiveToolNames?: (names: Iterable<string>) => void;
		} = {},
	) {
		const codeModel = model("openai-codex", "code_mode_only");
		const directModel = model("openai");
		const evalTool =
			options.evalTool ??
			({ ...tool("eval"), supportsCodeModeTransport: () => evalCapability && cfgEvalJs.get(settings) } as AgentTool);
		const tools = [evalTool, tool("read"), ...extraTools];
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: codeModel, systemPrompt: [], tools } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: {
				getApiKey: async () => "test-key",
				hasConfiguredAuth: () => true,
				refreshSelectedModelMetadata: async (value: Model) => value,
				clearSuppressedSelector: () => undefined,
			} as never,
			toolRegistry: new Map(tools.map(value => [value.name, value])),
			builtInToolNames: tools.map(value => value.name),
			rebuildSystemPrompt: options.rebuildSystemPrompt,
			setActiveToolNames: options.setActiveToolNames,
		});
		sessions.push(session);
		return { session, directModel, codeModel };
	}

	test("model switches reapply the full enabled set across Code Mode boundaries", async () => {
		const { session, directModel, codeModel } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
		);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);
		expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);
		await session.setModel(directModel);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval", "read"]);
		await session.setModel(codeModel);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);
	});

	test("unavailable Eval transport keeps the entire direct surface", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }), [], false);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.getCodeModeDirectToolNames()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();
	});

	test("runtime setting changes reconcile the visible surface and namespace metadata", async () => {
		const settings = Settings.isolated({ "providers.openai-codex.codeMode": "auto" });
		const { session } = createSession(settings);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.getActiveToolNames()).toEqual(["eval"]);
		expect((session.codeModeNamespacesInfo as ToolNamespacesInfo).functions.functions.read.direct).toBe(false);
		cfgProvidersOpenaiCodexCodeMode.override(settings, "off");
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();
	});

	test("eval JavaScript transport setting disables and re-enables Code Mode", async () => {
		const settings = Settings.isolated({ "providers.openai-codex.codeMode": "auto" });
		cfgEvalJs.set(settings, true);
		const { session } = createSession(settings);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.getActiveToolNames()).toEqual(["eval"]);
		cfgEvalJs.set(settings, false);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();
		cfgEvalJs.set(settings, true);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getActiveToolNames()).toEqual(["eval"]);
		expect((session.codeModeNamespacesInfo as ToolNamespacesInfo).functions.functions.read.direct).toBe(false);
	});

	test("demoted tools remain callable through the permission-gated bridge", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }));
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.getActiveToolNames()).toEqual(["eval"]);
		expect(session.getToolForEvalBridge("read")?.name).toBe("read");
	});
	test("configured extra direct tools remain visible and are marked direct in namespace metadata", async () => {
		const settings = Settings.isolated({
			"providers.openai-codex.codeMode": "auto",
			"providers.openai-codex.codeModeDirectTools": ["bash"],
		});
		const { session } = createSession(settings, [tool("bash")]);
		await session.setActiveToolsByName(["eval", "read", "bash"]);
		expect(session.getActiveToolNames()).toEqual(["eval", "bash"]);
		const info = session.codeModeNamespacesInfo as ToolNamespacesInfo;
		expect(info.functions.functions.bash.direct).toBe(true);
		expect(info.functions.functions.read.direct).toBe(false);
	});

	test("wire-name changes refresh the namespace snapshot on model reconciliation", async () => {
		let wireName: string | undefined = "apply_patch";
		const edit = {
			...tool("edit"),
			get customWireName() {
				return wireName;
			},
		};
		const settings = Settings.isolated({
			"providers.openai-codex.codeMode": "auto",
			"providers.openai-codex.codeModeDirectTools": ["edit"],
		});
		const { session, codeModel } = createSession(settings, [edit]);
		await session.setActiveToolsByName(["eval", "edit"]);
		expect((session.codeModeNamespacesInfo as ToolNamespacesInfo).functions.functions.apply_patch).toBeDefined();
		wireName = undefined;
		await session.setModel({ ...codeModel, id: `${codeModel.id}-next` });
		const info = session.codeModeNamespacesInfo as ToolNamespacesInfo;
		expect(info.functions.functions.edit).toBeDefined();
		expect(info.functions.functions.apply_patch).toBeUndefined();
	});
	test("prompt rebuilds receive the direct keep-set for the tool inventory", async () => {
		const directCalls: Array<readonly string[] | undefined> = [];
		const { session, directModel } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
			[],
			true,
			{
				rebuildSystemPrompt: async (names, _tools, options) => {
					directCalls.push(options?.directToolNames);
					return { systemPrompt: [`tools:${names.join(",")}`] };
				},
			},
		);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(directCalls.at(-1)).toEqual(["eval"]);
		await session.setModel(directModel);
		expect(directCalls.at(-1)).toBeUndefined();
	});

	test("a caller slate without eval keeps Code Mode inactive", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }));
		await session.setActiveToolsByName(["read"]);
		expect(session.getEnabledToolNames()).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();
	});

	test("reapplying an unchanged direct roster retains the existing tools array", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "off" }));
		const startupTools = session.agent.state.tools;
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.agent.state.tools).toBe(startupTools);
	});

	test("startup reconcile survives a transiently narrow live tool set", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }));
		session.agent.setTools([]);
		await session.initializeCodeMode();
		expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);
		expect(session.getActiveToolNames()).toEqual(["eval"]);
	});

	test("an eval replacement without the transport capability keeps the direct surface", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }), [], true, {
			evalTool: tool("eval"),
		});
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
		expect(session.codeModeNamespacesInfo).toBeUndefined();
	});

	test("Vibe teardown preserves bridge-enabled Code Mode tools", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }));
		await session.setActiveToolsByName(["eval", "read"]);
		await session.removeVibeToolsPreservingActive();
		expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);
		expect(session.getToolForEvalBridge("read")?.name).toBe("read");
	});

	test("bridge-enabled task retains eager delegation", async () => {
		const settings = Settings.isolated({
			"providers.openai-codex.codeMode": "auto",
			"task.eager": "always",
			"todo.enabled": false,
		});
		const { session } = createSession(settings, [tool("task")]);
		await session.setActiveToolsByName(["eval", "task"]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("implement the parser");
		const messages = promptSpy.mock.calls[0]?.[0] as unknown as Array<{ customType?: string }>;
		expect(session.getActiveToolNames()).toEqual(["eval"]);
		expect(messages.some(message => message.customType === "eager-task-prelude")).toBe(true);
	});

	test("bridge-enabled task retains orchestration notices", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }), [
			tool("task"),
		]);
		await session.setActiveToolsByName(["eval", "task"]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please orchestrate and workflowz this");
		const messages = promptSpy.mock.calls[0]?.[0] as unknown as Array<{ customType?: string }>;
		expect(messages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	test("prompt refresh preserves the full Code Mode tool predicate", async () => {
		const predicateUpdates: string[][] = [];
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }), [], true, {
			setActiveToolNames: names => predicateUpdates.push([...names]),
		});
		await session.setActiveToolsByName(["eval", "read"]);
		expect(predicateUpdates.at(-1)).toEqual(["eval", "read"]);
		await session.refreshBaseSystemPrompt();
		expect(predicateUpdates.at(-1)).toEqual(["eval", "read"]);
	});

	test("failed tool application leaves Code Mode namespace metadata unchanged", async () => {
		const { session } = createSession(Settings.isolated({ "providers.openai-codex.codeMode": "auto" }), [], true, {
			rebuildSystemPrompt: async () => {
				throw new Error("rebuild failed");
			},
		});
		await expect(session.setActiveToolsByName(["eval", "read"])).rejects.toThrow("rebuild failed");
		expect(session.codeModeNamespacesInfo).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["eval", "read"]);
	});

	test("plan guidance keeps task delegation after Code Mode demotes the tool", async () => {
		async function planPrompt(codeMode: "on" | "off", extraTools: AgentTool[], names: string[]): Promise<string> {
			const { session } = createSession(
				Settings.isolated({ "providers.openai-codex.codeMode": codeMode }),
				extraTools,
			);
			await session.setActiveToolsByName(names);
			session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			await session.sendPlanModeContext();
			const planMessage = session.state.messages.find(
				message => (message as { customType?: string }).customType === "plan-mode-context",
			);
			return String((planMessage as { content?: string })?.content);
		}
		const demoted = await planPrompt("on", [tool("task")], ["eval", "task"]);
		const direct = await planPrompt("off", [tool("task")], ["eval", "task"]);
		const unavailable = await planPrompt("on", [], ["eval"]);
		expect(demoted).toBe(direct);
		expect(demoted).not.toBe(unavailable);
	});
});

describe("Code Mode session startup", () => {
	test("initializeCodeMode publishes the restricted surface before the first turn", async () => {
		const codeModel = model("openai-codex", "code_mode_only");
		const settings = Settings.isolated({ "providers.openai-codex.codeMode": "auto" });
		const evalTool = { ...tool("eval"), supportsCodeModeTransport: () => cfgEvalJs.get(settings) } as AgentTool;
		const tools = [evalTool, tool("read")];
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: codeModel, systemPrompt: [], tools } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: { getApiKey: async () => "test-key", hasConfiguredAuth: () => true } as never,
			toolRegistry: new Map(tools.map(value => [value.name, value])),
			builtInToolNames: tools.map(value => value.name),
		});
		try {
			await session.initializeCodeMode();
			expect(session.getActiveToolNames()).toEqual(["eval"]);
			expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);
			const info = session.codeModeNamespacesInfo as ToolNamespacesInfo;
			expect(info.functions.functions.eval.direct).toBe(true);
			expect(info.functions.functions.read.direct).toBe(false);
		} finally {
			await session.dispose();
		}
	});
});
