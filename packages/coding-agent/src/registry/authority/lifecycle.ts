import { createHash, randomUUID } from "node:crypto";
import { durableFsync } from "./durable-sync";
import { hasPrivateMode } from "./private-mode";
import { directoryFsyncSupported } from "./directory-sync";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalDurableSha256, importLegacyAuthorityJournal, registryDurableJournalPath } from "../durable-state";
import { closeSessionAuthority } from "../authority";
import { readAuthorityDescriptor, writeAuthorityDescriptor } from "./descriptor";
import type { AuthorityDescriptor } from "./descriptor";
import { openAuthorityPersistence } from "./persistence";
import { recoverJsonlRotation } from "./jsonl-driver";
import {
	AUTHORITY_JSONL_ROTATION_MEMBER,
	isAuthorityRecoveryFileName,
	jsonlStoreFiles,
	listJsonlRotationArtifacts,
} from "./jsonl-layout";
import { authorityExportFromLegacySource } from "./engine";
import { SqliteAuthorityConstructionError } from "./sqlite-driver";
import type { AuthorityExport, AuthorityIdentity, AuthorityPersistence, JournalingBackend } from "./types";
import {
	authorityPaths,
	canonicalAuthoritySession,
	inspectAuthorityArtifacts,
	readAuthoritySessionId,
	withAuthorityExclusive,
	withAuthorityRelocationExclusive,
} from "./ownership";
import type {
	AuthorityExclusiveContext,
	AuthorityPhysicalIdentity,
	AuthorityRelocationExclusiveContext,
} from "./ownership";
import { legacyDenialBytes } from "./migration";
import { LEGACY_AUTHORITY_DENIAL_REASON } from "./ownership";
import { AuthorityCleanupError, withRetainedAuthorityCleanup } from "./private-cleanup";

export interface AuthorityBundle {
	readonly version: 1;
	readonly owningSessionId: string;
	readonly entries: readonly { readonly name: string; readonly data: Uint8Array }[];
}

interface BundleEntry {
	readonly name: string;
	readonly data: Uint8Array;
}

interface InspectionArtifact {
	readonly file: string;
	readonly bytes?: Buffer;
	readonly identity?: string;
}

class AuthorityInspectionChangedError extends Error {
	constructor(file?: string) {
		super(
			file
				? `Authority artifacts changed during private inspection: ${file}`
				: "Authority artifacts changed during private inspection.",
		);
	}
}

interface InspectionStat {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly nlink: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

interface InspectionCleanupResource {
	readonly close: () => void | Promise<void>;
	state: "open" | "failed" | "closed";
	error?: unknown;
}

interface InspectionCleanupState {
	readonly resources: InspectionCleanupResource[];
	readonly directories: Set<string>;
	readonly failures: unknown[];
}

function inspectionCleanup(): InspectionCleanupState {
	return { resources: [], directories: new Set(), failures: [] };
}

function trackInspectionResource(
	cleanup: InspectionCleanupState,
	close: () => void | Promise<void>,
): InspectionCleanupResource {
	const resource: InspectionCleanupResource = { close, state: "open" };
	cleanup.resources.push(resource);
	return resource;
}

function retainInspectionDirectory(cleanup: InspectionCleanupState, directory: string): void {
	cleanup.directories.add(directory);
}

function inspectionCleanupPending(cleanup: InspectionCleanupState): boolean {
	return cleanup.resources.some(resource => resource.state !== "closed") || cleanup.directories.size > 0;
}

async function closeInspectionResource(
	cleanup: InspectionCleanupState,
	resource: InspectionCleanupResource,
	retry = false,
): Promise<boolean> {
	if (resource.state === "closed") return true;
	if (resource.state === "failed" && !retry) return false;
	try {
		await resource.close();
		resource.state = "closed";
		return true;
	} catch (error) {
		resource.state = "failed";
		resource.error = error;
		if (!cleanup.failures.includes(error)) cleanup.failures.push(error);
		return false;
	}
}

async function disposeInspection(cleanup: InspectionCleanupState, retry = false): Promise<unknown[]> {
	const previousFailureCount = cleanup.failures.length;
	for (const resource of cleanup.resources)
		if (resource.state === "open" || (retry && resource.state === "failed"))
			await closeInspectionResource(cleanup, resource, retry);
	if (cleanup.resources.some(resource => resource.state !== "closed"))
		return cleanup.failures.slice(previousFailureCount);
	for (const directory of cleanup.directories) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			cleanup.directories.delete(directory);
		} catch (error) {
			if (!cleanup.failures.includes(error)) cleanup.failures.push(error);
		}
	}
	return cleanup.failures.slice(previousFailureCount);
}

function uniqueInspectionErrors(errors: readonly unknown[]): unknown[] {
	const unique: unknown[] = [];
	for (const error of errors) if (!unique.includes(error)) unique.push(error);
	return unique;
}

function inspectionFailure(errors: readonly unknown[], cleanup: InspectionCleanupState, message: string): unknown {
	const distinct = uniqueInspectionErrors([...errors, ...cleanup.failures]);
	const pending = distinct.filter(
		(error): error is AuthorityCleanupError => error instanceof AuthorityCleanupError && error.pending,
	);
	const dispose = async (): Promise<void> => {
		const failures = await disposeInspection(cleanup, true);
		if (inspectionCleanupPending(cleanup)) {
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, message, { cause: failures[0] });
			throw cleanup.failures[cleanup.failures.length - 1] ?? new Error(message);
		}
	};
	if (pending.length) {
		const owner = pending[0];
		for (const error of distinct) if (error !== owner && !owner.errors.includes(error)) owner.errors.push(error);
		for (const other of pending.slice(1)) owner.afterCleanup(() => other.cleanup());
		if (inspectionCleanupPending(cleanup)) owner.afterCleanup(dispose);
		return owner;
	}
	if (inspectionCleanupPending(cleanup)) return new AuthorityCleanupError(distinct, message, dispose);
	if (distinct.length === 1) return distinct[0];
	return new AggregateError(distinct, message, distinct.length ? { cause: distinct[0] } : undefined);
}

function deferNestedInspection(cleanup: InspectionCleanupState, error: unknown): void {
	if (!(error instanceof AuthorityCleanupError) || !error.pending) return;
	const resource = trackInspectionResource(cleanup, () => {});
	resource.state = "failed";
	resource.error = error;
}

function inspectionIdentity(stat: InspectionStat): string {
	return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function captureInspectionArtifact(file: string, cleanup?: InspectionCleanupState): Promise<InspectionArtifact> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if (isFsError(error, "ENOENT")) return { file };
		throw error;
	}
	const owner = cleanup ?? inspectionCleanup();
	const resource = trackInspectionResource(owner, () => handle.close());
	let artifact: InspectionArtifact | undefined;
	let failure: unknown;
	let failed = false;
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.nlink !== 1n || !hasPrivateMode(before.mode))
			throw new Error(`Authority inspection member must be a private singly-linked regular file: ${file}`);
		const bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		const identity = inspectionIdentity(before);
		if (identity !== inspectionIdentity(after)) throw new AuthorityInspectionChangedError(file);
		try {
			const current = await fs.lstat(file, { bigint: true });
			if (identity !== inspectionIdentity(current)) throw new AuthorityInspectionChangedError(file);
		} catch (error) {
			if (isFsError(error, "ENOENT")) throw new AuthorityInspectionChangedError(file);
			throw error;
		}
		artifact = { file, bytes, identity };
	} catch (error) {
		failed = true;
		failure = error;
	}
	const closed = await closeInspectionResource(owner, resource);
	if (failed) {
		if (!cleanup) throw inspectionFailure([failure], owner, "Authority inspection read and handle cleanup failed.");
		throw failure;
	}
	if (!closed) {
		if (!cleanup) throw inspectionFailure([], owner, "Authority inspection source handle close failed.");
		throw resource.error;
	}
	if (!artifact) throw new Error("Authority inspection did not capture its opened artifact.");
	return artifact;
}

async function writeInspectionCopy(file: string, data: Uint8Array, cleanup: InspectionCleanupState): Promise<void> {
	const handle = await fs.open(
		file,
		fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
		0o600,
	);
	const resource = trackInspectionResource(cleanup, () => handle.close());
	let failure: unknown;
	let failed = false;
	try {
		await handle.writeFile(data);
		await durableFsync(handle);
	} catch (error) {
		failed = true;
		failure = error;
	}
	const closed = await closeInspectionResource(cleanup, resource);
	if (failed) throw failure;
	if (!closed) throw resource.error;
}

async function verifyInspectionArtifacts(
	captured: readonly InspectionArtifact[],
	cleanup?: InspectionCleanupState,
): Promise<InspectionArtifact[]> {
	const current: InspectionArtifact[] = [];
	for (const original of captured) {
		const actual = await captureInspectionArtifact(original.file, cleanup);
		const bytesChanged =
			actual.bytes === undefined
				? original.bytes !== undefined
				: original.bytes === undefined || !actual.bytes.equals(original.bytes);
		if (actual.identity !== original.identity || bytesChanged)
			throw new AuthorityInspectionChangedError(original.file);
		current.push(actual);
	}
	return current;
}

interface InspectionTreeMember {
	readonly file: string;
	readonly directory: boolean;
	readonly identity: string;
	readonly bytes?: Buffer;
}

interface InspectionTreeSnapshot {
	readonly root: string;
	readonly members: readonly InspectionTreeMember[];
}

async function captureInspectionTree(root: string, cleanup?: InspectionCleanupState): Promise<InspectionTreeSnapshot> {
	const members: InspectionTreeMember[] = [];
	const visit = async (file: string): Promise<void> => {
		const before = await fs.lstat(file, { bigint: true });
		if (before.isSymbolicLink()) throw new Error(`Authority backup does not support symbolic links: ${file}`);
		const identity = inspectionIdentity(before);
		if (before.isDirectory()) {
			if (!hasPrivateMode(before.mode)) throw new Error(`Authority backup directory must be private: ${file}`);
			members.push({ file, directory: true, identity });
			const names = (await fs.readdir(file)).sort();
			for (const name of names) await visit(path.join(file, name));
			const after = await fs.lstat(file, { bigint: true });
			const currentNames = (await fs.readdir(file)).sort();
			if (identity !== inspectionIdentity(after) || JSON.stringify(names) !== JSON.stringify(currentNames))
				throw new AuthorityInspectionChangedError(file);
			return;
		}
		if (!before.isFile() || before.nlink !== 1n || !hasPrivateMode(before.mode))
			throw new Error(`Authority backup member must be a private singly-linked regular file: ${file}`);
		const captured = await captureInspectionArtifact(file, cleanup);
		if (captured.identity !== identity || !captured.bytes) throw new AuthorityInspectionChangedError(file);
		members.push({ file, directory: false, identity, bytes: captured.bytes });
	};
	await visit(root);
	return { root, members };
}

async function verifyInspectionTree(snapshot: InspectionTreeSnapshot, cleanup?: InspectionCleanupState): Promise<void> {
	const current = await captureInspectionTree(snapshot.root, cleanup);
	if (current.members.length !== snapshot.members.length) throw new AuthorityInspectionChangedError(snapshot.root);
	for (const [index, original] of snapshot.members.entries()) {
		const actual = current.members[index];
		if (
			actual.file !== original.file ||
			actual.directory !== original.directory ||
			actual.identity !== original.identity ||
			(actual.bytes && (!original.bytes || !actual.bytes.equals(original.bytes))) ||
			(!actual.bytes && original.bytes)
		)
			throw new AuthorityInspectionChangedError(original.file);
	}
}

interface RestoreManifest {
	readonly version: 1;
	readonly id: string;
	readonly bundleSha256: string;
	readonly owningSessionId: string;
	readonly stageName: string;
	readonly targetIdentity?: AuthorityIdentity;
	readonly targetSemanticSha256?: string;
	readonly targetFiles?: readonly { readonly name: string; readonly digest: string }[];
}

const O_NOFOLLOW = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
const AUTHORITY_SUFFIXES = [
	"authority.json",
	"authority.sqlite",
	"authority.sqlite-wal",
	"authority.sqlite-shm",
	"authority.jsonl",
	"authority-v1.jsonl",
	"authority-v1.jsonl.quarantine",
	"authority.lock",
] as const;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function digest(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function bundleDigest(entries: readonly BundleEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of [...entries].sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	)) {
		hash.update(entry.name).update("\0").update(String(entry.data.byteLength)).update("\0").update(entry.data);
	}
	return hash.digest("hex");
}

function safeBundleName(name: string): boolean {
	if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
	const segments = name.split("/");
	if (segments.some(segment => !segment || segment === "." || segment === "..")) return false;
	const top = segments[0];
	if (
		AUTHORITY_SUFFIXES.includes(top as (typeof AUTHORITY_SUFFIXES)[number]) ||
		AUTHORITY_JSONL_ROTATION_MEMBER.test(top)
	)
		return segments.length === 1;
	if (/^authority\.backup\.[a-f0-9-]{36}$/.test(top)) return segments.length > 1;
	return false;
}

function diskName(base: string, name: string): string {
	const [top, ...rest] = name.split("/");
	return path.join(`${base}.${top}`, ...rest);
}

function bundleName(base: string, name: string): string {
	const prefix = `${base}.`;
	if (!name.startsWith(prefix)) throw new Error(`Authority bundle artifact escaped its root: ${name}`);
	return name.slice(prefix.length);
}

async function readPrivateBytes(handle: fs.FileHandle, file: string): Promise<Buffer> {
	const before = await handle.stat({ bigint: true });
	if (!before.isFile() || before.nlink !== 1n || !hasPrivateMode(before.mode))
		throw new Error(`Authority bundle member must be a private singly-linked regular file: ${file}`);
	const bytes = await handle.readFile();
	const after = await handle.stat({ bigint: true });
	const current = await fs.lstat(file, { bigint: true });
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.dev !== current.dev ||
		before.ino !== current.ino ||
		before.size !== current.size ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs
	)
		throw new Error(`Authority bundle member changed while it was read: ${file}`);
	return bytes;
}

async function readPrivate(file: string, cleanup?: InspectionCleanupState): Promise<Buffer | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	const owner = cleanup ?? inspectionCleanup();
	const resource = trackInspectionResource(owner, () => handle.close());
	let bytes: Buffer | undefined;
	let failure: unknown;
	let failed = false;
	try {
		bytes = await readPrivateBytes(handle, file);
	} catch (error) {
		failed = true;
		failure = error;
	}
	const closed = await closeInspectionResource(owner, resource);
	if (failed || !closed) {
		if (!cleanup)
			throw inspectionFailure(failed ? [failure] : [], owner, "Authority private read and handle cleanup failed.");
		if (failed) throw failure;
		throw resource.error;
	}
	return bytes;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	const resolved = path.resolve(directory);
	await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
	const parsed = path.parse(resolved);
	let current = parsed.root;
	for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		const stat = await fs.lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error(`Authority artifact parent is not a directory: ${current}`);
	}
}

async function writePrivate(file: string, data: Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const cleanup = inspectionCleanup();
	try {
		await writeInspectionCopy(file, data, cleanup);
	} catch (error) {
		throw inspectionFailure([error], cleanup, "Authority private write and handle cleanup failed.");
	}
}

async function writePrivateAtomically(file: string, data: Uint8Array): Promise<void> {
	const temporary = `${file}.tmp-${randomUUID()}`;
	const cleanup = inspectionCleanup();
	try {
		await ensurePrivateDirectory(path.dirname(file));
		const handle = await fs.open(
			temporary,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
			0o600,
		);
		const resource = trackInspectionResource(cleanup, () => handle.close());
		await handle.writeFile(data);
		await durableFsync(handle);
		if (!(await closeInspectionResource(cleanup, resource))) throw resource.error;
		await fs.rename(temporary, file);
		await syncDirectory(path.dirname(file));
	} catch (error) {
		await disposeInspection(cleanup);
		return withRetainedAuthorityCleanup(
			async () => {
				throw inspectionFailure([error], cleanup, "Authority atomic publication and handle cleanup failed.");
			},
			() => fs.rm(temporary, { force: true }),
		);
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (!directoryFsyncSupported()) return;
	const cleanup = inspectionCleanup();
	const handle = await fs.open(directory, fs.constants.O_RDONLY);
	const resource = trackInspectionResource(cleanup, () => handle.close());
	let failure: unknown;
	let failed = false;
	try {
		await durableFsync(handle);
	} catch (error) {
		failed = true;
		failure = error;
	}
	const closed = await closeInspectionResource(cleanup, resource);
	if (failed || !closed)
		throw inspectionFailure(failed ? [failure] : [], cleanup, "Authority directory sync and handle cleanup failed.");
}

async function captureRetainedBackup(
	context: AuthorityExclusiveContext,
	name: string,
): Promise<InspectionTreeSnapshot> {
	const base = path.basename(context.sessionFile);
	const disk = path.join(path.dirname(context.sessionFile), name);
	const relative = bundleName(base, name);
	if (!/^authority\.backup\.[a-f0-9-]{36}$/.test(relative))
		throw new Error(`Cannot pack unfinished authority directory: ${disk}`);
	const snapshot = await captureInspectionTree(disk);
	const root = snapshot.members[0];
	if (snapshot.root !== disk || root?.file !== disk || !root.directory)
		throw new Error(`Authority backup must be a directory: ${disk}`);
	for (const member of snapshot.members.slice(1)) {
		const memberName = path.relative(path.dirname(context.sessionFile), member.file).split(path.sep).join("/");
		if (!safeBundleName(bundleName(base, memberName)))
			throw new Error(`Authority bundle member name is not permitted: ${memberName}`);
	}
	return snapshot;
}

async function captureRestoreEvidence(context: AuthorityExclusiveContext): Promise<InspectionTreeSnapshot[]> {
	const prefix = `${path.basename(context.sessionFile)}.authority.backup.`;
	const names = (await fs.readdir(path.dirname(context.sessionFile)))
		.filter(name => name.startsWith(prefix) && UUID_RE.test(name.slice(prefix.length)))
		.sort();
	const snapshots: InspectionTreeSnapshot[] = [];
	for (const name of names)
		snapshots.push(await captureInspectionTree(path.join(path.dirname(context.sessionFile), name)));
	return snapshots;
}

async function verifyRestoreEvidence(
	context: AuthorityExclusiveContext,
	snapshots: readonly InspectionTreeSnapshot[],
	cleanup?: InspectionCleanupState,
): Promise<void> {
	const prefix = `${path.basename(context.sessionFile)}.authority.backup.`;
	const names = (await fs.readdir(path.dirname(context.sessionFile)))
		.filter(name => name.startsWith(prefix) && UUID_RE.test(name.slice(prefix.length)))
		.sort();
	if (JSON.stringify(names) !== JSON.stringify(snapshots.map(snapshot => path.basename(snapshot.root))))
		throw new AuthorityInspectionChangedError(context.sessionFile);
	for (const snapshot of snapshots) await verifyInspectionTree(snapshot, cleanup);
}

function appendRetainedBackupEntries(
	context: AuthorityExclusiveContext,
	snapshots: readonly InspectionTreeSnapshot[],
	entries: BundleEntry[],
): void {
	const base = path.basename(context.sessionFile);
	for (const snapshot of snapshots)
		for (const member of snapshot.members) {
			if (member.directory) continue;
			if (!member.bytes) throw new Error(`Authority backup member was not captured: ${member.file}`);
			const relative = path.relative(path.dirname(context.sessionFile), member.file).split(path.sep).join("/");
			entries.push({ name: bundleName(base, relative), data: member.bytes });
		}
}

/** Bundle members beside the root: never the tail recovery file, which a pack or move leaves where it is. */
async function listAuthorityNames(context: AuthorityExclusiveContext): Promise<string[]> {
	const base = path.basename(context.sessionFile);
	const prefix = `${base}.authority`;
	return (await fs.readdir(path.dirname(context.sessionFile)))
		.filter(name => name.startsWith(prefix) && !isAuthorityRecoveryFileName(base, name))
		.sort();
}

function validateDescriptorBundle(bytes: Uint8Array, bundleOwner: string): AuthorityDescriptor {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		throw new Error("Authority bundle descriptor is not valid JSON.");
	}
	if (!isPlainRecord(value)) throw new Error("Authority bundle descriptor is not an object.");
	const keys = [
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
		Object.keys(value).sort().join("\0") !== keys.sort().join("\0") ||
		value.version !== 1 ||
		value.format !== 2 ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 1 ||
		value.owningSessionId !== bundleOwner ||
		(value.backend !== "jsonl" && value.backend !== "sqlite") ||
		typeof value.incarnation !== "string" ||
		!UUID_RE.test(value.incarnation) ||
		value.payload !== (value.backend === "sqlite" ? "authority.sqlite" : "authority.jsonl") ||
		value.state !== "active" ||
		!isPlainRecord(value.physicalIdentity) ||
		typeof value.physicalIdentity.dev !== "string" ||
		!value.physicalIdentity.dev ||
		typeof value.physicalIdentity.ino !== "string" ||
		!value.physicalIdentity.ino ||
		Object.keys(value.physicalIdentity).sort().join("\0") !== "dev\0ino"
	)
		throw new Error("Authority bundle descriptor is invalid or not quiescent.");
	return value as unknown as AuthorityDescriptor;
}

function validateBundle(bundle: AuthorityBundle): Map<string, Uint8Array> {
	if (
		!isPlainRecord(bundle) ||
		bundle.version !== 1 ||
		typeof bundle.owningSessionId !== "string" ||
		!UUID_RE.test(bundle.owningSessionId) ||
		!Array.isArray(bundle.entries)
	) {
		throw new Error("Authority bundle has an invalid version or root identity.");
	}
	const entries = new Map<string, Uint8Array>();
	for (const entry of bundle.entries) {
		if (
			!isPlainRecord(entry) ||
			Object.keys(entry).sort().join("\0") !== "data\0name" ||
			typeof entry.name !== "string" ||
			!safeBundleName(entry.name)
		) {
			throw new Error("Authority bundle contains an unsafe member name.");
		}
		if (!(entry.data instanceof Uint8Array) || entries.has(entry.name))
			throw new Error(`Authority bundle member is duplicated or invalid: ${entry.name}`);
		entries.set(entry.name, entry.data);
	}
	if (!entries.has("authority.lock")) throw new Error("Authority bundle is missing lock-anchor provenance.");
	return entries;
}

async function validateLegacyBytes(sessionFile: string, bytes: Uint8Array): Promise<AuthorityExport> {
	const directory = await fs.mkdtemp(path.join(path.dirname(sessionFile), ".authority-legacy-check-"));
	const cleanup = inspectionCleanup();
	retainInspectionDirectory(cleanup, directory);
	const failures: unknown[] = [];
	let exported: AuthorityExport | undefined;
	try {
		const validationSession = path.join(directory, path.basename(sessionFile));
		const transcript = await fs.readFile(sessionFile);
		await writeInspectionCopy(validationSession, transcript, cleanup);
		await writeInspectionCopy(registryDurableJournalPath(validationSession), bytes, cleanup);
		const identity: AuthorityIdentity = {
			backend: "jsonl",
			owningSessionId: await readAuthoritySessionId(validationSession),
			incarnation: randomUUID(),
			format: 2,
		};
		exported = authorityExportFromLegacySource(
			identity,
			importLegacyAuthorityJournal(registryDurableJournalPath(validationSession)),
		);
	} catch (error) {
		failures.push(error);
	}
	await disposeInspection(cleanup);
	if (failures.length || cleanup.failures.length)
		throw inspectionFailure(failures, cleanup, "Legacy authority inspection or snapshot cleanup failed.");
	if (!exported) throw new Error("Legacy authority inspection did not produce an export.");
	return exported;
}

async function selectedExport(
	file: string,
	identity: AuthorityIdentity,
	validateCapture?: (cleanup: InspectionCleanupState) => Promise<void>,
): Promise<AuthorityExport> {
	// A rotated JSONL store is its active payload plus its sealed segments, indexes and snapshot, copied under the same names.
	const files =
		identity.backend === "sqlite" ? ["", "-wal", "-shm"].map(suffix => `${file}${suffix}`) : jsonlStoreFiles(file);
	const captured: InspectionArtifact[] = [];
	for (const member of files) captured.push(await captureInspectionArtifact(member));
	if (!captured[0].bytes) throw new Error("Authority inspection payload is missing.");
	const directory = await fs.mkdtemp(path.join(path.dirname(file), ".authority-inspection-"));
	const cleanup = inspectionCleanup();
	retainInspectionDirectory(cleanup, directory);
	const copy = path.join(directory, path.basename(file));
	const failures: unknown[] = [];
	let driverResource: InspectionCleanupResource | undefined;
	let inspectionStarted = false;
	let state: AuthorityExport | undefined;
	try {
		for (let index = 0; index < files.length; index++) {
			const bytes = captured[index].bytes;
			if (bytes) await writeInspectionCopy(path.join(directory, path.basename(files[index])), bytes, cleanup);
		}
		await verifyInspectionArtifacts(captured, cleanup);
		if (validateCapture) await validateCapture(cleanup);
		inspectionStarted = true;
		const opened = openAuthorityPersistence({ path: copy, identity, create: false, refusalPath: file });
		driverResource = trackInspectionResource(cleanup, () => opened.close());
		opened.integrityCheck();
		state = opened.exportState();
	} catch (error) {
		failures.push(error);
		deferNestedInspection(cleanup, error);
		if (error instanceof SqliteAuthorityConstructionError) {
			const constructionCleanup = trackInspectionResource(cleanup, () => error.cleanup());
			await closeInspectionResource(cleanup, constructionCleanup);
		}
	}
	if (driverResource) await closeInspectionResource(cleanup, driverResource);
	if (inspectionStarted) {
		try {
			await verifyInspectionArtifacts(captured, cleanup);
			if (validateCapture) await validateCapture(cleanup);
		} catch (error) {
			failures.push(error);
			deferNestedInspection(cleanup, error);
		}
	}
	await disposeInspection(cleanup);
	if (failures.length || cleanup.failures.length)
		throw inspectionFailure(
			failures,
			cleanup,
			"Authority private inspection, handle close, or snapshot cleanup failed.",
		);
	if (!state) throw new Error("Authority private inspection did not produce an export.");
	return state;
}

function validateSelectedBundleArtifacts(
	entries: ReadonlyMap<string, Uint8Array>,
	descriptor: AuthorityDescriptor | undefined,
): void {
	if (!descriptor) {
		if ([...entries.keys()].some(name => payloadMember("sqlite", name) || payloadMember("jsonl", name)))
			throw new Error("Authority bundle has an unselected v2 payload without its descriptor.");
		return;
	}
	const fence = entries.get("authority-v1.jsonl.quarantine");
	if (!fence || Buffer.from(fence).toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON)
		throw new Error("Selected authority bundle is missing its exact mandatory legacy denial fence.");
	const competing = descriptor.backend === "sqlite" ? "jsonl" : "sqlite";
	if ([...entries.keys()].some(name => payloadMember(competing, name)))
		throw new Error("Selected authority bundle contains competing unselected payloads.");
}

async function validateSelectedDisk(
	context: AuthorityExclusiveContext,
	descriptor: AuthorityDescriptor,
	cleanup?: InspectionCleanupState,
): Promise<void> {
	if (!cleanup) {
		const owned = inspectionCleanup();
		let failure: unknown;
		let failed = false;
		try {
			await validateSelectedDisk(context, descriptor, owned);
		} catch (error) {
			failed = true;
			failure = error;
		}
		await disposeInspection(owned);
		if (failed || owned.failures.length)
			throw inspectionFailure(
				failed ? [failure] : [],
				owned,
				"Selected authority validation and handle cleanup failed.",
			);
		return;
	}
	if (
		descriptor.state !== "active" ||
		descriptor.owningSessionId !== context.owningSessionId ||
		descriptor.physicalIdentity.dev !== context.physicalIdentity.dev ||
		descriptor.physicalIdentity.ino !== context.physicalIdentity.ino
	)
		throw new Error("Selected authority descriptor has invalid lock-anchor provenance.");
	const marker = await readPrivate(context.paths.legacyFence, cleanup);
	if (!marker || marker.toString("utf8") !== LEGACY_AUTHORITY_DENIAL_REASON)
		throw new Error("Selected authority is missing its exact mandatory legacy denial fence.");
	const other = descriptor.backend === "sqlite" ? context.paths.jsonl : context.paths.sqlite;
	for (const suffix of descriptor.backend === "sqlite" ? [""] : ["", "-wal", "-shm"]) {
		if (await readPrivate(`${other}${suffix}`, cleanup))
			throw new Error("Selected authority contains competing unselected payloads.");
	}
	if (descriptor.backend === "sqlite" && listJsonlRotationArtifacts(context.paths.jsonl).length > 0)
		throw new Error("Selected authority contains competing unselected payloads.");
}

async function captureSelectedArtifacts(context: AuthorityExclusiveContext): Promise<InspectionArtifact[]> {
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
	const captured: InspectionArtifact[] = [];
	for (const file of files) captured.push(await captureInspectionArtifact(file));
	return captured;
}

async function verifySelectedArtifacts(
	context: AuthorityExclusiveContext,
	captured: readonly InspectionArtifact[],
	descriptor: AuthorityDescriptor,
	cleanup?: InspectionCleanupState,
): Promise<void> {
	const current = await verifyInspectionArtifacts(captured, cleanup);
	const selectedBytes = current.find(artifact => artifact.file === context.paths.descriptor)?.bytes;
	if (!selectedBytes) throw new AuthorityInspectionChangedError(context.paths.descriptor);
	let selected: unknown;
	try {
		selected = JSON.parse(selectedBytes.toString("utf8"));
	} catch {
		throw new AuthorityInspectionChangedError(context.paths.descriptor);
	}
	if (canonicalDurableSha256(selected) !== canonicalDurableSha256(descriptor))
		throw new AuthorityInspectionChangedError(context.paths.descriptor);
}

export async function packAuthorityBundle(sessionFile: string): Promise<AuthorityBundle | null> {
	const initial = await inspectAuthorityArtifacts(sessionFile);
	if (!initial.any) return null;
	await closeSessionAuthority(sessionFile);
	return withAuthorityExclusive(sessionFile, context => packUnderLock(context));
}

async function packUnderLock(context: AuthorityExclusiveContext): Promise<AuthorityBundle | null> {
	const base = path.basename(context.sessionFile);
	// Under exclusive ownership, an interrupted JSONL rotation is settled exactly as the next owner's open would.
	recoverJsonlRotation(context.paths.jsonl);
	const names = await listAuthorityNames(context);
	if (names.some(name => name.startsWith(`${base}.authority.migration.`) && name.endsWith(".json")))
		throw new Error("Cannot pack authority while a migration requires explicit recovery.");
	if (names.some(name => name.startsWith(`${base}.authority.stage.`) || name.startsWith(`${base}.authority.restore.`)))
		throw new Error("Cannot pack authority while staged lifecycle state is incomplete.");
	for (const name of names) {
		const isBackup = new RegExp(`^${escapeRegExp(base)}\\.authority\\.backup\\.[a-f0-9-]{36}$`).test(name);
		if (
			!isBackup &&
			!AUTHORITY_SUFFIXES.some(suffix => name === `${base}.${suffix}`) &&
			!AUTHORITY_JSONL_ROTATION_MEMBER.test(bundleName(base, name))
		)
			throw new Error(`Cannot pack unrecognized authority artifact: ${name}`);
	}
	const descriptor = await readAuthorityDescriptor(context.sessionFile);
	if (descriptor) await validateSelectedDisk(context, descriptor);
	const selectedSnapshot = descriptor ? await captureSelectedArtifacts(context) : [];
	const retainedBackups: InspectionTreeSnapshot[] = [];
	for (const name of names)
		if (name.startsWith(`${base}.authority.backup.`))
			retainedBackups.push(await captureRetainedBackup(context, name));
	if (
		!descriptor &&
		((await readPrivate(context.paths.sqlite)) ||
			(await readPrivate(`${context.paths.sqlite}-wal`)) ||
			(await readPrivate(`${context.paths.sqlite}-shm`)) ||
			(await readPrivate(context.paths.jsonl)) ||
			listJsonlRotationArtifacts(context.paths.jsonl).length > 0)
	)
		throw new Error("A v2 authority payload exists without its selected descriptor; refusing an ambiguous bundle.");
	if (descriptor) {
		const identity: AuthorityIdentity = {
			backend: descriptor.backend,
			owningSessionId: descriptor.owningSessionId,
			incarnation: descriptor.incarnation,
			format: 2,
		};
		await selectedExport(
			path.join(path.dirname(context.sessionFile), descriptor.payload),
			identity,
			async cleanup => {
				await verifySelectedArtifacts(context, selectedSnapshot, descriptor, cleanup);
				await validateSelectedDisk(context, descriptor, cleanup);
				for (const backup of retainedBackups) await verifyInspectionTree(backup, cleanup);
			},
		);
	} else {
		const legacy = await readPrivate(context.paths.legacy);
		if (legacy) await validateLegacyBytes(context.sessionFile, legacy);
		for (const backup of retainedBackups) await verifyInspectionTree(backup);
	}
	const entries: BundleEntry[] = [];
	for (const name of names) {
		if (name.startsWith(`${base}.authority.backup.`)) continue;
		const bytes = await readPrivate(path.join(path.dirname(context.sessionFile), name));
		if (!bytes) throw new Error(`Authority bundle member disappeared: ${name}`);
		if (name === path.basename(context.paths.descriptor)) {
			if (!descriptor) throw new Error("Authority descriptor disappeared while packing its bundle.");
			entries.push({
				name: "authority.json",
				data: Buffer.from(
					`${JSON.stringify({ ...descriptor, payload: descriptor.backend === "sqlite" ? "authority.sqlite" : "authority.jsonl" })}\n`,
				),
			});
		} else entries.push({ name: bundleName(base, name), data: bytes });
	}
	appendRetainedBackupEntries(context, retainedBackups, entries);
	if (!entries.some(entry => entry.name !== "authority.lock")) return null;
	const bundle: AuthorityBundle = {
		version: 1,
		owningSessionId: context.owningSessionId,
		entries: entries.sort((left, right) => left.name.localeCompare(right.name)),
	};
	await validateBundledState(context.sessionFile, bundle, validateBundle(bundle), true);
	if (descriptor) {
		await verifySelectedArtifacts(context, selectedSnapshot, descriptor);
		await validateSelectedDisk(context, descriptor);
	}
	for (const backup of retainedBackups) await verifyInspectionTree(backup);
	if (JSON.stringify(await listAuthorityNames(context)) !== JSON.stringify(names))
		throw new AuthorityInspectionChangedError(context.sessionFile);
	return bundle;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function isFsError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRestoreManifest(value: unknown, file: string): RestoreManifest {
	if (!isPlainRecord(value)) throw new Error(`Invalid authority restore manifest: ${file}`);
	const required = ["version", "id", "bundleSha256", "owningSessionId", "stageName"];
	const optional = ["targetIdentity", "targetSemanticSha256", "targetFiles"];
	const keys = Object.keys(value);
	if (required.some(key => !(key in value)) || keys.some(key => !required.includes(key) && !optional.includes(key)))
		throw new Error(`Invalid authority restore manifest fields: ${file}`);
	if (
		value.version !== 1 ||
		typeof value.id !== "string" ||
		!UUID_RE.test(value.id) ||
		typeof value.bundleSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.bundleSha256) ||
		typeof value.owningSessionId !== "string" ||
		!UUID_RE.test(value.owningSessionId) ||
		typeof value.stageName !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.stageName)
	)
		throw new Error(`Invalid authority restore manifest: ${file}`);
	if ("targetIdentity" in value) {
		if (
			!isPlainRecord(value.targetIdentity) ||
			(value.targetIdentity.backend !== "jsonl" && value.targetIdentity.backend !== "sqlite") ||
			value.targetIdentity.format !== 2 ||
			value.targetIdentity.owningSessionId !== value.owningSessionId ||
			typeof value.targetIdentity.incarnation !== "string" ||
			!UUID_RE.test(value.targetIdentity.incarnation)
		) {
			throw new Error(`Invalid authority restore target identity: ${file}`);
		}
	}
	if (
		"targetSemanticSha256" in value &&
		(typeof value.targetSemanticSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.targetSemanticSha256))
	) {
		throw new Error(`Invalid authority restore semantic fingerprint: ${file}`);
	}
	if (
		"targetFiles" in value &&
		(!Array.isArray(value.targetFiles) ||
			value.targetFiles.some(
				entry =>
					!isPlainRecord(entry) ||
					typeof entry.name !== "string" ||
					(!AUTHORITY_SUFFIXES.some(suffix => entry.name === suffix) &&
						!AUTHORITY_JSONL_ROTATION_MEMBER.test(entry.name)) ||
					typeof entry.digest !== "string" ||
					!/^[a-f0-9]{64}$/.test(entry.digest),
			))
	)
		throw new Error(`Invalid authority restore file evidence: ${file}`);
	return value as unknown as RestoreManifest;
}

async function readRestoreManifest(
	context: AuthorityExclusiveContext,
): Promise<{ file: string; manifest: RestoreManifest } | undefined> {
	const base = path.basename(context.sessionFile);
	const prefix = `${base}.authority.restore.`;
	const names = (await fs.readdir(path.dirname(context.sessionFile))).filter(
		name => name.startsWith(prefix) && name.endsWith(".json"),
	);
	if (names.length > 1) throw new Error("Multiple authority restore transactions exist; refusing to choose a winner.");
	if (!names.length) return undefined;
	const file = path.join(path.dirname(context.sessionFile), names[0]);
	const bytes = await readPrivate(file);
	if (!bytes) throw new Error("Authority restore manifest disappeared.");
	const manifest = parseRestoreManifest(JSON.parse(bytes.toString("utf8")), file);
	if (names[0] !== `${prefix}${manifest.id}.json` || manifest.owningSessionId !== context.owningSessionId)
		throw new Error("Authority restore manifest does not bind to this root.");
	return { file, manifest };
}

async function writeRestoreManifest(context: AuthorityExclusiveContext, manifest: RestoreManifest): Promise<string> {
	const file = path.join(
		path.dirname(context.sessionFile),
		`${path.basename(context.sessionFile)}.authority.restore.${manifest.id}.json`,
	);
	await writePrivateAtomically(file, Buffer.from(`${JSON.stringify(manifest)}\n`));
	return file;
}

async function ensureBundleFile(context: AuthorityExclusiveContext, name: string, data: Uint8Array): Promise<void> {
	const destination = path.join(path.dirname(context.sessionFile), diskName(path.basename(context.sessionFile), name));
	const existing = await readPrivate(destination);
	if (existing) {
		if (digest(existing) !== digest(data))
			throw new Error(`Refusing to overwrite unrelated authority artifact ${name}.`);
		return;
	}
	await writePrivateAtomically(destination, data);
}

function targetArtifactName(backend: JournalingBackend, suffix: "" | "-wal" | "-shm"): string {
	return `authority.${backend === "sqlite" ? "sqlite" : "jsonl"}${suffix}`;
}

/** Whether bundle member `name` belongs to a `backend` payload: its main file, SQLite sidecars, or JSONL rotation artifacts. */
function payloadMember(backend: JournalingBackend, name: string): boolean {
	if (backend === "sqlite")
		return name === "authority.sqlite" || name === "authority.sqlite-wal" || name === "authority.sqlite-shm";
	return name === "authority.jsonl" || AUTHORITY_JSONL_ROTATION_MEMBER.test(name);
}

/** Copies a bundled payload's members into `directory` under their bundle names, so `directory/authority.<ext>` opens as the store. */
async function writeBundledPayload(
	entries: ReadonlyMap<string, Uint8Array>,
	backend: JournalingBackend,
	directory: string,
	cleanup?: InspectionCleanupState,
): Promise<void> {
	if (!entries.get(targetArtifactName(backend, "")))
		throw new Error("Authority bundle is missing its selected payload.");
	for (const [name, data] of entries) {
		if (!payloadMember(backend, name)) continue;
		const file = path.join(directory, name);
		if (cleanup) {
			const existing = await readPrivate(file, cleanup);
			if (existing && digest(existing) !== digest(data))
				throw new Error("Authority bundle validation stage contains unrelated bytes.");
			if (!existing) await writeInspectionCopy(file, data, cleanup);
		} else await writePrivate(file, data);
	}
}

function semanticFingerprint(value: AuthorityExport): string {
	return canonicalDurableSha256({
		version: value.version,
		revision: value.revision,
		generationHighWater: value.generationHighWater,
		headHash: value.headHash,
		rows: [...value.rows].sort((left, right) =>
			JSON.stringify(left.record).localeCompare(JSON.stringify(right.record)),
		),
		controls: [...value.controls].sort((left, right) => left.key.localeCompare(right.key)),
		frames: [...value.frames].sort((left, right) => left.revision - right.revision),
		...(value.legacy ? { legacy: value.legacy } : {}),
	});
}

async function useStagedPersistence(
	open: () => AuthorityPersistence,
	use: (driver: AuthorityPersistence) => AuthorityExport,
): Promise<AuthorityExport> {
	const cleanup = inspectionCleanup();
	const failures: unknown[] = [];
	let resource: InspectionCleanupResource | undefined;
	let value: AuthorityExport | undefined;
	try {
		const driver = open();
		resource = trackInspectionResource(cleanup, () => driver.close());
		value = use(driver);
	} catch (error) {
		failures.push(error);
		deferNestedInspection(cleanup, error);
		if (error instanceof SqliteAuthorityConstructionError) {
			const construction = trackInspectionResource(cleanup, () => error.cleanup());
			await closeInspectionResource(cleanup, construction);
		}
	}
	if (resource) await closeInspectionResource(cleanup, resource);
	if (failures.length || cleanup.failures.length)
		throw inspectionFailure(failures, cleanup, "Authority staging operation and physical cleanup failed.");
	if (!value) throw new Error("Authority staging did not produce an export.");
	return value;
}

async function importBundleState(
	entries: ReadonlyMap<string, Uint8Array>,
	descriptor: AuthorityDescriptor,
	bundleOwner: string,
	stageDirectory: string,
	targetIdentity: AuthorityIdentity,
): Promise<{ state: AuthorityExport; semanticSha256: string; files: { name: string; digest: string }[] }> {
	const sourceIdentity: AuthorityIdentity = {
		backend: descriptor.backend,
		owningSessionId: bundleOwner,
		incarnation: descriptor.incarnation,
		format: 2,
	};
	const sourceDirectory = path.join(stageDirectory, "source");
	const sourcePath = path.join(sourceDirectory, descriptor.payload);
	await fs.mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
	await writeBundledPayload(entries, descriptor.backend, sourceDirectory);
	const exported = await useStagedPersistence(
		() => openAuthorityPersistence({ path: sourcePath, identity: sourceIdentity, create: false }),
		source => {
			source.integrityCheck();
			return source.exportState();
		},
	);
	const targetPath = path.join(stageDirectory, path.basename(sourcePath));
	const staged = await useStagedPersistence(
		() =>
			openAuthorityPersistence({
				path: targetPath,
				identity: targetIdentity,
				create: true,
				seed: { ...exported, sourceIdentity: targetIdentity },
			}),
		target => {
			target.integrityCheck();
			return target.exportState();
		},
	);
	const expected = { ...exported, sourceIdentity: targetIdentity };
	const semanticSha256 = semanticFingerprint(expected);
	if (semanticFingerprint(staged) !== semanticSha256)
		throw new Error("Restored authority failed complete semantic export verification.");
	const files: { name: string; digest: string }[] = [];
	// A long imported history is created already rotated: its sealed segment, index and snapshot are target files too.
	const stagedFiles =
		targetIdentity.backend === "jsonl"
			? jsonlStoreFiles(targetPath)
			: ["", "-wal", "-shm"].map(suffix => `${targetPath}${suffix}`);
	for (const file of stagedFiles) {
		const bytes = await readPrivate(file);
		if (bytes) {
			const cleanup = inspectionCleanup();
			const handle = await fs.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
			const resource = trackInspectionResource(cleanup, () => handle.close());
			let failure: unknown;
			let failed = false;
			try {
				await durableFsync(handle);
			} catch (error) {
				failed = true;
				failure = error;
			}
			const closed = await closeInspectionResource(cleanup, resource);
			if (failed || !closed)
				throw inspectionFailure(
					failed ? [failure] : [],
					cleanup,
					"Authority staging sync and handle cleanup failed.",
				);
			files.push({ name: path.basename(file), digest: digest(bytes) });
		}
	}
	await syncDirectory(stageDirectory);
	return { state: exported, semanticSha256, files };
}

async function targetMatches(file: string, identity: AuthorityIdentity, expected: AuthorityExport): Promise<boolean> {
	let actual: AuthorityExport;
	try {
		actual = await selectedExport(file, identity);
	} catch (error) {
		if (error instanceof AuthorityInspectionChangedError || error instanceof AggregateError) throw error;
		return false;
	}
	return semanticFingerprint(actual) === semanticFingerprint({ ...expected, sourceIdentity: identity });
}

async function validateBundledState(
	sessionFile: string,
	bundle: AuthorityBundle,
	entries: Map<string, Uint8Array>,
	allowUnresolved: boolean,
): Promise<{ sourceDescriptor?: AuthorityDescriptor; validatedState?: AuthorityExport }> {
	const descriptorBytes = entries.get("authority.json");
	const sourceDescriptor = descriptorBytes
		? validateDescriptorBundle(descriptorBytes, bundle.owningSessionId)
		: undefined;
	validateSelectedBundleArtifacts(entries, sourceDescriptor);
	const legacy = entries.get("authority-v1.jsonl");
	let retainedLegacy: AuthorityExport | undefined;
	if (legacy) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(legacy).toString("utf8"));
		} catch {
			parsed = undefined;
		}
		const record = isPlainRecord(parsed) && isPlainRecord(parsed.record) ? parsed.record : undefined;
		const migrationId = record?.migrationId;
		if (
			typeof migrationId === "string" &&
			UUID_RE.test(migrationId) &&
			digest(legacy) === digest(legacyDenialBytes(migrationId))
		) {
			if (
				!sourceDescriptor ||
				Buffer.from(entries.get("authority-v1.jsonl.quarantine") ?? []).toString("utf8") !==
					LEGACY_AUTHORITY_DENIAL_REASON
			)
				throw new Error("Legacy denial lacks its selected authority and canonical fence.");
			const prefix = `authority.backup.${migrationId}/`;
			const manifestBytes = entries.get(`${prefix}migration.json`);
			if (!manifestBytes) throw new Error("Legacy denial lacks migration provenance.");
			let manifest: unknown;
			try {
				manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
			} catch {
				throw new Error("Invalid legacy migration provenance.");
			}
			if (
				!isPlainRecord(manifest) ||
				manifest.id !== migrationId ||
				manifest.sourceBackend !== "legacy-v1" ||
				!isPlainRecord(manifest.legacyDenial) ||
				manifest.legacyDenial.migrationId !== migrationId ||
				manifest.legacyDenial.digest !== digest(legacy) ||
				!Array.isArray(manifest.sourceFiles)
			)
				throw new Error("Legacy denial provenance does not match its migration.");
			const denial = manifest.legacyDenial;
			if (
				typeof denial.name !== "string" ||
				denial.name.includes("/") ||
				typeof denial.sourceDigest !== "string" ||
				!manifest.sourceFiles.some(
					file => isPlainRecord(file) && file.name === denial.name && file.digest === denial.sourceDigest,
				)
			)
				throw new Error("Legacy denial source provenance is invalid.");
			const original = entries.get(`${prefix}${denial.name}`);
			if (!original || digest(original) !== denial.sourceDigest)
				throw new Error("Legacy denial original evidence is missing or changed.");
			retainedLegacy = await validateLegacyBytes(sessionFile, original);
		} else {
			const legacyState = await validateLegacyBytes(sessionFile, legacy);
			const blockers = unresolvedAuthorityEffects(legacyState);
			if (!allowUnresolved && blockers.length)
				throw new Error(`Cannot restore authority with unresolved effects or claims: ${blockers.join(", ")}`);
		}
	}
	let validatedState: AuthorityExport | undefined;
	if (sourceDescriptor) {
		const validationDirectory = await fs.mkdtemp(path.join(path.dirname(sessionFile), ".authority-bundle-check-"));
		validatedState = await selectedExportFromBundle(
			entries,
			sourceDescriptor,
			bundle.owningSessionId,
			validationDirectory,
		);
		if (
			retainedLegacy &&
			canonicalDurableSha256(retainedLegacy.legacy) !== canonicalDurableSha256(validatedState.legacy)
		)
			throw new Error("Legacy denial backup does not match the selected authority history.");
		const blockers = unresolvedAuthorityEffects(validatedState);
		if (!allowUnresolved && blockers.length)
			throw new Error(`Cannot restore authority with unresolved effects or claims: ${blockers.join(", ")}`);
	}
	return { sourceDescriptor, validatedState };
}

async function completedRestore(
	context: AuthorityExclusiveContext,
	bundle: AuthorityBundle,
	incomingDigest: string,
): Promise<boolean> {
	const prefix = `${path.basename(context.sessionFile)}.authority.backup.`;
	const retainedEvidence = await captureRestoreEvidence(context);
	let completed: RestoreManifest | undefined;
	for (const snapshot of retainedEvidence) {
		const name = path.basename(snapshot.root);
		const directory = path.join(path.dirname(context.sessionFile), name);
		const stat = await fs.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateMode(stat.mode))
			throw new Error("Restore backup provenance is not a private directory.");
		const file = path.join(directory, "restore.json");
		const bytes = snapshot.members.find(member => member.file === file)?.bytes;
		if (!bytes) continue;
		const manifest = parseRestoreManifest(JSON.parse(bytes.toString("utf8")), file);
		if (manifest.id !== name.slice(prefix.length))
			throw new Error("Restore completion provenance does not bind its backup.");
		if (manifest.owningSessionId !== context.owningSessionId || manifest.bundleSha256 !== incomingDigest) continue;
		if (completed) throw new Error("Multiple completed restores claim this bundle.");
		completed = manifest;
	}
	if (!completed) return false;
	const descriptor = await readAuthorityDescriptor(context.sessionFile);
	const identity = completed.targetIdentity;
	if (!identity) {
		if (descriptor) throw new Error("Completed legacy restore has a new selection; refusing stale restoration.");
		for (const entry of bundle.entries) {
			if (entry.name === "authority.lock") continue;
			const bytes = await readPrivate(diskName(context.sessionFile, entry.name));
			if (!bytes || digest(bytes) !== digest(entry.data))
				throw new Error("Completed legacy restore has changed; refusing stale restoration.");
		}
		await verifyRestoreEvidence(context, retainedEvidence);
		return true;
	}
	if (
		!descriptor ||
		!completed.targetSemanticSha256 ||
		descriptor.state !== "active" ||
		descriptor.owningSessionId !== context.owningSessionId ||
		descriptor.incarnation !== identity.incarnation ||
		descriptor.backend !== identity.backend ||
		descriptor.physicalIdentity.dev !== context.physicalIdentity.dev ||
		descriptor.physicalIdentity.ino !== context.physicalIdentity.ino
	)
		throw new Error("Completed restore selection is missing or changed; refusing stale restoration.");
	await validateSelectedDisk(context, descriptor);
	const selectedSnapshot = await captureSelectedArtifacts(context);
	for (const entry of bundle.entries) {
		if (
			entry.name === "authority.json" ||
			entry.name === "authority.lock" ||
			payloadMember(identity.backend, entry.name)
		)
			continue;
		const bytes = await readPrivate(diskName(context.sessionFile, entry.name));
		if (!bytes || digest(bytes) !== digest(entry.data))
			throw new Error("Completed restore metadata provenance is missing or changed.");
	}
	const actual = await selectedExport(
		path.join(path.dirname(context.sessionFile), descriptor.payload),
		identity,
		async cleanup => {
			await verifySelectedArtifacts(context, selectedSnapshot, descriptor, cleanup);
			await validateSelectedDisk(context, descriptor, cleanup);
			await verifyRestoreEvidence(context, retainedEvidence, cleanup);
		},
	);
	if (semanticFingerprint(actual) !== completed.targetSemanticSha256)
		throw new Error("Completed restore has advanced or changed; refusing stale restoration.");
	return true;
}

async function restoreUnderLock(
	context: AuthorityExclusiveContext,
	bundle: AuthorityBundle,
	entries: Map<string, Uint8Array>,
): Promise<void> {
	const base = path.basename(context.sessionFile);
	const incomingDigest = bundleDigest(bundle.entries);
	const descriptorBytes = entries.get("authority.json");
	const { sourceDescriptor, validatedState } = await validateBundledState(context.sessionFile, bundle, entries, false);
	const transaction = await readRestoreManifest(context);
	if (!transaction && (await completedRestore(context, bundle, incomingDigest))) return;
	let manifest: RestoreManifest;
	let manifestPath: string;
	if (transaction) {
		manifest = transaction.manifest;
		manifestPath = transaction.file;
		if (manifest.bundleSha256 !== incomingDigest || manifest.owningSessionId !== context.owningSessionId) {
			throw new Error("A different authority restore is already staged for this root.");
		}
	} else {
		const existing = await fs.readdir(path.dirname(context.sessionFile));
		const prefix = `${base}.authority`;
		const unrelated = existing.filter(
			name =>
				name.startsWith(prefix) && name !== `${base}.authority.lock` && !isAuthorityRecoveryFileName(base, name),
		);
		if (unrelated.length)
			throw new Error(`Cannot restore authority over existing root artifacts: ${unrelated.join(", ")}`);
		const id = randomUUID();
		manifest = {
			version: 1,
			id,
			bundleSha256: incomingDigest,
			owningSessionId: context.owningSessionId,
			stageName: id,
		};
		manifestPath = await writeRestoreManifest(context, manifest);
	}

	if (sourceDescriptor) {
		const targetIdentity: AuthorityIdentity = manifest.targetIdentity ?? {
			backend: sourceDescriptor.backend,
			owningSessionId: context.owningSessionId,
			incarnation: randomUUID(),
			format: 2,
		};
		if (
			targetIdentity.backend !== sourceDescriptor.backend ||
			targetIdentity.owningSessionId !== context.owningSessionId
		) {
			throw new Error("Authority restore target identity does not match the bundled backend or destination root.");
		}
		const stageDirectory = path.join(
			path.dirname(context.sessionFile),
			`${base}.authority.stage.${manifest.stageName}`,
		);
		const installedTarget = path.join(path.dirname(context.sessionFile), `${base}.${sourceDescriptor.payload}`);
		let imported:
			| { state: AuthorityExport; semanticSha256: string; files: { name: string; digest: string }[] }
			| undefined;
		let targetReady = false;
		if (!validatedState) throw new Error("Validated authority bundle export is unavailable.");
		if (
			manifest.targetSemanticSha256 &&
			(await targetMatches(installedTarget, targetIdentity, { ...validatedState, sourceIdentity: targetIdentity }))
		)
			targetReady = true;
		if (!targetReady) {
			await fs.rm(stageDirectory, { recursive: true, force: true });
			await fs.mkdir(stageDirectory, { mode: 0o700 });
			imported = await importBundleState(
				entries,
				sourceDescriptor,
				bundle.owningSessionId,
				stageDirectory,
				targetIdentity,
			);
			if (manifest.targetSemanticSha256 && imported.semanticSha256 !== manifest.targetSemanticSha256) {
				throw new Error("Authority restore bundle semantics changed during restart.");
			}
			manifest = {
				...manifest,
				targetIdentity,
				targetSemanticSha256: imported.semanticSha256,
				targetFiles: mergeFiles(manifest.targetFiles, imported.files),
			};
			manifestPath = await writeRestoreManifest(context, manifest);
		}
		if (!manifest.targetSemanticSha256 || !manifest.targetFiles)
			throw new Error("Authority restore target is missing durable staging evidence.");
		// Bundled payload members (the selected file, SQLite sidecars, JSONL rotation artifacts) are archived as
		// provenance; the restored target is a fresh store seeded from their complete export.
		const selectedPayload = (name: string): boolean => payloadMember(sourceDescriptor.backend, name);
		for (const [name, data] of entries) {
			if (name === "authority.lock" || name === "authority.json") continue;
			if (name.startsWith("authority.backup.")) {
				await ensureBundleFile(context, name, data);
				continue;
			}
			if (selectedPayload(name)) continue;
			await ensureBundleFile(context, name, data);
		}
		const provenance = `authority.backup.${manifest.id}`;
		for (const [name, data] of entries) {
			if (!selectedPayload(name)) continue;
			const archivedName = `${provenance}/source.${name.slice("authority.".length)}`;
			await ensureBundleFile(context, archivedName, data);
		}
		if (descriptorBytes) await ensureBundleFile(context, `${provenance}/source.authority.json`, descriptorBytes);
		await ensureBundleFile(context, `${provenance}/source.authority.lock`, entries.get("authority.lock")!);
		if (!targetReady)
			await publishRestoredTarget(context, manifest, stageDirectory, imported?.state ?? validatedState);
		const actualDescriptor = await readAuthorityDescriptor(context.sessionFile);
		if (!actualDescriptor) {
			await writeAuthorityDescriptor(context.sessionFile, {
				version: 1,
				revision: 1,
				owningSessionId: context.owningSessionId,
				backend: targetIdentity.backend,
				format: 2,
				incarnation: targetIdentity.incarnation,
				payload: `${base}.${targetIdentity.backend === "sqlite" ? "authority.sqlite" : "authority.jsonl"}`,
				state: "initializing",
				physicalIdentity: context.physicalIdentity,
			});
		} else if (
			actualDescriptor.owningSessionId !== context.owningSessionId ||
			actualDescriptor.backend !== targetIdentity.backend ||
			actualDescriptor.incarnation !== targetIdentity.incarnation ||
			actualDescriptor.physicalIdentity.dev !== context.physicalIdentity.dev ||
			actualDescriptor.physicalIdentity.ino !== context.physicalIdentity.ino
		)
			throw new Error("An unrelated authority descriptor appeared during restore.");
		const activationDescriptor = await readAuthorityDescriptor(context.sessionFile);
		if (!activationDescriptor)
			throw new Error("Authority restore selector is missing before activation verification.");
		const activationSnapshot = await captureSelectedArtifacts(context);
		const retainedEvidence = await captureRestoreEvidence(context);
		const expectedEvidence = new Map<string, Uint8Array>();
		for (const [name, data] of entries) {
			if (name.startsWith("authority.backup.")) expectedEvidence.set(diskName(context.sessionFile, name), data);
			if (selectedPayload(name))
				expectedEvidence.set(
					diskName(context.sessionFile, `${provenance}/source.${name.slice("authority.".length)}`),
					data,
				);
		}
		if (descriptorBytes)
			expectedEvidence.set(diskName(context.sessionFile, `${provenance}/source.authority.json`), descriptorBytes);
		expectedEvidence.set(
			diskName(context.sessionFile, `${provenance}/source.authority.lock`),
			entries.get("authority.lock")!,
		);
		for (const [file, data] of expectedEvidence) {
			const member = retainedEvidence
				.flatMap(snapshot => snapshot.members)
				.find(candidate => candidate.file === file);
			if (!member?.bytes || !member.bytes.equals(Buffer.from(data))) throw new AuthorityInspectionChangedError(file);
		}
		const verified = await selectedExport(installedTarget, targetIdentity, async cleanup => {
			await verifySelectedArtifacts(context, activationSnapshot, activationDescriptor, cleanup);
			await verifyRestoreEvidence(context, retainedEvidence, cleanup);
		});
		if (semanticFingerprint(verified) !== manifest.targetSemanticSha256)
			throw new Error("Restored target changed before descriptor activation.");
		const current = await readAuthorityDescriptor(context.sessionFile);
		if (current?.state === "initializing") {
			await writeAuthorityDescriptor(context.sessionFile, {
				...current,
				revision: current.revision + 1,
				state: "active",
			});
		} else if (current?.state !== "active") {
			throw new Error("Authority restore selector is not safely activatable.");
		}
	} else {
		for (const [name, data] of entries) {
			if (name === "authority.lock") continue;
			await ensureBundleFile(context, name, data);
		}
	}
	await ensureBundleFile(
		context,
		`authority.backup.${manifest.id}/restore.json`,
		Buffer.from(`${JSON.stringify(manifest)}\n`),
	);
	await syncDirectory(path.dirname(context.sessionFile));
	await fs.rm(path.join(path.dirname(context.sessionFile), `${base}.authority.stage.${manifest.stageName}`), {
		recursive: true,
		force: true,
	});
	await fs.rm(manifestPath, { force: true });
	await syncDirectory(path.dirname(context.sessionFile));
}

function mergeFiles(
	existing: RestoreManifest["targetFiles"],
	added: readonly { name: string; digest: string }[],
): { name: string; digest: string }[] {
	const merged = new Map<string, { name: string; digest: string }>();
	for (const file of [...(existing ?? []), ...added]) merged.set(`${file.name}\0${file.digest}`, file);
	return [...merged.values()].sort((left, right) =>
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

async function selectedExportFromBundle(
	entries: ReadonlyMap<string, Uint8Array>,
	descriptor: AuthorityDescriptor,
	owner: string,
	stageDirectory: string,
): Promise<AuthorityExport> {
	const cleanup = inspectionCleanup();
	retainInspectionDirectory(cleanup, stageDirectory);
	const sourceDirectory = path.join(stageDirectory, "source");
	const sourcePath = path.join(sourceDirectory, descriptor.payload);
	const failures: unknown[] = [];
	let driverResource: InspectionCleanupResource | undefined;
	let exported: AuthorityExport | undefined;
	try {
		await fs.mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
		await writeBundledPayload(entries, descriptor.backend, sourceDirectory, cleanup);
		const driver = openAuthorityPersistence({
			path: sourcePath,
			identity: {
				backend: descriptor.backend,
				owningSessionId: owner,
				incarnation: descriptor.incarnation,
				format: 2,
			},
			create: false,
		});
		driverResource = trackInspectionResource(cleanup, () => driver.close());
		driver.integrityCheck();
		exported = driver.exportState();
	} catch (error) {
		failures.push(error);
		if (error instanceof SqliteAuthorityConstructionError) {
			const constructionCleanup = trackInspectionResource(cleanup, () => error.cleanup());
			await closeInspectionResource(cleanup, constructionCleanup);
		}
	}
	if (driverResource) await closeInspectionResource(cleanup, driverResource);
	await disposeInspection(cleanup);
	if (failures.length || cleanup.failures.length)
		throw inspectionFailure(
			failures,
			cleanup,
			"Authority bundle inspection, driver close, or snapshot cleanup failed.",
		);
	if (!exported) throw new Error("Authority bundle inspection did not produce an export.");
	return exported;
}

async function publishRestoredTarget(
	context: AuthorityExclusiveContext,
	manifest: RestoreManifest,
	stageDirectory: string,
	exported: AuthorityExport,
): Promise<void> {
	if (!manifest.targetIdentity || !manifest.targetFiles)
		throw new Error("Authority restore manifest lacks target publication evidence.");
	const stagePath = path.join(
		stageDirectory,
		`${manifest.targetIdentity.backend === "sqlite" ? "authority.sqlite" : "authority.jsonl"}`,
	);
	const activePath = path.join(
		path.dirname(context.sessionFile),
		`${path.basename(context.sessionFile)}.${manifest.targetIdentity.backend === "sqlite" ? "authority.sqlite" : "authority.jsonl"}`,
	);
	const digests = new Map(
		manifest.targetFiles.map(file => [
			file.name,
			new Set([...(manifest.targetFiles ?? []).filter(item => item.name === file.name).map(item => item.digest)]),
		]),
	);
	// Rotation files go first: the store a reader can open appears only with its payload, published below.
	for (const name of [...digests.keys()]
		.filter(name => manifest.targetIdentity?.backend === "jsonl" && AUTHORITY_JSONL_ROTATION_MEMBER.test(name))
		.sort()) {
		const active = diskName(context.sessionFile, name);
		const staged = path.join(stageDirectory, name);
		const activeBytes = await readPrivate(active);
		const stageBytes = await readPrivate(staged);
		if (activeBytes && digest(activeBytes) !== (stageBytes ? digest(stageBytes) : undefined)) {
			if (!digests.get(name)?.has(digest(activeBytes)))
				throw new Error(`Refusing to overwrite unrelated restore target bytes: ${active}`);
			await fs.rm(active);
		}
		if (stageBytes && (!activeBytes || digest(activeBytes) !== digest(stageBytes))) await fs.rename(staged, active);
		if (!(await readPrivate(active)))
			throw new Error(`Restored authority rotation file disappeared before selection: ${active}`);
	}
	await syncDirectory(path.dirname(context.sessionFile));
	for (const suffix of ["", "-wal", "-shm"] as const) {
		const active = `${activePath}${suffix}`;
		const staged = `${stagePath}${suffix}`;
		const activeBytes = await readPrivate(active);
		const stageBytes = await readPrivate(staged);
		if (activeBytes && digest(activeBytes) !== (stageBytes ? digest(stageBytes) : undefined)) {
			const allowed = digests.get(targetArtifactName(manifest.targetIdentity.backend, suffix));
			if (!allowed?.has(digest(activeBytes)))
				throw new Error(`Refusing to overwrite unrelated restore target bytes: ${active}`);
			await fs.rm(active);
		}
		if (stageBytes && (!activeBytes || digest(activeBytes) !== digest(stageBytes))) await fs.rename(staged, active);
		if (suffix === "" && !(await readPrivate(active)))
			throw new Error("Restored authority payload disappeared before selection.");
		await syncDirectory(path.dirname(activePath));
	}
	if (
		!(await targetMatches(activePath, manifest.targetIdentity, {
			...exported,
			sourceIdentity: manifest.targetIdentity,
		}))
	) {
		throw new Error("Published authority bundle failed complete semantic verification.");
	}
}

export async function retainAuthorityBundleProvenance(sessionFile: string, bundle: AuthorityBundle): Promise<void> {
	const entries = validateBundle(bundle);
	await closeSessionAuthority(sessionFile);
	await withAuthorityExclusive(sessionFile, async context => {
		const descriptor = await readAuthorityDescriptor(context.sessionFile);
		if (!descriptor || descriptor.state !== "active" || descriptor.owningSessionId !== context.owningSessionId)
			throw new Error("A selected fresh authority is required for fork provenance.");
		const identity: AuthorityIdentity = {
			backend: descriptor.backend,
			owningSessionId: descriptor.owningSessionId,
			incarnation: descriptor.incarnation,
			format: 2,
		};
		const selectedSnapshot = await captureSelectedArtifacts(context);

		await selectedExport(
			path.join(path.dirname(context.sessionFile), descriptor.payload),
			identity,
			async cleanup => {
				await verifySelectedArtifacts(context, selectedSnapshot, descriptor, cleanup);
				await validateSelectedDisk(context, descriptor, cleanup);
			},
		);
		const prefix = `authority.backup.${randomUUID()}/displaced`;
		for (const [name, data] of entries) await ensureBundleFile(context, `${prefix}/${name}`, data);
		await syncDirectory(path.dirname(context.sessionFile));
	});
}

/** Offline restore requires source stop and post-backup reconciliation; a fresh incarnation cannot discover disconnected originals. */
export async function restoreAuthorityBundle(sessionFile: string, bundle: AuthorityBundle): Promise<void> {
	const entries = validateBundle(bundle);
	await validateBundledState(sessionFile, bundle, entries, false);
	await closeSessionAuthority(sessionFile);
	const lifecycle = await findRelocation(sessionFile);
	if (lifecycle) {
		if (lifecycle.manifest.kind !== "delete" || lifecycle.manifest.phase !== "complete")
			throw new AuthorityRelocationInterruptedError(
				lifecycle.manifest.target,
				new Error("Finish or abort the pending lifecycle operation before explicit restore."),
			);
		await releaseCompletedDeletion(lifecycle, await readAuthoritySessionId(sessionFile));
	}
	await withAuthorityExclusive(sessionFile, context => restoreUnderLock(context, bundle, entries), { create: true });
}

export async function moveAuthorityBundle(source: string, target: string): Promise<void> {
	if (path.resolve(source) === path.resolve(target)) return;
	await relocateSessionAuthority(source, target);
}

function unresolvedAuthorityEffects(exported: AuthorityExport): string[] {
	const blocked: string[] = [];
	for (const row of exported.rows) {
		const record = row.record;
		switch (record.kind) {
			case "operation":
				if (!["completed", "failed", "abandoned", "cancelled"].includes(record.phase))
					blocked.push(`operation:${record.operationId}:${record.phase}`);
				break;
			case "resource":
				if (!["completed", "cancelled", "abandoned"].includes(record.phase))
					blocked.push(`resource:${record.resourceId}:${record.phase}`);
				break;
			case "transition":
				if (!["retired", "recovered"].includes(record.phase))
					blocked.push(`transition:${record.transitionId}:${record.phase}`);
				break;
			case "construction":
				if (!["activated", "abandoned"].includes(record.phase))
					blocked.push(`construction:${record.actorId}:${record.generation}:${record.phase}`);
				break;
			case "local-entry":
				if (["reserved", "intent", "effect"].includes(record.phase))
					blocked.push(`local-entry:${record.localId}:${record.entryId}:${record.phase}`);
				break;
		}
	}
	for (const control of exported.controls) if (control.key.startsWith("local-claim:")) blocked.push(control.key);
	return blocked;
}

export async function deleteAuthorityBundle(sessionFile: string): Promise<void> {
	const initial = await inspectAuthorityArtifacts(sessionFile);
	if (!initial.any) return;
	await runAuthorityRelocation(sessionFile, sessionFile, "delete-authority", {});
}

export type AuthorityRelocationCut =
	| "guards-installed"
	| "target-transcript"
	| "target-artifacts"
	| "target-payload"
	| "before-selection"
	| "selected"
	| "source-authority-retired"
	| "source-transcript-retired"
	| "completed";

export class AuthorityRelocationInterruptedError extends Error {
	constructor(
		readonly recoverySessionFile: string,
		cause: unknown,
	) {
		super(
			`Authority relocation for ${recoverySessionFile} retains recovery evidence: ${String(cause)}. Use explicit finish or abort recovery before reopening this manager.`,
			{ cause },
		);
		this.name = "AuthorityRelocationInterruptedError";
	}
}

export interface AuthorityRelocationPublication {
	readonly size: number;
	readonly identity: { readonly dev: number; readonly ino: number };
}

interface RelocationEntry {
	readonly name: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly mode: number;
	readonly mtimeMs: number;
	readonly sha256?: string;
	readonly link?: string;
	readonly identity?: AuthorityPhysicalIdentity;
}
interface RelocationSnapshot {
	readonly sessionFile: string;
	readonly anchor: AuthorityPhysicalIdentity;
	readonly source: boolean;
	readonly entries: readonly RelocationEntry[];
}
interface RelocationManifest {
	readonly version: 1;
	readonly id: string;
	readonly owningSessionId: string;
	readonly kind: "move" | "replace" | "delete" | "delete-authority";
	readonly phase: "prepared" | "selected" | "complete" | "aborted";
	readonly snapshots: readonly RelocationSnapshot[];
	readonly target: string;
	readonly targetEntries: readonly RelocationEntry[];
	readonly cwd?: string;
	readonly incomingEntries?: readonly RelocationEntry[];
	readonly targetDescriptor?: AuthorityDescriptor;
	readonly targetSemanticSha256?: string;
	readonly targetRevision?: number;
	readonly targetHeadHash?: string;
}
interface CapturedRelocation {
	readonly snapshot: RelocationSnapshot;
	readonly data: ReadonlyMap<string, Uint8Array>;
	readonly bundle: AuthorityBundle | null;
}
export interface AuthoritySessionReplacement {
	readonly sources: readonly string[];
	readonly target: string;
	readonly owningSessionId: string;
	readonly transcript: Uint8Array;
	readonly artifacts: readonly { readonly name: string; readonly data: Uint8Array }[];
	readonly authority?: AuthorityBundle;
	readonly cwd: string;
	readonly faultAt?: AuthorityRelocationCut;
	readonly revalidateSources?: () => Promise<void>;
	readonly validateSource?: (sessionFile: string, transcript: Uint8Array) => void;
}

function relocationStage(sessionFile: string, id: string): string {
	return `${sessionFile}.authority.stage.${id}`;
}
function relocationBackup(sessionFile: string, id: string): string {
	return `${sessionFile}.authority.backup.${id}`;
}
function artifactDirectory(sessionFile: string): string | undefined {
	return sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -6) : undefined;
}
function relativeMember(name: string): boolean {
	return (
		Boolean(name) &&
		!name.startsWith("/") &&
		!name.includes("\\") &&
		!name.includes("\0") &&
		name.split("/").every(part => part !== "" && part !== "." && part !== "..")
	);
}
function relocationMember(name: string): boolean {
	if (name === "transcript" || name === "artifacts" || name.startsWith("artifacts/")) return relativeMember(name);
	if (!name.startsWith("authority/")) return false;
	const member = name.slice(10);
	return safeBundleName(member) || /^authority\.backup\.[a-f0-9-]{36}$/.test(member);
}
function relocationPath(sessionFile: string, name: string): string {
	if (!relocationMember(name)) throw new Error(`Unsafe relocation member: ${name}`);
	if (name === "transcript") return sessionFile;
	if (name.startsWith("authority/")) return diskName(sessionFile, name.slice(10));
	const root = artifactDirectory(sessionFile);
	if (!root) throw new Error("Artifact relocation requires a .jsonl transcript path.");
	return name === "artifacts" ? root : path.join(root, name.slice(10));
}
function sameAnchor(left: AuthorityPhysicalIdentity, right: AuthorityPhysicalIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}
function relocationFault(cut: AuthorityRelocationCut | undefined, at: AuthorityRelocationCut): void {
	if (cut === at) throw new Error(`Injected relocation fault at ${at}`);
}

async function captureRelocationPath(
	sessionFile: string,
	name: string,
	entries: RelocationEntry[],
	data: Map<string, Uint8Array>,
	authority: boolean,
): Promise<void> {
	const file = relocationPath(sessionFile, name);
	let stat;
	try {
		stat = await fs.lstat(file, { bigint: true });
	} catch (error) {
		if (isFsError(error, "ENOENT")) return;
		throw error;
	}
	const common = {
		name,
		mode: Number(stat.mode & 0o777n),
		mtimeMs: Number(stat.mtimeNs) / 1_000_000,
		identity: { dev: String(stat.dev), ino: String(stat.ino) },
	};
	if (stat.isSymbolicLink()) {
		if (authority || name === "transcript" || name === "artifacts")
			throw new Error(`Cannot relocate symbolic authority, transcript or artifact roots: ${file}`);
		entries.push({ ...common, kind: "symlink", link: await fs.readlink(file) });
		return;
	}
	if (stat.isDirectory()) {
		if (authority && !hasPrivateMode(stat.mode))
			throw new Error(`Authority relocation directories must be private: ${file}`);
		entries.push({ ...common, kind: "directory" });
		for (const child of (await fs.readdir(file)).sort())
			await captureRelocationPath(sessionFile, `${name}/${child}`, entries, data, authority);
		return;
	}
	if (!stat.isFile() || (authority && (stat.nlink !== 1n || !hasPrivateMode(stat.mode))))
		throw new Error(`Invalid relocation file: ${file}`);
	const handle = await fs.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
	const cleanup = inspectionCleanup();
	const resource = trackInspectionResource(cleanup, () => handle.close());
	let bytes: Buffer | undefined;
	let failure: unknown;
	let failed = false;
	try {
		const before = await handle.stat({ bigint: true });
		bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		const current = await fs.lstat(file, { bigint: true });
		if (
			before.dev !== stat.dev ||
			before.ino !== stat.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			current.size !== after.size ||
			current.mtimeNs !== after.mtimeNs ||
			current.ctimeNs !== after.ctimeNs
		)
			throw new Error(`Relocation source changed while capturing: ${file}`);
	} catch (error) {
		failed = true;
		failure = error;
	}
	const closed = await closeInspectionResource(cleanup, resource);
	if (failed || !closed)
		throw inspectionFailure(
			failed ? [failure] : [],
			cleanup,
			`Relocation source capture and handle cleanup failed: ${file}`,
		);
	if (bytes === undefined) throw new Error(`Relocation source file produced no captured bytes: ${file}`);
	entries.push({ ...common, kind: "file", sha256: digest(bytes) });
	data.set(name, bytes);
}

async function captureRelocation(
	context: AuthorityExclusiveContext,
	source: boolean,
	ignoredOperation?: string,
): Promise<{ snapshot: RelocationSnapshot; data: Map<string, Uint8Array> }> {
	const entries: RelocationEntry[] = [];
	const data = new Map<string, Uint8Array>();
	await captureRelocationPath(context.sessionFile, "transcript", entries, data, false);
	for (const name of await listAuthorityNames(context)) {
		if (
			ignoredOperation &&
			(name === path.basename(relocationStage(context.sessionFile, ignoredOperation)) ||
				name === path.basename(relocationBackup(context.sessionFile, ignoredOperation)))
		)
			continue;
		await captureRelocationPath(
			context.sessionFile,
			`authority/${bundleName(path.basename(context.sessionFile), name)}`,
			entries,
			data,
			true,
		);
	}
	if (artifactDirectory(context.sessionFile))
		await captureRelocationPath(context.sessionFile, "artifacts", entries, data, false);
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return { snapshot: { sessionFile: context.sessionFile, anchor: context.physicalIdentity, source, entries }, data };
}

function relocationIdentity(value: unknown): value is AuthorityPhysicalIdentity {
	return (
		isPlainRecord(value) &&
		typeof value.dev === "string" &&
		/^\d+$/.test(value.dev) &&
		typeof value.ino === "string" &&
		/^\d+$/.test(value.ino) &&
		Object.keys(value).sort().join("\0") === "dev\0ino"
	);
}
function relocationEntry(value: unknown): value is RelocationEntry {
	if (
		!isPlainRecord(value) ||
		typeof value.name !== "string" ||
		!relocationMember(value.name) ||
		!Number.isSafeInteger(value.mode) ||
		Number(value.mode) < 0 ||
		Number(value.mode) > 0o777 ||
		typeof value.mtimeMs !== "number" ||
		!Number.isFinite(value.mtimeMs) ||
		(value.identity !== undefined && !relocationIdentity(value.identity))
	)
		return false;
	if (Object.keys(value).some(key => !["name", "kind", "mode", "mtimeMs", "identity", "sha256", "link"].includes(key)))
		return false;
	return value.kind === "file"
		? typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && value.link === undefined
		: value.kind === "symlink"
			? value.name.startsWith("artifacts") &&
				typeof value.link === "string" &&
				!value.link.includes("\0") &&
				value.sha256 === undefined
			: value.kind === "directory" && value.sha256 === undefined && value.link === undefined;
}
function relocationEntries(value: unknown): value is readonly RelocationEntry[] {
	if (
		!Array.isArray(value) ||
		!value.every(relocationEntry) ||
		new Set(value.map(entry => entry.name)).size !== value.length
	)
		return false;
	const entries = new Map(value.map(entry => [entry.name, entry]));
	return value.every(entry => {
		const parts = entry.name.split("/");
		for (let size = entry.name.startsWith("authority/") ? 2 : 1; size < parts.length; size++)
			if (entries.get(parts.slice(0, size).join("/"))?.kind !== "directory") return false;
		return true;
	});
}
function relocationSnapshot(value: unknown): value is RelocationSnapshot {
	return (
		isPlainRecord(value) &&
		Object.keys(value).sort().join("\0") === "anchor\0entries\0sessionFile\0source" &&
		typeof value.sessionFile === "string" &&
		path.isAbsolute(value.sessionFile) &&
		path.resolve(value.sessionFile) === value.sessionFile &&
		typeof value.source === "boolean" &&
		relocationIdentity(value.anchor) &&
		relocationEntries(value.entries)
	);
}
function relocationManifest(value: unknown): value is RelocationManifest {
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		!UUID_RE.test(value.id) ||
		typeof value.owningSessionId !== "string" ||
		!UUID_RE.test(value.owningSessionId) ||
		!["move", "replace", "delete", "delete-authority"].includes(String(value.kind)) ||
		!["prepared", "selected", "complete", "aborted"].includes(String(value.phase)) ||
		!Array.isArray(value.snapshots) ||
		!value.snapshots.length ||
		!value.snapshots.every(relocationSnapshot) ||
		new Set(value.snapshots.map(snapshot => snapshot.sessionFile)).size !== value.snapshots.length ||
		typeof value.target !== "string" ||
		!value.snapshots.some(snapshot => snapshot.sessionFile === value.target) ||
		!relocationEntries(value.targetEntries)
	)
		return false;
	if (
		Object.keys(value).some(
			key =>
				![
					"version",
					"id",
					"owningSessionId",
					"kind",
					"phase",
					"snapshots",
					"target",
					"targetEntries",
					"cwd",
					"incomingEntries",
					"targetDescriptor",
					"targetSemanticSha256",
					"targetRevision",
					"targetHeadHash",
				].includes(key),
		) ||
		(value.cwd !== undefined &&
			(typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || path.resolve(value.cwd) !== value.cwd)) ||
		(value.incomingEntries !== undefined && !relocationEntries(value.incomingEntries))
	)
		return false;
	if (value.targetDescriptor !== undefined) {
		if (!isPlainRecord(value.targetDescriptor)) return false;
		try {
			validateDescriptorBundle(
				Buffer.from(
					JSON.stringify({
						...value.targetDescriptor,
						payload: value.targetDescriptor.backend === "sqlite" ? "authority.sqlite" : "authority.jsonl",
					}),
				),
				value.owningSessionId,
			);
		} catch {
			return false;
		}
		if (
			value.targetDescriptor.payload !==
				`${path.basename(value.target)}.${value.targetDescriptor.backend === "sqlite" ? "authority.sqlite" : "authority.jsonl"}` ||
			typeof value.targetSemanticSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.targetSemanticSha256) ||
			!Number.isSafeInteger(value.targetRevision) ||
			Number(value.targetRevision) < 0 ||
			typeof value.targetHeadHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.targetHeadHash)
		)
			return false;
	} else if (
		value.targetSemanticSha256 !== undefined ||
		value.targetRevision !== undefined ||
		value.targetHeadHash !== undefined
	)
		return false;
	return true;
}
function relocationImmutable(manifest: RelocationManifest): string {
	return canonicalDurableSha256({ ...manifest, phase: "prepared" });
}
function relocationManifestBytes(manifest: RelocationManifest): Buffer {
	return Buffer.from(`${JSON.stringify({ manifest, sha256: canonicalDurableSha256(manifest) })}\n`);
}
async function readRelocationRecord(directory: string): Promise<RelocationManifest | undefined> {
	let stat;
	try {
		stat = await fs.lstat(directory);
	} catch (error) {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateMode(stat.mode))
		throw new Error(`Relocation provenance is not a private real directory: ${directory}`);
	const bytes = await readPrivate(path.join(directory, "relocation.json"));
	if (!bytes) return undefined;
	const parsed: unknown = JSON.parse(bytes.toString("utf8"));
	if (
		!isPlainRecord(parsed) ||
		Object.keys(parsed).sort().join("\0") !== "manifest\0sha256" ||
		!relocationManifest(parsed.manifest) ||
		parsed.sha256 !== canonicalDurableSha256(parsed.manifest)
	)
		throw new Error(`Invalid relocation provenance: ${directory}`);
	return parsed.manifest;
}

interface RelocationPlan {
	readonly entries: readonly RelocationEntry[];
	readonly data: ReadonlyMap<string, Uint8Array>;
	readonly descriptor?: AuthorityDescriptor;
	readonly state?: AuthorityExport;
	readonly incoming?: { readonly entries: readonly RelocationEntry[]; readonly data: ReadonlyMap<string, Uint8Array> };
}

/**
 * Where the published transcript's `authorityRoot` stamp must point: at the target when a bundle is
 * selected there (`selected`), or when the stamp still names one of the relocated `sources`. Any other
 * stamp (a child's owning parent, or the original of a bundle-less copy) is adoption evidence and is kept.
 */
interface RelocationRootStamp {
	readonly target: string;
	readonly sources: readonly string[];
	readonly selected: boolean;
}

function rewriteRelocationTranscript(
	bytes: Uint8Array,
	owner: string,
	cwd?: string,
	previous?: string,
	stamp?: RelocationRootStamp,
): Uint8Array {
	const text = Buffer.from(bytes).toString("utf8");
	let offset = 0;
	for (const line of text.split("\n")) {
		let header: unknown;
		try {
			header = JSON.parse(line);
		} catch {
			offset += line.length + 1;
			continue;
		}
		if (!isPlainRecord(header) || header.type !== "session") {
			offset += line.length + 1;
			continue;
		}
		if (header.id !== owner) throw new Error("Relocation transcript UUID does not match its owning session.");
		const restamp =
			stamp !== undefined &&
			header.authorityRoot !== stamp.target &&
			(stamp.selected || (typeof header.authorityRoot === "string" && stamp.sources.includes(header.authorityRoot)));
		if (!cwd && !previous && !restamp) return bytes;
		if (restamp) header.authorityRoot = stamp.target;
		if (cwd) {
			header.cwd = path.resolve(cwd);
			if (Array.isArray(header.additionalDirectories)) {
				const remaining = header.additionalDirectories.filter(directory => directory !== header.cwd);
				if (remaining.length) header.additionalDirectories = remaining;
				else delete header.additionalDirectories;
			}
		}
		if (previous)
			header.previousSessionFiles = [
				...new Set([...(Array.isArray(header.previousSessionFiles) ? header.previousSessionFiles : []), previous]),
			];
		return Buffer.from(`${text.slice(0, offset)}${JSON.stringify(header)}${text.slice(offset + line.length)}`);
	}
	throw new Error("Relocation transcript has no valid owning session header.");
}

function addPlanParents(entries: Map<string, RelocationEntry>, name: string, at: number): void {
	const parts = name.split("/");
	for (let size = name.startsWith("authority/") ? 2 : 1; size < parts.length; size++) {
		const parent = parts.slice(0, size).join("/");
		const existing = entries.get(parent);
		if (existing && existing.kind !== "directory")
			throw new Error(`Relocation plan parent collides with a file: ${parent}`);
		if (!existing) entries.set(parent, { name: parent, kind: "directory", mode: 0o700, mtimeMs: at });
	}
}
function putPlanFile(
	entries: Map<string, RelocationEntry>,
	data: Map<string, Uint8Array>,
	name: string,
	bytes: Uint8Array,
	mode = 0o600,
	at = Date.now(),
): void {
	if (!relocationMember(name)) throw new Error(`Invalid relocation publication name: ${name}`);
	if (entries.get(name)?.kind === "directory")
		throw new Error(`Relocation file collides with a planned directory: ${name}`);
	addPlanParents(entries, name, at);
	entries.set(name, { name, kind: "file", mode, mtimeMs: at, sha256: digest(bytes) });
	data.set(name, bytes);
}
function copyPlanEntry(
	entries: Map<string, RelocationEntry>,
	data: Map<string, Uint8Array>,
	entry: RelocationEntry,
	captured: ReadonlyMap<string, Uint8Array>,
): void {
	addPlanParents(entries, entry.name, entry.mtimeMs);
	entries.set(entry.name, {
		name: entry.name,
		kind: entry.kind,
		mode: entry.mode,
		mtimeMs: entry.mtimeMs,
		...(entry.sha256 ? { sha256: entry.sha256 } : {}),
		...(entry.link !== undefined ? { link: entry.link } : {}),
	});
	if (entry.kind === "file") {
		const bytes = captured.get(entry.name);
		if (!bytes || digest(bytes) !== entry.sha256) throw new Error(`Missing captured relocation bytes: ${entry.name}`);
		data.set(entry.name, bytes);
	}
}
function canMergeArtifact(entries: ReadonlyMap<string, RelocationEntry>, entry: RelocationEntry): boolean {
	const parts = entry.name.split("/");
	for (let size = 1; size < parts.length; size++)
		if (entries.get(parts.slice(0, size).join("/"))?.kind !== "directory") return false;
	if (entries.has(entry.name)) return false;
	const id = /^(\d+)\./.exec(parts.at(-1)!)?.[1];
	if (!id) return true;
	const parent = parts.slice(0, -1).join("/");
	for (const name of entries.keys())
		if (path.posix.dirname(name) === parent && /^(\d+)\./.exec(path.posix.basename(name))?.[1] === id) return false;
	return true;
}

async function prepareRelocationPlan(
	context: AuthorityRelocationExclusiveContext,
	captures: readonly CapturedRelocation[],
	primary: string,
	kind: RelocationManifest["kind"],
	directory: string,
	options: { cwd?: string; replacement?: AuthoritySessionReplacement },
): Promise<RelocationPlan> {
	const entries = new Map<string, RelocationEntry>();
	const data = new Map<string, Uint8Array>();
	const source = captures.find(capture => capture.snapshot.sessionFile === primary);
	const target = captures.find(capture => capture.snapshot.sessionFile === context.target.sessionFile);
	if (!target || !source) throw new Error("Relocation capture does not include its selected endpoints.");
	if (kind === "delete" || kind === "delete-authority") {
		if (kind === "delete-authority") {
			for (const entry of source.snapshot.entries)
				if (!entry.name.startsWith("authority/")) copyPlanEntry(entries, data, entry, source.data);
			putPlanFile(
				entries,
				data,
				"authority/authority-v1.jsonl.quarantine",
				Buffer.from(LEGACY_AUTHORITY_DENIAL_REASON),
			);
		}
		return { entries: [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)), data };
	}
	let descriptor: AuthorityDescriptor | undefined;
	let state: AuthorityExport | undefined;
	let incoming: RelocationPlan["incoming"];
	const replacement = options.replacement;
	if (replacement) {
		const incomingEntries = new Map<string, RelocationEntry>();
		const incomingData = new Map<string, Uint8Array>();
		putPlanFile(incomingEntries, incomingData, "transcript", replacement.transcript);
		for (const artifact of replacement.artifacts) {
			if (!relativeMember(artifact.name)) throw new Error(`Unsafe replacement artifact: ${artifact.name}`);
			putPlanFile(incomingEntries, incomingData, `artifacts/${artifact.name}`, artifact.data);
		}
		if (replacement.authority)
			for (const [name, bytes] of validateBundle(replacement.authority))
				putPlanFile(incomingEntries, incomingData, `authority/${name}`, bytes);
		incoming = {
			entries: [...incomingEntries.values()].sort((left, right) => left.name.localeCompare(right.name)),
			data: incomingData,
		};
		for (const entry of incoming.entries)
			if (entry.name !== "authority/authority.lock" && entry.name !== "authority/authority.json")
				copyPlanEntry(entries, data, entry, incomingData);
		const validationFile = path.join(directory, "validation.jsonl");
		await writePrivate(validationFile, replacement.transcript);
		if (replacement.authority) {
			if (replacement.authority.owningSessionId !== context.owningSessionId)
				throw new Error("Replacement authority UUID does not match its transcript.");
			const members = validateBundle(replacement.authority);
			const validated = await validateBundledState(validationFile, replacement.authority, members, false);
			if (validated.sourceDescriptor) {
				const identity: AuthorityIdentity = {
					backend: validated.sourceDescriptor.backend,
					owningSessionId: context.owningSessionId,
					incarnation: randomUUID(),
					format: 2,
				};
				const importedDirectory = path.join(directory, "imported");
				await fs.mkdir(importedDirectory, { mode: 0o700 });
				const imported = await importBundleState(
					members,
					validated.sourceDescriptor,
					replacement.authority.owningSessionId,
					importedDirectory,
					identity,
				);
				state = imported.state;
				// The imported target is a fresh store: no incoming payload member (sidecar or rotation artifact) survives.
				for (const name of [...entries.keys()]) {
					if (
						name.startsWith("authority/") &&
						(payloadMember("sqlite", name.slice(10)) || payloadMember("jsonl", name.slice(10)))
					) {
						entries.delete(name);
						data.delete(name);
					}
				}
				for (const file of imported.files) {
					const bytes = await readPrivate(path.join(importedDirectory, file.name));
					if (!bytes || digest(bytes) !== file.digest)
						throw new Error(`Imported relocation target file changed before planning: ${file.name}`);
					putPlanFile(entries, data, `authority/${file.name}`, bytes);
				}
				descriptor = {
					...validated.sourceDescriptor,
					revision: validated.sourceDescriptor.revision + 1,
					incarnation: identity.incarnation,
					payload: path.basename(
						identity.backend === "sqlite" ? context.target.paths.sqlite : context.target.paths.jsonl,
					),
					physicalIdentity: context.target.physicalIdentity,
				};
				await fs.rm(importedDirectory, { recursive: true });
			}
		} else {
			const selected = captures.find(capture =>
				capture.bundle?.entries.some(entry => entry.name === "authority.json"),
			);
			if (selected?.bundle) {
				const old = validateDescriptorBundle(
					selected.bundle.entries.find(entry => entry.name === "authority.json")!.data,
					context.owningSessionId,
				);
				const identity: AuthorityIdentity = {
					backend: old.backend,
					owningSessionId: context.owningSessionId,
					incarnation: randomUUID(),
					format: 2,
				};
				const file = path.join(directory, `empty.${identity.backend}`);
				state = await useStagedPersistence(
					() => openAuthorityPersistence({ path: file, identity, create: true }),
					driver => driver.exportState(),
				);
				for (const suffix of ["", "-wal", "-shm"] as const) {
					const bytes = await readPrivate(`${file}${suffix}`);
					if (bytes)
						putPlanFile(entries, data, `authority/${targetArtifactName(identity.backend, suffix)}`, bytes);
					await fs.rm(`${file}${suffix}`, { force: true });
				}
				putPlanFile(
					entries,
					data,
					"authority/authority-v1.jsonl.quarantine",
					Buffer.from(LEGACY_AUTHORITY_DENIAL_REASON),
				);
				descriptor = {
					...old,
					revision: old.revision + 1,
					incarnation: identity.incarnation,
					payload: path.basename(
						identity.backend === "sqlite" ? context.target.paths.sqlite : context.target.paths.jsonl,
					),
					physicalIdentity: context.target.physicalIdentity,
				};
			}
		}
		await fs.rm(validationFile);
		const sources = [
			...captures.filter(capture => capture.snapshot.source).map(capture => capture.snapshot.sessionFile),
			context.target.sessionFile,
		];
		putPlanFile(
			entries,
			data,
			"transcript",
			rewriteRelocationTranscript(replacement.transcript, context.owningSessionId, options.cwd, undefined, {
				target: context.target.sessionFile,
				sources,
				selected: descriptor !== undefined,
			}),
		);
	} else {
		for (const entry of source.snapshot.entries)
			if (
				!entry.name.startsWith("artifacts") &&
				entry.name !== "authority/authority.lock" &&
				entry.name !== "authority/authority.json"
			)
				copyPlanEntry(entries, data, entry, source.data);
		for (const entry of target.snapshot.entries)
			if (entry.name.startsWith("artifacts")) copyPlanEntry(entries, data, entry, target.data);
		for (const entry of source.snapshot.entries)
			if (entry.name.startsWith("artifacts") && canMergeArtifact(entries, entry))
				copyPlanEntry(entries, data, entry, source.data);
		const transcript = source.data.get("transcript");
		if (!transcript) throw new Error("Relocation source transcript is missing.");
		const transcriptMetadata = source.snapshot.entries.find(entry => entry.name === "transcript")!;
		if (source.bundle) {
			const members = validateBundle(source.bundle);
			const bytes = members.get("authority.json");
			if (bytes) {
				const old = validateDescriptorBundle(bytes, context.owningSessionId);
				const check = path.join(directory, "check");
				state = await selectedExportFromBundle(members, old, context.owningSessionId, check);
				descriptor = {
					...old,
					revision: old.revision + 1,
					payload: path.basename(
						old.backend === "sqlite" ? context.target.paths.sqlite : context.target.paths.jsonl,
					),
					physicalIdentity: context.target.physicalIdentity,
				};
			}
		}
		const stamp = { target: context.target.sessionFile, sources: [primary], selected: descriptor !== undefined };
		putPlanFile(
			entries,
			data,
			"transcript",
			rewriteRelocationTranscript(
				transcript,
				context.owningSessionId,
				options.cwd,
				primary === context.target.sessionFile || !options.cwd ? undefined : primary,
				stamp,
			),
			transcriptMetadata.mode,
			transcriptMetadata.mtimeMs,
		);
	}
	if (descriptor) {
		const previousTarget = target.bundle?.entries.find(entry => entry.name === "authority.json");
		if (previousTarget)
			descriptor = {
				...descriptor,
				revision: Math.max(
					descriptor.revision,
					validateDescriptorBundle(previousTarget.data, context.owningSessionId).revision + 1,
				),
			};
		putPlanFile(entries, data, "authority/authority.json", Buffer.from(`${JSON.stringify(descriptor)}\n`));
	}
	return {
		entries: [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)),
		data,
		...(descriptor ? { descriptor } : {}),
		...(state ? { state } : {}),
		...(incoming ? { incoming } : {}),
	};
}

async function syncRelocationTree(directory: string): Promise<void> {
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateMode(stat.mode))
		throw new Error(`Relocation staging directory is not private: ${directory}`);
	for (const name of await fs.readdir(directory)) {
		const file = path.join(directory, name);
		const child = await fs.lstat(file);
		if (child.isDirectory()) await syncRelocationTree(file);
		else if (!child.isFile() || child.isSymbolicLink() || child.nlink !== 1 || !hasPrivateMode(child.mode))
			throw new Error(`Unsafe relocation staging file: ${file}`);
	}
	await syncDirectory(directory);
}

async function stagedRelocationBytes(
	directory: string,
	group: string,
	index: number,
	entry: RelocationEntry,
): Promise<Buffer> {
	let parent = directory;
	for (const part of group.split("/")) {
		parent = path.join(parent, part);
		const stat = await fs.lstat(parent);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateMode(stat.mode))
			throw new Error("Relocation data ancestry is not a private real directory.");
	}
	const bytes = await readPrivate(path.join(parent, String(index)));
	if (!bytes || digest(bytes) !== entry.sha256)
		throw new Error(`Relocation retained bytes are missing or changed: ${entry.name}`);
	return bytes;
}

async function writeRelocationMirror(
	destination: string,
	temporary: string,
	manifest: RelocationManifest,
): Promise<void> {
	const existing = await readRelocationRecord(destination);
	if (existing) {
		if (relocationImmutable(existing) !== relocationImmutable(manifest) || existing.phase !== manifest.phase)
			throw new Error("Relocation mirror contradicts its durable preparation.");
		return;
	}
	await fs.mkdir(temporary, { mode: 0o700 }).catch(error => {
		if (!isFsError(error, "EEXIST")) throw error;
	});
	const stat = await fs.lstat(temporary);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateMode(stat.mode))
		throw new Error("Relocation mirror staging is not a private real directory.");
	for (const name of await fs.readdir(temporary)) {
		if (name !== "relocation.json") throw new Error("Relocation mirror staging contains unrelated evidence.");
		await readPrivate(path.join(temporary, name));
		await fs.unlink(path.join(temporary, name));
	}
	await writePrivate(path.join(temporary, "relocation.json"), relocationManifestBytes(manifest));
	await syncDirectory(temporary);
	await fs.rename(temporary, destination);
	await syncDirectory(path.dirname(destination));
}

async function writeRelocationGuard(sessionFile: string, manifest: RelocationManifest): Promise<void> {
	await writeRelocationMirror(
		relocationStage(sessionFile, manifest.id),
		path.join(path.dirname(sessionFile), `.${path.basename(sessionFile)}.authority-guard.${manifest.id}`),
		manifest,
	);
}

async function prepareRelocation(
	context: AuthorityRelocationExclusiveContext,
	primary: string,
	kind: RelocationManifest["kind"],
	options: { cwd?: string; replacement?: AuthoritySessionReplacement; expectedTranscript?: string },
): Promise<{ manifest: RelocationManifest; directory: string }> {
	const contexts = new Map(context.sources.map(source => [source.sessionFile, source]));
	contexts.set(context.target.sessionFile, context.target);
	const sourceFiles = new Set(context.sources.map(source => source.sessionFile));
	const captures: CapturedRelocation[] = [];
	await options.replacement?.revalidateSources?.();
	for (const current of contexts.values()) {
		const bundle = await packUnderLock(current);
		if (bundle) await validateBundledState(current.sessionFile, bundle, validateBundle(bundle), false);
		const captured = await captureRelocation(current, sourceFiles.has(current.sessionFile));
		if (
			options.expectedTranscript !== undefined &&
			current.sessionFile === primary &&
			Buffer.from(captured.data.get("transcript") ?? []).toString("utf8") !== options.expectedTranscript
		)
			throw new Error("Session changed while its authority was being closed; refusing deletion.");
		const transcript = captured.data.get("transcript");
		if (options.replacement && transcript) options.replacement.validateSource?.(current.sessionFile, transcript);
		captures.push({ ...captured, bundle });
	}
	const temporary = path.join(
		path.dirname(context.target.sessionFile),
		`.${path.basename(context.target.sessionFile)}.relocation-${context.operationId}`,
	);
	const directory = relocationStage(context.target.sessionFile, context.operationId);
	let publicationAttempted = false;
	await fs.mkdir(temporary, { mode: 0o700 });
	try {
		const plan = await prepareRelocationPlan(context, captures, primary, kind, temporary, options);
		const manifest: RelocationManifest = {
			version: 1,
			id: context.operationId,
			owningSessionId: context.owningSessionId,
			kind,
			phase: "prepared",
			snapshots: captures.map(capture => capture.snapshot),
			target: context.target.sessionFile,
			targetEntries: plan.entries,
			...(options.cwd ? { cwd: path.resolve(options.cwd) } : {}),
			...(plan.incoming ? { incomingEntries: plan.incoming.entries } : {}),
			...(plan.descriptor && plan.state
				? {
						targetDescriptor: plan.descriptor,
						targetSemanticSha256: semanticFingerprint(plan.state),
						targetRevision: plan.state.revision,
						targetHeadHash: plan.state.headHash,
					}
				: {}),
		};
		for (const [snapshotIndex, capture] of captures.entries())
			for (const [index, entry] of capture.snapshot.entries.entries()) {
				if (entry.kind === "file")
					await writePrivate(
						path.join(temporary, "original", String(snapshotIndex), String(index)),
						capture.data.get(entry.name)!,
					);
			}
		for (const [index, entry] of plan.entries.entries())
			if (entry.kind === "file")
				await writePrivate(path.join(temporary, "prepared", String(index)), plan.data.get(entry.name)!);
		if (plan.incoming)
			for (const [index, entry] of plan.incoming.entries.entries())
				if (entry.kind === "file")
					await writePrivate(path.join(temporary, "incoming", String(index)), plan.incoming.data.get(entry.name)!);
		await writePrivate(path.join(temporary, "relocation.json"), relocationManifestBytes(manifest));
		await syncRelocationTree(temporary);
		for (const capture of captures) {
			const current = contexts.get(capture.snapshot.sessionFile)!;
			const recaptured = await captureRelocation(current, capture.snapshot.source);
			if (canonicalDurableSha256(recaptured.snapshot) !== canonicalDurableSha256(capture.snapshot))
				throw new Error(`Relocation source changed during preparation: ${current.sessionFile}`);
		}
		publicationAttempted = true;
		await fs.rename(temporary, directory);
		await syncDirectory(path.dirname(context.target.sessionFile));
		return { manifest, directory };
	} catch (error) {
		if (error instanceof AuthorityCleanupError && error.pending) {
			if (!publicationAttempted) error.afterCleanup(() => fs.rm(temporary, { recursive: true, force: true }));
			throw error;
		}
		if (publicationAttempted) throw new AuthorityRelocationInterruptedError(context.target.sessionFile, error);
		try {
			await fs.rm(temporary, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Relocation preparation and private staging cleanup failed; retain its evidence.",
				{ cause: error },
			);
		}
		throw error;
	}
}

async function validateRetainedRelocation(directory: string, manifest: RelocationManifest): Promise<void> {
	await syncRelocationTree(directory);
	for (const [snapshotIndex, snapshot] of manifest.snapshots.entries())
		for (const [index, entry] of snapshot.entries.entries())
			if (entry.kind === "file") await stagedRelocationBytes(directory, `original/${snapshotIndex}`, index, entry);
	for (const [index, entry] of manifest.targetEntries.entries())
		if (entry.kind === "file") await stagedRelocationBytes(directory, "prepared", index, entry);
	if (manifest.incomingEntries)
		for (const [index, entry] of manifest.incomingEntries.entries())
			if (entry.kind === "file") await stagedRelocationBytes(directory, "incoming", index, entry);
}

async function centralRelocation(
	record: RelocationManifest,
): Promise<{ manifest: RelocationManifest; directory: string }> {
	const candidates = new Set([
		relocationStage(record.target, record.id),
		path.join(path.dirname(record.target), `.${path.basename(record.target)}.relocation-${record.id}`),
		...record.snapshots.map(snapshot => relocationBackup(snapshot.sessionFile, record.id)),
		...["aborted", "deleted"].map(disposition =>
			path.join(
				path.dirname(record.target),
				`.${path.basename(record.target)}.authority-${disposition}.${record.id}`,
			),
		),
	]);
	let result: { manifest: RelocationManifest; directory: string } | undefined;
	for (const directory of candidates) {
		const manifest = await readRelocationRecord(directory);
		if (!manifest) continue;
		if (relocationImmutable(manifest) !== relocationImmutable(record))
			throw new Error("Relocation guards and retained preparation contradict each other.");
		const members = await fs.readdir(directory);
		if (!members.includes("original")) {
			if (members.some(name => name !== "relocation.json"))
				throw new Error("Relocation receipt has unrelated retained members.");
			continue;
		}
		if (
			directory !== relocationStage(record.target, record.id) &&
			directory !==
				path.join(path.dirname(record.target), `.${path.basename(record.target)}.relocation-${record.id}`) &&
			manifest.phase !== "complete" &&
			manifest.phase !== "aborted"
		)
			throw new Error("Relocation backup has no completed disposition.");
		if (result) throw new Error("Multiple retained relocation preparations claim one decision.");
		result = { manifest, directory };
	}
	if (!result) throw new Error("Relocation guard has lost its retained preparation; refusing source recreation.");
	return result;
}

async function findRelocation(
	sessionFile: string,
	dispositions = false,
): Promise<{ manifest: RelocationManifest; directory: string } | undefined> {
	const canonical = await canonicalAuthoritySession(sessionFile);
	const base = path.basename(canonical);
	const names = (await fs.readdir(path.dirname(canonical))).sort();
	const stages: RelocationManifest[] = [];
	const receipts: RelocationManifest[] = [];
	for (const name of names) {
		const stage = name.startsWith(`${base}.authority.stage.`) || name.startsWith(`.${base}.relocation-`);
		if (
			!stage &&
			(!dispositions ||
				(!name.startsWith(`${base}.authority.backup.`) &&
					!name.startsWith(`.${base}.authority-aborted.`) &&
					!name.startsWith(`.${base}.authority-deleted.`)))
		)
			continue;
		if (name.startsWith(`.${base}.relocation-`)) {
			const directory = path.join(path.dirname(canonical), name);
			const stat = await fs.lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateMode(stat.mode))
				throw new Error("Relocation preparation is not a private real directory.");
			if (!(await fs.readdir(directory)).includes("original")) continue;
		}
		const record = await readRelocationRecord(path.join(path.dirname(canonical), name));
		if (!record) continue;
		if (
			stage &&
			name !== path.basename(relocationStage(canonical, record.id)) &&
			name !== `.${base}.relocation-${record.id}`
		)
			throw new Error("Relocation guard operation identity is invalid.");
		if (!record.snapshots.some(snapshot => snapshot.sessionFile === canonical)) {
			if (stage) throw new Error("Relocation provenance does not include this endpoint.");
			continue;
		}
		if (stage) stages.push(record);
		else receipts.push(record);
	}
	if (stages.length > 1) throw new Error("Multiple relocation guards exist; refusing to choose a winner.");
	if (stages.length) return centralRelocation(stages[0]);
	if (!dispositions) return undefined;
	const descriptor = await readAuthorityDescriptor(canonical);
	for (const record of receipts) {
		if (
			record.phase === "complete" &&
			record.target === canonical &&
			(record.targetDescriptor
				? Boolean(
						descriptor && canonicalDurableSha256(record.targetDescriptor) === canonicalDurableSha256(descriptor),
					)
				: !descriptor)
		)
			return centralRelocation(record);
	}
	const descriptorBytes = await readPrivate(authorityPaths(canonical).descriptor);
	for (const record of receipts) {
		if (record.phase !== "aborted") continue;
		const original = record.snapshots
			.find(snapshot => snapshot.sessionFile === canonical)
			?.entries.find(entry => entry.name === "authority/authority.json");
		if (original?.sha256 === (descriptorBytes ? digest(descriptorBytes) : undefined))
			return centralRelocation(record);
	}
	return undefined;
}

async function validateRelocationContexts(
	context: AuthorityRelocationExclusiveContext,
	manifest: RelocationManifest,
	directory: string,
): Promise<void> {
	if (
		context.operationId !== manifest.id ||
		context.owningSessionId !== manifest.owningSessionId ||
		context.target.sessionFile !== manifest.target
	)
		throw new Error("Relocation request does not bind its retained operation.");
	const contexts = new Map(context.sources.map(source => [source.sessionFile, source]));
	contexts.set(context.target.sessionFile, context.target);
	if (contexts.size !== manifest.snapshots.length)
		throw new Error("Relocation recovery does not exclude every retained endpoint.");
	for (const snapshot of manifest.snapshots) {
		const current = contexts.get(snapshot.sessionFile);
		if (!current || !sameAnchor(current.physicalIdentity, snapshot.anchor))
			throw new Error("Relocation recovery anchor does not match its original endpoint.");
		const guard = await readRelocationRecord(relocationStage(snapshot.sessionFile, manifest.id));
		if (guard && relocationImmutable(guard) !== relocationImmutable(manifest))
			throw new Error("Relocation endpoint guard has changed.");
	}
	await validateRetainedRelocation(directory, manifest);
}

function entryContentMatches(left: RelocationEntry, right: RelocationEntry, exactIdentity: boolean): boolean {
	return (
		left.kind === right.kind &&
		left.mode === right.mode &&
		(left.kind === "directory" || (left.sha256 === right.sha256 && left.link === right.link)) &&
		(!exactIdentity ||
			Boolean(
				left.identity &&
				right.identity &&
				sameAnchor(left.identity, right.identity) &&
				(left.kind === "directory" || left.mtimeMs === right.mtimeMs),
			))
	);
}
async function verifyOriginalRelocation(
	context: AuthorityExclusiveContext,
	snapshot: RelocationSnapshot,
	id: string,
): Promise<void> {
	const current = await captureRelocation(context, snapshot.source, id);
	if (canonicalDurableSha256(current.snapshot) !== canonicalDurableSha256(snapshot))
		throw new Error(`Relocation source changed after capture: ${snapshot.sessionFile}`);
}
async function verifyTargetProgress(context: AuthorityExclusiveContext, manifest: RelocationManifest): Promise<void> {
	const original = manifest.snapshots.find(snapshot => snapshot.sessionFile === context.sessionFile)!;
	const originalEntries = new Map(original.entries.map(entry => [entry.name, entry]));
	const planned = new Map(manifest.targetEntries.map(entry => [entry.name, entry]));
	const current = await captureRelocation(context, original.source, manifest.id);
	for (const entry of current.snapshot.entries) {
		if (entry.name === "authority/authority.lock") continue;
		if (
			entry.name === "authority/authority.json" &&
			manifest.targetDescriptor &&
			!originalEntries.has(entry.name) &&
			entry.sha256 ===
				digest(
					Buffer.from(`${JSON.stringify({ ...manifest.targetDescriptor, revision: 1, state: "initializing" })}\n`),
				)
		)
			continue;
		const before = originalEntries.get(entry.name);
		const after = planned.get(entry.name);
		if (!(before && entryContentMatches(entry, before, true)) && !(after && entryContentMatches(entry, after, false)))
			throw new Error(`Unrecognized bytes appeared during relocation publication: ${entry.name}`);
	}
}

async function removeRelocationEntry(sessionFile: string, entry: RelocationEntry): Promise<void> {
	const file = relocationPath(sessionFile, entry.name);
	try {
		if (entry.kind === "directory") await fs.rmdir(file);
		else await fs.unlink(file);
	} catch (error) {
		if (!isFsError(error, "ENOENT")) throw error;
	}
	await syncDirectory(path.dirname(file));
}

async function publishRelocationEntry(sessionFile: string, entry: RelocationEntry, bytes?: Uint8Array): Promise<void> {
	const file = relocationPath(sessionFile, entry.name);
	await ensurePrivateDirectory(path.dirname(file));
	if (entry.kind === "directory") {
		await fs.mkdir(file, { mode: entry.mode }).catch(error => {
			if (!isFsError(error, "EEXIST")) throw error;
		});
		const stat = await fs.lstat(file);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Relocation directory was replaced: ${file}`);
		await fs.chmod(file, entry.mode);
		await syncDirectory(path.dirname(file));
		return;
	}
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.relocation-${randomUUID()}`);
	const cleanup = inspectionCleanup();
	try {
		if (entry.kind === "symlink") await fs.symlink(entry.link!, temporary);
		else {
			if (!bytes || digest(bytes) !== entry.sha256)
				throw new Error("Relocation publication bytes do not match the retained plan.");
			const handle = await fs.open(
				temporary,
				fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
				entry.mode,
			);
			const resource = trackInspectionResource(cleanup, () => handle.close());
			await handle.writeFile(bytes);
			await handle.chmod(entry.mode);
			await handle.utimes(entry.mtimeMs / 1000, entry.mtimeMs / 1000);
			await durableFsync(handle);
			if (!(await closeInspectionResource(cleanup, resource))) throw resource.error;
		}
		await fs.rename(temporary, file);
		if (entry.kind === "symlink") await fs.lutimes(file, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
		await syncDirectory(path.dirname(file));
	} catch (error) {
		await disposeInspection(cleanup);
		return withRetainedAuthorityCleanup(
			async () => {
				throw inspectionFailure([error], cleanup, "Relocation publication and handle cleanup failed.");
			},
			() => fs.rm(temporary, { force: true }),
		);
	}
}

async function relocationSelected(manifest: RelocationManifest): Promise<boolean> {
	if (manifest.targetDescriptor) {
		const descriptor = await readAuthorityDescriptor(manifest.target);
		const selected = Boolean(
			descriptor && canonicalDurableSha256(descriptor) === canonicalDurableSha256(manifest.targetDescriptor),
		);
		if (!selected && (manifest.phase === "selected" || manifest.phase === "complete"))
			throw new Error(
				"Selected relocation target descriptor is missing or changed; source grants must not be restored.",
			);
		return selected;
	}
	return manifest.phase === "selected" || manifest.phase === "complete";
}

async function writeRelocationPhase(
	directory: string,
	manifest: RelocationManifest,
	phase: RelocationManifest["phase"],
): Promise<RelocationManifest> {
	const next = { ...manifest, phase };
	await writePrivateAtomically(path.join(directory, "relocation.json"), relocationManifestBytes(next));
	return next;
}

async function publishRelocationPlan(
	context: AuthorityExclusiveContext,
	manifest: RelocationManifest,
	directory: string,
	faultAt?: AuthorityRelocationCut,
): Promise<void> {
	await verifyTargetProgress(context, manifest);
	const planned = new Map(manifest.targetEntries.map(entry => [entry.name, entry]));
	const original = manifest.snapshots.find(snapshot => snapshot.sessionFile === context.sessionFile)!;
	const removals = [...original.entries]
		.filter(
			entry =>
				entry.name !== "authority/authority.lock" &&
				!(entry.name === "authority/authority.json" && manifest.targetDescriptor) &&
				(!planned.has(entry.name) || planned.get(entry.name)!.kind !== entry.kind),
		)
		.sort((left, right) => right.name.split("/").length - left.name.split("/").length);
	for (const entry of removals) await removeRelocationEntry(context.sessionFile, entry);
	for (const group of ["transcript", "artifacts", "authority"] as const) {
		for (const [index, entry] of manifest.targetEntries.entries()) {
			if (
				entry.name === "authority/authority.json" ||
				entry.name === "authority/authority.lock" ||
				(group === "transcript" ? entry.name !== "transcript" : !entry.name.startsWith(group))
			)
				continue;
			await publishRelocationEntry(
				context.sessionFile,
				entry,
				entry.kind === "file" ? await stagedRelocationBytes(directory, "prepared", index, entry) : undefined,
			);
		}
		if (group === "authority" && manifest.targetDescriptor && !(await readAuthorityDescriptor(context.sessionFile)))
			await writeAuthorityDescriptor(context.sessionFile, {
				...manifest.targetDescriptor,
				revision: 1,
				state: "initializing",
			});
		relocationFault(
			faultAt,
			group === "authority" ? "target-payload" : group === "artifacts" ? "target-artifacts" : "target-transcript",
		);
	}
	await restoreRelocationDirectoryMetadata(context.sessionFile, manifest.targetEntries);
	await verifyPublishedRelocation(context, manifest, false);
}

async function verifyPublishedRelocation(
	context: AuthorityExclusiveContext,
	manifest: RelocationManifest,
	selected: boolean,
): Promise<void> {
	const current = await captureRelocation(context, false, manifest.id);
	const actual = new Map(
		current.snapshot.entries
			.filter(
				entry =>
					entry.name !== "authority/authority.lock" &&
					(selected || !manifest.targetDescriptor || entry.name !== "authority/authority.json"),
			)
			.map(entry => [entry.name, entry]),
	);
	const expected = manifest.targetEntries.filter(
		entry =>
			entry.name !== "authority/authority.lock" &&
			(selected || !manifest.targetDescriptor || entry.name !== "authority/authority.json"),
	);
	if (
		actual.size !== expected.length ||
		expected.some(entry => !actual.has(entry.name) || !entryContentMatches(actual.get(entry.name)!, entry, false))
	)
		throw new Error("Published relocation bundle differs from its retained exact plan.");
	const descriptorBytes = current.data.get("authority/authority.json");
	let selectedBefore = false;
	if (descriptorBytes && manifest.targetDescriptor) {
		let value: unknown;
		try {
			value = JSON.parse(Buffer.from(descriptorBytes).toString("utf8"));
		} catch {
			throw new AuthorityInspectionChangedError(context.paths.descriptor);
		}
		selectedBefore = canonicalDurableSha256(value) === canonicalDurableSha256(manifest.targetDescriptor);
	}
	if (manifest.targetDescriptor && selectedBefore !== selected)
		throw new AuthorityInspectionChangedError(context.paths.descriptor);
	if (manifest.targetDescriptor) {
		const descriptor = manifest.targetDescriptor;
		const members = new Map<string, Uint8Array>();
		for (const [name, bytes] of current.data) {
			if (name.startsWith("authority/") && payloadMember(descriptor.backend, name.slice("authority/".length)))
				members.set(name.slice("authority/".length), bytes);
		}
		const scratch = await fs.mkdtemp(path.join(path.dirname(context.sessionFile), ".authority-relocation-check-"));
		const normalized = { ...descriptor, payload: targetArtifactName(descriptor.backend, "") };
		const exported = await selectedExportFromBundle(members, normalized, manifest.owningSessionId, scratch);
		if (
			exported.revision !== manifest.targetRevision ||
			exported.headHash !== manifest.targetHeadHash ||
			semanticFingerprint(exported) !== manifest.targetSemanticSha256
		)
			throw new Error("Relocation target lost complete authority history or evidence.");
	}
	const after = await captureRelocation(context, false, manifest.id);
	const beforeEntries = new Map(current.snapshot.entries.map(entry => [entry.name, entry]));
	const afterEntries = new Map(after.snapshot.entries.map(entry => [entry.name, entry]));
	const changed =
		after.snapshot.entries.find(entry => {
			const before = beforeEntries.get(entry.name);
			return !before || canonicalDurableSha256(before) !== canonicalDurableSha256(entry);
		}) ?? current.snapshot.entries.find(entry => !afterEntries.has(entry.name));
	if (changed) throw new AuthorityInspectionChangedError(relocationPath(context.sessionFile, changed.name));
	const afterDescriptorBytes = after.data.get("authority/authority.json");
	let selectedAfter = false;
	if (afterDescriptorBytes && manifest.targetDescriptor) {
		let value: unknown;
		try {
			value = JSON.parse(Buffer.from(afterDescriptorBytes).toString("utf8"));
		} catch {
			throw new AuthorityInspectionChangedError(context.paths.descriptor);
		}
		selectedAfter = canonicalDurableSha256(value) === canonicalDurableSha256(manifest.targetDescriptor);
	}
	if (manifest.targetDescriptor && selectedAfter !== selected)
		throw new AuthorityInspectionChangedError(context.paths.descriptor);
}

async function capturePublishedTranscript(
	context: AuthorityExclusiveContext,
	manifest: RelocationManifest,
): Promise<AuthorityRelocationPublication> {
	if (!(await relocationSelected(manifest))) throw new Error("Relocation has not selected its published target.");
	const entries: RelocationEntry[] = [];
	const data = new Map<string, Uint8Array>();
	await captureRelocationPath(context.sessionFile, "transcript", entries, data, false);
	const expected = manifest.targetEntries.find(entry => entry.name === "transcript");
	const published = entries[0];
	const bytes = data.get("transcript");
	if (!expected || !published?.identity || !bytes || !entryContentMatches(published, expected, false))
		throw new Error("Relocation transcript no longer matches its owned publication.");
	return {
		size: bytes.byteLength,
		identity: { dev: Number(published.identity.dev), ino: Number(published.identity.ino) },
	};
}

async function retireRelocationSource(
	context: AuthorityExclusiveContext,
	snapshot: RelocationSnapshot,
	manifest: RelocationManifest,
	faultAt?: AuthorityRelocationCut,
): Promise<void> {
	const current = await captureRelocation(context, snapshot.source, manifest.id);
	const originals = new Map(snapshot.entries.map(entry => [entry.name, entry]));
	for (const entry of current.snapshot.entries) {
		if (entry.name === "authority/authority.lock") continue;
		const original = originals.get(entry.name);
		if (manifest.kind === "delete-authority" && entry.name === "authority/authority-v1.jsonl.quarantine") {
			if (original && entryContentMatches(entry, original, true)) continue;
			const denial = manifest.targetEntries.find(candidate => candidate.name === entry.name);
			if (denial && entryContentMatches(entry, denial, false)) continue;
		}
		if (!original || !entryContentMatches(entry, original, true))
			throw new Error(`Relocation source changed before retirement: ${entry.name}`);
	}
	if (manifest.kind === "delete-authority") {
		const denial = manifest.targetEntries.find(entry => entry.name === "authority/authority-v1.jsonl.quarantine")!;
		await publishRelocationEntry(context.sessionFile, denial, Buffer.from(LEGACY_AUTHORITY_DENIAL_REASON));
	}
	const authority = current.snapshot.entries
		.filter(
			entry =>
				entry.name.startsWith("authority/") &&
				entry.name !== "authority/authority.lock" &&
				!(manifest.kind === "delete-authority" && entry.name === "authority/authority-v1.jsonl.quarantine"),
		)
		.sort((left, right) => {
			if (left.name === "authority/authority.json") return 1;
			if (right.name === "authority/authority.json") return -1;
			return right.name.split("/").length - left.name.split("/").length;
		});
	for (const entry of authority) await removeRelocationEntry(context.sessionFile, entry);
	relocationFault(faultAt, "source-authority-retired");
	if (manifest.kind !== "delete-authority") {
		const artifacts = current.snapshot.entries
			.filter(entry => entry.name === "artifacts" || entry.name.startsWith("artifacts/"))
			.sort((left, right) => right.name.split("/").length - left.name.split("/").length);
		for (const entry of artifacts) await removeRelocationEntry(context.sessionFile, entry);
		const transcript = current.snapshot.entries.find(entry => entry.name === "transcript");
		if (transcript) await removeRelocationEntry(context.sessionFile, transcript);
	}
	relocationFault(faultAt, "source-transcript-retired");
	await syncDirectory(path.dirname(context.sessionFile));
}

async function removeRelocationGuard(sessionFile: string, manifest: RelocationManifest): Promise<void> {
	const guard = relocationStage(sessionFile, manifest.id);
	const retired = path.join(
		path.dirname(sessionFile),
		`.${path.basename(sessionFile)}.authority-retired-guard.${manifest.id}`,
	);
	const cleanupRetired = async (): Promise<void> => {
		const stat = await fs.lstat(retired).catch(error => {
			if (isFsError(error, "ENOENT")) return undefined;
			throw error;
		});
		if (!stat) return;
		const record = await readRelocationRecord(retired);
		if (record && relocationImmutable(record) !== relocationImmutable(manifest))
			throw new Error("Retired guard contradicts its retained relocation.");
		if ((await fs.readdir(retired)).some(name => name !== "relocation.json"))
			throw new Error("Retired guard contains unrelated evidence.");
		if (record) await fs.unlink(path.join(retired, "relocation.json"));
		await fs.rmdir(retired);
		await syncDirectory(path.dirname(sessionFile));
	};
	await cleanupRetired();
	const record = await readRelocationRecord(guard);
	if (!record) {
		if (
			await fs.lstat(guard).catch(error => {
				if (isFsError(error, "ENOENT")) return undefined;
				throw error;
			})
		)
			throw new Error("Relocation guard has lost its record; refusing unexplained cleanup.");
		return;
	}
	if (
		relocationImmutable(record) !== relocationImmutable(manifest) ||
		(await fs.readdir(guard)).some(name => name !== "relocation.json")
	)
		throw new Error("Refusing to remove an unrelated or nonempty relocation guard.");
	await fs.rename(guard, retired);
	await syncDirectory(path.dirname(sessionFile));
	await cleanupRetired();
}

async function finishRelocation(
	context: AuthorityRelocationExclusiveContext,
	retained: { manifest: RelocationManifest; directory: string },
	faultAt?: AuthorityRelocationCut,
): Promise<RelocationManifest> {
	let { manifest, directory } = retained;
	await validateRelocationContexts(context, manifest, directory);
	if (manifest.phase === "aborted")
		throw new Error("Relocation was aborted; start a new operation rather than selecting stale source grants.");
	let selected = await relocationSelected(manifest);
	if (manifest.phase !== "complete" && directory !== relocationStage(manifest.target, manifest.id)) {
		const stage = relocationStage(manifest.target, manifest.id);
		await fs.rename(directory, stage);
		directory = stage;
		await syncDirectory(path.dirname(manifest.target));
	}
	if (!selected) {
		for (const snapshot of manifest.snapshots)
			if (snapshot.sessionFile !== manifest.target || manifest.kind.startsWith("delete")) {
				const endpoint =
					context.sources.find(source => source.sessionFile === snapshot.sessionFile) ?? context.target;
				await verifyOriginalRelocation(endpoint, snapshot, manifest.id);
			}
		for (const snapshot of manifest.snapshots)
			if (snapshot.sessionFile !== manifest.target) await writeRelocationGuard(snapshot.sessionFile, manifest);
		relocationFault(faultAt, "guards-installed");
		if (manifest.kind === "move" || manifest.kind === "replace")
			await publishRelocationPlan(context.target, manifest, directory, faultAt);
		for (const snapshot of manifest.snapshots)
			if (snapshot.sessionFile !== manifest.target)
				await verifyOriginalRelocation(
					context.sources.find(source => source.sessionFile === snapshot.sessionFile)!,
					snapshot,
					manifest.id,
				);
		relocationFault(faultAt, "before-selection");
		if (manifest.kind === "move" || manifest.kind === "replace")
			await verifyPublishedRelocation(context.target, manifest, false);
		if (manifest.targetDescriptor)
			await writeAuthorityDescriptor(context.target.sessionFile, manifest.targetDescriptor);
		manifest = await writeRelocationPhase(directory, manifest, "selected");
		selected = true;
		relocationFault(faultAt, "selected");
	}
	if (selected && manifest.phase !== "complete" && (manifest.kind === "move" || manifest.kind === "replace"))
		await verifyPublishedRelocation(context.target, manifest, true);
	if (manifest.phase !== "complete") {
		for (const snapshot of manifest.snapshots) {
			if (snapshot.sessionFile === manifest.target && !manifest.kind.startsWith("delete")) continue;
			const endpoint = context.sources.find(source => source.sessionFile === snapshot.sessionFile) ?? context.target;
			await retireRelocationSource(endpoint, snapshot, manifest, faultAt);
		}
		manifest = await writeRelocationPhase(directory, manifest, "complete");
	}
	for (const snapshot of manifest.snapshots) {
		if (snapshot.sessionFile === manifest.target && (manifest.kind === "move" || manifest.kind === "replace"))
			continue;
		const endpoint = context.sources.find(source => source.sessionFile === snapshot.sessionFile) ?? context.target;
		const current = await captureRelocation(endpoint, snapshot.source, manifest.id);
		const expected = manifest.kind === "delete-authority" ? manifest.targetEntries : [];
		const actual = current.snapshot.entries.filter(entry => entry.name !== "authority/authority.lock");
		if (
			actual.length !== expected.length ||
			actual.some(
				entry =>
					!expected.some(
						candidate => candidate.name === entry.name && entryContentMatches(entry, candidate, false),
					),
			)
		)
			throw new Error("Completed relocation source has unexplained surviving bytes; refusing stale grant cleanup.");
	}
	relocationFault(faultAt, "completed");
	if (manifest.kind !== "delete" && directory === relocationStage(manifest.target, manifest.id)) {
		const backup = relocationBackup(manifest.target, manifest.id);
		await fs.rename(directory, backup);
		directory = backup;
		await syncDirectory(path.dirname(manifest.target));
	}
	for (const snapshot of manifest.snapshots)
		if (snapshot.sessionFile !== manifest.target) await removeRelocationGuard(snapshot.sessionFile, manifest);
	return manifest;
}

async function abortRelocation(
	context: AuthorityRelocationExclusiveContext,
	retained: { manifest: RelocationManifest; directory: string },
): Promise<void> {
	const { directory } = retained;
	let { manifest } = retained;
	await validateRelocationContexts(context, manifest, directory);
	if (manifest.phase === "aborted") {
		if (await relocationSelected(manifest))
			throw new Error("Relocation target is already selected; only finish is permitted.");
		const original = manifest.snapshots
			.find(snapshot => snapshot.sessionFile === manifest.target)!
			.entries.find(entry => entry.name === "authority/authority.json");
		const current = await readPrivate(context.target.paths.descriptor);
		if (original?.sha256 !== (current ? digest(current) : undefined))
			throw new Error("Aborted relocation target authority changed after restoration; retain its provenance.");
		await finalizeAbortedRelocation(manifest, directory);
		return;
	}
	if (await relocationSelected(manifest))
		throw new Error("Relocation target is already selected; only finish is permitted.");
	for (const snapshot of manifest.snapshots)
		if (snapshot.sessionFile !== manifest.target)
			await verifyOriginalRelocation(
				context.sources.find(source => source.sessionFile === snapshot.sessionFile)!,
				snapshot,
				manifest.id,
			);
	await verifyTargetProgress(context.target, manifest);
	const snapshotIndex = manifest.snapshots.findIndex(snapshot => snapshot.sessionFile === manifest.target);
	const snapshot = manifest.snapshots[snapshotIndex];
	const originals = new Map(snapshot.entries.map(entry => [entry.name, entry]));
	const current = await captureRelocation(context.target, snapshot.source, manifest.id);
	for (const entry of [...current.snapshot.entries].sort(
		(left, right) => right.name.split("/").length - left.name.split("/").length,
	)) {
		if (
			entry.name !== "authority/authority.lock" &&
			(!originals.has(entry.name) || originals.get(entry.name)!.kind !== entry.kind)
		)
			await removeRelocationEntry(manifest.target, entry);
	}
	for (const [index, entry] of snapshot.entries.entries())
		if (entry.name !== "authority/authority.lock" && entry.name !== "authority/authority.json")
			await publishRelocationEntry(
				manifest.target,
				entry,
				entry.kind === "file"
					? await stagedRelocationBytes(directory, `original/${snapshotIndex}`, index, entry)
					: undefined,
			);
	const descriptorIndex = snapshot.entries.findIndex(entry => entry.name === "authority/authority.json");
	if (descriptorIndex >= 0)
		await publishRelocationEntry(
			manifest.target,
			snapshot.entries[descriptorIndex],
			await stagedRelocationBytes(
				directory,
				`original/${snapshotIndex}`,
				descriptorIndex,
				snapshot.entries[descriptorIndex],
			),
		);
	await restoreRelocationDirectoryMetadata(manifest.target, snapshot.entries);
	manifest = await writeRelocationPhase(directory, manifest, "aborted");
	await finalizeAbortedRelocation(manifest, directory);
}

async function recoverRetainedRelocation(
	retained: { manifest: RelocationManifest; directory: string },
	action: "finish" | "abort",
	faultAt?: AuthorityRelocationCut,
	publicationRequired = false,
): Promise<AuthorityRelocationPublication | undefined> {
	const { manifest } = retained;
	for (const snapshot of manifest.snapshots) await closeSessionAuthority(snapshot.sessionFile);
	return withAuthorityRelocationExclusive(
		{
			owningSessionId: manifest.owningSessionId,
			operationId: manifest.id,
			sources: manifest.snapshots
				.filter(snapshot => snapshot.source && snapshot.sessionFile !== manifest.target)
				.map(snapshot => ({ sessionFile: snapshot.sessionFile, expectedPhysicalIdentity: snapshot.anchor })),
			target: {
				sessionFile: manifest.target,
				expectedPhysicalIdentity: manifest.snapshots.find(snapshot => snapshot.sessionFile === manifest.target)!
					.anchor,
			},
		},
		async context => {
			const current = await centralRelocation(manifest);
			if (action === "abort") await abortRelocation(context, current);
			else {
				const completed = await finishRelocation(context, current, faultAt);
				if (publicationRequired) return capturePublishedTranscript(context.target, completed);
			}
		},
	);
}

async function runAuthorityRelocation(
	source: string,
	target: string,
	kind: RelocationManifest["kind"],
	options: {
		cwd?: string;
		replacement?: AuthoritySessionReplacement;
		faultAt?: AuthorityRelocationCut;
		expectedTranscript?: string;
	},
): Promise<AuthorityRelocationPublication | undefined> {
	await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true, mode: 0o700 });
	const sourceFile = await canonicalAuthoritySession(source);
	const targetFile = await canonicalAuthoritySession(target);
	let pending =
		(await findRelocation(sourceFile)) ?? (sourceFile === targetFile ? undefined : await findRelocation(targetFile));
	if (!pending && sourceFile !== targetFile) {
		const sourceStat = await fs.lstat(sourceFile).catch(error => {
			if (isFsError(error, "ENOENT")) return undefined;
			throw error;
		});
		if (!sourceStat) {
			const completed = await findRelocation(targetFile, true);
			if (
				completed?.manifest.phase === "complete" &&
				completed.manifest.kind === kind &&
				completed.manifest.target === targetFile &&
				completed.manifest.snapshots.some(snapshot => snapshot.sessionFile === sourceFile)
			)
				pending = completed;
		}
	}
	let reservedTarget: AuthorityPhysicalIdentity | undefined;
	if (pending?.manifest.phase === "aborted") {
		const anchor = await releaseAbortedTarget(pending);
		if (pending.manifest.target === targetFile) reservedTarget = anchor;
	}
	if (
		pending?.manifest.kind === "delete" &&
		pending.manifest.phase === "complete" &&
		kind === "replace" &&
		pending.manifest.target === targetFile
	) {
		reservedTarget = await releaseCompletedDeletion(pending);
		pending = undefined;
	}
	if (pending && pending.manifest.phase !== "aborted") {
		if (kind === "replace")
			throw new AuthorityRelocationInterruptedError(
				pending.manifest.target,
				new Error("Recover the previous replacement before submitting another archive."),
			);
		if (options.cwd !== undefined && pending.manifest.cwd !== path.resolve(options.cwd))
			throw new AuthorityRelocationInterruptedError(
				pending.manifest.target,
				new Error("A different cwd request cannot replace the retained move; finish or abort it first."),
			);
		if (
			pending.manifest.kind !== kind ||
			pending.manifest.target !== targetFile ||
			!pending.manifest.snapshots.some(snapshot => snapshot.sessionFile === sourceFile)
		)
			throw new Error("A different relocation requires explicit recovery before this operation.");
		try {
			return await recoverRetainedRelocation(pending, "finish", options.faultAt, kind === "move");
		} catch (error) {
			if (error instanceof AuthorityCleanupError && error.pending) throw error;
			throw new AuthorityRelocationInterruptedError(pending.manifest.target, error);
		}
	}
	const sources = options.replacement
		? await Promise.all(options.replacement.sources.map(canonicalAuthoritySession))
		: [sourceFile];
	const owner = options.replacement?.owningSessionId ?? (await readAuthoritySessionId(sourceFile));
	reservedTarget ??= await emptyRelocationTargetAnchor(targetFile);
	for (const file of new Set([...sources, targetFile])) await closeSessionAuthority(file);
	let preparationRetained = false;
	return withAuthorityRelocationExclusive(
		{
			owningSessionId: owner,
			operationId: randomUUID(),
			sources: sources.filter(file => file !== targetFile).map(sessionFile => ({ sessionFile })),
			target: { sessionFile: targetFile, ...(reservedTarget ? { expectedPhysicalIdentity: reservedTarget } : {}) },
		},
		async context => {
			try {
				const prepared = await prepareRelocation(context, sourceFile, kind, options);
				preparationRetained = true;
				const completed = await finishRelocation(context, prepared, options.faultAt);
				if (kind === "move") return await capturePublishedTranscript(context.target, completed);
			} catch (error) {
				if (error instanceof AuthorityCleanupError && error.pending) throw error;
				// Remember uncertain preparation before grouped release can aggregate its error.
				if (error instanceof AuthorityRelocationInterruptedError) preparationRetained = true;
				if (preparationRetained && !(error instanceof AuthorityRelocationInterruptedError))
					throw new AuthorityRelocationInterruptedError(context.target.sessionFile, error);
				throw error;
			}
		},
	).catch(error => {
		if (error instanceof AuthorityCleanupError && error.pending) throw error;
		if (preparationRetained && !(error instanceof AuthorityRelocationInterruptedError))
			throw new AuthorityRelocationInterruptedError(targetFile, error);
		throw error;
	});
}

export async function relocateSessionAuthority(
	source: string,
	target: string,
	options: { cwd?: string; faultAt?: AuthorityRelocationCut } = {},
): Promise<AuthorityRelocationPublication> {
	const publication = await runAuthorityRelocation(source, target, "move", options);
	if (!publication)
		throw new AuthorityRelocationInterruptedError(
			target,
			new Error("Relocation completed without its transcript publication identity."),
		);
	return publication;
}

/** Explicit archive import selects a fresh incarnation after caller-owned source-stop/reconciliation. */
export async function replaceSessionAuthorityBundle(replacement: AuthoritySessionReplacement): Promise<void> {
	await validateReplacementInput(replacement);
	await runAuthorityRelocation(replacement.sources[0] ?? replacement.target, replacement.target, "replace", {
		cwd: replacement.cwd,
		replacement,
		faultAt: replacement.faultAt,
	});
}

export async function deleteSessionAuthorityBundle(
	sessionFile: string,
	options: { faultAt?: AuthorityRelocationCut; expectedTranscript?: string } = {},
): Promise<void> {
	const pending = await findRelocation(sessionFile);
	if (pending && pending.manifest.phase !== "aborted") {
		if (pending.manifest.kind !== "delete") throw new Error("Another relocation must be recovered before deletion.");
		await recoverRetainedRelocation(pending, "finish", options.faultAt);
		return;
	}
	await runAuthorityRelocation(sessionFile, sessionFile, "delete", options);
}

export async function recoverAuthorityRelocationIfPresent(
	sessionFile: string,
	action: "finish" | "abort",
): Promise<boolean> {
	const retained = await findRelocation(sessionFile, true);
	if (!retained) return false;
	await recoverRetainedRelocation(retained, action);
	return true;
}

export async function recoverAuthorityRelocation(sessionFile: string, action: "finish" | "abort"): Promise<void> {
	if (!(await recoverAuthorityRelocationIfPresent(sessionFile, action)))
		throw new Error("No retained authority relocation is available for recovery.");
}

async function finalizeAbortedRelocation(manifest: RelocationManifest, directory: string): Promise<void> {
	const hidden = path.join(
		path.dirname(manifest.target),
		`.${path.basename(manifest.target)}.authority-aborted.${manifest.id}`,
	);
	if (directory !== hidden) {
		await fs.rename(directory, hidden);
		await syncDirectory(path.dirname(manifest.target));
	}
	for (const snapshot of manifest.snapshots) {
		if (snapshot.entries.some(entry => entry.name === "transcript")) {
			await writeRelocationMirror(
				relocationBackup(snapshot.sessionFile, manifest.id),
				path.join(
					path.dirname(snapshot.sessionFile),
					`.${path.basename(snapshot.sessionFile)}.authority-receipt.${manifest.id}`,
				),
				manifest,
			);
		}
		if (snapshot.sessionFile !== manifest.target) await removeRelocationGuard(snapshot.sessionFile, manifest);
	}
	if (
		!manifest.snapshots
			.find(snapshot => snapshot.sessionFile === manifest.target)!
			.entries.some(entry => entry.name === "transcript")
	)
		await writeRelocationGuard(manifest.target, manifest);
}

async function releaseAbortedTarget(retained: {
	manifest: RelocationManifest;
	directory: string;
}): Promise<AuthorityPhysicalIdentity> {
	const { manifest } = retained;
	const target = manifest.snapshots.find(snapshot => snapshot.sessionFile === manifest.target)!;
	for (const snapshot of manifest.snapshots) await closeSessionAuthority(snapshot.sessionFile);
	await withAuthorityRelocationExclusive(
		{
			owningSessionId: manifest.owningSessionId,
			operationId: manifest.id,
			sources: manifest.snapshots
				.filter(snapshot => snapshot.source && snapshot.sessionFile !== manifest.target)
				.map(snapshot => ({ sessionFile: snapshot.sessionFile, expectedPhysicalIdentity: snapshot.anchor })),
			target: { sessionFile: manifest.target, expectedPhysicalIdentity: target.anchor },
		},
		async context => {
			const current = await centralRelocation(manifest);
			await abortRelocation(context, current);
			await removeRelocationGuard(manifest.target, manifest);
		},
	);
	return target.anchor;
}

export async function validateAuthorityBundleSource(sessionFile: string, bundle: AuthorityBundle): Promise<void> {
	await validateBundledState(sessionFile, bundle, validateBundle(bundle), true);
}

async function restoreRelocationDirectoryMetadata(
	sessionFile: string,
	entries: readonly RelocationEntry[],
): Promise<void> {
	for (const entry of [...entries]
		.filter(candidate => candidate.kind === "directory")
		.sort((left, right) => right.name.split("/").length - left.name.split("/").length)) {
		const file = relocationPath(sessionFile, entry.name);
		await fs.utimes(file, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
		await syncDirectory(file);
	}
}

async function emptyRelocationTargetAnchor(sessionFile: string): Promise<AuthorityPhysicalIdentity | undefined> {
	const transcript = await fs.lstat(sessionFile).catch(error => {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	});
	if (transcript) return undefined;
	const paths = authorityPaths(sessionFile);
	const base = path.basename(sessionFile);
	const names = (await fs.readdir(path.dirname(sessionFile))).filter(
		name => name.startsWith(`${base}.authority`) && !isAuthorityRecoveryFileName(base, name),
	);
	if (names.length !== 1 || names[0] !== path.basename(paths.lock)) return undefined;
	const stat = await fs.lstat(paths.lock);
	// This is an empty destination reservation, not runtime-root allocation
	// evidence. Grouped exclusion revalidates the private anchor and its inode.
	return { dev: String(stat.dev), ino: String(stat.ino) };
}

export async function assertAuthorityRelocationSettled(sessionFile: string): Promise<void> {
	const retained = await findRelocation(sessionFile);
	if (
		retained &&
		retained.manifest.phase !== "aborted" &&
		!(retained.manifest.kind === "delete" && retained.manifest.phase === "complete")
	)
		throw new AuthorityRelocationInterruptedError(
			retained.manifest.target,
			new Error("Recover the pending lifecycle operation before classifying or replacing local copies."),
		);
}

async function validateReplacementInput(replacement: AuthoritySessionReplacement): Promise<void> {
	rewriteRelocationTranscript(replacement.transcript, replacement.owningSessionId);
	const entries = new Map<string, RelocationEntry>();
	const data = new Map<string, Uint8Array>();
	const names = new Set<string>();
	for (const artifact of replacement.artifacts) {
		if (!relativeMember(artifact.name) || names.has(artifact.name))
			throw new Error("Replacement contains an unsafe or duplicate artifact member.");
		names.add(artifact.name);
		putPlanFile(entries, data, `artifacts/${artifact.name}`, artifact.data);
	}
	if (!replacement.authority) return;
	await fs.mkdir(path.dirname(path.resolve(replacement.target)), { recursive: true, mode: 0o700 });
	const directory = await fs.mkdtemp(
		path.join(path.dirname(path.resolve(replacement.target)), ".authority-replacement-check-"),
	);
	const cleanup = inspectionCleanup();
	try {
		const file = path.join(directory, "incoming.jsonl");
		await writeInspectionCopy(file, replacement.transcript, cleanup);
		await validateBundledState(file, replacement.authority, validateBundle(replacement.authority), false);
	} catch (error) {
		deferNestedInspection(cleanup, error);
		retainInspectionDirectory(cleanup, directory);
		await disposeInspection(cleanup);
		if (cleanup.failures.length || inspectionCleanupPending(cleanup))
			throw inspectionFailure([error], cleanup, "Replacement validation and private staging cleanup failed.");
		throw error;
	}
	retainInspectionDirectory(cleanup, directory);
	await disposeInspection(cleanup);
	if (cleanup.failures.length)
		throw inspectionFailure([], cleanup, "Replacement validation and private staging cleanup failed.");
}

async function releaseCompletedDeletion(
	retained: { manifest: RelocationManifest; directory: string },
	targetOwner?: string,
): Promise<AuthorityPhysicalIdentity> {
	const { manifest } = retained;
	if (
		manifest.kind !== "delete" ||
		manifest.phase !== "complete" ||
		manifest.snapshots.length !== 1 ||
		manifest.snapshots[0].sessionFile !== manifest.target
	)
		throw new Error("Only a completed whole-session deletion can be archived for explicit restore.");
	const snapshot = manifest.snapshots[0];
	await closeSessionAuthority(manifest.target);
	await withAuthorityRelocationExclusive(
		{
			owningSessionId: targetOwner ?? manifest.owningSessionId,
			operationId: manifest.id,
			sources: [],
			target: { sessionFile: manifest.target, expectedPhysicalIdentity: snapshot.anchor },
		},
		async context => {
			const current = await centralRelocation(manifest);
			if (current.manifest.phase !== "complete" || !sameAnchor(context.target.physicalIdentity, snapshot.anchor))
				throw new Error("Deletion receipt or its physical reservation changed.");
			await validateRetainedRelocation(current.directory, current.manifest);
			const names = await listAuthorityNames(context.target);
			if (
				names.some(
					name =>
						name !== path.basename(context.target.paths.lock) &&
						name !== path.basename(relocationStage(manifest.target, manifest.id)),
				)
			)
				throw new Error("Completed deletion has competing authority artifacts; reconcile them before restore.");
			const hidden = path.join(
				path.dirname(manifest.target),
				`.${path.basename(manifest.target)}.authority-deleted.${manifest.id}`,
			);
			if (current.directory !== hidden) {
				await fs.rename(current.directory, hidden);
				await syncDirectory(path.dirname(manifest.target));
			}
		},
	);
	return snapshot.anchor;
}
