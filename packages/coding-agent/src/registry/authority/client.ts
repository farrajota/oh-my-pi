import { openAuthorityCapacityFile, AuthorityCapacityFileOpenError } from "./capacity";
import type { AuthorityCapacityFile } from "./capacity";
import type { FileHandle } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { workerHostEntry } from "@oh-my-pi/pi-utils";
import type {
	AuthorityActivation,
	AuthorityDriverOptions,
	AuthorityExport,
	AuthorityOwner,
	AuthorityPage,
	AuthorityRecoveryState,
	AuthorityRow,
	AuthorityStore,
	LocalClaim,
	LocalReconciliation,
	LocalReservation,
	MutationOptions,
	MutationReceipt,
	RootTransitionCommit,
} from "./types";
import type {
	DurableActorRecord,
	DurableConstructionRecord,
	DurableGateRecord,
	DurableLocalBackingExpectation,
	DurableLocalEntryRecord,
	DurableLocalHeadRecord,
	DurableLocalPublishResult,
	DurableOperationRecord,
	DurableRegistryRecord,
	DurableResourceRecord,
	DurableRootRecord,
	DurableTransitionRecord,
} from "../durable-state";
import type { AuthorityOwnership } from "./ownership";
import type { JournalingCapacity } from "./journaling-env";
import type { AuthorityRpcCall, AuthorityRpcOpen, AuthorityRpcResponse } from "./types";
import {
	authorityFailureFromEvidence,
	isAuthorityThreadLifetimeMessage,
	pinAuthorityWorker,
	requestAuthorityFailedOpenCleanup,
	waitForAuthorityThreadExit,
} from "./thread-lifetime";
import type { AuthorityFailureEvidence, AuthorityThreadPin } from "./thread-lifetime";

export const AUTHORITY_DIRECT_WORKER_ARG = "__omp_authority_direct_worker";

export const AUTHORITY_RESOURCE_CAPS = {
	maxWorkersPerProcess: 8,
	maxWorkersPerRoot: 1,
	maxSessionsPerProcess: 8,
	maxOutstandingPerSession: 80,
	maxNormalOutstandingPerSession: 64,
	maxNormalQueuedBytesPerSession: 8 * 1024 * 1024,
	maxReservedCompletionCount: 16,
	maxReservedCompletionBytes: 2 * 1024 * 1024,
	maxRequestBytes: 2 * 1024 * 1024,
	maxResponseBytes: 64 * 1024 * 1024,
	/**
	 * Requests sent to the worker before their predecessors are acknowledged, so the worker can group
	 * concurrent mutations into one durable sync. Responses still arrive strictly in request order.
	 */
	maxPipelinedRequests: 64,
	maxQueueAgeMs: 30_000,
	endToEndDeadlineMs: 60_000,
} as const;
const AUTHORITY_READ_METHODS: Partial<Record<AuthorityRpcCall["method"], true>> = {
	getRoot: true,
	getActor: true,
	getActorGeneration: true,
	getConstruction: true,
	getGate: true,
	getOperation: true,
	getTransition: true,
	getResource: true,
	getLocalEntry: true,
	getLocalHead: true,
	listOpen: true,
	listActors: true,
	recoveryState: true,
	validateRevival: true,
	localBacking: true,
	resolveReceipt: true,
	exportState: true,
};

export function isAuthorityReadMethod(method: AuthorityRpcCall["method"]): boolean {
	return AUTHORITY_READ_METHODS[method] === true;
}

type WireFrame =
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "map"; readonly iterator: Iterator<[unknown, unknown]> }
	| { readonly kind: "array"; readonly iterator: Iterator<unknown> };

export function assertAuthorityWireBudget(
	value: unknown,
	maximumBytes = AUTHORITY_RESOURCE_CAPS.maxResponseBytes,
): number {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
		throw new RangeError("Authority wire budget must be a positive safe integer");
	let bytes = 0;
	const seen = new WeakSet<object>();
	const stack: WireFrame[] = [{ kind: "value", value }];
	const count = (amount: number): void => {
		bytes += amount;
		if (bytes > maximumBytes) throw new RangeError(`Authority response exceeds ${maximumBytes} bytes`);
	};
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (frame.kind === "map") {
			const entry = frame.iterator.next();
			if (entry.done) continue;
			stack.push(frame);
			count(8);
			stack.push({ kind: "value", value: entry.value[1] }, { kind: "value", value: entry.value[0] });
			continue;
		}
		if (frame.kind === "array") {
			const entry = frame.iterator.next();
			if (entry.done) continue;
			stack.push(frame, { kind: "value", value: entry.value });
			continue;
		}
		const current = frame.value;
		if (current === null || current === undefined || typeof current === "boolean") {
			count(1);
			continue;
		}
		if (typeof current === "string") {
			count(Buffer.byteLength(current, "utf8") * 6 + 2);
			continue;
		}
		if (typeof current === "number" || typeof current === "bigint") {
			count(8);
			continue;
		}
		if (typeof current !== "object") throw new TypeError("Authority RPC values must be structured-clone-safe data");
		if (seen.has(current)) {
			count(16);
			continue;
		}
		seen.add(current);
		if (current instanceof Map) {
			count(8);
			stack.push({ kind: "map", iterator: current.entries() });
		} else if (Array.isArray(current)) {
			count(8);
			stack.push({ kind: "array", iterator: current.values() });
		} else if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
			count(current.byteLength + 8);
		} else {
			count(8);
			for (const [key, child] of Object.entries(current)) {
				count(Buffer.byteLength(key, "utf8") * 6 + 2);
				stack.push({ kind: "value", value: child });
			}
		}
	}
	return bytes;
}

export class AuthorityRpcError extends Error {
	readonly unknownOutcome: boolean;
	readonly requestId: string;

	constructor(
		message: string,
		requestId: string,
		unknownOutcome: boolean,
		name = "AuthorityRpcError",
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = name;
		this.requestId = requestId;
		this.unknownOutcome = unknownOutcome;
	}
}

type PendingRequest = {
	readonly call: AuthorityRpcCall;
	readonly bytes: number;
	readonly reserved: boolean;
	readonly enqueuedAt: number;
	readonly result: PromiseWithResolvers<unknown>;
	timeout: NodeJS.Timeout;
};

/**
 * A parent failure that already retains a nested effect failure (by identity, through
 * aggregate constituents or cause chains) must not be wrapped again: re-aggregating it
 * would bury the parent's primary cause without preserving anything new.
 */
function carriesError(error: unknown, target: unknown): boolean {
	const pending = [error];
	const seen = new Set<unknown>();
	for (let index = 0; index < pending.length; index++) {
		const current = pending[index];
		if (current === target) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		if (current instanceof AggregateError) pending.push(...current.errors);
		if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
	}
	return false;
}

class EffectScopes {
	readonly #context = new AsyncLocalStorage<symbol>();
	readonly #activeScopes = new Set<symbol>();
	readonly #acceptingScopes = new Set<symbol>();
	readonly #children = new Map<
		symbol,
		Array<Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>>
	>();
	#closing = false;
	#drained: PromiseWithResolvers<void> | undefined;

	run<T>(run: () => Promise<T>): Promise<T> {
		const result = this.#run(run);
		void result.catch(() => {});
		return result;
	}

	async #run<T>(run: () => Promise<T>): Promise<T> {
		if (this.#closing) throw new Error("Authority root is closing and no longer admits external effects");
		const parent = this.#context.getStore();
		if (parent !== undefined && !this.#acceptingScopes.has(parent)) {
			throw new Error("Authority effect scope is no longer active");
		}
		const token = Symbol("authority-effect");
		const children: Array<Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>> = [];
		const completed = Promise.withResolvers<
			{ readonly ok: true } | { readonly ok: false; readonly error: unknown }
		>();
		this.#activeScopes.add(token);
		this.#acceptingScopes.add(token);
		this.#children.set(token, children);
		if (parent !== undefined) this.#children.get(parent)?.push(completed.promise);

		let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
		try {
			outcome = { ok: true, value: await this.#context.run(token, run) };
		} catch (error) {
			outcome = { ok: false, error };
		}
		this.#acceptingScopes.delete(token);
		try {
			for (let index = 0; index < children.length; index++) {
				const child = await children[index];
				if (!child.ok && (outcome.ok || !carriesError(outcome.error, child.error))) {
					outcome = outcome.ok
						? { ok: false, error: child.error }
						: {
								ok: false,
								error: new AggregateError(
									[outcome.error, child.error],
									"Authority effect and nested effect both failed.",
								),
							};
				}
			}
		} finally {
			this.#children.delete(token);
			this.#activeScopes.delete(token);
			completed.resolve(outcome.ok ? { ok: true } : { ok: false, error: outcome.error });
			if (this.#activeScopes.size === 0) this.#drained?.resolve();
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}

	async stopAndDrain(): Promise<void> {
		this.#closing = true;
		if (this.#activeScopes.size === 0) return;
		this.#drained ??= Promise.withResolvers<void>();
		await this.#drained.promise;
	}

	/**
	 * Starts `run` with no enclosing effect scope, so effects it later admits become root-level scopes instead of
	 * nested ones. It works the same whether the caller's scope still accepts or has settled: detached work never
	 * inherits the caller's scope or operation lease, and every effect it admits is its own root-level scope, which
	 * close drains and a closing root refuses. A late detach therefore gains nothing a call from outside any scope
	 * could not already do, so it is not refused; only a late effect that tries to nest in a settled scope is.
	 */
	detach<T>(run: () => T): T {
		return this.#context.exit(run);
	}

	get currentScopeActive(): boolean {
		const token = this.#context.getStore();
		return token !== undefined && this.#activeScopes.has(token);
	}
}

const effectScopes = new WeakMap<AuthorityStore, EffectScopes>();
const liveClients = new Set<AuthorityRpcClient>();
const unavailableClients = new Set<AuthorityRpcClient>();

interface PendingSetupCleanup {
	readonly handle?: FileHandle;
	readonly ownership: AuthorityOwnership;
	handleClosed: boolean;
	ownershipReleased: boolean;
}

const pendingSetupCleanups = new Map<string, PendingSetupCleanup[]>();

async function retryPendingSetupCleanup(owningSessionId: string): Promise<boolean> {
	const cleanups = pendingSetupCleanups.get(owningSessionId);
	const cleanup = cleanups?.[0];
	if (!cleanup) return false;
	if (!cleanup.handleClosed && cleanup.handle) {
		await cleanup.handle.close();
		cleanup.handleClosed = true;
	}
	if (!cleanup.ownershipReleased) {
		await cleanup.ownership.release();
		cleanup.ownershipReleased = true;
	}
	cleanups!.shift();
	if (cleanups!.length === 0) pendingSetupCleanups.delete(owningSessionId);
	return true;
}

export function withAuthorityEffect<T>(store: AuthorityStore, run: () => Promise<T>): Promise<T> {
	const scopes = effectScopes.get(store);
	if (!scopes) throw new Error("Authority effect scope requires a live host-managed authority store");
	return scopes.run(run);
}

/**
 * Runs `run` outside the caller's authority effect scope for `store`. The work keeps the same root authority handle;
 * each effect it admits afterwards is its own root-level scope, joined by nothing the caller owns.
 */
export function detachFromAuthorityEffect<T>(store: AuthorityStore, run: () => T): T {
	const scopes = effectScopes.get(store);
	if (!scopes) throw new Error("Authority effect detachment requires a live host-managed authority store");
	return scopes.detach(run);
}

export class AuthorityRpcClient implements AuthorityStore {
	readonly identity: AuthorityStore["identity"];
	/** The recovery file the worker's open kept when it cut an interrupted JSONL append's tail; undefined otherwise. */
	tailRecoveryFile: string | undefined;
	readonly #driverOptions: AuthorityDriverOptions;
	readonly #workerFactory: () => Worker;
	readonly #ownership: AuthorityOwnership;
	readonly #capacityFile: AuthorityCapacityFile | undefined;
	#worker: Worker;
	readonly #effects = new EffectScopes();
	readonly #openRequestId = crypto.randomUUID();
	readonly #queue: PendingRequest[] = [];
	readonly #openResult = Promise.withResolvers<AuthorityRpcResponse>();
	#capacityFileClosed = false;
	#requestsDrained: PromiseWithResolvers<void> | undefined;
	#owner: AuthorityOwner | undefined;
	// Sent to the worker and not yet answered, in request order (the worker answers in the same order).
	readonly #inFlight: PendingRequest[] = [];
	#threadPin: AuthorityThreadPin | undefined;
	#failedOpenRecoveryRequired = false;
	#failedOpenError: AuthorityRpcError | undefined;
	#failedOpenCleanupPending = false;
	#failedOpenCleanupAcknowledged = false;
	#failedOpenFailureEvidence: readonly AuthorityFailureEvidence[] = [];
	#failedOpenCleanupComplete = false;
	#normalBytes = 0;
	#reservedCount = 0;
	#normalCount = 0;
	#reservedBytes = 0;
	#opening = true;
	#closed = false;
	#closing = false;
	#closePromise: Promise<void> | undefined;
	#ownershipRelease: Promise<void> | undefined;
	#failure: AuthorityRpcError | undefined;
	#workerCleanupComplete = false;
	#onClosed: (() => void) | undefined;
	// Workers this client terminated itself; their close event is expected, not a failure.
	readonly #terminatedWorkers = new WeakSet<Worker>();

	private constructor(
		options: AuthorityDriverOptions,
		ownership: AuthorityOwnership,
		workerFactory: () => Worker,
		capacityFile: AuthorityCapacityFile | undefined,
	) {
		this.identity = options.identity;
		// Without a capacity file the driver admits writes with no physical reserve; the live owner still
		// takes the backend's single-writer settings.
		const { capacity: _callerCapacity, ...driver } = options;
		this.#driverOptions = capacityFile
			? {
					...driver,
					identity: { ...options.identity },
					liveOwner: true,
					capacity: { identity: capacityFile.identity, maxRequestBytes: AUTHORITY_RESOURCE_CAPS.maxRequestBytes },
				}
			: { ...driver, identity: { ...options.identity }, liveOwner: true };
		this.#ownership = ownership;
		this.#capacityFile = capacityFile;
		this.#workerFactory = workerFactory;
		this.#worker = workerFactory();
	}

	/**
	 * Opens the root's worker. `capacity` is the runtime admission policy: `off` (default) opens no
	 * capacity backing and passes the driver no capacity option; `xfs` opens the anonymous O_TMPFILE
	 * capacity file the worker funds physical reserve from (Linux x86_64 on XFS only). `openDeadlineMs` bounds the
	 * worker's startup and open; an open that outlives it stops its worker (see #stopTimedOutOpen).
	 */
	static async open(
		options: AuthorityDriverOptions,
		ownership: AuthorityOwnership,
		workerFactory: () => Worker = createAuthorityWorker,
		capacity: JournalingCapacity = "off",
		openDeadlineMs: number = AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
	): Promise<AuthorityRpcClient> {
		let rootWorkers = 0;
		for (const client of liveClients) {
			if (client.identity.owningSessionId === options.identity.owningSessionId) rootWorkers++;
		}
		if (rootWorkers >= AUTHORITY_RESOURCE_CAPS.maxWorkersPerRoot) {
			const failure = new Error(
				`Authority root ${options.identity.owningSessionId} already has ${AUTHORITY_RESOURCE_CAPS.maxWorkersPerRoot} live worker`,
			);
			try {
				await ownership.release();
			} catch (cleanupError) {
				throw new AggregateError(
					[failure, cleanupError],
					"Authority admission failed and ownership cleanup failed",
				);
			}
			throw failure;
		}
		if (
			liveClients.size >=
			Math.min(AUTHORITY_RESOURCE_CAPS.maxWorkersPerProcess, AUTHORITY_RESOURCE_CAPS.maxSessionsPerProcess)
		) {
			const failure = new Error(
				`Authority worker/session limit of ${AUTHORITY_RESOURCE_CAPS.maxSessionsPerProcess} active roots was reached`,
			);
			try {
				await ownership.release();
			} catch (cleanupError) {
				throw new AggregateError(
					[failure, cleanupError],
					"Authority admission failed and ownership cleanup failed",
				);
			}
			throw failure;
		}
		let capacityFile: AuthorityCapacityFile | undefined;
		let client: AuthorityRpcClient;
		try {
			if (capacity === "xfs") capacityFile = await openAuthorityCapacityFile(path.dirname(options.path));
			client = new AuthorityRpcClient(options, ownership, workerFactory, capacityFile);
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			const retainedHandle =
				capacityFile?.handle ?? (error instanceof AuthorityCapacityFileOpenError ? error.handle : undefined);
			let handleClosed = retainedHandle === undefined;
			if (retainedHandle) {
				try {
					await retainedHandle.close();
					handleClosed = true;
				} catch (closeError) {
					cleanupErrors.push(closeError);
				}
			}
			let ownershipReleased = false;
			if (handleClosed) {
				try {
					await ownership.release();
					ownershipReleased = true;
				} catch (releaseError) {
					cleanupErrors.push(releaseError);
				}
			}
			if (cleanupErrors.length > 0) {
				// A rejected ownership release is terminal: its issuer retains the lock, and a
				// retry here would release it twice. Only an unclosed handle stays retryable.
				if (!handleClosed) {
					const pending = pendingSetupCleanups.get(options.identity.owningSessionId) ?? [];
					pending.push({
						...(retainedHandle ? { handle: retainedHandle } : {}),
						ownership,
						handleClosed,
						ownershipReleased,
					});
					pendingSetupCleanups.set(options.identity.owningSessionId, pending);
					throw new AggregateError(
						[error, ...cleanupErrors],
						"Authority capacity/client setup failed and exact cleanup remains available for retry",
					);
				}
				throw new AggregateError(
					[error, ...cleanupErrors],
					"Authority capacity/client setup failed and ownership release was rejected",
				);
			}
			throw error;
		}
		effectScopes.set(client, client.#effects);
		liveClients.add(client);
		const worker = client.#worker;
		let openAttempted = false;
		let timedOut: AuthorityRpcError | undefined;
		try {
			worker.addEventListener("message", event => client.#handleMessage(event.data));
			worker.addEventListener("messageerror", () =>
				client.#fail("Authority worker delivered an unreadable response", true),
			);
			worker.addEventListener("error", event =>
				client.#fail(event.message || "Authority worker exited unexpectedly", true),
			);
			// A worker can also exit with no error event and no response (a native crash, process.exit() in the
			// worker). Fail every pending request then, as an unknown outcome, instead of at its 60 s deadline.
			worker.addEventListener("close", () => {
				if (!client.#terminatedWorkers.has(worker))
					client.#fail("Authority worker exited without responding", true);
			});
			const open: AuthorityRpcOpen = {
				kind: "open",
				id: client.#openRequestId,
				driver: client.#driverOptions,
				ownerToken: crypto.randomUUID(),
			};
			const deadline = Date.now() + openDeadlineMs;
			client.#threadPin = await pinAuthorityWorker(worker, deadline);
			// A throwing send may have reached the worker; local setup cannot have opened a store.
			openAttempted = true;
			worker.postMessage(open);
			const openTimeout = setTimeout(
				() => {
					timedOut = new AuthorityRpcError("Authority worker open timed out", open.id, true, "TimeoutError");
					client.#openResult.reject(timedOut);
				},
				Math.max(0, deadline - Date.now()),
			);
			let response: AuthorityRpcResponse;
			try {
				response = await client.#openResult.promise;
			} finally {
				clearTimeout(openTimeout);
			}
			if (!response.ok) throw toRpcError(response);
			if (!isOpenedValue(response.value, options.identity))
				throw new AuthorityRpcError("Authority worker opened an inconsistent store identity", open.id, true);
			client.#owner = response.value.recovery.owner;
			client.tailRecoveryFile = response.value.recoveredTail;
			return client;
		} catch (error) {
			if (timedOut !== undefined && error === timedOut)
				throw await client.#stopTimedOutOpen(timedOut, openDeadlineMs);
			const failure = error instanceof AuthorityRpcError ? error : client.#failure;
			if (openAttempted && (failure?.unknownOutcome ?? true)) {
				const unresolved =
					failure ??
					new AuthorityRpcError(
						error instanceof Error ? error.message : String(error),
						client.#openRequestId,
						true,
						"AuthorityOpenError",
						error,
					);
				client.#failedOpenError = unresolved;
				client.#failedOpenRecoveryRequired = true;
				client.#fail(unresolved.message, true, undefined, unresolved);
				throw unresolved;
			}
			try {
				client.#closePromise ??= client.#closeRejectedOpen(openAttempted);
				await client.#closePromise;
			} catch (cleanupError) {
				const retainedFailure = withWorkerFailureEvidence(error, client.#failedOpenFailureEvidence);
				const cause = new AggregateError(
					[retainedFailure, cleanupError],
					"Authority worker open cleanup did not complete",
				);
				const message = `Authority worker open failed and cleanup remains uncertain: ${cause.message}`;
				client.#fail(message, true, undefined, cause);
				throw new AuthorityRpcError(message, client.#openRequestId, true, "AuthorityOpenCleanupError", cause);
			}
			throw withWorkerFailureEvidence(error, client.#failedOpenFailureEvidence);
		}
	}

	static async closeFailedOpen(owningSessionId: string): Promise<boolean> {
		if (await retryPendingSetupCleanup(owningSessionId)) return true;
		for (const client of unavailableClients) {
			if (client.identity.owningSessionId !== owningSessionId) continue;
			if (client.#failedOpenRecoveryRequired) {
				const closing = client.close();
				try {
					await closing;
				} catch (error) {
					// Only explicit failed-opening cleanup retries; ordinary close stays memoized.
					if (client.#failedOpenRecoveryRequired && client.#closePromise === closing)
						client.#closePromise = undefined;
					throw error;
				}
			} else if (client.#failedOpenCleanupPending || client.#failedOpenCleanupAcknowledged)
				await client.#retryFailedOpenCleanup();
			else if (client.#failedOpenCleanupComplete || client.#workerCleanupComplete) {
				await client.#releaseOwnership();
				client.#onClosed?.();
			} else await client.close();
			return true;
		}
		return false;
	}

	transition(record: DurableRegistryRecord, options?: MutationOptions): Promise<MutationReceipt> {
		return this.#invoke("transition", [record, withStableRequest(options)]);
	}

	transitionBatch(records: readonly DurableRegistryRecord[], options?: MutationOptions): Promise<MutationReceipt> {
		return this.#invoke("transitionBatch", [records, withStableRequest(options)]);
	}

	activateAuthority(input: AuthorityActivation, options?: MutationOptions): Promise<MutationReceipt> {
		return this.#invoke("activateAuthority", [input, withStableRequest(options)]);
	}

	commitRootTransition(input: RootTransitionCommit, options?: MutationOptions): Promise<MutationReceipt> {
		return this.#invoke("commitRootTransition", [input, withStableRequest(options)]);
	}

	getRoot(rootId: string): Promise<AuthorityRow<DurableRootRecord> | undefined> {
		return this.#invoke("getRoot", [rootId]);
	}

	getActor(actorId: string): Promise<AuthorityRow<DurableActorRecord> | undefined> {
		return this.#invoke("getActor", [actorId]);
	}

	getActorGeneration(actorId: string, generation: number): Promise<AuthorityRow<DurableActorRecord> | undefined> {
		return this.#invoke("getActorGeneration", [actorId, generation]);
	}

	getConstruction(
		rootId: string,
		actorId: string,
		generation: number,
	): Promise<AuthorityRow<DurableConstructionRecord> | undefined> {
		return this.#invoke("getConstruction", [rootId, actorId, generation]);
	}

	getGate(rootId: string): Promise<AuthorityRow<DurableGateRecord> | undefined> {
		return this.#invoke("getGate", [rootId]);
	}

	getOperation(
		ownerId: string,
		effectClass: DurableOperationRecord["effectClass"],
		operationId: string,
	): Promise<AuthorityRow<DurableOperationRecord> | undefined> {
		return this.#invoke("getOperation", [ownerId, effectClass, operationId]);
	}

	getTransition(rootId: string, transitionId: string): Promise<AuthorityRow<DurableTransitionRecord> | undefined> {
		return this.#invoke("getTransition", [rootId, transitionId]);
	}

	getResource(
		actorId: string,
		generation: number,
		resourceId: string,
	): Promise<AuthorityRow<DurableResourceRecord> | undefined> {
		return this.#invoke("getResource", [actorId, generation, resourceId]);
	}

	getLocalEntry(
		localId: string,
		entryId: string,
		version: number,
	): Promise<AuthorityRow<DurableLocalEntryRecord> | undefined> {
		return this.#invoke("getLocalEntry", [localId, entryId, version]);
	}

	getLocalHead(localId: string): Promise<AuthorityRow<DurableLocalHeadRecord> | undefined> {
		return this.#invoke("getLocalHead", [localId]);
	}

	listOpen(domain: Parameters<AuthorityStore["listOpen"]>[0], after?: string, limit?: number): Promise<AuthorityPage> {
		return this.#invoke("listOpen", [domain, after, limit]);
	}

	listActors(
		rootId: string,
		rootGeneration: number,
		after?: string,
		limit?: number,
	): Promise<AuthorityPage<DurableActorRecord>> {
		return this.#invoke("listActors", [rootId, rootGeneration, after, limit]);
	}

	recover(): Promise<AuthorityRecoveryState> {
		return this.#invoke<AuthorityRecoveryState>("recover", []).then(result => {
			this.#owner = result.owner;
			return result;
		});
	}

	recoveryState(): Promise<AuthorityRecoveryState> {
		return this.#invoke("recoveryState", []);
	}

	validateRevival(input: Parameters<AuthorityStore["validateRevival"]>[0]): Promise<boolean> {
		return this.#invoke("validateRevival", [input]);
	}

	reserveLocal(input: LocalReservation, options?: MutationOptions): Promise<LocalClaim> {
		return this.#invoke("reserveLocal", [input, withStableRequest(options)]);
	}

	authorizeLocalEffect(claim: LocalClaim, options?: MutationOptions): Promise<MutationReceipt> {
		return this.#invoke("authorizeLocalEffect", [claim, withStableRequest(options)]);
	}

	finalizeLocal(
		claim: LocalClaim,
		outcome: "committed" | "uncertain",
		options?: MutationOptions,
	): Promise<DurableLocalPublishResult> {
		return this.#invoke("finalizeLocal", [claim, outcome, withStableRequest(options)], true);
	}

	reconcileLocal(input: LocalReconciliation, options?: MutationOptions): Promise<MutationReceipt> {
		return this.#invoke("reconcileLocal", [input, withStableRequest(options)], true);
	}

	localBacking(localId: string): Promise<DurableLocalBackingExpectation | null> {
		return this.#invoke("localBacking", [localId]);
	}

	resolveReceipt(
		requestId: string,
		epoch?: number,
		incarnation?: string,
		payloadHash?: string,
	): Promise<MutationReceipt | undefined> {
		return this.#invoke("resolveReceipt", [requestId, epoch, incarnation, payloadHash], true);
	}

	quarantine(reason: string): Promise<never> {
		return this.#invoke("quarantine", [reason], true);
	}

	exportState(): Promise<AuthorityExport> {
		return this.#invoke("exportState", []);
	}

	onClosed(callback: () => void): void {
		this.#onClosed = callback;
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		const closing = this.#close().catch(error => {
			// Worker/driver close failures stay retryable on the same worker; an attempted
			// ownership release is terminal and shared by every later close caller.
			if (!this.#closed && this.#ownershipRelease === undefined) this.#closePromise = undefined;
			throw error;
		});
		this.#closePromise = closing;
		return closing;
	}

	async #close(): Promise<void> {
		this.#closing = true;
		await this.#effects.stopAndDrain();
		await this.#drainAcceptedRequests();
		if (!this.#workerCleanupComplete) {
			// Known close refusals keep this exact worker available; only unknown
			// transport outcomes enter the existing fenced replacement path.
			if (this.#failure) await this.#closeAfterWorkerFailure();
			else {
				await this.#invoke("close", [], true, true);
				this.#terminateWorker();
				await this.#waitForPinnedThreadExit();
				this.#workerCleanupComplete = true;
			}
		}
		await this.#releaseOwnership();
		this.#onClosed?.();
	}

	async #closeRejectedOpen(openAttempted: boolean): Promise<void> {
		this.#closing = true;
		if (openAttempted) {
			if (!this.#threadPin) throw new Error("Authority open was sent without a confirmed native thread pin");
			try {
				this.#failedOpenFailureEvidence = await this.#requestFailedOpenCleanup(
					Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
				);
				this.#failedOpenCleanupAcknowledged = true;
			} catch (error) {
				this.#failedOpenCleanupPending = true;
				throw error;
			}
		}
		this.#terminateWorker();
		if (this.#threadPin) await this.#waitForPinnedThreadExit();
		else if (openAttempted) await this.#waitForPinnedThreadExit();
		this.#failedOpenCleanupPending = false;
		this.#failedOpenCleanupAcknowledged = false;
		this.#failedOpenCleanupComplete = true;
		await this.#releaseOwnership();
	}

	/**
	 * An open that outlived its deadline. Its worker may still be replaying the store or changing it (the open's
	 * recovery commit, a segment rotation), and while it works synchronously it reads no message, so it can be
	 * neither asked to clean up nor left running: it is terminated, its exact thread exit is confirmed, and only
	 * then are the capacity backing and ownership released. What it wrote before it stopped is unknown, so the
	 * open is an unknown outcome; every write an open makes is crash-safe, so the next open recovers the store as
	 * it would after a crash at the same point. The client stays registered as a failed open whose cleanup is
	 * complete, so closeFailedOpen (which closeSessionAuthority runs for an unknown open) acknowledges it once.
	 * If the exit cannot be confirmed, ownership stays held and closeFailedOpen waits on the same pin again.
	 */
	async #stopTimedOutOpen(timeout: AuthorityRpcError, deadlineMs: number): Promise<AuthorityRpcError> {
		this.#closing = true;
		this.#fail(timeout.message, true, undefined, timeout);
		this.#terminateWorker();
		try {
			await this.#waitForPinnedThreadExit();
		} catch (exitError) {
			// No worker-local cleanup remains (the worker was terminated); a retry only re-waits for the exit.
			this.#failedOpenCleanupPending = true;
			this.#failedOpenCleanupAcknowledged = true;
			const cause = new AggregateError(
				[timeout, exitError],
				"Authority worker open timed out and its exit could not be confirmed",
			);
			return new AuthorityRpcError(
				`Authority worker open exceeded its ${deadlineMs} ms deadline; the worker was terminated but its exit could not be confirmed, so ownership stays held until AuthorityRpcClient.closeFailedOpen confirms it`,
				this.#openRequestId,
				true,
				"AuthorityOpenCleanupError",
				cause,
			);
		}
		this.#failedOpenCleanupComplete = true;
		try {
			await this.#releaseHeldResources();
		} catch (releaseError) {
			const cause = new AggregateError(
				[timeout, releaseError],
				"Authority worker open timed out and its resource release failed",
			);
			return new AuthorityRpcError(
				`Authority worker open exceeded its ${deadlineMs} ms deadline; the worker was terminated and its exit confirmed, but releasing its capacity backing or ownership failed`,
				this.#openRequestId,
				true,
				"AuthorityOpenCleanupError",
				cause,
			);
		}
		// The root has no live worker any more, so a new open of it is admitted.
		this.#closed = true;
		liveClients.delete(this);
		effectScopes.delete(this);
		return new AuthorityRpcError(
			`Authority worker open exceeded its ${deadlineMs} ms deadline; the worker was terminated, its exit confirmed and ownership released. The open may have changed the store before it stopped (its recovery commit or a segment rotation); the next open recovers it.`,
			this.#openRequestId,
			true,
			"TimeoutError",
			timeout,
		);
	}

	async #retryFailedOpenCleanup(): Promise<void> {
		if (!this.#failedOpenCleanupAcknowledged) {
			this.#failedOpenFailureEvidence = await this.#requestFailedOpenCleanup(
				Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
			);
			this.#failedOpenCleanupAcknowledged = true;
		}
		await this.#waitForPinnedThreadExit();
		this.#failedOpenCleanupPending = false;
		this.#failedOpenCleanupAcknowledged = false;
		this.#failedOpenCleanupComplete = true;
		await this.#releaseOwnership();
	}

	/** The worker exits by itself after acknowledging failed-open cleanup, so its close event is expected. */
	#requestFailedOpenCleanup(deadline: number): Promise<readonly AuthorityFailureEvidence[]> {
		this.#terminatedWorkers.add(this.#worker);
		return requestAuthorityFailedOpenCleanup(this.#worker, deadline);
	}

	#terminateWorker(): void {
		this.#terminatedWorkers.add(this.#worker);
		this.#worker.terminate();
	}

	async #waitForPinnedThreadExit(pin = this.#threadPin): Promise<void> {
		if (!pin) throw new Error("Authority worker has no confirmed native thread pin");
		await waitForAuthorityThreadExit(pin, Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs);
	}

	/** Closes the capacity backing, then releases ownership; the ownership release is attempted at most once. */
	async #releaseHeldResources(): Promise<void> {
		if (!this.#capacityFileClosed) {
			await this.#capacityFile?.handle.close();
			this.#capacityFileClosed = true;
		}
		await (this.#ownershipRelease ??= this.#ownership.release());
	}

	async #releaseOwnership(): Promise<void> {
		await this.#releaseHeldResources();
		this.#closed = true;
		liveClients.delete(this);
		unavailableClients.delete(this);
		effectScopes.delete(this);
	}
	async #drainAcceptedRequests(): Promise<void> {
		const drained = (this.#requestsDrained ??= Promise.withResolvers<void>());
		this.#resolveRequestsDrained();
		await drained.promise;
	}

	#resolveRequestsDrained(): void {
		if (this.#inFlight.length > 0 || this.#queue.length > 0) return;
		const drained = this.#requestsDrained;
		this.#requestsDrained = undefined;
		drained?.resolve();
	}

	async #closeAfterWorkerFailure(): Promise<void> {
		if (
			!this.#failedOpenRecoveryRequired &&
			(this.#failedOpenCleanupPending || this.#failedOpenCleanupAcknowledged)
		) {
			if (!this.#failedOpenCleanupAcknowledged) {
				this.#failedOpenFailureEvidence = await this.#requestFailedOpenCleanup(
					Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
				);
				this.#failedOpenCleanupAcknowledged = true;
			}
			await this.#waitForPinnedThreadExit();
			this.#failedOpenCleanupPending = false;
			this.#failedOpenCleanupAcknowledged = false;
			this.#threadPin = undefined;
			this.#failedOpenRecoveryRequired = false;
			this.#failedOpenCleanupComplete = true;
			this.#workerCleanupComplete = true;
			return;
		}
		if (this.#failedOpenRecoveryRequired && !this.#failedOpenCleanupAcknowledged) {
			// UNKNOWN opening still owns worker-local construction/persistence cleanup.
			// Its failure must leave that same worker and native pin available for retry.
			this.#failedOpenFailureEvidence = await this.#requestFailedOpenCleanup(
				Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
			);
			this.#failedOpenCleanupAcknowledged = true;
			// Cleanup can finish after rejection: enrich the error the caller already holds.
			if (this.#failedOpenError) withWorkerFailureEvidence(this.#failedOpenError, this.#failedOpenFailureEvidence);
		}
		this.#terminateWorker();
		await this.#waitForPinnedThreadExit();
		this.#failedOpenRecoveryRequired = false;
		this.#failedOpenCleanupAcknowledged = false;
		this.#threadPin = undefined;
		const worker = this.#workerFactory();
		this.#worker = worker;
		let replacementPin: AuthorityThreadPin | undefined;
		let cleanupPending = false;
		let durableClosed = false;
		try {
			const openId = crypto.randomUUID();
			const open: AuthorityRpcOpen = {
				kind: "open",
				id: openId,
				driver: {
					path: this.#driverOptions.path,
					identity: this.#driverOptions.identity,
					...(this.#driverOptions.capacity ? { capacity: this.#driverOptions.capacity } : {}),
					liveOwner: true,
					create: false,
				},
				ownerToken: crypto.randomUUID(),
			};
			const deadline = Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs;
			replacementPin = await pinAuthorityWorker(worker, deadline);
			this.#threadPin = replacementPin;
			try {
				const openResponse = await sendAuthorityRequest(worker, open);
				if (!openResponse.ok) throw toRpcError(openResponse);
				if (!isOpenedValue(openResponse.value, this.identity))
					throw new AuthorityRpcError(
						"Recovered authority worker identity disagrees with the pinned descriptor",
						openId,
						true,
					);
				const closeId = crypto.randomUUID();
				const close: AuthorityRpcCall = {
					kind: "call",
					id: closeId,
					method: "close",
					args: [],
					owner: openResponse.value.recovery.owner,
					deadline: Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
				};
				const closeResponse = await sendAuthorityRequest(worker, close);
				if (!closeResponse.ok) throw toRpcError(closeResponse);
				durableClosed = true;
			} catch (error) {
				let evidence: readonly AuthorityFailureEvidence[] = [];
				try {
					evidence = await requestAuthorityFailedOpenCleanup(
						worker,
						Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
					);
					this.#failedOpenFailureEvidence = evidence;
				} catch (cleanupError) {
					cleanupPending = true;
					this.#failedOpenCleanupPending = true;
					throw new AggregateError(
						[error, cleanupError],
						"Authority replacement worker failed and retained its cleanup capability",
					);
				}
				throw withWorkerFailureEvidence(error, evidence);
			}
		} finally {
			if (!cleanupPending) {
				worker.terminate();
				if (replacementPin) {
					await waitForAuthorityThreadExit(
						replacementPin,
						Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
					);
					// Native retirement alone cannot discharge an uncertain durable close.
					this.#workerCleanupComplete = durableClosed;
				}
			}
		}
	}

	#invoke<T>(
		method: AuthorityRpcCall["method"],
		args: readonly unknown[],
		reserved = false,
		allowedWhenClosing = false,
	): Promise<T> {
		if (this.#failure) return Promise.reject(this.#failure);
		const completion = reserved || isCompletionCall(method, args);
		if (
			this.#closed ||
			(this.#closing && !allowedWhenClosing && (!this.#effects.currentScopeActive || !completion))
		) {
			return Promise.reject(new Error("Authority store is closed or quiescing"));
		}
		if (!this.#owner) return Promise.reject(new Error("Authority store has not completed worker recovery"));
		const id = crypto.randomUUID();
		const call: AuthorityRpcCall = {
			kind: "call",
			id,
			method,
			args,
			owner: this.#owner,
			deadline: Date.now() + AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs,
		};
		const bytes = Buffer.byteLength(JSON.stringify(call), "utf8");
		if (bytes > AUTHORITY_RESOURCE_CAPS.maxRequestBytes) {
			return Promise.reject(
				new RangeError(`Authority request exceeds ${AUTHORITY_RESOURCE_CAPS.maxRequestBytes} bytes`),
			);
		}
		if (this.#queue.length + this.#inFlight.length >= AUTHORITY_RESOURCE_CAPS.maxOutstandingPerSession) {
			return Promise.reject(new RangeError("Authority request queue is full"));
		}
		if (completion) {
			if (
				this.#reservedCount >= AUTHORITY_RESOURCE_CAPS.maxReservedCompletionCount ||
				this.#reservedBytes + bytes > AUTHORITY_RESOURCE_CAPS.maxReservedCompletionBytes
			) {
				return Promise.reject(new RangeError("Authority completion reserve is full"));
			}
		} else if (
			this.#normalCount >= AUTHORITY_RESOURCE_CAPS.maxNormalOutstandingPerSession ||
			this.#normalBytes + bytes > AUTHORITY_RESOURCE_CAPS.maxNormalQueuedBytesPerSession
		) {
			return Promise.reject(new RangeError("Authority request queue is full"));
		}
		const result = Promise.withResolvers<unknown>();
		const enqueuedAt = Date.now();
		const pending: PendingRequest = {
			call,
			bytes,
			reserved: completion,
			enqueuedAt,
			result,
			timeout: setTimeout(() => this.#timeout(pending), AUTHORITY_RESOURCE_CAPS.maxQueueAgeMs),
		};
		if (completion) {
			this.#reservedCount++;
			this.#reservedBytes += bytes;
		} else {
			this.#normalCount++;
			this.#normalBytes += bytes;
		}
		this.#queue.push(pending);
		this.#pump();
		return result.promise as Promise<T>;
	}

	#pump(): void {
		while (
			!this.#failure &&
			!this.#closed &&
			this.#queue.length > 0 &&
			this.#inFlight.length < AUTHORITY_RESOURCE_CAPS.maxPipelinedRequests
		) {
			const pending = this.#queue.shift()!;
			if (Date.now() - pending.enqueuedAt > AUTHORITY_RESOURCE_CAPS.maxQueueAgeMs) {
				clearTimeout(pending.timeout);
				this.#releaseCapacity(pending);
				pending.result.reject(
					new AuthorityRpcError(
						"Authority request exceeded maximum queue age",
						durableRequestId(pending.call),
						false,
						"TimeoutError",
					),
				);
				continue;
			}
			clearTimeout(pending.timeout);
			const remainingDeadline = pending.call.deadline - Date.now();
			if (remainingDeadline <= 0) {
				this.#releaseCapacity(pending);
				pending.result.reject(
					new AuthorityRpcError(
						"Authority request exceeded end-to-end deadline before worker admission",
						durableRequestId(pending.call),
						false,
						"TimeoutError",
					),
				);
				continue;
			}
			pending.timeout = setTimeout(() => this.#timeout(pending), remainingDeadline);
			this.#inFlight.push(pending);
			try {
				this.#worker.postMessage(pending.call);
			} catch (error) {
				this.#fail(error instanceof Error ? error.message : String(error), true, pending, error);
				return;
			}
		}
		this.#resolveRequestsDrained();
	}
	#handleMessage(value: unknown): void {
		if (isAuthorityThreadLifetimeMessage(value)) return;
		if (!isRpcResponse(value)) {
			this.#fail(
				"Authority worker response is malformed",
				this.#opening || this.#inFlight.length > 0,
				this.#inFlight[0],
			);
			return;
		}
		if (value.id === this.#openRequestId) {
			this.#opening = false;
			try {
				assertAuthorityWireBudget(value);
				this.#openResult.resolve(value);
			} catch (error) {
				this.#openResult.reject(error);
			}
			return;
		}
		const pending = this.#inFlight[0];
		if (!pending || value.id !== pending.call.id) {
			this.#fail(
				"Authority worker response does not match the ordered request",
				this.#opening || pending !== undefined,
				pending,
			);
			return;
		}
		try {
			assertAuthorityWireBudget(value);
		} catch (error) {
			this.#fail(
				error instanceof Error ? error.message : String(error),
				!isAuthorityReadMethod(pending.call.method),
				pending,
				error,
			);
			return;
		}
		if (!value.ok && value.error.unknownOutcome) {
			this.#fail(value.error.message, true, pending);
			return;
		}
		clearTimeout(pending.timeout);
		this.#inFlight.shift();
		this.#releaseCapacity(pending);
		// The worker exits by itself right after acknowledging a durable close.
		if (value.ok && pending.call.method === "close") this.#terminatedWorkers.add(this.#worker);
		if (value.ok) pending.result.resolve(value.value);
		else pending.result.reject(toRpcError(value, pending.call));
		this.#pump();
	}

	#timeout(pending: PendingRequest): void {
		if (!this.#inFlight.includes(pending)) {
			const index = this.#queue.indexOf(pending);
			if (index < 0) return;
			this.#queue.splice(index, 1);
			this.#releaseCapacity(pending);
			pending.result.reject(
				new AuthorityRpcError(
					"Authority request exceeded queue age or end-to-end deadline before worker admission",
					durableRequestId(pending.call),
					false,
					"TimeoutError",
				),
			);
			this.#pump();
			return;
		}
		this.#fail("Authority request exceeded end-to-end deadline with an unknown commit outcome", true, pending);
	}

	#fail(message: string, unknownOutcome: boolean, failing?: PendingRequest, cause?: unknown): void {
		if (this.#failure) return;
		const requestId = failing ? durableRequestId(failing.call) : this.#openRequestId;
		this.#failure = new AuthorityRpcError(message, requestId, unknownOutcome, "AuthorityRpcError", cause);
		unavailableClients.add(this);
		for (const request of this.#inFlight.splice(0)) {
			clearTimeout(request.timeout);
			this.#releaseCapacity(request);
			// A request already sent may have been staged and synced with the failing one's group; only a
			// read has no durable outcome to be unknown about.
			const outcome =
				request === failing ? unknownOutcome : unknownOutcome || !isAuthorityReadMethod(request.call.method);
			request.result.reject(
				new AuthorityRpcError(message, durableRequestId(request.call), outcome, "AuthorityRpcError", cause),
			);
		}
		for (const queued of this.#queue.splice(0)) {
			clearTimeout(queued.timeout);
			this.#releaseCapacity(queued);
			queued.result.reject(
				new AuthorityRpcError(
					"Authority worker became unavailable before request admission",
					durableRequestId(queued.call),
					false,
				),
			);
		}
		this.#resolveRequestsDrained();
		this.#openResult.resolve({
			id: this.#openRequestId,
			ok: false,
			error: { name: this.#failure.name, message, unknownOutcome },
		});
	}

	#releaseCapacity(pending: PendingRequest): void {
		if (pending.reserved) {
			this.#reservedCount--;
			this.#reservedBytes -= pending.bytes;
		} else {
			this.#normalCount--;
			this.#normalBytes -= pending.bytes;
		}
	}
}

function withStableRequest(options?: MutationOptions): MutationOptions {
	return { ...options, requestId: options?.requestId ?? crypto.randomUUID() };
}

function isCompletionCall(method: AuthorityRpcCall["method"], args: readonly unknown[]): boolean {
	if (
		method === "finalizeLocal" ||
		method === "reconcileLocal" ||
		method === "commitRootTransition" ||
		method === "recover" ||
		method === "quarantine" ||
		method === "close" ||
		method === "resolveReceipt"
	)
		return true;
	if (method === "transition") return args[0] !== undefined && isCompletionRecord(args[0]);
	if (method === "transitionBatch")
		return Array.isArray(args[0]) && args[0].length > 0 && args[0].every(isCompletionRecord);
	return false;
}

function isCompletionRecord(value: unknown): value is DurableRegistryRecord {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	switch (value.kind) {
		case "root":
			return "state" in value && (value.state === "retired" || value.state === "invalidated");
		case "actor":
			return "state" in value && (value.state === "retired" || value.state === "aborted");
		case "construction":
			return "phase" in value && (value.phase === "activated" || value.phase === "abandoned");
		case "gate":
			return "phase" in value && value.phase === "closed";
		case "operation":
			return (
				"phase" in value &&
				(value.phase === "committed" ||
					value.phase === "completed" ||
					value.phase === "failed" ||
					value.phase === "abandoned" ||
					value.phase === "cancelled")
			);
		case "transition":
			return "phase" in value && (value.phase === "retired" || value.phase === "recovered");
		case "resource":
			return (
				"phase" in value &&
				(value.phase === "committed" ||
					value.phase === "completed" ||
					value.phase === "cancelled" ||
					value.phase === "abandoned")
			);
		case "local-entry":
			return (
				"phase" in value &&
				(value.phase === "committed" || value.phase === "conflict" || value.phase === "cancelled")
			);
		case "local-head":
			return false;
	}
	return false;
}

function isRpcResponse(value: unknown): value is AuthorityRpcResponse {
	if (
		typeof value !== "object" ||
		value === null ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("ok" in value) ||
		typeof value.ok !== "boolean"
	)
		return false;
	if (value.ok) return "value" in value;
	if (!("error" in value)) return false;
	const error = value.error;
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		typeof error.name === "string" &&
		"message" in error &&
		typeof error.message === "string" &&
		"unknownOutcome" in error &&
		typeof error.unknownOutcome === "boolean"
	);
}

function isOpenedValue(
	value: unknown,
	identity: AuthorityStore["identity"],
): value is { identity: AuthorityStore["identity"]; recovery: AuthorityRecoveryState; recoveredTail?: string } {
	if (
		typeof value === "object" &&
		value !== null &&
		"recoveredTail" in value &&
		typeof value.recoveredTail !== "string"
	)
		return false;
	return (
		typeof value === "object" &&
		value !== null &&
		"identity" in value &&
		isIdentity(value.identity) &&
		value.identity.backend === identity.backend &&
		value.identity.owningSessionId === identity.owningSessionId &&
		value.identity.incarnation === identity.incarnation &&
		value.identity.format === identity.format &&
		"recovery" in value &&
		isRecovery(value.recovery)
	);
}

function isIdentity(value: unknown): value is AuthorityStore["identity"] {
	return (
		typeof value === "object" &&
		value !== null &&
		"backend" in value &&
		(value.backend === "jsonl" || value.backend === "sqlite") &&
		"owningSessionId" in value &&
		typeof value.owningSessionId === "string" &&
		"incarnation" in value &&
		typeof value.incarnation === "string" &&
		"format" in value &&
		value.format === 2
	);
}

function isRecovery(value: unknown): value is AuthorityRecoveryState {
	return (
		typeof value === "object" &&
		value !== null &&
		"owner" in value &&
		"blocked" in value &&
		Array.isArray(value.blocked) &&
		"revision" in value &&
		typeof value.revision === "number"
	);
}

function toRpcError(
	response: Extract<AuthorityRpcResponse, { ok: false }>,
	call?: AuthorityRpcCall,
): AuthorityRpcError {
	return new AuthorityRpcError(
		response.error.message,
		call ? durableRequestId(call) : response.id,
		response.error.unknownOutcome,
		response.error.name,
	);
}

function withWorkerFailureEvidence(error: unknown, evidence: readonly AuthorityFailureEvidence[]): unknown {
	if (evidence.length === 0) return error;
	const primary = error instanceof Error ? error : new Error(String(error));
	const failures = evidence.map(authorityFailureFromEvidence);
	const workerFailure =
		failures.length === 1
			? failures[0]
			: new AggregateError(failures, "Authority worker preserved distinct failed-open errors");
	if (primary instanceof AuthorityRpcError) {
		primary.cause =
			primary.cause === undefined
				? workerFailure
				: new AggregateError([primary.cause, workerFailure], "Authority worker open failure evidence");
		return primary;
	}
	return new AggregateError([primary, workerFailure], "Authority worker failure evidence", { cause: primary });
}
function durableRequestId(call: AuthorityRpcCall): string {
	const optionsIndex =
		call.method === "finalizeLocal"
			? 2
			: [
						"transition",
						"transitionBatch",
						"activateAuthority",
						"commitRootTransition",
						"reserveLocal",
						"authorizeLocalEffect",
						"reconcileLocal",
				  ].includes(call.method)
				? 1
				: -1;
	if (optionsIndex < 0) return call.id;
	const options = call.args[optionsIndex];
	return typeof options === "object" &&
		options !== null &&
		"requestId" in options &&
		typeof options.requestId === "string"
		? options.requestId
		: call.id;
}
function createAuthorityWorker(): Worker {
	const hostEntry = workerHostEntry();
	return hostEntry
		? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_authority"] })
		: new Worker(new URL("./worker.ts", import.meta.url).href, {
				type: "module",
				argv: [AUTHORITY_DIRECT_WORKER_ARG],
			});
}

function sendAuthorityRequest(
	worker: Worker,
	request: AuthorityRpcOpen | AuthorityRpcCall,
): Promise<AuthorityRpcResponse> {
	const id = request.id;
	const result = Promise.withResolvers<AuthorityRpcResponse>();
	const cleanup = (): void => {
		clearTimeout(timeout);
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("messageerror", onMessageError);
		worker.removeEventListener("error", onError);
	};
	const onMessage = (event: MessageEvent<unknown>): void => {
		if (!isRpcResponse(event.data) || event.data.id !== id) return;
		cleanup();
		result.resolve(event.data);
	};
	const onMessageError = (): void => {
		cleanup();
		result.reject(new AuthorityRpcError("Authority recovery worker response was unreadable", id, true));
	};
	const onError = (event: ErrorEvent): void => {
		cleanup();
		result.reject(new AuthorityRpcError(event.message || "Authority recovery worker exited", id, true));
	};
	const timeout = setTimeout(() => {
		cleanup();
		result.reject(new AuthorityRpcError("Authority recovery worker request timed out", id, true, "TimeoutError"));
	}, AUTHORITY_RESOURCE_CAPS.endToEndDeadlineMs);
	worker.addEventListener("message", onMessage);
	worker.addEventListener("messageerror", onMessageError);
	worker.addEventListener("error", onError);
	try {
		worker.postMessage(request);
	} catch (error) {
		cleanup();
		result.reject(error);
	}
	return result.promise;
}
