import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	registerToolSessionLifecycleAuthority,
	resetAgentLifecycleForTests,
} from "../../src/internal/agent-lifecycle-bridge";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import type { AgentSession } from "../../src/session/agent-session";
import * as discovery from "../../src/task/discovery";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";

const SCOUT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Inspect things.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();
const authoritySessions = new Set<AgentSession>();

async function makeSession(): Promise<ToolSession> {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	const registry = new AgentRegistry();
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.maxConcurrency": 2,
		"task.maxRecursionDepth": 2,
		"task.isolation.enabled": false,
		"task.enableLsp": false,
	});
	const root = await createAgentRootSession(registry, {
		agentId: "Main",
		agentDisplayName: "Main",
		cwd: "/tmp",
		agentDir: "/tmp",
		settings,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
		skipPythonPreflight: true,
	});
	const authorityBinding = bindInternalAgentAuthoritySession(registry, root.session);
	if (!authorityBinding) throw new Error("Test fixture requires a live parent-bound authority session.");
	authoritySessions.add(root.session);
	managers.add(manager);
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings,
		asyncJobManager: manager,
		agentRegistry: registry,
		createAuthoritySession: (options, reviveRef) => authorityBinding.create(options, reviveRef),
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	} satisfies ToolSession;
	registerToolSessionLifecycleAuthority(session, registry, root.session);
	return session;
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	await Promise.all([...authoritySessions].map(session => session.dispose()));
	authoritySessions.clear();
	vi.restoreAllMocks();
	resetAgentLifecycleForTests();
	WorkPoolRegistry.resetForTests();
});

describe("runEvalWorkpool", () => {
	it("validates operation arguments", async () => {
		const session = await makeSession();
		await expect(runEvalWorkpool(null, { session })).rejects.toThrow("arguments must be an object");
		await expect(runEvalWorkpool({}, { session })).rejects.toThrow("requires an op");
		await expect(runEvalWorkpool({ op: "create", agent: 4 }, { session })).rejects.toThrow(
			"agent must be a non-empty string",
		);
		await expect(runEvalWorkpool({ op: "status", name: "" }, { session })).rejects.toThrow(
			"requires a non-empty name",
		);
	});

	it("rejects unknown pool names", async () => {
		const session = await makeSession();
		await expect(runEvalWorkpool({ op: "status", name: "missing" }, { session })).rejects.toThrow(
			'unknown workpool "missing"',
		);
	});

	it("creates unique default names and validates push and peek arguments", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = await makeSession();
		const events: Array<Record<string, unknown>> = [];
		const first = await runEvalWorkpool(
			{ op: "create", agent: "scout" },
			{ session, emitStatus: event => events.push(event) },
		);
		const second = await runEvalWorkpool({ op: "create", agent: "scout" }, { session });
		expect(first).toEqual({ name: "scout-pool", agent: "scout", limit: 2 });
		expect(second).toEqual({ name: "scout-pool-2", agent: "scout", limit: 2 });
		expect(events).toEqual([{ op: "workpool", action: "create", pool: "scout-pool", count: 2 }]);
		await expect(runEvalWorkpool({ op: "push", name: "scout-pool", items: ["ok", 1] }, { session })).rejects.toThrow(
			"items string array",
		);
		expect(await runEvalWorkpool({ op: "peek", name: "scout-pool" }, { session })).toEqual({
			batches: [],
			pending: 0,
		});
		await expect(runEvalWorkpool({ op: "wait", name: "scout-pool" }, { session })).rejects.toThrow(
			'unknown workpool operation "wait"',
		);
	});
});
