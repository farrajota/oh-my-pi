import { Database, type Statement } from "bun:sqlite";
import { createHash, randomUUID, type Hash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalDurableJson, canonicalDurableSha256, validateDurableRegistryRecord } from "../durable-state";
import {
	authorityExportFromLegacySource,
	authorityGenesisHash,
	authorityKey,
	authorityRecordKey,
	compareAuthorityKeys,
	validateAuthorityFrame,
	validateAuthorityFrameState,
	type AuthorityFrameState,
} from "./engine";
import { cesu8Decode, cesu8Encode } from "./sqlite-codec";
import type {
	AuthorityCommitFrame,
	AuthorityControl,
	AuthorityDomain,
	AuthorityExport,
	AuthorityIdentity,
	AuthorityKey,
	AuthorityLegacySource,
	AuthorityMeta,
	AuthorityMetaUpdate,
	AuthorityRecordMap,
	AuthorityRow,
} from "./types";

/*
 * Offline conversions read, verify, hash and write an authority export without holding it. An export is
 * O(history): every committed frame, a receipt control per frame, and (for long-lived roots) every terminal row.
 * Here it is read in exportState() order, one item at a time, from the source store; whatever must be looked up
 * by key or re-read in another order (the rolling replay state, receipts, sort spills) lives in an
 * AuthorityScratch, a private throwaway SQLite file beside the conversion's other private copies. Memory is then
 * the scratch page cache plus one item (a frame is at most the 64 MiB frame bound), independent of history and of
 * the size of the current state. The one exception is legacy v1 provenance: both formats store it as a single
 * value, so it (and the baseline derived from it) is held once per store.
 */

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SCRATCH_COMMIT_EVERY = 20_000;
const SCRATCH_CACHE_KIB = 16 * 1024;

/** One committed frame and the receipt control value its export lists under the frame's receipt key. */
export interface AuthorityStreamFrame {
	readonly frame: AuthorityCommitFrame;
	readonly receipt: unknown;
}

/**
 * An authority export read in bounded pieces: the header fields, legacy provenance and the same rows, non-receipt
 * controls and frames `exportState()` returns, in the same order. Each method may be called more than once.
 */
export interface AuthorityExportReader {
	readonly revision: number;
	readonly generationHighWater: number;
	readonly headHash: string;
	readonly legacy?: AuthorityLegacySource;
	/**
	 * When the export lists its receipt controls separately from its frames (a JSONL seed), their number; the
	 * verifier then proves they are exactly one per frame. Readers that derive each receipt from its frame omit it.
	 */
	readonly receiptControls?: number;
	/** Frames in revision order, each with the receipt control value the export lists for it. */
	frames(): Iterable<AuthorityStreamFrame>;
	/** Current rows in strictly ascending key order. */
	rows(): Iterable<AuthorityRow>;
	/** Current non-receipt controls in strictly ascending key order. */
	controls(): Iterable<AuthorityControl>;
}

/** A verified export as exportState() lists it: rows, every control (receipts included) and frames, in order. */
export interface AuthorityExportView {
	readonly revision: number;
	readonly generationHighWater: number;
	readonly headHash: string;
	readonly legacy?: AuthorityLegacySource;
	rows(): Iterable<AuthorityRow>;
	controls(): Iterable<AuthorityControl>;
	frames(): Iterable<AuthorityStreamFrame>;
}

/** A verified export to create a store from, and the owning session it belongs to. */
export interface AuthoritySeedStream {
	readonly owningSessionId: string;
	readonly view: AuthorityExportView;
}

export function receiptKeyOf(frame: Pick<AuthorityCommitFrame, "request">): string {
	return `receipt:${JSON.stringify([frame.request.incarnation, frame.request.ownerEpoch, frame.request.requestId])}`;
}

function rowKeyOf(row: AuthorityRow): string {
	return authorityKey(row.record.kind, authorityRecordKey(row.record));
}

type Bound = string | number | bigint | Uint8Array | null;

/**
 * A key-ordered map inside an AuthorityScratch. Keys are compared as JavaScript strings (CESU-8 bytes sort in
 * UTF-16 code-unit order), values are JSON text, and an optional (local, version) pair indexes local entries.
 */
export class ScratchMap {
	#size = 0;
	readonly #scratch: AuthorityScratch;
	readonly #get: Statement<{ v: string }, Bound[]>;
	readonly #insert: Statement<unknown, Bound[]>;
	readonly #update: Statement<unknown, Bound[]>;
	readonly #delete: Statement<unknown, Bound[]>;
	readonly #entries: Statement<{ k: Uint8Array; v: string }, Bound[]>;
	readonly #local: Statement<{ v: string }, Bound[]>;
	readonly #clear: Statement<unknown, Bound[]>;
	readonly #copy: Statement<unknown, Bound[]>;

	constructor(
		scratch: AuthorityScratch,
		database: Database,
		readonly space: number,
	) {
		this.#scratch = scratch;
		this.#get = database.prepare("SELECT v FROM entries WHERE space = ? AND k = ?");
		this.#insert = database.prepare(
			"INSERT OR IGNORE INTO entries (space, k, local, lver, v) VALUES (?, ?, ?, ?, ?)",
		);
		this.#update = database.prepare("UPDATE entries SET local = ?, lver = ?, v = ? WHERE space = ? AND k = ?");
		this.#delete = database.prepare("DELETE FROM entries WHERE space = ? AND k = ?");
		this.#entries = database.prepare("SELECT k, v FROM entries WHERE space = ? ORDER BY k");
		// Without statistics the planner prefers the primary key's `space = ?` prefix (a scan of the whole map) over
		// the (space, local, lver) index; a scan per local command would make the replay quadratic.
		this.#local = database.prepare(
			"SELECT v FROM entries INDEXED BY entries_local WHERE space = ? AND local = ? AND lver = ?",
		);
		this.#clear = database.prepare("DELETE FROM entries WHERE space = ?");
		this.#copy = database.prepare(
			"INSERT OR REPLACE INTO entries (space, k, local, lver, v) SELECT ?, k, local, lver, v FROM entries WHERE space = ?",
		);
	}

	get size(): number {
		return this.#size;
	}

	getJson(key: string): string | undefined {
		return this.#get.get(this.space, cesu8Encode(key))?.v;
	}

	get(key: string): unknown {
		const json = this.getJson(key);
		return json === undefined ? undefined : JSON.parse(json);
	}

	/** Inserts or replaces; returns whether the key was new. */
	set(key: string, json: string, local: string | null = null, version: number | null = null): boolean {
		const encoded = cesu8Encode(key);
		const inserted = this.#insert.run(this.space, encoded, local, version, json).changes > 0;
		if (inserted) this.#size++;
		else this.#update.run(local, version, json, this.space, encoded);
		this.#scratch.wrote();
		return inserted;
	}

	/** Inserts a new key; returns false (and changes nothing) when it already exists. */
	insert(key: string, json: string): boolean {
		const inserted = this.#insert.run(this.space, cesu8Encode(key), null, null, json).changes > 0;
		if (inserted) this.#size++;
		this.#scratch.wrote();
		return inserted;
	}

	delete(key: string): void {
		this.#size -= this.#delete.run(this.space, cesu8Encode(key)).changes;
		this.#scratch.wrote();
	}

	clear(): void {
		this.#clear.run(this.space);
		this.#size = 0;
		this.#scratch.wrote();
	}

	/** Replaces this map's contents with a copy of `source` (one statement, never a walk interleaved with writes). */
	copyFrom(source: ScratchMap): void {
		this.clear();
		this.#size = this.#copy.run(this.space, source.space).changes;
		this.#scratch.wrote();
	}

	*entries(): Generator<{ readonly key: string; readonly json: string }> {
		for (const row of this.#entries.iterate(this.space)) yield { key: cesu8Decode(row.k), json: row.v };
	}

	*byLocal(local: string, version: number): Generator<string> {
		for (const row of this.#local.iterate(this.space, local, version)) yield row.v;
	}
}

/**
 * A private, disposable SQLite file used as bounded working memory: never synced (nothing in it must survive the
 * process), a fixed page cache, and writes batched into large transactions. Its rollback journal stays on disk:
 * Bun runs SQLite in defensive mode, which ignores journal_mode=OFF.
 */
export class AuthorityScratch {
	readonly #database: Database;
	readonly #file: string;
	#spaces = 0;
	#pending = 0;
	#closed = false;

	constructor(directory: string) {
		this.#file = path.join(directory, `.scratch-${randomUUID()}.sqlite`);
		fs.closeSync(
			fs.openSync(
				this.#file,
				fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
				0o600,
			),
		);
		try {
			this.#database = new Database(this.#file, { create: false, readwrite: true, strict: true });
			this.#database.exec(
				`PRAGMA synchronous=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA temp_store=FILE; PRAGMA cache_size=-${SCRATCH_CACHE_KIB};`,
			);
			this.#database.exec(
				"CREATE TABLE entries (space INTEGER NOT NULL, k BLOB NOT NULL, local TEXT, lver INTEGER, v TEXT NOT NULL, PRIMARY KEY (space, k)) WITHOUT ROWID",
			);
			// Local entries by (local, version), for localEntriesAt; ScratchMap forces its use (see #local).
			this.#database.exec("CREATE INDEX entries_local ON entries(space, local, lver)");
			this.#database.exec("BEGIN");
		} catch (error) {
			fs.rmSync(this.#file, { force: true });
			throw error;
		}
	}

	map(): ScratchMap {
		return new ScratchMap(this, this.#database, ++this.#spaces);
	}

	/** Counts a write and periodically commits, so one transaction never holds the whole history. */
	wrote(): void {
		if (++this.#pending < SCRATCH_COMMIT_EVERY) return;
		this.#pending = 0;
		this.#database.exec("COMMIT");
		this.#database.exec("BEGIN");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		// Exclusive locking mode keeps the rollback journal of the open transaction after close; it is scratch too.
		try {
			this.#database.close(false);
		} finally {
			fs.rmSync(this.#file, { force: true });
			fs.rmSync(`${this.#file}-journal`, { force: true });
		}
	}
}

/** The rolling replay state of an export: current rows, non-receipt controls and receipt controls, on disk. */
export class AuthorityReplayState {
	readonly rows: ScratchMap;
	readonly controls: ScratchMap;
	readonly receipts: ScratchMap;
	readonly frameState: AuthorityFrameState;

	constructor(scratch: AuthorityScratch) {
		this.rows = scratch.map();
		this.controls = scratch.map();
		this.receipts = scratch.map();
		const state = this;
		this.frameState = Object.freeze({
			get<D extends AuthorityDomain>(domain: D, key: AuthorityKey): AuthorityRow<AuthorityRecordMap[D]> | undefined {
				return state.rows.get(authorityKey(domain, key)) as AuthorityRow<AuthorityRecordMap[D]> | undefined;
			},
			getControl: (key: string): unknown => state.getControl(key),
			*localEntriesAt(localId: string, version: number) {
				for (const json of state.rows.byLocal(localId, version)) {
					const row = JSON.parse(json) as AuthorityRow;
					if (row.record.kind === "local-entry") yield row as AuthorityRow<AuthorityRecordMap["local-entry"]>;
				}
			},
		});
	}

	getRow(key: string): AuthorityRow | undefined {
		return this.rows.get(key) as AuthorityRow | undefined;
	}

	setRow(row: AuthorityRow, key = rowKeyOf(row)): void {
		const record = row.record;
		if (record.kind === "local-entry") this.rows.set(key, JSON.stringify(row), record.localId, record.version);
		else this.rows.set(key, JSON.stringify(row));
	}

	getControl(key: string): unknown {
		return key.startsWith("receipt:") ? this.receipts.get(key) : this.controls.get(key);
	}

	setControl(key: string, value: unknown): void {
		const json = JSON.stringify(value);
		if (json === undefined) throw new TypeError(`Authority control ${key} is not JSON serializable.`);
		(key.startsWith("receipt:") ? this.receipts : this.controls).set(key, json);
	}

	deleteControl(key: string): void {
		(key.startsWith("receipt:") ? this.receipts : this.controls).delete(key);
	}
}

function genesisMeta(): AuthorityMeta {
	return { revision: 0, headHash: authorityGenesisHash(), generationHighWater: 0, status: "ready" };
}

/** Loads the state an export with legacy provenance starts from (its legacy baseline), or the genesis meta. */
export function loadExportBaseline(
	state: AuthorityReplayState,
	identity: AuthorityIdentity,
	legacy: AuthorityLegacySource | undefined,
): void {
	if (legacy === undefined) {
		state.setControl("meta", genesisMeta());
		return;
	}
	if (
		!legacy ||
		typeof legacy !== "object" ||
		Array.isArray(legacy) ||
		Object.keys(legacy).sort().join("\0") !== "entries\0sourceSha256"
	)
		throw new Error("Authority legacy provenance envelope is invalid.");
	const baseline = authorityExportFromLegacySource(identity, legacy);
	for (const row of baseline.rows) state.setRow(row);
	for (const control of baseline.controls) state.setControl(control.key, control.value);
}

/**
 * The SQLite per-frame evidence rules (verifyFrame): the frame carries exactly its own receipt delta, equal to its
 * receipt, a meta delta without headHash for its own revision, unique control keys, and JSON-valid values.
 */
function verifyFrameEvidence(frame: AuthorityCommitFrame): AuthorityMetaUpdate {
	const receiptKey = receiptKeyOf(frame);
	const receiptDelta = frame.controls.find(change => change.key === receiptKey);
	if (
		!receiptDelta ||
		receiptDelta.deleted ||
		canonicalDurableSha256(receiptDelta.value) !== canonicalDurableSha256(frame.receipt)
	)
		throw new Error("Authority frame must carry its exact incarnation-scoped receipt control.");
	const meta = frame.controls.find(change => change.key === "meta");
	if (!meta || meta.deleted || !meta.value || typeof meta.value !== "object")
		throw new Error("Authority frame must carry its updated meta control.");
	if (Object.hasOwn(meta.value, "headHash")) throw new Error("Authority meta frame delta must omit headHash.");
	const metaValue = meta.value as AuthorityMetaUpdate;
	if (
		metaValue.revision !== frame.revision ||
		!Number.isSafeInteger(metaValue.generationHighWater) ||
		metaValue.generationHighWater < 0
	)
		throw new Error("Authority frame meta does not match its revision or generation high-water.");
	const keys = new Set<string>();
	for (const change of frame.controls) {
		if (keys.has(change.key)) throw new Error(`Authority frame repeats control key ${change.key}.`);
		keys.add(change.key);
		if (change.key.startsWith("receipt:") && change.key !== receiptKey)
			throw new Error("Authority frame contains a receipt control without matching receipt identity.");
		if (!change.deleted) {
			canonicalDurableSha256(change.value);
			if (JSON.stringify(change.value) === undefined)
				throw new TypeError(`Authority control ${change.key} is not JSON serializable.`);
		}
	}
	return metaValue;
}

/**
 * Replays an export's frames against `state` (seeded with its legacy baseline or genesis) and proves the export is
 * exactly what its history produces: the union of the SQLite import check (verifyExportState) and the JSONL seed
 * check (verifyExport). Every frame continues the hash chain, carries consistent receipt and meta evidence,
 * matches the replayed row versions and passes the engine's state validation; afterwards the header, current rows,
 * controls and receipts must equal the replayed state. `state` is left holding the replayed state.
 */
export function verifyExportReader(
	reader: AuthorityExportReader,
	state: AuthorityReplayState,
	identity: AuthorityIdentity,
): void {
	if (
		!Number.isSafeInteger(reader.revision) ||
		reader.revision < 0 ||
		!Number.isSafeInteger(reader.generationHighWater) ||
		reader.generationHighWater < 0 ||
		typeof reader.headHash !== "string" ||
		!HASH_PATTERN.test(reader.headHash)
	)
		throw new Error("Authority export has invalid header metadata.");
	loadExportBaseline(state, identity, reader.legacy);
	let previousHash = authorityGenesisHash();
	let previousRevision = 0;
	let frames = 0;
	for (const { frame, receipt } of reader.frames()) {
		validateAuthorityFrame(frame, previousHash);
		const metaUpdate = verifyFrameEvidence(frame);
		if (frame.revision !== previousRevision + 1)
			throw new Error("Authority export frame revisions are discontinuous.");
		const expectedVersions = new Map<string, number | null>();
		for (const expected of frame.expected) {
			const key = authorityKey(expected.domain, expected.key);
			expectedVersions.set(key, expected.version);
			if ((state.getRow(key)?.version ?? null) !== expected.version)
				throw new Error("Authority export frame expected row version does not match replay.");
		}
		validateAuthorityFrameState(frame, state.frameState);
		const receiptKey = receiptKeyOf(frame);
		if (receipt === undefined) throw new Error("Authority export is missing committed receipt controls.");
		if (canonicalDurableSha256(receipt) !== canonicalDurableSha256(frame.receipt))
			throw new Error("Authority export receipt control does not match its retained frame identity.");
		const receiptJson = JSON.stringify(receipt);
		if (receiptJson === undefined || !state.receipts.insert(receiptKey, receiptJson))
			throw new Error("Authority export retained duplicate receipt identities in commit evidence.");
		for (const row of frame.changes) {
			const key = rowKeyOf(row);
			if (!expectedVersions.has(key) || row.version !== (expectedVersions.get(key) ?? 0) + 1)
				throw new Error("Authority export changed row version does not match replay.");
			state.setRow(row, key);
		}
		for (const change of frame.controls) {
			if (change.key.startsWith("receipt:")) continue;
			if (change.key === "meta")
				state.setControl("meta", { ...metaUpdate, headHash: frame.hash } satisfies AuthorityMeta);
			else if (change.deleted) state.deleteControl(change.key);
			else state.setControl(change.key, change.value);
		}
		previousHash = frame.hash;
		previousRevision = frame.revision;
		frames++;
	}
	if (reader.revision !== previousRevision || reader.headHash !== previousHash)
		throw new Error("Authority export frame history does not match export revision or head hash.");
	const meta = state.controls.get("meta") as AuthorityMeta | undefined;
	if (
		!meta ||
		meta.revision !== reader.revision ||
		meta.generationHighWater !== reader.generationHighWater ||
		meta.headHash !== reader.headHash
	)
		throw new Error("Authority export metadata does not match reconstructed frame and legacy evidence.");
	if (reader.receiptControls !== undefined && reader.receiptControls !== frames)
		throw new Error("Authority export receipt controls do not match committed frame evidence.");
	let rows = 0;
	let previousKey: string | undefined;
	for (const row of reader.rows()) {
		if (
			!row ||
			typeof row !== "object" ||
			Array.isArray(row) ||
			!Number.isSafeInteger(row.version) ||
			row.version < 1
		)
			throw new Error("Authority export row version is invalid.");
		validateDurableRegistryRecord(row.record);
		const key = rowKeyOf(row);
		if (previousKey !== undefined && compareAuthorityKeys(previousKey, key) >= 0)
			throw new Error("Authority export contains duplicate or unordered row identities.");
		previousKey = key;
		const expected = state.rows.getJson(key);
		if (expected === undefined || canonicalDurableSha256(row) !== canonicalDurableSha256(JSON.parse(expected)))
			throw new Error(`Authority export current ${row.record.kind} row disagrees with retained evidence.`);
		rows++;
	}
	if (rows !== state.rows.size)
		throw new Error("Authority export current row count disagrees with retained evidence.");
	if (frames === 0 && reader.legacy === undefined && rows > 0)
		throw new Error("Authority export rows are missing legacy or committed-frame evidence.");
	let controls = 0;
	previousKey = undefined;
	for (const control of reader.controls()) {
		if (!control || typeof control.key !== "string" || control.key.length === 0 || control.key.includes("\0"))
			throw new Error("Authority export control is invalid or duplicated.");
		if (control.key.startsWith("receipt:")) throw new Error("Authority export contains duplicate receipt controls.");
		if (previousKey !== undefined && compareAuthorityKeys(previousKey, control.key) >= 0)
			throw new Error("Authority export control is invalid or duplicated.");
		previousKey = control.key;
		const expected = state.controls.getJson(control.key);
		if (
			expected === undefined ||
			canonicalDurableSha256(control.value) !== canonicalDurableSha256(JSON.parse(expected))
		)
			throw new Error(`Authority export current control ${control.key} disagrees with retained evidence.`);
		if (control.key === "meta") verifyMetaStatus(control.value);
		controls++;
	}
	if (controls !== state.controls.size)
		throw new Error("Authority export current control count disagrees with retained evidence.");
}

function verifyMetaStatus(value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Authority export metadata is invalid.");
	const meta = value as Record<string, unknown>;
	if (
		(meta.status !== "ready" && meta.status !== "quarantined") ||
		(meta.status === "quarantined" &&
			(typeof meta.quarantineReason !== "string" || meta.quarantineReason.length === 0)) ||
		(meta.status === "ready" && meta.quarantineReason !== undefined)
	)
		throw new Error("Authority export metadata does not match its exported identity.");
}

/** Every control of the export in key order: the reader's non-receipt controls merged with `receipts`. */
export function* mergedControls(
	controls: Iterable<AuthorityControl>,
	receipts: ScratchMap,
): Generator<AuthorityControl> {
	const receiptIterator = receipts.entries()[Symbol.iterator]();
	let receipt = receiptIterator.next();
	for (const control of controls) {
		while (!receipt.done && compareAuthorityKeys(receipt.value.key, control.key) < 0) {
			yield { key: receipt.value.key, value: JSON.parse(receipt.value.json) };
			receipt = receiptIterator.next();
		}
		yield control;
	}
	while (!receipt.done) {
		yield { key: receipt.value.key, value: JSON.parse(receipt.value.json) };
		receipt = receiptIterator.next();
	}
}

/** The view of a verified reader: its rows and frames, and its controls merged with the replayed receipts. */
export function exportViewOf(reader: AuthorityExportReader, receipts: ScratchMap): AuthorityExportView {
	return {
		revision: reader.revision,
		generationHighWater: reader.generationHighWater,
		headHash: reader.headHash,
		...(reader.legacy !== undefined ? { legacy: reader.legacy } : {}),
		rows: () => reader.rows(),
		controls: () => mergedControls(reader.controls(), receipts),
		frames: () => reader.frames(),
	};
}

/** An in-memory export as a view (legacy v1 sources, whose provenance is held whole anyway). */
export function inMemoryExportView(exported: AuthorityExport): AuthorityExportView {
	const receipts = new Map(
		exported.controls
			.filter(control => control.key.startsWith("receipt:"))
			.map(control => [control.key, control.value] as const),
	);
	return {
		revision: exported.revision,
		generationHighWater: exported.generationHighWater,
		headHash: exported.headHash,
		...(exported.legacy ? { legacy: exported.legacy } : {}),
		rows: () => exported.rows,
		controls: () => exported.controls,
		*frames() {
			for (const frame of exported.frames) yield { frame, receipt: receipts.get(receiptKeyOf(frame)) };
		},
	};
}

/** Writes canonical JSON into a hash in pieces; the result equals hashing the whole canonical document. */
export class CanonicalHashWriter {
	readonly #hash: Hash = createHash("sha256");

	text(value: string): this {
		this.#hash.update(value);
		return this;
	}

	value(value: unknown): this {
		this.#hash.update(canonicalDurableJson(value));
		return this;
	}

	/** `"name":` */
	key(name: string): this {
		this.#hash.update(`${JSON.stringify(name)}:`);
		return this;
	}

	array<T>(items: Iterable<T>, each: (item: T) => unknown): this {
		this.#hash.update("[");
		let first = true;
		for (const item of items) {
			if (!first) this.#hash.update(",");
			first = false;
			this.#hash.update(canonicalDurableJson(each(item)));
		}
		this.#hash.update("]");
		return this;
	}

	digest(): string {
		return this.#hash.digest("hex");
	}
}

/** External effects or claims an export leaves unresolved; a conversion refuses them. */
function unresolvedRow(row: AuthorityRow): string | undefined {
	const record = row.record;
	switch (record.kind) {
		case "operation":
			return ["completed", "failed", "abandoned", "cancelled"].includes(record.phase)
				? undefined
				: `operation:${record.operationId}:${record.phase}`;
		case "resource":
			return ["completed", "cancelled", "abandoned"].includes(record.phase)
				? undefined
				: `resource:${record.resourceId}:${record.phase}`;
		case "transition":
			return ["retired", "recovered"].includes(record.phase)
				? undefined
				: `transition:${record.transitionId}:${record.phase}`;
		case "construction":
			return ["activated", "abandoned"].includes(record.phase)
				? undefined
				: `construction:${record.actorId}:${record.generation}:${record.phase}`;
		case "local-entry":
			return record.phase === "intent" || record.phase === "effect"
				? `local-entry:${record.localId}:${record.entryId}:${record.phase}`
				: undefined;
		default:
			return undefined;
	}
}

export interface AuthorityViewDigest {
	/** canonicalDurableSha256 of the export without its source identity (the migration's semanticExport). */
	readonly semanticSha256: string;
	/** Unresolved external effects and claims, in the order the in-memory check listed them (rows, then claims). */
	readonly blockers: readonly string[];
}

/**
 * The semantic fingerprint of a view, streamed: canonical JSON of { controls, frames, generationHighWater,
 * headHash, legacy?, revision, rows, version } (canonical key order), which is what the in-memory migration hashed.
 */
export function digestExportView(view: AuthorityExportView): AuthorityViewDigest {
	const rowBlockers: string[] = [];
	const claimBlockers: string[] = [];
	const hash = new CanonicalHashWriter()
		.text("{")
		.key("controls")
		.array(view.controls(), control => {
			if (control.key.startsWith("local-claim:")) claimBlockers.push(control.key);
			return { key: control.key, value: control.value };
		})
		.text(",")
		.key("frames")
		.array(view.frames(), item => item.frame)
		.text(",")
		.key("generationHighWater")
		.value(view.generationHighWater)
		.text(",")
		.key("headHash")
		.value(view.headHash);
	if (view.legacy) hash.text(",").key("legacy").value(view.legacy);
	hash
		.text(",")
		.key("revision")
		.value(view.revision)
		.text(",")
		.key("rows")
		.array(view.rows(), row => {
			const blocker = unresolvedRow(row);
			if (blocker) rowBlockers.push(blocker);
			return row;
		})
		.text(",")
		.key("version")
		.value(2)
		.text("}");
	return { semanticSha256: hash.digest(), blockers: [...rowBlockers, ...claimBlockers] };
}
