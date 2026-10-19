import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sumSubagentTreeCost } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import {
	adoptAgent,
	createAgentLifecycleManager,
	disposeAgentLifecycle,
	ensureAgentLive,
	parkAgent,
} from "../../src/internal/agent-lifecycle-bridge";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	setAgentStatus,
} from "../../src/internal/agent-registry-bridge";
import {
	type AgentMetricsSummary,
	type AgentRef,
	AgentRegistry,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentCostSnapshot } from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

const root = path.resolve("sessions", "root.jsonl");
const artifacts = path.resolve("sessions", "root");

function usage(cost: number): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(model: Model, cost: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Reviewed the implementation" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(cost),
		stopReason: "stop",
		timestamp,
	};
}

function liveSession(manager: SessionManager, model: Model, modelRegistry: ModelRegistry): AgentSession {
	return new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
	});
}

function ref(id: string, overrides: Partial<AgentRef> & { cost?: number } = {}): AgentRef {
	const { cost, ...rest } = overrides;
	const metrics: AgentMetricsSummary | undefined =
		cost === undefined ? undefined : { tokens: 1, requests: 1, tools: 0, cost, durationMs: 0 };
	return {
		id,
		displayName: id,
		kind: "sub",
		status: "parked",
		sessionFile: path.join(artifacts, `${id}.jsonl`),
		createdAt: 0,
		lastActivity: 0,
		history: metrics ? { metrics } : undefined,
		...rest,
	};
}

describe("sumSubagentTreeCost", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("sums the root's subagent tree and nothing outside it", () => {
		const observers = new SessionObserverRegistry();
		const cost = sumSubagentTreeCost({
			refs: [
				ref("Main", { kind: "main", sessionFile: root, cost: 10 }),
				ref("A", { cost: 0.1 }),
				// Grandchild transcripts live in the child's artifacts dir.
				ref("A.B", { parentId: "A", sessionFile: path.join(artifacts, "A", "A.B.jsonl"), cost: 0.02 }),
				// Subagent advisors are part of the tree; the main advisor is billed separately.
				ref("A/advisor", {
					kind: "advisor",
					parentId: "A",
					sessionFile: path.join(artifacts, "A", "__advisor.jsonl"),
					cost: 0.003,
				}),
				ref("Main/advisor", {
					kind: "advisor",
					parentId: "Main",
					sessionFile: path.join(artifacts, "__advisor.jsonl"),
					cost: 5,
				}),
				// A previous session's agent still in the process-global registry.
				ref("Old", { sessionFile: path.resolve("sessions", "old", "Old.jsonl"), cost: 7 }),
				// File-less and not observed by this session.
				ref("Stray", { sessionFile: null, cost: 9 }),
			],
			// Empty registry: no row resolves a live session, so only metrics count.
			registry: new AgentRegistry(),
			observers,
			rootSessionFile: root,
			sessionCosts: new WeakMap(),
		});
		expect(cost).toBeCloseTo(0.123, 10);
	});

	it("prefers live observer progress over persisted history", () => {
		const observers = new SessionObserverRegistry();
		const bus = new EventTarget();
		observers.subscribeToEventBus(
			{
				on: (channel, listener) => {
					const handler = (event: Event) => listener((event as CustomEvent).detail);
					bus.addEventListener(channel, handler);
					return () => bus.removeEventListener(channel, handler);
				},
			},
			{ on: () => () => {} },
		);
		bus.dispatchEvent(
			new CustomEvent("task:subagent:progress", {
				detail: {
					index: 0,
					agent: "task",
					agentSource: "bundled",
					task: "t",
					progress: { id: "A", tokens: 5, requests: 2, toolCount: 1, cost: 0.25, durationMs: 100 },
				},
			}),
		);
		const cost = sumSubagentTreeCost({
			refs: [ref("A", { status: "running", cost: 0.1 })],
			// Empty registry: no row resolves a live session, so only metrics count.
			registry: new AgentRegistry(),
			observers,
			rootSessionFile: root,
			sessionCosts: new WeakMap(),
		});
		expect(cost).toBeCloseTo(0.25);
	});

	it("keeps cumulative direct billing across changing tails and compaction without scanning session statistics", async () => {
		const auth = await AuthStorage.create(":memory:");
		const sessions: AgentSession[] = [];
		try {
			const models = new ModelRegistry(auth);
			const model = models.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
			if (!model) throw new Error("Expected a bundled model");
			const parentManager = SessionManager.inMemory();
			parentManager.appendMessage({ role: "user", content: "review", timestamp: 1 });
			const ownerParent = parentManager.appendMessage(assistant(model, 0.6, 2));
			const parent = liveSession(parentManager, model, models);
			const childManager = SessionManager.inMemory();
			childManager.appendMessage(assistant(model, 0.2, 2));
			const child = liveSession(childManager, model, models);
			sessions.push(parent, child);
			const statsReads = sessions.map(session => spyOn(session, "getSessionStats"));
			const registry = new AgentRegistry();
			const rows = [
				registry.register({ ...ref("Parent", { status: "running" }), session: null }),
				registry.register({ ...ref("Child", { parentId: "Parent", status: "running" }), session: null }),
				registry.register({ ...ref("ChildAlias", { status: "running" }), session: null }),
			];
			expect(registry.attachSession("Parent", parent, root, rows[0])).toBe(true);
			expect(registry.attachSession("Child", child, path.join(artifacts, "Child.jsonl"), rows[1])).toBe(true);
			expect(registry.attachSession("ChildAlias", child, path.join(artifacts, "ChildAlias.jsonl"), rows[2])).toBe(
				true,
			);
			const args = {
				refs: rows,
				registry,
				observers: new SessionObserverRegistry(),
				rootSessionFile: root,
				sessionCosts: new WeakMap<object, AgentCostSnapshot>(),
			};
			expect(sumSubagentTreeCost(args)).toBeCloseTo(0.8);
			const tail = assistant(model, 0, 3);
			parent.agent.appendMessage(tail);
			for (let i = 0; i < 3; i++) {
				tail.usage.output++;
				expect(sumSubagentTreeCost(args)).toBeCloseTo(0.8);
			}
			parentManager.appendMessage({
				...assistant(model, 0, 3),
				content: [{ type: "toolCall", id: "nested-task", name: "task", arguments: {} }],
				stopReason: "toolUse",
			});
			parentManager.appendMessage({
				role: "toolResult",
				toolCallId: "nested-task",
				toolName: "task",
				content: [{ type: "text", text: "child result" }],
				details: { usage: usage(99) },
				isError: false,
				timestamp: 4,
			});
			const retained = parentManager.appendMessage(assistant(model, 0.4, 5));
			parentManager.appendCompaction("Earlier work", undefined, retained, 100, { tokensAfter: 15 });
			parent.agent.replaceMessages(parentManager.buildSessionContext().messages);
			expect(sumSubagentTreeCost(args)).toBeCloseTo(1.2);
			parentManager.appendModelUsage(
				{
					purpose: "task-completion-probe",
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: usage(0.05),
					stopReason: "stop",
				},
				{ sessionId: parentManager.getSessionId(), parentId: ownerParent },
			);
			expect(parentManager.getBranch().some(entry => entry.type === "model_usage")).toBe(false);
			expect(sumSubagentTreeCost(args)).toBeCloseTo(1.25);
			for (const reads of statsReads) expect(reads).not.toHaveBeenCalled();
		} finally {
			await Promise.all(sessions.map(session => session.dispose()));
			auth.close();
		}
	});

	it("uses the final parked charge and replaces it when the same agent resumes", async () => {
		const auth = await AuthStorage.create(":memory:");
		using tempDir = TempDir.createSync("@omp-subagent-cost-");
		let lifecycle: AgentLifecycleManager | undefined;
		let authorityRoot: AgentSession | undefined;
		const createdSessions = new Set<AgentSession>();
		try {
			const durableRootSessionFile = path.join(tempDir.path(), "main.jsonl");
			await Bun.write(durableRootSessionFile, "");
			const registry = new AgentRegistry({ durableState: registryDurableStateForSession(durableRootSessionFile) });
			const models = new ModelRegistry(auth);
			const model = models.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
			if (!model) throw new Error("Expected a bundled model");
			const root = await createAgentRootSession(registry, {
				agentId: "Main",
				cwd: tempDir.path(),
				agentDir: tempDir.join("agent"),
				settings: Settings.isolated(),
				authStorage: auth,
				modelRegistry: models,
				model,
			});
			authorityRoot = root.session;
			const authority = bindInternalAgentAuthoritySession(registry, authorityRoot);
			if (!authority) throw new Error("Test fixture requires parent authority");
			lifecycle = createAgentLifecycleManager(registry);
			const rootSessionFile = authorityRoot.sessionManager.getSessionFile();
			const rootArtifactsDir = authorityRoot.sessionManager.getArtifactsDir();
			if (!rootSessionFile || !rootArtifactsDir) throw new Error("Expected a file-backed root session");
			const workerSettings = Settings.isolated({ "compaction.enabled": false });
			const workerOptions = (sessionManager: SessionManager) => ({
				agentId: "Worker",
				agentName: "worker",
				agentDisplayName: "Worker",
				parentAgentId: "Main",
				parentTaskPrefix: "Worker",
				taskDepth: 1,
				spawns: "",
				cwd: tempDir.path(),
				agentDir: tempDir.join("agent"),
				authStorage: auth,
				modelRegistry: models,
				model,
				settings: workerSettings,
				sessionManager,
				toolNames: [],
				restrictToolNames: true,
				enableIrc: false,
				enableLsp: false,
				enableMCP: false,
				hasUI: false,
			});
			const manager = SessionManager.create(tempDir.path(), rootArtifactsDir);
			manager.appendMessage(assistant(model, 0.6, 1));
			const { session } = await authority.create(workerOptions(manager));
			createdSessions.add(session);
			expect(setAgentStatus(registry, "Worker", "idle", session)).toBe(true);
			const worker = registry.get("Worker");
			if (!worker) throw new Error("Expected Worker registry snapshot");
			adoptAgent(
				lifecycle,
				worker.id,
				{
					idleTtlMs: 0,
					revive: async expected => {
						const workerSessionFile = manager.getSessionFile();
						if (!workerSessionFile) throw new Error("Expected a file-backed worker session");
						const resumedManager = await SessionManager.open(workerSessionFile);
						resumedManager.appendMessage(assistant(model, 0.3, 3));
						const { session: resumedSession } = await authority.create(workerOptions(resumedManager), expected);
						createdSessions.add(resumedSession);
						return resumedSession;
					},
				},
				worker,
			);
			const observers = new SessionObserverRegistry();
			const sessionCosts = new WeakMap<object, AgentCostSnapshot>();
			const args = () => ({
				refs: registry.list(),
				registry,
				observers,
				rootSessionFile,
				sessionCosts,
			});
			expect(sumSubagentTreeCost(args())).toBeCloseTo(0.6);
			manager.appendMessage(assistant(model, 0.4, 2));
			await parkAgent(lifecycle, worker.id);
			const parkedWorker = registry.get("Worker");
			expect(parkedWorker?.status).toBe("parked");
			expect(parkedWorker?.history?.metrics).toBeUndefined();
			expect(parkedWorker?.history?.directCost).toBe(1.0);
			expect(sumSubagentTreeCost(args())).toBeCloseTo(1);

			await ensureAgentLive(lifecycle, worker.id);
			const resumedWorker = registry.get("Worker");
			expect(resumedWorker?.status).toBe("idle");
			expect(sumSubagentTreeCost(args())).toBeCloseTo(1.3);
		} finally {
			try {
				if (lifecycle) await disposeAgentLifecycle(lifecycle);
			} finally {
				try {
					await Promise.all([...createdSessions].map(session => session.dispose()));
				} finally {
					try {
						await authorityRoot?.dispose();
					} finally {
						try {
							AgentStorage.close();
						} finally {
							auth.close();
						}
					}
				}
			}
		}
	});
});
