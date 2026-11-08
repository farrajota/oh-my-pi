/**
 * Spawning a subagent with a permission request: the task tool composes the scope, the executor
 * writes it into the child's settings as a runtime override, and under `enforce` the child starts
 * with only the tools its scope allows and a PERMISSIONS block in its prompt. `suggest` records the
 * scope and restricts nothing; a spawn without a request behaves as upstream.
 *
 * The task-tool cases port the fork's task index permission tests (design 7, step 13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { activePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/guard";
import { cfgTaskPermissionsActiveScope } from "@oh-my-pi/pi-coding-agent/task/permissions/settings";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../../helpers/session-defaults";
import { enforceScope, scopedSettings } from "./scope-fixtures";

const roots: string[] = [];

beforeEach(async () => {
	// An empty agent dir, so a developer's own permissions.json never reaches these spawns.
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spawn-scope-"));
	roots.push(root);
	setAgentDir(path.join(root, "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function makeAgent(tools?: string[]): AgentDefinition {
	return {
		name: "synthetic",
		description: "Synthetic test agent",
		systemPrompt: "Do the work.",
		source: "project",
		...(tools !== undefined ? { tools } : {}),
	};
}

function makeResult(options: executorModule.ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
	};
}

function taskSession(settings: Settings, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "spawn-scope-test",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		...extra,
	} as ToolSession;
}

function taskSettings(mode: "off" | "suggest" | "enforce", overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"async.enabled": false,
		"task.batch": false,
		"task.isolation.enabled": false,
		"task.permissions.mode": mode,
		...overrides,
	});
}

/** Run one task call with the executor stubbed out; returns the options the executor received. */
async function spawnThroughTask(
	session: ToolSession,
	params: Record<string, unknown>,
	agent: AgentDefinition = makeAgent(),
): Promise<{ options: executorModule.ExecutorOptions | undefined; text: string; isError: boolean }> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options));
	const tool = await TaskTool.create(session);
	const result = await tool.execute("tool-call", { agent: agent.name, task: "Do the work.", ...params });
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	return { options: runSpy.mock.calls[0]?.[0], text, isError: result.isError === true };
}

describe("task spawn composes the permission scope", () => {
	it("narrows an edit toolProfile with a read-only profile, without re-adding edit or write", async () => {
		const { options } = await spawnThroughTask(taskSession(taskSettings("enforce")), {
			toolProfile: "edit",
			permissions: { profiles: ["read-only"] },
		});

		const scope = options?.permissionScope;
		expect(scope?.mode).toBe("enforce");
		expect(scope?.tools).toEqual(["read", "grep", "find"]);
		expect(scope?.profiles).toEqual(["read-only"]);
		expect(scope?.restricted).toBe(true);
		expect(scope?.actorId).toBe(options?.id);
		expect(scope?.actorKind).toBe("sub");
		expect(scope?.parentId).toBe("Main");
	});

	it("composes focused-edit, no-network and no-delegation under an edit toolProfile", async () => {
		const { options } = await spawnThroughTask(taskSession(taskSettings("enforce")), {
			toolProfile: "edit",
			permissions: { profiles: ["focused-edit", "no-network", "no-delegation"] },
		});

		const scope = options?.permissionScope;
		expect(scope?.profiles).toEqual(["focused-edit", "no-network", "no-delegation"]);
		expect(scope?.tools).toEqual(["read", "grep", "find", "edit", "write", "ast_grep"]);
		expect(scope?.denyTools).toEqual(expect.arrayContaining(["browser", "web_search", "task"]));
		expect(scope?.guardrails.noNetwork).toBe(true);
		expect(scope?.provenance.profiles.map(identity => [identity.name, identity.source])).toEqual([
			["focused-edit", "built-in"],
			["no-network", "built-in"],
			["no-delegation", "built-in"],
		]);
	});

	it("does not widen toolProfile none", async () => {
		const { options } = await spawnThroughTask(taskSession(taskSettings("enforce")), {
			toolProfile: "none",
			permissions: { profiles: ["focused-edit"] },
		});

		expect(options?.permissionScope?.tools).toEqual([]);
	});

	it("turns a toolProfile alone into the scope's allowlist", async () => {
		const { options } = await spawnThroughTask(taskSession(taskSettings("enforce")), { toolProfile: "inspect" });

		expect(options?.permissionScope?.tools).toEqual(["read", "grep", "find"]);
		expect(options?.permissionScope?.restricted).toBe(true);
	});

	it("forwards the exact requested and inherited profile order under suggest", async () => {
		const parent = enforceScope({ mode: "suggest", actorId: "Main", actorKind: "main", profiles: ["read-only"] });
		delete (parent as { parentId?: string }).parentId;
		const { options } = await spawnThroughTask(
			taskSession(scopedSettings(parent, { "async.enabled": false, "task.permissions.mode": "suggest" })),
			{ permissions: { profiles: ["no-network", "focused-edit"] } },
		);

		expect(options?.permissionScope?.mode).toBe("suggest");
		expect(options?.permissionScope?.profiles).toEqual(["read-only", "no-network", "focused-edit"]);
		expect(options?.permissionScope?.inherited).toBe(true);
	});

	it("leaves a spawn without permissions or toolProfile unscoped under enforce", async () => {
		const { options } = await spawnThroughTask(taskSession(taskSettings("enforce")), {});

		expect(options).toBeDefined();
		expect(options?.permissionScope).toBeUndefined();
	});

	it("fails preflight on an unknown profile before anything runs", async () => {
		const { options, text, isError } = await spawnThroughTask(taskSession(taskSettings("enforce")), {
			permissions: { profiles: ["missing-profile"] },
		});

		expect(isError).toBe(true);
		expect(text).toContain('Unknown permission profile "missing-profile"');
		expect(options).toBeUndefined();
	});

	it("fails preflight on a modifier-only request under enforce", async () => {
		const { options, text, isError } = await spawnThroughTask(taskSession(taskSettings("enforce")), {
			permissions: { profiles: ["no-network"] },
		});

		expect(isError).toBe(true);
		expect(text).toContain("Subagent tool permissions require a concrete allowlist");
		expect(options).toBeUndefined();
	});

	it("fails preflight on a toolProfile while tool permissions are off", async () => {
		const { options, text, isError } = await spawnThroughTask(
			taskSession(taskSettings("enforce", { "task.permissions.tools.enabled": false })),
			{ toolProfile: "inspect" },
		);

		expect(isError).toBe(true);
		expect(text).toContain("Subagent tool permissions are disabled");
		expect(options).toBeUndefined();
	});
});

function yieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-1",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "done" }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
			return true;
		},
	} as unknown as AgentSession;
}

function sessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

/** Run the executor with the child session stubbed out; returns what `createAgentSession` received. */
async function executorSpawn(
	options: Partial<executorModule.ExecutorOptions> & { settings: Settings },
): Promise<CreateAgentSessionOptions> {
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(yieldingSession()));
	const result = await executorModule.runSubprocess({
		cwd: process.cwd(),
		agent: makeAgent(),
		task: "do work",
		index: 0,
		id: "ScopedSpawn",
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		...options,
	});
	expect(result.exitCode).toBe(0);
	const created = spy.mock.calls[0]?.[0];
	if (!created) throw new Error("the executor created no child session");
	return created;
}

function childScope(created: CreateAgentSessionOptions): PermissionScope | undefined {
	if (!created.settings) throw new Error("the child session got no settings");
	const active = activePermissionScope(created.settings);
	if (active && !active.ok) throw new Error(active.error);
	return active?.scope as PermissionScope | undefined;
}

function promptBlocks(created: CreateAgentSessionOptions): string {
	const build = created.systemPrompt;
	if (typeof build !== "function") throw new Error("the child session got no prompt builder");
	return [build(["base"])].flat().join("\n");
}

describe("executor starts the child under its scope", () => {
	it("writes the scope as a runtime override in the child's settings", async () => {
		const scope = enforceScope({ actorId: "ScopedSpawn", tools: ["read", "grep"] });
		const created = await executorSpawn({ settings: Settings.isolated(), permissionScope: scope });

		expect(created.settings?.getProvenance(cfgTaskPermissionsActiveScope)).toBe("runtime");
		expect(childScope(created)?.tools).toEqual(["read", "grep"]);
		expect(childScope(created)?.actorId).toBe("ScopedSpawn");
	});

	it("cuts the tool list to the scope and restricts the child to it", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			agent: makeAgent(["read", "write", "bash", "grep"]),
			permissionScope: enforceScope({ tools: ["read", "grep"] }),
		});

		expect(created.toolNames).toEqual(["read", "grep"]);
		expect(created.restrictToolNames).toBe(true);
		expect(created.enableMCP).toBe(false);
	});

	it("honours an explicit empty allowlist", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			permissionScope: enforceScope({ tools: [] }),
		});

		expect(created.toolNames).toEqual([]);
		expect(created.restrictToolNames).toBe(true);
	});

	it("takes the scope's allowlist when the agent declares no tools, messaging as write and wait", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			permissionScope: enforceScope({ tools: ["read", "hub"] }),
		});

		expect(created.toolNames).toEqual(["read", "write", "wait"]);
	});

	it("drops tools whose effects path rules cannot check", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			agent: makeAgent(["read", "bash", "eval", "lsp"]),
			permissionScope: enforceScope({ tools: ["read", "bash", "eval", "lsp"], denyPathGroups: [["secret"]] }),
		});

		expect(created.toolNames).toEqual(["read"]);
	});

	it("drops denied tools from the built-in set when there is no allowlist", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			permissionScope: enforceScope({ denyTools: ["bash", "web_search"] }),
		});

		expect(created.toolNames).toContain("read");
		expect(created.toolNames).not.toContain("bash");
		expect(created.toolNames).not.toContain("web_search");
		expect(created.restrictToolNames).toBe(true);
	});

	it("records a suggest scope without narrowing anything", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			agent: makeAgent(["read", "write", "bash"]),
			permissionScope: enforceScope({ mode: "suggest", tools: ["read"] }),
		});

		expect(childScope(created)?.mode).toBe("suggest");
		expect(created.toolNames).toEqual(["read", "write", "bash", "wait"]);
		expect(created.restrictToolNames).toBe(false);
	});

	it("adds a PERMISSIONS block naming the scope and its threat model", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			permissionScope: enforceScope({
				profiles: ["read-only"],
				tools: ["read", "grep"],
				denyTools: ["web_search"],
				denyPathGroups: [["**/.env", "secret"]],
			}),
		});

		const prompt = promptBlocks(created);
		expect(prompt).toContain("§ Permissions");
		expect(prompt).toContain("Profiles: read-only");
		expect(prompt).toContain("Tools: read, grep");
		expect(prompt).toContain("Denied tools: web_search");
		expect(prompt).toContain("Denied paths: **/.env | secret");
		expect(prompt).toContain("guardrails, not a sandbox");
		expect(prompt).toContain("Memory recall");
		expect(prompt).toContain("the scope does not filter");
	});

	it("marks a suggest scope's block as advisory", async () => {
		const created = await executorSpawn({
			settings: Settings.isolated(),
			permissionScope: enforceScope({ mode: "suggest", tools: ["read"] }),
		});

		const prompt = promptBlocks(created);
		expect(prompt).toContain("§ Permissions");
		expect(prompt).toContain("Advisory");
	});

	it("leaves an unscoped child's prompt and tools as upstream", async () => {
		const created = await executorSpawn({ settings: Settings.isolated(), agent: makeAgent(["read", "bash"]) });

		expect(promptBlocks(created)).not.toContain("§ Permissions");
		expect(created.toolNames).toEqual(["read", "bash", "wait"]);
		expect(created.restrictToolNames).toBe(false);
		expect(created.settings?.getProvenance(cfgTaskPermissionsActiveScope)).toBe("default");
	});
});
