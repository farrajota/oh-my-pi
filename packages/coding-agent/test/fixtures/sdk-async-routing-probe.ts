import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	disposeAgentLifecycle,
	ensureAgentLive,
	lookupOwnedAgentLifecycle,
} from "@oh-my-pi/pi-coding-agent/internal/agent-lifecycle-bridge";
import { bindInternalAgentAuthoritySession } from "../../src/internal/agent-registry-bridge";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const mode = process.argv[2] ?? "collision";
assert.ok(["single", "collision", "unique", "reload"].includes(mode));
const profileDir = getAgentDir();
await fs.mkdir(profileDir, { recursive: true });
const root = await fs.mkdtemp(path.join(profileDir, "repro-async-routing-"));
const cwd = path.join(root, "work");
await fs.mkdir(cwd);
const marker = "REPRO_B_WAKE_ONLY";
const childId = "ReproChildB";
const sessions: AgentSession[] = [];
const agentRegistries = new Map<AgentSession, AgentRegistry>();
const sessionSettings = new Map<AgentSession, Settings>();
const auth = await AuthStorage.create(":memory:");
auth.keys.setRuntime("mock", "repro-key");
registerMockApi("repro-sdk-async-routing");
const model = createMockModel({
	handler: context => {
		if (context.tools?.some(tool => tool.name === "yield")) {
			if (context.messages.at(-1)?.role === "toolResult") return { content: ["done"] };
			const correction = JSON.stringify(context.messages).includes(marker);
			return {
				content: [
					{
						type: "toolCall",
						name: "yield",
						arguments: {
							type: "result",
							data: correction ? marker : "initial child result",
						},
					},
				],
			};
		}
		if (context.tools?.some(tool => tool.name === "task") && context.messages.at(-1)?.role === "user") {
			return {
				content: [
					{
						type: "toolCall",
						name: "task",
						arguments: {
							context: "Return an initial result. Keep the child available for a correction turn.",
							tasks: [
								{
									name: childId,
									agent: "task",
									task: "Return initial child result.",
									solutionSpace: "Report only.",
								},
							],
						},
					},
				],
			};
		}
		return { content: ["acknowledged"] };
	},
});
const create = async (
	name: string,
	tools: string[],
	agentId?: string,
	sessionManager?: AgentSession["sessionManager"],
) => {
	const settings = Settings.isolated(
		{
			"async.enabled": true,
			"task.batch": true,
			"task.maxConcurrency": 1,
			"task.agentIdleTtlMs": 0,
			"task.completionProbe": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"autolearn.enabled": false,
			modelRoles: { default: "mock/mock-model" },
		},
		{ cwd, agentDir: profileDir },
	);
	const modelRegistry = new ModelRegistry(auth, path.join(root, "models.yml"), { settings });
	const find = modelRegistry.find.bind(modelRegistry);
	modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
	modelRegistry.getAvailable = () => [model];
	const rootSessionManager = sessionManager ?? SessionManager.create(cwd, path.join(root, `${name}-sessions`));
	await rootSessionManager.ensureOnDisk();
	const sessionFile = rootSessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Test fixture requires a persisted root transcript");
	const agentRegistry = new AgentRegistry({ durableState: registryDurableStateForSession(sessionFile) });
	const { session } = await agentRegistry.createIsolatedRootSession({
		cwd,
		agentDir: profileDir,
		authStorage: auth,
		modelRegistry,
		model,
		settings,
		agentRegistry,
		sessionManager: rootSessionManager,
		agentId,
		disableExtensionDiscovery: true,
		preloadedExtensionPaths: [],
		preloadedCustomToolPaths: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: true,
		skipPythonPreflight: true,
		cacheWarming: false,
		toolNames: tools,
		restrictToolNames: true,
	});
	sessions.push(session);
	agentRegistries.set(session, agentRegistry);
	sessionSettings.set(session, settings);
	console.log(name, { sessionId: session.sessionId, hasManager: !!session.asyncJobManager });
	return session;
};
const deadline = setTimeout(() => {
	console.error("REPRO_TIMEOUT");
	for (const session of sessions) void session.abort();
}, 30_000);
try {
	let a: AgentSession | undefined;
	if (mode !== "single") {
		a = await create("A", [], mode === "unique" ? "RootA" : undefined);
		await a.prompt("A: unrelated task");
		if (mode === "reload") {
			const sessionFile = a.sessionFile!;
			await a.dispose();
			a = await create("A reloaded", [], undefined, await SessionManager.open(sessionFile));
		}
	}
	const bRootId = mode === "unique" ? "RootB" : MAIN_AGENT_ID;
	const b = await create("B", ["task"], mode === "unique" ? bRootId : undefined);
	await b.prompt("B: launch child");
	if (b.asyncJobManager) {
		await b.asyncJobManager.waitForOwnerJobs(bRootId);
		await b.asyncJobManager.drainDeliveries({ filter: { ownerId: bRootId } });
		await b.waitForIdle();
	}
	const agentRegistry = agentRegistries.get(b);
	assert.ok(agentRegistry, "B's session did not retain its registry");
	const childRef = agentRegistry.get(childId);
	assert.ok(childRef, "B's task did not register a live child");
	const lifecycle = lookupOwnedAgentLifecycle(b);
	assert.ok(lifecycle, "B's session did not bind its lifecycle owner");
	console.log("child", {
		parentId: childRef.parentId,
		status: childRef.status,
	});
	assert.equal(childRef.status, "idle");
	const peerId = "ReproPeerB";
	const peerSettings = sessionSettings.get(b);
	assert.ok(peerSettings, "B's session did not retain its Settings context");
	const authority = bindInternalAgentAuthoritySession(agentRegistry, b);
	assert.ok(authority, "B's session did not retain its root authority");
	const peer = await authority.create({
		cwd,
		agentDir: profileDir,
		settings: peerSettings,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		agentId: peerId,
		agentDisplayName: peerId,
	});
	sessions.push(peer.session);
	const peerRef = agentRegistry.get(peerId);
	assert.ok(peerRef, "B's root authority did not register the peer sender");
	assert.equal(peerRef.lineage?.rootId, bRootId);
	assert.equal(peerRef.parentId, bRootId);
	assert.notEqual(peerRef.id, childId);
	const bus = IrcBus.forRoot(agentRegistry, bRootId);
	const receipt = await bus.send({ from: peerId, to: childId, body: marker });
	console.log("IRC", receipt);
	assert.equal(receipt.outcome, "woken");
	const childSession = await ensureAgentLive(lifecycle, childId);
	await childSession.waitForIdle();
	await childSession.waitForIrcReplies();
	const rootAsyncManager = b.asyncJobManager;
	assert.ok(rootAsyncManager, "B's root session did not retain its async job manager");
	const currentChildRef = agentRegistry.get(childId);
	assert.ok(currentChildRef, "B's task child was not registered after wake");
	assert.equal(currentChildRef.parentId, bRootId);
	assert.equal(childSession.asyncJobManager, rootAsyncManager);
	await rootAsyncManager.waitForOwnerJobs(bRootId);
	await rootAsyncManager.drainDeliveries({ filter: { ownerId: bRootId } });
	await a?.waitForIdle();
	await b.waitForIdle();
	for (const session of sessions) await session.sessionManager.flush();
	const count = (session: AgentSession | undefined) =>
		session?.sessionManager
			.getEntries()
			.filter(
				entry =>
					entry.type === "custom_message" &&
					entry.customType === "async-result" &&
					JSON.stringify(entry).includes(marker),
			).length ?? 0;
	const diskA = a ? await fs.readFile(a.sessionFile!, "utf8") : "";
	const diskB = await fs.readFile(b.sessionFile!, "utf8");
	const result = {
		mode,
		aAsyncResults: count(a),
		bAsyncResults: count(b),
		markerOnDiskA: diskA.includes(marker),
		markerOnDiskB: diskB.includes(marker),
	};
	console.log("RESULT", JSON.stringify(result));
	assert.equal(result.aAsyncResults, 0, "BUG: B's correction async-result was delivered into A");
	assert.equal(result.bAsyncResults, 1, "BUG: B did not receive its child's correction async-result");
	assert.equal(result.markerOnDiskA, false, "BUG: B's correction was persisted in A");
	assert.equal(result.markerOnDiskB, true, "BUG: B's correction was not persisted in B");
} finally {
	clearTimeout(deadline);
	for (let index = sessions.length - 1; index >= 0; index--) {
		const session = sessions[index];
		const lifecycle = session ? lookupOwnedAgentLifecycle(session) : undefined;
		if (lifecycle) await disposeAgentLifecycle(lifecycle);
	}
	for (let index = sessions.length - 1; index >= 0; index--) {
		const session = sessions[index];
		if (session) await session.dispose();
	}
	unregisterCustomApis("repro-sdk-async-routing");
	auth.close();
}
