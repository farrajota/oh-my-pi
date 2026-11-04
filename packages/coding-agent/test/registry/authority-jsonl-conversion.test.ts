import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fsNamespace from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { jsonlLayout, listJsonlRotationArtifacts } from "../../src/registry/authority/jsonl-layout";
import { packAuthorityBundle, restoreAuthorityBundle } from "../../src/registry/authority/lifecycle";
import { migrateAuthority, recoverAuthorityMigration } from "../../src/registry/authority/migration";
import { authorityPaths } from "../../src/registry/authority/ownership";
import { openAuthorityPersistence } from "../../src/registry/authority/persistence";
import { AUTHORITY_JSONL_SEGMENT_MIN_BYTES } from "../../src/registry/authority/types";
import type { AuthorityExport, AuthorityIdentity } from "../../src/registry/authority/types";
import {
	canonicalDurableSha256,
	durableGenesisHash,
	registryDurableJournalPath,
} from "../../src/registry/durable-state";
import type { DurableRegistryRecord } from "../../src/registry/durable-state";
import { SessionManager } from "../../src/session/session-manager";

// A conversion that writes a versioned JSONL store from an existing history (SQLite to JSONL, a legacy v1
// upgrade, a bundle restore) must not leave a single segment that every first open replays: once the history
// reaches the rotation threshold the converted store starts rotated, so its first open reads the snapshot and
// an empty active segment. Each case compares the bytes that first open reads at two history sizes.

const directories: string[] = [];
const restoredId = "019ed677-02fb-7000-8dac-396e2f84d484";
// Each size builds a multi-MiB history and runs full conversions, which verify that history end to end several times.
const CONVERSION_TEST_TIMEOUT_MS = 300_000;

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function selected(file: string): Promise<{ readonly payload: string; readonly identity: AuthorityIdentity }> {
	const descriptor = await readAuthorityDescriptor(file);
	if (!descriptor) throw new Error("Expected a selected authority descriptor.");
	return {
		payload: path.join(path.dirname(file), descriptor.payload),
		identity: {
			backend: descriptor.backend,
			owningSessionId: descriptor.owningSessionId,
			incarnation: descriptor.incarnation,
			format: 2,
		},
	};
}

async function offlineState(file: string): Promise<AuthorityExport> {
	const { payload, identity } = await selected(file);
	const driver = openAuthorityPersistence({ path: payload, identity, create: false });
	try {
		driver.integrityCheck();
		return driver.exportState();
	} finally {
		driver.close();
	}
}

function withoutIdentity(state: AuthorityExport): Omit<AuthorityExport, "sourceIdentity"> {
	const { sourceIdentity: _identity, ...rest } = state;
	return rest;
}

function bytesReadBy(run: () => void): number {
	let bytes = 0;
	const readSync = fsNamespace.readSync;
	const spy = spyOn(fsNamespace, "readSync").mockImplementation(((...args: Parameters<typeof readSync>) => {
		const read = readSync(...args);
		bytes += read;
		return read;
	}) as typeof readSync);
	try {
		run();
	} finally {
		spy.mockRestore();
	}
	return bytes;
}

/** Bytes the first open of the selected JSONL store reads, with the sizes of what it must and must not read. */
async function firstOpen(
	file: string,
): Promise<{ readonly read: number; readonly snapshot: number; readonly active: number; readonly sealed: number }> {
	const { payload, identity } = await selected(file);
	expect(identity.backend).toBe("jsonl");
	const layout = jsonlLayout(payload);
	const read = bytesReadBy(() => {
		new JsonlAuthorityPersistence({ path: payload, identity, create: false }).close();
	});
	const snapshots = listJsonlRotationArtifacts(payload).filter(artifact => artifact.kind === "snapshot");
	const snapshot = snapshots.reduce((total, artifact) => total + fsNamespace.statSync(artifact.file).size, 0);
	const sealed = listJsonlRotationArtifacts(payload)
		.filter(artifact => artifact.kind === "segment")
		.reduce((total, artifact) => total + fsNamespace.statSync(artifact.file).size, 0);
	return { read, snapshot, active: fsNamespace.statSync(layout.active).size, sealed };
}

/** A selected JSONL root holding `batches` frames of 50 terminal operations each, written offline. */
async function historySession(
	directory: string,
	batches: number,
): Promise<{ readonly file: string; readonly id: string }> {
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "conversion fixture", timestamp: 1 });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Fixture did not create a transcript.");
	const id = manager.getSessionId();
	const store = await registryDurableStateForSession(file, { owningSessionId: id, backend: "jsonl", create: true });
	await store.close();
	await manager.close();
	const { payload, identity } = await selected(file);
	const engine = new AuthorityEngine(
		new JsonlAuthorityPersistence({ path: payload, identity, create: false }),
		"history-owner",
	);
	engine.recover();
	for (let batch = 0; batch < batches; batch++) {
		const records: DurableRegistryRecord[] = [];
		for (let index = 0; index < 50; index++) {
			const operation = {
				kind: "operation" as const,
				at: 10,
				operationId: `op-${batch}-${index}-${"p".repeat(120)}`,
				effectClass: "eval" as const,
				ownerId: "actor-1",
				classOwnerId: "root-1",
				actorId: "actor-1",
				rootId: "root-1",
				generation: 1,
				acquiredAt: 10,
				expiresAt: 100,
			};
			records.push({ ...operation, phase: "intent" }, { ...operation, phase: "abandoned" });
		}
		engine.transitionBatch(records, { requestId: `history-${batch}` });
	}
	engine.close();
	return { file, id };
}

/** Converts a JSONL history to SQLite and back, so the measured store is the SQLite-to-JSONL conversion of that history. */
async function convertedThroughSqlite(file: string): Promise<AuthorityExport> {
	expect((await migrateAuthority(file, "sqlite", { apply: true })).status).toBe("migrated");
	const sqlite = await offlineState(file);
	expect((await migrateAuthority(file, "jsonl", { apply: true })).status).toBe("migrated");
	return sqlite;
}

describe("SQLite to JSONL conversion", () => {
	it(
		"writes a long history rotated, so its first open reads only the snapshot and active segment at two sizes",
		async () => {
			const measured: Array<{ read: number; sealed: number }> = [];
			for (const batches of [90, 180]) {
				const directory = await makeDirectory("omp-convert-sqlite-");
				const { file } = await historySession(directory, batches);
				const sqlite = await convertedThroughSqlite(file);
				const open = await firstOpen(file);
				// Guard the fixture: the converted history must reach the rotation threshold.
				expect(open.sealed).toBeGreaterThanOrEqual(AUTHORITY_JSONL_SEGMENT_MIN_BYTES);
				expect(open.read).toBeGreaterThanOrEqual(open.snapshot + open.active);
				expect(open.read).toBeLessThanOrEqual(open.snapshot + open.active + 1);
				expect(withoutIdentity(await offlineState(file))).toEqual(withoutIdentity(sqlite));
				measured.push({ read: open.read, sealed: open.sealed });
			}
			const [small, large] = measured as [{ read: number; sealed: number }, { read: number; sealed: number }];
			expect(large.sealed).toBeGreaterThan(small.sealed * 2);
			for (const sample of measured) expect(sample.read).toBeLessThan(sample.sealed);
		},
		CONVERSION_TEST_TIMEOUT_MS,
	);

	it(
		"keeps a short history a single segment",
		async () => {
			const directory = await makeDirectory("omp-convert-short-");
			const { file } = await historySession(directory, 2);
			await convertedThroughSqlite(file);
			expect(listJsonlRotationArtifacts(authorityPaths(file).jsonl)).toEqual([]);
		},
		CONVERSION_TEST_TIMEOUT_MS,
	);

	it(
		"rolls a rotated target back on abort and completes it on finish after a publication cut",
		async () => {
			const directory = await makeDirectory("omp-convert-cut-");
			const { file, id } = await historySession(directory, 90);
			expect((await migrateAuthority(file, "sqlite", { apply: true })).status).toBe("migrated");
			const sqlite = await offlineState(file);
			await expect(
				migrateAuthority(file, "jsonl", { apply: true, faultAt: "target-published-main" }),
			).rejects.toThrow("Injected migration fault");
			// The payload is published after its rotation files, so a cut there has every rotation file in place.
			expect(listJsonlRotationArtifacts(authorityPaths(file).jsonl).length).toBe(3);
			expect((await recoverAuthorityMigration(file, "abort")).status).toBe("recovered");
			expect(listJsonlRotationArtifacts(authorityPaths(file).jsonl)).toEqual([]);
			expect(await Bun.file(authorityPaths(file).jsonl).exists()).toBe(false);
			expect(withoutIdentity(await offlineState(file))).toEqual(withoutIdentity(sqlite));
			await expect(migrateAuthority(file, "jsonl", { apply: true, faultAt: "target-publishing" })).rejects.toThrow(
				"Injected migration fault",
			);
			expect((await recoverAuthorityMigration(file, "finish")).status).toBe("recovered");
			const open = await firstOpen(file);
			expect(open.read).toBeLessThanOrEqual(open.snapshot + open.active + 1);
			expect(withoutIdentity(await offlineState(file))).toEqual(withoutIdentity(sqlite));
			const store = await registryDurableStateForSession(file, { owningSessionId: id });
			await store.close();
		},
		CONVERSION_TEST_TIMEOUT_MS,
	);
});

describe("legacy v1 upgrade", () => {
	/** A legacy v1 journal written directly in its persisted format: each entry hash-chained to its predecessor. */
	async function legacySession(directory: string, operations: number): Promise<string> {
		const id = "019ed676-02fb-7000-8dac-396e2f84d484";
		const file = path.join(directory, "root.jsonl");
		await Bun.write(
			file,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
		);
		const startupHash = canonicalDurableSha256("Main:startup");
		const provenanceHash = canonicalDurableSha256("Main:provenance");
		const headHash = canonicalDurableSha256({
			rootId: "Main",
			generation: 1,
			actorId: "Main",
			startupHash,
			provenanceHash,
		});
		const construction = {
			kind: "construction" as const,
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			startupHash,
			provenanceHash,
		};
		const records: DurableRegistryRecord[] = [
			{ ...construction, at: 1, phase: "reserved" },
			{ ...construction, at: 2, phase: "constructing" },
			{ ...construction, at: 3, phase: "constructed" },
			{ kind: "root", at: 4, rootId: "Main", generation: 1, headHash, state: "active" },
			{
				kind: "actor",
				at: 5,
				actorId: "Main",
				rootId: "Main",
				generation: 1,
				rootGeneration: 1,
				rootHeadHash: headHash,
				startupHash,
				provenanceHash,
				state: "active",
			},
			{ ...construction, at: 6, phase: "activated" },
		];
		for (let index = 0; index < operations; index++) {
			const operation = {
				kind: "operation" as const,
				at: 10,
				operationId: `op-${index}-${"p".repeat(120)}`,
				effectClass: "eval" as const,
				ownerId: "Main",
				classOwnerId: "Main",
				actorId: "Main",
				rootId: "Main",
				generation: 1,
				acquiredAt: 10,
				expiresAt: 100,
			};
			records.push({ ...operation, phase: "intent" }, { ...operation, phase: "abandoned" });
		}
		let previousHash = durableGenesisHash();
		const lines: string[] = [];
		for (const [index, record] of records.entries()) {
			const base = {
				version: 1 as const,
				sequence: index + 1,
				previousHash,
				contentHash: canonicalDurableSha256(record),
				record,
			};
			const hash = canonicalDurableSha256(base);
			lines.push(JSON.stringify({ ...base, hash }));
			previousHash = hash;
		}
		await fs.writeFile(registryDurableJournalPath(file), `${lines.join("\n")}\n`, { mode: 0o600 });
		return file;
	}

	it(
		"upgrades a long legacy journal rotated, so its first open reads only the snapshot and active segment at two sizes",
		async () => {
			const measured: Array<{ read: number; sealed: number }> = [];
			for (const operations of [4_000, 12_000]) {
				const directory = await makeDirectory("omp-convert-legacy-");
				const file = await legacySession(directory, operations);
				expect((await migrateAuthority(file, "jsonl", { apply: true })).status).toBe("migrated");
				const open = await firstOpen(file);
				expect(open.sealed).toBeGreaterThanOrEqual(AUTHORITY_JSONL_SEGMENT_MIN_BYTES);
				expect(open.read).toBeLessThanOrEqual(open.snapshot + open.active + 1);
				const state = await offlineState(file);
				expect(state.legacy?.entries.length).toBe(6 + 2 * operations);
				measured.push({ read: open.read, sealed: open.sealed });
			}
			const [small, large] = measured as [{ read: number; sealed: number }, { read: number; sealed: number }];
			expect(large.sealed).toBeGreaterThan(small.sealed * 2);
			for (const sample of measured) expect(sample.read).toBeLessThan(sample.sealed);
		},
		CONVERSION_TEST_TIMEOUT_MS,
	);
});

describe("bundle restore", () => {
	it(
		"restores a long history rotated, so its first open reads only the snapshot and active segment at two sizes",
		async () => {
			const measured: Array<{ read: number; sealed: number }> = [];
			for (const batches of [90, 180]) {
				const sourceDirectory = await makeDirectory("omp-convert-restore-source-");
				const targetDirectory = await makeDirectory("omp-convert-restore-target-");
				const { file } = await historySession(sourceDirectory, batches);
				const source = await offlineState(file);
				const bundle = await packAuthorityBundle(file);
				if (!bundle) throw new Error("Expected an authority bundle.");
				const target = path.join(targetDirectory, `${restoredId}.jsonl`);
				await Bun.write(
					target,
					`${JSON.stringify({ type: "session", version: 3, id: restoredId, timestamp: "2026-01-01T00:00:00.000Z", cwd: targetDirectory })}\n`,
				);
				await restoreAuthorityBundle(target, bundle);
				const open = await firstOpen(target);
				expect(open.sealed).toBeGreaterThanOrEqual(AUTHORITY_JSONL_SEGMENT_MIN_BYTES);
				expect(open.read).toBeLessThanOrEqual(open.snapshot + open.active + 1);
				expect(withoutIdentity(await offlineState(target))).toEqual(withoutIdentity(source));
				const store = await registryDurableStateForSession(target, { owningSessionId: restoredId });
				await store.close();
				measured.push({ read: open.read, sealed: open.sealed });
			}
			const [small, large] = measured as [{ read: number; sealed: number }, { read: number; sealed: number }];
			expect(large.sealed).toBeGreaterThan(small.sealed * 2);
			for (const sample of measured) expect(sample.read).toBeLessThan(sample.sealed);
		},
		CONVERSION_TEST_TIMEOUT_MS,
	);
});
