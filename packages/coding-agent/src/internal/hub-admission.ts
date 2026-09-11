import type { ToolSession } from "../tools";
import type { AgentRegistry } from "../registry/agent-registry";
import type { HubSessionAuthority } from "./hub-authority";
import {
	isHubSessionAuthority,
	isHubSessionAuthorityLive,
	resolveHubAdmissionAuthority,
	type HubAdmissionAuthorityBinding,
} from "./hub-authority";
import {
	canonicalSha256,
	durableHubStoreForSession,
	type DurableHubStore,
	type HubDurableMutation,
} from "./hub-durable-state";

declare const hubAdmissionAttemptBrand: unique symbol;

/** Opaque membership token for one logical Hub invocation. */
export interface HubAdmissionAttempt {
	readonly [hubAdmissionAttemptBrand]: never;
}

/** Settlement-only view retained by the Hub invocation wrapper. */
export interface HubStateTransaction {
	commit(): void;
	rollback(): void;
	abandon(): void;
}

export interface HubAdmissionFinalizers {
	readonly hold: () => void;
	/** Legacy callback retained as an in-memory apply hook. */
	readonly commit: () => void;
	readonly rollback: () => void;
	readonly abandon: () => void;
	readonly prepare?: () => readonly HubDurableMutation[];
	readonly apply?: () => void;
}

/** Admission view used only while selecting state or starting a Hub effect. */
export interface HubAdmissionStateTransaction extends HubStateTransaction {
	readonly attempt: HubAdmissionAttempt;
	assertActive(): void;
	markEffect(): void;
	enlist(finalizers: HubAdmissionFinalizers): void;
	recordWait(waiterId: string, payload: Readonly<Record<string, unknown>>): void;
	stageDurable(mutation: HubDurableMutation): void;
	select<T>(selector: () => T): T;
}

export interface HubAdmissionLifecycle {
	readonly transaction: HubStateTransaction;
	readonly admissionTransaction: HubAdmissionStateTransaction;
}

type AttemptState = "active" | "retired";
type InvocationState = "active" | "retryable" | "retired";
type TransactionState = "open" | "settling" | "finished";
type SelectionState = "fresh" | "held" | "finished";

interface AuthorityBinding {
	readonly kind: "authority";
	readonly registry: AgentRegistry;
	readonly authority: HubSessionAuthority;
	readonly session: ToolSession;
	readonly actorId: string;
	readonly owner: object;
	readonly rootId: string;
	readonly operationAuthority: HubAdmissionAuthorityBinding;
}

type AdmissionBinding = AuthorityBinding;

interface AttemptRecord {
	readonly manager: HubAdmissionManager;
	readonly invocation: InvocationRecord;
	readonly binding: AdmissionBinding;
	state: AttemptState;
}

interface InvocationRecord {
	readonly toolCallId: string;
	readonly fingerprint: string;
	readonly attempt: HubAdmissionAttempt;
	readonly attemptRecord: AttemptRecord;
	state: InvocationState;
	readonly durableAttemptId?: string;
	readonly durableEntityId?: string;
	readonly durableStore?: DurableHubStore;
	readonly fingerprintSha256?: string;
	readonly durableScope?: string;
}

interface TransactionRecord {
	readonly invocation: InvocationRecord;
	readonly attempt: HubAdmissionAttempt;
	readonly attemptRecord: AttemptRecord;
	readonly selections: object[];
	readonly durableMutations: HubDurableMutation[];
	state: TransactionState;
	enlisting: boolean;
	effectStarted: boolean;
	readonly durableWaiters: Set<string>;
}

interface SelectionRecord {
	readonly transactionRecord: TransactionRecord;
	readonly finalizers: HubAdmissionFinalizers;
	state: SelectionState;
}

const authorityManagers = new WeakMap<AgentRegistry, HubAdmissionManager>();
const attemptMembership = new WeakMap<object, AttemptRecord>();
const transactionMembership = new WeakMap<object, TransactionRecord>();
const admissionTransactionMembership = new WeakSet<object>();
const selectionMembership = new WeakMap<object, SelectionRecord>();

function bindingIsLive(binding: AdmissionBinding): boolean {
	return binding.operationAuthority.validate() && isHubSessionAuthorityLive(binding.authority, binding.session);
}

function sameBinding(left: AdmissionBinding, right: AdmissionBinding): boolean {
	return (
		left.registry === right.registry &&
		left.session === right.session &&
		left.actorId === right.actorId &&
		left.owner === right.owner &&
		left.rootId === right.rootId &&
		left.operationAuthority.capability === right.operationAuthority.capability &&
		left.operationAuthority.generation === right.operationAuthority.generation
	);
}

function transactionFor(value: object): TransactionRecord {
	const transaction = transactionMembership.get(value);
	if (!transaction) throw new Error("Invalid Hub state transaction.");
	if (transaction.state !== "open") throw new Error("Hub admission transaction is finished.");
	if (transaction.attemptRecord.state !== "active" || transaction.invocation.state !== "active") {
		throw new Error("Hub admission attempt is retired.");
	}
	if (
		attemptMembership.get(transaction.attempt as object) !== transaction.attemptRecord ||
		transaction.invocation.attempt !== transaction.attempt
	) {
		throw new Error("Invalid Hub admission attempt membership.");
	}
	if (!bindingIsLive(transaction.attemptRecord.binding)) {
		throw new Error("Hub admission authority is stale or replaced.");
	}
	return transaction;
}

function finishSelections(transaction: TransactionRecord, outcome: "commit" | "rollback" | "abandon"): void {
	const selections = transaction.selections.splice(0);
	let firstError: unknown;
	for (const selection of selections) {
		const record = selectionMembership.get(selection);
		if (!record || record.transactionRecord !== transaction || record.state !== "held") continue;
		try {
			record.finalizers[outcome]();
		} catch (error) {
			firstError ??= error;
		} finally {
			record.state = "finished";
		}
	}
	if (firstError !== undefined) throw firstError;
}

function persistAdmission(
	invocation: InvocationRecord,
	state: "active" | "retryable" | "committed" | "abandoned",
	effectStarted: boolean,
): void {
	if (!invocation.durableStore || !invocation.durableAttemptId || !invocation.durableEntityId) return;
	invocation.durableStore.append("admission", invocation.durableEntityId, invocation.durableAttemptId, {
		state,
		toolCallId: invocation.toolCallId,
		fingerprintSha256: invocation.fingerprintSha256,
		scope: invocation.durableScope,
		effectStarted,
	});
}

function retireAttempt(transaction: TransactionRecord): void {
	transaction.attemptRecord.state = "retired";
	transaction.invocation.state = "retired";
}

function beginSettlement(view: object): TransactionRecord {
	const transaction = transactionMembership.get(view);
	if (!transaction) throw new Error("Invalid Hub state transaction.");
	if (transaction.state !== "open") throw new Error("Hub admission transaction is finished.");
	if (transaction.enlisting) throw new Error("Hub admission transaction cannot settle during observation enlistment.");
	transaction.state = "settling";
	return transaction;
}

function admissionMutation(
	invocation: InvocationRecord,
	state: "committed" | "abandoned",
	effectStarted: boolean,
): HubDurableMutation | undefined {
	if (!invocation.durableStore || !invocation.durableAttemptId || !invocation.durableEntityId) return undefined;
	return {
		kind: "admission",
		entityId: invocation.durableEntityId,
		incarnationId: invocation.durableAttemptId,
		payload: {
			state,
			toolCallId: invocation.toolCallId,
			fingerprintSha256: invocation.fingerprintSha256,
			scope: invocation.durableScope,
			effectStarted,
		},
	};
}

function prepareSelections(transaction: TransactionRecord): HubDurableMutation[] {
	const mutations = [...transaction.durableMutations];
	let stagedCount = transaction.durableMutations.length;
	for (const selection of transaction.selections) {
		const record = selectionMembership.get(selection);
		if (!record || record.transactionRecord !== transaction || record.state !== "held") continue;
		if (record.finalizers.prepare) record.finalizers.prepare();
		if (transaction.durableMutations.length > stagedCount) {
			mutations.push(...transaction.durableMutations.slice(stagedCount));
			stagedCount = transaction.durableMutations.length;
		}
	}
	return mutations;
}

function applySelections(transaction: TransactionRecord): void {
	const selections = transaction.selections.splice(0);
	for (const selection of selections) {
		const record = selectionMembership.get(selection);
		if (!record || record.transactionRecord !== transaction || record.state !== "held") continue;
		try {
			(record.finalizers.apply ?? record.finalizers.commit)();
		} catch {
			// The durable batch is authoritative; recovery will finish this apply forward.
		}
		record.state = "finished";
	}
}

function settleTransaction(view: object, requested: "commit" | "rollback" | "abandon"): void {
	const transaction = beginSettlement(view);
	const live = bindingIsLive(transaction.attemptRecord.binding);
	if (!live && requested === "commit") {
		finishSelections(transaction, "abandon");
		transaction.state = "finished";
		retireAttempt(transaction);
		throw new Error("Hub admission authority is stale or replaced.");
	}

	if (requested === "commit") {
		try {
			const admission = admissionMutation(transaction.invocation, "committed", transaction.effectStarted);
			const mutations = prepareSelections(transaction);
			if (admission) mutations.unshift(admission);
			if (transaction.invocation.durableStore && mutations.length > 0)
				transaction.invocation.durableStore.appendBatch(mutations);
			applySelections(transaction);
			transaction.state = "finished";
			retireAttempt(transaction);
			return;
		} catch (error) {
			try {
				finishSelections(transaction, transaction.effectStarted ? "abandon" : "rollback");
			} finally {
				transaction.durableMutations.length = 0;
				transaction.state = "finished";
				retireAttempt(transaction);
			}
			throw error;
		}
	}

	const retryable = requested === "rollback" && !transaction.effectStarted && live;
	let firstError: unknown;
	try {
		finishSelections(transaction, retryable ? "rollback" : requested === "rollback" ? "abandon" : "abandon");
	} catch (error) {
		firstError = error;
	} finally {
		transaction.durableMutations.length = 0;
		transaction.state = "finished";
		if (retryable && firstError === undefined) transaction.invocation.state = "retryable";
		else retireAttempt(transaction);
		if (retryable) persistAdmission(transaction.invocation, "retryable", transaction.effectStarted);
		else if (transaction.invocation.durableStore) {
			const mutation = admissionMutation(transaction.invocation, "abandoned", transaction.effectStarted);
			if (mutation) transaction.invocation.durableStore.appendBatch([mutation]);
		}
	}
	if (requested === "rollback" && transaction.effectStarted)
		throw new Error("Hub admission attempt cannot retry after an effect started.");
	if (firstError !== undefined) throw firstError;
}

function createBaseTransaction(transaction: TransactionRecord): HubStateTransaction {
	const view = Object.freeze({
		commit(): void {
			settleTransaction(view, "commit");
		},
		rollback(): void {
			settleTransaction(view, "rollback");
		},
		abandon(): void {
			settleTransaction(view, "abandon");
		},
	});
	transactionMembership.set(view, transaction);
	return view;
}

function enlistSelection(view: object, finalizers: HubAdmissionFinalizers): void {
	const transaction = transactionFor(view);
	if (!admissionTransactionMembership.has(view)) throw new Error("Invalid Hub admission transaction.");
	if (transaction.enlisting) throw new Error("Hub admission transaction is busy.");
	const selection = Object.freeze(Object.create(null)) as object;
	const record: SelectionRecord = { transactionRecord: transaction, finalizers, state: "fresh" };
	selectionMembership.set(selection, record);

	// The immutable finalizers are registered before hold runs. Settlement is
	// blocked during hold so reentrancy cannot strand manager-owned state.
	transaction.selections.push(selection);
	transaction.enlisting = true;
	try {
		finalizers.hold();
		record.state = "held";
	} catch (error) {
		const index = transaction.selections.lastIndexOf(selection);
		if (index !== -1) transaction.selections.splice(index, 1);
		try {
			finalizers.rollback();
		} finally {
			record.state = "finished";
		}
		throw error;
	} finally {
		transaction.enlisting = false;
	}
}

function createAdmissionTransaction(transaction: TransactionRecord): HubAdmissionStateTransaction {
	const view = Object.freeze({
		get attempt(): HubAdmissionAttempt {
			return transactionFor(view).attempt;
		},
		assertActive(): void {
			transactionFor(view);
		},
		markEffect(): void {
			const active = transactionFor(view);
			active.effectStarted = true;
			persistAdmission(active.invocation, "active", true);
		},
		enlist(finalizers: HubAdmissionFinalizers): void {
			enlistSelection(view, finalizers);
		},
		recordWait(waiterId: string, payload: Readonly<Record<string, unknown>>): void {
			const active = transactionMembership.get(view);
			if (!active || active.state === "finished") throw new Error("Hub admission transaction is finished.");
			const invocation = active.invocation;
			if (!invocation.durableStore || !invocation.durableAttemptId || !invocation.durableEntityId) return;
			const entityId = `${invocation.durableEntityId}:wait:${waiterId}`;
			if (!active.durableWaiters.has(waiterId)) {
				if (!invocation.durableStore.reserve("wait", entityId, waiterId))
					throw new Error("Hub waiter identity is already occupied.");
				active.durableWaiters.add(waiterId);
			}
			active.durableMutations.push({ kind: "wait", entityId, incarnationId: waiterId, payload });
		},
		stageDurable(mutation: HubDurableMutation): void {
			const active = transactionFor(view);
			active.durableMutations.push(mutation);
		},
		select<T>(selector: () => T): T {
			let selected: T | undefined;
			let completed = false;
			enlistSelection(view, {
				hold: () => {
					selected = selector();
					completed = true;
				},
				commit: () => {},
				rollback: () => {},
				abandon: () => {},
			});
			if (!completed) throw new Error("Hub state selection did not complete.");
			return selected as T;
		},
		commit(): void {
			settleTransaction(view, "commit");
		},
		rollback(): void {
			settleTransaction(view, "rollback");
		},
		abandon(): void {
			settleTransaction(view, "abandon");
		},
	});
	transactionMembership.set(view, transaction);
	admissionTransactionMembership.add(view);
	return view;
}

class HubAdmissionManager {
	readonly #invocationsBySession = new WeakMap<object, Map<string, InvocationRecord>>();
	readonly #recoveredByStore = new WeakMap<
		DurableHubStore,
		Map<string, { incarnationId: string; payload: Readonly<Record<string, unknown>> }>
	>();

	#recoverStore(
		store: DurableHubStore,
	): Map<string, { incarnationId: string; payload: Readonly<Record<string, unknown>> }> {
		const existing = this.#recoveredByStore.get(store);
		if (existing) return existing;
		const recovered = new Map<string, { incarnationId: string; payload: Readonly<Record<string, unknown>> }>();
		let cursor = 0;
		for (;;) {
			const batch = store.recover(cursor, 100);
			for (const record of batch.records) {
				if (record.kind !== "admission") continue;
				const prior = recovered.get(record.entityId);
				if (prior && prior.incarnationId !== record.incarnationId) {
					recovered.set(record.entityId, { incarnationId: "ambiguous", payload: { state: "abandoned" } });
					continue;
				}
				recovered.set(record.entityId, { incarnationId: record.incarnationId, payload: record.payload });
			}
			if (batch.nextCursor === undefined) break;
			cursor = batch.nextCursor;
		}
		this.#recoveredByStore.set(store, recovered);
		return recovered;
	}

	begin(binding: AdmissionBinding, toolCallId: string, fingerprint: string): HubAdmissionLifecycle {
		if (!toolCallId) throw new Error("Hub admission requires a tool call id.");
		if (!bindingIsLive(binding)) throw new Error("Hub admission authority is stale or replaced.");
		const sessionFile = binding.session.getSessionFile?.() ?? undefined;
		const durableStore = sessionFile ? durableHubStoreForSession(sessionFile) : undefined;
		const durableScope = binding.actorId;
		const durableEntityId = `${durableScope}:${toolCallId}`;
		const fingerprintSha256 = canonicalSha256({ fingerprint });
		let invocations = this.#invocationsBySession.get(binding.session as object);
		if (!invocations) {
			invocations = new Map();
			this.#invocationsBySession.set(binding.session as object, invocations);
		}
		let invocation = invocations.get(toolCallId);
		if (invocation) {
			if (invocation.fingerprint !== fingerprint || !sameBinding(invocation.attemptRecord.binding, binding)) {
				throw new Error("Hub tool call id was replayed with a different operation or authority.");
			}
			if (invocation.state === "active") throw new Error("Hub admission invocation is already active.");
			if (invocation.state === "retired") throw new Error("Hub admission attempt is retired.");
			invocation.state = "active";
			persistAdmission(invocation, "active", false);
		} else {
			if (durableStore) {
				const recovered = this.#recoverStore(durableStore).get(durableEntityId);
				if (recovered) {
					if (recovered.payload.fingerprintSha256 !== fingerprintSha256) {
						throw new Error("Hub tool call id was recovered with a different operation.");
					}
					throw new Error("Recovered Hub admission attempt is retired and cannot be reminted.");
				}
			}
			const durableAttemptId = crypto.randomUUID();
			if (durableStore && !durableStore.reserve("admission", durableEntityId, durableAttemptId)) {
				throw new Error("Recovered Hub admission identity is occupied and cannot be reminted.");
			}
			const attempt = Object.freeze(Object.create(null)) as HubAdmissionAttempt;
			const attemptRecord = {} as AttemptRecord;
			invocation = {
				toolCallId,
				fingerprint,
				attempt,
				attemptRecord,
				state: "active",
				durableAttemptId,
				durableEntityId,
				durableStore,
				fingerprintSha256,
				durableScope,
			};
			Object.assign(attemptRecord, { manager: this, invocation, binding, state: "active" as const });
			attemptMembership.set(attempt as object, attemptRecord);
			invocations.set(toolCallId, invocation);
			persistAdmission(invocation, "active", false);
		}
		const transactionRecord: TransactionRecord = {
			invocation,
			attempt: invocation.attempt,
			attemptRecord: invocation.attemptRecord,
			selections: [],
			durableMutations: [],
			state: "open",
			enlisting: false,
			effectStarted: false,
			durableWaiters: new Set(),
		};
		return Object.freeze({
			transaction: createBaseTransaction(transactionRecord),
			admissionTransaction: createAdmissionTransaction(transactionRecord),
		});
	}
}

function authorityManager(registry: AgentRegistry): HubAdmissionManager {
	let manager = authorityManagers.get(registry);
	if (!manager) {
		manager = new HubAdmissionManager();
		authorityManagers.set(registry, manager);
	}
	return manager;
}

/** Begin one access-bound logical Hub invocation through its private manager. */
export function beginHubAdmission(
	access: HubSessionAuthority,
	session: ToolSession,
	toolCallId: string,
	fingerprint: string,
): HubAdmissionLifecycle {
	if (!isHubSessionAuthority(access)) {
		throw new Error("Hub admission requires an exact session authority.");
	}
	const operationAuthority = resolveHubAdmissionAuthority(access);
	if (!operationAuthority) throw new Error("Hub admission authority is stale or replaced.");
	const binding: AuthorityBinding = {
		kind: "authority",
		registry: access.registry,
		authority: access,
		session,
		actorId: access.actorId,
		owner: access.owner,
		rootId: access.rootId,
		operationAuthority,
	};
	return authorityManager(access.registry).begin(binding, toolCallId, fingerprint);
}
