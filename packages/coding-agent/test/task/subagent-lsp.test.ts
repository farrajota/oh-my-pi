import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { IsolationHandle, WorktreeBaseline } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/tools/yield";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const TEST_TASK: TaskParams = { agent: "task", name: "CheckLsp", task: "Inspect LSP tools." };

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		...createSessionDefaults(),
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
	} as unknown as AgentSession;
}

function createSession(
	options: {
		isolationEnabled?: boolean;
		parentEnableLsp?: boolean;
		planMode?: PlanModeState;
		sessionFile?: string | null;
		taskEnableLsp?: boolean;
		agentRegistry?: AgentRegistry;
		createAuthoritySession?: ToolSession["createAuthoritySession"];
	} = {},
): ToolSession {
	const modelRegistry = {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;

	return {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: options.parentEnableLsp,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": options.isolationEnabled ?? false,
			...(options.taskEnableLsp !== undefined ? { "task.enableLsp": options.taskEnableLsp } : {}),
		}),
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => "*",
		modelRegistry,
		agentRegistry: options.agentRegistry,
		createAuthoritySession: options.createAuthoritySession,
		getPlanModeState: () => options.planMode,
	} as unknown as ToolSession;
}

function mockAgents(agent: AgentDefinition): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [agent],
		projectAgentsDir: null,
	});
}

function mockCreateAuthoritySession(): {
	agentRegistry: AgentRegistry;
	createAuthoritySession: NonNullable<ToolSession["createAuthoritySession"]>;
	getOptions: () => CreateAgentSessionOptions | undefined;
} {
	let capturedOptions: CreateAgentSessionOptions | undefined;
	const agentRegistry = new AgentRegistry();
	return {
		agentRegistry,
		createAuthoritySession: async options => {
			capturedOptions = options;
			return {
				session: createYieldingSession(),
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		},
		getOptions: () => capturedOptions,
	};
}

function mockIsolation(): void {
	const baseline: WorktreeBaseline = {
		root: {
			repoRoot: "/repo",
			headCommit: "HEAD",
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
	const isolationHandle: IsolationHandle = {
		mergedDir: "/tmp/isolated-subagent",
		backend: worktreeModule.parseIsolationBackend("rcopy")!,
		fellBack: false,
		fallbackReason: null,
	};

	vi.spyOn(worktreeModule, "getRepoRoot").mockResolvedValue("/repo");
	vi.spyOn(worktreeModule, "captureBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue(isolationHandle);
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
}

describe("subagent LSP availability", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables LSP for subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		const creator = mockCreateAuthoritySession();

		const tool = await TaskTool.create(
			createSession({
				agentRegistry: creator.agentRegistry,
				createAuthoritySession: creator.createAuthoritySession,
			}),
		);
		await tool.execute("tool-call", TEST_TASK);

		expect(creator.getOptions()?.enableLsp).toBe(false);
	});

	it("enables subagent LSP when task.enableLsp is set", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const creator = mockCreateAuthoritySession();

		const tool = await TaskTool.create(
			createSession({
				agentRegistry: creator.agentRegistry,
				taskEnableLsp: true,
				createAuthoritySession: creator.createAuthoritySession,
			}),
		);
		await tool.execute("tool-call", TEST_TASK);

		expect(creator.getOptions()?.enableLsp).toBe(true);
		expect(creator.getOptions()?.toolNames).toContain("lsp");
	});

	it("keeps subagent LSP disabled when the parent session disables LSP", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const creator = mockCreateAuthoritySession();

		const tool = await TaskTool.create(
			createSession({
				parentEnableLsp: false,
				taskEnableLsp: true,
				agentRegistry: creator.agentRegistry,
				createAuthoritySession: creator.createAuthoritySession,
			}),
		);
		await tool.execute("tool-call", TEST_TASK);

		expect(creator.getOptions()?.enableLsp).toBe(false);
	});

	it("disables LSP for isolated subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		mockIsolation();
		const creator = mockCreateAuthoritySession();

		const tool = await TaskTool.create(
			createSession({
				agentRegistry: creator.agentRegistry,
				isolationEnabled: true,
				createAuthoritySession: creator.createAuthoritySession,
			}),
		);
		await tool.execute("tool-call", { ...TEST_TASK, isolated: true });

		expect(creator.getOptions()?.cwd).toBe("/tmp/isolated-subagent");
		expect(creator.getOptions()?.enableLsp).toBe(false);
	});

	it("opens isolated persisted subagent sessions with the worktree cwd", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["write"],
		});
		mockIsolation();
		const creator = mockCreateAuthoritySession();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolated-session-cwd-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			const tool = await TaskTool.create(
				createSession({
					isolationEnabled: true,
					sessionFile: parentSessionFile,
					agentRegistry: creator.agentRegistry,
					createAuthoritySession: creator.createAuthoritySession,
				}),
			);
			await tool.execute("tool-call", { ...TEST_TASK, isolated: true });

			const sessionManager = creator.getOptions()?.sessionManager as { getCwd?: () => string } | undefined;
			expect(creator.getOptions()?.cwd).toBe("/tmp/isolated-subagent");
			expect(sessionManager?.getCwd?.()).toBe("/tmp/isolated-subagent");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("clamps plan-mode mixed-capability tools despite ordinary settings", async () => {
		mockAgents({
			name: "task",
			description: "Reviewer-like task agent",
			systemPrompt: "Review with read-only specialty tools.",
			source: "bundled",
			tools: ["bash", "ast_grep", "memory_edit", "retain", "todo"],
		});
		const creator = mockCreateAuthoritySession();
		const planMode = { enabled: true, planFilePath: "local://PLAN.md" };

		const tool = await TaskTool.create(
			createSession({
				agentRegistry: creator.agentRegistry,
				planMode,
				taskEnableLsp: true,
				createAuthoritySession: creator.createAuthoritySession,
			}),
		);
		await tool.execute("tool-call", TEST_TASK);

		const options = creator.getOptions();
		expect(options?.enableLsp).toBe(false);
		expect(options?.enableIrc).toBe(false);
		expect(options?.restrictToolNames).toBe(true);
		expect(options?.toolNames).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(options?.toolNames).not.toContain("lsp");
		expect(options?.toolNames).not.toContain("hub");
		expect(options?.toolNames).not.toContain("bash");
		expect(options?.toolNames).not.toContain("memory_edit");
		expect(options?.toolNames).not.toContain("retain");
		expect(options?.toolNames).not.toContain("todo");
	});
});
