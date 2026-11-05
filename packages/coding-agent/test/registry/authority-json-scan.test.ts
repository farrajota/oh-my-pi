import { afterEach, describe, expect, it } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { jsonArrayElements, jsonObjectMembers, readJsonValue } from "../../src/registry/authority/json-scan";
import { AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES } from "../../src/registry/authority/jsonl-layout";
import { packAuthorityBundle } from "../../src/registry/authority/lifecycle";
import { migrateAuthority, repairSelectedAuthority } from "../../src/registry/authority/migration";
import {
	canonicalDurableSha256,
	registryDurableJournalPath,
	RegistryDurableStateStore,
} from "../../src/registry/durable-state";

/**
 * json-scan buffers one member or element of a large single-line document at a time. Every element a reader captures
 * is one frame's worth of data or one legacy-v1 journal record (the seed's `legacy.entries` is read entry by entry),
 * so an element longer than the frame-line cap is hostile or corrupt and is refused before it is buffered whole.
 */

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function documentFile(text: string | Buffer): Promise<{ fd: number; length: number; close(): void }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-json-scan-"));
	directories.push(directory);
	const file = path.join(directory, "document.json");
	await fs.writeFile(file, text);
	const fd = syncFs.openSync(file, "r");
	return { fd, length: (await fs.stat(file)).size, close: () => syncFs.closeSync(fd) };
}

describe("authority json-scan element cap", () => {
	it("reads an element of exactly the frame-line cap", async () => {
		const atCap = Buffer.alloc(AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES, 0x61);
		atCap[0] = 0x22;
		atCap[atCap.length - 1] = 0x22;
		const document = await documentFile(Buffer.concat([Buffer.from('{"rows":['), atCap, Buffer.from(",2]}")]));
		try {
			const members = jsonObjectMembers(document.fd, { start: 0, end: document.length });
			const elements = [...jsonArrayElements(document.fd, members.get("rows")!)];
			expect(elements).toHaveLength(2);
			expect((elements[0] as string).length).toBe(AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES - 2);
			expect(elements[1]).toBe(2);
		} finally {
			document.close();
		}
	});

	it("refuses an element longer than the frame-line cap with a clear error", async () => {
		const oversized = Buffer.alloc(AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES + 2, 0x61);
		oversized[0] = 0x22;
		oversized[oversized.length - 1] = 0x22;
		const document = await documentFile(Buffer.concat([Buffer.from('{"rows":[1,'), oversized, Buffer.from("]}")]));
		try {
			const members = jsonObjectMembers(document.fd, { start: 0, end: document.length });
			const elements = jsonArrayElements(document.fd, members.get("rows")!);
			expect(elements.next().value).toBe(1);
			expect(() => elements.next()).toThrow(
				`longer than the ${AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES}-byte frame-line cap`,
			);
			expect(() => readJsonValue(document.fd, { start: 11, end: 11 + oversized.length })).toThrow("frame-line cap");
		} finally {
			document.close();
		}
	});
});

describe("a seed whose legacy member is larger than the frame-line cap", () => {
	// Legacy ids may be up to 512 UTF-16 units; three-byte characters make each record large, so fewer records
	// (and less replay time) are needed to push the whole legacy journal past the cap.
	const ROOT = "\u20ac".repeat(512);
	const OWNER = "019ed676-02fb-7000-8dac-396e2f84d484";

	async function largeLegacyRoot(): Promise<string> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-large-legacy-"));
		directories.push(directory);
		const sessionFile = path.join(directory, "root.jsonl");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({ type: "session", id: OWNER, timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
		);
		const generation = 1;
		const startupHash = canonicalDurableSha256(`${ROOT}:startup`);
		const provenanceHash = canonicalDurableSha256(`${ROOT}:provenance`);
		const headHash = canonicalDurableSha256({ rootId: ROOT, generation, actorId: ROOT, startupHash, provenanceHash });
		const construction = {
			kind: "construction" as const,
			actorId: ROOT,
			rootId: ROOT,
			generation,
			startupHash,
			provenanceHash,
		};
		const journal = registryDurableJournalPath(sessionFile);
		const store = new RegistryDurableStateStore(journal);
		store.append({ ...construction, at: 1, phase: "reserved" });
		store.append({ ...construction, at: 2, phase: "constructing" });
		store.append({ ...construction, at: 3, phase: "constructed" });
		store.append({ kind: "root", at: 4, rootId: ROOT, generation, headHash, state: "active" });
		store.append({
			kind: "actor",
			at: 5,
			actorId: ROOT,
			rootId: ROOT,
			generation,
			rootGeneration: generation,
			rootHeadHash: headHash,
			startupHash,
			provenanceHash,
			state: "active",
		});
		store.append({ ...construction, at: 6, phase: "activated" });
		// Extend the hash chain directly: appending one record at a time through the store re-reads the journal each time.
		const lines = (await fs.readFile(journal, "utf8")).trimEnd().split("\n");
		let previousHash = (JSON.parse(lines.at(-1)!) as { hash: string }).hash;
		let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
		for (let at = 7; bytes <= AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES + 4 * 1024 * 1024; at++) {
			const record = { kind: "root", at, rootId: ROOT, generation, headHash, state: "active" };
			const base = {
				version: 1,
				sequence: lines.length + 1,
				previousHash,
				contentHash: canonicalDurableSha256(record),
				record,
			};
			const hash = canonicalDurableSha256(base);
			const line = JSON.stringify({ ...base, hash });
			lines.push(line);
			bytes += Buffer.byteLength(line) + 1;
			previousHash = hash;
		}
		await fs.writeFile(journal, `${lines.join("\n")}\n`, { mode: 0o600 });
		return sessionFile;
	}

	it("converts it, and repair, migration dry-run and pack read the seeded store", async () => {
		const sessionFile = await largeLegacyRoot();
		const legacyBytes = (await fs.stat(registryDurableJournalPath(sessionFile))).size;
		// The seed embeds every legacy record, so its legacy member is at least as long as the journal.
		expect(legacyBytes).toBeGreaterThan(AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES);
		expect((await migrateAuthority(sessionFile, "jsonl", { apply: true })).status).toBe("migrated");
		expect((await repairSelectedAuthority(sessionFile)).status).toBe("clean");
		expect((await migrateAuthority(sessionFile, "sqlite")).status).toBe("dry-run");
		const bundle = await packAuthorityBundle(sessionFile);
		expect(bundle?.entries.length).toBeGreaterThan(0);
	}, 240_000);
});
