import { afterEach, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthorityStore, LocalClaim } from "../../src/registry/authority/types";
import type { DurableLocalBackingExpectation, DurableLocalPublishResult } from "../../src/registry/durable-state";
import { durableBackingSha256 } from "../../src/registry/durable-state";
import { DurableLocalState } from "../../src/registry/authority-local";
import { AuthorityRpcClient } from "../../src/registry/authority/client";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";

const GENESIS = "0".repeat(64);

const clients: AuthorityRpcClient[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map(client => client.close()));
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function claim(input: { localId: string; entryId: string; entryHash: string; expectedHeadHash: string }): LocalClaim {
	return {
		localId: input.localId,
		entryId: input.entryId,
		version: 1,
		entryHash: input.entryHash,
		headHash: "1".repeat(64),
		previousHeadHash: input.expectedHeadHash,
		claimToken: "claim-token",
		ownerEpoch: 1,
		incarnation: "incarnation-1",
		phase: "reserved",
	};
}
async function storeHarness(
	options: {
		backing?: DurableLocalBackingExpectation | null;
		authorize?: (value: LocalClaim) => Promise<void>;
		finalize?: (value: LocalClaim, outcome: "committed" | "uncertain") => Promise<DurableLocalPublishResult>;
	} = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-local-test-"));
	directories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	await fs.writeFile(sessionFile, '{"type":"session","id":"session-1"}\n');
	const ownership = await acquireAuthorityOwnership(sessionFile, { owningSessionId: "session-1", create: true });
	const client = await AuthorityRpcClient.open(
		{
			path: ownership.paths.jsonl,
			identity: { backend: "jsonl", owningSessionId: "session-1", incarnation: Bun.randomUUIDv7(), format: 2 },
			create: true,
		},
		ownership,
	);
	clients.push(client);
	const claims: LocalClaim[] = [];
	const finalized: Array<{ claim: LocalClaim; outcome: "committed" | "uncertain" }> = [];
	let activeClaim: LocalClaim | undefined;
	const store = client as AuthorityRpcClient & AuthorityStore;
	store.reserveLocal = async input => {
		if (activeClaim) throw new Error("local publication claim is already active");
		activeClaim = claim(input);
		claims.push(activeClaim);
		return activeClaim;
	};
	store.authorizeLocalEffect = async value => {
		await options.authorize?.(value);
		if (activeClaim?.claimToken !== value.claimToken) throw new Error("local claim is stale");
		return {
			requestId: "authorize-request",
			ownerEpoch: value.ownerEpoch,
			revision: 1,
			payloadHash: "2".repeat(64),
			incarnation: value.incarnation,
			commandKind: "authorize-local-effect",
			committedAt: 1,
			result: { kind: "mutation" },
		};
	};
	store.finalizeLocal = async (value, outcome) => {
		finalized.push({ claim: value, outcome });
		if (options.finalize) return options.finalize(value, outcome);
		if (activeClaim?.claimToken !== value.claimToken) throw new Error("local claim is stale");
		if (outcome === "committed") activeClaim = undefined;
		return { version: value.version, headHash: value.headHash };
	};
	store.localBacking = async () => options.backing ?? null;
	store.quarantine = async reason => {
		throw new Error(reason);
	};
	return {
		store,
		claims,
		finalized,
		get activeClaim() {
			return activeClaim;
		},
	};
}
async function realStoreHarness(backend: "jsonl" | "sqlite") {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-local-real-test-"));
	directories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	await fs.writeFile(sessionFile, '{"type":"session","id":"session-1"}\n');
	const ownership = await acquireAuthorityOwnership(sessionFile, { owningSessionId: "session-1", create: true });
	const client = await AuthorityRpcClient.open(
		{
			path: backend === "jsonl" ? ownership.paths.jsonl : ownership.paths.sqlite,
			identity: { backend, owningSessionId: "session-1", incarnation: Bun.randomUUIDv7(), format: 2 },
			create: true,
		},
		ownership,
	);
	clients.push(client);
	return { directory, store: client as AuthorityRpcClient & AuthorityStore };
}

describe("DurableLocalState real-store publication", () => {
	for (const backend of ["jsonl", "sqlite"] as const) {
		it(`commits actual local publication and returns callback value with ${backend}`, async () => {
			const { directory, store } = await realStoreHarness(backend);
			const state = new DurableLocalState(store, "session-1");
			const entryId = `entry-${backend}`;
			const bytes = Buffer.from(`published bytes through ${backend}`);
			const entryHash = durableBackingSha256(bytes);
			const target = path.join(directory, "published.bin");

			const result = await state.publishWithEffect(entryId, entryHash, GENESIS, async () => {
				await fs.writeFile(target, bytes);
				return { written: bytes.length, backend };
			});

			expect(result).toEqual({ written: bytes.length, backend });
			expect(await fs.readFile(target)).toEqual(bytes);
			const backing = await store.localBacking("session-1");
			const head = await store.getLocalHead("session-1");
			const entry = await store.getLocalEntry("session-1", entryId, 1);
			expect(backing).toMatchObject({ version: 1, entryId, entryHash });
			expect(entry).toMatchObject({
				record: {
					kind: "local-entry",
					localId: "session-1",
					entryId,
					version: 1,
					expectedHeadHash: GENESIS,
					entryHash,
					phase: "committed",
				},
			});
			expect(entry?.record.headHash).toBe(backing?.headHash);
			expect(head).toMatchObject({
				record: {
					kind: "local-head",
					localId: "session-1",
					version: 1,
					previousHeadHash: GENESIS,
					phase: "current",
				},
			});
			expect(head?.record.headHash).toBe(backing?.headHash);
			const current = await state.current();
			if (!head) throw new Error("Successful publication must have a committed local head.");
			if (!current) throw new Error("Successful publication must expose its current state.");
			expect(current).toEqual({ version: head.record.version, headHash: head.record.headHash });
		});

		it(`retains first-publication uncertainty without a head or callback replay on ${backend}`, async () => {
			const { directory, store } = await realStoreHarness(backend);
			const state = new DurableLocalState(store, "session-1");
			const target = path.join(directory, "partial.bin");
			const failure = new Error(`interrupted ${backend} backing write`);
			let callbackCount = 0;

			// Await the real authority response before asserting; Bun 1.4.4 promise matchers starve Worker replies.
			await assert.rejects(
				state.publishWithEffect("uncertain-entry", "c".repeat(64), GENESIS, async () => {
					callbackCount++;
					await fs.writeFile(target, "partial bytes");
					throw failure;
				}),
				error => error === failure,
			);
			expect(callbackCount).toBe(1);
			expect(await fs.readFile(target, "utf8")).toBe("partial bytes");
			expect(await state.current()).toBeNull();
			expect(await store.getLocalHead("session-1")).toBeUndefined();
			expect(await store.localBacking("session-1")).toBeNull();

			await assert.rejects(
				state.publishWithEffect("retry-entry", "d".repeat(64), GENESIS, async () => {
					callbackCount++;
				}),
				/claim|active|unresolved/i,
			);
			expect(callbackCount).toBe(1);
		});
	}
});
describe("DurableLocalState async publication", () => {
	it("binds local state identity to the owning root session", async () => {
		const harness = await storeHarness();
		expect(() => new DurableLocalState(harness.store, "child-session")).toThrow(/owning root session/i);
	});
	it("waits for effect authorization before invoking the backing write", async () => {
		const authorization = Promise.withResolvers<void>();
		const harness = await storeHarness({ authorize: () => authorization.promise });
		const state = new DurableLocalState(harness.store, "session-1");
		let callbackStarted = false;
		const publishing = state.publishWithEffect("entry-1", "a".repeat(64), GENESIS, async () => {
			callbackStarted = true;
			return "backing-written";
		});

		await Promise.resolve();
		expect(harness.claims).toHaveLength(1);
		expect(callbackStarted).toBe(false);
		authorization.resolve();
		await expect(publishing).resolves.toBe("backing-written");
		expect(callbackStarted).toBe(true);
		expect(harness.finalized[0]?.claim).toMatchObject({ version: 1, headHash: "1".repeat(64) });
		expect(harness.finalized[0]?.claim).toEqual({ ...harness.claims[0], phase: "effect" });
		expect(harness.finalized.map(item => item.outcome)).toEqual(["committed"]);
	});
	it("admits only one overlapping publication while its durable authorization is pending", async () => {
		const authorization = Promise.withResolvers<void>();
		const authorizationStarted = Promise.withResolvers<void>();
		const harness = await storeHarness({
			authorize: async () => {
				authorizationStarted.resolve();
				await authorization.promise;
			},
		});
		const state = new DurableLocalState(harness.store, "session-1");
		let writes = 0;
		const first = state.publishWithEffect("entry-1", "a".repeat(64), GENESIS, async () => {
			writes++;
		});
		await authorizationStarted.promise;

		await expect(
			state.publishWithEffect("entry-2", "b".repeat(64), GENESIS, async () => {
				writes++;
			}),
		).rejects.toThrow(/active/i);
		expect(writes).toBe(0);
		authorization.resolve();
		await first;
		expect(writes).toBe(1);
		expect(harness.claims).toHaveLength(1);
	});

	it("keeps the unique claim uncertain when a first write partially changes bytes then rejects", async () => {
		const harness = await storeHarness();
		const state = new DurableLocalState(harness.store, "session-1");
		let backing = "";

		await expect(
			state.publishWithEffect("entry-1", "a".repeat(64), GENESIS, async () => {
				backing = "partial bytes";
				throw new Error("write interrupted");
			}),
		).rejects.toThrow("write interrupted");
		expect(backing).toBe("partial bytes");
		expect(harness.finalized.map(item => item.outcome)).toEqual(["uncertain"]);
		expect(harness.finalized[0]?.claim).toEqual({ ...harness.claims[0], phase: "effect" });
		expect(harness.activeClaim).toBeDefined();
	});

	it("does not report success or repeat the callback after a late finalizer rejection", async () => {
		const harness = await storeHarness({
			finalize: async () => {
				throw new Error("unknown finalization outcome");
			},
		});
		const state = new DurableLocalState(harness.store, "session-1");
		let writes = 0;

		await expect(
			state.publishWithEffect("entry-1", "a".repeat(64), GENESIS, async () => {
				writes++;
			}),
		).rejects.toThrow("unknown finalization outcome");
		expect(writes).toBe(1);
		expect(harness.finalized).toHaveLength(1);
		expect(harness.activeClaim).toBeDefined();
	});

	it("refuses publication when actual backing bytes disagree with the committed head", async () => {
		const expectation: DurableLocalBackingExpectation = {
			version: 4,
			headHash: "4".repeat(64),
			entryId: "previous-entry",
			entryHash: "5".repeat(64),
		};
		const harness = await storeHarness({ backing: expectation });
		const state = new DurableLocalState(harness.store, "session-1");
		let writes = 0;

		await expect(
			state.publishWithEffect(
				"entry-1",
				"a".repeat(64),
				expectation.headHash,
				async () => {
					writes++;
				},
				async () => false,
			),
		).rejects.toThrow(/backing/i);
		expect(writes).toBe(0);
		expect(harness.claims).toHaveLength(1);
		expect(harness.finalized).toHaveLength(0);
		expect(harness.activeClaim).toBeDefined();
	});
});
