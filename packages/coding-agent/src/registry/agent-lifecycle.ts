/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 *
 * Park/dispose is gated against concurrent ensureLive/hub-send:
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
	resolveAgentObservation,
	setAgentStatus,
	type InternalAgentRef,
	type InternalRegistryEvent,
} from "../internal/agent-registry-bridge";
import type { AgentSession } from "../session/agent-session";
import { trackLateCleanup } from "../utils/late-cleanup";
import { type AgentRef, AgentRegistry, getAgentTombstonePath, MAIN_AGENT_ID } from "./agent-registry";

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
}

interface AdoptedAgent {
	ref: InternalAgentRef;
	idleTtlMs: number;
	revive?: AgentReviver;
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

export class AgentLifecycleManager {
	static global(): never {
		throw new Error("AgentLifecycleManager.global() is not a public authority surface.");
	}

	/** Test callers must use the non-exported lifecycle bridge. */
	static resetGlobalForTests(): never {
		throw new Error("Agent lifecycle reset is internal.");
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts, each bound to the ref it started from. A park is
	 * cancelable until the live session is detached; after detach, ensureLive
	 * waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
	/** In-flight revives, bound to the parked ref that initiated them, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** TTL applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtlMs = 0;
	/** Set once {@link dispose} runs; blocks late revivals from adopting into a torn-down manager. */
	#disposed = false;

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
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 */
	setPersistedSubagentReviverFactory(
		factory: PersistedSubagentReviverFactory,
		idleTtlMs: number,
		_capability?: unknown,
	): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * When `expected` is given, the adoption is refused if the id no longer
	 * resolves to that ref (or that ref's session).
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRef | AgentSession, _capability?: unknown): void {
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
				if (await persistedFactory(observeAgentRef(this.#registry, ref))) return false;
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
		return removeAgentRef(this.#registry, ref);
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
	 * `session.dispose()` so concurrent {@link ensureLive}/hub-send never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(id: string, _capability?: unknown): Promise<void> {
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
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Cancel only before detach — once detached the old session is already
				// leaving the registry and must finish disposing.
				if (park.detached || cancelled) return cancelled;
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

				// Commit atomically: detach + parked before dispose so callers never
				if (!parkAgentRef(this.#registry, ref, session)) return;
				park.detached = true;
				try {
					await session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
				}
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
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls share one in-flight revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 */
	async ensureLive(id: string, _capability?: unknown): Promise<AgentSession> {
		const park = this.#parks.get(id);
		if (park) {
			const parked = lookupAgentRef(this.#registry, id);
			// Cancel if the live session is still attached — keep it instead of
			// thrashing dispose + revive.
			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				const kept = lookupAgentRef(this.#registry, id)?.session;
				if (kept) {
					// Park cleared the idle timer; re-arm so TTL park still works.
					const adopted = this.#adopted.get(id);
					if (adopted && adopted.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
					return kept;
				}
			} else {
				// Already committed to detach (or no live session): wait for park,
				// then fall through to the revive path.
				await park.promise;
			}
		}

		const ref = lookupAgentRef(this.#registry, id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (ref.session) return ref.session;
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return inflight.promise;
		const revival = this.#resolveAndRevive(id, ref);
		const pending: RevivingAgent = { ref, promise: revival };
		this.#revivals.set(id, pending);
		try {
			return await revival;
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: InternalAgentRef): Promise<AgentSession> {
		let adoption = this.#adopted.get(id);
		let revive = adoption?.ref === ref ? adoption.revive : undefined;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(observeAgentRef(this.#registry, ref));
			// Teardown can complete during the factory await. A late cold revive must
			// never repopulate or attach to a disposed lifecycle manager.
			if (this.#disposed) {
				throw new Error(
					`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was being prepared.`,
				);
			}
			if (revive) {
				adoption = { ref, idleTtlMs: this.#persistedReviveTtlMs, revive };
				this.#adopted.set(id, adoption);
				coldAdopted = true;
			}
		}
		if (lookupAgentRef(this.#registry, id) !== ref) {
			throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
		}
		if (ref.status !== "parked" || !revive || !adoption) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		try {
			return await this.#revive(id, revive, ref, adoption);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
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
	 * `finalizeSubagentLifecycle`'s genuine-kill path.
	 */
	async release(
		id: string,
		expected: AgentRef | AgentSession,
		options?: { tombstone?: boolean },
		capability?: unknown,
	): Promise<boolean> {
		assertAgentLifecycleCapability(capability);
		const adopted = this.#adopted.get(id);
		const current = lookupAgentRef(this.#registry, id);
		const currentMatches = current && matchesExpected(this.#registry, current, expected);
		const adoptedMatches = adopted && matchesExpected(this.#registry, adopted.ref, expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		if (expected !== undefined && current && !currentMatches) return false;
		if (!ref) return false;
		if (adopted?.ref === ref) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(id);
		}

		const park = this.#parks.get(id);
		let parkOwnsDispose = false;
		if (park && park.ref === ref) {
			// Prefer cancel when the session is still live so release owns the
			// disposal. Once detached, remove the row immediately and let the
			// in-flight park finish disposing its captured session.
			if (!park.detached) {
				park.cancel();
				await park.promise;
			} else {
				parkOwnsDispose = true;
			}
		}
		if (lookupAgentRef(this.#registry, id) !== ref) return false;
		const live = ref.session;

		if (options?.tombstone) {
			if (!abortAgentRef(this.#registry, ref, live ?? undefined)) return false;
			try {
				try {
					if (ref.sessionFile) await persistAgentTombstone(ref.sessionFile);
				} finally {
					// Always dispose the captured session, even if persistence fails.
					if (live && !parkOwnsDispose) {
						try {
							await live.dispose();
						} catch (error) {
							logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
						}
					} else if (parkOwnsDispose) {
						await park?.promise;
					}
				}
			} finally {
				endAgentTermination(this.#registry, ref);
			}
		} else {
			// Remove before awaiting disposal. A replacement generation can claim
			// the same id, while the exact captured session can only affect `ref`.
			if (parkOwnsDispose && this.#parks.get(id) === park) this.#parks.delete(id);
			if (!removeAgentRef(this.#registry, ref)) return false;
			if (live && !parkOwnsDispose) {
				try {
					await live.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
				}
			} else if (parkOwnsDispose) {
				await park?.promise;
			}
		}
		return true;
	}

	/** Teardown everything; disposing the global manager makes its next owner a fresh instance. */
	async dispose(deadlineAt: number = Date.now() + AGENT_RELEASE_GRACE_MS, _capability?: unknown): Promise<void> {
		this.#unsubscribe?.();
		this.#disposed = true;
		this.#unsubscribe = undefined;
		const ids = [...new Set([...this.#adopted.keys(), ...this.#parks.keys()])];
		await Promise.all(
			ids.map(async id => {
				const expected = lookupAgentRef(this.#registry, id) ?? this.#adopted.get(id)?.ref;
				if (!expected) return;
				const release = (
					expected.sessionFile
						? this.park(id, lifecycleCapability)
						: this.release(id, expected, undefined, lifecycleCapability)
				).then(() => {});
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => release);
				} catch (error) {
					if (Date.now() >= deadlineAt) trackLateCleanup(release, { id, resource: "adopted-agent" });
					logger.warn("Agent cleanup exceeded its deadline", {
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		this.#revivals.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
	}

	async #revive(
		id: string,
		revive: AgentReviver,
		ref: InternalAgentRef,
		adopted: AdoptedAgent,
	): Promise<AgentSession> {
		const session = await revive(observeAgentRef(this.#registry, ref));
		if (this.#disposed) {
			// The owning lifecycle tore down while the reviver was in flight; dispose
			// the late session before rejecting.
			await session.dispose();
			throw new Error(
				`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was reviving.`,
			);
		}
		let liveRef = lookupAgentRef(this.#registry, id);
		if (liveRef === ref && ref.status === "parked" && !ref.session) {
			// A simple reviver returned a session without claiming the parked ref;
			// attach it here while the exact ref is still revivable.
			if (!attachAgentSession(this.#registry, id, session, ref.sessionFile, ref)) {
				await session.dispose();
				throw new Error(`Agent "${id}" changed before its persisted session could attach.`);
			}
			liveRef = ref;
		} else if (
			liveRef !== ref ||
			liveRef.status !== "running" ||
			liveRef.session !== session ||
			liveRef.kind !== ref.kind ||
			liveRef.parentId !== ref.parentId ||
			liveRef.sessionFile !== ref.sessionFile
		) {
			// createAgentSession may have already claimed this exact parked ref and
			// attached the returned session. Any other state — especially an
			// `aborted` tombstone set while revive() was in flight — is stale.
			await session.dispose();
			throw new Error(`Agent "${id}" was replaced or became terminal while its persisted session was reviving.`);
		}
		adopted.ref = liveRef;
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		if (!setAgentStatus(this.#registry, id, "idle", session)) {
			await session.dispose();
			throw new Error(`Agent "${id}" changed before its persisted session became idle.`);
		}
		return session;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			void this.park(id, lifecycleCapability);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: InternalRegistryEvent): void {
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
