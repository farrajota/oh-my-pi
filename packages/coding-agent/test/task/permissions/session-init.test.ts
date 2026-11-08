/**
 * A scoped spawn records its permission provenance in the child's `session_init`: the profiles its
 * request named, the effective profiles, and the frozen scope with its hash. The field names and the
 * hash are the fork's, so fork-era transcripts stay readable. Ports the fork's extract-session-init
 * and peek-session-init permission assertions (design 7, step 19).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	extractSessionInit,
	type PersistedSessionInit,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { freezePermissionScope, readPermissionSnapshot } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../../helpers/session-defaults";
import v1FixtureJson from "./fixtures/v1-permission-snapshots.json" with { type: "json" };
import { enforceScope } from "./scope-fixtures";

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

beforeEach(async () => {
	// An empty agent dir, so a developer's own permissions.json never reaches these spawns.
	setAgentDir(path.join(await tempRoot("omp-session-init-agent-"), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function createManager(cwd: string): { manager: SessionManager; sessionFile: string } {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file path");
	return { manager, sessionFile };
}

function assistantFlush(manager: SessionManager): void {
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "flush" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

describe("session_init permission provenance", () => {
	it("keeps the permission revival contract when a rebuilt session_init is re-appended", async () => {
		const { manager, sessionFile } = createManager(await tempRoot("omp-extract-init-"));
		const snapshot = freezePermissionScope(
			enforceScope({ actorId: "child", profiles: ["read-only"], tools: ["read", "grep"] }),
		);
		manager.appendSessionInit({
			systemPrompt: ["base", "batch 1"],
			task: "work",
			tools: ["read"],
			requestedPermissionProfiles: [],
			effectivePermissionProfiles: ["read-only"],
			permissionSnapshot: snapshot,
		});
		await manager.ensureOnDisk();

		// AgentSession re-appends the extracted contract with a new base whenever a model call's base changes.
		const extracted = extractSessionInit(manager.getEntries());
		if (!extracted) throw new Error("Expected a persisted session_init");
		manager.appendSessionInit({ ...extracted, systemPrompt: ["base", "batch 2"] });
		await manager.flush();

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.init?.systemPrompt).toEqual(["base", "batch 2"]);
		expect(peek?.init?.permissionSnapshot).toEqual(snapshot);
		expect(peek?.init?.effectivePermissionProfiles).toEqual(["read-only"]);
		expect(peek?.init?.requestedPermissionProfiles).toEqual([]);
	});

	it("reads the requested and effective profiles back through the lock-free peek", async () => {
		const { manager, sessionFile } = createManager(await tempRoot("omp-peek-init-"));
		manager.appendSessionInit({ systemPrompt: ["first"], task: "t1", tools: ["read"], spawns: "" });
		manager.appendSessionInit({
			systemPrompt: ["second"],
			task: "t2",
			tools: ["read", "yield"],
			requestedPermissionProfiles: ["no-network", "focused-edit"],
			effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
		});
		assistantFlush(manager);

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.init?.requestedPermissionProfiles).toEqual(["no-network", "focused-edit"]);
		expect(peek?.init?.effectivePermissionProfiles).toEqual(["read-only", "no-network", "focused-edit"]);
	});

	it("reads a fork-era v1 snapshot back verbatim, so its hash still verifies", async () => {
		const { manager, sessionFile } = createManager(await tempRoot("omp-v1-init-"));
		const forkSnapshot = v1FixtureJson.snapshots.child.snapshot;
		manager.appendSessionInit({
			systemPrompt: ["fork"],
			task: "fork task",
			tools: ["read", "grep", "yield"],
			requestedPermissionProfiles: [],
			effectivePermissionProfiles: forkSnapshot.scope.profiles,
			permissionSnapshot: forkSnapshot,
		});
		assistantFlush(manager);

		const persisted = (await SessionManager.peekSessionInit(sessionFile))?.init?.permissionSnapshot;
		expect(persisted).toEqual(forkSnapshot);
		const read = readPermissionSnapshot(persisted);
		if (!read.ok) throw new Error(read.error);
		expect(read.version).toBe(1);
		expect(read.snapshot.scope.actorId).toBe(forkSnapshot.scope.actorId);
	});
});

function yieldingSession(recorded: PersistedSessionInit[]): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: (init: PersistedSessionInit) => recorded.push(init) },
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

/** Run the executor with the child session stubbed out; returns the session_init it recorded. */
async function recordedInit(options: Partial<executorModule.ExecutorOptions>): Promise<PersistedSessionInit> {
	const recorded: PersistedSessionInit[] = [];
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(yieldingSession(recorded)));
	const result = await executorModule.runSubprocess({
		cwd: process.cwd(),
		agent: { name: "synthetic", description: "test", systemPrompt: "Do the work.", source: "project" },
		task: "do work",
		index: 0,
		id: "ScopedSpawn",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		...options,
	});
	expect(result.exitCode).toBe(0);
	const init = recorded[0];
	if (!init) throw new Error("the executor recorded no session_init");
	return init;
}

describe("the executor records the spawn's provenance", () => {
	it("writes the requested and effective profiles and the frozen scope with its hash", async () => {
		const scope = enforceScope({
			actorId: "ScopedSpawn",
			profiles: ["read-only", "no-network"],
			tools: ["read", "grep"],
		});
		const init = await recordedInit({ permissionScope: scope, requestedPermissionProfiles: ["no-network"] });

		expect(init.requestedPermissionProfiles).toEqual(["no-network"]);
		expect(init.effectivePermissionProfiles).toEqual(["read-only", "no-network"]);
		expect(init.permissionSnapshot).toEqual(freezePermissionScope(scope));
		const read = readPermissionSnapshot(init.permissionSnapshot);
		if (!read.ok) throw new Error(read.error);
		expect(read.version).toBe(2);
		expect(read.snapshot.scope).toEqual(scope);
	});

	it("records a suggest scope too, because revival restores whatever the spawn ran under", async () => {
		const scope = enforceScope({ actorId: "ScopedSpawn", mode: "suggest", tools: ["read"] });
		const init = await recordedInit({ permissionScope: scope });

		expect(init.requestedPermissionProfiles).toEqual([]);
		expect(init.permissionSnapshot?.canonicalSha256).toBe(freezePermissionScope(scope).canonicalSha256);
	});

	it("records no permission fields for an unscoped spawn", async () => {
		const init = await recordedInit({});

		expect(init.requestedPermissionProfiles).toBeUndefined();
		expect(init.effectivePermissionProfiles).toBeUndefined();
		expect(init.permissionSnapshot).toBeUndefined();
	});
});

describe("the task tool forwards the profiles its request named", () => {
	function makeAgent(): AgentDefinition {
		return { name: "synthetic", description: "Synthetic", systemPrompt: "Do the work.", source: "project" };
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

	it("passes the request's profile names, in request order, with the composed scope", async () => {
		const agent = makeAgent();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options));
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": false,
				"task.batch": false,
				"task.isolation.enabled": false,
				"task.permissions.mode": "enforce",
			}),
			taskDepth: 0,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => null,
			getSessionId: () => "session-init-test",
			getActiveModelString: () => "p/active",
			getModelString: () => "p/fallback",
		} as ToolSession;
		const tool = await TaskTool.create(session);
		const result = await tool.execute("tool-call", {
			agent: agent.name,
			task: "Do the work.",
			permissions: { profiles: ["no-network", "read-only"] },
		});

		expect(result.isError).not.toBe(true);
		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.requestedPermissionProfiles).toEqual(["no-network", "read-only"]);
		expect(options?.permissionScope?.profiles).toEqual(["no-network", "read-only"]);
	});
});
