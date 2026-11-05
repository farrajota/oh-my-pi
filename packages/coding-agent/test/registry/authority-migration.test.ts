import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
	migrateAuthority,
	recoverAuthorityMigration,
	repairSelectedAuthority,
} from "../../src/registry/authority/migration";
import {
	acquireAuthorityOwnership,
	authorityPaths,
	LEGACY_AUTHORITY_DENIAL_REASON,
} from "../../src/registry/authority/ownership";
import { readAuthorityDescriptor, writeAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import type { AuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { cesu8Encode } from "../../src/registry/authority/sqlite-codec";
import { AuthorityCleanupError } from "../../src/registry/authority/private-cleanup";
import {
	canonicalDurableSha256,
	durableBackingSha256,
	RegistryDurableStateStore,
	registryDurableJournalPath,
} from "../../src/registry/durable-state";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { packAuthorityBundle, restoreAuthorityBundle } from "../../src/registry/authority/lifecycle";
import { openAuthorityPersistence } from "../../src/registry/authority/persistence";
import type { AuthorityExport, JournalingBackend } from "../../src/registry/authority/types";
import { durableGenesisHash } from "../../src/registry/durable-state";
import { SessionManager } from "../../src/session/session-manager";

const directories: string[] = [];
const rootId = "019ed676-02fb-7000-8dac-396e2f84d484";
const crashCuts = [
	"manifest-created",
	"backup-synced",
	"source-frozen",
	"target-staged",
	"target-verified",
	"legacy-fenced",
	"target-publishing",
	"target-published-main",
	"target-published-wal",
	"target-published-shm",
	"target-published",
	"descriptor-published",
	"migration-ready",
	"manifest-finalized",
	"legacy-source-denied",
	"before-descriptor-publication",
] as const;

function hash(value: unknown): string {
	return canonicalDurableSha256(value);
}

function normalizedExport(value: AuthorityExport): AuthorityExport {
	return {
		...value,
		rows: [...value.rows].sort((a, b) => JSON.stringify(a.record).localeCompare(JSON.stringify(b.record))),
		controls: [...value.controls].sort((a, b) => a.key.localeCompare(b.key)),
	};
}

async function fixture(): Promise<{ sessionFile: string; legacy: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-migration-"));
	directories.push(directory);
	const sessionFile = path.join(directory, "root.jsonl");
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: rootId, timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
	);
	const generation = 1;
	const startupHash = hash("Main:startup");
	const provenanceHash = hash("Main:provenance");
	const headHash = hash({ rootId: "Main", generation, actorId: "Main", startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		actorId: "Main",
		rootId: "Main",
		generation,
		startupHash,
		provenanceHash,
	};
	const legacy = registryDurableJournalPath(sessionFile);
	const store = new RegistryDurableStateStore(legacy);
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
	store.append({ kind: "root", at: 7, rootId: "Main", generation, headHash, state: "active" });
	return { sessionFile, legacy };
}

// The live SQLite connection holds an exclusive lock, so no second reader can pin
// its WAL, and a clean close checkpoints and removes it. A WAL-bearing fixture is
// the real quiescent main/WAL pair captured after the last COMMIT and reinstalled
// after close: exactly the installed image of a crash before checkpoint. Only
// offline (non-live) connections may then pin it with a shared reader.
async function captureSqliteCrashImage(database: string): Promise<() => Promise<void>> {
	const [main, wal] = await Promise.all([fs.readFile(database), fs.readFile(`${database}-wal`)]);
	return async () => {
		await fs.writeFile(database, main);
		await fs.writeFile(`${database}-wal`, wal, { mode: 0o600 });
	};
}

async function offlineState(sessionFile: string): Promise<AuthorityExport> {
	const descriptor = await readAuthorityDescriptor(sessionFile);
	if (!descriptor) throw new Error("Expected selected authority.");
	const driver = openAuthorityPersistence({
		path: path.join(path.dirname(sessionFile), descriptor.payload),
		identity: {
			backend: descriptor.backend,
			owningSessionId: descriptor.owningSessionId,
			incarnation: descriptor.incarnation,
			format: 2,
		},
		create: false,
	});
	try {
		driver.integrityCheck();
		return driver.exportState();
	} finally {
		driver.close();
	}
}

async function writtenFixture(backend: JournalingBackend): Promise<{ sessionFile: string; before: AuthorityExport }> {
	const { sessionFile } = await fixture();
	await migrateAuthority(sessionFile, backend, { apply: true });
	const store = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
	try {
		const rootConstruction = {
			kind: "construction" as const,
			at: 10,
			actorId: "Evidence",
			rootId: "Evidence",
			generation: 2,
			startupHash: hash("Evidence:startup"),
			provenanceHash: hash("Evidence:provenance"),
		};
		await store.transitionBatch(
			[
				{ ...rootConstruction, phase: "reserved" },
				{ ...rootConstruction, at: 11, phase: "constructing" },
				{ ...rootConstruction, at: 12, phase: "constructed" },
			],
			{ requestId: "evidence-root-construction" },
		);
		const rootHeadHash = hash({
			rootId: "Evidence",
			generation: 2,
			actorId: "Evidence",
			startupHash: rootConstruction.startupHash,
			provenanceHash: rootConstruction.provenanceHash,
		});
		await store.activateAuthority(
			{
				root: { kind: "root", at: 13, rootId: "Evidence", generation: 2, headHash: rootHeadHash, state: "active" },
				actor: {
					kind: "actor",
					at: 13,
					actorId: "Evidence",
					rootId: "Evidence",
					generation: 2,
					rootGeneration: 2,
					rootHeadHash,
					startupHash: rootConstruction.startupHash,
					provenanceHash: rootConstruction.provenanceHash,
					state: "active",
				},
				construction: { ...rootConstruction, at: 13, phase: "activated" },
				gate: { kind: "gate", at: 13, rootId: "Evidence", generation: 2, phase: "open" },
			},
			{ requestId: "evidence-root-activation" },
		);
		const child = {
			kind: "construction" as const,
			at: 14,
			actorId: "Child",
			parentId: "Evidence",
			rootId: "Evidence",
			generation: 3,
			startupHash: hash("Child:startup"),
			provenanceHash: hash("Child:provenance"),
		};
		await store.transitionBatch(
			[
				{ ...child, phase: "reserved" },
				{ ...child, at: 15, phase: "constructing" },
				{ ...child, at: 16, phase: "constructed" },
			],
			{ requestId: "historical-child-construction" },
		);
		const actor = {
			kind: "actor" as const,
			at: 17,
			actorId: "Child",
			parentId: "Evidence",
			rootId: "Evidence",
			generation: 3,
			rootGeneration: 2,
			rootHeadHash,
			startupHash: child.startupHash,
			provenanceHash: child.provenanceHash,
			state: "active" as const,
		};
		await store.activateAuthority(
			{ actor, construction: { ...child, at: 17, phase: "activated" } },
			{ requestId: "historical-child-activation" },
		);
		await store.transition({ ...actor, at: 18, state: "retired" }, { requestId: "historical-child-retirement" });
		const claim = await store.reserveLocal(
			{ localId: "publication", entryId: "first", entryHash: hash("first"), expectedHeadHash: durableGenesisHash() },
			{ requestId: "historical-claim" },
		);
		await store.authorizeLocalEffect(claim, { requestId: "historical-authorization" });
		await store.finalizeLocal({ ...claim, phase: "effect" }, "committed", { requestId: "historical-publication" });
	} finally {
		await store.close();
	}
	return { sessionFile, before: await offlineState(sessionFile) };
}

interface MigrationBackupRecord {
	readonly sourceBackend: string;
	readonly targetBackend: string;
	readonly backupName: string;
	readonly sourceFiles: readonly { readonly name: string; readonly digest: string }[];
}

interface MigrationBackupSnapshot {
	readonly directory: string;
	readonly files: readonly { readonly name: string; readonly digest: string; readonly bytes: Buffer }[];
}

async function sqliteRecoveryBackup(sessionFile: string): Promise<MigrationBackupSnapshot | undefined> {
	const directory = path.dirname(sessionFile);
	const base = path.basename(sessionFile);
	const records: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.startsWith(`${base}.authority.migration.`))
			records.push(path.join(directory, entry.name));
		if (entry.isDirectory() && entry.name.startsWith(`${base}.authority.backup.`)) {
			for (const name of await fs.readdir(path.join(directory, entry.name))) {
				if (name === "migration.json" || name === "migration-aborted.json")
					records.push(path.join(directory, entry.name, name));
			}
		}
	}
	for (const file of records) {
		const record = JSON.parse(await fs.readFile(file, "utf8")) as MigrationBackupRecord;
		if (record.sourceBackend !== "sqlite" || record.targetBackend !== "jsonl" || !record.sourceFiles.length) continue;
		const backup = path.join(directory, record.backupName);
		const files = await Promise.all(
			record.sourceFiles.map(async source => ({
				...source,
				bytes: await fs.readFile(path.join(backup, source.name)),
			})),
		);
		return { directory: backup, files };
	}
	return undefined;
}

async function expectBackupPreserved(snapshot: MigrationBackupSnapshot): Promise<void> {
	const names = (await fs.readdir(snapshot.directory))
		.filter(name => name !== "migration.json" && name !== "migration-aborted.json")
		.sort();
	expect(names).toEqual(snapshot.files.map(file => file.name).sort());
	for (const original of snapshot.files) {
		expect(durableBackingSha256(original.bytes)).toBe(original.digest);
		const current = await fs.readFile(path.join(snapshot.directory, original.name));
		expect(current.equals(original.bytes)).toBe(true);
		expect(durableBackingSha256(current)).toBe(original.digest);
	}
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

// Each crash-matrix case performs real authority opens (funded capacity, exclusive
// SQLite configuration), offline conversion and repeated recovery with fsyncs:
// 1-13 s per case on the shared XFS host, past Bun's 5 s default while completing.
const MIGRATION_MATRIX_TIMEOUT_MS = 30_000;

describe("authority migration crash recovery", () => {
	for (const cut of crashCuts) {
		it(
			`finishes idempotently after the ${cut} durable cut`,
			async () => {
				const { sessionFile, legacy } = await fixture();
				const originalEntries = (await fs.readFile(legacy, "utf8"))
					.trimEnd()
					.split("\n")
					.map(line => JSON.parse(line));
				await expect(migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: cut })).rejects.toThrow(
					/injected migration fault/i,
				);

				await recoverAuthorityMigration(sessionFile, "finish");
				const descriptor = await readAuthorityDescriptor(sessionFile);
				expect(descriptor?.backend).toBe("sqlite");
				expect(descriptor?.state).toBe("active");
				expect(await Bun.file(authorityPaths(sessionFile).sqlite).exists()).toBe(true);
				const reopened = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
				try {
					expect((await reopened.getRoot("Main"))?.record).toMatchObject({
						kind: "root",
						generation: 1,
						state: "active",
					});
					expect((await reopened.getActor("Main"))?.record).toMatchObject({
						kind: "actor",
						generation: 1,
						state: "active",
					});
					expect((await reopened.getConstruction("Main", "Main", 1))?.record.phase).toBe("activated");
					const exported = await reopened.exportState();
					expect(exported.legacy?.entries).toEqual(originalEntries);
					expect(
						exported.frames.every(frame => frame.command.kind === "owner" || frame.command.kind === "recover"),
					).toBe(true);
					for (const control of exported.controls.filter(item => item.key.startsWith("receipt:"))) {
						expect(
							exported.frames.some(frame => JSON.stringify(frame.receipt) === JSON.stringify(control.value)),
						).toBe(true);
					}
				} finally {
					await reopened.close();
				}
				await recoverAuthorityMigration(sessionFile, "finish");
			},
			MIGRATION_MATRIX_TIMEOUT_MS,
		);
	}

	it("rejects abort when the captured legacy source changed after backup", async () => {
		const { sessionFile, legacy } = await fixture();
		const original = await Bun.file(legacy).text();
		await expect(
			migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "target-verified" }),
		).rejects.toThrow(/injected migration fault/i);
		await Bun.write(legacy, `${original} `);
		await expect(recoverAuthorityMigration(sessionFile, "abort")).rejects.toThrow(
			/source changed|backup|abort safely|partial record/i,
		);
		expect(await Bun.file(legacy).text()).toBe(`${original} `);
	});

	it("fences cached legacy readers with a durable unsupported-version source record", async () => {
		const { sessionFile, legacy } = await fixture();
		const original = await Bun.file(legacy).arrayBuffer();
		const cached = new RegistryDurableStateStore(legacy);
		cached.head();
		await expect(
			migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "legacy-source-denied" }),
		).rejects.toThrow(/injected migration fault/i);
		const denied = await Bun.file(legacy).arrayBuffer();
		expect(denied.byteLength).toBeGreaterThan(0);
		expect(denied).not.toEqual(original);
		expect(await Bun.file(authorityPaths(sessionFile).legacyFence).text()).toBe(LEGACY_AUTHORITY_DENIAL_REASON);
		expect(() => cached.head()).toThrow();
		await expect(recoverAuthorityMigration(sessionFile, "abort")).resolves.toMatchObject({
			status: "recovered",
			targetBackend: "jsonl",
		});
		await expect(recoverAuthorityMigration(sessionFile, "abort")).resolves.toMatchObject({
			status: "recovered",
			targetBackend: "jsonl",
		});
		expect(await Bun.file(legacy).arrayBuffer()).toEqual(original);
		expect(await Bun.file(authorityPaths(sessionFile).legacyFence).exists()).toBe(false);
		const eligible = new RegistryDurableStateStore(legacy);
		expect(eligible.head()?.sequence).toBe(7);
	});

	it("rejects a symlinked backup directory while finishing a staged migration", async () => {
		const { sessionFile } = await fixture();
		await expect(
			migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "target-verified" }),
		).rejects.toThrow(/injected migration fault/i);
		const parent = path.dirname(sessionFile);
		const manifestName = (await fs.readdir(parent)).find(
			name => name.startsWith(`${path.basename(sessionFile)}.authority.migration.`) && name.endsWith(".json"),
		);
		if (!manifestName) throw new Error("Expected the interrupted migration manifest.");
		const manifest = JSON.parse(await fs.readFile(path.join(parent, manifestName), "utf8")) as { backupName: string };
		const backup = path.join(parent, manifest.backupName);
		const retained = `${backup}.retained`;
		await fs.rename(backup, retained);
		await fs.symlink(retained, backup);

		await expect(recoverAuthorityMigration(sessionFile, "finish")).rejects.toThrow(/directory|symlink|backup/i);
		expect(await Bun.file(path.join(retained, "migration.json")).exists()).toBe(false);
	});

	it("keeps a selected target unavailable when its recorded semantic state is corrupted", async () => {
		const { sessionFile } = await fixture();
		await expect(
			migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "descriptor-published" }),
		).rejects.toThrow(/injected migration fault/i);
		const paths = authorityPaths(sessionFile);
		const selectedBefore = await readAuthorityDescriptor(sessionFile);
		const metaKey = cesu8Encode("meta");
		const database = new Database(paths.sqlite);
		try {
			const meta = database
				.query<{ value: string }, [Uint8Array]>("SELECT value FROM authority_controls WHERE order_key = ?")
				.get(metaKey);
			if (!meta) throw new Error("Expected selected SQLite metadata.");
			const corrupted = { ...JSON.parse(meta.value), generationHighWater: 999999 };
			database.run("UPDATE authority_controls SET value = ? WHERE order_key = ?", [
				JSON.stringify(corrupted),
				metaKey,
			]);
			expect(
				database
					.query<{ value: string }, [Uint8Array]>("SELECT value FROM authority_controls WHERE order_key = ?")
					.get(metaKey)?.value,
			).toBe(JSON.stringify(corrupted));
		} finally {
			database.close();
		}
		const check = new Database(paths.sqlite, { readonly: true });
		try {
			const meta = check
				.query<{ value: string }, [Uint8Array]>("SELECT value FROM authority_controls WHERE order_key = ?")
				.get(metaKey);
			if (!meta) throw new Error("Expected corrupted selected SQLite metadata.");
			expect(JSON.parse(meta.value).generationHighWater).toBe(999999);
		} finally {
			check.close();
		}
		await expect(recoverAuthorityMigration(sessionFile, "finish")).rejects.toThrow();
		expect(await readAuthorityDescriptor(sessionFile)).toEqual(selectedBefore);
		expect(selectedBefore?.state).toBe("initializing");
	});

	it("allows abort only before descriptor selection and preserves exact legacy source bytes", async () => {
		const { sessionFile, legacy } = await fixture();
		const original = await Bun.file(legacy).arrayBuffer();
		await expect(
			migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "target-verified" }),
		).rejects.toThrow(/injected migration fault/i);

		await recoverAuthorityMigration(sessionFile, "abort");
		await recoverAuthorityMigration(sessionFile, "abort");

		expect(await Bun.file(legacy).arrayBuffer()).toEqual(original);
		expect(await Bun.file(authorityPaths(sessionFile).descriptor).exists()).toBe(false);
	});

	it("never aborts to a stale source after the descriptor selected the target", async () => {
		const { sessionFile } = await fixture();
		await expect(
			migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "descriptor-published" }),
		).rejects.toThrow(/injected migration fault/i);

		await expect(recoverAuthorityMigration(sessionFile, "abort")).rejects.toThrow(/selected target|finish/i);
		await recoverAuthorityMigration(sessionFile, "finish");
		expect((await readAuthorityDescriptor(sessionFile))?.backend).toBe("sqlite");
	});
	it("refuses orphan payloads without a persistent anchor before migration", async () => {
		const { sessionFile, legacy } = await fixture();
		const original = await fs.readFile(legacy);
		const orphan = authorityPaths(sessionFile).jsonl;
		await fs.writeFile(orphan, "unexplained authority", { mode: 0o600 });
		await expect(migrateAuthority(sessionFile, "sqlite", { apply: true })).rejects.toThrow(
			/Authority artifacts exist without their persistent lock anchor; refusing recreation/,
		);
		expect(await fs.readFile(legacy)).toEqual(original);
		expect(await fs.readFile(orphan, "utf8")).toBe("unexplained authority");
		expect(await Bun.file(authorityPaths(sessionFile).descriptor).exists()).toBe(false);
	});

	it("does not report repeated finish after the mandatory denial fence is removed", async () => {
		const { sessionFile } = await fixture();
		await migrateAuthority(sessionFile, "sqlite", { apply: true });
		await fs.rm(authorityPaths(sessionFile).legacyFence);
		await expect(recoverAuthorityMigration(sessionFile, "finish")).rejects.toThrow(/fence|marker/i);
	});
	it("restores a migrated legacy denial with its exact original evidence", async () => {
		const { sessionFile, legacy } = await fixture();
		const original = await fs.readFile(legacy);
		await migrateAuthority(sessionFile, "sqlite", { apply: true });
		const bundle = await packAuthorityBundle(sessionFile);
		if (!bundle) throw new Error("Missing migrated bundle.");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-restore-denial-"));
		directories.push(directory);
		const target = path.join(directory, "root.jsonl");
		await fs.copyFile(sessionFile, target);
		await restoreAuthorityBundle(target, bundle);
		expect(await fs.readFile(authorityPaths(target).legacy)).toEqual(await fs.readFile(legacy));
		expect(
			bundle.entries.some(
				entry => entry.name.startsWith("authority.backup.") && Buffer.from(entry.data).equals(original),
			),
		).toBe(true);
		const reopened = await registryDurableStateForSession(target, { owningSessionId: rootId });
		try {
			expect((await reopened.exportState()).legacy?.entries).toHaveLength(7);
		} finally {
			await reopened.close();
		}
	});
	it("refuses to restore known unresolved external effects", async () => {
		const { sessionFile } = await fixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		const source = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
		const now = Date.now();
		await source.transition({
			kind: "operation",
			at: now,
			operationId: "restore-pending",
			effectClass: "session",
			ownerId: "Main",
			classOwnerId: "Main",
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			acquiredAt: now,
			expiresAt: now + 60_000,
			phase: "intent",
		});
		await source.close();
		const bundle = await packAuthorityBundle(sessionFile);
		if (!bundle) throw new Error("Missing authority bundle.");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-restore-pending-"));
		directories.push(directory);
		const target = path.join(directory, "root.jsonl");
		await fs.copyFile(sessionFile, target);
		await expect(restoreAuthorityBundle(target, bundle)).rejects.toThrow(/unresolved/i);
		expect(await Bun.file(authorityPaths(target).descriptor).exists()).toBe(false);
	});
	it("refuses reverse migration while an external operation remains unresolved", async () => {
		const { sessionFile } = await fixture();
		await migrateAuthority(sessionFile, "sqlite", { apply: true });
		const store = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
		const now = Date.now();
		await store.transition({
			kind: "operation",
			at: now,
			operationId: "pending-operation",
			effectClass: "session",
			ownerId: "Main",
			classOwnerId: "Main",
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			acquiredAt: now,
			expiresAt: now + 60_000,
			phase: "intent",
		});
		await store.close();

		await expect(migrateAuthority(sessionFile, "jsonl", { apply: true })).rejects.toThrow(/unresolved/i);
		expect((await readAuthorityDescriptor(sessionFile))?.backend).toBe("sqlite");
		const reopened = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
		const operation = await reopened.getOperation("Main", "session", "pending-operation");
		expect(operation?.record.phase).toBe("intent");
		await reopened.close();
	});
	for (const invalid of ["missing", "changed", "competing"] as const) {
		it(`refuses ${invalid} selected artifacts before migration or repair`, async () => {
			const { sessionFile } = await fixture();
			await migrateAuthority(sessionFile, "jsonl", { apply: true });
			const paths = authorityPaths(sessionFile);
			if (invalid === "missing") await fs.rm(paths.legacyFence);
			else if (invalid === "changed")
				await fs.writeFile(paths.legacyFence, "unrecognized quarantine", { mode: 0o600 });
			else await fs.writeFile(paths.sqlite, "competing", { mode: 0o600 });
			const before = await fs.readFile(paths.descriptor);
			for (const apply of [false, true]) {
				await expect(migrateAuthority(sessionFile, "jsonl", { apply })).rejects.toThrow();
				await expect(migrateAuthority(sessionFile, "sqlite", { apply })).rejects.toThrow();
				await expect(repairSelectedAuthority(sessionFile, { apply })).rejects.toThrow();
			}
			expect(await fs.readFile(paths.descriptor)).toEqual(before);
			if (invalid === "missing") expect(await Bun.file(paths.legacyFence).exists()).toBe(false);
		});
	}
	for (const sourceBackend of ["jsonl", "sqlite"] as const) {
		const targetBackend = sourceBackend === "jsonl" ? "sqlite" : "jsonl";
		for (const cut of crashCuts) {
			it(
				`${sourceBackend} to ${targetBackend} finishes ${cut} with every evidence field unchanged`,
				async () => {
					const { sessionFile, before } = await writtenFixture(sourceBackend);
					const transcript = await fs.readFile(sessionFile);
					await expect(
						migrateAuthority(sessionFile, targetBackend, { apply: true, faultAt: cut }),
					).rejects.toThrow(/injected migration fault/i);
					await recoverAuthorityMigration(sessionFile, "finish");
					await recoverAuthorityMigration(sessionFile, "finish");
					const after = await offlineState(sessionFile);
					expect(normalizedExport({ ...after, sourceIdentity: before.sourceIdentity })).toEqual(
						normalizedExport(before),
					);
					expect(await fs.readFile(sessionFile)).toEqual(transcript);
					const reopened = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
					try {
						expect((await reopened.getConstruction("Evidence", "Child", 3))?.record.phase).toBe("activated");
						expect(await reopened.localBacking("publication")).toMatchObject({
							entryId: "first",
							entryHash: hash("first"),
							version: 1,
						});
						expect((await reopened.getActorGeneration("Child", 3))?.record.parentId).toBe("Evidence");
					} finally {
						await reopened.close();
					}
				},
				MIGRATION_MATRIX_TIMEOUT_MS,
			);
			it(
				`${sourceBackend} to ${targetBackend} abort disposition at ${cut} never rolls back a selected target`,
				async () => {
					const { sessionFile, before } = await writtenFixture(sourceBackend);
					await expect(
						migrateAuthority(sessionFile, targetBackend, { apply: true, faultAt: cut }),
					).rejects.toThrow(/injected migration fault/i);
					const selected = ["descriptor-published", "migration-ready", "manifest-finalized"].includes(cut);
					if (selected && cut !== "manifest-finalized") {
						await expect(recoverAuthorityMigration(sessionFile, "abort")).rejects.toThrow(
							/selected target|finish/i,
						);
						await recoverAuthorityMigration(sessionFile, "finish");
					} else {
						await recoverAuthorityMigration(sessionFile, "abort");
						await recoverAuthorityMigration(sessionFile, "abort");
					}
					expect((await readAuthorityDescriptor(sessionFile))?.backend).toBe(
						selected ? targetBackend : sourceBackend,
					);
					const after = await offlineState(sessionFile);
					expect(normalizedExport({ ...after, sourceIdentity: before.sourceIdentity })).toEqual(
						normalizedExport(before),
					);
				},
				MIGRATION_MATRIX_TIMEOUT_MS,
			);
		}
	}
	it("validates selected denial before closing or mutating a live owner", async () => {
		const { sessionFile } = await fixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		const store = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
		const close = spyOn(store, "close");
		try {
			await fs.rm(authorityPaths(sessionFile).legacyFence);
			await expect(migrateAuthority(sessionFile, "sqlite", { apply: true })).rejects.toThrow(/fence|marker/);
			await expect(repairSelectedAuthority(sessionFile, { apply: true })).rejects.toThrow(/fence|marker/);
			expect(close).not.toHaveBeenCalled();
			expect((await store.getRoot("Main"))?.record.state).toBe("active");
		} finally {
			close.mockRestore();
			await store.close();
		}
	});
});

it("converts fresh selected authority without inventing legacy provenance", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fresh-authority-migration-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "fresh authority", timestamp: 1 });
	await manager.ensureOnDisk();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a published session.");
	const store = await registryDurableStateForSession(sessionFile, {
		owningSessionId: manager.getSessionId(),
		backend: "jsonl",
		create: true,
	});
	await store.close();
	await manager.close();
	const before = await offlineState(sessionFile);
	expect(before.legacy).toBeUndefined();
	await migrateAuthority(sessionFile, "sqlite", { apply: true });
	const after = await offlineState(sessionFile);
	expect(after.legacy).toBeUndefined();
	expect(normalizedExport({ ...after, sourceIdentity: before.sourceIdentity })).toEqual(normalizedExport(before));
});

for (const backend of ["jsonl", "sqlite"] as const) {
	for (const phase of ["reserved", "effect", "uncertain"] as const) {
		it(`retains the full ${backend} ${phase} claim instead of converting unresolved evidence`, async () => {
			const { sessionFile } = await writtenFixture(backend);
			const store = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
			const claim = await store.reserveLocal({
				localId: "unresolved",
				entryId: "entry",
				entryHash: hash("unresolved"),
				expectedHeadHash: durableGenesisHash(),
			});
			if (phase !== "reserved") await store.authorizeLocalEffect(claim);
			if (phase === "uncertain") await store.finalizeLocal({ ...claim, phase: "effect" }, "uncertain");
			await store.close();
			const before = await offlineState(sessionFile);
			await expect(
				migrateAuthority(sessionFile, backend === "jsonl" ? "sqlite" : "jsonl", { apply: true }),
			).rejects.toThrow(/unresolved/);
			expect(await offlineState(sessionFile)).toEqual(before);
			expect(before.controls.some(control => control.key === 'local-claim:"unresolved"')).toBe(true);
		});
	}
}

for (const suffix of ["restore.00000000-0000-4000-8000-000000000001.json", "jsonl-wal", "unknown"]) {
	it(`refuses selected source with unexplained authority.${suffix} before inspection or mutation`, async () => {
		const { sessionFile } = await fixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		const file = `${sessionFile}.authority.${suffix}`;
		await fs.writeFile(file, "unexplained", { mode: 0o600 });
		for (const apply of [false, true]) {
			await expect(migrateAuthority(sessionFile, "jsonl", { apply })).rejects.toThrow(
				/artifact|unrecognized|incomplete/i,
			);
			await expect(repairSelectedAuthority(sessionFile, { apply })).rejects.toThrow(
				/artifact|unrecognized|incomplete/i,
			);
		}
		expect(await fs.readFile(file, "utf8")).toBe("unexplained");
	});
}

for (const targetBackend of ["jsonl", "sqlite"] as const) {
	for (const cut of crashCuts) {
		it(`legacy to ${targetBackend} aborts or follows its selected target at ${cut}`, async () => {
			const { sessionFile, legacy } = await fixture();
			const original = await fs.readFile(legacy);
			await expect(migrateAuthority(sessionFile, targetBackend, { apply: true, faultAt: cut })).rejects.toThrow(
				/injected migration fault/i,
			);
			const selected = ["descriptor-published", "migration-ready", "manifest-finalized"].includes(cut);
			if (selected && cut !== "manifest-finalized") {
				await expect(recoverAuthorityMigration(sessionFile, "abort")).rejects.toThrow(/selected target|finish/i);
				await recoverAuthorityMigration(sessionFile, "finish");
			} else {
				await recoverAuthorityMigration(sessionFile, "abort");
				await recoverAuthorityMigration(sessionFile, "abort");
			}
			if (!selected) {
				expect(await fs.readFile(legacy)).toEqual(original);
				expect(await readAuthorityDescriptor(sessionFile)).toBeUndefined();
				expect(await Bun.file(authorityPaths(sessionFile).legacyFence).exists()).toBe(false);
			} else {
				expect((await readAuthorityDescriptor(sessionFile))?.backend).toBe(targetBackend);
				expect((await offlineState(sessionFile)).legacy?.entries).toEqual(
					original
						.toString("utf8")
						.trimEnd()
						.split("\n")
						.map(line => JSON.parse(line)),
				);
			}
		});
		if (targetBackend === "jsonl") {
			it(`finishes explicit legacy JSONL upgrade at ${cut} without fabricated receipts`, async () => {
				const { sessionFile, legacy } = await fixture();
				const original = await fs.readFile(legacy, "utf8");
				await expect(migrateAuthority(sessionFile, "jsonl", { apply: true, faultAt: cut })).rejects.toThrow(
					/injected migration fault/i,
				);
				await recoverAuthorityMigration(sessionFile, "finish");
				await recoverAuthorityMigration(sessionFile, "finish");
				const state = await offlineState(sessionFile);
				expect(state.legacy?.entries).toEqual(
					original
						.trimEnd()
						.split("\n")
						.map(line => JSON.parse(line)),
				);
				expect(state.frames).toEqual([]);
				expect(state.controls.some(control => control.key.startsWith("receipt:"))).toBe(false);
				const reopened = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
				try {
					expect((await reopened.getActor("Main"))?.record.state).toBe("active");
				} finally {
					await reopened.close();
				}
			});
		}
	}
}

for (const cut of crashCuts) {
	for (const action of ["finish", "abort"] as const) {
		it(
			`preserves WAL-backed SQLite evidence through ${action} at ${cut}`,
			async () => {
				const { sessionFile } = await writtenFixture("sqlite");
				const paths = authorityPaths(sessionFile);
				const store = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
				let reinstallCrashImage: (() => Promise<void>) | undefined;
				try {
					const claim = await store.reserveLocal({
						localId: "wal-source",
						entryId: "entry",
						entryHash: hash("wal-source"),
						expectedHeadHash: durableGenesisHash(),
					});
					await store.authorizeLocalEffect(claim);
					await store.finalizeLocal({ ...claim, phase: "effect" }, "committed");
					reinstallCrashImage = await captureSqliteCrashImage(paths.sqlite);
				} finally {
					await store.close();
				}
				if (!reinstallCrashImage) throw new Error("Expected a captured SQLite crash image.");
				await reinstallCrashImage();
				const reader = new Database(paths.sqlite, { readonly: true });
				reader.exec("BEGIN");
				reader.query("SELECT value FROM authority_controls WHERE order_key = CAST('meta' AS BLOB)").get();
				try {
					expect((await fs.stat(`${paths.sqlite}-wal`)).size).toBeGreaterThan(32);
					const before = await offlineState(sessionFile);
					await expect(migrateAuthority(sessionFile, "jsonl", { apply: true, faultAt: cut })).rejects.toThrow(
						/injected migration fault/i,
					);
					let backup = await sqliteRecoveryBackup(sessionFile);
					const rename = fs.rename;
					const capture = spyOn(fs, "rename").mockImplementation(async (from, to) => {
						await rename(from, to);
						if (!backup && String(to).startsWith(`${sessionFile}.authority.migration.`))
							backup = await sqliteRecoveryBackup(sessionFile);
					});
					const recover = async (recoveryAction: "finish" | "abort"): Promise<void> => {
						await recoverAuthorityMigration(sessionFile, recoveryAction);
						if (backup) await expectBackupPreserved(backup);
					};
					const selected = ["descriptor-published", "migration-ready", "manifest-finalized"].includes(cut);
					try {
						if (action === "abort" && selected && cut !== "manifest-finalized") {
							await expect(recoverAuthorityMigration(sessionFile, "abort")).rejects.toThrow(
								/selected target|finish/i,
							);
							if (backup) await expectBackupPreserved(backup);
							await recover("finish");
							await recover("finish");
						} else {
							await recover(action);
							await recover(action);
						}
					} finally {
						capture.mockRestore();
					}
					if (cut !== "manifest-created" || action === "finish") {
						if (!backup) throw new Error("Expected exact retained SQLite recovery evidence.");
						for (const suffix of ["", "-wal", "-shm"])
							expect(backup.files.some(file => file.name === `${path.basename(paths.sqlite)}${suffix}`)).toBe(
								true,
							);
						expect(
							backup.files.find(file => file.name === `${path.basename(paths.sqlite)}-wal`)!.bytes.byteLength,
						).toBeGreaterThan(32);
						await expectBackupPreserved(backup);
					}
					const after = await offlineState(sessionFile);
					expect(normalizedExport({ ...after, sourceIdentity: before.sourceIdentity })).toEqual(
						normalizedExport(before),
					);
					expect((await readAuthorityDescriptor(sessionFile))?.backend).toBe(
						action === "finish" || selected ? "jsonl" : "sqlite",
					);
				} finally {
					reader.exec("ROLLBACK");
					reader.close();
				}
			},
			MIGRATION_MATRIX_TIMEOUT_MS,
		);
	}
}

it("preserves both recovery inspection and disposable-copy cleanup failures without consuming the backup", async () => {
	const { sessionFile } = await writtenFixture("sqlite");
	await expect(migrateAuthority(sessionFile, "jsonl", { apply: true, faultAt: "source-frozen" })).rejects.toThrow(
		/injected migration fault/i,
	);
	const backup = await sqliteRecoveryBackup(sessionFile);
	if (!backup) throw new Error("Expected retained SQLite source backup.");
	const inspectionFailure = new Error("injected disposable inspection write failure");
	const cleanupFailure = new Error("injected disposable inspection cleanup failure");
	const open = fs.open;
	const remove = fs.rm;
	let inspectionFailed = false;
	let cleanupFailed = false;
	const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
		if (
			String(file).includes(`${path.sep}.authority-inspection-`) &&
			path.basename(String(file)) === path.basename(authorityPaths(sessionFile).sqlite)
		) {
			inspectionFailed = true;
			throw inspectionFailure;
		}
		return open(file, flags, mode);
	});
	const cleanupSpy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
		if (String(file).includes(`${path.sep}.authority-inspection-`)) {
			cleanupFailed = true;
			throw cleanupFailure;
		}
		await remove(file, options);
	});
	let caught: unknown;
	try {
		await recoverAuthorityMigration(sessionFile, "finish");
	} catch (error) {
		caught = error;
	} finally {
		openSpy.mockRestore();
		cleanupSpy.mockRestore();
	}
	expect(inspectionFailed).toBe(true);
	expect(cleanupFailed).toBe(true);
	expect(caught).toBeInstanceOf(AggregateError);
	if (!(caught instanceof AuthorityCleanupError))
		throw new Error("Expected retained recovery inspection cleanup ownership.");
	try {
		expect(caught.errors).toEqual([inspectionFailure, cleanupFailure]);
		expect(caught.cause).toBe(inspectionFailure);
		expect(caught.pending).toBe(true);
		await expect(acquireAuthorityOwnership(sessionFile, { owningSessionId: rootId })).rejects.toThrow(
			/already held/i,
		);
		await expectBackupPreserved(backup);
	} finally {
		await caught.cleanup();
	}
	expect(caught.pending).toBe(false);
	await caught.cleanup();
	expect(caught.errors).toEqual([inspectionFailure, cleanupFailure]);
	await recoverAuthorityMigration(sessionFile, "finish");
	await recoverAuthorityMigration(sessionFile, "finish");
	await expectBackupPreserved(backup);
});

interface V3SessionFixture {
	readonly rootId: string;
	readonly descriptor: AuthorityDescriptor;
	readonly files: Readonly<Record<string, string>>;
	readonly exportCanonicalSha256: string;
	readonly framesJsonSha256: string;
	readonly frameHashes: readonly string[];
}

/**
 * Installs the selected physical-schema-v3 SQLite session written by the v3 migration and client path (see the
 * fixture description). Only the lock anchor is new, so the descriptor takes its physical identity.
 */
async function v3SessionFixture(): Promise<{
	sessionFile: string;
	fixture: V3SessionFixture;
	payload: Buffer;
	sourceIdentity: AuthorityExport["sourceIdentity"];
}> {
	const fixture = (await Bun.file(
		path.join(import.meta.dir, "fixtures", "authority-sqlite-v3-session.json"),
	).json()) as V3SessionFixture;
	expect(fixture.rootId).toBe(rootId);
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-migration-v3-"));
	directories.push(directory);
	for (const [name, encoded] of Object.entries(fixture.files))
		await fs.writeFile(path.join(directory, name), gunzipSync(Buffer.from(encoded, "base64")), { mode: 0o600 });
	const sessionFile = path.join(directory, "root.jsonl");
	const paths = authorityPaths(sessionFile);
	await fs.writeFile(paths.lock, "", { mode: 0o600 });
	const anchor = await fs.stat(paths.lock);
	// Replay the descriptor's own history (initializing, then the active revision the fixture recorded).
	const descriptor = { ...fixture.descriptor, physicalIdentity: { dev: String(anchor.dev), ino: String(anchor.ino) } };
	await writeAuthorityDescriptor(sessionFile, { ...descriptor, revision: 1, state: "initializing" });
	await writeAuthorityDescriptor(sessionFile, descriptor);
	const sourceIdentity = {
		backend: "sqlite" as const,
		owningSessionId: fixture.descriptor.owningSessionId,
		incarnation: fixture.descriptor.incarnation,
		format: 2 as const,
	};
	return { sessionFile, fixture, payload: await fs.readFile(paths.sqlite), sourceIdentity };
}

/**
 * The v3 session as a live owner left it: the same logical store split across the main file and a committed WAL
 * (a header-only write lands in the WAL with no checkpoint), with its shared-memory index, captured before close.
 */
async function v3SessionWithLiveWal(): Promise<
	Awaited<ReturnType<typeof v3SessionFixture>> & { readonly files: Readonly<Record<string, Buffer>> }
> {
	const base = await v3SessionFixture();
	const sqlite = authorityPaths(base.sessionFile).sqlite;
	const database = new Database(sqlite);
	const files: Record<string, Buffer> = {};
	try {
		database.exec("PRAGMA journal_mode=WAL");
		database.exec("PRAGMA wal_autocheckpoint=0");
		const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
		database.exec(`PRAGMA user_version=${version}`);
		for (const suffix of ["", "-wal", "-shm"]) files[suffix] = await fs.readFile(`${sqlite}${suffix}`);
	} finally {
		database.close();
	}
	for (const [suffix, bytes] of Object.entries(files))
		await fs.writeFile(`${sqlite}${suffix}`, bytes, { mode: 0o600 });
	expect(files["-wal"]!.byteLength).toBeGreaterThan(32);
	return { ...base, files };
}

async function expectConvertedV3(
	sessionFile: string,
	fixture: V3SessionFixture,
	sourceIdentity: AuthorityExport["sourceIdentity"],
): Promise<void> {
	const descriptor = await readAuthorityDescriptor(sessionFile);
	expect(descriptor).toMatchObject({ backend: "sqlite", state: "active" });
	expect(descriptor?.incarnation).not.toBe(fixture.descriptor.incarnation);
	const after = await offlineState(sessionFile);
	// Hashes cover the logical frame, so the physical conversion keeps every frame hash, receipt and row exactly.
	expect(after.frames.map(frame => frame.hash)).toEqual([...fixture.frameHashes]);
	expect(createHash("sha256").update(JSON.stringify(after.frames)).digest("hex")).toBe(fixture.framesJsonSha256);
	expect(canonicalDurableSha256({ ...after, sourceIdentity })).toBe(fixture.exportCanonicalSha256);
	const database = new Database(authorityPaths(sessionFile).sqlite, { readonly: true });
	try {
		expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
	} finally {
		database.close();
	}
}

describe("physical schema v3 SQLite conversion", () => {
	it("refuses to open or repair a v3 store and converts it with --to sqlite --apply", async () => {
		const { sessionFile, fixture, payload, sourceIdentity } = await v3SessionFixture();
		const paths = authorityPaths(sessionFile);
		const transcript = await fs.readFile(sessionFile);
		expect(() => openAuthorityPersistence({ path: paths.sqlite, identity: sourceIdentity, create: false })).toThrow(
			`omp session authority ${sessionFile} --to sqlite --apply`,
		);
		await expect(repairSelectedAuthority(sessionFile)).rejects.toThrow("--to sqlite --apply");
		expect(await migrateAuthority(sessionFile, "sqlite")).toEqual({
			status: "dry-run",
			sourceBackend: "sqlite",
			targetBackend: "sqlite",
		});
		expect((await fs.readFile(paths.sqlite)).equals(payload)).toBe(true);
		const result = await migrateAuthority(sessionFile, "sqlite", { apply: true });
		expect(result).toMatchObject({ status: "migrated", sourceBackend: "sqlite", targetBackend: "sqlite" });
		await expectConvertedV3(sessionFile, fixture, sourceIdentity);
		// The exact v3 payload stays in the migration backup; the transcript is never rewritten.
		expect((await fs.readFile(path.join(result.backupDirectory!, path.basename(paths.sqlite)))).equals(payload)).toBe(
			true,
		);
		expect(await fs.readFile(sessionFile)).toEqual(transcript);
		expect(await migrateAuthority(sessionFile, "sqlite")).toEqual({
			status: "already-selected",
			sourceBackend: "sqlite",
			targetBackend: "sqlite",
		});
		const reopened = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
		try {
			expect((await reopened.getConstruction("Evidence", "Child", 3))?.record.phase).toBe("activated");
			expect(await reopened.localBacking("publication")).toMatchObject({
				entryId: "first",
				entryHash: hash("first"),
				version: 1,
			});
		} finally {
			await reopened.close();
		}
	});

	it("converts a v3 store to JSONL through the same reader", async () => {
		const { sessionFile, fixture } = await v3SessionFixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		expect((await readAuthorityDescriptor(sessionFile))?.backend).toBe("jsonl");
		expect((await offlineState(sessionFile)).frames.map(frame => frame.hash)).toEqual([...fixture.frameHashes]);
		expect(await fs.stat(authorityPaths(sessionFile).sqlite).catch(() => undefined)).toBeUndefined();
	});

	it(
		"converts a v3 store with a live WAL and keeps every source sidecar in the backup",
		async () => {
			const { sessionFile, fixture, sourceIdentity, files } = await v3SessionWithLiveWal();
			const sqlite = authorityPaths(sessionFile).sqlite;
			const result = await migrateAuthority(sessionFile, "sqlite", { apply: true });
			await expectConvertedV3(sessionFile, fixture, sourceIdentity);
			for (const suffix of ["", "-wal"])
				expect(
					(await fs.readFile(path.join(result.backupDirectory!, `${path.basename(sqlite)}${suffix}`))).equals(
						files[suffix]!,
					),
				).toBe(true);
		},
		MIGRATION_MATRIX_TIMEOUT_MS,
	);

	for (const cut of [
		"target-published-main",
		"target-published-wal",
		"target-published-shm",
		"target-published",
	] as const) {
		it(
			`aborts a live-WAL v3 conversion at ${cut} to the exact source files`,
			async () => {
				const { sessionFile, fixture, sourceIdentity, files } = await v3SessionWithLiveWal();
				const sqlite = authorityPaths(sessionFile).sqlite;
				await expect(migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: cut })).rejects.toThrow(
					/injected migration fault/i,
				);
				await recoverAuthorityMigration(sessionFile, "abort");
				expect(await readAuthorityDescriptor(sessionFile)).toMatchObject({
					backend: "sqlite",
					state: "active",
					incarnation: fixture.descriptor.incarnation,
				});
				// The published target and its sidecars are rolled back: the source database and its committed WAL return exactly.
				for (const suffix of ["", "-wal"])
					expect((await fs.readFile(`${sqlite}${suffix}`)).equals(files[suffix]!)).toBe(true);
				await migrateAuthority(sessionFile, "sqlite", { apply: true });
				await expectConvertedV3(sessionFile, fixture, sourceIdentity);
			},
			MIGRATION_MATRIX_TIMEOUT_MS,
		);
	}

	for (const cut of crashCuts) {
		it(
			`finishes a v3 conversion interrupted at ${cut}`,
			async () => {
				const { sessionFile, fixture, sourceIdentity } = await v3SessionFixture();
				await expect(migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: cut })).rejects.toThrow(
					/injected migration fault/i,
				);
				await recoverAuthorityMigration(sessionFile, "finish");
				await recoverAuthorityMigration(sessionFile, "finish");
				await expectConvertedV3(sessionFile, fixture, sourceIdentity);
			},
			MIGRATION_MATRIX_TIMEOUT_MS,
		);
		it(
			`aborts a v3 conversion at ${cut} to the exact v3 payload unless the target is selected`,
			async () => {
				const { sessionFile, fixture, payload, sourceIdentity } = await v3SessionFixture();
				await expect(migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: cut })).rejects.toThrow(
					/injected migration fault/i,
				);
				const selected = ["descriptor-published", "migration-ready", "manifest-finalized"].includes(cut);
				if (selected) {
					if (cut !== "manifest-finalized")
						await expect(recoverAuthorityMigration(sessionFile, "abort")).rejects.toThrow(
							/selected target|finish/i,
						);
					await recoverAuthorityMigration(sessionFile, "finish");
					await expectConvertedV3(sessionFile, fixture, sourceIdentity);
					return;
				}
				await recoverAuthorityMigration(sessionFile, "abort");
				await recoverAuthorityMigration(sessionFile, "abort");
				expect(await readAuthorityDescriptor(sessionFile)).toMatchObject({
					backend: "sqlite",
					state: "active",
					incarnation: fixture.descriptor.incarnation,
				});
				expect((await fs.readFile(authorityPaths(sessionFile).sqlite)).equals(payload)).toBe(true);
				// The restored source is still v3: it converts again from the start.
				await migrateAuthority(sessionFile, "sqlite", { apply: true });
				await expectConvertedV3(sessionFile, fixture, sourceIdentity);
			},
			MIGRATION_MATRIX_TIMEOUT_MS,
		);
	}
});
