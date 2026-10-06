import { afterEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalDurableSha256,
	DurableStateConflictError,
	RegistryDurableStateStore,
} from "../../src/registry/durable-state";

const temporaryDirectories: string[] = [];
const HISTORY_RECORDS = 60;

async function createStore(): Promise<{ journal: string; store: RegistryDurableStateStore }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-durable-append-cost-"));
	temporaryDirectories.push(directory);
	const journal = path.join(directory, "registry.jsonl");
	return { journal, store: new RegistryDurableStateStore(journal) };
}

function appendGates(store: RegistryDurableStateStore, from: number, count: number): void {
	for (let at = from; at < from + count; at++) {
		store.append({ kind: "gate", at, rootId: "Main", generation: 1, phase: "open" });
	}
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("durable registry journal append cost", () => {
	// Every tool call appends several journal records on the TUI thread. Replaying and
	// re-hashing the whole history per append made each append cost O(journal size).
	it("does not re-parse the journal history when appending to a validated store", async () => {
		const { store } = await createStore();
		appendGates(store, 1, HISTORY_RECORDS);

		const parse = vi.spyOn(JSON, "parse");
		try {
			appendGates(store, HISTORY_RECORDS + 1, 5);
			expect(parse.mock.calls.length).toBeLessThan(HISTORY_RECORDS);
		} finally {
			parse.mockRestore();
		}
		expect(store.head()?.sequence).toBe(HISTORY_RECORDS + 5);
	});

	it("still validates history appended by another store before appending", async () => {
		const { journal, store } = await createStore();
		appendGates(store, 1, HISTORY_RECORDS);
		new RegistryDurableStateStore(journal).append({
			kind: "gate",
			at: HISTORY_RECORDS + 1,
			rootId: "Main",
			generation: 1,
			phase: "quiescing",
		});

		store.append({ kind: "gate", at: HISTORY_RECORDS + 2, rootId: "Main", generation: 1, phase: "open" });

		const restarted = new RegistryDurableStateStore(journal);
		expect(restarted.head()?.sequence).toBe(HISTORY_RECORDS + 2);
		expect(restarted.readBatch(null).records.length).toBe(Math.min(HISTORY_RECORDS + 2, 100));
	});

	it("rejects an in-place same-size mutation of an early record even when file metadata looks unchanged", async () => {
		const { journal, store } = await createStore();
		appendGates(store, 1, HISTORY_RECORDS);
		const original = syncFs.readFileSync(journal, "utf8");
		const mutated = original.replace('"rootId":"Main"', '"rootId":"Evil"');
		expect(Buffer.byteLength(mutated)).toBe(Buffer.byteLength(original));
		const originalOpenSync = syncFs.openSync;
		const originalFstatSync = syncFs.fstatSync;
		const writeSync = vi.spyOn(syncFs, "writeSync");
		let staleStat: syncFs.BigIntStats | undefined;
		const openSync = vi.spyOn(syncFs, "openSync").mockImplementation(((filePath, flags, mode) => {
			if (!staleStat && String(filePath) === journal) {
				staleStat = syncFs.statSync(journal, { bigint: true });
				syncFs.writeFileSync(journal, mutated, { mode: 0o600 });
			}
			return originalOpenSync(filePath, flags, mode);
		}) as typeof syncFs.openSync);
		// Coarse timestamps can leave size, mtime and ctime unchanged after an in-place rewrite;
		// report the pre-mutation metadata so only the byte check can catch the change.
		const fstatSync = vi
			.spyOn(syncFs, "fstatSync")
			.mockImplementation(((fd, options) =>
				staleStat && options?.bigint ? staleStat : originalFstatSync(fd, options)) as typeof syncFs.fstatSync);
		try {
			expect(() =>
				store.append({ kind: "gate", at: HISTORY_RECORDS + 1, rootId: "Main", generation: 1, phase: "open" }),
			).toThrow(DurableStateConflictError);
			expect(staleStat).toBeDefined();
			expect(writeSync).not.toHaveBeenCalled();
			expect(syncFs.readFileSync(journal, "utf8")).toBe(mutated);
		} finally {
			fstatSync.mockRestore();
			writeSync.mockRestore();
			openSync.mockRestore();
		}
	});
});

describe("canonical durable hashing", () => {
	// Journal integrity depends on these exact bytes: existing journals must keep verifying.
	it("keeps the canonical encoding byte-identical for persisted record shapes", () => {
		const samples: unknown[] = [
			{
				kind: "operation",
				at: 1791298817957,
				operationId: "read:call_x|fc_y",
				effectClass: "filesystem",
				ownerId: "session-actor:Main:Main:1",
				nested: { z: [1, "two", { b: null, a: true }], a: 'ü\n"q"' },
				phase: "committed",
			},
			[3, { y: [], x: {} }, "s"],
			"plain",
			42,
			null,
		];
		expect(samples.map(canonicalDurableSha256)).toEqual([
			"69f52a809d7b096b0a8f80e8b4ed7fec573ed9a8246a3b1bdd1f518b4301e3e4",
			"b45d895ba572e207627261a506fb0a733234faa777b16b7c5322a81fa06fe618",
			"945603a8f587786b463c3f94fce115c0fae88fac2728cc96ddf5981cf7f61741",
			"73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049",
			"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
		]);
	});

	it("rejects nested undefined fields, cycles and non-plain objects", () => {
		expect(() => canonicalDurableSha256({ outer: { inner: undefined } })).toThrow(
			"Durable state field 'inner' is undefined.",
		);
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = { back: cyclic };
		expect(() => canonicalDurableSha256(cyclic)).toThrow("Durable state contains a cycle.");
		expect(() => canonicalDurableSha256({ when: new Date(0) })).toThrow(
			"Durable state must contain only plain objects and arrays.",
		);
	});
});
