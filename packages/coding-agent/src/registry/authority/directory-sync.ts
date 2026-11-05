import * as fs from "node:fs";
import { durableFsync, durableFsyncSync } from "./durable-sync";

/**
 * Whether the authority fsyncs a directory to make a new, renamed or removed entry durable. POSIX needs it: a
 * file fsync does not cover the directory entry naming the file (ext4 and XFS happen to commit both, which POSIX
 * does not guarantee). Windows cannot open a directory through Node (EISDIR) and NTFS journals directory entries
 * itself, so there the call is skipped instead of failing every authority write.
 */
export function directoryFsyncSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

/** Synchronous directory fsync for driver code that runs inside the worker's synchronous command path. */
export function fsyncDirectorySync(directory: string, platform: NodeJS.Platform = process.platform): void {
	if (!directoryFsyncSupported(platform)) return;
	const handle = fs.openSync(directory, fs.constants.O_RDONLY);
	try {
		durableFsyncSync(handle, platform);
	} finally {
		fs.closeSync(handle);
	}
}

export async function fsyncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
	if (!directoryFsyncSupported(platform)) return;
	const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
	try {
		await durableFsync(handle, platform);
	} finally {
		await handle.close();
	}
}
