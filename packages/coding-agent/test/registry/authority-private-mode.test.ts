import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readAuthorityDescriptor, writeAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { authorityPaths } from "../../src/registry/authority/ownership";
import { hasPrivateMode } from "../../src/registry/authority/private-mode";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("authority private mode check", () => {
	it("accepts Windows modes such as 0o666, where POSIX bits do not represent access", () => {
		expect(hasPrivateMode(0o100666, "win32")).toBe(true);
		expect(hasPrivateMode(0o100666n, "win32")).toBe(true);
	});

	it("refuses group and other bits on Linux and macOS", () => {
		for (const platform of ["linux", "darwin"] as const) {
			for (const mode of [0o100644, 0o100640, 0o100604, 0o100666, 0o040755]) {
				expect(hasPrivateMode(mode, platform)).toBe(false);
				expect(hasPrivateMode(BigInt(mode), platform)).toBe(false);
			}
			expect(hasPrivateMode(0o100600, platform)).toBe(true);
			expect(hasPrivateMode(0o040700n, platform)).toBe(true);
		}
	});

	it.skipIf(process.platform === "win32")("refuses a group-readable descriptor on POSIX hosts", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-private-mode-"));
		directories.push(directory);
		const session = path.join(directory, "root.jsonl");
		await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n');
		const paths = authorityPaths(session);
		await fs.writeFile(paths.lock, "", { mode: 0o600 });
		const lockStat = await fs.stat(paths.lock);
		const descriptor = {
			version: 1 as const,
			revision: 1,
			owningSessionId: "root-uuid",
			backend: "jsonl" as const,
			format: 2 as const,
			incarnation: "private-mode-incarnation",
			payload: path.basename(paths.jsonl),
			state: "initializing" as const,
			physicalIdentity: { dev: String(lockStat.dev), ino: String(lockStat.ino) },
		};
		await writeAuthorityDescriptor(session, descriptor);
		expect(await readAuthorityDescriptor(session)).toEqual(descriptor);
		await fs.chmod(paths.descriptor, 0o644);
		await expect(readAuthorityDescriptor(session)).rejects.toThrow(/private regular file/);
	});
});
