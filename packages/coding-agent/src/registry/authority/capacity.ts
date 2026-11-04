import * as fs from "node:fs";
import { durableFsyncSync } from "./durable-sync";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import type { FileHandle } from "node:fs/promises";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import type { CapacityPoolState } from "./capacity-native";

export interface AuthorityCapacityFile {
	readonly handle: FileHandle;
	readonly identity: { readonly fd: number; readonly device: bigint; readonly inode: bigint };
}

const LINUX_O_TMPFILE = 0o20200000;

export class AuthorityCapacityFileOpenError extends AggregateError {
	readonly handle: FileHandle;

	constructor(primary: unknown, closeError: unknown, handle: FileHandle) {
		super([primary, closeError], "Authority capacity backing validation and descriptor cleanup failed", {
			cause: primary,
		});
		this.name = "AuthorityCapacityFileOpenError";
		this.handle = handle;
	}
}

/** Opens an anonymous inode in the authority directory without allocating data on the caller thread. */
export async function openAuthorityCapacityFile(directory: string): Promise<AuthorityCapacityFile> {
	if (os.platform() !== "linux" || os.arch() !== "x64")
		throw new Error("Physical authority capacity requires the supported Linux x86_64 O_TMPFILE ABI");
	const handle = await fsp.open(directory, LINUX_O_TMPFILE | fs.constants.O_RDWR, 0o600);
	try {
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile() || stat.nlink !== 0n || (stat.mode & 0o077n) !== 0n)
			throw new Error("Authority capacity backing is not a private anonymous regular file");
		return Object.freeze({ handle, identity: Object.freeze({ fd: handle.fd, device: stat.dev, inode: stat.ino }) });
	} catch (error) {
		try {
			await handle.close();
		} catch (closeError) {
			throw new AuthorityCapacityFileOpenError(error, closeError, handle);
		}
		throw error;
	}
}

const XFS_BLOCK_BYTES = 4096;
const XFS_BMBT_MIN_RECORDS = 125;
const XFS_BMBT_MAX_LEVELS = 7;
const XFS_MAX_FALLOCATE_CHUNK_BLOCKS = XFS_BMBT_MAX_LEVELS - 1;
const XFS_CONVERSION_WORKSPACE_BLOCKS = 2 * (XFS_BMBT_MAX_LEVELS - 1);

export interface AuthorityXfsTargetHorizons {
	readonly databaseBytes: number;
	readonly walBytes: number;
	readonly shmBytes: number;
}

export interface AuthorityXfsTargetEnvelope {
	readonly dataBlocks: number;
	readonly metadataBlocks: number;
	readonly workspaceBlocks: number;
	readonly totalBytes: number;
}

/**
 * Conservative XFS data-fork and transient quota envelope for the SQLite target
 * horizons. Each horizon is independent; no multiplier is assumed between
 * target logical bytes and target metadata. Input horizons must already include
 * the current file prefix and every projected future DB/WAL/SHM allocation.
 */
export function xfsTargetEnvelope(horizons: AuthorityXfsTargetHorizons): AuthorityXfsTargetEnvelope {
	const targets = [horizons.databaseBytes, horizons.walBytes, horizons.shmBytes];
	let dataBlocks = 0;
	let metadataBlocks = 0;
	let workspaceBlocks = 0;
	for (const bytes of targets) {
		if (!Number.isSafeInteger(bytes) || bytes < 0)
			throw new RangeError("XFS target horizon must be a nonnegative safe integer");
		const blocks = Math.ceil(bytes / XFS_BLOCK_BYTES);
		if (!Number.isSafeInteger(blocks)) throw new RangeError("XFS target block count exceeds the safe integer range");
		if (blocks === 0) continue;
		dataBlocks += blocks;
		let levelBlocks = Math.ceil(blocks / XFS_BMBT_MIN_RECORDS) + 1;
		metadataBlocks += levelBlocks;
		for (let level = 1; level < XFS_BMBT_MAX_LEVELS; level++) {
			levelBlocks = Math.ceil(levelBlocks / XFS_BMBT_MIN_RECORDS) + 1;
			metadataBlocks += levelBlocks;
		}
		// Bound each <=6-block allocation; unwritten conversion reserves two
		// bmbt splits independently of byte count (xfs_iomap.c:586-596).
		workspaceBlocks += Math.max(
			XFS_MAX_FALLOCATE_CHUNK_BLOCKS + XFS_BMBT_MAX_LEVELS - 1,
			XFS_CONVERSION_WORKSPACE_BLOCKS,
		);
	}
	const totalBlocks = dataBlocks + metadataBlocks + workspaceBlocks;
	const totalBytes = totalBlocks * XFS_BLOCK_BYTES;
	if (![dataBlocks, metadataBlocks, workspaceBlocks, totalBytes].every(Number.isSafeInteger))
		throw new RangeError("XFS target envelope exceeds the safe integer range");
	return { dataBlocks, metadataBlocks, workspaceBlocks, totalBytes };
}

export interface AuthorityCapacityTargetCertificate {
	readonly device: bigint;
	readonly inode: bigint;
	readonly projectId: number;
	readonly blockSize: number;
	readonly logicalBytes: number;
	readonly coveredBytes: number;
	/** Allocated but reflink-shared bytes after the private prefix: never credited. */
	readonly sharedBytes: number;
	/** End of the observed dense allocation (shared or private, funded arena included): a readback bound, never credit. */
	readonly allocatedBytes: number;
}

interface TargetNativeLibrary {
	readonly symbols: {
		readonly fallocate: (fd: number, mode: number, offset: bigint, length: bigint) => number;
		readonly ioctl: (fd: number, request: number, argument: ReturnType<typeof ptr>) => number;
		readonly statx: (
			fd: number,
			pathname: ReturnType<typeof ptr>,
			flags: number,
			mask: number,
			result: ReturnType<typeof ptr>,
		) => number;
		readonly __errno_location: () => Pointer | bigint | null;
	};
}
let targetNative: TargetNativeLibrary | undefined;
function openTargetNative(): TargetNativeLibrary {
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error("Authority targets require Linux x86_64");
	return dlopen("libc.so.6", {
		fallocate: { args: [FFIType.i32, FFIType.i32, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
		ioctl: { args: [FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		statx: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		__errno_location: { args: [], returns: FFIType.ptr },
	});
}

function targetSymbols() {
	return (targetNative ??= openTargetNative()).symbols;
}

function targetSyscallError(operation: string): Error {
	const pointer = targetSymbols().__errno_location();
	if (pointer === null || pointer === 0 || pointer === 0n)
		throw new Error(`${operation} failed and libc returned a null errno pointer`);
	const errno = new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true);
	return Object.assign(new Error(`${operation} failed with Linux errno ${errno}`), {
		errno: -errno,
		code: `ERRNO_${errno}`,
	});
}

// Synchronous scratch for target readbacks (each worker isolate has its own module instance).
const targetAttributes = Buffer.alloc(28);
const targetStatx = Buffer.alloc(256);
const TARGET_EMPTY_PATH = Buffer.from("\0");

function targetIdentity(fd: number, domain: CapacityPoolState): AuthorityCapacityTargetCertificate {
	const stat = fs.fstatSync(fd, { bigint: true });
	const owner = process.getuid?.();
	if (
		!stat.isFile() ||
		stat.nlink !== 1n ||
		(stat.mode & 0o077n) !== 0n ||
		owner === undefined ||
		stat.uid !== BigInt(owner) ||
		stat.dev !== domain.device
	)
		throw new Error("Authority target must be an exact private, singly linked regular inode on the capacity device");
	// 125 is the smaller CRC/non-CRC 4KiB bmbt minimum; the 48-bit extent
	// ceiling gives at most seven levels. No free-space statistic supplies credit.
	// st_dev names one mounted filesystem instance, and the borrowed pool on that same device was proved to be XFS
	// with `domain.blockSize` blocks (capacity-native readNativeIdentity), so the target shares that geometry
	// without a statfs of its own on every readback.
	if (domain.blockSize !== 4_096)
		throw new Error("Authority target requires the supported 4KiB XFS allocation geometry");
	const attributes = targetAttributes.fill(0);
	if (targetSymbols().ioctl(fd, 0x801c581f, ptr(attributes)) !== 0)
		throw targetSyscallError("FS_IOC_FSGETXATTR(target)");
	if (
		(attributes.readUInt32LE(0) & ~(0x00000002 | 0x80000000)) !== 0 ||
		attributes.readUInt32LE(12) !== domain.projectId
	)
		throw new Error("Authority target has a different project or unsupported realtime, hint, CoW, or DAX flags");
	const statx = targetStatx.fill(0);
	if (targetSymbols().statx(fd, ptr(TARGET_EMPTY_PATH), 0x1000, 0x7ff, ptr(statx)) !== 0)
		throw targetSyscallError("statx(target)");
	if ((statx.readBigUInt64LE(56) & 0x00200000n) === 0n || (statx.readBigUInt64LE(8) & 0x00200000n) !== 0n)
		throw new Error("Authority target is not proved effectively non-DAX");
	const logicalBytes = Number(stat.size);
	if (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0)
		throw new Error("Authority target EOF is outside the safe allocation range");
	return {
		device: stat.dev,
		inode: stat.ino,
		projectId: domain.projectId,
		blockSize: 4_096,
		logicalBytes,
		coveredBytes: 0,
		sharedBytes: 0,
		allocatedBytes: 0,
	};
}

interface TargetCoverage {
	/** End of the dense privately owned prefix: the only backing credit. */
	readonly privateBytes: number;
	/** End of the dense allocation, including reflink-shared extents. */
	readonly allocatedBytes: number;
}

const FIEMAP_EXTENT_LAST = 0x1;
const FIEMAP_EXTENT_UNWRITTEN = 0x800;
const FIEMAP_EXTENT_MERGED = 0x1000;
const FIEMAP_EXTENT_SHARED = 0x2000;

// One FIEMAP batch, reused: the scan is synchronous and each worker isolate has its own module instance. A
// reflink-unshared target can hold thousands of extents, so a large batch keeps a full readback to few ioctls.
const FIEMAP_BATCH = 512;
const fiemapBuffer = Buffer.alloc(32 + FIEMAP_BATCH * 56);
const TWO_POW_32 = 2 ** 32;

/** A FIEMAP u64 field as a Number; every value this scan accepts is bounded by a safe-integer horizon. */
function fiemapU64(map: Buffer, offset: number): number {
	const high = map.readUInt32LE(offset + 4);
	if (high >= 0x200000)
		throw new Error("Authority target FIEMAP returned an offset outside the safe allocation range");
	return high * TWO_POW_32 + map.readUInt32LE(offset);
}

/** Cumulative readback work in this isolate, for cost contracts (work per steady-state command). */
export interface AuthorityTargetReadbackStats {
	/** Target backing certifications (full or suffix readbacks); funding increments are not counted. */
	readonly inspections: number;
	/** FIEMAP ioctls issued against targets. */
	readonly fiemapCalls: number;
	/** Logical bytes the returned extents spanned, from each scan's start. */
	readonly scannedBytes: number;
	/** The part of `scannedBytes` below the target's EOF: written history re-proved. */
	readonly prefixBytes: number;
}
const readbackStats = { inspections: 0, fiemapCalls: 0, scannedBytes: 0, prefixBytes: 0 };

export function authorityTargetReadbackStats(): AuthorityTargetReadbackStats {
	return { ...readbackStats };
}

/*
 * FIEMAP_FLAG_SYNC first writes back dirty pages so delayed allocation is never credited. Already-allocated extents
 * are reported identically without it, and writeback can only turn delalloc into allocation or a shared extent into
 * a private copy, so an unsynced scan that sees no delalloc, unknown, or otherwise unsupported extent certifies no
 * more than the synced one would. Any rejection falls back to the authoritative synced scan, whose verdict stands.
 * Skipping the sync matters for targets dirtied through mmap (the SQLite WAL index), where it forced a device
 * writeback on every command.
 */
/**
 * Coverage of `[start, ...)` up to the horizon `end`. With `stop`, the scan ends once it has certified `[start, stop)`:
 * a funding step only needs its own range proved, and scanning on to the horizon from every step made unsharing a
 * reflinked target quadratic in its size. `logicalBytes` (the target's EOF) only attributes work to the statistics.
 */
function targetCoverage(
	fd: number,
	start: number,
	end: number,
	logicalBytes: number,
	stop = Number.POSITIVE_INFINITY,
): TargetCoverage {
	try {
		return scanTargetCoverage(fd, start, end, false, logicalBytes, stop);
	} catch {
		return scanTargetCoverage(fd, start, end, true, logicalBytes, stop);
	}
}

function scanTargetCoverage(
	fd: number,
	start: number,
	end: number,
	sync: boolean,
	logicalBytes: number,
	stop: number,
): TargetCoverage {
	let cursor = start;
	// A write into a shared extent needs a fresh copy-on-write allocation, so
	// coverage credit stops at the first one even though later extents are scanned.
	let privateEnd: number | undefined;
	let finished = false;
	const map = fiemapBuffer;
	while (!finished && cursor < stop) {
		map.fill(0, 0, 32);
		map.writeBigUInt64LE(BigInt(cursor), 0);
		map.writeBigUInt64LE(Number.isFinite(stop) ? BigInt(stop - cursor) : (1n << 64n) - 1n - BigInt(cursor), 8);
		map.writeUInt32LE(sync ? 1 : 0, 16); // FIEMAP_FLAG_SYNC
		map.writeUInt32LE(FIEMAP_BATCH, 24);
		readbackStats.fiemapCalls++;
		if (targetSymbols().ioctl(fd, 0xc020660b, ptr(map)) !== 0) throw targetSyscallError("FIEMAP(target)");
		const count = map.readUInt32LE(20);
		if (count > FIEMAP_BATCH) throw new Error("Authority target FIEMAP returned an invalid count");
		if (count === 0) break;
		for (let index = 0; index < count; index++) {
			const offset = 32 + index * 56;
			const logical = fiemapU64(map, offset);
			const length = fiemapU64(map, offset + 16);
			const flags = map.readUInt32LE(offset + 40);
			// FIEMAP may return the whole coalesced extent containing start. The
			// earlier prefix was certified already; only this first overlap is legal.
			const overlapsPrefix = cursor === start && start !== 0 && logical < cursor;
			if (
				(!overlapsPrefix && logical !== cursor) ||
				length === 0 ||
				logical + length <= cursor ||
				(flags & ~(FIEMAP_EXTENT_LAST | FIEMAP_EXTENT_UNWRITTEN | FIEMAP_EXTENT_MERGED | FIEMAP_EXTENT_SHARED)) !==
					0
			)
				throw new Error(
					`Authority target coverage is sparse, delayed, unknown, or otherwise unsupported (extent ${logical}+${length} at ${cursor}, flags 0x${flags.toString(16)})`,
				);
			if ((flags & FIEMAP_EXTENT_SHARED) !== 0) privateEnd ??= cursor;
			cursor = logical + length;
			if (cursor > end)
				throw new Error(
					`Authority target has unaccounted beyond-horizon allocation (allocated to ${cursor}, horizon ${end})`,
				);
			if ((flags & FIEMAP_EXTENT_LAST) !== 0) finished = true;
		}
	}
	readbackStats.scannedBytes += cursor - start;
	readbackStats.prefixBytes += Math.max(0, Math.min(cursor, logicalBytes) - start);
	return { privateBytes: privateEnd ?? cursor, allocatedBytes: cursor };
}

function targetAlignedBytes(bytes: number): number {
	const aligned = Math.ceil(bytes / 4_096) * 4_096;
	if (!Number.isSafeInteger(aligned) || aligned < 0)
		throw new RangeError("Authority target alignment exceeds the safe allocation range");
	return aligned;
}

/** FIEMAP is the backing proof; EOF and st_blocks are never backing credit. */
export function inspectAuthorityCapacityTarget(
	fd: number,
	domain: CapacityPoolState,
	horizon: number,
	requiredBytes = horizon,
): AuthorityCapacityTargetCertificate {
	if (!Number.isSafeInteger(horizon) || horizon < 0) throw new RangeError("Invalid authority target horizon");
	if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > horizon)
		throw new RangeError("Invalid authority required coverage");
	readbackStats.inspections++;
	const identity = targetIdentity(fd, domain);
	const end = targetAlignedBytes(Math.max(horizon, identity.logicalBytes));
	const coverage = targetCoverage(fd, 0, end, identity.logicalBytes);
	// Shared extents inside EOF are allocated but uncredited; funding unshares them.
	if (
		coverage.allocatedBytes < targetAlignedBytes(identity.logicalBytes) ||
		coverage.privateBytes < targetAlignedBytes(requiredBytes)
	)
		throw new Error("Authority target has an unfunded allocation hole");
	assertTargetStable(fd, identity);
	return {
		...identity,
		coveredBytes: coverage.privateBytes,
		sharedBytes: coverage.allocatedBytes - coverage.privateBytes,
		allocatedBytes: coverage.allocatedBytes,
	};
}

/*
 * The scan must describe one inode at one EOF. Ownership, mode, project, flags and DAX were proved just before it;
 * this re-check covers what a concurrent replacement or resize would change during it (inode, device, EOF, link count).
 */
function assertTargetStable(fd: number, identity: AuthorityCapacityTargetCertificate): void {
	const after = fs.fstatSync(fd, { bigint: true });
	if (
		after.dev !== identity.device ||
		after.ino !== identity.inode ||
		after.size !== BigInt(identity.logicalBytes) ||
		after.nlink !== 1n
	)
		throw new Error("Authority target identity or EOF changed during backing readback");
}

/**
 * Readback of an APPEND-ONLY target (the JSONL journal) that re-proves only where future writes land: the block
 * holding EOF and everything past it (the funded KEEP_SIZE arena, plus any allocation beyond it for the horizon check).
 * `[0, alignDown(EOF))` keeps the private credit `prefix` certified for this same inode. The owner never rewrites or
 * re-allocates written bytes below its EOF (appends only; an undo cut and a rotation re-certify through their own
 * paths), so a later loss or sharing of those blocks cannot require any allocation by the owner's writes: it can
 * change no promise. Sharing or loss at or past EOF, where the owner does write, is still caught on every readback,
 * which is what keeps a reflink copy taken between commands from being credited. Returns undefined when `prefix`
 * cannot vouch for the prefix (different inode, EOF moved backwards, or EOF beyond its private prefix), so the
 * caller falls back to a full readback.
 */
export function inspectAuthorityCapacityTargetSuffix(
	fd: number,
	domain: CapacityPoolState,
	horizon: number,
	prefix: AuthorityCapacityTargetCertificate,
): AuthorityCapacityTargetCertificate | undefined {
	if (!Number.isSafeInteger(horizon) || horizon < 0) throw new RangeError("Invalid authority target horizon");
	const identity = targetIdentity(fd, domain);
	const start = Math.floor(identity.logicalBytes / 4_096) * 4_096;
	if (
		identity.device !== prefix.device ||
		identity.inode !== prefix.inode ||
		identity.projectId !== prefix.projectId ||
		identity.logicalBytes < prefix.logicalBytes ||
		start > prefix.coveredBytes
	)
		return undefined;
	readbackStats.inspections++;
	const end = targetAlignedBytes(Math.max(horizon, identity.logicalBytes, prefix.allocatedBytes));
	const coverage = targetCoverage(fd, start, end, identity.logicalBytes);
	if (coverage.allocatedBytes < targetAlignedBytes(identity.logicalBytes))
		throw new Error("Authority target has an unfunded allocation hole");
	assertTargetStable(fd, identity);
	return {
		...identity,
		coveredBytes: coverage.privateBytes,
		sharedBytes: coverage.allocatedBytes - coverage.privateBytes,
		allocatedBytes: coverage.allocatedBytes,
	};
}

const FALLOC_FL_KEEP_SIZE = 0x01;
const FALLOC_FL_UNSHARE_RANGE = 0x40;

/**
 * Where a funding transfer's space comes from. Each step is allocated into the target first, from space outside
 * the pool, and `allocated` reports it; the caller shrinks the pool afterwards. Only when a step fails for lack
 * of space (ENOSPC or EDQUOT) is `makeRoom` asked to release pool data for it now; it returns false when it has
 * nothing left to release, and the step is retried once.
 */
export interface AuthorityTargetFunding {
	allocated?(bytes: number): void;
	makeRoom?(bytes: number): boolean;
}

function exhaustedTargetSpace(error: Error): boolean {
	const code = (error as { code?: unknown }).code;
	return code === "ERRNO_28" || code === "ERRNO_122";
}

/**
 * KEEP_SIZE preserves SQLite headers, WAL layout, and JSONL's append position.
 * `funding` sees each allocation step (see {@link AuthorityTargetFunding}): allocation precedes any pool release,
 * so freed pool blocks are never exposed to other writers before the target holds what they pay for.
 * `allocationEnd` is the end of allocation the caller already accounted (a funded arena above
 * reflink-shared extents); coverage readback may scan that far, but funding stops at `horizon`.
 */
export function fundAuthorityCapacityTarget(
	fd: number,
	domain: CapacityPoolState,
	horizon: number,
	prefix?: AuthorityCapacityTargetCertificate,
	funding?: AuthorityTargetFunding,
	allocationEnd = 0,
): AuthorityCapacityTargetCertificate {
	if (!Number.isSafeInteger(horizon) || horizon < 0) throw new RangeError("Invalid authority target horizon");
	if (!Number.isSafeInteger(allocationEnd) || allocationEnd < 0)
		throw new RangeError("Invalid authority target allocation end");
	const before = targetIdentity(fd, domain);
	const end = targetAlignedBytes(Math.max(before.logicalBytes, horizon));
	const scanEnd = Math.max(end, targetAlignedBytes(allocationEnd));
	let certificate = prefix ?? inspectAuthorityCapacityTarget(fd, domain, scanEnd, 0);
	if (
		certificate.device !== before.device ||
		certificate.inode !== before.inode ||
		certificate.projectId !== before.projectId ||
		certificate.blockSize !== before.blockSize ||
		certificate.logicalBytes !== before.logicalBytes ||
		certificate.coveredBytes > end
	)
		throw new Error("Authority target prefix certificate belongs to a different inode, EOF, or horizon");
	// Each increment is certified by its own FIEMAP_FLAG_SYNC readback; one fsync after the loop makes the whole range durable.
	const funded = certificate.coveredBytes < end;
	for (let offset = certificate.coveredBytes; offset < end; offset += 6 * 4_096) {
		const length = Math.min(end - offset, 6 * 4_096);
		// UNSHARE gives reflink-shared blocks inside EOF a private copy; elsewhere it is a plain KEEP_SIZE allocation.
		// A failed step may have allocated part of its range; the retry re-allocates the same range, which is idempotent.
		const allocate = (): number =>
			targetSymbols().fallocate(fd, FALLOC_FL_KEEP_SIZE | FALLOC_FL_UNSHARE_RANGE, BigInt(offset), BigInt(length));
		if (allocate() !== 0) {
			const error = targetSyscallError("fallocate(KEEP_SIZE|UNSHARE_RANGE,target)");
			if (!exhaustedTargetSpace(error) || !funding?.makeRoom?.(length)) throw error;
			if (allocate() !== 0) throw targetSyscallError("fallocate(KEEP_SIZE|UNSHARE_RANGE,target)");
		}
		funding?.allocated?.(length);
		// Per step, only the inode and its EOF can matter to the increment: the descriptor cannot be retargeted without
		// a device/inode change, and ownership, project, geometry and DAX are re-proved in full after the last step,
		// before the certificate is returned as credit. FIEMAP below still certifies every increment.
		const step = fs.fstatSync(fd, { bigint: true });
		if (step.ino !== before.inode || step.dev !== before.device || step.size !== BigInt(before.logicalBytes))
			throw new Error("Authority target funding changed inode identity or logical EOF");
		// Each increment certifies its own range; what lies past the funded end is read once, after the last step.
		const coverage = targetCoverage(fd, offset, scanEnd, before.logicalBytes, offset + length);
		if (coverage.privateBytes < offset + length)
			throw new Error("Authority target increment has an unfunded allocation hole");
		certificate = { ...certificate, coveredBytes: offset + length };
	}
	if (funded) {
		// Allocation after a still-shared range already exists inside the horizon (or the accounted arena), so the
		// tail is scanned to `scanEnd`, which also re-checks for unaccounted allocation beyond the horizon.
		const tail = targetCoverage(fd, end, scanEnd, before.logicalBytes);
		certificate = {
			...certificate,
			sharedBytes: Math.max(0, tail.allocatedBytes - Math.max(tail.privateBytes, end)),
			allocatedBytes: Math.max(tail.allocatedBytes, end),
		};
		durableFsyncSync(fd);
		const after = targetIdentity(fd, domain);
		if (after.inode !== before.inode || after.device !== before.device || after.logicalBytes !== before.logicalBytes)
			throw new Error("Authority target funding changed inode identity or logical EOF");
		certificate = {
			...after,
			coveredBytes: certificate.coveredBytes,
			sharedBytes: certificate.sharedBytes,
			allocatedBytes: certificate.allocatedBytes,
		};
	}
	return certificate;
}

const FALLOC_FL_PUNCH_HOLE = 0x02;

/**
 * Returns a retired target's allocation in `[from, to)` (a funded KEEP_SIZE arena past its EOF that no append
 * will ever use) to the filesystem. Only whole blocks at or past the aligned EOF are released; data inside
 * EOF is never touched.
 */
export function releaseAuthorityTargetArena(fd: number, to: number): void {
	const from = targetAlignedBytes(fs.fstatSync(fd).size);
	if (!Number.isSafeInteger(to) || to <= from) return;
	if (targetSymbols().fallocate(fd, FALLOC_FL_KEEP_SIZE | FALLOC_FL_PUNCH_HOLE, BigInt(from), BigInt(to - from)) !== 0)
		throw targetSyscallError("fallocate(KEEP_SIZE|PUNCH_HOLE,retired target)");
}
