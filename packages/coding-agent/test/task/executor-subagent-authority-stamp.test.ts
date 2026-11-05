/**
 * An ordinary task subagent's transcript records the parent's authority root in its header, like seance and /tan
 * children, so `omp --resume <subagent>.jsonl` is refused instead of bootstrapping a separate root authority.
 *
 * These cases drive the real `task` tool (TaskTool.execute -> runSubprocess -> SessionManager.open), the path the
 * CLI takes, both inline and as a background job: only the child's model session is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { closeSessionAuthority, registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/authority";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetAgentLifecycleForTests } from "../../src/internal/agent-lifecycle-bridge";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import { createSessionDefaults } from "../helpers/session-defaults";

const roots: AgentSession[] = [];
const authorityFiles: string[] = [];
const directories: string[] = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	resetAgentLifecycleForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await root.dispose();
	for (const file of authorityFiles.splice(0)) await closeSessionAuthority(file);
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
	resetAgentLifecycleForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	resetSettingsForTest();
});

function yieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session: Partial<AgentSession> = {
		...createSessionDefaults(),
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners)
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			return true;
		},
		getLastAssistantMessage: () => undefined as never,
		sendUserMessage: async () => {},
		setIrcWakeTurnObserver: () => {},
		trackIrcReply: () => {},
		abort: async () => {},
		dispose: async () => {},
	};
	return session as AgentSession;
}

const agent: AgentDefinition = { name: "worker", description: "test", systemPrompt: "test", source: "bundled" };

interface Fixture {
	parentFile: string;
	tool: TaskTool;
	childFiles: string[];
}

async function fixture(asyncJobManager?: AsyncJobManager): Promise<Fixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-stamp-"));
	directories.push(directory);
	// Like the CLI: the parent is a persisted root whose registry lives in its own authority store.
	const parent = SessionManager.create(directory, path.join(directory, "sessions"));
	parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
	await parent.ensureOnDisk();
	const parentFile = parent.getSessionFile()!;
	authorityFiles.push(parentFile);

	const settings = Settings.isolated(asyncJobManager ? { "async.enabled": true } : {});
	const registry = await AgentRegistry.create({
		durableState: await registryDurableStateForSession(parentFile, { create: true }),
	});
	const root = await createAgentRootSession(registry, {
		agentId: "Main",
		agentDisplayName: "Main",
		sessionManager: parent,
		cwd: directory,
		agentDir: directory,
		settings,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
		skipPythonPreflight: true,
	});
	roots.push(root.session);
	const authority = bindInternalAgentAuthoritySession(registry, root.session);
	if (!authority) throw new Error("Test fixture requires parent authority");
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });

	const childFiles: string[] = [];
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		const file = options?.sessionManager?.getSessionFile();
		if (file) childFiles.push(file);
		const session = yieldingSession();
		Object.defineProperty(session, "sessionManager", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: options?.sessionManager,
		});
		return { session } as CreateAgentSessionResult;
	});

	const toolSession = {
		cwd: directory,
		hasUI: false,
		settings,
		agentRegistry: registry,
		asyncJobManager,
		createAuthoritySession: authority.create,
		getSessionFile: () => parentFile,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	return { parentFile, tool: await TaskTool.create(toolSession), childFiles };
}

async function childHeader(file: string): Promise<SessionHeader | undefined> {
	return (await loadEntriesFromFile(file)).find(entry => entry.type === "session") as SessionHeader | undefined;
}

describe("task tool subagent transcripts", () => {
	it("stamp the parent's authority root when the child runs inline", async () => {
		const { parentFile, tool, childFiles } = await fixture();

		await tool.execute("tc-stamp-sync", { agent: "worker", name: "Probe", task: "do work" } as never);

		expect(childFiles).toHaveLength(1);
		expect(path.dirname(childFiles[0]!)).toBe(parentFile.slice(0, -".jsonl".length));
		const header = await childHeader(childFiles[0]!);
		expect(header?.authorityRoot).toBe(await fs.realpath(parentFile));
		expect(header?.parentSession).toBe(parentFile);
	});

	it("stamp the parent's authority root when the child runs as a background job", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		try {
			const { parentFile, tool, childFiles } = await fixture(manager);

			await tool.execute("tc-stamp-async", { agent: "worker", name: "Probe", task: "do work" } as never);
			await manager.getJob("Probe")?.promise;

			expect(childFiles).toHaveLength(1);
			const header = await childHeader(childFiles[0]!);
			expect(header?.authorityRoot).toBe(await fs.realpath(parentFile));
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
