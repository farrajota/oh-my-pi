import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	canonicalDurableSha256,
	DurableLocalState,
	DurableStateConflictError,
	DurableStateUnavailableError,
	RegistryDurableStateStore,
	registryDurableJournalPath,
	registryDurableStateForSession,
} from "../../src/registry/durable-state";
import {
	bindSessionOperationDurability,
	installSessionOperationLedger,
	markUnregisteredSessionOperationProjection,
	runLocalOperation,
} from "../../src/registry/operation-lease";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{ directory: string; journal: string; store: RegistryDurableStateStore }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-durable-registry-"));
	temporaryDirectories.push(directory);
	const journal = path.join(directory, "registry.jsonl");
	return { directory, journal, store: new RegistryDurableStateStore(journal) };
}

function hash(value: unknown): string {
	return canonicalDurableSha256(value);
}

function appendActiveRoot(
	store: RegistryDurableStateStore,
	generation = 1,
): { headHash: string; startupHash: string; provenanceHash: string } {
	const startupHash = hash({ startup: generation });
	const provenanceHash = hash({ provenance: generation });
	const headHash = hash({ rootId: "Main", generation, actorId: "Main", startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		actorId: "Main",
		rootId: "Main",
		generation,
		startupHash,
		provenanceHash,
	};
	store.append({ ...construction, at: 1, phase: "reserved" });
	store.append({ ...construction, at: 2, phase: "constructing" });
	store.append({ ...construction, at: 3, phase: "constructed" });
	store.append({ kind: "root", at: 4, rootId: "Main", generation, headHash, state: "active" });
	store.append({
		kind: "actor",
		at: 5,
		actorId: "Main",
		rootId: "Main",
		generation,
		rootGeneration: generation,
		rootHeadHash: headHash,
		startupHash,
		provenanceHash,
		state: "active",
	});
	store.append({ ...construction, at: 6, phase: "activated" });
	store.append({ kind: "gate", at: 7, rootId: "Main", generation, phase: "open" });
	return { headHash, startupHash, provenanceHash };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("W4 durable registry state", () => {
	it("derives one canonical per-session authority journal and process store", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-durable-path-"));
		temporaryDirectories.push(directory);
		const sessionFile = path.join(directory, "nested", "..", "main.jsonl");
		expect(registryDurableJournalPath(sessionFile)).toBe(`${path.resolve(sessionFile)}.authority-v1.jsonl`);
		expect(registryDurableStateForSession(sessionFile)).toBe(
			registryDurableStateForSession(path.resolve(sessionFile)),
		);
	});

	it("enforces append head CAS and returns recovery batches of at most 100 records", async () => {
		const { store } = await createStore();
		const first = store.append({ kind: "gate", at: 1, rootId: "root-0", generation: 1, phase: "open" }, null);
		expect(() => store.append({ kind: "gate", at: 2, rootId: "stale", generation: 1, phase: "open" }, null)).toThrow(
			DurableStateConflictError,
		);
		for (let index = 1; index < 205; index++) {
			store.append({ kind: "gate", at: index + 2, rootId: `root-${index}`, generation: 1, phase: "open" });
		}
		const firstBatch = store.readBatch(null);
		expect(firstBatch.records).toHaveLength(100);
		expect(firstBatch.done).toBe(false);
		const secondBatch = store.readBatch(firstBatch.cursor);
		expect(secondBatch.records).toHaveLength(100);
		expect(secondBatch.done).toBe(false);
		const finalBatch = store.readBatch(secondBatch.cursor);
		expect(finalBatch.records).toHaveLength(5);
		expect(finalBatch.done).toBe(true);
		expect(first.sequence).toBe(1);
	});

	it("rejects explicitly undefined optional fields in malformed durable records", async () => {
		const { store } = await createStore();
		expect(() =>
			store.append({
				kind: "construction",
				at: 1,
				actorId: "Main",
				rootId: "Main",
				parentId: undefined,
				generation: 1,
				startupHash: hash("startup"),
				provenanceHash: hash("provenance"),
				phase: "reserved",
			} as never),
		).toThrow("Durable state field 'parentId' is undefined.");
	});

	it("quarantines tampered journal content and remains unavailable after another restart", async () => {
		const { journal, store } = await createStore();
		store.append({ kind: "gate", at: 1, rootId: "Main", generation: 1, phase: "open" });
		const original = await fs.readFile(journal, "utf8");
		await fs.writeFile(journal, original.replace('"rootId":"Main"', '"rootId":"Other"'));
		const restarted = new RegistryDurableStateStore(journal);
		expect(() => new AgentRegistry({ durableState: restarted })).toThrow(DurableStateUnavailableError);
		expect(() => restarted.recover()).toThrow(DurableStateUnavailableError);
		const restartedAgain = new RegistryDurableStateStore(journal);
		expect(restartedAgain.available).toBe(false);
		expect(() => restartedAgain.head()).toThrow(DurableStateUnavailableError);
	});

	it("cancels pending operations and resources before reopening a recovered gate", async () => {
		const { journal, store } = await createStore();
		appendActiveRoot(store);
		store.append({ kind: "gate", at: 8, rootId: "Main", generation: 1, phase: "quiescing" });
		store.append({ kind: "gate", at: 9, rootId: "Main", generation: 1, phase: "quiesced" });
		store.append({
			kind: "operation",
			at: 10,
			operationId: "read:pending",
			effectClass: "filesystem",
			ownerId: "owner",
			classOwnerId: "owner:filesystem",
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			acquiredAt: 10,
			expiresAt: 100,
			phase: "intent",
		});
		store.append({
			kind: "resource",
			at: 11,
			resourceId: "handle-1",
			resourceClass: "archive",
			operationId: "read:pending",
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			targetHash: hash("archive-target"),
			phase: "intent",
		});
		store.append({
			kind: "resource",
			at: 12,
			resourceId: "handle-1",
			resourceClass: "archive",
			operationId: "read:pending",
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			targetHash: hash("archive-target"),
			phase: "effect",
		});

		const snapshot = new RegistryDurableStateStore(journal).recover();
		expect([...snapshot.operations.values()].at(-1)?.phase).toBe("abandoned");
		expect([...snapshot.resources.values()].at(-1)?.phase).toBe("cancelled");
		expect(snapshot.gates.get("Main")?.phase).toBe("open");
		const records = store.readBatch(null).records;
		const cancelled = records.findIndex(
			entry => entry.record.kind === "resource" && entry.record.phase === "cancelled",
		);
		const reopened = records.findIndex(
			entry => entry.record.kind === "gate" && entry.record.phase === "open" && entry.sequence > 12,
		);
		expect(cancelled).toBeGreaterThan(-1);
		expect(reopened).toBeGreaterThan(cancelled);
	});

	it("rolls a pre-CAS root transition back to the exact source head", async () => {
		const { store } = await createStore();
		const source = appendActiveRoot(store);
		const destination = {
			kind: "construction" as const,
			actorId: "Main",
			rootId: "Main",
			generation: 2,
			startupHash: hash("destination-startup"),
			provenanceHash: hash("destination-provenance"),
		};
		store.append({ ...destination, at: 8, phase: "reserved" });
		store.append({ ...destination, at: 9, phase: "constructing" });
		store.append({ ...destination, at: 10, phase: "constructed" });
		const transition = {
			kind: "transition" as const,
			transitionId: "replace-1-2",
			rootId: "Main",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: source.headHash,
			destinationHeadHash: hash("destination-head"),
		};
		for (const [index, phase] of (["staged", "quiescing", "quiesced", "validated"] as const).entries()) {
			store.append({ ...transition, at: 11 + index, phase });
		}
		const snapshot = store.recover();
		expect(snapshot.transitions.values().next().value?.phase).toBe("recovered");
		expect(snapshot.roots.get("Main")).toMatchObject({ generation: 1, headHash: source.headHash, state: "active" });
		expect([...snapshot.constructions.values()].find(record => record.generation === 2)?.phase).toBe("abandoned");
	});

	it("finishes a post-CAS root replacement forward without reviving the old generation", async () => {
		const { store } = await createStore();
		const source = appendActiveRoot(store);
		const destination = {
			kind: "construction" as const,
			actorId: "Main",
			rootId: "Main",
			generation: 2,
			startupHash: hash("destination-startup"),
			provenanceHash: hash("destination-provenance"),
		};
		store.append({ ...destination, at: 8, phase: "reserved" });
		store.append({ ...destination, at: 9, phase: "constructing" });
		store.append({ ...destination, at: 10, phase: "constructed" });
		const destinationHeadHash = hash("destination-head");
		const transition = {
			kind: "transition" as const,
			transitionId: "replace-1-2",
			rootId: "Main",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: source.headHash,
			destinationHeadHash,
		};
		for (const [index, phase] of (
			["staged", "quiescing", "quiesced", "validated", "cas-committed"] as const
		).entries()) {
			store.append({ ...transition, at: 11 + index, phase });
		}
		const snapshot = store.recover();
		expect(snapshot.transitions.values().next().value?.phase).toBe("retired");
		expect(snapshot.roots.get("Main")).toMatchObject({
			generation: 2,
			headHash: destinationHeadHash,
			state: "active",
		});
		expect(snapshot.actors.get("Main")).toMatchObject({ generation: 2, state: "parked" });
		expect([...snapshot.constructions.values()].find(record => record.generation === 2)?.phase).toBe("activated");
	});

	it("does not recover-abandon a live operation while local state reads the journal", async () => {
		const { store } = await createStore();
		const manager = {};
		const operationControl = installSessionOperationLedger(manager);
		markUnregisteredSessionOperationProjection(manager, false);
		bindSessionOperationDurability(manager, store);
		const local = new DurableLocalState(store, "session-live");

		try {
			await expect(
				runLocalOperation(manager, "write:live-local", async () => {
					await local.publishWithEffect("entry-live", hash("live"), "0".repeat(64), async () => {
						throw new Error("unknown agent");
					});
				}),
			).rejects.toThrow("unknown agent");
			const snapshot = store.recover();
			expect(
				[...snapshot.operations.values()].find(record => record.operationId === "write:live-local")?.phase,
			).toBe("failed");
			expect(store.available).toBe(true);
		} finally {
			await operationControl.close();
		}
	});

	it("maintains one local head and terminally records an expected-head conflict", async () => {
		const { store } = await createStore();
		const local = new DurableLocalState(store, "session-1");
		const first = local.publish("entry-1", hash("one"));
		expect(local.current()).toEqual(first);
		expect(() => local.publish("entry-2", hash("two"), "0".repeat(64))).toThrow(DurableStateConflictError);
		const snapshot = store.recover();
		expect(snapshot.localHeads.get("session-1")).toMatchObject({
			version: 1,
			headHash: first.headHash,
			phase: "current",
		});
		expect([...snapshot.localEntries.values()].find(entry => entry.entryId === "entry-2")?.phase).toBe("conflict");
	});
});
