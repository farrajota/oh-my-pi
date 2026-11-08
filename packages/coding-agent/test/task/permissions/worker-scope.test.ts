/**
 * With subagents placed on worker threads, the child enforces its permission scope inside the worker:
 * a real worker on the direct-module entry, a real child `AgentSession` homed there, and a scripted
 * OpenAI-compatible server the worker finds through `models.yml`. The guard only reads a scope whose
 * provenance is `runtime`, so a refused call in the worker shows that the worker-side overlay, and a
 * worker mirror of a scoped main-thread overlay, both report `runtime`. Design 7, step 15.
 *
 * Upstream places a run on a worker only from the ninth concurrent subagent on, so the pool here is
 * forced onto workers (`hostsOnMain: false`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { encodePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
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
const WRITE_TASK = `omp-test-scoped-write-${SCRIPT_ID}`;
const AGENT_MARKER = `omp-test-scoped-agent-${SCRIPT_ID}`;
const TARGET = path.join("secret", "key.txt");

const AGENT: AgentDefinition = {
	name: "task",
	description: "scoped worker test agent",
	systemPrompt: `You are a test agent (${AGENT_MARKER}).`,
	source: "bundled",
	tools: ["read", "write"],
};

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined> = {};
let server: FakeModelServer;
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let jobs: AsyncJobManager;

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

const BASE_SETTINGS = {
	"task.agentIdleTtlMs": 0,
	"task.completionProbe": false,
	"compaction.enabled": false,
	"retry.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
	"advisor.enabled": false,
	"async.enabled": false,
	modelRoles: { default: MODEL },
};

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-scope-"));
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
	settings = Settings.isolated(BASE_SETTINGS);
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 600_000,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000 },
	});
	setSubagentWorkerPoolForTests(pool);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	setSubagentWorkerPoolForTests(undefined);
	pool.dispose();
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

function runOptions(id: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task: WRITE_TASK,
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
		...extra,
	};
}

function expectHomedOnWorker(id: string): void {
	const session = AgentRegistry.global().get(id)?.session;
	if (!(session instanceof RemoteAgentSession)) throw new Error(`${id} did not run on a worker`);
	expect(pool.forThread(session.home)?.alive).toBe(true);
}

describe("a scoped subagent on a worker thread", () => {
	it(
		"enforces the scope its spawn wrote, inside the worker",
		async () => {
			const scope = enforceScope({
				actorId: "WorkerScoped",
				tools: ["read", "write"],
				denyPathGroups: [["secret"]],
			});
			const result = await runSubprocess(runOptions("WorkerScoped", { permissionScope: scope }));

			expect(result.error).toBeUndefined();
			expectHomedOnWorker("WorkerScoped");
			expect(result.output).toBe("tool said: BLOCKED: Subagent permission profile denied path 'secret/key.txt'.");
			expect(await Bun.file(path.join(cwd, TARGET)).exists()).toBe(false);
			expect(server.systemPrompts.some(prompt => prompt.includes("§ Permissions"))).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"enforces a scope it reads through from a scoped main-thread parent overlay",
		async () => {
			// A restricted parent's settings: an overlay on main whose runtime layer holds the scope.
			const parentSettings = settings.overlay({
				"task.permissions.activeScope": encodePermissionScope(
					enforceScope({ actorId: "Parent", tools: ["read", "write"], denyPathGroups: [["secret"]] }),
				),
			});
			const result = await runSubprocess(runOptions("Parent.ReadThrough", { settings: parentSettings }));

			expect(result.error).toBeUndefined();
			expectHomedOnWorker("Parent.ReadThrough");
			expect(result.output).toBe("tool said: BLOCKED: Subagent permission profile denied path 'secret/key.txt'.");
			expect(await Bun.file(path.join(cwd, TARGET)).exists()).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs the same write unrestricted on a worker without a scope",
		async () => {
			const result = await runSubprocess(runOptions("WorkerOpen"));

			expect(result.error).toBeUndefined();
			expectHomedOnWorker("WorkerOpen");
			expect(result.output).not.toContain("BLOCKED");
			expect(await Bun.file(path.join(cwd, TARGET)).text()).toBe("leak");
		},
		TEST_TIMEOUT_MS,
	);
});
