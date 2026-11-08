/**
 * Cold revival of a persisted subagent under the permission scope it was spawned with (design 4 and
 * 7, step 18; P5). The child's `session_init` snapshot must match the hash its parent recorded at
 * spawn, still name the same actor, parent and profiles, use profiles whose files did not change,
 * and be no broader than the scope its parent runs under now. A revived child is then rebuilt as the
 * spawn built it: the scope in its settings, its tools cut, and no extension or custom-tool code.
 *
 * Ports the fork's persisted-revive permission tests; the fork returned no reviver on a refusal,
 * the port throws a refusal that says why and what to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	createPersistedSubagentReviverFactory,
	type PersistedReviveSpec,
	revivePersistedSubagent,
} from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { composeEffectivePermissions } from "@oh-my-pi/pi-coding-agent/task/permissions/compose";
import { activePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/guard";
import { loadPermissionProfiles } from "@oh-my-pi/pi-coding-agent/task/permissions/profiles";
import { recordPermissionBinding } from "@oh-my-pi/pi-coding-agent/task/permissions/revival";
import { cfgTaskPermissionsActiveScope } from "@oh-my-pi/pi-coding-agent/task/permissions/settings";
import { encodePermissionScope, freezePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import { permissionSessionInitFields } from "@oh-my-pi/pi-coding-agent/task/permissions/spawn";
import type { PermissionScope, TaskPermissionRequest } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../../helpers/session-defaults";
import v1FixtureJson from "./fixtures/v1-permission-snapshots.json" with { type: "json" };
import { enforceScope } from "./scope-fixtures";

const CHILD = "Persisted";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-permission-revive-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "work");
	await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	setAgentDir(agentDir);
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	__resetDirsFromEnvForTests();
	await fs.rm(root, { recursive: true, force: true });
});

async function writeJson(file: string, value: unknown): Promise<void> {
	await Bun.write(file, typeof value === "string" ? value : JSON.stringify(value));
}

const projectProfiles = (profiles: Record<string, unknown>) =>
	writeJson(path.join(cwd, ".omp", "permissions.json"), { profiles });
const localProfiles = (value: unknown) => writeJson(path.join(cwd, ".omp", "permissions.local.json"), value);
const userProfiles = (profiles: Record<string, unknown>) =>
	writeJson(path.join(agentDir, "permissions.json"), { profiles });

function assistantMessage(manager: SessionManager): void {
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
}

/** A parent transcript on disk, registered under `id` as a parked agent. */
class Parent {
	readonly manager: SessionManager;
	readonly file: string;

	constructor(
		readonly id: string,
		options: { parentId?: string; init?: Parameters<SessionManager["appendSessionInit"]>[0] } = {},
	) {
		this.manager = SessionManager.create(cwd, path.join(agentDir, "sessions", id));
		const file = this.manager.getSessionFile();
		if (!file) throw new Error("Expected a parent session file");
		this.file = file;
		if (options.init) this.manager.appendSessionInit(options.init);
		assistantMessage(this.manager);
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: id === "Main" ? "main" : "sub",
			parentId: options.parentId,
			session: null,
			sessionFile: file,
			status: id === "Main" ? "running" : "parked",
		});
	}

	bind(agentId: string, scope: PermissionScope): void {
		recordPermissionBinding(this.manager, agentId, scope);
	}

	async close(): Promise<void> {
		await this.manager.close();
	}
}

/** Compose the scope a spawn under `enforce` gives a child of `parentId` for `request`. */
async function composeChild(
	request: TaskPermissionRequest,
	options: { actorId?: string; parentId?: string; inherited?: PermissionScope } = {},
): Promise<PermissionScope> {
	const loaded = await loadPermissionProfiles(cwd, { agentDir });
	const composed = composeEffectivePermissions({
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: options.actorId ?? CHILD,
		actorKind: "sub",
		parentId: options.parentId ?? "Main",
		request,
		inherited: options.inherited,
		profiles: loaded.profiles,
		profileIdentities: loaded.profileIdentities,
	});
	if (!composed.ok) throw new Error(composed.error);
	return composed.value;
}

interface ChildOptions {
	readonly id?: string;
	readonly scope?: PermissionScope;
	readonly requested?: string[];
	/** Write the profile fields but no snapshot. */
	readonly omitSnapshot?: boolean;
	/** Write neither the snapshot nor the profile fields, as a child that stripped its provenance would. */
	readonly omitProvenance?: boolean;
	/** Persist this raw snapshot instead of the scope's own. */
	readonly snapshot?: unknown;
	/** Persist these effective profiles instead of the scope's own. */
	readonly effective?: string[];
	readonly tools?: string[];
}

async function persistChild(options: ChildOptions = {}): Promise<string> {
	const id = options.id ?? CHILD;
	const manager = SessionManager.create(cwd, path.join(agentDir, "sessions", "children", id));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a child session file");
	const fields = options.scope ? permissionSessionInitFields(options.scope, options.requested) : undefined;
	manager.appendSessionInit({
		systemPrompt: ["persisted prompt"],
		task: "persisted task",
		tools: options.tools ?? ["read", "write", "yield"],
		...(fields && !options.omitProvenance
			? {
					requestedPermissionProfiles: fields.requestedPermissionProfiles,
					effectivePermissionProfiles: options.effective ?? fields.effectivePermissionProfiles,
					...(options.omitSnapshot
						? {}
						: { permissionSnapshot: (options.snapshot ?? fields.permissionSnapshot) as never }),
				}
			: {}),
	});
	assistantMessage(manager);
	await manager.close();
	return sessionFile;
}

function childRef(sessionFile: string, id = CHILD, parentId = "Main"): AgentRef {
	return {
		id,
		displayName: id,
		kind: "sub",
		parentId,
		status: "parked",
		session: null,
		sessionFile,
		generation: 0,
		createdAt: 0,
		lastActivity: 0,
	};
}

function revivedSession(): AgentSession {
	return {
		...createSessionDefaults(),
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async () => {},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		setIrcWakeTurnObserver: () => {},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		getLastAssistantMessage: () => undefined,
	} as unknown as AgentSession;
}

/** Every `createAgentSession` call a revival makes. */
function captureSessions(): CreateAgentSessionOptions[] {
	const captured: CreateAgentSessionOptions[] = [];
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (options) captured.push(options);
		return { session: revivedSession() } as CreateAgentSessionResult;
	});
	return captured;
}

const parentExtension: PreparedExtension = {
	path: "/parent/.omp/extensions/audit.ts",
	resolvedPath: "/parent/.omp/extensions/audit.ts",
	factory: () => {},
	error: null,
};

function rootSession(): AgentSession {
	return {
		sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		preparedExtensions: [parentExtension],
		getSessionAgents: () => [],
		getAgentId: () => "Main",
	} as unknown as AgentSession;
}

function factory(settings = Settings.isolated()) {
	return createPersistedSubagentReviverFactory({
		session: rootSession(),
		authStorage: {} as never,
		modelRegistry: { authStorage: {} } as unknown as ModelRegistry,
		settings,
		enableLsp: true,
	});
}

async function revive(ref: AgentRef, settings?: Settings): Promise<void> {
	const reviver = await factory(settings)(ref);
	if (!reviver) throw new Error("Expected a persisted reviver");
	await reviver(ref);
}

function restoredScope(options: CreateAgentSessionOptions | undefined): PermissionScope | undefined {
	if (!options?.settings) throw new Error("the revival created no session");
	const active = activePermissionScope(options.settings);
	if (active && !active.ok) throw new Error(active.error);
	return active?.scope as PermissionScope | undefined;
}

describe("cold revival restores the recorded permission scope", () => {
	it("restores the complete frozen permission scope and exact profile provenance", async () => {
		await projectProfiles({ narrow: { tools: ["read"], allowPaths: ["src/**"] } });
		const parent = new Parent("Main");
		const scope = await composeChild({ profiles: ["narrow"] });
		parent.bind(CHILD, scope);
		const ref = childRef(await persistChild({ scope, requested: ["narrow"] }));
		const captured = captureSessions();

		await revive(ref);

		const restored = restoredScope(captured[0]);
		expect(captured[0]?.settings?.getProvenance(cfgTaskPermissionsActiveScope)).toBe("runtime");
		expect(restored).toEqual(scope);
		expect(restored?.profiles).toEqual(["narrow"]);
		expect(restored?.provenance.profiles[0]?.source).toBe("project");
		expect(restored?.allowPathGroups).toEqual([["src/**"]]);
		await parent.close();
	});

	it("rebuilds the child as its spawn did: tools cut to the scope, no MCP, extensions or custom tools", async () => {
		const parent = new Parent("Main");
		const scope = await composeChild({ tools: ["read"] });
		parent.bind(CHILD, scope);
		const ref = childRef(await persistChild({ scope, tools: ["read", "write", "bash", "yield"] }));
		const captured = captureSessions();

		await revive(ref);

		const options = captured[0];
		expect(options?.toolNames).toEqual(["read", "yield"]);
		expect(options?.restrictToolNames).toBe(true);
		expect(options?.requireYieldTool).toBe(true);
		expect(options?.enableMCP).toBe(false);
		expect(options?.preloadedPreparedExtensions).toEqual([]);
		expect(options?.preloadedExtensionPaths).toEqual([]);
		expect(options?.preloadedCustomToolPaths).toEqual([]);
		await parent.close();
	});

	it("keeps upstream's revival for a transcript with no permission fields and no parent record", async () => {
		const parent = new Parent("Main");
		const ref = childRef(await persistChild({ tools: ["read", "write", "yield"] }));
		const captured = captureSessions();

		await revive(ref);

		expect(restoredScope(captured[0])).toBeUndefined();
		expect(captured[0]?.toolNames).toEqual(["read", "write", "yield"]);
		expect(captured[0]?.preloadedPreparedExtensions).toEqual([parentExtension]);
		await parent.close();
	});

	it("restores a suggest scope without narrowing the child", async () => {
		const parent = new Parent("Main");
		const scope = { ...(await composeChild({ tools: ["read"] })), mode: "suggest" as const };
		parent.bind(CHILD, scope);
		const ref = childRef(await persistChild({ scope }));
		const captured = captureSessions();

		await revive(ref);

		expect(restoredScope(captured[0])?.mode).toBe("suggest");
		expect(captured[0]?.toolNames).toEqual(["read", "write", "yield"]);
		expect(captured[0]?.preloadedPreparedExtensions).toEqual([parentExtension]);
		await parent.close();
	});

	it("revives a fork-era v1 child and its parent's v1 scope, which carry no parent record", async () => {
		const fixture = v1FixtureJson;
		await writeJson(path.join(agentDir, "permissions.json"), fixture.userPermissionsFile);
		const parentSnapshot = fixture.snapshots.parent.snapshot;
		const childSnapshot = fixture.snapshots.child.snapshot;
		const main = new Parent("Main");
		const parent = new Parent(childSnapshot.scope.parentId, {
			parentId: "Main",
			init: {
				systemPrompt: ["fork parent"],
				task: "fork parent task",
				tools: ["read", "grep", "yield"],
				effectivePermissionProfiles: parentSnapshot.scope.profiles,
				permissionSnapshot: parentSnapshot,
			},
		});
		await parent.close();
		const ref = childRef(
			await persistChild({
				id: childSnapshot.scope.actorId,
				scope: enforceScope(),
				snapshot: childSnapshot,
				effective: childSnapshot.scope.profiles,
			}),
			childSnapshot.scope.actorId,
			childSnapshot.scope.parentId,
		);
		const captured = captureSessions();

		await revive(ref);

		const restored = restoredScope(captured[0]);
		expect(restored?.actorId).toBe(childSnapshot.scope.actorId);
		expect(restored?.inherited).toBe(true);
		expect(restored?.tools).toEqual(childSnapshot.scope.tools);
		expect(captured[0]?.restrictToolNames).toBe(true);
		await main.close();
	});
});

describe("cold revival refuses a scope it cannot verify", () => {
	it("rejects missing permission provenance and changed profile content", async () => {
		await projectProfiles({ narrow: { tools: ["read"] } });
		const parent = new Parent("Main");
		const scope = await composeChild({ profiles: ["narrow"] });
		captureSessions();

		// Profile fields without the snapshot they describe.
		const missingSnapshot = childRef(await persistChild({ scope, requested: ["narrow"], omitSnapshot: true }));
		await expect(revive(missingSnapshot)).rejects.toThrow(
			`Cannot revive subagent "${CHILD}": its session_init lists permission profiles but holds no permission snapshot. The agent was not revived. Start a fresh subagent`,
		);

		// A child that stripped all of its provenance, while its parent recorded a scope for it.
		parent.bind(CHILD, scope);
		const stripped = childRef(await persistChild({ scope, omitProvenance: true }));
		await expect(revive(stripped)).rejects.toThrow(
			"its parent recorded a permission scope for it, but its transcript holds none",
		);

		const changed = childRef(await persistChild({ scope, requested: ["narrow"] }));
		await projectProfiles({ narrow: { tools: ["write"] } });
		const refusal = revive(changed);
		await expect(refusal).rejects.toThrow('permission profile "narrow" changed since the subagent was spawned');
		await expect(refusal).rejects.toThrow("Restore the permission profile file");
		await parent.close();
	});

	it("revives unchanged user-level and project profiles while a user-level file is present", async () => {
		await userProfiles({ "user-narrow": { tools: ["read"], allowPaths: ["src/**"] } });
		await projectProfiles({ narrow: { tools: ["read"] } });
		const parent = new Parent("Main");
		const userScope = await composeChild({ profiles: ["user-narrow"] }, { actorId: "UserChild" });
		const projectScope = await composeChild({ profiles: ["narrow"] }, { actorId: "ProjectChild" });
		parent.bind("UserChild", userScope);
		parent.bind("ProjectChild", projectScope);
		const userRef = childRef(await persistChild({ id: "UserChild", scope: userScope }), "UserChild");
		const projectRef = childRef(await persistChild({ id: "ProjectChild", scope: projectScope }), "ProjectChild");
		const captured = captureSessions();

		await revive(userRef);
		await revive(projectRef);

		const restored = captured.flatMap(options =>
			(restoredScope(options)?.provenance.profiles ?? []).map(identity => `${identity.name}:${identity.source}`),
		);
		expect(restored.sort()).toEqual(["narrow:project", "user-narrow:user"]);
		await parent.close();
	});

	it("revives despite a reserved-name conflict in the user-level file", async () => {
		await projectProfiles({ narrow: { tools: ["read"] } });
		const parent = new Parent("Main");
		const scope = await composeChild({ profiles: ["narrow"] });
		parent.bind(CHILD, scope);
		const ref = childRef(await persistChild({ scope }));
		// Rejected and never applied, so every profile the snapshot uses still resolves as it did.
		await userProfiles({ "no-network": { tools: ["browser"] } });
		const captured = captureSessions();

		await revive(ref);

		expect(restoredScope(captured[0])?.profiles).toEqual(["narrow"]);
		await parent.close();
	});

	it("refuses revival when a higher-precedence file breaks a profile the snapshot uses", async () => {
		// The project file keeps defining both profiles correctly; only the local file breaks.
		await projectProfiles({ narrow: { tools: ["read"] }, other: { tools: ["read"] } });
		const parent = new Parent("Main");
		const narrowScope = await composeChild({ profiles: ["narrow"] }, { actorId: "NarrowChild" });
		const otherScope = await composeChild({ profiles: ["other"] }, { actorId: "OtherChild" });
		parent.bind("NarrowChild", narrowScope);
		parent.bind("OtherChild", otherScope);
		const narrowRef = childRef(await persistChild({ id: "NarrowChild", scope: narrowScope }), "NarrowChild");
		const otherRef = childRef(await persistChild({ id: "OtherChild", scope: otherScope }), "OtherChild");
		captureSessions();
		const invalidNarrowOverride = { profiles: { narrow: { tools: ["read"], denyPath: ["x"] } } };

		await localProfiles(invalidNarrowOverride);
		await expect(revive(narrowRef)).rejects.toThrow('permission profile "narrow" no longer exists');

		// Unparseable: it may have overridden any name, so nothing can be verified.
		await localProfiles("{ not json");
		await expect(revive(otherRef)).rejects.toThrow("a permission profile file could not be read");

		await localProfiles(invalidNarrowOverride);
		await revive(otherRef);
		await parent.close();
	});

	it("rejects a user-level profile that was edited or moved into the project file", async () => {
		const original = { tools: ["read"] };
		await userProfiles({ "user-narrow": original });
		const parent = new Parent("Main");
		const editedScope = await composeChild({ profiles: ["user-narrow"] }, { actorId: "Edited" });
		const movedScope = await composeChild({ profiles: ["user-narrow"] }, { actorId: "Moved" });
		parent.bind("Edited", editedScope);
		parent.bind("Moved", movedScope);
		const editedRef = childRef(await persistChild({ id: "Edited", scope: editedScope }), "Edited");
		const movedRef = childRef(await persistChild({ id: "Moved", scope: movedScope }), "Moved");
		captureSessions();

		await userProfiles({ "user-narrow": { tools: ["write"] } });
		await expect(revive(editedRef)).rejects.toThrow('permission profile "user-narrow" changed');

		// Identical content now owned by the project file: the source half of the identity changed.
		await userProfiles({});
		await projectProfiles({ "user-narrow": original });
		await expect(revive(movedRef)).rejects.toThrow('permission profile "user-narrow" moved from user to project');
		await parent.close();
	});

	it("rejects persisted actor, parent, and nested provenance drift", async () => {
		await projectProfiles({ narrow: { tools: ["read"] } });
		const parent = new Parent("Main");
		const scope = await composeChild({ profiles: ["narrow"] });
		captureSessions();
		const forgeries: Array<[PermissionScope, string]> = [
			[{ ...scope, actorId: "unrelated" }, 'was made for agent "unrelated" under "Main", not for this agent'],
			[{ ...scope, parentId: "unrelated" }, `was made for agent "${CHILD}" under "unrelated", not for this agent`],
			[
				{ ...scope, provenance: { profiles: [] } },
				"its recorded permission profiles disagree with its permission snapshot",
			],
		];
		for (const [forged, reason] of forgeries) {
			// Even a parent record that matches the forged scope does not make it this child's.
			parent.bind(CHILD, forged);
			const ref = childRef(await persistChild({ scope: forged }));
			await expect(revive(ref)).rejects.toThrow(reason);
		}

		// A nested edit without a new hash does not verify.
		parent.bind(CHILD, scope);
		const tampered = structuredClone(freezePermissionScope(scope)) as unknown as {
			scope: { provenance: { profiles: Array<{ source: string }> } };
		};
		tampered.scope.provenance.profiles[0]!.source = "local";
		const ref = childRef(await persistChild({ scope, snapshot: tampered }));
		await expect(revive(ref)).rejects.toThrow("its permission snapshot does not verify");
		await parent.close();
	});

	it("refuses a snapshot its parent has no record of, or one that differs from the record", async () => {
		const parent = new Parent("Main");
		const scope = await composeChild({ tools: ["read"] });
		captureSessions();

		const unrecorded = childRef(await persistChild({ scope }));
		await expect(revive(unrecorded)).rejects.toThrow(
			"its parent has no record of the permission scope it was spawned with",
		);

		// The child widened its own snapshot and re-hashed it; the parent's record still has the spawn's hash.
		parent.bind(CHILD, scope);
		const widened = childRef(await persistChild({ scope: { ...scope, tools: ["read", "write"] } }));
		await expect(revive(widened)).rejects.toThrow(
			"its permission snapshot does not match the scope its parent recorded when it spawned it",
		);
		await parent.close();
	});

	it("refuses when the parent's transcript cannot be read", async () => {
		const scope = await composeChild({ tools: ["read"] });
		captureSessions();
		const ref = childRef(await persistChild({ scope }));

		await expect(revive(ref)).rejects.toThrow('its parent "Main" has no transcript to check the scope against');
	});
});

describe("cold revival rechecks the parent's scope", () => {
	it("rechecks live parent scope when an already-prepared reviver is invoked", async () => {
		const parent = new Parent("Main");
		const scope = await composeChild({ tools: ["read", "grep"] });
		parent.bind(CHILD, scope);
		const ref = childRef(await persistChild({ scope }));
		captureSessions();
		const rootSettings = Settings.isolated();
		const reviver = await factory(rootSettings)(ref);
		if (!reviver) throw new Error("Expected prepared revival");

		// The root now runs under a narrower scope than the child's.
		rootSettings.writeValue(
			cfgTaskPermissionsActiveScope,
			encodePermissionScope(enforceScope({ actorId: "Main", actorKind: "main", parentId: undefined, tools: [] })),
			"override",
		);
		await expect(reviver(ref)).rejects.toThrow(
			"it would revive with a broader permission scope than its parent now runs under",
		);
		await parent.close();
	});

	it("refuses an unscoped child of a restricted parent", async () => {
		const parentScope = enforceScope({ actorId: "Scoped", tools: ["read"] });
		const main = new Parent("Main");
		const parent = new Parent("Scoped", {
			parentId: "Main",
			init: { systemPrompt: ["p"], task: "p", tools: ["read"], ...permissionSessionInitFields(parentScope, []) },
		});
		await parent.close();
		const ref = childRef(await persistChild({ id: "Scoped.Child" }), "Scoped.Child", "Scoped");
		captureSessions();

		await expect(revive(ref)).rejects.toThrow(
			"it would revive with a broader permission scope than its parent now runs under",
		);
		await main.close();
	});

	it("refuses an inherited scope once its parent no longer runs under one", async () => {
		const main = new Parent("Main");
		const parent = new Parent("Scoped", { parentId: "Main" });
		const inherited = enforceScope({ actorId: "Scoped", tools: ["read", "grep"] });
		const scope = await composeChild({}, { actorId: "Scoped.Child", parentId: "Scoped", inherited });
		parent.bind("Scoped.Child", scope);
		await parent.close();
		const ref = childRef(await persistChild({ id: "Scoped.Child", scope }), "Scoped.Child", "Scoped");
		captureSessions();

		await expect(revive(ref)).rejects.toThrow(
			"it inherited its parent's permission scope, but its parent no longer runs under one",
		);
		await main.close();
	});

	it("revives a child no broader than its live restricted parent", async () => {
		const main = new Parent("Main");
		const parentScope = enforceScope({ actorId: "Scoped", tools: ["read", "grep"] });
		const parent = new Parent("Scoped", { parentId: "Main" });
		const scope = await composeChild(
			{ tools: ["read"] },
			{ actorId: "Scoped.Child", parentId: "Scoped", inherited: parentScope },
		);
		parent.bind("Scoped.Child", scope);
		await parent.close();
		// The parent is live: its settings carry the scope its spawn wrote.
		const parentRef = AgentRegistry.global().get("Scoped");
		if (!parentRef) throw new Error("Expected the parent ref");
		parentRef.session = {
			settings: Settings.isolated({ [cfgTaskPermissionsActiveScope.id]: encodePermissionScope(parentScope) }),
		} as never;
		const ref = childRef(await persistChild({ id: "Scoped.Child", scope }), "Scoped.Child", "Scoped");
		const captured = captureSessions();

		await revive(ref);

		expect(restoredScope(captured[0])?.tools).toEqual(["read"]);
		await main.close();
	});
});

describe("revivePersistedSubagent", () => {
	it("refuses a transcript whose snapshot changed after the revival was checked", async () => {
		const parent = new Parent("Main");
		const scope = await composeChild({ tools: ["read"] });
		const sessionFile = await persistChild({ scope: { ...scope, tools: ["read", "write"] } });
		captureSessions();
		const spec = {
			id: CHILD,
			displayName: CHILD,
			parentId: "Main",
			sessionFile,
			taskDepth: 1,
			restoredSeance: undefined,
			root: rootSession(),
			rootAgentId: "Main",
			costGate: undefined,
			asyncJobManager: undefined,
			artifactManager: undefined,
			preparedExtensions: [parentExtension],
			authStorage: {} as never,
			modelRegistry: { authStorage: {} } as unknown as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: true,
			eventBus: undefined,
			subagentEventBus: undefined,
			permissionScope: scope,
			permissionSnapshotHash: freezePermissionScope(scope).canonicalSha256,
		} as unknown as PersistedReviveSpec;

		await expect(revivePersistedSubagent(spec, childRef(sessionFile))).rejects.toThrow(
			"its permission snapshot changed while the revival was being checked",
		);
		await parent.close();
	});
});
