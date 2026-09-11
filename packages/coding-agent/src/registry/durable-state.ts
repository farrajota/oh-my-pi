import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const DURABLE_STATE_VERSION = 1 as const;
export const DURABLE_RECOVERY_BATCH_LIMIT = 100;
const GENESIS_HASH = "0".repeat(64);
export const REGISTRY_DURABLE_JOURNAL_SUFFIX = ".authority-v1.jsonl";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type DurablePhase = "intent" | "effect" | "committed";
export type DurableTerminalPhase = "completed" | "failed" | "abandoned" | "cancelled";

interface DurableBaseRecord {
	readonly at: number;
}

export interface DurableRootRecord extends DurableBaseRecord {
	readonly kind: "root";
	readonly rootId: string;
	readonly generation: number;
	readonly headHash: string;
	readonly state: "active" | "retired" | "invalidated";
}

export interface DurableActorRecord extends DurableBaseRecord {
	readonly kind: "actor";
	readonly actorId: string;
	readonly rootId: string;
	readonly parentId?: string;
	readonly generation: number;
	readonly rootGeneration: number;
	readonly rootHeadHash: string;
	readonly startupHash: string;
	readonly provenanceHash: string;
	readonly scopeHash?: string;
	readonly parentScopeHash?: string;
	readonly state: "active" | "parked" | "retired" | "aborted";
}

export interface DurableConstructionRecord extends DurableBaseRecord {
	readonly kind: "construction";
	readonly actorId: string;
	readonly rootId: string;
	readonly parentId?: string;
	readonly generation: number;
	readonly startupHash: string;
	readonly provenanceHash: string;
	readonly scopeHash?: string;
	readonly parentScopeHash?: string;
	readonly phase: "reserved" | "constructing" | "constructed" | "activated" | "abandoned";
}

export interface DurableGateRecord extends DurableBaseRecord {
	readonly kind: "gate";
	readonly rootId: string;
	readonly generation: number;
	readonly phase: "closed" | "quiescing" | "quiesced" | "open";
}

export interface DurableOperationRecord extends DurableBaseRecord {
	readonly kind: "operation";
	readonly operationId: string;
	readonly effectClass: "eval" | "mcp" | "filesystem" | "local" | "extension" | "session";
	readonly ownerId: string;
	readonly classOwnerId: string;
	readonly actorId?: string;
	readonly rootId?: string;
	readonly generation?: number;
	readonly acquiredAt: number;
	readonly expiresAt: number;
	readonly phase: DurablePhase | DurableTerminalPhase;
	readonly recovery?: true;
}

export interface DurableTransitionRecord extends DurableBaseRecord {
	readonly kind: "transition";
	readonly transitionId: string;
	readonly rootId: string;
	readonly sourceGeneration: number;
	readonly destinationGeneration: number;
	readonly sourceHeadHash: string;
	readonly destinationHeadHash: string;
	readonly phase:
		| "staged"
		| "quiescing"
		| "quiesced"
		| "validated"
		| "cas-committed"
		| "activated"
		| "retired"
		| "recovered";
	readonly recovery?: true;
}

export type DurableResourceClass = "filesystem" | "local" | "archive" | "sqlite";

export interface DurableResourceRecord extends DurableBaseRecord {
	readonly kind: "resource";
	readonly resourceId: string;
	readonly resourceClass: DurableResourceClass;
	readonly operationId: string;
	readonly actorId: string;
	readonly rootId?: string;
	readonly generation: number;
	readonly targetHash: string;
	readonly phase: DurablePhase | "completed" | "cancelled" | "abandoned";
	readonly recovery?: true;
}

export interface DurableLocalEntryRecord extends DurableBaseRecord {
	readonly kind: "local-entry";
	readonly localId: string;
	readonly entryId: string;
	readonly version: number;
	readonly expectedHeadHash: string;
	readonly entryHash: string;
	readonly headHash: string;
	readonly phase: DurablePhase | "conflict" | "cancelled";
	readonly recovery?: true;
}

export interface DurableLocalHeadRecord extends DurableBaseRecord {
	readonly kind: "local-head";
	readonly localId: string;
	readonly version: number;
	readonly previousHeadHash: string;
	readonly headHash: string;
	readonly phase: "current" | "invalidated";
}

export type DurableRegistryRecord =
	| DurableRootRecord
	| DurableActorRecord
	| DurableConstructionRecord
	| DurableGateRecord
	| DurableOperationRecord
	| DurableTransitionRecord
	| DurableResourceRecord
	| DurableLocalEntryRecord
	| DurableLocalHeadRecord;

export interface DurableJournalRecord {
	readonly version: typeof DURABLE_STATE_VERSION;
	readonly sequence: number;
	readonly previousHash: string;
	readonly contentHash: string;
	readonly record: DurableRegistryRecord;
	readonly hash: string;
}

export interface DurableRecoveryCursor {
	readonly sequence: number;
	readonly hash: string;
}

export interface DurableRecoveryBatch {
	readonly records: readonly DurableJournalRecord[];
	readonly cursor: DurableRecoveryCursor | null;
	readonly done: boolean;
}

export interface DurableRegistryRecoverySnapshot {
	readonly available: true;
	readonly head: DurableRecoveryCursor | null;
	readonly roots: ReadonlyMap<string, DurableRootRecord>;
	readonly actors: ReadonlyMap<string, DurableActorRecord>;
	readonly constructions: ReadonlyMap<string, DurableConstructionRecord>;
	readonly gates: ReadonlyMap<string, DurableGateRecord>;
	readonly operations: ReadonlyMap<string, DurableOperationRecord>;
	readonly transitions: ReadonlyMap<string, DurableTransitionRecord>;
	readonly resources: ReadonlyMap<string, DurableResourceRecord>;
	readonly localHeads: ReadonlyMap<string, DurableLocalHeadRecord>;
	readonly localEntries: ReadonlyMap<string, DurableLocalEntryRecord>;
}

export class DurableStateConflictError extends Error {
	constructor(message = "Durable state compare-and-swap conflict.") {
		super(message);
		this.name = "DurableStateConflictError";
	}
}

export class DurableStateUnavailableError extends Error {
	constructor(message = "Durable registry state is quarantined and unavailable.") {
		super(message);
		this.name = "DurableStateUnavailableError";
	}
}

function assertPlainJson(value: unknown, active = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Durable state numbers must be finite.");
		return;
	}
	if (typeof value !== "object") throw new Error("Durable state contains a non-JSON value.");
	if (active.has(value)) throw new Error("Durable state contains a cycle.");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	) {
		throw new Error("Durable state must contain only plain objects and arrays.");
	}
	active.add(value);
	try {
		if (Array.isArray(value)) {
			for (const item of value) assertPlainJson(item, active);
			return;
		}
		for (const [key, item] of Object.entries(value)) {
			if (item === undefined) throw new Error(`Durable state field '${key}' is undefined.`);
			assertPlainJson(item, active);
		}
	} finally {
		active.delete(value);
	}
}

function canonicalJson(value: unknown): string {
	assertPlainJson(value);
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value as Record<string, unknown>)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}

export function canonicalDurableSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** SHA-256 of exact durable backing bytes, without JSON canonicalization. */
export function durableBackingSha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertId(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty opaque string.`);
	}
}

function assertGeneration(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0)
		throw new Error(`${label} must be a positive safe integer.`);
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new Error(`${label} must be a non-negative safe integer.`);
}

function assertHash(value: unknown, label: string, allowGenesis = false): asserts value is string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value) || (!allowGenesis && value === GENESIS_HASH)) {
		throw new Error(`${label} must be a canonical SHA-256 hash.`);
	}
}

function assertExactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`Unexpected durable ${String(record.kind)} field '${key}'.`);
	}
	for (const key of required) {
		if (!(key in record)) throw new Error(`Missing durable ${String(record.kind)} field '${key}'.`);
	}
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is invalid.`);
}

function validateRecord(value: unknown): asserts value is DurableRegistryRecord {
	assertPlainJson(value);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Durable record must be an object.");
	const record = value as Record<string, unknown>;
	assertId(record.kind, "Record kind");
	assertTimestamp(record.at, "Record timestamp");
	switch (record.kind) {
		case "root":
			assertExactKeys(record, ["kind", "at", "rootId", "generation", "headHash", "state"]);
			assertId(record.rootId, "Root id");
			assertGeneration(record.generation, "Root generation");
			assertHash(record.headHash, "Root head hash");
			assertOneOf(record.state, ["active", "retired", "invalidated"], "Root state");
			break;
		case "actor":
			assertExactKeys(
				record,
				[
					"kind",
					"at",
					"actorId",
					"rootId",
					"generation",
					"rootGeneration",
					"rootHeadHash",
					"startupHash",
					"provenanceHash",
					"state",
				],
				["parentId", "scopeHash", "parentScopeHash"],
			);
			assertId(record.actorId, "Actor id");
			assertId(record.rootId, "Actor root id");
			if (record.parentId !== undefined) assertId(record.parentId, "Actor parent id");
			assertGeneration(record.generation, "Actor generation");
			assertGeneration(record.rootGeneration, "Actor root generation");
			assertHash(record.rootHeadHash, "Actor root head hash");
			assertHash(record.startupHash, "Actor startup hash");
			assertHash(record.provenanceHash, "Actor provenance hash");
			if (record.scopeHash !== undefined) assertHash(record.scopeHash, "Actor scope hash");
			if (record.parentScopeHash !== undefined) assertHash(record.parentScopeHash, "Actor parent scope hash");
			assertOneOf(record.state, ["active", "parked", "retired", "aborted"], "Actor state");
			break;
		case "construction":
			assertExactKeys(
				record,
				["kind", "at", "actorId", "rootId", "generation", "startupHash", "provenanceHash", "phase"],
				["parentId", "scopeHash", "parentScopeHash"],
			);
			assertId(record.actorId, "Construction actor id");
			assertId(record.rootId, "Construction root id");
			if (record.parentId !== undefined) assertId(record.parentId, "Construction parent id");
			assertGeneration(record.generation, "Construction generation");
			assertHash(record.startupHash, "Construction startup hash");
			assertHash(record.provenanceHash, "Construction provenance hash");
			if (record.scopeHash !== undefined) assertHash(record.scopeHash, "Construction scope hash");
			if (record.parentScopeHash !== undefined) assertHash(record.parentScopeHash, "Construction parent scope hash");
			assertOneOf(
				record.phase,
				["reserved", "constructing", "constructed", "activated", "abandoned"],
				"Construction phase",
			);
			break;
		case "gate":
			assertExactKeys(record, ["kind", "at", "rootId", "generation", "phase"]);
			assertId(record.rootId, "Gate root id");
			assertGeneration(record.generation, "Gate generation");
			assertOneOf(record.phase, ["closed", "quiescing", "quiesced", "open"], "Gate phase");
			break;
		case "operation":
			assertExactKeys(
				record,
				["kind", "at", "operationId", "effectClass", "ownerId", "classOwnerId", "acquiredAt", "expiresAt", "phase"],
				["actorId", "rootId", "generation", "recovery"],
			);
			assertId(record.operationId, "Operation id");
			assertOneOf(
				record.effectClass,
				["eval", "mcp", "filesystem", "local", "extension", "session"],
				"Operation effect class",
			);
			assertId(record.ownerId, "Operation owner id");
			assertId(record.classOwnerId, "Operation class owner id");
			if (record.actorId !== undefined) assertId(record.actorId, "Operation actor id");
			if (record.rootId !== undefined) assertId(record.rootId, "Operation root id");
			if (record.generation !== undefined) assertGeneration(record.generation, "Operation generation");
			assertTimestamp(record.acquiredAt, "Operation acquisition time");
			assertTimestamp(record.expiresAt, "Operation expiry time");
			if ((record.expiresAt as number) <= (record.acquiredAt as number))
				throw new Error("Operation expiry must follow acquisition.");
			assertOneOf(
				record.phase,
				["intent", "effect", "committed", "completed", "failed", "abandoned", "cancelled"],
				"Operation phase",
			);
			if (record.recovery !== undefined && record.recovery !== true)
				throw new Error("Operation recovery marker is invalid.");
			break;
		case "transition":
			assertExactKeys(
				record,
				[
					"kind",
					"at",
					"transitionId",
					"rootId",
					"sourceGeneration",
					"destinationGeneration",
					"sourceHeadHash",
					"destinationHeadHash",
					"phase",
				],
				["recovery"],
			);
			assertId(record.transitionId, "Transition id");
			assertId(record.rootId, "Transition root id");
			assertGeneration(record.sourceGeneration, "Transition source generation");
			assertGeneration(record.destinationGeneration, "Transition destination generation");
			if ((record.destinationGeneration as number) <= (record.sourceGeneration as number))
				throw new Error("Transition destination generation must advance.");
			assertHash(record.sourceHeadHash, "Transition source head hash");
			assertHash(record.destinationHeadHash, "Transition destination head hash");
			assertOneOf(
				record.phase,
				["staged", "quiescing", "quiesced", "validated", "cas-committed", "activated", "retired", "recovered"],
				"Transition phase",
			);
			if (record.recovery !== undefined && record.recovery !== true)
				throw new Error("Transition recovery marker is invalid.");
			break;
		case "resource":
			assertExactKeys(
				record,
				[
					"kind",
					"at",
					"resourceId",
					"resourceClass",
					"operationId",
					"actorId",
					"generation",
					"targetHash",
					"phase",
				],
				["rootId", "recovery"],
			);
			assertId(record.resourceId, "Resource id");
			assertOneOf(record.resourceClass, ["filesystem", "local", "archive", "sqlite"], "Resource class");
			assertId(record.operationId, "Resource operation id");
			assertId(record.actorId, "Resource actor id");
			if (record.rootId !== undefined) assertId(record.rootId, "Resource root id");
			assertGeneration(record.generation, "Resource generation");
			assertHash(record.targetHash, "Resource target hash");
			assertOneOf(
				record.phase,
				["intent", "effect", "committed", "completed", "cancelled", "abandoned"],
				"Resource phase",
			);
			if (record.recovery !== undefined && record.recovery !== true)
				throw new Error("Resource recovery marker is invalid.");
			break;
		case "local-entry":
			assertExactKeys(
				record,
				["kind", "at", "localId", "entryId", "version", "expectedHeadHash", "entryHash", "headHash", "phase"],
				["recovery"],
			);
			assertId(record.localId, "Local id");
			assertId(record.entryId, "Local entry id");
			assertGeneration(record.version, "Local version");
			assertHash(record.expectedHeadHash, "Local expected head hash", true);
			assertHash(record.entryHash, "Local entry hash");
			assertHash(record.headHash, "Local head hash");
			assertOneOf(record.phase, ["intent", "effect", "committed", "conflict", "cancelled"], "Local entry phase");
			if (record.recovery !== undefined && record.recovery !== true)
				throw new Error("Local entry recovery marker is invalid.");
			break;
		case "local-head":
			assertExactKeys(record, ["kind", "at", "localId", "version", "previousHeadHash", "headHash", "phase"]);
			assertId(record.localId, "Local id");
			assertGeneration(record.version, "Local head version");
			assertHash(record.previousHeadHash, "Previous local head hash", true);
			assertHash(record.headHash, "Local head hash");
			assertOneOf(record.phase, ["current", "invalidated"], "Local head phase");
			break;
		default:
			throw new Error(`Unknown durable record kind '${String(record.kind)}'.`);
	}
}

function journalHash(input: Omit<DurableJournalRecord, "hash">): string {
	return canonicalDurableSha256(input);
}

function readJournalFile(journalPath: string): DurableJournalRecord[] {
	let text: string;
	try {
		text = fs.readFileSync(journalPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!text) return [];
	if (!text.endsWith("\n")) throw new Error("Durable journal ends with a partial record.");
	const records: DurableJournalRecord[] = [];
	let previousHash = GENESIS_HASH;
	for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`Durable journal record ${index + 1} is not valid JSON.`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error(`Durable journal record ${index + 1} is invalid.`);
		const entry = parsed as Record<string, unknown>;
		assertExactKeys(entry, ["version", "sequence", "previousHash", "contentHash", "record", "hash"]);
		if (entry.version !== DURABLE_STATE_VERSION)
			throw new Error(`Unsupported durable journal version at record ${index + 1}.`);
		if (entry.sequence !== index + 1) throw new Error(`Durable journal sequence mismatch at record ${index + 1}.`);
		assertHash(entry.previousHash, "Previous journal hash", true);
		if (entry.previousHash !== previousHash)
			throw new Error(`Durable journal chain mismatch at record ${index + 1}.`);
		validateRecord(entry.record);
		assertHash(entry.contentHash, "Durable content hash");
		if (entry.contentHash !== canonicalDurableSha256(entry.record))
			throw new Error(`Durable content hash mismatch at record ${index + 1}.`);
		assertHash(entry.hash, "Durable journal hash");
		const expectedHash = journalHash({
			version: DURABLE_STATE_VERSION,
			sequence: entry.sequence as number,
			previousHash: entry.previousHash as string,
			contentHash: entry.contentHash as string,
			record: entry.record,
		});
		if (entry.hash !== expectedHash) throw new Error(`Durable journal head mismatch at record ${index + 1}.`);
		const record = Object.freeze({
			version: DURABLE_STATE_VERSION,
			sequence: entry.sequence as number,
			previousHash: entry.previousHash as string,
			contentHash: entry.contentHash as string,
			record: Object.freeze(entry.record),
			hash: entry.hash as string,
		}) as DurableJournalRecord;
		records.push(record);
		previousHash = record.hash;
	}
	return records;
}

function currentCursor(records: readonly DurableJournalRecord[]): DurableRecoveryCursor | null {
	const last = records.at(-1);
	return last ? Object.freeze({ sequence: last.sequence, hash: last.hash }) : null;
}

export class RegistryDurableStateStore {
	readonly #journalPath: string;
	readonly #quarantinePath: string;
	#unavailableReason: string | undefined;

	constructor(journalPath: string) {
		if (!path.isAbsolute(journalPath)) throw new Error("Durable journal path must be absolute.");
		this.#journalPath = journalPath;
		this.#quarantinePath = `${journalPath}.quarantine`;
		try {
			this.#unavailableReason =
				fs.readFileSync(this.#quarantinePath, "utf8").trim() || "Durable state is quarantined.";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	get available(): boolean {
		return this.#unavailableReason === undefined;
	}

	get quarantineReason(): string | undefined {
		return this.#unavailableReason;
	}

	head(): DurableRecoveryCursor | null {
		return currentCursor(this.#readValidated());
	}

	append(record: DurableRegistryRecord, expectedHead?: DurableRecoveryCursor | null): DurableJournalRecord {
		if (!this.available) throw new DurableStateUnavailableError(this.#unavailableReason);
		validateRecord(record);
		const records = this.#readValidated();
		const head = currentCursor(records);
		if (
			expectedHead !== undefined &&
			(head?.sequence !== expectedHead?.sequence || head?.hash !== expectedHead?.hash)
		) {
			throw new DurableStateConflictError();
		}
		const previousHash = head?.hash ?? GENESIS_HASH;
		const base = {
			version: DURABLE_STATE_VERSION,
			sequence: (head?.sequence ?? 0) + 1,
			previousHash,
			contentHash: canonicalDurableSha256(record),
			record: Object.freeze({ ...record }) as DurableRegistryRecord,
		};
		const entry: DurableJournalRecord = Object.freeze({ ...base, hash: journalHash(base) });
		fs.mkdirSync(path.dirname(this.#journalPath), { recursive: true });
		const handle = fs.openSync(this.#journalPath, "a", 0o600);
		try {
			fs.writeSync(handle, `${JSON.stringify(entry)}\n`);
			fs.fsyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
		return entry;
	}

	readBatch(cursor: DurableRecoveryCursor | null = null): DurableRecoveryBatch {
		const records = this.#readValidated();
		const offset = cursor?.sequence ?? 0;
		if (cursor) {
			const previous = records[offset - 1];
			if (!previous || previous.hash !== cursor.hash)
				return this.#quarantine("Durable recovery cursor does not match the journal head chain.");
		}
		const batch = records.slice(offset, offset + DURABLE_RECOVERY_BATCH_LIMIT);
		const next = currentCursor(batch);
		return Object.freeze({
			records: Object.freeze(batch),
			cursor: next ?? cursor,
			done: offset + batch.length === records.length,
		});
	}

	snapshot(): DurableRegistryRecoverySnapshot {
		if (!this.available) throw new DurableStateUnavailableError(this.quarantineReason);
		try {
			return durableSnapshot(applyRecords(this));
		} catch (error) {
			if (error instanceof DurableStateUnavailableError) throw error;
			return this.quarantine(error instanceof Error ? error.message : String(error));
		}
	}

	recover(): DurableRegistryRecoverySnapshot {
		return recoverRegistryDurableState(this);
	}

	/** Permanently fail this store closed after semantic recovery validation fails. */
	quarantine(reason: string): never {
		return this.#quarantine(reason);
	}

	validateRevival(input: {
		actorId: string;
		parentId?: string;
		rootId: string;
		generation: number;
		scopeHash?: string;
	}): boolean {
		const snapshot = this.snapshot();
		const actor = snapshot.actors.get(input.actorId);
		if (
			!actor ||
			actor.state === "retired" ||
			actor.state === "aborted" ||
			actor.rootId !== input.rootId ||
			actor.parentId !== input.parentId ||
			actor.generation !== input.generation
		)
			return false;
		if (input.scopeHash !== undefined && actor.scopeHash !== input.scopeHash) return false;
		const seen = new Set<string>();
		let current = actor;
		while (current.parentId) {
			if (seen.has(current.actorId)) return false;
			seen.add(current.actorId);
			const parent = snapshot.actors.get(current.parentId);
			if (!parent || parent.rootId !== actor.rootId || parent.state === "retired" || parent.state === "aborted")
				return false;
			if (current.parentScopeHash !== undefined && parent.scopeHash !== current.parentScopeHash) return false;
			current = parent;
		}
		const root = snapshot.roots.get(actor.rootId);
		return Boolean(
			root &&
			root.state === "active" &&
			root.generation === actor.rootGeneration &&
			root.headHash === actor.rootHeadHash,
		);
	}
	#readValidated(): DurableJournalRecord[] {
		if (!this.available) throw new DurableStateUnavailableError(this.#unavailableReason);
		try {
			return readJournalFile(this.#journalPath);
		} catch (error) {
			return this.#quarantine(error instanceof Error ? error.message : String(error));
		}
	}

	#quarantine(reason: string): never {
		this.#unavailableReason = reason;
		fs.mkdirSync(path.dirname(this.#quarantinePath), { recursive: true });
		try {
			fs.writeFileSync(this.#quarantinePath, `${reason}\n`, { mode: 0o600, flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		throw new DurableStateUnavailableError(reason);
	}
}

/** Canonical authority journal path for one absolute or relative session JSONL path. */
export function registryDurableJournalPath(sessionFile: string): string {
	return `${path.resolve(sessionFile)}${REGISTRY_DURABLE_JOURNAL_SUFFIX}`;
}

const registryDurableStoresByPath = new Map<string, RegistryDurableStateStore>();

/** Process-local singleton for one session authority journal. */
export function registryDurableStateForSession(sessionFile: string): RegistryDurableStateStore {
	const journalPath = registryDurableJournalPath(sessionFile);
	let store = registryDurableStoresByPath.get(journalPath);
	if (!store) {
		store = new RegistryDurableStateStore(journalPath);
		registryDurableStoresByPath.set(journalPath, store);
	}
	return store;
}

function transitionKey(record: DurableTransitionRecord): string {
	return `${record.rootId}\0${record.transitionId}`;
}

function constructionKey(record: DurableConstructionRecord): string {
	return `${record.rootId}\0${record.actorId}\0${record.generation}`;
}

function operationKey(record: DurableOperationRecord): string {
	return `${record.ownerId}\0${record.effectClass}\0${record.operationId}`;
}

function resourceKey(record: DurableResourceRecord): string {
	return `${record.actorId}\0${record.generation}\0${record.resourceId}`;
}

function localEntryKey(record: DurableLocalEntryRecord): string {
	return `${record.localId}\0${record.entryId}\0${record.version}`;
}

const CONSTRUCTION_ORDER = ["reserved", "constructing", "constructed", "activated"] as const;
const TRANSITION_ORDER = [
	"staged",
	"quiescing",
	"quiesced",
	"validated",
	"cas-committed",
	"activated",
	"retired",
] as const;

function assertProgress(
	previous: string | undefined,
	next: string,
	ordered: readonly string[],
	terminal: readonly string[],
	label: string,
): void {
	if (!previous) {
		if (next !== ordered[0]) throw new Error(`${label} does not begin with ${ordered[0]}.`);
		return;
	}
	if (terminal.includes(previous)) throw new Error(`${label} changed after reaching terminal state.`);
	if (terminal.includes(next)) return;
	const previousIndex = ordered.indexOf(previous);
	const nextIndex = ordered.indexOf(next);
	if (previousIndex < 0 || nextIndex !== previousIndex + 1)
		throw new Error(`${label} has an invalid phase transition.`);
}

function operationProgress(previous: DurableOperationRecord | undefined, next: DurableOperationRecord): void {
	if (!previous) {
		if (next.phase !== "intent") throw new Error("Operation does not begin with durable intent.");
		return;
	}
	if (
		previous.operationId !== next.operationId ||
		previous.effectClass !== next.effectClass ||
		previous.ownerId !== next.ownerId ||
		previous.classOwnerId !== next.classOwnerId ||
		previous.actorId !== next.actorId ||
		previous.rootId !== next.rootId ||
		previous.generation !== next.generation ||
		previous.acquiredAt !== next.acquiredAt ||
		previous.expiresAt !== next.expiresAt
	) {
		throw new Error("Operation identity changed across durable phases.");
	}
	if (["completed", "failed", "abandoned", "cancelled"].includes(previous.phase))
		throw new Error("Operation changed after reaching terminal state.");
	if (next.phase === "effect" && previous.phase === "intent") return;
	if (next.phase === "committed" && previous.phase === "effect") return;
	if (["completed", "failed"].includes(next.phase) && (previous.phase === "effect" || previous.phase === "committed"))
		return;
	if (["abandoned", "cancelled"].includes(next.phase)) return;
	throw new Error("Operation has an invalid durable phase transition.");
}

function resourceProgress(previous: DurableResourceRecord | undefined, next: DurableResourceRecord): void {
	if (!previous) {
		if (next.phase !== "intent") throw new Error("Resource does not begin with durable intent.");
		return;
	}
	if (
		previous.resourceId !== next.resourceId ||
		previous.resourceClass !== next.resourceClass ||
		previous.operationId !== next.operationId ||
		previous.actorId !== next.actorId ||
		previous.rootId !== next.rootId ||
		previous.generation !== next.generation ||
		previous.targetHash !== next.targetHash
	) {
		throw new Error("Resource identity changed across durable phases.");
	}
	if (["completed", "cancelled", "abandoned"].includes(previous.phase))
		throw new Error("Resource changed after reaching terminal state.");
	if (next.phase === "effect" && previous.phase === "intent") return;
	if (next.phase === "committed" && previous.phase === "effect") return;
	if (next.phase === "completed" && (previous.phase === "effect" || previous.phase === "committed")) return;
	if (["cancelled", "abandoned"].includes(next.phase)) return;
	throw new Error("Resource has an invalid durable phase transition.");
}

interface MutableDurableRecoveryState {
	head: DurableRecoveryCursor | null;
	roots: Map<string, DurableRootRecord>;
	actors: Map<string, DurableActorRecord>;
	constructions: Map<string, DurableConstructionRecord>;
	gates: Map<string, DurableGateRecord>;
	operations: Map<string, DurableOperationRecord>;
	transitions: Map<string, DurableTransitionRecord>;
	resources: Map<string, DurableResourceRecord>;
	localHeads: Map<string, DurableLocalHeadRecord>;
	localEntries: Map<string, DurableLocalEntryRecord>;
}

function applyRecords(store: RegistryDurableStateStore): MutableDurableRecoveryState {
	const roots = new Map<string, DurableRootRecord>();
	const actors = new Map<string, DurableActorRecord>();
	const constructions = new Map<string, DurableConstructionRecord>();
	const gates = new Map<string, DurableGateRecord>();
	const operations = new Map<string, DurableOperationRecord>();
	const transitions = new Map<string, DurableTransitionRecord>();
	const resources = new Map<string, DurableResourceRecord>();
	const localHeads = new Map<string, DurableLocalHeadRecord>();
	const localEntries = new Map<string, DurableLocalEntryRecord>();
	let cursor: DurableRecoveryCursor | null = null;
	while (true) {
		const batch = store.readBatch(cursor);
		for (const entry of batch.records) {
			const record = entry.record;
			switch (record.kind) {
				case "root": {
					const previous = roots.get(record.rootId);
					if (previous && record.generation < previous.generation && previous.state !== "invalidated")
						throw new Error("Root generation regressed.");
					if (previous && record.generation === previous.generation && previous.headHash !== record.headHash)
						throw new Error("Root generation has multiple head hashes.");
					roots.set(record.rootId, record);
					break;
				}
				case "actor": {
					const previous = actors.get(record.actorId);
					if (previous && record.generation < previous.generation) throw new Error("Actor generation regressed.");
					if (
						previous &&
						record.generation === previous.generation &&
						(previous.rootId !== record.rootId ||
							previous.parentId !== record.parentId ||
							previous.startupHash !== record.startupHash ||
							previous.provenanceHash !== record.provenanceHash ||
							previous.scopeHash !== record.scopeHash ||
							previous.parentScopeHash !== record.parentScopeHash)
					)
						throw new Error("Actor immutable identity changed.");
					actors.set(record.actorId, record);
					break;
				}
				case "construction": {
					const key = constructionKey(record);
					const previous = constructions.get(key);
					if (
						previous &&
						(previous.startupHash !== record.startupHash ||
							previous.provenanceHash !== record.provenanceHash ||
							previous.parentId !== record.parentId ||
							previous.scopeHash !== record.scopeHash ||
							previous.parentScopeHash !== record.parentScopeHash)
					)
						throw new Error("Construction identity changed.");
					assertProgress(
						previous?.phase,
						record.phase,
						CONSTRUCTION_ORDER,
						["activated", "abandoned"],
						"Construction",
					);
					constructions.set(key, record);
					break;
				}
				case "gate": {
					const previous = gates.get(record.rootId);
					if (previous && record.generation < previous.generation) throw new Error("Gate generation regressed.");
					gates.set(record.rootId, record);
					break;
				}
				case "operation": {
					const key = operationKey(record);
					operationProgress(operations.get(key), record);
					operations.set(key, record);
					break;
				}
				case "transition": {
					const key = transitionKey(record);
					const previous = transitions.get(key);
					if (
						previous &&
						(previous.sourceGeneration !== record.sourceGeneration ||
							previous.destinationGeneration !== record.destinationGeneration ||
							previous.sourceHeadHash !== record.sourceHeadHash ||
							previous.destinationHeadHash !== record.destinationHeadHash)
					)
						throw new Error("Root transition identity changed.");
					assertProgress(
						previous?.phase,
						record.phase,
						TRANSITION_ORDER,
						["retired", "recovered"],
						"Root transition",
					);
					transitions.set(key, record);
					break;
				}
				case "resource": {
					const key = resourceKey(record);
					resourceProgress(resources.get(key), record);
					resources.set(key, record);
					break;
				}
				case "local-entry": {
					const key = localEntryKey(record);
					const previous = localEntries.get(key);
					if (
						previous &&
						(previous.expectedHeadHash !== record.expectedHeadHash ||
							previous.entryHash !== record.entryHash ||
							previous.headHash !== record.headHash)
					)
						throw new Error("Local entry identity changed.");
					assertProgress(
						previous?.phase,
						record.phase,
						["intent", "effect", "committed"],
						["committed", "conflict", "cancelled"],
						"Local entry",
					);
					localEntries.set(key, record);
					break;
				}
				case "local-head": {
					const previous = localHeads.get(record.localId);
					if (!previous) {
						if (record.version !== 1 || record.previousHeadHash !== GENESIS_HASH)
							throw new Error("Local journal does not begin at the genesis head.");
					} else if (record.version !== previous.version + 1 || record.previousHeadHash !== previous.headHash) {
						throw new Error("Local journal head compare-and-swap mismatch.");
					}
					localHeads.set(record.localId, record);
					break;
				}
			}
		}
		cursor = batch.cursor;
		if (batch.done) break;
	}
	return {
		head: cursor,
		roots,
		actors,
		constructions,
		gates,
		operations,
		transitions,
		resources,
		localHeads,
		localEntries,
	};
}

function validateSnapshot(state: MutableDurableRecoveryState): void {
	for (const actor of state.actors.values()) {
		if (actor.state === "retired" || actor.state === "aborted") continue;
		const root = state.roots.get(actor.rootId);
		if (
			!root ||
			root.state !== "active" ||
			root.generation !== actor.rootGeneration ||
			root.headHash !== actor.rootHeadHash
		)
			throw new Error("Actor references a missing or mismatched root head.");
		if (actor.parentId) {
			const parent = state.actors.get(actor.parentId);
			if (!parent || parent.rootId !== actor.rootId || parent.state === "retired" || parent.state === "aborted")
				throw new Error("Actor references a missing or invalid parent.");
			if (actor.parentScopeHash !== undefined && actor.parentScopeHash !== parent.scopeHash)
				throw new Error("Actor parent permission snapshot drifted.");
		}
		const seen = new Set<string>();
		let cursor: DurableActorRecord | undefined = actor;
		while (cursor?.parentId) {
			if (seen.has(cursor.actorId)) throw new Error("Actor parent graph contains a cycle.");
			seen.add(cursor.actorId);
			cursor = state.actors.get(cursor.parentId);
		}
	}
	for (const [localId, head] of state.localHeads) {
		if (head.phase !== "current") continue;
		const committed = [...state.localEntries.values()].filter(
			entry =>
				entry.localId === localId &&
				entry.phase === "committed" &&
				entry.version === head.version &&
				entry.headHash === head.headHash,
		);
		if (committed.length !== 1) throw new Error("Local state has a missing or non-single current head entry.");
	}
}

function durableSnapshot(state: MutableDurableRecoveryState): DurableRegistryRecoverySnapshot {
	validateSnapshot(state);
	return Object.freeze({
		available: true,
		head: state.head,
		roots: state.roots,
		actors: state.actors,
		constructions: state.constructions,
		gates: state.gates,
		operations: state.operations,
		transitions: state.transitions,
		resources: state.resources,
		localHeads: state.localHeads,
		localEntries: state.localEntries,
	});
}

function appendRecoveryTerminals(store: RegistryDurableStateStore, state: MutableDurableRecoveryState): boolean {
	let changed = false;
	const forwardTransitions = new Map<string, DurableTransitionRecord>();
	for (const transition of state.transitions.values()) {
		if (["cas-committed", "activated"].includes(transition.phase)) {
			forwardTransitions.set(`${transition.rootId}\0${transition.destinationGeneration}`, transition);
		}
	}
	const now = Date.now();
	for (const transition of forwardTransitions.values()) {
		for (const actor of state.actors.values()) {
			if (
				actor.rootId === transition.rootId &&
				actor.rootGeneration === transition.sourceGeneration &&
				actor.state !== "retired"
			) {
				store.append({ ...actor, at: now, state: "retired" });
				changed = true;
			}
		}
	}
	for (const construction of state.constructions.values()) {
		if (construction.phase === "activated" || construction.phase === "abandoned") continue;
		const forward = forwardTransitions.get(`${construction.rootId}\0${construction.generation}`);
		if (forward) {
			if (construction.phase !== "constructed") throw new Error("Post-CAS destination construction is incomplete.");
			const actor: DurableActorRecord = {
				kind: "actor",
				at: now,
				actorId: construction.actorId,
				rootId: construction.rootId,
				...(construction.parentId === undefined ? {} : { parentId: construction.parentId }),
				generation: construction.generation,
				rootGeneration: construction.generation,
				rootHeadHash: forward.destinationHeadHash,
				startupHash: construction.startupHash,
				provenanceHash: construction.provenanceHash,
				...(construction.scopeHash === undefined ? {} : { scopeHash: construction.scopeHash }),
				...(construction.parentScopeHash === undefined ? {} : { parentScopeHash: construction.parentScopeHash }),
				state: "parked",
			};
			store.append(actor);
			store.append({ ...construction, at: now, phase: "activated" });
			changed = true;
			continue;
		}
		store.append({ ...construction, at: now, phase: "abandoned" });
		const actor = state.actors.get(construction.actorId);
		if (actor?.generation === construction.generation && actor.state !== "retired" && actor.state !== "aborted") {
			store.append({ ...actor, at: now, state: "aborted" });
		}
		if (construction.parentId === undefined) {
			const root = state.roots.get(construction.rootId);
			if (root?.generation === construction.generation && root.state === "active") {
				store.append({ ...root, at: now, state: "invalidated" });
			}
		}
		changed = true;
	}
	for (const operation of state.operations.values()) {
		if (["completed", "failed", "abandoned", "cancelled"].includes(operation.phase)) continue;
		store.append({ ...operation, at: now, phase: "abandoned", recovery: true });
		changed = true;
	}
	for (const resource of state.resources.values()) {
		if (["completed", "cancelled", "abandoned"].includes(resource.phase)) continue;
		store.append({ ...resource, at: now, phase: "cancelled", recovery: true });
		changed = true;
	}
	for (const entry of state.localEntries.values()) {
		if (["committed", "conflict", "cancelled"].includes(entry.phase)) continue;
		store.append({ ...entry, at: now, phase: "cancelled", recovery: true });
		changed = true;
	}
	for (const transition of state.transitions.values()) {
		if (transition.phase === "retired" || transition.phase === "recovered") continue;
		if (["staged", "quiescing", "quiesced", "validated"].includes(transition.phase)) {
			store.append({ ...transition, at: now, phase: "recovered", recovery: true });
			store.append({
				kind: "root",
				at: now,
				rootId: transition.rootId,
				generation: transition.destinationGeneration,
				headHash: transition.destinationHeadHash,
				state: "invalidated",
			});
			store.append({
				kind: "root",
				at: now,
				rootId: transition.rootId,
				generation: transition.sourceGeneration,
				headHash: transition.sourceHeadHash,
				state: "active",
			});
		} else {
			if (transition.phase === "cas-committed")
				store.append({ ...transition, at: now, phase: "activated", recovery: true });
			store.append({
				kind: "root",
				at: now,
				rootId: transition.rootId,
				generation: transition.destinationGeneration,
				headHash: transition.destinationHeadHash,
				state: "active",
			});
			store.append({
				kind: "gate",
				at: now,
				rootId: transition.rootId,
				generation: transition.destinationGeneration,
				phase: "open",
			});
			store.append({ ...transition, at: now, phase: "retired", recovery: true });
		}
		changed = true;
	}
	for (const gate of state.gates.values()) {
		if (gate.phase === "open") continue;
		store.append({ ...gate, at: now, phase: "open" });
		changed = true;
	}
	return changed;
}

export function recoverRegistryDurableState(store: RegistryDurableStateStore): DurableRegistryRecoverySnapshot {
	if (!store.available) throw new DurableStateUnavailableError(store.quarantineReason);
	try {
		let state = applyRecords(store);
		if (appendRecoveryTerminals(store, state)) state = applyRecords(store);
		return durableSnapshot(state);
	} catch (error) {
		if (error instanceof DurableStateUnavailableError) throw error;
		return store.quarantine(error instanceof Error ? error.message : String(error));
	}
}

export interface DurableLocalPublishResult {
	readonly version: number;
	readonly headHash: string;
}

export interface DurableLocalBackingExpectation extends DurableLocalPublishResult {
	readonly entryId: string;
	readonly entryHash: string;
}

/** Single-head local:// metadata journal. It persists hashes and opaque ids only; backing paths never enter records. */
export class DurableLocalState {
	readonly #store: RegistryDurableStateStore;
	readonly #localId: string;
	#validatedHeadHash = GENESIS_HASH;

	constructor(store: RegistryDurableStateStore, localId: string) {
		assertId(localId, "Local id");
		this.#store = store;
		this.#localId = localId;
	}
	/** Identity-only ownership check; the journal path remains encapsulated. */
	isOwnedBy(store: RegistryDurableStateStore): boolean {
		return this.#store === store;
	}

	current(): DurableLocalPublishResult | null {
		const current = this.#currentEntry();
		return current ? Object.freeze({ version: current.version, headHash: current.headHash }) : null;
	}

	/** Validate a recovered head through caller-owned backing lookup before another publish. */
	async ensureRecoveredBacking(
		validate: (expectation: DurableLocalBackingExpectation) => boolean | Promise<boolean>,
	): Promise<void> {
		const current = this.#currentEntry();
		if (!current || current.headHash === this.#validatedHeadHash) return;
		let valid = false;
		try {
			valid = await validate(current);
		} catch {
			valid = false;
		}
		if (!valid) this.#store.quarantine("Recovered local:// backing bytes do not match the durable head.");
		this.#validatedHeadHash = current.headHash;
	}

	publish(entryId: string, entryHash: string, expectedHeadHash = GENESIS_HASH): DurableLocalPublishResult {
		assertId(entryId, "Local entry id");
		assertHash(entryHash, "Local entry hash");
		assertHash(expectedHeadHash, "Expected local head hash", true);
		const current = this.#currentEntry();
		this.#assertRecoveredBackingValidated(current);
		const actualHead = current?.headHash ?? GENESIS_HASH;
		const version = (current?.version ?? 0) + 1;
		const headHash = canonicalDurableSha256({
			localId: this.#localId,
			entryId,
			version,
			previousHeadHash: actualHead,
			entryHash,
		});
		const base = {
			kind: "local-entry" as const,
			at: Date.now(),
			localId: this.#localId,
			entryId,
			version,
			expectedHeadHash,
			entryHash,
			headHash,
		};
		this.#store.append({ ...base, phase: "intent" });
		if (expectedHeadHash !== actualHead) {
			this.#store.append({ ...base, at: Date.now(), phase: "conflict" });
			throw new DurableStateConflictError("local:// expected head does not match the current durable head.");
		}
		this.#store.append({ ...base, at: Date.now(), phase: "effect" });
		this.#store.append({ ...base, at: Date.now(), phase: "committed" });
		this.#store.append({
			kind: "local-head",
			at: Date.now(),
			localId: this.#localId,
			version,
			previousHeadHash: actualHead,
			headHash,
			phase: "current",
		});
		this.#validatedHeadHash = headHash;
		return Object.freeze({ version, headHash });
	}

	async publishWithEffect(
		entryId: string,
		entryHash: string,
		expectedHeadHash: string,
		effect: () => Promise<void>,
	): Promise<DurableLocalPublishResult> {
		assertId(entryId, "Local entry id");
		assertHash(entryHash, "Local entry hash");
		assertHash(expectedHeadHash, "Expected local head hash", true);
		const current = this.#currentEntry();
		this.#assertRecoveredBackingValidated(current);
		const actualHead = current?.headHash ?? GENESIS_HASH;
		const version = (current?.version ?? 0) + 1;
		const headHash = canonicalDurableSha256({
			localId: this.#localId,
			entryId,
			version,
			previousHeadHash: actualHead,
			entryHash,
		});
		const base = {
			kind: "local-entry" as const,
			at: Date.now(),
			localId: this.#localId,
			entryId,
			version,
			expectedHeadHash,
			entryHash,
			headHash,
		};
		this.#store.append({ ...base, phase: "intent" });
		if (expectedHeadHash !== actualHead) {
			this.#store.append({ ...base, at: Date.now(), phase: "conflict" });
			throw new DurableStateConflictError("local:// expected head does not match the current durable head.");
		}
		try {
			await effect();
		} catch (error) {
			this.#store.append({ ...base, at: Date.now(), phase: "cancelled" });
			throw error;
		}
		this.#store.append({ ...base, at: Date.now(), phase: "effect" });
		this.#store.append({ ...base, at: Date.now(), phase: "committed" });
		this.#store.append({
			kind: "local-head",
			at: Date.now(),
			localId: this.#localId,
			version,
			previousHeadHash: actualHead,
			headHash,
			phase: "current",
		});
		this.#validatedHeadHash = headHash;
		return Object.freeze({ version, headHash });
	}

	#currentEntry(): DurableLocalBackingExpectation | null {
		const snapshot = this.#store.snapshot();
		const head = snapshot.localHeads.get(this.#localId);
		if (!head || head.phase !== "current") return null;
		const entry = [...snapshot.localEntries.values()].find(
			candidate =>
				candidate.localId === this.#localId &&
				candidate.version === head.version &&
				candidate.headHash === head.headHash &&
				candidate.phase === "committed",
		);
		if (!entry) return this.#store.quarantine("Current local:// durable head has no committed backing entry.");
		return Object.freeze({
			version: head.version,
			headHash: head.headHash,
			entryId: entry.entryId,
			entryHash: entry.entryHash,
		});
	}

	#assertRecoveredBackingValidated(current: DurableLocalBackingExpectation | null): void {
		if (current && current.headHash !== this.#validatedHeadHash) {
			throw new DurableStateUnavailableError("Recovered local:// backing must be validated before publication.");
		}
	}
}

export function durableRootHeadHash(input: {
	readonly rootId: string;
	readonly generation: number;
	readonly actorId: string;
	readonly startupHash: string;
	readonly provenanceHash: string;
}): string {
	return canonicalDurableSha256(input);
}

export function durableTargetHash(input: {
	readonly actorId: string;
	readonly generation: number;
	readonly operationId: string;
	readonly canonicalTarget: string;
	readonly identity?: { readonly dev: bigint; readonly ino: bigint; readonly mode: bigint };
}): string {
	return createHash("sha256")
		.update(input.actorId)
		.update("\0")
		.update(String(input.generation))
		.update("\0")
		.update(input.operationId)
		.update("\0")
		.update(input.canonicalTarget)
		.update("\0")
		.update(input.identity ? `${input.identity.dev}:${input.identity.ino}:${input.identity.mode}` : "missing")
		.digest("hex");
}

export function durableGenesisHash(): string {
	return GENESIS_HASH;
}
