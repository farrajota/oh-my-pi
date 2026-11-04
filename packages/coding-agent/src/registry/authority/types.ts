import type { AuthorityExportView } from "./export-stream";
import type {
	DurableActorRecord,
	DurableConstructionRecord,
	DurableGateRecord,
	DurableJournalRecord,
	DurableLocalBackingExpectation,
	DurableLocalEntryRecord,
	DurableLocalHeadRecord,
	DurableLocalPublishResult,
	DurableOperationRecord,
	DurableRegistryRecord,
	DurableResourceRecord,
	DurableRootRecord,
	DurableTransitionRecord,
} from "../durable-state";

/**
 * Request bound for a continuation: a command that only advances an already-admitted record along a step
 * its admission promised (engine authorityCommandIsContinuation). It counts the whole encoded request,
 * requestId, options and records included. Capacity prices every promised future step at this bound
 * instead of the 2 MiB admission bound (client AUTHORITY_RESOURCE_CAPS.maxRequestBytes), and the engine
 * refuses a larger continuation before acknowledgement or any durable write.
 */
export const AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES = 16 * 1024;

/**
 * JSONL segment rotation trigger. The active segment is sealed, and a snapshot of the current state started,
 * before the next NEW admission once it holds at least max(this many bytes, the size of the snapshot it
 * started from): open then replays at most about twice the current state plus this floor, and snapshot
 * writes cost at most one current-state copy per equal amount of appended history.
 */
export const AUTHORITY_JSONL_SEGMENT_MIN_BYTES = 4 * 1024 * 1024;
/** Frame-count cap on the active JSONL segment, bounding the per-frame validation an open replays. */
export const AUTHORITY_JSONL_SEGMENT_MAX_FRAMES = 16_384;

export type JournalingBackend = "jsonl" | "sqlite";
export interface AuthorityIdentity {
	readonly backend: JournalingBackend;
	readonly owningSessionId: string;
	readonly incarnation: string;
	readonly format: 2;
}
export interface AuthorityRecordMap {
	root: DurableRootRecord;
	actor: DurableActorRecord;
	construction: DurableConstructionRecord;
	gate: DurableGateRecord;
	operation: DurableOperationRecord;
	transition: DurableTransitionRecord;
	resource: DurableResourceRecord;
	"local-entry": DurableLocalEntryRecord;
	"local-head": DurableLocalHeadRecord;
}
export type AuthorityDomain = keyof AuthorityRecordMap;
export type AuthorityKey = readonly (string | number)[];
export interface AuthorityRow<T extends DurableRegistryRecord = DurableRegistryRecord> {
	readonly record: T;
	readonly version: number;
}
export interface AuthorityExpectation {
	readonly domain: AuthorityDomain;
	readonly key: AuthorityKey;
	/** null requires absence; positive integers require that exact row version. */
	readonly version: number | null;
}
export interface MutationOptions {
	readonly requestId?: string;
	readonly expectedRevision?: number;
	readonly expected?: readonly AuthorityExpectation[];
}
export type AuthorityOwnerPhase = "recovering" | "ready" | "quiescing" | "closed";
export interface AuthorityOwner {
	readonly incarnation: string;
	readonly epoch: number;
	readonly token: string;
	readonly phase: AuthorityOwnerPhase;
}
export interface AuthorityRequestIdentity {
	readonly requestId: string;
	readonly incarnation: string;
	readonly ownerEpoch: number;
	readonly ownerToken: string;
}
export interface LocalReservation {
	readonly localId: string;
	readonly entryId: string;
	readonly entryHash: string;
	readonly expectedHeadHash: string;
}
export interface LocalClaim {
	readonly localId: string;
	readonly entryId: string;
	readonly version: number;
	readonly entryHash: string;
	readonly headHash: string;
	readonly previousHeadHash: string;
	readonly claimToken: string;
	readonly ownerEpoch: number;
	readonly incarnation: string;
	readonly phase: "reserved" | "effect" | "uncertain";
}
export interface AuthorityActivation {
	readonly root?: DurableRootRecord;
	readonly actor: DurableActorRecord;
	readonly construction: DurableConstructionRecord;
	readonly gate?: DurableGateRecord;
}
export interface RootTransitionCommit {
	readonly transition: DurableTransitionRecord;
	readonly expectedRootGeneration: number;
	readonly expectedRootHeadHash: string;
	readonly root: DurableRootRecord;
	readonly gate: DurableGateRecord;
}
export interface LocalReconciliation {
	readonly claim: LocalClaim;
	readonly observedEntryHash: string;
	readonly action: "commit" | "restore-predecessor";
}
export type AuthorityCommand =
	| { readonly kind: "transition"; readonly record: DurableRegistryRecord }
	| { readonly kind: "transition-batch"; readonly records: readonly DurableRegistryRecord[] }
	| { readonly kind: "activate-authority"; readonly activation: AuthorityActivation }
	| { readonly kind: "commit-root-transition"; readonly transition: RootTransitionCommit }
	| { readonly kind: "reserve-local"; readonly input: LocalReservation }
	| { readonly kind: "authorize-local-effect"; readonly claim: LocalClaim }
	| { readonly kind: "finalize-local"; readonly claim: LocalClaim; readonly outcome: "committed" | "uncertain" }
	| { readonly kind: "reconcile-local"; readonly input: LocalReconciliation }
	| { readonly kind: "recover" }
	| { readonly kind: "owner"; readonly owner: AuthorityOwner }
	| { readonly kind: "quarantine"; readonly reason: string };
export type AuthorityResult =
	| { readonly kind: "mutation" }
	| { readonly kind: "local-claim"; readonly claim: LocalClaim }
	| { readonly kind: "local-publication"; readonly publication: DurableLocalPublishResult };
export interface MutationReceipt {
	readonly requestId: string;
	readonly ownerEpoch: number;
	readonly revision: number;
	readonly payloadHash: string;
	readonly incarnation: string;
	readonly commandKind: AuthorityCommand["kind"];
	readonly committedAt: number;
	readonly result: AuthorityResult;
}
export interface AuthorityMetaUpdate {
	readonly revision: number;
	readonly generationHighWater: number;
	readonly status: "ready" | "quarantined";
	readonly quarantineReason?: string;
}
export interface AuthorityMeta extends AuthorityMetaUpdate {
	readonly headHash: string;
}
export interface AuthorityControl {
	readonly key: string;
	/** Values must pass the shared plain-JSON validator before persistence. */
	readonly value: unknown;
}
export type AuthorityControlChange =
	| { readonly key: string; readonly deleted: true }
	| { readonly key: string; readonly deleted: false; readonly value: unknown };
export interface AuthorityCommitFrame {
	readonly version: 2;
	readonly kind: "commit";
	readonly revision: number;
	readonly request: AuthorityRequestIdentity;
	readonly command: AuthorityCommand;
	readonly payloadHash: string;
	readonly expected: readonly AuthorityExpectation[];
	readonly changes: readonly AuthorityRow[];
	readonly controls: readonly AuthorityControlChange[];
	readonly receipt: MutationReceipt;
	readonly previousHash: string;
	readonly committedAt: number;
	readonly contentHash: string;
	readonly hash: string;
}
export interface AuthorityLegacySource {
	readonly sourceSha256: string;
	readonly entries: readonly DurableJournalRecord[];
}
export interface AuthorityExport {
	readonly version: 2;
	readonly sourceIdentity: AuthorityIdentity;
	readonly revision: number;
	readonly generationHighWater: number;
	readonly headHash: string;
	readonly rows: readonly AuthorityRow[];
	readonly controls: readonly AuthorityControl[];
	readonly frames: readonly AuthorityCommitFrame[];
	readonly legacy?: AuthorityLegacySource;
}
export interface AuthorityPage<T extends DurableRegistryRecord = DurableRegistryRecord> {
	readonly rows: readonly AuthorityRow<T>[];
	readonly cursor?: string;
}
export interface AuthorityControlPage {
	readonly controls: readonly AuthorityControl[];
	readonly cursor?: string;
}
export interface AuthorityScan {
	readonly openOnly?: boolean;
	readonly rootId?: string;
	readonly rootGeneration?: number;
	readonly after?: string;
	readonly limit: number;
	readonly localMatch?: { readonly localId: string; readonly version: number; readonly headHash: string };
}
export interface AuthorityRecoveryState {
	readonly revision: number;
	readonly generationHighWater: number;
	readonly owner: AuthorityOwner;
	readonly roots: ReadonlyMap<string, DurableRootRecord>;
	readonly actors: ReadonlyMap<string, DurableActorRecord>;
	readonly blocked: readonly string[];
}
export interface RevivalInput {
	readonly actorId: string;
	readonly parentId?: string;
	readonly rootId: string;
	readonly generation: number;
	readonly scopeHash?: string;
}
export interface AuthorityStore {
	readonly identity: AuthorityIdentity;
	transition(record: DurableRegistryRecord, options?: MutationOptions): Promise<MutationReceipt>;
	transitionBatch(records: readonly DurableRegistryRecord[], options?: MutationOptions): Promise<MutationReceipt>;
	activateAuthority(input: AuthorityActivation, options?: MutationOptions): Promise<MutationReceipt>;
	commitRootTransition(input: RootTransitionCommit, options?: MutationOptions): Promise<MutationReceipt>;
	getRoot(rootId: string): Promise<AuthorityRow<DurableRootRecord> | undefined>;
	getActor(actorId: string): Promise<AuthorityRow<DurableActorRecord> | undefined>;
	getActorGeneration(actorId: string, generation: number): Promise<AuthorityRow<DurableActorRecord> | undefined>;
	getConstruction(
		rootId: string,
		actorId: string,
		generation: number,
	): Promise<AuthorityRow<DurableConstructionRecord> | undefined>;
	getGate(rootId: string): Promise<AuthorityRow<DurableGateRecord> | undefined>;
	getOperation(
		ownerId: string,
		effectClass: DurableOperationRecord["effectClass"],
		operationId: string,
	): Promise<AuthorityRow<DurableOperationRecord> | undefined>;
	getTransition(rootId: string, transitionId: string): Promise<AuthorityRow<DurableTransitionRecord> | undefined>;
	getResource(
		actorId: string,
		generation: number,
		resourceId: string,
	): Promise<AuthorityRow<DurableResourceRecord> | undefined>;
	getLocalEntry(
		localId: string,
		entryId: string,
		version: number,
	): Promise<AuthorityRow<DurableLocalEntryRecord> | undefined>;
	getLocalHead(localId: string): Promise<AuthorityRow<DurableLocalHeadRecord> | undefined>;
	listOpen(domain: AuthorityDomain, after?: string, limit?: number): Promise<AuthorityPage>;
	/** Every actor (any state) of one root generation, paged in key order; listOpen("actor") is the open working set. */
	listActors(
		rootId: string,
		rootGeneration: number,
		after?: string,
		limit?: number,
	): Promise<AuthorityPage<DurableActorRecord>>;
	recover(): Promise<AuthorityRecoveryState>;
	recoveryState(): Promise<AuthorityRecoveryState>;
	validateRevival(input: RevivalInput): Promise<boolean>;
	reserveLocal(input: LocalReservation, options?: MutationOptions): Promise<LocalClaim>;
	authorizeLocalEffect(claim: LocalClaim, options?: MutationOptions): Promise<MutationReceipt>;
	finalizeLocal(
		claim: LocalClaim,
		outcome: "committed" | "uncertain",
		options?: MutationOptions,
	): Promise<DurableLocalPublishResult>;
	reconcileLocal(input: LocalReconciliation, options?: MutationOptions): Promise<MutationReceipt>;
	localBacking(localId: string): Promise<DurableLocalBackingExpectation | null>;
	resolveReceipt(
		requestId: string,
		epoch?: number,
		incarnation?: string,
		payloadHash?: string,
	): Promise<MutationReceipt | undefined>;
	quarantine(reason: string): Promise<never>;
	exportState(): Promise<AuthorityExport>;
	close(): Promise<void>;
}
export interface AuthorityDriverOptions {
	readonly path: string;
	readonly identity: AuthorityIdentity;
	readonly create: boolean;
	readonly seed?: AuthorityExport;
	/** Private worker-only borrowed capacity identity; never a persistence setting. */
	readonly capacity?: {
		readonly identity: { readonly fd: number; readonly device: bigint; readonly inode: bigint };
		readonly maxRequestBytes: number;
	};
	/**
	 * Set by the RPC client for the root's single live owner. SQLite then holds its database in
	 * exclusive locking mode even without capacity; offline tools leave it unset.
	 */
	readonly liveOwner?: boolean;
	/**
	 * JSONL segment rotation thresholds; defaults are AUTHORITY_JSONL_SEGMENT_MIN_BYTES and
	 * AUTHORITY_JSONL_SEGMENT_MAX_FRAMES. Ignored by SQLite. Lower values only rotate sooner.
	 */
	readonly jsonlSegment?: { readonly minBytes: number; readonly maxFrames: number };
	/**
	 * Offline conversion inspection only (never a live owner or worker): integrityCheck() then verifies the store in
	 * bounded memory, with its replay state in a scratch file under `scratchDirectory` (removed by close()), and
	 * offlineExportView() lists the verified export. SQLite only.
	 */
	readonly offlineInspection?: { readonly scratchDirectory: string };
	/**
	 * Set when `path` is a disposable inspection copy: the real payload it was copied from, which a refusal names
	 * (with its repair command) instead of the copy. Defaults to `path`.
	 */
	readonly refusalPath?: string;
}
/**
 * Optional worker-only group-commit capability. A driver that omits it keeps one frame per durable sync.
 *
 * Between begin() and sync(), every transaction() call is one group MEMBER: it validates, funds and applies
 * exactly as an ungrouped transaction would, against the state left by the earlier members, but performs no
 * durable sync. A member that throws leaves no trace and does not disturb the other members; when the
 * driver cannot guarantee that (it cannot undo the member), the member throws an error carrying
 * `unknownOutcome: true`, the driver becomes unavailable, and sync() then throws too. sync() makes every
 * member durable with one sync. If it throws, its error carries `unknownOutcome: true`, the driver becomes
 * unavailable, and every member's outcome is unknown: no member may be reported as a known result.
 * Nothing a member returns may be acknowledged before sync() returns.
 */
export interface AuthorityGroupCommit {
	/** True from begin() until sync() returns or throws. */
	readonly open: boolean;
	/** Opens a group. Refuses inside a transaction, inside an open group, or on an unavailable driver. */
	begin(): void;
	/** One durable sync covering every member staged since begin(); then the group is closed. */
	sync(): void;
}
/**
 * A member that the open group cannot take, for a reason that would not exist in a group of its own (for
 * example, capacity funded per group). Nothing was written, funded or acknowledged: the caller syncs the
 * open group and runs the same command once more as the first member of a new group. A driver never throws
 * this for the first member of a group, so the retry cannot loop.
 */
export class AuthorityGroupBoundaryError extends Error {
	readonly unknownOutcome = false;
	constructor(cause: unknown) {
		super("Authority command needs a group of its own; nothing was written.", { cause });
		this.name = "AuthorityGroupBoundaryError";
	}
}
/** Worker-only persistence. All writes flow through one complete commit frame. */
export interface AuthorityPersistence {
	readonly identity: AuthorityIdentity;
	/** JSONL only: the recovery file this open kept when it cut the tail an interrupted append left. */
	readonly recoveredTail?: string;
	/** Present only on drivers that implement group commit (see AuthorityGroupCommit). */
	readonly groupCommit?: AuthorityGroupCommit;
	transaction<T>(run: () => T): T;
	get<D extends AuthorityDomain>(domain: D, key: AuthorityKey): AuthorityRow<AuthorityRecordMap[D]> | undefined;
	scan<D extends AuthorityDomain>(domain: D, query: AuthorityScan): AuthorityPage<AuthorityRecordMap[D]>;
	getControl(key: string): unknown | undefined;
	findReceipt(requestId: string, incarnation: string, payloadHash?: string): MutationReceipt | undefined;
	scanControl(prefix: string, after?: string, limit?: number): AuthorityControlPage;
	commit(frame: AuthorityCommitFrame): void;
	exportState(): AuthorityExport;
	integrityCheck(): void;
	/** The export integrityCheck() verified, read in pieces; only on a driver opened with `offlineInspection`. */
	offlineExportView?(): AuthorityExportView;
	close(): void;
}
export type AuthorityMethod = Exclude<keyof AuthorityStore, "identity">;
export type AuthorityEngineApi = {
	[K in AuthorityMethod]: AuthorityStore[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never;
};
export interface AuthorityRpcCall {
	readonly kind: "call";
	readonly id: string;
	readonly method: AuthorityMethod;
	readonly args: readonly unknown[];
	readonly owner: AuthorityOwner;
	readonly deadline: number;
}
export interface AuthorityRpcOpen {
	readonly kind: "open";
	readonly id: string;
	readonly driver: AuthorityDriverOptions;
	readonly ownerToken: string;
}
export type AuthorityRpcRequest = AuthorityRpcOpen | AuthorityRpcCall;
export type AuthorityRpcResponse =
	| { readonly id: string; readonly ok: true; readonly value: unknown }
	| {
			readonly id: string;
			readonly ok: false;
			readonly error: { readonly name: string; readonly message: string; readonly unknownOutcome: boolean };
	  };
