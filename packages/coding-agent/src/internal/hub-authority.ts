import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "../tools";
import { IrcBus } from "../irc/bus";
import { durableHubStoreForSession } from "./hub-durable-state";
import type { DurableHubStore } from "./hub-durable-state";
import {
	lookupAgentAuthoritySession,
	lookupAgentRef,
	resolveAgentSessionOperationAuthority,
} from "./agent-registry-bridge";
import { resolveToolSessionLifecycleAuthority } from "./agent-lifecycle-bridge";
import type { AgentRegistry } from "../registry/agent-registry";

export interface HubSessionAuthority {
	readonly registry: AgentRegistry;
	readonly owner: AgentSession;
	readonly actorId: string;
	readonly rootId: string;
	readonly bus: IrcBus;
}

export type HubSessionAccess =
	| { readonly kind: "authority"; readonly authority: HubSessionAuthority }
	| { readonly kind: "invalid" }
	| { readonly kind: "unavailable" };

export interface HubAdmissionAuthorityBinding {
	readonly capability: unknown;
	readonly actorId: string;
	readonly rootId: string;
	readonly generation: unknown;
	readonly sessionFile: string | null | undefined;
	validate(): boolean;
}

interface HubAuthorityRootBinding {
	readonly sessionFile: string | null | undefined;
	readonly durableStore?: DurableHubStore;
}

const hubSessionAuthorities = new WeakSet<object>();
const authorityRootByDurableStore = new WeakMap<DurableHubStore, { registry: AgentRegistry; rootId: string }>();
const rootBindingByHubAuthority = new WeakMap<object, HubAuthorityRootBinding>();
const operationAuthorityByHubAuthority = new WeakMap<object, HubAdmissionAuthorityBinding>();

function resolveBoundAuthority(
	session: ToolSession,
	registry: AgentRegistry,
	actorId: string,
): HubSessionAuthority | undefined {
	const ref = lookupAgentRef(registry, actorId);
	const owner = ref?.session;
	const rootId = ref?.lineage?.rootId;
	if (!ref || !owner || !rootId || ref.status === "aborted" || owner.isDisposed) return undefined;
	if (lookupAgentAuthoritySession(registry, owner) !== ref) return undefined;
	if (session.getSessionFile?.() !== ref.sessionFile) return undefined;
	const rootRef = lookupAgentRef(registry, rootId);
	const rootOwner = rootRef?.session;
	if (
		!rootRef ||
		!rootOwner ||
		rootRef.lineage?.rootId !== rootId ||
		rootRef.status === "aborted" ||
		rootOwner.isDisposed ||
		lookupAgentAuthoritySession(registry, rootOwner) !== rootRef
	) {
		return undefined;
	}
	const operationAuthority = resolveAgentSessionOperationAuthority(registry, owner);
	if (
		!operationAuthority ||
		!operationAuthority.validate() ||
		operationAuthority.actorId !== actorId ||
		operationAuthority.rootId !== rootId ||
		operationAuthority.sessionFile !== ref.sessionFile
	) {
		return undefined;
	}
	const rootSessionFile = rootRef.sessionFile;
	let durableStore: DurableHubStore | undefined;
	if (rootSessionFile) {
		const candidate = durableHubStoreForSession(rootSessionFile);
		const claimedRoot = authorityRootByDurableStore.get(candidate);
		if (claimedRoot && (claimedRoot.registry !== registry || claimedRoot.rootId !== rootId)) return undefined;
		if (!claimedRoot) authorityRootByDurableStore.set(candidate, { registry, rootId });
		durableStore = candidate;
	}
	const authority = Object.freeze({ registry, owner, actorId, rootId, bus: IrcBus.forRoot(registry, rootId) });
	hubSessionAuthorities.add(authority);
	rootBindingByHubAuthority.set(authority, {
		sessionFile: rootSessionFile,
		...(durableStore ? { durableStore } : {}),
	});
	operationAuthorityByHubAuthority.set(authority, operationAuthority);
	return authority;
}

export function resolveHubSessionAuthority(session: ToolSession): HubSessionAuthority | undefined {
	const registry = session.agentRegistry;
	const actorId = session.getAgentId?.() ?? undefined;
	if (!registry || !actorId || !resolveToolSessionLifecycleAuthority(session)) return undefined;
	return resolveBoundAuthority(session, registry, actorId);
}

export function resolveHubSessionAccess(session: ToolSession): HubSessionAccess {
	const hasBinding = Boolean(resolveToolSessionLifecycleAuthority(session));
	if (!hasBinding) {
		// Caller-supplied registry and actor id hints do not establish Hub
		// authority. Direct/unregistered SDK sessions are permanently unavailable
		// for peer coordination and owner-scoped job control; do not even consult
		// those hints while resolving unbound access.
		return { kind: "unavailable" };
	}
	const registry = session.agentRegistry;
	const actorId = session.getAgentId?.() ?? undefined;
	if (!registry || !actorId) return { kind: "invalid" };
	const authority = resolveBoundAuthority(session, registry, actorId);
	return authority ? { kind: "authority", authority } : { kind: "invalid" };
}

export function isHubSessionAuthority(value: unknown): value is HubSessionAuthority {
	return typeof value === "object" && value !== null && hubSessionAuthorities.has(value);
}

export function resolveHubAuthorityDurableStore(authority: HubSessionAuthority): DurableHubStore | undefined {
	if (!isHubSessionAuthority(authority)) return undefined;
	return rootBindingByHubAuthority.get(authority)?.durableStore;
}

export function resolveHubAdmissionAuthority(authority: HubSessionAuthority): HubAdmissionAuthorityBinding | undefined {
	if (!isHubSessionAuthority(authority)) return undefined;
	const binding = operationAuthorityByHubAuthority.get(authority);
	return binding?.validate() ? binding : undefined;
}

/** Verify that the authority's caller and registry generation remain unchanged. */
export function isHubSessionAuthorityLive(authority: HubSessionAuthority, session: ToolSession): boolean {
	if (!isHubSessionAuthority(authority) || session.isDisposed?.() === true) return false;
	if (session.agentRegistry !== authority.registry || session.getAgentId?.() !== authority.actorId) return false;
	if (!resolveHubAdmissionAuthority(authority)) return false;
	const rootBinding = rootBindingByHubAuthority.get(authority);
	const ref = lookupAgentRef(authority.registry, authority.actorId);
	const rootRef = lookupAgentRef(authority.registry, authority.rootId);
	return Boolean(
		ref &&
		ref.session === authority.owner &&
		ref.lineage?.rootId === authority.rootId &&
		lookupAgentAuthoritySession(authority.registry, authority.owner) === ref &&
		ref.sessionFile === session.getSessionFile?.() &&
		rootRef &&
		rootRef.session &&
		rootRef.status !== "aborted" &&
		!rootRef.session.isDisposed &&
		rootRef.lineage?.rootId === authority.rootId &&
		lookupAgentAuthoritySession(authority.registry, rootRef.session) === rootRef &&
		rootBinding &&
		rootRef.sessionFile === rootBinding.sessionFile,
	);
}

export function sameHubRoot(authority: HubSessionAuthority, id: string): boolean {
	return lookupAgentRef(authority.registry, id)?.lineage?.rootId === authority.rootId;
}
