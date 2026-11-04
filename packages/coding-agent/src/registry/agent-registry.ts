/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`agent://`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import { logger } from "@oh-my-pi/pi-utils";
import {
	bindOwnedAgentLifecycle,
	disposeOwnedAgentLifecycle,
	lookupOwnedAgentLifecycle,
	quiesceOwnedAgentLifecycleForReplacement,
	replaceOwnedAgentLifecycle,
} from "../internal/agent-lifecycle-bridge";
import {
	bindAgentSessionRegistry,
	kRootCompactionThresholds,
	registerAgentRegistryBridge,
	type InternalAgentOwnershipToken,
	type InternalAgentRef,
	type InternalRegistryEvent,
	type SubagentChainSettings,
} from "../internal/agent-registry-bridge";
import { deriveRestrictedStartupPolicy } from "../internal/restricted-startup-policy";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionDisposeOptions } from "../session/agent-session-types";
import type * as Sdk from "../sdk";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import {
	composeEffectivePermissions,
	freezePermissionScope,
	isScopeNoBroader,
	normalizeEffectivePermissionSummary,
	type PermissionScopeSnapshot,
} from "../task/permission-profiles";
import { copyBrowserAuditSessionCapability } from "../internal/browser-audit-session-capabilities";
import {
	bindSessionOperationAuthority,
	bindSessionOperationDurability,
	type BoundSessionOperationAuthority,
	issueBoundSessionOperationAuthority,
	MigrationFenceController,
	type RootMigrationFence,
} from "./operation-lease";
import {
	canonicalDurableSha256,
	type DurableActorRecord,
	type DurableConstructionRecord,
	type DurableGateRecord,
	type DurableRootRecord,
	type DurableTransitionRecord,
	durableRootHeadHash,
} from "./durable-state";
import type {
	AuthorityActivation,
	AuthorityRecoveryState,
	AuthorityStore,
	RootTransitionCommit,
} from "./authority/types";
import { registryDurableStateForSession } from "./authority";
import { AgentAwaits } from "./agent-awaits";
import type { EffectivePermissionSummary } from "@oh-my-pi/pi-wire";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";
import { MAIN_AGENT_ID } from "./agent-identity";

export { MAIN_AGENT_ID };

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/** Provenance of a displayed duration: active runtime, transcript span, or unavailable. */
type AgentDurationKind = "active" | "span" | "unknown";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`proc://`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";

/** Persisted per-agent totals reconstructed from the child session transcript. */
export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: AgentDurationKind;
	contextTokens?: number;
	contextWindow?: number;
}
/** Run lifecycle milestones scoped to the current turn. */
export interface AgentRunLifecycle {
	/** When the run produced its final response. */
	responseAt?: number;
	/** When the run's final result was accepted by its driver. */
	acceptedAt?: number;
	/** When the ref last left `running` for a terminal status. */
	terminalAt?: number;
}

/** Historical identity and telemetry that remain available after the live observer is gone. */
export interface AgentHistorySummary {
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	/** Exact permission profiles requested by the original invocation, in request order. */
	requestedPermissionProfiles?: string[];
	/** Effective inherited plus requested permission profiles, in composition order. */
	effectivePermissionProfiles?: string[];
	/** Complete frozen permission scope retained for revival and drift rejection. */
	permissionSnapshot?: PermissionScopeSnapshot;
	/** Sanitized bounded display metadata; never used to reconstruct authority. */
	permissionSummary?: EffectivePermissionSummary;
	/** Whether the last resolved model was selected by retry fallback routing. */
	resolvedModelIsFallback?: boolean;
	metrics?: AgentMetricsSummary;
	/** Cumulative own-session assistant and model_usage cost, excluding nested task results. */
	directCost?: number;
	readOnly?: boolean;
	/** Durable task output artifact, when the executor wrote one. */
	outputPath?: string;
	/** Captured isolated-worktree patch, when patch capture succeeded. */
	patchPath?: string;
	/** Isolated branch identity, when branch-mode capture succeeded. */
	branchName?: string;
	/** Captured nested-repo patches (`<id>.nested-<n>-<path>.patch`), one per nested repository the agent changed. */
	nestedPatchPaths?: string[];
}
function cloneAndFreezeAuthorityInput<T>(value: T, active = new WeakSet<object>()): T {
	if (value === null || typeof value !== "object") return value;
	if (active.has(value)) throw new TypeError("Authority session inputs cannot contain cycles.");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		return value;
	active.add(value);
	try {
		if (Array.isArray(value))
			return Object.freeze(value.map(item => cloneAndFreezeAuthorityInput(item, active))) as T;
		const clone: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			clone[key] = cloneAndFreezeAuthorityInput(item, active);
		}
		return Object.freeze(clone) as T;
	} finally {
		active.delete(value);
	}
}

const AUTHORITY_DURABLE_STARTUP_KEYS = [
	"cwd",
	"agentDir",
	"agentName",
	"parentTaskPrefix",
	"spawns",
	"toolNames",
	"outputSchema",
	"outputSchemaMode",
	"requireYieldTool",
	"taskDepth",
] as const;

function cloneCanonicalAuthorityMetadata(value: unknown, active = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
		return undefined;
	if (active.has(value)) throw new TypeError("Canonical authority metadata cannot contain cycles.");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			return Object.freeze(
				value.map(item => cloneCanonicalAuthorityMetadata(item, active)).filter(item => item !== undefined),
			);
		}
		const clone: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			const canonical = cloneCanonicalAuthorityMetadata(item, active);
			if (canonical !== undefined) clone[key] = canonical;
		}
		return Object.freeze(clone);
	} finally {
		active.delete(value);
	}
}

function canonicalAuthorityStartupDescriptor(
	options: CreateAgentSessionOptions,
	reservation: AgentReservation,
): Readonly<Record<string, unknown>> {
	const policy = deriveRestrictedStartupPolicy({
		permissionScope: options.permissionScope,
		restrictToolNames: options.restrictToolNames,
		toolNames: options.toolNames,
		enableLsp: options.enableLsp,
		enableMCP: options.enableMCP,
	});
	const metadata: Record<string, unknown> = {};
	for (const key of AUTHORITY_DURABLE_STARTUP_KEYS) {
		const value = key === "toolNames" ? policy.toolNames : options[key];
		const canonical = cloneCanonicalAuthorityMetadata(
			key === "toolNames" && Array.isArray(value) ? [...value].sort() : value,
		);
		if (canonical !== undefined) metadata[key] = canonical;
	}
	metadata.restrictToolNames = options.restrictToolNames === true;
	metadata.features = Object.freeze({
		enableIrc: options.enableIrc !== false,
		enableLsp: policy.enableLsp,
		enableMCP: policy.enableMCP,
	});
	return Object.freeze({
		actorId: reservation.id,
		rootId: reservation.rootId,
		...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
		generation: reservation.generation,
		sessionFile: options.sessionManager?.getSessionFile() ?? null,
		metadata: Object.freeze(metadata),
	});
}

function authoritySessionFile(session: AgentSession): string | null {
	const manager = session.sessionManager as { getSessionFile?: () => string | null | undefined };
	return typeof manager.getSessionFile === "function" ? (manager.getSessionFile() ?? null) : null;
}

declare const agentCapabilityBrand: unique symbol;

export type AgentCapability = {
	readonly [agentCapabilityBrand]: never;
	readonly actorId: string;
	readonly rootId: string;
	readonly parentId?: string;
	readonly generation: number;
};

export interface AgentReservation {
	readonly capability: AgentCapability;
	readonly id: string;
	readonly rootId: string;
	readonly parentId?: string;
	readonly generation: number;
}

interface PreparedAgentAuthoritySession {
	readonly reservation: AgentReservation;
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly options: Pick<CreateAgentSessionOptions, "agentDisplayName">;
	readonly create: () => Promise<CreateAgentSessionResult>;
	readonly activate: (session: AgentSession) => Promise<void>;
	readonly abandon: () => Promise<void>;
	readonly isCurrent: (session: AgentSession) => boolean;
	readonly startupHash: string;
	readonly provenanceHash: string;
	readonly scopeHash?: string;
	readonly parentScopeHash?: string;
	readonly revival: boolean;
}

interface DurableRootTransitionAttempt {
	readonly transition: Omit<DurableTransitionRecord, "at" | "phase" | "recovery">;
	readonly sourceRoot: DurableRootRecord;
	readonly sourceGate: DurableGateRecord;
	phase: DurableTransitionRecord["phase"] | undefined;
	casAttempted: boolean;
	casCommitted: boolean;
}

interface DurableActivationAttempt {
	rootTransition?: DurableRootTransitionAttempt;
}

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Persisted identity and telemetry restored after the live session is disposed. */
	history?: AgentHistorySummary;
	/** Run lifecycle milestones for the current turn. */
	lifecycle?: AgentRunLifecycle;
	/** Opaque lineage slot assigned by the registry generation. */
	readonly lineage?: { readonly rootId: string; readonly parentId?: string; readonly generation: number };
}

type RegistryAgentRef = InternalAgentRef;
export type AgentRefExpectation = AgentRef | AgentSession;

/**
 * Whether messaging `ref` resumes it: a live `idle` agent, or a `parked` or
 * killed one whose transcript is on disk. Task summaries use it to tell the
 * parent to resume a stopped agent instead of redoing its work.
 */
export function isResumable(ref: AgentRef | undefined): boolean {
	if (ref?.status === "idle") return true;
	return (ref?.status === "parked" || ref?.status === "aborted") && ref.sessionFile !== null;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "metadata_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;
type InternalRegistryListener = (event: InternalRegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	activity?: string;
	createdAt?: number;
	lastActivity?: number;
	history?: AgentHistorySummary;
	/** Run lifecycle milestones restored from persisted history, when known. */
	lifecycle?: AgentRunLifecycle;
}

export interface AgentMetadataUpdate {
	displayName: string;
	createdAt: number;
	lastActivity: number;
}

export interface AgentAuthoritySessionBinding {
	create(
		options: CreateAgentSessionOptions & { agentId: string },
		reviveObservation?: AgentRef,
	): Promise<CreateAgentSessionResult>;
}

export interface AgentRegistryOptions {
	readonly durableState?: AuthorityStore;
}

interface AgentRegistryInitialization {
	readonly token: typeof initializedRegistryToken;
	readonly recovery: AuthorityRecoveryState;
}

const initializedRegistryToken = Symbol("initializedRegistryToken");

// sdk is loaded on first construction, not imported statically: it pulls in the full tool
// tree, and a static import closes a cycle (settings -> ... -> registry -> sdk -> tts-client
// -> model-worker-host -> settings) that leaves module-level worker clients in their TDZ.
// Caching the namespace keeps later constructions free of extra async hops, so they keep
// their ordering against quiesce and cancellation.
let sdkModule: typeof Sdk | undefined;

class AgentAuthorityCleanupError extends AggregateError {
	constructor(cause: unknown, cleanupErrors: readonly unknown[]) {
		super([cause, ...cleanupErrors], "Agent authority cleanup did not complete.");
		this.name = "AgentAuthorityCleanupError";
	}
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Install the canonical process registry before any authority is exposed. */
	static installGlobal(registry: AgentRegistry): void {
		const current = AgentRegistry.#global;
		if (current && current !== registry && current.#refs.size > 0) {
			throw new Error("Cannot replace an active process-global agent registry.");
		}
		AgentRegistry.#global = registry;
	}

	/**
	 * Create a private registry whose durable authority ledger follows one session transcript. The transcript must
	 * already be on disk (for a new session, call `SessionManager.ensureOnDisk()` first): authority binds to its header.
	 */
	static async isolatedForSession(sessionFile: string): Promise<AgentRegistry> {
		const durableState = await registryDurableStateForSession(sessionFile);
		return AgentRegistry.create({ durableState });
	}

	/** Recover durable authority before publishing a registry projection. */
	static async create(options: AgentRegistryOptions = {}): Promise<AgentRegistry> {
		if (!options.durableState) return new AgentRegistry(options);
		const recovery = await options.durableState.recover();
		if (recovery.blocked.length > 0 || recovery.owner.phase !== "ready") {
			throw new Error(
				`Authority recovery did not reach ready state: ${recovery.blocked.join("; ") || recovery.owner.phase}`,
			);
		}
		return new AgentRegistry(options, { token: initializedRegistryToken, recovery });
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, RegistryAgentRef>();
	readonly #listeners = new Set<RegistryListener>();
	/** Agents currently blocked on other agents; used to identify reply-wait cycles. */
	readonly awaits = new AgentAwaits();
	readonly #internalListeners = new Set<InternalRegistryListener>();
	readonly #terminating = new Map<string, RegistryAgentRef>();
	readonly #pendingRootOperations = new Map<
		string,
		Set<{ promise: Promise<unknown>; ancestors: ReadonlySet<RegistryAgentRef>; propagateFailure?: boolean }>
	>();
	readonly #removalPromises = new WeakMap<RegistryAgentRef, Promise<boolean>>();
	readonly #actorMutationTails = new WeakMap<RegistryAgentRef, Promise<void>>();
	readonly #sessionRunStateDrains = new WeakMap<AgentSession, () => Promise<void>>();
	readonly #acceptedParks = new Map<AgentSession, RegistryAgentRef>();
	/** Retain physical ownership and ancestry when disposal rejects; no successor may revive it. */
	readonly #failedSessionDisposals = new Map<RegistryAgentRef, { session: AgentSession; error: unknown }>();
	readonly #sourceOperationFences = new Set<string>();
	/**
	 * Root replacements own failures of descendant operations accepted while they run, including
	 * operations that settle before the replacement reaches its drain.
	 */
	readonly #rootOperationFailureWatches = new Map<string, Set<{ ancestor: RegistryAgentRef; failures: unknown[] }>>();
	/** Roots whose removal is running their owned lifecycle teardown; that teardown may still park descendants. */
	readonly #rootLifecycleTeardowns = new Set<RegistryAgentRef>();
	readonly #rawSessionDisposals = new WeakMap<AgentSession, AgentSession["dispose"]>();
	readonly #capabilities = new WeakMap<
		object,
		{ actorId: string; rootId: string; parentId?: string; generation: number }
	>();
	readonly #reservations = new WeakMap<object, AgentReservation>();
	/** Exact reservation occupying each id until it is claimed or abandoned. */
	readonly #claimedIds = new Map<string, AgentReservation>();
	readonly #sessionCapabilities = new WeakMap<AgentSession, AgentCapability>();
	readonly #operationSessionAuthorities = new WeakMap<AgentSession, BoundSessionOperationAuthority>();
	readonly #authorityRefs = new WeakSet<RegistryAgentRef>();
	readonly #refCapabilities = new WeakMap<RegistryAgentRef, AgentCapability>();
	readonly #observations = new WeakMap<AgentRef, RegistryAgentRef>();
	readonly #reservationRefs = new WeakMap<object, RegistryAgentRef>();
	readonly #ownershipTokens = new WeakMap<RegistryAgentRef, InternalAgentOwnershipToken>();
	readonly #durableState: AuthorityStore | undefined;
	readonly #durableRecovery: AuthorityRecoveryState | undefined;
	readonly #durableRootHeads = new Map<string, { generation: number; headHash: string }>();
	readonly #durableActorRecords = new WeakMap<RegistryAgentRef, DurableActorRecord>();

	constructor(options: AgentRegistryOptions = {}, initialization?: AgentRegistryInitialization) {
		if (options.durableState && (!initialization || initialization.token !== initializedRegistryToken)) {
			throw new Error("Live authority stores must be initialized through AgentRegistry.create().");
		}
		this.#durableState = options.durableState;
		this.#durableRecovery = initialization?.recovery;
		for (const root of this.#durableRecovery?.roots.values() ?? []) {
			if (root.state === "active")
				this.#durableRootHeads.set(root.rootId, { generation: root.generation, headHash: root.headHash });
		}
		this.#nextGeneration = (this.#durableRecovery?.generationHighWater ?? 0) + 1;
		registerAgentRegistryBridge(this, {
			lookup: id => this.#refs.get(id),
			list: () => [...this.#refs.values()],
			resolveObservation: observation => this.#observations.get(observation),
			ownershipToken: expected => this.#ownershipToken(expected),
			bindAuthoritySession: parent => this.#bindAuthoritySession(parent),
			lookupAuthoritySession: parent => this.#lookupAuthoritySession(parent),
			isSessionParentIrcSender: (session, recipientId, senderId) =>
				this.#isSessionParentIrcSender(session, recipientId, senderId),
			isSessionDescendantIrcSender: (session, recipientId, senderId) =>
				this.isSessionDescendantIrcSender(session, recipientId, senderId),
			isSessionSubagent: (session, recipientId) => this.isSessionSubagent(session, recipientId),
			lookupAuthorityLineage: parentId => this.#lookupAuthorityLineage(parentId),
			createRootSession: options => this.#createRootSession(options),
			setHistory: (expected, history, expectedSessionFile) =>
				this.#setHistoryInternal(expected, history, expectedSessionFile),
			setStatus: (id, status, expected) => this.#setStatusInternal(id, status, expected),
			setActivity: (id, activity, expected) => this.#setActivityInternal(id, activity, expected),
			attachSession: (id, session, sessionFile, expected) =>
				this.#attachSessionInternal(id, session, sessionFile, expected),
			detachSession: (id, expected) => this.#detachSessionInternal(id, expected),
			unregister: (id, expected) => this.#unregisterInternal(id, expected),
			operationAuthority: parent => this.#operationAuthority(parent),
			park: (expectedRef, expectedSession, dispose, beforeDispose) =>
				this.#transitionToParked(expectedRef, expectedSession, dispose, beforeDispose),
			abort: (expectedRef, expectedSession) => this.#transitionToAborted(expectedRef, expectedSession),
			remove: expectedRef => this.#removeExact(expectedRef),
			endTermination: expectedRef => this.#endTermination(expectedRef),
			syncSessionStatus: (id, session) => this.#syncSessionStatusInternal(id, session),
			register: input => this.#register(input),
			registerIfAvailable: (input, expected) => this.#registerIfAvailableInternal(input, expected),
			replaceIfAvailable: (input, expected) => this.#replaceIfAvailableInternal(input, expected),
			markResultAccepted: (id, expected, responseAt) => this.#markResultAcceptedInternal(id, expected, responseAt),
			onChange: listener => {
				this.#internalListeners.add(listener);
				return () => this.#internalListeners.delete(listener);
			},
			observe: ref => this.#observe(ref),
		});
	}

	/** Exact journal used by this registry; never included in public agent observations. */
	getDurableStateStore(): AuthorityStore | undefined {
		return this.#durableState;
	}

	/**
	 * Create the first authority-owning root session in this private registry.
	 *
	 * Public SDK sessions intentionally cannot self-register by passing assertion
	 * hints to `createAgentSession`. Embedders that need a task-capable isolated
	 * session must instead create a fresh registry and claim its empty root here.
	 * Existing registries are rejected so this capability cannot replace a live
	 * process root or bypass its generation ownership.
	 */
	async createIsolatedRootSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
		if (this.#refs.size > 0) throw new Error("Isolated root creation requires an empty agent registry.");
		return this.#createRootSession(options);
	}

	#nextGeneration = 1;
	#matchesPublicExpected(ref: RegistryAgentRef, expected?: AgentRefExpectation): boolean {
		if (this.#authorityRefs.has(ref)) return false;
		if (expected === undefined) return true;
		if (expected === ref.session) return true;
		return this.#observations.get(expected as AgentRef) === ref;
	}

	#matchesInternalExpected(ref: RegistryAgentRef, expected: RegistryAgentRef | AgentSession): boolean {
		if (!this.#authorityRefs.has(ref)) return expected === ref || expected === ref.session;
		const capability = this.#sessionCapabilities.get(expected as AgentSession);
		const record = capability ? this.#capabilities.get(capability as object) : undefined;
		return (
			expected === ref.session &&
			capability !== undefined &&
			this.#refCapabilities.get(ref) === capability &&
			record?.actorId === ref.id &&
			record.rootId === ref.lineage?.rootId &&
			record.generation === ref.lineage?.generation
		);
	}
	#ownershipToken(expected: RegistryAgentRef | AgentRef): InternalAgentOwnershipToken | undefined {
		const observed = this.#observations.get(expected as AgentRef);
		const ref = observed ?? (this.#refs.get(expected.id) === expected ? (expected as RegistryAgentRef) : undefined);
		return ref && this.#refs.get(ref.id) === ref ? this.#ownershipTokens.get(ref) : undefined;
	}
	#newCapability(actorId: string, rootId: string, parentId: string | undefined): AgentCapability {
		const capability = Object.freeze({
			actorId,
			rootId,
			parentId,
			generation: this.#nextGeneration++,
		}) as AgentCapability;
		this.#capabilities.set(capability, { actorId, rootId, parentId, generation: capability.generation });
		return capability;
	}

	#assertCapability(capability: AgentCapability): {
		actorId: string;
		rootId: string;
		parentId?: string;
		generation: number;
	} {
		const record = this.#capabilities.get(capability as object);
		if (!record) throw new Error("Invalid or forged agent capability.");
		return record;
	}
	/**
	 * Root removal fences its lineage before running its owned lifecycle teardown. Parks issued during that
	 * teardown stay admissible so they own their sessions' disposal and any releases accepted meanwhile; the
	 * removal drains them before retiring descendants. Any other terminating ancestor still refuses the park.
	 */
	#isParkFencedByTermination(ref: RegistryAgentRef, rootId: string): boolean {
		const root = this.#refs.get(rootId);
		if (!root || !this.#rootLifecycleTeardowns.has(root) || this.#terminating.get(rootId) !== root)
			return this.#isTerminatingLineage(ref.id, rootId);
		const seen = new Set<string>();
		let current: RegistryAgentRef | undefined = ref;
		while (current && current !== root && !seen.has(current.id)) {
			if (this.#terminating.has(current.id)) return true;
			seen.add(current.id);
			current = current.parentId === undefined ? undefined : this.#refs.get(current.parentId);
		}
		return current !== root;
	}

	#isTerminatingLineage(actorId: string, rootId?: string): boolean {
		if ((rootId && this.#terminating.has(rootId)) || this.#terminating.has(actorId)) return true;
		let current = this.#refs.get(actorId);
		const seen = new Set<string>();
		while (current && !seen.has(current.id)) {
			if (this.#terminating.get(current.id) === current) return true;
			seen.add(current.id);
			current = current.parentId === undefined ? undefined : this.#refs.get(current.parentId);
		}
		return false;
	}

	#trackRootOperation<T>(
		rootId: string,
		parent: RegistryAgentRef,
		promise: Promise<T>,
		propagateFailure = false,
	): Promise<T> {
		const ancestors = new Set<RegistryAgentRef>();
		let current: RegistryAgentRef | undefined = parent;
		while (current && !ancestors.has(current)) {
			ancestors.add(current);
			current = current.parentId === undefined ? undefined : this.#refs.get(current.parentId);
		}
		const pending = this.#pendingRootOperations.get(rootId) ?? new Set();
		const operation = { promise, ancestors, propagateFailure };
		pending.add(operation);
		this.#pendingRootOperations.set(rootId, pending);
		const clear = () => {
			pending.delete(operation);
			if (pending.size === 0) this.#pendingRootOperations.delete(rootId);
		};
		const record = (reason: unknown) => {
			if (reason instanceof AgentAuthorityCleanupError || propagateFailure) {
				for (const watch of this.#rootOperationFailureWatches.get(rootId) ?? []) {
					if (ancestors.has(watch.ancestor) && !watch.failures.includes(reason)) watch.failures.push(reason);
				}
			}
			clear();
		};
		void promise.then(clear, record);
		return promise;
	}

	#watchRootOperationFailures(rootId: string, ancestor: RegistryAgentRef): { failures: unknown[]; close(): void } {
		const watches = this.#rootOperationFailureWatches.get(rootId) ?? new Set();
		const watch = { ancestor, failures: [] as unknown[] };
		watches.add(watch);
		this.#rootOperationFailureWatches.set(rootId, watches);
		return {
			failures: watch.failures,
			close: () => {
				watches.delete(watch);
				if (watches.size === 0 && this.#rootOperationFailureWatches.get(rootId) === watches)
					this.#rootOperationFailureWatches.delete(rootId);
			},
		};
	}

	async #drainRootOperations(
		rootId: string,
		ancestor: RegistryAgentRef,
		excluding?: Promise<unknown>,
		watched?: readonly unknown[],
	): Promise<void> {
		const failures: unknown[] = [...(watched ?? [])];
		while (true) {
			const pending = [...(this.#pendingRootOperations.get(rootId) ?? [])].filter(
				operation => operation.promise !== excluding && operation.ancestors.has(ancestor),
			);
			if (pending.length === 0) break;
			for (const [index, result] of (
				await Promise.allSettled(pending.map(operation => operation.promise))
			).entries()) {
				if (
					result.status === "rejected" &&
					(result.reason instanceof AgentAuthorityCleanupError || pending[index]?.propagateFailure)
				)
					failures.push(result.reason);
			}
		}
		if (failures.length > 0)
			throw new AggregateError(failures, `Descendant authority operations failed while terminating ${ancestor.id}.`);
	}

	#reserve(
		id: string,
		rootId: string,
		parentId: string | undefined,
		generation?: number,
		allowOccupied = false,
	): AgentReservation {
		if (this.#isTerminatingLineage(rootId) || (parentId && this.#isTerminatingLineage(parentId, rootId)))
			throw new Error(`Agent root "${rootId}" is being terminated.`);
		if (parentId !== undefined && this.#claimedIds.has(rootId))
			throw new Error(`Agent root "${rootId}" is reserved for replacement.`);
		if (!id.trim() || (!allowOccupied && this.#refs.has(id)) || this.#claimedIds.has(id))
			throw new Error(`Agent "${id}" is already reserved.`);
		let capability: AgentCapability;
		if (generation === undefined) {
			capability = this.#newCapability(id, rootId, parentId);
		} else {
			capability = Object.freeze({ actorId: id, rootId, parentId, generation }) as AgentCapability;
			this.#capabilities.set(capability, { actorId: id, rootId, parentId, generation });
		}
		const reservation = Object.freeze({
			capability,
			id,
			rootId,
			parentId,
			generation: capability.generation,
		}) as AgentReservation;
		this.#reservations.set(reservation as object, reservation);
		this.#claimedIds.set(id, reservation);
		return reservation;
	}

	#reserveRevival(ref: RegistryAgentRef): AgentReservation {
		const failedSessionDisposal = this.#failedSessionDisposals.get(ref);
		if (failedSessionDisposal)
			throw new AggregateError(
				[failedSessionDisposal.error],
				`Actor "${ref.id}" still owns a session whose disposal failed.`,
			);
		if (
			this.#refs.get(ref.id) !== ref ||
			ref.status !== "parked" ||
			ref.session !== null ||
			!ref.lineage ||
			ref.parentId !== ref.lineage.parentId
		)
			throw new Error("Invalid parked revival authority.");
		if (
			this.#isTerminatingLineage(ref.id, ref.lineage?.rootId) ||
			(ref.parentId !== undefined && this.#claimedIds.has(ref.lineage.rootId))
		)
			throw new Error(
				`Agent "${ref.id}" cannot be revived while its root is terminating or reserved for replacement.`,
			);
		if (this.#claimedIds.has(ref.id)) throw new Error(`Agent "${ref.id}" is already reserved.`);
		const capability = Object.freeze({
			actorId: ref.id,
			rootId: ref.lineage.rootId,
			parentId: ref.lineage.parentId,
			generation: ref.lineage.generation,
		}) as AgentCapability;
		this.#capabilities.set(capability, {
			actorId: ref.id,
			rootId: ref.lineage.rootId,
			parentId: ref.lineage.parentId,
			generation: ref.lineage.generation,
		});
		const reservation = Object.freeze({
			capability,
			id: ref.id,
			rootId: ref.lineage.rootId,
			parentId: ref.lineage.parentId,
			generation: ref.lineage.generation,
		});
		this.#reservations.set(reservation as object, reservation);
		this.#reservationRefs.set(reservation as object, ref);
		this.#claimedIds.set(ref.id, reservation);
		return reservation;
	}

	#claimReserved(reservation: AgentReservation, input: RegisterInput): RegistryAgentRef {
		this.#assertCapability(reservation.capability);
		if (
			this.#isTerminatingLineage(reservation.rootId) ||
			(reservation.parentId && this.#isTerminatingLineage(reservation.parentId, reservation.rootId))
		)
			throw new Error(`Agent root "${reservation.rootId}" began terminating before its reservation was claimed.`);
		if (
			this.#reservations.get(reservation as object) !== reservation ||
			this.#claimedIds.get(reservation.id) !== reservation ||
			input.id !== reservation.id ||
			input.parentId !== reservation.parentId ||
			input.kind !== (reservation.parentId === undefined ? "main" : "sub")
		)
			throw new Error("Invalid or consumed agent reservation.");
		const existing = this.#refs.get(input.id);
		if (existing) {
			const reservedRef = this.#reservationRefs.get(reservation as object);
			if (
				existing.status !== "parked" ||
				existing.session !== null ||
				existing.displayName !== input.displayName ||
				existing.kind !== input.kind ||
				existing.parentId !== input.parentId ||
				existing.sessionFile !== (input.sessionFile ?? null) ||
				existing.lineage?.rootId !== reservation.rootId ||
				existing.lineage?.parentId !== reservation.parentId ||
				existing.lineage?.generation !== reservation.generation ||
				(reservedRef !== undefined && reservedRef !== existing)
			)
				throw new Error(`Agent "${input.id}" registry identity changed before revival.`);
			existing.session = input.session;
			existing.status = input.status ?? "running";
			existing.lastActivity = Date.now();
			this.#reservations.delete(reservation as object);
			this.#reservationRefs.delete(reservation as object);
			this.#claimedIds.delete(reservation.id);
			this.#authorityRefs.add(existing);
			return existing;
		}
		const reservedRef = this.#reservationRefs.get(reservation as object);
		if (reservedRef !== undefined)
			throw new Error(`Agent "${reservation.id}" registry identity changed before revival.`);
		this.#claimedIds.delete(reservation.id);
		let ref: RegistryAgentRef;
		try {
			ref = this.#register(
				input,
				Object.freeze({
					rootId: reservation.rootId,
					parentId: reservation.parentId,
					generation: reservation.generation,
				}),
			);
		} catch (error) {
			this.#claimedIds.set(reservation.id, reservation);
			throw error;
		}
		this.#reservations.delete(reservation as object);
		this.#reservationRefs.delete(reservation as object);
		this.#authorityRefs.add(ref);
		return ref;
	}

	#abandonReservation(reservation: AgentReservation): void {
		if (this.#reservations.get(reservation as object) !== reservation) return;
		this.#reservations.delete(reservation as object);
		this.#reservationRefs.delete(reservation as object);
		if (this.#claimedIds.get(reservation.id) === reservation) this.#claimedIds.delete(reservation.id);
	}

	#isCurrentParentAuthority(parentAuthority: {
		ref: RegistryAgentRef;
		session: AgentSession;
		capability: AgentCapability;
	}): boolean {
		const { ref, session, capability } = parentAuthority;
		return (
			this.#refs.get(ref.id) === ref &&
			ref.session === session &&
			!this.#isTerminatingLineage(ref.id, ref.lineage?.rootId) &&
			!session.isDisposed &&
			(ref.status === "running" || ref.status === "idle") &&
			this.#refCapabilities.get(ref) === capability &&
			this.#sessionCapabilities.get(session) === capability
		);
	}
	async #prepareAuthoritySession(
		reservation: AgentReservation,
		options: CreateAgentSessionOptions,
		parentAuthority?: { ref: RegistryAgentRef; session: AgentSession; capability: AgentCapability },
	): Promise<PreparedAgentAuthoritySession> {
		if (options.agentReservation !== undefined || options.expectedAgentRef !== undefined) {
			this.#abandonReservation(reservation);
			throw new Error("Public agent reservation hints are assertions only and cannot claim session authority.");
		}
		if (options.agentRegistry !== undefined && options.agentRegistry !== this) {
			this.#abandonReservation(reservation);
			throw new Error("Authority session registry assertion does not match its bound registry.");
		}
		if (options.agentId !== undefined && options.agentId !== reservation.id) {
			this.#abandonReservation(reservation);
			throw new Error("Authority session id assertion does not match its reserved slot.");
		}
		const parentSession = parentAuthority?.session;
		const parentScope = parentSession?.getPermissionScope?.();
		let permissionScope = options.permissionScope;
		if (parentScope && !permissionScope) {
			const inherited = composeEffectivePermissions({
				mode: parentScope.mode,
				toolsEnabled: parentScope.toolsEnabled,
				pathsEnabled: parentScope.pathsEnabled,
				actorId: reservation.id,
				actorKind: reservation.parentId === undefined ? "main" : "sub",
				parentId: reservation.parentId,
				inherited: parentScope,
				profiles: {},
			});
			if (!inherited.ok) throw new Error(inherited.error);
			permissionScope = inherited.value;
		}
		if (
			permissionScope &&
			(permissionScope.actorId !== reservation.id ||
				permissionScope.parentId !== reservation.parentId ||
				permissionScope.actorKind !== (reservation.parentId === undefined ? "main" : "sub") ||
				(parentScope && !isScopeNoBroader(parentScope, permissionScope)))
		)
			throw new Error("Permission scope does not match the reserved actor and live parent authority.");
		const settingsSnapshot: SubagentChainSettings | undefined = options.settings?.snapshot();
		const rootThresholds = (options.settings as SubagentChainSettings | undefined)?.[kRootCompactionThresholds];
		if (settingsSnapshot && rootThresholds) {
			settingsSnapshot[kRootCompactionThresholds] = Object.freeze({
				thresholdPercent: rootThresholds.thresholdPercent,
				thresholdTokens: rootThresholds.thresholdTokens,
				modelThresholdsEnabled: rootThresholds.modelThresholdsEnabled,
			});
		}
		const requestedOptions: CreateAgentSessionOptions = settingsSnapshot
			? { ...options, settings: settingsSnapshot }
			: options;
		const { getApiKey, mcpManager, credentialSourceSessionId, telemetry, ...authorityOptions } = requestedOptions;
		// Tracers are live service handles, including plain-object implementations.
		// Copy/freeze their configuration metadata without cloning or freezing the service.
		const { tracer, ...telemetryMetadata } = telemetry ?? {};
		const frozenAuthorityData = cloneAndFreezeAuthorityInput({
			...authorityOptions,
			agentId: reservation.id,
			parentAgentId: requestedOptions.parentAgentId ?? reservation.parentId,
			parentTaskPrefix:
				reservation.parentId === undefined
					? requestedOptions.parentTaskPrefix
					: (requestedOptions.parentTaskPrefix ?? reservation.id),
			agentRegistry: this,
			permissionScope,
		});
		let creationOptions = Object.freeze({
			...frozenAuthorityData,
			...(getApiKey === undefined ? {} : { getApiKey }),
			...(credentialSourceSessionId === undefined ? {} : { credentialSourceSessionId }),
			...(mcpManager === undefined ? {} : { mcpManager }),
			...(telemetry === undefined
				? {}
				: {
						telemetry: Object.freeze({
							...cloneAndFreezeAuthorityInput(telemetryMetadata),
							...(tracer === undefined ? {} : { tracer }),
						}),
					}),
		}) satisfies CreateAgentSessionOptions;
		const preparedOptions = Object.freeze({ agentDisplayName: creationOptions.agentDisplayName });
		copyBrowserAuditSessionCapability(options, creationOptions);
		if (deriveRestrictedStartupPolicy(creationOptions).restricted && !this.#durableState) {
			throw new Error("Restricted authority session startup requires a durable registry state store.");
		}
		const descriptor = canonicalAuthorityStartupDescriptor(creationOptions, reservation);
		const startupHash = canonicalDurableSha256(descriptor);
		const scopeHash = permissionScope ? freezePermissionScope(permissionScope).canonicalSha256 : undefined;
		const parentScopeHash = parentScope ? freezePermissionScope(parentScope).canonicalSha256 : undefined;
		const provenanceHash = canonicalDurableSha256(
			cloneCanonicalAuthorityMetadata(permissionScope?.provenance ?? { source: "unscoped" }),
		);
		const revival = this.#reservationRefs.has(reservation as object);
		if (revival && this.#durableState) {
			const actorRow = await this.#durableState.getActor(reservation.id);
			const recovered = actorRow?.record;
			if (
				!recovered ||
				recovered.rootId !== reservation.rootId ||
				recovered.parentId !== reservation.parentId ||
				recovered.generation !== reservation.generation ||
				recovered.startupHash !== startupHash ||
				recovered.provenanceHash !== provenanceHash ||
				recovered.scopeHash !== scopeHash ||
				recovered.parentScopeHash !== parentScopeHash ||
				!(await this.#durableState.validateRevival({
					actorId: reservation.id,
					rootId: reservation.rootId,
					...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
					generation: reservation.generation,
					...(scopeHash === undefined ? {} : { scopeHash }),
				}))
			)
				throw new Error("Persisted authority identity does not match the recovered durable actor.");
		}
		const durableConstruction = {
			kind: "construction" as const,
			actorId: reservation.id,
			rootId: reservation.rootId,
			...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
			generation: reservation.generation,
			startupHash,
			provenanceHash,
			...(scopeHash === undefined ? {} : { scopeHash }),
			...(parentScopeHash === undefined ? {} : { parentScopeHash }),
		};
		if (!revival && this.#durableState) {
			await this.#durableState.transition({ ...durableConstruction, at: Date.now(), phase: "reserved" });
			if (parentAuthority && !this.#isCurrentParentAuthority(parentAuthority)) {
				await this.#durableState.transition({ ...durableConstruction, at: Date.now(), phase: "abandoned" });
				throw new Error("Parent session authority changed while reserving child construction.");
			}
		}
		let state: "staged" | "creating" | "created" | "active" | "abandoned" = "staged";
		let createdSession: AgentSession | undefined;
		const isCurrent = (session: AgentSession): boolean => {
			if (createdSession !== session) return false;
			if (
				this.#isTerminatingLineage(reservation.rootId) ||
				(reservation.parentId && this.#isTerminatingLineage(reservation.parentId, reservation.rootId))
			)
				return false;
			if (parentAuthority && !this.#isCurrentParentAuthority(parentAuthority)) return false;
			if (session.isDisposed) return false;
			if (state === "created" || state === "active") {
				if (
					this.#reservations.get(reservation as object) === reservation &&
					this.#claimedIds.get(reservation.id) === reservation
				)
					return true;
				if (state !== "active") return false;
				const ref = this.#refs.get(reservation.id);
				return (
					ref?.session === session &&
					this.#sessionCapabilities.get(session) === reservation.capability &&
					this.#refCapabilities.get(ref) === reservation.capability
				);
			}
			return false;
		};
		const prepared: PreparedAgentAuthoritySession = Object.freeze({
			reservation,
			descriptor,
			options: preparedOptions,
			startupHash,
			provenanceHash,
			...(scopeHash === undefined ? {} : { scopeHash }),
			...(parentScopeHash === undefined ? {} : { parentScopeHash }),
			revival,
			create: async (): Promise<CreateAgentSessionResult> => {
				if (state !== "staged") throw new Error("Agent authority construction capability was already consumed.");
				state = "creating";
				let constructed: CreateAgentSessionResult | undefined;
				try {
					if (!revival && this.#durableState) {
						await this.#durableState.transition({
							...durableConstruction,
							at: Date.now(),
							phase: "constructing",
						});
						if (parentAuthority && !this.#isCurrentParentAuthority(parentAuthority))
							throw new Error("Parent session authority changed while child construction was being admitted.");
					}
					const optionsForCreation = creationOptions;
					creationOptions = Object.freeze({ ...creationOptions, settings: undefined });
					const sdk = (sdkModule ??= await import("../sdk"));
					constructed = await sdk.createAgentSession(optionsForCreation);
					if (parentAuthority && !this.#isCurrentParentAuthority(parentAuthority))
						throw new Error("Parent session authority changed during child creation.");
					const currentParentScope = parentSession?.getPermissionScope?.();
					if (
						(parentScope && !currentParentScope) ||
						(currentParentScope &&
							(!creationOptions.permissionScope ||
								!isScopeNoBroader(currentParentScope, creationOptions.permissionScope)))
					)
						throw new Error("Parent permission scope changed during child creation.");
					const constructedSession = constructed.session;
					const sessionFile = authoritySessionFile(constructedSession);
					if (descriptor.sessionFile !== null && descriptor.sessionFile !== sessionFile)
						throw new Error("Authority session file changed during construction.");
					createdSession = constructedSession;
					if (!revival && this.#durableState) {
						await this.#durableState.transition({ ...durableConstruction, at: Date.now(), phase: "constructed" });
						if (parentAuthority && !this.#isCurrentParentAuthority(parentAuthority))
							throw new Error("Parent session authority changed before child construction was recorded.");
					}
					state = "created";
					const operationAuthority = issueBoundSessionOperationAuthority(
						{
							capability: reservation.capability,
							actorId: reservation.id,
							rootId: reservation.rootId,
							generation: reservation.generation,
							sessionFile,
							validate: () => isCurrent(constructedSession),
						},
						constructedSession.sessionManager,
					);
					this.#operationSessionAuthorities.set(constructedSession, operationAuthority);
					if (this.#durableState)
						bindSessionOperationDurability(constructedSession.sessionManager, this.#durableState);
					await bindSessionOperationAuthority(constructedSession.sessionManager, operationAuthority);
					if (!isCurrent(constructedSession))
						throw new Error("Authority construction changed while its session operations were being bound.");
					return constructed;
				} catch (error) {
					state = "abandoned";
					const cleanupErrors: unknown[] = [];
					if (!revival && this.#durableState) {
						try {
							await this.#durableState.transition({
								...durableConstruction,
								at: Date.now(),
								phase: "abandoned",
							});
						} catch (cleanupError) {
							cleanupErrors.push(cleanupError);
						}
					}
					if (constructed) {
						try {
							await constructed.session.dispose();
						} catch (cleanupError) {
							cleanupErrors.push(cleanupError);
						}
					}
					if (cleanupErrors.length > 0) throw new AgentAuthorityCleanupError(error, cleanupErrors);
					throw error;
				}
			},
			activate: async (session: AgentSession): Promise<void> => {
				if (state !== "created" || createdSession !== session)
					throw new Error("Authority construction cannot activate another session.");
				state = "active";
			},
			abandon: async (): Promise<void> => {
				if (state !== "active" && state !== "abandoned") {
					state = "abandoned";
					if (!revival && this.#durableState)
						await this.#durableState.transition({ ...durableConstruction, at: Date.now(), phase: "abandoned" });
				}
			},
			isCurrent,
		});
		return prepared;
	}
	async #stageDurableActivation(
		prepared: PreparedAgentAuthoritySession,
		activationAttempt?: DurableActivationAttempt,
	): Promise<DurableActorRecord | undefined> {
		const store = this.#durableState;
		if (!store) return undefined;
		const reservation = prepared.reservation;
		const actorRow = await store.getActor(reservation.id);
		const constructionRow = await store.getConstruction(reservation.rootId, reservation.id, reservation.generation);
		let actor: DurableActorRecord;
		let root: DurableRootRecord | undefined;
		let gate: DurableGateRecord | undefined;
		let head: { generation: number; headHash: string } | undefined;
		let restartedRootTransition: DurableRootTransitionAttempt | undefined;
		if (prepared.revival) {
			const recovered = actorRow?.record;
			if (
				!recovered ||
				recovered.rootId !== reservation.rootId ||
				recovered.parentId !== reservation.parentId ||
				recovered.generation !== reservation.generation ||
				recovered.startupHash !== prepared.startupHash ||
				recovered.provenanceHash !== prepared.provenanceHash ||
				recovered.scopeHash !== prepared.scopeHash ||
				recovered.parentScopeHash !== prepared.parentScopeHash ||
				!(await store.validateRevival({
					actorId: reservation.id,
					rootId: reservation.rootId,
					...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
					generation: reservation.generation,
					...(prepared.scopeHash === undefined ? {} : { scopeHash: prepared.scopeHash }),
				}))
			)
				throw new Error("Recovered durable actor changed before revival activation.");
			actor = Object.freeze({ ...recovered, at: Date.now(), state: "active" });
			if (!constructionRow?.record)
				throw new Error("Recovered durable construction is missing before revival activation.");
			if (reservation.parentId === undefined) {
				const gateRow = await store.getGate(reservation.rootId);
				const currentGate = gateRow?.record;
				if (
					!currentGate ||
					currentGate.rootId !== reservation.rootId ||
					currentGate.generation !== reservation.generation ||
					currentGate.phase !== "closed"
				)
					throw new Error("Recovered durable root revival requires its exact closed gate.");
				gate = { ...currentGate, at: Date.now(), phase: "open" };
			}
		} else {
			if (reservation.parentId === undefined) {
				const headHash = durableRootHeadHash({
					rootId: reservation.rootId,
					generation: reservation.generation,
					actorId: reservation.id,
					startupHash: prepared.startupHash,
					provenanceHash: prepared.provenanceHash,
				});
				const rootRow = await store.getRoot(reservation.rootId);
				const currentRoot = rootRow?.record;
				if (currentRoot?.state === "active") {
					if (currentRoot.generation !== reservation.generation || currentRoot.headHash !== headHash) {
						const previousActor = actorRow?.record;
						if (
							this.#refs.has(reservation.id) ||
							!previousActor ||
							previousActor.parentId !== undefined ||
							previousActor.rootId !== reservation.rootId ||
							previousActor.generation !== currentRoot.generation ||
							previousActor.rootGeneration !== currentRoot.generation ||
							previousActor.rootHeadHash !== currentRoot.headHash ||
							(previousActor.state !== "retired" && previousActor.state !== "aborted") ||
							reservation.generation <= currentRoot.generation
						)
							throw new Error("Durable root changed before authority activation.");
						const recovery = await store.recoveryState();
						if ([...recovery.actors.values()].some(candidate => candidate.rootId === reservation.rootId))
							throw new Error("Retained root still has unresolved descendant authority.");
						const sourceGate = (await store.getGate(reservation.rootId))?.record;
						if (
							!sourceGate ||
							sourceGate.generation !== currentRoot.generation ||
							(sourceGate.phase !== "open" && sourceGate.phase !== "closed")
						)
							throw new Error(
								"Retained root gate does not match its open or recovered closed source generation.",
							);
						const transition = {
							kind: "transition" as const,
							transitionId: `root-reopen:${reservation.id}:${currentRoot.generation}:${reservation.generation}`,
							rootId: reservation.rootId,
							sourceGeneration: currentRoot.generation,
							destinationGeneration: reservation.generation,
							sourceHeadHash: currentRoot.headHash,
							destinationHeadHash: headHash,
						};
						restartedRootTransition = {
							transition,
							sourceRoot: currentRoot,
							sourceGate,
							phase: undefined,
							casAttempted: false,
							casCommitted: false,
						};
						if (activationAttempt) activationAttempt.rootTransition = restartedRootTransition;
						await store.transition({ ...transition, at: Date.now(), phase: "staged" });
						restartedRootTransition.phase = "staged";
						await store.transitionBatch([
							{ ...transition, at: Date.now(), phase: "quiescing" },
							{ ...sourceGate, at: Date.now(), phase: "quiescing" },
						]);
						restartedRootTransition.phase = "quiescing";
						// The recovered terminal tree has no live source sessions to drain.
						await store.transitionBatch([
							{ ...transition, at: Date.now(), phase: "quiesced" },
							{ ...sourceGate, at: Date.now(), phase: "quiesced" },
						]);
						restartedRootTransition.phase = "quiesced";
						await store.transition({ ...transition, at: Date.now(), phase: "validated" });
						restartedRootTransition.phase = "validated";
						restartedRootTransition.casAttempted = true;
						await store.commitRootTransition({
							transition: { ...transition, at: Date.now(), phase: "cas-committed" },
							expectedRootGeneration: currentRoot.generation,
							expectedRootHeadHash: currentRoot.headHash,
							root: { ...currentRoot, at: Date.now(), generation: reservation.generation, headHash },
							gate: { ...sourceGate, at: Date.now(), phase: "closed" },
						});
						restartedRootTransition.casCommitted = true;
						restartedRootTransition.phase = "cas-committed";
						this.#durableRootHeads.set(reservation.rootId, { generation: reservation.generation, headHash });
					}
					head = { generation: reservation.generation, headHash };
				} else {
					head = { generation: reservation.generation, headHash };
					root = {
						kind: "root",
						at: Date.now(),
						rootId: reservation.rootId,
						generation: reservation.generation,
						headHash,
						state: "active",
					};
				}
				gate = {
					kind: "gate",
					at: Date.now(),
					rootId: reservation.rootId,
					generation: reservation.generation,
					phase: "open",
				};
			} else {
				const rootRow = await store.getRoot(reservation.rootId);
				const gateRow = await store.getGate(reservation.rootId);
				const currentRoot = rootRow?.record;
				const currentGate = gateRow?.record;
				if (
					!currentRoot ||
					currentRoot.state !== "active" ||
					!currentGate ||
					currentGate.phase !== "open" ||
					currentGate.generation !== currentRoot.generation
				)
					throw new Error("Durable child authority requires an exact active root and open gate.");
				head = { generation: currentRoot.generation, headHash: currentRoot.headHash };
			}
			if (!head) throw new Error("Durable child authority requires an exact current root record.");
			actor = Object.freeze({
				kind: "actor",
				at: Date.now(),
				actorId: reservation.id,
				rootId: reservation.rootId,
				...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
				generation: reservation.generation,
				rootGeneration: head.generation,
				rootHeadHash: head.headHash,
				startupHash: prepared.startupHash,
				provenanceHash: prepared.provenanceHash,
				...(prepared.scopeHash === undefined ? {} : { scopeHash: prepared.scopeHash }),
				...(prepared.parentScopeHash === undefined ? {} : { parentScopeHash: prepared.parentScopeHash }),
				state: "active",
			});
		}
		const construction: DurableConstructionRecord = {
			kind: "construction",
			at: Date.now(),
			actorId: reservation.id,
			rootId: reservation.rootId,
			...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
			generation: reservation.generation,
			startupHash: prepared.startupHash,
			provenanceHash: prepared.provenanceHash,
			...(prepared.scopeHash === undefined ? {} : { scopeHash: prepared.scopeHash }),
			...(prepared.parentScopeHash === undefined ? {} : { parentScopeHash: prepared.parentScopeHash }),
			phase: "activated",
		};
		const activation: AuthorityActivation = {
			actor,
			construction,
			...(root ? { root } : {}),
			...(gate ? { gate } : {}),
		};
		await store.activateAuthority(activation);
		if (restartedRootTransition) {
			await store.transition({ ...restartedRootTransition.transition, at: Date.now(), phase: "activated" });
			restartedRootTransition.phase = "activated";
			await store.transition({ ...restartedRootTransition.transition, at: Date.now(), phase: "retired" });
			restartedRootTransition.phase = "retired";
		}
		if (root) this.#durableRootHeads.set(root.rootId, { generation: root.generation, headHash: root.headHash });
		return actor;
	}

	async #canRecoverRootTransition(store: AuthorityStore, attempt: DurableRootTransitionAttempt): Promise<boolean> {
		if (attempt.casCommitted) return false;
		if (!attempt.casAttempted) return true;
		const [rootRow, transitionRow] = await Promise.all([
			store.getRoot(attempt.transition.rootId),
			store.getTransition(attempt.transition.rootId, attempt.transition.transitionId),
		]);
		const root = rootRow?.record;
		const transition = transitionRow?.record;
		return Boolean(
			root?.state === "active" &&
			root.generation === attempt.sourceRoot.generation &&
			root.headHash === attempt.sourceRoot.headHash &&
			transition &&
			transition.transitionId === attempt.transition.transitionId &&
			transition.sourceGeneration === attempt.transition.sourceGeneration &&
			transition.destinationGeneration === attempt.transition.destinationGeneration &&
			transition.sourceHeadHash === attempt.transition.sourceHeadHash &&
			transition.destinationHeadHash === attempt.transition.destinationHeadHash &&
			(transition.phase === "staged" ||
				transition.phase === "quiescing" ||
				transition.phase === "quiesced" ||
				transition.phase === "validated"),
		);
	}

	async #recoverRootTransition(store: AuthorityStore, attempt: DurableRootTransitionAttempt): Promise<void> {
		const transition = (await store.getTransition(attempt.transition.rootId, attempt.transition.transitionId))
			?.record;
		if (!transition) {
			if (attempt.phase !== undefined) throw new Error("Staged root transition is missing before durable recovery.");
			return;
		}
		const gate = (await store.getGate(attempt.transition.rootId))?.record;
		if (transition.phase === "staged" && (gate?.phase === "open" || gate?.phase === "closed")) {
			await store.transitionBatch([
				{ ...attempt.transition, at: Date.now(), phase: "quiescing" },
				{ ...gate, at: Date.now(), phase: "quiescing" },
			]);
		}
		const recovery: RootTransitionCommit = {
			transition: { ...attempt.transition, at: Date.now(), phase: "recovered", recovery: true },
			expectedRootGeneration: attempt.sourceRoot.generation,
			expectedRootHeadHash: attempt.sourceRoot.headHash,
			root: attempt.sourceRoot,
			// Only the named recovery command may reopen the exact retained source generation.
			gate: { ...attempt.sourceGate, phase: "open" },
		};
		await store.commitRootTransition(recovery);
		attempt.phase = "recovered";
	}

	#finishDurableActivation(ref: RegistryAgentRef, actor: DurableActorRecord | undefined): void {
		if (actor) this.#durableActorRecords.set(ref, actor);
	}
	async #retireDurableActor(actor: DurableActorRecord | undefined): Promise<void> {
		if (!actor || !this.#durableState) return;
		const row = await this.#durableState.getActor(actor.actorId);
		if (!row || row.record.generation !== actor.generation || row.record.state !== "active") return;
		await this.#durableState.transition(
			{ ...row.record, at: Date.now(), state: "retired" },
			{ expected: [{ domain: "actor", key: [actor.actorId], version: row.version }] },
		);
	}

	#installAuthoritySessionDisposal(ref: RegistryAgentRef, session: AgentSession): void {
		const originalDispose = session.dispose.bind(session);
		this.#rawSessionDisposals.set(session, originalDispose);
		let disposePromise: Promise<void> | undefined;
		session.dispose = disposeOptions => {
			if (disposePromise) return disposePromise;
			const current = this.#refs.get(ref.id);
			disposePromise = (async () => {
				if (
					current === ref &&
					current.session === session &&
					current.status !== "parked" &&
					current.status !== "aborted"
				) {
					const removed = await this.#removeExactRef(ref, disposeOptions);
					if (removed) return;
					const latest = this.#refs.get(ref.id);
					if (
						latest === ref &&
						latest.session === session &&
						latest.status !== "parked" &&
						latest.status !== "aborted"
					)
						throw new Error(`Agent "${ref.id}" could not be retired before its session was disposed.`);
				}
				const drain = this.#sessionRunStateDrains.get(session);
				if (drain) await drain();
				await originalDispose(disposeOptions);
			})();
			void disposePromise.then(
				() => {},
				() => {
					disposePromise = undefined;
				},
			);
			return disposePromise;
		};
	}

	async #commitPreparedSession(
		prepared: PreparedAgentAuthoritySession,
		created: CreateAgentSessionResult,
		activationAttempt: DurableActivationAttempt,
	): Promise<RegistryAgentRef> {
		if (!prepared.isCurrent(created.session)) throw new Error("Authority construction changed before commit.");
		const reservation = prepared.reservation;
		const sessionFile = authoritySessionFile(created.session);
		const durableActor = await this.#stageDurableActivation(prepared, activationAttempt);
		if (!prepared.isCurrent(created.session)) {
			await this.#retireDurableActor(durableActor);
			throw new Error("Authority construction changed while activation was being persisted.");
		}
		await prepared.activate(created.session);
		if (!prepared.isCurrent(created.session)) {
			await this.#retireDurableActor(durableActor);
			throw new Error("Authority construction changed before registry projection.");
		}
		const ref = this.#claimReserved(reservation, {
			id: reservation.id,
			displayName: prepared.options.agentDisplayName ?? (reservation.parentId === undefined ? "main" : "sub"),
			kind: reservation.parentId === undefined ? "main" : "sub",
			parentId: reservation.parentId,
			session: created.session,
			sessionFile,
			status: "running",
		});
		this.#sessionCapabilities.set(created.session, reservation.capability);
		this.#refCapabilities.set(ref, reservation.capability);
		this.#ownershipTokens.set(ref, Object.freeze({}) as InternalAgentOwnershipToken);
		this.#finishDurableActivation(ref, durableActor);
		if (!bindAgentSessionRegistry(this, created.session)) {
			await this.#removeExactRef(ref);
			throw new Error("IRC parent classification requires an exact active authority session.");
		}
		if (reservation.parentId === undefined && !bindOwnedAgentLifecycle(this, created.session)) {
			await this.#removeExactRef(ref);
			throw new Error("Root lifecycle ownership requires an exact claimed authority session.");
		}
		this.#installAuthoritySessionDisposal(ref, created.session);
		return ref;
	}

	async #createReservedSession(
		reservation: AgentReservation,
		options: CreateAgentSessionOptions,
		parentAuthority?: { ref: RegistryAgentRef; session: AgentSession; capability: AgentCapability },
	): Promise<CreateAgentSessionResult> {
		const create = async (): Promise<CreateAgentSessionResult> => {
			let prepared: PreparedAgentAuthoritySession | undefined;
			let created: CreateAgentSessionResult | undefined;
			const activationAttempt: DurableActivationAttempt = {};
			try {
				prepared = await this.#prepareAuthoritySession(reservation, options, parentAuthority);
				created = await prepared.create();
				await this.#commitPreparedSession(prepared, created, activationAttempt);
				return created;
			} catch (error) {
				const rootTransition = activationAttempt.rootTransition;
				if (rootTransition && this.#durableState) {
					let recoverBeforeCas: boolean;
					try {
						recoverBeforeCas = await this.#canRecoverRootTransition(this.#durableState, rootTransition);
					} catch (inspectionError) {
						throw new AggregateError(
							[error, inspectionError],
							"Root admission CAS disposition is uncertain; the candidate remains live behind the closed fence.",
						);
					}
					if (!recoverBeforeCas) throw error;
				}
				const cleanupErrors: unknown[] = [];
				if (error instanceof AgentAuthorityCleanupError) cleanupErrors.push(error);
				if (prepared) {
					try {
						await prepared.abandon();
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				this.#abandonReservation(reservation);
				if (created) {
					try {
						await created.session.dispose();
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				if (cleanupErrors.length > 0) throw new AgentAuthorityCleanupError(error, cleanupErrors);
				if (rootTransition && this.#durableState) {
					try {
						await this.#recoverRootTransition(this.#durableState, rootTransition);
					} catch (recoveryError) {
						throw new AggregateError(
							[error, recoveryError],
							"Root admission failed and durable recovery did not complete.",
						);
					}
				}
				throw error;
			}
		};
		const operation = create();
		return parentAuthority ? this.#trackRootOperation(reservation.rootId, parentAuthority.ref, operation) : operation;
	}

	async #commitRootReplacement(
		prepared: PreparedAgentAuthoritySession,
		created: CreateAgentSessionResult,
		expected: RegistryAgentRef,
	): Promise<RegistryAgentRef> {
		const reservation = prepared.reservation;
		if (
			!prepared.isCurrent(created.session) ||
			this.#refs.get(expected.id) !== expected ||
			reservation.id !== expected.id ||
			reservation.parentId !== undefined ||
			this.#claimedIds.get(reservation.id) !== reservation ||
			this.#reservations.get(reservation as object) !== reservation
		)
			throw new Error("Root authority changed before replacement commit.");
		const durableActor = await this.#stageDurableActivation(prepared);
		if (
			!prepared.isCurrent(created.session) ||
			this.#refs.get(expected.id) !== expected ||
			this.#claimedIds.get(reservation.id) !== reservation ||
			this.#reservations.get(reservation as object) !== reservation
		)
			throw new Error("Root authority changed while replacement activation was being persisted.");
		await prepared.activate(created.session);
		if (
			!prepared.isCurrent(created.session) ||
			this.#refs.get(expected.id) !== expected ||
			this.#claimedIds.get(reservation.id) !== reservation ||
			this.#reservations.get(reservation as object) !== reservation
		)
			throw new Error("Root authority changed before replacement projection.");
		const now = Date.now();
		const replacement: RegistryAgentRef = {
			id: reservation.id,
			displayName: prepared.options.agentDisplayName ?? "main",
			kind: "main",
			status: "running",
			session: created.session,
			sessionFile: authoritySessionFile(created.session),
			createdAt: now,
			lastActivity: now,
			lineage: Object.freeze({ rootId: reservation.rootId, generation: reservation.generation }),
		};
		this.#refs.set(reservation.id, replacement);
		this.#reservations.delete(reservation as object);
		this.#claimedIds.delete(reservation.id);
		this.#authorityRefs.add(replacement);
		this.#sessionCapabilities.set(created.session, reservation.capability);
		this.#refCapabilities.set(replacement, reservation.capability);
		this.#ownershipTokens.set(replacement, Object.freeze({}) as InternalAgentOwnershipToken);
		this.#finishDurableActivation(replacement, durableActor);
		if (!bindAgentSessionRegistry(this, created.session)) {
			this.#refs.set(expected.id, expected);
			this.#sessionCapabilities.delete(created.session);
			this.#refCapabilities.delete(replacement);
			throw new Error("Replacement root IRC parent classification could not be activated.");
		}
		if (!replaceOwnedAgentLifecycle(this, expected.session!, created.session)) {
			this.#refs.set(expected.id, expected);
			this.#sessionCapabilities.delete(created.session);
			this.#refCapabilities.delete(replacement);
			throw new Error("Replacement root lifecycle ownership could not be activated.");
		}
		this.#installAuthoritySessionDisposal(replacement, created.session);
		this.#emit({ type: "removed", ref: expected });
		this.#emit({ type: "registered", ref: replacement });
		return replacement;
	}

	/** Create or replace one root authority session without ever leaving its root slot absent. */
	async #createRootSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
		if (options.agentReservation !== undefined || options.expectedAgentRef !== undefined) {
			throw new Error("Public agent reservation hints are assertions only and cannot claim session authority.");
		}
		const id = options.agentId ?? MAIN_AGENT_ID;
		const existing = this.#refs.get(id);
		if (!existing) {
			const recovered = this.#durableRecovery?.actors.get(id);
			const root = this.#durableRecovery?.roots.get(id);
			if (
				recovered &&
				recovered.rootId === id &&
				recovered.parentId === undefined &&
				(recovered.state === "active" || recovered.state === "parked") &&
				root?.state === "active" &&
				root.generation === recovered.rootGeneration &&
				root.headHash === recovered.rootHeadHash
			) {
				const sessionFile = options.sessionManager?.getSessionFile() ?? null;
				if (!sessionFile) throw new Error("Durable root revival requires an explicit persisted session manager.");
				const recoveredRef: RegistryAgentRef = {
					id,
					displayName: options.agentDisplayName ?? "main",
					kind: "main",
					status: "parked",
					session: null,
					sessionFile,
					createdAt: recovered.at,
					lastActivity: recovered.at,
					lineage: Object.freeze({ rootId: id, generation: recovered.generation }),
				};
				this.#refs.set(id, recoveredRef);
				this.#ownershipTokens.set(recoveredRef, Object.freeze({}) as InternalAgentOwnershipToken);
				this.#durableActorRecords.set(recoveredRef, recovered);
				try {
					return await this.#createReservedSession(this.#reserveRevival(recoveredRef), options);
				} catch (error) {
					if (this.#refs.get(id) === recoveredRef && recoveredRef.session === null) this.#refs.delete(id);
					throw error;
				}
			}
			if (this.#durableState) {
				// Check before reserving: the new candidate's own constructed row
				// will legitimately appear as unresolved until activation commits.
				const recovery = await this.#durableState.recoveryState();
				if (recovery.blocked.length > 0)
					throw new Error(`Root admission has unresolved authority: ${recovery.blocked.join("; ")}`);
				if (this.#refs.has(id)) throw new Error(`Agent "${id}" changed during root admission.`);
			}
			return this.#createReservedSession(this.#reserve(id, id, undefined), options);
		}
		if (existing.parentId !== undefined || existing.kind !== "main" || !existing.session) {
			throw new Error(`Agent "${id}" is already reserved.`);
		}
		const owner = existing.session;
		const ownerCapability = this.#sessionCapabilities.get(owner);
		const ownerRecord = ownerCapability ? this.#assertCapability(ownerCapability) : undefined;
		if (
			!ownerRecord ||
			ownerRecord.actorId !== id ||
			ownerRecord.rootId !== id ||
			ownerRecord.parentId !== undefined ||
			this.#refCapabilities.get(existing) !== ownerCapability
		)
			throw new Error(`Agent "${id}" is already reserved.`);

		const replacementGeneration = this.#nextGeneration++;
		const reservation = this.#reserve(id, id, undefined, replacementGeneration, true);
		let prepared: PreparedAgentAuthoritySession | undefined;
		let rootSource: DurableRootRecord | undefined;
		let sourceGate: DurableGateRecord | undefined;
		let replacement: CreateAgentSessionResult | undefined;
		let controller: MigrationFenceController | undefined;
		let fence: RootMigrationFence | undefined;
		let switched = false;
		let durableTransition: Omit<DurableTransitionRecord, "at" | "phase" | "recovery"> | undefined;
		let transitionAttempt: DurableRootTransitionAttempt | undefined;
		let resumeSourceLifecycleRevivalAdmission: (() => void) | undefined;
		const descendantFailures = this.#watchRootOperationFailures(id, existing);
		try {
			prepared = await this.#prepareAuthoritySession(reservation, options);
			if (this.#durableState) {
				const sourceRow = await this.#durableState.getRoot(id);
				rootSource = sourceRow?.record;
				if (!rootSource || rootSource.state !== "active" || rootSource.generation !== ownerRecord.generation)
					throw new Error("Root replacement source durable generation is missing or stale.");
				sourceGate = (await this.#durableState.getGate(id))?.record;
				if (
					!sourceGate ||
					sourceGate.rootId !== id ||
					sourceGate.generation !== rootSource.generation ||
					sourceGate.phase !== "open"
				)
					throw new Error("Root replacement source gate is missing or not open.");
				const destinationHeadHash = durableRootHeadHash({
					rootId: id,
					generation: replacementGeneration,
					actorId: id,
					startupHash: prepared.startupHash,
					provenanceHash: prepared.provenanceHash,
				});
				durableTransition = {
					kind: "transition",
					transitionId: `root-replacement:${id}:${ownerRecord.generation}:${replacementGeneration}`,
					rootId: id,
					sourceGeneration: ownerRecord.generation,
					destinationGeneration: replacementGeneration,
					sourceHeadHash: rootSource.headHash,
					destinationHeadHash,
				};
				transitionAttempt = {
					transition: durableTransition,
					sourceRoot: rootSource,
					sourceGate,
					phase: undefined,
					casAttempted: false,
					casCommitted: false,
				};
				await this.#durableState.transition({ ...durableTransition, at: Date.now(), phase: "staged" });
				transitionAttempt.phase = "staged";
			}
			replacement = await prepared.create();
			controller = new MigrationFenceController();
			fence = controller.open(id, `root-replacement:${id}:${ownerRecord.generation}:${replacementGeneration}`);
			const sourceLifecycle = lookupOwnedAgentLifecycle(owner);
			if (sourceLifecycle) {
				const revivalDrain = await quiesceOwnedAgentLifecycleForReplacement(sourceLifecycle);
				if (revivalDrain) {
					resumeSourceLifecycleRevivalAdmission = revivalDrain.resume;
					if (revivalDrain.failures.length > 0)
						throw new AggregateError(
							revivalDrain.failures,
							"Accepted agent revivals failed during root replacement.",
						);
				}
			}
			if (durableTransition && this.#durableState) {
				await this.#durableState.transitionBatch([
					{ ...durableTransition, at: Date.now(), phase: "quiescing" },
					{ kind: "gate", at: Date.now(), rootId: id, generation: ownerRecord.generation, phase: "quiescing" },
				]);
				if (transitionAttempt) transitionAttempt.phase = "quiescing";
				if (this.#refs.get(id) !== existing || existing.session !== owner)
					throw new Error("Root authority changed while replacement quiescing was being recorded.");
			}
			// Retain accepted parked sessions as physical owners through disposal; visible refs alone are insufficient.
			const quiescedSessions = new Set<AgentSession>();
			while (true) {
				const liveRootSessions = [
					...[...this.#refs.values()]
						.filter(ref => ref.lineage?.rootId === id && ref.session !== null)
						.map(ref => ref.session!),
					...[...this.#acceptedParks].filter(([, ref]) => ref.lineage?.rootId === id).map(([session]) => session),
				];
				const newlyObserved = [...new Set(liveRootSessions)].filter(session => !quiescedSessions.has(session));
				if (newlyObserved.length > 0) {
					fence = await controller.quiesce(
						fence,
						newlyObserved.map(session => session.sessionManager),
					);
					for (const session of newlyObserved) quiescedSessions.add(session);
				}
				await this.#drainRootOperations(id, existing, undefined, descendantFailures.failures);
				const unquiesced = [...this.#refs.values()].some(
					ref => ref.lineage?.rootId === id && ref.session !== null && !quiescedSessions.has(ref.session),
				);
				const acceptedOperations = (this.#pendingRootOperations.get(id)?.size ?? 0) > 0;
				if (!unquiesced && !acceptedOperations) {
					this.#sourceOperationFences.add(id);
					break;
				}
			}
			const retiringRefs = [...this.#refs.values()].filter(ref => ref.lineage?.rootId === id);
			// Old actors must retire while their current durable parents still
			// name the source head; destination publication cannot precede this.
			await this.#retireDescendants(existing, retiringRefs);
			if (durableTransition && this.#durableState) {
				await this.#durableState.transitionBatch([
					{ ...durableTransition, at: Date.now(), phase: "quiesced" },
					{ kind: "gate", at: Date.now(), rootId: id, generation: ownerRecord.generation, phase: "quiesced" },
				]);
				if (transitionAttempt) transitionAttempt.phase = "quiesced";
				if (this.#refs.get(id) !== existing || existing.session !== owner)
					throw new Error("Root authority changed while replacement quiescence was being recorded.");
			}
			fence = controller.validate(fence);
			controller.assertValidated(fence, id, owner.sessionManager);
			if (durableTransition && this.#durableState) {
				await this.#durableState.transition({ ...durableTransition, at: Date.now(), phase: "validated" });
				if (transitionAttempt) transitionAttempt.phase = "validated";
			}
			if (
				this.#refs.get(id) !== existing ||
				existing.session !== owner ||
				this.#sessionCapabilities.get(owner) !== ownerCapability ||
				this.#refCapabilities.get(existing) !== ownerCapability
			)
				throw new Error("Root authority changed before replacement compare-and-swap.");
			for (const claimed of this.#claimedIds.values()) {
				if (claimed !== reservation && claimed.rootId === id) this.#abandonReservation(claimed);
			}
			fence = controller.commit(fence);
			if (durableTransition && transitionAttempt && this.#durableState && rootSource) {
				transitionAttempt.casAttempted = true;
				await this.#durableState.commitRootTransition({
					transition: { ...durableTransition, at: Date.now(), phase: "cas-committed" },
					expectedRootGeneration: ownerRecord.generation,
					expectedRootHeadHash: rootSource.headHash,
					root: {
						kind: "root",
						at: Date.now(),
						rootId: id,
						generation: replacementGeneration,
						headHash: durableTransition.destinationHeadHash,
						state: "active",
					},
					gate: { kind: "gate", at: Date.now(), rootId: id, generation: ownerRecord.generation, phase: "closed" },
				});
				transitionAttempt.casCommitted = true;
				transitionAttempt.phase = "cas-committed";
				this.#durableRootHeads.set(id, {
					generation: replacementGeneration,
					headHash: durableTransition.destinationHeadHash,
				});
			}
			// Keep accepted lifecycle release callbacks post-CAS and settle them before replacing the in-memory root owner.
			const lifecycle = lookupOwnedAgentLifecycle(owner);
			const lifecycleDisposal = lifecycle ? disposeOwnedAgentLifecycle(lifecycle) : undefined;
			if (lifecycleDisposal) await lifecycleDisposal;
			await this.#drainRootOperations(id, existing);
			await this.#commitRootReplacement(prepared, replacement, existing);
			switched = true;
			await this.#drainRootOperations(id, existing);
			fence = controller.activate(fence);
			this.#sourceOperationFences.delete(id);
			if (durableTransition && this.#durableState)
				await this.#durableState.transition({ ...durableTransition, at: Date.now(), phase: "activated" });
			owner.beginDispose();
			await owner.dispose();
			if (durableTransition && this.#durableState)
				await this.#durableState.transition({ ...durableTransition, at: Date.now(), phase: "retired" });
			return replacement;
		} catch (error) {
			if (switched) this.#sourceOperationFences.delete(id);
			let recoverBeforeCas = !switched && !transitionAttempt?.casCommitted;
			if (recoverBeforeCas && transitionAttempt && this.#durableState) {
				try {
					recoverBeforeCas = await this.#canRecoverRootTransition(this.#durableState, transitionAttempt);
				} catch (inspectionError) {
					throw new AggregateError(
						[error, inspectionError],
						"Root replacement CAS disposition is uncertain; the candidate remains live behind the closed fence.",
					);
				}
			}
			if (!recoverBeforeCas) throw error;
			const cleanupErrors: unknown[] = [];
			if (prepared) {
				try {
					await prepared.abandon();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			this.#abandonReservation(reservation);
			if (replacement) {
				try {
					await replacement.session.dispose();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			if (cleanupErrors.length > 0)
				throw new AggregateError(
					[error, ...cleanupErrors],
					"Root replacement failed and candidate cleanup did not complete.",
				);
			if (transitionAttempt && this.#durableState) {
				try {
					await this.#recoverRootTransition(this.#durableState, transitionAttempt);
				} catch (recoveryError) {
					throw new AggregateError(
						[error, recoveryError],
						"Root replacement failed and durable recovery did not complete.",
					);
				}
			}
			if (controller && fence) {
				try {
					controller.recover(fence);
				} catch (recoveryError) {
					throw new AggregateError(
						[error, recoveryError],
						"Root replacement failed and its local fence did not recover.",
					);
				}
			}
			resumeSourceLifecycleRevivalAdmission?.();
			this.#sourceOperationFences.delete(id);
			throw error;
		} finally {
			descendantFailures.close();
		}
	}

	#lookupAuthoritySession(parent: AgentSession): RegistryAgentRef | undefined {
		const capability = this.#sessionCapabilities.get(parent);
		const record = capability ? this.#assertCapability(capability) : undefined;
		const parentRef = record ? this.#refs.get(record.actorId) : undefined;
		if (
			!capability ||
			!record ||
			!parentRef ||
			parentRef.session !== parent ||
			this.#refCapabilities.get(parentRef) !== capability ||
			parent.isDisposed ||
			(parentRef.status !== "running" && parentRef.status !== "idle")
		)
			return undefined;
		return parentRef;
	}
	#isCurrentAuthorityRefSession(ref: RegistryAgentRef, session: AgentSession): boolean {
		const capability = this.#sessionCapabilities.get(session);
		const record = capability ? this.#capabilities.get(capability as object) : undefined;
		return Boolean(
			capability &&
			record &&
			this.#refs.get(ref.id) === ref &&
			this.#authorityRefs.has(ref) &&
			ref.session === session &&
			this.#refCapabilities.get(ref) === capability &&
			record.actorId === ref.id &&
			record.rootId === ref.lineage?.rootId &&
			record.parentId === ref.lineage?.parentId &&
			record.generation === ref.lineage?.generation &&
			!session.isDisposed &&
			(ref.status === "running" || ref.status === "idle"),
		);
	}

	#isSessionParentIrcSender(session: AgentSession, recipientId: string, senderId: string): boolean {
		if (recipientId === senderId) return false;
		const recipientRef = this.#refs.get(recipientId);
		const recipientLineage = recipientRef?.lineage;
		if (
			!recipientRef ||
			!recipientLineage ||
			recipientRef.kind !== "sub" ||
			recipientRef.parentId !== senderId ||
			recipientLineage.parentId !== senderId ||
			!this.#isCurrentAuthorityRefSession(recipientRef, session)
		)
			return false;

		const parentRef = this.#refs.get(senderId);
		const parentSession = parentRef?.session;
		if (
			!parentRef ||
			!parentSession ||
			parentRef.kind === "advisor" ||
			parentRef.lineage?.rootId !== recipientLineage.rootId ||
			!this.#isCurrentAuthorityRefSession(parentRef, parentSession)
		)
			return false;

		const rootRef = this.#refs.get(recipientLineage.rootId);
		const rootSession = rootRef?.session;
		return Boolean(
			rootRef &&
			rootSession &&
			rootRef.id === recipientLineage.rootId &&
			rootRef.kind === "main" &&
			rootRef.parentId === undefined &&
			rootRef.lineage?.rootId === rootRef.id &&
			parentRef.lineage?.rootId === rootRef.id &&
			this.#isCurrentAuthorityRefSession(rootRef, rootSession),
		);
	}

	/** True when this exact registered session receives a message from one of its current descendants. */
	isSessionDescendantIrcSender(session: AgentSession, recipientId: string, senderId: string): boolean {
		if (recipientId === senderId) return false;
		const recipientRef = this.#lookupAuthoritySession(session);
		const rootId = recipientRef?.lineage?.rootId;
		const rootRef = rootId ? this.#refs.get(rootId) : undefined;
		const senderRef = this.#refs.get(senderId);
		// A settled descendant may already be idle or parked; its current authority ref proves origin.
		if (
			!recipientRef ||
			recipientRef.id !== recipientId ||
			!this.#authorityRefs.has(recipientRef) ||
			recipientRef.lineage?.parentId !== recipientRef.parentId ||
			!rootId ||
			!rootRef ||
			rootRef.id !== rootId ||
			rootRef.kind !== "main" ||
			rootRef.parentId !== undefined ||
			rootRef.lineage?.rootId !== rootId ||
			rootRef.lineage?.parentId !== undefined ||
			!this.#authorityRefs.has(rootRef) ||
			!senderRef ||
			!this.#authorityRefs.has(senderRef) ||
			senderRef.kind !== "sub" ||
			senderRef.parentId === undefined ||
			senderRef.lineage?.rootId !== rootId ||
			senderRef.lineage?.parentId !== senderRef.parentId
		)
			return false;
		let remaining = this.#refs.size;
		let parentId: string | undefined = senderRef.parentId;
		while (parentId !== undefined && remaining-- > 0) {
			if (parentId === recipientId) return true;
			const parentRef = this.#refs.get(parentId);
			if (
				!parentRef ||
				!this.#authorityRefs.has(parentRef) ||
				parentRef.kind === "advisor" ||
				parentRef.lineage?.rootId !== rootId ||
				parentRef.lineage?.parentId !== parentRef.parentId
			)
				return false;
			parentId = parentRef.parentId;
		}
		return false;
	}

	/** True only for the exact capability-bound subagent session in this registry. */
	isSessionSubagent(session: AgentSession, recipientId: string): boolean {
		const recipientRef = this.#lookupAuthoritySession(session);
		const lineage = recipientRef?.lineage;
		const rootRef = lineage ? this.#refs.get(lineage.rootId) : undefined;
		const parentRef = recipientRef?.parentId ? this.#refs.get(recipientRef.parentId) : undefined;
		return Boolean(
			recipientRef &&
			recipientRef.id === recipientId &&
			recipientRef.kind === "sub" &&
			this.#authorityRefs.has(recipientRef) &&
			lineage &&
			lineage.parentId === recipientRef.parentId &&
			parentRef &&
			this.#authorityRefs.has(parentRef) &&
			parentRef.kind !== "advisor" &&
			parentRef.lineage?.rootId === lineage.rootId &&
			parentRef.lineage?.parentId === parentRef.parentId &&
			rootRef &&
			rootRef.id === lineage.rootId &&
			rootRef.kind === "main" &&
			rootRef.parentId === undefined &&
			rootRef.lineage?.rootId === lineage.rootId &&
			rootRef.lineage?.parentId === undefined &&
			this.#authorityRefs.has(rootRef),
		);
	}

	#lookupAuthorityLineage(parentId: string): { readonly rootId: string; readonly parentId: string } | undefined {
		const parentRef = this.#refs.get(parentId);
		if (
			!parentRef ||
			!this.#authorityRefs.has(parentRef) ||
			!parentRef.session ||
			this.#lookupAuthoritySession(parentRef.session) !== parentRef ||
			!parentRef.lineage
		)
			return undefined;
		return Object.freeze({ rootId: parentRef.lineage.rootId, parentId: parentRef.id });
	}

	#bindAuthoritySession(parent: AgentSession): AgentAuthoritySessionBinding | undefined {
		const parentRef = this.#lookupAuthoritySession(parent);
		if (!parentRef) return undefined;
		const capability = this.#sessionCapabilities.get(parent)!;
		const boundParentRef = parentRef;
		const boundCapability = capability;
		return Object.freeze({
			create: (options: CreateAgentSessionOptions & { agentId: string }, reviveObservation?: AgentRef) =>
				reviveObservation === undefined
					? this.#createChildSession(parent, boundParentRef, boundCapability, options)
					: this.#reviveSession(parent, boundParentRef, boundCapability, reviveObservation, options),
		});
	}
	#operationAuthority(parent: AgentSession): BoundSessionOperationAuthority | undefined {
		if (!this.#lookupAuthoritySession(parent)) return undefined;
		const authority = this.#operationSessionAuthorities.get(parent);
		if (!authority || !authority.validate()) return undefined;
		return authority;
	}

	/** Only the opaque module-internal binding may call this authority creator. */
	async #createChildSession(
		parent: AgentSession,
		boundParentRef: RegistryAgentRef,
		boundCapability: AgentCapability,
		options: CreateAgentSessionOptions & { agentId: string },
	): Promise<CreateAgentSessionResult> {
		const capability = this.#sessionCapabilities.get(parent);
		const record = capability ? this.#assertCapability(capability) : undefined;
		const parentRef = record ? this.#refs.get(record.actorId) : undefined;
		if (
			capability !== boundCapability ||
			!record ||
			parentRef !== boundParentRef ||
			parentRef?.session !== parent ||
			this.#refCapabilities.get(parentRef) !== capability ||
			parent.isDisposed ||
			(parentRef?.status !== "running" && parentRef?.status !== "idle")
		)
			throw new Error("Invalid live parent session authority.");
		if (options.agentReservation !== undefined || options.expectedAgentRef !== undefined) {
			throw new Error("Public agent reservation hints are assertions only and cannot claim session authority.");
		}
		return this.#createReservedSession(this.#reserve(options.agentId, record.rootId, record.actorId), options, {
			ref: parentRef,
			session: parent,
			capability,
		});
	}

	/** Only the opaque module-internal binding may revive a parked identity. */
	async #reviveSession(
		parent: AgentSession,
		boundParentRef: RegistryAgentRef,
		boundCapability: AgentCapability,
		observation: AgentRef,
		options: CreateAgentSessionOptions & { agentId: string },
	): Promise<CreateAgentSessionResult> {
		const ref = this.#observations.get(observation);
		const capability = this.#sessionCapabilities.get(parent);
		const record = capability ? this.#assertCapability(capability) : undefined;
		const parentRef = record ? this.#refs.get(record.actorId) : undefined;
		if (
			!ref ||
			!capability ||
			capability !== boundCapability ||
			!record ||
			parentRef !== boundParentRef ||
			parent.isDisposed ||
			parentRef?.session !== parent ||
			(parentRef?.status !== "running" && parentRef?.status !== "idle") ||
			ref.parentId !== record.actorId ||
			!ref.lineage ||
			ref.parentId !== ref.lineage.parentId ||
			ref.lineage.rootId !== record.rootId
		)
			throw new Error("Invalid live parent revival authority.");
		if (options.agentReservation !== undefined || options.expectedAgentRef !== undefined) {
			throw new Error("Public agent reservation hints are assertions only and cannot claim session authority.");
		}
		return this.#createReservedSession(this.#reserveRevival(ref), options, {
			ref: parentRef,
			session: parent,
			capability,
		});
	}

	#endTermination(expectedRef: RegistryAgentRef): void {
		if (this.#terminating.get(expectedRef.id) === expectedRef) this.#terminating.delete(expectedRef.id);
	}

	#rejectStatusUpdate(id: string, status: AgentStatus, reason: string): false {
		logger.debug("Agent registry status update rejected", { id, status, reason });
		return false;
	}

	#register(
		input: RegisterInput,
		finalLineage?: RegistryAgentRef["lineage"],
		emitRegisteredEvent = true,
	): RegistryAgentRef {
		const existing = this.#refs.get(input.id);
		const parent = input.parentId ? this.#refs.get(input.parentId) : undefined;
		const rootId = finalLineage?.rootId ?? parent?.lineage?.rootId ?? input.id;
		if (this.#terminating.has(input.id) || this.#isTerminatingLineage(input.parentId ?? input.id, rootId))
			throw new Error(`Agent "${input.id}" is being terminated.`);
		if (existing && this.#authorityRefs.has(existing)) throw new Error(`Agent "${input.id}" is already registered.`);
		if (this.#claimedIds.has(input.id))
			throw new Error(`Agent "${input.id}" is reserved for capability-bound creation.`);
		const now = Date.now();
		const recoveredActor =
			input.session === null && (input.status ?? "running") === "parked"
				? this.#durableRecovery?.actors.get(input.id)
				: undefined;
		const recoveredRoot = recoveredActor ? this.#durableRecovery?.roots.get(recoveredActor.rootId) : undefined;
		const recoveredLineage =
			recoveredActor &&
			(recoveredActor.state === "active" || recoveredActor.state === "parked") &&
			recoveredActor.parentId === input.parentId &&
			recoveredRoot?.state === "active" &&
			recoveredRoot.generation === recoveredActor.rootGeneration &&
			recoveredRoot.headHash === recoveredActor.rootHeadHash
				? Object.freeze({
						rootId: recoveredActor.rootId,
						parentId: recoveredActor.parentId,
						generation: recoveredActor.generation,
					})
				: undefined;
		const lineage =
			finalLineage ??
			recoveredLineage ??
			Object.freeze({
				rootId: parent?.lineage?.rootId ?? input.id,
				parentId: input.parentId,
				generation: this.#nextGeneration++,
			});
		const inputHistory = input.history;
		const permissionSummary = normalizeEffectivePermissionSummary(inputHistory?.permissionSummary);
		const ref: RegistryAgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: input.createdAt ?? now,
			lastActivity: input.lastActivity ?? now,
			activity: input.activity,
			history: inputHistory ? { ...inputHistory, permissionSummary } : undefined,
			lifecycle: input.lifecycle,
			lineage,
		};
		if (recoveredActor && recoveredLineage) this.#durableActorRecords.set(ref, recoveredActor);
		this.#ownershipTokens.set(ref, Object.freeze({}) as InternalAgentOwnershipToken);
		this.#refs.set(ref.id, ref);
		if (emitRegisteredEvent) this.#emit({ type: "registered", ref });
		return ref;
	}

	register(input: RegisterInput): AgentRef {
		return this.#observe(this.#register(input));
	}

	#registerIfAvailableInternal(input: RegisterInput, expected: RegistryAgentRef | null): RegistryAgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (this.#isTerminatingLineage(input.parentId ?? input.id, current?.lineage?.rootId)) return undefined;
		if (expected === null) return current ? undefined : this.#register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	#replaceIfAvailableInternal(input: RegisterInput, expected: RegistryAgentRef | null): RegistryAgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (this.#isTerminatingLineage(input.parentId ?? input.id, current?.lineage?.rootId)) return undefined;
		if (this.#claimedIds.has(input.id) || this.#terminating.has(input.id)) return undefined;
		if (expected === null) return current ? undefined : this.#register(input);
		if (current !== expected || current.session) return undefined;
		const revivableAbort = current.status === "aborted" && !this.#authorityRefs.has(current);
		if (current.status !== "parked" && !revivableAbort) return undefined;
		// Replace the slot before events so observers never see a transiently missing id.
		const replacement = this.#register(input, undefined, false);
		this.#emit({ type: "removed", ref: current });
		this.#emit({ type: "registered", ref: replacement });
		return replacement;
	}

	#mergeHistory(ref: RegistryAgentRef, history: AgentHistorySummary, expectedSessionFile?: string): true {
		const permissionSummary = normalizeEffectivePermissionSummary(history.permissionSummary);
		const definedHistory = Object.fromEntries(
			Object.entries({ ...history, permissionSummary }).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		// A complete transcript scan owns these attribution fields, including an explicit clear when no leaf is selected.
		if (Object.hasOwn(history, "resolvedModel")) definedHistory.resolvedModel = history.resolvedModel;
		if (Object.hasOwn(history, "resolvedModelIsFallback")) {
			definedHistory.resolvedModelIsFallback = history.resolvedModelIsFallback;
		}
		const previousDirectCost = ref.history?.directCost;
		const incomingDirectCost = definedHistory.directCost;
		// Both writes are cumulative snapshots of this exact transcript. A delayed
		// scan must not replace a newer park-time snapshot; unscoped updates retain
		// their normal last-write semantics.
		if (
			expectedSessionFile !== undefined &&
			typeof previousDirectCost === "number" &&
			Number.isFinite(previousDirectCost) &&
			previousDirectCost >= 0 &&
			typeof incomingDirectCost === "number" &&
			Number.isFinite(incomingDirectCost) &&
			incomingDirectCost >= 0
		) {
			definedHistory.directCost = Math.max(previousDirectCost, incomingDirectCost);
		}
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	#setHistoryInternal(
		expected: RegistryAgentRef | AgentSession,
		history: AgentHistorySummary,
		expectedSessionFile?: string,
	): boolean {
		const capability = this.#sessionCapabilities.get(expected as AgentSession);
		const actorId = capability ? this.#assertCapability(capability).actorId : (expected as RegistryAgentRef).id;
		if (typeof actorId !== "string") return false;
		const ref = this.#refs.get(actorId);
		if (!ref || !this.#matchesInternalExpected(ref, expected)) return false;
		if (expectedSessionFile !== undefined && ref.sessionFile !== expectedSessionFile) return false;
		return this.#mergeHistory(
			ref,
			history,
			expectedSessionFile ?? (capability ? (ref.sessionFile ?? undefined) : undefined),
		);
	}

	/** Publish display metadata only from the exact live authority session that owns the registry row. */
	setSessionPermissionSummary(session: AgentSession, summary: EffectivePermissionSummary): boolean {
		const permissionSummary = normalizeEffectivePermissionSummary(summary);
		return permissionSummary !== undefined && this.#setHistoryInternal(session, { permissionSummary });
	}

	/** Attach transcript-derived identity and telemetry to legacy/mirrored rows only. */
	setHistory(id: string, history: AgentHistorySummary, expectedSessionFile?: string): boolean {
		const ref = this.#refs.get(id);
		if (
			!ref ||
			this.#authorityRefs.has(ref) ||
			(expectedSessionFile !== undefined && ref.sessionFile !== expectedSessionFile)
		)
			return false;
		return this.#mergeHistory(ref, history, expectedSessionFile);
	}

	/** Merge history only when the frozen observation still names the exact current legacy row. */
	setHistoryExact(id: string, expectedObservation: AgentRef, history: AgentHistorySummary): boolean {
		const ref = this.#observations.get(expectedObservation);
		if (
			!ref ||
			ref.id !== id ||
			this.#refs.get(id) !== ref ||
			this.#authorityRefs.has(ref) ||
			this.#terminating.get(id) === ref
		)
			return false;
		return this.#mergeHistory(ref, history);
	}

	/** Atomically reconcile scalar host metadata on the exact legacy observation. */
	updateAgentMetadata(id: string, expectedObservation: AgentRef, metadata: AgentMetadataUpdate): boolean {
		const ref = this.#refs.get(id);
		if (
			!ref ||
			this.#authorityRefs.has(ref) ||
			this.#observations.get(expectedObservation) !== ref ||
			this.#terminating.get(id) === ref
		)
			return false;
		ref.displayName = metadata.displayName;
		ref.createdAt = metadata.createdAt;
		ref.lastActivity = metadata.lastActivity;
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	#serializeActorMutation<T>(ref: RegistryAgentRef, operation: () => Promise<T>): Promise<T> {
		const previous = this.#actorMutationTails.get(ref) ?? Promise.resolve();
		const current = previous.then(operation);
		this.#actorMutationTails.set(
			ref,
			current.then(
				() => {},
				() => {},
			),
		);
		return current;
	}

	async #persistDurableActorState(
		ref: RegistryAgentRef,
		state: DurableActorRecord["state"],
		stillCurrent: () => boolean,
	): Promise<DurableActorRecord | undefined> {
		const current = this.#durableActorRecords.get(ref);
		if (!current || !this.#durableState || !stillCurrent()) return undefined;
		const row = await this.#durableState.getActor(ref.id);
		if (
			!stillCurrent() ||
			!row ||
			row.record.generation !== current.generation ||
			row.record.state === "retired" ||
			(row.record.state === "aborted" && state !== "aborted" && state !== "retired")
		)
			return undefined;
		if (row.record.state === "aborted") {
			// Aborted is terminal in the authority: it refuses any later actor change, including a
			// repeated abort or retirement. The durable outcome is already settled, so adopt it.
			this.#durableActorRecords.set(ref, row.record);
			return row.record;
		}
		const next: DurableActorRecord = Object.freeze({ ...row.record, at: Date.now(), state });
		await this.#durableState.transition(next, {
			expected: [{ domain: "actor", key: [ref.id], version: row.version }],
		});
		if (!stillCurrent()) return undefined;
		this.#durableActorRecords.set(ref, next);
		return next;
	}

	async #setStatus(ref: RegistryAgentRef, status: AgentStatus, isExpectedCurrent: () => boolean): Promise<boolean> {
		if (status === "parked" && this.#authorityRefs.has(ref))
			return this.#rejectStatusUpdate(ref.id, status, "authority-park-requires-owned-transition");
		if ((status === "parked" || status === "aborted") && ref.session) {
			const drain = this.#sessionRunStateDrains.get(ref.session);
			if (drain) await drain();
		}
		return this.#serializeActorMutation(ref, async () => {
			const startingStatus = ref.status;
			const stillCurrent = () =>
				this.#refs.get(ref.id) === ref &&
				ref.status === startingStatus &&
				isExpectedCurrent() &&
				!this.#isTerminatingLineage(ref.id, ref.lineage?.rootId);
			if (!stillCurrent()) return false;
			if (startingStatus === "aborted")
				return status === "aborted" || this.#rejectStatusUpdate(ref.id, status, "aborted-is-terminal");
			if (startingStatus === status) return true;
			const leftRunning = startingStatus === "running";
			if (this.#durableActorRecords.has(ref)) {
				const durableState = status === "aborted" ? "aborted" : status === "parked" ? "parked" : "active";
				const updated = await this.#persistDurableActorState(ref, durableState, stillCurrent);
				if (!updated || !stillCurrent()) return false;
			}
			ref.status = status;
			if (status !== "running") ref.activity = undefined;
			ref.lastActivity = Date.now();
			if (status === "running") {
				ref.lifecycle = undefined;
			} else if (leftRunning) {
				ref.lifecycle = { ...ref.lifecycle, terminalAt: ref.lastActivity };
			}
			this.#emit({ type: "status_changed", ref });
			return true;
		});
	}

	/**
	 * Record a settled run's accepted result only for its exact owning session/ref.
	 * This remains internal so opaque public observations cannot mutate lifecycle
	 * milestones or terminalize a different actor generation.
	 */
	async #markResultAcceptedInternal(
		id: string,
		expected: RegistryAgentRef | AgentSession,
		responseAt?: number,
	): Promise<boolean> {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === "aborted" || !this.#matchesInternalExpected(ref, expected)) return false;
		if (
			ref.status === "running" &&
			ref.session?.isStreaming !== true &&
			!(await this.#setStatus(ref, "idle", () => this.#matchesInternalExpected(ref, expected)))
		)
			return false;
		if (this.#refs.get(id) !== ref || !this.#matchesInternalExpected(ref, expected)) return false;
		const now = Date.now();
		ref.lifecycle = { ...ref.lifecycle, responseAt: responseAt ?? now, acceptedAt: now };
		if (ref.status !== "idle") this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	/**
	 * Accepted-but-running refs: the run's final result was handed over but the
	 * ref never left `running`, and no turn is in flight. This is the lifecycle
	 * leak the `proc://` running-agents roster reports so the parent can cancel it
	 * instead of waiting on a run that already finished.
	 */
	staleAcceptedRuns(): AgentRef[] {
		return this.list().filter(
			ref => ref.status === "running" && ref.lifecycle?.acceptedAt !== undefined && !this.isRunning(ref),
		);
	}

	async #setStatusInternal(
		id: string,
		status: AgentStatus,
		expected: RegistryAgentRef | AgentSession,
	): Promise<boolean> {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (!this.#matchesInternalExpected(ref, expected))
			return this.#rejectStatusUpdate(id, status, "session-ownership-changed");
		return this.#setStatus(ref, status, () => this.#matchesInternalExpected(ref, expected));
	}

	async setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): Promise<boolean> {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (!this.#matchesPublicExpected(ref, expected))
			return this.#rejectStatusUpdate(id, status, "authority-managed-or-changed");
		return this.#setStatus(ref, status, () => this.#matchesPublicExpected(ref, expected));
	}

	/**
	 * Record a short activity gist only while its exact session/ref still owns
	 * this running generation. Activity is display-only and emits no event, so
	 * per-tool progress updates stay off the registry listener path. Every
	 * accepted heartbeat refreshes `lastActivity`, even when the gist is unchanged.
	 * The gist is normalized to one bounded line so model-derived intent text
	 * cannot break the roster or smuggle terminal escapes.
	 */
	#setActivityInternal(id: string, activity: string, expected: RegistryAgentRef | AgentSession): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesInternalExpected(ref, expected) || ref.status !== "running") return false;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity !== gist) ref.activity = gist;
		return true;
	}

	#attachSession(ref: RegistryAgentRef, session: AgentSession, sessionFile?: string | null): boolean {
		if (
			this.#failedSessionDisposals.has(ref) ||
			ref.status === "aborted" ||
			this.#isTerminatingLineage(ref.id, ref.lineage?.rootId)
		)
			return false;
		ref.session = session;
		if (sessionFile !== undefined) {
			if (ref.sessionFile !== sessionFile && ref.history?.directCost !== undefined) {
				ref.history = { ...ref.history, directCost: undefined };
			}
			ref.sessionFile = sessionFile;
		}
		ref.lastActivity = Date.now();
		bindAgentSessionRegistry(this, session);
		return true;
	}

	#attachSessionInternal(
		id: string,
		session: AgentSession,
		sessionFile: string | null | undefined,
		expected: RegistryAgentRef | AgentSession,
	): boolean {
		const ref = this.#refs.get(id);
		return Boolean(
			ref && this.#matchesInternalExpected(ref, expected) && this.#attachSession(ref, session, sessionFile),
		);
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesPublicExpected(ref, expected)) return false;
		return this.#attachSession(ref, session, sessionFile);
	}

	#detachSessionInternal(id: string, expected: RegistryAgentRef | AgentSession): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesInternalExpected(ref, expected) || this.#terminating.get(id) === ref) return false;
		ref.session = null;
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesPublicExpected(ref, expected) || this.#terminating.get(id) === ref) return false;
		ref.session = null;
		return true;
	}
	/** Settle descendants while this actor remains active, then persist park and own disposal. */
	async #transitionToParked(
		expectedRef: RegistryAgentRef,
		expectedSession: AgentSession,
		dispose?: () => Promise<void>,
		beforeDispose?: () => Promise<void>,
	): Promise<boolean> {
		const ref = this.#refs.get(expectedRef.id);
		const rootId = expectedRef.lineage?.rootId ?? expectedRef.id;
		if (
			ref !== expectedRef ||
			ref.status === "aborted" ||
			ref.session !== expectedSession ||
			!this.#matchesInternalExpected(ref, expectedSession) ||
			this.#terminating.has(ref.id) ||
			this.#isParkFencedByTermination(ref, rootId) ||
			this.#sourceOperationFences.has(rootId)
		)
			return false;
		this.#terminating.set(ref.id, ref);
		this.#acceptedParks.set(expectedSession, ref);
		let cleanupFailed = false;
		const operation: Promise<boolean> = Promise.resolve().then(async () => {
			try {
				if (
					this.#refs.get(ref.id) !== ref ||
					ref.session !== expectedSession ||
					!this.#matchesInternalExpected(ref, expectedSession)
				)
					return false;
				const drain = this.#sessionRunStateDrains.get(expectedSession);
				if (drain) await drain();
				await this.#drainRootOperations(rootId, ref, operation);
				await this.#retireDescendants(ref);
				const parked = await this.#serializeActorMutation(ref, async () => {
					const startingStatus = ref.status;
					const stillCurrent = () =>
						this.#refs.get(ref.id) === ref &&
						ref.status === startingStatus &&
						ref.status !== "aborted" &&
						ref.session === expectedSession &&
						this.#matchesInternalExpected(ref, expectedSession);
					if (!stillCurrent()) return false;
					if (this.#durableActorRecords.has(ref)) {
						const updated = await this.#persistDurableActorState(ref, "parked", stillCurrent);
						if (!updated || !stillCurrent()) return false;
					}
					ref.session = null;
					ref.status = "parked";
					ref.activity = undefined;
					ref.lastActivity = Date.now();
					this.#emit({ type: "status_changed", ref });
					return true;
				});
				if (!parked) return false;

				const cleanupErrors: unknown[] = [];
				if (beforeDispose) {
					try {
						await beforeDispose();
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
				try {
					expectedSession.beginDispose();
				} catch (error) {
					if (!cleanupErrors.includes(error)) cleanupErrors.push(error);
				}
				try {
					if (dispose) await dispose();
					else {
						const rawDispose = this.#rawSessionDisposals.get(expectedSession);
						if (rawDispose) await rawDispose();
						else await expectedSession.dispose();
					}
				} catch (error) {
					if (!cleanupErrors.includes(error)) cleanupErrors.push(error);
				}
				if (cleanupErrors.length > 0) {
					cleanupFailed = true;
					const error =
						cleanupErrors.length === 1
							? cleanupErrors[0]
							: new AggregateError(cleanupErrors, `Agent "${ref.id}" park cleanup failed.`);
					this.#failedSessionDisposals.set(ref, { session: expectedSession, error });
					throw error;
				}
				return true;
			} finally {
				if (this.#terminating.get(ref.id) === ref) this.#terminating.delete(ref.id);
				if (!cleanupFailed && this.#acceptedParks.get(expectedSession) === ref)
					this.#acceptedParks.delete(expectedSession);
			}
		});
		return this.#trackRootOperation(rootId, ref, operation, true);
	}

	async #transitionToAborted(expectedRef: RegistryAgentRef, expectedSession?: AgentSession): Promise<boolean> {
		const ref = this.#refs.get(expectedRef.id);
		if (
			ref !== expectedRef ||
			ref.status === "aborted" ||
			this.#isTerminatingLineage(ref.id, ref.lineage?.rootId) ||
			(expectedSession === undefined
				? (ref.status !== "parked" && ref.status !== "running") || ref.session !== null
				: ref.session !== expectedSession || !this.#matchesInternalExpected(ref, expectedSession))
		)
			return false;
		this.#terminating.set(ref.id, ref);
		if (expectedSession) {
			const drain = this.#sessionRunStateDrains.get(expectedSession);
			if (drain) await drain();
		}
		return this.#serializeActorMutation(ref, async () => {
			const startingStatus = ref.status;
			const stillCurrent = () =>
				this.#refs.get(ref.id) === ref &&
				ref.status === startingStatus &&
				this.#terminating.get(ref.id) === ref &&
				(expectedSession === undefined
					? ref.session === null
					: ref.session === expectedSession && this.#matchesInternalExpected(ref, expectedSession));
			if (!stillCurrent()) return false;
			const rootId = ref.lineage?.rootId ?? ref.id;
			await this.#drainRootOperations(rootId, ref);
			await this.#retireDescendants(ref);
			if (!stillCurrent()) return false;
			if (this.#durableActorRecords.has(ref)) {
				const updated = await this.#persistDurableActorState(ref, "aborted", stillCurrent);
				if (!updated || !stillCurrent()) return false;
			}
			ref.session = null;
			ref.status = "aborted";
			ref.activity = undefined;
			ref.lastActivity = Date.now();
			this.#emit({ type: "status_changed", ref });
			return true;
		});
	}

	async #removeExact(expectedRef: RegistryAgentRef): Promise<boolean> {
		const ref = this.#refs.get(expectedRef.id);
		if (ref !== expectedRef || (this.#terminating.get(ref.id) === ref && ref.status === "aborted")) return false;
		return this.#removeExactRef(ref);
	}

	async #retireRef(ref: RegistryAgentRef, disposeOptions?: AgentSessionDisposeOptions): Promise<boolean> {
		if (this.#refs.get(ref.id) !== ref) return false;
		const failedSessionDisposal = this.#failedSessionDisposals.get(ref);
		if (failedSessionDisposal)
			throw new AggregateError(
				[failedSessionDisposal.error],
				`Agent "${ref.id}" cannot retire while its session disposal is unresolved.`,
			);
		this.#terminating.set(ref.id, ref);
		const sessionDrain = ref.session && this.#sessionRunStateDrains.get(ref.session);
		if (sessionDrain) await sessionDrain();
		return this.#serializeActorMutation(ref, async () => {
			if (this.#refs.get(ref.id) !== ref) return false;
			const session = ref.session;
			const status = ref.status;
			const stillCurrent = () => this.#refs.get(ref.id) === ref && ref.session === session && ref.status === status;
			if (!stillCurrent()) return false;
			if (this.#durableActorRecords.has(ref)) {
				const updated = await this.#persistDurableActorState(ref, "retired", stillCurrent);
				if (!updated && stillCurrent()) throw new Error(`Durable actor "${ref.id}" could not be retired.`);
				if (!updated || !stillCurrent()) return false;
			}
			this.#refs.delete(ref.id);
			this.#emit({ type: "removed", ref });
			if (session) {
				const disposalErrors: unknown[] = [];
				try {
					session.beginDispose();
				} catch (error) {
					disposalErrors.push(error);
				}
				try {
					const dispose = this.#rawSessionDisposals.get(session);
					if (dispose) await dispose(disposeOptions);
					else await session.dispose(disposeOptions);
				} catch (error) {
					if (!disposalErrors.includes(error)) disposalErrors.push(error);
				}
				if (disposalErrors.length > 0) {
					const error =
						disposalErrors.length === 1
							? disposalErrors[0]
							: new AggregateError(disposalErrors, `Agent "${ref.id}" disposal failed.`);
					this.#failedSessionDisposals.set(ref, { session, error });
					throw error;
				}
			}
			if (this.#terminating.get(ref.id) === ref) this.#terminating.delete(ref.id);
			return true;
		});
	}

	async #retireDescendants(
		ref: RegistryAgentRef,
		captured: readonly RegistryAgentRef[] = [...this.#refs.values()],
		preserveParkedDescendants = false,
	): Promise<void> {
		const ancestry = new Map(captured.map(candidate => [candidate.id, candidate]));
		ancestry.set(ref.id, ref);
		for (const failedRef of this.#failedSessionDisposals.keys()) ancestry.set(failedRef.id, failedRef);
		const failedDescendantDisposals = [...this.#failedSessionDisposals]
			.filter(([failedRef]) => {
				if (failedRef === ref || failedRef.lineage?.rootId !== ref.lineage?.rootId) return false;
				let cursor: RegistryAgentRef | undefined = failedRef;
				const seen = new Set<string>();
				while (cursor?.parentId !== undefined && !seen.has(cursor.id)) {
					seen.add(cursor.id);
					if (cursor.parentId === ref.id) return true;
					cursor = ancestry.get(cursor.parentId);
				}
				return false;
			})
			.map(([, failure]) => failure.error);
		if (failedDescendantDisposals.length > 0)
			throw new AggregateError(
				failedDescendantDisposals,
				`Agent descendants still own sessions whose disposal failed before ${ref.id}.`,
			);
		const descendants = captured
			.filter(
				candidate =>
					candidate !== ref &&
					candidate.lineage?.rootId === ref.lineage?.rootId &&
					// A main root leaving (e.g. a root session switch) keeps disk-backed parked peers discoverable.
					// A durable actor is not such a peer: its record lives in the leaving root's authority, so
					// it is settled with that root even while parked.
					!(
						preserveParkedDescendants &&
						candidate.status === "parked" &&
						candidate.session === null &&
						!this.#durableActorRecords.has(candidate)
					),
			)
			.map(candidate => {
				let cursor: RegistryAgentRef | undefined = candidate;
				let depth = 0;
				const seen = new Set<string>();
				while (cursor?.parentId !== undefined && !seen.has(cursor.id)) {
					seen.add(cursor.id);
					if (cursor.parentId === ref.id) return { ref: candidate, depth: depth + 1 };
					cursor = ancestry.get(cursor.parentId);
					depth++;
				}
				return undefined;
			})
			.filter((entry): entry is { ref: RegistryAgentRef; depth: number } => entry !== undefined)
			.sort((left, right) => right.depth - left.depth);
		const failures: unknown[] = [];
		const failedSubtrees = new Set<string>();
		for (const descendant of descendants) {
			if (failedSubtrees.has(descendant.ref.id)) continue;
			try {
				await this.#retireRef(descendant.ref);
			} catch (error) {
				failures.push(error);
				let ancestor: RegistryAgentRef | undefined = descendant.ref;
				while (ancestor && ancestor !== ref && !failedSubtrees.has(ancestor.id)) {
					failedSubtrees.add(ancestor.id);
					ancestor = ancestor.parentId === undefined ? undefined : ancestry.get(ancestor.parentId);
				}
			}
		}
		if (failures.length > 0)
			throw new AggregateError(failures, `Agent descendants could not be fully retired before ${ref.id}.`);
	}

	#removeExactRef(ref: RegistryAgentRef, disposeOptions?: AgentSessionDisposeOptions): Promise<boolean> {
		if (this.#refs.get(ref.id) !== ref) return Promise.resolve(false);
		const existing = this.#removalPromises.get(ref);
		if (existing) return existing;
		this.#terminating.set(ref.id, ref);
		const removal = Promise.resolve().then(async () => {
			const rootId = ref.lineage?.rootId ?? ref.id;
			const isRoot = ref.parentId === undefined && rootId === ref.id;
			if (isRoot && ref.session) {
				const lifecycle = lookupOwnedAgentLifecycle(ref.session);
				this.#rootLifecycleTeardowns.add(ref);
				try {
					const disposal = lifecycle ? disposeOwnedAgentLifecycle(lifecycle) : undefined;
					if (disposal) await disposal;
				} finally {
					this.#rootLifecycleTeardowns.delete(ref);
				}
			}
			await this.#drainRootOperations(rootId, ref);
			await this.#retireDescendants(ref, undefined, ref.kind === "main" && ref.parentId === undefined);
			return this.#retireRef(ref, disposeOptions);
		});
		this.#removalPromises.set(ref, removal);
		const parent = ref.parentId === undefined ? undefined : this.#refs.get(ref.parentId);
		if (parent) {
			const tracked = removal.catch(error => {
				throw new AgentAuthorityCleanupError(error, []);
			});
			this.#trackRootOperation(ref.lineage?.rootId ?? parent.id, parent, tracked);
		}
		const clear = () => {
			if (this.#removalPromises.get(ref) === removal) this.#removalPromises.delete(ref);
		};
		void removal.then(clear, clear);
		return removal;
	}

	async #unregisterInternal(id: string, expected: RegistryAgentRef | AgentSession): Promise<boolean> {
		const ref = this.#refs.get(id);
		if (
			!ref ||
			!this.#matchesInternalExpected(ref, expected) ||
			(this.#terminating.get(id) === ref && ref.status === "aborted")
		)
			return false;
		return this.#removeExactRef(ref);
	}

	async unregister(id: string, expected?: AgentRefExpectation): Promise<boolean> {
		const ref = this.#refs.get(id);
		if (
			!ref ||
			!this.#matchesPublicExpected(ref, expected) ||
			(this.#terminating.get(id) === ref && ref.status === "aborted")
		)
			return false;
		return this.#removeExactRef(ref);
	}

	#observe(ref: RegistryAgentRef): AgentRef {
		const { session: _session, ...copyable } = ref;
		const observation = Object.freeze(cloneAndFreezeAuthorityInput(copyable)) as AgentRef;
		this.#observations.set(observation, ref);
		return observation;
	}

	get(id: string): AgentRef | undefined {
		const ref = this.#refs.get(id);
		return ref ? this.#observe(ref) : undefined;
	}

	list(): AgentRef[] {
		return [...this.#refs.values()].map(ref => this.#observe(ref));
	}

	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => ref.id !== id && ref.kind !== "advisor" && (ref.status === "running" || ref.status === "idle"),
		);
	}

	/** Whether a fresh registry observation's running state is corroborated by its exact attached session. */
	isRunning(ref: AgentRef): boolean {
		if (ref.status !== "running") return false;
		return this.#observations.get(ref)?.session?.isStreaming === true;
	}

	#subscribeSessionRunState(
		session: AgentSession,
		id: string,
		update: (status: AgentStatus) => Promise<boolean>,
	): () => Promise<void> {
		const existing = this.#sessionRunStateDrains.get(session);
		if (existing) return existing;
		let tail = Promise.resolve();
		let drained: Promise<void> | undefined;
		const failures: unknown[] = [];
		const unsubscribe = session.subscribeRunState(status => {
			tail = tail.then(async () => {
				await update(status);
			});
			tail = tail.catch(error => {
				failures.push(error);
				logger.error("Agent status persistence failed", { id, error: String(error) });
			});
		});
		const drain = () => {
			if (!drained) {
				unsubscribe();
				drained = tail.then(() => {
					if (failures.length > 0) throw new AggregateError(failures, `Agent ${id} run-state persistence failed.`);
				});
			}
			return drained;
		};
		this.#sessionRunStateDrains.set(session, drain);
		return drain;
	}

	#syncSessionStatusInternal(id: string, session: AgentSession): () => Promise<void> {
		return this.#subscribeSessionRunState(session, id, status => this.#setStatusInternal(id, status, session));
	}

	/** Legacy-only run-state mirroring. Authority-managed sessions must use the internal bridge. */
	syncSessionStatus(id: string, session: AgentSession): () => Promise<void> {
		return this.#subscribeSessionRunState(session, id, status => this.setStatus(id, status, session));
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	// Dispatch walks a snapshot, not the live `Set`: `Set` iteration visits
	// entries appended behind the cursor, so a listener that resubscribes itself
	// while handling an event would be re-entered forever — an unbounded
	// synchronous loop that starves the event loop and wedges the process. The
	// membership re-check keeps the "an unsubscribed listener stops receiving
	// events" contract for listeners dropped earlier in the same dispatch.
	#emit(event: InternalRegistryEvent): void {
		const internalListeners = [...this.#internalListeners];
		for (const listener of internalListeners) {
			if (!this.#internalListeners.has(listener)) continue;
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
		if (this.#listeners.size === 0) return;
		const publicEvent = Object.freeze({ type: event.type, ref: this.#observe(event.ref) }) as RegistryEvent;
		const listeners = [...this.#listeners];
		for (const listener of listeners) {
			if (!this.#listeners.has(listener)) continue;
			try {
				listener(publicEvent);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
