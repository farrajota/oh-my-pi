import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import {
	ensureAgentLive,
	getAgentLifecycleManager,
	parkAgent,
	releaseAgent,
	resetAgentLifecycleForTests,
	setPersistedAgentReviverFactory,
} from "../../src/internal/agent-lifecycle-bridge";
import type { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { freezePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permission-profiles";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { PreparedSeanceSession } from "@oh-my-pi/pi-coding-agent/task/seance";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";

const MOCK_API_SOURCE = "seance-artifact-lifecycle-test";
const AGENT_ID = "SeanceArtifactLifecycle";
const UNSTRUCTURED_AGENT_ID = "SeanceUnstructuredLifecycle";
function preparedSession(sourceFile: string, sourceSessionId: string): PreparedSeanceSession {
	return {
		fork: {
			sourceFile,
		},
		promptSuffix: model => `Consulting ${sourceSessionId} with ${model ?? "the saved model"}.`,
	};
}

async function createDurableRootAuthority(tempDir: TempDir, cwd: string) {
	const rootSessionFile = path.join(tempDir.path(), "main.jsonl");
	await Bun.write(rootSessionFile, "");
	const registry = new AgentRegistry({ durableState: registryDurableStateForSession(rootSessionFile) });
	AgentRegistry.installGlobal(registry);
	const agentDir = path.join(tempDir.path(), "agent");
	const root = await createAgentRootSession(registry, {
		agentId: "Main",
		cwd,
		agentDir,
		settings: Settings.isolated(),
	});
	const authority = bindInternalAgentAuthoritySession(registry, root.session);
	if (!authority) {
		await root.session.dispose();
		throw new Error("Test fixture requires parent authority");
	}
	return { registry, root: root.session, create: authority.create };
}

function makeModelRegistry(authStorage: AuthStorage, modelsPath: string, model: MockModel): ModelRegistry {
	const registry = new ModelRegistry(authStorage, modelsPath);
	vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	vi.spyOn(registry, "getAvailableForProviders").mockReturnValue([model]);
	vi.spyOn(registry, "getAll").mockReturnValue([model]);
	vi.spyOn(registry, "find").mockImplementation((provider, id) =>
		provider === model.provider && id === model.id ? model : undefined,
	);
	return registry;
}

async function releaseFixtureAgent(registry: AgentRegistry | undefined, id: string): Promise<void> {
	if (!registry) return;
	try {
		const ref = registry.get(id);
		if (ref) await releaseAgent(getAgentLifecycleManager(registry), id, ref);
	} catch {
		// Cleanup must not replace the test's assertion failure, including synchronous ownership errors.
	}
}

async function runFollowUp(
	eventBus: EventBus,
	agentRegistry: AgentRegistry,
	lifecycle: AgentLifecycleManager,
	agent: AgentDefinition,
	id: string,
	artifactsDir: string,
	structured = true,
): Promise<void> {
	const session = await ensureAgentLive(lifecycle, id);
	// Direct follow-ups own their monitor; the autonomous wake observer must not consume this turn.
	session.setIrcWakeTurnObserver(undefined);
	const statuses: string[] = [];
	const unsubscribe = eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
		if (!payload || typeof payload !== "object") return;
		const frame = payload as { id?: unknown; status?: unknown };
		if (frame.id === id && typeof frame.status === "string") statuses.push(frame.status);
	});
	try {
		const result = await runSubagentFollowUpTurn({
			id,
			agent,
			message: "Continue with the next follow-up.",
			structured,
			agentRegistry,
			agentLifecycle: lifecycle,
			subagentEventBus: eventBus,
			artifactsDir,
		});
		expect(result.exitCode).toBe(0);
		expect(statuses).toContain("completed");
	} finally {
		unsubscribe();
	}
}

beforeEach(() => {
	resetAgentLifecycleForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	resetAgentLifecycleForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
});

describe("seance artifact lifecycle", () => {
	it("publishes the latest warm and cold yield beside sibling results", async () => {
		using tempDir = TempDir.createSync("@omp-seance-artifact-lifecycle-");
		const cwd = path.join(tempDir.path(), "project");
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const artifactsDir = sourceFile.slice(0, -".jsonl".length);
		await fs.mkdir(cwd, { recursive: true });

		const timestamp = "2026-10-01T00:00:00.000Z";
		const sourceEntries = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "host-session",
				timestamp,
				cwd,
			},
			{
				type: "session_init",
				id: "host-init",
				parentId: null,
				timestamp,
				systemPrompt: ["host-only startup contract"],
				task: "host task",
				tools: ["read"],
				agent: "task",
				spawns: "*",
			},
			{
				type: "message",
				id: "host-message",
				parentId: "host-init",
				timestamp,
				message: { role: "user", content: "historical request", timestamp: 1 },
			},
		];
		const sourceText = `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await Bun.write(sourceFile, sourceText);

		const mock = createMockModel({
			provider: "mock",
			id: "seance-artifact-lifecycle",
			responses: [
				{ content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: "initial answer" } } }] },
				{ content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: "warm answer" } } }] },
				{ content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: "cold answer" } } }] },
			],
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const settings = Settings.isolated({
			// Disable implicit idle parking; this fixture exercises explicit warm/cold transitions.
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const eventBus = new EventBus();
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		let cleanupRegistry: AgentRegistry | undefined;
		let authorityRoot: AgentSession | undefined;
		try {
			const rootAuthority = await createDurableRootAuthority(tempDir, cwd);
			const agentRegistry = rootAuthority.registry;
			cleanupRegistry = agentRegistry;
			let lifecycle = getAgentLifecycleManager(agentRegistry);
			authorityRoot = rootAuthority.root;
			const permissionSnapshot = freezePermissionScope({
				mode: "enforce",
				toolsEnabled: true,
				pathsEnabled: true,
				actorId: AGENT_ID,
				actorKind: "sub",
				parentId: "Main",
				profiles: [],
				denyTools: [],
				allowPaths: [],
				denyPaths: [],
				provenance: { source: "builtin", profileNames: [], profiles: [] },
			});
			const result = await runSubprocess({
				cwd,
				agent,
				task: "Consult the current host session.",
				assignment: "Read the saved context and submit a result.",
				index: 0,
				id: AGENT_ID,
				settings,
				modelRegistry,
				authStorage,
				getApiKey: async () => "test-key",
				modelOverride: [`${mock.model.provider}/${mock.model.id}`],
				preparedSession: preparedSession(sourceFile, "host-session"),
				artifactsDir,
				enableIrc: false,
				enableLsp: false,
				enableMCP: false,
				parentAgentId: "Main",
				permissionScope: permissionSnapshot.scope,
				permissionSnapshot,
				agentRegistry,
				subagentEventBus: eventBus,
				createAuthoritySession: rootAuthority.create,
			});
			expect(result.exitCode).toBe(0);

			const publishedPath = path.join(artifactsDir, `${AGENT_ID}.md`);
			expect(result.outputPath).toBe(publishedPath);
			expect(AgentRegistry.global().get(AGENT_ID)?.history?.outputPath).toBe(publishedPath);
			expect(await Bun.file(publishedPath).text()).toContain("initial answer");

			const liveSession = await ensureAgentLive(lifecycle, AGENT_ID);
			expect(liveSession).toBeDefined();
			await runFollowUp(eventBus, agentRegistry, lifecycle, agent, AGENT_ID, artifactsDir);
			expect(await Bun.file(publishedPath).text()).toContain("warm answer");

			await parkAgent(lifecycle, AGENT_ID);
			resetAgentLifecycleForTests();
			lifecycle = getAgentLifecycleManager(agentRegistry);
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: authorityRoot!,
				agentRegistry,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				enableMCP: false,
				subagentEventBus: eventBus,
			});
			setPersistedAgentReviverFactory(lifecycle, reviveFactory, 0);
			await runFollowUp(eventBus, agentRegistry, lifecycle, agent, AGENT_ID, artifactsDir);

			expect(await Bun.file(publishedPath).text()).toContain("cold answer");
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			await releaseFixtureAgent(cleanupRegistry, AGENT_ID);
			try {
				await authorityRoot?.dispose();
			} finally {
				try {
					AgentStorage.close();
				} finally {
					try {
						authStorage.close();
					} finally {
						setAgentDir(previousAgentDir);
					}
				}
			}
		}
	});

	it("preserves an unstructured seance result contract through fresh, warm, and cold turns", async () => {
		using tempDir = TempDir.createSync("@omp-seance-unstructured-lifecycle-");
		const cwd = path.join(tempDir.path(), "project");
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const artifactsDir = sourceFile.slice(0, -".jsonl".length);
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });

		const timestamp = "2026-10-01T00:00:00.000Z";
		const sourceEntries = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "unstructured-host",
				timestamp,
				cwd,
			},
			{
				type: "session_init",
				id: "host-init",
				parentId: null,
				timestamp,
				systemPrompt: ["host-only startup contract"],
				task: "host task",
				tools: ["read"],
				agent: "task",
				spawns: "*",
			},
			{
				type: "message",
				id: "host-message",
				parentId: "host-init",
				timestamp,
				message: { role: "user", content: "historical request", timestamp: 1 },
			},
		];
		const sourceText = `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
		await Bun.write(sourceFile, sourceText);

		const mock = createMockModel({
			provider: "mock",
			id: "seance-unstructured-lifecycle",
			responses: [{ content: ["Initial unstructured answer"] }],
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const settings = Settings.isolated({
			// Disable implicit idle parking; this fixture exercises explicit warm/cold transitions.
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const eventBus = new EventBus();
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		let cleanupRegistry: AgentRegistry | undefined;
		let authorityRoot: AgentSession | undefined;
		try {
			const rootAuthority = await createDurableRootAuthority(tempDir, cwd);
			const agentRegistry = rootAuthority.registry;
			cleanupRegistry = agentRegistry;
			let lifecycle = getAgentLifecycleManager(agentRegistry);
			authorityRoot = rootAuthority.root;
			const permissionSnapshot = freezePermissionScope({
				mode: "enforce",
				toolsEnabled: true,
				pathsEnabled: true,
				actorId: UNSTRUCTURED_AGENT_ID,
				actorKind: "sub",
				parentId: "Main",
				profiles: [],
				denyTools: [],
				allowPaths: [],
				denyPaths: [],
				provenance: { source: "builtin", profileNames: [], profiles: [] },
			});
			const result = await runSubprocess({
				cwd,
				agent,
				task: "Consult the current host session.",
				assignment: "Read the saved context and submit a final message.",
				index: 0,
				id: UNSTRUCTURED_AGENT_ID,
				settings,
				modelRegistry,
				authStorage,
				getApiKey: async () => "test-key",
				modelOverride: [`${mock.model.provider}/${mock.model.id}`],
				preparedSession: preparedSession(sourceFile, "unstructured-host"),
				artifactsDir,
				enableIrc: false,
				enableLsp: false,
				enableMCP: false,
				parentAgentId: "Main",
				permissionScope: permissionSnapshot.scope,
				permissionSnapshot,
				structured: false,
				agentRegistry,
				subagentEventBus: eventBus,
				createAuthoritySession: rootAuthority.create,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Initial unstructured answer");

			const childSessionFile = path.join(artifactsDir, `${UNSTRUCTURED_AGENT_ID}.jsonl`);
			const publishedPath = path.join(artifactsDir, `${UNSTRUCTURED_AGENT_ID}.md`);
			const persisted = await SessionManager.peekSessionInit(childSessionFile);
			expect(persisted?.init?.tools).not.toContain("yield");
			expect(await Bun.file(publishedPath).text()).toContain("Initial unstructured answer");

			const liveSession = await ensureAgentLive(lifecycle, UNSTRUCTURED_AGENT_ID);
			expect(liveSession).toBeDefined();
			expect(liveSession.getActiveToolNames()).not.toContain("yield");
			mock.push({ content: ["Warm unstructured answer"] });
			await runFollowUp(eventBus, agentRegistry, lifecycle, agent, UNSTRUCTURED_AGENT_ID, artifactsDir, false);
			expect(await Bun.file(publishedPath).text()).toContain("Warm unstructured answer");

			await parkAgent(lifecycle, UNSTRUCTURED_AGENT_ID);
			resetAgentLifecycleForTests();
			lifecycle = getAgentLifecycleManager(agentRegistry);
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: authorityRoot!,
				agentRegistry,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				enableMCP: false,
				subagentEventBus: eventBus,
			});
			setPersistedAgentReviverFactory(lifecycle, reviveFactory, 0);
			const coldSession = await ensureAgentLive(lifecycle, UNSTRUCTURED_AGENT_ID);
			expect(coldSession.getActiveToolNames()).not.toContain("yield");
			mock.push({ content: ["Cold unstructured answer"] });
			await runFollowUp(eventBus, agentRegistry, lifecycle, agent, UNSTRUCTURED_AGENT_ID, artifactsDir, false);
			expect(await Bun.file(publishedPath).text()).toContain("Cold unstructured answer");
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			await releaseFixtureAgent(cleanupRegistry, UNSTRUCTURED_AGENT_ID);
			try {
				await authorityRoot?.dispose();
			} finally {
				try {
					AgentStorage.close();
				} finally {
					try {
						authStorage.close();
					} finally {
						setAgentDir(previousAgentDir);
					}
				}
			}
		}
	});

	it("allocates past the source's artifact ids and resolves inherited ids to the source, never another session", async () => {
		using tempDir = TempDir.createSync("@omp-seance-artifact-ids-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const sourceArtifacts = sourceFile.slice(0, -".jsonl".length);
		await Bun.write(
			sourceFile,
			`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "host", timestamp: "2026-10-01T00:00:00.000Z", cwd })}\n`,
		);
		const sourceArtifactsManager = new ArtifactManager(sourceArtifacts);
		const sourceArtifactIds: string[] = [];
		for (let index = 0; index < 5; index++) {
			sourceArtifactIds.push(await sourceArtifactsManager.save(`source artifact ${index}`, "read"));
		}
		const otherFile = path.join(tempDir.path(), "other", "other.jsonl");
		const otherArtifacts = otherFile.slice(0, -".jsonl".length);
		const otherArtifactId = await new ArtifactManager(otherArtifacts).save("other session only", "bash");
		expect(sourceArtifactIds).not.toContain(otherArtifactId);
		AgentRegistry.global().register({
			id: "OtherSession",
			displayName: "task",
			kind: "sub",
			sessionFile: otherFile,
			status: "parked",
			session: null,
		});
		const fork = await SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: path.join(sourceArtifacts, `${AGENT_ID}.jsonl`),
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		try {
			const forkArtifactId = await fork.saveArtifact("seance output", "bash");
			if (!forkArtifactId) throw new Error("Expected the seance fork to save an artifact");
			expect(sourceArtifactIds).not.toContain(forkArtifactId);
			const inheritedSourceArtifactId = sourceArtifactIds[0];
			if (!inheritedSourceArtifactId) throw new Error("Expected a source-owned artifact ID");
			const forkArtifactPath = await fork.getArtifactPath(forkArtifactId);
			if (!forkArtifactPath) throw new Error("Expected the fork artifact to have a published path");
			expect(await Bun.file(forkArtifactPath).text()).toBe("seance output");
			const toolSession: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => fork.getSessionFile() ?? null,
				getSessionSpawns: () => "",
				getArtifactsDir: () => fork.getArtifactsDir(),
				settings: Settings.isolated(),
				seanceSourceArtifactsDir: fork.getSeanceSourceArtifactsDir() ?? undefined,
			};
			const context = sessionResolveContext(toolSession);
			const router = InternalUrlRouter.instance();

			expect((await router.resolve(`artifact://${inheritedSourceArtifactId}`, context)).content).toBe(
				"source artifact 0",
			);
			await expect(router.resolve(`artifact://${otherArtifactId}`, context)).rejects.toThrow(
				`Artifact ${otherArtifactId} not found`,
			);
			expect((await router.resolve(`artifact://${otherArtifactId}`)).content).toBe("other session only");
		} finally {
			await fork.close();
		}
	});

	it("leaves only each seance's transcript and result in a repeatedly consulted host's artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-seance-repeat-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "sessions", "host.jsonl");
		const artifactsDir = sourceFile.slice(0, -".jsonl".length);
		await Bun.write(
			sourceFile,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "host",
					timestamp: "2026-10-01T00:00:00.000Z",
					cwd,
				},
				{
					type: "message",
					id: "host-message",
					parentId: null,
					timestamp: "2026-10-01T00:00:01.000Z",
					message: { role: "user", content: "historical request", timestamp: 1 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const hostArtifactId = await new ArtifactManager(artifactsDir).save("host artifact bytes", "read");

		const seanceIds = ["SeanceRepeatOne", "SeanceRepeatTwo"];
		const mock = createMockModel({
			provider: "mock",
			id: "seance-repeat",
			responses: seanceIds.map(id => ({
				content: [{ type: "toolCall", name: "yield", arguments: { data: { answer: id } } }],
			})),
		});
		registerMockApi(MOCK_API_SOURCE);
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(mock.model.provider, "test-key");
		const modelRegistry = makeModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), mock.model);
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		let cleanupRegistry: AgentRegistry | undefined;
		let authorityRoot: AgentSession | undefined;
		try {
			const rootAuthority = await createDurableRootAuthority(tempDir, cwd);
			const agentRegistry = rootAuthority.registry;
			cleanupRegistry = agentRegistry;
			authorityRoot = rootAuthority.root;
			for (const id of seanceIds) {
				const result = await runSubprocess({
					cwd,
					agent,
					task: "Consult the current host session.",
					assignment: "Read the saved context and submit a result.",
					index: 0,
					id,
					settings,
					modelRegistry,
					authStorage,
					getApiKey: async () => "test-key",
					modelOverride: [`${mock.model.provider}/${mock.model.id}`],
					preparedSession: preparedSession(sourceFile, "host"),
					artifactsDir,
					enableLsp: false,
					enableMCP: false,
					parentAgentId: "Main",
					agentRegistry,
					createAuthoritySession: rootAuthority.create,
				});
				expect(result.exitCode).toBe(0);
			}

			const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: artifactsDir }), file =>
				file.replaceAll("\\", "/"),
			);
			const outputLogs = files.filter(file => /^\d+\.agent-output\.log$/.test(file));
			expect(outputLogs).toHaveLength(seanceIds.length);
			expect(new Set(outputLogs).size).toBe(seanceIds.length);
			expect(files.toSorted()).toEqual(
				[
					`${hostArtifactId}.read.log`,
					...outputLogs,
					...seanceIds.flatMap(id => [`${id}.jsonl`, `${id}.md`]),
				].toSorted(),
			);
			const outputContents = await Promise.all(
				outputLogs.map(file => Bun.file(path.join(artifactsDir, file)).text()),
			);
			for (const id of seanceIds) {
				expect(outputContents.filter(content => content.includes(id))).toHaveLength(1);
				expect(await Bun.file(path.join(artifactsDir, `${id}.md`)).text()).toContain(id);
			}
		} finally {
			for (const id of seanceIds) await releaseFixtureAgent(cleanupRegistry, id);
			try {
				await authorityRoot?.dispose();
			} finally {
				try {
					AgentStorage.close();
				} finally {
					try {
						authStorage.close();
					} finally {
						setAgentDir(previousAgentDir);
					}
				}
			}
		}
	});
});
