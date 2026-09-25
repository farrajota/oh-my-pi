import * as fs from "node:fs";
import { hasFsCode, isEexist, isEnoent, logger, toError } from "@oh-my-pi/pi-utils";

/**
 * Publish a staged sibling file atomically, preserving an existing destination
 * across Windows `EPERM`/`EEXIST` replacement failures.
 */
export async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
	try {
		await fs.promises.rename(tempPath, targetPath);
		return;
	} catch (error) {
		if (!hasFsCode(error, "EPERM") && !isEexist(error)) throw error;
		await replaceAfterWindowsRenameFailure(tempPath, targetPath, error);
	}
}

async function replaceAfterWindowsRenameFailure(
	tempPath: string,
	targetPath: string,
	renameError: unknown,
): Promise<void> {
	const backupPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.bak`;
	try {
		await fs.promises.rename(targetPath, backupPath);
	} catch (error) {
		if (isEnoent(error)) {
			await fs.promises.rename(tempPath, targetPath);
			return;
		}
		throw renameError;
	}

	try {
		await fs.promises.rename(tempPath, targetPath);
	} catch (replaceError) {
		try {
			await fs.promises.rename(backupPath, targetPath);
		} catch (rollbackError) {
			throw new Error(
				`Failed to replace file after ${toError(renameError).message} (retry: ${
					toError(replaceError).message
				}; rollback: ${toError(rollbackError).message})`,
				{ cause: toError(renameError) },
			);
		}
		throw replaceError;
	}

	try {
		await fs.promises.rm(backupPath);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to remove atomic replacement backup", {
				path: targetPath,
				backupPath,
				error: toError(error).message,
			});
		}
	}
}

/**
 * Move a live file across devices without exposing a partial destination.
 * The source remains authoritative while the copy is staged. The caller may
 * update its owned identity only after a guarded rewrite of that source.
 * Publication, ownership verification, and source removal are synchronous;
 * an external process can still replace a path between the check and unlink.
 */
export async function moveFileAcrossDevices(
	source: string,
	destination: string,
	expectedSourceIdentity: { dev: number; ino: number },
	onPublished?: (identity: { dev: number; ino: number }) => void,
): Promise<void> {
	const staging = `${destination}.${process.pid}.${crypto.randomUUID()}.move`;
	try {
		for (;;) {
			const before = fs.lstatSync(source, { bigint: true });
			if (before.dev !== BigInt(expectedSourceIdentity.dev) || before.ino !== BigInt(expectedSourceIdentity.ino)) {
				throw new Error("Relocating session source identity changed");
			}
			await fs.promises.copyFile(source, staging);
			const after = fs.lstatSync(source, { bigint: true });
			if (after.dev !== BigInt(expectedSourceIdentity.dev) || after.ino !== BigInt(expectedSourceIdentity.ino)) {
				throw new Error("Relocating session source identity changed");
			}
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				before.mtimeNs !== after.mtimeNs
			) {
				continue;
			}
			// Flush the completed copy before making it discoverable. Neither the
			// temporary copy nor an existing destination is ever a live write target.
			const fd = fs.openSync(staging, "r+");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			const stagedIdentity = fs.lstatSync(staging, { bigint: true });
			fs.linkSync(staging, destination);
			try {
				const current = fs.lstatSync(source, { bigint: true });
				if (
					current.dev !== BigInt(expectedSourceIdentity.dev) ||
					current.ino !== BigInt(expectedSourceIdentity.ino)
				) {
					throw new Error("Relocating session source identity changed");
				}
				fs.unlinkSync(source);
			} catch (error) {
				try {
					const published = fs.lstatSync(destination, { bigint: true });
					if (published.dev === stagedIdentity.dev && published.ino === stagedIdentity.ino) {
						fs.unlinkSync(destination);
					}
				} catch (cleanupError) {
					if (!isEnoent(cleanupError)) {
						throw new AggregateError(
							[error, cleanupError],
							"Failed to remove source and rollback cross-device publication",
						);
					}
				}
				throw error;
			}
			onPublished?.({ dev: Number(stagedIdentity.dev), ino: Number(stagedIdentity.ino) });
			return;
		}
	} finally {
		await fs.promises.unlink(staging).catch(error => {
			if (!isEnoent(error))
				logger.warn("Failed to remove staged move copy", { staging, error: toError(error).message });
		});
	}
}
