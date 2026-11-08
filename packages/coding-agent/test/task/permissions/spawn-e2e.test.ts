/**
 * End to end, from the task call to the child's tool call: a real child session, driven by a scripted
 * model, runs under the scope its spawn composed. Headless subagents run with
 * `tools.approvalMode: yolo`, which auto-approves every tier; the permission guard must still refuse
 * what the scope does not allow. `suggest` and a spawn without a request restrict nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { activePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/guard";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const MOCK_SOURCE = "test/permission-spawn-e2e";
const CHILD_ID = "ScopedWriter";

let root: string;
let cwd: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-permission-e2e-"));
	cwd = path.join(root, "project");
	await fs.mkdir(path.join(cwd, "secret"), { recursive: true });
	setAgentDir(path.join(root, "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_SOURCE);
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "test-key");
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_SOURCE);
	vi.restoreAllMocks();
	authStorage.close();
	AgentStorage.close();
	closeModelCache();
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

function toolResultText(message: { content: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
}

/** Spawn one child through the task tool; its model writes `target`, then reports the write's result. */
async function spawnWriter(options: {
	mode: "off" | "suggest" | "enforce";
	target: string;
	request?: Record<string, unknown>;
}): Promise<{ text: string; childSettings: Settings | undefined }> {
	const model = createMockModel({
		id: "permission-e2e",
		handler: context => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") return { content: [`RESULT: ${toolResultText(last)}`] };
			return {
				content: [{ type: "toolCall", name: "write", arguments: { path: options.target, content: "leak" } }],
			};
		},
	});
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const find = modelRegistry.find.bind(modelRegistry);
	modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
	modelRegistry.getAvailable = () => [model];
	const agent: AgentDefinition = {
		name: "writer",
		description: "Writes a file",
		systemPrompt: "Write the file.",
		source: "bundled",
		tools: ["read", "write"],
		model: [`mock/${model.id}`],
	};
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	const settings = Settings.isolated({
		"task.permissions.mode": options.mode,
		"task.batch": false,
		"task.structured": false,
		"task.isolation.enabled": false,
		"task.enableLsp": false,
		"task.completionProbe": false,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.enabled": false,
		"autolearn.enabled": false,
		"todo.enabled": false,
	});
	const session = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	const tool = await TaskTool.create(session);
	const result = await tool.execute("permission-e2e", {
		name: CHILD_ID,
		agent: "writer",
		task: `Write ${options.target}.`,
		solutionSpace: "one write, target given",
		...options.request,
	});
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	const child = AgentRegistry.global().get(CHILD_ID)?.session;
	return { text, childSettings: child instanceof AgentSession ? child.settings : undefined };
}

describe("spawn to denied call, under the headless yolo approval mode", () => {
	it("refuses a write the enforce scope denies, though the child auto-approves every tier", async () => {
		const target = path.join("secret", "key.txt");
		const { text, childSettings } = await spawnWriter({
			mode: "enforce",
			target,
			request: { permissions: { tools: ["read", "write"], denyPaths: ["secret"] } },
		});

		expect(childSettings).toBeDefined();
		expect(cfgToolsApprovalMode.get(childSettings!)).toBe("yolo");
		const active = childSettings ? activePermissionScope(childSettings) : undefined;
		expect(active?.ok && active.scope.actorId).toBe(CHILD_ID);
		expect(text).toContain("RESULT: BLOCKED: Subagent permission profile denied path 'secret/key.txt'.");
		expect(await Bun.file(path.join(cwd, target)).exists()).toBe(false);
	});

	it("lets the same write through for a spawn without a permission request", async () => {
		const target = path.join("secret", "key.txt");
		const { text, childSettings } = await spawnWriter({ mode: "enforce", target });

		expect(childSettings ? activePermissionScope(childSettings) : "no child").toBeUndefined();
		expect(text).not.toContain("BLOCKED");
		expect(await Bun.file(path.join(cwd, target)).text()).toBe("leak");
	});

	it("lets the same write through under suggest, which only records the scope", async () => {
		const target = path.join("secret", "key.txt");
		const { text, childSettings } = await spawnWriter({
			mode: "suggest",
			target,
			request: { permissions: { tools: ["read", "write"], denyPaths: ["secret"] } },
		});

		const active = childSettings ? activePermissionScope(childSettings) : undefined;
		expect(active?.ok && active.scope.mode).toBe("suggest");
		expect(text).not.toContain("BLOCKED");
		expect(await Bun.file(path.join(cwd, target)).text()).toBe("leak");
	});
});
