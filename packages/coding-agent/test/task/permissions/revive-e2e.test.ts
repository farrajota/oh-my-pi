/**
 * A scoped subagent keeps its permission scope after it parks, on both revival paths: the
 * in-process (warm) revive, which rebuilds the session from the spawn's own options, and the cold
 * revive from its transcript after a restart, placed on a worker like a fresh spawn. Each test runs
 * a real child session against a scripted model and has it write a path its scope denies after the
 * revive. Design 7, step 20.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { recordPermissionBinding } from "@oh-my-pi/pi-coding-agent/task/permissions/revival";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { RemoteAgentSession } from "@oh-my-pi/pi-coding-agent/thread/remote-agent-session";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import { FakeModelServer } from "./fake-model-server";
import { enforceScope } from "./scope-fixtures";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "fake/fake-model";
const TEST_TIMEOUT_MS = 120_000;
const SCRIPT_ID = Bun.randomUUIDv7("hex");
const WRITE_TASK = `omp-test-revived-write-${SCRIPT_ID}`;
const AGENT_MARKER = `omp-test-revived-agent-${SCRIPT_ID}`;
const TARGET = path.join("secret", "key.txt");
const BLOCKED_RESULT = "BLOCKED: Subagent permission profile denied path 'secret/key.txt'.";
const BLOCKED = `tool said: ${BLOCKED_RESULT}`;

const AGENT: AgentDefinition = {
	name: "task",
	description: "scoped revival test agent",
	systemPrompt: `You are a test agent (${AGENT_MARKER}).`,
	source: "bundled",
	tools: ["read", "write"],
};

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined> = {};
let server: FakeModelServer;
let pool: SubagentWorkerPool | undefined;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let jobs: AsyncJobManager;
const cleanups: Array<() => Promise<void> | void> = [];

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-revive-e2e-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	cwd = path.join(root, "work");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(cwd, "secret"), { recursive: true });
	// Workers read these at start-up, so set them before the pool spawns any.
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	server = new FakeModelServer({ agentMarker: AGENT_MARKER, writeTask: WRITE_TASK, target: TARGET });
	const modelsPath = await server.writeModelsYml(agentDir);
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"task.workerThreads": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"async.enabled": false,
		modelRoles: { default: MODEL },
	});
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	pool = undefined;
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	setSubagentWorkerPoolForTests(undefined);
	pool?.dispose();
	server.stop();
	await jobs.dispose({ timeoutMs: 1_000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	authStorage.close();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

function useWorkerPool(): void {
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 600_000,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000 },
	});
	setSubagentWorkerPoolForTests(pool);
}

function runOptions(id: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task: "say hello",
		index: 0,
		id,
		description: `scoped ${id}`,
		modelOverride: MODEL,
		structured: false,
		settings,
		authStorage,
		modelRegistry,
		asyncJobManager: jobs,
		artifactsDir: path.join(root, "artifacts"),
		enableLsp: false,
		enableMCP: false,
		taskDepth: 0,
		parentAgentId: "Main",
		...extra,
	};
}

/**
 * A real root session over a persisted transcript, registered as `Main`, as main.ts hands the
 * persisted reviver factory. A spawn through the task tool records its children's scope hashes here.
 */
function rootSession(): AgentSession {
	const manager = SessionManager.create(cwd, path.join(root, "home", ".omp", "agent", "sessions"));
	manager.appendMessage({
		role: "assistant",
		provider: "fake",
		model: "fake-model",
		content: [{ type: "text", text: "spawning" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "openai-completions",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const model = modelRegistry.find("fake", "fake-model");
	if (!model) throw new Error("fake model missing from the main registry");
	const agent = new Agent({ initialState: { model, systemPrompt: ["root"], tools: [] }, convertToLlm });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry,
		agentId: MAIN_AGENT_ID,
	});
	cleanups.push(() => session.dispose());
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session: null,
		sessionFile: manager.getSessionFile() ?? null,
		status: "running",
	});
	return session;
}

/** Simulate a restart: only the transcripts are left, and the persisted factory revives from them. */
function restartWithPersistedReviver(root: AgentSession): void {
	AgentLifecycleManager.resetGlobalForTests();
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({ session: root, authStorage, modelRegistry, settings, enableLsp: false }),
		() => 0,
	);
}

describe("a scoped subagent revived after it parked", () => {
	it(
		"keeps its scope across an in-process park and revive",
		async () => {
			const scope = enforceScope({ actorId: "WarmScoped", tools: ["read", "write"], denyPathGroups: [["secret"]] });
			const first = await runSubprocess(runOptions("WarmScoped", { permissionScope: scope }));
			expect(first.error).toBeUndefined();
			const lifecycle = AgentLifecycleManager.global();
			await lifecycle.park("WarmScoped");
			expect(AgentRegistry.global().get("WarmScoped")?.status).toBe("parked");

			const result = await runSubagentFollowUpTurn({
				id: "WarmScoped",
				agent: AGENT,
				message: WRITE_TASK,
				structured: false,
			});

			expect(result.output).toContain(BLOCKED);
			expect(server.toolResults.at(-1)).toBe(BLOCKED_RESULT);
			expect(await Bun.file(path.join(cwd, TARGET)).exists()).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"restores its scope from the transcript on a cold revive placed on a worker",
		async () => {
			useWorkerPool();
			const main = rootSession();
			const scope = enforceScope({ actorId: "ColdScoped", tools: ["read", "write"], denyPathGroups: [["secret"]] });
			recordPermissionBinding(main.sessionManager, "ColdScoped", scope);
			const first = await runSubprocess(runOptions("ColdScoped", { permissionScope: scope }));
			expect(first.error).toBeUndefined();
			await AgentLifecycleManager.global().park("ColdScoped");
			restartWithPersistedReviver(main);
			server.systemPrompts.length = 0;

			const result = await runSubagentFollowUpTurn({
				id: "ColdScoped",
				agent: AGENT,
				message: WRITE_TASK,
				structured: false,
			});

			const revived = AgentRegistry.global().get("ColdScoped")?.session;
			if (!(revived instanceof RemoteAgentSession)) throw new Error("the cold revive did not run on a worker");
			expect(result.output).toContain(BLOCKED);
			expect(server.toolResults.at(-1)).toBe(BLOCKED_RESULT);
			expect(await Bun.file(path.join(cwd, TARGET)).exists()).toBe(false);
			// The PERMISSIONS block the spawn sent is replayed with the persisted prompt.
			expect(server.systemPrompts.some(prompt => prompt.includes("§ Permissions"))).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs the same write unrestricted after a cold revive of an unscoped child",
		async () => {
			useWorkerPool();
			const main = rootSession();
			const first = await runSubprocess(runOptions("ColdOpen"));
			expect(first.error).toBeUndefined();
			await AgentLifecycleManager.global().park("ColdOpen");
			restartWithPersistedReviver(main);

			const result = await runSubagentFollowUpTurn({
				id: "ColdOpen",
				agent: AGENT,
				message: WRITE_TASK,
				structured: false,
			});

			expect(result.output).not.toContain("BLOCKED");
			expect(await Bun.file(path.join(cwd, TARGET)).text()).toBe("leak");
		},
		TEST_TIMEOUT_MS,
	);
});
