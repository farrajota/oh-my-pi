import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import * as syncFs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import {
	BorrowedAuthorityCapacityPool,
	AuthorityCapacityPoolError,
} from "../../src/registry/authority/capacity-native";

const directories: string[] = [];
const handles: FileHandle[] = [];

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function anonymousFile(): Promise<FileHandle> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-native-"));
	directories.push(directory);
	const filename = path.join(directory, "pool");
	const handle = await fs.open(filename, "w+");
	handles.push(handle);
	await fs.unlink(filename);
	return handle;
}

async function identityFor(handle: FileHandle) {
	const stat = await handle.stat({ bigint: true });
	return { fd: handle.fd, device: stat.dev, inode: stat.ino } as const;
}

async function openPool(handle: FileHandle) {
	return BorrowedAuthorityCapacityPool.open(await identityFor(handle));
}

/** Allocates `[offset, offset + length)` of `fd` without changing its size, as a mode-0 step that failed partway leaves it. */
function allocatePastEof(fd: number, offset: number, length: number): void {
	const libc = dlopen("libc.so.6", {
		fallocate: { args: [FFIType.i32, FFIType.i32, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
	});
	try {
		const FALLOC_FL_KEEP_SIZE = 0x01;
		if (libc.symbols.fallocate(fd, FALLOC_FL_KEEP_SIZE, BigInt(offset), BigInt(length)) !== 0)
			throw new Error("fixture fallocate failed");
	} finally {
		libc.close();
	}
}

describe("borrowed native authority capacity pool", () => {
	it("reconciles a growth that failed partway by returning its allocation past EOF, then grows again", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const grown = pool.ensureDataBytes(2 * pool.inspect().blockSize);
		const allocated = (await handle.stat()).blocks * 512;
		allocatePastEof(handle.fd, grown.dataBytes, 6 * grown.blockSize);
		expect((await handle.stat()).blocks * 512).toBeGreaterThan(allocated);
		const reconciled = pool.reconcile();
		// The uncredited blocks past EOF are gone and the verified EOF prefix is the pool again.
		expect(reconciled.dataBytes).toBe(grown.dataBytes);
		expect((await handle.stat()).size).toBe(grown.dataBytes);
		expect((await handle.stat()).blocks * 512).toBe(allocated);
		expect(pool.ensureDataBytes(grown.dataBytes + grown.blockSize).dataBytes).toBe(grown.dataBytes + grown.blockSize);
	});

	it("rejects named files and identity mismatches without changing them", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-native-named-"));
		directories.push(directory);
		const handle = await fs.open(path.join(directory, "named"), "w+");
		handles.push(handle);
		await handle.write(Buffer.from("owned"));
		const before = await handle.stat({ bigint: true });
		expect(() =>
			BorrowedAuthorityCapacityPool.open({ fd: handle.fd, device: before.dev, inode: before.ino }),
		).toThrow(AuthorityCapacityPoolError);
		expect(() =>
			BorrowedAuthorityCapacityPool.open({ fd: handle.fd, device: before.dev, inode: before.ino + 1n }),
		).toThrow(AuthorityCapacityPoolError);
		const after = await handle.stat({ bigint: true });
		expect(after.size).toBe(before.size);
		expect(after.ino).toBe(before.ino);
	});

	it("allocates a real dense aligned EOF, reports physical blocks separately, and retains the borrowed descriptor", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const initial = pool.inspect();
		expect(initial.dataBytes).toBe(0);
		expect(initial.device).toBe((await identityFor(handle)).device);
		expect(initial.inode).toBe((await identityFor(handle)).inode);
		const grown = pool.ensureDataBytes(initial.blockSize + 1);
		expect(grown.dataBytes).toBe(initial.blockSize * 2);
		expect(grown.allocatedBytes).toBeGreaterThanOrEqual(grown.dataBytes);
		expect((await handle.stat()).size).toBe(grown.dataBytes);
		const fd = handle.fd;
		await handle.write(Buffer.from([0x5a]), 0, 1, 0);
		expect(pool.inspect().dataBytes).toBe(grown.dataBytes);
		expect(handle.fd).toBe(fd);
	});

	it("releases only an aligned previously allocated EOF suffix and can regrow it", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const initial = pool.inspect();
		const full = pool.ensureDataBytes(initial.blockSize * 3);
		await handle.write(Buffer.from([0x41]), 0, 1, 0);
		await handle.write(Buffer.from([0x52]), 0, 1, initial.blockSize * 2);
		const receipt = pool.releaseDataBytes(initial.blockSize);
		expect(receipt.before.dataBytes).toBe(full.dataBytes);
		expect(receipt.after.dataBytes).toBe(initial.blockSize * 2);
		const retained = Buffer.alloc(1);
		expect((await handle.read(retained, 0, 1, 0)).bytesRead).toBe(1);
		expect(retained[0]).toBe(0x41);
		expect(receipt.releasedDataBytes).toBe(initial.blockSize);
		expect((await handle.stat()).size).toBe(receipt.after.dataBytes);
		expect(pool.ensureDataBytes(full.dataBytes).dataBytes).toBe(full.dataBytes);
	});

	it("reconciles a real same-inode EOF change before reporting restored capacity", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const initial = pool.inspect();
		const allocated = pool.ensureDataBytes(initial.blockSize * 3);
		await handle.truncate(initial.blockSize);
		expect(() => pool.inspect()).toThrow(AuthorityCapacityPoolError);
		expect(pool.reconcile().dataBytes).toBe(initial.blockSize);
		expect(pool.ensureDataBytes(allocated.dataBytes).dataBytes).toBe(allocated.dataBytes);
	});

	it("refuses sparse anonymous EOF without converting size into allocation credit", async () => {
		const handle = await anonymousFile();
		await handle.truncate(1_048_576);
		const before = await handle.stat();
		const identity = await identityFor(handle);
		expect(() => BorrowedAuthorityCapacityPool.open(identity)).toThrow(AuthorityCapacityPoolError);
		expect((await handle.stat()).size).toBe(before.size);
	});
	it("rejects invalid growth and release requests without mutating coverage", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const initial = pool.inspect();
		expect(() => pool.ensureDataBytes(-1)).toThrow();
		expect(() => pool.ensureDataBytes(Number.MAX_SAFE_INTEGER + 1)).toThrow();
		expect(() => pool.releaseDataBytes(1)).toThrow();
		expect(() => pool.releaseDataBytes(initial.blockSize)).toThrow();
		expect(pool.inspect().dataBytes).toBe(initial.dataBytes);
		expect((await handle.stat()).size).toBe(0);
	});
	it("refuses a reused borrowed descriptor without mutating the replacement inode", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const blockSize = pool.inspect().blockSize;
		const borrowedFd = handle.fd;
		handles.splice(handles.indexOf(handle), 1);
		await handle.close();
		const replacement = await fs.open(path.join(directories[0]!, "replacement"), "w+");
		handles.push(replacement);
		expect(replacement.fd).toBe(borrowedFd);
		let failure: unknown;
		try {
			pool.ensureDataBytes(blockSize);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AuthorityCapacityPoolError);
		expect((failure as AuthorityCapacityPoolError).poolState).toBe("uncertain");
		expect((await replacement.stat()).size).toBe(0);
		expect(() => pool.reconcile()).toThrow(AuthorityCapacityPoolError);
	});
	it("reports uncertain native failures and reconciles before credit", () => {
		const moduleUrl = new URL("../../src/registry/authority/capacity-native.ts", import.meta.url).href;
		const childSource = `
			import { dlopen, FFIType, ptr } from "bun:ffi";
			import * as fs from "node:fs/promises";
			import * as os from "node:os";
			import * as path from "node:path";
			import { BorrowedAuthorityCapacityPool } from ${JSON.stringify(moduleUrl)};
			const libc = dlopen("libc.so.6", {
				dup: { args: [FFIType.i32], returns: FFIType.i32 },
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				close: { args: [FFIType.i32], returns: FFIType.i32 },
				getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
				setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			});
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-native-failure-"));
			const filename = path.join(directory, "pool");
			let handle;
			try {
				handle = await fs.open(filename, "w+");
				await fs.unlink(filename);
				const stat = await handle.stat({ bigint: true });
				const pool = BorrowedAuthorityCapacityPool.open({ fd: handle.fd, device: stat.dev, inode: stat.ino });
				const initial = pool.inspect();
				const writableBackupFd = libc.symbols.dup(handle.fd);
				if (writableBackupFd < 0) throw new Error("Could not retain writable capacity descriptor");
				let eligibilityFailure;
				try {
					const readonlyHandle = await fs.open("/proc/self/fd/" + handle.fd, "r");
					try {
						// Only the test caller rebinds the borrowed fd; its writable backup retains the same inode.
						if (libc.symbols.dup2(readonlyHandle.fd, handle.fd) !== handle.fd) throw new Error("Could not rebind capacity descriptor read-only");
						const rebound = await handle.stat({ bigint: true });
						if (rebound.dev !== stat.dev || rebound.ino !== stat.ino) throw new Error("Read-only descriptor changed capacity inode identity");
						try { pool.inspect(); } catch (error) { eligibilityFailure = error; }
						if (!eligibilityFailure) throw new Error("Inspection accepted a read-only capacity descriptor");
					} finally {
						try {
							if (libc.symbols.dup2(writableBackupFd, handle.fd) !== handle.fd) throw new Error("Could not restore writable capacity descriptor");
						} finally {
							await readonlyHandle.close();
						}
					}
				} finally {
					if (libc.symbols.close(writableBackupFd) !== 0) throw new Error("Could not close writable capacity backup");
				}
				const eligibilityReconciled = pool.reconcile();
				const previousLimit = Buffer.alloc(16);
				if (libc.symbols.getrlimit(1, ptr(previousLimit)) !== 0) throw new Error("getrlimit(RLIMIT_FSIZE) failed");
				const originalSoftLimit = previousLimit.readBigUInt64LE(0);
				const originalHardLimit = previousLimit.readBigUInt64LE(8);
				const limited = Buffer.alloc(16);
				limited.writeBigUInt64LE(0n, 0);
				limited.writeBigUInt64LE(originalHardLimit, 8);
				if (libc.symbols.setrlimit(1, ptr(limited)) !== 0) throw new Error("setrlimit(RLIMIT_FSIZE) failed");
				process.on("SIGXFSZ", () => {});
				let growthFailure;
				try { pool.ensureDataBytes(initial.blockSize); } catch (error) { growthFailure = error; }
				finally {
					const restoredLimit = Buffer.alloc(16);
					restoredLimit.writeBigUInt64LE(originalSoftLimit, 0);
					restoredLimit.writeBigUInt64LE(originalHardLimit, 8);
					if (libc.symbols.setrlimit(1, ptr(restoredLimit)) !== 0) throw new Error("Could not restore RLIMIT_FSIZE");
				}
				if (!growthFailure) throw new Error("Native fallocate unexpectedly succeeded under a zero file-size limit");
				let latchedFailure;
				try { pool.inspect(); } catch (error) { latchedFailure = error; }
				if (!latchedFailure) throw new Error("Pool inspection bypassed the uncertain-state latch");
				const reconciled = pool.reconcile();
				const regrown = pool.ensureDataBytes(initial.blockSize);
				const eligibilityCause = eligibilityFailure.cause;
				const nativeCause = growthFailure.cause;
				process.stdout.write(JSON.stringify({
					initialBytes: initial.dataBytes,
					blockSize: initial.blockSize,
					eligibilityPoolState: eligibilityFailure.poolState,
					eligibilityCausePoolState: eligibilityCause?.poolState,
					eligibilityCauseMessage: eligibilityCause?.message,
					eligibilityReconciledBytes: eligibilityReconciled.dataBytes,
					growthPoolState: growthFailure.poolState,
					nativeCauseName: nativeCause?.name,
					nativeCauseCode: nativeCause?.code,
					nativeCauseMessage: nativeCause?.message,
					latchedPoolState: latchedFailure.poolState,
					reconciledBytes: reconciled.dataBytes,
					regrownBytes: regrown.dataBytes,
					borrowedDescriptorRetained: (await handle.stat({ bigint: true })).ino === stat.ino,
				}));
			} finally {
				try {
					await handle?.close();
				} finally {
					await fs.rm(directory, { recursive: true, force: true });
				}
			}
		`;
		const child = spawnSync(process.execPath, ["-e", childSource], { encoding: "utf8" });
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
		const result = JSON.parse(String(child.stdout)) as {
			initialBytes: number;
			blockSize: number;
			eligibilityPoolState: string;
			eligibilityCausePoolState: string;
			eligibilityCauseMessage: string;
			eligibilityReconciledBytes: number;
			growthPoolState: string;
			nativeCauseCode: string;
			nativeCauseMessage: string;
			latchedPoolState: string;
			reconciledBytes: number;
			regrownBytes: number;
			borrowedDescriptorRetained: boolean;
		};
		expect(result.initialBytes).toBe(0);
		expect(result.eligibilityPoolState).toBe("uncertain");
		expect(result.eligibilityCausePoolState).toBe("verified");
		expect(result.eligibilityCauseMessage).toBe("Capacity descriptor must be open for writing");
		expect(result.eligibilityReconciledBytes).toBe(0);
		expect(result.growthPoolState).toBe("uncertain");
		expect(result.nativeCauseCode).toBe("ERRNO_27");
		expect(result.nativeCauseMessage).toContain("fallocate(mode 0)");
		expect(result.latchedPoolState).toBe("uncertain");
		expect(result.reconciledBytes).toBe(0);
		expect(result.regrownBytes).toBe(result.blockSize);
		expect(result.borrowedDescriptorRetained).toBe(true);
	});

	it("proves each bounded growth step's exact EOF with a full identity readback per call, not per step", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const { blockSize } = pool.inspect();
		const steps = spyOn(syncFs, "fstatSync");
		const identities = spyOn(syncFs, "statfsSync");
		try {
			pool.ensureDataBytes(blockSize * 12, blockSize * 6);
			const shortCall = identities.mock.calls.length;
			identities.mockClear();
			steps.mockClear();
			const grown = pool.ensureDataBytes(blockSize * 612, blockSize * 6);
			expect(grown.dataBytes).toBe(blockSize * 612);
			// 100 steps: each still reads back its EOF, but the inode's project, geometry and flags are read a fixed number of times.
			expect(steps.mock.calls.length).toBeGreaterThanOrEqual(100);
			expect(identities.mock.calls.length).toBe(shortCall);
		} finally {
			identities.mockRestore();
			steps.mockRestore();
		}
		expect((await handle.stat()).size).toBe(blockSize * 612);
	});

	it("rejects a growth step that is not a whole number of blocks without changing coverage", async () => {
		const handle = await anonymousFile();
		const pool = await openPool(handle);
		const { blockSize } = pool.inspect();
		for (const step of [0, blockSize - 1, blockSize + 1]) {
			expect(() => pool.ensureDataBytes(blockSize * 4, step)).toThrow(
				"Capacity growth step must be a positive whole number of blocks",
			);
		}
		expect(pool.inspect().dataBytes).toBe(0);
		expect((await handle.stat()).size).toBe(0);
	});

	it("counts every completed growth step when a later step fails", () => {
		const moduleUrl = new URL("../../src/registry/authority/capacity-native.ts", import.meta.url).href;
		const childSource = `
			import { dlopen, FFIType, ptr } from "bun:ffi";
			import * as fs from "node:fs/promises";
			import * as os from "node:os";
			import * as path from "node:path";
			import { BorrowedAuthorityCapacityPool } from ${JSON.stringify(moduleUrl)};
			const libc = dlopen("libc.so.6", {
				getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
				setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			});
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-native-steps-"));
			const filename = path.join(directory, "pool");
			let handle;
			try {
				handle = await fs.open(filename, "w+");
				await fs.unlink(filename);
				const stat = await handle.stat({ bigint: true });
				const pool = BorrowedAuthorityCapacityPool.open({ fd: handle.fd, device: stat.dev, inode: stat.ino });
				const { blockSize } = pool.inspect();
				const grown = pool.ensureDataBytes(blockSize * 5, blockSize * 2);
				const grownSize = Number((await handle.stat()).size);
				const previousLimit = Buffer.alloc(16);
				if (libc.symbols.getrlimit(1, ptr(previousLimit)) !== 0) throw new Error("getrlimit(RLIMIT_FSIZE) failed");
				const limited = Buffer.alloc(16);
				// Two more two-block steps fit below the limit; the third crosses it.
				limited.writeBigUInt64LE(BigInt(blockSize * 9), 0);
				limited.writeBigUInt64LE(previousLimit.readBigUInt64LE(8), 8);
				if (libc.symbols.setrlimit(1, ptr(limited)) !== 0) throw new Error("setrlimit(RLIMIT_FSIZE) failed");
				process.on("SIGXFSZ", () => {});
				let growthFailure;
				try { pool.ensureDataBytes(blockSize * 12, blockSize * 2); } catch (error) { growthFailure = error; }
				finally {
					if (libc.symbols.setrlimit(1, ptr(previousLimit)) !== 0) throw new Error("Could not restore RLIMIT_FSIZE");
				}
				if (!growthFailure) throw new Error("Stepped growth unexpectedly crossed the file-size limit");
				const reconciled = pool.reconcile();
				process.stdout.write(JSON.stringify({
					blockSize,
					grownBytes: grown.dataBytes,
					grownSize,
					growthPoolState: growthFailure.poolState,
					nativeCauseCode: growthFailure.cause?.code,
					reconciledBytes: reconciled.dataBytes,
				}));
			} finally {
				try {
					await handle?.close();
				} finally {
					await fs.rm(directory, { recursive: true, force: true });
				}
			}
		`;
		const child = spawnSync(process.execPath, ["-e", childSource], { encoding: "utf8" });
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
		const result = JSON.parse(String(child.stdout)) as {
			blockSize: number;
			grownBytes: number;
			grownSize: number;
			growthPoolState: string;
			nativeCauseCode: string;
			reconciledBytes: number;
		};
		expect(result.grownBytes).toBe(result.blockSize * 5);
		expect(result.grownSize).toBe(result.blockSize * 5);
		expect(result.growthPoolState).toBe("uncertain");
		expect(result.nativeCauseCode).toBe("ERRNO_27");
		expect(result.reconciledBytes).toBe(result.blockSize * 9);
	});
});
