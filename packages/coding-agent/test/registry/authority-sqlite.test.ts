import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AuthorityCommitFrame,
	AuthorityControlChange,
	AuthorityDriverOptions,
	AuthorityExpectation,
	AuthorityExport,
	AuthorityMeta,
	AuthorityMetaUpdate,
	AuthorityIdentity,
	AuthorityRow,
} from "../../src/registry/authority/types";
import {
	AuthorityEngine,
	authorityExportFromLegacy,
	authorityFrameContentHash,
	authorityFrameHash,
	authorityGenesisHash,
} from "../../src/registry/authority/engine";
import { canonicalDurableSha256, durableRootHeadHash } from "../../src/registry/durable-state";
import type {
	DurableActorRecord,
	DurableJournalRecord,
	DurableRegistryRecord,
	DurableRegistryRecoverySnapshot,
} from "../../src/registry/durable-state";
import {
	SqliteAuthorityConstructionError,
	SqliteAuthorityPersistence,
} from "../../src/registry/authority/sqlite-driver";
import { cesu8Encode, sqliteAuthorityOrderKey } from "../../src/registry/authority/sqlite-codec";
import { openAuthorityCapacityFile } from "../../src/registry/authority/capacity";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { AuthorityRpcClient } from "../../src/registry/authority/client";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import {
	bindSessionOperationAuthority,
	bindSessionOperationDurability,
	getOperationTerminal,
	installSessionOperationLedger,
	issueBoundSessionOperationAuthority,
	runFilesystemOperation,
} from "../../src/registry/operation-lease";
import type { SessionOperationControl } from "../../src/registry/operation-lease";
import { xfsCapacityHost } from "./authority-capacity-host";

// Cases that fund real XFS capacity under os.tmpdir(); see authority-capacity-host.ts for when a host qualifies.
const itOnXfs = it.skipIf(!xfsCapacityHost);

const temporaryDirectories: string[] = [];

async function createLocation(): Promise<{ directory: string; databasePath: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-sqlite-"));
	temporaryDirectories.push(directory);
	return { directory, databasePath: path.join(directory, "authority.sqlite") };
}

function options(
	databasePath: string,
	create: boolean,
	identity: AuthorityIdentity = {
		backend: "sqlite",
		owningSessionId: "session-1",
		incarnation: "incarnation-1",
		format: 2,
	},
): AuthorityDriverOptions {
	return { path: databasePath, identity, create };
}

function frame(
	revision: number,
	previousHash: string,
	changes: readonly AuthorityRow[],
	expected: readonly AuthorityExpectation[],
	controls: readonly AuthorityControlChange[],
	requestId = `request-${revision}`,
	command: AuthorityCommitFrame["command"] = {
		kind: "transition-batch",
		records: changes.map(change => change.record),
	},
): AuthorityCommitFrame {
	const request = { requestId, incarnation: "incarnation-1", ownerEpoch: 1, ownerToken: "owner-token" };
	const payloadHash = canonicalDurableSha256(command);
	const committedAt = revision;
	const receipt = {
		requestId,
		ownerEpoch: 1,
		revision,
		payloadHash,
		incarnation: "incarnation-1",
		commandKind: command.kind,
		committedAt,
		result: { kind: "mutation" as const },
	};
	const content = {
		version: 2 as const,
		kind: "commit" as const,
		revision,
		request,
		command,
		payloadHash,
		expected,
		changes,
		controls,
		receipt,
		previousHash,
		committedAt,
	};
	const contentHash = authorityFrameContentHash(content);
	return { ...content, contentHash, hash: authorityFrameHash({ version: 2, revision, previousHash, contentHash }) };
}

function metadata(revision: number, generationHighWater = 0): AuthorityControlChange {
	return {
		key: "meta",
		deleted: false,
		value: { revision, generationHighWater, status: "ready" },
	};
}

function operation(ownerId: string, operationId: string, phase: "intent" | "effect" | "committed" | "completed") {
	return {
		kind: "operation" as const,
		at: 1,
		operationId,
		effectClass: "mcp" as const,
		ownerId,
		classOwnerId: ownerId,
		acquiredAt: 1,
		expiresAt: 10,
		phase,
	};
}

function sqliteResetObserverWorker() {
	const workerModule = new URL("../../src/registry/authority/worker.ts", import.meta.url).href;
	const admissionModule = new URL("../../src/registry/authority/capacity-sqlite.ts", import.meta.url).href;
	const poolModule = new URL("../../src/registry/authority/capacity-native.ts", import.meta.url).href;
	const source = `
		import { parentPort } from "node:worker_threads";
		import { Database, constants } from "bun:sqlite";
		import { AuthorityCapacityAdmission } from ${JSON.stringify(admissionModule)};
		import { BorrowedAuthorityCapacityPool } from ${JSON.stringify(poolModule)};
		import { runAuthorityWorker } from ${JSON.stringify(workerModule)};
		let liveDatabase;
		let heldStatement;
		let heldIterator;
		let lastResetFault;
		let capturePrepareRefusal = false;
		let holdReaderAfterIntentCommit = false;
		let pool;
		let observePoolGrowth = false;
		function emit(event, details = {}) {
			parentPort.postMessage({ kind: "sqlite-reset-test-observation", event, ...details });
		}
		function errorEvidence(error) {
			return {
				name: error instanceof Error ? error.name : typeof error,
				code: error && typeof error === "object" ? error.code : undefined,
				errno: error && typeof error === "object" ? error.errno : undefined,
				message: error instanceof Error ? error.message : String(error),
			};
		}
		function releaseReader() {
			const failures = [];
			if (heldIterator) {
				try {
					const result = heldIterator.return();
					if (!result.done) throw new Error("SQLite reset test iterator did not return as done.");
					heldIterator = undefined;
				} catch (error) { failures.push(error); }
			}
			if (heldStatement) {
				try {
					heldStatement.finalize();
					heldStatement = undefined;
					heldIterator = undefined;
				} catch (error) { failures.push(error); }
			}
			if (failures.length) {
				emit("reader-release-failure", { failures: failures.map(errorEvidence) });
				throw new AggregateError(failures, "SQLite reset test reader cleanup failed.");
			}
			emit("reader-released", { iteratorReturned: true, statementFinalized: true });
		}
		function holdReader(database) {
			if (!database || database !== liveDatabase) throw new Error("The same configured exclusive SQLite connection was not captured.");
			if (heldStatement || heldIterator) throw new Error("A SQLite reset test reader is already held.");
			heldStatement = database.query("SELECT revision FROM authority_frames ORDER BY revision");
			try {
				heldIterator = heldStatement.iterate();
				const first = heldIterator.next();
				if (first.done) throw new Error("SQLite reset test reader returned no committed frame.");
				emit("reader-held", { revision: first.value.revision });
			} catch (error) {
				try { releaseReader(); }
				catch (cleanupError) { throw new AggregateError([error, cleanupError], "SQLite reset test reader acquisition and cleanup both failed.", { cause: error }); }
				throw error;
			}
		}
		const originalExec = Database.prototype.exec;
		Database.prototype.exec = new Proxy(originalExec, {
			apply(target, database, args) {
				const result = Reflect.apply(target, database, args);
				// Identify the live handle by its native main-file lock, not by how configuration statements are batched.
				if (!liveDatabase && !database.inTransaction) {
					const lockState = new Int32Array([-1, 0]);
					if (database.fileControl("main", constants.SQLITE_FCNTL_LOCKSTATE, lockState) === 0 && lockState[0] === 4) liveDatabase = database;
				}
				return result;
			},
		});
		const originalQuery = Database.prototype.query;
		Database.prototype.query = new Proxy(originalQuery, {
			apply(target, database, args) {
				const statement = Reflect.apply(target, database, args);
				// Observe every post-COMMIT WAL reconciliation statement: the NOOP frame read that decides
				// whether a reset is due, and the RESTART reset itself. A held reader refuses both.
				if (database !== liveDatabase || typeof args[0] !== "string" || !args[0].startsWith("PRAGMA wal_checkpoint(")) return statement;
				const mode = args[0];
				return new Proxy(statement, {
					get(target, property) {
						if (property === "get") {
							const get = Reflect.get(target, property, target);
							return (...getArgs) => {
								const inTransaction = database.inTransaction;
								try {
									const result = Reflect.apply(get, target, getArgs);
									emit("wal-restart", { inTransaction, mode, result });
									return result;
								} catch (error) {
									if (error && typeof error === "object" && (error.code === "SQLITE_LOCKED" || error.errno === 6)) lastResetFault = error;
									emit("wal-restart", { inTransaction, mode, error: errorEvidence(error) });
									throw error;
								}
							};
						}
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			},
		});
		const originalPoolOpen = BorrowedAuthorityCapacityPool.open;
		BorrowedAuthorityCapacityPool.open = new Proxy(originalPoolOpen, {
			apply(target, receiver, args) {
				const opened = Reflect.apply(target, receiver, args);
				pool = opened;
				return opened;
			},
		});
		const originalEnsureDataBytes = BorrowedAuthorityCapacityPool.prototype.ensureDataBytes;
		BorrowedAuthorityCapacityPool.prototype.ensureDataBytes = new Proxy(originalEnsureDataBytes, {
			apply(target, currentPool, args) {
				if (!observePoolGrowth) return Reflect.apply(target, currentPool, args);
				const before = currentPool.inspect();
				const requested = args[0];
				const targetBytes = Math.ceil(requested / before.blockSize) * before.blockSize;
				emit("pool-ensure", { before, requested, targetBytes, samePool: currentPool === pool });
				const result = Reflect.apply(target, currentPool, args);
				emit("pool-ensure-result", { before, result, targetBytes, samePool: currentPool === pool });
				return result;
			},
		});
		const originalPrepare = AuthorityCapacityAdmission.prototype.prepare;
		AuthorityCapacityAdmission.prototype.prepare = new Proxy(originalPrepare, {
			apply(target, admission, args) {
				try { return Reflect.apply(target, admission, args); }
				catch (error) {
					if (capturePrepareRefusal) {
						capturePrepareRefusal = false;
						const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
						emit("prepare-refusal", { sameNativeFault: cause === lastResetFault,
							error: errorEvidence(error), cause: errorEvidence(cause), nativeResetFault: errorEvidence(lastResetFault) });
					}
					throw error;
				}
			},
		});
		const originalCommitted = AuthorityCapacityAdmission.prototype.committed;
		AuthorityCapacityAdmission.prototype.committed = new Proxy(originalCommitted, {
			apply(target, admission, args) {
				const [frame, database] = args;
				const result = Reflect.apply(target, admission, args);
				if (holdReaderAfterIntentCommit && database === liveDatabase && frame?.command?.kind === "transition" &&
					frame.command.record?.kind === "operation" && frame.command.record.phase === "intent" && frame.command.record.effectClass === "filesystem") {
					holdReaderAfterIntentCommit = false;
					if (!pool) throw new Error("The actual borrowed capacity pool was not captured.");
					observePoolGrowth = true;
					emit("pool-observation-start", { state: pool.inspect() });
					holdReader(database);
				}
				return result;
			},
		});
		const originalClose = Database.prototype.close;
		Database.prototype.close = new Proxy(originalClose, {
			apply(target, database, args) {
				if (database === liveDatabase) emit("database-close", { readerHeld: heldIterator !== undefined || heldStatement !== undefined });
				return Reflect.apply(target, database, args);
			},
		});
		parentPort.on("message", message => {
			if (!message || typeof message !== "object" || message.kind !== "sqlite-reset-test-control") return;
			try {
				if (message.action === "release-reader") releaseReader();
				else if (message.action === "observe-refusal") capturePrepareRefusal = true;
				else if (message.action === "finish-pool-observation") {
					if (!observePoolGrowth || !pool) throw new Error("Pool growth observation was not started.");
					emit("pool-observation-end", { state: pool.inspect() });
					observePoolGrowth = false;
				}
				else if (message.action === "arm-intent-reader") {
					if (!liveDatabase) throw new Error("The live exclusive SQLite connection was not captured.");
					if (heldStatement || heldIterator || holdReaderAfterIntentCommit) throw new Error("SQLite reset test reader is already held or armed.");
					holdReaderAfterIntentCommit = true;
				}
				else throw new Error("Unknown SQLite reset test control action.");
				parentPort.postMessage({ kind: "sqlite-reset-test-control-result", id: message.id, ok: true });
			} catch (error) {
				parentPort.postMessage({ kind: "sqlite-reset-test-control-result", id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) });
			}
		});
		await runAuthorityWorker();
	`;
	const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	const events: Array<Record<string, unknown>> = [];
	type ControlResponse = { ok: boolean; message?: string };
	const pendingControls = new Map<string, PromiseWithResolvers<ControlResponse>>();
	let worker: Worker | undefined;
	let capacityIdentity: { fd: number; device: bigint; inode: bigint } | undefined;
	let readerHeld = false;
	let databaseCloseObserved = false;
	let unavailable: unknown;
	let channelUnavailable = false;
	const failControls = (error: unknown, readerUncertain = true) => {
		if (channelUnavailable) return;
		channelUnavailable = true;
		unavailable = error;
		// A lost channel cannot prove whether the worker retained a reader.
		if (readerUncertain) readerHeld = true;
		for (const pending of pendingControls.values()) pending.reject(error);
		pendingControls.clear();
	};
	const factory = (): Worker => {
		const current = new Worker(url, { type: "module" });
		current.addEventListener("error", event =>
			failControls(event.error ?? new Error(event.message || "SQLite reset test worker failed.")),
		);
		current.addEventListener("messageerror", () =>
			failControls(new Error("SQLite reset test worker delivered an unreadable message.")),
		);
		current.addEventListener("close", () => failControls(new Error("SQLite reset test worker channel closed.")));
		current.addEventListener("message", event => {
			const value: unknown = event.data;
			if (!value || typeof value !== "object" || !("kind" in value)) return;
			const message = value as Record<string, unknown>;
			if (message.kind === "sqlite-reset-test-observation") {
				event.stopImmediatePropagation();
				events.push(message);
				if (message.event === "reader-held") readerHeld = true;
				if (message.event === "reader-released" && !channelUnavailable) readerHeld = false;
				if (message.event === "reader-release-failure") readerHeld = true;
				if (message.event === "database-close" && message.readerHeld === false) databaseCloseObserved = true;
				return;
			}
			if (message.kind === "sqlite-reset-test-control-result" && typeof message.id === "string") {
				event.stopImmediatePropagation();
				const pending = pendingControls.get(message.id);
				if (!pending) return;
				pendingControls.delete(message.id);
				pending.resolve({
					ok: message.ok === true,
					...(typeof message.message === "string" ? { message: message.message } : {}),
				});
			}
		});
		worker = current;
		return new Proxy(current, {
			get(target, property) {
				if (property === "terminate")
					return () => {
						failControls(
							new Error("SQLite reset test worker was terminated."),
							!databaseCloseObserved || readerHeld || pendingControls.size > 0,
						);
						return target.terminate();
					};
				if (property === "postMessage")
					return (message: unknown) => {
						if (
							message &&
							typeof message === "object" &&
							"kind" in message &&
							message.kind === "open" &&
							"driver" in message
						) {
							const borrowed = (message.driver as AuthorityDriverOptions).capacity?.identity;
							if (borrowed) capacityIdentity = { ...borrowed };
						}
						target.postMessage(message);
					};
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	return {
		factory,
		events,
		get capacityIdentity() {
			return capacityIdentity;
		},
		get readerHeld() {
			return readerHeld;
		},
		control: async (
			action: "release-reader" | "observe-refusal" | "arm-intent-reader" | "finish-pool-observation",
		): Promise<void> => {
			if (channelUnavailable) throw unavailable;
			if (!worker) throw new Error("SQLite reset test worker has not started.");
			const id = crypto.randomUUID();
			const pending = Promise.withResolvers<ControlResponse>();
			pendingControls.set(id, pending);
			try {
				worker.postMessage({ kind: "sqlite-reset-test-control", id, action });
			} catch (error) {
				failControls(error);
			}
			const response = await pending.promise;
			if (!response.ok) throw new Error(response.message ?? "SQLite reset test worker control failed.");
		},
		dispose: () => {
			failControls(new Error("SQLite reset test observer was disposed."));
			URL.revokeObjectURL(url);
		},
	};
}

function putReceipt(controlChanges: AuthorityControlChange[], value: AuthorityCommitFrame["receipt"]): void {
	controlChanges.push({
		key: `receipt:${JSON.stringify([value.incarnation, value.ownerEpoch, value.requestId])}`,
		deleted: false,
		value,
	});
}

function makeCommit(
	revision: number,
	previousHash: string,
	changes: readonly AuthorityRow[],
	expected: readonly AuthorityExpectation[],
	extraControls: readonly AuthorityControlChange[] = [],
	generationHighWater = 0,
	command: AuthorityCommitFrame["command"] = {
		kind: "transition-batch",
		records: changes.map(change => change.record),
	},
): AuthorityCommitFrame {
	const controls: AuthorityControlChange[] = [metadata(revision, generationHighWater), ...extraControls];
	const result = frame(revision, previousHash, changes, expected, controls, `request-${revision}`, command);
	putReceipt(controls, result.receipt);
	return frame(revision, previousHash, changes, expected, controls, `request-${revision}`, command);
}

function rewriteCommit(
	commit: AuthorityCommitFrame,
	updates: Partial<Pick<AuthorityCommitFrame, "revision" | "previousHash" | "command" | "expected" | "changes">>,
): AuthorityCommitFrame {
	const rewritten = { ...commit, ...updates };
	const payloadHash = canonicalDurableSha256(rewritten.command);
	const receipt = { ...rewritten.receipt, revision: rewritten.revision, payloadHash };
	const controls = rewritten.controls.map(control => {
		if (control.key === "meta" && !control.deleted)
			return { ...control, value: { ...(control.value as AuthorityMetaUpdate), revision: rewritten.revision } };
		if (control.key.startsWith("receipt:") && !control.deleted) return { ...control, value: receipt };
		return control;
	});
	const content = { ...rewritten, payloadHash, receipt, controls };
	const contentHash = authorityFrameContentHash(content);
	return { ...content, contentHash, hash: authorityFrameHash({ ...content, contentHash }) };
}

function activateRoot(engine: AuthorityEngine, rootId: string, generation: number) {
	const startupHash = canonicalDurableSha256(`${rootId}-startup`);
	const provenanceHash = canonicalDurableSha256(`${rootId}-provenance`);
	const headHash = durableRootHeadHash({ rootId, generation, actorId: rootId, startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		at: 1,
		rootId,
		actorId: rootId,
		generation,
		startupHash,
		provenanceHash,
		phase: "reserved" as const,
	};
	engine.transitionBatch(
		[
			construction,
			{ ...construction, at: 2, phase: "constructing" },
			{ ...construction, at: 3, phase: "constructed" },
		],
		{ requestId: `${rootId}-construction` },
	);
	const root = { kind: "root" as const, at: 4, rootId, generation, headHash, state: "active" as const };
	const actor = {
		kind: "actor" as const,
		at: 4,
		actorId: rootId,
		rootId,
		generation,
		rootGeneration: generation,
		rootHeadHash: headHash,
		startupHash,
		provenanceHash,
		state: "active" as const,
	};
	const activatedConstruction = { ...construction, at: 4, phase: "activated" as const };
	const gate = { kind: "gate" as const, at: 4, rootId, generation, phase: "open" as const };
	engine.activateAuthority(
		{ root, actor, construction: activatedConstruction, gate },
		{ requestId: `${rootId}-activation` },
	);
	return { root, actor, construction: activatedConstruction, gate };
}

function legacyLineage() {
	const hash = canonicalDurableSha256;
	const startupHash = hash("root-startup");
	const provenanceHash = hash("root-provenance");
	const headHash = durableRootHeadHash({
		rootId: "legacy-root",
		generation: 5,
		actorId: "legacy-root",
		startupHash,
		provenanceHash,
	});
	const root = {
		kind: "root" as const,
		at: 1,
		rootId: "legacy-root",
		generation: 5,
		headHash,
		state: "active" as const,
	};
	const parent: DurableActorRecord = {
		kind: "actor",
		at: 2,
		actorId: root.rootId,
		rootId: root.rootId,
		generation: 5,
		rootGeneration: 5,
		rootHeadHash: headHash,
		startupHash,
		provenanceHash,
		state: "active",
	};
	const child: DurableActorRecord = {
		...parent,
		at: 3,
		actorId: "legacy-child",
		parentId: parent.actorId,
		generation: 2,
		startupHash: hash("child-startup"),
		provenanceHash: hash("child-provenance"),
	};
	return { root, parent, child, records: [root, parent, child] };
}

function legacySource(records: readonly DurableRegistryRecord[]) {
	let previousHash = authorityGenesisHash();
	const entries: DurableJournalRecord[] = records.map((record, index) => {
		const base = {
			version: 1 as const,
			sequence: index + 1,
			previousHash,
			contentHash: canonicalDurableSha256(record),
			record,
		};
		const entry = { ...base, hash: canonicalDurableSha256(base) };
		previousHash = entry.hash;
		return entry;
	});
	return { sourceSha256: canonicalDurableSha256("legacy-source"), entries };
}

function legacySeed(identity: AuthorityIdentity) {
	const { root, parent, child, records } = legacyLineage();
	const legacy = legacySource(records);
	const last = legacy.entries[legacy.entries.length - 1]!;
	const snapshot: DurableRegistryRecoverySnapshot = {
		available: true,
		head: { sequence: last.sequence, hash: last.hash },
		roots: new Map([[root.rootId, root]]),
		actors: new Map([
			[parent.actorId, parent],
			[child.actorId, child],
		]),
		constructions: new Map(),
		gates: new Map(),
		operations: new Map(),
		transitions: new Map(),
		resources: new Map(),
		localHeads: new Map(),
		localEntries: new Map(),
	};
	return authorityExportFromLegacy(identity, { ...legacy, snapshot });
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("SQLite authority persistence", () => {
	it("refuses missing and corrupt selected stores without creating or replacing them", async () => {
		const { databasePath } = await createLocation();
		expect(() => new SqliteAuthorityPersistence(options(databasePath, false))).toThrow();
		expect(await fs.stat(databasePath).catch(() => undefined)).toBeUndefined();

		await fs.writeFile(databasePath, "not a sqlite database");
		expect(() => new SqliteAuthorityPersistence(options(databasePath, false))).toThrow();
		expect(await fs.readFile(databasePath, "utf8")).toBe("not a sqlite database");
	});

	it("uses private WAL, full-sync, foreign-key storage and passes physical integrity checks", async () => {
		const { databasePath } = await createLocation();
		const originalExec = Database.prototype.exec;
		const observed: { writer?: Database } = {};
		Database.prototype.exec = new Proxy(originalExec, {
			apply(target, database, args) {
				const result = Reflect.apply(target, database, args);
				if (args[0] === "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;") {
					observed.writer = database as Database;
				}
				return result;
			},
		});
		let persistence: SqliteAuthorityPersistence;
		try {
			persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		} finally {
			Database.prototype.exec = originalExec;
		}
		try {
			const stats = await fs.stat(databasePath);
			const engine = new AuthorityEngine(persistence, "foreign-key-owner");
			engine.recover();
			const record = operation("foreign-key-owner", "foreign-key-operation", "intent");
			engine.transition(record, { requestId: "foreign-key-receipt" });
			engine.transition({ ...record, at: 2, phase: "effect" }, { requestId: "foreign-key-operation-effect" });
			engine.transition({ ...record, at: 3, phase: "committed" }, { requestId: "foreign-key-operation-committed" });
			engine.transition({ ...record, at: 4, phase: "completed" }, { requestId: "foreign-key-operation-completed" });
			expect(stats.mode & 0o777).toBe(0o600);
			const writer = observed.writer;
			if (!writer) throw new Error("SQLite authority writer configuration was not observed.");
			expect(writer.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
			expect(writer.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
			expect(writer.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
			expect(writer.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
			const database = new Database(databasePath);
			try {
				expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
				expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
				database.exec("PRAGMA foreign_keys=ON");
				// The receipt is a projection of its immutable frame row, found through one unique receipt index.
				const request = database
					.query<{ revision: number }, [Uint8Array]>("SELECT revision FROM authority_frames WHERE request_id = ?")
					.get(cesu8Encode("foreign-key-receipt"));
				if (!request) throw new Error("Receipt request identity is absent from its frame row.");
				expect(() => database.run("DELETE FROM authority_frames WHERE revision = ?", [request.revision])).toThrow(
					"immutable",
				);
				expect(() =>
					database.run("UPDATE authority_frames SET receipt = '{}' WHERE revision = ?", [request.revision]),
				).toThrow("immutable");
				expect(
					database.query("SELECT revision FROM authority_frames WHERE revision = ?").get(request.revision),
				).toEqual(request);
				expect(
					database
						.query<{ name: string }, []>("PRAGMA index_info('authority_frames_receipt')")
						.all()
						.map(column => column.name),
				).toEqual(["incarnation", "request_id", "epoch"]);
				expect(
					database
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_schema WHERE name IN ('authority_strings', 'authority_receipts')",
						)
						.all(),
				).toEqual([]);
				expect(database.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
			} finally {
				database.close();
			}
			persistence.integrityCheck();
		} finally {
			persistence.close();
		}
	});
	it("physically closes before stable WAL capture and reopens complete history for recovery", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		const record = operation("close-owner", "close-operation", "intent");
		engine.transition(record, { requestId: "close-operation-intent" });
		engine.transition({ ...record, at: 2, phase: "effect" }, { requestId: "close-operation-effect" });
		const exported = persistence.exportState();
		const receiptKey = `receipt:${JSON.stringify([exported.frames.at(-1)!.receipt.incarnation, exported.frames.at(-1)!.receipt.ownerEpoch, exported.frames.at(-1)!.receipt.requestId])}`;
		expect(persistence.getControl(receiptKey)).toEqual(exported.frames.at(-1)!.receipt);
		expect(persistence.scan("operation", { openOnly: true, limit: 10 }).rows).toHaveLength(1);
		persistence.integrityCheck();
		persistence.scanControl("receipt:", undefined, 10);
		expect((await fs.readFile(`${databasePath}-wal`)).byteLength).toBeGreaterThan(0);
		persistence.close();

		const capture = await Promise.all(
			["", "-wal", "-shm"].map(async suffix => {
				const file = `${databasePath}${suffix}`;
				try {
					return [suffix, await fs.readFile(file)] as const;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return [suffix, undefined] as const;
					throw error;
				}
			}),
		);
		const stableCapture = await Promise.all(
			capture.map(async ([suffix]) => {
				try {
					return [suffix, await fs.readFile(`${databasePath}${suffix}`)] as const;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return [suffix, undefined] as const;
					throw error;
				}
			}),
		);
		expect(stableCapture).toEqual(capture);
		const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
		expect(reopened.exportState()).toEqual(exported);
		expect(reopened.getControl(receiptKey)).toEqual(exported.frames.at(-1)!.receipt);
		expect(reopened.get("operation", [record.ownerId, record.effectClass, record.operationId])).toEqual({
			record: { ...record, at: 2, phase: "effect" },
			version: 2,
		});
		const recovery = new AuthorityEngine(reopened, "reopened-owner").recover();
		expect(recovery.revision).toBe(exported.revision + 1);
		expect(recovery.blocked.length).toBeGreaterThan(0);
		reopened.integrityCheck();
		reopened.close();
	});
	it("retains failed constructor close ownership until the exact database physically closes", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(path.join(directory, "retry-seed-source.sqlite"), true));
		const seed = source.exportState();
		source.close();
		const closeFailure = new Error("injected physical close boundary failure");
		const originalClose = Database.prototype.close;
		const attemptedDatabases: Database[] = [];
		const actualCloseDatabases: Database[] = [];
		const closeForceArguments: unknown[] = [];
		let injectFailure = true;
		Database.prototype.close = new Proxy(originalClose, {
			apply(target, database, args) {
				if (database instanceof Database) {
					attemptedDatabases.push(database);
					closeForceArguments.push(args[0]);
					if (injectFailure) {
						injectFailure = false;
						throw closeFailure;
					}
				}
				const result = Reflect.apply(target, database, args);
				if (database instanceof Database) actualCloseDatabases.push(database);
				return result;
			},
		});
		let constructionFailure: unknown;
		try {
			new SqliteAuthorityPersistence({ ...options(databasePath, true), seed: { ...seed, revision: -1 } });
		} catch (error) {
			constructionFailure = error;
		}
		try {
			expect(constructionFailure).toBeInstanceOf(SqliteAuthorityConstructionError);
			if (!(constructionFailure instanceof SqliteAuthorityConstructionError))
				throw new Error("Failed construction did not expose its cleanup owner.");
			expect(constructionFailure.cause).toEqual(
				expect.objectContaining({ message: expect.stringMatching(/header metadata/i) }),
			);
			expect(constructionFailure.constructionError).toBe(constructionFailure.cause);
			expect(constructionFailure.errors).toContain(closeFailure);
			expect(constructionFailure.cleanupErrors).toContain(closeFailure);
			expect(attemptedDatabases).toHaveLength(1);
			const retainedArtifacts = await Promise.all(
				["", "-wal", "-shm"].map(async suffix => {
					try {
						await fs.stat(`${databasePath}${suffix}`);
						return suffix;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
						throw error;
					}
				}),
			);
			expect(retainedArtifacts).toContain("");

			constructionFailure.cleanup();

			expect(attemptedDatabases).toHaveLength(2);
			expect(attemptedDatabases[1]).toBe(attemptedDatabases[0]);
			expect(actualCloseDatabases).toEqual([attemptedDatabases[0]]);
			expect(closeForceArguments).toEqual([true, true]);
			for (const suffix of ["", "-wal", "-shm"]) {
				expect(await fs.stat(`${databasePath}${suffix}`).catch(() => undefined)).toBeUndefined();
			}
		} finally {
			Database.prototype.close = originalClose;
		}
	});

	it("physically closes failed seeded construction before removing created SQLite artifacts", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(path.join(directory, "seed-source.sqlite"), true));
		const seed = source.exportState();
		source.close();
		const invalidSeed = { ...seed, revision: -1 };
		const originalClose = Database.prototype.close;
		const observed: { closed?: Database; force?: boolean } = {};
		Database.prototype.close = new Proxy(originalClose, {
			apply(target, database, args) {
				const result = Reflect.apply(target, database, args);
				if (database instanceof Database) {
					observed.closed = database;
					observed.force = args[0] === true;
				}
				return result;
			},
		});
		try {
			expect(() => new SqliteAuthorityPersistence({ ...options(databasePath, true), seed: invalidSeed })).toThrow(
				/header metadata/i,
			);
		} finally {
			Database.prototype.close = originalClose;
		}
		expect(observed.closed).toBeInstanceOf(Database);
		expect(observed.force).toBe(true);
		for (const suffix of ["", "-wal", "-shm"]) {
			expect(await fs.stat(`${databasePath}${suffix}`).catch(() => undefined)).toBeUndefined();
		}
	});

	it("discards staged rows, receipt, control and export evidence when transaction work throws", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const record = operation("owner", "operation", "intent");
		const changes: readonly AuthorityRow[] = [{ record, version: 1 }];
		const commit = makeCommit(1, authorityGenesisHash(), changes, [
			{ domain: "operation", key: ["owner", "mcp", "operation"], version: null },
		]);
		expect(() =>
			persistence.transaction(() => {
				persistence.commit(commit);
				expect(persistence.get("operation", ["owner", "mcp", "operation"])?.record).toEqual(record);
				expect(persistence.getControl("meta")).toEqual({
					revision: 1,
					generationHighWater: 0,
					status: "ready",
					headHash: commit.hash,
				});
				throw new Error("abort command");
			}),
		).toThrow("abort command");
		expect(persistence.get("operation", ["owner", "mcp", "operation"])).toBeUndefined();
		expect(persistence.getControl("meta")).toEqual({
			revision: 0,
			headHash: authorityGenesisHash(),
			generationHighWater: 0,
			status: "ready",
		});
		expect(persistence.getControl(`receipt:${JSON.stringify(["incarnation-1", 1, "request-1"])}`)).toBeUndefined();
		expect(persistence.exportState().frames).toHaveLength(0);
		expect(persistence.exportState().revision).toBe(0);
		persistence.close();
	});
	it("compares frame expectations with persisted state while transaction callbacks see staged state", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		const prefix = persistence.exportState();
		const initial = operation("owner", "cas-operation", "intent");
		const first = makeCommit(
			prefix.revision + 1,
			prefix.headHash,
			[{ record: initial, version: 1 }],
			[{ domain: "operation", key: [initial.ownerId, initial.effectClass, initial.operationId], version: null }],
		);
		expect(() =>
			persistence.transaction(() => {
				persistence.commit(first);
				expect(persistence.get("operation", [initial.ownerId, initial.effectClass, initial.operationId])).toEqual({
					record: initial,
					version: 1,
				});
				expect(persistence.scan("operation", { openOnly: true, limit: 1 }).rows).toEqual([
					{ record: initial, version: 1 },
				]);
				expect(persistence.getControl("meta")).toEqual({
					revision: first.revision,
					generationHighWater: 0,
					status: "ready",
					headHash: first.hash,
				});
			}),
		).not.toThrow();
		expect(persistence.get("operation", [initial.ownerId, initial.effectClass, initial.operationId])).toEqual({
			record: initial,
			version: 1,
		});
		expect(
			persistence.getControl(
				`receipt:${JSON.stringify([first.receipt.incarnation, first.receipt.ownerEpoch, first.receipt.requestId])}`,
			),
		).toEqual(first.receipt);

		const updated = { ...initial, at: 2, phase: "effect" as const };
		const second = makeCommit(
			first.revision + 1,
			first.hash,
			[{ record: updated, version: 2 }],
			[{ domain: "operation", key: [updated.ownerId, updated.effectClass, updated.operationId], version: 1 }],
			[],
			0,
			{ kind: "transition", record: updated },
		);
		persistence.transaction(() => persistence.commit(second));
		expect(persistence.get("operation", [updated.ownerId, updated.effectClass, updated.operationId])).toEqual({
			record: updated,
			version: 2,
		});
		expect(persistence.getControl("meta")).toEqual({
			revision: second.revision,
			generationHighWater: 0,
			status: "ready",
			headHash: second.hash,
		});
		expect(
			persistence.getControl(
				`receipt:${JSON.stringify([second.receipt.incarnation, second.receipt.ownerEpoch, second.receipt.requestId])}`,
			),
		).toEqual(second.receipt);

		const stale = makeCommit(
			second.revision + 1,
			second.hash,
			[{ record: { ...updated, at: 3, phase: "completed" as const }, version: 3 }],
			[{ domain: "operation", key: [updated.ownerId, updated.effectClass, updated.operationId], version: 1 }],
		);
		const beforeRejectedCommit = persistence.exportState();
		expect(() => persistence.transaction(() => persistence.commit(stale))).toThrow(/expected-row version conflict/);
		expect(persistence.exportState()).toEqual(beforeRejectedCommit);
		persistence.close();

		const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
		expect(reopened.get("operation", [updated.ownerId, updated.effectClass, updated.operationId])).toEqual({
			record: updated,
			version: 2,
		});
		expect(reopened.exportState()).toEqual(beforeRejectedCommit);
		reopened.integrityCheck();
		reopened.close();
	});
	it("marks a COMMIT-then-throw as uncertain and retains its request identity when unavailable", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		const prefix = persistence.exportState();
		const record = operation("owner", "commit-uncertainty", "intent");
		const commit = makeCommit(
			prefix.revision + 1,
			prefix.headHash,
			[{ record, version: 1 }],
			[{ domain: "operation", key: [record.ownerId, record.effectClass, record.operationId], version: null }],
		);
		const originalExec = Database.prototype.exec;
		const commitCause = new Error("injected failure after durable COMMIT");
		let failAfterCommit = false;
		Database.prototype.exec = new Proxy(originalExec, {
			apply(target, database, args) {
				const result = Reflect.apply(target, database, args);
				if (failAfterCommit && args[0] === "COMMIT") {
					failAfterCommit = false;
					throw commitCause;
				}
				return result;
			},
		});
		let unknown: unknown;
		let cached: unknown;
		try {
			failAfterCommit = true;
			try {
				persistence.transaction(() => persistence.commit(commit));
			} catch (error) {
				unknown = error;
			}
			expect(unknown).toMatchObject({
				unknownOutcome: true,
				requestId: commit.receipt.requestId,
				requestIdentity: {
					requestId: commit.request.requestId,
					incarnation: commit.request.incarnation,
					ownerEpoch: commit.request.ownerEpoch,
				},
			});
			expect((unknown as Error).cause).toBe(commitCause);
			try {
				persistence.get("root", ["dependent-admission"]);
			} catch (error) {
				cached = error;
			}
			expect(cached).toBe(unknown);
			expect(cached).toMatchObject({
				unknownOutcome: true,
				requestId: commit.receipt.requestId,
				requestIdentity: {
					requestId: commit.request.requestId,
					incarnation: commit.request.incarnation,
					ownerEpoch: commit.request.ownerEpoch,
				},
			});
			expect((cached as Error).cause).toBe(commitCause);
		} finally {
			Database.prototype.exec = originalExec;
		}
		persistence.close();

		const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
		expect(
			reopened.getControl(
				`receipt:${JSON.stringify([commit.receipt.incarnation, commit.receipt.ownerEpoch, commit.receipt.requestId])}`,
			),
		).toEqual(commit.receipt);
		expect(reopened.exportState().frames).toEqual([...prefix.frames, commit]);
		reopened.integrityCheck();
		reopened.close();
	});

	it("keeps proven pre-COMMIT rollback available and does not report an unknown outcome", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const record = operation("owner", "precommit-rollback", "intent");
		const commit = makeCommit(
			1,
			authorityGenesisHash(),
			[{ record, version: 1 }],
			[{ domain: "operation", key: [record.ownerId, record.effectClass, record.operationId], version: null }],
		);
		const database = new Database(databasePath);
		database.exec(
			"CREATE TRIGGER reject_precommit_frame BEFORE INSERT ON authority_frames BEGIN SELECT RAISE(ABORT, 'proven precommit rejection'); END",
		);
		database.close();
		let failure: unknown;
		try {
			persistence.transaction(() => persistence.commit(commit));
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ message: "proven precommit rejection" });
		expect(failure).not.toHaveProperty("unknownOutcome", true);
		expect(persistence.get("operation", [record.ownerId, record.effectClass, record.operationId])).toBeUndefined();
		expect(persistence.getControl("meta")).toEqual({
			revision: 0,
			headHash: authorityGenesisHash(),
			generationHighWater: 0,
			status: "ready",
		});
		expect(persistence.exportState().frames).toHaveLength(0);
		persistence.close();
	});
	itOnXfs("reconciles a same-handle SQLITE_LOCKED reset before an explicit funded continuation", async () => {
		const { directory } = await createLocation();
		const sessionId = `wal-reset-${crypto.randomUUID()}`;
		const sessionFile = path.join(directory, "session.jsonl");
		await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`, { mode: 0o600 });
		const ownership = await acquireAuthorityOwnership(sessionFile, { owningSessionId: sessionId, create: true });
		const observer = sqliteResetObserverWorker();
		let client: AuthorityRpcClient | undefined;
		let clientOpenUnsettled = false;
		let clientCloseAttempted = false;
		let capacityHandle: FileHandle | undefined;
		let capacityCloseAttempted = false;
		let operationControl: SessionOperationControl | undefined;
		let primary: unknown;
		let hasPrimary = false;
		try {
			const capacity = await openAuthorityCapacityFile(directory);
			capacityHandle = capacity.handle;
			// A rejected open may retain its actual worker/capacity owner without returning a client.
			clientOpenUnsettled = true;
			const authorityClient = await AuthorityRpcClient.open(
				{
					path: ownership.paths.sqlite,
					identity: { backend: "sqlite", owningSessionId: sessionId, incarnation: crypto.randomUUID(), format: 2 },
					create: true,
					capacity: { identity: capacity.identity, maxRequestBytes: 2 * 1024 * 1024 },
				},
				ownership,
				observer.factory,
				"xfs",
			);
			client = authorityClient;
			clientOpenUnsettled = false;
			const capacityIdentity = observer.capacityIdentity;
			if (!capacityIdentity)
				throw new Error("The SQLite worker did not retain its actual borrowed capacity identity.");

			const manager = {};
			operationControl = installSessionOperationLedger(manager);
			bindSessionOperationDurability(manager, authorityClient);
			const authority = issueBoundSessionOperationAuthority(
				{
					capability: {},
					actorId: "wal-reset-worker",
					rootId: "wal-reset-root",
					generation: 1,
					sessionFile: null,
					validate: () => true,
				},
				manager,
			);
			await bindSessionOperationAuthority(manager, authority);

			const operationId = "filesystem:wal-reset-funded-continuation";
			const effectPath = path.join(directory, "funded-effect.bin");
			const effectBytes = Buffer.from("one explicitly funded filesystem effect\n");
			let callbackCalls = 0;
			let callbackEffectStat:
				| { dev: bigint; ino: bigint; size: bigint; blocks: bigint; mtimeNs: bigint; ctimeNs: bigint }
				| undefined;
			let stateAtCallback: AuthorityExport | undefined;
			const effectCallback = async () => {
				callbackCalls++;
				if (!observer.readerHeld)
					throw new Error(
						"The live configured connection did not retain its same-handle iterator through the effect callback.",
					);
				await fs.writeFile(effectPath, effectBytes);
				const stat = await fs.stat(effectPath, { bigint: true });
				callbackEffectStat = {
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					blocks: stat.blocks,
					mtimeNs: stat.mtimeNs,
					ctimeNs: stat.ctimeNs,
				};
				// The effect frame is committed; release the pinned statement so the refused terminal command can reconcile after rollback.
				await observer.control("release-reader");
				stateAtCallback = await authorityClient.exportState();
				return "effect bytes written";
			};

			const resetsBeforeOperation = observer.events.filter(event => event.event === "wal-restart").length;
			await observer.control("observe-refusal");
			await observer.control("arm-intent-reader");
			const run = await runFilesystemOperation(manager, operationId, effectCallback).then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);
			// The post-COMMIT reset failed under the held reader; the terminal continuation retries it outside any
			// transaction before its BEGIN (the reader is released by then), so it is admitted on the first attempt.
			if (!run.ok) throw run.error;
			expect(run.value).toBe("effect bytes written");
			expect(callbackCalls).toBe(1);
			if (!stateAtCallback || !callbackEffectStat)
				throw new Error(
					"The production filesystem callback did not record its actual effect and pre-continuation durable state.",
				);
			expect(observer.readerHeld).toBe(false);
			expect(observer.events.filter(event => event.event === "reader-held")).toHaveLength(1);
			expect(observer.events.filter(event => event.event === "reader-released").at(-1)).toMatchObject({
				iteratorReturned: true,
				statementFinalized: true,
			});

			const resetEvents = observer.events
				.filter(event => event.event === "wal-restart")
				.slice(resetsBeforeOperation);
			expect(resetEvents.slice(0, 3).map(event => event.mode)).toEqual([
				"PRAGMA wal_checkpoint(NOOP)",
				"PRAGMA wal_checkpoint(NOOP)",
				"PRAGMA wal_checkpoint(RESTART)",
			]);
			expect(resetEvents[0]).toMatchObject({ inTransaction: false, result: { busy: 0 } });
			expect(resetEvents[1]).toMatchObject({
				inTransaction: false,
				error: {
					name: "SQLiteError",
					code: "SQLITE_LOCKED",
					errno: 6,
					message: "database table is locked",
				},
			});
			// After a refused read the outside-transaction reconciliation always forces a complete RESTART.
			expect(resetEvents[2]).toMatchObject({ inTransaction: false, result: { busy: 0 } });
			const reconciliation = resetEvents[2]?.result as { log: number; checkpointed: number } | undefined;
			if (!reconciliation)
				throw new Error("Outside-transaction WAL reconciliation did not return a checkpoint result.");
			expect(reconciliation.log).toBe(reconciliation.checkpointed);
			for (const event of resetEvents) expect(event.inTransaction).toBe(false);
			const readerReleaseIndex = observer.events.findIndex(event => event.event === "reader-released");
			const reconciliationIndex = observer.events.indexOf(resetEvents[2]!);
			expect(readerReleaseIndex).toBeGreaterThanOrEqual(0);
			expect(readerReleaseIndex).toBeLessThan(reconciliationIndex);
			expect(observer.events.filter(event => event.event === "prepare-refusal")).toEqual([]);

			const afterContinuation = await authorityClient.exportState();
			const effectFrame = stateAtCallback.frames.at(-1);
			if (
				!effectFrame ||
				effectFrame.command.kind !== "transition" ||
				effectFrame.command.record.kind !== "operation" ||
				effectFrame.command.record.operationId !== operationId ||
				effectFrame.command.record.phase !== "effect"
			)
				throw new Error("The callback did not follow the committed filesystem effect frame.");
			const phases = afterContinuation.frames.flatMap(frame =>
				frame.command.kind === "transition" &&
				frame.command.record.kind === "operation" &&
				frame.command.record.operationId === operationId
					? [frame.command.record.phase]
					: [],
			);
			expect(phases).toEqual(["intent", "effect", "committed", "completed"]);
			expect(getOperationTerminal(manager, operationId)?.status).toBe("completed");
			expect(await fs.readFile(effectPath)).toEqual(effectBytes);

			await observer.control("finish-pool-observation");
			const poolStart = observer.events.findIndex(event => event.event === "pool-observation-start");
			const poolEnd = observer.events.findIndex(event => event.event === "pool-observation-end");
			expect(poolStart).toBeGreaterThanOrEqual(0);
			expect(poolStart).toBeLessThan(readerReleaseIndex);
			expect(poolEnd).toBeGreaterThan(reconciliationIndex);
			const faultIndex = observer.events.indexOf(resetEvents[1]!);
			expect(faultIndex).toBeGreaterThan(poolStart);
			expect(faultIndex).toBeLessThan(reconciliationIndex);
			const poolEvents = observer.events
				.slice(poolStart + 1, poolEnd)
				.filter(event => event.event === "pool-ensure");
			const poolResults = observer.events
				.slice(poolStart + 1, poolEnd)
				.filter(event => event.event === "pool-ensure-result");
			expect(poolResults).toHaveLength(poolEvents.length);
			for (const [index, event] of poolEvents.entries()) {
				const before = event.before as { device: bigint; inode: bigint; dataBytes: number };
				const outcome = poolResults[index]!;
				const result = outcome.result as { dataBytes: number; device: bigint; inode: bigint };
				expect(event.samePool).toBe(true);
				expect(outcome.samePool).toBe(true);
				expect([before.device, before.inode]).toEqual([capacityIdentity.device, capacityIdentity.inode]);
				expect([result.device, result.inode]).toEqual([capacityIdentity.device, capacityIdentity.inode]);
				expect((outcome.before as { dataBytes: number }).dataBytes).toBe(before.dataBytes);
				if (observer.events.indexOf(event) > faultIndex) {
					// The funded continuation consumes its reserved promise: reconciliation and its commit never grow the pool.
					expect(event.targetBytes as number).toBeLessThanOrEqual(before.dataBytes);
					expect(result.dataBytes).toBe(before.dataBytes);
				} else {
					expect(result.dataBytes).toBe(Math.max(before.dataBytes, event.targetBytes as number));
				}
			}
			const preFaultResults = poolResults.filter(event => observer.events.indexOf(event) < faultIndex);
			const atFault =
				preFaultResults.length > 0
					? (preFaultResults.at(-1)!.result as { dataBytes: number }).dataBytes
					: (observer.events[poolStart]!.state as { dataBytes: number }).dataBytes;
			expect((observer.events[poolEnd]!.state as { dataBytes: number }).dataBytes).toBeLessThanOrEqual(atFault);
			for (const index of [poolStart, poolEnd]) {
				const state = observer.events[index]?.state as { device: bigint; inode: bigint };
				expect([state.device, state.inode]).toEqual([capacityIdentity.device, capacityIdentity.inode]);
			}

			await operationControl.close();
			operationControl = undefined;
			clientCloseAttempted = true;
			await authorityClient.close();
			client = undefined;
			expect(observer.events.filter(event => event.event === "database-close")).toMatchObject([
				{ readerHeld: false },
			]);
			capacityCloseAttempted = true;
			await capacity.handle.close();
			capacityHandle = undefined;
		} catch (error) {
			primary = error;
			hasPrimary = true;
		} finally {
			const cleanupErrors: unknown[] = [];
			if (observer.readerHeld) {
				try {
					await observer.control("release-reader");
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			try {
				await operationControl?.close();
			} catch (error) {
				cleanupErrors.push(error);
			}
			if (client && !observer.readerHeld && !clientCloseAttempted) {
				clientCloseAttempted = true;
				try {
					await client.close();
					client = undefined;
				} catch (error) {
					cleanupErrors.push(error);
				}
			} else if (client)
				cleanupErrors.push(
					new Error(
						"Retained the SQLite worker and capacity owner because reader or client close ownership is unresolved.",
					),
				);
			if (capacityHandle && !client && !capacityCloseAttempted) {
				capacityCloseAttempted = true;
				try {
					await capacityHandle.close();
					capacityHandle = undefined;
				} catch (error) {
					cleanupErrors.push(error);
				}
			} else if (capacityHandle)
				cleanupErrors.push(
					new Error(
						"Retained the borrowed SQLite capacity owner because client or descriptor close ownership is unresolved.",
					),
				);
			if (clientOpenUnsettled || observer.readerHeld || client || capacityHandle) {
				// Do not unlink a store whose exact worker or descriptor ownership remains unresolved.
				const index = temporaryDirectories.indexOf(directory);
				if (index >= 0) temporaryDirectories.splice(index, 1);
			}
			observer.dispose();
			if (hasPrimary) {
				if (cleanupErrors.length)
					throw new AggregateError(
						[primary, ...cleanupErrors],
						"SQLite reset regression and exact-owner cleanup both failed.",
						{ cause: primary },
					);
				throw primary;
			}
			if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "SQLite reset regression cleanup failed.");
		}
	});

	it("persists actor root projections and optional parent lineage across restore", async () => {
		const { directory, databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const hash = (value: unknown): string => canonicalDurableSha256(value);
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		const { actor: parent } = activateRoot(engine, "parent-actor", 7);
		const child = {
			...parent,
			at: 8,
			actorId: "child-actor",
			parentId: parent.actorId,
			generation: 12,
			startupHash: hash("child-startup"),
			provenanceHash: hash("child-provenance"),
			state: "active" as const,
		};
		const parentKey = `actor-generation:${JSON.stringify([parent.actorId, parent.generation])}`;
		const childKey = `actor-generation:${JSON.stringify([child.actorId, child.generation])}`;
		const construction = {
			kind: "construction" as const,
			at: 5,
			actorId: child.actorId,
			rootId: child.rootId,
			parentId: child.parentId,
			generation: child.generation,
			startupHash: child.startupHash,
			provenanceHash: child.provenanceHash,
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				construction,
				{ ...construction, at: 6, phase: "constructing" },
				{ ...construction, at: 7, phase: "constructed" },
			],
			{ requestId: "actor-projection-construction" },
		);
		engine.activateAuthority(
			{ actor: child, construction: { ...construction, at: 8, phase: "activated" } },
			{ requestId: "actor-projection-activation" },
		);
		expect(persistence.getControl(parentKey)).toEqual({ row: { record: parent, version: 1 } });
		const parked = { ...child, at: 9, state: "parked" as const };
		engine.transition(parked, { requestId: "actor-projection-park" });
		expect(persistence.get("actor", [child.actorId])).toEqual({ record: parked, version: 2 });
		expect(persistence.getControl(childKey)).toEqual({
			row: { record: parked, version: 2 },
			parentGeneration: parent.generation,
		});
		const projection = new Database(databasePath, { readonly: true });
		try {
			expect(
				projection
					.query(
						"SELECT json_extract(record, '$.actorId') AS actor_id, json_extract(record, '$.generation') AS generation, json_extract(record, '$.parentId') AS parent_id, CAST(root_id AS TEXT) AS root_id, root_generation, state FROM authority_actors ORDER BY order_key",
					)
					.all(),
			).toEqual([
				{
					actor_id: "child-actor",
					generation: 12,
					parent_id: "parent-actor",
					root_id: child.rootId,
					root_generation: child.rootGeneration,
					state: "parked",
				},
				{
					actor_id: "parent-actor",
					generation: 7,
					parent_id: null,
					root_id: parent.rootId,
					root_generation: parent.rootGeneration,
					state: "active",
				},
			]);
		} finally {
			projection.close();
		}
		const exported = persistence.exportState();
		persistence.close();

		const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
		expect(reopened.get("actor", [child.actorId])).toEqual({ record: parked, version: 2 });
		expect(reopened.getControl(childKey)).toEqual({
			row: { record: parked, version: 2 },
			parentGeneration: parent.generation,
		});
		reopened.integrityCheck();
		reopened.close();

		const restored = new SqliteAuthorityPersistence({
			...options(path.join(directory, "actor-restored.sqlite"), true),
			seed: exported,
		});
		expect(restored.get("actor", [child.actorId])).toEqual({ record: parked, version: 2 });
		expect(restored.getControl(childKey)).toEqual({
			row: { record: parked, version: 2 },
			parentGeneration: parent.generation,
		});
		restored.integrityCheck();
		restored.close();
	});
	it("preserves verified legacy root and first-parent lineage through import and integrity", async () => {
		const { databasePath } = await createLocation();
		const { root, parent, child, records } = legacyLineage();
		const legacy = legacySource(records);
		const seed = legacySeed(options(databasePath, true).identity);
		const restored = new SqliteAuthorityPersistence({ ...options(databasePath, true), seed });
		const lineageKey = `actor-generation:${JSON.stringify([child.actorId, child.generation])}`;
		expect(restored.get("root", [root.rootId])).toEqual({ record: root, version: 1 });
		expect(restored.get("actor", [child.actorId])).toEqual({ record: child, version: 1 });
		expect(restored.getControl(lineageKey)).toEqual({
			row: { record: child, version: 1 },
			parentGeneration: parent.generation,
		});
		expect(restored.exportState().legacy).toEqual(legacy);
		expect(seed.frames).toEqual([]);
		expect(seed.controls.filter(control => control.key.startsWith("receipt:"))).toEqual([]);
		restored.integrityCheck();
		restored.close();
	});

	it("rejects semantically invalid legacy baselines on seed import and offline integrity", async () => {
		const { directory, databasePath } = await createLocation();
		const { root, parent, child } = legacyLineage();
		const seed = legacySeed(options(databasePath, true).identity);
		const badHead = canonicalDurableSha256("different-root-head");
		const cases: {
			name: string;
			records: DurableRegistryRecord[];
			changed?: DurableRegistryRecord;
			version?: number;
		}[] = [
			{ name: "orphan-root", records: [parent, root, child] },
			{
				name: "wrong-root-generation",
				records: [root, parent, { ...child, rootGeneration: 4 }],
				changed: { ...child, rootGeneration: 4 },
			},
			{
				name: "wrong-root-head",
				records: [root, parent, { ...child, rootHeadHash: badHead }],
				changed: { ...child, rootHeadHash: badHead },
			},
			{
				name: "conflicting-root",
				records: [root, { ...root, headHash: badHead }, root, parent, child],
				changed: root,
				version: 3,
			},
			{
				name: "conflicting-actor",
				records: [root, parent, child, { ...child, startupHash: badHead }, child],
				changed: child,
				version: 3,
			},
		];
		for (const scenario of cases) {
			const changed = scenario.changed;
			const version = scenario.version ?? 1;
			const generationKey =
				changed?.kind === "root"
					? `root-generation:${JSON.stringify([changed.rootId, changed.generation])}`
					: changed?.kind === "actor"
						? `actor-generation:${JSON.stringify([changed.actorId, changed.generation])}`
						: undefined;
			const inconsistent = {
				...seed,
				legacy: legacySource(scenario.records),
				rows: seed.rows.map(row =>
					changed &&
					row.record.kind === changed.kind &&
					(changed.kind === "root"
						? row.record.kind === "root" && row.record.rootId === changed.rootId
						: changed.kind === "actor" && row.record.kind === "actor" && row.record.actorId === changed.actorId)
						? { record: changed, version }
						: row,
				),
				controls: seed.controls.map(control =>
					control.key === generationKey
						? {
								...control,
								value:
									changed?.kind === "root"
										? { record: changed, version }
										: { row: { record: changed, version }, parentGeneration: parent.generation },
							}
						: control,
				),
			};
			expect(
				() =>
					new SqliteAuthorityPersistence({
						...options(path.join(directory, `${scenario.name}-seed.sqlite`), true),
						seed: inconsistent,
					}),
			).toThrow();

			const integrityPath = path.join(directory, `${scenario.name}-integrity.sqlite`);
			const store = new SqliteAuthorityPersistence({ ...options(integrityPath, true), seed });
			const database = new Database(integrityPath);
			try {
				database.run("UPDATE authority_legacy_source SET value = ? WHERE id = 1", [
					JSON.stringify(inconsistent.legacy),
				]);
				if (changed?.kind === "root") {
					database.run("UPDATE authority_roots SET record = ?, version = ? WHERE order_key = ?", [
						JSON.stringify(changed),
						version,
						sqliteAuthorityOrderKey([changed.rootId]),
					]);
				} else if (changed?.kind === "actor") {
					database.run(
						"UPDATE authority_actors SET record = ?, version = ?, root_generation = ? WHERE order_key = ?",
						[
							JSON.stringify(changed),
							version,
							changed.rootGeneration,
							sqliteAuthorityOrderKey([changed.actorId]),
						],
					);
				}
				const control = inconsistent.controls.find(item => item.key === generationKey);
				if (control)
					database.run("UPDATE authority_controls SET value = ? WHERE order_key = ?", [
						JSON.stringify(control.value),
						cesu8Encode(control.key),
					]);
				expect(() => store.integrityCheck()).toThrow();
			} finally {
				database.close();
				store.close();
			}
		}
	});

	it("rejects a seeded current row omitted from retained frame evidence before opening", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const record = operation("owner", "seed-row", "intent");
		const engine = new AuthorityEngine(source, "owner-token");
		engine.recover();
		engine.transition(record, { requestId: "seed-row" });
		const seed = source.exportState();
		source.integrityCheck();
		source.close();
		const inconsistent = { ...seed, rows: [] };
		expect(
			() =>
				new SqliteAuthorityPersistence({
					...options(path.join(directory, "missing-row.sqlite"), true),
					seed: inconsistent,
				}),
		).toThrow(/evidence|frame|row/i);
	});

	it("rejects a seeded owner control that disagrees with the latest retained frame", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(source, "owner-token");
		const owner = engine.recover().owner;
		const seed = source.exportState();
		source.close();
		const inconsistent = {
			...seed,
			controls: seed.controls.map(control =>
				control.key === "owner" ? { ...control, value: { ...owner, phase: "closed" } } : control,
			),
		};
		expect(
			() =>
				new SqliteAuthorityPersistence({
					...options(path.join(directory, "changed-owner.sqlite"), true),
					seed: inconsistent,
				}),
		).toThrow(/evidence|frame|control/i);
	});

	it("rejects a coherent reconciliation commit forged from a retained reserved claim on seed and integrity", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(source, "owner-token");
		engine.recover();
		const claim = engine.reserveLocal(
			{
				localId: "reserved-repo",
				entryId: "reserved-entry",
				entryHash: canonicalDurableSha256("reserved-entry-bytes"),
				expectedHeadHash: authorityGenesisHash(),
			},
			{ requestId: "reserved-prefix" },
		);
		const prefix = source.exportState();
		const claimKey = `local-claim:${JSON.stringify(claim.localId)}`;
		expect(source.getControl(claimKey)).toEqual(claim);
		expect(engine.getLocalEntry(claim.localId, claim.entryId, claim.version)).toMatchObject({
			record: { phase: "intent" },
			version: 1,
		});
		expect(engine.getLocalHead(claim.localId)).toBeUndefined();
		const forgedClaim = { ...claim, phase: "effect" as const };
		expect(() =>
			engine.reconcileLocal(
				{ claim: forgedClaim, observedEntryHash: claim.entryHash, action: "commit" },
				{ requestId: "rejected-reserved-reconcile" },
			),
		).toThrow(/claim|phase|reserved/i);
		expect(source.exportState()).toEqual(prefix);

		// Rebase an actual engine reconciliation frame onto its reserved-only prefix.
		// Every hash, projection and receipt remains coherent; the missing authorization is the defect.
		engine.authorizeLocalEffect(claim, { requestId: "legal-reserved-authorize" });
		engine.reconcileLocal(
			{ claim: forgedClaim, observedEntryHash: claim.entryHash, action: "commit" },
			{ requestId: "legal-reserved-reconcile" },
		);
		const legal = source.exportState().frames.at(-1)!;
		expect(legal.command.kind).toBe("reconcile-local");
		source.integrityCheck();
		source.close();
		const forged = rewriteCommit(legal, {
			revision: prefix.revision + 1,
			previousHash: prefix.headHash,
			expected: legal.expected.map(item => (item.domain === "local-entry" ? { ...item, version: 1 } : item)),
			changes: legal.changes.map(row => (row.record.kind === "local-entry" ? { ...row, version: 2 } : row)),
		});
		const integrityPath = path.join(directory, "reserved-forged-integrity.sqlite");
		const store = new SqliteAuthorityPersistence({ ...options(integrityPath, true), seed: prefix });
		try {
			store.integrityCheck();
			expect(() => store.transaction(() => store.commit(forged))).not.toThrow();
			const inconsistent = store.exportState();
			expect(inconsistent.frames).toEqual([...prefix.frames, forged]);
			expect(inconsistent.frames.some(commit => commit.command.kind === "authorize-local-effect")).toBe(false);
			expect(store.get("local-entry", [claim.localId, claim.entryId, claim.version])).toMatchObject({
				record: { phase: "committed" },
				version: 2,
			});
			expect(store.get("local-head", [claim.localId])).toMatchObject({
				record: { headHash: claim.headHash, version: claim.version },
				version: 1,
			});
			expect(store.getControl(claimKey)).toBeUndefined();
			expect(
				store.getControl(
					`receipt:${JSON.stringify([forged.receipt.incarnation, forged.receipt.ownerEpoch, forged.receipt.requestId])}`,
				),
			).toEqual(forged.receipt);
			const physical = new Database(integrityPath, { readonly: true });
			try {
				expect(physical.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
				expect(physical.query("PRAGMA foreign_key_check").all()).toEqual([]);
			} finally {
				physical.close();
			}
			expect(
				() =>
					new SqliteAuthorityPersistence({
						...options(path.join(directory, "reserved-forged-seed.sqlite"), true),
						seed: inconsistent,
					}),
			).toThrow(/claim|phase|entry|reconcil|progress/i);
			expect(() => store.integrityCheck()).toThrow(/claim|phase|entry|reconcil|progress/i);
		} finally {
			store.close();
		}
	});

	it("rejects coherent non-genesis reconciliation without the observed predecessor bytes on seed and integrity", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(source, "owner-token");
		engine.recover();
		const first = engine.reserveLocal(
			{
				localId: "predecessor-repo",
				entryId: "predecessor-entry",
				entryHash: canonicalDurableSha256("predecessor-bytes"),
				expectedHeadHash: authorityGenesisHash(),
			},
			{ requestId: "predecessor-reserve" },
		);
		engine.authorizeLocalEffect(first, { requestId: "predecessor-authorize" });
		engine.finalizeLocal({ ...first, phase: "effect" }, "committed", { requestId: "predecessor-finalize" });
		const reserved = engine.reserveLocal(
			{
				localId: first.localId,
				entryId: "successor-entry",
				entryHash: canonicalDurableSha256("successor-bytes"),
				expectedHeadHash: first.headHash,
			},
			{ requestId: "successor-reserve" },
		);
		engine.authorizeLocalEffect(reserved, { requestId: "successor-authorize" });
		const claim = { ...reserved, phase: "effect" as const };
		const prefix = source.exportState();
		const predecessor = engine.getLocalHead(claim.localId)!;
		const wrongObservation = canonicalDurableSha256("not-the-predecessor-bytes");
		expect(claim.previousHeadHash).not.toBe(authorityGenesisHash());
		expect(wrongObservation).not.toBe(first.entryHash);
		expect(engine.localBacking(claim.localId)).toEqual({
			entryId: first.entryId,
			entryHash: first.entryHash,
			version: first.version,
			headHash: first.headHash,
		});
		expect(() =>
			engine.reconcileLocal(
				{ claim, action: "restore-predecessor", observedEntryHash: wrongObservation },
				{ requestId: "rejected-predecessor-observation" },
			),
		).toThrow(/observed|predecessor/i);
		expect(source.exportState()).toEqual(prefix);
		engine.reconcileLocal(
			{ claim, action: "restore-predecessor", observedEntryHash: first.entryHash },
			{ requestId: "legal-predecessor-reconcile" },
		);
		const legal = source.exportState().frames.at(-1)!;
		expect(legal.command.kind).toBe("reconcile-local");
		source.integrityCheck();
		source.close();
		const forged = rewriteCommit(legal, {
			command: {
				kind: "reconcile-local",
				input: { claim, action: "restore-predecessor", observedEntryHash: wrongObservation },
			},
		});
		const integrityPath = path.join(directory, "predecessor-forged-integrity.sqlite");
		const store = new SqliteAuthorityPersistence({ ...options(integrityPath, true), seed: prefix });
		try {
			store.integrityCheck();
			expect(() => store.transaction(() => store.commit(forged))).not.toThrow();
			const inconsistent = store.exportState();
			expect(inconsistent.frames).toEqual([...prefix.frames, forged]);
			expect(store.get("local-entry", [claim.localId, claim.entryId, claim.version])).toMatchObject({
				record: { phase: "cancelled" },
				version: 3,
			});
			expect(store.get("local-head", [claim.localId])).toEqual(predecessor);
			expect(store.getControl(`local-claim:${JSON.stringify(claim.localId)}`)).toBeUndefined();
			expect(
				store.getControl(
					`receipt:${JSON.stringify([forged.receipt.incarnation, forged.receipt.ownerEpoch, forged.receipt.requestId])}`,
				),
			).toEqual(forged.receipt);
			const physical = new Database(integrityPath, { readonly: true });
			try {
				expect(physical.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
				expect(physical.query("PRAGMA foreign_key_check").all()).toEqual([]);
			} finally {
				physical.close();
			}
			expect(
				() =>
					new SqliteAuthorityPersistence({
						...options(path.join(directory, "predecessor-forged-seed.sqlite"), true),
						seed: inconsistent,
					}),
			).toThrow(/observed|predecessor|reconcil/i);
			expect(() => store.integrityCheck()).toThrow(/observed|predecessor|reconcil/i);
		} finally {
			store.close();
		}
	});

	for (const action of ["commit", "restore-predecessor"] as const) {
		it(`imports and replays actual-engine ${action} reconciliation of an uncertain old-incarnation claim`, async () => {
			const { directory, databasePath } = await createLocation();
			const source = new SqliteAuthorityPersistence(options(databasePath, true));
			const original = new AuthorityEngine(source, "owner-token");
			const oldOwner = original.recover().owner;
			const first = original.reserveLocal(
				{
					localId: "imported-repo",
					entryId: "committed-predecessor",
					entryHash: canonicalDurableSha256("committed-predecessor-bytes"),
					expectedHeadHash: authorityGenesisHash(),
				},
				{ requestId: "imported-first-reserve" },
			);
			original.authorizeLocalEffect(first, { requestId: "imported-first-authorize" });
			original.finalizeLocal({ ...first, phase: "effect" }, "committed", { requestId: "imported-first-finalize" });
			const reserved = original.reserveLocal(
				{
					localId: first.localId,
					entryId: "uncertain-successor",
					entryHash: canonicalDurableSha256("uncertain-successor-bytes"),
					expectedHeadHash: first.headHash,
				},
				{ requestId: "imported-second-reserve" },
			);
			original.authorizeLocalEffect(reserved, { requestId: "imported-second-authorize" });
			original.finalizeLocal({ ...reserved, phase: "effect" }, "uncertain", {
				requestId: "imported-second-uncertain",
			});
			const claim = { ...reserved, phase: "uncertain" as const };
			const prefix = source.exportState();
			source.integrityCheck();
			source.close();
			const identity = { ...prefix.sourceIdentity, incarnation: `imported-${action}` };
			const imported = new SqliteAuthorityPersistence({
				...options(path.join(directory, "imported.sqlite"), true, identity),
				seed: prefix,
			});
			const claimKey = `local-claim:${JSON.stringify(claim.localId)}`;
			expect(imported.getControl(claimKey)).toEqual(claim);
			const recovering = new AuthorityEngine(imported, "imported-owner-token");
			expect(recovering.recover()).toMatchObject({
				owner: { incarnation: identity.incarnation, epoch: oldOwner.epoch + 1, phase: "recovering" },
			});
			expect(recovering.recoveryState().blocked).toContain(claimKey);
			const receipt = recovering.reconcileLocal(
				{ claim, action, observedEntryHash: action === "commit" ? claim.entryHash : first.entryHash },
				{ requestId: `imported-${action}-reconcile` },
			);
			expect(receipt).toMatchObject({
				incarnation: identity.incarnation,
				ownerEpoch: oldOwner.epoch + 1,
				commandKind: "reconcile-local",
				result:
					action === "commit"
						? { kind: "local-publication", publication: { version: claim.version, headHash: claim.headHash } }
						: { kind: "mutation" },
			});
			expect(imported.getControl(claimKey)).toBeUndefined();
			expect(recovering.getLocalEntry(claim.localId, claim.entryId, claim.version)).toMatchObject({
				record: { phase: action === "commit" ? "committed" : "cancelled" },
				version: 3,
			});
			expect(recovering.localBacking(claim.localId)).toEqual(
				action === "commit"
					? {
							entryId: claim.entryId,
							entryHash: claim.entryHash,
							version: claim.version,
							headHash: claim.headHash,
						}
					: {
							entryId: first.entryId,
							entryHash: first.entryHash,
							version: first.version,
							headHash: first.headHash,
						},
			);
			expect(recovering.recover()).toMatchObject({
				owner: { incarnation: identity.incarnation, epoch: oldOwner.epoch + 1, phase: "ready" },
				blocked: [],
			});
			const reconciled = imported.exportState();
			expect(reconciled.frames.slice(0, prefix.frames.length)).toEqual([...prefix.frames]);
			for (const commit of reconciled.frames) {
				expect(
					imported.getControl(
						`receipt:${JSON.stringify([commit.receipt.incarnation, commit.receipt.ownerEpoch, commit.receipt.requestId])}`,
					),
				).toEqual(commit.receipt);
			}
			expect(reconciled.frames.slice(prefix.frames.length).map(commit => commit.command.kind)).toEqual([
				"owner",
				"reconcile-local",
				"owner",
			]);
			imported.integrityCheck();
			imported.close();
			const restored = new SqliteAuthorityPersistence({
				...options(path.join(directory, "reconciled-restored.sqlite"), true, identity),
				seed: reconciled,
			});
			expect(restored.exportState()).toEqual(reconciled);
			restored.integrityCheck();
			restored.close();
		});
	}
	it("reconciles and reimports claims, lineage, ownership, quarantine and high-water metadata", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(source, "owner-token");
		const owner = engine.recover().owner;
		const { root } = activateRoot(engine, "metadata-root", 4);
		const actor = {
			kind: "actor" as const,
			at: 8,
			actorId: "metadata-actor",
			rootId: root.rootId,
			parentId: root.rootId,
			generation: 9,
			rootGeneration: root.generation,
			rootHeadHash: root.headHash,
			startupHash: canonicalDurableSha256("metadata-startup"),
			provenanceHash: canonicalDurableSha256("metadata-provenance"),
			state: "active" as const,
		};
		const construction = {
			kind: "construction" as const,
			at: 5,
			actorId: actor.actorId,
			rootId: actor.rootId,
			parentId: actor.parentId,
			generation: actor.generation,
			startupHash: actor.startupHash,
			provenanceHash: actor.provenanceHash,
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				construction,
				{ ...construction, at: 6, phase: "constructing" },
				{ ...construction, at: 7, phase: "constructed" },
			],
			{ requestId: "metadata-child-construction" },
		);
		engine.activateAuthority(
			{ actor, construction: { ...construction, at: 8, phase: "activated" } },
			{ requestId: "metadata-child-activation" },
		);
		const pendingOperation = operation("owner", "metadata-operation", "intent");
		engine.transition(pendingOperation, { requestId: "metadata-operation" });
		const reserved = engine.reserveLocal(
			{
				localId: "repo",
				entryId: "pending-entry",
				entryHash: canonicalDurableSha256("pending-entry-bytes"),
				expectedHeadHash: authorityGenesisHash(),
			},
			{ requestId: "metadata-reserve" },
		);
		engine.authorizeLocalEffect(reserved, { requestId: "metadata-authorize" });
		const claim = { ...reserved, phase: "effect" as const };
		const pendingEntry = engine.getLocalEntry(claim.localId, claim.entryId, claim.version)!;
		const actorGenerationKey = `actor-generation:${JSON.stringify([actor.actorId, actor.generation])}`;
		const localClaimKey = `local-claim:${JSON.stringify(claim.localId)}`;
		const reason = "offline quarantine evidence";
		expect(() => engine.quarantine(reason)).toThrow(reason);
		const seed = source.exportState();
		source.close();

		const restoredIdentity: AuthorityIdentity = { ...seed.sourceIdentity, incarnation: "metadata-restored" };
		const restored = new SqliteAuthorityPersistence({
			...options(path.join(directory, "metadata-restored.sqlite"), true, restoredIdentity),
			seed,
		});
		expect(restored.get("actor", [actor.actorId])).toEqual({ record: actor, version: 1 });
		expect(
			restored.get("operation", [
				pendingOperation.ownerId,
				pendingOperation.effectClass,
				pendingOperation.operationId,
			]),
		).toEqual({ record: pendingOperation, version: 1 });
		expect(restored.get("local-entry", [claim.localId, claim.entryId, claim.version])).toEqual(pendingEntry);
		expect(pendingEntry).toMatchObject({
			record: { phase: "effect", expectedHeadHash: authorityGenesisHash() },
			version: 2,
		});
		expect(restored.getControl(actorGenerationKey)).toEqual({
			row: { record: actor, version: 1 },
			parentGeneration: root.generation,
		});
		expect(restored.getControl(localClaimKey)).toEqual(claim);
		expect(restored.getControl("owner")).toEqual(owner);
		expect(restored.getControl("meta")).toEqual({
			revision: seed.revision,
			generationHighWater: actor.generation,
			status: "quarantined",
			quarantineReason: reason,
			headHash: seed.headHash,
		});
		expect(seed.frames.map(commit => commit.command.kind)).toEqual([
			"owner",
			"owner",
			"transition-batch",
			"activate-authority",
			"transition-batch",
			"activate-authority",
			"transition",
			"reserve-local",
			"authorize-local-effect",
			"quarantine",
		]);
		for (const commit of seed.frames) {
			expect(
				restored.getControl(
					`receipt:${JSON.stringify([commit.receipt.incarnation, commit.receipt.ownerEpoch, commit.receipt.requestId])}`,
				),
			).toEqual(commit.receipt);
		}
		expect(restored.exportState().controls).toEqual(seed.controls);
		expect(restored.exportState().frames).toEqual(seed.frames);
		restored.integrityCheck();
		restored.close();
	});

	it("requires exact bidirectional receipt-control correspondence before seeded reopen", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const record = operation("owner", "seed-receipt", "intent");
		const engine = new AuthorityEngine(source, "owner-token");
		engine.recover();
		engine.transition(record, { requestId: "seed-receipt" });
		const seed = source.exportState();
		const commit = seed.frames.at(-1)!;
		source.integrityCheck();
		source.close();
		const receiptControlKey = `receipt:${JSON.stringify([commit.receipt.incarnation, commit.receipt.ownerEpoch, commit.receipt.requestId])}`;
		const restoredIdentity: AuthorityIdentity = { ...seed.sourceIdentity, incarnation: "restored-incarnation" };
		const restoredPath = path.join(directory, "restored-receipts.sqlite");
		const restored = new SqliteAuthorityPersistence({
			...options(restoredPath, true, restoredIdentity),
			seed,
		});
		expect(restored.getControl(receiptControlKey)).toEqual(commit.receipt);
		expect(
			restored.getControl(
				`receipt:${JSON.stringify([restoredIdentity.incarnation, commit.receipt.ownerEpoch, commit.receipt.requestId])}`,
			),
		).toBeUndefined();
		expect(restored.exportState().frames).toEqual(seed.frames);
		for (const retained of seed.frames) {
			expect(
				restored.getControl(
					`receipt:${JSON.stringify([retained.receipt.incarnation, retained.receipt.ownerEpoch, retained.receipt.requestId])}`,
				),
			).toEqual(retained.receipt);
		}
		restored.integrityCheck();
		restored.close();

		const missingReceipt = { ...seed, controls: seed.controls.filter(control => control.key !== receiptControlKey) };
		expect(
			() =>
				new SqliteAuthorityPersistence({
					...options(path.join(directory, "missing-receipt.sqlite"), true, restoredIdentity),
					seed: missingReceipt,
				}),
		).toThrow(/receipt/i);

		const changedReceipt = {
			...seed,
			controls: seed.controls.map(control =>
				control.key === receiptControlKey
					? { ...control, value: { ...commit.receipt, requestId: "different-request" } }
					: control,
			),
		};
		expect(
			() =>
				new SqliteAuthorityPersistence({
					...options(path.join(directory, "changed-receipt.sqlite"), true, restoredIdentity),
					seed: changedReceipt,
				}),
		).toThrow(/receipt/i);

		const extraReceipt = {
			...commit.receipt,
			incarnation: "legacy-incarnation",
			ownerEpoch: 9,
			requestId: "unframed-request",
		};
		const extraReceiptKey = `receipt:${JSON.stringify([extraReceipt.incarnation, extraReceipt.ownerEpoch, extraReceipt.requestId])}`;
		const extraReceiptSeed = {
			...seed,
			controls: [...seed.controls, { key: extraReceiptKey, value: extraReceipt }],
		};
		expect(
			() =>
				new SqliteAuthorityPersistence({
					...options(path.join(directory, "extra-receipt.sqlite"), true, restoredIdentity),
					seed: extraReceiptSeed,
				}),
		).toThrow(/receipt/i);
	});

	it("rolls back already-applied rows and controls when the frame and receipt row insert fails", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		const { actor } = activateRoot(engine, "rollback-root", 1);
		const before = persistence.exportState();
		const record = operation("owner", "operation", "intent");
		const actorKey = `actor-generation:${JSON.stringify([actor.actorId, actor.generation])}`;
		const beforeActor = persistence.get("actor", [actor.actorId]);
		const beforeActorEvidence = persistence.getControl(actorKey);
		const beforeMeta = persistence.getControl("meta");
		const database = new Database(databasePath);
		database.exec(
			"CREATE TRIGGER reject_authority_receipt BEFORE INSERT ON authority_frames BEGIN SELECT RAISE(ABORT, 'reject receipt'); END",
		);
		database.close();

		expect(() =>
			engine.transitionBatch([{ ...actor, at: 5, state: "parked" }, record], { requestId: "rollback-receipt" }),
		).toThrow("reject receipt");
		expect(persistence.get("operation", [record.ownerId, record.effectClass, record.operationId])).toBeUndefined();
		expect(persistence.get("actor", [actor.actorId])).toEqual(beforeActor);
		expect(persistence.getControl(actorKey)).toEqual(beforeActorEvidence);
		expect(persistence.getControl("meta")).toEqual(beforeMeta);
		expect(
			persistence.getControl(`receipt:${JSON.stringify(["incarnation-1", 1, "rollback-receipt"])}`),
		).toBeUndefined();
		expect(persistence.exportState()).toEqual(before);
		const evidence = new Database(databasePath);
		expect(
			evidence
				.query<{ operations: number; receipts: number; later_frames: number }, [Uint8Array, Uint8Array, number]>(
					"SELECT (SELECT count(*) FROM authority_operations WHERE order_key = ?) AS operations, (SELECT count(*) FROM authority_frames WHERE request_id = ?) AS receipts, (SELECT count(*) FROM authority_frames WHERE revision > ?) AS later_frames",
				)
				.get(
					sqliteAuthorityOrderKey([record.ownerId, record.effectClass, record.operationId]),
					cesu8Encode("rollback-receipt"),
					before.revision,
				),
		).toEqual({ operations: 0, receipts: 0, later_frames: 0 });
		evidence.close();
		persistence.close();
	});

	it("keeps compound keys exact and preserves absent optional operation fields", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		activateRoot(engine, "root:2", 1);
		activateRoot(engine, "root", 2);
		const first = {
			kind: "construction" as const,
			at: 1,
			rootId: "root:2",
			actorId: "actor",
			parentId: "root:2",
			generation: 3,
			startupHash: canonicalDurableSha256("startup"),
			provenanceHash: canonicalDurableSha256("provenance"),
			phase: "reserved" as const,
		};
		const second = { ...first, rootId: "root", actorId: "2:actor", parentId: "root" };
		const absentOptionals = operation("owner", "sparse", "intent");
		engine.transitionBatch([first, second, absentOptionals], { requestId: "compound-keys" });
		expect(persistence.get("construction", [first.rootId, first.actorId, first.generation])?.record).toEqual(first);
		expect(persistence.get("construction", [second.rootId, second.actorId, second.generation])?.record).toEqual(
			second,
		);
		expect(persistence.get("operation", ["owner", "mcp", "sparse"])?.record).toEqual(absentOptionals);
		expect((persistence.getControl("meta") as AuthorityMeta).generationHighWater).toBe(3);
		persistence.integrityCheck();
		persistence.close();
	});

	it("continues pagination in SQLite binary key order for supplementary Unicode identifiers", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const firstId = `op-${String.fromCodePoint(0x10000)}`;
		const secondId = "op-\uE000";
		const records = [operation("owner", firstId, "intent"), operation("owner", secondId, "intent")];
		const commit = makeCommit(
			1,
			authorityGenesisHash(),
			records.map(record => ({ record, version: 1 })),
			records.map(record => ({
				domain: "operation" as const,
				key: [record.ownerId, record.effectClass, record.operationId],
				version: null,
			})),
		);
		persistence.transaction(() => persistence.commit(commit));
		const firstPage = persistence.scan("operation", { openOnly: true, limit: 1 });
		const secondPage = persistence.scan("operation", { openOnly: true, after: firstPage.cursor, limit: 1 });
		expect(firstPage.rows.map(row => row.record.operationId)).toEqual([firstId]);
		expect(secondPage.rows.map(row => row.record.operationId)).toEqual([secondId]);
		persistence.close();
	});
	it("pages open operations stably and exports/reimports full receipt and history evidence", async () => {
		const { directory, databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		engine.recover();
		const records = [
			operation("owner", "op-a", "intent"),
			operation("owner", "op-b", "intent"),
			operation("owner", "op-c", "intent"),
		];
		engine.transitionBatch(records, { requestId: "paged-operations-intent" });
		engine.transition({ ...records[1]!, at: 2, phase: "effect" }, { requestId: "paged-operation-b-effect" });
		engine.transition({ ...records[2]!, at: 2, phase: "effect" }, { requestId: "paged-operation-c-effect" });
		engine.transition({ ...records[2]!, at: 3, phase: "committed" }, { requestId: "paged-operation-c-committed" });
		engine.transition({ ...records[2]!, at: 4, phase: "completed" }, { requestId: "paged-operation-c-completed" });
		const firstPage = persistence.scan("operation", { openOnly: true, limit: 1 });
		const nextPage = persistence.scan("operation", { openOnly: true, after: firstPage.cursor, limit: 1 });
		expect(firstPage.rows.map(row => row.record.operationId)).toEqual(["op-a"]);
		expect(nextPage.rows.map(row => row.record.operationId)).toEqual(["op-b"]);
		expect(nextPage.cursor).toBeUndefined();

		engine.transition({ ...records[0]!, at: 2, phase: "effect" }, { requestId: "paged-operation-a-effect" });
		const changed = { ...records[0]!, at: 3, phase: "committed" as const };
		engine.transition(changed, { requestId: "paged-operation-a-committed" });
		const exported = persistence.exportState();
		persistence.close();
		const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
		expect(reopened.exportState()).toEqual(exported);
		reopened.integrityCheck();
		reopened.close();

		const restoredPath = path.join(directory, "restored.sqlite");
		const restored = new SqliteAuthorityPersistence({ ...options(restoredPath, true), seed: exported });
		expect(restored.exportState()).toEqual(exported);
		restored.integrityCheck();
		restored.close();
	});
	it("preserves legacy journal provenance in SQLite export and reimport", async () => {
		const { directory, databasePath } = await createLocation();
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const baseExport = source.exportState();
		source.close();
		const seed = {
			...baseExport,
			legacy: { sourceSha256: canonicalDurableSha256("original-jsonl-source"), entries: [] },
		};
		const restoredPath = path.join(directory, "legacy-restored.sqlite");
		const restored = new SqliteAuthorityPersistence({ ...options(restoredPath, true), seed });
		expect(restored.exportState()).toEqual(seed);
		restored.integrityCheck();
		restored.close();
	});
	it("preserves all domain projections, retirement indexes, local cardinality and reversible history", async () => {
		const { directory, databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "owner-token");
		const owner = engine.recover().owner;
		const hash = (value: unknown): string => canonicalDurableSha256(value);
		const { root, actor, construction, gate } = activateRoot(engine, "root-1", 1);
		const op = operation(actor.actorId, "op-1", "intent");
		const transition = {
			kind: "transition" as const,
			at: 1,
			transitionId: "transition-1",
			rootId: root.rootId,
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: root.headHash,
			destinationHeadHash: hash("destination"),
			phase: "staged" as const,
		};
		const resource = {
			kind: "resource" as const,
			at: 1,
			resourceId: "resource-1",
			resourceClass: "filesystem" as const,
			operationId: op.operationId,
			actorId: actor.actorId,
			rootId: root.rootId,
			generation: 1,
			targetHash: hash("target"),
			phase: "intent" as const,
		};
		const localId = "local-1";
		const firstClaim = engine.reserveLocal(
			{ localId, entryId: "entry-1", entryHash: hash("entry-1-bytes"), expectedHeadHash: authorityGenesisHash() },
			{ requestId: "projection-first-reserve" },
		);
		engine.authorizeLocalEffect(firstClaim, { requestId: "projection-first-authorize" });
		engine.finalizeLocal({ ...firstClaim, phase: "effect" }, "committed", { requestId: "projection-first-finalize" });
		const firstLocalHead = firstClaim.headHash;
		const firstEntry = engine.getLocalEntry(localId, firstClaim.entryId, 1)!.record;
		const localHead = engine.getLocalHead(localId)!.record;
		const reserved = engine.reserveLocal(
			{ localId, entryId: "entry-2", entryHash: hash("entry-2-bytes"), expectedHeadHash: firstLocalHead },
			{ requestId: "projection-second-reserve" },
		);
		engine.authorizeLocalEffect(reserved, { requestId: "projection-second-authorize" });
		const claim = { ...reserved, phase: "effect" as const };
		const secondHeadHash = claim.headHash;
		const secondEntry = engine.getLocalEntry(localId, claim.entryId, 2)!.record;
		engine.transitionBatch([op, transition, resource], { requestId: "projection-domain-intents" });
		const rootEvidenceKey = `root-generation:${JSON.stringify([root.rootId, root.generation])}`;
		const actorEvidenceKey = `actor-generation:${JSON.stringify([actor.actorId, actor.generation])}`;
		const claimKey = `local-claim:${JSON.stringify(localId)}`;
		const projectionPrefix = persistence.exportState();
		persistence.integrityCheck();
		expect(persistence.get("root", [root.rootId])?.record).toEqual(root);
		expect(persistence.get("actor", [actor.actorId])?.record).toEqual(actor);
		expect(persistence.get("construction", [construction.rootId, construction.actorId, 1])?.record).toEqual(
			construction,
		);
		expect(persistence.get("gate", [gate.rootId])?.record).toEqual(gate);
		expect(persistence.get("operation", [op.ownerId, op.effectClass, op.operationId])?.record).toEqual(op);
		expect(persistence.get("transition", [transition.rootId, transition.transitionId])?.record).toEqual(transition);
		expect(persistence.get("resource", [resource.actorId, resource.generation, resource.resourceId])?.record).toEqual(
			resource,
		);
		expect(persistence.get("local-entry", [localId, firstEntry.entryId, 1])?.record).toEqual(firstEntry);
		expect(persistence.get("local-head", [localId])?.record).toEqual(localHead);
		expect(persistence.get("local-entry", [localId, firstEntry.entryId, 1])).toMatchObject({
			record: { phase: "committed", expectedHeadHash: authorityGenesisHash(), entryHash: firstClaim.entryHash },
			version: 3,
		});
		expect(persistence.get("local-entry", [localId, secondEntry.entryId, 2])).toMatchObject({
			record: { phase: "effect", expectedHeadHash: firstLocalHead, entryHash: claim.entryHash },
			version: 2,
		});
		expect(persistence.getControl(claimKey)).toEqual(claim);
		expect(persistence.getControl("owner")).toEqual(owner);
		expect(persistence.scan("operation", { openOnly: true, limit: 10 }).rows).toHaveLength(1);
		expect(persistence.scan("gate", { openOnly: true, limit: 10 }).rows).toHaveLength(1);
		expect(
			persistence.scan("local-entry", { openOnly: true, limit: 10 }).rows.map(row => row.record.entryId),
		).toEqual(["entry-2"]);
		expect(
			persistence.scan("local-entry", { localMatch: { localId, version: 1, headHash: firstLocalHead }, limit: 2 })
				.rows,
		).toHaveLength(1);

		engine.transition({ ...op, at: 5, phase: "effect" }, { requestId: "projection-operation-effect" });
		engine.transition({ ...op, at: 6, phase: "committed" }, { requestId: "projection-operation-committed" });
		engine.transition({ ...resource, at: 5, phase: "effect" }, { requestId: "projection-resource-effect" });
		engine.transition({ ...resource, at: 6, phase: "committed" }, { requestId: "projection-resource-committed" });
		const completedOperation = { ...op, at: 7, phase: "completed" as const };
		const completedResource = { ...resource, at: 7, phase: "completed" as const };
		engine.transitionBatch([completedOperation, completedResource], { requestId: "projection-effect-completions" });
		engine.transitionBatch(
			[
				{ ...transition, at: 8, phase: "quiescing" },
				{ ...gate, at: 8, phase: "quiescing" },
				{ ...transition, at: 9, phase: "quiesced" },
				{ ...gate, at: 9, phase: "quiesced" },
				{ ...transition, at: 10, phase: "validated" },
			],
			{ requestId: "projection-transition-validated" },
		);
		const replacementRoot = {
			...root,
			at: 11,
			generation: transition.destinationGeneration,
			headHash: transition.destinationHeadHash,
		};
		const closedGate = { ...gate, at: 11, phase: "closed" as const };
		engine.commitRootTransition(
			{
				transition: { ...transition, at: 11, phase: "cas-committed" },
				expectedRootGeneration: root.generation,
				expectedRootHeadHash: root.headHash,
				root: replacementRoot,
				gate: closedGate,
			},
			{ requestId: "projection-transition-cas" },
		);
		const retiredRoot = { ...replacementRoot, at: 13, state: "retired" as const };
		const retiredActor = { ...actor, at: 13, state: "retired" as const };
		const retiredTransition = { ...transition, at: 13, phase: "retired" as const };
		engine.transitionBatch(
			[{ ...transition, at: 12, phase: "activated" }, retiredTransition, retiredRoot, retiredActor],
			{ requestId: "projection-retire" },
		);
		expect(persistence.get("root", [root.rootId])).toEqual({ record: retiredRoot, version: 3 });
		expect(persistence.get("actor", [actor.actorId])).toEqual({ record: retiredActor, version: 2 });
		expect(
			persistence.get("construction", [construction.rootId, construction.actorId, construction.generation]),
		).toEqual({ record: construction, version: 2 });
		expect(persistence.get("gate", [gate.rootId])).toEqual({ record: closedGate, version: 3 });
		expect(persistence.get("operation", [op.ownerId, op.effectClass, op.operationId])).toEqual({
			record: completedOperation,
			version: 4,
		});
		expect(persistence.get("transition", [transition.rootId, transition.transitionId])).toEqual({
			record: retiredTransition,
			version: 4,
		});
		expect(persistence.get("resource", [resource.actorId, resource.generation, resource.resourceId])).toEqual({
			record: completedResource,
			version: 4,
		});
		expect(persistence.getControl(claimKey)).toEqual(claim);
		engine.finalizeLocal(claim, "committed", { requestId: "projection-second-finalize" });
		expect(persistence.get("local-entry", [localId, secondEntry.entryId, 2])).toMatchObject({
			record: { phase: "committed", headHash: secondHeadHash, expectedHeadHash: firstLocalHead },
			version: 3,
		});
		expect(persistence.get("local-head", [localId])).toMatchObject({
			record: { version: 2, previousHeadHash: firstLocalHead, headHash: secondHeadHash },
			version: 2,
		});
		expect(persistence.scan("root", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(persistence.scan("actor", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(persistence.scan("operation", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(persistence.scan("construction", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(persistence.scan("gate", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(persistence.scan("transition", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(persistence.scan("resource", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(persistence.scan("local-entry", { openOnly: true, limit: 10 }).rows).toHaveLength(0);
		expect(
			persistence.scan("local-entry", { localMatch: { localId, version: 2, headHash: secondHeadHash }, limit: 2 })
				.rows,
		).toHaveLength(1);
		expect(persistence.scan("local-head", { openOnly: true, limit: 10 }).rows).toHaveLength(1);
		expect(persistence.getControl(claimKey)).toBeUndefined();
		const exported = persistence.exportState();
		expect(exported.frames.map(commit => commit.command.kind)).toEqual([
			"owner",
			"owner",
			"transition-batch",
			"activate-authority",
			"reserve-local",
			"authorize-local-effect",
			"finalize-local",
			"reserve-local",
			"authorize-local-effect",
			"transition-batch",
			"transition",
			"transition",
			"transition",
			"transition",
			"transition-batch",
			"transition-batch",
			"commit-root-transition",
			"transition-batch",
			"finalize-local",
		]);
		expect(exported.frames.slice(0, projectionPrefix.frames.length)).toEqual([...projectionPrefix.frames]);
		expect(exported.generationHighWater).toBe(transition.destinationGeneration);
		expect(persistence.getControl(rootEvidenceKey)).toEqual({ record: root, version: 1 });
		expect(
			persistence.getControl(`root-generation:${JSON.stringify([root.rootId, replacementRoot.generation])}`),
		).toEqual({ record: retiredRoot, version: 2 });
		expect(persistence.getControl(actorEvidenceKey)).toEqual({ row: { record: retiredActor, version: 2 } });
		for (const commit of exported.frames) {
			expect(
				persistence.getControl(
					`receipt:${JSON.stringify([commit.receipt.incarnation, commit.receipt.ownerEpoch, commit.receipt.requestId])}`,
				),
			).toEqual(commit.receipt);
		}
		expect(exported.rows).toHaveLength(10);
		persistence.close();

		const restored = new SqliteAuthorityPersistence({
			...options(path.join(directory, "restored.sqlite"), true),
			seed: exported,
		});
		expect(restored.exportState()).toEqual(exported);
		restored.integrityCheck();
		restored.close();
	});
	it("round-trips maximum Unicode request identities across normalized SQLite and JSONL evidence", async () => {
		const { directory, databasePath } = await createLocation();
		const identity: AuthorityIdentity = {
			backend: "sqlite",
			owningSessionId: "session-1",
			incarnation: "incarnation-\ud800",
			format: 2,
		};
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true, identity));
		const engine = new AuthorityEngine(persistence, "unicode-owner");
		engine.recover();
		const authority = activateRoot(engine, "unicode-root", 1);
		const requestId = `${"R".repeat(1_999_999)}\ud800`;
		const absentExpectedKey = "absent-expected-\ud800";
		const markerLikeId = '{"$authorityRef":"request","id":1}';
		const record = operation("unicode-owner", markerLikeId, "intent");
		const receipt = engine.transition(record, {
			requestId,
			expected: [{ domain: "root", key: [absentExpectedKey], version: null }],
		});
		engine.transition({ ...record, at: 2, phase: "effect" }, { requestId: "unicode-operation-effect" });
		engine.transition({ ...record, at: 3, phase: "committed" }, { requestId: "unicode-operation-committed" });
		engine.transition({ ...record, at: 4, phase: "completed" }, { requestId: "unicode-operation-completed" });
		engine.close();
		const initialReopen = new SqliteAuthorityPersistence(options(databasePath, false, identity));
		const exported = initialReopen.exportState();
		const exportedReceipt = exported.frames.find(frame => frame.receipt.requestId === requestId)?.receipt;
		if (!exportedReceipt) throw new Error("Reopened SQLite export lacks the maximum-length request receipt.");
		expect(JSON.stringify(exportedReceipt)).toBe(JSON.stringify(receipt));
		expect(exported.rows.map(row => row.record.kind)).toEqual(
			expect.arrayContaining(["root", "actor", "construction", "gate", "operation"]),
		);
		const database = new Database(databasePath, { readonly: true });
		try {
			// The lone surrogate survives exactly: identifier columns are CESU-8 BLOBs, never lossy TEXT.
			const encodedRequestId = cesu8Encode(requestId);
			const physical = database
				.query<
					{ request_id: Uint8Array; incarnation: Uint8Array; body: Uint8Array; receipt: string },
					[Uint8Array, number]
				>("SELECT request_id, incarnation, body, receipt FROM authority_frames WHERE request_id = ? AND epoch = ?")
				.get(encodedRequestId, receipt.ownerEpoch);
			if (!physical) throw new Error("Normalized frame and receipt evidence is absent.");
			expect(Buffer.from(physical.request_id).equals(Buffer.from(encodedRequestId))).toBe(true);
			expect(Buffer.from(physical.incarnation).equals(Buffer.from(cesu8Encode(identity.incarnation)))).toBe(true);
			expect(exported.frames.find(frame => frame.receipt.requestId === requestId)?.expected).toContainEqual({
				domain: "root",
				key: [absentExpectedKey],
				version: null,
			});
			// Neither the frame body nor the receipt column repeats the request identity the row column holds.
			expect(physical.body.byteLength).toBeLessThan(10_000);
			expect(physical.receipt.length).toBeLessThan(10_000);
		} finally {
			database.close();
		}
		initialReopen.integrityCheck();
		expect(JSON.stringify(initialReopen.findReceipt(requestId, identity.incarnation, receipt.payloadHash))).toBe(
			JSON.stringify(receipt),
		);
		initialReopen.close();
		const jsonlIdentity: AuthorityIdentity = { ...identity, backend: "jsonl" };
		const jsonlPath = path.join(directory, "roundtrip.jsonl");
		const jsonl = new JsonlAuthorityPersistence({
			path: jsonlPath,
			identity: jsonlIdentity,
			create: true,
			seed: exported,
		});
		const jsonlExport = jsonl.exportState();
		expect(JSON.stringify(jsonlExport.frames)).toBe(JSON.stringify(exported.frames));
		expect(JSON.stringify(jsonlExport.controls)).toBe(JSON.stringify(exported.controls));
		expect(JSON.stringify(jsonlExport.rows)).toBe(JSON.stringify(exported.rows));
		expect(JSON.stringify(jsonl.findReceipt(requestId, identity.incarnation, receipt.payloadHash))).toBe(
			JSON.stringify(receipt),
		);
		jsonl.close();
		const reopenedJsonl = new JsonlAuthorityPersistence({ path: jsonlPath, identity: jsonlIdentity, create: false });
		const reopenedJsonlExport = reopenedJsonl.exportState();
		expect(JSON.stringify(reopenedJsonlExport.frames)).toBe(JSON.stringify(exported.frames));
		expect(JSON.stringify(reopenedJsonlExport.controls)).toBe(JSON.stringify(exported.controls));
		expect(JSON.stringify(reopenedJsonlExport.rows)).toBe(JSON.stringify(exported.rows));
		expect(JSON.stringify(reopenedJsonl.findReceipt(requestId, identity.incarnation, receipt.payloadHash))).toBe(
			JSON.stringify(receipt),
		);
		reopenedJsonl.close();
		const returned = new SqliteAuthorityPersistence({
			...options(path.join(directory, "returned.sqlite"), true, identity),
			seed: reopenedJsonlExport,
		});
		const returnedExport = returned.exportState();
		expect(JSON.stringify(returnedExport.frames)).toBe(JSON.stringify(exported.frames));
		expect(JSON.stringify(returnedExport.controls)).toBe(JSON.stringify(exported.controls));
		expect(JSON.stringify(returnedExport.rows)).toBe(JSON.stringify(exported.rows));
		expect(returned.get("root", [authority.root.rootId])?.record).toEqual(authority.root);
		expect(returned.get("actor", [authority.actor.actorId])?.record).toEqual(authority.actor);
		expect(
			returned.get("construction", [
				authority.construction.rootId,
				authority.construction.actorId,
				authority.construction.generation,
			])?.record,
		).toEqual(authority.construction);
		expect(returned.get("gate", [authority.gate.rootId])?.record).toEqual(authority.gate);
		expect(returned.get("operation", [record.ownerId, record.effectClass, record.operationId])?.record).toEqual({
			...record,
			at: 4,
			phase: "completed",
		});
		expect(JSON.stringify(returned.findReceipt(requestId, identity.incarnation, receipt.payloadHash))).toBe(
			JSON.stringify(receipt),
		);
		returned.integrityCheck();
		returned.close();
	});
	it("refuses prior SQLite physical versions before writable open or sidecar changes", async () => {
		for (const version of [2, 3]) {
			const { databasePath } = await createLocation();
			const legacy = new Database(databasePath, { create: true });
			try {
				legacy.exec(`PRAGMA application_id=0x4f4d5041; PRAGMA user_version=${version};`);
			} finally {
				legacy.close();
			}
			const originalBytes = await fs.readFile(databasePath);
			const originalMode = (await fs.stat(databasePath)).mode & 0o777;
			expect(() => new SqliteAuthorityPersistence(options(databasePath, true))).toThrow(/unsupported.*version/i);
			expect(await fs.readFile(databasePath)).toEqual(originalBytes);
			expect((await fs.stat(databasePath)).mode & 0o777).toBe(originalMode);
			expect(await fs.stat(`${databasePath}-wal`).catch(() => undefined)).toBeUndefined();
			expect(await fs.stat(`${databasePath}-shm`).catch(() => undefined)).toBeUndefined();
		}
	});

	it("rejects corrupted persisted structural frame evidence during full integrity validation", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "corruption-owner");
		engine.recover();
		engine.transition(operation("corruption-owner", "corrupt-operation", "intent"), { requestId: "corrupt-frame" });
		engine.close();
		const database = new Database(databasePath);
		database.exec("DROP TRIGGER authority_frames_no_update");
		database.query("UPDATE authority_frames SET body = ? WHERE revision = 1").run(Buffer.from('{"codec":99}'));
		database.close();
		const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
		expect(() => reopened.integrityCheck()).toThrow(/codec|frame reference/i);
		reopened.close();
	});
	it("rejects noncanonical frame identifier encodings during offline integrity", async () => {
		const { databasePath } = await createLocation();
		const identity = options(databasePath, true).identity;
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true, identity));
		const engine = new AuthorityEngine(persistence, "identifier-corruption-owner");
		engine.recover();
		const record = operation("identifier-owner", "identifier-operation", "intent");
		engine.transition(record, { requestId: "corrupt-identifier" });
		engine.transition({ ...record, at: 2, phase: "effect" }, { requestId: "identifier-effect" });
		engine.close();
		const database = new Database(databasePath);
		database.exec("DROP TRIGGER authority_frames_no_update");
		// An overlong two-byte form of "c" is not canonical CESU-8, so it decodes to nothing and matches nothing.
		const noncanonical = Buffer.concat([Buffer.from([0xc1, 0xa3]), Buffer.from("orrupt-identifier")]);
		database.run("UPDATE authority_frames SET request_id = ? WHERE request_id = ?", [
			noncanonical,
			cesu8Encode("corrupt-identifier"),
		]);
		database.close();
		const reopened = new SqliteAuthorityPersistence(options(databasePath, false, identity));
		try {
			expect(reopened.findReceipt("corrupt-identifier", identity.incarnation)).toBeUndefined();
			expect(() => reopened.integrityCheck()).toThrow(/CESU-8|order key|canonical/i);
		} finally {
			reopened.close();
		}
	});

	it("rejects noncanonical control keys and corrupted control order projections offline", async () => {
		for (const corruption of ["control-key", "control-order"] as const) {
			const { databasePath } = await createLocation();
			const identity = options(databasePath, true).identity;
			const persistence = new SqliteAuthorityPersistence(options(databasePath, true, identity));
			const engine = new AuthorityEngine(persistence, `control-corruption-${corruption}`);
			engine.recover();
			const localId = `corrupt-${corruption}`;
			engine.reserveLocal(
				{
					localId,
					entryId: "entry",
					entryHash: canonicalDurableSha256("entry"),
					expectedHeadHash: authorityGenesisHash(),
				},
				{ requestId: `reserve-${corruption}` },
			);
			engine.close();
			const key = `local-claim:${JSON.stringify(localId)}`;
			const encodedKey = cesu8Encode(key);
			const database = new Database(databasePath);
			if (corruption === "control-key") {
				// Overlong "l": the logical key no longer has a canonical encoding.
				const noncanonicalKey = Buffer.concat([Buffer.from([0xc1, 0xac]), Buffer.from(encodedKey).subarray(1)]);
				database.run("UPDATE authority_controls SET order_key = ? WHERE order_key = ?", [
					noncanonicalKey,
					encodedKey,
				]);
			} else {
				database.run("UPDATE authority_controls SET order_key = ? WHERE order_key = ?", [
					Buffer.from([0xff]),
					encodedKey,
				]);
			}
			database.close();
			const reopened = new SqliteAuthorityPersistence(options(databasePath, false, identity));
			try {
				if (corruption === "control-key") expect(reopened.getControl(key)).toBeUndefined();
				else expect(reopened.scanControl("local-claim:").controls).toEqual([]);
				expect(() => reopened.integrityCheck()).toThrow(/control|order|canonical/i);
			} finally {
				reopened.close();
			}
		}
	});
	it("rejects a receipt column that disagrees with its frame during offline integrity", async () => {
		const { databasePath } = await createLocation();
		const identity = options(databasePath, true).identity;
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true, identity));
		const engine = new AuthorityEngine(persistence, "receipt-order-corruption-owner");
		engine.recover();
		engine.close();
		const database = new Database(databasePath);
		database.exec("DROP TRIGGER authority_frames_no_update");
		database.run("UPDATE authority_frames SET receipt = json_set(receipt, '$.committedAt', 1) WHERE revision = 1");
		database.close();
		const reopened = new SqliteAuthorityPersistence(options(databasePath, false, identity));
		try {
			expect(() => reopened.integrityCheck()).toThrow(/receipt/i);
		} finally {
			reopened.close();
		}
	});
	it("preserves current receipt-control order independently from immutable frame order", async () => {
		const { directory, databasePath } = await createLocation();
		const identity: AuthorityIdentity = {
			backend: "sqlite",
			owningSessionId: "session-1",
			incarnation: "incarnation-order",
			format: 2,
		};
		const source = new SqliteAuthorityPersistence(options(databasePath, true, identity));
		new AuthorityEngine(source, "order-owner").recover();
		const original = source.exportState();
		const originalFrame = original.frames[0];
		if (!originalFrame) throw new Error("Order fixture lacks a persisted commit frame.");
		const key = `receipt:${JSON.stringify([originalFrame.receipt.incarnation, originalFrame.receipt.ownerEpoch, originalFrame.receipt.requestId])}`;
		const receiptDelta = originalFrame.controls.find(change => change.key === key);
		if (
			!receiptDelta ||
			receiptDelta.deleted ||
			!receiptDelta.value ||
			typeof receiptDelta.value !== "object" ||
			Array.isArray(receiptDelta.value)
		)
			throw new Error("Order fixture lacks its receipt-control object.");
		const reorderedValue = Object.fromEntries(Object.entries(receiptDelta.value).reverse());
		const seed = {
			...original,
			controls: original.controls.map(control =>
				control.key === key ? { ...control, value: reorderedValue } : control,
			),
		};
		source.close();
		const restored = new SqliteAuthorityPersistence({
			...options(path.join(directory, "ordered.sqlite"), true, identity),
			seed,
		});
		const exported = restored.exportState();
		const exportedDelta = exported.frames[0]!.controls.find(change => change.key === key);
		if (
			!exportedDelta ||
			exportedDelta.deleted ||
			!exportedDelta.value ||
			typeof exportedDelta.value !== "object" ||
			Array.isArray(exportedDelta.value)
		)
			throw new Error("Restored receipt-control frame slot was not projected.");
		const exportedControl = exported.controls.find(control => control.key === key);
		expect(JSON.stringify(exported.frames)).toBe(JSON.stringify(original.frames));
		expect(JSON.stringify(exportedDelta.value)).toBe(JSON.stringify(receiptDelta.value));
		expect(JSON.stringify(exportedControl?.value)).toBe(JSON.stringify(reorderedValue));
		expect(JSON.stringify(restored.getControl(key))).toBe(JSON.stringify(reorderedValue));
		expect(
			JSON.stringify(
				restored.findReceipt(
					originalFrame.receipt.requestId,
					originalFrame.receipt.incarnation,
					originalFrame.receipt.payloadHash,
				),
			),
		).toBe(JSON.stringify(reorderedValue));
		restored.integrityCheck();
		restored.close();
	});
	it("preserves accepted current row wrapper order across SQLite and JSONL reopen and import", async () => {
		const { directory, databasePath } = await createLocation();
		const identity = options(databasePath, true).identity;
		const source = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(source, "wrapper-owner");
		engine.recover();
		activateRoot(engine, "wrapper-root", 1);
		const original = source.exportState();
		engine.close();
		const seed = { ...original, rows: original.rows.map(row => ({ version: row.version, record: row.record })) };
		const expected = JSON.stringify(seed.rows);
		const sqlitePath = path.join(directory, "wrapper.sqlite");
		const sqlite = new SqliteAuthorityPersistence({ ...options(sqlitePath, true, identity), seed });
		try {
			expect(JSON.stringify(sqlite.exportState().rows)).toBe(expected);
			sqlite.integrityCheck();
		} finally {
			sqlite.close();
		}
		const reopened = new SqliteAuthorityPersistence(options(sqlitePath, false, identity));
		let sqliteExport: AuthorityExport;
		try {
			sqliteExport = reopened.exportState();
			expect(JSON.stringify(sqliteExport.rows)).toBe(expected);
		} finally {
			reopened.close();
		}
		const jsonlPath = path.join(directory, "wrapper.jsonl");
		const jsonlIdentity: AuthorityIdentity = { ...identity, backend: "jsonl" };
		const jsonl = new JsonlAuthorityPersistence({
			path: jsonlPath,
			identity: jsonlIdentity,
			create: true,
			seed: sqliteExport,
		});
		try {
			expect(JSON.stringify(jsonl.exportState().rows)).toBe(expected);
		} finally {
			jsonl.close();
		}
		const jsonlReopen = new JsonlAuthorityPersistence({ path: jsonlPath, identity: jsonlIdentity, create: false });
		let returnedSeed: AuthorityExport;
		try {
			returnedSeed = jsonlReopen.exportState();
			expect(JSON.stringify(returnedSeed.rows)).toBe(expected);
		} finally {
			jsonlReopen.close();
		}
		const returned = new SqliteAuthorityPersistence({
			...options(path.join(directory, "wrapper-return.sqlite"), true, identity),
			seed: returnedSeed,
		});
		try {
			expect(JSON.stringify(returned.exportState().rows)).toBe(expected);
			returned.integrityCheck();
		} finally {
			returned.close();
		}
	});

	it("rejects TEXT domain order keys even when their bytes equal the expected BLOB", async () => {
		const { databasePath } = await createLocation();
		const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
		const engine = new AuthorityEngine(persistence, "order-corruption-owner");
		engine.recover();
		engine.transition(operation("order-owner", "op-a", "intent"), { requestId: "order-a" });
		engine.transition(operation("order-owner", "op-b", "intent"), { requestId: "order-b" });
		engine.close();
		const database = new Database(databasePath);
		try {
			database.run(
				"UPDATE authority_operations SET order_key = CAST(order_key AS TEXT) WHERE json_extract(record, '$.operationId') = 'op-b'",
			);
			expect(
				database
					.query(
						"SELECT typeof(order_key) AS storage FROM authority_operations WHERE json_extract(record, '$.operationId') = 'op-b'",
					)
					.get(),
			).toEqual({ storage: "text" });
		} finally {
			database.close();
		}
		const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
		try {
			expect(() => reopened.integrityCheck()).toThrow(/order|BLOB/i);
		} finally {
			reopened.close();
		}
	});

	it("rejects identifier projections that disagree with their records and never aliases absent indexed filters", async () => {
		for (const target of ["root", "local"] as const) {
			const { databasePath } = await createLocation();
			const persistence = new SqliteAuthorityPersistence(options(databasePath, true));
			const engine = new AuthorityEngine(persistence, `reference-owner-${target}`);
			engine.recover();
			let localHeadHash = "";
			if (target === "root") activateRoot(engine, "reference-root", 1);
			else
				localHeadHash = engine.reserveLocal(
					{
						localId: "reference-local",
						entryId: "entry",
						entryHash: canonicalDurableSha256("entry"),
						expectedHeadHash: authorityGenesisHash(),
					},
					{ requestId: "reserve-reference" },
				).headHash;
			engine.close();
			const database = new Database(databasePath);
			try {
				if (target === "root")
					database.run("UPDATE authority_actors SET root_id = ? WHERE root_id = ?", [
						cesu8Encode("moved-root"),
						cesu8Encode("reference-root"),
					]);
				else
					database.run("UPDATE authority_local_entries SET local_id = ? WHERE local_id = ?", [
						cesu8Encode("moved-local"),
						cesu8Encode("reference-local"),
					]);
			} finally {
				database.close();
			}
			const reopened = new SqliteAuthorityPersistence(options(databasePath, false));
			try {
				// Indexed reads trust the projection; an id no row projects never matches.
				if (target === "root") {
					expect(reopened.scan("actor", { rootId: "moved-root", limit: 10 }).rows).toHaveLength(1);
					expect(reopened.scan("actor", { rootId: "reference-root", limit: 10 }).rows).toEqual([]);
					expect(reopened.scan("actor", { rootId: "never-written", limit: 10 }).rows).toEqual([]);
				} else {
					expect(
						reopened.scan("local-entry", {
							localMatch: { localId: "moved-local", version: 1, headHash: localHeadHash },
							limit: 10,
						}).rows,
					).toHaveLength(1);
					expect(
						reopened.scan("local-entry", {
							localMatch: { localId: "never-written", version: 1, headHash: localHeadHash },
							limit: 10,
						}).rows,
					).toEqual([]);
				}
				expect(() => reopened.integrityCheck()).toThrow(/projection disagrees/i);
			} finally {
				reopened.close();
			}
		}
	});
});

describe("portable SQLite live owner exclusive lock", () => {
	function readerOutcome(databasePath: string): string {
		const reader = new Database(databasePath, { readonly: true });
		try {
			reader.exec("PRAGMA busy_timeout=0");
			reader.query("SELECT count(*) FROM sqlite_master").get();
			return "read";
		} catch (error) {
			return (error as { code?: string }).code ?? String(error);
		} finally {
			reader.close();
		}
	}

	it("holds the exclusive lock from open, before any write, for created and reopened stores", async () => {
		const { databasePath } = await createLocation();
		for (const create of [true, false]) {
			const owner = new SqliteAuthorityPersistence({ ...options(databasePath, create), liveOwner: true });
			try {
				expect({ create, reader: readerOutcome(databasePath) }).toEqual({ create, reader: "SQLITE_BUSY" });
			} finally {
				owner.close();
			}
		}
		expect(readerOutcome(databasePath)).toBe("read");
	});

	it("refuses to open when the connection does not actually hold the exclusive lock", async () => {
		const { databasePath } = await createLocation();
		new SqliteAuthorityPersistence(options(databasePath, true)).close();
		// A SQLite build that accepts the pragma, reports it back, and still takes only transient locks.
		const exec = Database.prototype.exec;
		const query = Database.prototype.query;
		const execSpy = spyOn(Database.prototype, "exec").mockImplementation(function (
			this: Database,
			sql: string,
			...rest: unknown[]
		) {
			return (exec as (sql: string, ...rest: unknown[]) => unknown).call(
				this,
				sql === "PRAGMA locking_mode=EXCLUSIVE" ? "PRAGMA locking_mode=NORMAL" : sql,
				...rest,
			);
		} as typeof exec);
		const querySpy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
			return query.call(this, sql === "PRAGMA locking_mode" ? "SELECT 'exclusive' AS locking_mode" : sql);
		} as typeof query);
		let outcome: unknown = "opened";
		try {
			try {
				new SqliteAuthorityPersistence({ ...options(databasePath, false), liveOwner: true }).close();
			} catch (error) {
				outcome = error;
			}
		} finally {
			execSpy.mockRestore();
			querySpy.mockRestore();
		}
		expect(outcome).toBeInstanceOf(Error);
		expect(String((outcome as Error).message)).toContain("exclusive lock");
		// The refusal released everything: a plain reopen works.
		new SqliteAuthorityPersistence(options(databasePath, false)).close();
	});
});
