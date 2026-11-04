import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AuthorityCommitFrame,
	AuthorityControl,
	AuthorityControlChange,
	AuthorityControlPage,
	AuthorityDomain,
	AuthorityDriverOptions,
	AuthorityExport,
	AuthorityIdentity,
	AuthorityKey,
	AuthorityMeta,
	AuthorityMetaUpdate,
	AuthorityPage,
	AuthorityPersistence,
	AuthorityRecordMap,
	AuthorityRow,
	AuthorityScan,
} from "./types";
import { AuthorityGroupBoundaryError, type AuthorityGroupCommit } from "./types";
import {
	authorityExportFromLegacySource,
	authorityGenesisHash,
	authorityKey,
	authorityRecordIsOpen,
	authorityRecordKey,
	validateAuthorityFrame,
	validateAuthorityFrameState,
	type AuthorityFrameState,
} from "./engine";
import { canonicalDurableSha256, validateDurableRegistryRecord, type DurableRegistryRecord } from "../durable-state";
import {
	SQLITE_AUTHORITY_APPLICATION_ID,
	SQLITE_AUTHORITY_CODEC_VERSION,
	SQLITE_AUTHORITY_DOMAINS,
	SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION,
	SQLITE_AUTHORITY_SCHEMA,
	SQLITE_AUTHORITY_SCHEMA_VERSION,
	SQLITE_AUTHORITY_V3_DOMAIN_TABLES,
} from "./sqlite-schema";
import {
	cesu8Decode,
	cesu8Encode,
	cesu8PrefixUpperBound,
	decodeAuthorityFrameBody,
	decodeAuthorityFrameV3,
	decodeAuthorityReceiptControlV3,
	encodeAuthorityFrameBody,
	receiptControlKey,
	sqliteAuthorityFrameColumns,
	sqliteAuthorityOrderKey,
	sqliteAuthorityOrderKeyAfter,
	sqliteAuthorityProjection,
	sqliteAuthorityFrameColumnsFromRow,
	sqliteAuthorityFrameRow,
	sqliteAuthorityReceipt,
	sqliteAuthorityRowValues,
	type SqliteAuthorityFrameColumns,
	type SqliteAuthorityFrameRow,
} from "./sqlite-codec";
import {
	AuthorityCapacityAdmission,
	authoritySqliteBootstrapDebt,
	configureAuthoritySqliteCapacity,
} from "./capacity-sqlite";
import { fsyncDirectorySync } from "./directory-sync";
import { fullFsyncRequired } from "./durable-sync";
import { AuthorityReplayState, AuthorityScratch, exportViewOf, verifyExportReader } from "./export-stream";
import type { AuthorityExportReader, AuthorityExportView, AuthoritySeedStream } from "./export-stream";
const BUSY_TIMEOUT_MS = 5_000;
const MAX_PAGE_SIZE = 1_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;
type StoredRow = {
	order_key: Uint8Array;
	version: number;
	wrapper_order: number;
	record: string;
	[column: string]: string | number | bigint | Uint8Array | null;
};
type ControlRow = { order_key: Uint8Array; value: string };
type IdentityRow = { value: string };
type FrameRow = SqliteAuthorityFrameRow & { body: Uint8Array };
const FRAME_COLUMNS = "revision, incarnation, request_id, epoch, hash, previous_hash, content_hash, receipt, body";
/** Domains in export order: every `authorityKey` starts with its domain name, so exports list rows domain by domain. */
const SORTED_DOMAINS = (Object.keys(SQLITE_AUTHORITY_DOMAINS) as AuthorityDomain[]).sort((left, right) =>
	compareText(authorityKey(left, []), authorityKey(right, [])),
);

function frameColumns(row: FrameRow): SqliteAuthorityFrameColumns {
	if (!(row.body instanceof Uint8Array)) throw new Error("SQLite authority frame body is not a BLOB.");
	return sqliteAuthorityFrameColumnsFromRow(row);
}

/** Session transcript path `S` of a payload named `S.authority.sqlite`, for operator guidance. */
function sessionPathOf(filePath: string): string {
	const suffix = ".authority.sqlite";
	return filePath.endsWith(suffix) ? filePath.slice(0, -suffix.length) : "<session>";
}

/** Refusal for a store this build cannot open, naming the offline conversion when one exists. */
export class SqliteAuthorityUnsupportedVersionError extends Error {
	readonly physicalVersion: number;
	constructor(filePath: string, applicationId: number, physicalVersion: number) {
		const convertible =
			applicationId === SQLITE_AUTHORITY_APPLICATION_ID &&
			physicalVersion === SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION;
		super(
			convertible
				? `Selected SQLite authority store uses physical schema v${physicalVersion}, which this build does not open (it writes v${SQLITE_AUTHORITY_SCHEMA_VERSION}). ` +
						`Stop the owning client and convert it offline: omp session authority ${sessionPathOf(filePath)} --to sqlite --apply`
				: applicationId === SQLITE_AUTHORITY_APPLICATION_ID
					? `Selected SQLite authority store uses unsupported physical schema version ${physicalVersion}; this build supports only v${SQLITE_AUTHORITY_SCHEMA_VERSION}.`
					: "Selected SQLite authority store uses an unsupported application or physical schema version.",
		);
		this.name = "SqliteAuthorityUnsupportedVersionError";
		this.physicalVersion = physicalVersion;
	}
}

type DomainStatements = {
	readonly get: Statement<StoredRow, SQLQueryBindings[]>;
	readonly upsert: Statement<SqlRow, SQLQueryBindings[]>;
};

class SQLiteUnknownCommitOutcomeError extends Error {
	readonly unknownOutcome = true;
	readonly requestId: string | undefined;
	readonly requestIdentity:
		| Pick<AuthorityCommitFrame["request"], "requestId" | "incarnation" | "ownerEpoch">
		| undefined;
	readonly rollbackError: unknown;

	constructor(frame: AuthorityCommitFrame | undefined, cause: unknown, rollbackError: unknown) {
		const requestId = frame?.request.requestId;
		super(
			`SQLite authority${requestId ? ` request ${requestId}` : " transaction"} reached COMMIT but its outcome is unknown.`,
			{ cause },
		);
		this.name = "SQLiteUnknownCommitOutcomeError";
		this.requestId = requestId;
		this.requestIdentity = frame
			? {
					requestId: frame.request.requestId,
					incarnation: frame.request.incarnation,
					ownerEpoch: frame.request.ownerEpoch,
				}
			: undefined;
		this.rollbackError = rollbackError;
	}
}
class SQLiteUnknownGroupOutcomeError extends Error {
	readonly unknownOutcome = true;
	readonly requestIds: readonly string[];
	readonly rollbackError: unknown;

	constructor(frames: readonly AuthorityCommitFrame[], reason: string, cause: unknown, rollbackError: unknown) {
		super(
			`SQLite authority group of ${frames.length} staged command(s) ${reason}; every grouped command has an unknown outcome.`,
			{ cause },
		);
		this.name = "SQLiteUnknownGroupOutcomeError";
		this.requestIds = Object.freeze(frames.map(frame => frame.request.requestId));
		this.rollbackError = rollbackError;
	}
}

interface SqliteAuthorityGroup {
	readonly frames: AuthorityCommitFrame[];
	// Members whose capacity prepare succeeded, including any later rolled back to their savepoint.
	prepared: number;
	failure?: SQLiteUnknownGroupOutcomeError;
}

const GROUP_MEMBER_SAVEPOINT = "authority_group_member";

function finalizeStatements(statements: Iterable<{ finalize(): void }>, finalized: WeakSet<object>): unknown[] {
	const failures: unknown[] = [];
	for (const statement of statements) {
		if (finalized.has(statement)) continue;
		try {
			statement.finalize();
			finalized.add(statement);
		} catch (error) {
			if (!failures.includes(error)) failures.push(error);
		}
	}
	return failures;
}

function throwWithCleanup(primary: unknown, cleanup: readonly unknown[], message: string): never {
	const errors = [primary];
	for (const error of cleanup) if (!errors.includes(error)) errors.push(error);
	if (errors.length === 1) throw primary;
	throw new AggregateError(errors, message, { cause: primary });
}

function removeCreatedArtifacts(filePath: string): unknown[] {
	const failures: unknown[] = [];
	for (const suffix of ["-wal", "-shm", ""]) {
		try {
			fs.unlinkSync(`${filePath}${suffix}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !failures.includes(error)) failures.push(error);
		}
	}
	return failures;
}

interface ConstructionCleanupState {
	readonly descriptors: Set<number>;
	readonly closeFailures: unknown[];
	created: boolean;
}

function withRawDescriptor<T>(descriptor: number, state: ConstructionCleanupState, run: (descriptor: number) => T): T {
	state.descriptors.add(descriptor);
	let result!: T;
	let primary: unknown;
	let failed = false;
	try {
		result = run(descriptor);
	} catch (error) {
		primary = error;
		failed = true;
	}
	let cleanup: unknown;
	let closeFailed = false;
	try {
		fs.closeSync(descriptor);
		state.descriptors.delete(descriptor);
	} catch (error) {
		// Linux may consume a descriptor before reporting a close error; never retry its reusable integer.
		state.descriptors.delete(descriptor);
		state.closeFailures.push(error);
		cleanup = error;
		closeFailed = true;
	}
	if (failed)
		throwWithCleanup(primary, closeFailed ? [cleanup] : [], "SQLite raw descriptor operation and close both failed.");
	if (closeFailed) throw cleanup;
	return result;
}
class FailedConstructionCleanupOwner {
	#database: Database | undefined;
	readonly #filePath: string;
	readonly #state: ConstructionCleanupState;
	readonly #capacity: AuthorityCapacityAdmission | undefined;
	readonly #statements: readonly { finalize(): void }[];
	readonly #finalizedStatements: WeakSet<object>;
	#physicallyClosed: boolean;

	constructor(
		database: Database | undefined,
		filePath: string,
		state: ConstructionCleanupState,
		capacity: AuthorityCapacityAdmission | undefined,
		statements: readonly { finalize(): void }[],
		finalizedStatements: WeakSet<object>,
	) {
		this.#database = database;
		this.#filePath = filePath;
		this.#state = state;
		this.#capacity = capacity;
		this.#statements = statements;
		this.#finalizedStatements = finalizedStatements;
		this.#physicallyClosed = database === undefined;
	}

	retry(): unknown[] {
		const failures: unknown[] = [];
		let admissionReady = true;
		try {
			this.#capacity?.prepareClose();
		} catch (error) {
			failures.push(error);
			admissionReady = false;
		}
		for (const descriptor of this.#state.descriptors) {
			this.#state.descriptors.delete(descriptor);
			try {
				fs.closeSync(descriptor);
			} catch (error) {
				// Linux can consume the descriptor before reporting a close error; its integer is no longer retryable.
				if (!failures.includes(error)) failures.push(error);
			}
		}
		if (admissionReady && this.#database && !this.#physicallyClosed) {
			const finalizationFailures = finalizeStatements(this.#statements, this.#finalizedStatements);
			for (const error of finalizationFailures) if (!failures.includes(error)) failures.push(error);
			if (finalizationFailures.length === 0) {
				try {
					this.#database.close(true);
					this.#physicallyClosed = true;
					this.#database = undefined;
				} catch (error) {
					if (!failures.includes(error)) failures.push(error);
				}
			}
		}
		if (admissionReady && this.#state.descriptors.size === 0 && this.#physicallyClosed && this.#state.created)
			failures.push(...removeCreatedArtifacts(this.#filePath));
		return failures;
	}
}

export class SqliteAuthorityConstructionError extends AggregateError {
	readonly constructionError: unknown;
	readonly #cleanupOwner: FailedConstructionCleanupOwner;

	constructor(
		constructionError: unknown,
		cleanupErrors: readonly unknown[],
		cleanupOwner: FailedConstructionCleanupOwner,
	) {
		const errors: unknown[] = [constructionError];
		for (const error of cleanupErrors) if (!errors.includes(error)) errors.push(error);
		super(errors, "SQLite authority construction failed before physical cleanup completed.", {
			cause: constructionError,
		});
		this.name = "SqliteAuthorityConstructionError";
		this.constructionError = constructionError;
		this.#cleanupOwner = cleanupOwner;
	}

	get cleanupErrors(): readonly unknown[] {
		return this.errors.slice(1);
	}

	cleanup(): void {
		let failures: unknown[];
		try {
			failures = this.#cleanupOwner.retry();
		} catch (error) {
			failures = [error];
		}
		for (const error of failures) if (!this.errors.includes(error)) this.errors.push(error);
		if (failures.length) throw this;
	}
}

function json(value: unknown, label: string): string {
	canonicalDurableSha256(value);
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError(`${label} is not JSON serializable.`);
	return serialized;
}

function parse<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error(`SQLite authority ${label} contains invalid JSON.`, { cause: error });
	}
}

function rowKey(domain: AuthorityDomain, record: AuthorityRecordMap[AuthorityDomain]): AuthorityKey {
	if (record.kind !== domain) throw new TypeError(`SQLite authority ${domain} received ${record.kind}.`);
	const key = authorityRecordKey(record as DurableRegistryRecord);
	exactKey(domain, key);
	if (key.some(component => component === ""))
		throw new TypeError(`SQLite authority ${domain} key has an empty component.`);
	return key;
}

function rowBindings(domain: AuthorityDomain, row: AuthorityRow): readonly SQLQueryBindings[] {
	if (row.record.kind !== domain)
		throw new TypeError(`SQLite authority domain ${domain} received ${row.record.kind}.`);
	if (!Number.isSafeInteger(row.version) || row.version < 1)
		throw new TypeError("Authority row version must be a positive safe integer.");
	rowKey(domain, row.record);
	json(row.record, `${domain} record`);
	const values = sqliteAuthorityRowValues(row);
	return rowColumns(domain).map(column => values[column] as SQLQueryBindings);
}

function rowColumns(domain: AuthorityDomain): readonly string[] {
	return [
		"order_key",
		"version",
		"wrapper_order",
		...SQLITE_AUTHORITY_DOMAINS[domain].columns.map(([column]) => column),
		"record",
	];
}

function upsertSql(domain: AuthorityDomain): string {
	const columns = rowColumns(domain);
	return `INSERT INTO ${SQLITE_AUTHORITY_DOMAINS[domain].table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (order_key) DO UPDATE SET ${columns
		.slice(1)
		.map(column => `${column}=excluded.${column}`)
		.join(", ")}`;
}

// Key component types per domain: true marks a positive-integer component, false a string one.
const KEY_SHAPES: Readonly<Record<AuthorityDomain, readonly boolean[]>> = {
	root: [false],
	actor: [false],
	construction: [false, false, true],
	gate: [false],
	operation: [false, false, false],
	transition: [false, false],
	resource: [false, true, false],
	"local-entry": [false, false, true],
	"local-head": [false],
};

function exactKey(domain: AuthorityDomain, key: AuthorityKey): readonly SQLQueryBindings[] {
	const shape = KEY_SHAPES[domain];
	if (key.length !== shape.length)
		throw new TypeError(`SQLite authority ${domain} requires a ${shape.length}-part key.`);
	for (let index = 0; index < shape.length; index++) {
		const value = key[index];
		if (shape[index] ? !Number.isSafeInteger(value) || (value as number) < 1 : typeof value !== "string") {
			throw new TypeError(`SQLite authority ${domain} key component ${index + 1} has an invalid type.`);
		}
	}
	return key as readonly SQLQueryBindings[];
}

function receiptKey(frame: AuthorityCommitFrame): string {
	return `receipt:${JSON.stringify([frame.receipt.incarnation, frame.receipt.ownerEpoch, frame.receipt.requestId])}`;
}

function verifyFrame(frame: AuthorityCommitFrame, previousHash?: string): AuthorityMetaUpdate {
	validateAuthorityFrame(frame, previousHash);
	const receiptDelta = frame.controls.find(change => change.key === receiptKey(frame));
	if (
		!receiptDelta ||
		receiptDelta.deleted ||
		canonicalDurableSha256(receiptDelta.value) !== canonicalDurableSha256(frame.receipt)
	)
		throw new Error("SQLite authority frame must carry its exact incarnation-scoped receipt control.");
	const meta = frame.controls.find(change => change.key === "meta");
	if (!meta || meta.deleted || !meta.value || typeof meta.value !== "object")
		throw new Error("SQLite authority frame must carry its updated meta control.");
	if (Object.hasOwn(meta.value, "headHash")) throw new Error("SQLite authority meta frame delta must omit headHash.");
	const metaValue = meta.value as AuthorityMetaUpdate;
	if (
		metaValue.revision !== frame.revision ||
		!Number.isSafeInteger(metaValue.generationHighWater) ||
		metaValue.generationHighWater < 0
	)
		throw new Error("SQLite authority frame meta does not match its revision or generation high-water.");
	const controls = new Set<string>();
	for (const change of frame.controls) {
		if (controls.has(change.key)) throw new Error(`SQLite authority frame repeats control key ${change.key}.`);
		controls.add(change.key);
		if (!change.deleted) json(change.value, `control ${change.key}`);
	}
	return metaValue;
}

function verifyReceiptControls(frames: readonly AuthorityCommitFrame[], controls: AuthorityExport["controls"]): void {
	const expected = new Map<string, AuthorityCommitFrame["receipt"]>();
	for (const frame of frames) {
		const key = receiptKey(frame);
		if (expected.has(key))
			throw new Error("SQLite authority retained duplicate receipt identities in commit evidence.");
		expected.set(key, frame.receipt);
		for (const change of frame.controls) {
			if (change.key.startsWith("receipt:") && change.key !== key)
				throw new Error("SQLite authority frame contains a receipt control without matching receipt identity.");
		}
	}
	const actual = new Map<string, unknown>();
	for (const control of controls) {
		if (!control.key.startsWith("receipt:")) continue;
		if (actual.has(control.key)) throw new Error("SQLite authority contains duplicate receipt controls.");
		actual.set(control.key, control.value);
	}
	if (actual.size !== expected.size)
		throw new Error("SQLite authority frame and receipt-control counts do not match.");
	for (const [key, receipt] of expected) {
		if (!actual.has(key) || canonicalDurableSha256(actual.get(key)) !== canonicalDurableSha256(receipt))
			throw new Error("SQLite authority receipt control does not match its retained frame identity.");
	}
}

function verifyExportState(state: AuthorityExport): void {
	if (
		!state ||
		typeof state !== "object" ||
		Array.isArray(state) ||
		state.version !== 2 ||
		!Array.isArray(state.rows) ||
		!Array.isArray(state.controls) ||
		!Array.isArray(state.frames) ||
		!state.sourceIdentity ||
		typeof state.sourceIdentity !== "object" ||
		Array.isArray(state.sourceIdentity) ||
		state.sourceIdentity.format !== 2 ||
		(state.sourceIdentity.backend !== "jsonl" && state.sourceIdentity.backend !== "sqlite") ||
		typeof state.sourceIdentity.owningSessionId !== "string" ||
		state.sourceIdentity.owningSessionId.length === 0 ||
		state.sourceIdentity.owningSessionId.includes("\0") ||
		typeof state.sourceIdentity.incarnation !== "string" ||
		state.sourceIdentity.incarnation.length === 0 ||
		state.sourceIdentity.incarnation.includes("\0") ||
		!Number.isSafeInteger(state.revision) ||
		state.revision < 0 ||
		!Number.isSafeInteger(state.generationHighWater) ||
		state.generationHighWater < 0 ||
		!HASH_PATTERN.test(state.headHash)
	)
		throw new Error("SQLite authority export has invalid header metadata.");
	const currentRows = new Map<string, AuthorityRow>();
	// Local entries by `localId` then `version` (both part of a local entry's key, so a row never changes bucket), so
	// validating each frame reads only its own version's entries instead of every row (O(frames x rows) before).
	const localEntries = new Map<string, Map<number, Set<string>>>();
	const setRow = (row: AuthorityRow): void => {
		const identity = expectationIdentity(row.record.kind, authorityRecordKey(row.record));
		currentRows.set(identity, row);
		if (row.record.kind !== "local-entry") return;
		let versions = localEntries.get(row.record.localId);
		if (!versions) localEntries.set(row.record.localId, (versions = new Map()));
		let identities = versions.get(row.record.version);
		if (!identities) versions.set(row.record.version, (identities = new Set()));
		identities.add(identity);
	};
	const currentControls = new Map<string, unknown>();
	if (state.legacy !== undefined) {
		if (
			!state.legacy ||
			typeof state.legacy !== "object" ||
			Array.isArray(state.legacy) ||
			Object.keys(state.legacy).sort().join("\0") !== "entries\0sourceSha256"
		)
			throw new Error("SQLite authority legacy provenance envelope is invalid.");
		const baseline = authorityExportFromLegacySource(state.sourceIdentity, state.legacy);
		for (const row of baseline.rows) setRow(row);
		for (const control of baseline.controls) currentControls.set(control.key, control.value);
	} else {
		currentControls.set("meta", {
			revision: 0,
			headHash: authorityGenesisHash(),
			generationHighWater: 0,
			status: "ready",
		} satisfies AuthorityMeta);
	}
	const frameState: AuthorityFrameState = Object.freeze({
		get<D extends AuthorityDomain>(domain: D, key: AuthorityKey): AuthorityRow<AuthorityRecordMap[D]> | undefined {
			return currentRows.get(expectationIdentity(domain, key)) as AuthorityRow<AuthorityRecordMap[D]> | undefined;
		},
		getControl: (key: string): unknown => currentControls.get(key),
		*localEntriesAt(localId: string, version: number) {
			for (const identity of localEntries.get(localId)?.get(version) ?? []) {
				const row = currentRows.get(identity);
				if (row?.record.kind === "local-entry") yield row as AuthorityRow<AuthorityRecordMap["local-entry"]>;
			}
		},
	});
	let previousHash = authorityGenesisHash();
	let previousRevision = 0;
	const frames: readonly AuthorityCommitFrame[] = state.frames;
	for (const frame of frames) {
		const metaUpdate = verifyFrame(frame, previousHash);
		if (frame.revision !== previousRevision + 1)
			throw new Error("SQLite authority frame revisions are discontinuous.");
		validateAuthorityFrameState(frame, frameState);
		for (const row of frame.changes) setRow(row);
		const controls: readonly AuthorityControlChange[] = frame.controls;
		for (const change of controls) {
			if (change.key === "meta") {
				currentControls.set("meta", { ...metaUpdate, headHash: frame.hash } satisfies AuthorityMeta);
			} else if (change.deleted) {
				currentControls.delete(change.key);
			} else {
				currentControls.set(change.key, change.value);
			}
		}
		previousHash = frame.hash;
		previousRevision = frame.revision;
	}
	if (state.revision !== previousRevision || state.headHash !== previousHash)
		throw new Error("SQLite authority frame history does not match export revision or head hash.");
	const meta = currentControls.get("meta") as AuthorityMeta | undefined;
	if (
		!meta ||
		meta.revision !== state.revision ||
		meta.generationHighWater !== state.generationHighWater ||
		meta.headHash !== state.headHash
	)
		throw new Error("SQLite authority metadata does not match reconstructed frame and legacy evidence.");
	verifyReceiptControls(frames, state.controls);
	if (state.rows.length !== currentRows.size)
		throw new Error("SQLite authority current row count disagrees with retained evidence.");
	const seenRows = new Set<string>();
	for (const row of state.rows) {
		validateDurableRegistryRecord(row.record);
		const identity = expectationIdentity(row.record.kind, authorityRecordKey(row.record));
		const expected = currentRows.get(identity);
		if (!expected || seenRows.has(identity) || canonicalDurableSha256(row) !== canonicalDurableSha256(expected))
			throw new Error(`SQLite authority current ${row.record.kind} row disagrees with retained evidence.`);
		seenRows.add(identity);
	}
	if (state.controls.length !== currentControls.size)
		throw new Error("SQLite authority current control count disagrees with retained evidence.");
	const seenControls = new Set<string>();
	for (const control of state.controls) {
		if (
			seenControls.has(control.key) ||
			!currentControls.has(control.key) ||
			canonicalDurableSha256(control.value) !== canonicalDurableSha256(currentControls.get(control.key))
		)
			throw new Error(`SQLite authority current control ${control.key} disagrees with retained evidence.`);
		seenControls.add(control.key);
	}
}

function openPrivateFile(filePath: string, create: boolean, state: ConstructionCleanupState): boolean {
	if (create) {
		let createdDescriptor: number | undefined;
		try {
			createdDescriptor = fs.openSync(
				filePath,
				fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | NO_FOLLOW,
				0o600,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (createdDescriptor !== undefined) {
			state.created = true;
			withRawDescriptor(createdDescriptor, state, descriptor => {
				if (!fs.fstatSync(descriptor).isFile()) throw new Error("SQLite authority path is not a regular file.");
				fs.fchmodSync(descriptor, 0o600);
			});
			return true;
		}
	}
	let descriptor: number;
	try {
		descriptor = fs.openSync(filePath, fs.constants.O_RDWR | NO_FOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Selected SQLite authority store is missing: ${filePath}.`, { cause: error });
		}
		throw error;
	}
	// An existing store keeps its mode until its header and version are verified supported.
	withRawDescriptor(descriptor, state, opened => {
		if (!fs.fstatSync(opened).isFile()) throw new Error("SQLite authority path is not a regular file.");
	});
	return false;
}

function restrictExistingFile(filePath: string, state: ConstructionCleanupState): void {
	withRawDescriptor(fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW), state, opened => {
		if (!fs.fstatSync(opened).isFile()) throw new Error("SQLite authority path is not a regular file.");
		fs.fchmodSync(opened, 0o600);
	});
}

/**
 * Connection setup when capacity is off (the default) or the store is opened offline. It runs on any
 * SQLite that Bun loads, including the macOS system library, so it drops the capacity-only proofs
 * (source-pinned 3.53.4 allocator, TEMP_STORE build, Linux x86_64 ABI and VFS readback). It keeps the
 * page format capacity assumes, so a root created here can later open with OMP_JOURNALING_CAPACITY=xfs,
 * and the live owner keeps single-writer exclusive locking. WAL, FULL sync, foreign keys and the busy
 * timeout are applied and read back by the driver for every connection.
 */
export function configurePortableAuthoritySqlite(
	database: Database,
	liveOwner: boolean,
	platform: NodeJS.Platform = process.platform,
): void {
	for (const [pragma, expected] of [
		["page_size", 4_096],
		["auto_vacuum", 0],
		["encoding", "UTF-8"],
	] as const) {
		const row = database.query<Record<string, number | string>, []>(`PRAGMA ${pragma}`).get();
		if (!row || Object.values(row)[0] !== expected)
			throw new Error(
				`SQLite authority requires ${pragma}=${expected}; this SQLite build or store reports ${row ? String(Object.values(row)[0]) : "nothing"}.`,
			);
	}
	// macOS fsync(2) leaves data in the drive cache; SQLite issues F_FULLFSYNC for commits and checkpoints only
	// when asked, so darwin gets the same power-loss durability as Linux FULL sync.
	if (fullFsyncRequired(platform)) {
		database.exec("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON");
		const fullfsync = database.query<{ fullfsync: number }, []>("PRAGMA fullfsync").get()?.fullfsync;
		const checkpoint = database
			.query<{ checkpoint_fullfsync: number }, []>("PRAGMA checkpoint_fullfsync")
			.get()?.checkpoint_fullfsync;
		if (fullfsync !== 1 || checkpoint !== 1)
			throw new Error("SQLite authority on darwin did not retain fullfsync and checkpoint_fullfsync.");
	}
	if (!liveOwner) return;
	database.exec("PRAGMA locking_mode=EXCLUSIVE");
	if (database.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()?.locking_mode !== "exclusive")
		throw new Error("SQLite authority live owner did not retain exclusive locking mode.");
}

/**
 * Proves at open that a portable live owner holds SQLite's exclusive lock, instead of trusting the lazily applied
 * locking_mode. A worker that crashed or was terminated can still have its connection finalized by native teardown
 * (checkpoint and WAL delete); that stays serialized only while the live owner holds the lock, which is
 * process-scoped and also covers in-process connections through SQLite's inode table. BEGIN EXCLUSIVE takes the
 * lock (locking_mode=EXCLUSIVE keeps it after COMMIT), and a second read-only connection in this process must then
 * be refused with SQLITE_BUSY. The capacity path proves the same with SQLITE_FCNTL_LOCKSTATE, which needs a debug
 * build the portable path cannot assume.
 */
function proveExclusiveSqliteLock(database: Database, filePath: string): void {
	database.exec("BEGIN EXCLUSIVE; COMMIT");
	let outcome: string;
	const probe = new Database(filePath, { readonly: true });
	try {
		probe.exec("PRAGMA busy_timeout=0");
		probe.query("SELECT count(*) FROM sqlite_master").get();
		outcome = "a second connection could read the store";
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		outcome =
			code === "SQLITE_BUSY" ? "" : `the lock probe failed with ${typeof code === "string" ? code : String(error)}`;
	} finally {
		probe.close();
	}
	if (outcome)
		throw new Error(
			`SQLite authority live owner could not prove it holds the exclusive lock on ${filePath}: ${outcome}.`,
		);
}

function validateExistingHeader(
	filePath: string,
	state: ConstructionCleanupState,
	capacity = false,
	newlyCreated = false,
): void {
	let descriptor: number;
	try {
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !newlyCreated) return;
		throw error;
	}
	withRawDescriptor(descriptor, state, opened => {
		if (!fs.fstatSync(opened).isFile()) throw new Error("SQLite authority path is not a regular file.");
		const header = Buffer.alloc(100);
		const read = fs.readSync(opened, header, 0, header.length, 0);
		// Offline configuration does not create a header for a newly created empty file.
		if (newlyCreated && !capacity && read === 0) return;
		if (read < 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0")
			throw new Error("Selected SQLite authority store has an invalid native header.");
		const pageSize = header.readUInt16BE(16);
		const reservedBytes = header[20];
		const schemaFormat = header.readUInt32BE(44);
		const largestRootPage = header.readUInt32BE(52);
		const encoding = header.readUInt32BE(56);
		const userVersion = header.readUInt32BE(60);
		const applicationId = header.readUInt32BE(68);
		if (newlyCreated) {
			if (
				applicationId !== 0 ||
				userVersion !== 0 ||
				(capacity &&
					(pageSize !== 4_096 ||
						reservedBytes !== 0 ||
						schemaFormat !== 0 ||
						encoding !== 0 ||
						largestRootPage !== 0))
			)
				throw new Error("New SQLite authority store has an unexpected pre-initialization header.");
			return;
		}
		if (
			capacity &&
			(pageSize !== 4_096 || reservedBytes !== 0 || schemaFormat !== 4 || encoding !== 1 || largestRootPage !== 0)
		)
			throw new Error(
				"SQLite authority capacity requires format-4, UTF-8, zero-reserve-byte 4KiB pages without auto-vacuum",
			);
		if (applicationId !== SQLITE_AUTHORITY_APPLICATION_ID || userVersion !== SQLITE_AUTHORITY_SCHEMA_VERSION)
			throw new SqliteAuthorityUnsupportedVersionError(filePath, applicationId, userVersion);
	});
}
function isOpen(domain: AuthorityDomain): string | undefined {
	switch (domain) {
		case "root":
			return "state = 'active'";
		case "actor":
			return "state IN ('active', 'parked')";
		case "construction":
			return "phase NOT IN ('activated', 'abandoned')";
		case "gate":
			return "phase IN ('open', 'quiescing', 'quiesced')";
		case "operation":
		case "resource":
			return "phase IN ('intent', 'effect', 'committed')";
		case "transition":
			return "phase NOT IN ('retired', 'recovered')";
		case "local-entry":
			return "phase IN ('intent', 'effect')";
		case "local-head":
			return "phase = 'current'";
	}
}

export class SqliteAuthorityPersistence implements AuthorityPersistence {
	readonly identity: AuthorityIdentity;
	readonly #database: Database;
	readonly #capacity: AuthorityCapacityAdmission | undefined;
	readonly #statements = new Map<AuthorityDomain, DomainStatements>();
	readonly #scanStatements = new Map<string, Statement<StoredRow, SQLQueryBindings[]>>();
	#closed = false;
	#inTransaction = false;
	#stagedFrame: AuthorityCommitFrame | undefined;
	#deferredCloseFrame: AuthorityCommitFrame | undefined;
	#unavailableError: unknown;
	#finalizedStatements = new WeakSet<object>();
	#closeError: unknown;
	#closeFailed = false;
	#group: SqliteAuthorityGroup | undefined;
	readonly #offlineInspection: AuthorityDriverOptions["offlineInspection"];
	#offlineScratch: AuthorityScratch | undefined;
	#offlineView: AuthorityExportView | undefined;

	/*
	 * Group commit: one BEGIN IMMEDIATE ... COMMIT spans the group, and each member runs inside its own
	 * SAVEPOINT. With journal_mode=WAL and synchronous=FULL, a COMMIT appends the transaction's dirty pages to
	 * the WAL and fsyncs it before returning, so the single group COMMIT is the one durable sync for all
	 * members; nothing is durable (or readable by any other connection) before it, and SQLite never writes a
	 * partial transaction, so the group is all-or-nothing on a crash. A member's refusal is undone by
	 * ROLLBACK TO its savepoint, which leaves earlier members' writes intact. A deferred-sync design would
	 * need synchronous=NORMAL (unsynced WAL commits that a power loss can drop after acknowledgement), which
	 * the authority contract forbids, so one transaction with savepoints is the only FULL-sync grouping.
	 */
	readonly groupCommit: AuthorityGroupCommit = (() => {
		const driver = this;
		return Object.freeze({
			get open(): boolean {
				return driver.#group !== undefined;
			},
			begin: (): void => driver.#beginGroup(),
			sync: (): void => driver.#syncGroup(),
		});
	})();

	/**
	 * `seedStream` creates the store from an already verified export read in pieces (an offline conversion); it
	 * writes exactly what `options.seed` would, in the same order, without holding the export.
	 */
	constructor(options: AuthorityDriverOptions, seedStream?: AuthoritySeedStream) {
		if (
			options.identity.backend !== "sqlite" ||
			options.identity.format !== 2 ||
			!options.identity.owningSessionId ||
			options.identity.owningSessionId.includes("\0") ||
			!options.identity.incarnation ||
			options.identity.incarnation.includes("\0")
		)
			throw new TypeError("SQLite authority requires a valid format-2 SQLite identity.");
		if (!path.isAbsolute(options.path)) throw new TypeError("SQLite authority path must be absolute.");
		if (options.seed && !options.create)
			throw new TypeError("SQLite authority seed is valid only when creating a new store.");
		if (seedStream && (!options.create || options.seed || options.capacity))
			throw new TypeError(
				"A streamed SQLite authority seed is valid only when creating a new offline store without another seed.",
			);
		if (options.offlineInspection && (options.create || options.capacity || options.liveOwner))
			throw new TypeError("SQLite offline inspection opens an existing store without capacity or live ownership.");
		this.identity = Object.freeze({ ...options.identity });
		this.#offlineInspection = options.offlineInspection;
		const filePath = path.resolve(options.path);
		const cleanupState: ConstructionCleanupState = { descriptors: new Set(), closeFailures: [], created: false };
		this.#capacity = options.capacity
			? new AuthorityCapacityAdmission(filePath, this.identity, options.capacity)
			: undefined;
		let created = false;
		let database: Database | undefined;
		try {
			this.#capacity?.initialize([], undefined);
			created = openPrivateFile(filePath, options.create, cleanupState);
			this.#capacity?.fundBootstrap({
				jsonlBytes: 0,
				sqliteDatabaseBytes: 0,
				sqliteWalBytes: 32 + 2 * 4_120,
				sqliteShmBytes: 32_768,
			});
			database = new Database(filePath, { create: false, readwrite: true, strict: true });
			this.#database = database;
			if (options.capacity !== undefined) configureAuthoritySqliteCapacity(database, true);
			else configurePortableAuthoritySqlite(database, options.liveOwner === true);
			database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
			validateExistingHeader(filePath, cleanupState, options.capacity !== undefined, created);
			const applicationRow = database.query<{ application_id: number }, []>("PRAGMA application_id").get();
			const userVersionRow = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
			if (
				!applicationRow ||
				!Number.isSafeInteger(applicationRow.application_id) ||
				!userVersionRow ||
				!Number.isSafeInteger(userVersionRow.user_version)
			)
				throw new Error("SQLite authority application or schema PRAGMA returned invalid identity values.");
			const applicationId = applicationRow.application_id;
			const userVersion = userVersionRow.user_version;
			if (created) {
				this.#capacity?.fundBootstrap(authoritySqliteBootstrapDebt(options.seed), database);
				database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
				database.exec(
					`PRAGMA application_id=${SQLITE_AUTHORITY_APPLICATION_ID}; PRAGMA user_version=${SQLITE_AUTHORITY_SCHEMA_VERSION};`,
				);
				database.exec("BEGIN IMMEDIATE");
				try {
					database.exec(SQLITE_AUTHORITY_SCHEMA);
					this.#prepareStatements();
					this.#initialize(options, seedStream);
					database.exec("COMMIT");
					const checkpoint = database
						.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
						.get();
					if (!checkpoint || checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed)
						throw new Error("SQLite authority schema header checkpoint did not complete.");
					validateExistingHeader(filePath, cleanupState, options.capacity !== undefined);
				} catch (error) {
					try {
						database.exec("ROLLBACK");
					} catch (rollbackError) {
						throwWithCleanup(error, [rollbackError], "SQLite authority initialization and rollback both failed.");
					}
					throw error;
				}
			} else if (
				applicationId !== SQLITE_AUTHORITY_APPLICATION_ID ||
				userVersion !== SQLITE_AUTHORITY_SCHEMA_VERSION
			) {
				throw new SqliteAuthorityUnsupportedVersionError(filePath, applicationId, userVersion);
			}
			if (!created) restrictExistingFile(filePath, cleanupState);
			this.#verifyIdentity();
			this.#configureAndVerify();
			if (!created) this.#prepareStatements();
			const meta = this.getControl("meta") as AuthorityMeta | undefined;
			if (!meta || !Number.isSafeInteger(meta.revision) || meta.revision < 0 || !HASH_PATTERN.test(meta.headHash))
				throw new Error("Selected SQLite authority store has invalid meta control state.");
			if (options.capacity === undefined && options.liveOwner === true) proveExclusiveSqliteLock(database, filePath);
			this.#capacity?.initialize(this.#capacityRecords(), database, this.#capacityClaims());
			// The reads above created `-wal` (SQLite opens it on the first read transaction). COMMIT fsyncs that file
			// but never the directory entry naming it, which POSIX needs for acknowledged commits to survive a crash.
			fsyncDirectorySync(path.dirname(filePath));
		} catch (error) {
			const statements = [
				...Array.from(this.#statements.values()).flatMap(entry => [entry.get, entry.upsert]),
				...this.#scanStatements.values(),
			];
			const cleanupOwner = new FailedConstructionCleanupOwner(
				database,
				filePath,
				cleanupState,
				this.#capacity,
				statements,
				this.#finalizedStatements,
			);
			const cleanup = cleanupOwner.retry();
			if (cleanupState.closeFailures.length || cleanup.length)
				throw new SqliteAuthorityConstructionError(error, cleanup, cleanupOwner);
			throw error;
		}
	}

	transaction<T>(run: () => T): T {
		if (this.#group) return this.#groupMember(this.#group, run);
		this.#assertOpen();
		if (this.#inTransaction) throw new Error("SQLite authority transactions cannot be nested.");
		this.#capacity?.reconcileBeforeTransaction(this.#database);
		this.#database.exec("BEGIN IMMEDIATE");
		this.#inTransaction = true;
		this.#stagedFrame = undefined;
		let commitAttempted = false;
		let commitFrame: AuthorityCommitFrame | undefined;
		let result: T;
		try {
			result = run();
			commitFrame = this.#stagedFrame;
			if (commitFrame) this.#applyFrame(commitFrame);
			commitAttempted = true;
			this.#database.exec("COMMIT");
		} catch (error) {
			const capacityFrame = commitFrame ?? this.#stagedFrame;
			let rollbackError: unknown;
			try {
				this.#database.exec("ROLLBACK");
			} catch (failure) {
				rollbackError = failure;
			} finally {
				this.#inTransaction = false;
				this.#stagedFrame = undefined;
			}
			let capacityError: unknown;
			if (capacityFrame) {
				try {
					this.#capacity?.aborted(capacityFrame, commitAttempted || rollbackError !== undefined, this.#database);
				} catch (failure) {
					capacityError = failure;
				}
			}
			if (commitAttempted) {
				const unknown = new SQLiteUnknownCommitOutcomeError(commitFrame, error, rollbackError);
				this.#unavailableError = unknown;
				throw unknown;
			}
			if (rollbackError !== undefined) this.#unavailableError = rollbackError;
			if (capacityError !== undefined)
				throwWithCleanup(
					error,
					[capacityError],
					"SQLite authority rollback completed but capacity reconciliation failed.",
				);
			throw error;
		}
		this.#inTransaction = false;
		this.#stagedFrame = undefined;
		if (commitFrame === this.#deferredCloseFrame) this.#deferredCloseFrame = undefined;
		if (commitFrame) {
			try {
				this.#capacity?.committed(commitFrame, this.#database);
			} catch (error) {
				// The COMMIT is durable but its reserve settlement is not: there is nothing to roll back, so the
				// outcome is reported unknown and the driver stops admitting rather than writing on an unsettled reserve.
				this.#capacity?.aborted(commitFrame, true, this.#database);
				const unknown = new SQLiteUnknownCommitOutcomeError(commitFrame, error, undefined);
				this.#unavailableError = unknown;
				throw unknown;
			}
		}
		return result;
	}
	#beginGroup(): void {
		this.#assertOpen();
		if (this.#inTransaction || this.#group)
			throw new Error("SQLite authority groups cannot be nested or opened inside a transaction.");
		this.#capacity?.reconcileBeforeTransaction(this.#database);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#capacity?.beginGroup();
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch (rollbackError) {
				throwWithCleanup(error, [rollbackError], "SQLite authority group admission and rollback both failed.");
			}
			throw error;
		}
		this.#group = { frames: [], prepared: 0 };
	}

	#groupMember<T>(group: SqliteAuthorityGroup, run: () => T): T {
		if (group.failure) throw group.failure;
		this.#assertOpen();
		if (this.#inTransaction) throw new Error("SQLite authority transactions cannot be nested.");
		this.#database.exec(`SAVEPOINT ${GROUP_MEMBER_SAVEPOINT}`);
		this.#inTransaction = true;
		this.#stagedFrame = undefined;
		let applied: AuthorityCommitFrame | undefined;
		try {
			const result = run();
			applied = this.#stagedFrame;
			if (applied) this.#applyFrame(applied);
			this.#database.exec(`RELEASE ${GROUP_MEMBER_SAVEPOINT}`);
			this.#inTransaction = false;
			this.#stagedFrame = undefined;
			// Capacity keeps this frame pending; the next member's prepare or the group sync settles it.
			if (applied) group.frames.push(applied);
			return result;
		} catch (error) {
			const capacityFrame = applied ?? this.#stagedFrame;
			this.#inTransaction = false;
			this.#stagedFrame = undefined;
			let undoError: unknown;
			try {
				this.#database.exec(`ROLLBACK TO ${GROUP_MEMBER_SAVEPOINT}`);
				this.#database.exec(`RELEASE ${GROUP_MEMBER_SAVEPOINT}`);
			} catch (failure) {
				undoError = failure;
			}
			// Some errors (for example I/O or a full disk) make SQLite roll back the whole transaction itself.
			if (undoError === undefined && !this.#database.inTransaction)
				undoError = new Error("SQLite rolled back the whole group transaction after a member failure");
			if (undoError !== undefined)
				throw this.#poisonGroup(group, "could not undo a refused member", error, undoError);
			if (capacityFrame) this.#capacity?.groupMemberAborted(capacityFrame);
			throw error;
		}
	}

	/** Earlier members' writes can no longer be trusted: discard the whole transaction, never COMMIT it. */
	#poisonGroup(
		group: SqliteAuthorityGroup,
		reason: string,
		cause: unknown,
		undoError: unknown,
	): SQLiteUnknownGroupOutcomeError {
		let rollbackError: unknown;
		try {
			if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
		} catch (failure) {
			rollbackError = failure;
		}
		const unknown = new SQLiteUnknownGroupOutcomeError(
			group.frames,
			reason,
			cause,
			rollbackError === undefined
				? undoError
				: new AggregateError([undoError, rollbackError], "SQLite group member undo and group rollback both failed"),
		);
		group.failure = unknown;
		this.#unavailableError = unknown;
		this.#capacity?.groupFailed();
		return unknown;
	}

	#syncGroup(): void {
		const group = this.#group;
		if (!group) throw new Error("SQLite authority has no open group to sync.");
		if (this.#inTransaction) throw new Error("SQLite authority cannot sync a group while a member is running.");
		this.#group = undefined;
		if (group.failure) throw group.failure;
		try {
			this.#database.exec("COMMIT");
		} catch (error) {
			let rollbackError: unknown;
			try {
				if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
			} catch (failure) {
				rollbackError = failure;
			}
			const unknown = new SQLiteUnknownGroupOutcomeError(
				group.frames,
				"reached COMMIT but its outcome is unknown",
				error,
				rollbackError,
			);
			this.#unavailableError = unknown;
			this.#capacity?.groupFailed();
			throw unknown;
		}
		try {
			this.#capacity?.groupCommitted(this.#database);
		} catch (error) {
			// As in transaction(): a durable COMMIT whose settlement failed stops admission instead of continuing.
			const unknown = new SQLiteUnknownGroupOutcomeError(
				group.frames,
				"committed but its capacity settlement failed",
				error,
				undefined,
			);
			this.#unavailableError = unknown;
			this.#capacity?.groupFailed();
			throw unknown;
		}
	}

	get<D extends AuthorityDomain>(domain: D, key: AuthorityKey): AuthorityRow<AuthorityRecordMap[D]> | undefined {
		this.#assertOpen();
		const staged = this.#stagedFrame?.changes.find(
			change => change.record.kind === domain && sameKey(rowKey(domain, change.record), key),
		);
		if (staged) return staged as AuthorityRow<AuthorityRecordMap[D]>;
		return this.#persistedRow(domain, key);
	}

	scan<D extends AuthorityDomain>(domain: D, query: AuthorityScan): AuthorityPage<AuthorityRecordMap[D]> {
		this.#assertOpen();
		if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_PAGE_SIZE)
			throw new RangeError(`SQLite authority page limit must be between 1 and ${MAX_PAGE_SIZE}.`);
		const schema = SQLITE_AUTHORITY_DOMAINS[domain];
		const projected = new Set(schema.columns.map(([column]) => column));
		const clauses: string[] = [];
		const bindings: SQLQueryBindings[] = [];
		let empty = false;
		if (query.openOnly) {
			const open = isOpen(domain);
			if (open) clauses.push(open);
		}
		if (query.rootId !== undefined) {
			if (!schema.rootFilter) throw new TypeError(`SQLite authority ${domain} does not support a rootId filter.`);
			// Only actors project root_id (indexed per root); other domains compare their record's JSON value (unindexed, as
			// before). Both comparisons are exact for lone surrogates, which a TEXT binding would replace.
			if (projected.has("root_id")) {
				clauses.push("root_id = ?");
				bindings.push(cesu8Encode(query.rootId));
			} else {
				clauses.push("json_extract(record, '$.rootId') = json_extract(?, '$')");
				bindings.push(JSON.stringify(query.rootId));
			}
		}
		if (query.rootGeneration !== undefined) {
			if (domain !== "actor")
				throw new TypeError(`SQLite authority ${domain} does not support a rootGeneration filter.`);
			clauses.push("root_generation = ?");
			bindings.push(query.rootGeneration);
		}
		if (query.localMatch) {
			if (domain !== "local-entry")
				throw new TypeError(`SQLite authority ${domain} does not support a local match filter.`);
			clauses.push("local_id = ?", "version_key = ?", "head_hash = ?");
			// Stored head hashes are 32-byte digests; a non-hash query value cannot match any of them.
			const headHash = HASH_PATTERN.test(query.localMatch.headHash)
				? Buffer.from(query.localMatch.headHash, "hex")
				: undefined;
			if (!headHash) empty = true;
			bindings.push(cesu8Encode(query.localMatch.localId), query.localMatch.version, headHash ?? null);
		}
		if (query.after !== undefined) {
			const lower = sqliteAuthorityOrderKeyAfter(domain, query.after);
			if (lower === null) empty = true;
			else if (lower) {
				clauses.push("order_key > ?");
				bindings.push(lower);
			}
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		const cacheKey = `${domain}:${where}`;
		let statement = this.#scanStatements.get(cacheKey);
		if (!statement && !empty) {
			statement = this.#database.prepare(
				`SELECT order_key, version, wrapper_order, record FROM ${schema.table}${where} ORDER BY order_key LIMIT ?`,
			);
			this.#scanStatements.set(cacheKey, statement);
		}
		const stagedCount = this.#stagedFrame?.changes.length ?? 0;
		const candidates =
			empty || !statement
				? []
				: statement
						.all(...bindings, query.limit + stagedCount + 1)
						.map(row => this.#storedRow<AuthorityRecordMap[D]>(row));
		const merged = new Map(candidates.map(row => [authorityKey(domain, rowKey(domain, row.record)), row]));
		for (const change of this.#stagedFrame?.changes ?? []) {
			if (change.record.kind !== domain) continue;
			const key = rowKey(domain, change.record);
			const serializedKey = authorityKey(domain, key);
			merged.delete(serializedKey);
			if (query.after !== undefined && compareText(serializedKey, query.after) <= 0) continue;
			if (!this.#matchesScan(domain, change.record, query)) continue;
			merged.set(serializedKey, change as AuthorityRow<AuthorityRecordMap[D]>);
		}
		const rows = [...merged.entries()]
			.filter(([serializedKey]) => query.after === undefined || compareText(serializedKey, query.after) > 0)
			.sort(([left], [right]) => compareText(left, right))
			.slice(0, query.limit + 1);
		const hasMore = rows.length > query.limit;
		const pageRows = rows.slice(0, query.limit).map(([, row]) => row);
		return {
			rows: pageRows,
			...(hasMore && pageRows.length
				? { cursor: authorityKey(domain, rowKey(domain, pageRows.at(-1)!.record)) }
				: {}),
		};
	}

	getControl(key: string): unknown | undefined {
		this.#assertOpen();
		const staged = this.#stagedFrame?.controls.find(change => change.key === key);
		if (staged) {
			if (staged.deleted) return undefined;
			if (key === "meta")
				return {
					...(staged.value as AuthorityMetaUpdate),
					headHash: this.#stagedFrame!.hash,
				} satisfies AuthorityMeta;
			return this.#controlValue(staged);
		}
		return this.#persistedControl(key);
	}
	findReceipt(
		requestId: string,
		incarnation: string,
		payloadHash?: string,
	): AuthorityCommitFrame["receipt"] | undefined {
		this.#assertOpen();
		const stagedFrame = this.#stagedFrame;
		const stagedReceipt = stagedFrame?.receipt;
		const stagedControl = stagedFrame
			? stagedFrame.controls.find(change => change.key === receiptKey(stagedFrame) && !change.deleted)
			: undefined;
		const stagedMatches =
			stagedReceipt &&
			stagedControl &&
			!stagedControl.deleted &&
			stagedReceipt.requestId === requestId &&
			stagedReceipt.incarnation === incarnation &&
			(payloadHash === undefined || stagedReceipt.payloadHash === payloadHash)
				? (stagedControl.value as AuthorityCommitFrame["receipt"])
				: undefined;
		// The receipt index seeks (incarnation, request id); the decimal-text epoch order keeps the earlier choice of
		// the lowest String(epoch) among the few epochs that reused one request id.
		const persisted =
			payloadHash === undefined
				? this.#database
						.query<{ epoch: number; receipt: string }, [Uint8Array, Uint8Array]>(
							"SELECT epoch, receipt FROM authority_frames WHERE incarnation = ? AND request_id = ? ORDER BY CAST(epoch AS TEXT) LIMIT 1",
						)
						.get(cesu8Encode(incarnation), cesu8Encode(requestId))
				: this.#database
						.query<{ epoch: number; receipt: string }, [Uint8Array, Uint8Array, string]>(
							"SELECT epoch, receipt FROM authority_frames WHERE incarnation = ? AND request_id = ? AND json_extract(receipt, '$.payloadHash') = ? ORDER BY CAST(epoch AS TEXT) LIMIT 1",
						)
						.get(cesu8Encode(incarnation), cesu8Encode(requestId), payloadHash);
		const stored = persisted
			? (sqliteAuthorityReceipt(persisted.receipt, {
					incarnation,
					requestId,
					epoch: persisted.epoch,
				}) as unknown as AuthorityCommitFrame["receipt"])
			: undefined;
		if (stagedMatches && (!stored || String(stagedMatches.ownerEpoch) < String(stored.ownerEpoch)))
			return stagedMatches;
		return stored;
	}

	scanControl(prefix: string, after?: string, limit = 100): AuthorityControlPage {
		this.#assertOpen();
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
			throw new RangeError("SQLite authority control page limit is invalid.");
		const clauses = ["order_key >= ?"];
		const bindings: SQLQueryBindings[] = [cesu8Encode(prefix)];
		const upper = cesu8PrefixUpperBound(prefix);
		if (upper) {
			clauses.push("order_key < ?");
			bindings.push(upper);
		}
		if (after !== undefined) {
			clauses.push("order_key > ?");
			bindings.push(cesu8Encode(after));
		}
		const stagedCount = this.#stagedFrame?.controls.length ?? 0;
		const candidates = this.#database
			.query<ControlRow, SQLQueryBindings[]>(
				`SELECT order_key, value FROM authority_controls WHERE ${clauses.join(" AND ")} ORDER BY order_key LIMIT ?`,
			)
			.all(...bindings, limit + stagedCount + 1);
		const merged = new Map(
			candidates.map(row => {
				const key = cesu8Decode(row.order_key);
				return [key, parse<unknown>(row.value, `control ${key}`)] as const;
			}),
		);
		if ("receipt:".startsWith(prefix) || prefix.startsWith("receipt:")) {
			// Receipt controls live in their frame rows; a scan that can reach them reads every one (no caller does).
			for (const row of this.#database
				.query<FrameRow, []>(`SELECT ${FRAME_COLUMNS} FROM authority_frames`)
				.iterate()) {
				const columns = frameColumns(row);
				merged.set(
					receiptControlKey({
						incarnation: columns.incarnation,
						ownerEpoch: columns.epoch,
						requestId: columns.requestId,
					}),
					parse<unknown>(columns.receipt, "receipt"),
				);
			}
		}
		for (const change of this.#stagedFrame?.controls ?? []) {
			merged.delete(change.key);
			if (!change.deleted)
				merged.set(
					change.key,
					change.key === "meta"
						? { ...(change.value as AuthorityMetaUpdate), headHash: this.#stagedFrame!.hash }
						: change.value,
				);
		}
		const controls = [...merged]
			.filter(([key]) => key.startsWith(prefix) && (after === undefined || compareText(key, after) > 0))
			.sort(([left], [right]) => compareText(left, right))
			.slice(0, limit + 1);
		const page = controls.slice(0, limit).map(([key, value]) => ({ key, value }));
		return { controls: page, ...(controls.length > limit && page.length ? { cursor: page.at(-1)!.key } : {}) };
	}

	commit(frame: AuthorityCommitFrame): void {
		this.#assertOpen();
		if (!this.#inTransaction) throw new Error("SQLite authority commits require an active transaction.");
		if (this.#stagedFrame) throw new Error("A SQLite authority transaction can stage exactly one commit frame.");
		verifyFrame(frame);
		try {
			// Encoding first refuses an oversized body before capacity or SQL; the encoded body is cached for the write.
			encodeAuthorityFrameBody(frame, sqliteAuthorityFrameColumns(frame));
			this.#stagedFrame = frame;
			this.#capacity?.prepare(frame, this.#database);
			if (this.#group) this.#group.prepared++;
		} catch (error) {
			// Capacity refused before any SQL mutation. The engine has already moved
			// its in-memory owner to closed, so retain this exact unwritten frame.
			if (frame.command.kind === "owner" && frame.command.owner.phase === "closed") this.#deferredCloseFrame = frame;
			// A later group member is funded against the group's accumulated WAL bound and an unrefilled
			// reserve; only its own group (after the deferred reconciliation) is the serial-equivalent test.
			if (this.#group && this.#group.prepared > 0) throw new AuthorityGroupBoundaryError(error);
			throw error;
		}
	}

	exportState(): AuthorityExport {
		this.#assertOpen();
		if (this.#inTransaction || this.#group)
			throw new Error("SQLite authority export is available only outside a transaction.");
		const controls = this.#database
			.query<ControlRow, []>("SELECT order_key, value FROM authority_controls")
			.all()
			.map(control => ({
				key: cesu8Decode(control.order_key),
				value: parse<unknown>(control.value, "control value"),
			}));
		const meta = controls.find(control => control.key === "meta");
		if (!meta) throw new Error("SQLite authority metadata is missing.");
		const metadata = meta.value as AuthorityMeta;
		const rows: AuthorityRow[] = [];
		for (const domain of Object.keys(SQLITE_AUTHORITY_DOMAINS) as AuthorityDomain[]) {
			const { table } = SQLITE_AUTHORITY_DOMAINS[domain];
			for (const stored of this.#database
				.query<StoredRow, []>(`SELECT order_key, version, wrapper_order, record FROM ${table} ORDER BY order_key`)
				.all())
				rows.push(this.#storedRow(stored));
		}
		rows.sort((left, right) =>
			compareText(
				authorityKey(left.record.kind, authorityRecordKey(left.record)),
				authorityKey(right.record.kind, authorityRecordKey(right.record)),
			),
		);
		const frames: AuthorityCommitFrame[] = [];
		for (const row of this.#database
			.query<FrameRow, []>(`SELECT ${FRAME_COLUMNS} FROM authority_frames ORDER BY revision`)
			.iterate()) {
			const columns = frameColumns(row);
			const frame = decodeAuthorityFrameBody(row.body, columns);
			frames.push(frame);
			controls.push({
				key: receiptControlKey({
					incarnation: columns.incarnation,
					ownerEpoch: columns.epoch,
					requestId: columns.requestId,
				}),
				value: parse<unknown>(columns.receipt, "receipt"),
			});
		}
		controls.sort((left, right) => compareText(left.key, right.key));
		const legacy = this.#database
			.query<{ value: string }, []>("SELECT value FROM authority_legacy_source WHERE id = 1")
			.get();
		return {
			version: 2,
			sourceIdentity: this.identity,
			revision: metadata.revision,
			generationHighWater: metadata.generationHighWater,
			headHash: metadata.headHash,
			rows,
			controls,
			frames,
			...(legacy
				? { legacy: parse<NonNullable<AuthorityExport["legacy"]>>(legacy.value, "legacy provenance") }
				: {}),
		};
	}

	integrityCheck(): void {
		if (this.#offlineInspection) {
			this.#offlineIntegrityCheck(this.#offlineInspection.scratchDirectory);
			return;
		}
		this.#assertOpen();
		const integrity = this.#database.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
			throw new Error(`SQLite authority integrity check failed: ${JSON.stringify(integrity)}.`);
		if (this.#database.query("PRAGMA foreign_key_check").all().length)
			throw new Error("SQLite authority foreign-key integrity check failed.");
		this.#configureAndVerify();
		this.#verifyIdentity();
		for (const row of this.#database
			.query<{ order_key: unknown }, []>("SELECT order_key FROM authority_controls")
			.all()) {
			if (!(row.order_key instanceof Uint8Array))
				throw new Error("SQLite authority control key must be a BLOB value.");
			if (Buffer.compare(row.order_key, cesu8Encode(cesu8Decode(row.order_key))) !== 0)
				throw new Error("SQLite authority control key is not canonically encoded.");
		}
		const exported = this.exportState();
		verifyExportState(exported);
		const frameRows = this.#database
			.query<FrameRow, []>(`SELECT ${FRAME_COLUMNS} FROM authority_frames ORDER BY revision`)
			.all();
		if (frameRows.length !== exported.frames.length)
			throw new Error("SQLite authority frame evidence is incomplete.");
		for (let index = 0; index < exported.frames.length; index++) {
			const frame = exported.frames[index]!;
			const stored = frameColumns(frameRows[index]!);
			const expected = sqliteAuthorityFrameColumns(frame, parse<unknown>(stored.receipt, "receipt"));
			if (
				stored.revision !== frame.revision ||
				Buffer.compare(stored.hash, expected.hash) !== 0 ||
				Buffer.compare(stored.previousHash, expected.previousHash) !== 0 ||
				Buffer.compare(stored.contentHash, expected.contentHash) !== 0 ||
				stored.incarnation !== expected.incarnation ||
				stored.requestId !== expected.requestId ||
				stored.epoch !== expected.epoch ||
				frameRows[index]!.body[0] !== SQLITE_AUTHORITY_CODEC_VERSION
			)
				throw new Error("SQLite authority frame columns disagree with retained commit evidence.");
			if (
				canonicalDurableSha256(parse<unknown>(stored.receipt, "receipt")) !== canonicalDurableSha256(frame.receipt)
			)
				throw new Error("SQLite authority receipt column disagrees with commit evidence.");
		}
		for (const domain of Object.keys(SQLITE_AUTHORITY_DOMAINS) as AuthorityDomain[]) {
			const schema = SQLITE_AUTHORITY_DOMAINS[domain];
			for (const stored of this.#database
				.query<StoredRow, []>(`SELECT * FROM ${schema.table} ORDER BY order_key`)
				.all()) {
				const row = this.#storedRow(stored);
				validateDurableRegistryRecord(row.record);
				if (
					row.record.kind !== domain ||
					!(stored.order_key instanceof Uint8Array) ||
					Buffer.compare(stored.order_key, sqliteAuthorityOrderKey(rowKey(domain, row.record))) !== 0
				)
					throw new Error(`SQLite authority ${domain} row order key disagrees with its typed record.`);
				const projection = sqliteAuthorityProjection(domain, row.record as DurableRegistryRecord);
				schema.columns.forEach(([column], index) => {
					const actual = stored[column] ?? null;
					const expected = projection[index] ?? null;
					const same =
						expected instanceof Uint8Array
							? actual instanceof Uint8Array && Buffer.compare(actual, expected) === 0
							: actual === expected;
					if (!same)
						throw new Error(`SQLite authority ${domain}.${column} projection disagrees with its typed record.`);
				});
			}
		}
	}

	close(): void {
		if (this.#closed) return;
		if (this.#inTransaction || this.#group)
			throw new Error("Cannot close SQLite authority storage during a transaction or an open group.");
		const deferred = this.#deferredCloseFrame;
		if (deferred && this.#unavailableError === undefined) this.transaction(() => this.commit(deferred));
		this.#capacity?.prepareClose();
		const statements = [
			...Array.from(this.#statements.values()).flatMap(entry => [entry.get, entry.upsert]),
			...this.#scanStatements.values(),
		];
		const cleanup = finalizeStatements(statements, this.#finalizedStatements);
		if (cleanup.length) {
			this.#capacity?.closeFailed(cleanup[0]);
			this.#closeFailed = true;
			this.#closeError = cleanup[0];
			throwWithCleanup(
				cleanup[0],
				cleanup.slice(1),
				"SQLite authority statement finalization failed before physical close.",
			);
		}
		try {
			this.#database.close(true);
		} catch (closeError) {
			this.#capacity?.closeFailed(closeError);
			this.#closeFailed = true;
			this.#closeError = closeError;
			throw closeError;
		}
		this.#closed = true;
		this.#statements.clear();
		this.#scanStatements.clear();
		const scratch = this.#offlineScratch;
		this.#offlineScratch = undefined;
		this.#offlineView = undefined;
		scratch?.close();
	}

	/**
	 * integrityCheck() of an offline inspection, in bounded memory: the physical checks and per-row and per-frame
	 * column checks of streamIntegrity(), and verifyExportState's complete logical replay against a rolling state
	 * kept in a scratch file (closed and removed by close()). The verified export is then offlineExportView().
	 */
	#offlineIntegrityCheck(scratchDirectory: string): void {
		if (this.#offlineView) return;
		const reader = this.streamIntegrity();
		this.#offlineScratch ??= new AuthorityScratch(scratchDirectory);
		const state = new AuthorityReplayState(this.#offlineScratch);
		verifyExportReader(reader, state, this.identity);
		this.#offlineView = exportViewOf(reader, state.receipts);
	}

	offlineExportView(): AuthorityExportView {
		this.#assertOpen();
		if (!this.#offlineView)
			throw new Error("SQLite offline export view requires a completed offline integrity check.");
		return this.#offlineView;
	}

	#capacityRecords(): DurableRegistryRecord[] {
		const records: DurableRegistryRecord[] = [];
		for (const domain of Object.keys(SQLITE_AUTHORITY_DOMAINS) as AuthorityDomain[]) {
			let after: string | undefined;
			for (;;) {
				const page = this.scan(domain, { openOnly: true, after, limit: MAX_PAGE_SIZE });
				for (const row of page.rows) records.push(row.record);
				if (!page.cursor) break;
				after = page.cursor;
			}
		}
		return records;
	}

	#capacityClaims(): AuthorityControl[] {
		const controls: AuthorityControl[] = [];
		let after: string | undefined;
		for (;;) {
			const page = this.scanControl("local-claim:", after, MAX_PAGE_SIZE);
			controls.push(...page.controls);
			if (!page.cursor) return controls;
			after = page.cursor;
		}
	}

	#initialize(options: AuthorityDriverOptions, seedStream: AuthoritySeedStream | undefined): void {
		this.#database.run("INSERT INTO authority_identity (id, value) VALUES (1, ?)", [
			json(this.identity, "store identity"),
		]);
		if (options.seed) {
			this.#importSeed(options.seed);
			return;
		}
		if (seedStream) {
			this.#importSeedStream(seedStream);
			return;
		}
		this.#putControl(
			"meta",
			{
				revision: 0,
				headHash: authorityGenesisHash(),
				generationHighWater: 0,
				status: "ready",
			} satisfies AuthorityMeta,
			"initial meta",
		);
	}

	#importSeed(seed: AuthorityExport): void {
		if (seed.version !== 2 || seed.sourceIdentity.owningSessionId !== this.identity.owningSessionId)
			throw new Error("SQLite authority seed does not belong to this owning session or format.");
		verifyExportState(seed);
		const meta = seed.controls.find(control => control.key === "meta")?.value as AuthorityMeta;
		const receiptControls = new Map(
			seed.controls
				.filter(control => control.key.startsWith("receipt:"))
				.map(control => [control.key, control.value] as const),
		);
		for (const control of seed.controls) {
			if (control.key === "meta" || control.key.startsWith("receipt:")) continue;
			this.#putControl(control.key, control.value, `seed control ${control.key}`);
		}
		this.#putControl("meta", meta, "seed meta");
		for (const row of seed.rows) this.#writeRow(row);
		if (seed.legacy)
			this.#database.run("INSERT INTO authority_legacy_source (id, value) VALUES (1, ?)", [
				json(seed.legacy, "legacy provenance"),
			]);
		for (const frame of seed.frames) {
			// The current receipt control keeps the key order the export carried; the frame keeps its own slot.
			const control = receiptControls.get(receiptKey(frame));
			if (control === undefined) throw new Error("SQLite authority seed is missing a receipt control.");
			this.#writeEvidence(frame, control);
		}
	}

	/**
	 * #importSeed for a verified export read in pieces: the same statements in the same order (non-meta, non-receipt
	 * controls in key order, meta, rows, legacy provenance, then each frame with its listed receipt control), so the
	 * resulting file is byte-identical. The caller has already verified the export against its replayed history.
	 */
	#importSeedStream(seed: AuthoritySeedStream): void {
		if (seed.owningSessionId !== this.identity.owningSessionId)
			throw new Error("SQLite authority seed does not belong to this owning session or format.");
		const view = seed.view;
		let meta: unknown;
		for (const control of view.controls()) {
			if (control.key === "meta") meta = control.value;
			if (control.key === "meta" || control.key.startsWith("receipt:")) continue;
			this.#putControl(control.key, control.value, `seed control ${control.key}`);
		}
		if (meta === undefined) throw new Error("SQLite authority seed metadata is missing.");
		this.#putControl("meta", meta, "seed meta");
		for (const row of view.rows()) this.#writeRow(row);
		if (view.legacy)
			this.#database.run("INSERT INTO authority_legacy_source (id, value) VALUES (1, ?)", [
				json(view.legacy, "legacy provenance"),
			]);
		for (const { frame, receipt } of view.frames()) {
			if (receipt === undefined) throw new Error("SQLite authority seed is missing a receipt control.");
			this.#writeEvidence(frame, receipt);
		}
	}

	/**
	 * integrityCheck() for an offline inspection, without the export in memory: the native, settings, identity and
	 * control-key checks run now, and the returned reader applies the per-frame and per-row column checks as it
	 * streams the export. The caller replays the reader (verifyExportReader) for the logical verifyExportState.
	 */
	streamIntegrity(): AuthorityExportReader {
		this.#assertOpen();
		if (this.#inTransaction || this.#group)
			throw new Error("SQLite authority export is available only outside a transaction.");
		const integrity = this.#database.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
			throw new Error(`SQLite authority integrity check failed: ${JSON.stringify(integrity)}.`);
		if (this.#database.query("PRAGMA foreign_key_check").all().length)
			throw new Error("SQLite authority foreign-key integrity check failed.");
		this.#configureAndVerify();
		this.#verifyIdentity();
		for (const row of this.#iterate<{ order_key: unknown }>("SELECT order_key FROM authority_controls")) {
			if (!(row.order_key instanceof Uint8Array))
				throw new Error("SQLite authority control key must be a BLOB value.");
			if (Buffer.compare(row.order_key, cesu8Encode(cesu8Decode(row.order_key))) !== 0)
				throw new Error("SQLite authority control key is not canonically encoded.");
		}
		const meta = this.#persistedControlRow("meta");
		if (!meta) throw new Error("SQLite authority metadata is missing.");
		const metadata = parse<AuthorityMeta>(meta, "control value");
		const legacy = this.#database
			.query<{ value: string }, []>("SELECT value FROM authority_legacy_source WHERE id = 1")
			.get();
		const driver = this;
		return {
			revision: metadata.revision,
			generationHighWater: metadata.generationHighWater,
			headHash: metadata.headHash,
			...(legacy
				? { legacy: parse<NonNullable<AuthorityExport["legacy"]>>(legacy.value, "legacy provenance") }
				: {}),
			*frames() {
				for (const row of driver.#iterate<FrameRow>(
					`SELECT ${FRAME_COLUMNS} FROM authority_frames ORDER BY revision`,
				)) {
					const columns = frameColumns(row);
					const frame = decodeAuthorityFrameBody(row.body, columns);
					const receipt = parse<unknown>(columns.receipt, "receipt");
					const expected = sqliteAuthorityFrameColumns(frame, receipt);
					if (
						columns.revision !== frame.revision ||
						Buffer.compare(columns.hash, expected.hash) !== 0 ||
						Buffer.compare(columns.previousHash, expected.previousHash) !== 0 ||
						Buffer.compare(columns.contentHash, expected.contentHash) !== 0 ||
						columns.incarnation !== expected.incarnation ||
						columns.requestId !== expected.requestId ||
						columns.epoch !== expected.epoch ||
						row.body[0] !== SQLITE_AUTHORITY_CODEC_VERSION
					)
						throw new Error("SQLite authority frame columns disagree with retained commit evidence.");
					if (canonicalDurableSha256(receipt) !== canonicalDurableSha256(frame.receipt))
						throw new Error("SQLite authority receipt column disagrees with commit evidence.");
					yield { frame, receipt };
				}
			},
			*rows() {
				for (const domain of SORTED_DOMAINS) {
					const schema = SQLITE_AUTHORITY_DOMAINS[domain];
					for (const stored of driver.#iterate<StoredRow>(`SELECT * FROM ${schema.table} ORDER BY order_key`)) {
						const row = driver.#storedRow(stored);
						validateDurableRegistryRecord(row.record);
						if (
							row.record.kind !== domain ||
							!(stored.order_key instanceof Uint8Array) ||
							Buffer.compare(stored.order_key, sqliteAuthorityOrderKey(rowKey(domain, row.record))) !== 0
						)
							throw new Error(`SQLite authority ${domain} row order key disagrees with its typed record.`);
						const projection = sqliteAuthorityProjection(domain, row.record as DurableRegistryRecord);
						schema.columns.forEach(([column], index) => {
							const actual = stored[column] ?? null;
							const expected = projection[index] ?? null;
							const same =
								expected instanceof Uint8Array
									? actual instanceof Uint8Array && Buffer.compare(actual, expected) === 0
									: actual === expected;
							if (!same)
								throw new Error(
									`SQLite authority ${domain}.${column} projection disagrees with its typed record.`,
								);
						});
						yield row;
					}
				}
			},
			*controls() {
				for (const control of driver.#iterate<ControlRow>(
					"SELECT order_key, value FROM authority_controls ORDER BY order_key",
				))
					yield { key: cesu8Decode(control.order_key), value: parse<unknown>(control.value, "control value") };
			},
		};
	}

	/** Streams a query through its own statement (never the shared query cache), finalized when the walk ends. */
	*#iterate<T>(sql: string): Generator<T> {
		this.#assertOpen();
		const statement = this.#database.prepare<T, []>(sql);
		try {
			for (const row of statement.iterate()) yield row;
		} finally {
			statement.finalize();
		}
	}

	#persistedControlRow(key: string): string | undefined {
		return this.#database
			.query<{ value: string }, [Uint8Array]>("SELECT value FROM authority_controls WHERE order_key = ?")
			.get(cesu8Encode(key))?.value;
	}

	#putControl(key: string, value: unknown, label: string): void {
		this.#database.run(
			"INSERT INTO authority_controls (order_key, value) VALUES (?, ?) ON CONFLICT(order_key) DO UPDATE SET value=excluded.value",
			[cesu8Encode(key), json(value, label)],
		);
	}

	#verifyIdentity(): void {
		const row = this.#database.query("SELECT value FROM authority_identity WHERE id = 1").get() as IdentityRow | null;
		if (
			!row ||
			canonicalDurableSha256(parse<AuthorityIdentity>(row.value, "store identity")) !==
				canonicalDurableSha256(this.identity)
		)
			throw new Error(
				"Selected SQLite authority store identity does not match the requested session and incarnation.",
			);
	}

	#configureAndVerify(): void {
		this.#database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`);
		const journalMode = this.#database.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
		const synchronous = this.#database.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
		const foreignKeys = this.#database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
		const busyTimeout = this.#database.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
		if (
			!journalMode ||
			typeof journalMode.journal_mode !== "string" ||
			!synchronous ||
			!Number.isSafeInteger(synchronous.synchronous) ||
			!foreignKeys ||
			!Number.isSafeInteger(foreignKeys.foreign_keys) ||
			!busyTimeout ||
			!Number.isSafeInteger(busyTimeout.timeout)
		)
			throw new Error("SQLite authority PRAGMA readback returned invalid setting values.");
		if (
			journalMode.journal_mode.toLowerCase() !== "wal" ||
			synchronous.synchronous !== 2 ||
			foreignKeys.foreign_keys !== 1 ||
			busyTimeout.timeout !== BUSY_TIMEOUT_MS
		)
			throw new Error(
				"SQLite authority connection did not retain WAL, FULL sync, foreign keys and finite busy timeout settings.",
			);
	}

	#prepareStatements(): void {
		for (const domain of Object.keys(SQLITE_AUTHORITY_DOMAINS) as AuthorityDomain[]) {
			const schema = SQLITE_AUTHORITY_DOMAINS[domain];
			this.#statements.set(domain, {
				get: this.#database.prepare(
					`SELECT order_key, version, wrapper_order, record FROM ${schema.table} WHERE order_key = ?`,
				),
				upsert: this.#database.prepare(upsertSql(domain)),
			});
		}
	}

	#domainStatements(domain: AuthorityDomain): DomainStatements {
		const statements = this.#statements.get(domain);
		if (!statements) throw new Error(`SQLite authority ${domain} statements are unavailable.`);
		return statements;
	}

	#persistedRow<D extends AuthorityDomain>(
		domain: D,
		key: AuthorityKey,
	): AuthorityRow<AuthorityRecordMap[D]> | undefined {
		const stored = this.#domainStatements(domain).get.get(
			sqliteAuthorityOrderKey(exactKey(domain, key) as AuthorityKey),
		);
		return stored ? this.#storedRow<AuthorityRecordMap[D]>(stored) : undefined;
	}

	#persistedControl(key: string): unknown | undefined {
		const row = this.#database
			.query<{ value: string }, [Uint8Array]>("SELECT value FROM authority_controls WHERE order_key = ?")
			.get(cesu8Encode(key));
		if (row) return parse<unknown>(row.value, `control ${key}`);
		if (!key.startsWith("receipt:")) return undefined;
		let identity: unknown;
		try {
			identity = JSON.parse(key.slice("receipt:".length));
		} catch {
			return undefined;
		}
		if (
			!Array.isArray(identity) ||
			identity.length !== 3 ||
			typeof identity[0] !== "string" ||
			!Number.isSafeInteger(identity[1]) ||
			typeof identity[2] !== "string"
		)
			return undefined;
		const receipt = this.#database
			.query<{ receipt: string }, [Uint8Array, Uint8Array, number]>(
				"SELECT receipt FROM authority_frames WHERE incarnation = ? AND request_id = ? AND epoch = ?",
			)
			.get(cesu8Encode(identity[0]), cesu8Encode(identity[2]), identity[1] as number);
		return receipt
			? sqliteAuthorityReceipt(receipt.receipt, {
					incarnation: identity[0],
					requestId: identity[2],
					epoch: identity[1] as number,
				})
			: undefined;
	}

	#storedRow<T extends AuthorityRecordMap[AuthorityDomain]>(row: StoredRow): AuthorityRow<T> {
		const record = parse<T>(row.record, "domain row");
		if (row.wrapper_order === 0) return { record, version: row.version };
		if (row.wrapper_order === 1) return { version: row.version, record };
		throw new Error("SQLite authority domain row wrapper order is invalid.");
	}

	#controlValue(change: AuthorityControlChange): unknown {
		return change.deleted ? undefined : change.value;
	}

	#matchesScan(domain: AuthorityDomain, record: AuthorityRecordMap[AuthorityDomain], query: AuthorityScan): boolean {
		const value = record as unknown as Record<string, unknown>;
		if (query.openOnly && !authorityRecordIsOpen(record as AuthorityRecordMap[AuthorityDomain])) return false;
		if (query.rootId !== undefined && value.rootId !== query.rootId) return false;
		if (query.rootGeneration !== undefined && value.rootGeneration !== query.rootGeneration) return false;
		if (
			query.localMatch &&
			(domain !== "local-entry" ||
				value.localId !== query.localMatch.localId ||
				value.version !== query.localMatch.version ||
				value.headHash !== query.localMatch.headHash)
		)
			return false;
		return true;
	}

	#writeRow(row: AuthorityRow): void {
		const domain = row.record.kind as AuthorityDomain;
		this.#domainStatements(domain).upsert.run(...rowBindings(domain, row));
	}

	#writeEvidence(frame: AuthorityCommitFrame, receiptControl?: unknown): void {
		const columns = sqliteAuthorityFrameColumns(frame, receiptControl);
		const row = sqliteAuthorityFrameRow(columns);
		this.#database.run(`INSERT INTO authority_frames (${FRAME_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			row.revision,
			row.incarnation,
			row.request_id,
			row.epoch,
			row.hash,
			row.previous_hash,
			row.content_hash,
			row.receipt,
			encodeAuthorityFrameBody(frame, columns),
		]);
	}

	#applyFrame(frame: AuthorityCommitFrame): void {
		const updatedMeta = verifyFrame(frame);
		const meta = this.#persistedControl("meta") as AuthorityMeta | undefined;
		if (!meta || frame.revision !== meta.revision + 1 || frame.previousHash !== meta.headHash)
			throw new Error("SQLite authority commit revision or previous-hash compare-and-swap failed.");
		const expected = new Map(frame.expected.map(item => [expectationIdentity(item.domain, item.key), item]));
		if (expected.size !== frame.expected.length)
			throw new Error("SQLite authority frame repeats an expected row key.");
		for (const item of frame.expected) {
			const actual = this.#persistedRow(item.domain, item.key)?.version ?? null;
			if (actual !== item.version)
				throw new Error(`SQLite authority expected-row version conflict for ${item.domain}.`);
		}
		const changedKeys = new Set<string>();
		for (const row of frame.changes) {
			const domain = row.record.kind as AuthorityDomain;
			const key = rowKey(domain, row.record);
			const identity = expectationIdentity(domain, key);
			if (changedKeys.has(identity)) throw new Error(`SQLite authority frame repeats ${domain} row changes.`);
			changedKeys.add(identity);
			const expectation = expected.get(identity);
			if (!expectation) throw new Error(`SQLite authority frame omits its ${domain} row expectation.`);
			const current = this.#persistedRow(domain, key);
			if (row.version !== (current?.version ?? 0) + 1)
				throw new Error(`SQLite authority ${domain} row version is not monotonic.`);
		}
		for (const row of frame.changes) this.#writeRow(row);
		for (const change of frame.controls) {
			if (change.key === "meta" || change.key.startsWith("receipt:")) continue;
			if (change.deleted)
				this.#database.run("DELETE FROM authority_controls WHERE order_key = ?", [cesu8Encode(change.key)]);
			else this.#putControl(change.key, change.value, `control ${change.key}`);
		}
		if (updatedMeta.generationHighWater < meta.generationHighWater)
			throw new Error("SQLite authority generation high-water cannot decrease.");
		this.#putControl("meta", { ...updatedMeta, headHash: frame.hash } satisfies AuthorityMeta, "updated meta");
		this.#writeEvidence(frame);
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("SQLite authority persistence is closed.");
		if (this.#closeFailed) throw this.#closeError;
		if (this.#unavailableError !== undefined) throw this.#unavailableError;
	}
}

function sameKey(left: AuthorityKey, right: AuthorityKey): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
function expectationIdentity(domain: AuthorityDomain, key: AuthorityKey): string {
	return `${domain}:${JSON.stringify(key)}`;
}

/** Physical schema version recorded in a SQLite authority file header, or undefined when it is not an authority store. */
export function sqliteAuthorityPhysicalVersion(filePath: string): number | undefined {
	const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
	try {
		if (!fs.fstatSync(descriptor).isFile()) throw new Error("SQLite authority path is not a regular file.");
		const header = Buffer.alloc(100);
		if (
			fs.readSync(descriptor, header, 0, header.length, 0) < 100 ||
			header.toString("ascii", 0, 16) !== "SQLite format 3\0"
		)
			return undefined;
		return header.readUInt32BE(68) === SQLITE_AUTHORITY_APPLICATION_ID ? header.readUInt32BE(60) : undefined;
	} finally {
		fs.closeSync(descriptor);
	}
}

type V3ReceiptRow = {
	body: string;
	body_order: Uint8Array;
	control_order: Uint8Array;
	incarnation_ref: number;
	request_ref: number;
	epoch: number;
};

/*
 * Reads a physical-schema-v3 store into its logical export, for the offline v3 -> v4 conversion only. It opens a
 * private copy (the conversion's disposable inspection copy), checks native integrity and the store identity, decodes
 * the v3 dictionary, receipts and frames, and verifies the complete logical history (hash chain, current rows and
 * controls) exactly as an import does. Hashes are over the logical frame, so the export is the same in any physical
 * schema; nothing in v4 writes this layout.
 */
export function exportSqliteAuthorityV3(filePath: string, identity: AuthorityIdentity): AuthorityExport {
	if (sqliteAuthorityPhysicalVersion(filePath) !== SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION)
		throw new Error("SQLite authority conversion source is not a physical schema v3 authority store.");
	const database = new Database(filePath, { create: false, readwrite: true, strict: true });
	try {
		const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
			throw new Error(`SQLite authority v3 integrity check failed: ${JSON.stringify(integrity)}.`);
		const identityRow = database.query<IdentityRow, []>("SELECT value FROM authority_identity WHERE id = 1").get();
		if (
			!identityRow ||
			canonicalDurableSha256(parse<AuthorityIdentity>(identityRow.value, "store identity")) !==
				canonicalDurableSha256(identity)
		)
			throw new Error("SQLite authority v3 store identity does not match the requested session and incarnation.");
		const dictionary = database.query<{ value: Uint8Array }, [number]>(
			"SELECT value FROM authority_strings WHERE id = ?",
		);
		const stringValue = (id: number): string => {
			const row = dictionary.get(id);
			if (!row) throw new Error("SQLite authority v3 string reference is missing.");
			const decoded: unknown = JSON.parse(Buffer.from(row.value).toString("utf8"));
			if (typeof decoded !== "string")
				throw new Error("SQLite authority v3 exact-string dictionary entry is invalid.");
			return decoded;
		};
		const receiptOf = (row: V3ReceiptRow): AuthorityCommitFrame["receipt"] => {
			const body = parse<Record<string, unknown>>(row.body, "v3 receipt body");
			const order = parse<string[]>(Buffer.from(row.body_order).toString("utf8"), "v3 receipt property order");
			const reconstructed: Record<string, unknown> = {
				...body,
				requestId: stringValue(row.request_ref),
				ownerEpoch: row.epoch,
				incarnation: stringValue(row.incarnation_ref),
			};
			if (
				!Array.isArray(order) ||
				order.length !== Object.keys(reconstructed).length ||
				order.some(key => !Object.hasOwn(reconstructed, key))
			)
				throw new Error("SQLite authority v3 receipt property order is inconsistent.");
			const ordered: Record<string, unknown> = {};
			for (const key of order)
				Object.defineProperty(ordered, key, {
					value: reconstructed[key],
					enumerable: true,
					configurable: true,
					writable: true,
				});
			return ordered as unknown as AuthorityCommitFrame["receipt"];
		};
		const controls = database
			.query<{ key: Uint8Array; value: string }, []>("SELECT key, value FROM authority_controls")
			.all()
			.map(control => {
				const key: unknown = JSON.parse(Buffer.from(control.key).toString("utf8"));
				if (typeof key !== "string") throw new Error("SQLite authority v3 control key is invalid.");
				return { key, value: parse<unknown>(control.value, `v3 control ${key}`) };
			});
		const meta = controls.find(control => control.key === "meta")?.value as AuthorityMeta | undefined;
		if (!meta) throw new Error("SQLite authority v3 metadata is missing.");
		const rows: AuthorityRow[] = [];
		for (const table of Object.values(SQLITE_AUTHORITY_V3_DOMAIN_TABLES)) {
			for (const stored of database
				.query<{ version: number; wrapper_order: number; record: string }, []>(
					`SELECT version, wrapper_order, record FROM ${table}`,
				)
				.all()) {
				const record = parse<DurableRegistryRecord>(stored.record, "v3 domain row");
				if (stored.wrapper_order === 0) rows.push({ record, version: stored.version } as AuthorityRow);
				else if (stored.wrapper_order === 1) rows.push({ version: stored.version, record } as AuthorityRow);
				else throw new Error("SQLite authority v3 domain row wrapper order is invalid.");
			}
		}
		rows.sort((left, right) =>
			compareText(
				authorityKey(left.record.kind, authorityRecordKey(left.record)),
				authorityKey(right.record.kind, authorityRecordKey(right.record)),
			),
		);
		const frames: AuthorityCommitFrame[] = [];
		for (const row of database
			.query<V3ReceiptRow & { frame_body: Uint8Array; revision: number }, []>(
				"SELECT f.revision, f.body AS frame_body, r.body, r.body_order, r.control_order, r.incarnation_ref, r.request_ref, r.epoch FROM authority_frames f JOIN authority_receipts r ON r.revision = f.revision ORDER BY f.revision",
			)
			.iterate()) {
			const receipt = receiptOf(row);
			frames.push(decodeAuthorityFrameV3(row.frame_body, receipt, row.request_ref));
			controls.push({
				key: receiptControlKey(receipt),
				value: decodeAuthorityReceiptControlV3(receipt, row.control_order),
			});
		}
		controls.sort((left, right) => compareText(left.key, right.key));
		const legacy = database
			.query<{ value: string }, []>("SELECT value FROM authority_legacy_source WHERE id = 1")
			.get();
		const exported: AuthorityExport = {
			version: 2,
			sourceIdentity: identity,
			revision: meta.revision,
			generationHighWater: meta.generationHighWater,
			headHash: meta.headHash,
			rows,
			controls,
			frames,
			...(legacy
				? { legacy: parse<NonNullable<AuthorityExport["legacy"]>>(legacy.value, "v3 legacy provenance") }
				: {}),
		};
		verifyExportState(exported);
		return exported;
	} finally {
		database.close(true);
	}
}

/**
 * exportSqliteAuthorityV3 as a reader, for the offline v3 -> v4 conversion of a history too large to hold: the same
 * native-integrity and identity checks, the same decoding, and the same export order. A v3 store's controls and rows
 * are not stored in export order, so they are first spilled, key by key, into `scratch` and read back sorted. The
 * caller replays the reader (verifyExportReader) for the complete logical verification exportSqliteAuthorityV3 runs.
 */
export function openSqliteAuthorityV3Reader(
	filePath: string,
	identity: AuthorityIdentity,
	scratch: AuthorityScratch,
): { readonly reader: AuthorityExportReader; close(): void } {
	if (sqliteAuthorityPhysicalVersion(filePath) !== SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION)
		throw new Error("SQLite authority conversion source is not a physical schema v3 authority store.");
	const database = new Database(filePath, { create: false, readwrite: true, strict: true });
	try {
		const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
			throw new Error(`SQLite authority v3 integrity check failed: ${JSON.stringify(integrity)}.`);
		const identityRow = database.query<IdentityRow, []>("SELECT value FROM authority_identity WHERE id = 1").get();
		if (
			!identityRow ||
			canonicalDurableSha256(parse<AuthorityIdentity>(identityRow.value, "store identity")) !==
				canonicalDurableSha256(identity)
		)
			throw new Error("SQLite authority v3 store identity does not match the requested session and incarnation.");
		const dictionary = database.prepare<{ value: Uint8Array }, [number]>(
			"SELECT value FROM authority_strings WHERE id = ?",
		);
		const stringValue = (id: number): string => {
			const row = dictionary.get(id);
			if (!row) throw new Error("SQLite authority v3 string reference is missing.");
			const decoded: unknown = JSON.parse(Buffer.from(row.value).toString("utf8"));
			if (typeof decoded !== "string")
				throw new Error("SQLite authority v3 exact-string dictionary entry is invalid.");
			return decoded;
		};
		const receiptOf = (row: V3ReceiptRow): AuthorityCommitFrame["receipt"] => {
			const body = parse<Record<string, unknown>>(row.body, "v3 receipt body");
			const order = parse<string[]>(Buffer.from(row.body_order).toString("utf8"), "v3 receipt property order");
			const reconstructed: Record<string, unknown> = {
				...body,
				requestId: stringValue(row.request_ref),
				ownerEpoch: row.epoch,
				incarnation: stringValue(row.incarnation_ref),
			};
			if (
				!Array.isArray(order) ||
				order.length !== Object.keys(reconstructed).length ||
				order.some(key => !Object.hasOwn(reconstructed, key))
			)
				throw new Error("SQLite authority v3 receipt property order is inconsistent.");
			const ordered: Record<string, unknown> = {};
			for (const key of order)
				Object.defineProperty(ordered, key, {
					value: reconstructed[key],
					enumerable: true,
					configurable: true,
					writable: true,
				});
			return ordered as unknown as AuthorityCommitFrame["receipt"];
		};
		const controls = scratch.map();
		let meta: AuthorityMeta | undefined;
		for (const control of database
			.query<{ key: Uint8Array; value: string }, []>("SELECT key, value FROM authority_controls")
			.iterate()) {
			const key: unknown = JSON.parse(Buffer.from(control.key).toString("utf8"));
			if (typeof key !== "string") throw new Error("SQLite authority v3 control key is invalid.");
			const value = parse<unknown>(control.value, `v3 control ${key}`);
			if (!controls.insert(key, control.value)) throw new Error("SQLite authority v3 contains duplicate controls.");
			if (key === "meta") meta = value as AuthorityMeta;
		}
		if (!meta) throw new Error("SQLite authority v3 metadata is missing.");
		const rows = scratch.map();
		for (const table of Object.values(SQLITE_AUTHORITY_V3_DOMAIN_TABLES)) {
			for (const stored of database
				.query<{ version: number; wrapper_order: number; record: string }, []>(
					`SELECT version, wrapper_order, record FROM ${table}`,
				)
				.iterate()) {
				const record = parse<DurableRegistryRecord>(stored.record, "v3 domain row");
				let row: AuthorityRow;
				if (stored.wrapper_order === 0) row = { record, version: stored.version };
				else if (stored.wrapper_order === 1) row = { version: stored.version, record };
				else throw new Error("SQLite authority v3 domain row wrapper order is invalid.");
				if (!rows.insert(authorityKey(record.kind, authorityRecordKey(record)), JSON.stringify(row)))
					throw new Error("SQLite authority v3 contains duplicate row identities.");
			}
		}
		const legacy = database
			.query<{ value: string }, []>("SELECT value FROM authority_legacy_source WHERE id = 1")
			.get();
		const reader: AuthorityExportReader = {
			revision: meta.revision,
			generationHighWater: meta.generationHighWater,
			headHash: meta.headHash,
			...(legacy
				? { legacy: parse<NonNullable<AuthorityExport["legacy"]>>(legacy.value, "v3 legacy provenance") }
				: {}),
			*frames() {
				const statement = database.prepare<V3ReceiptRow & { frame_body: Uint8Array; revision: number }, []>(
					"SELECT f.revision, f.body AS frame_body, r.body, r.body_order, r.control_order, r.incarnation_ref, r.request_ref, r.epoch FROM authority_frames f JOIN authority_receipts r ON r.revision = f.revision ORDER BY f.revision",
				);
				try {
					for (const row of statement.iterate()) {
						const receipt = receiptOf(row);
						yield {
							frame: decodeAuthorityFrameV3(row.frame_body, receipt, row.request_ref),
							receipt: decodeAuthorityReceiptControlV3(receipt, row.control_order),
						};
					}
				} finally {
					statement.finalize();
				}
			},
			*rows() {
				for (const entry of rows.entries()) yield JSON.parse(entry.json) as AuthorityRow;
			},
			*controls() {
				for (const entry of controls.entries()) yield { key: entry.key, value: JSON.parse(entry.json) };
			},
		};
		return { reader, close: () => database.close(true) };
	} catch (error) {
		database.close(true);
		throw error;
	}
}
