import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelRoleAlias } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	adoptAgent,
	disposeAgentLifecycle,
	getAgentLifecycleManager,
	parkAgent,
	resetAgentLifecycleForTests,
	setPersistedAgentReviverFactory,
} from "../../src/internal/agent-lifecycle-bridge";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
	setAgentStatus,
} from "../../src/internal/agent-registry-bridge";
import { getSessionLocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import { installSessionOperationLedger } from "@oh-my-pi/pi-coding-agent/registry/operation-lease";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import {
	buildEffectivePermissionSummary,
	composeEffectivePermissions,
	freezePermissionScope,
	loadPermissionProfiles,
	type PermissionScopeSnapshot,
} from "@oh-my-pi/pi-coding-agent/task/permission-profiles";
import { createMCPProxyTools, createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { EffectivePermissionSummary, PermissionDenialDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";

const tempDirs: TempDir[] = [];
let fixtureRegistry: AgentRegistry | undefined;

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

interface FixtureOptions {
	enableMCP?: boolean;
	mcpManager?: MCPManager;
}

async function createRef(sessionFile: string, options: FixtureOptions = {}): Promise<AgentRef> {
	if (!fixtureRegistry) {
		fixtureRegistry = new AgentRegistry({ durableState: registryDurableStateForSession(sessionFile) });
		AgentRegistry.installGlobal(fixtureRegistry);
	}
	const registry = fixtureRegistry;
	let parentSession = lookupAgentRef(registry, "Main")?.session ?? null;
	if (!parentSession) parentSession = (await createAgentRootSession(registry, { agentId: "Main" })).session;
	const peek = await SessionManager.peekSessionInit(sessionFile);
	if (!peek?.init) throw new Error("Expected a persisted authority fixture");
	const init = peek.init;
	const permissionSnapshot = init.permissionSnapshot
		? freezePermissionScope(init.permissionSnapshot.scope)
		: undefined;
	const id = `persisted-${path.basename(sessionFile, ".jsonl")}`;
	const settings = Settings.isolated();
	const subagentSettings = createSubagentSettings(
		settings,
		init.advisor
			? {
					"advisor.enabled": true,
					...(init.advisor !== "on"
						? { modelRoles: { ...settings.getModelRoles(), advisor: init.advisor } }
						: undefined),
				}
			: undefined,
		undefined,
		{ cwd: peek.cwd, agentDir: settings.getAgentDir() },
	);
	const persistedModelPattern =
		init.modelRole && init.modelRole !== "default"
			? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
			: init.resolvedModel;
	const restrictToolNames = init.restrictToolNames === true;
	const revivedToolNames =
		init.readOnly === true && init.tools.includes("write") ? init.tools.filter(name => name !== "write") : init.tools;
	const enableMCP = !restrictToolNames && (init.enableMCP ?? true) && (options.enableMCP ?? true);
	const mcpManager = enableMCP ? options.mcpManager : undefined;
	const customTools = mcpManager ? createMCPProxyTools(mcpManager) : [];
	const authorityBinding = bindInternalAgentAuthoritySession(registry, parentSession);
	if (!authorityBinding) throw new Error("Expected bound Main authority fixture");
	const reopened = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
	try {
		const { session } = await authorityBinding.create({
			cwd: peek.cwd,
			agentDir: subagentSettings.getAgentDir(),
			authStorage: {} as never,
			modelRegistry: { authStorage: {} } as ModelRegistry,
			...(persistedModelPattern ? { modelPattern: persistedModelPattern } : {}),
			modelPatternAuthFallback: init.resolvedModel,
			sessionManager: reopened,
			localProtocolOptions: getSessionLocalProtocolOptions(parentSession.sessionManager),
			agentId: id,
			agentDisplayName: "Persisted Restricted",
			agentName:
				init.agent &&
				init.agent.trim().toLowerCase() !== MAIN_AGENT_RULE_NAME &&
				init.agent.trim().toLowerCase() !== SUB_AGENT_RULE_NAME
					? init.agent
					: "Persisted Restricted",
			parentTaskPrefix: id,
			taskDepth: 1,
			toolNames: revivedToolNames,
			outputSchema: init.outputSchema,
			outputSchemaMode: init.outputSchemaMode,
			restrictToolNames: restrictToolNames || undefined,
			permissionScope: permissionSnapshot?.scope,
			requireYieldTool: true,
			systemPrompt: () => [init.systemPrompt],
			spawns: init.spawns ?? "",
			hasUI: false,
			enableLsp: restrictToolNames ? false : true,
			enableIrc: restrictToolNames ? false : undefined,
			enableMCP,
			...(mcpManager ? { mcpManager, customTools: customTools.length > 0 ? customTools : undefined } : {}),
		});
		if (!setAgentStatus(registry, id, "idle", session)) throw new Error("Expected live child authority fixture");
		const lifecycle = getAgentLifecycleManager(registry);
		adoptAgent(lifecycle, id, { idleTtlMs: 0 }, session);
		await parkAgent(lifecycle, id);
	} finally {
		await reopened.close();
	}
	const getTools = mcpManager?.getTools;
	if (getTools && "mockClear" in getTools && typeof getTools.mockClear === "function") getTools.mockClear();
	const ref = registry.get(id);
	if (!ref || ref.status !== "parked") throw new Error("Expected parked child authority fixture");
	return ref;
}

type IrcWakeObserver = (records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface RevivedSessionHandle {
	session: AgentSession;
	observer: () => IrcWakeObserver | undefined;
	/** Reply obligations the wake monitor registered via `trackIrcReply`. */
	trackedReplies: Promise<void>[];
	/** Text the stubbed session reports as its last assistant message. */
	setLastAssistantText: (text: string) => void;
}

function createRevivedSession(
	activeToolNames: string[][],
	extensionRunner?: unknown,
	sessionManager = SessionManager.inMemory("/tmp"),
): RevivedSessionHandle {
	installSessionOperationLedger(sessionManager);
	let observer: IrcWakeObserver | undefined;
	let lastAssistantText: string | undefined;
	const trackedReplies: Promise<void>[] = [];
	const session = {
		...createSessionDefaults(),
		sessionManager,
		getPermissionSummary: () => sessionManager.getLatestPermissionSummary(),
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		setIrcWakeTurnObserver: (next: IrcWakeObserver | undefined) => {
			observer = next;
		},
		trackIrcReply: (pending: Promise<void>) => {
			trackedReplies.push(pending);
		},
		getLastAssistantMessage: () =>
			lastAssistantText === undefined
				? undefined
				: { role: "assistant", content: [{ type: "text", text: lastAssistantText }], stopReason: "stop" },
		extensionRunner,
	} as unknown as AgentSession;
	return {
		session,
		observer: () => observer,
		trackedReplies,
		setLastAssistantText: text => {
			lastAssistantText = text;
		},
	};
}

async function createPersistedSession(
	cwd: string,
	restrictToolNames?: boolean,
	modelRole?: string,
	advisor?: string,
	contract?: {
		tools?: string[];
		readOnly?: boolean;
		agent?: string;
		enableMCP?: boolean;
		permissionProfile?: string;
		omitPermissionProvenance?: boolean;
		omitPermissionSnapshot?: boolean;
		recentDenials?: PermissionDenialDetails[];
	},
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const loaded = await loadPermissionProfiles(cwd);
	const actorId = `persisted-${path.basename(sessionFile, ".jsonl")}`;
	const requestedProfiles = contract?.permissionProfile ? [contract.permissionProfile] : [];
	const composed = composeEffectivePermissions({
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId,
		actorKind: "sub",
		parentId: "Main",
		...(requestedProfiles.length > 0 ? { request: { profiles: requestedProfiles } } : {}),
		profiles: loaded.profiles,
		profileIdentities: loaded.profileIdentities,
	});
	if (!composed.ok) throw new Error(composed.error);
	const persistedPermissions: {
		requestedPermissionProfiles: string[];
		effectivePermissionProfiles: string[];
		permissionSnapshot?: PermissionScopeSnapshot;
		permissionSummary: EffectivePermissionSummary;
	} = {
		requestedPermissionProfiles: requestedProfiles,
		effectivePermissionProfiles: [...composed.value.profiles],
		...(contract?.omitPermissionSnapshot
			? {}
			: {
					permissionSnapshot: freezePermissionScope(
						contract?.omitPermissionProvenance ? { ...composed.value, provenance: undefined } : composed.value,
					),
				}),
		permissionSummary: buildEffectivePermissionSummary(composed.value, contract?.recentDenials),
	};
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: contract?.tools ?? ["read", "yield"],
		restrictToolNames,
		modelRole,
		resolvedModel: modelRole ? "anthropic/claude-sonnet-4-5" : undefined,
		advisor,
		readOnly: contract?.readOnly,
		agent: contract?.agent,
		enableMCP: contract?.enableMCP,
		...persistedPermissions,
	});
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
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
	await manager.close();
	return sessionFile;
}

function createFactory(cwd: string, subagentEventBus?: EventBus, options: FixtureOptions = {}) {
	return async (ref: AgentRef) => {
		const registry = fixtureRegistry;
		if (!registry) throw new Error("Expected an installed persisted revival registry fixture");
		let parentSession = lookupAgentRef(registry, "Main")?.session ?? null;
		if (!parentSession) {
			parentSession = (await createAgentRootSession(registry, { agentId: "Main" })).session;
		}
		return createPersistedSubagentReviverFactory({
			session: parentSession,
			authStorage: {} as never,
			modelRegistry: { authStorage: {} } as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: true,
			enableMCP: options.enableMCP ?? true,
			mcpManager: options.mcpManager,
			subagentEventBus,
			agentRegistry: registry,
		})(ref);
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	if (fixtureRegistry && AgentRegistry.global() !== fixtureRegistry) AgentRegistry.installGlobal(fixtureRegistry);
	resetAgentLifecycleForTests();
	AgentRegistry.resetGlobalForTests();
	fixtureRegistry = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("persisted subagent revival", () => {
	it("restores a parked persisted child after root restart and delivers one Hub message", async () => {
		const cwd = makeTempDir("@pi-revive-hub-restart-");
		const delivered: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const handle = createRevivedSession([], undefined, options?.sessionManager);
			handle.session.deliverIrcMessage = async message => {
				delivered.push(message.body);
				return "woken";
			};
			return { session: handle.session } as CreateAgentSessionResult;
		});
		const childSessionFile = await createPersistedSession(cwd);
		fixtureRegistry = new AgentRegistry({ durableState: registryDurableStateForSession(childSessionFile) });
		AgentRegistry.installGlobal(fixtureRegistry);
		const initialRootManager = SessionManager.create(cwd, path.join(cwd, "roots"));
		await initialRootManager.ensureOnDisk();
		const initialRootFile = initialRootManager.getSessionFile();
		if (!initialRootFile) throw new Error("Expected persisted root fixture");
		const { session: initialRoot } = await createAgentRootSession(fixtureRegistry, {
			agentId: MAIN_AGENT_ID,
			sessionManager: initialRootManager,
		});
		const initialRef = await createRef(childSessionFile);
		await disposeAgentLifecycle(getAgentLifecycleManager(fixtureRegistry));
		await initialRoot.dispose();
		await initialRootManager.close();

		AgentRegistry.resetGlobalForTests();
		const registry = new AgentRegistry({ durableState: registryDurableStateForSession(childSessionFile) });
		fixtureRegistry = registry;
		AgentRegistry.installGlobal(registry);
		const resumedRootManager = await SessionManager.open(initialRootFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		const { session: root } = await createAgentRootSession(registry, {
			agentId: MAIN_AGENT_ID,
			sessionManager: resumedRootManager,
		});
		const ref = registry.register({
			id: initialRef.id,
			displayName: initialRef.displayName,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: childSessionFile,
			status: "parked",
		});
		setPersistedAgentReviverFactory(
			getAgentLifecycleManager(registry),
			createPersistedSubagentReviverFactory({
				session: root,
				authStorage: {} as never,
				modelRegistry: { authStorage: {} } as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: true,
				enableMCP: true,
				agentRegistry: registry,
			}),
			0,
		);

		const receipt = await IrcBus.forRoot(registry, MAIN_AGENT_ID).send({
			from: MAIN_AGENT_ID,
			to: ref.id,
			body: "resume wake",
		});

		expect(receipt).toEqual({ to: ref.id, outcome: "revived" });
		expect(delivered).toEqual(["resume wake"]);
		await resumedRootManager.close();
	});

	it("revives a persisted child despite non-authoritative startup input drift", async () => {
		const cwd = makeTempDir("@pi-revive-startup-inputs-");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: createRevivedSession([], undefined, options?.sessionManager).session,
				}) as CreateAgentSessionResult,
		);
		const sessionFile = await createPersistedSession(cwd, false, "default", undefined, { agent: "task" });
		const id = `persisted-${path.basename(sessionFile, ".jsonl")}`;
		fixtureRegistry = new AgentRegistry({ durableState: registryDurableStateForSession(sessionFile) });
		AgentRegistry.installGlobal(fixtureRegistry);
		const { session: root } = await createAgentRootSession(fixtureRegistry, { agentId: MAIN_AGENT_ID });
		const authorityBinding = bindInternalAgentAuthoritySession(fixtureRegistry, root);
		if (!authorityBinding) throw new Error("Expected bound Main authority fixture");
		const peek = await SessionManager.peekSessionInit(sessionFile);
		if (!peek?.init?.permissionSnapshot) throw new Error("Expected persisted authority fixture");
		const reopened = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
		try {
			const { session } = await authorityBinding.create({
				cwd: peek.cwd,
				agentDir: Settings.isolated().getAgentDir(),
				authStorage: {} as never,
				modelRegistry: { authStorage: {} } as ModelRegistry,
				model: { provider: "pi", id: "smol" } as never,
				thinkingLevel: "high" as never,
				thinkingLevelCeiling: "high" as never,
				contextFiles: [{ path: "AGENTS.md", content: "runtime" }],
				skills: [] as never,
				promptTemplates: [] as never,
				workspaceTree: {} as never,
				rules: [] as never,
				prewalk: {} as never,
				sessionManager: reopened,
				localProtocolOptions: getSessionLocalProtocolOptions(root.sessionManager),
				agentId: id,
				agentDisplayName: "SmokeWorker",
				agentName: "task",
				parentTaskPrefix: id,
				taskDepth: 1,
				toolNames: peek.init.tools,
				restrictToolNames: false,
				permissionScope: peek.init.permissionSnapshot.scope,
				requireYieldTool: true,
				spawns: peek.init.spawns ?? "",
				hasUI: false,
				enableLsp: true,
				enableIrc: true,
				enableMCP: true,
			});
			if (!setAgentStatus(fixtureRegistry, id, "idle", session))
				throw new Error("Expected live child authority fixture");
			const lifecycle = getAgentLifecycleManager(fixtureRegistry);
			adoptAgent(lifecycle, id, { idleTtlMs: 0 }, session);
			await parkAgent(lifecycle, id);
		} finally {
			await reopened.close();
		}
		const ref = fixtureRegistry.get(id);
		if (!ref || ref.status !== "parked") throw new Error("Expected parked persisted child");
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);
	});

	it("rejects persisted actor, parent, and nested provenance drift", async () => {
		const cwd = makeTempDir("@pi-revive-identity-drift-");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: createRevivedSession([], undefined, options?.sessionManager).session,
				}) as CreateAgentSessionResult,
		);
		for (const field of ["actorId", "parentId", "provenance"] as const) {
			const sessionFile = await createPersistedSession(cwd);
			const ref = await createRef(sessionFile);
			const records = (await fs.readFile(sessionFile, "utf8"))
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line));
			const init = records.find(record => record.type === "session_init");
			if (!init?.permissionSnapshot) throw new Error("Expected persisted permission snapshot");
			if (field === "provenance") {
				init.permissionSnapshot.scope.provenance.source = "local";
			} else {
				init.permissionSnapshot.scope[field] = "unrelated";
				init.permissionSnapshot = freezePermissionScope(init.permissionSnapshot.scope);
			}
			await fs.writeFile(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
			expect(await createFactory(cwd)(ref)).toBeUndefined();
		}
	});

	it("rechecks live parent scope when an already-prepared reviver is invoked", async () => {
		const cwd = makeTempDir("@pi-revive-live-parent-drift-");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: createRevivedSession([], undefined, options?.sessionManager).session,
				}) as CreateAgentSessionResult,
		);
		const ref = await createRef(await createPersistedSession(cwd));
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected prepared revival");
		const parent = lookupAgentRef(AgentRegistry.global(), "Main")?.session;
		if (!parent) throw new Error("Expected live parent");
		const narrowed = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "Main",
			actorKind: "main",
			request: { tools: [] },
			profiles: {},
		});
		if (!narrowed.ok) throw new Error(narrowed.error);
		parent.getPermissionScope = () => narrowed.value;
		await expect(reviver(ref)).rejects.toThrow("parent authority changed");
	});

	it("initializes the extension runtime on cold revival so tool_call handlers are not fail-closed blocked", async () => {
		const cwd = makeTempDir("@pi-revive-ext-init-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		const initialize = vi.fn();
		const onError = vi.fn();
		const emit = vi.fn(async () => undefined);
		const extensionRunner = { initialize, onError, emit };
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: createRevivedSession([], extensionRunner, options?.sessionManager).session,
				}) as CreateAgentSessionResult,
		);

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(initialize).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith({ type: "session_start" });
	});

	it("cold-revives a restricted contract without loading hostile same-name capabilities", async () => {
		const cwd = makeTempDir("@pi-restricted-revive-");
		const sessionFile = await createPersistedSession(cwd, true);
		const hostileMcpGetTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileMcpGetTools } as unknown as MCPManager);
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession(activeToolNames, undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBe(true);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.enableLsp).toBe(false);
		expect(capturedOptions?.enableIrc).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		for (const channel of [
			"preloadedExtensionPaths",
			"preloadedPreparedExtensions",
			"preloadedCustomToolPaths",
		] as const) {
			expect(Object.hasOwn(capturedOptions ?? {}, channel)).toBe(false);
		}
		expect(hostileMcpGetTools).not.toHaveBeenCalled();
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("strips synthetic write from legacy read-only cold revival", async () => {
		const cwd = makeTempDir("@pi-read-only-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: true,
		});
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession(activeToolNames, undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.toolNames).toEqual(["read", "yield"]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("preserves explicitly writable cold-revival contracts", async () => {
		const cwd = makeTempDir("@pi-write-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: false,
		});
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession(activeToolNames, undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.toolNames).toEqual(["read", "write", "yield"]);
		expect(activeToolNames).toEqual([["read", "write", "yield"]]);
	});

	it("derives restrictive startup features for a scoped legacy contract without using the process singleton", async () => {
		const cwd = makeTempDir("@pi-normal-revive-");
		const sessionFile = await createPersistedSession(cwd);
		const hostileGetTools = vi.fn(() => [{ name: "mcp__hostile_read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileGetTools } as unknown as MCPManager);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBe(false);
		expect(capturedOptions?.enableLsp).toBe(false);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(Object.hasOwn(capturedOptions ?? {}, "mcpManager")).toBe(false);
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(hostileGetTools).not.toHaveBeenCalled();
	});

	it("does not restore a persisted MCP grant when its effective scope is restricted", async () => {
		const cwd = makeTempDir("@pi-enabled-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { enableMCP: true });
		const getTools = vi.fn(() => [{ name: "mcp__server_read", label: "server/read" }]);
		const sessionMcp = { getTools } as unknown as MCPManager;
		const factoryOptions = { enableMCP: true, mcpManager: sessionMcp };
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile, factoryOptions);
		const reviver = await createFactory(cwd, undefined, factoryOptions)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(getTools).not.toHaveBeenCalled();
	});

	it("does not fill an absent session-owned manager when scope policy disables MCP", async () => {
		const cwd = makeTempDir("@pi-enabled-child-discovery-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { enableMCP: true });
		const hostileGetTools = vi.fn(() => [{ name: "mcp__hostile_read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileGetTools } as unknown as MCPManager);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, { enableMCP: true })(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.enableMCP).toBe(false);
		expect(Object.hasOwn(capturedOptions ?? {}, "mcpManager")).toBe(false);
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(hostileGetTools).not.toHaveBeenCalled();
	});

	it("does not restore a persisted MCP grant when the current root session disables MCP", async () => {
		const cwd = makeTempDir("@pi-disabled-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { enableMCP: true });
		const getTools = vi.fn(() => [{ name: "mcp__server_read", label: "server/read" }]);
		const factoryOptions = { enableMCP: false, mcpManager: { getTools } as unknown as MCPManager };
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile, factoryOptions);
		const reviver = await createFactory(cwd, undefined, factoryOptions)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.enableMCP).toBe(false);
		expect(Object.hasOwn(capturedOptions ?? {}, "mcpManager")).toBe(false);
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(getTools).not.toHaveBeenCalled();
	});

	it("restores the persisted agent definition name on cold revival so agent-scoped rules keep matching", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "scout" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// `ref.displayName` is the registry's generated label ("Persisted
		// Restricted") for a cold-revived ref, not the durable agent definition
		// name. `agents: [scout]` rule scoping must key on the latter.
		expect(capturedOptions?.agentName).toBe("scout");
	});

	it("falls back to the ref display name reviving a legacy session file without a persisted agent name", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-legacy-");
		const sessionFile = await createPersistedSession(cwd);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.agentName).toBe(ref.displayName);
	});
	it("treats a persisted legacy 'main'-named subagent as scoped to the ref display name, not the top-level sentinel", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-legacy-main-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "main" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// A parked transcript from before "main" was reserved as a definition
		// name could still carry `init.agent === "main"`. That must not resolve
		// to the top-level sentinel here, or `agents: [main]` rules documented
		// as top-level-only would load into this subagent.
		expect(capturedOptions?.agentName).toBe(ref.displayName);
		expect(capturedOptions?.agentName).not.toBe("main");
	});
	it("treats a persisted legacy 'sub'-named subagent as scoped to the ref display name, not the shared sub sentinel", async () => {
		const cwd = makeTempDir("@pi-revive-agent-name-legacy-sub-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, { agent: "sub" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// A parked transcript from before "sub" was reserved as a definition
		// name could still carry `init.agent === "sub"`. That must not resolve
		// to the shared subagent-fallback sentinel here, or `agents: [sub]`
		// rules meant for that specific legacy definition would load into every
		// unnamed subagent session.
		expect(capturedOptions?.agentName).toBe(ref.displayName);
		expect(capturedOptions?.agentName).not.toBe("sub");
	});

	it("restores the persisted per-agent advisor opt-in on cold revival", async () => {
		const cwd = makeTempDir("@pi-advisor-revive-");
		const advisedFile = await createPersistedSession(cwd, undefined, undefined, "moonshot/k3");
		const roleAdvisedFile = await createPersistedSession(cwd, undefined, undefined, "on");
		const unadvisedFile = await createPersistedSession(cwd);
		const captured: Settings[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (options?.settings) captured.push(options.settings);
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const factory = createFactory(cwd);
		for (const sessionFile of [advisedFile, roleAdvisedFile, unadvisedFile]) {
			const ref = await createRef(sessionFile);
			const reviver = await factory(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
		}

		const [advised, roleAdvised, unadvised] = captured;
		expect(advised.get("advisor.enabled")).toBe(true);
		expect(advised.getModelRole("advisor")).toBe("moonshot/k3");
		expect(roleAdvised.get("advisor.enabled")).toBe(true);
		expect(roleAdvised.getModelRole("advisor")).toBeUndefined();
		expect(unadvised.get("advisor.enabled")).toBe(false);
	});

	it("restores the persisted custom model role before reopening the session", async () => {
		const cwd = makeTempDir("@pi-custom-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "review-fast");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toEqual(["@review-fast", "anthropic/claude-sonnet-4-5"]);
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("pins the persisted concrete model when the default role is revived", async () => {
		const cwd = makeTempDir("@pi-default-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toBe("anthropic/claude-sonnet-4-5");
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
		AgentRegistry.resetGlobalForTests();
		resetAgentLifecycleForTests();
		const cwd = makeTempDir("@pi-revive-frames-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			handle = createRevivedSession([], undefined, options?.sessionManager);
			return { session: handle.session } as CreateAgentSessionResult;
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const terminal = Promise.withResolvers<void>();
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") terminal.resolve();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd, eventBus)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "resume after resume",
			display: true,
			details: { id: "irc-1", from: "Main", message: "resume after resume" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer?.([record]);
		await finish?.();
		await terminal.promise;

		expect(frames[0]).toMatchObject({
			type: "subagent_lifecycle",
			payload: { id: ref.id, status: "started" },
		});
		const last = frames.at(-1);
		expect(last?.type).toBe("subagent_lifecycle");
		if (last?.type !== "subagent_lifecycle") throw new Error("expected terminal lifecycle frame");
		expect(last.payload.id).toBe(ref.id);
		expect(last.payload.status).not.toBe("started");
		rpcRegistry.dispose();
		resetAgentLifecycleForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("preserves the completed output artifact when a revived subagent answers a hub message without yielding", async () => {
		AgentRegistry.resetGlobalForTests();
		resetAgentLifecycleForTests();
		const cwd = makeTempDir("@pi-revive-artifact-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			handle = createRevivedSession([], undefined, options?.sessionManager);
			return { session: handle.session } as CreateAgentSessionResult;
		});

		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// The completed first run already wrote its report to <artifactsDir>/<id>.md
		// (artifactsDir = parent sessionFile sans ".jsonl"; see createFactory).
		const artifactPath = path.join(cwd, "parent", `${ref.id}.md`);
		const completedReport = "# Completed report\n\nfull multi-paragraph body\n\nZZEND";
		await Bun.write(artifactPath, completedReport);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "thanks",
			display: true,
			details: { id: "irc-1", from: "Main", message: "thanks" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		// A wake turn answering a hub message never calls yield; finalization must
		// not clobber the authoritative completion artifact with a warning body.
		const finish = observer?.([record]);
		await finish?.();

		expect(await Bun.file(artifactPath).text()).toBe(completedReport);
		resetAgentLifecycleForTests();
		AgentRegistry.resetGlobalForTests();
	});

	describe("wake-turn relay", () => {
		async function reviveWithWaker(
			cwd: string,
		): Promise<{ ref: AgentRef; handle: RevivedSessionHandle; bus: IrcBus }> {
			AgentRegistry.resetGlobalForTests();
			resetAgentLifecycleForTests();
			IrcBus.resetGlobalForTests();
			const sessionFile = await createPersistedSession(cwd);
			MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
			let handle: RevivedSessionHandle | undefined;
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				handle = createRevivedSession([], undefined, options?.sessionManager);
				return { session: handle.session } as CreateAgentSessionResult;
			});
			const ref = await createRef(sessionFile);
			const reviver = await createFactory(cwd)(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
			if (!handle) throw new Error("Expected a revived session");
			const rootId = ref.lineage?.rootId;
			if (!rootId || !fixtureRegistry) throw new Error("Expected a root-scoped persisted authority fixture");
			return { ref, handle, bus: IrcBus.forRoot(fixtureRegistry, rootId) };
		}

		const wakeRecord = (from: string): CustomMessage => ({
			role: "custom",
			customType: "irc:incoming",
			content: "send me the full table",
			display: true,
			details: { id: "irc-42", from, message: "send me the full table" },
			attribution: "agent",
			timestamp: Date.now(),
		});

		it("delivers the turn's final text to the waker when the agent never replied itself", async () => {
			// A read-only scout has no `hub` tool: without the relay its answer to a
			// wake message is stranded in its own transcript.
			const cwd = makeTempDir("@pi-revive-relay-");
			const { ref, handle, bus } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const finish = observer?.([wakeRecord("Main")]);
			handle.setLastAssistantText("# Full table\n\n| tool | file |\n|---|---|\n| read | read.ts |");
			const reply = bus.wait("Main", { from: ref.id }, 5000);
			await finish?.();
			expect(handle.trackedReplies).toHaveLength(1);
			await handle.trackedReplies[0];

			const delivered = await reply;
			expect(delivered).toMatchObject({
				from: ref.id,
				to: "Main",
				replyTo: "irc-42",
				body: "# Full table\n\n| tool | file |\n|---|---|\n| read | read.ts |",
			});
			const duplicate = bus.wait("Main", { from: ref.id }, 200);
			expect(await duplicate).toBeNull();
			resetAgentLifecycleForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});

		it("stays silent when the agent already answered its waker during the turn", async () => {
			const cwd = makeTempDir("@pi-revive-relay-answered-");
			const { ref, handle, bus } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			const finish = observer?.([wakeRecord("Main")]);
			const answered = bus.wait("Main", { from: ref.id }, 5000);
			await bus.send({ from: ref.id, to: "Main", body: "here you go" });
			expect((await answered)?.body).toBe("here you go");
			handle.setLastAssistantText("Sent the table via hub.");
			const duplicate = bus.wait("Main", { from: ref.id }, 200);
			await finish?.();
			await handle.trackedReplies[0];

			expect(await duplicate).toBeNull();
			resetAgentLifecycleForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});
		it("never relays a wake turn woken by another relay", async () => {
			// Two idle subagents exchanging one message used to ping-pong forever:
			// each relay woke the peer, whose stop-text was relayed straight back.
			// Relay messages are answers, not wake sources, so the echo stops here.
			const cwd = makeTempDir("@pi-revive-relay-echo-");
			const { handle } = await reviveWithWaker(cwd);
			const observer = handle.observer();
			expect(observer).toBeDefined();

			// A live peer captures whatever the turn relays instead of a null
			// `bus.wait`: fully deterministic, no timer dependence.
			const delivered: IrcMessage[] = [];
			AgentRegistry.global().register({
				id: "Peer",
				displayName: "Peer",
				kind: "sub",
				status: "idle",
				session: {
					deliverIrcMessage: async (msg: IrcMessage) => {
						delivered.push(msg);
						return "injected" as const;
					},
				} as unknown as AgentSession,
			});
			const relayRecord: CustomMessage = {
				...wakeRecord("Peer"),
				details: { id: "irc-43", from: "Peer", message: "You hang up", wakeRelay: true },
			};
			const finish = observer?.([relayRecord]);
			handle.setLastAssistantText("No YOU hang up");
			await finish?.();
			await handle.trackedReplies[0];

			expect(delivered).toHaveLength(0);
			resetAgentLifecycleForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		});
	});
	it("restores the complete frozen permission scope and exact profile provenance", async () => {
		const cwd = makeTempDir("@pi-permission-revive-");
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".omp", "permissions.json"),
			JSON.stringify({ profiles: { narrow: { tools: ["read"], allowPaths: ["src/**"] } } }),
		);
		const denial: PermissionDenialDetails = {
			kind: "subagent_permission_denial",
			code: "path-not-allowed",
			tool: "read",
			targets: { items: [{ kind: "path", display: "outside/private.ts" }], omittedCount: 0 },
			matched: "subagent:path-allowlist",
			reason: "blocked",
		};
		const sessionFile = await createPersistedSession(cwd, true, undefined, undefined, {
			permissionProfile: "narrow",
			recentDenials: [denial],
		});
		let captured: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			captured = options;
			return {
				session: createRevivedSession([], undefined, options?.sessionManager).session,
			} as CreateAgentSessionResult;
		});
		const ref = await createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected exact permission revival");
		await reviver(ref);
		expect(captured?.permissionScope?.profiles).toEqual(["narrow"]);
		expect(captured?.permissionScope?.provenance?.profiles[0]?.source).toBe("project");
		expect(captured?.permissionScope?.allowPathGroups).toEqual([["src/**"]]);
		expect(Object.isFrozen(captured?.permissionScope)).toBe(true);
		expect(Object.isFrozen(captured?.permissionScope?.allowPathGroups?.[0])).toBe(true);
		expect(Object.isFrozen(captured?.permissionScope?.provenance?.profiles[0])).toBe(true);
		expect(fixtureRegistry?.get(ref.id)?.history?.permissionSummary?.profiles.items).toEqual(["narrow"]);
		expect(fixtureRegistry?.get(ref.id)?.history?.permissionSummary?.recentDenials.items).toEqual([denial]);
	});

	it("rejects missing permission provenance and changed profile content", async () => {
		const cwd = makeTempDir("@pi-permission-drift-");
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		const profileFile = path.join(cwd, ".omp", "permissions.json");
		await fs.writeFile(profileFile, JSON.stringify({ profiles: { narrow: { tools: ["read"] } } }));
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: createRevivedSession([], undefined, options?.sessionManager).session,
				}) as CreateAgentSessionResult,
		);
		const missingProvenanceFile = await createPersistedSession(cwd, true, undefined, undefined, {
			permissionProfile: "narrow",
			omitPermissionProvenance: true,
		});
		const missingRef = await createRef(missingProvenanceFile);
		expect(await createFactory(cwd)(missingRef)).toBeUndefined();
		const missingSnapshotFile = await createPersistedSession(cwd, true, undefined, undefined, {
			permissionProfile: "narrow",
			omitPermissionSnapshot: true,
		});
		expect(await createFactory(cwd)(await createRef(missingSnapshotFile))).toBeUndefined();
		const changedFile = await createPersistedSession(cwd, true, undefined, undefined, {
			permissionProfile: "narrow",
		});
		const changedRef = await createRef(changedFile);
		await fs.writeFile(profileFile, JSON.stringify({ profiles: { narrow: { tools: ["write"] } } }));
		expect(await createFactory(cwd)(changedRef)).toBeUndefined();
	});
});
