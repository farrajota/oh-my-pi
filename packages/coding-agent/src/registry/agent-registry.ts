/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { bindOwnedAgentLifecycle, replaceOwnedAgentLifecycle } from "../internal/agent-lifecycle-bridge";
import {
	registerAgentRegistryBridge,
	type InternalAgentOwnershipToken,
	type InternalAgentRef,
	type InternalRegistryEvent,
} from "../internal/agent-registry-bridge";
import { deriveRestrictedStartupPolicy } from "../internal/restricted-startup-policy";
import type { AgentSession } from "../session/agent-session";
import { createAgentSession, type CreateAgentSessionOptions, type CreateAgentSessionResult } from "../sdk";
import {
	composeEffectivePermissions,
	freezePermissionScope,
	isScopeNoBroader,
	normalizeEffectivePermissionSummary,
	type PermissionScopeSnapshot,
} from "../task/permission-profiles";
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
	type DurableRegistryRecoverySnapshot,
	type DurableTransitionRecord,
	durableRootHeadHash,
	RegistryDurableStateStore,
} from "./durable-state";
import { type EffectivePermissionSummary, oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/** Sidecar marker retained beside a child transcript after an explicit kill. */
const AGENT_TOMBSTONE_SUFFIX = ".tombstone";

export function getAgentTombstonePath(sessionFile: string): string {
	return `${sessionFile}${AGENT_TOMBSTONE_SUFFIX}`;
}

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
 *   agent-facing rosters (`hub`, `history://`) and not messageable/revivable.
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

/** Historical identity and telemetry that remain available after the live session is disposed. */
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
	readOnly?: boolean;
	/** Durable task output artifact, when the executor wrote one. */
	outputPath?: string;
	/** Captured isolated-worktree patch, when patch capture succeeded. */
	patchPath?: string;
	/** Isolated branch identity, when branch-mode capture succeeded. */
	branchName?: string;
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
	readonly options: CreateAgentSessionOptions;
	readonly create: () => Promise<CreateAgentSessionResult>;
	readonly activate: (session: AgentSession) => void;
	readonly abandon: () => void;
	readonly isCurrent: (session: AgentSession) => boolean;
	readonly startupHash: string;
	readonly provenanceHash: string;
	readonly scopeHash?: string;
	readonly parentScopeHash?: string;
	readonly revival: boolean;
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
	/** Persisted identity and telemetry restored after the live observer is gone. */
	history?: AgentHistorySummary;
	/** Opaque lineage slot assigned by the registry generation. */
	readonly lineage?: { readonly rootId: string; readonly parentId?: string; readonly generation: number };
}

type RegistryAgentRef = InternalAgentRef;
export type AgentRefExpectation = AgentRef | AgentSession;

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
	readonly durableState?: RegistryDurableStateStore;
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

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, RegistryAgentRef>();
	readonly #listeners = new Set<RegistryListener>();
	readonly #internalListeners = new Set<InternalRegistryListener>();
	readonly #terminating = new Map<string, RegistryAgentRef>();
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
	readonly #durableState: RegistryDurableStateStore | undefined;
	readonly #durableRecovery: DurableRegistryRecoverySnapshot | undefined;
	readonly #durableRootHeads = new Map<string, { generation: number; headHash: string }>();
	readonly #durableActorRecords = new WeakMap<RegistryAgentRef, DurableActorRecord>();

	constructor(options: AgentRegistryOptions = {}) {
		this.#durableState = options.durableState;
		this.#durableRecovery = options.durableState?.recover();
		for (const root of this.#durableRecovery?.roots.values() ?? []) {
			if (root.state === "active")
				this.#durableRootHeads.set(root.rootId, { generation: root.generation, headHash: root.headHash });
		}
		const recoveredGenerations = [
			...[...(this.#durableRecovery?.roots.values() ?? [])].map(root => root.generation),
			...[...(this.#durableRecovery?.actors.values() ?? [])].map(actor => actor.generation),
		];
		this.#nextGeneration = Math.max(0, ...recoveredGenerations) + 1;
		registerAgentRegistryBridge(this, {
			lookup: id => this.#refs.get(id),
			list: () => [...this.#refs.values()],
			resolveObservation: observation => this.#observations.get(observation),
			ownershipToken: expected => this.#ownershipToken(expected),
			bindAuthoritySession: parent => this.#bindAuthoritySession(parent),
			lookupAuthoritySession: parent => this.#lookupAuthoritySession(parent),
			createRootSession: options => this.#createRootSession(options),
			setHistory: (expected, history) => this.#setHistoryInternal(expected, history),
			setStatus: (id, status, expected) => this.#setStatusInternal(id, status, expected),
			attachSession: (id, session, sessionFile, expected) =>
				this.#attachSessionInternal(id, session, sessionFile, expected),
			detachSession: (id, expected) => this.#detachSessionInternal(id, expected),
			unregister: (id, expected) => this.#unregisterInternal(id, expected),
			operationAuthority: parent => this.#operationAuthority(parent),
			park: (expectedRef, expectedSession) => this.#transitionToParked(expectedRef, expectedSession),
			abort: (expectedRef, expectedSession) => this.#transitionToAborted(expectedRef, expectedSession),
			remove: expectedRef => this.#removeExact(expectedRef),
			endTermination: expectedRef => this.#endTermination(expectedRef),
			syncSessionStatus: (id, session) => this.#syncSessionStatusInternal(id, session),
			register: input => this.#register(input),
			registerIfAvailable: (input, expected) => this.#registerIfAvailableInternal(input, expected),
			replaceIfAvailable: (input, expected) => this.#replaceIfAvailableInternal(input, expected),
			onChange: listener => {
				this.#internalListeners.add(listener);
				return () => this.#internalListeners.delete(listener);
			},
			observe: ref => this.#observe(ref),
		});
	}

	/** Exact journal used by this registry; never included in public agent observations. */
	getDurableStateStore(): RegistryDurableStateStore | undefined {
		return this.#durableState;
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

	#reserve(
		id: string,
		rootId: string,
		parentId: string | undefined,
		generation?: number,
		allowOccupied = false,
	): AgentReservation {
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
		if (
			this.#refs.get(ref.id) !== ref ||
			ref.status !== "parked" ||
			ref.session !== null ||
			!ref.lineage ||
			ref.parentId !== ref.lineage.parentId
		)
			throw new Error("Invalid parked revival authority.");
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
			ref = this.#register(input);
		} catch (error) {
			this.#claimedIds.set(reservation.id, reservation);
			throw error;
		}
		(ref as { lineage?: AgentRef["lineage"] }).lineage = Object.freeze({
			rootId: reservation.rootId,
			parentId: reservation.parentId,
			generation: reservation.generation,
		});
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

	#prepareAuthoritySession(
		reservation: AgentReservation,
		options: CreateAgentSessionOptions,
		parentAuthority?: { ref: RegistryAgentRef; session: AgentSession; capability: AgentCapability },
	): PreparedAgentAuthoritySession {
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
		const requestedOptions: CreateAgentSessionOptions = options.settings
			? { ...options, settings: options.settings.snapshot() }
			: options;
		const { getApiKey, mcpManager, ...authorityOptions } = requestedOptions;
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
		const creationOptions = Object.freeze({
			...frozenAuthorityData,
			...(getApiKey === undefined ? {} : { getApiKey }),
			...(mcpManager === undefined ? {} : { mcpManager }),
		}) satisfies CreateAgentSessionOptions;
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
			const recovered = this.#durableState.snapshot().actors.get(reservation.id);
			if (
				!recovered ||
				recovered.rootId !== reservation.rootId ||
				recovered.parentId !== reservation.parentId ||
				recovered.generation !== reservation.generation ||
				recovered.startupHash !== startupHash ||
				recovered.provenanceHash !== provenanceHash ||
				recovered.scopeHash !== scopeHash ||
				recovered.parentScopeHash !== parentScopeHash ||
				!this.#durableState.validateRevival({
					actorId: reservation.id,
					rootId: reservation.rootId,
					...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
					generation: reservation.generation,
					...(scopeHash === undefined ? {} : { scopeHash }),
				})
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
		if (!revival) this.#durableState?.append({ ...durableConstruction, at: Date.now(), phase: "reserved" });
		let state: "staged" | "creating" | "created" | "active" | "abandoned" = "staged";
		let createdSession: AgentSession | undefined;
		const isCurrent = (session: AgentSession): boolean => {
			if (createdSession !== session) return false;
			if (state === "created") {
				return (
					this.#reservations.get(reservation as object) === reservation &&
					this.#claimedIds.get(reservation.id) === reservation
				);
			}
			if (state !== "active") return false;
			const ref = this.#refs.get(reservation.id);
			return (
				ref?.session === session &&
				this.#sessionCapabilities.get(session) === reservation.capability &&
				this.#refCapabilities.get(ref) === reservation.capability
			);
		};
		const prepared: PreparedAgentAuthoritySession = Object.freeze({
			reservation,
			descriptor,
			options: creationOptions,
			startupHash,
			provenanceHash,
			...(scopeHash === undefined ? {} : { scopeHash }),
			...(parentScopeHash === undefined ? {} : { parentScopeHash }),
			revival,
			create: async (): Promise<CreateAgentSessionResult> => {
				if (state !== "staged") throw new Error("Agent authority construction capability was already consumed.");
				state = "creating";
				if (!revival) this.#durableState?.append({ ...durableConstruction, at: Date.now(), phase: "constructing" });
				let constructed: CreateAgentSessionResult | undefined;
				try {
					constructed = await createAgentSession(creationOptions);
					if (
						parentAuthority &&
						(this.#refs.get(reservation.parentId!) !== parentAuthority.ref ||
							parentAuthority.ref.session !== parentSession ||
							parentSession!.isDisposed ||
							(parentAuthority.ref.status !== "running" && parentAuthority.ref.status !== "idle") ||
							this.#refCapabilities.get(parentAuthority.ref) !== parentAuthority.capability ||
							this.#sessionCapabilities.get(parentSession!) !== parentAuthority.capability)
					)
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
					if (descriptor.sessionFile !== null && descriptor.sessionFile !== sessionFile) {
						throw new Error("Authority session file changed during construction.");
					}
					createdSession = constructedSession;
					if (!revival)
						this.#durableState?.append({ ...durableConstruction, at: Date.now(), phase: "constructed" });
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
					bindSessionOperationAuthority(constructedSession.sessionManager, operationAuthority);
					return constructed;
				} catch (error) {
					state = "abandoned";
					if (!revival) this.#durableState?.append({ ...durableConstruction, at: Date.now(), phase: "abandoned" });
					if (constructed) await constructed.session.dispose();
					throw error;
				}
			},
			activate: (session: AgentSession): void => {
				if (state !== "created" || createdSession !== session)
					throw new Error("Authority construction cannot activate another session.");
				state = "active";
			},
			abandon: () => {
				if (state !== "active" && state !== "abandoned") {
					state = "abandoned";
					if (!revival) this.#durableState?.append({ ...durableConstruction, at: Date.now(), phase: "abandoned" });
				}
			},
			isCurrent,
		});
		return prepared;
	}
	#stageDurableActivation(prepared: PreparedAgentAuthoritySession): DurableActorRecord | undefined {
		const store = this.#durableState;
		if (!store) return undefined;
		const reservation = prepared.reservation;
		if (prepared.revival) {
			const recovered = store.snapshot().actors.get(reservation.id);
			if (
				!recovered ||
				recovered.rootId !== reservation.rootId ||
				recovered.parentId !== reservation.parentId ||
				recovered.generation !== reservation.generation ||
				recovered.startupHash !== prepared.startupHash ||
				recovered.provenanceHash !== prepared.provenanceHash ||
				recovered.scopeHash !== prepared.scopeHash ||
				recovered.parentScopeHash !== prepared.parentScopeHash
			)
				throw new Error("Recovered durable actor changed before revival activation.");
			const actor = Object.freeze({ ...recovered, at: Date.now(), state: "active" as const });
			store.append(actor);
			return actor;
		}
		let root = this.#durableRootHeads.get(reservation.rootId);
		if (reservation.parentId === undefined) {
			const headHash = durableRootHeadHash({
				rootId: reservation.rootId,
				generation: reservation.generation,
				actorId: reservation.id,
				startupHash: prepared.startupHash,
				provenanceHash: prepared.provenanceHash,
			});
			root = { generation: reservation.generation, headHash };
			store.append({
				kind: "root",
				at: Date.now(),
				rootId: reservation.rootId,
				generation: root.generation,
				headHash: root.headHash,
				state: "active",
			});
		} else if (!root) {
			throw new Error("Durable child authority requires an exact current root record.");
		}
		const actor: DurableActorRecord = Object.freeze({
			kind: "actor",
			at: Date.now(),
			actorId: reservation.id,
			rootId: reservation.rootId,
			...(reservation.parentId === undefined ? {} : { parentId: reservation.parentId }),
			generation: reservation.generation,
			rootGeneration: root.generation,
			rootHeadHash: root.headHash,
			startupHash: prepared.startupHash,
			provenanceHash: prepared.provenanceHash,
			...(prepared.scopeHash === undefined ? {} : { scopeHash: prepared.scopeHash }),
			...(prepared.parentScopeHash === undefined ? {} : { parentScopeHash: prepared.parentScopeHash }),
			state: "active",
		});
		store.append(actor);
		return actor;
	}

	#finishDurableActivation(
		prepared: PreparedAgentAuthoritySession,
		ref: RegistryAgentRef,
		actor: DurableActorRecord | undefined,
	): void {
		if (!this.#durableState || !actor) return;
		if (prepared.revival) {
			this.#durableActorRecords.set(ref, actor);
			return;
		}
		const reservation = prepared.reservation;
		this.#durableState.append({
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
		});
		if (reservation.parentId === undefined) {
			this.#durableRootHeads.set(reservation.rootId, {
				generation: actor.rootGeneration,
				headHash: actor.rootHeadHash,
			});
			this.#durableState.append({
				kind: "gate",
				at: Date.now(),
				rootId: reservation.rootId,
				generation: reservation.generation,
				phase: "open",
			});
		}
		this.#durableActorRecords.set(ref, actor);
	}

	#installAuthoritySessionDisposal(ref: RegistryAgentRef, session: AgentSession): void {
		const originalDispose = session.dispose.bind(session);
		let disposePromise: Promise<void> | undefined;
		session.dispose = disposeOptions => {
			disposePromise ??= (async () => {
				try {
					await originalDispose(disposeOptions);
				} finally {
					const current = this.#refs.get(ref.id);
					if (
						current === ref &&
						current.session === session &&
						current.status !== "parked" &&
						current.status !== "aborted"
					) {
						this.#unregisterInternal(ref.id, session);
					}
				}
			})();
			return disposePromise;
		};
	}

	#commitPreparedSession(
		prepared: PreparedAgentAuthoritySession,
		created: CreateAgentSessionResult,
	): RegistryAgentRef {
		if (!prepared.isCurrent(created.session)) throw new Error("Authority construction changed before commit.");
		const reservation = prepared.reservation;
		const sessionFile = authoritySessionFile(created.session);
		const durableActor = this.#stageDurableActivation(prepared);
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
		prepared.activate(created.session);
		if (reservation.parentId === undefined && !bindOwnedAgentLifecycle(this, created.session)) {
			this.#removeExactRef(ref);
			throw new Error("Root lifecycle ownership requires an exact claimed authority session.");
		}
		this.#installAuthoritySessionDisposal(ref, created.session);
		this.#finishDurableActivation(prepared, ref, durableActor);
		return ref;
	}

	async #createReservedSession(
		reservation: AgentReservation,
		options: CreateAgentSessionOptions,
		parentAuthority?: { ref: RegistryAgentRef; session: AgentSession; capability: AgentCapability },
	): Promise<CreateAgentSessionResult> {
		let prepared: PreparedAgentAuthoritySession | undefined;
		let created: CreateAgentSessionResult | undefined;
		try {
			prepared = this.#prepareAuthoritySession(reservation, options, parentAuthority);
			created = await prepared.create();
			this.#commitPreparedSession(prepared, created);
			return created;
		} catch (error) {
			prepared?.abandon();
			this.#abandonReservation(reservation);
			if (created) await created.session.dispose();
			throw error;
		}
	}

	#commitRootReplacement(
		prepared: PreparedAgentAuthoritySession,
		created: CreateAgentSessionResult,
		expected: RegistryAgentRef,
	): RegistryAgentRef {
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
		const durableActor = this.#stageDurableActivation(prepared);
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
		prepared.activate(created.session);
		if (!replaceOwnedAgentLifecycle(this, expected.session!, created.session)) {
			this.#refs.set(expected.id, expected);
			this.#sessionCapabilities.delete(created.session);
			this.#refCapabilities.delete(replacement);
			throw new Error("Replacement root lifecycle ownership could not be activated.");
		}
		this.#installAuthoritySessionDisposal(replacement, created.session);
		this.#finishDurableActivation(prepared, replacement, durableActor);
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
		let replacement: CreateAgentSessionResult | undefined;
		let controller: MigrationFenceController | undefined;
		let fence: RootMigrationFence | undefined;
		let switched = false;
		let durableTransition: Omit<DurableTransitionRecord, "at" | "phase" | "recovery"> | undefined;
		let durableCasCommitted = false;
		try {
			prepared = this.#prepareAuthoritySession(reservation, options);
			if (this.#durableState) {
				const source = this.#durableRootHeads.get(id);
				if (!source || source.generation !== ownerRecord.generation)
					throw new Error("Root replacement source durable generation is missing or stale.");
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
					sourceHeadHash: source.headHash,
					destinationHeadHash,
				};
				this.#durableState.append({ ...durableTransition, at: Date.now(), phase: "staged" });
			}
			replacement = await prepared.create();
			controller = new MigrationFenceController();
			fence = controller.open(id, `root-replacement:${id}:${ownerRecord.generation}:${replacementGeneration}`);
			if (durableTransition) {
				this.#durableState!.append({ ...durableTransition, at: Date.now(), phase: "quiescing" });
				this.#durableState!.append({
					kind: "gate",
					at: Date.now(),
					rootId: id,
					generation: ownerRecord.generation,
					phase: "quiescing",
				});
			}
			const quiescedSessions = new Set<AgentSession>();
			while (true) {
				const liveRootSessions = [...this.#refs.values()]
					.filter(ref => ref.lineage?.rootId === id && ref.session !== null)
					.map(ref => ref.session!);
				const newlyObserved = [...new Set(liveRootSessions)].filter(session => !quiescedSessions.has(session));
				if (newlyObserved.length === 0) break;
				fence = await controller.quiesce(
					fence,
					newlyObserved.map(session => session.sessionManager),
				);
				for (const session of newlyObserved) quiescedSessions.add(session);
			}
			if (durableTransition) {
				this.#durableState!.append({ ...durableTransition, at: Date.now(), phase: "quiesced" });
				this.#durableState!.append({
					kind: "gate",
					at: Date.now(),
					rootId: id,
					generation: ownerRecord.generation,
					phase: "quiesced",
				});
			}
			fence = controller.validate(fence);
			controller.assertValidated(fence, id, owner.sessionManager);
			if (durableTransition)
				this.#durableState!.append({ ...durableTransition, at: Date.now(), phase: "validated" });
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
			if (durableTransition) {
				this.#durableState!.append({
					kind: "gate",
					at: Date.now(),
					rootId: id,
					generation: ownerRecord.generation,
					phase: "closed",
				});
				this.#durableState!.append({ ...durableTransition, at: Date.now(), phase: "cas-committed" });
				durableCasCommitted = true;
			}
			const retiringRefs = [...this.#refs.values()].filter(ref => ref.lineage?.rootId === id);
			const retiringSessions = [...new Set(retiringRefs.flatMap(ref => (ref.session ? [ref.session] : [])))];
			const replacementRef = this.#commitRootReplacement(prepared, replacement, existing);
			switched = true;
			fence = controller.activate(fence);
			if (durableTransition) {
				this.#durableState!.append({ ...durableTransition, at: Date.now(), phase: "activated" });
				this.#durableState!.append({
					kind: "gate",
					at: Date.now(),
					rootId: id,
					generation: replacementGeneration,
					phase: "open",
				});
			}
			for (const session of retiringSessions) session.beginDispose();
			for (const ref of retiringRefs) {
				if (ref !== existing && ref !== replacementRef) this.#removeExactRef(ref);
			}
			const retirements = await Promise.allSettled(retiringSessions.map(session => session.dispose()));
			for (const retirement of retirements) {
				if (retirement.status === "rejected") {
					logger.warn("Root replacement retirement failed after replacement activation", {
						rootId: id,
						error: retirement.reason instanceof Error ? retirement.reason.message : String(retirement.reason),
					});
				}
			}
			if (durableTransition) this.#durableState!.append({ ...durableTransition, at: Date.now(), phase: "retired" });
			return replacement;
		} catch (error) {
			if (!switched && !durableCasCommitted && controller && fence) controller.recover(fence);
			if (!switched && !durableCasCommitted && durableTransition && this.#durableState?.available) {
				this.#durableState.append({ ...durableTransition, at: Date.now(), phase: "recovered", recovery: true });
				this.#durableState.append({
					kind: "root",
					at: Date.now(),
					rootId: id,
					generation: durableTransition.destinationGeneration,
					headHash: durableTransition.destinationHeadHash,
					state: "invalidated",
				});
				this.#durableState.append({
					kind: "root",
					at: Date.now(),
					rootId: id,
					generation: durableTransition.sourceGeneration,
					headHash: durableTransition.sourceHeadHash,
					state: "active",
				});
				this.#durableState.append({
					kind: "gate",
					at: Date.now(),
					rootId: id,
					generation: durableTransition.sourceGeneration,
					phase: "open",
				});
			}
			prepared?.abandon();
			this.#abandonReservation(reservation);
			if (replacement && !switched) await replacement.session.dispose();
			throw error;
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

	#register(input: RegisterInput): RegistryAgentRef {
		if (this.#terminating.has(input.id)) throw new Error(`Agent "${input.id}" is being terminated.`);
		const existing = this.#refs.get(input.id);
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
		const parent = input.parentId ? this.#refs.get(input.parentId) : undefined;
		const lineage =
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
			lineage,
		};
		if (recoveredActor && recoveredLineage) this.#durableActorRecords.set(ref, recoveredActor);
		this.#ownershipTokens.set(ref, Object.freeze({}) as InternalAgentOwnershipToken);
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	register(input: RegisterInput): AgentRef {
		return this.#observe(this.#register(input));
	}

	#registerIfAvailableInternal(input: RegisterInput, expected: RegistryAgentRef | null): RegistryAgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.#register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	#replaceIfAvailableInternal(input: RegisterInput, expected: RegistryAgentRef | null): RegistryAgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (this.#claimedIds.has(input.id) || this.#terminating.has(input.id)) return undefined;
		if (expected === null) return current ? undefined : this.#register(input);
		if (current !== expected || current.status !== "parked" || current.session) return undefined;
		this.#refs.delete(current.id);
		this.#emit({ type: "removed", ref: current });
		return this.#register(input);
	}

	/** Register only when the id is absent, or reuse the exact detached parked ref represented by the observation. */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const exactExpected = expected === null ? null : this.#observations.get(expected);
		if (expected !== null && !exactExpected) return undefined;
		const ref = this.#registerIfAvailableInternal(input, exactExpected ?? null);
		return ref ? this.#observe(ref) : undefined;
	}

	#mergeHistory(ref: RegistryAgentRef, history: AgentHistorySummary): true {
		const permissionSummary = normalizeEffectivePermissionSummary(history.permissionSummary);
		const definedHistory = Object.fromEntries(
			Object.entries({ ...history, permissionSummary }).filter(([, value]) => value !== undefined),
		) as AgentHistorySummary;
		ref.history = { ...ref.history, ...definedHistory };
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	#setHistoryInternal(expected: RegistryAgentRef | AgentSession, history: AgentHistorySummary): boolean {
		const capability = this.#sessionCapabilities.get(expected as AgentSession);
		const actorId = capability ? this.#assertCapability(capability).actorId : (expected as RegistryAgentRef).id;
		if (typeof actorId !== "string") return false;
		const ref = this.#refs.get(actorId);
		if (!ref || !this.#matchesInternalExpected(ref, expected)) return false;
		return this.#mergeHistory(ref, history);
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
		return this.#mergeHistory(ref, history);
	}

	/** Merge history only when the frozen observation still names the exact current legacy row. */
	setHistoryExact(id: string, expectedObservation: AgentRef, history: AgentHistorySummary): boolean {
		const ref = this.#observations.get(expectedObservation);
		if (!ref || ref.id !== id || this.#refs.get(id) !== ref || this.#authorityRefs.has(ref)) return false;
		return this.#mergeHistory(ref, history);
	}

	/** Atomically reconcile scalar host metadata on the exact legacy observation. */
	updateAgentMetadata(id: string, expectedObservation: AgentRef, metadata: AgentMetadataUpdate): boolean {
		const ref = this.#refs.get(id);
		if (!ref || this.#authorityRefs.has(ref) || this.#observations.get(expectedObservation) !== ref) return false;
		ref.displayName = metadata.displayName;
		ref.createdAt = metadata.createdAt;
		ref.lastActivity = metadata.lastActivity;
		this.#emit({ type: "metadata_changed", ref });
		return true;
	}

	#persistDurableActorState(ref: RegistryAgentRef, state: DurableActorRecord["state"]): void {
		const current = this.#durableActorRecords.get(ref);
		if (!current || !this.#durableState) return;
		const next: DurableActorRecord = Object.freeze({ ...current, at: Date.now(), state });
		this.#durableState.append(next);
		this.#durableActorRecords.set(ref, next);
	}

	#setStatus(ref: RegistryAgentRef, status: AgentStatus): boolean {
		if (ref.status === "aborted") {
			return status === "aborted" || this.#rejectStatusUpdate(ref.id, status, "aborted-is-terminal");
		}
		if (ref.status === status) return true;
		this.#persistDurableActorState(ref, status === "aborted" ? "aborted" : "active");
		ref.status = status;
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	#setStatusInternal(id: string, status: AgentStatus, expected: RegistryAgentRef | AgentSession): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (!this.#matchesInternalExpected(ref, expected))
			return this.#rejectStatusUpdate(id, status, "session-ownership-changed");
		return this.#setStatus(ref, status);
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref) return this.#rejectStatusUpdate(id, status, "missing-ref");
		if (!this.#matchesPublicExpected(ref, expected))
			return this.#rejectStatusUpdate(id, status, "authority-managed-or-changed");
		return this.#setStatus(ref, status);
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	#attachSession(ref: RegistryAgentRef, session: AgentSession, sessionFile?: string | null): boolean {
		if (ref.status === "aborted") return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
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
		return Boolean(
			ref && this.#matchesPublicExpected(ref, expected) && this.#attachSession(ref, session, sessionFile),
		);
	}

	#detachSessionInternal(id: string, expected: RegistryAgentRef | AgentSession): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesInternalExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesPublicExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	/** Atomically detach the exact live generation and publish it as parked. */
	#transitionToParked(expectedRef: RegistryAgentRef, expectedSession: AgentSession): boolean {
		const ref = this.#refs.get(expectedRef.id);
		if (
			ref !== expectedRef ||
			ref.status === "aborted" ||
			ref.session !== expectedSession ||
			!this.#matchesInternalExpected(ref, expectedSession)
		)
			return false;
		this.#persistDurableActorState(ref, "parked");
		ref.session = null;
		ref.status = "parked";
		ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	#transitionToAborted(expectedRef: RegistryAgentRef, expectedSession?: AgentSession): boolean {
		const ref = this.#refs.get(expectedRef.id);
		if (
			ref !== expectedRef ||
			ref.status === "aborted" ||
			this.#terminating.has(ref.id) ||
			(expectedSession === undefined
				? ref.status !== "parked" || ref.session !== null
				: ref.session !== expectedSession || !this.#matchesInternalExpected(ref, expectedSession))
		)
			return false;
		this.#persistDurableActorState(ref, "aborted");
		this.#terminating.set(ref.id, ref);
		ref.session = null;
		ref.status = "aborted";
		ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	#removeExact(expectedRef: RegistryAgentRef): boolean {
		const ref = this.#refs.get(expectedRef.id);
		return ref === expectedRef && !this.#terminating.has(ref.id) && this.#removeExactRef(ref);
	}

	#removeExactRef(ref: RegistryAgentRef): boolean {
		if (this.#refs.get(ref.id) !== ref) return false;
		this.#persistDurableActorState(ref, "retired");
		this.#refs.delete(ref.id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	#unregisterInternal(id: string, expected: RegistryAgentRef | AgentSession): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesInternalExpected(ref, expected) || this.#terminating.get(id) === ref) return false;
		return this.#removeExactRef(ref);
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesPublicExpected(ref, expected) || this.#terminating.get(id) === ref) return false;
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

	#syncSessionStatusInternal(id: string, session: AgentSession): () => void {
		return session.subscribeRunState(status => {
			this.#setStatusInternal(id, status, session);
		});
	}

	/** Legacy-only run-state mirroring. Authority-managed sessions must use the internal bridge. */
	syncSessionStatus(id: string, session: AgentSession): () => void {
		return session.subscribeRunState(status => {
			this.setStatus(id, status, session);
		});
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: InternalRegistryEvent): void {
		for (const listener of this.#internalListeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
		if (this.#listeners.size === 0) return;
		const publicEvent = Object.freeze({ type: event.type, ref: this.#observe(event.ref) }) as RegistryEvent;
		for (const listener of this.#listeners) {
			try {
				listener(publicEvent);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
