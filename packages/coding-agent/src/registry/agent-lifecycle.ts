/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`. An ordinary detached `aborted` agent may be reopened from
 * its transcript; explicit tombstones remain terminal hard kills.
 *
 * Park/dispose is gated against concurrent ensureLive/peer sends:
 * - A disposing session is never handed out.
 * - ensureLive during an in-flight park either cancels the park (session still
 *   live) or waits for detach+park and then revives.
 * - Concurrent ensureLive/park operations coalesce per id.
 *
 * Every adoption, park, and revival is bound to the exact {@link AgentRef} it
 * started from, so stale async work (a late finalizer, a cancelled initializer,
 * a superseded revive) can never clobber a newer same-id ref.
 */

import * as fs from "node:fs/promises";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { assertAgentLifecycleCapability, getAgentLifecycleCapability } from "../internal/agent-lifecycle-capability";
import {
	abortAgentRef,
	attachAgentSession,
	endAgentTermination,
	lookupAgentRef,
	onInternalRegistryChange,
	observeAgentRef,
	parkAgentRef,
	removeAgentRef,
	replaceInternalAgentIfAvailable,
	resolveAgentObservation,
	setAgentHistory,
	setAgentStatus,
	type InternalAgentRef,
	type InternalRegistryEvent,
} from "../internal/agent-registry-bridge";
import type { AgentSession } from "../session/agent-session";
import { trackLateCleanup } from "../utils/late-cleanup";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./agent-registry";
import { getAgentTombstonePath } from "./agent-tombstone";

const lifecycleCapability = getAgentLifecycleCapability();
export type AgentReviver = (expected: AgentRef) => Promise<AgentSession>;

const AGENT_RELEASE_GRACE_MS = 5000;

async function persistAgentTombstone(sessionFile: string): Promise<boolean> {
	try {
		await fs.writeFile(getAgentTombstonePath(sessionFile), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}
async function hasAgentTombstone(sessionFile: string): Promise<boolean> {
	try {
		await fs.access(getAgentTombstonePath(sessionFile));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
	onRelease?: () => void | Promise<void>;
}
export interface AgentLifecycleReplacementDrain {
	readonly failures: readonly unknown[];
	resume(): void;
}

interface AdoptedAgent {
	ref: InternalAgentRef;
	idleTtlMs: number;
	revive?: AgentReviver;
	onRelease?: () => void | Promise<void>;
	timer?: NodeJS.Timeout;
}

interface ParkInFlight {
	/** The exact ref this park was started for. */
	ref: InternalAgentRef;
	/** Resolves when the park attempt finishes (success, cancel, or dispose error). */
	promise: Promise<void>;
	/** Cancel before the session is detached. Returns true if cancel took effect. */
	cancel: () => boolean;
	/** True once cancel() succeeded (ensureLive kept the live session). */
	cancelled: boolean;
	/** True once the live session has been detached and status is parked. */
	detached: boolean;
}

interface RevivingAgent {
	ref: InternalAgentRef;
	promise: Promise<AgentSession>;
}

function matchesExpected(
	registry: AgentRegistry,
	ref: InternalAgentRef,
	expected: AgentRef | AgentSession | undefined,
): boolean {
	if (expected === undefined) return true;
	if (expected === ref || ref.session === expected) return true;
	return "id" in expected && resolveAgentObservation(registry, expected) === ref;
}

interface ReopeningAgent {
	/** The killed ref being reopened. */
	ref: InternalAgentRef;
	/** Resolves to the fresh `parked` generation. */
	promise: Promise<InternalAgentRef>;
}

class AgentLifecycleCleanupError extends AggregateError {}
class LifecycleDisposedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LifecycleDisposedError";
	}
}
export class AgentLifecycleManager {
	static global(): never {
		throw new Error("AgentLifecycleManager.global() is not a public authority surface.");
	}

	/** Test callers must use the non-exported lifecycle bridge. */
	static resetGlobalForTests(): void {}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts, each bound to the ref it started from. A park is
	 * cancelable until the live session is detached; after detach, ensureLive
	 * waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
	readonly #releases = new Set<Promise<boolean>>();
	#releaseClosed = false;
	/** In-flight revives, bound to the parked ref that initiated them, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	readonly #persistedObservations = new Map<string, { ref: InternalAgentRef; observation: AgentRef }>();
	/** In-flight reopens of killed refs, bound to the killed ref, so concurrent {@link ensureLive} calls coalesce. */
	readonly #reopens = new Map<string, ReopeningAgent>();
	readonly #activeEnsureOperations = new Set<Promise<AgentSession>>();
	#replacementRevivalFence = false;
	readonly #hardKilledRefs = new WeakSet<InternalAgentRef>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** Resolves the TTL applied when a cold-revived ref is adopted on demand (read per revive). */
	#persistedReviveTtlMs: () => number = () => 0;
	/** Set once {@link dispose} runs; blocks late revivals from adopting into a torn-down manager. */
	#disposed = false;
	#disposal: Promise<void> | undefined;

	constructor(registry: AgentRegistry = AgentRegistry.global(), capability?: unknown) {
		assertAgentLifecycleCapability(capability);
		this.#registry = registry;
		this.#unsubscribe = onInternalRegistryChange(registry, event => this.#onRegistryEvent(event));
	}

	resetForTests(capability?: unknown): void {
		assertAgentLifecycleCapability(capability);
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const adopted of this.#adopted.values()) clearTimeout(adopted.timer);
		this.#adopted.clear();
		this.#revivals.clear();
		this.#persistedObservations.clear();
		this.#reopens.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
		this.#activeEnsureOperations.clear();
		this.#replacementRevivalFence = false;
		this.#disposed = false;
		this.#releaseClosed = false;
		this.#disposal = undefined;
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time. The TTL may
	 * be a fixed value from the internal bridge or a provider resolved per revive.
	 */
	setPersistedSubagentReviverFactory(
		factory: PersistedSubagentReviverFactory,
		idleTtlMs: number | (() => number),
		_capability?: unknown,
	): void {
		if (this.#disposed) return;
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = typeof idleTtlMs === "function" ? idleTtlMs : () => idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * When `expected` is given, the adoption is refused if the id no longer
	 * resolves to that ref (or that ref's session).
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRef | AgentSession, _capability?: unknown): void {
		if (this.#disposed) return;
		if (id === MAIN_AGENT_ID) return;
		const ref = lookupAgentRef(this.#registry, id);
		if (!ref || !matchesExpected(this.#registry, ref, expected)) {
			logger.warn("AgentLifecycleManager.adopt: unknown or replaced agent id", { id });
			return;
		}

		// A parked ref restored from disk has no live session authority. It may
		// enter lifecycle management only when this adoption explicitly supplies
		// the reviver that can recreate that session. Active refs retain their
		// attached-session authority requirement.
		if (!ref.session && (ref.status !== "parked" || !opts.revive)) {
			logger.warn("AgentLifecycleManager.adopt: agent has no live session authority", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = {
			ref,
			idleTtlMs: opts.idleTtlMs,
			revive: opts.revive,
			onRelease: opts.onRelease,
		};
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live) — and, when `expected` is given, still bound to that ref. */
	has(id: string, expected?: AgentRef | AgentSession, _capability?: unknown): boolean {
		const adopted = this.#adopted.get(id);
		return Boolean(adopted && matchesExpected(this.#registry, adopted.ref, expected));
	}
	/**
	 * Reclaim a provably-dead parked corpse so a fresh spawn can reuse its id.
	 * Refuses live, adopted, in-flight, or cold-revivable refs. For a parked ref
	 * restored from disk, the persisted factory is consulted before removal
	 * because cold revivers are created lazily by {@link ensureLive}.
	 *
	 * Only refs in the registry this manager owns are touched; the transcript
	 * stays readable at `history://<id>`. Returns true when the corpse was
	 * unregistered.
	 */
	async reclaimDeadCorpse(id: string, expected: AgentRef, _capability?: unknown): Promise<boolean> {
		const ref = lookupAgentRef(this.#registry, id);
		if (
			!ref ||
			(ref !== expected && resolveAgentObservation(this.#registry, expected) !== ref) ||
			ref.status !== "parked" ||
			ref.session
		)
			return false;
		if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;

		const persistedFactory = ref.sessionFile ? this.#persistedReviverFactory : undefined;
		if (persistedFactory) {
			try {
				const revive = await persistedFactory(expected);
				if (revive) {
					if (
						!this.#disposed &&
						lookupAgentRef(this.#registry, id) === ref &&
						ref.status === "parked" &&
						!ref.session &&
						!this.#adopted.has(id) &&
						!this.#parks.has(id) &&
						!this.#revivals.has(id)
					) {
						this.#persistedObservations.set(id, { ref, observation: expected });
					}
					return false;
				}
			} catch (error) {
				logger.warn("AgentLifecycleManager.reclaimDeadCorpse: persisted reviver probe failed", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			if (lookupAgentRef(this.#registry, id) !== ref || ref.status !== "parked" || ref.session) return false;
			if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;
		}
		return await removeAgentRef(this.#registry, ref);
	}

	/**
	 * True when this manager owns `registry` — i.e. its adopt/park/revive state
	 * describes that registry's refs. Lets a caller holding a specific registry
	 * (e.g. a custom-registry {@link IrcBus} that fell back to the global
	 * manager) skip lifecycle gating that would consult unrelated park state.
	 */
	manages(registry: AgentRegistry, _capability?: unknown): boolean {
		return this.#registry === registry;
	}
	/**
	 * True while {@link park} is disposing this agent's session (lets dispose
	 * hooks distinguish park from teardown). False once the park is cancelled
	 * by ensureLive or after detach+dispose completes. When `expected` is
	 * given, only a park bound to that ref (or its session) counts.
	 */
	isParking(id: string, expected?: AgentRef | AgentSession, _capability?: unknown): boolean {
		const park = this.#parks.get(id);
		return Boolean(park && !park.cancelled && matchesExpected(this.#registry, park.ref, expected));
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 *
	 * The session is detached (and status flipped to `parked`) *before*
	 * `session.dispose()` so concurrent {@link ensureLive}/peer sends never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(
		id: string,
		_capability?: unknown,
		dispose?: () => Promise<void>,
		beforeDispose?: () => Promise<void>,
	): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;

		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = lookupAgentRef(this.#registry, id);
		if (!ref || adopted.ref !== ref) return;
		const session = ref.session;
		if (!session) return;

		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		let committing = false;
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Durable park commit is the ownership boundary: before it, keep the
				// attached session; after it, finish detach and revive on demand.
				if (park.detached || committing || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				// Yield so a same-tick ensureLive/hub-send can cancel before we
				// commit to dispose. Deterministic with Promise microtasks; no timers.
				await Promise.resolve();
				if (cancelled) return;

				// Re-check liveness: release/unregister/replace may have raced us.
				const live = lookupAgentRef(this.#registry, id);
				if (live !== ref || !live.session || live.session !== session) return;
				if (this.#adopted.get(id)?.ref !== ref) return;

				// Preserve cost before detaching the only live source. The session usage
				// index includes off-transcript model calls; remove completed task-result
				// billing so child rows remain the sole owners of nested spend.
				try {
					const usage = session.sessionManager.getUsageStatistics();
					const directCost = usage.cost - usage.subagentCost;
					if (Number.isFinite(directCost) && directCost >= 0) {
						if (!setAgentHistory(this.#registry, session, { directCost })) return;
					}
				} catch (error) {
					logger.debug("AgentLifecycleManager.park: cost snapshot failed", { id, error: String(error) });
				}

				// Registry owns the exact session through descendant settlement, durable park, and disposal.
				committing = true;
				if (
					!(await parkAgentRef(this.#registry, ref, session, dispose ?? (() => session.dispose()), beforeDispose))
				)
					return;
				park.detached = true;
			} finally {
				// Only clear if we are still the in-flight entry (a later park would
				// have replaced us only after we resolved).
				if (this.#parks.get(id) === park) this.#parks.delete(id);
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked or
	 * killed. Throws a plain Error if the id is unknown, or its transcript
	 * cannot be revived (no reviver, no session contract, workspace gone).
	 * Concurrent calls share one in-flight revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 */
	async ensureLive(id: string, _capability?: unknown): Promise<AgentSession> {
		if (this.#disposed) throw new LifecycleDisposedError("Agent lifecycle is being disposed.");
		if (this.#replacementRevivalFence)
			throw new LifecycleDisposedError("Agent revival is paused while its root authority is being replaced.");
		const operation = this.#ensureLive(id);
		this.#activeEnsureOperations.add(operation);
		try {
			return await operation;
		} finally {
			this.#activeEnsureOperations.delete(operation);
		}
	}

	async #ensureLive(id: string): Promise<AgentSession> {
		const park = this.#parks.get(id);
		if (park) {
			const parked = lookupAgentRef(this.#registry, id);
			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				if (this.#disposed) throw new LifecycleDisposedError(`Agent "${id}" lifecycle is being disposed.`);
				if (lookupAgentRef(this.#registry, id) !== parked)
					throw new Error(`Agent "${id}" changed while its park was being cancelled.`);
				const kept = parked.session;
				if (kept) {
					const adopted = this.#adopted.get(id);
					if (adopted?.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
					return kept;
				}
			} else {
				await park.promise;
				if (this.#disposed) throw new LifecycleDisposedError(`Agent "${id}" lifecycle is being disposed.`);
				if (lookupAgentRef(this.#registry, id) !== park.ref)
					throw new Error(`Agent "${id}" changed while its park was completing.`);
				const current = lookupAgentRef(this.#registry, id);
				const adopted = this.#adopted.get(id);
				if (current?.session && adopted?.ref === current && current.status === "idle") this.#armTimer(id, adopted);
			}
		}

		let ref = lookupAgentRef(this.#registry, id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (ref.status === "aborted") {
			const killed = ref;
			ref = await this.#reopen(id, killed);
			if (this.#disposed) throw new LifecycleDisposedError(`Agent "${id}" lifecycle is being disposed.`);
			if (lookupAgentRef(this.#registry, id) !== ref || ref.status !== "parked" || ref.session !== null)
				throw new Error(`Agent "${id}" changed while it was being reopened.`);
		}
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return inflight.promise;
		if (ref.session) {
			if (ref.session.isDisposed)
				throw new Error(`Agent "${id}" session is disposed; its failed cleanup must settle before revival.`);
			return ref.session;
		}
		const revival = this.#resolveAndRevive(id, ref);
		const pending: RevivingAgent = { ref, promise: revival };
		this.#revivals.set(id, pending);
		try {
			return await revival;
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	/** Reopens only ordinary aborted refs; explicit tombstones remain terminal hard kills. */
	async #reopen(id: string, killed: InternalAgentRef): Promise<InternalAgentRef> {
		const inflight = this.#reopens.get(id);
		if (inflight?.ref === killed) return inflight.promise;
		const pending: ReopeningAgent = { ref: killed, promise: this.#reopenKilled(id, killed) };
		this.#reopens.set(id, pending);
		try {
			return await pending.promise;
		} finally {
			if (this.#reopens.get(id) === pending) this.#reopens.delete(id);
		}
	}

	async #reopenKilled(id: string, killed: InternalAgentRef): Promise<InternalAgentRef> {
		const sessionFile = killed.sessionFile;
		const lineage = killed.lineage;
		const parentId = killed.parentId;
		if (!sessionFile) throw new Error(`Agent "${id}" was killed and has no transcript to resume from.`);
		if (this.#disposed) throw new LifecycleDisposedError(`Agent "${id}" lifecycle is being disposed.`);
		if (this.#hardKilledRefs.has(killed))
			throw new Error(`Agent "${id}" was hard-killed and cannot be revived. Read history://${id} for what it did.`);
		const hasInitialTombstone = await hasAgentTombstone(sessionFile);
		if (this.#disposed)
			throw new LifecycleDisposedError(`Agent "${id}" lifecycle was disposed during tombstone validation.`);
		if (
			lookupAgentRef(this.#registry, id) !== killed ||
			killed.status !== "aborted" ||
			killed.session !== null ||
			killed.sessionFile !== sessionFile ||
			killed.lineage !== lineage ||
			killed.parentId !== parentId
		)
			throw new Error(`Agent "${id}" changed while its transcript was being checked.`);
		if (hasInitialTombstone)
			throw new Error(`Agent "${id}" was hard-killed and cannot be revived. Read history://${id} for what it did.`);
		const factory = this.#persistedReviverFactory;
		if (!factory) {
			throw new Error(
				`Agent "${id}" was killed and cannot be revived (no reviver registered). Read history://${id} for what it did.`,
			);
		}
		const reviver = await factory(observeAgentRef(this.#registry, killed));
		if (this.#disposed)
			throw new LifecycleDisposedError(`Agent "${id}" lifecycle was disposed while its transcript was checked.`);
		if (
			lookupAgentRef(this.#registry, id) !== killed ||
			killed.status !== "aborted" ||
			killed.session !== null ||
			killed.sessionFile !== sessionFile ||
			killed.lineage !== lineage ||
			killed.parentId !== parentId
		)
			throw new Error(`Agent "${id}" changed while its transcript was being checked.`);
		if (!reviver) {
			throw new Error(
				`Agent "${id}" was killed and cannot be revived (no session contract, isolated run, or its workspace is gone). Read history://${id} for what it did.`,
			);
		}
		if (this.#hardKilledRefs.has(killed))
			throw new Error(`Agent "${id}" was hard-killed and cannot be revived. Read history://${id} for what it did.`);
		const hasLatestTombstone = await hasAgentTombstone(sessionFile);
		if (this.#disposed)
			throw new LifecycleDisposedError(`Agent "${id}" lifecycle was disposed during final tombstone validation.`);
		if (hasLatestTombstone)
			throw new Error(`Agent "${id}" was hard-killed and cannot be revived. Read history://${id} for what it did.`);
		if (
			lookupAgentRef(this.#registry, id) !== killed ||
			killed.status !== "aborted" ||
			killed.session !== null ||
			killed.sessionFile !== sessionFile ||
			killed.lineage !== lineage ||
			killed.parentId !== parentId
		)
			throw new Error(`Agent "${id}" changed while its transcript was being checked.`);
		const reopened = replaceInternalAgentIfAvailable(
			this.#registry,
			{
				id,
				displayName: killed.displayName,
				kind: killed.kind,
				parentId: killed.parentId,
				session: null,
				sessionFile,
				status: "parked",
				createdAt: killed.createdAt,
				history: killed.history,
			},
			killed,
		);
		if (!reopened) throw new Error(`Agent "${id}" changed while its transcript was being checked.`);
		return reopened;
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: InternalAgentRef): Promise<AgentSession> {
		const expectedSessionFile = ref.sessionFile;
		const expectedLineage = ref.lineage;
		const expectedParentId = ref.parentId;
		const stillParked = () =>
			lookupAgentRef(this.#registry, id) === ref &&
			ref.status === "parked" &&
			ref.session === null &&
			ref.sessionFile === expectedSessionFile &&
			ref.lineage === expectedLineage &&
			ref.parentId === expectedParentId;
		let adoption = this.#adopted.get(id);
		let revive = adoption?.ref === ref ? adoption.revive : undefined;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			const retained = this.#persistedObservations.get(id);
			let observation: AgentRef;
			if (retained?.ref === ref) {
				observation = retained.observation;
			} else {
				if (retained) this.#persistedObservations.delete(id);
				observation = observeAgentRef(this.#registry, ref);
			}
			revive = await this.#persistedReviverFactory(observation);
			if (this.#disposed)
				throw new LifecycleDisposedError(
					`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was being prepared.`,
				);
			if (!stillParked()) throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
			if (revive) {
				adoption = { ref, idleTtlMs: this.#persistedReviveTtlMs(), revive };
				this.#adopted.set(id, adoption);
				coldAdopted = true;
			}
		}
		if (!stillParked()) throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
		if (!revive || !adoption) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		try {
			return await this.#revive(id, revive, ref, adoption);
		} catch (error) {
			if (coldAdopted && this.#adopted.get(id) === adoption) this.#adopted.delete(id);
			throw error;
		}
	}

	/**
	 * Dispose if live and drop timers. When `expected` is given, only a ref
	 * matching it is released; a stale release can never take down a newer
	 * same-id ref. Returns true when a matching ref was released.
	 *
	 * By default the ref is unregistered (teardown / one-shot removal). Pass
	 * `tombstone: true` for an explicit kill: the ref is kept registered as a
	 * terminal `aborted` row (session detached) instead of being removed, so a
	 * later persisted-subagent scan (e.g. Agent Hub reopen) skips it via its
	 * `if (!registry.get(id))` guard rather than re-adopting the surviving
	 * on-disk transcript as a fresh `parked` row. Mirrors
	 * `finalizeSubagentLifecycle`'s explicit-kill path. An explicit kill is terminal;
	 * only ordinary aborted refs without a persisted hard-kill marker may reopen.
	 */
	release(
		id: string,
		expected: AgentRef | AgentSession,
		options?: { tombstone?: boolean },
		capability?: unknown,
	): Promise<boolean> {
		// Release is not async (it must register in #releases synchronously), but callers still observe
		// authority refusal as a rejection, never a synchronous throw.
		try {
			assertAgentLifecycleCapability(capability);
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.#releaseClosed)
			return Promise.reject(new LifecycleDisposedError("Agent lifecycle release admission is closed."));
		const release = this.#release(id, expected, options);
		this.#releases.add(release);
		const clear = () => {
			if (!this.#disposed) this.#releases.delete(release);
		};
		void release.then(clear, clear);
		return release;
	}

	async #release(id: string, expected: AgentRef | AgentSession, options?: { tombstone?: boolean }): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		const current = lookupAgentRef(this.#registry, id);
		const currentMatches = current && matchesExpected(this.#registry, current, expected);
		const adoptedMatches = adopted && matchesExpected(this.#registry, adopted.ref, expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		if (expected !== undefined && current && !currentMatches) return false;
		if (!ref) return false;
		const lineage = ref.lineage;
		const sessionFile = ref.sessionFile;
		const expectedSession = ref.session;
		const onRelease = adopted?.ref === ref ? adopted.onRelease : undefined;
		if (adopted?.ref === ref) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(id);
		}

		const park = this.#parks.get(id);
		let parkOwnsDispose = false;
		if (park && park.ref === ref) {
			if (!park.detached) {
				park.cancel();
				await park.promise;
				if (park.detached) parkOwnsDispose = true;
			} else {
				parkOwnsDispose = true;
			}
		}
		if (lookupAgentRef(this.#registry, id) !== ref || ref.lineage !== lineage || ref.sessionFile !== sessionFile)
			return false;
		if (parkOwnsDispose) {
			if (ref.session !== null || ref.status !== "parked") return false;
		} else if (ref.session !== expectedSession) {
			return false;
		}
		const live = parkOwnsDispose ? null : expectedSession;

		if (options?.tombstone) {
			const alreadyAborted = ref.status === "aborted" && !live;
			if (!alreadyAborted && !(await abortAgentRef(this.#registry, ref, live ?? undefined))) return false;
			if (
				lookupAgentRef(this.#registry, id) !== ref ||
				ref.status !== "aborted" ||
				ref.session !== null ||
				ref.lineage !== lineage ||
				ref.sessionFile !== sessionFile
			)
				return false;
			this.#hardKilledRefs.add(ref);
			try {
				try {
					if (sessionFile) await persistAgentTombstone(sessionFile);
				} finally {
					if (live) await live.dispose();
					else if (parkOwnsDispose) await park?.promise;
				}
			} finally {
				if (!alreadyAborted) endAgentTermination(this.#registry, ref);
			}
		} else {
			if (parkOwnsDispose && this.#parks.get(id) === park) this.#parks.delete(id);
			if (!(await removeAgentRef(this.#registry, ref))) return false;
			if (parkOwnsDispose) await park?.promise;
		}
		if (onRelease) await onRelease();
		return true;
	}

	/** Fence new ensureLive calls while draining accepted revivals; release callbacks remain independently owned. */
	async quiesceRevivalsForRootReplacement(capability?: unknown): Promise<AgentLifecycleReplacementDrain> {
		assertAgentLifecycleCapability(capability);
		if (this.#disposed) throw new LifecycleDisposedError("Agent lifecycle is being disposed.");
		this.#replacementRevivalFence = true;
		const outcomes = await Promise.allSettled([...this.#activeEnsureOperations]);
		const failures = outcomes.flatMap(outcome => (outcome.status === "rejected" ? [outcome.reason] : []));
		const cleanupFailed = outcomes.some(
			outcome => outcome.status === "rejected" && outcome.reason instanceof AgentLifecycleCleanupError,
		);
		return {
			failures,
			resume: () => {
				if (!this.#disposed && !cleanupFailed) this.#replacementRevivalFence = false;
			},
		};
	}
	/** Teardown everything; disposing the global manager makes its next owner a fresh instance. */
	dispose(deadlineAt: number = Date.now() + AGENT_RELEASE_GRACE_MS, _capability?: unknown): Promise<void> {
		if (this.#disposal) return this.#disposal;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#persistedObservations.clear();
		for (const adopted of this.#adopted.values()) clearTimeout(adopted.timer);
		const disposal = this.#finishDispose(deadlineAt);
		this.#disposal = disposal;
		return disposal;
	}

	async #finishDispose(deadlineAt: number): Promise<void> {
		const pendingOperations = [
			...[...this.#revivals.values()].map(revival => revival.promise),
			...[...this.#reopens.values()].map(reopening => reopening.promise),
			...[...this.#parks.values()].map(park => park.promise),
			...this.#releases,
		];
		const ids = [...new Set([...this.#adopted.keys(), ...this.#parks.keys()])];
		const cleanupOperations = ids.map(async id => {
			const expected = lookupAgentRef(this.#registry, id) ?? this.#adopted.get(id)?.ref;
			if (!expected) return;
			const cleanup: Promise<void> = (async () => {
				if (expected.sessionFile) await this.park(id, lifecycleCapability);
				else if (
					!(await this.release(id, expected, undefined, lifecycleCapability)) &&
					lookupAgentRef(this.#registry, id) === expected
				)
					throw new Error(`Agent "${id}" could not be released during lifecycle teardown.`);
			})();
			try {
				await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => cleanup);
			} catch (error) {
				if (Date.now() < deadlineAt) throw error;
				trackLateCleanup(cleanup, { id, resource: "adopted-agent" });
				logger.warn("Agent cleanup exceeded its deadline", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
				await cleanup;
			}
		});
		const outcomes = await Promise.allSettled([...pendingOperations, ...cleanupOperations]);
		// Releases accepted while parks drain still own their onRelease callbacks.
		while (this.#releases.size > 0) {
			const releases = [...this.#releases];
			outcomes.push(...(await Promise.allSettled(releases)));
			for (const release of releases) this.#releases.delete(release);
		}
		this.#releaseClosed = true;
		const errors: unknown[] = [];
		for (const outcome of outcomes) {
			if (
				outcome.status === "rejected" &&
				!(outcome.reason instanceof LifecycleDisposedError) &&
				!errors.includes(outcome.reason)
			)
				errors.push(outcome.reason);
		}
		this.#adopted.clear();
		this.#revivals.clear();
		this.#reopens.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
		if (errors.length > 0) throw new AggregateError(errors, "Agent lifecycle teardown failed.");
	}

	async #revive(
		id: string,
		revive: AgentReviver,
		ref: InternalAgentRef,
		adopted: AdoptedAgent,
	): Promise<AgentSession> {
		const sessionFile = ref.sessionFile;
		const lineage = ref.lineage;
		const parentId = ref.parentId;
		const kind = ref.kind;
		const session = await revive(observeAgentRef(this.#registry, ref));
		const stillSameRef = () =>
			lookupAgentRef(this.#registry, id) === ref &&
			ref.lineage === lineage &&
			ref.parentId === parentId &&
			ref.kind === kind &&
			ref.sessionFile === sessionFile;
		try {
			if (this.#disposed)
				throw new LifecycleDisposedError(
					`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was reviving.`,
				);
			let liveRef = lookupAgentRef(this.#registry, id);
			if (liveRef === ref && stillSameRef() && ref.status === "parked" && !ref.session) {
				if (!attachAgentSession(this.#registry, id, session, sessionFile, ref))
					throw new Error(`Agent "${id}" changed before its persisted session could attach.`);
				liveRef = ref;
			} else if (liveRef !== ref || !stillSameRef() || liveRef.status !== "running" || liveRef.session !== session) {
				throw new Error(`Agent "${id}" was replaced or became terminal while its persisted session was reviving.`);
			}
			adopted.ref = liveRef;
			if (!(await setAgentStatus(this.#registry, id, "idle", session)))
				throw new Error(`Agent "${id}" changed before its persisted session became idle.`);
			if (this.#disposed)
				throw new LifecycleDisposedError(
					`Agent "${id}" lifecycle was disposed while its persisted session was becoming idle.`,
				);
			if (!stillSameRef() || ref.status !== "idle" || ref.session !== session)
				throw new Error(`Agent "${id}" changed while its persisted session was becoming idle.`);
			return session;
		} catch (error) {
			try {
				await session.dispose();
			} catch (cleanupError) {
				throw new AgentLifecycleCleanupError(
					[error, cleanupError],
					`Agent "${id}" revival failed and session cleanup also failed.`,
				);
			}
			throw error;
		}
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (this.#disposed || adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			if (adopted.ref.session?.ircWakesPending) {
				this.#armTimer(id, adopted);
				return;
			}
			void this.park(id, lifecycleCapability).catch(error => {
				logger.warn("AgentLifecycleManager.park: session disposal failed", { id, error: String(error) });
			});
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: InternalRegistryEvent): void {
		const retained = this.#persistedObservations.get(event.ref.id);
		if (retained && (retained.ref === event.ref || lookupAgentRef(this.#registry, event.ref.id) !== retained.ref)) {
			this.#persistedObservations.delete(event.ref.id);
		}
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted || adopted.ref !== event.ref) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			// Don't re-arm while a park is in flight — the park owns the transition.
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
