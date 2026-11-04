import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireAuthorityOwnership,
	authorityPaths,
	canonicalAuthoritySession,
	withAuthorityExclusive,
} from "../../src/registry/authority/ownership";
import { LEGACY_AUTHORITY_DENIAL_REASON } from "../../src/registry/authority/ownership";
import * as ownershipMethods from "../../src/registry/authority/ownership";
import {
	consumeFreshAuthorityRootAllocation,
	issueFreshAuthorityRootAllocation,
	revokeFreshAuthorityRootAllocation,
} from "../../src/registry/authority/allocation";
import {
	AuthorityRecoveryRequiredError,
	parseJournalingBackend,
	registryDurableStateForSession,
	closeSessionAuthority,
	validateJournalingEnvironment,
} from "../../src/registry/authority";
import { sessionAuthorityCommand } from "../../src/utils/resume-command";
import { readAuthorityDescriptor, writeAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import type {
	AuthorityDriverOptions,
	AuthorityExport,
	AuthorityRecoveryState,
} from "../../src/registry/authority/types";
import type { AuthorityOwnership } from "../../src/registry/authority/ownership";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import {
	assertAuthorityWireBudget,
	AUTHORITY_DIRECT_WORKER_ARG,
	AuthorityRpcClient,
	AuthorityRpcError,
	AUTHORITY_RESOURCE_CAPS,
	withAuthorityEffect,
} from "../../src/registry/authority/client";
import { durableGenesisHash, durableTargetHash, RegistryDurableStateStore } from "../../src/registry/durable-state";
import { SessionManager } from "../../src/session/session-manager";
import type { DurableOperationRecord, DurableResourceRecord } from "../../src/registry/durable-state";

type AsyncOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

interface RawOpeningCleanup {
	readonly label: string;
	readonly close: () => Promise<void>;
	readonly outcome: () => Promise<AsyncOutcome<void>>;
	readonly primaryFailures: unknown[];
	readonly snapshot?: (reason: string, error?: unknown) => void;
	readonly settled: AsyncOutcome<void> | undefined;
}

interface LostAckObservation {
	readonly phase: string;
	readonly worker: number;
	readonly rpcId?: string;
	readonly requestId?: string;
	readonly method?: string;
	readonly value?: unknown;
}

const clients: AuthorityRpcClient[] = [];
const sessions: string[] = [];
const directories: string[] = [];
const rawOpeningCleanups: RawOpeningCleanup[] = [];
let refusingContaminatedTest = false;
const isolatedFixtureNameEnvironment = "OMP_AUTHORITY_HOST_ISOLATED_FIXTURE";
const isolatedFixtureDirectoryEnvironment = "OMP_AUTHORITY_HOST_ISOLATED_DIRECTORY";

function observeOutcome<T>(promise: Promise<T>): Promise<AsyncOutcome<T>> {
	return promise.then(
		value => ({ ok: true as const, value }),
		error => ({ ok: false as const, error }),
	);
}

async function observeRejection<T>(promise: Promise<T>): Promise<Error> {
	const outcome = await observeOutcome(promise);
	if (outcome.ok) throw new Error("Expected authority operation to reject");
	if (!(outcome.error instanceof Error)) throw outcome.error;
	return outcome.error;
}

function openTrackedAuthority(
	options: AuthorityDriverOptions,
	ownership: AuthorityOwnership,
	workerFactory?: () => Worker,
	snapshot?: (reason: string, error?: unknown) => void,
) {
	const promise = AuthorityRpcClient.open(options, ownership, workerFactory);
	// Retain a non-rejecting opening result before publishing its client.
	const openingOutcome = observeOutcome(promise);
	let closing: Promise<void> | undefined;
	let closingOutcome: Promise<AsyncOutcome<void>> | undefined;
	let settled: AsyncOutcome<void> | undefined;
	const outcome = (): Promise<AsyncOutcome<void>> =>
		(closingOutcome ??= openingOutcome
			.then(async result => {
				if (result.ok) return result.value.close();
				if (result.error instanceof AuthorityRpcError && result.error.unknownOutcome) {
					expect(await AuthorityRpcClient.closeFailedOpen(options.identity.owningSessionId)).toBe(true);
					return;
				}
				throw result.error;
			})
			.then(
				() => ({ ok: true as const, value: undefined }),
				error => ({ ok: false as const, error }),
			)
			.then(result => {
				settled = result;
				if (!result.ok) snapshot?.("cleanup-failed", result.error);
				return result;
			}));
	const close = (): Promise<void> =>
		(closing ??= outcome().then(result => {
			if (!result.ok) throw result.error;
		}));
	const cleanup: RawOpeningCleanup = {
		label: options.identity.owningSessionId,
		close,
		outcome,
		...(snapshot ? { snapshot } : {}),
		primaryFailures: [],
		get settled() {
			return settled;
		},
	};
	rawOpeningCleanups.push(cleanup);
	return { promise, outcome: openingOutcome, close };
}

async function withPreservedFailure<T>(run: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
	const runOutcome = await observeOutcome(run());
	if (!runOutcome.ok) {
		const trackedCleanup = rawOpeningCleanups.find(item => item.close === cleanup);
		if (trackedCleanup) {
			trackedCleanup.primaryFailures.push(runOutcome.error);
			trackedCleanup.snapshot?.("body-failed", runOutcome.error);
			void cleanup().catch(() => undefined);
			throw runOutcome.error;
		}
		const cleanupOutcome = await observeOutcome(cleanup());
		if (!cleanupOutcome.ok)
			throw new AggregateError(
				[runOutcome.error, cleanupOutcome.error],
				"Authority fixture failed and cleanup also failed",
			);
		throw runOutcome.error;
	}
	const cleanupOutcome = await observeOutcome(cleanup());
	if (!cleanupOutcome.ok) throw cleanupOutcome.error;
	return runOutcome.value;
}

async function makeDirectory(): Promise<string> {
	// Keep backing identities until the isolated host exits; its parent owns directory cleanup.
	const isolatedDirectory = process.env[isolatedFixtureDirectoryEnvironment];
	if (process.env[isolatedFixtureNameEnvironment] && isolatedDirectory) return isolatedDirectory;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-host-"));
	directories.push(directory);
	return directory;
}
async function runIsolatedAuthorityFixture(testName: string, directory: string): Promise<void> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "test", "--test-name-pattern", testName, import.meta.path],
		{
			cwd: path.resolve(import.meta.dir, "../.."),
			env: {
				...process.env,
				[isolatedFixtureNameEnvironment]: testName,
				[isolatedFixtureDirectoryEnvironment]: directory,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const output = `${stdout}${stderr}`;
	expect(exitCode, output).toBe(0);
	expect(output).toContain(`(pass) authority backend configuration > ${testName}`);
}
async function makeAuthorityClient(): Promise<AuthorityRpcClient> {
	const directory = await makeDirectory();
	const session = path.join(directory, "root.jsonl");
	await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
	const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
	const client = await AuthorityRpcClient.open(
		{
			path: ownership.paths.jsonl,
			identity: { backend: "jsonl", owningSessionId: "root-uuid", incarnation: crypto.randomUUID(), format: 2 },
			create: true,
		},
		ownership,
	);
	clients.push(client);
	return client;
}
async function prepareActiveJsonlAuthority(session: string): Promise<void> {
	const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
	const incarnation = crypto.randomUUID();
	const descriptor = {
		version: 1 as const,
		revision: 1,
		owningSessionId: "root-uuid",
		backend: "jsonl" as const,
		format: 2 as const,
		incarnation,
		payload: path.basename(ownership.paths.jsonl),
		state: "initializing" as const,
		physicalIdentity: ownership.physicalIdentity,
	};
	await writeAuthorityDescriptor(session, descriptor);
	await fs.writeFile(ownership.paths.legacyFence, LEGACY_AUTHORITY_DENIAL_REASON, { mode: 0o600 });
	const client = await AuthorityRpcClient.open(
		{
			path: ownership.paths.jsonl,
			identity: { backend: "jsonl", owningSessionId: "root-uuid", incarnation, format: 2 },
			create: true,
		},
		ownership,
	);
	clients.push(client);
	await writeAuthorityDescriptor(session, { ...descriptor, revision: 2, state: "active" });
	await client.close();
}

async function makeSession(directory: string, filename = "root.jsonl"): Promise<string> {
	const session = path.join(directory, filename);
	await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
	sessions.push(session);
	return session;
}

interface AuthorityProcessMessage {
	readonly acquired?: boolean;
	readonly error?: string;
	readonly invalidRejected?: boolean;
	readonly parsed?: string;
	readonly cached?: string;
}

function spawnAuthorityProcess(mode: "hold" | "try" | "env" | "close-release-reject", session = "") {
	return Bun.spawn([process.execPath, path.join(import.meta.dir, "authority-process.ts"), mode, session], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function readAuthorityProcessMessage(stream: ReadableStream<Uint8Array>): Promise<AuthorityProcessMessage> {
	const reader = stream.getReader();
	let output = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`Authority process exited before reporting a result: ${output}`);
			output += new TextDecoder().decode(value, { stream: true });
			const newline = output.indexOf("\n");
			if (newline >= 0) return JSON.parse(output.slice(0, newline)) as AuthorityProcessMessage;
		}
	} finally {
		reader.releaseLock();
	}
}

function resourceRecord(
	operationId: string,
	resourceId: string,
	at: number,
	phase: DurableResourceRecord["phase"],
): DurableResourceRecord {
	return {
		kind: "resource",
		at,
		resourceId,
		resourceClass: "filesystem",
		operationId,
		actorId: "root-uuid",
		generation: 1,
		targetHash: durableTargetHash({
			actorId: "root-uuid",
			generation: 1,
			operationId,
			canonicalTarget: "/tmp/authority-target",
		}),
		phase,
	};
}

function operationRecord(
	operationId: string,
	at: number,
	phase: DurableOperationRecord["phase"],
): DurableOperationRecord {
	return {
		kind: "operation",
		at,
		operationId,
		effectClass: "session",
		ownerId: "root-uuid",
		classOwnerId: "root-uuid",
		acquiredAt: 1,
		expiresAt: 1_000,
		phase,
	};
}

beforeEach(() => {
	const unsafe = rawOpeningCleanups.filter(cleanup => cleanup.settled?.ok !== true);
	if (unsafe.length === 0) {
		rawOpeningCleanups.splice(0);
		refusingContaminatedTest = false;
		return;
	}
	refusingContaminatedTest = true;
	for (const cleanup of unsafe)
		cleanup.snapshot?.(cleanup.settled ? "cleanup-failed-contamination" : "cleanup-nonterminal");
	const failures = unsafe.flatMap(cleanup => [
		...cleanup.primaryFailures,
		cleanup.settled && !cleanup.settled.ok
			? cleanup.settled.error
			: new Error(
					`Authority opening cleanup for ${cleanup.label} remains nonterminal; refusing shared-UUID fixture reuse`,
				),
	]);
	throw new AggregateError(
		failures,
		"Prior authority fixture cleanup is unresolved; refusing to continue with shared-UUID state",
	);
});

afterEach(async () => {
	if (refusingContaminatedTest) {
		refusingContaminatedTest = false;
		return;
	}
	const cleanupBatch = rawOpeningCleanups.slice();
	for (const cleanup of cleanupBatch) cleanup.snapshot?.("hook-awaiting-cleanup");
	const rawOutcomes = await Promise.all(cleanupBatch.map(cleanup => cleanup.outcome()));
	const cleanupFailures = rawOutcomes.flatMap(outcome => (outcome.ok ? [] : [outcome.error]));
	if (cleanupFailures.length > 0) {
		const primaryFailures = cleanupBatch.flatMap(cleanup => cleanup.primaryFailures);
		throw new AggregateError(
			[...primaryFailures, ...cleanupFailures],
			"Raw authority opening cleanup failed; retaining fixture evidence and ownership state",
		);
	}
	for (const cleanup of cleanupBatch) {
		const index = rawOpeningCleanups.indexOf(cleanup);
		if (index >= 0) rawOpeningCleanups.splice(index, 1);
	}
	await Promise.all(sessions.splice(0).map(session => closeSessionAuthority(session)));
	await Promise.all(clients.splice(0).map(client => client.close()));
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("private fresh authority allocation state machine", () => {
	it("reserves a UUID throughout canonicalization and permits only one concurrent consumer", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const id = "root-uuid";
		const token = issueFreshAuthorityRootAllocation(session, id);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const canonicalize = ownershipMethods.canonicalAuthoritySession;
		const spy = spyOn(ownershipMethods, "canonicalAuthoritySession").mockImplementation(async file => {
			entered.resolve();
			await release.promise;
			return canonicalize(file);
		});
		const consumption = consumeFreshAuthorityRootAllocation(session, id);
		try {
			await entered.promise;
			expect(() => issueFreshAuthorityRootAllocation(session, id)).toThrow(/allocation/i);
			await expect(consumeFreshAuthorityRootAllocation(session, id)).rejects.toThrow(/allocation/i);
			release.resolve();
			await consumption;
			await expect(consumeFreshAuthorityRootAllocation(session, id)).rejects.toThrow(/allocation/i);
		} finally {
			release.resolve();
			await consumption.catch(() => undefined);
			spy.mockRestore();
			revokeFreshAuthorityRootAllocation(token);
		}
	});
	for (const stage of ["canonicalization", "header"] as const) {
		it(`denies revocation during ${stage} without releasing the in-flight UUID reservation`, async () => {
			const directory = await makeDirectory();
			const session = await makeSession(directory);
			const token = issueFreshAuthorityRootAllocation(session, "root-uuid");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const method = stage === "canonicalization" ? "canonicalAuthoritySession" : "readAuthoritySessionId";
			const original = ownershipMethods[method];
			const spy = spyOn(ownershipMethods, method).mockImplementation(async file => {
				entered.resolve();
				await release.promise;
				return original(file);
			});
			const consumption = consumeFreshAuthorityRootAllocation(session, "root-uuid");
			try {
				await entered.promise;
				revokeFreshAuthorityRootAllocation(token);
				expect(() => issueFreshAuthorityRootAllocation(session, "root-uuid")).toThrow(/allocation/i);
				await expect(consumeFreshAuthorityRootAllocation(session, "root-uuid")).rejects.toThrow(/allocation/i);
				release.resolve();
				await expect(consumption).rejects.toThrow(/allocation/i);
				await expect(consumeFreshAuthorityRootAllocation(session, "root-uuid")).rejects.toThrow(/allocation/i);
				expect((await fs.readdir(directory)).sort()).toEqual([path.basename(session)]);
			} finally {
				release.resolve();
				await consumption.catch(() => undefined);
				spy.mockRestore();
				revokeFreshAuthorityRootAllocation(token);
			}
		});
	}
	it("burns the original proof on failed validation and releases only its bounded reservation", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const token = issueFreshAuthorityRootAllocation(session, "expected-uuid");
		await expect(consumeFreshAuthorityRootAllocation(session, "expected-uuid")).rejects.toThrow(/allocation/i);
		await fs.writeFile(session, '{"type":"session","id":"expected-uuid"}\n');
		await expect(consumeFreshAuthorityRootAllocation(session, "expected-uuid")).rejects.toThrow(/allocation/i);
		revokeFreshAuthorityRootAllocation(token);
		const replacement = issueFreshAuthorityRootAllocation(session, "expected-uuid");
		revokeFreshAuthorityRootAllocation(token);
		await consumeFreshAuthorityRootAllocation(session, "expected-uuid");
		revokeFreshAuthorityRootAllocation(replacement);
		expect((await fs.readdir(directory)).sort()).toEqual([path.basename(session)]);
	});
});

describe("authority worker admission", () => {
	it("fails in-flight requests as unknown outcomes as soon as the worker exits silently, not at the deadline", async () => {
		const directory = await makeDirectory();
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
		const client = await AuthorityRpcClient.open(
			{
				path: ownership.paths.jsonl,
				identity: { backend: "jsonl", owningSessionId: "root-uuid", incarnation: crypto.randomUUID(), format: 2 },
				create: true,
			},
			ownership,
			() => new Worker(new URL("./authority-silent-exit-worker.ts", import.meta.url).href, { type: "module" }),
		);
		clients.push(client);
		const started = Date.now();
		const failure = await client
			.transition(operationRecord("silent-exit-operation", 1, "intent"), { requestId: "silent-exit" })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(AuthorityRpcError);
		expect(failure).toMatchObject({ unknownOutcome: true });
		expect(Date.now() - started).toBeLessThan(AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs / 2);
		// The client is unavailable: later commands are refused instead of queueing behind a dead worker.
		const later = await client
			.transition(operationRecord("after-exit", 2, "intent"), { requestId: "after-exit" })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(later).toBeInstanceOf(AuthorityRpcError);
	});

	it("retains pending raw opening cleanup until its real open acknowledgement and single ownership release", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
		const acknowledged = Promise.withResolvers<void>();
		let deliverOpen: (() => void) | undefined;
		let releases = 0;
		const opening = openTrackedAuthority(
			{
				path: ownership.paths.jsonl,
				identity: { backend: "jsonl", owningSessionId: "root-uuid", incarnation: crypto.randomUUID(), format: 2 },
				create: true,
			},
			{
				...ownership,
				async release() {
					releases++;
					await ownership.release();
				},
			},
			() => {
				const worker = new Worker(new URL("../../src/registry/authority/worker.ts", import.meta.url).href, {
					type: "module",
					argv: [AUTHORITY_DIRECT_WORKER_ARG],
				});
				const addEventListener = worker.addEventListener.bind(worker);
				worker.addEventListener = new Proxy(worker.addEventListener, {
					apply(_method, _this, args) {
						const [type, listener, options] = args as Parameters<Worker["addEventListener"]>;
						if (type !== "message") return addEventListener(type, listener, options);
						let firstResponse = true;
						return addEventListener(
							type,
							event => {
								const deliver = () => {
									if (typeof listener === "function") listener.call(worker, event);
									else listener.handleEvent(event);
								};
								if (!firstResponse) return deliver();
								firstResponse = false;
								deliverOpen = deliver;
								acknowledged.resolve();
							},
							options,
						);
					},
				});
				return worker;
			},
		);
		let cleanupSettled = false;
		try {
			await acknowledged.promise;
			const cleanup = opening.close();
			void cleanup.then(
				() => {
					cleanupSettled = true;
				},
				() => {
					cleanupSettled = true;
				},
			);
			expect(opening.close()).toBe(cleanup);
			await expect(acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" })).rejects.toThrow(
				/ownership|lock/i,
			);
			expect(cleanupSettled).toBe(false);
			expect(releases).toBe(0);
			expect(await fs.readFile(session, "utf8")).toBe('{"type":"session","id":"root-uuid"}\n');
			deliverOpen?.();
			await cleanup;
			expect(releases).toBe(1);
			const client = await opening.promise;
			const closedClientFailure = await observeRejection(client.getRoot("after-opening-cleanup"));
			expect(closedClientFailure.message).toMatch(/closed|quiescing/i);
			const next = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
			await next.release();
		} finally {
			deliverOpen?.();
			await opening.close();
		}
		expect(releases).toBe(1);
	});
	for (const stage of ["client initialization", "worker listener setup", "open request preparation"] as const) {
		it(`releases ownership without sending an open when ${stage} fails locally`, async () => {
			const directory = await makeDirectory();
			const session = await makeSession(directory);
			const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
			const identity = {
				backend: "jsonl" as const,
				owningSessionId: "root-uuid",
				incarnation: crypto.randomUUID(),
				format: 2 as const,
			};
			const driver = { path: ownership.paths.jsonl, identity, create: true };
			const failure = new Error(`injected ${stage} failure before authority open send`);
			const randomUUID = crypto.randomUUID.bind(crypto);
			const uuidSpy = spyOn(crypto, "randomUUID").mockImplementation(randomUUID);
			let worker: Worker | undefined;
			let posts = 0;
			let terminations = 0;
			let releases = 0;
			let opened: AuthorityRpcClient | undefined;
			if (stage === "client initialization")
				uuidSpy.mockImplementationOnce(() => {
					throw failure;
				});
			try {
				const opening = AuthorityRpcClient.open(
					driver,
					{
						...ownership,
						async release() {
							releases++;
							await ownership.release();
						},
					},
					() => {
						const created = new Worker(new URL("../../src/registry/authority/worker.ts", import.meta.url).href, {
							type: "module",
						});
						worker = created;
						created.postMessage = new Proxy(created.postMessage, {
							apply(method, _this, args) {
								posts++;
								return Reflect.apply(method, created, args);
							},
						});
						created.terminate = new Proxy(created.terminate, {
							apply(method, _this, args) {
								terminations++;
								return Reflect.apply(method, created, args);
							},
						});
						if (stage === "worker listener setup") {
							created.addEventListener = new Proxy(created.addEventListener, {
								apply() {
									throw failure;
								},
							});
						}
						if (stage === "open request preparation")
							uuidSpy.mockImplementationOnce(() => {
								throw failure;
							});
						return created;
					},
				).then(client => {
					opened = client;
					clients.push(client);
					return client;
				});
				const openingFailure = await observeRejection(opening);
				expect(openingFailure).toBe(failure);
				uuidSpy.mockRestore();
				expect(posts).toBe(0);
				expect(terminations).toBe(stage === "client initialization" ? 0 : 1);
				expect(releases).toBe(1);
				expect(await AuthorityRpcClient.closeFailedOpen("root-uuid")).toBe(false);
				await expect(fs.stat(driver.path)).rejects.toMatchObject({ code: "ENOENT" });
				const nextOwnership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
				const next = await AuthorityRpcClient.open(driver, nextOwnership);
				clients.push(next);
				await next.close();
			} finally {
				uuidSpy.mockRestore();
				await opened?.close();
				await AuthorityRpcClient.closeFailedOpen("root-uuid");
				if (worker && terminations === 0) await worker.terminate();
				await ownership.release();
			}
		});
	}
	it("returns typed recovery state and admits subsequent work under its recovered owner", async () => {
		const client = await makeAuthorityClient();
		const before = await client.recoveryState();
		const recovery: AuthorityRecoveryState = await client.recover();
		expect(recovery.owner.phase).toBe("ready");
		expect(recovery.owner).toEqual(before.owner);
		expect(recovery.revision).toBe(before.revision);
		const receipt = await client.transition(operationRecord("after-explicit-recovery", 1, "intent"));
		expect(receipt.ownerEpoch).toBe(recovery.owner.epoch);
		expect(receipt.incarnation).toBe(recovery.owner.incarnation);
		expect(receipt.revision).toBe(recovery.revision + 1);
		expect(await client.resolveReceipt(receipt.requestId)).toEqual(receipt);
	});
	// Measured on XFS (2026-11-03, three runs): ownership + worker open + first intent + close take at most 0.2 s with
	// capacity off (this test's default) and 0.53 s with capacity xfs (SQLite open 0.35 s, first funded intent 0.15 s).
	// The bound is ~50x the capacity-on worst case for loaded shared hosts; a stalled RPC fails here rather than
	// waiting out the 60 s production deadline.
	const FIRST_INTENT_TEST_TIMEOUT_MS = 30_000;
	for (const backend of ["jsonl", "sqlite"] as const) {
		it(
			`settles the first actor-bound intent and returns its durable receipt through the real ${backend} worker`,
			async () => {
				const directory = await makeDirectory();
				const session = await makeSession(directory);
				const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
				const identity = {
					backend,
					owningSessionId: "root-uuid",
					incarnation: crypto.randomUUID(),
					format: 2 as const,
				};
				const opening = openTrackedAuthority(
					{
						path: backend === "jsonl" ? ownership.paths.jsonl : ownership.paths.sqlite,
						identity,
						create: true,
					},
					ownership,
				);
				const client = await opening.promise;
				const now = Date.now();
				const record: DurableOperationRecord = {
					kind: "operation",
					at: now,
					operationId: `filesystem:first-intent-${backend}`,
					effectClass: "filesystem",
					ownerId: "session-actor:Main:Worker:1",
					classOwnerId: "session-actor:Main:Worker:1:filesystem",
					actorId: "Worker",
					rootId: "Main",
					generation: 1,
					acquiredAt: now,
					expiresAt: now + 300_000,
					phase: "intent",
				};
				const requestId = `w-cycle1-attempt2-first-intent-${backend}`;
				const receipt = await withAuthorityEffect(client, () =>
					withAuthorityEffect(client, () => client.transition(record, { requestId })),
				);
				expect(receipt).toMatchObject({
					requestId,
					commandKind: "transition",
					incarnation: client.identity.incarnation,
				});
				expect(await client.resolveReceipt(requestId)).toEqual(receipt);
				expect(await client.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
					record,
					version: 1,
				});
			},
			FIRST_INTENT_TEST_TIMEOUT_MS,
		);
	}

	it("settles the first actor-bound intent through nested effect scopes before invoking its external callback", async () => {
		const client = await makeAuthorityClient();
		const now = Date.now();
		const record: DurableOperationRecord = {
			kind: "operation",
			at: now,
			operationId: "filesystem:sqlite-sniff",
			effectClass: "filesystem",
			ownerId: "session-actor:Main:Worker:1",
			classOwnerId: "session-actor:Main:Worker:1:filesystem",
			actorId: "Worker",
			rootId: "Main",
			generation: 1,
			acquiredAt: now,
			expiresAt: now + 300_000,
			phase: "intent",
		};
		const committed = Promise.withResolvers<void>();
		const releaseAck = Promise.withResolvers<void>();
		const transition = client.transition.bind(client);
		let transitionCalls = 0;
		let callbacks = 0;
		client.transition = async (next, options) => {
			transitionCalls++;
			const receipt = await transition(next, options);
			if (next.kind === "operation" && next.phase === "intent") {
				committed.resolve();
				await releaseAck.promise;
			}
			return receipt;
		};
		const pending = withAuthorityEffect(client, () =>
			withAuthorityEffect(client, async () => {
				const receipt = await client.transition(record, { requestId: "actor-bound-first-intent" });
				await client.transition({ ...record, phase: "effect" });
				callbacks++;
				await client.transition({ ...record, phase: "completed" });
				return receipt;
			}),
		);
		try {
			const boundary = await Promise.race([
				committed.promise.then(() => "committed"),
				pending.then(
					() => "settled",
					() => "settled",
				),
			]);
			expect(boundary).toBe("committed");
			expect(callbacks).toBe(0);
			expect(transitionCalls).toBe(1);
			expect(await client.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
				record,
				version: 1,
			});
			releaseAck.resolve();
			const receipt = await pending;
			expect((await client.recoveryState()).revision).toBe(receipt.revision + 2);
			expect(await client.resolveReceipt("actor-bound-first-intent")).toEqual(receipt);
			expect((await client.getOperation(record.ownerId, record.effectClass, record.operationId))?.record.phase).toBe(
				"completed",
			);
			expect(callbacks).toBe(1);
			expect(transitionCalls).toBe(3);
		} finally {
			releaseAck.resolve();
			await pending.catch(() => undefined);
		}
	});
	it("admits terminal transitions from reserved completion capacity when normal requests saturate", async () => {
		const client = await makeAuthorityClient();
		const operationId = crypto.randomUUID();
		await client.transition(operationRecord(operationId, 1, "intent"));
		await client.transition(operationRecord(operationId, 2, "effect"));
		const reads = Array.from({ length: AUTHORITY_RESOURCE_CAPS.maxNormalOutstandingPerSession }, (_, index) =>
			client.getRoot(`queued-${index}`),
		);
		const overLimitFailure = await observeRejection(client.getRoot("over-limit"));
		expect(overLimitFailure.message).toMatch(/queue is full/);
		const completion = client.transition(operationRecord(operationId, 3, "completed"));
		await Promise.all([...reads, completion]);
	});
	it("bounds normal queued bytes independently of request count", async () => {
		const client = await makeAuthorityClient();
		const key = "x".repeat(300 * 1024);
		const requests = Array.from({ length: 40 }, (_, index) => client.getRoot(`${index}:${key}`));
		const results = await Promise.allSettled(requests);
		expect(results.filter(result => result.status === "rejected")).not.toHaveLength(0);
	});
	it("retains ownership across a lost mutation acknowledgement and reconciles without replay", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "root-uuid",
			incarnation: crypto.randomUUID(),
			format: 2 as const,
		};
		const record = operationRecord("lost-ack-operation", 1, "intent");
		const faultMessage = "Injected authority worker ACK loss after durable commit before response delivery";
		const responses: unknown[] = [];
		const diagnostics: unknown[] = [];
		const observations: LostAckObservation[] = [];
		const diagnosticChannel = new BroadcastChannel("omp-authority-lost-ack-diagnostic");
		const rpcIds = new Set<string>();
		const snapshot = (reason: string, error?: unknown): void => {
			try {
				const failure =
					error instanceof Error
						? { name: error.name, message: error.message.slice(0, 512) }
						: error === undefined
							? undefined
							: String(error).slice(0, 512);
				console.error(
					JSON.stringify({
						fixture: "authority-lost-ack",
						reason,
						failure,
						observations: observations.map(({ phase, worker, rpcId, requestId, method }) => ({
							phase,
							worker,
							rpcId,
							requestId,
							method,
						})),
						diagnostics: diagnostics.map(value =>
							typeof value === "object" && value !== null && "phase" in value && typeof value.phase === "string"
								? value.phase.slice(0, 128)
								: "invalid",
						),
						responses: responses.map(value =>
							typeof value === "object" && value !== null && "id" in value && "ok" in value
								? { id: value.id, ok: value.ok }
								: "invalid",
						),
					}),
				);
			} catch {
				/* Diagnostics must not replace the authority failure. */
			}
		};
		const observe = (
			phase: string,
			worker: number,
			detail: Omit<LostAckObservation, "phase" | "worker"> = {},
		): void => {
			if (observations.length === 128) observations.shift();
			observations.push({ phase, worker, ...detail });
			snapshot(phase);
		};
		let lostCallId: string | undefined;
		let workerCount = 0;
		let transitionCalls = 0;
		let releases = 0;
		let diagnosticChannelClosed = false;
		const closeDiagnosticChannel = (): void => {
			if (diagnosticChannelClosed) return;
			diagnosticChannelClosed = true;
			diagnosticChannel.close();
		};
		diagnosticChannel.addEventListener("message", event => {
			if (diagnostics.length < 8) diagnostics.push(event.data);
			snapshot("diagnostic-received");
		});
		// Independent bounded event-loop settlement; worker/RPC closure is not a channel barrier.
		const settleDiagnostics = async (): Promise<void> => {
			for (let turn = 0; turn < 64; turn++) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setImmediate(resolve);
				await promise;
			}
			snapshot(diagnostics.length < 4 ? "diagnostic-incomplete" : "diagnostic-settled");
		};
		const opening = openTrackedAuthority(
			{ path: ownership.paths.jsonl, identity, create: true },
			{
				...ownership,
				async release() {
					releases++;
					observe("ownership-release-started", 1);
					await ownership.release();
					observe("ownership-release-settled", 1);
				},
			},
			() => {
				const workerNumber = ++workerCount;
				const firstWorker = workerNumber === 1;
				observe(firstWorker ? "original-worker-created" : "replacement-worker-created", workerNumber);
				const worker = firstWorker
					? new Worker(new URL("./authority-lost-ack-worker.ts", import.meta.url).href, { type: "module" })
					: new Worker(new URL("../../src/registry/authority/worker.ts", import.meta.url).href, {
							type: "module",
							argv: [AUTHORITY_DIRECT_WORKER_ARG],
						});
				// Private native-lifetime controls are not authority RPC responses.
				worker.addEventListener("message", event => {
					if (
						typeof event.data === "object" &&
						event.data !== null &&
						"id" in event.data &&
						typeof event.data.id === "string" &&
						rpcIds.has(event.data.id)
					) {
						if (responses.length < 64) responses.push(event.data);
						observe("native-response", workerNumber, { rpcId: event.data.id, value: event.data });
					}
				});
				const terminate = worker.terminate;
				worker.terminate = new Proxy(terminate, {
					apply(method, receiver, args) {
						observe("worker-termination-requested", workerNumber);
						const result = Reflect.apply(method, receiver, args);
						void Promise.resolve(result).then(
							value => {
								observe("worker-terminate-return-observed", workerNumber, { value });
							},
							error => {
								observe("worker-termination-failed", workerNumber, { value: error });
								snapshot("termination-failed", error);
							},
						);
						return result;
					},
				});
				worker.postMessage = new Proxy(worker.postMessage, {
					apply(method, _this, args) {
						const request: unknown = args[0];
						let rpcId: string | undefined;
						let methodName: string | undefined;
						let requestId: string | undefined;
						if (
							typeof request === "object" &&
							request !== null &&
							"kind" in request &&
							"id" in request &&
							typeof request.id === "string"
						) {
							rpcId = request.id;
							if (request.kind === "open") methodName = "open";
							if (request.kind === "call" && "method" in request && typeof request.method === "string") {
								methodName = request.method;
								if (request.method === "transition" && "args" in request && Array.isArray(request.args)) {
									const options = request.args[1];
									if (
										typeof options === "object" &&
										options !== null &&
										"requestId" in options &&
										typeof options.requestId === "string"
									) {
										requestId = options.requestId;
									}
								}
							}
						}
						if (methodName === "transition") {
							transitionCalls++;
							lostCallId = rpcId;
						}
						if (methodName && rpcId) {
							rpcIds.add(rpcId);
							const phase =
								methodName === "open"
									? "open-request-sent"
									: methodName === "close"
										? "close-request-sent"
										: methodName === "transition"
											? "transition-request-sent"
											: "request-sent";
							observe(phase, workerNumber, { rpcId, method: methodName, ...(requestId ? { requestId } : {}) });
						}
						const result = Reflect.apply(method, worker, args);
						if (methodName && rpcId)
							observe("host-post-returned", workerNumber, {
								rpcId,
								method: methodName,
								...(requestId ? { requestId } : {}),
							});
						return result;
					},
				});
				return worker;
			},
			snapshot,
		);
		try {
			await withPreservedFailure(async () => {
				const openOutcome = await opening.outcome;
				if (!openOutcome.ok) throw openOutcome.error;
				const client = openOutcome.value;
				const pending = client.transition(record, { requestId: "lost-ack-request" });
				const mutationOutcome = await observeOutcome(pending);
				if (mutationOutcome.ok)
					throw new Error("Lost-ACK mutation unexpectedly received a success acknowledgement");
				if (!(mutationOutcome.error instanceof AuthorityRpcError)) throw mutationOutcome.error;
				const hostFailure = mutationOutcome.error;
				observe("host-rejection", 1, {
					rpcId: lostCallId,
					requestId: hostFailure.requestId,
					value: {
						name: hostFailure.name,
						message: hostFailure.message,
						requestId: hostFailure.requestId,
						unknownOutcome: hostFailure.unknownOutcome,
					},
				});
				expect(hostFailure).toMatchObject({
					message: faultMessage,
					requestId: "lost-ack-request",
					unknownOutcome: true,
				});
				expect(typeof lostCallId).toBe("string");
				const nativeError = {
					id: lostCallId,
					ok: false,
					error: { name: "Error", message: faultMessage, unknownOutcome: true },
				};
				expect(
					responses.filter(
						response =>
							typeof response === "object" &&
							response !== null &&
							"id" in response &&
							response.id === lostCallId,
					),
				).toEqual([nativeError]);
				expect((await observeRejection(client.getRoot("unavailable-after-lost-ack"))).message).toMatch(
					faultMessage,
				);
				await expect(acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" })).rejects.toThrow(
					/ownership|lock/i,
				);
				expect(workerCount).toBe(1);
				expect(transitionCalls).toBe(1);
				expect(releases).toBe(0);

				// Validate a complete private copy, never open a second writable view of the owned payload.
				const committedBytes = await fs.readFile(ownership.paths.jsonl);
				const evidencePath = path.join(directory, "lost-ack-evidence.jsonl");
				await fs.copyFile(ownership.paths.jsonl, evidencePath);
				const evidence = new JsonlAuthorityPersistence({ path: evidencePath, identity, create: false });
				let persisted: AuthorityExport;
				try {
					persisted = evidence.exportState();
				} finally {
					evidence.close();
				}
				expect(await fs.readFile(ownership.paths.jsonl)).toEqual(committedBytes);
				const mutationFrames = persisted.frames.filter(frame => frame.command.kind === "transition");
				expect(mutationFrames).toHaveLength(1);
				const committed = mutationFrames[0];
				if (!committed) throw new Error("Lost ACK must follow an actual durable transition and receipt");
				expect(committed.command).toEqual({ kind: "transition", record });
				expect(committed.request).toMatchObject({
					requestId: "lost-ack-request",
					incarnation: identity.incarnation,
				});
				expect(committed.receipt).toMatchObject({
					requestId: "lost-ack-request",
					incarnation: identity.incarnation,
					commandKind: "transition",
				});
				expect([...committed.changes]).toEqual([{ record, version: 1 }]);
				expect([...persisted.rows]).toEqual([{ record, version: 1 }]);
				expect(
					persisted.controls.find(
						control =>
							control.key ===
							`receipt:${JSON.stringify([identity.incarnation, committed.receipt.ownerEpoch, "lost-ack-request"])}`,
					)?.value,
				).toEqual(committed.receipt);

				const closing = opening.close();
				expect(opening.close()).toBe(closing);
				observe("close-await-started", 1);
				await closing;
				observe("close-await-settled", 1);
				expect(workerCount).toBe(2);
				expect(transitionCalls).toBe(1);
				expect(releases).toBe(1);

				const recoveredOwnership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
				const recoveredOpening = openTrackedAuthority(
					{ path: recoveredOwnership.paths.jsonl, identity, create: false },
					recoveredOwnership,
					undefined,
					(reason, error) => snapshot(`recovered-${reason}`, error),
				);
				await withPreservedFailure(async () => {
					const recoveredOutcome = await recoveredOpening.outcome;
					if (!recoveredOutcome.ok) throw recoveredOutcome.error;
					const recovered = recoveredOutcome.value;
					expect(await recovered.resolveReceipt("lost-ack-request")).toEqual(committed.receipt);
					expect(
						await recovered.resolveReceipt(
							"lost-ack-request",
							committed.receipt.ownerEpoch,
							identity.incarnation,
							committed.receipt.payloadHash,
						),
					).toEqual(committed.receipt);
					expect(await recovered.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
						record,
						version: 1,
					});
					expect((await recovered.recoveryState()).blocked).toEqual([
						"operation:root-uuid:lost-ack-operation:intent",
					]);
					const reconciled = await recovered.exportState();
					expect(reconciled.frames.slice(0, persisted.frames.length)).toEqual([...persisted.frames]);
					expect(reconciled.frames.filter(frame => frame.command.kind === "transition")).toEqual([committed]);
				}, recoveredOpening.close);
				const originalOpen = observations.find(item => item.phase === "open-request-sent" && item.worker === 1);
				const originalOpenResponse = observations.find(
					item => item.phase === "native-response" && item.worker === 1 && item.rpcId === originalOpen?.rpcId,
				);
				const transitionSend = observations.find(
					item => item.phase === "transition-request-sent" && item.worker === 1,
				);
				const transitionPostReturn = observations.findIndex(
					item => item.phase === "host-post-returned" && item.worker === 1 && item.rpcId === lostCallId,
				);
				const nativeErrorIndex = observations.findIndex(
					item => item.phase === "native-response" && item.worker === 1 && item.rpcId === lostCallId,
				);
				const hostRejectionIndex = observations.findIndex(
					item => item.phase === "host-rejection" && item.worker === 1 && item.rpcId === lostCallId,
				);
				expect(originalOpen?.rpcId).toBeDefined();
				expect(originalOpenResponse?.value).toMatchObject({ id: originalOpen?.rpcId, ok: true });
				expect(transitionSend).toMatchObject({ rpcId: lostCallId, requestId: "lost-ack-request" });
				expect(observations).toContainEqual({
					phase: "native-response",
					worker: 1,
					rpcId: lostCallId,
					value: nativeError,
				});
				expect(observations).toContainEqual({
					phase: "host-rejection",
					worker: 1,
					rpcId: lostCallId,
					requestId: "lost-ack-request",
					value: {
						name: "AuthorityRpcError",
						message: faultMessage,
						requestId: "lost-ack-request",
						unknownOutcome: true,
					},
				});
				expect(transitionPostReturn).toBeGreaterThanOrEqual(0);
				expect(nativeErrorIndex).toBeGreaterThan(transitionPostReturn);
				expect(hostRejectionIndex).toBeGreaterThan(nativeErrorIndex);
				const originalTermination = observations.findIndex(
					item => item.phase === "worker-terminate-return-observed" && item.worker === 1,
				);
				const replacementOpen = observations.find(item => item.phase === "open-request-sent" && item.worker === 2);
				const replacementOpenResponse = observations.find(
					item => item.phase === "native-response" && item.worker === 2 && item.rpcId === replacementOpen?.rpcId,
				);
				const replacementClose = observations.find(
					item => item.phase === "close-request-sent" && item.worker === 2,
				);
				const replacementCloseResponse = observations.find(
					item => item.phase === "native-response" && item.worker === 2 && item.rpcId === replacementClose?.rpcId,
				);
				const replacementTermination = observations.findIndex(
					item => item.phase === "worker-terminate-return-observed" && item.worker === 2,
				);
				const originalOpenIndex = observations.findIndex(
					item => item.phase === "open-request-sent" && item.worker === 1,
				);
				const originalOpenResponseIndex = observations.findIndex(
					item => item.phase === "native-response" && item.worker === 1 && item.rpcId === originalOpen?.rpcId,
				);
				const transitionSendIndex = observations.findIndex(
					item => item.phase === "transition-request-sent" && item.worker === 1,
				);
				const replacementOpenIndex = observations.findIndex(
					item => item.phase === "open-request-sent" && item.worker === 2,
				);
				const replacementOpenResponseIndex = observations.findIndex(
					item => item.phase === "native-response" && item.worker === 2 && item.rpcId === replacementOpen?.rpcId,
				);
				const replacementCloseIndex = observations.findIndex(
					item => item.phase === "close-request-sent" && item.worker === 2,
				);
				const replacementCloseResponseIndex = observations.findIndex(
					item => item.phase === "native-response" && item.worker === 2 && item.rpcId === replacementClose?.rpcId,
				);
				const releaseStarted = observations.findIndex(
					item => item.phase === "ownership-release-started" && item.worker === 1,
				);
				const releaseSettled = observations.findIndex(
					item => item.phase === "ownership-release-settled" && item.worker === 1,
				);
				expect(replacementOpen?.rpcId).toBeDefined();
				expect(replacementOpenResponse?.value).toMatchObject({ id: replacementOpen?.rpcId, ok: true });
				expect(replacementClose?.rpcId).toBeDefined();
				expect(replacementCloseResponse?.value).toMatchObject({ id: replacementClose?.rpcId, ok: true });
				expect(originalOpenResponseIndex).toBeGreaterThan(originalOpenIndex);
				expect(transitionSendIndex).toBeGreaterThan(originalOpenResponseIndex);
				expect(originalTermination).toBeGreaterThan(hostRejectionIndex);
				expect(replacementOpenIndex).toBeGreaterThan(originalTermination);
				expect(replacementOpenResponseIndex).toBeGreaterThan(replacementOpenIndex);
				expect(replacementCloseIndex).toBeGreaterThan(replacementOpenResponseIndex);
				expect(replacementCloseResponseIndex).toBeGreaterThan(replacementCloseIndex);
				expect(replacementTermination).toBeGreaterThan(replacementCloseResponseIndex);
				expect(releaseStarted).toBeGreaterThan(replacementTermination);
				expect(releaseSettled).toBeGreaterThan(releaseStarted);
				await settleDiagnostics();
				try {
					if (diagnostics.length < 4)
						throw new Error(
							`Diagnostic channel incomplete after 64 event-loop turns: received ${diagnostics.length} of 4`,
						);
					expect(diagnostics).toEqual([
						{ phase: "worker-started" },
						{ phase: "transition-entered", requestId: "lost-ack-request" },
						{ phase: "durable-transition-returned", requestId: "lost-ack-request", receipt: committed.receipt },
						{
							phase: "fault-thrown",
							requestId: "lost-ack-request",
							failure: { name: "Error", message: faultMessage, unknownOutcome: true },
						},
					]);
				} catch (error) {
					snapshot("diagnostic-failed", error);
					throw new Error("Lost-ACK diagnostic delivery or order failed after authority recovery proof", {
						cause: error,
					});
				}
			}, opening.close);
			expect(workerCount).toBe(2);
			expect(transitionCalls).toBe(1);
			expect(releases).toBe(1);
		} catch (error) {
			snapshot("body-failed", error);
			throw error;
		} finally {
			closeDiagnosticChannel();
		}
	});

	it("surfaces a real SQLite post-COMMIT authorization failure as unknown and drains callbacks before release", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: "root-uuid",
			incarnation: crypto.randomUUID(),
			format: 2 as const,
		};
		let workerCount = 0;
		const client = await AuthorityRpcClient.open(
			{ path: ownership.paths.sqlite, identity, create: true },
			ownership,
			() => {
				workerCount++;
				return new Worker(new URL("./authority-commit-failure-worker.ts", import.meta.url).href, {
					type: "module",
				});
			},
		);
		clients.push(client);
		const authorizationFailure = Promise.withResolvers<unknown>();
		const releaseActorCallback = Promise.withResolvers<void>();
		let externalCallbackCount = 0;
		const actorScope = withAuthorityEffect(client, async () => {
			const claim = await client.reserveLocal(
				{
					localId: "repo",
					entryId: "entry-1",
					entryHash: "a".repeat(64),
					expectedHeadHash: durableGenesisHash(),
				},
				{ requestId: "reserve-before-authorization" },
			);
			try {
				await client.authorizeLocalEffect(claim, { requestId: "authorize-post-commit" });
			} catch (error) {
				authorizationFailure.resolve(error);
				await releaseActorCallback.promise;
				throw error;
			}
			externalCallbackCount++;
			await client.finalizeLocal({ ...claim, phase: "effect" }, "committed");
		}).catch(error => error);

		const failure = await authorizationFailure.promise;
		expect(failure).toMatchObject({ requestId: "authorize-post-commit", unknownOutcome: true });
		const dependentAdmissionFailure = await observeRejection(client.getRoot("dependent-admission"));
		expect(dependentAdmissionFailure).toMatchObject({ unknownOutcome: true });
		const closing = client.close();
		const aliasClosing = client.close();
		expect(aliasClosing).toBe(closing);
		await expect(acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" })).rejects.toThrow(
			/ownership|lock/i,
		);
		expect(externalCallbackCount).toBe(0);
		releaseActorCallback.resolve();
		expect(await actorScope).toBe(failure);
		await closing;
		await aliasClosing;
		expect(workerCount).toBe(2);

		const recoveredOwnership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
		const recovered = await AuthorityRpcClient.open(
			{ path: recoveredOwnership.paths.sqlite, identity, create: false },
			recoveredOwnership,
		);
		clients.push(recovered);
		expect(await recovered.resolveReceipt("authorize-post-commit")).toMatchObject({
			requestId: "authorize-post-commit",
		});
		expect(externalCallbackCount).toBe(0);
		await recovered.close();
	});
	it("retains an uncertain open until outcome-aware cleanup reconciles its committed owner frame", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
		const identity = {
			backend: "sqlite" as const,
			owningSessionId: "root-uuid",
			incarnation: crypto.randomUUID(),
			format: 2 as const,
		};
		let workerCount = 0;
		let releases = 0;
		const opening = openTrackedAuthority(
			{ path: ownership.paths.sqlite, identity, create: true },
			{
				...ownership,
				async release() {
					releases++;
					await ownership.release();
				},
			},
			() => {
				if (workerCount++ === 0)
					return new Worker(new URL("./authority-open-commit-failure-worker.ts", import.meta.url).href, {
						type: "module",
					});
				return new Worker(new URL("../../src/registry/authority/worker.ts", import.meta.url).href, {
					type: "module",
					argv: [AUTHORITY_DIRECT_WORKER_ARG],
				});
			},
		);
		const failure = opening.promise.then(client => {
			clients.push(client);
			throw new Error("Authority worker unexpectedly opened after the injected post-COMMIT failure");
		});
		try {
			const openingFailure = await observeRejection(failure);
			expect(openingFailure).toMatchObject({ unknownOutcome: true });
			await expect(acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" })).rejects.toThrow(
				/ownership|lock/i,
			);
			await opening.close();
			expect(workerCount).toBe(2);
			expect(releases).toBe(1);
			const recoveredOwnership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
			const recoveredOpening = openTrackedAuthority(
				{ path: recoveredOwnership.paths.sqlite, identity, create: false },
				recoveredOwnership,
			);
			const recovered = await recoveredOpening.promise;
			expect(await recovered.recoveryState()).toMatchObject({ owner: { phase: "ready" } });
			await recovered.close();
		} finally {
			await opening.close();
		}
	});
	it("admits authorized committed operation and resource completions through a saturated drain", async () => {
		const client = await makeAuthorityClient();
		const operationId = crypto.randomUUID();
		const resourceId = crypto.randomUUID();
		const entered = Promise.withResolvers<void>();
		const continueScope = Promise.withResolvers<void>();
		const scope = withAuthorityEffect(client, async () => {
			await client.transition(operationRecord(operationId, 1, "intent"));
			await client.transition(operationRecord(operationId, 2, "effect"));
			await client.transition(resourceRecord(operationId, resourceId, 3, "intent"));
			await client.transition(resourceRecord(operationId, resourceId, 4, "effect"));
			entered.resolve();
			await continueScope.promise;
			const quiescingFailure = await observeRejection(
				client.transition(operationRecord(crypto.randomUUID(), 5, "intent")),
			);
			expect(quiescingFailure.message).toMatch(/quiescing|closed/);
			await client.transition(operationRecord(operationId, 5, "committed"));
			await client.transition(resourceRecord(operationId, resourceId, 6, "committed"));
			await client.transition(resourceRecord(operationId, resourceId, 7, "completed"));
			await client.transition(operationRecord(operationId, 8, "completed"));
		});
		await entered.promise;
		const acceptedReads = Array.from({ length: AUTHORITY_RESOURCE_CAPS.maxNormalOutstandingPerSession }, (_, index) =>
			client.getRoot(`drain-${index}`),
		);
		const overLimitFailure = await observeRejection(client.getRoot("drain-over-limit"));
		expect(overLimitFailure.message).toMatch(/queue is full/);
		const closing = client.close();
		continueScope.resolve();
		await scope;
		await Promise.all(acceptedReads);
		await closing;
	});
	it("drains accepted requests before closing when normal and completion capacity are saturated", async () => {
		const client = await makeAuthorityClient();
		const acceptedReads = Array.from({ length: AUTHORITY_RESOURCE_CAPS.maxNormalOutstandingPerSession }, (_, index) =>
			client.getRoot(`shutdown-root-${index}`),
		);
		const acceptedCompletions = Array.from(
			{ length: AUTHORITY_RESOURCE_CAPS.maxReservedCompletionCount },
			(_, index) => client.resolveReceipt(`drain-receipt-${index}`),
		);
		const closing = client.close();
		const drained = await Promise.all([...acceptedReads, ...acceptedCompletions]);
		expect(drained).toHaveLength(AUTHORITY_RESOURCE_CAPS.maxOutstandingPerSession);
		await closing;
	});
	it("classifies oversized real worker responses and preserves mutation request identity", async () => {
		const readClient = await makeAuthorityClient();
		const previousLimit = AUTHORITY_RESOURCE_CAPS.maxResponseBytes;
		try {
			Reflect.set(AUTHORITY_RESOURCE_CAPS, "maxResponseBytes", 1);
			const oversizedReadFailure = await observeRejection(readClient.recoveryState());
			expect(oversizedReadFailure).toMatchObject({ unknownOutcome: false });
		} finally {
			Reflect.set(AUTHORITY_RESOURCE_CAPS, "maxResponseBytes", previousLimit);
		}
		await readClient.close();

		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "root-uuid",
			incarnation: crypto.randomUUID(),
			format: 2 as const,
		};
		const mutationClient = await AuthorityRpcClient.open(
			{ path: ownership.paths.jsonl, identity, create: true },
			ownership,
		);
		clients.push(mutationClient);
		try {
			Reflect.set(AUTHORITY_RESOURCE_CAPS, "maxResponseBytes", 1);
			const oversizedMutationFailure = await observeRejection(
				mutationClient.transition(operationRecord("oversized-response-operation", 1, "intent"), {
					requestId: "oversized-response-request",
				}),
			);
			expect(oversizedMutationFailure).toMatchObject({
				requestId: "oversized-response-request",
				unknownOutcome: true,
			});
		} finally {
			Reflect.set(AUTHORITY_RESOURCE_CAPS, "maxResponseBytes", previousLimit);
		}
		await mutationClient.close();
		const recoveredOwnership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
		const recovered = await AuthorityRpcClient.open(
			{ path: recoveredOwnership.paths.jsonl, identity, create: false },
			recoveredOwnership,
		);
		clients.push(recovered);
		expect(await recovered.resolveReceipt("oversized-response-request")).toMatchObject({
			requestId: "oversized-response-request",
		});
		await recovered.close();
	});
	it("counts map entries in recovery responses against the structured-clone byte budget", () => {
		const recovery = {
			roots: new Map([["root", { record: "x".repeat(512) }]]),
			actors: new Map(),
		};
		expect(() => assertAuthorityWireBudget(recovery, 128)).toThrow(/response exceeds/);
	});
});

describe("authority backend configuration", () => {
	it("accepts only the exact persisted backend tokens and defaults unset to JSONL", () => {
		expect(parseJournalingBackend(undefined)).toBe("jsonl");
		expect(parseJournalingBackend("jsonl")).toBe("jsonl");
		expect(parseJournalingBackend("sqlite")).toBe("sqlite");
		for (const invalid of ["", " JSONL", "jsonl ", "JSONL", "SQLITE", "sqlite\n", "postgres"]) {
			expect(() => parseJournalingBackend(invalid)).toThrow(/OMP_JOURNALING_BACKEND/);
		}
	});
	it("isolates process-start environment caching from the test runner", async () => {
		const child = spawnAuthorityProcess("env");
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(await child.exited, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ invalidRejected: true, parsed: "sqlite", cached: "sqlite" });
	});
	it("installs the durable legacy denial fence before exposing a fresh v2 store", async () => {
		const directory = await makeDirectory();
		const manager = SessionManager.create(directory, directory);
		const session = manager.getSessionFile();
		try {
			if (!session) throw new Error("Expected a newly allocated persistent SessionManager root");
			sessions.push(session);
			await manager.ensureOnDisk();
			const owningSessionId = manager.getSessionId();
			const store = await registryDurableStateForSession(session, { owningSessionId, create: true });
			expect(store.identity.owningSessionId).toBe(owningSessionId);
			const paths = authorityPaths(session);
			const fenceStat = await fs.stat(paths.legacyFence);
			expect(fenceStat.mode & 0o777).toBe(0o600);
			expect(await fs.readFile(paths.legacyFence, "utf8")).toBe(LEGACY_AUTHORITY_DENIAL_REASON);
			const legacy = new RegistryDurableStateStore(paths.legacy);
			expect(legacy.available).toBe(false);
			expect(legacy.quarantineReason).toMatch(/authority v2/i);
		} finally {
			try {
				await manager.close();
			} finally {
				if (session) await closeSessionAuthority(session);
			}
		}
	});
	it("retains the exact opened client when post-open anchor association fails", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const paths = authorityPaths(session);
		const descriptorBefore = await fs.readFile(paths.descriptor, "utf8");
		const associationFailure = new Error("injected post-open anchor lstat failure");
		// Force deferred anchor association without fabricating production allocation evidence.
		const lstatSpy = spyOn(fs, "lstat").mockRejectedValueOnce(
			Object.assign(new Error("defer anchor lookup"), { code: "ENOENT" }),
		);
		const open = AuthorityRpcClient.open;
		let opened: AuthorityRpcClient | undefined;
		const openSpy = spyOn(AuthorityRpcClient, "open").mockImplementation(async (driver, ownership, factory) => {
			opened = await open(driver, ownership, factory);
			lstatSpy.mockRejectedValueOnce(associationFailure);
			return opened;
		});
		try {
			const associationOutcome = await observeRejection(registryDurableStateForSession(session));
			expect(associationOutcome).toBe(associationFailure);
			expect(opened).toBeDefined();
			if (!opened) throw new Error("Fault did not occur after successful worker opening");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const scope = withAuthorityEffect(opened, async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			let closed = false;
			const closing = closeSessionAuthority(session).then(() => {
				closed = true;
			});
			try {
				await expect(acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" })).rejects.toThrow(
					/ownership|lock/i,
				);
				expect(closed).toBe(false);
			} finally {
				release.resolve();
				await scope;
				await closing;
			}
			const closedClientFailure = await observeRejection(opened.getRoot("closed-exact-client"));
			expect(closedClientFailure.message).toMatch(/closed|quiescing/);
			expect(await fs.readFile(paths.descriptor, "utf8")).toBe(descriptorBefore);
			const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
			await ownership.release();
		} finally {
			lstatSpy.mockRestore();
			openSpy.mockRestore();
			await closeSessionAuthority(session);
			await opened?.close();
		}
	});
	it("reopens a usable canonical store after direct close through an alias", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const alias = path.join(directory, "direct-close-alias.jsonl");
		await fs.symlink(session, alias);
		const first = await registryDurableStateForSession(session);
		expect(await registryDurableStateForSession(alias)).toBe(first);
		expect(await first.getRoot("before-direct-close")).toBeUndefined();
		await first.close();
		const reopened = await registryDurableStateForSession(alias);
		expect(reopened).not.toBe(first);
		expect(await registryDurableStateForSession(session)).toBe(reopened);
		expect(await reopened.getRoot("after-direct-close")).toBeUndefined();
		await closeSessionAuthority(session);
	});
	it("joins the canonical cleanup when an alias closes while its opening is still pending", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const alias = path.join(directory, "pending-alias.jsonl");
		await fs.symlink(session, alias);
		const primary = registryDurableStateForSession(session);
		const aliased = registryDurableStateForSession(alias);
		const closing = closeSessionAuthority(alias);
		const [first, second] = await Promise.all([primary, aliased]);
		expect(second).toBe(first);
		await closing;
		const reopened = await registryDurableStateForSession(session);
		expect(reopened).not.toBe(first);
		expect(await reopened.getRoot("reopened-after-pending-alias-close")).toBeUndefined();
		await closeSessionAuthority(session);
	});
	it("shares root and alias close through callback drain and delayed ownership release", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const alias = path.join(directory, "close-alias.jsonl");
		await fs.symlink(session, alias);
		const releaseEntered = Promise.withResolvers<void>();
		const releaseAllowed = Promise.withResolvers<void>();
		const acquire = ownershipMethods.acquireAuthorityOwnership;
		let releases = 0;
		const spy = spyOn(ownershipMethods, "acquireAuthorityOwnership").mockImplementation(async (file, options) => {
			const ownership = await acquire(file, options);
			return {
				...ownership,
				async release() {
					releases++;
					releaseEntered.resolve();
					await releaseAllowed.promise;
					await ownership.release();
				},
			};
		});
		const callbackEntered = Promise.withResolvers<void>();
		const callbackAllowed = Promise.withResolvers<void>();
		try {
			const store = await registryDurableStateForSession(session);
			expect(await registryDurableStateForSession(alias)).toBe(store);
			const callback = withAuthorityEffect(store, async () => {
				callbackEntered.resolve();
				await callbackAllowed.promise;
			});
			await callbackEntered.promise;
			const reads = Array.from({ length: AUTHORITY_RESOURCE_CAPS.maxNormalOutstandingPerSession }, (_, index) =>
				store.getRoot(`shared-close-${index}`),
			);
			let completed = 0;
			const first = closeSessionAuthority(session).then(() => {
				completed++;
			});
			const second = closeSessionAuthority(alias).then(() => {
				completed++;
			});
			expect(releases).toBe(0);
			callbackAllowed.resolve();
			await callback;
			await Promise.all(reads);
			await releaseEntered.promise;
			const third = store.close().then(() => {
				completed++;
			});
			await Promise.resolve();
			expect(completed).toBe(0);
			expect(releases).toBe(1);
			releaseAllowed.resolve();
			await Promise.all([first, second, third]);
			expect(completed).toBe(3);
			expect(releases).toBe(1);
		} finally {
			callbackAllowed.resolve();
			releaseAllowed.resolve();
			spy.mockRestore();
			await closeSessionAuthority(session);
		}
	});
	it("shares rejected ownership release with all close callers in an isolated host", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const child = spawnAuthorityProcess("close-release-reject", session);
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(await child.exited, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			samePromise: true,
			prematureSuccess: false,
			releases: 1,
			failures: [
				"injected ownership release failure",
				"injected ownership release failure",
				"injected ownership release failure",
			],
			sameFailure: true,
		});
	});
	it("retains resolver ownership when client construction and cleanup both fail", async () => {
		const testName = "retains resolver ownership when client construction and cleanup both fail";
		const directory = await makeDirectory();
		if (process.env[isolatedFixtureNameEnvironment] !== testName) {
			await runIsolatedAuthorityFixture(testName, directory);
			return;
		}
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		await prepareActiveJsonlAuthority(session);
		const paths = authorityPaths(session);
		const payload = await fs.readFile(paths.jsonl);
		const originalFailure = new Error("injected resolver client initialization failure");
		const cleanupFailure = new Error("injected resolver ownership release failure");
		const releaseEntered = Promise.withResolvers<void>();
		const releaseAllowed = Promise.withResolvers<void>();
		let acquired: AuthorityOwnership | undefined;
		let releases = 0;
		let firstCloseSettled = false;
		let secondCloseSettled = false;
		const acquire = ownershipMethods.acquireAuthorityOwnership;
		const ownershipSpy = spyOn(ownershipMethods, "acquireAuthorityOwnership").mockImplementation(
			async (file, options) => {
				const ownership = await acquire(file, options);
				acquired = ownership;
				return {
					...ownership,
					async release() {
						releases++;
						releaseEntered.resolve();
						await releaseAllowed.promise;
						throw cleanupFailure;
					},
				};
			},
		);
		const uuidSpy = spyOn(crypto, "randomUUID").mockImplementationOnce(() => {
			throw originalFailure;
		});
		try {
			const openingOutcome = registryDurableStateForSession(session).then(
				() => undefined,
				error => error,
			);
			const firstCloseOutcome = closeSessionAuthority(session).then(
				() => {
					firstCloseSettled = true;
					return undefined;
				},
				error => {
					firstCloseSettled = true;
					return error;
				},
			);
			const secondCloseOutcome = closeSessionAuthority(session).then(
				() => {
					secondCloseSettled = true;
					return undefined;
				},
				error => {
					secondCloseSettled = true;
					return error;
				},
			);
			await releaseEntered.promise;
			await Promise.resolve();
			expect(firstCloseSettled).toBe(false);
			expect(secondCloseSettled).toBe(false);
			expect(releases).toBe(1);
			releaseAllowed.resolve();
			const [openingFailure, firstCloseFailure, secondCloseFailure] = await Promise.all([
				openingOutcome,
				firstCloseOutcome,
				secondCloseOutcome,
			]);
			expect(openingFailure).toBeInstanceOf(AggregateError);
			expect((openingFailure as AggregateError).errors).toEqual([originalFailure, cleanupFailure]);
			expect(firstCloseFailure).toBe(openingFailure);
			expect(secondCloseFailure).toBe(openingFailure);
			expect(await observeRejection(closeSessionAuthority(session))).toBe(openingFailure);
			expect(releases).toBe(1);
			await expect(AuthorityRpcClient.closeFailedOpen("root-uuid")).resolves.toBe(false);
			await expect(fs.readFile(paths.jsonl)).resolves.toEqual(payload);
			await expect(acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" })).rejects.toThrow(
				/ownership|lock/i,
			);
		} finally {
			releaseAllowed.resolve();
			uuidSpy.mockRestore();
			ownershipSpy.mockRestore();
			await acquired?.release();
			expect(await observeRejection(closeSessionAuthority(session))).toBeDefined();
		}
	});
	it("retains resolver ownership when worker construction and release both fail", async () => {
		const testName = "retains resolver ownership when worker construction and release both fail";
		const directory = await makeDirectory();
		if (process.env[isolatedFixtureNameEnvironment] !== testName) {
			await runIsolatedAuthorityFixture(testName, directory);
			return;
		}
		const session = path.join(directory, "worker-factory.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		await prepareActiveJsonlAuthority(session);
		const paths = authorityPaths(session);
		const payload = await fs.readFile(paths.jsonl);
		const originalFailure = new Error("injected resolver worker factory failure");
		const cleanupFailure = new Error("injected resolver worker ownership release failure");
		let acquired: AuthorityOwnership | undefined;
		let releases = 0;
		const acquire = ownershipMethods.acquireAuthorityOwnership;
		const ownershipSpy = spyOn(ownershipMethods, "acquireAuthorityOwnership").mockImplementation(
			async (file, options) => {
				const ownership = await acquire(file, options);
				acquired = ownership;
				return {
					...ownership,
					async release() {
						releases++;
						throw cleanupFailure;
					},
				};
			},
		);
		const open = AuthorityRpcClient.open.bind(AuthorityRpcClient);
		const openSpy = spyOn(AuthorityRpcClient, "open").mockImplementation((options, ownership) =>
			open(options, ownership, () => {
				throw originalFailure;
			}),
		);
		try {
			let openingFailure: unknown;
			try {
				await registryDurableStateForSession(session);
			} catch (error) {
				openingFailure = error;
			}
			expect(openingFailure).toBeInstanceOf(AggregateError);
			expect((openingFailure as AggregateError).errors).toEqual([originalFailure, cleanupFailure]);
			expect(await AuthorityRpcClient.closeFailedOpen("root-uuid")).toBe(false);
			await expect(fs.readFile(paths.jsonl)).resolves.toEqual(payload);
			expect<unknown>(await observeRejection(closeSessionAuthority(session))).toBe(openingFailure);
			expect(releases).toBe(1);
		} finally {
			openSpy.mockRestore();
			ownershipSpy.mockRestore();
			await acquired?.release();
			expect(await observeRejection(closeSessionAuthority(session))).toBeDefined();
		}
	});
	it("retains resolver ownership when admission refusal cleanup rejects", async () => {
		const testName = "retains resolver ownership when admission refusal cleanup rejects";
		const directory = await makeDirectory();
		if (process.env[isolatedFixtureNameEnvironment] !== testName) {
			await runIsolatedAuthorityFixture(testName, directory);
			return;
		}
		const session = path.join(directory, "target.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		await prepareActiveJsonlAuthority(session);
		const paths = authorityPaths(session);
		const payload = await fs.readFile(paths.jsonl);
		for (let index = 0; index < AUTHORITY_RESOURCE_CAPS.maxWorkersPerProcess; index++) {
			const blockerSession = path.join(directory, `blocker-${index}.jsonl`);
			const owningSessionId = `blocker-${index}`;
			await fs.writeFile(blockerSession, `{"type":"session","id":"${owningSessionId}"}\n`);
			const ownership = await acquireAuthorityOwnership(blockerSession, { owningSessionId, create: true });
			const client = await AuthorityRpcClient.open(
				{
					path: ownership.paths.jsonl,
					identity: { backend: "jsonl", owningSessionId, incarnation: crypto.randomUUID(), format: 2 },
					create: true,
				},
				ownership,
			);
			clients.push(client);
		}
		const cleanupFailure = new Error("injected admission ownership release failure");
		let acquired: AuthorityOwnership | undefined;
		let releases = 0;
		const acquire = ownershipMethods.acquireAuthorityOwnership;
		const ownershipSpy = spyOn(ownershipMethods, "acquireAuthorityOwnership").mockImplementation(
			async (file, options) => {
				const ownership = await acquire(file, options);
				acquired = ownership;
				return {
					...ownership,
					async release() {
						releases++;
						throw cleanupFailure;
					},
				};
			},
		);
		try {
			let openingFailure: unknown;
			try {
				await registryDurableStateForSession(session);
			} catch (error) {
				openingFailure = error;
			}
			expect(openingFailure).toBeInstanceOf(AggregateError);
			const openingErrors = (openingFailure as AggregateError).errors;
			expect(openingErrors).toHaveLength(2);
			expect(openingErrors[0]).toBeInstanceOf(Error);
			expect((openingErrors[0] as Error).message).toMatch(/active roots/);
			expect(openingErrors[1]).toBe(cleanupFailure);
			expect(await AuthorityRpcClient.closeFailedOpen("root-uuid")).toBe(false);
			await expect(fs.readFile(paths.jsonl)).resolves.toEqual(payload);
			expect<unknown>(await observeRejection(closeSessionAuthority(session))).toBe(openingFailure);
			expect(releases).toBe(1);
			await expect(acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" })).rejects.toThrow(
				/ownership|lock/i,
			);
		} finally {
			ownershipSpy.mockRestore();
			await acquired?.release();
			expect(await observeRejection(closeSessionAuthority(session))).toBeDefined();
		}
	});
	it("cleans up a known failed worker open without changing selected payload evidence", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const paths = authorityPaths(session);
		await fs.writeFile(paths.jsonl, "malformed selected authority payload\n", { mode: 0o600 });
		const failedPayload = await fs.readFile(paths.jsonl, "utf8");
		const malformedOpeningFailure = await observeRejection(registryDurableStateForSession(session));
		expect(malformedOpeningFailure.message).toMatch(/authority|header|JSON|format/i);
		await closeSessionAuthority(session);
		const repeatedOpeningFailure = await observeRejection(registryDurableStateForSession(session));
		expect(repeatedOpeningFailure.message).toMatch(/authority|header|JSON|format/i);
		await closeSessionAuthority(session);
		expect(await fs.readFile(paths.jsonl, "utf8")).toBe(failedPayload);
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid" });
		await ownership.release();
	});
	it("rejects an independent process opening a hardlink alias of an owned root", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const alias = path.join(directory, "hardlink.jsonl");
		expect((await fs.statfs(session)).type).toBe(0x58465342);
		const owner = spawnAuthorityProcess("hold", session);
		try {
			expect(await readAuthorityProcessMessage(owner.stdout)).toMatchObject({ acquired: true });
			await fs.link(session, alias);
			const contender = spawnAuthorityProcess("try", alias);
			const contenderMessage = await readAuthorityProcessMessage(contender.stdout);
			expect(contenderMessage.acquired).toBe(false);
			expect(contenderMessage.error).toMatch(/link|regular/i);
			expect(await contender.exited).toBe(0);
		} finally {
			if (!owner.stdin) throw new Error("Authority owner process has no release pipe");
			owner.stdin.write("release\n");
			owner.stdin.end();
			expect(await owner.exited).toBe(0);
		}
	});
	it("refuses xfs-capacity ownership on unsupported Linux mount types before parsing session data", async () => {
		if (os.platform() !== "linux") return;
		const procFile = "/proc/self/status";
		expect((await fs.statfs(procFile)).type).not.toBe(0x58465342);
		await expect(acquireAuthorityOwnership(procFile, { create: true, capacity: "xfs" })).rejects.toThrow(
			/OMP_JOURNALING_CAPACITY=xfs requires the session directory on XFS/,
		);
	});
	it("requires matching transcript UUID evidence before creating or adopting authority", async () => {
		// Opening without creation evidence now adopts evidence-free roots (authority-adoption.test.ts);
		// a mismatched UUID must still refuse on both paths before any artifact exists.
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const mismatchedResumeFailure = await observeRejection(
			registryDurableStateForSession(session, { owningSessionId: "other-uuid" }),
		);
		expect(mismatchedResumeFailure.message).toMatch(/UUID mismatch/);
		await closeSessionAuthority(session);
		const mismatchedRootFailure = await observeRejection(
			registryDurableStateForSession(session, { owningSessionId: "other-uuid", create: true }),
		);
		expect(mismatchedRootFailure.message).toMatch(/UUID mismatch/);
		const paths = authorityPaths(session);
		for (const artifact of [paths.lock, paths.descriptor, paths.jsonl, paths.sqlite]) {
			expect(await fs.stat(artifact).catch(() => undefined)).toBeUndefined();
		}
	});
	it("refuses to initialize over a legacy journal or its retained denial fence", async () => {
		for (const suffix of ["authority-v1.jsonl", "authority-v1.jsonl.quarantine"]) {
			const directory = await makeDirectory();
			const session = path.join(directory, "root.jsonl");
			await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
			const legacyPath = `${session}.${suffix}`;
			const evidence = `preserve:${suffix}\n`;
			await fs.writeFile(legacyPath, evidence, { mode: 0o600 });
			const legacyUpgradeFailure = await observeRejection(
				registryDurableStateForSession(session, { owningSessionId: "root-uuid", create: true }),
			);
			expect(legacyUpgradeFailure.message).toMatch(/legacy|upgrade|authority/i);
			expect(await fs.readFile(legacyPath, "utf8")).toBe(evidence);
			const paths = authorityPaths(session);
			for (const createdPath of [paths.descriptor, paths.jsonl, paths.sqlite]) {
				expect(await fs.stat(createdPath).catch(() => undefined)).toBeUndefined();
			}
		}
	});

	it("keeps the persisted backend when the environment changes and coalesces aliased opens", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const previous = process.env.OMP_JOURNALING_BACKEND;
		const cachedDefault = validateJournalingEnvironment();
		process.env.OMP_JOURNALING_BACKEND = cachedDefault === "jsonl" ? "sqlite" : "jsonl";
		const alias = path.join(directory, "alias.jsonl");
		await fs.symlink(session, alias);
		try {
			const [first, second, third] = await Promise.all([
				registryDurableStateForSession(session),
				registryDurableStateForSession(alias),
				registryDurableStateForSession(session),
			]);
			expect(first.identity.backend).toBe("jsonl");
			expect(second).toBe(first);
			expect(third).toBe(first);
		} finally {
			await closeSessionAuthority(session);
			if (previous === undefined) delete process.env.OMP_JOURNALING_BACKEND;
			else process.env.OMP_JOURNALING_BACKEND = previous;
		}
	});
	it("rejects missing or unrecognized selected-store legacy denial fences", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const fence = authorityPaths(session).legacyFence;
		await fs.rm(fence);
		const denialFenceFailure = await observeRejection(registryDurableStateForSession(session));
		expect(denialFenceFailure.message).toMatch(/denial fence/i);
		await closeSessionAuthority(session);
		await fs.writeFile(fence, "unrecognized quarantine\n", { mode: 0o600 });
		const unknownFenceFailure = await observeRejection(registryDurableStateForSession(session));
		expect(unknownFenceFailure.message).toMatch(/denial fence/i);
		expect(await fs.readFile(fence, "utf8")).toBe("unrecognized quarantine\n");
	});
	it("rejects multiply linked transcripts and anchors without modifying the bundle", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const transcriptAlias = path.join(directory, "hardlink.jsonl");
		await fs.link(session, transcriptAlias);
		const linkedTranscriptFailure = await observeRejection(registryDurableStateForSession(session));
		expect(linkedTranscriptFailure.message).toMatch(/link|regular/i);
		await closeSessionAuthority(session);
		await fs.unlink(transcriptAlias);
		const anchor = authorityPaths(session).lock;
		await fs.link(anchor, path.join(directory, "anchor-link"));
		const linkedAnchorFailure = await observeRejection(registryDurableStateForSession(session));
		expect(linkedAnchorFailure.message).toMatch(/link|anchor/i);
	});
	it("refuses a replaced selected anchor while keeping the original supervisor reachable", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		await registryDurableStateForSession(session);
		const anchor = authorityPaths(session).lock;
		await fs.rename(anchor, `${anchor}.original`);
		await fs.writeFile(anchor, "", { mode: 0o600 });
		const replacedAnchorFailure = await observeRejection(registryDurableStateForSession(session));
		expect(replacedAnchorFailure.message).toMatch(/anchor|identity/i);
		await closeSessionAuthority(session);
		const stillReplacedAnchorFailure = await observeRejection(registryDurableStateForSession(session));
		expect(stillReplacedAnchorFailure.message).toMatch(/anchor|identity/i);
	});
	it("rejects missing selected payloads and ambiguous backend payloads without recreation", async () => {
		const missingDirectory = await makeDirectory();
		const missingSession = await makeSession(missingDirectory);
		await prepareActiveJsonlAuthority(missingSession);
		const missingPaths = authorityPaths(missingSession);
		await fs.rm(missingPaths.jsonl);
		const missingPayloadFailure = await observeRejection(
			registryDurableStateForSession(missingSession, { create: true }),
		);
		expect(missingPayloadFailure.message).toMatch(/payload is missing/);
		// No recover command rebuilds a lost payload, so the refusal names the documented manual procedure instead.
		expect(missingPayloadFailure).toBeInstanceOf(AuthorityRecoveryRequiredError);
		expect((missingPayloadFailure as AuthorityRecoveryRequiredError).command).toBeUndefined();
		expect(missingPayloadFailure.message).toContain(
			`"Refused authority stores" in docs/session-operations-export-share-fork-resume.md`,
		);
		expect(missingPayloadFailure.message).not.toContain("\n");
		expect(await fs.stat(missingPaths.jsonl).catch(() => undefined)).toBeUndefined();

		const ambiguousDirectory = await makeDirectory();
		const ambiguousSession = await makeSession(ambiguousDirectory);
		await prepareActiveJsonlAuthority(ambiguousSession);
		const ambiguousPaths = authorityPaths(ambiguousSession);
		await fs.writeFile(ambiguousPaths.sqlite, "ambiguous", { mode: 0o600 });
		const ambiguousPayloadFailure = await observeRejection(registryDurableStateForSession(ambiguousSession));
		expect(ambiguousPayloadFailure.message).toMatch(/Ambiguous authority payloads/);
		expect(ambiguousPayloadFailure).toBeInstanceOf(AuthorityRecoveryRequiredError);
		expect(ambiguousPayloadFailure.message).toContain(
			`"Refused authority stores" in docs/session-operations-export-share-fork-resume.md`,
		);
	});
	it("refuses a descriptor that is still initializing with the --recover abort command that recovers it", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		await prepareActiveJsonlAuthority(session);
		const descriptorPath = authorityPaths(session).descriptor;
		const active = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as Record<string, unknown>;
		await fs.writeFile(descriptorPath, `${JSON.stringify({ ...active, revision: 1, state: "initializing" })}\n`, {
			mode: 0o600,
		});
		const failure = await observeRejection(registryDurableStateForSession(session));
		expect(failure).toBeInstanceOf(AuthorityRecoveryRequiredError);
		const command = sessionAuthorityCommand(await canonicalAuthoritySession(session), "--recover abort");
		expect((failure as AuthorityRecoveryRequiredError).command).toBe(command);
		expect(failure.message).toContain(command);
	});
	it("rejects a copied UUID in an independent process without fresh allocation evidence", async () => {
		const directory = await makeDirectory();
		const first = await makeSession(directory, "first.jsonl");
		await prepareActiveJsonlAuthority(first);
		const copy = path.join(directory, "copy.jsonl");
		await fs.copyFile(first, copy);
		const owner = spawnAuthorityProcess("hold", first);
		try {
			expect(await readAuthorityProcessMessage(owner.stdout)).toMatchObject({ acquired: true });
			const contender = spawnAuthorityProcess("try", copy);
			const contenderMessage = await readAuthorityProcessMessage(contender.stdout);
			expect(contenderMessage.acquired).toBe(false);
			expect(contenderMessage.error).toMatch(/allocation/i);
			expect(await contender.exited).toBe(0);
			const paths = authorityPaths(copy);
			for (const artifact of [paths.lock, paths.descriptor, paths.jsonl, paths.sqlite])
				expect(await fs.stat(artifact).catch(() => undefined)).toBeUndefined();
		} finally {
			if (!owner.stdin) throw new Error("Authority owner process has no release pipe");
			owner.stdin.write("release\n");
			owner.stdin.end();
			expect(await owner.exited).toBe(0);
		}
	});
	it("refuses a complete copied bundle across processes both during and after source ownership", async () => {
		const sourceDirectory = await makeDirectory();
		const targetDirectory = await makeDirectory();
		const session = await makeSession(sourceDirectory);
		await prepareActiveJsonlAuthority(session);
		const names = (await fs.readdir(sourceDirectory)).sort();
		for (const name of names) await fs.copyFile(path.join(sourceDirectory, name), path.join(targetDirectory, name));
		const copy = path.join(targetDirectory, path.basename(session));
		const before = await Promise.all(names.map(name => fs.readFile(path.join(targetDirectory, name))));
		const owner = spawnAuthorityProcess("hold", session);
		try {
			expect(await readAuthorityProcessMessage(owner.stdout)).toMatchObject({ acquired: true });
			const contender = spawnAuthorityProcess("try", copy);
			const contenderMessage = await readAuthorityProcessMessage(contender.stdout);
			expect(contenderMessage.acquired).toBe(false);
			expect(contenderMessage.error).toMatch(/anchor|physical|identity/i);
			expect(await contender.exited).toBe(0);
		} finally {
			if (!owner.stdin) throw new Error("Authority owner process has no release pipe");
			owner.stdin.write("release\n");
			owner.stdin.end();
			expect(await owner.exited).toBe(0);
		}
		const afterRelease = spawnAuthorityProcess("try", copy);
		const afterReleaseMessage = await readAuthorityProcessMessage(afterRelease.stdout);
		expect(afterReleaseMessage.acquired).toBe(false);
		expect(afterReleaseMessage.error).toMatch(/anchor|physical|identity/i);
		expect(await afterRelease.exited).toBe(0);
		expect((await fs.readdir(targetDirectory)).sort()).toEqual(names);
		expect(await Promise.all(names.map(name => fs.readFile(path.join(targetDirectory, name))))).toEqual(before);
	});
	it("rejects a second root with the same transcript UUID", async () => {
		const directory = await makeDirectory();
		const first = await makeSession(directory, "first.jsonl");
		const second = await makeSession(directory, "second.jsonl");
		await prepareActiveJsonlAuthority(first);
		const store = await registryDurableStateForSession(first);
		try {
			const duplicateRootFailure = await observeRejection(registryDurableStateForSession(second, { create: true }));
			expect(duplicateRootFailure.message).toMatch(/allocation|ownership|lock/i);
		} finally {
			await closeSessionAuthority(first);
		}
		expect(store.identity.owningSessionId).toBe("root-uuid");
	});
	it("retains one supervisor through real symlink compaction rewrites and close/reopen", async () => {
		const directory = await makeDirectory();
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(
			session,
			`${JSON.stringify({ type: "session", version: 3, id: "root-uuid", timestamp: new Date().toISOString(), cwd: directory })}\n`,
		);
		await prepareActiveJsonlAuthority(session);
		const alias = path.join(directory, "compaction-alias.jsonl");
		await fs.symlink(session, alias);
		const manager = await SessionManager.open(alias, directory);
		try {
			const store = await registryDurableStateForSession(alias);
			expect(await registryDurableStateForSession(session)).toBe(store);
			const kept = manager.appendMessage({
				role: "user",
				content: "retain after compaction",
				timestamp: Date.now(),
			});
			const compactionId = manager.appendCompaction("real compacted context", "compacted", kept, 100, {
				tokensAfter: 40,
			});
			await manager.flush();
			const before = await fs.stat(session);
			const compaction = manager.getEntries().find(entry => entry.id === compactionId);
			if (compaction?.type !== "compaction") throw new Error("Expected actual SessionManager compaction entry");
			compaction.tokensAfter = 30;
			await manager.rewriteEntries();
			const after = await fs.stat(session);
			expect(after.ino).not.toBe(before.ino);
			expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
			expect(await fs.realpath(alias)).toBe(session);
			expect(await fs.readFile(alias, "utf8")).toContain('"tokensAfter":30');
			expect(await registryDurableStateForSession(alias)).toBe(store);
			expect(await registryDurableStateForSession(session)).toBe(store);
			const contender = spawnAuthorityProcess("try", alias);
			const contenderMessage = await readAuthorityProcessMessage(contender.stdout);
			expect(contenderMessage.acquired).toBe(false);
			expect(contenderMessage.error).toMatch(/ownership|lock|flock/i);
			expect(await contender.exited).toBe(0);
			const hardlink = path.join(directory, "compacted-hardlink.jsonl");
			await fs.link(session, hardlink);
			try {
				const hardlinkContender = spawnAuthorityProcess("try", hardlink);
				const hardlinkContenderMessage = await readAuthorityProcessMessage(hardlinkContender.stdout);
				expect(hardlinkContenderMessage.acquired).toBe(false);
				expect(hardlinkContenderMessage.error).toMatch(/link|regular/i);
				expect(await hardlinkContender.exited).toBe(0);
			} finally {
				await fs.unlink(hardlink);
			}
			await Promise.all([closeSessionAuthority(alias), closeSessionAuthority(session)]);
			const reopened = await registryDurableStateForSession(alias);
			expect(reopened.identity).toEqual(store.identity);
			await closeSessionAuthority(alias);
		} finally {
			await closeSessionAuthority(session);
			await manager.close();
		}
	});
});

describe("authority descriptor and physical ownership", () => {
	it("canonicalizes aliases to one physical session identity", async () => {
		const directory = await makeDirectory();
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		const alias = path.join(directory, "alias.jsonl");
		await fs.symlink(session, alias);
		expect(await canonicalAuthoritySession(alias)).toBe(await canonicalAuthoritySession(session));
		expect(authorityPaths(alias).descriptor).toBe(`${path.resolve(alias)}.authority.json`);
	});

	it("round-trips a descriptor bound to the lock anchor and refuses traversal payloads", async () => {
		const directory = await makeDirectory();
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		const paths = authorityPaths(session);
		await fs.writeFile(paths.lock, "", { mode: 0o600 });
		const lockStat = await fs.stat(paths.lock);
		const descriptor = {
			version: 1 as const,
			revision: 1,
			owningSessionId: "root-uuid",
			backend: "jsonl" as const,
			format: 2 as const,
			incarnation: "incarnation-1",
			payload: path.basename(paths.jsonl),
			state: "initializing" as const,
			physicalIdentity: { dev: String(lockStat.dev), ino: String(lockStat.ino) },
		};
		await writeAuthorityDescriptor(session, descriptor);
		expect(await readAuthorityDescriptor(session)).toEqual(descriptor);
		await expect(writeAuthorityDescriptor(session, { ...descriptor, payload: "../outside" })).rejects.toThrow();
	});

	it("validates unknown descriptor fields exactly while preserving optional migration IDs", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const paths = authorityPaths(session);
		await fs.writeFile(paths.lock, "", { mode: 0o600 });
		const lockStat = await fs.stat(paths.lock);
		const descriptor = {
			version: 1 as const,
			revision: 1,
			owningSessionId: "root-uuid",
			backend: "jsonl" as const,
			format: 2 as const,
			incarnation: "descriptor-validation-incarnation",
			payload: path.basename(paths.jsonl),
			state: "initializing" as const,
			physicalIdentity: { dev: String(lockStat.dev), ino: String(lockStat.ino) },
		};
		await writeAuthorityDescriptor(session, descriptor);
		const migration = { ...descriptor, revision: 2, state: "migration" as const, migrationId: "migration-1" };
		await writeAuthorityDescriptor(session, migration);
		expect(await readAuthorityDescriptor(session)).toEqual(migration);
		const invalid: readonly unknown[] = [
			null,
			[],
			Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== "incarnation")),
			{ ...descriptor, unexpected: true },
			{ ...descriptor, version: 2 },
			{ ...descriptor, format: 1 },
			{ ...descriptor, backend: "other" },
			{ ...descriptor, revision: "1" },
			{ ...descriptor, owningSessionId: 1 },
			{ ...descriptor, incarnation: 1 },
			{ ...descriptor, payload: 1 },
			{ ...descriptor, state: "other" },
			{ ...descriptor, physicalIdentity: null },
			{ ...descriptor, physicalIdentity: { dev: descriptor.physicalIdentity.dev } },
			{ ...descriptor, physicalIdentity: { ...descriptor.physicalIdentity, ino: 1 } },
			{ ...migration, migrationId: 1 },
			{ ...migration, migrationId: "" },
			{ ...descriptor, migrationId: "not-migrating" },
		];
		for (const value of invalid) {
			const evidence = `${JSON.stringify(value)}\n`;
			await fs.writeFile(paths.descriptor, evidence, { mode: 0o600 });
			await expect(readAuthorityDescriptor(session)).rejects.toThrow(/descriptor/i);
			expect(await fs.readFile(paths.descriptor, "utf8")).toBe(evidence);
		}
	});

	it("fails closed when the lock anchor is replaced by a symlink", async () => {
		const directory = await makeDirectory();
		const session = await makeSession(directory);
		const paths = authorityPaths(session);
		const foreignAnchor = path.join(directory, "foreign-lock");
		await fs.writeFile(foreignAnchor, "foreign", { mode: 0o600 });
		await fs.symlink(foreignAnchor, paths.lock);
		await expect(
			acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true }),
		).rejects.toThrow();
		expect(await fs.readFile(foreignAnchor, "utf8")).toBe("foreign");
	});
	it("does not grant overlapping root ownership in one process", async () => {
		const directory = await makeDirectory();
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = withAuthorityExclusive(
			session,
			async () => {
				entered.resolve();
				await release.promise;
			},
			{ owningSessionId: "root-uuid", create: true },
		);
		await entered.promise;
		await expect(
			withAuthorityExclusive(session, async () => undefined, { owningSessionId: "root-uuid", create: true }),
		).rejects.toThrow(/ownership|lock/i);
		release.resolve();
		await first;
	});
});
