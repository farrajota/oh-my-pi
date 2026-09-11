/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 */

import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import {
	ensureAgentLive,
	getAgentLifecycleManager,
	isAgentParking,
	lifecycleHasAgent,
	lifecycleManagesRegistry,
} from "../internal/agent-lifecycle-bridge";
import { lookupAgentRef, onInternalRegistryChange } from "../internal/agent-registry-bridge";
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { HubAdmissionStateTransaction } from "../internal/hub-admission";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { CustomMessage } from "../session/messages";
import { DurableHubStore, type HubDurableMutation, type HubDurableRecord } from "../internal/hub-durable-state";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/**
	 * Automated wake-turn relay of a woken subagent's stop output (task executor
	 * `relayWakeTurnOutput`). Relays are answers, never wake sources: the
	 * recipient's own wake-turn relay must skip them or two idle peers
	 * ping-pong forever.
	 */
	wakeRelay?: boolean;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

declare const ircDeliveryBatchBrand: unique symbol;

/** Opaque batch admitted atomically before any delivery leg starts. */
export interface IrcDeliveryBatch {
	readonly [ircDeliveryBatchBrand]: never;
}

export class IrcDeliveryAdmissionError extends Error {
	constructor(readonly receipts: readonly IrcDeliveryReceipt[]) {
		super(receipts[0]?.error ?? "IRC delivery admission failed.");
		this.name = "IrcDeliveryAdmissionError";
	}
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/**
 * Rejection reason for a `send await:true` whose awaited peer reached a
 * terminal stop (ended its turn, parked, was aborted, or unregistered)
 * without ever replying. Distinct from a plain timeout so the sender can
 * surface "they stopped" instead of stranding the caller on the full
 * `irc.timeoutMs` window.
 */
export class IrcAwaitTargetStopped extends Error {
	constructor(target: string) {
		super(`Awaited peer "${target}" stopped without replying.`);
		this.name = "IrcAwaitTargetStopped";
	}
}

/** Mailbox cap per agent, including slots reserved by in-flight transactions. */
const MAILBOX_CAP = 100;

interface IrcNamespaceState {
	readonly mailboxes: Map<string, IrcMessage[]>;
	readonly waiters: Map<string, IrcWaiter[]>;
	readonly lastSent: Map<string, Map<string, number>>;
	readonly reservedSlots: Map<string, number>;
}

interface IrcDeliveryReservation {
	readonly message: IrcMessage;
	readonly targetRef: object;
	convertedToMailbox: boolean;
}

interface IrcDeliveryBatchRecord {
	readonly transaction?: HubAdmissionStateTransaction;
	reservations: IrcDeliveryReservation[];
	readonly stagedMutations: HubDurableMutation[];
	state: "held" | "finished";
}

export interface IrcRecoveryBatch {
	readonly processed: number;
	readonly restoredMessageIds: readonly string[];
	readonly expiredWaiterIds: readonly string[];
	readonly quarantinedIds: readonly string[];
	readonly nextCursor?: number;
}

interface IrcDurableRecoveryState {
	readonly messages: Map<string, HubDurableRecord>;
	readonly waits: Map<string, HubDurableRecord>;
	readonly quarantined: Set<string>;
}

export class IrcBus {
	static #global: IrcBus | undefined;
	static #scoped = new WeakMap<AgentRegistry, Map<string, IrcBus>>();
	static #unscoped = new WeakMap<AgentRegistry, IrcBus>();
	static #namespaces = new WeakMap<AgentRegistry, Map<string, IrcNamespaceState>>();

	static global(): IrcBus {
		if (!IrcBus.#global) IrcBus.#global = new IrcBus();
		return IrcBus.#global;
	}

	static forRegistry(registry: AgentRegistry): IrcBus {
		if (registry === AgentRegistry.global()) return IrcBus.global();
		let bus = IrcBus.#unscoped.get(registry);
		if (!bus) {
			bus = new IrcBus(registry);
			IrcBus.#unscoped.set(registry, bus);
		}
		return bus;
	}

	/** Return the mailbox/waiter bus for one exact registry root. */
	static forRoot(registry: AgentRegistry, rootId: string): IrcBus {
		let byRoot = IrcBus.#scoped.get(registry);
		if (!byRoot) {
			byRoot = new Map();
			IrcBus.#scoped.set(registry, byRoot);
		}
		let bus = byRoot.get(rootId);
		if (!bus) {
			bus = new IrcBus(registry, undefined, rootId);
			byRoot.set(rootId, bus);
		}
		return bus;
	}

	/** Reset global and scoped buses. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
		IrcBus.#scoped = new WeakMap();
		IrcBus.#unscoped = new WeakMap();
		IrcBus.#namespaces = new WeakMap();
	}

	readonly #registry: AgentRegistry;
	readonly #namespace?: string;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #state: IrcNamespaceState;
	readonly #deliveryBatches = new WeakMap<object, IrcDeliveryBatchRecord>();
	#durableStore: DurableHubStore | undefined;
	#durableRecovery: IrcDurableRecoveryState | undefined;

	constructor(
		registry: AgentRegistry = AgentRegistry.global(),
		lifecycle?: AgentLifecycleManager,
		namespace?: string,
		durableStore?: DurableHubStore,
	) {
		this.#registry = registry;
		this.#namespace = namespace;
		this.#durableStore = durableStore;
		const namespaceKey = namespace === undefined ? "unscoped" : `root:${namespace}`;
		let registryNamespaces = IrcBus.#namespaces.get(registry);
		if (!registryNamespaces) {
			registryNamespaces = new Map();
			IrcBus.#namespaces.set(registry, registryNamespaces);
		}
		let state = registryNamespaces.get(namespaceKey);
		if (!state) {
			state = { mailboxes: new Map(), waiters: new Map(), lastSent: new Map(), reservedSlots: new Map() };
			registryNamespaces.set(namespaceKey, state);
		}
		this.#state = state;
		this.#lifecycle = () => lifecycle ?? getAgentLifecycleManager(this.#registry);
	}

	/** Attach records-only persistence before this bus is exposed to Hub calls. */
	attachDurableStore(store: DurableHubStore): void {
		if (this.#durableStore && this.#durableStore.journalPath !== store.journalPath) {
			throw new Error("IRC bus already has a different durable store.");
		}
		this.#durableStore ??= store;
	}

	/** True only for refs belonging to this bus's exact root namespace. */
	#inScope(ref: { lineage?: { rootId: string } }): boolean {
		return this.#namespace === undefined || ref.lineage?.rootId === this.#namespace;
	}

	/** The namespace used by this bus, when it is root-scoped. */
	get namespace(): string | undefined {
		return this.#namespace;
	}
	#mailboxMutation(message: IrcMessage, state: "admitted" | "queued" | "delivered" | "consumed" | "abandoned") {
		return {
			kind: "mailbox" as const,
			entityId: message.id,
			incarnationId: message.id,
			payload: {
				state,
				message: {
					id: message.id,
					from: message.from,
					to: message.to,
					body: message.body,
					ts: message.ts,
					replyTo: message.replyTo,
					wakeRelay: message.wakeRelay,
				},
			},
		};
	}

	#persistMailbox(message: IrcMessage, state: "admitted" | "queued" | "delivered" | "consumed" | "abandoned"): void {
		this.#durableStore?.append("mailbox", message.id, message.id, this.#mailboxMutation(message, state).payload);
		if (message.replyTo) {
			this.#durableStore?.append("correlation", message.id, message.id, {
				state,
				replyTo: message.replyTo,
				from: message.from,
				to: message.to,
			});
		}
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		let reservations: IrcDeliveryReservation[];
		try {
			reservations = this.#reserveDeliveries([msg]);
		} catch (error) {
			if (error instanceof IrcDeliveryAdmissionError) return error.receipts[0]!;
			throw error;
		}
		const reservation = reservations[0]!;
		try {
			const receipt = await this.#deliver(reservation, opts);
			this.#recordSent(reservation.message, receipt);
			return receipt;
		} finally {
			this.#finishReservations(reservations, true);
		}
	}

	/** Atomically reserve every broadcast/direct leg before any delivery effect. */
	admitDeliveryBatch(
		transaction: HubAdmissionStateTransaction,
		messages: readonly Omit<IrcMessage, "id" | "ts">[],
	): IrcDeliveryBatch {
		let reservations: IrcDeliveryReservation[] = [];
		const batch = Object.freeze(Object.create(null)) as IrcDeliveryBatch;
		const record: IrcDeliveryBatchRecord = { transaction, reservations, stagedMutations: [], state: "held" };
		this.#deliveryBatches.set(batch as object, record);
		transaction.enlist({
			hold: () => {
				reservations = this.#reserveDeliveries(messages);
				record.reservations = reservations;
			},
			prepare: () => [...record.stagedMutations],
			apply: () => this.#finishDeliveryBatch(record, true),
			commit: () => this.#finishDeliveryBatch(record, true),
			rollback: () => this.#finishDeliveryBatch(record, false),
			abandon: () => this.#finishDeliveryBatch(record, true),
		});
		return batch;
	}

	/** Deliver a previously admitted batch; all legs were preflighted together. */
	async deliverBatch(
		transaction: HubAdmissionStateTransaction,
		batch: IrcDeliveryBatch,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt[]> {
		transaction.assertActive();
		const record = this.#deliveryBatches.get(batch as object);
		if (!record || record.transaction !== transaction || record.state !== "held") {
			throw new Error("Invalid or retired IRC delivery batch.");
		}
		transaction.markEffect();
		const receipts: IrcDeliveryReceipt[] = [];
		for (const reservation of record.reservations) {
			const receipt = await this.#deliver(reservation, opts, transaction);
			this.#recordSent(reservation.message, receipt, record);
			receipts.push(receipt);
		}
		return receipts;
	}

	#finishDeliveryBatch(record: IrcDeliveryBatchRecord, preserveBuffered: boolean): void {
		if (record.state === "finished") return;
		record.state = "finished";
		this.#finishReservations(record.reservations, preserveBuffered);
	}

	#recordSent(message: IrcMessage, receipt: IrcDeliveryReceipt, batch?: IrcDeliveryBatchRecord): void {
		if (receipt.outcome === "failed") {
			const buffered = this.#state.mailboxes.get(message.to)?.includes(message) === true;
			if (!buffered) {
				if (batch) batch.stagedMutations.push(this.#mailboxMutation(message, "abandoned"));
				else this.#persistMailbox(message, "abandoned");
			}
			return;
		}
		if (batch) batch.stagedMutations.push(this.#mailboxMutation(message, "delivered"));
		else this.#persistMailbox(message, "delivered");
		let sent = this.#state.lastSent.get(message.from);
		if (!sent) {
			sent = new Map();
			this.#state.lastSent.set(message.from, sent);
		}
		sent.set(message.to, message.ts);
	}

	#reserveDeliveries(messages: readonly Omit<IrcMessage, "id" | "ts">[]): IrcDeliveryReservation[] {
		const reservations: IrcDeliveryReservation[] = [];
		const requiredByRecipient = new Map<string, number>();
		const failures: IrcDeliveryReceipt[] = [];
		for (const raw of messages) {
			const message: IrcMessage = { ...raw, id: Snowflake.next(), ts: Date.now() };
			if (this.#namespace !== undefined) {
				const senderRef = lookupAgentRef(this.#registry, message.from);
				if (!senderRef || !this.#inScope(senderRef)) {
					failures.push({
						to: message.to,
						outcome: "failed",
						error: `Sender "${message.from}" is outside this hub root.`,
					});
					continue;
				}
			}
			const ref = lookupAgentRef(this.#registry, message.to);
			if (!ref || !this.#inScope(ref)) {
				failures.push({
					to: message.to,
					outcome: "failed",
					error: ref
						? `Agent "${message.to}" is outside this hub root.`
						: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
				});
				continue;
			}
			if (ref.status === "aborted") {
				failures.push({
					to: message.to,
					outcome: "failed",
					error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
				});
				continue;
			}
			if (ref.kind === "advisor") {
				failures.push({
					to: message.to,
					outcome: "failed",
					error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
				});
				continue;
			}
			reservations.push({ message, targetRef: ref, convertedToMailbox: false });
			requiredByRecipient.set(message.to, (requiredByRecipient.get(message.to) ?? 0) + 1);
		}
		if (failures.length > 0) throw new IrcDeliveryAdmissionError(failures);
		for (const [agentId, required] of requiredByRecipient) {
			const occupied = this.#state.mailboxes.get(agentId)?.length ?? 0;
			const reserved = this.#state.reservedSlots.get(agentId) ?? 0;
			if (occupied + reserved + required > MAILBOX_CAP) {
				throw new IrcDeliveryAdmissionError([
					{
						to: agentId,
						outcome: "failed",
						error: `Mailbox capacity reached for "${agentId}" (${MAILBOX_CAP} messages).`,
					},
				]);
			}
		}
		if (this.#durableStore) {
			for (const reservation of reservations) {
				if (!this.#durableStore.reserve("admission", `message:${reservation.message.id}`, reservation.message.id)) {
					throw new IrcDeliveryAdmissionError([
						{ to: reservation.message.to, outcome: "failed", error: "Message identity collision." },
					]);
				}
			}
		}
		for (const [agentId, required] of requiredByRecipient) {
			this.#state.reservedSlots.set(agentId, (this.#state.reservedSlots.get(agentId) ?? 0) + required);
		}
		return reservations;
	}

	#finishReservations(reservations: readonly IrcDeliveryReservation[], preserveBuffered: boolean): void {
		for (const reservation of reservations) {
			if (reservation.convertedToMailbox) {
				if (!preserveBuffered) this.#removeExactMailboxMessage(reservation.message);
				continue;
			}
			this.#releaseReservedSlot(reservation.message.to);
		}
	}

	#releaseReservedSlot(agentId: string): void {
		const reserved = this.#state.reservedSlots.get(agentId) ?? 0;
		if (reserved <= 1) this.#state.reservedSlots.delete(agentId);
		else this.#state.reservedSlots.set(agentId, reserved - 1);
	}

	#removeExactMailboxMessage(message: IrcMessage): void {
		const mailbox = this.#state.mailboxes.get(message.to);
		if (!mailbox) return;
		const index = mailbox.indexOf(message);
		if (index !== -1) mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#state.mailboxes.delete(message.to);
	}

	/**
	 * Whether `from` successfully sent `to` anything at or after `sinceTs`.
	 * The wake-turn relay uses it to skip agents that already answered their
	 * waker themselves.
	 */
	sentSince(from: string, to: string, sinceTs: number): boolean {
		const ts = this.#state.lastSent.get(from)?.get(to);
		return ts !== undefined && ts >= sinceTs;
	}

	async #deliver(
		reservation: IrcDeliveryReservation,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
		transaction?: HubAdmissionStateTransaction,
	): Promise<IrcDeliveryReceipt> {
		const { message } = reservation;
		if (this.#namespace !== undefined) {
			const senderRef = lookupAgentRef(this.#registry, message.from);
			if (!senderRef || !this.#inScope(senderRef)) {
				return { to: message.to, outcome: "failed", error: `Sender "${message.from}" is outside this hub root.` };
			}
		}
		const ref = lookupAgentRef(this.#registry, message.to);
		if (ref !== reservation.targetRef) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" was replaced before delivery.` };
		}
		if (!ref || !this.#inScope(ref)) {
			return {
				to: message.to,
				outcome: "failed",
				error: ref
					? `Agent "${message.to}" is outside this hub root.`
					: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			waiter.resolve(message);
			return { to: message.to, outcome: "injected" };
		}

		// A `parked` recipient always needs the lifecycle to revive it — this is
		// read from *this* bus's registry, so it holds for any registry. The
		// mid-park / adopted checks below query the lifecycle's own state, which
		// only describes the registry it manages: consult them only when the
		// lifecycle owns this bus's registry, otherwise a custom-registry bus
		// (fallen back to the global manager) would gate a live recipient on
		// unrelated global park state. Main/non-adopted live peers skip the gate,
		// and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycleManagesRegistry(lifecycle, this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (isAgentParking(lifecycle, message.to) || lifecycleHasAgent(lifecycle, message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await ensureAgentLive(lifecycle, message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
		const session = lookupAgentRef(this.#registry, message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): convert
			this.#enqueueReserved(reservation, transaction);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: {
			drainPending?: boolean;
			liveness?: { registry: AgentRegistry; senderId: string };
			awaitTarget?: { registry: AgentRegistry; target: string };
			transaction?: HubAdmissionStateTransaction;
		},
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.take(agentId, filter.from, options?.transaction);
			if (pending) return pending;
		}
		const waiterId = crypto.randomUUID();
		const waitEntityId = `${agentId}:${waiterId}`;
		const waitPayload = {
			agentId,
			from: filter.from,
			mode: options?.awaitTarget ? "await-target" : options?.liveness ? "liveness" : "mailbox",
			windowMs: Math.max(0, timeoutMs),
			deadlineAt: timeoutMs > 0 ? Date.now() + timeoutMs : null,
		};
		if (options?.transaction) {
			options.transaction.recordWait(waiterId, { state: "waiting", ...waitPayload });
		} else if (this.#durableStore) {
			if (!this.#durableStore.reserve("wait", waitEntityId, waiterId))
				throw new Error("IRC waiter identity collision.");
			this.#durableStore.append("wait", waitEntityId, waiterId, { state: "waiting", ...waitPayload });
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;
		let unsubscribeAwaitTarget: (() => void) | undefined;
		let observedMessage: IrcMessage | undefined;
		let waiterObservationFinished = false;
		let waiterSlotReserved = false;
		let durableOutcome:
			| { outcome: "message"; messageId: string }
			| { outcome: "expired" }
			| { outcome: "cancelled" }
			| undefined;
		const persistWaitOutcome = (state: "committed" | "abandoned"): void => {
			const payload = { state, ...(durableOutcome ?? { outcome: "ambiguous" }) };
			if (options?.transaction) {
				options.transaction.recordWait(waiterId, payload);
			} else if (this.#durableStore) {
				this.#durableStore.append("wait", waitEntityId, waiterId, payload);
			}
		};

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			durableOutcome =
				outcome.kind === "message"
					? { outcome: "message", messageId: outcome.msg.id }
					: outcome.kind === "timeout"
						? { outcome: "expired" }
						: { outcome: "cancelled" };
			if (!options?.transaction) persistWaitOutcome("committed");
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
			unsubscribeAwaitTarget?.();
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => {
				observedMessage = msg;
				settle({ kind: "message", msg });
			},
			cancel: () => cleanup(),
		};
		if (options?.transaction) {
			options.transaction.enlist({
				prepare: () => {
					if (!waiterObservationFinished) persistWaitOutcome("committed");
					return [];
				},
				hold: () => {
					this.#reserveMailboxSlots(agentId, 1);
					waiterSlotReserved = true;
				},
				apply: () => {
					if (waiterObservationFinished) return;
					waiterObservationFinished = true;
					cleanup();
					if (waiterSlotReserved) this.#releaseReservedSlot(agentId);
				},
				commit: () => {
					if (waiterObservationFinished) return;
					waiterObservationFinished = true;
					cleanup();
					if (waiterSlotReserved) this.#releaseReservedSlot(agentId);
				},
				rollback: () => {
					if (waiterObservationFinished) return;
					waiterObservationFinished = true;
					cleanup();
					if (observedMessage) this.#restoreMailboxMessages(agentId, [observedMessage]);
					if (waiterSlotReserved) this.#releaseReservedSlot(agentId);
					persistWaitOutcome("abandoned");
				},
				abandon: () => {
					if (waiterObservationFinished) return;
					waiterObservationFinished = true;
					cleanup();
					if (observedMessage) this.#restoreMailboxMessages(agentId, [observedMessage]);
					if (waiterSlotReserved) this.#releaseReservedSlot(agentId);
					persistWaitOutcome("abandoned");
				},
			});
		}

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#state.waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#state.waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasRunningSender = (from?: string): boolean =>
				registry
					.listVisibleTo(senderId)
					.some(ref => this.#inScope(ref) && registry.isRunning(ref) && (!from || ref.id === from));
			const check = filter.from ? () => hasRunningSender(filter.from) : () => hasRunningSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		// `send await:true`: settle the sender promptly once the awaited peer
		// reaches a terminal stop without replying, instead of stranding it on
		// the full timeout. Unlike `liveness`, this tolerates a peer that is
		// idle/parked when the send lands (the send is about to wake or revive
		// it): it only aborts once the peer has actually been observed running
		// and then stopped, or is unambiguously gone (unregistered / aborted).
		// A real reply resolves the waiter first (the recipient sends it mid-turn,
		// before the turn-end idle transition), so cleanup tears this down.
		const awaitTarget = options?.awaitTarget;
		if (awaitTarget) {
			const { registry, target } = awaitTarget;
			let subscribedSession: AgentSession | null = null;
			let unsubscribeSession: (() => void) | undefined;
			let active = true;
			// The peer's terminal `agent_end` is the authoritative "stopped" signal.
			// It is emitted only after the peer's prompt fully unwinds (see
			// AgentSession#flushPendingAgentEnd) and supersedes scheduled
			// continuations. A side-channel auto-reply may outlive that main turn,
			// though, so wait for it before declaring the peer stopped: its bus send
			// resolves this waiter first; an empty/failed reply then falls through to
			// the clean stopped result.
			const onSessionEvent = (event: AgentSessionEvent): void => {
				if (event.type !== "agent_end" || event.isTerminal === false) return;
				const session = subscribedSession;
				if (!session) {
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
					return;
				}
				void session.waitForIrcReplies().then(() => {
					if (!active || lookupAgentRef(registry, target)?.session !== session) return;
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
				});
			};
			const sync = (): void => {
				const ref = lookupAgentRef(registry, target);
				// Gone or hard-aborted: no reply will ever come.
				if (!ref || ref.status === "aborted") {
					settle({ kind: "abort", error: new IrcAwaitTargetStopped(target) });
					return;
				}
				// Follow the live session across a park→revive rebuild; tolerate a
				// parked peer with no session yet (the send is about to revive it).
				const session = ref.session;
				if (session && session !== subscribedSession) {
					unsubscribeSession?.();
					subscribedSession = session;
					unsubscribeSession = session.subscribe(onSessionEvent);
				}
			};
			const unsubscribeChange = onInternalRegistryChange(registry, sync);
			unsubscribeAwaitTarget = () => {
				active = false;
				unsubscribeChange();
				unsubscribeSession?.();
			};
			sync();
		}

		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`, transactionally when admitted. */
	inbox(agentId: string, opts?: { peek?: boolean }, transaction?: HubAdmissionStateTransaction): IrcMessage[] {
		if (!transaction) {
			const mailbox = this.#state.mailboxes.get(agentId);
			if (!mailbox || mailbox.length === 0) return [];
			if (opts?.peek) return [...mailbox];
			this.#state.mailboxes.delete(agentId);
			for (const message of mailbox) this.#persistMailbox(message, "consumed");
			return mailbox;
		}
		let messages: IrcMessage[] = [];
		let reserved = 0;
		transaction.enlist({
			hold: () => {
				const mailbox = this.#state.mailboxes.get(agentId);
				if (!mailbox || mailbox.length === 0) return;
				messages = [...mailbox];
				if (opts?.peek) return;
				reserved = messages.length;
				this.#reserveMailboxSlots(agentId, reserved, true);
				this.#state.mailboxes.delete(agentId);
			},
			prepare: () => (!opts?.peek ? messages.map(message => this.#mailboxMutation(message, "consumed")) : []),
			apply: () => {
				this.#releaseReservedSlots(agentId, reserved);
			},
			commit: () => {
				this.#releaseReservedSlots(agentId, reserved);
			},
			rollback: () => {
				if (!opts?.peek && messages.length > 0) this.#restoreMailboxMessages(agentId, messages);
				this.#releaseReservedSlots(agentId, reserved);
			},
			abandon: () => {
				if (!opts?.peek && messages.length > 0) this.#restoreMailboxMessages(agentId, messages);
				this.#releaseReservedSlots(agentId, reserved);
			},
		});
		return messages;
	}

	/** Consume the oldest matching message, transactionally when admitted. */
	take(agentId: string, from?: string, transaction?: HubAdmissionStateTransaction): IrcMessage | undefined {
		if (!transaction) {
			const direct = this.#takeFromMailbox(agentId, from);
			if (direct) this.#persistMailbox(direct, "consumed");
			return direct;
		}
		let message: IrcMessage | undefined;
		let originalIndex = -1;
		transaction.enlist({
			hold: () => {
				const mailbox = this.#state.mailboxes.get(agentId);
				if (!mailbox || mailbox.length === 0) return;
				originalIndex = from ? mailbox.findIndex(candidate => candidate.from === from) : 0;
				if (originalIndex === -1) return;
				this.#reserveMailboxSlots(agentId, 1, true);
				[message] = mailbox.splice(originalIndex, 1);
				if (mailbox.length === 0) this.#state.mailboxes.delete(agentId);
			},
			prepare: () => (message ? [this.#mailboxMutation(message, "consumed")] : []),
			apply: () => {
				if (message) this.#releaseReservedSlot(agentId);
			},
			commit: () => {
				if (message) this.#releaseReservedSlot(agentId);
			},
			rollback: () => {
				if (message) this.#restoreMailboxMessages(agentId, [message], originalIndex);
				if (message) this.#releaseReservedSlot(agentId);
			},
			abandon: () => {
				if (message) this.#restoreMailboxMessages(agentId, [message], originalIndex);
				if (message) this.#releaseReservedSlot(agentId);
			},
		});
		return message;
	}

	/** Restore committed mailbox custody in batches without recreating wait capabilities. */
	recoverDurableState(cursor = 0, limit = 100, now = Date.now()): IrcRecoveryBatch {
		if (!this.#durableStore) {
			return { processed: 0, restoredMessageIds: [], expiredWaiterIds: [], quarantinedIds: [] };
		}
		const batch = this.#durableStore.recover(cursor, limit);
		this.#durableRecovery ??= { messages: new Map(), waits: new Map(), quarantined: new Set() };
		const recovery = this.#durableRecovery;
		for (const invalid of batch.quarantined) recovery.quarantined.add(`journal:${invalid.cursor}`);
		for (const record of batch.records) {
			if (record.kind === "mailbox") {
				const prior = recovery.messages.get(record.entityId);
				if (prior && prior.incarnationId !== record.incarnationId) {
					recovery.messages.delete(record.entityId);
					recovery.quarantined.add(record.entityId);
				} else if (!recovery.quarantined.has(record.entityId)) {
					recovery.messages.set(record.entityId, record);
				}
			} else if (record.kind === "wait") {
				const prior = recovery.waits.get(record.entityId);
				if (prior && prior.incarnationId !== record.incarnationId) recovery.quarantined.add(record.entityId);
				else recovery.waits.set(record.entityId, record);
			}
		}
		if (batch.nextCursor !== undefined) {
			return {
				processed: batch.records.length + batch.quarantined.length,
				restoredMessageIds: [],
				expiredWaiterIds: [],
				quarantinedIds: [...recovery.quarantined],
				nextCursor: batch.nextCursor,
			};
		}
		const restoredMessageIds: string[] = [];
		for (const [id, record] of recovery.messages) {
			if (recovery.quarantined.has(id)) continue;
			const state = record.payload.state;
			if (state === "admitted") {
				recovery.quarantined.add(id);
				continue;
			}
			if (state !== "queued") continue;
			const raw = record.payload.message;
			if (!raw || typeof raw !== "object") {
				recovery.quarantined.add(id);
				continue;
			}
			const message = raw as Partial<IrcMessage>;
			if (
				message.id !== id ||
				record.incarnationId !== id ||
				typeof message.from !== "string" ||
				typeof message.to !== "string" ||
				typeof message.body !== "string" ||
				typeof message.ts !== "number"
			) {
				recovery.quarantined.add(id);
				continue;
			}
			const mailbox = this.#state.mailboxes.get(message.to) ?? [];
			if (!mailbox.some(candidate => candidate.id === id)) {
				mailbox.push(message as IrcMessage);
				mailbox.sort((left, right) => left.ts - right.ts);
				this.#state.mailboxes.set(message.to, mailbox);
				restoredMessageIds.push(id);
			}
		}
		const expiredWaiterIds: string[] = [];
		for (const [id, record] of recovery.waits) {
			if (recovery.quarantined.has(id) || record.payload.state !== "waiting") continue;
			const deadlineAt = record.payload.deadlineAt;
			if (typeof deadlineAt === "number" && deadlineAt <= now) {
				expiredWaiterIds.push(id);
				this.#durableStore.append("wait", record.entityId, record.incarnationId, {
					...record.payload,
					state: "committed",
					settled: "expired",
				});
			} else {
				recovery.quarantined.add(id);
				this.#durableStore.append("wait", record.entityId, record.incarnationId, {
					...record.payload,
					state: "quarantined",
				});
			}
		}
		this.#durableRecovery = undefined;
		return {
			processed: batch.records.length + batch.quarantined.length,
			restoredMessageIds,
			expiredWaiterIds,
			quarantinedIds: [...recovery.quarantined],
		};
	}

	unreadCount(agentId: string): number {
		return this.#state.mailboxes.get(agentId)?.length ?? 0;
	}

	#reserveMailboxSlots(agentId: string, count: number, replacingOccupied = false): void {
		if (count <= 0) return;
		const occupied = this.#state.mailboxes.get(agentId)?.length ?? 0;
		const reserved = this.#state.reservedSlots.get(agentId) ?? 0;
		if (!replacingOccupied && occupied + reserved + count > MAILBOX_CAP) {
			throw new IrcDeliveryAdmissionError([
				{
					to: agentId,
					outcome: "failed",
					error: `Mailbox capacity reached for "${agentId}" (${MAILBOX_CAP} messages).`,
				},
			]);
		}
		this.#state.reservedSlots.set(agentId, reserved + count);
	}

	#releaseReservedSlots(agentId: string, count: number): void {
		if (count <= 0) return;
		const reserved = this.#state.reservedSlots.get(agentId) ?? 0;
		const remaining = Math.max(0, reserved - count);
		if (remaining === 0) this.#state.reservedSlots.delete(agentId);
		else this.#state.reservedSlots.set(agentId, remaining);
	}

	#restoreMailboxMessages(agentId: string, messages: readonly IrcMessage[], index = 0): void {
		if (messages.length === 0) return;
		let mailbox = this.#state.mailboxes.get(agentId);
		if (!mailbox) {
			mailbox = [];
			this.#state.mailboxes.set(agentId, mailbox);
		}
		mailbox.splice(Math.min(Math.max(index, 0), mailbox.length), 0, ...messages);
	}

	#enqueueReserved(reservation: IrcDeliveryReservation, transaction?: HubAdmissionStateTransaction): void {
		if (reservation.convertedToMailbox) return;
		const { message } = reservation;
		let mailbox = this.#state.mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#state.mailboxes.set(message.to, mailbox);
		}
		if (transaction) transaction.stageDurable(this.#mailboxMutation(message, "queued"));
		else this.#persistMailbox(message, "queued");
		mailbox.push(message);
		reservation.convertedToMailbox = true;
		this.#releaseReservedSlot(message.to);
	}

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#state.waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#state.waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#state.waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#state.waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#state.mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#state.mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (message.to === MAIN_AGENT_ID || message.from === MAIN_AGENT_ID) return;
		const mainSession = lookupAgentRef(this.#registry, MAIN_AGENT_ID)?.session;
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
