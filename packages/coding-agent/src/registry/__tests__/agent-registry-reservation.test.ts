import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../config/settings";
import { ExtensionRuntime } from "../../extensibility/extensions/loader";
import * as sdk from "../../sdk";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
	parkAgentRef,
	setAgentStatus,
} from "../../internal/agent-registry-bridge";
import { SessionManager } from "../../session/session-manager";
import type { AgentSession } from "../../session/agent-session";
import { EventBus } from "../../utils/event-bus";
import { installSessionOperationLedger, runLocalOperation } from "../operation-lease";
import { AgentRegistry } from "../agent-registry";
import { closeSessionAuthority, registryDurableStateForSession } from "../authority";
import { authorityPaths } from "../authority/ownership";

const temporaryDirectories: string[] = [];
const authoritySessionFiles: string[] = [];
function fakeSession(file: string): AgentSession {
	const sessionManager = { getSessionFile: () => file };
	const operationControl = installSessionOperationLedger(sessionManager);
	let disposed = false;
	const beginDispose = () => {
		if (disposed) return;
		disposed = true;
		void operationControl.close();
	};
	return {
		sessionManager,
		beginDispose,
		dispose: vi.fn(async () => {
			beginDispose();
			await operationControl.close();
		}),
		get isDisposed() {
			return disposed;
		},
	} as unknown as AgentSession;
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
	if (errors.length > 1) throw new AggregateError(errors, "Registry reservation fixture cleanup failed.");
}

afterEach(async () => {
	await cleanupFixture(
		[],
		() => vi.restoreAllMocks(),
		...authoritySessionFiles.splice(0).map(sessionFile => () => closeSessionAuthority(sessionFile)),
	);
	await cleanupFixture(
		[],
		...temporaryDirectories.splice(0).map(directory => () => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("AgentRegistry authority session creation", () => {
	test("claims a reserved root after SDK assembly", async () => {
		const session = fakeSession("/main.jsonl");
		vi.spyOn(sdk, "createAgentSession").mockResolvedValue({ session } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		await createAgentRootSession(registry, { agentId: "Main", agentDisplayName: "main" });
		expect(registry.get("Main")?.lineage).toMatchObject({ rootId: "Main" });
	});
	test("publishes a reserved child with the same lineage it later removes", async () => {
		const main = fakeSession("/main.jsonl");
		const child = fakeSession("/worker.jsonl");
		vi.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: main } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: child } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		await createAgentRootSession(registry, { agentId: "Main" });
		let registeredCount = 0;
		let removedCount = 0;
		let registeredGeneration: number | undefined;
		let registeredInternalGeneration: number | undefined;
		let removedGeneration: number | undefined;
		let registeredSession: AgentSession | undefined;
		registry.onChange(event => {
			if (event.ref.id !== "Main/worker") return;
			if (event.type === "registered") {
				registeredCount++;
				registeredGeneration = event.ref.lineage?.generation;
				const row = lookupAgentRef(registry, event.ref.id);
				registeredInternalGeneration = row?.lineage?.generation;
				registeredSession = row?.session ?? undefined;
			} else if (event.type === "removed") {
				removedCount++;
				removedGeneration = event.ref.lineage?.generation;
			}
		});
		const mainBinding = bindInternalAgentAuthoritySession(registry, main)!;
		await mainBinding.create({ agentId: "Main/worker", agentDisplayName: "worker" });
		const committedRow = lookupAgentRef(registry, "Main/worker");
		expect(registeredCount).toBe(1);
		expect(registeredSession).toBe(child);
		expect(committedRow?.session).toBe(registeredSession);
		expect(registeredInternalGeneration).toBe(committedRow?.lineage?.generation);
		expect(registeredGeneration).toBe(registeredInternalGeneration);
		await child.dispose();
		expect(removedCount).toBe(1);
		expect(removedGeneration).toBe(registeredGeneration);
		expect(registry.get("Main/worker")).toBeUndefined();
	});
	test("rejects restricted authority startup before SDK assembly without a durable store", async () => {
		const createSession = vi.spyOn(sdk, "createAgentSession");
		const registry = new AgentRegistry();
		await expect(
			createAgentRootSession(registry, {
				agentId: "Restricted",
				restrictToolNames: true,
				toolNames: [],
			}),
		).rejects.toThrow("durable registry state store");
		expect(createSession).not.toHaveBeenCalled();
	});

	test("returns fresh recursively frozen observations without exposing mutable registry state", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "worker",
			kind: "sub",
			status: "running",
			session: null,
			parentId: "Main",
			history: {
				requestedPermissionProfiles: ["default"],
				metrics: { tokens: 1, requests: 2, tools: 3, cost: 4, durationMs: 5 },
			},
		});
		const first = registry.get("Worker")!;
		const second = registry.get("Worker")!;
		expect(second).not.toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.lineage)).toBe(true);
		expect(Object.isFrozen(first.history)).toBe(true);
		expect(Object.isFrozen(first.history?.requestedPermissionProfiles)).toBe(true);
		expect(Object.isFrozen(first.history?.metrics)).toBe(true);
		expect(Reflect.set(first, "status", "aborted")).toBe(false);
		expect(Reflect.set(first.lineage!, "parentId", "forged")).toBe(false);
		expect(Reflect.set(first, "parentId", "forged")).toBe(false);
		expect("session" in first).toBe(false);
		expect(Reflect.set(first, "history", {})).toBe(false);
		expect(() => {
			first.history!.requestedPermissionProfiles!.push("forged");
		}).toThrow();
		expect(registry.get("Worker")).toMatchObject({ status: "running", parentId: "Main" });
	});

	test("consumes one construction callback against an immutable canonical snapshot", async () => {
		const session = fakeSession("/snapshot.jsonl");
		const work: FixtureWork[] = [];
		const gate = Promise.withResolvers<void>();
		let captured: sdk.CreateAgentSessionOptions | undefined;
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			captured = options;
			await gate.promise;
			return { session } as sdk.CreateAgentSessionResult;
		});
		const settings = Settings.isolated();
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const modelPattern = ["provider/model", "provider/fallback"];
		const registry = new AgentRegistry();
		const creation = trackWork(
			createAgentRootSession(registry, { agentId: "Main", outputSchema, modelPattern, settings }),
			work,
		);
		try {
			await Promise.resolve();
			outputSchema.properties.answer.type = "number";
			modelPattern[0] = "forged/model";
			expect(captured?.outputSchema).toEqual({ type: "object", properties: { answer: { type: "string" } } });
			expect(captured?.modelPattern).toEqual(["provider/model", "provider/fallback"]);
			expect(captured?.settings).not.toBe(settings);
			expect(Object.isFrozen(captured)).toBe(true);
			expect(Object.isFrozen(captured?.outputSchema)).toBe(true);
			expect(Object.isFrozen(captured?.modelPattern)).toBe(true);
			gate.resolve();
			await creation;
			expect(createSession).toHaveBeenCalledTimes(1);
			expect(registry.get("Main")?.lineage).toMatchObject({ rootId: "Main" });
		} finally {
			gate.resolve();
			await cleanupFixture(work, () => createSession.mockRestore());
		}
	});
	test("allows child creation only from the exact current live parent session", async () => {
		const main = fakeSession("/main.jsonl");
		const child = fakeSession("/worker.jsonl");
		vi.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: main } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: child } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		await createAgentRootSession(registry, { agentId: "Main" });
		const mainBinding = bindInternalAgentAuthoritySession(registry, main)!;
		await mainBinding.create({ agentId: "Main/worker", agentDisplayName: "worker" });
	});

	test("revives only the exact parked ref under the same live root", async () => {
		const main = fakeSession("/main.jsonl");
		const first = fakeSession("/worker.jsonl");
		const revived = fakeSession("/worker.jsonl");
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: main } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: first } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: revived } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		await createAgentRootSession(registry, { agentId: "Main" });
		const mainBinding = bindInternalAgentAuthoritySession(registry, main)!;
		await mainBinding.create({ agentId: "Main/worker", agentDisplayName: "worker" });
		const ref = registry.get("Main/worker")!;
		await expect(registry.setStatus(ref.id, "parked", first)).resolves.toBe(false);
		expect(registry.detachSession(ref.id, first)).toBe(false);
		expect(bindInternalAgentAuthoritySession(registry, fakeSession("/forged.jsonl"))).toBeUndefined();
		expect(await setAgentStatus(registry, ref.id, "parked", first)).toBe(false);
		const ownedRef = lookupAgentRef(registry, ref.id);
		if (!ownedRef) throw new Error("Expected owned worker ref");
		expect(await parkAgentRef(registry, ownedRef, first)).toBe(true);
		await mainBinding.create({ agentId: ref.id, agentDisplayName: ref.displayName }, ref);
		const observed = registry.get(ref.id)!;
		expect(observed).not.toBe(ref);
		expect(observed).toMatchObject({ id: ref.id, lineage: ref.lineage, status: "running" });
		expect("session" in observed).toBe(false);
		await expect(registry.setStatus(ref.id, "aborted", first)).resolves.toBe(false);
		expect(registry.detachSession(ref.id, first)).toBe(false);
		expect(await setAgentStatus(registry, ref.id, "idle", revived)).toBe(true);
		await expect(mainBinding.create({ agentId: ref.id }, { ...ref })).rejects.toBeInstanceOf(Error);
		expect(createSession).toHaveBeenCalledTimes(3);
		expect(registry.get(ref.id)).toMatchObject({
			id: observed.id,
			lineage: observed.lineage,
			status: "idle",
		});
		expect(lookupAgentRef(registry, ref.id)?.session).toBe(revived);
	});

	for (const backend of ["jsonl", "sqlite"] as const) {
		for (const actorState of ["active", "parked"] as const) {
			test(`revives the exact durable ${actorState} root generation on ${backend} despite an ephemeral deadline change`, async () => {
				const work: FixtureWork[] = [];
				let createSession: { mockRestore(): void } | undefined;
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-registry-restart-"));
				temporaryDirectories.push(directory);
				const firstManager = SessionManager.create(directory, path.join(directory, "sessions"));
				const managers = [firstManager];
				let sessionFile: string | undefined;
				const disposalOrder: string[] = [];
				const deadlines: (number | undefined)[] = [];
				const fixtures: Array<{
					manager: SessionManager;
					session: AgentSession;
					disposalStarted: Promise<void>;
					disposeRaw: () => Promise<void>;
					isPhysicallyDisposed: () => boolean;
				}> = [];
				let releaseHeldOperation: (() => void) | undefined;
				let heldOperationOutcome: Promise<PromiseSettledResult<void>> | undefined;
				let parking: Promise<boolean> | undefined;
				let activeDisposal: Promise<void> | undefined;
				try {
					firstManager.appendMessage({
						role: "user",
						content: `retained root restart ${backend} ${actorState}`,
						timestamp: 1,
					});
					await firstManager.ensureOnDisk();
					sessionFile = firstManager.getSessionFile();
					if (!sessionFile) throw new Error("Expected a SessionManager-allocated root fixture");
					authoritySessionFiles.push(sessionFile);
					const journalPath = authorityPaths(sessionFile).jsonl;
					createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
						const manager = options?.sessionManager;
						if (!(manager instanceof SessionManager)) throw new Error("Expected explicit session manager");
						deadlines.push(options?.deadline);
						const operationControl = installSessionOperationLedger(manager);
						const disposalStarted = Promise.withResolvers<void>();
						const fixtureId = fixtures.length + 1;
						let disposed = false;
						let physicallyDisposed = false;
						let operationDrain: Promise<void> | undefined;
						let physicalDisposal: Promise<void> | undefined;
						const beginDispose = () => {
							if (disposed) return;
							disposed = true;
							operationDrain = operationControl.close();
						};
						const disposeRaw = () => {
							if (physicalDisposal) return physicalDisposal;
							beginDispose();
							physicalDisposal = (async () => {
								await (operationDrain ?? operationControl.close());
								await manager.close();
								physicallyDisposed = true;
								disposalOrder.push(`session-${fixtureId}-physically-disposed`);
							})();
							disposalStarted.resolve();
							return physicalDisposal;
						};
						const session = {
							sessionManager: manager,
							beginDispose,
							dispose: vi.fn(disposeRaw),
							get isDisposed() {
								return disposed;
							},
						} as unknown as AgentSession;
						fixtures.push({
							manager,
							session,
							disposalStarted: disposalStarted.promise,
							disposeRaw,
							isPhysicallyDisposed: () => physicallyDisposed,
						});
						return {
							session,
							extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
							setToolUIContext: () => {},
							eventBus: new EventBus(),
						} satisfies sdk.CreateAgentSessionResult;
					});

					const firstStore = await registryDurableStateForSession(sessionFile, {
						backend,
						owningSessionId: firstManager.getSessionId(),
						create: true,
					});
					expect(firstStore.identity.backend).toBe(backend);
					const firstRegistry = await AgentRegistry.create({ durableState: firstStore });
					await createAgentRootSession(firstRegistry, {
						agentId: "Main",
						agentDisplayName: "main",
						sessionManager: firstManager,
						deadline: 1,
					});
					const firstFixture = fixtures[0];
					if (!firstFixture) throw new Error("Expected the initial root session fixture");
					const firstRef = lookupAgentRef(firstRegistry, "Main");
					if (!firstRef) throw new Error("Expected the initial durable root ref");
					const originalStatus = firstRegistry.get("Main")?.status;
					if (!originalStatus) throw new Error("Expected the initial root status");
					const generation = firstRegistry.get("Main")?.lineage?.generation;
					if (generation === undefined) throw new Error("Expected the initial root generation");

					const operationStarted = Promise.withResolvers<void>();
					const releaseOperation = Promise.withResolvers<void>();
					let operationCallbackSettled = false;
					releaseHeldOperation = releaseOperation.resolve;
					const operationId = `restart-disposal-${backend}-${actorState}`;
					const heldOperation = runLocalOperation(firstManager, operationId, async () => {
						operationStarted.resolve();
						try {
							await releaseOperation.promise;
						} finally {
							operationCallbackSettled = true;
						}
					});
					heldOperationOutcome = captureOutcome(heldOperation, work);
					await operationStarted.promise;

					firstFixture.session.beginDispose();
					const postFenceCallback = vi.fn(async () => "unexpected admission");
					await expect(
						runLocalOperation(firstManager, `${operationId}-after-fence`, postFenceCallback),
					).rejects.toThrow("Bound session operation authority is stale or no longer current.");
					expect(postFenceCallback).not.toHaveBeenCalled();

					if (actorState === "parked") {
						parking = trackWork(parkAgentRef(firstRegistry, firstRef, firstFixture.session), work);
						await firstFixture.disposalStarted;
						expect(firstRegistry.get("Main")).toMatchObject({ status: "parked" });
						expect(lookupAgentRef(firstRegistry, "Main")?.session).toBeNull();
					} else {
						activeDisposal = trackWork(firstFixture.disposeRaw(), work);
						await firstFixture.disposalStarted;
						expect(firstRegistry.get("Main")?.status).toBe(originalStatus);
						expect(lookupAgentRef(firstRegistry, "Main")?.session).toBe(firstFixture.session);
					}
					expect(firstFixture.session.isDisposed).toBe(true);
					expect(firstFixture.isPhysicallyDisposed()).toBe(false);
					expect(operationCallbackSettled).toBe(false);
					expect((await firstStore.getActor("Main"))?.record).toMatchObject({ generation, state: actorState });
					expect((await firstStore.getGate("Main"))?.record).toMatchObject({ generation, phase: "open" });

					releaseOperation.resolve();
					const operationOutcome = await heldOperationOutcome;
					expect(operationOutcome.status).toBe("rejected");
					if (operationOutcome.status !== "rejected") throw new Error("Expected held-operation cancellation");
					expect(() => {
						throw operationOutcome.reason;
					}).toThrow(/cancelled: Session disposed/);
					expect(operationCallbackSettled).toBe(true);
					if (parking) await expect(parking).resolves.toBe(true);
					if (activeDisposal) await activeDisposal;
					expect(firstFixture.isPhysicallyDisposed()).toBe(true);

					const rootBeforeClose = await firstStore.getRoot("Main");
					const actorBeforeClose = await firstStore.getActor("Main");
					const constructionBeforeClose = await firstStore.getConstruction("Main", "Main", generation);
					const actorGenerationBeforeClose = await firstStore.getActorGeneration("Main", generation);
					const generationHighWaterBeforeClose = (await firstStore.recoveryState()).generationHighWater;
					if (!rootBeforeClose || !actorBeforeClose || !constructionBeforeClose || !actorGenerationBeforeClose)
						throw new Error("Expected complete retained root and construction history before restart");
					expect(actorBeforeClose.record).toMatchObject({ generation, state: actorState });
					expect(actorGenerationBeforeClose).toEqual(actorBeforeClose);
					expect(constructionBeforeClose.record).toMatchObject({ generation, phase: "activated" });
					expect(generationHighWaterBeforeClose).toBe(generation);
					const rootHistoryKey = `root-generation:${JSON.stringify(["Main", generation])}`;
					const actorHistoryKey = `actor-generation:${JSON.stringify(["Main", generation])}`;
					const historyBeforeClose = await firstStore.exportState();
					const rootHistoryBeforeClose = historyBeforeClose.controls.find(
						control => control.key === rootHistoryKey,
					);
					const actorHistoryBeforeClose = historyBeforeClose.controls.find(
						control => control.key === actorHistoryKey,
					);
					if (!rootHistoryBeforeClose || !actorHistoryBeforeClose)
						throw new Error("Expected immutable root and actor-generation history before restart");
					if (backend === "jsonl") {
						const durableBytes = await fs.readFile(authorityPaths(sessionFile).jsonl, "utf8");
						expect(durableBytes).not.toContain(sessionFile);
						expect(durableBytes).not.toContain("agentRegistry");
					}
					expect(firstFixture.isPhysicallyDisposed()).toBe(true);
					expect(disposalOrder).toEqual(["session-1-physically-disposed"]);
					disposalOrder.push("authority-close-start");
					await closeSessionAuthority(sessionFile);
					disposalOrder.push("authority-closed");
					expect(disposalOrder).toEqual([
						"session-1-physically-disposed",
						"authority-close-start",
						"authority-closed",
					]);

					const restartedManager = await SessionManager.open(sessionFile, undefined, undefined, {
						initialCwd: directory,
					});
					managers.push(restartedManager);
					const restartedStore = await registryDurableStateForSession(sessionFile, { backend });
					expect(restartedStore.identity.backend).toBe(backend);
					const restartedRegistry = await AgentRegistry.create({ durableState: restartedStore });
					expect(await restartedStore.getActor("Main")).toEqual(actorBeforeClose);
					expect(await restartedStore.getRoot("Main")).toEqual(rootBeforeClose);
					expect(await restartedStore.getConstruction("Main", "Main", generation)).toEqual(
						constructionBeforeClose,
					);
					expect(await restartedStore.getActorGeneration("Main", generation)).toEqual(actorGenerationBeforeClose);
					expect((await restartedStore.getGate("Main"))?.record).toMatchObject({ generation, phase: "closed" });
					expect((await restartedStore.recoveryState()).generationHighWater).toBe(generationHighWaterBeforeClose);
					await createAgentRootSession(restartedRegistry, {
						agentId: "Main",
						agentDisplayName: "main",
						sessionManager: restartedManager,
						deadline: 2,
					});

					expect(deadlines).toEqual([1, 2]);
					expect(restartedRegistry.get("Main")?.lineage?.generation).toBe(generation);
					expect((await restartedStore.getActor("Main"))?.record).toMatchObject({ generation, state: "active" });
					expect((await restartedStore.getGate("Main"))?.record).toMatchObject({ generation, phase: "open" });
					expect(await restartedStore.getRoot("Main")).toEqual(rootBeforeClose);
					expect(await restartedStore.getConstruction("Main", "Main", generation)).toEqual(
						constructionBeforeClose,
					);
					expect((await restartedStore.recoveryState()).generationHighWater).toBe(generationHighWaterBeforeClose);
					const activatedActorGeneration = await restartedStore.getActorGeneration("Main", generation);
					if (!activatedActorGeneration) throw new Error("Expected the reactivated actor-generation history");
					expect(activatedActorGeneration.version).toBe(actorGenerationBeforeClose.version + 1);
					expect(activatedActorGeneration.record).toMatchObject({
						actorId: actorGenerationBeforeClose.record.actorId,
						rootId: actorGenerationBeforeClose.record.rootId,
						generation,
						rootGeneration: actorGenerationBeforeClose.record.rootGeneration,
						rootHeadHash: actorGenerationBeforeClose.record.rootHeadHash,
						startupHash: actorGenerationBeforeClose.record.startupHash,
						provenanceHash: actorGenerationBeforeClose.record.provenanceHash,
						state: "active",
					});
					expect(activatedActorGeneration.record.parentId).toBe(actorGenerationBeforeClose.record.parentId);
					const historyAfterActivation = await restartedStore.exportState();
					expect(historyAfterActivation.controls.find(control => control.key === rootHistoryKey)).toEqual(
						rootHistoryBeforeClose,
					);
					expect(historyAfterActivation.controls.find(control => control.key === actorHistoryKey)).toMatchObject({
						key: actorHistoryKey,
						value: { row: activatedActorGeneration },
					});

					const restartedFixture = fixtures[1];
					if (!restartedFixture) throw new Error("Expected the restarted root session fixture");
					await restartedFixture.disposeRaw();
					disposalOrder.push("restarted-authority-close-start");
					await closeSessionAuthority(sessionFile);
					disposalOrder.push("restarted-authority-closed");
					expect(disposalOrder.slice(-3)).toEqual([
						"session-2-physically-disposed",
						"restarted-authority-close-start",
						"restarted-authority-closed",
					]);
				} finally {
					releaseHeldOperation?.();
					await cleanupFixture(
						work,
						...fixtures.map(fixture => () => fixture.disposeRaw()),
						...managers
							.filter(manager => !fixtures.some(fixture => fixture.manager === manager))
							.map(manager => () => manager.close()),
						() => createSession?.mockRestore(),
						async () => {
							if (sessionFile) await closeSessionAuthority(sessionFile);
						},
					);
				}
			});
		}
	}
});
