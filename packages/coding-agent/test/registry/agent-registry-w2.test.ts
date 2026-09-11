import { describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../../src/config/model-registry";
import type { MCPManager } from "../../src/mcp/manager";
import {
	adoptAgent,
	createAgentLifecycleManager,
	disposeAgentLifecycle,
	getAgentLifecycleManager,
	lifecycleHasAgent,
	releaseAgent,
	resetAgentLifecycleForTests,
} from "../../src/internal/agent-lifecycle-bridge";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	detachAgentSession,
	lookupAgentRef,
	resolveAgentSessionOperationAuthority,
	setAgentStatus,
} from "../../src/internal/agent-registry-bridge";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as publicRegistry from "../../src/registry/agent-registry";
import { getOperationTerminal, runEvalOperation } from "../../src/registry/operation-lease";
import * as operationLease from "../../src/registry/operation-lease";
import * as sdk from "../../src/sdk";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { Settings } from "../../src/config/settings";
import { freezePermissionScope } from "../../src/task/permission-profiles";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function fakeSession(sessionFile: string): AgentSession {
	const sessionManager = { getSessionFile: () => sessionFile };
	operationLease.installSessionOperationLedger(sessionManager);
	return {
		sessionManager,
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSession;
}

function realSession(): { session: AgentSession; auth: AuthStorage } {
	const auth = createInMemoryAuthStorage();
	return {
		auth,
		session: new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
		}),
	};
}

function authority(registry: AgentRegistry, parent: AgentSession) {
	const binding = bindInternalAgentAuthoritySession(registry, parent);
	if (!binding) throw new Error("Invalid live parent");
	return binding;
}

describe("W2 registry capabilities", () => {
	it("rejects a child whose parent retires while SDK construction is pending", async () => {
		const rootSession = fakeSession("/root.jsonl");
		const childSession = fakeSession("/child.jsonl");
		const pending = Promise.withResolvers<sdk.CreateAgentSessionResult>();
		const constructionStarted = Promise.withResolvers<void>();
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: rootSession } as sdk.CreateAgentSessionResult)
			.mockImplementationOnce(() => {
				constructionStarted.resolve();
				return pending.promise;
			});
		try {
			const registry = new AgentRegistry();
			await createAgentRootSession(registry, { agentId: "Main" });
			const creation = authority(registry, rootSession).create({ agentId: "Worker" });
			const outcome = creation.then(
				() => undefined,
				error => error,
			);
			await constructionStarted.promise;
			await rootSession.dispose();
			pending.resolve({ session: childSession } as sdk.CreateAgentSessionResult);
			const error = await outcome;
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Parent session authority changed");
			expect(registry.get("Worker")).toBeUndefined();
			expect(childSession.dispose).toHaveBeenCalledTimes(1);
		} finally {
			createSession.mockRestore();
		}
	});

	it("rejects a pending child after manager release replaces its parent generation with the same session", async () => {
		const parent = fakeSession("/root.jsonl");
		const child = fakeSession("/child.jsonl");
		const pending = Promise.withResolvers<sdk.CreateAgentSessionResult>();
		const constructionStarted = Promise.withResolvers<void>();
		const registry = new AgentRegistry();
		const lifecycle = createAgentLifecycleManager(registry);
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: parent } as sdk.CreateAgentSessionResult)
			.mockImplementationOnce(() => {
				constructionStarted.resolve();
				return pending.promise;
			});
		try {
			await createAgentRootSession(registry, { agentId: "Main" });
			const original = registry.get("Main")!;
			const creation = authority(registry, parent).create({ agentId: "Worker" });
			const outcome = creation.then(
				() => undefined,
				error => error,
			);
			await constructionStarted.promise;
			expect(await releaseAgent(lifecycle, "Main", original)).toBe(true);
			// This fake session remains reusable after disposal; identity alone is not authority.
			const replacement = registry.register({ id: "Main", displayName: "main", kind: "main", session: parent });
			expect(replacement).not.toBe(original);
			expect(replacement.lineage?.generation).not.toBe(original.lineage?.generation);
			expect(lookupAgentRef(registry, "Main")?.session).toBe(parent);
			pending.resolve({ session: child } as sdk.CreateAgentSessionResult);
			const error = await outcome;
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain("Parent session authority changed");
			expect(child.dispose).toHaveBeenCalledTimes(1);
			expect(registry.get("Worker")).toBeUndefined();
			expect(registry.get("Main")).toMatchObject({ id: replacement.id, lineage: replacement.lineage });
			// Rejection also releases the reserved child ID.
			expect(
				registry.register({ id: "Worker", displayName: "worker", kind: "sub", parentId: "Main", session: null }).id,
			).toBe("Worker");
		} finally {
			createSession.mockRestore();
			await disposeAgentLifecycle(lifecycle);
		}
	});

	it("checks actor provenance and no-broader scope at the private creator boundary", async () => {
		const rootSession = fakeSession("/root.jsonl");
		const rootScope = freezePermissionScope({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "Main",
			actorKind: "main",
			profiles: [],
			tools: ["read"],
			denyTools: [],
			allowPaths: [],
			denyPaths: [],
		}).scope;
		rootSession.getPermissionScope = () => rootScope;
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValue({ session: rootSession } as sdk.CreateAgentSessionResult);
		try {
			const registry = new AgentRegistry();
			await createAgentRootSession(registry, { agentId: "Main" });
			await expect(
				authority(registry, rootSession).create({
					agentId: "Worker",
					permissionScope: {
						...rootScope,
						actorId: "Worker",
						actorKind: "sub",
						parentId: "Main",
						tools: ["read", "write"],
					},
				}),
			).rejects.toThrow("live parent authority");
			await expect(
				authority(registry, rootSession).create({
					agentId: "Worker",
					permissionScope: { ...rootScope, actorId: "Other", actorKind: "sub", parentId: "Main" },
				}),
			).rejects.toThrow("reserved actor");
		} finally {
			createSession.mockRestore();
		}
	});

	it("creates exact root and child lineages and rejects same-slot and stale-parent replay", async () => {
		const sessions = [fakeSession("/root.jsonl"), fakeSession("/child.jsonl")];
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockImplementation(async () => ({ session: sessions.shift()! }) as sdk.CreateAgentSessionResult);
		try {
			const registry = new AgentRegistry();
			const root = await createAgentRootSession(registry, { agentId: "Main", agentDisplayName: "main" });
			const child = await authority(registry, root.session).create({
				agentId: "Worker",
				agentDisplayName: "worker",
			});
			const ref = registry.get("Worker");
			expect(ref?.lineage).toMatchObject({ rootId: "Main", parentId: "Main" });
			await expect(authority(registry, root.session).create({ agentId: "Worker" })).rejects.toThrow(
				"already reserved",
			);
			await root.session.dispose();
			expect(bindInternalAgentAuthoritySession(registry, root.session)).toBeUndefined();
			await child.session.dispose();
		} finally {
			createSession.mockRestore();
		}
	});
	it("keeps concurrent roots and same-name actors in exact independent slots", async () => {
		const sessions: Record<string, AgentSession> = {
			RootA: fakeSession("/a.jsonl"),
			RootB: fakeSession("/b.jsonl"),
			"RootA/worker": fakeSession("/a-worker.jsonl"),
			"RootB/worker": fakeSession("/b-worker.jsonl"),
		};
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockImplementation(async (options: sdk.CreateAgentSessionOptions = {}) => {
				const session = sessions[options.agentId ?? ""];
				if (!session) throw new Error(`Unexpected agent ID: ${options.agentId}`);
				return { session } as sdk.CreateAgentSessionResult;
			});
		try {
			const registry = new AgentRegistry();
			const [rootA, rootB] = await Promise.all([
				createAgentRootSession(registry, { agentId: "RootA" }),
				createAgentRootSession(registry, { agentId: "RootB" }),
			]);
			await Promise.all([
				authority(registry, rootA.session).create({ agentId: "RootA/worker", agentDisplayName: "worker" }),
				authority(registry, rootB.session).create({ agentId: "RootB/worker", agentDisplayName: "worker" }),
			]);
			expect(createSession).toHaveBeenCalledTimes(4);
			expect(registry.get("RootA/worker")?.lineage?.rootId).toBe("RootA");
			expect(registry.get("RootB/worker")?.lineage?.rootId).toBe("RootB");
			expect(bindInternalAgentAuthoritySession(registry, { ...rootA.session } as AgentSession)).toBeUndefined();
			const worker = registry.get("RootA/worker");
			if (!worker) throw new Error("Expected live worker");
			const workerSession = lookupAgentRef(registry, worker.id)?.session;
			if (!workerSession) throw new Error("Expected exact live worker session");
			expect(registry.setStatus(worker.id, "parked", workerSession)).toBe(false);
			expect(registry.detachSession(worker.id, workerSession)).toBe(false);
			expect(setAgentStatus(registry, worker.id, "parked", workerSession)).toBe(true);
			expect(detachAgentSession(registry, worker.id, workerSession)).toBe(true);
			await expect(authority(registry, rootB.session).create({ agentId: worker.id }, worker)).rejects.toThrow(
				"Invalid live parent revival",
			);
			expect(registry.list().filter(ref => ref.displayName === "worker")).toHaveLength(2);
		} finally {
			createSession.mockRestore();
		}
	});

	it("freezes cloned authority data while preserving the opaque MCP manager identity", async () => {
		const session = fakeSession("/mcp-root.jsonl");
		const getTools = vi.fn(() => []);
		const mcpManager = { getTools } as unknown as MCPManager;
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		let captured: sdk.CreateAgentSessionOptions | undefined;
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockImplementation(async (options: sdk.CreateAgentSessionOptions = {}) => {
				captured = options;
				return { session } as sdk.CreateAgentSessionResult;
			});
		try {
			const registry = new AgentRegistry();
			await createAgentRootSession(registry, { agentId: "Main", mcpManager, outputSchema });
			expect(captured?.mcpManager).toBe(mcpManager);
			expect(captured?.mcpManager?.getTools()).toEqual([]);
			expect(getTools).toHaveBeenCalledTimes(1);
			expect(captured?.outputSchema).not.toBe(outputSchema);
			const capturedSchema = captured?.outputSchema as typeof outputSchema | undefined;
			if (!capturedSchema) throw new Error("Expected a captured output schema");
			expect(Object.isFrozen(capturedSchema)).toBe(true);
			expect(Object.isFrozen(capturedSchema.properties)).toBe(true);
			expect(Object.isFrozen(mcpManager)).toBe(false);
		} finally {
			createSession.mockRestore();
		}
	});

	it("replaces an occupied root through quiesce, drain, transition, commit, and activation", async () => {
		const first = realSession();
		const second = realSession();
		const childHost = realSession();
		const pending = Promise.withResolvers<string>();
		const callbackStarted = Promise.withResolvers<void>();
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: first.session } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: childHost.session } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: second.session } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		try {
			const original = await createAgentRootSession(registry, { agentId: "Main" });
			const child = await authority(registry, original.session).create({ agentId: "RetiredChild" });
			const oldGeneration = registry.get("Main")?.lineage?.generation;
			let callbackFinished = false;
			const active = runEvalOperation(original.session.sessionManager, "eval:root-replacement", async () => {
				callbackStarted.resolve();
				try {
					return await pending.promise;
				} finally {
					callbackFinished = true;
				}
			});
			await callbackStarted.promise;
			const replacementPromise = createAgentRootSession(registry, { agentId: "Main" });
			let replacementSettled = false;
			void replacementPromise.then(
				() => {
					replacementSettled = true;
				},
				() => {
					replacementSettled = true;
				},
			);
			await Promise.resolve();
			expect(callbackFinished).toBe(false);
			expect(replacementSettled).toBe(false);
			pending.resolve("old completion");
			await expect(active).rejects.toThrow(/cancel/i);
			const replacement = await replacementPromise;
			expect(original.session.isDisposed).toBe(true);
			expect(child.session.isDisposed).toBe(true);
			expect(registry.get("RetiredChild")).toBeUndefined();
			expect(lookupAgentRef(registry, "Main")?.session).toBe(replacement.session);
			expect(registry.get("Main")?.lineage?.generation).not.toBe(oldGeneration);
			const staleRun = vi.fn(async () => "stale");
			await expect(
				runEvalOperation(original.session.sessionManager, "eval:stale-generation", staleRun),
			).rejects.toThrow(/quiesced|authority/i);
			expect(staleRun).not.toHaveBeenCalled();
			expect(getOperationTerminal(original.session.sessionManager, "eval:root-replacement")).toMatchObject({
				status: "abandoned",
				detail: "Session disposed",
			});
			await expect(
				runEvalOperation(replacement.session.sessionManager, "eval:new-root", async () => "new root"),
			).resolves.toBe("new root");
			const replacementGeneration = registry.get("Main")?.lineage?.generation;
			expect(getOperationTerminal(replacement.session.sessionManager, "eval:new-root")).toMatchObject({
				actorId: "Main",
				rootId: "Main",
				generation: replacementGeneration,
				effectClass: "eval",
				status: "completed",
			});
			await replacement.session.dispose();
		} finally {
			createSession.mockRestore();
			await first.session.dispose();
			await second.session.dispose();
			await childHost.session.dispose();
			first.auth.close();
			second.auth.close();
			childHost.auth.close();
		}
	});

	it("keeps the old root fully active when staged replacement construction fails", async () => {
		const first = realSession();
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: first.session } as sdk.CreateAgentSessionResult)
			.mockRejectedValueOnce(new Error("replacement construction failed"));
		const registry = new AgentRegistry();
		try {
			await createAgentRootSession(registry, { agentId: "Main" });
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toThrow(
				"replacement construction failed",
			);
			expect(lookupAgentRef(registry, "Main")?.session).toBe(first.session);
			await expect(
				runEvalOperation(first.session.sessionManager, "eval:after-recovery", async () => "old root active"),
			).resolves.toBe("old root active");
			expect(getOperationTerminal(first.session.sessionManager, "eval:after-recovery")).toMatchObject({
				status: "completed",
			});
		} finally {
			createSession.mockRestore();
			await first.session.dispose();
			first.auth.close();
		}
	});

	it("keeps the replacement authoritative when old-root retirement fails after the CAS", async () => {
		const first = realSession();
		const second = realSession();
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: first.session } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: second.session } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		const originalDispose = first.session.dispose;
		try {
			await createAgentRootSession(registry, { agentId: "Main" });
			first.session.dispose = vi.fn(async () => {
				throw new Error("retirement failpoint");
			});
			const replacement = await createAgentRootSession(registry, { agentId: "Main" });
			expect(replacement.session).toBe(second.session);
			expect(lookupAgentRef(registry, "Main")?.session).toBe(second.session);
			await expect(
				runEvalOperation(second.session.sessionManager, "eval:post-cas", async () => "forward"),
			).resolves.toBe("forward");
		} finally {
			createSession.mockRestore();
			first.session.dispose = originalDispose;
			await first.session.dispose();
			await second.session.dispose();
			first.auth.close();
			second.auth.close();
		}
	});
	it("keeps public SDK construction unregistered and rejects public authority assertions", async () => {
		const registry = new AgentRegistry();
		const session = fakeSession("/direct.jsonl");
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValue({ session } as sdk.CreateAgentSessionResult);
		try {
			await sdk.createAgentSession({ agentRegistry: registry, agentId: "Direct" });
			expect(registry.get("Direct")).toBeUndefined();
			expect("bindAgentAuthoritySession" in publicRegistry).toBe(false);
			expect("createRootSession" in registry).toBe(false);
		} finally {
			createSession.mockRestore();
		}
	});

	it("rejects stolen and structurally forged operation capabilities", async () => {
		const root = realSession();
		const foreign = realSession();
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValue({ session: root.session } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		try {
			await createAgentRootSession(registry, { agentId: "Main" });
			const authority = resolveAgentSessionOperationAuthority(registry, root.session);
			expect(authority).toBeDefined();
			expect(() => operationLease.bindSessionOperationAuthority(foreign.session.sessionManager, authority!)).toThrow(
				/different session manager/i,
			);
			const forged = { ...authority } as typeof authority;
			expect(() => operationLease.bindSessionOperationAuthority(root.session.sessionManager, forged!)).toThrow(
				/different session manager/i,
			);
		} finally {
			createSession.mockRestore();
			await root.session.dispose();
			await foreign.session.dispose();
			root.auth.close();
			foreign.auth.close();
		}
	});

	it("publishes only frozen redacted observations even while authority registration is committing", async () => {
		const session = fakeSession("/event-root.jsonl");
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValue({ session } as sdk.CreateAgentSessionResult);
		try {
			const registry = new AgentRegistry();
			const events: Array<{ ref: publicRegistry.AgentRef }> = [];
			registry.onChange(event => events.push(event));
			await createAgentRootSession(registry, { agentId: "Main" });
			expect(events).toHaveLength(1);
			expect(Object.isFrozen(events[0]?.ref)).toBe(true);
			expect("session" in events[0]!.ref).toBe(false);
			expect(Reflect.set(events[0]!.ref, "status", "aborted")).toBe(false);
			expect(registry.get("Main")?.status).toBe("running");
			expect(lookupAgentRef(registry, "Main")?.session).toBe(session);
		} finally {
			createSession.mockRestore();
		}
	});

	it("memoizes registry-owned disposal and never lets a stale dispose resolve a later lifecycle", async () => {
		AgentRegistry.resetGlobalForTests();
		resetAgentLifecycleForTests();
		const registry = AgentRegistry.global();
		const backing = fakeSession("/root-dispose-owner.jsonl");
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValue({ session: backing } as sdk.CreateAgentSessionResult);
		try {
			const root = await createAgentRootSession(registry, { agentId: "Main" });
			const firstDispose = root.session.dispose();
			const repeatedDispose = root.session.dispose();
			expect(repeatedDispose).toBe(firstDispose);
			await firstDispose;

			resetAgentLifecycleForTests();
			const laterLifecycle = getAgentLifecycleManager(registry);
			const laterSession = fakeSession("/later-worker.jsonl");
			const laterRef = registry.register({
				id: "LaterWorker",
				displayName: "later worker",
				kind: "sub",
				parentId: "Main",
				session: laterSession,
				status: "idle",
			});
			const laterAuthority = lookupAgentRef(registry, laterRef.id)!;
			adoptAgent(laterLifecycle, laterRef.id, { idleTtlMs: 0 }, laterAuthority);
			expect(lifecycleHasAgent(laterLifecycle, laterRef.id, laterAuthority)).toBe(true);
			const staleDispose = root.session.dispose();
			expect(staleDispose).toBe(firstDispose);
			await staleDispose;
			expect(lifecycleHasAgent(laterLifecycle, laterRef.id, laterAuthority)).toBe(true);
			await disposeAgentLifecycle(laterLifecycle);
		} finally {
			createSession.mockRestore();
			resetAgentLifecycleForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	it("fails closed for public lifecycle construction, global acquisition, and direct release", async () => {
		const registry = new AgentRegistry();
		expect(() => new AgentLifecycleManager(registry)).toThrow("internal");
		expect(() => AgentLifecycleManager.global()).toThrow("public authority surface");
		const lifecycle = createAgentLifecycleManager(registry);
		const observed = registry.register({
			id: "Legacy",
			displayName: "legacy",
			kind: "sub",
			session: null,
			status: "parked",
		});
		await expect(lifecycle.release("Legacy", observed)).rejects.toThrow("internal");
		expect(await releaseAgent(lifecycle, "Legacy", { ...observed })).toBe(false);
		expect(registry.get("Legacy")).toBeDefined();
		await disposeAgentLifecycle(lifecycle);
	});
	it("exposes immutable scope tuples but no public reservation, claim, factory, or generic owner mutation", () => {
		const registry = new AgentRegistry();
		const snapshot = freezePermissionScope({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "Worker",
			actorKind: "sub",
			parentId: "Main",
			profiles: [],
			tools: ["read"],
			denyTools: [],
			allowPaths: ["src/**"],
			denyPaths: [],
			allowPathGroups: [["src/**"]],
			denyPathGroups: [],
		});
		for (const compileOnly of []) {
			void compileOnly;
			// @ts-expect-error production session construction cannot be injected
			new AgentRegistry(() => {});
			// @ts-expect-error retirement is manager-owned, not public registry authority
			registry.retire({}, "Worker");
			// @ts-expect-error termination start is manager-owned, not public registry authority
			registry.beginTermination("Worker", {});
			// @ts-expect-error reservations are private implementation details
			registry.reserveRoot("Main");
			// @ts-expect-error claims are private implementation details
			registry.registerReserved({}, {});
			// @ts-expect-error private factories cannot be invoked by SDK callers
			registry.createReservedSession({}, {});
			// @ts-expect-error public caller-bound factories are not authority
			registry.createSessionFactory(() => {});
			// @ts-expect-error public registry instances cannot create authority-owned roots
			registry.createRootSession({ agentId: "Main" });
			// @ts-expect-error public registry module does not export the internal binder
			publicRegistry.bindAgentAuthoritySession;
			// @ts-expect-error refs do not carry authority capabilities
			registry.get("Worker")?.capability;
			// @ts-expect-error operation ledgers cannot be publicly constructed
			operationLease.OperationLeaseRegistry;
			// @ts-expect-error root transitions are private registry implementation
			registry.beginRootTransition({}, {}, {});
			// @ts-expect-error lifecycle parking is manager-owned, not public registry authority
			registry.transitionToParked("Worker", {}, {});
			// @ts-expect-error lifecycle abort is manager-owned, not public registry authority
			registry.transitionToAborted("Worker", {});
			// @ts-expect-error exact removal is manager-owned, not public registry authority
			registry.removeExact("Worker", {});
			// @ts-expect-error termination completion is manager-owned, not public registry authority
			registry.endTermination("Worker", {});
			// @ts-expect-error frozen path tuples cannot be changed
			snapshot.scope.allowPathGroups![0]![0] = "**";
		}
		expect(Object.isFrozen(snapshot.scope.allowPathGroups?.[0])).toBe(true);
	});
});
