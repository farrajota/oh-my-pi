import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { dlopen, FFIType, ptr } from "bun:ffi";

// PIDFD_THREAD uses libc's O_EXCL value (0x80) on Linux.
const PIDFD_THREAD = fs.constants.O_EXCL;
// POLLIN | POLLHUP identify task exit on the pinned thread descriptor.
const THREAD_EXIT_EVENTS = 17;
function openLinuxLibc() {
	if (process.platform !== "linux") return undefined;
	try {
		return dlopen("libc.so.6", {
			getpid: { args: [], returns: FFIType.i32 },
			gettid: { args: [], returns: FFIType.i32 },
			pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
			poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
			close: { args: [FFIType.i32], returns: FFIType.i32 },
		});
	} catch {
		// A Linux libc without these glibc symbols (for example musl) uses the portable worker-close lifetime.
		return undefined;
	}
}
const libc = openLinuxLibc();

function nativeLibc() {
	if (!libc) throw new Error("Authority native thread lifetime requires Linux libc support");
	return libc;
}

/**
 * How the client proves an authority worker has stopped before it releases root ownership.
 *
 * - `pidfd-thread` (Linux 6.9+ with glibc): the client pins the worker's kernel thread with
 *   pidfd_open(tid, PIDFD_THREAD) and waits until the kernel reports that exact thread has exited.
 * - `worker-close` (every other host): the client waits for Bun's worker `close` event, which Bun
 *   dispatches once the worker's JavaScript runtime has shut down. No worker JavaScript runs after it,
 *   but the kernel does not confirm that the native thread is gone, so native teardown may still be
 *   finishing when ownership is released.
 */
export type AuthorityThreadLifetimeMode = "pidfd-thread" | "worker-close";

let lifetimeMode: AuthorityThreadLifetimeMode | undefined;

export function authorityThreadLifetimeMode(): AuthorityThreadLifetimeMode {
	if (lifetimeMode) return lifetimeMode;
	lifetimeMode = "worker-close";
	if (libc && PIDFD_THREAD === 128) {
		// Probe on this thread: kernels before 6.9 reject the PIDFD_THREAD flag with EINVAL.
		const descriptor = libc.symbols.pidfd_open(libc.symbols.gettid(), PIDFD_THREAD);
		if (descriptor >= 0) {
			if (libc.symbols.close(descriptor) !== 0)
				throw new Error("Could not close the authority PIDFD_THREAD probe descriptor");
			lifetimeMode = "pidfd-thread";
		}
	}
	return lifetimeMode;
}

export interface AuthorityThreadPin {
	/** Kernel thread ID in `pidfd-thread` mode; null when the platform exposes none. */
	readonly threadId: number | null;
	readonly mode: AuthorityThreadLifetimeMode;
	hasExited(): boolean;
}

type LifetimeEnvelope =
	| { readonly kind: "authority-thread-lifetime"; readonly phase: "ready"; readonly tid: number | null }
	| {
			readonly kind: "authority-thread-lifetime";
			readonly phase: "proof";
			readonly nonce: string;
			readonly tid: number | null;
	  };
export interface AuthorityFailureEvidence {
	readonly name: string;
	readonly message: string;
	readonly stack?: string;
	readonly cause?: AuthorityFailureEvidence;
	readonly errors?: readonly AuthorityFailureEvidence[];
	readonly constructionError?: AuthorityFailureEvidence;
	readonly cleanupErrors?: readonly AuthorityFailureEvidence[];
	readonly rollbackError?: AuthorityFailureEvidence;
}
type CleanupEnvelope = {
	readonly kind: "authority-thread-lifetime";
	readonly phase: "cleanup";
	readonly id: string;
	readonly ok: boolean;
	readonly message?: string;
	readonly failures?: readonly AuthorityFailureEvidence[];
};
// `exitConfirmed` outlives the descriptor: once closed, its number may be reused by an unrelated file.
type PinnedThread = AuthorityThreadPin & {
	readonly mode: "pidfd-thread";
	readonly descriptor: number;
	readonly pollState: Uint8Array;
	readonly pollView: DataView;
	closed: boolean;
	exitConfirmed: boolean;
};
type ClosedEventPin = AuthorityThreadPin & { readonly mode: "worker-close" };
type StartupHandshake = {
	readonly ready: Promise<LifetimeEnvelope | undefined>;
	wait<T>(operation: Promise<T>): Promise<T>;
	challenge(nonce: string): { readonly promise: Promise<LifetimeEnvelope | undefined>; cancel(): void };
	complete(): void;
	cancel(): void;
};
type CleanupWaiter = { readonly promise: Promise<CleanupEnvelope | undefined>; cancel(): void };
// Retain descriptor ownership if callers cannot establish kernel exit before their deadline.
const retainedPins = new Set<PinnedThread>();

export function authorityWorkerThreadId(): number {
	if (process.platform !== "linux")
		throw new Error("Authority native thread lifetime requires Linux PIDFD_THREAD support");
	const threadId = nativeLibc().symbols.gettid();
	if (!Number.isSafeInteger(threadId) || threadId <= 0)
		throw new Error("Authority worker returned an invalid native thread ID");
	return threadId;
}

/** The worker's kernel thread ID where the platform has one, else null (worker-close lifetime). */
function reportedWorkerThreadId(): number | null {
	return libc ? authorityWorkerThreadId() : null;
}

export async function pinAuthorityWorker(
	worker: Worker,
	deadline: number,
	mode: AuthorityThreadLifetimeMode = authorityThreadLifetimeMode(),
): Promise<AuthorityThreadPin> {
	if (mode === "worker-close") return pinAuthorityWorkerByCloseEvent(worker, deadline);
	if (process.platform !== "linux" || PIDFD_THREAD !== 128)
		throw new Error("Authority native thread lifetime is unsupported on this platform");
	const handshake = createStartupHandshake(worker, deadline);
	let pin: PinnedThread | undefined;
	try {
		const ready = await handshake.ready;
		if (!ready || ready.phase !== "ready")
			throw new Error("Authority worker did not provide its initial native thread ID");
		const threadId = ready.tid;
		if (threadId === null || !Number.isSafeInteger(threadId) || threadId <= 0)
			throw new Error("Authority worker native thread proof is invalid");
		const status = await handshake.wait(fsp.readFile(`/proc/self/task/${threadId}/status`, "utf8"));
		if (!status.split("\n").includes(`Tgid:\t${nativeLibc().symbols.getpid()}`))
			throw new Error("Authority worker native thread is not in this process");
		const pollState = new Uint8Array(8);
		const pollView = new DataView(pollState.buffer);
		const descriptor = nativeLibc().symbols.pidfd_open(threadId, PIDFD_THREAD);
		if (descriptor < 0) throw new Error("Authority worker PIDFD_THREAD pin failed");
		pollView.setInt32(0, descriptor, true);
		pollView.setInt16(4, 1, true);
		const pinned: PinnedThread = {
			threadId,
			mode: "pidfd-thread",
			descriptor,
			pollState,
			pollView,
			closed: false,
			exitConfirmed: false,
			hasExited: () => pinned.exitConfirmed || (!pinned.closed && threadExited(pollState, pollView)),
		};
		pin = pinned;
		retainedPins.add(pin);
		if (pin.hasExited()) throw new Error("Authority worker exited before native thread challenge");
		const nonce = crypto.randomUUID();
		const proof = handshake.challenge(nonce);
		try {
			worker.postMessage({ kind: "authority-thread-lifetime", phase: "challenge", nonce });
		} catch (error) {
			proof.cancel();
			throw error;
		}
		const response = await proof.promise;
		if (
			!response ||
			response.phase !== "proof" ||
			response.nonce !== nonce ||
			response.tid !== threadId ||
			pin.hasExited()
		) {
			throw new Error("Authority worker native thread challenge was stale or mismatched");
		}
		handshake.complete();
		return pin;
	} catch (error) {
		handshake.cancel();
		if (pin && !pin.closed) {
			try {
				closeUnadmittedPin(pin);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Authority startup proof failed and its provisional thread descriptor could not be closed",
				);
			}
		}
		throw error;
	}
}

/**
 * Portable lifetime: the same ready/challenge/proof handshake proves the worker is live and answering,
 * and exit is confirmed by the worker `close` event. The listener is attached before the first await so
 * an early exit cannot be missed.
 */
async function pinAuthorityWorkerByCloseEvent(worker: Worker, deadline: number): Promise<AuthorityThreadPin> {
	let exited = false;
	worker.addEventListener(
		"close",
		() => {
			exited = true;
		},
		{ once: true },
	);
	const handshake = createStartupHandshake(worker, deadline);
	try {
		const ready = await handshake.ready;
		if (!ready || ready.phase !== "ready")
			throw new Error("Authority worker did not provide its initial startup message");
		if (exited) throw new Error("Authority worker exited before its startup challenge");
		const nonce = crypto.randomUUID();
		const proof = handshake.challenge(nonce);
		try {
			worker.postMessage({ kind: "authority-thread-lifetime", phase: "challenge", nonce });
		} catch (error) {
			proof.cancel();
			throw error;
		}
		const response = await proof.promise;
		if (!response || response.phase !== "proof" || response.nonce !== nonce || response.tid !== ready.tid || exited) {
			throw new Error("Authority worker native thread challenge was stale or mismatched");
		}
		handshake.complete();
		const pin: ClosedEventPin = { threadId: ready.tid, mode: "worker-close", hasExited: () => exited };
		return pin;
	} catch (error) {
		handshake.cancel();
		throw error;
	}
}

export async function waitForAuthorityThreadExit(pin: AuthorityThreadPin, deadline: number): Promise<void> {
	while (!pin.hasExited()) {
		if (Date.now() >= deadline) {
			throw new Error(
				pin.mode === "pidfd-thread"
					? `Authority native thread ${pin.threadId} exit remains unconfirmed`
					: "Authority worker exit (close event) remains unconfirmed",
			);
		}
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, 5);
		await tick.promise;
	}
	if (pin.mode === "pidfd-thread") closePin(pin as PinnedThread);
}

export async function requestAuthorityFailedOpenCleanup(
	worker: Worker,
	deadline: number,
): Promise<readonly AuthorityFailureEvidence[]> {
	const id = crypto.randomUUID();
	const reply = waitForCleanup(worker, id, deadline);
	try {
		worker.postMessage({ kind: "authority-thread-lifetime", phase: "cleanup-request", id });
	} catch (error) {
		reply.cancel();
		throw error;
	}
	const result = await reply.promise;
	if (!result) throw new Error("Authority failed-open cleanup request was cancelled before acknowledgment");
	const failures = result.failures ?? [];
	if (!result.ok) {
		const evidence = failures.map(authorityFailureFromEvidence);
		const cause =
			evidence.length === 1
				? evidence[0]
				: evidence.length
					? new AggregateError(evidence, "Authority worker failed-open cleanup evidence")
					: undefined;
		throw new Error(
			result.message || "Authority worker retained failed-open cleanup ownership",
			cause === undefined ? undefined : { cause },
		);
	}
	return failures;
}

export function handleAuthorityThreadLifetimeMessage(
	message: unknown,
	worker: { postMessage(value: unknown): void },
): boolean {
	if (!isChallenge(message)) return false;
	worker.postMessage({
		kind: "authority-thread-lifetime",
		phase: "proof",
		nonce: message.nonce,
		tid: reportedWorkerThreadId(),
	});
	return true;
}

export function authorityThreadReadyMessage(): LifetimeEnvelope {
	return { kind: "authority-thread-lifetime", phase: "ready", tid: reportedWorkerThreadId() };
}

export function isAuthorityThreadLifetimeMessage(value: unknown): boolean {
	return typeof value === "object" && value !== null && "kind" in value && value.kind === "authority-thread-lifetime";
}

function createStartupHandshake(worker: Worker, deadline: number): StartupHandshake {
	const ready = Promise.withResolvers<LifetimeEnvelope | undefined>();
	const interrupted = Promise.withResolvers<Error>();
	let state: "ready" | "challenge" | "proof" | "proved" | "complete" | "cancelled" | "failed" = "ready";
	let failure: Error | undefined;
	let nonce: string | undefined;
	let proof: PromiseWithResolvers<LifetimeEnvelope | undefined> | undefined;
	const cleanup = (): void => {
		clearTimeout(timeout);
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("error", onError);
		worker.removeEventListener("messageerror", onMessageError);
	};
	const fail = (error: Error): void => {
		if (state === "complete" || state === "cancelled" || state === "failed") return;
		const waitingFor = state;
		failure = error;
		state = "failed";
		cleanup();
		interrupted.resolve(error);
		if (waitingFor === "ready") ready.reject(error);
		if (waitingFor === "proof") proof?.reject(error);
	};
	const onMessage = (event: MessageEvent<unknown>): void => {
		const value = event.data;
		if (!isLifetimeEnvelope(value)) {
			fail(new Error("Authority worker sent a malformed or unexpected startup message"));
			return;
		}
		if (state === "ready") {
			if (value.phase !== "ready") {
				fail(new Error("Authority worker startup message arrived in the wrong phase"));
				return;
			}
			state = "challenge";
			ready.resolve(value);
			return;
		}
		if (state === "proof") {
			if (value.phase !== "proof" || value.nonce !== nonce) {
				fail(new Error("Authority worker startup proof had a stale nonce or wrong phase"));
				return;
			}
			state = "proved";
			proof?.resolve(value);
			return;
		}
		fail(new Error("Authority worker sent a duplicate or stale startup message"));
	};
	const onError = (event: ErrorEvent): void =>
		fail(new Error(event.message || "Authority worker exited during native thread handshake"));
	const onMessageError = (): void => fail(new Error("Authority worker native thread handshake was unreadable"));
	const timeout = setTimeout(
		() => fail(new Error("Authority worker native thread handshake exceeded its deadline")),
		Math.max(0, deadline - Date.now()),
	);
	worker.addEventListener("message", onMessage);
	worker.addEventListener("error", onError);
	worker.addEventListener("messageerror", onMessageError);
	const cancelHandshake = (): void => {
		if (state === "complete" || state === "cancelled" || state === "failed") return;
		const waitingFor = state;
		state = "cancelled";
		cleanup();
		if (waitingFor === "ready") ready.resolve(undefined);
		if (waitingFor === "proof") proof?.resolve(undefined);
	};
	return {
		ready: ready.promise,
		async wait<T>(operation: Promise<T>): Promise<T> {
			const result = await Promise.race([
				operation.then(
					value => ({ value }),
					error => ({ error }),
				),
				interrupted.promise.then(error => ({ failure: error })),
			]);
			if ("failure" in result) throw result.failure;
			if ("error" in result) throw result.error;
			if (failure) throw failure;
			return result.value;
		},
		challenge(challengeNonce: string) {
			if (failure) throw failure;
			if (state !== "challenge") throw new Error("Authority worker startup challenge arrived in the wrong phase");
			nonce = challengeNonce;
			state = "proof";
			proof = Promise.withResolvers<LifetimeEnvelope | undefined>();
			return { promise: proof.promise, cancel: cancelHandshake };
		},
		complete(): void {
			if (failure) throw failure;
			if (state !== "proved") throw new Error("Authority worker startup proof was not completed");
			state = "complete";
			cleanup();
		},
		cancel: cancelHandshake,
	};
}

function waitForCleanup(worker: Worker, id: string, deadline: number): CleanupWaiter {
	const result = Promise.withResolvers<CleanupEnvelope | undefined>();
	let settled = false;
	const cleanup = (): void => {
		clearTimeout(timeout);
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("error", onError);
		worker.removeEventListener("messageerror", onMessageError);
	};
	const resolve = (value: CleanupEnvelope | undefined): void => {
		if (settled) return;
		settled = true;
		cleanup();
		result.resolve(value);
	};
	const reject = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		result.reject(error);
	};
	const onMessage = (event: MessageEvent<unknown>): void => {
		const value = event.data;
		if (
			typeof value !== "object" ||
			value === null ||
			!("kind" in value) ||
			value.kind !== "authority-thread-lifetime" ||
			!("phase" in value) ||
			value.phase !== "cleanup"
		)
			return;
		if (!isCleanupEnvelope(value) || value.id !== id) {
			reject(new Error("Authority worker sent a malformed or stale failed-open cleanup response"));
			return;
		}
		resolve(value);
	};
	const onError = (event: ErrorEvent): void =>
		reject(new Error(event.message || "Authority worker exited during failed-open cleanup"));
	const onMessageError = (): void => reject(new Error("Authority failed-open cleanup response was unreadable"));
	const timeout = setTimeout(
		() => reject(new Error("Authority failed-open cleanup exceeded its deadline")),
		Math.max(0, deadline - Date.now()),
	);
	worker.addEventListener("message", onMessage);
	worker.addEventListener("error", onError);
	worker.addEventListener("messageerror", onMessageError);
	return { promise: result.promise, cancel: () => resolve(undefined) };
}

function isLifetimeEnvelope(value: unknown): value is LifetimeEnvelope {
	if (
		typeof value !== "object" ||
		value === null ||
		!("kind" in value) ||
		value.kind !== "authority-thread-lifetime" ||
		!("phase" in value) ||
		!("tid" in value)
	)
		return false;
	if (value.tid !== null && (typeof value.tid !== "number" || !Number.isSafeInteger(value.tid) || value.tid <= 0))
		return false;
	if (value.phase === "ready") return Object.keys(value).length === 3;
	return (
		value.phase === "proof" &&
		Object.keys(value).length === 4 &&
		"nonce" in value &&
		typeof value.nonce === "string" &&
		value.nonce.length > 0
	);
}

function isCleanupEnvelope(value: unknown): value is CleanupEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "authority-thread-lifetime" &&
		"phase" in value &&
		value.phase === "cleanup" &&
		"id" in value &&
		typeof value.id === "string" &&
		"ok" in value &&
		typeof value.ok === "boolean" &&
		(!("message" in value) || typeof value.message === "string") &&
		(!("failures" in value) ||
			(Array.isArray(value.failures) && value.failures.every(failure => isAuthorityFailureEvidence(failure))))
	);
}

function isAuthorityFailureEvidence(value: unknown, seen = new WeakSet<object>()): value is AuthorityFailureEvidence {
	if (
		typeof value !== "object" ||
		value === null ||
		seen.has(value) ||
		!("name" in value) ||
		typeof value.name !== "string" ||
		!("message" in value) ||
		typeof value.message !== "string"
	)
		return false;
	seen.add(value);
	if ("stack" in value && typeof value.stack !== "string") return false;
	if ("cause" in value && !isAuthorityFailureEvidence(value.cause, seen)) return false;
	if (
		"errors" in value &&
		(!Array.isArray(value.errors) || !value.errors.every(entry => isAuthorityFailureEvidence(entry, seen)))
	)
		return false;
	if ("constructionError" in value && !isAuthorityFailureEvidence(value.constructionError, seen)) return false;
	if (
		"cleanupErrors" in value &&
		(!Array.isArray(value.cleanupErrors) ||
			!value.cleanupErrors.every(entry => isAuthorityFailureEvidence(entry, seen)))
	)
		return false;
	if ("rollbackError" in value && !isAuthorityFailureEvidence(value.rollbackError, seen)) return false;
	return true;
}

export function authorityFailureEvidence(value: unknown): AuthorityFailureEvidence {
	return serializeFailureEvidence(value, new WeakSet<object>());
}

function serializeFailureEvidence(value: unknown, ancestors: WeakSet<object>): AuthorityFailureEvidence {
	if (!(value instanceof Error)) return { name: typeof value, message: String(value) };
	if (ancestors.has(value))
		return { name: value.name, message: value.message, ...(value.stack === undefined ? {} : { stack: value.stack }) };
	ancestors.add(value);
	const cause = value.cause === undefined ? undefined : serializeFailureEvidence(value.cause, ancestors);
	const errors =
		value instanceof AggregateError
			? Array.from(value.errors, error => serializeFailureEvidence(error, ancestors))
			: undefined;
	const constructionError =
		"constructionError" in value ? serializeFailureEvidence(value.constructionError, ancestors) : undefined;
	const cleanupErrors =
		"cleanupErrors" in value && Array.isArray(value.cleanupErrors)
			? value.cleanupErrors.map(error => serializeFailureEvidence(error, ancestors))
			: undefined;
	const rollbackError =
		"rollbackError" in value && value.rollbackError !== undefined
			? serializeFailureEvidence(value.rollbackError, ancestors)
			: undefined;
	ancestors.delete(value);
	return {
		name: value.name,
		message: value.message,
		...(value.stack === undefined ? {} : { stack: value.stack }),
		...(cause === undefined ? {} : { cause }),
		...(errors === undefined ? {} : { errors }),
		...(constructionError === undefined ? {} : { constructionError }),
		...(cleanupErrors === undefined ? {} : { cleanupErrors }),
		...(rollbackError === undefined ? {} : { rollbackError }),
	};
}

export function authorityFailureFromEvidence(evidence: AuthorityFailureEvidence): Error {
	const cause = evidence.cause === undefined ? undefined : authorityFailureFromEvidence(evidence.cause);
	const errors = evidence.errors?.map(authorityFailureFromEvidence);
	const error =
		errors === undefined
			? new Error(evidence.message, cause === undefined ? undefined : { cause })
			: new AggregateError(errors, evidence.message, cause === undefined ? undefined : { cause });
	error.name = evidence.name;
	if (evidence.stack !== undefined) error.stack = evidence.stack;
	if (evidence.constructionError !== undefined)
		Object.defineProperty(error, "constructionError", {
			value: authorityFailureFromEvidence(evidence.constructionError),
		});
	if (evidence.cleanupErrors !== undefined)
		Object.defineProperty(error, "cleanupErrors", {
			value: evidence.cleanupErrors.map(authorityFailureFromEvidence),
		});
	if (evidence.rollbackError !== undefined)
		Object.defineProperty(error, "rollbackError", { value: authorityFailureFromEvidence(evidence.rollbackError) });
	return error;
}

function isChallenge(
	value: unknown,
): value is { readonly kind: "authority-thread-lifetime"; readonly phase: "challenge"; readonly nonce: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "authority-thread-lifetime" &&
		"phase" in value &&
		value.phase === "challenge" &&
		"nonce" in value &&
		typeof value.nonce === "string" &&
		value.nonce.length > 0
	);
}

function threadExited(state: Uint8Array, view: DataView): boolean {
	view.setInt16(6, 0, true);
	const result = nativeLibc().symbols.poll(ptr(state), 1, 0);
	if (result < 0) throw new Error("Authority PIDFD_THREAD poll failed");
	return result > 0 && (view.getInt16(6, true) & THREAD_EXIT_EVENTS) !== 0;
}

function closePin(pin: PinnedThread): void {
	if (pin.closed) return;
	if (!threadExited(pin.pollState, pin.pollView))
		throw new Error("Cannot close authority PIDFD_THREAD before exact thread exit");
	pin.exitConfirmed = true;
	if (nativeLibc().symbols.close(pin.descriptor) !== 0)
		throw new Error("Could not close authority PIDFD_THREAD descriptor");
	pin.closed = true;
	retainedPins.delete(pin);
}

function closeUnadmittedPin(pin: PinnedThread): void {
	if (pin.closed) return;
	if (nativeLibc().symbols.close(pin.descriptor) !== 0)
		throw new Error("Could not close unadmitted authority PIDFD_THREAD descriptor");
	pin.closed = true;
	retainedPins.delete(pin);
}
