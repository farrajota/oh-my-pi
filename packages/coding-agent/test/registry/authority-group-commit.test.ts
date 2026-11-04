import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fsNamespace from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openAuthorityCapacityFile } from "../../src/registry/authority/capacity";
import {
	AuthorityCapacityAdmission,
	AuthorityCapacityRefusedError,
} from "../../src/registry/authority/capacity-sqlite";
import { AuthorityRpcClient, AuthorityRpcError, withAuthorityEffect } from "../../src/registry/authority/client";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import { listJsonlRotationArtifacts } from "../../src/registry/authority/jsonl-layout";
import { SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";
import { AuthorityGroupBoundaryError } from "../../src/registry/authority/types";
import type {
	AuthorityDriverOptions,
	AuthorityIdentity,
	JournalingBackend,
	MutationReceipt,
} from "../../src/registry/authority/types";
import type { DurableOperationRecord } from "../../src/registry/durable-state";

// Real worker opens fund capacity arenas with fallocate/fsync; on a loaded shared host one open plus a
// stalled sync takes seconds, so worker-level cases carry the same order of budget as the other suites.
const WORKER_TEST_BUDGET_MS = 120_000;
const directories: string[] = [];
const clients: AuthorityRpcClient[] = [];
const capacityHandles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	const failures: unknown[] = [];
	for (const client of clients.splice(0)) {
		try {
			await client.close();
		} catch (error) {
			failures.push(error);
		}
	}
	for (const handle of capacityHandles.splice(0)) {
		try {
			await handle.close();
		} catch (error) {
			failures.push(error);
		}
	}
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	if (failures.length) throw new AggregateError(failures, "Group-commit fixture cleanup failed");
}, WORKER_TEST_BUDGET_MS);

async function makeDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-group-commit-"));
	directories.push(directory);
	return directory;
}

function operation(
	operationId: string,
	phase: DurableOperationRecord["phase"] = "intent",
	at = 1,
): DurableOperationRecord {
	return {
		kind: "operation",
		at,
		operationId,
		effectClass: "session",
		ownerId: "root-uuid",
		classOwnerId: "root-uuid",
		acquiredAt: 1,
		expiresAt: 1_000,
		phase,
	};
}

function sqliteOptions(databasePath: string, create: boolean): AuthorityDriverOptions {
	const identity: AuthorityIdentity = {
		backend: "sqlite",
		owningSessionId: "session-1",
		incarnation: "incarnation-1",
		format: 2,
	};
	return { path: databasePath, identity, create };
}

function isCommit(sql: unknown): boolean {
	return typeof sql === "string" && sql.trim().toUpperCase() === "COMMIT";
}

async function settle<T>(
	promise: Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> {
	return promise.then(
		value => ({ ok: true as const, value }),
		error => ({ ok: false as const, error }),
	);
}

describe("SQLite group commit through the engine", () => {
	it("makes every grouped command durable with exactly one COMMIT", async () => {
		const databasePath = path.join(await makeDirectory(), "authority.sqlite");
		const persistence = new SqliteAuthorityPersistence(sqliteOptions(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		expect(engine.groupCommitSupported).toBe(true);
		const exec = spyOn(Database.prototype, "exec");
		try {
			engine.beginGroup();
			const receipts = ["a", "b", "c", "d"].map(id =>
				engine.transition(operation(id), { requestId: `grouped-${id}` }),
			);
			expect(exec.mock.calls.filter(([sql]) => isCommit(sql))).toHaveLength(0);
			engine.syncGroup();
			expect(exec.mock.calls.filter(([sql]) => isCommit(sql))).toHaveLength(1);
			expect(receipts.map(receipt => receipt.revision)).toEqual([
				receipts[0]!.revision,
				receipts[0]!.revision + 1,
				receipts[0]!.revision + 2,
				receipts[0]!.revision + 3,
			]);
		} finally {
			exec.mockRestore();
		}
		engine.close();
		const reopened = new SqliteAuthorityPersistence(sqliteOptions(databasePath, false));
		for (const id of ["a", "b", "c", "d"])
			expect(reopened.get("operation", ["root-uuid", "session", id])?.record).toEqual(operation(id));
		for (const id of ["a", "b", "c", "d"])
			expect(reopened.findReceipt(`grouped-${id}`, "incarnation-1")?.requestId).toBe(`grouped-${id}`);
		reopened.integrityCheck();
		reopened.close();
	});

	for (const [label, hook] of [
		["group sync", "groupCommitted"],
		["single transaction", "committed"],
	] as const) {
		it(`stops admission when capacity settlement throws after a durable COMMIT (${label})`, async () => {
			const directory = await makeDirectory();
			const capacity = await openAuthorityCapacityFile(directory);
			capacityHandles.push(capacity.handle);
			const databasePath = path.join(directory, "authority.sqlite");
			const persistence = new SqliteAuthorityPersistence({
				...sqliteOptions(databasePath, true),
				capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
			});
			const engine = new AuthorityEngine(persistence, "owner-token");
			engine.recover();
			const settlement = spyOn(AuthorityCapacityAdmission.prototype, hook).mockImplementationOnce(() => {
				throw new Error("Injected capacity settlement failure after COMMIT");
			});
			let failure: unknown;
			try {
				if (hook === "groupCommitted") {
					engine.beginGroup();
					engine.transition(operation("settled"), { requestId: "settled" });
					engine.syncGroup();
				} else {
					engine.transition(operation("settled"), { requestId: "settled" });
				}
			} catch (error) {
				failure = error;
			} finally {
				settlement.mockRestore();
			}
			// The commit is durable but its reserve is unsettled: report the outcome as unknown and admit nothing more.
			expect(failure).toMatchObject({ unknownOutcome: true });
			expect(() => engine.transition(operation("after"), { requestId: "after" })).toThrow(
				expect.objectContaining({ unknownOutcome: true }),
			);
			expect(() => engine.close()).toThrow();
			// The engine cannot write its closed-owner frame on an unavailable store; physically close it.
			persistence.close();
			const reopened = new SqliteAuthorityPersistence(sqliteOptions(databasePath, false));
			expect(reopened.get("operation", ["root-uuid", "session", "settled"])?.record).toEqual(operation("settled"));
			expect(reopened.get("operation", ["root-uuid", "session", "after"])).toBeUndefined();
			reopened.close();
		});
	}

	it("rolls back only a refused member and keeps the others and a contiguous revision chain", async () => {
		const databasePath = path.join(await makeDirectory(), "authority.sqlite");
		const persistence = new SqliteAuthorityPersistence(sqliteOptions(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		engine.beginGroup();
		const first = engine.transition(operation("kept-1"), { requestId: "kept-1" });
		expect(() => engine.transition(operation("refused"), { requestId: "refused", expectedRevision: 0 })).toThrow(
			"compare-and-swap",
		);
		const second = engine.transition(operation("kept-2"), { requestId: "kept-2" });
		engine.syncGroup();
		expect(second.revision).toBe(first.revision + 1);
		engine.close();
		const reopened = new SqliteAuthorityPersistence(sqliteOptions(databasePath, false));
		expect(reopened.get("operation", ["root-uuid", "session", "kept-1"])).toBeDefined();
		expect(reopened.get("operation", ["root-uuid", "session", "kept-2"])).toBeDefined();
		expect(reopened.get("operation", ["root-uuid", "session", "refused"])).toBeUndefined();
		expect(reopened.findReceipt("refused", "incarnation-1")).toBeUndefined();
		reopened.integrityCheck();
		reopened.close();
	});

	it("replays a receipt staged earlier in the same group without a second frame", async () => {
		const databasePath = path.join(await makeDirectory(), "authority.sqlite");
		const engine = new AuthorityEngine(
			new SqliteAuthorityPersistence(sqliteOptions(databasePath, true)),
			"owner-token",
		);
		engine.recover();
		engine.beginGroup();
		const first = engine.transition(operation("same"), { requestId: "same-request" });
		const replay = engine.transition(operation("same"), { requestId: "same-request" });
		engine.syncGroup();
		expect(replay).toEqual(first);
		expect(engine.recoveryState().revision).toBe(first.revision);
		engine.close();
	});

	for (const timing of ["before", "after"] as const) {
		it(`reports a group COMMIT failure ${timing} execution as an unknown outcome for the whole group`, async () => {
			const databasePath = path.join(await makeDirectory(), "authority.sqlite");
			const persistence = new SqliteAuthorityPersistence(sqliteOptions(databasePath, true));
			const engine = new AuthorityEngine(persistence, "owner-token");
			engine.recover();
			engine.beginGroup();
			for (const id of ["x", "y", "z"]) engine.transition(operation(id), { requestId: id });
			const original = Database.prototype.exec;
			const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
				this: Database,
				...args: Parameters<Database["exec"]>
			) {
				if (!isCommit(args[0])) return Reflect.apply(original, this, args);
				if (timing === "after") Reflect.apply(original, this, args);
				throw new Error(`Injected group COMMIT failure ${timing} execution`);
			});
			let failure: unknown;
			try {
				engine.syncGroup();
			} catch (error) {
				failure = error;
			} finally {
				exec.mockRestore();
			}
			expect(failure).toMatchObject({ unknownOutcome: true });
			expect(() => persistence.get("operation", ["root-uuid", "session", "x"])).toThrow();
			expect(() => engine.close()).toThrow();
			// The engine cannot write its closed-owner frame on an unavailable store; physically close it.
			persistence.close();
			const reopened = new SqliteAuthorityPersistence(sqliteOptions(databasePath, false));
			const present = ["x", "y", "z"].map(
				id => reopened.get("operation", ["root-uuid", "session", id]) !== undefined,
			);
			// All or nothing: the group is one transaction, never a partial result.
			expect(present).toEqual(timing === "after" ? [true, true, true] : [false, false, false]);
			reopened.integrityCheck();
			reopened.close();
		});
	}

	it("turns a member rollback failure into an unknown outcome for the whole group", async () => {
		const databasePath = path.join(await makeDirectory(), "authority.sqlite");
		const persistence = new SqliteAuthorityPersistence(sqliteOptions(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		engine.beginGroup();
		engine.transition(operation("before-poison"), { requestId: "before-poison" });
		const original = Database.prototype.exec;
		const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
			this: Database,
			...args: Parameters<Database["exec"]>
		) {
			if (typeof args[0] === "string" && args[0].trim().toUpperCase().startsWith("ROLLBACK TO"))
				throw new Error("Injected member rollback failure");
			return Reflect.apply(original, this, args);
		});
		let memberFailure: unknown;
		try {
			engine.transition(operation("refused"), { requestId: "refused", expectedRevision: 0 });
		} catch (error) {
			memberFailure = error;
		} finally {
			exec.mockRestore();
		}
		expect(memberFailure).toMatchObject({ unknownOutcome: true });
		let syncFailure: unknown;
		try {
			engine.syncGroup();
		} catch (error) {
			syncFailure = error;
		}
		expect(syncFailure).toMatchObject({ unknownOutcome: true });
		persistence.close();
		const reopened = new SqliteAuthorityPersistence(sqliteOptions(databasePath, false));
		expect(reopened.get("operation", ["root-uuid", "session", "before-poison"])).toBeUndefined();
		reopened.close();
	});
});

function jsonlOptions(
	file: string,
	create: boolean,
	extra: Partial<AuthorityDriverOptions> = {},
): AuthorityDriverOptions {
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "session-1",
		incarnation: "incarnation-1",
		format: 2,
	};
	return { path: file, identity, create, ...extra };
}

/** Frame lines of a JSONL active segment, after its header. */
async function frameLines(file: string): Promise<string[]> {
	return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).slice(1);
}

describe("JSONL group commit through the engine", () => {
	async function openJsonl(extra: Partial<AuthorityDriverOptions> = {}) {
		const file = path.join(await makeDirectory(), "authority.jsonl");
		const persistence = new JsonlAuthorityPersistence(jsonlOptions(file, true, extra));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		return { file, persistence, engine };
	}

	function reopened(file: string, extra: Partial<AuthorityDriverOptions> = {}): AuthorityEngine {
		return new AuthorityEngine(new JsonlAuthorityPersistence(jsonlOptions(file, false, extra)), "next-owner");
	}

	it("makes every grouped command durable with exactly one sync and no per-member sync", async () => {
		const { file, engine } = await openJsonl();
		expect(engine.groupCommitSupported).toBe(true);
		const fdatasync = spyOn(fsNamespace, "fdatasyncSync");
		const fsync = spyOn(fsNamespace, "fsyncSync");
		try {
			engine.beginGroup();
			const receipts = Array.from({ length: 5 }, (_, index) =>
				engine.transition(operation(`grouped-${index}`), { requestId: `grouped-${index}` }),
			);
			expect(fsync).not.toHaveBeenCalled();
			expect(fdatasync).not.toHaveBeenCalled();
			engine.syncGroup();
			expect(fsync.mock.calls.length + fdatasync.mock.calls.length).toBe(1);
			expect(receipts.map(receipt => receipt.revision)).toEqual(
				receipts.map((_, index) => receipts[0]!.revision + index),
			);
		} finally {
			fdatasync.mockRestore();
			fsync.mockRestore();
		}
		engine.close();
		const next = reopened(file);
		for (let index = 0; index < 5; index++)
			expect(next.getOperation("root-uuid", "session", `grouped-${index}`)).toBeDefined();
		next.close();
	});

	it("rolls back only a refused member and keeps the others and a contiguous revision chain", async () => {
		const { file, engine } = await openJsonl();
		const before = (await frameLines(file)).length;
		engine.beginGroup();
		const first = engine.transition(operation("kept-1"), { requestId: "kept-1" });
		expect(() => engine.transition(operation("refused"), { requestId: "refused", expectedRevision: 0 })).toThrow();
		const last = engine.transition(operation("kept-2"), { requestId: "kept-2" });
		engine.syncGroup();
		expect(last.revision).toBe(first.revision + 1);
		expect((await frameLines(file)).length).toBe(before + 2);
		engine.close();
		const next = reopened(file);
		expect(next.getOperation("root-uuid", "session", "refused")).toBeUndefined();
		expect(next.getOperation("root-uuid", "session", "kept-2")).toBeDefined();
		next.close();
	});

	it("replays a receipt staged earlier in the same group without a second frame", async () => {
		const { file, engine } = await openJsonl();
		engine.beginGroup();
		const receipt = engine.transition(operation("replayed"), { requestId: "replayed" });
		const lines = (await frameLines(file)).length;
		expect(engine.transition(operation("replayed"), { requestId: "replayed" })).toEqual(receipt);
		expect((await frameLines(file)).length).toBe(lines);
		engine.syncGroup();
		engine.close();
	});

	for (const timing of ["before", "after"] as const) {
		it(`reports a group sync failure ${timing} execution as an unknown outcome and makes the store unavailable`, async () => {
			const { engine } = await openJsonl();
			engine.beginGroup();
			for (let index = 0; index < 3; index++)
				engine.transition(operation(`failed-${index}`), { requestId: `failed-${index}` });
			const original = fsNamespace.fsyncSync;
			const fsync = spyOn(fsNamespace, "fsyncSync").mockImplementation((descriptor: number) => {
				if (timing === "after") original(descriptor);
				throw new Error(`Injected sync failure ${timing} execution`);
			});
			let failure: unknown;
			try {
				engine.syncGroup();
			} catch (error) {
				failure = error;
			} finally {
				fsync.mockRestore();
			}
			expect(failure).toMatchObject({ unknownOutcome: true });
			expect(() => engine.transition(operation("after-failure"), { requestId: "after-failure" })).toThrow();
		});
	}

	it("truncates a member whose write fails back to its start and keeps the group", async () => {
		const { file, engine } = await openJsonl();
		engine.beginGroup();
		engine.transition(operation("before-torn"), { requestId: "before-torn" });
		const size = (await fs.stat(file)).size;
		const original = fsNamespace.writeSync;
		let injected = false;
		const write = spyOn(fsNamespace, "writeSync").mockImplementation(((
			descriptor: number,
			buffer: Buffer,
			offset?: number,
			length?: number,
		) => {
			if (!injected) {
				injected = true;
				// Half of the member reaches the file, then the write fails (as on a full disk).
				original(descriptor, buffer, offset ?? 0, Math.floor((length ?? buffer.byteLength) / 2));
				throw Object.assign(new Error("Injected short write"), { code: "ENOSPC" });
			}
			return original(descriptor, buffer, offset, length);
		}) as typeof original);
		let failure: unknown;
		try {
			engine.transition(operation("torn"), { requestId: "torn" });
		} catch (error) {
			failure = error;
		} finally {
			write.mockRestore();
		}
		expect(failure).toMatchObject({ code: "ENOSPC" });
		expect((failure as { unknownOutcome?: boolean }).unknownOutcome).not.toBe(true);
		expect((await fs.stat(file)).size).toBe(size);
		engine.transition(operation("after-torn"), { requestId: "after-torn" });
		engine.syncGroup();
		engine.close();
		const next = reopened(file);
		expect(next.getOperation("root-uuid", "session", "torn")).toBeUndefined();
		expect(next.getOperation("root-uuid", "session", "after-torn")).toBeDefined();
		next.close();
	});

	it("undoes a member whose fence arming fails after its write and keeps the sealed history exportable", async () => {
		const { file, engine, persistence } = await openJsonl({
			jsonlSegment: { minBytes: Number.MAX_SAFE_INTEGER, maxFrames: 6 },
		});
		engine.beginGroup();
		engine.transition(operation("kept"), { requestId: "kept" });
		const size = (await fs.stat(file)).size;
		// The member's bytes are written and read back; arming the fence afterwards fails with a raw error.
		const lutimes = spyOn(fsNamespace, "lutimesSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("Injected lutimes failure"), { code: "EIO" });
		});
		let failure: unknown;
		try {
			engine.transition(operation("undone"), { requestId: "undone" });
		} catch (error) {
			failure = error;
		} finally {
			lutimes.mockRestore();
		}
		expect(failure).toMatchObject({ code: "EIO" });
		expect((failure as { unknownOutcome?: boolean }).unknownOutcome).not.toBe(true);
		expect((await fs.stat(file)).size).toBe(size);
		engine.syncGroup();
		// Rotation seals the active segment with the digest the owner tracked; export reads it back in full.
		for (let index = 0; index < 8; index++)
			engine.transition(operation(`after-${index}`), { requestId: `after-${index}` });
		expect(listJsonlRotationArtifacts(file).some(artifact => artifact.kind === "segment")).toBe(true);
		persistence.integrityCheck();
		engine.close();
		const next = reopened(file, { jsonlSegment: { minBytes: Number.MAX_SAFE_INTEGER, maxFrames: 6 } });
		expect(next.getOperation("root-uuid", "session", "kept")).toBeDefined();
		expect(next.getOperation("root-uuid", "session", "undone")).toBeUndefined();
		next.close();
	});

	it("syncs a member's undo cut before reporting the refusal, with capacity off", async () => {
		// A refused member is a known outcome; if the cut were not durable, writeback of the fully written line could
		// let a reopen replay the refused member as committed.
		const { engine } = await openJsonl();
		engine.beginGroup();
		engine.transition(operation("kept"), { requestId: "kept" });
		const calls: string[] = [];
		const truncate = spyOn(fsNamespace, "ftruncateSync");
		truncate.mockImplementation(((descriptor: number, length?: number) => {
			calls.push(`truncate:${descriptor}`);
			truncate.mockRestore();
			fsNamespace.ftruncateSync(descriptor, length);
		}) as typeof fsNamespace.ftruncateSync);
		const originalFsync = fsNamespace.fsyncSync;
		const fsync = spyOn(fsNamespace, "fsyncSync").mockImplementation(((descriptor: number) => {
			calls.push(`fsync:${descriptor}`);
			originalFsync(descriptor);
		}) as typeof originalFsync);
		const lutimes = spyOn(fsNamespace, "lutimesSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("Injected lutimes failure"), { code: "EIO" });
		});
		let failure: unknown;
		try {
			engine.transition(operation("undone"), { requestId: "undone" });
		} catch (error) {
			failure = error;
		} finally {
			lutimes.mockRestore();
			fsync.mockRestore();
			truncate.mockRestore();
		}
		expect(failure).toMatchObject({ code: "EIO" });
		expect((failure as { unknownOutcome?: boolean }).unknownOutcome).not.toBe(true);
		const cut = calls.findIndex(call => call.startsWith("truncate:"));
		expect(cut).toBeGreaterThanOrEqual(0);
		expect(calls.slice(cut + 1)).toContain(`fsync:${calls[cut]!.slice("truncate:".length)}`);
		engine.syncGroup();
		engine.close();
	});

	it("makes the store unavailable when settlement after a successful group sync fails", async () => {
		const { file, engine } = await openJsonl();
		engine.beginGroup();
		engine.transition(operation("synced"), { requestId: "synced" });
		const original = fsNamespace.lstatSync;
		let calls = 0;
		// The second lstat of the sync is its post-sync settlement observation, after fsync and readback succeeded.
		const lstat = spyOn(fsNamespace, "lstatSync").mockImplementation(((...args: Parameters<typeof original>) => {
			if (args[0] === file && ++calls === 2)
				throw Object.assign(new Error("Injected settlement failure"), { code: "EIO" });
			return original(...args);
		}) as typeof original);
		let failure: unknown;
		try {
			engine.syncGroup();
		} catch (error) {
			failure = error;
		} finally {
			lstat.mockRestore();
		}
		expect(calls).toBe(2);
		expect(failure).toBeInstanceOf(Error);
		// Its members may or may not be reported, but the driver must stop admitting.
		expect(() => engine.transition(operation("after-settlement"), { requestId: "after-settlement" })).toThrow();
	});

	it("keeps a funded journal arena when a member's undo cuts the journal back", async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		capacityHandles.push(capacity.handle);
		const file = path.join(directory, "authority.jsonl");
		const engine = new AuthorityEngine(
			new JsonlAuthorityPersistence(
				jsonlOptions(file, true, { capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 } }),
			),
			"owner-token",
		);
		engine.recover();
		engine.beginGroup();
		engine.transition(operation("funded"), { requestId: "funded" });
		const funded = fsNamespace.statSync(file);
		expect(funded.blocks * 512).toBeGreaterThan(funded.size);
		const original = fsNamespace.writeSync;
		let injected = false;
		const write = spyOn(fsNamespace, "writeSync").mockImplementation(((
			descriptor: number,
			buffer: Buffer,
			offset?: number,
			length?: number,
		) => {
			if (!injected) {
				injected = true;
				original(descriptor, buffer, offset ?? 0, Math.floor((length ?? buffer.byteLength) / 2));
				throw Object.assign(new Error("Injected short write"), { code: "ENOSPC" });
			}
			return original(descriptor, buffer, offset, length);
		}) as typeof original);
		try {
			expect(() => engine.transition(operation("cut"), { requestId: "cut" })).toThrow("Injected short write");
		} finally {
			write.mockRestore();
		}
		// ftruncate frees allocation past the cut; the arena the reserve counted as backing must be allocated again.
		const cut = fsNamespace.statSync(file);
		expect(cut.size).toBe(funded.size);
		expect(cut.blocks * 512).toBeGreaterThanOrEqual(funded.blocks * 512);
		engine.transition(operation("after-cut"), { requestId: "after-cut" });
		engine.syncGroup();
		engine.close();
	});

	it("turns a member whose failed write cannot be truncated into an unknown outcome for the whole group", async () => {
		const { engine } = await openJsonl();
		engine.beginGroup();
		engine.transition(operation("earlier"), { requestId: "earlier" });
		const write = spyOn(fsNamespace, "writeSync").mockImplementation(() => {
			throw new Error("Injected write failure");
		});
		const truncate = spyOn(fsNamespace, "ftruncateSync").mockImplementation(() => {
			throw new Error("Injected truncate failure");
		});
		let failure: unknown;
		try {
			engine.transition(operation("undoable"), { requestId: "undoable" });
		} catch (error) {
			failure = error;
		} finally {
			write.mockRestore();
			truncate.mockRestore();
		}
		expect(failure).toMatchObject({ unknownOutcome: true });
		expect(() => engine.syncGroup()).toThrow(expect.objectContaining({ unknownOutcome: true }));
	});

	it("refuses a later member that capacity cannot fund as a group boundary with nothing appended", async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		capacityHandles.push(capacity.handle);
		const file = path.join(directory, "authority.jsonl");
		const engine = new AuthorityEngine(
			new JsonlAuthorityPersistence(
				jsonlOptions(file, true, { capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 } }),
			),
			"owner-token",
		);
		engine.recover();
		engine.beginGroup();
		engine.transition(operation("funded"), { requestId: "funded" });
		const size = (await fs.stat(file)).size;
		const original = AuthorityCapacityAdmission.prototype.prepare;
		const prepare = spyOn(AuthorityCapacityAdmission.prototype, "prepare").mockImplementationOnce(() => {
			throw new AuthorityCapacityRefusedError(new Error("Injected refusal of a later group member"));
		});
		try {
			expect(() => engine.transition(operation("boundary"), { requestId: "boundary" })).toThrow(
				AuthorityGroupBoundaryError,
			);
		} finally {
			prepare.mockRestore();
		}
		expect(AuthorityCapacityAdmission.prototype.prepare).toBe(original);
		expect((await fs.stat(file)).size).toBe(size);
		engine.syncGroup();
		// The same command runs once more as the first member of its own group.
		engine.beginGroup();
		engine.transition(operation("boundary"), { requestId: "boundary" });
		engine.syncGroup();
		expect(engine.getOperation("root-uuid", "session", "boundary")).toBeDefined();
		engine.close();
	});

	it("never rotates inside a group: a later member that would rotate is a group boundary, the first member rotates", async () => {
		const segment = { minBytes: Number.MAX_SAFE_INTEGER, maxFrames: 4 };
		const { file, engine } = await openJsonl({ jsonlSegment: segment });
		engine.beginGroup();
		let boundary: unknown;
		for (let index = 0; index < 8 && boundary === undefined; index++) {
			try {
				engine.transition(operation(`rotation-${index}`), { requestId: `rotation-${index}` });
			} catch (error) {
				boundary = error;
			}
		}
		expect(boundary).toBeInstanceOf(AuthorityGroupBoundaryError);
		expect(listJsonlRotationArtifacts(file)).toEqual([]);
		engine.syncGroup();
		engine.beginGroup();
		engine.transition(operation("rotating-first"), { requestId: "rotating-first" });
		engine.syncGroup();
		expect(
			listJsonlRotationArtifacts(file)
				.map(artifact => artifact.kind)
				.sort(),
		).toEqual(["index", "segment", "snapshot"]);
		engine.close();
		const next = reopened(file, { jsonlSegment: segment });
		expect(next.getOperation("root-uuid", "session", "rotating-first")).toBeDefined();
		next.close();
	});
});

interface GroupCommitEvent {
	readonly type: "arrive" | "member" | "commit-start" | "commit-end" | "commit-failed" | "post" | "boundary-refusal";
	readonly id?: string;
	readonly method?: string;
	readonly members?: number;
	readonly ok?: boolean;
	readonly unknownOutcome?: boolean;
}

interface GroupCommitFixture {
	readonly client: AuthorityRpcClient;
	readonly rpcIds: Map<string, string>;
	readonly session: string;
	readonly identity: AuthorityIdentity;
	readonly path: string;
	events(mode?: string): Promise<GroupCommitEvent[]>;
	stalling(): Promise<void>;
}

async function openGroupCommitFixture(backend: JournalingBackend): Promise<GroupCommitFixture> {
	const directory = await makeDirectory();
	const session = path.join(directory, "root.jsonl");
	await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
	const control = new Map<string, () => void>();
	const rpcIds = new Map<string, string>();
	// One ordered timeline of worker trace events and RPC responses, as delivered on the worker's port.
	const timeline: GroupCommitEvent[] = [];
	let stall = Promise.withResolvers<void>();
	let current: Worker | undefined;
	const factory = (): Worker => {
		const worker = new Worker(new URL("./authority-group-commit-worker.ts", import.meta.url).href, {
			type: "module",
		});
		worker.addEventListener("message", event => {
			const value = event.data as {
				kind?: unknown;
				id?: unknown;
				ok?: unknown;
				event?: unknown;
				trace?: unknown;
				error?: { unknownOutcome?: unknown };
			};
			if (value?.kind !== "group-commit-test") {
				if (typeof value?.id === "string" && typeof value.ok === "boolean")
					timeline.push({
						type: "post",
						id: value.id,
						ok: value.ok,
						...(value.ok ? {} : { unknownOutcome: value.error?.unknownOutcome === true }),
					});
				return;
			}
			event.stopImmediatePropagation();
			if (value.event === "trace") timeline.push(value.trace as GroupCommitEvent);
			if (value.event === "stalling") stall.resolve();
			if (typeof value.id === "string") control.get(value.id)?.();
		});
		const post = worker.postMessage.bind(worker);
		worker.postMessage = ((message: unknown, ...rest: unknown[]) => {
			const call = message as { kind?: unknown; id?: unknown; args?: unknown };
			if (call?.kind === "call" && typeof call.id === "string" && Array.isArray(call.args)) {
				const options = call.args[1] as { requestId?: unknown } | undefined;
				if (typeof options?.requestId === "string") rpcIds.set(options.requestId, call.id);
			}
			return Reflect.apply(post, worker, [message, ...rest]);
		}) as typeof worker.postMessage;
		current = worker;
		return worker;
	};
	const identity: AuthorityIdentity = {
		backend,
		owningSessionId: "root-uuid",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
	const payload = backend === "sqlite" ? ownership.paths.sqlite : ownership.paths.jsonl;
	// The worker group-commit suite runs with physical capacity (its boundary refusal needs it), so it opts in.
	const client = await AuthorityRpcClient.open({ path: payload, identity, create: true }, ownership, factory, "xfs");
	clients.push(client);
	return {
		client,
		rpcIds,
		session,
		identity,
		path: payload,
		events: async mode => {
			const id = crypto.randomUUID();
			const reply = Promise.withResolvers<void>();
			control.set(id, reply.resolve);
			if (mode !== undefined) stall = Promise.withResolvers<void>();
			current!.postMessage({ kind: "group-commit-test", id, ...(mode === undefined ? {} : { mode }) });
			await reply.promise;
			return [...timeline];
		},
		stalling: () => stall.promise,
	};
}

/** Index of the first `type` event for `id` at or after `from`. */
function eventIndex(events: readonly GroupCommitEvent[], type: GroupCommitEvent["type"], id: string, from = 0): number {
	return events.findIndex((event, index) => index >= from && event.type === type && event.id === id);
}

/** Every successful acknowledgement follows a completed COMMIT that started after the command's member staging. */
function expectAcknowledgedAfterCoveringCommit(events: readonly GroupCommitEvent[], rpcId: string): void {
	const post = eventIndex(events, "post", rpcId);
	expect(post).toBeGreaterThanOrEqual(0);
	const member = events.findLastIndex((event, index) => index < post && event.type === "member" && event.id === rpcId);
	expect(member).toBeGreaterThanOrEqual(0);
	const covering = events.findIndex((event, index) => index > member && index < post && event.type === "commit-end");
	expect(covering).toBeGreaterThan(member);
}

for (const backend of ["sqlite", "jsonl"] as const)
	describe(`${backend} worker group commit over the real client`, () => {
		it(
			"shares one COMMIT among concurrent commands and acknowledges each only after a COMMIT that covers it",
			async () => {
				const fixture = await openGroupCommitFixture(backend);
				await fixture.events("stall");
				const head = fixture.client.transition(operation("concurrent-head"), { requestId: "concurrent-head" });
				await fixture.stalling();
				const before = (await fixture.events()).length;
				const receipts = await Promise.all(
					Array.from({ length: 16 }, (_, index) =>
						fixture.client.transition(operation(`concurrent-${index}`), { requestId: `concurrent-${index}` }),
					),
				);
				await head;
				const events = (await fixture.events()).slice(before);
				expect(receipts.map(receipt => receipt.revision)).toEqual(
					receipts.map((_, index) => receipts[0]!.revision + index),
				);
				// Sixteen commands that queued behind one in-flight sync share exactly one further sync.
				expect(events.filter(event => event.type === "commit-end").map(event => event.members)).toEqual([16]);
				for (let index = 0; index < 16; index++)
					expectAcknowledgedAfterCoveringCommit(events, fixture.rpcIds.get(`concurrent-${index}`)!);
			},
			WORKER_TEST_BUDGET_MS,
		);

		it(
			"groups unsynchronized concurrent commands into fewer COMMITs than commands",
			async () => {
				const fixture = await openGroupCommitFixture(backend);
				const before = (await fixture.events()).length;
				await Promise.all(
					Array.from({ length: 32 }, (_, index) =>
						fixture.client.transition(operation(`free-${index}`), { requestId: `free-${index}` }),
					),
				);
				const events = (await fixture.events()).slice(before);
				const commits = events.filter(event => event.type === "commit-end");
				expect(commits.length).toBeLessThan(32);
				expect(commits.reduce((sum, event) => sum + (event.members ?? 0), 0)).toBe(32);
				for (let index = 0; index < 32; index++)
					expectAcknowledgedAfterCoveringCommit(events, fixture.rpcIds.get(`free-${index}`)!);
			},
			WORKER_TEST_BUDGET_MS,
		);

		it(
			"commits a lone command at once in its own group, without waiting for company",
			async () => {
				const fixture = await openGroupCommitFixture(backend);
				const before = (await fixture.events()).length;
				for (let index = 0; index < 10; index++)
					await fixture.client.transition(operation(`serial-${index}`), { requestId: `serial-${index}` });
				const events = (await fixture.events()).slice(before);
				const commits = events.filter(event => event.type === "commit-end");
				expect(commits.map(event => event.members)).toEqual(Array.from({ length: 10 }, () => 1));
				for (let index = 0; index < 10; index++) {
					const rpcId = fixture.rpcIds.get(`serial-${index}`)!;
					expectAcknowledgedAfterCoveringCommit(events, rpcId);
					// Nothing else (no other arrival, no timer-driven wait) separates a lone command's COMMIT from its ACK.
					const post = eventIndex(events, "post", rpcId);
					expect(events[post - 1]?.type).toBe("commit-end");
				}
			},
			WORKER_TEST_BUDGET_MS,
		);

		it(
			"isolates a refused command inside a concurrent group from the commands around it",
			async () => {
				const fixture = await openGroupCommitFixture(backend);
				await fixture.events("stall");
				const head = fixture.client.transition(operation("head"), { requestId: "head" });
				await fixture.stalling();
				const before = (await fixture.events()).length;
				const outcomes = await Promise.all([
					settle(fixture.client.transition(operation("member-1"), { requestId: "member-1" })),
					settle(
						fixture.client.transition(operation("member-refused"), {
							requestId: "member-refused",
							expectedRevision: 0,
						}),
					),
					settle(fixture.client.transition(operation("member-2"), { requestId: "member-2" })),
				]);
				await head;
				const events = (await fixture.events()).slice(before);
				expect(outcomes[0]!.ok).toBe(true);
				expect(outcomes[2]!.ok).toBe(true);
				expect(outcomes[1]!.ok).toBe(false);
				expect(!outcomes[1]!.ok && outcomes[1]!.error).toMatchObject({ unknownOutcome: false });
				expect(events.filter(event => event.type === "commit-end").map(event => event.members)).toEqual([2]);
				expect(await fixture.client.getOperation("root-uuid", "session", "member-1")).toBeDefined();
				expect(await fixture.client.getOperation("root-uuid", "session", "member-2")).toBeDefined();
				expect(await fixture.client.getOperation("root-uuid", "session", "member-refused")).toBeUndefined();
				const first = outcomes[0]!.ok ? outcomes[0]!.value : undefined;
				const last = outcomes[2]!.ok ? outcomes[2]!.value : undefined;
				expect(last!.revision).toBe(first!.revision + 1);
			},
			WORKER_TEST_BUDGET_MS,
		);

		it(
			"runs each effect callback only after the COMMIT covering its grouped intent",
			async () => {
				const fixture = await openGroupCommitFixture(backend);
				await fixture.events("stall");
				const head = fixture.client.transition(operation("effect-head"), { requestId: "effect-head" });
				await fixture.stalling();
				const observed: Array<{ readonly requestId: string; readonly events: GroupCommitEvent[] }> = [];
				await Promise.all(
					Array.from({ length: 6 }, (_, index) =>
						withAuthorityEffect(fixture.client, async () => {
							const requestId = `effect-intent-${index}`;
							await fixture.client.transition(operation(requestId), { requestId });
							// The external effect callback: it must observe its intent already covered by a completed COMMIT.
							observed.push({ requestId, events: await fixture.events() });
						}),
					),
				);
				await head;
				expect(observed).toHaveLength(6);
				for (const { requestId, events } of observed)
					expectAcknowledgedAfterCoveringCommit(events, fixture.rpcIds.get(requestId)!);
				const all = await fixture.events();
				expect(all.filter(event => event.type === "commit-end").some(event => (event.members ?? 0) >= 2)).toBe(
					true,
				);
			},
			WORKER_TEST_BUDGET_MS,
		);

		for (const timing of ["before", "after"] as const) {
			it(
				`fails every member of a group whose COMMIT fails ${timing} execution with an unknown outcome`,
				async () => {
					const fixture = await openGroupCommitFixture(backend);
					await fixture.events(`stall-then-fail-${timing}-group-commit`);
					const head = fixture.client.transition(operation("failure-head"), { requestId: "failure-head" });
					await fixture.stalling();
					const outcomes = await Promise.all(
						Array.from({ length: 5 }, (_, index) =>
							settle(
								fixture.client.transition(operation(`failed-group-${index}`), {
									requestId: `failed-group-${index}`,
								}),
							),
						),
					);
					expect((await head).requestId).toBe("failure-head");
					// No partial known result: every grouped command is an unknown outcome, none a success or a known failure.
					for (const outcome of outcomes) {
						expect(outcome.ok).toBe(false);
						expect(
							!outcome.ok && outcome.error instanceof AuthorityRpcError && outcome.error.unknownOutcome,
						).toBe(true);
					}
					clients.splice(clients.indexOf(fixture.client), 1);
					await fixture.client.close();
					const ownership = await acquireAuthorityOwnership(fixture.session, {
						owningSessionId: "root-uuid",
						create: false,
					});
					const reopened = await AuthorityRpcClient.open(
						{ path: fixture.path, identity: fixture.identity, create: false },
						ownership,
						undefined,
						"xfs",
					);
					clients.push(reopened);
					const present = await Promise.all(
						Array.from(
							{ length: 5 },
							async (_, index) =>
								(await reopened.getOperation("root-uuid", "session", `failed-group-${index}`)) !== undefined,
						),
					);
					// SQLite discards an uncommitted group. JSONL members were appended before the sync, so after a process-level
					// failure they persist; either way none was acknowledged and every one was reported as an unknown outcome.
					expect(present).toEqual(Array.from({ length: 5 }, () => timing === "after" || backend === "jsonl"));
					expect(await reopened.getOperation("root-uuid", "session", "failure-head")).toBeDefined();
				},
				WORKER_TEST_BUDGET_MS,
			);
		}

		it(
			"retries a member refused only because of grouping as the first member of the next group",
			async () => {
				const fixture = await openGroupCommitFixture(backend);
				await fixture.events("stall-then-refuse-second-member");
				const head = fixture.client.transition(operation("boundary-head"), { requestId: "boundary-head" });
				await fixture.stalling();
				const before = (await fixture.events()).length;
				const receipts: MutationReceipt[] = await Promise.all(
					Array.from({ length: 4 }, (_, index) =>
						fixture.client.transition(operation(`boundary-${index}`), { requestId: `boundary-${index}` }),
					),
				);
				await head;
				const events = (await fixture.events()).slice(before);
				expect(events.filter(event => event.type === "boundary-refusal")).toHaveLength(1);
				expect(receipts.map(receipt => receipt.revision)).toEqual(
					receipts.map((_, index) => receipts[0]!.revision + index),
				);
				const commits = events.filter(event => event.type === "commit-end");
				expect(commits.length).toBeGreaterThanOrEqual(2);
				expect(commits.reduce((sum, event) => sum + (event.members ?? 0), 0)).toBe(4);
				for (let index = 0; index < 4; index++)
					expectAcknowledgedAfterCoveringCommit(events, fixture.rpcIds.get(`boundary-${index}`)!);
			},
			WORKER_TEST_BUDGET_MS,
		);
	});

for (const backend of ["sqlite", "jsonl"] as const)
	describe(`${backend} group commit crash cuts`, () => {
		for (const cut of ["before", "after"] as const) {
			// A killed process loses no page cache: JSONL members appended before the sync survive it unacknowledged.
			const groupSurvives = cut === "after" || backend === "jsonl";
			it(`keeps acknowledged commands durable and the unacknowledged group ${groupSurvives ? "durable but unacknowledged" : "absent"} when killed ${cut} the group sync`, async () => {
				const directory = await makeDirectory();
				const session = path.join(directory, "root.jsonl");
				await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
				const marker = path.join(directory, "cut.json");
				const progress = path.join(directory, "progress.jsonl");
				const child = Bun.spawn(
					[
						process.execPath,
						"--no-env-file",
						path.join(import.meta.dir, "authority-group-commit-process.ts"),
						session,
						marker,
						progress,
						`stall-then-cut-${cut}-group-commit`,
						backend,
					],
					{
						cwd: path.resolve(import.meta.dir, "../.."),
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const deadline = Date.now() + 60_000;
				let reached: { phase: string; members: number } | undefined;
				// The worker blocks forever at the cut, so waiting for the head's ACK line as well is race-free.
				while (Date.now() < deadline) {
					const text = await fs.readFile(marker, "utf8").catch(() => undefined);
					const lines = await fs.readFile(progress, "utf8").catch(() => "");
					if (text && lines.includes('"requestId":"stalled-single"')) {
						reached = JSON.parse(text);
						break;
					}
					if (child.exitCode !== null) break;
					await Bun.sleep(20);
				}
				child.kill("SIGKILL");
				await child.exited;
				const childOutput = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
				expect(reached, childOutput).toEqual({ phase: cut, members: 6 });
				const events = (await fs.readFile(progress, "utf8"))
					.trim()
					.split("\n")
					.map(
						line =>
							JSON.parse(line) as {
								event: string;
								requestId?: string;
								identity?: AuthorityIdentity;
								path?: string;
							},
					);
				const opened = events.find(event => event.event === "opened")!;
				const acknowledged = events.filter(event => event.event === "ack").map(event => event.requestId);
				expect(acknowledged).toEqual(["acked-before-cut", "stalled-single"]);
				const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: false });
				const reopened = await AuthorityRpcClient.open(
					{ path: opened.path!, identity: opened.identity!, create: false },
					ownership,
					undefined,
					"xfs",
				);
				clients.push(reopened);
				for (const requestId of acknowledged)
					expect(await reopened.getOperation("root-uuid", "session", requestId!)).toBeDefined();
				const burst = await Promise.all(
					Array.from(
						{ length: 6 },
						async (_, index) =>
							(await reopened.getOperation("root-uuid", "session", `burst-${index}`)) !== undefined,
					),
				);
				expect(burst).toEqual(Array.from({ length: 6 }, () => groupSurvives));
			}, 120_000);
		}
	});
