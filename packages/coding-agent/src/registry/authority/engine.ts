import {
	canonicalDurableSha256,
	durableGenesisHash,
	durableRootHeadHash,
	DurableStateConflictError,
	DurableStateUnavailableError,
	validateDurableRegistryRecord,
	validateLegacyAuthorityEntries,
} from "../durable-state";
import type {
	AuthorityActivation,
	AuthorityCommand,
	AuthorityControl,
	AuthorityEngineApi,
	AuthorityCommitFrame,
	AuthorityControlChange,
	AuthorityDomain,
	AuthorityKey,
	AuthorityExpectation,
	AuthorityExport,
	AuthorityIdentity,
	AuthorityLegacySource,
	AuthorityOwner,
	AuthorityPage,
	AuthorityPersistence,
	AuthorityRecordMap,
	AuthorityRecoveryState,
	AuthorityRequestIdentity,
	AuthorityRow,
	AuthorityStore,
	LocalClaim,
	LocalReconciliation,
	LocalReservation,
	MutationOptions,
	MutationReceipt,
	RootTransitionCommit,
} from "./types";
import { AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES } from "./types";
import type {
	DurableActorRecord,
	DurableLocalBackingExpectation,
	DurableLocalEntryRecord,
	DurableLocalHeadRecord,
	DurableLocalPublishResult,
	DurableOperationRecord,
	DurableRegistryRecord,
	DurableResourceRecord,
	DurableRootRecord,
	DurableTransitionRecord,
	DurableLegacyAuthorityImport,
} from "../durable-state";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const GENESIS_HASH = durableGenesisHash();
const TERMINAL_OPERATION_PHASES = new Set(["completed", "failed", "abandoned", "cancelled"]);
const TERMINAL_RESOURCE_PHASES = new Set(["completed", "cancelled", "abandoned"]);
const TERMINAL_TRANSITION_PHASES = new Set(["retired", "recovered"]);
const TERMINAL_CONSTRUCTION_PHASES = new Set(["activated", "abandoned"]);

export function authorityKey(domain: AuthorityDomain, key: readonly (string | number)[]): string {
	return JSON.stringify([domain, ...key]);
}

export function compareAuthorityKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function authorityGenesisHash(): string {
	return GENESIS_HASH;
}

export function authorityFrameContentHash(frame: Omit<AuthorityCommitFrame, "contentHash" | "hash">): string {
	return canonicalDurableSha256({
		version: frame.version,
		kind: frame.kind,
		revision: frame.revision,
		request: frame.request,
		command: frame.command,
		payloadHash: frame.payloadHash,
		expected: frame.expected,
		changes: frame.changes,
		controls: frame.controls,
		receipt: frame.receipt,
		previousHash: frame.previousHash,
		committedAt: frame.committedAt,
	});
}

export function authorityFrameHash(
	frame: Pick<AuthorityCommitFrame, "version" | "revision" | "previousHash" | "contentHash">,
): string {
	return canonicalDurableSha256({
		version: frame.version,
		revision: frame.revision,
		previousHash: frame.previousHash,
		contentHash: frame.contentHash,
	});
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(value);
	return (
		required.every(key => key in value) &&
		keys.every(key => required.includes(key) || optional.includes(key)) &&
		keys.length >= required.length &&
		keys.length <= required.length + optional.length
	);
}

function validateLocalClaim(value: unknown): asserts value is LocalClaim {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Authority local claim is invalid.");
	const claim = value as Record<string, unknown>;
	if (
		!exactKeys(claim, [
			"localId",
			"entryId",
			"version",
			"entryHash",
			"headHash",
			"previousHeadHash",
			"claimToken",
			"ownerEpoch",
			"incarnation",
			"phase",
		]) ||
		typeof claim.localId !== "string" ||
		!claim.localId ||
		claim.localId.includes("\0") ||
		typeof claim.entryId !== "string" ||
		!claim.entryId ||
		claim.entryId.includes("\0") ||
		!Number.isSafeInteger(claim.version) ||
		(claim.version as number) < 1 ||
		![claim.entryHash, claim.headHash, claim.previousHeadHash].every(
			hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
		) ||
		typeof claim.claimToken !== "string" ||
		!claim.claimToken ||
		claim.claimToken.includes("\0") ||
		!Number.isSafeInteger(claim.ownerEpoch) ||
		(claim.ownerEpoch as number) < 1 ||
		typeof claim.incarnation !== "string" ||
		!claim.incarnation ||
		claim.incarnation.includes("\0") ||
		(claim.phase !== "reserved" && claim.phase !== "effect" && claim.phase !== "uncertain")
	)
		throw new Error("Authority local claim is invalid.");
}

function validateBatchEffectPhases(records: readonly DurableRegistryRecord[]): void {
	if (
		records.some(
			record =>
				(record.kind === "operation" || record.kind === "resource") &&
				(record.phase === "effect" || record.phase === "committed"),
		)
	)
		throw new Error("Effect authorization and post-effect phases require a single ordered authority command.");
}

/** Phases a root transition can still take, in order; "recovered" is reachable only before cas-committed. */
export function authorityTransitionPhases(phase: string): readonly string[] {
	switch (phase) {
		case "staged":
			return ["quiescing", "quiesced", "validated", "cas-committed", "activated", "retired", "recovered"];
		case "quiescing":
			return ["quiesced", "validated", "cas-committed", "activated", "retired", "recovered"];
		case "quiesced":
			return ["validated", "cas-committed", "activated", "retired", "recovered"];
		case "validated":
			return ["cas-committed", "activated", "retired", "recovered"];
		case "cas-committed":
			return ["activated", "retired"];
		case "activated":
			return ["retired"];
		default:
			return [];
	}
}

/**
 * The future-debt model: every phase/state sequence an admitted open record may still take. Capacity
 * reserves each step as one continuation command priced at AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES,
 * and the engine refuses any continuation larger than that, so both sides must read this one model.
 */
export function authorityFuturePhasePaths(
	record: DurableRegistryRecord,
	uncertain = false,
): readonly (readonly string[])[] {
	switch (record.kind) {
		case "root":
			return record.state === "active" ? [["retired"], ["invalidated"]] : [];
		case "actor":
			return record.state === "active" || record.state === "parked" ? [["retired"], ["aborted"]] : [];
		case "construction": {
			const progress =
				record.phase === "reserved"
					? ["constructing", "constructed", "activated"]
					: record.phase === "constructing"
						? ["constructed", "activated"]
						: record.phase === "constructed"
							? ["activated"]
							: [];
			if (progress.length === 0) return [];
			const paths: string[][] = [progress];
			for (let prefix = 0; prefix < progress.length; prefix++)
				paths.push([...progress.slice(0, prefix), "abandoned"]);
			return paths;
		}
		case "gate": {
			const progress =
				record.phase === "open"
					? ["quiescing", "quiesced", "closed"]
					: record.phase === "quiescing"
						? ["quiesced", "closed"]
						: record.phase === "quiesced"
							? ["closed"]
							: [];
			return progress.length === 0 ? [] : [progress];
		}
		case "operation":
			if (record.phase === "intent")
				return [
					["effect", "committed", "completed"],
					["effect", "failed"],
					["effect", "abandoned"],
					["effect", "cancelled"],
					["abandoned"],
					["cancelled"],
				];
			if (record.phase === "effect")
				return [["committed", "completed"], ["completed"], ["failed"], ["abandoned"], ["cancelled"]];
			return record.phase === "committed" ? [["completed"], ["failed"], ["abandoned"], ["cancelled"]] : [];
		case "resource":
			if (record.phase === "intent")
				return [
					["effect", "committed", "completed"],
					["effect", "cancelled"],
					["effect", "abandoned"],
					["cancelled"],
					["abandoned"],
				];
			if (record.phase === "effect")
				return [["committed", "completed"], ["completed"], ["cancelled"], ["abandoned"]];
			return record.phase === "committed" ? [["completed"], ["cancelled"], ["abandoned"]] : [];
		case "transition": {
			const forward = authorityTransitionPhases(record.phase).filter(phase => phase !== "recovered");
			if (forward.length === 0) return [];
			const paths: string[][] = [forward];
			const recoveryCut = forward.indexOf("cas-committed");
			for (let prefix = 0; prefix <= recoveryCut; prefix++) paths.push([...forward.slice(0, prefix), "recovered"]);
			return paths;
		}
		case "local-entry":
			if (record.phase === "intent")
				return [
					["effect", "uncertain", "committed"],
					["effect", "uncertain", "conflict"],
					["effect", "committed"],
					["effect", "conflict"],
					["cancelled"],
				];
			if (record.phase === "effect")
				return uncertain
					? [["committed"], ["conflict"], ["cancelled"]]
					: [["uncertain", "committed"], ["uncertain", "conflict"], ["committed"], ["conflict"], ["cancelled"]];
			return [];
		case "local-head":
			return [];
	}
}

/** True when `record` advances the persisted open `previous` along a step its future debt already promised. */
export function authorityStepIsPromised(
	previous: DurableRegistryRecord | undefined,
	record: DurableRegistryRecord,
): boolean {
	if (!previous || previous.kind !== record.kind || !authorityRecordIsOpen(previous)) return false;
	if ("generation" in previous && "generation" in record && previous.generation !== record.generation) return false;
	const phase = "state" in record ? record.state : record.phase;
	return authorityFuturePhasePaths(previous).some(path => path.includes(phase));
}

/**
 * Whether `command` only continues already-admitted records, judged against the state before it runs.
 * Continuations are exactly the commands whose cost capacity reserved at admission (authorityFuturePhasePaths,
 * the recovered-root activation and the local claim lifecycle), so each must fit the continuation bound.
 * The classification is deliberately a superset of what capacity spends from that reserve: a command both
 * sides could treat as a funded continuation is always capped, never priced at the 2 MiB admission bound.
 */
export function authorityCommandIsContinuation(
	command: AuthorityCommand,
	get: <D extends AuthorityDomain>(domain: D, key: AuthorityKey) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
): boolean {
	switch (command.kind) {
		case "transition":
			return authorityStepIsPromised(
				get(command.record.kind, authorityRecordKey(command.record))?.record,
				command.record,
			);
		case "transition-batch":
			return (
				command.records.length > 0 &&
				command.records.every(record =>
					authorityStepIsPromised(get(record.kind, authorityRecordKey(record))?.record, record),
				)
			);
		case "activate-authority": {
			const { actor, construction } = command.activation;
			if (get("construction", authorityRecordKey(construction))?.record.phase === "constructed") return true;
			// Every persisted active root carries a funded root-actor recovery activation.
			const root = get("root", [actor.rootId])?.record;
			return (
				actor.actorId === actor.rootId &&
				actor.parentId === undefined &&
				root?.kind === "root" &&
				root.state === "active" &&
				root.generation === actor.generation
			);
		}
		// Each of these can only advance an admitted transition or local claim; none admits new debt.
		case "commit-root-transition":
		case "authorize-local-effect":
		case "finalize-local":
		case "reconcile-local":
			return true;
		case "reserve-local":
		case "recover":
		case "owner":
		case "quarantine":
			return false;
	}
}

/** Encoded size of an authority request as the continuation bound measures it: command (records included) plus options. */
export function authorityRequestBytes(command: AuthorityCommand, options: MutationOptions | undefined): number {
	const encoded = JSON.stringify({ command, options: options ?? {} });
	if (encoded === undefined) throw new TypeError("Authority request is not JSON serializable.");
	return Buffer.byteLength(encoded, "utf8");
}

/** A continuation larger than AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES; refused before any durable write or receipt. */
export class AuthorityContinuationTooLargeError extends RangeError {
	readonly commandKind: AuthorityCommand["kind"];
	readonly requestBytes: number;
	readonly maximumBytes: number;
	readonly unknownOutcome = false;

	constructor(commandKind: AuthorityCommand["kind"], requestBytes: number, maximumBytes: number) {
		super(
			`Authority ${commandKind} continuation request is ${requestBytes} bytes; continuations of admitted records are limited to ${maximumBytes} bytes (requestId, options and records included). Nothing was written.`,
		);
		this.name = "AuthorityContinuationTooLargeError";
		this.commandKind = commandKind;
		this.requestBytes = requestBytes;
		this.maximumBytes = maximumBytes;
	}
}

function validateAuthorityCommand(value: Record<string, unknown>): asserts value is AuthorityCommand {
	if (typeof value.kind !== "string") throw new Error("Authority command kind is invalid.");
	switch (value.kind) {
		case "transition":
			if (!exactKeys(value, ["kind", "record"])) throw new Error("Authority transition command is malformed.");
			validateDurableRegistryRecord(value.record);
			return;
		case "transition-batch":
			if (
				!exactKeys(value, ["kind", "records"]) ||
				!Array.isArray(value.records) ||
				value.records.length < 1 ||
				value.records.length > 100
			)
				throw new Error("Authority transition batch is malformed.");
			for (const record of value.records) validateDurableRegistryRecord(record);
			validateBatchEffectPhases(value.records as DurableRegistryRecord[]);
			return;
		case "activate-authority": {
			if (
				!exactKeys(value, ["kind", "activation"]) ||
				!value.activation ||
				typeof value.activation !== "object" ||
				Array.isArray(value.activation)
			)
				throw new Error("Authority activation command is malformed.");
			const activation = value.activation as Record<string, unknown>;
			if (!exactKeys(activation, ["actor", "construction"], ["root", "gate"]))
				throw new Error("Authority activation is malformed.");
			validateDurableRegistryRecord(activation.actor);
			validateDurableRegistryRecord(activation.construction);
			if (activation.root !== undefined) validateDurableRegistryRecord(activation.root);
			if (activation.gate !== undefined) validateDurableRegistryRecord(activation.gate);
			return;
		}
		case "commit-root-transition": {
			if (
				!exactKeys(value, ["kind", "transition"]) ||
				!value.transition ||
				typeof value.transition !== "object" ||
				Array.isArray(value.transition)
			)
				throw new Error("Root transition command is malformed.");
			const transition = value.transition as Record<string, unknown>;
			if (
				!exactKeys(transition, ["transition", "expectedRootGeneration", "expectedRootHeadHash", "root", "gate"]) ||
				!Number.isSafeInteger(transition.expectedRootGeneration) ||
				(transition.expectedRootGeneration as number) < 1 ||
				typeof transition.expectedRootHeadHash !== "string" ||
				!/^[a-f0-9]{64}$/.test(transition.expectedRootHeadHash)
			)
				throw new Error("Root transition command is malformed.");
			validateDurableRegistryRecord(transition.transition);
			validateDurableRegistryRecord(transition.root);
			validateDurableRegistryRecord(transition.gate);
			return;
		}
		case "reserve-local": {
			if (
				!exactKeys(value, ["kind", "input"]) ||
				!value.input ||
				typeof value.input !== "object" ||
				Array.isArray(value.input)
			)
				throw new Error("Local reservation command is malformed.");
			const input = value.input as Record<string, unknown>;
			if (
				!exactKeys(input, ["localId", "entryId", "entryHash", "expectedHeadHash"]) ||
				typeof input.localId !== "string" ||
				!input.localId ||
				input.localId.includes("\0") ||
				typeof input.entryId !== "string" ||
				!input.entryId ||
				input.entryId.includes("\0") ||
				typeof input.entryHash !== "string" ||
				!/^[a-f0-9]{64}$/.test(input.entryHash) ||
				typeof input.expectedHeadHash !== "string" ||
				!/^[a-f0-9]{64}$/.test(input.expectedHeadHash)
			)
				throw new Error("Local reservation command is malformed.");
			return;
		}
		case "authorize-local-effect":
			if (!exactKeys(value, ["kind", "claim"])) throw new Error("Local authorization command is malformed.");
			validateLocalClaim(value.claim);
			return;
		case "finalize-local":
			if (
				!exactKeys(value, ["kind", "claim", "outcome"]) ||
				(value.outcome !== "committed" && value.outcome !== "uncertain")
			)
				throw new Error("Local finalization command is malformed.");
			validateLocalClaim(value.claim);
			return;
		case "reconcile-local": {
			if (
				!exactKeys(value, ["kind", "input"]) ||
				!value.input ||
				typeof value.input !== "object" ||
				Array.isArray(value.input)
			)
				throw new Error("Local reconciliation command is malformed.");
			const input = value.input as Record<string, unknown>;
			if (
				!exactKeys(input, ["claim", "observedEntryHash", "action"]) ||
				typeof input.observedEntryHash !== "string" ||
				!/^[a-f0-9]{64}$/.test(input.observedEntryHash) ||
				(input.action !== "commit" && input.action !== "restore-predecessor")
			)
				throw new Error("Local reconciliation command is malformed.");
			validateLocalClaim(input.claim);
			return;
		}
		case "recover":
			if (!exactKeys(value, ["kind"])) throw new Error("Authority recovery command is malformed.");
			return;
		case "owner": {
			if (
				!exactKeys(value, ["kind", "owner"]) ||
				!value.owner ||
				typeof value.owner !== "object" ||
				Array.isArray(value.owner)
			)
				throw new Error("Authority owner command is malformed.");
			const owner = value.owner as Record<string, unknown>;
			if (
				!exactKeys(owner, ["incarnation", "epoch", "token", "phase"]) ||
				typeof owner.incarnation !== "string" ||
				!owner.incarnation ||
				!Number.isSafeInteger(owner.epoch) ||
				(owner.epoch as number) < 1 ||
				typeof owner.token !== "string" ||
				!owner.token ||
				(owner.phase !== "recovering" &&
					owner.phase !== "ready" &&
					owner.phase !== "quiescing" &&
					owner.phase !== "closed")
			)
				throw new Error("Authority owner command is malformed.");
			return;
		}
		case "quarantine":
			if (!exactKeys(value, ["kind", "reason"]) || typeof value.reason !== "string" || !value.reason.trim())
				throw new Error("Authority quarantine command is malformed.");
			return;
		default:
			throw new Error("Unknown authority command kind.");
	}
}

function parseControlTuple(key: string, prefix: string, length: number): readonly unknown[] {
	if (!key.startsWith(prefix)) throw new Error("Authority control key has an invalid prefix.");
	const encoded = key.slice(prefix.length);
	let tuple: unknown;
	try {
		tuple = JSON.parse(encoded);
	} catch {
		throw new Error("Authority control key tuple is invalid.");
	}
	if (!Array.isArray(tuple) || tuple.length !== length || JSON.stringify(tuple) !== encoded)
		throw new Error("Authority control key tuple is invalid.");
	return tuple;
}

function validateAuthorityOwner(value: unknown): asserts value is AuthorityOwner {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Authority owner control is invalid.");
	const owner = value as Record<string, unknown>;
	if (
		!exactKeys(owner, ["incarnation", "epoch", "token", "phase"]) ||
		typeof owner.incarnation !== "string" ||
		!owner.incarnation ||
		!Number.isSafeInteger(owner.epoch) ||
		(owner.epoch as number) < 1 ||
		typeof owner.token !== "string" ||
		!owner.token ||
		(owner.phase !== "recovering" &&
			owner.phase !== "ready" &&
			owner.phase !== "quiescing" &&
			owner.phase !== "closed")
	)
		throw new Error("Authority owner control is invalid.");
}

function parseLocalClaimId(key: string): string {
	const prefix = "local-claim:";
	if (!key.startsWith(prefix)) throw new Error("Local claim control key is invalid.");
	const encoded = key.slice(prefix.length);
	let localId: unknown;
	try {
		localId = JSON.parse(encoded);
	} catch {
		throw new Error("Local claim control key is invalid.");
	}
	if (typeof localId !== "string" || !localId || JSON.stringify(localId) !== encoded)
		throw new Error("Local claim control key is invalid.");
	return localId;
}

interface RootRecoveryEvidence {
	readonly version: 1;
	readonly incarnation: string;
	readonly ownerEpoch: number;
	readonly ownerToken: string;
	readonly rootId: string;
	readonly generation: number;
	readonly rootHeadHash: string;
	readonly rootVersion: number;
	readonly actorVersion: number;
	readonly constructionVersion: number;
	readonly gateVersion: number;
}

function rootRecoveryKey(rootId: string): string {
	return `root-recovery:${JSON.stringify([rootId])}`;
}

function parseRootRecoveryKey(key: string): string {
	const tuple = parseControlTuple(key, "root-recovery:", 1);
	if (typeof tuple[0] !== "string" || !tuple[0] || tuple[0].includes("\0"))
		throw new Error("Root recovery control key is invalid.");
	return tuple[0];
}

function validateRootRecoveryEvidence(key: string, value: unknown): asserts value is RootRecoveryEvidence {
	const rootId = parseRootRecoveryKey(key);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Root recovery control is invalid.");
	const evidence = value as Record<string, unknown>;
	if (
		!exactKeys(evidence, [
			"version",
			"incarnation",
			"ownerEpoch",
			"ownerToken",
			"rootId",
			"generation",
			"rootHeadHash",
			"rootVersion",
			"actorVersion",
			"constructionVersion",
			"gateVersion",
		]) ||
		evidence.version !== 1 ||
		typeof evidence.incarnation !== "string" ||
		!evidence.incarnation ||
		evidence.incarnation.includes("\0") ||
		!Number.isSafeInteger(evidence.ownerEpoch) ||
		(evidence.ownerEpoch as number) < 1 ||
		typeof evidence.ownerToken !== "string" ||
		!evidence.ownerToken ||
		evidence.ownerToken.includes("\0") ||
		evidence.rootId !== rootId ||
		!Number.isSafeInteger(evidence.generation) ||
		(evidence.generation as number) < 1 ||
		typeof evidence.rootHeadHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(evidence.rootHeadHash) ||
		![evidence.rootVersion, evidence.actorVersion, evidence.constructionVersion, evidence.gateVersion].every(
			version => Number.isSafeInteger(version) && (version as number) >= 1,
		)
	)
		throw new Error("Root recovery control fields are invalid.");
}

function validateAuthorityControlValue(key: string, deleted: boolean, value: unknown): void {
	if (deleted) {
		if (key.startsWith("root-recovery:")) parseRootRecoveryKey(key);
		else parseLocalClaimId(key);
		return;
	}
	if (key === "meta") return;
	if (key === "owner") {
		validateAuthorityOwner(value);
		return;
	}
	if (key.startsWith("root-recovery:")) {
		validateRootRecoveryEvidence(key, value);
		return;
	}
	if (key.startsWith("receipt:")) {
		const tuple = parseControlTuple(key, "receipt:", 3);
		if (
			typeof tuple[0] !== "string" ||
			!Number.isSafeInteger(tuple[1]) ||
			typeof tuple[2] !== "string" ||
			!value ||
			typeof value !== "object" ||
			Array.isArray(value)
		)
			throw new Error("Authority receipt control is invalid.");
		const receipt = value as Record<string, unknown>;
		if (
			!exactKeys(receipt, [
				"requestId",
				"ownerEpoch",
				"revision",
				"payloadHash",
				"incarnation",
				"commandKind",
				"committedAt",
				"result",
			]) ||
			receipt.incarnation !== tuple[0] ||
			receipt.ownerEpoch !== tuple[1] ||
			receipt.requestId !== tuple[2]
		)
			throw new Error("Authority receipt control identity does not match its key.");
		return;
	}
	if (key.startsWith("root-generation:")) {
		const tuple = parseControlTuple(key, "root-generation:", 2);
		if (
			typeof tuple[0] !== "string" ||
			!Number.isSafeInteger(tuple[1]) ||
			(tuple[1] as number) < 1 ||
			!value ||
			typeof value !== "object" ||
			Array.isArray(value)
		)
			throw new Error("Root-generation control is invalid.");
		const row = value as Record<string, unknown>;
		if (!exactKeys(row, ["record", "version"]) || !Number.isSafeInteger(row.version) || (row.version as number) < 1)
			throw new Error("Root-generation control row is invalid.");
		validateDurableRegistryRecord(row.record);
		const root = row.record as DurableRootRecord;
		if (root.kind !== "root" || root.rootId !== tuple[0] || root.generation !== tuple[1])
			throw new Error("Root-generation control key does not match its row.");
		return;
	}
	if (key.startsWith("actor-generation:")) {
		const tuple = parseControlTuple(key, "actor-generation:", 2);
		if (
			typeof tuple[0] !== "string" ||
			!Number.isSafeInteger(tuple[1]) ||
			(tuple[1] as number) < 1 ||
			!value ||
			typeof value !== "object" ||
			Array.isArray(value)
		)
			throw new Error("Actor-generation control is invalid.");
		const evidence = value as Record<string, unknown>;
		if (!exactKeys(evidence, ["row"], ["parentGeneration"]))
			throw new Error("Actor-generation control fields are invalid.");
		const row = evidence.row as Record<string, unknown> | undefined;
		if (
			!row ||
			typeof row !== "object" ||
			Array.isArray(row) ||
			!exactKeys(row, ["record", "version"]) ||
			!Number.isSafeInteger(row.version) ||
			(row.version as number) < 1
		)
			throw new Error("Actor-generation control row is invalid.");
		validateDurableRegistryRecord(row.record);
		const actor = row.record as DurableActorRecord;
		if (
			actor.kind !== "actor" ||
			actor.actorId !== tuple[0] ||
			actor.generation !== tuple[1] ||
			(actor.parentId === undefined
				? evidence.parentGeneration !== undefined
				: !Number.isSafeInteger(evidence.parentGeneration) || (evidence.parentGeneration as number) < 1)
		)
			throw new Error("Actor-generation control key or parent lineage does not match its row.");
		return;
	}
	if (key.startsWith("local-claim:")) {
		const localId = parseLocalClaimId(key);
		validateLocalClaim(value);
		if ((value as LocalClaim).localId !== localId)
			throw new Error("Local claim control key does not match its value.");
		return;
	}
	throw new Error("Unknown authority control key.");
}

function validateFrameCommandDeltas(frame: AuthorityCommitFrame): void {
	const expectedChanges = new Map<string, (record: DurableRegistryRecord) => boolean>();
	const expectExact = (record: DurableRegistryRecord): void => {
		const key = authorityKey(record.kind, authorityRecordKey(record));
		const fingerprint = canonicalDurableSha256(record);
		expectedChanges.set(key, actual => canonicalDurableSha256(actual) === fingerprint);
	};
	const expectLocalEntry = (claim: LocalClaim, phase: DurableLocalEntryRecord["phase"]): void => {
		const key = authorityKey("local-entry", [claim.localId, claim.entryId, claim.version]);
		expectedChanges.set(
			key,
			record =>
				record.kind === "local-entry" &&
				record.localId === claim.localId &&
				record.entryId === claim.entryId &&
				record.version === claim.version &&
				record.expectedHeadHash === claim.previousHeadHash &&
				record.entryHash === claim.entryHash &&
				record.headHash === claim.headHash &&
				record.phase === phase,
		);
	};
	const expectLocalHead = (claim: LocalClaim): void => {
		const key = authorityKey("local-head", [claim.localId]);
		expectedChanges.set(
			key,
			record =>
				record.kind === "local-head" &&
				record.localId === claim.localId &&
				record.version === claim.version &&
				record.previousHeadHash === claim.previousHeadHash &&
				record.headHash === claim.headHash &&
				record.phase === "current",
		);
	};
	const command = frame.command;
	switch (command.kind) {
		case "transition":
			expectExact(command.record);
			break;
		case "transition-batch":
			for (const record of command.records) expectExact(record);
			break;
		case "activate-authority":
			if (command.activation.root) expectExact(command.activation.root);
			expectExact(command.activation.actor);
			if (frame.changes.some(row => row.record.kind === "construction"))
				expectExact(command.activation.construction);
			if (command.activation.gate) expectExact(command.activation.gate);
			break;
		case "commit-root-transition":
			expectExact(command.transition.transition);
			if (command.transition.transition.phase !== "recovered") expectExact(command.transition.root);
			expectExact(command.transition.gate);
			break;
		case "reserve-local": {
			const result = frame.receipt.result;
			if (result.kind !== "local-claim") throw new Error("Local reservation must return its durable claim.");
			const claim = result.claim;
			if (
				claim.localId !== command.input.localId ||
				claim.entryId !== command.input.entryId ||
				claim.entryHash !== command.input.entryHash ||
				claim.previousHeadHash !== command.input.expectedHeadHash ||
				claim.phase !== "reserved" ||
				claim.ownerEpoch !== frame.request.ownerEpoch ||
				claim.incarnation !== frame.request.incarnation
			)
				throw new Error("Local reservation receipt does not match its command.");
			expectLocalEntry(claim, "intent");
			break;
		}
		case "authorize-local-effect":
			if (
				command.claim.phase !== "reserved" ||
				command.claim.ownerEpoch !== frame.request.ownerEpoch ||
				command.claim.incarnation !== frame.request.incarnation
			)
				throw new Error("Local authorization requires a reserved claim of the current request owner.");
			expectLocalEntry(command.claim, "effect");
			break;
		case "finalize-local":
			if (
				command.claim.phase !== "effect" ||
				command.claim.ownerEpoch !== frame.request.ownerEpoch ||
				command.claim.incarnation !== frame.request.incarnation
			)
				throw new Error("Local finalization requires an authorized claim of the current request owner.");
			if (command.outcome === "committed") {
				expectLocalEntry(command.claim, "committed");
				expectLocalHead(command.claim);
			}
			break;
		case "reconcile-local":
			if (
				command.input.action === "commit" &&
				(command.input.claim.phase === "reserved" ||
					command.input.observedEntryHash !== command.input.claim.entryHash)
			)
				throw new Error("Local reconciliation cannot commit an unapproved or unobserved effect.");
			if (
				command.input.action === "restore-predecessor" &&
				command.input.claim.previousHeadHash === GENESIS_HASH &&
				command.input.observedEntryHash !== GENESIS_HASH
			)
				throw new Error("Local reconciliation does not prove the genesis predecessor.");
			expectLocalEntry(command.input.claim, command.input.action === "commit" ? "committed" : "cancelled");
			if (command.input.action === "commit") expectLocalHead(command.input.claim);
			break;
		case "recover":
		case "owner":
		case "quarantine":
			break;
	}
	const changes = new Map<string, DurableRegistryRecord>();
	for (const row of frame.changes) {
		const key = authorityKey(row.record.kind, authorityRecordKey(row.record));
		if (changes.has(key)) throw new Error("Authority command frame repeats a changed row key.");
		changes.set(key, row.record);
	}
	if (changes.size !== expectedChanges.size) throw new Error("Authority command and changed rows do not match.");
	for (const [key, check] of expectedChanges) {
		const record = changes.get(key);
		if (!record || !check(record)) throw new Error("Authority command does not match its changed row projection.");
	}
	const controls = new Map(frame.controls.map(change => [change.key, change]));
	const expectedControls = new Set(["meta", receiptKey(frame.request)]);
	if (command.kind === "owner") expectedControls.add("owner");
	for (const record of changes.values()) {
		if (record.kind === "root") expectedControls.add(immutableRootKey(record.rootId, record.generation));
		if (record.kind === "actor") expectedControls.add(immutableActorKey(record.actorId, record.generation));
	}
	if (command.kind === "commit-root-transition" && command.transition.transition.phase === "recovered")
		expectedControls.add(
			immutableRootKey(command.transition.transition.rootId, command.transition.transition.destinationGeneration),
		);
	if (command.kind === "reserve-local") {
		if (frame.receipt.result.kind !== "local-claim")
			throw new Error("Local reservation must return its durable claim.");
		expectedControls.add(localClaimKey(frame.receipt.result.claim.localId));
	} else if (
		command.kind === "authorize-local-effect" ||
		(command.kind === "finalize-local" && command.outcome === "uncertain")
	) {
		expectedControls.add(localClaimKey(command.claim.localId));
	}
	if ((command.kind === "finalize-local" && command.outcome === "committed") || command.kind === "reconcile-local") {
		const localId = command.kind === "finalize-local" ? command.claim.localId : command.input.claim.localId;
		expectedControls.add(localClaimKey(localId));
	}
	const recoveryControlKey =
		command.kind === "transition" && command.record.kind === "gate" && command.record.phase === "closed"
			? rootRecoveryKey(command.record.rootId)
			: command.kind === "activate-authority" &&
				  !command.activation.root &&
				  command.activation.actor.actorId === command.activation.actor.rootId &&
				  command.activation.actor.parentId === undefined &&
				  command.activation.gate?.phase === "open"
				? rootRecoveryKey(command.activation.actor.rootId)
				: undefined;
	const recoveryChange = recoveryControlKey ? controls.get(recoveryControlKey) : undefined;
	const unexpectedControl = [...controls.keys()].some(key => !expectedControls.has(key) && key !== recoveryControlKey);
	if (controls.size !== expectedControls.size + (recoveryChange ? 1 : 0) || unexpectedControl)
		throw new Error("Authority command and control changes do not match.");
	if (recoveryChange) {
		if (command.kind === "transition" && command.record.kind === "gate" && command.record.phase === "closed") {
			const rootId = command.record.rootId;
			if (recoveryChange.deleted)
				throw new Error("Root recovery issuance does not match its closed-gate command and request.");
			if (!recoveryControlKey) throw new Error("Root recovery control key is missing.");
			const evidenceValue = recoveryChange.value;
			validateRootRecoveryEvidence(recoveryControlKey, evidenceValue);
			const gateVersion = frame.changes.find(
				row => row.record.kind === "gate" && row.record.rootId === rootId,
			)?.version;
			if (
				evidenceValue.rootId !== command.record.rootId ||
				evidenceValue.generation !== command.record.generation ||
				evidenceValue.incarnation !== frame.request.incarnation ||
				evidenceValue.ownerEpoch !== frame.request.ownerEpoch ||
				evidenceValue.ownerToken !== frame.request.ownerToken ||
				evidenceValue.gateVersion !== gateVersion
			)
				throw new Error("Root recovery issuance does not match its closed-gate command and request.");
		} else if (command.kind !== "activate-authority" || !recoveryChange.deleted) {
			throw new Error("Root recovery control delta does not match its named command.");
		}
	}
	const meta = controls.get("meta");
	if (!meta || meta.deleted || !meta.value || typeof meta.value !== "object" || Array.isArray(meta.value))
		throw new Error("Authority command has no metadata update.");
	const metaValue = meta.value as Record<string, unknown>;
	if (metaValue.status !== (command.kind === "quarantine" ? "quarantined" : "ready"))
		throw new Error("Authority metadata status does not match its command.");
	if (command.kind === "owner") {
		const owner = controls.get("owner");
		if (
			!owner ||
			owner.deleted ||
			canonicalDurableSha256(owner.value) !== canonicalDurableSha256(command.owner) ||
			command.owner.incarnation !== frame.request.incarnation ||
			command.owner.epoch !== frame.request.ownerEpoch ||
			command.owner.token !== frame.request.ownerToken
		)
			throw new Error("Owner command does not match its durable control update.");
	}
	for (const record of changes.values()) {
		if (record.kind === "root") {
			const control = controls.get(immutableRootKey(record.rootId, record.generation));
			if (
				!control ||
				control.deleted ||
				!control.value ||
				typeof control.value !== "object" ||
				canonicalDurableSha256((control.value as { record?: unknown }).record) !== canonicalDurableSha256(record)
			)
				throw new Error("Root row and immutable generation control disagree.");
		}
		if (record.kind === "actor") {
			const control = controls.get(immutableActorKey(record.actorId, record.generation));
			if (
				!control ||
				control.deleted ||
				!control.value ||
				typeof control.value !== "object" ||
				canonicalDurableSha256((control.value as { row?: { record?: unknown } }).row?.record) !==
					canonicalDurableSha256(record)
			)
				throw new Error("Actor row and immutable generation control disagree.");
		}
	}
	if (command.kind === "commit-root-transition" && command.transition.transition.phase === "recovered") {
		const transition = command.transition.transition;
		const control = controls.get(immutableRootKey(transition.rootId, transition.destinationGeneration));
		if (!control || control.deleted || !control.value || typeof control.value !== "object")
			throw new Error("Pre-CAS recovery must retain destination-generation invalidation history.");
		const destination = (control.value as { record?: DurableRootRecord }).record;
		if (
			!destination ||
			destination.kind !== "root" ||
			destination.rootId !== transition.rootId ||
			destination.generation !== transition.destinationGeneration ||
			destination.headHash !== transition.destinationHeadHash ||
			destination.state !== "invalidated"
		)
			throw new Error("Pre-CAS recovery destination history is inconsistent.");
	}
	for (const [key, control] of controls) {
		if (control.deleted) {
			const recoveredRootDelete =
				command.kind === "activate-authority" &&
				recoveryControlKey === key &&
				command.activation.gate?.phase === "open";
			if (!recoveredRootDelete && command.kind !== "finalize-local" && command.kind !== "reconcile-local")
				throw new Error("Authority command cannot delete this control.");
			continue;
		}
		if (key.startsWith("local-claim:")) {
			const claimControl = control.value as LocalClaim;
			if (
				command.kind === "reserve-local" &&
				(frame.receipt.result.kind !== "local-claim" ||
					canonicalDurableSha256(claimControl) !== canonicalDurableSha256(frame.receipt.result.claim))
			)
				throw new Error("Local reservation claim control and result disagree.");
			if (
				command.kind === "authorize-local-effect" &&
				canonicalDurableSha256(claimControl) !== canonicalDurableSha256({ ...command.claim, phase: "effect" })
			)
				throw new Error("Local effect claim control and command disagree.");
			if (
				command.kind === "finalize-local" &&
				canonicalDurableSha256(claimControl) !== canonicalDurableSha256({ ...command.claim, phase: "uncertain" })
			)
				throw new Error("Uncertain local claim control and command disagree.");
		}
	}
	const resultKind = frame.receipt.result.kind;
	const expectedResult =
		command.kind === "reserve-local"
			? "local-claim"
			: command.kind === "finalize-local" ||
				  (command.kind === "reconcile-local" && command.input.action === "commit")
				? "local-publication"
				: "mutation";
	if (resultKind !== expectedResult) throw new Error("Authority receipt result kind does not match its command.");
	if (frame.receipt.result.kind === "local-publication") {
		const claim =
			command.kind === "finalize-local"
				? command.claim
				: command.kind === "reconcile-local"
					? command.input.claim
					: undefined;
		if (
			!claim ||
			frame.receipt.result.publication.version !== claim.version ||
			frame.receipt.result.publication.headHash !== claim.headHash
		)
			throw new Error("Local publication receipt does not match its claim command.");
	}
	let requiredHighWater = 0;
	for (const row of frame.changes) requiredHighWater = highWaterFor(row.record, requiredHighWater);
	if (
		!Number.isSafeInteger(metaValue.generationHighWater) ||
		(metaValue.generationHighWater as number) < requiredHighWater
	)
		throw new Error("Authority metadata high-water is below a changed generation.");
}

function assertCurrentAncestry(
	actor: DurableActorRecord,
	root: DurableRootRecord,
	getRow: <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
): void {
	const seen = new Set([actor.actorId]);
	let current = actor;
	while (current.parentId !== undefined) {
		if (seen.has(current.parentId)) throw new Error("Actor activation ancestry contains a self-reference or cycle.");
		seen.add(current.parentId);
		const parent = getRow("actor", [current.parentId])?.record;
		if (
			!parent ||
			parent.state !== "active" ||
			parent.rootId !== root.rootId ||
			parent.rootGeneration !== root.generation ||
			parent.rootHeadHash !== root.headHash ||
			(current.parentScopeHash !== undefined && current.parentScopeHash !== parent.scopeHash)
		)
			throw new Error("Actor activation ancestry is not current under the active root.");
		if (parent.actorId === root.rootId) {
			if (
				parent.parentId !== undefined ||
				parent.generation !== root.generation ||
				parent.actorId !== parent.rootId ||
				parent.rootHeadHash !==
					durableRootHeadHash({
						rootId: root.rootId,
						generation: root.generation,
						actorId: root.rootId,
						startupHash: parent.startupHash,
						provenanceHash: parent.provenanceHash,
					})
			)
				throw new Error("Actor activation ancestry does not terminate at the active root actor.");
			return;
		}
		current = parent;
	}
	throw new Error("Actor activation ancestry does not reach the active root actor.");
}

function sameActorGenerationIdentity(left: DurableActorRecord, right: DurableActorRecord): boolean {
	return (
		left.actorId === right.actorId &&
		left.generation === right.generation &&
		left.rootId === right.rootId &&
		left.parentId === right.parentId &&
		left.rootGeneration === right.rootGeneration &&
		left.rootHeadHash === right.rootHeadHash &&
		left.startupHash === right.startupHash &&
		left.provenanceHash === right.provenanceHash &&
		left.scopeHash === right.scopeHash &&
		left.parentScopeHash === right.parentScopeHash
	);
}

function isCurrentActorRevival(
	actor: DurableActorRecord,
	getRow: <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
	getControl: (key: string) => unknown,
): boolean {
	const root = getRow("root", [actor.rootId])?.record;
	if (
		!root ||
		root.state !== "active" ||
		(actor.state !== "active" && actor.state !== "parked") ||
		actor.rootGeneration !== root.generation ||
		actor.rootHeadHash !== root.headHash
	)
		return false;
	const rootRow = asRow<DurableRootRecord>(getControl(immutableRootKey(root.rootId, root.generation)));
	if (
		!rootRow ||
		rootRow.record.kind !== "root" ||
		rootRow.record.rootId !== root.rootId ||
		rootRow.record.generation !== root.generation ||
		rootRow.record.headHash !== root.headHash ||
		rootRow.record.state !== "active"
	)
		return false;
	const seen = new Set<string>();
	let cursor = actor;
	while (true) {
		if (seen.has(cursor.actorId)) return false;
		seen.add(cursor.actorId);
		const lineage = getControl(immutableActorKey(cursor.actorId, cursor.generation));
		if (!lineage || typeof lineage !== "object" || !("row" in lineage)) return false;
		const history = asRow<DurableActorRecord>(lineage.row);
		if (
			!history ||
			history.record.kind !== "actor" ||
			!sameActorGenerationIdentity(history.record, cursor) ||
			(history.record.state !== "active" && history.record.state !== "parked")
		)
			return false;
		if (cursor.parentId === undefined) {
			return (
				!("parentGeneration" in lineage) &&
				cursor.actorId === root.rootId &&
				cursor.generation === root.generation &&
				cursor.rootHeadHash ===
					durableRootHeadHash({
						rootId: root.rootId,
						generation: root.generation,
						actorId: cursor.actorId,
						startupHash: cursor.startupHash,
						provenanceHash: cursor.provenanceHash,
					})
			);
		}
		if (!("parentGeneration" in lineage)) return false;
		const parentGeneration = lineage.parentGeneration;
		if (typeof parentGeneration !== "number" || !Number.isSafeInteger(parentGeneration) || parentGeneration < 1)
			return false;
		const parent = getRow("actor", [cursor.parentId])?.record;
		if (
			!parent ||
			parent.state !== "active" ||
			parent.generation !== parentGeneration ||
			parent.rootId !== root.rootId ||
			parent.rootGeneration !== root.generation ||
			parent.rootHeadHash !== root.headHash ||
			(cursor.parentScopeHash !== undefined && cursor.parentScopeHash !== parent.scopeHash)
		)
			return false;
		cursor = parent;
	}
}

function rootRecoveryEvidenceFor(
	rootId: string,
	owner: AuthorityOwner,
	gateVersion: number,
	getRow: <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
	getControl: (key: string) => unknown,
): RootRecoveryEvidence | undefined {
	const rootRow = getRow("root", [rootId]);
	const actorRow = getRow("actor", [rootId]);
	const gateRow = getRow("gate", [rootId]);
	if (
		!rootRow ||
		!actorRow ||
		!gateRow ||
		rootRow.record.state !== "active" ||
		gateRow.record.generation !== rootRow.record.generation
	)
		return undefined;
	const root = rootRow.record;
	const actor = actorRow.record;
	if (
		actor.actorId !== rootId ||
		actor.rootId !== rootId ||
		actor.parentId !== undefined ||
		actor.generation !== root.generation ||
		actor.rootGeneration !== root.generation ||
		actor.rootHeadHash !== root.headHash ||
		(actor.state !== "active" && actor.state !== "parked") ||
		root.headHash !==
			durableRootHeadHash({
				rootId,
				generation: root.generation,
				actorId: rootId,
				startupHash: actor.startupHash,
				provenanceHash: actor.provenanceHash,
			}) ||
		!isCurrentActorRevival(actor, getRow, getControl)
	)
		return undefined;
	const constructionRow = getRow("construction", [rootId, rootId, root.generation]);
	if (!constructionRow) return undefined;
	const construction = constructionRow.record;
	if (
		construction.phase !== "activated" ||
		construction.parentId !== undefined ||
		construction.rootId !== rootId ||
		construction.actorId !== rootId ||
		construction.generation !== root.generation ||
		construction.startupHash !== actor.startupHash ||
		construction.provenanceHash !== actor.provenanceHash ||
		construction.scopeHash !== actor.scopeHash ||
		construction.parentScopeHash !== actor.parentScopeHash
	)
		return undefined;
	return Object.freeze({
		version: 1,
		incarnation: owner.incarnation,
		ownerEpoch: owner.epoch,
		ownerToken: owner.token,
		rootId,
		generation: root.generation,
		rootHeadHash: root.headHash,
		rootVersion: rootRow.version,
		actorVersion: actorRow.version,
		constructionVersion: constructionRow.version,
		gateVersion,
	});
}

function recoveredRootActivationEvidence(
	activation: AuthorityActivation,
	getRow: <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
	getControl: (key: string) => unknown,
): RootRecoveryEvidence | undefined {
	const actor = activation.actor;
	const gateRow = getRow("gate", [actor.rootId]);
	const owner = getControl("owner");
	if (
		activation.root ||
		!activation.gate ||
		actor.actorId !== actor.rootId ||
		actor.parentId !== undefined ||
		activation.gate.phase !== "open" ||
		!gateRow ||
		gateRow.record.phase !== "closed" ||
		gateRow.record.generation !== actor.rootGeneration ||
		!owner ||
		typeof owner !== "object" ||
		Array.isArray(owner)
	)
		return undefined;
	validateAuthorityOwner(owner);
	if (owner.phase !== "ready") return undefined;
	const expected = rootRecoveryEvidenceFor(actor.rootId, owner, gateRow.version, getRow, getControl);
	const retained = getControl(rootRecoveryKey(actor.rootId));
	return expected && retained && canonicalDurableSha256(expected) === canonicalDurableSha256(retained)
		? expected
		: undefined;
}

function validateActivationAdmission(
	activation: AuthorityActivation,
	getRow: <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
	getControl: (key: string) => unknown,
): boolean {
	const actor = activation.actor;
	const construction = activation.construction;
	if (
		actor.actorId !== construction.actorId ||
		actor.rootId !== construction.rootId ||
		actor.parentId !== construction.parentId ||
		actor.generation !== construction.generation ||
		actor.startupHash !== construction.startupHash ||
		actor.provenanceHash !== construction.provenanceHash ||
		actor.scopeHash !== construction.scopeHash ||
		actor.parentScopeHash !== construction.parentScopeHash ||
		construction.phase !== "activated" ||
		actor.state !== "active"
	)
		throw new Error("Authority activation records are not coherent.");
	const reserved = getRow("construction", [construction.rootId, construction.actorId, construction.generation]);
	if (
		!reserved ||
		(reserved.record.phase !== "constructed" && reserved.record.phase !== "activated") ||
		reserved.record.parentId !== construction.parentId ||
		reserved.record.startupHash !== construction.startupHash ||
		reserved.record.provenanceHash !== construction.provenanceHash ||
		reserved.record.scopeHash !== construction.scopeHash ||
		reserved.record.parentScopeHash !== construction.parentScopeHash
	)
		throw new Error("Authority activation requires the matching constructed reservation.");
	const revival = reserved.record.phase === "activated";
	if (revival) {
		const currentActor = getRow("actor", [actor.actorId])?.record;
		if (
			!currentActor ||
			!sameActorGenerationIdentity(currentActor, actor) ||
			!isCurrentActorRevival(currentActor, getRow, getControl)
		)
			throw new Error("Authority revival requires the exact nonterminal actor and immutable current lineage.");
	}
	const rootRow = getRow("root", [actor.rootId]);
	const gate = activation.gate;
	const persistedGate = getRow("gate", [actor.rootId])?.record;
	if (gate && (gate.rootId !== actor.rootId || gate.generation !== actor.rootGeneration || gate.phase !== "open"))
		throw new Error("Authority activation gate does not match the active root generation.");
	if (activation.root) {
		const root = activation.root;
		if (
			rootRow ||
			root.rootId !== actor.rootId ||
			root.generation !== actor.rootGeneration ||
			actor.actorId !== root.rootId ||
			actor.generation !== root.generation ||
			actor.parentId !== undefined ||
			actor.rootHeadHash !== root.headHash ||
			root.state !== "active" ||
			!gate ||
			persistedGate ||
			root.headHash !==
				durableRootHeadHash({
					rootId: root.rootId,
					generation: root.generation,
					actorId: actor.actorId,
					startupHash: actor.startupHash,
					provenanceHash: actor.provenanceHash,
				})
		)
			throw new Error("Authority root activation identity is inconsistent.");
		return true;
	}
	if (
		!rootRow ||
		rootRow.record.state !== "active" ||
		rootRow.record.rootId !== actor.rootId ||
		rootRow.record.generation !== actor.rootGeneration ||
		rootRow.record.headHash !== actor.rootHeadHash
	)
		throw new Error("Authority activation requires the exact active root generation.");
	if (!persistedGate) throw new Error("Authority activation requires persisted root-gate evidence.");
	const currentGateOpen = persistedGate.generation === rootRow.record.generation && persistedGate.phase === "open";
	const predecessorGateClosed =
		persistedGate.generation < rootRow.record.generation && persistedGate.phase === "closed";
	const recoveredRoot =
		actor.actorId === actor.rootId &&
		gate !== undefined &&
		!!recoveredRootActivationEvidence(activation, getRow, getControl);
	if (gate ? !currentGateOpen && !predecessorGateClosed && !recoveredRoot : !currentGateOpen)
		throw new Error(
			"Authority activation requires the current open root gate, a closed predecessor gate, or exact recovered-root evidence.",
		);
	if (actor.actorId === actor.rootId) {
		if (
			actor.parentId !== undefined ||
			actor.generation !== rootRow.record.generation ||
			(!gate && !revival) ||
			rootRow.record.headHash !==
				durableRootHeadHash({
					rootId: rootRow.record.rootId,
					generation: rootRow.record.generation,
					actorId: actor.actorId,
					startupHash: actor.startupHash,
					provenanceHash: actor.provenanceHash,
				})
		)
			throw new Error("Root actor activation identity is inconsistent.");
	} else {
		if (actor.parentId === undefined) throw new Error("Non-root actors require a current-root parent chain.");
		assertCurrentAncestry(actor, rootRow.record, getRow);
	}
	return !revival;
}

function validateRootTransitionAdmission(
	input: RootTransitionCommit,
	getRow: <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
	getControl: (key: string) => unknown,
): void {
	const transition = input.transition;
	const root = getRow("root", [transition.rootId]);
	const sourceGate = getRow("gate", [transition.rootId]);
	const persistedTransition = getRow("transition", [transition.rootId, transition.transitionId])?.record;
	if (
		!root ||
		root.record.state !== "active" ||
		root.record.generation !== input.expectedRootGeneration ||
		root.record.headHash !== input.expectedRootHeadHash ||
		transition.sourceGeneration !== input.expectedRootGeneration ||
		transition.sourceHeadHash !== input.expectedRootHeadHash ||
		transition.rootId !== root.record.rootId ||
		!persistedTransition ||
		persistedTransition.sourceGeneration !== transition.sourceGeneration ||
		persistedTransition.destinationGeneration !== transition.destinationGeneration ||
		persistedTransition.sourceHeadHash !== transition.sourceHeadHash ||
		persistedTransition.destinationHeadHash !== transition.destinationHeadHash
	)
		throw new DurableStateConflictError("Root transition identity or source compare-and-swap changed.");
	if (transition.phase === "recovered") {
		if (
			!["staged", "quiescing", "quiesced", "validated"].includes(persistedTransition.phase) ||
			!sourceGate ||
			sourceGate.record.generation !== input.expectedRootGeneration ||
			(sourceGate.record.phase !== "quiescing" && sourceGate.record.phase !== "quiesced") ||
			transition.recovery !== true ||
			input.root.state !== "active" ||
			canonicalDurableSha256(input.root) !== canonicalDurableSha256(root.record) ||
			input.gate.rootId !== root.record.rootId ||
			input.gate.generation !== input.expectedRootGeneration ||
			input.gate.phase !== "open"
		)
			throw new DurableStateConflictError(
				"Pre-CAS recovery requires the exact active source and a quiescing source gate.",
			);
		if (asRow<DurableRootRecord>(getControl(immutableRootKey(root.record.rootId, transition.destinationGeneration))))
			throw new DurableStateConflictError("Consumed destination generation already has immutable history.");
		return;
	}
	if (
		!sourceGate ||
		sourceGate.record.generation !== input.expectedRootGeneration ||
		sourceGate.record.phase !== "quiesced" ||
		persistedTransition.phase !== "validated" ||
		transition.phase !== "cas-committed" ||
		transition.recovery !== undefined ||
		input.root.rootId !== root.record.rootId ||
		input.root.generation !== transition.destinationGeneration ||
		input.root.state !== "active" ||
		input.root.headHash !== transition.destinationHeadHash ||
		input.gate.rootId !== input.root.rootId ||
		input.gate.generation !== input.expectedRootGeneration ||
		input.gate.phase !== "closed"
	)
		throw new Error("Root transition commit is inconsistent.");
}
export interface AuthorityFrameState {
	get<D extends AuthorityDomain>(domain: D, key: AuthorityKey): AuthorityRow<AuthorityRecordMap[D]> | undefined;
	getControl(key: string): unknown;
	/**
	 * Local entries of `localId` at exactly `version`. Validation only ever needs the entries of the current
	 * head's version, so a driver can index by version and keep each local command proportional to one version.
	 */
	localEntriesAt(localId: string, version: number): Iterable<AuthorityRow<DurableLocalEntryRecord>>;
}

function validateAuthorityRelationships(
	record: DurableRegistryRecord,
	getRow: <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	) => AuthorityRow<AuthorityRecordMap[D]> | undefined,
	getControl: (key: string) => unknown | undefined,
): void {
	if (record.kind === "actor") {
		const root = asRow<DurableRootRecord>(getControl(immutableRootKey(record.rootId, record.rootGeneration)));
		if (!root || root.record.headHash !== record.rootHeadHash)
			throw new Error("Actor references missing root generation evidence.");
		if (record.parentId !== undefined) {
			const parent = getRow("actor", [record.parentId]);
			if (
				!parent ||
				parent.record.rootId !== record.rootId ||
				parent.record.rootGeneration !== record.rootGeneration ||
				parent.record.rootHeadHash !== record.rootHeadHash ||
				parent.record.state !== "active"
			)
				throw new Error("Actor references a missing or invalid parent.");
			if (record.parentScopeHash !== undefined && record.parentScopeHash !== parent.record.scopeHash)
				throw new Error("Actor parent permission snapshot drifted.");
		}
	}
	if (record.kind === "construction") {
		const root = getRow("root", [record.rootId]);
		const rootReservation = record.actorId === record.rootId && record.parentId === undefined;
		if ((!root || root.record.state !== "active") && !rootReservation)
			throw new Error("Construction requires an active root or a root construction reservation.");
		if (record.parentId !== undefined) {
			const parent = getRow("actor", [record.parentId]);
			if (!parent || parent.record.state !== "active" || parent.record.rootId !== record.rootId)
				throw new Error("Construction parent is unavailable.");
		}
	}
	if (record.kind === "resource") {
		const actor = getRow("actor", [record.actorId]);
		if (
			actor &&
			(actor.record.generation !== record.generation ||
				(actor.record.state !== "active" && actor.record.state !== "parked"))
		)
			throw new Error("Resource actor generation is not current.");
	}
}

function validateLocalReservationAdmission(
	input: LocalReservation,
	backing: DurableLocalBackingExpectation | null,
): { readonly version: number; readonly previousHeadHash: string; readonly headHash: string } {
	const previousHeadHash = backing?.headHash ?? GENESIS_HASH;
	if (input.expectedHeadHash !== previousHeadHash)
		throw new DurableStateConflictError("Local expected head does not match current durable head.");
	const version = (backing?.version ?? 0) + 1;
	const headHash = canonicalDurableSha256({
		localId: input.localId,
		entryId: input.entryId,
		version,
		previousHeadHash,
		entryHash: input.entryHash,
	});
	return { version, previousHeadHash, headHash };
}

function localBackingFromFrameState(
	state: AuthorityFrameState,
	localId: string,
): DurableLocalBackingExpectation | null {
	const head = state.get("local-head", [localId]);
	if (!head || head.record.phase !== "current") return null;
	let entry: DurableLocalEntryRecord | undefined;
	for (const row of state.localEntriesAt(localId, head.record.version)) {
		const record = row.record;
		if (
			record.localId !== localId ||
			record.version !== head.record.version ||
			record.headHash !== head.record.headHash ||
			record.phase !== "committed"
		)
			continue;
		if (entry)
			throw new DurableStateUnavailableError("Current local head does not have exactly one committed entry.");
		entry = record;
	}
	if (!entry) throw new DurableStateUnavailableError("Current local head does not have exactly one committed entry.");
	return Object.freeze({
		version: head.record.version,
		headHash: head.record.headHash,
		entryId: entry.entryId,
		entryHash: entry.entryHash,
	});
}

function validateAuthorityFrameRelationships(
	frame: AuthorityCommitFrame,
	state: AuthorityFrameState,
): ReadonlyMap<string, number | undefined> | undefined {
	const command = frame.command;
	if (command.kind === "commit-root-transition") return undefined;
	if (command.kind === "activate-authority") {
		const activation = command.activation;
		const getRow = <D extends AuthorityDomain>(
			domain: D,
			key: readonly (string | number)[],
		): AuthorityRow<AuthorityRecordMap[D]> | undefined => state.get(domain, key);
		if (activation.root) {
			const root = activation.root;
			const rootHistoryKey = immutableRootKey(root.rootId, root.generation);
			const getControl = (key: string): unknown | undefined =>
				key === rootHistoryKey ? { record: root, version: 1 } : state.getControl(key);
			validateAuthorityRelationships(activation.construction, getRow, getControl);
			validateAuthorityRelationships(activation.actor, getRow, getControl);
		} else {
			const getControl = (key: string): unknown | undefined => state.getControl(key);
			validateAuthorityRelationships(activation.construction, getRow, getControl);
			validateAuthorityRelationships(activation.actor, getRow, getControl);
		}
		return undefined;
	}
	if (command.kind === "transition") {
		const record = command.record;
		if (record.kind === "actor" || record.kind === "construction" || record.kind === "resource")
			validateAuthorityRelationships(
				record,
				(domain, key) => state.get(domain, key),
				key => state.getControl(key),
			);
		return undefined;
	}
	let hasRelationships = false;
	if (command.kind === "transition-batch") {
		for (const record of command.records) {
			if (record.kind === "actor" || record.kind === "construction" || record.kind === "resource") {
				hasRelationships = true;
				break;
			}
		}
	} else {
		for (const row of frame.changes) {
			if (row.record.kind === "actor" || row.record.kind === "construction" || row.record.kind === "resource") {
				hasRelationships = true;
				break;
			}
		}
	}
	if (!hasRelationships) return undefined;
	if (command.kind !== "transition-batch" && frame.changes.length === 1) {
		const record = frame.changes[0]!.record;
		validateAuthorityRelationships(
			record,
			(domain, key) => state.get(domain, key),
			key => state.getControl(key),
		);
		return undefined;
	}
	const stagedRows = new Map<string, AuthorityRow>();
	const stagedControls = new Map<string, unknown>();
	let firstParentGenerations: Map<string, number | undefined> | undefined;
	const getRow = <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	): AuthorityRow<AuthorityRecordMap[D]> | undefined =>
		(stagedRows.get(authorityKey(domain, key)) ?? state.get(domain, key)) as
			| AuthorityRow<AuthorityRecordMap[D]>
			| undefined;
	const getControl = (key: string): unknown | undefined =>
		stagedControls.has(key) ? stagedControls.get(key) : state.getControl(key);
	const apply = (record: DurableRegistryRecord): void => {
		const domain = record.kind;
		const key = authorityRecordKey(record);
		if (record.kind === "actor") {
			const historyKey = immutableActorKey(record.actorId, record.generation);
			if (getControl(historyKey) === undefined) {
				const parent = record.parentId === undefined ? undefined : getRow("actor", [record.parentId]);
				(firstParentGenerations ??= new Map()).set(historyKey, parent?.record.generation);
			}
		}
		const row = state.get(domain, key);
		stagedRows.set(authorityKey(domain, key), { record, version: (row?.version ?? 0) + 1 });
		validateAuthorityRelationships(record, getRow, getControl);
		if (record.kind === "root") {
			const historyKey = immutableRootKey(record.rootId, record.generation);
			const persisted = state.getControl(historyKey);
			const previous = persisted === undefined ? undefined : controlRow(persisted, "root");
			stagedControls.set(historyKey, { record, version: (previous?.version ?? 0) + 1 });
		} else if (record.kind === "actor") {
			const historyKey = immutableActorKey(record.actorId, record.generation);
			const previous = getControl(historyKey);
			const evidence = previous === undefined ? undefined : actorControl(previous);
			let parentGeneration = evidence?.parentGeneration;
			if (!evidence && record.parentId !== undefined)
				parentGeneration = getRow("actor", [record.parentId])?.record.generation;
			const persisted = state.getControl(historyKey);
			const original = persisted === undefined ? undefined : actorControl(persisted);
			stagedControls.set(historyKey, {
				row: { record, version: (original?.row.version ?? 0) + 1 },
				...(parentGeneration === undefined ? {} : { parentGeneration }),
			});
		}
	};
	if (command.kind === "transition-batch") {
		for (const record of command.records) apply(record);
	} else {
		for (const row of frame.changes) apply(row.record);
	}
	return firstParentGenerations;
}

function validateRootRecoveryFrameContext(frame: AuthorityCommitFrame, state: AuthorityFrameState): void {
	const command = frame.command;
	const deltas = frame.controls.filter(change => change.key.startsWith("root-recovery:"));
	if (deltas.length === 0 && command.kind !== "activate-authority" && command.kind !== "transition") return;
	const getRow = <D extends AuthorityDomain>(
		domain: D,
		key: readonly (string | number)[],
	): AuthorityRow<AuthorityRecordMap[D]> | undefined => state.get(domain, key);
	const getControl = (key: string): unknown => state.getControl(key);
	if (command.kind === "transition" && command.record.kind === "gate" && command.record.phase === "closed") {
		const rootId = command.record.rootId;
		const ownerControl = state.getControl("owner");
		const gate = state.get("gate", [command.record.rootId]);
		const root = state.get("root", [command.record.rootId]);
		let recoveringOwner: AuthorityOwner | undefined;
		if (ownerControl && typeof ownerControl === "object" && !Array.isArray(ownerControl)) {
			validateAuthorityOwner(ownerControl);
			recoveringOwner = ownerControl;
		}
		const isCurrentClosing =
			recoveringOwner?.phase === "recovering" &&
			root?.record.state === "active" &&
			root.record.generation === command.record.generation &&
			gate?.record.generation === command.record.generation;
		const gateChange = frame.changes.find(row => row.record.kind === "gate" && row.record.rootId === rootId);
		const expected =
			recoveringOwner && isCurrentClosing && gateChange
				? rootRecoveryEvidenceFor(command.record.rootId, recoveringOwner, gateChange.version, getRow, getControl)
				: undefined;
		const key = rootRecoveryKey(command.record.rootId);
		const control = deltas.find(change => change.key === key);
		if (deltas.some(change => change.key !== key))
			throw new Error("Root recovery frame contains an unrelated control delta.");
		const previous = state.getControl(key);
		if (expected && previous !== undefined) {
			validateRootRecoveryEvidence(key, previous);
			if (
				previous.incarnation === expected.incarnation &&
				previous.ownerEpoch === expected.ownerEpoch &&
				previous.ownerToken === expected.ownerToken
			)
				throw new Error("Root recovery evidence cannot be renewed within the same owner epoch.");
		}
		if (expected) {
			if (
				!control ||
				control.deleted ||
				!control.value ||
				canonicalDurableSha256(control.value) !== canonicalDurableSha256(expected)
			)
				throw new Error("Recovering-owner gate closure must issue exact root recovery evidence.");
		} else if (control) throw new Error("Root recovery evidence is not eligible for this gate closure.");
		return;
	}
	if (command.kind === "activate-authority") {
		const expected = recoveredRootActivationEvidence(command.activation, getRow, getControl);
		const key = rootRecoveryKey(command.activation.actor.rootId);
		const control = deltas.find(change => change.key === key);
		if (deltas.some(change => change.key !== key))
			throw new Error("Root activation contains an unrelated recovery control delta.");
		if (expected) {
			if (!control || !control.deleted)
				throw new Error("Recovered-root activation must consume its exact recovery evidence.");
		} else if (control) throw new Error("Root activation cannot consume unrelated or invalid recovery evidence.");
		return;
	}
	if (deltas.length) throw new Error("This authority command cannot change root recovery evidence.");
}

export function validateAuthorityFrameState(frame: AuthorityCommitFrame, state: AuthorityFrameState): void {
	validateFrameCommandDeltas(frame);
	validateRootRecoveryFrameContext(frame, state);
	const command = frame.command;
	if (command.kind === "reserve-local") {
		const admission = validateLocalReservationAdmission(
			command.input,
			localBackingFromFrameState(state, command.input.localId),
		);
		const result = frame.receipt.result;
		if (result.kind !== "local-claim") throw new Error("Local reservation must return its durable claim.");
		if (
			result.claim.version !== admission.version ||
			result.claim.previousHeadHash !== admission.previousHeadHash ||
			result.claim.headHash !== admission.headHash
		)
			throw new Error("Local reservation claim does not match its derived next version and head.");
	}
	const firstParentGenerations = validateAuthorityFrameRelationships(frame, state);
	if (command.kind === "activate-authority") {
		const activateConstruction = validateActivationAdmission(
			command.activation,
			(domain, key) => state.get(domain, key),
			key => state.getControl(key),
		);
		if (frame.changes.some(row => row.record.kind === "construction") !== activateConstruction)
			throw new Error(
				"Authority activation must advance a constructed reservation and preserve an already activated construction.",
			);
	}
	if (command.kind === "commit-root-transition") {
		validateRootTransitionAdmission(
			command.transition,
			(domain, key) => state.get(domain, key),
			key => state.getControl(key),
		);
	}

	const owner = state.getControl("owner");
	if (command.kind !== "owner") {
		validateAuthorityOwner(owner);
		if (
			owner.epoch !== frame.request.ownerEpoch ||
			owner.incarnation !== frame.request.incarnation ||
			owner.token !== frame.request.ownerToken
		)
			throw new Error("Authority frame request belongs to a stale owner.");
		const recoveryGateClose =
			command.kind === "transition" &&
			command.record.kind === "gate" &&
			command.record.phase === "closed" &&
			state.get("root", [command.record.rootId])?.record.generation === command.record.generation;
		if (
			owner.phase !== "ready" &&
			!(
				owner.phase === "recovering" &&
				(command.kind === "recover" ||
					command.kind === "reconcile-local" ||
					command.kind === "quarantine" ||
					recoveryGateClose)
			) &&
			!(
				owner.phase === "quiescing" &&
				(command.kind === "finalize-local" || command.kind === "reconcile-local" || command.kind === "quarantine")
			)
		)
			throw new Error("Authority frame command is not admitted in the persisted owner phase.");
	}
	for (const expected of frame.expected) {
		if ((state.get(expected.domain, expected.key)?.version ?? null) !== expected.version)
			throw new Error("Authority frame expected row version does not match prior state.");
	}
	for (const row of frame.changes) {
		const key = authorityKey(row.record.kind, authorityRecordKey(row.record));
		const expected = frame.expected.find(item => authorityKey(item.domain, item.key) === key);
		if (!expected || row.version !== (expected.version ?? 0) + 1)
			throw new Error("Authority frame changed row version does not match prior state.");
	}
	const allowRecovery =
		command.kind === "commit-root-transition" && command.transition.transition.phase === "recovered";
	if (
		command.kind === "authorize-local-effect" ||
		command.kind === "finalize-local" ||
		command.kind === "reconcile-local"
	) {
		const claim = command.kind === "reconcile-local" ? command.input.claim : command.claim;
		assertSameClaim(state.getControl(localClaimKey(claim.localId)), claim);
		const entry = state.get("local-entry", [claim.localId, claim.entryId, claim.version])?.record;
		const head = state.get("local-head", [claim.localId])?.record;
		const headHash = head?.phase === "current" ? head.headHash : GENESIS_HASH;
		if (
			!entry ||
			entry.expectedHeadHash !== claim.previousHeadHash ||
			entry.entryHash !== claim.entryHash ||
			entry.headHash !== claim.headHash ||
			entry.phase !== (claim.phase === "reserved" ? "intent" : "effect") ||
			headHash !== claim.previousHeadHash
		)
			throw new Error("Local command does not match its retained claim and predecessor.");
		if (command.kind === "reconcile-local" && command.input.action === "restore-predecessor") {
			let prior: DurableLocalEntryRecord | undefined;
			if (head?.phase === "current") {
				for (const row of state.localEntriesAt(claim.localId, head.version)) {
					const record = row.record;
					if (
						record.localId !== claim.localId ||
						record.version !== head.version ||
						record.headHash !== headHash ||
						record.phase !== "committed"
					)
						continue;
					if (prior) throw new Error("Local reconciliation predecessor is ambiguous.");
					prior = record;
				}
			}
			if (
				(headHash !== GENESIS_HASH && !prior) ||
				command.input.observedEntryHash !== (headHash === GENESIS_HASH ? GENESIS_HASH : prior?.entryHash)
			)
				throw new Error("Local reconciliation does not prove the observed predecessor.");
		}
	}
	if (frame.command.kind === "transition-batch") {
		validateBatchEffectPhases(frame.command.records);
		const staged = new Map<string, AuthorityRecordMap[AuthorityDomain]>();
		for (const record of frame.command.records) {
			const key = authorityKey(record.kind, authorityRecordKey(record));
			const previous = staged.get(key) ?? state.get(record.kind, authorityRecordKey(record))?.record;
			validateGenericRecordAdmission(previous, record);
			validateAuthorityRecordProgress(previous, record, allowRecovery);
			staged.set(key, record);
		}
	} else {
		for (const row of frame.changes) {
			const record = row.record;
			const previous = state.get(record.kind, authorityRecordKey(record))?.record;
			if (command.kind === "transition") validateGenericRecordAdmission(previous, record);
			validateAuthorityRecordProgress(previous, record, allowRecovery);
		}
	}
	for (const change of frame.controls) {
		const previous = state.getControl(change.key);
		if (change.key === "meta") {
			if (change.deleted) throw new Error("Authority metadata cannot be deleted.");
			const oldMeta = previous as Record<string, unknown> | undefined;
			const nextMeta = change.value as Record<string, unknown>;
			if (
				!oldMeta ||
				typeof oldMeta !== "object" ||
				oldMeta.revision !== frame.revision - 1 ||
				oldMeta.headHash !== frame.previousHash ||
				!Number.isSafeInteger(oldMeta.generationHighWater) ||
				(nextMeta.generationHighWater as number) < (oldMeta.generationHighWater as number) ||
				(oldMeta.status === "quarantined" && nextMeta.status !== "quarantined")
			)
				throw new Error("Authority metadata regresses previously committed state.");
			continue;
		}
		if (change.key === "owner") {
			if (change.deleted) throw new Error("Authority owner cannot be deleted.");
			const next = change.value as AuthorityOwner;
			const old = previous as AuthorityOwner | undefined;
			if (!old) {
				if (next.epoch !== 1 || next.phase !== "recovering")
					throw new Error("Initial authority owner state is invalid.");
			} else if (
				next.epoch === old.epoch
					? next.incarnation !== old.incarnation ||
						next.token !== old.token ||
						!(
							(old.phase === "recovering" &&
								["recovering", "ready", "quiescing", "closed"].includes(next.phase)) ||
							(old.phase === "ready" && ["ready", "quiescing", "closed"].includes(next.phase)) ||
							(old.phase === "quiescing" && ["quiescing", "closed"].includes(next.phase)) ||
							(old.phase === "closed" && next.phase === "closed")
						)
					: next.epoch !== old.epoch + 1 || next.phase !== "recovering"
			) {
				throw new Error("Authority owner epoch or phase transition is invalid.");
			}
			continue;
		}
		if (change.key.startsWith("receipt:")) {
			if (previous !== undefined || change.deleted) throw new Error("Authority receipt is duplicated or deleted.");
			continue;
		}
		if (change.key.startsWith("root-generation:")) {
			if (change.deleted) throw new Error("Root generation history cannot be deleted.");
			const next = controlRow(change.value, "root");
			const old = previous === undefined ? undefined : controlRow(previous, "root");
			if (next.version !== (old?.version ?? 0) + 1)
				throw new Error("Root generation history version is not consecutive.");
			if (old) validateAuthorityRecordProgress(old.record, next.record);
			continue;
		}
		if (change.key.startsWith("actor-generation:")) {
			if (change.deleted) throw new Error("Actor generation history cannot be deleted.");
			const next = actorControl(change.value);
			const old = previous === undefined ? undefined : actorControl(previous);
			if (!old) {
				const orderedAdmission = firstParentGenerations?.has(change.key) ?? false;
				const actualParentGeneration =
					next.row.record.parentId === undefined
						? undefined
						: state.get("actor", [next.row.record.parentId])?.record.generation;
				const expectedParentGeneration = orderedAdmission
					? firstParentGenerations?.get(change.key)
					: actualParentGeneration;
				if (
					(firstParentGenerations !== undefined && !orderedAdmission) ||
					(command.kind === "transition-batch" && !orderedAdmission) ||
					next.parentGeneration !== expectedParentGeneration
				)
					throw new Error("Actor first-admission parent generation does not match its persisted parent.");
			}
			if (
				next.row.version !== (old?.row.version ?? 0) + 1 ||
				(old && old.parentGeneration !== next.parentGeneration)
			)
				throw new Error("Actor generation history version or first-parent lineage changed.");
			if (old) validateAuthorityRecordProgress(old.row.record, next.row.record);
			continue;
		}
		if (change.key.startsWith("local-claim:")) {
			if (change.deleted) {
				const requested =
					frame.command.kind === "finalize-local"
						? frame.command.claim
						: frame.command.kind === "reconcile-local"
							? frame.command.input.claim
							: undefined;
				if (!previous || !requested || canonicalDurableSha256(previous) !== canonicalDurableSha256(requested))
					throw new Error("Authority local claim deletion does not match its prior state.");
				if (
					frame.command.kind === "finalize-local" &&
					(frame.command.outcome !== "committed" || (previous as LocalClaim).phase !== "effect")
				)
					throw new Error("Committed local claim finalization is invalid.");
				continue;
			}
			const next = change.value as LocalClaim;
			const old = previous as LocalClaim | undefined;
			if (!old) {
				if (frame.command.kind !== "reserve-local" || next.phase !== "reserved")
					throw new Error("Initial local claim state is invalid.");
			} else {
				const sameIdentity =
					old.localId === next.localId &&
					old.entryId === next.entryId &&
					old.version === next.version &&
					old.entryHash === next.entryHash &&
					old.headHash === next.headHash &&
					old.previousHeadHash === next.previousHeadHash &&
					old.claimToken === next.claimToken &&
					old.ownerEpoch === next.ownerEpoch &&
					old.incarnation === next.incarnation;
				if (
					!sameIdentity ||
					!(
						(frame.command.kind === "authorize-local-effect" &&
							old.phase === "reserved" &&
							next.phase === "effect") ||
						(frame.command.kind === "finalize-local" &&
							frame.command.outcome === "uncertain" &&
							old.phase === "effect" &&
							next.phase === "uncertain")
					)
				)
					throw new Error("Authority local claim phase transition is invalid.");
			}
			continue;
		}
		// The contextual validator above has already derived the exact pre-frame issuance or consumption delta.
		if (change.key.startsWith("root-recovery:")) {
			const issuance =
				frame.command.kind === "transition" &&
				frame.command.record.kind === "gate" &&
				frame.command.record.phase === "closed";
			const consumption =
				frame.command.kind === "activate-authority" &&
				!frame.command.activation.root &&
				frame.command.activation.actor.actorId === frame.command.activation.actor.rootId &&
				frame.command.activation.actor.parentId === undefined &&
				frame.command.activation.gate?.phase === "open";
			if (issuance || consumption) continue;
			throw new Error("Root recovery control does not match its validated issuance or consumption.");
		}
		throw new Error("Authority frame changes an unrecognized control.");
	}
}

function controlRow<D extends "root" | "actor">(value: unknown, domain: D): AuthorityRow<AuthorityRecordMap[D]> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Authority generation control is invalid.");
	const row = value as AuthorityRow<AuthorityRecordMap[D]>;
	if (!row.record || row.record.kind !== domain || !Number.isSafeInteger(row.version) || row.version < 1)
		throw new Error("Authority generation control is invalid.");
	return row;
}

function actorControl(value: unknown): {
	readonly row: AuthorityRow<AuthorityRecordMap["actor"]>;
	readonly parentGeneration?: number;
} {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Actor generation control is invalid.");
	const evidence = value as { readonly row?: unknown; readonly parentGeneration?: number };
	const row = controlRow(evidence.row, "actor");
	if (
		row.record.parentId === undefined
			? evidence.parentGeneration !== undefined
			: !Number.isSafeInteger(evidence.parentGeneration) || (evidence.parentGeneration as number) < 1
	)
		throw new Error("Actor generation parent evidence is invalid.");
	return { row, ...(evidence.parentGeneration === undefined ? {} : { parentGeneration: evidence.parentGeneration }) };
}
export function validateAuthorityFrame(value: unknown, previousHash?: string): asserts value is AuthorityCommitFrame {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Authority frame must be an object.");
	const frame = value as Record<string, unknown>;
	const expectedKeys = [
		"version",
		"kind",
		"revision",
		"request",
		"command",
		"payloadHash",
		"expected",
		"changes",
		"controls",
		"receipt",
		"previousHash",
		"committedAt",
		"contentHash",
		"hash",
	];
	if (Object.keys(frame).sort().join("\0") !== expectedKeys.sort().join("\0"))
		throw new Error("Authority frame fields are invalid.");
	if (frame.version !== 2 || frame.kind !== "commit") throw new Error("Unsupported authority commit frame.");
	if (!Number.isSafeInteger(frame.revision) || (frame.revision as number) < 1)
		throw new Error("Authority revision is invalid.");
	if (typeof frame.previousHash !== "string" || !/^[a-f0-9]{64}$/.test(frame.previousHash))
		throw new Error("Authority previous hash is invalid.");
	if (previousHash !== undefined && frame.previousHash !== previousHash)
		throw new Error("Authority frame chain mismatch.");
	if (!Number.isFinite(frame.committedAt)) throw new Error("Authority commit timestamp is invalid.");
	if (!frame.request || typeof frame.request !== "object" || Array.isArray(frame.request))
		throw new Error("Authority request identity is invalid.");
	const request = frame.request as Record<string, unknown>;
	if (
		!exactKeys(request, ["requestId", "incarnation", "ownerEpoch", "ownerToken"]) ||
		typeof request.requestId !== "string" ||
		request.requestId.length === 0 ||
		request.requestId.includes("\0") ||
		typeof request.incarnation !== "string" ||
		request.incarnation.length === 0 ||
		request.incarnation.includes("\0") ||
		!Number.isSafeInteger(request.ownerEpoch) ||
		(request.ownerEpoch as number) < 1 ||
		typeof request.ownerToken !== "string" ||
		request.ownerToken.length === 0 ||
		request.ownerToken.includes("\0")
	)
		throw new Error("Authority request identity is invalid.");
	if (!frame.command || typeof frame.command !== "object" || Array.isArray(frame.command))
		throw new Error("Authority command is invalid.");
	const command = frame.command as Record<string, unknown>;
	validateAuthorityCommand(command);
	if (canonicalDurableSha256(command) !== frame.payloadHash)
		throw new Error("Authority command payload hash is invalid.");
	if (!Array.isArray(frame.expected) || !Array.isArray(frame.changes) || !Array.isArray(frame.controls))
		throw new Error("Authority frame deltas must be arrays.");
	const domains: readonly string[] = [
		"root",
		"actor",
		"construction",
		"gate",
		"operation",
		"transition",
		"resource",
		"local-entry",
		"local-head",
	];
	const expectedKeySet = new Set<string>();
	for (const expectation of frame.expected as unknown[]) {
		if (!expectation || typeof expectation !== "object" || Array.isArray(expectation))
			throw new Error("Authority expected row version is invalid.");
		const entry = expectation as Record<string, unknown>;
		if (
			!exactKeys(entry, ["domain", "key", "version"]) ||
			typeof entry.domain !== "string" ||
			!domains.includes(entry.domain) ||
			!Array.isArray(entry.key) ||
			entry.key.length === 0 ||
			entry.key.some(part => typeof part !== "string" && (typeof part !== "number" || !Number.isFinite(part))) ||
			!(entry.version === null || (Number.isSafeInteger(entry.version) && (entry.version as number) > 0))
		)
			throw new Error("Authority expected row version is invalid.");
		const key = authorityKey(entry.domain as AuthorityDomain, entry.key as readonly (string | number)[]);
		if (expectedKeySet.has(key)) throw new Error("Authority frame repeats an expected row key.");
		expectedKeySet.add(key);
	}
	const changedKeySet = new Set<string>();
	for (const change of frame.changes as unknown[]) {
		if (!change || typeof change !== "object" || Array.isArray(change))
			throw new Error("Authority row change is invalid.");
		const row = change as Record<string, unknown>;
		if (!exactKeys(row, ["record", "version"]) || !Number.isSafeInteger(row.version) || (row.version as number) < 1)
			throw new Error("Authority row version is invalid.");
		validateDurableRegistryRecord(row.record);
		const record = row.record as DurableRegistryRecord;
		const key = authorityKey(record.kind, authorityRecordKey(record));
		if (!expectedKeySet.has(key) || changedKeySet.has(key))
			throw new Error("Authority changed row has a missing expectation or duplicate key.");
		changedKeySet.add(key);
	}
	const controlKeys = new Set<string>();
	for (const change of frame.controls as unknown[]) {
		if (!change || typeof change !== "object" || Array.isArray(change))
			throw new Error("Authority control change is invalid.");
		const control = change as Record<string, unknown>;
		if (
			typeof control.key !== "string" ||
			control.key.length === 0 ||
			control.key.includes("\0") ||
			controlKeys.has(control.key)
		)
			throw new Error("Authority control key is invalid or duplicated.");
		controlKeys.add(control.key);
		if (control.deleted !== true && control.deleted !== false)
			throw new Error("Authority control deletion marker is invalid.");
		if (control.deleted === true && !exactKeys(control, ["key", "deleted"]))
			throw new Error("Deleted authority controls cannot contain a value.");
		if (control.deleted === false && !exactKeys(control, ["key", "deleted", "value"]))
			throw new Error("Authority control value is missing or malformed.");
		if (control.deleted === true) validateAuthorityControlValue(control.key as string, true, undefined);
		else {
			canonicalDurableSha256(control.value);
			validateAuthorityControlValue(control.key as string, false, control.value);
		}
	}
	const receipt = frame.receipt as Record<string, unknown> | null;
	if (
		!receipt ||
		typeof receipt !== "object" ||
		Array.isArray(receipt) ||
		!exactKeys(receipt, [
			"requestId",
			"ownerEpoch",
			"revision",
			"payloadHash",
			"incarnation",
			"commandKind",
			"committedAt",
			"result",
		])
	)
		throw new Error("Authority receipt is invalid.");
	if (
		receipt.requestId !== request.requestId ||
		receipt.ownerEpoch !== request.ownerEpoch ||
		receipt.incarnation !== request.incarnation ||
		receipt.payloadHash !== frame.payloadHash ||
		receipt.revision !== frame.revision ||
		receipt.commandKind !== command.kind ||
		receipt.committedAt !== frame.committedAt ||
		!Number.isFinite(receipt.committedAt)
	)
		throw new Error("Authority receipt does not match its commit frame.");
	if (!receipt.result || typeof receipt.result !== "object" || Array.isArray(receipt.result))
		throw new Error("Authority receipt result is invalid.");
	const receiptResult = receipt.result as Record<string, unknown>;
	if (receiptResult.kind === "mutation") {
		if (!exactKeys(receiptResult, ["kind"])) throw new Error("Authority mutation receipt result is invalid.");
	} else if (receiptResult.kind === "local-claim") {
		if (!exactKeys(receiptResult, ["kind", "claim"]))
			throw new Error("Authority local claim receipt result is invalid.");
		validateLocalClaim(receiptResult.claim);
	} else if (receiptResult.kind === "local-publication") {
		if (
			!exactKeys(receiptResult, ["kind", "publication"]) ||
			!receiptResult.publication ||
			typeof receiptResult.publication !== "object" ||
			Array.isArray(receiptResult.publication)
		)
			throw new Error("Authority local publication receipt result is invalid.");
		const publication = receiptResult.publication as Record<string, unknown>;
		if (
			!exactKeys(publication, ["version", "headHash"]) ||
			!Number.isSafeInteger(publication.version) ||
			(publication.version as number) < 1 ||
			typeof publication.headHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(publication.headHash)
		)
			throw new Error("Authority local publication receipt result is invalid.");
	} else throw new Error("Unknown authority receipt result kind.");
	const controlChanges = frame.controls as AuthorityControlChange[];
	const receiptControl = controlChanges.find(
		change =>
			change.key === `receipt:${JSON.stringify([request.incarnation, request.ownerEpoch, request.requestId])}`,
	);
	if (
		!receiptControl ||
		receiptControl.deleted ||
		canonicalDurableSha256(receiptControl.value) !== canonicalDurableSha256(receipt)
	)
		throw new Error("Authority receipt control does not match its commit frame.");
	const metaControl = controlChanges.find(change => change.key === "meta");
	if (
		!metaControl ||
		metaControl.deleted ||
		!metaControl.value ||
		typeof metaControl.value !== "object" ||
		Array.isArray(metaControl.value)
	)
		throw new Error("Authority commit frame is missing its metadata update.");
	const meta = metaControl.value as Record<string, unknown>;
	if (
		!exactKeys(meta, ["revision", "generationHighWater", "status"], ["quarantineReason"]) ||
		meta.revision !== frame.revision ||
		!Number.isSafeInteger(meta.generationHighWater) ||
		(meta.generationHighWater as number) < 0 ||
		(meta.status !== "ready" && meta.status !== "quarantined") ||
		(meta.status === "quarantined"
			? typeof meta.quarantineReason !== "string" || meta.quarantineReason.length === 0
			: meta.quarantineReason !== undefined)
	)
		throw new Error("Authority metadata update is invalid.");
	const { contentHash, hash, ...content } = frame;
	if (
		typeof contentHash !== "string" ||
		contentHash !== authorityFrameContentHash(content as Omit<AuthorityCommitFrame, "contentHash" | "hash">)
	)
		throw new Error("Authority frame content hash mismatch.");
	if (
		typeof hash !== "string" ||
		hash !==
			authorityFrameHash({
				version: 2,
				revision: frame.revision as number,
				previousHash: frame.previousHash,
				contentHash,
			})
	)
		throw new Error("Authority frame hash mismatch.");
	validateFrameCommandDeltas(frame as unknown as AuthorityCommitFrame);
}

export function authorityRecordIsOpen(record: DurableRegistryRecord): boolean {
	switch (record.kind) {
		case "root":
			return record.state === "active";
		case "actor":
			return record.state === "active" || record.state === "parked";
		case "construction":
			return !TERMINAL_CONSTRUCTION_PHASES.has(record.phase);
		case "gate":
			return record.phase === "open" || record.phase === "quiescing" || record.phase === "quiesced";
		case "operation":
			return !TERMINAL_OPERATION_PHASES.has(record.phase);
		case "transition":
			return !TERMINAL_TRANSITION_PHASES.has(record.phase);
		case "resource":
			return !TERMINAL_RESOURCE_PHASES.has(record.phase);
		case "local-entry":
			return record.phase === "intent" || record.phase === "effect";
		case "local-head":
			return record.phase === "current";
	}
}

function recordDomain(record: DurableRegistryRecord): AuthorityDomain {
	return record.kind;
}

export function authorityRecordKey(record: DurableRegistryRecord): AuthorityKey {
	switch (record.kind) {
		case "root":
			return [record.rootId];
		case "actor":
			return [record.actorId];
		case "construction":
			return [record.rootId, record.actorId, record.generation];
		case "gate":
			return [record.rootId];
		case "operation":
			return [record.ownerId, record.effectClass, record.operationId];
		case "transition":
			return [record.rootId, record.transitionId];
		case "resource":
			return [record.actorId, record.generation, record.resourceId];
		case "local-entry":
			return [record.localId, record.entryId, record.version];
		case "local-head":
			return [record.localId];
	}
}

function assertLegacySnapshotMatches(actualValue: unknown, expected: DurableLegacyAuthorityImport["snapshot"]): void {
	if (!actualValue || typeof actualValue !== "object" || Array.isArray(actualValue))
		throw new Error("Legacy snapshot does not match replayed journal evidence.");
	const actual = actualValue as Record<string, unknown>;
	if (
		!exactKeys(actual, [
			"available",
			"head",
			"roots",
			"actors",
			"constructions",
			"gates",
			"operations",
			"transitions",
			"resources",
			"localHeads",
			"localEntries",
		]) ||
		actual.available !== true ||
		canonicalDurableSha256(actual.head) !== canonicalDurableSha256(expected.head)
	)
		throw new Error("Legacy snapshot does not match replayed journal evidence.");
	const matches = (mapValue: unknown, expectedMap: ReadonlyMap<string, unknown>): boolean => {
		if (!(mapValue instanceof Map) || mapValue.size !== expectedMap.size) return false;
		for (const [key, expectedRecord] of expectedMap) {
			if (!mapValue.has(key) || canonicalDurableSha256(mapValue.get(key)) !== canonicalDurableSha256(expectedRecord))
				return false;
		}
		return true;
	};
	for (const key of [
		"roots",
		"actors",
		"constructions",
		"gates",
		"operations",
		"transitions",
		"resources",
		"localHeads",
		"localEntries",
	] as const) {
		if (!matches(actual[key], expected[key]))
			throw new Error("Legacy snapshot does not match replayed journal evidence.");
	}
}

function authorityExportFromValidatedLegacy(
	identity: AuthorityIdentity,
	legacy: DurableLegacyAuthorityImport,
): AuthorityExport {
	const versions = new Map<string, number>();
	const rootsByGeneration = new Map<string, AuthorityRow<DurableRootRecord>>();
	const actorsByGeneration = new Map<
		string,
		{ readonly row: AuthorityRow<DurableActorRecord>; readonly parentGeneration?: number }
	>();
	const currentActors = new Map<string, DurableActorRecord>();
	const entries = legacy.entries;
	let generationHighWater = 0;
	for (const entry of entries) {
		const record = entry.record;
		const recordId = authorityKey(record.kind, authorityRecordKey(record));
		versions.set(recordId, (versions.get(recordId) ?? 0) + 1);
		generationHighWater = highWaterFor(record, generationHighWater);
		if (record.kind === "root") {
			const key = controlKey("root-generation", record.rootId, record.generation);
			const previous = rootsByGeneration.get(key);
			rootsByGeneration.set(key, Object.freeze({ record, version: (previous?.version ?? 0) + 1 }));
		}
		if (record.kind === "actor") {
			const key = controlKey("actor-generation", record.actorId, record.generation);
			const previous = actorsByGeneration.get(key);
			let parentGeneration = previous?.parentGeneration;
			if (!previous && record.parentId !== undefined) {
				const parent = currentActors.get(record.parentId);
				if (!parent) throw new Error("Legacy actor first-parent generation is missing during export.");
				parentGeneration = parent.generation;
			}
			actorsByGeneration.set(
				key,
				Object.freeze({
					row: Object.freeze({ record, version: (previous?.row.version ?? 0) + 1 }),
					...(parentGeneration === undefined ? {} : { parentGeneration }),
				}),
			);
			currentActors.set(record.actorId, record);
		}
	}
	const snapshot = legacy.snapshot;
	const snapshotRecords: DurableRegistryRecord[] = [
		...snapshot.roots.values(),
		...snapshot.actors.values(),
		...snapshot.constructions.values(),
		...snapshot.gates.values(),
		...snapshot.operations.values(),
		...snapshot.transitions.values(),
		...snapshot.resources.values(),
		...snapshot.localEntries.values(),
		...snapshot.localHeads.values(),
	];
	const rows: AuthorityRow[] = snapshotRecords.map(record => {
		const version = versions.get(authorityKey(record.kind, authorityRecordKey(record)));
		if (version === undefined) throw new Error("Legacy snapshot row is absent from its original journal evidence.");
		return Object.freeze({ record: Object.freeze({ ...record }), version });
	});
	rows.sort((left, right) =>
		compareAuthorityKeys(
			authorityKey(left.record.kind, authorityRecordKey(left.record)),
			authorityKey(right.record.kind, authorityRecordKey(right.record)),
		),
	);
	const controls = new Map<string, unknown>();
	controls.set("meta", Object.freeze({ revision: 0, generationHighWater, status: "ready", headHash: GENESIS_HASH }));
	for (const [key, row] of rootsByGeneration) controls.set(key, row);
	for (const [key, evidence] of actorsByGeneration) controls.set(key, evidence);
	const exportedControls: AuthorityControl[] = [...controls.entries()]
		.sort(([left], [right]) => compareAuthorityKeys(left, right))
		.map(([key, value]) => Object.freeze({ key, value }));
	return Object.freeze({
		version: 2,
		sourceIdentity: Object.freeze({ ...identity }),
		revision: 0,
		generationHighWater,
		headHash: GENESIS_HASH,
		rows: Object.freeze(rows),
		controls: Object.freeze(exportedControls),
		frames: Object.freeze([]),
		legacy: Object.freeze({ sourceSha256: legacy.sourceSha256, entries }),
	});
}

export function authorityExportFromLegacy(
	identity: AuthorityIdentity,
	legacy: DurableLegacyAuthorityImport,
): AuthorityExport {
	const verified = validateLegacyAuthorityEntries(legacy.sourceSha256, legacy.entries);
	assertLegacySnapshotMatches(legacy.snapshot, verified.snapshot);
	return authorityExportFromValidatedLegacy(identity, verified);
}

export function authorityExportFromLegacySource(
	identity: AuthorityIdentity,
	legacy: AuthorityLegacySource,
): AuthorityExport {
	return authorityExportFromValidatedLegacy(
		identity,
		validateLegacyAuthorityEntries(legacy.sourceSha256, legacy.entries),
	);
}

function controlKey(kind: "root-generation" | "actor-generation", first: string, generation: number): string {
	return `${kind}:${JSON.stringify([first, generation])}`;
}

function localClaimKey(localId: string): string {
	return `local-claim:${JSON.stringify(localId)}`;
}

function receiptKey(request: AuthorityRequestIdentity): string {
	return `receipt:${JSON.stringify([request.incarnation, request.ownerEpoch, request.requestId])}`;
}

function currentMeta(driver: AuthorityPersistence) {
	const meta = driver.getControl("meta");
	if (!meta || typeof meta !== "object" || Array.isArray(meta))
		throw new DurableStateUnavailableError("Authority metadata is missing.");
	return meta as {
		revision: number;
		headHash: string;
		generationHighWater: number;
		status: "ready" | "quarantined";
		quarantineReason?: string;
	};
}

function currentOwner(driver: AuthorityPersistence): AuthorityOwner | undefined {
	const owner = driver.getControl("owner");
	return owner && typeof owner === "object" && !Array.isArray(owner) ? (owner as AuthorityOwner) : undefined;
}

function assertSafePageLimit(limit: number | undefined): number {
	const selected = limit ?? DEFAULT_PAGE_SIZE;
	if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_PAGE_SIZE)
		throw new RangeError(`Authority page limit must be between 1 and ${MAX_PAGE_SIZE}.`);
	return selected;
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
	)
		throw new Error("Operation identity changed across durable phases.");
	if (TERMINAL_OPERATION_PHASES.has(previous.phase))
		throw new Error("Operation changed after reaching terminal state.");
	if (next.phase === "effect" && previous.phase === "intent") return;
	if (next.phase === "committed" && previous.phase === "effect") return;
	if (
		(next.phase === "completed" || next.phase === "failed") &&
		(previous.phase === "effect" || previous.phase === "committed")
	)
		return;
	if (next.phase === "abandoned" || next.phase === "cancelled") return;
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
	)
		throw new Error("Resource identity changed across durable phases.");
	if (TERMINAL_RESOURCE_PHASES.has(previous.phase)) throw new Error("Resource changed after reaching terminal state.");
	if (next.phase === "effect" && previous.phase === "intent") return;
	if (next.phase === "committed" && previous.phase === "effect") return;
	if (next.phase === "completed" && (previous.phase === "effect" || previous.phase === "committed")) return;
	if (next.phase === "cancelled" || next.phase === "abandoned") return;
	throw new Error("Resource has an invalid durable phase transition.");
}

function assertProgress(
	previous: string | undefined,
	next: string,
	order: readonly string[],
	terminal: readonly string[],
	label: string,
): void {
	if (!previous) {
		if (next !== order[0]) throw new Error(`${label} does not begin with ${order[0]}.`);
		return;
	}
	if (terminal.includes(previous)) throw new Error(`${label} changed after reaching terminal state.`);
	if (terminal.includes(next)) return;
	const previousIndex = order.indexOf(previous);
	if (previousIndex < 0 || order.indexOf(next) !== previousIndex + 1)
		throw new Error(`${label} has an invalid phase transition.`);
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

function validateGenericRecordAdmission(
	previous: DurableRegistryRecord | undefined,
	record: DurableRegistryRecord,
): void {
	if (record.kind === "root" && (!previous || previous.kind !== "root" || previous.generation !== record.generation))
		throw new Error("Root creation and generation activation require activateAuthority or commitRootTransition.");
	if (record.kind === "actor" && (!previous || previous.kind !== "actor" || previous.generation !== record.generation))
		throw new Error("Actor admission requires activateAuthority.");
	if (record.kind === "construction" && record.phase === "activated")
		throw new Error("Construction activation requires activateAuthority.");
	if (record.kind === "gate" && record.phase === "open")
		throw new Error("Opening a gate requires an authority activation command.");
	if (record.kind === "transition" && record.phase === "cas-committed")
		throw new Error("Root transition CAS requires commitRootTransition.");
	if (record.kind === "transition" && record.phase === "recovered")
		throw new Error("Root transition recovery requires the constrained commitRootTransition command.");
	if (record.kind === "local-entry" || record.kind === "local-head")
		throw new Error("Local publication records require named local commands.");
}

function validateRecordProgress(
	previous: DurableRegistryRecord | undefined,
	next: DurableRegistryRecord,
	allowConstrainedRecovery = false,
): void {
	validateDurableRegistryRecord(next);
	if (previous && previous.kind !== next.kind) throw new Error("Authority row domain changed across versions.");
	switch (next.kind) {
		case "root": {
			if (!previous) return;
			if (previous.kind !== "root") throw new Error("Root domain mismatch.");
			if (next.generation < previous.generation) throw new Error("Root generation regressed.");
			if (next.generation === previous.generation && next.headHash !== previous.headHash)
				throw new Error("Root generation has multiple head hashes.");
			if (
				next.generation === previous.generation &&
				(previous.state === "retired" || previous.state === "invalidated")
			)
				throw new Error("Terminal root generation cannot be reused.");
			return;
		}
		case "actor": {
			if (!previous) return;
			if (previous.kind !== "actor") throw new Error("Actor domain mismatch.");
			if (next.generation < previous.generation) throw new Error("Actor generation regressed.");
			if (next.generation === previous.generation && !sameActorGenerationIdentity(previous, next))
				throw new Error("Actor immutable identity changed.");
			if (previous.generation === next.generation) {
				if (previous.state === "retired" || previous.state === "aborted")
					throw new Error("Actor changed after reaching terminal state.");
				const legal =
					previous.state === "active"
						? next.state === "active" ||
							next.state === "parked" ||
							next.state === "retired" ||
							next.state === "aborted"
						: next.state === "parked" ||
							next.state === "active" ||
							next.state === "retired" ||
							next.state === "aborted";
				if (!legal) throw new Error("Actor has an invalid state transition.");
			}
			return;
		}
		case "construction": {
			if (!previous) {
				if (next.phase !== "reserved") throw new Error("Construction does not begin with reserved phase.");
				return;
			}
			if (previous.kind !== "construction") throw new Error("Construction domain mismatch.");
			if (
				previous.startupHash !== next.startupHash ||
				previous.provenanceHash !== next.provenanceHash ||
				previous.parentId !== next.parentId ||
				previous.scopeHash !== next.scopeHash ||
				previous.parentScopeHash !== next.parentScopeHash
			)
				throw new Error("Construction identity changed.");
			assertProgress(previous.phase, next.phase, CONSTRUCTION_ORDER, ["activated", "abandoned"], "Construction");
			return;
		}
		case "gate": {
			if (!previous) return;
			if (previous.kind !== "gate") throw new Error("Gate domain mismatch.");
			if (next.generation < previous.generation) throw new Error("Gate generation regressed.");
			if (
				next.generation === previous.generation &&
				previous.phase === "quiesced" &&
				next.phase === "open" &&
				!allowConstrainedRecovery
			)
				throw new Error(
					"Quiesced gate requires a new root generation or constrained root recovery before reopening.",
				);
			return;
		}
		case "operation":
			operationProgress(previous?.kind === "operation" ? previous : undefined, next);
			return;
		case "transition": {
			if (!previous) {
				if (next.phase !== "staged") throw new Error("Root transition does not begin with staged phase.");
				return;
			}
			if (previous.kind !== "transition") throw new Error("Transition domain mismatch.");
			if (
				previous.sourceGeneration !== next.sourceGeneration ||
				previous.destinationGeneration !== next.destinationGeneration ||
				previous.sourceHeadHash !== next.sourceHeadHash ||
				previous.destinationHeadHash !== next.destinationHeadHash
			)
				throw new Error("Root transition identity changed.");
			if (next.phase === "recovered") {
				if (!allowConstrainedRecovery || !["staged", "quiescing", "quiesced", "validated"].includes(previous.phase))
					throw new Error("Root transition recovery requires the constrained pre-CAS command.");
				return;
			}
			if (next.phase === "retired") {
				if (previous.phase !== "activated") throw new Error("Root transition must be activated before retirement.");
				return;
			}
			if (TERMINAL_TRANSITION_PHASES.has(previous.phase))
				throw new Error("Root transition changed after reaching a terminal phase.");
			assertProgress(previous.phase, next.phase, TRANSITION_ORDER, [], "Root transition");
			return;
		}
		case "resource":
			resourceProgress(previous?.kind === "resource" ? previous : undefined, next);
			return;
		case "local-entry": {
			if (!previous) {
				if (next.phase !== "intent") throw new Error("Local entry does not begin with durable intent.");
				return;
			}
			if (previous.kind !== "local-entry") throw new Error("Local entry domain mismatch.");
			if (
				previous.expectedHeadHash !== next.expectedHeadHash ||
				previous.entryHash !== next.entryHash ||
				previous.headHash !== next.headHash
			)
				throw new Error("Local entry identity changed.");
			assertProgress(
				previous.phase,
				next.phase,
				["intent", "effect", "committed"],
				["committed", "conflict", "cancelled"],
				"Local entry",
			);
			return;
		}
		case "local-head": {
			if (!previous) {
				if (next.version !== 1 || next.previousHeadHash !== GENESIS_HASH)
					throw new Error("Local journal does not begin at the genesis head.");
				return;
			}
			if (previous.kind !== "local-head") throw new Error("Local head domain mismatch.");
			if (next.version !== previous.version + 1 || next.previousHeadHash !== previous.headHash)
				throw new Error("Local journal head compare-and-swap mismatch.");
			return;
		}
	}
}

export function validateAuthorityRecordProgress(
	previous: DurableRegistryRecord | undefined,
	next: DurableRegistryRecord,
	allowConstrainedRecovery = false,
): void {
	validateRecordProgress(previous, next, allowConstrainedRecovery);
}

function highWaterFor(record: DurableRegistryRecord, current: number): number {
	if (record.kind === "transition") return Math.max(current, record.sourceGeneration, record.destinationGeneration);
	if (record.kind === "operation") return Math.max(current, record.generation ?? 0);
	if (record.kind === "local-entry" || record.kind === "local-head") return current;
	return Math.max(current, record.generation);
}

function immutableRootKey(rootId: string, generation: number): string {
	return controlKey("root-generation", rootId, generation);
}
function immutableActorKey(actorId: string, generation: number): string {
	return controlKey("actor-generation", actorId, generation);
}

function asRow<T extends DurableRegistryRecord>(value: unknown): AuthorityRow<T> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as AuthorityRow<T>;
	return row.record && Number.isSafeInteger(row.version) ? row : undefined;
}

function assertSameClaim(actual: unknown, expected: LocalClaim): asserts actual is LocalClaim {
	if (!actual || typeof actual !== "object" || Array.isArray(actual))
		throw new DurableStateConflictError("Local publication claim is missing.");
	const claim = actual as LocalClaim;
	if (
		claim.localId !== expected.localId ||
		claim.entryId !== expected.entryId ||
		claim.version !== expected.version ||
		claim.entryHash !== expected.entryHash ||
		claim.headHash !== expected.headHash ||
		claim.previousHeadHash !== expected.previousHeadHash ||
		claim.claimToken !== expected.claimToken ||
		claim.ownerEpoch !== expected.ownerEpoch ||
		claim.incarnation !== expected.incarnation ||
		claim.phase !== expected.phase
	)
		throw new DurableStateConflictError("Local publication claim identity is stale.");
}

export class AuthorityEngine implements AuthorityEngineApi {
	readonly identity: AuthorityIdentity;
	readonly #driver: AuthorityPersistence;
	readonly #ownerToken: string;
	#owner: AuthorityOwner;
	#physicallyClosed = false;

	constructor(driver: AuthorityPersistence, ownerToken: string) {
		if (!ownerToken || ownerToken.includes("\0"))
			throw new TypeError("Authority owner token must be a non-empty opaque string.");
		this.#driver = driver;
		this.identity = driver.identity;
		this.#ownerToken = ownerToken;
		const previous = currentOwner(driver);
		this.#owner = Object.freeze({
			incarnation: this.identity.incarnation,
			epoch: (previous?.epoch ?? 0) + 1,
			token: ownerToken,
			phase: "recovering",
		});
		this.#execute(
			{ kind: "owner", owner: this.#owner },
			{ requestId: crypto.randomUUID() },
			{ allowRecovering: true, bypassReceipt: true },
		);
	}

	/** Whether the driver implements AuthorityGroupCommit; without it every command is its own durable sync. */
	get groupCommitSupported(): boolean {
		return this.#driver.groupCommit !== undefined;
	}

	/**
	 * Opens a group: later mutations stage as members until syncGroup(). The engine keeps no per-command
	 * state outside the driver except its owner, which only recover() and close() change; the worker never
	 * runs those (or any read) inside a group, so every member sees exactly the state a serial run would.
	 */
	beginGroup(): void {
		const group = this.#driver.groupCommit;
		if (!group) throw new Error("Authority persistence driver does not implement group commit.");
		if (this.#physicallyClosed) throw new DurableStateUnavailableError("Authority engine is closed.");
		group.begin();
	}

	/** One durable sync for every member since beginGroup(); nothing staged may be acknowledged before it returns. */
	syncGroup(): void {
		const group = this.#driver.groupCommit;
		if (!group) throw new Error("Authority persistence driver does not implement group commit.");
		group.sync();
	}

	transition(record: DurableRegistryRecord, options?: MutationOptions): MutationReceipt {
		return this.#execute({ kind: "transition", record }, options);
	}

	transitionBatch(records: readonly DurableRegistryRecord[], options?: MutationOptions): MutationReceipt {
		if (records.length === 0 || records.length > 100)
			throw new RangeError("Authority transition batch must contain 1 to 100 records.");
		validateBatchEffectPhases(records);
		return this.#execute({ kind: "transition-batch", records }, options);
	}

	activateAuthority(input: AuthorityActivation, options?: MutationOptions): MutationReceipt {
		return this.#execute({ kind: "activate-authority", activation: input }, options);
	}

	commitRootTransition(input: RootTransitionCommit, options?: MutationOptions): MutationReceipt {
		return this.#execute({ kind: "commit-root-transition", transition: input }, options);
	}

	getRoot(rootId: string) {
		return this.#driver.get("root", [rootId]);
	}
	getActor(actorId: string) {
		return this.#driver.get("actor", [actorId]);
	}
	getActorGeneration(actorId: string, generation: number) {
		const evidence = this.#driver.getControl(immutableActorKey(actorId, generation));
		return asRow<DurableActorRecord>(
			evidence && typeof evidence === "object" && "row" in evidence ? (evidence as { row: unknown }).row : undefined,
		);
	}
	getConstruction(rootId: string, actorId: string, generation: number) {
		return this.#driver.get("construction", [rootId, actorId, generation]);
	}
	getGate(rootId: string) {
		return this.#driver.get("gate", [rootId]);
	}
	getOperation(ownerId: string, effectClass: DurableOperationRecord["effectClass"], operationId: string) {
		return this.#driver.get("operation", [ownerId, effectClass, operationId]);
	}
	getTransition(rootId: string, transitionId: string) {
		return this.#driver.get("transition", [rootId, transitionId]);
	}
	getResource(actorId: string, generation: number, resourceId: string) {
		return this.#driver.get("resource", [actorId, generation, resourceId]);
	}
	getLocalEntry(localId: string, entryId: string, version: number) {
		return this.#driver.get("local-entry", [localId, entryId, version]);
	}
	getLocalHead(localId: string) {
		return this.#driver.get("local-head", [localId]);
	}

	listOpen(domain: AuthorityDomain, after?: string, limit?: number): AuthorityPage {
		return this.#driver.scan(domain, { openOnly: true, after, limit: assertSafePageLimit(limit) });
	}

	/**
	 * Every actor of one root generation, in any state (terminal ones included), paged in key order. The
	 * generation is required: a root-wide listing would walk every past incarnation's actors and needs a sort
	 * on SQLite, while one generation is index-ordered and bounded by its own tree. Use listOpen("actor") for
	 * the open working set.
	 */
	listActors(
		rootId: string,
		rootGeneration: number,
		after?: string,
		limit?: number,
	): AuthorityPage<DurableActorRecord> {
		if (!Number.isSafeInteger(rootGeneration) || rootGeneration < 1)
			throw new RangeError("Authority listActors requires a positive root generation.");
		return this.#driver.scan("actor", { rootId, rootGeneration, after, limit: assertSafePageLimit(limit) });
	}

	recover(): AuthorityRecoveryState {
		this.#assertNoOpenGroup("recover");
		if (this.#owner.phase === "ready") return this.recoveryState();
		this.#assertOwnerPhase("recovering");
		const blocked = this.#unresolvedReasons();
		const roots = this.#collectOpen("root").filter(row => row.record.state === "active");
		for (const root of roots) {
			const gate = this.#driver.get("gate", [root.record.rootId]);
			if (!gate || gate.record.generation !== root.record.generation) continue;
			const recoveryKey = rootRecoveryKey(root.record.rootId);
			const existing = this.#driver.getControl(recoveryKey);
			const currentEvidence =
				gate.record.phase === "closed"
					? rootRecoveryEvidenceFor(
							root.record.rootId,
							this.#owner,
							gate.version,
							(domain, key) => this.#driver.get(domain, key),
							key => this.#driver.getControl(key),
						)
					: undefined;
			if (
				currentEvidence &&
				existing &&
				canonicalDurableSha256(currentEvidence) === canonicalDurableSha256(existing)
			)
				continue;
			if (existing !== undefined) {
				validateRootRecoveryEvidence(recoveryKey, existing);
				if (
					existing.incarnation === this.#owner.incarnation &&
					existing.ownerEpoch === this.#owner.epoch &&
					existing.ownerToken === this.#owner.token
				)
					continue;
			}
			const closed = { ...gate.record, at: Date.now(), phase: "closed" as const };
			this.#execute(
				{ kind: "transition", record: closed },
				{ requestId: crypto.randomUUID() },
				{ allowRecovering: true },
			);
		}
		if (blocked.length === 0) {
			this.#owner = Object.freeze({ ...this.#owner, phase: "ready" });
			this.#execute(
				{ kind: "owner", owner: this.#owner },
				{ requestId: crypto.randomUUID() },
				{ allowRecovering: true },
			);
		}
		return this.recoveryState(blocked);
	}

	recoveryState(blockedOverride?: readonly string[]): AuthorityRecoveryState {
		const meta = currentMeta(this.#driver);
		const owner = currentOwner(this.#driver);
		if (!owner) throw new DurableStateUnavailableError("Authority owner state is missing.");
		const roots = new Map<string, DurableRootRecord>();
		for (const row of this.#collectOpen("root"))
			if (row.record.state === "active") roots.set(row.record.rootId, row.record);
		const actors = new Map<string, DurableActorRecord>();
		for (const row of this.#collectOpen("actor"))
			if (row.record.state === "active" || row.record.state === "parked") actors.set(row.record.actorId, row.record);
		return Object.freeze({
			revision: meta.revision,
			generationHighWater: meta.generationHighWater,
			owner,
			roots,
			actors,
			blocked: blockedOverride ? Object.freeze([...blockedOverride]) : Object.freeze(this.#unresolvedReasons()),
		});
	}

	validateRevival(input: {
		readonly actorId: string;
		readonly parentId?: string;
		readonly rootId: string;
		readonly generation: number;
		readonly scopeHash?: string;
	}): boolean {
		const actor = this.#driver.get("actor", [input.actorId])?.record;
		if (
			!actor ||
			actor.rootId !== input.rootId ||
			actor.generation !== input.generation ||
			actor.parentId !== input.parentId ||
			(input.scopeHash !== undefined && actor.scopeHash !== input.scopeHash)
		)
			return false;
		return isCurrentActorRevival(
			actor,
			(domain, key) => this.#driver.get(domain, key),
			key => this.#driver.getControl(key),
		);
	}

	reserveLocal(input: LocalReservation, options?: MutationOptions): LocalClaim {
		const receipt = this.#execute({ kind: "reserve-local", input }, options);
		if (receipt.result.kind !== "local-claim") throw new Error("Local reservation receipt has an invalid result.");
		return receipt.result.claim;
	}

	authorizeLocalEffect(claim: LocalClaim, options?: MutationOptions): MutationReceipt {
		return this.#execute({ kind: "authorize-local-effect", claim }, options);
	}

	finalizeLocal(
		claim: LocalClaim,
		outcome: "committed" | "uncertain",
		options?: MutationOptions,
	): DurableLocalPublishResult {
		const receipt = this.#execute({ kind: "finalize-local", claim, outcome }, options);
		if (receipt.result.kind !== "local-publication")
			throw new Error("Local finalization receipt has an invalid result.");
		return receipt.result.publication;
	}

	reconcileLocal(input: LocalReconciliation, options?: MutationOptions): MutationReceipt {
		return this.#execute({ kind: "reconcile-local", input }, options, { allowRecovering: true });
	}

	localBacking(localId: string): DurableLocalBackingExpectation | null {
		const head = this.#driver.get("local-head", [localId]);
		if (!head || head.record.phase !== "current") return null;
		const entries = this.#driver.scan("local-entry", {
			localMatch: { localId, version: head.record.version, headHash: head.record.headHash },
			limit: 2,
		});
		if (entries.rows.length !== 1)
			throw new DurableStateUnavailableError("Current local head does not have exactly one committed entry.");
		const entry = entries.rows[0]?.record;
		if (!entry || entry.kind !== "local-entry" || entry.phase !== "committed")
			throw new DurableStateUnavailableError("Current local head entry is not committed.");
		return Object.freeze({
			version: head.record.version,
			headHash: head.record.headHash,
			entryId: entry.entryId,
			entryHash: entry.entryHash,
		});
	}

	resolveReceipt(
		requestId: string,
		epoch?: number,
		incarnation = this.identity.incarnation,
		payloadHash?: string,
	): MutationReceipt | undefined {
		if (epoch !== undefined)
			return this.#findReceipt(
				receiptKey({ requestId, ownerEpoch: epoch, incarnation, ownerToken: "" }),
				payloadHash,
			);
		return this.#driver.findReceipt(requestId, incarnation, payloadHash);
	}

	quarantine(reason: string): never {
		this.#assertNoOpenGroup("quarantine");
		const message = reason.trim();
		if (!message) throw new TypeError("Quarantine reason must be non-empty.");
		this.#execute(
			{ kind: "quarantine", reason: message },
			{ requestId: crypto.randomUUID() },
			{ allowRecovering: true, allowQuiescing: true },
		);
		throw new DurableStateUnavailableError(message);
	}

	exportState(): AuthorityExport {
		return this.#driver.exportState();
	}

	close(): void {
		if (this.#physicallyClosed) return;
		this.#assertNoOpenGroup("close");
		// Quarantine refuses every later frame, an owner-close included, so a quarantined store only
		// closes physically; its last frame stays the quarantine record and reopening still refuses it.
		if (this.#owner.phase !== "closed") {
			const quarantined = currentMeta(this.#driver).status === "quarantined";
			this.#owner = Object.freeze({ ...this.#owner, phase: "closed" });
			if (!quarantined)
				this.#execute(
					{ kind: "owner", owner: this.#owner },
					{ requestId: crypto.randomUUID() },
					{ allowRecovering: true, allowQuiescing: true, allowClosed: true },
				);
		}
		this.#driver.close();
		this.#physicallyClosed = true;
	}

	#execute(
		command: AuthorityCommand,
		options: MutationOptions = {},
		permissions: {
			allowRecovering?: boolean;
			allowQuiescing?: boolean;
			allowClosed?: boolean;
			bypassReceipt?: boolean;
		} = {},
	): MutationReceipt {
		return this.#driver.transaction(() => {
			const meta = currentMeta(this.#driver);
			const persistedOwner = currentOwner(this.#driver);
			if (command.kind === "owner") {
				const nextOwner = command.owner;
				const startsOwner =
					persistedOwner === undefined && nextOwner.epoch === 1 && nextOwner.phase === "recovering";
				const advancesOwner =
					persistedOwner !== undefined &&
					nextOwner.epoch === persistedOwner.epoch + 1 &&
					nextOwner.incarnation === this.identity.incarnation &&
					nextOwner.phase === "recovering";
				const updatesOwner =
					persistedOwner !== undefined &&
					nextOwner.epoch === persistedOwner.epoch &&
					nextOwner.token === persistedOwner.token &&
					nextOwner.incarnation === persistedOwner.incarnation;
				if (!startsOwner && !advancesOwner && !updatesOwner)
					throw new DurableStateConflictError("Authority owner epoch changed.");
			} else if (
				!persistedOwner ||
				persistedOwner.epoch !== this.#owner.epoch ||
				persistedOwner.token !== this.#owner.token ||
				persistedOwner.incarnation !== this.#owner.incarnation ||
				persistedOwner.phase !== this.#owner.phase
			) {
				throw new DurableStateConflictError("Authority command belongs to a stale owner.");
			}
			if (meta.status === "quarantined" && command.kind !== "quarantine")
				throw new DurableStateUnavailableError(meta.quarantineReason ?? "Authority is quarantined.");
			this.#assertOwnerPermission(command, permissions);
			const owner = this.#owner;
			const request: AuthorityRequestIdentity = Object.freeze({
				requestId: options.requestId ?? crypto.randomUUID(),
				incarnation: this.identity.incarnation,
				ownerEpoch: owner.epoch,
				ownerToken: owner.token,
			});
			const payloadHash = canonicalDurableSha256(command);
			const existing = this.#findReceipt(receiptKey(request));
			if (existing && (existing.payloadHash !== payloadHash || existing.commandKind !== command.kind))
				throw new DurableStateConflictError("Request identity was reused for a different authority command.");
			if (existing && !permissions.bypassReceipt) return existing;
			// After the receipt replay (an acknowledged request stays idempotent) and before any staging,
			// so a refusal leaves state, receipts and revision untouched and the outcome known.
			if (authorityCommandIsContinuation(command, (domain, key) => this.#driver.get(domain, key))) {
				const requestBytes = authorityRequestBytes(command, options);
				if (requestBytes > AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES)
					throw new AuthorityContinuationTooLargeError(
						command.kind,
						requestBytes,
						AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES,
					);
			}
			if (options.expectedRevision !== undefined && options.expectedRevision !== meta.revision)
				throw new DurableStateConflictError("Authority revision compare-and-swap failed.");
			const expected = new Map<string, AuthorityExpectation>();
			for (const expectation of options.expected ?? []) {
				const key = authorityKey(expectation.domain, expectation.key);
				if (expected.has(key)) throw new TypeError("Authority expectations contain a duplicate key.");
				const row = this.#driver.get(expectation.domain, expectation.key);
				const actual = row?.version ?? null;
				if (actual !== expectation.version)
					throw new DurableStateConflictError("Authority row version compare-and-swap failed.");
				expected.set(key, expectation);
			}
			const changes: AuthorityRow[] = [];
			const controlChanges = new Map<string, AuthorityControlChange>();
			const stagedRows = new Map<string, AuthorityRow>();
			const initialRows = new Map<string, AuthorityRow | undefined>();
			let highWater = meta.generationHighWater;
			let result: MutationReceipt["result"] = { kind: "mutation" };
			const getRow = <D extends AuthorityDomain>(
				domain: D,
				key: readonly (string | number)[],
			): AuthorityRow<AuthorityRecordMap[D]> | undefined => {
				const cursor = authorityKey(domain, key);
				const staged = stagedRows.get(cursor);
				if (staged) return staged as AuthorityRow<AuthorityRecordMap[D]>;
				const existing = this.#driver.get(domain, key);
				if (!initialRows.has(cursor)) initialRows.set(cursor, existing);
				return existing;
			};
			const getControl = (key: string): unknown | undefined => {
				const staged = controlChanges.get(key);
				if (staged) return staged.deleted ? undefined : staged.value;
				return this.#driver.getControl(key);
			};
			const putControl = (key: string, value: unknown): void => {
				controlChanges.set(key, { key, deleted: false, value });
			};
			const deleteControl = (key: string): void => {
				controlChanges.set(key, { key, deleted: true });
			};
			const putRecord = (record: DurableRegistryRecord, enforce = true, allowTransitionRecovery = false): void => {
				const domain = recordDomain(record);
				const key = authorityRecordKey(record);
				const cursor = authorityKey(domain, key);
				const old = getRow(domain, key);
				if (enforce) validateRecordProgress(old?.record, record, allowTransitionRecovery);
				const original = initialRows.get(cursor);
				const expectation: AuthorityExpectation = { domain, key, version: original?.version ?? null };
				expected.set(cursor, expectation);
				const row: AuthorityRow = Object.freeze({
					record: Object.freeze({ ...record }),
					version: (original?.version ?? 0) + 1,
				});
				stagedRows.set(cursor, row);
				const existingIndex = changes.findIndex(
					change => authorityKey(recordDomain(change.record), authorityRecordKey(change.record)) === cursor,
				);
				if (existingIndex >= 0) changes[existingIndex] = row;
				else changes.push(row);
				highWater = highWaterFor(record, highWater);
				validateAuthorityRelationships(record, getRow, getControl);
			};
			const updateGenerationEvidence = (record: DurableRegistryRecord): void => {
				if (record.kind === "root") {
					const key = immutableRootKey(record.rootId, record.generation);
					const old = getControl(key);
					if (old === undefined) putControl(key, { record: Object.freeze({ ...record }), version: 1 });
					else {
						const row = asRow<DurableRootRecord>(old);
						if (!row || row.record.headHash !== record.headHash)
							throw new Error("Root generation immutable head evidence changed.");
						validateRecordProgress(row.record, record);
						const persisted = asRow<DurableRootRecord>(this.#driver.getControl(key));
						putControl(key, { record: Object.freeze({ ...record }), version: (persisted?.version ?? 0) + 1 });
					}
				}
				if (record.kind === "actor") {
					const key = immutableActorKey(record.actorId, record.generation);
					const old = getControl(key);
					const previous =
						old && typeof old === "object" ? (old as { row?: unknown; parentGeneration?: number }) : undefined;
					const historical = asRow<DurableActorRecord>(previous?.row);
					if (historical) {
						const origin = historical.record;
						if (
							origin.rootId !== record.rootId ||
							origin.parentId !== record.parentId ||
							origin.rootGeneration !== record.rootGeneration ||
							origin.rootHeadHash !== record.rootHeadHash ||
							origin.startupHash !== record.startupHash ||
							origin.provenanceHash !== record.provenanceHash ||
							origin.scopeHash !== record.scopeHash ||
							origin.parentScopeHash !== record.parentScopeHash
						)
							throw new Error("Actor generation immutable evidence changed.");
						validateRecordProgress(historical.record, record);
						const persisted = this.#driver.getControl(key) as
							| { row?: AuthorityRow<DurableActorRecord> }
							| undefined;
						putControl(key, {
							row: { record: Object.freeze({ ...record }), version: (persisted?.row?.version ?? 0) + 1 },
							...(previous?.parentGeneration === undefined
								? {}
								: { parentGeneration: previous.parentGeneration }),
						});
					} else {
						let parentGeneration: number | undefined;
						if (record.parentId !== undefined) {
							const parent = getRow("actor", [record.parentId]);
							if (!parent || parent.record.rootId !== record.rootId || parent.record.state !== "active")
								throw new Error("Actor first-admission parent is unavailable.");
							parentGeneration = parent.record.generation;
						}
						putControl(key, {
							row: { record: Object.freeze({ ...record }), version: 1 },
							...(parentGeneration === undefined ? {} : { parentGeneration }),
						});
					}
				}
			};
			const putGenericRecord = (record: DurableRegistryRecord): void => {
				const previous = getRow(recordDomain(record), authorityRecordKey(record))?.record;
				validateGenericRecordAdmission(previous, record);
				putRecord(record);
				updateGenerationEvidence(record);
			};
			switch (command.kind) {
				case "transition": {
					putGenericRecord(command.record);
					if (
						command.record.kind === "gate" &&
						command.record.phase === "closed" &&
						this.#owner.phase === "recovering"
					) {
						const evidence = rootRecoveryEvidenceFor(
							command.record.rootId,
							this.#owner,
							getRow("gate", [command.record.rootId])?.version ?? 0,
							getRow,
							getControl,
						);
						if (evidence) putControl(rootRecoveryKey(command.record.rootId), evidence);
					}
					break;
				}
				case "transition-batch":
					for (const record of command.records) putGenericRecord(record);
					break;
				case "activate-authority": {
					const activation = command.activation;
					const actor = activation.actor;
					const constructionRecord = activation.construction;
					const gate = activation.gate;
					const recoveryEvidence = recoveredRootActivationEvidence(activation, getRow, getControl);
					const activateConstruction = validateActivationAdmission(activation, getRow, getControl);
					if (activation.root) {
						putRecord(activation.root);
						updateGenerationEvidence(activation.root);
					}
					if (activateConstruction) putRecord(constructionRecord);
					putRecord(actor);
					updateGenerationEvidence(actor);
					if (gate) putRecord(gate);
					if (recoveryEvidence) deleteControl(rootRecoveryKey(recoveryEvidence.rootId));
					break;
				}
				case "commit-root-transition": {
					const transition = command.transition;
					const transitionRecord = transition.transition;
					validateRootTransitionAdmission(transition, getRow, getControl);
					const root = getRow("root", [transitionRecord.rootId]);
					const sourceGate = getRow("gate", [transitionRecord.rootId]);
					const stagedTransition = getRow("transition", [transitionRecord.rootId, transitionRecord.transitionId]);
					const persistedTransition = stagedTransition?.record;
					if (
						!root ||
						root.record.state !== "active" ||
						root.record.generation !== transition.expectedRootGeneration ||
						root.record.headHash !== transition.expectedRootHeadHash ||
						transitionRecord.sourceGeneration !== transition.expectedRootGeneration ||
						transitionRecord.sourceHeadHash !== transition.expectedRootHeadHash ||
						transitionRecord.rootId !== root.record.rootId ||
						!persistedTransition ||
						persistedTransition.sourceGeneration !== transitionRecord.sourceGeneration ||
						persistedTransition.destinationGeneration !== transitionRecord.destinationGeneration ||
						persistedTransition.sourceHeadHash !== transitionRecord.sourceHeadHash ||
						persistedTransition.destinationHeadHash !== transitionRecord.destinationHeadHash
					)
						throw new DurableStateConflictError("Root transition identity or source compare-and-swap changed.");
					if (transitionRecord.phase === "recovered") {
						if (
							!["staged", "quiescing", "quiesced", "validated"].includes(persistedTransition.phase) ||
							!sourceGate ||
							sourceGate.record.generation !== transition.expectedRootGeneration ||
							(sourceGate.record.phase !== "quiescing" && sourceGate.record.phase !== "quiesced") ||
							transitionRecord.recovery !== true ||
							transition.root.state !== "active" ||
							canonicalDurableSha256(transition.root) !== canonicalDurableSha256(root.record) ||
							transition.gate.rootId !== root.record.rootId ||
							transition.gate.generation !== transition.expectedRootGeneration ||
							transition.gate.phase !== "open"
						)
							throw new DurableStateConflictError(
								"Pre-CAS recovery requires the exact active source and a quiescing source gate.",
							);
						const invalidatedKey = immutableRootKey(root.record.rootId, transitionRecord.destinationGeneration);
						const existingInvalidation = asRow<DurableRootRecord>(getControl(invalidatedKey));
						if (existingInvalidation)
							throw new DurableStateConflictError(
								"Consumed destination generation already has immutable history.",
							);
						putControl(invalidatedKey, {
							record: {
								kind: "root",
								at: transitionRecord.at,
								rootId: root.record.rootId,
								generation: transitionRecord.destinationGeneration,
								headHash: transitionRecord.destinationHeadHash,
								state: "invalidated",
							},
							version: 1,
						});
						highWater = Math.max(highWater, transitionRecord.destinationGeneration);
						putRecord(transitionRecord, true, true);
						putRecord(transition.gate, true, true);
						break;
					}
					if (
						!sourceGate ||
						sourceGate.record.generation !== transition.expectedRootGeneration ||
						sourceGate.record.phase !== "quiesced" ||
						persistedTransition.phase !== "validated" ||
						transitionRecord.phase !== "cas-committed" ||
						transitionRecord.recovery !== undefined ||
						transition.root.rootId !== root.record.rootId ||
						transition.root.generation !== transitionRecord.destinationGeneration ||
						transition.root.state !== "active" ||
						transition.root.headHash !== transitionRecord.destinationHeadHash ||
						transition.gate.rootId !== transition.root.rootId ||
						transition.gate.generation !== transition.expectedRootGeneration ||
						transition.gate.phase !== "closed"
					)
						throw new Error("Root transition commit is inconsistent.");
					putRecord(transitionRecord);
					putRecord(transition.root);
					putRecord(transition.gate);
					updateGenerationEvidence(transition.root);
					break;
				}
				case "reserve-local": {
					const input = command.input;
					if (getControl(localClaimKey(input.localId)) !== undefined)
						throw new DurableStateConflictError("Local publication has an unresolved claim.");
					const admission = validateLocalReservationAdmission(input, this.localBacking(input.localId));
					const { version, previousHeadHash: actual, headHash } = admission;
					const claim: LocalClaim = Object.freeze({
						localId: input.localId,
						entryId: input.entryId,
						version,
						entryHash: input.entryHash,
						headHash,
						previousHeadHash: actual,
						claimToken: crypto.randomUUID(),
						ownerEpoch: request.ownerEpoch,
						incarnation: request.incarnation,
						phase: "reserved",
					});
					const entry: DurableLocalEntryRecord = {
						kind: "local-entry",
						at: Date.now(),
						localId: input.localId,
						entryId: input.entryId,
						version,
						expectedHeadHash: input.expectedHeadHash,
						entryHash: input.entryHash,
						headHash,
						phase: "intent",
					};
					putRecord(entry);
					putControl(localClaimKey(input.localId), claim);
					result = { kind: "local-claim", claim };
					break;
				}
				case "authorize-local-effect": {
					const claim = command.claim;
					const stored = getControl(localClaimKey(claim.localId));
					assertSameClaim(stored, claim);
					this.#assertClaimOwner(claim, request);
					if (claim.phase !== "reserved")
						throw new DurableStateConflictError("Local claim is not awaiting effect authorization.");
					this.#assertLocalPredecessor(claim);
					const entry = getRow("local-entry", [claim.localId, claim.entryId, claim.version]);
					if (!entry || entry.record.phase !== "intent")
						throw new DurableStateConflictError("Local claim intent is missing.");
					putRecord({ ...entry.record, at: Date.now(), phase: "effect" });
					putControl(localClaimKey(claim.localId), { ...claim, phase: "effect" });
					break;
				}
				case "finalize-local": {
					const claim = command.claim;
					const stored = getControl(localClaimKey(claim.localId));
					assertSameClaim(stored, claim);
					this.#assertClaimOwner(claim, request);
					if (claim.phase !== "effect")
						throw new DurableStateConflictError("Local effect was not durably authorized.");
					if (command.outcome === "uncertain") {
						putControl(localClaimKey(claim.localId), { ...claim, phase: "uncertain" });
						result = {
							kind: "local-publication",
							publication: { version: claim.version, headHash: claim.headHash },
						};
						break;
					}
					this.#assertLocalPredecessor(claim);
					const entry = getRow("local-entry", [claim.localId, claim.entryId, claim.version]);
					if (!entry || entry.record.phase !== "effect")
						throw new DurableStateConflictError("Local effect record is missing.");
					putRecord({ ...entry.record, at: Date.now(), phase: "committed" });
					const head: DurableLocalHeadRecord = {
						kind: "local-head",
						at: Date.now(),
						localId: claim.localId,
						version: claim.version,
						previousHeadHash: claim.previousHeadHash,
						headHash: claim.headHash,
						phase: "current",
					};
					putRecord(head);
					deleteControl(localClaimKey(claim.localId));
					result = {
						kind: "local-publication",
						publication: { version: claim.version, headHash: claim.headHash },
					};
					break;
				}
				case "reconcile-local":
					result = this.#reconcileLocal(command.input, putRecord, deleteControl);
					break;
				case "recover":
					break;
				case "owner":
					putControl("owner", command.owner);
					break;
				case "quarantine":
					putControl("meta", {
						revision: meta.revision + 1,
						generationHighWater: meta.generationHighWater,
						status: "quarantined",
						quarantineReason: command.reason,
					});
					break;
			}
			if (command.kind !== "quarantine")
				putControl("meta", {
					revision: meta.revision + 1,
					generationHighWater: highWater,
					status: "ready",
				});
			const revision = meta.revision + 1;
			const receipt: MutationReceipt = Object.freeze({
				requestId: request.requestId,
				ownerEpoch: request.ownerEpoch,
				revision,
				payloadHash,
				incarnation: request.incarnation,
				commandKind: command.kind,
				committedAt: Date.now(),
				result,
			});
			putControl(receiptKey(request), receipt);
			const frameBase = {
				version: 2 as const,
				kind: "commit" as const,
				revision,
				request,
				command,
				payloadHash,
				expected: Object.freeze([...expected.values()]),
				changes: Object.freeze(changes),
				controls: Object.freeze([...controlChanges.values()]),
				receipt,
				previousHash: meta.headHash,
				committedAt: receipt.committedAt,
			};
			const contentHash = authorityFrameContentHash(frameBase);
			const frame: AuthorityCommitFrame = Object.freeze({
				...frameBase,
				contentHash,
				hash: authorityFrameHash({ version: 2, revision, previousHash: meta.headHash, contentHash }),
			});
			validateAuthorityFrame(frame, meta.headHash);
			this.#driver.commit(frame);
			return receipt;
		});
	}

	#assertOwnerPermission(
		command: AuthorityCommand,
		permissions: { allowRecovering?: boolean; allowQuiescing?: boolean; allowClosed?: boolean },
	): void {
		if (this.#owner.incarnation !== this.identity.incarnation || this.#owner.token !== this.#ownerToken)
			throw new DurableStateConflictError("Authority owner identity changed.");
		const phase = this.#owner.phase;
		if (phase === "ready") return;
		if (
			phase === "recovering" &&
			(permissions.allowRecovering ||
				command.kind === "recover" ||
				command.kind === "reconcile-local" ||
				command.kind === "quarantine")
		)
			return;
		if (
			phase === "quiescing" &&
			(permissions.allowQuiescing ||
				command.kind === "finalize-local" ||
				command.kind === "reconcile-local" ||
				command.kind === "quarantine")
		)
			return;
		if (phase === "closed" && permissions.allowClosed) return;
		throw new DurableStateUnavailableError(`Authority owner is ${phase}.`);
	}

	// Owner and lifecycle commands change the engine's in-memory owner, so they never join a group.
	#assertNoOpenGroup(operation: string): void {
		if (this.#driver.groupCommit?.open)
			throw new Error(`Authority ${operation} cannot run inside an open commit group.`);
	}

	#assertOwnerPhase(phase: AuthorityOwner["phase"]): void {
		if (this.#owner.phase !== phase)
			throw new DurableStateUnavailableError(`Authority recovery requires ${phase} owner phase.`);
	}

	#findReceipt(key: string, payloadHash?: string): MutationReceipt | undefined {
		const receipt = this.#driver.getControl(key);
		if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
		const typed = receipt as MutationReceipt;
		if (payloadHash !== undefined && typed.payloadHash !== payloadHash)
			throw new DurableStateConflictError("Request identity was reused with a different payload.");
		return typed;
	}

	#collectOpen<D extends AuthorityDomain>(domain: D): AuthorityRow<AuthorityRecordMap[D]>[] {
		const rows: AuthorityRow<AuthorityRecordMap[D]>[] = [];
		let after: string | undefined;
		while (true) {
			const page = this.#driver.scan(domain, { openOnly: true, after, limit: MAX_PAGE_SIZE });
			rows.push(...page.rows);
			if (!page.cursor) return rows;
			after = page.cursor;
		}
	}

	#unresolvedReasons(): string[] {
		const reasons = new Set<string>();
		for (const domain of ["construction", "operation", "resource", "transition", "local-entry"] as const) {
			for (const row of this.#collectOpen(domain)) {
				const record = row.record;
				if (record.kind === "construction" && record.phase !== "activated" && record.phase !== "abandoned")
					reasons.add(`construction:${record.rootId}:${record.actorId}:${record.generation}:${record.phase}`);
				if (
					record.kind === "operation" &&
					(record.phase === "intent" || record.phase === "effect" || record.phase === "committed")
				)
					reasons.add(`operation:${record.ownerId}:${record.operationId}:${record.phase}`);
				if (
					record.kind === "resource" &&
					(record.phase === "intent" || record.phase === "effect" || record.phase === "committed")
				)
					reasons.add(`resource:${record.actorId}:${record.resourceId}:${record.phase}`);
				if (record.kind === "transition" && !TERMINAL_TRANSITION_PHASES.has(record.phase))
					reasons.add(`transition:${record.rootId}:${record.transitionId}:${record.phase}`);
				if (record.kind === "local-entry" && (record.phase === "intent" || record.phase === "effect"))
					reasons.add(`local:${record.localId}:${record.entryId}:${record.phase}`);
			}
		}
		let cursor: string | undefined;
		while (true) {
			const page = this.#driver.scanControl("local-claim:", cursor, MAX_PAGE_SIZE);
			for (const control of page.controls) if (!control.key.startsWith("__deleted__")) reasons.add(control.key);
			if (!page.cursor) break;
			cursor = page.cursor;
		}
		return [...reasons].sort();
	}

	#assertClaimOwner(claim: LocalClaim, request: AuthorityRequestIdentity): void {
		if (claim.ownerEpoch !== request.ownerEpoch || claim.incarnation !== request.incarnation)
			throw new DurableStateConflictError("Local claim belongs to a different owner incarnation.");
	}

	#assertLocalPredecessor(claim: LocalClaim): void {
		const current = this.#driver.get("local-head", [claim.localId]);
		const actual = current?.record.phase === "current" ? current.record.headHash : GENESIS_HASH;
		if (actual !== claim.previousHeadHash)
			throw new DurableStateConflictError("Local publication predecessor changed.");
	}

	#reconcileLocal(
		input: LocalReconciliation,
		putRecord: (record: DurableRegistryRecord, enforce?: boolean) => void,
		deleteControl: (key: string) => void,
	): MutationReceipt["result"] {
		const claim = input.claim;
		assertSameClaim(this.#driver.getControl(localClaimKey(claim.localId)), claim);
		const entry = this.#driver.get("local-entry", [claim.localId, claim.entryId, claim.version]);
		const reserved = claim.phase === "reserved";
		if (
			!entry ||
			entry.record.localId !== claim.localId ||
			entry.record.entryId !== claim.entryId ||
			entry.record.version !== claim.version ||
			entry.record.expectedHeadHash !== claim.previousHeadHash ||
			entry.record.entryHash !== claim.entryHash ||
			entry.record.headHash !== claim.headHash ||
			(reserved ? entry.record.phase !== "intent" : entry.record.phase !== "effect")
		)
			throw new DurableStateConflictError("Local claim has no matching durable entry in its persisted phase.");
		const head = this.#driver.get("local-head", [claim.localId]);
		const actualHead = head?.record.phase === "current" ? head.record.headHash : GENESIS_HASH;
		if (actualHead !== claim.previousHeadHash)
			throw new DurableStateConflictError("Local predecessor changed during reconciliation.");
		if (input.action === "commit") {
			if (reserved) throw new DurableStateConflictError("An unapproved reservation cannot be committed.");
			if (input.observedEntryHash !== claim.entryHash)
				throw new DurableStateConflictError("Observed backing entry does not match the claimed entry hash.");
			putRecord({ ...entry.record, at: Date.now(), phase: "committed" });
			putRecord({
				kind: "local-head",
				at: Date.now(),
				localId: claim.localId,
				version: claim.version,
				previousHeadHash: claim.previousHeadHash,
				headHash: claim.headHash,
				phase: "current",
			});
			deleteControl(localClaimKey(claim.localId));
			return { kind: "local-publication", publication: { version: claim.version, headHash: claim.headHash } };
		}
		const prior = claim.previousHeadHash === GENESIS_HASH ? undefined : this.localBacking(claim.localId);
		const expectedObserved = prior?.entryHash ?? GENESIS_HASH;
		if (input.observedEntryHash !== expectedObserved)
			throw new DurableStateConflictError("Observed backing bytes do not prove the predecessor state.");
		putRecord({ ...entry.record, at: Date.now(), phase: "cancelled" });
		deleteControl(localClaimKey(claim.localId));
		return { kind: "mutation" };
	}
}
