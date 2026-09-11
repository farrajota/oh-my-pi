import {
	AgentLifecycleManager,
	type AdoptOptions,
	type PersistedSubagentReviverFactory,
} from "../registry/agent-lifecycle";
import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { getAgentLifecycleCapability } from "./agent-lifecycle-capability";
import {
	lookupAgentAuthoritySession,
	lookupAgentRef,
	resolveAgentObservation,
	type InternalAgentRef,
} from "./agent-registry-bridge";
const lifecycleCapability = getAgentLifecycleCapability();
const managerRegistries = new WeakMap<AgentLifecycleManager, AgentRegistry>();
const registryManagers = new WeakMap<AgentRegistry, AgentLifecycleManager>();
const sessionLifecycleOwners = new WeakMap<AgentSession, AgentLifecycleManager>();
const lifecycleOwnerSessions = new WeakMap<AgentLifecycleManager, Set<AgentSession>>();
const toolSessionLifecycleOwners = new WeakMap<object, { registry: AgentRegistry; owner: AgentSession }>();

export function createAgentLifecycleManager(registry: AgentRegistry): AgentLifecycleManager {
	const manager = new AgentLifecycleManager(registry, lifecycleCapability);
	managerRegistries.set(manager, registry);
	return manager;
}

export function getAgentLifecycleManager(registry: AgentRegistry = AgentRegistry.global()): AgentLifecycleManager {
	const existing = registryManagers.get(registry);
	if (existing) return existing;
	const manager = createAgentLifecycleManager(registry);
	registryManagers.set(registry, manager);
	return manager;
}

function registryFor(manager: AgentLifecycleManager): AgentRegistry {
	const registry = managerRegistries.get(manager);
	if (!registry) throw new Error("Agent lifecycle manager is not internally owned.");
	return registry;
}

function resolveExpected(
	manager: AgentLifecycleManager,
	expected: AgentRef | InternalAgentRef | AgentSession,
): InternalAgentRef | AgentSession | undefined {
	if (!("id" in expected) || !("status" in expected)) return expected as AgentSession;
	const registry = registryFor(manager);
	const exact = lookupAgentRef(registry, expected.id);
	if (exact === expected) return exact;
	return resolveAgentObservation(registry, expected);
}

export function setPersistedAgentReviverFactory(
	manager: AgentLifecycleManager,
	factory: PersistedSubagentReviverFactory,
	idleTtlMs: number,
): void {
	manager.setPersistedSubagentReviverFactory(factory, idleTtlMs, lifecycleCapability);
}

export function adoptAgent(
	manager: AgentLifecycleManager,
	id: string,
	opts: AdoptOptions,
	expected: AgentRef | InternalAgentRef | AgentSession,
): void {
	const exact = resolveExpected(manager, expected);
	if (!exact) return;
	manager.adopt(id, opts, exact, lifecycleCapability);
}

export function lifecycleHasAgent(
	manager: AgentLifecycleManager,
	id: string,
	expected?: AgentRef | InternalAgentRef | AgentSession,
): boolean {
	if (expected === undefined) return manager.has(id, undefined, lifecycleCapability);
	const exact = resolveExpected(manager, expected);
	return exact ? manager.has(id, exact, lifecycleCapability) : false;
}

export function lifecycleManagesRegistry(manager: AgentLifecycleManager, registry: AgentRegistry): boolean {
	return manager.manages(registry, lifecycleCapability);
}

export function isAgentParking(
	manager: AgentLifecycleManager,
	id: string,
	expected?: AgentRef | InternalAgentRef | AgentSession,
): boolean {
	if (expected === undefined) return manager.isParking(id, undefined, lifecycleCapability);
	const exact = resolveExpected(manager, expected);
	return exact ? manager.isParking(id, exact, lifecycleCapability) : false;
}

export function parkAgent(manager: AgentLifecycleManager, id: string): Promise<void> {
	return manager.park(id, lifecycleCapability);
}

export function ensureAgentLive(manager: AgentLifecycleManager, id: string): Promise<AgentSession> {
	return manager.ensureLive(id, lifecycleCapability);
}

export function reclaimDeadAgent(
	manager: AgentLifecycleManager,
	id: string,
	expected: AgentRef | InternalAgentRef,
): Promise<boolean> {
	const exact = resolveExpected(manager, expected);
	return exact && "id" in exact ? manager.reclaimDeadCorpse(id, exact, lifecycleCapability) : Promise.resolve(false);
}

export function releaseAgent(
	manager: AgentLifecycleManager,
	id: string,
	expected: AgentRef | InternalAgentRef | AgentSession,
	options?: { tombstone?: boolean },
): Promise<boolean> {
	const exact = resolveExpected(manager, expected);
	return exact ? manager.release(id, exact, options, lifecycleCapability) : Promise.resolve(false);
}

export function registerToolSessionLifecycleAuthority(
	toolSession: object,
	registry: AgentRegistry,
	owner: AgentSession,
): void {
	toolSessionLifecycleOwners.set(toolSession, { registry, owner });
}

export function resolveToolSessionLifecycleAuthority(toolSession: object): AgentLifecycleManager | undefined {
	const binding = toolSessionLifecycleOwners.get(toolSession);
	if (!binding || !lookupAgentAuthoritySession(binding.registry, binding.owner)) return undefined;
	return getAgentLifecycleManager(binding.registry);
}

export function bindOwnedAgentLifecycle(
	registry: AgentRegistry,
	session: AgentSession,
): AgentLifecycleManager | undefined {
	const ref = lookupAgentAuthoritySession(registry, session);
	if (!ref || ref.kind !== "main" || ref.parentId !== undefined || ref.lineage?.rootId !== ref.id) return undefined;
	const manager = getAgentLifecycleManager(registry);
	const owners = lifecycleOwnerSessions.get(manager) ?? new Set<AgentSession>();
	owners.add(session);
	lifecycleOwnerSessions.set(manager, owners);
	sessionLifecycleOwners.set(session, manager);
	return manager;
}

export function replaceOwnedAgentLifecycle(
	registry: AgentRegistry,
	previous: AgentSession,
	replacement: AgentSession,
): AgentLifecycleManager | undefined {
	const manager = bindOwnedAgentLifecycle(registry, replacement);
	if (!manager) return undefined;
	sessionLifecycleOwners.delete(previous);
	lifecycleOwnerSessions.get(manager)?.delete(previous);
	return manager;
}

export function lookupOwnedAgentLifecycle(session: AgentSession): AgentLifecycleManager | undefined {
	return sessionLifecycleOwners.get(session);
}

export function disposeOwnedAgentLifecycle(
	manager: AgentLifecycleManager,
	deadlineAt?: number,
): Promise<void> | undefined {
	const registry = managerRegistries.get(manager);
	if (!registry || registryManagers.get(registry) !== manager) return undefined;
	return disposeAgentLifecycle(manager, deadlineAt);
}
export async function disposeAgentLifecycle(manager: AgentLifecycleManager, deadlineAt?: number): Promise<void> {
	try {
		await manager.dispose(deadlineAt, lifecycleCapability);
	} finally {
		const owners = lifecycleOwnerSessions.get(manager);
		if (owners) for (const owner of owners) sessionLifecycleOwners.delete(owner);
		lifecycleOwnerSessions.delete(manager);
		const registry = managerRegistries.get(manager);
		if (registry && registryManagers.get(registry) === manager) registryManagers.delete(registry);
		managerRegistries.delete(manager);
	}
}

export function resetAgentLifecycleForTests(): void {
	const registry = AgentRegistry.global();
	const manager = registryManagers.get(registry);
	if (!manager) return;
	manager.resetForTests(lifecycleCapability);
	const owners = lifecycleOwnerSessions.get(manager);
	if (owners) for (const owner of owners) sessionLifecycleOwners.delete(owner);
	lifecycleOwnerSessions.delete(manager);
	registryManagers.delete(registry);
	managerRegistries.delete(manager);
}
