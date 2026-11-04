import { parentPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import {
	assertAuthorityWireBudget,
	AUTHORITY_DIRECT_WORKER_ARG,
	AUTHORITY_RESOURCE_CAPS,
	isAuthorityReadMethod,
} from "./client";
import { AuthorityEngine } from "./engine";
import { openAuthorityPersistence } from "./persistence";
import {
	authorityFailureEvidence,
	authorityThreadReadyMessage,
	handleAuthorityThreadLifetimeMessage,
} from "./thread-lifetime";
import { SqliteAuthorityConstructionError } from "./sqlite-driver";
import { AuthorityGroupBoundaryError } from "./types";
import type {
	AuthorityDriverOptions,
	AuthorityMethod,
	AuthorityOwner,
	AuthorityPersistence,
	AuthorityRpcCall,
	AuthorityRpcOpen,
	AuthorityRpcResponse,
} from "./types";

const AUTHORITY_METHODS: Record<AuthorityMethod, true> = {
	transition: true,
	transitionBatch: true,
	activateAuthority: true,
	commitRootTransition: true,
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
	recover: true,
	recoveryState: true,
	validateRevival: true,
	reserveLocal: true,
	authorizeLocalEffect: true,
	finalizeLocal: true,
	reconcileLocal: true,
	localBacking: true,
	resolveReceipt: true,
	quarantine: true,
	exportState: true,
	close: true,
};

/**
 * Commands that may share one durable sync. Everything else (reads, recover, quarantine, close, export) is a
 * group barrier: the open group is synced and acknowledged first, so a read never observes unsynced state
 * and owner/lifecycle changes never mix with grouped frames.
 */
const GROUPABLE_METHODS: Partial<Record<AuthorityMethod, true>> = {
	transition: true,
	transitionBatch: true,
	activateAuthority: true,
	commitRootTransition: true,
	reserveLocal: true,
	authorizeLocalEffect: true,
	finalizeLocal: true,
	reconcileLocal: true,
};

/**
 * Group bounds. There is no wait window: a group holds only the commands already queued at this worker when
 * its first member ran (they arrive while the previous sync blocks this thread), and it is synced on the next
 * event-loop turn after the queue drains (setImmediate), or at once when a bound or a barrier is reached.
 * A lone command therefore syncs immediately, exactly as before group commit.
 */
export const AUTHORITY_GROUP_COMMIT_LIMITS = {
	maxCommands: 64,
	maxRequestBytes: 8 * 1024 * 1024,
} as const;

type HeldResponse =
	| { readonly id: string; readonly ok: true; readonly value: unknown }
	| { readonly id: string; readonly ok: false; readonly error: unknown; readonly unknownOutcome: boolean };

interface OpenCommitGroup {
	readonly responses: HeldResponse[];
	commands: number;
	bytes: number;
}

export async function runAuthorityWorker(): Promise<void> {
	if (!parentPort) throw new Error("Authority worker requires a Bun worker parent port");
	let engine: AuthorityEngine | undefined;
	let owner: AuthorityOwner | undefined;
	let opened = false;
	let group: OpenCommitGroup | undefined;
	const failedOpenCleanup: Array<() => void> = [];
	const failedOpenFailures: unknown[] = [];
	parentPort.postMessage(authorityThreadReadyMessage());
	parentPort.on("message", (message: unknown) => {
		if (handleAuthorityThreadLifetimeMessage(message, parentPort!)) return;
		if (isFailedOpenCleanupRequest(message)) {
			try {
				if (failedOpenCleanup.length > 0) {
					for (const cleanup of failedOpenCleanup) cleanup();
					failedOpenCleanup.length = 0;
				} else if (engine) {
					engine.close();
				}
				engine = undefined;
				parentPort!.postMessage({
					kind: "authority-thread-lifetime",
					phase: "cleanup",
					id: message.id,
					ok: true,
					failures: failedOpenFailures.map(authorityFailureEvidence),
				});
				setTimeout(() => process.exit(0), 0);
			} catch (error) {
				if (!failedOpenFailures.includes(error)) failedOpenFailures.push(error);
				parentPort!.postMessage({
					kind: "authority-thread-lifetime",
					phase: "cleanup",
					id: message.id,
					ok: false,
					message: error instanceof Error ? error.message : String(error),
					failures: failedOpenFailures.map(authorityFailureEvidence),
				});
			}
			return;
		}
		if (isOpenRequest(message)) {
			if (opened) {
				sendError(message.id, new Error("Authority worker accepts one store per lifetime"), false);
				return;
			}
			opened = true;
			let persistence: AuthorityPersistence | undefined;
			try {
				persistence = openAuthorityPersistence(message.driver);
				engine = new AuthorityEngine(persistence, message.ownerToken);
				const recovery = engine.recover();
				owner = recovery.owner;
				const recoveredTail = persistence.recoveredTail;
				sendSuccess(
					message.id,
					{ identity: engine.identity, recovery, ...(recoveredTail !== undefined ? { recoveredTail } : {}) },
					true,
				);
			} catch (error) {
				if (!failedOpenFailures.includes(error)) failedOpenFailures.push(error);
				if (error instanceof SqliteAuthorityConstructionError) failedOpenCleanup.push(() => error.cleanup());
				if (engine) {
					const failedEngine = engine;
					failedOpenCleanup.push(() => failedEngine.close());
				} else if (persistence) {
					const openedPersistence = persistence;
					failedOpenCleanup.push(() => openedPersistence.close());
				}
				sendError(message.id, error, hasUnknownOutcome(error));
			}
			return;
		}
		if (!isCallRequest(message)) {
			logger.warn("Ignoring malformed authority worker request");
			return;
		}
		if (!engine || !owner) {
			sendError(message.id, new Error("Authority worker has not completed store recovery"), false);
			return;
		}
		if (GROUPABLE_METHODS[message.method] === true && engine.groupCommitSupported) {
			admitGroupMember(message, engine);
			return;
		}
		flushGroup(engine);
		void processCall(message, engine);
	});

	function admitGroupMember(call: AuthorityRpcCall, engine: AuthorityEngine): void {
		const bytes = Buffer.byteLength(JSON.stringify(call.args), "utf8");
		if (
			group &&
			(group.commands >= AUTHORITY_GROUP_COMMIT_LIMITS.maxCommands ||
				group.bytes + bytes > AUTHORITY_GROUP_COMMIT_LIMITS.maxRequestBytes)
		)
			flushGroup(engine);
		runGroupMember(call, engine, bytes, false);
	}

	function runGroupMember(call: AuthorityRpcCall, engine: AuthorityEngine, bytes: number, retried: boolean): void {
		if (call.deadline <= Date.now()) {
			holdOrSendError(call.id, new Error("Authority request expired before worker admission"), false);
			return;
		}
		if (
			!owner ||
			call.owner.incarnation !== owner.incarnation ||
			call.owner.epoch !== owner.epoch ||
			call.owner.token !== owner.token
		) {
			holdOrSendError(call.id, new Error("Authority request belongs to a stale owner epoch"), false);
			return;
		}
		if (!group) {
			try {
				engine.beginGroup();
			} catch (error) {
				sendError(call.id, error, hasUnknownOutcome(error));
				return;
			}
			const opening: OpenCommitGroup = { responses: [], commands: 0, bytes: 0 };
			group = opening;
			// Zero-delay window: messages already queued are dispatched before this callback runs.
			setImmediate(() => {
				if (group === opening) flushGroup(engine);
			});
		}
		const current = group;
		try {
			const method: unknown = Reflect.get(engine, call.method);
			if (typeof method !== "function") throw new Error(`Unknown authority method ${call.method}`);
			const value: unknown = Reflect.apply(method, engine, call.args);
			current.responses.push({ id: call.id, ok: true, value });
		} catch (error) {
			if (error instanceof AuthorityGroupBoundaryError && !retried) {
				// Nothing was written for this command: sync the members before it, then run it alone.
				flushGroup(engine);
				runGroupMember(call, engine, bytes, true);
				return;
			}
			const unknownOutcome = hasUnknownOutcome(error);
			current.responses.push({ id: call.id, ok: false, error, unknownOutcome });
			current.commands++;
			current.bytes += bytes;
			// An unknown member poisons the driver; settle the whole group now rather than stage more.
			if (unknownOutcome) flushGroup(engine);
			return;
		}
		current.commands++;
		current.bytes += bytes;
	}

	/**
	 * One durable sync for the open group, then every held response in arrival order. Acknowledgements are
	 * sent only here, after sync() returned, so a host effect awaiting any grouped command runs after its
	 * frame is durable. If the sync fails, every grouped command (including one refused inside the group)
	 * is reported as an unknown outcome: the group is one transaction, so no partial known result exists.
	 */
	function flushGroup(engine: AuthorityEngine): void {
		const closing = group;
		if (!closing) return;
		group = undefined;
		let failure: unknown;
		let failed = false;
		try {
			engine.syncGroup();
		} catch (error) {
			failure = error;
			failed = true;
		}
		for (const response of closing.responses) {
			if (failed) sendError(response.id, failure, true);
			else if (response.ok) sendSuccess(response.id, response.value, true);
			else sendError(response.id, response.error, response.unknownOutcome);
		}
	}

	function holdOrSendError(id: string, error: unknown, unknownOutcome: boolean): void {
		// Responses leave in request order, so a refusal behind an open group waits for that group's sync.
		if (group) {
			group.responses.push({ id, ok: false, error, unknownOutcome });
			group.commands++;
		} else sendError(id, error, unknownOutcome);
	}

	async function processCall(call: AuthorityRpcCall, engine: AuthorityEngine): Promise<void> {
		if (call.deadline <= Date.now()) {
			sendError(call.id, new Error("Authority request expired before worker admission"), false);
			return;
		}
		if (
			!owner ||
			call.owner.incarnation !== owner.incarnation ||
			call.owner.epoch !== owner.epoch ||
			call.owner.token !== owner.token
		) {
			sendError(call.id, new Error("Authority request belongs to a stale owner epoch"), false);
			return;
		}
		try {
			const method: unknown = Reflect.get(engine, call.method);
			if (typeof method !== "function") throw new Error(`Unknown authority method ${call.method}`);
			const result: unknown = await Reflect.apply(method, engine, call.args);
			if (call.method === "recover" && isOwnerBearingState(result)) owner = result.owner;
			sendSuccess(call.id, result, !isAuthorityReadMethod(call.method));
			if (call.method === "close") setTimeout(() => process.exit(0), 0);
		} catch (error) {
			sendError(call.id, error, hasUnknownOutcome(error));
		}
	}

	function sendSuccess(id: string, value: unknown, uncertainOnOverflow: boolean): void {
		const response: AuthorityRpcResponse = { id, ok: true, value };
		try {
			assertAuthorityWireBudget(response, AUTHORITY_RESOURCE_CAPS.maxResponseBytes);
			parentPort!.postMessage(response);
		} catch (error) {
			sendError(id, error, uncertainOnOverflow);
		}
	}

	function sendError(id: string, error: unknown, unknownOutcome: boolean): void {
		const failure = error instanceof Error ? error : new Error(String(error));
		parentPort!.postMessage({
			id,
			ok: false,
			error: { name: failure.name, message: failure.message, unknownOutcome },
		} satisfies AuthorityRpcResponse);
	}
}

function isFailedOpenCleanupRequest(
	value: unknown,
): value is { readonly kind: "authority-thread-lifetime"; readonly phase: "cleanup-request"; readonly id: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "authority-thread-lifetime" &&
		"phase" in value &&
		value.phase === "cleanup-request" &&
		"id" in value &&
		typeof value.id === "string"
	);
}
function isOpenRequest(value: unknown): value is AuthorityRpcOpen {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "open" &&
		"id" in value &&
		typeof value.id === "string" &&
		"driver" in value &&
		isDriverOptions(value.driver) &&
		value.driver.liveOwner === true &&
		"ownerToken" in value &&
		typeof value.ownerToken === "string"
	);
}

function isCallRequest(value: unknown): value is AuthorityRpcCall {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "call" &&
		"id" in value &&
		typeof value.id === "string" &&
		"method" in value &&
		isAuthorityMethod(value.method) &&
		"args" in value &&
		Array.isArray(value.args) &&
		"owner" in value &&
		isOwner(value.owner) &&
		"deadline" in value &&
		typeof value.deadline === "number"
	);
}
function isAuthorityMethod(value: unknown): value is AuthorityMethod {
	return typeof value === "string" && Object.hasOwn(AUTHORITY_METHODS, value);
}

function isDriverOptions(value: unknown): value is AuthorityDriverOptions {
	if (
		typeof value !== "object" ||
		value === null ||
		!("path" in value) ||
		typeof value.path !== "string" ||
		!("identity" in value) ||
		!isIdentity(value.identity) ||
		!("create" in value) ||
		typeof value.create !== "boolean"
	)
		return false;
	if ("liveOwner" in value && typeof value.liveOwner !== "boolean") return false;
	// Capacity is opt-in (OMP_JOURNALING_CAPACITY=xfs); a live owner without it admits writes with no physical reserve.
	if (!("capacity" in value) || value.capacity === undefined) return true;
	const capacity = value.capacity;
	if (
		typeof capacity !== "object" ||
		capacity === null ||
		!("identity" in capacity) ||
		!isCapacityIdentity(capacity.identity) ||
		!("maxRequestBytes" in capacity)
	)
		return false;
	return (
		typeof capacity.maxRequestBytes === "number" &&
		Number.isSafeInteger(capacity.maxRequestBytes) &&
		capacity.maxRequestBytes > 0
	);
}

function isCapacityIdentity(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"fd" in value &&
		typeof value.fd === "number" &&
		Number.isSafeInteger(value.fd) &&
		value.fd >= 0 &&
		"device" in value &&
		typeof value.device === "bigint" &&
		value.device >= 0n &&
		"inode" in value &&
		typeof value.inode === "bigint" &&
		value.inode >= 0n
	);
}

function isIdentity(value: unknown): boolean {
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

function isOwner(value: unknown): value is AuthorityOwner {
	return (
		typeof value === "object" &&
		value !== null &&
		"incarnation" in value &&
		typeof value.incarnation === "string" &&
		"epoch" in value &&
		typeof value.epoch === "number" &&
		"token" in value &&
		typeof value.token === "string" &&
		"phase" in value &&
		(value.phase === "recovering" ||
			value.phase === "ready" ||
			value.phase === "quiescing" ||
			value.phase === "closed")
	);
}

function isOwnerBearingState(value: unknown): value is { owner: AuthorityOwner } {
	return typeof value === "object" && value !== null && "owner" in value && isOwner(value.owner);
}

function hasUnknownOutcome(error: unknown): boolean {
	return typeof error === "object" && error !== null && "unknownOutcome" in error && error.unknownOutcome === true;
}

// Only the direct fallback carries this marker; CLI and fault-worker imports dispatch explicitly.
if (!Bun.isMainThread && Bun.argv.includes(AUTHORITY_DIRECT_WORKER_ARG)) {
	void runAuthorityWorker().catch(error =>
		logger.error("Authority worker startup failed", {
			error: error instanceof Error ? error.message : String(error),
		}),
	);
}
