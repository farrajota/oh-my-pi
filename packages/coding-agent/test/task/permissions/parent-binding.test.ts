/**
 * P5: when a session spawns a scoped child, it records the child's scope hash in its own transcript.
 * Revival matches the child's `session_init` snapshot against that record, which the child cannot
 * edit: its own transcript and the parent's live under the agent dir, which a restricted child may
 * not write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	PERMISSION_BINDING_CUSTOM_TYPE,
	permissionBindingIn,
} from "@oh-my-pi/pi-coding-agent/task/permissions/revival";
import { freezePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { enforceScope } from "./scope-fixtures";

const roots: string[] = [];

beforeEach(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parent-binding-"));
	roots.push(root);
	setAgentDir(path.join(root, "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const agent: AgentDefinition = {
	name: "synthetic",
	description: "Synthetic test agent",
	systemPrompt: "Do the work.",
	source: "project",
};

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

async function spawn(
	params: Record<string, unknown>,
): Promise<{ manager: SessionManager; options: executorModule.ExecutorOptions }> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options));
	const manager = SessionManager.inMemory();
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
		sessionManager: manager,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "parent-binding-test",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
	} as ToolSession;
	const tool = await TaskTool.create(session);
	const result = await tool.execute("tool-call", { agent: agent.name, task: "Do the work.", ...params });
	expect(result.isError).not.toBe(true);
	const options = runSpy.mock.calls[0]?.[0];
	if (!options) throw new Error("the task tool spawned nothing");
	return { manager, options };
}

describe("the spawning session records each scoped child's scope hash", () => {
	it("appends the child's id and scope hash to its own transcript before the child runs", async () => {
		const { manager, options } = await spawn({ permissions: { profiles: ["read-only"] } });
		const scope = options.permissionScope;
		if (!scope) throw new Error("expected a scoped spawn");

		const records = manager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === PERMISSION_BINDING_CUSTOM_TYPE);
		expect(records).toHaveLength(1);
		expect(permissionBindingIn(manager.getEntries(), options.id)).toBe(freezePermissionScope(scope).canonicalSha256);
	});

	it("records nothing for an unscoped child", async () => {
		const { manager, options } = await spawn({});

		expect(options.permissionScope).toBeUndefined();
		expect(permissionBindingIn(manager.getEntries(), options.id)).toBeUndefined();
	});
});

describe("permissionBindingIn", () => {
	it("returns the latest record for the agent and ignores other agents and malformed records", () => {
		const manager = SessionManager.inMemory();
		const first = freezePermissionScope(enforceScope({ actorId: "Child", tools: ["read"] }));
		const second = freezePermissionScope(enforceScope({ actorId: "Child", tools: [] }));
		const other = freezePermissionScope(enforceScope({ actorId: "Other", tools: ["read"] }));
		manager.appendCustomEntry(PERMISSION_BINDING_CUSTOM_TYPE, {
			agentId: "Child",
			canonicalSha256: first.canonicalSha256,
		});
		manager.appendCustomEntry(PERMISSION_BINDING_CUSTOM_TYPE, {
			agentId: "Other",
			canonicalSha256: other.canonicalSha256,
		});
		manager.appendCustomEntry(PERMISSION_BINDING_CUSTOM_TYPE, {
			agentId: "Child",
			canonicalSha256: second.canonicalSha256,
		});
		manager.appendCustomEntry(PERMISSION_BINDING_CUSTOM_TYPE, { agentId: "Child", canonicalSha256: 7 });
		manager.appendCustomEntry("unrelated", { agentId: "Child", canonicalSha256: first.canonicalSha256 });

		expect(permissionBindingIn(manager.getEntries(), "Child")).toBe(second.canonicalSha256);
		expect(permissionBindingIn(manager.getEntries(), "Other")).toBe(other.canonicalSha256);
		expect(permissionBindingIn(manager.getEntries(), "Missing")).toBeUndefined();
	});
});
