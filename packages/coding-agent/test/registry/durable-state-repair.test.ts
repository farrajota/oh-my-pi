import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { ModelRegistry } from "../../src/config/model-registry";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	canonicalDurableSha256,
	RegistryDurableStateStore,
	repairSessionAuthority,
	registryDurableJournalPath,
	durableRootHeadHash,
} from "../../src/registry/durable-state";
import * as sdk from "../../src/sdk";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { Settings } from "../../src/config/settings";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const temporaryDirectories: string[] = [];

interface LegacyRootHashes {
	rootId: string;
	generation: number;
	headHash: string;
	startupHash: string;
	provenanceHash: string;
}

async function createStore(): Promise<{
	directory: string;
	sessionFile: string;
	journal: string;
	store: RegistryDurableStateStore;
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-durable-repair-"));
	temporaryDirectories.push(directory);
	const sessionFile = path.join(directory, "main.jsonl");
	const journal = registryDurableJournalPath(sessionFile);
	return { directory, sessionFile, journal, store: new RegistryDurableStateStore(journal) };
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

function hash(value: unknown): string {
	return canonicalDurableSha256(value);
}

function appendActiveRoot(
	store: RegistryDurableStateStore,
	generation = 1,
	rootId = "Main",
	headHash?: string,
): LegacyRootHashes {
	const startupHash = hash({ startup: generation, rootId });
	const provenanceHash = hash({ provenance: generation, rootId });
	const derivedHeadHash = durableRootHeadHash({ rootId, generation, actorId: rootId, startupHash, provenanceHash });
	const activeHeadHash = headHash ?? derivedHeadHash;
	const construction = {
		kind: "construction" as const,
		actorId: rootId,
		rootId,
		generation,
		startupHash,
		provenanceHash,
	};
	store.append({ ...construction, at: 1, phase: "reserved" });
	store.append({ ...construction, at: 2, phase: "constructing" });
	store.append({ ...construction, at: 3, phase: "constructed" });
	store.append({ kind: "root", at: 4, rootId, generation, headHash: activeHeadHash, state: "active" });
	store.append({
		kind: "actor",
		at: 5,
		actorId: rootId,
		rootId,
		generation,
		rootGeneration: generation,
		rootHeadHash: activeHeadHash,
		startupHash,
		provenanceHash,
		state: "active",
	});
	store.append({ ...construction, at: 6, phase: "activated" });
	store.append({ kind: "gate", at: 7, rootId, generation, phase: "open" });
	return { rootId, generation, headHash: activeHeadHash, startupHash, provenanceHash };
}

function appendActor(
	store: RegistryDurableStateStore,
	root: LegacyRootHashes,
	input: {
		actorId: string;
		parentId?: string;
		rootId?: string;
		generation: number;
		rootGeneration?: number;
		rootHeadHash?: string;
		startupHash?: string;
		provenanceHash?: string;
		state: "active" | "parked" | "retired" | "aborted";
		at: number;
	},
): void {
	store.append({
		kind: "actor",
		at: input.at,
		actorId: input.actorId,
		rootId: input.rootId ?? root.rootId,
		...(input.parentId === undefined ? {} : { parentId: input.parentId }),
		generation: input.generation,
		rootGeneration: input.rootGeneration ?? root.generation,
		rootHeadHash: input.rootHeadHash ?? root.headHash,
		startupHash: input.startupHash ?? hash(`${input.actorId}:startup`),
		provenanceHash: input.provenanceHash ?? hash(`${input.actorId}:provenance`),
		state: input.state,
	});
}

function appendRepairableTree(store: RegistryDurableStateStore): void {
	const root = appendActiveRoot(store);
	appendActor(store, root, {
		actorId: "Main",
		generation: 1,
		startupHash: root.startupHash,
		provenanceHash: root.provenanceHash,
		state: "retired",
		at: 8,
	});
	appendActor(store, root, { actorId: "Child", parentId: "Main", generation: 2, state: "active", at: 9 });
	appendActor(store, root, { actorId: "Grandchild", parentId: "Child", generation: 3, state: "parked", at: 10 });
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("durable authority repair", () => {
	it("reports a clean authority journal without changing source bytes", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendActiveRoot(store);
		const original = await fs.readFile(journal, "utf8");
		const result = await repairSessionAuthority(sessionFile);
		expect(result.status).toBe("clean");
		expect(result.affectedActorIds).toEqual([]);
		expect(result.originalHead).toEqual(store.head());
		expect(await fs.readFile(journal, "utf8")).toBe(original);
		expect(syncFs.existsSync(`${journal}.quarantine`)).toBe(false);
	});

	it("dry-runs a transitive terminal-parent repair without mutating journal or quarantine", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		const original = await fs.readFile(journal, "utf8");
		const result = await repairSessionAuthority(sessionFile);
		expect(result.status).toBe("repairable");
		expect(result.affectedActorIds).toEqual(["Grandchild", "Child"]);
		expect(result.originalHead).toEqual(store.head());
		expect(await fs.readFile(journal, "utf8")).toBe(original);
		expect(syncFs.existsSync(`${journal}.quarantine`)).toBe(false);
	});

	it("refuses tampered and missing-parent authority journals without quarantining them", async () => {
		const tampered = await createStore();
		appendActiveRoot(tampered.store);
		const tamperedOriginal = await fs.readFile(tampered.journal, "utf8");
		await fs.writeFile(tampered.journal, tamperedOriginal.replace('"rootId":"Main"', '"rootId":"Other"'));
		await expect(repairSessionAuthority(tampered.sessionFile)).rejects.toThrow(/hash|chain|tamper/i);
		expect(syncFs.existsSync(`${tampered.journal}.quarantine`)).toBe(false);

		const missing = await createStore();
		const root = appendActiveRoot(missing.store);
		appendActor(missing.store, root, {
			actorId: "Orphan",
			parentId: "Missing",
			generation: 2,
			state: "active",
			at: 8,
		});
		const missingOriginal = await fs.readFile(missing.journal, "utf8");
		await expect(repairSessionAuthority(missing.sessionFile)).rejects.toThrow(/missing|parent|lineage/i);
		expect(await fs.readFile(missing.journal, "utf8")).toBe(missingOriginal);
		expect(syncFs.existsSync(`${missing.journal}.quarantine`)).toBe(false);
	});
	it("refuses cross-root parents, parent cycles, and non-derived root heads without quarantining evidence", async () => {
		const crossRoot = await createStore();
		appendActiveRoot(crossRoot.store);
		const otherRoot = appendActiveRoot(crossRoot.store, 1, "OtherRoot");
		appendActor(crossRoot.store, otherRoot, {
			actorId: "CrossRoot",
			parentId: "Main",
			generation: 2,
			state: "active",
			at: 8,
		});
		const crossRootOriginal = await fs.readFile(crossRoot.journal, "utf8");
		await expect(repairSessionAuthority(crossRoot.sessionFile)).rejects.toThrow(/parent|root/i);
		expect(await fs.readFile(crossRoot.journal, "utf8")).toBe(crossRootOriginal);
		expect(syncFs.existsSync(`${crossRoot.journal}.quarantine`)).toBe(false);

		const cycle = await createStore();
		const cycleRoot = appendActiveRoot(cycle.store);
		appendActor(cycle.store, cycleRoot, {
			actorId: "Child",
			parentId: "Grandchild",
			generation: 2,
			state: "active",
			at: 8,
		});
		appendActor(cycle.store, cycleRoot, {
			actorId: "Grandchild",
			parentId: "Child",
			generation: 3,
			state: "active",
			at: 9,
		});
		const cycleOriginal = await fs.readFile(cycle.journal);
		expect(syncFs.existsSync(`${cycle.journal}.quarantine`)).toBe(false);
		await expect(repairSessionAuthority(cycle.sessionFile)).rejects.toThrow(Error);
		expect(await fs.readFile(cycle.journal)).toEqual(cycleOriginal);
		expect(syncFs.existsSync(`${cycle.journal}.quarantine`)).toBe(false);

		const rootHash = await createStore();
		appendActiveRoot(rootHash.store, 1, "Main", hash({ wrong: "root-head" }));
		await expect(repairSessionAuthority(rootHash.sessionFile)).rejects.toThrow(/root head|mismatched/i);
		expect(syncFs.existsSync(`${rootHash.journal}.quarantine`)).toBe(false);
	});
	it("refuses historical actor identity drift without creating quarantine state", async () => {
		const { sessionFile, journal, store } = await createStore();
		const root = appendActiveRoot(store);
		appendActor(store, root, {
			actorId: "Main",
			generation: 1,
			startupHash: hash({ changed: "startup" }),
			provenanceHash: root.provenanceHash,
			state: "parked",
			at: 8,
		});
		const original = await fs.readFile(journal, "utf8");
		await expect(repairSessionAuthority(sessionFile)).rejects.toThrow(/immutable|identity/i);
		expect(await fs.readFile(journal, "utf8")).toBe(original);
		expect(syncFs.existsSync(`${journal}.quarantine`)).toBe(false);
	});
	it("refuses historical root-generation drift hidden by a later same-generation actor record", async () => {
		const { sessionFile, journal, store } = await createStore();
		const root = appendActiveRoot(store);
		appendActor(store, root, { actorId: "Child", parentId: "Main", generation: 2, state: "active", at: 8 });
		appendActor(store, root, {
			actorId: "Child",
			parentId: "Main",
			generation: 2,
			rootGeneration: root.generation + 1,
			rootHeadHash: hash({ wrong: "historical-root-binding" }),
			state: "parked",
			at: 9,
		});
		appendActor(store, root, { actorId: "Child", parentId: "Main", generation: 2, state: "retired", at: 10 });
		const original = await fs.readFile(journal, "utf8");
		await expect(repairSessionAuthority(sessionFile)).rejects.toThrow(/immutable|root binding/i);
		expect(await fs.readFile(journal, "utf8")).toBe(original);
		expect(syncFs.existsSync(`${journal}.quarantine`)).toBe(false);
	});
	it("refuses historical root-head drift hidden by a later same-generation actor record", async () => {
		const { sessionFile, journal, store } = await createStore();
		const root = appendActiveRoot(store);
		appendActor(store, root, { actorId: "Child", parentId: "Main", generation: 2, state: "active", at: 8 });
		appendActor(store, root, {
			actorId: "Child",
			parentId: "Main",
			generation: 2,
			rootHeadHash: hash({ wrong: "historical-root-head" }),
			state: "parked",
			at: 9,
		});
		appendActor(store, root, { actorId: "Child", parentId: "Main", generation: 2, state: "retired", at: 10 });
		const original = await fs.readFile(journal, "utf8");
		await expect(repairSessionAuthority(sessionFile)).rejects.toThrow(/immutable|root binding/i);
		expect(await fs.readFile(journal, "utf8")).toBe(original);
		expect(syncFs.existsSync(`${journal}.quarantine`)).toBe(false);
	});

	it("refuses malformed lineage in an actor generation superseded by a valid final generation", async () => {
		const { sessionFile, journal, store } = await createStore();
		const root = appendActiveRoot(store);
		appendActor(store, root, {
			actorId: "Worker",
			parentId: "Missing",
			generation: 2,
			state: "active",
			at: 8,
		});
		appendActor(store, root, { actorId: "Worker", parentId: "Main", generation: 3, state: "active", at: 9 });
		const original = await fs.readFile(journal, "utf8");
		await expect(repairSessionAuthority(sessionFile)).rejects.toThrow(/missing|parent|lineage/i);
		expect(await fs.readFile(journal, "utf8")).toBe(original);
		expect(syncFs.existsSync(`${journal}.quarantine`)).toBe(false);
	});
	it("refuses an unexplained quarantine marker without changing journal evidence", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendActiveRoot(store);
		const original = await fs.readFile(journal, "utf8");
		await fs.writeFile(`${journal}.quarantine`, "unexplained marker\n", { mode: 0o600 });
		await expect(repairSessionAuthority(sessionFile)).rejects.toThrow(/marker|quarantine/i);
		expect(await fs.readFile(journal, "utf8")).toBe(original);
		expect(await fs.readFile(`${journal}.quarantine`, "utf8")).toBe("unexplained marker\n");
	});

	it("applies a leaf-first append-only repair with immutable original backup", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		await fs.writeFile(`${journal}.quarantine`, "Actor references a missing or invalid parent.\n", { mode: 0o600 });
		const original = await fs.readFile(journal, "utf8");
		const originalHead = store.head();
		const result = await repairSessionAuthority(sessionFile, { apply: true });
		expect(result.status).toBe("repaired");
		expect(result.affectedActorIds).toEqual(["Grandchild", "Child"]);
		const backupDirectory = result.backupDirectory;
		expect(backupDirectory).toBeTruthy();
		if (!backupDirectory) throw new Error("Repair backup directory was not returned.");
		expect(result.originalHead).toEqual(originalHead);
		const staged = await fs.readFile(journal, "utf8");
		expect(syncFs.existsSync(`${journal}.quarantine`)).toBe(false);
		expect(staged.startsWith(original)).toBe(true);
		const backupFiles = await fs.readdir(backupDirectory);
		const backupContents = await Promise.all(
			backupFiles.map(async file => fs.readFile(path.join(backupDirectory, file), "utf8").catch(() => undefined)),
		);
		expect(backupContents).toContain(original);
		expect(backupContents).toContain("Actor references a missing or invalid parent.\n");
		const repaired = new RegistryDurableStateStore(journal).snapshot();
		expect(repaired.actors.get("Main")?.state).toBe("retired");
		expect(repaired.actors.get("Child")?.state).toBe("retired");
		expect(repaired.actors.get("Grandchild")?.state).toBe("retired");
	});
	it("syncs the durable evidence directory entry before publishing the repaired journal", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		await fs.writeFile(`${journal}.quarantine`, "Actor references a missing or invalid parent.\n", { mode: 0o600 });
		const journalDirectory = path.dirname(journal);
		let repairedJournalPublished = false;
		const originalRename = syncFs.renameSync;
		const open = vi.spyOn(syncFs, "openSync");
		const fsync = vi.spyOn(syncFs, "fsyncSync");
		const rename = vi.spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			if (String(destination) === journal && String(source).endsWith(".staged-authority.jsonl")) {
				repairedJournalPublished = true;
				const evidenceDirectoryEntrySynced = open.mock.calls.some(([filePath], index) => {
					if (String(filePath) !== journalDirectory) return false;
					const handle = open.mock.results[index]?.value;
					return typeof handle === "number" && fsync.mock.calls.some(([syncedHandle]) => syncedHandle === handle);
				});
				expect(evidenceDirectoryEntrySynced).toBe(true);
			}
			return originalRename(source, destination);
		});
		try {
			await repairSessionAuthority(sessionFile, { apply: true });
			expect(repairedJournalPublished).toBe(true);
		} finally {
			rename.mockRestore();
			fsync.mockRestore();
			open.mockRestore();
		}
	});
	it("rejects apply while the authority journal is locked and leaves source unchanged", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		const original = await fs.readFile(journal, "utf8");
		const lock = FileLock.tryAcquire(journal);
		expect(lock.acquired).toBe(true);
		try {
			await expect(repairSessionAuthority(sessionFile, { apply: true })).rejects.toThrow(/conflict|lock/i);
			expect(await fs.readFile(journal, "utf8")).toBe(original);
		} finally {
			lock.release();
		}
	});
	it("refuses apply when the verified quarantine marker is locked", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		await fs.writeFile(`${journal}.quarantine`, "Actor references a missing or invalid parent.\n", { mode: 0o600 });
		const original = await fs.readFile(journal, "utf8");
		const markerLock = FileLock.tryAcquire(`${journal}.quarantine`);
		expect(markerLock.acquired).toBe(true);
		try {
			await expect(repairSessionAuthority(sessionFile, { apply: true })).rejects.toThrow(/conflict|lock/i);
			expect(await fs.readFile(journal, "utf8")).toBe(original);
			expect(await fs.readFile(`${journal}.quarantine`, "utf8")).toBe(
				"Actor references a missing or invalid parent.\n",
			);
		} finally {
			markerLock.release();
		}
	});
	it("preserves a distinct quarantine marker installed after the verified marker is captured", async () => {
		const { directory, sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		const markerPath = `${journal}.quarantine`;
		const originalMarker = "Actor references a missing or invalid parent.\n";
		const competingMarker = "Actor references a missing or invalid parent. replaced\n";
		await fs.writeFile(markerPath, originalMarker, { mode: 0o600 });
		const originalMarkerInode = syncFs.statSync(markerPath, { bigint: true }).ino;
		const original = await fs.readFile(journal, "utf8");
		const originalRename = syncFs.renameSync;
		const rename = vi.spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			const result = originalRename(source, destination);
			if (String(source) === markerPath)
				syncFs.writeFileSync(markerPath, competingMarker, { mode: 0o600, flag: "wx" });
			return result;
		});
		try {
			await expect(repairSessionAuthority(sessionFile, { apply: true })).rejects.toThrow(/marker|conflict/i);
			expect((await fs.readFile(journal, "utf8")).startsWith(original)).toBe(true);
			expect(() => new RegistryDurableStateStore(journal).snapshot()).toThrow(/replaced/i);
			expect(await fs.readFile(markerPath, "utf8")).toBe(competingMarker);
			expect(syncFs.statSync(markerPath, { bigint: true }).ino).not.toBe(originalMarkerInode);
			const backupDirectory = (await fs.readdir(directory)).find(entry => entry.startsWith(".authority-repair-"));
			expect(backupDirectory).toBeTruthy();
			if (!backupDirectory) throw new Error("Repair backup directory was not created.");
			const capturedMarker = path.join(directory, backupDirectory, ".captured-quarantine-marker");
			expect(await fs.readFile(capturedMarker, "utf8")).toBe(originalMarker);
			expect(syncFs.statSync(capturedMarker, { bigint: true }).ino).toBe(originalMarkerInode);
		} finally {
			rename.mockRestore();
		}
	});

	it("restores a marker missing during post-publication capture from durable evidence", async () => {
		const { directory, sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		const markerPath = `${journal}.quarantine`;
		const markerText = "Actor references a missing or invalid parent.\n";
		await fs.writeFile(markerPath, markerText, { mode: 0o600 });
		const originalRename = syncFs.renameSync;
		const rename = vi.spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
			if (String(source) === markerPath) syncFs.unlinkSync(markerPath);
			return originalRename(source, destination);
		});
		try {
			await expect(repairSessionAuthority(sessionFile, { apply: true })).rejects.toThrow(/marker|conflict/i);
			expect(await fs.readFile(markerPath, "utf8")).toBe(markerText);
			const backupDirectory = (await fs.readdir(directory)).find(entry => entry.startsWith(".authority-repair-"));
			expect(backupDirectory).toBeTruthy();
			if (!backupDirectory) throw new Error("Repair backup directory was not created.");
			const backupMarker = path.join(directory, backupDirectory, path.basename(markerPath));
			expect(await fs.readFile(backupMarker, "utf8")).toBe(markerText);
			expect(syncFs.statSync(markerPath, { bigint: true }).ino).toBe(
				syncFs.statSync(backupMarker, { bigint: true }).ino,
			);
		} finally {
			rename.mockRestore();
		}
	});

	it("permits fresh registry root creation after repaired legacy descendants are terminal", async () => {
		const { sessionFile, journal, store } = await createStore();
		appendRepairableTree(store);
		await repairSessionAuthority(sessionFile, { apply: true });
		const fresh = realSession();
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValue({ session: fresh.session } as sdk.CreateAgentSessionResult);
		try {
			const registry = new AgentRegistry({ durableState: new RegistryDurableStateStore(journal) });
			const created = await registry.createIsolatedRootSession({ agentId: "Main" });
			expect(created.session).toBe(fresh.session);
			const snapshot = new RegistryDurableStateStore(journal).snapshot();
			expect(snapshot.actors.get("Child")?.state).toBe("retired");
			expect(snapshot.actors.get("Grandchild")?.state).toBe("retired");
			expect(snapshot.actors.get("Main")?.state).toBe("active");
			const clean = await repairSessionAuthority(sessionFile);
			expect(clean.status).toBe("clean");
			expect(clean.affectedActorIds).toEqual([]);
		} finally {
			createSession.mockRestore();
			await fresh.session.dispose();
			fresh.auth.close();
		}
	});
});
