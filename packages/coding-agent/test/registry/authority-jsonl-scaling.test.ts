import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsNamespace from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import type { AuthorityDriverOptions, AuthorityIdentity } from "../../src/registry/authority/types";

// The JSONL driver must keep each command proportional to the frame it writes and each open proportional to the
// bytes it replays. Bytes read through the fs namespace and entries visited by Map/Set iteration are deterministic
// proxies for that work: a driver that re-reads the journal or copies its whole state per command or per replayed
// frame grows both with history, while a delta-proportional driver does not.

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function operation(index: number, phase: "intent" | "abandoned") {
	return {
		kind: "operation" as const,
		at: 10 + index,
		operationId: `op-${index}`,
		effectClass: "eval" as const,
		ownerId: "actor-1",
		classOwnerId: "root-1",
		actorId: "actor-1",
		rootId: "root-1",
		generation: 1,
		acquiredAt: 10,
		expiresAt: 100,
		phase,
	};
}

interface Work {
	readonly bytesRead: number;
	readonly visited: number;
}

/** Runs `run` while counting bytes read through the fs namespace and entries visited by Map/Set iteration. */
function measureWork(run: () => void): Work {
	let bytesRead = 0;
	let visited = 0;
	const readSync = fsNamespace.readSync;
	const readFileSync = fsNamespace.readFileSync;
	const spies: Array<{ mockRestore(): void }> = [
		spyOn(fsNamespace, "readSync").mockImplementation(((...args: Parameters<typeof readSync>) => {
			const read = readSync(...args);
			bytesRead += read;
			return read;
		}) as typeof readSync),
		spyOn(fsNamespace, "readFileSync").mockImplementation(((...args: Parameters<typeof readFileSync>) => {
			const contents = readFileSync(...args);
			bytesRead += typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
			return contents;
		}) as typeof readFileSync),
	];
	const counted = <T extends object>(prototype: T, name: PropertyKey): void => {
		const original = (prototype as Record<PropertyKey, (this: unknown) => Iterator<unknown>>)[name as string];
		spies.push(
			spyOn(prototype as Record<PropertyKey, () => unknown>, name as string).mockImplementation(
				function (this: unknown) {
					const iterator = original.call(this);
					return {
						next() {
							const result = iterator.next();
							if (!result.done) visited++;
							return result;
						},
						[Symbol.iterator]() {
							return this;
						},
					};
				},
			),
		);
	};
	for (const name of [Symbol.iterator, "entries", "keys", "values"]) counted(Map.prototype, name);
	for (const name of [Symbol.iterator, "entries", "values"]) counted(Set.prototype, name);
	try {
		run();
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	return { bytesRead, visited };
}

async function createHistory(operations: number): Promise<{
	readonly options: AuthorityDriverOptions;
	readonly driver: JsonlAuthorityPersistence;
	readonly engine: AuthorityEngine;
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-jsonl-scaling-"));
	temporaryDirectories.push(directory);
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: path.join(directory, "store.jsonl"), identity, create: true };
	const driver = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	// Every operation leaves a terminal row and two receipts behind, like a long-lived session's history.
	for (let index = 0; index < operations; index++) {
		engine.transition(operation(index, "intent"), { requestId: `history-intent-${index}` });
		engine.transition(operation(index, "abandoned"), { requestId: `history-abandoned-${index}` });
	}
	return { options, driver, engine };
}

const SMALL_HISTORY = 40;
const LARGE_HISTORY = 400;
const MEASURED_COMMANDS = 8;
// Two frame-sized reads (the verified chain head and the appended readback) plus engine bookkeeping fit easily.
const COMMIT_BYTES_BOUND = 16 * 1024;
const COMMIT_VISITS_BOUND = 64;
const OPEN_VISITS_PER_FRAME = 24;
// Building the large history performs about 800 fsynced appends.
const HISTORY_TEST_TIMEOUT_MS = 120_000;

function measureCommands(engine: AuthorityEngine, first: number): Work[] {
	const samples: Work[] = [];
	for (let index = first; index < first + MEASURED_COMMANDS; index++)
		samples.push(
			measureWork(() => {
				engine.transition(operation(index, "intent"), { requestId: `measured-${index}` });
			}),
		);
	return samples;
}

test(
	"JSONL per-commit reads and state visits stay bounded as committed history grows",
	async () => {
		for (const operations of [SMALL_HISTORY, LARGE_HISTORY]) {
			const { options, driver, engine } = await createHistory(operations);
			// The first append after construction verifies the whole journal once; steady-state commits must not.
			engine.transition(operation(operations, "intent"), { requestId: "warm-up" });
			const samples = measureCommands(engine, operations + 1);
			const journalBytes = (await fs.stat(options.path)).size;
			const stateEntries = driver.exportState().rows.length + driver.exportState().controls.length;
			if (operations === LARGE_HISTORY) {
				// Guard the fixture: an O(history) driver would exceed the bounds by a wide margin at this size.
				expect(journalBytes).toBeGreaterThan(COMMIT_BYTES_BOUND * 32);
				expect(stateEntries).toBeGreaterThan(COMMIT_VISITS_BOUND * 16);
			}
			for (const sample of samples) {
				expect(sample.bytesRead).toBeLessThanOrEqual(COMMIT_BYTES_BOUND);
				expect(sample.visited).toBeLessThanOrEqual(COMMIT_VISITS_BOUND);
			}
			driver.integrityCheck();
			engine.close();
		}
	},
	HISTORY_TEST_TIMEOUT_MS,
);

test(
	"JSONL reopen replays the journal in one pass without copying state per frame",
	async () => {
		for (const operations of [SMALL_HISTORY, LARGE_HISTORY]) {
			const { options, engine } = await createHistory(operations);
			engine.close();
			const baseline = new JsonlAuthorityPersistence({ ...options, create: false });
			const committed = baseline.exportState();
			baseline.close();
			const journalBytes = (await fs.stat(options.path)).size;
			let reopened: JsonlAuthorityPersistence | undefined;
			const work = measureWork(() => {
				reopened = new JsonlAuthorityPersistence({ ...options, create: false });
			});
			if (!reopened) throw new Error("Reopen did not construct a driver.");
			expect(reopened.exportState()).toEqual(committed);
			// One pass over the journal, plus at most the one-byte torn-tail probe that runs before any frame is parsed.
			expect(work.bytesRead).toBeGreaterThanOrEqual(journalBytes);
			expect(work.bytesRead).toBeLessThanOrEqual(journalBytes + 1);
			// Linear in replayed frames: frame validation visits a constant number of entries, never a copy of all rows or controls.
			expect(work.visited).toBeLessThanOrEqual(committed.frames.length * OPEN_VISITS_PER_FRAME);
			// After a reopen the first append re-verifies the journal bytes once, then commits read only their delta.
			const reopenedEngine = new AuthorityEngine(reopened, "next-owner");
			const recovery = measureWork(() => {
				reopenedEngine.recover();
			});
			expect(recovery.bytesRead).toBeLessThanOrEqual(journalBytes + COMMIT_BYTES_BOUND);
			for (const sample of measureCommands(reopenedEngine, operations + 1))
				expect(sample.bytesRead).toBeLessThanOrEqual(COMMIT_BYTES_BOUND);
			reopened.integrityCheck();
			reopenedEngine.close();
		}
	},
	HISTORY_TEST_TIMEOUT_MS,
);

test("JSONL discarding a staged frame restores rows, open-row scans and receipt lookups applied in place", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-jsonl-discard-"));
	temporaryDirectories.push(directory);
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const source = new JsonlAuthorityPersistence({ path: path.join(directory, "source.jsonl"), identity, create: true });
	const engine = new AuthorityEngine(source, "owner-token");
	engine.recover();
	engine.transition(operation(1, "intent"), { requestId: "open-intent" });
	// A replica at the same head lets the source's next real frame be staged and discarded on the replica.
	const replica = new JsonlAuthorityPersistence({
		path: path.join(directory, "replica.jsonl"),
		identity,
		create: true,
		seed: source.exportState(),
	});
	engine.transition(operation(1, "abandoned"), { requestId: "terminal-abandon" });
	const frame = source.exportState().frames.at(-1);
	if (!frame) throw new Error("Source has no committed frame to stage.");
	const openPage = () => replica.scan("operation", { openOnly: true, limit: 10 }).rows.map(row => row.record);
	const before = replica.exportState();
	expect(openPage()).toEqual([operation(1, "intent")]);
	expect(() =>
		replica.transaction(() => {
			replica.commit(frame);
			expect(openPage()).toEqual([]);
			expect(replica.findReceipt("terminal-abandon", identity.incarnation)).toEqual(frame.receipt);
			throw new Error("discard staged frame");
		}),
	).toThrow("discard staged frame");
	expect(openPage()).toEqual([operation(1, "intent")]);
	expect(replica.findReceipt("terminal-abandon", identity.incarnation)).toBeUndefined();
	expect(replica.exportState()).toEqual(before);
	replica.transaction(() => replica.commit(frame));
	expect(openPage()).toEqual([]);
	expect(replica.exportState()).toEqual(source.exportState());
	replica.integrityCheck();
	replica.close();
	engine.close();
});

test("JSONL refuses to append after a same-size in-place rewrite of an earlier frame within the same clock tick", async () => {
	const { options, engine } = await createHistory(4);
	const history = fsNamespace.readFileSync(options.path);
	const offset = history.indexOf(Buffer.from('"op-1"')) + 2;
	const replacement = Buffer.from([history[offset] === 0x70 ? 0x71 : 0x70]);
	// Rewrite one byte inside an earlier frame synchronously right after a commit. Storage whose fsync returns
	// within one coarse timestamp tick (tmpfs, fast NVMe) is simulated by skipping the sync, so the foreign write
	// lands in the same tick as the append and keeps the size, mtime and ctime the kernel would otherwise report.
	const handle = fsNamespace.openSync(options.path, "r+");
	const fastSync = spyOn(fsNamespace, "fsyncSync").mockImplementation(() => {});
	try {
		engine.transition(operation(4, "intent"), { requestId: "fence-armed" });
		fsNamespace.writeSync(handle, replacement, 0, 1, offset);
	} finally {
		fastSync.mockRestore();
		fsNamespace.closeSync(handle);
	}
	const before = fsNamespace.statSync(options.path).size;
	expect(() => engine.transition(operation(5, "intent"), { requestId: "after-rewrite" })).toThrow(
		"changed outside its active owner",
	);
	expect(fsNamespace.statSync(options.path).size).toBe(before);
});
