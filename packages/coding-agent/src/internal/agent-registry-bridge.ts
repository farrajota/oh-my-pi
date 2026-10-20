import type { CompactionThresholdPair } from "../config/compaction-threshold";
import type { Settings } from "../config/settings";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { BoundSessionOperationAuthority } from "../registry/operation-lease";
import type {
	AgentAuthoritySessionBinding,
	AgentHistorySummary,
	AgentRef,
	AgentRegistry,
	AgentStatus,
	RegisterInput,
	RegistryEvent,
} from "../registry/agent-registry";

/**
 * Original-root thresholds for a subagent settings chain. Named overrides apply
 * to that child only; authority snapshots retain this metadata, not arbitrary
 * symbol properties or session authority brands.
 */
export const kRootCompactionThresholds = Symbol("task.rootCompactionThresholds");

export interface SubagentChainSettings extends Settings {
	[kRootCompactionThresholds]?: Readonly<CompactionThresholdPair> & { modelThresholdsEnabled: boolean };
}

/** Exact mutable registry row. This type is confined to non-package-exported code. */
export type InternalAgentRef = AgentRef & { session: AgentSession | null };

declare const internalAgentOwnershipTokenBrand: unique symbol;

export type InternalAgentOwnershipToken = { readonly [internalAgentOwnershipTokenBrand]: never };

export type InternalRegistryEvent =
	| { type: "registered"; ref: InternalAgentRef }
	| { type: "status_changed"; ref: InternalAgentRef }
	| { type: "metadata_changed"; ref: InternalAgentRef }
	| { type: "removed"; ref: InternalAgentRef };

interface AgentRegistryBridge {
	lookup(id: string): InternalAgentRef | undefined;
	list(): InternalAgentRef[];
	resolveObservation(observation: AgentRef): InternalAgentRef | undefined;
	ownershipToken(expected: InternalAgentRef | AgentRef): InternalAgentOwnershipToken | undefined;
	bindAuthoritySession(parent: AgentSession): AgentAuthoritySessionBinding | undefined;
	lookupAuthoritySession(parent: AgentSession): InternalAgentRef | undefined;
	isSessionParentIrcSender(session: AgentSession, recipientId: string, senderId: string): boolean;
	lookupAuthorityLineage(parentId: string): { readonly rootId: string; readonly parentId: string } | undefined;
	operationAuthority(parent: AgentSession): BoundSessionOperationAuthority | undefined;
	createRootSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
	setHistory(
		expected: InternalAgentRef | AgentSession,
		history: AgentHistorySummary,
		expectedSessionFile?: string,
	): boolean;
	setStatus(id: string, status: AgentStatus, expected: InternalAgentRef | AgentSession): boolean;
	setActivity(id: string, activity: string, expected: InternalAgentRef | AgentSession): boolean;
	markResultAccepted(id: string, expected: InternalAgentRef | AgentSession, responseAt?: number): boolean;
	attachSession(
		id: string,
		session: AgentSession,
		sessionFile: string | null | undefined,
		expected: InternalAgentRef | AgentSession,
	): boolean;
	detachSession(id: string, expected: InternalAgentRef | AgentSession): boolean;
	unregister(id: string, expected: InternalAgentRef | AgentSession): boolean;
	park(expectedRef: InternalAgentRef, expectedSession: AgentSession): boolean;
	abort(expectedRef: InternalAgentRef, expectedSession?: AgentSession): boolean;
	remove(expectedRef: InternalAgentRef): boolean;
	endTermination(expectedRef: InternalAgentRef): void;
	syncSessionStatus(id: string, session: AgentSession): () => void;
	register(input: RegisterInput): InternalAgentRef;
	registerIfAvailable(input: RegisterInput, expected: InternalAgentRef | null): InternalAgentRef | undefined;
	replaceIfAvailable(input: RegisterInput, expected: InternalAgentRef | null): InternalAgentRef | undefined;
	onChange(listener: (event: InternalRegistryEvent) => void): () => void;
	observe(ref: InternalAgentRef): AgentRef;
}

const registryBridges = new WeakMap<AgentRegistry, AgentRegistryBridge>();
interface AgentSessionRegistryBinding {
	readonly registry: AgentRegistry;
	readonly ref: InternalAgentRef;
	readonly rootRef: InternalAgentRef;
	readonly rootId: string;
	readonly actorGeneration: number;
	readonly rootGeneration: number;
}

const sessionRegistryBindings = new WeakMap<AgentSession, AgentSessionRegistryBinding>();

export function registerAgentRegistryBridge(registry: AgentRegistry, bridge: AgentRegistryBridge): void {
	if (registryBridges.has(registry)) throw new Error("Agent registry bridge is already registered.");
	registryBridges.set(registry, Object.freeze(bridge));
}

function bridgeFor(registry: AgentRegistry): AgentRegistryBridge {
	const bridge = registryBridges.get(registry);
	if (!bridge) throw new Error("Agent registry bridge is unavailable.");
	return bridge;
}

export function lookupAgentRef(registry: AgentRegistry, id: string): InternalAgentRef | undefined {
	return bridgeFor(registry).lookup(id);
}

export function listAgentRefs(registry: AgentRegistry): InternalAgentRef[] {
	return bridgeFor(registry).list();
}

export function resolveAgentObservation(registry: AgentRegistry, observation: AgentRef): InternalAgentRef | undefined {
	return bridgeFor(registry).resolveObservation(observation);
}

export function getAgentRefOwnershipToken(
	registry: AgentRegistry,
	expected: InternalAgentRef | AgentRef,
): InternalAgentOwnershipToken | undefined {
	return bridgeFor(registry).ownershipToken(expected);
}

export function observeAgentRef(registry: AgentRegistry, ref: InternalAgentRef): AgentRef {
	return bridgeFor(registry).observe(ref);
}

export function bindInternalAgentAuthoritySession(
	registry: AgentRegistry,
	parent: AgentSession,
): AgentAuthoritySessionBinding | undefined {
	return bridgeFor(registry).bindAuthoritySession(parent);
}

export function lookupAgentAuthoritySession(
	registry: AgentRegistry,
	parent: AgentSession,
): InternalAgentRef | undefined {
	return bridgeFor(registry).lookupAuthoritySession(parent);
}

/** Bind only a live authority session; each parent lookup revalidates its exact registry lineage. */
export function bindAgentSessionRegistry(registry: AgentRegistry, session: AgentSession): boolean {
	const ref = lookupAgentAuthoritySession(registry, session);
	const lineage = ref?.lineage;
	if (!ref || !lineage) return false;
	const rootId = lineage.rootId;
	const rootRef = lookupAgentRef(registry, rootId);
	const rootSession = rootRef?.session;
	const rootLineage = rootRef?.lineage;
	if (
		!rootRef ||
		!rootSession ||
		!rootLineage ||
		rootRef.id !== rootId ||
		rootRef.kind !== "main" ||
		rootLineage.rootId !== rootId ||
		lookupAgentAuthoritySession(registry, rootSession) !== rootRef
	)
		return false;
	sessionRegistryBindings.set(session, {
		registry,
		ref,
		rootRef,
		rootId,
		actorGeneration: lineage.generation,
		rootGeneration: rootLineage.generation,
	});
	return true;
}

export function isSessionParentIrcSender(session: AgentSession, recipientId: string, senderId: string): boolean {
	const binding = sessionRegistryBindings.get(session);
	if (
		!binding ||
		lookupAgentRef(binding.registry, binding.ref.id) !== binding.ref ||
		binding.ref.session !== session ||
		binding.ref.lineage?.rootId !== binding.rootId ||
		binding.ref.lineage?.generation !== binding.actorGeneration ||
		lookupAgentRef(binding.registry, binding.rootId) !== binding.rootRef ||
		binding.rootRef.id !== binding.rootId ||
		binding.rootRef.lineage?.rootId !== binding.rootId ||
		binding.rootRef.lineage?.generation !== binding.rootGeneration
	)
		return false;
	return bridgeFor(binding.registry).isSessionParentIrcSender(session, recipientId, senderId);
}

export function lookupAgentAuthorityLineage(
	registry: AgentRegistry,
	parentId: string,
): { readonly rootId: string; readonly parentId: string } | undefined {
	return bridgeFor(registry).lookupAuthorityLineage(parentId);
}

export function resolveAgentSessionOperationAuthority(
	registry: AgentRegistry,
	parent: AgentSession,
): BoundSessionOperationAuthority | undefined {
	return bridgeFor(registry).operationAuthority(parent);
}

export function createAgentRootSession(
	registry: AgentRegistry,
	options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
	return bridgeFor(registry).createRootSession(options);
}

/** Commit history only while the exact registry generation still owns its slot. */
export function setAgentHistory(
	registry: AgentRegistry,
	expected: InternalAgentRef | AgentSession,
	history: AgentHistorySummary,
	expectedSessionFile?: string,
): boolean {
	return bridgeFor(registry).setHistory(expected, history, expectedSessionFile);
}

/** Accept a settled task result only while its exact session/ref still owns this registry generation. */
export function markAgentResultAccepted(
	registry: AgentRegistry,
	id: string,
	expected: InternalAgentRef | AgentSession,
	responseAt?: number,
): boolean {
	return bridgeFor(registry).markResultAccepted(id, expected, responseAt);
}

/** Update display-only activity only while the exact session/ref owns this generation. */
export function setAgentActivity(
	registry: AgentRegistry,
	id: string,
	activity: string,
	expected: InternalAgentRef | AgentSession,
): boolean {
	return bridgeFor(registry).setActivity(id, activity, expected);
}

export function setAgentStatus(
	registry: AgentRegistry,
	id: string,
	status: AgentStatus,
	expected: InternalAgentRef | AgentSession,
): boolean {
	return bridgeFor(registry).setStatus(id, status, expected);
}

export function attachAgentSession(
	registry: AgentRegistry,
	id: string,
	session: AgentSession,
	sessionFile: string | null | undefined,
	expected: InternalAgentRef | AgentSession,
): boolean {
	return bridgeFor(registry).attachSession(id, session, sessionFile, expected);
}

export function detachAgentSession(
	registry: AgentRegistry,
	id: string,
	expected: InternalAgentRef | AgentSession,
): boolean {
	return bridgeFor(registry).detachSession(id, expected);
}

export function parkAgentRef(
	registry: AgentRegistry,
	expectedRef: InternalAgentRef,
	expectedSession: AgentSession,
): boolean {
	return bridgeFor(registry).park(expectedRef, expectedSession);
}

export function abortAgentRef(
	registry: AgentRegistry,
	expectedRef: InternalAgentRef,
	expectedSession?: AgentSession,
): boolean {
	return bridgeFor(registry).abort(expectedRef, expectedSession);
}

export function removeAgentRef(registry: AgentRegistry, expectedRef: InternalAgentRef): boolean {
	return bridgeFor(registry).remove(expectedRef);
}

export function endAgentTermination(registry: AgentRegistry, expectedRef: InternalAgentRef): void {
	bridgeFor(registry).endTermination(expectedRef);
}

export function unregisterAgentRef(
	registry: AgentRegistry,
	id: string,
	expected: InternalAgentRef | AgentSession,
): boolean {
	return bridgeFor(registry).unregister(id, expected);
}

export function syncAgentSessionStatus(registry: AgentRegistry, id: string, session: AgentSession): () => void {
	return bridgeFor(registry).syncSessionStatus(id, session);
}

export function registerInternalAgent(registry: AgentRegistry, input: RegisterInput): InternalAgentRef {
	return bridgeFor(registry).register(input);
}

export function registerInternalAgentIfAvailable(
	registry: AgentRegistry,
	input: RegisterInput,
	expected: InternalAgentRef | null,
): InternalAgentRef | undefined {
	return bridgeFor(registry).registerIfAvailable(input, expected);
}

export function replaceInternalAgentIfAvailable(
	registry: AgentRegistry,
	input: RegisterInput,
	expected: InternalAgentRef | null,
): InternalAgentRef | undefined {
	return bridgeFor(registry).replaceIfAvailable(input, expected);
}
export function onInternalRegistryChange(
	registry: AgentRegistry,
	listener: (event: InternalRegistryEvent) => void,
): () => void {
	return bridgeFor(registry).onChange(listener);
}

export type { RegistryEvent };
