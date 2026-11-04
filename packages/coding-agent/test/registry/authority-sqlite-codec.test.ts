import { describe, expect, it } from "bun:test";
import * as zlib from "node:zlib";
import {
	authorityFrameBodyBound,
	cesu8Decode,
	cesu8Encode,
	cesu8PrefixUpperBound,
	decodeAuthorityFrameBody,
	encodeAuthorityFrameBody,
	sqliteAuthorityFrameColumns,
	sqliteAuthorityFrameColumnsFromRow,
	sqliteAuthorityFrameRow,
} from "../../src/registry/authority/sqlite-codec";
import { SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES } from "../../src/registry/authority/sqlite-schema";
import type { AuthorityCommitFrame, MutationReceipt } from "../../src/registry/authority/types";

const receipt = {
	requestId: "\ud800-request",
	ownerEpoch: 10,
	revision: 7,
	payloadHash: "a".repeat(64),
	incarnation: "incarnation-\udfff",
	commandKind: "transition-batch",
	committedAt: 7,
	result: { kind: "mutation" },
} as MutationReceipt;
const receiptKey = `receipt:${JSON.stringify([receipt.incarnation, receipt.ownerEpoch, receipt.requestId])}`;

function operation(operationId: string, phase: string) {
	return {
		kind: "operation",
		at: 5,
		operationId,
		effectClass: "eval",
		ownerId: "owner-é",
		classOwnerId: "owner-é:eval",
		acquiredAt: 1,
		expiresAt: 9,
		phase,
	};
}
const actor = {
	kind: "actor",
	at: 5,
	actorId: "actor-\u{1F600}",
	rootId: "root",
	generation: 2,
	rootGeneration: 1,
	rootHeadHash: "e".repeat(64),
	startupHash: "f".repeat(64),
	provenanceHash: "1".repeat(64),
	state: "parked",
};
const records = Array.from({ length: 12 }, (_, index) => operation(`op-${index}`, "intent"));
// A computed change (not a command record) and a caller-supplied expectation stay inline.
const computed = {
	kind: "operation",
	at: 6,
	operationId: "computed",
	effectClass: "eval",
	ownerId: "owner-é",
	classOwnerId: "owner-é:eval",
	acquiredAt: 1,
	expiresAt: 9,
	phase: "abandoned",
};

const frame = {
	version: 2,
	kind: "commit",
	revision: 7,
	request: { requestId: receipt.requestId, incarnation: receipt.incarnation, ownerEpoch: 10, ownerToken: "token" },
	command: { kind: "transition-batch", records: [...records, actor] },
	payloadHash: receipt.payloadHash,
	expected: [
		{ domain: "actor", key: ["caller-supplied"], version: 3 },
		...records.map(record => ({
			domain: "operation",
			key: [record.ownerId, record.effectClass, record.operationId],
			version: null,
		})),
		{ domain: "actor", key: [actor.actorId], version: 4 },
		{ domain: "operation", key: [computed.ownerId, computed.effectClass, computed.operationId], version: 1 },
	],
	changes: [
		...records.map(record => ({ record, version: 1 })),
		{ version: 5, record: actor },
		{ record: computed, version: 2 },
	],
	controls: [
		{ key: "meta", deleted: false, value: { revision: 7, generationHighWater: 2, status: "ready" } },
		{
			key: "literal",
			deleted: false,
			value: { record: 0, marker: { $authorityRef: "request", id: 1 }, nested: ["\ud800", "é"] },
		},
		{
			key: `actor-generation:${JSON.stringify([actor.actorId, actor.generation])}`,
			deleted: false,
			value: { row: { record: actor, version: 5 }, parentGeneration: 1 },
		},
		{ key: "gone", deleted: true },
		{ key: receiptKey, deleted: false, value: receipt },
	],
	receipt,
	previousHash: "b".repeat(64),
	committedAt: 7,
	contentHash: "c".repeat(64),
	hash: "d".repeat(64),
} as unknown as AuthorityCommitFrame;

function withHeader(declaredLength: number, encoding: number, payload: Uint8Array): Uint8Array {
	const body = Buffer.alloc(6 + payload.byteLength);
	body[0] = 4;
	body[1] = encoding;
	body.writeUInt32BE(declaredLength, 2);
	body.set(payload, 6);
	return body;
}

describe("SQLite authority frame codec v4", () => {
	it("round-trips frames exactly through references, placeholders and zstd", () => {
		const columns = sqliteAuthorityFrameColumns(frame);
		const body = encodeAuthorityFrameBody(frame, columns);
		const decoded = decodeAuthorityFrameBody(
			body,
			sqliteAuthorityFrameColumnsFromRow(sqliteAuthorityFrameRow(columns)),
		);
		// Exact JSON text equality: values, key order and wrapper order all survive.
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(frame));
		expect(body[0]).toBe(4);
		expect(body[1]).toBe(1);
		const raw = zlib.zstdDecompressSync(Buffer.from(body).subarray(6)).toString("utf8");
		const envelope = JSON.parse(raw) as { f: Record<string, unknown>; r: unknown[] };
		// Every command-equal change, derived expectation and generation-control record became a reference.
		expect(envelope.r).toHaveLength(records.length * 2 + 4);
		expect(raw).toContain("caller-supplied");
		expect(raw).toContain('"computed"');
		// Request identity and hashes live only in the row columns.
		expect(raw).not.toContain("d".repeat(64));
		expect(raw).not.toContain("incarnation-");
		expect(body.byteLength).toBeLessThan(authorityFrameBodyBound(frame, columns));
	});

	it("keeps an imported receipt-control slot whose key order differs from the current control", () => {
		const reordered = Object.fromEntries(Object.entries(receipt).reverse());
		const ordered = {
			...frame,
			controls: frame.controls.map(control =>
				control.key === receiptKey ? { ...control, value: reordered } : control,
			),
		} as AuthorityCommitFrame;
		const columns = sqliteAuthorityFrameColumns(ordered, receipt);
		const decoded = decodeAuthorityFrameBody(encodeAuthorityFrameBody(ordered, columns), columns);
		const slot = decoded.controls.find(control => control.key === receiptKey);
		if (!slot || slot.deleted) throw new Error("Decoded frame lacks its receipt-control slot.");
		expect(Object.keys(slot.value as object)).toEqual(Object.keys(reordered));
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(ordered));
		const row = sqliteAuthorityFrameRow(columns);
		expect(row.receipt).not.toContain("incarnation-");
		expect(JSON.parse(sqliteAuthorityFrameColumnsFromRow(row).receipt)).toEqual(receipt);
	});

	it("rejects corrupt zstd payloads with a clear integrity error", () => {
		const columns = sqliteAuthorityFrameColumns(frame);
		const body = Buffer.from(encodeAuthorityFrameBody(frame, columns));
		body[Math.floor(body.length / 2)]! ^= 0xff;
		expect(() => decodeAuthorityFrameBody(body, columns)).toThrow(/frame body at revision 7 is corrupt/);
	});

	it("refuses an oversized declared body before decompressing it", () => {
		const columns = sqliteAuthorityFrameColumns(frame);
		const bomb = zlib.zstdCompressSync(Buffer.alloc(SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES + 1, 0x20));
		expect(() =>
			decodeAuthorityFrameBody(withHeader(SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES + 1, 1, bomb), columns),
		).toThrow(/above the \d+-byte frame cap/);
	});

	it("stops decompression at the declared length of a body that expands further", () => {
		const columns = sqliteAuthorityFrameColumns(frame);
		const bomb = zlib.zstdCompressSync(Buffer.alloc(32 * 1024 * 1024, 0x20));
		expect(() => decodeAuthorityFrameBody(withHeader(1_024, 1, bomb), columns)).toThrow(
			/exceeded its declared length/,
		);
	});

	it("rejects truncated raw bodies, unknown codecs and malformed references", () => {
		const columns = sqliteAuthorityFrameColumns(frame);
		const raw = Buffer.from(JSON.stringify({ f: {}, r: [] }));
		expect(() => decodeAuthorityFrameBody(withHeader(raw.byteLength + 3, 0, raw), columns)).toThrow(
			/instead of its declared/,
		);
		expect(() =>
			decodeAuthorityFrameBody(
				Buffer.concat([Buffer.from([3]), Buffer.from(encodeAuthorityFrameBody(frame, columns)).subarray(1)]),
				columns,
			),
		).toThrow(/codec version 3/);
		const envelope = JSON.parse(
			zlib.zstdDecompressSync(Buffer.from(encodeAuthorityFrameBody(frame, columns)).subarray(6)).toString("utf8"),
		) as { f: unknown; r: unknown[][] };
		const selfReference = Buffer.from(
			JSON.stringify({ ...envelope, r: [[envelope.r[0]![0], envelope.r[0]![0]], ...envelope.r.slice(1)] }),
		);
		expect(() => decodeAuthorityFrameBody(withHeader(selfReference.byteLength, 0, selfReference), columns)).toThrow(
			/unresolved value/,
		);
		const overlapping = Buffer.from(JSON.stringify({ ...envelope, r: [...envelope.r, envelope.r[0]] }));
		expect(() => decodeAuthorityFrameBody(withHeader(overlapping.byteLength, 0, overlapping), columns)).toThrow(
			/overlapping reference targets/,
		);
	});
});

describe("SQLite authority CESU-8 order keys", () => {
	const keys = ["", "a", "a\u0000", "é", "߿", "ࠀ", "퟿", "\ud800", "😀", "\udfff", "", "￿", "z𐀀", "z￿"];

	it("orders encoded keys bytewise exactly as JavaScript orders the strings", () => {
		const byText = [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
		const byBytes = [...keys].sort((left, right) => Buffer.compare(cesu8Encode(left), cesu8Encode(right)));
		expect(byBytes).toEqual(byText);
		for (const key of keys) expect(cesu8Decode(cesu8Encode(key))).toBe(key);
	});

	it("bounds every key with a prefix below the prefix upper bound", () => {
		for (const prefix of ["local-claim:", "\ud83d", "é"]) {
			const upper = cesu8PrefixUpperBound(prefix)!;
			for (const key of keys.map(key => prefix + key))
				expect(Buffer.compare(cesu8Encode(key), upper)).toBeLessThan(0);
			expect(
				Buffer.compare(
					cesu8Encode(`${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`),
					upper,
				),
			).toBeGreaterThanOrEqual(0);
		}
	});

	it("rejects byte strings the encoder cannot produce", () => {
		for (const bytes of [[0xc1, 0xa3], [0xe0, 0x81, 0xa3], [0xf0, 0x9f, 0x98, 0x80], [0xff], [0xe2, 0x82]])
			expect(() => cesu8Decode(Uint8Array.from(bytes))).toThrow(/order key/);
	});
});
