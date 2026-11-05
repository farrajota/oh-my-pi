import { dlopen, FFIType } from "bun:ffi";
import { durableFsync } from "./durable-sync";
import { hasPrivateMode } from "./private-mode";
import { directoryFsyncSupported } from "./directory-sync";
import { FileLock } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JournalingCapacity } from "./journaling-env";
import { canonicalAuthorityPathSync } from "./canonical-path";
import { classifyJsonlArtifact, jsonlLayout } from "./jsonl-layout";
import { authorityThreadLifetimeMode } from "./thread-lifetime";
import { AuthorityCleanupError, withRetainedAuthorityCleanup } from "./private-cleanup";
import { refusedAuthorityStoreGuidance } from "../../utils/resume-command";

export const LEGACY_AUTHORITY_DENIAL_REASON = "Authority v2 is active; legacy authority constructors are disabled.\n";

export interface AuthorityArtifacts {
	readonly any: boolean;
	readonly lock: boolean;
	readonly descriptor: boolean;
	readonly sqlite: boolean;
	/** The JSONL payload or any of its rotation artifacts (sealed segments, indexes, snapshots, temporaries). */
	readonly jsonl: boolean;
	readonly legacyJournal: boolean;
	readonly legacyFence: boolean;
	readonly migration: boolean;
	readonly staging: boolean;
	readonly backup: boolean;
	readonly temporary: boolean;
}
export interface AuthorityPaths {
	readonly sessionFile: string;
	readonly descriptor: string;
	readonly sqlite: string;
	readonly jsonl: string;
	readonly legacy: string;
	readonly legacyFence: string;
	readonly lock: string;
}

export interface AuthorityPhysicalIdentity {
	readonly dev: string;
	readonly ino: string;
}

export interface AuthorityExclusiveContext {
	readonly sessionFile: string;
	readonly owningSessionId: string;
	readonly paths: AuthorityPaths;
	readonly physicalIdentity: AuthorityPhysicalIdentity;
}

export interface AuthorityRelocationEndpoint {
	readonly sessionFile: string;
	readonly expectedPhysicalIdentity?: AuthorityPhysicalIdentity;
}

export interface AuthorityRelocationLockRequest {
	readonly owningSessionId: string;
	readonly operationId: string;
	readonly sources: readonly AuthorityRelocationEndpoint[];
	readonly target: AuthorityRelocationEndpoint;
	readonly capacity?: JournalingCapacity;
}

export interface AuthorityRelocationExclusiveContext {
	readonly owningSessionId: string;
	readonly operationId: string;
	readonly sources: readonly AuthorityExclusiveContext[];
	readonly target: AuthorityExclusiveContext;
}

export interface AuthorityOwnership extends AuthorityExclusiveContext {
	release(): Promise<void>;
}

export interface AuthorityOwnershipOptions {
	readonly owningSessionId?: string;
	readonly create?: boolean;
	/** `xfs` additionally refuses, before any mutation, a host or filesystem that cannot fund physical capacity. */
	readonly capacity?: JournalingCapacity;
}
interface SessionHeaderEvidence {
	readonly id: string;
	readonly dev: number;
	readonly ino: number;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const privateLockMode = 0o600;
const MAX_HEADER_BYTES = 64 * 1024;
const XFS_MAGIC = 0x58465342;
const activeOwners = new Set<string>();

/**
 * Thrown before any authority mutation when OMP_JOURNALING_CAPACITY=xfs is selected on a host or
 * filesystem that cannot provide the physical capacity reserve. The message is one actionable line.
 */
export class AuthorityCapacityUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthorityCapacityUnsupportedError";
	}
}

/**
 * Thrown by an open that finds a store it must not select without explicit operator recovery: an interrupted
 * migration, initialization or lifecycle operation, or a stopped state no command repairs. The message is one line.
 * `command` holds the exact `omp session authority ... --recover` command when one recovers the state; when none
 * does, it is undefined and the message names the documented manual procedure instead. Most sites throw before the
 * open changes anything; the legacy-upgrade check throws after `upgradeLegacyAuthorityOnResume` already ran.
 */
export class AuthorityRecoveryRequiredError extends Error {
	constructor(
		message: string,
		readonly command: string | undefined,
	) {
		super(message);
		this.name = "AuthorityRecoveryRequiredError";
	}
}

/** A one-line {@link AuthorityRecoveryRequiredError} for a state no recover command repairs. */
export function manualAuthorityRecoveryRequired(
	sessionFile: string,
	problem: string,
	cause?: unknown,
): AuthorityRecoveryRequiredError {
	const error = new AuthorityRecoveryRequiredError(
		`${problem}; no recover command applies: ${refusedAuthorityStoreGuidance(sessionFile)}`,
		undefined,
	);
	if (cause !== undefined) error.cause = cause;
	return error;
}

/**
 * Exclusion primitive for the transcript and the persistent anchor.
 *
 * Unix hosts (Linux on any filesystem, macOS, BSD) take a non-blocking exclusive `flock(2)` on the
 * open file description, so the kernel drops it when the descriptor closes or the process dies.
 * Windows has no `flock`; there the lock is a process-owned named kernel object keyed by the file's
 * volume serial and file index (the native FileLock), which Windows also drops on process exit.
 */
interface ExclusiveFileLocks {
	tryLock(handle: fs.FileHandle, key: string): boolean;
	close(handle: fs.FileHandle): Promise<void>;
}

function openFlockLibrary(): ((fd: number, operation: number) => number) | undefined {
	const candidates =
		os.platform() === "linux"
			? ["libc.so.6", "libc.so"]
			: os.platform() === "darwin"
				? ["libc.dylib", "/usr/lib/libSystem.B.dylib"]
				: os.platform() === "freebsd"
					? ["libc.so.7"]
					: [];
	for (const candidate of candidates) {
		try {
			const library = dlopen(candidate, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
			return (fd, operation) => library.symbols.flock(fd, operation);
		} catch {
			// Try the next loader name (glibc vs musl, dylib alias); requireFileLocks reports when none loads.
		}
	}
	return undefined;
}

/**
 * Name of the Windows named lock object for one file: a sha256 over the exact (bigint) volume serial and file index.
 * As JavaScript Numbers, file indexes at or above 2^53 (NTFS ids with a high sequence number) round together, so two
 * files could share a lock and the second open would read a false "already held". Unix flock ignores the key.
 */
export function authorityLockKey(kind: "transcript" | "anchor", dev: bigint, ino: bigint): string {
	return `${kind}:${new Bun.CryptoHasher("sha256").update(`${dev}:${ino}`).digest("hex")}`;
}

function createExclusiveFileLocks(): ExclusiveFileLocks | undefined {
	if (os.platform() === "win32") {
		const held = new Map<fs.FileHandle, FileLock>();
		return {
			tryLock(handle, key) {
				const lock = FileLock.tryAcquire(`omp-authority:${key}`);
				if (!lock.acquired) return false;
				held.set(handle, lock);
				return true;
			},
			async close(handle) {
				const lock = held.get(handle);
				if (lock) {
					lock.release();
					held.delete(handle);
				}
				await handle.close();
			},
		};
	}
	const flock = openFlockLibrary();
	if (!flock) return undefined;
	return {
		tryLock: handle => flock(handle.fd, LOCK_EX | LOCK_NB) === 0,
		close: handle => handle.close(),
	};
}

const fileLocks = createExclusiveFileLocks();

function requireFileLocks(action: string): ExclusiveFileLocks {
	if (!fileLocks)
		throw new Error(
			`Authority ${action} requires flock(2) or Windows named-object locks; neither is available on ${os.platform()}`,
		);
	return fileLocks;
}

function closeLockedHandle(handle: fs.FileHandle): Promise<void> {
	return fileLocks ? fileLocks.close(handle) : handle.close();
}

/**
 * Refuses OMP_JOURNALING_CAPACITY=xfs on an unsupported host or filesystem before anything is written.
 * `off` accepts every host. Physical capacity needs Linux x86_64 (O_TMPFILE, fallocate, FIEMAP and the
 * XFS project-quota ioctls) with the authority directory on XFS.
 */
export async function assertAuthorityCapacityHost(sessionFile: string, capacity: JournalingCapacity): Promise<void> {
	if (capacity === "off") return;
	const remedy = 'unset OMP_JOURNALING_CAPACITY (or set it to "off") to run without the physical capacity reserve';
	if (os.platform() !== "linux" || os.arch() !== "x64") {
		throw new AuthorityCapacityUnsupportedError(
			`OMP_JOURNALING_CAPACITY=xfs requires Linux x86_64 with the session directory on XFS, but this host is ${os.platform()} ${os.arch()}; ${remedy}`,
		);
	}
	if (authorityThreadLifetimeMode() !== "pidfd-thread") {
		throw new AuthorityCapacityUnsupportedError(
			`OMP_JOURNALING_CAPACITY=xfs requires Linux 6.9+ with glibc for exact worker lifetime (pidfd_open PIDFD_THREAD), which this host lacks; ${remedy}`,
		);
	}
	let target = path.resolve(sessionFile);
	let filesystem: { type: number } | undefined;
	try {
		filesystem = await fs.statfs(target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		target = path.dirname(target);
		filesystem = await fs.statfs(target);
	}
	if (filesystem.type !== XFS_MAGIC) {
		throw new AuthorityCapacityUnsupportedError(
			`OMP_JOURNALING_CAPACITY=xfs requires the session directory on XFS, but ${target} is on filesystem type 0x${filesystem.type.toString(16)}; ${remedy}`,
		);
	}
}

/** A session directory on a filesystem where flock exclusion across hosts is weak or emulated. */
export interface AuthorityWeakLockFilesystem {
	readonly directory: string;
	/** Short filesystem name: the Linux type (`nfs`, `smb`, `cifs`, `smb2`, `9p`, `ceph`, `afs`), the macOS f_fstypename, or `unc`. */
	readonly filesystem: string;
}

/** Platform probes for {@link detectWeakLockFilesystem}; tests inject them, production uses the host. */
export interface AuthorityFilesystemProbe {
	readonly platform?: NodeJS.Platform;
	/** Linux statfs f_type of `directory`. */
	readonly statfsType?: (directory: string) => Promise<number>;
	/** macOS statfs f_fstypename of `directory`, or undefined when it cannot be read. */
	readonly darwinFilesystemName?: (directory: string) => string | undefined;
}

/**
 * Linux statfs magics of network filesystems whose flock is emulated or not coherent across hosts. NFS maps flock to
 * whole-file POSIX locks (process-scoped, dropped by any close of the file in the process) unless local_lock=flock
 * makes it host-local; SMB/CIFS and 9p do not carry flock to other clients reliably. FUSE (sshfs, virtiofs) shares
 * one magic with local FUSE filesystems and is not classified.
 */
const LINUX_WEAK_LOCK_MAGICS: ReadonlyMap<number, string> = new Map([
	[0x6969, "nfs"],
	[0x517b, "smb"],
	[0xff534d42, "cifs"],
	[0xfe534d42, "smb2"],
	[0x01021997, "9p"],
	[0x00c36400, "ceph"],
	[0x5346414f, "afs"],
]);
const DARWIN_WEAK_LOCK_NAMES: ReadonlySet<string> = new Set(["nfs", "smbfs", "afpfs", "webdav"]);

/**
 * Detects a session directory where capacity-off exclusion (flock, or a Windows named object) may not hold across
 * hosts. Only a notice follows: two processes on one host still exclude each other, and refusing would strand users
 * whose home directory is a network mount. Returns undefined for local filesystems and when the probe cannot tell.
 */
export async function detectWeakLockFilesystem(
	sessionFile: string,
	probe: AuthorityFilesystemProbe = {},
): Promise<AuthorityWeakLockFilesystem | undefined> {
	const platform = probe.platform ?? process.platform;
	if (platform === "win32") {
		// UNC paths, including the extended \\?\UNC\ form a mapped network drive canonicalizes to; \\?\C:\ is local.
		if (/^\\\\\?\\UNC\\/i.test(sessionFile) || /^\\\\(?![?.]\\)/.test(sessionFile))
			return { directory: path.win32.dirname(sessionFile), filesystem: "unc" };
		return undefined;
	}
	const directory = path.dirname(path.resolve(sessionFile));
	if (platform === "darwin") {
		const name = (probe.darwinFilesystemName ?? darwinFilesystemName)(directory);
		return name !== undefined && DARWIN_WEAK_LOCK_NAMES.has(name) ? { directory, filesystem: name } : undefined;
	}
	if (platform !== "linux") return undefined;
	const type = await (probe.statfsType ?? (async (target: string) => (await fs.statfs(target)).type))(directory);
	const filesystem = LINUX_WEAK_LOCK_MAGICS.get(type);
	return filesystem ? { directory, filesystem } : undefined;
}

/** Offset and size of f_fstypename in darwin's 64-bit-inode `struct statfs` (the only layout on arm64). */
const DARWIN_STATFS_FSTYPENAME_OFFSET = 72;
const DARWIN_STATFS_FSTYPENAME_BYTES = 16;
const DARWIN_STATFS_BYTES = 2168;
let darwinStatfs: ((target: string) => string | undefined) | undefined;

function darwinFilesystemName(directory: string): string | undefined {
	darwinStatfs ??= loadDarwinStatfs();
	return darwinStatfs(directory);
}

function loadDarwinStatfs(): (target: string) => string | undefined {
	let statfs: (target: Uint8Array, buffer: Uint8Array) => number;
	try {
		// x86_64 keeps the 32-bit-inode statfs under the plain name; the 64-bit-inode layout is statfs$INODE64 there.
		const symbol = os.arch() === "x64" ? "statfs$INODE64" : "statfs";
		const library = dlopen("/usr/lib/libSystem.B.dylib", {
			[symbol]: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		});
		statfs = (target, buffer) =>
			(library.symbols[symbol] as (target: Uint8Array, buffer: Uint8Array) => number)(target, buffer);
	} catch {
		return () => undefined;
	}
	return target => {
		const buffer = new Uint8Array(DARWIN_STATFS_BYTES);
		if (statfs(Buffer.from(`${target}\0`), buffer) !== 0) return undefined;
		const name = buffer.subarray(
			DARWIN_STATFS_FSTYPENAME_OFFSET,
			DARWIN_STATFS_FSTYPENAME_OFFSET + DARWIN_STATFS_FSTYPENAME_BYTES,
		);
		const end = name.indexOf(0);
		return Buffer.from(name.subarray(0, end < 0 ? name.byteLength : end)).toString("utf8");
	};
}

export function authorityPaths(sessionFile: string): AuthorityPaths {
	const canonicalInput = path.resolve(sessionFile);
	return {
		sessionFile: canonicalInput,
		descriptor: `${canonicalInput}.authority.json`,
		sqlite: `${canonicalInput}.authority.sqlite`,
		jsonl: `${canonicalInput}.authority.jsonl`,
		legacy: `${canonicalInput}.authority-v1.jsonl`,
		legacyFence: `${canonicalInput}.authority-v1.jsonl.quarantine`,
		lock: `${canonicalInput}.authority.lock`,
	};
}

/** The canonical transcript path every authority check uses; the same function stamps `authorityRoot` headers. */
export async function canonicalAuthoritySession(sessionFile: string): Promise<string> {
	return canonicalAuthorityPathSync(sessionFile);
}

export async function readAuthoritySessionId(sessionFile: string): Promise<string> {
	const canonical = await canonicalAuthoritySession(sessionFile);
	const evidence = await readSessionHeaderEvidence(canonical);
	if (!evidence) throw new Error(`Authority root transcript has no valid session UUID header: ${canonical}`);
	return evidence.id;
}
export async function acquireAuthorityOwnership(
	sessionFile: string,
	options: AuthorityOwnershipOptions = {},
): Promise<AuthorityOwnership> {
	requireFileLocks("lifetime exclusion");
	const canonical = await canonicalAuthoritySession(sessionFile);
	await assertAuthorityCapacityHost(canonical, options.capacity ?? "off");
	const paths = authorityPaths(canonical);
	const evidence = await readSessionHeaderEvidence(canonical);
	if (!evidence) throw new Error(`Authority root transcript has no valid session UUID header: ${canonical}`);
	const headerId = evidence.id;
	if (options.owningSessionId !== undefined && options.owningSessionId !== headerId) {
		throw new Error(
			`Authority root UUID mismatch: requested ${options.owningSessionId}, transcript records ${headerId}`,
		);
	}
	const owningSessionId = options.owningSessionId ?? headerId;
	const ownerKey = `${evidence.dev}:${evidence.ino}:${owningSessionId}`;
	const sessionIdKey = `session:${owningSessionId}`;
	if (activeOwners.has(ownerKey) || activeOwners.has(sessionIdKey))
		throw new Error(`Authority ownership is already held for session ${owningSessionId}`);
	const transcript = await lockAuthorityTranscript(canonical, evidence);
	let anchor: fs.FileHandle | undefined;
	try {
		const artifacts = await inspectArtifacts(paths);
		if ((artifacts.descriptor || artifacts.sqlite || artifacts.jsonl) && !artifacts.lock) {
			throw new Error(
				`Authority artifacts exist without their persistent lock anchor; refusing recreation for ${canonical}`,
			);
		}
		if (!artifacts.any && !options.create) {
			throw new Error(`No authority creation evidence exists for ${canonical}; open with explicit create evidence`);
		}
		const lockedAnchor = await lockPersistentAnchor(paths, canonical, artifacts.lock, !artifacts.lock, artifacts.any);
		anchor = lockedAnchor.handle;
		const physicalIdentity = lockedAnchor.physicalIdentity;
		const cacheKey = `${ownerKey}:${physicalIdentity.dev}:${physicalIdentity.ino}`;
		if (activeOwners.has(cacheKey) || activeOwners.has(sessionIdKey))
			throw new Error(`Authority ownership is already held for ${canonical}`);
		activeOwners.add(ownerKey);
		activeOwners.add(sessionIdKey);
		activeOwners.add(cacheKey);
		let released = false;
		let anchorUnlocked = false;
		let transcriptUnlocked = false;
		let anchorClosed = false;
		let transcriptClosed = false;
		const release = async (): Promise<void> => {
			if (released) return;
			if (!anchorClosed && !anchorUnlocked) {
				await closeLockedHandle(anchor!);
				anchorClosed = true;
				anchorUnlocked = true;
			}
			if (!transcriptClosed && !transcriptUnlocked) {
				await closeLockedHandle(transcript);
				transcriptClosed = true;
				transcriptUnlocked = true;
			}
			released = true;
			activeOwners.delete(ownerKey);
			activeOwners.delete(sessionIdKey);
			activeOwners.delete(cacheKey);
		};
		return {
			sessionFile: canonical,
			owningSessionId,
			paths,
			physicalIdentity,
			release,
		};
	} catch (error) {
		let anchorUnlocked = !anchor;
		let transcriptUnlocked = false;
		let anchorClosed = !anchor;
		let transcriptClosed = false;
		const cleanup = async (): Promise<void> => {
			if (anchor && !anchorClosed && !anchorUnlocked) {
				await closeLockedHandle(anchor);
				anchorClosed = true;
				anchorUnlocked = true;
			}
			if (!transcriptClosed && !transcriptUnlocked) {
				await closeLockedHandle(transcript);
				transcriptClosed = true;
				transcriptUnlocked = true;
			}
		};
		if (error instanceof AuthorityCleanupError && error.pending) {
			error.afterCleanup(cleanup);
			throw error;
		}
		try {
			await cleanup();
		} catch (cleanupError) {
			throw retainAuthorityCleanup(
				error,
				cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError],
				"Authority ownership acquisition and cleanup failed.",
				cleanup,
			);
		}
		throw error;
	}
}

export async function withAuthorityExclusive<T>(
	sessionFile: string,
	run: (context: AuthorityExclusiveContext) => Promise<T>,
	options: AuthorityOwnershipOptions = {},
): Promise<T> {
	const ownership = await acquireAuthorityOwnership(sessionFile, options);
	const context: AuthorityExclusiveContext = {
		sessionFile: ownership.sessionFile,
		owningSessionId: ownership.owningSessionId,
		paths: ownership.paths,
		physicalIdentity: ownership.physicalIdentity,
	};
	return withRetainedAuthorityCleanup(
		() => run(context),
		() => ownership.release(),
	);
}

export async function withAuthorityRelocationExclusive<T>(
	request: AuthorityRelocationLockRequest,
	run: (context: AuthorityRelocationExclusiveContext) => Promise<T>,
): Promise<T> {
	requireFileLocks("relocation exclusion");
	if (!request.owningSessionId || !request.operationId)
		throw new Error("Authority relocation requires a session UUID and operation ID");
	const sessionIdKey = `session:${request.owningSessionId}`;
	if (activeOwners.has(sessionIdKey))
		throw new Error(`Authority ownership is already held for session ${request.owningSessionId}`);
	activeOwners.add(sessionIdKey);
	const locks: RelocationLock[] = [];
	const release = async (): Promise<void> => {
		const errors = await releaseRelocationLocks(locks);
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "Authority relocation lock cleanup is incomplete.");
		activeOwners.delete(sessionIdKey);
	};
	return withRetainedAuthorityCleanup(async () => {
		// After the synchronous UUID reservation, before any endpoint is inspected or locked.
		for (const endpoint of [...request.sources, request.target])
			await assertAuthorityCapacityHost(endpoint.sessionFile, request.capacity ?? "off");
		const candidates: RelocationCandidate[] = [];
		for (const endpoint of request.sources) {
			const canonical = await canonicalAuthoritySession(endpoint.sessionFile);
			const binding = await inspectRelocationBinding(
				canonical,
				request.owningSessionId,
				endpoint.expectedPhysicalIdentity,
				"source",
				request.operationId,
			);
			candidates.push({ canonical, key: binding.bundleKey, binding, endpoint, role: "source" });
		}
		const targetCanonical = await canonicalAuthoritySession(request.target.sessionFile);
		const targetBinding = await inspectRelocationBinding(
			targetCanonical,
			request.owningSessionId,
			request.target.expectedPhysicalIdentity,
			"target",
			request.operationId,
		);
		const targetCandidate: RelocationCandidate = {
			canonical: targetCanonical,
			key: targetBinding.bundleKey,
			binding: targetBinding,
			endpoint: request.target,
			role: "target",
		};
		candidates.push(targetCandidate);
		const transcriptBindings = new Map<string, RelocationCandidate>();
		for (const candidate of candidates) {
			const transcriptIdentity = candidate.binding.transcriptIdentity;
			if (!transcriptIdentity) continue;
			const transcriptKey = `${transcriptIdentity.dev}:${transcriptIdentity.ino}`;
			const existing = transcriptBindings.get(transcriptKey);
			if (existing && !sameRelocationBinding(existing.binding, candidate.binding))
				throw new Error(
					`Unsupported authority transcript-only alias has a different bundle parent or sibling anchor: ${candidate.canonical}`,
				);
			transcriptBindings.set(transcriptKey, existing ?? candidate);
		}
		const ordered = [...candidates].sort(
			(left, right) =>
				left.role.localeCompare(right.role) ||
				left.key.localeCompare(right.key) ||
				left.canonical.localeCompare(right.canonical),
		);
		const unique = new Map<string, RelocationCandidate>();
		for (const candidate of ordered) {
			const existing = unique.get(candidate.key);
			if (!existing) {
				unique.set(candidate.key, candidate);
				continue;
			}
			if (!sameRelocationBinding(existing.binding, candidate.binding))
				throw new Error(
					`Authority relocation endpoints do not share one physical bundle and sibling anchor: ${candidate.canonical}`,
				);
		}
		const contexts = new Map<string, AuthorityExclusiveContext>();
		for (const candidate of unique.values()) {
			const lock = await acquireRelocationEndpoint(candidate, request.owningSessionId, request.operationId);
			locks.push(lock);
			for (const alias of candidates.filter(item => item.key === candidate.key)) {
				const acquiredBinding = await inspectRelocationBinding(
					alias.canonical,
					request.owningSessionId,
					lock.context.physicalIdentity,
					alias.role,
					request.operationId,
				);
				if (!sameAcquiredRelocationBinding(alias.binding, acquiredBinding, lock.context.physicalIdentity))
					throw new Error(
						`Authority relocation endpoint binding changed during grouped acquisition: ${alias.canonical}`,
					);
			}
			contexts.set(candidate.key, lock.context);
		}
		const sourceKeys = candidates.filter(candidate => candidate.role === "source").map(candidate => candidate.key);
		const sources = [...new Set(sourceKeys)].sort().map(key => contexts.get(key)!);
		const target = contexts.get(targetCandidate.key)!;
		return run({ owningSessionId: request.owningSessionId, operationId: request.operationId, sources, target });
	}, release);
}

interface RelocationCandidate {
	readonly canonical: string;
	readonly key: string;
	readonly binding: RelocationBinding;
	readonly endpoint: AuthorityRelocationEndpoint;
	readonly role: "source" | "target";
}

interface RelocationBinding {
	readonly bundleKey: string;
	readonly exists: boolean;
	readonly parentIdentity: AuthorityPhysicalIdentity;
	readonly transcriptIdentity?: AuthorityPhysicalIdentity;
	readonly anchorIdentity?: AuthorityPhysicalIdentity;
	readonly artifactNames: readonly string[];
	readonly stageEntries: readonly string[];
	readonly hasArtifacts: boolean;
}

interface RelocationLock {
	readonly sessionFile: string;
	readonly context: AuthorityExclusiveContext;
	readonly transcript?: fs.FileHandle;
	readonly anchor: fs.FileHandle;
	anchorUnlocked: boolean;
	transcriptUnlocked: boolean;
	anchorClosed: boolean;
	transcriptClosed: boolean;
}

interface AuthorityArtifactSnapshot {
	readonly artifacts: AuthorityArtifacts;
	readonly names: readonly string[];
}

interface RelocationFileStat {
	readonly dev: number;
	readonly ino: number;
	readonly mode: number;
	readonly nlink: number;
	isFile(): boolean;
	isSymbolicLink(): boolean;
	isDirectory(): boolean;
}

async function inspectRelocationBinding(
	canonical: string,
	owningSessionId: string,
	expectedIdentity: AuthorityPhysicalIdentity | undefined,
	role: "source" | "target",
	operationId: string,
): Promise<RelocationBinding> {
	const parentPath = path.dirname(canonical);
	const parentStat = await fs.stat(parentPath);
	const parentIdentity = { dev: String(parentStat.dev), ino: String(parentStat.ino) };
	let transcriptStat: RelocationFileStat | undefined;
	try {
		transcriptStat = await fs.lstat(canonical);
		if (!transcriptStat.isFile() || transcriptStat.isSymbolicLink())
			throw new Error(`Authority relocation transcript must be a regular file: ${canonical}`);
		if (transcriptStat.nlink !== 1)
			throw new Error(`Authority relocation transcript must be singly linked: ${canonical}`);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const exists = transcriptStat !== undefined;
	let transcriptIdentity: AuthorityPhysicalIdentity | undefined;
	if (transcriptStat) {
		const evidence = await readSessionHeaderEvidence(canonical);
		if (!evidence) throw new Error(`Authority root transcript has no valid session UUID header: ${canonical}`);
		if (evidence.id !== owningSessionId)
			throw new Error(
				`Authority root UUID mismatch: requested ${owningSessionId}, transcript records ${evidence.id}`,
			);
		if (evidence.dev !== transcriptStat.dev || evidence.ino !== transcriptStat.ino)
			throw new Error(`Authority relocation transcript identity changed during inspection: ${canonical}`);
		transcriptIdentity = { dev: String(transcriptStat.dev), ino: String(transcriptStat.ino) };
	}
	const paths = authorityPaths(canonical);
	const snapshot = await readArtifactSnapshot(paths);
	if (snapshot.artifacts.any && !snapshot.artifacts.lock) {
		// Legacy roots predate persistent anchors; only their lone journal may bootstrap one.
		// Expected anchors and absent-source recovery still require an existing exact anchor below.
		const initialLegacy = exists && snapshot.artifacts.legacyJournal && snapshot.names.length === 1;
		if (!initialLegacy)
			throw new Error(
				`Authority artifacts exist without their persistent lock anchor; refusing relocation for ${canonical}`,
			);
	}
	const lockName = path.basename(paths.lock);
	let anchorIdentity: AuthorityPhysicalIdentity | undefined;
	if (snapshot.names.includes(lockName)) {
		const anchorStat = await fs.lstat(paths.lock);
		if (
			!anchorStat.isFile() ||
			anchorStat.isSymbolicLink() ||
			anchorStat.nlink !== 1 ||
			!hasPrivateMode(anchorStat.mode)
		) {
			throw new Error(`Authority lock anchor must be a singly linked private regular file: ${paths.lock}`);
		}
		anchorIdentity = { dev: String(anchorStat.dev), ino: String(anchorStat.ino) };
	}
	if (expectedIdentity && !anchorIdentity)
		throw new Error(`Expected authority relocation anchor is missing: ${canonical}`);
	if (expectedIdentity && anchorIdentity && !samePhysicalIdentity(expectedIdentity, anchorIdentity)) {
		throw new Error(`Authority relocation anchor identity mismatch for ${canonical}`);
	}
	const nonAnchorArtifacts = snapshot.names.filter(name => name !== lockName);
	let stageEntries: readonly string[] = [];
	if (!exists && role === "source") {
		if (!expectedIdentity)
			throw new Error(
				`Absent authority relocation source requires its exact expected anchor identity: ${canonical}`,
			);
		if (snapshot.artifacts.staging) {
			stageEntries = await recognizedRelocationStage(
				paths,
				snapshot,
				operationId,
				Boolean(expectedIdentity && anchorIdentity),
			);
			if (!stageEntries.length)
				throw new Error(
					`Absent authority relocation source has unrelated or unexplained staging artifacts: ${canonical}`,
				);
		} else if (nonAnchorArtifacts.length) {
			throw new Error(`Absent authority relocation source has unexplained artifacts: ${canonical}`);
		}
	}
	if (!exists && role === "target") {
		if (snapshot.artifacts.staging) {
			stageEntries = await recognizedRelocationStage(
				paths,
				snapshot,
				operationId,
				Boolean(expectedIdentity && anchorIdentity),
			);
			if (!stageEntries.length)
				throw new Error(`Authority relocation target has unrelated or unexplained staging artifacts: ${canonical}`);
		} else if (nonAnchorArtifacts.length) {
			throw new Error(`Authority relocation target has artifacts without a transcript: ${canonical}`);
		}
		if (anchorIdentity && !expectedIdentity)
			throw new Error(
				`Reserved authority relocation target requires its exact expected anchor identity: ${canonical}`,
			);
	}
	const bundleKey = `${parentIdentity.dev}:${parentIdentity.ino}:${path.basename(canonical)}`;
	return {
		bundleKey,
		exists,
		parentIdentity,
		...(transcriptIdentity ? { transcriptIdentity } : {}),
		...(anchorIdentity ? { anchorIdentity } : {}),
		artifactNames: snapshot.names,
		stageEntries,
		hasArtifacts: snapshot.artifacts.any,
	};
}

async function recognizedRelocationStage(
	paths: AuthorityPaths,
	snapshot: AuthorityArtifactSnapshot,
	operationId: string,
	hasExpectedAnchor: boolean,
): Promise<readonly string[]> {
	if (
		!hasExpectedAnchor ||
		!operationId ||
		operationId === "." ||
		operationId === ".." ||
		operationId.includes("/") ||
		operationId.includes("\\")
	)
		return [];
	const base = path.basename(paths.sessionFile);
	const lockName = path.basename(paths.lock);
	const stageName = `${base}.authority.stage.${operationId}`;
	const stageNames = snapshot.names.filter(name => name.startsWith(`${base}.authority.stage.`));
	if (
		stageNames.length !== 1 ||
		stageNames[0] !== stageName ||
		snapshot.names.some(name => name !== lockName && name !== stageName)
	)
		return [];
	const stagePath = path.join(path.dirname(paths.sessionFile), stageName);
	const stageStat = await fs.lstat(stagePath).catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!stageStat?.isDirectory() || stageStat.isSymbolicLink() || !hasPrivateMode(stageStat.mode)) return [];
	const entries = await fs.readdir(stagePath);
	if (!entries.length) return [];
	return [...entries].sort();
}

function sameRelocationBinding(left: RelocationBinding, right: RelocationBinding): boolean {
	return (
		left.bundleKey === right.bundleKey &&
		left.exists === right.exists &&
		samePhysicalIdentity(left.parentIdentity, right.parentIdentity) &&
		(left.transcriptIdentity === undefined
			? right.transcriptIdentity === undefined
			: right.transcriptIdentity !== undefined &&
				samePhysicalIdentity(left.transcriptIdentity, right.transcriptIdentity)) &&
		(left.anchorIdentity === undefined
			? right.anchorIdentity === undefined
			: right.anchorIdentity !== undefined && samePhysicalIdentity(left.anchorIdentity, right.anchorIdentity)) &&
		left.artifactNames.join("\0") === right.artifactNames.join("\0") &&
		left.stageEntries.join("\0") === right.stageEntries.join("\0")
	);
}

function sameAcquiredRelocationBinding(
	initial: RelocationBinding,
	acquired: RelocationBinding,
	anchorIdentity: AuthorityPhysicalIdentity,
): boolean {
	const initialArtifacts = initial.artifactNames.filter(name => !name.endsWith(".authority.lock"));
	const acquiredArtifacts = acquired.artifactNames.filter(name => !name.endsWith(".authority.lock"));
	return (
		initial.bundleKey === acquired.bundleKey &&
		initial.exists === acquired.exists &&
		samePhysicalIdentity(initial.parentIdentity, acquired.parentIdentity) &&
		(initial.transcriptIdentity === undefined
			? acquired.transcriptIdentity === undefined
			: acquired.transcriptIdentity !== undefined &&
				samePhysicalIdentity(initial.transcriptIdentity, acquired.transcriptIdentity)) &&
		(!initial.anchorIdentity || samePhysicalIdentity(initial.anchorIdentity, anchorIdentity)) &&
		Boolean(acquired.anchorIdentity && samePhysicalIdentity(acquired.anchorIdentity, anchorIdentity)) &&
		initialArtifacts.join("\0") === acquiredArtifacts.join("\0") &&
		initial.stageEntries.join("\0") === acquired.stageEntries.join("\0")
	);
}

async function acquireRelocationEndpoint(
	candidate: RelocationCandidate,
	owningSessionId: string,
	operationId: string,
): Promise<RelocationLock> {
	const { canonical, binding, endpoint, role } = candidate;
	const paths = authorityPaths(canonical);
	let transcript: fs.FileHandle | undefined;
	let anchor: fs.FileHandle | undefined;
	try {
		const before = await inspectRelocationBinding(
			canonical,
			owningSessionId,
			endpoint.expectedPhysicalIdentity,
			role,
			operationId,
		);
		if (!sameRelocationBinding(binding, before))
			throw new Error(`Authority relocation endpoint changed before acquisition: ${canonical}`);
		if (binding.exists) {
			const evidence = await readSessionHeaderEvidence(canonical);
			if (!evidence || evidence.id !== owningSessionId)
				throw new Error(`Authority relocation root UUID changed before acquisition: ${canonical}`);
			transcript = await lockAuthorityTranscript(canonical, evidence);
		}
		const lockedAnchor = await lockPersistentAnchor(
			paths,
			canonical,
			Boolean(binding.anchorIdentity),
			binding.exists || role === "target",
			binding.hasArtifacts,
			endpoint.expectedPhysicalIdentity,
		);
		anchor = lockedAnchor.handle;
		const parentAfter = await fs.stat(path.dirname(canonical));
		if (
			String(parentAfter.dev) !== binding.parentIdentity.dev ||
			String(parentAfter.ino) !== binding.parentIdentity.ino
		) {
			throw new Error(`Authority relocation parent directory identity changed during acquisition for ${canonical}`);
		}
		const acquiredBinding = await inspectRelocationBinding(
			canonical,
			owningSessionId,
			lockedAnchor.physicalIdentity,
			role,
			operationId,
		);
		if (!sameAcquiredRelocationBinding(binding, acquiredBinding, lockedAnchor.physicalIdentity)) {
			throw new Error(`Authority relocation endpoint identity changed during acquisition: ${canonical}`);
		}
		const context: AuthorityExclusiveContext = {
			sessionFile: canonical,
			owningSessionId,
			paths,
			physicalIdentity: lockedAnchor.physicalIdentity,
		};
		return {
			sessionFile: canonical,
			context,
			transcript,
			anchor,
			anchorUnlocked: false,
			transcriptUnlocked: false,
			anchorClosed: false,
			transcriptClosed: false,
		};
	} catch (error) {
		let anchorUnlocked = !anchor;
		let transcriptUnlocked = !transcript;
		let anchorClosed = !anchor;
		let transcriptClosed = !transcript;
		const cleanup = async (): Promise<void> => {
			if (anchor && !anchorClosed && !anchorUnlocked) {
				await closeLockedHandle(anchor);
				anchorClosed = true;
				anchorUnlocked = true;
			}
			if (transcript && !transcriptClosed && !transcriptUnlocked) {
				await closeLockedHandle(transcript);
				transcriptClosed = true;
				transcriptUnlocked = true;
			}
		};
		if (error instanceof AuthorityCleanupError && error.pending) {
			error.afterCleanup(cleanup);
			throw error;
		}
		try {
			await cleanup();
		} catch (cleanupError) {
			throw retainAuthorityCleanup(
				error,
				cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError],
				"Authority relocation acquisition and cleanup failed.",
				cleanup,
			);
		}
		throw error;
	}
}
async function releaseRelocationLocks(locks: readonly RelocationLock[]): Promise<unknown[]> {
	for (const lock of [...locks].reverse()) {
		if (!lock.anchorClosed && !lock.anchorUnlocked) {
			try {
				await closeLockedHandle(lock.anchor);
				lock.anchorClosed = true;
				lock.anchorUnlocked = true;
			} catch (error) {
				return [error];
			}
		}
		if (lock.transcript && !lock.transcriptClosed && !lock.transcriptUnlocked) {
			try {
				await closeLockedHandle(lock.transcript);
				lock.transcriptClosed = true;
				lock.transcriptUnlocked = true;
			} catch (error) {
				return [error];
			}
		}
	}
	return [];
}

interface LockedPersistentAnchor {
	readonly handle: fs.FileHandle;
	readonly physicalIdentity: AuthorityPhysicalIdentity;
}

async function lockAuthorityTranscript(canonical: string, evidence: SessionHeaderEvidence): Promise<fs.FileHandle> {
	const transcript = await fs.open(canonical, fs.constants.O_RDONLY | noFollow());
	try {
		const stat = await transcript.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== evidence.dev || stat.ino !== evidence.ino) {
			throw new Error(`Authority root transcript identity changed while opening ${canonical}`);
		}
		const exact = await transcript.stat({ bigint: true });
		if (
			!requireFileLocks("lifetime exclusion").tryLock(
				transcript,
				authorityLockKey("transcript", exact.dev, exact.ino),
			)
		) {
			throw new Error(`Authority ownership is already held for the physical root containing ${canonical}`);
		}
		const currentEvidence = await readSessionHeaderEvidence(canonical);
		if (
			!currentEvidence ||
			currentEvidence.id !== evidence.id ||
			currentEvidence.dev !== evidence.dev ||
			currentEvidence.ino !== evidence.ino
		) {
			throw new Error(`Authority root transcript identity changed during lock acquisition for ${canonical}`);
		}
		return transcript;
	} catch (error) {
		let closed = false;
		const cleanup = async (): Promise<void> => {
			if (closed) return;
			await closeLockedHandle(transcript);
			closed = true;
		};
		if (error instanceof AuthorityCleanupError && error.pending) {
			error.afterCleanup(cleanup);
			throw error;
		}
		try {
			await cleanup();
		} catch (cleanupError) {
			throw retainAuthorityCleanup(
				error,
				cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError],
				"Authority transcript locking and cleanup failed.",
				cleanup,
			);
		}
		throw error;
	}
}

async function lockPersistentAnchor(
	paths: AuthorityPaths,
	canonical: string,
	hasAnchor: boolean,
	mayCreate: boolean,
	hasArtifacts: boolean,
	expectedIdentity?: AuthorityPhysicalIdentity,
): Promise<LockedPersistentAnchor> {
	if (!hasAnchor && !mayCreate) throw new Error(`Persistent authority lock anchor is required for ${canonical}`);
	const created = !hasAnchor;
	const flags = created
		? fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollow()
		: fs.constants.O_RDWR | noFollow();
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(paths.lock, flags, privateLockMode).catch(error => {
			if (isEnoent(error) && hasArtifacts)
				throw new Error(`Persistent authority lock anchor disappeared for ${canonical}`);
			if (isEexist(error)) throw new Error(`Authority lock anchor was concurrently initialized for ${canonical}`);
			throw error;
		});
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || !hasPrivateMode(stat.mode)) {
			throw new Error(`Authority lock anchor must be a singly linked private regular file: ${paths.lock}`);
		}
		const physicalIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
		if (expectedIdentity && !samePhysicalIdentity(expectedIdentity, physicalIdentity))
			throw new Error(`Authority relocation anchor identity mismatch for ${canonical}`);
		const openedPath = await fs.lstat(paths.lock);
		if (!openedPath.isFile() || openedPath.dev !== stat.dev || openedPath.ino !== stat.ino) {
			throw new Error(`Authority lock anchor identity changed while opening ${paths.lock}`);
		}
		if (created) await syncPrivateAnchor(handle, paths.lock);
		const exact = await handle.stat({ bigint: true });
		if (!requireFileLocks("lifetime exclusion").tryLock(handle, authorityLockKey("anchor", exact.dev, exact.ino)))
			throw new Error(`Unable to acquire authority filesystem flock for ${canonical}`);
		const lockedPath = await fs.lstat(paths.lock);
		if (!lockedPath.isFile() || lockedPath.dev !== stat.dev || lockedPath.ino !== stat.ino) {
			throw new Error(`Authority lock anchor changed during flock acquisition for ${canonical}`);
		}
		return { handle, physicalIdentity };
	} catch (error) {
		if (!handle) throw error;
		let closed = false;
		const cleanup = async (): Promise<void> => {
			if (closed) return;
			await closeLockedHandle(handle!);
			closed = true;
		};
		if (error instanceof AuthorityCleanupError && error.pending) {
			error.afterCleanup(cleanup);
			throw error;
		}
		try {
			await cleanup();
		} catch (cleanupError) {
			throw retainAuthorityCleanup(
				error,
				cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError],
				"Authority anchor acquisition and cleanup failed.",
				cleanup,
			);
		}
		throw error;
	}
}

async function syncPrivateAnchor(anchor: fs.FileHandle, lockPath: string): Promise<void> {
	await durableFsync(anchor);
	if (!directoryFsyncSupported()) return;
	const directory = await fs.open(path.dirname(lockPath), fs.constants.O_RDONLY);
	let syncError: unknown;
	let syncFailed = false;
	try {
		await durableFsync(directory);
	} catch (error) {
		syncFailed = true;
		syncError = error;
	}
	try {
		await directory.close();
	} catch (closeError) {
		throw new AuthorityCleanupError(
			syncFailed ? [syncError, closeError] : [closeError],
			"Authority anchor directory sync and close failed.",
			async () => {
				await directory.close();
			},
		);
	}
	if (syncFailed) throw syncError;
}

function samePhysicalIdentity(left: AuthorityPhysicalIdentity, right: AuthorityPhysicalIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}
export async function inspectAuthorityArtifacts(sessionFile: string): Promise<AuthorityArtifacts> {
	const canonical = await canonicalAuthoritySession(sessionFile);
	return inspectArtifacts(authorityPaths(canonical));
}

async function inspectArtifacts(paths: AuthorityPaths): Promise<AuthorityArtifacts> {
	return (await readArtifactSnapshot(paths)).artifacts;
}

async function readArtifactSnapshot(paths: AuthorityPaths): Promise<AuthorityArtifactSnapshot> {
	const directoryNames = await fs.readdir(path.dirname(paths.sessionFile));
	const base = path.basename(paths.sessionFile);
	const prefix = `${base}.authority.`;
	const artifacts = directoryNames.filter(name => name.startsWith(prefix));
	const has = (name: string): boolean => directoryNames.includes(name);
	const migration = artifacts.some(name => name.startsWith(`${prefix}migration.`));
	const staging = artifacts.some(name => name.startsWith(`${prefix}stage.`));
	const backup = artifacts.some(name => name.startsWith(`${prefix}backup.`));
	const temporary = artifacts.some(name => name.startsWith(`${path.basename(paths.descriptor)}.tmp-`));
	const legacyJournal = has(path.basename(paths.legacy));
	const legacyFence = has(path.basename(paths.legacyFence));
	const relevantNames = [
		...artifacts,
		...(legacyJournal ? [path.basename(paths.legacy)] : []),
		...(legacyFence ? [path.basename(paths.legacyFence)] : []),
	].sort();
	return {
		artifacts: {
			any: artifacts.length > 0 || legacyJournal || legacyFence,
			lock: has(path.basename(paths.lock)),
			descriptor: has(path.basename(paths.descriptor)),
			sqlite: has(path.basename(paths.sqlite)),
			jsonl:
				has(path.basename(paths.jsonl)) ||
				artifacts.some(name => classifyJsonlArtifact(jsonlLayout(paths.jsonl), name) !== undefined),
			legacyJournal,
			legacyFence,
			migration,
			staging,
			backup,
			temporary,
		},
		names: relevantNames,
	};
}

async function readSessionHeaderEvidence(sessionFile: string): Promise<SessionHeaderEvidence | undefined> {
	const file = await fs.open(sessionFile, fs.constants.O_RDONLY | noFollow());
	let evidence: SessionHeaderEvidence | undefined;
	let inspectionError: unknown;
	let inspectionFailed = false;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1)
			throw new Error(`Authority root transcript must be a singly linked regular file: ${sessionFile}`);
		const buffer = Buffer.alloc(MAX_HEADER_BYTES);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const text = buffer.toString("utf8", 0, bytesRead);
		for (const line of text.split("\n")) {
			if (!line.startsWith("{")) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (isSessionHeader(entry)) {
				evidence = { id: entry.id, dev: stat.dev, ino: stat.ino };
				break;
			}
		}
	} catch (error) {
		inspectionFailed = true;
		inspectionError = error;
	}
	try {
		await file.close();
	} catch (closeError) {
		throw new AuthorityCleanupError(
			inspectionFailed ? [inspectionError, closeError] : [closeError],
			"Authority header inspection and close failed.",
			async () => {
				await file.close();
			},
		);
	}
	if (inspectionFailed) throw inspectionError;
	return evidence;
}

function isSessionHeader(value: unknown): value is { type: "session"; id: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "session" &&
		"id" in value &&
		typeof value.id === "string" &&
		value.id.length > 0
	);
}

function isEnoent(error: unknown): boolean {
	return isFsError(error, "ENOENT");
}

function isEexist(error: unknown): boolean {
	return isFsError(error, "EEXIST");
}

function isFsError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function retainAuthorityCleanup(
	primary: unknown,
	additionalErrors: readonly unknown[],
	message: string,
	cleanup: () => Promise<void>,
): AuthorityCleanupError {
	const errors = primary instanceof AuthorityCleanupError ? [...primary.errors] : [primary];
	if (primary instanceof AuthorityCleanupError && primary.pending) {
		return new AuthorityCleanupError([...errors, ...additionalErrors], message, async () => {
			try {
				await primary.cleanup();
			} catch (cleanupError) {
				throw primary.errors.at(-1) ?? cleanupError;
			}
			await cleanup();
		});
	}
	return new AuthorityCleanupError([...errors, ...additionalErrors], message, cleanup);
}

function noFollow(): number {
	return "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}
