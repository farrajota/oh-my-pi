import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	adoptAgent,
	disposeAgentLifecycle,
	ensureAgentLive,
	getAgentLifecycleManager,
	parkAgent,
	releaseAgent,
} from "../src/internal/agent-lifecycle-bridge";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../src/internal/agent-registry-bridge";
import {
	BROWSER_AUDIT_CORE_PACKAGE_IDENTITY,
	BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION,
	type BrowserAuditActor,
	type BrowserAuditAuthorization,
	type BrowserAuditDispatch,
	type BrowserAuditTuple,
} from "../src/tools/browser-audit";
import type { BrowserAuditBindingInput } from "../src/tools/browser-audit-production";
import {
	bindBrowserAuditRunOptions,
	bindBrowserAuditSessionOptions,
	bindRegisteredBrowserAuditTaskAuthority,
	takeBrowserAuditTaskAuthority,
	type BrowserAuditSpawnBindingIdentity,
} from "../src/internal/browser-audit-authority";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { AgentSession } from "../src/session/agent-session";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/sdk";
import * as executorModule from "../src/task/executor";
import type { AgentDefinition } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Keep custody IDs in a valid hexadecimal range disjoint from engine fixtures.
let auditSequence = 0x2_0000_0000_0000;

function binding(options: {
	spawnId: string;
	parentAgentId: string;
	definitionSha256: string;
	toolCallFingerprint: string;
}): BrowserAuditBindingInput {
	const actor: BrowserAuditActor = {
		actor_kind: "sub",
		actor_id: options.spawnId,
		parent_actor_id: options.parentAgentId,
	};
	const dispatch: BrowserAuditDispatch = {
		schema: "browser-audit-dispatch/v2",
		audit_id: `browser-audit-${(++auditSequence).toString(16).padStart(16, "0")}`,
		request_sha256: "a".repeat(64),
		task_sha256: "b".repeat(64),
		request_byte_count: 1,
		task_byte_count: 1,
		agent_source: "user",
		agent_logical_path: "agents/browser-audit-specialist.md",
		agent_definition_sha256: options.definitionSha256,
		tool_origin_class: "builtin",
		tool_implementation_revision: BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION,
		core_package_identity: BROWSER_AUDIT_CORE_PACKAGE_IDENTITY,
		expected_spawn_id: options.spawnId,
		expected_parent_actor_id: options.parentAgentId,
		tool_call_fingerprint: options.toolCallFingerprint,
	};
	const authorization: BrowserAuditAuthorization = {
		document_locators: ["https://example.test/audit"],
		origins: ["https://example.test"],
		route_states: [
			{
				route_state_id: "route",
				locator: "https://example.test/audit",
				state_assertions: [],
				allowed_action_ids: ["click"],
			},
		],
		viewports: [{ viewport_id: "viewport", width: 800, height: 600, device_scale_factor: 1 }],
		actions: [{ action_id: "click", kind: "click", target: "#approved", value: null, mutation: "none" }],
		mutation_policy: { mode: "deny", allowed_action_ids: [] },
		credential_policy: { mode: "deny-raw", pre_established_state_ids: [] },
		screenshot_policy: { mode: "deny", max_count: 0, max_bytes: 0, allowed_check_ids: [] },
		resource_policy: {
			mode: "allow-listed",
			allowed_origins: ["https://example.test"],
			allow_file_subresources: false,
		},
		protected_actions: [],
	};
	const tuples: readonly BrowserAuditTuple[] = [
		{ tuple_id: "check@route@viewport", check_id: "check", route_state_id: "route", viewport_id: "viewport" },
	];
	return { actor, dispatch, authorization, tuples, spawn_id: options.spawnId, file_document_authority: null };
}

function spawnIdentity(input: BrowserAuditBindingInput): BrowserAuditSpawnBindingIdentity {
	return {
		agentName: "browser-audit-specialist",
		agentSource: input.dispatch.agent_source,
		agentLogicalPath: input.dispatch.agent_logical_path,
		agentDefinitionSha256: input.dispatch.agent_definition_sha256,
		spawnId: input.spawn_id,
		parentAgentId: input.actor.parent_actor_id,
		toolCallFingerprint: input.dispatch.tool_call_fingerprint,
	};
}

function publicSessionOptions(
	cwd: string,
	authStorage: AuthStorage,
	modelRegistry: ModelRegistry,
	model: Model,
): CreateAgentSessionOptions {
	return {
		cwd,
		agentDir: cwd,
		authStorage,
		modelRegistry,
		model,
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(cwd),
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMCP: false,
		enableLsp: false,
		bindProcessState: false,
		toolNames: ["browser_audit"],
		restrictToolNames: true,
	};
}

describe("browser-audit session option custody", () => {
	it("registers one live capability through real executor, registry, SDK copies, and refuses revival", async () => {
		using temp = TempDir.createSync("@browser-audit-custody-");
		const authStorage = createInMemoryAuthStorage();
		const settings = Settings.isolated({ "task.agentIdleTtlMs": 0 });
		const modelsPath = path.join(temp.path(), "models.yml");
		// Exact executor selection needs registry availability, not just a bundled model.
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { openai: { baseUrl: "http://127.0.0.1:1/v1", auth: "none" } },
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, { settings });
		const model = modelRegistry.find("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected configured OpenAI model for the local executor fixture");
		const rootManager = SessionManager.create(temp.path(), path.join(temp.path(), "root-sessions"));
		const rootFile = rootManager.getSessionFile();
		if (!rootFile) throw new Error("Test fixture requires a persisted root transcript");
		const registry = AgentRegistry.isolatedForSession(rootFile);
		const lifecycle = getAgentLifecycleManager(registry);
		let rootSession: AgentSession | undefined;

		try {
			const rootResult = await createAgentRootSession(registry, {
				agentId: "Main",
				agentDisplayName: "Main",
				cwd: temp.path(),
				agentDir: temp.path(),
				authStorage,
				modelRegistry,
				model,
				settings,
				sessionManager: rootManager,
				disableExtensionDiscovery: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				enableMCP: false,
				enableLsp: false,
				toolNames: [],
			});
			rootSession = rootResult.session;
			const parentAuthority = bindInternalAgentAuthoritySession(registry, rootSession);
			if (!parentAuthority) throw new Error("Test fixture requires a live registered parent session");
			const parentAgentId = rootSession.getAgentId?.() ?? "Main";
			const spawnId = "BrowserAuditCustody-1";
			const definitionSha256 = "c".repeat(64);
			const toolCallFingerprint = "d".repeat(64);
			const agent: AgentDefinition = {
				name: "browser-audit-specialist",
				description: "Browser audit fixture",
				systemPrompt: "Use only the reserved audit tool.",
				source: "user",
				filePath: "agents/browser-audit-specialist.md",
				definitionSha256,
				tools: ["browser_audit"],
				spawns: [],
				model: ["openai/gpt-4o-mini"],
				blocking: true,
			};
			const input = binding({ spawnId, parentAgentId, definitionSha256, toolCallFingerprint });
			const brokerSession = {} as ToolSession;
			bindRegisteredBrowserAuditTaskAuthority(brokerSession);
			const taskAuthority = takeBrowserAuditTaskAuthority(brokerSession);
			if (!taskAuthority) throw new Error("Test fixture requires the registered browser-audit broker");
			const identity = spawnIdentity(input);
			const wrongSpawnKey = {};
			taskAuthority.install(wrongSpawnKey, input);
			expect(taskAuthority.activate(wrongSpawnKey, { ...identity, spawnId: `${spawnId}-other` })).toBeUndefined();
			const activationKey = {};
			taskAuthority.install(activationKey, input);
			const capability = taskAuthority.activate(activationKey, identity);
			if (!capability) throw new Error("Exact prepared browser-audit authority did not activate");
			expect(taskAuthority.activate(activationKey, identity)).toBeUndefined();
			bindBrowserAuditRunOptions(agent, capability);

			const artifactsDir = path.join(temp.path(), "artifacts");
			fs.mkdirSync(artifactsDir, { recursive: true });
			let freshSession: AgentSession | undefined;
			const mockStream = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "browser-audit-custody-yield",
								name: "yield",
								arguments: { data: { status: "authorized" } },
							},
						],
					},
				],
			});
			const actualRunSubprocess = executorModule.runSubprocess;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(options =>
				actualRunSubprocess({
					...options,
					onHistoryAuthorityClaimed: session => {
						freshSession = session;
						vi.spyOn(session.agent, "streamFn").mockImplementation(mockStream.stream);
					},
				}),
			);
			const result = await executorModule.runSubprocess({
				cwd: temp.path(),
				agent,
				task: "Verify the real child session capability boundary.",
				assignment: "Verify the real child session capability boundary.",
				index: 0,
				id: spawnId,
				agentRegistry: registry,
				createAuthoritySession: (options, reviveRef) => parentAuthority.create(options, reviveRef),
				settings,
				modelRegistry,
				authStorage,
				modelOverride: "openai/gpt-4o-mini",
				exactModelOverride: true,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
				restrictToolNames: true,
				maxRuntimeMs: 10_000,
				artifactsDir,
				parentAgentId,
				keepAlive: true,
			});
			vi.restoreAllMocks();

			expect(result.exitCode).toBe(0);
			expect(result.aborted).not.toBe(true);
			expect(freshSession?.getAllToolNames()).toContain("browser_audit");
			expect(freshSession?.getToolByName("browser_audit")?.name).toBe("browser_audit");
			const freshRef = registry.get(spawnId);
			expect(freshRef?.status).toBe("idle");
			expect(freshRef?.lineage).toMatchObject({ rootId: "Main", parentId: parentAgentId });
			const generation = freshRef?.lineage?.generation;
			expect(generation).toBeDefined();

			await parkAgent(lifecycle, spawnId);
			expect(registry.get(spawnId)?.status).toBe("parked");
			const revivedSession = await ensureAgentLive(lifecycle, spawnId);
			expect(registry.get(spawnId)?.status).toBe("idle");
			expect(registry.get(spawnId)?.lineage?.generation).toBe(generation);
			expect(revivedSession.getAllToolNames()).not.toContain("browser_audit");
			expect(revivedSession.getToolByName("browser_audit")).toBeUndefined();
		} finally {
			vi.restoreAllMocks();
			await disposeAgentLifecycle(lifecycle);
			await rootSession?.dispose();
			authStorage.close();
		}
	});

	it("rejects exact dispatch provenance mismatches before activation", () => {
		const brokerSession = {} as ToolSession;
		bindRegisteredBrowserAuditTaskAuthority(brokerSession);
		const taskAuthority = takeBrowserAuditTaskAuthority(brokerSession);
		if (!taskAuthority) throw new Error("Test fixture requires the registered browser-audit broker");
		const input = binding({
			spawnId: "BrowserAuditCustody-2",
			parentAgentId: "Main",
			definitionSha256: "c".repeat(64),
			toolCallFingerprint: "d".repeat(64),
		});
		const identity = spawnIdentity(input);
		const mismatches: Partial<BrowserAuditSpawnBindingIdentity>[] = [
			{ agentName: "different-agent" },
			{ agentSource: "project" },
			{ agentLogicalPath: "agents/other-agent.md" },
			{ agentDefinitionSha256: "0".repeat(64) },
			{ spawnId: "BrowserAuditCustody-2-other" },
			{ parentAgentId: "different-parent" },
			{ toolCallFingerprint: "e".repeat(64) },
		];
		for (const mismatch of mismatches) {
			const key = {};
			taskAuthority.install(key, input);
			expect(taskAuthority.activate(key, { ...identity, ...mismatch })).toBeUndefined();
			expect(taskAuthority.activate(key, identity)).toBeUndefined();
		}
	});

	it("rejects an owned stale child generation and an opaque binding to a replaced parent session", async () => {
		using temp = TempDir.createSync("@browser-audit-stale-custody-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled OpenAI model for the local ownership fixture");
		const rootManager = SessionManager.create(temp.path(), path.join(temp.path(), "root-sessions"));
		const rootFile = rootManager.getSessionFile();
		if (!rootFile) throw new Error("Test fixture requires a persisted root transcript");
		const registry = AgentRegistry.isolatedForSession(rootFile);
		const lifecycle = getAgentLifecycleManager(registry);
		const sessions: AgentSession[] = [];
		const rootOptions: CreateAgentSessionOptions = {
			...publicSessionOptions(temp.path(), authStorage, modelRegistry, model),
			agentId: "Main",
			agentDisplayName: "Main",
			toolNames: [],
			sessionManager: rootManager,
		};
		const spawnId = "BrowserAuditStaleCustody";
		const childOptions = {
			...publicSessionOptions(temp.path(), authStorage, modelRegistry, model),
			agentId: spawnId,
			agentDisplayName: "browser-audit-specialist",
			sessionManager: SessionManager.create(temp.path(), path.join(temp.path(), "child-sessions")),
		};
		try {
			const root = await createAgentRootSession(registry, rootOptions);
			sessions.push(root.session);
			await root.session.sessionManager.ensureOnDisk();
			await root.session.sessionManager.flush();
			const parentAuthority = bindInternalAgentAuthoritySession(registry, root.session);
			if (!parentAuthority) throw new Error("Test fixture requires a live registered parent session");
			const child = await parentAuthority.create(childOptions);
			sessions.push(child.session);
			await child.session.sessionManager.ensureOnDisk();
			await child.session.sessionManager.flush();
			adoptAgent(lifecycle, spawnId, { idleTtlMs: 0 }, child.session);
			await parkAgent(lifecycle, spawnId);
			const staleObservation = registry.get(spawnId);
			if (!staleObservation?.lineage) throw new Error("Test fixture requires an owned parked observation");
			expect(staleObservation.status).toBe("parked");
			expect(await releaseAgent(lifecycle, spawnId, staleObservation)).toBe(true);
			const replacementOptions = {
				...childOptions,
				sessionManager: SessionManager.create(temp.path(), path.join(temp.path(), "replacement-child-sessions")),
			};
			const replacement = await parentAuthority.create(replacementOptions);
			sessions.push(replacement.session);
			await replacement.session.sessionManager.ensureOnDisk();
			await replacement.session.sessionManager.flush();
			adoptAgent(lifecycle, spawnId, { idleTtlMs: 0 }, replacement.session);
			await parkAgent(lifecycle, spawnId);
			const currentObservation = registry.get(spawnId);
			if (!currentObservation?.lineage) throw new Error("Test fixture requires a replacement parked observation");
			expect(currentObservation.status).toBe("parked");
			expect(currentObservation.lineage.generation).not.toBe(staleObservation.lineage.generation);

			const brokerSession = {} as ToolSession;
			bindRegisteredBrowserAuditTaskAuthority(brokerSession);
			const taskAuthority = takeBrowserAuditTaskAuthority(brokerSession);
			if (!taskAuthority) throw new Error("Test fixture requires the registered browser-audit broker");
			const input = binding({
				spawnId,
				parentAgentId: "Main",
				definitionSha256: "c".repeat(64),
				toolCallFingerprint: "d".repeat(64),
			});
			const key = {};
			taskAuthority.install(key, input);
			const capability = taskAuthority.activate(key, spawnIdentity(input));
			if (!capability) throw new Error("Exact prepared browser-audit authority did not activate");
			if (!currentObservation.sessionFile) throw new Error("Test fixture requires a persisted child transcript");
			const revivalOptions = {
				...replacementOptions,
				sessionManager: await SessionManager.open(currentObservation.sessionFile),
			};
			bindBrowserAuditSessionOptions(revivalOptions, capability);
			await expect(parentAuthority.create(revivalOptions, staleObservation)).rejects.toThrow(
				"Invalid parked revival authority.",
			);
			expect(registry.get(spawnId)).toMatchObject({ status: "parked", lineage: currentObservation.lineage });
			// A valid owned observation reaches the SDK after the stale one was refused.
			const revived = await parentAuthority.create(revivalOptions, currentObservation);
			sessions.push(revived.session);
			expect(revived.session.getAllToolNames()).toContain("browser_audit");
			expect(registry.get(spawnId)?.lineage?.generation).toBe(currentObservation.lineage.generation);

			const oldRootGeneration = registry.get("Main")?.lineage?.generation;
			const replacementRoot = await createAgentRootSession(registry, {
				...rootOptions,
				sessionManager: SessionManager.create(temp.path(), path.join(temp.path(), "replacement-root-sessions")),
			});
			sessions.push(replacementRoot.session);
			expect(registry.get("Main")?.lineage?.generation).not.toBe(oldRootGeneration);
			expect(root.session.isDisposed).toBe(true);
			expect(bindInternalAgentAuthoritySession(registry, root.session)).toBeUndefined();
			const staleParentKey = {};
			taskAuthority.install(staleParentKey, input);
			const staleParentCapability = taskAuthority.activate(staleParentKey, spawnIdentity(input));
			if (!staleParentCapability) throw new Error("Exact prepared browser-audit authority did not activate");
			const staleParentOptions = {
				...childOptions,
				sessionManager: SessionManager.create(temp.path(), path.join(temp.path(), "current-parent-child-sessions")),
			};
			bindBrowserAuditSessionOptions(staleParentOptions, staleParentCapability);
			await expect(parentAuthority.create(staleParentOptions)).rejects.toThrow(
				"Invalid live parent session authority.",
			);
			await expect(parentAuthority.create(staleParentOptions, currentObservation)).rejects.toThrow(
				"Invalid live parent revival authority.",
			);
			expect(registry.get(spawnId)).toBeUndefined();
			expect(replacementRoot.session.getAllToolNames()).not.toContain("browser_audit");
			const replacementParentAuthority = bindInternalAgentAuthoritySession(registry, replacementRoot.session);
			if (!replacementParentAuthority) throw new Error("Test fixture requires the current parent session binding");
			const replacementParentInput = binding({
				spawnId,
				parentAgentId: "Main",
				definitionSha256: "c".repeat(64),
				toolCallFingerprint: "e".repeat(64),
			});
			const replacementParentKey = {};
			taskAuthority.install(replacementParentKey, replacementParentInput);
			const replacementParentCapability = taskAuthority.activate(
				replacementParentKey,
				spawnIdentity(replacementParentInput),
			);
			if (!replacementParentCapability) throw new Error("Fresh replacement-parent authority did not activate");
			const replacementParentOptions = {
				...childOptions,
				sessionManager: SessionManager.create(
					temp.path(),
					path.join(temp.path(), "replacement-parent-child-sessions"),
				),
			};
			bindBrowserAuditSessionOptions(replacementParentOptions, replacementParentCapability);
			const currentParentChild = await replacementParentAuthority.create(replacementParentOptions);
			sessions.push(currentParentChild.session);
			expect(currentParentChild.session.getAllToolNames()).toContain("browser_audit");
			expect(registry.get(spawnId)?.lineage?.generation).not.toBe(currentObservation.lineage.generation);
		} finally {
			await disposeAgentLifecycle(lifecycle);
			for (const session of sessions) await session.dispose();
			authStorage.close();
		}
	});

	it("does not register browser audit for unbound or forged public SDK options", async () => {
		using temp = TempDir.createSync("@browser-audit-public-custody-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled OpenAI model for the local SDK fixture");
		const sessions: AgentSession[] = [];
		try {
			const unbound = await createAgentSession(publicSessionOptions(temp.path(), authStorage, modelRegistry, model));
			sessions.push(unbound.session);
			const forged = await createAgentSession({
				...publicSessionOptions(temp.path(), authStorage, modelRegistry, model),
				browserAuditCapability: Object.freeze({}),
			} as CreateAgentSessionOptions);
			sessions.push(forged.session);
			for (const session of sessions) {
				expect(session.getAllToolNames()).not.toContain("browser_audit");
				expect(session.getToolByName("browser_audit")).toBeUndefined();
			}
		} finally {
			for (const session of sessions) await session.dispose();
			authStorage.close();
		}
	});
});
