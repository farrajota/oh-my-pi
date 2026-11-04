import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as directorySync from "../../src/registry/authority/directory-sync";
import { detectFullFsyncFallback, durableFsync, durableFsyncSync } from "../../src/registry/authority/durable-sync";
import { formatAuthorityFullFsyncNotice } from "../../src/registry/authority";
import { configurePortableAuthoritySqlite } from "../../src/registry/authority/sqlite-driver";

/**
 * Durability parity on darwin: macOS fsync(2) does not flush the drive cache, so every authority sync issues
 * fcntl(F_FULLFSYNC) there and falls back to fsync (with a warning) only when the full flush fails. Linux keeps fsync.
 */

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function scratchFile(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-durable-sync-"));
	directories.push(directory);
	const file = path.join(directory, "data");
	await fs.writeFile(file, "payload", { mode: 0o600 });
	return file;
}

describe("authority durable sync", () => {
	it("issues F_FULLFSYNC on darwin instead of fsync", async () => {
		const file = await scratchFile();
		const fd = syncFs.openSync(file, "r+");
		const fsync = spyOn(syncFs, "fsyncSync");
		try {
			const flushed: number[] = [];
			durableFsyncSync(fd, "darwin", target => {
				flushed.push(target);
				return undefined;
			});
			expect(flushed).toEqual([fd]);
			expect(fsync).not.toHaveBeenCalled();
		} finally {
			fsync.mockRestore();
			syncFs.closeSync(fd);
		}
	});

	it("falls back to fsync with a logged warning when F_FULLFSYNC fails on darwin", async () => {
		const file = await scratchFile();
		const fd = syncFs.openSync(file, "r+");
		const fsync = spyOn(syncFs, "fsyncSync");
		const warn = spyOn(logger, "warn");
		try {
			durableFsyncSync(fd, "darwin", () => "fcntl(F_FULLFSYNC) failed with errno 45 (sync fallback test)");
			expect(fsync.mock.calls).toEqual([[fd]]);
			expect(
				warn.mock.calls.some(
					([, context]) =>
						(context as { reason?: string })?.reason ===
						"fcntl(F_FULLFSYNC) failed with errno 45 (sync fallback test)",
				),
			).toBe(true);
			// A throwing full flush is a failure too, not a skipped sync.
			durableFsyncSync(fd, "darwin", () => {
				throw new Error("libSystem missing (sync fallback test)");
			});
			expect(fsync.mock.calls).toEqual([[fd], [fd]]);
		} finally {
			fsync.mockRestore();
			warn.mockRestore();
			syncFs.closeSync(fd);
		}
	});

	it("detects, for a visible notice, a darwin session directory whose syncs fall back to fsync", async () => {
		const file = await scratchFile();
		const reason = "fcntl(F_FULLFSYNC) failed with errno 45 (notice probe test)";
		const fallback = detectFullFsyncFallback(file, "darwin", () => reason);
		expect(fallback).toEqual({ directory: path.dirname(file), reason });
		const notice = formatAuthorityFullFsyncNotice(fallback!);
		expect(notice).toContain(reason);
		expect(notice).toContain(path.dirname(file));
		expect(notice).not.toContain("\n");
		expect(detectFullFsyncFallback(file, "darwin", () => undefined)).toBeUndefined();
		expect(detectFullFsyncFallback(file, "linux", () => reason)).toBeUndefined();
	});

	it("probes a darwin directory once after a successful full flush, but keeps probing one that falls back", async () => {
		const file = await scratchFile();
		const other = await scratchFile();
		expect(path.dirname(other)).not.toBe(path.dirname(file));
		const succeeded = new Set<string>();
		let probes = 0;
		const works = () => {
			probes++;
			return undefined;
		};
		expect(detectFullFsyncFallback(file, "darwin", works, succeeded)).toBeUndefined();
		expect(detectFullFsyncFallback(file, "darwin", works, succeeded)).toBeUndefined();
		expect(probes).toBe(1);
		expect(detectFullFsyncFallback(other, "darwin", works, succeeded)).toBeUndefined();
		expect(probes).toBe(2);

		const failing = new Set<string>();
		let failedProbes = 0;
		const fails = () => {
			failedProbes++;
			return "fcntl(F_FULLFSYNC) failed with errno 45 (cache test)";
		};
		expect(detectFullFsyncFallback(file, "darwin", fails, failing)).toBeDefined();
		expect(detectFullFsyncFallback(file, "darwin", fails, failing)).toBeDefined();
		expect(failedProbes).toBe(2);
		expect(failing.size).toBe(0);
	});

	it("keeps plain fsync on Linux and never attempts a full flush", async () => {
		const file = await scratchFile();
		const fd = syncFs.openSync(file, "r+");
		const fsync = spyOn(syncFs, "fsyncSync");
		try {
			let attempted = false;
			durableFsyncSync(fd, "linux", () => {
				attempted = true;
				return undefined;
			});
			expect(attempted).toBe(false);
			expect(fsync.mock.calls).toEqual([[fd]]);
		} finally {
			fsync.mockRestore();
			syncFs.closeSync(fd);
		}
	});

	it("routes FileHandle syncs the same way: full flush on darwin, handle.sync on Linux", async () => {
		const file = await scratchFile();
		const handle = await fs.open(file, "r+");
		try {
			const sync = spyOn(handle, "sync");
			const flushed: number[] = [];
			await durableFsync(handle, "darwin", target => {
				flushed.push(target);
				return undefined;
			});
			expect(flushed).toEqual([handle.fd]);
			expect(sync).not.toHaveBeenCalled();
			await durableFsync(handle, "linux", () => {
				throw new Error("must not run on Linux");
			});
			expect(sync).toHaveBeenCalledTimes(1);
		} finally {
			await handle.close();
		}
	});

	it("routes directory fsync through the darwin full flush (here libSystem is absent, so it warns and fsyncs)", async () => {
		const directory = path.dirname(await scratchFile());
		const fsync = spyOn(syncFs, "fsyncSync");
		const warn = spyOn(logger, "warn");
		try {
			directorySync.fsyncDirectorySync(directory, "darwin");
			expect(fsync).toHaveBeenCalledTimes(1);
			if (process.platform !== "darwin")
				expect(
					warn.mock.calls.some(([, context]) =>
						String((context as { reason?: string })?.reason).includes("F_FULLFSYNC"),
					),
				).toBe(true);
		} finally {
			fsync.mockRestore();
			warn.mockRestore();
		}
	});
});

describe("portable SQLite durability settings", () => {
	function pragma(database: Database, name: string): number {
		return Object.values(database.query<Record<string, number>, []>(`PRAGMA ${name}`).get()!)[0]!;
	}

	it("turns on fullfsync and checkpoint_fullfsync on darwin", async () => {
		const database = new Database(path.join(path.dirname(await scratchFile()), "store.sqlite"), {
			create: true,
			readwrite: true,
			strict: true,
		});
		try {
			configurePortableAuthoritySqlite(database, false, "darwin");
			expect({
				fullfsync: pragma(database, "fullfsync"),
				checkpoint: pragma(database, "checkpoint_fullfsync"),
			}).toEqual({ fullfsync: 1, checkpoint: 1 });
		} finally {
			database.close();
		}
	});

	it("leaves SQLite's fsync settings unchanged on Linux", async () => {
		const database = new Database(path.join(path.dirname(await scratchFile()), "store.sqlite"), {
			create: true,
			readwrite: true,
			strict: true,
		});
		try {
			configurePortableAuthoritySqlite(database, false, "linux");
			expect({
				fullfsync: pragma(database, "fullfsync"),
				checkpoint: pragma(database, "checkpoint_fullfsync"),
			}).toEqual({ fullfsync: 0, checkpoint: 0 });
		} finally {
			database.close();
		}
	});
});
