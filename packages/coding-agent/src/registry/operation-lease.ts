import { AsyncLocalStorage } from "node:async_hooks";
import { type DurableOperationRecord, RegistryDurableStateStore } from "./durable-state";
export type EffectClass = "eval" | "mcp" | "job" | "filesystem" | "local" | "artifact" | "extension" | "session";

export type OperationTerminalStatus = "completed" | "failed" | "abandoned";

export interface OperationLease {
	readonly operationId: string;
	readonly effectClass: EffectClass;
	readonly ownerId: string;
	readonly classOwnerId: string;
	readonly actorId?: string;
	readonly rootId?: string;
	readonly generation?: number;
	readonly acquiredAt: number;
	readonly expiresAt: number;
}

export interface OperationTerminalRecord {
	readonly operationId: string;
	readonly effectClass: EffectClass;
	readonly ownerId: string;
	readonly classOwnerId: string;
	readonly actorId?: string;
	readonly rootId?: string;
	readonly generation?: number;
	readonly status: OperationTerminalStatus;
	readonly at: number;
	readonly detail?: string;
}

type OperationAdmission =
	| { readonly ok: true; readonly lease: OperationLease }
	| { readonly ok: false; readonly reason: "already-active" | "terminal" | "invalid-lease" | "quiesced" };

const DEFAULT_LEASE_MS = 5 * 60_000;
const operationRegistries = new WeakMap<object, OperationLeaseRegistry>();
const sessionOperationLedgerStates = new WeakMap<object, SessionOperationLedgerState>();
const issuedOperationAuthorityManagers = new WeakMap<BoundSessionOperationAuthority, object>();
const quiescedRegistries = new WeakMap<OperationLeaseRegistry, MigrationFenceController>();
const operationDurableStores = new WeakMap<OperationLeaseRegistry, RegistryDurableStateStore>();
const sessionDurableStores = new WeakMap<object, RegistryDurableStateStore>();
let nextOperationOwnerId = 1;
const operationLeaseContext = new AsyncLocalStorage<{ registry: OperationLeaseRegistry; lease: OperationLease }>();

const boundSessionOperationAuthorityBrand: unique symbol = Symbol("boundSessionOperationAuthority");

export interface BoundSessionOperationAuthority {
	readonly [boundSessionOperationAuthorityBrand]: true;
	readonly capability: object;
	readonly actorId: string;
	readonly rootId: string;
	readonly generation: number;
	readonly sessionFile: string | null;
	readonly validate: () => boolean;
}

interface BoundSessionOperationAuthorityInput {
	readonly capability: object;
	readonly actorId: string;
	readonly rootId: string;
	readonly generation: number;
	readonly sessionFile: string | null;
	readonly validate: () => boolean;
}

type SessionOperationAuthority =
	| { readonly kind: "projection"; readonly restricted: boolean }
	| { readonly kind: "bound"; readonly authority: BoundSessionOperationAuthority };

const operationAuthorities = new WeakMap<OperationLeaseRegistry, SessionOperationAuthority>();

interface SessionOperationLedgerState {
	current: OperationLeaseRegistry;
	readonly owned: Set<OperationLeaseRegistry>;
	closed: boolean;
}

/** Internal non-Hub ledger. Callers enter it only through class-fixed manager wrappers below. */
interface ActiveOperation {
	readonly lease: OperationLease;
	readonly controller: AbortController;
	settled: boolean;
	abandonReason?: string;
}

class OperationLeaseRegistry {
	readonly #ownerId: string;
	readonly #active = new Map<string, ActiveOperation>();
	readonly #terminals = new Map<string, OperationTerminalRecord>();
	#closed = false;
	#drainPromise: Promise<void> | undefined;
	#resolveDrain: (() => void) | undefined;

	constructor(ownerId: string) {
		if (!ownerId.trim()) throw new Error("Owner id is required.");
		this.#ownerId = ownerId;
	}

	#authority(effectClass: EffectClass): BoundSessionOperationAuthority | undefined {
		const binding = operationAuthorities.get(this);
		if (!binding) throw new Error("Operation ledger has no session authority capability.");
		if (binding.kind === "projection") {
			if (binding.restricted) throw new Error("Restricted operation requires exact bound session authority.");
			return undefined;
		}
		if (!binding.authority.validate())
			throw new Error("Bound session operation authority is stale or no longer current.");
		if (
			!binding.authority.actorId.trim() ||
			!binding.authority.rootId.trim() ||
			!Number.isSafeInteger(binding.authority.generation)
		) {
			throw new Error("Bound session operation authority is invalid.");
		}
		void effectClass;
		return binding.authority;
	}

	#recordDurable(lease: OperationLease, phase: DurableOperationRecord["phase"], now = Date.now()): void {
		const store = operationDurableStores.get(this);
		if (!store || lease.effectClass === "artifact" || lease.effectClass === "job") return;
		store.append({
			kind: "operation",
			at: now,
			operationId: lease.operationId,
			effectClass: lease.effectClass,
			ownerId: lease.ownerId,
			classOwnerId: lease.classOwnerId,
			...(lease.actorId === undefined ? {} : { actorId: lease.actorId }),
			...(lease.rootId === undefined ? {} : { rootId: lease.rootId }),
			...(lease.generation === undefined ? {} : { generation: lease.generation }),
			acquiredAt: lease.acquiredAt,
			expiresAt: lease.expiresAt,
			phase,
		});
	}

	#admit(effectClass: EffectClass, operationId: string, leaseMs: number, now = Date.now()): OperationAdmission {
		if (quiescedRegistries.has(this)) return { ok: false, reason: "quiesced" };
		const authority = this.#authority(effectClass);
		if (this.#closed || this.#terminals.has(operationId)) return { ok: false, reason: "terminal" };
		if (!Number.isFinite(leaseMs) || leaseMs <= 0) return { ok: false, reason: "invalid-lease" };
		const active = this.#active.get(operationId);
		if (active) {
			if (active.lease.expiresAt > now) return { ok: false, reason: "already-active" };
			active.abandonReason = "Operation lease expired";
			active.controller.abort(new Error("Operation lease expired"));
			this.#recordTerminal(active.lease, "abandoned", active.abandonReason, now);
			return { ok: false, reason: "terminal" };
		}
		const lease = Object.freeze({
			operationId,
			effectClass,
			ownerId: this.#ownerId,
			classOwnerId: `${this.#ownerId}:${effectClass}`,
			...(authority
				? { actorId: authority.actorId, rootId: authority.rootId, generation: authority.generation }
				: {}),
			acquiredAt: now,
			expiresAt: now + leaseMs,
		});
		this.#recordDurable(lease, "intent", now);
		this.#active.set(operationId, { lease, controller: new AbortController(), settled: false });
		return { ok: true, lease };
	}

	#recordTerminal(
		lease: OperationLease,
		status: OperationTerminalStatus,
		detail?: string,
		now = Date.now(),
	): OperationTerminalRecord {
		const existing = this.#terminals.get(lease.operationId);
		if (existing) return existing;
		this.#recordDurable(lease, status, now);
		const record = Object.freeze({
			operationId: lease.operationId,
			effectClass: lease.effectClass,
			ownerId: lease.ownerId,
			classOwnerId: lease.classOwnerId,
			...(lease.actorId === undefined ? {} : { actorId: lease.actorId }),
			...(lease.rootId === undefined ? {} : { rootId: lease.rootId }),
			...(lease.generation === undefined ? {} : { generation: lease.generation }),
			status,
			at: now,
			...(detail ? { detail } : {}),
		});
		this.#terminals.set(lease.operationId, record);
		return record;
	}

	#terminal(operation: ActiveOperation, status: OperationTerminalStatus, detail?: string): void {
		if (status === "completed" && !this.#terminals.has(operation.lease.operationId)) {
			this.#recordDurable(operation.lease, "committed");
		}
		if (!this.#terminals.has(operation.lease.operationId)) this.#recordTerminal(operation.lease, status, detail);
		if (operation.settled) return;
		operation.settled = true;
		this.#active.delete(operation.lease.operationId);
		this.#maybeResolveDrain();
	}

	#throwIfStale(operation: ActiveOperation): void {
		const recorded = this.#terminals.get(operation.lease.operationId);
		if (recorded?.detail === "Operation lease expired") {
			throw new Error(`Operation ${operation.lease.effectClass} lease expired.`);
		}
		if (operation.abandonReason || recorded?.status === "abandoned") {
			throw new Error(
				`Operation ${operation.lease.effectClass} cancelled: ${operation.abandonReason ?? recorded?.detail ?? "abandoned"}.`,
			);
		}
		if (operation.controller.signal.aborted) {
			operation.abandonReason = "Operation cancelled";
			throw new Error(`Operation ${operation.lease.effectClass} cancelled.`);
		}
		if (Date.now() >= operation.lease.expiresAt) {
			operation.abandonReason = "Operation lease expired";
			operation.controller.abort(new Error(operation.abandonReason));
			this.#recordTerminal(operation.lease, "abandoned", operation.abandonReason);
			throw new Error(`Operation ${operation.lease.effectClass} lease expired.`);
		}
	}

	async #run<T>(
		effectClass: EffectClass,
		operationId: string,
		run: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const admission = this.#admit(effectClass, operationId, DEFAULT_LEASE_MS);
		if (!admission.ok) throw new Error(`Operation ${effectClass} was not admitted: ${admission.reason}`);
		const operation = this.#active.get(admission.lease.operationId);
		if (!operation) throw new Error("Operation lease was not registered.");
		const relayAbort = () => operation.controller.abort(signal?.reason);
		if (signal?.aborted) relayAbort();
		else signal?.addEventListener("abort", relayAbort, { once: true });
		try {
			this.#recordDurable(operation.lease, "effect");
			operation.controller.signal.throwIfAborted();
			const value = await operationLeaseContext.run({ registry: this, lease: operation.lease }, () =>
				run(operation.controller.signal),
			);
			this.#throwIfStale(operation);
			this.#terminal(operation, "completed");
			return value;
		} catch (error) {
			const staleError = (() => {
				try {
					this.#throwIfStale(operation);
					return undefined;
				} catch (stale) {
					return stale instanceof Error ? stale : new Error(String(stale));
				}
			})();
			if (staleError) {
				this.#terminal(operation, "abandoned", operation.abandonReason ?? staleError.message);
				throw staleError;
			}
			const detail = error instanceof Error ? error.message : String(error);
			const abandoned = operation.controller.signal.aborted || signal?.aborted;
			this.#terminal(operation, abandoned ? "abandoned" : "failed", detail);
			throw error;
		} finally {
			signal?.removeEventListener("abort", relayAbort);
		}
	}

	runEval<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("eval", operationId, run, signal);
	}
	runMcp<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("mcp", operationId, run, signal);
	}
	runJob<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("job", operationId, run, signal);
	}
	runFilesystem<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("filesystem", operationId, run, signal);
	}
	runLocal<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("local", operationId, run, signal);
	}
	runArtifact<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("artifact", operationId, run, signal);
	}
	runExtension<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("extension", operationId, run, signal);
	}
	runSession<T>(operationId: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#run("session", operationId, run, signal);
	}

	quiesce(): Promise<void> {
		for (const operation of this.#active.values()) {
			operation.abandonReason ??= "Session disposed";
			operation.controller.abort(new Error(operation.abandonReason));
		}
		return this.#awaitDrain();
	}

	close(): Promise<void> {
		this.#closed = true;
		return this.quiesce();
	}

	#awaitDrain(): Promise<void> {
		if (this.#active.size === 0) return Promise.resolve();
		if (!this.#drainPromise) {
			this.#drainPromise = new Promise<void>(resolve => {
				this.#resolveDrain = resolve;
			});
		}
		return this.#drainPromise;
	}

	#maybeResolveDrain(): void {
		if (this.#active.size !== 0) return;
		this.#resolveDrain?.();
		this.#resolveDrain = undefined;
		this.#drainPromise = undefined;
	}

	activeCount(): number {
		return this.#active.size;
	}

	getTerminal(operationId: string): OperationTerminalRecord | undefined {
		return this.#terminals.get(operationId);
	}
}

interface SessionOperationControl {
	close(): Promise<void>;
}

function projectionOwnerId(): string {
	return `session-projection:${nextOperationOwnerId++}`;
}

function boundOwnerId(authority: BoundSessionOperationAuthority): string {
	return `session-actor:${authority.rootId}:${authority.actorId}:${authority.generation}`;
}

function createSessionOperationLedger(manager: object): SessionOperationLedgerState {
	const registry = new OperationLeaseRegistry(projectionOwnerId());
	const state: SessionOperationLedgerState = { current: registry, owned: new Set([registry]), closed: false };
	operationRegistries.set(manager, registry);
	sessionOperationLedgerStates.set(manager, state);
	operationAuthorities.set(registry, Object.freeze({ kind: "projection", restricted: true }));
	return state;
}

/** @internal Installs the private ledger owned by one AgentSession. */
export function installSessionOperationLedger(manager: object): SessionOperationControl {
	if (sessionOperationLedgerStates.has(manager)) throw new Error("Session manager already owns an operation ledger.");
	const state = createSessionOperationLedger(manager);
	let closePromise: Promise<void> | undefined;
	return Object.freeze({
		close: () => {
			state.closed = true;
			closePromise ??= Promise.all([...state.owned].map(registry => registry.close())).then(() => undefined);
			return closePromise;
		},
	});
}

/** @internal Bind one session ledger to the registry-owned durable journal without exposing it through SDK payloads. */
export function bindSessionOperationDurability(manager: object, store: RegistryDurableStateStore): void {
	const state = sessionOperationLedgerStates.get(manager);
	if (!state || state.closed) throw new Error("Session operation durability requires an open installed ledger.");
	sessionDurableStores.set(manager, store);
	for (const registry of state.owned) operationDurableStores.set(registry, store);
}

/** @internal Marks a public SDK session projection without granting actor authority. */
export function markUnregisteredSessionOperationProjection(manager: object, restricted: boolean): void {
	const registry = operationRegistries.get(manager);
	if (!registry) throw new Error("Session operation projection requires an installed operation ledger.");
	const current = operationAuthorities.get(registry);
	if (current?.kind === "bound")
		throw new Error("Bound session operation authority cannot be downgraded to a projection.");
	operationAuthorities.set(registry, Object.freeze({ kind: "projection", restricted }));
}

/** @internal Sole opaque issuer used by the hidden registry bridge. */
export function issueBoundSessionOperationAuthority(
	authority: BoundSessionOperationAuthorityInput,
	manager: object,
): BoundSessionOperationAuthority {
	const issued: BoundSessionOperationAuthority = Object.freeze({
		...authority,
		[boundSessionOperationAuthorityBrand]: true as const,
	});
	issuedOperationAuthorityManagers.set(issued, manager);
	return issued;
}

/** @internal Binds this exact manager ledger to one registry-owned actor generation. */
export function bindSessionOperationAuthority(manager: object, authority: BoundSessionOperationAuthority): void {
	if (issuedOperationAuthorityManagers.get(authority) !== manager)
		throw new Error("Session operation authority belongs to a different session manager.");
	if (!authority.validate()) throw new Error("Cannot bind stale session operation authority.");
	let state = sessionOperationLedgerStates.get(manager);
	if (!state) {
		const registry = new OperationLeaseRegistry(boundOwnerId(authority));
		state = { current: registry, owned: new Set([registry]), closed: false };
		operationRegistries.set(manager, registry);
		sessionOperationLedgerStates.set(manager, state);
		operationAuthorities.set(registry, Object.freeze({ kind: "bound", authority }));
		const store = sessionDurableStores.get(manager);
		if (store) operationDurableStores.set(registry, store);
		return;
	}
	const ledgerState = state;
	if (ledgerState.closed) throw new Error("Cannot bind authority to a closed session operation ledger.");
	const previousRegistry = ledgerState.current;
	const currentAuthority = operationAuthorities.get(previousRegistry);
	if (currentAuthority?.kind === "bound") {
		if (currentAuthority.authority === authority) return;
		if (currentAuthority.authority.validate())
			throw new Error("Session operation authority is already bound to another actor generation.");
	}
	void previousRegistry.close().then(() => ledgerState.owned.delete(previousRegistry));
	const registry = new OperationLeaseRegistry(boundOwnerId(authority));
	operationAuthorities.set(registry, Object.freeze({ kind: "bound", authority }));
	const store = sessionDurableStores.get(manager);
	if (store) operationDurableStores.set(registry, store);
	ledgerState.current = registry;
	ledgerState.owned.add(registry);
	operationRegistries.set(manager, registry);
}

function registryFor(manager: object | undefined): OperationLeaseRegistry | undefined {
	return manager === undefined ? undefined : operationRegistries.get(manager);
}

function runClassFixedOperation<T>(
	manager: object | undefined,
	invoke: (registry: OperationLeaseRegistry) => Promise<T>,
): Promise<T> {
	const registry = registryFor(manager);
	if (!registry) throw new Error("Operation requires an installed session operation ledger.");
	return invoke(registry);
}

/** @internal Exact effect lease active in this async invocation, if any. */
export function getActiveOperationLease(
	manager: object | undefined,
	operationId: string,
	effectClass?: EffectClass,
): OperationLease | undefined {
	const registry = registryFor(manager);
	const active = operationLeaseContext.getStore();
	if (!registry || active?.registry !== registry || active.lease.operationId !== operationId) return undefined;
	if (effectClass !== undefined && active.lease.effectClass !== effectClass) return undefined;
	const authority = operationAuthorities.get(registry);
	if (authority?.kind === "bound" && !authority.authority.validate()) return undefined;
	if (authority?.kind === "projection" && authority.restricted) return undefined;
	return active.lease;
}

export interface ActiveOperationDurability {
	readonly store: RegistryDurableStateStore;
	readonly lease: OperationLease;
}

/** @internal Durable resource hook for the exact active operation only. */
export function getActiveOperationDurability(
	manager: object | undefined,
	operationId: string,
	effectClass?: EffectClass,
): ActiveOperationDurability | undefined {
	const registry = registryFor(manager);
	if (!registry) return undefined;
	const lease = getActiveOperationLease(manager, operationId, effectClass);
	const store = operationDurableStores.get(registry);
	return lease && store ? Object.freeze({ store, lease }) : undefined;
}

/** @internal */
export function runEvalOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runEval(operationId, run, signal));
}
/** @internal */
export function runMcpOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runMcp(operationId, run, signal));
}
/** @internal */
export function runJobOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runJob(operationId, run, signal));
}
/** @internal */
export function runFilesystemOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runFilesystem(operationId, run, signal));
}

/** @internal Bound restricted filesystem calls must never execute without their session ledger. */
export function runBoundFilesystemOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const registry = registryFor(manager);
	if (!registry) throw new Error("Bound filesystem operation requires an installed session operation ledger.");
	return registry.runFilesystem(operationId, run, signal);
}
/** @internal */
export function runLocalOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runLocal(operationId, run, signal));
}
/** @internal */
export function runArtifactOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runArtifact(operationId, run, signal));
}
/** @internal */
export function runExtensionOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runExtension(operationId, run, signal));
}
/** @internal */
export function runSessionOperation<T>(
	manager: object | undefined,
	operationId: string,
	run: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return runClassFixedOperation(manager, registry => registry.runSession(operationId, run, signal));
}

/** @internal Read-only migration/test observation; no authority mutation is exposed. */
export function getOperationTerminal(
	manager: object | undefined,
	operationId: string,
): OperationTerminalRecord | undefined {
	return registryFor(manager)?.getTerminal(operationId);
}

declare const rootMigrationFenceBrand: unique symbol;

export interface RootMigrationFence {
	readonly [rootMigrationFenceBrand]: never;
	readonly rootId: string;
	readonly token: string;
	readonly state: "open" | "quiesced" | "validated" | "committed" | "activated" | "recovered";
}

/** @internal Registry-only root replacement fence; never re-exported through the SDK. */
export class MigrationFenceController {
	#fence: RootMigrationFence | undefined;
	readonly #operations = new Set<OperationLeaseRegistry>();

	open(rootId: string, token: string): RootMigrationFence {
		if (!rootId.trim() || !token.trim()) throw new Error("Root id and migration token are required.");
		if (this.#fence && this.#fence.state !== "activated" && this.#fence.state !== "recovered")
			throw new Error("A root migration is already active.");
		this.#fence = Object.freeze({ rootId, token, state: "open" }) as RootMigrationFence;
		return this.#fence;
	}
	async quiesce(fence: RootMigrationFence, managers: object | readonly object[]): Promise<RootMigrationFence> {
		if (fence.state !== "open" && fence.state !== "quiesced")
			throw new Error("Migration fence must be open or quiesced.");
		this.#assert(fence, fence.state);
		const values = Array.isArray(managers) ? managers : [managers];
		if (values.length === 0) throw new Error("Root migration requires at least one session-owned operation ledger.");
		const operations = values.map(manager => {
			const registry = registryFor(manager);
			if (!registry) throw new Error("Root migration requires a session-owned operation ledger.");
			const currentController = quiescedRegistries.get(registry);
			if (currentController && currentController !== this)
				throw new Error("Operation ledger is quiesced by another migration controller.");
			return registry;
		});
		for (const operation of operations) {
			this.#operations.add(operation);
			quiescedRegistries.set(operation, this);
		}
		await Promise.all(operations.map(operation => operation.quiesce()));
		this.#fence = Object.freeze({
			rootId: fence.rootId,
			token: fence.token,
			state: "quiesced",
		}) as RootMigrationFence;
		return this.#fence;
	}

	validate(fence: RootMigrationFence): RootMigrationFence {
		this.#assert(fence, "quiesced");
		this.#assertDrained();
		this.#fence = Object.freeze({
			rootId: fence.rootId,
			token: fence.token,
			state: "validated",
		}) as RootMigrationFence;
		return this.#fence;
	}

	assertValidated(fence: RootMigrationFence, rootId: string, manager?: object): void {
		this.#assert(fence, "validated");
		if (fence.rootId !== rootId) throw new Error("Migration fence belongs to another root.");
		if (manager !== undefined) {
			const operations = registryFor(manager);
			if (!operations || !this.#operations.has(operations))
				throw new Error("Migration fence belongs to another operation ledger.");
		}
	}

	commit(fence: RootMigrationFence): RootMigrationFence {
		this.#assert(fence, "validated");
		this.#assertDrained();
		this.#fence = Object.freeze({
			rootId: fence.rootId,
			token: fence.token,
			state: "committed",
		}) as RootMigrationFence;
		return this.#fence;
	}

	activate(fence: RootMigrationFence): RootMigrationFence {
		this.#assert(fence, "committed");
		this.#assertDrained();
		this.#fence = Object.freeze({
			rootId: fence.rootId,
			token: fence.token,
			state: "activated",
		}) as RootMigrationFence;
		return this.#fence;
	}

	recover(fence: RootMigrationFence): RootMigrationFence {
		if (fence.state === "activated") throw new Error("Activated root migrations cannot be recovered.");
		this.#assert(fence, fence.state);
		this.#assertDrained();
		for (const operations of this.#operations) {
			if (quiescedRegistries.get(operations) === this) quiescedRegistries.delete(operations);
		}
		this.#operations.clear();
		this.#fence = Object.freeze({
			rootId: fence.rootId,
			token: fence.token,
			state: "recovered",
		}) as RootMigrationFence;
		return this.#fence;
	}

	#assert(fence: RootMigrationFence, state: RootMigrationFence["state"]): void {
		if (this.#fence !== fence || fence.state !== state) throw new Error(`Migration fence must be ${state}.`);
	}

	#assertDrained(): void {
		for (const operations of this.#operations) {
			if (operations.activeCount() !== 0)
				throw new Error("Root migration requires every operation lease to drain before transition.");
		}
	}
}
