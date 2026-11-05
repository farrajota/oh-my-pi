import { dlopen, FFIType, read } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { logger } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The one way authority code makes file (and directory) contents durable.
 *
 * On Linux and Windows `fsync(2)` / `FlushFileBuffers` flush through the device write cache, so the authority's
 * acknowledgement-after-sync contract holds. On macOS `fsync(2)` only hands the data to the drive, which may keep it
 * in a volatile cache across a power loss; Apple documents `fcntl(F_FULLFSYNC)` as the call that flushes the drive.
 * So on darwin every authority sync issues F_FULLFSYNC first and falls back to `fsync(2)` with a logged warning
 * only when the full flush itself fails (for example on a filesystem that does not implement it).
 */

/** `F_FULLFSYNC` from `<sys/fcntl.h>` on darwin. */
export const F_FULLFSYNC = 51;

/** Issues a full device flush of `fd`; returns undefined on success or the failure reason. Injected by tests. */
export type FullFsync = (fd: number) => string | undefined;

let darwinFullFsync: FullFsync | undefined;

function loadDarwinFullFsync(): FullFsync {
	let fcntl: (fd: number, command: number) => number;
	let errnoLocation: () => Pointer | null;
	try {
		const library = dlopen("/usr/lib/libSystem.B.dylib", {
			// fcntl is variadic; F_FULLFSYNC takes no third argument, so the two fixed arguments are the whole call.
			fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			__error: { args: [], returns: FFIType.ptr },
		});
		fcntl = (fd, command) => library.symbols.fcntl(fd, command);
		errnoLocation = () => library.symbols.__error() as Pointer | null;
	} catch (error) {
		const reason = `libSystem could not be loaded for F_FULLFSYNC: ${error instanceof Error ? error.message : String(error)}`;
		return () => reason;
	}
	return fd => {
		if (fcntl(fd, F_FULLFSYNC) !== -1) return undefined;
		const errno = errnoLocation();
		return `fcntl(F_FULLFSYNC) failed with errno ${errno ? read.i32(errno, 0) : "unknown"}`;
	};
}

function defaultFullFsync(fd: number): string | undefined {
	darwinFullFsync ??= loadDarwinFullFsync();
	return darwinFullFsync(fd);
}

/** Whether `platform` needs F_FULLFSYNC for an fsync to reach stable storage. */
export function fullFsyncRequired(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin";
}

const reportedFallbacks = new Set<string>();

/** Runs the full flush; returns undefined on success or the failure reason (a throw is a failure too). */
function attemptFullFsync(fd: number, fullFsync: FullFsync): string | undefined {
	try {
		return fullFsync(fd);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Runs the darwin full flush; returns whether the caller still has to fsync (the full flush failed). */
function fullFsyncOrFallback(fd: number, fullFsync: FullFsync): boolean {
	const reason = attemptFullFsync(fd, fullFsync);
	if (reason === undefined) return false;
	// Once per distinct reason: a filesystem without F_FULLFSYNC fails it on every commit.
	if (!reportedFallbacks.has(reason)) {
		reportedFallbacks.add(reason);
		logger.warn(
			"Authority could not issue F_FULLFSYNC and fell back to fsync, which may leave acknowledged data in the drive cache across a power loss",
			{ reason },
		);
	}
	return true;
}

/** Synchronous durable sync of an open descriptor (file or directory). */
export function durableFsyncSync(
	fd: number,
	platform: NodeJS.Platform = process.platform,
	fullFsync: FullFsync = defaultFullFsync,
): void {
	if (fullFsyncRequired(platform) && !fullFsyncOrFallback(fd, fullFsync)) return;
	fs.fsyncSync(fd);
}

/**
 * Durable sync of an open FileHandle. On darwin the full flush runs synchronously on the calling thread; the async
 * callers (descriptor, ownership, lifecycle and migration steps) are rare control-plane writes, not the commit path.
 */
export async function durableFsync(
	handle: fs.promises.FileHandle,
	platform: NodeJS.Platform = process.platform,
	fullFsync: FullFsync = defaultFullFsync,
): Promise<void> {
	if (fullFsyncRequired(platform) && !fullFsyncOrFallback(handle.fd, fullFsync)) return;
	await handle.sync();
}

export interface AuthorityFullFsyncFallback {
	readonly directory: string;
	readonly reason: string;
}

/** Directories whose F_FULLFSYNC probe succeeded in this process; each probe is a synchronous whole-drive flush. */
const fullFsyncProbeSucceeded = new Set<string>();

/**
 * Probes F_FULLFSYNC on `sessionFile` for a user-visible notice. Most authority syncs run in the store's worker,
 * whose fallback is only logged; a filesystem without the full flush fails it for every file, so one probe on the
 * transcript tells whether this session's syncs fall back. Undefined off darwin or when the full flush works. A
 * success is remembered per directory in `succeeded`, so later opens there skip the flush; a failure is not, and the
 * caller deduplicates its notice.
 */
export function detectFullFsyncFallback(
	sessionFile: string,
	platform: NodeJS.Platform = process.platform,
	fullFsync: FullFsync = defaultFullFsync,
	succeeded: Set<string> = fullFsyncProbeSucceeded,
): AuthorityFullFsyncFallback | undefined {
	if (!fullFsyncRequired(platform)) return undefined;
	const directory = path.dirname(sessionFile);
	if (succeeded.has(directory)) return undefined;
	const fd = fs.openSync(sessionFile, fs.constants.O_RDONLY);
	let reason: string | undefined;
	try {
		reason = attemptFullFsync(fd, fullFsync);
	} finally {
		fs.closeSync(fd);
	}
	if (reason === undefined) {
		succeeded.add(directory);
		return undefined;
	}
	return { directory, reason };
}
