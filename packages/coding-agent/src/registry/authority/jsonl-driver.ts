import * as fs from "node:fs";
import { hasPrivateMode } from "./private-mode";
import { directoryFsyncSupported } from "./directory-sync";
import { durableFsyncSync } from "./durable-sync";
import { refusedAuthorityStoreGuidance, repairSessionCommand } from "../../utils/resume-command";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	canonicalDurableSha256,
	durableGenesisHash,
	DurableStateConflictError,
	DurableStateUnavailableError,
	validateDurableRegistryRecord,
} from "../durable-state";
import type { DurableJournalRecord, DurableRegistryRecord } from "../durable-state";
import {
	authorityExportFromLegacySource,
	authorityKey,
	authorityRecordIsOpen,
	authorityRecordKey,
	compareAuthorityKeys,
	validateAuthorityFrame,
	validateAuthorityFrameState,
} from "./engine";
import type { AuthorityFrameState } from "./engine";
import type {
	AuthorityCommitFrame,
	AuthorityControl,
	AuthorityDomain,
	AuthorityDriverOptions,
	AuthorityExport,
	AuthorityIdentity,
	AuthorityPage,
	AuthorityPersistence,
	AuthorityRecordMap,
	AuthorityRow,
	AuthorityScan,
} from "./types";
import {
	AUTHORITY_JSONL_SEGMENT_MAX_FRAMES,
	AUTHORITY_JSONL_SEGMENT_MIN_BYTES,
	AuthorityGroupBoundaryError,
} from "./types";
import type { AuthorityGroupCommit } from "./types";
import { AuthorityCapacityAdmission } from "./capacity-sqlite";
import {
	AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES,
	classifyJsonlArtifact,
	jsonlLayout,
	jsonlRecoveryFile,
	listJsonlRotationArtifacts,
} from "./jsonl-layout";
import {
	AuthorityReplayState,
	AuthorityScratch,
	CanonicalHashWriter,
	loadExportBaseline,
	mergedControls,
	receiptKeyOf,
	verifyExportReader,
} from "./export-stream";
import type {
	AuthorityExportReader,
	AuthorityExportView,
	AuthoritySeedStream,
	AuthorityStreamFrame,
	ScratchMap,
} from "./export-stream";
import { isJsonArray, isJsonObject, jsonArrayElements, jsonObjectMembers, lineEnd, readJsonValue } from "./json-scan";
import type { JsonRange } from "./json-scan";
import type { JsonlLayout } from "./jsonl-layout";

const GENESIS_HASH = durableGenesisHash();
/** Bytes of a segment's first line read to classify its header when only the header is needed; segment headers fit easily. */
const SEGMENT_HEADER_PROBE_BYTES = 4096;
/**
 * First byte of every group-member line (JSON allows leading whitespace). Group members are appended without a
 * sync, so a crash may persist a member's prefix; open discards a torn tail only when it starts with this byte
 * right after a complete line, i.e. at a member boundary. A torn ungrouped line still refuses to open.
 */
const GROUP_MEMBER_MARKER = 0x20;
/** Longest frame line an owner writes; see AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES. */
const MAX_FRAME_LINE_BYTES = AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES;
/**
 * Most bytes one unsynced write episode can leave past the last acknowledged line: one group holds at most 8 MiB of
 * encoded requests (AUTHORITY_GROUP_COMMIT_LIMITS) and an ungrouped frame one 2 MiB request, each frame at most 5x its
 * request plus its skeleton. A longer suffix is not a crash cut of one episode.
 */
const MAX_UNACKNOWLEDGED_SUFFIX_BYTES = 64 * 1024 * 1024;
/** Every frame line (after an optional group marker) starts with these bytes: JSON.stringify of a frame object. */
const FRAME_LINE_PREFIX = Buffer.from('{"version":2,"kind":"commit",');
/** Filesystem blocks are multiples of this; a block the kernel never wrote back reads as zeros to its end. */
const UNWRITTEN_BLOCK_ALIGNMENT = 512;
const O_NOFOLLOW = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
const NEWLINE = 0x0a;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Bytes of the journal's last line retained to re-check the on-disk chain head before each append. */
const TAIL_CHECK_BYTES = 64 * 1024;
const LINE_CHAIN_SEED = 0n;
const DOMAINS: readonly AuthorityDomain[] = [
	"root",
	"actor",
	"construction",
	"gate",
	"operation",
	"transition",
	"resource",
	"local-entry",
	"local-head",
];
const NO_KEYS: ReadonlySet<string> = new Set();

type StoredRow = AuthorityRow<AuthorityRecordMap[AuthorityDomain]>;
type RowMaps = { [D in AuthorityDomain]: Map<string, AuthorityRow<AuthorityRecordMap[D]>> };

interface AuthorityHeader {
	readonly version: 2;
	readonly kind: "header";
	readonly identity: AuthorityIdentity;
	readonly seed?: AuthorityExport;
	readonly hash: string;
}

function emptyRows(): RowMaps {
	return {
		root: new Map(),
		actor: new Map(),
		construction: new Map(),
		gate: new Map(),
		operation: new Map(),
		transition: new Map(),
		resource: new Map(),
		"local-entry": new Map(),
		"local-head": new Map(),
	};
}

function addMember<K>(index: Map<K, Set<string>>, key: K, member: string): void {
	const members = index.get(key);
	if (members) members.add(member);
	else index.set(key, new Set([member]));
}

function removeMember<K>(index: Map<K, Set<string>>, key: K, member: string): void {
	const members = index.get(key);
	if (!members) return;
	members.delete(member);
	if (members.size === 0) index.delete(key);
}

/** Text before and including the first ":" of a control key; scans for a prefix that contains a colon only visit that family. */
function controlFamily(key: string): string | undefined {
	const colon = key.indexOf(":");
	return colon < 0 ? undefined : key.slice(0, colon + 1);
}

function receiptIndexKey(incarnation: string, requestId: string): string {
	return `${incarnation}\0${requestId}`;
}

interface ControlSlot {
	readonly present: boolean;
	readonly value: unknown;
}

/**
 * Current rows and controls plus the secondary indexes that keep reads and commit validation independent of
 * history: open rows per domain, actors per root, local entries per local and version, control-key families and
 * receipts per request. Every mutation goes through setRow/setControl so the indexes never diverge from the maps.
 */
class AuthorityState {
	readonly rows: RowMaps = emptyRows();
	readonly controls = new Map<string, unknown>();
	readonly #open = new Map<AuthorityDomain, Set<string>>(DOMAINS.map(domain => [domain, new Set<string>()]));
	readonly #actorsByRoot = new Map<string, Set<string>>();
	readonly #localEntries = new Map<string, Map<number, Set<string>>>();
	readonly #controlFamilies = new Map<string, Set<string>>();
	readonly #receipts = new Map<string, Set<string>>();

	/** Replaces (or with `undefined`, removes) a row and returns the row it displaced. */
	setRow(domain: AuthorityDomain, key: string, row: StoredRow | undefined): StoredRow | undefined {
		const rows = this.rows[domain] as Map<string, StoredRow>;
		const previous = rows.get(key);
		if (previous) this.#unindexRow(key, previous.record);
		if (row) {
			rows.set(key, row);
			this.#indexRow(key, row.record);
		} else rows.delete(key);
		return previous;
	}

	/** Sets (or with `present: false`, deletes) a control and returns the slot it displaced. */
	setControl(key: string, present: boolean, value?: unknown): ControlSlot {
		const previous: ControlSlot = { present: this.controls.has(key), value: this.controls.get(key) };
		if (previous.present) this.#unindexControl(key, previous.value);
		if (present) {
			this.controls.set(key, value);
			this.#indexControl(key, value);
		} else this.controls.delete(key);
		return previous;
	}

	/** Keys of every row that can satisfy `query`; callers still apply the full filter to each candidate. */
	scanKeys(domain: AuthorityDomain, query: AuthorityScan): Iterable<string> {
		if (domain === "local-entry" && query.localMatch)
			return this.#localEntries.get(query.localMatch.localId)?.get(query.localMatch.version) ?? NO_KEYS;
		if (query.openOnly) return this.#open.get(domain) ?? NO_KEYS;
		if (domain === "actor" && query.rootId !== undefined) return this.#actorsByRoot.get(query.rootId) ?? NO_KEYS;
		return this.rows[domain].keys();
	}

	/** Control keys that can start with `prefix`. */
	controlKeys(prefix: string): Iterable<string> {
		const family = controlFamily(prefix);
		return family === undefined ? this.controls.keys() : (this.#controlFamilies.get(family) ?? NO_KEYS);
	}

	/** Receipt keys whose receipt names this request; undefined when the arguments cannot use the index. */
	receiptKeys(requestId: unknown, incarnation: unknown): Iterable<string> | undefined {
		if (typeof requestId !== "string" || typeof incarnation !== "string") return undefined;
		return this.#receipts.get(receiptIndexKey(incarnation, requestId)) ?? NO_KEYS;
	}

	/** Local entries of `localId` at exactly `version` (the AuthorityFrameState contract), from the version index. */
	*localEntriesAt(localId: string, version: number): Generator<AuthorityRow<AuthorityRecordMap["local-entry"]>> {
		const keys = this.#localEntries.get(localId)?.get(version);
		if (!keys) return;
		for (const key of keys) {
			const row = this.rows["local-entry"].get(key);
			if (row) yield row;
		}
	}

	/** Open records in domain then row-insertion order; a construction-time walk, not a per-command one. */
	openRecords(): DurableRegistryRecord[] {
		const records: DurableRegistryRecord[] = [];
		for (const domain of DOMAINS) {
			for (const row of this.rows[domain].values()) if (authorityRecordIsOpen(row.record)) records.push(row.record);
		}
		return records;
	}

	#indexRow(key: string, record: DurableRegistryRecord): void {
		if (authorityRecordIsOpen(record)) this.#open.get(record.kind)?.add(key);
		if (record.kind === "actor") addMember(this.#actorsByRoot, record.rootId, key);
		if (record.kind === "local-entry") {
			let versions = this.#localEntries.get(record.localId);
			if (!versions) {
				versions = new Map();
				this.#localEntries.set(record.localId, versions);
			}
			addMember(versions, record.version, key);
		}
	}

	#unindexRow(key: string, record: DurableRegistryRecord): void {
		this.#open.get(record.kind)?.delete(key);
		if (record.kind === "actor") removeMember(this.#actorsByRoot, record.rootId, key);
		if (record.kind === "local-entry") {
			const versions = this.#localEntries.get(record.localId);
			if (!versions) return;
			removeMember(versions, record.version, key);
			if (versions.size === 0) this.#localEntries.delete(record.localId);
		}
	}

	#indexControl(key: string, value: unknown): void {
		const family = controlFamily(key);
		if (family !== undefined) addMember(this.#controlFamilies, family, key);
		const receipt = indexedReceipt(key, value);
		if (receipt) addMember(this.#receipts, receipt, key);
	}

	#unindexControl(key: string, value: unknown): void {
		const family = controlFamily(key);
		if (family !== undefined) removeMember(this.#controlFamilies, family, key);
		const receipt = indexedReceipt(key, value);
		if (receipt) removeMember(this.#receipts, receipt, key);
	}
}

function indexedReceipt(key: string, value: unknown): string | undefined {
	if (!key.startsWith("receipt:") || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const receipt = value as { readonly requestId?: unknown; readonly incarnation?: unknown };
	if (typeof receipt.requestId !== "string" || typeof receipt.incarnation !== "string") return undefined;
	return receiptIndexKey(receipt.incarnation, receipt.requestId);
}

function validIdentity(value: unknown): value is AuthorityIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Record<string, unknown>;
	return (
		Object.keys(identity).sort().join("\0") ===
			["backend", "format", "incarnation", "owningSessionId"].sort().join("\0") &&
		(identity.backend === "jsonl" || identity.backend === "sqlite") &&
		identity.format === 2 &&
		typeof identity.owningSessionId === "string" &&
		!!identity.owningSessionId &&
		!identity.owningSessionId.includes("\0") &&
		typeof identity.incarnation === "string" &&
		!!identity.incarnation &&
		!identity.incarnation.includes("\0")
	);
}

function assertIdentityEqual(actual: AuthorityIdentity, expected: AuthorityIdentity): void {
	if (
		!validIdentity(expected) ||
		actual.backend !== expected.backend ||
		actual.format !== expected.format ||
		actual.owningSessionId !== expected.owningSessionId ||
		actual.incarnation !== expected.incarnation
	)
		throw new Error("Authority JSONL identity does not match the selected store.");
}

function headerHash(header: Omit<AuthorityHeader, "hash">): string {
	return canonicalDurableSha256(header);
}

function headerBytes(identity: AuthorityIdentity, seed?: AuthorityExport): Buffer {
	const headerBase = { version: 2 as const, kind: "header" as const, identity, ...(seed ? { seed } : {}) };
	const header: AuthorityHeader = { ...headerBase, hash: headerHash(headerBase) };
	return Buffer.from(`${JSON.stringify(header)}\n`);
}

/**
 * A sibling file bound by its exact length and SHA-256. `file` is relative to the store's stem (for example
 * `snapshot.3.json`), so a store copied or moved under another active name still resolves its own files.
 */
interface FileRef {
	readonly file: string;
	readonly bytes: number;
	readonly sha256: string;
}

/** Committed position a segment continues from: the last frame of the previous segment and the snapshot of the state there. */
interface SegmentBase {
	readonly revision: number;
	readonly headHash: string;
	readonly generationHighWater: number;
	readonly snapshot: FileRef;
}

/** First line of active segment n >= 1. Version 3 so that a binary which knows only version 2 refuses it. */
interface SegmentHeader {
	readonly version: 3;
	readonly kind: "header";
	readonly identity: AuthorityIdentity;
	readonly segment: number;
	readonly base: SegmentBase;
	readonly hash: string;
}

type ParsedHeader =
	| { readonly version: 2; readonly header: AuthorityHeader }
	| { readonly version: 3; readonly header: SegmentHeader };

/** Index of a sealed segment, chained to the previous segment's index through `previous`. */
interface SegmentIndex {
	readonly version: 1;
	readonly kind: "segment-index";
	readonly identity: AuthorityIdentity;
	readonly segment: number;
	readonly segmentBytes: number;
	readonly segmentSha256: string;
	readonly firstRevision: number;
	readonly lastRevision: number;
	readonly headHash: string;
	readonly previous: FileRef | null;
	/** Every receipt control introduced by the segment (seed or frames), sorted by key. */
	readonly receipts: readonly AuthorityControl[];
}

/** Compacted state at the start of active segment `segment`; receipts live in the sealed indexes, not here. */
interface SegmentSnapshot {
	readonly version: 1;
	readonly kind: "snapshot";
	readonly identity: AuthorityIdentity;
	readonly segment: number;
	readonly revision: number;
	readonly headHash: string;
	readonly generationHighWater: number;
	readonly rows: readonly AuthorityRow[];
	readonly controls: readonly AuthorityControl[];
	readonly sealed: {
		/** Index of segment `segment - 1`, the head of the index chain. */
		readonly index: FileRef;
		/** Highest owner epoch of any sealed receipt of this store's incarnation (0 when none). */
		readonly receiptEpoch: number;
	};
}

const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function snapshotMember(segment: number): string {
	return `snapshot.${segment}.json`;
}

function indexMember(segment: number): string {
	return `segment.${segment}.index.json`;
}

function validFileRef(value: unknown, expectedFile: string): value is FileRef {
	return (
		isPlainObject(value) &&
		exactKeys(value, ["file", "bytes", "sha256"]) &&
		value.file === expectedFile &&
		Number.isSafeInteger(value.bytes) &&
		(value.bytes as number) > 0 &&
		typeof value.sha256 === "string" &&
		SHA256_RE.test(value.sha256)
	);
}

function validRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function segmentHeaderBytes(identity: AuthorityIdentity, segment: number, base: SegmentBase): Buffer {
	const content = { version: 3 as const, kind: "header" as const, identity, segment, base };
	const header: SegmentHeader = { ...content, hash: canonicalDurableSha256(content) };
	return Buffer.from(`${JSON.stringify(header)}\n`);
}

function verifySegmentHeader(
	value: Record<string, unknown>,
	identity: AuthorityIdentity,
	layout: JsonlLayout,
): SegmentHeader {
	if (
		!exactKeys(value, ["version", "kind", "identity", "segment", "base", "hash"]) ||
		value.kind !== "header" ||
		!validIdentity(value.identity)
	)
		throw new Error("Authority JSONL segment header fields are invalid.");
	assertIdentityEqual(value.identity, identity);
	const segment = value.segment;
	if (!Number.isSafeInteger(segment) || (segment as number) < 1)
		throw new Error("Authority JSONL segment number is invalid.");
	const base = value.base;
	if (
		!isPlainObject(base) ||
		!exactKeys(base, ["revision", "headHash", "generationHighWater", "snapshot"]) ||
		!validRevision(base.revision) ||
		typeof base.headHash !== "string" ||
		!SHA256_RE.test(base.headHash) ||
		!validRevision(base.generationHighWater) ||
		!validFileRef(base.snapshot, snapshotMember(segment as number))
	)
		throw new Error("Authority JSONL segment base is invalid.");
	const { hash, ...content } = value;
	if (typeof hash !== "string" || hash !== canonicalDurableSha256(content))
		throw new Error("Authority JSONL segment header hash mismatch.");
	return value as unknown as SegmentHeader;
}

/** Parses and verifies a segment's first line; a version this binary does not know is refused, never guessed. */
function parseSegmentHeader(text: string, identity: AuthorityIdentity, layout: JsonlLayout): ParsedHeader {
	if (!text) throw new DurableStateUnavailableError("Authority JSONL header is missing.");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new DurableStateUnavailableError("Authority JSONL header is not valid JSON.");
	}
	if (!isPlainObject(value)) throw new Error("Authority JSONL header is invalid.");
	if (value.version === 2) return { version: 2, header: verifyHeader(value, identity) };
	if (value.version === 3) return { version: 3, header: verifySegmentHeader(value, identity, layout) };
	throw new Error("Unsupported authority JSONL header.");
}

/** Reads a whole private regular file that must not change while it is read. */
function readPrivateFile(file: string, missing: string): Buffer {
	let handle: number;
	try {
		handle = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DurableStateUnavailableError(missing);
		throw error;
	}
	try {
		const before = fs.fstatSync(handle, { bigint: true });
		if (!before.isFile() || !hasPrivateMode(before.mode))
			throw new DurableStateUnavailableError(
				`Authority JSONL artifact must be a private regular file: ${path.basename(file)}`,
			);
		const length = Number(before.size);
		if (!Number.isSafeInteger(length))
			throw new DurableStateUnavailableError("Authority JSONL artifact is too large to read.");
		const bytes = length === 0 ? Buffer.alloc(0) : readExactly(handle, 0, length);
		if (!sameObservation(before, fs.fstatSync(handle, { bigint: true })))
			throw new DurableStateUnavailableError(
				`Authority JSONL artifact changed while it was read: ${path.basename(file)}`,
			);
		return bytes;
	} finally {
		fs.closeSync(handle);
	}
}

/** Reads the sibling named by `ref` and proves it holds exactly the bound bytes. */
function readBoundFile(layout: JsonlLayout, ref: FileRef, what: string): Buffer {
	const bytes = readPrivateFile(`${layout.stem}.${ref.file}`, `Authority JSONL ${what} is missing: ${ref.file}`);
	if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.sha256)
		throw new DurableStateUnavailableError(`Authority JSONL ${what} does not match its recorded digest: ${ref.file}`);
	return bytes;
}

function parseDocumentLine(bytes: Buffer, what: string): Record<string, unknown> {
	if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== NEWLINE)
		throw new DurableStateUnavailableError(`Authority JSONL ${what} is torn.`);
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8", 0, bytes.byteLength - 1));
	} catch {
		throw new DurableStateUnavailableError(`Authority JSONL ${what} is not valid JSON.`);
	}
	if (!isPlainObject(value)) throw new DurableStateUnavailableError(`Authority JSONL ${what} is invalid.`);
	return value;
}

/** Row shape only; duplicate identities are refused while the rows are loaded (loadSnapshot). */
function validRows(value: unknown): value is readonly AuthorityRow[] {
	if (!Array.isArray(value)) return false;
	for (const row of value) {
		if (
			!isPlainObject(row) ||
			!exactKeys(row, ["record", "version"]) ||
			!Number.isSafeInteger(row.version) ||
			(row.version as number) < 1 ||
			!isPlainObject(row.record) ||
			!DOMAINS.includes(row.record.kind as AuthorityDomain)
		)
			return false;
	}
	return true;
}

function validControls(value: unknown, receipts: boolean): value is readonly AuthorityControl[] {
	if (!Array.isArray(value)) return false;
	let previous: string | undefined;
	for (const control of value) {
		if (
			!isPlainObject(control) ||
			!exactKeys(control, ["key", "value"]) ||
			typeof control.key !== "string" ||
			!control.key ||
			control.key.includes("\0") ||
			control.key.startsWith("receipt:") !== receipts ||
			control.value === undefined
		)
			return false;
		// Sorted and unique, so a receipt index can be searched by bisection.
		if (previous !== undefined && compareAuthorityKeys(previous, control.key) >= 0) return false;
		previous = control.key;
	}
	return true;
}

/** Loads and verifies the snapshot an active segment header names; cost is proportional to the snapshot. */
function readSnapshot(layout: JsonlLayout, header: SegmentHeader, identity: AuthorityIdentity): SegmentSnapshot {
	const value = parseDocumentLine(readBoundFile(layout, header.base.snapshot, "snapshot"), "snapshot");
	const base = header.base;
	const sealed = value.sealed;
	if (
		!exactKeys(value, [
			"version",
			"kind",
			"identity",
			"segment",
			"revision",
			"headHash",
			"generationHighWater",
			"rows",
			"controls",
			"sealed",
		]) ||
		value.version !== 1 ||
		value.kind !== "snapshot" ||
		!validIdentity(value.identity) ||
		value.segment !== header.segment ||
		value.revision !== base.revision ||
		value.headHash !== base.headHash ||
		value.generationHighWater !== base.generationHighWater ||
		!validRows(value.rows) ||
		!validControls(value.controls, false) ||
		!isPlainObject(sealed) ||
		!exactKeys(sealed, ["index", "receiptEpoch"]) ||
		!validFileRef(sealed.index, indexMember(header.segment - 1)) ||
		!validRevision(sealed.receiptEpoch)
	)
		throw new DurableStateUnavailableError("Authority JSONL snapshot does not match its segment header.");
	assertIdentityEqual(value.identity, identity);
	const meta = (value.controls as readonly AuthorityControl[]).find(control => control.key === "meta")?.value;
	if (
		!isPlainObject(meta) ||
		meta.revision !== base.revision ||
		meta.headHash !== base.headHash ||
		meta.generationHighWater !== base.generationHighWater
	)
		throw new DurableStateUnavailableError("Authority JSONL snapshot metadata does not match its segment header.");
	return value as unknown as SegmentSnapshot;
}

function readSegmentIndex(
	layout: JsonlLayout,
	ref: FileRef,
	segment: number,
	identity: AuthorityIdentity,
): { readonly index: SegmentIndex; readonly bytes: Buffer } {
	const bytes = readBoundFile(layout, ref, "segment index");
	return { index: parseSegmentIndex(bytes, segment, identity), bytes };
}

function parseSegmentIndex(bytes: Buffer, segment: number, identity: AuthorityIdentity): SegmentIndex {
	const value = parseDocumentLine(bytes, "segment index");
	if (
		!exactKeys(value, [
			"version",
			"kind",
			"identity",
			"segment",
			"segmentBytes",
			"segmentSha256",
			"firstRevision",
			"lastRevision",
			"headHash",
			"previous",
			"receipts",
		]) ||
		value.version !== 1 ||
		value.kind !== "segment-index" ||
		!validIdentity(value.identity) ||
		value.segment !== segment ||
		!Number.isSafeInteger(value.segmentBytes) ||
		(value.segmentBytes as number) < 1 ||
		typeof value.segmentSha256 !== "string" ||
		!SHA256_RE.test(value.segmentSha256) ||
		!validRevision(value.firstRevision) ||
		!validRevision(value.lastRevision) ||
		typeof value.headHash !== "string" ||
		!SHA256_RE.test(value.headHash) ||
		(segment === 0 ? value.previous !== null : !validFileRef(value.previous, indexMember(segment - 1))) ||
		!validControls(value.receipts, true)
	)
		throw new DurableStateUnavailableError(`Authority JSONL segment ${segment} index is invalid.`);
	assertIdentityEqual(value.identity, identity);
	return value as unknown as SegmentIndex;
}

/** Receipt key components `[incarnation, ownerEpoch, requestId]`, or undefined when the key is not a well-formed receipt key. */
function receiptKeyParts(
	key: string,
): { readonly incarnation: string; readonly epoch: number; readonly requestId: string } | undefined {
	if (!key.startsWith("receipt:")) return undefined;
	let parts: unknown;
	try {
		parts = JSON.parse(key.slice("receipt:".length));
	} catch {
		return undefined;
	}
	if (
		!Array.isArray(parts) ||
		parts.length !== 3 ||
		typeof parts[0] !== "string" ||
		!Number.isSafeInteger(parts[1]) ||
		typeof parts[2] !== "string"
	)
		return undefined;
	return { incarnation: parts[0], epoch: parts[1], requestId: parts[2] };
}

const JSON_QUOTE = 0x22;
const JSON_BACKSLASH = 0x5c;
const JSON_COMMA = 0x2c;
const JSON_COLON = 0x3a;
const JSON_OPEN_OBJECT = 0x7b;
const JSON_CLOSE_OBJECT = 0x7d;
const JSON_OPEN_ARRAY = 0x5b;
const JSON_CLOSE_ARRAY = 0x5d;

function isJsonWhitespace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function skipJsonWhitespace(bytes: Buffer, position: number): number {
	while (isJsonWhitespace(bytes[position])) position++;
	return position;
}

/** End offset of the JSON value that starts at `start`, in a document already proven to be valid JSON. */
function skipJsonValue(bytes: Buffer, start: number): number {
	const first = bytes[start];
	if (first === JSON_QUOTE) {
		for (let position = start + 1; position < bytes.length; position++) {
			const byte = bytes[position];
			if (byte === JSON_BACKSLASH) position++;
			else if (byte === JSON_QUOTE) return position + 1;
		}
	} else if (first === JSON_OPEN_OBJECT || first === JSON_OPEN_ARRAY) {
		let depth = 0;
		let inString = false;
		for (let position = start; position < bytes.length; position++) {
			const byte = bytes[position];
			if (inString) {
				if (byte === JSON_BACKSLASH) position++;
				else if (byte === JSON_QUOTE) inString = false;
			} else if (byte === JSON_QUOTE) inString = true;
			else if (byte === JSON_OPEN_OBJECT || byte === JSON_OPEN_ARRAY) depth++;
			else if ((byte === JSON_CLOSE_OBJECT || byte === JSON_CLOSE_ARRAY) && --depth === 0) return position + 1;
		}
	} else {
		let position = start;
		while (
			position < bytes.length &&
			!isJsonWhitespace(bytes[position]) &&
			bytes[position] !== JSON_COMMA &&
			bytes[position] !== JSON_CLOSE_OBJECT &&
			bytes[position] !== JSON_CLOSE_ARRAY
		)
			position++;
		if (position > start) return position;
	}
	throw new DurableStateUnavailableError("Authority JSONL segment index is not valid JSON.");
}

/**
 * Byte ranges of the elements of a segment index document's top-level `receipts` array, as a flat
 * `[start0, end0, start1, end1, ...]` list in array order. The document must already have parsed as JSON.
 */
function receiptSpans(bytes: Buffer): number[] {
	const invalid = (): never => {
		throw new DurableStateUnavailableError("Authority JSONL segment index is not valid JSON.");
	};
	const spans: number[] = [];
	let found = false;
	let position = skipJsonWhitespace(bytes, 0);
	if (bytes[position] !== JSON_OPEN_OBJECT) invalid();
	position = skipJsonWhitespace(bytes, position + 1);
	while (bytes[position] !== JSON_CLOSE_OBJECT) {
		const keyEnd = skipJsonValue(bytes, position);
		const key = JSON.parse(bytes.toString("utf8", position, keyEnd)) as unknown;
		position = skipJsonWhitespace(bytes, keyEnd);
		if (bytes[position] !== JSON_COLON) invalid();
		position = skipJsonWhitespace(bytes, position + 1);
		if (key === "receipts") {
			if (found || bytes[position] !== JSON_OPEN_ARRAY) invalid();
			found = true;
			position = skipJsonWhitespace(bytes, position + 1);
			while (bytes[position] !== JSON_CLOSE_ARRAY) {
				const end = skipJsonValue(bytes, position);
				spans.push(position, end);
				position = skipJsonWhitespace(bytes, end);
				if (bytes[position] === JSON_COMMA) position = skipJsonWhitespace(bytes, position + 1);
				else if (bytes[position] !== JSON_CLOSE_ARRAY) invalid();
			}
			position++;
		} else position = skipJsonValue(bytes, position);
		position = skipJsonWhitespace(bytes, position);
		if (bytes[position] === JSON_COMMA) position = skipJsonWhitespace(bytes, position + 1);
		else if (bytes[position] !== JSON_CLOSE_OBJECT) invalid();
	}
	if (!found) invalid();
	return spans;
}

const SEALED_LOOKUP_INITIAL_CAPACITY = 1024;
const NO_ENTRY = -1;

/**
 * Where every sealed receipt lives, for the lookups the in-memory state cannot answer (by request id alone, or by
 * a key at or below the receipt floor). Each sealed index is read and digest-verified once, when the lookup is
 * built; sealed indexes are immutable, so its entries stay valid for the driver's lifetime and a rotation only
 * adds the index it seals. The receipts stay on disk: an entry records the receipt's byte range in its index file
 * and a 64-bit hash of those bytes taken from the verified index, and a lookup reads the range back and proves it
 * against that hash before parsing it.
 *
 * Memory per sealed receipt: one Map entry keyed by request id (about 70 bytes for a 36-character id) plus 28
 * bytes of columns (chain link, segment, offset, length, hash), at most doubled by column growth slack: roughly
 * 100 to 160 bytes, against about 940 bytes for a parsed receipt control.
 */
class SealedReceiptLookup {
	readonly #files: string[] = [];
	readonly #fileBytes: number[] = [];
	/** First entry per request id; further entries of the same request id are chained through `#next`. */
	readonly #heads = new Map<string, number>();
	#count = 0;
	#next = new Int32Array(SEALED_LOOKUP_INITIAL_CAPACITY);
	#segment = new Uint32Array(SEALED_LOOKUP_INITIAL_CAPACITY);
	#offset = new Float64Array(SEALED_LOOKUP_INITIAL_CAPACITY);
	#length = new Uint32Array(SEALED_LOOKUP_INITIAL_CAPACITY);
	#hash = new BigUint64Array(SEALED_LOOKUP_INITIAL_CAPACITY);

	/**
	 * Adds the receipts of sealed index `index`, whose exact bytes `bytes` were verified against `ref` (or written
	 * by this owner), stored at `file`. Every receipt key must name the request and incarnation its value records,
	 * which is what lets one lookup by request id answer both key and request-id queries.
	 */
	add(file: string, ref: FileRef, bytes: Buffer, index: SegmentIndex): void {
		const segment = index.segment;
		const spans = receiptSpans(bytes);
		if (spans.length !== index.receipts.length * 2)
			throw new DurableStateUnavailableError(
				`Authority JSONL segment ${segment} index receipts could not be located.`,
			);
		this.#files[segment] = file;
		this.#fileBytes[segment] = ref.bytes;
		for (let position = 0; position < index.receipts.length; position++) {
			const control = index.receipts[position]!;
			const parts = receiptKeyParts(control.key);
			const value = control.value;
			if (
				!parts ||
				!isPlainObject(value) ||
				value.requestId !== parts.requestId ||
				value.incarnation !== parts.incarnation
			)
				throw new DurableStateUnavailableError(
					`Authority JSONL segment ${segment} index holds a receipt that does not match its key.`,
				);
			const start = spans[position * 2]!;
			const end = spans[position * 2 + 1]!;
			this.#append(parts.requestId, segment, start, end - start, Bun.hash.wyhash(bytes.subarray(start, end)));
		}
	}

	/** Every sealed receipt control whose key names `requestId`, each read back and proved against its verified bytes. */
	controls(requestId: string): AuthorityControl[] {
		const controls: AuthorityControl[] = [];
		for (let entry = this.#heads.get(requestId) ?? NO_ENTRY; entry !== NO_ENTRY; entry = this.#next[entry]!) {
			const control = this.#read(entry);
			if (receiptKeyParts(control.key)?.requestId !== requestId)
				throw new DurableStateUnavailableError("Authority JSONL sealed receipt does not match its index entry.");
			controls.push(control);
		}
		return controls;
	}

	#append(requestId: string, segment: number, offset: number, length: number, hash: bigint): void {
		if (this.#count === this.#next.length) this.#grow();
		const entry = this.#count++;
		this.#segment[entry] = segment;
		this.#offset[entry] = offset;
		this.#length[entry] = length;
		this.#hash[entry] = hash;
		this.#next[entry] = this.#heads.get(requestId) ?? NO_ENTRY;
		this.#heads.set(requestId, entry);
	}

	#grow(): void {
		const capacity = this.#next.length * 2;
		const next = new Int32Array(capacity);
		next.set(this.#next);
		this.#next = next;
		const segment = new Uint32Array(capacity);
		segment.set(this.#segment);
		this.#segment = segment;
		const offset = new Float64Array(capacity);
		offset.set(this.#offset);
		this.#offset = offset;
		const length = new Uint32Array(capacity);
		length.set(this.#length);
		this.#length = length;
		const hash = new BigUint64Array(capacity);
		hash.set(this.#hash);
		this.#hash = hash;
	}

	#read(entry: number): AuthorityControl {
		const segment = this.#segment[entry]!;
		const file = this.#files[segment]!;
		let handle: number;
		try {
			handle = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new DurableStateUnavailableError(`Authority JSONL segment ${segment} index is missing.`);
			throw error;
		}
		let bytes: Buffer;
		try {
			const stat = fs.fstatSync(handle, { bigint: true });
			if (!stat.isFile() || stat.size !== BigInt(this.#fileBytes[segment]!))
				throw new DurableStateUnavailableError(
					`Authority JSONL segment ${segment} index changed after it was verified.`,
				);
			bytes = readExactly(handle, this.#offset[entry]!, this.#length[entry]!);
		} finally {
			fs.closeSync(handle);
		}
		if (Bun.hash.wyhash(bytes) !== this.#hash[entry])
			throw new DurableStateUnavailableError(
				`Authority JSONL segment ${segment} index changed after it was verified.`,
			);
		return JSON.parse(bytes.toString("utf8")) as AuthorityControl;
	}
}

/**
 * Inode identity plus the timestamps observed when this owner last proved the journal's bytes. A write(2),
 * truncation, allocation or attribute change by another file description moves ctime and mtime. A store through
 * a shared mapping whose page is already dirty need not move them again, so the fence detects foreign writers,
 * it does not exclude them: exclusion is the ownership lock, and `integrityCheck` re-reads every byte.
 */
interface FileFence {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

function fenceOf(stat: fs.BigIntStats): FileFence {
	return Object.freeze({
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	});
}

function sameFile(
	stat: Pick<FileFence, "dev" | "ino" | "mode">,
	fence: Pick<FileFence, "dev" | "ino" | "mode">,
): boolean {
	return stat.dev === fence.dev && stat.ino === fence.ino && stat.mode === fence.mode;
}

function sameObservation(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return (
		sameFile(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function readExactly(handle: number, position: number, length: number): Buffer {
	const bytes = Buffer.allocUnsafe(length);
	let offset = 0;
	while (offset < length) {
		const read = fs.readSync(handle, bytes, offset, length - offset, position + offset);
		if (read <= 0) throw new Error("Authority JSONL ended before its expected length.");
		offset += read;
	}
	return bytes;
}

function tailOf(line: Buffer): Buffer {
	return Buffer.from(line.subarray(Math.max(0, line.byteLength - TAIL_CHECK_BYTES)));
}

/**
 * Streams `[0, length)` of the descriptor in bounded chunks and calls `onLine` with each complete line including
 * its newline. The buffer passed to `onLine` is reused afterwards, so callers copy anything they keep.
 */
function forEachLine(handle: number, length: number, onLine: (line: Buffer, index: number, end: number) => void): void {
	let buffer = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, length)));
	let start = 0;
	let end = 0;
	let position = 0;
	let index = 0;
	while (position < length) {
		if (end === buffer.byteLength) {
			if (start > 0) {
				buffer.copy(buffer, 0, start, end);
				end -= start;
				start = 0;
			} else {
				if (index > 0 && end >= MAX_FRAME_LINE_BYTES)
					throw new DurableStateUnavailableError("Authority JSONL has a line longer than any frame.");
				const grown = Buffer.allocUnsafe(buffer.byteLength * 2);
				buffer.copy(grown, 0, 0, end);
				buffer = grown;
			}
		}
		const read = fs.readSync(handle, buffer, end, Math.min(buffer.byteLength - end, length - position), position);
		if (read <= 0) throw new Error("Authority JSONL ended before its observed length.");
		end += read;
		position += read;
		const filled = buffer.subarray(0, end);
		let newline = filled.indexOf(NEWLINE, start);
		while (newline !== -1) {
			onLine(filled.subarray(start, newline + 1), index++, position - end + newline + 1);
			start = newline + 1;
			newline = filled.indexOf(NEWLINE, start);
		}
	}
	if (start !== end) throw new DurableStateUnavailableError("Authority JSONL ends with a torn line.");
}

/** Chained per-line hash of the journal: each line is hashed with the previous line's hash as its seed. */
function chainLine(chain: bigint, line: Buffer): bigint {
	return Bun.hash.xxHash3(line, chain);
}

function journalChain(handle: number, length: number): bigint {
	let chain = LINE_CHAIN_SEED;
	forEachLine(handle, length, line => {
		chain = chainLine(chain, line);
	});
	return chain;
}

function openJournal(file: string): { readonly handle: number; readonly stat: fs.BigIntStats } {
	let handle: number;
	try {
		handle = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new DurableStateUnavailableError("Selected authority JSONL payload is missing.");
		throw error;
	}
	try {
		const stat = fs.fstatSync(handle, { bigint: true });
		if (!stat.isFile())
			throw new DurableStateUnavailableError("Selected authority JSONL payload is not a regular file.");
		return { handle, stat };
	} catch (error) {
		fs.closeSync(handle);
		throw error;
	}
}

function fsyncDirectory(directory: string): void {
	if (!directoryFsyncSupported()) return;
	const handle = fs.openSync(directory, fs.constants.O_RDONLY | O_NOFOLLOW);
	try {
		durableFsyncSync(handle);
	} finally {
		fs.closeSync(handle);
	}
}

function verifyHeader(value: unknown, identity: AuthorityIdentity): AuthorityHeader {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Authority JSONL header is invalid.");
	const header = value as Record<string, unknown>;
	const keys = Object.keys(header).sort().join("\0");
	if (
		keys !== ["hash", "identity", "kind", "seed", "version"].sort().join("\0") &&
		keys !== ["hash", "identity", "kind", "version"].sort().join("\0")
	)
		throw new Error("Authority JSONL header fields are invalid.");
	if (header.version !== 2 || header.kind !== "header" || !validIdentity(header.identity))
		throw new Error("Unsupported authority JSONL header.");
	assertIdentityEqual(header.identity, identity);
	const { hash, ...content } = header;
	if (typeof hash !== "string" || hash !== canonicalDurableSha256(content))
		throw new Error("Authority JSONL header hash mismatch.");
	if ("seed" in header) {
		verifyExport(header.seed, identity);
		return { version: header.version, kind: header.kind, identity: header.identity, seed: header.seed, hash };
	}
	return { version: header.version, kind: header.kind, identity: header.identity, hash };
}

function verifyExport(value: unknown, expectedIdentity: AuthorityIdentity): asserts value is AuthorityExport {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Authority seed export is invalid.");
	const exported = value as Record<string, unknown>;
	const { sourceIdentity, revision, generationHighWater, headHash } = exported;
	if (
		exported.version !== 2 ||
		!validIdentity(sourceIdentity) ||
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 0 ||
		typeof generationHighWater !== "number" ||
		!Number.isSafeInteger(generationHighWater) ||
		generationHighWater < 0 ||
		typeof headHash !== "string" ||
		!Array.isArray(exported.rows) ||
		!Array.isArray(exported.controls) ||
		!Array.isArray(exported.frames)
	)
		throw new Error("Authority seed export is invalid.");
	if (sourceIdentity.owningSessionId !== expectedIdentity.owningSessionId)
		throw new Error("Authority seed belongs to a different owning session.");
	const rows: readonly unknown[] = exported.rows;
	const rowKeys = new Set<string>();
	if (
		!rows.every((value): value is AuthorityRow => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return false;
			const row = value as Record<string, unknown>;
			if (typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) return false;
			validateDurableRegistryRecord(row.record);
			const key = authorityKey(row.record.kind, authorityRecordKey(row.record));
			if (rowKeys.has(key)) throw new Error("Authority seed contains duplicate row identities.");
			rowKeys.add(key);
			return true;
		}) ||
		rowKeys.size !== rows.length
	)
		throw new Error("Authority seed row version is invalid.");
	const controls: readonly unknown[] = exported.controls;
	const controlKeys = new Set<string>();
	if (
		!controls.every((value): value is AuthorityControl => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return false;
			const control = value as Record<string, unknown>;
			if (
				typeof control.key !== "string" ||
				control.key.length === 0 ||
				control.key.includes("\0") ||
				controlKeys.has(control.key)
			)
				return false;
			controlKeys.add(control.key);
			canonicalDurableSha256(control.value);
			return true;
		}) ||
		controlKeys.size !== controls.length
	)
		throw new Error("Authority seed control is invalid or duplicated.");
	const frames: readonly unknown[] = exported.frames;
	let legacyBaseline: AuthorityExport | undefined;
	if (exported.legacy !== undefined) {
		const legacy = exported.legacy;
		if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
			throw new Error("Authority seed legacy provenance is invalid.");
		const provenance = legacy as Record<string, unknown>;
		if (
			Object.keys(provenance).sort().join("\0") !== ["entries", "sourceSha256"].join("\0") ||
			typeof provenance.sourceSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(provenance.sourceSha256) ||
			!Array.isArray(provenance.entries)
		)
			throw new Error("Authority seed legacy provenance is invalid.");
		const entries: readonly unknown[] = provenance.entries;
		let ordinal = 1;
		if (
			!entries.every((value): value is DurableJournalRecord => {
				if (!value || typeof value !== "object" || Array.isArray(value)) return false;
				const entry = value as Record<string, unknown>;
				if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== ordinal++)
					throw new Error("Authority seed legacy ordinals are discontinuous.");
				if (
					entry.version !== 1 ||
					typeof entry.previousHash !== "string" ||
					typeof entry.contentHash !== "string" ||
					typeof entry.hash !== "string"
				)
					return false;
				validateDurableRegistryRecord(entry.record);
				return true;
			}) ||
			ordinal !== entries.length + 1
		)
			throw new Error("Authority seed legacy entry is invalid.");
		legacyBaseline = authorityExportFromLegacySource(sourceIdentity, {
			sourceSha256: provenance.sourceSha256,
			entries,
		});
	} else if (frames.length === 0 && (rows.length > 0 || controlKeys.size !== 1)) {
		throw new Error("Authority seed rows are missing legacy or committed-frame evidence.");
	}
	const meta = controls.find(control => control.key === "meta")?.value;
	if (!meta || typeof meta !== "object" || Array.isArray(meta))
		throw new Error("Authority seed metadata does not match its exported identity.");
	const metadata = meta as Record<string, unknown>;
	if (
		metadata.revision !== revision ||
		metadata.generationHighWater !== generationHighWater ||
		metadata.headHash !== headHash ||
		!/^[a-f0-9]{64}$/.test(headHash) ||
		(metadata.status !== "ready" && metadata.status !== "quarantined") ||
		(metadata.status === "quarantined" &&
			(typeof metadata.quarantineReason !== "string" || metadata.quarantineReason.length === 0)) ||
		(metadata.status === "ready" && metadata.quarantineReason !== undefined)
	)
		throw new Error("Authority seed metadata does not match its exported identity.");
	let previousHash = GENESIS_HASH;
	let frameRevision = 0;
	const framedReceipts = new Map<string, string>();
	for (const frame of frames) {
		validateAuthorityFrame(frame, previousHash);
		if (frame.revision !== frameRevision + 1) throw new Error("Authority seed frame revision is discontinuous.");
		previousHash = frame.hash;
		frameRevision = frame.revision;
		const key = `receipt:${JSON.stringify([frame.request.incarnation, frame.request.ownerEpoch, frame.request.requestId])}`;
		framedReceipts.set(key, canonicalDurableSha256(frame.receipt));
	}
	for (const control of controls) {
		if (!control.key.startsWith("receipt:")) continue;
		if (framedReceipts.get(control.key) !== canonicalDurableSha256(control.value))
			throw new Error("Authority seed receipt controls do not match committed frame evidence.");
		framedReceipts.delete(control.key);
	}
	if (framedReceipts.size > 0) throw new Error("Authority seed is missing committed receipt controls.");
	if (frames.length > 0 && (frameRevision !== revision || previousHash !== headHash))
		throw new Error("Authority seed frame head does not match metadata.");
	if (frames.length === 0 && (revision !== 0 || headHash !== GENESIS_HASH))
		throw new Error("Authority seed is missing command evidence.");
	verifyExportProjection({ rows, controls, frames, revision, headHash }, legacyBaseline);
}

function frameState(state: AuthorityState): AuthorityFrameState {
	return {
		get<D extends AuthorityDomain>(
			domain: D,
			key: readonly (string | number)[],
		): AuthorityRow<AuthorityRecordMap[D]> | undefined {
			return state.rows[domain].get(authorityKey(domain, key)) as AuthorityRow<AuthorityRecordMap[D]> | undefined;
		},
		getControl: key => state.controls.get(key),
		localEntriesAt: (localId, version) => state.localEntriesAt(localId, version),
	};
}

function genesisMeta(): AuthorityControl["value"] {
	return { revision: 0, generationHighWater: 0, status: "ready", headHash: GENESIS_HASH };
}

function verifyExportProjection(
	value: Pick<AuthorityExport, "rows" | "controls" | "revision" | "headHash"> & {
		readonly frames: readonly unknown[];
	},
	legacyBaseline: AuthorityExport | undefined,
): void {
	const state = new AuthorityState();
	if (legacyBaseline) {
		for (const row of legacyBaseline.rows)
			state.setRow(row.record.kind, authorityKey(row.record.kind, authorityRecordKey(row.record)), row);
		for (const control of legacyBaseline.controls) state.setControl(control.key, true, control.value);
	} else state.setControl("meta", true, genesisMeta());
	let revision = 0;
	let previousHash = GENESIS_HASH;
	for (const frame of value.frames) {
		validateAuthorityFrame(frame, previousHash);
		if (frame.revision !== revision + 1) throw new Error("Authority export frame sequence is invalid.");
		const expectedVersions = new Map<string, number | null>();
		for (const expected of frame.expected) {
			const key = authorityKey(expected.domain, expected.key);
			expectedVersions.set(key, expected.version);
			if ((state.rows[expected.domain].get(key)?.version ?? null) !== expected.version)
				throw new Error("Authority export frame expected row version does not match replay.");
		}
		validateAuthorityFrameState(frame, frameState(state));
		for (const row of frame.changes) {
			const key = authorityKey(row.record.kind, authorityRecordKey(row.record));
			if (!expectedVersions.has(key) || row.version !== (expectedVersions.get(key) ?? 0) + 1)
				throw new Error("Authority export changed row version does not match replay.");
			state.setRow(row.record.kind, key, row);
		}
		for (const change of frame.controls) {
			if (change.deleted) state.setControl(change.key, false);
			else if (change.key !== "meta") state.setControl(change.key, true, change.value);
		}
		const metaChange = frame.controls.find(change => change.key === "meta");
		if (!metaChange || metaChange.deleted) throw new Error("Authority frame is missing metadata.");
		state.setControl("meta", true, { ...(metaChange.value as object), headHash: frame.hash });
		revision = frame.revision;
		previousHash = frame.hash;
	}
	if (revision !== value.revision || previousHash !== value.headHash)
		throw new Error("Authority export replay head does not match its metadata.");
	const exportedRows = new Map<string, AuthorityRow>();
	for (const row of value.rows) exportedRows.set(authorityKey(row.record.kind, authorityRecordKey(row.record)), row);
	let replayedRows = 0;
	for (const domain of DOMAINS) {
		for (const [key, replayed] of state.rows[domain]) {
			replayedRows++;
			const actual = exportedRows.get(key);
			if (
				!actual ||
				actual.version !== replayed.version ||
				canonicalDurableSha256(actual.record) !== canonicalDurableSha256(replayed.record)
			)
				throw new Error("Authority export rows do not match replayed evidence.");
		}
	}
	if (exportedRows.size !== replayedRows) throw new Error("Authority export rows do not match replayed evidence.");
	const exportedControls = new Map(value.controls.map(control => [control.key, control.value]));
	if (exportedControls.size !== state.controls.size)
		throw new Error("Authority export controls do not match replayed evidence.");
	for (const [key, replayed] of state.controls) {
		if (
			!exportedControls.has(key) ||
			canonicalDurableSha256(exportedControls.get(key)) !== canonicalDurableSha256(replayed)
		)
			throw new Error("Authority export controls do not match replayed evidence.");
	}
}

function loadExport(state: AuthorityState, value: AuthorityExport): void {
	for (const row of value.rows)
		state.setRow(row.record.kind, authorityKey(row.record.kind, authorityRecordKey(row.record)), row);
	for (const control of value.controls) state.setControl(control.key, true, control.value);
	const meta = state.controls.get("meta");
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Authority seed metadata is missing.");
	state.setControl("meta", true, {
		...(meta as object),
		revision: value.revision,
		generationHighWater: value.generationHighWater,
		headHash: value.headHash,
	});
}

interface ReplayCursor {
	readonly revision: number;
	readonly headHash: string;
	readonly generationHighWater: number;
}

/** Applies one already chain-validated committed frame to `state` in place. */
function applyCommittedFrame(
	state: AuthorityState,
	frame: AuthorityCommitFrame,
	cursor: ReplayCursor,
	identity: AuthorityIdentity,
): ReplayCursor {
	if (frame.revision !== cursor.revision + 1) throw new DurableStateConflictError("Authority frame revision changed.");
	if (frame.request.incarnation !== identity.incarnation)
		throw new DurableStateUnavailableError("Authority frame incarnation does not match selected identity.");
	const expectedVersions = new Map<string, number | null>();
	for (const expected of frame.expected) {
		const key = authorityKey(expected.domain, expected.key);
		if (expectedVersions.has(key)) throw new Error("Authority frame repeats an expected row key.");
		expectedVersions.set(key, expected.version);
		if ((state.rows[expected.domain].get(key)?.version ?? null) !== expected.version)
			throw new DurableStateUnavailableError("Authority frame expected row version mismatch.");
	}
	validateAuthorityFrameState(frame, frameState(state));
	for (const row of frame.changes) {
		const key = authorityKey(row.record.kind, authorityRecordKey(row.record));
		if (!expectedVersions.has(key) || row.version !== (expectedVersions.get(key) ?? 0) + 1)
			throw new Error("Authority frame row version is invalid.");
		state.setRow(row.record.kind, key, row);
	}
	for (const control of frame.controls) {
		if (control.deleted) state.setControl(control.key, false);
		else state.setControl(control.key, true, control.value);
	}
	const metaChange = frame.controls.find(control => control.key === "meta");
	if (
		!metaChange ||
		metaChange.deleted ||
		!metaChange.value ||
		typeof metaChange.value !== "object" ||
		Array.isArray(metaChange.value)
	)
		throw new Error("Authority frame is missing metadata.");
	const meta = metaChange.value as Record<string, unknown>;
	if (meta.revision !== frame.revision || !Number.isSafeInteger(meta.generationHighWater))
		throw new Error("Authority frame metadata is invalid.");
	state.setControl("meta", true, { ...meta, headHash: frame.hash });
	return { revision: frame.revision, headHash: frame.hash, generationHighWater: meta.generationHighWater as number };
}

interface SegmentReplay {
	readonly header: ParsedHeader;
	/** Position the segment's first frame continued from (its seed, snapshot or the previous segment's end). */
	readonly base: ReplayCursor;
	/** Position after the segment's last frame. */
	readonly cursor: ReplayCursor;
	readonly frames: number;
	/** Receipt controls the segment introduced, from its seed and its frames. */
	readonly receipts: Map<string, unknown>;
	readonly length: number;
	readonly chain: bigint;
	readonly tail: Buffer;
	readonly hasher: Bun.CryptoHasher;
	readonly fence: FileFence;
}

function genesisCursor(): ReplayCursor {
	return { revision: 0, headHash: GENESIS_HASH, generationHighWater: 0 };
}

function seedCursor(seed: AuthorityExport): ReplayCursor {
	return { revision: seed.revision, headHash: seed.headHash, generationHighWater: seed.generationHighWater };
}

function addReceipts(
	receipts: Map<string, unknown>,
	controls: readonly { readonly key: string; readonly deleted?: boolean; readonly value?: unknown }[],
): void {
	for (const control of controls)
		if (control.key.startsWith("receipt:") && control.deleted !== true) receipts.set(control.key, control.value);
}

/**
 * Streams one segment in a single pass: each line is chained, hashed, parsed and chain-validated. `start`
 * receives the verified header and returns the position the first frame continues from, after loading any base
 * state into `state`. With a `state`, frames are applied to it in place; without one they are only validated
 * (export). `onFrame` sees every committed frame of the segment, seed frames first. The descriptor must not
 * change while it is read, and `length` bounds the bytes read (an owner's committed length).
 */
function replaySegment(
	handle: number,
	before: fs.BigIntStats,
	length: number,
	identity: AuthorityIdentity,
	layout: JsonlLayout,
	state: AuthorityState | undefined,
	start: (header: ParsedHeader) => ReplayCursor,
	onFrame?: (frame: AuthorityCommitFrame) => void,
): SegmentReplay {
	if (!Number.isSafeInteger(length) || BigInt(length) > before.size)
		throw new DurableStateUnavailableError("Authority JSONL is too large to replay.");
	// Torn-tail refusal precedes any frame parsing, matching the journal's crash-cut contract.
	if (length === 0 || readExactly(handle, length - 1, 1)[0] !== NEWLINE)
		throw new DurableStateUnavailableError("Authority JSONL ends with a torn line.");
	let header: ParsedHeader | undefined;
	let base = genesisCursor();
	let cursor = base;
	let chain = LINE_CHAIN_SEED;
	let tail: Buffer | undefined;
	let frames = 0;
	const receipts = new Map<string, unknown>();
	const hasher = new Bun.CryptoHasher("sha256");
	forEachLine(handle, length, (line, index, end) => {
		chain = chainLine(chain, line);
		hasher.update(line);
		if (end === length) tail = tailOf(line);
		const text = line.toString("utf8", 0, line.byteLength - 1);
		if (index === 0) {
			header = parseSegmentHeader(text, identity, layout);
			const seed = header.version === 2 ? header.header.seed : undefined;
			if (seed) {
				addReceipts(receipts, seed.controls);
				if (onFrame) for (const frame of seed.frames) onFrame(frame);
			}
			base = cursor = start(header);
			return;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new DurableStateUnavailableError(`Authority JSONL frame ${index} is not valid JSON.`);
		}
		validateAuthorityFrame(raw, cursor.headHash);
		if (raw.revision !== cursor.revision + 1)
			throw new DurableStateUnavailableError("Authority JSONL frame revision is discontinuous.");
		if (state) cursor = applyCommittedFrame(state, raw, cursor, identity);
		else {
			const metaChange = raw.controls.find(control => control.key === "meta");
			const meta = metaChange && !metaChange.deleted ? metaChange.value : undefined;
			const generationHighWater =
				isPlainObject(meta) && Number.isSafeInteger(meta.generationHighWater)
					? (meta.generationHighWater as number)
					: cursor.generationHighWater;
			cursor = { revision: raw.revision, headHash: raw.hash, generationHighWater };
		}
		addReceipts(receipts, raw.controls);
		frames++;
		onFrame?.(raw);
	});
	if (!header || !tail) throw new DurableStateUnavailableError("Authority JSONL header is missing.");
	const after = fs.fstatSync(handle, { bigint: true });
	if (!sameObservation(before, after))
		throw new DurableStateUnavailableError("Authority JSONL changed while it was being read.");
	if (state) {
		const meta = state.controls.get("meta");
		if (
			!meta ||
			typeof meta !== "object" ||
			Array.isArray(meta) ||
			(meta as { headHash?: string }).headHash !== cursor.headHash
		)
			throw new DurableStateUnavailableError("Authority JSONL metadata head does not match committed frames.");
	}
	return { header, base, cursor, frames, receipts, length, chain, tail, hasher, fence: fenceOf(after) };
}

/** Loads a verified snapshot's rows and controls into an empty state. */
function loadSnapshot(state: AuthorityState, snapshot: SegmentSnapshot): void {
	for (const row of snapshot.rows) {
		const domain = row.record.kind;
		const key = authorityKey(domain, authorityRecordKey(row.record));
		if (state.rows[domain].has(key))
			throw new DurableStateUnavailableError("Authority JSONL snapshot contains duplicate row identities.");
		state.setRow(domain, key, row);
	}
	for (const control of snapshot.controls) state.setControl(control.key, true, control.value);
}

/** Loads the base an active segment starts from: nothing, its seed, or the snapshot its header names. */
function activeBase(
	state: AuthorityState,
	header: ParsedHeader,
	identity: AuthorityIdentity,
	layout: JsonlLayout,
	loaded: { snapshot?: SegmentSnapshot },
): ReplayCursor {
	if (header.version === 3) {
		const snapshot = readSnapshot(layout, header.header, identity);
		loadSnapshot(state, snapshot);
		loaded.snapshot = snapshot;
		return {
			revision: header.header.base.revision,
			headHash: header.header.base.headHash,
			generationHighWater: header.header.base.generationHighWater,
		};
	}
	const seed = header.header.seed;
	if (seed) {
		loadExport(state, seed);
		return seedCursor(seed);
	}
	state.setControl("meta", true, genesisMeta());
	return genesisCursor();
}

/** Opens a sealed segment or the active payload for reading, refusing anything but a regular file. */
function openSegment(file: string, missing: string): { readonly handle: number; readonly stat: fs.BigIntStats } {
	let handle: number;
	try {
		handle = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DurableStateUnavailableError(missing);
		throw error;
	}
	try {
		const stat = fs.fstatSync(handle, { bigint: true });
		if (!stat.isFile())
			throw new DurableStateUnavailableError(
				`Authority JSONL segment is not a regular file: ${path.basename(file)}`,
			);
		return { handle, stat };
	} catch (error) {
		fs.closeSync(handle);
		throw error;
	}
}

/**
 * Segment number recorded by the active payload's first line, read without the store's identity: enough to
 * decide which rotation artifacts are committed. A segment header is short; a first line longer than the probe
 * is a seeded version-2 header. The header hash is still checked, so a damaged header is refused, not guessed.
 */
function probeSegmentNumber(file: string): number {
	const { handle, stat } = openSegment(file, "Selected authority JSONL payload is missing.");
	try {
		const probe = readExactly(handle, 0, Math.min(Number(stat.size), SEGMENT_HEADER_PROBE_BYTES));
		const newline = probe.indexOf(NEWLINE);
		if (newline < 0) {
			if (!probe.subarray(0, 12).equals(Buffer.from('{"version":2')))
				throw new DurableStateUnavailableError("Authority JSONL header is invalid.");
			return 0;
		}
		let value: unknown;
		try {
			value = JSON.parse(probe.toString("utf8", 0, newline));
		} catch {
			throw new DurableStateUnavailableError("Authority JSONL header is not valid JSON.");
		}
		if (!isPlainObject(value)) throw new DurableStateUnavailableError("Authority JSONL header is invalid.");
		if (value.version === 2) return 0;
		const { hash, ...content } = value;
		if (
			value.version !== 3 ||
			!Number.isSafeInteger(value.segment) ||
			(value.segment as number) < 1 ||
			hash !== canonicalDurableSha256(content)
		)
			throw new DurableStateUnavailableError("Unsupported authority JSONL header.");
		return value.segment as number;
	} finally {
		fs.closeSync(handle);
	}
}

/**
 * Brings the rotation artifacts beside an active segment numbered `segment` back to a committed layout after
 * an interrupted rotation. A rotation is committed exactly when the active payload has been replaced by the
 * next segment's header, so anything the interrupted rotation wrote for a later segment is discarded:
 * temporaries, the sealed name hard-linked to the still-active inode, its index, and the next snapshot. A
 * snapshot older than the active one is what a committed rotation had not yet deleted. Returns whether
 * anything was removed. Unknown inconsistencies (a sealed segment at or past the active number that is not
 * the active inode, or a missing sealed segment) are refused rather than repaired.
 */
function repairRotationArtifacts(layout: JsonlLayout, segment: number): boolean {
	const removals = plannedRotationRepair(layout, segment);
	for (const file of removals) fs.unlinkSync(file);
	if (removals.length) fsyncDirectory(layout.directory);
	return removals.length > 0;
}

/**
 * The files `repairRotationArtifacts` would remove, without touching any: the shared classification that both the
 * owner's repair and a lock-free inspection (which must never mutate) use. Throws on the same unknown inconsistencies.
 */
function plannedRotationRepair(layout: JsonlLayout, segment: number): string[] {
	const active = fs.lstatSync(layout.active, { bigint: true });
	const removals: string[] = [];
	const remove = (file: string): void => {
		removals.push(file);
	};
	const sealed = new Set<number>();
	for (const artifact of listJsonlRotationArtifacts(layout.active)) {
		if (artifact.kind === "temporary") remove(artifact.file);
		else if (artifact.kind === "segment") {
			if (artifact.number < segment) {
				sealed.add(artifact.number);
				continue;
			}
			const stat = fs.lstatSync(artifact.file, { bigint: true });
			if (artifact.number !== segment || !stat.isFile() || stat.dev !== active.dev || stat.ino !== active.ino)
				throw new DurableStateUnavailableError(
					`Authority JSONL has an unexpected sealed segment: ${path.basename(artifact.file)}`,
				);
			remove(artifact.file);
		} else if (artifact.kind === "index") {
			if (artifact.number >= segment) remove(artifact.file);
		} else if (artifact.number !== segment) remove(artifact.file);
	}
	for (let index = 0; index < segment; index++)
		if (!sealed.has(index))
			throw new DurableStateUnavailableError(`Authority JSONL sealed segment ${index} is missing.`);
	return removals;
}

/**
 * What follows the last complete line of an active segment: nothing to settle (`clean`: the open failed elsewhere),
 * a provably unacknowledged suffix starting at `cut`, or bytes that must be kept as evidence (`refused`).
 */
type SegmentTail =
	| { readonly kind: "clean" }
	| { readonly kind: "unacknowledged"; readonly cut: number }
	| { readonly kind: "refused"; readonly offset: number; readonly reason: string };

/**
 * Classifies the tail of an active segment after its last complete line.
 *
 * Every acknowledgement follows an fsync that covers its line through the final newline, and an owner appends only
 * at the verified end of its committed lines (after an unknown outcome it appends nothing until a reopen has settled
 * the tail). So the bytes an interrupted, never-acknowledged write episode left are a suffix of the file. Only two
 * shapes are accepted as that suffix, and both start right after the last newline-terminated line:
 *
 * - zeros through EOF: the size reached disk but the data did not (XFS reads unwritten extents and size-extended
 *   EOF as zeros, including the rest of the block that held the last committed newline);
 * - one newline-less fragment that is a prefix of a frame line, optionally followed by zeros through EOF that start
 *   on a block boundary (the fragment's later blocks never reached disk).
 *
 * Anything else is refused as evidence: a complete line (frame or foreign) or any non-zero byte after a zero run,
 * which may be acknowledged history behind a block a faulty flush lost; zeros starting inside a written block;
 * foreign text; a fragment or suffix longer than one write episode can produce.
 */
function classifySegmentTail(handle: number, length: number): SegmentTail {
	let headerEnd = -1;
	let lineStart = 0;
	let firstZero = -1;
	const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, length)));
	for (let position = 0; position < length;) {
		const read = fs.readSync(handle, chunk, 0, Math.min(chunk.byteLength, length - position), position);
		if (read <= 0) throw new Error("Authority JSONL ended before its observed length.");
		for (let index = 0; index < read; index++) {
			const byte = chunk[index]!;
			const offset = position + index;
			if (firstZero >= 0) {
				if (byte !== 0)
					return {
						kind: "refused",
						offset: lineStart,
						reason: `non-zero bytes at offset ${offset} follow a zero run that starts at offset ${firstZero}`,
					};
				continue;
			}
			if (byte === 0) {
				firstZero = offset;
				continue;
			}
			if (byte === NEWLINE) {
				if (headerEnd < 0) headerEnd = offset + 1;
				lineStart = offset + 1;
			} else if (headerEnd >= 0 && offset - lineStart >= MAX_FRAME_LINE_BYTES)
				return {
					kind: "refused",
					offset: lineStart,
					reason: `the line at offset ${lineStart} is longer than any frame an owner writes`,
				};
		}
		position += read;
	}
	if (headerEnd < 0) return { kind: "clean" };
	const fragmentEnd = firstZero >= 0 ? firstZero : length;
	if (fragmentEnd > lineStart) {
		const probe = readExactly(handle, lineStart, Math.min(fragmentEnd - lineStart, FRAME_LINE_PREFIX.byteLength + 1));
		const fragment = probe[0] === GROUP_MEMBER_MARKER ? probe.subarray(1) : probe;
		const shared = Math.min(fragment.byteLength, FRAME_LINE_PREFIX.byteLength);
		if (shared === 0 || !fragment.subarray(0, shared).equals(FRAME_LINE_PREFIX.subarray(0, shared)))
			return {
				kind: "refused",
				offset: lineStart,
				reason: `the bytes at offset ${lineStart} are not the start of a frame line`,
			};
		if (firstZero >= 0 && firstZero % UNWRITTEN_BLOCK_ALIGNMENT !== 0)
			return {
				kind: "refused",
				offset: lineStart,
				reason: `the zero run at offset ${firstZero} starts inside a written block`,
			};
	} else if (firstZero < 0) return { kind: "clean" };
	if (length - lineStart > MAX_UNACKNOWLEDGED_SUFFIX_BYTES)
		return {
			kind: "refused",
			offset: lineStart,
			reason: `the ${length - lineStart}-byte tail is longer than one write episode`,
		};
	return { kind: "unacknowledged", cut: lineStart };
}

/**
 * Remedy text for a refused tail of the active payload `file` (named `<session>.authority.jsonl`). An open of the live
 * payload names repair as the diagnosis step. Repair, migration and pack read a disposable inspection copy
 * (`inspectionCopy`): they are that diagnosis, so they give the documented manual procedure instead of naming repair.
 */
function remedyFor(file: string, inspectionCopy: boolean): string {
	const suffix = ".authority.jsonl";
	const session = file.endsWith(suffix) ? file.slice(0, -suffix.length) : undefined;
	if (inspectionCopy) {
		return session
			? `The store cannot be repaired automatically; ${refusedAuthorityStoreGuidance(session)}.`
			: `The store cannot be repaired automatically; keep the file unchanged and follow "Refused authority stores" in docs/session-operations-export-share-fork-resume.md.`;
	}
	return session
		? `Run ${repairSessionCommand(session)} (dry-run) to diagnose it; the file is left unchanged as evidence.`
		: "Run omp session repair on the owning session (dry-run) to diagnose it; the file is left unchanged as evidence.";
}

/**
 * Writes `bytes` durably to a new private `file`. An existing file is accepted only when it is a private regular file
 * holding the same bytes, and it is synced with its directory too: the earlier open that wrote it may have been killed
 * before its own sync, and the cut that follows must not become durable before the bytes it drops.
 */
function writeRecoveryFile(file: string, bytes: Buffer, directory: string): void {
	let handle: number;
	try {
		handle = fs.openSync(
			file,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// The name carries the offset and digest: an earlier open of the same tail kept it before it could truncate.
		syncExistingRecoveryFile(file, bytes);
		fsyncDirectory(directory);
		return;
	}
	try {
		for (let written = 0; written < bytes.byteLength;)
			written += fs.writeSync(handle, bytes, written, bytes.byteLength - written);
		durableFsyncSync(handle);
	} finally {
		fs.closeSync(handle);
	}
	fsyncDirectory(directory);
}

function syncExistingRecoveryFile(file: string, bytes: Buffer): void {
	let handle: number;
	try {
		handle = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		throw new DurableStateUnavailableError(
			`Authority JSONL recovery file ${file} exists but cannot be opened as a regular file.`,
			{ cause: error },
		);
	}
	try {
		const stat = fs.fstatSync(handle);
		if (!stat.isFile() || !hasPrivateMode(stat.mode))
			throw new DurableStateUnavailableError(
				`Authority JSONL recovery file ${file} exists but is not a private regular file.`,
			);
		if (stat.size !== bytes.byteLength || !readExactly(handle, 0, bytes.byteLength).equals(bytes))
			throw new DurableStateUnavailableError(`Authority JSONL recovery file ${file} exists with different bytes.`);
		durableFsyncSync(handle);
	} finally {
		fs.closeSync(handle);
	}
}

/**
 * Settles the tail of the active segment at `file` (see {@link classifySegmentTail}). A provably unacknowledged
 * suffix is cut once the remaining prefix replays as a complete committed segment: the dropped bytes are first kept
 * in a private recovery file, then the cut is synced. Returns the recovery file when it cut anything; a clean tail or a
 * prefix that does not replay returns undefined and leaves the original error to the open. A tail that must be kept as evidence refuses and leaves
 * every byte in place; the refusal names `refusalPath`, the real payload when `file` is a disposable inspection copy,
 * and its remedy comes from {@link remedyFor}.
 */
function discardUnacknowledgedSuffix(
	file: string,
	identity: AuthorityIdentity,
	layout: JsonlLayout,
	openError: DurableStateUnavailableError,
	refusalPath = file,
): string | undefined {
	const handle = fs.openSync(file, fs.constants.O_RDWR | O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(handle, { bigint: true });
		const length = Number(stat.size);
		if (!stat.isFile() || !hasPrivateMode(stat.mode) || !Number.isSafeInteger(length) || length === 0)
			return undefined;
		const tail = classifySegmentTail(handle, length);
		if (tail.kind === "clean") return undefined;
		if (tail.kind === "refused")
			throw new DurableStateUnavailableError(
				`Authority JSONL ${refusalPath} has bytes after its last complete frame that are not an interrupted unacknowledged append: ${tail.reason}. ${remedyFor(refusalPath, refusalPath !== file)}`,
				{ cause: openError },
			);
		const { cut } = tail;
		try {
			const state = new AuthorityState();
			replaySegment(handle, stat, cut, identity, layout, state, header =>
				activeBase(state, header, identity, layout, {}),
			);
		} catch {
			return undefined;
		}
		const dropped = readExactly(handle, cut, length - cut);
		const sha256 = new Bun.CryptoHasher("sha256").update(dropped).digest("hex");
		const recovery = jsonlRecoveryFile(layout, cut, sha256);
		writeRecoveryFile(recovery, dropped, layout.directory);
		fs.ftruncateSync(handle, cut);
		durableFsyncSync(handle);
		logger.warn(
			"Authority JSONL cut the unacknowledged suffix an interrupted write left; the dropped bytes are kept in a recovery file",
			{ file, keptBytes: cut, droppedBytes: length - cut, droppedSha256: sha256, recoveryFile: recovery },
		);
		return recovery;
	} finally {
		fs.closeSync(handle);
	}
}

/**
 * Whether the store beside `activePath` holds artifacts of a rotation that is in progress (under a live owner) or
 * was interrupted, which its owner's open or `recoverJsonlRotation` would remove. Reads only; needs no ownership.
 * Throws when the layout is inconsistent in a way recovery itself refuses.
 */
export function jsonlRotationRecoveryPending(activePath: string): boolean {
	const layout = jsonlLayout(activePath);
	if (listJsonlRotationArtifacts(layout.active).length === 0 || !fs.existsSync(layout.active)) return false;
	return plannedRotationRepair(layout, probeSegmentNumber(layout.active)).length > 0;
}

export function recoverJsonlRotation(activePath: string): boolean {
	const layout = jsonlLayout(activePath);
	if (listJsonlRotationArtifacts(layout.active).length === 0) return false;
	// Without an active payload nothing names a committed segment; such artifacts are left for the caller to refuse.
	if (!fs.existsSync(layout.active)) return false;
	return repairRotationArtifacts(layout, probeSegmentNumber(layout.active));
}

function sortedControls(controls: Map<string, unknown>): AuthorityControl[] {
	return [...controls.entries()]
		.sort(([left], [right]) => compareAuthorityKeys(left, right))
		.map(([key, value]) => ({ key, value }));
}

type StateUndo =
	| {
			readonly kind: "row";
			readonly domain: AuthorityDomain;
			readonly key: string;
			readonly previous: StoredRow | undefined;
	  }
	| { readonly kind: "control"; readonly key: string; readonly previous: ControlSlot };

interface StagedCommit {
	readonly frame: AuthorityCommitFrame;
	/** Displaced rows and controls in application order; replayed backwards to discard the staged frame. */
	readonly undo: readonly StateUndo[];
	readonly generationHighWater: number;
}

interface JsonlGroup {
	readonly frames: AuthorityCommitFrame[];
	/** Offset where the group's first member starts, and every member's appended bytes, for the sync's readback. */
	start: number;
	readonly bytes: Buffer[];
	/** The append descriptor every member writes through; the sync's fsync, readback and close end its boundary. */
	handle?: number;
	/** Unknown outcome of the whole group once any member could not be undone or the driver became unavailable. */
	failure?: DurableStateUnavailableError;
}

interface SealingPlan {
	readonly index: SegmentIndex;
	readonly indexBytes: Buffer;
	readonly indexRef: FileRef;
	readonly receiptEpoch: number;
	readonly snapshotBytes: Buffer;
	readonly header: Buffer;
	/** Epoch of the store's current owner of this incarnation, whose receipts stay in memory; undefined when none. */
	readonly ownerEpoch: number | undefined;
}

interface SegmentLimits {
	readonly minBytes: number;
	readonly maxFrames: number;
}

function segmentLimits(options: AuthorityDriverOptions): SegmentLimits {
	const limits = options.jsonlSegment ?? {
		minBytes: AUTHORITY_JSONL_SEGMENT_MIN_BYTES,
		maxFrames: AUTHORITY_JSONL_SEGMENT_MAX_FRAMES,
	};
	if (
		!Number.isSafeInteger(limits.minBytes) ||
		limits.minBytes < 1 ||
		!Number.isSafeInteger(limits.maxFrames) ||
		limits.maxFrames < 1
	)
		throw new RangeError("Authority JSONL segment limits must be positive safe integers.");
	return limits;
}

/** Base of segment `number` while every segment is read in order: segment 0 starts at genesis or its seed, later ones exactly where their predecessor ended. */
function continuationBase(header: ParsedHeader, number: number, previous: ReplayCursor | undefined): ReplayCursor {
	if (number === 0) {
		if (header.version !== 2)
			throw new DurableStateUnavailableError("Authority JSONL segment 0 must start with a version-2 header.");
		return header.header.seed ? seedCursor(header.header.seed) : genesisCursor();
	}
	if (header.version !== 3 || header.header.segment !== number)
		throw new DurableStateUnavailableError(`Authority JSONL segment ${number} header does not name its position.`);
	const base = header.header.base;
	if (
		!previous ||
		base.revision !== previous.revision ||
		base.headHash !== previous.headHash ||
		base.generationHighWater !== previous.generationHighWater
	)
		throw new DurableStateUnavailableError(`Authority JSONL segment ${number} does not continue its predecessor.`);
	return { revision: base.revision, headHash: base.headHash, generationHighWater: base.generationHighWater };
}

function sameControlValues(left: ReadonlyMap<string, unknown>, right: readonly AuthorityControl[]): boolean {
	if (left.size !== right.length) return false;
	for (const control of right)
		if (
			!left.has(control.key) ||
			canonicalDurableSha256(left.get(control.key)) !== canonicalDurableSha256(control.value)
		)
			return false;
	return true;
}

export class JsonlAuthorityPersistence implements AuthorityPersistence {
	readonly identity: AuthorityIdentity;
	readonly #path: string;
	readonly #refusalPath: string;
	#recoveredTail: string | undefined;
	readonly #layout: JsonlLayout;
	readonly #limits: SegmentLimits;
	readonly #capacity: AuthorityCapacityAdmission | undefined;
	#state = new AuthorityState();
	#revision = 0;
	#headHash = GENESIS_HASH;
	#generationHighWater = 0;
	#unavailableError: DurableStateUnavailableError | undefined;
	#closed = false;
	#inTransaction = false;
	#staged: StagedCommit | undefined;
	#deferredCloseFrame: AuthorityCommitFrame | undefined;
	// The active segment: its number, the committed position it continues from, the size of the snapshot it
	// started from (the rotation trigger), its frame count, the receipts it introduced (sealed into its index at
	// rotation) and the running SHA-256 of its committed bytes (recorded in that index).
	#segment = 0;
	#base: ReplayCursor = genesisCursor();
	#snapshotBytes = 0;
	#segmentFrames = 0;
	#segmentReceipts = new Map<string, unknown>();
	#segmentHasher = new Bun.CryptoHasher("sha256");
	// Head of the sealed index chain, and the highest owner epoch of any sealed receipt of this incarnation.
	#sealedIndex: FileRef | undefined;
	#sealedReceiptEpoch = 0;
	// Every receipt of this incarnation with an owner epoch above the floor is in memory; only lookups at or below
	// it (or of another incarnation) can need the sealed indexes. Reopening starts a higher owner epoch, so the
	// engine's own per-command receipt lookups never read sealed history.
	#receiptFloor = 0;
	// Built on the first lookup that needs sealed receipts, then extended by each rotation; undefined until then.
	#sealedReceipts: SealedReceiptLookup | undefined;
	// What this owner has proven about the active segment's bytes: their length, the chained per-line hash of all
	// of them, the last line (the on-disk chain head) and the file fence observed when they were last proven.
	#length = 0;
	#chain = LINE_CHAIN_SEED;
	#tail: Buffer = Buffer.alloc(0);
	#fence: FileFence | undefined;
	// False until this instance has re-read every active-segment byte after construction or rotation, and again
	// after any capacity refusal that may have touched the file; until then the fence timestamps prove nothing.
	#contentVerified = false;
	#group: JsonlGroup | undefined;

	/*
	 * Group commit: every member appends its own complete line (marked by GROUP_MEMBER_MARKER) through the same
	 * verified, funded append path as an ungrouped frame, but without a sync; sync() then makes all of them
	 * durable with one sync. Nothing is acknowledged before it. A member refused before writing leaves no
	 * byte; one whose write fails is truncated back to its own start, and if that cannot be proved the whole
	 * group's outcome is unknown. Rotation never happens inside a group: only a group's first member may rotate
	 * (every earlier byte is then synced); a later member that would rotate is a group boundary.
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

	/** The recovery file this open kept when it cut an interrupted append's tail, for the caller's notice. */
	get recoveredTail(): string | undefined {
		return this.#recoveredTail;
	}

	constructor(options: AuthorityDriverOptions) {
		if (!path.isAbsolute(options.path)) throw new TypeError("Authority JSONL path must be absolute.");
		if (options.identity.backend !== "jsonl") throw new TypeError("JSONL driver requires a JSONL identity.");
		this.#path = path.resolve(options.path);
		this.#refusalPath = options.refusalPath ?? this.#path;
		this.#layout = jsonlLayout(this.#path);
		this.#limits = segmentLimits(options);
		this.identity = Object.freeze({ ...options.identity });
		this.#capacity = options.capacity
			? new AuthorityCapacityAdmission(this.#path, this.identity, options.capacity)
			: undefined;
		if (options.create) {
			const header = headerBytes(this.identity, options.seed);
			this.#create(options.seed, header);
		} else {
			this.#open();
		}
		if (this.#capacity) {
			const records = this.#state.openRecords();
			const claims: AuthorityControl[] = [];
			for (const record of records) {
				if (record.kind !== "local-entry") continue;
				const key = `local-claim:${JSON.stringify(record.localId)}`;
				const value = this.#state.controls.get(key);
				if (value !== undefined) claims.push({ key, value });
			}
			this.#capacity.initialize(records, undefined, claims);
		}
	}

	transaction<T>(run: () => T): T {
		if (this.#group) return this.#groupMember(this.#group, run);
		this.#assertAvailable();
		if (this.#inTransaction) throw new Error("Nested authority transactions are not supported.");
		this.#inTransaction = true;
		this.#staged = undefined;
		try {
			const result = run();
			this.#commitStaged();
			return result;
		} catch (error) {
			this.#discardStaged();
			throw error;
		} finally {
			this.#staged = undefined;
			this.#inTransaction = false;
		}
	}

	#commitStaged(): void {
		const staged = this.#staged;
		if (!staged) return;
		if (this.#group) this.#appendGroupMember(this.#group, staged.frame);
		else this.#appendFrame(staged.frame);
		this.#staged = undefined;
		this.#revision = staged.frame.revision;
		this.#headHash = staged.frame.hash;
		this.#generationHighWater = staged.generationHighWater;
		this.#segmentFrames++;
		addReceipts(this.#segmentReceipts, staged.frame.controls);
	}

	#discardStaged(): void {
		const staged = this.#staged;
		if (!staged) return;
		this.#staged = undefined;
		for (let index = staged.undo.length - 1; index >= 0; index--) {
			const undo = staged.undo[index]!;
			if (undo.kind === "row") this.#state.setRow(undo.domain, undo.key, undo.previous);
			else this.#state.setControl(undo.key, undo.previous.present, undo.previous.value);
		}
	}

	get<D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	): AuthorityRow<AuthorityRecordMap[D]> | undefined {
		this.#assertAvailable();
		const row = this.#state.rows[domain].get(authorityKey(domain, key));
		return row as AuthorityRow<AuthorityRecordMap[D]> | undefined;
	}

	scan<D extends AuthorityDomain>(domain: D, query: AuthorityScan): AuthorityPage<AuthorityRecordMap[D]> {
		this.#assertAvailable();
		if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)
			throw new RangeError("Authority scan limit must be between 1 and 1000.");
		const rows = this.#state.rows[domain];
		const candidates: Array<{ cursor: string; row: AuthorityRow<AuthorityRecordMap[D]> }> = [];
		for (const cursor of this.#state.scanKeys(domain, query)) {
			const row = rows.get(cursor);
			if (!row) continue;
			if (query.after !== undefined && compareAuthorityKeys(cursor, query.after) <= 0) continue;
			if (query.openOnly && !authorityRecordIsOpen(row.record)) continue;
			if (query.rootId !== undefined && row.record.kind === "actor" && row.record.rootId !== query.rootId) continue;
			if (
				query.rootGeneration !== undefined &&
				row.record.kind === "actor" &&
				row.record.rootGeneration !== query.rootGeneration
			)
				continue;
			if (
				query.localMatch &&
				row.record.kind === "local-entry" &&
				(row.record.localId !== query.localMatch.localId ||
					row.record.version !== query.localMatch.version ||
					row.record.headHash !== query.localMatch.headHash ||
					row.record.phase !== "committed")
			)
				continue;
			candidates.push({ cursor, row: row as AuthorityRow<AuthorityRecordMap[D]> });
		}
		candidates.sort((left, right) => compareAuthorityKeys(left.cursor, right.cursor));
		const selected = candidates.slice(0, query.limit);
		return Object.freeze({
			rows: Object.freeze(selected.map(item => item.row)),
			...(candidates.length > query.limit ? { cursor: selected.at(-1)?.cursor } : {}),
		});
	}

	getControl(key: string): unknown | undefined {
		this.#assertAvailable();
		const value = this.#state.controls.get(key);
		if (value !== undefined || !this.#mayBeSealedReceipt(key)) return value;
		// Every sealed receipt key is well formed (the lookup refuses an index otherwise), so a malformed key is never sealed.
		const requestId = receiptKeyParts(key)?.requestId;
		const sealed = this.#sealedReceiptControls(requestId);
		return sealed.find(control => control.key === key)?.value;
	}

	findReceipt(
		requestId: string,
		incarnation: string,
		payloadHash?: string,
	): AuthorityCommitFrame["receipt"] | undefined {
		this.#assertAvailable();
		const controls = this.#state.controls;
		const candidates = new Map<string, unknown>();
		for (const key of this.#state.receiptKeys(requestId, incarnation) ?? controls.keys())
			if (key.startsWith("receipt:")) candidates.set(key, controls.get(key));
		// A request may have receipts in several owner epochs, and the first in key order wins, so every sealed
		// receipt of the request is consulted, through the lookup built once from the verified sealed indexes.
		if (this.#segment > 0) {
			for (const control of this.#sealedReceiptControls(requestId)) {
				const receipt = control.value as Partial<AuthorityCommitFrame["receipt"]> | undefined;
				if (!candidates.has(control.key) && receipt?.requestId === requestId && receipt.incarnation === incarnation)
					candidates.set(control.key, control.value);
			}
		}
		for (const key of [...candidates.keys()].sort(compareAuthorityKeys)) {
			const value = candidates.get(key);
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const receipt = value as AuthorityCommitFrame["receipt"];
			if (
				receipt.requestId === requestId &&
				receipt.incarnation === incarnation &&
				(payloadHash === undefined || receipt.payloadHash === payloadHash)
			)
				return receipt;
		}
		return undefined;
	}

	scanControl(
		prefix: string,
		after?: string,
		limit = 100,
	): { readonly controls: readonly AuthorityControl[]; readonly cursor?: string } {
		this.#assertAvailable();
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			throw new RangeError("Authority control scan limit must be between 1 and 1000.");
		const controls = this.#state.controls;
		const values: Array<[string, unknown]> = [];
		for (const key of this.#state.controlKeys(prefix)) {
			if (key.startsWith(prefix) && (after === undefined || compareAuthorityKeys(key, after) > 0))
				values.push([key, controls.get(key)]);
		}
		if (this.#segment > 0 && (prefix.startsWith("receipt:") || "receipt:".startsWith(prefix))) {
			const seen = new Set(values.map(([key]) => key));
			this.#forEachSealedIndex(index => {
				for (const control of index.receipts) {
					if (
						!seen.has(control.key) &&
						control.key.startsWith(prefix) &&
						(after === undefined || compareAuthorityKeys(control.key, after) > 0)
					) {
						seen.add(control.key);
						values.push([control.key, control.value]);
					}
				}
				return false;
			});
		}
		values.sort(([left], [right]) => compareAuthorityKeys(left, right));
		const selected = values.slice(0, limit);
		return Object.freeze({
			controls: Object.freeze(selected.map(([key, value]) => Object.freeze({ key, value }))),
			...(values.length > limit ? { cursor: selected.at(-1)?.[0] } : {}),
		});
	}

	/**
	 * Validates `frame` against the current state, then applies it in place and records what it displaced so a
	 * failed append or a throwing transaction body can restore the prior state. Work is proportional to the frame.
	 */
	commit(frame: AuthorityCommitFrame): void {
		this.#assertAvailable();
		if (!this.#inTransaction) throw new Error("Authority commit must be staged inside a transaction.");
		if (this.#staged) throw new Error("A transaction may stage only one authority commit frame.");
		validateAuthorityFrame(frame, this.#headHash);
		if (frame.revision !== this.#revision + 1)
			throw new DurableStateConflictError("Authority commit revision changed.");
		if (frame.request.incarnation !== this.identity.incarnation)
			throw new DurableStateConflictError("Authority frame incarnation does not match the store.");
		const state = this.#state;
		const expectedVersions = new Map<string, number | null>();
		for (const expectation of frame.expected) {
			const key = authorityKey(expectation.domain, expectation.key);
			if (expectedVersions.has(key)) throw new Error("Authority frame repeats an expected row key.");
			expectedVersions.set(key, expectation.version);
			const actual = state.rows[expectation.domain].get(key)?.version ?? null;
			if (actual !== expectation.version)
				throw new DurableStateConflictError("Authority expected row version changed.");
		}
		validateAuthorityFrameState(frame, frameState(state));
		const changedRows = new Set<string>();
		for (const row of frame.changes) {
			const composite = authorityKey(row.record.kind, authorityRecordKey(row.record));
			if (!expectedVersions.has(composite) || changedRows.has(composite))
				throw new Error("Authority frame row changes are missing expectations or duplicate a key.");
			changedRows.add(composite);
			if (row.version !== (expectedVersions.get(composite) ?? 0) + 1)
				throw new Error("Authority changed row version is not consecutive.");
		}
		const changedControls = new Set<string>();
		for (const change of frame.controls) {
			if (changedControls.has(change.key)) throw new Error("Authority frame repeats a control key.");
			changedControls.add(change.key);
		}
		const metaChange = frame.controls.find(change => change.key === "meta");
		if (
			!metaChange ||
			metaChange.deleted ||
			!metaChange.value ||
			typeof metaChange.value !== "object" ||
			Array.isArray(metaChange.value)
		)
			throw new Error("Authority frame must update metadata atomically.");
		const meta = metaChange.value as Record<string, unknown>;
		if (
			meta.revision !== frame.revision ||
			!Number.isSafeInteger(meta.generationHighWater) ||
			(meta.status !== "ready" && meta.status !== "quarantined")
		)
			throw new Error("Authority frame metadata does not match its revision.");
		const undo: StateUndo[] = [];
		for (const row of frame.changes) {
			const domain = row.record.kind;
			const key = authorityKey(domain, authorityRecordKey(row.record));
			undo.push({ kind: "row", domain, key, previous: state.setRow(domain, key, row) });
		}
		for (const change of frame.controls)
			undo.push({
				kind: "control",
				key: change.key,
				previous: change.deleted
					? state.setControl(change.key, false)
					: state.setControl(change.key, true, change.value),
			});
		undo.push({
			kind: "control",
			key: "meta",
			previous: state.setControl("meta", true, { ...meta, headHash: frame.hash }),
		});
		this.#staged = { frame, undo, generationHighWater: meta.generationHighWater as number };
	}

	/**
	 * The committed state with every sealed receipt and the whole history read back from the segments: cost is
	 * proportional to history, as evidence export must be.
	 */
	exportState(): AuthorityExport {
		this.#assertAvailable();
		const { rows, controls } = this.#committedView();
		const history = this.#readHistory();
		for (const [key, value] of history.receipts) if (!controls.has(key)) controls.set(key, value);
		return Object.freeze({
			version: 2,
			sourceIdentity: this.identity,
			revision: this.#revision,
			generationHighWater: this.#generationHighWater,
			headHash: this.#headHash,
			rows: Object.freeze(rows),
			controls: Object.freeze(sortedControls(controls)),
			frames: Object.freeze(history.frames),
			...(history.legacy ? { legacy: history.legacy } : {}),
		});
	}

	integrityCheck(): void {
		this.#assertAvailable();
		try {
			this.#checkIntegrity();
		} catch (error) {
			if (this.#unavailableError) throw error;
			this.#unavailable(error instanceof Error ? error.message : String(error), error);
		}
	}

	close(): void {
		if (this.#closed) return;
		if (this.#group) throw new Error("Cannot close JSONL authority storage during an open commit group.");
		const deferred = this.#deferredCloseFrame;
		if (deferred && !this.#unavailableError) this.transaction(() => this.commit(deferred));
		this.#capacity?.prepareClose();
		this.#closed = true;
	}

	/** Committed rows (key order) and controls: a frame staged by an open transaction is already applied in place, so its displaced values win. */
	#committedView(): { readonly rows: AuthorityRow[]; readonly controls: Map<string, unknown> } {
		const rowOverrides = new Map<string, StoredRow | undefined>();
		const controlOverrides = new Map<string, ControlSlot>();
		for (const undo of this.#staged?.undo ?? []) {
			if (undo.kind === "row" && !rowOverrides.has(undo.key)) rowOverrides.set(undo.key, undo.previous);
			if (undo.kind === "control" && !controlOverrides.has(undo.key)) controlOverrides.set(undo.key, undo.previous);
		}
		const rows: AuthorityRow[] = [];
		for (const domain of DOMAINS) {
			for (const [key, row] of this.#state.rows[domain] as Map<string, StoredRow>)
				if (!rowOverrides.has(key)) rows.push(row);
		}
		for (const previous of rowOverrides.values()) if (previous) rows.push(previous);
		rows.sort((left, right) =>
			compareAuthorityKeys(
				authorityKey(left.record.kind, authorityRecordKey(left.record)),
				authorityKey(right.record.kind, authorityRecordKey(right.record)),
			),
		);
		const controls = new Map(this.#state.controls);
		for (const [key, previous] of controlOverrides) {
			if (previous.present) controls.set(key, previous.value);
			else controls.delete(key);
		}
		return { rows, controls };
	}

	/** May a receipt `key` missing from memory exist only in sealed history? */
	#mayBeSealedReceipt(key: string): boolean {
		if (this.#segment === 0 || !key.startsWith("receipt:")) return false;
		const parts = receiptKeyParts(key);
		return !parts || parts.incarnation !== this.identity.incarnation || parts.epoch <= this.#receiptFloor;
	}

	/**
	 * Sealed receipt controls whose key names `requestId` (none for undefined), from the sealed receipt lookup,
	 * which is built and verified on first use. An unreadable or changed sealed index makes the store unavailable.
	 */
	#sealedReceiptControls(requestId: string | undefined): AuthorityControl[] {
		let lookup = this.#sealedReceipts;
		if (!lookup) {
			const building = new SealedReceiptLookup();
			this.#forEachSealedIndex((index, ref, bytes) => {
				building.add(`${this.#layout.stem}.${ref.file}`, ref, bytes, index);
				return false;
			});
			lookup = building;
			this.#sealedReceipts = lookup;
		}
		if (requestId === undefined) return [];
		try {
			return lookup.controls(requestId);
		} catch (error) {
			if (error === this.#unavailableError) throw error;
			this.#unavailable("Authority JSONL sealed history could not be read.", error);
		}
	}

	/**
	 * Visits the sealed segment indexes newest first, each proved by the digest its successor (or the active
	 * snapshot) recorded, until `visit` returns true. An unreadable or inconsistent chain makes the store unavailable.
	 */
	#forEachSealedIndex(visit: (index: SegmentIndex, ref: FileRef, bytes: Buffer) => boolean): void {
		try {
			let ref = this.#sealedIndex;
			for (let segment = this.#segment - 1; segment >= 0; segment--) {
				if (!ref) throw new DurableStateUnavailableError("Authority JSONL sealed index chain is incomplete.");
				const { index, bytes } = readSegmentIndex(this.#layout, ref, segment, this.identity);
				if (visit(index, ref, bytes)) return;
				ref = index.previous ?? undefined;
			}
			if (ref)
				throw new DurableStateUnavailableError(
					"Authority JSONL sealed index chain is longer than its sealed segments.",
				);
		} catch (error) {
			if (error === this.#unavailableError) throw error;
			this.#unavailable("Authority JSONL sealed history could not be read.", error);
		}
	}

	/** Every segment's frames and receipts read back in order, proving each continues its predecessor and that they end at the committed head. */
	#readHistory(): {
		readonly frames: AuthorityCommitFrame[];
		readonly receipts: Map<string, unknown>;
		readonly legacy: AuthorityExport["legacy"];
	} {
		const frames: AuthorityCommitFrame[] = [];
		const receipts = new Map<string, unknown>();
		let legacy: AuthorityExport["legacy"];
		try {
			let previous: ReplayCursor | undefined;
			for (let number = 0; number <= this.#segment; number++) {
				const active = number === this.#segment;
				const { handle, stat } = openSegment(
					active ? this.#layout.active : this.#layout.segment(number),
					`Authority JSONL segment ${number} is missing.`,
				);
				let replay: SegmentReplay;
				try {
					const before = previous;
					replay = replaySegment(
						handle,
						stat,
						active ? this.#length : Number(stat.size),
						this.identity,
						this.#layout,
						undefined,
						header => continuationBase(header, number, before),
						frame => frames.push(frame),
					);
				} finally {
					fs.closeSync(handle);
				}
				if (number === 0 && replay.header.version === 2) legacy = replay.header.header.seed?.legacy;
				for (const [key, value] of replay.receipts) receipts.set(key, value);
				previous = replay.cursor;
			}
			if (!previous || previous.revision !== this.#revision || previous.headHash !== this.#headHash)
				throw new DurableStateUnavailableError("Authority JSONL history does not end at the committed head.");
		} catch (error) {
			if (error === this.#unavailableError) throw error;
			this.#unavailable("Authority JSONL history could not be read back.", error);
		}
		return { frames, receipts, legacy };
	}

	/**
	 * Full verification, proportional to history: replays every sealed segment against its index (length,
	 * SHA-256, revision range, receipts), proves the active snapshot equals the replayed state at its boundary,
	 * replays the active segment, and compares the result field by field and byte by byte with this owner's state.
	 */
	#checkIntegrity(): void {
		this.#assertAvailable();
		const indexes: SegmentIndex[] = [];
		this.#forEachSealedIndex(index => {
			indexes.unshift(index);
			return false;
		});
		const state = new AuthorityState();
		let previous: ReplayCursor | undefined;
		let sealedReceiptEpoch = 0;
		for (let number = 0; number < this.#segment; number++) {
			const index = indexes[number]!;
			const { handle, stat } = openSegment(
				this.#layout.segment(number),
				`Authority JSONL sealed segment ${number} is missing.`,
			);
			let replay: SegmentReplay;
			try {
				if (!hasPrivateMode(stat.mode) || stat.size !== BigInt(index.segmentBytes))
					throw new DurableStateUnavailableError(
						`Authority JSONL sealed segment ${number} does not match its index.`,
					);
				const before = previous;
				replay = replaySegment(handle, stat, index.segmentBytes, this.identity, this.#layout, state, header => {
					const base = continuationBase(header, number, before);
					if (number === 0) activeBase(state, header, this.identity, this.#layout, {});
					return base;
				});
			} finally {
				fs.closeSync(handle);
			}
			if (
				replay.hasher.digest("hex") !== index.segmentSha256 ||
				replay.base.revision + 1 !== index.firstRevision ||
				replay.cursor.revision !== index.lastRevision ||
				replay.cursor.headHash !== index.headHash ||
				!sameControlValues(replay.receipts, index.receipts)
			)
				throw new DurableStateUnavailableError(
					`Authority JSONL sealed segment ${number} does not match its index.`,
				);
			for (const receipt of index.receipts) {
				const parts = receiptKeyParts(receipt.key);
				if (parts?.incarnation === this.identity.incarnation && parts.epoch > sealedReceiptEpoch)
					sealedReceiptEpoch = parts.epoch;
			}
			previous = replay.cursor;
		}
		const { handle, stat } = openJournal(this.#path);
		let replay: SegmentReplay;
		try {
			const before = previous;
			replay = replaySegment(handle, stat, Number(stat.size), this.identity, this.#layout, state, header => {
				const base = continuationBase(header, this.#segment, before);
				if (header.version === 3) {
					const snapshot = readSnapshot(this.#layout, header.header, this.identity);
					if (
						canonicalDurableSha256(snapshot.sealed.index) !== canonicalDurableSha256(this.#sealedIndex ?? null) ||
						snapshot.sealed.receiptEpoch !== sealedReceiptEpoch
					)
						throw new DurableStateUnavailableError("Authority JSONL snapshot does not name the sealed history.");
					this.#assertSnapshotMatches(snapshot, state);
				} else activeBase(state, header, this.identity, this.#layout, {});
				return base;
			});
		} finally {
			fs.closeSync(handle);
		}
		const { cursor } = replay;
		if (
			cursor.revision !== this.#revision ||
			cursor.headHash !== this.#headHash ||
			cursor.generationHighWater !== this.#generationHighWater ||
			replay.frames !== this.#segmentFrames
		)
			this.#unavailable("Authority JSONL contents changed after validation.");
		for (const domain of DOMAINS) {
			const cached = this.#state.rows[domain] as Map<string, StoredRow>;
			const replayed = state.rows[domain] as Map<string, StoredRow>;
			if (cached.size !== replayed.size)
				this.#unavailable("Authority JSONL cached rows do not match replayed evidence.");
			for (const [key, row] of replayed) {
				const stored = cached.get(key);
				if (
					!stored ||
					stored.version !== row.version ||
					canonicalDurableSha256(stored.record) !== canonicalDurableSha256(row.record)
				)
					this.#unavailable("Authority JSONL cached rows do not match replayed evidence.");
			}
		}
		// Memory holds every non-receipt control, the active segment's receipts and any retained current-owner
		// receipts; the remaining receipts are sealed.
		const controls = this.#state.controls;
		for (const [key, value] of state.controls) {
			const cached = controls.get(key);
			if (
				cached === undefined
					? !key.startsWith("receipt:") || replay.receipts.has(key)
					: canonicalDurableSha256(cached) !== canonicalDurableSha256(value)
			)
				this.#unavailable("Authority JSONL cached controls do not match replayed evidence.");
		}
		for (const key of controls.keys())
			if (!state.controls.has(key))
				this.#unavailable("Authority JSONL cached controls do not match replayed evidence.");
		const fence = this.#fence;
		if (!fence || !sameFile(replay.fence, fence) || replay.length !== this.#length || replay.chain !== this.#chain)
			this.#unavailable("Authority JSONL bytes changed after validation.");
	}

	/** A snapshot must equal the replayed state at its boundary, receipts excepted. */
	#assertSnapshotMatches(snapshot: SegmentSnapshot, state: AuthorityState): void {
		let rows = 0;
		for (const row of snapshot.rows) {
			validateDurableRegistryRecord(row.record);
			const replayed = state.rows[row.record.kind].get(
				authorityKey(row.record.kind, authorityRecordKey(row.record)),
			);
			if (
				!replayed ||
				replayed.version !== row.version ||
				canonicalDurableSha256(replayed.record) !== canonicalDurableSha256(row.record)
			)
				throw new DurableStateUnavailableError("Authority JSONL snapshot rows do not match replayed history.");
			rows++;
		}
		for (const domain of DOMAINS) rows -= state.rows[domain].size;
		if (rows !== 0)
			throw new DurableStateUnavailableError("Authority JSONL snapshot rows do not match replayed history.");
		const replayed = new Map<string, unknown>();
		for (const [key, value] of state.controls) if (!key.startsWith("receipt:")) replayed.set(key, value);
		if (!sameControlValues(replayed, snapshot.controls))
			throw new DurableStateUnavailableError("Authority JSONL snapshot controls do not match replayed history.");
	}

	#create(seed: AuthorityExport | undefined, bytes: Buffer): void {
		fs.mkdirSync(path.dirname(this.#path), { recursive: true, mode: 0o700 });
		if (seed) {
			verifyExport(seed, this.identity);
			loadExport(this.#state, seed);
			this.#revision = seed.revision;
			this.#headHash = seed.headHash;
			this.#generationHighWater = seed.generationHighWater;
			this.#base = seedCursor(seed);
			addReceipts(this.#segmentReceipts, seed.controls);
		} else {
			this.#state.setControl("meta", true, genesisMeta());
		}
		// Sealed segments, indexes or snapshots of an earlier store at this name would be read as this store's history.
		if (listJsonlRotationArtifacts(this.#path).length > 0)
			throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
		// A conversion of a long history starts rotated. Conversions run offline; an owner funding capacity keeps
		// the single-segment create, which the bootstrap funding below covers, and rotates on its first admission.
		if (
			seed &&
			!this.#capacity &&
			(bytes.byteLength >= this.#limits.minBytes || seed.frames.length >= this.#limits.maxFrames)
		) {
			if (fs.existsSync(this.#path))
				throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
			this.#createRotated(bytes);
			return;
		}
		// The exact header bytes were included in bootstrap funding before directory or file creation.
		let handle: number;
		try {
			handle = fs.openSync(
				this.#path,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
				0o600,
			);
		} catch (error) {
			if (["EEXIST", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
			throw error;
		}
		try {
			this.#capacity?.fundBootstrap({
				jsonlBytes: bytes.byteLength,
				sqliteDatabaseBytes: 0,
				sqliteWalBytes: 0,
				sqliteShmBytes: 0,
			});
			this.#writeAll(handle, bytes);
			durableFsyncSync(handle);
			this.#fence = fenceOf(fs.fstatSync(handle, { bigint: true }));
			this.#length = bytes.byteLength;
			this.#chain = chainLine(LINE_CHAIN_SEED, bytes);
			this.#tail = tailOf(bytes);
			this.#segmentHasher.update(bytes);
		} catch (error) {
			this.#unavailableError = new DurableStateUnavailableError(
				error instanceof Error ? error.message : String(error),
				{ cause: error },
			);
			throw error;
		} finally {
			fs.closeSync(handle);
		}
		fsyncDirectory(path.dirname(this.#path));
	}

	/** Opens the active segment: its base (genesis, seed or snapshot) plus its own frames, never the sealed history. */
	#open(): void {
		try {
			this.#openActive();
		} catch (error) {
			// Only the suffix an interrupted, never-acknowledged write left is repairable; anything else refuses.
			if (!(error instanceof DurableStateUnavailableError)) throw error;
			const recovery = discardUnacknowledgedSuffix(
				this.#path,
				this.identity,
				this.#layout,
				error,
				this.#refusalPath,
			);
			if (recovery === undefined) throw error;
			this.#recoveredTail = recovery;
			this.#openActive();
		}
	}

	#openActive(): void {
		const { handle, stat } = openJournal(this.#path);
		const state = new AuthorityState();
		const loaded: { snapshot?: SegmentSnapshot } = {};
		let replay: SegmentReplay;
		try {
			if (!hasPrivateMode(stat.mode))
				throw new DurableStateUnavailableError("Authority JSONL must be a private regular file.");
			replay = replaySegment(handle, stat, Number(stat.size), this.identity, this.#layout, state, header =>
				activeBase(state, header, this.identity, this.#layout, loaded),
			);
		} finally {
			fs.closeSync(handle);
		}
		this.#state = state;
		this.#revision = replay.cursor.revision;
		this.#headHash = replay.cursor.headHash;
		this.#generationHighWater = replay.cursor.generationHighWater;
		this.#segment = replay.header.version === 3 ? replay.header.header.segment : 0;
		this.#base = replay.base;
		this.#snapshotBytes = replay.header.version === 3 ? replay.header.header.base.snapshot.bytes : 0;
		this.#segmentFrames = replay.frames;
		this.#segmentReceipts = replay.receipts;
		this.#segmentHasher = replay.hasher;
		this.#sealedIndex = loaded.snapshot?.sealed.index;
		this.#sealedReceiptEpoch = loaded.snapshot?.sealed.receiptEpoch ?? 0;
		this.#receiptFloor = this.#sealedReceiptEpoch;
		this.#length = replay.length;
		this.#chain = replay.chain;
		this.#tail = replay.tail;
		this.#fence = replay.fence;
		// After the replay: the active header names the committed segment number, which decides what an
		// interrupted rotation left behind. Removing a stale hard link moves the active inode's ctime, which the
		// first append's full re-read of the active segment absorbs.
		repairRotationArtifacts(this.#layout, this.#segment);
	}

	#rotationDue(): boolean {
		return (
			this.#length >= Math.max(this.#limits.minBytes, this.#snapshotBytes) ||
			this.#segmentFrames >= this.#limits.maxFrames
		);
	}

	/**
	 * Seals the active segment and starts the next one from a snapshot of the committed state, before `frame` is
	 * appended. Each step is durable before the next: (1) the sealed segment's index and (2) the next snapshot are
	 * published (temporary file, fsync, rename, directory fsync); (3) the active inode is hard-linked to its
	 * sealed name; (4) the next segment's header is published over the active name, which commits the rotation;
	 * (5) the previous snapshot is removed. A cut before (4) leaves the active segment as it was and the next
	 * owner discards the partial artifacts; a cut after (4) leaves the complete new layout. Capacity funds each
	 * new file before it is written and refuses before step (1); a frame that consumes a funded promise defers
	 * the rotation instead, so a promised continuation never depends on fresh capacity.
	 *
	 * A failure before (4) changes nothing committed: the owner removes this attempt's artifacts exactly as the
	 * next open would and keeps appending to the segment that stayed active, so `frame` (and every reserved
	 * continuation after it) is decided by its own append, never by the optional rotation. Only a failure after
	 * the header rename, or a rollback that cannot prove the committed layout, makes the store unavailable.
	 */
	#rotate(frame: AuthorityCommitFrame, appendBytes: number): void {
		// The sealed bytes must be exactly the ones this owner verified, and durable before a second name makes them
		// sealed history: an earlier undo's unsynced truncation must not leave the sealed file longer than its index.
		const verified = this.#openVerifiedAppendDescriptor();
		let syncFailure: unknown;
		try {
			durableFsyncSync(verified);
		} catch (error) {
			syncFailure = error;
		}
		try {
			fs.closeSync(verified);
		} catch (error) {
			this.#unavailable(
				"Authority JSONL verification descriptor failed to close.",
				syncFailure === undefined
					? error
					: new AggregateError([syncFailure, error], "Authority JSONL verification sync and close failed."),
			);
		}
		if (syncFailure !== undefined)
			this.#unavailable("Authority JSONL active segment could not be synced before sealing.", syncFailure);
		const layout = this.#layout;
		const sealed = this.#segment;
		const plan = this.#sealingPlan();
		const { indexBytes, snapshotBytes, header } = plan;
		if (
			this.#capacity &&
			!this.#capacity.prepareRotation(
				frame,
				[indexBytes.byteLength, snapshotBytes.byteLength, header.byteLength],
				header.byteLength,
				appendBytes,
			)
		)
			return;
		let headerRenamed = false;
		try {
			// Leftovers of an earlier abandoned attempt or cleanup (for example a stale snapshot) go first.
			repairRotationArtifacts(layout, sealed);
			this.#publish(layout.index(sealed), indexBytes);
			this.#publish(layout.snapshot(sealed + 1), snapshotBytes);
			fs.linkSync(layout.active, layout.segment(sealed));
			fsyncDirectory(layout.directory);
			this.#publish(layout.active, header, () => {
				headerRenamed = true;
			});
		} catch (error) {
			if (headerRenamed)
				this.#unavailable(
					"Authority JSONL segment rotation published its header but could not make it durable; reopen the store to recover.",
					error,
				);
			this.#abandonRotation(error);
			return;
		}
		// Committed: the active payload is the new segment.
		this.#enterSealedPlan(plan);
		try {
			this.#fence = this.#publishedHeaderFence(header);
		} catch (error) {
			this.#unavailable(
				"Authority JSONL segment rotation committed but its header could not be re-observed; reopen the store to recover.",
				error,
			);
		}
		// The receipts just sealed leave memory (other than the current owner's); a built lookup must now answer for them.
		try {
			this.#sealedReceipts?.add(`${layout.stem}.${plan.indexRef.file}`, plan.indexRef, indexBytes, plan.index);
		} catch (error) {
			this.#unavailable(
				"Authority JSONL segment rotation committed but its sealed receipts could not be indexed; reopen the store to recover.",
				error,
			);
		}
		if (sealed >= 1) {
			// A previous snapshot that survives is what a committed rotation had not yet deleted: the next rotation
			// or open removes it, so its removal failure costs space, not availability.
			try {
				fs.unlinkSync(layout.snapshot(sealed));
				fsyncDirectory(layout.directory);
			} catch (error) {
				logger.warn(
					"Authority JSONL rotation committed; its previous snapshot is left for the next rotation or open to remove",
					{ file: layout.snapshot(sealed), error: String(error) },
				);
			}
		}
		this.#capacity?.rotated(layout.segment(sealed));
	}

	/**
	 * Undoes a rotation that failed before its header was renamed over the active name: removes the attempt's
	 * index, snapshot, sealed link and temporaries (the committed-layout rule an open applies) and keeps the store
	 * available. The removed link moved the active inode's ctime, so the next append re-reads the active segment
	 * instead of trusting the timestamp fence.
	 */
	#abandonRotation(error: unknown): void {
		// The rollback is decided by the header on disk, not by this owner's view: a rename that took effect but
		// reported an error has already committed the next segment, whose index and snapshot must not be removed.
		let published: number;
		try {
			published = probeSegmentNumber(this.#layout.active);
		} catch (probeError) {
			this.#unavailable(
				"Authority JSONL segment rotation failed and its active header could not be re-read; reopen the store to recover.",
				new AggregateError([error, probeError], "Authority JSONL rotation and its header probe failed."),
			);
		}
		if (published !== this.#segment)
			this.#unavailable(
				`Authority JSONL segment rotation published its header (segment ${published}) although the publication reported a failure; reopen the store to recover.`,
				error,
			);
		try {
			repairRotationArtifacts(this.#layout, published);
		} catch (rollbackError) {
			this.#unavailable(
				"Authority JSONL segment rotation was interrupted before it committed and its artifacts could not be removed; reopen the store to recover.",
				new AggregateError([error, rollbackError], "Authority JSONL rotation and its rollback failed."),
			);
		}
		this.#contentVerified = false;
		logger.warn(
			"Authority JSONL segment rotation failed before its commit point; rolled back and continuing in the active segment",
			{ file: this.#path, error: error instanceof Error ? error.message : String(error) },
		);
	}

	/**
	 * The files that seal the active segment (its bytes are this owner's committed bytes) and start the next one
	 * from the committed state: the sealed segment's index, the next snapshot, and the next segment's header.
	 */
	#sealingPlan(): SealingPlan {
		const sealed = this.#segment;
		const next = sealed + 1;
		const view = this.#committedView();
		const receipts = sortedControls(this.#segmentReceipts);
		let receiptEpoch = this.#sealedReceiptEpoch;
		for (const receipt of receipts) {
			const parts = receiptKeyParts(receipt.key);
			if (parts?.incarnation === this.identity.incarnation && parts.epoch > receiptEpoch) receiptEpoch = parts.epoch;
		}
		const index: SegmentIndex = {
			version: 1,
			kind: "segment-index",
			identity: this.identity,
			segment: sealed,
			segmentBytes: this.#length,
			segmentSha256: this.#segmentHasher.copy().digest("hex"),
			firstRevision: this.#base.revision + 1,
			lastRevision: this.#revision,
			headHash: this.#headHash,
			previous: this.#sealedIndex ?? null,
			receipts,
		};
		const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
		const indexRef: FileRef = { file: indexMember(sealed), bytes: indexBytes.byteLength, sha256: sha256(indexBytes) };
		const stateControls = new Map<string, unknown>();
		for (const [key, value] of view.controls) if (!key.startsWith("receipt:")) stateControls.set(key, value);
		const snapshot: SegmentSnapshot = {
			version: 1,
			kind: "snapshot",
			identity: this.identity,
			segment: next,
			revision: this.#revision,
			headHash: this.#headHash,
			generationHighWater: this.#generationHighWater,
			rows: view.rows,
			controls: sortedControls(stateControls),
			sealed: { index: indexRef, receiptEpoch },
		};
		const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
		const snapshotRef: FileRef = {
			file: snapshotMember(next),
			bytes: snapshotBytes.byteLength,
			sha256: sha256(snapshotBytes),
		};
		const header = segmentHeaderBytes(this.identity, next, {
			revision: this.#revision,
			headHash: this.#headHash,
			generationHighWater: this.#generationHighWater,
			snapshot: snapshotRef,
		});
		const owner = view.controls.get("owner");
		const ownerEpoch =
			isPlainObject(owner) && owner.incarnation === this.identity.incarnation && Number.isSafeInteger(owner.epoch)
				? (owner.epoch as number)
				: undefined;
		return { index, indexBytes, indexRef, receiptEpoch, snapshotBytes, header, ownerEpoch };
	}

	/**
	 * Moves this owner's view onto the segment `plan` started. Receipts of the current owner stay in memory so its
	 * own retries never read sealed history; the rest are now only in the sealed indexes.
	 */
	#enterSealedPlan(plan: SealingPlan): void {
		for (const key of this.#segmentReceipts.keys()) {
			const parts = receiptKeyParts(key);
			const ours = parts?.incarnation === this.identity.incarnation;
			if (ours && plan.ownerEpoch !== undefined && parts.epoch >= plan.ownerEpoch) continue;
			this.#state.setControl(key, false);
			if (ours && parts.epoch > this.#receiptFloor) this.#receiptFloor = parts.epoch;
		}
		this.#segment++;
		this.#base = {
			revision: this.#revision,
			headHash: this.#headHash,
			generationHighWater: this.#generationHighWater,
		};
		this.#snapshotBytes = plan.snapshotBytes.byteLength;
		this.#segmentFrames = 0;
		this.#segmentReceipts = new Map();
		this.#segmentHasher = new Bun.CryptoHasher("sha256").update(plan.header);
		this.#sealedIndex = plan.indexRef;
		this.#sealedReceiptEpoch = plan.receiptEpoch;
		this.#length = plan.header.byteLength;
		this.#chain = chainLine(LINE_CHAIN_SEED, plan.header);
		this.#tail = tailOf(plan.header);
		this.#contentVerified = false;
	}

	#publishedHeaderFence(header: Buffer): FileFence {
		const published = fs.lstatSync(this.#layout.active, { bigint: true });
		if (!published.isFile() || published.size !== BigInt(header.byteLength))
			throw new Error("Authority JSONL active segment is not the published segment header.");
		return fenceOf(published);
	}

	/**
	 * Creates a store from a seed whose history reaches the rotation threshold directly in the rotated layout, so
	 * its first open reads the snapshot and an empty active segment instead of the whole seeded history. Segment 0
	 * is the seeded version-2 header a single-file create would have written. Its index, snapshot 1 and segment 0
	 * are published first; publishing the active segment-1 header (exclusively, by hard link) commits the store,
	 * so a cut before it leaves no store at this name, only artifacts a retried create refuses and its caller's
	 * staging removes.
	 */
	#createRotated(seeded: Buffer): void {
		const layout = this.#layout;
		this.#length = seeded.byteLength;
		this.#segmentHasher.update(seeded);
		const plan = this.#sealingPlan();
		const temporary = `${layout.active}.tmp-${crypto.randomUUID()}`;
		try {
			this.#publish(layout.segment(0), seeded);
			this.#publish(layout.index(0), plan.indexBytes);
			this.#publish(layout.snapshot(1), plan.snapshotBytes);
			const handle = fs.openSync(
				temporary,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
				0o600,
			);
			try {
				this.#writeAll(handle, plan.header);
				durableFsyncSync(handle);
			} finally {
				fs.closeSync(handle);
			}
			try {
				fs.linkSync(temporary, layout.active);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST")
					throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
				throw error;
			}
			fs.unlinkSync(temporary);
			fsyncDirectory(layout.directory);
		} catch (error) {
			try {
				fs.unlinkSync(temporary);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
					throw new AggregateError([error, unlinkError], "Authority JSONL rotated create and its cleanup failed.");
			}
			this.#unavailableError = new DurableStateUnavailableError(
				error instanceof Error ? error.message : String(error),
				{ cause: error },
			);
			throw error;
		}
		this.#enterSealedPlan(plan);
		this.#fence = this.#publishedHeaderFence(plan.header);
	}

	/** Publishes `bytes` at `target` atomically and durably: temporary file, funding, write, fsync, rename, directory fsync. */
	#publish(target: string, bytes: Buffer, onRenamed?: () => void): void {
		const temporary = `${target}.tmp-${crypto.randomUUID()}`;
		let handle: number | undefined = fs.openSync(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
			0o600,
		);
		try {
			this.#capacity?.fundRotationFile(handle, bytes.byteLength);
			this.#writeAll(handle, bytes);
			durableFsyncSync(handle);
			const closing = handle;
			handle = undefined;
			fs.closeSync(closing);
			fs.renameSync(temporary, target);
			onRenamed?.();
		} catch (error) {
			const failures: unknown[] = [error];
			if (handle !== undefined) {
				try {
					fs.closeSync(handle);
				} catch (closeError) {
					failures.push(closeError);
				}
			}
			try {
				fs.unlinkSync(temporary);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") failures.push(unlinkError);
			}
			throw failures.length === 1
				? error
				: new AggregateError(failures, "Authority JSONL rotation file publication and its cleanup failed.");
		}
		fsyncDirectory(this.#layout.directory);
	}

	/**
	 * Proves the descriptor still holds exactly the bytes this owner verified, without reading them when it can:
	 * once every byte has been re-read by this instance, an unchanged inode, length, mtime and ctime suffice
	 * against foreign write(2)/truncate/fallocate calls, which move the timestamps (armFence makes that hold within
	 * one clock tick too). Writes through an already-dirtied shared mapping are outside that guarantee; the
	 * ownership lock excludes cooperating writers and `integrityCheck` re-reads the bytes.
	 */
	#journalUnchanged(handle: number): boolean {
		const fence = this.#fence;
		if (!fence) return false;
		const observed = fs.fstatSync(handle, { bigint: true });
		if (!observed.isFile() || !sameFile(observed, fence) || observed.size !== BigInt(this.#length)) return false;
		if (this.#contentVerified) return observed.mtimeNs === fence.mtimeNs && observed.ctimeNs === fence.ctimeNs;
		if (journalChain(handle, this.#length) !== this.#chain) return false;
		const settled = fs.fstatSync(handle, { bigint: true });
		if (!sameObservation(observed, settled)) return false;
		this.#fence = fenceOf(settled);
		this.#contentVerified = true;
		return true;
	}

	/** Opens the append descriptor and proves it holds the verified journal, or makes the owner unavailable. */
	#openVerifiedAppendDescriptor(): number {
		let handle: number;
		try {
			handle = fs.openSync(this.#path, fs.constants.O_RDWR | fs.constants.O_APPEND | O_NOFOLLOW);
		} catch (error) {
			this.#unavailable("Authority JSONL could not be verified before append.", error);
		}
		let unchanged = false;
		let failure: unknown;
		try {
			unchanged = this.#journalUnchanged(handle);
		} catch (error) {
			failure = error;
		}
		if (unchanged) return handle;
		try {
			fs.closeSync(handle);
		} catch (closeError) {
			failure =
				failure === undefined
					? closeError
					: new AggregateError([failure, closeError], "Authority JSONL verification descriptor failed to close.");
		}
		if (failure !== undefined) this.#unavailable("Authority JSONL could not be verified before append.", failure);
		this.#unavailable("Authority JSONL changed outside its active owner.");
	}

	#appendFrame(frame: AuthorityCommitFrame): void {
		this.#assertAvailable();
		const encoded = Buffer.from(`${JSON.stringify(frame)}\n`);
		if (this.#rotationDue()) this.#rotate(frame, encoded.byteLength);
		let handle: number | undefined = this.#openVerifiedAppendDescriptor();
		let fundedTarget = false;
		try {
			fundedTarget = this.#capacity?.prepare(frame, undefined, encoded.byteLength) ?? false;
		} catch (error) {
			// A refused prepare may already have allocated target blocks, which moves the journal's timestamps;
			// the next append re-reads the bytes instead of trusting the fence.
			this.#contentVerified = false;
			// This exact internal close frame is known never to have entered append.
			if (frame.command.kind === "owner" && frame.command.owner.phase === "closed") this.#deferredCloseFrame = frame;
			try {
				fs.closeSync(handle);
			} catch (closeError) {
				this.#unavailable(
					"Authority JSONL append descriptor failed to close.",
					new AggregateError([error, closeError], "Authority JSONL capacity refusal and descriptor close failed."),
				);
			}
			throw error;
		}
		const capacityPrepared = this.#capacity !== undefined;
		let writeStarted = false;
		try {
			const opened = fs.fstatSync(handle, { bigint: true });
			// Capacity funding inside prepare may legitimately move the timestamps, so after prepare the descriptor
			// is re-checked by identity and length, and its last line must still be the verified chain head.
			if (!opened.isFile() || !this.#fence || !sameFile(opened, this.#fence) || opened.size !== BigInt(this.#length))
				this.#unavailable("Authority JSONL changed before commit.");
			// Funding allocated into the journal, which moved the timestamps the fence relies on, so a foreign
			// same-size rewrite during it would be invisible from here on: re-read every byte before appending.
			if (fundedTarget && !this.#verifiedChain(handle, this.#length))
				this.#unavailable("Authority JSONL changed outside its active owner during capacity funding.");
			if (!readExactly(handle, this.#length - this.#tail.byteLength, this.#tail.byteLength).equals(this.#tail))
				this.#unavailable("Authority JSONL append descriptor does not contain the verified bytes.");
			writeStarted = true;
			this.#writeAll(handle, encoded);
			// The single durability point: the commit is acknowledged only after its appended bytes are synced.
			durableFsyncSync(handle);
			const after = fs.fstatSync(handle, { bigint: true });
			if (!after.isFile() || !sameFile(after, opened) || after.size !== opened.size + BigInt(encoded.byteLength))
				this.#unavailable("Authority JSONL commit length or identity is uncertain.");
			const named = fs.lstatSync(this.#path, { bigint: true });
			if (
				!readExactly(handle, this.#length, encoded.byteLength).equals(encoded) ||
				!named.isFile() ||
				!sameFile(named, after) ||
				named.size !== after.size
			)
				this.#unavailable("Authority JSONL commit readback is uncertain.");
			const closing = handle;
			handle = undefined;
			// Linux close can consume the descriptor even when it reports an error. The append boundary includes
			// this close: capacity learns of the commit only after it succeeds.
			fs.closeSync(closing);
			this.#length += encoded.byteLength;
			this.#chain = chainLine(this.#chain, encoded);
			this.#tail = tailOf(encoded);
			this.#segmentHasher.update(encoded);
			const settledTarget = this.#capacity?.committed(frame) ?? false;
			if (settledTarget) this.#verifyJournalAfterFunding();
			// Armed after capacity has settled the target so its allocation does not read as a foreign change.
			this.#fence = this.#armFence(after);
			if (frame === this.#deferredCloseFrame) this.#deferredCloseFrame = undefined;
		} catch (error) {
			let cause = error;
			if (handle !== undefined) {
				const closing = handle;
				handle = undefined;
				try {
					fs.closeSync(closing);
				} catch (closeError) {
					cause = new AggregateError([error, closeError], "Authority JSONL append descriptor failed to close.");
				}
			}
			if (capacityPrepared) {
				try {
					this.#capacity?.aborted(frame, writeStarted);
				} catch (capacityError) {
					cause = new AggregateError(
						[cause, capacityError],
						"Authority JSONL append and capacity reconciliation failed.",
					);
				}
			}
			if (writeStarted) this.#unknownOutcome(frame, cause);
			if (this.#unavailableError) throw this.#unavailableError;
			this.#unavailable("Authority JSONL append failed before any write.", cause);
		}
	}

	#beginGroup(): void {
		this.#assertAvailable();
		if (this.#inTransaction || this.#group)
			throw new Error("JSONL authority groups cannot be nested or opened inside a transaction.");
		this.#capacity?.beginGroup();
		this.#group = { frames: [], start: this.#length, bytes: [] };
	}

	#groupMember<T>(group: JsonlGroup, run: () => T): T {
		if (group.failure) throw group.failure;
		this.#assertAvailable();
		if (this.#inTransaction) throw new Error("Nested authority transactions are not supported.");
		this.#inTransaction = true;
		this.#staged = undefined;
		try {
			const result = run();
			this.#commitStaged();
			return result;
		} catch (error) {
			this.#discardStaged();
			// The driver can no longer vouch for the unsynced members before this one: none of them may be reported.
			if (this.#unavailableError && !group.failure)
				throw this.#poisonGroup(group, "a member left the store unavailable", error);
			throw error;
		} finally {
			this.#staged = undefined;
			this.#inTransaction = false;
		}
	}

	#poisonGroup(group: JsonlGroup, reason: string, cause: unknown): DurableStateUnavailableError {
		const closeError = this.#releaseGroupDescriptor(group);
		const unknown = new DurableStateUnavailableError(
			`Authority JSONL commit outcome is unknown for every member of its group (${reason}); preserve the journal for explicit recovery.`,
			{
				unknownOutcome: true,
				cause:
					closeError === undefined
						? cause
						: new AggregateError([cause, closeError], "Authority JSONL group descriptor failed to close."),
			},
		);
		group.failure = unknown;
		if (!this.#unavailableError) this.#unavailableError = unknown;
		this.#capacity?.groupFailed();
		return unknown;
	}

	/**
	 * Appends one group member without a sync, through the group's single append descriptor. Funding is
	 * cumulative: capacity keeps the previous member pending and stages it when this one is prepared, so the group
	 * is priced exactly as its members in a row would be.
	 */
	#appendGroupMember(group: JsonlGroup, frame: AuthorityCommitFrame): void {
		this.#assertAvailable();
		const encoded = Buffer.from(` ${JSON.stringify(frame)}\n`);
		if (this.#rotationDue()) {
			// Sealing needs every byte of the active segment synced, which holds only before the group's first member.
			if (group.frames.length > 0)
				throw new AuthorityGroupBoundaryError(
					new Error("Authority JSONL segment rotation is due; it runs only as the first member of a group."),
				);
			this.#rotate(frame, encoded.byteLength);
		}
		const opening = group.handle === undefined;
		const handle = group.handle ?? this.#openVerifiedAppendDescriptor();
		let fundedTarget = false;
		try {
			fundedTarget = this.#capacity?.prepare(frame, undefined, encoded.byteLength) ?? false;
		} catch (error) {
			this.#contentVerified = false;
			if (opening) {
				try {
					fs.closeSync(handle);
				} catch (closeError) {
					this.#unavailable(
						"Authority JSONL append descriptor failed to close.",
						new AggregateError(
							[error, closeError],
							"Authority JSONL capacity refusal and descriptor close failed.",
						),
					);
				}
			}
			// A later member is funded against an unrefilled group reserve; only a group of its own is the serial test.
			if (group.frames.length > 0) throw new AuthorityGroupBoundaryError(error);
			throw error;
		}
		group.handle = handle;
		const start = this.#length;
		let writeStarted = false;
		try {
			const opened = fs.fstatSync(handle, { bigint: true });
			if (!opened.isFile() || !this.#fence || !sameFile(opened, this.#fence) || opened.size !== BigInt(this.#length))
				this.#unavailable("Authority JSONL changed before commit.");
			if (fundedTarget && !this.#verifiedChain(handle, this.#length))
				this.#unavailable("Authority JSONL changed outside its active owner during capacity funding.");
			if (!readExactly(handle, this.#length - this.#tail.byteLength, this.#tail.byteLength).equals(this.#tail))
				this.#unavailable("Authority JSONL append descriptor does not contain the verified bytes.");
			writeStarted = true;
			this.#writeAll(handle, encoded);
			const after = fs.fstatSync(handle, { bigint: true });
			if (!after.isFile() || !sameFile(after, opened) || after.size !== opened.size + BigInt(encoded.byteLength))
				this.#unavailable("Authority JSONL group member length or identity is uncertain.");
			if (!readExactly(handle, start, encoded.byteLength).equals(encoded))
				this.#unavailable("Authority JSONL group member readback is uncertain.");
			// The fence is armed before the owner's view advances: if arming throws, the undo below sees the view of
			// the earlier members, and the segment digest a later seal records never includes the undone member.
			this.#fence = this.#armFence(after);
			this.#length += encoded.byteLength;
			this.#chain = chainLine(this.#chain, encoded);
			this.#tail = tailOf(encoded);
			this.#segmentHasher.update(encoded);
			// A first member that rotated starts the group in the new segment.
			if (group.frames.length === 0) group.start = start;
			group.frames.push(frame);
			group.bytes.push(encoded);
		} catch (error) {
			let cause = error;
			if (writeStarted && !this.#unavailableError) {
				// Undo this member alone: cut the file back to its start and prove the earlier members are intact.
				try {
					fs.ftruncateSync(handle, start);
					const cut = fs.fstatSync(handle, { bigint: true });
					if (
						cut.size !== BigInt(start) ||
						this.#length !== start ||
						!readExactly(handle, start - this.#tail.byteLength, this.#tail.byteLength).equals(this.#tail)
					)
						throw new Error("Authority JSONL group member truncation did not restore its start.");
					// The member is reported as a known refusal, so its cut must be durable first: otherwise writeback of
					// the fully written line could let a reopen replay it as committed. With capacity on, re-funding may
					// sync too, but only when it re-allocates, so the cut is synced here in every mode.
					durableFsyncSync(handle);
					// The cut also freed any funded arena past it; capacity re-allocates it, which moves the timestamps,
					// so the earlier members' bytes are re-proved before the fence is armed.
					if (this.#capacity?.jsonlTargetTruncated(handle)) this.#verifyJournalAfterFunding();
					this.#fence = this.#armFence(cut);
					this.#capacity?.groupMemberAborted(frame);
					if (group.frames.length === 0) this.#releaseGroupDescriptor(group);
					throw error;
				} catch (undoError) {
					if (undoError === error) throw error;
					cause = new AggregateError(
						[error, undoError],
						"Authority JSONL group member write and its truncation failed.",
					);
				}
			}
			if (writeStarted) throw this.#poisonGroup(group, "a member's write could not be undone", cause);
			try {
				this.#capacity?.groupMemberAborted(frame);
			} catch (capacityError) {
				cause = new AggregateError(
					[cause, capacityError],
					"Authority JSONL group member and capacity reconciliation failed.",
				);
			}
			if (this.#unavailableError) throw this.#unavailableError;
			this.#unavailable("Authority JSONL group member failed before any write.", cause);
		}
	}

	/** Closes the group's append descriptor once; a close error consumes the descriptor anyway and is never retried. */
	#releaseGroupDescriptor(group: JsonlGroup): unknown {
		const handle = group.handle;
		group.handle = undefined;
		if (handle === undefined) return undefined;
		try {
			fs.closeSync(handle);
			return undefined;
		} catch (error) {
			return error;
		}
	}

	/**
	 * One durable sync for every member appended since begin(), with the same boundary as an ungrouped append:
	 * fsync on an append descriptor, readback of the group's bytes, and a close that is part of the boundary.
	 * (An append grows the file, so fdatasync would flush the same metadata; one boundary keeps one proof.)
	 * Capacity settles the group only after it.
	 */
	#syncGroup(): void {
		const group = this.#group;
		if (!group) throw new Error("JSONL authority has no open group to sync.");
		if (this.#inTransaction) throw new Error("JSONL authority cannot sync a group while a member is running.");
		this.#group = undefined;
		if (group.failure) {
			this.#releaseGroupDescriptor(group);
			throw group.failure;
		}
		if (group.frames.length > 0) {
			const expected = Buffer.concat(group.bytes);
			const handle = group.handle;
			group.handle = undefined;
			let failure: unknown;
			try {
				if (handle === undefined) throw new Error("Authority JSONL group lost its append descriptor.");
				const opened = fs.fstatSync(handle, { bigint: true });
				if (
					!opened.isFile() ||
					!this.#fence ||
					!sameFile(opened, this.#fence) ||
					opened.size !== BigInt(this.#length) ||
					group.start + expected.byteLength !== this.#length
				)
					throw new Error("Authority JSONL changed before its group sync.");
				durableFsyncSync(handle);
				const after = fs.fstatSync(handle, { bigint: true });
				const named = fs.lstatSync(this.#path, { bigint: true });
				if (
					!after.isFile() ||
					!sameFile(after, opened) ||
					after.size !== opened.size ||
					!readExactly(handle, group.start, expected.byteLength).equals(expected) ||
					!named.isFile() ||
					!sameFile(named, after) ||
					named.size !== after.size
				)
					throw new Error("Authority JSONL group readback is uncertain.");
			} catch (error) {
				failure = error;
			}
			if (handle !== undefined) {
				// Linux close can consume the descriptor even when it reports an error; never retry its number.
				try {
					fs.closeSync(handle);
				} catch (closeError) {
					failure =
						failure === undefined
							? closeError
							: new AggregateError(
									[failure, closeError],
									"Authority JSONL group sync descriptor failed to close.",
								);
				}
			}
			if (failure !== undefined) throw this.#poisonGroup(group, "its sync did not complete", failure);
		}
		// The group is durable. A settlement failure from here on cannot make it unknown to the store, but this owner
		// can no longer vouch for its fence or capacity view, so it stops admitting (its members' replies are unknown).
		try {
			this.#capacity?.groupCommitted();
			const settled = fs.lstatSync(this.#path, { bigint: true });
			// Settlement may allocate into the journal, which moves the timestamps the fence relies on: re-prove the bytes then.
			if (this.#fence && (settled.mtimeNs !== this.#fence.mtimeNs || settled.ctimeNs !== this.#fence.ctimeNs)) {
				this.#verifyJournalAfterFunding();
				this.#fence = this.#armFence(settled);
			}
		} catch (error) {
			this.#unavailable(
				"Authority JSONL group committed but its settlement failed; reopen the store to continue.",
				error,
			);
		}
		for (const frame of group.frames) if (frame === this.#deferredCloseFrame) this.#deferredCloseFrame = undefined;
	}

	/**
	 * Sets mtime to a millisecond strictly before the current one so that any later write by anyone, whose kernel
	 * timestamp is at least the current coarse tick, is guaranteed to leave a different mtime. Without this, a
	 * same-size rewrite landing in the same coarse clock tick (4 ms here) as our own append would keep both
	 * timestamps unchanged. The value only lives in this owner's memory, so it needs no fsync. Runs on the path
	 * after the append descriptor is closed, so the inode is re-checked against the committed one around it.
	 */
	#armFence(committed: fs.BigIntStats): FileFence {
		const observed = fs.lstatSync(this.#path, { bigint: true });
		if (!observed.isFile() || !sameFile(observed, committed) || observed.size !== committed.size)
			this.#unavailable("Authority JSONL changed after its committed append.");
		fs.lutimesSync(
			this.#path,
			Number(observed.atimeNs / 1_000_000n) / 1000,
			(Number(observed.mtimeNs / 1_000_000n) - 1) / 1000,
		);
		const armed = fs.lstatSync(this.#path, { bigint: true });
		if (!armed.isFile() || !sameFile(armed, committed) || armed.size !== committed.size)
			this.#unavailable("Authority JSONL changed after its committed append.");
		return fenceOf(armed);
	}

	/** Full chain re-read of `[0, length)`, stable across the read: the proof that does not rely on timestamps. */
	#verifiedChain(handle: number, length: number): boolean {
		const before = fs.fstatSync(handle, { bigint: true });
		if (!before.isFile() || before.size !== BigInt(length) || journalChain(handle, length) !== this.#chain)
			return false;
		return sameObservation(before, fs.fstatSync(handle, { bigint: true }));
	}

	/** After settlement allocated into the journal, re-proves its bytes on a fresh descriptor before the fence is re-armed. */
	#verifyJournalAfterFunding(): void {
		let verified = false;
		let failure: unknown;
		const { handle } = openJournal(this.#path);
		try {
			verified = this.#verifiedChain(handle, this.#length);
		} catch (error) {
			failure = error;
		} finally {
			fs.closeSync(handle);
		}
		if (!verified)
			this.#unavailable("Authority JSONL changed outside its active owner during capacity settlement.", failure);
	}

	#writeAll(handle: number, bytes: Buffer): void {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const written = fs.writeSync(handle, bytes, offset, bytes.byteLength - offset);
			if (written <= 0) throw new Error("Authority JSONL write made no progress.");
			offset += written;
		}
	}

	#assertAvailable(): void {
		if (this.#closed) throw new DurableStateUnavailableError("Authority JSONL driver is closed.");
		if (this.#unavailableError) throw this.#unavailableError;
	}

	#unavailable(reason: string, cause?: unknown): never {
		if (this.#unavailableError) throw this.#unavailableError;
		const error = new DurableStateUnavailableError(reason, { cause });
		this.#unavailableError = error;
		throw error;
	}

	#unknownOutcome(frame: AuthorityCommitFrame, cause: unknown): never {
		const error = new DurableStateUnavailableError(
			"Authority JSONL commit outcome is unknown; preserve the journal for explicit recovery.",
			{
				unknownOutcome: true,
				cause,
				request: frame.request,
			},
		);
		this.#unavailableError = error;
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Offline streaming inspection and creation (conversions). A converted store's segment 0 is one header line that
// embeds the whole seed export, its index lists every seed receipt and its snapshot every current row, so the
// owner paths above (which parse those lines whole and hold the state in memory) cost O(history) memory there.
// These read and write the same files in bounded memory: lines are scanned, not buffered, and the replayed state
// lives in an AuthorityScratch. They prove exactly what open() + integrityCheck() prove and list exactly what
// exportState() lists.
// ---------------------------------------------------------------------------------------------------------------

const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_KEYS = [
	"version",
	"kind",
	"identity",
	"segment",
	"revision",
	"headHash",
	"generationHighWater",
	"rows",
	"controls",
	"sealed",
];
const INDEX_KEYS = [
	"version",
	"kind",
	"identity",
	"segment",
	"segmentBytes",
	"segmentSha256",
	"firstRevision",
	"lastRevision",
	"headHash",
	"previous",
	"receipts",
];
const SEED_ARRAYS = new Set(["rows", "controls", "frames"]);

/** A private regular file opened for a streaming read, and how it looked when opened. */
interface StreamedFile {
	readonly file: string;
	readonly handle: number;
	readonly stat: fs.BigIntStats;
	readonly length: number;
}

function openStreamedFile(file: string, missing: string, requirePrivate: boolean): StreamedFile {
	const { handle, stat } = openSegment(file, missing);
	if (requirePrivate && !hasPrivateMode(stat.mode)) {
		fs.closeSync(handle);
		throw new DurableStateUnavailableError(
			`Authority JSONL artifact must be a private regular file: ${path.basename(file)}`,
		);
	}
	const length = Number(stat.size);
	if (!Number.isSafeInteger(length)) {
		fs.closeSync(handle);
		throw new DurableStateUnavailableError("Authority JSONL artifact is too large to read.");
	}
	return { file, handle, stat, length };
}

function closeStreamedFile(opened: StreamedFile, what: string): void {
	try {
		if (!sameObservation(opened.stat, fs.fstatSync(opened.handle, { bigint: true })))
			throw new DurableStateUnavailableError(
				`Authority JSONL ${what} changed while it was being read: ${path.basename(opened.file)}`,
			);
	} finally {
		fs.closeSync(opened.handle);
	}
}

function streamSha256(handle: number, length: number): string {
	const hasher = new Bun.CryptoHasher("sha256");
	const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(STREAM_CHUNK_BYTES, length)));
	for (let position = 0; position < length;) {
		const read = fs.readSync(handle, chunk, 0, Math.min(chunk.length, length - position), position);
		if (read <= 0) throw new Error("Authority JSONL ended before its observed length.");
		hasher.update(chunk.subarray(0, read));
		position += read;
	}
	return hasher.digest("hex");
}

/** Like forEachLine, from `from` on, for frame lines only (every line is bounded by the frame line limit). */
function forEachFrameLine(handle: number, from: number, length: number, onLine: (line: Buffer) => void): void {
	let buffer = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, length - from)));
	let start = 0;
	let end = 0;
	let position = from;
	while (position < length) {
		if (end === buffer.byteLength) {
			if (start > 0) {
				buffer.copy(buffer, 0, start, end);
				end -= start;
				start = 0;
			} else {
				if (end >= MAX_FRAME_LINE_BYTES)
					throw new DurableStateUnavailableError("Authority JSONL has a line longer than any frame.");
				const grown = Buffer.allocUnsafe(buffer.byteLength * 2);
				buffer.copy(grown, 0, 0, end);
				buffer = grown;
			}
		}
		const read = fs.readSync(handle, buffer, end, Math.min(buffer.byteLength - end, length - position), position);
		if (read <= 0) throw new Error("Authority JSONL ended before its observed length.");
		end += read;
		position += read;
		const filled = buffer.subarray(0, end);
		let newline = filled.indexOf(NEWLINE, start);
		while (newline !== -1) {
			onLine(filled.subarray(start, newline + 1));
			start = newline + 1;
			newline = filled.indexOf(NEWLINE, start);
		}
	}
	if (start !== end) throw new DurableStateUnavailableError("Authority JSONL ends with a torn line.");
}

function parseFrameLine(line: Buffer): unknown {
	try {
		return JSON.parse(line.toString("utf8", 0, line.byteLength - 1));
	} catch {
		throw new DurableStateUnavailableError("Authority JSONL frame is not valid JSON.");
	}
}

/** A seeded version-2 header line, located: its small members parsed, the seed's three large arrays as ranges. */
interface StreamedSeed {
	readonly sourceIdentity: AuthorityIdentity;
	readonly revision: number;
	readonly generationHighWater: number;
	readonly headHash: string;
	readonly legacy?: AuthorityExport["legacy"];
	readonly rows: JsonRange;
	readonly controls: JsonRange;
	readonly frames: JsonRange;
}

interface StreamedHeader0 {
	readonly identity: AuthorityIdentity;
	readonly seed?: StreamedSeed;
	/** For the seed check: every seed member, the arrays as ranges and the rest parsed. */
	readonly seedMembers?: ReadonlyMap<string, JsonRange | { readonly value: unknown }>;
	readonly headerMembers: ReadonlyMap<string, unknown>;
}

/**
 * The seed's `legacy` member: the whole legacy-v1 journal, held in memory like the live open holds it, but read entry
 * by entry. Each entry is one legacy journal record, so only the member as a whole can exceed the frame-line cap; the
 * live open accepts such a header, and so must the streaming readers. Members keep document order, as JSON.parse does.
 */
function readSeedLegacy(handle: number, range: JsonRange): unknown {
	if (!isJsonObject(handle, range)) return readJsonValue(handle, range);
	let members: Map<string, JsonRange>;
	try {
		members = jsonObjectMembers(handle, range);
	} catch {
		throw new Error("Authority seed export is invalid.");
	}
	const legacy: Record<string, unknown> = {};
	for (const [name, value] of members)
		legacy[name] =
			name === "entries" && isJsonArray(handle, value)
				? [...jsonArrayElements(handle, value)]
				: readJsonValue(handle, value);
	return legacy;
}

/** Locates and checks the fields of a segment-0 (version 2) header line at `range`; verifyHeader without parsing the seed. */
function readSegment0Header(handle: number, range: JsonRange, identity: AuthorityIdentity): StreamedHeader0 {
	let members: Map<string, JsonRange>;
	try {
		members = jsonObjectMembers(handle, range);
	} catch {
		throw new DurableStateUnavailableError("Authority JSONL header is not valid JSON.");
	}
	const keys = [...members.keys()].sort().join("\0");
	if (
		keys !== ["hash", "identity", "kind", "seed", "version"].sort().join("\0") &&
		keys !== ["hash", "identity", "kind", "version"].sort().join("\0")
	)
		throw new Error("Authority JSONL header fields are invalid.");
	const headerMembers = new Map<string, unknown>();
	for (const [name, value] of members) if (name !== "seed") headerMembers.set(name, readJsonValue(handle, value));
	const headerIdentity = headerMembers.get("identity");
	if (headerMembers.get("version") !== 2 || headerMembers.get("kind") !== "header" || !validIdentity(headerIdentity))
		throw new Error("Unsupported authority JSONL header.");
	assertIdentityEqual(headerIdentity, identity);
	const hash = headerMembers.get("hash");
	const seedRange = members.get("seed");
	if (!seedRange) {
		const { hash: _hash, ...content } = Object.fromEntries(headerMembers);
		if (typeof hash !== "string" || hash !== canonicalDurableSha256(content))
			throw new Error("Authority JSONL header hash mismatch.");
		return { identity: headerIdentity, headerMembers };
	}
	let seedRanges: Map<string, JsonRange>;
	try {
		seedRanges = jsonObjectMembers(handle, seedRange);
	} catch {
		throw new Error("Authority seed export is invalid.");
	}
	const seedMembers = new Map<string, JsonRange | { readonly value: unknown }>();
	for (const [name, value] of seedRanges) {
		if (SEED_ARRAYS.has(name) && isJsonArray(handle, value)) seedMembers.set(name, value);
		else if (name === "legacy") seedMembers.set(name, { value: readSeedLegacy(handle, value) });
		else seedMembers.set(name, { value: readJsonValue(handle, value) });
	}
	// The header hash is canonical JSON of every member but `hash`, the seed's arrays streamed element by element.
	const writer = new CanonicalHashWriter().text("{");
	let firstMember = true;
	for (const name of [...members.keys()].filter(name => name !== "hash").sort()) {
		writer.text(firstMember ? "" : ",").key(name);
		firstMember = false;
		if (name !== "seed") {
			writer.value(headerMembers.get(name));
			continue;
		}
		writer.text("{");
		let firstSeed = true;
		for (const seedName of [...seedMembers.keys()].sort()) {
			const member = seedMembers.get(seedName)!;
			writer.text(firstSeed ? "" : ",").key(seedName);
			firstSeed = false;
			if ("value" in member) writer.value(member.value);
			else writer.array(jsonArrayElements(handle, member), element => element);
		}
		writer.text("}");
	}
	if (typeof hash !== "string" || hash !== writer.text("}").digest())
		throw new Error("Authority JSONL header hash mismatch.");
	const scalar = (name: string): unknown => {
		const member = seedMembers.get(name);
		return member && "value" in member ? member.value : undefined;
	};
	const array = (name: string): JsonRange | undefined => {
		const member = seedMembers.get(name);
		return member && !("value" in member) ? member : undefined;
	};
	const sourceIdentity = scalar("sourceIdentity");
	const revision = scalar("revision");
	const generationHighWater = scalar("generationHighWater");
	const headHash = scalar("headHash");
	const rows = array("rows");
	const controls = array("controls");
	const frames = array("frames");
	if (
		scalar("version") !== 2 ||
		!validIdentity(sourceIdentity) ||
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 0 ||
		typeof generationHighWater !== "number" ||
		!Number.isSafeInteger(generationHighWater) ||
		generationHighWater < 0 ||
		typeof headHash !== "string" ||
		!rows ||
		!controls ||
		!frames
	)
		throw new Error("Authority seed export is invalid.");
	if (sourceIdentity.owningSessionId !== identity.owningSessionId)
		throw new Error("Authority seed belongs to a different owning session.");
	const legacy = seedMembers.has("legacy") ? (scalar("legacy") as AuthorityExport["legacy"]) : undefined;
	return {
		identity: headerIdentity,
		headerMembers,
		seedMembers,
		seed: {
			sourceIdentity,
			revision,
			generationHighWater,
			headHash,
			...(legacy !== undefined ? { legacy } : {}),
			rows,
			controls,
			frames,
		},
	};
}

/** The seed of a segment-0 header as an export reader; its receipt controls are looked up in `receipts`. */
function seedReader(
	file: string,
	seed: StreamedSeed,
	receipts: ScratchMap,
	receiptControls: number,
): AuthorityExportReader {
	const withFile = function* <T>(run: (handle: number) => Iterable<T>): Generator<T> {
		const opened = openStreamedFile(file, `Authority JSONL segment is missing: ${path.basename(file)}`, false);
		try {
			yield* run(opened.handle);
		} finally {
			closeStreamedFile(opened, "segment");
		}
	};
	return {
		revision: seed.revision,
		generationHighWater: seed.generationHighWater,
		headHash: seed.headHash,
		...(seed.legacy !== undefined ? { legacy: seed.legacy } : {}),
		receiptControls,
		frames: () =>
			withFile(function* (handle) {
				for (const value of jsonArrayElements(handle, seed.frames)) {
					const frame = value as AuthorityCommitFrame;
					let receipt: unknown;
					try {
						receipt = receipts.get(receiptKeyOf(frame));
					} catch {
						receipt = undefined;
					}
					yield { frame, receipt };
				}
			}),
		rows: () => withFile(handle => jsonArrayElements(handle, seed.rows) as Iterable<AuthorityRow>),
		controls: () =>
			withFile(function* (handle) {
				for (const value of jsonArrayElements(handle, seed.controls)) {
					const control = value as AuthorityControl;
					if (isPlainObject(control) && typeof control.key === "string" && control.key.startsWith("receipt:"))
						continue;
					yield control;
				}
			}),
	};
}

/** Validates a seed's controls and records its receipt controls in `receipts`; returns how many there are. */
function loadSeedReceipts(handle: number, seed: StreamedSeed, receipts: ScratchMap): number {
	let count = 0;
	for (const value of jsonArrayElements(handle, seed.controls)) {
		if (!isPlainObject(value) || typeof value.key !== "string" || value.key.length === 0 || value.key.includes("\0"))
			throw new Error("Authority seed control is invalid or duplicated.");
		canonicalDurableSha256(value.value);
		if (!value.key.startsWith("receipt:")) continue;
		const json = JSON.stringify(value.value);
		if (json === undefined || !receipts.insert(value.key, json))
			throw new Error("Authority seed control is invalid or duplicated.");
		count++;
	}
	return count;
}

/** A sealed segment's index, checked and bound to its recorded digest, without its receipts parsed whole. */
interface StreamedIndex {
	readonly ref: FileRef;
	readonly segmentBytes: number;
	readonly segmentSha256: string;
	readonly firstRevision: number;
	readonly lastRevision: number;
	readonly headHash: string;
	readonly previous: FileRef | null;
	readonly receipts: JsonRange;
}

/** Opens the sibling named by `ref` and proves it holds exactly the bound bytes (readBoundFile, streamed). */
function openBoundDocument(
	layout: JsonlLayout,
	ref: FileRef,
	what: string,
): { readonly opened: StreamedFile; readonly content: JsonRange } {
	const opened = openStreamedFile(
		`${layout.stem}.${ref.file}`,
		`Authority JSONL ${what} is missing: ${ref.file}`,
		true,
	);
	try {
		if (opened.length !== ref.bytes || streamSha256(opened.handle, opened.length) !== ref.sha256)
			throw new DurableStateUnavailableError(
				`Authority JSONL ${what} does not match its recorded digest: ${ref.file}`,
			);
		if (opened.length === 0 || readExactly(opened.handle, opened.length - 1, 1)[0] !== NEWLINE)
			throw new DurableStateUnavailableError(`Authority JSONL ${what} is torn.`);
		return { opened, content: { start: 0, end: opened.length - 1 } };
	} catch (error) {
		fs.closeSync(opened.handle);
		throw error;
	}
}

function documentMembers(handle: number, content: JsonRange, what: string): Map<string, JsonRange> {
	try {
		return jsonObjectMembers(handle, content);
	} catch {
		throw new DurableStateUnavailableError(`Authority JSONL ${what} is not valid JSON.`);
	}
}

/** validControls for an array streamed from a document. */
function checkStreamedControls(
	handle: number,
	range: JsonRange,
	receipts: boolean,
	onControl?: (control: AuthorityControl) => void,
): boolean {
	if (!isJsonArray(handle, range)) return false;
	let previous: string | undefined;
	for (const control of jsonArrayElements(handle, range)) {
		if (
			!isPlainObject(control) ||
			!exactKeys(control, ["key", "value"]) ||
			typeof control.key !== "string" ||
			!control.key ||
			control.key.includes("\0") ||
			control.key.startsWith("receipt:") !== receipts ||
			control.value === undefined
		)
			return false;
		if (previous !== undefined && compareAuthorityKeys(previous, control.key) >= 0) return false;
		previous = control.key;
		onControl?.(control as unknown as AuthorityControl);
	}
	return true;
}

function readStreamedIndex(
	layout: JsonlLayout,
	ref: FileRef,
	segment: number,
	identity: AuthorityIdentity,
): StreamedIndex {
	const { opened, content } = openBoundDocument(layout, ref, "segment index");
	try {
		const members = documentMembers(opened.handle, content, "segment index");
		const value: Record<string, unknown> = {};
		for (const [name, range] of members) if (name !== "receipts") value[name] = readJsonValue(opened.handle, range);
		const receipts = members.get("receipts");
		if (
			!exactKeys(Object.fromEntries(members), INDEX_KEYS) ||
			value.version !== 1 ||
			value.kind !== "segment-index" ||
			!validIdentity(value.identity) ||
			value.segment !== segment ||
			!Number.isSafeInteger(value.segmentBytes) ||
			(value.segmentBytes as number) < 1 ||
			typeof value.segmentSha256 !== "string" ||
			!SHA256_RE.test(value.segmentSha256) ||
			!validRevision(value.firstRevision) ||
			!validRevision(value.lastRevision) ||
			typeof value.headHash !== "string" ||
			!SHA256_RE.test(value.headHash) ||
			(segment === 0 ? value.previous !== null : !validFileRef(value.previous, indexMember(segment - 1))) ||
			!receipts ||
			!checkStreamedControls(opened.handle, receipts, true)
		)
			throw new DurableStateUnavailableError(`Authority JSONL segment ${segment} index is invalid.`);
		assertIdentityEqual(value.identity, identity);
		return {
			ref,
			segmentBytes: value.segmentBytes as number,
			segmentSha256: value.segmentSha256,
			firstRevision: value.firstRevision,
			lastRevision: value.lastRevision,
			headHash: value.headHash,
			previous: value.previous as FileRef | null,
			receipts,
		};
	} finally {
		closeStreamedFile(opened, "segment index");
	}
}

/** Receipts of a sealed index, streamed from its bound file. */
function* streamedIndexReceipts(layout: JsonlLayout, index: StreamedIndex): Generator<AuthorityControl> {
	const { opened } = openBoundDocument(layout, index.ref, "segment index");
	try {
		for (const control of jsonArrayElements(opened.handle, index.receipts)) yield control as AuthorityControl;
	} finally {
		closeStreamedFile(opened, "segment index");
	}
}

/** The snapshot an active segment header names, checked (readSnapshot, streamed); rows and controls stay ranges. */
interface StreamedSnapshot {
	readonly ref: FileRef;
	readonly rows: JsonRange;
	readonly controls: JsonRange;
	/** Index of segment `segment - 1`, the head of the sealed index chain. */
	readonly index: FileRef;
	readonly receiptEpoch: number;
}

function readStreamedSnapshot(
	layout: JsonlLayout,
	header: SegmentHeader,
	identity: AuthorityIdentity,
): StreamedSnapshot {
	const ref = header.base.snapshot;
	const { opened, content } = openBoundDocument(layout, ref, "snapshot");
	try {
		const members = documentMembers(opened.handle, content, "snapshot");
		const value: Record<string, unknown> = {};
		for (const [name, range] of members)
			if (name !== "rows" && name !== "controls") value[name] = readJsonValue(opened.handle, range);
		const base = header.base;
		const sealed = value.sealed;
		const rows = members.get("rows");
		const controls = members.get("controls");
		let meta: unknown;
		if (
			!exactKeys(Object.fromEntries(members), SNAPSHOT_KEYS) ||
			value.version !== 1 ||
			value.kind !== "snapshot" ||
			!validIdentity(value.identity) ||
			value.segment !== header.segment ||
			value.revision !== base.revision ||
			value.headHash !== base.headHash ||
			value.generationHighWater !== base.generationHighWater ||
			!rows ||
			!isJsonArray(opened.handle, rows) ||
			!controls ||
			!checkStreamedControls(opened.handle, controls, false, control => {
				if (control.key === "meta") meta = control.value;
			}) ||
			!isPlainObject(sealed) ||
			!exactKeys(sealed, ["index", "receiptEpoch"]) ||
			!validFileRef(sealed.index, indexMember(header.segment - 1)) ||
			!validRevision(sealed.receiptEpoch)
		)
			throw new DurableStateUnavailableError("Authority JSONL snapshot does not match its segment header.");
		assertIdentityEqual(value.identity, identity);
		if (
			!isPlainObject(meta) ||
			meta.revision !== base.revision ||
			meta.headHash !== base.headHash ||
			meta.generationHighWater !== base.generationHighWater
		)
			throw new DurableStateUnavailableError("Authority JSONL snapshot metadata does not match its segment header.");
		return { ref, rows, controls, index: sealed.index, receiptEpoch: sealed.receiptEpoch };
	} finally {
		closeStreamedFile(opened, "snapshot");
	}
}

/** Rows and controls of a bound snapshot, streamed (rows shape-checked as validRows does). */
function* streamedSnapshotItems(
	layout: JsonlLayout,
	snapshot: StreamedSnapshot,
	member: "rows" | "controls",
): Generator<unknown> {
	const { opened } = openBoundDocument(layout, snapshot.ref, "snapshot");
	try {
		for (const item of jsonArrayElements(opened.handle, snapshot[member])) {
			if (
				member === "rows" &&
				(!isPlainObject(item) ||
					!exactKeys(item, ["record", "version"]) ||
					!Number.isSafeInteger(item.version) ||
					(item.version as number) < 1 ||
					!isPlainObject(item.record) ||
					!DOMAINS.includes(item.record.kind as AuthorityDomain))
			)
				throw new DurableStateUnavailableError("Authority JSONL snapshot does not match its segment header.");
			yield item;
		}
	} finally {
		closeStreamedFile(opened, "snapshot");
	}
}

/** applyCommittedFrame against the on-disk replay state; `overlay` collects what the active segment changed. */
function applyStreamedFrame(
	state: AuthorityReplayState,
	frame: AuthorityCommitFrame,
	cursor: ReplayCursor,
	identity: AuthorityIdentity,
	segmentReceipts: ScratchMap,
	overlay?: { readonly rows: ScratchMap; readonly controls: ScratchMap },
): ReplayCursor {
	if (frame.revision !== cursor.revision + 1) throw new DurableStateConflictError("Authority frame revision changed.");
	if (frame.request.incarnation !== identity.incarnation)
		throw new DurableStateUnavailableError("Authority frame incarnation does not match selected identity.");
	const expectedVersions = new Map<string, number | null>();
	for (const expected of frame.expected) {
		const key = authorityKey(expected.domain, expected.key);
		if (expectedVersions.has(key)) throw new Error("Authority frame repeats an expected row key.");
		expectedVersions.set(key, expected.version);
		if ((state.getRow(key)?.version ?? null) !== expected.version)
			throw new DurableStateUnavailableError("Authority frame expected row version mismatch.");
	}
	validateAuthorityFrameState(frame, state.frameState);
	for (const row of frame.changes) {
		const key = authorityKey(row.record.kind, authorityRecordKey(row.record));
		if (!expectedVersions.has(key) || row.version !== (expectedVersions.get(key) ?? 0) + 1)
			throw new Error("Authority frame row version is invalid.");
		state.setRow(row, key);
		overlay?.rows.set(key, JSON.stringify(row));
	}
	const metaChange = frame.controls.find(control => control.key === "meta");
	if (
		!metaChange ||
		metaChange.deleted ||
		!metaChange.value ||
		typeof metaChange.value !== "object" ||
		Array.isArray(metaChange.value)
	)
		throw new Error("Authority frame is missing metadata.");
	const meta = metaChange.value as Record<string, unknown>;
	if (meta.revision !== frame.revision || !Number.isSafeInteger(meta.generationHighWater))
		throw new Error("Authority frame metadata is invalid.");
	for (const control of frame.controls) {
		if (control.key.startsWith("receipt:")) {
			// A receipt joins the history the export lists; frame validation pins it to the frame's own receipt.
			if (control.deleted)
				throw new DurableStateUnavailableError("Authority JSONL frame deletes a receipt control.");
			const json = JSON.stringify(control.value);
			state.receipts.set(control.key, json);
			segmentReceipts.set(control.key, json);
			continue;
		}
		const value =
			control.key === "meta" ? { ...meta, headHash: frame.hash } : control.deleted ? undefined : control.value;
		if (control.deleted) state.deleteControl(control.key);
		else state.setControl(control.key, value);
		overlay?.controls.set(
			control.key,
			JSON.stringify(control.deleted ? { present: false } : { present: true, value }),
		);
	}
	return { revision: frame.revision, headHash: frame.hash, generationHighWater: meta.generationHighWater as number };
}

/** Merges a strictly ascending base with an overlay of replacements (and, for controls, deletions). */
function* overlaid<T>(
	base: Iterable<T>,
	keyOf: (item: T) => string,
	overlay: ScratchMap,
	fromOverlay: (key: string, json: string) => T | undefined,
	what: string,
): Generator<T> {
	const changes = overlay.entries()[Symbol.iterator]();
	let change = changes.next();
	let previous: string | undefined;
	for (const item of base) {
		const key = keyOf(item);
		if (previous !== undefined && compareAuthorityKeys(previous, key) >= 0)
			throw new DurableStateUnavailableError(`Authority JSONL ${what} are not in strictly ascending key order.`);
		previous = key;
		while (!change.done && compareAuthorityKeys(change.value.key, key) < 0) {
			const added = fromOverlay(change.value.key, change.value.json);
			if (added !== undefined) yield added;
			change = changes.next();
		}
		if (!change.done && change.value.key === key) {
			const replaced = fromOverlay(change.value.key, change.value.json);
			if (replaced !== undefined) yield replaced;
			change = changes.next();
			continue;
		}
		yield item;
	}
	while (!change.done) {
		const added = fromOverlay(change.value.key, change.value.json);
		if (added !== undefined) yield added;
		change = changes.next();
	}
}

/** Per-segment facts the export view needs after the verification pass. */
interface VerifiedSegment {
	readonly file: string;
	readonly length: number;
	readonly headerEnd: number;
}

/**
 * open() + integrityCheck() + exportState() of a JSONL store in bounded memory. Every sealed segment is replayed
 * against its index (length, SHA-256, revision range, head, receipts), a seed is checked against its own history
 * (verifyExport) and its header hash, the active snapshot must equal the replayed state at its boundary, and the
 * active segment is replayed on top. The returned view lists exactly what exportState() would.
 */
function inspectJsonlStream(
	layout: JsonlLayout,
	identity: AuthorityIdentity,
	directory: string,
	disposable: boolean,
): { readonly view: AuthorityExportView; close(): void } {
	const scratch = new AuthorityScratch(directory);
	try {
		const segment = probeSegmentNumber(layout.active);
		if (disposable) repairRotationArtifacts(layout, segment);
		else if (plannedRotationRepair(layout, segment).length > 0)
			throw new DurableStateUnavailableError("Authority JSONL store has interrupted rotation artifacts.");
		const state = new AuthorityReplayState(scratch);
		const seedReceipts = scratch.map();
		const segmentReceipts = scratch.map();
		const overlay = { rows: scratch.map(), controls: scratch.map() };
		const indexes = scratch.map();
		let snapshot: StreamedSnapshot | undefined;
		if (segment >= 1) {
			const active = openStreamedFile(layout.active, "Selected authority JSONL payload is missing.", true);
			let header: ParsedHeader;
			try {
				const end = lineEnd(active.handle, 0, Math.min(active.length, SEGMENT_HEADER_PROBE_BYTES));
				if (end < 0) throw new DurableStateUnavailableError("Authority JSONL header is missing.");
				header = parseSegmentHeader(readExactly(active.handle, 0, end - 1).toString("utf8"), identity, layout);
			} finally {
				closeStreamedFile(active, "active segment");
			}
			if (header.version !== 3 || header.header.segment !== segment)
				throw new DurableStateUnavailableError("Authority JSONL active header does not name its segment.");
			snapshot = readStreamedSnapshot(layout, header.header, identity);
			let next: FileRef | undefined = snapshot.index;
			for (let number = segment - 1; number >= 0; number--) {
				if (!next) throw new DurableStateUnavailableError("Authority JSONL sealed index chain is incomplete.");
				const index = readStreamedIndex(layout, next, number, identity);
				indexes.set(String(number).padStart(10, "0"), JSON.stringify(index));
				next = index.previous ?? undefined;
			}
			if (next)
				throw new DurableStateUnavailableError(
					"Authority JSONL sealed index chain is longer than its sealed segments.",
				);
		}
		const verified: VerifiedSegment[] = [];
		let seed: StreamedSeed | undefined;
		let previous: ReplayCursor | undefined;
		let sealedReceiptEpoch = 0;
		for (let number = 0; number <= segment; number++) {
			const isActive = number === segment;
			const index = isActive
				? undefined
				: (JSON.parse(indexes.getJson(String(number).padStart(10, "0"))!) as StreamedIndex);
			const file = isActive ? layout.active : layout.segment(number);
			const opened = openStreamedFile(
				file,
				isActive
					? "Selected authority JSONL payload is missing."
					: `Authority JSONL sealed segment ${number} is missing.`,
				true,
			);
			let base: ReplayCursor;
			let cursor: ReplayCursor;
			let headerEnd: number;
			try {
				if (index && opened.stat.size !== BigInt(index.segmentBytes))
					throw new DurableStateUnavailableError(
						`Authority JSONL sealed segment ${number} does not match its index.`,
					);
				const length = opened.length;
				if (length === 0 || readExactly(opened.handle, length - 1, 1)[0] !== NEWLINE)
					throw new DurableStateUnavailableError("Authority JSONL ends with a torn line.");
				headerEnd = lineEnd(opened.handle, 0, length);
				if (headerEnd < 0) throw new DurableStateUnavailableError("Authority JSONL header is missing.");
				segmentReceipts.clear();
				if (number === 0) {
					const header0 = readSegment0Header(opened.handle, { start: 0, end: headerEnd - 1 }, identity);
					seed = header0.seed;
					if (seed) {
						const receiptControls = loadSeedReceipts(opened.handle, seed, seedReceipts);
						segmentReceipts.copyFrom(seedReceipts);
						verifyExportReader(seedReader(file, seed, seedReceipts, receiptControls), state, seed.sourceIdentity);
						base = {
							revision: seed.revision,
							headHash: seed.headHash,
							generationHighWater: seed.generationHighWater,
						};
					} else {
						loadExportBaseline(state, identity, undefined);
						base = genesisCursor();
					}
				} else {
					const header = parseSegmentHeader(
						readExactly(opened.handle, 0, headerEnd - 1).toString("utf8"),
						identity,
						layout,
					);
					base = continuationBase(header, number, previous);
				}
				if (isActive && snapshot) {
					// The active snapshot must equal the replayed state at its boundary, receipts excepted.
					if (snapshot.receiptEpoch !== sealedReceiptEpoch)
						throw new DurableStateUnavailableError("Authority JSONL snapshot does not name the sealed history.");
					let rows = 0;
					for (const item of streamedSnapshotItems(layout, snapshot, "rows")) {
						const row = item as AuthorityRow;
						validateDurableRegistryRecord(row.record);
						const replayed = state.getRow(authorityKey(row.record.kind, authorityRecordKey(row.record)));
						if (
							!replayed ||
							replayed.version !== row.version ||
							canonicalDurableSha256(replayed.record) !== canonicalDurableSha256(row.record)
						)
							throw new DurableStateUnavailableError(
								"Authority JSONL snapshot rows do not match replayed history.",
							);
						rows++;
					}
					if (rows !== state.rows.size)
						throw new DurableStateUnavailableError(
							"Authority JSONL snapshot rows do not match replayed history.",
						);
					let controls = 0;
					for (const item of streamedSnapshotItems(layout, snapshot, "controls")) {
						const control = item as AuthorityControl;
						const replayed = state.controls.getJson(control.key);
						if (
							replayed === undefined ||
							canonicalDurableSha256(JSON.parse(replayed)) !== canonicalDurableSha256(control.value)
						)
							throw new DurableStateUnavailableError(
								"Authority JSONL snapshot controls do not match replayed history.",
							);
						controls++;
					}
					if (controls !== state.controls.size)
						throw new DurableStateUnavailableError(
							"Authority JSONL snapshot controls do not match replayed history.",
						);
				}
				cursor = base;
				forEachFrameLine(opened.handle, headerEnd, length, line => {
					const raw = parseFrameLine(line);
					validateAuthorityFrame(raw, cursor.headHash);
					if (raw.revision !== cursor.revision + 1)
						throw new DurableStateUnavailableError("Authority JSONL frame revision is discontinuous.");
					cursor = applyStreamedFrame(
						state,
						raw,
						cursor,
						identity,
						segmentReceipts,
						isActive ? overlay : undefined,
					);
				});
				if (index) {
					if (
						streamSha256(opened.handle, length) !== index.segmentSha256 ||
						base.revision + 1 !== index.firstRevision ||
						cursor.revision !== index.lastRevision ||
						cursor.headHash !== index.headHash
					)
						throw new DurableStateUnavailableError(
							`Authority JSONL sealed segment ${number} does not match its index.`,
						);
					let receipts = 0;
					for (const receipt of streamedIndexReceipts(layout, index)) {
						const replayed = segmentReceipts.getJson(receipt.key);
						if (
							replayed === undefined ||
							canonicalDurableSha256(JSON.parse(replayed)) !== canonicalDurableSha256(receipt.value)
						)
							throw new DurableStateUnavailableError(
								`Authority JSONL sealed segment ${number} does not match its index.`,
							);
						receipts++;
						const parts = receiptKeyParts(receipt.key);
						if (parts?.incarnation === identity.incarnation && parts.epoch > sealedReceiptEpoch)
							sealedReceiptEpoch = parts.epoch;
					}
					if (receipts !== segmentReceipts.size)
						throw new DurableStateUnavailableError(
							`Authority JSONL sealed segment ${number} does not match its index.`,
						);
				}
				verified.push({ file, length, headerEnd });
			} finally {
				closeStreamedFile(opened, isActive ? "active segment" : "sealed segment");
			}
			previous = cursor;
		}
		const meta = state.controls.get("meta");
		if (!isPlainObject(meta) || meta.headHash !== previous!.headHash)
			throw new DurableStateUnavailableError("Authority JSONL metadata head does not match committed frames.");
		const head = previous!;
		const view = jsonlExportView(layout, verified, seed, snapshot, overlay, state.receipts, head);
		return { view, close: () => scratch.close() };
	} catch (error) {
		scratch.close();
		throw error;
	}
}

/** The export of a verified JSONL store, read back in exportState() order. */
function jsonlExportView(
	layout: JsonlLayout,
	segments: readonly VerifiedSegment[],
	seed: StreamedSeed | undefined,
	snapshot: StreamedSnapshot | undefined,
	overlay: { readonly rows: ScratchMap; readonly controls: ScratchMap },
	receipts: ScratchMap,
	head: ReplayCursor,
): AuthorityExportView {
	const withSegment = function* <T>(segment: VerifiedSegment, run: (handle: number) => Iterable<T>): Generator<T> {
		const opened = openStreamedFile(
			segment.file,
			`Authority JSONL segment is missing: ${path.basename(segment.file)}`,
			false,
		);
		try {
			if (opened.length !== segment.length)
				throw new DurableStateUnavailableError(
					`Authority JSONL segment changed after verification: ${path.basename(segment.file)}`,
				);
			yield* run(opened.handle);
		} finally {
			closeStreamedFile(opened, "segment");
		}
	};
	const segment0 = segments[0]!;
	const rowKey = (row: AuthorityRow): string => authorityKey(row.record.kind, authorityRecordKey(row.record));
	const baseRows = (): Iterable<AuthorityRow> => {
		if (snapshot) return streamedSnapshotItems(layout, snapshot, "rows") as Iterable<AuthorityRow>;
		if (seed) return withSegment(segment0, handle => jsonArrayElements(handle, seed.rows) as Iterable<AuthorityRow>);
		return [];
	};
	const baseControls = (): Iterable<AuthorityControl> => {
		if (snapshot) return streamedSnapshotItems(layout, snapshot, "controls") as Iterable<AuthorityControl>;
		if (seed)
			return withSegment(segment0, function* (handle) {
				for (const value of jsonArrayElements(handle, seed.controls)) {
					const control = value as AuthorityControl;
					if (control.key.startsWith("receipt:")) continue;
					// loadExport: the seed's meta, completed with the seed header's position.
					yield control.key === "meta"
						? {
								key: control.key,
								value: {
									...(control.value as object),
									revision: seed.revision,
									generationHighWater: seed.generationHighWater,
									headHash: seed.headHash,
								},
							}
						: control;
				}
			});
		return [{ key: "meta", value: genesisMeta() }];
	};
	return {
		revision: head.revision,
		generationHighWater: head.generationHighWater,
		headHash: head.headHash,
		...(seed?.legacy !== undefined ? { legacy: seed.legacy } : {}),
		rows: () => overlaid(baseRows(), rowKey, overlay.rows, (_key, json) => JSON.parse(json) as AuthorityRow, "rows"),
		controls: () =>
			mergedControls(
				overlaid(
					baseControls(),
					control => control.key,
					overlay.controls,
					(key, json) => {
						const slot = JSON.parse(json) as { present: boolean; value?: unknown };
						return slot.present ? { key, value: slot.value } : undefined;
					},
					"controls",
				),
				receipts,
			),
		*frames() {
			const withReceipt = (frame: AuthorityCommitFrame): AuthorityStreamFrame => ({
				frame,
				receipt: receipts.get(receiptKeyOf(frame)),
			});
			if (seed)
				for (const value of withSegment(segment0, handle => jsonArrayElements(handle, seed.frames)))
					yield withReceipt(value as AuthorityCommitFrame);
			// Lines are parsed one at a time; each is handed out before the next is read.
			for (const segment of segments)
				for (const frame of withSegment(segment, handle => frameLines(handle, segment.headerEnd, segment.length)))
					yield withReceipt(frame);
		},
	};
}

/** Frame lines of a segment as a lazy sequence (forEachFrameLine is push-based; this reads in bounded chunks). */
function* frameLines(handle: number, from: number, length: number): Generator<AuthorityCommitFrame> {
	let buffer = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, length - from)));
	let start = 0;
	let end = 0;
	let position = from;
	while (position < length) {
		if (end === buffer.byteLength) {
			if (start > 0) {
				buffer.copy(buffer, 0, start, end);
				end -= start;
				start = 0;
			} else {
				if (end >= MAX_FRAME_LINE_BYTES)
					throw new DurableStateUnavailableError("Authority JSONL has a line longer than any frame.");
				const grown = Buffer.allocUnsafe(buffer.byteLength * 2);
				buffer.copy(grown, 0, 0, end);
				buffer = grown;
			}
		}
		const read = fs.readSync(handle, buffer, end, Math.min(buffer.byteLength - end, length - position), position);
		if (read <= 0) throw new Error("Authority JSONL ended before its observed length.");
		end += read;
		position += read;
		let newline = buffer.subarray(0, end).indexOf(NEWLINE, start);
		while (newline !== -1) {
			const frame = parseFrameLine(buffer.subarray(start, newline + 1)) as AuthorityCommitFrame;
			start = newline + 1;
			yield frame;
			newline = buffer.subarray(0, end).indexOf(NEWLINE, start);
		}
	}
	if (start !== end) throw new DurableStateUnavailableError("Authority JSONL ends with a torn line.");
}

/**
 * Inspects the JSONL store at `activePath` for an offline conversion (open + integrityCheck + exportState, in
 * bounded memory), using `directory` for its scratch file. On a `disposable` copy it settles the store as open()
 * would (interrupted rotation artifacts removed, a provably unacknowledged suffix of the active segment cut);
 * otherwise (a freshly staged target, inspected where it lies) it changes nothing and refuses either condition.
 * A refusal of the tail names `refusalPath` (the real payload a disposable copy was taken from), never the copy.
 */
export function openJsonlVerifiedExport(
	activePath: string,
	identity: AuthorityIdentity,
	directory: string,
	disposable: boolean,
	refusalPath = activePath,
): { readonly view: AuthorityExportView; close(): void } {
	if (identity.backend !== "jsonl") throw new TypeError("JSONL driver requires a JSONL identity.");
	const layout = jsonlLayout(path.resolve(activePath));
	try {
		return inspectJsonlStream(layout, identity, directory, disposable);
	} catch (error) {
		if (
			!disposable ||
			!(error instanceof DurableStateUnavailableError) ||
			discardUnacknowledgedSuffix(layout.active, identity, layout, error, refusalPath) === undefined
		)
			throw error;
		return inspectJsonlStream(layout, identity, directory, disposable);
	}
}

/** Buffered, durable sequential writes to one new private file, with a running SHA-256 and byte count. */
class StreamedFileWriter {
	readonly #handle: number;
	readonly #buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
	readonly #hasher = new Bun.CryptoHasher("sha256");
	#used = 0;
	bytes = 0;

	constructor(handle: number) {
		this.#handle = handle;
	}

	write(text: string): void {
		const length = Buffer.byteLength(text);
		if (length > this.#buffer.length - this.#used) this.flush();
		if (length > this.#buffer.length) {
			const bytes = Buffer.from(text);
			this.#writeAll(bytes);
			return;
		}
		this.#used += this.#buffer.write(text, this.#used);
	}

	flush(): void {
		if (this.#used === 0) return;
		this.#writeAll(this.#buffer.subarray(0, this.#used));
		this.#used = 0;
	}

	#writeAll(bytes: Buffer): void {
		this.#hasher.update(bytes);
		for (let written = 0; written < bytes.byteLength;)
			written += fs.writeSync(this.#handle, bytes, written, bytes.byteLength - written);
		this.bytes += bytes.byteLength;
	}

	sha256(): string {
		return this.#hasher.digest("hex");
	}
}

/** Writes `,`-joined JSON.stringify of each item, so the bytes equal JSON.stringify of the whole array. */
function writeJsonArray<T>(writer: StreamedFileWriter, items: Iterable<T>, each: (item: T) => unknown): void {
	writer.write("[");
	let first = true;
	for (const item of items) {
		if (!first) writer.write(",");
		first = false;
		writer.write(JSON.stringify(each(item)));
	}
	writer.write("]");
}

function jsonText(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw new TypeError("Authority JSONL value is not JSON serializable.");
	return text;
}

/**
 * The seeded segment-0 header's hash and byte length, streamed: headerBytes(identity, seed) hashes canonical JSON
 * of { version, kind, identity, seed } where seed is the export with `identity` as its source identity.
 */
function seededHeaderDigest(
	identity: AuthorityIdentity,
	view: AuthorityExportView,
): { readonly hash: string; readonly bytes: number } {
	// Element bytes plus one separator per element after the first of each array.
	let bytes = 0;
	const counted = [0, 0, 0];
	const sized = (array: number, value: unknown): unknown => {
		bytes += Buffer.byteLength(jsonText(value)) + (counted[array]!++ > 0 ? 1 : 0);
		return value;
	};
	const writer = new CanonicalHashWriter()
		.text("{")
		.key("identity")
		.value(identity)
		.text(",")
		.key("kind")
		.value("header")
		.text(",")
		.key("seed")
		.text("{")
		.key("controls")
		.array(view.controls(), control => sized(1, { key: control.key, value: control.value }))
		.text(",")
		.key("frames")
		.array(view.frames(), item => sized(2, item.frame))
		.text(",")
		.key("generationHighWater")
		.value(view.generationHighWater)
		.text(",")
		.key("headHash")
		.value(view.headHash);
	if (view.legacy) writer.text(",").key("legacy").value(view.legacy);
	writer
		.text(",")
		.key("revision")
		.value(view.revision)
		.text(",")
		.key("rows")
		.array(view.rows(), row => sized(0, row))
		.text(",")
		.key("sourceIdentity")
		.value(identity)
		.text(",")
		.key("version")
		.value(2)
		.text("}")
		.text(",")
		.key("version")
		.value(2)
		.text("}");
	const hash = writer.digest();
	const prefix =
		`{"version":2,"kind":"header","identity":${jsonText(identity)},"seed":{"version":2,"sourceIdentity":${jsonText(identity)},` +
		`"revision":${jsonText(view.revision)},"generationHighWater":${jsonText(view.generationHighWater)},"headHash":${jsonText(view.headHash)},"rows":[`;
	const suffix = `],"controls":[],"frames":[]${view.legacy ? `,"legacy":${jsonText(view.legacy)}` : ""}},"hash":${jsonText(hash)}}\n`;
	return { hash, bytes: Buffer.byteLength(prefix) + Buffer.byteLength(suffix) + bytes };
}

/** JSON.stringify of the seeded header headerBytes(identity, seed) builds, streamed. */
function writeSeededHeader(
	writer: StreamedFileWriter,
	identity: AuthorityIdentity,
	view: AuthorityExportView,
	hash: string,
): void {
	writer.write(
		`{"version":2,"kind":"header","identity":${jsonText(identity)},"seed":{"version":2,"sourceIdentity":${jsonText(identity)},` +
			`"revision":${jsonText(view.revision)},"generationHighWater":${jsonText(view.generationHighWater)},"headHash":${jsonText(view.headHash)},"rows":`,
	);
	writeJsonArray(writer, view.rows(), row => row);
	writer.write(`,"controls":`);
	writeJsonArray(writer, view.controls(), control => ({ key: control.key, value: control.value }));
	writer.write(`,"frames":`);
	writeJsonArray(writer, view.frames(), item => item.frame);
	writer.write(`${view.legacy ? `,"legacy":${jsonText(view.legacy)}` : ""}},"hash":${jsonText(hash)}}\n`);
}

/** #publish with streamed content: temporary file, write, fsync, rename, directory fsync. Returns the bytes' length and SHA-256. */
function publishStreamed(layout: JsonlLayout, target: string, write: (writer: StreamedFileWriter) => void): FileRef {
	const temporary = `${target}.tmp-${crypto.randomUUID()}`;
	let handle: number | undefined = fs.openSync(
		temporary,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
		0o600,
	);
	let ref: FileRef;
	try {
		const writer = new StreamedFileWriter(handle);
		write(writer);
		writer.flush();
		durableFsyncSync(handle);
		ref = {
			file: path.basename(target).slice(path.basename(layout.stem).length + 1),
			bytes: writer.bytes,
			sha256: writer.sha256(),
		};
		const closing = handle;
		handle = undefined;
		fs.closeSync(closing);
		fs.renameSync(temporary, target);
	} catch (error) {
		const failures: unknown[] = [error];
		if (handle !== undefined) {
			try {
				fs.closeSync(handle);
			} catch (closeError) {
				failures.push(closeError);
			}
		}
		try {
			fs.unlinkSync(temporary);
		} catch (unlinkError) {
			if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") failures.push(unlinkError);
		}
		throw failures.length === 1
			? error
			: new AggregateError(failures, "Authority JSONL rotation file publication and its cleanup failed.");
	}
	fsyncDirectory(layout.directory);
	return ref;
}

/**
 * Creates a JSONL store from a verified export read in pieces, writing byte for byte what `new
 * JsonlAuthorityPersistence({ create: true, seed })` writes: one seeded file, or (once the seeded header reaches
 * the rotation threshold) the rotated layout of #createRotated: sealed segment 0, its index, snapshot 1 and the
 * active segment-1 header, published in that order. Offline only: never with capacity.
 */
export function createJsonlAuthorityFromStream(options: AuthorityDriverOptions, seed: AuthoritySeedStream): void {
	if (!path.isAbsolute(options.path)) throw new TypeError("Authority JSONL path must be absolute.");
	if (options.identity.backend !== "jsonl") throw new TypeError("JSONL driver requires a JSONL identity.");
	if (!options.create || options.seed || options.capacity)
		throw new TypeError(
			"A streamed JSONL authority seed is valid only when creating a new offline store without another seed.",
		);
	const identity = Object.freeze({ ...options.identity });
	const filePath = path.resolve(options.path);
	const layout = jsonlLayout(filePath);
	const limits = segmentLimits(options);
	const view = seed.view;
	if (seed.owningSessionId !== identity.owningSessionId)
		throw new Error("Authority seed belongs to a different owning session.");
	const { hash, bytes } = seededHeaderDigest(identity, view);
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	if (listJsonlRotationArtifacts(filePath).length > 0)
		throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
	if (bytes >= limits.minBytes || view.revision >= limits.maxFrames) {
		if (fs.existsSync(filePath))
			throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
		createRotatedFromStream(layout, identity, view, hash, bytes);
		return;
	}
	let handle: number;
	try {
		handle = fs.openSync(
			filePath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		if (["EEXIST", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
			throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
		throw error;
	}
	try {
		const writer = new StreamedFileWriter(handle);
		writeSeededHeader(writer, identity, view, hash);
		writer.flush();
		if (writer.bytes !== bytes) throw new Error("Authority JSONL seeded header length changed while it was written.");
		durableFsyncSync(handle);
	} finally {
		fs.closeSync(handle);
	}
	fsyncDirectory(path.dirname(filePath));
}

function createRotatedFromStream(
	layout: JsonlLayout,
	identity: AuthorityIdentity,
	view: AuthorityExportView,
	hash: string,
	bytes: number,
): void {
	const segment0 = publishStreamed(layout, layout.segment(0), writer => {
		writeSeededHeader(writer, identity, view, hash);
		writer.flush();
		if (writer.bytes !== bytes) throw new Error("Authority JSONL seeded header length changed while it was written.");
	});
	let receiptEpoch = 0;
	const indexRef = publishStreamed(layout, layout.index(0), writer => {
		writer.write(
			`{"version":1,"kind":"segment-index","identity":${jsonText(identity)},"segment":0,"segmentBytes":${segment0.bytes},` +
				`"segmentSha256":${jsonText(segment0.sha256)},"firstRevision":${view.revision + 1},"lastRevision":${view.revision},` +
				`"headHash":${jsonText(view.headHash)},"previous":null,"receipts":`,
		);
		writeJsonArray(writer, receiptControls(view.controls()), control => {
			const parts = receiptKeyParts(control.key);
			if (parts?.incarnation === identity.incarnation && parts.epoch > receiptEpoch) receiptEpoch = parts.epoch;
			return { key: control.key, value: control.value };
		});
		writer.write("}\n");
	});
	const snapshotRef = publishStreamed(layout, layout.snapshot(1), writer => {
		writer.write(
			`{"version":1,"kind":"snapshot","identity":${jsonText(identity)},"segment":1,"revision":${jsonText(view.revision)},` +
				`"headHash":${jsonText(view.headHash)},"generationHighWater":${jsonText(view.generationHighWater)},"rows":`,
		);
		writeJsonArray(writer, view.rows(), row => row);
		writer.write(`,"controls":`);
		writeJsonArray(writer, stateControls(view), control => ({ key: control.key, value: control.value }));
		writer.write(`,"sealed":${jsonText({ index: indexRef, receiptEpoch })}}\n`);
	});
	const header = segmentHeaderBytes(identity, 1, {
		revision: view.revision,
		headHash: view.headHash,
		generationHighWater: view.generationHighWater,
		snapshot: snapshotRef,
	});
	const temporary = `${layout.active}.tmp-${crypto.randomUUID()}`;
	try {
		const handle = fs.openSync(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
			0o600,
		);
		try {
			for (let written = 0; written < header.byteLength;)
				written += fs.writeSync(handle, header, written, header.byteLength - written);
			durableFsyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
		try {
			fs.linkSync(temporary, layout.active);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new DurableStateConflictError("Authority JSONL target already exists or is unsafe.");
			throw error;
		}
		fs.unlinkSync(temporary);
		fsyncDirectory(layout.directory);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch (unlinkError) {
			if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
				throw new AggregateError([error, unlinkError], "Authority JSONL rotated create and its cleanup failed.");
		}
		throw error;
	}
}

function* receiptControls(controls: Iterable<AuthorityControl>): Generator<AuthorityControl> {
	for (const control of controls) if (control.key.startsWith("receipt:")) yield control;
}

/** The non-receipt controls loadExport leaves in a seeded store's state: meta completed with the export's position. */
function* stateControls(view: AuthorityExportView): Generator<AuthorityControl> {
	for (const control of view.controls()) {
		if (control.key.startsWith("receipt:")) continue;
		if (control.key !== "meta") {
			yield control;
			continue;
		}
		if (!control.value || typeof control.value !== "object" || Array.isArray(control.value))
			throw new Error("Authority seed metadata is missing.");
		yield {
			key: "meta",
			value: {
				...(control.value as object),
				revision: view.revision,
				generationHighWater: view.generationHighWater,
				headHash: view.headHash,
			},
		};
	}
}
