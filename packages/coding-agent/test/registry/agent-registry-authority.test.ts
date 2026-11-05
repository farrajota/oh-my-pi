import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRuntime } from "../../src/extensibility/extensions/loader";
import { EventBus } from "../../src/utils/event-bus";
import * as sdk from "../../src/sdk";
import {
	abortAgentRef,
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
	parkAgentRef,
	removeAgentRef,
	setAgentStatus,
	syncAgentSessionStatus,
} from "../../src/internal/agent-registry-bridge";
import type { AgentSession } from "../../src/session/agent-session";
import type { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import type { AuthorityIdentity, AuthorityRecoveryState, AuthorityStore } from "../../src/registry/authority/types";
import {
	bindSessionOperationDurability,
	getActiveOperationLease,
	installSessionOperationLedger,
	markUnregisteredSessionOperationProjection,
	type OperationLease,
	runLocalOperation,
} from "../../src/registry/operation-lease";
import {
	adoptAgent,
	bindOwnedAgentLifecycle,
	createAgentLifecycleManager,
	disposeAgentLifecycle,
	ensureAgentLive,
	parkAgent,
	releaseAgent,
} from "../../src/internal/agent-lifecycle-bridge";
import type { AgentSessionDisposeOptions } from "../../src/session/agent-session-types";
import { AgentRegistry, type AgentRef } from "../../src/registry/agent-registry";
import { closeSessionAuthority, registryDurableStateForSession } from "../../src/registry/authority";
import { SessionManager } from "../../src/session/session-manager";

function persistentStore(file: string, create = true): AuthorityStore {
	const persistence = new JsonlAuthorityPersistence({ path: file, identity, create });
	const engine = new AuthorityEngine(persistence, "registry-test-owner");
	return Object.assign(engine, { close: async () => persistence.close() }) as unknown as AuthorityStore;
}

type FakeAgentSession = AgentSession & { emitRunState(status: "running" | "idle"): void };

function fakeSession(file: string): FakeAgentSession {
	const listeners = new Set<(status: "running" | "idle") => void>();
	const sessionManager = { getSessionFile: () => file };
	const operationControl = installSessionOperationLedger(sessionManager);
	let disposed = false;
	const beginDispose = () => {
		if (disposed) return;
		disposed = true;
		void operationControl.close();
	};
	const dispose = vi.fn(async () => {
		beginDispose();
		await operationControl.close();
	});
	return {
		sessionManager,
		subscribeRunState: (listener: (status: "running" | "idle") => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emitRunState: (status: "running" | "idle") => {
			for (const listener of [...listeners]) listener(status);
		},
		beginDispose,
		dispose,
		get isDisposed() {
			return disposed;
		},
	} as unknown as FakeAgentSession;
}

function sessionResult(session: AgentSession): sdk.CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const identity: AuthorityIdentity = {
	backend: "jsonl",
	owningSessionId: "root-session",
	incarnation: "incarnation-1",
	format: 2,
};

function recoveringStore(recovery: Promise<AuthorityRecoveryState>): AuthorityStore {
	return {
		identity,
		recover: () => recovery,
	} as unknown as AuthorityStore;
}

function recovered(highWater: number): AuthorityRecoveryState {
	return {
		revision: 12,
		generationHighWater: highWater,
		owner: { incarnation: identity.incarnation, epoch: 1, token: "owner-token", phase: "ready" },
		roots: new Map(),
		actors: new Map(),
		blocked: [],
	};
}

interface FixtureWork {
	outcome: Promise<PromiseSettledResult<unknown>>;
	expectsFailure: boolean;
}

function captureOutcome<T>(
	promise: Promise<T>,
	work: FixtureWork[],
	expectsFailure = true,
): Promise<PromiseSettledResult<T>> {
	const outcome = promise.then(
		value => ({ status: "fulfilled" as const, value }),
		reason => ({ status: "rejected" as const, reason }),
	);
	work.push({ outcome, expectsFailure });
	return outcome;
}

function trackWork<T>(promise: Promise<T>, work: FixtureWork[]): Promise<T> {
	captureOutcome(promise, work, false);
	return promise;
}

function expectFailure<T>(outcome: PromiseSettledResult<T>, expected: Error | RegExp | string): unknown {
	expect(outcome.status).toBe("rejected");
	if (outcome.status !== "rejected") throw new Error("Expected the owned operation to reject.");
	if (expected instanceof Error) expect(outcome.reason).toBe(expected);
	else
		expect(() => {
			throw outcome.reason;
		}).toThrow(expected);
	return outcome.reason;
}

async function cleanupFixture(work: FixtureWork[], ...steps: Array<() => unknown | Promise<unknown>>): Promise<void> {
	const outcomes = await Promise.all(work.map(item => item.outcome));
	const errors = outcomes.flatMap((outcome, index) =>
		outcome.status === "rejected" && !work[index]?.expectsFailure ? [outcome.reason] : [],
	);
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			if (!errors.includes(error)) errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Registry authority fixture cleanup failed.");
}

describe("AgentRegistry durable initialization", () => {
	it("does not expose a registry until asynchronous recovery completes", async () => {
		const work: FixtureWork[] = [];
		const recovery = Promise.withResolvers<AuthorityRecoveryState>();
		const store = recoveringStore(recovery.promise);
		let settled = false;
		const creating = trackWork(
			AgentRegistry.create({ durableState: store }).then(registry => {
				settled = true;
				return registry;
			}),
			work,
		);

		try {
			await Promise.resolve();
			expect(settled).toBe(false);
			recovery.resolve(recovered(7));
			const registry = await creating;
			expect(registry.list()).toEqual([]);
		} finally {
			recovery.resolve(recovered(7));
			await cleanupFixture(work);
		}
	});

	it("continues generation allocation above abandoned construction history", async () => {
		const store = recoveringStore(Promise.resolve(recovered(23)));
		const registry = await AgentRegistry.create({ durableState: store });

		const actor = registry.register({ id: "fresh-agent", displayName: "fresh", kind: "sub", session: null });
		expect(actor.lineage?.generation).toBe(24);
	});

	it("rejects synchronous construction with an uninitialized authority store", () => {
		const store = recoveringStore(Promise.resolve(recovered(0)));

		expect(() => new AgentRegistry({ durableState: store })).toThrow(/create|initialize|recover/i);
	});
	it("recovers generation high-water from abandoned history after reopening the journal", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-restart-"));
		const file = path.join(directory, "authority.jsonl");
		const firstStore = persistentStore(file);
		const digest = "a".repeat(64);
		const construction = {
			kind: "construction" as const,
			actorId: "Main",
			rootId: "Main",
			generation: 41,
			startupHash: digest,
			provenanceHash: digest,
			at: Date.now(),
			phase: "reserved" as const,
		};
		try {
			await firstStore.recover();
			await firstStore.transition(construction);
			await firstStore.transition({ ...construction, at: Date.now(), phase: "abandoned" });
			await firstStore.close();
			const restartedStore = persistentStore(file, false);
			try {
				const registry = await AgentRegistry.create({ durableState: restartedStore });
				const actor = registry.register({ id: "fresh-agent", displayName: "fresh", kind: "sub", session: null });
				expect(actor.lineage?.generation).toBe(42);
			} finally {
				await restartedStore.close();
			}
		} finally {
			await firstStore.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	it("abandons a child construction when its durable root retires while SDK creation is pending", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-stale-root-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "worker.jsonl"));
		const pending = Promise.withResolvers<sdk.CreateAgentSessionResult>();
		const started = Promise.withResolvers<void>();
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.agentId === "Main") return sessionResult(root);
			if (options.agentId === "Main/worker") {
				started.resolve();
				return pending.promise;
			}
			throw new Error(`Unexpected authority actor ${options.agentId}`);
		});
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected the durable root authority binding");
			const creating = captureOutcome(binding.create({ agentId: "Main/worker" }), work);
			await started.promise;
			const rootRef = lookupAgentRef(registry, "Main");
			if (!rootRef) throw new Error("Expected the durable root authority ref");
			let removed = false;
			const removal = trackWork(
				removeAgentRef(registry, rootRef).then(result => {
					removed = true;
					return result;
				}),
				work,
			);
			await Promise.resolve();
			expect(removed).toBe(false);
			pending.resolve(sessionResult(child));
			expectFailure(await creating, /authority|parent|construction/i);
			expect(await removal).toBe(true);
			expect(await store.getActor("Main/worker")).toBeUndefined();
			expect((await store.getConstruction("Main", "Main/worker", 2))?.record.phase).toBe("abandoned");
			expect((await store.getActor("Main"))?.record.state).toBe("retired");
		} finally {
			pending.resolve(sessionResult(child));
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("persists park and abort transitions against the exact actor generation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-lifecycle-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "worker.jsonl"));
		const revived = fakeSession(path.join(directory, "worker.jsonl"));
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child))
			.mockResolvedValueOnce(sessionResult(revived));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected the durable root authority binding");
			await binding.create({ agentId: "Main/worker" });
			const workerRef = lookupAgentRef(registry, "Main/worker");
			if (!workerRef) throw new Error("Expected the durable worker registry ref");
			expect(await parkAgentRef(registry, workerRef, child)).toBe(true);
			expect((await store.getActor("Main/worker"))?.record.state).toBe("parked");
			expect(lookupAgentRef(registry, "Main/worker")?.session).toBeNull();
			const parkedObservation = registry.get("Main/worker");
			if (!parkedObservation) throw new Error("Expected the parked worker observation");
			await binding.create({ agentId: "Main/worker" }, parkedObservation);
			expect((await store.getActor("Main/worker"))?.record.state).toBe("active");
			const revivedRef = lookupAgentRef(registry, "Main/worker");
			if (!revivedRef) throw new Error("Expected the revived worker ref");
			expect(revivedRef.session).toBe(revived);
			expect(await parkAgentRef(registry, revivedRef, revived)).toBe(true);
			expect(await abortAgentRef(registry, revivedRef)).toBe(true);
			expect((await store.getActor("Main/worker"))?.record.state).toBe("aborted");
		} finally {
			createSession.mockRestore();
			await store.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	it("activates the exact root head and persists parking through the owned transition", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-head-cas-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "worker.jsonl"));
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child));
		const childDispose = child.dispose;
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const rootRecord = (await store.getRoot("Main"))?.record;
			const rootActor = (await store.getActor("Main"))?.record;
			expect(rootRecord).toBeDefined();
			expect(rootActor).toMatchObject({
				rootGeneration: rootRecord?.generation,
				rootHeadHash: rootRecord?.headHash,
			});
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected the durable root authority binding");
			await binding.create({ agentId: "Main/worker" });
			const workerRef = lookupAgentRef(registry, "Main/worker");
			if (!workerRef) throw new Error("Expected the durable worker registry ref");
			expect(await setAgentStatus(registry, workerRef.id, "parked", child)).toBe(false);
			expect((await store.getActor(workerRef.id))?.record.state).toBe("active");
			expect(registry.get(workerRef.id)?.status).toBe("running");
			expect(await parkAgentRef(registry, workerRef, child)).toBe(true);
			expect((await store.getActor(workerRef.id))?.record.state).toBe("parked");
			expect(registry.get(workerRef.id)?.status).toBe("parked");
			expect(lookupAgentRef(registry, workerRef.id)?.session).toBeNull();
			expect(childDispose).toHaveBeenCalledTimes(1);
		} finally {
			createSession.mockRestore();
			await store.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("waits for a prior operation ledger drain and owns stale binding failure", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-bind-drain-"));
		const manager = SessionManager.create(directory, directory);
		const child = fakeSession(path.join(directory, "worker.jsonl"));
		const childDispose = child.dispose;
		const bindingCancelled = Promise.withResolvers<void>();
		const releaseDrain = Promise.withResolvers<void>();
		const operationStarted = Promise.withResolvers<OperationLease>();
		let root: FakeAgentSession | undefined;
		let file: string | undefined;
		let createSession: { mockRestore(): void } | undefined;
		try {
			manager.appendMessage({ role: "user", content: "prior ledger binding drain", timestamp: 1 });
			await manager.ensureOnDisk();
			file = manager.getSessionFile() ?? undefined;
			if (!file) throw new Error("Expected a materialized SessionManager root fixture");
			const store = await registryDurableStateForSession(file, {
				backend: "jsonl",
				owningSessionId: manager.getSessionId(),
				create: true,
			});
			root = fakeSession(file);
			createSession = vi
				.spyOn(sdk, "createAgentSession")
				.mockResolvedValueOnce(sessionResult(root))
				.mockResolvedValueOnce(sessionResult(child));
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main", sessionManager: manager });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected the durable root authority binding");
			// The prior SDK projection has no actor grant; attach its live store before admitting any durable phase.
			markUnregisteredSessionOperationProjection(child.sessionManager, false);
			bindSessionOperationDurability(child.sessionManager, store);
			const pendingOperationFailure = captureOutcome(
				runLocalOperation(child.sessionManager, "hold-ledger", async signal => {
					if (!signal) throw new Error("Expected the held operation cancellation signal");
					const lease = getActiveOperationLease(child.sessionManager, "hold-ledger", "local");
					if (!lease) throw new Error("Expected the held projection operation lease");
					signal.addEventListener("abort", () => bindingCancelled.resolve(), { once: true });
					operationStarted.resolve(lease);
					await releaseDrain.promise;
				}),
				work,
			);
			const heldLease = await Promise.race([
				operationStarted.promise,
				pendingOperationFailure.then(outcome => {
					if (outcome.status === "rejected") throw outcome.reason;
					throw new Error("Expected the prior ledger callback to remain held");
				}),
			]);
			const priorOperation = await store.getOperation(heldLease.ownerId, "local", "hold-ledger");
			if (!priorOperation) throw new Error("Expected durable intent and effect before authority binding");
			expect(priorOperation).toMatchObject({
				version: 2,
				record: {
					phase: "effect",
					operationId: "hold-ledger",
					effectClass: "local",
					ownerId: heldLease.ownerId,
					classOwnerId: heldLease.classOwnerId,
					acquiredAt: heldLease.acquiredAt,
					expiresAt: heldLease.expiresAt,
				},
			});
			expect(priorOperation.record.actorId).toBeUndefined();
			expect(priorOperation.record.rootId).toBeUndefined();
			expect(priorOperation.record.generation).toBeUndefined();
			let settled = false;
			const creating = captureOutcome(
				binding.create({ agentId: "Main/worker" }).then(
					value => {
						settled = true;
						return value;
					},
					error => {
						settled = true;
						throw error;
					},
				),
				work,
			);
			await Promise.race([
				bindingCancelled.promise,
				creating.then(outcome => {
					if (outcome.status === "rejected") throw outcome.reason;
					throw new Error("Expected authority binding to wait for the prior ledger drain");
				}),
			]);
			expect(settled).toBe(false);
			expect(lookupAgentRef(registry, "Main/worker")).toBeUndefined();
			const rootRef = lookupAgentRef(registry, "Main");
			if (!rootRef) throw new Error("Expected the durable root authority ref");
			let removed = false;
			const removal = trackWork(
				removeAgentRef(registry, rootRef).then(result => {
					removed = true;
					return result;
				}),
				work,
			);
			await Promise.resolve();
			expect(removed).toBe(false);
			releaseDrain.resolve();
			expectFailure(await pendingOperationFailure, /cancelled|abandoned/i);
			expect(await store.getOperation(heldLease.ownerId, "local", "hold-ledger")).toEqual({
				version: priorOperation.version + 1,
				record: { ...priorOperation.record, at: expect.any(Number), phase: "abandoned" },
			});
			expectFailure(await creating, /parent|authority|stale/i);
			expect(await removal).toBe(true);
			expect(lookupAgentRef(registry, "Main/worker")).toBeUndefined();
			expect(await store.getActor("Main/worker")).toBeUndefined();
			expect((await store.getConstruction("Main", "Main/worker", 2))?.record.phase).toBe("abandoned");
			expect(childDispose).toHaveBeenCalledTimes(1);
		} finally {
			releaseDrain.resolve();
			await cleanupFixture(
				work,
				() => (child.isDisposed ? undefined : childDispose()),
				() => (root && !root.isDisposed ? root.dispose() : undefined),
				() => createSession?.mockRestore(),
				() => manager.close(),
				async () => {
					if (file) await closeSessionAuthority(file);
				},
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("does not project a stale same-ref session status after revival", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-stale-status-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "worker.jsonl"));
		const revived = fakeSession(path.join(directory, "worker.jsonl"));
		const statusCommitted = Promise.withResolvers<void>();
		const releaseStatusAck = Promise.withResolvers<void>();
		const originalTransition = store.transition.bind(store);
		let holdStatusAck = true;
		store.transition = async (record, options) => {
			const receipt = await originalTransition(record, options);
			if (
				record.kind === "actor" &&
				record.actorId === "Main/worker" &&
				record.state === "active" &&
				holdStatusAck
			) {
				holdStatusAck = false;
				statusCommitted.resolve();
				await releaseStatusAck.promise;
			}
			return receipt;
		};
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child))
			.mockResolvedValueOnce(sessionResult(revived));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected the durable root authority binding");
			await binding.create({ agentId: "Main/worker" });
			const ref = lookupAgentRef(registry, "Main/worker");
			if (!ref) throw new Error("Expected the durable worker registry ref");
			const staleUpdate = trackWork(setAgentStatus(registry, ref.id, "idle", child), work);
			await statusCommitted.promise;
			let parkSettled = false;
			const parking = trackWork(
				parkAgentRef(registry, ref, child).then(result => {
					parkSettled = true;
					return result;
				}),
				work,
			);
			await Promise.resolve();
			expect(parkSettled).toBe(false);
			releaseStatusAck.resolve();
			expect(await staleUpdate).toBe(false);
			expect(await parking).toBe(true);
			const parked = registry.get(ref.id);
			if (!parked) throw new Error("Expected the parked worker observation");
			await binding.create({ agentId: ref.id }, parked);
			expect(await setAgentStatus(registry, ref.id, "idle", child)).toBe(false);
			expect(lookupAgentRef(registry, ref.id)).toMatchObject({ status: "running", session: revived });
			expect((await store.getActor(ref.id))?.record.state).toBe("active");
		} finally {
			releaseStatusAck.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("drains run-state persistence before root disposal completes", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-runstate-drain-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const statusCommitted = Promise.withResolvers<void>();
		const releaseStatusAck = Promise.withResolvers<void>();
		const originalTransition = store.transition.bind(store);
		let holdStatusAck = true;
		store.transition = async (record, options) => {
			const receipt = await originalTransition(record, options);
			if (record.kind === "actor" && record.actorId === "Main" && record.state === "active" && holdStatusAck) {
				holdStatusAck = false;
				statusCommitted.resolve();
				await releaseStatusAck.promise;
			}
			return receipt;
		};
		const createSession = vi.spyOn(sdk, "createAgentSession").mockResolvedValue(sessionResult(root));
		let drain: (() => Promise<void>) | undefined;
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			drain = syncAgentSessionStatus(registry, "Main", root);
			root.emitRunState("idle");
			await statusCommitted.promise;
			root.emitRunState("running");
			let disposed = false;
			const disposal = trackWork(
				root.dispose().then(() => {
					disposed = true;
				}),
				work,
			);
			await Promise.resolve();
			expect(disposed).toBe(false);
			releaseStatusAck.resolve();
			await disposal;
			expect(disposed).toBe(true);
			expect((await store.getActor("Main"))?.record.state).toBe("retired");
		} finally {
			releaseStatusAck.resolve();
			await cleanupFixture(
				work,
				() => drain?.(),
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("root disposal waits for a previously accepted child removal and reports raw cleanup failure", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-removal-drain-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const failure = new Error("child raw disposal failed");
		const originalDispose = child.dispose;
		child.dispose = vi.fn(async () => {
			started.resolve();
			await gate.promise;
			await originalDispose();
			throw failure;
		});
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected root binding");
			await binding.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child");
			if (!ref) throw new Error("Expected child ref");
			const removal = removeAgentRef(registry, ref);
			const removalFailure = captureOutcome(removal, work);
			await started.promise;
			expect(lookupAgentRef(registry, ref.id)).toBeUndefined();
			let settled = false;
			const disposal = root.dispose().finally(() => {
				settled = true;
			});
			const disposalFailure = captureOutcome(disposal, work);
			await Promise.resolve();
			expect(settled).toBe(false);
			gate.resolve();
			expectFailure(await removalFailure, failure);
			expectFailure(await disposalFailure, /descendant authority operations failed/i);
		} finally {
			gate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("root disposal waits for an accepted release callback and propagates its failure", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-release-callback-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const failure = new Error("callback failed");
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			const lifecycle = bindOwnedAgentLifecycle(registry, root);
			if (!binding || !lifecycle) throw new Error("Expected root lifecycle binding");
			await binding.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child");
			if (!ref) throw new Error("Expected child ref");
			adoptAgent(
				lifecycle,
				ref.id,
				{
					idleTtlMs: 0,
					onRelease: async () => {
						started.resolve();
						await gate.promise;
						throw failure;
					},
				},
				ref,
			);
			const release = releaseAgent(lifecycle, ref.id, ref);
			const releaseFailure = captureOutcome(release, work);
			await started.promise;
			expect(lookupAgentRef(registry, ref.id)).toBeUndefined();
			let settled = false;
			const disposal = root.dispose().finally(() => {
				settled = true;
			});
			const disposalFailure = captureOutcome(disposal, work);
			await Promise.resolve();
			expect(settled).toBe(false);
			gate.resolve();
			expectFailure(await releaseFailure, failure);
			expectFailure(await disposalFailure, /lifecycle teardown failed/i);
		} finally {
			gate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("root disposal owns a release accepted during a held park through callback failure", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-late-release-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const parkStarted = Promise.withResolvers<void>();
		const parkGate = Promise.withResolvers<void>();
		const callbackStarted = Promise.withResolvers<void>();
		const callbackGate = Promise.withResolvers<void>();
		const failure = new Error("late release callback failed");
		const originalDispose = child.dispose;
		child.dispose = vi.fn(async () => {
			parkStarted.resolve();
			await parkGate.promise;
			await originalDispose();
		});
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			const lifecycle = bindOwnedAgentLifecycle(registry, root);
			if (!binding || !lifecycle) throw new Error("Expected root lifecycle");
			await binding.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child")!;
			adoptAgent(
				lifecycle,
				ref.id,
				{
					idleTtlMs: 0,
					onRelease: async () => {
						callbackStarted.resolve();
						await callbackGate.promise;
						throw failure;
					},
				},
				ref,
			);
			let settled = false;
			const disposal = root.dispose().finally(() => {
				settled = true;
			});
			const disposalFailure = captureOutcome(disposal, work);
			await parkStarted.promise;
			const release = releaseAgent(lifecycle, ref.id, ref);
			const releaseFailure = captureOutcome(release, work);
			parkGate.resolve();
			await callbackStarted.promise;
			expect(settled).toBe(false);
			expect(lookupAgentRef(registry, ref.id)).toBeUndefined();
			callbackGate.resolve();
			expectFailure(await releaseFailure, failure);
			expectFailure(await disposalFailure, /lifecycle teardown failed/i);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
		} finally {
			parkGate.resolve();
			callbackGate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("propagates a held notification failure while retiring with another notification queued", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-retirement-failure-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const failure = new Error("notification failure");
		const original = store.transition.bind(store);
		let fail = false;
		store.transition = async (record, options) => {
			if (fail && record.kind === "actor" && record.state === "active") {
				entered.resolve();
				await gate.promise;
				throw failure;
			}
			return original(record, options);
		};
		const createSession = vi.spyOn(sdk, "createAgentSession").mockResolvedValue(sessionResult(root));
		let drain: (() => Promise<void>) | undefined;
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			drain = syncAgentSessionStatus(registry, "Main", root);
			fail = true;
			root.emitRunState("idle");
			await entered.promise;
			root.emitRunState("running");
			const disposal = root.dispose();
			const rejection = captureOutcome(disposal, work);
			gate.resolve();
			expectFailure(await rejection, /run-state persistence failed/);
			await expect(drain()).rejects.toThrow(/run-state persistence failed/);
			drain = undefined;
		} finally {
			gate.resolve();
			await cleanupFixture(
				work,
				() => drain?.(),
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it.each(["park", "abort"] as const)(
		"surfaces a run-state persistence failure before %s detaches the session",
		async action => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-notification-failure-"));
			const store = persistentStore(path.join(directory, "authority.jsonl"));
			const root = fakeSession(path.join(directory, "main.jsonl"));
			const child = fakeSession(path.join(directory, "child.jsonl"));
			const failure = new Error("notification write failed");
			const failedWrite = Promise.withResolvers<void>();
			const originalTransition = store.transition.bind(store);
			let failNotification = false;
			store.transition = async (record, options) => {
				if (
					failNotification &&
					record.kind === "actor" &&
					record.actorId === "Main/child" &&
					record.state === "active"
				) {
					failedWrite.resolve();
					throw failure;
				}
				return originalTransition(record, options);
			};
			const createSession = vi
				.spyOn(sdk, "createAgentSession")
				.mockResolvedValueOnce(sessionResult(root))
				.mockResolvedValueOnce(sessionResult(child));
			try {
				const registry = await AgentRegistry.create({ durableState: store });
				await createAgentRootSession(registry, { agentId: "Main" });
				const binding = bindInternalAgentAuthoritySession(registry, root);
				if (!binding) throw new Error("Expected root binding");
				await binding.create({ agentId: "Main/child" });
				const ref = lookupAgentRef(registry, "Main/child");
				if (!ref) throw new Error("Expected child ref");
				syncAgentSessionStatus(registry, ref.id, child);
				failNotification = true;
				child.emitRunState("idle");
				await failedWrite.promise;
				const terminal =
					action === "park" ? parkAgentRef(registry, ref, child) : abortAgentRef(registry, ref, child);
				await expect(terminal).rejects.toThrow(/run-state persistence failed/);
				expect(lookupAgentRef(registry, ref.id)?.session).toBe(child);
			} finally {
				createSession.mockRestore();
				await store.close();
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("recovers a staged replacement when candidate creation fails before quiescing", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-staged-failure-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const source = fakeSession(path.join(directory, "main.jsonl"));
		const failure = new Error("candidate creation failed");
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(source))
			.mockRejectedValueOnce(failure);
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const before = (await store.getRoot("Main"))?.record;
			if (!before) throw new Error("Expected original root authority");
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toBe(failure);
			expect((await store.getRoot("Main"))?.record).toEqual(before);
			expect((await store.getGate("Main"))?.record.phase).toBe("open");
			expect(lookupAgentRef(registry, "Main")?.session).toBe(source);
			const transition = (
				await store.getTransition("Main", `root-replacement:Main:${before.generation}:${before.generation + 1}`)
			)?.record;
			expect(transition).toMatchObject({ phase: "recovered", recovery: true, sourceHeadHash: before.headHash });
			const exported = await store.exportState();
			expect(
				exported.controls.some(
					control => control.key === `root-generation:${JSON.stringify(["Main", before.generation + 1])}`,
				),
			).toBe(true);
			expect((await store.recoveryState()).generationHighWater).toBeGreaterThan(before.generation);
		} finally {
			createSession.mockRestore();
			await store.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("uses coherent recovery before CAS and never rolls back a committed root replacement", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-root-recovery-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const source = fakeSession(path.join(directory, "main.jsonl"));
		let candidateDisposed = false;
		const candidate = fakeSession(path.join(directory, "replacement.jsonl"));
		const originalCandidateDispose = candidate.dispose;
		candidate.dispose = vi.fn(async () => {
			candidateDisposed = true;
			await originalCandidateDispose();
		});
		const originalTransition = store.transition.bind(store);
		store.transition = async (record, options) => {
			if (record.kind === "transition" && record.phase === "validated") throw new Error("injected pre-CAS failure");
			return originalTransition(record, options);
		};
		const recoveredInputs: Parameters<AuthorityStore["commitRootTransition"]>[0][] = [];
		const originalCommit = store.commitRootTransition.bind(store);
		vi.spyOn(store, "commitRootTransition").mockImplementation(async input => {
			if (input.transition.phase === "recovered") {
				expect(candidateDisposed).toBe(true);
				recoveredInputs.push(input);
			}
			return originalCommit(input);
		});
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(source))
			.mockResolvedValueOnce(sessionResult(candidate));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const sourceRoot = (await store.getRoot("Main"))?.record;
			if (!sourceRoot) throw new Error("Expected the source root record");
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toThrow(
				"injected pre-CAS failure",
			);
			expect(recoveredInputs).toHaveLength(1);
			expect(recoveredInputs[0]).toMatchObject({
				transition: {
					phase: "recovered",
					recovery: true,
					sourceGeneration: sourceRoot.generation,
					sourceHeadHash: sourceRoot.headHash,
				},
				expectedRootGeneration: sourceRoot.generation,
				expectedRootHeadHash: sourceRoot.headHash,
				root: sourceRoot,
				gate: { rootId: "Main", generation: sourceRoot.generation, phase: "open" },
			});
			expect(await store.getRoot("Main")).toMatchObject({
				record: { generation: sourceRoot.generation, state: "active" },
			});
			expect(await store.getGate("Main")).toMatchObject({
				record: { generation: sourceRoot.generation, phase: "open" },
			});
		} finally {
			createSession.mockRestore();
			await store.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps a committed root replacement forward-only after a post-CAS error", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-root-forward-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const source = fakeSession(path.join(directory, "main.jsonl"));
		const destination = fakeSession(path.join(directory, "replacement.jsonl"));
		const originalTransition = store.transition.bind(store);
		store.transition = async (record, options) => {
			if (record.kind === "transition" && record.phase === "activated") throw new Error("injected post-CAS failure");
			return originalTransition(record, options);
		};
		const recoveredInputs: Parameters<AuthorityStore["commitRootTransition"]>[0][] = [];
		const originalCommit = store.commitRootTransition.bind(store);
		vi.spyOn(store, "commitRootTransition").mockImplementation(async input => {
			if (input.transition.phase === "recovered") recoveredInputs.push(input);
			return originalCommit(input);
		});
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(source))
			.mockResolvedValueOnce(sessionResult(destination));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const sourceGeneration = registry.get("Main")?.lineage?.generation;
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toThrow(
				"injected post-CAS failure",
			);
			expect(recoveredInputs).toHaveLength(0);
			expect((await store.getRoot("Main"))?.record.generation).toBeGreaterThan(sourceGeneration ?? 0);
			expect((await store.getGate("Main"))?.record.phase).toBe("open");
			expect(lookupAgentRef(registry, "Main")?.session).toBe(destination);
		} finally {
			createSession.mockRestore();
			await store.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("blocks new child admission and drains accepted construction before root disposal", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-registry-root-drain-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "worker.jsonl"));
		const pendingChild = fakeSession(path.join(directory, "pending.jsonl"));
		const childDisposeStarted = Promise.withResolvers<void>();
		const finishChildDispose = Promise.withResolvers<void>();
		const pendingConstructionStarted = Promise.withResolvers<void>();
		const finishPendingConstruction = Promise.withResolvers<sdk.CreateAgentSessionResult>();
		const originalChildDispose = child.dispose;
		child.dispose = vi.fn(async () => {
			childDisposeStarted.resolve();
			await finishChildDispose.promise;
			await originalChildDispose();
		});
		const pendingChildDispose = vi.spyOn(pendingChild, "dispose");
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.agentId === "Main") return sessionResult(root);
			if (options.agentId === "Main/worker") return sessionResult(child);
			if (options.agentId === "Main/pending") {
				pendingConstructionStarted.resolve();
				return finishPendingConstruction.promise;
			}
			throw new Error(`Unexpected authority actor ${options.agentId}`);
		});
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected the durable root authority binding");
			await binding.create({ agentId: "Main/worker" });
			const pendingCreate = captureOutcome(binding.create({ agentId: "Main/pending" }), work);
			await pendingConstructionStarted.promise;
			let disposed = false;
			const disposal = trackWork(
				root.dispose().then(() => {
					disposed = true;
				}),
				work,
			);
			await Promise.resolve();
			await expect(binding.create({ agentId: "Main/late" })).rejects.toThrow(
				/^Agent root "Main" is being terminated\.$/,
			);
			expect(lookupAgentRef(registry, "Main/late")).toBeUndefined();
			expect(disposed).toBe(false);
			finishPendingConstruction.resolve(sessionResult(pendingChild));
			expectFailure(await pendingCreate, /parent|authority|construction/i);
			await childDisposeStarted.promise;
			expect(disposed).toBe(false);
			finishChildDispose.resolve();
			await disposal;
			expect(disposed).toBe(true);
			expect(pendingChildDispose).toHaveBeenCalledTimes(1);
			expect(lookupAgentRef(registry, "Main/pending")).toBeUndefined();
			expect((await store.getConstruction("Main", "Main/pending", 3))?.record.phase).toBe("abandoned");
			expect((await store.getActor("Main"))?.record.state).toBe("retired");
		} finally {
			finishChildDispose.resolve();
			finishPendingConstruction.resolve(sessionResult(pendingChild));
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("reopens a retired root above retained high-water without reviving terminal history", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-retired-root-"));
		const file = path.join(directory, "authority.jsonl");
		let store = persistentStore(file);
		const source = fakeSession(path.join(directory, "main.jsonl"));
		const destination = fakeSession(path.join(directory, "main.jsonl"));
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(source))
			.mockResolvedValueOnce(sessionResult(destination));
		try {
			const first = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(first, { agentId: "Main" });
			const sourceGeneration = first.get("Main")!.lineage!.generation;
			await source.dispose();
			expect((await store.getRoot("Main"))?.record.state).toBe("active");
			expect((await store.getActor("Main"))?.record.state).toBe("retired");
			const highWater = (await store.recoveryState()).generationHighWater;
			await store.close();
			store = persistentStore(file, false);
			const reopened = await AgentRegistry.create({ durableState: store });
			expect((await store.getGate("Main"))?.record).toMatchObject({ generation: sourceGeneration, phase: "closed" });
			await createAgentRootSession(reopened, { agentId: "Main" });
			const actor = (await store.getActor("Main"))!.record;
			expect(actor.generation).toBeGreaterThan(highWater);
			expect(actor.rootGeneration).toBe(actor.generation);
			expect((await store.getActorGeneration("Main", sourceGeneration))?.record.state).toBe("retired");
			expect((await store.getRoot("Main"))?.record.generation).toBe(actor.generation);
			expect((await store.getGate("Main"))?.record).toMatchObject({ generation: actor.generation, phase: "open" });
		} finally {
			createSession.mockRestore();
			await store.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	for (const backend of ["jsonl", "sqlite"] as const) {
		for (const { recoverOwner, failurePhase } of [
			{ recoverOwner: false, failurePhase: "quiesced" },
			{ recoverOwner: true, failurePhase: "quiescing" },
			{ recoverOwner: true, failurePhase: "quiesced" },
		] as const) {
			it(`cleans the retained-root candidate before known ${failurePhase} failure recovery on ${backend} (${recoverOwner ? "recovered" : "same"} owner)`, async () => {
				const work: FixtureWork[] = [];
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-retained-pre-cas-"));
				const manager = SessionManager.create(directory, directory);
				manager.appendMessage({ role: "user", content: "retained root recovery", timestamp: 1 });
				await manager.ensureOnDisk();
				const file = manager.getSessionFile()!;
				const source = fakeSession(file);
				const candidate = fakeSession(file);
				const destination = fakeSession(file);
				const cleanupStarted = Promise.withResolvers<void>();
				const cleanupGate = Promise.withResolvers<void>();
				const order: string[] = [];
				const candidateDispose = vi.fn(async () => {
					cleanupStarted.resolve();
					await cleanupGate.promise;
					order.push("candidate-disposed");
				});
				candidate.dispose = candidateDispose;
				const createSession = vi
					.spyOn(sdk, "createAgentSession")
					.mockResolvedValueOnce(sessionResult(source))
					.mockResolvedValueOnce(sessionResult(candidate))
					.mockResolvedValueOnce(sessionResult(destination));
				let admitting: Promise<sdk.CreateAgentSessionResult> | undefined;
				try {
					let store = await registryDurableStateForSession(file, {
						backend,
						owningSessionId: manager.getSessionId(),
						create: true,
					});
					const first = await AgentRegistry.create({ durableState: store });
					await createAgentRootSession(first, { agentId: "Main", sessionManager: manager });
					await source.dispose();
					const sourceRoot = (await store.getRoot("Main"))!.record;
					if (recoverOwner) {
						await closeSessionAuthority(file);
						store = await registryDurableStateForSession(file);
					}
					const registry = await AgentRegistry.create({ durableState: store });
					const sourceGate = (await store.getGate("Main"))!.record;
					expect(sourceGate).toMatchObject({
						generation: sourceRoot.generation,
						phase: recoverOwner ? "closed" : "open",
					});
					const beforeHighWater = (await store.recoveryState()).generationHighWater;
					const reservationGeneration = beforeHighWater + 1;
					const transitionId = `root-reopen:Main:${sourceRoot.generation}:${reservationGeneration}`;
					const failure = new Error(`known retained-root ${failurePhase} rejection`);
					const originalBatch = store.transitionBatch.bind(store);
					let rejectBoundary = true;
					store.transitionBatch = async (records, options) => {
						if (
							rejectBoundary &&
							records.some(record => record.kind === "transition" && record.phase === failurePhase)
						) {
							rejectBoundary = false;
							throw failure;
						}
						return originalBatch(records, options);
					};
					const originalCommit = store.commitRootTransition.bind(store);
					store.commitRootTransition = async (input, options) => {
						if (input.transition.phase === "recovered") {
							expect(order).toEqual(["candidate-disposed"]);
							expect(input).toMatchObject({
								transition: { transitionId, phase: "recovered", recovery: true },
								expectedRootGeneration: sourceRoot.generation,
								expectedRootHeadHash: sourceRoot.headHash,
								root: sourceRoot,
								gate: { ...sourceGate, phase: "open" },
							});
							order.push("recovering");
						}
						return originalCommit(input, options);
					};
					admitting = createAgentRootSession(registry, { agentId: "Main", sessionManager: manager });
					const rejected = captureOutcome(admitting, work);
					await cleanupStarted.promise;
					expect(order).toEqual([]);
					expect((await store.getRoot("Main"))?.record).toEqual(sourceRoot);
					expect((await store.getGate("Main"))?.record).toMatchObject({
						generation: sourceRoot.generation,
						phase: failurePhase === "quiescing" ? sourceGate.phase : "quiescing",
					});
					expect((await store.getTransition("Main", transitionId))?.record.phase).toBe(
						failurePhase === "quiescing" ? "staged" : "quiescing",
					);
					cleanupGate.resolve();
					expectFailure(await rejected, failure);
					expect(order).toEqual(["candidate-disposed", "recovering"]);
					expect(candidateDispose).toHaveBeenCalledTimes(1);
					expect(lookupAgentRef(registry, "Main")).toBeUndefined();
					expect((await store.getRoot("Main"))?.record).toEqual(sourceRoot);
					expect((await store.getGate("Main"))?.record).toEqual({ ...sourceGate, phase: "open" });
					expect((await store.getActor("Main"))?.record).toMatchObject({
						state: "retired",
						generation: sourceRoot.generation,
					});
					expect((await store.getConstruction("Main", "Main", reservationGeneration))?.record.phase).toBe(
						"abandoned",
					);
					expect((await store.getTransition("Main", transitionId))?.record).toMatchObject({
						phase: "recovered",
						recovery: true,
						sourceHeadHash: sourceRoot.headHash,
					});
					const recoveredState = await store.recoveryState();
					expect(recoveredState.blocked).toEqual([]);
					expect(recoveredState.generationHighWater).toBeGreaterThanOrEqual(reservationGeneration);
					const consumedKey = `root-generation:${JSON.stringify(["Main", reservationGeneration])}`;
					const consumed = (await store.exportState()).controls.find(control => control.key === consumedKey);
					expect(consumed).toMatchObject({
						value: { record: { generation: reservationGeneration, state: "invalidated" } },
					});
					await createAgentRootSession(registry, { agentId: "Main", sessionManager: manager });
					const destinationActor = (await store.getActor("Main"))!.record;
					expect(destinationActor.generation).toBeGreaterThan(recoveredState.generationHighWater);
					expect(destinationActor.state).toBe("active");
					expect(lookupAgentRef(registry, "Main")?.session).toBe(destination);
					expect((await store.getActorGeneration("Main", sourceRoot.generation))?.record.state).toBe("retired");
					expect((await store.exportState()).controls.find(control => control.key === consumedKey)).toEqual(
						consumed,
					);
					await destination.dispose();
				} finally {
					cleanupGate.resolve();
					await cleanupFixture(
						work,
						() => createSession.mockRestore(),
						() => manager.close(),
						() => closeSessionAuthority(file),
						() => fs.rm(directory, { recursive: true, force: true }),
					);
				}
			});
		}
	}

	for (const boundary of ["unknown-cas", "post-cas"] as const) {
		for (const recoverOwner of [false, true]) {
			it(`keeps retained-root admission fail-closed and forward-only after ${boundary} (${recoverOwner ? "recovered" : "same"} owner)`, async () => {
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-retained-forward-"));
				const manager = SessionManager.create(directory, directory);
				manager.appendMessage({ role: "user", content: "retained root recovery forward evidence", timestamp: 1 });
				await manager.ensureOnDisk();
				const file = manager.getSessionFile()!;
				const source = fakeSession(file);
				const candidate = fakeSession(file);
				const candidateDispose = candidate.dispose;
				const failure = Object.assign(new Error(`retained-root ${boundary} failure`), {
					unknownOutcome: boundary === "unknown-cas",
					requestId: "retained-root-cas-request",
				});
				const inspectionFailure = new Error("retained-root CAS evidence unavailable");
				const work: FixtureWork[] = [];
				const createSession = vi
					.spyOn(sdk, "createAgentSession")
					.mockResolvedValueOnce(sessionResult(source))
					.mockResolvedValueOnce(sessionResult(candidate));
				try {
					let store = await registryDurableStateForSession(file, {
						backend: "jsonl",
						owningSessionId: manager.getSessionId(),
						create: true,
					});
					const first = await AgentRegistry.create({ durableState: store });
					await createAgentRootSession(first, { agentId: "Main", sessionManager: manager });
					await source.dispose();
					if (recoverOwner) {
						await closeSessionAuthority(file);
						store = await registryDurableStateForSession(file);
					}
					const registry = await AgentRegistry.create({ durableState: store });
					expect((await store.getGate("Main"))?.record.phase).toBe(recoverOwner ? "closed" : "open");
					const sourceRoot = (await store.getRoot("Main"))!.record;
					const generation = (await store.recoveryState()).generationHighWater + 1;
					const transitionId = `root-reopen:Main:${sourceRoot.generation}:${generation}`;
					const getRoot = store.getRoot.bind(store);
					const getTransition = store.getTransition.bind(store);
					const commit = store.commitRootTransition.bind(store);
					let recovered = 0;
					let casFailed = false;
					store.commitRootTransition = async (input, options) => {
						if (input.transition.phase === "recovered") recovered++;
						const receipt = await commit(input, options);
						if (boundary === "unknown-cas" && input.transition.phase === "cas-committed") {
							casFailed = true;
							throw failure;
						}
						return receipt;
					};
					store.getRoot = async rootId => {
						if (casFailed) throw inspectionFailure;
						return getRoot(rootId);
					};
					store.getTransition = async (rootId, id) => {
						if (casFailed) throw inspectionFailure;
						return getTransition(rootId, id);
					};
					const transition = store.transition.bind(store);
					store.transition = async (record, options) => {
						if (boundary === "post-cas" && record.kind === "transition" && record.phase === "activated")
							throw failure;
						return transition(record, options);
					};
					const admitting = captureOutcome(
						createAgentRootSession(registry, { agentId: "Main", sessionManager: manager }),
						work,
					);
					if (boundary === "unknown-cas") {
						const outcome = await admitting;
						expect(outcome.status).toBe("rejected");
						if (outcome.status !== "rejected") throw new Error("Expected the owned operation to reject.");
						const error = outcome.reason;
						expect(error).toBeInstanceOf(AggregateError);
						expect((error as AggregateError).errors).toEqual([failure, inspectionFailure]);
						expect(failure).toMatchObject({ unknownOutcome: true, requestId: "retained-root-cas-request" });
					} else {
						expectFailure(await admitting, failure);
					}
					expect(recovered).toBe(0);
					expect(candidateDispose).not.toHaveBeenCalled();
					expect(lookupAgentRef(registry, "Main")).toBeUndefined();
					expect((await getRoot("Main"))?.record).toMatchObject({ generation, state: "active" });
					expect((await getTransition("Main", transitionId))?.record).toMatchObject({
						phase: "cas-committed",
						sourceHeadHash: sourceRoot.headHash,
						destinationGeneration: generation,
					});
					expect((await store.getGate("Main"))?.record).toMatchObject({
						generation: boundary === "unknown-cas" ? sourceRoot.generation : generation,
						phase: boundary === "unknown-cas" ? "closed" : "open",
					});
					expect((await store.getConstruction("Main", "Main", generation))?.record.phase).toBe(
						boundary === "unknown-cas" ? "constructed" : "activated",
					);
					expect((await store.getActorGeneration("Main", sourceRoot.generation))?.record.state).toBe("retired");
					expectFailure(
						await captureOutcome(
							createAgentRootSession(registry, { agentId: "Main", sessionManager: manager }),
							work,
						),
						/unresolved|reserved/i,
					);
					expect(candidateDispose).not.toHaveBeenCalled();
					await candidate.dispose();
				} finally {
					await cleanupFixture(
						work,
						() => createSession.mockRestore(),
						() => manager.close(),
						() => closeSessionAuthority(file),
						() => fs.rm(directory, { recursive: true, force: true }),
					);
				}
			});
		}
	}

	it.each(["replacement", "disposal"] as const)(
		"settles a nested subtree before parking an intermediate actor and root %s",
		async action => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-parked-subtree-"));
			const store = persistentStore(path.join(directory, "authority.jsonl"));
			const root = fakeSession(path.join(directory, "main.jsonl"));
			const destination = fakeSession(path.join(directory, "replacement.jsonl"));
			const child = fakeSession(path.join(directory, "child.jsonl"));
			const grandchild = fakeSession(path.join(directory, "grandchild.jsonl"));
			let rootCreations = 0;
			const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
				if (options.agentId === "Main") return sessionResult(++rootCreations === 1 ? root : destination);
				if (options.agentId === "Main/Child") return sessionResult(child);
				if (options.agentId === "Main/Child/Grandchild") return sessionResult(grandchild);
				throw new Error(`Unexpected actor ${options.agentId}`);
			});
			let lifecycle: AgentLifecycleManager | undefined;
			try {
				const registry = await AgentRegistry.create({ durableState: store });
				lifecycle = createAgentLifecycleManager(registry);
				await createAgentRootSession(registry, { agentId: "Main" });
				await bindInternalAgentAuthoritySession(registry, root)!.create({ agentId: "Main/Child" });
				const childRef = lookupAgentRef(registry, "Main/Child");
				if (!childRef) throw new Error("Expected durable child");
				await bindInternalAgentAuthoritySession(registry, child)!.create({ agentId: "Main/Child/Grandchild" });
				adoptAgent(lifecycle, childRef.id, { idleTtlMs: 0 }, childRef);
				await parkAgent(lifecycle, childRef.id);
				expect(lookupAgentRef(registry, childRef.id)).toMatchObject({ status: "parked", session: null });
				expect((await store.getActor(childRef.id))?.record.state).toBe("parked");
				expect(lookupAgentRef(registry, "Main/Child/Grandchild")).toBeUndefined();
				expect((await store.getActor("Main/Child/Grandchild"))?.record.state).toBe("retired");
				expect((await store.getActor("Main"))?.record.state).toBe("active");
				if (action === "replacement") {
					await createAgentRootSession(registry, { agentId: "Main" });
					expect(lookupAgentRef(registry, childRef.id)).toBeUndefined();
					expect(lookupAgentRef(registry, "Main")?.session).toBe(destination);
				} else {
					const rootRef = lookupAgentRef(registry, "Main");
					if (!rootRef) throw new Error("Expected durable root");
					expect(await removeAgentRef(registry, rootRef)).toBe(true);
					expect(lookupAgentRef(registry, childRef.id)).toBeUndefined();
					expect((await store.getActor("Main"))?.record.state).toBe("retired");
				}
			} finally {
				await cleanupFixture(
					[],
					() => lifecycle && disposeAgentLifecycle(lifecycle),
					() => createSession.mockRestore(),
					() => store.close(),
					() => fs.rm(directory, { recursive: true, force: true }),
				);
			}
		},
	);
	it("holds detached park operations in the source fence until callback disposal settles", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-detached-park-"));
		const manager = SessionManager.create(directory, directory);
		manager.appendMessage({ role: "user", content: "detached park effect root", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		const store = await registryDurableStateForSession(file, {
			owningSessionId: manager.getSessionId(),
			create: true,
		});
		const root = fakeSession(file);
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const destination = fakeSession(path.join(directory, "replacement.jsonl"));
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const disposing = Promise.withResolvers<void>();
		const quiescing = Promise.withResolvers<void>();
		const originalDispose = child.dispose;
		const callbackSettled = Promise.withResolvers<void>();
		child.dispose = vi.fn(async options => {
			disposing.resolve();
			await originalDispose(options);
		});
		const originalBatch = store.transitionBatch.bind(store);
		store.transitionBatch = async (records, options) => {
			const receipt = await originalBatch(records, options);
			if (records.some(record => record.kind === "transition" && record.phase === "quiescing")) quiescing.resolve();
			return receipt;
		};
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child))
			.mockResolvedValueOnce(sessionResult(destination));
		let lifecycle: AgentLifecycleManager | undefined;
		let parking: Promise<void> | undefined;
		let replacing: Promise<sdk.CreateAgentSessionResult> | undefined;
		let casCount = 0;
		const commit = store.commitRootTransition.bind(store);
		store.commitRootTransition = async (input, options) => {
			if (input.transition.phase === "cas-committed") casCount++;
			return commit(input, options);
		};
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			lifecycle = createAgentLifecycleManager(registry);
			await createAgentRootSession(registry, { agentId: "Main", sessionManager: manager });
			await bindInternalAgentAuthoritySession(registry, root)!.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child")!;
			adoptAgent(lifecycle, ref.id, { idleTtlMs: 0 }, ref);
			const heldOperation = runLocalOperation(child.sessionManager, "held-park-callback", async () => {
				started.resolve();
				try {
					await release.promise;
				} finally {
					callbackSettled.resolve();
				}
			});
			const cancellation = captureOutcome(heldOperation, work);
			await started.promise;
			parking = trackWork(parkAgent(lifecycle, ref.id), work);
			await disposing.promise;
			replacing = trackWork(createAgentRootSession(registry, { agentId: "Main" }), work);
			await quiescing.promise;
			expect(lookupAgentRef(registry, ref.id)).toMatchObject({ status: "parked", session: null });
			expect((await store.getGate("Main"))?.record.phase).toBe("quiescing");
			expect(casCount).toBe(0);
			release.resolve();
			await callbackSettled.promise;
			expectFailure(await cancellation, /cancelled/i);
			await Promise.all([parking, replacing]);
			expect(casCount).toBe(1);
			expect((await store.getActor(ref.id))?.record.state).toBe("retired");
		} finally {
			release.resolve();
			await cleanupFixture(
				work,
				() => lifecycle && disposeAgentLifecycle(lifecycle),
				() => createSession.mockRestore(),
				() => manager.close(),
				() => closeSessionAuthority(file),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("drains a successful park admitted while replacement construction is pending", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-park-admitted-during-replacement-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const candidate = fakeSession(path.join(directory, "candidate.jsonl"));
		const constructionStarted = Promise.withResolvers<void>();
		const finishConstruction = Promise.withResolvers<sdk.CreateAgentSessionResult>();
		const disposalStarted = Promise.withResolvers<void>();
		const releaseDisposal = Promise.withResolvers<void>();
		const quiescing = Promise.withResolvers<void>();
		const originalChildDispose = child.dispose;
		child.dispose = vi.fn(async () => {
			disposalStarted.resolve();
			await releaseDisposal.promise;
			await originalChildDispose();
		});
		let rootCreations = 0;
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.agentId === "Main") {
				if (++rootCreations === 1) return sessionResult(root);
				constructionStarted.resolve();
				return finishConstruction.promise;
			}
			if (options.agentId === "Main/child") return sessionResult(child);
			throw new Error(`Unexpected actor ${options.agentId}`);
		});
		const originalBatch = store.transitionBatch.bind(store);
		store.transitionBatch = async (records, options) => {
			const receipt = await originalBatch(records, options);
			if (records.some(record => record.kind === "transition" && record.phase === "quiescing")) quiescing.resolve();
			return receipt;
		};
		let lifecycle: AgentLifecycleManager | undefined;
		let parking: Promise<void> | undefined;
		let replacing: Promise<sdk.CreateAgentSessionResult> | undefined;
		let casCount = 0;
		const originalCommit = store.commitRootTransition.bind(store);
		store.commitRootTransition = async (input, options) => {
			if (input.transition.phase === "cas-committed") casCount++;
			return originalCommit(input, options);
		};
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			lifecycle = createAgentLifecycleManager(registry);
			await createAgentRootSession(registry, { agentId: "Main" });
			await bindInternalAgentAuthoritySession(registry, root)!.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child")!;
			adoptAgent(lifecycle, ref.id, { idleTtlMs: 0 }, ref);
			replacing = trackWork(createAgentRootSession(registry, { agentId: "Main" }), work);
			await constructionStarted.promise;
			parking = trackWork(parkAgent(lifecycle, ref.id), work);
			await disposalStarted.promise;
			finishConstruction.resolve(sessionResult(candidate));
			await quiescing.promise;
			expect((await store.getGate("Main"))?.record.phase).toBe("quiescing");
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			expect(casCount).toBe(0);
			releaseDisposal.resolve();
			await Promise.all([parking, replacing]);
			expect(casCount).toBe(1);
			expect((await store.getActor(ref.id))?.record.state).toBe("retired");
			expect(lookupAgentRef(registry, "Main")?.session).toBe(candidate);
		} finally {
			releaseDisposal.resolve();
			finishConstruction.resolve(sessionResult(candidate));
			await cleanupFixture(
				work,
				() => lifecycle && disposeAgentLifecycle(lifecycle),
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("settles an accepted lifecycle revival before source quiescence and root CAS", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-revival-fence-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const revived = fakeSession(path.join(directory, "child.jsonl"));
		const destination = fakeSession(path.join(directory, "destination.jsonl"));
		const revivalStarted = Promise.withResolvers<void>();
		const releaseRevival = Promise.withResolvers<void>();
		const destinationStarted = Promise.withResolvers<void>();
		const quiescing = Promise.withResolvers<void>();
		const originalBatch = store.transitionBatch.bind(store);
		store.transitionBatch = async (records, options) => {
			const receipt = await originalBatch(records, options);
			if (records.some(record => record.kind === "transition" && record.phase === "quiescing")) quiescing.resolve();
			return receipt;
		};
		let rootCreations = 0;
		let childCreations = 0;
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.agentId === "Main") {
				if (++rootCreations === 1) return sessionResult(root);
				destinationStarted.resolve();
				return sessionResult(destination);
			}
			if (options.agentId === "Main/child") {
				if (++childCreations === 1) return sessionResult(child);
				revivalStarted.resolve();
				await releaseRevival.promise;
				return sessionResult(revived);
			}
			throw new Error(`Unexpected actor ${options.agentId}`);
		});
		let lifecycle: AgentLifecycleManager | undefined;
		let reviving: Promise<AgentSession> | undefined;
		let replacing: Promise<sdk.CreateAgentSessionResult> | undefined;
		let replacementSettled = false;
		let casCount = 0;
		const originalCommit = store.commitRootTransition.bind(store);
		store.commitRootTransition = async (input, options) => {
			if (input.transition.phase === "cas-committed") casCount++;
			return originalCommit(input, options);
		};
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			lifecycle = bindOwnedAgentLifecycle(registry, root);
			if (!lifecycle) throw new Error("Expected the root-owned lifecycle manager");
			const binding = bindInternalAgentAuthoritySession(registry, root);
			if (!binding) throw new Error("Expected the bound root authority");
			await binding.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child");
			if (!ref) throw new Error("Expected the durable child ref");
			adoptAgent(
				lifecycle,
				ref.id,
				{
					idleTtlMs: 0,
					revive: async expected => (await binding.create({ agentId: ref.id }, expected)).session,
				},
				ref,
			);
			await parkAgent(lifecycle, ref.id);
			reviving = trackWork(ensureAgentLive(lifecycle, ref.id), work);
			await revivalStarted.promise;
			replacing = trackWork(
				createAgentRootSession(registry, { agentId: "Main" }).then(
					result => {
						replacementSettled = true;
						return result;
					},
					error => {
						replacementSettled = true;
						throw error;
					},
				),
				work,
			);
			await destinationStarted.promise;
			expect(replacementSettled).toBe(false);
			expect(casCount).toBe(0);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			releaseRevival.resolve();
			expect(await reviving).toBe(revived);
			await quiescing.promise;
			expect(replacementSettled).toBe(false);
			expect(casCount).toBe(0);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			await replacing;
			expect(casCount).toBe(1);
			expect((await store.getActor(ref.id))?.record.state).toBe("retired");
		} finally {
			releaseRevival.resolve();
			await cleanupFixture(
				work,
				() => lifecycle && disposeAgentLifecycle(lifecycle),
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("owns a park accepted during replacement and retains the source tree on disposal failure", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-park-during-replacement-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const candidate = fakeSession(path.join(directory, "candidate.jsonl"));
		const constructionStarted = Promise.withResolvers<void>();
		const finishConstruction = Promise.withResolvers<sdk.CreateAgentSessionResult>();
		const disposalStarted = Promise.withResolvers<void>();
		const releaseDisposal = Promise.withResolvers<void>();
		const failure = new Error("park disposal failed");
		const originalChildDispose = child.dispose;
		child.dispose = vi.fn(async () => {
			disposalStarted.resolve();
			await releaseDisposal.promise;
			await originalChildDispose();
			throw failure;
		});
		let rootCreations = 0;
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.agentId === "Main") {
				if (++rootCreations === 1) return sessionResult(root);
				constructionStarted.resolve();
				return finishConstruction.promise;
			}
			if (options.agentId === "Main/child") return sessionResult(child);
			throw new Error(`Unexpected actor ${options.agentId}`);
		});
		let lifecycle: AgentLifecycleManager | undefined;
		let parking: Promise<PromiseSettledResult<void>> | undefined;
		let replacing: Promise<PromiseSettledResult<sdk.CreateAgentSessionResult>> | undefined;
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			lifecycle = bindOwnedAgentLifecycle(registry, root);
			if (!lifecycle) throw new Error("Expected the root-owned lifecycle manager");
			const binding = bindInternalAgentAuthoritySession(registry, root)!;
			await binding.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child")!;
			adoptAgent(
				lifecycle,
				ref.id,
				{ idleTtlMs: 0, revive: async expected => (await binding.create({ agentId: ref.id }, expected)).session },
				ref,
			);
			replacing = captureOutcome(createAgentRootSession(registry, { agentId: "Main" }), work);
			await constructionStarted.promise;
			parking = captureOutcome(parkAgent(lifecycle, ref.id), work);
			await disposalStarted.promise;
			finishConstruction.resolve(sessionResult(candidate));
			releaseDisposal.resolve();
			expectFailure(await parking, failure);
			expectFailure(await replacing, /descendant authority operations failed/i);
			expect(lookupAgentRef(registry, "Main")?.session).toBe(root);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			expect(lookupAgentRef(registry, ref.id)).toMatchObject({ status: "parked", session: null });
			expect((await store.getActor(ref.id))?.record.state).toBe("parked");
			expect((await store.getGate("Main"))?.record.phase).toBe("open");
			const failedRevival = ensureAgentLive(lifecycle, ref.id);
			await expect(failedRevival).rejects.toThrow(/still owns a session whose disposal failed/i);
			await expect(failedRevival).rejects.toMatchObject({ errors: [failure] });
			expect(lookupAgentRef(registry, ref.id)).toMatchObject({ status: "parked", session: null });
			const rootRef = lookupAgentRef(registry, "Main");
			if (!rootRef) throw new Error("Expected the retained root ref");
			await expect(removeAgentRef(registry, rootRef)).rejects.toThrow(/failed before Main/i);
			expect(lookupAgentRef(registry, "Main")?.session).toBe(root);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toThrow(/terminat/i);
		} finally {
			releaseDisposal.resolve();
			finishConstruction.resolve(sessionResult(candidate));
			await cleanupFixture(
				work,
				() => lifecycle && disposeAgentLifecycle(lifecycle),
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("joins pre-begun root physical cleanup before granting a successor", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-prebegun-root-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const physicalStarted = Promise.withResolvers<void>();
		const releasePhysical = Promise.withResolvers<void>();
		let physicalDisposalStarted = false;
		const originalDispose = root.dispose;
		root.dispose = vi.fn(async options => {
			physicalDisposalStarted = true;
			physicalStarted.resolve();
			await releasePhysical.promise;
			await originalDispose(options);
		});
		const createSession = vi.spyOn(sdk, "createAgentSession").mockResolvedValue(sessionResult(root));
		let removal: Promise<boolean> | undefined;
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const rootRef = lookupAgentRef(registry, "Main");
			if (!rootRef) throw new Error("Expected the durable root ref");
			root.beginDispose();
			let removalSettled = false;
			removal = trackWork(
				removeAgentRef(registry, rootRef).then(
					result => {
						removalSettled = true;
						return result;
					},
					error => {
						removalSettled = true;
						throw error;
					},
				),
				work,
			);
			const boundary = await Promise.race([
				physicalStarted.promise.then(() => "physical" as const),
				removal.then(
					() => "removed" as const,
					() => "failed" as const,
				),
			]);
			expect(boundary).toBe("physical");
			expect(removalSettled).toBe(false);
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toThrow(/terminat/i);
			expect(physicalDisposalStarted).toBe(true);
			releasePhysical.resolve();
			expect(await removal).toBe(true);
		} finally {
			releasePhysical.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("joins pre-begun child physical cleanup before root CAS", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-prebegun-child-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const destination = fakeSession(path.join(directory, "replacement.jsonl"));
		const physicalStarted = Promise.withResolvers<void>();
		const releasePhysical = Promise.withResolvers<void>();
		const quiescing = Promise.withResolvers<void>();
		let childDisposalStarted = false;
		const originalChildDispose = child.dispose;
		child.dispose = vi.fn(async options => {
			childDisposalStarted = true;
			physicalStarted.resolve();
			await releasePhysical.promise;
			await originalChildDispose(options);
		});
		const originalBatch = store.transitionBatch.bind(store);
		store.transitionBatch = async (records, options) => {
			const receipt = await originalBatch(records, options);
			if (records.some(record => record.kind === "transition" && record.phase === "quiescing")) quiescing.resolve();
			return receipt;
		};
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child))
			.mockResolvedValueOnce(sessionResult(destination));
		let replacing: Promise<sdk.CreateAgentSessionResult> | undefined;
		let casCount = 0;
		const commit = store.commitRootTransition.bind(store);
		store.commitRootTransition = async (input, options) => {
			if (input.transition.phase === "cas-committed") {
				if (!childDisposalStarted) throw new Error("Root CAS started before pre-begun child physical cleanup");
				casCount++;
			}
			return commit(input, options);
		};
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			await bindInternalAgentAuthoritySession(registry, root)!.create({ agentId: "Main/child" });
			child.beginDispose();
			replacing = trackWork(createAgentRootSession(registry, { agentId: "Main" }), work);
			await quiescing.promise;
			const boundary = await Promise.race([
				physicalStarted.promise.then(() => "physical" as const),
				replacing.then(
					() => "settled" as const,
					() => "failed" as const,
				),
			]);
			expect(boundary).toBe("physical");
			expect(childDisposalStarted).toBe(true);
			expect(casCount).toBe(0);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			expect((await store.getGate("Main"))?.record.phase).toBe("quiescing");
			releasePhysical.resolve();
			await replacing;
			expect(casCount).toBe(1);
			expect((await store.getActor("Main/child"))?.record.state).toBe("retired");
		} finally {
			releasePhysical.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("retains synchronous park-start failure and blocks root cleanup", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-park-start-failure-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const physicalStarted = Promise.withResolvers<void>();
		const releasePhysical = Promise.withResolvers<void>();
		const failure = new Error("beginDispose failed synchronously");
		let beginDisposeCalls = 0;
		const originalBeginDispose = child.beginDispose.bind(child);
		child.beginDispose = vi.fn(() => {
			beginDisposeCalls++;
			if (beginDisposeCalls === 1) throw failure;
			originalBeginDispose();
		});
		const originalChildDispose = child.dispose;
		child.dispose = vi.fn(async options => {
			physicalStarted.resolve();
			await releasePhysical.promise;
			await originalChildDispose(options);
		});
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child));
		let lifecycle: AgentLifecycleManager | undefined;
		let parking: Promise<void> | undefined;
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			lifecycle = bindOwnedAgentLifecycle(registry, root);
			if (!lifecycle) throw new Error("Expected the root-owned lifecycle manager");
			const binding = bindInternalAgentAuthoritySession(registry, root)!;
			await binding.create({ agentId: "Main/child" });
			const ref = lookupAgentRef(registry, "Main/child");
			if (!ref) throw new Error("Expected the durable child ref");
			const revive = vi.fn(
				async (expected: AgentRef) => (await binding.create({ agentId: ref.id }, expected)).session,
			);
			adoptAgent(lifecycle, ref.id, { idleTtlMs: 0, revive }, ref);
			parking = parkAgent(lifecycle, ref.id);
			const parkingFailure = captureOutcome(parking, work);
			const boundary = await Promise.race([
				physicalStarted.promise.then(() => "physical" as const),
				parking.then(
					() => "parked" as const,
					() => "failed" as const,
				),
			]);
			expect(boundary).toBe("physical");
			expect(beginDisposeCalls).toBe(1);
			releasePhysical.resolve();
			expectFailure(await parkingFailure, failure);
			expect(lookupAgentRef(registry, ref.id)).toMatchObject({ status: "parked", session: null });
			expect((await store.getActor(ref.id))?.record.state).toBe("parked");
			const failedRevival = ensureAgentLive(lifecycle, ref.id);
			await expect(failedRevival).rejects.toThrow(/still owns a session whose disposal failed/i);
			await expect(failedRevival).rejects.toMatchObject({ errors: [failure] });
			expect(revive).toHaveBeenCalledTimes(1);
			const rootRef = lookupAgentRef(registry, "Main");
			if (!rootRef) throw new Error("Expected the retained root ref");
			await expect(removeAgentRef(registry, rootRef)).rejects.toThrow(/failed before Main/i);
			expect(lookupAgentRef(registry, "Main")?.session).toBe(root);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toThrow(/terminat/i);
		} finally {
			releasePhysical.resolve();
			await cleanupFixture(
				work,
				() => lifecycle && disposeAgentLifecycle(lifecycle),
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("retains synchronous retirement-start failure and blocks ancestor cleanup", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-retire-start-failure-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const physicalStarted = Promise.withResolvers<void>();
		const releasePhysical = Promise.withResolvers<void>();
		const failure = new Error("retirement beginDispose failed synchronously");
		let beginDisposeCalls = 0;
		const originalBeginDispose = child.beginDispose.bind(child);
		child.beginDispose = vi.fn(() => {
			beginDisposeCalls++;
			if (beginDisposeCalls === 1) throw failure;
			originalBeginDispose();
		});
		const originalChildDispose = child.dispose;
		child.dispose = vi.fn(async options => {
			physicalStarted.resolve();
			await releasePhysical.promise;
			await originalChildDispose(options);
		});
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child));
		let removal: Promise<boolean> | undefined;
		let removalSettled = false;
		let casCount = 0;
		const commit = store.commitRootTransition.bind(store);
		store.commitRootTransition = async (input, options) => {
			if (input.transition.phase === "cas-committed") casCount++;
			return commit(input, options);
		};
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			await bindInternalAgentAuthoritySession(registry, root)!.create({ agentId: "Main/child" });
			expect(casCount).toBe(0);
			const rootRef = lookupAgentRef(registry, "Main");
			if (!rootRef) throw new Error("Expected the durable root ref");
			removal = removeAgentRef(registry, rootRef).then(
				result => {
					removalSettled = true;
					return result;
				},
				error => {
					removalSettled = true;
					throw error;
				},
			);
			const removalFailure = captureOutcome(removal, work);
			await physicalStarted.promise;
			expect(removalSettled).toBe(false);
			expect(beginDisposeCalls).toBe(1);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			await expect(createAgentRootSession(registry, { agentId: "Main" })).rejects.toThrow(/terminat/i);
			expect(casCount).toBe(0);
			releasePhysical.resolve();
			const outcome = await removalFailure;
			const error = expectFailure(outcome, /descendants could not be fully retired/i);
			expect(error).toMatchObject({ errors: [failure] });
			expect(lookupAgentRef(registry, "Main")?.session).toBe(root);
			expect((await store.getActor("Main"))?.record.state).toBe("active");
			expect((await store.getActor("Main/child"))?.record.state).toBe("retired");
		} finally {
			releasePhysical.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
	it("keeps destination-generation children admitted before old-root cleanup", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-replacement-child-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const source = fakeSession(path.join(directory, "main.jsonl"));
		const oldChild = fakeSession(path.join(directory, "old.jsonl"));
		const destination = fakeSession(path.join(directory, "replacement.jsonl"));
		const newChild = fakeSession(path.join(directory, "new.jsonl"));
		const sourceDispose = source.dispose;
		const oldChildDispose = oldChild.dispose;
		const destinationDispose = destination.dispose;
		const newChildDispose = newChild.dispose;
		const published = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const work: FixtureWork[] = [];
		const original = store.transition.bind(store);
		store.transition = async (record, options) => {
			const receipt = await original(record, options);
			if (record.kind === "transition" && record.phase === "activated") {
				published.resolve();
				await gate.promise;
			}
			return receipt;
		};
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(source))
			.mockResolvedValueOnce(sessionResult(oldChild))
			.mockResolvedValueOnce(sessionResult(destination))
			.mockResolvedValueOnce(sessionResult(newChild));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			await bindInternalAgentAuthoritySession(registry, source)!.create({ agentId: "old-child" });
			const sourceRoot = (await store.getRoot("Main"))!.record;
			const originalCommit = store.commitRootTransition.bind(store);
			vi.spyOn(store, "commitRootTransition").mockImplementation(async (input, options) => {
				if (input.transition.phase === "cas-committed") {
					expect((await store.getActor("Main"))?.record).toMatchObject({
						state: "active",
						generation: sourceRoot.generation,
					});
					expect((await store.getActor("old-child"))?.record).toMatchObject({
						state: "retired",
						rootGeneration: sourceRoot.generation,
						rootHeadHash: sourceRoot.headHash,
					});
					expect(oldChildDispose).toHaveBeenCalledTimes(1);
					expect(sourceDispose).not.toHaveBeenCalled();
				}
				return originalCommit(input, options);
			});
			const replacing = trackWork(createAgentRootSession(registry, { agentId: "Main" }), work);
			try {
				await published.promise;
				await bindInternalAgentAuthoritySession(registry, destination)!.create({ agentId: "new-child" });
			} finally {
				gate.resolve();
			}
			await replacing;
			expect(lookupAgentRef(registry, "old-child")).toBeUndefined();
			expect(lookupAgentRef(registry, "new-child")?.session).toBe(newChild);
			expect((await store.getActor("new-child"))?.record).toMatchObject({
				state: "active",
				rootGeneration: registry.get("Main")!.lineage!.generation,
			});
			expect(lookupAgentRef(registry, "Main")?.session).toBe(destination);
			expect((await store.getActor("Main"))?.record).toMatchObject({
				state: "active",
				generation: registry.get("Main")!.lineage!.generation,
			});
			expect((await store.getActor("new-child"))?.record.rootHeadHash).toBe(
				(await store.getRoot("Main"))!.record.headHash,
			);
			expect(sourceDispose).toHaveBeenCalledTimes(1);
			expect(oldChildDispose).toHaveBeenCalledTimes(1);
			expect(destinationDispose).not.toHaveBeenCalled();
			expect(newChildDispose).not.toHaveBeenCalled();
		} finally {
			gate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("captures an accepted child whose activation ACK arrives during replacement drain", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-replacement-activation-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const source = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const destination = fakeSession(path.join(directory, "replacement.jsonl"));
		const sourceDispose = source.dispose;
		const childDispose = child.dispose;
		const destinationDispose = destination.dispose;
		const activated = Promise.withResolvers<void>();
		const activationGate = Promise.withResolvers<void>();
		const quiescing = Promise.withResolvers<void>();
		const work: FixtureWork[] = [];
		const originalActivate = store.activateAuthority.bind(store);
		store.activateAuthority = async (input, options) => {
			const receipt = await originalActivate(input, options);
			if (input.actor.actorId === "child") {
				activated.resolve();
				await activationGate.promise;
			}
			return receipt;
		};
		const originalBatch = store.transitionBatch.bind(store);
		store.transitionBatch = async (records, options) => {
			const receipt = await originalBatch(records, options);
			if (records.some(record => record.kind === "transition" && record.phase === "quiescing")) quiescing.resolve();
			return receipt;
		};
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(source))
			.mockResolvedValueOnce(sessionResult(child))
			.mockResolvedValueOnce(sessionResult(destination));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const creating = trackWork(
				bindInternalAgentAuthoritySession(registry, source)!.create({ agentId: "child" }),
				work,
			);
			await activated.promise;
			expect(lookupAgentRef(registry, "child")).toBeUndefined();
			const sourceRoot = (await store.getRoot("Main"))!.record;
			let settled = false;
			const replacing = trackWork(
				createAgentRootSession(registry, { agentId: "Main" }).finally(() => {
					settled = true;
				}),
				work,
			);
			await quiescing.promise;
			expect(settled).toBe(false);
			expect((await store.getRoot("Main"))?.record).toEqual(sourceRoot);
			activationGate.resolve();
			expect((await creating).session).toBe(child);
			await replacing;
			expect(lookupAgentRef(registry, "child")).toBeUndefined();
			expect((await store.getActor("child"))?.record).toMatchObject({
				state: "retired",
				rootGeneration: sourceRoot.generation,
				rootHeadHash: sourceRoot.headHash,
			});
			expect(lookupAgentRef(registry, "Main")?.session).toBe(destination);
			expect(sourceDispose).toHaveBeenCalledTimes(1);
			expect(childDispose).toHaveBeenCalledTimes(1);
			expect(destinationDispose).not.toHaveBeenCalled();
		} finally {
			activationGate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("drains accepted construction and retires the captured source tree before root CAS", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-replacement-source-drain-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const source = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const grandchild = fakeSession(path.join(directory, "grandchild.jsonl"));
		const pending = fakeSession(path.join(directory, "pending.jsonl"));
		const destination = fakeSession(path.join(directory, "replacement.jsonl"));
		const sourceDispose = source.dispose;
		const childDispose = child.dispose;
		const pendingDispose = pending.dispose;
		const destinationDispose = destination.dispose;
		const constructionStarted = Promise.withResolvers<void>();
		const constructionGate = Promise.withResolvers<sdk.CreateAgentSessionResult>();
		const quiescing = Promise.withResolvers<void>();
		const disposalStarted = Promise.withResolvers<void>();
		const disposalGate = Promise.withResolvers<void>();
		const work: FixtureWork[] = [];
		const grandchildDispose = vi.fn(async () => {
			disposalStarted.resolve();
			await disposalGate.promise;
		});
		grandchild.dispose = grandchildDispose;
		const originalBatch = store.transitionBatch.bind(store);
		store.transitionBatch = async (records, options) => {
			const receipt = await originalBatch(records, options);
			if (records.some(record => record.kind === "transition" && record.phase === "quiescing")) quiescing.resolve();
			return receipt;
		};
		let rootsCreated = 0;
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			if (options.agentId === "Main") return sessionResult(rootsCreated++ === 0 ? source : destination);
			if (options.agentId === "child") return sessionResult(child);
			if (options.agentId === "grandchild") return sessionResult(grandchild);
			if (options.agentId === "pending") {
				constructionStarted.resolve();
				return constructionGate.promise;
			}
			throw new Error(`Unexpected authority actor ${options.agentId}`);
		});
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			const binding = bindInternalAgentAuthoritySession(registry, source)!;
			await binding.create({ agentId: "child" });
			await bindInternalAgentAuthoritySession(registry, child)!.create({ agentId: "grandchild" });
			const sourceRoot = (await store.getRoot("Main"))!.record;
			const constructionFailure = captureOutcome(binding.create({ agentId: "pending" }), work);
			await constructionStarted.promise;
			let settled = false;
			const replacing = trackWork(
				createAgentRootSession(registry, { agentId: "Main" }).finally(() => {
					settled = true;
				}),
				work,
			);
			await quiescing.promise;
			expect(settled).toBe(false);
			expect((await store.getRoot("Main"))?.record).toEqual(sourceRoot);
			await expect(binding.create({ agentId: "late-child" })).rejects.toThrow(/parent|authority|reserv|replac/i);
			expect(lookupAgentRef(registry, "late-child")).toBeUndefined();
			constructionGate.resolve(sessionResult(pending));
			expectFailure(await constructionFailure, /parent|authority|construction/i);
			await disposalStarted.promise;
			expect(settled).toBe(false);
			expect((await store.getRoot("Main"))?.record).toEqual(sourceRoot);
			expect((await store.getActor("Main"))?.record).toMatchObject({
				state: "active",
				generation: sourceRoot.generation,
			});
			expect((await store.getActor("child"))?.record.state).toBe("active");
			expect((await store.getActor("grandchild"))?.record).toMatchObject({
				state: "retired",
				rootGeneration: sourceRoot.generation,
				rootHeadHash: sourceRoot.headHash,
			});
			expect(childDispose).not.toHaveBeenCalled();
			expect(sourceDispose).not.toHaveBeenCalled();
			disposalGate.resolve();
			await replacing;
			expect(lookupAgentRef(registry, "child")).toBeUndefined();
			expect(lookupAgentRef(registry, "grandchild")).toBeUndefined();
			expect(lookupAgentRef(registry, "pending")).toBeUndefined();
			expect((await store.getConstruction("Main", "pending", 4))?.record.phase).toBe("abandoned");
			expect((await store.getActor("child"))?.record).toMatchObject({
				state: "retired",
				rootGeneration: sourceRoot.generation,
				rootHeadHash: sourceRoot.headHash,
			});
			expect(lookupAgentRef(registry, "Main")?.session).toBe(destination);
			expect(sourceDispose).toHaveBeenCalledTimes(1);
			expect(childDispose).toHaveBeenCalledTimes(1);
			expect(grandchildDispose).toHaveBeenCalledTimes(1);
			expect(pendingDispose).toHaveBeenCalledTimes(1);
			expect(destinationDispose).not.toHaveBeenCalled();
		} finally {
			constructionGate.resolve(sessionResult(pending));
			disposalGate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("waits for an accepted source lifecycle release before replacing its durable parent", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-replacement-release-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const source = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const destination = fakeSession(path.join(directory, "replacement.jsonl"));
		const callbackStarted = Promise.withResolvers<void>();
		const callbackGate = Promise.withResolvers<void>();
		const lifecycleDrainStarted = Promise.withResolvers<void>();
		const work: FixtureWork[] = [];
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(source))
			.mockResolvedValueOnce(sessionResult(child))
			.mockResolvedValueOnce(sessionResult(destination));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			await bindInternalAgentAuthoritySession(registry, source)!.create({ agentId: "child" });
			const lifecycle = bindOwnedAgentLifecycle(registry, source)!;
			const disposeLifecycle = lifecycle.dispose.bind(lifecycle);
			vi.spyOn(lifecycle, "dispose").mockImplementation((deadlineAt, capability) => {
				const disposal = disposeLifecycle(deadlineAt, capability);
				lifecycleDrainStarted.resolve();
				return disposal;
			});
			const ref = lookupAgentRef(registry, "child")!;
			adoptAgent(
				lifecycle,
				ref.id,
				{
					idleTtlMs: 0,
					onRelease: async () => {
						callbackStarted.resolve();
						await callbackGate.promise;
					},
				},
				ref,
			);
			const releasing = trackWork(releaseAgent(lifecycle, ref.id, ref), work);
			await callbackStarted.promise;
			const sourceRoot = (await store.getRoot("Main"))!.record;
			let settled = false;
			const replacing = trackWork(
				createAgentRootSession(registry, { agentId: "Main" }).finally(() => {
					settled = true;
				}),
				work,
			);
			await lifecycleDrainStarted.promise;
			expect(settled).toBe(false);
			expect((await store.getRoot("Main"))?.record.generation).toBeGreaterThan(sourceRoot.generation);
			expect((await store.getActor("Main"))?.record).toMatchObject({
				state: "active",
				generation: sourceRoot.generation,
				rootHeadHash: sourceRoot.headHash,
			});
			expect(lookupAgentRef(registry, "Main")?.session).toBe(source);
			callbackGate.resolve();
			expect(await releasing).toBe(true);
			await replacing;
			expect(lookupAgentRef(registry, "Main")?.session).toBe(destination);
		} finally {
			callbackGate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});

	it("applies the initiating bounded shutdown options once after descendants finish", async () => {
		const work: FixtureWork[] = [];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-dispose-options-"));
		const store = persistentStore(path.join(directory, "authority.jsonl"));
		const root = fakeSession(path.join(directory, "main.jsonl"));
		const child = fakeSession(path.join(directory, "child.jsonl"));
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const order: string[] = [];
		const options: AgentSessionDisposeOptions = { drainTimeoutMs: 17, mnemopiConsolidateTimeoutMs: 0 };
		const originalChildDispose = child.dispose;
		child.dispose = vi.fn(async () => {
			started.resolve();
			await gate.promise;
			order.push("child-drained");
			await originalChildDispose();
		});
		const originalRootDispose = root.dispose;
		const raw = vi.fn(async (received?: AgentSessionDisposeOptions) => {
			expect(order).toEqual(["child-drained"]);
			expect(received).toEqual(options);
			if (received?.mnemopiConsolidateTimeoutMs === 0) order.push("skip-consolidation");
			order.push(`drain:${received?.drainTimeoutMs}`);
			await originalRootDispose(received);
		});
		root.dispose = raw;
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce(sessionResult(root))
			.mockResolvedValueOnce(sessionResult(child));
		try {
			const registry = await AgentRegistry.create({ durableState: store });
			await createAgentRootSession(registry, { agentId: "Main" });
			await bindInternalAgentAuthoritySession(registry, root)!.create({ agentId: "child" });
			const disposal = trackWork(root.dispose(options), work);
			try {
				await started.promise;
				expect(raw).not.toHaveBeenCalled();
			} finally {
				gate.resolve();
			}
			await Promise.all([disposal, root.dispose({ drainTimeoutMs: 99 })]);
			expect(raw).toHaveBeenCalledTimes(1);
			expect(order).toEqual(["child-drained", "skip-consolidation", "drain:17"]);
		} finally {
			gate.resolve();
			await cleanupFixture(
				work,
				() => createSession.mockRestore(),
				() => store.close(),
				() => fs.rm(directory, { recursive: true, force: true }),
			);
		}
	});
});
