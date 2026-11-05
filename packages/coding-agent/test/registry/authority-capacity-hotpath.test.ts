import { afterEach, expect, it, spyOn } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	authorityTargetReadbackStats,
	fundAuthorityCapacityTarget,
	openAuthorityCapacityFile,
} from "../../src/registry/authority/capacity";
import { BorrowedAuthorityCapacityPool } from "../../src/registry/authority/capacity-native";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";
import { durableRootHeadHash, type DurableRegistryRecord } from "../../src/registry/durable-state";
import { xfsCapacityHost } from "./authority-capacity-host";

// Cases that fund real XFS capacity under os.tmpdir(); see authority-capacity-host.ts for when a host qualifies.
const itOnXfs = it.skipIf(!xfsCapacityHost);

/*
 * Steady-state cost contracts of the opt-in capacity mode: per-command readback work must not grow with the
 * store's history or with the size of a group commit, while the readbacks that defend a promise (the write
 * region's private allocation, reflink sharing) still run before every write.
 */

const ADMISSION = 2_097_152;
const directories: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function makeDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "authority-capacity-hotpath-"));
	directories.push(directory);
	return directory;
}

type Binding = { rootId: string; actorId: string; generation: number };

function activateRoot(engine: AuthorityEngine): Binding {
	const hash = "1".repeat(64);
	const rootHash = durableRootHeadHash({
		rootId: "r",
		generation: 1,
		actorId: "r",
		startupHash: hash,
		provenanceHash: hash,
	});
	const construction = {
		kind: "construction",
		at: 1,
		rootId: "r",
		actorId: "r",
		generation: 1,
		startupHash: hash,
		provenanceHash: hash,
		phase: "reserved",
	} satisfies DurableRegistryRecord;
	for (const phase of ["reserved", "constructing", "constructed"] as const)
		engine.transition({ ...construction, phase });
	engine.activateAuthority({
		construction: { ...construction, phase: "activated" },
		root: { kind: "root", at: 1, rootId: "r", generation: 1, headHash: rootHash, state: "active" },
		actor: {
			kind: "actor",
			at: 1,
			actorId: "r",
			rootId: "r",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: rootHash,
			startupHash: hash,
			provenanceHash: hash,
			state: "active",
		},
		gate: { kind: "gate", at: 1, rootId: "r", generation: 1, phase: "open" },
	});
	return { rootId: "r", actorId: "r", generation: 1 };
}

function operationRow(
	binding: Binding,
	operationId: string,
	phase: "intent" | "effect" | "completed",
	at: number,
): DurableRegistryRecord {
	return {
		kind: "operation",
		at,
		operationId,
		effectClass: "eval",
		ownerId: binding.actorId,
		classOwnerId: `${binding.actorId}:eval`,
		actorId: binding.actorId,
		rootId: binding.rootId,
		generation: binding.generation,
		acquiredAt: 1,
		expiresAt: 1_800_001,
		phase,
	};
}

const sqliteIdentity = {
	backend: "sqlite" as const,
	owningSessionId: "session",
	incarnation: "incarnation",
	format: 2 as const,
};
const jsonlIdentity = {
	backend: "jsonl" as const,
	owningSessionId: "session",
	incarnation: "incarnation",
	format: 2 as const,
};

itOnXfs(
	"certifies SQLite target backing a fixed number of times per group commit, independent of how many members it holds",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const engine = new AuthorityEngine(
			new SqliteAuthorityPersistence({
				path: path.join(directory, "grouped.sqlite"),
				identity: sqliteIdentity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
			}),
			"o".repeat(36),
		);
		try {
			engine.recover();
			const binding = activateRoot(engine);
			let at = 10;
			let serial = 0;
			// Every member advances an already admitted operation, so no member is a NEW admission that could fund an arena.
			const group = (members: number): number => {
				const ids = Array.from({ length: members }, () => `toolu_01group${serial++}`);
				for (const id of ids) engine.transition(operationRow(binding, id, "intent", at++));
				const before = authorityTargetReadbackStats().inspections;
				engine.beginGroup();
				for (const id of ids) engine.transition(operationRow(binding, id, "effect", at++));
				engine.syncGroup();
				return authorityTargetReadbackStats().inspections - before;
			};
			// Warm-up funds the database, WAL and pool arenas.
			for (let index = 0; index < 3; index++) group(4);
			const small = group(2);
			const large = group(12);
			expect(engine.getOperation("r", "eval", `toolu_01group${serial - 1}`)?.record.phase).toBe("effect");
			// One certification at the transaction's start and one at its settlement; members in between write nothing
			// to the database or WAL (cache_spill=OFF, exclusive lock), so their prepares reuse that certification.
			expect(small).toBeGreaterThan(0);
			expect(large).toBe(small);
		} finally {
			engine.close();
		}
	},
);

itOnXfs("runs steady-state SQLite commands without free-space or pool attribute readbacks", async () => {
	const directory = await makeDirectory();
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	const engine = new AuthorityEngine(
		new SqliteAuthorityPersistence({
			path: path.join(directory, "steady.sqlite"),
			identity: sqliteIdentity,
			create: true,
			capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
		}),
		"o".repeat(36),
	);
	const statfs = spyOn(syncFs, "statfsSync");
	try {
		engine.recover();
		const binding = activateRoot(engine);
		let at = 10;
		const lifecycle = (operationId: string): void => {
			for (const phase of ["intent", "effect", "completed"] as const)
				engine.transition(operationRow(binding, operationId, phase, at++));
		};
		for (let index = 0; index < 3; index++) lifecycle(`toolu_01warm${index}`);
		statfs.mockClear();
		for (let index = 0; index < 10; index++) lifecycle(`toolu_01steady${index}`);
		expect(engine.getOperation("r", "eval", "toolu_01steady9")?.record.phase).toBe("completed");
		// Free space is consulted only to grow the pool, and the pool's and targets' filesystem is proved once per
		// mutation of the pool, not on every inspection; 30 steady commands may grow the pool slack at most a few times.
		expect(statfs.mock.calls.length).toBeLessThanOrEqual(4);
	} finally {
		statfs.mockRestore();
		engine.close();
	}
});

/** Steady-state JSONL lifecycles on a store whose journal already holds `historyOperations` completed operations. */
async function jsonlSteadyPrefixBytes(
	historyOperations: number,
): Promise<{ prefixBytesPerCommand: number; scansPerCommand: number; journalBytes: number }> {
	const directory = await makeDirectory();
	const filename = path.join(directory, "history.jsonl");
	const builder = new AuthorityEngine(
		new JsonlAuthorityPersistence({ path: filename, identity: jsonlIdentity, create: true }),
		"o".repeat(36),
	);
	let at = 10;
	let binding: Binding;
	try {
		builder.recover();
		binding = activateRoot(builder);
		// History built without capacity, in groups, so only the reopened owner below is measured.
		for (let start = 0; start < historyOperations; start += 50) {
			builder.beginGroup();
			for (let index = start; index < Math.min(historyOperations, start + 50); index++)
				for (const phase of ["intent", "effect", "completed"] as const)
					builder.transition(operationRow(binding, `toolu_01history${index}`, phase, at++));
			builder.syncGroup();
		}
	} finally {
		builder.close();
	}
	const capacity = await openAuthorityCapacityFile(directory);
	handles.push(capacity.handle);
	const engine = new AuthorityEngine(
		new JsonlAuthorityPersistence({
			path: filename,
			identity: jsonlIdentity,
			create: false,
			capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
		}),
		"o".repeat(36),
	);
	try {
		engine.recover();
		const lifecycle = (operationId: string): void => {
			for (const phase of ["intent", "effect", "completed"] as const)
				engine.transition(operationRow(binding, operationId, phase, at++));
		};
		for (let index = 0; index < 3; index++) lifecycle(`toolu_01warm${index}`);
		const before = authorityTargetReadbackStats();
		for (let index = 0; index < 10; index++) lifecycle(`toolu_01steady${index}`);
		const after = authorityTargetReadbackStats();
		expect(engine.getOperation("r", "eval", "toolu_01steady9")?.record.phase).toBe("completed");
		return {
			prefixBytesPerCommand: (after.prefixBytes - before.prefixBytes) / 30,
			scansPerCommand: (after.fiemapCalls - before.fiemapCalls) / 30,
			journalBytes: syncFs.statSync(filename).size,
		};
	} finally {
		engine.close();
	}
}

itOnXfs(
	"re-scans no written JSONL history in steady state: readback work per command does not grow with the journal",
	async () => {
		const small = await jsonlSteadyPrefixBytes(0);
		const large = await jsonlSteadyPrefixBytes(400);
		expect(large.journalBytes).toBeGreaterThan(20 * small.journalBytes);
		// An append-only journal never rewrites below its EOF, so only the block holding EOF is re-proved each command.
		expect(small.prefixBytesPerCommand).toBeLessThanOrEqual(4_096);
		expect(large.prefixBytesPerCommand).toBeLessThanOrEqual(4_096);
		expect(large.scansPerCommand).toBeLessThanOrEqual(small.scansPerCommand + 0.5);
	},
);

itOnXfs(
	"still detects a reflink copy taken between JSONL commands and gives the journal's write block a private copy before the append",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const filename = path.join(directory, "copied.jsonl");
		const engine = new AuthorityEngine(
			new JsonlAuthorityPersistence({
				path: filename,
				identity: jsonlIdentity,
				create: true,
				capacity: { identity: capacity.identity, maxRequestBytes: ADMISSION },
			}),
			"o".repeat(36),
		);
		try {
			engine.recover();
			const binding = activateRoot(engine);
			let at = 10;
			for (const phase of ["intent", "effect", "completed"] as const)
				engine.transition(operationRow(binding, "toolu_01before", phase, at++));
			// XFS copy_file_range reflinks the live journal, so its block holding EOF becomes shared behind the owner.
			await fs.copyFile(filename, path.join(directory, "evidence.jsonl"));
			const shared = sharedRanges(filename);
			expect(shared.length).toBeGreaterThan(0);
			engine.transition(operationRow(binding, "toolu_01after", "intent", at++));
			const size = syncFs.statSync(filename).size;
			const writeBlock = Math.floor((size - 1) / 4_096) * 4_096;
			// The append landed in a private block: the shared copy-on-write source was replaced before the write.
			expect(sharedRanges(filename).some(([start, end]) => start <= writeBlock && writeBlock < end)).toBe(false);
		} finally {
			engine.close();
		}
	},
);

itOnXfs(
	"scans only each funding step's range while unsharing a reflinked target, so the work is linear in the horizon",
	async () => {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const domain = BorrowedAuthorityCapacityPool.open(capacity.identity).inspect();
		const filename = path.join(directory, "shared");
		const content = Buffer.alloc(2 * 1_048_576, 9);
		await fs.writeFile(filename, content, { mode: 0o600 });
		await fs.copyFile(filename, path.join(directory, "copy"));
		const target = await fs.open(filename, "r+");
		handles.push(target);
		const before = authorityTargetReadbackStats();
		const funded = fundAuthorityCapacityTarget(target.fd, domain, content.length);
		const after = authorityTargetReadbackStats();
		expect(funded.coveredBytes).toBe(content.length);
		expect(funded.sharedBytes).toBe(0);
		expect(await fs.readFile(filename)).toEqual(content);
		// 86 six-block steps over 2 MiB: scanning to the end of the file from every step reads ~43x the horizon.
		expect(after.scannedBytes - before.scannedBytes).toBeLessThanOrEqual(4 * content.length);
	},
);

/** `[start, end)` byte ranges FIEMAP reports as shared for `filename` (FIEMAP_FLAG_SYNC, so delayed allocation is resolved first). */
function sharedRanges(filename: string): Array<[number, number]> {
	const libc = dlopen("libc.so.6", { ioctl: { args: [FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 } });
	const descriptor = syncFs.openSync(filename, "r");
	const ranges: Array<[number, number]> = [];
	try {
		const map = Buffer.alloc(32 + 512 * 56);
		let cursor = 0n;
		for (;;) {
			map.fill(0);
			map.writeBigUInt64LE(cursor, 0);
			map.writeBigUInt64LE((1n << 64n) - 1n - cursor, 8);
			map.writeUInt32LE(1, 16);
			map.writeUInt32LE(512, 24);
			if (libc.symbols.ioctl(descriptor, 0xc020660b, ptr(map)) !== 0) throw new Error("fixture FIEMAP failed");
			const count = map.readUInt32LE(20);
			if (count === 0) break;
			let last = false;
			for (let index = 0; index < count; index++) {
				const offset = 32 + index * 56;
				const logical = map.readBigUInt64LE(offset);
				const length = map.readBigUInt64LE(offset + 16);
				const flags = map.readUInt32LE(offset + 40);
				if ((flags & 0x2000) !== 0) ranges.push([Number(logical), Number(logical + length)]);
				cursor = logical + length;
				if ((flags & 0x1) !== 0) last = true;
			}
			if (last) break;
		}
	} finally {
		syncFs.closeSync(descriptor);
		libc.close();
	}
	return ranges;
}
