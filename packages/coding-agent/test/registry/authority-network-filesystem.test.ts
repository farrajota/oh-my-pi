import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	closeSessionAuthority,
	formatAuthorityWeakLockNotice,
	registryDurableStateForSession,
} from "../../src/registry/authority";
import type { AuthorityWeakLockFilesystem } from "../../src/registry/authority";
import * as ownership from "../../src/registry/authority/ownership";
import { authorityLockKey, detectWeakLockFilesystem } from "../../src/registry/authority/ownership";
import { SessionManager } from "../../src/session/session-manager";

/**
 * With capacity off, exclusion is flock (or a Windows named object keyed by the file id). Network filesystems emulate
 * or weaken flock across hosts, so an open there is not refused but surfaces a one-time notice that cross-host
 * exclusion is not guaranteed.
 */

const directories: string[] = [];
const sessions: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await closeSessionAuthority(session);
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("weak-lock filesystem detection", () => {
	it("recognizes Linux network filesystems by statfs magic and accepts local ones", async () => {
		const linux = (type: number) =>
			detectWeakLockFilesystem("/sessions/root.jsonl", { platform: "linux", statfsType: async () => type });
		const detected: Record<string, string | undefined> = {};
		for (const [label, type] of Object.entries({
			nfs: 0x6969,
			smb: 0x517b,
			cifs: 0xff534d42,
			smb2: 0xfe534d42,
			"9p": 0x01021997,
			ext4: 0xef53,
			xfs: 0x58465342,
			overlay: 0x794c7630,
			tmpfs: 0x01021994,
		}))
			detected[label] = (await linux(type))?.filesystem;
		expect(detected).toEqual({
			nfs: "nfs",
			smb: "smb",
			cifs: "cifs",
			smb2: "smb2",
			"9p": "9p",
			ext4: undefined,
			xfs: undefined,
			overlay: undefined,
			tmpfs: undefined,
		});
	});

	it("recognizes macOS network filesystems by f_fstypename", async () => {
		const detected: Record<string, string | undefined> = {};
		for (const name of ["nfs", "smbfs", "afpfs", "apfs", "hfs"])
			detected[name] = (
				await detectWeakLockFilesystem("/Users/me/root.jsonl", {
					platform: "darwin",
					darwinFilesystemName: () => name,
				})
			)?.filesystem;
		expect(detected).toEqual({ nfs: "nfs", smbfs: "smbfs", afpfs: "afpfs", apfs: undefined, hfs: undefined });
	});

	it("recognizes Windows UNC session paths, including the extended form, and accepts drive paths", async () => {
		const windows = (session: string) => detectWeakLockFilesystem(session, { platform: "win32" });
		expect((await windows("\\\\server\\share\\sessions\\root.jsonl"))?.filesystem).toBe("unc");
		expect((await windows("\\\\?\\UNC\\server\\share\\root.jsonl"))?.filesystem).toBe("unc");
		expect(await windows("C:\\Users\\me\\root.jsonl")).toBeUndefined();
		expect(await windows("\\\\?\\C:\\Users\\me\\root.jsonl")).toBeUndefined();
	});
});

describe("weak-lock filesystem notice", () => {
	async function freshRoot(): Promise<{ session: string; owningSessionId: string }> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-netfs-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		managers.push(manager);
		const session = manager.getSessionFile()!;
		await manager.ensureOnDisk();
		sessions.push(session);
		return { session, owningSessionId: manager.getSessionId() };
	}

	it("opens with capacity off on a network filesystem and reports it once per process, never refusing", async () => {
		const { session, owningSessionId } = await freshRoot();
		const detect = spyOn(ownership, "detectWeakLockFilesystem").mockImplementation(async file => ({
			directory: path.dirname(file),
			filesystem: "nfs",
		}));
		const notices: AuthorityWeakLockFilesystem[] = [];
		try {
			const store = await registryDurableStateForSession(session, {
				owningSessionId,
				create: true,
				capacity: "off",
				onWeakLockFilesystem: notice => notices.push(notice),
			});
			expect(store.identity.backend).toBeDefined();
			await closeSessionAuthority(session);
			await registryDurableStateForSession(session, {
				owningSessionId,
				capacity: "off",
				onWeakLockFilesystem: notice => notices.push(notice),
			});
			await closeSessionAuthority(session);
		} finally {
			detect.mockRestore();
		}
		expect(notices).toHaveLength(1);
		expect(notices[0]!.filesystem).toBe("nfs");
		const line = formatAuthorityWeakLockNotice(notices[0]!);
		expect(line).toContain("nfs");
		expect(line).toContain("cross-host exclusion is not guaranteed");
		expect(line.includes("\n")).toBe(false);
	});
});

describe("Windows lock keys", () => {
	it("keeps file ids that collide as doubles distinct, so neighbours never read as already held", () => {
		const volume = 0xdeadbeefn;
		const first = 2n ** 53n;
		expect(Number(first)).toBe(Number(first + 1n));
		expect(authorityLockKey("transcript", volume, first)).not.toBe(
			authorityLockKey("transcript", volume, first + 1n),
		);
		expect(authorityLockKey("transcript", volume, first)).toBe(authorityLockKey("transcript", volume, first));
		expect(authorityLockKey("transcript", volume, first)).not.toBe(authorityLockKey("anchor", volume, first));
		expect(authorityLockKey("transcript", volume, first)).not.toBe(
			authorityLockKey("transcript", volume + 1n, first),
		);
	});
});
