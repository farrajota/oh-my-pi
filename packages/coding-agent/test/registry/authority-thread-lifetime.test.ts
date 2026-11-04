import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTHORITY_RESOURCE_CAPS,
	AuthorityRpcClient,
	AuthorityRpcError,
	withAuthorityEffect,
} from "../../src/registry/authority/client";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import type { AuthorityOwnership } from "../../src/registry/authority/ownership";
import * as threadLifetime from "../../src/registry/authority/thread-lifetime";
import type { AuthorityDriverOptions, AuthorityExport, AuthorityIdentity } from "../../src/registry/authority/types";
import { SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";
import type { DurableOperationRecord } from "../../src/registry/durable-state";

const libc = dlopen("libc.so.6", {
	pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
	poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
	pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
	close: { args: [FFIType.i32], returns: FFIType.i32 },
});
const THREAD_EXIT_EVENTS = 17;
// Every worker open, including fenced replacements, borrows the client's anonymous capacity backing.
const borrowedCapacity = {
	identity: { fd: expect.any(Number), device: expect.any(BigInt), inode: expect.any(BigInt) },
	maxRequestBytes: AUTHORITY_RESOURCE_CAPS.maxRequestBytes,
};
const workers: Worker[] = [];
const descriptors = new Set<number>();
const releaseDescriptors = new Set<number>();
const temporaryDirectories: string[] = [];
const pendingClosures: Promise<unknown>[] = [];
const clients: AuthorityRpcClient[] = [];
const failedOpenRoots = new Set<string>();
const ownedAuthorities = new Set<AuthorityOwnership>();
const fixtureDrivers = new Set<SqliteAuthorityPersistence>();
type NativePromiseOutcome<T> =
	| { readonly status: "fulfilled"; readonly value: T }
	| { readonly status: "rejected"; readonly reason: unknown };

interface NativeCleanupAttempt {
	promise?: Promise<boolean>;
	requestId?: string;
	settled: boolean;
}

interface NativeCleanupAckBridge {
	readonly worker: Worker;
	readonly descriptor: number;
	readonly returned: PromiseWithResolvers<void>;
	readonly forwardedEvents: WeakSet<Event>;
	readonly proofTasks: Set<Promise<void>>;
	readonly proofFailures: unknown[];
	readonly forwardingFailures: unknown[];
	currentAttempt?: NativeCleanupAttempt;
	ack?: { readonly value: unknown; readonly requestId?: string; readonly attempt?: NativeCleanupAttempt };
	root?: string;
	ackDelivered: boolean;
	dispatching: boolean;
	tearingDown: boolean;
	readReturned: boolean;
	blockedReadProven: boolean;
	physicalCloseAttempts: number;
	deliveredAcknowledgements: number;
}

const cleanupAckBridges = new Set<NativeCleanupAckBridge>();
const pendingCleanupAttempts = new Set<NativeCleanupAttempt>();

function observePromise<T>(promise: Promise<T>): Promise<NativePromiseOutcome<T>> {
	return promise.then(
		value => ({ status: "fulfilled", value }),
		reason => ({ status: "rejected", reason }),
	);
}

function rejectionReason<T>(outcome: NativePromiseOutcome<T>): unknown {
	expect(outcome.status).toBe("rejected");
	if (outcome.status !== "rejected") throw new Error("Expected a native worker promise to reject");
	return outcome.reason;
}

function trackCleanupAttempt(root: string, bridge?: NativeCleanupAckBridge): Promise<boolean> {
	if (bridge?.currentAttempt && !bridge.currentAttempt.settled)
		throw new Error("Native cleanup retry started before its original attempt settled");
	if (bridge?.ack && !bridge.ackDelivered)
		throw new Error("Native cleanup retry started while its original ACK remained withheld");
	const attempt: NativeCleanupAttempt = { settled: false };
	if (bridge) bridge.currentAttempt = attempt;
	const promise = AuthorityRpcClient.closeFailedOpen(root);
	attempt.promise = promise;
	pendingCleanupAttempts.add(attempt);
	void promise.then(
		() => {
			attempt.settled = true;
			pendingCleanupAttempts.delete(attempt);
		},
		() => {
			attempt.settled = true;
			pendingCleanupAttempts.delete(attempt);
		},
	);
	return promise;
}

function createCleanupAckBridge(worker: Worker, descriptor: number): NativeCleanupAckBridge {
	const bridge: NativeCleanupAckBridge = {
		worker,
		descriptor,
		returned: Promise.withResolvers<void>(),
		forwardedEvents: new WeakSet<Event>(),
		proofTasks: new Set<Promise<void>>(),
		proofFailures: [],
		forwardingFailures: [],
		ackDelivered: false,
		dispatching: false,
		tearingDown: false,
		readReturned: false,
		blockedReadProven: false,
		physicalCloseAttempts: 0,
		deliveredAcknowledgements: 0,
	};
	cleanupAckBridges.add(bridge);
	return bridge;
}

function dispatchCleanupAck(bridge: NativeCleanupAckBridge): void {
	const withheld = bridge.ack;
	if (!withheld || bridge.dispatching) return;
	const attempt = withheld.attempt;
	if (
		!attempt ||
		attempt !== bridge.currentAttempt ||
		attempt.settled ||
		withheld.requestId === undefined ||
		withheld.requestId !== attempt.requestId
	) {
		bridge.forwardingFailures.push(new Error("Native cleanup ACK no longer belongs to its original pending request"));
		return;
	}
	bridge.dispatching = true;
	try {
		const event = new MessageEvent("message", { data: withheld.value });
		bridge.forwardedEvents.add(event);
		if (!bridge.worker.dispatchEvent(event)) throw new Error("Native cleanup ACK dispatch was canceled");
		bridge.ackDelivered = true;
		bridge.deliveredAcknowledgements++;
		bridge.ack = undefined;
	} catch (error) {
		bridge.forwardingFailures.push(error);
	} finally {
		bridge.dispatching = false;
	}
}

async function openTrackedAuthority(...args: Parameters<typeof AuthorityRpcClient.open>): Promise<AuthorityRpcClient> {
	const root = args[0].identity.owningSessionId;
	failedOpenRoots.add(root);
	try {
		// These lifetimes are qualified with the borrowed capacity descriptor, so they opt in to xfs.
		const [driver, ownership, workerFactory, capacity = "xfs"] = args;
		const client = await AuthorityRpcClient.open(driver, ownership, workerFactory, capacity);
		clients.push(client);
		failedOpenRoots.delete(root);
		return client;
	} catch (error) {
		if (!(error instanceof AuthorityRpcError) || !error.unknownOutcome) failedOpenRoots.delete(root);
		throw error;
	}
}

async function waitForFixturePhase<T>(phase: string, promise: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	// Native worker scheduling requires a real deadline, not a fake clock.
	const timeout = setTimeout(
		() => deadline.reject(new Error(`Native lifetime fixture did not reach ${phase}`)),
		10_000,
	);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timeout);
	}
}

function isFixtureMessage(value: unknown): boolean {
	return typeof value === "object" && value !== null && "kind" in value && value.kind === "native-lifetime-fixture";
}

function isFixturePhase(value: unknown, phase: string): boolean {
	return (
		isFixtureMessage(value) &&
		typeof value === "object" &&
		value !== null &&
		"phase" in value &&
		value.phase === phase
	);
}

function operationRecord(operationId: string): DurableOperationRecord {
	return {
		kind: "operation",
		at: 1,
		operationId,
		effectClass: "session",
		ownerId: "native-root",
		classOwnerId: "native-root",
		acquiredAt: 1,
		expiresAt: 1_000,
		phase: "intent",
	};
}

function createTrackedWorkerFactory(
	opened: (message: unknown) => void,
	terminated: Array<PromiseWithResolvers<void>>,
	onTransition: () => void,
	mode: string,
	onFixtureMessage: (value: unknown) => void,
	cleanupExitDescriptor?: number,
	onCleanupAckBridge?: (bridge: NativeCleanupAckBridge) => void,
): () => Worker {
	return () => {
		const target = new Worker(new URL("./authority-thread-lifetime-worker.ts", import.meta.url).href, {
			type: "module",
		});
		workers.push(target);
		const bridge =
			cleanupExitDescriptor === undefined ? undefined : createCleanupAckBridge(target, cleanupExitDescriptor);
		if (bridge) onCleanupAckBridge?.(bridge);
		queueMicrotask(() =>
			target.postMessage({
				kind: "native-lifetime-fixture-start",
				mode,
				...(cleanupExitDescriptor === undefined ? {} : { cleanupExitDescriptor }),
			}),
		);
		const exited = Promise.withResolvers<void>();
		const notifyFixtureMessage = (value: unknown): void => {
			try {
				onFixtureMessage(value);
			} catch (error) {
				if (bridge) bridge.forwardingFailures.push(error);
				else throw error;
			}
		};
		target.addEventListener("message", event => {
			if (bridge?.forwardedEvents.has(event)) return;
			const value = (event as MessageEvent).data;
			if (
				bridge &&
				typeof value === "object" &&
				value !== null &&
				"kind" in value &&
				value.kind === "authority-thread-lifetime" &&
				"phase" in value &&
				value.phase === "cleanup" &&
				"ok" in value &&
				value.ok === true
			) {
				if (bridge.ack !== undefined || bridge.ackDelivered)
					throw new Error("Native lifetime fixture received duplicate successful cleanup acknowledgements");
				const requestId = "id" in value && typeof value.id === "string" ? value.id : undefined;
				bridge.ack = { value, requestId, attempt: bridge.currentAttempt };
				if (!bridge.currentAttempt || bridge.currentAttempt.requestId !== requestId)
					bridge.forwardingFailures.push(new Error("Native cleanup ACK did not match its tracked request"));
				event.stopImmediatePropagation();
				notifyFixtureMessage(value);
				if ((bridge.tearingDown && bridge.readReturned) || (bridge.blockedReadProven && !bridge.tearingDown))
					dispatchCleanupAck(bridge);
				return;
			}
			if (isFixturePhase(value, "cleanup-block-started")) {
				if (bridge) {
					if (
						!bridge.tearingDown &&
						typeof value === "object" &&
						value !== null &&
						"tid" in value &&
						typeof value.tid === "number"
					) {
						const tid = value.tid;
						const proof = (async (): Promise<void> => {
							try {
								await waitForBlockedRead(tid, bridge.descriptor, () => !bridge.readReturned);
								bridge.blockedReadProven = true;
								if (!bridge.tearingDown) dispatchCleanupAck(bridge);
							} catch (error) {
								bridge.proofFailures.push(error);
							}
						})();
						bridge.proofTasks.add(proof);
						void proof.then(() => bridge.proofTasks.delete(proof));
					} else if (!bridge.tearingDown)
						bridge.proofFailures.push(new Error("Native cleanup block omitted its original thread ID"));
				}
				notifyFixtureMessage(value);
				return;
			}
			if (isFixturePhase(value, "cleanup-block-returned")) {
				if (bridge) {
					bridge.readReturned = true;
					bridge.returned.resolve();
					if (bridge.tearingDown) dispatchCleanupAck(bridge);
				}
				notifyFixtureMessage(value);
				return;
			}
			if (isFixturePhase(value, "unknown-open-close") && bridge) bridge.physicalCloseAttempts++;
			if (isFixturePhase(value, "transition")) onTransition();
			notifyFixtureMessage(value);
		});
		type FixtureWorkerEventListener = ((event: Event) => void) | { handleEvent(event: Event): void };

		const messageListeners = new Map<FixtureWorkerEventListener, FixtureWorkerEventListener>();
		terminated.push(exited);
		return new Proxy(target, {
			get(worker, property) {
				if (property === "addEventListener")
					return (
						type: string,
						listener: FixtureWorkerEventListener,
						options?: AddEventListenerOptions | boolean,
					): void => {
						if (type !== "message") {
							worker.addEventListener(type, listener, options);
							return;
						}
						const filtered: FixtureWorkerEventListener = event => {
							if (isFixtureMessage((event as MessageEvent).data)) return;
							if (typeof listener === "function") listener.call(worker, event);
							else listener.handleEvent(event);
						};
						messageListeners.set(listener, filtered);
						worker.addEventListener(type, filtered, options);
					};
				if (property === "removeEventListener")
					return (
						type: string,
						listener: FixtureWorkerEventListener,
						options?: EventListenerOptions | boolean,
					): void => {
						const filtered = type === "message" ? messageListeners.get(listener) : undefined;
						worker.removeEventListener(type, filtered ?? listener, options);
						if (filtered) messageListeners.delete(listener);
					};
				if (property === "terminate")
					return (): void => {
						exited.resolve();
						worker.terminate();
					};
				if (property === "postMessage")
					return (message: unknown): void => {
						if (typeof message === "object" && message !== null && "kind" in message && message.kind === "open")
							opened(message);
						if (
							bridge &&
							typeof message === "object" &&
							message !== null &&
							"kind" in message &&
							message.kind === "authority-thread-lifetime" &&
							"phase" in message &&
							message.phase === "cleanup-request" &&
							"id" in message &&
							typeof message.id === "string"
						) {
							if (bridge.currentAttempt) bridge.currentAttempt.requestId = message.id;
							else
								bridge.forwardingFailures.push(
									new Error("Native cleanup request was not owned by a tracked attempt"),
								);
						}
						worker.postMessage(message);
					};
				const member = Reflect.get(worker, property, worker);
				return typeof member === "function" ? member.bind(worker) : member;
			},
		});
	};
}
function workerWithFailedSend(target: Worker, phase: string, failure: Error, removed: string[]): Worker {
	return new Proxy(target, {
		get(worker, property) {
			if (property === "postMessage")
				return (message: unknown): void => {
					if (
						typeof message === "object" &&
						message !== null &&
						"kind" in message &&
						message.kind === "authority-thread-lifetime" &&
						"phase" in message &&
						message.phase === phase
					)
						throw failure;
					worker.postMessage(message);
				};
			if (property === "removeEventListener")
				return (...args: Parameters<Worker["removeEventListener"]>): void => {
					removed.push(args[0]);
					worker.removeEventListener(...args);
				};
			const member = Reflect.get(worker, property, worker);
			return typeof member === "function" ? member.bind(worker) : member;
		},
	});
}

async function makeOwnedAuthority(
	backend: AuthorityIdentity["backend"],
): Promise<{ readonly ownership: AuthorityOwnership; readonly path: string; readonly directory: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-thread-lifetime-"));
	temporaryDirectories.push(directory);
	const session = path.join(directory, "root.jsonl");
	await fs.writeFile(session, '{"type":"session","id":"native-root"}\n');
	const acquired = await acquireAuthorityOwnership(session, { owningSessionId: "native-root", create: true });
	const ownership: AuthorityOwnership = {
		...acquired,
		release: async () => {
			await acquired.release();
			ownedAuthorities.delete(ownership);
		},
	};
	ownedAuthorities.add(ownership);
	return { ownership, path: backend === "jsonl" ? ownership.paths.jsonl : ownership.paths.sqlite, directory };
}

function threadExitEvents(pidfd: number): number {
	const pollState = new Uint8Array(8);
	const pollView = new DataView(pollState.buffer);
	pollView.setInt32(0, pidfd, true);
	pollView.setInt16(4, 1, true);
	const result = libc.symbols.poll(ptr(pollState), 1, 0);
	if (result < 0) throw new Error("Could not poll the exact native thread pin");
	return pollView.getInt16(6, true);
}

async function waitForBlockedRead(
	threadId: number,
	readDescriptor: number,
	shouldContinue: () => boolean = () => true,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (!shouldContinue())
			throw new Error("Native worker left the blocked read before its original-thread proof completed");
		const syscall = (await Bun.file(`/proc/self/task/${threadId}/syscall`).text()).trim().split(/\s+/);
		const syscallNumber = syscall[0];
		const syscallDescriptor = syscall[1];
		if (
			syscallNumber === "0" &&
			syscallDescriptor !== undefined &&
			Number(BigInt(syscallDescriptor)) === readDescriptor
		)
			return;
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
	throw new Error("Native worker did not block in read on the task-owned pipe descriptor");
}
async function settleCleanupAckBridge(bridge: NativeCleanupAckBridge): Promise<unknown[]> {
	const failures: unknown[] = [];
	bridge.tearingDown = true;
	if (bridge.ack && !bridge.ackDelivered) {
		if (!bridge.readReturned) {
			try {
				await waitForFixturePhase("native cleanup block return", bridge.returned.promise);
			} catch (error) {
				failures.push(error);
			}
		}
		if (bridge.readReturned) dispatchCleanupAck(bridge);
	}
	await Promise.all([...bridge.proofTasks]);
	for (const error of bridge.proofFailures) if (!failures.includes(error)) failures.push(error);
	for (const error of bridge.forwardingFailures) if (!failures.includes(error)) failures.push(error);
	return failures;
}

afterEach(async () => {
	const failures: unknown[] = [];
	let cleanupConfirmed = true;
	const recordFailure = (error: unknown, preventsDisposal = true): void => {
		if (!failures.includes(error)) failures.push(error);
		if (preventsDisposal) cleanupConfirmed = false;
	};
	const bridges = [...cleanupAckBridges];
	for (const bridge of bridges) bridge.tearingDown = true;
	for (const descriptor of releaseDescriptors) {
		if (libc.symbols.write(descriptor, ptr(new Uint8Array([1])), 1) === 1n) releaseDescriptors.delete(descriptor);
		else recordFailure(new Error("Could not release a task-owned native read during test cleanup"));
	}
	for (const bridge of bridges) for (const error of await settleCleanupAckBridge(bridge)) recordFailure(error, false);
	const inFlight = [...pendingCleanupAttempts];
	const inFlightOutcomes = await Promise.all(inFlight.map(attempt => observePromise(attempt.promise!)));
	for (const outcome of inFlightOutcomes) if (outcome.status === "rejected") recordFailure(outcome.reason, false);
	for (const bridge of bridges) for (const error of await settleCleanupAckBridge(bridge)) recordFailure(error, false);
	for (const client of clients) pendingClosures.push(client.close());
	const closures = await Promise.allSettled(pendingClosures);
	for (const result of closures) if (result.status === "rejected") recordFailure(result.reason);
	for (const root of failedOpenRoots) {
		const bridge = bridges.find(candidate => candidate.root === root);
		const attemptLimit = bridge ? Math.max(3 - bridge.physicalCloseAttempts, 0) + 1 : 3;
		let closed = false;
		for (let index = 0; index < attemptLimit; index++) {
			let attempt: Promise<boolean>;
			try {
				attempt = trackCleanupAttempt(root, bridge);
			} catch (error) {
				recordFailure(error, false);
				break;
			}
			const outcome = await observePromise(attempt);
			if (outcome.status === "rejected") {
				const acknowledgedExitRetry =
					bridge !== undefined && bridge.deliveredAcknowledgements > 0 && index + 1 < attemptLimit;
				const injectedPhysicalCloseFailure =
					outcome.reason instanceof Error &&
					/^injected unknown-open physical close failure [12]$/.test(outcome.reason.message);
				if (!injectedPhysicalCloseFailure && !acknowledgedExitRetry) break;
				continue;
			}
			if (!outcome.value) {
				recordFailure(new Error(`Failed-open owner ${root} is no longer reachable`));
				break;
			}
			failedOpenRoots.delete(root);
			closed = true;
			break;
		}
		if (!closed)
			recordFailure(
				new Error(`Failed-open owner ${root} could not be disposed after its original cleanup attempt settled`),
			);
	}
	for (const bridge of bridges) {
		for (const error of await settleCleanupAckBridge(bridge)) recordFailure(error, false);
		if (bridge.ack && !bridge.ackDelivered)
			recordFailure(new Error("Failed-open owner still holds an undispatched cleanup ACK"));
		if (bridge.proofTasks.size > 0) recordFailure(new Error("Native cleanup proof work remains in flight"));
	}
	if (pendingCleanupAttempts.size > 0) recordFailure(new Error("Native cleanup attempts remain in flight"));
	for (const driver of fixtureDrivers) {
		try {
			driver.close();
			fixtureDrivers.delete(driver);
		} catch (error) {
			recordFailure(error);
		}
	}
	if (cleanupConfirmed) {
		for (const ownership of ownedAuthorities) {
			try {
				await ownership.release();
			} catch (error) {
				recordFailure(error);
			}
		}
	}
	// Failed or unconfirmed cleanup retains the workers, borrowed descriptors and directories.
	if (!cleanupConfirmed) throw new AggregateError(failures, "Native lifetime fixture cleanup remains owned");
	pendingClosures.length = 0;
	clients.length = 0;
	for (const worker of workers.splice(0)) {
		try {
			worker.terminate();
		} catch (error) {
			recordFailure(error);
		}
	}
	for (const descriptor of descriptors) {
		if (libc.symbols.close(descriptor) === 0) descriptors.delete(descriptor);
		else recordFailure(new Error(`Could not close task-owned descriptor ${descriptor}`));
	}
	for (const directory of temporaryDirectories) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
		} catch (error) {
			recordFailure(error);
		}
	}
	temporaryDirectories.length = 0;
	cleanupAckBridges.clear();
	if (failures.length) throw new AggregateError(failures, "Native lifetime fixture cleanup remains owned");
});

describe("authority native worker lifetime", () => {
	it("waits for the exact native thread blocked in read before replacing or releasing ownership", async () => {
		const pipe = new Int32Array(2);
		if (libc.symbols.pipe2(ptr(pipe), 0) !== 0) throw new Error("Could not create test pipe");
		for (const descriptor of pipe) descriptors.add(descriptor);
		releaseDescriptors.add(pipe[1]);
		const { ownership: acquired, path: authorityPath } = await makeOwnedAuthority("jsonl");
		let releaseCount = 0;
		// Bound once the original thread is observed; the hooks below may run before that.
		// oxlint-disable-next-line prefer-const
		let originalThreadPidfd: number | undefined;
		const releaseAfterOldThreadExit: boolean[] = [];
		const replacementOpenAfterOldThreadExit: boolean[] = [];
		const ownership: AuthorityOwnership = {
			...acquired,
			release: async () => {
				releaseCount++;
				if (originalThreadPidfd !== undefined)
					releaseAfterOldThreadExit.push((threadExitEvents(originalThreadPidfd) & THREAD_EXIT_EVENTS) !== 0);
				await acquired.release();
			},
		};
		const workerTerminations: Array<PromiseWithResolvers<void>> = [];
		let openCount = 0;
		let transitionCalls = 0;
		const transitionObserved = Promise.withResolvers<void>();
		const workerFactory = createTrackedWorkerFactory(
			() => {
				openCount++;
				if (originalThreadPidfd !== undefined)
					replacementOpenAfterOldThreadExit.push(
						(threadExitEvents(originalThreadPidfd) & THREAD_EXIT_EVENTS) !== 0,
					);
			},
			workerTerminations,
			() => {
				transitionCalls++;
				transitionObserved.resolve();
			},
			"normal",
			() => {},
		);
		const identity = {
			backend: "jsonl" as const,
			owningSessionId: "native-root",
			incarnation: crypto.randomUUID(),
			format: 2 as const,
		};
		const client = await openTrackedAuthority(
			{ path: authorityPath, identity, create: true },
			ownership,
			workerFactory,
		);
		const firstWorker = workers[0]!;
		const record = operationRecord("native-lifetime-operation");
		let callbackCalls = 0;
		const receipt = await withAuthorityEffect(client, async () => {
			const result = await client.transition(record, { requestId: "native-lifetime-request" });
			callbackCalls++;
			return result;
		});
		await waitForFixturePhase("transition", transitionObserved.promise);
		const blocked = Promise.withResolvers<number>();
		firstWorker.addEventListener("message", event => {
			if (!isFixturePhase(event.data, "block-started")) return;
			if (
				typeof event.data === "object" &&
				event.data !== null &&
				"tid" in event.data &&
				typeof event.data.tid === "number"
			)
				blocked.resolve(event.data.tid);
		});
		firstWorker.postMessage({ kind: "block-native-read", fd: pipe[0] });
		const threadId = await waitForFixturePhase("native read start", blocked.promise);
		const threadStatus = await Bun.file(`/proc/self/task/${threadId}/status`).text();
		expect(threadStatus.split("\n").includes(`Tgid:\t${process.pid}`)).toBe(true);
		if (fsSync.constants.O_EXCL !== 128)
			throw new Error("PIDFD_THREAD is unsupported for the native lifetime regression");
		const threadPidfd = libc.symbols.pidfd_open(threadId, fsSync.constants.O_EXCL);
		if (threadPidfd < 0) throw new Error("Could not pin the exact blocked worker thread");
		originalThreadPidfd = threadPidfd;
		descriptors.add(threadPidfd);
		expect(threadExitEvents(threadPidfd)).toBe(0);
		await waitForBlockedRead(threadId, pipe[0]);
		firstWorker.dispatchEvent(
			new ErrorEvent("error", { message: "Injected worker transport failure during blocked native read" }),
		);
		let closeSettled = false;
		const closing = client.close().then(
			() => {
				closeSettled = true;
			},
			error => {
				closeSettled = true;
				throw error;
			},
		);
		void closing.catch(() => {});
		pendingClosures.push(closing);
		await waitForFixturePhase("worker termination request", workerTerminations[0]!.promise);
		expect(closeSettled).toBe(false);
		expect(threadExitEvents(threadPidfd)).toBe(0);
		await waitForBlockedRead(threadId, pipe[0]);
		expect(workers).toHaveLength(1);
		expect(openCount).toBe(1);
		expect(releaseCount).toBe(0);
		expect(transitionCalls).toBe(1);
		expect(callbackCalls).toBe(1);
		if (libc.symbols.write(pipe[1], ptr(new Uint8Array([1])), 1) !== 1n)
			throw new Error("Could not release blocked native read");
		releaseDescriptors.delete(pipe[1]);
		await closing;
		expect((threadExitEvents(threadPidfd) & THREAD_EXIT_EVENTS) !== 0).toBe(true);
		expect(openCount).toBe(2);
		expect(replacementOpenAfterOldThreadExit).toEqual([true]);
		expect(releaseCount).toBe(1);
		expect(releaseAfterOldThreadExit).toEqual([true]);
		expect(transitionCalls).toBe(1);
		expect(callbackCalls).toBe(1);
		const recoveredOwnership = await acquireAuthorityOwnership(path.join(temporaryDirectories[0]!, "root.jsonl"), {
			owningSessionId: "native-root",
		});
		const recovered = await openTrackedAuthority(
			{ path: authorityPath, identity, create: false },
			recoveredOwnership,
			workerFactory,
		);
		expect(await recovered.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
			record,
			version: 1,
		});
		expect(await recovered.resolveReceipt("native-lifetime-request")).toEqual(receipt);
		await recovered.close();
	});
	it("refuses malformed, duplicate, stale and wrong-thread startup messages before persistence open", async () => {
		let ownershipReleases = 0;
		const modes: readonly { readonly mode: string; readonly error: RegExp }[] = [
			{ mode: "malformed-ready", error: /malformed or unexpected startup message/ },
			{ mode: "duplicate-ready", error: /wrong phase/ },
			{ mode: "stale-proof", error: /stale nonce or wrong phase/ },
			{ mode: "wrong-tid", error: /challenge was stale or mismatched/ },
		];
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-thread-startup-"));
		temporaryDirectories.push(directory);
		for (const [index, { mode, error }] of modes.entries()) {
			const worker = new Worker(new URL("./authority-thread-lifetime-worker.ts", import.meta.url).href, {
				type: "module",
			});
			workers.push(worker);
			queueMicrotask(() => worker.postMessage({ kind: "native-lifetime-fixture-start", mode }));
			let openReceived = false;
			worker.addEventListener("message", event => {
				if (isFixturePhase(event.data, "open-received")) openReceived = true;
			});
			const sessionFile = path.join(directory, "native-root.jsonl");
			const ownership: AuthorityOwnership = {
				sessionFile,
				owningSessionId: "native-root",
				paths: { sessionFile, descriptor: "", sqlite: "", jsonl: "", legacy: "", legacyFence: "", lock: "" },
				physicalIdentity: { dev: "0", ino: "0" },
				release: async () => {
					ownershipReleases++;
				},
			};
			const opening = AuthorityRpcClient.open(
				{
					path: `${sessionFile}.authority.jsonl`,
					identity: {
						backend: "jsonl",
						owningSessionId: "native-root",
						incarnation: crypto.randomUUID(),
						format: 2,
					},
					create: true,
				},
				ownership,
				() => worker,
			);
			const startupFailure = rejectionReason(await observePromise(opening));
			expect(startupFailure).toBeInstanceOf(Error);
			if (!(startupFailure instanceof Error))
				throw new Error("Malformed startup worker did not reject with an Error");
			expect(startupFailure.message).toMatch(error);
			expect(openReceived).toBe(false);
			expect(await fs.readdir(directory)).toEqual([]);
			expect(ownershipReleases).toBe(index + 1);
		}
	});
	it("cancels challenge and cleanup waiters when synchronous sends fail", async () => {
		const challengeTarget = new Worker(new URL("./authority-thread-lifetime-worker.ts", import.meta.url).href, {
			type: "module",
		});
		workers.push(challengeTarget);
		queueMicrotask(() => challengeTarget.postMessage({ kind: "native-lifetime-fixture-start", mode: "stale-proof" }));
		const challengeFailure = new Error("injected synchronous challenge send failure");
		const challengeRemovals: string[] = [];
		const challengeWorker = workerWithFailedSend(challengeTarget, "challenge", challengeFailure, challengeRemovals);
		expect(
			rejectionReason(await observePromise(threadLifetime.pinAuthorityWorker(challengeWorker, Date.now() + 10_000))),
		).toBe(challengeFailure);
		expect(challengeRemovals).toEqual(["message", "error", "messageerror"]);

		const cleanupTarget = new Worker(new URL("./authority-thread-lifetime-worker.ts", import.meta.url).href, {
			type: "module",
		});
		workers.push(cleanupTarget);
		const cleanupFailure = new Error("injected synchronous cleanup send failure");
		const cleanupRemovals: string[] = [];
		const cleanupWorker = workerWithFailedSend(cleanupTarget, "cleanup-request", cleanupFailure, cleanupRemovals);
		expect(
			rejectionReason(
				await observePromise(threadLifetime.requestAuthorityFailedOpenCleanup(cleanupWorker, Date.now() + 10_000)),
			),
		).toBe(cleanupFailure);
		expect(cleanupRemovals).toEqual(["message", "error", "messageerror"]);
	});
	it("keeps an exact exit confirmed after its thread pin descriptor is released", async () => {
		const worker = new Worker(new URL("./authority-thread-lifetime-worker.ts", import.meta.url).href, {
			type: "module",
		});
		workers.push(worker);
		queueMicrotask(() => worker.postMessage({ kind: "native-lifetime-fixture-start", mode: "normal" }));
		const pin = await threadLifetime.pinAuthorityWorker(worker, Date.now() + 10_000, "pidfd-thread");
		if (pin.threadId === null) throw new Error("PIDFD_THREAD pin omitted its kernel thread ID");
		const pinnedThread = libc.symbols.pidfd_open(pin.threadId, fsSync.constants.O_EXCL);
		if (pinnedThread < 0) throw new Error("Could not independently pin the authority worker thread");
		descriptors.add(pinnedThread);
		worker.terminate();
		await threadLifetime.waitForAuthorityThreadExit(pin, Date.now() + 10_000);
		expect((threadExitEvents(pinnedThread) & THREAD_EXIT_EVENTS) !== 0).toBe(true);
		// A retried cleanup waits on the same pin; its released descriptor number must not be polled again.
		const repeated = await observePromise(threadLifetime.waitForAuthorityThreadExit(pin, Date.now() + 1_000));
		expect(repeated).toEqual({ status: "fulfilled", value: undefined });
	});
	it("retains an unknown real open until explicit cleanup recovers exactly once", async () => {
		const { ownership: acquired, path: databasePath, directory } = await makeOwnedAuthority("sqlite");
		const identity: AuthorityIdentity = {
			backend: "sqlite",
			owningSessionId: "native-root",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		let releases = 0;
		let opens = 0;
		let recoveries = 0;
		const modes: string[] = [];
		const opensSent: unknown[] = [];
		const ownership: AuthorityOwnership = {
			...acquired,
			release: async () => {
				releases++;
				await acquired.release();
			},
		};
		const factory = (): Worker => {
			const mode = modes.length === 0 ? "unknown-open" : "normal";
			modes.push(mode);
			return createTrackedWorkerFactory(
				message => {
					opens++;
					opensSent.push(message);
				},
				[],
				() => {},
				mode,
				value => {
					if (isFixturePhase(value, "recovered-before-unknown")) recoveries++;
				},
			)();
		};
		expect(
			rejectionReason(
				await observePromise(
					openTrackedAuthority({ path: databasePath, identity, create: true }, ownership, factory),
				),
			),
		).toMatchObject({ unknownOutcome: true });
		expect(recoveries).toBe(1);
		expect(opens).toBe(1);
		expect(releases).toBe(0);
		await expect(
			acquireAuthorityOwnership(path.join(directory, "root.jsonl"), { owningSessionId: "native-root" }),
		).rejects.toThrow(/ownership|lock/i);
		expect(await trackCleanupAttempt(identity.owningSessionId)).toBe(true);
		failedOpenRoots.delete(identity.owningSessionId);
		expect(opens).toBe(2);
		expect(opensSent).toEqual([
			expect.objectContaining({ driver: expect.objectContaining({ create: true }) }),
			expect.objectContaining({ driver: expect.objectContaining({ create: false }) }),
		]);
		expect(modes).toEqual(["unknown-open", "normal"]);
		expect(recoveries).toBe(1);
		expect(releases).toBe(1);
		const recoveredOwnership = await acquireAuthorityOwnership(path.join(directory, "root.jsonl"), {
			owningSessionId: "native-root",
		});
		const recovered = await openTrackedAuthority(
			{ path: databasePath, identity, create: false },
			recoveredOwnership,
			factory,
		);
		expect(await recovered.recoveryState()).toMatchObject({ owner: { phase: "ready" } });
		await recovered.close();
	});
	it("retains the unknown-opening worker and every physical cleanup failure until same-owner cleanup and exact exit", async () => {
		const { ownership: acquired, path: databasePath, directory } = await makeOwnedAuthority("sqlite");
		const identity: AuthorityIdentity = {
			backend: "sqlite",
			owningSessionId: "native-root",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		let releases = 0;
		let originalPidfd: number | undefined;
		let recoveries = 0;
		let mutations = 0;
		let callbacks = 0;
		let physicallyClosed = false;
		const replacementBoundaries: boolean[] = [];
		const releaseBoundaries: boolean[] = [];
		const cleanupAttempts: unknown[] = [];
		const cleanupReplies: unknown[] = [];
		const terminations: Array<PromiseWithResolvers<void>> = [];
		const opens: unknown[] = [];
		let workerCount = 0;
		const ownership: AuthorityOwnership = {
			...acquired,
			release: async () => {
				releaseBoundaries.push(
					physicallyClosed &&
						originalPidfd !== undefined &&
						(threadExitEvents(originalPidfd) & THREAD_EXIT_EVENTS) !== 0,
				);
				releases++;
				await acquired.release();
			},
		};
		const factory = (): Worker => {
			const mode = workerCount++ === 0 ? "unknown-open-close-failure" : "normal";
			return createTrackedWorkerFactory(
				message => {
					opens.push(message);
					if (opens.length > 1)
						replacementBoundaries.push(
							physicallyClosed &&
								originalPidfd !== undefined &&
								(threadExitEvents(originalPidfd) & THREAD_EXIT_EVENTS) !== 0,
						);
				},
				terminations,
				() => {
					mutations++;
				},
				mode,
				value => {
					if (isFixturePhase(value, "recovered-before-unknown")) {
						recoveries++;
						if (typeof value !== "object" || value === null || !("tid" in value) || typeof value.tid !== "number")
							throw new Error("Unknown-opening fixture omitted its actual thread ID");
						originalPidfd = libc.symbols.pidfd_open(value.tid, fsSync.constants.O_EXCL);
						if (originalPidfd < 0) throw new Error("Could not independently pin the failed-opening worker");
						descriptors.add(originalPidfd);
					}
					if (isFixturePhase(value, "unknown-open-close")) {
						cleanupAttempts.push(value);
						physicallyClosed =
							typeof value === "object" &&
							value !== null &&
							"physicallyClosed" in value &&
							value.physicallyClosed === true;
					}
					if (
						typeof value === "object" &&
						value !== null &&
						"kind" in value &&
						value.kind === "authority-thread-lifetime" &&
						"phase" in value &&
						value.phase === "cleanup"
					)
						cleanupReplies.push(value);
				},
			)();
		};
		const opening = openTrackedAuthority({ path: databasePath, identity, create: true }, ownership, factory).then(
			client => {
				callbacks++;
				return client;
			},
		);
		expect(rejectionReason(await observePromise(opening))).toMatchObject({
			unknownOutcome: true,
			message: "injected failure after real recovery",
		});
		expect(recoveries).toBe(1);
		expect(cleanupAttempts).toEqual([]);
		expect(cleanupReplies).toEqual([]);
		if (originalPidfd === undefined) throw new Error("Failed-opening worker was not independently pinned");
		for (const attempt of [1, 2]) {
			let cleanupFailure: unknown;
			try {
				await trackCleanupAttempt(identity.owningSessionId);
			} catch (error) {
				cleanupFailure = error;
			}
			expect(cleanupFailure).toMatchObject({
				message: `injected unknown-open physical close failure ${attempt}`,
				cause: {
					errors: expect.arrayContaining([
						expect.objectContaining({ message: "injected failure after real recovery" }),
						...Array.from({ length: attempt }, (_, index) =>
							expect.objectContaining({ message: `injected unknown-open physical close failure ${index + 1}` }),
						),
					]),
				},
			});
			expect(cleanupAttempts).toHaveLength(attempt);
			expect(threadExitEvents(originalPidfd)).toBe(0);
			expect(workers).toHaveLength(1);
			expect(opens).toHaveLength(1);
			expect(releases).toBe(0);
			let terminated = false;
			void terminations[0]!.promise.then(() => {
				terminated = true;
			});
			await Promise.resolve();
			expect(terminated).toBe(false);
			await expect(
				acquireAuthorityOwnership(path.join(directory, "root.jsonl"), { owningSessionId: "native-root" }),
			).rejects.toThrow(/ownership|lock/i);
		}
		expect(await trackCleanupAttempt(identity.owningSessionId)).toBe(true);
		failedOpenRoots.delete(identity.owningSessionId);
		expect(cleanupAttempts).toEqual([
			expect.objectContaining({ attempt: 1, sameHandle: true, force: true, physicallyClosed: false }),
			expect.objectContaining({ attempt: 2, sameHandle: true, force: true, physicallyClosed: false }),
			expect.objectContaining({ attempt: 3, sameHandle: true, force: true, physicallyClosed: true }),
		]);
		expect(cleanupReplies).toEqual([
			expect.objectContaining({ ok: false }),
			expect.objectContaining({ ok: false }),
			expect.objectContaining({
				ok: true,
				failures: [
					expect.objectContaining({ message: "injected failure after real recovery" }),
					expect.objectContaining({ message: "injected unknown-open physical close failure 1" }),
					expect.objectContaining({ message: "injected unknown-open physical close failure 2" }),
				],
			}),
		]);
		expect(opens).toEqual([
			expect.objectContaining({
				driver: { path: databasePath, identity, create: true, liveOwner: true, capacity: borrowedCapacity },
			}),
			expect.objectContaining({
				driver: { path: databasePath, identity, create: false, liveOwner: true, capacity: borrowedCapacity },
			}),
		]);
		expect(replacementBoundaries).toEqual([true]);
		expect(releaseBoundaries).toEqual([true]);
		expect(releases).toBe(1);
		expect(recoveries).toBe(1);
		expect(mutations).toBe(0);
		expect(callbacks).toBe(0);
		const recoveredOwnership = await acquireAuthorityOwnership(path.join(directory, "root.jsonl"), {
			owningSessionId: "native-root",
		});
		const recovered = await openTrackedAuthority(
			{ path: databasePath, identity, create: false },
			recoveredOwnership,
			createTrackedWorkerFactory(
				() => {},
				[],
				() => {},
				"normal",
				() => {},
			),
		);
		expect(await recovered.recoveryState()).toMatchObject({ owner: { phase: "ready" } });
		await recovered.close();
	});
	for (const retryCleanupAndExit of [false, true]) {
		it(`keeps nested real post-COMMIT opening evidence on the original rejection after successful cleanup${retryCleanupAndExit ? " and cleanup/exit retries" : ""}`, async () => {
			const { ownership: acquired, path: databasePath, directory } = await makeOwnedAuthority("sqlite");
			const identity: AuthorityIdentity = {
				backend: "sqlite",
				owningSessionId: "native-root",
				incarnation: crypto.randomUUID(),
				format: 2,
			};
			let pipe: Int32Array | undefined;
			if (retryCleanupAndExit) {
				pipe = new Int32Array(2);
				if (libc.symbols.pipe2(ptr(pipe), 0) !== 0) throw new Error("Could not create cleanup-exit test pipe");
				for (const descriptor of pipe) descriptors.add(descriptor);
				releaseDescriptors.add(pipe[1]);
			}
			let originalThreadId: number | undefined;
			let originalPidfd: number | undefined;
			let committedOpenings = 0;
			let rollbackFailure: unknown;
			let cleanupAcknowledged = false;
			let releases = 0;
			let mutations = 0;
			let callbacks = 0;
			let workerCount = 0;
			let cleanupBridge: NativeCleanupAckBridge | undefined;
			const opens: unknown[] = [];
			const cleanupReplies: unknown[] = [];
			const cleanupAttempts: unknown[] = [];
			const cleanupBlockTids: number[] = [];
			const replacementBoundaries: boolean[] = [];
			const releaseBoundaries: boolean[] = [];
			const ownership: AuthorityOwnership = {
				...acquired,
				release: async () => {
					releaseBoundaries.push(
						cleanupAcknowledged &&
							originalPidfd !== undefined &&
							(threadExitEvents(originalPidfd) & THREAD_EXIT_EVENTS) !== 0,
					);
					releases++;
					await acquired.release();
				},
			};
			const factory = (): Worker => {
				const original = workerCount++ === 0;
				const mode = original
					? retryCleanupAndExit
						? "post-commit-open-failure-with-retries"
						: "post-commit-open-failure"
					: "normal";
				return createTrackedWorkerFactory(
					message => {
						opens.push(message);
						if (!original)
							replacementBoundaries.push(
								cleanupAcknowledged &&
									originalPidfd !== undefined &&
									(threadExitEvents(originalPidfd) & THREAD_EXIT_EVENTS) !== 0,
							);
					},
					[],
					() => {
						mutations++;
					},
					mode,
					value => {
						if (
							isFixturePhase(value, "cleanup-block-started") &&
							typeof value === "object" &&
							value !== null &&
							"tid" in value &&
							typeof value.tid === "number"
						)
							cleanupBlockTids.push(value.tid);
						if (isFixturePhase(value, "opening-committed")) {
							committedOpenings++;
							if (
								typeof value !== "object" ||
								value === null ||
								!("tid" in value) ||
								typeof value.tid !== "number"
							)
								throw new Error("Post-COMMIT fixture omitted its native thread ID");
							originalThreadId = value.tid;
							originalPidfd = libc.symbols.pidfd_open(value.tid, fsSync.constants.O_EXCL);
							if (originalPidfd < 0)
								throw new Error("Could not independently pin the post-COMMIT opening worker");
							descriptors.add(originalPidfd);
						}
						if (
							isFixturePhase(value, "opening-rollback-failed") &&
							typeof value === "object" &&
							value !== null &&
							"failure" in value
						)
							rollbackFailure = value.failure;
						if (isFixturePhase(value, "unknown-open-close")) cleanupAttempts.push(value);
						if (
							typeof value === "object" &&
							value !== null &&
							"kind" in value &&
							value.kind === "authority-thread-lifetime" &&
							"phase" in value &&
							value.phase === "cleanup"
						) {
							cleanupReplies.push(value);
							if ("ok" in value && value.ok === true) cleanupAcknowledged = true;
						}
					},
					original && retryCleanupAndExit ? pipe![0] : undefined,
					bridge => {
						cleanupBridge = bridge;
						bridge.root = identity.owningSessionId;
					},
				)();
			};
			const opening = openTrackedAuthority({ path: databasePath, identity, create: true }, ownership, factory).then(
				client => {
					callbacks++;
					return client;
				},
			);
			let failure: unknown;
			try {
				await opening;
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(AuthorityRpcError);
			if (!(failure instanceof AuthorityRpcError))
				throw new Error("Post-COMMIT opening did not reject with its original RPC error");
			const originalFailure = failure;
			const originalProperties = {
				name: failure.name,
				message: failure.message,
				requestId: failure.requestId,
				unknownOutcome: failure.unknownOutcome,
				stack: failure.stack,
			};
			expect(originalFailure).toMatchObject({ name: "SQLiteUnknownCommitOutcomeError", unknownOutcome: true });
			expect(originalFailure.cause).toBeUndefined();
			expect(committedOpenings).toBe(1);
			expect(rollbackFailure).toMatchObject({
				message: expect.stringMatching(/rollback|transaction/i),
				stack: expect.any(String),
			});
			expect(cleanupReplies).toEqual([]);
			expect(cleanupAttempts).toEqual([]);
			expect(opens).toHaveLength(1);
			expect(releases).toBe(0);
			await expect(
				acquireAuthorityOwnership(path.join(directory, "root.jsonl"), {
					owningSessionId: identity.owningSessionId,
				}),
			).rejects.toThrow(/ownership|lock/i);
			const nativeThreadId = originalThreadId;
			if (nativeThreadId === undefined || originalPidfd === undefined)
				throw new Error("Post-COMMIT opening worker was not independently pinned");
			let acknowledgedEvidence: unknown;
			if (retryCleanupAndExit) {
				if (!pipe) throw new Error("Cleanup-exit retry fixture lost its pipe");
				if (!cleanupBridge) throw new Error("Cleanup-exit retry fixture lost its ACK owner");
				for (const attempt of [1, 2]) {
					const closeFailure = rejectionReason(
						await observePromise(trackCleanupAttempt(identity.owningSessionId, cleanupBridge)),
					);
					expect(closeFailure).toBeInstanceOf(Error);
					if (!(closeFailure instanceof Error))
						throw new Error("Native physical-close retry did not reject with an Error");
					expect(closeFailure.message).toContain(`injected unknown-open physical close failure ${attempt}`);
					expect(cleanupReplies).toHaveLength(attempt);
					expect(cleanupAttempts).toHaveLength(attempt);
					expect(threadExitEvents(originalPidfd)).toBe(0);
					expect(opens).toHaveLength(1);
					expect(releases).toBe(0);
				}
				const waitForExit = threadLifetime.waitForAuthorityThreadExit;
				const exitWait = spyOn(threadLifetime, "waitForAuthorityThreadExit").mockImplementationOnce(async pin => {
					expect(pin.threadId).toBe(nativeThreadId);
					if (pin.threadId === null) throw new Error("PIDFD_THREAD pin omitted its kernel thread ID");
					await waitForBlockedRead(pin.threadId, pipe![0]);
					// Poll the real, still-live pin with an expired boundary; never fake successful exit.
					await waitForExit(pin, Date.now());
				});
				try {
					const exitFailure = rejectionReason(
						await observePromise(trackCleanupAttempt(identity.owningSessionId, cleanupBridge)),
					);
					expect(exitFailure).toBeInstanceOf(Error);
					if (!(exitFailure instanceof Error))
						throw new Error("Native exact-exit retry did not reject with an Error");
					expect(exitFailure.message).toMatch(/exit remains unconfirmed/);
					expect(threadExitEvents(originalPidfd)).toBe(0);
					expect(cleanupReplies).toHaveLength(3);
					expect(cleanupReplies[2]).toMatchObject({ ok: true });
					expect(cleanupBlockTids).toEqual([nativeThreadId]);
					expect(cleanupAttempts).toHaveLength(3);
					expect(opens).toHaveLength(1);
					expect(releases).toBe(0);
					acknowledgedEvidence = originalFailure.cause;
					expect(acknowledgedEvidence).toBeDefined();
				} finally {
					exitWait.mockRestore();
				}
				if (libc.symbols.write(pipe[1], ptr(new Uint8Array([1])), 1) !== 1n)
					throw new Error("Could not release the acknowledged cleanup worker");
				releaseDescriptors.delete(pipe[1]);
			}
			expect(await trackCleanupAttempt(identity.owningSessionId, cleanupBridge)).toBe(true);
			failedOpenRoots.delete(identity.owningSessionId);
			if (retryCleanupAndExit) {
				expect(originalFailure.cause).toBe(acknowledgedEvidence);
				expect(cleanupAttempts).toEqual([
					expect.objectContaining({ attempt: 1, sameHandle: true, force: true, physicallyClosed: false }),
					expect.objectContaining({ attempt: 2, sameHandle: true, force: true, physicallyClosed: false }),
					expect.objectContaining({ attempt: 3, sameHandle: true, force: true, physicallyClosed: true }),
				]);
			}
			expect(cleanupReplies).toHaveLength(retryCleanupAndExit ? 3 : 1);
			expect(await trackCleanupAttempt(identity.owningSessionId, cleanupBridge)).toBe(false);
			expect(rejectionReason(await observePromise(opening))).toBe(originalFailure);
			expect(originalFailure).toMatchObject(originalProperties);
			const underlyingCause = {
				name: "TypeError",
				message: "injected opening storage boundary failure",
				stack: expect.any(String),
				cause: { name: "RangeError", message: "injected nested opening cause", stack: expect.any(String) },
			};
			const originalWorkerEvidence = {
				name: "SQLiteUnknownCommitOutcomeError",
				message: originalProperties.message,
				stack: expect.any(String),
				cause: {
					name: "AggregateError",
					message: "injected failure after real opening COMMIT",
					stack: expect.any(String),
					cause: underlyingCause,
					errors: [
						underlyingCause,
						{ name: "Error", message: "injected distinct opening evidence", stack: expect.any(String) },
					],
				},
				rollbackError: rollbackFailure,
			};
			expect(originalFailure.cause).toMatchObject(
				retryCleanupAndExit
					? {
							errors: [
								originalWorkerEvidence,
								{ message: "injected unknown-open physical close failure 1", stack: expect.any(String) },
								{ message: "injected unknown-open physical close failure 2", stack: expect.any(String) },
							],
						}
					: originalWorkerEvidence,
			);
			expect(opens).toEqual([
				expect.objectContaining({
					id: originalFailure.requestId,
					driver: { path: databasePath, identity, create: true, liveOwner: true, capacity: borrowedCapacity },
				}),
				expect.objectContaining({
					driver: { path: databasePath, identity, create: false, liveOwner: true, capacity: borrowedCapacity },
				}),
			]);
			expect(replacementBoundaries).toEqual([true]);
			expect(releaseBoundaries).toEqual([true]);
			expect(releases).toBe(1);
			expect(committedOpenings).toBe(1);
			expect(mutations).toBe(0);
			expect(callbacks).toBe(0);
			const recoveredOwnership = await acquireAuthorityOwnership(path.join(directory, "root.jsonl"), {
				owningSessionId: identity.owningSessionId,
			});
			const recovered = await openTrackedAuthority(
				{ path: databasePath, identity, create: false },
				recoveredOwnership,
				factory,
			);
			const exported = await recovered.exportState();
			const committed = exported.frames[0];
			if (!committed) throw new Error("Real post-COMMIT opening lost its committed owner frame");
			expect(committed.command).toMatchObject({ kind: "owner", owner: { epoch: 1, phase: "recovering" } });
			expect(
				await recovered.resolveReceipt(
					committed.request.requestId,
					committed.receipt.ownerEpoch,
					identity.incarnation,
					committed.receipt.payloadHash,
				),
			).toEqual(committed.receipt);
			expect(exported.frames.filter(frame => frame.command.kind !== "owner")).toEqual([]);
			await recovered.close();
		});
	}
	it("recovers a valid seeded SQLite client at the exact existing store without seed, callback or mutation replay", async () => {
		const { ownership: acquired, path: databasePath, directory } = await makeOwnedAuthority("sqlite");
		const identity: AuthorityIdentity = {
			backend: "sqlite",
			owningSessionId: "native-root",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const source = new SqliteAuthorityPersistence({
			path: path.join(directory, "valid-seed.sqlite"),
			identity,
			create: true,
		});
		fixtureDrivers.add(source);
		const sourceEngine = new AuthorityEngine(source, "native-seed-owner");
		sourceEngine.recover();
		const seededIntent = operationRecord("native-seeded-operation");
		const seededIntentReceipt = sourceEngine.transition(seededIntent, { requestId: "native-seeded-intent-request" });
		const seededRecord: DurableOperationRecord = { ...seededIntent, phase: "cancelled" };
		const seededReceipt = sourceEngine.transition(seededRecord, { requestId: "native-seeded-request" });
		const seed = sourceEngine.exportState();
		sourceEngine.close();
		fixtureDrivers.delete(source);
		let releases = 0;
		let callbacks = 0;
		let mutations = 0;
		const opens: unknown[] = [];
		const factory = createTrackedWorkerFactory(
			message => {
				opens.push(message);
			},
			[],
			() => {
				mutations++;
			},
			"normal",
			() => {},
		);
		const ownership: AuthorityOwnership = {
			...acquired,
			release: async () => {
				releases++;
				await acquired.release();
			},
		};
		const client = await openTrackedAuthority(
			{ path: databasePath, identity, create: true, seed },
			ownership,
			factory,
		);
		expect(
			await client.getOperation(seededRecord.ownerId, seededRecord.effectClass, seededRecord.operationId),
		).toEqual({ record: seededRecord, version: 2 });
		expect(await client.resolveReceipt("native-seeded-intent-request")).toEqual(seededIntentReceipt);
		expect(await client.resolveReceipt("native-seeded-request")).toEqual(seededReceipt);
		const record = operationRecord("native-after-seed-operation");
		const receipt = await withAuthorityEffect(client, async () => {
			const result = await client.transition(record, { requestId: "native-after-seed-request" });
			callbacks++;
			return result;
		});
		const beforeFailure = await client.exportState();
		expect(beforeFailure.frames.slice(0, seed.frames.length)).toEqual([...seed.frames]);
		workers[0]!.dispatchEvent(new ErrorEvent("error", { message: "injected seeded-client transport failure" }));
		await client.close();
		expect(opens).toEqual([
			expect.objectContaining({
				driver: { path: databasePath, identity, create: true, seed, liveOwner: true, capacity: borrowedCapacity },
			}),
			expect.objectContaining({
				driver: { path: databasePath, identity, create: false, liveOwner: true, capacity: borrowedCapacity },
			}),
		]);
		expect(releases).toBe(1);
		expect(mutations).toBe(1);
		expect(callbacks).toBe(1);
		const recoveredOwnership = await acquireAuthorityOwnership(path.join(directory, "root.jsonl"), {
			owningSessionId: "native-root",
		});
		const recovered = await openTrackedAuthority(
			{ path: databasePath, identity, create: false },
			recoveredOwnership,
			factory,
		);
		expect(
			await recovered.getOperation(seededRecord.ownerId, seededRecord.effectClass, seededRecord.operationId),
		).toEqual({ record: seededRecord, version: 2 });
		expect(await recovered.resolveReceipt("native-seeded-intent-request")).toEqual(seededIntentReceipt);
		expect(await recovered.resolveReceipt("native-seeded-request")).toEqual(seededReceipt);
		expect(await recovered.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
			record,
			version: 1,
		});
		expect(await recovered.resolveReceipt("native-after-seed-request")).toEqual(receipt);
		const evidence = await recovered.exportState();
		expect(evidence.frames.slice(0, beforeFailure.frames.length)).toEqual([...beforeFailure.frames]);
		expect(evidence.frames.filter(frame => frame.command.kind === "transition")).toEqual(
			beforeFailure.frames.filter(frame => frame.command.kind === "transition"),
		);
		expect((await recovered.recoveryState()).blocked).toEqual([
			"operation:native-root:native-after-seed-operation:intent",
		]);
		expect(mutations).toBe(1);
		expect(callbacks).toBe(1);
		await recovered.close();
	});
	it("cancels replacement RPC listeners on a synchronous open send failure", async () => {
		const { ownership, path: authorityPath } = await makeOwnedAuthority("jsonl");
		const identity: AuthorityIdentity = {
			backend: "jsonl",
			owningSessionId: "native-root",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		let count = 0;
		let sends = 0;
		let retryOpens = 0;
		let inject = false;
		const removed: string[] = [];
		const failure = new Error("injected synchronous replacement open send failure");
		const factory = (): Worker => {
			const index = ++count;
			const worker = createTrackedWorkerFactory(
				() => {
					if (index > 2) retryOpens++;
				},
				[],
				() => {},
				"normal",
				() => {},
			)();
			// Only the first fenced replacement fails to send; an explicit cleanup retry must replace it again.
			if (index !== 2) return worker;
			return new Proxy(worker, {
				get(target, property) {
					if (property === "postMessage")
						return (message: unknown): void => {
							if (
								typeof message === "object" &&
								message !== null &&
								"kind" in message &&
								message.kind === "open"
							) {
								sends++;
								inject = true;
								throw failure;
							}
							target.postMessage(message);
						};
					if (property === "removeEventListener")
						return (...args: Parameters<Worker["removeEventListener"]>): void => {
							if (inject) removed.push(args[0]);
							target.removeEventListener(...args);
						};
					const member = Reflect.get(target, property, target);
					return typeof member === "function" ? member.bind(target) : member;
				},
			});
		};
		const client = await openTrackedAuthority({ path: authorityPath, identity, create: true }, ownership, factory);
		workers[0]!.dispatchEvent(new ErrorEvent("error", { message: "injected transport failure" }));
		const closeOutcome = await observePromise(client.close());
		expect(rejectionReason(closeOutcome)).toBe(failure);
		expect(sends).toBe(1);
		expect(removed.slice(0, 3)).toEqual(["message", "messageerror", "error"]);
		expect(await trackCleanupAttempt(identity.owningSessionId)).toBe(true);
		expect(count).toBe(3);
		expect(retryOpens).toBe(1);
		expect(sends).toBe(1);
		clients.splice(clients.indexOf(client), 1);
	});
	it("preserves construction and distinct cleanup failures while retrying the worker-owned SQLite handle", async () => {
		const { ownership: acquired, path: databasePath, directory } = await makeOwnedAuthority("sqlite");
		const identity: AuthorityIdentity = {
			backend: "sqlite",
			owningSessionId: "native-root",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const sourceOptions: AuthorityDriverOptions = {
			path: path.join(directory, "seed-source.sqlite"),
			identity,
			create: true,
		};
		const source = new SqliteAuthorityPersistence(sourceOptions);
		fixtureDrivers.add(source);
		const seed = source.exportState();
		source.close();
		fixtureDrivers.delete(source);
		const invalidSeed: AuthorityExport = { ...seed, revision: -1 };
		let ownershipReleases = 0;
		const ownership: AuthorityOwnership = {
			...acquired,
			release: async () => {
				ownershipReleases++;
				await acquired.release();
			},
		};
		const closeAttempts: unknown[] = [];
		let openCount = 0;
		const terminations: Array<PromiseWithResolvers<void>> = [];
		const workerFactory = createTrackedWorkerFactory(
			() => openCount++,
			terminations,
			() => {},
			"sqlite-construction-failure",
			value => {
				if (isFixturePhase(value, "sqlite-close")) closeAttempts.push(value);
			},
		);
		let openingFailure: unknown;
		try {
			await openTrackedAuthority(
				{ path: databasePath, identity, create: true, seed: invalidSeed },
				ownership,
				workerFactory,
			);
		} catch (error) {
			openingFailure = error;
		}
		expect(openingFailure).toBeInstanceOf(AuthorityRpcError);
		if (!(openingFailure instanceof AuthorityRpcError))
			throw new Error("SQLite worker opening did not preserve its RPC failure");
		expect(openingFailure.cause).toEqual(
			expect.objectContaining({
				name: "SqliteAuthorityConstructionError",
				constructionError: expect.objectContaining({ message: expect.stringMatching(/header metadata/i) }),
				cleanupErrors: expect.arrayContaining([
					expect.objectContaining({ message: "injected physical close boundary failure" }),
				]),
				errors: expect.arrayContaining([
					expect.objectContaining({ message: expect.stringMatching(/header metadata/i) }),
					expect.objectContaining({ message: "injected physical close boundary failure" }),
				]),
			}),
		);
		expect(closeAttempts).toEqual([
			expect.objectContaining({ attempt: "initial", force: true }),
			expect.objectContaining({ attempt: "retry", sameHandle: true, force: true }),
		]);
		expect(openCount).toBe(1);
		expect(ownershipReleases).toBe(1);
		for (const suffix of ["", "-wal", "-shm"]) {
			let statFailure: unknown;
			try {
				await fs.stat(`${databasePath}${suffix}`);
			} catch (error) {
				statFailure = error;
			}
			expect(statFailure).toEqual(expect.objectContaining({ code: "ENOENT" }));
		}
	});
});
