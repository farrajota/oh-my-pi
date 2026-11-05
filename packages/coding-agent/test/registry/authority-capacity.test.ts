import { constants, Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import {
	AuthorityCapacityAdmission,
	AuthorityCapacityDebtLedger,
	AuthorityCapacityRefusedError,
	authorityOwnerEpisodeDebt,
	authoritySqliteDatabaseArena,
	authoritySqliteOverflowPages,
	configureAuthoritySqliteCapacity,
} from "../../src/registry/authority/capacity-sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	fundAuthorityCapacityTarget,
	inspectAuthorityCapacityTarget,
	openAuthorityCapacityFile,
	xfsTargetEnvelope,
} from "../../src/registry/authority/capacity";
import {
	AuthorityCapacityPoolError,
	BorrowedAuthorityCapacityPool,
} from "../../src/registry/authority/capacity-native";
import * as syncFs from "node:fs";
import { SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import {
	AuthorityContinuationTooLargeError,
	AuthorityEngine,
	authorityRequestBytes,
} from "../../src/registry/authority/engine";

import { durableRootHeadHash, type DurableRegistryRecord } from "../../src/registry/durable-state";
import { AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES } from "../../src/registry/authority/types";
import type { AuthorityCommand, AuthorityCommitFrame } from "../../src/registry/authority/types";
import { xfsCapacityHost } from "./authority-capacity-host";

// Cases that fund real XFS capacity under os.tmpdir(); see authority-capacity-host.ts for when a host qualifies.
const itOnXfs = it.skipIf(!xfsCapacityHost);

const CONTINUATION = AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES;
const ADMISSION = 2_097_152;
// Well below the 8 MiB minimum arena slack: a funded arena leaves more allocation than this past EOF.
const ARENA_PROBE_BYTES = 1_048_576;

/** A requestId that makes `command` exactly `bytes` long as the engine measures a request; escaped quotes expand most. */
function requestIdFor(prefix: string, command: AuthorityCommand, bytes = CONTINUATION): string {
	const padding = bytes - authorityRequestBytes(command, { requestId: prefix });
	if (padding < 0) throw new Error("Request fixture is already larger than its target size");
	return prefix + '"'.repeat(Math.floor(padding / 2)) + (padding % 2 === 0 ? "" : "a");
}

/**
 * Sends a funded continuation one byte over the continuation bound, which must be refused before
 * acknowledgement with nothing written, then the maximal legal one, which must commit.
 */
function refuseOversizedThenContinue<T>(
	engine: AuthorityEngine,
	prefix: string,
	command: AuthorityCommand,
	run: (options: { requestId: string }) => T,
): T {
	const oversized = requestIdFor(prefix, command, CONTINUATION + 1);
	const revision = engine.recoveryState().revision;
	expect(() => run({ requestId: oversized })).toThrow(AuthorityContinuationTooLargeError);
	expect(engine.resolveReceipt(oversized)).toBeUndefined();
	expect(engine.recoveryState().revision).toBe(revision);
	return run({ requestId: requestIdFor(prefix, command) });
}
const directories: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function makeDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "authority-capacity-"));
	directories.push(directory);
	return directory;
}

function assertSqliteArena(
	filename: string,
	identity: { readonly fd: number; readonly device: bigint; readonly inode: bigint },
	database: Database,
): void {
	// Commits share the WAL between amortized resets, so run the checkpoint whose chunked DB truncate
	// could drop a funded suffix before asserting that the arena survived it.
	const checkpoint = database
		.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(PASSIVE)")
		.get();
	expect(checkpoint?.busy).toBe(0);
	expect(checkpoint?.checkpointed).toBe(checkpoint?.log);
	const descriptor = syncFs.openSync(filename, syncFs.constants.O_RDWR | syncFs.constants.O_NOFOLLOW);
	try {
		const size = syncFs.fstatSync(descriptor).size;
		const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
		if (pages === undefined || !Number.isSafeInteger(pages) || pages < 1)
			throw new Error("SQLite arena regression lost the current page count");
		expect(size).toBeGreaterThan(pages * 4_096);
		const domain = BorrowedAuthorityCapacityPool.open(identity).inspect();
		const certificate = inspectAuthorityCapacityTarget(descriptor, domain, size, size);
		expect(certificate.logicalBytes).toBe(size);
		expect(certificate.coveredBytes).toBeGreaterThanOrEqual(size);
	} finally {
		syncFs.closeSync(descriptor);
	}
}

describe("anonymous authority capacity backing", () => {
	it("retains an unlinked O_TMPFILE descriptor with exact inode identity", async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const stat = await capacity.handle.stat({ bigint: true });
		expect(await fs.readdir(directory)).toEqual([]);
		expect(capacity.identity).toEqual({ fd: capacity.handle.fd, device: stat.dev, inode: stat.ino });
	});
});
itOnXfs("funds and returns only a verified allocated EOF suffix", async () => {
	const directory = await makeDirectory();
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	const pool = BorrowedAuthorityCapacityPool.open(capacity.identity);
	const funded = pool.ensureDataBytes(4_096);
	expect(funded.dataBytes).toBeGreaterThanOrEqual(4_096);
	expect(funded.allocatedBytes).toBeGreaterThanOrEqual(4_096);
	const released = pool.releaseDataBytes(funded.dataBytes);
	expect(released.after.dataBytes).toBe(0);
	expect(released.releasedDataBytes).toBe(funded.dataBytes);
});

describe("SQLite statement journal capacity policy", () => {
	it("selects memory-backed statement journals only on an overridable TEMP_STORE build", () => {
		const database = new Database(":memory:");
		try {
			expect(configureAuthoritySqliteCapacity(database)).toBe(2);
			expect(database.query<{ temp_store: number }, []>("PRAGMA temp_store").get()?.temp_store).toBe(2);
		} finally {
			database.close(true);
		}
	});
});

describe("SQLite open-operation reserve", () => {
	it("prices an open operation at five v4 B-trees per future step, under a quarter of the v3 reserve", () => {
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const operation = {
			kind: "operation",
			at: 1,
			operationId: "toolu_reserve",
			effectClass: "mcp",
			ownerId: "owner",
			classOwnerId: "owner:mcp",
			actorId: "owner",
			rootId: "root",
			generation: 1,
			acquiredAt: 1,
			expiresAt: 10,
			phase: "intent",
		} satisfies DurableRegistryRecord;
		for (const height of [12, 17, 20]) {
			const pages =
				new AuthorityCapacityDebtLedger(identity, ADMISSION, [operation], undefined, [], height).currentDebt()
					.sqliteDatabaseBytes / 4_096;
			// The longest path (effect, committed, terminal) has three continuation steps. Each writes one frame row and
			// its receipt-index entry, the operation row and its open-index entry, and the meta control: five B-trees of
			// at most 4H+1 structural allocations each, plus the continuation option envelope.
			const options = Math.ceil((3 * CONTINUATION) / 4_092) + 3;
			expect(pages).toBe(3 * (5 * (4 * height + 1) + options));
			// Physical schema v3 touched 22 B-trees per step (dictionary rows and index, a separate receipt table with four
			// indexes, order-key autoindexes): 4,590 pages at height 17.
			expect(pages).toBeLessThan((3 * (22 * (4 * height + 1) + Math.ceil((2 * CONTINUATION) / 4_092) + 3)) / 4);
		}
	});
});

describe("SQLite completion capacity projection", () => {
	it("retains overflow thresholds and both generated DB/WAL terms as the episode is consumed", () => {
		expect(authoritySqliteOverflowPages(4_061, true)).toBe(0);
		expect(authoritySqliteOverflowPages(4_062, true)).toBe(1);
		expect(authoritySqliteOverflowPages(1_002, false)).toBe(0);
		expect(authoritySqliteOverflowPages(1_003, false)).toBe(1);
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const transition = {
			kind: "transition",
			at: 1,
			rootId: "r",
			transitionId: "t",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: "1".repeat(64),
			destinationHeadHash: "2".repeat(64),
			phase: "cas-committed",
		} satisfies DurableRegistryRecord;
		const cohort = new AuthorityCapacityDebtLedger(identity, ADMISSION, [transition]).currentDebt().sqliteCohort;
		// Two remaining commands: 20 native stable-population pages (2 x 5 inserted
		// cells: frame row, receipt index, transition row, open index, meta
		// control) plus 18 of the original 54 generated pages/frames, retained on BOTH sides.
		// Both remaining steps are continuations, so their options are priced at the continuation bound: 3x the
		// request (physical schema v4 frame rows also hold the requestId in their receipt column) plus 3 pages.
		expect(cohort?.options).toBe(2 * (Math.ceil((3 * CONTINUATION) / 4_092) + 3));
		expect(cohort?.reusable).toBe(38);
		expect(cohort!.retained - cohort!.options).toBe(38);
	});
});

describe("authority XFS target capacity envelope", () => {
	it("accounts exact independent DB, WAL, and SHM horizons plus quota workspace", () => {
		const envelope = xfsTargetEnvelope({ databaseBytes: 25_362_792, walBytes: 25_362_792, shmBytes: 32_768 });
		expect(envelope).toEqual({
			dataBlocks: 12_394,
			metadataBlocks: 140,
			workspaceBlocks: 36,
			totalBytes: 51_486_720,
		});
	});

	it("derives metadata from each actual horizon rather than a fixed multiplier", () => {
		const small = xfsTargetEnvelope({ databaseBytes: 4_096, walBytes: 0, shmBytes: 0 });
		const larger = xfsTargetEnvelope({ databaseBytes: 8_192, walBytes: 0, shmBytes: 0 });
		expect(small.dataBlocks).toBe(1);
		expect(larger.dataBlocks).toBe(2);
		expect(small.metadataBlocks).toBe(14);
		expect(larger.metadataBlocks).toBe(14);
		expect(small.workspaceBlocks).toBe(12);
		expect(larger.workspaceBlocks).toBe(12);
	});

	it("rejects non-safe horizons instead of converting them into guessed reserve bytes", () => {
		expect(() => xfsTargetEnvelope({ databaseBytes: Number.MAX_SAFE_INTEGER + 1, walBytes: 0, shmBytes: 0 })).toThrow(
			RangeError,
		);
		expect(() => xfsTargetEnvelope({ databaseBytes: -1, walBytes: 0, shmBytes: 0 })).toThrow(RangeError);
	});
});

describe("physical target funding", () => {
	itOnXfs("allocates private target coverage without changing EOF or existing bytes", async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const domain = BorrowedAuthorityCapacityPool.open(capacity.identity).inspect();
		const filename = path.join(directory, "target");
		const target = await fs.open(filename, "wx+", 0o600);
		handles.push(target);
		await target.write(Buffer.from("SQLite format 3\0"));
		const before = await target.stat({ bigint: true });
		const funded = fundAuthorityCapacityTarget(target.fd, domain, 13 * 4_096);
		expect(funded.coveredBytes).toBeGreaterThanOrEqual(13 * 4_096);
		expect(funded.device).toBe(before.dev);
		expect(funded.inode).toBe(before.ino);
		expect(funded.projectId).toBe(domain.projectId);
		expect((await target.stat()).size).toBe(Number(before.size));
		expect(await fs.readFile(filename)).toEqual(Buffer.from("SQLite format 3\0"));
		expect(inspectAuthorityCapacityTarget(target.fd, domain, funded.coveredBytes).coveredBytes).toBe(
			funded.coveredBytes,
		);
		expect(fundAuthorityCapacityTarget(target.fd, domain, funded.coveredBytes, funded)).toEqual(funded);
		await target.truncate(1);
		expect(() => fundAuthorityCapacityTarget(target.fd, domain, funded.coveredBytes, funded)).toThrow();
	});

	itOnXfs("does not certify a sparse logical prefix or a different allocation domain", async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const domain = BorrowedAuthorityCapacityPool.open(capacity.identity).inspect();
		const target = await fs.open(path.join(directory, "sparse"), "wx+", 0o600);
		handles.push(target);
		await target.truncate(4_096);
		expect(() => inspectAuthorityCapacityTarget(target.fd, domain, 4_096)).toThrow();
		expect(() =>
			fundAuthorityCapacityTarget(target.fd, { ...domain, projectId: domain.projectId + 1 }, 4_096),
		).toThrow();
		expect((await target.stat()).size).toBe(4_096);
	});

	itOnXfs("never credits reflink-shared target extents and unshares them when funding", async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const domain = BorrowedAuthorityCapacityPool.open(capacity.identity).inspect();
		const filename = path.join(directory, "shared");
		const content = Buffer.alloc(5 * 4_096, 7);
		await fs.writeFile(filename, content, { mode: 0o600 });
		// XFS copy_file_range reflinks, so the source's extents become shared.
		await fs.copyFile(filename, path.join(directory, "copy"));
		const target = await fs.open(filename, "r+");
		handles.push(target);
		expect(inspectAuthorityCapacityTarget(target.fd, domain, content.length, 0).coveredBytes).toBe(0);
		expect(() => inspectAuthorityCapacityTarget(target.fd, domain, content.length, content.length)).toThrow();
		const funded = fundAuthorityCapacityTarget(target.fd, domain, 8 * 4_096);
		expect(funded.coveredBytes).toBe(8 * 4_096);
		expect(inspectAuthorityCapacityTarget(target.fd, domain, funded.coveredBytes, content.length).coveredBytes).toBe(
			8 * 4_096,
		);
		expect(await fs.readFile(filename)).toEqual(content);
		expect(await fs.readFile(path.join(directory, "copy"))).toEqual(content);
	});
});

for (const backend of ["sqlite", "jsonl"] as const) {
	for (const errno of [28, 122, 5] as const) {
		itOnXfs(
			`${backend} reopen ${errno === 5 ? "keeps an unproved EIO growth failure uncertain" : `refuses before claim when growth hits errno ${errno}`}`,
			async () => {
				const directory = await makeDirectory();
				const capacity = await openAuthorityCapacityFile(directory);
				handles.push(capacity.handle);
				const filename = path.join(directory, `refused.${backend}`);
				const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
				const options = {
					path: filename,
					identity,
					create: false,
					capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
				};
				const open = (create: boolean, funded = true) => {
					const selected = funded ? { ...options, create } : { path: filename, identity, create };
					return backend === "sqlite"
						? new SqliteAuthorityPersistence(selected)
						: new JsonlAuthorityPersistence(selected);
				};
				const engine = new AuthorityEngine(open(true), "o".repeat(36));
				engine.recover();
				engine.close();
				const snapshot = (): unknown => {
					const reader = open(false, false);
					try {
						return reader.exportState();
					} finally {
						reader.close();
					}
				};
				const before = snapshot();
				// A reopening process starts from an empty reserve; drop any arena slack the first owner left.
				const drained = BorrowedAuthorityCapacityPool.open(capacity.identity);
				drained.releaseDataBytes(drained.inspect().dataBytes);
				const exhausted = Object.assign(new Error(`fallocate(mode 0) failed with Linux errno ${errno}`), {
					errno: -errno,
					code: `ERRNO_${errno}`,
				});
				const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
					throw new AuthorityCapacityPoolError(
						"Capacity growth may have partially changed the inode; reconcile before credit",
						"uncertain",
						undefined,
						exhausted,
					);
				});
				let refusal: unknown;
				try {
					try {
						new AuthorityEngine(open(false), "o".repeat(36)).recover();
					} catch (error) {
						refusal = error;
					}
					expect(growth).toHaveBeenCalled();
				} finally {
					growth.mockRestore();
				}
				if (errno === 5) {
					expect(refusal).toBeInstanceOf(AuthorityCapacityPoolError);
					expect(refusal).not.toBeInstanceOf(AuthorityCapacityRefusedError);
				} else {
					expect(refusal).toBeInstanceOf(AuthorityCapacityRefusedError);
					expect((refusal as Error).cause).toBeInstanceOf(AuthorityCapacityPoolError);
				}
				expect(snapshot()).toEqual(before);
				const reopened = new AuthorityEngine(open(false), "o".repeat(36));
				try {
					expect(reopened.recover().owner.phase).toBe("ready");
				} finally {
					reopened.close();
				}
			},
		);
	}

	itOnXfs(`${backend} owner reopens and continues its store after a reflink copy of it`, async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const filename = path.join(directory, `copied.${backend}`);
		const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
		const options = {
			path: filename,
			identity,
			capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
		};
		const open = (create: boolean) =>
			backend === "sqlite"
				? new SqliteAuthorityPersistence({ ...options, create })
				: new JsonlAuthorityPersistence({ ...options, create });
		const hash = "1".repeat(64);
		const record = {
			kind: "construction",
			at: 1,
			rootId: "r",
			actorId: "r",
			generation: 1,
			startupHash: hash,
			provenanceHash: hash,
			phase: "reserved",
		} satisfies DurableRegistryRecord;
		const engine = new AuthorityEngine(open(true), "o".repeat(36));
		expect(engine.recover().owner.phase).toBe("ready");
		engine.close();
		const copy = path.join(directory, `copy.${backend}`);
		await fs.copyFile(filename, copy);
		const copied = await fs.readFile(copy);
		const reopened = new AuthorityEngine(open(false), "o".repeat(36));
		try {
			expect(reopened.recover().owner.phase).toBe("ready");
			reopened.transition(record);
			expect(reopened.getConstruction("r", "r", 1)?.record.phase).toBe("reserved");
		} finally {
			reopened.close();
		}
		expect(await fs.readFile(copy)).toEqual(copied);
	});
}

describe("legal future mutation options", () => {
	it("funds the complete request envelope for every unresolved non-root domain", () => {
		const hash = "1".repeat(64);
		const records: DurableRegistryRecord[] = [
			{
				kind: "construction",
				at: 1,
				rootId: "r",
				actorId: "r",
				generation: 1,
				startupHash: hash,
				provenanceHash: hash,
				phase: "constructed",
			},
			{
				kind: "operation",
				at: 1,
				ownerId: "r",
				classOwnerId: "r",
				operationId: "o",
				effectClass: "filesystem",
				acquiredAt: 1,
				expiresAt: 2,
				phase: "effect",
			},
			{
				kind: "resource",
				at: 1,
				actorId: "r",
				generation: 1,
				resourceId: "f",
				resourceClass: "filesystem",
				operationId: "o",
				targetHash: hash,
				phase: "effect",
			},
			{
				kind: "local-entry",
				at: 1,
				localId: "l",
				entryId: "e",
				version: 1,
				expectedHeadHash: hash,
				entryHash: hash,
				headHash: hash,
				phase: "effect",
			},
		];
		for (const backend of ["jsonl", "sqlite"] as const) {
			for (const record of records) {
				const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
				const small = new AuthorityCapacityDebtLedger(identity, 1_024, [record]).currentDebt();
				const maximum = new AuthorityCapacityDebtLedger(identity, ADMISSION, [record]).currentDebt();
				// At least one complete continuation envelope per unresolved record...
				if (backend === "jsonl")
					expect(maximum.jsonlBytes - small.jsonlBytes).toBeGreaterThanOrEqual(5 * (CONTINUATION - 1_024));
				else
					expect(
						maximum.sqliteDatabaseBytes +
							maximum.sqliteWalBytes -
							small.sqliteDatabaseBytes -
							small.sqliteWalBytes,
					).toBeGreaterThanOrEqual(
						(Math.ceil((2 * CONTINUATION) / 4_092) - Math.ceil((2 * 1_024) / 4_092)) * (4_096 + 4_120),
					);
				// ...priced at the continuation bound, never at the 2 MiB admission bound.
				expect(maximum).toEqual(new AuthorityCapacityDebtLedger(identity, CONTINUATION, [record]).currentDebt());
			}
		}
	});
	it("retains independent active-root and actor promises while a transition can retire alone", () => {
		const hash = "1".repeat(64);
		const root: DurableRegistryRecord = {
			kind: "root",
			at: 1,
			rootId: "r",
			generation: 1,
			headHash: hash,
			state: "active",
		};
		const actor: DurableRegistryRecord = {
			kind: "actor",
			at: 1,
			actorId: "r",
			rootId: "r",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: hash,
			startupHash: hash,
			provenanceHash: hash,
			state: "active",
		};
		const transition: DurableRegistryRecord = {
			kind: "transition",
			at: 1,
			rootId: "r",
			transitionId: "t",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: hash,
			destinationHeadHash: hash,
			phase: "staged",
		};
		for (const backend of ["jsonl", "sqlite"] as const) {
			const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
			const independent = new AuthorityCapacityDebtLedger(identity, 2_097_152, [root, actor]).currentDebt();
			const staged = new AuthorityCapacityDebtLedger(identity, 2_097_152, [transition]).currentDebt();
			const joint = new AuthorityCapacityDebtLedger(identity, 2_097_152, [root, actor, transition]).currentDebt();
			expect(joint.jsonlBytes).toBeGreaterThanOrEqual(staged.jsonlBytes + independent.jsonlBytes);
			expect(joint.sqliteDatabaseBytes).toBeGreaterThanOrEqual(
				staged.sqliteDatabaseBytes + independent.sqliteDatabaseBytes,
			);
			expect(joint.sqliteWalBytes).toBeGreaterThanOrEqual(staged.sqliteWalBytes + independent.sqliteWalBytes);
		}
	});
});
it("reserves a resource effect's committed and completed continuations", () => {
	const resource = {
		kind: "resource",
		at: 1,
		actorId: "r",
		generation: 1,
		resourceId: "f",
		resourceClass: "filesystem",
		operationId: "o",
		targetHash: "1".repeat(64),
		phase: "effect",
	} satisfies DurableRegistryRecord;
	const committed = { ...resource, phase: "committed" } satisfies DurableRegistryRecord;
	const completed = { ...resource, phase: "completed" } satisfies DurableRegistryRecord;
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const effectDebt = new AuthorityCapacityDebtLedger(identity, 2_097_152, [resource]).currentDebt().jsonlBytes;
	const committedDebt = new AuthorityCapacityDebtLedger(identity, 2_097_152, [committed]).currentDebt().jsonlBytes;
	const completedDebt = new AuthorityCapacityDebtLedger(identity, 2_097_152, [completed]).currentDebt().jsonlBytes;
	expect(effectDebt).toBeGreaterThan(committedDebt);
	expect(committedDebt).toBeGreaterThan(completedDebt);
});

it("retains standalone gate progress alongside optional transition batches", () => {
	const hash = "1".repeat(64);
	const transition: DurableRegistryRecord = {
		kind: "transition",
		at: 1,
		rootId: "r",
		transitionId: "t",
		sourceGeneration: 1,
		destinationGeneration: 2,
		sourceHeadHash: hash,
		destinationHeadHash: hash,
		phase: "staged",
	};
	const gate: DurableRegistryRecord = { kind: "gate", at: 1, rootId: "r", generation: 1, phase: "quiescing" };
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const transitionOnly = new AuthorityCapacityDebtLedger(identity, 2_097_152, [transition]).currentDebt().jsonlBytes;
	const gateOnly = new AuthorityCapacityDebtLedger(identity, 2_097_152, [gate]).currentDebt().jsonlBytes;
	const combined = new AuthorityCapacityDebtLedger(identity, 2_097_152, [transition, gate]).currentDebt().jsonlBytes;
	expect(combined).toBeGreaterThanOrEqual(transitionOnly + gateOnly);
});
it("binds live WAL and allocator assumptions to the selected SQLite connection", async () => {
	const directory = await makeDirectory();
	const filename = path.join(directory, "live.sqlite");
	const database = new Database(filename, { create: true, strict: true });
	try {
		expect(configureAuthoritySqliteCapacity(database, true)).toBe(2);
		expect(database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
		expect(database.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()?.locking_mode).toBe("exclusive");
		expect(database.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(2);
		expect(database.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get()?.mmap_size).toBe(0);
		expect(database.query<{ cache_spill: number }, []>("PRAGMA cache_spill").get()?.cache_spill).toBe(0);
	} finally {
		database.close(true);
	}
});

it("keeps the bound live connection usable for durable WAL writes", async () => {
	const directory = await makeDirectory();
	const database = new Database(path.join(directory, "binding.sqlite"), { create: true, strict: true });
	try {
		configureAuthoritySqliteCapacity(database, true);
		database.exec("CREATE TABLE binding_probe (value INTEGER); INSERT INTO binding_probe VALUES (42)");
		expect(database.query<{ value: number }, []>("SELECT value FROM binding_probe").get()?.value).toBe(42);
		expect(database.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()?.locking_mode).toBe("exclusive");
	} finally {
		database.close(true);
	}
});

it("funds public root, actor, gate and recovery activation options", () => {
	const hash = "1".repeat(64);
	const records: DurableRegistryRecord[] = [
		{ kind: "root", at: 1, rootId: "r", generation: 1, headHash: hash, state: "active" },
		{
			kind: "actor",
			at: 1,
			actorId: "r",
			rootId: "r",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: hash,
			startupHash: hash,
			provenanceHash: hash,
			state: "active",
		},
		{ kind: "gate", at: 1, rootId: "r", generation: 1, phase: "quiesced" },
	];
	for (const backend of ["jsonl", "sqlite"] as const) {
		const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
		for (const record of records) {
			const small = new AuthorityCapacityDebtLedger(identity, 1_024, [record]).currentDebt();
			const large = new AuthorityCapacityDebtLedger(identity, ADMISSION, [record]).currentDebt();
			const delta =
				backend === "jsonl"
					? large.jsonlBytes - small.jsonlBytes
					: large.sqliteDatabaseBytes + large.sqliteWalBytes - small.sqliteDatabaseBytes - small.sqliteWalBytes;
			expect(delta).toBeGreaterThanOrEqual(
				backend === "jsonl"
					? 5 * (CONTINUATION - 1_024)
					: (Math.ceil((2 * CONTINUATION) / 4_092) - Math.ceil((2 * 1_024) / 4_092)) * (4_096 + 4_120),
			);
			expect(large).toEqual(new AuthorityCapacityDebtLedger(identity, CONTINUATION, [record]).currentDebt());
		}
	}
});

it("does not replace root-family native mutations with a single 54-page allowance", () => {
	const identity = {
		backend: "sqlite" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const root: DurableRegistryRecord = {
		kind: "root",
		at: 1,
		rootId: "r",
		generation: 1,
		headHash: "1".repeat(64),
		state: "active",
	};
	const debt = new AuthorityCapacityDebtLedger(identity, 1_024, [root]).currentDebt();
	// A frame and receipt alone insert at least seven table/index entries.
	expect(debt.sqliteDatabaseBytes).toBeGreaterThanOrEqual(7 * (4 * 32 + 1) * 4_096);
});

it("reserves separate public options for root retirement and later revival", () => {
	const hash = "1".repeat(64);
	const root: DurableRegistryRecord = {
		kind: "root",
		at: 1,
		rootId: "r",
		generation: 1,
		headHash: hash,
		state: "active",
	};
	const gate: DurableRegistryRecord = { kind: "gate", at: 1, rootId: "r", generation: 1, phase: "quiesced" };
	for (const backend of ["jsonl", "sqlite"] as const) {
		const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
		const contribution = (bound: number) => {
			const combined = new AuthorityCapacityDebtLedger(identity, bound, [root, gate]).currentDebt();
			const gateOnly = new AuthorityCapacityDebtLedger(identity, bound, [gate]).currentDebt();
			return backend === "jsonl"
				? combined.jsonlBytes - gateOnly.jsonlBytes
				: combined.sqliteDatabaseBytes +
						combined.sqliteWalBytes -
						gateOnly.sqliteDatabaseBytes -
						gateOnly.sqliteWalBytes;
		};
		const envelope =
			backend === "jsonl"
				? 5 * (CONTINUATION - 1_024)
				: (Math.ceil((2 * CONTINUATION) / 4_092) - Math.ceil((2 * 1_024) / 4_092)) * (4_096 + 4_120);
		expect(contribution(ADMISSION) - contribution(1_024)).toBeGreaterThanOrEqual(2 * envelope);
	}
});

itOnXfs("allows an already funded CAS and pre-CAS recovery when NEW reconciliation fails", async () => {
	const hash = "1".repeat(64);
	for (const recovery of [false, true]) {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const filename = path.join(directory, "authority.jsonl");
		await fs.writeFile(filename, "", { mode: 0o600 });
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const transition: DurableRegistryRecord = {
			kind: "transition",
			at: 1,
			rootId: "r",
			transitionId: "t",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: hash,
			destinationHeadHash: hash,
			phase: "validated",
		};
		const admission = new AuthorityCapacityAdmission(filename, identity, {
			identity: capacity.identity,
			maxRequestBytes: 1024,
		});
		admission.initialize([transition]);
		admission.closeFailed(new Error("refill failed"));
		const reconcile = spyOn(BorrowedAuthorityCapacityPool.prototype, "reconcile").mockImplementation(() => {
			throw new Error("NEW reconciliation failed");
		});
		try {
			const next = {
				...transition,
				at: 2,
				phase: recovery ? "recovered" : "cas-committed",
			} satisfies DurableRegistryRecord;
			const gate: DurableRegistryRecord = {
				kind: "gate",
				at: 2,
				rootId: "r",
				generation: 1,
				phase: recovery ? "open" : "closed",
			};
			const root: DurableRegistryRecord = {
				kind: "root",
				at: 2,
				rootId: "r",
				generation: recovery ? 1 : 2,
				headHash: hash,
				state: "active",
			};
			const frame = {
				command: { kind: "commit-root-transition" },
				revision: 2,
				changes: (recovery ? [next, gate] : [next, gate, root]).map(record => ({ record, version: 2 })),
				controls: [],
			} as unknown as AuthorityCommitFrame;
			const unknown = {
				...frame,
				changes: [{ record: { ...next, transitionId: "unfunded" }, version: 2 }],
			} as AuthorityCommitFrame;
			expect(() => admission.prepare(unknown, undefined, 128)).toThrow();
			expect(reconcile).toHaveBeenCalled();
			reconcile.mockClear();
			expect(() => admission.prepare(frame, undefined, 128)).not.toThrow();
			expect(reconcile).not.toHaveBeenCalled();
			admission.aborted(frame, false);
		} finally {
			reconcile.mockRestore();
		}
	}
});

function admissionFrame(
	records: readonly DurableRegistryRecord[],
	revision: number,
	ownerPhase?: "recovering" | "ready" | "closed",
): AuthorityCommitFrame {
	const incarnation = "incarnation";
	const requestId = `request-${revision}`;
	const receipt = {
		requestId,
		ownerEpoch: 1,
		revision,
		payloadHash: "1".repeat(64),
		incarnation,
		commandKind: ownerPhase ? ("owner" as const) : ("transition" as const),
		committedAt: revision,
		result: { kind: "mutation" as const },
	};
	const owner = { incarnation, epoch: 1, token: "o".repeat(36), phase: ownerPhase ?? ("ready" as const) };
	return {
		version: 2,
		kind: "commit",
		revision,
		request: { requestId, incarnation, ownerEpoch: 1, ownerToken: owner.token },
		command: ownerPhase ? { kind: "owner", owner } : { kind: "transition", record: records[0]! },
		payloadHash: receipt.payloadHash,
		expected: [],
		changes: records.map(record => ({ record, version: revision })),
		controls: [
			{ key: "meta", deleted: false, value: { revision, generationHighWater: 1, status: "ready" } },
			...(ownerPhase ? [{ key: "owner", deleted: false as const, value: owner }] : []),
			{ key: `receipt:${JSON.stringify([incarnation, 1, requestId])}`, deleted: false, value: receipt },
		],
		receipt,
		previousHash: receipt.payloadHash,
		committedAt: revision,
		contentHash: receipt.payloadHash,
		hash: receipt.payloadHash,
	};
}

itOnXfs("requires NEW reconciliation for first quiescing and closed-to-quiescing gates", async () => {
	for (const previous of [undefined, "closed", "open"] as const) {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const filename = path.join(directory, "gate.jsonl");
		await fs.writeFile(filename, "", { mode: 0o600 });
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const gate = {
			kind: "gate",
			at: 1,
			rootId: "r",
			generation: 1,
			phase: "quiescing",
		} satisfies DurableRegistryRecord;
		const admission = new AuthorityCapacityAdmission(filename, identity, {
			identity: capacity.identity,
			maxRequestBytes: 1024,
		});
		admission.initialize(previous ? [{ ...gate, phase: previous }] : []);
		admission.closeFailed(new Error("retained refill failure"));
		const reconcile = spyOn(BorrowedAuthorityCapacityPool.prototype, "reconcile").mockImplementation(() => {
			throw new Error("NEW reconciliation failed");
		});
		const frame = admissionFrame([gate], 2);
		try {
			if (previous === "open") {
				expect(() => admission.prepare(frame)).not.toThrow();
				expect(reconcile).not.toHaveBeenCalled();
				admission.aborted(frame, false);
			} else {
				expect(() => admission.prepare(frame)).toThrow("NEW admission remains closed");
				expect(reconcile).toHaveBeenCalled();
			}
		} finally {
			reconcile.mockRestore();
		}
	}
});

itOnXfs("consumes a funded recovering-ready-close episode without any reserve growth", async () => {
	const directory = await makeDirectory();
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	const filename = path.join(directory, "owner.jsonl");
	await fs.writeFile(filename, "", { mode: 0o600 });
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const admission = new AuthorityCapacityAdmission(filename, identity, {
		identity: capacity.identity,
		maxRequestBytes: 1024,
	});
	admission.initialize([]);
	const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
		throw new Error("no fresh capacity");
	});
	try {
		let revision = 0;
		for (const phase of ["recovering", "ready", "closed"] as const) {
			const frame = admissionFrame([], ++revision, phase);
			expect(() => admission.prepare(frame)).not.toThrow();
			await fs.appendFile(filename, `${JSON.stringify(frame)}\n`);
			expect(() => admission.committed(frame)).not.toThrow();
		}
		expect(growth).not.toHaveBeenCalled();
		expect((await fs.readFile(filename, "utf8")).trim().split("\n")).toHaveLength(3);
	} finally {
		growth.mockRestore();
	}
});

it("tracks append-safe SQLite WAL and SHM obligations across independent futures", () => {
	const hash = "1".repeat(64);
	const records: DurableRegistryRecord[] = [
		{
			kind: "operation",
			at: 1,
			ownerId: "r",
			classOwnerId: "r",
			operationId: "o",
			effectClass: "filesystem",
			acquiredAt: 1,
			expiresAt: 2,
			phase: "effect",
		},
		{
			kind: "resource",
			at: 1,
			actorId: "r",
			generation: 1,
			resourceId: "f",
			resourceClass: "filesystem",
			operationId: "o",
			targetHash: hash,
			phase: "effect",
		},
	];
	const identity = {
		backend: "sqlite" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const separate = records.map(record => new AuthorityCapacityDebtLedger(identity, 2_097_152, [record]).currentDebt());
	const combined = new AuthorityCapacityDebtLedger(identity, 2_097_152, records).currentDebt();
	expect(combined.sqliteWalBytes).toBeGreaterThanOrEqual(separate.reduce((sum, debt) => sum + debt.sqliteWalBytes, 0));
	expect(combined.sqliteShmBytes).toBe(Math.max(...separate.map(debt => debt.sqliteShmBytes)));
	expect(combined.sqliteDatabaseBytes).toBeGreaterThan(separate[0]!.sqliteDatabaseBytes);
});
it("funds legal construction abandonment and pre-CAS transition recovery", () => {
	const hash = "1".repeat(64);
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const construction = (phase: "reserved" | "constructing" | "constructed" | "activated"): DurableRegistryRecord => ({
		kind: "construction",
		at: 1,
		rootId: "r",
		actorId: "r",
		generation: 1,
		startupHash: hash,
		provenanceHash: hash,
		phase,
	});
	const debt = (record: DurableRegistryRecord) =>
		new AuthorityCapacityDebtLedger(identity, 2_097_152, [record]).currentDebt().jsonlBytes;
	expect(debt(construction("reserved"))).toBeGreaterThan(debt(construction("constructing")));
	expect(debt(construction("constructing"))).toBeGreaterThan(debt(construction("constructed")));
	expect(debt(construction("constructed"))).toBeGreaterThan(debt(construction("activated")));
	const transition = (phase: "validated" | "cas-committed"): DurableRegistryRecord => ({
		kind: "transition",
		at: 1,
		rootId: "r",
		transitionId: "t",
		sourceGeneration: 1,
		destinationGeneration: 2,
		sourceHeadHash: hash,
		destinationHeadHash: hash,
		phase,
	});
	expect(debt(transition("validated"))).toBeGreaterThan(debt(transition("cas-committed")));
});

it("reserves six append-only transition steps when WAL reset is unavailable", () => {
	const hash = "1".repeat(64);
	const transition: DurableRegistryRecord = {
		kind: "transition",
		at: 1,
		rootId: "r",
		transitionId: "t",
		sourceGeneration: 1,
		destinationGeneration: 2,
		sourceHeadHash: hash,
		destinationHeadHash: hash,
		phase: "staged",
	};
	const identity = {
		backend: "sqlite" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const debt = new AuthorityCapacityDebtLedger(identity, ADMISSION, [transition]).currentDebt();
	const optionPages = Math.ceil((2 * CONTINUATION) / 4_092) + 3;
	expect(debt.sqliteWalBytes).toBeGreaterThanOrEqual(6 * optionPages * 4_120 + 7_737_392);
	expect(debt.sqliteDatabaseBytes).toBeGreaterThanOrEqual(6 * optionPages * 4_096 + 3_588_096);
});

it("reserves revival gate progress independently of the current gate and staged transition", () => {
	const hash = "1".repeat(64);
	const records: DurableRegistryRecord[] = [
		{ kind: "root", at: 1, rootId: "r", generation: 1, headHash: hash, state: "active" },
		{
			kind: "actor",
			at: 1,
			actorId: "r",
			rootId: "r",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: hash,
			startupHash: hash,
			provenanceHash: hash,
			state: "active",
		},
		{
			kind: "transition",
			at: 1,
			rootId: "r",
			transitionId: "t",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: hash,
			destinationHeadHash: hash,
			phase: "staged",
		},
		{ kind: "gate", at: 1, rootId: "r", generation: 1, phase: "quiesced" },
	];
	const jsonlIdentity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const jsonlDebt = new AuthorityCapacityDebtLedger(jsonlIdentity, ADMISSION, records).currentDebt().jsonlBytes;
	expect(jsonlDebt).toBeGreaterThanOrEqual(14 * 5 * CONTINUATION);
	expect(jsonlDebt).toBeLessThan(14 * 5 * CONTINUATION + 32 * 8_192);
});

for (const { backend, budget, recovery, activationOnly } of [
	{ backend: "sqlite", budget: 100_663_296, recovery: false, activationOnly: false },
	{ backend: "sqlite", budget: 100_663_296, recovery: true, activationOnly: false },
	{ backend: "sqlite", budget: 100_663_296, recovery: false, activationOnly: true },
	{ backend: "jsonl", budget: 134_217_728, recovery: false, activationOnly: false },
	{ backend: "jsonl", budget: 134_217_728, recovery: true, activationOnly: false },
	{ backend: "jsonl", budget: 134_217_728, recovery: false, activationOnly: true },
	{ backend: "jsonl", budget: 1_048_576, recovery: false, activationOnly: false },
] as const) {
	itOnXfs(
		`${backend} funds actual ${activationOnly ? "activation" : recovery ? "recovery" : "CAS"} or refuses before ACK inside ${budget} physical bytes`,
		async () => {
			const directory = await makeDirectory();
			const filename = path.join(directory, `coexist.${backend}`);
			const capacity = await openAuthorityCapacityFile(directory);
			handles.push(capacity.handle);
			const original = BorrowedAuthorityCapacityPool.prototype.ensureDataBytes;
			const boundedGrowth = function (
				this: BorrowedAuthorityCapacityPool,
				bytes: number,
			): ReturnType<BorrowedAuthorityCapacityPool["ensureDataBytes"]> {
				let targetBytes = 0;
				for (const suffix of ["", "-wal", "-shm"]) {
					try {
						const data = syncFs.statSync(filename + suffix).blocks * 512;
						if (data)
							targetBytes += xfsTargetEnvelope({ databaseBytes: data, walBytes: 0, shmBytes: 0 }).totalBytes;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				const pool = xfsTargetEnvelope({ databaseBytes: bytes, walBytes: 0, shmBytes: 0 });
				if (targetBytes + pool.totalBytes > budget) throw new Error("complete physical coexistence exceeds budget");
				return original.call(this, bytes);
			};
			const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(
				boundedGrowth,
			);
			const captured: { connection?: Database } = {};
			const fileControl = Database.prototype.fileControl;
			const captureFileControl: Database["fileControl"] = function (
				this: Database,
				databaseOrOpcode: string | number,
				opcodeOrArgument?: number | ArrayBufferView,
				argument?: number | ArrayBufferView,
			): number {
				captured.connection = this;
				const native = fileControl.bind(this);
				if (typeof databaseOrOpcode === "number") return native(databaseOrOpcode, opcodeOrArgument);
				if (typeof opcodeOrArgument !== "number")
					throw new TypeError("Named SQLite file control requires a numeric opcode");
				return native(databaseOrOpcode, opcodeOrArgument, argument);
			};
			const capture =
				backend === "sqlite"
					? spyOn(Database.prototype, "fileControl").mockImplementation(captureFileControl)
					: undefined;
			const assertRetainedArena = (): void => {
				if (backend !== "sqlite" || !activationOnly) return;
				if (!captured.connection) throw new Error("SQLite arena regression did not capture the actual connection");
				assertSqliteArena(filename, capacity.identity, captured.connection);
			};
			let driver: SqliteAuthorityPersistence | JsonlAuthorityPersistence | undefined;
			try {
				const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
				const Persistence = backend === "sqlite" ? SqliteAuthorityPersistence : JsonlAuthorityPersistence;
				driver = new Persistence({
					path: filename,
					identity,
					create: true,
					capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
				});
				const engine = new AuthorityEngine(driver, "o".repeat(36));
				expect(engine.recover().owner.phase).toBe("ready");
				const hash = "1".repeat(64);
				const rootHash = durableRootHeadHash({
					rootId: "r",
					generation: 1,
					actorId: "r",
					startupHash: hash,
					provenanceHash: hash,
				});
				const nextHash = durableRootHeadHash({
					rootId: "r",
					generation: 2,
					actorId: "r",
					startupHash: hash,
					provenanceHash: hash,
				});
				const construction = {
					kind: "construction",
					at: 1,
					rootId: "r",
					actorId: "r",
					generation: 1,
					startupHash: hash,
					provenanceHash: hash,
					phase: "reserved",
				} satisfies DurableRegistryRecord;
				if (backend === "jsonl" && budget === 1_048_576) {
					expect(() => engine.transition(construction)).toThrow("complete physical coexistence exceeds budget");
					expect(engine.getConstruction("r", "r", 1)).toBeUndefined();
					growth.mockClear();
					growth.mockImplementation(() => {
						throw new Error("no fresh capacity after refused NEW admission");
					});
					engine.close();
					expect(growth).not.toHaveBeenCalled();
					driver = undefined;
					return;
				}
				engine.transition(construction);
				if (activationOnly) {
					growth.mockClear();
					growth.mockImplementation(() => {
						throw new Error("no fresh capacity after construction reservation");
					});
				}
				const constructing = { ...construction, phase: "constructing" } satisfies DurableRegistryRecord;
				if (activationOnly)
					refuseOversizedThenContinue(
						engine,
						"constructing",
						{ kind: "transition", record: constructing },
						options => engine.transition(constructing, options),
					);
				else engine.transition(constructing);
				assertRetainedArena();
				const constructed = { ...construction, phase: "constructed" } satisfies DurableRegistryRecord;
				if (activationOnly)
					refuseOversizedThenContinue(
						engine,
						"constructed",
						{ kind: "transition", record: constructed },
						options => engine.transition(constructed, options),
					);
				else engine.transition(constructed);
				assertRetainedArena();
				const activation = {
					construction: { ...construction, phase: "activated" as const },
					root: {
						kind: "root" as const,
						at: 1,
						rootId: "r",
						generation: 1,
						headHash: rootHash,
						state: "active" as const,
					},
					actor: {
						kind: "actor" as const,
						at: 1,
						actorId: "r",
						rootId: "r",
						generation: 1,
						rootGeneration: 1,
						rootHeadHash: rootHash,
						startupHash: hash,
						provenanceHash: hash,
						state: "active" as const,
					},
					gate: { kind: "gate" as const, at: 1, rootId: "r", generation: 1, phase: "open" as const },
				};
				if (activationOnly)
					refuseOversizedThenContinue(engine, "activation", { kind: "activate-authority", activation }, options =>
						engine.activateAuthority(activation, options),
					);
				else engine.activateAuthority(activation);
				assertRetainedArena();
				if (activationOnly) {
					expect(engine.getActor("r")?.record.state).toBe("active");
					engine.close();
					expect(growth).not.toHaveBeenCalled();
					if (backend === "sqlite") {
						// Reopen funds its own owner and root-recovery episode: it may grow within the
						// budget, or refuse before claiming the store.
						growth.mockImplementation(boundedGrowth);
						const reopenOptions = {
							path: filename,
							create: false,
							identity: { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const },
						};
						let refusal: unknown;
						let reopened: AuthorityEngine | undefined;
						try {
							driver = new SqliteAuthorityPersistence({
								...reopenOptions,
								capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
							});
							reopened = new AuthorityEngine(driver, "o".repeat(36));
							expect(reopened.recover().owner.phase).toBe("ready");
						} catch (error) {
							refusal = error;
						}
						if (refusal !== undefined) {
							expect(String(refusal)).toContain("complete physical coexistence exceeds budget");
							driver?.close();
							const unclaimed = new SqliteAuthorityPersistence(reopenOptions);
							try {
								expect(unclaimed.getControl("owner")).toMatchObject({ phase: "closed" });
								expect(unclaimed.get("actor", ["r"])?.record.state).toBe("active");
							} finally {
								unclaimed.close();
							}
						} else {
							growth.mockClear();
							growth.mockImplementation(() => {
								throw new Error("no fresh capacity after funded reopen");
							});
							expect(reopened!.getActor("r")?.record.state).toBe("active");
							assertRetainedArena();
							reopened!.close();
							expect(growth).not.toHaveBeenCalled();
						}
					}
					driver = undefined;
					return;
				}
				engine.transition({ kind: "gate", at: 2, rootId: "r", generation: 1, phase: "quiescing" });
				engine.transition({ kind: "gate", at: 3, rootId: "r", generation: 1, phase: "quiesced" });
				const transition = {
					kind: "transition",
					at: 3,
					rootId: "r",
					transitionId: "t",
					sourceGeneration: 1,
					destinationGeneration: 2,
					sourceHeadHash: rootHash,
					destinationHeadHash: nextHash,
					phase: "staged",
				} satisfies DurableRegistryRecord;
				engine.transition(transition);
				const inspect = BorrowedAuthorityCapacityPool.open(capacity.identity);
				expect(inspect.inspect().dataBytes).toBeGreaterThan(0);
				growth.mockClear();
				growth.mockImplementation(() => {
					throw new Error("no fresh capacity after staged admission");
				});
				const step = (prefix: string, record: DurableRegistryRecord): void => {
					refuseOversizedThenContinue(engine, prefix, { kind: "transition", record }, options =>
						engine.transition(record, options),
					);
				};
				for (const phase of ["quiescing", "quiesced", "validated"] as const) step(phase, { ...transition, phase });
				if (recovery) {
					const source = engine.getRoot("r");
					if (!source) throw new Error("Recovery fixture lost its source root");
					const recovered = {
						transition: { ...transition, phase: "recovered" as const, recovery: true as const },
						expectedRootGeneration: 1,
						expectedRootHeadHash: rootHash,
						root: source.record,
						gate: { kind: "gate" as const, at: 4, rootId: "r", generation: 1, phase: "open" as const },
					};
					refuseOversizedThenContinue(
						engine,
						"recovery",
						{ kind: "commit-root-transition", transition: recovered },
						options => engine.commitRootTransition(recovered, options),
					);
					for (const phase of ["quiescing", "quiesced", "closed"] as const)
						step(`recovery-gate-${phase}`, { kind: "gate", at: 5, rootId: "r", generation: 1, phase });
					expect(engine.getTransition("r", "t")?.record.phase).toBe("recovered");
					engine.close();
					expect(growth).not.toHaveBeenCalled();
					driver = undefined;
					return;
				}
				const cas = {
					transition: { ...transition, phase: "cas-committed" as const },
					expectedRootGeneration: 1,
					expectedRootHeadHash: rootHash,
					root: {
						kind: "root" as const,
						at: 4,
						rootId: "r",
						generation: 2,
						headHash: nextHash,
						state: "active" as const,
					},
					gate: { kind: "gate" as const, at: 4, rootId: "r", generation: 1, phase: "closed" as const },
				};
				refuseOversizedThenContinue(engine, "cas", { kind: "commit-root-transition", transition: cas }, options =>
					engine.commitRootTransition(cas, options),
				);
				for (const phase of ["activated", "retired"] as const) step(phase, { ...transition, phase });
				expect(engine.getTransition("r", "t")?.record.phase).toBe("retired");
				engine.close();
				expect(growth).not.toHaveBeenCalled();
				growth.mockImplementation(boundedGrowth);
				const options = {
					path: filename,
					create: false,
					identity: { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const },
					capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
				};
				driver =
					backend === "sqlite" ? new SqliteAuthorityPersistence(options) : new JsonlAuthorityPersistence(options);
				expect(driver.get("root", ["r"])?.record.generation).toBe(2);
				driver.close();
				driver = undefined;
			} finally {
				growth.mockRestore();
				driver?.close();
				capture?.mockRestore();
			}
		},
	);
}

itOnXfs(
	"keeps known SQLite COMMIT successful and retries a failed reset before the next transaction, so the funded continuation is admitted",
	async () => {
		const directory = await makeDirectory();
		const filename = path.join(directory, "reset.sqlite");
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const captured: { connection?: Database } = {};
		const fileControl = Database.prototype.fileControl;
		const captureFileControl: Database["fileControl"] = function (
			this: Database,
			databaseOrOpcode: string | number,
			opcodeOrArgument?: number | ArrayBufferView,
			argument?: number | ArrayBufferView,
		): number {
			captured.connection = this;
			const native = fileControl.bind(this);
			if (typeof databaseOrOpcode === "number") return native(databaseOrOpcode, opcodeOrArgument);
			if (typeof opcodeOrArgument !== "number")
				throw new TypeError("Named SQLite file control requires a numeric opcode");
			return native(databaseOrOpcode, opcodeOrArgument, argument);
		};
		const capture = spyOn(Database.prototype, "fileControl").mockImplementation(captureFileControl);
		let driver: SqliteAuthorityPersistence;
		try {
			driver = new SqliteAuthorityPersistence({
				path: filename,
				create: true,
				identity: { backend: "sqlite", owningSessionId: "session", incarnation: "incarnation", format: 2 },
				capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
			});
		} finally {
			capture.mockRestore();
		}
		const engine = new AuthorityEngine(driver, "o".repeat(36));
		engine.recover();
		const connection = captured.connection;
		if (!connection) {
			engine.close();
			throw new Error("Reset regression did not capture the actual connection");
		}
		const resetFailure = new Error("injected checkpoint I/O failure");
		// Bun's per-connection statement cache holds 20 entries, so the checkpoint statement
		// is evicted between commits; inject at query() to reach the live WAL reconciliation
		// (the NOOP frame read or the RESTART reset that follows every COMMIT).
		const query = connection.query;
		let injected = false;
		const checkpointsAfterFailure: { sql: string; inTransaction: boolean }[] = [];
		const checkpoint = spyOn(connection, "query").mockImplementation(function (this: Database, sql: string) {
			const statement = query.call(this, sql);
			if (sql.startsWith("PRAGMA wal_checkpoint(") && injected)
				checkpointsAfterFailure.push({ sql, inTransaction: this.inTransaction });
			if (!sql.startsWith("PRAGMA wal_checkpoint(") || injected) return statement;
			injected = true;
			const get = statement.get;
			statement.get = () => {
				statement.get = get;
				throw resetFailure;
			};
			return statement;
		} as Database["query"]);
		const hash = "1".repeat(64);
		const record = {
			kind: "construction",
			at: 1,
			rootId: "r",
			actorId: "r",
			generation: 1,
			startupHash: hash,
			provenanceHash: hash,
			phase: "reserved",
		} satisfies DurableRegistryRecord;
		let restoreGrowth: (() => void) | undefined;
		try {
			const forwardFileControl: Database["fileControl"] = captureFileControl.bind(connection);
			const numericLock = new Int32Array([-1, 0]);
			const namedLock = new Int32Array([-1, 0]);
			expect(forwardFileControl(constants.SQLITE_FCNTL_LOCKSTATE, numericLock)).toBe(0);
			expect(forwardFileControl("main", constants.SQLITE_FCNTL_LOCKSTATE, namedLock)).toBe(0);
			expect(numericLock[0]).toBe(4);
			expect(namedLock[0]).toBe(4);
			const receipt = engine.transition(record, { requestId: "known-commit" });
			expect(engine.resolveReceipt("known-commit")?.revision).toBe(receipt.revision);
			expect(engine.getConstruction("r", "r", 1)?.record.phase).toBe("reserved");
			const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
				throw new Error("no fresh capacity after known commit");
			});
			restoreGrowth = () => growth.mockRestore();
			const next = { ...record, phase: "constructing" } satisfies DurableRegistryRecord;
			// The failed reset is retried (forced RESTART) before BEGIN, outside any transaction, so the
			// continuation is admitted on its first attempt instead of being refused once.
			expect(() => engine.transition(next, { requestId: "funded-continuation" })).not.toThrow();
			expect(checkpointsAfterFailure[0]).toEqual({ sql: "PRAGMA wal_checkpoint(RESTART)", inTransaction: false });
			expect(engine.getConstruction("r", "r", 1)?.record.phase).toBe("constructing");
			expect(engine.resolveReceipt("funded-continuation")?.revision).toBe(receipt.revision + 1);
			engine.close();
			expect(growth).not.toHaveBeenCalled();
		} finally {
			restoreGrowth?.();
			checkpoint.mockRestore();
			engine.close();
		}
	},
);

itOnXfs("keeps a funded SQLite continuation's reservation when its conversion fails partway", async () => {
	const directory = await makeDirectory();
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	// 20 MiB of reported free space funds every mandatory reserve but no optional pre-funded arena
	// (#tryGrowPool spends at most half the free space), so the continuation must convert its own write.
	const statfs = syncFs.statfsSync;
	const poolPath = `/proc/self/fd/${capacity.identity.fd}`;
	const free = spyOn(syncFs, "statfsSync").mockImplementation(((
		target: syncFs.PathLike,
		options?: syncFs.StatFsOptions,
	) => {
		const actual = statfs(target, options as { bigint?: false });
		return target === poolPath ? { ...actual, bavail: 20 * 256, bsize: 4_096 } : actual;
	}) as typeof syncFs.statfsSync);
	const driver = new SqliteAuthorityPersistence({
		path: path.join(directory, "partial.sqlite"),
		create: true,
		identity: { backend: "sqlite", owningSessionId: "session", incarnation: "incarnation", format: 2 },
		capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
	});
	const engine = new AuthorityEngine(driver, "o".repeat(36));
	engine.recover();
	const hash = "1".repeat(64);
	const record = {
		kind: "construction",
		at: 1,
		rootId: "r",
		actorId: "r",
		generation: 1,
		startupHash: hash,
		provenanceHash: hash,
		phase: "reserved",
	} satisfies DurableRegistryRecord;
	engine.transition(record);
	const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
		throw new Error("no fresh capacity after reservation");
	});
	const release = BorrowedAuthorityCapacityPool.prototype.releaseDataBytes;
	const conversionFailure = new Error("injected mid-conversion release failure");
	let releases = 0;
	const releaseSpy = spyOn(BorrowedAuthorityCapacityPool.prototype, "releaseDataBytes").mockImplementation(function (
		this: BorrowedAuthorityCapacityPool,
		bytes: number,
	) {
		if (++releases === 1) throw conversionFailure;
		return release.call(this, bytes);
	});
	try {
		const before = driver.exportState();
		// A maximal escaped continuation: its targets are allocated first, then the pool release that pays for them fails.
		const constructing = { ...record, phase: "constructing" } satisfies DurableRegistryRecord;
		expect(() =>
			engine.transition(constructing, {
				requestId: requestIdFor("constructing", { kind: "transition", record: constructing }),
			}),
		).toThrow(conversionFailure);
		expect(releases).toBe(1);
		expect(engine.getConstruction("r", "r", 1)?.record.phase).toBe("reserved");
		expect(driver.exportState()).toEqual(before);
		expect(growth).not.toHaveBeenCalled();
	} finally {
		releaseSpy.mockRestore();
		growth.mockRestore();
		free.mockRestore();
		engine.close();
	}
});

it("keeps recovered-root activation funded after NEW admission is closed", () => {
	const hash = "1".repeat(64);
	const root: DurableRegistryRecord = {
		kind: "root",
		at: 1,
		rootId: "r",
		generation: 1,
		headHash: hash,
		state: "active",
	};
	const actor: DurableRegistryRecord = {
		kind: "actor",
		at: 1,
		actorId: "r",
		rootId: "r",
		generation: 1,
		rootGeneration: 1,
		rootHeadHash: hash,
		startupHash: hash,
		provenanceHash: hash,
		state: "active",
	};
	const gate: DurableRegistryRecord = { kind: "gate", at: 1, rootId: "r", generation: 1, phase: "closed" };
	const activation = { ...actor, at: 2 } satisfies DurableRegistryRecord;
	const openedGate = { ...gate, at: 2, phase: "open" } satisfies DurableRegistryRecord;
	const frame = {
		changes: [activation, openedGate].map(record => ({ record, version: 2 })),
		controls: [{ key: 'root-recovery:["r"]', deleted: true }],
	} as unknown as AuthorityCommitFrame;
	for (const backend of ["jsonl", "sqlite"] as const) {
		const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
		const ledger = new AuthorityCapacityDebtLedger(identity, 2_097_152, [root, actor, gate]);
		const funded = ledger.currentDebt();
		const afterRecoveryActivation = ledger.project(frame);
		if (backend === "jsonl") expect(funded.jsonlBytes).toBeGreaterThanOrEqual(afterRecoveryActivation.jsonlBytes);
		else {
			expect(funded.sqliteDatabaseBytes).toBeGreaterThanOrEqual(afterRecoveryActivation.sqliteDatabaseBytes);
			expect(funded.sqliteWalBytes).toBeGreaterThanOrEqual(afterRecoveryActivation.sqliteWalBytes);
			expect(funded.sqliteShmBytes).toBeGreaterThanOrEqual(afterRecoveryActivation.sqliteShmBytes);
		}
	}
});

itOnXfs("spends the funded recovered-root activation instead of requesting fresh capacity", async () => {
	const directory = await makeDirectory();
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	const filename = path.join(directory, "revival.jsonl");
	await fs.writeFile(filename, "", { mode: 0o600 });
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const hash = "1".repeat(64);
	const root = {
		kind: "root",
		at: 1,
		rootId: "r",
		generation: 1,
		headHash: hash,
		state: "active",
	} satisfies DurableRegistryRecord;
	const actor = {
		kind: "actor",
		at: 1,
		rootId: "r",
		actorId: "r",
		generation: 1,
		rootGeneration: 1,
		rootHeadHash: hash,
		startupHash: hash,
		provenanceHash: hash,
		state: "active",
	} satisfies DurableRegistryRecord;
	const gate = { kind: "gate", at: 1, rootId: "r", generation: 1, phase: "closed" } satisfies DurableRegistryRecord;
	const admission = new AuthorityCapacityAdmission(filename, identity, {
		identity: capacity.identity,
		maxRequestBytes: 1024,
	});
	admission.initialize([root, actor, gate]);
	admission.closeFailed(new Error("optional refill failed"));
	const frame = admissionFrame([actor, { ...gate, phase: "open" }], 2);
	const activation = {
		...frame,
		command: {
			kind: "activate-authority",
			activation: {
				actor,
				construction: {
					kind: "construction",
					at: 1,
					rootId: "r",
					actorId: "r",
					generation: 1,
					startupHash: hash,
					provenanceHash: hash,
					phase: "activated",
				},
				gate: { ...gate, phase: "open" },
			},
		},
		controls: [...frame.controls, { key: 'root-recovery:["r"]', deleted: true }],
	} as AuthorityCommitFrame;
	const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
		throw new Error("no fresh capacity");
	});
	try {
		expect(() => admission.prepare(activation)).not.toThrow();
		await fs.appendFile(filename, `${JSON.stringify(activation)}\n`);
		admission.committed(activation);
		expect(growth).not.toHaveBeenCalled();
		expect((await fs.readFile(filename, "utf8")).trim()).toBe(JSON.stringify(activation));
	} finally {
		growth.mockRestore();
	}
});

it("keeps the funded construction activation's downstream obligations within its reservation", () => {
	const hash = "1".repeat(64);
	const construction: DurableRegistryRecord = {
		kind: "construction",
		at: 1,
		rootId: "r",
		actorId: "r",
		generation: 1,
		startupHash: hash,
		provenanceHash: hash,
		phase: "constructed",
	};
	const root: DurableRegistryRecord = {
		kind: "root",
		at: 2,
		rootId: "r",
		generation: 1,
		headHash: hash,
		state: "active",
	};
	const actor: DurableRegistryRecord = {
		kind: "actor",
		at: 2,
		actorId: "r",
		rootId: "r",
		generation: 1,
		rootGeneration: 1,
		rootHeadHash: hash,
		startupHash: hash,
		provenanceHash: hash,
		state: "active",
	};
	const activated = { ...construction, at: 2, phase: "activated" } satisfies DurableRegistryRecord;
	const gate: DurableRegistryRecord = { kind: "gate", at: 2, rootId: "r", generation: 1, phase: "open" };
	const frame = {
		command: { kind: "activate-authority", activation: { root, actor, construction: activated, gate } },
		changes: [root, actor, activated, gate].map(record => ({ record, version: 2 })),
		controls: [],
	} as unknown as AuthorityCommitFrame;
	for (const backend of ["jsonl", "sqlite"] as const) {
		const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
		const ledger = new AuthorityCapacityDebtLedger(identity, 2_097_152, [construction]);
		const reservation = ledger.currentDebt();
		const downstream = ledger.project(frame);
		if (backend === "jsonl") expect(reservation.jsonlBytes).toBeGreaterThanOrEqual(downstream.jsonlBytes);
		else {
			expect(reservation.sqliteDatabaseBytes).toBeGreaterThanOrEqual(downstream.sqliteDatabaseBytes);
			expect(reservation.sqliteWalBytes).toBeGreaterThanOrEqual(downstream.sqliteWalBytes);
		}
	}
});

it("maintains independent allocator-command collateral through every gate phase", () => {
	for (const backend of ["sqlite", "jsonl"] as const) {
		const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
		for (const [phase, commands] of [
			["open", 3],
			["quiescing", 2],
			["quiesced", 1],
			["closed", 0],
		] as const) {
			const gate: DurableRegistryRecord = { kind: "gate", at: 1, rootId: "r", generation: 1, phase };
			const other: DurableRegistryRecord = { kind: "gate", at: 1, rootId: "other", generation: 1, phase: "open" };
			const debt = new AuthorityCapacityDebtLedger(identity, 2_097_152, [gate, other]).currentDebt();
			expect(debt.sqliteCohort?.commands).toBe(commands + 3);
		}
	}
});

itOnXfs("refuses an unmodelled physical index before issuing a capacity capability", async () => {
	const directory = await makeDirectory();
	const filename = path.join(directory, "extra-index.sqlite");
	const identity = {
		backend: "sqlite" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	new SqliteAuthorityPersistence({ path: filename, identity, create: true }).close();
	const offline = new Database(filename, { create: false, strict: true });
	try {
		offline.exec("CREATE INDEX unexpected_amplifier ON authority_frames(body)");
	} finally {
		offline.close(true);
	}
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	expect(
		() =>
			new SqliteAuthorityPersistence({
				path: filename,
				identity,
				create: false,
				capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
			}),
	).toThrow("physical schema");
});

for (const backend of ["sqlite", "jsonl"] as const) {
	itOnXfs(
		`${backend} consumes full-size standalone gate and final-close collateral without fresh growth`,
		async () => {
			const directory = await makeDirectory();
			const filename = path.join(directory, `gate-collateral.${backend}`);
			const capacity = await openAuthorityCapacityFile(directory);
			handles.push(capacity.handle);
			const identity = { backend, owningSessionId: "session", incarnation: "incarnation", format: 2 as const };
			const Persistence = backend === "sqlite" ? SqliteAuthorityPersistence : JsonlAuthorityPersistence;
			const driver = new Persistence({
				path: filename,
				identity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
			});
			const engine = new AuthorityEngine(driver, "o".repeat(36));
			engine.recover();
			const hash = "1".repeat(64);
			const rootHash = durableRootHeadHash({
				rootId: "r",
				generation: 1,
				actorId: "r",
				startupHash: hash,
				provenanceHash: hash,
			});
			const construction = {
				kind: "construction",
				at: 1,
				rootId: "r",
				actorId: "r",
				generation: 1,
				startupHash: hash,
				provenanceHash: hash,
				phase: "reserved",
			} satisfies DurableRegistryRecord;
			for (const phase of ["reserved", "constructing", "constructed"] as const)
				engine.transition({ ...construction, phase });
			engine.activateAuthority({
				construction: { ...construction, phase: "activated" },
				root: { kind: "root", at: 1, rootId: "r", generation: 1, headHash: rootHash, state: "active" },
				actor: {
					kind: "actor",
					at: 1,
					actorId: "r",
					rootId: "r",
					generation: 1,
					rootGeneration: 1,
					rootHeadHash: rootHash,
					startupHash: hash,
					provenanceHash: hash,
					state: "active",
				},
				gate: { kind: "gate", at: 1, rootId: "r", generation: 1, phase: "open" },
			});
			const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
				throw new Error("funded metadata/workspace collateral must not be replenished");
			});
			try {
				for (const phase of ["quiescing", "quiesced", "closed"] as const) {
					const gate = { kind: "gate", at: 2, rootId: "r", generation: 1, phase } satisfies DurableRegistryRecord;
					refuseOversizedThenContinue(engine, phase, { kind: "transition", record: gate }, options =>
						engine.transition(gate, options),
					);
				}
				engine.close();
				expect(growth).not.toHaveBeenCalled();
			} finally {
				growth.mockRestore();
				engine.close();
			}
		},
	);
}

// Activates root "r" and returns the binding that operation records need.
function activateRoot(engine: AuthorityEngine): { rootId: string; actorId: string; generation: number } {
	const hash = "1".repeat(64);
	const rootHash = durableRootHeadHash({
		rootId: "r",
		generation: 1,
		actorId: "r",
		startupHash: hash,
		provenanceHash: hash,
	});
	const construction = {
		kind: "construction",
		at: 1,
		rootId: "r",
		actorId: "r",
		generation: 1,
		startupHash: hash,
		provenanceHash: hash,
		phase: "reserved",
	} satisfies DurableRegistryRecord;
	for (const phase of ["reserved", "constructing", "constructed"] as const)
		engine.transition({ ...construction, phase });
	engine.activateAuthority({
		construction: { ...construction, phase: "activated" },
		root: { kind: "root", at: 1, rootId: "r", generation: 1, headHash: rootHash, state: "active" },
		actor: {
			kind: "actor",
			at: 1,
			actorId: "r",
			rootId: "r",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: rootHash,
			startupHash: hash,
			provenanceHash: hash,
			state: "active",
		},
		gate: { kind: "gate", at: 1, rootId: "r", generation: 1, phase: "open" },
	});
	return { rootId: "r", actorId: "r", generation: 1 };
}

function operationRow(
	binding: { rootId: string; actorId: string; generation: number },
	operationId: string,
	phase: "intent" | "effect" | "completed" | "abandoned",
	at: number,
): DurableRegistryRecord {
	return {
		kind: "operation",
		at,
		operationId,
		effectClass: "eval",
		ownerId: binding.actorId,
		classOwnerId: `${binding.actorId}:eval`,
		actorId: binding.actorId,
		rootId: binding.rootId,
		generation: binding.generation,
		acquiredAt: 1,
		expiresAt: 1_800_001,
		phase,
	};
}

itOnXfs(
	"reopens a multi-thousand-row SQLite store with a reserve bounded by its file horizon and open obligations",
	async () => {
		const directory = await makeDirectory();
		const filename = path.join(directory, "history.sqlite");
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		// Build the history without capacity: only the reopen below is under test.
		const builder = new AuthorityEngine(
			new SqliteAuthorityPersistence({ path: filename, identity, create: true }),
			"o".repeat(36),
		);
		builder.recover();
		const binding = activateRoot(builder);
		// Physical schema v4 stores a history in about a quarter of the v3 bytes; longer ids keep this one above the
		// observer's page bound below. One commit group keeps its ~180 commands to a single durable sync.
		builder.beginGroup();
		for (let batch = 0; batch < 30; batch++) {
			const ids = Array.from(
				{ length: 100 },
				(_, index) => `toolu_01${String(batch * 100 + index).padStart(392, "0")}`,
			);
			builder.transitionBatch(ids.map(id => operationRow(binding, id, "intent", 10)));
			// Abandonment continues admitted operations, so each batch must fit the continuation request bound.
			for (let chunk = 0; chunk < ids.length; chunk += 20)
				builder.transitionBatch(ids.slice(chunk, chunk + 20).map(id => operationRow(binding, id, "abandoned", 11)));
		}
		builder.syncGroup();
		builder.close();
		const reader = new SqliteAuthorityPersistence({ path: filename, identity, create: false });
		let open: DurableRegistryRecord[];
		try {
			open = reader
				.exportState()
				.rows.map(row => row.record)
				.filter(record =>
					"state" in record ? record.state === "active" : record.kind === "gate" && record.phase === "open",
				);
		} finally {
			reader.close();
		}
		const fileBytes = syncFs.statSync(filename).size;
		// Precondition: the store is larger than the bounded 256-page native observer, so no tree walk can make it cheap.
		expect(fileBytes).toBeGreaterThan(256 * 4_096 * 3);
		const obligations = new AuthorityCapacityDebtLedger(identity, 2_097_152, open).currentDebt();
		// The reopening owner's own recovering, ready and closed frames are obligations as well as the open records'.
		const episode = authorityOwnerEpisodeDebt(identity);
		// Database growth is at most the obligations' additive allocations; any one WAL transaction rewrites at most
		// the pages that can then exist; close may delete and refund that WAL; XFS metadata is a fraction of the horizon.
		const horizon = fileBytes + obligations.sqliteDatabaseBytes + episode.sqliteDatabaseBytes;
		const bound = 3 * horizon + 64 * 1_048_576;
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const requests: number[] = [];
		const original = BorrowedAuthorityCapacityPool.prototype.ensureDataBytes;
		const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(function (
			this: BorrowedAuthorityCapacityPool,
			bytes: number,
			step?: number,
		) {
			requests.push(bytes);
			// Refuse before allocating so a regression fails here instead of filling the disk.
			if (bytes > bound)
				throw new Error(`reopen requested ${bytes} reserve bytes above the ${bound}-byte horizon bound`);
			return original.call(this, bytes, step);
		});
		try {
			const engine = new AuthorityEngine(
				new SqliteAuthorityPersistence({
					path: filename,
					identity,
					create: false,
					capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
				}),
				"o".repeat(36),
			);
			try {
				expect(engine.recover().owner.phase).toBe("ready");
				expect(engine.getActor("r")?.record.state).toBe("active");
			} finally {
				engine.close();
			}
		} finally {
			growth.mockRestore();
		}
		expect(requests.length).toBeGreaterThan(0);
		expect(Math.max(...requests)).toBeLessThanOrEqual(bound);
	},
);

itOnXfs(
	"commits steady-state SQLite transitions without capacity fsyncs except at amortized arena extensions",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const engine = new AuthorityEngine(
			new SqliteAuthorityPersistence({
				path: path.join(directory, "steady.sqlite"),
				identity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
			}),
			"o".repeat(36),
		);
		const fsyncs = spyOn(syncFs, "fsyncSync");
		const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes");
		const query = Database.prototype.query;
		let resets = 0;
		const checkpoints = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
			if (sql === "PRAGMA wal_checkpoint(RESTART)") resets++;
			return query.call(this, sql);
		} as Database["query"]);
		try {
			engine.recover();
			const binding = activateRoot(engine);
			let at = 10;
			const perCommit: number[] = [];
			const continuationGrowth: number[] = [];
			const lifecycle = (operationId: string): void => {
				for (const phase of ["intent", "effect", "completed"] as const) {
					const [syncsBefore, growthBefore] = [fsyncs.mock.calls.length, growth.mock.calls.length];
					engine.transition(operationRow(binding, operationId, phase, at++));
					perCommit.push(fsyncs.mock.calls.length - syncsBefore);
					// Effect and completion consume funded promises: they never ask for fresh reserve.
					if (phase !== "intent") continuationGrowth.push(growth.mock.calls.length - growthBefore);
				}
			};
			// Warm-up funds the first arenas.
			for (let index = 0; index < 3; index++) lifecycle(`toolu_01warm${index}`);
			perCommit.length = 0;
			continuationGrowth.length = 0;
			resets = 0;
			for (let index = 0; index < 20; index++) lifecycle(`toolu_01steady${index}`);
			expect(engine.getOperation("r", "eval", "toolu_01steady19")?.record.phase).toBe("completed");
			// Before: every commit released pool data and allocated+fsynced targets (~4 capacity fsyncs each).
			expect(perCommit.filter(count => count > 0).length).toBeLessThanOrEqual(perCommit.length / 10);
			expect(continuationGrowth.every(count => count === 0)).toBe(true);
			// The WAL is reset when its funded room runs out, not after every commit.
			expect(resets).toBeLessThanOrEqual(perCommit.length / 10);
		} finally {
			checkpoints.mockRestore();
			growth.mockRestore();
			fsyncs.mockRestore();
			engine.close();
		}
	},
);

itOnXfs(
	"commits steady-state JSONL appends inside the funded journal arena without pool release, growth or capacity fsync",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const engine = new AuthorityEngine(
			new JsonlAuthorityPersistence({
				path: path.join(directory, "steady.jsonl"),
				identity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
			}),
			"o".repeat(36),
		);
		const releases = spyOn(BorrowedAuthorityCapacityPool.prototype, "releaseDataBytes");
		const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes");
		const truncates = spyOn(syncFs, "ftruncateSync");
		const fsyncs = spyOn(syncFs, "fsyncSync");
		try {
			engine.recover();
			const binding = activateRoot(engine);
			let at = 10;
			const lifecycle = (operationId: string): void => {
				for (const phase of ["intent", "effect", "completed"] as const)
					engine.transition(operationRow(binding, operationId, phase, at++));
			};
			// Warm-up funds the first journal arena.
			for (let index = 0; index < 3; index++) lifecycle(`toolu_01warm${index}`);
			releases.mockClear();
			growth.mockClear();
			truncates.mockClear();
			fsyncs.mockClear();
			for (let index = 0; index < 20; index++) lifecycle(`toolu_01steady${index}`);
			expect(engine.getOperation("r", "eval", "toolu_01steady19")?.record.phase).toBe("completed");
			// Each append lands inside the already funded arena: no transfer, no pool truncate or regrowth, and the only
			// fsyncs are the journal's own commit points (never the pool's).
			expect(releases).not.toHaveBeenCalled();
			expect(truncates).not.toHaveBeenCalled();
			expect(growth).not.toHaveBeenCalled();
			expect(fsyncs.mock.calls.filter(([fd]) => fd === capacity.identity.fd)).toHaveLength(0);
		} finally {
			fsyncs.mockRestore();
			truncates.mockRestore();
			growth.mockRestore();
			releases.mockRestore();
			engine.close();
		}
	},
);

itOnXfs(
	"keeps a small store's funded journal arena proportional to its data instead of a fixed 8 MiB floor",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const filename = path.join(directory, "small.jsonl");
		const engine = new AuthorityEngine(
			new JsonlAuthorityPersistence({
				path: filename,
				identity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
			}),
			"o".repeat(36),
		);
		try {
			engine.recover();
			const binding = activateRoot(engine);
			let at = 10;
			for (let index = 0; index < 10; index++)
				for (const phase of ["intent", "effect", "completed"] as const)
					engine.transition(operationRow(binding, `toolu_01small${index}`, phase, at++));
		} finally {
			engine.close();
		}
		const stat = syncFs.statSync(filename);
		// The funded arena past EOF is at most the journal's own size plus the 2 MiB floor (it doubles below 8 MiB).
		expect(stat.blocks * 512).toBeGreaterThanOrEqual(stat.size);
		expect(stat.blocks * 512).toBeLessThanOrEqual(2 * stat.size + 2 * 1_048_576 + 65_536);
	},
);

itOnXfs(
	"amortizes JSONL pool growth across many NEW admissions instead of growing and syncing it for each",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const engine = new AuthorityEngine(
			new JsonlAuthorityPersistence({
				path: path.join(directory, "growing.jsonl"),
				identity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
			}),
			"o".repeat(36),
		);
		const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes");
		try {
			engine.recover();
			const binding = activateRoot(engine);
			growth.mockClear();
			// Every intent is a NEW admission that adds an open obligation the pool must fund before its ACK.
			for (let index = 0; index < 40; index++)
				engine.transition(operationRow(binding, `toolu_01open${index}`, "intent", 10 + index));
			expect(engine.getOperation("r", "eval", "toolu_01open39")?.record.phase).toBe("intent");
			expect(growth.mock.calls.length).toBeLessThanOrEqual(4);
		} finally {
			growth.mockRestore();
			engine.close();
		}
	},
);

it("keeps incremental SQLite WAL and SHM maxima equal to a fresh ledger as the largest obligations settle", () => {
	const hash = "1".repeat(64);
	const identity = {
		backend: "sqlite" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const open: DurableRegistryRecord[] = [
		{
			kind: "transition",
			at: 1,
			rootId: "r",
			transitionId: "t",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: hash,
			destinationHeadHash: hash,
			phase: "staged",
		},
		{
			kind: "resource",
			at: 1,
			actorId: "r",
			generation: 1,
			resourceId: "f",
			resourceClass: "filesystem",
			operationId: "o",
			targetHash: hash,
			phase: "intent",
		},
		...Array.from(
			{ length: 4 },
			(_, index) =>
				({
					kind: "operation",
					at: 1,
					ownerId: "r",
					classOwnerId: "r",
					operationId: `o${"x".repeat(index * 900)}`,
					effectClass: "filesystem",
					acquiredAt: 1,
					expiresAt: 2,
					phase: "intent",
				}) satisfies DurableRegistryRecord,
		),
	];
	const terminal = (record: DurableRegistryRecord): DurableRegistryRecord =>
		record.kind === "transition"
			? { ...record, phase: "recovered" }
			: record.kind === "resource"
				? { ...record, phase: "abandoned" }
				: ({ ...record, phase: "abandoned" } as DurableRegistryRecord);
	const ledger = new AuthorityCapacityDebtLedger(identity, ADMISSION, open);
	const remaining = [...open];
	const initial = ledger.currentDebt().sqliteStepWalBytes ?? 0;
	const maxima: number[] = [];
	for (let revision = 2; remaining.length > 0; revision++) {
		const frame = admissionFrame([terminal(remaining.shift()!)], revision);
		ledger.project(frame);
		ledger.apply(frame);
		const incremental = ledger.currentDebt();
		const fresh = new AuthorityCapacityDebtLedger(identity, ADMISSION, remaining).currentDebt();
		expect(incremental.sqliteStepWalBytes).toBe(fresh.sqliteStepWalBytes);
		expect(incremental.sqliteShmBytes).toBe(fresh.sqliteShmBytes);
		expect(incremental.sqliteWalBytes).toBe(fresh.sqliteWalBytes);
		maxima.push(incremental.sqliteStepWalBytes ?? 0);
	}
	// Settling the largest obligation first must lower the maximum, not leave a stale high-water mark.
	expect(maxima[0]).toBeLessThan(initial);
	expect(maxima.at(-1)).toBe(0);
});

it("keeps funded arena ends monotone as a horizon grows across 2 GiB chunk splits, where the chunk itself shrinks", () => {
	const page = 4_096;
	const splitPages = Math.floor(0x7fffffff / page);
	const boundaries = [1, 2, 3, 4].flatMap(chunks => [
		chunks * splitPages - 1,
		chunks * splitPages,
		chunks * splitPages + 1,
		chunks * splitPages + 2,
	]);
	let previous = authoritySqliteDatabaseArena(page);
	for (const pages of boundaries) {
		const grown = authoritySqliteDatabaseArena(pages * page);
		// A larger horizon never asks SQLite to size-hint or truncate below an arena end it funded before.
		expect(grown.endBytes).toBeGreaterThanOrEqual(previous.endBytes);
		previous = grown;
	}
	// The chunk itself does shrink at a split (one ~2 GiB chunk becomes two ~1 GiB chunks) ...
	const below = authoritySqliteDatabaseArena(splitPages * page);
	const above = authoritySqliteDatabaseArena((splitPages + 1) * page);
	expect(above.chunkBytes).toBeLessThan(below.chunkBytes);
	// ... so a checkpoint under the new chunk may truncate a file funded to `below.endBytes` down to
	// roundUp(committed, above.chunkBytes). Admission credits exactly that floor for the newly bound chunk
	// (never the old file size), so the freed suffix is re-funded from the pool, not counted as backing.
	for (const committedPages of [1, Math.floor(splitPages / 2), splitPages - 1, splitPages]) {
		const floor = Math.ceil((committedPages * page) / above.chunkBytes) * above.chunkBytes;
		expect(floor).toBeGreaterThanOrEqual(committedPages * page);
		expect(floor).toBeLessThanOrEqual(above.endBytes);
	}
});

it("sizes a SQLite database arena above the signed-int chunk ABI to within a page per chunk of its horizon", () => {
	const page = 4_096;
	for (const pages of [1, 7_172, 524_287, 524_288, 719_018, 719_019, 1_048_575, 1_572_865]) {
		const horizon = pages * page;
		const { chunkBytes, endBytes } = authoritySqliteDatabaseArena(horizon);
		expect(chunkBytes).toBeLessThanOrEqual(0x7fffffff);
		expect(chunkBytes % page).toBe(0);
		expect(endBytes % chunkBytes).toBe(0);
		expect(endBytes).toBeGreaterThanOrEqual(horizon);
		// SQLite rounds every xTruncate and size hint up to the chunk, so the funded end must be exactly that rounding.
		expect(Math.ceil(horizon / chunkBytes) * chunkBytes).toBe(endBytes);
		expect(endBytes - horizon).toBeLessThan((endBytes / chunkBytes) * page);
		// A horizon that already is an arena end keeps the same chunk (reopen preserves the bound EOF).
		expect(authoritySqliteDatabaseArena(endBytes)).toEqual({ chunkBytes, endBytes });
	}
});

itOnXfs("refuses a reserve larger than the filesystem's free space before allocating any of it", async () => {
	const directory = await makeDirectory();
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	const filename = path.join(directory, "huge.jsonl");
	await fs.writeFile(filename, "", { mode: 0o600 });
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const admission = new AuthorityCapacityAdmission(filename, identity, {
		identity: capacity.identity,
		maxRequestBytes: ADMISSION,
	});
	// A single open operation's continuation reserve is now small, so shrink the free space the pool's
	// filesystem reports instead: one 4 KiB block is less than any reserve.
	const statfs = syncFs.statfsSync;
	const poolPath = `/proc/self/fd/${capacity.identity.fd}`;
	const free = spyOn(syncFs, "statfsSync").mockImplementation(((
		target: syncFs.PathLike,
		options?: syncFs.StatFsOptions,
	) => {
		const actual = statfs(target, options as { bigint?: false });
		return target === poolPath ? { ...actual, bavail: 1, bsize: 4_096 } : actual;
	}) as typeof syncFs.statfsSync);
	// Never pass growth through: a regression must fail here, not fill the shared disk.
	const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
		throw new Error("reserve growth attempted beyond free space");
	});
	let refusal: unknown;
	try {
		try {
			admission.initialize([
				{
					kind: "operation",
					at: 1,
					ownerId: "r",
					classOwnerId: "r",
					operationId: "o",
					effectClass: "filesystem",
					acquiredAt: 1,
					expiresAt: 2,
					phase: "intent",
				},
			]);
		} catch (error) {
			refusal = error;
		}
		expect(growth).not.toHaveBeenCalled();
	} finally {
		growth.mockRestore();
		free.mockRestore();
	}
	expect(refusal).toBeInstanceOf(AuthorityCapacityRefusedError);
	expect(BorrowedAuthorityCapacityPool.open(capacity.identity).inspect().dataBytes).toBe(0);
});

itOnXfs(
	"re-reads the JSONL journal before appending when capacity funding moved its timestamps, catching a same-size foreign rewrite",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		// 12 MiB of reported free space funds the mandatory reserve but no pre-funded arena, so the admission
		// below must allocate into the journal itself (fallocate moves its mtime and ctime).
		const statfs = syncFs.statfsSync;
		const poolPath = `/proc/self/fd/${capacity.identity.fd}`;
		const free = spyOn(syncFs, "statfsSync").mockImplementation(((
			target: syncFs.PathLike,
			options?: syncFs.StatFsOptions,
		) => {
			const actual = statfs(target, options as { bigint?: false });
			return target === poolPath ? { ...actual, bavail: 12 * 256, bsize: 4_096 } : actual;
		}) as typeof syncFs.statfsSync);
		const filename = path.join(directory, "fenced.jsonl");
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const driver = new JsonlAuthorityPersistence({
			path: filename,
			identity,
			create: true,
			capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
		});
		const engine = new AuthorityEngine(driver, "o".repeat(36));
		const release = BorrowedAuthorityCapacityPool.prototype.releaseDataBytes;
		let armed = false;
		let rewrittenSize: number | undefined;
		// A foreign writer rewrites the header in place, keeping the size, while the transfer is releasing pool data
		// for the journal's own allocation.
		const releases = spyOn(BorrowedAuthorityCapacityPool.prototype, "releaseDataBytes").mockImplementation(function (
			this: BorrowedAuthorityCapacityPool,
			bytes: number,
		) {
			if (armed && rewrittenSize === undefined) {
				const changed = syncFs.readFileSync(filename);
				changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
				syncFs.writeFileSync(filename, changed);
				rewrittenSize = changed.byteLength;
			}
			return release.call(this, bytes);
		});
		try {
			engine.recover();
			armed = true;
			const record = {
				kind: "operation",
				at: 1,
				ownerId: "r",
				classOwnerId: "r",
				operationId: "fenced",
				effectClass: "filesystem",
				acquiredAt: 1,
				expiresAt: 2,
				phase: "intent",
			} satisfies DurableRegistryRecord;
			// A large admission frame needs journal blocks beyond the funded prefix.
			expect(() => engine.transition(record, { requestId: `fenced-${"a".repeat(256 * 1_024)}` })).toThrow(
				"changed outside its active owner during capacity funding",
			);
			expect(rewrittenSize).toBeDefined();
			expect(syncFs.statSync(filename).size).toBe(rewrittenSize!);
			expect(() => engine.getOperation("r", "filesystem", "fenced")).toThrow();
		} finally {
			releases.mockRestore();
			free.mockRestore();
			driver.close();
		}
	},
);

itOnXfs("allocates a transfer into the target before the pool gives up any space", async () => {
	const directory = await makeDirectory();
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	// As above: the mandatory reserve fits, no pre-funded arena does, so the admission transfers pool data into the journal.
	const statfs = syncFs.statfsSync;
	const poolPath = `/proc/self/fd/${capacity.identity.fd}`;
	const free = spyOn(syncFs, "statfsSync").mockImplementation(((
		target: syncFs.PathLike,
		options?: syncFs.StatFsOptions,
	) => {
		const actual = statfs(target, options as { bigint?: false });
		return target === poolPath ? { ...actual, bavail: 12 * 256, bsize: 4_096 } : actual;
	}) as typeof syncFs.statfsSync);
	const filename = path.join(directory, "ordered.jsonl");
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const driver = new JsonlAuthorityPersistence({
		path: filename,
		identity,
		create: true,
		capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
	});
	const engine = new AuthorityEngine(driver, "o".repeat(36));
	const release = BorrowedAuthorityCapacityPool.prototype.releaseDataBytes;
	let armed = false;
	const observed: number[] = [];
	// The target's allocation at each moment the pool shrinks: freed pool blocks are exposed to every other writer
	// of the filesystem or project, so the target must already hold what they pay for.
	const releases = spyOn(BorrowedAuthorityCapacityPool.prototype, "releaseDataBytes").mockImplementation(function (
		this: BorrowedAuthorityCapacityPool,
		bytes: number,
	) {
		if (armed && bytes > 0) observed.push(syncFs.statSync(filename).blocks * 512);
		return release.call(this, bytes);
	});
	try {
		engine.recover();
		const before = syncFs.statSync(filename).blocks * 512;
		armed = true;
		const record = {
			kind: "operation",
			at: 1,
			ownerId: "r",
			classOwnerId: "r",
			operationId: "ordered",
			effectClass: "filesystem",
			acquiredAt: 1,
			expiresAt: 2,
			phase: "intent",
		} satisfies DurableRegistryRecord;
		engine.transition(record, { requestId: `ordered-${"a".repeat(256 * 1_024)}` });
		armed = false;
		const after = syncFs.statSync(filename);
		expect(after.blocks * 512).toBeGreaterThan(before);
		expect(observed.length).toBeGreaterThan(0);
		// The journal's append left its allocation unchanged, so every release saw the final funded allocation.
		for (const allocated of observed) expect(allocated).toBe(after.blocks * 512);
	} finally {
		releases.mockRestore();
		free.mockRestore();
		engine.close();
	}
});

itOnXfs(
	"keeps continuations admitted after a pool growth step fails partway and leaves blocks past the pool's EOF",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const filename = path.join(directory, "partial-growth.jsonl");
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const engine = new AuthorityEngine(
			new JsonlAuthorityPersistence({
				path: filename,
				identity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
			}),
			"o".repeat(36),
		);
		engine.recover();
		const intent = {
			kind: "operation",
			at: 1,
			ownerId: "r",
			classOwnerId: "r",
			operationId: "admitted",
			effectClass: "filesystem",
			acquiredAt: 1,
			expiresAt: 2,
			phase: "intent",
		} satisfies DurableRegistryRecord;
		engine.transition(intent);
		// XFS mode-0 fallocate can allocate part of a step and then fail: blocks past EOF with an unchanged size.
		const libc = dlopen("libc.so.6", {
			fallocate: { args: [FFIType.i32, FFIType.i32, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
		});
		const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(
			function (this: BorrowedAuthorityCapacityPool) {
				const eof = syncFs.fstatSync(capacity.identity.fd).size;
				if (libc.symbols.fallocate(capacity.identity.fd, 0x01, BigInt(eof), BigInt(6 * 4_096)) !== 0)
					throw new Error("fixture fallocate failed");
				throw new AuthorityCapacityPoolError(
					"Capacity growth may have partially changed the inode; reconcile before credit",
					"uncertain",
					undefined,
					Object.assign(new Error("fallocate(mode 0) failed with Linux errno 28"), {
						code: "ERRNO_28",
						errno: -28,
					}),
				);
			},
		);
		try {
			const large = { ...intent, operationId: "large" } satisfies DurableRegistryRecord;
			let refused: unknown;
			try {
				engine.transition(large, { requestId: `large-${"a".repeat(1_900_000)}` });
			} catch (error) {
				refused = error;
			}
			expect(growth).toHaveBeenCalled();
			expect(refused).toBeInstanceOf(AuthorityCapacityRefusedError);
			// The continuation of the admitted intent is funded by the reserve the failed growth never touched.
			engine.transition({ ...intent, phase: "abandoned" }, { requestId: "continuation" });
			expect(engine.getOperation("r", "filesystem", "admitted")?.record.phase).toBe("abandoned");
		} finally {
			growth.mockRestore();
			libc.close();
		}
		// With growth working again NEW admission reopens.
		engine.transition({ ...intent, operationId: "after" }, { requestId: "after" });
		engine.close();
	},
);

itOnXfs("reopens a JSONL store whose funded arena sits above reflink-shared journal extents", async () => {
	const directory = await makeDirectory();
	const filename = path.join(directory, "arena.jsonl");
	const identity = {
		backend: "jsonl" as const,
		owningSessionId: "session",
		incarnation: "incarnation",
		format: 2 as const,
	};
	const first = await openAuthorityCapacityFile(directory);
	handles.push(first.handle);
	const abandoned = new AuthorityEngine(
		new JsonlAuthorityPersistence({
			path: filename,
			identity,
			create: true,
			capacity: { identity: first.identity, maxRequestBytes: ADMISSION },
		}),
		"o".repeat(36),
	);
	abandoned.recover();
	// A NEW admission funds a KEEP_SIZE arena past EOF; an evidence copy then reflink-shares the journal's bytes below it.
	abandoned.transition({
		kind: "operation",
		at: 1,
		ownerId: "r",
		classOwnerId: "r",
		operationId: "o",
		effectClass: "filesystem",
		acquiredAt: 1,
		expiresAt: 2,
		phase: "intent",
	});
	expect(syncFs.statSync(filename).blocks * 512).toBeGreaterThan(syncFs.statSync(filename).size + ARENA_PROBE_BYTES);
	await fs.copyFile(filename, path.join(directory, "evidence.jsonl"));
	// The first owner is lost without closing; a replacement owner must account the shared prefix and the arena.
	const second = await openAuthorityCapacityFile(directory);
	handles.push(second.handle);
	const replacement = new AuthorityEngine(
		new JsonlAuthorityPersistence({
			path: filename,
			identity,
			create: false,
			capacity: { identity: second.identity, maxRequestBytes: ADMISSION },
		}),
		"p".repeat(36),
	);
	try {
		expect(replacement.recover().blocked).toEqual(["operation:r:o:intent"]);
		expect(replacement.getOperation("r", "filesystem", "o")?.record.phase).toBe("intent");
	} finally {
		replacement.close();
	}
});

itOnXfs(
	"reserves per open SQLite operation its database growth only, with WAL bounded by one transaction",
	async () => {
		const directory = await makeDirectory();
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: "session",
			incarnation: "incarnation",
			format: 2 as const,
		};
		const source = path.join(directory, "history.sqlite");
		// Build a terminal history without capacity: only the reopen reserve is under test.
		const builder = new AuthorityEngine(
			new SqliteAuthorityPersistence({ path: source, identity, create: true }),
			"o".repeat(36),
		);
		builder.recover();
		const binding = activateRoot(builder);
		// Physical schema v4 stores a history in about a quarter of the v3 bytes; longer ids keep this one above the
		// observer's page bound below. One commit group keeps its ~180 commands to a single durable sync.
		builder.beginGroup();
		for (let batch = 0; batch < 30; batch++) {
			const ids = Array.from(
				{ length: 100 },
				(_, index) => `toolu_01${String(batch * 100 + index).padStart(392, "0")}`,
			);
			builder.transitionBatch(ids.map(id => operationRow(binding, id, "intent", 10)));
			for (let chunk = 0; chunk < ids.length; chunk += 20)
				builder.transitionBatch(ids.slice(chunk, chunk + 20).map(id => operationRow(binding, id, "abandoned", 11)));
		}
		builder.syncGroup();
		builder.close();
		// Precondition: larger than the bounded 256-page native observer, so only the proven bounds apply.
		expect(syncFs.statSync(source).size).toBeGreaterThan(256 * 4_096 * 3);
		const OPEN = 100;
		const reopenReserve = async (open: number): Promise<number> => {
			const copy = path.join(directory, `open-${open}`);
			await fs.mkdir(copy, { mode: 0o700 });
			const filename = path.join(copy, "history.sqlite");
			await fs.copyFile(source, filename);
			const adder = new AuthorityEngine(
				new SqliteAuthorityPersistence({ path: filename, identity, create: false }),
				"a".repeat(36),
			);
			adder.recover();
			for (let index = 0; index < open; index++)
				adder.transition(operationRow(binding, `toolu_01open${String(index).padStart(18, "0")}`, "intent", 12));
			adder.close();
			const capacity = await openAuthorityCapacityFile(copy);
			handles.push(capacity.handle);
			const requests: number[] = [];
			const original = BorrowedAuthorityCapacityPool.prototype.ensureDataBytes;
			// Refuse before allocating so a regression fails here instead of filling the disk.
			const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(function (
				this: BorrowedAuthorityCapacityPool,
				bytes: number,
				step?: number,
			) {
				requests.push(bytes);
				if (bytes > 8 * 1_073_741_824) throw new Error(`reopen requested ${bytes} reserve bytes`);
				return original.call(this, bytes, step);
			});
			try {
				const engine = new AuthorityEngine(
					new SqliteAuthorityPersistence({
						path: filename,
						identity,
						create: false,
						capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
					}),
					"r".repeat(36),
				);
				try {
					expect(engine.recover().blocked).toHaveLength(open);
				} finally {
					engine.close();
				}
			} finally {
				growth.mockRestore();
			}
			return Math.max(...requests);
		};
		const perOperation = ((await reopenReserve(OPEN)) - (await reopenReserve(0))) / OPEN;
		// One open operation's own database obligation, priced at the source-pinned 20-level cursor depth (an upper bound
		// on the height the live owner may use). Each operation adds its additive page growth, at most 1/8 database arena
		// slack and its XFS extent metadata; the WAL and the WAL close refund depend only on the largest single
		// transaction, so they add nothing per operation (the old sum-over-later-allocations WAL tripled this).
		const operationDebt = new AuthorityCapacityDebtLedger(identity, ADMISSION, [
			operationRow(binding, "toolu_01bound", "intent", 12),
		]).currentDebt();
		expect(perOperation).toBeGreaterThan(0);
		expect(perOperation).toBeLessThanOrEqual(1.25 * operationDebt.sqliteDatabaseBytes);
	},
	120_000,
);
