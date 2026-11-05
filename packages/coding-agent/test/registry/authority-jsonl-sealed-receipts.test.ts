import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsNamespace from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DurableStateUnavailableError } from "../../src/registry/durable-state";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { jsonlLayout } from "../../src/registry/authority/jsonl-layout";
import type { AuthorityDriverOptions, AuthorityIdentity, MutationReceipt } from "../../src/registry/authority/types";

// A lookup by request id alone (no owner epoch) may need sealed history. Sealed segment indexes are immutable, so
// each is read and digest-verified once per driver; later lookups must not re-read, re-hash or re-parse them.

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
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

/** Bytes read through the fs namespace while `run` executes, and how many of the reads were whole-file reads. */
function readsBy(run: () => void): { readonly bytes: number; readonly wholeFiles: number } {
	let bytes = 0;
	let wholeFiles = 0;
	const readSync = fsNamespace.readSync;
	const readFileSync = fsNamespace.readFileSync;
	const spies = [
		spyOn(fsNamespace, "readSync").mockImplementation(((...args: Parameters<typeof readSync>) => {
			const read = readSync(...args);
			bytes += read;
			return read;
		}) as typeof readSync),
		spyOn(fsNamespace, "readFileSync").mockImplementation(((...args: Parameters<typeof readFileSync>) => {
			const contents = readFileSync(...args);
			wholeFiles++;
			bytes += typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
			return contents;
		}) as typeof readFileSync),
	];
	try {
		run();
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	return { bytes, wholeFiles };
}

function sealedIndexBytes(active: string): number {
	const layout = jsonlLayout(active);
	let total = 0;
	for (let segment = 0; fsNamespace.existsSync(layout.index(segment)); segment++)
		total += fsNamespace.statSync(layout.index(segment)).size;
	return total;
}

// One receipt control read back by slice is a few hundred bytes; a sealed index of this fixture is tens of KiB.
const SLICE_BYTES_BOUND = 2 * 1024;
const REQUESTS = 120;
const FRAMES_PER_SEGMENT = 16;

/** A store whose receipts were all written by a first owner and sealed across several segments, reopened by a second owner. */
async function sealedHistory(): Promise<{
	readonly options: AuthorityDriverOptions;
	readonly receipts: MutationReceipt[];
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-jsonl-sealed-receipts-"));
	directories.push(directory);
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = {
		path: path.join(directory, "store.jsonl"),
		identity,
		create: true,
		jsonlSegment: { minBytes: Number.MAX_SAFE_INTEGER, maxFrames: FRAMES_PER_SEGMENT },
	};
	const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "first-owner");
	engine.recover();
	const receipts: MutationReceipt[] = [];
	for (let index = 0; index < REQUESTS; index++)
		receipts.push(
			engine.transition(operation(index >> 1, index % 2 === 0 ? "intent" : "abandoned"), {
				requestId: `request-${index}`,
			}),
		);
	engine.close();
	return { options: { ...options, create: false }, receipts };
}

describe("JSONL epoch-less receipt lookup over sealed history", () => {
	test("reads each sealed index once; later lookups read at most one receipt slice and no whole file", async () => {
		const { options, receipts } = await sealedHistory();
		const driver = new JsonlAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "second-owner");
		const sealed = sealedIndexBytes(options.path);
		// Guard the fixture: several sealed segments, each index far larger than one slice.
		expect(fsNamespace.existsSync(jsonlLayout(options.path).index(3))).toBe(true);
		expect(sealed).toBeGreaterThan(SLICE_BYTES_BOUND * 16);
		const first = readsBy(() => {
			expect(engine.resolveReceipt(receipts[0]!.requestId)).toEqual(receipts[0]!);
		});
		expect(first.bytes).toBeGreaterThanOrEqual(sealed);
		for (const receipt of receipts) {
			const lookup = readsBy(() => {
				expect(engine.resolveReceipt(receipt.requestId)).toEqual(receipt);
			});
			expect(lookup.wholeFiles).toBe(0);
			expect(lookup.bytes).toBeLessThanOrEqual(SLICE_BYTES_BOUND);
			// With an owner epoch at or below the floor the key names one sealed receipt: also one slice at most.
			const keyed = readsBy(() => {
				expect(
					engine.resolveReceipt(receipt.requestId, receipt.ownerEpoch, receipt.incarnation, receipt.payloadHash),
				).toEqual(receipt);
			});
			expect(keyed.wholeFiles).toBe(0);
			expect(keyed.bytes).toBeLessThanOrEqual(SLICE_BYTES_BOUND);
		}
		const missing = readsBy(() => {
			expect(engine.resolveReceipt("never-sent")).toBeUndefined();
			expect(engine.resolveReceipt("never-sent", 1)).toBeUndefined();
			expect(driver.findReceipt(receipts[0]!.requestId, crypto.randomUUID())).toBeUndefined();
			expect(
				driver.findReceipt(receipts[0]!.requestId, options.identity.incarnation, "0".repeat(64)),
			).toBeUndefined();
		});
		expect(missing.bytes).toBeLessThanOrEqual(SLICE_BYTES_BOUND * 2);
		driver.integrityCheck();
		engine.close();
	}, 60_000);

	test("a rotation adds the newly sealed receipts without re-reading sealed indexes", async () => {
		const { options, receipts } = await sealedHistory();
		const driver = new JsonlAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "second-owner");
		engine.recover();
		// The last first-owner receipts are still in the active segment; warm the sealed lookup before they are sealed.
		const active = fsNamespace.readFileSync(options.path, "utf8");
		const unsealed = receipts.filter(receipt => active.includes(`"requestId":"${receipt.requestId}"`));
		expect(unsealed.length).toBeGreaterThan(0);
		expect(engine.resolveReceipt(receipts[0]!.requestId)).toEqual(receipts[0]!);
		const before = sealedIndexBytes(options.path);
		const next: MutationReceipt[] = [];
		for (let index = 0; index < FRAMES_PER_SEGMENT * 2; index++)
			next.push(engine.transition(operation(REQUESTS + index, "intent"), { requestId: `next-${index}` }));
		expect(sealedIndexBytes(options.path)).toBeGreaterThan(before);
		for (const receipt of [...unsealed, ...receipts.slice(0, 8), ...next]) {
			const lookup = readsBy(() => {
				expect(engine.resolveReceipt(receipt.requestId)).toEqual(receipt);
			});
			expect(lookup.wholeFiles).toBe(0);
			expect(lookup.bytes).toBeLessThanOrEqual(SLICE_BYTES_BOUND);
		}
		driver.integrityCheck();
		engine.close();
		// A reopen builds the lookup again from disk and resolves every receipt of both owners.
		const reopened = new JsonlAuthorityPersistence(options);
		const third = new AuthorityEngine(reopened, "third-owner");
		for (const receipt of [...receipts, ...next]) {
			expect(third.resolveReceipt(receipt.requestId)).toEqual(receipt);
			expect(third.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
		}
		const exported = reopened.exportState().controls.filter(control => control.key.startsWith("receipt:"));
		expect(exported.length).toBeGreaterThan(receipts.length + next.length);
		expect(reopened.scanControl("receipt:", undefined, 1000).controls).toEqual(exported);
		reopened.integrityCheck();
		third.close();
	}, 60_000);

	test("a sealed index whose digest does not match makes the store unavailable on first use", async () => {
		const { options, receipts } = await sealedHistory();
		const index = jsonlLayout(options.path).index(1);
		const bytes = fsNamespace.readFileSync(index);
		const at = bytes.indexOf('"payloadHash":"') + '"payloadHash":"'.length;
		bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
		fsNamespace.writeFileSync(index, bytes);
		const driver = new JsonlAuthorityPersistence(options);
		expect(() => driver.findReceipt(receipts[0]!.requestId, options.identity.incarnation)).toThrow(
			DurableStateUnavailableError,
		);
		expect(() => driver.findReceipt("never-sent", options.identity.incarnation)).toThrow(
			DurableStateUnavailableError,
		);
		driver.close();
	}, 60_000);

	test("a sealed receipt changed on disk after its index was verified makes the store unavailable", async () => {
		const { options, receipts } = await sealedHistory();
		const driver = new JsonlAuthorityPersistence(options);
		expect(driver.findReceipt(receipts[0]!.requestId, options.identity.incarnation)).toEqual(receipts[0]!);
		const index = jsonlLayout(options.path).index(1);
		const bytes = fsNamespace.readFileSync(index);
		const target = receipts.find(receipt => bytes.includes(`"payloadHash":"${receipt.payloadHash}"`))!;
		const at = bytes.indexOf(`"payloadHash":"${target.payloadHash}"`) + '"payloadHash":"'.length;
		bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
		fsNamespace.writeFileSync(index, bytes);
		expect(() => driver.findReceipt(target.requestId, options.identity.incarnation)).toThrow(
			DurableStateUnavailableError,
		);
		expect(() => driver.findReceipt(receipts[0]!.requestId, options.identity.incarnation)).toThrow(
			DurableStateUnavailableError,
		);
		driver.close();
	}, 60_000);
});
