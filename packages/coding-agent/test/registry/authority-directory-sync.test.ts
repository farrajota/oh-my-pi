import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as directorySync from "../../src/registry/authority/directory-sync";
import { SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function makeDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-directory-sync-"));
	directories.push(directory);
	return directory;
}

describe("authority directory fsync", () => {
	it("opens and fsyncs the directory on POSIX hosts, so a missing directory fails loudly", async () => {
		const directory = await makeDirectory();
		expect(() => directorySync.fsyncDirectorySync(directory, "linux")).not.toThrow();
		expect(() => directorySync.fsyncDirectorySync(path.join(directory, "missing"), "linux")).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
		await expect(directorySync.fsyncDirectory(path.join(directory, "missing"), "darwin")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("never opens a directory on Windows, where Node cannot open one and NTFS journals entries itself", async () => {
		const missing = path.join(await makeDirectory(), "missing");
		const open = spyOn(syncFs, "openSync");
		const openAsync = spyOn(syncFs.promises, "open");
		try {
			directorySync.fsyncDirectorySync(missing, "win32");
			await directorySync.fsyncDirectory(missing, "win32");
			expect(open).not.toHaveBeenCalled();
			expect(openAsync).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			openAsync.mockRestore();
		}
	});

	it("makes the SQLite -wal directory entry durable once the store has created it", async () => {
		const directory = await makeDirectory();
		const databasePath = path.join(directory, "authority.sqlite");
		const synced: { directory: string; walExists: boolean }[] = [];
		const original = directorySync.fsyncDirectorySync;
		const sync = spyOn(directorySync, "fsyncDirectorySync").mockImplementation(
			(target: string, platform?: NodeJS.Platform) => {
				synced.push({ directory: target, walExists: syncFs.existsSync(`${databasePath}-wal`) });
				original(target, platform);
			},
		);
		try {
			for (const create of [true, false]) {
				const persistence = new SqliteAuthorityPersistence({
					path: databasePath,
					identity: { backend: "sqlite", owningSessionId: "session-1", incarnation: "incarnation-1", format: 2 },
					create,
				});
				persistence.close();
			}
		} finally {
			sync.mockRestore();
		}
		// Both the creating and the reopening connection create -wal and sync its parent directory afterwards.
		expect(synced.filter(entry => entry.directory === directory && entry.walExists)).toHaveLength(2);
	});
});
