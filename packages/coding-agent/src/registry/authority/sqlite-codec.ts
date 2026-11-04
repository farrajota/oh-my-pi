import * as zlib from "node:zlib";
import { authorityRecordKey } from "./engine";
import {
	SQLITE_AUTHORITY_CODEC_VERSION,
	SQLITE_AUTHORITY_DOMAINS,
	SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES,
} from "./sqlite-schema";
import type { AuthorityCommitFrame, AuthorityDomain, AuthorityKey, AuthorityRow, MutationReceipt } from "./types";
import type { DurableRegistryRecord } from "../durable-state";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASCII_PATTERN = /^[\x00-\x7f]*$/;

/*
 * Order keys are CESU-8: each UTF-16 code unit (a lone or paired surrogate included) becomes its 1-3 byte UTF-8
 * form. That encoding is prefix-free per code unit and monotonic in the code unit, so bytewise (memcmp) order of
 * two keys equals JavaScript's code-unit string order, which every scan cursor and export sort uses. Standard UTF-8
 * would not: it encodes an astral pair as F0-F4 bytes, above the EE-EF bytes of U+E000..U+FFFF.
 */
export function cesu8Encode(value: string): Uint8Array {
	if (ASCII_PATTERN.test(value)) return Buffer.from(value, "latin1");
	const bytes = Buffer.allocUnsafe(value.length * 3);
	let offset = 0;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit < 0x80) bytes[offset++] = unit;
		else if (unit < 0x800) {
			bytes[offset++] = 0xc0 | (unit >> 6);
			bytes[offset++] = 0x80 | (unit & 0x3f);
		} else {
			bytes[offset++] = 0xe0 | (unit >> 12);
			bytes[offset++] = 0x80 | ((unit >> 6) & 0x3f);
			bytes[offset++] = 0x80 | (unit & 0x3f);
		}
	}
	return bytes.subarray(0, offset);
}

/** Strict inverse of cesu8Encode; rejects any byte sequence cesu8Encode cannot produce. */
export function cesu8Decode(bytes: Uint8Array): string {
	const units: number[] = [];
	for (let offset = 0; offset < bytes.length;) {
		const lead = bytes[offset]!;
		let unit: number;
		if (lead < 0x80) {
			unit = lead;
			offset += 1;
		} else if (lead >= 0xc2 && lead < 0xe0 && offset + 1 < bytes.length && (bytes[offset + 1]! & 0xc0) === 0x80) {
			unit = ((lead & 0x1f) << 6) | (bytes[offset + 1]! & 0x3f);
			offset += 2;
		} else if (
			lead >= 0xe0 &&
			lead < 0xf0 &&
			offset + 2 < bytes.length &&
			(bytes[offset + 1]! & 0xc0) === 0x80 &&
			(bytes[offset + 2]! & 0xc0) === 0x80
		) {
			unit = ((lead & 0x0f) << 12) | ((bytes[offset + 1]! & 0x3f) << 6) | (bytes[offset + 2]! & 0x3f);
			if (unit < 0x800) throw new Error("SQLite authority order key contains an overlong encoding.");
			offset += 3;
		} else throw new Error("SQLite authority order key is not canonical CESU-8.");
		units.push(unit);
	}
	let text = "";
	for (let index = 0; index < units.length; index += 8_192)
		text += String.fromCharCode(...units.slice(index, index + 8_192));
	return text;
}

/** Smallest byte string above every key that starts with `prefix` (none for the empty prefix). */
export function cesu8PrefixUpperBound(prefix: string): Uint8Array | undefined {
	const encoded = Buffer.from(cesu8Encode(prefix));
	if (!encoded.length) return undefined;
	// CESU-8 never emits 0xFF, so incrementing the last byte cannot carry.
	encoded[encoded.length - 1]!++;
	return encoded;
}

function domainKeyPrefix(domain: AuthorityDomain): string {
	return `[${JSON.stringify(domain)},`;
}

/**
 * Compact domain-table key: CESU-8 of `authorityKey(domain, key)` without its constant `["<domain>",` prefix. Within
 * one table every key shares that prefix, so dropping it preserves order.
 */
export function sqliteAuthorityOrderKey(key: AuthorityKey): Uint8Array {
	return cesu8Encode(JSON.stringify(key).slice(1));
}

/**
 * Lower bound for a scan cursor that is an `authorityKey` string. `undefined` means every key of the domain is
 * after the cursor; `null` means none is (the cursor sorts after the whole domain).
 */
export function sqliteAuthorityOrderKeyAfter(domain: AuthorityDomain, cursor: string): Uint8Array | undefined | null {
	const prefix = domainKeyPrefix(domain);
	if (cursor.startsWith(prefix)) return cesu8Encode(cursor.slice(prefix.length));
	return cursor < prefix ? undefined : null;
}

export type SqliteAuthorityValue = string | number | Uint8Array | null;

/** Projected column values of a domain row, in SQLITE_AUTHORITY_DOMAINS column order. */
export function sqliteAuthorityProjection(
	domain: AuthorityDomain,
	record: DurableRegistryRecord,
): SqliteAuthorityValue[] {
	const source = record as unknown as Record<string, unknown>;
	return SQLITE_AUTHORITY_DOMAINS[domain].columns.map(([column, field]) => {
		const value = source[field];
		if (column === "head_hash") {
			if (typeof value !== "string" || !HASH_PATTERN.test(value))
				throw new TypeError(`SQLite authority ${domain}.${column} is not a SHA-256 hash.`);
			return Buffer.from(value, "hex");
		}
		if (column === "root_id" || column === "local_id") {
			if (typeof value !== "string")
				throw new TypeError(`SQLite authority ${domain}.${column} is not an identifier.`);
			return cesu8Encode(value);
		}
		if (typeof value === "string" || typeof value === "number") return value;
		throw new TypeError(`SQLite authority ${domain}.${column} is missing or not a scalar value.`);
	});
}

/** Every physical column of a domain row, by name. Shared by the driver and capacity pricing. */
export function sqliteAuthorityRowValues(row: AuthorityRow): Record<string, SqliteAuthorityValue> {
	const domain = row.record.kind as AuthorityDomain;
	const values: Record<string, SqliteAuthorityValue> = {
		order_key: sqliteAuthorityOrderKey(authorityRecordKey(row.record as DurableRegistryRecord)),
		version: row.version,
		wrapper_order: Object.keys(row)[0] === "version" ? 1 : 0,
	};
	const projection = sqliteAuthorityProjection(domain, row.record as DurableRegistryRecord);
	SQLITE_AUTHORITY_DOMAINS[domain].columns.forEach(([column], index) => {
		values[column] = projection[index]!;
	});
	const record = JSON.stringify(row.record);
	if (record === undefined) throw new TypeError("SQLite authority record is not JSON serializable.");
	values.record = record;
	return values;
}

export function receiptControlKey(receipt: Pick<MutationReceipt, "incarnation" | "ownerEpoch" | "requestId">): string {
	return `receipt:${JSON.stringify([receipt.incarnation, receipt.ownerEpoch, receipt.requestId])}`;
}

/** Frame-row columns stored beside the body; the body never repeats them. */
export interface SqliteAuthorityFrameColumns {
	readonly revision: number;
	readonly incarnation: string;
	readonly requestId: string;
	readonly epoch: number;
	readonly hash: Uint8Array;
	readonly previousHash: Uint8Array;
	readonly contentHash: Uint8Array;
	/** JSON of the current receipt control value: what replay and `getControl("receipt:...")` return. */
	readonly receipt: string;
}

/** Stored form of the frame-row columns (identifiers as CESU-8, the receipt without its column-held identity). */
export interface SqliteAuthorityFrameRow {
	readonly revision: number;
	readonly incarnation: Uint8Array;
	readonly request_id: Uint8Array;
	readonly epoch: number;
	readonly hash: Uint8Array;
	readonly previous_hash: Uint8Array;
	readonly content_hash: Uint8Array;
	readonly receipt: string;
}

// Receipt fields the row's own columns hold: stored as the placeholder 0 (an epoch is positive and ids are strings).
const RECEIPT_IDENTITY = [
	["requestId", "requestId"],
	["incarnation", "incarnation"],
	["ownerEpoch", "epoch"],
] as const;

export function sqliteAuthorityFrameRow(columns: SqliteAuthorityFrameColumns): SqliteAuthorityFrameRow {
	const receipt = JSON.parse(columns.receipt) as Record<string, unknown>;
	if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
		throw new TypeError("SQLite authority receipt control is not an object.");
	for (const [field, column] of RECEIPT_IDENTITY) {
		if (Object.hasOwn(receipt, field) && receipt[field] === columns[column])
			Object.defineProperty(receipt, field, {
				value: PLACEHOLDER,
				enumerable: true,
				configurable: true,
				writable: true,
			});
	}
	return {
		revision: columns.revision,
		incarnation: cesu8Encode(columns.incarnation),
		request_id: cesu8Encode(columns.requestId),
		epoch: columns.epoch,
		hash: columns.hash,
		previous_hash: columns.previousHash,
		content_hash: columns.contentHash,
		receipt: json(receipt),
	};
}

/** Inverse of sqliteAuthorityFrameRow; validates column types. */
export function sqliteAuthorityFrameColumnsFromRow(row: SqliteAuthorityFrameRow): SqliteAuthorityFrameColumns {
	if (
		!Number.isSafeInteger(row.revision) ||
		row.revision < 1 ||
		!(row.incarnation instanceof Uint8Array) ||
		!(row.request_id instanceof Uint8Array) ||
		!Number.isSafeInteger(row.epoch) ||
		row.epoch < 1 ||
		!(row.hash instanceof Uint8Array) ||
		!(row.previous_hash instanceof Uint8Array) ||
		!(row.content_hash instanceof Uint8Array) ||
		typeof row.receipt !== "string"
	)
		throw new Error("SQLite authority frame row has invalid column types.");
	const columns = {
		revision: row.revision,
		incarnation: cesu8Decode(row.incarnation),
		requestId: cesu8Decode(row.request_id),
		epoch: row.epoch,
		hash: row.hash,
		previousHash: row.previous_hash,
		contentHash: row.content_hash,
		receipt: "",
	};
	return { ...columns, receipt: json(expandReceipt(row.receipt, columns)) };
}

/** The receipt control value of a stored frame row, given its identity columns. */
export function sqliteAuthorityReceipt(
	stored: string,
	identity: { readonly incarnation: string; readonly requestId: string; readonly epoch: number },
): Record<string, unknown> {
	return expandReceipt(stored, identity);
}

function expandReceipt(
	stored: string,
	identity: { readonly incarnation: string; readonly requestId: string; readonly epoch: number },
): Record<string, unknown> {
	let receipt: unknown;
	try {
		receipt = JSON.parse(stored);
	} catch (error) {
		throw new Error("SQLite authority receipt column contains invalid JSON.", { cause: error });
	}
	if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
		throw new Error("SQLite authority receipt column is not an object.");
	const value = receipt as Record<string, unknown>;
	for (const [field, column] of RECEIPT_IDENTITY) {
		if (value[field] === PLACEHOLDER)
			Object.defineProperty(value, field, {
				value: identity[column],
				enumerable: true,
				configurable: true,
				writable: true,
			});
	}
	return value;
}

function hashBlob(value: string, label: string): Uint8Array {
	if (!HASH_PATTERN.test(value)) throw new TypeError(`SQLite authority frame ${label} is not a SHA-256 hash.`);
	return Buffer.from(value, "hex");
}

function receiptControlIndex(frame: AuthorityCommitFrame): number {
	const key = receiptControlKey(frame.receipt);
	const index = frame.controls.findIndex(control => control.key === key);
	const control = frame.controls[index];
	if (!control || control.deleted || frame.controls.some((other, position) => position !== index && other.key === key))
		throw new Error("SQLite authority frame lacks exactly one receipt-control slot.");
	return index;
}

/**
 * Columns of a frame row. `receiptControl` is the current receipt control value when it differs in key order from
 * the frame's own slot (an imported export); a live commit stores its own slot value.
 */
export function sqliteAuthorityFrameColumns(
	frame: AuthorityCommitFrame,
	receiptControl?: unknown,
): SqliteAuthorityFrameColumns {
	const slot = frame.controls[receiptControlIndex(frame)]!;
	const receipt = JSON.stringify(receiptControl ?? (slot.deleted ? undefined : slot.value));
	if (receipt === undefined) throw new TypeError("SQLite authority receipt control is not JSON serializable.");
	if (
		frame.request.requestId !== frame.receipt.requestId ||
		frame.request.incarnation !== frame.receipt.incarnation ||
		frame.request.ownerEpoch !== frame.receipt.ownerEpoch
	)
		throw new Error("SQLite authority frame request and receipt identities differ.");
	return {
		revision: frame.revision,
		incarnation: frame.receipt.incarnation,
		requestId: frame.receipt.requestId,
		epoch: frame.receipt.ownerEpoch,
		hash: hashBlob(frame.hash, "hash"),
		previousHash: hashBlob(frame.previousHash, "previous hash"),
		contentHash: hashBlob(frame.contentHash, "content hash"),
		receipt,
	};
}

/*
 * Frame body codec v4. Body = [codec version][encoding: 0 raw, 1 zstd][uint32 BE JSON length][payload]. The JSON is
 * {"f": frame, "r": references}. Values the row columns already hold are replaced in place by the placeholder 0 so key
 * order is kept: revision, the three hashes, request identity, the receipt-control slot (key and value), and the
 * receipt and payload hash when equal to the receipt column. A reference [targetPath, source] replaces the value at
 * targetPath (also by 0) with a copy of the value at the path `source`, or, when `source` is a number i, with the
 * expectation that change i implies. References are emitted only where JSON text equality holds, and only when the
 * placeholder plus reference is shorter than the value, so the referenced form is never longer than the inline one.
 * Decoding needs no other frame: history stays independent per frame.
 */
const BODY_HEADER_BYTES = 6;
const ENCODING_RAW = 0;
const ENCODING_ZSTD = 1;
const PLACEHOLDER = 0;
type Path = readonly (string | number)[];
type Reference = readonly [target: Path, source: Path | number];
const DOMAINS = new Set(Object.keys(SQLITE_AUTHORITY_DOMAINS));

function derivedExpectation(row: AuthorityRow): unknown {
	return {
		domain: row.record.kind,
		key: authorityRecordKey(row.record as DurableRegistryRecord),
		version: row.version === 1 ? null : row.version - 1,
	};
}

function json(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw new TypeError("SQLite authority frame value is not JSON serializable.");
	return text;
}

function collectRecords(value: unknown, path: (string | number)[], depth: number, found: Map<string, Path>): void {
	if (depth > 4 || !value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((entry, index) => collectRecords(entry, [...path, index], depth + 1, found));
		return;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.kind === "string" && DOMAINS.has(record.kind) && path.length) {
		const text = json(record);
		if (!found.has(text)) found.set(text, path);
		return;
	}
	for (const [key, child] of Object.entries(record)) collectRecords(child, [...path, key], depth + 1, found);
}

function worthReferencing(valueText: string, reference: Reference): boolean {
	return valueText.length - 1 >= Buffer.byteLength(json(reference), "utf8") + 1;
}

/** Body JSON: reference-free (`withReferences` false, the capacity bound) or with every worthwhile reference. */
function encodeBodyJson(
	frame: AuthorityCommitFrame,
	columns: SqliteAuthorityFrameColumns,
	withReferences: boolean,
): string {
	const receiptIndex = receiptControlIndex(frame);
	const slot = frame.controls[receiptIndex]!;
	const request = { ...frame.request, requestId: PLACEHOLDER, incarnation: PLACEHOLDER, ownerEpoch: PLACEHOLDER };
	const controls: unknown[] = frame.controls.map((control, index) =>
		index === receiptIndex
			? {
					...control,
					key: PLACEHOLDER,
					value:
						json(slot.deleted ? undefined : slot.value) === columns.receipt
							? PLACEHOLDER
							: (slot as { value: unknown }).value,
				}
			: control,
	);
	const skeleton: Record<string, unknown> = {
		...frame,
		revision: PLACEHOLDER,
		request,
		controls,
		previousHash: PLACEHOLDER,
		contentHash: PLACEHOLDER,
		hash: PLACEHOLDER,
	};
	if (json(frame.receipt) === columns.receipt) skeleton.receipt = PLACEHOLDER;
	const receiptValue = JSON.parse(columns.receipt) as { payloadHash?: unknown };
	if (frame.payloadHash === receiptValue.payloadHash) skeleton.payloadHash = PLACEHOLDER;
	if (!withReferences) return json({ f: skeleton, r: [] });
	const references: Reference[] = [];
	const commandRecords = new Map<string, Path>();
	collectRecords(frame.command, ["command"], 0, commandRecords);
	const changes = frame.changes.map(row => ({ ...row }) as Record<string, unknown>);
	const changeRecords = new Map<string, Path>();
	frame.changes.forEach((row, index) => {
		const text = json(row.record);
		const source = commandRecords.get(text);
		const reference: Reference | undefined = source ? [["changes", index, "record"], source] : undefined;
		if (reference && worthReferencing(text, reference)) {
			changes[index]!.record = PLACEHOLDER;
			references.push(reference);
		}
		if (!changeRecords.has(text)) changeRecords.set(text, ["changes", index, "record"]);
	});
	const derived = new Map<string, number>();
	frame.changes.forEach((row, index) => {
		const text = json(derivedExpectation(row));
		if (!derived.has(text)) derived.set(text, index);
	});
	const expected: unknown[] = frame.expected.map((expectation, index) => {
		const text = json(expectation);
		const source = derived.get(text);
		const reference: Reference | undefined = source === undefined ? undefined : [["expected", index], source];
		if (!reference || !worthReferencing(text, reference)) return expectation;
		references.push(reference);
		return PLACEHOLDER;
	});
	const generationControls = controls.map((control, index) => {
		if (index === receiptIndex || !control || typeof control !== "object") return control;
		const value = (control as { value?: unknown }).value;
		if (!value || typeof value !== "object" || Array.isArray(value)) return control;
		const evidence = { ...(value as Record<string, unknown>) };
		let changed = false;
		const reference = (target: Path, candidate: unknown): boolean => {
			if (!candidate || typeof candidate !== "object") return false;
			const text = json(candidate);
			const source = commandRecords.get(text) ?? changeRecords.get(text);
			const entry: Reference | undefined = source ? [target, source] : undefined;
			if (!entry || !worthReferencing(text, entry)) return false;
			references.push(entry);
			return true;
		};
		if (Object.hasOwn(evidence, "record") && reference(["controls", index, "value", "record"], evidence.record)) {
			evidence.record = PLACEHOLDER;
			changed = true;
		}
		const row = evidence.row;
		if (row && typeof row === "object" && !Array.isArray(row) && Object.hasOwn(row, "record")) {
			const nested = { ...(row as Record<string, unknown>) };
			if (reference(["controls", index, "value", "row", "record"], nested.record)) {
				nested.record = PLACEHOLDER;
				evidence.row = nested;
				changed = true;
			}
		}
		return changed ? { ...(control as Record<string, unknown>), value: evidence } : control;
	});
	return json({
		f: references.length ? { ...skeleton, changes, expected, controls: generationControls } : skeleton,
		r: references,
	});
}

function bodyBytes(payload: Uint8Array, encoding: number, length: number): Uint8Array {
	const body = Buffer.allocUnsafe(BODY_HEADER_BYTES + payload.byteLength);
	body[0] = SQLITE_AUTHORITY_CODEC_VERSION;
	body[1] = encoding;
	body.writeUInt32BE(length, 2);
	body.set(payload, BODY_HEADER_BYTES);
	return body;
}

function assertBodyLength(length: number): void {
	if (length > SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES)
		throw new RangeError(
			`SQLite authority frame body of ${length} bytes exceeds the ${SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES}-byte frame cap.`,
		);
}

const encodedBodies = new WeakMap<AuthorityCommitFrame, { readonly receipt: string; readonly body: Uint8Array }>();

/** Stored body of a frame: references applied, then zstd when that is smaller. Cached per frame object. */
export function encodeAuthorityFrameBody(
	frame: AuthorityCommitFrame,
	columns: SqliteAuthorityFrameColumns,
): Uint8Array {
	const cached = encodedBodies.get(frame);
	if (cached && cached.receipt === columns.receipt) return cached.body;
	const raw = Buffer.from(encodeBodyJson(frame, columns, true), "utf8");
	assertBodyLength(raw.byteLength);
	const compressed = zlib.zstdCompressSync(raw, {
		params: { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_checksumFlag]: 1 },
	});
	const body =
		compressed.byteLength < raw.byteLength
			? bodyBytes(compressed, ENCODING_ZSTD, raw.byteLength)
			: bodyBytes(raw, ENCODING_RAW, raw.byteLength);
	encodedBodies.set(frame, { receipt: columns.receipt, body });
	return body;
}

/**
 * Upper bound of the stored body length without compressing: the header plus the inline (reference-free) JSON. The
 * stored body is never longer, because references only shorten the JSON and zstd is kept only when it is smaller.
 */
export function authorityFrameBodyBound(frame: AuthorityCommitFrame, columns: SqliteAuthorityFrameColumns): number {
	const length = Buffer.byteLength(encodeBodyJson(frame, columns, false), "utf8");
	assertBodyLength(length);
	return BODY_HEADER_BYTES + length;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function corrupt(columns: SqliteAuthorityFrameColumns, reason: string, cause?: unknown): Error {
	return new Error(
		`SQLite authority frame body at revision ${columns.revision} is corrupt: ${reason}.`,
		cause === undefined ? undefined : { cause },
	);
}

function bodyText(body: Uint8Array, columns: SqliteAuthorityFrameColumns): string {
	if (body.byteLength < BODY_HEADER_BYTES) throw corrupt(columns, "it is shorter than its header");
	const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (bytes[0] !== SQLITE_AUTHORITY_CODEC_VERSION)
		throw corrupt(columns, `codec version ${bytes[0]} is not ${SQLITE_AUTHORITY_CODEC_VERSION}`);
	const length = bytes.readUInt32BE(2);
	if (length > SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES)
		throw corrupt(
			columns,
			`it declares ${length} bytes, above the ${SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES}-byte frame cap`,
		);
	const payload = bytes.subarray(BODY_HEADER_BYTES);
	let raw: Uint8Array;
	if (bytes[1] === ENCODING_RAW) raw = payload;
	else if (bytes[1] === ENCODING_ZSTD) {
		try {
			raw = zlib.zstdDecompressSync(payload, { maxOutputLength: Math.max(1, length) });
		} catch (error) {
			throw corrupt(columns, "zstd decompression failed or exceeded its declared length", error);
		}
	} else throw corrupt(columns, `encoding ${bytes[1]} is unknown`);
	if (raw.byteLength !== length)
		throw corrupt(columns, `it holds ${raw.byteLength} bytes instead of its declared ${length}`);
	try {
		return strictUtf8.decode(raw);
	} catch (error) {
		throw corrupt(columns, "it is not UTF-8", error);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPath(value: unknown): value is Path {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(part => typeof part === "string" || (Number.isSafeInteger(part) && part >= 0))
	);
}

function locate(
	root: Record<string, unknown>,
	path: Path,
): { parent: Record<string, unknown> | unknown[]; key: string | number } | undefined {
	let parent: unknown = root;
	for (let index = 0; index < path.length - 1; index++) {
		const part = path[index]!;
		if (
			Array.isArray(parent)
				? typeof part !== "number" || part >= parent.length
				: !isRecord(parent) || typeof part !== "string" || !Object.hasOwn(parent, part)
		)
			return undefined;
		parent = (parent as Record<string | number, unknown>)[part];
	}
	const key = path.at(-1)!;
	if (
		Array.isArray(parent)
			? typeof key !== "number" || key >= parent.length
			: !isRecord(parent) || typeof key !== "string" || !Object.hasOwn(parent, key)
	)
		return undefined;
	return { parent: parent as Record<string, unknown> | unknown[], key };
}

function replace(
	root: Record<string, unknown>,
	path: Path,
	value: unknown,
	columns: SqliteAuthorityFrameColumns,
	label: string,
): void {
	const slot = locate(root, path);
	if (!slot || (slot.parent as Record<string | number, unknown>)[slot.key] !== PLACEHOLDER)
		throw corrupt(columns, `${label} has no placeholder at ${JSON.stringify(path)}`);
	// defineProperty keeps the key position and never invokes a __proto__ setter.
	Object.defineProperty(slot.parent, slot.key, { value, enumerable: true, configurable: true, writable: true });
}

function sharesPrefix(left: Path, right: Path): boolean {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) if (left[index] !== right[index]) return false;
	return true;
}

export function decodeAuthorityFrameBody(body: Uint8Array, columns: SqliteAuthorityFrameColumns): AuthorityCommitFrame {
	let envelope: unknown;
	try {
		envelope = JSON.parse(bodyText(body, columns));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("SQLite authority frame body")) throw error;
		throw corrupt(columns, "its JSON is invalid", error);
	}
	if (
		!isRecord(envelope) ||
		Object.keys(envelope).sort().join("\0") !== "f\0r" ||
		!isRecord(envelope.f) ||
		!Array.isArray(envelope.r)
	)
		throw corrupt(columns, "its envelope is invalid");
	const frame = envelope.f;
	const request = frame.request;
	if (
		!isRecord(request) ||
		!Array.isArray(frame.controls) ||
		!Array.isArray(frame.changes) ||
		!Array.isArray(frame.expected)
	)
		throw corrupt(columns, "its frame structure is invalid");
	let receipt: unknown;
	try {
		receipt = JSON.parse(columns.receipt);
	} catch (error) {
		throw corrupt(columns, "its receipt column is invalid", error);
	}
	if (!isRecord(receipt)) throw corrupt(columns, "its receipt column is not an object");
	replace(frame, ["revision"], columns.revision, columns, "revision");
	replace(frame, ["previousHash"], Buffer.from(columns.previousHash).toString("hex"), columns, "previous hash");
	replace(frame, ["contentHash"], Buffer.from(columns.contentHash).toString("hex"), columns, "content hash");
	replace(frame, ["hash"], Buffer.from(columns.hash).toString("hex"), columns, "hash");
	replace(frame, ["request", "requestId"], columns.requestId, columns, "request id");
	replace(frame, ["request", "incarnation"], columns.incarnation, columns, "request incarnation");
	replace(frame, ["request", "ownerEpoch"], columns.epoch, columns, "request epoch");
	if (frame.receipt === PLACEHOLDER) replace(frame, ["receipt"], JSON.parse(columns.receipt), columns, "receipt");
	if (frame.payloadHash === PLACEHOLDER) replace(frame, ["payloadHash"], receipt.payloadHash, columns, "payload hash");
	const slots = frame.controls.flatMap((control, index) =>
		isRecord(control) && control.key === PLACEHOLDER ? [index] : [],
	);
	if (slots.length !== 1) throw corrupt(columns, "it lacks exactly one receipt-control slot");
	const slot = slots[0]!;
	replace(
		frame,
		["controls", slot, "key"],
		receiptControlKey({ incarnation: columns.incarnation, ownerEpoch: columns.epoch, requestId: columns.requestId }),
		columns,
		"receipt-control key",
	);
	if ((frame.controls[slot] as Record<string, unknown>).value === PLACEHOLDER)
		replace(frame, ["controls", slot, "value"], JSON.parse(columns.receipt), columns, "receipt-control value");
	const references = envelope.r as unknown[];
	const pending: Path[] = [];
	for (const reference of references) {
		if (
			!Array.isArray(reference) ||
			reference.length !== 2 ||
			!validPath(reference[0]) ||
			!(validPath(reference[1]) || (Number.isSafeInteger(reference[1]) && (reference[1] as number) >= 0))
		)
			throw corrupt(columns, "it has a malformed reference");
		if (pending.some(path => sharesPrefix(path, reference[0] as Path)))
			throw corrupt(columns, "it has overlapping reference targets");
		pending.push(reference[0] as Path);
	}
	for (let index = 0; index < references.length; index++) {
		const [target, source] = references[index] as unknown as Reference;
		const unresolved = pending.slice(index + 1);
		let value: unknown;
		if (typeof source === "number") {
			const row = frame.changes[source];
			if (
				!isRecord(row) ||
				!isRecord(row.record) ||
				!Number.isSafeInteger(row.version) ||
				unresolved.some(path => sharesPrefix(path, ["changes", source]))
			)
				throw corrupt(columns, "an expectation references an unavailable change");
			value = derivedExpectation(row as unknown as AuthorityRow);
		} else {
			if (sharesPrefix(target, source) || unresolved.some(path => sharesPrefix(path, source)))
				throw corrupt(columns, "a reference reads an unresolved value");
			const located = locate(frame, source);
			if (!located) throw corrupt(columns, `a reference source ${JSON.stringify(source)} is missing`);
			value = JSON.parse(json((located.parent as Record<string | number, unknown>)[located.key]));
		}
		replace(frame, target, value, columns, "reference");
	}
	return frame as unknown as AuthorityCommitFrame;
}

/*
 * Physical schema v3 codec, read-only: the offline v3 -> v4 conversion decodes v3 frames with it. Nothing writes it.
 */
type OrderShapeV3 =
	| null
	| { readonly array: readonly OrderShapeV3[] }
	| { readonly object: readonly (readonly [string, OrderShapeV3])[] };
type ReferenceV3 = { readonly $authorityRef: string; readonly id: number };

export function decodeAuthorityReceiptControlV3(receipt: MutationReceipt, encodedOrder: Uint8Array): unknown {
	const shape: unknown = JSON.parse(Buffer.from(encodedOrder).toString("utf8"));
	return restoreOrderV3(receipt, shape as OrderShapeV3);
}

function restoreOrderV3(value: unknown, shape: OrderShapeV3): unknown {
	if (shape === null) {
		if (value !== null && typeof value === "object")
			throw new Error("SQLite authority receipt-control order metadata is inconsistent.");
		return value;
	}
	if (!shape || typeof shape !== "object" || Array.isArray(shape))
		throw new Error("SQLite authority receipt-control order metadata is inconsistent.");
	if ("array" in shape) {
		if (
			Object.keys(shape).length !== 1 ||
			!Array.isArray(shape.array) ||
			!Array.isArray(value) ||
			value.length !== shape.array.length
		)
			throw new Error("SQLite authority receipt-control array order metadata is inconsistent.");
		return value.map((entry, index) => restoreOrderV3(entry, shape.array[index]!));
	}
	if (Object.keys(shape).length !== 1 || !("object" in shape) || !Array.isArray(shape.object) || !isRecord(value))
		throw new Error("SQLite authority receipt-control object order metadata is inconsistent.");
	const entries = shape.object as readonly (readonly [string, OrderShapeV3])[];
	if (entries.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"))
		throw new Error("SQLite authority receipt-control object order metadata is inconsistent.");
	if (Object.keys(value).length !== entries.length || entries.some(([key]) => !Object.hasOwn(value, key)))
		throw new Error("SQLite authority receipt-control object order metadata is inconsistent.");
	const ordered: Record<string, unknown> = {};
	for (const [key, child] of entries) {
		if (Object.hasOwn(ordered, key))
			throw new Error("SQLite authority receipt-control object order metadata is inconsistent.");
		Object.defineProperty(ordered, key, {
			value: restoreOrderV3(value[key], child),
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return ordered;
}

export function decodeAuthorityFrameV3(
	bytes: Uint8Array,
	receipt: MutationReceipt,
	expectedRequestRef: number,
): AuthorityCommitFrame {
	const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
	if (!isRecord(parsed)) throw new Error("SQLite authority encoded frame is invalid.");
	if (
		parsed.codec !== 3 ||
		!Number.isSafeInteger(parsed.requestRef) ||
		parsed.requestRef !== expectedRequestRef ||
		!Number.isSafeInteger(parsed.receiptRef) ||
		parsed.receiptRef !== receipt.revision ||
		!Number.isSafeInteger(parsed.receiptControlIndex) ||
		!isRecord(parsed.frame)
	)
		throw new Error("SQLite authority frame reference or codec marker is invalid.");
	const frame = parsed.frame;
	const request = frame.request as Record<string, unknown> | undefined;
	const controls = frame.controls as Record<string, unknown>[] | undefined;
	const referenceMatches = (value: unknown, kind: string, referenceId: number): value is ReferenceV3 =>
		isRecord(value) && value.$authorityRef === kind && value.id === referenceId;
	if (
		!request ||
		!referenceMatches(request.requestId, "request", parsed.requestRef as number) ||
		!referenceMatches(frame.receipt, "receipt", parsed.receiptRef as number) ||
		!Array.isArray(controls)
	)
		throw new Error("SQLite authority frame structural references are inconsistent.");
	const control = controls[parsed.receiptControlIndex as number];
	if (
		!control ||
		!referenceMatches(control.key, "receipt-control-key", parsed.receiptRef as number) ||
		!referenceMatches(control.value, "receipt-control-value", parsed.receiptRef as number) ||
		control.deleted === true
	)
		throw new Error("SQLite authority receipt-control structural slot is inconsistent.");
	request.requestId = receipt.requestId;
	frame.receipt = receipt;
	control.key = receiptControlKey(receipt);
	control.value = restoreOrderV3(receipt, parsed.receiptControlOrder as OrderShapeV3);
	if (
		typeof request.requestId !== "string" ||
		request.requestId.length === 0 ||
		request.incarnation !== receipt.incarnation ||
		request.ownerEpoch !== receipt.ownerEpoch
	)
		throw new Error("SQLite authority receipt request identity is invalid.");
	return frame as unknown as AuthorityCommitFrame;
}
