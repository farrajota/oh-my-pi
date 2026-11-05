import { afterEach, describe, expect, it as bunIt, spyOn } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import type { FileHandle } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { FileLock } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { migrateAuthority, recoverAuthorityMigration } from "../../src/registry/authority/migration";
import {
	acquireAuthorityOwnership,
	authorityPaths,
	withAuthorityExclusive,
} from "../../src/registry/authority/ownership";
import { AuthorityCleanupError, withRetainedAuthorityCleanup } from "../../src/registry/authority/private-cleanup";
import * as persistenceModule from "../../src/registry/authority/persistence";
import { SqliteAuthorityConstructionError } from "../../src/registry/authority/sqlite-driver";
import {
	canonicalDurableSha256,
	durableGenesisHash,
	RegistryDurableStateStore,
	registryDurableJournalPath,
} from "../../src/registry/durable-state";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import type { AuthorityDriverOptions, AuthorityPersistence } from "../../src/registry/authority/types";
import { tmpdirOnXfs } from "./authority-capacity-host";

const directories: string[] = [];
const rootId = "019ed676-02fb-7000-8dac-396e2f84d484";
const originalDatabaseExec = Database.prototype.exec;
const originalDatabaseClose = Database.prototype.close;

const disposableDatabases = new Set<Database>();
const disposableHandles = new Set<FileHandle>();
const pendingCleanupOwners = new Set<AuthorityCleanupError>();
const pendingConstructionOwners = new Set<SqliteAuthorityConstructionError>();
const completedConstructionOwners = new WeakSet<SqliteAuthorityConstructionError>();
const restorers: Array<() => void> = [];
const releases = new Set<() => Promise<void>>();

function retain(error: unknown, seen = new Set<unknown>()): void {
	if (seen.has(error)) return;
	seen.add(error);
	if (error instanceof SqliteAuthorityConstructionError) {
		if (!completedConstructionOwners.has(error)) pendingConstructionOwners.add(error);
		return;
	}
	if (error instanceof AuthorityCleanupError) {
		if (error.pending) pendingCleanupOwners.add(error);
		return;
	}
	if (error instanceof AggregateError) for (const nested of error.errors) retain(nested, seen);
	if (error instanceof Error && error.cause !== undefined) retain(error.cause, seen);
}

function hasPendingCleanup(): boolean {
	return pendingCleanupOwners.size > 0 || pendingConstructionOwners.size > 0;
}

function openTrackedDriver(options: AuthorityDriverOptions): AuthorityPersistence {
	let driver: AuthorityPersistence;
	try {
		driver = persistenceModule.openAuthorityPersistence(options);
	} catch (error) {
		retain(error);
		throw error;
	}
	const close = driver.close.bind(driver);
	const release = async () => {
		close();
		releases.delete(release);
	};
	releases.add(release);
	return new Proxy(driver, {
		get(target, property) {
			if (property === "close")
				return () => {
					close();
					releases.delete(release);
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function retainFailures<T>(promise: Promise<T>): Promise<T> {
	return promise.catch(error => {
		retain(error);
		throw error;
	});
}

function useDriver<T>(driver: AuthorityPersistence, run: () => T): T {
	let result!: T;
	let primary: unknown;
	let failed = false;
	try {
		result = run();
	} catch (error) {
		retain(error);
		failed = true;
		primary = error;
	}
	try {
		driver.close();
	} catch (error) {
		retain(error);
		if (failed) throw new AggregateError([primary, error], "Driver use and cleanup failed.");
		throw error;
	}
	if (failed) throw primary;
	return result;
}

type Register = (name: string, run: () => Promise<void>, timeout?: number) => void;

function it(name: string, run: () => Promise<void>, timeout?: number, register: Register = bunIt): void {
	register(
		name,
		async () => {
			try {
				await run();
			} catch (error) {
				retain(error);
				throw error;
			}
		},
		timeout,
	);
}

// These cases pin real XFS root flock behaviour under os.tmpdir(); a host whose temp directory is not XFS skips them.
function itOnXfsTmpdir(name: string, run: () => Promise<void>, timeout?: number): void {
	it(name, run, timeout, bunIt.skipIf(!tmpdirOnXfs));
}

// Real migration, inspection and reopen with funded capacity take 3.4-6.7 s on the
// shared XFS host, past Bun's 5 s default while completing functionally.
const MIGRATION_REOPEN_TIMEOUT_MS = 30_000;

async function cleanupFixtures(): Promise<void> {
	const errors: unknown[] = [];
	for (const restore of restorers.splice(0).reverse()) {
		try {
			restore();
		} catch (error) {
			errors.push(error);
		}
	}
	Database.prototype.exec = originalDatabaseExec;
	Database.prototype.close = originalDatabaseClose;
	await disposeTrackedResources(errors);
}

async function disposeTrackedResources(errors: unknown[]): Promise<void> {
	for (const owner of pendingConstructionOwners) {
		try {
			owner.cleanup();
			completedConstructionOwners.add(owner);
			pendingConstructionOwners.delete(owner);
		} catch (error) {
			retain(error);
			errors.push(error);
		}
	}
	for (const owner of pendingCleanupOwners) {
		try {
			await owner.cleanup();
		} catch (error) {
			errors.push(error);
		}
		if (!owner.pending) pendingCleanupOwners.delete(owner);
	}
	if (!hasPendingCleanup()) {
		for (const release of releases) {
			try {
				await release();
				releases.delete(release);
			} catch (error) {
				retain(error);
				errors.push(error);
				if (hasPendingCleanup()) break;
			}
		}
	}
	if (!hasPendingCleanup() && releases.size === 0) {
		for (const database of disposableDatabases) {
			try {
				database.close();
				disposableDatabases.delete(database);
			} catch (error) {
				errors.push(error);
			}
		}
		for (const handle of disposableHandles) {
			try {
				await handle.close();
				disposableHandles.delete(handle);
			} catch (error) {
				errors.push(error);
			}
		}
	}
	if (
		errors.length === 0 &&
		!hasPendingCleanup() &&
		releases.size === 0 &&
		disposableDatabases.size === 0 &&
		disposableHandles.size === 0
	) {
		for (const directory of directories) {
			try {
				await fs.rm(directory, { recursive: true, force: true });
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 0) directories.length = 0;
	}
	if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed; owned artifacts were retained.");
}

afterEach(cleanupFixtures);

async function legacyFixture(): Promise<{ session: string; legacy: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-cleanup-migration-"));
	directories.push(directory);
	const session = path.join(directory, "root.jsonl");
	await fs.writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: rootId })}\n`);
	const legacy = registryDurableJournalPath(session);
	const store = new RegistryDurableStateStore(legacy);
	const generation = 1;
	const startupHash = canonicalDurableSha256("Main:startup");
	const provenanceHash = canonicalDurableSha256("Main:provenance");
	const headHash = canonicalDurableSha256({
		rootId: "Main",
		generation,
		actorId: "Main",
		startupHash,
		provenanceHash,
	});
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
	store.append({ kind: "root", at: 7, rootId: "Main", generation, headHash, state: "active" });
	return { session, legacy };
}

describe("private authority cleanup ownership", () => {
	it("disposes a directly failed SQLite fixture constructor after interrupted setup without removing its live artifacts", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-direct-constructor-cleanup-"));
		directories.push(directory);
		const databasePath = path.join(directory, "authority.sqlite");
		const markerPath = path.join(directory, "private-copy");
		await fs.writeFile(markerPath, "retain until physical close");
		const initFailure = new Error("direct fixture initialization failed");
		const firstCloseFailure = new Error("direct fixture constructor close failed before forwarding");
		const retryCloseFailure = new Error("distinct direct fixture close retry failed before forwarding");
		const interruption = new Error("fixture assertions interrupted after construction failed");
		const attempted: Database[] = [];
		let connected: Database | undefined;
		let failInit = true;
		Database.prototype.exec = new Proxy(originalDatabaseExec, {
			apply(target, database, args) {
				if (failInit && database instanceof Database) {
					failInit = false;
					connected = database;
					throw initFailure;
				}
				return Reflect.apply(target, database, args);
			},
		});
		Database.prototype.close = new Proxy(originalDatabaseClose, {
			apply(target, database, args) {
				if (database === connected) {
					attempted.push(database);
					throw attempted.length === 1 ? firstCloseFailure : retryCloseFailure;
				}
				return Reflect.apply(target, database, args);
			},
		});
		let caught: unknown;
		let interrupted: unknown;
		try {
			try {
				openTrackedDriver({
					path: databasePath,
					identity: { backend: "sqlite", owningSessionId: rootId, incarnation: "direct-fixture", format: 2 },
					create: true,
				});
			} catch (error) {
				caught = error;
			}
			throw interruption;
		} catch (error) {
			interrupted = error;
		}
		expect(interrupted).toBe(interruption);
		expect(caught).toBeInstanceOf(SqliteAuthorityConstructionError);
		if (!(caught instanceof SqliteAuthorityConstructionError) || !connected)
			throw new Error("Expected the actual connected constructor cleanup capability.");
		const database = connected;
		const owner = caught;
		expect(owner.constructionError).toBe(initFailure);
		expect(owner.cause).toBe(initFailure);
		expect(owner.errors).toEqual([initFailure, firstCloseFailure]);
		expect(database.query("SELECT 1 AS live").get()).toEqual({ live: 1 });
		const cleanup = owner.cleanup.bind(owner);
		const events: string[] = [];
		const cleanupSpy = spyOn(owner, "cleanup").mockImplementation(() => {
			events.push("cleanup-attempt");
			cleanup();
			expect(() => database.query("SELECT 1").get()).toThrow();
			events.push("physically-closed");
		});
		const restoreCleanupSpy = () => cleanupSpy.mockRestore();
		restorers.push(restoreCleanupSpy);
		const originalRemove = fs.rm;
		const removeSpy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (String(file) === directory) {
				expect(() => database.query("SELECT 1").get()).toThrow();
				events.push("directory-removal");
			}
			return originalRemove(file, options);
		});
		const restoreRemoveSpy = () => removeSpy.mockRestore();
		restorers.push(restoreRemoveSpy);
		let teardownFailure: unknown;
		try {
			await disposeTrackedResources([]);
		} catch (error) {
			teardownFailure = error;
		}
		expect(teardownFailure).toBeInstanceOf(AggregateError);
		expect((teardownFailure as AggregateError).errors).toEqual([owner]);
		expect(owner.errors).toEqual([initFailure, firstCloseFailure, retryCloseFailure]);
		expect(owner.cleanupErrors).toEqual([firstCloseFailure, retryCloseFailure]);
		expect(attempted).toEqual([database, database]);
		expect(events).toEqual(["cleanup-attempt"]);
		expect(await fs.stat(databasePath)).toBeTruthy();
		expect(await fs.readFile(markerPath, "utf8")).toBe("retain until physical close");
		expect(database.query("SELECT 1 AS live").get()).toEqual({ live: 1 });
		// A fixture-use aggregate can carry the same constructor owner more than once.
		retain(new AggregateError([owner, owner], "Fixture use and cleanup failed.", { cause: owner }));
		// Exercise the real afterEach path: fault hooks are disarmed before retry.
		// Keep observation spies through that path without keeping either fault armed.
		restorers.splice(restorers.indexOf(restoreCleanupSpy), 1);
		restorers.splice(restorers.indexOf(restoreRemoveSpy), 1);
		try {
			await cleanupFixtures();
			expect(events).toEqual(["cleanup-attempt", "cleanup-attempt", "physically-closed", "directory-removal"]);
			expect(cleanupSpy).toHaveBeenCalledTimes(2);
			expect(await Bun.file(markerPath).exists()).toBe(false);
			expect(await Bun.file(databasePath).exists()).toBe(false);
			expect(() => database.query("SELECT 1").get()).toThrow();
			owner.cleanup();
			retain(owner);
			await cleanupFixtures();
			expect(cleanupSpy).toHaveBeenCalledTimes(3);
			expect(owner.errors).toEqual([initFailure, firstCloseFailure, retryCloseFailure]);
		} finally {
			cleanupSpy.mockRestore();
			removeSpy.mockRestore();
		}
	});

	it("retains the real SQLite handle and private artifact until the same cleanup owner retries successfully", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-private-cleanup-"));
		directories.push(directory);
		const databasePath = path.join(directory, "authority.sqlite");
		const markerPath = path.join(directory, "private-copy");
		const primary = new Error("inspection failed");
		const firstCloseFailure = new Error("injected close failure before forwarding");
		const distinctRemovalFailure = new Error("injected removal failure");
		const database = new Database(databasePath, { create: true });
		disposableDatabases.add(database);
		const handle = await fs.open(databasePath, "r");
		disposableHandles.add(handle);
		await fs.writeFile(markerPath, "private");
		let failPhysicalClose = true;
		let failRemoval = true;
		let closeForwards = 0;
		restorers.push(() => {
			failPhysicalClose = false;
			failRemoval = false;
		});
		const owner = new AuthorityCleanupError([primary], "Inspection and physical cleanup failed.", async () => {
			if (failPhysicalClose) {
				failPhysicalClose = false;
				throw firstCloseFailure;
			}
			closeForwards++;
			if (disposableDatabases.has(database)) {
				database.close();
				disposableDatabases.delete(database);
			}
			if (disposableHandles.has(handle)) {
				await handle.close();
				disposableHandles.delete(handle);
			}
		});
		pendingCleanupOwners.add(owner);
		owner.afterCleanup(async () => {
			if (failRemoval) {
				failRemoval = false;
				throw distinctRemovalFailure;
			}
			await fs.rm(markerPath, { force: true });
		});
		const releases: number[] = [];
		const callback = () =>
			withRetainedAuthorityCleanup(
				async () => {
					throw owner;
				},
				async () => {
					releases.push(1);
				},
			);
		let observed: unknown;
		try {
			await callback();
		} catch (error) {
			retain(error);
			observed = error;
		}
		expect(observed).toBe(owner);
		expect(owner.cause).toBe(primary);
		expect(releases).toEqual([]);
		expect(owner.pending).toBe(true);
		expect(await fs.stat(databasePath)).toBeTruthy();
		expect(await fs.readFile(markerPath, "utf8")).toBe("private");
		const other = await fs.open(databasePath, "r+");
		disposableHandles.add(other);
		await expect(other.close()).resolves.toBeUndefined();
		disposableHandles.delete(other);
		await expect(owner.cleanup()).rejects.toBe(owner);
		expect(owner.errors).toEqual([primary, firstCloseFailure]);
		expect(closeForwards).toBe(0);
		expect(await fs.readFile(markerPath, "utf8")).toBe("private");
		await expect(owner.cleanup()).rejects.toBe(owner);
		expect(owner.errors).toEqual([primary, firstCloseFailure, distinctRemovalFailure]);
		expect(closeForwards).toBe(1);
		expect(owner.pending).toBe(true);
		await owner.cleanup();
		expect(releases).toEqual([1]);
		expect(owner.pending).toBe(false);
		expect(closeForwards).toBe(1);
		expect(await Bun.file(markerPath).exists()).toBe(false);
		await owner.cleanup();
		expect(releases).toEqual([1]);
	});

	it("coalesces concurrent cleanup retries and preserves each release result", async () => {
		const order: string[] = [];
		const { promise: gate, resolve: finish } = Promise.withResolvers<void>();
		const owner = new AuthorityCleanupError([new Error("primary")], "cleanup", async () => {
			order.push("physical-start");
			await gate;
			order.push("physical-done");
		});
		pendingCleanupOwners.add(owner);
		restorers.push(finish);
		owner.afterCleanup(async () => {
			order.push("release-one");
		});
		owner.afterCleanup(async () => {
			order.push("release-two");
		});
		const first = owner.cleanup();
		const second = owner.cleanup();
		expect(first).toBe(second);
		finish();
		await Promise.all([first, second]);
		expect(order).toEqual(["physical-start", "physical-done", "release-one", "release-two"]);
		expect(owner.pending).toBe(false);
	});
	itOnXfsTmpdir("retains real XFS root flock until the same cleanup owner releases it", async () => {
		expect(os.platform()).toBe("linux");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-flock-cleanup-"));
		directories.push(directory);
		const stat = await fs.statfs(directory);
		expect(Number(stat.type)).toBe(0x58465342);
		const session = path.join(directory, "root.jsonl");
		const owningSessionId = "019ed676-02fb-7000-8dac-396e2f84d484";
		await fs.writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: owningSessionId })}\n`);
		const dbPath = path.join(directory, "cleanup.sqlite");
		const database = new Database(dbPath, { create: true });
		disposableDatabases.add(database);
		let failFirst = true;
		restorers.push(() => {
			failFirst = false;
		});
		const owner = new AuthorityCleanupError([new Error("inspection failed")], "cleanup pending", async () => {
			if (failFirst) {
				failFirst = false;
				throw new Error("retry this physical close");
			}
			database.close();
			disposableDatabases.delete(database);
		});
		pendingCleanupOwners.add(owner);
		let observed: unknown;
		try {
			await withAuthorityExclusive(
				session,
				async () => {
					throw owner;
				},
				{ owningSessionId, create: true },
			);
		} catch (error) {
			retain(error);
			observed = error;
		}
		expect(observed).toBe(owner);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId })),
		).rejects.toThrow(/ownership|lock/i);
		await expect(owner.cleanup()).rejects.toBe(owner);
		await owner.cleanup();
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => true, { owningSessionId })),
		).resolves.toBe(true);
	});
	it("retains staged migration and source bytes across a real FileHandle close retry", async () => {
		const { session, legacy } = await legacyFixture();
		const sourceBefore = await fs.readFile(legacy);
		const failure = new Error("injected FileHandle close failure before forwarding");
		const originalOpen = fs.open;
		let didInject = false;
		let closeForwards = 0;
		let injectClose = true;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await originalOpen(file, flags, mode);
			if (
				didInject ||
				!String(file).includes(".authority.stage.") ||
				path.basename(String(file)) !== path.basename(authorityPaths(session).sqlite)
			)
				return handle;
			disposableHandles.add(handle);
			didInject = true;
			const close = handle.close.bind(handle);
			Object.defineProperty(handle, "close", {
				configurable: true,
				value: async () => {
					closeForwards++;
					if (injectClose) {
						injectClose = false;
						throw failure;
					}
					await close();
					disposableHandles.delete(handle);
				},
			});
			return handle;
		});
		restorers.push(() => {
			injectClose = false;
			openSpy.mockRestore();
		});
		let caught: unknown;
		try {
			await migrateAuthority(session, "sqlite", { apply: true });
		} catch (error) {
			retain(error);
			caught = error;
		}
		openSpy.mockRestore();
		expect(didInject).toBe(true);
		expect(caught).toBeInstanceOf(AuthorityCleanupError);
		if (!(caught instanceof AuthorityCleanupError)) throw new Error("Expected retained staged-file cleanup owner.");
		expect(caught.errors).toEqual([failure]);
		expect(caught.cause).toBe(failure);
		const names = await fs.readdir(path.dirname(session));
		const stages = names.filter(name => name.startsWith(`${path.basename(session)}.authority.stage.`));
		expect(stages.length).toBe(1);
		expect(await fs.readFile(legacy)).toEqual(sourceBefore);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		const nestedAttempt = FileLock.tryAcquire(legacy);
		const nestedAttemptAcquired = nestedAttempt.acquired;
		if (nestedAttemptAcquired) {
			const release = async () => nestedAttempt.release();
			releases.add(release);
			await release();
			releases.delete(release);
		}
		expect(nestedAttemptAcquired).toBe(false);
		await caught.cleanup();
		const releasedNestedLock = FileLock.tryAcquire(legacy);
		const releasedNestedLockAcquired = releasedNestedLock.acquired;
		if (releasedNestedLockAcquired) {
			const release = async () => releasedNestedLock.release();
			releases.add(release);
			await release();
			releases.delete(release);
		}
		expect(releasedNestedLockAcquired).toBe(true);
		expect(closeForwards).toBe(2);
		expect(await fs.readFile(legacy)).toEqual(sourceBefore);
		await recoverAuthorityMigration(session, "finish");
		const descriptor = await readAuthorityDescriptor(session);
		expect(descriptor?.backend).toBe("sqlite");
		expect(caught.errors).toContain(failure);
		const driver = openTrackedDriver({
			path: path.join(path.dirname(session), descriptor!.payload),
			identity: {
				backend: descriptor!.backend,
				owningSessionId: descriptor!.owningSessionId,
				incarnation: descriptor!.incarnation,
				format: 2,
			},
			create: false,
		});
		useDriver(driver, () => {
			driver.integrityCheck();
			expect(driver.exportState().rows.length).toBeGreaterThan(0);
		});
	});
	it(
		"preserves inspection, real driver-close, and removal failures until migration can reopen",
		async () => {
			const { session, legacy } = await legacyFixture();
			const initialMigration = await migrateAuthority(session, "sqlite", { apply: true });
			expect(initialMigration.status).toBe("migrated");
			const durable = await registryDurableStateForSession(session, { owningSessionId: rootId });
			const releaseDurable = async () => {
				await durable.close();
				releases.delete(releaseDurable);
			};
			releases.add(releaseDurable);
			let durableFailure: unknown;
			let durableFailed = false;
			try {
				const construction = {
					kind: "construction" as const,
					at: 10,
					actorId: "Evidence",
					rootId: "Evidence",
					generation: 2,
					startupHash: canonicalDurableSha256("Evidence:startup"),
					provenanceHash: canonicalDurableSha256("Evidence:provenance"),
				};
				await durable.transitionBatch(
					[
						{ ...construction, phase: "reserved" },
						{ ...construction, at: 11, phase: "constructing" },
						{ ...construction, at: 12, phase: "constructed" },
					],
					{ requestId: "evidence-root-construction" },
				);
				const headHash = canonicalDurableSha256({
					rootId: construction.rootId,
					generation: construction.generation,
					actorId: construction.actorId,
					startupHash: construction.startupHash,
					provenanceHash: construction.provenanceHash,
				});
				await durable.activateAuthority(
					{
						root: { kind: "root", at: 13, rootId: "Evidence", generation: 2, headHash, state: "active" },
						actor: {
							kind: "actor",
							at: 13,
							actorId: "Evidence",
							rootId: "Evidence",
							generation: 2,
							rootGeneration: 2,
							rootHeadHash: headHash,
							startupHash: construction.startupHash,
							provenanceHash: construction.provenanceHash,
							state: "active",
						},
						construction: { ...construction, at: 13, phase: "activated" },
						gate: { kind: "gate", at: 13, rootId: "Evidence", generation: 2, phase: "open" },
					},
					{ requestId: "evidence-root-activation" },
				);
				const claim = await durable.reserveLocal(
					{
						localId: "publication",
						entryId: "first",
						entryHash: canonicalDurableSha256("published source"),
						expectedHeadHash: durableGenesisHash(),
					},
					{ requestId: "historical-claim" },
				);
				await durable.authorizeLocalEffect(claim, { requestId: "historical-authorization" });
				await durable.finalizeLocal({ ...claim, phase: "effect" }, "committed", {
					requestId: "historical-publication",
				});
			} catch (error) {
				retain(error);
				durableFailed = true;
				durableFailure = error;
			}
			try {
				await releaseDurable();
			} catch (error) {
				retain(error);
				if (durableFailed) throw new AggregateError([durableFailure, error], "Durable fixture and cleanup failed.");
				throw error;
			}
			if (durableFailed) throw durableFailure;
			const selected = await readAuthorityDescriptor(session);
			if (!selected) throw new Error("Expected the SQLite source authority.");
			const sourcePath = path.join(path.dirname(session), selected.payload);
			const sourceBefore = await fs.readFile(sourcePath);
			const initial = openTrackedDriver({
				path: sourcePath,
				identity: {
					backend: selected.backend,
					owningSessionId: selected.owningSessionId,
					incarnation: selected.incarnation,
					format: 2,
				},
				create: false,
			});
			const expectedState = useDriver(initial, () => initial.exportState());
			const inspectionFailure = new Error("injected inspection failure");
			const closeFailure = new Error("injected physical driver close failure before forwarding");
			const removalFailure = new Error("injected inspection-copy removal failure");
			const originalFactory = persistenceModule.openAuthorityPersistence;
			const originalRemove = fs.rm;
			let failClose = true;
			let failRemoval = true;
			const cleanupEvents: string[] = [];
			restorers.push(() => {
				failClose = false;
				failRemoval = false;
			});
			const factorySpy = spyOn(persistenceModule, "openAuthorityPersistence").mockImplementation(options => {
				const driver = originalFactory(options);
				if (!options.path.includes(".authority-inspection-")) return driver;
				return new Proxy(driver, {
					get(target, property) {
						if (property === "integrityCheck")
							return () => {
								throw inspectionFailure;
							};
						if (property === "close")
							return () => {
								if (failClose) {
									failClose = false;
									throw closeFailure;
								}
								target.close();
								cleanupEvents.push("driver-closed");
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			});
			restorers.push(() => factorySpy.mockRestore());
			const removeSpy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
				if (String(file).includes(".authority-inspection-") && failRemoval) {
					cleanupEvents.push("removal-attempted");
					failRemoval = false;
					throw removalFailure;
				}
				await originalRemove(file, options);
			});
			restorers.push(() => removeSpy.mockRestore());
			let caught: unknown;
			try {
				await migrateAuthority(session, "jsonl", { apply: true });
			} catch (error) {
				retain(error);
				caught = error;
			}
			factorySpy.mockRestore();
			expect(caught).toBeInstanceOf(AuthorityCleanupError);
			if (!(caught instanceof AuthorityCleanupError))
				throw new Error("Expected retained inspection cleanup capability.");
			expect(caught.errors).toEqual([inspectionFailure, closeFailure]);
			expect(caught.cause).toBe(inspectionFailure);
			const inspectionNames = (await fs.readdir(path.dirname(session))).filter(name =>
				name.startsWith(".authority-inspection-"),
			);
			expect(inspectionNames.length).toBe(1);
			await expect(
				retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
			).rejects.toThrow(/ownership|lock/i);
			await expect(caught.cleanup()).rejects.toBe(caught);
			expect(cleanupEvents).toEqual(["driver-closed", "removal-attempted"]);
			removeSpy.mockRestore();
			expect(caught.errors).toEqual([inspectionFailure, closeFailure, removalFailure]);
			expect(await fs.readFile(sourcePath)).toEqual(sourceBefore);
			expect(await readAuthorityDescriptor(session)).toEqual(selected);
			const reopened = openTrackedDriver({
				path: sourcePath,
				identity: {
					backend: selected.backend,
					owningSessionId: selected.owningSessionId,
					incarnation: selected.incarnation,
					format: 2,
				},
				create: false,
			});
			useDriver(reopened, () => {
				reopened.integrityCheck();
				expect(reopened.exportState()).toEqual(expectedState);
			});
			await caught.cleanup();
			expect(caught.pending).toBe(false);
			expect(
				(await fs.readdir(path.dirname(session))).filter(name => name.startsWith(".authority-inspection-")).length,
			).toBe(0);
			const migration = await migrateAuthority(session, "jsonl", { apply: true });
			expect(migration.backupDirectory).toBeDefined();
			expect(await fs.readFile(path.join(migration.backupDirectory!, path.basename(sourcePath)))).toEqual(
				sourceBefore,
			);
			const migrated = await readAuthorityDescriptor(session);
			expect(migrated?.backend).toBe("jsonl");
			const restored = openTrackedDriver({
				path: path.join(path.dirname(session), migrated!.payload),
				identity: {
					backend: migrated!.backend,
					owningSessionId: migrated!.owningSessionId,
					incarnation: migrated!.incarnation,
					format: 2,
				},
				create: false,
			});
			useDriver(restored, () => {
				restored.integrityCheck();
				const actual = restored.exportState();
				expect(actual.rows).toEqual(expectedState.rows);
				expect(actual.controls).toEqual(expectedState.controls);
				expect(actual.frames).toEqual(expectedState.frames);
			});
			expect(await fs.readFile(legacy)).not.toEqual(Buffer.alloc(0));
		},
		MIGRATION_REOPEN_TIMEOUT_MS,
	);
	it("propagates pending staged inspection cleanup without replacing the target", async () => {
		const { session, legacy } = await legacyFixture();
		await migrateAuthority(session, "sqlite", { apply: true });
		const sourceDescriptor = await readAuthorityDescriptor(session);
		if (!sourceDescriptor || sourceDescriptor.backend !== "sqlite")
			throw new Error("Expected a selected SQLite source authority.");
		const sourcePath = path.join(path.dirname(session), sourceDescriptor.payload);
		const sourceBytes = await fs.readFile(sourcePath);
		const sourceDriver = openTrackedDriver({
			path: sourcePath,
			identity: {
				backend: sourceDescriptor.backend,
				owningSessionId: sourceDescriptor.owningSessionId,
				incarnation: sourceDescriptor.incarnation,
				format: 2,
			},
			create: false,
		});
		const expectedState = useDriver(sourceDriver, () => sourceDriver.exportState());
		await expect(
			retainFailures(migrateAuthority(session, "jsonl", { apply: true, faultAt: "target-staged" })),
		).rejects.toThrow("Injected migration fault at target-staged.");
		const names = await fs.readdir(path.dirname(session));
		const stageName = names.find(name => name.startsWith(`${path.basename(session)}.authority.stage.`));
		const manifestName = names.find(
			name => name.startsWith(`${path.basename(session)}.authority.migration.`) && name.endsWith(".json"),
		);
		if (!stageName || !manifestName) throw new Error("Expected the faulted migration stage and manifest.");
		const stagePath = path.join(path.dirname(session), stageName, path.basename(authorityPaths(session).jsonl));
		const stageBytes = await fs.readFile(stagePath);
		const stageIdentity = await fs.stat(stagePath);
		const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(session), manifestName), "utf8")) as {
			backupName: string;
		};
		const frozenDescriptor = await readAuthorityDescriptor(session);
		const closeFailure = new Error("injected staged inspection handle close failure");
		const originalOpen = fs.open;
		let stageHandle: FileHandle | undefined;
		let failClose = true;
		let realCloseForwards = 0;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await originalOpen(file, flags, mode);
			if (String(file) !== stagePath) return handle;
			disposableHandles.add(handle);
			stageHandle = handle;
			const close = handle.close.bind(handle);
			Object.defineProperty(handle, "close", {
				configurable: true,
				value: async () => {
					if (failClose) {
						failClose = false;
						throw closeFailure;
					}
					realCloseForwards++;
					await close();
					disposableHandles.delete(handle);
				},
			});
			return handle;
		});
		restorers.push(() => {
			failClose = false;
			openSpy.mockRestore();
		});
		let caught: unknown;
		try {
			await recoverAuthorityMigration(session, "finish");
		} catch (error) {
			retain(error);
			caught = error;
		}
		openSpy.mockRestore();
		expect(caught).toBeInstanceOf(AuthorityCleanupError);
		if (!(caught instanceof AuthorityCleanupError)) throw new Error("Expected retained staged inspection cleanup.");
		expect(caught.errors).toEqual([closeFailure]);
		expect(stageHandle).toBeDefined();
		expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
		expect(await fs.readFile(stagePath)).toEqual(stageBytes);
		expect((await fs.stat(stagePath)).ino).toBe(stageIdentity.ino);
		expect(await readAuthorityDescriptor(session)).toEqual(frozenDescriptor);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		const nestedAttempt = FileLock.tryAcquire(legacy);
		const nestedAttemptAcquired = nestedAttempt.acquired;
		if (nestedAttemptAcquired) {
			const release = async () => nestedAttempt.release();
			releases.add(release);
			await release();
			releases.delete(release);
		}
		expect(nestedAttemptAcquired).toBe(false);
		await caught.cleanup();
		expect(caught.pending).toBe(false);
		expect(realCloseForwards).toBe(1);
		expect(await fs.readFile(stagePath)).toEqual(stageBytes);
		const releasedNestedLock = FileLock.tryAcquire(legacy);
		const releasedNestedLockAcquired = releasedNestedLock.acquired;
		if (releasedNestedLockAcquired) {
			const release = async () => releasedNestedLock.release();
			releases.add(release);
			await release();
			releases.delete(release);
		}
		expect(releasedNestedLockAcquired).toBe(true);
		await recoverAuthorityMigration(session, "finish");
		const migrated = await readAuthorityDescriptor(session);
		expect(migrated?.backend).toBe("jsonl");
		const backupPath = path.join(path.dirname(session), manifest.backupName, path.basename(sourcePath));
		expect(await fs.readFile(backupPath)).toEqual(sourceBytes);
		const restored = openTrackedDriver({
			path: path.join(path.dirname(session), migrated!.payload),
			identity: {
				backend: migrated!.backend,
				owningSessionId: migrated!.owningSessionId,
				incarnation: migrated!.incarnation,
				format: 2,
			},
			create: false,
		});
		useDriver(restored, () => {
			restored.integrityCheck();
			const actual = restored.exportState();
			expect(actual.rows).toEqual(expectedState.rows);
			expect(actual.controls).toEqual(expectedState.controls);
			expect(actual.frames).toEqual(expectedState.frames);
		});
	});
	it("composes every concurrent SQLite source capture cleanup before releasing ownership", async () => {
		const { session } = await legacyFixture();
		await migrateAuthority(session, "sqlite", { apply: true });
		const selected = await readAuthorityDescriptor(session);
		if (!selected || selected.backend !== "sqlite") throw new Error("Expected a selected SQLite source authority.");
		const sourcePath = path.join(path.dirname(session), selected.payload);
		const sourceDriver = openTrackedDriver({
			path: sourcePath,
			identity: {
				backend: selected.backend,
				owningSessionId: selected.owningSessionId,
				incarnation: selected.incarnation,
				format: 2,
			},
			create: false,
		});
		const expectedState = useDriver(sourceDriver, () => sourceDriver.exportState());
		const walDatabase = new Database(sourcePath);
		disposableDatabases.add(walDatabase);
		walDatabase.exec("PRAGMA journal_mode=WAL");
		walDatabase.exec("PRAGMA user_version = 4");
		const capturePaths = [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`];
		const captureBytes = new Map<string, Buffer>();
		for (const file of capturePaths) captureBytes.set(file, await fs.readFile(file));
		const closeFailures = new Map(
			capturePaths.map((file, index) => [file, new Error(`injected capture close failure ${index}`)] as const),
		);
		const closeReached = new Map(capturePaths.map(file => [file, Promise.withResolvers<void>()] as const));
		const capturedHandles = new Map<string, FileHandle>();
		const originalDescriptors = new Map<string, number>();
		const forwardedCloses = new Set<string>();
		const originalOpen = fs.open;
		let injectCaptureFailures = true;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await originalOpen(file, flags, mode);
			const name = String(file);
			if (!closeFailures.has(name)) return handle;
			disposableHandles.add(handle);
			capturedHandles.set(name, handle);
			originalDescriptors.set(name, handle.fd);
			let failed = false;
			const close = handle.close.bind(handle);
			Object.defineProperty(handle, "close", {
				configurable: true,
				value: async () => {
					closeReached.get(name)!.resolve();
					if (injectCaptureFailures && !failed) {
						failed = true;
						throw closeFailures.get(name);
					}
					forwardedCloses.add(name);
					await close();
					disposableHandles.delete(handle);
				},
			});
			return handle;
		});
		restorers.push(() => {
			injectCaptureFailures = false;
			openSpy.mockRestore();
		});
		let caught: unknown;
		try {
			await migrateAuthority(session, "jsonl", { apply: true });
		} catch (error) {
			retain(error);
			caught = error;
		}
		openSpy.mockRestore();
		expect(caught).toBeInstanceOf(AuthorityCleanupError);
		if (!(caught instanceof AuthorityCleanupError))
			throw new Error("Expected one retained owner for SQLite capture cleanup.");
		expect(await readAuthorityDescriptor(session)).toEqual(selected);
		await Promise.all([...closeReached.values()].map(result => result.promise));
		expect(capturedHandles.size).toBe(3);
		expect([...originalDescriptors.values()].every(fd => fd >= 0)).toBe(true);
		for (const failure of closeFailures.values()) expect(caught.errors).toContain(failure);
		expect(caught.cause).toBe(closeFailures.get(sourcePath));
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		for (const [file, bytes] of captureBytes) expect<Buffer<ArrayBufferLike>>(await fs.readFile(file)).toEqual(bytes);
		await caught.cleanup();
		expect(caught.pending).toBe(false);
		expect([...forwardedCloses].sort()).toEqual([...capturePaths].sort());
		for (const [file, bytes] of captureBytes) expect<Buffer<ArrayBufferLike>>(await fs.readFile(file)).toEqual(bytes);
		walDatabase.close();
		disposableDatabases.delete(walDatabase);
		const sourceAfterClose = await fs.readFile(sourcePath);
		const migration = await migrateAuthority(session, "jsonl", { apply: true });
		expect(migration.backupDirectory).toBeDefined();
		expect(await fs.readFile(path.join(migration.backupDirectory!, path.basename(sourcePath)))).toEqual(
			sourceAfterClose,
		);
		const migrated = await readAuthorityDescriptor(session);
		if (!migrated) throw new Error("Expected the migrated authority descriptor.");
		const restored = openTrackedDriver({
			path: path.join(path.dirname(session), migrated.payload),
			identity: {
				backend: migrated.backend,
				owningSessionId: migrated.owningSessionId,
				incarnation: migrated.incarnation,
				format: 2,
			},
			create: false,
		});
		useDriver(restored, () => {
			restored.integrityCheck();
			const actual = restored.exportState();
			expect(actual.rows).toEqual(expectedState.rows);
			expect(actual.controls).toEqual(expectedState.controls);
			expect(actual.frames).toEqual(expectedState.frames);
		});
	});
	itOnXfsTmpdir("closes nested header cleanup before releasing the transcript flock", async () => {
		expect(os.platform()).toBe("linux");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-nested-cleanup-"));
		directories.push(directory);
		expect(Number((await fs.statfs(directory)).type)).toBe(0x58465342);
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: rootId })}\n`);
		const headerFailure = new Error("injected nested header close failure");
		const transcriptFailure = new Error("injected outer transcript close failure");
		const events: string[] = [];
		let sessionOpens = 0;
		let headerHandle: FileHandle | undefined;
		let transcriptHandle: FileHandle | undefined;
		let failHeaderClose = true;
		let failTranscriptClose = true;
		const originalOpen = fs.open;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await originalOpen(file, flags, mode);
			if (String(file) !== session) return handle;
			sessionOpens++;
			if (sessionOpens === 2) {
				disposableHandles.add(handle);
				transcriptHandle = handle;
				const close = handle.close.bind(handle);
				Object.defineProperty(handle, "close", {
					configurable: true,
					value: async () => {
						if (failTranscriptClose) {
							failTranscriptClose = false;
							events.push("transcript-close-failed");
							throw transcriptFailure;
						}
						events.push("transcript-close-forwarded");
						await close();
						disposableHandles.delete(handle);
					},
				});
			}
			if (sessionOpens === 3) {
				disposableHandles.add(handle);
				headerHandle = handle;
				const close = handle.close.bind(handle);
				Object.defineProperty(handle, "close", {
					configurable: true,
					value: async () => {
						if (failHeaderClose) {
							failHeaderClose = false;
							events.push("header-close-failed");
							throw headerFailure;
						}
						events.push("header-close-forwarded");
						await close();
						disposableHandles.delete(handle);
					},
				});
			}
			return handle;
		});
		restorers.push(() => {
			failHeaderClose = false;
			failTranscriptClose = false;
			openSpy.mockRestore();
		});
		let caught: unknown;
		try {
			const acquired = await acquireAuthorityOwnership(session, { owningSessionId: rootId, create: true });
			releases.add(() => acquired.release());
		} catch (error) {
			retain(error);
			caught = error;
		}
		openSpy.mockRestore();
		expect(caught).toBeInstanceOf(AuthorityCleanupError);
		if (!(caught instanceof AuthorityCleanupError)) throw new Error("Expected the nested header cleanup owner.");
		expect(headerHandle).toBeDefined();
		expect(transcriptHandle).toBeDefined();
		expect(events).toEqual(["header-close-failed"]);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		await expect(caught.cleanup()).rejects.toBe(caught);
		expect(events).toEqual(["header-close-failed", "header-close-forwarded", "transcript-close-failed"]);
		expect(caught.errors).toContain(headerFailure);
		expect(caught.errors).toContain(transcriptFailure);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		await caught.cleanup();
		expect(caught.pending).toBe(false);
		expect(events).toEqual([
			"header-close-failed",
			"header-close-forwarded",
			"transcript-close-failed",
			"transcript-close-forwarded",
		]);
		const recovered = await acquireAuthorityOwnership(session, { owningSessionId: rootId, create: true });
		const releaseRecovered = () => recovered.release();
		releases.add(releaseRecovered);
		await releaseRecovered();
		releases.delete(releaseRecovered);
	});
	itOnXfsTmpdir("finishes nested anchor-directory cleanup before releasing outer root locks", async () => {
		expect(os.platform()).toBe("linux");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-nested-anchor-cleanup-"));
		directories.push(directory);
		expect(Number((await fs.statfs(directory)).type)).toBe(0x58465342);
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: rootId })}\n`);
		const directoryFailure = new Error("injected anchor-directory close failure");
		const anchorFailure = new Error("injected outer anchor close failure");
		const events: string[] = [];
		let sessionOpens = 0;
		let directoryHandle: FileHandle | undefined;
		let anchorHandle: FileHandle | undefined;
		let failDirectoryClose = true;
		let failAnchorClose = true;
		const originalOpen = fs.open;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await originalOpen(file, flags, mode);
			if (String(file) === session) sessionOpens++;
			if (String(file) === path.dirname(session)) {
				disposableHandles.add(handle);
				directoryHandle = handle;
				const close = handle.close.bind(handle);
				Object.defineProperty(handle, "close", {
					configurable: true,
					value: async () => {
						if (failDirectoryClose) {
							failDirectoryClose = false;
							events.push("directory-close-failed");
							throw directoryFailure;
						}
						events.push("directory-close-forwarded");
						await close();
						disposableHandles.delete(handle);
					},
				});
			}
			if (String(file) === authorityPaths(session).lock) {
				disposableHandles.add(handle);
				anchorHandle = handle;
				const close = handle.close.bind(handle);
				Object.defineProperty(handle, "close", {
					configurable: true,
					value: async () => {
						if (failAnchorClose) {
							failAnchorClose = false;
							events.push("anchor-close-failed");
							throw anchorFailure;
						}
						events.push("anchor-close-forwarded");
						await close();
						disposableHandles.delete(handle);
					},
				});
			}
			return handle;
		});
		restorers.push(() => {
			failDirectoryClose = false;
			failAnchorClose = false;
			openSpy.mockRestore();
		});
		let caught: unknown;
		try {
			const acquired = await acquireAuthorityOwnership(session, { owningSessionId: rootId, create: true });
			releases.add(() => acquired.release());
		} catch (error) {
			retain(error);
			caught = error;
		}
		openSpy.mockRestore();
		expect(caught).toBeInstanceOf(AuthorityCleanupError);
		if (!(caught instanceof AuthorityCleanupError))
			throw new Error("Expected the nested anchor-directory cleanup owner.");
		expect(sessionOpens).toBeGreaterThanOrEqual(3);
		expect(directoryHandle).toBeDefined();
		expect(anchorHandle).toBeDefined();
		expect(events).toEqual(["directory-close-failed"]);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		await expect(caught.cleanup()).rejects.toBe(caught);
		expect(events).toEqual(["directory-close-failed", "directory-close-forwarded", "anchor-close-failed"]);
		expect(caught.errors).toContain(directoryFailure);
		expect(caught.errors).toContain(anchorFailure);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		await caught.cleanup();
		expect(caught.pending).toBe(false);
		expect(events).toEqual([
			"directory-close-failed",
			"directory-close-forwarded",
			"anchor-close-failed",
			"anchor-close-forwarded",
		]);
		const recovered = await acquireAuthorityOwnership(session, { owningSessionId: rootId, create: true });
		const releaseRecovered = () => recovered.release();
		releases.add(releaseRecovered);
		await releaseRecovered();
		releases.delete(releaseRecovered);
	});
	itOnXfsTmpdir("retains partial anchor cleanup and never flocks a reused descriptor", async () => {
		expect(os.platform()).toBe("linux");
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-reused-fd-cleanup-"));
		directories.push(directory);
		expect(Number((await fs.statfs(directory)).type)).toBe(0x58465342);
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: rootId })}\n`);
		const closeFailure = new Error("injected anchor close failure before forwarding");
		const originalOpen = fs.open;
		let anchor: FileHandle | undefined;
		let anchorDescriptor = -1;
		let faultedFlock = false;
		let closeCalls = 0;
		let realCloseForwards = 0;
		let injectClose = true;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await originalOpen(file, flags, mode);
			if (String(file) !== authorityPaths(session).lock) return handle;
			disposableHandles.add(handle);
			anchor = handle;
			anchorDescriptor = handle.fd;
			const originalFd = Object.getOwnPropertyDescriptor(handle, "fd");
			Object.defineProperty(handle, "fd", {
				configurable: true,
				get: () => {
					if (!faultedFlock) {
						faultedFlock = true;
						if (originalFd) Object.defineProperty(handle, "fd", originalFd);
						else Reflect.deleteProperty(handle, "fd");
						return -1;
					}
					return anchorDescriptor;
				},
			});
			const close = handle.close.bind(handle);
			Object.defineProperty(handle, "close", {
				configurable: true,
				value: async () => {
					closeCalls++;
					if (injectClose) {
						injectClose = false;
						throw closeFailure;
					}
					realCloseForwards++;
					await close();
					disposableHandles.delete(handle);
				},
			});
			return handle;
		});
		restorers.push(() => {
			injectClose = false;
			openSpy.mockRestore();
		});
		let caught: unknown;
		try {
			const acquired = await acquireAuthorityOwnership(session, { owningSessionId: rootId, create: true });
			releases.add(() => acquired.release());
		} catch (error) {
			retain(error);
			caught = error;
		}
		openSpy.mockRestore();
		expect(anchor).toBeDefined();
		expect(anchorDescriptor).toBeGreaterThanOrEqual(0);
		expect(faultedFlock).toBe(true);
		expect(caught).toBeInstanceOf(AuthorityCleanupError);
		if (!(caught instanceof AuthorityCleanupError)) throw new Error("Expected retained partial anchor cleanup.");
		expect(caught.errors).toHaveLength(2);
		expect((caught.errors[0] as Error).message).toMatch(/Unable to acquire authority filesystem flock/);
		expect(caught.errors[1]).toBe(closeFailure);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		await caught.cleanup();
		expect(caught.pending).toBe(false);
		expect(closeCalls).toBe(2);
		expect(realCloseForwards).toBe(1);
		const recovered = await acquireAuthorityOwnership(session, { owningSessionId: rootId, create: true });
		const releaseRecovered = () => recovered.release();
		releases.add(releaseRecovered);
		await releaseRecovered();
		releases.delete(releaseRecovered);
		const originalDescriptorPath = path.join(directory, "reused-descriptor");
		let blocker: FileHandle | undefined;
		let blockerPath = "";
		for (let index = 0; index <= anchorDescriptor && !blocker; index++) {
			const candidatePath = `${originalDescriptorPath}-${index}`;
			const candidate = await originalOpen(candidatePath, "w+");
			disposableHandles.add(candidate);
			if (candidate.fd === anchorDescriptor) {
				blocker = candidate;
				blockerPath = candidatePath;
			}
		}
		if (!blocker) throw new Error("Could not reuse the retained anchor's original numeric descriptor.");
		const libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
		restorers.push(() => libc.close());
		const LOCK_EX = 2;
		const LOCK_NB = 4;
		expect(libc.symbols.flock(blocker.fd, LOCK_EX | LOCK_NB)).toBe(0);
		await caught.cleanup();
		const probe = await originalOpen(blockerPath, "r+");
		disposableHandles.add(probe);
		expect((await probe.stat()).ino).toBe((await blocker.stat()).ino);
		const probeResult = libc.symbols.flock(probe.fd, LOCK_EX | LOCK_NB);
		expect(probeResult).not.toBe(0);
	});
	it("adopts the real failed-constructor cleanup owner through migration exclusion", async () => {
		const { session, legacy } = await legacyFixture();
		const sourceBefore = await fs.readFile(legacy);
		const initFailure = new Error("injected SQLite staged initialization failure");
		const closeFailure = new Error("injected SQLite constructor close failure before forwarding");
		const originalExec = Database.prototype.exec;
		const originalClose = Database.prototype.close;
		const attempted: Database[] = [];
		const physicallyClosed: Database[] = [];
		let failInit = true;
		let failClose = true;
		Database.prototype.exec = new Proxy(originalExec, {
			apply(target, database, args) {
				if (failInit) {
					failInit = false;
					throw initFailure;
				}
				return Reflect.apply(target, database, args);
			},
		});
		Database.prototype.close = new Proxy(originalClose, {
			apply(target, database, args) {
				if (database instanceof Database) attempted.push(database);
				if (failClose) {
					failClose = false;
					throw closeFailure;
				}
				const result = Reflect.apply(target, database, args);
				if (database instanceof Database) physicallyClosed.push(database);
				return result;
			},
		});
		let caught: unknown;
		try {
			await migrateAuthority(session, "sqlite", { apply: true });
		} catch (error) {
			retain(error);
			caught = error;
		}
		Database.prototype.exec = originalExec;
		expect(caught).toBeInstanceOf(AuthorityCleanupError);
		if (!(caught instanceof AuthorityCleanupError)) {
			Database.prototype.close = originalClose;
			throw new Error("Expected the migration to retain failed SQLite constructor cleanup.");
		}
		expect(caught.errors).toEqual([initFailure, closeFailure]);
		expect(caught.cause).toBe(initFailure);
		const names = await fs.readdir(path.dirname(session));
		const stageName = names.find(name => name.startsWith(`${path.basename(session)}.authority.stage.`));
		expect(stageName).toBeDefined();
		expect(
			await fs.stat(path.join(path.dirname(session), stageName!, path.basename(authorityPaths(session).sqlite))),
		).toBeTruthy();
		expect(await fs.readFile(legacy)).toEqual(sourceBefore);
		await expect(
			retainFailures(withAuthorityExclusive(session, async () => undefined, { owningSessionId: rootId })),
		).rejects.toThrow(/ownership|lock/i);
		await caught.cleanup();
		for (const suffix of ["", "-wal", "-shm"])
			expect(
				await Bun.file(
					path.join(
						path.dirname(session),
						stageName!,
						`${path.basename(authorityPaths(session).sqlite)}${suffix}`,
					),
				).exists(),
			).toBe(false);
		Database.prototype.close = originalClose;
		expect(attempted).toHaveLength(2);
		expect(attempted[1]).toBe(attempted[0]);
		expect(physicallyClosed).toEqual([attempted[0]]);
		expect(await fs.readFile(legacy)).toEqual(sourceBefore);
		await recoverAuthorityMigration(session, "finish");
		const descriptor = await readAuthorityDescriptor(session);
		expect(descriptor?.backend).toBe("sqlite");
		const driver = openTrackedDriver({
			path: path.join(path.dirname(session), descriptor!.payload),
			identity: {
				backend: descriptor!.backend,
				owningSessionId: descriptor!.owningSessionId,
				incarnation: descriptor!.incarnation,
				format: 2,
			},
			create: false,
		});
		useDriver(driver, () => {
			driver.integrityCheck();
			expect(driver.exportState().rows.length).toBeGreaterThan(0);
		});
	});
});
