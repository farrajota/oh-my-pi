/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { replaceFileAtomically } from "../utils/atomic-file";

/**
 * Sanitize a tool name for safe use as the middle segment of the artifact
 * filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP,
 * extension, and RPC-host tool names are arbitrary and may contain path
 * separators (`/`, `\`) or traversal sequences (`..`) that would otherwise let
 * a spilled artifact escape the artifacts directory. Collapse everything
 * outside `[A-Za-z0-9_-]` to `_`, and cap the length so an arbitrarily long
 * name cannot overflow the filesystem's filename limit (ENAMETOOLONG). Fall
 * back to `tool` when nothing survives.
 */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

const pendingManagedWrites = new Map<string, () => Promise<void>>();

/** Publish a manager-reserved streaming path after its writer has closed. */
export async function publishAllocatedArtifact(artifactPath: string): Promise<void> {
	const resolvedPath = path.resolve(artifactPath);
	const managedPublish = pendingManagedWrites.get(resolvedPath);
	if (!managedPublish) return;
	try {
		await managedPublish();
	} finally {
		pendingManagedWrites.delete(resolvedPath);
	}
}

/**
 * Persist an artifact only after the filesystem confirms the complete payload
 * is readable. Content is written to a temporary sibling and verified (byte
 * count, on-disk size, readability) before an atomic rename. Paths issued by
 * ArtifactManager are opaque staging paths: after that rename this helper
 * seals metadata and publishes final content through the manager. Other
 * callers retain the legacy atomic-file behavior. On failure, the temporary
 * file is removed and any pre-existing destination remains untouched.
 *
 * Returns the verified UTF-8 byte count.
 */
export async function writeArtifact(artifactPath: string, content: string): Promise<number> {
	const expectedBytes = Buffer.byteLength(content);
	const tempPath = `${artifactPath}.tmp-${crypto.randomUUID()}`;
	const managedPublish = pendingManagedWrites.has(path.resolve(artifactPath));
	try {
		const writtenBytes = await Bun.write(tempPath, content);
		if (writtenBytes !== expectedBytes) {
			throw new Error(`Artifact write incomplete: wrote ${writtenBytes} of ${expectedBytes} bytes`);
		}
		const file = Bun.file(tempPath);
		if (file.size !== expectedBytes) {
			throw new Error(`Artifact size mismatch: found ${file.size} of ${expectedBytes} bytes`);
		}
		await file.slice(0, Math.min(expectedBytes, 1)).arrayBuffer();
		await replaceFileAtomically(tempPath, artifactPath);
		await publishAllocatedArtifact(artifactPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	} finally {
		if (managedPublish) pendingManagedWrites.delete(path.resolve(artifactPath));
	}
	return expectedBytes;
}

export type ArtifactPublicationPhase = "reserved" | "staged" | "metadata-published" | "published" | "abandoned";

export interface ArtifactReservationOptions {
	readonly provenance?: string;
	readonly scope?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ArtifactReservation {
	readonly id: string;
	readonly stagingId: string;
	readonly path: string;
}

export interface ArtifactRecoveryBatch {
	readonly processed: number;
	readonly published: readonly string[];
	readonly abandoned: readonly string[];
	readonly quarantined: readonly string[];
	readonly nextCursor?: number;
}

export type NamedArtifactNamespace = "agent-output" | "agent-sidecar";

export interface AgentArtifactPublication {
	readonly generationId: string;
	readonly outputPath: string;
	readonly sidecarPath?: string;
}

export interface AgentArtifactPublishOptions extends ArtifactReservationOptions {
	readonly expectedGenerationId?: string | null;
}

interface NamedArtifactHead {
	readonly version: 1;
	readonly identitySha256: string;
	readonly generationId: string;
	readonly outputArtifactId: string;
	readonly sidecarArtifactId?: string;
}

interface NamedArtifactClaim extends NamedArtifactHead {
	readonly expectedGenerationId: string | null;
}

class NamedArtifactUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NamedArtifactUnavailableError";
	}
}

interface ArtifactState {
	readonly version: 1;
	readonly id: string;
	readonly stagingId: string;
	readonly toolType: string;
	readonly suffix: string;
	readonly provenance: string;
	readonly scope: string;
	readonly metadataInputSha256: string;
	readonly audience: "artifact" | "named";
	readonly phase: ArtifactPublicationPhase;
	readonly createdAt: number;
	readonly bytes?: number;
	readonly contentSha256?: string;
	readonly metadataSha256?: string;
	readonly reason?: string;
}

const ARTIFACT_RECOVERY_BATCH_LIMIT = 100;
const MAX_ARTIFACT_ID_ATTEMPTS = 100;

function artifactSha256(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function isArtifactId(value: string): boolean {
	return /^\d{1,64}$/.test(value);
}

function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
	);
}

function namedArtifactFilename(namespace: NamedArtifactNamespace, logicalId: string): string {
	if (
		logicalId.length === 0 ||
		logicalId === "." ||
		logicalId === ".." ||
		logicalId !== path.basename(logicalId) ||
		logicalId.includes("/") ||
		logicalId.includes("\\") ||
		logicalId.includes("\0")
	) {
		throw new Error("Named artifact id must be a single safe filename segment.");
	}
	const suffix = namespace === "agent-output" ? ".md" : ".json";
	const filename = `${logicalId}${suffix}`;
	if (Buffer.byteLength(filename) > 255) throw new Error("Named artifact filename is too long.");
	return filename;
}

function isNamedArtifactHead(value: unknown, identitySha256: string): value is NamedArtifactHead {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<NamedArtifactHead>;
	return (
		state.version === 1 &&
		state.identitySha256 === identitySha256 &&
		/^[a-f0-9]{64}$/.test(identitySha256) &&
		isUuid(state.generationId) &&
		typeof state.outputArtifactId === "string" &&
		isArtifactId(state.outputArtifactId) &&
		(state.sidecarArtifactId === undefined ||
			(typeof state.sidecarArtifactId === "string" && isArtifactId(state.sidecarArtifactId)))
	);
}

function isNamedArtifactClaim(value: unknown, identitySha256: string): value is NamedArtifactClaim {
	if (!isNamedArtifactHead(value, identitySha256)) return false;
	const claim = value as Partial<NamedArtifactClaim>;
	return claim.expectedGenerationId === null || isUuid(claim.expectedGenerationId);
}

function stableMetadata(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Artifact metadata requires finite numbers.");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(item => stableMetadata(item, seen)).join(",")}]`;
	if (!value || typeof value !== "object") throw new Error("Artifact metadata contains an unsupported value.");
	if (seen.has(value)) throw new Error("Artifact metadata cannot contain cycles.");
	seen.add(value);
	try {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.filter(key => (value as Record<string, unknown>)[key] !== undefined)
			.map(key => {
				if (
					/(?:credential|password|secret|private.?key|capability|authority|transaction|handle|path)$/i.test(key)
				) {
					throw new Error(`Artifact metadata field is forbidden: ${key}`);
				}
				return `${JSON.stringify(key)}:${stableMetadata((value as Record<string, unknown>)[key], seen)}`;
			})
			.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

function isArtifactState(value: unknown, id: string, phase: ArtifactPublicationPhase): value is ArtifactState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<ArtifactState>;
	const digest = /^[a-f0-9]{64}$/;
	return (
		state.version === 1 &&
		state.id === id &&
		/^\d{1,64}$/.test(id) &&
		typeof state.stagingId === "string" &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(state.stagingId) &&
		typeof state.toolType === "string" &&
		state.toolType === sanitizeToolType(state.toolType) &&
		state.suffix === `.${state.toolType}.log` &&
		typeof state.provenance === "string" &&
		digest.test(state.provenance) &&
		typeof state.scope === "string" &&
		digest.test(state.scope) &&
		typeof state.metadataInputSha256 === "string" &&
		digest.test(state.metadataInputSha256) &&
		(state.audience === "artifact" || state.audience === "named") &&
		state.phase === phase &&
		typeof state.createdAt === "number" &&
		Number.isFinite(state.createdAt) &&
		(state.bytes === undefined ||
			(typeof state.bytes === "number" && Number.isSafeInteger(state.bytes) && state.bytes >= 0)) &&
		(state.contentSha256 === undefined || digest.test(state.contentSha256)) &&
		(state.metadataSha256 === undefined || digest.test(state.metadataSha256)) &&
		(state.reason === undefined || typeof state.reason === "string")
	);
}

/**
 * Manager-owned durable artifact publication. Reservation directories are the
 * allocation CAS: once created, an id remains occupied even when abandoned.
 */
export class ArtifactManager {
	readonly #dir: string;
	readonly #stateDir: string;
	readonly #stagingDir: string;
	readonly #namedStateDir: string;
	#dirCreated = false;

	constructor(dir: string) {
		this.#dir = dir;
		this.#stateDir = path.join(dir, ".artifact-state-v1");
		this.#stagingDir = path.join(dir, ".artifact-staging-v1");
		this.#namedStateDir = path.join(dir, ".artifact-named-state-v1");
	}

	get dir(): string {
		return this.#dir;
	}

	async #ensureDir(): Promise<void> {
		if (this.#dirCreated) return;
		await Promise.all([
			fs.mkdir(this.#dir, { recursive: true }),
			fs.mkdir(this.#stateDir, { recursive: true }),
			fs.mkdir(this.#stagingDir, { recursive: true }),
			fs.mkdir(this.#namedStateDir, { recursive: true }),
		]);
		this.#dirCreated = true;
	}

	#recordDir(id: string): string {
		return path.join(this.#stateDir, id);
	}

	#phasePath(id: string, phase: ArtifactPublicationPhase): string {
		const order: Record<ArtifactPublicationPhase, string> = {
			reserved: "00-reserved.json",
			staged: "10-staged.json",
			"metadata-published": "20-metadata-published.json",
			published: "30-published.json",
			abandoned: "99-abandoned.json",
		};
		return path.join(this.#recordDir(id), order[phase]);
	}

	async #writePhase(state: ArtifactState): Promise<void> {
		const phasePath = this.#phasePath(state.id, state.phase);
		const file = await fs.open(phasePath, "wx", 0o600);
		try {
			await file.writeFile(`${stableMetadata(state)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
	}

	async #readPhase(id: string, phase: ArtifactPublicationPhase): Promise<ArtifactState | undefined> {
		if (!isArtifactId(id)) return undefined;
		try {
			const value: unknown = JSON.parse(await fs.readFile(this.#phasePath(id, phase), "utf8"));
			if (!isArtifactState(value, id, phase)) throw new Error(`Invalid artifact ${phase} record: ${id}`);
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async #latestState(id: string): Promise<ArtifactState | undefined> {
		for (const phase of ["abandoned", "published", "metadata-published", "staged", "reserved"] as const) {
			const state = await this.#readPhase(id, phase);
			if (state) return state;
		}
		return undefined;
	}

	async reserve(toolType: string, options: ArtifactReservationOptions = {}): Promise<ArtifactReservation> {
		return this.#reserve(toolType, options, "artifact");
	}

	async #reserve(
		toolType: string,
		options: ArtifactReservationOptions,
		audience: ArtifactState["audience"],
	): Promise<ArtifactReservation> {
		await this.#ensureDir();
		const sanitized = sanitizeToolType(toolType);
		const suffix = `.${sanitized}.log`;
		const provenance = artifactSha256(options.provenance ?? "tool-output");
		const scope = artifactSha256(options.scope ?? "session");
		const metadataInputSha256 = artifactSha256(stableMetadata(options.metadata ?? {}));
		for (let attempt = 0; attempt < MAX_ARTIFACT_ID_ATTEMPTS; attempt++) {
			const id = BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`).toString(10);
			const stagingId = crypto.randomUUID();
			try {
				await fs.mkdir(this.#recordDir(id));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw error;
			}
			const state: ArtifactState = {
				version: 1,
				id,
				stagingId,
				toolType: sanitized,
				suffix,
				provenance,
				scope,
				metadataInputSha256,
				audience,
				phase: "reserved",
				createdAt: Date.now(),
			};
			try {
				await this.#writePhase(state);
				return { id, stagingId, path: path.join(this.#stagingDir, stagingId) };
			} catch (error) {
				await this.#abandon(
					state,
					`reservation-write-failed:${error instanceof Error ? error.message : String(error)}`,
				);
				throw error;
			}
		}
		throw new Error("Unable to reserve a unique artifact id.");
	}

	/** Reserve an opaque staging path. Call publishReserved after the stream closes. */
	async allocatePath(toolType: string): Promise<{ id: string; path: string }> {
		const reservation = await this.reserve(toolType);
		pendingManagedWrites.set(path.resolve(reservation.path), async () => {
			await this.publishReserved(reservation.id);
		});
		return { id: reservation.id, path: reservation.path };
	}

	/** Seal streamed bytes into the durable staged phase. */
	async stageReserved(id: string): Promise<void> {
		const state = await this.#latestState(id);
		if (!state || state.phase === "abandoned") throw new Error(`Artifact reservation is unavailable: ${id}`);
		if (state.phase !== "reserved") return;
		const stagingPath = path.join(this.#stagingDir, state.stagingId);
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await fs.readFile(stagingPath));
		} catch (error) {
			await this.#abandon(state, `staging-unreadable:${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		await this.#writePhase({
			...state,
			phase: "staged",
			bytes: bytes.byteLength,
			contentSha256: artifactSha256(bytes),
		});
	}

	/** Publish the canonical metadata hash before any final content filename exists. */
	async publishReservedMetadata(id: string): Promise<void> {
		let state = await this.#latestState(id);
		if (!state || state.phase === "abandoned") throw new Error(`Artifact reservation is unavailable: ${id}`);
		if (state.phase === "reserved") {
			await this.stageReserved(id);
			state = await this.#latestState(id);
		}
		if (!state || state.phase !== "staged") return;
		const metadataSha256 = artifactSha256(
			stableMetadata({
				id: state.id,
				suffix: state.suffix,
				bytes: state.bytes,
				contentSha256: state.contentSha256,
				provenance: state.provenance,
				scope: state.scope,
				audience: state.audience,
				metadataInputSha256: state.metadataInputSha256,
			}),
		);
		await this.#writePhase({ ...state, phase: "metadata-published", metadataSha256 });
	}

	async publishReserved(id: string): Promise<string> {
		let state = await this.#latestState(id);
		if (!state || state.phase === "abandoned") throw new Error(`Artifact reservation is unavailable: ${id}`);
		if (state.phase === "published") return id;
		if (state.phase === "reserved") await this.stageReserved(id);
		state = await this.#latestState(id);
		if (state?.phase === "staged") await this.publishReservedMetadata(id);
		state = await this.#latestState(id);
		if (!state || state.phase !== "metadata-published") throw new Error(`Artifact metadata is unavailable: ${id}`);
		const stagingPath = path.join(this.#stagingDir, state.stagingId);
		const working = state;
		await this.#validateStaging(working, stagingPath);
		const finalPath = path.join(this.#dir, `${working.id}${working.suffix}`);
		try {
			await fs.link(stagingPath, finalPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				await this.#abandon(working, `publish-failed:${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
			const existing = new Uint8Array(await fs.readFile(finalPath));
			if (existing.byteLength !== working.bytes || artifactSha256(existing) !== working.contentSha256) {
				await this.#abandon(working, "publish-collision");
				throw new Error(`Artifact publication collision: ${id}`);
			}
		}
		await fs.rm(stagingPath, { force: true });
		const published = { ...working, phase: "published" as const };
		try {
			await this.#writePhase(published);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		return id;
	}

	async #validateStaging(state: ArtifactState, stagingPath: string): Promise<void> {
		if (state.bytes === undefined || !state.contentSha256 || !state.metadataSha256) {
			throw new Error(`Artifact metadata is incomplete: ${state.id}`);
		}
		const bytes = new Uint8Array(await fs.readFile(stagingPath));
		if (bytes.byteLength !== state.bytes || artifactSha256(bytes) !== state.contentSha256) {
			await this.#abandon(state, "staging-tampered");
			throw new Error(`Artifact staging bytes failed validation: ${state.id}`);
		}
		const expectedMetadataHash = artifactSha256(
			stableMetadata({
				id: state.id,
				suffix: state.suffix,
				bytes: state.bytes,
				contentSha256: state.contentSha256,
				provenance: state.provenance,
				scope: state.scope,
				metadataInputSha256: state.metadataInputSha256,
				audience: state.audience,
			}),
		);
		if (expectedMetadataHash !== state.metadataSha256) {
			await this.#abandon(state, "metadata-tampered");
			throw new Error(`Artifact metadata failed validation: ${state.id}`);
		}
	}

	async #abandon(state: ArtifactState, reason: string): Promise<void> {
		try {
			await this.#writePhase({ ...state, phase: "abandoned", reason: reason.slice(0, 512) });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await fs.rm(path.join(this.#stagingDir, state.stagingId), { force: true });
	}

	async save(content: string, toolType: string, options: ArtifactReservationOptions = {}): Promise<string> {
		return this.#save(content, toolType, options, "artifact");
	}

	async #save(
		content: string,
		toolType: string,
		options: ArtifactReservationOptions,
		audience: ArtifactState["audience"],
	): Promise<string> {
		const reservation = await this.#reserve(toolType, options, audience);
		const expectedBytes = Buffer.byteLength(content);
		try {
			const file = await fs.open(reservation.path, "wx", 0o600);
			try {
				await file.writeFile(content, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			const stat = await fs.stat(reservation.path);
			if (stat.size !== expectedBytes)
				throw new Error(`Artifact write incomplete: wrote ${stat.size} of ${expectedBytes} bytes`);
			return await this.publishReserved(reservation.id);
		} catch (error) {
			const state = await this.#latestState(reservation.id);
			if (state && state.phase !== "published")
				await this.#abandon(state, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	async recover(cursor = 0, limit = ARTIFACT_RECOVERY_BATCH_LIMIT): Promise<ArtifactRecoveryBatch> {
		await this.#ensureDir();
		const ids = (await fs.readdir(this.#stateDir, { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
			.sort();
		const boundedLimit = Math.min(ARTIFACT_RECOVERY_BATCH_LIMIT, Math.max(1, Math.trunc(limit)));
		const end = Math.min(ids.length, Math.max(0, Math.trunc(cursor)) + boundedLimit);
		const published: string[] = [];
		const abandoned: string[] = [];
		const quarantined: string[] = [];
		for (const id of ids.slice(cursor, end)) {
			try {
				const state = await this.#latestState(id);
				if (!state) {
					quarantined.push(id);
					continue;
				}
				if (state.phase === "abandoned") {
					abandoned.push(id);
					continue;
				}
				if (state.phase === "published") {
					if (await this.#getPublishedPath(id, state.audience)) published.push(id);
					else quarantined.push(id);
					continue;
				}
				if (state.phase === "staged" || state.phase === "metadata-published") {
					await this.publishReserved(id);
					published.push(id);
					continue;
				}
				if (state.phase === "reserved") {
					await this.#abandon(state, "recovery-incomplete");
					abandoned.push(id);
				}
			} catch {
				let recoverable: ArtifactState | undefined;
				for (const phase of ["published", "metadata-published", "staged", "reserved"] as const) {
					try {
						recoverable = await this.#readPhase(id, phase);
					} catch {
						continue;
					}
					if (recoverable) break;
				}
				if (recoverable) {
					await this.#abandon(recoverable, "recovery-invalid");
					abandoned.push(id);
				} else {
					quarantined.push(id);
				}
			}
		}
		return {
			processed: end - Math.max(0, Math.trunc(cursor)),
			published,
			abandoned,
			quarantined,
			...(end < ids.length ? { nextCursor: end } : {}),
		};
	}

	async exists(id: string): Promise<boolean> {
		return (await this.getPath(id)) !== null;
	}

	async listFiles(): Promise<string[]> {
		try {
			const ids = (await fs.readdir(this.#stateDir, { withFileTypes: true }))
				.filter(entry => entry.isDirectory())
				.map(entry => entry.name);
			const paths = await Promise.all(ids.map(id => this.getPath(id)));
			return paths
				.filter((filePath): filePath is string => filePath !== null)
				.map(filePath => path.basename(filePath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async getPath(id: string): Promise<string | null> {
		return this.#getPublishedPath(id, "artifact");
	}

	async #getPublishedPath(id: string, audience: ArtifactState["audience"]): Promise<string | null> {
		const state = await this.#readPhase(id, "published");
		if (
			!state ||
			state.audience !== audience ||
			state.bytes === undefined ||
			!state.contentSha256 ||
			!state.metadataSha256
		) {
			return null;
		}
		const expectedMetadataSha256 = artifactSha256(
			stableMetadata({
				id: state.id,
				suffix: state.suffix,
				bytes: state.bytes,
				contentSha256: state.contentSha256,
				provenance: state.provenance,
				scope: state.scope,
				metadataInputSha256: state.metadataInputSha256,
				audience: state.audience,
			}),
		);
		if (expectedMetadataSha256 !== state.metadataSha256) return null;
		const finalPath = path.join(this.#dir, `${state.id}${state.suffix}`);
		try {
			const bytes = new Uint8Array(await fs.readFile(finalPath));
			return bytes.byteLength === state.bytes && artifactSha256(bytes) === state.contentSha256 ? finalPath : null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	#namedIdentity(logicalId: string): string {
		namedArtifactFilename("agent-output", logicalId);
		return artifactSha256(stableMetadata({ kind: "agent-result", logicalId }));
	}

	#namedRecordDir(identitySha256: string): string {
		return path.join(this.#namedStateDir, identitySha256);
	}

	#namedHeadPath(identitySha256: string): string {
		return path.join(this.#namedRecordDir(identitySha256), "head.json");
	}

	#namedClaimPath(identitySha256: string, expectedGenerationId: string | null): string {
		const expectedSha256 = artifactSha256(expectedGenerationId ?? "initial");
		return path.join(this.#namedRecordDir(identitySha256), `claim-${expectedSha256}.json`);
	}

	async #readNamedHead(identitySha256: string): Promise<NamedArtifactHead | null> {
		let serialized: string;
		try {
			serialized = await fs.readFile(this.#namedHeadPath(identitySha256), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(serialized);
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new NamedArtifactUnavailableError("Invalid named artifact head.");
			}
			throw error;
		}
		if (!isNamedArtifactHead(value, identitySha256)) {
			throw new NamedArtifactUnavailableError("Invalid named artifact head.");
		}
		return value;
	}

	async #readNamedClaim(
		identitySha256: string,
		expectedGenerationId: string | null,
	): Promise<NamedArtifactClaim | null> {
		let serialized: string;
		try {
			serialized = await fs.readFile(this.#namedClaimPath(identitySha256, expectedGenerationId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(serialized);
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new NamedArtifactUnavailableError("Invalid named artifact claim.");
			}
			throw error;
		}
		if (!isNamedArtifactClaim(value, identitySha256) || value.expectedGenerationId !== expectedGenerationId) {
			throw new NamedArtifactUnavailableError("Invalid named artifact claim.");
		}
		return value;
	}

	async #writeDurableTemp(directory: string, value: unknown): Promise<string> {
		const tempPath = path.join(directory, `.tmp-${crypto.randomUUID()}`);
		const file = await fs.open(tempPath, "wx", 0o600);
		try {
			await file.writeFile(`${stableMetadata(value)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		return tempPath;
	}

	async #installNamedAlias(sourcePath: string, aliasPath: string): Promise<void> {
		try {
			const [source, alias] = await Promise.all([fs.stat(sourcePath), fs.stat(aliasPath)]);
			if (source.dev === alias.dev && source.ino === alias.ino) return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const tempPath = `${aliasPath}.tmp-${crypto.randomUUID()}`;
		try {
			await fs.link(sourcePath, tempPath);
			await replaceFileAtomically(tempPath, aliasPath);
		} catch (error) {
			await fs.rm(tempPath, { force: true });
			throw error;
		}
	}

	async #installNamedOutputAlias(logicalId: string, head: NamedArtifactHead): Promise<string> {
		const outputSource = await this.#getPublishedPath(head.outputArtifactId, "named");
		if (!outputSource) {
			throw new NamedArtifactUnavailableError(`Named artifact output is unpublished: ${head.generationId}`);
		}
		const outputPath = path.join(this.#dir, namedArtifactFilename("agent-output", logicalId));
		await this.#installNamedAlias(outputSource, outputPath);
		return outputPath;
	}

	async #installNamedAliases(logicalId: string, head: NamedArtifactHead): Promise<AgentArtifactPublication> {
		const outputPath = await this.#installNamedOutputAlias(logicalId, head);

		const sidecarPath = path.join(this.#dir, namedArtifactFilename("agent-sidecar", logicalId));
		if (head.sidecarArtifactId) {
			const sidecarSource = await this.#getPublishedPath(head.sidecarArtifactId, "named");
			if (!sidecarSource) {
				throw new NamedArtifactUnavailableError(`Named artifact sidecar is unpublished: ${head.generationId}`);
			}
			await this.#installNamedAlias(sidecarSource, sidecarPath);
		} else {
			await fs.rm(sidecarPath, { force: true });
		}
		return {
			generationId: head.generationId,
			outputPath,
			...(head.sidecarArtifactId ? { sidecarPath } : {}),
		};
	}

	async #publishNamedHead(identitySha256: string, logicalId: string, head: NamedArtifactHead): Promise<void> {
		await this.#installNamedAliases(logicalId, head);
		const tempPath = await this.#writeDurableTemp(this.#namedRecordDir(identitySha256), head);
		try {
			await replaceFileAtomically(tempPath, this.#namedHeadPath(identitySha256));
		} catch (error) {
			await fs.rm(tempPath, { force: true });
			throw error;
		}
	}

	async #recoverNamedHead(identitySha256: string, logicalId: string): Promise<NamedArtifactHead | null> {
		let head = await this.#readNamedHead(identitySha256);
		for (let depth = 0; depth < 100; depth++) {
			const claim = await this.#readNamedClaim(identitySha256, head?.generationId ?? null);
			if (!claim) return head;
			await this.#publishNamedHead(identitySha256, logicalId, claim);
			head = claim;
		}
		throw new Error("Named artifact recovery exceeded 100 generations.");
	}

	/**
	 * Publish one immutable task-result generation and atomically advance its
	 * logical agent head. Output and optional structured sidecar share the same
	 * head, so a new generation explicitly removes any stale prior sidecar.
	 */
	async publishAgentArtifacts(
		logicalId: string,
		outputContent: string,
		sidecarContent?: string,
		options: AgentArtifactPublishOptions = {},
	): Promise<AgentArtifactPublication> {
		await this.#ensureDir();
		const identitySha256 = this.#namedIdentity(logicalId);
		await fs.mkdir(this.#namedRecordDir(identitySha256), { recursive: true });
		const current = await this.#recoverNamedHead(identitySha256, logicalId);
		const expectedGenerationId =
			options.expectedGenerationId === undefined ? (current?.generationId ?? null) : options.expectedGenerationId;
		if ((current?.generationId ?? null) !== expectedGenerationId) {
			throw new Error(`Named artifact publication collision: ${logicalId}`);
		}
		const reservationOptions: ArtifactReservationOptions = {
			...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
			...(options.scope !== undefined ? { scope: options.scope } : {}),
			...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
		};
		const generationId = crypto.randomUUID();
		const sharedMetadata = {
			...reservationOptions.metadata,
			identitySha256,
			generationId,
		};
		const outputArtifactId = await this.#save(
			outputContent,
			"agent-output",
			{
				...reservationOptions,
				metadata: { ...sharedMetadata, member: "output" },
			},
			"named",
		);
		const sidecarArtifactId =
			sidecarContent === undefined
				? undefined
				: await this.#save(
						sidecarContent,
						"agent-sidecar",
						{
							...reservationOptions,
							metadata: { ...sharedMetadata, member: "sidecar" },
						},
						"named",
					);
		const claim: NamedArtifactClaim = {
			version: 1,
			identitySha256,
			generationId,
			expectedGenerationId,
			outputArtifactId,
			...(sidecarArtifactId ? { sidecarArtifactId } : {}),
		};
		const tempPath = await this.#writeDurableTemp(this.#namedRecordDir(identitySha256), claim);
		try {
			await fs.link(tempPath, this.#namedClaimPath(identitySha256, claim.expectedGenerationId));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				await this.#recoverNamedHead(identitySha256, logicalId);
				throw new Error(`Named artifact publication collision: ${logicalId}`);
			}
			throw error;
		} finally {
			await fs.rm(tempPath, { force: true });
		}
		await this.#publishNamedHead(identitySha256, logicalId, claim);
		return this.#installNamedAliases(logicalId, claim);
	}

	/** Return the current published generation token for explicit CAS updates. */
	async getAgentArtifactGeneration(logicalId: string): Promise<string | null> {
		await this.#ensureDir();
		const identitySha256 = this.#namedIdentity(logicalId);
		return (await this.#recoverNamedHead(identitySha256, logicalId))?.generationId ?? null;
	}
	/** Resolve only the current marker-published task-result generation. */
	async getNamedPath(namespace: NamedArtifactNamespace, logicalId: string): Promise<string | null> {
		await this.#ensureDir();
		const identitySha256 = this.#namedIdentity(logicalId);
		try {
			const head = await this.#recoverNamedHead(identitySha256, logicalId);
			if (!head || (namespace === "agent-sidecar" && !head.sidecarArtifactId)) return null;
			if (namespace === "agent-output") {
				const outputPath = await this.#installNamedOutputAlias(logicalId, head);
				return outputPath;
			}
			return (await this.#installNamedAliases(logicalId, head)).sidecarPath ?? null;
		} catch (error) {
			if (error instanceof NamedArtifactUnavailableError) return null;
			throw error;
		}
	}
}
