import { afterEach, describe, expect, it } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthorityRpcClient, AuthorityRpcError } from "../../src/registry/authority/client";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { jsonlLayout, listJsonlRotationArtifacts } from "../../src/registry/authority/jsonl-layout";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import type { AuthorityOwnership } from "../../src/registry/authority/ownership";
import type { AuthorityDriverOptions, AuthorityIdentity, MutationReceipt } from "../../src/registry/authority/types";

// An open whose worker outlives the open deadline (a long replay or rotation of a large store) must not leave that
// worker running with the store and its ownership: the client terminates it, confirms the exact thread exit, and
// only then releases ownership. The open is an unknown outcome, and the store stays recoverable as after a crash.

const libc = dlopen("libc.so.6", {
	pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
	poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
	close: { args: [FFIType.i32], returns: FFIType.i32 },
});
// PIDFD_THREAD shares O_EXCL's value; POLLIN|POLLHUP report the pinned thread's exit.
const PIDFD_THREAD = 128;
const THREAD_EXIT_EVENTS = 17;
// Short enough to expire while the fixture worker spins, long enough for the startup pin and the open to reach it.
const OPEN_DEADLINE_MS = 2_000;

const directories: string[] = [];
const descriptors = new Set<number>();
const workers: Worker[] = [];
const ownerships = new Set<AuthorityOwnership>();

afterEach(async () => {
	for (const worker of workers.splice(0)) worker.terminate();
	for (const descriptor of descriptors) libc.symbols.close(descriptor);
	descriptors.clear();
	for (const ownership of ownerships) await ownership.release();
	ownerships.clear();
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function threadExited(pidfd: number): boolean {
	const state = new Uint8Array(8);
	const view = new DataView(state.buffer);
	view.setInt32(0, pidfd, true);
	view.setInt16(4, 1, true);
	if (libc.symbols.poll(ptr(state), 1, 0) < 0) throw new Error("Could not poll the worker thread pin");
	return (view.getInt16(6, true) & THREAD_EXIT_EVENTS) !== 0;
}

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

interface Fixture {
	readonly directory: string;
	readonly session: string;
	readonly options: AuthorityDriverOptions;
	readonly receipts: MutationReceipt[];
}

/** A never-rotated JSONL store with acknowledged history, written directly and closed, under a session file. */
async function storeWithHistory(): Promise<Fixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-open-timeout-"));
	directories.push(directory);
	const session = path.join(directory, "root.jsonl");
	// A root per test: a client that leaked from a failed test must not count against the next test's root.
	const root = crypto.randomUUID();
	await fs.writeFile(session, `{"type":"session","id":"${root}"}\n`);
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: root,
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: `${session}.authority.jsonl`, identity, create: true };
	const ownership = await acquireAuthorityOwnership(session, {
		owningSessionId: identity.owningSessionId,
		create: true,
	});
	const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "history-owner");
	engine.recover();
	const receipts: MutationReceipt[] = [];
	for (let index = 0; index < 24; index++)
		receipts.push(
			engine.transition(operation(index >> 1, index % 2 === 0 ? "intent" : "abandoned"), {
				requestId: `history-${index}`,
			}),
		);
	engine.close();
	await ownership.release();
	return { directory, session, options: { ...options, create: false }, receipts };
}

function storeBytes(directory: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const name of fsSync.readdirSync(directory).sort()) {
		if (!name.includes(".authority.") || name.endsWith(".lock")) continue;
		files[name] = new Bun.CryptoHasher("sha256")
			.update(fsSync.readFileSync(path.join(directory, name)))
			.digest("hex");
	}
	return files;
}

interface TimedOutOpen {
	readonly failure: unknown;
	readonly pidfd: number;
	readonly phase: string;
	readonly releasesAfterExit: boolean[];
}

/** Opens `fixture` through the client with a fixture worker that blocks in `mode`, and returns the open's rejection. */
async function openPastDeadline(
	fixture: Fixture,
	mode: string,
	driver: Partial<AuthorityDriverOptions> = {},
): Promise<TimedOutOpen> {
	const acquired = await acquireAuthorityOwnership(fixture.session, {
		owningSessionId: fixture.options.identity.owningSessionId,
	});
	ownerships.add(acquired);
	const blocked = Promise.withResolvers<{ readonly pidfd: number; readonly phase: string }>();
	let pidfd: number | undefined;
	const releasesAfterExit: boolean[] = [];
	const ownership: AuthorityOwnership = {
		...acquired,
		release: async () => {
			releasesAfterExit.push(pidfd !== undefined && threadExited(pidfd));
			await acquired.release();
			ownerships.delete(acquired);
		},
	};
	const factory = (): Worker => {
		const worker = new Worker(new URL("./authority-open-timeout-worker.ts", import.meta.url).href, {
			type: "module",
			argv: [mode],
		});
		workers.push(worker);
		// Registered before the client's own listener: fixture messages are not authority responses.
		worker.addEventListener("message", event => {
			const value = (event as MessageEvent).data as { kind?: unknown; phase?: unknown; tid?: unknown };
			if (value?.kind !== "open-timeout-fixture") return;
			event.stopImmediatePropagation();
			if (typeof value.tid !== "number" || typeof value.phase !== "string")
				throw new Error("Open-timeout fixture omitted its thread ID or phase");
			pidfd = libc.symbols.pidfd_open(value.tid, PIDFD_THREAD);
			if (pidfd < 0) throw new Error("Could not pin the blocked worker thread");
			descriptors.add(pidfd);
			blocked.resolve({ pidfd, phase: value.phase });
		});
		return worker;
	};
	const started = Date.now();
	const failure = await AuthorityRpcClient.open(
		{ ...fixture.options, ...driver },
		ownership,
		factory,
		"off",
		OPEN_DEADLINE_MS,
	).then(
		client => {
			void client.close();
			return undefined;
		},
		(error: unknown) => error,
	);
	// The rejection waits for the deadline, not for the worker, which never finishes by itself.
	expect(Date.now() - started).toBeGreaterThanOrEqual(OPEN_DEADLINE_MS - 50);
	const pinned = await blocked.promise;
	return { failure, pidfd: pinned.pidfd, phase: pinned.phase, releasesAfterExit };
}

function expectStoppedAndReleased(open: TimedOutOpen): void {
	expect(open.failure).toBeInstanceOf(AuthorityRpcError);
	expect(open.failure).toMatchObject({ name: "TimeoutError", unknownOutcome: true });
	expect((open.failure as Error).message).toMatch(/terminated.*exit.*confirmed.*ownership.*released/);
	expect(threadExited(open.pidfd)).toBe(true);
	expect(open.releasesAfterExit).toEqual([true]);
}

describe("authority client open deadline", () => {
	it("terminates a worker blocked past the open deadline, confirms its exit, then releases ownership", async () => {
		const fixture = await storeWithHistory();
		const before = storeBytes(fixture.directory);
		const open = await openPastDeadline(fixture, "block-replay");
		expect(open.phase).toBe("replay");
		expectStoppedAndReleased(open);
		// Ownership is free again at once, without an explicit cleanup call.
		const next = await acquireAuthorityOwnership(fixture.session, {
			owningSessionId: fixture.options.identity.owningSessionId,
		});
		ownerships.add(next);
		// Failed-open cleanup (as closeSessionAuthority runs it for an unknown open) has nothing left to do: it
		// acknowledges the opening once and never releases ownership a second time.
		expect(await AuthorityRpcClient.closeFailedOpen(fixture.options.identity.owningSessionId)).toBe(true);
		expect(await AuthorityRpcClient.closeFailedOpen(fixture.options.identity.owningSessionId)).toBe(false);
		expect(open.releasesAfterExit).toHaveLength(1);
		// Stopped during its read-only replay, the worker changed nothing; the store opens with its full history.
		expect(storeBytes(fixture.directory)).toEqual(before);
		const client = await AuthorityRpcClient.open(fixture.options, next);
		ownerships.delete(next);
		for (const receipt of fixture.receipts) expect(await client.resolveReceipt(receipt.requestId)).toEqual(receipt);
		await client.close();
	}, 30_000);

	for (const [mode, committed] of [
		["block-after-link", false],
		["block-after-header", true],
	] as const) {
		it(`leaves a recoverable store when the deadline terminates the worker mid-rotation (${mode})`, async () => {
			const fixture = await storeWithHistory();
			// A frame cap below the store's history makes the open's own recovery commit rotate the active segment.
			const open = await openPastDeadline(fixture, mode, {
				jsonlSegment: { minBytes: Number.MAX_SAFE_INTEGER, maxFrames: 8 },
			});
			expect(open.phase).toBe(mode.slice("block-".length));
			expectStoppedAndReleased(open);
			expect(await AuthorityRpcClient.closeFailedOpen(fixture.options.identity.owningSessionId)).toBe(true);
			// The cut left rotation artifacts behind; the next open settles them as after a crash at the same point.
			expect(listJsonlRotationArtifacts(fixture.options.path).length).toBeGreaterThan(0);
			const reopened = new JsonlAuthorityPersistence(fixture.options);
			const engine = new AuthorityEngine(reopened, "recovering-owner");
			engine.recover();
			for (const receipt of fixture.receipts) expect(engine.resolveReceipt(receipt.requestId)).toEqual(receipt);
			reopened.integrityCheck();
			const layout = jsonlLayout(fixture.options.path);
			expect(fsSync.existsSync(layout.index(0))).toBe(committed);
			expect(fsSync.existsSync(layout.segment(0))).toBe(committed);
			engine.close();
			// The recovered store opens through the client again and keeps every acknowledged command.
			const next = await acquireAuthorityOwnership(fixture.session, {
				owningSessionId: fixture.options.identity.owningSessionId,
			});
			const client = await AuthorityRpcClient.open(fixture.options, next);
			for (const receipt of fixture.receipts)
				expect(await client.resolveReceipt(receipt.requestId)).toEqual(receipt);
			await client.close();
		}, 30_000);
	}
});
