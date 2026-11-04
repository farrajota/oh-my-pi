import { CString, linkSymbols, ptr, read } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { constants } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import {
	authorityFrameBodyBound,
	cesu8Encode,
	encodeAuthorityFrameBody,
	sqliteAuthorityFrameColumns,
	sqliteAuthorityFrameRow,
	sqliteAuthorityRowValues,
} from "./sqlite-codec";
import { SQLITE_AUTHORITY_DOMAINS, SQLITE_AUTHORITY_SCHEMA, SQLITE_AUTHORITY_SCHEMA_VERSION } from "./sqlite-schema";
import { AuthorityCapacityPoolError, BorrowedAuthorityCapacityPool } from "./capacity-native";
import type { BorrowedCapacityIdentity, CapacityPoolRelease, CapacityPoolState } from "./capacity-native";
import {
	fundAuthorityCapacityTarget,
	inspectAuthorityCapacityTarget,
	inspectAuthorityCapacityTargetSuffix,
	releaseAuthorityTargetArena,
	xfsTargetEnvelope,
	type AuthorityCapacityTargetCertificate,
	type AuthorityTargetFunding,
} from "./capacity";
import {
	authorityFuturePhasePaths,
	authorityRecordIsOpen,
	authorityRecordKey,
	authorityTransitionPhases,
} from "./engine";
import { AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES } from "./types";
import type {
	AuthorityCommitFrame,
	AuthorityControl,
	AuthorityExport,
	AuthorityIdentity,
	AuthorityOwner,
	AuthorityRow,
} from "./types";
import type { DurableRegistryRecord } from "../durable-state";

const SQLITE_PAGE_BYTES = 4_096;
const SQLITE_WAL_FRAME_BYTES = 4_120;
const SQLITE_OVERFLOW_BYTES = 4_092;
const SQLITE_FILE_CHUNK_MAX = 0x7fffffff;
const SQLITE_PAGE_ALIGNED_CHUNK_PAGES = Math.floor(SQLITE_FILE_CHUNK_MAX / SQLITE_PAGE_BYTES);
const SQLITE_PAGE_ALIGNED_CHUNK_MAX = SQLITE_PAGE_ALIGNED_CHUNK_PAGES * SQLITE_PAGE_BYTES;
/*
 * B-tree height bounds (pinned sqlite3.c 3.53.4).
 * - Cursor depth: BTCURSOR_MAX_DEPTH=20 (72673-72682); moveToChild (78685) and the inlined descent of
 *   sqlite3BtreeTableMoveto/IndexMoveto (79467) return SQLITE_CORRUPT before a 21st level, so no mutation
 *   can descend a deeper tree. 20 levels is the fallback when the page population is unknown.
 * - Page population: every interior page has at least one cell, hence at least two children.
 *   balance_nonroot gives each new sibling cntNew[i] > cntNew[i-1] (81820-81825, 81866-81869, else
 *   SQLITE_CORRUPT), and its repacking never leaves the right sibling empty ("This adjustment is not
 *   optional", 81827-81863, the szRight!=0 guard); a root reduced to no cells is replaced by its only child
 *   (the balance_shallower copy in balance_nonroot) and balance_deeper only runs on an overflowing root
 *   whose content needs at least two children. A tree of L levels therefore has at least 2^(L-1) pages,
 *   so L <= 1 + floor(log2(P)) where P bounds the database page count while the command runs. (SQLite's
 *   own depth comment assumes fanout 3 below the root; the bound here uses only the provable 2.)
 * The "+1" in each 4H+1 allocation pass below is the balance_deeper root split a mutation may add.
 */
const SQLITE_MAX_CURSOR_DEPTH = 20;

/** Proven B-tree level bound for a database of at most `pages` pages. */
export function authoritySqliteTreeHeightBound(pages: number): number {
	if (!Number.isSafeInteger(pages) || pages < 0)
		throw new RangeError("SQLite page population bound must be a nonnegative safe integer");
	let levels = 1;
	while (levels < SQLITE_MAX_CURSOR_DEPTH && 2 ** levels <= pages) levels++;
	return levels;
}

/** How future commands are priced: their request envelope bound and the B-tree height valid when they run. */
interface FuturePricing {
	readonly continuationBytes: number;
	readonly treeHeight: number;
}
// Original source worksheet: 822+54 DB pages; 1800+54+12+12 WAL
// frames plus its 32-byte header. Keep all 54 generated pages AND frames.
const ROOT_NATIVE_BYTES = Object.freeze({ databaseBytes: 3_588_096, walBytes: 7_737_392, shmBytes: 98_304 });
const ROOT_NATIVE_DEBT: AuthorityCapacityDebt = Object.freeze({
	jsonlBytes: 0,
	sqliteDatabaseBytes: ROOT_NATIVE_BYTES.databaseBytes,
	sqliteWalBytes: ROOT_NATIVE_BYTES.walBytes,
	sqliteShmBytes: ROOT_NATIVE_BYTES.shmBytes,
});
const GENERATED_ROOT_NATIVE_DEBT: AuthorityCapacityDebt = Object.freeze({
	jsonlBytes: 0,
	sqliteDatabaseBytes: 54 * SQLITE_PAGE_BYTES,
	sqliteWalBytes: 54 * SQLITE_WAL_FRAME_BYTES,
	sqliteShmBytes: 98_304,
});
const HASH = "0".repeat(64);
// Each pool release fsyncs; 1 MiB steps bound that count per transfer and the
// uncertified bytes a partial conversion can strand (charged as attempt collateral).
const TRANSFER_RELEASE_BYTES = 256 * 4_096;
// Unsharing a reflinked target stages copy-on-write blocks in XFS_DEFAULT_COWEXTSZ_HINT
// (32-block) windows; ascending funding steps leave at most one window outstanding per
// inode until XFS reclaims it. Targets carry no COWEXTSIZE hint (capacity.ts identity check).
const XFS_COW_WINDOW_BYTES = 32 * 4_096;
// Minimum slack for live target arenas and pool growth; see #arenaHorizon and #ensurePoolData.
const ARENA_SLACK_BYTES = 8 * 1_048_576;
// Smallest slack of a proportional journal arena; see #arenaHorizon.
const ARENA_MIN_SLACK_BYTES = 2 * 1_048_576;

// Logical coefficient aggregate. JSONL has zero native terms but retains the
// independent command count: allocator/close collateral is funded on BOTH backends.
interface SqliteCohort {
	readonly retained: number;
	readonly reusable: number;
	readonly immutable: number;
	readonly options: number;
	readonly commands: number;
	/** Pages the commands may allocate (structural + overflow + options): the additive file-growth bound. */
	readonly allocated: number;
}
const EMPTY_COHORT: SqliteCohort = Object.freeze({
	retained: 0,
	reusable: 0,
	immutable: 0,
	options: 0,
	commands: 0,
	allocated: 0,
});
// BTCURSOR_MAX_DEPTH=20 (pinned sqlite3.c:72673-72682); deeper input is corrupt.
const SQLITE_TRANSIENT_PAGES = 2 * (4 * 20 + 1) + 2;
const liveCapacityConnections = new WeakSet<Database>();
// Schema introspection per live connection. initialize() asserts the physical schema equals the
// source-certified one and the exclusive connection cannot be altered by others, so it is stable.
const liveSchemaCache = new WeakMap<Database, Map<string, unknown>>();

function liveSchema<T>(database: Database, key: string, load: () => T): T {
	if (!liveCapacityConnections.has(database)) return load();
	let cache = liveSchemaCache.get(database);
	if (!cache) liveSchemaCache.set(database, (cache = new Map()));
	if (cache.has(key)) return cache.get(key) as T;
	const value = load();
	cache.set(key, value);
	return value;
}

function combineCohorts(left = EMPTY_COHORT, right = EMPTY_COHORT): SqliteCohort {
	return {
		retained: safeAdd(left.retained, right.retained),
		reusable: safeAdd(left.reusable, right.reusable),
		immutable: safeAdd(left.immutable, right.immutable),
		options: safeAdd(left.options, right.options),
		commands: safeAdd(left.commands, right.commands),
		allocated: safeAdd(left.allocated, right.allocated),
	};
}

function maximumCohorts(left = EMPTY_COHORT, right = EMPTY_COHORT): SqliteCohort {
	return {
		retained: Math.max(left.retained, right.retained),
		reusable: Math.max(left.reusable, right.reusable),
		immutable: Math.max(left.immutable, right.immutable),
		options: Math.max(left.options, right.options),
		commands: Math.max(left.commands, right.commands),
		allocated: Math.max(left.allocated, right.allocated),
	};
}

function subtractCohorts(left: SqliteCohort, right = EMPTY_COHORT): SqliteCohort {
	const result = {
		retained: left.retained - right.retained,
		reusable: left.reusable - right.reusable,
		immutable: left.immutable - right.immutable,
		options: left.options - right.options,
		commands: left.commands - right.commands,
		allocated: left.allocated - right.allocated,
	};
	if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 0))
		throw new Error("SQLite cohort aggregate lost a funded contribution");
	return result;
}

export interface AuthorityCapacityDebt {
	readonly jsonlBytes: number;
	readonly sqliteDatabaseBytes: number;
	/** Append-only WAL bytes of every command together (no reset between them). */
	readonly sqliteWalBytes: number;
	readonly sqliteShmBytes: number;
	readonly sqliteCohort?: SqliteCohort;
	/** WAL bytes of the largest SINGLE command: a maximum, never a sum. */
	readonly sqliteStepWalBytes?: number;
}

interface DebtEntry {
	readonly record: DurableRegistryRecord;
	readonly jsonlBytes: number;
	readonly sqliteDatabaseBytes: number;
	readonly sqliteWalBytes: number;
	readonly sqliteShmBytes: number;
	readonly sqliteCohort?: SqliteCohort;
	readonly sqliteStepWalBytes?: number;
	readonly recoveryProgress?: number;
}

function serializedBytes(value: unknown): number {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError("Authority capacity projection is not JSON serializable");
	return Buffer.byteLength(serialized, "utf8");
}

export function authoritySqliteOverflowPages(bytes: number, table: boolean): number {
	if (!Number.isSafeInteger(bytes) || bytes < 0)
		throw new RangeError("SQLite capacity record size must be a nonnegative safe integer");
	const limit = table ? SQLITE_PAGE_BYTES - 35 : 1_002;
	if (bytes <= limit) return 0;
	let local = 489 + ((bytes - 489) % SQLITE_OVERFLOW_BYTES);
	if (local > limit) local = 489;
	return Math.ceil((bytes - local) / SQLITE_OVERFLOW_BYTES);
}

function futureFrame(record: DurableRegistryRecord, phase: string, identity: AuthorityIdentity): AuthorityCommitFrame {
	// Options share the continuation request budget. futureFrameDebt composes their expansion;
	// allocating a maximum-size placeholder per unresolved row is unnecessary.
	const requestId = "";
	const ownerToken = "o".repeat(36);
	const revision = Number.MAX_SAFE_INTEGER;
	const future =
		record.kind === "root" || record.kind === "actor"
			? { ...record, at: revision, state: phase }
			: { ...record, at: revision, phase };
	const receiptKey = `receipt:${JSON.stringify([identity.incarnation, revision, requestId])}`;
	const receipt = {
		requestId,
		ownerEpoch: revision,
		revision,
		payloadHash: HASH,
		incarnation: identity.incarnation,
		commandKind:
			record.kind === "transition" && phase === "cas-committed"
				? "commit-root-transition"
				: record.kind === "transition" && ["quiescing", "quiesced"].includes(phase)
					? "transition-batch"
					: "transition",
		committedAt: revision,
		result: { kind: "mutation" },
	};
	const controls: unknown[] = [
		{ key: "meta", deleted: false, value: { revision, generationHighWater: revision, status: "ready" } },
		{ key: receiptKey, deleted: false, value: receipt },
	];
	if (record.kind === "root")
		controls.push({
			key: `root-generation:${JSON.stringify([record.rootId, record.generation])}`,
			deleted: false,
			value: { record: future, version: revision },
		});
	if (record.kind === "actor")
		controls.push({
			key: `actor-generation:${JSON.stringify([record.actorId, record.generation])}`,
			deleted: false,
			value: { row: { record: future, version: revision } },
		});
	let command: unknown = { kind: "transition", record: future };
	let changes: unknown[] = [{ record: future, version: revision }];
	let expected: unknown[] = [{ domain: record.kind, key: authorityRecordKey(record), version: revision }];
	if (record.kind === "transition" && ["quiescing", "quiesced"].includes(phase)) {
		const records: unknown[] = [future];
		const expectedRows: unknown[] = [expected[0]];
		if (phase === "quiescing" || phase === "quiesced") {
			const gate = { kind: "gate", at: revision, rootId: record.rootId, generation: record.sourceGeneration, phase };
			records.push(gate);
			expectedRows.push({ domain: "gate", key: [record.rootId], version: revision });
		}
		command = { kind: "transition-batch", records };
		changes = records.map(value => ({ record: value, version: revision }));
		expected = expectedRows;
	}
	if (record.kind === "transition" && phase === "cas-committed") {
		const root = {
			kind: "root",
			at: revision,
			rootId: record.rootId,
			generation: record.destinationGeneration,
			headHash: record.destinationHeadHash,
			state: "active",
		};
		const gate = {
			kind: "gate",
			at: revision,
			rootId: record.rootId,
			generation: record.sourceGeneration,
			phase: "closed",
		};
		command = {
			kind: "commit-root-transition",
			transition: {
				transition: future,
				expectedRootGeneration: record.sourceGeneration,
				expectedRootHeadHash: record.sourceHeadHash,
				root,
				gate,
			},
		};
		changes = [changes[0], { record: root, version: revision }, { record: gate, version: revision }];
		expected = [
			expected[0],
			{ domain: "root", key: [record.rootId], version: revision },
			{ domain: "gate", key: [record.rootId], version: revision },
		];
		controls.push({
			key: `root-generation:${JSON.stringify([record.rootId, record.destinationGeneration])}`,
			deleted: false,
			value: { record: root, version: revision },
		});
	}
	if (record.kind === "transition" && phase === "recovered") {
		const recovered = { ...future, recovery: true };
		const root = {
			kind: "root",
			at: revision,
			rootId: record.rootId,
			generation: record.sourceGeneration,
			headHash: record.sourceHeadHash,
			state: "active",
		};
		const gate = {
			kind: "gate",
			at: revision,
			rootId: record.rootId,
			generation: record.sourceGeneration,
			phase: "open",
		};
		command = {
			kind: "commit-root-transition",
			transition: {
				transition: recovered,
				expectedRootGeneration: record.sourceGeneration,
				expectedRootHeadHash: record.sourceHeadHash,
				root,
				gate,
			},
		};
		changes = [
			{ record: recovered, version: revision },
			{ record: gate, version: revision },
		];
		expected = [
			{ domain: "transition", key: authorityRecordKey(record), version: revision },
			{ domain: "gate", key: [record.rootId], version: revision },
		];
		controls.push({
			key: `root-generation:${JSON.stringify([record.rootId, record.destinationGeneration])}`,
			deleted: false,
			value: {
				record: {
					kind: "root",
					at: revision,
					rootId: record.rootId,
					generation: record.destinationGeneration,
					headHash: record.destinationHeadHash,
					state: "invalidated",
				},
				version: 1,
			},
		});
		receipt.commandKind = "commit-root-transition";
	}
	if (record.kind === "construction" && phase === "activated") {
		const root = {
			kind: "root",
			at: revision,
			rootId: record.rootId,
			generation: record.generation,
			headHash: HASH,
			state: "active",
		};
		const actor = {
			...record,
			kind: "actor",
			at: revision,
			rootGeneration: revision,
			rootHeadHash: HASH,
			scopeHash: HASH,
			parentScopeHash: HASH,
			state: "active",
		};
		const gate = { kind: "gate", at: revision, rootId: record.rootId, generation: record.generation, phase: "open" };
		const activation = { root, actor, construction: future, gate };
		command = { kind: "activate-authority", activation };
		changes = [root, actor, future, gate].map(value => ({ record: value, version: revision }));
		expected = changes.map(value => {
			const row = value as { record: DurableRegistryRecord };
			return { domain: row.record.kind, key: authorityRecordKey(row.record), version: revision };
		});
		controls.push(
			{
				key: `root-generation:${JSON.stringify([record.rootId, record.generation])}`,
				deleted: false,
				value: { record: root, version: revision },
			},
			{
				key: `actor-generation:${JSON.stringify([record.actorId, record.generation])}`,
				deleted: false,
				value: { row: { record: actor, version: revision }, parentGeneration: revision },
			},
			{ key: `root-recovery:${JSON.stringify([record.rootId])}`, deleted: true },
		);
		receipt.commandKind = "activate-authority";
	}
	if (record.kind === "local-entry") {
		const claim = {
			localId: record.localId,
			entryId: record.entryId,
			version: record.version,
			entryHash: record.entryHash,
			headHash: record.headHash,
			previousHeadHash: record.expectedHeadHash,
			claimToken: "c".repeat(36),
			ownerEpoch: revision,
			incarnation: identity.incarnation,
			phase: "uncertain",
		};
		const claimKey = `local-claim:${JSON.stringify(record.localId)}`;
		if (phase === "uncertain") {
			command = { kind: "finalize-local", claim: { ...claim, phase: "effect" }, outcome: "uncertain" };
			changes = [];
			expected = [];
			controls.push({ key: claimKey, deleted: false, value: claim });
		} else {
			command = {
				kind: "reconcile-local",
				input: {
					claim,
					observedEntryHash: record.entryHash,
					action: phase === "committed" ? "commit" : "restore-predecessor",
				},
			};
			controls.push({ key: claimKey, deleted: true });
			if (phase === "committed") {
				const head = {
					kind: "local-head",
					at: revision,
					localId: record.localId,
					version: record.version,
					previousHeadHash: record.expectedHeadHash,
					headHash: record.headHash,
					phase: "current",
				};
				changes.push({ record: head, version: revision });
				expected.push({ domain: "local-head", key: [record.localId], version: revision });
			}
		}
		// Both direct finalization and uncertain-then-reconciliation return publication
		// evidence. Reserving the longer path also funds restore-predecessor disposition.
		Object.assign(receipt, {
			commandKind: phase === "uncertain" ? "finalize-local" : "reconcile-local",
			result: { kind: "local-publication", publication: { version: record.version, headHash: record.headHash } },
		});
	}
	const frame = {
		version: 2,
		kind: "commit",
		revision,
		request: { requestId, incarnation: identity.incarnation, ownerEpoch: revision, ownerToken },
		command,
		payloadHash: HASH,
		expected,
		changes,
		controls,
		receipt,
		previousHash: HASH,
		committedAt: revision,
		contentHash: HASH,
		hash: HASH,
	};
	return frame as unknown as AuthorityCommitFrame;
}

function appendFutureDebt(left: AuthorityCapacityDebt, right: AuthorityCapacityDebt): AuthorityCapacityDebt {
	return {
		jsonlBytes: safeAdd(left.jsonlBytes, right.jsonlBytes),
		sqliteDatabaseBytes: safeAdd(left.sqliteDatabaseBytes, right.sqliteDatabaseBytes),
		sqliteWalBytes: safeAdd(left.sqliteWalBytes, right.sqliteWalBytes),
		sqliteShmBytes: Math.max(left.sqliteShmBytes, right.sqliteShmBytes),
		sqliteCohort: combineCohorts(left.sqliteCohort, right.sqliteCohort),
		sqliteStepWalBytes: Math.max(left.sqliteStepWalBytes ?? 0, right.sqliteStepWalBytes ?? 0),
	};
}

function maximumFutureDebt(paths: readonly AuthorityCapacityDebt[]): AuthorityCapacityDebt {
	return paths.reduce(
		(maximum, debt) => ({
			jsonlBytes: Math.max(maximum.jsonlBytes, debt.jsonlBytes),
			sqliteDatabaseBytes: Math.max(maximum.sqliteDatabaseBytes, debt.sqliteDatabaseBytes),
			sqliteWalBytes: Math.max(maximum.sqliteWalBytes, debt.sqliteWalBytes),
			sqliteShmBytes: Math.max(maximum.sqliteShmBytes, debt.sqliteShmBytes),
			sqliteCohort: maximumCohorts(maximum.sqliteCohort, debt.sqliteCohort),
			sqliteStepWalBytes: Math.max(maximum.sqliteStepWalBytes ?? 0, debt.sqliteStepWalBytes ?? 0),
		}),
		ZERO_DEBT,
	);
}

/*
 * Debt of one promised future command. The skeleton frame carries the record at its next phase with an empty
 * requestId; `requestEnvelope` adds what a real request of at most `pricing.continuationBytes` encoded bytes can add on
 * top of it. Every promised step is a continuation, and the engine refuses a continuation whose encoded request
 * (command with its records, plus requestId and options) exceeds AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES before
 * acknowledging or writing it, so the envelope is priced at that bound, never at the 2 MiB admission bound.
 * Expansion stays linear in the request: a requestId byte appears in the frame request, the receipt, the
 * receipt control value and (escaped twice) the receipt control key, at most 5x its request encoding; a
 * record byte appears at most 3x (command, changed row, generation control). SQLite (physical schema v4) stores
 * at most 3x the request in option/overflow payload, plus 3 pages of boundary slack: the 2x of the v3 layout, plus
 * the requestId copy the frame row's receipt column now holds beside its request_id column and receipt index entry
 * (v3 kept those two copies in its dictionary row and index). The stored v4 body never exceeds its reference-free
 * form, whose copies are the v3 body's.
 */
const FUTURE_NATIVE_DEBT_CACHE_LIMIT = 4_096;
const futureNativeDebts = new Map<string, AuthorityCapacityDebt>();

function futureFrameDebt(
	frame: AuthorityCommitFrame,
	identity: AuthorityIdentity,
	pricing: FuturePricing,
	requestEnvelope: boolean,
): AuthorityCapacityDebt {
	if (identity.backend === "jsonl")
		return {
			jsonlBytes: serializedBytes(frame) + (requestEnvelope ? 5 * pricing.continuationBytes : 0) + 1,
			sqliteDatabaseBytes: 0,
			sqliteWalBytes: 0,
			sqliteShmBytes: 0,
			sqliteCohort: { ...EMPTY_COHORT, commands: 1 },
		};
	// Without a database the native debt is a pure function of the skeleton frame and height. The same skeleton recurs
	// across a record's alternative paths and again when its next phase is priced, so reuse it by exact content.
	const key = `${pricing.treeHeight}|${JSON.stringify(frame)}`;
	let native = futureNativeDebts.get(key);
	if (!native) {
		if (futureNativeDebts.size >= FUTURE_NATIVE_DEBT_CACHE_LIMIT) futureNativeDebts.clear();
		native = Object.freeze(sqliteCommitDebt(frame, undefined, true, pricing.treeHeight));
		futureNativeDebts.set(key, native);
	}
	if (!requestEnvelope) return native;
	const optionPages = Math.ceil((3 * pricing.continuationBytes) / SQLITE_OVERFLOW_BYTES) + 3;
	const walBytes = safeAdd(native.sqliteWalBytes, optionPages * SQLITE_WAL_FRAME_BYTES);
	return {
		...native,
		sqliteDatabaseBytes: safeAdd(native.sqliteDatabaseBytes, optionPages * SQLITE_PAGE_BYTES),
		sqliteWalBytes: walBytes,
		sqliteStepWalBytes: walBytes,
		sqliteCohort: combineCohorts(native.sqliteCohort, {
			retained: optionPages,
			reusable: 0,
			immutable: 0,
			options: optionPages,
			commands: 0,
			allocated: optionPages,
		}),
	};
}

/*
 * Debt of the promised command that moves `record` to `phase`. futureFrame is a pure function of (record, phase,
 * identity.incarnation) and futureFrameDebt of that frame, the backend, the pricing and the envelope flag, so the
 * result is keyed by exactly those inputs. Except for a construction (whose activation spreads the raw record into its
 * actor, current phase included), futureFrame reads the record only through its future form, the record with `at` and
 * its phase (`state` for roots and actors) replaced, so that form stands for the record in the key: the same future
 * frame is then shared by a record's alternative paths, by repeated projections, and by the record's next version,
 * whose remaining futures its predecessor already priced. Like the skeleton cache it refines, the key identifies a
 * record by its JSON text.
 */
const FUTURE_RECORD_DEBT_CACHE_LIMIT = 4_096;
const futureRecordDebts = new Map<string, AuthorityCapacityDebt>();

/*
 * The phase-independent part of a record's key (built once per record per pricing pass, for all its phases). The future
 * form is the record's fields in their order with `at` and the phase field overwritten (or appended when absent), so it
 * is determined by the phase, the field order and every other field's value; the key spells out exactly those.
 */
function futureRecordKeyBase(record: DurableRegistryRecord): string {
	if (record.kind === "construction") return JSON.stringify(record);
	const replaced = record.kind === "root" || record.kind === "actor" ? "state" : "phase";
	return `${JSON.stringify(Object.keys(record))}|${JSON.stringify({ ...record, at: undefined, [replaced]: undefined })}`;
}

function futureRecordFrameDebt(
	record: DurableRegistryRecord,
	keyBase: string,
	phase: string,
	identity: AuthorityIdentity,
	pricing: FuturePricing,
	requestEnvelope: boolean,
): AuthorityCapacityDebt {
	const key = `${identity.backend}|${JSON.stringify(identity.incarnation)}|${pricing.treeHeight}|${pricing.continuationBytes}|${requestEnvelope ? 1 : 0}|${phase}|${keyBase}`;
	let debt = futureRecordDebts.get(key);
	if (!debt) {
		if (futureRecordDebts.size >= FUTURE_RECORD_DEBT_CACHE_LIMIT) futureRecordDebts.clear();
		debt = Object.freeze(futureFrameDebt(futureFrame(record, phase, identity), identity, pricing, requestEnvelope));
		futureRecordDebts.set(key, debt);
	}
	return debt;
}

function futurePathDebt(
	record: DurableRegistryRecord,
	keyBase: string,
	phases: readonly string[],
	identity: AuthorityIdentity,
	pricing: FuturePricing,
): AuthorityCapacityDebt {
	let debt = ZERO_DEBT;
	for (const phase of phases) {
		const requestEnvelope =
			record.kind === "construction" ||
			record.kind === "operation" ||
			record.kind === "resource" ||
			record.kind === "transition" ||
			record.kind === "local-entry" ||
			record.kind === "root" ||
			record.kind === "actor" ||
			record.kind === "gate";
		debt = appendFutureDebt(debt, futureRecordFrameDebt(record, keyBase, phase, identity, pricing, requestEnvelope));
		if (record.kind === "construction" && phase === "activated")
			debt = appendFutureDebt(debt, activationDownstreamDebt(record, identity, pricing));
		if (record.kind === "transition" && phase === "recovered") {
			const gate: DurableRegistryRecord = {
				kind: "gate",
				at: Number.MAX_SAFE_INTEGER,
				rootId: record.rootId,
				generation: record.sourceGeneration,
				phase: "open",
			};
			debt = appendFutureDebt(debt, recordFutureDebt(gate, identity, pricing));
		}
	}
	return debt;
}

function recordFutureDebt(
	record: DurableRegistryRecord,
	identity: AuthorityIdentity,
	pricing: FuturePricing,
	uncertain = false,
	includeGateFuture = true,
	recoveryProgress = 0,
): AuthorityCapacityDebt {
	if (!authorityRecordIsOpen(record)) return ZERO_DEBT;
	const phasePaths = authorityFuturePhasePaths(record, uncertain);
	const keyBase = phasePaths.length > 0 ? futureRecordKeyBase(record) : "";
	const paths = phasePaths.map(path => futurePathDebt(record, keyBase, path, identity, pricing));
	let debt = maximumFutureDebt(paths);
	const boundedRootDomain =
		identity.backend === "sqlite" && (record.kind === "root" || record.kind === "actor" || record.kind === "gate");
	if (record.kind === "transition" && paths.length > 0 && identity.backend === "sqlite") {
		// The scalar fallback retains its original worksheet. The live shared
		// forest already bounds structural allocation; add, rather than drop,
		// the original 54 generated DB pages AND 54 WAL frames as it is consumed.
		debt = appendFutureDebt(debt, ROOT_NATIVE_DEBT);
		// The worksheet's frames may all fall into one step's transaction.
		debt = { ...debt, sqliteStepWalBytes: safeAdd(debt.sqliteStepWalBytes ?? 0, ROOT_NATIVE_BYTES.walBytes) };
		const cohort = debt.sqliteCohort ?? EMPTY_COHORT;
		const remaining = authorityTransitionPhases(record.phase).filter(phase => phase !== "recovered").length;
		debt = {
			...debt,
			sqliteCohort: {
				...cohort,
				retained: safeAdd(cohort.retained, Math.ceil((54 * remaining) / 6)),
				reusable: safeAdd(cohort.reusable, Math.ceil((54 * remaining) / 6)),
				allocated: safeAdd(cohort.allocated, ROOT_NATIVE_BYTES.databaseBytes / SQLITE_PAGE_BYTES),
			},
		};
	}
	if (boundedRootDomain && paths.length > 0)
		debt = {
			...appendFutureDebt(debt, GENERATED_ROOT_NATIVE_DEBT),
			sqliteStepWalBytes: safeAdd(debt.sqliteStepWalBytes ?? 0, GENERATED_ROOT_NATIVE_DEBT.sqliteWalBytes),
		};
	if (boundedRootDomain && paths.length > 0)
		debt = {
			...debt,
			sqliteCohort: combineCohorts(debt.sqliteCohort, {
				retained: 54,
				reusable: 54,
				immutable: 0,
				options: 0,
				commands: 0,
				allocated: 54,
			}),
		};
	if (record.kind === "root" && record.state === "active" && recoveryProgress < 2) {
		if (recoveryProgress === 0)
			debt = appendFutureDebt(debt, futureFrameDebt(rootRecoveryFrame(record, identity), identity, pricing, false));
		debt = appendFutureDebt(
			debt,
			futureFrameDebt(rootRecoveryActivationFrame(record, identity), identity, pricing, true),
		);
		// Revival reopens a gate; its downstream progress is independent of
		// the current gate's progress. Neither path assumes optional batching.
		if (includeGateFuture || recoveryProgress === 0) {
			const gate: DurableRegistryRecord = {
				kind: "gate",
				at: Number.MAX_SAFE_INTEGER,
				rootId: record.rootId,
				generation: record.generation,
				phase: "open",
			};
			debt = appendFutureDebt(debt, recordFutureDebt(gate, identity, pricing));
		}
	}
	return debt;
}

function activationDownstreamDebt(
	record: Extract<DurableRegistryRecord, { kind: "construction" }>,
	identity: AuthorityIdentity,
	pricing: FuturePricing,
): AuthorityCapacityDebt {
	const revision = Number.MAX_SAFE_INTEGER;
	const actor: DurableRegistryRecord = {
		...record,
		kind: "actor",
		at: revision,
		rootGeneration: revision,
		rootHeadHash: HASH,
		scopeHash: record.scopeHash ?? HASH,
		parentScopeHash: record.parentScopeHash ?? HASH,
		state: "active",
	};
	let debt = recordFutureDebt(actor, identity, pricing);
	if (record.actorId === record.rootId && record.parentId === undefined) {
		const root: DurableRegistryRecord = {
			kind: "root",
			at: revision,
			rootId: record.rootId,
			generation: record.generation,
			headHash: HASH,
			state: "active",
		};
		const gate: DurableRegistryRecord = {
			kind: "gate",
			at: revision,
			rootId: record.rootId,
			generation: record.generation,
			phase: "open",
		};
		// Activation occurs in this ready owner's episode, or completes its
		// already-funded recovery. Its resulting root has recovery progress 2;
		// a later owner must fund a new recovery episode before claiming it.
		debt = appendFutureDebt(
			appendFutureDebt(debt, recordFutureDebt(root, identity, pricing, false, false, 2)),
			recordFutureDebt(gate, identity, pricing),
		);
	}
	return debt;
}

function makeDebtEntry(
	record: DurableRegistryRecord,
	identity: AuthorityIdentity,
	pricing: FuturePricing,
	_database?: Database,
	uncertain = false,
	includeGateFuture = true,
	recoveryProgress = 0,
): DebtEntry | undefined {
	if (!authorityRecordIsOpen(record)) return undefined;
	return {
		record,
		recoveryProgress,
		...recordFutureDebt(record, identity, pricing, uncertain, includeGateFuture, recoveryProgress),
	};
}

// Fixed-size 4KiB buckets through the supported 64MiB horizon, then logarithmic overflow buckets.
const WAL_BUCKET_BYTES = 4_096;
const WAL_LINEAR_BUCKETS = 16_384;
const WAL_BUCKET_COUNT = WAL_LINEAR_BUCKETS + 54;

function walBucket(bytes: number): number {
	const units = Math.ceil(bytes / WAL_BUCKET_BYTES);
	return units <= WAL_LINEAR_BUCKETS
		? units - 1
		: WAL_LINEAR_BUCKETS + Math.ceil(Math.log2(bytes / (WAL_LINEAR_BUCKETS * WAL_BUCKET_BYTES))) - 1;
}
// Buckets per summary block: maximum() skips whole empty blocks instead of probing all ~16k buckets.
const WAL_BLOCK_BUCKETS = 128;

function walBucketBytes(bucket: number): number {
	return bucket < WAL_LINEAR_BUCKETS
		? (bucket + 1) * WAL_BUCKET_BYTES
		: WAL_LINEAR_BUCKETS * WAL_BUCKET_BYTES * 2 ** (bucket - WAL_LINEAR_BUCKETS + 1);
}

class BoundedMaximum {
	readonly #counts = new Float64Array(WAL_BUCKET_COUNT);
	// Number of nonzero buckets in each block of WAL_BLOCK_BUCKETS.
	readonly #occupied = new Uint32Array(Math.ceil(WAL_BUCKET_COUNT / WAL_BLOCK_BUCKETS));

	adjust(bytes: number, delta: number): void {
		if (bytes === 0) return;
		const bucket = walBucket(bytes);
		const previous = this.#counts[bucket]!;
		const count = previous + delta;
		if (count < 0) throw new Error("SQLite capacity high-water index lost an outstanding cohort");
		this.#counts[bucket] = count;
		const block = Math.floor(bucket / WAL_BLOCK_BUCKETS);
		if (previous === 0 && count !== 0) this.#occupied[block]!++;
		else if (previous !== 0 && count === 0) this.#occupied[block]!--;
	}

	/** Largest bucket whose count plus its pending adjustment is positive; identical to a full top-down scan. */
	maximum(adjustments?: ReadonlyMap<number, number>): number {
		// A bucket in an unoccupied block can only become positive through an adjustment.
		let best = -1;
		if (adjustments)
			for (const [bucket, delta] of adjustments)
				if (bucket > best && this.#counts[bucket]! + delta > 0) best = bucket;
		for (let block = this.#occupied.length - 1; block >= 0; block--) {
			const first = block * WAL_BLOCK_BUCKETS;
			if (first + WAL_BLOCK_BUCKETS - 1 <= best) break;
			if (this.#occupied[block] === 0) continue;
			for (
				let bucket = Math.min(WAL_BUCKET_COUNT, first + WAL_BLOCK_BUCKETS) - 1;
				bucket >= first && bucket > best;
				bucket--
			) {
				if (this.#counts[bucket]! + (adjustments?.get(bucket) ?? 0) > 0) {
					best = bucket;
					break;
				}
			}
			if (best >= first) break;
		}
		return best < 0 ? 0 : walBucketBytes(best);
	}
}
/*
 * Request bound every promised future command is priced at. A continuation is bounded both by the engine's
 * continuation cap and by the configured admission (wire) bound, so the smaller of the two is sound.
 */
function continuationPricingBytes(maxRequestBytes: number): number {
	return Math.min(maxRequestBytes, AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES);
}

export class AuthorityCapacityDebtLedger {
	readonly #identity: AuthorityIdentity;
	#pricing: FuturePricing;
	readonly #entries = new Map<string, DebtEntry>();
	readonly #openGates = new Set<string>();
	#ownerReady = false;
	#sqliteWalBytes = 0;
	readonly #shmMaximum = new BoundedMaximum();
	readonly #stepWalMaximum = new BoundedMaximum();
	readonly #uncertainClaims = new Set<string>();
	#jsonlBytes = 0;
	#sqliteDatabaseBytes = 0;
	#cohort: SqliteCohort = EMPTY_COHORT;
	#projection:
		| {
				readonly frame: AuthorityCommitFrame;
				readonly replacements: ReadonlyMap<string, DebtEntry | undefined>;
				readonly debt: AuthorityCapacityDebt;
		  }
		| undefined;

	/** `treeHeight` must bound every B-tree while any priced command runs; the cursor-depth fallback always does. */
	constructor(
		identity: AuthorityIdentity,
		maxRequestBytes: number,
		records: Iterable<DurableRegistryRecord> = [],
		_database?: Database,
		controls: Iterable<AuthorityControl> = [],
		treeHeight = SQLITE_MAX_CURSOR_DEPTH,
	) {
		if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1)
			throw new RangeError("Authority request bound must be a positive safe integer");
		if (!Number.isSafeInteger(treeHeight) || treeHeight < 1 || treeHeight > SQLITE_MAX_CURSOR_DEPTH)
			throw new RangeError("Authority B-tree height bound is invalid");
		this.#identity = identity;
		this.#pricing = { continuationBytes: continuationPricingBytes(maxRequestBytes), treeHeight };
		for (const control of controls) {
			if (
				control.key.startsWith("local-claim:") &&
				control.value &&
				typeof control.value === "object" &&
				"phase" in control.value &&
				control.value.phase === "uncertain"
			)
				this.#uncertainClaims.add(control.key);
		}
		const initialRecords = [...records];
		for (const record of initialRecords)
			if (record.kind === "gate" && authorityRecordIsOpen(record)) this.#openGates.add(record.rootId);
		for (const record of initialRecords) this.#replace(record);
	}

	currentDebt(): AuthorityCapacityDebt {
		return {
			jsonlBytes: this.#jsonlBytes,
			sqliteDatabaseBytes: this.#sqliteDatabaseBytes,
			sqliteWalBytes: this.#sqliteWalBytes,
			sqliteShmBytes: this.#shmMaximum.maximum(),
			sqliteCohort: this.#cohort,
			sqliteStepWalBytes: this.#stepWalMaximum.maximum(),
		};
	}

	get treeHeight(): number {
		return this.#pricing.treeHeight;
	}

	/** Re-prices every open obligation for a larger B-tree height bound (the database may now grow past the old one). */
	raiseTreeHeight(treeHeight: number): void {
		if (!Number.isSafeInteger(treeHeight) || treeHeight > SQLITE_MAX_CURSOR_DEPTH)
			throw new RangeError("Authority B-tree height bound is invalid");
		if (treeHeight <= this.#pricing.treeHeight) return;
		this.#pricing = { ...this.#pricing, treeHeight };
		this.#projection = undefined;
		for (const [key, entry] of [...this.#entries]) {
			const next = this.#makeEntry(entry.record);
			this.#remove(key, entry);
			this.#insert(key, next);
		}
	}

	hasTransitionPromise(record: Extract<DurableRegistryRecord, { kind: "transition" }>): boolean {
		const previous = this.#entries.get(this.#key(record))?.record;
		return (
			previous?.kind === "transition" &&
			["staged", "quiescing", "quiesced", "validated"].includes(previous.phase) &&
			(record.phase === "recovered" || (record.phase === "cas-committed" && previous.phase === "validated")) &&
			previous.sourceGeneration === record.sourceGeneration &&
			previous.destinationGeneration === record.destinationGeneration &&
			previous.sourceHeadHash === record.sourceHeadHash &&
			previous.destinationHeadHash === record.destinationHeadHash
		);
	}

	hasGatePromise(record: Extract<DurableRegistryRecord, { kind: "gate" }>): boolean {
		const previous = this.#entries.get(this.#key(record))?.record;
		if (previous?.kind !== "gate" || previous.generation !== record.generation) return false;
		return authorityFuturePhasePaths(previous).some(path => path.includes(record.phase));
	}

	hasStepPromise(record: DurableRegistryRecord): boolean {
		const previous = this.#entries.get(this.#key(record))?.record;
		if (!previous || previous.kind !== record.kind) return false;
		if ("generation" in previous && "generation" in record && previous.generation !== record.generation) return false;
		const phase = "state" in record ? record.state : record.phase;
		return authorityFuturePhasePaths(previous).some(path => path.includes(phase));
	}

	hasActivationPromise(frame: AuthorityCommitFrame): boolean {
		if (frame.command.kind !== "activate-authority") return false;
		const { actor, construction } = frame.command.activation;
		const reserved = this.#entries.get(this.#key(construction))?.record;
		if (
			reserved?.kind === "construction" &&
			reserved.phase === "constructed" &&
			reserved.startupHash === construction.startupHash &&
			reserved.provenanceHash === construction.provenanceHash
		)
			return true;
		const root = this.#entries.get(JSON.stringify(["root", actor.rootId]));
		return (
			actor.actorId === actor.rootId &&
			actor.parentId === undefined &&
			root?.record.kind === "root" &&
			root.record.generation === actor.generation &&
			(root.recoveryProgress ?? 0) < 2
		);
	}

	project(frame: AuthorityCommitFrame): AuthorityCapacityDebt {
		let jsonlBytes = this.#jsonlBytes;
		let sqliteDatabaseBytes = this.#sqliteDatabaseBytes;
		let sqliteWalBytes = this.#sqliteWalBytes;
		let cohort = this.#cohort;
		const shmChanges = new Map<number, number>();
		const stepChanges = new Map<number, number>();
		const replacements = new Map<string, DebtEntry | undefined>();
		const adjustShm = (bytes: number, delta: number): void => {
			if (bytes === 0) return;
			const bucket = walBucket(bytes);
			shmChanges.set(bucket, (shmChanges.get(bucket) ?? 0) + delta);
		};
		const adjustStep = (bytes: number | undefined, delta: number): void => {
			if (!bytes) return;
			const bucket = walBucket(bytes);
			stepChanges.set(bucket, (stepChanges.get(bucket) ?? 0) + delta);
		};
		for (const row of this.#affectedRows(frame)) {
			const key = this.#key(row.record);
			const old = this.#entries.get(key);
			if (old) {
				jsonlBytes -= old.jsonlBytes;
				sqliteDatabaseBytes -= old.sqliteDatabaseBytes;
				sqliteWalBytes -= old.sqliteWalBytes;
				if (sqliteWalBytes < 0) throw new Error("SQLite WAL append debt lost an outstanding cohort");
				adjustShm(old.sqliteShmBytes, -1);
				adjustStep(old.sqliteStepWalBytes, -1);
				cohort = subtractCohorts(cohort, old.sqliteCohort);
			}
			const next = this.#makeEntry(row.record, frame);
			replacements.set(key, next);
			if (next) {
				jsonlBytes = safeAdd(jsonlBytes, next.jsonlBytes);
				sqliteDatabaseBytes = safeAdd(sqliteDatabaseBytes, next.sqliteDatabaseBytes);
				sqliteWalBytes = safeAdd(sqliteWalBytes, next.sqliteWalBytes);
				adjustShm(next.sqliteShmBytes, 1);
				adjustStep(next.sqliteStepWalBytes, 1);
				cohort = combineCohorts(cohort, next.sqliteCohort);
			}
		}
		const debt = {
			jsonlBytes,
			sqliteDatabaseBytes,
			sqliteWalBytes,
			sqliteShmBytes: this.#shmMaximum.maximum(shmChanges),
			sqliteCohort: cohort,
			sqliteStepWalBytes: this.#stepWalMaximum.maximum(stepChanges),
		};
		this.#projection = { frame, replacements, debt };
		return debt;
	}

	apply(frame: AuthorityCommitFrame): void {
		const projection = this.#projection;
		if (!projection || projection.frame !== frame)
			throw new Error("Authority debt commit has no matching precommit projection");
		for (const [key, next] of projection.replacements) {
			this.#remove(key, this.#entries.get(key));
			this.#insert(key, next);
		}
		for (const row of frame.changes) {
			if (row.record.kind !== "gate") continue;
			if (authorityRecordIsOpen(row.record)) this.#openGates.add(row.record.rootId);
			else this.#openGates.delete(row.record.rootId);
		}
		if (frame.command?.kind === "owner" && frame.command.owner.phase === "ready") this.#ownerReady = true;
		for (const control of frame.controls) {
			if (!control.key.startsWith("local-claim:")) continue;
			if (
				!control.deleted &&
				control.value &&
				typeof control.value === "object" &&
				"phase" in control.value &&
				control.value.phase === "uncertain"
			)
				this.#uncertainClaims.add(control.key);
			else this.#uncertainClaims.delete(control.key);
		}
		this.#projection = undefined;
	}

	#key(record: DurableRegistryRecord): string {
		return JSON.stringify([record.kind, ...authorityRecordKey(record)]);
	}

	#replace(record: DurableRegistryRecord): void {
		this.#insert(this.#key(record), this.#makeEntry(record));
	}

	#makeEntry(record: DurableRegistryRecord, frame?: AuthorityCommitFrame): DebtEntry | undefined {
		if (!authorityRecordIsOpen(record)) return undefined;
		let uncertain = false;
		if (record.kind === "local-entry") {
			const key = `local-claim:${JSON.stringify(record.localId)}`;
			const control = frame?.controls.find(change => change.key === key);
			uncertain = control
				? !control.deleted &&
					!!control.value &&
					typeof control.value === "object" &&
					"phase" in control.value &&
					control.value.phase === "uncertain"
				: this.#uncertainClaims.has(key);
		}
		if (record.kind !== "root") return makeDebtEntry(record, this.#identity, this.#pricing, undefined, uncertain);
		const changedGate = frame?.changes.find(
			({ record: change }) => change.kind === "gate" && change.rootId === record.rootId,
		)?.record;
		const gateOpen =
			changedGate === undefined ? this.#openGates.has(record.rootId) : authorityRecordIsOpen(changedGate);
		const recoveryKey = `root-recovery:${JSON.stringify([record.rootId])}`;
		const recoveryChange = frame?.controls.find(control => control.key === recoveryKey);
		const progress = recoveryChange
			? recoveryChange.deleted
				? 2
				: 1
			: (this.#entries.get(this.#key(record))?.recoveryProgress ??
				(frame && (this.#ownerReady || frame.command?.kind === "activate-authority") ? 2 : 0));
		return makeDebtEntry(record, this.#identity, this.#pricing, undefined, uncertain, !gateOpen, progress);
	}

	#affectedRows(frame: AuthorityCommitFrame): readonly AuthorityRow[] {
		const rows = new Map(frame.changes.map(row => [this.#key(row.record), row]));
		for (const row of frame.changes) {
			if (row.record.kind !== "gate") continue;
			const key = JSON.stringify(["root", row.record.rootId]);
			const entry = this.#entries.get(key);
			if (entry && !rows.has(key)) rows.set(key, { record: entry.record, version: frame.revision });
		}
		for (const control of frame.controls) {
			if (
				!control.key.startsWith("local-claim:") ||
				control.deleted ||
				!control.value ||
				typeof control.value !== "object"
			)
				continue;
			const claim = control.value as { localId: string; entryId: string; version: number };
			const key = JSON.stringify(["local-entry", claim.localId, claim.entryId, claim.version]);
			const entry = this.#entries.get(key);
			if (entry && !rows.has(key)) rows.set(key, { record: entry.record, version: frame.revision });
		}
		return [...rows.values()];
	}

	#insert(key: string, entry: DebtEntry | undefined): void {
		if (!entry) return;
		this.#entries.set(key, entry);
		this.#jsonlBytes = safeAdd(this.#jsonlBytes, entry.jsonlBytes);
		this.#sqliteDatabaseBytes = safeAdd(this.#sqliteDatabaseBytes, entry.sqliteDatabaseBytes);
		this.#sqliteWalBytes = safeAdd(this.#sqliteWalBytes, entry.sqliteWalBytes);
		this.#shmMaximum.adjust(entry.sqliteShmBytes, 1);
		this.#stepWalMaximum.adjust(entry.sqliteStepWalBytes ?? 0, 1);
		this.#cohort = combineCohorts(this.#cohort, entry.sqliteCohort);
	}

	#remove(key: string, entry: DebtEntry | undefined): void {
		if (!entry) return;
		this.#entries.delete(key);
		this.#jsonlBytes -= entry.jsonlBytes;
		this.#sqliteDatabaseBytes -= entry.sqliteDatabaseBytes;
		this.#sqliteWalBytes -= entry.sqliteWalBytes;
		if (this.#sqliteWalBytes < 0) throw new Error("SQLite WAL append debt lost an outstanding cohort");
		this.#shmMaximum.adjust(entry.sqliteShmBytes, -1);
		this.#stepWalMaximum.adjust(entry.sqliteStepWalBytes ?? 0, -1);
		this.#cohort = subtractCohorts(this.#cohort, entry.sqliteCohort);
	}
}
const ZERO_DEBT: AuthorityCapacityDebt = Object.freeze({
	jsonlBytes: 0,
	sqliteDatabaseBytes: 0,
	sqliteWalBytes: 0,
	sqliteShmBytes: 0,
});

function jsonBytes(value: unknown): number {
	const text = JSON.stringify(value);
	if (text === undefined) throw new TypeError("Authority capacity projection is not JSON serializable");
	return Buffer.byteLength(text, "utf8");
}

function safeAdd(left: number, right: number): number {
	const value = left + right;
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError("Authority capacity horizon exceeds the safe integer range");
	return value;
}

/* Pinned SQLite 3.53.4 source: unixTruncate rounds xTruncate to szChunk before robust_ftruncate (44164-44173),
 * fcntlSizeHint preallocates to that boundary (44246-44289), and unixFileControl stores CHUNK_SIZE
 * walCheckpoint size-hints mxPage*pageSize (69800-69815), then truncates to
 * hdr.nPage*pageSize (69844-69851); charge rounded EOF apart from logical pages. */
function sqliteDatabaseChunkSize(horizonBytes: number): number {
	if (!Number.isSafeInteger(horizonBytes) || horizonBytes < 0 || horizonBytes % SQLITE_PAGE_BYTES !== 0)
		throw new RangeError("SQLite database arena must be a nonnegative whole-page horizon");
	if (horizonBytes === 0) return 0;
	if (horizonBytes <= SQLITE_PAGE_ALIGNED_CHUNK_MAX) return horizonBytes;
	// Above the signed-int file-control ABI, split the horizon into the fewest equal whole-page chunks that fit it.
	// Rounding the horizon up to a single maximum chunk instead could fund up to ~2 GiB SQLite never needs.
	const pages = horizonBytes / SQLITE_PAGE_BYTES;
	const chunks = Math.ceil(pages / SQLITE_PAGE_ALIGNED_CHUNK_PAGES);
	return Math.ceil(pages / chunks) * SQLITE_PAGE_BYTES;
}

/*
 * End of the funded database arena for a horizon: the horizon rounded up to its own chunk, which is exactly where
 * SQLite's chunked truncate and size hint can take the file. It exceeds the horizon by less than one page per chunk,
 * and an arena end maps to the same chunk again (ceil(n/k) pages per chunk divides k*ceil(n/k) pages), so a reopened
 * or re-bound arena keeps its rounding.
 */
function sqliteDatabaseArenaEnd(horizonBytes: number): number {
	const chunkBytes = sqliteDatabaseChunkSize(horizonBytes);
	return chunkBytes === 0 ? 0 : roundUp(horizonBytes, chunkBytes);
}

/** The chunk size bound for a whole-page database horizon and the funded arena end SQLite's chunk rounding can reach. */
export function authoritySqliteDatabaseArena(horizonBytes: number): {
	readonly chunkBytes: number;
	readonly endBytes: number;
} {
	return { chunkBytes: sqliteDatabaseChunkSize(horizonBytes), endBytes: sqliteDatabaseArenaEnd(horizonBytes) };
}

/*
 * The database horizon whose chunk is bound after funding `target` over certified `backing`: the larger one when it
 * is its own arena end (so every chunk rounding of a smaller size stays inside it), else the funded target. Funded
 * targets are always arena ends; only an unusual pre-existing backing can fail the test.
 */
function sqliteBoundDatabaseHorizon(target: number, backing: number): number {
	const horizon = Math.max(target, backing);
	return sqliteDatabaseArenaEnd(horizon) === horizon ? horizon : target;
}

/*
 * The page count recorded in an existing database header (offset 28), or undefined when it is not provably current:
 * it is valid only when the version-valid-for number (offset 92) equals the change counter (offset 24), and only for
 * the supported 4 KiB page size. With auto_vacuum=0 a committed page count never decreases, so every later checkpoint
 * snapshot has at least this many pages. A short or empty file has no floor.
 */
function sqliteHeaderPageCount(descriptor: number): number | undefined {
	const header = Buffer.alloc(100);
	const bytes = fs.readSync(descriptor, header, 0, 100, 0);
	if (
		bytes !== 100 ||
		header.toString("latin1", 0, 16) !== "SQLite format 3\0" ||
		header.readUInt16BE(16) !== SQLITE_PAGE_BYTES ||
		header.readUInt32BE(24) !== header.readUInt32BE(92)
	)
		return undefined;
	return header.readUInt32BE(28);
}

function sqliteExistingDatabaseChunkSize(fileBytes: number): number {
	if (!Number.isSafeInteger(fileBytes) || fileBytes <= 0 || fileBytes % SQLITE_PAGE_BYTES !== 0) return 0;
	// Only an EOF that already is its own arena end is preserved; any other size binds no chunk until admission funds one.
	const chunkBytes = sqliteDatabaseChunkSize(fileBytes);
	return fileBytes % chunkBytes === 0 ? chunkBytes : 0;
}

function setSqliteDatabaseChunkSize(database: Database, chunkBytes: number, buffer: Int32Array): void {
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0 || chunkBytes > SQLITE_FILE_CHUNK_MAX)
		throw new RangeError("SQLite database chunk size exceeds the signed-int file-control ABI");
	buffer[0] = chunkBytes;
	buffer[1] = 0;
	if (database.fileControl("main", constants.SQLITE_FCNTL_CHUNK_SIZE, buffer) !== 0 || buffer[0] !== chunkBytes)
		throw new Error("SQLite authority could not bind the funded database-arena chunk size to its opened connection");
}

function fileSize(filename: string): number {
	try {
		const size = fs.statSync(filename).size;
		if (!Number.isSafeInteger(size) || size < 0)
			throw new RangeError(`Authority target ${filename} has an unsafe logical size`);
		return size;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
		throw error;
	}
}

function targetHorizons(filename: string, identity: AuthorityIdentity): AuthorityCapacityDebt {
	if (identity.backend === "jsonl")
		return { jsonlBytes: fileSize(filename), sqliteDatabaseBytes: 0, sqliteWalBytes: 0, sqliteShmBytes: 0 };
	return {
		jsonlBytes: 0,
		sqliteDatabaseBytes: fileSize(filename),
		sqliteWalBytes: fileSize(`${filename}-wal`),
		sqliteShmBytes: fileSize(`${filename}-shm`),
	};
}

function plusDebt(left: AuthorityCapacityDebt, right: AuthorityCapacityDebt): AuthorityCapacityDebt {
	return {
		jsonlBytes: safeAdd(left.jsonlBytes, right.jsonlBytes),
		sqliteDatabaseBytes: safeAdd(left.sqliteDatabaseBytes, right.sqliteDatabaseBytes),
		sqliteWalBytes: safeAdd(left.sqliteWalBytes, right.sqliteWalBytes),
		sqliteShmBytes: safeAdd(left.sqliteShmBytes, right.sqliteShmBytes),
		sqliteCohort: combineCohorts(left.sqliteCohort, right.sqliteCohort),
		sqliteStepWalBytes: Math.max(left.sqliteStepWalBytes ?? 0, right.sqliteStepWalBytes ?? 0),
	};
}

function addHorizons(current: AuthorityCapacityDebt, increment: AuthorityCapacityDebt): AuthorityCapacityDebt {
	return {
		jsonlBytes: safeAdd(current.jsonlBytes, increment.jsonlBytes),
		sqliteDatabaseBytes: safeAdd(current.sqliteDatabaseBytes, increment.sqliteDatabaseBytes),
		sqliteWalBytes: safeAdd(current.sqliteWalBytes, increment.sqliteWalBytes),
		sqliteShmBytes: Math.max(current.sqliteShmBytes, increment.sqliteShmBytes),
	};
}

function sameHorizons(left: AuthorityCapacityDebt, right: AuthorityCapacityDebt): boolean {
	return (
		left.jsonlBytes === right.jsonlBytes &&
		left.sqliteDatabaseBytes === right.sqliteDatabaseBytes &&
		left.sqliteWalBytes === right.sqliteWalBytes &&
		left.sqliteShmBytes === right.sqliteShmBytes
	);
}

function xfsHorizonBytes(horizon: AuthorityCapacityDebt, identity: AuthorityIdentity): number {
	const envelope =
		identity.backend === "jsonl"
			? xfsTargetEnvelope({ databaseBytes: horizon.jsonlBytes, walBytes: 0, shmBytes: 0 })
			: xfsTargetEnvelope({
					databaseBytes: horizon.sqliteDatabaseBytes,
					walBytes: horizon.sqliteWalBytes,
					shmBytes: horizon.sqliteShmBytes,
				});
	// Keep a separate two-split (2*(7-1)) close/directory envelope even
	// after the final owner marker consumed its per-command transfer loan.
	return safeAdd(envelope.totalBytes, 12 * SQLITE_PAGE_BYTES);
}

/*
 * Metadata+workspace bytes that N separate appends totalling A bytes can spend,
 * one xfsTargetEnvelope per append. An append is a JSONL write past EOF or a
 * KEEP_SIZE fallocate past a target's certified dense prefix: it adds at most one
 * extent record per new block (extents are >= 1 block) plus a boundary split, and
 * a 4KiB bmbt node holds >= 125 records (CRC minrecs), so level l gains at most
 * ceil(r_l/125)+1 nodes for r_l new records, over <= 7 levels, plus one bounded
 * per-transaction workspace (6-block chunk or two conversion splits). Per level,
 * sum(ceil(x_i/125)+1) <= ceil(sum(x_i)/125) + 2N - 1 because ceil(a)+ceil(b) <=
 * ceil(a+b)+1; block straddle gives level-0 input ceil(A/4096) + N - 1. The bound
 * is splittable: aggregate(A, N) >= envelope(a) + aggregate(A - a, N - 1) at every
 * level, so a transfer of one append's envelope leaves the remaining appends funded.
 * It grows with appended bytes and append count, never with the file's horizon.
 */
function xfsAppendOverheadBytes(appendBytes: number, commands: number): number {
	if (commands === 0) return 0;
	let levelInput = safeAdd(Math.ceil(appendBytes / 4_096), commands - 1);
	let metadataBlocks = 0;
	for (let level = 0; level < 7; level++) {
		levelInput = safeAdd(Math.ceil(levelInput / 125), 2 * commands - 1);
		metadataBlocks = safeAdd(metadataBlocks, levelInput);
	}
	return safeAdd(metadataBlocks, 12 * commands) * 4_096;
}

function roundUp(value: number, blockSize: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(blockSize) || blockSize <= 0)
		throw new RangeError("Invalid authority allocation alignment");
	const aligned = Math.ceil(value / blockSize) * blockSize;
	if (!Number.isSafeInteger(aligned))
		throw new RangeError("Authority allocation alignment exceeds the safe integer range");
	return aligned;
}

function poolDataTarget(targetBytes: number, blockSize: number): number {
	let dataBytes = roundUp(targetBytes, blockSize);
	for (;;) {
		const poolEnvelope = xfsTargetEnvelope({ databaseBytes: dataBytes, walBytes: 0, shmBytes: 0 });
		const metadataAndWorkspace = (poolEnvelope.metadataBlocks + poolEnvelope.workspaceBlocks) * 4_096;
		const next = roundUp(safeAdd(targetBytes, metadataAndWorkspace), blockSize);
		if (next <= dataBytes) return dataBytes;
		dataBytes = next;
	}
}

/** A BLOB known only by its length (an upper bound priced without materializing the bytes). */
interface SqlBlobLength {
	readonly blobBytes: number;
}
type SqlScalar = string | number | bigint | Uint8Array | SqlBlobLength | null;
interface SqlTreeMutation {
	readonly table: boolean;
	readonly immutable: boolean;
	readonly inserted: number[];
	readonly removed: number[];
}

function varintBytes(value: number): number {
	let bytes = 1;
	while (value >= 128 && bytes < 9) {
		value = Math.floor(value / 128);
		bytes++;
	}
	return bytes;
}

/** SQLite format-4 serial types, including zero-byte integer serial types 8/9. */
function sqlRecordBytes(values: readonly SqlScalar[]): number {
	let dataBytes = 0;
	let serialBytes = 0;
	for (const value of values) {
		let bytes: number;
		let serial: number;
		if (value === null) {
			bytes = 0;
			serial = 0;
		} else if (typeof value === "number" || typeof value === "bigint") {
			if (value === 0 || value === 1 || value === 0n || value === 1n) {
				bytes = 0;
				serial = Number(value) + 8;
			} else if (typeof value === "number" && !Number.isInteger(value)) {
				bytes = 8;
				serial = 7;
			} else {
				const integer = BigInt(value);
				bytes =
					[1, 2, 3, 4, 6, 8].find(
						width => integer >= -(1n << BigInt(width * 8 - 1)) && integer < 1n << BigInt(width * 8 - 1),
					) ?? 8;
				serial = bytes <= 4 ? bytes : bytes === 6 ? 5 : 6;
			}
		} else {
			bytes =
				typeof value === "string"
					? Buffer.byteLength(value, "utf8")
					: value instanceof Uint8Array
						? value.byteLength
						: value.blobBytes;
			serial = 2 * bytes + (typeof value === "string" ? 13 : 12);
		}
		dataBytes = safeAdd(dataBytes, bytes);
		serialBytes = safeAdd(serialBytes, varintBytes(serial));
	}
	let header = serialBytes + 1;
	while (header !== serialBytes + varintBytes(header)) header = serialBytes + varintBytes(header);
	return safeAdd(header, dataBytes);
}

interface SourceTableShape {
	readonly indexes: readonly { readonly name: string }[];
	/** Index key columns (then the table key) as the source schema declares them, for an index of this table. */
	indexFields(name: string): readonly { readonly name: string | null }[];
}

// Derived only from the constant source schema, so one parse per table serves every priced frame.
const sourceTableShapes = new Map<string, SourceTableShape>();

function sourceTableShape(table: string, rowid: boolean): SourceTableShape {
	const cached = sourceTableShapes.get(table);
	if (cached) return cached;
	const definition = SQLITE_AUTHORITY_SCHEMA.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?;`))?.[0] ?? "";
	const primary = rowid
		? []
		: (/PRIMARY KEY\s*\(([^)]+)\)/
				.exec(definition)?.[1]
				?.split(",")
				.map(field => field.trim()) ?? []);
	const fallbackIndexes: { name: string; fields: string[] }[] = [
		...SQLITE_AUTHORITY_SCHEMA.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX (\\w+) ON ${table}\\(([^)]+)\\)`, "g")),
	].map(match => ({ name: match[1]!, fields: match[2]!.split(",").map(field => field.trim()) }));
	for (const match of definition.matchAll(/\bUNIQUE\s*\(([^)]+)\)|\b(\w+)\s+[^,()]+\bUNIQUE\b/g)) {
		fallbackIndexes.push({
			name: `${table}:unique:${fallbackIndexes.length}`,
			fields: match[1]?.split(",").map(field => field.trim()) ?? [match[2]!],
		});
	}
	const fieldsByIndex = new Map<string, readonly { readonly name: string | null }[]>();
	const indexFields = (name: string): readonly { readonly name: string | null }[] => {
		let fields = fieldsByIndex.get(name);
		if (!fields) {
			const fallback = fallbackIndexes.find(candidate => candidate.name === name);
			const names = [...(fallback?.fields ?? []), ...primary.filter(field => !fallback?.fields.includes(field))];
			fieldsByIndex.set(
				name,
				(fields = [...names.map(field => ({ name: field })), ...(rowid ? [{ name: null }] : [])]),
			);
		}
		return fields;
	};
	const shape: SourceTableShape = { indexes: fallbackIndexes, indexFields };
	sourceTableShapes.set(table, shape);
	return shape;
}

/**
 * Native debt of one commit frame. `treeHeight` must bound every B-tree while it runs; without one, a live
 * connection derives it from its page count plus this frame's own allocations, else the cursor-depth fallback.
 */
function sqliteCommitDebt(
	frame: AuthorityCommitFrame,
	database: Database | undefined,
	allocateShm: boolean,
	treeHeight?: number,
): AuthorityCapacityDebt {
	// Only a connection holding this build's physical schema is read; anything else (a fresh file during bootstrap)
	// is priced from the source schema alone.
	if (
		database &&
		!liveSchema(
			database,
			"schema",
			() =>
				database!.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ===
					SQLITE_AUTHORITY_SCHEMA_VERSION &&
				database!
					.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE name = 'authority_frames' LIMIT 1")
					.get() != null,
		)
	)
		database = undefined;
	const trees = new Map<string, SqlTreeMutation>();
	const add = (
		name: string,
		table: boolean,
		immutable: boolean,
		inserted: number | undefined,
		removed?: number,
	): void => {
		const mutation: SqlTreeMutation = trees.get(name) ?? { table, immutable, inserted: [], removed: [] };
		if (inserted !== undefined) mutation.inserted.push(inserted);
		if (removed !== undefined) mutation.removed.push(removed);
		trees.set(name, mutation);
	};
	// v4 B-trees a commit touches: the frame row (rowid table, immutable) and its receipt index, each changed
	// domain table and its indexes, and the control table. No dictionary, no separate receipt table.
	const write = (
		table: string,
		values: Record<string, SqlScalar> | undefined,
		previous?: Record<string, SqlScalar>,
	): void => {
		const rowid = table === "authority_frames";
		const columns =
			(database &&
				liveSchema(database, `columns:${table}`, () =>
					database
						.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
						.all()
						.map(column => column.name),
				)) ??
			Object.keys(values ?? previous ?? {});
		const immutable = rowid;
		add(
			table,
			rowid,
			immutable,
			values &&
				sqlRecordBytes(columns.map(column => (rowid && column === "revision" ? null : (values[column] ?? null)))),
			previous && sqlRecordBytes(columns.map(column => previous[column] ?? null)),
		);
		const shape = sourceTableShape(table, rowid);
		const indexes =
			(database &&
				liveSchema(database, `indexes:${table}`, () =>
					database
						.query<{ name: string }, [string]>(
							"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND rootpage > 0",
						)
						.all(table),
				)) ??
			shape.indexes;
		for (const index of indexes) {
			const fields =
				(database &&
					liveSchema(database, `index:${index.name}`, () =>
						database
							.query<{ name: string | null }, []>(`PRAGMA index_xinfo("${index.name.replaceAll('"', '""')}")`)
							.all(),
					)) ??
				shape.indexFields(index.name);
			// Charging inactive partial-index entries too is conservative; indexes
			// are enumerated by their actual names, not guessed projection counts.
			add(
				index.name,
				false,
				immutable,
				values &&
					sqlRecordBytes(
						fields.map(field => (field.name === null ? Number.MAX_SAFE_INTEGER : (values[field.name] ?? null))),
					),
				previous &&
					sqlRecordBytes(
						fields.map(field => (field.name === null ? Number.MAX_SAFE_INTEGER : (previous[field.name] ?? null))),
					),
			);
		}
	};
	const columns = sqliteAuthorityFrameColumns(frame);
	// A live commit writes exactly the encoded body (cached for the driver's write); a future or offline frame is
	// priced at the uncompressed reference-free bound, which no stored body exceeds.
	const body: SqlScalar = database
		? encodeAuthorityFrameBody(frame, columns)
		: { blobBytes: authorityFrameBodyBound(frame, columns) };
	write("authority_frames", { ...sqliteAuthorityFrameRow(columns), body });
	for (const row of frame.changes) {
		const schema = SQLITE_AUTHORITY_DOMAINS[row.record.kind];
		const values: Record<string, SqlScalar> = sqliteAuthorityRowValues(row);
		const previous =
			database
				?.query<Record<string, SqlScalar>, [Uint8Array]>(`SELECT * FROM ${schema.table} WHERE order_key = ?`)
				.get(values.order_key as Uint8Array) ?? undefined;
		write(schema.table, values, previous);
	}
	for (const change of frame.controls) {
		if (change.key.startsWith("receipt:")) continue;
		const key = cesu8Encode(change.key);
		const previous =
			database
				?.query<Record<string, SqlScalar>, [Uint8Array]>("SELECT * FROM authority_controls WHERE order_key = ?")
				.get(key) ?? undefined;
		const value =
			!change.deleted && change.key === "meta"
				? { ...(change.value as object), headHash: frame.hash }
				: !change.deleted
					? change.value
					: undefined;
		write(
			"authority_controls",
			change.deleted ? undefined : { order_key: key, value: JSON.stringify(value) },
			previous,
		);
	}
	const price = (height: number) => {
		let allocations = 0;
		let dirty = 1; // Page 1 is a transaction-unique union member.
		let freed = 0;
		let cohort = EMPTY_COHORT;
		for (const tree of trees.values()) {
			const inserts = tree.inserted.length;
			const deletes = tree.removed.length;
			const structuralAllocations = inserts * (4 * height + 1) + deletes * 2 * (4 * height + 1);
			const oldCandidates = Math.min(Number.MAX_SAFE_INTEGER, (inserts + 2 * deletes) * (6 * (height + 1) + 2));
			const newOverflow = tree.inserted.reduce(
				(sum, bytes) => sum + authoritySqliteOverflowPages(bytes, tree.table),
				0,
			);
			const oldOverflow = tree.removed.reduce(
				(sum, bytes) => sum + authoritySqliteOverflowPages(bytes, tree.table),
				0,
			);
			allocations = safeAdd(allocations, structuralAllocations + newOverflow);
			dirty = safeAdd(dirty, oldCandidates + structuralAllocations + newOverflow + oldOverflow);
			freed = safeAdd(freed, oldCandidates + oldOverflow);
			cohort = combineCohorts(cohort, {
				retained: 2 * inserts + newOverflow,
				reusable: 2 * inserts + (tree.immutable ? 0 : newOverflow),
				immutable: tree.immutable ? newOverflow : 0,
				options: 0,
				commands: 0,
				allocated: structuralAllocations + newOverflow,
			});
		}
		return { allocations, dirty, freed, cohort };
	};
	let priced = price(treeHeight ?? SQLITE_MAX_CURSOR_DEPTH);
	if (treeHeight === undefined && database) {
		// The database holds at most its current pages plus this frame's allocations while the frame runs.
		const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
		if (pages === undefined || !Number.isSafeInteger(pages) || pages < 0)
			throw new Error("Invalid SQLite page-count readback");
		const height = authoritySqliteTreeHeightBound(safeAdd(pages, priced.allocations));
		if (height < SQLITE_MAX_CURSOR_DEPTH) priced = price(height);
	}
	const { allocations, freed, cohort } = priced;
	let { dirty } = priced;
	// At most the old free-page population can be old trunks. Newly formed trunks are already in the
	// affected union. No deletion is negative debt. A future frame cannot read the freelist it will meet,
	// so it is charged the population that bound caps.
	const freePages = database?.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count;
	if (freePages !== undefined && (!Number.isSafeInteger(freePages) || freePages < 0))
		throw new Error("Invalid SQLite freelist readback");
	dirty = safeAdd(dirty, Math.min(freePages ?? Number.MAX_SAFE_INTEGER, allocations + freed) + 2);
	const walBytes = safeAdd(dirty * SQLITE_WAL_FRAME_BYTES, 32);
	return {
		jsonlBytes: 0,
		sqliteDatabaseBytes: allocations * SQLITE_PAGE_BYTES,
		sqliteWalBytes: walBytes,
		sqliteStepWalBytes: walBytes,
		sqliteShmBytes: allocateShm ? 32_768 * Math.max(1, Math.ceil((dirty + 34) / 4_096)) : 0,
		sqliteCohort: { ...cohort, commands: 1 },
	};
}

interface SqliteNativeCertificate {
	readonly retained: number;
	readonly reusable: number;
	/**
	 * Logical page count the additive bound starts from, or undefined without a bound live connection.
	 * Pages only appear through allocation (no autovacuum, so the file never shrinks below its high page), so
	 * pages + the allocations of every command that can run before a point bound the page count at that point.
	 */
	readonly pages?: number;
}

function assertSqliteCapacitySchema(database: Database): void {
	const normalize = (sql: string): string => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
	const expected = new Map<string, { type: string; sql: string }>();
	for (const match of SQLITE_AUTHORITY_SCHEMA.matchAll(/CREATE (?:UNIQUE )?(TABLE|INDEX) (\w+)[\s\S]*?;/g))
		expected.set(match[2]!, { type: match[1]!.toLowerCase(), sql: normalize(match[0]) });
	for (const match of SQLITE_AUTHORITY_SCHEMA.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?END;/g))
		expected.set(match[1]!, { type: "trigger", sql: normalize(match[0]) });
	const actual = database
		.query<{ name: string; type: string; sql: string | null }, []>(
			`SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT ${expected.size + 1}`,
		)
		.all();
	if (
		actual.length !== expected.size ||
		actual.some(entry => {
			const descriptor = expected.get(entry.name);
			return (
				!descriptor ||
				descriptor.type !== entry.type ||
				entry.sql === null ||
				normalize(entry.sql) !== descriptor.sql
			);
		})
	)
		throw new Error("SQLite authority physical schema differs from the source-certified native mutation descriptors");
}

/* Source-pinned forest certificate (sqlite3.c 79739-80035, 81830-81930,
 * 82182-82483): a stable table has <=2n structural pages, an index <=n,
 * plus its already existing empty root. Balancing reuses siblings; a
 * single B-tree operation has at most two 20-level passes, each <=4H+1
 * allocations. One shared 164-page arena bounds their coexistence. SQL
 * mutations are sequential, so this is not multiplied by batch size.
 * With no autovacuum, allocation reuses the freelist before extending.
 * Thus baseline pages + 2*(baseline cells + lifetime inserted cells) +
 * lifetime new overflow + the arena bounds the maximum DB page number,
 * even after removals/replacements and arbitrarily sparse freelist trunks.
 * Deleted pages never become negative debt. Initial page 1/schema pages
 * remain in baseline, not in the changing population.
 *
 * For WAL, subtract ONLY observed overflow owned by immutable table/index
 * cells. Balance moves their cell/overflow pointers, not overflow payload
 * (81401-81428, 81670-81765, 82000-82055); pointer maps are disabled.
 * All mutable overflow ever allocated, old free pages and every structural
 * candidate remain in reusable. Add the entire projected cohort's native
 * work, which dominates any <=100-row batch, plus one whole command's
 * option envelope. DB options are still ADDITIVE over independent future
 * commands; only a confirmed exclusive reset permits WAL reuse. Spill is
 * disabled/read back, so a cached page has only its final commit image.
 *
 * The bounded observer reads headers/child pointers through this opened
 * connection's xRead, after complete checkpoint, at most 256 pages/1MiB.
 * It reads payload LENGTH varints, never payload or overflow chains. If
 * incomplete, every page is allowed 2046 record cells and no overflow is
 * excluded: a finite, coarser certificate, never a partial tight result.
 * No unresolved entry caches geometry, and no ordinary commit observes
 * history or walks a tree. Contributions change only at affected keys.
 */

/** At most 256 native pages, never an overflow chain or a decoded history row. */
function observeSqliteCertificate(database: Database): SqliteNativeCertificate {
	if (!liveCapacityConnections.has(database))
		throw new Error("SQLite capacity observation requires the bound live connection");
	const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
	if (pages === undefined || !Number.isSafeInteger(pages) || pages < 1)
		throw new Error("Invalid SQLite certificate page population");
	const fallback = (): SqliteNativeCertificate => {
		const bound = safeAdd(pages, safeAdd(2 * 2_046 * pages, SQLITE_TRANSIENT_PAGES));
		return { retained: bound, reusable: bound };
	};
	const output = new BigUint64Array(1);
	if (database.fileControl("main", constants.SQLITE_FCNTL_FILE_POINTER, output) !== 0)
		throw new Error("SQLite certificate cannot obtain its actual opened file");
	const native = Number(output[0]);
	if (!Number.isSafeInteger(native) || native <= 0) throw new Error("Invalid SQLite certificate file pointer");
	const io = read.ptr(native, 0);
	const method = io && read.ptr(io, 16);
	if (!method || !Number.isSafeInteger(method)) throw new Error("SQLite certificate actual VFS omits xRead");
	const reader = linkSymbols({
		xRead: { ptr: method as Pointer, args: ["ptr", "ptr", "i32", "i64"], returns: "i32" },
	});
	const roots = database
		.query<{ rootpage: number; tbl_name: string }, []>(
			"SELECT rootpage, tbl_name FROM sqlite_schema WHERE rootpage > 0",
		)
		.all();
	const pending = [
		{ page: 1, immutable: false, population: false },
		...roots.map(root => ({
			page: root.rootpage,
			population: !["authority_identity", "authority_legacy_source"].includes(root.tbl_name),
			immutable: ["authority_frames", "authority_identity", "authority_legacy_source"].includes(root.tbl_name),
		})),
	];
	const seen = new Set<number>();
	const buffer = Buffer.allocUnsafe(SQLITE_PAGE_BYTES);
	let cells = 0;
	let immutableOverflow = 0;
	const payloadSize = (offset: number): number => {
		let value = 0;
		for (let index = 0; index < 9; index++) {
			const byte = buffer[offset + index];
			if (byte === undefined) throw new Error("SQLite certificate payload varint crosses its page");
			value = value * (index === 8 ? 256 : 128) + (index === 8 ? byte : byte & 127);
			if (!Number.isSafeInteger(value)) throw new Error("SQLite certificate payload exceeds safe native bounds");
			if (index === 8 || byte < 128) return value;
		}
		throw new Error("Invalid SQLite certificate payload varint");
	};
	try {
		while (pending.length) {
			if (seen.size === 256) return fallback();
			const next = pending.pop()!;
			if (!Number.isSafeInteger(next.page) || next.page < 1 || next.page > pages || seen.has(next.page))
				throw new Error("SQLite certificate found an invalid or repeated B-tree child");
			seen.add(next.page);
			if (
				reader.symbols.xRead(
					native as Pointer,
					ptr(buffer),
					SQLITE_PAGE_BYTES,
					BigInt((next.page - 1) * SQLITE_PAGE_BYTES),
				) !== 0
			)
				throw new Error("SQLite certificate native page read failed");
			const base = next.page === 1 ? 100 : 0;
			const flags = buffer[base]!;
			if (![2, 5, 10, 13].includes(flags)) throw new Error("SQLite certificate found an unsupported B-tree header");
			const leaf = flags === 10 || flags === 13;
			const table = flags === 5 || flags === 13;
			const count = buffer.readUInt16BE(base + 3);
			const pointers = base + (leaf ? 8 : 12);
			if (pointers + 2 * count > SQLITE_PAGE_BYTES)
				throw new Error("SQLite certificate cell pointers exceed their page");
			if (!leaf && seen.size + pending.length + count + 1 > 256) return fallback();
			if (next.population) cells = safeAdd(cells, table && !leaf ? 0 : count);
			if (!leaf) pending.push({ ...next, page: buffer.readUInt32BE(base + 8) });
			for (let index = 0; index < count; index++) {
				const offset = buffer.readUInt16BE(pointers + 2 * index);
				if (offset < pointers + 2 * count || offset >= SQLITE_PAGE_BYTES - (leaf ? 0 : 4))
					throw new Error("SQLite certificate found an invalid cell offset");
				if (!leaf) pending.push({ ...next, page: buffer.readUInt32BE(offset) });
				if (next.immutable && (!table || leaf))
					immutableOverflow = safeAdd(
						immutableOverflow,
						authoritySqliteOverflowPages(payloadSize(offset + (leaf ? 0 : 4)), table),
					);
			}
		}
	} finally {
		reader.close();
	}
	if (immutableOverflow > pages) throw new Error("SQLite certificate overflow exceeds the actual page population");
	const structural = safeAdd(2 * cells, SQLITE_TRANSIENT_PAGES);
	return { retained: safeAdd(pages, structural), reusable: safeAdd(pages - immutableOverflow, structural) };
}

export function authoritySqliteBootstrapDebt(seed?: AuthorityExport): AuthorityCapacityDebt {
	const objectCount = (SQLITE_AUTHORITY_SCHEMA.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b/gi) ?? []).length;
	const schemaBytes = Buffer.byteLength(SQLITE_AUTHORITY_SCHEMA, "utf8");
	let debt: AuthorityCapacityDebt = {
		jsonlBytes: 0,
		sqliteDatabaseBytes: (Math.ceil(schemaBytes / 489) + objectCount + 4) * SQLITE_PAGE_BYTES,
		sqliteWalBytes: (Math.ceil(schemaBytes / 489) + objectCount + 4) * SQLITE_WAL_FRAME_BYTES + 32,
		sqliteShmBytes: 32_768,
	};
	if (!seed) return debt;
	// Import's physical work is normalized rows, controls and immutable
	// evidence, not the byte length of the logical export JSON.
	for (const frame of seed.frames) debt = plusDebt(debt, sqliteCommitDebt(frame, undefined, false));
	const represented = new Set(
		seed.frames.flatMap(frame =>
			frame.changes.map(row => JSON.stringify([row.record.kind, ...authorityRecordKey(row.record)])),
		),
	);
	for (const row of seed.rows) {
		if (represented.has(JSON.stringify([row.record.kind, ...authorityRecordKey(row.record)]))) continue;
		const skeleton = ownerFrame(seed.sourceIdentity, "recovering");
		debt = plusDebt(
			debt,
			sqliteCommitDebt(
				{
					...skeleton,
					changes: [row],
					controls: skeleton.controls.filter(change => change.key.startsWith("receipt:")),
				},
				undefined,
				false,
			),
		);
	}
	for (const control of seed.controls) {
		if (control.key.startsWith("receipt:")) continue;
		const skeleton = ownerFrame(seed.sourceIdentity, "recovering");
		debt = plusDebt(
			debt,
			sqliteCommitDebt(
				{
					...skeleton,
					changes: [],
					controls: [
						...skeleton.controls.filter(change => change.key.startsWith("receipt:")),
						{ ...control, deleted: false },
					],
				},
				undefined,
				false,
			),
		);
	}
	if (seed.legacy) {
		const pages = authoritySqliteOverflowPages(sqlRecordBytes([null, JSON.stringify(seed.legacy)]), true) + 2;
		debt = plusDebt(debt, {
			jsonlBytes: 0,
			sqliteDatabaseBytes: pages * SQLITE_PAGE_BYTES,
			sqliteWalBytes: pages * SQLITE_WAL_FRAME_BYTES,
			sqliteShmBytes: 0,
		});
	}
	// Bootstrap includes schema roots and optional legacy data, not only the
	// normalized-frame cohort. Keep its complete additive fallback intact.
	return {
		jsonlBytes: debt.jsonlBytes,
		sqliteDatabaseBytes: debt.sqliteDatabaseBytes,
		sqliteWalBytes: debt.sqliteWalBytes,
		sqliteShmBytes: debt.sqliteShmBytes,
	};
}

function ownerFrame(identity: AuthorityIdentity, phase: "recovering" | "ready" | "closed"): AuthorityCommitFrame {
	const revision = Number.MAX_SAFE_INTEGER;
	const requestId = "c".repeat(36);
	const ownerToken = "t".repeat(36);
	const owner = { incarnation: identity.incarnation, epoch: revision, token: ownerToken, phase };
	const receipt: AuthorityCommitFrame["receipt"] = {
		requestId,
		ownerEpoch: revision,
		revision,
		payloadHash: HASH,
		incarnation: identity.incarnation,
		commandKind: "owner",
		committedAt: revision,
		result: { kind: "mutation" },
	};
	const receiptKey = `receipt:${JSON.stringify([identity.incarnation, revision, requestId])}`;
	return {
		version: 2,
		kind: "commit",
		revision,
		request: { requestId, incarnation: identity.incarnation, ownerEpoch: revision, ownerToken },
		command: { kind: "owner", owner },
		payloadHash: HASH,
		expected: [],
		changes: [],
		controls: [
			{ key: "meta", deleted: false, value: { revision, generationHighWater: revision, status: "ready" } },
			{ key: "owner", deleted: false, value: owner },
			{ key: receiptKey, deleted: false, value: receipt },
		],
		receipt,
		previousHash: HASH,
		committedAt: revision,
		contentHash: HASH,
		hash: HASH,
	};
}

function rootRecoveryFrame(
	root: Extract<DurableRegistryRecord, { kind: "root" }>,
	identity: AuthorityIdentity,
): AuthorityCommitFrame {
	const base = ownerFrame(identity, "recovering");
	const revision = Number.MAX_SAFE_INTEGER;
	const gate = {
		kind: "gate" as const,
		at: revision,
		rootId: root.rootId,
		generation: root.generation,
		phase: "closed" as const,
	};
	const receipt: AuthorityCommitFrame["receipt"] = { ...base.receipt, commandKind: "transition" };
	return {
		...base,
		command: { kind: "transition", record: gate },
		receipt,
		expected: [{ domain: "gate", key: [root.rootId], version: revision }],
		changes: [{ record: gate, version: revision }],
		controls: [
			...base.controls
				.filter(control => control.key !== "owner")
				.map(control =>
					control.key.startsWith("receipt:") ? { ...control, deleted: false as const, value: receipt } : control,
				),
			{
				key: `root-recovery:${JSON.stringify([root.rootId])}`,
				deleted: false,
				value: {
					version: 1,
					incarnation: identity.incarnation,
					ownerEpoch: revision,
					ownerToken: base.request.ownerToken,
					rootId: root.rootId,
					generation: root.generation,
					rootHeadHash: root.headHash,
					rootVersion: revision,
					actorVersion: revision,
					constructionVersion: revision,
					gateVersion: revision,
				},
			},
		],
	};
}

function rootRecoveryActivationFrame(
	root: Extract<DurableRegistryRecord, { kind: "root" }>,
	identity: AuthorityIdentity,
): AuthorityCommitFrame {
	const revision = Number.MAX_SAFE_INTEGER;
	const requestId = "";
	const ownerToken = "o".repeat(36);
	const actor = {
		kind: "actor" as const,
		at: revision,
		actorId: root.rootId,
		rootId: root.rootId,
		generation: root.generation,
		rootGeneration: root.generation,
		rootHeadHash: root.headHash,
		startupHash: HASH,
		provenanceHash: HASH,
		state: "active" as const,
	};
	const construction = {
		kind: "construction" as const,
		at: revision,
		rootId: root.rootId,
		actorId: root.rootId,
		generation: root.generation,
		startupHash: HASH,
		provenanceHash: HASH,
		phase: "activated" as const,
	};
	const gate = {
		kind: "gate" as const,
		at: revision,
		rootId: root.rootId,
		generation: root.generation,
		phase: "open" as const,
	};
	const receipt = {
		requestId,
		ownerEpoch: revision,
		revision,
		payloadHash: HASH,
		incarnation: identity.incarnation,
		commandKind: "activate-authority" as const,
		committedAt: revision,
		result: { kind: "mutation" as const },
	};
	const changes = [actor, gate].map(record => ({ record, version: revision }));
	return {
		version: 2,
		kind: "commit",
		revision,
		request: { requestId, incarnation: identity.incarnation, ownerEpoch: revision, ownerToken },
		command: { kind: "activate-authority", activation: { actor, construction, gate } },
		payloadHash: HASH,
		expected: changes.map(row => ({
			domain: row.record.kind,
			key: authorityRecordKey(row.record),
			version: revision,
		})),
		changes,
		controls: [
			{ key: "meta", deleted: false, value: { revision, generationHighWater: revision, status: "ready" } },
			{
				key: `actor-generation:${JSON.stringify([actor.actorId, actor.generation])}`,
				deleted: false,
				value: { row: { record: actor, version: revision } },
			},
			{ key: `root-recovery:${JSON.stringify([root.rootId])}`, deleted: true },
			{
				key: `receipt:${JSON.stringify([identity.incarnation, revision, requestId])}`,
				deleted: false,
				value: receipt,
			},
		],
		receipt,
		previousHash: HASH,
		committedAt: revision,
		contentHash: HASH,
		hash: HASH,
	} as unknown as AuthorityCommitFrame;
}

function ownerPhasesAhead(phase: AuthorityOwner["phase"] | undefined): readonly ("recovering" | "ready" | "closed")[] {
	return phase === "closed"
		? []
		: phase === "ready" || phase === "quiescing"
			? ["closed"]
			: phase === "recovering"
				? ["ready", "closed"]
				: ["recovering", "ready", "closed"];
}

/**
 * Debt of the owner-phase frames still ahead of an owner in `phase`; without a phase, a new owner's whole
 * recovering, ready and closed episode, which every (re)opening owner reserves on top of its records' debt.
 * Owner frames are internal fixed-size commands, so no request envelope applies.
 */
export function authorityOwnerEpisodeDebt(
	identity: AuthorityIdentity,
	phase?: AuthorityOwner["phase"],
	treeHeight = SQLITE_MAX_CURSOR_DEPTH,
): AuthorityCapacityDebt {
	return ownerPhasesAhead(phase).reduce(
		(total, next) =>
			appendFutureDebt(
				total,
				futureFrameDebt(ownerFrame(identity, next), identity, { continuationBytes: 0, treeHeight }, false),
			),
		ZERO_DEBT,
	);
}

export interface AuthorityCapacityWorkerConfig {
	readonly identity: BorrowedCapacityIdentity;
	readonly maxRequestBytes: number;
}

/** No physical space or project quota for a NEW reservation; the previous promise was re-proved intact. */
export class AuthorityCapacityRefusedError extends Error {
	constructor(cause: unknown) {
		super("Authority capacity refused the reservation: no physical space or project quota is available", { cause });
		this.name = "AuthorityCapacityRefusedError";
	}
}

function exhaustedSpace(error: unknown): boolean {
	if (!(error instanceof AuthorityCapacityPoolError)) return false;
	const cause = error.cause;
	const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
	return code === "ERRNO_28" || code === "ERRNO_122";
}

/*
 * How a funding decision obtains target backing.
 * - "full": open every target and certify it with a complete FIEMAP readback.
 * - "suffix": the JSONL journal is append-only; re-prove only the block holding EOF and the arena past it
 *   (inspectAuthorityCapacityTargetSuffix), falling back to "full" when the cached certificate cannot vouch for the prefix.
 * - "group": a later member of an open SQLite group reuses the certificates the group's transaction already took (see
 *   #groupCertified), falling back to "full" if any target's EOF differs from its certificate.
 * - "append": JSONL settlement after the owner's own append reuses the certificate its prepare took (see #appendCertified).
 */
type BackingReadback = "full" | "suffix" | "group" | "append";

/*
 * The borrowed pool as one admission call sees it: the first inspection of a call re-verifies the descriptor, and later
 * ones in the same call reuse it until a mutation, whose own full readback then stands for the pool. Every public
 * admission entry starts by forgetting it (#startCall), so each call re-verifies at least once before any credit.
 */
class InspectedPool {
	readonly #pool: BorrowedAuthorityCapacityPool;
	#state: CapacityPoolState | undefined;

	constructor(pool: BorrowedAuthorityCapacityPool) {
		this.#pool = pool;
	}

	forget(): void {
		this.#state = undefined;
	}

	inspect(): CapacityPoolState {
		return (this.#state ??= this.#pool.inspect());
	}

	ensureDataBytes(bytes: number, maxStepBytes?: number): CapacityPoolState {
		this.#state = undefined;
		return (this.#state = this.#pool.ensureDataBytes(bytes, maxStepBytes));
	}

	releaseDataBytes(bytes: number): CapacityPoolRelease {
		this.#state = undefined;
		const release = this.#pool.releaseDataBytes(bytes);
		this.#state = release.after;
		return release;
	}

	reconcile(): CapacityPoolState {
		this.#state = undefined;
		return (this.#state = this.#pool.reconcile());
	}
}

/** Worker-owned accounting over the host-retained native pool descriptor. */
export class AuthorityCapacityAdmission {
	readonly #filename: string;
	readonly #identity: AuthorityIdentity;
	readonly #maxRequestBytes: number;
	readonly #continuationBytes: number;
	readonly #pool: InspectedPool;
	readonly #poolDescriptor: number;
	#ledger: AuthorityCapacityDebtLedger;
	#database: Database | undefined;
	#databaseChunkBuffer: Int32Array | undefined;
	#pending: AuthorityCommitFrame | undefined;
	#admissionFailure: unknown;
	#closePrepared = false;
	#systemPhase: AuthorityOwner["phase"] | undefined;
	#nativeCertificate: SqliteNativeCertificate = { retained: SQLITE_TRANSIENT_PAGES, reusable: SQLITE_TRANSIENT_PAGES };
	// Exact frame count of the live WAL since its last RESTART, read with the no-work NOOP checkpoint;
	// inside an open group, an upper bound that also counts every staged member's priced frames.
	#walFrames = 0;
	readonly #systemDebts = new Map<string, AuthorityCapacityDebt>();
	#pendingCohort: SqliteCohort | undefined;
	#walState: "reset" | "unreset" | "unknown" = "unreset";
	#walFailure: unknown;
	// Priced WAL bytes of the prepared frame, so a grouped member can advance #walFrames without a checkpoint.
	#pendingWalBytes = 0;
	// A group member touched capacity, so the group's COMMIT must be followed by the reconciliation
	// that committed()/aborted() would have run after each ungrouped transaction.
	#groupSettlementDue = false;
	#groupOpen = false;
	// Members prepared in the open group so far, excluding the pending tail (staged or rolled back).
	#groupMembers = 0;
	// Open-group WAL bound: the certified frames at the group's start plus min(sum of the members' priced
	// frames, the most pages any member could leave in the database). One transaction writes each dirty page
	// once (cache_spill=OFF), so its frames never exceed the pages that exist when it commits; both terms
	// are upper bounds, so their minimum is one too. Rolled-back members stay in both terms.
	#groupBaseFrames = 0;
	#groupPricedFrames = 0;
	#groupMaxPages = 0;
	// Pages the prepared frame could leave in the database: the current count plus its priced allocations.
	#pendingPagesBound = 0;
	readonly #targetHorizons = new Map<string, number>();
	// End of each target's observed allocation. It exceeds the private (credited) prefix when reflink-shared
	// extents sit below a funded KEEP_SIZE arena; later readbacks must scan that far, but never credit it.
	readonly #targetAllocationEnds = new Map<string, number>();
	readonly #targetCertificates = new Map<string, AuthorityCapacityTargetCertificate>();
	// Sticky: a staged copy-on-write window can outlive the shared extents that caused it.
	readonly #sharedTargets = new Set<string>();
	#targetCloseFailure: unknown;
	// Set when a target allocation step ran since the last prepare/committed began; fallocate moves the
	// target's timestamps, so a JSONL owner must not trust its timestamp fence across such a step.
	#targetsTouched = false;
	// Committed page count from the database header at the last pre-initialization backing readback.
	#headerPages: number | undefined;
	/*
	 * An open SQLite group's transaction has certified every target since it began. Until its COMMIT nothing writes the
	 * database or WAL: members only dirty cached pages (cache_spill=OFF keeps them in memory, statement journals are in
	 * memory, the exclusive lock excludes other connections), and the only allocations are this admission's own funding,
	 * which updates the certificates it changes. A group is ONE transaction, so certifying at its start gives its writes
	 * the same guarantee a single transaction's prepare gives: a later member's prepare reuses the certificates instead
	 * of re-reading them. Cleared whenever the group ends or any path other than a member prepare runs.
	 */
	#groupCertified = false;
	/*
	 * The JSONL target was certified by the prepare of the frame now being settled. Between that readback and settlement
	 * the only writer is the owner's own append (the ownership lock excludes cooperating writers), and an append inside
	 * the certified private arena converts already-allocated blocks without freeing or sharing any, so settlement reuses
	 * that certificate at the new EOF. A foreign change in that window is caught by the next prepare's readback, which
	 * runs before the next write. Cleared by every path other than prepare and settlement.
	 */
	#appendCertified = false;

	constructor(
		filename: string,
		identity: AuthorityIdentity,
		config: AuthorityCapacityWorkerConfig,
		database?: Database,
	) {
		if (identity.backend !== "sqlite" && identity.backend !== "jsonl")
			throw new TypeError("Authority capacity requires a supported persistence backend");
		if (!Number.isSafeInteger(config.maxRequestBytes) || config.maxRequestBytes < 1)
			throw new RangeError("Authority capacity request bound is invalid");
		this.#filename = path.resolve(filename);
		this.#identity = identity;
		this.#maxRequestBytes = config.maxRequestBytes;
		this.#continuationBytes = continuationPricingBytes(config.maxRequestBytes);
		this.#pool = new InspectedPool(BorrowedAuthorityCapacityPool.open(config.identity));
		this.#poolDescriptor = config.identity.fd;
		this.#ledger = new AuthorityCapacityDebtLedger(identity, config.maxRequestBytes);
		this.#database = database;
	}

	initialize(
		records: Iterable<DurableRegistryRecord>,
		database = this.#database,
		controls: Iterable<AuthorityControl> = [],
	): void {
		this.#startCall();
		this.#assertAvailable();
		if (this.#pending) throw new Error("Authority capacity cannot initialize during a prepared commit");
		this.#database = database;
		const initialControls = [...controls];
		const owner = initialControls.find(control => control.key === "owner")?.value;
		this.#systemPhase =
			owner &&
			typeof owner === "object" &&
			"phase" in owner &&
			(owner.phase === "recovering" || owner.phase === "ready" || owner.phase === "closed")
				? owner.phase
				: undefined;
		const initialRecords = [...records];
		this.#ledger = new AuthorityCapacityDebtLedger(
			this.#identity,
			this.#maxRequestBytes,
			initialRecords,
			database,
			initialControls,
		);
		if (this.#identity.backend === "sqlite" && database) {
			if (!liveCapacityConnections.has(database))
				throw new Error("SQLite capacity requires its configured exclusive live connection");
			assertSqliteCapacitySchema(database);
			const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
			if (pages === undefined || !Number.isSafeInteger(pages) || pages < 0)
				throw new Error("Invalid SQLite initialization checkpoint horizon");
			const current = targetHorizons(this.#filename, this.#identity);
			this.#fundAndRelease(
				{ ...ZERO_DEBT, sqliteDatabaseBytes: Math.max(0, pages * SQLITE_PAGE_BYTES - current.sqliteDatabaseBytes) },
				ZERO_DEBT,
			);
			// The bounded observer reads the database file itself, so it needs a complete checkpoint first.
			this.#reconcileWal(true);
			this.#nativeCertificate = { ...observeSqliteCertificate(database), pages };
			// The smallest provable B-tree height: priced at height h, the obligations may grow the database to
			// P(h) pages, and h is valid once every tree of P(h) pages has at most h levels. P grows with h.
			for (let height = authoritySqliteTreeHeightBound(pages); height < SQLITE_MAX_CURSOR_DEPTH; height++) {
				const ledger = new AuthorityCapacityDebtLedger(
					this.#identity,
					this.#maxRequestBytes,
					initialRecords,
					database,
					initialControls,
					height,
				);
				const future = appendFutureDebt(ledger.currentDebt(), this.#systemDebt(this.#systemPhase, height));
				if (
					authoritySqliteTreeHeightBound(
						safeAdd(pages, Math.ceil(future.sqliteDatabaseBytes / SQLITE_PAGE_BYTES)),
					) <= height
				) {
					this.#ledger = ledger;
					break;
				}
			}
		}
		this.#ensureReserve(this.#ledger.currentDebt(), ZERO_DEBT);
	}

	fundBootstrap(write: AuthorityCapacityDebt, database = this.#database): void {
		this.#startCall();
		this.#assertAvailable();
		this.#database = database;
		this.#fundAndRelease(write, this.#ledger.currentDebt());
	}

	/** Returns whether funding allocated into a target file (see #targetsTouched). */
	prepare(frame: AuthorityCommitFrame, database = this.#database, jsonlBytes?: number): boolean {
		// A failed refill closes only NEW admission. Consuming an already funded
		// phase/disposition or internal close must retain its exact capability.
		// In an open group the previous member's staged frame stays pending until the next member arrives,
		// so a group's last member settles through committed() exactly as an ungrouped frame does.
		if (this.#groupOpen && this.#pending) this.#groupStage(this.#pending);
		if (this.#pending) throw new Error("Authority capacity already has a prepared commit");
		this.#targetsTouched = false;
		const groupCertified = this.#groupCertified;
		this.#startCall();
		this.#database = database;
		// The caller must retain this prospective frame before prepare: refusing
		// an unreset WAL leaves #pending unset, but still requires aborted() after
		// actual ROLLBACK. Reset cannot run inside the caller's active transaction.
		if (this.#identity.backend === "sqlite" && this.#walState !== "reset")
			throw new Error(
				"SQLite authority WAL reset requires outside-transaction reconciliation; funded capability is retained",
				{ cause: this.#walFailure },
			);
		if (this.#admissionFailure !== undefined && !this.#consumesPromise(frame)) this.#assertAvailable();
		let projected = this.#ledger.project(frame);
		const current = targetHorizons(this.#filename, this.#identity);
		let write: AuthorityCapacityDebt =
			this.#identity.backend === "jsonl"
				? {
						jsonlBytes: jsonlBytes ?? jsonBytes(frame) + 1,
						sqliteDatabaseBytes: 0,
						sqliteWalBytes: 0,
						sqliteShmBytes: 0,
					}
				: sqliteCommitDebt(frame, this.#database, current.sqliteShmBytes === 0);
		if (this.#identity.backend === "sqlite") {
			const pages = this.#database?.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
			if (!Number.isSafeInteger(pages) || pages < 0) throw new Error("Invalid SQLite checkpoint horizon");
			const walFrames = Math.ceil((current.sqliteWalBytes + write.sqliteWalBytes) / SQLITE_WAL_FRAME_BYTES);
			this.#pendingPagesBound = safeAdd(
				pages,
				write.sqliteCohort?.allocated ?? Math.ceil(write.sqliteDatabaseBytes / SQLITE_PAGE_BYTES),
			);
			write = {
				...write,
				sqliteDatabaseBytes: safeAdd(
					write.sqliteDatabaseBytes,
					Math.max(0, pages * SQLITE_PAGE_BYTES - current.sqliteDatabaseBytes),
				),
				sqliteShmBytes: Math.max(
					0,
					32_768 * Math.max(1, Math.ceil((walFrames + 34) / 4_096)) - current.sqliteShmBytes,
				),
			};
			// Committed, this frame's allocations precede every remaining obligation; rolled back, the old ones remain.
			const phase = frame.command.kind === "owner" ? frame.command.owner.phase : this.#systemPhase;
			while (
				this.#raiseTreeHeight(
					Math.max(
						safeAdd(
							write.sqliteCohort?.allocated ?? 0,
							Math.ceil(
								appendFutureDebt(projected, this.#systemDebt(phase)).sqliteDatabaseBytes / SQLITE_PAGE_BYTES,
							),
						),
						Math.ceil(
							appendFutureDebt(this.#ledger.currentDebt(), this.#systemDebt()).sqliteDatabaseBytes /
								SQLITE_PAGE_BYTES,
						),
					),
				)
			)
				projected = this.#ledger.project(frame);
			// A later group member joins only if the WAL coverage already certified holds the whole group
			// so far plus this member, with the release-step margin #reconcileWal uses: it never makes a
			// WAL transfer that a serial run (which re-certifies with NOOP/RESTART after every COMMIT)
			// would not. Thrown before any funding; the driver turns it into a group boundary.
			if (this.#groupMembers > 0) {
				const phase = frame.command.kind === "owner" ? frame.command.owner.phase : this.#systemPhase;
				const need = this.#horizonNeed(
					write,
					appendFutureDebt(projected, this.#systemDebt(phase)),
					this.#nativeCertificate,
					this.#walFrames,
				).walBytes;
				const coverage = this.#targetCertificates.get(`${this.#filename}-wal`)?.coveredBytes ?? 0;
				if (safeAdd(need, TRANSFER_RELEASE_BYTES) > coverage)
					throw new Error(
						"SQLite authority WAL coverage has no certified room for another grouped member; nothing was funded",
					);
			}
		}
		const readback: BackingReadback =
			this.#identity.backend === "jsonl" ? "suffix" : this.#groupOpen && groupCertified ? "group" : "full";
		this.#fundAndRelease(
			write,
			projected,
			frame.command.kind === "owner" ? frame.command.owner.phase : this.#systemPhase,
			!this.#consumesPromise(frame),
			current,
			readback,
		);
		if (this.#identity.backend === "sqlite" && this.#groupOpen) this.#groupCertified = true;
		if (this.#identity.backend === "jsonl") this.#appendCertified = true;
		this.#pending = frame;
		this.#pendingCohort = write.sqliteCohort;
		this.#pendingWalBytes = write.sqliteWalBytes;
		if (this.#identity.backend === "sqlite") this.#walState = "unreset";
		return this.#targetsTouched;
	}

	prepareClose(): void {
		this.#startCall();
		this.#closePendingTargetDescriptors();
		if (this.#closePrepared) return;
		if (this.#pending) throw new Error("Authority capacity cannot close during a prepared commit");
		if (this.#identity.backend !== "sqlite") return;
		const current = targetHorizons(this.#filename, this.#identity);
		if (current.sqliteWalBytes === 0) return;
		const pages = this.#database?.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
		if (pages === undefined || !Number.isSafeInteger(pages) || pages < 0)
			throw new Error("Invalid SQLite close checkpoint horizon");
		this.#fundAndRelease(
			{
				jsonlBytes: 0,
				sqliteDatabaseBytes: Math.max(0, pages * SQLITE_PAGE_BYTES - current.sqliteDatabaseBytes),
				sqliteWalBytes: 0,
				sqliteShmBytes: 0,
			},
			this.#ledger.currentDebt(),
		);
		this.#closePrepared = true;
	}

	closeFailed(error: unknown): void {
		this.#admissionFailure = error;
	}

	/** Returns whether settlement allocated into a target file (see #targetsTouched). */
	committed(frame: AuthorityCommitFrame, database = this.#database): boolean {
		if (this.#pending !== frame) throw new Error("Authority capacity commit does not match its prepared frame");
		this.#targetsTouched = false;
		const appendCertified = this.#appendCertified;
		this.#startCall();
		this.#database = database;
		this.#ledger.apply(frame);
		if (frame.command.kind === "owner") this.#systemPhase = frame.command.owner.phase;
		if (this.#pendingCohort)
			this.#nativeCertificate = {
				retained: safeAdd(this.#nativeCertificate.retained, this.#pendingCohort.retained),
				reusable: safeAdd(this.#nativeCertificate.reusable, this.#pendingCohort.reusable),
				...(this.#nativeCertificate.pages === undefined ? {} : { pages: this.#databasePages() }),
			};
		this.#pendingCohort = undefined;
		this.#pending = undefined;
		try {
			if (this.#identity.backend === "sqlite") this.#reconcileWal(false);
			this.#ensureReserve(this.#ledger.currentDebt(), ZERO_DEBT, appendCertified ? "append" : "full");
		} catch (error) {
			// COMMIT is known; a checkpoint/refill failure retains its cause and only closes NEW admission.
			this.#admissionFailure = error;
		}
		return this.#targetsTouched;
	}

	/*
	 * Group commit (sqlite-driver AuthorityGroupCommit). A grouped member is prepared exactly like an ungrouped
	 * frame, but its transaction stays open, so neither the post-commit WAL checkpoint (NOOP/RESTART, which
	 * needs the connection outside any transaction) nor the reserve refill can run between members.
	 *
	 * The staged frame of each member stays pending. When another member is prepared, #groupStage() settles
	 * the previous one as committed() would (ledger, certificate) and replaces the checkpoint's exact frame
	 * count with an upper bound (see #groupBaseFrames). #fundAndRelease prices the next member from that bound,
	 * and prepare admits a later member only if the WAL coverage already certified holds it, so a group never
	 * outgrows its funded arena. groupCommitted() then settles the group's last member through committed()
	 * itself, which runs the deferred reconciliation and refill once, exactly as after an ungrouped COMMIT;
	 * a lone command is therefore settled exactly as before group commit. groupFailed() is aborted()'s
	 * unknown path. A later member that prepare refuses becomes a group boundary in the driver, and its
	 * retry as a first member sees exactly the serial state.
	 */
	beginGroup(): void {
		if (this.#pending || this.#groupOpen)
			throw new Error("Authority capacity cannot open a group during a prepared commit or another group");
		this.#startCall();
		this.#groupOpen = true;
		this.#groupMembers = 0;
		this.#groupSettlementDue = false;
	}

	/**
	 * Called by the SQLite driver before BEGIN IMMEDIATE, outside any transaction. A reset that failed after an
	 * earlier COMMIT left the WAL unreset, and prepare() cannot reset it from inside the caller's transaction, so it
	 * is retried here; otherwise the next command (often a funded continuation) would be refused once just to reach
	 * the reconciliation that aborted() runs after its rollback. A failure is retained in #walFailure, and prepare()
	 * then refuses with it as the cause exactly as before. Unknown-outcome state ("unknown") is left alone.
	 */
	reconcileBeforeTransaction(database = this.#database): void {
		if (this.#identity.backend !== "sqlite" || this.#walState !== "unreset" || this.#pending || this.#groupOpen)
			return;
		this.#startCall();
		this.#database = database;
		try {
			this.#reconcileWal(this.#walFailure !== undefined);
		} catch {
			// Retained in #walFailure by #reconcileWal; prepare() surfaces it as the refusal's cause.
		}
	}

	#groupStage(frame: AuthorityCommitFrame): void {
		this.#ledger.apply(frame);
		if (frame.command.kind === "owner") this.#systemPhase = frame.command.owner.phase;
		if (this.#pendingCohort)
			this.#nativeCertificate = {
				retained: safeAdd(this.#nativeCertificate.retained, this.#pendingCohort.retained),
				reusable: safeAdd(this.#nativeCertificate.reusable, this.#pendingCohort.reusable),
				...(this.#nativeCertificate.pages === undefined ? {} : { pages: this.#databasePages() }),
			};
		this.#settleGroupedFrames();
	}

	/** A member rolled back to its savepoint with a known outcome; the rest of its group stays staged. */
	groupMemberAborted(frame: AuthorityCommitFrame): void {
		this.#startCall();
		if (this.#pending !== frame) {
			// Same boundary as aborted(): a refused prepare over an unreset WAL still needs reconciliation.
			if (this.#identity.backend === "sqlite" && this.#walState === "unreset") this.#groupSettlementDue = true;
			return;
		}
		// Its savepoint rollback restores page contents but can leave those pages dirty, so the group
		// COMMIT may still write them: keep its priced frames in the bound.
		this.#settleGroupedFrames();
	}

	groupCommitted(database = this.#database): void {
		this.#database = database;
		this.#groupOpen = false;
		this.#groupMembers = 0;
		this.#groupCertified = false;
		const tail = this.#pending;
		if (tail) {
			this.#groupSettlementDue = false;
			this.committed(tail, database);
			return;
		}
		this.#startCall();
		if (!this.#groupSettlementDue) return;
		this.#groupSettlementDue = false;
		try {
			if (this.#identity.backend === "sqlite") this.#reconcileWal(this.#walFailure !== undefined);
			this.#ensureReserve(this.#ledger.currentDebt(), ZERO_DEBT);
		} catch (error) {
			// The group COMMIT is known; as in committed(), a reconciliation failure only closes NEW admission.
			this.#admissionFailure = error;
		}
	}

	groupFailed(): void {
		this.#startCall();
		this.#groupOpen = false;
		this.#pending = undefined;
		this.#pendingCohort = undefined;
		this.#groupSettlementDue = false;
		this.#groupMembers = 0;
		this.#walState = "unknown";
		this.#admissionFailure = new Error(
			"Authority capacity reservation requires reconciliation after an unknown group commit outcome",
		);
	}

	#settleGroupedFrames(): void {
		if (this.#identity.backend === "sqlite") {
			if (this.#groupMembers === 0) {
				this.#groupBaseFrames = this.#walFrames;
				this.#groupPricedFrames = 0;
				this.#groupMaxPages = 0;
			}
			this.#groupPricedFrames = safeAdd(
				this.#groupPricedFrames,
				Math.ceil(this.#pendingWalBytes / SQLITE_WAL_FRAME_BYTES),
			);
			this.#groupMaxPages = Math.max(this.#groupMaxPages, this.#pendingPagesBound);
			this.#walFrames = safeAdd(this.#groupBaseFrames, Math.min(this.#groupPricedFrames, this.#groupMaxPages));
			this.#walState = "reset";
		}
		this.#pendingCohort = undefined;
		this.#pending = undefined;
		this.#pendingWalBytes = 0;
		this.#groupSettlementDue = true;
		this.#groupMembers++;
	}

	/*
	 * Funds a JSONL segment rotation ahead of `frame`. A rotation writes new files (the sealed segment's index,
	 * the next snapshot and the next segment's header) and replaces the target with a fresh inode that has no
	 * certified backing, so the pool must hold both the files' complete XFS envelopes and the standing reserve
	 * the fresh target needs for every outstanding obligation plus this frame's append. Returns false, funding
	 * nothing, when `frame` consumes a funded promise: rotation is optional, so it rides only on NEW admission and
	 * a promised command never depends on fresh capacity. Refusal happens here, before any rotation write.
	 */
	prepareRotation(
		frame: AuthorityCommitFrame,
		fileBytes: readonly number[],
		headerBytes: number,
		appendBytes: number,
	): boolean {
		if (this.#identity.backend !== "jsonl") throw new Error("Only a JSONL authority target rotates");
		this.#startCall();
		if (this.#pending) throw new Error("Authority capacity cannot rotate during a prepared commit");
		if (this.#consumesPromise(frame)) return false;
		this.#assertAvailable();
		const phase = frame.command.kind === "owner" ? frame.command.owner.phase : this.#systemPhase;
		const obligation = appendFutureDebt(this.#ledger.project(frame), this.#systemDebt(phase));
		const fresh: AuthorityCapacityDebt = { ...ZERO_DEBT, jsonlBytes: headerBytes };
		const increment = this.#capacityIncrement(fresh, { ...ZERO_DEBT, jsonlBytes: appendBytes }, obligation);
		const standing = this.#requiredData(
			fresh,
			increment,
			ZERO_DEBT,
			safeAdd(obligation.sqliteCohort?.commands ?? 0, 1),
		);
		let files = 0;
		for (const bytes of fileBytes)
			files = safeAdd(files, xfsTargetEnvelope({ databaseBytes: bytes, walBytes: 0, shmBytes: 0 }).totalBytes);
		const current = targetHorizons(this.#filename, this.#identity);
		this.#ensurePoolData(
			safeAdd(standing, files),
			this.#sanityBound(current, [{ ...ZERO_DEBT, jsonlBytes: files }, increment]),
		);
		return true;
	}

	/** Funds one rotation file the owner just created: its certified KEEP_SIZE allocation first, then the matching pool release. */
	fundRotationFile(descriptor: number, bytes: number): void {
		if (this.#identity.backend !== "jsonl") throw new Error("Only a JSONL authority target rotates");
		this.#startCall();
		try {
			const domain = this.#pool.inspect();
			const envelope = xfsTargetEnvelope({ databaseBytes: bytes, walBytes: 0, shmBytes: 0 });
			const release = (amount: number): void => {
				if (amount === 0) return;
				if (this.#pool.releaseDataBytes(amount).releasedDataBytes !== amount)
					throw new Error("Authority capacity rotation released a different amount than requested");
			};
			// The file's blocks and their XFS metadata come from free space first; the pool then gives up what they cost.
			const owed = (allocated: number): number =>
				roundUp(safeAdd((envelope.metadataBlocks + envelope.workspaceBlocks) * 4_096, allocated), domain.blockSize);
			let allocated = 0;
			let released = 0;
			fundAuthorityCapacityTarget(descriptor, domain, bytes, undefined, {
				allocated: step => {
					allocated += step;
				},
				makeRoom: step => {
					const amount = owed(allocated + step) - released;
					if (amount <= 0) return false;
					release(amount);
					released += amount;
					return true;
				},
			});
			release(Math.max(0, owed(allocated) - released));
		} catch (error) {
			this.#admissionFailure = error;
			throw error;
		}
	}

	/**
	 * The JSONL target name now holds the next segment's fresh inode: forget the retired inode's certificate so
	 * the next readback certifies the new one, and return the retired inode's unused arena past its EOF.
	 */
	rotated(retired: string): void {
		this.#startCall();
		const allocationEnd = this.#targetAllocationEnds.get(this.#filename) ?? 0;
		this.#targetCertificates.delete(this.#filename);
		this.#targetHorizons.delete(this.#filename);
		this.#targetAllocationEnds.delete(this.#filename);
		// The rotation is committed; like every post-commit hook, a failure here only closes NEW admission (the
		// retired arena stays allocated, which costs space and no promise) until same-owner reconciliation.
		try {
			const descriptor = fs.openSync(retired, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
			this.#withTargetDescriptor(descriptor, () => releaseAuthorityTargetArena(descriptor, allocationEnd));
		} catch (error) {
			this.#admissionFailure = error;
		}
	}

	/**
	 * A group member's undo cut the JSONL target back with ftruncate, which also freed its funded KEEP_SIZE arena past
	 * the cut, backing the reserve still counts. Re-allocates that arena from the space the cut just freed (never from
	 * the pool, so no other obligation pays for it) and returns whether the target's allocation may have changed (the
	 * caller then re-proves the journal's bytes). If the space is gone, the lost backing is forgotten and NEW admission
	 * closes until reconciliation re-funds the reserve from the pool.
	 */
	jsonlTargetTruncated(descriptor: number): boolean {
		if (this.#identity.backend !== "jsonl") throw new Error("Only a JSONL authority target is cut back by an undo");
		this.#startCall();
		const allocationEnd = this.#targetAllocationEnds.get(this.#filename) ?? 0;
		const before = fs.fstatSync(descriptor, { bigint: true });
		if (allocationEnd <= Number(before.size)) return false;
		try {
			const domain = this.#pool.inspect();
			const certificate = fundAuthorityCapacityTarget(descriptor, domain, allocationEnd);
			this.#targetCertificates.set(this.#filename, certificate);
			this.#targetHorizons.set(this.#filename, certificate.coveredBytes);
			this.#targetAllocationEnds.set(this.#filename, Math.max(allocationEnd, certificate.allocatedBytes));
			return fs.fstatSync(descriptor, { bigint: true }).blocks !== before.blocks;
		} catch (error) {
			this.#targetCertificates.delete(this.#filename);
			this.#targetHorizons.delete(this.#filename);
			this.#targetAllocationEnds.delete(this.#filename);
			this.#admissionFailure = error;
			return true;
		}
	}

	#databasePages(): number {
		const pages = this.#database?.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
		if (pages === undefined || !Number.isSafeInteger(pages) || pages < 0)
			throw new Error("Invalid SQLite page-count horizon");
		return pages;
	}

	/*
	 * Certifies that the live WAL can take the next funded transaction, resetting it only when it must.
	 *
	 * Every admission is funded for walFrames + F frames, where F bounds any single later transaction
	 * (#walTransactionFrames). Reuse needs a RESTART only when the WAL's certified coverage lacks room
	 * for one more such transaction (plus one release step) after the frames it already holds;
	 * otherwise later transactions append. NOOP reads the exact frame count without a checkpoint or fsync, while each RESTART costs
	 * two fsyncs plus a header fsync on the next commit, so resets are amortized over the funded slack.
	 * Any failure, the observer's need for a complete checkpoint, and a missing frame count force RESTART.
	 * A NOOP or RESTART refusal (for example SQLITE_LOCKED under a held reader) keeps the WAL unreset and
	 * closes admission until outside-transaction reconciliation, exactly as a failed RESTART did.
	 */
	#reconcileWal(force: boolean): void {
		this.#walState = "unreset";
		try {
			if (!this.#database || !liveCapacityConnections.has(this.#database))
				throw new Error("SQLite WAL reuse requires the configured exclusive live connection");
			if (!force && this.#walFailure === undefined) {
				const frames = this.#database
					.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(NOOP)")
					.get();
				if (
					!frames ||
					frames.busy !== 0 ||
					!Number.isSafeInteger(frames.log) ||
					frames.log < 0 ||
					!Number.isSafeInteger(frames.checkpointed) ||
					frames.checkpointed < 0 ||
					frames.checkpointed > frames.log
				)
					throw new Error("SQLite authority could not read its live WAL frame count");
				const coverage = this.#targetCertificates.get(`${this.#filename}-wal`)?.coveredBytes ?? 0;
				const next = this.#walTransactionFrames(
					ZERO_DEBT,
					appendFutureDebt(this.#ledger.currentDebt(), this.#systemDebt()),
					this.#nativeCertificate,
				);
				// Keep one release step of room beyond the estimate, as the RESTART path does through its
				// attempt collateral: an actual funded command may exceed its reserved future-frame estimate.
				if (
					safeAdd(safeAdd(32, safeAdd(frames.log, next) * SQLITE_WAL_FRAME_BYTES), TRANSFER_RELEASE_BYTES) <=
					coverage
				) {
					this.#walFrames = frames.log;
					this.#walState = "reset";
					return;
				}
			}
			const result = this.#database
				.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(RESTART)")
				.get();
			if (
				!result ||
				result.busy !== 0 ||
				!Number.isSafeInteger(result.log) ||
				result.log < 0 ||
				result.checkpointed !== result.log
			)
				throw new Error(
					"SQLite authority committed WAL could not be fully checkpointed and reset for bounded reuse",
				);
			this.#walFrames = 0;
			this.#walState = "reset";
			this.#walFailure = undefined;
		} catch (error) {
			this.#walFailure =
				this.#walFailure === undefined || this.#walFailure === error
					? error
					: new AggregateError(
							[this.#walFailure, error],
							"SQLite reset and subsequent outside-transaction reconciliation failed",
							{ cause: this.#walFailure },
						);
			throw this.#walFailure;
		}
	}

	aborted(frame: AuthorityCommitFrame, unknownOutcome: boolean, database = this.#database): void {
		// Known rollback of a refused prospective frame is also a reconciliation
		// boundary. Its original promise survives without projecting/applying the
		// refused command; only an explicit caller retry may consume that promise.
		this.#startCall();
		if (this.#pending !== frame && !(this.#identity.backend === "sqlite" && this.#walState === "unreset")) return;
		this.#database = database;
		this.#pending = undefined;
		this.#pendingCohort = undefined;
		if (unknownOutcome) {
			this.#walState = "unknown";
			this.#admissionFailure = new Error(
				"Authority capacity reservation requires reconciliation after an unknown commit outcome",
			);
			return;
		}
		try {
			if (this.#identity.backend === "sqlite") this.#reconcileWal(this.#walFailure !== undefined);
			this.#ensureReserve(this.#ledger.currentDebt(), ZERO_DEBT);
		} catch (error) {
			this.#admissionFailure =
				this.#admissionFailure === undefined || this.#admissionFailure === error
					? error
					: new AggregateError(
							[this.#admissionFailure, error],
							"Authority funded capability reset/refill reconciliation failed",
							{ cause: this.#admissionFailure },
						);
			throw this.#admissionFailure;
		}
	}

	#withTargetDescriptor<T>(descriptor: number, operation: () => T): T {
		let result!: T;
		let primary: unknown;
		let failed = false;
		try {
			result = operation();
		} catch (error) {
			primary = error;
			failed = true;
		}
		let cleanup: unknown;
		let closeFailed = false;
		try {
			fs.closeSync(descriptor);
		} catch (error) {
			cleanup = error;
			closeFailed = true;
			this.#targetCloseFailure = cleanup;
		}
		if (closeFailed) {
			const failure = new AggregateError(
				failed ? [primary, cleanup] : [cleanup],
				"Authority target descriptor close failed",
				{ cause: failed ? primary : cleanup },
			);
			this.#admissionFailure = failure;
			throw failure;
		}
		if (failed) throw primary;
		return result;
	}

	#closePendingTargetDescriptors(): void {
		if (this.#targetCloseFailure === undefined) return;
		// Linux releases an fd before reporting close errors. Never retry its integer:
		// another thread may already have reused it for a different, even identical, inode.
		this.#targetCloseFailure = undefined;
	}
	#assertAvailable(): void {
		if (this.#admissionFailure === undefined) return;
		const primary = this.#admissionFailure;
		try {
			this.#closePendingTargetDescriptors();
			this.#pool.reconcile();
			this.#ensureReserve(this.#ledger.currentDebt(), ZERO_DEBT);
			this.#admissionFailure = undefined;
		} catch (error) {
			this.#admissionFailure = new AggregateError(
				[primary, error],
				"Authority NEW admission remains closed after same-owner reserve reconciliation",
				{ cause: primary },
			);
			throw this.#admissionFailure;
		}
	}

	#consumesPromise(frame: AuthorityCommitFrame): boolean {
		if (frame.command.kind === "owner") {
			const phase = frame.command.owner.phase;
			return phase !== "quiescing" && this.#systemPhases().includes(phase);
		}
		if (frame.command.kind === "reconcile-local" || frame.command.kind === "finalize-local") return true;
		if (frame.command.kind === "activate-authority") return this.#ledger.hasActivationPromise(frame);
		if (frame.command.kind === "commit-root-transition") {
			const transition = frame.changes.find(({ record }) => record.kind === "transition")?.record;
			return transition?.kind === "transition" && this.#ledger.hasTransitionPromise(transition);
		}
		if (frame.command.kind === "authorize-local-effect" || frame.command.kind === "reserve-local") return false;
		if (frame.changes.length === 0) return false;
		return frame.changes.every(({ record }) => {
			if (!this.#ledger.hasStepPromise(record)) return false;
			if (record.kind === "operation" || record.kind === "resource" || record.kind === "local-entry")
				return !["intent", "effect"].includes(record.phase);
			if (record.kind === "transition") return record.phase !== "staged";
			if (record.kind === "construction")
				return record.phase === "constructing" || record.phase === "constructed" || record.phase === "abandoned";
			if (record.kind === "root" || record.kind === "actor")
				return record.state === "retired" || record.state === "invalidated" || record.state === "aborted";
			return record.kind === "gate" && this.#ledger.hasGatePromise(record);
		});
	}

	#systemPhases(phase = this.#systemPhase): readonly ("recovering" | "ready" | "closed")[] {
		return ownerPhasesAhead(phase);
	}

	#systemDebt(phase = this.#systemPhase, treeHeight = this.#ledger.treeHeight): AuthorityCapacityDebt {
		// Pure in (identity, phase, height); prepare/commit evaluate it several times per command.
		const key = `${phase ?? "none"}:${treeHeight}`;
		let debt = this.#systemDebts.get(key);
		if (!debt) this.#systemDebts.set(key, (debt = authorityOwnerEpisodeDebt(this.#identity, phase, treeHeight)));
		return debt;
	}

	/*
	 * Raises the obligations' B-tree height bound when the database could now reach a page count the old
	 * bound does not cover: the certified page count plus `futurePages` that can be allocated before any
	 * remaining priced command runs. A raise re-prices every obligation, so it is funded (or refused) by the
	 * admission that causes it, before any later command runs. Returns whether it raised.
	 */
	#raiseTreeHeight(futurePages: number): boolean {
		const pages = this.#nativeCertificate.pages;
		if (this.#identity.backend !== "sqlite" || pages === undefined) return false;
		const height = authoritySqliteTreeHeightBound(safeAdd(pages, futurePages));
		if (height <= this.#ledger.treeHeight) return false;
		this.#ledger.raiseTreeHeight(height);
		return true;
	}

	#ensureReserve(debt: AuthorityCapacityDebt, write: AuthorityCapacityDebt, readback: BackingReadback = "full"): void {
		while (
			this.#raiseTreeHeight(
				Math.ceil(
					appendFutureDebt(this.#ledger.currentDebt(), this.#systemDebt()).sqliteDatabaseBytes / SQLITE_PAGE_BYTES,
				),
			)
		)
			debt = this.#ledger.currentDebt();
		// The JSONL settlement after its own append reads the journal once, for both its EOF and its inode.
		const appended =
			readback === "append" ? fs.statSync(this.#filename, { bigint: true, throwIfNoEntry: false }) : undefined;
		const current = appended
			? { ...ZERO_DEBT, jsonlBytes: Number(appended.size) }
			: targetHorizons(this.#filename, this.#identity);
		const obligation = appendFutureDebt(debt, this.#systemDebt());
		const increment = this.#capacityIncrement(current, write, obligation);
		this.#ensurePoolData(
			this.#standingData(
				current,
				increment,
				this.#backingHorizons(addHorizons(current, increment), current, appended ? readback : "full", appended),
				obligation.sqliteCohort?.commands ?? 0,
				true,
			),
			this.#sanityBound(current, [write, obligation]),
		);
	}

	/*
	 * Hard ceiling on any single reserve: 4x every target's current bytes plus every additive debt in
	 * play, plus 128 KiB per command and 64 MiB. It is independent of the potential/additive minimum and
	 * the arena policy: the database horizon is at most current + additive allocations, one WAL
	 * transaction at most the pages that can then exist, the close refund at most that again, and XFS
	 * metadata, collateral and arena slack are a few percent plus per-command and fixed constants.
	 * Exceeding it means the accounting itself is wrong, so admission refuses instead of allocating.
	 */
	#sanityBound(current: AuthorityCapacityDebt, debts: readonly AuthorityCapacityDebt[]): number {
		const bytes = (debt: AuthorityCapacityDebt): number =>
			this.#identity.backend === "jsonl"
				? debt.jsonlBytes
				: safeAdd(debt.sqliteDatabaseBytes, safeAdd(debt.sqliteWalBytes, debt.sqliteShmBytes));
		let base = bytes(current);
		let commands = 1;
		for (const debt of debts) {
			base = safeAdd(base, bytes(debt));
			commands = safeAdd(commands, debt.sqliteCohort?.commands ?? 0);
		}
		return safeAdd(4 * base, safeAdd(commands * 131_072, 64 * 1_048_576));
	}

	#fundAndRelease(
		write: AuthorityCapacityDebt,
		projected: AuthorityCapacityDebt,
		systemPhase = this.#systemPhase,
		newAdmission = false,
		current = targetHorizons(this.#filename, this.#identity),
		readback: BackingReadback = "full",
	): void {
		const obligation = appendFutureDebt(projected, this.#systemDebt(systemPhase));
		// The prospective transaction appends after the frames the WAL already holds.
		const walFrames = this.#live() ? this.#walFrames : 0;
		let increment = this.#capacityIncrement(current, write, obligation, undefined, walFrames);
		let currentWrite = this.#capacityIncrement(current, write, ZERO_DEBT, undefined, walFrames);
		const backing = this.#backingHorizons(addHorizons(current, increment), current, readback);
		// Pages the database can never drop below (see the truncation credit in plan): the live page count once
		// initialized, else the committed page count its header recorded at this readback.
		const committedPages = this.#nativeCertificate.pages ?? this.#headerPages;
		let target = addHorizons(current, currentWrite);
		if (this.#identity.backend === "sqlite") {
			const databaseEnd = sqliteDatabaseArenaEnd(Math.max(target.sqliteDatabaseBytes, backing.sqliteDatabaseBytes));
			const databaseIncrement = Math.max(
				currentWrite.sqliteDatabaseBytes,
				databaseEnd - current.sqliteDatabaseBytes,
			);
			if (databaseIncrement > currentWrite.sqliteDatabaseBytes) {
				currentWrite = { ...currentWrite, sqliteDatabaseBytes: databaseIncrement };
				increment = {
					...increment,
					sqliteDatabaseBytes: Math.max(increment.sqliteDatabaseBytes, databaseIncrement),
				};
				target = { ...target, sqliteDatabaseBytes: databaseEnd };
			}
		}
		const requiredData = this.#requiredData(
			current,
			increment,
			backing,
			safeAdd(obligation.sqliteCohort?.commands ?? 0, 1),
		);
		const poolState = this.#pool.inspect();
		const rollbackObligation = appendFutureDebt(this.#ledger.currentDebt(), this.#systemDebt());
		const guard = this.#sanityBound(current, [write, obligation, rollbackObligation]);
		const committedCohort = write.sqliteCohort ?? EMPTY_COHORT;
		const committedCertificate: SqliteNativeCertificate = {
			retained: safeAdd(this.#nativeCertificate.retained, committedCohort.retained),
			reusable: safeAdd(this.#nativeCertificate.reusable, committedCohort.reusable),
			...(this.#nativeCertificate.pages === undefined
				? {}
				: { pages: safeAdd(this.#nativeCertificate.pages, committedCohort.allocated) }),
		};
		// Raw data requirements: #ensurePoolData adds the pool's own metadata exactly once. (Adding it here
		// too charged it twice, so a funded continuation needed more than its predecessor's reserve.)
		const standing = (
			horizon: AuthorityCapacityDebt,
			settledBacking: AuthorityCapacityDebt,
			future: AuthorityCapacityDebt,
			certificate: SqliteNativeCertificate,
			attempt: boolean,
		): number =>
			this.#standingData(
				horizon,
				this.#capacityIncrement(horizon, ZERO_DEBT, future, certificate),
				settledBacking,
				future.sqliteCohort?.commands ?? 0,
				attempt,
			);
		// A failed conversion strands at most its overhead plus one release step;
		// the old obligations' attempt collateral pays for exactly that.
		const pre =
			this.#identity.backend === "sqlite"
				? standing(current, backing, rollbackObligation, this.#nativeCertificate, true)
				: 0;
		const plan = (funded: AuthorityCapacityDebt) => {
			const write = {
				...ZERO_DEBT,
				jsonlBytes: Math.max(0, funded.jsonlBytes - current.jsonlBytes),
				sqliteDatabaseBytes: Math.max(0, funded.sqliteDatabaseBytes - current.sqliteDatabaseBytes),
				sqliteWalBytes: Math.max(0, funded.sqliteWalBytes - current.sqliteWalBytes),
				// addHorizons takes the SHM maximum, so the SHM horizon is passed absolute.
				sqliteShmBytes: funded.sqliteShmBytes,
			};
			const releaseBytes = this.#requiredData(current, write, backing, 0, "transfer");
			const releaseDataBytes = roundUp(releaseBytes, poolState.blockSize);
			const horizon = this.#targetHorizon(current, write, backing);
			const overheadBytes = Math.min(
				releaseDataBytes,
				roundUp(
					safeAdd(
						this.#transferOverhead(horizon, this.#live() ? this.#missingTargets(horizon, backing) : write),
						this.#sharedTargets.size * XFS_COW_WINDOW_BYTES,
					),
					poolState.blockSize,
				),
			);
			if (this.#identity.backend !== "sqlite") {
				if (funded.jsonlBytes <= target.jsonlBytes)
					return { target: funded, releaseBytes, releaseDataBytes, overheadBytes, settled: 0, pool: requiredData };
				// A JSONL arena past this command's append: afterwards the dense prefix up to the arena is
				// credited backing, and any part beyond the obligation horizon only adds its XFS metadata.
				// As for SQLite, the pool must keep the standing reserve whether the append then commits or rolls back.
				const afterBacking = {
					...backing,
					jsonlBytes: Math.max(backing.jsonlBytes, roundUp(funded.jsonlBytes, 4_096)),
				};
				const commit = this.#requiredData(
					current,
					increment,
					afterBacking,
					safeAdd(obligation.sqliteCohort?.commands ?? 0, 1),
				);
				const rollback = this.#requiredData(
					current,
					this.#capacityIncrement(current, ZERO_DEBT, rollbackObligation),
					afterBacking,
					rollbackObligation.sqliteCohort?.commands ?? 0,
				);
				const settled = poolDataTarget(Math.max(commit, rollback), poolState.blockSize);
				return {
					target: funded,
					releaseBytes,
					releaseDataBytes,
					overheadBytes,
					settled,
					pool: Math.max(requiredData, safeAdd(releaseDataBytes, settled)),
				};
			}
			const fundedDatabaseBytes = Math.max(funded.sqliteDatabaseBytes, backing.sqliteDatabaseBytes);
			// A checkpoint truncates to its snapshot's page count rounded up to the bound chunk C. With auto_vacuum=0
			// (configure) and no VACUUM on the exclusive connection the page count never decreases, so that truncation
			// keeps at least roundUp(committed pages, C), and at least C for any nonempty DB. Credit no more than that.
			const boundDatabaseBytes = sqliteBoundDatabaseHorizon(funded.sqliteDatabaseBytes, backing.sqliteDatabaseBytes);
			const chunkBytes = sqliteDatabaseChunkSize(boundDatabaseBytes);
			const truncationFloor =
				committedPages === undefined || chunkBytes === 0
					? 0
					: roundUp(committedPages * SQLITE_PAGE_BYTES, chunkBytes);
			const retainedDatabaseBytes = Math.min(fundedDatabaseBytes, Math.max(chunkBytes, truncationFloor));
			const afterHorizon: AuthorityCapacityDebt = {
				jsonlBytes: Math.max(funded.jsonlBytes, backing.jsonlBytes),
				sqliteDatabaseBytes: fundedDatabaseBytes,
				sqliteWalBytes: Math.max(funded.sqliteWalBytes, backing.sqliteWalBytes),
				sqliteShmBytes: Math.max(funded.sqliteShmBytes, backing.sqliteShmBytes),
			};
			// RESTART reuses WAL in place (sqlite3.c:71403-71415); checkpoint truncates the DB fd only (69844-69851).
			// Credit DB C and fund any H-C suffix; #standingData separately refunds the WAL that close deletes.
			const afterBacking: AuthorityCapacityDebt = { ...afterHorizon, sqliteDatabaseBytes: retainedDatabaseBytes };
			const commit = standing(afterHorizon, afterBacking, obligation, committedCertificate, true);
			// A rolled-back transfer has spent its attempt collateral; only an explicit
			// retry needs it again, which NEW-admission reconciliation refills.
			const rollback = standing(afterHorizon, afterBacking, rollbackObligation, this.#nativeCertificate, false);
			const settled = Math.max(commit, rollback);
			// poolDataTarget(release + settled) - release >= poolDataTarget(settled): pool metadata is monotone.
			return {
				target: funded,
				releaseBytes,
				releaseDataBytes,
				overheadBytes,
				settled: poolDataTarget(settled, poolState.blockSize),
				pool: Math.max(requiredData, pre, safeAdd(releaseDataBytes, settled)),
			};
		};
		let chosen = plan(target);
		this.#ensurePoolData(chosen.pool, guard);
		if (this.#identity.backend === "jsonl") {
			// Same policy for the append-only JSONL target: funding moves its timestamps, which costs the owner
			// a full journal re-read (jsonl-driver integrity fence), so fund a whole arena ahead and keep those
			// re-reads to one per arena. Only spare pool data pays for it; only NEW admission grows the pool for it.
			const arenaTarget = this.#arenaHorizon(target, backing, {
				databaseBytes: 0,
				walBytes: 0,
				jsonlBytes: target.jsonlBytes,
			});
			// An arena equal to the target plans exactly the chosen transfer, so it is never planned twice.
			const arena = sameHorizons(arenaTarget, target) ? chosen : plan(arenaTarget);
			if (arena.releaseBytes > chosen.releaseBytes) {
				if (newAdmission && arena.pool <= guard) this.#tryGrowPool(arena.pool);
				if (poolDataTarget(arena.pool, poolState.blockSize) <= this.#pool.inspect().dataBytes) chosen = arena;
			}
		}
		if (this.#live()) {
			// Fund a whole arena when a target is short or within half its slack of being short, so the
			// following commits find their targets backed (no release, allocation or fsync) and the WAL
			// keeps room to batch resets. Only spare pool data pays for it: a funded continuation never
			// grows the pool or refuses because of an arena.
			// The DB arena follows this command's need (the database file persists, so pre-funding every
			// later option envelope into it would bloat it); one WAL transaction may be any later one.
			const arenaTarget = this.#arenaHorizon(target, backing, {
				databaseBytes: this.#horizonNeed(write, ZERO_DEBT, this.#nativeCertificate, walFrames).databaseBytes,
				walBytes: this.#horizonNeed(write, obligation, this.#nativeCertificate, walFrames).walBytes,
			});
			const arena = sameHorizons(arenaTarget, target) ? chosen : plan(arenaTarget);
			if (arena.releaseBytes > chosen.releaseBytes) {
				// NEW admission may grow the pool anyway, so it may also try to grow it for the arena.
				if (newAdmission && arena.pool <= guard) this.#tryGrowPool(arena.pool);
				if (poolDataTarget(arena.pool, poolState.blockSize) <= this.#pool.inspect().dataBytes) chosen = arena;
			}
		}
		target = chosen.target;
		const { releaseBytes, releaseDataBytes, overheadBytes } = chosen;
		const settledPoolReserve = chosen.settled;
		if (releaseBytes === 0) {
			if (this.#identity.backend === "sqlite")
				this.#setDatabaseChunkSize(
					sqliteBoundDatabaseHorizon(target.sqliteDatabaseBytes, backing.sqliteDatabaseBytes),
				);
			return;
		}
		try {
			let released = 0;
			const release = (bytes: number): void => {
				if (bytes === 0) return;
				const result = this.#pool.releaseDataBytes(bytes);
				if (result.releasedDataBytes !== bytes)
					throw new Error("Authority capacity transfer released a different amount than requested");
				released += bytes;
			};
			let allocated = 0;
			// What the pool owes the targets: their allocation so far plus the transfer's XFS metadata, never more than planned.
			const owed = (bytes: number): number =>
				Math.min(releaseDataBytes, roundUp(safeAdd(overheadBytes, bytes), poolState.blockSize));
			// Allocate into the targets first and shrink the pool after, so freed pool blocks are never exposed to other
			// writers (the unreserved transcript, another session's pool) before the target holds what they pay for. Only
			// a step that finds no space outside the pool releases ahead of itself, one step at a time; a failure then
			// strands at most one release step, as before.
			this.#fundTargets(target, {
				allocated: bytes => {
					allocated += bytes;
				},
				makeRoom: bytes => {
					const amount = Math.min(
						releaseDataBytes - released,
						Math.max(owed(allocated + bytes) - released, roundUp(TRANSFER_RELEASE_BYTES, poolState.blockSize)),
					);
					if (amount <= 0) return false;
					release(amount);
					return true;
				},
			});
			release(Math.max(0, owed(allocated) - released));
			if (this.#identity.backend === "sqlite" && this.#pool.inspect().dataBytes < settledPoolReserve)
				throw new Error("Authority capacity transfer consumed its funded post-settlement reserve");
			if (this.#identity.backend === "sqlite")
				this.#setDatabaseChunkSize(
					sqliteBoundDatabaseHorizon(target.sqliteDatabaseBytes, backing.sqliteDatabaseBytes),
				);
			// prepare runs before native writes/COMMIT; the funded arena is now pinned before SQLite can size-hint/truncate.
		} catch (error) {
			this.#admissionFailure = error;
			try {
				const previous = this.#pool.reconcile();
				const retained = appendFutureDebt(this.#ledger.currentDebt(), this.#systemDebt());
				const oldIncrement = this.#capacityIncrement(current, ZERO_DEBT, retained);
				const oldRequired = poolDataTarget(
					this.#standingData(
						current,
						oldIncrement,
						this.#backingHorizons(),
						retained.sqliteCohort?.commands ?? 0,
						false,
					),
					previous.blockSize,
				);
				if (previous.dataBytes < oldRequired) this.#growPool(previous.dataBytes, oldRequired, previous.blockSize);
			} catch (reconcileError) {
				this.#admissionFailure = new AggregateError(
					[error, reconcileError],
					"Authority capacity release and same-owner reconciliation failed",
				);
				throw this.#admissionFailure;
			}
			throw error;
		}
	}

	/*
	 * Arena for a live SQLite or a JSONL target whose backing is within half a slack of the mandatory target: the target
	 * plus a slack. The JSONL journal gets a slack proportional to its need below 8 MiB (max(2 MiB, need): the arena
	 * doubles) and max(8 MiB, need/8) above it, so a small journal is not mostly zero-filled arena while large ones keep
	 * the same steady-state arenas. Either way growth is geometric, bounding transfers by O(log H) plus one per ~4 MiB
	 * of horizon drift. SQLite keeps the 8 MiB floor: a small database's file is dominated by its own funded need
	 * (pages + this command's priced allocations), and the WAL slack is the room #reconcileWal spends before it needs
	 * a RESTART. Targets with enough backing keep their horizon.
	 */
	#arenaHorizon(
		target: AuthorityCapacityDebt,
		backing: AuthorityCapacityDebt,
		need: { readonly databaseBytes: number; readonly walBytes: number; readonly jsonlBytes?: number },
	): AuthorityCapacityDebt {
		// Measure from the computed need, never from a file size: SQLite's chunked truncate rounds the DB
		// EOF up to the bound arena, so a size-based trigger would ratchet the arena on every admission.
		const grow = (bytes: number, needed: number, backed: number, persistent: boolean): number => {
			const slack =
				persistent && needed < ARENA_SLACK_BYTES
					? Math.max(ARENA_MIN_SLACK_BYTES, needed)
					: Math.max(ARENA_SLACK_BYTES, Math.floor(needed / 8));
			return roundUp(safeAdd(needed, Math.floor(slack / 2)), 4_096) > backed
				? Math.max(bytes, roundUp(safeAdd(needed, slack), SQLITE_PAGE_BYTES))
				: bytes;
		};
		if (this.#identity.backend === "jsonl")
			return {
				...target,
				jsonlBytes: grow(target.jsonlBytes, need.jsonlBytes ?? target.jsonlBytes, backing.jsonlBytes, true),
			};
		const database = grow(target.sqliteDatabaseBytes, need.databaseBytes, backing.sqliteDatabaseBytes, false);
		return {
			...target,
			sqliteDatabaseBytes: database === target.sqliteDatabaseBytes ? database : sqliteDatabaseArenaEnd(database),
			sqliteWalBytes: grow(target.sqliteWalBytes, need.walBytes, backing.sqliteWalBytes, false),
		};
	}

	#live(): boolean {
		return (
			this.#identity.backend === "sqlite" &&
			this.#database !== undefined &&
			liveCapacityConnections.has(this.#database)
		);
	}

	/*
	 * Every public entry starts here: it re-verifies the pool on its first inspection, and ends certificate reuse, which
	 * only prepare and settlement re-establish (any other path may write a target, or did not take the certificate).
	 */
	#startCall(): void {
		this.#pool.forget();
		this.#groupCertified = false;
		this.#appendCertified = false;
	}

	/*
	 * Live SQLite standing reserve: R plus a refund of the whole reset-epoch WAL
	 * horizon, because close deletes the nonpersistent WAL after later transfers may
	 * have grown it to that horizon; reopen funds it again from zero. With `attempt`,
	 * one more transfer overhead and release step cover a conversion that fails
	 * partway. Commit leaves exactly this reserve for the remaining N-1 commands.
	 */
	#standingData(
		current: AuthorityCapacityDebt,
		increment: AuthorityCapacityDebt,
		backing: AuthorityCapacityDebt,
		commands: number,
		attempt: boolean,
	): number {
		const required = this.#requiredData(current, increment, backing, commands);
		if (!this.#live()) return required;
		// The funded WAL horizon (arena included) bounds what close can delete; it is constant
		// while commits stay inside the arena, so the refund does not drift with every commit.
		const refund = roundUp(this.#targetHorizon(current, increment, backing).sqliteWalBytes, 4_096);
		const collateral =
			attempt && commands > 0
				? safeAdd(
						this.#transferOverhead(this.#targetHorizon(current, increment, backing), increment),
						safeAdd(TRANSFER_RELEASE_BYTES, this.#sharedTargets.size * XFS_COW_WINDOW_BYTES),
					)
				: 0;
		return safeAdd(required, safeAdd(refund, collateral));
	}

	#targetHorizon(
		current: AuthorityCapacityDebt,
		increment: AuthorityCapacityDebt,
		backing: AuthorityCapacityDebt,
	): AuthorityCapacityDebt {
		const desired = addHorizons(current, increment);
		return {
			jsonlBytes: Math.max(desired.jsonlBytes, backing.jsonlBytes),
			sqliteDatabaseBytes: Math.max(desired.sqliteDatabaseBytes, backing.sqliteDatabaseBytes),
			sqliteWalBytes: Math.max(desired.sqliteWalBytes, backing.sqliteWalBytes),
			sqliteShmBytes: Math.max(desired.sqliteShmBytes, backing.sqliteShmBytes),
		};
	}

	#transferOverhead(horizon: AuthorityCapacityDebt, increment: AuthorityCapacityDebt): number {
		// JSONL appends never rewrite its initialized prefix. New bmbt records
		// are bounded by appended blocks; the seven +1 levels also cover the
		// old boundary path splitting (XFS xfs_bmap_btree.c:248-524).
		if (this.#identity.backend === "jsonl") {
			const append = xfsTargetEnvelope({ databaseBytes: increment.jsonlBytes, walBytes: 0, shmBytes: 0 });
			return (append.metadataBlocks + append.workspaceBlocks) * 4_096;
		}
		// Live SQLite funding is also append-only: fundAuthorityCapacityTarget only allocates KEEP_SIZE
		// blocks past the certified dense prefix, so the same per-append envelope bounds a transfer's
		// bmbt growth. SQLite's own unwritten-to-written conversions are NOT transfer work: records never
		// exceed blocks, so the whole tree always fits the standing xfsHorizonBytes(H) charged once.
		// The heap WAL index needs no SHM transfer.
		if (this.#live()) {
			const sqlite = xfsTargetEnvelope({
				databaseBytes: increment.sqliteDatabaseBytes,
				walBytes: increment.sqliteWalBytes,
				shmBytes: 0,
			});
			return (sqlite.metadataBlocks + sqlite.workspaceBlocks) * 4_096;
		}
		return (
			xfsHorizonBytes(horizon, this.#identity) -
			(roundUp(horizon.sqliteDatabaseBytes, 4_096) +
				roundUp(horizon.sqliteWalBytes, 4_096) +
				roundUp(horizon.sqliteShmBytes, 4_096))
		);
	}

	#capacityIncrement(
		current: AuthorityCapacityDebt,
		write: AuthorityCapacityDebt,
		future: AuthorityCapacityDebt,
		nativeCertificate: SqliteNativeCertificate = this.#nativeCertificate,
		walFramesBefore = 0,
	): AuthorityCapacityDebt {
		if (this.#identity.backend === "jsonl") return addHorizons(write, future);
		const need = this.#horizonNeed(write, future, nativeCertificate, walFramesBefore);
		const retainedPages = need.databaseBytes / SQLITE_PAGE_BYTES;
		const reusableWal = need.walBytes;
		const rawDatabase = write.sqliteCohort ? 0 : write.sqliteDatabaseBytes;
		const rawWal = write.sqliteCohort ? 0 : write.sqliteWalBytes;
		const databaseHorizon = Math.max(
			retainedPages * SQLITE_PAGE_BYTES,
			safeAdd(current.sqliteDatabaseBytes, rawDatabase),
		);
		const databaseArenaEnd = sqliteDatabaseArenaEnd(databaseHorizon);
		return {
			...ZERO_DEBT,
			sqliteDatabaseBytes: Math.max(0, databaseArenaEnd - current.sqliteDatabaseBytes),
			sqliteWalBytes: Math.max(
				0,
				Math.max(reusableWal, safeAdd(current.sqliteWalBytes, rawWal)) - current.sqliteWalBytes,
			),
			sqliteShmBytes: this.#database && liveCapacityConnections.has(this.#database) ? 0 : write.sqliteShmBytes,
		};
	}

	/** Live SQLite DB and WAL horizons the cohorts need, before flooring at the targets' current sizes. */
	#horizonNeed(
		write: AuthorityCapacityDebt,
		future: AuthorityCapacityDebt,
		nativeCertificate: SqliteNativeCertificate,
		walFramesBefore: number,
	): { databaseBytes: number; walBytes: number } {
		const now = write.sqliteCohort ?? EMPTY_COHORT;
		const later = future.sqliteCohort ?? EMPTY_COHORT;
		// Whole-tree stable populations plus a shared transient arena cover old
		// rows, overflow removal and freelist trunks, including arbitrary batches.
		const potentialPages = safeAdd(nativeCertificate.retained, safeAdd(now.retained, later.retained));
		// The potential needs every existing cell (2 pages each); an unobserved history falls back to 2046
		// cells per page, i.e. ~4,093x the file. The additive bound needs only the current page count.
		const additivePages =
			nativeCertificate.pages === undefined
				? undefined
				: safeAdd(
						nativeCertificate.pages,
						safeAdd(now.allocated, Math.ceil(future.sqliteDatabaseBytes / SQLITE_PAGE_BYTES)),
					);
		const pages = additivePages === undefined ? potentialPages : Math.min(potentialPages, additivePages);
		const frames = safeAdd(walFramesBefore, this.#walTransactionFrames(write, future, nativeCertificate));
		return { databaseBytes: pages * SQLITE_PAGE_BYTES, walBytes: safeAdd(32, frames * SQLITE_WAL_FRAME_BYTES) };
	}

	/*
	 * Frames that any ONE transaction among `write` and `future` can append after a WAL reset.
	 * With cache_spill=OFF a transaction writes each dirty page once, so its frames never exceed the pages
	 * that can exist when it commits, minus immutable overflow it cannot rewrite. Two bounds, take the min:
	 *  - potential: the certified reusable population plus every cohort (the original model);
	 *  - additive: current pages + this command's allocations + every later command's non-option
	 *    allocations + one command's option envelope (option payload is immutable overflow written only
	 *    by its own transaction; a batch carries one request, hence one envelope).
	 */
	#walTransactionFrames(
		write: AuthorityCapacityDebt,
		future: AuthorityCapacityDebt,
		nativeCertificate: SqliteNativeCertificate,
	): number {
		const now = write.sqliteCohort ?? EMPTY_COHORT;
		const later = future.sqliteCohort ?? EMPTY_COHORT;
		const core = safeAdd(nativeCertificate.reusable, safeAdd(now.reusable, later.reusable));
		// On the bound connection prepare() admits a cohort only after a certified
		// reconciliation, so each command starts from the WAL's certified frame count
		// and a later one appends only within certified room. A failed, unknown or
		// post-reopen reconciliation refuses appends instead of extending the WAL.
		const reset = this.#live();
		// `later` holds only promised continuations (a NEW admission is this command's own `write`), so a
		// later transaction's option payload is bounded by the continuation request bound.
		const envelope = Math.ceil((2 * this.#continuationBytes) / SQLITE_OVERFLOW_BYTES) + 3;
		const options = reset ? (later.options ? envelope : 0) : later.options;
		// Current immutable payload and a later command's option payload belong
		// to DIFFERENT transactions. Never add both to one transaction; without
		// the actual reset certificate retain the additive fallback.
		const payload = reset
			? Math.max(now.immutable, safeAdd(later.immutable, options))
			: safeAdd(now.immutable, safeAdd(later.immutable, options));
		const potential = safeAdd(core, payload);
		if (!reset) return potential;
		// With certified reuse, the WAL never holds more than the frames already in it plus ONE transaction
		// (see #reconcileWal), and that transaction is either this command's own write or one later command:
		// each frame's dirty-page union is already priced per command (sqliteCommitDebt), so the largest single
		// command bounds it, independent of how many commands are outstanding.
		const step = Math.ceil(
			Math.max(write.sqliteStepWalBytes ?? 0, future.sqliteStepWalBytes ?? 0) / SQLITE_WAL_FRAME_BYTES,
		);
		if (nativeCertificate.pages === undefined) return Math.min(potential, step);
		const laterPages = Math.ceil(future.sqliteDatabaseBytes / SQLITE_PAGE_BYTES);
		const additive = safeAdd(
			nativeCertificate.pages,
			safeAdd(now.allocated, safeAdd(Math.max(0, laterPages - later.options), later.options ? envelope : 0)),
		);
		return Math.min(potential, additive, step);
	}

	#requiredData(
		current: AuthorityCapacityDebt,
		increment: AuthorityCapacityDebt,
		backing: AuthorityCapacityDebt,
		commands = 0,
		mode: "standing" | "transfer" = "standing",
	): number {
		const horizon = this.#targetHorizon(current, increment, backing);
		// Credit only certified data inside THIS horizon. Current target metadata,
		// conversion workspace, final-close metadata and pool metadata stay charged.
		const dataCredit =
			Math.min(roundUp(horizon.jsonlBytes, 4_096), backing.jsonlBytes) +
			Math.min(roundUp(horizon.sqliteDatabaseBytes, 4_096), backing.sqliteDatabaseBytes) +
			Math.min(roundUp(horizon.sqliteWalBytes, 4_096), backing.sqliteWalBytes) +
			Math.min(roundUp(horizon.sqliteShmBytes, 4_096), backing.sqliteShmBytes);
		const targetBytes = xfsHorizonBytes(horizon, this.#identity);
		const dataBytes =
			roundUp(horizon.jsonlBytes, 4_096) +
			roundUp(horizon.sqliteDatabaseBytes, 4_096) +
			roundUp(horizon.sqliteWalBytes, 4_096) +
			roundUp(horizon.sqliteShmBytes, 4_096);
		const transferOverhead = this.#live() ? 0 : this.#transferOverhead(horizon, increment);
		// In block units, R = missingData(H, B) + standingEnvelope(H) + N*T.
		// N includes the current command during prepare, not after settlement.
		// Native settlement can reduce guaranteed B while H stays fixed, so
		// #fundAndRelease reserves each post-settlement fixed point explicitly.
		// A standing JSONL increment holds ALL future appends; each command spends
		// only its own append envelope, so charge their splittable aggregate.
		const copyOnWrite = this.#sharedTargets.size * XFS_COW_WINDOW_BYTES;
		const missing = dataBytes - dataCredit;
		if (mode === "transfer") {
			// Fully backed targets need no transfer: no pool release, allocation, or fsync. For live SQLite and for a
			// JSONL append inside its funded KEEP_SIZE arena alike, the write only converts already-allocated
			// unwritten blocks; bmbt records never exceed blocks, so that conversion tree is inside the standing
			// xfsHorizonBytes(H) charged once for the horizon (which includes the arena), not per command. Without this
			// JSONL released (ftruncate+fsync) one append envelope from the pool on every commit and regrew it later.
			if (missing === 0 && (this.#live() || this.#identity.backend === "jsonl")) return 0;
			return safeAdd(
				missing,
				safeAdd(
					this.#live()
						? this.#transferOverhead(horizon, this.#missingTargets(horizon, backing))
						: transferOverhead,
					copyOnWrite,
				),
			);
		}
		// Future transfers append at most the still-missing bytes of this horizon, one append per target
		// per command (DB and WAL on the live heap-index connection): charge their splittable aggregate.
		const perCommand =
			this.#identity.backend === "jsonl"
				? xfsAppendOverheadBytes(increment.jsonlBytes, commands)
				: this.#live()
					? xfsAppendOverheadBytes(missing, 2 * commands)
					: commands * transferOverhead;
		return safeAdd(targetBytes - dataCredit, safeAdd(perCommand, copyOnWrite));
	}

	/** Per-target bytes a transfer to `horizon` must still allocate beyond the certified backing. */
	#missingTargets(horizon: AuthorityCapacityDebt, backing: AuthorityCapacityDebt): AuthorityCapacityDebt {
		const missing = (field: Exclude<keyof AuthorityCapacityDebt, "sqliteCohort" | "sqliteStepWalBytes">): number =>
			Math.max(0, roundUp(horizon[field], 4_096) - backing[field]);
		return {
			jsonlBytes: missing("jsonlBytes"),
			sqliteDatabaseBytes: missing("sqliteDatabaseBytes"),
			sqliteWalBytes: missing("sqliteWalBytes"),
			sqliteShmBytes: missing("sqliteShmBytes"),
		};
	}

	#backingHorizons(
		allowed?: AuthorityCapacityDebt,
		current = targetHorizons(this.#filename, this.#identity),
		readback: BackingReadback = "full",
		appended?: fs.BigIntStats,
	): AuthorityCapacityDebt {
		const targets: readonly [string, Exclude<keyof AuthorityCapacityDebt, "sqliteCohort" | "sqliteStepWalBytes">][] =
			this.#identity.backend === "jsonl"
				? [[this.#filename, "jsonlBytes"]]
				: [
						[this.#filename, "sqliteDatabaseBytes"],
						[`${this.#filename}-wal`, "sqliteWalBytes"],
						[`${this.#filename}-shm`, "sqliteShmBytes"],
					];
		const reused =
			readback === "group"
				? this.#groupBacking(targets, current)
				: readback === "append" && appended
					? this.#appendBacking(appended)
					: undefined;
		if (reused) return reused;
		const backing = { ...ZERO_DEBT };
		let domain;
		try {
			domain = this.#pool.inspect();
		} catch (primary) {
			try {
				domain = this.#pool.reconcile();
			} catch (error) {
				throw new AggregateError(
					[primary, error],
					"Authority backing readback and same-owner pool reconciliation failed",
					{ cause: primary },
				);
			}
		}
		for (const [filename, field] of targets) {
			let descriptor: number;
			try {
				descriptor = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" && current[field] === 0) {
					this.#targetCertificates.delete(filename);
					this.#targetAllocationEnds.delete(filename);
					continue;
				}
				throw error;
			}
			const certificate = this.#withTargetDescriptor(descriptor, () => {
				const horizon = Math.max(
					current[field],
					this.#targetHorizons.get(filename) ?? 0,
					this.#targetAllocationEnds.get(filename) ?? 0,
					allowed?.[field] ?? 0,
				);
				const previous = this.#targetCertificates.get(filename);
				const suffix =
					readback === "suffix" && previous && this.#targetHorizons.has(filename)
						? inspectAuthorityCapacityTargetSuffix(descriptor, domain, horizon, previous)
						: undefined;
				// A reopened owner's KEEP_SIZE suffix has no in-memory horizon.
				// Discover its dense physical prefix without granting any exemption:
				// every returned byte becomes BOTH target horizon and backing in
				// #requiredData, including its complete XFS metadata/workspace.
				// This read-only safe off_t bound is never an allocation request;
				// subsequent reads/funding use only the actual certified prefix.
				const inspectHorizon = this.#targetHorizons.has(filename)
					? horizon
					: Math.floor(Number.MAX_SAFE_INTEGER / domain.blockSize) * domain.blockSize;
				const next = suffix ?? inspectAuthorityCapacityTarget(descriptor, domain, inspectHorizon, 0);
				// Before the live connection reports its page count, the header supplies the truncation floor.
				if (field === "sqliteDatabaseBytes" && this.#nativeCertificate.pages === undefined)
					this.#headerPages = sqliteHeaderPageCount(descriptor);
				this.#targetCertificates.set(filename, next);
				this.#targetHorizons.set(filename, next.coveredBytes);
				this.#targetAllocationEnds.set(filename, next.allocatedBytes);
				if (next.sharedBytes > 0) this.#sharedTargets.add(filename);
				return next;
			});
			backing[field] = certificate.coveredBytes;
		}
		return backing;
	}

	/** Backing from the certificates the open group's transaction took; undefined (full readback) if any EOF moved. */
	#groupBacking(
		targets: readonly [string, Exclude<keyof AuthorityCapacityDebt, "sqliteCohort" | "sqliteStepWalBytes">][],
		current: AuthorityCapacityDebt,
	): AuthorityCapacityDebt | undefined {
		const backing = { ...ZERO_DEBT };
		for (const [filename, field] of targets) {
			const certificate = this.#targetCertificates.get(filename);
			if (!certificate) {
				if (current[field] !== 0) return undefined;
				continue;
			}
			if (certificate.logicalBytes !== current[field]) return undefined;
			backing[field] = certificate.coveredBytes;
		}
		return backing;
	}

	/*
	 * JSONL backing after the owner's own append (see #appendCertified): the same inode, its EOF advanced but still inside
	 * the private prefix the prepare certified. Anything else (a replaced inode, a cut, an append past the certified
	 * arena) falls back to a full readback.
	 */
	#appendBacking(stat: fs.BigIntStats): AuthorityCapacityDebt | undefined {
		const certificate = this.#targetCertificates.get(this.#filename);
		if (!certificate) return undefined;
		if (!stat.isFile() || stat.dev !== certificate.device || stat.ino !== certificate.inode) return undefined;
		const size = Number(stat.size);
		if (size < certificate.logicalBytes || size > certificate.coveredBytes) return undefined;
		this.#targetCertificates.set(this.#filename, { ...certificate, logicalBytes: size });
		return { ...ZERO_DEBT, jsonlBytes: certificate.coveredBytes };
	}

	#setDatabaseChunkSize(horizonBytes: number): void {
		const database = this.#database;
		if (!database || !liveCapacityConnections.has(database)) return;
		const chunkBytes = sqliteDatabaseChunkSize(horizonBytes);
		if (chunkBytes === 0) return;
		const buffer = (this.#databaseChunkBuffer ??= new Int32Array(2));
		setSqliteDatabaseChunkSize(database, chunkBytes, buffer);
	}

	#fundTargets(horizon: AuthorityCapacityDebt, funding: AuthorityTargetFunding): void {
		const targets: readonly [string, number][] =
			this.#identity.backend === "jsonl"
				? [[this.#filename, horizon.jsonlBytes]]
				: [
						[this.#filename, horizon.sqliteDatabaseBytes],
						[`${this.#filename}-wal`, horizon.sqliteWalBytes],
						[`${this.#filename}-shm`, horizon.sqliteShmBytes],
					];
		const domain = this.#pool.inspect();
		for (const [filename, bytes] of targets) {
			if (bytes === 0) continue;
			const descriptor = fs.openSync(
				filename,
				fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
				0o600,
			);
			this.#withTargetDescriptor(descriptor, () => {
				const stat = fs.fstatSync(descriptor);
				const previous = this.#targetHorizons.get(filename) ?? stat.size;
				// Checkpoint/close may discard target extents; never inherit their ticket across reset.
				const expected = Math.max(bytes, previous);
				this.#targetHorizons.set(filename, roundUp(expected, domain.blockSize));
				const certificate = fundAuthorityCapacityTarget(
					descriptor,
					domain,
					expected,
					this.#targetCertificates.get(filename),
					{
						allocated: bytes => {
							this.#targetsTouched = true;
							funding.allocated?.(bytes);
						},
						makeRoom: bytes => funding.makeRoom?.(bytes) ?? false,
					},
					this.#targetAllocationEnds.get(filename) ?? 0,
				);
				this.#targetCertificates.set(filename, certificate);
				this.#targetHorizons.set(filename, certificate.coveredBytes);
				this.#targetAllocationEnds.set(
					filename,
					Math.max(certificate.allocatedBytes, this.#targetAllocationEnds.get(filename) ?? 0),
				);
			});
		}
	}

	#ensurePoolData(targetBytes: number, guardBytes: number): void {
		const state = this.#pool.inspect();
		const target = poolDataTarget(targetBytes, state.blockSize);
		if (state.dataBytes >= target) return;
		const refuse = (cause: Error): never => {
			// Nothing was allocated: the previous promise stands and only NEW admission closes.
			this.#admissionFailure = new AuthorityCapacityRefusedError(cause);
			throw this.#admissionFailure;
		};
		if (targetBytes > guardBytes)
			refuse(
				new Error(
					`Authority capacity computed a ${targetBytes}-byte reserve above its ${guardBytes}-byte provable bound`,
				),
			);
		const free = this.#freeBytes();
		if (target - state.dataBytes > free)
			refuse(
				new AuthorityCapacityPoolError(
					`Authority capacity needs ${target - state.dataBytes} more reserve bytes but only ${free} are free`,
					"verified",
					state,
					Object.assign(new Error("Insufficient free space for the reserve; nothing was allocated"), {
						code: "ERRNO_28",
						errno: -28,
					}),
				),
			);
		try {
			this.#growPool(state.dataBytes, target, state.blockSize);
		} catch (error) {
			this.#admissionFailure = error;
			try {
				this.#reconcilePoolTo(state.dataBytes);
			} catch (reconcileError) {
				this.#admissionFailure = new AggregateError(
					[error, reconcileError],
					"Authority capacity growth and same-owner reconciliation failed",
				);
				throw this.#admissionFailure;
			}
			// Reconciliation re-proved at least the previous promise, so exhausted space is a
			// clean refusal of the NEW reservation; any other cause stays uncertain.
			if (exhaustedSpace(error)) this.#admissionFailure = new AuthorityCapacityRefusedError(error);
			throw this.#admissionFailure;
		}
		// Only after the exact growth succeeded: add optional slack so obligations that drift by a few pages (SQLite)
		// or one append envelope (JSONL) per command do not grow (and fsync) the pool on every NEW admission.
		if (this.#live() || this.#identity.backend === "jsonl")
			this.#tryGrowPool(
				Math.min(guardBytes, safeAdd(targetBytes, Math.max(ARENA_SLACK_BYTES, Math.floor(targetBytes / 8)))),
			);
	}

	/*
	 * Optional growth (arena or pool slack), attempted only after a mandatory growth succeeded, so any
	 * failure of the mandatory path has already surfaced with its own semantics. It never refuses or
	 * closes admission: a failure (including an injected or simulated shortfall) only re-proves the
	 * previous pool and returns partial growth, and the command proceeds without the arena.
	 */
	#tryGrowPool(targetBytes: number): void {
		const state = this.#pool.inspect();
		const target = poolDataTarget(targetBytes, state.blockSize);
		if (state.dataBytes >= target || target - state.dataBytes > this.#freeBytes() / 2) return;
		try {
			this.#growPool(state.dataBytes, target, state.blockSize);
		} catch (growthError) {
			try {
				this.#reconcilePoolTo(state.dataBytes);
			} catch (reconcileError) {
				this.#admissionFailure = new AggregateError(
					[growthError, reconcileError],
					"Authority capacity optional arena growth and same-owner reconciliation failed",
				);
				throw this.#admissionFailure;
			}
		}
	}

	/** Re-proves the pool after a failed growth and returns any partial growth above `previous` to the filesystem. */
	#reconcilePoolTo(previous: number): number {
		const reconciled = this.#pool.reconcile();
		if (reconciled.dataBytes < previous)
			throw new Error("Reconciliation found less physical reserve than the previous funded promise");
		if (reconciled.dataBytes > previous) this.#pool.releaseDataBytes(reconciled.dataBytes - previous);
		return previous;
	}

	#freeBytes(): number {
		const filesystem = fs.statfsSync(`/proc/self/fd/${this.#poolDescriptor}`);
		const free = filesystem.bavail * filesystem.bsize;
		if (!Number.isSafeInteger(free) || free < 0)
			throw new Error("Authority capacity read an invalid free-space figure");
		return free;
	}

	#growPool(current: number, target: number, blockSize: number): void {
		if (current < target) this.#pool.ensureDataBytes(target, 6 * blockSize);
	}
}

/**
 * SQLite source proves TEMP_STORE=1/2 plus an early MEMORY setting keeps
 * statement subjournals in memory rather than creating auxiliary files.
 */
export function configureAuthoritySqliteCapacity(database: Database, live = false): number {
	const compileOptions = database.query<{ compile_options: string }, []>("PRAGMA compile_options").all();
	if (
		!compileOptions.some(
			({ compile_options }) => compile_options === "TEMP_STORE=1" || compile_options === "TEMP_STORE=2",
		)
	)
		throw new Error(
			"SQLite authority capacity requires a TEMP_STORE=1 or TEMP_STORE=2 build for memory-backed statement journals",
		);
	database.exec("PRAGMA temp_store=MEMORY");
	const tempStore = database.query<{ temp_store: number }, []>("PRAGMA temp_store").get()?.temp_store;
	if (tempStore !== 2) throw new Error("SQLite authority connection did not retain memory-backed statement journals");
	const source = database.query<{ source: string }, []>("SELECT sqlite_source_id() AS source").get()?.source;
	if (source !== "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc")
		throw new Error("SQLite authority capacity requires the source-pinned 3.53.4 allocator");
	for (const [pragma, expected] of [
		["page_size", 4_096],
		["auto_vacuum", 0],
		["encoding", "UTF-8"],
		["journal_size_limit", -1],
	] as const) {
		const row = database.query<Record<string, number | string>, []>(`PRAGMA ${pragma}`).get();
		if (!row || Object.values(row)[0] !== expected)
			throw new Error(`Unsupported SQLite capacity assumption: ${pragma}`);
	}
	if (!live) return tempStore;
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error("SQLite authority capacity requires the verified Linux x86_64 public SQLite ABI");
	database.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA mmap_size=0; PRAGMA synchronous=FULL");
	const settings = database.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get();
	const synchronous = database.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
	const mmap = database.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get();
	if (settings?.locking_mode !== "exclusive" || synchronous?.synchronous !== 2 || mmap?.mmap_size !== 0)
		throw new Error("SQLite authority connection did not retain exclusive, FULL-sync, mmap-disabled settings");
	database.exec("PRAGMA cache_spill=OFF");
	if (database.query<{ cache_spill: number }, []>("PRAGMA cache_spill").get()?.cache_spill !== 0)
		throw new Error("SQLite authority cannot disable repeated WAL spill frames");
	const control = (opcode: number, output: ArrayBufferView): void => {
		if (!Number.isSafeInteger(opcode) || database.fileControl("main", opcode, output) !== 0)
			throw new Error(`SQLite authority file control ${opcode} is unsupported by the opened connection`);
	};
	const integerControl = (opcode: number, initial = -1): number => {
		const output = new Int32Array([initial, 0]);
		control(opcode, output);
		return output[0]!;
	};
	const connectionPointer = (opcode: number): number => {
		const output = new BigUint64Array(1);
		control(opcode, output);
		const value = Number(output[0]);
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new Error("SQLite authority returned an invalid opened-connection pointer");
		return value;
	};
	const vfs = connectionPointer(constants.SQLITE_FCNTL_VFS_POINTER);
	if (read.i32(vfs, 0) !== 3) throw new Error("SQLite authority requires VFS version 3 on the opened connection");
	const namePointer = read.ptr(vfs, 24);
	if (namePointer === 0 || String(new CString(namePointer)) !== "unix")
		throw new Error("SQLite authority requires the supported unix VFS");
	const nativeFile = connectionPointer(constants.SQLITE_FCNTL_FILE_POINTER);
	const io = read.ptr(nativeFile, 0);
	if (io === 0) throw new Error("SQLite authority opened file has no native I/O methods");
	const ioVersion = read.i32(io, 0);
	if (ioVersion !== 3) throw new Error("SQLite authority requires version-3 native I/O methods");
	const sectorMethod = read.ptr(io, 88);
	const deviceMethod = read.ptr(io, 96);
	const methodPointer = (address: number, name: string): Pointer => {
		if (!Number.isSafeInteger(address) || address <= 0)
			throw new Error(`SQLite authority VFS returned an invalid ${name} method pointer`);
		return address as Pointer;
	};
	if (sectorMethod === 0 || deviceMethod === 0)
		throw new Error("SQLite authority VFS omits sector/device readback methods");
	const methods = linkSymbols({
		sectorSize: { ptr: methodPointer(sectorMethod, "sector-size"), args: ["ptr"], returns: "i32" },
		deviceCharacteristics: {
			ptr: methodPointer(deviceMethod, "device-characteristics"),
			args: ["ptr"],
			returns: "i32",
		},
	});
	try {
		if (
			methods.symbols.sectorSize(nativeFile as Pointer) !== 4_096 ||
			methods.symbols.deviceCharacteristics(nativeFile as Pointer) !== 36_864
		)
			throw new Error(
				"SQLite authority VFS sector/device characteristics are outside the funded source assumptions",
			);
	} finally {
		methods.close();
	}
	const chunkSize = new Int32Array([0, 0]);
	control(constants.SQLITE_FCNTL_CHUNK_SIZE, chunkSize);
	if (chunkSize[0] !== 0) throw new Error("SQLite authority VFS retained a nonzero preallocation chunk size");
	const file = database.query<{ file: string }, []>("PRAGMA database_list").get()?.file;
	if (!file) throw new Error("SQLite authority opened connection has no main database filename");
	const beforeHint = fs.statSync(file, { bigint: true });
	const sizeHint = new BigInt64Array([4n * 1_024n * 1_024n]);
	control(constants.SQLITE_FCNTL_SIZE_HINT, sizeHint);
	const afterHint = fs.statSync(file, { bigint: true });
	// This is only a no-growth discriminator; target backing credit still comes from FIEMAP certificates.
	if (
		beforeHint.dev !== afterHint.dev ||
		beforeHint.ino !== afterHint.ino ||
		beforeHint.size !== afterHint.size ||
		beforeHint.blocks !== afterHint.blocks
	)
		throw new Error(
			"SQLite authority size hint changed backing allocation despite zero chunk size and disabled mmap",
		);
	const existingFileBytes = Number(beforeHint.size);
	if (!Number.isSafeInteger(existingFileBytes) || existingFileBytes < 0)
		throw new Error("SQLite authority database EOF exceeds the safe chunk-size range");
	const existingChunkSize = sqliteExistingDatabaseChunkSize(existingFileBytes);
	// Preserve a known existing EOF before WAL setup; admission binds each larger funded arena before native writes.
	if (existingChunkSize !== 0) setSqliteDatabaseChunkSize(database, existingChunkSize, new Int32Array(2));
	database.exec("PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE; COMMIT");
	const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
	if (journal?.journal_mode !== "wal") throw new Error("SQLite authority connection did not retain WAL mode");
	if (
		integerControl(constants.SQLITE_FCNTL_PERSIST_WAL) !== 0 ||
		integerControl(constants.SQLITE_FCNTL_POWERSAFE_OVERWRITE) !== 1 ||
		integerControl(38) !== 0
	)
		throw new Error(
			"SQLite authority actual file controls do not prove nonpersistent WAL, PSOW, and zero reserve bytes",
		);
	if (integerControl(constants.SQLITE_FCNTL_LOCKSTATE) !== 4)
		throw new Error("SQLite authority actual file controls do not prove the opened connection's exclusive lock");
	liveCapacityConnections.add(database);
	return tempStore;
}
