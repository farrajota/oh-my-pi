import { afterEach, describe, expect, it } from "bun:test";
import * as fsNamespace from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { jsonlLayout, listJsonlRotationArtifacts } from "../../src/registry/authority/jsonl-layout";
import {
	deleteAuthorityBundle,
	moveAuthorityBundle,
	packAuthorityBundle,
	restoreAuthorityBundle,
} from "../../src/registry/authority/lifecycle";
import { migrateAuthority } from "../../src/registry/authority/migration";
import { authorityPaths, withAuthorityExclusive } from "../../src/registry/authority/ownership";
import { openAuthorityPersistence } from "../../src/registry/authority/persistence";
import type { AuthorityExport, AuthorityIdentity } from "../../src/registry/authority/types";
import { SessionManager } from "../../src/session/session-manager";

// Bundle operations must carry a rotated JSONL store as a whole: its active segment plus sealed segments,
// indexes and snapshot. Each operation is checked against the store's complete export (current state and
// full history), which only a store with every rotation artifact can produce.

const directories: string[] = [];
const restoredId = "019ed677-02fb-7000-8dac-396e2f84d484";
// Each case builds a worker-backed root, rotates it offline across several owners, then runs a whole-bundle operation with full verification.
const BUNDLE_TEST_TIMEOUT_MS = 20_000;

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function sessionFile(directory: string, id: string): Promise<string> {
	const file = path.join(directory, `${id}.jsonl`);
	await Bun.write(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
	);
	return file;
}

async function selectedIdentity(
	file: string,
): Promise<{ readonly payload: string; readonly identity: AuthorityIdentity }> {
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
	const { payload, identity } = await selectedIdentity(file);
	const driver = openAuthorityPersistence({ path: payload, identity, create: false });
	try {
		driver.integrityCheck();
		return driver.exportState();
	} finally {
		driver.close();
	}
}

/** A selected JSONL root whose payload has rotated through several segments while closed between owners. */
async function rotatedSession(
	directory: string,
): Promise<{ readonly file: string; readonly id: string; readonly state: AuthorityExport }> {
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "rotated authority fixture", timestamp: 1 });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Fixture did not create a transcript.");
	const id = manager.getSessionId();
	const store = await registryDurableStateForSession(file, { owningSessionId: id, backend: "jsonl", create: true });
	await store.close();
	await manager.close();
	const { payload, identity } = await selectedIdentity(file);
	const driver = new JsonlAuthorityPersistence({
		path: payload,
		identity,
		create: false,
		jsonlSegment: { minBytes: Number.MAX_SAFE_INTEGER, maxFrames: 3 },
	});
	for (let index = 0; index < 10; index++) new AuthorityEngine(driver, `restart-${index}`).recover();
	new AuthorityEngine(driver, "closing-owner").close();
	expect(
		listJsonlRotationArtifacts(payload).filter(artifact => artifact.kind === "segment").length,
	).toBeGreaterThanOrEqual(3);
	return { file, id, state: await offlineState(file) };
}

function rotationNames(payload: string): string[] {
	return listJsonlRotationArtifacts(payload)
		.map(artifact => path.basename(artifact.file))
		.sort();
}

function withoutIdentity(state: AuthorityExport): Omit<AuthorityExport, "sourceIdentity"> {
	const { sourceIdentity: _identity, ...rest } = state;
	return rest;
}

describe("rotated JSONL bundle operations", () => {
	it(
		"packs every rotation artifact and restores the complete history into a fresh incarnation",
		async () => {
			const sourceDirectory = await makeDirectory("omp-rotated-pack-source-");
			const targetDirectory = await makeDirectory("omp-rotated-pack-target-");
			const { file, state } = await rotatedSession(sourceDirectory);
			const bundle = await packAuthorityBundle(file);
			if (!bundle) throw new Error("Expected an authority bundle.");
			const payload = authorityPaths(file).jsonl;
			const bundled = bundle.entries
				.map(entry => entry.name)
				.filter(name => /^authority\.(segment|snapshot)\./.test(name))
				.sort();
			expect(bundled).toEqual(rotationNames(payload).map(name => name.slice(path.basename(file).length + 1)));
			for (const name of bundled)
				expect(Buffer.from(bundle.entries.find(entry => entry.name === name)!.data)).toEqual(
					await fs.readFile(path.join(sourceDirectory, `${path.basename(file)}.${name}`)),
				);
			const target = await sessionFile(targetDirectory, restoredId);
			await restoreAuthorityBundle(target, bundle);
			const restored = await offlineState(target);
			expect(withoutIdentity(restored)).toEqual(withoutIdentity(state));
			// The restored store is a fresh single segment seeded with that history; the source segments are retained provenance only.
			expect(rotationNames(authorityPaths(target).jsonl)).toEqual([]);
			const reopened = await registryDurableStateForSession(target, { owningSessionId: restoredId });
			await reopened.close();
		},
		BUNDLE_TEST_TIMEOUT_MS,
	);

	it(
		"moves a rotated store with its sealed history under the target name",
		async () => {
			const sourceDirectory = await makeDirectory("omp-rotated-move-source-");
			const targetDirectory = await makeDirectory("omp-rotated-move-target-");
			const { file, id, state } = await rotatedSession(sourceDirectory);
			const sourceNames = rotationNames(authorityPaths(file).jsonl).map(name =>
				name.slice(path.basename(file).length),
			);
			const target = path.join(targetDirectory, path.basename(file));
			await moveAuthorityBundle(file, target);
			expect(rotationNames(authorityPaths(file).jsonl)).toEqual([]);
			expect(
				rotationNames(authorityPaths(target).jsonl).map(name => name.slice(path.basename(target).length)),
			).toEqual(sourceNames);
			expect(await offlineState(target)).toEqual(state);
			const store = await registryDurableStateForSession(target, { owningSessionId: id });
			expect((await store.recoveryState()).revision).toBeGreaterThan(state.revision);
			await store.close();
		},
		BUNDLE_TEST_TIMEOUT_MS,
	);

	it(
		"deletes every rotation artifact with the authority",
		async () => {
			const directory = await makeDirectory("omp-rotated-delete-");
			const { file } = await rotatedSession(directory);
			await deleteAuthorityBundle(file);
			expect(rotationNames(authorityPaths(file).jsonl)).toEqual([]);
			expect(await Bun.file(authorityPaths(file).jsonl).exists()).toBe(false);
		},
		BUNDLE_TEST_TIMEOUT_MS,
	);

	it(
		"migrates a rotated store to SQLite and back from its current state and complete history",
		async () => {
			const directory = await makeDirectory("omp-rotated-migrate-");
			const { file, state } = await rotatedSession(directory);
			const sourceNames = rotationNames(authorityPaths(file).jsonl);
			const toSqlite = await migrateAuthority(file, "sqlite", { apply: true });
			expect(toSqlite.status).toBe("migrated");
			// The unselected JSONL source leaves the root with its sealed history, which the backup retains.
			expect(rotationNames(authorityPaths(file).jsonl)).toEqual([]);
			for (const name of sourceNames)
				expect(await Bun.file(path.join(toSqlite.backupDirectory!, name)).exists()).toBe(true);
			const sqlite = await offlineState(file);
			expect(withoutIdentity(sqlite)).toEqual(withoutIdentity(state));
			const store = await registryDurableStateForSession(file, {
				owningSessionId: (await readAuthorityDescriptor(file))!.owningSessionId,
			});
			await store.recover();
			await store.close();
			const current = await offlineState(file);
			expect(current.revision).toBeGreaterThan(state.revision);
			const toJsonl = await migrateAuthority(file, "jsonl", { apply: true });
			expect(toJsonl.status).toBe("migrated");
			expect(withoutIdentity(await offlineState(file))).toEqual(withoutIdentity(current));
		},
		BUNDLE_TEST_TIMEOUT_MS,
	);

	it(
		"settles an interrupted rotation before packing",
		async () => {
			const directory = await makeDirectory("omp-rotated-interrupted-");
			const { file, state } = await rotatedSession(directory);
			const payload = authorityPaths(file).jsonl;
			const committed = rotationNames(payload);
			const layout = jsonlLayout(payload);
			const segment = committed.filter(name => name.includes(".segment.") && name.endsWith(".jsonl")).length;
			// A rotation cut after its sealed link: the next index and snapshot exist and the active inode has two names.
			await fs.writeFile(layout.index(segment), "{}\n", { mode: 0o600 });
			await fs.writeFile(layout.snapshot(segment + 1), "{}\n", { mode: 0o600 });
			fsNamespace.linkSync(payload, layout.segment(segment));
			const bundle = await packAuthorityBundle(file);
			expect(bundle).not.toBeNull();
			expect(rotationNames(payload)).toEqual(committed);
			expect(fsNamespace.statSync(payload).nlink).toBe(1);
			expect(await offlineState(file)).toEqual(state);
		},
		BUNDLE_TEST_TIMEOUT_MS,
	);

	it(
		"a migration dry-run against a live owner mid-rotation changes no file",
		async () => {
			const directory = await makeDirectory("omp-rotated-dry-run-");
			const { file, state } = await rotatedSession(directory);
			const payload = authorityPaths(file).jsonl;
			const layout = jsonlLayout(payload);
			const segment = rotationNames(payload).filter(
				name => name.includes(".segment.") && name.endsWith(".jsonl"),
			).length;
			const planted = [
				layout.index(segment),
				layout.snapshot(segment + 1),
				layout.segment(segment),
				`${payload}.tmp-0f0e0d0c-0b0a-4908-8706-050403020100`,
			];
			// Another holder owns the root exclusively while its rotation sits between the sealed link and the header
			// publication: the next index and snapshot exist, the active inode has its sealed name, and a temporary exists.
			await withAuthorityExclusive(file, async () => {
				await fs.writeFile(planted[0]!, "{}\n", { mode: 0o600 });
				await fs.writeFile(planted[1]!, "{}\n", { mode: 0o600 });
				fsNamespace.linkSync(payload, planted[2]!);
				await fs.writeFile(planted[3]!, "pending header\n", { mode: 0o600 });
				const before = await directoryBytes(directory);
				for (const target of ["sqlite", "jsonl"] as const) {
					let outcome: unknown;
					try {
						outcome = await migrateAuthority(file, target, {});
					} catch (error) {
						outcome = error;
					}
					// The dry-run reports the pending recovery instead of performing it.
					expect(outcome).toBeInstanceOf(Error);
					expect((outcome as Error).message).toMatch(/rotation recovery is pending/);
					expect(await directoryBytes(directory)).toEqual(before);
					expect(fsNamespace.statSync(payload).nlink).toBe(2);
				}
				// The owner's rotation then fails before its commit point and discards its own artifacts.
				for (const name of planted) await fs.rm(name);
			});
			expect(await offlineState(file)).toEqual(state);
		},
		BUNDLE_TEST_TIMEOUT_MS,
	);
});

/** Every regular file under `directory` (recursively) mapped to its exact bytes, for byte-identity checks. */
async function directoryBytes(directory: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const full = path.join(entry.parentPath, entry.name);
		result[path.relative(directory, full)] = (await fs.readFile(full)).toString("base64");
	}
	return result;
}
