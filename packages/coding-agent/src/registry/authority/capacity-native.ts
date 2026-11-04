import * as fs from "node:fs";
import { durableFsyncSync } from "./durable-sync";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

export interface BorrowedCapacityIdentity {
	readonly fd: number;
	readonly device: bigint;
	readonly inode: bigint;
}

export interface CapacityPoolState {
	readonly dataBytes: number;
	readonly allocatedBytes: number;
	readonly device: bigint;
	readonly inode: bigint;
	readonly projectId: number;
	readonly blockSize: number;
}

export interface CapacityPoolRelease {
	readonly before: CapacityPoolState;
	readonly after: CapacityPoolState;
	readonly releasedDataBytes: number;
}

export class AuthorityCapacityPoolError extends Error {
	readonly poolState: "verified" | "uncertain";
	readonly state?: CapacityPoolState;

	constructor(message: string, poolState: "verified" | "uncertain", state?: CapacityPoolState, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AuthorityCapacityPoolError";
		this.poolState = poolState;
		if (state !== undefined) this.state = state;
	}
}

interface NativeSymbols {
	readonly fallocate: (fd: number, mode: number, offset: bigint, length: bigint) => number;
	readonly ioctl: (fd: number, request: number, argument: ReturnType<typeof ptr>) => number;
	readonly fcntl: (fd: number, command: number) => number;
	readonly statx: (
		dirfd: number,
		pathname: ReturnType<typeof ptr>,
		flags: number,
		mask: number,
		result: ReturnType<typeof ptr>,
	) => number;
	readonly __errno_location: () => ReturnType<typeof ptr>;
}

interface NativeIdentity {
	readonly stat: fs.BigIntStats;
	readonly blockSize: number;
	readonly projectId: number;
}

const XFS_MAGIC = 0x58465342;
const FS_IOC_FSGETXATTR = 0x801c581f;
const FS_IOC_FIEMAP = 0xc020660b;
const FIEMAP_FLAG_SYNC = 0x1;
const FIEMAP_EXTENT_LAST = 0x1;
const FIEMAP_EXTENT_UNKNOWN = 0x2;
const FIEMAP_EXTENT_DELALLOC = 0x4;
const FIEMAP_EXTENT_UNWRITTEN = 0x800;
const FIEMAP_EXTENT_MERGED = 0x1000;
const FIEMAP_EXTENT_SHARED = 0x2000;
const FSXATTR_SIZE = 28;
// PREALLOC and HASATTR are state indicators; allocation coverage is proved separately.
const FS_XFLAG_PREALLOC = 0x00000002;
const FS_XFLAG_HASATTR = 0x80000000;
const FS_XFLAG_BENIGN_STATE = FS_XFLAG_PREALLOC | FS_XFLAG_HASATTR;
const FIEMAP_HEADER_SIZE = 32;
const FIEMAP_EXTENT_SIZE = 56;
const FIEMAP_BATCH = 128;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const FALLOC_FL_KEEP_SIZE = 0x01;
const FALLOC_FL_PUNCH_HOLE = 0x02;
let nativeSymbols: NativeSymbols | undefined;
let nativeLibrary: { symbols: NativeSymbols } | undefined;

function native(): NativeSymbols {
	if (!nativeSymbols) {
		try {
			const library = dlopen("libc.so.6", {
				fallocate: { args: [FFIType.i32, FFIType.i32, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
				ioctl: { args: [FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
				fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				statx: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			nativeLibrary = library as { symbols: NativeSymbols };
			nativeSymbols = nativeLibrary.symbols;
		} catch (cause) {
			throw new AuthorityCapacityPoolError(
				"The supported Linux libc native ABI is unavailable",
				"uncertain",
				undefined,
				cause,
			);
		}
	}
	return nativeSymbols;
}

function errnoValue(): number {
	const memory = toArrayBuffer(native().__errno_location(), 0, 4);
	return new DataView(memory).getInt32(0, true);
}

function syscallError(operation: string): Error {
	const code = errnoValue();
	const error = new Error(`${operation} failed with Linux errno ${code}`);
	Object.assign(error, { errno: -code, code: `ERRNO_${code}` });
	return error;
}

function requireLinuxAbi(): void {
	if (process.platform !== "linux" || process.arch !== "x64") {
		throw new AuthorityCapacityPoolError("Native capacity pools require the supported Linux x86_64 ABI", "uncertain");
	}
}

function descriptorPath(fd: number): string {
	return `/proc/self/fd/${fd}`;
}

const STATX_ATTRIBUTES_DAX = 0x00200000n;
// Synchronous single-thread scratch for the native readbacks (each worker isolate has its own module instance).
const identityAttributes = Buffer.alloc(FSXATTR_SIZE);
const identityStatx = Buffer.alloc(256);
const EMPTY_PATH = Buffer.from("\0");

function readNativeIdentity(identity: BorrowedCapacityIdentity): NativeIdentity {
	let stat: fs.BigIntStats;
	let filesystem: fs.StatsFs;
	try {
		stat = fs.statSync(descriptorPath(identity.fd), { bigint: true });
		filesystem = fs.statfsSync(descriptorPath(identity.fd));
	} catch (cause) {
		throw new AuthorityCapacityPoolError(
			"Borrowed descriptor is not currently a readable live inode",
			"uncertain",
			undefined,
			cause,
		);
	}
	const device = BigInt(stat.dev);
	const inode = BigInt(stat.ino);
	if (device !== identity.device || inode !== identity.inode) {
		throw new AuthorityCapacityPoolError("Borrowed descriptor identity changed", "uncertain");
	}
	if (!stat.isFile() || stat.nlink !== 0n) {
		throw new AuthorityCapacityPoolError("Capacity inode must be an ordinary anonymous unlinked file", "verified");
	}
	if (filesystem.type !== XFS_MAGIC || !Number.isSafeInteger(filesystem.bsize) || filesystem.bsize <= 0) {
		throw new AuthorityCapacityPoolError("Capacity inode must reside on supported Linux XFS", "verified");
	}
	const accessMode = native().fcntl(identity.fd, 3);
	if (accessMode < 0)
		throw new AuthorityCapacityPoolError(
			"Could not read borrowed descriptor access mode",
			"uncertain",
			undefined,
			syscallError("fcntl(F_GETFL)"),
		);
	if ((accessMode & 3) === 0)
		throw new AuthorityCapacityPoolError("Capacity descriptor must be open for writing", "verified");
	const attributes = identityAttributes.fill(0);
	if (native().ioctl(identity.fd, FS_IOC_FSGETXATTR, ptr(attributes)) !== 0) {
		throw new AuthorityCapacityPoolError(
			"Could not read XFS inode project and extent attributes",
			"uncertain",
			undefined,
			syscallError("FS_IOC_FSGETXATTR"),
		);
	}
	const xflags = attributes.readUInt32LE(0);
	const projectId = attributes.readUInt32LE(12);
	if ((xflags & ~FS_XFLAG_BENIGN_STATE) !== 0)
		throw new AuthorityCapacityPoolError(
			"Capacity inode has realtime, DAX, extent-hint, CoW, or other unsupported XFS flags",
			"verified",
		);
	const statx = identityStatx.fill(0);
	if (native().statx(identity.fd, ptr(EMPTY_PATH), 0x1000, 0x7ff, ptr(statx)) !== 0) {
		throw new AuthorityCapacityPoolError(
			"Could not read effective inode DAX attributes",
			"uncertain",
			undefined,
			syscallError("statx"),
		);
	}
	const attributesMask = statx.readBigUInt64LE(56);
	const effectiveAttributes = statx.readBigUInt64LE(8);
	if ((attributesMask & STATX_ATTRIBUTES_DAX) === 0n || (effectiveAttributes & STATX_ATTRIBUTES_DAX) !== 0n) {
		throw new AuthorityCapacityPoolError("Filesystem does not prove the inode is effectively non-DAX", "verified");
	}
	return { stat, blockSize: filesystem.bsize, projectId };
}

interface Extent {
	readonly logical: bigint;
	readonly length: bigint;
	readonly flags: number;
}

function fiemap(identity: BorrowedCapacityIdentity, start: bigint, length: bigint): Extent[] {
	const extents: Extent[] = [];
	let cursor = start;
	const end = start + length;
	while (cursor < end) {
		const buffer = Buffer.alloc(FIEMAP_HEADER_SIZE + FIEMAP_BATCH * FIEMAP_EXTENT_SIZE);
		buffer.writeBigUInt64LE(cursor, 0);
		buffer.writeBigUInt64LE(end - cursor, 8);
		buffer.writeUInt32LE(FIEMAP_FLAG_SYNC, 16);
		buffer.writeUInt32LE(FIEMAP_BATCH, 24);
		if (native().ioctl(identity.fd, FS_IOC_FIEMAP, ptr(buffer)) !== 0) {
			throw syscallError("FIEMAP");
		}
		const count = buffer.readUInt32LE(20);
		if (count > FIEMAP_BATCH) throw new Error("FIEMAP returned an invalid extent count");
		if (count === 0) break;
		let last = false;
		for (let index = 0; index < count; index++) {
			const offset = FIEMAP_HEADER_SIZE + index * FIEMAP_EXTENT_SIZE;
			const logical = buffer.readBigUInt64LE(offset);
			const extentLength = buffer.readBigUInt64LE(offset + 16);
			const flags = buffer.readUInt32LE(offset + 40);
			if (extentLength === 0n) throw new Error("FIEMAP returned an empty extent");
			extents.push({ logical, length: extentLength, flags });
			const next = logical + extentLength;
			if (next > cursor) cursor = next;
			if ((flags & FIEMAP_EXTENT_LAST) !== 0) last = true;
		}
		if (last || cursor >= end) break;
		if (cursor <= start || cursor >= end) break;
	}
	return extents;
}

function proveDenseCoverage(identity: BorrowedCapacityIdentity, start: bigint, end: bigint): void {
	if (start === end) return;
	const extents = fiemap(identity, start, end - start);
	let cursor = start;
	for (const extent of extents) {
		const extentEnd = extent.logical + extent.length;
		if (extentEnd <= cursor) continue;
		if (extent.logical > cursor) throw new Error("FIEMAP did not prove dense allocated coverage");
		if (extentEnd > end) throw new Error("FIEMAP found allocation beyond the verified EOF range");
		const disallowed = FIEMAP_EXTENT_UNKNOWN | FIEMAP_EXTENT_DELALLOC | FIEMAP_EXTENT_SHARED;
		if ((extent.flags & disallowed) !== 0) throw new Error("FIEMAP coverage is shared, delayed, or unknown");
		const supportedFlags = FIEMAP_EXTENT_LAST | FIEMAP_EXTENT_UNWRITTEN | FIEMAP_EXTENT_MERGED;
		if ((extent.flags & ~supportedFlags) !== 0) throw new Error("FIEMAP returned unsupported extent attributes");
		cursor = extentEnd;
		if (cursor === end) break;
	}
	if (cursor !== end) throw new Error("FIEMAP left an uncovered hole in the capacity pool");
}
function proveFullCoverage(identity: BorrowedCapacityIdentity, end: bigint): void {
	const extents = fiemap(identity, 0n, (1n << 64n) - 1n);
	let cursor = 0n;
	for (const extent of extents) {
		if (extent.logical !== cursor || extent.length <= 0n)
			throw new Error("FIEMAP did not prove dense allocated coverage");
		const disallowed = FIEMAP_EXTENT_UNKNOWN | FIEMAP_EXTENT_DELALLOC | FIEMAP_EXTENT_SHARED;
		if ((extent.flags & disallowed) !== 0) throw new Error("FIEMAP coverage is shared, delayed, or unknown");
		const supportedFlags = FIEMAP_EXTENT_LAST | FIEMAP_EXTENT_UNWRITTEN | FIEMAP_EXTENT_MERGED;
		if ((extent.flags & ~supportedFlags) !== 0) throw new Error("FIEMAP returned unsupported extent attributes");
		cursor += extent.length;
		if (cursor > end) throw new Error("FIEMAP found an allocation beyond actual EOF");
	}
	if (cursor !== end) throw new Error("FIEMAP left an uncovered hole in the capacity pool");
}

function toNumber(value: bigint, field: string): number {
	if (value < 0n || value > MAX_SAFE_BIGINT) throw new Error(`${field} exceeds the safe native capacity range`);
	return Number(value);
}

export class BorrowedAuthorityCapacityPool {
	// The borrower retains and exclusively mutates this descriptor for the worker lifetime.
	// Open/reconcile establish the full prefix; successful mutations prove only changed ranges.
	readonly #identity: BorrowedCapacityIdentity;
	readonly #projectId: number;
	readonly #blockSize: number;
	#dataBytes: bigint;
	#uncertain = false;

	private constructor(identity: BorrowedCapacityIdentity, projectId: number, blockSize: number, dataBytes: bigint) {
		this.#identity = Object.freeze({ fd: identity.fd, device: identity.device, inode: identity.inode });
		this.#projectId = projectId;
		this.#blockSize = blockSize;
		this.#dataBytes = dataBytes;
	}

	static open(identity: BorrowedCapacityIdentity): BorrowedAuthorityCapacityPool {
		requireLinuxAbi();
		if (
			typeof identity !== "object" ||
			identity === null ||
			!Number.isSafeInteger(identity.fd) ||
			identity.fd < 0 ||
			typeof identity.device !== "bigint" ||
			typeof identity.inode !== "bigint" ||
			identity.device < 0n ||
			identity.inode < 0n
		) {
			throw new AuthorityCapacityPoolError("Invalid borrowed capacity inode identity", "uncertain");
		}
		const borrowedIdentity = Object.freeze({ fd: identity.fd, device: identity.device, inode: identity.inode });
		const nativeIdentity = readNativeIdentity(borrowedIdentity);
		const size = BigInt(nativeIdentity.stat.size);
		if (size < 0n || size > MAX_SAFE_BIGINT || size % BigInt(nativeIdentity.blockSize) !== 0n) {
			throw new AuthorityCapacityPoolError("Initial capacity inode size is not safely block-aligned", "verified");
		}
		try {
			durableFsyncSync(borrowedIdentity.fd);
			const syncedIdentity = readNativeIdentity(borrowedIdentity);
			if (
				BigInt(syncedIdentity.stat.size) !== size ||
				syncedIdentity.projectId !== nativeIdentity.projectId ||
				syncedIdentity.blockSize !== nativeIdentity.blockSize
			) {
				throw new Error("Initial synchronized inode metadata changed during coverage proof");
			}
			proveFullCoverage(borrowedIdentity, size);
			return new BorrowedAuthorityCapacityPool(
				borrowedIdentity,
				nativeIdentity.projectId,
				nativeIdentity.blockSize,
				size,
			);
		} catch (cause) {
			throw new AuthorityCapacityPoolError(
				"Initial capacity inode coverage could not be verified",
				"uncertain",
				undefined,
				cause,
			);
		}
	}

	/*
	 * Between mutations the pool is re-checked with an fstat and an F_GETFL of the borrowed descriptor number: inode,
	 * device, link count, exact EOF, and the access mode of whatever open file description the number now names (dup2
	 * can rebind it to a read-only description of the same inode). The rest of the proof (XFS geometry, project, flags,
	 * DAX) is a property of the inode and its filesystem, established by the last open/growth/release/reconcile, each of
	 * which re-proves it in full before returning: the filesystem and block size are fixed per mounted device; project,
	 * flags and DAX change only through FS_IOC_FSSETXATTR on a descriptor of this inode, and the unlinked O_TMPFILE inode
	 * is reachable only through this process's descriptors (host-retained, worker-borrowed), none of which issue it.
	 * Coverage of the verified EOF prefix likewise changes only through this class's own fallocate/ftruncate calls, so an
	 * unchanged EOF keeps the proved dense prefix.
	 */
	inspect(): CapacityPoolState {
		if (this.#uncertain)
			throw new AuthorityCapacityPoolError("Capacity pool state requires reconciliation", "uncertain");
		let stat: fs.BigIntStats;
		try {
			stat = fs.fstatSync(this.#identity.fd, { bigint: true });
		} catch (cause) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Capacity pool state could not be verified; reconcile before use",
				"uncertain",
				undefined,
				cause,
			);
		}
		if (
			stat.dev !== this.#identity.device ||
			stat.ino !== this.#identity.inode ||
			!stat.isFile() ||
			stat.nlink !== 0n ||
			stat.size !== this.#dataBytes
		) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Borrowed capacity inode no longer matches its verified state",
				"uncertain",
			);
		}
		const accessMode = native().fcntl(this.#identity.fd, 3);
		if (accessMode < 0 || (accessMode & 3) === 0) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Capacity pool state could not be verified; reconcile before use",
				"uncertain",
				undefined,
				new AuthorityCapacityPoolError(
					accessMode < 0
						? "Could not read borrowed descriptor access mode"
						: "Capacity descriptor must be open for writing",
					accessMode < 0 ? "uncertain" : "verified",
				),
			);
		}
		return {
			dataBytes: toNumber(this.#dataBytes, "Pool data coverage"),
			allocatedBytes: toNumber(stat.blocks * 512n, "Physical allocation"),
			device: stat.dev,
			inode: stat.ino,
			projectId: this.#projectId,
			blockSize: this.#blockSize,
		};
	}

	/**
	 * Grows the pool to `bytes`. With `maxStepBytes`, each fallocate extends EOF by at most one step and is
	 * read back before the next, so a failed step leaves at most one step of allocation beyond the verified EOF.
	 * The unlinked pool has no crash durability to preserve, so one fsync covers the whole growth.
	 */
	ensureDataBytes(bytes: number, maxStepBytes?: number): CapacityPoolState {
		this.#assertRequest(bytes);
		if (
			maxStepBytes !== undefined &&
			(!Number.isSafeInteger(maxStepBytes) || maxStepBytes < this.#blockSize || maxStepBytes % this.#blockSize !== 0)
		)
			throw new AuthorityCapacityPoolError(
				"Capacity growth step must be a positive whole number of blocks",
				this.#uncertain ? "uncertain" : "verified",
			);
		if (this.#uncertain)
			throw new AuthorityCapacityPoolError("Capacity pool state requires reconciliation before growth", "uncertain");
		const before = this.#state();
		const block = BigInt(this.#blockSize);
		const requested = BigInt(bytes);
		const target = ((requested + block - 1n) / block) * block;
		if (target <= this.#dataBytes) return before;
		if (target > MAX_SAFE_BIGINT)
			throw new AuthorityCapacityPoolError("Requested capacity exceeds the safe native range", "verified", before);
		const current = this.#dataBytes;
		const step = maxStepBytes === undefined ? target - current : BigInt(maxStepBytes);
		try {
			this.#verifyCurrentMetadata(current);
			for (let cursor = current; cursor < target;) {
				const next = cursor + step < target ? cursor + step : target;
				if (native().fallocate(this.#identity.fd, 0, cursor, next - cursor) !== 0)
					throw syscallError("fallocate(mode 0)");
				// Only EOF can differ between steps in a way the step bound depends on. The descriptor's inode cannot
				// change underneath it (a closed-and-reused fd shows a different device/inode here), the filesystem
				// geometry is fixed per mount, and project/flag/DAX/link changes move the whole inode's charge at once,
				// so they are proved by the full readbacks before the first and after the last step, before any credit.
				const stepStat = fs.fstatSync(this.#identity.fd, { bigint: true });
				if (
					stepStat.dev !== this.#identity.device ||
					stepStat.ino !== this.#identity.inode ||
					!stepStat.isFile() ||
					stepStat.nlink !== 0n ||
					stepStat.size !== next
				) {
					throw new Error("Growth step readback did not preserve inode identity and exact EOF");
				}
				cursor = next;
			}
			durableFsyncSync(this.#identity.fd);
			const nativeIdentity = readNativeIdentity(this.#identity);
			if (
				BigInt(nativeIdentity.stat.size) !== target ||
				nativeIdentity.projectId !== this.#projectId ||
				nativeIdentity.blockSize !== this.#blockSize
			) {
				throw new Error("Growth readback did not preserve inode identity, project, geometry, and exact EOF");
			}
			proveDenseCoverage(this.#identity, current, target);
			this.#dataBytes = target;
			return this.#state();
		} catch (cause) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Capacity growth may have partially changed the inode; reconcile before credit",
				"uncertain",
				undefined,
				cause,
			);
		}
	}

	releaseDataBytes(bytes: number): CapacityPoolRelease {
		this.#assertRequest(bytes);
		if (this.#uncertain)
			throw new AuthorityCapacityPoolError(
				"Capacity pool state requires reconciliation before release",
				"uncertain",
			);
		const before = this.#state();
		const amount = BigInt(bytes);
		if (amount % BigInt(this.#blockSize) !== 0n || amount > this.#dataBytes) {
			throw new AuthorityCapacityPoolError(
				"Release amount must be block-aligned and no greater than verified pool data",
				"verified",
				before,
			);
		}
		if (amount === 0n) return { before, after: before, releasedDataBytes: 0 };
		const target = this.#dataBytes - amount;
		try {
			this.#verifyCurrentMetadata(this.#dataBytes);
			fs.ftruncateSync(this.#identity.fd, toNumber(target, "Truncated EOF"));
			durableFsyncSync(this.#identity.fd);
			const nativeIdentity = readNativeIdentity(this.#identity);
			if (
				BigInt(nativeIdentity.stat.size) !== target ||
				nativeIdentity.projectId !== this.#projectId ||
				nativeIdentity.blockSize !== this.#blockSize
			) {
				throw new Error("Shrink readback did not preserve inode identity, project, geometry, and exact EOF");
			}
			if (target > 0n) proveDenseCoverage(this.#identity, target - BigInt(this.#blockSize), target);
			this.#dataBytes = target;
			const after = this.#state();
			return { before, after, releasedDataBytes: toNumber(amount, "Released suffix") };
		} catch (cause) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Capacity truncate or synchronization may have partially changed the inode; reconcile before credit",
				"uncertain",
				undefined,
				cause,
			);
		}
	}

	/**
	 * Re-proves the pool from the inode itself: its verified EOF prefix becomes the pool. Blocks past EOF were never
	 * credited (an XFS mode-0 growth step can allocate part of its range and then fail, leaving them with an
	 * unchanged size); they are returned to the filesystem here instead of latching the pool as unprovable.
	 */
	reconcile(): CapacityPoolState {
		try {
			const nativeIdentity = readNativeIdentity(this.#identity);
			const size = BigInt(nativeIdentity.stat.size);
			if (
				nativeIdentity.projectId !== this.#projectId ||
				nativeIdentity.blockSize !== this.#blockSize ||
				size < 0n ||
				size > MAX_SAFE_BIGINT ||
				size % BigInt(this.#blockSize) !== 0n
			) {
				throw new Error("Reconciled inode identity, project, or geometry no longer matches the borrowed pool");
			}
			this.#trimPastEof(size);
			durableFsyncSync(this.#identity.fd);
			const syncedIdentity = readNativeIdentity(this.#identity);
			if (
				BigInt(syncedIdentity.stat.size) !== size ||
				syncedIdentity.projectId !== this.#projectId ||
				syncedIdentity.blockSize !== this.#blockSize
			) {
				throw new Error("Synchronized reconciliation metadata no longer matches the borrowed inode");
			}
			proveFullCoverage(this.#identity, size);
			this.#dataBytes = size;
			this.#uncertain = false;
			return this.#state();
		} catch (cause) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Native capacity coverage could not be reconciled",
				"uncertain",
				undefined,
				cause,
			);
		}
	}

	#trimPastEof(size: bigint): void {
		let end = size;
		for (const extent of fiemap(this.#identity, size, MAX_SAFE_BIGINT - size)) {
			const extentEnd = extent.logical + extent.length;
			if (extentEnd > end) end = extentEnd;
		}
		if (end === size) return;
		if (native().fallocate(this.#identity.fd, FALLOC_FL_KEEP_SIZE | FALLOC_FL_PUNCH_HOLE, size, end - size) !== 0)
			throw syscallError("fallocate(KEEP_SIZE|PUNCH_HOLE,past EOF)");
	}

	#assertRequest(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0)
			throw new AuthorityCapacityPoolError(
				"Capacity byte request must be a nonnegative safe integer",
				this.#uncertain ? "uncertain" : "verified",
			);
	}

	#verifyCurrentMetadata(expectedSize: bigint): void {
		const current = readNativeIdentity(this.#identity);
		if (
			BigInt(current.stat.size) !== expectedSize ||
			current.projectId !== this.#projectId ||
			current.blockSize !== this.#blockSize
		) {
			throw new Error("Capacity inode changed since its last verified state");
		}
	}

	#state(): CapacityPoolState {
		let nativeIdentity: NativeIdentity;
		try {
			nativeIdentity = readNativeIdentity(this.#identity);
		} catch (cause) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Capacity pool state could not be verified; reconcile before use",
				"uncertain",
				undefined,
				cause,
			);
		}
		if (
			nativeIdentity.projectId !== this.#projectId ||
			nativeIdentity.blockSize !== this.#blockSize ||
			BigInt(nativeIdentity.stat.size) !== this.#dataBytes
		) {
			this.#uncertain = true;
			throw new AuthorityCapacityPoolError(
				"Borrowed capacity inode no longer matches its verified state",
				"uncertain",
			);
		}
		return {
			dataBytes: toNumber(this.#dataBytes, "Pool data coverage"),
			allocatedBytes: toNumber(BigInt(nativeIdentity.stat.blocks) * 512n, "Physical allocation"),
			device: BigInt(nativeIdentity.stat.dev),
			inode: BigInt(nativeIdentity.stat.ino),
			projectId: nativeIdentity.projectId,
			blockSize: nativeIdentity.blockSize,
		};
	}
}
