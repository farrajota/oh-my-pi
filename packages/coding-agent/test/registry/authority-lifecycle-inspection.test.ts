import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalDurableSha256, durableRootHeadHash } from "../../src/registry/durable-state";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { openAuthorityPersistence } from "../../src/registry/authority/persistence";
import {
	SqliteAuthorityConstructionError,
	SqliteAuthorityPersistence,
} from "../../src/registry/authority/sqlite-driver";
import { AuthorityCleanupError } from "../../src/registry/authority/private-cleanup";
import {
	acquireAuthorityOwnership,
	authorityPaths,
	type AuthorityOwnership,
} from "../../src/registry/authority/ownership";
import {
	moveAuthorityBundle,
	packAuthorityBundle,
	replaceSessionAuthorityBundle,
	restoreAuthorityBundle,
} from "../../src/registry/authority/lifecycle";
import { SessionManager } from "../../src/session/session-manager";

const directories: string[] = [];
const fixtures = new Set<InspectionFixture>();

function appendErrorEvidence(errors: unknown[], error: unknown): void {
	if (errors.includes(error)) return;
	errors.push(error);
	if (error instanceof Error && error.cause !== undefined) appendErrorEvidence(errors, error.cause);
	if (error instanceof AggregateError) for (const nested of error.errors) appendErrorEvidence(errors, nested);
}

class InspectionFixture {
	faultsArmed = true;
	readonly errors: unknown[] = [];
	readonly #owners = new Set<AuthorityCleanupError>();
	readonly #constructors = new Set<SqliteAuthorityConstructionError>();
	readonly #resources = new Set<() => Promise<void>>();
	readonly #disarmers = new Set<() => void>();
	readonly #handles = new Set<fs.FileHandle>();

	retain(error: unknown): void {
		appendErrorEvidence(this.errors, error);
		const seen = new Set<unknown>();
		const visit = (failure: unknown): void => {
			if (seen.has(failure)) return;
			seen.add(failure);
			if (failure instanceof AuthorityCleanupError) {
				this.#owners.add(failure);
				return; // Its nested resources must be serviced through this exact escaping owner.
			}
			if (failure instanceof SqliteAuthorityConstructionError) {
				if (!this.#constructors.has(failure)) {
					this.#constructors.add(failure);
					this.own(() => failure.cleanup());
				}
				return;
			}
			if (failure instanceof Error) visit(failure.cause);
			if (failure instanceof AggregateError) for (const nested of failure.errors) visit(nested);
		};
		visit(error);
	}

	async observe<T>(operation: Promise<T>): Promise<T> {
		try {
			return await operation;
		} catch (error) {
			this.retain(error);
			throw error;
		}
	}

	disarm(restore: () => void): void {
		this.#disarmers.add(restore);
	}

	spy<T extends { mockRestore(): unknown }>(spy: T): T {
		this.disarm(() => {
			spy.mockRestore();
		});
		return spy;
	}

	watch(handle: fs.FileHandle): void {
		this.#handles.add(handle);
	}

	own(close: () => void | Promise<void>): () => Promise<void> {
		const dispose = async (): Promise<void> => {
			if (!this.#resources.has(dispose)) return;
			await close();
			this.#resources.delete(dispose);
		};
		this.#resources.add(dispose);
		return dispose;
	}

	async ownership(...args: Parameters<typeof acquireAuthorityOwnership>): Promise<AuthorityOwnership> {
		const ownership = await this.observe(acquireAuthorityOwnership(...args));
		return { ...ownership, release: this.own(() => ownership.release()) };
	}

	get pending(): boolean {
		return (
			this.#disarmers.size > 0 ||
			this.#resources.size > 0 ||
			[...this.#owners].some(owner => owner.pending) ||
			[...this.#handles].some(handle => handle.fd >= 0)
		);
	}

	disarmFaults(): unknown[] {
		const errors: unknown[] = [];
		this.faultsArmed = false;
		for (const restore of [...this.#disarmers].reverse()) {
			try {
				restore();
				this.#disarmers.delete(restore);
			} catch (error) {
				this.retain(error);
				appendErrorEvidence(errors, error);
			}
		}
		return errors;
	}

	async cleanup(): Promise<unknown[]> {
		const errors = this.disarmFaults();
		const failed = (error: unknown): void => {
			this.retain(error);
			appendErrorEvidence(errors, error);
		};
		// A failed disarm is not permission to run cleanup against an armed fixture.
		if (this.#disarmers.size === 0) {
			for (const owner of this.#owners) {
				if (!owner.pending) continue;
				try {
					await owner.cleanup();
				} catch (error) {
					failed(error);
				}
			}
			// Fixture-owned readers/drivers/exclusions outlive all pending operation resources.
			if (![...this.#owners].some(owner => owner.pending)) {
				for (const close of [...this.#resources].reverse()) {
					try {
						await close();
					} catch (error) {
						failed(error);
					}
				}
			}
		}
		if (this.pending && errors.length === 0)
			failed(new Error("Inspection fixture still retains an open physical resource."));
		return errors;
	}
}

async function runInspectionFixture(run: (fixture: InspectionFixture) => Promise<void>): Promise<void> {
	const fixture = new InspectionFixture();
	fixtures.add(fixture);
	let failed = false;
	let failure: unknown;
	try {
		await run(fixture);
	} catch (error) {
		failed = true;
		failure = error;
		fixture.retain(error);
	}
	const cleanupErrors = await fixture.cleanup();
	if (cleanupErrors.length > 0) {
		const errors: unknown[] = [];
		if (failed) appendErrorEvidence(errors, failure);
		for (const error of cleanupErrors) appendErrorEvidence(errors, error);
		throw new AggregateError(errors, "Authority inspection test and fixture cleanup failed.", {
			cause: failed ? failure : errors[0],
		});
	}
	if (failed) throw failure;
}

function inspectionTest(name: string, run: (fixture: InspectionFixture) => Promise<void>): void {
	it(name, () => runInspectionFixture(run));
}
async function authoritySession(
	fixture: InspectionFixture,
	backend: "jsonl" | "sqlite" = "sqlite",
	installedWal = true,
): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-inspection-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	let closeStore: (() => Promise<void>) | undefined;
	const closeManager = fixture.own(async () => {
		await closeStore?.();
		await manager.close();
	});
	manager.appendMessage({ role: "user", content: "authority inspection fixture", timestamp: 1 });
	await manager.ensureOnDisk();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a materialized authority inspection session.");
	const owningSessionId = manager.getSessionId();
	const store = await registryDurableStateForSession(sessionFile, { owningSessionId, backend, create: true });
	closeStore = async () => {
		await store.close();
		closeStore = undefined;
	};
	const startupHash = canonicalDurableSha256("inspection:startup");
	const provenanceHash = canonicalDurableSha256("inspection:provenance");
	const headHash = durableRootHeadHash({
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
	await store.transitionBatch(
		[
			{ ...construction, at: 1, phase: "reserved" },
			{ ...construction, at: 2, phase: "constructing" },
			{ ...construction, at: 3, phase: "constructed" },
		],
		{ requestId: "inspection-construction" },
	);
	await store.activateAuthority(
		{
			root: { kind: "root", at: 4, rootId: "Main", generation: 1, headHash, state: "active" },
			actor: {
				kind: "actor",
				at: 4,
				actorId: "Main",
				rootId: "Main",
				generation: 1,
				rootGeneration: 1,
				rootHeadHash: headHash,
				startupHash,
				provenanceHash,
				state: "active",
			},
			construction: { ...construction, at: 4, phase: "activated" },
			gate: { kind: "gate", at: 4, rootId: "Main", generation: 1, phase: "open" },
		},
		{ requestId: "inspection-activation" },
	);
	// The live SQLite connection holds an exclusive lock, so no second reader can
	// pin its WAL, and a clean close checkpoints and removes it. Capture the real
	// quiescent main/WAL pair after the last COMMIT and reinstall it after close:
	// the installed bundle is then exactly a crash-before-checkpoint image, which
	// an offline shared reader may pin (with its SHM) for the rest of the test.
	const sqlite = authorityPaths(sessionFile).sqlite;
	const crashImage =
		backend === "sqlite" && installedWal
			? { main: await fs.readFile(sqlite), wal: await fs.readFile(`${sqlite}-wal`) }
			: undefined;
	await closeStore();
	await closeManager();
	if (crashImage) {
		await fs.writeFile(sqlite, crashImage.main);
		await fs.writeFile(`${sqlite}-wal`, crashImage.wal, { mode: 0o600 });
		const reader = new Database(sqlite, { readonly: true });
		fixture.own(() => reader.close(true));
		reader.exec("BEGIN");
		reader.query("SELECT value FROM authority_controls WHERE order_key = CAST('meta' AS BLOB)").get();
	}
	return sessionFile;
}

async function snapshot(file: string): Promise<{ bytes: Buffer; dev: bigint; ino: bigint } | undefined> {
	try {
		const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file, { bigint: true })]);
		return { bytes, dev: stat.dev, ino: stat.ino };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function removeInspectionDirectories(): Promise<void> {
	const pending = [...fixtures].filter(fixture => fixture.pending);
	if (pending.length > 0) {
		const errors: unknown[] = [];
		for (const fixture of pending) for (const error of fixture.errors) appendErrorEvidence(errors, error);
		appendErrorEvidence(
			errors,
			new Error("Refusing recursive directory removal while inspection resource owners remain pending."),
		);
		throw new AggregateError(errors, "Authority inspection resources and their directories remain retained.", {
			cause: errors[0],
		});
	}
	const errors: unknown[] = [];
	for (const directory of [...directories]) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			directories.splice(directories.indexOf(directory), 1);
		} catch (error) {
			appendErrorEvidence(errors, error);
		}
	}
	if (errors.length > 0) {
		for (const fixture of fixtures) for (const error of fixture.errors) appendErrorEvidence(errors, error);
		throw new AggregateError(errors, "Authority inspection directory cleanup failed.", { cause: errors[0] });
	}
	fixtures.clear();
}

afterEach(removeInspectionDirectories);

describe("authority lifecycle installed-artifact inspection", () => {
	inspectionTest(
		"packs SQLite from a private snapshot without changing installed main, WAL, SHM, or authority evidence",
		async fixture => {
			const sessionFile = await authoritySession(fixture);
			const paths = authorityPaths(sessionFile);
			const artifactFiles = [
				paths.descriptor,
				paths.sqlite,
				`${paths.sqlite}-wal`,
				`${paths.sqlite}-shm`,
				paths.legacyFence,
				paths.lock,
			];
			const before = await Promise.all(artifactFiles.map(snapshot));
			expect(before[2]).toBeDefined();
			expect(before[2]?.bytes.length ?? 0).toBeGreaterThan(32);
			const sourceDescriptor = await readAuthorityDescriptor(sessionFile);
			if (!sourceDescriptor) throw new Error("Expected selected SQLite authority descriptor.");
			const bundle = await fixture.observe(packAuthorityBundle(sessionFile));
			const after = await Promise.all(artifactFiles.map(snapshot));
			expect(after).toEqual(before);
			for (const [index, name] of ["authority.sqlite", "authority.sqlite-wal", "authority.sqlite-shm"].entries()) {
				const snapshotIndex = index + 1;
				const member = bundle?.entries.find(entry => entry.name === name);
				if (before[snapshotIndex])
					expect<Buffer<ArrayBufferLike> | undefined>(Buffer.from(member?.data ?? [])).toEqual(
						before[snapshotIndex]?.bytes,
					);
				else expect(member).toBeUndefined();
			}
			for (const [snapshotIndex, name] of [
				[4, "authority-v1.jsonl.quarantine"],
				[5, "authority.lock"],
			] as const) {
				const member = bundle?.entries.find(entry => entry.name === name);
				expect<Buffer<ArrayBufferLike> | undefined>(Buffer.from(member?.data ?? [])).toEqual(
					before[snapshotIndex]?.bytes,
				);
			}
			const copied = path.join(path.dirname(sessionFile), ".authority-bundle-verification");
			await fs.mkdir(copied, { mode: 0o700 });
			for (const name of ["authority.sqlite", "authority.sqlite-wal", "authority.sqlite-shm"] as const) {
				const member = bundle?.entries.find(entry => entry.name === name);
				if (member) await fs.writeFile(path.join(copied, name), member.data, { mode: 0o600 });
			}
			const verifier = openAuthorityPersistence({
				path: path.join(copied, "authority.sqlite"),
				identity: {
					backend: "sqlite",
					owningSessionId: sourceDescriptor.owningSessionId,
					incarnation: sourceDescriptor.incarnation,
					format: 2,
				},
				create: false,
			});
			const closeVerifier = fixture.own(() => verifier.close());
			{
				verifier.integrityCheck();
				const state = verifier.exportState();
				expect(state.rows.some(row => row.record.kind === "root" && row.record.rootId === "Main")).toBe(true);
				expect(state.frames.some(frame => frame.request.requestId === "inspection-activation")).toBe(true);
				const receipts = state.controls.filter(control => control.key.startsWith("receipt:"));
				expect(receipts.length).toBeGreaterThan(0);
				for (const receipt of receipts)
					expect(state.frames.some(frame => JSON.stringify(frame.receipt) === JSON.stringify(receipt.value))).toBe(
						true,
					);
			}
			await closeVerifier();
			expect(bundle?.entries.some(entry => entry.name === "authority.json")).toBe(true);
			expect(bundle?.entries.some(entry => entry.name === "authority-v1.jsonl.quarantine")).toBe(true);
		},
	);

	inspectionTest("rejects a real changed SQLite WAL after proving the unchanged main stayed stable", async fixture => {
		const sessionFile = await authoritySession(fixture);
		const paths = authorityPaths(sessionFile);
		const mainBefore = await snapshot(paths.sqlite);
		if (!mainBefore) throw new Error("Expected a selected SQLite main artifact.");
		const wal = `${paths.sqlite}-wal`;
		const originalOpen = fs.open;
		let changed = false;
		const openSpy = spyOn(fs, "open").mockImplementation(
			new Proxy<typeof originalOpen>(originalOpen, {
				async apply(method, thisArg, args) {
					const handle = await Reflect.apply(method, thisArg, args);
					if (
						!changed &&
						String(args[0]).includes(".authority-inspection-") &&
						String(args[0]).endsWith(".sqlite")
					) {
						changed = true;
						await fs.appendFile(wal, Buffer.from("unrelated-wal-change"));
					}
					return handle;
				},
			}),
		);
		fixture.spy(openSpy);
		{
			const outcome = await fixture.observe(packAuthorityBundle(sessionFile)).then(
				() => ({ ok: true as const }),
				error => ({ ok: false as const, error }),
			);
			if (outcome.ok) throw new Error("An actual SQLite WAL change was accepted.");
			expect(changed).toBe(true);
			expect(await snapshot(paths.sqlite)).toEqual(mainBefore);
			expect((await fs.readFile(wal)).subarray(-20)).toEqual(Buffer.from("unrelated-wal-change"));
			if (!(outcome.error instanceof Error)) throw new Error("Expected changed-WAL refusal error.");
			expect(outcome.error.message).toContain(`${paths.sqlite}-wal`);
		}
	});
});

function cleanupCapable(error: unknown): error is AuthorityCleanupError {
	return error instanceof AuthorityCleanupError;
}

function inspectionDirectoryNames(directory: string): Promise<string[]> {
	return fs
		.readdir(directory)
		.then(names =>
			names.filter(
				name =>
					name.startsWith(".authority-inspection-") ||
					name.startsWith(".authority-bundle-check-") ||
					name.startsWith(".authority-relocation-check-"),
			),
		);
}

inspectionTest("packs unchanged JSONL authority artifacts and semantics from a private inspection", async fixture => {
	const sessionFile = await authoritySession(fixture, "jsonl");
	const paths = authorityPaths(sessionFile);
	const artifactFiles = [paths.descriptor, paths.jsonl, paths.legacyFence, paths.lock];
	const before = await Promise.all(artifactFiles.map(snapshot));
	const sourceDescriptor = await readAuthorityDescriptor(sessionFile);
	const jsonlBefore = before[1];
	if (!sourceDescriptor || !jsonlBefore) throw new Error("Expected selected JSONL authority artifacts.");
	const bundle = await fixture.observe(packAuthorityBundle(sessionFile));
	expect(await Promise.all(artifactFiles.map(snapshot))).toEqual(before);
	const member = bundle?.entries.find(entry => entry.name === "authority.jsonl");
	if (!member) throw new Error("Expected packed JSONL payload.");
	expect(member.data).toEqual(jsonlBefore.bytes);
	const copied = path.join(path.dirname(sessionFile), ".authority-jsonl-bundle-verification");
	await fs.mkdir(copied, { mode: 0o700 });
	const copiedPath = path.join(copied, "authority.jsonl");
	await fs.writeFile(copiedPath, member.data, { mode: 0o600 });
	const verifier = openAuthorityPersistence({
		path: copiedPath,
		identity: {
			backend: "jsonl",
			owningSessionId: sourceDescriptor.owningSessionId,
			incarnation: sourceDescriptor.incarnation,
			format: 2,
		},
		create: false,
	});
	const closeVerifier = fixture.own(() => verifier.close());
	{
		verifier.integrityCheck();
		const state = verifier.exportState();
		expect(state.rows.some(row => row.record.kind === "root" && row.record.rootId === "Main")).toBe(true);
		expect(state.frames.some(frame => frame.request.requestId === "inspection-activation")).toBe(true);
		expect(state.controls.some(control => control.key.startsWith("receipt:"))).toBe(true);
	}
	await closeVerifier();
});

inspectionTest("retains the exact private copy FileHandle and snapshot after close failure", async fixture => {
	const sessionFile = await authoritySession(fixture);
	const originalOpen = fs.open;
	let injected = false;
	let attempts = 0;
	const closeFailure = new Error("injected inspection FileHandle close failure");
	const openSpy = spyOn(fs, "open").mockImplementation(
		new Proxy<typeof originalOpen>(originalOpen, {
			async apply(method, thisArg, args) {
				const handle = await Reflect.apply(method, thisArg, args);
				if (injected || !String(args[0]).includes(".authority-inspection-") || !String(args[0]).endsWith(".sqlite"))
					return handle;
				injected = true;
				fixture.watch(handle);
				return new Proxy(handle, {
					get(target, property) {
						if (property === "close")
							return async () => {
								attempts++;
								if (fixture.faultsArmed && attempts === 1) throw closeFailure;
								return target.close();
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		}),
	);
	fixture.spy(openSpy);
	{
		const outcome = await fixture.observe(packAuthorityBundle(sessionFile)).then(
			() => ({ ok: true as const }),
			error => ({ ok: false as const, error }),
		);
		if (outcome.ok || !cleanupCapable(outcome.error))
			throw new Error("Inspection close failure lost its retryable cleanup capability.");
		expect(outcome.error.errors).toContain(closeFailure);
		expect(outcome.error.pending).toBe(true);
		expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(1);
		await outcome.error.cleanup();
		expect(attempts).toBe(2);
		expect(outcome.error.pending).toBe(false);
		expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(0);
	}
});

inspectionTest(
	"retains the private driver and composes bundle inspection, close, and removal failures",
	async fixture => {
		const sessionFile = await authoritySession(fixture);
		const bundle = await fixture.observe(packAuthorityBundle(sessionFile));
		if (!bundle) throw new Error("Expected a selected authority bundle.");
		const originalClose = SqliteAuthorityPersistence.prototype.close;
		const originalRm = fs.rm;
		const inspectionFailure = new Error("injected bundle inspection failure");
		const closeFailure = new Error("injected bundle driver close failure");
		const removeFailure = new Error("injected bundle snapshot removal failure");
		let closeAttempts = 0;
		let removalFailed = false;
		const integritySpy = spyOn(SqliteAuthorityPersistence.prototype, "integrityCheck").mockImplementation(() => {
			throw inspectionFailure;
		});
		const closeSpy = spyOn(SqliteAuthorityPersistence.prototype, "close").mockImplementation(
			function (this: SqliteAuthorityPersistence) {
				closeAttempts++;
				if (closeAttempts === 1) throw closeFailure;
				return originalClose.call(this);
			},
		);
		const removeSpy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (!removalFailed && String(file).includes(".authority-bundle-check-")) {
				removalFailed = true;
				throw removeFailure;
			}
			return originalRm(file, options);
		});
		fixture.spy(integritySpy);
		fixture.spy(closeSpy);
		fixture.spy(removeSpy);
		{
			const outcome = await fixture.observe(restoreAuthorityBundle(sessionFile, bundle)).then(
				() => ({ ok: true as const }),
				error => ({ ok: false as const, error }),
			);
			if (outcome.ok || !cleanupCapable(outcome.error))
				throw new Error("Bundle inspection lost its retained cleanup owner.");
			expect(outcome.error.errors).toContain(inspectionFailure);
			expect(outcome.error.errors).toContain(closeFailure);
			expect(outcome.error.pending).toBe(true);
			expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(1);
			await expect(outcome.error.cleanup()).rejects.toBe(outcome.error);
			expect(outcome.error.errors).toContain(removeFailure);
			expect(outcome.error.pending).toBe(true);
			expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(1);
			removeSpy.mockRestore();
			await outcome.error.cleanup();
			expect(closeAttempts).toBe(2);
			expect(outcome.error.pending).toBe(false);
			expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(0);
		}
	},
);

inspectionTest(
	"retains relocation inspection, close, and removal failures until its private snapshot is cleaned",
	async fixture => {
		const source = await authoritySession(fixture, "sqlite", false);
		const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-inspection-target-"));
		directories.push(targetDirectory);
		const target = path.join(targetDirectory, path.basename(source));
		const originalOpen = fs.open;
		const originalIntegrityCheck = SqliteAuthorityPersistence.prototype.integrityCheck;
		const originalClose = SqliteAuthorityPersistence.prototype.close;
		const originalRm = fs.rm;
		const inspectionFailure = new Error("injected relocation bundle inspection failure");
		const closeFailure = new Error("injected relocation driver close failure");
		const removeFailure = new Error("injected relocation snapshot removal failure");
		let relocationCopyOpened = false;
		let closeAttempts = 0;
		let removalFailed = false;
		const openSpy = spyOn(fs, "open").mockImplementation(
			new Proxy<typeof originalOpen>(originalOpen, {
				async apply(method, thisArg, args) {
					const handle = await Reflect.apply(method, thisArg, args);
					if (String(args[0]).includes(".authority-relocation-check-") && String(args[0]).endsWith(".sqlite"))
						relocationCopyOpened = true;
					return handle;
				},
			}),
		);
		const integritySpy = spyOn(SqliteAuthorityPersistence.prototype, "integrityCheck").mockImplementation(
			function (this: SqliteAuthorityPersistence) {
				if (relocationCopyOpened) throw inspectionFailure;
				return originalIntegrityCheck.call(this);
			},
		);
		const closeSpy = spyOn(SqliteAuthorityPersistence.prototype, "close").mockImplementation(
			function (this: SqliteAuthorityPersistence) {
				if (relocationCopyOpened) {
					closeAttempts++;
					if (closeAttempts === 1) throw closeFailure;
				}
				return originalClose.call(this);
			},
		);
		const removeSpy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (!removalFailed && String(file).includes(".authority-relocation-check-")) {
				removalFailed = true;
				throw removeFailure;
			}
			return originalRm(file, options);
		});
		fixture.spy(openSpy);
		fixture.spy(integritySpy);
		fixture.spy(closeSpy);
		fixture.spy(removeSpy);
		{
			const outcome = await fixture.observe(moveAuthorityBundle(source, target)).then(
				() => ({ ok: true as const }),
				error => ({ ok: false as const, error }),
			);
			if (outcome.ok) throw new Error("Failed relocation inspection was accepted before descriptor selection.");
			let current: unknown = outcome.error;
			const seen = new Set<unknown>();
			let cleanup: AuthorityCleanupError | undefined;
			while (current !== undefined && !seen.has(current)) {
				if (cleanupCapable(current)) {
					cleanup = current;
					break;
				}
				seen.add(current);
				current = current instanceof Error ? current.cause : undefined;
			}
			if (!cleanup) throw new Error("Relocation inspection lost its retryable cleanup capability.");
			expect(cleanup.errors).toContain(inspectionFailure);
			expect(cleanup.errors).toContain(closeFailure);
			expect(cleanup.pending).toBe(true);
			expect(relocationCopyOpened).toBe(true);
			expect(await Bun.file(source).exists()).toBe(true);
			expect((await readAuthorityDescriptor(target))?.state).toBe("initializing");
			expect(await inspectionDirectoryNames(targetDirectory)).toHaveLength(1);
			await expect(cleanup.cleanup()).rejects.toBe(cleanup);
			expect(cleanup.errors).toContain(removeFailure);
			expect(cleanup.pending).toBe(true);
			expect(await inspectionDirectoryNames(targetDirectory)).toHaveLength(1);
			removeSpy.mockRestore();
			await cleanup.cleanup();
			expect(closeAttempts).toBe(2);
			expect(cleanup.pending).toBe(false);
			expect(await inspectionDirectoryNames(targetDirectory)).toHaveLength(0);
		}
	},
);

inspectionTest("packs, restores, and repacks exact nested retained backup evidence", async fixture => {
	const source = await authoritySession(fixture);
	const backupId = "123e4567-e89b-42d3-a456-426614174000";
	const backupName = `${path.basename(source)}.authority.backup.${backupId}`;
	const backup = path.join(path.dirname(source), backupName);
	const evidenceName = `authority.backup.${backupId}/evidence/authority.jsonl`;
	const evidence = Buffer.from("retained legacy authority evidence\n");
	const evidenceFile = path.join(backup, "evidence", "authority.jsonl");
	await fs.mkdir(path.dirname(evidenceFile), { recursive: true, mode: 0o700 });
	await fs.writeFile(evidenceFile, evidence, { mode: 0o600 });

	const packed = await fixture.observe(packAuthorityBundle(source));
	if (!packed) throw new Error("Expected a selected authority bundle with retained backup evidence.");
	const packedEvidence = packed.entries.filter(entry => entry.name.startsWith(`authority.backup.${backupId}/`));
	expect(packedEvidence).toEqual([{ name: evidenceName, data: evidence }]);

	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-retained-backup-roundtrip-"));
	directories.push(directory);
	const target = path.join(directory, path.basename(source));
	await fs.copyFile(source, target);
	await fixture.observe(restoreAuthorityBundle(target, packed));
	expect(await fs.readFile(path.join(directory, `${path.basename(target)}.${evidenceName}`))).toEqual(evidence);

	const repacked = await fixture.observe(packAuthorityBundle(target));
	if (!repacked) throw new Error("Expected the restored authority bundle to repack.");
	expect(repacked.entries.filter(entry => entry.name.startsWith(`authority.backup.${backupId}/`))).toEqual(
		packedEvidence,
	);
});

for (const mutation of ["content", "membership", "identity"] as const) {
	inspectionTest(`rejects retained backup ${mutation} changes during selected-source inspection`, async fixture => {
		const sessionFile = await authoritySession(fixture);
		const base = path.basename(sessionFile);
		const backupName = `${base}.authority.backup.123e4567-e89b-42d3-a456-426614174000`;
		const backup = path.join(path.dirname(sessionFile), backupName);
		const nested = path.join(backup, "evidence");
		await fs.mkdir(nested, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(nested, "first.json"), "first evidence\n", { mode: 0o600 });
		if (mutation === "identity")
			await fs.writeFile(path.join(nested, "second.json"), "first evidence\n", { mode: 0o600 });
		const originalOpen = fs.open;
		const originalClose = SqliteAuthorityPersistence.prototype.close;
		let inspected = false;
		let changed = false;
		const closeSpy = spyOn(SqliteAuthorityPersistence.prototype, "close").mockImplementation(
			function (this: SqliteAuthorityPersistence) {
				const result = originalClose.call(this);
				inspected = true;
				return result;
			},
		);
		const openSpy = spyOn(fs, "open").mockImplementation(
			new Proxy<typeof originalOpen>(originalOpen, {
				async apply(method, thisArg, args) {
					const handle = await Reflect.apply(method, thisArg, args);
					if (inspected && !changed && String(args[0]) === path.join(nested, "first.json")) {
						changed = true;
						if (mutation === "content")
							await fs.writeFile(path.join(nested, "first.json"), "changed evidence\n", { mode: 0o600 });
						else if (mutation === "membership")
							await fs.writeFile(path.join(nested, "new.json"), "new evidence\n", { mode: 0o600 });
						else {
							await fs.rename(path.join(nested, "first.json"), path.join(nested, "swap.json"));
							await fs.rename(path.join(nested, "second.json"), path.join(nested, "first.json"));
							await fs.rename(path.join(nested, "swap.json"), path.join(nested, "second.json"));
						}
					}
					return handle;
				},
			}),
		);
		fixture.spy(closeSpy);
		fixture.spy(openSpy);
		{
			const outcome = await fixture.observe(packAuthorityBundle(sessionFile)).then(
				() => ({ ok: true as const }),
				error => ({ ok: false as const, error }),
			);
			if (outcome.ok) throw new Error("Changed retained backup evidence was accepted into the authority bundle.");
			expect(changed).toBe(true);
			expect(outcome.error).toBeInstanceOf(Error);
			if (!(outcome.error instanceof Error)) throw new Error("Expected retained-backup change refusal.");
			expect(outcome.error.message).toMatch(/changed|backup/i);
		}
	});
}

inspectionTest("revalidates the exact published relocation target before selecting its descriptor", async fixture => {
	const source = await authoritySession(fixture, "sqlite", false);
	const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-inspection-target-"));
	directories.push(targetDirectory);
	const target = path.join(targetDirectory, path.basename(source));
	const targetPayload = authorityPaths(target).sqlite;
	const originalOpen = fs.open;
	let relocationInspections = 0;
	let changed = false;
	const openSpy = spyOn(fs, "open").mockImplementation(
		new Proxy<typeof originalOpen>(originalOpen, {
			async apply(method, thisArg, args) {
				const handle = await Reflect.apply(method, thisArg, args);
				if (String(args[0]).includes(".authority-relocation-check-") && String(args[0]).endsWith(".sqlite")) {
					relocationInspections++;
					if (!changed && relocationInspections === 2) {
						changed = true;
						await fs.appendFile(targetPayload, Buffer.from("unrelated-published-target-change"));
					}
				}
				return handle;
			},
		}),
	);
	fixture.spy(openSpy);
	{
		await expect(fixture.observe(moveAuthorityBundle(source, target))).rejects.toThrow(
			/changed|published relocation/i,
		);
		expect(changed).toBe(true);
		expect(await Bun.file(source).exists()).toBe(true);
		expect((await readAuthorityDescriptor(target))?.state).toBe("initializing");
	}
});

inspectionTest("retains a default installed read handle when read and close both fail", async fixture => {
	const sessionFile = await authoritySession(fixture, "jsonl");
	const file = authorityPaths(sessionFile).legacyFence;
	const originalOpen = fs.open;
	const readFailure = new Error("installed read failed");
	const closeFailure = new Error("installed read close failed");
	let attempts = 0;
	let injected = false;
	let fenceReads = 0;
	const spy = spyOn(fs, "open").mockImplementation(
		new Proxy<typeof originalOpen>(originalOpen, {
			async apply(method, thisArg, args) {
				const handle = await Reflect.apply(method, thisArg, args);
				if (injected || String(args[0]) !== file || ++fenceReads !== 7) return handle;
				injected = true;
				fixture.watch(handle);
				return new Proxy(handle, {
					get(target, property) {
						if (property === "readFile")
							return async (...readArgs: Parameters<fs.FileHandle["readFile"]>) => {
								if (fixture.faultsArmed) throw readFailure;
								return target.readFile(...readArgs);
							};
						if (property === "close")
							return async () => {
								if (++attempts === 1 && fixture.faultsArmed) throw closeFailure;
								return target.close();
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		}),
	);
	fixture.spy(spy);
	{
		const outcome = await fixture.observe(packAuthorityBundle(sessionFile)).then(
			() => undefined,
			error => error,
		);
		if (!(outcome instanceof AuthorityCleanupError)) throw new Error("Installed read lost its cleanup owner.");
		expect(outcome.errors).toContain(readFailure);
		expect(outcome.errors).toContain(closeFailure);
		await outcome.cleanup();
		expect(attempts).toBe(2);
		expect(outcome.pending).toBe(false);
	}
});

for (const completed of [false, true]) {
	inspectionTest(
		`refuses retained restore evidence changed during ${completed ? "completed" : "initial"} inspection`,
		async fixture => {
			const source = await authoritySession(fixture, "sqlite", false);
			const backup = `${source}.authority.backup.123e4567-e89b-42d3-a456-426614174000`;
			await fs.mkdir(path.join(backup, "nested"), { recursive: true, mode: 0o700 });
			await fs.writeFile(path.join(backup, "nested", "evidence"), "original", { mode: 0o600 });
			const bundle = await fixture.observe(packAuthorityBundle(source));
			if (!bundle) throw new Error("Expected bundle.");
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-evidence-"));
			directories.push(directory);
			const target = path.join(directory, path.basename(source));
			await fs.copyFile(source, target);
			if (completed) await fixture.observe(restoreAuthorityBundle(target, bundle));
			const retained = `${target}.authority.backup.123e4567-e89b-42d3-a456-426614174000`;
			let changed = false;
			let privateCopy = false;
			let inspected = false;
			const originalClose = SqliteAuthorityPersistence.prototype.close;
			const spy = spyOn(SqliteAuthorityPersistence.prototype, "close").mockImplementation(
				function (this: SqliteAuthorityPersistence) {
					const result = originalClose.call(this);
					if (privateCopy) inspected = true;
					return result;
				},
			);
			const originalOpen = fs.open;
			const openSpy = spyOn(fs, "open").mockImplementation(
				new Proxy<typeof originalOpen>(originalOpen, {
					async apply(method, thisArg, args) {
						const handle = await Reflect.apply(method, thisArg, args);
						if (
							String(args[0]).includes(".authority-inspection-") &&
							String(args[0]).endsWith(".sqlite") &&
							(await Bun.file(authorityPaths(target).descriptor).exists()) &&
							(await Bun.file(path.join(retained, "nested", "evidence")).exists())
						)
							privateCopy = true;
						if (inspected && !changed && String(args[0]) === path.join(retained, "nested", "evidence")) {
							changed = true;
							await fs.writeFile(path.join(retained, "nested", "added"), "unrelated", { mode: 0o600 });
						}
						return handle;
					},
				}),
			);
			fixture.spy(openSpy);
			fixture.spy(spy);
			{
				await expect(fixture.observe(restoreAuthorityBundle(target, bundle))).rejects.toThrow(/changed|backup/i);
				expect(changed).toBe(true);
				if (!completed) expect((await readAuthorityDescriptor(target))?.state).toBe("initializing");
			}
		},
	);
}

inspectionTest(
	"retains a failed staged SQLite driver and the original inspection failure until real close",
	async fixture => {
		const source = await authoritySession(fixture, "sqlite", false);
		const bundle = await fixture.observe(packAuthorityBundle(source));
		if (!bundle) throw new Error("Expected bundle.");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-stage-"));
		directories.push(directory);
		const target = path.join(directory, path.basename(source));
		await fs.copyFile(source, target);
		const originalOpen = fs.open;
		const originalIntegrity = SqliteAuthorityPersistence.prototype.integrityCheck;
		const originalClose = SqliteAuthorityPersistence.prototype.close;
		const primary = new Error("staged integrity failed");
		const closeFailure = new Error("staged physical close failed");
		let staged = false;
		let attempts = 0;
		const openSpy = spyOn(fs, "open").mockImplementation(
			new Proxy<typeof originalOpen>(originalOpen, {
				async apply(method, thisArg, args) {
					const handle = await Reflect.apply(method, thisArg, args);
					if (String(args[0]).includes(".authority.stage.") && String(args[0]).includes("/source/")) staged = true;
					return handle;
				},
			}),
		);
		const integritySpy = spyOn(SqliteAuthorityPersistence.prototype, "integrityCheck").mockImplementation(
			function (this: SqliteAuthorityPersistence) {
				if (staged) throw primary;
				return originalIntegrity.call(this);
			},
		);
		const closeSpy = spyOn(SqliteAuthorityPersistence.prototype, "close").mockImplementation(
			function (this: SqliteAuthorityPersistence) {
				if (staged && ++attempts === 1) throw closeFailure;
				return originalClose.call(this);
			},
		);
		fixture.spy(openSpy);
		fixture.spy(integritySpy);
		fixture.spy(closeSpy);
		{
			const error = await fixture.observe(restoreAuthorityBundle(target, bundle)).then(
				() => undefined,
				failure => failure,
			);
			if (!(error instanceof AuthorityCleanupError)) throw new Error("Staged driver cleanup ownership was lost.");
			expect(error.errors).toContain(primary);
			expect(error.errors).toContain(closeFailure);
			expect((await fs.readdir(directory)).some(name => name.includes(".authority.stage."))).toBe(true);
			await error.cleanup();
			expect(attempts).toBe(2);
			expect(error.pending).toBe(false);
		}
	},
);

inspectionTest("composes selected-driver and post-inspection FileHandle failures under one owner", async fixture => {
	const sessionFile = await authoritySession(fixture, "sqlite", false);
	const descriptor = authorityPaths(sessionFile).descriptor;
	const originalOpen = fs.open;
	const originalClose = SqliteAuthorityPersistence.prototype.close;
	const driverFailure = new Error("selected driver close failed");
	const handleFailure = new Error("revalidation handle close failed");
	let driverAttempts = 0;
	let handleAttempts = 0;
	let postInspection = false;
	let injected = false;
	const closeSpy = spyOn(SqliteAuthorityPersistence.prototype, "close").mockImplementation(
		function (this: SqliteAuthorityPersistence) {
			if (++driverAttempts === 1) {
				postInspection = true;
				throw driverFailure;
			}
			return originalClose.call(this);
		},
	);
	const openSpy = spyOn(fs, "open").mockImplementation(
		new Proxy<typeof originalOpen>(originalOpen, {
			async apply(method, thisArg, args) {
				const handle = await Reflect.apply(method, thisArg, args);
				if (!postInspection || injected || String(args[0]) !== descriptor) return handle;
				injected = true;
				fixture.watch(handle);
				return new Proxy(handle, {
					get(target, property) {
						if (property === "close")
							return async () => {
								if (++handleAttempts === 1 && fixture.faultsArmed) throw handleFailure;
								return target.close();
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		}),
	);
	fixture.spy(openSpy);
	fixture.spy(closeSpy);
	{
		const error = await fixture.observe(packAuthorityBundle(sessionFile)).then(
			() => undefined,
			failure => failure,
		);
		if (!(error instanceof AuthorityCleanupError)) throw new Error("Composed cleanup owner was lost.");
		expect(error.errors).toContain(driverFailure);
		expect(error.errors).toContain(handleFailure);
		expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(1);
		await error.cleanup();
		expect(driverAttempts).toBe(2);
		expect(handleAttempts).toBe(2);
		expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(0);
	}
});

inspectionTest(
	"retains a failed SQLite staging constructor cleanup until the same real connection closes",
	async fixture => {
		const source = await authoritySession(fixture, "sqlite", false);
		const bundle = await fixture.observe(packAuthorityBundle(source));
		if (!bundle) throw new Error("Expected bundle.");
		const nativeHeader = Buffer.from(bundle.entries.find(entry => entry.name === "authority.sqlite")!.data).subarray(
			0,
			100,
		);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-constructor-"));
		directories.push(directory);
		const target = path.join(directory, path.basename(source));
		await fs.copyFile(source, target);
		const originalOpen = fs.open;
		const originalExec = Database.prototype.exec;
		const originalClose = Database.prototype.close;
		const primary = new Error("staged constructor failed after connected PRAGMA");
		const closeFailures = [
			new Error("constructor physical close failed"),
			new Error("constructor immediate cleanup close failed"),
		];
		let stagedFile: string | undefined;
		let connection: Database | undefined;
		const closedConnections: Database[] = [];
		const openSpy = spyOn(fs, "open").mockImplementation(
			new Proxy<typeof originalOpen>(originalOpen, {
				async apply(method, thisArg, args) {
					const handle = await Reflect.apply(method, thisArg, args);
					const file = String(args[0]);
					if (file.includes(".authority.stage.") && file.endsWith("/source/authority.sqlite")) stagedFile = file;
					return handle;
				},
			}),
		);
		const execSpy = spyOn(Database.prototype, "exec").mockImplementation(function (
			this: Database,
			...args: Parameters<Database["exec"]>
		) {
			const result = originalExec.apply(this, args);
			if (stagedFile && !connection && String(args[0]).startsWith("PRAGMA busy_timeout=")) {
				connection = this;
				expect(this.query("PRAGMA application_id").get()).toBeDefined();
				throw primary;
			}
			return result;
		});
		const closeSpy = spyOn(Database.prototype, "close").mockImplementation(function (
			this: Database,
			...args: Parameters<Database["close"]>
		) {
			if (this === connection) {
				closedConnections.push(this);
				const failure = closeFailures[closedConnections.length - 1];
				if (failure) throw failure;
			}
			return originalClose.apply(this, args);
		});
		fixture.spy(openSpy);
		fixture.spy(execSpy);
		fixture.spy(closeSpy);
		{
			const error = await fixture.observe(restoreAuthorityBundle(target, bundle)).then(
				() => undefined,
				failure => failure,
			);
			if (!(error instanceof AuthorityCleanupError)) throw new Error("Constructor cleanup owner was lost.");
			if (!stagedFile || !connection)
				throw new Error("Expected a real post-connection staging constructor failure.");
			expect((await fs.readFile(stagedFile)).subarray(0, 100)).toEqual(nativeHeader);
			expect(nativeHeader.toString("ascii", 0, 16)).toBe("SQLite format 3\0");
			const construction = error.errors.find(failure => failure instanceof SqliteAuthorityConstructionError);
			if (!(construction instanceof SqliteAuthorityConstructionError))
				throw new Error("Expected retained native construction cleanup.");
			expect(construction.constructionError).toBe(primary);
			for (const failure of closeFailures) expect(construction.errors).toContain(failure);
			expect(closedConnections).toEqual([connection, connection]);
			expect(connection.query("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
			expect(error.pending).toBe(true);
			expect((await fs.readdir(directory)).some(name => name.includes(".authority.stage."))).toBe(true);
			await expect(fixture.ownership(target)).rejects.toThrow(/already held/i);
			await error.cleanup();
			expect(closedConnections).toEqual([connection, connection, connection]);
			expect(() => connection!.query("SELECT 1").get()).toThrow();
			expect(error.pending).toBe(false);
			await error.cleanup();
			expect(closedConnections).toHaveLength(3);
			const ownership = await fixture.ownership(target);
			await ownership.release();
		}
	},
);

inspectionTest("retains empty replacement staging until its real SQLite driver closes", async fixture => {
	const source = await authoritySession(fixture, "sqlite", false);
	const descriptor = await readAuthorityDescriptor(source);
	if (!descriptor) throw new Error("Expected source authority.");
	const transcript = await fs.readFile(source);
	const originalOpen = fs.open;
	const originalClose = SqliteAuthorityPersistence.prototype.close;
	const closeFailure = new Error("empty replacement close failed");
	let preparing = false;
	let attempts = 0;
	const openSpy = spyOn(fs, "open").mockImplementation(
		new Proxy<typeof originalOpen>(originalOpen, {
			async apply(method, thisArg, args) {
				const handle = await Reflect.apply(method, thisArg, args);
				if (String(args[0]).includes(".relocation-") && String(args[0]).endsWith("/validation.jsonl"))
					preparing = true;
				return handle;
			},
		}),
	);
	const closeSpy = spyOn(SqliteAuthorityPersistence.prototype, "close").mockImplementation(
		function (this: SqliteAuthorityPersistence) {
			if (preparing && ++attempts === 1) throw closeFailure;
			return originalClose.call(this);
		},
	);
	fixture.spy(openSpy);
	fixture.spy(closeSpy);
	{
		const error = await fixture
			.observe(
				replaceSessionAuthorityBundle({
					sources: [source],
					target: source,
					owningSessionId: descriptor.owningSessionId,
					transcript,
					artifacts: [],
					cwd: path.dirname(source),
				}),
			)
			.then(
				() => undefined,
				failure => failure,
			);
		if (!(error instanceof AuthorityCleanupError)) throw new Error("Empty replacement lost its cleanup owner.");
		expect(error.errors).toContain(closeFailure);
		expect((await fs.readdir(path.dirname(source))).some(name => name.includes(".relocation-"))).toBe(true);
		await error.cleanup();
		expect(attempts).toBe(2);
		expect((await fs.readdir(path.dirname(source))).some(name => name.includes(".relocation-"))).toBe(false);
	}
});

for (const publication of ["restore-manifest", "relocation-payload"] as const) {
	for (const boundary of ["write", "sync", "close"] as const) {
		inspectionTest(
			`retains ${publication} after ${boundary} failure through repeated physical close and removal failures`,
			async fixture => {
				const source = await authoritySession(fixture, "sqlite", false);
				const bundle = await fixture.observe(packAuthorityBundle(source));
				if (!bundle) throw new Error("Expected a real SQLite authority bundle.");
				const sourcePaths = authorityPaths(source);
				const sourceFiles = [source, sourcePaths.descriptor, sourcePaths.sqlite, sourcePaths.legacyFence];
				const sourceBefore = await Promise.all(sourceFiles.map(snapshot));
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publication-cleanup-"));
				directories.push(directory);
				const target = path.join(directory, path.basename(source));
				if (publication === "restore-manifest") await fs.copyFile(source, target);
				const originalOpen = fs.open;
				const originalRm = fs.rm;
				const primary = new Error(`${publication} ${boundary} failed`);
				const firstClose = boundary === "close" ? primary : new Error(`${publication} first physical close failed`);
				const secondClose = new Error(`${publication} second physical close failed`);
				const removalFailure = new Error(`${publication} temporary removal failed`);
				let temporary: string | undefined;
				let retainedHandle: fs.FileHandle | undefined;
				let writes = 0;
				let syncs = 0;
				let closes = 0;
				let removals = 0;
				let released = false;
				let releaseEvidence: { fd: number | undefined; temporaryExists: boolean } | undefined;
				const openSpy = spyOn(fs, "open").mockImplementation(
					new Proxy<typeof originalOpen>(originalOpen, {
						async apply(method, thisArg, args) {
							const handle = await Reflect.apply(method, thisArg, args);
							const file = String(args[0]);
							const matches =
								publication === "restore-manifest"
									? file.startsWith(`${target}.authority.restore.`) && file.includes(".json.tmp-")
									: path.dirname(file) === directory &&
										path
											.basename(file)
											.startsWith(`.${path.basename(authorityPaths(target).sqlite)}.relocation-`);
							if (retainedHandle || !matches) return handle;
							temporary = file;
							retainedHandle = handle;
							fixture.watch(handle);
							return new Proxy(handle, {
								get(realHandle, property) {
									if (property === "writeFile")
										return async (...writeArgs: Parameters<fs.FileHandle["writeFile"]>) => {
											writes++;
											await realHandle.writeFile(...writeArgs);
											if (fixture.faultsArmed && boundary === "write") throw primary;
										};
									if (property === "sync")
										return async () => {
											syncs++;
											await realHandle.sync();
											if (fixture.faultsArmed && boundary === "sync") throw primary;
										};
									if (property === "close")
										return async () => {
											closes++;
											if (fixture.faultsArmed && closes === 1) throw firstClose;
											if (fixture.faultsArmed && closes === 2) throw secondClose;
											await realHandle.close();
										};
									const value = Reflect.get(realHandle, property, realHandle);
									return typeof value === "function" ? value.bind(realHandle) : value;
								},
							});
						},
					}),
				);
				const removeSpy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
					if (temporary && String(file) === temporary) {
						expect(retainedHandle?.fd).toBe(-1);
						if (++removals === 1) throw removalFailure;
					}
					return originalRm(file, options);
				});
				fixture.spy(openSpy);
				fixture.spy(removeSpy);
				{
					const error = await fixture
						.observe(
							publication === "restore-manifest"
								? restoreAuthorityBundle(target, bundle)
								: moveAuthorityBundle(source, target),
						)
						.then(
							() => undefined,
							failure => failure,
						);
					if (!(error instanceof AuthorityCleanupError))
						throw new Error("Publication lost its shared pending cleanup owner.");
					if (!temporary || !retainedHandle) throw new Error("Expected a real private publication handle.");
					expect(error.cause).toBe(primary);
					expect(error.errors).toContain(primary);
					expect(error.errors).toContain(firstClose);
					expect(error.pending).toBe(true);
					expect(closes).toBe(1);
					expect(removals).toBe(0);
					expect((await retainedHandle.stat()).size).toBeGreaterThan(100);
					expect(await Bun.file(temporary).exists()).toBe(true);
					expect(await Bun.file(authorityPaths(target).sqlite).exists()).toBe(false);
					error.afterCleanup(async () => {
						releaseEvidence = { fd: retainedHandle?.fd, temporaryExists: await Bun.file(temporary!).exists() };
						released = true;
					});
					await expect(fixture.ownership(source)).rejects.toThrow(/already held/i);
					await expect(fixture.observe(error.cleanup())).rejects.toBe(error);
					expect(error.errors).toContain(secondClose);
					expect(closes).toBe(2);
					expect(removals).toBe(0);
					expect(retainedHandle.fd).toBeGreaterThanOrEqual(0);
					expect(await Bun.file(temporary).exists()).toBe(true);
					expect(released).toBe(false);
					await expect(fixture.observe(error.cleanup())).rejects.toBe(error);
					expect(error.errors).toContain(removalFailure);
					expect(error.pending).toBe(true);
					expect(retainedHandle.fd).toBe(-1);
					expect(closes).toBe(3);
					expect(removals).toBe(1);
					expect(await Bun.file(temporary).exists()).toBe(true);
					expect(released).toBe(false);
					await expect(fixture.ownership(source)).rejects.toThrow(/already held/i);
					await error.cleanup();
					expect(error.pending).toBe(false);
					expect(closes).toBe(3);
					expect(removals).toBe(2);
					expect(writes).toBe(1);
					expect(syncs).toBe(boundary === "write" ? 0 : 1);
					expect(released).toBe(true);
					expect(releaseEvidence?.fd).toBe(-1);
					expect(releaseEvidence?.temporaryExists).toBe(false);
					expect(await Bun.file(temporary).exists()).toBe(false);
					expect(await Promise.all(sourceFiles.map(snapshot))).toEqual(sourceBefore);
					await error.cleanup();
					expect(closes).toBe(3);
					expect(removals).toBe(2);
					const ownership = await fixture.ownership(source);
					await ownership.release();
				}
			},
		);
	}
}

for (const interruptedAt of ["assertion", "cleanup-retry"] as const) {
	inspectionTest(
		`physically cleans the same inspection owner after an interrupted ${interruptedAt}`,
		async fixture => {
			let sessionFile: string | undefined;
			let handle: fs.FileHandle | undefined;
			let owner: AuthorityCleanupError | undefined;
			let originalFailure: unknown;
			let opens = 0;
			let closes = 0;
			const closeFailure = new Error("inspection remains open until fixture faults are disarmed");
			const failure = await runInspectionFixture(async interrupted => {
				sessionFile = await authoritySession(interrupted);
				const originalOpen = fs.open;
				interrupted.spy(
					spyOn(fs, "open").mockImplementation(
						new Proxy<typeof originalOpen>(originalOpen, {
							async apply(method, thisArg, args) {
								const opened = await Reflect.apply(method, thisArg, args);
								if (
									handle ||
									!String(args[0]).includes(".authority-inspection-") ||
									!String(args[0]).endsWith(".sqlite")
								)
									return opened;
								handle = opened;
								interrupted.watch(opened);
								opens++;
								return new Proxy(opened, {
									get(target, property) {
										if (property === "close")
											return async () => {
												closes++;
												if (interrupted.faultsArmed) throw closeFailure;
												await target.close();
											};
										const value = Reflect.get(target, property, target);
										return typeof value === "function" ? value.bind(target) : value;
									},
								});
							},
						}),
					),
				);
				const error = await interrupted.observe(packAuthorityBundle(sessionFile)).then(
					() => undefined,
					error => error,
				);
				if (!(error instanceof AuthorityCleanupError))
					throw new Error("Expected the real inspection cleanup owner.");
				owner = error;
				try {
					if (interruptedAt === "assertion") expect(error.pending).toBe(false);
					else await error.cleanup();
				} catch (error) {
					originalFailure = error;
					throw error;
				}
			}).then(
				() => undefined,
				error => error,
			);
			expect(originalFailure).toBeDefined();
			expect(failure).toBe(originalFailure);
			expect(owner?.errors).toContain(closeFailure);
			expect(owner?.pending).toBe(false);
			expect(handle?.fd).toBe(-1);
			expect(opens).toBe(1);
			expect(closes).toBe(interruptedAt === "assertion" ? 2 : 3);
			if (!sessionFile) throw new Error("Expected the interrupted real authority fixture.");
			expect(await inspectionDirectoryNames(path.dirname(sessionFile))).toHaveLength(0);
			const ownership = await fixture.ownership(sessionFile);
			await ownership.release();
		},
	);
}

inspectionTest(
	"preserves assertion and all cleanup errors without removing directories containing pending owners",
	async fixture => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inspection-teardown-"));
		directories.push(directory);
		const files = [path.join(directory, "first"), path.join(directory, "second")];
		const handles: fs.FileHandle[] = [];
		const owners: AuthorityCleanupError[] = [];
		const primary = new Error("original inspection failure");
		const assertionFailure = new Error("intermediate assertion failure");
		const closeFailures = [
			new Error("first retained physical close failed"),
			new Error("second retained physical close failed"),
		];
		let unavailable = true;
		let releases = 0;
		fixture.disarm(() => {
			unavailable = false;
		});
		for (const [index, file] of files.entries()) {
			await fs.writeFile(file, `retained evidence ${index}`);
			const handle = await fs.open(file, "r");
			handles.push(handle);
			fixture.watch(handle);
			const originalClose = handle.close.bind(handle);
			fixture.spy(
				spyOn(handle, "close").mockImplementation(async () => {
					if (unavailable) throw closeFailures[index];
					await originalClose();
				}),
			);
			const owner = new AuthorityCleanupError([primary], "Fixture physical cleanup failed.", async () => {
				await handle.close();
			});
			owner.afterCleanup(async () => {
				releases++;
			});
			owners.push(owner);
			fixture.retain(owner);
		}
		let interrupted: InspectionFixture | undefined;
		const failure = await runInspectionFixture(async pending => {
			interrupted = pending;
			for (const owner of owners) pending.retain(owner);
			throw assertionFailure;
		}).then(
			() => undefined,
			error => error,
		);
		if (!(failure instanceof AggregateError))
			throw new Error("Expected original assertion and distinct teardown errors.");
		expect(failure.cause).toBe(assertionFailure);
		for (const error of [assertionFailure, primary, ...closeFailures]) expect(failure.errors).toContain(error);
		expect(owners.map(owner => owner.pending)).toEqual([true, true]);
		expect(handles.every(handle => handle.fd >= 0)).toBe(true);
		expect(releases).toBe(0);
		expect(fixture.disarmFaults()).toEqual([]);
		const removal = await removeInspectionDirectories().then(
			() => undefined,
			error => error,
		);
		if (!(removal instanceof AggregateError))
			throw new Error("Pending owners did not fence recursive fixture removal.");
		for (const error of [assertionFailure, primary, ...closeFailures]) expect(removal.errors).toContain(error);
		expect(await Promise.all(files.map(file => fs.readFile(file, "utf8")))).toEqual([
			"retained evidence 0",
			"retained evidence 1",
		]);
		if (!interrupted) throw new Error("Expected retained interrupted fixture state.");
		expect(await interrupted.cleanup()).toEqual([]);
		expect(owners.map(owner => owner.pending)).toEqual([false, false]);
		expect(handles.map(handle => handle.fd)).toEqual([-1, -1]);
		expect(releases).toBe(2);
	},
);
