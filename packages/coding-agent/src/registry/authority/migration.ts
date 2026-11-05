import { createHash, randomUUID } from "node:crypto";
import { durableFsync } from "./durable-sync";
import { hasPrivateMode } from "./private-mode";
import { directoryFsyncSupported } from "./directory-sync";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeSessionAuthority } from "../authority";
import { FileLock } from "@oh-my-pi/pi-natives";
import {
	canonicalDurableSha256,
	durableBackingSha256,
	repairSessionAuthority,
	validateLegacyAuthorityEntries,
	type DurableJournalRecord,
} from "../durable-state";
import { authorityExportFromLegacy } from "./engine";
import {
	AuthorityReplayState,
	AuthorityScratch,
	digestExportView,
	exportViewOf,
	inMemoryExportView,
	verifyExportReader,
} from "./export-stream";
import type { AuthorityExportView, AuthorityViewDigest } from "./export-stream";
import {
	createJsonlAuthorityFromStream,
	jsonlRotationRecoveryPending,
	openJsonlVerifiedExport,
	recoverJsonlRotation,
} from "./jsonl-driver";
import {
	classifyJsonlArtifact,
	isAuthorityRecoveryFileName,
	jsonlLayout,
	jsonlStoreFiles,
	listAuthorityRecoveryFiles,
	listJsonlRotationArtifacts,
} from "./jsonl-layout";
import { readAuthorityDescriptor, writeAuthorityDescriptor } from "./descriptor";
import type { AuthorityDescriptor } from "./descriptor";
import {
	LEGACY_AUTHORITY_DENIAL_REASON,
	authorityPaths,
	canonicalAuthoritySession,
	inspectAuthorityArtifacts,
	readAuthoritySessionId,
	withAuthorityExclusive,
} from "./ownership";
import { openAuthorityPersistence } from "./persistence";
import {
	openSqliteAuthorityV3Reader,
	SqliteAuthorityConstructionError,
	SqliteAuthorityPersistence,
	sqliteAuthorityPhysicalVersion,
	SqliteAuthorityUnsupportedVersionError,
} from "./sqlite-driver";
import { SQLITE_AUTHORITY_APPLICATION_ID, SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION } from "./sqlite-schema";
import { AuthorityCleanupError, withRetainedAuthorityCleanup } from "./private-cleanup";
import type { AuthorityExclusiveContext } from "./ownership";
import type {
	AuthorityDriverOptions,
	AuthorityExport,
	AuthorityIdentity,
	AuthorityPersistence,
	JournalingBackend,
} from "./types";

const MIGRATION_PREFIX = ".authority.migration.";
const STAGE_PREFIX = ".authority.stage.";
const BACKUP_PREFIX = ".authority.backup.";
const FAULT_POINTS = [
	"manifest-created",
	"backup-synced",
	"source-frozen",
	"target-staged",
	"target-verified",
	"legacy-source-denied",
	"legacy-fenced",
	"target-publishing",
	"target-published-main",
	"target-published-wal",
	"target-published-shm",
	"target-published",
	"before-descriptor-publication",
	"descriptor-published",
	"migration-ready",
	"manifest-finalized",
] as const;
const O_NOFOLLOW = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;

export type AuthorityMigrationFaultPoint = (typeof FAULT_POINTS)[number];
export interface AuthorityMigrationResult {
	readonly status: "dry-run" | "migrated" | "recovered" | "already-selected";
	readonly sourceBackend: "legacy-v1" | JournalingBackend;
	readonly targetBackend: JournalingBackend;
	readonly backupDirectory?: string;
}
export interface AuthorityMigrationOptions {
	readonly apply?: boolean;
	readonly faultAt?: AuthorityMigrationFaultPoint;
}
export interface AuthorityRepairResult {
	readonly status: "clean" | "repairable" | "repaired";
	readonly journalPath: string;
	readonly affectedActorIds: readonly string[];
	readonly backupDirectory?: string;
	/** Tail recovery files beside the root: reported for the operator, never part of the diagnosis. */
	readonly recoveryFiles: readonly string[];
}

interface MigrationFile {
	readonly name: string;
	readonly digest: string;
}
interface LegacyDenialProvenance {
	readonly name: string;
	readonly migrationId: string;
	readonly sourceDigest: string;
	readonly bytes: string;
	readonly digest: string;
}

interface MigrationManifest {
	readonly version: 1;
	readonly id: string;
	readonly owningSessionId: string;
	readonly sourceBackend: "legacy-v1" | JournalingBackend;
	readonly targetBackend: JournalingBackend;
	readonly phase:
		| "started"
		| "backed-up"
		| "source-frozen"
		| "target-staged"
		| "target-verified"
		| "legacy-fenced"
		| "target-publishing"
		| "target-published"
		| "before-descriptor-publication"
		| "descriptor-published"
		| "ready"
		| "aborted";
	readonly sourceIdentity?: AuthorityIdentity;
	readonly targetIdentity: AuthorityIdentity;
	readonly sourceFiles: readonly MigrationFile[];
	readonly backupName: string;
	readonly stageName: string;
	readonly sourceDescriptor?: AuthorityDescriptor;
	readonly targetSemanticSha256?: string;
	readonly targetFiles?: readonly MigrationFile[];
	readonly createdLegacyFence: boolean;
	readonly legacyDenial?: LegacyDenialProvenance;
}

type MigrationSourceContext = Pick<AuthorityExclusiveContext, "sessionFile" | "owningSessionId" | "paths">;

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function mergeTargetFiles(
	existing: readonly MigrationFile[] | undefined,
	added: readonly MigrationFile[],
): MigrationFile[] {
	const files = new Map<string, MigrationFile>();
	for (const file of [...(existing ?? []), ...added]) files.set(`${file.name}\0${file.digest}`, file);
	return [...files.values()].sort((left, right) =>
		left.name < right.name
			? -1
			: left.name > right.name
				? 1
				: left.digest < right.digest
					? -1
					: left.digest > right.digest
						? 1
						: 0,
	);
}

function fault(options: AuthorityMigrationOptions, point: AuthorityMigrationFaultPoint): void {
	if (options.faultAt === point) throw new Error(`Injected migration fault at ${point}.`);
}

function authorityIdentity(
	backend: JournalingBackend,
	owningSessionId: string,
	incarnation = randomUUID(),
): AuthorityIdentity {
	return { backend, owningSessionId, incarnation, format: 2 };
}

function payloadPath(context: AuthorityExclusiveContext, backend: JournalingBackend): string {
	return backend === "sqlite" ? context.paths.sqlite : context.paths.jsonl;
}

/** Rotation files (sealed segments, indexes, snapshot) of a JSONL target that `manifest` staged, by basename. */
function targetRotationNames(context: AuthorityExclusiveContext, manifest: MigrationManifest): string[] {
	if (manifest.targetBackend !== "jsonl") return [];
	const layout = jsonlLayout(context.paths.jsonl);
	return [...new Set((manifest.targetFiles ?? []).map(file => file.name))]
		.filter(name => {
			const artifact = classifyJsonlArtifact(layout, name);
			return artifact !== undefined && artifact.kind !== "temporary";
		})
		.sort();
}

/** Basenames a migration's target owns once published: its payload, SQLite sidecars, and staged JSONL rotation files. */
function targetMemberNames(context: AuthorityExclusiveContext, manifest: MigrationManifest): Set<string> {
	const payload = payloadPath(context, manifest.targetBackend);
	return new Set([
		path.basename(payload),
		path.basename(`${payload}-wal`),
		path.basename(`${payload}-shm`),
		...targetRotationNames(context, manifest),
	]);
}

function identityFromDescriptor(descriptor: AuthorityDescriptor): AuthorityIdentity {
	return {
		backend: descriptor.backend,
		owningSessionId: descriptor.owningSessionId,
		incarnation: descriptor.incarnation,
		format: 2,
	};
}

async function readOptional(file: string): Promise<Buffer | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	return withPrivateFileHandle(handle, "Authority migration artifact read and handle close failed.", async () => {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`Authority migration artifact is not a regular file: ${file}`);
		const bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		const current = await fs.lstat(file, { bigint: true });
		if (
			!current.isFile() ||
			before.nlink !== 1n ||
			current.nlink !== 1n ||
			!hasPrivateMode(before.mode) ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.dev !== current.dev ||
			before.ino !== current.ino ||
			before.size !== current.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs
		)
			throw new Error(`Authority migration artifact changed while it was read: ${file}`);
		return bytes;
	});
}

const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * readOptional's checks around a streaming read: a private, single-link regular file (never followed through a
 * symlink) whose identity, size and timestamps do not change while `read` walks it. Undefined when it is absent.
 */
async function withStableFile<T>(
	file: string,
	read: (handle: fs.FileHandle, size: number) => Promise<T>,
): Promise<T | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	return withPrivateFileHandle(handle, "Authority migration artifact read and handle close failed.", async () => {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new Error(`Authority migration artifact is not a regular file: ${file}`);
		const result = await read(handle, Number(before.size));
		const after = await handle.stat({ bigint: true });
		const current = await fs.lstat(file, { bigint: true });
		if (
			!current.isFile() ||
			before.nlink !== 1n ||
			current.nlink !== 1n ||
			!hasPrivateMode(before.mode) ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.dev !== current.dev ||
			before.ino !== current.ino ||
			before.size !== current.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs
		)
			throw new Error(`Authority migration artifact changed while it was read: ${file}`);
		return result;
	});
}

/** Reads `size` bytes of `handle` in bounded chunks. */
async function forEachChunk(
	handle: fs.FileHandle,
	size: number,
	onChunk: (chunk: Buffer) => Promise<void> | void,
): Promise<void> {
	const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(STREAM_CHUNK_BYTES, size)));
	for (let position = 0; position < size;) {
		const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
		if (bytesRead <= 0) throw new Error("Authority migration artifact ended before its observed size.");
		await onChunk(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
}

/** SHA-256 of an artifact under readOptional's stability checks, streamed; undefined when absent. */
async function digestOptional(file: string): Promise<string | undefined> {
	return withStableFile(file, async (handle, size) => {
		const hash = createHash("sha256");
		await forEachChunk(handle, size, chunk => {
			hash.update(chunk);
		});
		return hash.digest("hex");
	});
}

/** Whether an artifact exists, with readOptional's checks (regular, private, single link, not a symlink) and no read. */
async function artifactPresent(file: string): Promise<boolean> {
	return (await withStableFile(file, async () => true)) === true;
}

/**
 * Copies a stable artifact into a new private file (writePrivate: exclusive create, fsync) without holding it,
 * and returns the SHA-256 of the copied bytes; undefined when the source is absent.
 */
async function copyPrivate(source: string, destination: string): Promise<string | undefined> {
	return withStableFile(source, async (input, size) => {
		const output = await fs.open(
			destination,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
			0o600,
		);
		return withPrivateFileHandle(output, "Private authority write and handle close failed.", async () => {
			const hash = createHash("sha256");
			let written = 0;
			await forEachChunk(input, size, async chunk => {
				hash.update(chunk);
				for (let offset = 0; offset < chunk.length;) {
					const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, written + offset);
					offset += bytesWritten;
				}
				written += chunk.length;
			});
			await durableFsync(output);
			return hash.digest("hex");
		});
	});
}

/** writePrivateAtomically from a stable source artifact, streamed; the copy must hold `expectedDigest`. */
async function copyPrivateAtomically(source: string, destination: string, expectedDigest: string): Promise<void> {
	const directory = path.dirname(destination);
	const temporary = path.join(directory, `.${path.basename(destination)}.tmp-${randomUUID()}`);
	try {
		const copied = await copyPrivate(source, temporary);
		if (copied !== expectedDigest)
			throw new Error(`Authority artifact changed while it was preserved: ${path.basename(source)}`);
		await fs.rename(temporary, destination);
		await syncDirectory(directory);
	} catch (error) {
		if (error instanceof AuthorityCleanupError && error.pending) {
			error.afterCleanup(() => fs.rm(temporary, { force: true }));
			throw error;
		}
		try {
			await fs.rm(temporary, { force: true });
		} catch (cleanupError) {
			throw new AuthorityCleanupError(
				[error, cleanupError],
				"Atomic private copy and temporary-file removal failed.",
				async () => {
					await fs.rm(temporary, { force: true });
				},
			);
		}
		throw error;
	}
}

function isFsError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function withPrivateFileHandle<T>(handle: fs.FileHandle, message: string, run: () => Promise<T>): Promise<T> {
	let result!: T;
	let operationError: unknown;
	let operationFailed = false;
	try {
		result = await run();
	} catch (error) {
		operationFailed = true;
		operationError = error;
	}
	try {
		await handle.close();
	} catch (closeError) {
		throw new AuthorityCleanupError(
			operationFailed ? [operationError, closeError] : [closeError],
			message,
			async () => {
				await handle.close();
			},
		);
	}
	if (operationFailed) throw operationError;
	return result;
}

async function syncDirectory(directory: string): Promise<void> {
	if (!directoryFsyncSupported()) return;
	const handle = await fs.open(directory, fs.constants.O_RDONLY);
	await withPrivateFileHandle(handle, "Authority directory sync and handle close failed.", () => durableFsync(handle));
}

async function writePrivateAtomically(file: string, data: Uint8Array): Promise<void> {
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.${path.basename(file)}.tmp-${randomUUID()}`);
	try {
		const handle = await fs.open(
			temporary,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
			0o600,
		);
		await withPrivateFileHandle(handle, "Atomic private write and handle close failed.", async () => {
			await handle.writeFile(data);
			await durableFsync(handle);
		});
		await fs.rename(temporary, file);
		await syncDirectory(directory);
	} catch (error) {
		if (error instanceof AuthorityCleanupError && error.pending) {
			error.afterCleanup(() => fs.rm(temporary, { force: true }));
			throw error;
		}
		try {
			await fs.rm(temporary, { force: true });
		} catch (cleanupError) {
			throw new AuthorityCleanupError(
				[error, cleanupError],
				"Atomic private write and temporary-file removal failed.",
				async () => {
					await fs.rm(temporary, { force: true });
				},
			);
		}
		throw error;
	}
}

async function writeManifest(context: AuthorityExclusiveContext, manifest: MigrationManifest): Promise<void> {
	const destination = path.join(
		path.dirname(context.sessionFile),
		`${path.basename(context.sessionFile)}${MIGRATION_PREFIX}${manifest.id}.json`,
	);
	await writePrivateAtomically(destination, Buffer.from(`${JSON.stringify(manifest)}\n`));
}

function migrationNames(sessionFile: string, id: string): { manifest: string; stage: string; backup: string } {
	const parent = path.dirname(sessionFile);
	const base = path.basename(sessionFile);
	return {
		manifest: path.join(parent, `${base}${MIGRATION_PREFIX}${id}.json`),
		stage: path.join(parent, `${base}${STAGE_PREFIX}${id}`),
		backup: path.join(parent, `${base}${BACKUP_PREFIX}${id}`),
	};
}

async function validatePrivateDirectory(directory: string, label: string, optional = false): Promise<boolean> {
	for (let ancestor = path.dirname(directory); ; ancestor = path.dirname(ancestor)) {
		const ancestorStat = await fs.lstat(ancestor);
		if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
			throw new Error(`Authority ${label} ancestry contains a non-directory or symbolic link: ${ancestor}`);
		}
		if (ancestor === path.dirname(ancestor)) break;
	}
	const stat = await fs.lstat(directory).catch(error => {
		if (optional && isFsError(error, "ENOENT")) return undefined;
		throw error;
	});
	if (!stat) return false;
	if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateMode(stat.mode)) {
		throw new Error(`Authority ${label} must be a private non-symlink directory: ${directory}`);
	}
	return true;
}

async function validateMigrationDirectories(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
): Promise<void> {
	const names = migrationNames(context.sessionFile, manifest.id);
	const parent = path.dirname(context.sessionFile);
	if (
		manifest.owningSessionId !== context.owningSessionId ||
		manifest.backupName !== path.basename(names.backup) ||
		manifest.stageName !== path.basename(names.stage) ||
		path.dirname(names.backup) !== parent ||
		path.dirname(names.stage) !== parent
	)
		throw new Error("Migration staging and backup directories do not match the canonical owning-session siblings.");
	await validatePrivateDirectory(names.backup, "migration backup", true);
	await validatePrivateDirectory(names.stage, "migration staging", true);
}

/** Every present authority artifact of the session, by basename, with the SHA-256 of its bytes (streamed). */
async function sourceArtifacts(
	context: MigrationSourceContext,
): Promise<Array<{ name: string; file: string; digest: string }>> {
	const files = [
		context.paths.descriptor,
		context.paths.sqlite,
		`${context.paths.sqlite}-wal`,
		`${context.paths.sqlite}-shm`,
		...jsonlStoreFiles(context.paths.jsonl),
		context.paths.legacy,
		context.paths.legacyFence,
		context.paths.lock,
	];
	const result: Array<{ name: string; file: string; digest: string }> = [];
	for (const file of files) {
		const fileDigest = await digestOptional(file);
		if (fileDigest !== undefined) result.push({ name: path.basename(file), file, digest: fileDigest });
	}
	return result;
}

async function withLegacyJournalExclusion<T>(context: AuthorityExclusiveContext, run: () => Promise<T>): Promise<T> {
	if (!(await artifactPresent(context.paths.legacy))) return run();
	const lock = FileLock.tryAcquire(context.paths.legacy);
	if (!lock.acquired) throw new Error("Cannot migrate while a legacy journal writer holds its file lock.");
	return withRetainedAuthorityCleanup(run, async () => {
		lock.release();
	});
}

async function backupArtifacts(context: AuthorityExclusiveContext, directory: string): Promise<MigrationFile[]> {
	const files = await sourceArtifacts(context);
	const exists = await validatePrivateDirectory(directory, "migration backup", true);
	if (!exists) {
		await fs.mkdir(directory, { mode: 0o700 });
		await syncDirectory(path.dirname(directory));
	}
	const expectedNames = new Set(files.map(file => file.name));
	for (const name of await fs.readdir(directory)) {
		if (!expectedNames.has(name)) throw new Error(`Unexpected file in migration backup directory: ${name}`);
	}
	const metadata: MigrationFile[] = [];
	for (const file of files) {
		const destination = path.join(directory, file.name);
		const previous = await digestOptional(destination);
		if (previous !== undefined) {
			if (previous !== file.digest) throw new Error(`Migration backup changed during capture: ${file.name}`);
		} else if ((await copyPrivate(file.file, destination)) !== file.digest) {
			throw new Error(`Migration backup changed during capture: ${file.name}`);
		}
		metadata.push({ name: file.name, digest: file.digest });
	}
	await syncDirectory(directory);
	return metadata;
}

async function readLegacyExport(
	context: MigrationSourceContext,
	identity: AuthorityIdentity,
	journalPath = context.paths.legacy,
): Promise<AuthorityExport> {
	const bytes = await readOptional(journalPath);
	if (!bytes) throw new Error(`No legacy authority journal exists for ${context.sessionFile}.`);
	const text = bytes.toString("utf8");
	if (!text.endsWith("\n")) throw new Error("Durable journal ends with a partial record.");
	let entries: DurableJournalRecord[];
	try {
		entries = text
			? text
					.slice(0, -1)
					.split("\n")
					.map(line => JSON.parse(line) as DurableJournalRecord)
			: [];
	} catch {
		throw new Error("Legacy authority journal contains an invalid JSON record.");
	}
	const imported = validateLegacyAuthorityEntries(durableBackingSha256(bytes), entries);
	return authorityExportFromLegacy(identity, imported);
}

async function readLegacyBackupExport(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
): Promise<AuthorityExport> {
	await verifyBackupFiles(context, manifest);
	const names = migrationNames(context.sessionFile, manifest.id);
	const journalName = path.basename(context.paths.legacy);
	const journal = await readOptional(path.join(names.backup, journalName));
	const expected = manifest.sourceFiles.find(file => file.name === journalName);
	if (!journal || !expected || digest(journal) !== expected.digest) {
		throw new Error("The exact legacy source backup is missing or has changed; migration cannot finish safely.");
	}
	return readLegacyExport(
		context,
		authorityIdentity("jsonl", context.owningSessionId),
		path.join(names.backup, journalName),
	);
}

async function verifyBackupFiles(context: AuthorityExclusiveContext, manifest: MigrationManifest): Promise<void> {
	const names = migrationNames(context.sessionFile, manifest.id);
	await validateMigrationDirectories(context, manifest);
	for (const file of manifest.sourceFiles) {
		if ((await digestOptional(path.join(names.backup, file.name))) !== file.digest)
			throw new Error(`Authority migration backup changed: ${file.name}`);
	}
}

export function legacyDenialBytes(migrationId: string): Buffer {
	const emptyHash = "0".repeat(64);
	return Buffer.from(
		`${JSON.stringify({
			version: 2,
			sequence: 1,
			previousHash: emptyHash,
			contentHash: emptyHash,
			record: { kind: "authority-denial", migrationId, reason: LEGACY_AUTHORITY_DENIAL_REASON },
			hash: emptyHash,
		})}\n`,
	);
}

function legacyDenialProvenance(context: MigrationSourceContext, manifest: MigrationManifest): LegacyDenialProvenance {
	const name = path.basename(context.paths.legacy);
	const source = manifest.sourceFiles.find(file => file.name === name);
	if (!source) throw new Error("The captured legacy journal is missing from migration source provenance.");
	const bytes = legacyDenialBytes(manifest.id);
	return {
		name,
		migrationId: manifest.id,
		sourceDigest: source.digest,
		bytes: bytes.toString("base64"),
		digest: digest(bytes),
	};
}

/**
 * Runs `use` with the verified export of the captured source backup (a legacy journal is read whole; a v2 payload
 * is inspected through a disposable copy and streamed).
 */
async function withSourceBackupView<T>(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
	use: (view: AuthorityExportView) => Promise<T> | T,
): Promise<T> {
	await verifyBackupFiles(context, manifest);
	if (manifest.sourceBackend === "legacy-v1")
		return use(inMemoryExportView(await readLegacyBackupExport(context, manifest)));
	if (!manifest.sourceIdentity || !manifest.sourceDescriptor)
		throw new Error("Migration manifest is missing its captured source identity.");
	const names = migrationNames(context.sessionFile, manifest.id);
	const backupPath = path.join(names.backup, path.basename(payloadPath(context, manifest.sourceBackend)));
	return withExportCopy(
		context,
		backupPath,
		manifest.sourceIdentity,
		() => verifyBackupFiles(context, manifest),
		false,
		true,
		use,
	);
}

async function readSourceBackupExport(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
): Promise<InspectedAuthority> {
	return withSourceBackupView(context, manifest, view => digestExportView(view));
}

async function ensureMigrationDenial(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
): Promise<MigrationManifest> {
	if (manifest.sourceBackend === "legacy-v1" && !manifest.legacyDenial) {
		manifest = { ...manifest, legacyDenial: legacyDenialProvenance(context, manifest) };
		await writeManifest(context, manifest);
	}
	const existingFence = await readOptional(context.paths.legacyFence);
	if (existingFence && existingFence.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON) {
		throw new Error("The legacy denial marker is not canonical; refusing migration.");
	}
	if (!existingFence) {
		manifest = { ...manifest, createdLegacyFence: true };
		await writeManifest(context, manifest);
		await writePrivateAtomically(context.paths.legacyFence, Buffer.from(LEGACY_AUTHORITY_DENIAL_REASON));
	}
	if (manifest.sourceBackend === "legacy-v1") {
		const denial = manifest.legacyDenial;
		if (!denial) throw new Error("Migration is missing its legacy source denial provenance.");
		const sourceDigest = await digestOptional(context.paths.legacy);
		if (sourceDigest === undefined) throw new Error("The captured legacy source disappeared during migration.");
		const sourceFile = manifest.sourceFiles.find(file => file.name === denial.name);
		if (!sourceFile || sourceFile.digest !== denial.sourceDigest)
			throw new Error("The captured legacy source backup does not match denial provenance.");
		if (sourceDigest === sourceFile.digest) {
			await writePrivateAtomically(context.paths.legacy, Buffer.from(denial.bytes, "base64"));
		} else if (sourceDigest !== denial.digest) {
			throw new Error("The legacy source is neither the captured journal nor this migration's denial record.");
		}
		if ((await digestOptional(context.paths.legacy)) !== denial.digest)
			throw new Error("The legacy denial record failed its durable readback.");
	}
	return manifest;
}

async function verifyMigrationDenial(context: AuthorityExclusiveContext, manifest: MigrationManifest): Promise<void> {
	const marker = await readOptional(context.paths.legacyFence);
	if (!marker || marker.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON) {
		throw new Error("The permanent legacy denial fence is missing or changed.");
	}
	if (manifest.sourceBackend === "legacy-v1") {
		const denial = manifest.legacyDenial;
		const sourceDigest = await digestOptional(context.paths.legacy);
		if (!denial || sourceDigest === undefined || sourceDigest !== denial.digest) {
			throw new Error("The legacy source denial record is missing or changed.");
		}
	}
}

/** What an inspection proves about an export: its semantic fingerprint and its unresolved effects and claims. */
type InspectedAuthority = AuthorityViewDigest;

/** The inspection result of an export held in memory (a legacy v1 journal, read whole). */
function inspectedOf(exported: AuthorityExport): InspectedAuthority {
	return digestExportView(inMemoryExportView(exported));
}

/**
 * Opens the store at `file` for an offline inspection: open() and integrityCheck() in bounded memory, followed by
 * the full logical verification, and returns its export view. `legacySqliteSource` admits a physical-schema-v3
 * SQLite store (read by the conversion-only v3 reader). The scratch file lives in `directory`. Only a `disposable`
 * copy may be settled as an owner's open would settle it.
 */
function openVerifiedExport(
	file: string,
	identity: AuthorityIdentity,
	legacySqliteSource: boolean,
	directory: string,
	refusalPath: string,
	disposable = true,
): { readonly view: AuthorityExportView; close(): void } {
	// A refusal names the real payload (and so the session to repair or convert), never this disposable copy.
	if (identity.backend === "jsonl") return openJsonlVerifiedExport(file, identity, directory, disposable, refusalPath);
	const legacyCopy = sqliteAuthorityPhysicalVersion(file) === SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION;
	if (legacyCopy && !legacySqliteSource)
		throw new SqliteAuthorityUnsupportedVersionError(
			refusalPath,
			SQLITE_AUTHORITY_APPLICATION_ID,
			SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION,
		);
	if (legacyCopy) {
		const scratch = new AuthorityScratch(directory);
		try {
			const opened = openSqliteAuthorityV3Reader(file, identity, scratch);
			try {
				const state = new AuthorityReplayState(scratch);
				verifyExportReader(opened.reader, state, identity);
				return {
					view: exportViewOf(opened.reader, state.receipts),
					close: () => {
						try {
							opened.close();
						} finally {
							scratch.close();
						}
					},
				};
			} catch (error) {
				opened.close();
				throw error;
			}
		} catch (error) {
			scratch.close();
			throw error;
		}
	}
	// The same open, integrityCheck() and close() an in-memory inspection ran; the offline driver verifies in bounded
	// memory (its replay state in a scratch file under `directory`, removed by close()) and keeps the verified view.
	let driver: AuthorityPersistence;
	try {
		driver = openAuthorityPersistence({
			path: file,
			identity,
			create: false,
			offlineInspection: { scratchDirectory: directory },
		});
	} catch (error) {
		if (error instanceof SqliteAuthorityConstructionError)
			throw new AuthorityCleanupError(
				error.errors,
				"SQLite authority construction cleanup is pending.",
				async () => {
					error.cleanup();
				},
			);
		throw error;
	}
	try {
		driver.integrityCheck();
		if (!driver.offlineExportView) throw new Error("Authority offline inspection driver has no export view.");
		return { view: driver.offlineExportView(), close: () => driver.close() };
	} catch (error) {
		try {
			driver.close();
		} catch (cleanupError) {
			throw new AuthorityCleanupError(
				[error, cleanupError],
				"Authority export inspection and driver close failed.",
				async () => {
					driver.close();
				},
			);
		}
		throw error;
	}
}

async function verifyBackupSnapshot(context: AuthorityExclusiveContext, manifest: MigrationManifest): Promise<void> {
	await validateMigrationDirectories(context, manifest);
	const actual = await sourceArtifacts(context);
	const observed = new Map(actual.map(file => [file.name, file.digest]));
	const targetNames = targetMemberNames(context, manifest);
	const targetMayBePublished = [
		"target-publishing",
		"target-published",
		"before-descriptor-publication",
		"descriptor-published",
		"ready",
		"aborted",
	].includes(manifest.phase);
	const permittedNames = new Set(manifest.sourceFiles.map(file => file.name));
	if (targetMayBePublished) for (const name of targetNames) permittedNames.add(name);
	if (["descriptor-published", "ready"].includes(manifest.phase))
		permittedNames.add(path.basename(context.paths.descriptor));
	for (const name of observed.keys())
		if (!permittedNames.has(name))
			throw new Error(`Unexpected authority artifact appeared during backup verification: ${name}`);
	const descriptorName = path.basename(context.paths.descriptor);
	const descriptor = await readAuthorityDescriptor(context.sessionFile);
	const frozenByThisMigration =
		manifest.sourceDescriptor !== undefined &&
		descriptor?.state === "migration" &&
		descriptor.migrationId === manifest.id;
	if (manifest.sourceDescriptor && (!descriptor || (!frozenByThisMigration && descriptor.state !== "active"))) {
		throw new Error("The selected source descriptor changed while the migration backup was being verified.");
	}
	for (const file of manifest.sourceFiles) {
		if (
			(await digestOptional(path.join(migrationNames(context.sessionFile, manifest.id).backup, file.name))) !==
			file.digest
		)
			throw new Error(`Authority migration backup changed: ${file.name}`);
		if (file.name === descriptorName && frozenByThisMigration) continue;
		if (targetMayBePublished && targetNames.has(file.name)) continue;
		if (observed.get(file.name) !== file.digest)
			throw new Error(`Authority migration source changed after backup: ${file.name}`);
	}
}

async function verifySourceFiles(context: AuthorityExclusiveContext, manifest: MigrationManifest): Promise<void> {
	await validateMigrationDirectories(context, manifest);
	const currentDescriptor = await readAuthorityDescriptor(context.sessionFile);
	if (manifest.sourceDescriptor) {
		if (
			!currentDescriptor ||
			currentDescriptor.state !== "migration" ||
			currentDescriptor.migrationId !== manifest.id ||
			currentDescriptor.backend !== manifest.sourceDescriptor.backend ||
			currentDescriptor.incarnation !== manifest.sourceDescriptor.incarnation
		)
			throw new Error("The selected source descriptor changed during migration.");
	} else if (currentDescriptor) {
		throw new Error("A descriptor appeared while upgrading the legacy authority journal.");
	}
	const descriptorName = path.basename(context.paths.descriptor);
	const replacedTargetNames = targetMemberNames(context, manifest);
	const names = new Map((await sourceArtifacts(context)).map(file => [file.name, file.digest]));
	const expectedNames = new Set(manifest.sourceFiles.map(file => file.name));
	const fence = await readOptional(context.paths.legacyFence);
	if (fence?.toString("utf8") === LEGACY_AUTHORITY_DENIAL_REASON)
		expectedNames.add(path.basename(context.paths.legacyFence));
	const targetMayBePublished = [
		"target-publishing",
		"target-published",
		"before-descriptor-publication",
		"descriptor-published",
		"ready",
	].includes(manifest.phase);
	if (targetMayBePublished) for (const name of replacedTargetNames) expectedNames.add(name);
	for (const name of names.keys()) {
		if (!expectedNames.has(name)) throw new Error(`Unexpected authority artifact appeared during migration: ${name}`);
	}
	for (const file of manifest.sourceFiles) {
		if (
			file.name === descriptorName ||
			((manifest.phase === "target-publishing" ||
				manifest.phase === "target-published" ||
				manifest.phase === "before-descriptor-publication" ||
				manifest.phase === "descriptor-published" ||
				manifest.phase === "ready") &&
				replacedTargetNames.has(file.name))
		)
			continue;
		const observedDigest = names.get(file.name);
		if (
			file.name === path.basename(context.paths.legacy) &&
			manifest.legacyDenial &&
			observedDigest === manifest.legacyDenial.digest
		)
			continue;
		if (observedDigest !== file.digest)
			throw new Error(`Authority migration source changed after capture: ${file.name}`);
	}
}

async function syncPrivateFile(file: string): Promise<void> {
	const handle = await fs.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	let operationError: unknown;
	let operationFailed = false;
	try {
		await durableFsync(handle);
	} catch (error) {
		operationFailed = true;
		operationError = error;
	}
	try {
		await handle.close();
	} catch (closeError) {
		throw new AuthorityCleanupError(
			operationFailed ? [operationError, closeError] : [closeError],
			"Private authority file sync or handle close failed.",
			async () => {
				await handle.close();
			},
		);
	}
	if (operationFailed) throw operationError;
}

/**
 * Stages the target from the verified source backup, streamed into the target writer (the bytes an in-memory seed
 * import writes), then inspects the staged store in full: its semantic fingerprint must equal the source's.
 */
async function createTarget(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
	expectedSemanticSha256: string,
): Promise<{ semanticSha256: string; files: MigrationFile[] }> {
	const names = migrationNames(context.sessionFile, manifest.id);
	await validateMigrationDirectories(context, manifest);
	await fs.rm(names.stage, { recursive: true, force: true });
	await fs.mkdir(names.stage, { mode: 0o700 });
	const options: AuthorityDriverOptions = {
		path: path.join(names.stage, path.basename(payloadPath(context, manifest.targetBackend))),
		identity: manifest.targetIdentity,
		create: true,
	};
	await withSourceBackupView(context, manifest, view => {
		const seed = { owningSessionId: context.owningSessionId, view };
		if (manifest.targetBackend === "jsonl") {
			createJsonlAuthorityFromStream(options, seed);
			return;
		}
		let driver: SqliteAuthorityPersistence;
		try {
			driver = new SqliteAuthorityPersistence(options, seed);
		} catch (error) {
			if (error instanceof SqliteAuthorityConstructionError)
				throw new AuthorityCleanupError(
					error.errors,
					"SQLite staged authority construction cleanup is pending.",
					async () => {
						error.cleanup();
					},
				);
			throw error;
		}
		try {
			driver.close();
		} catch (closeError) {
			throw new AuthorityCleanupError(
				[closeError],
				"Staged authority inspection or driver close failed.",
				async () => {
					driver.close();
				},
			);
		}
	});
	const targetHash = await inspectInPlace(context, options.path, manifest.targetIdentity);
	if (targetHash !== expectedSemanticSha256)
		throw new Error("Staged authority failed complete semantic export verification.");
	const targetFiles: MigrationFile[] = [];
	// A long history converts to JSONL already rotated: its sealed segment, index and snapshot are target files too.
	const stagedFiles =
		manifest.targetBackend === "jsonl"
			? jsonlStoreFiles(options.path)
			: ["", "-wal", "-shm"].map(suffix => `${options.path}${suffix}`);
	for (const file of stagedFiles) {
		const fileDigest = await digestOptional(file);
		if (fileDigest === undefined) continue;
		await syncPrivateFile(file);
		targetFiles.push({ name: path.basename(file), digest: fileDigest });
	}
	await syncDirectory(names.stage);
	return { semanticSha256: targetHash, files: targetFiles };
}

/** Inspects a store where it lies (a freshly staged target), with its scratch file in a disposable directory. */
async function inspectInPlace(
	context: AuthorityExclusiveContext,
	file: string,
	identity: AuthorityIdentity,
): Promise<string> {
	const directory = await fs.mkdtemp(path.join(path.dirname(context.sessionFile), ".authority-inspection-"));
	let semanticSha256: string;
	try {
		const opened = openVerifiedExport(file, identity, false, directory, file, false);
		try {
			semanticSha256 = digestExportView(opened.view).semanticSha256;
		} finally {
			opened.close();
		}
	} catch (error) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AuthorityCleanupError(
				[error, cleanupError],
				"Staged authority inspection and scratch cleanup failed.",
				async () => {
					await fs.rm(directory, { recursive: true, force: true });
				},
			);
		}
		throw error;
	}
	try {
		await fs.rm(directory, { recursive: true, force: true });
	} catch (error) {
		throw new AuthorityCleanupError([error], "Staged authority inspection scratch removal failed.", async () => {
			await fs.rm(directory, { recursive: true, force: true });
		});
	}
	return semanticSha256;
}

class InvalidTargetInspectionError extends Error {
	constructor(cause: unknown) {
		super("Target authority inspection failed.", { cause });
	}
}

/**
 * Inspects a private copy of an authority payload and returns its semantic fingerprint and unresolved effects.
 * `legacySqliteSource` admits a physical-schema-v3 SQLite source (read by the conversion-only v3 reader); every
 * target, active-selection and repair inspection stays current-schema only.
 */
async function inspectExportCopy(
	context: AuthorityExclusiveContext,
	source: string,
	identity: AuthorityIdentity,
	validateCapture: () => Promise<void>,
	classifyInvalidTarget = false,
	legacySqliteSource = false,
): Promise<InspectedAuthority> {
	return withExportCopy(
		context,
		source,
		identity,
		validateCapture,
		classifyInvalidTarget,
		legacySqliteSource,
		view => digestExportView(view),
		classifyInvalidTarget,
	);
}

/**
 * Copies an authority payload (and its sidecars or rotation files) into a disposable private directory, streamed,
 * proves the originals did not change, opens and verifies the copy in bounded memory, and runs `use` with its
 * export view before the copy is removed. With `classifyInvalidTarget`, a store that cannot be opened or verified
 * is reported as InvalidTargetInspectionError (and so is a failure of `use` when `classifyUse`).
 */
async function withExportCopy<T>(
	context: AuthorityExclusiveContext,
	source: string,
	identity: AuthorityIdentity,
	validateCapture: () => Promise<void>,
	classifyInvalidTarget: boolean,
	legacySqliteSource: boolean,
	use: (view: AuthorityExportView) => Promise<T> | T,
	classifyUse = false,
): Promise<T> {
	// A rotated JSONL store is its payload plus its sealed segments, indexes and snapshot, copied under the same names.
	const files =
		identity.backend === "sqlite"
			? ["", "-wal", "-shm"].map(suffix => `${source}${suffix}`)
			: jsonlStoreFiles(source);
	const directory = await fs.mkdtemp(path.join(path.dirname(context.sessionFile), ".authority-inspection-"));
	let result!: T;
	try {
		// Every member is captured concurrently (each streamed into the private copy); a failed capture's pending
		// handle-close owner is composed with every other one, so no capture cleanup is dropped.
		const captureResults = await Promise.allSettled(
			files.map(file => copyPrivate(file, path.join(directory, path.basename(file)))),
		);
		const captureFailures = captureResults.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (captureFailures.length) {
			const pendingOwners = captureFailures.filter(
				(error): error is AuthorityCleanupError => error instanceof AuthorityCleanupError && error.pending,
			);
			if (!pendingOwners.length) {
				if (captureFailures.length === 1) throw captureFailures[0];
				throw new AggregateError(captureFailures, "Authority inspection source capture failed.");
			}
			if (captureFailures.length === 1 && pendingOwners.length === 1) throw pendingOwners[0];
			const errors = captureFailures.flatMap(error =>
				error instanceof AuthorityCleanupError ? [...error.errors] : [error],
			);
			const retry = async (owner: AuthorityCleanupError): Promise<void> => {
				try {
					await owner.cleanup();
				} catch (cleanupError) {
					throw owner.errors[owner.errors.length - 1] ?? cleanupError;
				}
			};
			const combined = new AuthorityCleanupError(errors, "Authority SQLite source capture cleanup is pending.", () =>
				retry(pendingOwners[0]!),
			);
			for (const owner of pendingOwners.slice(1)) combined.afterCleanup(() => retry(owner));
			throw combined;
		}
		const captured = captureResults.map(result => (result.status === "fulfilled" ? result.value : undefined));
		if (captured[0] === undefined) throw new Error("Authority inspection payload is missing.");
		for (let index = 0; index < files.length; index++) {
			if ((await digestOptional(files[index]!)) !== captured[index])
				throw new Error("Authority artifacts changed during private inspection.");
		}
		await validateCapture();
		// Writable SQLite inspection may checkpoint or remove sidecars only in this disposable complete copy.
		const copy = path.join(directory, path.basename(source));
		let opened: { readonly view: AuthorityExportView; close(): void };
		try {
			opened = openVerifiedExport(copy, identity, legacySqliteSource, directory, source);
		} catch (error) {
			if (classifyInvalidTarget && !(error instanceof AggregateError)) throw new InvalidTargetInspectionError(error);
			throw error;
		}
		let useError: unknown;
		let useFailed = false;
		try {
			result = await use(opened.view);
		} catch (error) {
			useFailed = true;
			useError = classifyUse && !(error instanceof AggregateError) ? new InvalidTargetInspectionError(error) : error;
		}
		try {
			opened.close();
		} catch (closeError) {
			throw new AuthorityCleanupError(
				useFailed ? [useError, closeError] : [closeError],
				"Authority private inspection driver close failed.",
				async () => {
					opened.close();
				},
			);
		}
		if (useFailed) throw useError;
	} catch (error) {
		if (error instanceof AuthorityCleanupError && error.pending) {
			error.afterCleanup(() => fs.rm(directory, { recursive: true, force: true }));
			throw error;
		}
		try {
			await fs.rm(directory, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AuthorityCleanupError(
				[error, cleanupError],
				"Authority private inspection and disposable-copy cleanup failed.",
				async () => {
					await fs.rm(directory, { recursive: true, force: true });
				},
			);
		}
		throw error;
	}
	try {
		await fs.rm(directory, { recursive: true, force: true });
	} catch (error) {
		throw new AuthorityCleanupError([error], "Authority private inspection copy removal failed.", async () => {
			await fs.rm(directory, { recursive: true, force: true });
		});
	}
	return result;
}

async function inspectSelectedCopy(
	context: AuthorityExclusiveContext,
	descriptor: AuthorityDescriptor,
	legacySqliteSource: boolean,
): Promise<InspectedAuthority> {
	return inspectExportCopy(
		context,
		payloadPath(context, descriptor.backend),
		identityFromDescriptor(descriptor),
		async () => {
			const selected = await readAuthorityDescriptor(context.sessionFile);
			if (canonicalDurableSha256(selected) !== canonicalDurableSha256(descriptor))
				throw new Error("Selected descriptor changed during dry-run inspection.");
		},
		false,
		legacySqliteSource,
	);
}

/** Whether the selected SQLite payload is a physical-schema-v3 store that `--to sqlite --apply` converts. */
async function selectedLegacySqlite(
	context: AuthorityExclusiveContext,
	descriptor: AuthorityDescriptor | undefined,
): Promise<boolean> {
	if (descriptor?.backend !== "sqlite") return false;
	// Reads only the 100-byte header; the source capture below still reads and verifies the whole payload.
	try {
		return sqliteAuthorityPhysicalVersion(context.paths.sqlite) === SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION;
	} catch (error) {
		if (isFsError(error, "ENOENT")) return false;
		throw error;
	}
}

async function validateSelectedSource(
	context: AuthorityExclusiveContext,
	descriptor: AuthorityDescriptor,
): Promise<void> {
	if (
		descriptor.state !== "active" ||
		descriptor.owningSessionId !== context.owningSessionId ||
		descriptor.payload !== path.basename(payloadPath(context, descriptor.backend))
	) {
		throw new Error("Authority source is not a coherent active selection; recover it first.");
	}
	const anchor = await fs.lstat(context.paths.lock, { bigint: true });
	if (
		!anchor.isFile() ||
		anchor.isSymbolicLink() ||
		anchor.nlink !== 1n ||
		!hasPrivateMode(anchor.mode) ||
		String(anchor.dev) !== descriptor.physicalIdentity.dev ||
		String(anchor.ino) !== descriptor.physicalIdentity.ino
	) {
		throw new Error("Selected authority lock-anchor provenance does not match its descriptor.");
	}
	const marker = await readOptional(context.paths.legacyFence);
	if (!marker || marker.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON)
		throw new Error("The mandatory legacy denial fence is missing or changed.");
	const artifacts = await inspectAuthorityArtifacts(context.sessionFile);
	if (artifacts.migration || artifacts.staging || artifacts.temporary)
		throw new Error("Selected authority has incomplete competing lifecycle artifacts; recover them first.");
	const base = path.basename(context.sessionFile);
	const allowed = new Set(
		[
			context.paths.descriptor,
			context.paths.lock,
			context.paths.legacy,
			context.paths.legacyFence,
			payloadPath(context, descriptor.backend),
			...(descriptor.backend === "sqlite"
				? [`${context.paths.sqlite}-wal`, `${context.paths.sqlite}-shm`]
				: jsonlStoreFiles(context.paths.jsonl)),
		].map(file => path.basename(file)),
	);
	for (const name of await fs.readdir(path.dirname(context.sessionFile))) {
		if (!name.startsWith(`${base}.authority`)) continue;
		if (allowed.has(name) || isAuthorityRecoveryFileName(base, name)) continue;
		const backupPrefix = `${base}.authority.backup.`;
		if (
			name.startsWith(backupPrefix) &&
			/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
				name.slice(backupPrefix.length),
			)
		) {
			await validatePrivateDirectory(
				path.join(path.dirname(context.sessionFile), name),
				"selected authority backup",
				false,
			);
			continue;
		}
		throw new Error(`Unrecognized or competing selected authority artifact: ${name}`);
	}
	const unselected = descriptor.backend === "sqlite" ? context.paths.jsonl : context.paths.sqlite;
	for (const file of [unselected, `${unselected}-wal`, `${unselected}-shm`]) {
		if (await artifactPresent(file))
			throw new Error(`Ambiguous unselected authority payload: ${path.basename(file)}`);
	}
}

async function validateSelectedBeforeClose(sessionFile: string): Promise<void> {
	const canonical = await canonicalAuthoritySession(sessionFile);
	const descriptor = await readAuthorityDescriptor(canonical);
	if (!descriptor) return;
	await validateSelectedSource(
		{
			sessionFile: canonical,
			owningSessionId: await readAuthoritySessionId(canonical),
			paths: authorityPaths(canonical),
			physicalIdentity: descriptor.physicalIdentity,
		},
		descriptor,
	);
}

async function selectSource(
	context: AuthorityExclusiveContext,
	descriptor: AuthorityDescriptor | undefined,
	legacySqliteSource = false,
): Promise<{
	sourceBackend: "legacy-v1" | JournalingBackend;
	identity?: AuthorityIdentity;
	inspected: InspectedAuthority;
}> {
	if (descriptor) await validateSelectedSource(context, descriptor);
	if (!descriptor) {
		for (const file of [
			context.paths.jsonl,
			context.paths.sqlite,
			`${context.paths.sqlite}-wal`,
			`${context.paths.sqlite}-shm`,
			...listJsonlRotationArtifacts(context.paths.jsonl).map(artifact => artifact.file),
		]) {
			if (await artifactPresent(file))
				throw new Error(`Ambiguous or orphan unselected authority payload: ${path.basename(file)}`);
		}
	}
	if (!descriptor) {
		if (await readOptional(context.paths.legacyFence))
			throw new Error(
				"Legacy authority is permanently fenced without a selected v2 descriptor; refusing migration.",
			);
		const identity = authorityIdentity("jsonl", context.owningSessionId);
		return { sourceBackend: "legacy-v1", inspected: inspectedOf(await readLegacyExport(context, identity)) };
	}
	if (descriptor.state !== "active")
		throw new Error("Authority migration requires an active selected source; recover its current migration first.");
	const identity = identityFromDescriptor(descriptor);
	return {
		sourceBackend: descriptor.backend,
		identity,
		inspected: await inspectSelectedCopy(context, descriptor, legacySqliteSource),
	};
}

/** Whether `file` holds a valid store whose semantic fingerprint (source identity excluded) is `expectedSemanticSha256`. */
async function targetMatches(
	context: AuthorityExclusiveContext,
	file: string,
	identity: AuthorityIdentity,
	expectedSemanticSha256: string,
): Promise<boolean> {
	if (!(await artifactPresent(file))) return false;
	let state: InspectedAuthority;
	try {
		state = await inspectExportCopy(context, file, identity, async () => {}, true);
	} catch (error) {
		if (error instanceof InvalidTargetInspectionError) return false;
		throw error;
	}
	return state.semanticSha256 === expectedSemanticSha256;
}

async function publishTarget(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
	expectedSemanticSha256: string,
	options?: AuthorityMigrationOptions,
): Promise<void> {
	const names = migrationNames(context.sessionFile, manifest.id);
	const stagePath = path.join(names.stage, path.basename(payloadPath(context, manifest.targetBackend)));
	const activeTarget = payloadPath(context, manifest.targetBackend);
	if (await targetMatches(context, activeTarget, manifest.targetIdentity, expectedSemanticSha256)) return;
	const stagedDigests = new Map<string, Set<string>>();
	for (const file of manifest.targetFiles ?? []) {
		let digests = stagedDigests.get(file.name);
		if (!digests) stagedDigests.set(file.name, (digests = new Set()));
		digests.add(file.digest);
	}
	const originalDigests = new Map(manifest.sourceFiles.map(file => [file.name, file.digest]));
	// Rotation files go first: the store a reader can open appears only with its payload, published below.
	for (const name of targetRotationNames(context, manifest)) {
		const active = path.join(path.dirname(activeTarget), name);
		const staged = path.join(names.stage, name);
		const activeDigest = await digestOptional(active);
		const stagedDigest = await digestOptional(staged);
		if (activeDigest !== undefined && activeDigest !== stagedDigest) {
			if (!(stagedDigests.get(name)?.has(activeDigest) ?? false))
				throw new Error(`Cannot publish authority target over unrecognized inactive bytes: ${name}`);
			await fs.rm(active);
		}
		if (stagedDigest !== undefined && stagedDigest !== activeDigest) await fs.rename(staged, active);
		if (!(await artifactPresent(active)))
			throw new Error(`Verified target rotation file disappeared before publication: ${name}`);
	}
	await syncDirectory(path.dirname(activeTarget));
	for (const [suffix, cutName] of [
		["", "target-published-main"],
		["-wal", "target-published-wal"],
		["-shm", "target-published-shm"],
	] as const) {
		const active = `${activeTarget}${suffix}`;
		const staged = `${stagePath}${suffix}`;
		const activeName = path.basename(active);
		const activeDigest = await digestOptional(active);
		const stagedDigest = await digestOptional(staged);
		if (activeDigest !== undefined && activeDigest !== stagedDigest) {
			const originalDigest = originalDigests.get(activeName);
			const generated = stagedDigests.get(activeName)?.has(activeDigest) ?? false;
			if (originalDigest !== undefined && activeDigest === originalDigest) {
				const previousPath = path.join(names.backup, `${activeName}.previous`);
				if ((await digestOptional(previousPath)) !== originalDigest)
					await copyPrivateAtomically(active, previousPath, originalDigest);
				await fs.rm(active);
			} else if (generated) {
				await fs.rm(active);
			} else {
				throw new Error(`Cannot publish authority target over unrecognized inactive bytes: ${activeName}`);
			}
		}
		if (stagedDigest !== undefined && stagedDigest !== activeDigest) await fs.rename(staged, active);
		if (suffix === "" && !(await artifactPresent(active)))
			throw new Error("Verified target payload disappeared before publication.");
		await syncDirectory(path.dirname(activeTarget));
		fault(options ?? {}, cutName);
	}
	if (!(await targetMatches(context, activeTarget, manifest.targetIdentity, expectedSemanticSha256))) {
		throw new Error("Published authority payload and sidecars failed complete semantic verification.");
	}
}

async function applyMigration(
	context: AuthorityExclusiveContext,
	targetBackend: JournalingBackend,
	options: AuthorityMigrationOptions,
): Promise<AuthorityMigrationResult> {
	const existingManifest = (await fs.readdir(path.dirname(context.sessionFile))).filter(
		name => name.startsWith(`${path.basename(context.sessionFile)}${MIGRATION_PREFIX}`) && name.endsWith(".json"),
	);
	if (existingManifest.length)
		throw new Error("A staged authority migration already exists; use --recover finish|abort.");
	const descriptor = await readAuthorityDescriptor(context.sessionFile);
	if (descriptor?.backend === "jsonl") {
		// Only --apply holds exclusive ownership, so only it settles an interrupted JSONL rotation, exactly as the next
		// owner's open would. A dry-run takes no lock: the artifacts may belong to a live owner's rotation in progress,
		// and removing them could unlink its sealed history, so it reports them and changes nothing.
		if (options.apply) recoverJsonlRotation(context.paths.jsonl);
		else if (jsonlRotationRecoveryPending(context.paths.jsonl)) {
			throw new Error(
				"Authority JSONL rotation recovery is pending (a live owner is rotating, or a rotation was interrupted); a dry-run does not repair it. Retry the dry-run, or close the session and rerun with --apply.",
			);
		}
	}
	const existingFence = await readOptional(context.paths.legacyFence);
	if (existingFence && existingFence.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON)
		throw new Error("The legacy denial marker is not canonical; refusing migration.");
	// A selected SQLite store in the earlier physical schema converts through this same protocol even when the target
	// backend is SQLite: the target is a fresh current-schema store published over the backed-up v3 payload.
	const legacySqlite = await selectedLegacySqlite(context, descriptor);
	const source = await selectSource(context, descriptor, true);
	if (source.sourceBackend === targetBackend && !legacySqlite) {
		return { status: "already-selected", sourceBackend: source.sourceBackend, targetBackend };
	}
	const blockers = source.inspected.blockers;
	if (blockers.length)
		throw new Error(`Authority migration blocked by unresolved external effects or claims: ${blockers.join(", ")}`);
	if (!options.apply) return { status: "dry-run", sourceBackend: source.sourceBackend, targetBackend };

	const id = randomUUID();
	const names = migrationNames(context.sessionFile, id);
	const targetIdentity = authorityIdentity(targetBackend, context.owningSessionId);
	let manifest: MigrationManifest = {
		version: 1,
		id,
		owningSessionId: context.owningSessionId,
		sourceBackend: source.sourceBackend,
		targetBackend,
		phase: "started",
		targetIdentity,
		sourceFiles: [],
		backupName: path.basename(names.backup),
		stageName: path.basename(names.stage),
		...(source.identity ? { sourceIdentity: source.identity } : {}),
		...(descriptor ? { sourceDescriptor: descriptor } : {}),
		createdLegacyFence: false,
	};
	await writeManifest(context, manifest);
	fault(options, "manifest-created");
	const sourceFiles = await backupArtifacts(context, names.backup);
	manifest = { ...manifest, phase: "backed-up", sourceFiles };
	await writeManifest(context, manifest);
	await verifyBackupSnapshot(context, manifest);
	fault(options, "backup-synced");
	if (descriptor) {
		const sourceMigration: AuthorityDescriptor = {
			...descriptor,
			revision: descriptor.revision + 1,
			state: "migration",
			migrationId: id,
		};
		await writeAuthorityDescriptor(context.sessionFile, sourceMigration);
	}
	manifest = { ...manifest, phase: "source-frozen" };
	await writeManifest(context, manifest);
	fault(options, "source-frozen");

	const stagedTarget = await createTarget(context, manifest, source.inspected.semanticSha256);
	manifest = {
		...manifest,
		phase: "target-staged",
		targetSemanticSha256: stagedTarget.semanticSha256,
		targetFiles: mergeTargetFiles(manifest.targetFiles, stagedTarget.files),
	};
	await writeManifest(context, manifest);
	fault(options, "target-staged");
	manifest = { ...manifest, phase: "target-verified" };
	await writeManifest(context, manifest);
	fault(options, "target-verified");

	manifest = await ensureMigrationDenial(context, manifest);
	fault(options, "legacy-source-denied");
	manifest = { ...manifest, phase: "legacy-fenced" };
	await writeManifest(context, manifest);
	fault(options, "legacy-fenced");
	await verifySourceFiles(context, manifest);

	const activeTarget = payloadPath(context, targetBackend);
	manifest = { ...manifest, phase: "target-publishing" };
	await writeManifest(context, manifest);
	fault(options, "target-publishing");
	await publishTarget(context, manifest, source.inspected.semanticSha256, options);
	manifest = { ...manifest, phase: "target-published" };
	await writeManifest(context, manifest);
	fault(options, "target-published");
	manifest = { ...manifest, phase: "before-descriptor-publication" };
	await writeManifest(context, manifest);
	fault(options, "before-descriptor-publication");
	await verifySourceFiles(context, manifest);
	await verifyMigrationDenial(context, manifest);
	if (descriptor) {
		const targetMigration: AuthorityDescriptor = {
			...descriptor,
			revision: descriptor.revision + 2,
			backend: targetBackend,
			incarnation: targetIdentity.incarnation,
			payload: path.basename(activeTarget),
			state: "migration",
			migrationId: id,
		};
		await writeAuthorityDescriptor(context.sessionFile, targetMigration);
	} else {
		const initializing: AuthorityDescriptor = {
			version: 1,
			revision: 1,
			owningSessionId: context.owningSessionId,
			backend: targetBackend,
			format: 2,
			incarnation: targetIdentity.incarnation,
			payload: path.basename(activeTarget),
			state: "initializing",
			physicalIdentity: context.physicalIdentity,
		};
		await writeAuthorityDescriptor(context.sessionFile, initializing);
	}
	manifest = { ...manifest, phase: "descriptor-published" };
	await writeManifest(context, manifest);
	fault(options, "descriptor-published");
	await finalizeMigration(context, manifest, options);
	return { status: "migrated", sourceBackend: source.sourceBackend, targetBackend, backupDirectory: names.backup };
}

async function verifySelectedTarget(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
	descriptor: AuthorityDescriptor,
): Promise<void> {
	await validateMigrationDirectories(context, manifest);
	if (
		descriptor.owningSessionId !== context.owningSessionId ||
		descriptor.backend !== manifest.targetBackend ||
		descriptor.incarnation !== manifest.targetIdentity.incarnation ||
		descriptor.payload !== path.basename(payloadPath(context, manifest.targetBackend)) ||
		descriptor.physicalIdentity.dev !== context.physicalIdentity.dev ||
		descriptor.physicalIdentity.ino !== context.physicalIdentity.ino
	) {
		throw new Error(
			"The selected target descriptor does not match the migration owner, payload, incarnation, or physical authority anchor.",
		);
	}
	const firstSelectedRevision = manifest.sourceDescriptor ? manifest.sourceDescriptor.revision + 2 : 1;
	if (descriptor.state === "migration") {
		if (descriptor.migrationId !== manifest.id || descriptor.revision !== firstSelectedRevision)
			throw new Error("The selected target migration descriptor has an unexpected id or revision.");
	} else if (descriptor.state === "initializing") {
		if (manifest.sourceBackend !== "legacy-v1" || descriptor.revision !== firstSelectedRevision)
			throw new Error("The initializing target descriptor does not match the migration revision.");
	} else if (descriptor.state === "active") {
		if (descriptor.revision !== firstSelectedRevision + 1)
			throw new Error("The active target descriptor has an unexpected migration revision.");
	} else {
		throw new Error("The selected target descriptor is not a finishable migration state.");
	}
	if (
		!manifest.targetSemanticSha256 ||
		!manifest.targetFiles?.some(file => file.name === path.basename(payloadPath(context, manifest.targetBackend)))
	) {
		throw new Error("Migration lacks complete selected-target semantic and payload evidence.");
	}
	const targetPath = payloadPath(context, manifest.targetBackend);
	if (!(await artifactPresent(targetPath)))
		throw new Error("The descriptor-selected migration target payload is missing.");
	const state = await inspectExportCopy(context, targetPath, manifest.targetIdentity, async () => {
		const current = await readAuthorityDescriptor(context.sessionFile);
		if (canonicalDurableSha256(current) !== canonicalDurableSha256(descriptor))
			throw new Error("The selected target descriptor changed during inspection.");
	});
	if (state.semanticSha256 !== manifest.targetSemanticSha256) {
		throw new Error("The descriptor-selected target no longer matches its recorded complete semantic fingerprint.");
	}
}

async function archiveUnselectedSource(context: AuthorityExclusiveContext, manifest: MigrationManifest): Promise<void> {
	await verifyBackupFiles(context, manifest);
	for (const backend of ["jsonl", "sqlite"] as const) {
		if (backend === manifest.targetBackend) continue;
		const sourcePath = payloadPath(context, backend);
		const members =
			backend === "jsonl"
				? jsonlStoreFiles(sourcePath)
				: ["", "-wal", "-shm"].map(suffix => `${sourcePath}${suffix}`);
		for (const active of members) {
			const name = path.basename(active);
			const expected = manifest.sourceFiles.find(file => file.name === name);
			const current = await digestOptional(active);
			if (!expected && current !== undefined)
				throw new Error(`Unselected source has an unexplained active artifact: ${name}`);
			if (current !== undefined && current !== expected?.digest)
				throw new Error(`Unselected source artifact changed after backup: ${name}`);
			if (current !== undefined) await fs.rm(active);
		}
	}
	await syncDirectory(path.dirname(context.sessionFile));
}

async function finalizeMigration(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
	options?: AuthorityMigrationOptions,
): Promise<void> {
	let descriptor = await readAuthorityDescriptor(context.sessionFile);
	if (!descriptor) throw new Error("Migration target is not descriptor-selected; explicit recovery is required.");
	await verifySelectedTarget(context, manifest, descriptor);
	await verifyMigrationDenial(context, manifest);
	await archiveUnselectedSource(context, manifest);
	if (descriptor.state === "migration" || descriptor.state === "initializing") {
		await writeAuthorityDescriptor(context.sessionFile, {
			version: 1,
			revision: descriptor.revision + 1,
			owningSessionId: descriptor.owningSessionId,
			backend: descriptor.backend,
			format: 2,
			incarnation: descriptor.incarnation,
			payload: descriptor.payload,
			state: "active",
			physicalIdentity: descriptor.physicalIdentity,
		});
		descriptor = await readAuthorityDescriptor(context.sessionFile);
		if (!descriptor) throw new Error("The selected target descriptor disappeared during finalization.");
	}
	await verifySelectedTarget(context, manifest, descriptor);
	await verifyMigrationDenial(context, manifest);
	const ready = { ...manifest, phase: "ready" as const };
	await writeManifest(context, ready);
	fault(options ?? {}, "migration-ready");
	const names = migrationNames(context.sessionFile, manifest.id);
	await validateMigrationDirectories(context, ready);
	await fs.rm(names.stage, { recursive: true, force: true });
	await fs.rename(names.manifest, path.join(names.backup, "migration.json"));
	await syncDirectory(names.backup);
	await syncDirectory(path.dirname(context.sessionFile));
	fault(options ?? {}, "manifest-finalized");
}

export async function migrateAuthority(
	sessionFile: string,
	targetBackend: JournalingBackend,
	options: AuthorityMigrationOptions = {},
): Promise<AuthorityMigrationResult> {
	if (targetBackend !== "jsonl" && targetBackend !== "sqlite")
		throw new Error("Target authority backend must be jsonl or sqlite.");
	if (!options.apply) {
		const canonical = await canonicalAuthoritySession(sessionFile);
		const stat = await fs.stat(canonical);
		const context: AuthorityExclusiveContext = {
			sessionFile: canonical,
			owningSessionId: await readAuthoritySessionId(canonical),
			paths: authorityPaths(canonical),
			physicalIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
		};
		return applyMigration(context, targetBackend, options);
	}
	await validateSelectedBeforeClose(sessionFile);
	await closeSessionAuthority(sessionFile);
	return withAuthorityExclusive(sessionFile, context =>
		withLegacyJournalExclusion(context, () => applyMigration(context, targetBackend, options)),
	);
}

/**
 * Resume-time legacy v1 → versioned JSONL upgrade for a caller that already holds the root's exclusive
 * ownership. It is the offline `--to jsonl --apply` conversion (same manifest phases, backup, denial
 * fence and `--recover` contract), without releasing ownership between conversion and the first open.
 */
export async function upgradeLegacyAuthorityUnderOwnership(
	context: AuthorityExclusiveContext,
): Promise<AuthorityMigrationResult> {
	return withLegacyJournalExclusion(context, () => applyMigration(context, "jsonl", { apply: true }));
}

/**
 * Read-only legacy v1 upgrade preflight (the `--to jsonl` dry-run); throws the conversion's own refusal.
 * It takes no legacy writer lock, so concurrent preflights never contend; the apply step takes it.
 */
export async function checkLegacyAuthorityUpgrade(context: AuthorityExclusiveContext): Promise<void> {
	await applyMigration(context, "jsonl", { apply: false });
}

/** Whether a legacy v1 journal writer (an older client, or an upgrade in progress) holds the journal's lock. */
export function legacyAuthorityJournalBusy(journalPath: string): boolean {
	const lock = FileLock.tryAcquire(journalPath);
	if (!lock.acquired) return true;
	lock.release();
	return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function validIdentity(
	value: unknown,
	backend: JournalingBackend,
	owningSessionId: string,
): value is AuthorityIdentity {
	return (
		isPlainRecord(value) &&
		Object.keys(value).sort().join("\0") ===
			["backend", "format", "incarnation", "owningSessionId"].sort().join("\0") &&
		value.backend === backend &&
		value.format === 2 &&
		value.owningSessionId === owningSessionId &&
		typeof value.incarnation === "string" &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.incarnation)
	);
}

function validMigrationFiles(
	value: unknown,
	allowedNames: ReadonlySet<string>,
	allowRepeatedNames: boolean,
): value is readonly MigrationFile[] {
	if (!Array.isArray(value)) return false;
	const seen = new Set<string>();
	const seenNames = new Set<string>();
	for (const entry of value) {
		if (!isPlainRecord(entry) || Object.keys(entry).sort().join("\0") !== "digest\0name") return false;
		if (
			typeof entry.name !== "string" ||
			!allowedNames.has(entry.name) ||
			typeof entry.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.digest)
		)
			return false;
		if (!allowRepeatedNames && seenNames.has(entry.name)) return false;
		const unique = `${entry.name}\0${entry.digest}`;
		if (seen.has(unique)) return false;
		seen.add(unique);
		seenNames.add(entry.name);
	}
	return true;
}

function parseManifest(value: unknown, sessionFile: string, manifestPath: string): MigrationManifest {
	if (!isPlainRecord(value)) throw new Error(`Invalid authority migration manifest: ${manifestPath}`);
	const required = [
		"version",
		"id",
		"owningSessionId",
		"sourceBackend",
		"targetBackend",
		"phase",
		"targetIdentity",
		"sourceFiles",
		"backupName",
		"stageName",
		"createdLegacyFence",
	];
	const optional = ["sourceIdentity", "sourceDescriptor", "targetSemanticSha256", "targetFiles", "legacyDenial"];
	const keys = Object.keys(value).sort();
	if (required.some(key => !(key in value)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
		throw new Error(`Invalid authority migration manifest fields: ${manifestPath}`);
	}
	const id = value.id;
	const owningSessionId = value.owningSessionId;
	const sourceBackend = value.sourceBackend;
	const targetBackend = value.targetBackend;
	const phase = value.phase;
	const base = path.basename(sessionFile);
	const sourceNames = new Set([
		`${base}.authority.json`,
		`${base}.authority.sqlite`,
		`${base}.authority.sqlite-wal`,
		`${base}.authority.sqlite-shm`,
		`${base}.authority.jsonl`,
		`${base}.authority-v1.jsonl`,
		`${base}.authority-v1.jsonl.quarantine`,
		`${base}.authority.lock`,
	]);
	// A rotated JSONL source also captured its sealed segments, indexes and snapshot.
	const rotationLayout = jsonlLayout(path.join(path.dirname(path.resolve(sessionFile)), `${base}.authority.jsonl`));
	if (Array.isArray(value.sourceFiles)) {
		for (const entry of value.sourceFiles) {
			if (!isPlainRecord(entry) || typeof entry.name !== "string") continue;
			const artifact = classifyJsonlArtifact(rotationLayout, entry.name);
			if (artifact && artifact.kind !== "temporary") sourceNames.add(entry.name);
		}
	}
	const targetBase = targetBackend === "sqlite" ? `${base}.authority.sqlite` : `${base}.authority.jsonl`;
	const targetNames = new Set([targetBase, `${targetBase}-wal`, `${targetBase}-shm`]);
	if (targetBackend === "jsonl" && Array.isArray(value.targetFiles)) {
		for (const entry of value.targetFiles) {
			if (!isPlainRecord(entry) || typeof entry.name !== "string") continue;
			const artifact = classifyJsonlArtifact(rotationLayout, entry.name);
			if (artifact && artifact.kind !== "temporary") targetNames.add(entry.name);
		}
	}
	const phases = [
		"started",
		"backed-up",
		"source-frozen",
		"target-staged",
		"target-verified",
		"legacy-fenced",
		"target-publishing",
		"target-published",
		"before-descriptor-publication",
		"descriptor-published",
		"ready",
	];
	if (
		value.version !== 1 ||
		typeof id !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) ||
		path.basename(manifestPath) !== `${base}${MIGRATION_PREFIX}${id}.json` ||
		typeof owningSessionId !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owningSessionId) ||
		(sourceBackend !== "legacy-v1" && sourceBackend !== "jsonl" && sourceBackend !== "sqlite") ||
		(targetBackend !== "jsonl" && targetBackend !== "sqlite") ||
		typeof phase !== "string" ||
		(!phases.includes(phase) && phase !== "aborted") ||
		!validIdentity(value.targetIdentity, targetBackend, owningSessionId) ||
		typeof value.backupName !== "string" ||
		value.backupName !== `${base}${BACKUP_PREFIX}${id}` ||
		typeof value.stageName !== "string" ||
		value.stageName !== `${base}${STAGE_PREFIX}${id}` ||
		typeof value.createdLegacyFence !== "boolean" ||
		!validMigrationFiles(value.sourceFiles, sourceNames, false)
	)
		throw new Error(`Invalid authority migration manifest: ${manifestPath}`);
	if (sourceBackend === "legacy-v1") {
		if ("sourceIdentity" in value || "sourceDescriptor" in value)
			throw new Error(`Invalid legacy source metadata in migration manifest: ${manifestPath}`);
	} else {
		if (
			!validIdentity(value.sourceIdentity, sourceBackend, owningSessionId) ||
			!isPlainRecord(value.sourceDescriptor)
		) {
			throw new Error(`Missing selected source identity in migration manifest: ${manifestPath}`);
		}
		const sourceDescriptor = value.sourceDescriptor;
		const descriptorKeys = [
			"version",
			"revision",
			"owningSessionId",
			"backend",
			"format",
			"incarnation",
			"payload",
			"state",
			"physicalIdentity",
		];
		if (
			Object.keys(sourceDescriptor).sort().join("\0") !== descriptorKeys.sort().join("\0") ||
			sourceDescriptor.version !== 1 ||
			sourceDescriptor.format !== 2 ||
			sourceDescriptor.backend !== sourceBackend ||
			sourceDescriptor.state !== "active" ||
			sourceDescriptor.owningSessionId !== owningSessionId ||
			sourceDescriptor.incarnation !== (value.sourceIdentity as AuthorityIdentity).incarnation ||
			sourceDescriptor.payload !==
				(sourceBackend === "sqlite" ? `${base}.authority.sqlite` : `${base}.authority.jsonl`) ||
			!Number.isSafeInteger(sourceDescriptor.revision) ||
			(sourceDescriptor.revision as number) < 1 ||
			!isPlainRecord(sourceDescriptor.physicalIdentity) ||
			typeof sourceDescriptor.physicalIdentity.dev !== "string" ||
			typeof sourceDescriptor.physicalIdentity.ino !== "string" ||
			Object.keys(sourceDescriptor.physicalIdentity).sort().join("\0") !== "dev\0ino"
		)
			throw new Error(`Invalid source descriptor in migration manifest: ${manifestPath}`);
	}
	if ("legacyDenial" in value) {
		const denial = value.legacyDenial;
		const legacyName = `${base}.authority-v1.jsonl`;
		const source = (value.sourceFiles as MigrationFile[]).find(file => file.name === legacyName);
		if (
			sourceBackend !== "legacy-v1" ||
			!isPlainRecord(denial) ||
			Object.keys(denial).sort().join("\0") !== "bytes\0digest\0migrationId\0name\0sourceDigest" ||
			denial.name !== legacyName ||
			denial.migrationId !== id ||
			typeof denial.sourceDigest !== "string" ||
			!source ||
			denial.sourceDigest !== source.digest ||
			typeof denial.bytes !== "string" ||
			typeof denial.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(denial.digest)
		)
			throw new Error(`Invalid legacy denial provenance in migration manifest: ${manifestPath}`);
		const denialBytes = Buffer.from(denial.bytes, "base64");
		if (denialBytes.toString("base64") !== denial.bytes || digest(denialBytes) !== denial.digest) {
			throw new Error(`Legacy denial bytes do not match their migration provenance: ${manifestPath}`);
		}
	}
	const stagedPhase =
		phase === "aborted"
			? "targetSemanticSha256" in value || "targetFiles" in value
			: phases.indexOf(phase as (typeof phases)[number]) >= phases.indexOf("target-staged");
	if (stagedPhase) {
		if (
			typeof value.targetSemanticSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.targetSemanticSha256) ||
			!validMigrationFiles(value.targetFiles, targetNames, true) ||
			!(value.targetFiles as MigrationFile[]).some(file => file.name === targetBase)
		)
			throw new Error(`Missing verified target evidence in migration manifest: ${manifestPath}`);
	} else if ("targetSemanticSha256" in value || "targetFiles" in value) {
		throw new Error(`Premature target evidence in migration manifest: ${manifestPath}`);
	}
	return value as unknown as MigrationManifest;
}
async function findManifest(
	context: AuthorityExclusiveContext,
): Promise<{ path: string; manifest: MigrationManifest } | undefined> {
	const prefix = `${path.basename(context.sessionFile)}${MIGRATION_PREFIX}`;
	const matches = (await fs.readdir(path.dirname(context.sessionFile))).filter(
		name => name.startsWith(prefix) && name.endsWith(".json"),
	);
	if (matches.length > 1)
		throw new Error("Multiple authority migration manifests exist; refusing to choose a winner.");
	if (!matches.length) return undefined;
	const manifestPath = path.join(path.dirname(context.sessionFile), matches[0]);
	const manifestBytes = await readOptional(manifestPath);
	if (!manifestBytes) throw new Error("Authority migration manifest disappeared during recovery.");
	const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")), context.sessionFile, manifestPath);
	await validateMigrationDirectories(context, manifest);
	return { path: manifestPath, manifest };
}

/** Semantic fingerprint of the staged (or, once moved, published) target, checked against the recorded one. */
async function loadTargetState(context: AuthorityExclusiveContext, manifest: MigrationManifest): Promise<string> {
	const names = migrationNames(context.sessionFile, manifest.id);
	await validateMigrationDirectories(context, manifest);
	const stagedPath = path.join(names.stage, path.basename(payloadPath(context, manifest.targetBackend)));
	const pathToRead = (await artifactPresent(stagedPath)) ? stagedPath : payloadPath(context, manifest.targetBackend);
	const state = await inspectExportCopy(context, pathToRead, manifest.targetIdentity, async () => {});
	if (manifest.targetSemanticSha256 && state.semanticSha256 !== manifest.targetSemanticSha256) {
		throw new Error("Staged authority no longer matches its recorded complete semantic fingerprint.");
	}
	return state.semanticSha256;
}

async function targetMatchesManifest(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
): Promise<boolean> {
	if (!manifest.targetSemanticSha256) return false;
	if (!(await artifactPresent(payloadPath(context, manifest.targetBackend)))) return false;
	try {
		const state = await inspectExportCopy(
			context,
			payloadPath(context, manifest.targetBackend),
			manifest.targetIdentity,
			async () => {},
			true,
		);
		return state.semanticSha256 === manifest.targetSemanticSha256;
	} catch (error) {
		if (error instanceof InvalidTargetInspectionError) return false;
		throw error;
	}
}

async function rollbackUnselectedTarget(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
): Promise<void> {
	const names = migrationNames(context.sessionFile, manifest.id);
	await validateMigrationDirectories(context, manifest);
	await verifyBackupFiles(context, manifest);
	const target = payloadPath(context, manifest.targetBackend);
	const originalDigests = new Map(manifest.sourceFiles.map(file => [file.name, file.digest]));
	const stagedDigests = new Map<string, Set<string>>();
	for (const file of manifest.targetFiles ?? []) {
		const set = stagedDigests.get(file.name) ?? new Set<string>();
		set.add(file.digest);
		stagedDigests.set(file.name, set);
	}
	const semanticTarget = await targetMatchesManifest(context, manifest);
	for (const suffix of ["", "-wal", "-shm"]) {
		const active = `${target}${suffix}`;
		const name = path.basename(active);
		const previous = path.join(names.backup, `${name}.previous`);
		const expectedOriginal = originalDigests.get(name);
		const previousDigest = await digestOptional(previous);
		if (previousDigest !== undefined && (!expectedOriginal || previousDigest !== expectedOriginal)) {
			throw new Error(`Cannot abort safely: preserved pre-migration target bytes are unexplained for ${name}.`);
		}
		const activeDigest = await digestOptional(active);
		if (activeDigest !== undefined && expectedOriginal && activeDigest === expectedOriginal) continue;
		if (activeDigest !== undefined) {
			const staged = stagedDigests.get(name)?.has(activeDigest) ?? false;
			if (!staged && !(suffix === "" && semanticTarget)) {
				throw new Error(
					`Cannot abort safely: unpublished target bytes are not attributable to this migration: ${name}`,
				);
			}
			await fs.rm(active);
		}
		if (previousDigest !== undefined) await fs.rename(previous, active);
		const restored = await digestOptional(active);
		if (expectedOriginal && restored !== expectedOriginal) {
			throw new Error(`Cannot abort safely: the captured pre-migration target artifact was not restored: ${name}`);
		}
		if (!expectedOriginal && restored !== undefined)
			throw new Error(`Cannot abort safely: an unrecorded target artifact remains after rollback: ${name}`);
	}
	for (const name of targetRotationNames(context, manifest)) {
		const active = path.join(path.dirname(target), name);
		const activeDigest = await digestOptional(active);
		if (activeDigest === undefined) continue;
		if (!(stagedDigests.get(name)?.has(activeDigest) ?? false))
			throw new Error(
				`Cannot abort safely: unpublished target bytes are not attributable to this migration: ${name}`,
			);
		await fs.rm(active);
	}
	await syncDirectory(path.dirname(target));
}

async function verifyAbortSourceSnapshot(
	context: AuthorityExclusiveContext,
	manifest: MigrationManifest,
): Promise<{ readonly descriptor?: AuthorityDescriptor; readonly exported: InspectedAuthority }> {
	await validateMigrationDirectories(context, manifest);
	const descriptor = await readAuthorityDescriptor(context.sessionFile);
	const marker = await readOptional(context.paths.legacyFence);
	if (marker && marker.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON)
		throw new Error("Cannot abort because the legacy denial marker is not canonical.");
	if (manifest.sourceDescriptor) {
		const source = manifest.sourceDescriptor;
		if (
			!descriptor ||
			descriptor.owningSessionId !== context.owningSessionId ||
			descriptor.backend !== source.backend ||
			descriptor.incarnation !== source.incarnation ||
			descriptor.payload !== source.payload ||
			descriptor.physicalIdentity.dev !== source.physicalIdentity.dev ||
			descriptor.physicalIdentity.ino !== source.physicalIdentity.ino
		)
			throw new Error("Cannot abort because the captured source descriptor is missing or changed.");
		if (descriptor.state === "migration") {
			if (descriptor.migrationId !== manifest.id || descriptor.revision !== source.revision + 1)
				throw new Error("Cannot abort because the source migration descriptor changed.");
		} else if (descriptor.state === "active") {
			if (descriptor.revision !== source.revision && descriptor.revision !== source.revision + 2)
				throw new Error("Cannot abort because the active source revision changed.");
		} else throw new Error("Cannot abort because the selected source is not recoverable.");
	} else if (descriptor) {
		throw new Error("Cannot abort because a descriptor appeared during legacy migration.");
	}
	if (manifest.sourceFiles.length) await verifyBackupFiles(context, manifest);
	let exported: InspectedAuthority;
	if (manifest.sourceBackend === "legacy-v1") {
		const original = manifest.sourceFiles.length ? await readSourceBackupExport(context, manifest) : undefined;
		const legacyDigest = await digestOptional(context.paths.legacy);
		const denial = manifest.legacyDenial;
		if (legacyDigest !== undefined && denial && legacyDigest === denial.digest) {
			if (
				!marker ||
				!original ||
				denial.migrationId !== manifest.id ||
				denial.name !== path.basename(context.paths.legacy) ||
				denial.digest !== digest(legacyDenialBytes(manifest.id)) ||
				denial.bytes !== legacyDenialBytes(manifest.id).toString("base64") ||
				!manifest.sourceFiles.some(file => file.name === denial.name && file.digest === denial.sourceDigest)
			)
				throw new Error("Cannot abort: legacy denial provenance is incomplete or changed.");
			exported = original;
		} else {
			const current = inspectedOf(
				await readLegacyExport(context, authorityIdentity("jsonl", context.owningSessionId)),
			);
			exported = original ?? current;
			if (current.semanticSha256 !== exported.semanticSha256)
				throw new Error("Cannot abort because the current legacy source differs from the captured source backup.");
		}
	} else {
		if (!manifest.sourceIdentity) throw new Error("Cannot abort because the captured source identity is missing.");
		// A same-backend conversion publishes its target over the source payload; once that payload no longer holds
		// the captured source bytes, the verified backup is the source and the rollback below restores it.
		const sourcePayload = payloadPath(context, manifest.sourceBackend);
		const captured = manifest.sourceFiles.find(file => file.name === path.basename(sourcePayload));
		const activeSource =
			manifest.sourceBackend === manifest.targetBackend && captured
				? await digestOptional(sourcePayload)
				: undefined;
		if (captured && manifest.sourceBackend === manifest.targetBackend && activeSource !== captured.digest) {
			exported = await readSourceBackupExport(context, manifest);
		} else {
			const current = await inspectExportCopy(
				context,
				sourcePayload,
				manifest.sourceIdentity,
				async () => {},
				false,
				true,
			);
			exported = manifest.sourceFiles.length ? await readSourceBackupExport(context, manifest) : current;
			if (current.semanticSha256 !== exported.semanticSha256) {
				throw new Error("Cannot abort because the selected source differs from the captured source backup.");
			}
		}
	}
	if (exported.blockers.length)
		throw new Error("Cannot abort safely while the captured source has unresolved external effects or claims.");
	if (!manifest.sourceFiles.length) return { ...(descriptor ? { descriptor } : {}), exported };
	const actual = new Map((await sourceArtifacts(context)).map(file => [file.name, file.digest]));
	const targetNames = targetMemberNames(context, manifest);
	const targetMayBePublished = [
		"target-publishing",
		"target-published",
		"before-descriptor-publication",
		"descriptor-published",
		"ready",
		"aborted",
	].includes(manifest.phase);
	const expectedNames = new Set(manifest.sourceFiles.map(file => file.name));
	const fence = await readOptional(context.paths.legacyFence);
	if (fence?.toString("utf8") === LEGACY_AUTHORITY_DENIAL_REASON)
		expectedNames.add(path.basename(context.paths.legacyFence));
	if (targetMayBePublished) for (const name of targetNames) expectedNames.add(name);
	for (const name of actual.keys())
		if (!expectedNames.has(name))
			throw new Error(`Cannot abort because an unexplained authority artifact appeared: ${name}`);
	for (const file of manifest.sourceFiles) {
		if (file.name === path.basename(context.paths.descriptor) || (targetMayBePublished && targetNames.has(file.name)))
			continue;
		const observedDigest = actual.get(file.name);
		if (
			file.name === path.basename(context.paths.legacy) &&
			manifest.legacyDenial &&
			observedDigest === manifest.legacyDenial.digest
		)
			continue;
		if (observedDigest !== file.digest)
			throw new Error(`Cannot abort because source evidence changed after backup: ${file.name}`);
	}
	return { ...(descriptor ? { descriptor } : {}), exported };
}

async function verifyActiveAuthority(context: AuthorityExclusiveContext): Promise<AuthorityDescriptor> {
	const descriptor = await readAuthorityDescriptor(context.sessionFile);
	if (
		!descriptor ||
		descriptor.state !== "active" ||
		descriptor.owningSessionId !== context.owningSessionId ||
		descriptor.physicalIdentity.dev !== context.physicalIdentity.dev ||
		descriptor.physicalIdentity.ino !== context.physicalIdentity.ino ||
		descriptor.payload !== path.basename(payloadPath(context, descriptor.backend))
	) {
		throw new Error("No fully selected active authority exists for recovery.");
	}
	const artifacts = await inspectAuthorityArtifacts(context.sessionFile);
	if (artifacts.migration || artifacts.staging || artifacts.temporary)
		throw new Error("Authority migration artifacts exist without a recoverable manifest.");
	const otherPayload = descriptor.backend === "sqlite" ? context.paths.jsonl : context.paths.sqlite;
	for (const file of [otherPayload, `${otherPayload}-wal`, `${otherPayload}-shm`]) {
		if (await artifactPresent(file))
			throw new Error(
				`An unselected authority payload remains outside the migration backup: ${path.basename(file)}`,
			);
	}
	const marker = await readOptional(context.paths.legacyFence);
	if (!marker || marker.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON)
		throw new Error("The permanent legacy denial fence is missing or changed.");
	const legacy = await readOptional(context.paths.legacy);
	if (legacy) {
		if (!marker) throw new Error("An unselected legacy source remains without its permanent denial fence.");
		let parsed: unknown;
		try {
			parsed = JSON.parse(legacy.toString("utf8"));
		} catch {
			throw new Error("The legacy denial record is invalid.");
		}
		if (!isPlainRecord(parsed) || !isPlainRecord(parsed.record) || typeof parsed.record.migrationId !== "string") {
			throw new Error("The legacy denial record is invalid.");
		}
		const migrationId = parsed.record.migrationId;
		if (digest(legacy) !== digest(legacyDenialBytes(migrationId))) {
			throw new Error("The legacy source is not this implementation's unsupported-version denial record.");
		}
	}
	// A selected v3 SQLite store is a coherent selection awaiting `--to sqlite --apply`, so recovery inspects it too.
	await inspectExportCopy(
		context,
		payloadPath(context, descriptor.backend),
		identityFromDescriptor(descriptor),
		async () => {
			const current = await readAuthorityDescriptor(context.sessionFile);
			if (canonicalDurableSha256(current) !== canonicalDurableSha256(descriptor))
				throw new Error("The selected active descriptor changed during inspection.");
		},
		false,
		true,
	);
	return descriptor;
}

async function recoverMigration(
	context: AuthorityExclusiveContext,
	action: "finish" | "abort",
): Promise<AuthorityMigrationResult> {
	const found = await findManifest(context);
	if (!found) {
		const descriptor = await readAuthorityDescriptor(context.sessionFile);
		if (!descriptor && action === "abort") {
			const artifacts = await inspectAuthorityArtifacts(context.sessionFile);
			if (
				artifacts.descriptor ||
				artifacts.sqlite ||
				artifacts.jsonl ||
				artifacts.migration ||
				artifacts.staging ||
				artifacts.temporary
			) {
				throw new Error(
					"Cannot repeat legacy abort because v2 or incomplete authority artifacts remain without a selected descriptor.",
				);
			}
			if (await readOptional(context.paths.legacyFence))
				throw new Error("The legacy source remains permanently fenced; refusing an implicit fallback.");
			await readLegacyExport(context, authorityIdentity("jsonl", context.owningSessionId));
			return { status: "recovered", sourceBackend: "legacy-v1", targetBackend: "jsonl" };
		}
		if (!descriptor) throw new Error("No recoverable staged authority migration exists.");
		const active = await verifyActiveAuthority(context);
		return { status: "recovered", sourceBackend: active.backend, targetBackend: active.backend };
	}
	let { manifest } = found;
	const names = migrationNames(context.sessionFile, manifest.id);
	if (manifest.backupName !== path.basename(names.backup) || manifest.stageName !== path.basename(names.stage)) {
		throw new Error("Migration manifest names do not match the canonical sibling paths.");
	}
	if (action === "abort") {
		const descriptor = await readAuthorityDescriptor(context.sessionFile);
		if (
			descriptor?.backend === manifest.targetBackend &&
			descriptor.incarnation === manifest.targetIdentity.incarnation
		) {
			throw new Error("The descriptor already selected the target; use --recover finish.");
		}
		await verifyAbortSourceSnapshot(context, manifest);
		manifest = { ...manifest, phase: "aborted" };
		await writeManifest(context, manifest);
		if (manifest.targetFiles?.length) await rollbackUnselectedTarget(context, manifest);
		if (manifest.sourceBackend === "legacy-v1" && manifest.legacyDenial) {
			if ((await digestOptional(context.paths.legacy)) === manifest.legacyDenial.digest) {
				const backup = path.join(names.backup, manifest.legacyDenial.name);
				if ((await digestOptional(backup)) !== manifest.legacyDenial.sourceDigest)
					throw new Error("Cannot restore the exact legacy source backup.");
				await copyPrivateAtomically(backup, context.paths.legacy, manifest.legacyDenial.sourceDigest);
			}
		}
		const currentDescriptor = await readAuthorityDescriptor(context.sessionFile);
		if (
			currentDescriptor?.state === "migration" &&
			currentDescriptor.migrationId === manifest.id &&
			manifest.sourceDescriptor
		) {
			await writeAuthorityDescriptor(context.sessionFile, {
				...manifest.sourceDescriptor,
				revision: currentDescriptor.revision + 1,
				state: "active",
			});
		}
		if (manifest.createdLegacyFence) {
			const marker = await readOptional(context.paths.legacyFence);
			if (marker && marker.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON)
				throw new Error("Cannot abort safely because the legacy denial marker changed.");
			if (marker) {
				await fs.rm(context.paths.legacyFence);
				await syncDirectory(path.dirname(context.sessionFile));
			}
		}
		await validateMigrationDirectories(context, manifest);
		await fs.rm(names.stage, { recursive: true, force: true });
		if (!(await validatePrivateDirectory(names.backup, "migration backup", true))) {
			await fs.mkdir(names.backup, { mode: 0o700 });
			await syncDirectory(path.dirname(context.sessionFile));
		}
		const receipt = path.join(names.backup, "migration-aborted.json");
		if (await artifactPresent(receipt))
			throw new Error("An aborted migration receipt already exists; refusing to overwrite it.");
		await fs.rename(found.path, receipt);
		await syncDirectory(names.backup);
		await syncDirectory(path.dirname(context.sessionFile));
		return {
			status: "recovered",
			sourceBackend: manifest.sourceBackend,
			targetBackend: manifest.sourceBackend === "legacy-v1" ? "jsonl" : manifest.sourceBackend,
		};
	}
	if (manifest.phase === "aborted") throw new Error("This migration was durably aborted; it cannot be finished.");
	if (manifest.phase === "ready") {
		await finalizeMigration(context, manifest);
		return { status: "recovered", sourceBackend: manifest.sourceBackend, targetBackend: manifest.targetBackend };
	}
	let descriptor = await readAuthorityDescriptor(context.sessionFile);
	const selectedTarget =
		descriptor?.backend === manifest.targetBackend && descriptor.incarnation === manifest.targetIdentity.incarnation;
	if (selectedTarget) {
		await finalizeMigration(context, manifest);
		return { status: "recovered", sourceBackend: manifest.sourceBackend, targetBackend: manifest.targetBackend };
	}
	if (manifest.phase === "started") {
		if (manifest.sourceDescriptor) {
			if (
				!descriptor ||
				descriptor.state !== "active" ||
				descriptor.backend !== manifest.sourceDescriptor.backend ||
				descriptor.incarnation !== manifest.sourceDescriptor.incarnation
			)
				throw new Error("The selected source changed before migration backup completed.");
		} else if (descriptor) {
			throw new Error("A v2 descriptor appeared before legacy migration backup completed.");
		}
		const sourceFiles = await backupArtifacts(context, names.backup);
		manifest = { ...manifest, phase: "backed-up", sourceFiles };
		await writeManifest(context, manifest);
	}
	if (manifest.phase === "backed-up") {
		await verifyBackupSnapshot(context, manifest);
		if (descriptor && manifest.sourceDescriptor) {
			if (
				descriptor.state === "active" &&
				descriptor.backend === manifest.sourceDescriptor.backend &&
				descriptor.incarnation === manifest.sourceDescriptor.incarnation
			) {
				await writeAuthorityDescriptor(context.sessionFile, {
					...descriptor,
					revision: descriptor.revision + 1,
					state: "migration",
					migrationId: manifest.id,
				});
			} else if (
				descriptor.state !== "migration" ||
				descriptor.migrationId !== manifest.id ||
				descriptor.backend !== manifest.sourceDescriptor.backend ||
				descriptor.incarnation !== manifest.sourceDescriptor.incarnation
			)
				throw new Error("The selected source changed before migration freeze completed.");
			descriptor = await readAuthorityDescriptor(context.sessionFile);
		}
		manifest = { ...manifest, phase: "source-frozen" };
		await writeManifest(context, manifest);
	}
	await verifyBackupFiles(context, manifest);
	await verifySourceFiles(context, manifest);
	// The source identity is outside the semantic fingerprint, so the target must carry the source's fingerprint.
	const expectedTargetHash = (await readSourceBackupExport(context, manifest)).semanticSha256;
	if (manifest.targetSemanticSha256 && manifest.targetSemanticSha256 !== expectedTargetHash) {
		throw new Error("The preserved source no longer matches the staged target's semantic fingerprint.");
	}
	let targetReady = await targetMatches(
		context,
		payloadPath(context, manifest.targetBackend),
		manifest.targetIdentity,
		expectedTargetHash,
	);
	if (targetReady) {
		await validateMigrationDirectories(context, manifest);
		await fs.rm(names.stage, { recursive: true, force: true });
	} else if (manifest.targetSemanticSha256) {
		try {
			targetReady = (await loadTargetState(context, manifest)) === expectedTargetHash;
		} catch (error) {
			if (error instanceof AuthorityCleanupError && error.pending) throw error;
			targetReady = false;
		}
	}
	if (!targetReady) {
		const stagedTarget = await createTarget(context, manifest, expectedTargetHash);
		const publicationStarted = ["target-publishing", "target-published", "before-descriptor-publication"].includes(
			manifest.phase,
		);
		manifest = {
			...manifest,
			phase: publicationStarted ? "target-publishing" : "target-staged",
			targetSemanticSha256: stagedTarget.semanticSha256,
			targetFiles: mergeTargetFiles(manifest.targetFiles, stagedTarget.files),
		};
		await writeManifest(context, manifest);
	}
	manifest = await ensureMigrationDenial(context, manifest);
	if (!["target-publishing", "target-published", "before-descriptor-publication"].includes(manifest.phase)) {
		manifest = { ...manifest, phase: "legacy-fenced" };
		await writeManifest(context, manifest);
	}
	await verifySourceFiles(context, manifest);
	const alreadyPublished =
		targetReady && ["target-published", "before-descriptor-publication"].includes(manifest.phase);
	if (!alreadyPublished) {
		if (manifest.phase !== "target-publishing") {
			manifest = { ...manifest, phase: "target-publishing" };
			await writeManifest(context, manifest);
		}
		await publishTarget(context, manifest, await loadTargetState(context, manifest));
		manifest = { ...manifest, phase: "target-published" };
		await writeManifest(context, manifest);
	}
	manifest = { ...manifest, phase: "before-descriptor-publication" };
	await writeManifest(context, manifest);
	await verifySourceFiles(context, manifest);
	await verifyMigrationDenial(context, manifest);
	const targetPath = payloadPath(context, manifest.targetBackend);
	descriptor = await readAuthorityDescriptor(context.sessionFile);
	if (manifest.sourceDescriptor) {
		if (
			!descriptor ||
			descriptor.state !== "migration" ||
			descriptor.migrationId !== manifest.id ||
			descriptor.backend !== manifest.sourceDescriptor.backend ||
			descriptor.incarnation !== manifest.sourceDescriptor.incarnation
		) {
			throw new Error("The selected source descriptor changed before target descriptor publication.");
		}
		await writeAuthorityDescriptor(context.sessionFile, {
			...descriptor,
			revision: descriptor.revision + 1,
			backend: manifest.targetBackend,
			incarnation: manifest.targetIdentity.incarnation,
			payload: path.basename(targetPath),
			state: "migration",
			migrationId: manifest.id,
		});
	} else {
		if (descriptor) throw new Error("A descriptor appeared during legacy migration before target publication.");
		await writeAuthorityDescriptor(context.sessionFile, {
			version: 1,
			revision: 1,
			owningSessionId: context.owningSessionId,
			backend: manifest.targetBackend,
			format: 2,
			incarnation: manifest.targetIdentity.incarnation,
			payload: path.basename(targetPath),
			state: "initializing",
			physicalIdentity: context.physicalIdentity,
		});
	}
	manifest = { ...manifest, phase: "descriptor-published" };
	await writeManifest(context, manifest);
	await finalizeMigration(context, manifest);
	return { status: "recovered", sourceBackend: manifest.sourceBackend, targetBackend: manifest.targetBackend };
}

export async function recoverAuthorityMigration(
	sessionFile: string,
	action: "finish" | "abort",
): Promise<AuthorityMigrationResult> {
	if (action !== "finish" && action !== "abort") throw new Error("Migration recovery action must be finish or abort.");
	await closeSessionAuthority(sessionFile);
	return withAuthorityExclusive(sessionFile, context =>
		withLegacyJournalExclusion(context, () => recoverMigration(context, action)),
	);
}

export async function repairSelectedAuthority(
	sessionFile: string,
	options: { readonly apply?: boolean } = {},
): Promise<AuthorityRepairResult> {
	const diagnosis = await diagnoseSelectedAuthority(sessionFile, options);
	return { ...diagnosis, recoveryFiles: listAuthorityRecoveryFiles(await canonicalAuthoritySession(sessionFile)) };
}

async function diagnoseSelectedAuthority(
	sessionFile: string,
	options: { readonly apply?: boolean },
): Promise<Omit<AuthorityRepairResult, "recoveryFiles">> {
	if (!options.apply) {
		const canonical = await canonicalAuthoritySession(sessionFile);
		const descriptor = await readAuthorityDescriptor(canonical);
		if (!descriptor) {
			const result = await repairSessionAuthority(canonical, { apply: false });
			return { status: result.status, journalPath: result.journalPath, affectedActorIds: result.affectedActorIds };
		}
		if (descriptor.state !== "active")
			throw new Error("Cannot repair authority while a migration or initialization is incomplete.");
		const stat = await fs.stat(canonical);
		const context: AuthorityExclusiveContext = {
			sessionFile: canonical,
			owningSessionId: await readAuthoritySessionId(canonical),
			paths: authorityPaths(canonical),
			physicalIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
		};
		await selectSource(context, descriptor);
		return { status: "clean", journalPath: payloadPath(context, descriptor.backend), affectedActorIds: [] };
	}
	await validateSelectedBeforeClose(sessionFile);
	await closeSessionAuthority(sessionFile);
	return withAuthorityExclusive(sessionFile, async context => {
		const descriptor = await readAuthorityDescriptor(context.sessionFile);
		if (!descriptor) {
			const result = await repairSessionAuthority(context.sessionFile, { apply: options.apply });
			return {
				status: result.status,
				journalPath: result.journalPath,
				affectedActorIds: result.affectedActorIds,
				...(result.backupDirectory ? { backupDirectory: result.backupDirectory } : {}),
			};
		}
		await selectSource(context, descriptor);
		return { status: "clean", journalPath: payloadPath(context, descriptor.backend), affectedActorIds: [] };
	});
}
