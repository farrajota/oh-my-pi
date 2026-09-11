import * as fs from "node:fs";
import * as path from "node:path";

export const HUB_DURABLE_RECORD_VERSION = 1;
export const HUB_RECOVERY_BATCH_LIMIT = 100;
const MAX_RECORD_BYTES = 96 * 1024;
const RESERVED_KEY =
	/(?:credential|password|secret|private.?key|capability|authority|transaction|handle|backing.?path|output.?path)$/i;

export type HubDurableRecordKind =
	| "job"
	| "delivery"
	| "consumption"
	| "cancel"
	| "admission"
	| "wait"
	| "mailbox"
	| "correlation"
	| "pin"
	| "result";

export interface HubDurableRecord {
	readonly version: typeof HUB_DURABLE_RECORD_VERSION;
	readonly recordId: string;
	readonly kind: HubDurableRecordKind;
	readonly entityId: string;
	readonly incarnationId: string;
	readonly sequence: number;
	readonly occurredAt: number;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly payloadSha256: string;
}

export interface HubDurableRecoveryBatch {
	readonly records: readonly HubDurableRecord[];
	readonly units: readonly (readonly HubDurableRecord[])[];
	readonly quarantined: readonly { cursor: number; reason: string }[];
	readonly nextCursor?: number;
}

/** A records-only mutation staged until one Hub admission commit point. */
export interface HubDurableMutation {
	readonly kind: HubDurableRecordKind;
	readonly entityId: string;
	readonly incarnationId: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly occurredAt?: number;
}

interface HubDurableBatchEnvelope {
	readonly version: typeof HUB_DURABLE_RECORD_VERSION;
	readonly kind: "batch";
	readonly batchId: string;
	readonly records: readonly HubDurableRecord[];
	readonly batchSha256: string;
}

function canonicalValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Durable Hub records require finite numbers.");
		return value;
	}
	if (Array.isArray(value)) return value.map(item => canonicalValue(item, seen));
	if (typeof value !== "object" || value === null)
		throw new Error("Durable Hub records contain an unsupported value.");
	if (seen.has(value)) throw new Error("Durable Hub records cannot contain cycles.");
	seen.add(value);
	try {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (RESERVED_KEY.test(key)) throw new Error(`Durable Hub record field is forbidden: ${key}`);
			const item = (value as Record<string, unknown>)[key];
			if (item !== undefined) out[key] = canonicalValue(item, seen);
		}
		return out;
	} finally {
		seen.delete(value);
	}
}

export function canonicalDurableJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

export function canonicalSha256(value: unknown): string {
	return new Bun.CryptoHasher("sha256").update(canonicalDurableJson(value)).digest("hex");
}

const HUB_DURABLE_KINDS = new Set<HubDurableRecordKind>([
	"job",
	"delivery",
	"consumption",
	"cancel",
	"admission",
	"wait",
	"mailbox",
	"correlation",
	"pin",
	"result",
]);

function isRecord(value: unknown): value is HubDurableRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<HubDurableRecord>;
	return (
		record.version === HUB_DURABLE_RECORD_VERSION &&
		typeof record.recordId === "string" &&
		record.recordId.length > 0 &&
		record.recordId.length <= 256 &&
		typeof record.kind === "string" &&
		HUB_DURABLE_KINDS.has(record.kind as HubDurableRecordKind) &&
		typeof record.entityId === "string" &&
		record.entityId.length > 0 &&
		record.entityId.length <= 512 &&
		typeof record.incarnationId === "string" &&
		record.incarnationId.length > 0 &&
		record.incarnationId.length <= 256 &&
		Number.isSafeInteger(record.sequence) &&
		(record.sequence ?? 0) > 0 &&
		typeof record.occurredAt === "number" &&
		Number.isFinite(record.occurredAt) &&
		!!record.payload &&
		typeof record.payload === "object" &&
		typeof record.payloadSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(record.payloadSha256) &&
		canonicalSha256(record.payload) === record.payloadSha256
	);
}

function reservationName(kind: string, entityId: string): string {
	return `${canonicalSha256({ entityId, kind })}.json`;
}

function assertOpaqueId(value: string, label: string, maxBytes: number): void {
	if (!value || Buffer.byteLength(value) > maxBytes || value.includes("\0")) {
		throw new Error(`Durable Hub ${label} must be a bounded opaque string.`);
	}
}

/** Append-only, records-only custody journal. It never accepts runtime capabilities or handles. */
export class DurableHubStore {
	readonly journalPath: string;
	readonly #reservationDir: string;
	readonly #writerId = crypto.randomUUID();
	#sequence = 0;

	constructor(journalPath: string) {
		this.journalPath = path.resolve(journalPath);
		this.#reservationDir = `${this.journalPath}.reservations`;
	}

	/** Occupy a public identity before any effect. Existing reservations are never reclaimed. */
	reserve(kind: "job" | "admission" | "wait", entityId: string, incarnationId: string): boolean {
		assertOpaqueId(entityId, "entity id", 512);
		assertOpaqueId(incarnationId, "incarnation id", 256);
		fs.mkdirSync(this.#reservationDir, { recursive: true });
		const reservationPath = path.join(this.#reservationDir, reservationName(kind, entityId));
		try {
			const fd = fs.openSync(reservationPath, "wx", 0o600);
			try {
				const body = canonicalDurableJson({ version: 1, kind, entityId, incarnationId });
				fs.writeFileSync(fd, `${body}\n`, "utf8");
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	}

	append(
		kind: HubDurableRecordKind,
		entityId: string,
		incarnationId: string,
		payload: Readonly<Record<string, unknown>>,
		occurredAt = Date.now(),
	): HubDurableRecord {
		const record = this.#buildRecord({ kind, entityId, incarnationId, payload, occurredAt });
		const line = `${canonicalDurableJson(record)}\n`;
		if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("Durable Hub record exceeds 96 KiB.");
		this.#appendLine(line);
		return record;
	}

	/** Append one validated, fsync'd batch. Recovery exposes all members or none. */
	appendBatch(mutations: readonly HubDurableMutation[]): readonly HubDurableRecord[] {
		if (mutations.length === 0) throw new Error("Durable Hub batches must contain at least one mutation.");
		const records = mutations.map(mutation => this.#buildRecord(mutation));
		const envelope: HubDurableBatchEnvelope = {
			version: HUB_DURABLE_RECORD_VERSION,
			kind: "batch",
			batchId: crypto.randomUUID(),
			records,
			batchSha256: canonicalSha256({ records }),
		};
		const line = `${canonicalDurableJson(envelope)}\n`;
		if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("Durable Hub batch exceeds 96 KiB.");
		this.#appendLine(line);
		return records;
	}

	#buildRecord(mutation: HubDurableMutation): HubDurableRecord {
		assertOpaqueId(mutation.entityId, "entity id", 512);
		assertOpaqueId(mutation.incarnationId, "incarnation id", 256);
		const normalizedPayload = canonicalValue(mutation.payload) as Readonly<Record<string, unknown>>;
		return Object.freeze({
			version: HUB_DURABLE_RECORD_VERSION,
			recordId: `${this.#writerId}:${this.#sequence + 1}`,
			kind: mutation.kind,
			entityId: mutation.entityId,
			incarnationId: mutation.incarnationId,
			sequence: ++this.#sequence,
			occurredAt: mutation.occurredAt ?? Date.now(),
			payload: normalizedPayload,
			payloadSha256: canonicalSha256(normalizedPayload),
		});
	}

	#appendLine(line: string): void {
		fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
		const fd = fs.openSync(this.journalPath, "a", 0o600);
		try {
			fs.writeSync(fd, line, undefined, "utf8");
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}

	recover(cursor = 0, limit = HUB_RECOVERY_BATCH_LIMIT): HubDurableRecoveryBatch {
		const boundedLimit = Math.min(HUB_RECOVERY_BATCH_LIMIT, Math.max(1, Math.trunc(limit)));
		let text: string;
		try {
			text = fs.readFileSync(this.journalPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], units: [], quarantined: [] };
			throw error;
		}
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const start = Math.max(0, Math.trunc(cursor));
		const end = Math.min(lines.length, start + boundedLimit);
		const records: HubDurableRecord[] = [];
		const units: HubDurableRecord[][] = [];
		const quarantined: { cursor: number; reason: string }[] = [];
		for (let index = start; index < end; index++) {
			try {
				const parsed = JSON.parse(lines[index]!);
				if (isRecord(parsed)) {
					const record = Object.freeze(parsed);
					records.push(record);
					units.push([record]);
					continue;
				}
				if (
					!parsed ||
					typeof parsed !== "object" ||
					(parsed as Partial<HubDurableBatchEnvelope>).version !== HUB_DURABLE_RECORD_VERSION ||
					(parsed as Partial<HubDurableBatchEnvelope>).kind !== "batch"
				)
					throw new Error("invalid schema or payload hash");
				const envelope = parsed as Partial<HubDurableBatchEnvelope>;
				if (!Array.isArray(envelope.records) || typeof envelope.batchSha256 !== "string")
					throw new Error("invalid durable batch envelope");
				if (canonicalSha256({ records: envelope.records }) !== envelope.batchSha256)
					throw new Error("durable batch hash mismatch");
				if (envelope.records.length === 0 || envelope.records.some(record => !isRecord(record)))
					throw new Error("invalid durable batch member");
				const unit = envelope.records.map(record => Object.freeze(record));
				units.push(unit);
				records.push(...unit);
			} catch (error) {
				quarantined.push({ cursor: index, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		return {
			records,
			units,
			quarantined,
			...(end < lines.length ? { nextCursor: end } : {}),
		};
	}
}

const durableStoresByPath = new Map<string, DurableHubStore>();

export function hubDurableJournalPath(sessionFile: string): string {
	return `${path.resolve(sessionFile)}.hub-custody-v1.jsonl`;
}

/** Process-local identity for one journal so independently attached managers share it. */
export function durableHubStoreForSession(sessionFile: string): DurableHubStore {
	const journalPath = hubDurableJournalPath(sessionFile);
	let store = durableStoresByPath.get(journalPath);
	if (!store) {
		store = new DurableHubStore(journalPath);
		durableStoresByPath.set(journalPath, store);
	}
	return store;
}
