import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthorityCapacityUnsupportedError,
	closeSessionAuthority,
	parseJournalingCapacity,
	registryDurableStateForSession,
	type JournalingCapacity,
} from "../../src/registry/authority";
import * as capacityFile from "../../src/registry/authority/capacity";
import { AUTHORITY_DIRECT_WORKER_ARG } from "../../src/registry/authority/client";
import { authorityPaths } from "../../src/registry/authority/ownership";
import * as threadLifetime from "../../src/registry/authority/thread-lifetime";
import type { JournalingBackend } from "../../src/registry/authority/types";
import type { DurableOperationRecord } from "../../src/registry/durable-state";
import { SessionManager } from "../../src/session/session-manager";

const XFS_MAGIC = 0x58465342;
const backends: readonly JournalingBackend[] = ["jsonl", "sqlite"];
const directories: string[] = [];
const sessions: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await closeSessionAuthority(session);
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function filesystemType(directory: string): Promise<number> {
	return (await fs.statfs(directory)).type;
}

async function temporaryDirectory(parent: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(parent, ".omp-capacity-optin-"));
	directories.push(directory);
	return directory;
}

/**
 * Real non-XFS parents in this environment: tmpfs (/dev/shm) and the container overlay holding the
 * account's real home (not the test runner's private HOME, which sits on XFS). Each is kept only when it
 * is writable and genuinely not XFS, so the default path is proven on a filesystem capacity cannot fund.
 */
async function nonXfsParents(): Promise<Array<{ readonly label: string; readonly parent: string }>> {
	const candidates = [
		{ label: "tmpfs", parent: "/dev/shm" },
		{ label: "home overlay", parent: os.userInfo().homedir },
	];
	const usable: Array<{ readonly label: string; readonly parent: string }> = [];
	for (const candidate of candidates) {
		try {
			await fs.access(candidate.parent, fs.constants.W_OK);
			if ((await filesystemType(candidate.parent)) !== XFS_MAGIC) usable.push(candidate);
		} catch {
			// Absent or read-only candidates are not part of this host's non-XFS evidence.
		}
	}
	return usable;
}

async function freshRoot(
	parent: string,
): Promise<{ readonly session: string; readonly owningSessionId: string; readonly directory: string }> {
	const directory = await temporaryDirectory(parent);
	const manager = SessionManager.create(directory, directory);
	managers.push(manager);
	const session = manager.getSessionFile();
	if (!session) throw new Error("Expected a persistent SessionManager root");
	await manager.ensureOnDisk();
	sessions.push(session);
	return { session, owningSessionId: manager.getSessionId(), directory };
}

function operationRecord(
	ownerId: string,
	operationId: string,
	at = 1,
	phase: DurableOperationRecord["phase"] = "intent",
): DurableOperationRecord {
	return {
		kind: "operation",
		at,
		operationId,
		effectClass: "session",
		ownerId,
		classOwnerId: ownerId,
		acquiredAt: 1,
		expiresAt: 1_000,
		phase,
	};
}

async function writeAndClose(
	session: string,
	options: { owningSessionId: string; create?: boolean; backend?: JournalingBackend; capacity?: JournalingCapacity },
	operationId: string,
): Promise<DurableOperationRecord> {
	const store = await registryDurableStateForSession(session, options);
	// Startup recovers the owner before any write, exactly as AgentRegistry.create does.
	const recovery = await store.recover();
	expect(recovery.owner.phase).toBe("ready");
	expect(recovery.blocked).toEqual([]);
	// A completed operation leaves nothing unresolved, so the next owner recovers straight to ready.
	await store.transition(operationRecord(options.owningSessionId, operationId, 1, "intent"));
	await store.transition(operationRecord(options.owningSessionId, operationId, 2, "effect"));
	const record = operationRecord(options.owningSessionId, operationId, 3, "completed");
	await store.transition(record);
	await closeSessionAuthority(session);
	return record;
}

async function expectRecord(
	session: string,
	owningSessionId: string,
	capacity: JournalingCapacity | undefined,
	records: readonly DurableOperationRecord[],
	backend: JournalingBackend,
): Promise<void> {
	const store = await registryDurableStateForSession(session, { owningSessionId, ...(capacity ? { capacity } : {}) });
	expect(store.identity.backend).toBe(backend);
	for (const record of records)
		expect(await store.getOperation(record.ownerId, record.effectClass, record.operationId)).toEqual({
			record,
			version: 3,
		});
	await closeSessionAuthority(session);
}

describe("OMP_JOURNALING_CAPACITY parsing", () => {
	it("defaults to off when unset and accepts only exact lowercase off or xfs", () => {
		expect(parseJournalingCapacity(undefined)).toBe("off");
		expect(parseJournalingCapacity("off")).toBe("off");
		expect(parseJournalingCapacity("xfs")).toBe("xfs");
	});

	it("rejects empty, padded, uppercase and unknown values with one actionable line", () => {
		for (const invalid of [
			"",
			" ",
			"OFF",
			"Off",
			"XFS",
			" xfs",
			"xfs ",
			"xfs\n",
			"\toff",
			"on",
			"true",
			"1",
			"ext4",
		]) {
			let failure: unknown;
			try {
				parseJournalingCapacity(invalid);
			} catch (error) {
				failure = error;
			}
			expect(failure, JSON.stringify(invalid)).toBeInstanceOf(Error);
			const message = (failure as Error).message;
			expect(message).toContain(`OMP_JOURNALING_CAPACITY value ${JSON.stringify(invalid)}`);
			expect(message).toContain('expected exactly "off" or "xfs"');
			expect(message.includes("\n")).toBe(false);
		}
	});

	it("parses once per process and keeps the bootstrap choice when the environment later changes", async () => {
		const module = path.resolve(import.meta.dir, "../../src/registry/authority/journaling-env.ts");
		const script = `
			const { journalingEnvironment } = await import(${JSON.stringify(module)});
			process.env.OMP_JOURNALING_CAPACITY = "Xfs";
			let invalidRejected = false;
			try { journalingEnvironment(); } catch (error) { invalidRejected = /OMP_JOURNALING_CAPACITY/.test(error.message); }
			process.env.OMP_JOURNALING_CAPACITY = "xfs";
			const parsed = journalingEnvironment().capacity;
			process.env.OMP_JOURNALING_CAPACITY = "off";
			const cached = journalingEnvironment().capacity;
			console.log(JSON.stringify({ invalidRejected, parsed, cached }));
		`;
		const env: Record<string, string | undefined> = { ...process.env };
		delete env.OMP_JOURNALING_CAPACITY;
		delete env.OMP_JOURNALING_BACKEND;
		const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ invalidRejected: true, parsed: "xfs", cached: "xfs" });
	});
});

describe("default capacity off on non-XFS filesystems", () => {
	it("finds at least one real non-XFS filesystem to prove the default path on", async () => {
		expect((await nonXfsParents()).length).toBeGreaterThan(0);
	});

	for (const backend of backends) {
		it(`starts, writes and resumes a ${backend} root without a capacity file on every non-XFS filesystem`, async () => {
			expect(process.env.OMP_JOURNALING_CAPACITY).toBeUndefined();
			const capacitySpy = spyOn(capacityFile, "openAuthorityCapacityFile");
			try {
				for (const { label, parent } of await nonXfsParents()) {
					const root = await freshRoot(parent);
					expect(await filesystemType(root.directory), label).not.toBe(XFS_MAGIC);
					const first = await writeAndClose(
						root.session,
						{ owningSessionId: root.owningSessionId, create: true, backend },
						`${label}-first`,
					);
					const second = await writeAndClose(
						root.session,
						{ owningSessionId: root.owningSessionId },
						`${label}-second`,
					);
					await expectRecord(root.session, root.owningSessionId, undefined, [first, second], backend);
				}
				expect(capacitySpy).not.toHaveBeenCalled();
			} finally {
				capacitySpy.mockRestore();
			}
		}, 60_000);
	}

	it("keeps the live SQLite owner exclusive without capacity, so no second connection can read the store", async () => {
		const [{ parent }] = await nonXfsParents();
		const root = await freshRoot(parent);
		const store = await registryDurableStateForSession(root.session, {
			owningSessionId: root.owningSessionId,
			create: true,
			backend: "sqlite",
		});
		await store.recover();
		await store.transition(operationRecord(root.owningSessionId, "exclusive"));
		const foreign = new Database(authorityPaths(root.session).sqlite, { readonly: true });
		try {
			expect(() => foreign.query("SELECT count(*) FROM sqlite_master").get()).toThrow(/locked|busy/i);
		} finally {
			foreign.close();
		}
		await closeSessionAuthority(root.session);
	}, 60_000);
});

describe("explicit OMP_JOURNALING_CAPACITY=xfs", () => {
	it("refuses a non-XFS session directory with one line before writing any authority artifact", async () => {
		const [{ parent }] = await nonXfsParents();
		const root = await freshRoot(parent);
		const before = (await fs.readdir(root.directory)).sort();
		let failure: unknown;
		try {
			await registryDurableStateForSession(root.session, {
				owningSessionId: root.owningSessionId,
				create: true,
				capacity: "xfs",
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AuthorityCapacityUnsupportedError);
		const message = (failure as Error).message;
		expect(message).toContain("OMP_JOURNALING_CAPACITY=xfs requires the session directory on XFS");
		expect(message).toContain('set it to "off"');
		expect(message.includes("\n")).toBe(false);
		expect((await fs.readdir(root.directory)).sort()).toEqual(before);
		await closeSessionAuthority(root.session);
		// Nothing was consumed: the same fresh root still starts once capacity is off.
		const record = await writeAndClose(
			root.session,
			{ owningSessionId: root.owningSessionId, create: true, capacity: "off" },
			"after-refusal",
		);
		await expectRecord(root.session, root.owningSessionId, "off", [record], "jsonl");
	}, 60_000);

	for (const backend of backends) {
		it(`funds a ${backend} root from the anonymous capacity file on XFS`, async () => {
			expect(await filesystemType(os.tmpdir())).toBe(XFS_MAGIC);
			const capacitySpy = spyOn(capacityFile, "openAuthorityCapacityFile");
			try {
				const root = await freshRoot(os.tmpdir());
				const record = await writeAndClose(
					root.session,
					{ owningSessionId: root.owningSessionId, create: true, backend, capacity: "xfs" },
					"xfs-funded",
				);
				expect(capacitySpy).toHaveBeenCalledTimes(1);
				await expectRecord(root.session, root.owningSessionId, "xfs", [record], backend);
				expect(capacitySpy).toHaveBeenCalledTimes(2);
			} finally {
				capacitySpy.mockRestore();
			}
		}, 60_000);
	}
});

describe("capacity is a runtime policy, not a store format", () => {
	for (const backend of backends) {
		it(`reopens a ${backend} root created under xfs with off, and one created under off with xfs`, async () => {
			expect(await filesystemType(os.tmpdir())).toBe(XFS_MAGIC);
			const fundedFirst = await freshRoot(os.tmpdir());
			const funded = await writeAndClose(
				fundedFirst.session,
				{ owningSessionId: fundedFirst.owningSessionId, create: true, backend, capacity: "xfs" },
				"created-xfs",
			);
			const unfunded = await writeAndClose(
				fundedFirst.session,
				{ owningSessionId: fundedFirst.owningSessionId, capacity: "off" },
				"appended-off",
			);
			await expectRecord(fundedFirst.session, fundedFirst.owningSessionId, "xfs", [funded, unfunded], backend);

			const plainFirst = await freshRoot(os.tmpdir());
			const plain = await writeAndClose(
				plainFirst.session,
				{ owningSessionId: plainFirst.owningSessionId, create: true, backend, capacity: "off" },
				"created-off",
			);
			const later = await writeAndClose(
				plainFirst.session,
				{ owningSessionId: plainFirst.owningSessionId, capacity: "xfs" },
				"appended-xfs",
			);
			await expectRecord(plainFirst.session, plainFirst.owningSessionId, "off", [plain, later], backend);
		}, 90_000);
	}
});

describe("portable worker lifetime", () => {
	function authorityWorker(): Worker {
		return new Worker(new URL("../../src/registry/authority/worker.ts", import.meta.url).href, {
			type: "module",
			argv: [AUTHORITY_DIRECT_WORKER_ARG],
		});
	}

	it("confirms worker exit through the close event and refuses to confirm a live worker", async () => {
		const worker = authorityWorker();
		try {
			const pin = await threadLifetime.pinAuthorityWorker(worker, Date.now() + 10_000, "worker-close");
			expect(pin.mode).toBe("worker-close");
			expect(pin.hasExited()).toBe(false);
			await expect(threadLifetime.waitForAuthorityThreadExit(pin, Date.now())).rejects.toThrow(
				/remains unconfirmed/,
			);
			worker.terminate();
			await threadLifetime.waitForAuthorityThreadExit(pin, Date.now() + 10_000);
			expect(pin.hasExited()).toBe(true);
		} finally {
			worker.terminate();
		}
	}, 30_000);

	for (const backend of backends) {
		it(`runs a full ${backend} root lifecycle when the host has no PIDFD_THREAD`, async () => {
			const pinWorker = threadLifetime.pinAuthorityWorker;
			const modes: string[] = [];
			const pinSpy = spyOn(threadLifetime, "pinAuthorityWorker").mockImplementation(async (worker, deadline) => {
				const pin = await pinWorker(worker, deadline, "worker-close");
				modes.push(pin.mode);
				return pin;
			});
			try {
				const [{ parent }] = await nonXfsParents();
				const root = await freshRoot(parent);
				const first = await writeAndClose(
					root.session,
					{ owningSessionId: root.owningSessionId, create: true, backend },
					"portable-first",
				);
				await expectRecord(root.session, root.owningSessionId, undefined, [first], backend);
				expect(modes).toEqual(["worker-close", "worker-close"]);
			} finally {
				pinSpy.mockRestore();
			}
		}, 60_000);
	}
});
