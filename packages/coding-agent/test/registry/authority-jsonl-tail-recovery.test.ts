import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as syncFs from "node:fs";
import * as durableSync from "../../src/registry/authority/durable-sync";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import type { AuthorityDriverOptions, AuthorityIdentity } from "../../src/registry/authority/types";
import type { DurableOperationRecord } from "../../src/registry/durable-state";
import {
	type AuthorityTailRecovery,
	closeSessionAuthority,
	formatAuthorityTailRecoveryNotice,
	registryDurableStateForSession,
} from "../../src/registry/authority";
import { authorityPaths } from "../../src/registry/authority/ownership";
import { SessionManager } from "../../src/session/session-manager";

/**
 * Open-time recovery of the tail an interrupted, never-acknowledged JSONL append left. Only two crash shapes are cut:
 * zeros through EOF, or one newline-less frame-line fragment optionally followed by block-aligned zeros through EOF.
 * Anything else after the last complete line (a complete line after zeros, non-zero bytes after zeros, foreign text)
 * may be acknowledged history or foreign evidence, so the open refuses and leaves the file byte-for-byte unchanged.
 */

const BLOCK = 512;
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function operation(operationId: string): DurableOperationRecord {
	return {
		kind: "operation",
		at: 1,
		operationId,
		effectClass: "session",
		ownerId: "root-uuid",
		classOwnerId: "root-uuid",
		acquiredAt: 1,
		expiresAt: 1_000,
		phase: "intent",
	};
}

function options(file: string, create: boolean): AuthorityDriverOptions {
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "session-1",
		incarnation: "incarnation-1",
		format: 2,
	};
	return { path: file, identity, create };
}

/** A store named like a session's authority payload, holding `frames` acknowledged frames `req-0..`. */
async function committedStore(
	frames: number,
): Promise<{ directory: string; file: string; session: string; committed: Buffer }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-tail-"));
	directories.push(directory);
	const session = path.join(directory, "root.jsonl");
	const file = `${session}.authority.jsonl`;
	const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options(file, true)), "owner-token");
	engine.recover();
	for (let index = 0; index < frames; index++)
		engine.transition(operation(`op-${index}`), { requestId: `req-${index}` });
	engine.close();
	return { directory, file, session, committed: await fs.readFile(file) };
}

/** Start offsets of every line after the header. */
function frameLineStarts(bytes: Buffer): number[] {
	const starts: number[] = [];
	for (let offset = bytes.indexOf(0x0a) + 1; offset < bytes.byteLength; offset = bytes.indexOf(0x0a, offset) + 1)
		starts.push(offset);
	return starts;
}

function presentReceipts(file: string, frames: number): string[] {
	const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options(file, false)), "next-owner");
	try {
		const present: string[] = [];
		for (let index = 0; index < frames; index++)
			if (engine.resolveReceipt(`req-${index}`)) present.push(`req-${index}`);
		return present;
	} finally {
		engine.close();
	}
}

/** Whether the reopened store kept exactly `prefix` (the reopening owner may append its own frames after it) and no zeros. */
async function keptPrefix(file: string, prefix: Buffer): Promise<boolean> {
	const after = await fs.readFile(file);
	return (
		after.subarray(0, prefix.byteLength).equals(prefix) &&
		!after.includes(0) &&
		after.indexOf(0x0a, prefix.byteLength - 1) === prefix.byteLength - 1
	);
}

async function recoveryFiles(directory: string): Promise<string[]> {
	return (await fs.readdir(directory))
		.filter(name => name.includes("-recovered."))
		.map(name => path.join(directory, name));
}

async function sha256(bytes: Uint8Array): Promise<string> {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("JSONL unacknowledged-tail recovery", () => {
	it("cuts torn frame-line fragments and preserves the dropped bytes in a private recovery file", async () => {
		const { directory, file, committed } = await committedStore(3);
		for (const torn of [' {"version":2,"kind":"commit","revision"', '{"version":2,"kind":"commit","revi', '{"vers']) {
			await fs.writeFile(file, Buffer.concat([committed, Buffer.from(torn)]), { mode: 0o600 });
			expect(presentReceipts(file, 3)).toEqual(["req-0", "req-1", "req-2"]);
			expect(await keptPrefix(file, committed)).toBe(true);
			const [recovered, ...others] = await recoveryFiles(directory);
			expect(others).toEqual([]);
			const bytes = await fs.readFile(recovered!);
			expect(bytes.toString()).toBe(torn);
			// Named with the cut offset and the dropped bytes' sha256, and private like every authority file.
			expect(path.basename(recovered!)).toBe(
				`root.jsonl.authority-recovered.${committed.byteLength}.${await sha256(bytes)}.bin`,
			);
			expect((await fs.stat(recovered!)).mode & 0o777).toBe(0o600);
			await fs.rm(recovered!);
		}
	});

	it("cuts zeros through EOF (the size reached disk, the data did not)", async () => {
		const { directory, file, committed } = await committedStore(3);
		await fs.writeFile(file, Buffer.concat([committed, Buffer.alloc(3_000)]), { mode: 0o600 });
		expect(presentReceipts(file, 3)).toEqual(["req-0", "req-1", "req-2"]);
		expect(await keptPrefix(file, committed)).toBe(true);
		const [recovered] = await recoveryFiles(directory);
		expect((await fs.readFile(recovered!)).equals(Buffer.alloc(3_000))).toBe(true);
	});

	it("cuts a frame-line fragment followed by block-aligned zeros through EOF", async () => {
		const { file, committed } = await committedStore(3);
		const fragmentEnd = Math.ceil((committed.byteLength + 40) / BLOCK) * BLOCK;
		const fragment = Buffer.concat([
			Buffer.from('{"version":2,"kind":"commit",'),
			Buffer.alloc(fragmentEnd - committed.byteLength - 29, 0x61),
		]);
		await fs.writeFile(file, Buffer.concat([committed, fragment, Buffer.alloc(2 * BLOCK)]), { mode: 0o600 });
		expect(presentReceipts(file, 3)).toEqual(["req-0", "req-1", "req-2"]);
		expect(await keptPrefix(file, committed)).toBe(true);
	});

	it("cuts an acknowledged final frame whose last block reads as zeros, because its bytes equal a torn append", async () => {
		// Residual: a lost write of the final committed block is byte-identical to an unacknowledged torn append, so
		// it is cut. The recovery file keeps the exact dropped bytes for the operator.
		const { directory, file, committed } = await committedStore(12);
		const zeroFrom = Math.floor((committed.byteLength - 10) / BLOCK) * BLOCK;
		const lastLine = frameLineStarts(committed).at(-1)!;
		expect(zeroFrom).toBeGreaterThan(lastLine);
		const corrupt = Buffer.from(committed);
		corrupt.fill(0, zeroFrom);
		await fs.writeFile(file, corrupt, { mode: 0o600 });
		expect(presentReceipts(file, 11)).toEqual(Array.from({ length: 11 }, (_, index) => `req-${index}`));
		expect(await keptPrefix(file, committed.subarray(0, lastLine))).toBe(true);
		const [recovered] = await recoveryFiles(directory);
		expect((await fs.readFile(recovered!)).equals(corrupt.subarray(lastLine))).toBe(true);
		expect(path.basename(recovered!)).toContain(`.authority-recovered.${lastLine}.`);
	});

	describe("refuses, unchanged and without a recovery file", () => {
		async function expectRefused(directory: string, file: string, session: string, bytes: Buffer): Promise<void> {
			await fs.writeFile(file, bytes, { mode: 0o600 });
			let outcome: unknown = "opened";
			try {
				new JsonlAuthorityPersistence(options(file, false)).close();
			} catch (error) {
				outcome = error;
			}
			expect(outcome).toBeInstanceOf(Error);
			expect((outcome as Error).message).toContain(`session repair ${session}`);
			expect((await fs.readFile(file)).equals(bytes)).toBe(true);
			expect(await recoveryFiles(directory)).toEqual([]);
		}

		it("acknowledged frames after an aligned zero block (re-review probe A)", async () => {
			const { directory, file, session, committed } = await committedStore(12);
			const starts = frameLineStarts(committed);
			const zeroAt = Math.ceil((starts.at(-3)! + 2) / BLOCK) * BLOCK;
			expect(zeroAt + BLOCK).toBeLessThan(starts.at(-1)!);
			const corrupt = Buffer.from(committed);
			corrupt.fill(0, zeroAt, zeroAt + BLOCK);
			await expectRefused(directory, file, session, corrupt);
		});

		it("foreign newline-terminated text after an aligned zero run (probe C)", async () => {
			const { directory, file, session, committed } = await committedStore(3);
			const pad = Math.ceil(committed.byteLength / BLOCK) * BLOCK - committed.byteLength;
			await expectRefused(
				directory,
				file,
				session,
				Buffer.concat([
					committed,
					Buffer.alloc(pad + BLOCK),
					Buffer.from("FOREIGN EVIDENCE not a frame\nmore foreign\n"),
				]),
			);
		});

		it("a complete copy of the final acknowledged frame after a zero gap (probe D)", async () => {
			const { directory, file, session, committed } = await committedStore(3);
			const pad = Math.ceil(committed.byteLength / BLOCK) * BLOCK - committed.byteLength;
			await expectRefused(
				directory,
				file,
				session,
				Buffer.concat([committed, Buffer.alloc(pad), committed.subarray(frameLineStarts(committed).at(-1)!)]),
			);
		});

		it("an aligned zero block inside the final committed frame, followed by the rest of that frame", async () => {
			const { directory, file, session, committed } = await committedStore(12);
			const lastLine = frameLineStarts(committed).at(-1)!;
			const zeroAt = Math.ceil((lastLine + 1) / BLOCK) * BLOCK;
			expect(zeroAt + BLOCK).toBeLessThan(committed.byteLength - 1);
			const corrupt = Buffer.from(committed);
			corrupt.fill(0, zeroAt, zeroAt + BLOCK);
			await expectRefused(directory, file, session, corrupt);
		});

		it("complete group members persisted after an unwritten block (out-of-order writeback)", async () => {
			const { directory, file, session, committed } = await committedStore(1);
			const boundary = Math.ceil((committed.byteLength + 1) / BLOCK) * BLOCK;
			await expectRefused(
				directory,
				file,
				session,
				Buffer.concat([
					committed,
					Buffer.alloc(boundary - committed.byteLength),
					Buffer.from('ion":2,"kind":"commit"}\n {"version":2,"kind":"commit","revision":9}\n'),
				]),
			);
		});

		it("a newline-less fragment after a zero run", async () => {
			const { directory, file, session, committed } = await committedStore(1);
			await expectRefused(
				directory,
				file,
				session,
				Buffer.concat([committed, Buffer.alloc(BLOCK), Buffer.from('{"version":2,"kind":"commit","re')]),
			);
		});

		it("a fragment followed by zeros that start inside a block", async () => {
			const { directory, file, session, committed } = await committedStore(1);
			const fragment = Buffer.from('{"version":2,"kind":"commit","revision":');
			expect((committed.byteLength + fragment.byteLength) % BLOCK).not.toBe(0);
			await expectRefused(directory, file, session, Buffer.concat([committed, fragment, Buffer.alloc(BLOCK)]));
		});

		it("foreign tails, a misaligned single zero, a zero run inside a torn append, and an oversized fragment", async () => {
			const { directory, file, session, committed } = await committedStore(2);
			const lastLine = frameLineStarts(committed).at(-1)!;
			const corruptLast = Buffer.from(committed);
			corruptLast[lastLine + 40] = 0;
			for (const bytes of [
				Buffer.concat([committed, Buffer.from(" not an authority frame")]),
				Buffer.concat([committed, Buffer.from('{"other":1')]),
				corruptLast,
				Buffer.concat([committed, Buffer.from('{"version":2,"kind":"commit"\0\0abc')]),
				Buffer.concat([
					committed,
					Buffer.from('{"version":2,"kind":"commit",'),
					Buffer.alloc(65 * 1024 * 1024, 0x61),
				]),
			])
				await expectRefused(directory, file, session, bytes);
		});
	});
});

describe("a session open that cuts a torn tail", () => {
	it("reports the recovery file once, for a visible notice", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-tail-notice-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;
		const owningSessionId = manager.getSessionId();
		try {
			const created = await registryDurableStateForSession(sessionFile, {
				backend: "jsonl",
				owningSessionId,
				create: true,
			});
			await created.close();
			await manager.close();
			await fs.appendFile(authorityPaths(sessionFile).jsonl, '{"version":2,"kind":"commit","revi');

			const reported: AuthorityTailRecovery[] = [];
			const reopened = await registryDurableStateForSession(sessionFile, {
				owningSessionId,
				onTailRecovered: recovery => reported.push(recovery),
			});
			await reopened.close();
			const [recovery, ...others] = await recoveryFiles(directory);
			expect(others).toEqual([]);
			expect(reported).toEqual([{ sessionFile: await fs.realpath(sessionFile), recoveryFile: recovery! }]);
			const notice = formatAuthorityTailRecoveryNotice(reported[0]!);
			expect(notice).toContain(recovery!);
			expect(notice).not.toContain("\n");

			// A later clean open cuts nothing and reports nothing, though the recovery file is still there.
			const again: AuthorityTailRecovery[] = [];
			const clean = await registryDurableStateForSession(sessionFile, {
				owningSessionId,
				onTailRecovered: recovery => again.push(recovery),
			});
			await clean.close();
			expect(again).toEqual([]);
		} finally {
			await closeSessionAuthority(sessionFile);
		}
	});
});

describe("a recovery file an earlier, interrupted open already wrote", () => {
	/** The state open #1 leaves when it is killed after writing the recovery file but before truncating. */
	async function interruptedCut(
		mode = 0o600,
	): Promise<{ directory: string; file: string; session: string; committed: Buffer; recovery: string }> {
		const store = await committedStore(1);
		const fragment = Buffer.from('{"version":2,"kind":"commit","revi');
		await fs.appendFile(store.file, fragment);
		const recovery = `${store.file.slice(0, -".jsonl".length)}-recovered.${store.committed.byteLength}.${await sha256(fragment)}.bin`;
		await fs.writeFile(recovery, fragment, { mode });
		await fs.chmod(recovery, mode);
		return { ...store, recovery };
	}

	it("is synced with its directory before the cut, and the open reports it", async () => {
		const { directory, file, committed, recovery } = await interruptedCut();
		const synced: string[] = [];
		const spy = spyOn(durableSync, "durableFsyncSync").mockImplementation((fd: number) => {
			const stat = syncFs.fstatSync(fd);
			synced.push(`${stat.dev}:${stat.ino}`);
		});
		let driver: JsonlAuthorityPersistence;
		try {
			driver = new JsonlAuthorityPersistence(options(file, false));
		} finally {
			spy.mockRestore();
		}
		try {
			expect(driver.recoveredTail).toBe(recovery);
		} finally {
			driver.close();
		}
		const recoveryStat = await fs.stat(recovery);
		const directoryStat = await fs.stat(directory);
		expect(synced).toContain(`${recoveryStat.dev}:${recoveryStat.ino}`);
		expect(synced).toContain(`${directoryStat.dev}:${directoryStat.ino}`);
		expect((await fs.readFile(file)).equals(committed)).toBe(true);
		expect(await recoveryFiles(directory)).toEqual([recovery]);
	});

	it("is refused, and nothing is cut, when it is not a private regular file", async () => {
		const { file, committed, recovery } = await interruptedCut(0o644);
		const before = await fs.readFile(file);
		expect(() => new JsonlAuthorityPersistence(options(file, false))).toThrow(/recovery file/);
		expect((await fs.readFile(file)).equals(before)).toBe(true);
		expect(before.byteLength).toBeGreaterThan(committed.byteLength);
		expect((await fs.stat(recovery)).mode & 0o777).toBe(0o644);
	});

	it("is reported by the session open that completes the cut", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-tail-rerun-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;
		const owningSessionId = manager.getSessionId();
		try {
			const created = await registryDurableStateForSession(sessionFile, {
				backend: "jsonl",
				owningSessionId,
				create: true,
			});
			await created.close();
			await manager.close();
			const payload = authorityPaths(sessionFile).jsonl;
			const prefix = await fs.readFile(payload);
			const cut = prefix.byteLength;
			const fragment = Buffer.from('{"version":2,"kind":"commit","revi');
			await fs.appendFile(payload, fragment);
			const recovery = `${await fs.realpath(sessionFile)}.authority-recovered.${cut}.${await sha256(fragment)}.bin`;
			await fs.writeFile(recovery, fragment, { mode: 0o600 });

			const reported: AuthorityTailRecovery[] = [];
			const reopened = await registryDurableStateForSession(sessionFile, {
				owningSessionId,
				onTailRecovered: recovery => reported.push(recovery),
			});
			await reopened.close();
			expect(reported).toEqual([{ sessionFile: await fs.realpath(sessionFile), recoveryFile: recovery }]);
			// The reopening owner appends its own frames after the kept prefix; the fragment is gone.
			expect(await keptPrefix(payload, prefix)).toBe(true);
		} finally {
			await closeSessionAuthority(sessionFile);
		}
	});
});
