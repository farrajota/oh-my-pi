import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthorityRpcClient, AUTHORITY_RESOURCE_CAPS, withAuthorityEffect } from "../../src/registry/authority/client";
import { durableRootHeadHash, canonicalDurableSha256 } from "../../src/registry/durable-state";
import { acquireAuthorityOwnership, type AuthorityOwnership } from "../../src/registry/authority/ownership";
import type { JournalingBackend } from "../../src/registry/authority/types";
import { AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES } from "../../src/registry/authority/types";
import { authorityRequestBytes } from "../../src/registry/authority/engine";
import { createHash } from "node:crypto";
import { openAuthorityCapacityFile } from "../../src/registry/authority/capacity";
import { BorrowedAuthorityCapacityPool } from "../../src/registry/authority/capacity-native";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";
import type { AuthorityIdentity } from "../../src/registry/authority/types";
import type {
	AuthorityCommand,
	AuthorityMethod,
	AuthorityRecordMap,
	MutationOptions,
	MutationReceipt,
} from "../../src/registry/authority/types";
import {
	pinAuthorityWorker,
	waitForAuthorityThreadExit,
	type AuthorityThreadPin,
} from "../../src/registry/authority/thread-lifetime";

const clients: AuthorityRpcClient[] = [];
const directories: string[] = [];
const ballastHandles: Array<{ close(): Promise<void> }> = [];
const workerUrls: string[] = [];
const pendingOpens = new Set<Promise<void>>();
const failedOpens = new Set<string>();
const rawWorkerCleanups = new Map<Worker, () => Promise<void>>();

async function openAuthorityClient(
	options: Parameters<typeof AuthorityRpcClient.open>[0],
	ownership: Parameters<typeof AuthorityRpcClient.open>[1],
	workerFactory?: () => Worker,
): Promise<AuthorityRpcClient> {
	// Every client in this suite exercises physical capacity, which is opt-in (OMP_JOURNALING_CAPACITY=xfs).
	const opening = AuthorityRpcClient.open(options, ownership, workerFactory, "xfs");
	const settled = opening.then(
		client => {
			clients.push(client);
		},
		() => {
			failedOpens.add(options.identity.owningSessionId);
		},
	);
	pendingOpens.add(settled);
	try {
		return await opening;
	} finally {
		pendingOpens.delete(settled);
	}
}

async function openLiveAuthority(
	backend: JournalingBackend,
	root = os.tmpdir(),
	workerFactory?: () => Worker,
): Promise<{ client: AuthorityRpcClient; sessionId: string; directory: string }> {
	const directory = await fs.mkdtemp(path.join(root, "omp-authority-capacity-worker-"));
	directories.push(directory);
	const sessionId = `capacity-${backend}-${crypto.randomUUID()}`;
	const session = path.join(directory, "session.jsonl");
	await fs.writeFile(session, `${JSON.stringify({ type: "session", id: sessionId })}\n`, { mode: 0o600 });
	const ownership = await acquireAuthorityOwnership(session, { owningSessionId: sessionId, create: true });
	const client = await openAuthorityClient(
		{
			path: backend === "sqlite" ? ownership.paths.sqlite : ownership.paths.jsonl,
			identity: { backend, owningSessionId: sessionId, incarnation: crypto.randomUUID(), format: 2 },
			create: true,
		},
		ownership,
		workerFactory,
	);
	return { client, sessionId, directory };
}

type Settlement<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

// Bun's async `rejects` matcher can starve real Worker message delivery until the
// client deadline fires; settle with a native await before matching.
async function settle<T>(promise: Promise<T>): Promise<Settlement<T>> {
	return await promise.then(
		value => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

// Rethrows the exact rejection value so `toThrow` applies its unchanged matching semantics.
function thrownBy<T>(outcome: Settlement<T>): () => never {
	if (outcome.ok)
		throw new Error(`Expected the authority promise to reject, but it resolved with ${Bun.inspect(outcome.value)}`);
	const { error } = outcome;
	return () => {
		throw error;
	};
}

afterEach(async () => {
	const failures: unknown[] = [];
	while (pendingOpens.size) await Promise.all([...pendingOpens]);
	for (const cleanup of [...rawWorkerCleanups.values()]) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	for (const sessionId of failedOpens) {
		try {
			await AuthorityRpcClient.closeFailedOpen(sessionId);
			failedOpens.delete(sessionId);
		} catch (error) {
			failures.push(error);
		}
	}
	for (const client of [...clients]) {
		try {
			await client.close();
			clients.splice(clients.indexOf(client), 1);
		} catch (error) {
			failures.push(error);
		}
	}
	for (const handle of [...ballastHandles]) {
		try {
			await handle.close();
			ballastHandles.splice(ballastHandles.indexOf(handle), 1);
		} catch (error) {
			failures.push(error);
		}
	}
	// Retained typed capabilities must remain reachable, and their directories must remain intact.
	if (clients.length === 0 && failedOpens.size === 0 && rawWorkerCleanups.size === 0 && ballastHandles.length === 0) {
		for (const url of workerUrls.splice(0)) URL.revokeObjectURL(url);
		for (const directory of [...directories]) {
			try {
				await fs.rm(directory, { recursive: true, force: true });
				directories.splice(directories.indexOf(directory), 1);
			} catch (error) {
				failures.push(error);
			}
		}
	}
	if (failures.length)
		throw new AggregateError(
			failures,
			"Authority fixture cleanup failed; unresolved capabilities and directories remain tracked.",
		);
});

async function exerciseSixStepRootTransition(
	client: AuthorityRpcClient,
	sessionId: string,
	beforeFuture?: (step: number) => Promise<void>,
	maximumOptions = false,
	retireUnderPressure = false,
): Promise<void> {
	const now = Date.now();
	const rootId = `root-${sessionId}`;
	const startupHash = canonicalDurableSha256(`${rootId}-startup`);
	const provenanceHash = canonicalDurableSha256(`${rootId}-provenance`);
	const headHash = durableRootHeadHash({ rootId, generation: 1, actorId: rootId, startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		at: now,
		rootId,
		actorId: rootId,
		generation: 1,
		startupHash,
		provenanceHash,
		phase: "reserved" as const,
	};
	await client.transition(construction, { requestId: `${sessionId}-construction-reserved` });
	await client.transition(
		{ ...construction, at: now + 1, phase: "constructing" },
		{ requestId: `${sessionId}-construction-start` },
	);
	await client.transition(
		{ ...construction, at: now + 2, phase: "constructed" },
		{ requestId: `${sessionId}-construction-done` },
	);
	const root = { kind: "root" as const, at: now + 3, rootId, generation: 1, headHash, state: "active" as const };
	const actor = {
		kind: "actor" as const,
		at: now + 3,
		actorId: rootId,
		rootId,
		generation: 1,
		rootGeneration: 1,
		rootHeadHash: headHash,
		startupHash,
		provenanceHash,
		state: "active" as const,
	};
	const activatedConstruction = { ...construction, at: now + 3, phase: "activated" as const };
	const gate = { kind: "gate" as const, at: now + 3, rootId, generation: 1, phase: "open" as const };
	await client.activateAuthority(
		{ root, actor, construction: activatedConstruction, gate },
		{ requestId: `${sessionId}-activation` },
	);
	await client.transition({ ...gate, at: now + 4, phase: "quiescing" });
	await client.transition({ ...gate, at: now + 5, phase: "quiesced" });

	const destinationHeadHash = canonicalDurableSha256(`${rootId}-destination`);
	const transition = {
		kind: "transition" as const,
		at: now + 4,
		transitionId: `${sessionId}-transition`,
		rootId,
		sourceGeneration: 1,
		destinationGeneration: 2,
		sourceHeadHash: headHash,
		destinationHeadHash,
		phase: "staged" as const,
	};
	await client.transition(
		transition,
		maximumOptions
			? await legalMaximumOptions(client, "transition", [transition])
			: { requestId: `${sessionId}-staged` },
	);
	await beforeFuture?.(0);
	const quiescing = { ...transition, at: now + 5, phase: "quiescing" as const };
	await client.transition(
		quiescing,
		maximumOptions
			? await legalMaximumContinuation(client, "transition", [quiescing])
			: { requestId: `${sessionId}-transition-quiescing` },
	);
	expect((await client.getTransition(rootId, transition.transitionId))?.record.phase).toBe("quiescing");
	await beforeFuture?.(1);
	const quiesced = { ...transition, at: now + 6, phase: "quiesced" as const };
	await client.transition(
		quiesced,
		maximumOptions
			? await legalMaximumContinuation(client, "transition", [quiesced])
			: { requestId: `${sessionId}-transition-quiesced` },
	);
	expect((await client.getTransition(rootId, transition.transitionId))?.record.phase).toBe("quiesced");
	await beforeFuture?.(2);
	const validated = { ...transition, at: now + 7, phase: "validated" as const };
	await client.transition(
		validated,
		maximumOptions
			? await legalMaximumContinuation(client, "transition", [validated])
			: { requestId: `${sessionId}-transition-validated` },
	);
	expect((await client.getTransition(rootId, transition.transitionId))?.record.phase).toBe("validated");
	await beforeFuture?.(3);
	const replacementRoot = { ...root, at: now + 8, generation: 2, headHash: destinationHeadHash };
	const cas = {
		transition: { ...transition, at: now + 8, phase: "cas-committed" as const },
		expectedRootGeneration: 1,
		expectedRootHeadHash: headHash,
		root: replacementRoot,
		gate: { ...gate, at: now + 8, phase: "closed" as const },
	};
	await client.commitRootTransition(
		cas,
		maximumOptions
			? await legalMaximumContinuation(client, "commitRootTransition", [cas])
			: { requestId: `${sessionId}-transition-cas` },
	);
	expect((await client.getRoot(rootId))?.record).toEqual(replacementRoot);
	await beforeFuture?.(4);
	const activated = { ...transition, at: now + 9, phase: "activated" as const };
	await client.transition(
		activated,
		maximumOptions
			? await legalMaximumContinuation(client, "transition", [activated])
			: { requestId: `${sessionId}-transition-activated` },
	);
	expect((await client.getTransition(rootId, transition.transitionId))?.record.phase).toBe("activated");
	await beforeFuture?.(5);
	const retired = { ...transition, at: now + 10, phase: "retired" as const };
	await client.transition(
		retired,
		maximumOptions
			? await legalMaximumContinuation(client, "transition", [retired])
			: { requestId: `${sessionId}-transition-retired` },
	);
	expect((await client.getTransition(rootId, transition.transitionId))?.record.phase).toBe("retired");
	expect((await client.getRoot(rootId))?.record.state).toBe("active");
	expect((await client.getActor(rootId))?.record.state).toBe("active");
	if (retireUnderPressure) {
		const retiredRoot = { ...replacementRoot, state: "retired" as const };
		await client.transition(
			retiredRoot,
			maximumOptions
				? await legalMaximumContinuation(client, "transition", [retiredRoot])
				: { requestId: `${sessionId}-retired-root` },
		);
		const retiredActor = { ...actor, state: "retired" as const };
		await client.transition(
			retiredActor,
			maximumOptions
				? await legalMaximumContinuation(client, "transition", [retiredActor])
				: { requestId: `${sessionId}-retired-actor` },
		);
		expect((await client.getRoot(rootId))?.record.state).toBe("retired");
		expect((await client.getActor(rootId))?.record.state).toBe("retired");
	}
}

async function activateCapacityRoot(
	client: AuthorityRpcClient,
	rootId: string,
	maximumOptions = false,
	afterReservation?: (receipt: MutationReceipt) => Promise<void>,
) {
	const startupHash = canonicalDurableSha256(`${rootId}-startup`);
	const provenanceHash = canonicalDurableSha256(`${rootId}-provenance`);
	const headHash = durableRootHeadHash({ rootId, generation: 1, actorId: rootId, startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		at: Date.now(),
		rootId,
		actorId: rootId,
		generation: 1,
		startupHash,
		provenanceHash,
		phase: "reserved" as const,
	};
	const reservation = await client.transition(
		construction,
		maximumOptions ? await legalMaximumOptions(client, "transition", [construction]) : undefined,
	);
	if (maximumOptions)
		expect(await client.resolveReceipt(reservation.requestId, reservation.ownerEpoch)).toEqual(reservation);
	await afterReservation?.(reservation);
	for (const phase of ["constructing", "constructed"] as const) {
		const progress = { ...construction, phase };
		const receipt = await client.transition(
			progress,
			maximumOptions ? await legalMaximumContinuation(client, "transition", [progress]) : undefined,
		);
		if (maximumOptions) expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
		expect((await client.getConstruction(rootId, rootId, 1))?.record.phase).toBe(phase);
	}
	const activation = {
		root: { kind: "root" as const, at: Date.now(), rootId, generation: 1, headHash, state: "active" as const },
		actor: {
			kind: "actor" as const,
			at: Date.now(),
			actorId: rootId,
			rootId,
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: headHash,
			startupHash,
			provenanceHash,
			state: "active" as const,
		},
		construction: { ...construction, phase: "activated" as const },
		gate: { kind: "gate" as const, at: Date.now(), rootId, generation: 1, phase: "open" as const },
	};
	const activated = await client.activateAuthority(
		activation,
		maximumOptions ? await legalMaximumContinuation(client, "activateAuthority", [activation]) : undefined,
	);
	if (maximumOptions)
		expect(await client.resolveReceipt(activated.requestId, activated.ownerEpoch)).toEqual(activated);
	expect((await client.getConstruction(rootId, rootId, 1))?.record.phase).toBe("activated");
	expect((await client.getRoot(rootId))?.record).toEqual(activation.root);
	expect((await client.getActor(rootId))?.record).toEqual(activation.actor);
	expect((await client.getGate(rootId))?.record).toEqual(activation.gate);
	return activation;
}

async function consumeCapacityRootPromises(
	client: AuthorityRpcClient,
	activation: {
		root: AuthorityRecordMap["root"];
		actor: AuthorityRecordMap["actor"];
		gate: AuthorityRecordMap["gate"];
	},
) {
	for (const phase of ["quiescing", "quiesced", "closed"] as const) {
		const gate = { ...activation.gate, phase };
		const receipt = await client.transition(gate, await legalMaximumContinuation(client, "transition", [gate]));
		expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
		expect((await client.getGate(gate.rootId))?.record).toEqual(gate);
	}
	const root = { ...activation.root, state: "retired" as const };
	const actor = { ...activation.actor, state: "retired" as const };
	const rootReceipt = await client.transition(root, await legalMaximumContinuation(client, "transition", [root]));
	expect(await client.resolveReceipt(rootReceipt.requestId, rootReceipt.ownerEpoch)).toEqual(rootReceipt);
	const actorReceipt = await client.transition(actor, await legalMaximumContinuation(client, "transition", [actor]));
	expect(await client.resolveReceipt(actorReceipt.requestId, actorReceipt.ownerEpoch)).toEqual(actorReceipt);
	expect((await client.getRoot(root.rootId))?.record).toEqual(root);
	expect((await client.getActor(actor.actorId))?.record).toEqual(actor);
}

it("rejects a capacity SQLite header outside the source-bound format-4 assumptions", async () => {
	const { client, directory, sessionId } = await openLiveAuthority("sqlite");
	const identity = client.identity;
	await client.close();
	const ownership = await acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
		owningSessionId: sessionId,
		create: false,
	});
	const header = await fs.open(ownership.paths.sqlite, "r+");
	try {
		const legacyFormat = Buffer.alloc(4);
		legacyFormat.writeUInt32BE(3);
		await header.write(legacyFormat, 0, legacyFormat.length, 44);
		await header.sync();
	} finally {
		await header.close();
	}
	expect(
		thrownBy(await settle(openAuthorityClient({ path: ownership.paths.sqlite, identity, create: false }, ownership))),
	).toThrow("format-4");
}, 45_000);

it("removes a newly created SQLite main file after bootstrap funding fails before database allocation", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-capacity-bootstrap-"));
	directories.push(directory);
	const sessionId = `capacity-bootstrap-${crypto.randomUUID()}`;
	const session = path.join(directory, "session.jsonl");
	await fs.writeFile(session, `${JSON.stringify({ type: "session", id: sessionId })}\n`, { mode: 0o600 });
	const ownership = await acquireAuthorityOwnership(session, { owningSessionId: sessionId, create: true });
	const fault = faultWorker("bootstrap-failure");
	const storePath = ownership.paths.sqlite;
	expect(
		thrownBy(
			await settle(
				openAuthorityClient(
					{
						path: storePath,
						identity: {
							backend: "sqlite",
							owningSessionId: sessionId,
							incarnation: crypto.randomUUID(),
							format: 2,
						},
						create: true,
					},
					ownership,
					fault.factory,
				),
			),
		),
	).toThrow("after real SQLite bootstrap funding");
	await expect(fs.lstat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
}, 45_000);

async function legalMaximumOptions(
	client: AuthorityRpcClient,
	method: AuthorityMethod,
	args: readonly unknown[],
	envelope: "request" | "expected" = "request",
): Promise<MutationOptions> {
	const owner = (await client.recoveryState()).owner;
	const prefix = crypto.randomUUID();
	const initial: MutationOptions =
		envelope === "request"
			? { requestId: prefix }
			: { requestId: prefix, expected: [{ domain: "root", key: [prefix], version: null }] };
	const call = {
		kind: "call",
		id: "i".repeat(36),
		method,
		args: [...args, initial],
		owner,
		deadline: Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
	};
	const remaining = AUTHORITY_RESOURCE_CAPS.maxRequestBytes - Buffer.byteLength(JSON.stringify(call));
	if (remaining < 0) throw new Error("Capacity test command itself exceeds the unchanged request bound");
	const expanded = prefix + '"'.repeat(Math.floor(remaining / 2)) + (remaining % 2 === 0 ? "" : "a");
	const options: MutationOptions =
		envelope === "request"
			? { requestId: expanded }
			: { requestId: prefix, expected: [{ domain: "root", key: [expanded], version: null }] };
	expect(Buffer.byteLength(JSON.stringify({ ...call, args: [...args, options] }))).toBe(
		AUTHORITY_RESOURCE_CAPS.maxRequestBytes,
	);
	return options;
}

type ContinuationMethod =
	| "transition"
	| "activateAuthority"
	| "commitRootTransition"
	| "authorizeLocalEffect"
	| "finalizeLocal"
	| "reconcileLocal";

function continuationCommand(method: ContinuationMethod, args: readonly unknown[]): AuthorityCommand {
	switch (method) {
		case "transition":
			return { kind: "transition", record: args[0] } as AuthorityCommand;
		case "activateAuthority":
			return { kind: "activate-authority", activation: args[0] } as AuthorityCommand;
		case "commitRootTransition":
			return { kind: "commit-root-transition", transition: args[0] } as AuthorityCommand;
		case "authorizeLocalEffect":
			return { kind: "authorize-local-effect", claim: args[0] } as AuthorityCommand;
		case "finalizeLocal":
			return { kind: "finalize-local", claim: args[0], outcome: args[1] } as AuthorityCommand;
		case "reconcileLocal":
			return { kind: "reconcile-local", input: args[0] } as AuthorityCommand;
	}
}

/**
 * Options that make a continuation exactly `bytes` long as the engine measures it (command plus options),
 * with the whole envelope in escaped quotes, the worst frame expansion.
 */
function continuationOptions(
	method: ContinuationMethod,
	args: readonly unknown[],
	bytes: number,
	envelope: "request" | "expected",
): MutationOptions {
	const command = continuationCommand(method, args);
	const prefix = crypto.randomUUID();
	const initial: MutationOptions =
		envelope === "request"
			? { requestId: prefix }
			: { requestId: prefix, expected: [{ domain: "root", key: [prefix], version: null }] };
	const remaining = bytes - authorityRequestBytes(command, initial);
	if (remaining < 0) throw new Error("Capacity test continuation itself exceeds the continuation bound");
	const expanded = prefix + '"'.repeat(Math.floor(remaining / 2)) + (remaining % 2 === 0 ? "" : "a");
	const options: MutationOptions =
		envelope === "request"
			? { requestId: expanded }
			: { requestId: prefix, expected: [{ domain: "root", key: [expanded], version: null }] };
	expect(authorityRequestBytes(command, options)).toBe(bytes);
	return options;
}

/**
 * Continuations of admitted records are bounded by AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES, not the 2 MiB
 * admission bound. Proves through the worker RPC that one byte more is refused before acknowledgement with a
 * typed, known-outcome error and nothing written, then returns the maximal legal options.
 */
async function legalMaximumContinuation(
	client: AuthorityRpcClient,
	method: ContinuationMethod,
	args: readonly unknown[],
	envelope: "request" | "expected" = "request",
): Promise<MutationOptions> {
	const before = await client.recoveryState();
	const oversized = continuationOptions(method, args, AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES + 1, envelope);
	const invoke = client[method] as (...values: unknown[]) => Promise<unknown>;
	const refusal = await settle(invoke.call(client, ...args, oversized));
	expect(refusal.ok).toBe(false);
	if (!refusal.ok)
		expect(refusal.error).toMatchObject({ name: "AuthorityContinuationTooLargeError", unknownOutcome: false });
	expect((await client.recoveryState()).revision).toBe(before.revision);
	expect(await client.resolveReceipt(oversized.requestId!, before.owner.epoch)).toBeUndefined();
	return continuationOptions(method, args, AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES, envelope);
}

async function readCapacityState(client: AuthorityRpcClient) {
	// A committed frame always advances recovery.revision. Read current rows separately
	// so maximum escaped receipt identities never accumulate in one response envelope.
	const recovery = await client.recoveryState();
	const openRows = await Promise.all(
		(
			[
				"root",
				"actor",
				"construction",
				"gate",
				"operation",
				"transition",
				"resource",
				"local-entry",
				"local-head",
			] as const
		).map(async domain => {
			const page = await client.listOpen(domain, undefined, 1_000);
			expect(page.cursor).toBeUndefined();
			return { domain, rows: page.rows };
		}),
	);
	return { recovery, openRows };
}

async function compileNativeCloseObstruction(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-native-close-"));
	// Aggregating teardown retains both files if any client/worker still owns the extension.
	directories.push(directory);
	const source = path.join(directory, "close-obstruction.c");
	const library = path.join(directory, "close-obstruction.so");
	await fs.writeFile(
		source,
		`#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1

static _Thread_local sqlite3_stmt *held_statement;
static _Thread_local sqlite3 *actual_database;

int omp_authority_test_try_close(void) {
    /* Never invalidate Bun's pointer by attempting an unobstructed raw close. */
    if (!held_statement || !actual_database) return SQLITE_MISUSE;
    return sqlite3_close(actual_database);
}

int omp_authority_test_release(void) {
    sqlite3_stmt *statement = held_statement;
    held_statement = 0;
    actual_database = 0;
    return statement ? sqlite3_finalize(statement) : SQLITE_OK;
}

int sqlite3_ompclose_init(sqlite3 *database, char **error, const sqlite3_api_routines *api) {
    (void)error;
    SQLITE_EXTENSION_INIT2(api);
    if (held_statement || actual_database) return SQLITE_MISUSE;
    sqlite3_stmt *statement = 0;
    int result = sqlite3_prepare_v2(database, "SELECT 1", -1, &statement, 0);
    if (result != SQLITE_OK) {
        if (statement) sqlite3_finalize(statement);
        return result;
    }
    if (!statement) return SQLITE_MISUSE;
    held_statement = statement;
    actual_database = database;
    return SQLITE_OK;
}
`,
		{ mode: 0o600, flag: "wx" },
	);
	// All SQLite calls use this connection's extension API table, never a linked libsqlite3.
	const compile = Bun.spawn({
		cmd: ["cc", "-shared", "-fPIC", "-O0", "-Wall", "-Wextra", "-Werror", "-Wl,-z,defs", "-o", library, source],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		compile.exited,
		new Response(compile.stdout).text(),
		new Response(compile.stderr).text(),
	]);
	if (exit !== 0) throw new Error(`Native SQLite close fixture compilation failed (${exit}): ${stderr}${stdout}`);
	return library;
}

async function pressureRoot(backend: JournalingBackend, budget: "positive" | "refusal" = "positive"): Promise<string> {
	const fixtureBinding =
		budget === "refusal"
			? { variable: "OMP_QUAL_XFS_FIXTURE", label: "64MiB refusal" }
			: backend === "jsonl"
				? { variable: "OMP_QUAL_XFS_JSONL_FIXTURE", label: "128MiB JSONL positive" }
				: { variable: "OMP_QUAL_SQLITE_POSITIVE_XFS_FIXTURE", label: "96MiB SQLite positive" };
	const manifest = process.env[`${fixtureBinding.variable}_MANIFEST`];
	const hash = process.env[`${fixtureBinding.variable}_SHA256`];
	const launcher = process.env.OMP_QUAL_NATIVE_LAUNCHER;
	const evidence = process.env.OMP_QUAL_RESULT_JOURNAL;
	if (!manifest || !hash || !launcher || !evidence)
		throw new Error(
			`Main must supply the private ${fixtureBinding.label} project fixture and read-only native inspector/evidence bindings`,
		);
	const status = await fs.lstat(manifest);
	if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0)
		throw new Error("Unsafe pressure manifest");
	const text = await fs.readFile(manifest, "utf8");
	expect(createHash("sha256").update(text).digest("hex")).toBe(hash);
	const fixture = JSON.parse(text) as {
		root: string;
		dev: string;
		ino: string;
		projectId: number;
		boundedCapacityBytes: number;
	};
	const root = await fs.lstat(fixture.root, { bigint: true });
	expect(root.isDirectory() && !root.isSymbolicLink()).toBe(true);
	expect(String(root.dev)).toBe(fixture.dev);
	expect(String(root.ino)).toBe(fixture.ino);
	const budgetBytes = pressureBudget(backend, budget);
	expect(fixture.boundedCapacityBytes).toBe(budgetBytes);
	const inspection = Bun.spawn({
		cmd: [launcher, "--inspect-xfs", fixture.root, evidence],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		inspection.exited,
		new Response(inspection.stdout).text(),
		new Response(inspection.stderr).text(),
	]);
	expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
	const actual = JSON.parse(stdout) as {
		projectId: number;
		projectQuotaEnforced: boolean;
		projectInheritance: boolean;
		boundedCapacityBytes: number;
		dev: string;
		ino: string;
	};
	expect(actual.projectId).toBe(fixture.projectId);
	expect(actual.projectQuotaEnforced && actual.projectInheritance).toBe(true);
	expect(actual.boundedCapacityBytes).toBe(budgetBytes);
	expect([actual.dev, actual.ino]).toEqual([fixture.dev, fixture.ino]);
	return fixture.root;
}

// Each pool growth fsyncs (about 10 ms on loop storage), so climb in 1 MiB steps and
// then finish with the same 6-block steps to the exact unpromised-space edge.
const BALLAST_COARSE_STEP_BYTES = 256 * 4_096;
const BALLAST_EDGE_STEP_BYTES = 6 * 4_096;

interface Ballast {
	readonly release: () => Promise<void>;
}

async function exhaustUnpromisedSpace(directory: string, boundedCapacityBytes: number): Promise<Ballast> {
	const ballast = await openAuthorityCapacityFile(directory);
	ballastHandles.push(ballast.handle);
	const pool = BorrowedAuthorityCapacityPool.open(ballast.identity);
	let bytes = 0;
	let failure: unknown;
	for (const step of [BALLAST_COARSE_STEP_BYTES, BALLAST_EDGE_STEP_BYTES]) {
		failure = undefined;
		try {
			while (bytes < boundedCapacityBytes) bytes = pool.ensureDataBytes(bytes + step).dataBytes;
		} catch (error) {
			failure = error;
		}
		if (failure === undefined) break;
		// A refused coarse step must leave exactly the verified prefix before the edge steps.
		if (step === BALLAST_COARSE_STEP_BYTES) expect(pool.reconcile().dataBytes).toBe(bytes);
	}
	expect(failure).toBeDefined();
	let cause = failure;
	while (cause && typeof cause === "object" && "cause" in cause && cause.cause) cause = cause.cause;
	const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
	expect(typeof code === "string" && ["ERRNO_28", "ERRNO_122"].includes(code)).toBe(true);
	return {
		release: async () => {
			// Truncate synchronously; freeing an unlinked inode on close may be deferred.
			pool.releaseDataBytes(pool.reconcile().dataBytes);
			await ballast.handle.close();
			ballastHandles.splice(ballastHandles.indexOf(ballast.handle), 1);
		},
	};
}

function readDurableState(backend: JournalingBackend, storePath: string, identity: AuthorityIdentity): unknown {
	const options = { path: storePath, identity, create: false };
	const reader =
		backend === "sqlite" ? new SqliteAuthorityPersistence(options) : new JsonlAuthorityPersistence(options);
	try {
		return reader.exportState();
	} finally {
		reader.close();
	}
}

/*
 * Approved reopen contract: a reopen funds its own owner and root-recovery episode.
 * Under full ballast it either grows within the budget or refuses before claiming,
 * leaving durable state unchanged and ownership released. After releasing the ballast
 * the reopen must succeed; pressure is then held again for the caller's assertions.
 */
async function reopenFundedOrRefused(
	backend: JournalingBackend,
	directory: string,
	sessionId: string,
	identity: AuthorityIdentity,
	ballast: Ballast,
	workerFactory?: () => Worker,
): Promise<{ client: AuthorityRpcClient; ballast: Ballast; refused: boolean }> {
	const session = path.join(directory, "session.jsonl");
	const acquire = () => acquireAuthorityOwnership(session, { owningSessionId: sessionId, create: false });
	const storePath = (ownership: AuthorityOwnership) =>
		backend === "sqlite" ? ownership.paths.sqlite : ownership.paths.jsonl;
	const first = await acquire();
	const before = readDurableState(backend, storePath(first), identity);
	const attempt = await settle(
		AuthorityRpcClient.open({ path: storePath(first), identity, create: false }, first, workerFactory, "xfs"),
	);
	if (attempt.ok) {
		clients.push(attempt.value);
		return { client: attempt.value, ballast, refused: false };
	}
	expect(attempt.error).toMatchObject({ name: "AuthorityCapacityRefusedError", unknownOutcome: false });
	expect(readDurableState(backend, storePath(first), identity)).toEqual(before);
	await ballast.release();
	const second = await acquire();
	const client = await openAuthorityClient(
		{ path: storePath(second), identity, create: false },
		second,
		workerFactory,
	);
	return { client, ballast: await exhaustUnpromisedSpace(directory, pressureBudget(backend)), refused: true };
}

function pressureBudget(backend: JournalingBackend, budget: "positive" | "refusal" = "positive"): number {
	if (budget === "refusal") return 67_108_864;
	return backend === "jsonl" ? 134_217_728 : 100_663_296;
}

function faultWorker(
	initialMode?: string,
	nativeCloseExtensionPath?: string,
): {
	readonly factory: () => Worker;
	readonly arm: (mode: string) => Promise<void>;
	readonly rawSqlite: (
		options: Parameters<typeof AuthorityRpcClient.open>[0],
		mode?: string,
		deadlineMs?: number,
	) => Promise<Record<string, unknown>>;
	readonly capacities: Array<{ fd: number; device: bigint; inode: bigint }>;
	readonly events: Array<Record<string, unknown>>;
	readonly headers: Array<Record<string, unknown>>;
	readonly sqliteCloseCalls: unknown[];
	readonly prepareCloseCalls: number[];
} {
	const workerModule = new URL("../../src/registry/authority/worker.ts", import.meta.url).href;
	const poolModule = new URL("../../src/registry/authority/capacity-native.ts", import.meta.url).href;
	const admissionModule = new URL("../../src/registry/authority/capacity-sqlite.ts", import.meta.url).href;
	const sqliteModule = new URL("../../src/registry/authority/sqlite-driver.ts", import.meta.url).href;
	const jsonlModule = new URL("../../src/registry/authority/jsonl-driver.ts", import.meta.url).href;
	const engineModule = new URL("../../src/registry/authority/engine.ts", import.meta.url).href;
	const lifetimeModule = new URL("../../src/registry/authority/thread-lifetime.ts", import.meta.url).href;
	const source = `
		import { parentPort } from "node:worker_threads";
		import fs from "node:fs";
		import * as fsNamespace from "node:fs";
		import { spyOn } from "bun:test";
		import { Database } from "bun:sqlite";
		import { dlopen } from "bun:ffi";
		import { runAuthorityWorker } from ${JSON.stringify(workerModule)};
		import { BorrowedAuthorityCapacityPool } from ${JSON.stringify(poolModule)};
		import { AuthorityCapacityAdmission } from ${JSON.stringify(admissionModule)};
		import { SqliteAuthorityConstructionError, SqliteAuthorityPersistence } from ${JSON.stringify(sqliteModule)};
		import { JsonlAuthorityPersistence } from ${JSON.stringify(jsonlModule)};
		import { AuthorityEngine } from ${JSON.stringify(engineModule)};
		import { authorityThreadReadyMessage, handleAuthorityThreadLifetimeMessage } from ${JSON.stringify(lifetimeModule)};
		const rawOnly = process.argv.includes("__authority_capacity_raw_only");
		let mode = ${JSON.stringify(initialMode)};
		const nativeCloseExtensionPath = ${JSON.stringify(nativeCloseExtensionPath)};
		const replacementCleanupRetry = mode === "replacement-cleanup-retry";
		let currentTargetPath;
		let rawTargetPath;
		let capacityConfigurationSeen = false;
		let liveCapacityConfigured = false;
		let syncedForReadback = false;
		let jsonlAppendActive = false;
		let captureDriverFailure = false;
		let captureCapacityFailure = false;
		let dualCloseFailure = false;
		let targetReadbackArmed = false;
		let targetReadbackInjected = false;
		let targetCloseInjected = false;
		let targetDualCloseArmed = false;
		let rawFchmodInjected = false;
		let rawReadInjected = false;
		let rawCloseAttempts = 0;
		let rawDescriptor;
		let rawDescriptorIdentity;
		let rawDescriptorCleanupArmed = false;
		let rawReplacementDescriptor;
		let rawReplacementIdentity;
		let rawReplacementStartByte;
		let failedTargetDescriptor;
		let sqliteCloseAttempts = 0;
		let failedDatabase;
		let nativeCloseObstruction;
		let nativeCloseReleased = false;
		let appendReplacement;
		let appendReplacementIdentity;
		let appendReplacementNextByte;
		let appendCloseReplayed = false;
		let statementFinalizeFailed = false;
		let statementFinalizeRetried = false;
		let failedStatement;
		let failedStatementId;
		let nextStatementId = 0;
		const statementIds = new WeakMap();
		let nextAdmissionId = 0;
		const admissionIds = new WeakMap();
		const targetDescriptors = new Map();
		const native = {
			openSync: fs.openSync,
			closeSync: fs.closeSync,
			fchmodSync: fs.fchmodSync,
			fsyncSync: fs.fsyncSync,
			fstatSync: fs.fstatSync,
			readSync: fs.readSync,
			readFileSync: fs.readFileSync,
			writeSync: fs.writeSync,
		};
		function isTargetPath(value) {
			return typeof value === "string" && currentTargetPath !== undefined &&
				(value === currentTargetPath || value === currentTargetPath + "-wal" || value === currentTargetPath + "-shm");
		}
		function errorEvidence(value, ancestors = new Set()) {
			if (!(value instanceof Error)) return { name: typeof value, message: String(value) };
			if (ancestors.has(value)) return { name: value.name, message: value.message };
			ancestors.add(value);
			const result = { name: value.name, message: value.message };
			if (value.cause !== undefined) result.cause = errorEvidence(value.cause, ancestors);
			if (value instanceof AggregateError) result.errors = Array.from(value.errors, error => errorEvidence(error, ancestors));
			if ("constructionError" in value) result.constructionError = errorEvidence(value.constructionError, ancestors);
			if ("cleanupErrors" in value && Array.isArray(value.cleanupErrors)) result.cleanupErrors = value.cleanupErrors.map(error => errorEvidence(error, ancestors));
			ancestors.delete(value);
			return result;
		}
		function emit(event, values = {}) {
			parentPort.postMessage({ kind: "capacity-test", event, ...values });
		}
		function inspectHeader(filePath) {
			const descriptor = native.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			try {
				const bytes = Buffer.alloc(100);
				const read = native.readSync(descriptor, bytes, 0, bytes.length, 0);
				if (read === 0) return { empty: true, configuredBeforeApplicationRead: capacityConfigurationSeen, liveCapacityConfigured };
				if (read !== bytes.length) throw new Error("SQLite header observation was incomplete");
				return {
					pageSize: bytes.readUInt16BE(16),
					reservedBytes: bytes[20],
					schemaFormat: bytes.readUInt32BE(44),
					encoding: bytes.readUInt32BE(56),
					applicationId: bytes.readUInt32BE(68),
					userVersion: bytes.readUInt32BE(60),
					configuredBeforeApplicationRead: capacityConfigurationSeen,
					liveCapacityConfigured,
				};
			} finally { native.closeSync(descriptor); }
		}
		function verifyAppendReplacement() {
			let identityPreserved = false;
			let offsetPreserved = false;
			let closed = false;
			if (appendReplacement !== undefined) {
				const descriptor = appendReplacement;
				appendReplacement = undefined;
				try {
					const stat = native.fstatSync(descriptor);
					identityPreserved = stat.dev === appendReplacementIdentity.device && stat.ino === appendReplacementIdentity.inode;
					if (identityPreserved) {
						const byte = Buffer.alloc(1);
						offsetPreserved = native.readSync(descriptor, byte, 0, 1, null) === 1 && byte[0] === appendReplacementNextByte;
					}
				} finally {
					native.closeSync(descriptor);
					closed = true;
				}
			}
			emit("jsonl-append-close-aba-verified", { identityPreserved: identityPreserved && !appendCloseReplayed, offsetPreserved, closed });
		}
		const query = Database.prototype.query;
		const databaseExec = Database.prototype.exec;
		Database.prototype.exec = function(...args) {
			if (typeof args[0] === "string" && args[0].includes("locking_mode=EXCLUSIVE")) liveCapacityConfigured = true;
			return databaseExec.apply(this, args);
		};
		Database.prototype.query = function(...args) {
			const sql = args[0];
			// compile_options opens the capacity configuration; page_size opens the portable (capacity off) one.
			if (typeof sql === "string" && /^\\s*PRAGMA\\s+(compile_options|page_size)\\b/i.test(sql)) capacityConfigurationSeen = true;
			if (typeof sql === "string" && /^\\s*PRAGMA\\s+application_id\\b/i.test(sql) && currentTargetPath) {
				try { emit("sqlite-header", { header: inspectHeader(currentTargetPath) }); }
				catch (error) { emit("sqlite-header-observation-error", { error: errorEvidence(error) }); }
			}
			return query.apply(this, args);
		};
		const prepareStatement = Database.prototype.prepare;
		Database.prototype.prepare = function(...args) {
			const statement = prepareStatement.apply(this, args);
			const statementId = ++nextStatementId;
			statementIds.set(statement, statementId);
			return new Proxy(statement, {
				get(target, property) {
					if (property === "finalize") return (...finalizeArgs) => {
						if (mode === "sqlite-close-retry" && !statementFinalizeFailed && typeof args[0] === "string" && /^SELECT order_key, version, wrapper_order, record FROM .* WHERE /.test(args[0])) {
							statementFinalizeFailed = true;
							failedStatement = target;
							failedStatementId = statementIds.get(target);
							emit("statement-finalize-failure", { message: "injected statement finalization failure", statementId: failedStatementId });
							throw new Error("injected statement finalization failure");
						}
						const result = Reflect.apply(Reflect.get(target, property, target), target, finalizeArgs);
						if (mode === "sqlite-close-retry" && failedStatement === target && !statementFinalizeRetried) {
							statementFinalizeRetried = true;
							emit("statement-finalize-retry", { nativeFinalization: true, statementId: failedStatementId });
						}
						return result;
					};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		};
		const closeDatabase = Database.prototype.close;
		Database.prototype.close = function(...args) {
			if (mode === "sqlite-native-close-retry" && failedDatabase === undefined) {
				failedDatabase = this;
				if (!nativeCloseExtensionPath) throw new Error("Native SQLite close obstruction fixture is missing");
				nativeCloseObstruction = dlopen(nativeCloseExtensionPath, {
					omp_authority_test_try_close: { args: [], returns: "int" },
					omp_authority_test_release: { args: [], returns: "int" },
				});
				// The callback receives THIS database's sqlite3 pointer and SQLite API table.
				// Retain the FFI reference and raw statement across the rejected close/retry.
				this.loadExtension(nativeCloseExtensionPath, "sqlite3_ompclose_init");
				const nativeCloseCode = nativeCloseObstruction.symbols.omp_authority_test_try_close();
				const alive = this.query("SELECT 37 AS alive").get().alive;
				emit("sqlite-native-close-failure", { force: args[0], databaseId: this.handle, nativeCloseApi: "sqlite3_close", nativeCloseCode,
					underlyingNativeCloseAttempted: true, bunCloseCalled: false, nativeCloseCompleted: false, connectionUsable: alive === 37, alive });
				if (nativeCloseCode !== 5) throw new Error("Actual sqlite3_close returned unexpected code " + nativeCloseCode);
				// Translate an actual C API failure at Database.close; Bun did not emit this error.
				throw new Error("actual sqlite3_close returned SQLITE_BUSY (5) on this retained Bun connection");
			}
			if (this === failedDatabase && nativeCloseObstruction && !nativeCloseReleased) {
				const nativeFinalizeCode = nativeCloseObstruction.symbols.omp_authority_test_release();
				nativeCloseReleased = true;
				const unsafeNativeCloseGuardCode = nativeCloseObstruction.symbols.omp_authority_test_try_close();
				emit("sqlite-native-close-obstruction-released", { databaseId: this.handle, nativeFinalizeCode, unsafeNativeCloseGuardCode,
					connectionUsable: this.query("SELECT 37 AS alive").get().alive === 37 });
				if (nativeFinalizeCode !== 0 || unsafeNativeCloseGuardCode !== 21) throw new Error("Native SQLite close obstruction release/guard failed");
			}
			const databaseId = this.handle;
			const result = closeDatabase.apply(this, args);
			emit("sqlite-database-close", { force: args[0], attempt: ++sqliteCloseAttempts, nativeCloseCalled: true, nativeCloseCompleted: true });
			if (this === failedDatabase) {
				emit("sqlite-native-close-retry", { force: args[0], databaseId, sameDatabase: true, bunCloseCalled: true, nativeCloseCompleted: true });
				// SQLite releases its loadExtension reference during close; keep ours until then.
				if (nativeCloseObstruction) {
					nativeCloseObstruction.close();
					nativeCloseObstruction = undefined;
					emit("sqlite-native-close-extension-unloaded", { afterBunClose: true });
				}
			}
			return result;
		};
		const nativeReadFile = fs.readFileSync;
		fs.readFileSync = function(...args) {
			const result = nativeReadFile.apply(this, args);
			if (mode === "post-readback" && syncedForReadback) {
				mode = undefined;
				syncedForReadback = false;
				throw new Error("injected readback failure after actual JSONL append readback");
			}
			return result;
		};
		fs.openSync = function(...args) {
			const descriptor = native.openSync.apply(this, args);
			const filename = args[0];
			const flags = args[1];
			if (isTargetPath(filename)) {
				const stat = native.fstatSync(descriptor);
				targetDescriptors.set(descriptor, { path: filename, device: stat.dev, inode: stat.ino, allocatedBlocks: Number(stat.blocks), allocationSteps: 0 });
			}
			const creates = typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0;
			const writable = typeof flags === "number" && (flags & fs.constants.O_RDWR) !== 0;
			if (filename === rawTargetPath && rawDescriptor === undefined &&
				(mode === "raw-bootstrap-fd-dual" && creates || mode === "raw-header-fd-dual" && !creates && !writable)) {
				const stat = native.fstatSync(descriptor);
				rawDescriptor = descriptor;
				rawDescriptorIdentity = { fd: descriptor, device: stat.dev, inode: stat.ino };
			}
			return descriptor;
		};
		fs.fchmodSync = function(...args) {
			if (mode === "raw-bootstrap-fd-dual" && args[0] === rawDescriptor && !rawFchmodInjected) {
				rawFchmodInjected = true;
				rawDescriptorCleanupArmed = true;
				emit("raw-fchmod-failure", { descriptor: rawDescriptorIdentity });
				throw new Error("injected SQLite raw descriptor fchmod primary failure");
			}
			return native.fchmodSync.apply(this, args);
		};
		fs.fstatSync = function(...args) {
			const result = native.fstatSync.apply(this, args);
			const descriptor = args[0];
			const target = targetDescriptors.get(descriptor);
			if (target && mode === "target-partial-allocation") {
				// Funding certifies every fallocate step with an fstat identity readback; a grown
				// st_blocks proves that readback follows a real completed allocation step.
				const allocatedBlocks = Number(result.blocks);
				if (allocatedBlocks > target.allocatedBlocks) {
					target.allocatedBlocks = allocatedBlocks;
					target.allocationSteps++;
				}
				if (target.allocationSteps === 2) {
					// Funding syncs once after all steps, so this cut leaves a real, unsynchronized partial allocation.
					mode = undefined;
					captureCapacityFailure = true;
					emit("target-partial-allocation-failure", { path: target.path, completedNativeChunks: target.allocationSteps, nativeSyncCalled: false });
					throw new Error("injected SQLite target identity readback failure after two real allocation steps");
				}
			}
			if (targetDescriptors.has(descriptor) && mode === "target-readback" && targetReadbackArmed && !targetReadbackInjected) {
				targetReadbackInjected = true;
				mode = undefined;
				emit("target-readback-failure", { path: targetDescriptors.get(descriptor).path, readbackCompleted: true });
				throw new Error("injected SQLite target readback failure after actual fstat");
			}
			return result;
		};
		fs.readSync = function(...args) {
			const result = native.readSync.apply(this, args);
			// The driver may read back its appended bytes through a positioned read rather than a whole-file read.
			if (mode === "post-readback" && syncedForReadback) {
				mode = undefined;
				syncedForReadback = false;
				throw new Error("injected readback failure after actual JSONL append readback");
			}
			if (mode === "raw-header-fd-dual" && args[0] === rawDescriptor && !rawReadInjected) {
				rawReadInjected = true;
				rawDescriptorCleanupArmed = true;
				mode = undefined;
				emit("raw-header-read-failure", { descriptor: rawDescriptorIdentity, readbackCompleted: true });
				throw new Error("injected SQLite header descriptor read primary failure after actual read");
			}
			return result;
		};
		fs.writeSync = function(...args) {
			const target = targetDescriptors.get(args[0]);
			if (target?.path === currentTargetPath && ["post-fsync", "post-readback", "dual-failure", "append-close-aba-same", "append-close-aba-other"].includes(mode)) jsonlAppendActive = true;
			return native.writeSync.apply(this, args);
		};
		fs.fsyncSync = function(...args) {
			const descriptor = args[0];
			const target = targetDescriptors.get(descriptor);
			if (target && mode === "target-dual-failure" && !targetCloseInjected) {
				native.fsyncSync.apply(this, args);
				targetDualCloseArmed = true;
				mode = undefined;
				captureCapacityFailure = true;
				emit("target-primary-sync-failure", { path: target.path, allocationCompleted: true, nativeSyncCalled: true });
				throw new Error("injected SQLite target sync primary failure after real target sync");
			}
			if (target && mode === "target-sync") {
				mode = undefined;
				captureCapacityFailure = true;
				emit("target-sync-failure", { path: target.path, allocationCompleted: true, nativeSyncCalled: false });
				throw new Error("injected SQLite target sync failure after native partial allocation");
			}
			if (target && mode === "target-readback" && !targetReadbackArmed) {
				const result = native.fsyncSync.apply(this, args);
				targetReadbackArmed = true;
				return result;
			}
			if (jsonlAppendActive && mode === "post-fsync") {
				const result = native.fsyncSync.apply(this, args);
				mode = undefined;
				jsonlAppendActive = false;
				throw new Error("injected JSONL append sync failure after real fsync");
			}
			if (jsonlAppendActive && mode === "dual-failure") {
				const result = native.fsyncSync.apply(this, args);
				mode = undefined;
				captureDriverFailure = true;
				dualCloseFailure = true;
				throw new Error("injected JSONL append primary failure after real fsync");
			}
			const result = native.fsyncSync.apply(this, args);
			if (jsonlAppendActive && mode === "post-readback") syncedForReadback = true;
			return result;
		};
		fs.closeSync = function(...args) {
			const descriptor = args[0];
			const target = targetDescriptors.get(descriptor);
			if (descriptor === appendReplacement) {
				appendCloseReplayed = true;
				appendReplacement = undefined;
				emit("jsonl-append-close-aba-replayed");
			}
			if (jsonlAppendActive && target?.path === currentTargetPath && (mode === "append-close-aba-same" || mode === "append-close-aba-other")) {
				const sameInode = mode === "append-close-aba-same";
				mode = undefined;
				jsonlAppendActive = false;
				captureDriverFailure = true;
				native.closeSync(descriptor);
				targetDescriptors.delete(descriptor);
				const replacementPath = sameInode ? currentTargetPath : currentTargetPath + ".append-aba";
				const replacement = native.openSync(replacementPath, sameInode ? fs.constants.O_RDONLY : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
				if (!sameInode) { native.writeSync(replacement, Buffer.from("ABA"), 0, 3, 0); fs.unlinkSync(replacementPath); }
				appendReplacement = replacement;
				const stat = native.fstatSync(replacement);
				appendReplacementIdentity = { device: stat.dev, inode: stat.ino };
				const bytes = Buffer.alloc(2);
				native.readSync(replacement, bytes, 0, bytes.length, 0);
				appendReplacementNextByte = bytes[1];
				native.readSync(replacement, Buffer.alloc(1), 0, 1, null);
				emit("jsonl-append-close-aba", { nativeCloseCompleted: true, sameNumber: replacement === descriptor,
					sameInode: stat.dev === target.device && stat.ino === target.inode });
				throw new Error("injected successful JSONL append close error after consumed descriptor reuse");
			}
			if (descriptor === rawDescriptor && rawDescriptorCleanupArmed && rawCloseAttempts === 0) {
				rawCloseAttempts++;
				native.closeSync.apply(this, args);
				targetDescriptors.delete(descriptor);
				rawDescriptor = undefined;
				rawDescriptorCleanupArmed = false;
				const replacement = native.openSync(rawTargetPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
				const stat = native.fstatSync(replacement);
				rawReplacementDescriptor = replacement;
				rawReplacementIdentity = { fd: replacement, device: stat.dev, inode: stat.ino };
				const firstByte = Buffer.alloc(1);
				const bytesRead = native.readSync(replacement, firstByte, 0, 1, null);
				rawReplacementStartByte = bytesRead === 1 ? firstByte[0] : undefined;
				emit("raw-descriptor-close-failure", { attempt: rawCloseAttempts, descriptor: rawDescriptorIdentity, nativeCloseCompleted: true,
					replacement: rawReplacementIdentity, replacementStartByte: rawReplacementStartByte });
				throw new Error("injected SQLite raw descriptor close response failure after actual native close");
			}
			if (dualCloseFailure && jsonlAppendActive && target?.path === currentTargetPath) {
				dualCloseFailure = false;
				jsonlAppendActive = false;
				native.closeSync.apply(this, args);
				targetDescriptors.delete(descriptor);
				emit("jsonl-descriptor-close-failure", { descriptor, nativeCloseCompleted: true });
				throw new Error("injected JSONL append descriptor cleanup failure after native close");
			}
			if (targetDualCloseArmed && target && !targetCloseInjected) {
				targetDualCloseArmed = false;
				targetCloseInjected = true;
				captureCapacityFailure = true;
				failedTargetDescriptor = { fd: descriptor, device: target.device, inode: target.inode };
				native.closeSync.apply(this, args);
				targetDescriptors.delete(descriptor);
				emit("target-descriptor-close-failure", { descriptor: failedTargetDescriptor, nativeCloseCompleted: true });
				throw new Error("injected SQLite target descriptor cleanup failure");
			}
			const result = native.closeSync.apply(this, args);
			// A failed Linux close consumes its descriptor; never retry the integer.
			targetDescriptors.delete(descriptor);
			if (descriptor === rawDescriptor) { rawDescriptor = undefined; rawDescriptorCleanupArmed = false; }
			if (target?.path === currentTargetPath) jsonlAppendActive = false;
			return result;
		};
		// Bun 1.4.4 snapshots \`import * as fs\` namespaces, so default-object patches plus
		// syncBuiltinESMExports never reach the drivers; rebind the shared namespace instead.
		for (const name of ["openSync", "closeSync", "fchmodSync", "fsyncSync", "fstatSync", "readSync", "readFileSync", "writeSync"]) {
			const wrapped = fs[name];
			spyOn(fsNamespace, name).mockImplementation(wrapped);
		}
		// Bun 1.4.4 exposes parentPort.postMessage as a non-configurable own property bound to
		// a private native post, so responses cannot be rewritten inside the worker. Requests
		// reach this listener before runAuthorityWorker; it announces each transport fault, and
		// the host rewrites the matching real response before the client observes it.
		let replacementCloseId;
		let cleanupFailureInjected = false;
		let replacementCleanupRequests = 0;
		let replacementCleanupConsumed = false;
		const exitProcess = process.exit.bind(process);
		process.exit = function(...args) {
			if (replacementCleanupRetry && replacementCloseId && !replacementCleanupConsumed) return;
			return exitProcess(...args);
		};
		const fundBootstrap = AuthorityCapacityAdmission.prototype.fundBootstrap;
		AuthorityCapacityAdmission.prototype.fundBootstrap = function(...args) {
			const result = fundBootstrap.apply(this, args);
			if (mode === "bootstrap-failure" && args[1] === undefined) {
				mode = undefined;
				throw new Error("injected failure after real SQLite bootstrap funding");
			}
			return result;
		};
		const admissionPrepareClose = AuthorityCapacityAdmission.prototype.prepareClose;
		AuthorityCapacityAdmission.prototype.prepareClose = function(...args) {
			let id = admissionIds.get(this);
			if (id === undefined) { id = ++nextAdmissionId; admissionIds.set(this, id); }
			try {
				const result = admissionPrepareClose.apply(this, args);
				emit("prepare-close", { admissionId: id, ok: true });
				return result;
			} catch (error) {
				emit("prepare-close", { admissionId: id, ok: false, error: errorEvidence(error) });
				throw error;
			}
		};
		let optionalRefill = false;
		for (const Driver of [SqliteAuthorityPersistence, JsonlAuthorityPersistence]) {
			const close = Driver.prototype.close;
			Driver.prototype.close = function(...args) {
				if (appendReplacement !== undefined) verifyAppendReplacement();
				try {
					const result = close.apply(this, args);
					if (mode === "physical-close") { mode = undefined; throw new Error("injected response loss after actual driver close"); }
					return result;
				} catch (error) {
					if (Driver === SqliteAuthorityPersistence && mode === "sqlite-close-retry") emit("sqlite-close-error", { error: errorEvidence(error) });
					throw error;
				}
			};
		}
		const sqliteTransaction = SqliteAuthorityPersistence.prototype.transaction;
		SqliteAuthorityPersistence.prototype.transaction = function(...args) {
			try { return sqliteTransaction.apply(this, args); }
			catch (error) {
				if (captureCapacityFailure) {
					emit("capacity-prepare-error", { error: errorEvidence(error) });
					captureCapacityFailure = false;
				}
				throw error;
			}
		};
		const jsonlTransaction = JsonlAuthorityPersistence.prototype.transaction;
		JsonlAuthorityPersistence.prototype.transaction = function(...args) {
			try { return jsonlTransaction.apply(this, args); }
			catch (error) {
				if (captureDriverFailure) {
					emit("jsonl-append-error", { error: errorEvidence(error) });
					captureDriverFailure = false;
				}
				throw error;
			}
		};
		// A grouped JSONL command reaches its durable append boundary (sync, readback, close) in the group sync.
		const engineSyncGroup = AuthorityEngine.prototype.syncGroup;
		AuthorityEngine.prototype.syncGroup = function(...args) {
			try { return engineSyncGroup.apply(this, args); }
			catch (error) {
				if (captureDriverFailure) {
					emit("jsonl-append-error", { error: errorEvidence(error) });
					captureDriverFailure = false;
				}
				throw error;
			}
		};
		const poolEnsure = BorrowedAuthorityCapacityPool.prototype.ensureDataBytes;
		BorrowedAuthorityCapacityPool.prototype.ensureDataBytes = function(bytes) {
			if (mode === "allocation") {
				mode = undefined;
				poolEnsure.call(this, bytes);
				throw new Error("injected post-allocation reconciliation failure");
			}
			if (mode === "reconciliation" || mode === "admission-gate") {
				const failedMode = mode;
				if (mode === "reconciliation") mode = undefined;
				throw new Error("injected real allocator boundary: " + failedMode);
			}
			return poolEnsure.call(this, bytes);
		};
		const inspect = BorrowedAuthorityCapacityPool.prototype.inspect;
		BorrowedAuthorityCapacityPool.prototype.inspect = function() {
			const result = inspect.call(this);
			if (optionalRefill) throw new Error("injected optional-refill readback failure");
			return result;
		};
		const reconcile = BorrowedAuthorityCapacityPool.prototype.reconcile;
		BorrowedAuthorityCapacityPool.prototype.reconcile = function() {
			if (optionalRefill) throw new Error("injected optional-refill reconciliation failure");
			if (mode === "reconciliation") { mode = undefined; throw new Error("injected same-owner reconciliation failure"); }
			if (mode === "admission-gate" || mode === "refill-blocked") throw new Error("injected persistent NEW-admission reconciliation failure");
			return reconcile.call(this);
		};
		const prepare = AuthorityCapacityAdmission.prototype.prepare;
		AuthorityCapacityAdmission.prototype.prepare = function(...args) {
			if (mode === "owner-close" && args[0].command.kind === "owner" && args[0].command.owner.phase === "closed") {
				mode = undefined;
				throw new Error("injected durable owner close failure");
			}
			try { return prepare.apply(this, args); }
			catch (error) {
				if (captureCapacityFailure) {
					emit("capacity-prepare-error", { error: errorEvidence(error) });
					captureCapacityFailure = false;
				}
				throw error;
			}
		};
		const committed = AuthorityCapacityAdmission.prototype.committed;
		AuthorityCapacityAdmission.prototype.committed = function(...args) {
			optionalRefill = mode === "refill";
			if (optionalRefill) mode = "refill-blocked";
			try { return committed.apply(this, args); }
			finally { optionalRefill = false; }
		};
		parentPort.on("message", message => {
			if (rawOnly && handleAuthorityThreadLifetimeMessage(message, parentPort)) return;
			if (message?.kind === "open" && typeof message.driver?.path === "string") currentTargetPath = message.driver.path;
			if (message?.kind === "capacity-test" && message.command === "raw-sqlite") {
				if (message.mode === "raw-worker-exit") { process.exit(17); return; }
				if (message.mode === "raw-worker-error") throw new Error("injected raw worker failure");
				if (message.mode === "raw-no-response") return;
				currentTargetPath = message.options.path;
				rawTargetPath = message.options.path;
				mode = message.mode;
				if (typeof mode === "string" && mode.startsWith("raw-")) captureCapacityFailure = false;
				void (async () => {
					let result;
					try {
						const persistence = new SqliteAuthorityPersistence(message.options);
						persistence.close();
						result = { ok: true };
					} catch (error) {
						let cleanupSucceeded = false;
						let cleanupAttempts = 0;
						const cleanupFailures = [];
						if (error instanceof SqliteAuthorityConstructionError) {
							for (let attempt = 0; attempt < 2 && !cleanupSucceeded; attempt++) {
								cleanupAttempts++;
								try { error.cleanup(); cleanupSucceeded = true; }
								catch (failure) { cleanupFailures.push(errorEvidence(failure)); }
							}
						}
						result = { ok: false, error: errorEvidence(error), cleanupSucceeded, cleanupAttempts, cleanupFailures };
					}
					let rawReplacementVerified = false;
					let rawReplacementClosed = false;
					if (rawReplacementDescriptor !== undefined) {
						try {
							const stat = native.fstatSync(rawReplacementDescriptor);
							const nextByte = Buffer.alloc(1);
							const bytesRead = native.readSync(rawReplacementDescriptor, nextByte, 0, 1, null);
							const expectedContent = message.mode === "raw-bootstrap-fd-dual"
								? rawReplacementStartByte === undefined && bytesRead === 0 && stat.size === 0
								: rawReplacementStartByte === 0x53 && bytesRead === 1 && nextByte[0] === 0x51;
							rawReplacementVerified = stat.dev === rawDescriptorIdentity.device && stat.ino === rawDescriptorIdentity.inode &&
								rawReplacementIdentity.fd === rawDescriptorIdentity.fd && expectedContent;
						} catch (error) { emit("raw-replacement-verification-error", { error: errorEvidence(error) }); }
						finally {
							try {
								const stat = native.fstatSync(rawReplacementDescriptor);
								if (stat.dev === rawReplacementIdentity.device && stat.ino === rawReplacementIdentity.inode) {
									native.closeSync(rawReplacementDescriptor);
									rawReplacementClosed = true;
								}
							} catch (error) { emit("raw-replacement-close-error", { error: errorEvidence(error) }); }
							rawReplacementDescriptor = undefined;
						}
					}
					emit("raw-sqlite-result", { id: message.id, result, rawCloseAttempts, rawDescriptor: rawDescriptorIdentity,
						rawDescriptorClosed: rawDescriptor === undefined, rawReplacementIdentity, rawReplacementVerified, rawReplacementClosed,
						prepareCloseIds: Array.from(prepareCloseIdsForWorker) });
				})();
			}
			if (replacementCleanupRetry) {
				if (message?.kind === "call" && message.method === "close" && typeof message.id === "string") {
					replacementCloseId = message.id;
					emit("transport-fault", { fault: "replacement-close-response-loss", id: message.id });
				}
				if (message?.kind === "authority-thread-lifetime" && message.phase === "cleanup-request" && replacementCloseId) {
					replacementCleanupRequests++;
					emit("replacement-cleanup-request", { cleanupRequest: replacementCleanupRequests });
					// The worker schedules process.exit only after posting a successful cleanup reply.
					if (replacementCleanupRequests >= 2) replacementCleanupConsumed = true;
				}
				if (message?.kind === "authority-thread-lifetime" && message.phase === "cleanup-request" && replacementCloseId && !cleanupFailureInjected) {
					cleanupFailureInjected = true;
					emit("transport-fault", { fault: "stale-cleanup-reply", cleanupRequest: replacementCleanupRequests });
				}
			}
			if (message?.kind !== "capacity-fault") return;
			mode = message.mode;
			if (mode === "verify-append-close-aba") verifyAppendReplacement();
			if (typeof mode === "string" && mode.startsWith("target-")) captureCapacityFailure = true;
			if (mode === "dual-failure") captureDriverFailure = true;
			parentPort.postMessage({ kind: "capacity-fault-armed", id: message.id });
		});
		const prepareCloseIdsForWorker = [];
		const trackedPrepareClose = AuthorityCapacityAdmission.prototype.prepareClose;
		AuthorityCapacityAdmission.prototype.prepareClose = function(...args) {
			let id = admissionIds.get(this);
			if (id === undefined) { id = ++nextAdmissionId; admissionIds.set(this, id); }
			prepareCloseIdsForWorker.push(id);
			return trackedPrepareClose.apply(this, args);
		};
		if (rawOnly) parentPort.postMessage(authorityThreadReadyMessage());
		else await runAuthorityWorker();
	`;
	const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	workerUrls.push(url);
	let worker: Worker | undefined;
	const pendingArms = new Map<string, () => void>();
	const pendingRaw = new Map<string, (value: Record<string, unknown>) => void>();
	const capacities: Array<{ fd: number; device: bigint; inode: bigint }> = [];
	const events: Array<Record<string, unknown>> = [];
	const headers: Array<Record<string, unknown>> = [];
	const sqliteCloseCalls: unknown[] = [];
	const prepareCloseCalls: number[] = [];
	const rewritten = new WeakSet<Event>();
	let lostAckArmed = false;
	let replacementCloseLossId: string | undefined;
	let staleCleanupRequest: number | undefined;
	let cleanupRequests = 0;
	// Replaces a real worker response with the transport-faulted one the client must observe.
	const deliver = (target: Worker, event: Event, data: unknown): void => {
		event.stopImmediatePropagation();
		const replacement = new MessageEvent("message", { data });
		rewritten.add(replacement);
		target.dispatchEvent(replacement);
	};
	const makeWorker = (rawOnly = false): Worker => {
		const current = rawOnly
			? new Worker(url, { type: "module", argv: ["__authority_capacity_raw_only"] })
			: new Worker(url);
		current.addEventListener("message", event => {
			if (rewritten.has(event)) return;
			const value: unknown = event.data;
			if (!value || typeof value !== "object") return;
			const response = value as Record<string, unknown>;
			if (lostAckArmed && response.ok === true && typeof response.id === "string") {
				lostAckArmed = false;
				deliver(current, event, { malformedCapacityAck: true });
				return;
			}
			if (replacementCloseLossId !== undefined && response.id === replacementCloseLossId && response.ok === true) {
				deliver(current, event, {
					...response,
					ok: false,
					error: { name: "Error", message: "injected replacement close response loss", unknownOutcome: false },
				});
				return;
			}
			if (response.kind === "authority-thread-lifetime" && response.phase === "cleanup") {
				if (staleCleanupRequest !== undefined) {
					events.push({
						kind: "capacity-test",
						event: "replacement-cleanup-retained",
						cleanupRequest: staleCleanupRequest,
					});
					staleCleanupRequest = undefined;
					deliver(current, event, { ...response, id: "stale-cleanup-capability" });
					return;
				}
				if (replacementCloseLossId !== undefined && response.ok === true && cleanupRequests >= 2)
					events.push({
						kind: "capacity-test",
						event: "replacement-cleanup-consumed",
						cleanupRequest: cleanupRequests,
					});
				return;
			}
			if (!("kind" in value)) return;
			if (value.kind === "capacity-fault-armed" && "id" in value && typeof value.id === "string") {
				event.stopImmediatePropagation();
				pendingArms.get(value.id)?.();
				pendingArms.delete(value.id);
				return;
			}
			if (value.kind !== "capacity-test") return;
			event.stopImmediatePropagation();
			const record = value as Record<string, unknown>;
			if (record.event === "transport-fault") {
				if (record.fault === "replacement-close-response-loss" && typeof record.id === "string")
					replacementCloseLossId = record.id;
				if (record.fault === "stale-cleanup-reply" && typeof record.cleanupRequest === "number")
					staleCleanupRequest = record.cleanupRequest;
				return;
			}
			if (record.event === "replacement-cleanup-request" && typeof record.cleanupRequest === "number")
				cleanupRequests = record.cleanupRequest;
			events.push(record);
			if (record.event === "sqlite-header" && record.header && typeof record.header === "object")
				headers.push(record.header as Record<string, unknown>);
			if (record.event === "sqlite-database-close") sqliteCloseCalls.push(record.force);
			if (record.event === "prepare-close" && typeof record.admissionId === "number")
				prepareCloseCalls.push(record.admissionId);
			if (record.event === "raw-sqlite-result" && typeof record.id === "string") pendingRaw.get(record.id)?.(record);
		});
		worker = current;
		return new Proxy(current, {
			get(target, property) {
				if (property === "postMessage")
					return (message: unknown) => {
						if (
							message &&
							typeof message === "object" &&
							"kind" in message &&
							message.kind === "open" &&
							"driver" in message
						) {
							const driver = message.driver as {
								capacity: { identity: { fd: number; device: bigint; inode: bigint } };
							};
							capacities.push({ ...driver.capacity.identity });
						}
						target.postMessage(message);
					};
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	return {
		capacities,
		events,
		headers,
		sqliteCloseCalls,
		prepareCloseCalls,
		factory: () => makeWorker(),
		rawSqlite: async (options, mode, deadlineMs = 20_000) => {
			const current = makeWorker(true);
			const id = crypto.randomUUID();
			const response = Promise.withResolvers<Record<string, unknown>>();
			let pin: AuthorityThreadPin | undefined;
			const exited = Promise.withResolvers<void>();
			// A synchronous structured-clone failure can occur before the response is awaited.
			void response.promise.catch(() => {});
			const onError = (event: Event) => {
				event.preventDefault();
				response.reject(new Error("Raw SQLite worker failed", { cause: event }));
			};
			const onMessageError = (event: Event) =>
				response.reject(new Error("Raw SQLite worker message failed", { cause: event }));
			const onExit = () => {
				exited.resolve();
				response.reject(new Error("Raw SQLite worker exited before its result"));
			};
			// Real-worker integration needs a platform-clock safety bound even if the worker never answers.
			let timer = setTimeout(
				() => response.reject(new Error("Raw SQLite worker startup deadline exceeded")),
				20_000,
			);
			const cleanup = async () => {
				response.reject(new Error("Raw SQLite worker cleanup cancelled the pending result"));
				clearTimeout(timer);
				pendingRaw.delete(id);
				current.removeEventListener("error", onError);
				current.removeEventListener("messageerror", onMessageError);
				if (!pin?.hasExited()) current.terminate();
				if (pin) await waitForAuthorityThreadExit(pin, Date.now() + 20_000);
				else {
					const deadline = Promise.withResolvers<never>();
					const exitTimer = setTimeout(
						() => deadline.reject(new Error("Raw worker termination remains unconfirmed")),
						20_000,
					);
					try {
						await Promise.race([exited.promise, deadline.promise]);
					} finally {
						clearTimeout(exitTimer);
					}
				}
				current.removeEventListener("close", onExit);
				rawWorkerCleanups.delete(current);
				worker = undefined;
			};
			rawWorkerCleanups.set(current, cleanup);
			let primary: unknown;
			try {
				current.addEventListener("error", onError);
				current.addEventListener("messageerror", onMessageError);
				current.addEventListener("close", onExit);
				pin = await pinAuthorityWorker(current, Date.now() + 20_000);
				clearTimeout(timer);
				timer = setTimeout(
					() => response.reject(new Error("Raw SQLite worker result deadline exceeded")),
					deadlineMs,
				);
				pendingRaw.set(id, response.resolve);
				current.postMessage({
					kind: "capacity-test",
					command: "raw-sqlite",
					id,
					options,
					mode,
					...(mode === "raw-send-failure" ? { uncloneable: () => {} } : {}),
				});
				return await response.promise;
			} catch (error) {
				primary = error;
				throw error;
			} finally {
				try {
					await cleanup();
				} catch (error) {
					throw new AggregateError(
						primary === undefined ? [error] : [primary, error],
						"Raw SQLite worker result and cleanup failed; exact worker remains tracked.",
					);
				}
			}
		},
		arm: async mode => {
			if (!worker) throw new Error("Capacity fault worker has not opened");
			const current = worker;
			const id = crypto.randomUUID();
			const armed = Promise.withResolvers<void>();
			pendingArms.set(id, armed.resolve);
			current.postMessage({ kind: "capacity-fault", mode, id });
			await armed.promise;
			// Arm before any later request so its first successful real response loses its ACK.
			if (mode === "lost-ack") lostAckArmed = true;
		},
	};
}

async function clearingFaultAfter(
	fault: { readonly arm: (mode: string) => Promise<void> },
	run: () => Promise<void>,
): Promise<void> {
	let primary: unknown;
	let failed = false;
	try {
		await run();
	} catch (error) {
		primary = error;
		failed = true;
	}
	if (!failed) return;
	try {
		await fault.arm("clear");
	} catch (cleanup) {
		throw new AggregateError([primary, cleanup], "Capacity test failed and its fault could not be cleared");
	}
	throw primary;
}

function nestedErrorMessages(value: unknown): string[] {
	const pending = [value];
	const visited = new Set<object>();
	const messages: string[] = [];
	while (pending.length) {
		const current = pending.pop();
		if (current === null || typeof current !== "object" || visited.has(current)) continue;
		visited.add(current);
		const record = current as Record<string, unknown>;
		if (typeof record.message === "string") messages.push(record.message);
		for (const key of ["cause", "errors", "constructionError", "cleanupErrors"]) {
			const nested = record[key];
			if (Array.isArray(nested)) pending.push(...nested);
			else if (nested !== undefined) pending.push(nested);
		}
	}
	return messages;
}

it("distinguishes the fresh 0/0 SQLite header from an existing supported 4/1 store", async () => {
	const firstFault = faultWorker();
	const opened = await openLiveAuthority("sqlite", os.tmpdir(), firstFault.factory);
	const identity = opened.client.identity;
	expect(firstFault.headers).toHaveLength(1);
	expect(firstFault.headers[0]).toEqual({
		pageSize: 4_096,
		reservedBytes: 0,
		schemaFormat: 0,
		encoding: 0,
		applicationId: 0,
		userVersion: 0,
		configuredBeforeApplicationRead: true,
		liveCapacityConfigured: true,
	});
	await opened.client.close();
	const ownership = await acquireAuthorityOwnership(path.join(opened.directory, "session.jsonl"), {
		owningSessionId: opened.sessionId,
		create: false,
	});
	const secondFault = faultWorker();
	const reopened = await openAuthorityClient(
		{ path: ownership.paths.sqlite, identity, create: false },
		ownership,
		secondFault.factory,
	);
	expect(secondFault.headers).toHaveLength(1);
	expect(secondFault.headers[0]).toMatchObject({
		pageSize: 4_096,
		reservedBytes: 0,
		schemaFormat: 4,
		encoding: 1,
		configuredBeforeApplicationRead: true,
		liveCapacityConfigured: true,
	});
	expect(secondFault.headers[0]!.applicationId).toBeGreaterThan(0);
	expect(secondFault.headers[0]!.userVersion).toBeGreaterThan(0);
	await reopened.close();
}, 45_000);

it("preserves raw offline SQLite construction for fresh and existing stores", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-capacity-raw-sqlite-"));
	directories.push(directory);
	const storePath = path.join(directory, "offline.sqlite");
	const identity = {
		backend: "sqlite" as const,
		owningSessionId: `capacity-offline-${crypto.randomUUID()}`,
		incarnation: crypto.randomUUID(),
		format: 2 as const,
	};
	const fault = faultWorker();
	const fresh = await fault.rawSqlite({ path: storePath, identity, create: true });
	expect(fresh.result).toMatchObject({ ok: true });
	expect(fault.headers[0]).toMatchObject({
		empty: true,
		configuredBeforeApplicationRead: true,
		liveCapacityConfigured: false,
	});
	const existing = await fault.rawSqlite({ path: storePath, identity, create: false });
	expect(existing.result).toMatchObject({ ok: true });
	expect(fault.headers[1]).toMatchObject({
		pageSize: 4_096,
		schemaFormat: 4,
		encoding: 1,
		configuredBeforeApplicationRead: true,
		liveCapacityConfigured: false,
	});
}, 45_000);

for (const mode of ["raw-send-failure", "raw-worker-error", "raw-worker-exit", "raw-no-response"] as const) {
	it(`cleans the exact raw SQLite worker after ${mode} without abandoning its response`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-capacity-raw-lifetime-"));
		directories.push(directory);
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: `raw-lifetime-${crypto.randomUUID()}`,
			incarnation: crypto.randomUUID(),
			format: 2 as const,
		};
		const before = rawWorkerCleanups.size;
		const failure = await faultWorker()
			.rawSqlite(
				{ path: path.join(directory, "offline.sqlite"), identity, create: true },
				mode,
				mode === "raw-no-response" ? 1_000 : 20_000,
			)
			.then(
				() => undefined,
				error => error,
			);
		expect(failure).toBeInstanceOf(Error);
		if (mode === "raw-send-failure") expect(String(failure)).toMatch(/clon/i);
		else
			expect(String(failure)).toContain(
				mode === "raw-worker-error"
					? "worker failed"
					: mode === "raw-worker-exit"
						? "exited before its result"
						: "deadline exceeded",
			);
		expect(rawWorkerCleanups.size).toBe(before);
		expect(await fs.readdir(directory)).toEqual([]);
	}, 45_000);
}

it("rejects a truncated existing raw SQLite header", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-capacity-truncated-"));
	directories.push(directory);
	const storePath = path.join(directory, "offline.sqlite");
	await fs.writeFile(storePath, "SQLite format 3\0", { mode: 0o600 });
	const identity = {
		backend: "sqlite" as const,
		owningSessionId: `truncated-${crypto.randomUUID()}`,
		incarnation: crypto.randomUUID(),
		format: 2 as const,
	};
	const before = await fs.stat(storePath, { bigint: true });
	const fault = faultWorker();
	const response = await fault.rawSqlite({ path: storePath, identity, create: false });
	expect(response.result).toMatchObject({ ok: false, cleanupFailures: [] });
	const messages = nestedErrorMessages((response.result as Record<string, unknown>).error);
	expect(
		messages.some(
			message =>
				message === "file is not a database" ||
				message === "Selected SQLite authority store has an invalid native header.",
		),
	).toBe(true);
	expect(fault.events.filter(event => event.event === "sqlite-database-close")).toMatchObject([
		{ force: true, nativeCloseCompleted: true },
	]);
	const after = await fs.stat(storePath, { bigint: true });
	expect([after.dev, after.ino, after.size]).toEqual([before.dev, before.ino, before.size]);
	expect(await fs.readFile(storePath)).toEqual(Buffer.from("SQLite format 3\0"));
	expect(await fs.readdir(directory)).toEqual(["offline.sqlite"]);
}, 45_000);

for (const mode of ["raw-bootstrap-fd-dual", "raw-header-fd-dual"] as const) {
	it(`retains exact ${mode} construction cleanup with both causes and the same admission`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-capacity-raw-fd-"));
		directories.push(directory);
		const capacity = await openAuthorityCapacityFile(directory);
		ballastHandles.push(capacity.handle);
		const storePath = path.join(directory, `${mode}.sqlite`);
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: `capacity-raw-${crypto.randomUUID()}`,
			incarnation: crypto.randomUUID(),
			format: 2 as const,
		};
		const fault = faultWorker();
		const response = await fault.rawSqlite(
			{
				path: storePath,
				identity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: AUTHORITY_RESOURCE_CAPS.maxRequestBytes },
			},
			mode,
		);
		const result = response.result as Record<string, unknown>;
		expect(result.ok).toBe(false);
		expect(result.error).toMatchObject({ name: "SqliteAuthorityConstructionError" });
		expect(result.cleanupFailures).toEqual([]);
		expect(result.cleanupSucceeded).toBe(true);
		expect(result.cleanupAttempts).toBe(1);
		expect(response.rawCloseAttempts).toBe(1);
		expect(response.rawDescriptorClosed).toBe(true);
		expect(response.rawReplacementVerified).toBe(true);
		expect(response.rawReplacementClosed).toBe(true);
		expect(response.rawReplacementIdentity).toEqual(response.rawDescriptor);
		const rawClose = fault.events.find(event => event.event === "raw-descriptor-close-failure");
		expect(rawClose).toMatchObject({
			nativeCloseCompleted: true,
			replacementStartByte: mode === "raw-bootstrap-fd-dual" ? undefined : 0x53,
		});
		expect(rawClose?.replacement).toEqual(response.rawDescriptor);
		expect(fault.events.some(event => event.event === "raw-replacement-verification-error")).toBe(false);
		const messages = nestedErrorMessages(result.error);
		expect(messages).toContain(
			mode === "raw-bootstrap-fd-dual"
				? "injected SQLite raw descriptor fchmod primary failure"
				: "injected SQLite header descriptor read primary failure after actual read",
		);
		expect(messages).toContain("injected SQLite raw descriptor close response failure after actual native close");
		const admissionIds = response.prepareCloseIds as number[];
		expect(admissionIds.length).toBeGreaterThanOrEqual(2);
		expect(new Set(admissionIds).size).toBe(1);
		await expect(fs.lstat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
	}, 45_000);
}

describe("live authority capacity worker integration", () => {
	for (const backend of ["jsonl", "sqlite"] as const) {
		if (backend === "jsonl") {
			for (const sameInode of [false, true]) {
				it(`does not replay a consumed JSONL successful-append close descriptor after same-number ${sameInode ? "same-inode" : "different-inode"} reuse`, async () => {
					const fault = faultWorker();
					const { client, directory, sessionId } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
					const operation = {
						kind: "operation" as const,
						at: Date.now(),
						ownerId: "owner",
						classOwnerId: "owner",
						operationId: "append-close-aba",
						effectClass: "filesystem" as const,
						acquiredAt: 1,
						expiresAt: Number.MAX_SAFE_INTEGER,
						phase: "intent" as const,
					};
					const requestId = `append-close-${crypto.randomUUID()}`;
					await fault.arm(sameInode ? "append-close-aba-same" : "append-close-aba-other");
					expect(thrownBy(await settle(client.transition(operation, { requestId })))).toThrow(
						"commit outcome is unknown",
					);
					const failure = fault.events.find(event => event.event === "jsonl-append-error");
					expect(nestedErrorMessages(failure?.error)).toContain(
						"injected successful JSONL append close error after consumed descriptor reuse",
					);
					const reused = fault.events.find(event => event.event === "jsonl-append-close-aba");
					expect(reused).toMatchObject({ nativeCloseCompleted: true, sameNumber: true, sameInode });
					await fault.arm("verify-append-close-aba");
					expect(fault.events.find(event => event.event === "jsonl-append-close-aba-verified")).toMatchObject({
						identityPreserved: true,
						offsetPreserved: true,
						closed: true,
					});
					expect(fault.events.some(event => event.event === "jsonl-append-close-aba-replayed")).toBe(false);
					await client.close();
					const ownership = await acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
						owningSessionId: sessionId,
						create: false,
					});
					const reopened = await openAuthorityClient(
						{ path: ownership.paths.jsonl, identity: client.identity, create: false },
						ownership,
					);
					expect(
						(await reopened.exportState()).frames.filter(frame => frame.request.requestId === requestId),
					).toHaveLength(1);
					expect(
						(await reopened.getOperation(operation.ownerId, operation.effectClass, operation.operationId))?.record
							.phase,
					).toBe("intent");
				}, 45_000);
			}
			for (const mode of ["post-fsync", "post-readback", "dual-failure"] as const) {
				it(`preserves ${mode} JSONL commit uncertainty after the actual append boundary`, async () => {
					const fault = faultWorker();
					const { client, directory, sessionId } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
					const operation = {
						kind: "operation" as const,
						at: Date.now(),
						ownerId: "owner",
						classOwnerId: "owner",
						operationId: mode,
						effectClass: "filesystem" as const,
						acquiredAt: 1,
						expiresAt: Number.MAX_SAFE_INTEGER,
						phase: "intent" as const,
					};
					const requestId = `jsonl-${mode}-${crypto.randomUUID()}`;
					await fault.arm(mode);
					expect(thrownBy(await settle(client.transition(operation, { requestId })))).toThrow(
						"commit outcome is unknown",
					);
					if (mode === "dual-failure") {
						const appendFailure = fault.events.find(event => event.event === "jsonl-append-error");
						expect(appendFailure).toBeDefined();
						const messages = nestedErrorMessages(appendFailure?.error);
						expect(messages).toContain("injected JSONL append primary failure after real fsync");
						expect(messages).toContain("injected JSONL append descriptor cleanup failure after native close");
						expect(fault.events.find(event => event.event === "jsonl-descriptor-close-failure")).toMatchObject({
							nativeCloseCompleted: true,
						});
					}
					await client.close();
					expect(fault.prepareCloseCalls.length).toBeGreaterThan(0);
					const ownership = await acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
						owningSessionId: sessionId,
						create: false,
					});
					const reopened = await openAuthorityClient(
						{ path: ownership.paths.jsonl, identity: client.identity, create: false },
						ownership,
					);
					const state = await reopened.exportState();
					expect(state.frames.filter(frame => frame.request.requestId === requestId)).toHaveLength(1);
					expect(
						(await reopened.getOperation(operation.ownerId, operation.effectClass, operation.operationId))?.record
							.phase,
					).toBe("intent");
				}, 45_000);
			}
		}
		if (backend === "sqlite") {
			for (const mode of [
				"target-partial-allocation",
				"target-sync",
				"target-readback",
				"target-dual-failure",
			] as const) {
				it(`preserves the real SQLite ${mode} funding failure and retained descriptor cleanup`, async () => {
					const fault = faultWorker();
					const { client } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
					const base = {
						kind: "operation" as const,
						at: Date.now(),
						ownerId: "target-owner",
						classOwnerId: "target-owner",
						operationId: `target-${mode}-base`,
						effectClass: "filesystem" as const,
						acquiredAt: 1,
						expiresAt: Number.MAX_SAFE_INTEGER,
						phase: "intent" as const,
					};
					await client.transition(base);
					const before = await client.exportState();
					await fault.arm(mode);
					const additions = Array.from({ length: 100 }, (_, index) => ({
						...base,
						operationId: `target-${mode}-${index}`,
					}));
					expect(
						thrownBy(await settle(client.transitionBatch(additions, { requestId: `target-fault-${mode}` }))),
					).toThrow();
					const after = await client.exportState();
					expect([after.revision, after.headHash, after.frames.length]).toEqual([
						before.revision,
						before.headHash,
						before.frames.length,
					]);
					const failureEventName =
						mode === "target-partial-allocation"
							? "target-partial-allocation-failure"
							: mode === "target-sync"
								? "target-sync-failure"
								: mode === "target-readback"
									? "target-readback-failure"
									: "target-primary-sync-failure";
					const physicalFailure = fault.events.find(event => event.event === failureEventName);
					expect(physicalFailure).toBeDefined();
					if (mode === "target-partial-allocation")
						expect(physicalFailure).toMatchObject({ completedNativeChunks: 2, nativeSyncCalled: false });
					if (mode === "target-sync")
						expect(physicalFailure).toMatchObject({ allocationCompleted: true, nativeSyncCalled: false });
					if (mode === "target-readback") expect(physicalFailure).toMatchObject({ readbackCompleted: true });
					if (mode === "target-dual-failure") {
						expect(physicalFailure).toMatchObject({ allocationCompleted: true, nativeSyncCalled: true });
						const cleanupFailure = fault.events.find(event => event.event === "target-descriptor-close-failure");
						expect(cleanupFailure).toMatchObject({ nativeCloseCompleted: true });
						const prepareFailure = fault.events.find(event => event.event === "capacity-prepare-error");
						const messages = nestedErrorMessages(prepareFailure?.error);
						expect(messages).toContain("injected SQLite target sync primary failure after real target sync");
						expect(messages).toContain("injected SQLite target descriptor cleanup failure");
					}
					await client.close();
					expect(fault.prepareCloseCalls.length).toBeGreaterThan(0);
					expect(new Set(fault.prepareCloseCalls).size).toBe(1);
				}, 45_000);
			}
			it("retries SQLite statement finalization before the real force-close and keeps its known close frame singular", async () => {
				const fault = faultWorker();
				const { client, directory, sessionId } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
				const identity = fault.capacities[0]!;
				const owner = (await client.recoveryState()).owner;
				await fault.arm("sqlite-close-retry");
				expect(thrownBy(await settle(client.close()))).toThrow("injected statement finalization failure");
				expect(fault.sqliteCloseCalls).toHaveLength(0);
				const retained = await fs.stat(`/proc/self/fd/${identity.fd}`, { bigint: true });
				expect([retained.dev, retained.ino]).toEqual([identity.device, identity.inode]);
				await client.close();
				expect(fault.sqliteCloseCalls).toEqual([true]);
				expect(fault.events.find(event => event.event === "sqlite-database-close")).toMatchObject({
					force: true,
					nativeCloseCalled: true,
					nativeCloseCompleted: true,
				});
				const finalizeFailure = fault.events.find(event => event.event === "statement-finalize-failure");
				const finalizeRetry = fault.events.find(event => event.event === "statement-finalize-retry");
				expect(finalizeFailure).toBeDefined();
				expect(finalizeRetry).toMatchObject({
					nativeFinalization: true,
					statementId: finalizeFailure?.statementId,
				});
				await expect(fs.stat(`/proc/self/fd/${identity.fd}`)).rejects.toThrow();
				const ownership = await acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
					owningSessionId: sessionId,
					create: false,
				});
				const reopened = await openAuthorityClient(
					{ path: ownership.paths.sqlite, identity: client.identity, create: false },
					ownership,
				);
				const closed = (await reopened.exportState()).frames.filter(
					frame =>
						frame.command.kind === "owner" &&
						frame.command.owner.phase === "closed" &&
						frame.request.ownerEpoch === owner.epoch,
				);
				expect(closed).toHaveLength(1);
			}, 45_000);
			it("retains the same SQLite database after actual sqlite3_close returns BUSY and retries Bun close(true) without another owner frame", async () => {
				const extension = await compileNativeCloseObstruction();
				const fault = faultWorker(undefined, extension);
				const { client, directory, sessionId } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
				const identity = fault.capacities[0]!;
				const owner = (await client.recoveryState()).owner;
				await fault.arm("sqlite-native-close-retry");
				expect(thrownBy(await settle(client.close()))).toThrow("actual sqlite3_close returned SQLITE_BUSY (5)");
				const failed = fault.events.find(event => event.event === "sqlite-native-close-failure");
				expect(failed).toMatchObject({
					force: true,
					nativeCloseApi: "sqlite3_close",
					nativeCloseCode: 5,
					underlyingNativeCloseAttempted: true,
					bunCloseCalled: false,
					nativeCloseCompleted: false,
					connectionUsable: true,
					alive: 37,
				});
				expect(fault.sqliteCloseCalls).toEqual([]);
				expect(fault.events.filter(event => event.event === "sqlite-native-close-failure")).toHaveLength(1);
				const retained = await fs.stat(`/proc/self/fd/${identity.fd}`, { bigint: true });
				expect([retained.dev, retained.ino, retained.nlink]).toEqual([identity.device, identity.inode, 0n]);
				const retainedPool = BorrowedAuthorityCapacityPool.open(identity);
				const capacity = retainedPool.inspect();
				expect([capacity.device, capacity.inode]).toEqual([identity.device, identity.inode]);
				expect(capacity.allocatedBytes).toBeGreaterThanOrEqual(capacity.dataBytes);
				await expect(
					acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
						owningSessionId: sessionId,
						create: false,
					}),
				).rejects.toThrow();
				await client.close();
				expect(fault.capacities).toHaveLength(1);
				expect(fault.sqliteCloseCalls).toEqual([true]);
				expect(
					fault.events.find(event => event.event === "sqlite-native-close-obstruction-released"),
				).toMatchObject({
					databaseId: failed?.databaseId,
					nativeFinalizeCode: 0,
					unsafeNativeCloseGuardCode: 21,
					connectionUsable: true,
				});
				const completed = fault.events.find(event => event.event === "sqlite-native-close-retry");
				expect(completed).toMatchObject({
					force: true,
					databaseId: failed?.databaseId,
					sameDatabase: true,
					bunCloseCalled: true,
					nativeCloseCompleted: true,
				});
				expect(fault.events.find(event => event.event === "sqlite-native-close-extension-unloaded")).toMatchObject({
					afterBunClose: true,
				});
				const closeEvents = [
					"sqlite-native-close-failure",
					"sqlite-native-close-obstruction-released",
					"sqlite-database-close",
					"sqlite-native-close-retry",
					"sqlite-native-close-extension-unloaded",
				];
				expect(
					fault.events.filter(event => closeEvents.includes(String(event.event))).map(event => event.event),
				).toEqual(closeEvents);
				await expect(fs.stat(`/proc/self/fd/${identity.fd}`)).rejects.toThrow();
				expect(() => retainedPool.inspect()).toThrow();
				const ownership = await acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
					owningSessionId: sessionId,
					create: false,
				});
				const reopened = await openAuthorityClient(
					{ path: ownership.paths.sqlite, identity: client.identity, create: false },
					ownership,
				);
				expect(
					(await reopened.exportState()).frames.filter(
						frame =>
							frame.command.kind === "owner" &&
							frame.command.owner.phase === "closed" &&
							frame.request.ownerEpoch === owner.epoch,
					),
				).toHaveLength(1);
			}, 45_000);
		}
		it(`keeps bounded ${backend} state and receipt oracles reachable after maximum request IDs exceed the public export budget`, async () => {
			const { client } = await openLiveAuthority(backend);
			const initial = await client.recoveryState();
			const operation = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "bounded-owner",
				classOwnerId: "bounded-owner",
				operationId: "bounded-0",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			const admitted = [];
			for (let index = 0; index < 2; index++) {
				const record = { ...operation, operationId: `bounded-${index}` };
				const options = await legalMaximumOptions(client, "transition", [record]);
				expect(options.requestId!.length).toBeGreaterThan(1_000_000);
				admitted.push({ record, receipt: await client.transition(record, options) });
			}
			const before = await readCapacityState(client);
			expect(before.recovery.revision).toBe(initial.revision + admitted.length);
			expect(thrownBy(await settle(client.exportState()))).toThrow(
				`Authority response exceeds ${AUTHORITY_RESOURCE_CAPS.maxResponseBytes} bytes`,
			);
			expect(await readCapacityState(client)).toEqual(before);
			for (const { record, receipt } of admitted) {
				expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
				expect(await client.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
					version: 1,
					record,
				});
				const cancelled = { ...record, phase: "cancelled" as const };
				const completion = await client.transition(
					cancelled,
					await legalMaximumContinuation(client, "transition", [cancelled]),
				);
				expect(await client.resolveReceipt(completion.requestId, completion.ownerEpoch)).toEqual(completion);
				expect(await client.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
					version: 2,
					record: cancelled,
				});
			}
			expect((await client.recoveryState()).revision).toBe(initial.revision + 2 * admitted.length);
			expect(await client.listOpen("operation")).toEqual({ rows: [] });
		}, 45_000);
		it(`honors complete escaped expectation and request envelopes through the real ${backend} effect boundary`, async () => {
			const { client, directory } = await openLiveAuthority(backend);
			const operation = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "owner",
				classOwnerId: "owner",
				operationId: "maximum-options",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			await client.transition(operation);
			const effect = { ...operation, phase: "effect" as const };
			const options = await legalMaximumContinuation(client, "transition", [effect], "expected");
			await withAuthorityEffect(client, async () => {
				await client.transition(effect, options);
				await fs.writeFile(path.join(directory, "maximum-effect"), "authorized", { mode: 0o600 });
			});
			const committed = { ...operation, phase: "committed" as const };
			await client.transition(committed, await legalMaximumContinuation(client, "transition", [committed]));
			const completed = { ...operation, phase: "completed" as const };
			await client.transition(
				completed,
				await legalMaximumContinuation(client, "transition", [completed], "expected"),
			);
			expect(await fs.readFile(path.join(directory, "maximum-effect"), "utf8")).toBe("authorized");
			expect(
				(await client.getOperation(operation.ownerId, operation.effectClass, operation.operationId))?.record.phase,
			).toBe("completed");
			const state = await client.exportState();
			expect(state.frames.find(frame => frame.request.requestId === options.requestId)?.expected).toContainEqual(
				options.expected![0],
			);
		}, 45_000);
		for (const action of ["commit", "restore-predecessor"] as const) {
			it(`rearms funded ${backend} local uncertainty and ${action} under held real ${pressureBudget(backend) / (1024 * 1024)}MiB pressure`, async () => {
				const opened = await openLiveAuthority(backend, await pressureRoot(backend));
				const { directory, sessionId } = opened;
				let client = opened.client;
				const bytes = Buffer.from("real approved local publication");
				const entryHash = createHash("sha256").update(bytes).digest("hex");
				const input = { localId: "local", entryId: "entry", entryHash, expectedHeadHash: "0".repeat(64) };
				const claim = await client.reserveLocal(input, await legalMaximumOptions(client, "reserveLocal", [input]));
				const effect = { ...claim, phase: "effect" as const };
				const backing = path.join(directory, "local-backing");
				await withAuthorityEffect(client, async () => {
					await client.authorizeLocalEffect(
						claim,
						await legalMaximumContinuation(client, "authorizeLocalEffect", [claim]),
					);
					const handle = await fs.open(backing, "wx", 0o600);
					try {
						await handle.writeFile(bytes);
						await handle.sync();
					} finally {
						await handle.close();
					}
				});
				const ballast = await exhaustUnpromisedSpace(directory, pressureBudget(backend));
				const beforeUncertain = await readCapacityState(client);
				const entryBefore = await client.getLocalEntry(claim.localId, claim.entryId, claim.version);
				const headBefore = await client.getLocalHead(claim.localId);
				const options = await legalMaximumContinuation(client, "finalizeLocal", [effect, "uncertain"]);
				const publication = await client.finalizeLocal(effect, "uncertain", options);
				expect(publication).toEqual({ version: claim.version, headHash: claim.headHash });
				const uncertain = await readCapacityState(client);
				expect(uncertain).toEqual({
					...beforeUncertain,
					recovery: { ...beforeUncertain.recovery, revision: beforeUncertain.recovery.revision + 1 },
				});
				expect(entryBefore?.record.phase).toBe("effect");
				expect(await client.getLocalEntry(claim.localId, claim.entryId, claim.version)).toEqual(entryBefore);
				expect(await client.getLocalHead(claim.localId)).toEqual(headBefore);
				const uncertainReceipt = await client.resolveReceipt(
					options.requestId!,
					beforeUncertain.recovery.owner.epoch,
				);
				expect(uncertainReceipt).toMatchObject({
					requestId: options.requestId,
					ownerEpoch: beforeUncertain.recovery.owner.epoch,
					incarnation: client.identity.incarnation,
					commandKind: "finalize-local",
					revision: beforeUncertain.recovery.revision + 1,
					result: { kind: "local-publication", publication },
				});
				const identity = client.identity;
				await client.close();
				client = (await reopenFundedOrRefused(backend, directory, sessionId, identity, ballast)).client;
				expect(await client.resolveReceipt(options.requestId!, beforeUncertain.recovery.owner.epoch)).toEqual(
					uncertainReceipt,
				);
				if (action === "restore-predecessor") await fs.unlink(backing);
				const reconciliation = {
					claim: { ...claim, phase: "uncertain" as const },
					action,
					observedEntryHash: action === "commit" ? entryHash : "0".repeat(64),
				};
				const receipt = await client.reconcileLocal(
					reconciliation,
					await legalMaximumContinuation(client, "reconcileLocal", [reconciliation]),
				);
				expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
				expect((await client.getLocalEntry(claim.localId, claim.entryId, claim.version))?.record.phase).toBe(
					action === "commit" ? "committed" : "cancelled",
				);
				if (action === "commit") {
					expect(await fs.readFile(backing)).toEqual(bytes);
					expect((await client.getLocalHead(claim.localId))?.record.headHash).toBe(claim.headHash);
					expect(receipt.result).toEqual({ kind: "local-publication", publication });
				} else {
					expect(await client.getLocalHead(claim.localId)).toBeUndefined();
					expect(receipt.result).toEqual({ kind: "mutation" });
				}
			}, 45_000);
		}
		it(`opens, funds, and completes a staged six-step root transition through the real ${backend} worker`, async () => {
			const { client, sessionId } = await openLiveAuthority(backend);
			await exerciseSixStepRootTransition(client, sessionId, undefined, true);
			const rootId = `root-${sessionId}`;
			const root = (await client.getRoot(rootId))!.record;
			const actor = (await client.getActor(rootId))!.record;
			const retiredRoot = { ...root, state: "retired" as const };
			const retiredActor = { ...actor, state: "retired" as const };
			await client.transition(retiredRoot, await legalMaximumContinuation(client, "transition", [retiredRoot]));
			await client.transition(retiredActor, await legalMaximumContinuation(client, "transition", [retiredActor]));
			expect((await client.getRoot(rootId))?.record.state).toBe("retired");
			expect((await client.getActor(rootId))?.record.state).toBe("retired");
		}, 45_000);
		for (let cut = 0; cut < 6; cut++) {
			it(`preserves all six funded future commands after real ${pressureBudget(backend) / (1024 * 1024)}MiB ${backend} pressure at cut ${cut}`, async () => {
				const { client, sessionId, directory } = await openLiveAuthority(backend, await pressureRoot(backend));
				await exerciseSixStepRootTransition(
					client,
					sessionId,
					async step => {
						if (step === cut) await exhaustUnpromisedSpace(directory, pressureBudget(backend));
					},
					true,
					true,
				);
			}, 45_000);
		}

		it(`keeps the genuine 64MiB ${backend} refusal assignment effect-free while retaining a funded disposition`, async () => {
			const { client, directory } = await openLiveAuthority(backend, await pressureRoot(backend, "refusal"));
			const operation = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "refusal-owner",
				classOwnerId: "refusal-owner",
				operationId: "funded-disposition",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			await client.transition(operation);
			await exhaustUnpromisedSpace(directory, pressureBudget(backend, "refusal"));
			const before = await client.exportState();
			let callbacks = 0;
			expect(
				thrownBy(
					await settle(
						withAuthorityEffect(client, async () => {
							await client.transitionBatch(
								Array.from({ length: 100 }, (_, index) => ({ ...operation, operationId: `unfunded-${index}` })),
							);
							callbacks++;
							await fs.writeFile(path.join(directory, "forbidden-effect"), "not authorized");
						}),
					),
				),
			).toThrow();
			const after = await client.exportState();
			expect([after.revision, after.headHash, after.frames.length]).toEqual([
				before.revision,
				before.headHash,
				before.frames.length,
			]);
			expect(callbacks).toBe(0);
			await expect(fs.lstat(path.join(directory, "forbidden-effect"))).rejects.toMatchObject({ code: "ENOENT" });
			const cancelled = { ...operation, phase: "cancelled" as const };
			await client.transition(cancelled, await legalMaximumContinuation(client, "transition", [cancelled]));
			expect(
				(await client.getOperation(operation.ownerId, operation.effectClass, operation.operationId))?.record.phase,
			).toBe("cancelled");
		}, 45_000);

		it(`independently consumes every maximum-option ${backend} gate/root/actor promise under held positive pressure and closed NEW admission`, async () => {
			const fault = faultWorker();
			const { client, directory, sessionId } = await openLiveAuthority(
				backend,
				await pressureRoot(backend),
				fault.factory,
			);
			const activation = await activateCapacityRoot(client, `independent-gate-${sessionId}`);
			await exhaustUnpromisedSpace(directory, pressureBudget(backend));
			await fault.arm("admission-gate");
			const operation = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "owner",
				classOwnerId: "owner",
				operationId: "independent-gate-new",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			expect(
				thrownBy(
					await settle(
						client.transitionBatch(
							Array.from({ length: 100 }, (_, index) => ({
								...operation,
								operationId: `gate-refused-${index}`,
							})),
						),
					),
				),
			).toThrow();
			expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
			await consumeCapacityRootPromises(client, activation);
			expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
		}, 45_000);

		for (const cut of ["staged", "quiescing", "quiesced", "validated"] as const) {
			it(`consumes constrained pre-CAS ${backend} recovery from ${cut} and reopened gate promises under held pressure with NEW closed`, async () => {
				const fault = faultWorker();
				const { client, directory, sessionId } = await openLiveAuthority(
					backend,
					await pressureRoot(backend),
					fault.factory,
				);
				const activation = await activateCapacityRoot(client, `recover-transition-${sessionId}`);
				for (const phase of ["quiescing", "quiesced"] as const)
					await client.transition({ ...activation.gate, phase });
				const transition = {
					kind: "transition" as const,
					at: Date.now(),
					rootId: activation.root.rootId,
					transitionId: "recover-pre-cas",
					sourceGeneration: 1,
					destinationGeneration: 2,
					sourceHeadHash: activation.root.headHash,
					destinationHeadHash: canonicalDurableSha256("unused-destination"),
					phase: "staged" as const,
				};
				for (const phase of ["staged", "quiescing", "quiesced", "validated"] as const) {
					await client.transition({ ...transition, phase });
					if (phase === cut) break;
				}
				await exhaustUnpromisedSpace(directory, pressureBudget(backend));
				await fault.arm("admission-gate");
				const operation = {
					kind: "operation" as const,
					at: Date.now(),
					ownerId: "owner",
					classOwnerId: "owner",
					operationId: "recovery-new",
					effectClass: "filesystem" as const,
					acquiredAt: 1,
					expiresAt: Number.MAX_SAFE_INTEGER,
					phase: "intent" as const,
				};
				expect(
					thrownBy(
						await settle(
							client.transitionBatch(
								Array.from({ length: 100 }, (_, index) => ({
									...operation,
									operationId: `recovery-refused-${index}`,
								})),
							),
						),
					),
				).toThrow();
				expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
				const recovery = {
					transition: { ...transition, phase: "recovered" as const, recovery: true as const },
					expectedRootGeneration: 1,
					expectedRootHeadHash: activation.root.headHash,
					root: activation.root,
					gate: activation.gate,
				};
				const receipt = await client.commitRootTransition(
					recovery,
					await legalMaximumContinuation(client, "commitRootTransition", [recovery]),
				);
				expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
				expect((await client.getTransition(activation.root.rootId, transition.transitionId))?.record).toEqual(
					recovery.transition,
				);
				expect((await client.getRoot(activation.root.rootId))?.record).toEqual(activation.root);
				expect((await client.getGate(activation.root.rootId))?.record).toEqual(activation.gate);
				expect((await client.exportState()).generationHighWater).toBe(2);
				await consumeCapacityRootPromises(client, activation);
				expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
			}, 45_000);
		}

		it(`reactivates recovered ${backend} root evidence with maximum options and consumes downstream promises under held pressure with NEW closed`, async () => {
			const opened = await openLiveAuthority(backend, await pressureRoot(backend));
			const activation = await activateCapacityRoot(opened.client, `recovered-root-${opened.sessionId}`);
			const rootBefore = await opened.client.getRoot(activation.root.rootId);
			const constructionBefore = await opened.client.getConstruction(
				activation.root.rootId,
				activation.actor.actorId,
				1,
			);
			const ballast = await exhaustUnpromisedSpace(opened.directory, pressureBudget(backend));
			await opened.client.close();
			const fault = faultWorker();
			const { client } = await reopenFundedOrRefused(
				backend,
				opened.directory,
				opened.sessionId,
				opened.client.identity,
				ballast,
				fault.factory,
			);
			expect((await client.recoveryState()).owner.phase).toBe("ready");
			expect((await client.getGate(activation.root.rootId))?.record.phase).toBe("closed");
			await fault.arm("admission-gate");
			const operation = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "owner",
				classOwnerId: "owner",
				operationId: "recovered-root-new",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			expect(
				thrownBy(
					await settle(
						client.transitionBatch(
							Array.from({ length: 100 }, (_, index) => ({
								...operation,
								operationId: `revival-refused-${index}`,
							})),
						),
					),
				),
			).toThrow();
			expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
			const revival = {
				actor: { ...activation.actor, at: Date.now() },
				construction: constructionBefore!.record,
				gate: { ...activation.gate, at: Date.now() },
			};
			const receipt = await client.activateAuthority(
				revival,
				await legalMaximumContinuation(client, "activateAuthority", [revival]),
			);
			expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
			expect(await client.getRoot(activation.root.rootId)).toEqual(rootBefore);
			expect(await client.getConstruction(activation.root.rootId, activation.actor.actorId, 1)).toEqual(
				constructionBefore,
			);
			expect((await client.getActor(activation.actor.actorId))?.record).toEqual(revival.actor);
			expect((await client.getGate(activation.root.rootId))?.record).toEqual(revival.gate);
			await consumeCapacityRootPromises(client, { root: activation.root, actor: revival.actor, gate: revival.gate });
			expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
		}, 45_000);

		it(`refuses an unfunded admission without a frame or callback and preserves funded ${backend} completion/disposition on its positive budget`, async () => {
			const { client, directory } = await openLiveAuthority(backend, await pressureRoot(backend, "positive"));
			const base = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "capacity-owner",
				classOwnerId: "capacity-owner",
				operationId: "funded",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			const intentReceipt = await client.transition(base);
			const effect = { ...base, phase: "effect" as const };
			const effectReceipt = await withAuthorityEffect(client, async () => {
				const receipt = await client.transition(effect);
				await fs.writeFile(path.join(directory, "real-effect"), "completed callback");
				return receipt;
			});
			const disposition = { ...base, operationId: "disposition" };
			const dispositionReceipt = await client.transition(disposition);
			const resource = {
				kind: "resource" as const,
				at: Date.now(),
				actorId: "resource-actor",
				generation: 1,
				resourceId: "funded-resource",
				resourceClass: "filesystem" as const,
				operationId: "resource-operation",
				targetHash: canonicalDurableSha256("funded-resource"),
				phase: "intent" as const,
			};
			const resourceIntentReceipt = await client.transition(
				resource,
				await legalMaximumOptions(client, "transition", [resource]),
			);
			const resourceEffect = { ...resource, phase: "effect" as const };
			const resourceEffectReceipt = await withAuthorityEffect(client, async () => {
				const receipt = await client.transition(
					resourceEffect,
					await legalMaximumContinuation(client, "transition", [resourceEffect]),
				);
				await fs.writeFile(path.join(directory, "resource-effect"), "resource completed");
				return receipt;
			});
			await exhaustUnpromisedSpace(directory, pressureBudget(backend, "positive"));
			const before = await readCapacityState(client);
			let callback = false;
			const refusedRequestId = `unfunded-${crypto.randomUUID()}`;
			const unfunded = Array.from({ length: 100 }, (_, index) => ({ ...base, operationId: `unfunded-${index}` }));
			expect(
				thrownBy(
					await settle(
						withAuthorityEffect(client, async () => {
							await client.transitionBatch(unfunded, { requestId: refusedRequestId });
							callback = true;
							await fs.writeFile(path.join(directory, "forbidden-effect"), "not authorized");
						}),
					),
				),
			).toThrow();
			expect(callback).toBe(false);
			expect(await readCapacityState(client)).toEqual(before);
			expect(await client.resolveReceipt(refusedRequestId, before.recovery.owner.epoch)).toBeUndefined();
			expect(await client.getOperation(base.ownerId, base.effectClass, unfunded[0]!.operationId)).toBeUndefined();
			expect(
				await client.getOperation(base.ownerId, base.effectClass, unfunded.at(-1)!.operationId),
			).toBeUndefined();
			await expect(fs.lstat(path.join(directory, "forbidden-effect"))).rejects.toMatchObject({ code: "ENOENT" });
			for (const receipt of [
				intentReceipt,
				effectReceipt,
				dispositionReceipt,
				resourceIntentReceipt,
				resourceEffectReceipt,
			]) {
				expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
			}
			const committedOperation = { ...effect, phase: "committed" as const };
			const committedOperationReceipt = await client.transition(
				committedOperation,
				await legalMaximumContinuation(client, "transition", [committedOperation]),
			);
			expect(
				await client.resolveReceipt(committedOperationReceipt.requestId, committedOperationReceipt.ownerEpoch),
			).toEqual(committedOperationReceipt);
			expect(await client.getOperation(base.ownerId, base.effectClass, base.operationId)).toEqual({
				version: 3,
				record: committedOperation,
			});
			const completedOperation = { ...effect, phase: "completed" as const };
			const completedOperationReceipt = await client.transition(
				completedOperation,
				await legalMaximumContinuation(client, "transition", [completedOperation]),
			);
			expect(
				await client.resolveReceipt(completedOperationReceipt.requestId, completedOperationReceipt.ownerEpoch),
			).toEqual(completedOperationReceipt);
			const committedResource = { ...resource, phase: "committed" as const };
			const committedResourceReceipt = await client.transition(
				committedResource,
				await legalMaximumContinuation(client, "transition", [committedResource]),
			);
			expect(
				await client.resolveReceipt(committedResourceReceipt.requestId, committedResourceReceipt.ownerEpoch),
			).toEqual(committedResourceReceipt);
			expect(await client.getResource(resource.actorId, resource.generation, resource.resourceId)).toEqual({
				version: 3,
				record: committedResource,
			});
			const completedResource = { ...resource, phase: "completed" as const };
			const completedResourceReceipt = await client.transition(
				completedResource,
				await legalMaximumContinuation(client, "transition", [completedResource]),
			);
			expect(
				await client.resolveReceipt(completedResourceReceipt.requestId, completedResourceReceipt.ownerEpoch),
			).toEqual(completedResourceReceipt);
			expect(await client.getResource(resource.actorId, resource.generation, resource.resourceId)).toEqual({
				version: 4,
				record: completedResource,
			});
			expect(await fs.readFile(path.join(directory, "resource-effect"), "utf8")).toBe("resource completed");
			const cancelled = { ...disposition, phase: "cancelled" as const };
			const cancelledReceipt = await client.transition(cancelled);
			expect(await client.resolveReceipt(cancelledReceipt.requestId, cancelledReceipt.ownerEpoch)).toEqual(
				cancelledReceipt,
			);
			expect(await fs.readFile(path.join(directory, "real-effect"), "utf8")).toBe("completed callback");
			expect(await client.getOperation(base.ownerId, base.effectClass, base.operationId)).toEqual({
				version: 4,
				record: completedOperation,
			});
			expect(await client.getOperation(base.ownerId, base.effectClass, disposition.operationId)).toEqual({
				version: 2,
				record: cancelled,
			});
		}, 45_000);
		for (const mode of ["allocation", "reconciliation"] as const) {
			it(`preserves funded ${backend} disposition across ${mode} failure and rearms the same owner`, async () => {
				const fault = faultWorker();
				const { client } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
				const base = {
					kind: "operation" as const,
					at: Date.now(),
					ownerId: "owner",
					classOwnerId: "owner",
					operationId: "existing",
					effectClass: "filesystem" as const,
					acquiredAt: 1,
					expiresAt: Number.MAX_SAFE_INTEGER,
					phase: "intent" as const,
				};
				await client.transition(base);
				const before = await client.exportState();
				await fault.arm(mode);
				expect(
					thrownBy(
						await settle(
							client.transitionBatch(
								Array.from({ length: 100 }, (_, index) => ({ ...base, operationId: `new-${index}` })),
							),
						),
					),
				).toThrow();
				const refused = await client.exportState();
				expect([refused.revision, refused.headHash, refused.frames.length]).toEqual([
					before.revision,
					before.headHash,
					before.frames.length,
				]);
				await client.transition({ ...base, phase: "cancelled" });
				expect((await client.getOperation(base.ownerId, base.effectClass, base.operationId))?.record.phase).toBe(
					"cancelled",
				);
				await client.transition({ ...base, operationId: "rearmed" });
				expect((await client.getOperation(base.ownerId, base.effectClass, "rearmed"))?.record.phase).toBe("intent");
				await client.transition({ ...base, operationId: "rearmed", phase: "cancelled" });
			}, 45_000);
		}

		it(`preserves maximum-option ${backend} construction activation and every downstream promise while NEW remains closed`, async () => {
			const fault = faultWorker();
			const { client, directory } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
			const operation = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "owner",
				classOwnerId: "owner",
				operationId: "new",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			const abandonedConstruction = {
				kind: "construction" as const,
				at: Date.now(),
				rootId: "abandoned-construction",
				actorId: "abandoned-construction",
				generation: 1,
				startupHash: canonicalDurableSha256("abandoned-construction-startup"),
				provenanceHash: canonicalDurableSha256("abandoned-construction-provenance"),
				phase: "reserved" as const,
			};
			// A failed assertion must not leave admission-gate armed for the shared teardown close.
			await clearingFaultAfter(fault, async () => {
				const abandonedReservation = await client.transition(
					abandonedConstruction,
					await legalMaximumOptions(client, "transition", [abandonedConstruction]),
				);
				const activation = await activateCapacityRoot(
					client,
					"funded-construction-activation",
					true,
					async reservation => {
						await fault.arm("admission-gate");
						const before = await readCapacityState(client);
						for (const receipt of [abandonedReservation, reservation])
							expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
						const batchRequestId = `construction-batch-refused-${crypto.randomUUID()}`;
						const requestId = `construction-refused-${crypto.randomUUID()}`;
						let callbacks = 0;
						expect(
							thrownBy(
								await settle(
									withAuthorityEffect(client, async () => {
										await client.transitionBatch(
											Array.from({ length: 100 }, (_, index) => ({
												...operation,
												operationId: `construction-refused-${index}`,
											})),
											{ requestId: batchRequestId },
										);
										callbacks++;
										await fs.writeFile(
											path.join(directory, "forbidden-construction-effect"),
											"not authorized",
										);
									}),
								),
							),
						).toThrow();
						expect(
							thrownBy(
								await settle(
									withAuthorityEffect(client, async () => {
										await client.transition(operation, { requestId });
										callbacks++;
										await fs.writeFile(
											path.join(directory, "forbidden-construction-effect"),
											"not authorized",
										);
									}),
								),
							),
						).toThrow("NEW admission");
						expect(callbacks).toBe(0);
						expect(await readCapacityState(client)).toEqual(before);
						expect(await client.resolveReceipt(batchRequestId, before.recovery.owner.epoch)).toBeUndefined();
						expect(await client.resolveReceipt(requestId, before.recovery.owner.epoch)).toBeUndefined();
						expect(
							await client.getOperation(operation.ownerId, operation.effectClass, operation.operationId),
						).toBeUndefined();
						await expect(fs.lstat(path.join(directory, "forbidden-construction-effect"))).rejects.toMatchObject({
							code: "ENOENT",
						});
					},
				);
				expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
				for (const [index, phase] of (["constructing", "constructed", "abandoned"] as const).entries()) {
					const construction = { ...abandonedConstruction, phase };
					const receipt = await client.transition(
						construction,
						await legalMaximumContinuation(client, "transition", [construction]),
					);
					expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
					expect(await client.getConstruction(construction.rootId, construction.actorId, 1)).toEqual({
						version: index + 2,
						record: construction,
					});
				}
				await consumeCapacityRootPromises(client, activation);
				expect(thrownBy(await settle(client.transition(operation)))).toThrow("NEW admission");
				await fault.arm("clear");
				await client.transition(operation);
				await client.transition({ ...operation, phase: "cancelled" });
			});
		}, 45_000);

		it(`keeps a known ${backend} commit successful when optional refill and reconciliation fail`, async () => {
			const fault = faultWorker();
			const { client, directory } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
			const base = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "owner",
				classOwnerId: "owner",
				operationId: "known-commit",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			await client.transition(base);
			let effects = 0;
			await withAuthorityEffect(client, async () => {
				await client.transition({ ...base, phase: "effect" });
				effects++;
				await fs.writeFile(path.join(directory, "known-commit-effect"), "once");
			});
			await fault.arm("refill");
			const receipt = await client.transition(
				{ ...base, phase: "committed" },
				{ requestId: "known-commit-after-refill-failure" },
			);
			expect(await client.resolveReceipt(receipt.requestId, receipt.ownerEpoch)).toEqual(receipt);
			const refused = { ...base, operationId: "new-after-refill-failure" };
			const beforeRefusal = await client.exportState();
			expect(
				thrownBy(
					await settle(client.transition(refused, await legalMaximumOptions(client, "transition", [refused]))),
				),
			).toThrow("NEW admission");
			const afterRefusal = await client.exportState();
			expect([afterRefusal.revision, afterRefusal.headHash, afterRefusal.frames.length]).toEqual([
				beforeRefusal.revision,
				beforeRefusal.headHash,
				beforeRefusal.frames.length,
			]);
			const completed = { ...base, phase: "completed" as const };
			await client.transition(completed, await legalMaximumContinuation(client, "transition", [completed]));
			expect(thrownBy(await settle(client.transition(refused)))).toThrow("NEW admission");
			const state = await client.exportState();
			expect(state.frames.filter(frame => frame.request.requestId === receipt.requestId)).toHaveLength(1);
			expect(effects).toBe(1);
			expect(await fs.readFile(path.join(directory, "known-commit-effect"), "utf8")).toBe("once");
			expect((await client.getOperation(base.ownerId, base.effectClass, base.operationId))?.record.phase).toBe(
				"completed",
			);
			await fault.arm("clear");
		}, 45_000);

		for (const mode of ["physical-close", "owner-close"] as const) {
			it(`retries ${backend} ${mode} on the same worker before releasing its exact capacity inode`, async () => {
				const fault = faultWorker();
				const { client, directory, sessionId } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
				const identity = fault.capacities[0]!;
				const owner = (await client.recoveryState()).owner;
				await fault.arm(mode);
				expect(thrownBy(await settle(client.close()))).toThrow(
					mode === "physical-close"
						? "response loss after actual driver close"
						: "injected durable owner close failure",
				);
				if (mode === "physical-close") expect(fault.prepareCloseCalls.length).toBeGreaterThan(0);
				const retained = await fs.stat(`/proc/self/fd/${identity.fd}`, { bigint: true });
				expect([retained.dev, retained.ino, retained.nlink]).toEqual([identity.device, identity.inode, 0n]);
				expect(fault.capacities).toHaveLength(1);
				await client.close();
				expect(fault.capacities).toHaveLength(1);
				await expect(fs.stat(`/proc/self/fd/${identity.fd}`)).rejects.toThrow();
				const ownership = await acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
					owningSessionId: sessionId,
					create: false,
				});
				const reopened = await openAuthorityClient(
					{
						path: backend === "sqlite" ? ownership.paths.sqlite : ownership.paths.jsonl,
						identity: client.identity,
						create: false,
					},
					ownership,
				);
				const state = await reopened.exportState();
				expect(
					state.frames.filter(
						frame =>
							frame.command.kind === "owner" &&
							frame.command.owner.phase === "closed" &&
							frame.request.ownerEpoch === owner.epoch,
					),
				).toHaveLength(1);
			}, 45_000);
		}

		it(`retains the exact borrowed ${backend} capacity inode through lost-ACK replacement without replay`, async () => {
			const fault = faultWorker();
			const { client, directory, sessionId } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
			const identity = fault.capacities[0]!;
			const base = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "owner",
				classOwnerId: "owner",
				operationId: "lost-ack",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			await fault.arm("lost-ack");
			expect(thrownBy(await settle(client.transition(base, { requestId: "capacity-lost-ack" })))).toThrow(
				"malformed",
			);
			const retained = await fs.stat(`/proc/self/fd/${identity.fd}`, { bigint: true });
			expect([retained.dev, retained.ino]).toEqual([identity.device, identity.inode]);
			await client.close();
			expect(fault.capacities).toEqual([identity, identity]);
			await expect(fs.stat(`/proc/self/fd/${identity.fd}`)).rejects.toThrow();
			const ownership = await acquireAuthorityOwnership(path.join(directory, "session.jsonl"), {
				owningSessionId: sessionId,
				create: false,
			});
			const reopened = await openAuthorityClient(
				{
					path: backend === "sqlite" ? ownership.paths.sqlite : ownership.paths.jsonl,
					identity: client.identity,
					create: false,
				},
				ownership,
			);
			const state = await reopened.exportState();
			expect(state.frames.filter(frame => frame.request.requestId === "capacity-lost-ack")).toHaveLength(1);
			expect((await reopened.getOperation(base.ownerId, base.effectClass, base.operationId))?.record.phase).toBe(
				"intent",
			);
		}, 45_000);
		it(`retries retained replacement cleanup on the ordinary ${backend} close path`, async () => {
			const fault = faultWorker("replacement-cleanup-retry");
			const { client } = await openLiveAuthority(backend, os.tmpdir(), fault.factory);
			const identity = fault.capacities[0]!;
			const operation = {
				kind: "operation" as const,
				at: Date.now(),
				ownerId: "owner",
				classOwnerId: "owner",
				operationId: "replacement-cleanup",
				effectClass: "filesystem" as const,
				acquiredAt: 1,
				expiresAt: Number.MAX_SAFE_INTEGER,
				phase: "intent" as const,
			};
			await fault.arm("lost-ack");
			expect(
				thrownBy(await settle(client.transition(operation, { requestId: "replacement-cleanup-lost-ack" }))),
			).toThrow("malformed");
			expect(thrownBy(await settle(client.close()))).toThrow("replacement worker failed");
			expect(fault.capacities).toHaveLength(2);
			expect(await fs.stat(`/proc/self/fd/${identity.fd}`)).toBeDefined();
			expect(fault.events.filter(event => event.event === "replacement-cleanup-retained")).toMatchObject([
				{ cleanupRequest: 1 },
			]);
			expect(fault.events.some(event => event.event === "replacement-cleanup-consumed")).toBe(false);
			await client.close();
			expect(fault.capacities).toHaveLength(2);
			expect(
				fault.events
					.filter(event => event.event === "replacement-cleanup-request")
					.map(event => event.cleanupRequest),
			).toEqual([1, 2]);
			expect(fault.events.filter(event => event.event === "replacement-cleanup-consumed")).toMatchObject([
				{ cleanupRequest: 2 },
			]);
			await expect(fs.stat(`/proc/self/fd/${identity.fd}`)).rejects.toThrow();
		}, 45_000);
	}
});
