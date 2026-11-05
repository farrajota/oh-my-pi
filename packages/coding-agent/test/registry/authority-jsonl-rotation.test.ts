import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsNamespace from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openAuthorityCapacityFile } from "../../src/registry/authority/capacity";
import { BorrowedAuthorityCapacityPool } from "../../src/registry/authority/capacity-native";
import { AuthorityCapacityRefusedError } from "../../src/registry/authority/capacity-sqlite";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { jsonlLayout, listJsonlRotationArtifacts } from "../../src/registry/authority/jsonl-layout";
import type { AuthorityDriverOptions, AuthorityIdentity } from "../../src/registry/authority/types";
import { xfsCapacityHost } from "./authority-capacity-host";

// A rotated JSONL store keeps the active segment small: open reads its snapshot and the active segment only,
// sealed history is read back only for export and full verification, and every crash cut of a rotation
// reopens to a committed layout without losing an acknowledged command.

const directories: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close();
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(prefix = "omp-authority-jsonl-rotation-"): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function operation(index: number, phase: "intent" | "abandoned") {
	return {
		kind: "operation" as const,
		at: 10 + index,
		operationId: `op-${index}`,
		effectClass: "eval" as const,
		ownerId: "actor-1",
		classOwnerId: "root-1",
		actorId: "actor-1",
		rootId: "root-1",
		generation: 1,
		acquiredAt: 10,
		expiresAt: 100,
		phase,
	};
}

/** One frame that leaves a terminal operation row behind, so recovery is never blocked by an open intent. */
function terminal(engine: AuthorityEngine, index: number, requestId: string) {
	return engine.transitionBatch([operation(index, "intent"), operation(index, "abandoned")], { requestId });
}

function identity(): AuthorityIdentity {
	return { backend: "jsonl", owningSessionId: "root-session", incarnation: crypto.randomUUID(), format: 2 };
}

/** Rotation limits that never trigger by size, so tests choose the exact frame count of each segment. */
function frameLimits(maxFrames: number): AuthorityDriverOptions["jsonlSegment"] {
	return { minBytes: Number.MAX_SAFE_INTEGER, maxFrames };
}

/** Segment number recorded by the active payload's first line. */
function activeSegment(file: string): number {
	const first = fsNamespace.readFileSync(file, "utf8").split("\n", 1)[0]!;
	const header = JSON.parse(first) as { version: number; segment?: number };
	return header.version === 3 ? header.segment! : 0;
}

function directoryOf(file: string): string {
	return path.dirname(file);
}

function activeFrames(file: string): number {
	return fsNamespace.readFileSync(file, "utf8").split("\n").filter(Boolean).length - 1;
}

/** Basenames of the rotation artifacts a committed store at active segment `segment` has, and nothing else. */
function committedLayout(active: string, segment: number): string[] {
	const layout = jsonlLayout(active);
	const names: string[] = [];
	for (let index = 0; index < segment; index++)
		names.push(path.basename(layout.segment(index)), path.basename(layout.index(index)));
	if (segment > 0) names.push(path.basename(layout.snapshot(segment)));
	return names.sort();
}

function artifactNames(active: string): string[] {
	return listJsonlRotationArtifacts(active)
		.map(artifact => path.basename(artifact.file))
		.sort();
}

/** Bytes read through the fs namespace while `run` executes. */
function bytesReadBy(run: () => void): number {
	let bytes = 0;
	const readSync = fsNamespace.readSync;
	const readFileSync = fsNamespace.readFileSync;
	const spies = [
		spyOn(fsNamespace, "readSync").mockImplementation(((...args: Parameters<typeof readSync>) => {
			const read = readSync(...args);
			bytes += read;
			return read;
		}) as typeof readSync),
		spyOn(fsNamespace, "readFileSync").mockImplementation(((...args: Parameters<typeof readFileSync>) => {
			const contents = readFileSync(...args);
			bytes += typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
			return contents;
		}) as typeof readFileSync),
	];
	try {
		run();
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	return bytes;
}

describe("JSONL segment rotation trigger", () => {
	test("seals the active segment before the append that would exceed the frame cap", async () => {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: frameLimits(6),
		};
		const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "owner-token");
		engine.recover();
		for (let index = 0; activeFrames(options.path) < 6; index++)
			engine.transition(operation(index, "intent"), { requestId: `fill-${index}` });
		expect(activeSegment(options.path)).toBe(0);
		expect(artifactNames(options.path)).toEqual([]);
		const sealedBytes = fsNamespace.readFileSync(options.path);
		const receipt = engine.transition(operation(100, "intent"), { requestId: "rotating" });
		// The sealed segment is the former active segment byte for byte; the triggering frame opens segment 1.
		expect(activeSegment(options.path)).toBe(1);
		expect(activeFrames(options.path)).toBe(1);
		expect(artifactNames(options.path)).toEqual(committedLayout(options.path, 1));
		expect(fsNamespace.readFileSync(jsonlLayout(options.path).segment(0))).toEqual(sealedBytes);
		expect(engine.resolveReceipt("rotating")).toEqual(receipt);
		engine.close();
	});

	test("waits for the active segment to reach the snapshot size before rotating again", async () => {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: { minBytes: 1, maxFrames: Number.MAX_SAFE_INTEGER },
		};
		const driver = new JsonlAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		// Terminal rows make the snapshot outgrow a single frame, so a one-byte floor alone would snapshot every command.
		for (let index = 0; index < 40; index++) terminal(engine, index, `terminal-${index}`);
		const segment = activeSegment(options.path);
		const snapshotBytes = fsNamespace.statSync(jsonlLayout(options.path).snapshot(segment)).size;
		const activeBytes = fsNamespace.statSync(options.path).size;
		expect(segment).toBeGreaterThan(1);
		expect(segment).toBeLessThan(40);
		// The active segment always ends below the size that would trigger its own rotation.
		expect(activeBytes).toBeLessThan(
			snapshotBytes + fsNamespace.readFileSync(options.path, "utf8").split("\n").filter(Boolean).at(-1)!.length + 1,
		);
		driver.integrityCheck();
		engine.close();
	});
});

describe("JSONL open cost after rotation", () => {
	/** A history whose state stays constant: every owner restart replaces the owner control and adds one receipt. */
	async function ownerHistory(restarts: number): Promise<AuthorityDriverOptions> {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: frameLimits(16),
		};
		const driver = new JsonlAuthorityPersistence(options);
		for (let index = 0; index < restarts; index++) new AuthorityEngine(driver, `owner-${index}`);
		driver.close();
		return { ...options, create: false };
	}

	test("open reads the snapshot and active segment only, at two history sizes", async () => {
		const measured: Array<{ readonly read: number; readonly sealed: number }> = [];
		for (const restarts of [40, 400]) {
			const options = await ownerHistory(restarts);
			const layout = jsonlLayout(options.path);
			const segment = activeSegment(options.path);
			const snapshotBytes = fsNamespace.statSync(layout.snapshot(segment)).size;
			const activeBytes = fsNamespace.statSync(options.path).size;
			let sealed = 0;
			for (let index = 0; index < segment; index++)
				sealed += fsNamespace.statSync(layout.segment(index)).size + fsNamespace.statSync(layout.index(index)).size;
			let reopened: JsonlAuthorityPersistence | undefined;
			const read = bytesReadBy(() => {
				reopened = new JsonlAuthorityPersistence(options);
			});
			// The active segment once, its snapshot once, and the one-byte torn-tail probe; never sealed history.
			expect(read).toBeGreaterThanOrEqual(activeBytes + snapshotBytes);
			expect(read).toBeLessThanOrEqual(activeBytes + snapshotBytes + 1);
			expect(reopened!.findReceipt("missing", options.identity.incarnation)).toBeUndefined();
			// The first commit after open re-proves only the active segment, not the sealed history.
			const firstCommit = bytesReadBy(() => {
				new AuthorityEngine(reopened!, "measured-owner");
			});
			expect(firstCommit).toBeLessThanOrEqual(activeBytes + 16 * 1024);
			reopened!.integrityCheck();
			reopened!.close();
			measured.push({ read, sealed });
		}
		const [small, large] = measured as [{ read: number; sealed: number }, { read: number; sealed: number }];
		// Ten times the history, while the open still reads at most the bounded active segment more.
		expect(large.sealed).toBeGreaterThan(small.sealed * 8);
		expect(large.read).toBeLessThan(large.sealed / 10);
		expect(large.read).toBeLessThanOrEqual(small.read + 16 * 1024);
	}, 120_000);
});

describe("JSONL receipts across rotation", () => {
	test("acknowledged requests stay idempotent and resolvable across rotations and reopen", async () => {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: frameLimits(4),
		};
		const driver = new JsonlAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const receipts = [];
		for (let index = 0; index < 20; index++)
			receipts.push(engine.transition(operation(index, "intent"), { requestId: `request-${index}` }));
		expect(activeSegment(options.path)).toBeGreaterThanOrEqual(4);
		const revision = engine.recoveryState().revision;
		// Same owner: a retry of a request sealed in an earlier segment replays its receipt without a new frame.
		expect(engine.transition(operation(0, "intent"), { requestId: "request-0" })).toEqual(receipts[0]);
		expect(() => engine.transition(operation(1, "abandoned"), { requestId: "request-1" })).toThrow(
			"Request identity was reused",
		);
		expect(engine.recoveryState().revision).toBe(revision);
		const exported = driver.exportState();
		engine.close();
		const reopened = new JsonlAuthorityPersistence({ ...options, create: false });
		const next = new AuthorityEngine(reopened, "next-owner");
		for (const receipt of receipts) {
			expect(next.resolveReceipt(receipt.requestId)).toEqual(receipt);
			expect(
				next.resolveReceipt(receipt.requestId, receipt.ownerEpoch, receipt.incarnation, receipt.payloadHash),
			).toEqual(receipt);
		}
		expect(next.resolveReceipt("never-sent")).toBeUndefined();
		expect(
			reopened
				.scanControl("receipt:", undefined, 1000)
				.controls.filter(control => (control.value as { requestId: string }).requestId.startsWith("request-"))
				.length,
		).toBe(20);
		// Export reads every segment back: the full frame history and every receipt, accepted as a seed elsewhere.
		const full = reopened.exportState();
		expect(full.frames.slice(0, exported.frames.length)).toEqual([...exported.frames]);
		expect(full.frames.map(frame => frame.revision)).toEqual(
			Array.from({ length: full.revision }, (_, index) => index + 1),
		);
		const copy = new JsonlAuthorityPersistence({
			path: path.join(directory, "copy.jsonl"),
			identity: options.identity,
			create: true,
			seed: full,
		});
		expect(copy.exportState()).toEqual(full);
		copy.close();
		reopened.integrityCheck();
		next.close();
	});
});

describe("JSONL rotation crash cuts", () => {
	const MUTATIONS = ["openSync", "writeSync", "fsyncSync", "renameSync", "linkSync", "unlinkSync"] as const;

	/**
	 * Runs `run` while counting durable filesystem mutations (file creation, writes, fsyncs, renames, links,
	 * unlinks). At mutation `cut` the process "dies": that call and every later mutation throw without effect.
	 */
	function mutating(
		cut: number | undefined,
		run: () => void,
	): { readonly mutations: number; readonly error: unknown } {
		let mutations = 0;
		let dead = false;
		const spies: Array<{ mockRestore(): void }> = [];
		for (const name of MUTATIONS) {
			const original = fsNamespace[name] as (...args: unknown[]) => unknown;
			spies.push(
				spyOn(fsNamespace, name).mockImplementation(((...args: unknown[]) => {
					if (name === "openSync" && ((args[1] as number) & fsNamespace.constants.O_CREAT) === 0)
						return original(...args);
					if (mutations === cut) dead = true;
					if (dead) throw Object.assign(new Error(`simulated crash at ${name}`), { code: "ESIMULATEDCRASH" });
					mutations++;
					return original(...args);
				}) as never),
			);
		}
		let error: unknown;
		try {
			run();
		} catch (caught) {
			error = caught;
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		return { mutations, error };
	}

	/** A store whose first command after a reopen (owner recovering, then ready) rotates segment `segment`. */
	async function rotationBase(segment: number): Promise<{
		readonly directory: string;
		readonly options: AuthorityDriverOptions;
		readonly acknowledged: string[];
	}> {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: frameLimits(8),
		};
		const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "builder");
		engine.recover();
		const acknowledged: string[] = [];
		for (let index = 0; activeSegment(options.path) !== segment || activeFrames(options.path) !== 8 - 3; index++) {
			terminal(engine, index, `acknowledged-${index}`);
			acknowledged.push(`acknowledged-${index}`);
		}
		engine.close();
		return { directory, options: { ...options, create: false }, acknowledged };
	}

	async function copyStore(source: string): Promise<string> {
		const target = await makeDirectory("omp-authority-jsonl-cut-");
		for (const name of await fs.readdir(source)) await fs.copyFile(path.join(source, name), path.join(target, name));
		return target;
	}

	for (const segment of [0, 1]) {
		test(`every cut of rotating segment ${segment} reopens committed with every acknowledged command`, async () => {
			const base = await rotationBase(segment);
			const run = (options: AuthorityDriverOptions, cut: number | undefined) => {
				const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "crashing-owner");
				engine.recover();
				const revision = engine.recoveryState().revision;
				const outcome = mutating(cut, () => {
					terminal(engine, 1000, "rotating");
				});
				return { engine, revision, outcome };
			};
			const referencePath = path.join(await copyStore(base.directory), "store.jsonl");
			const reference = run({ ...base.options, path: referencePath }, undefined);
			expect(reference.outcome.error).toBeUndefined();
			expect(activeSegment(referencePath)).toBe(segment + 1);
			reference.engine.close();
			const total = reference.outcome.mutations;
			// Index and snapshot publications, the sealed link, the segment header publication, the old snapshot
			// removal (segment 1 only) and the frame's own append and fsync.
			expect(total).toBeGreaterThanOrEqual(segment === 0 ? 16 : 18);
			const committed = new Set<number>();
			for (let cut = 0; cut < total; cut++) {
				const directory = await copyStore(base.directory);
				const options = { ...base.options, path: path.join(directory, "store.jsonl") };
				const crashed = run(options, cut);
				expect((crashed.outcome.error as Error | undefined)?.message).toBeDefined();
				// The crashed owner never acknowledges and never continues past the cut.
				expect(() => crashed.engine.recoveryState()).toThrow();
				// Opening repairs the layout; inspect it before any new owner commits (which may rotate again).
				const reopened = new JsonlAuthorityPersistence(options);
				const after = activeSegment(options.path);
				committed.add(after);
				expect([segment, segment + 1]).toContain(after);
				expect(artifactNames(options.path)).toEqual(committedLayout(options.path, after));
				reopened.integrityCheck();
				const recovered = new AuthorityEngine(reopened, "recovering-owner");
				const state = recovered.recover();
				const landed = recovered.resolveReceipt("rotating") !== undefined;
				// Only a cut at the frame's own final fsync can leave the unacknowledged frame on disk.
				if (landed) expect(cut).toBe(total - 1);
				expect(state.revision).toBe(crashed.revision + 2 + (landed ? 1 : 0));
				for (const requestId of base.acknowledged)
					expect(recovered.resolveReceipt(requestId)?.requestId).toBe(requestId);
				terminal(recovered, 2000, "after-recovery");
				recovered.close();
			}
			// Cuts land on both sides of the rotation's commit point.
			expect([...committed].sort()).toEqual([segment, segment + 1]);
		}, 240_000);
	}
});

describe("JSONL legacy and version gate", () => {
	test("a single-file store opens as one sealed history and rotates on its next NEW admission", async () => {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
		};
		const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "legacy-owner");
		engine.recover();
		for (let index = 0; index < 30; index++)
			engine.transition(operation(index, "intent"), { requestId: `legacy-${index}` });
		engine.close();
		const legacyBytes = fsNamespace.readFileSync(options.path);
		const reader = new JsonlAuthorityPersistence({ ...options, create: false });
		const before = reader.exportState();
		reader.close();
		const reopened = new JsonlAuthorityPersistence({ ...options, create: false, jsonlSegment: frameLimits(8) });
		const next = new AuthorityEngine(reopened, "segmented-owner");
		expect(activeSegment(options.path)).toBe(1);
		expect(fsNamespace.readFileSync(jsonlLayout(options.path).segment(0))).toEqual(legacyBytes);
		const after = reopened.exportState();
		expect(after.frames.slice(0, before.frames.length)).toEqual([...before.frames]);
		for (let index = 0; index < 30; index++)
			expect(next.resolveReceipt(`legacy-${index}`)?.requestId).toBe(`legacy-${index}`);
		reopened.integrityCheck();
		next.close();
	});

	test("a seeded single-file store keeps its seed history and foreign receipts through rotation", async () => {
		const directory = await makeDirectory();
		const sourceIdentity = identity();
		const source = new AuthorityEngine(
			new JsonlAuthorityPersistence({
				path: path.join(directory, "source.jsonl"),
				identity: sourceIdentity,
				create: true,
			}),
			"source-owner",
		);
		source.recover();
		for (let index = 0; index < 6; index++) terminal(source, index, `seeded-${index}`);
		const seed = source.exportState();
		source.close();
		const target = identity();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "target.jsonl"),
			identity: target,
			create: true,
			seed: { ...seed, sourceIdentity: target },
			jsonlSegment: frameLimits(3),
		};
		const driver = new JsonlAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "target-owner");
		engine.recover();
		for (let index = 10; index < 20; index++)
			engine.transition(operation(index, "intent"), { requestId: `target-${index}` });
		expect(activeSegment(options.path)).toBeGreaterThan(1);
		const exported = driver.exportState();
		expect(exported.frames.slice(0, seed.frames.length)).toEqual([...seed.frames]);
		// Seed receipts carry the source incarnation; they are found in the sealed index of segment 0.
		const seeded = seed.controls.find(
			control =>
				control.key.startsWith("receipt:") && (control.value as { requestId: string }).requestId === "seeded-3",
		);
		expect(seeded).toBeDefined();
		expect(driver.getControl(seeded!.key)).toEqual(seeded!.value);
		expect(driver.findReceipt("seeded-3", sourceIdentity.incarnation)).toEqual(seeded!.value as never);
		engine.close();
		const reopened = new JsonlAuthorityPersistence({ ...options, create: false });
		const reopenedExport = reopened.exportState();
		expect(reopenedExport.frames.slice(0, exported.frames.length)).toEqual([...exported.frames]);
		expect(
			reopenedExport.controls.filter(
				control => control.key.startsWith("receipt:") && exported.controls.some(other => other.key === control.key),
			),
		).toEqual(exported.controls.filter(control => control.key.startsWith("receipt:")));
		reopened.integrityCheck();
		reopened.close();
	});

	test("a rotated store reopens with its complete history after its files are renamed to another active name", async () => {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "first.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: frameLimits(3),
		};
		const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "owner-token");
		engine.recover();
		for (let index = 0; index < 8; index++) terminal(engine, index, `renamed-${index}`);
		engine.close();
		const reader = new JsonlAuthorityPersistence({ ...options, create: false });
		const before = reader.exportState();
		reader.close();
		const renamed = path.join(directory, "second.jsonl");
		await fs.rename(options.path, renamed);
		for (const artifact of listJsonlRotationArtifacts(options.path))
			await fs.rename(
				artifact.file,
				path.join(directory, path.basename(artifact.file).replace(/^first\./, "second.")),
			);
		expect(listJsonlRotationArtifacts(renamed).length).toBeGreaterThan(2);
		const reopened = new JsonlAuthorityPersistence({ ...options, path: renamed, create: false });
		expect(reopened.exportState()).toEqual(before);
		reopened.integrityCheck();
		reopened.close();
	});

	test("refuses an unknown future header version and a snapshot that does not match its header", async () => {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: frameLimits(3),
		};
		const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "owner-token");
		engine.recover();
		for (let index = 0; index < 4; index++)
			engine.transition(operation(index, "intent"), { requestId: `gate-${index}` });
		engine.close();
		expect(activeSegment(options.path)).toBeGreaterThan(0);
		const reopen = () => new JsonlAuthorityPersistence({ ...options, create: false });
		const snapshot = jsonlLayout(options.path).snapshot(activeSegment(options.path));
		const original = await fs.readFile(snapshot);
		await fs.writeFile(snapshot, Buffer.from(original.toString("utf8").replace('"revision":', '"revision": ')));
		expect(reopen).toThrow("does not match its recorded digest");
		await fs.writeFile(snapshot, original);
		const lines = (await fs.readFile(options.path, "utf8")).split("\n");
		const future = { ...JSON.parse(lines[0]!), version: 4 };
		await fs.writeFile(options.path, [JSON.stringify(future), ...lines.slice(1)].join("\n"), { mode: 0o600 });
		expect(reopen).toThrow("Unsupported authority JSONL header.");
	});
});

describe("JSONL rotation failure before its commit point", () => {
	const steps = [
		[
			"the index publication",
			(layout: ReturnType<typeof jsonlLayout>) => ({ call: "renameSync" as const, target: layout.index(0) }),
		],
		[
			"the snapshot publication",
			(layout: ReturnType<typeof jsonlLayout>) => ({ call: "renameSync" as const, target: layout.snapshot(1) }),
		],
		[
			"the sealed link",
			(layout: ReturnType<typeof jsonlLayout>) => ({ call: "linkSync" as const, target: layout.segment(0) }),
		],
		[
			"the segment header publication",
			(layout: ReturnType<typeof jsonlLayout>) => ({ call: "renameSync" as const, target: layout.active }),
		],
	] as const;

	for (const [name, fault] of steps) {
		test(`a failure at ${name} rolls the rotation back and keeps the store available`, async () => {
			const directory = await makeDirectory();
			const options: AuthorityDriverOptions = {
				path: path.join(directory, "store.jsonl"),
				identity: identity(),
				create: true,
				jsonlSegment: frameLimits(4),
			};
			const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "owner");
			engine.recover();
			// An admitted intent whose continuation must stay possible after the failed rotation.
			engine.transition(operation(0, "intent"), { requestId: "admitted" });
			for (let index = 1; activeFrames(options.path) < 4; index++) terminal(engine, index, `fill-${index}`);
			const { call, target } = fault(jsonlLayout(options.path));
			const original = fsNamespace[call] as (...args: unknown[]) => unknown;
			let injected = 0;
			const spy = spyOn(fsNamespace, call).mockImplementation(((...args: unknown[]) => {
				if (args[1] === target && injected++ === 0)
					throw Object.assign(new Error(`EDQUOT: injected at ${name}`), { code: "EDQUOT" });
				return original(...args);
			}) as never);
			let triggering: unknown;
			try {
				triggering = terminal(engine, 100, "triggering");
			} catch (error) {
				triggering = error;
			} finally {
				spy.mockRestore();
			}
			expect(injected).toBe(1);
			// The rotation is rolled back: no partial artifact, the active inode has one name, and the triggering
			// command commits in the segment that stayed active.
			expect(triggering).not.toBeInstanceOf(Error);
			expect(artifactNames(options.path)).toEqual([]);
			expect(fsNamespace.statSync(options.path).nlink).toBe(1);
			expect(activeSegment(options.path)).toBe(0);
			expect(engine.resolveReceipt("triggering")).toBeDefined();
			// The continuation of the earlier admission still commits; the next admission rotates.
			engine.transition(operation(0, "abandoned"), { requestId: "continuation" });
			terminal(engine, 101, "after");
			expect(activeSegment(options.path)).toBe(1);
			engine.close();
			const reopened = new JsonlAuthorityPersistence({ ...options, create: false });
			reopened.integrityCheck();
			const recovered = new AuthorityEngine(reopened, "reopened");
			recovered.recover();
			for (const requestId of ["admitted", "triggering", "continuation", "after"])
				expect(recovered.resolveReceipt(requestId)?.requestId).toBe(requestId);
			recovered.close();
		});
	}

	test("a header rename that took effect but reported failure keeps the published layout and makes the store unavailable", async () => {
		const directory = await makeDirectory();
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "store.jsonl"),
			identity: identity(),
			create: true,
			jsonlSegment: frameLimits(4),
		};
		const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "owner");
		engine.recover();
		for (let index = 1; activeFrames(options.path) < 4; index++) terminal(engine, index, `fill-${index}`);
		const layout = jsonlLayout(options.path);
		const original = fsNamespace.renameSync;
		let injected = 0;
		const spy = spyOn(fsNamespace, "renameSync").mockImplementation(((
			from: fsNamespace.PathLike,
			to: fsNamespace.PathLike,
		) => {
			original(from, to);
			if (to === layout.active && injected++ === 0)
				throw Object.assign(new Error("EIO: injected after the header rename took effect"), { code: "EIO" });
		}) as typeof original);
		let triggering: unknown;
		try {
			triggering = terminal(engine, 100, "triggering");
		} catch (error) {
			triggering = error;
		} finally {
			spy.mockRestore();
		}
		expect(injected).toBe(1);
		expect(triggering).toBeInstanceOf(Error);
		// The published header names segment 1; its sealed segment, index and snapshot must survive the rollback.
		expect(activeSegment(options.path)).toBe(1);
		expect(artifactNames(options.path)).toEqual(committedLayout(options.path, 1));
		// The reason names the committed rotation, judged from the on-disk header rather than the owner's view.
		expect(String(triggering)).toContain("rotation published its header");
		expect(() => terminal(engine, 101, "after-failure")).toThrow("rotation published its header");
		expect(() => engine.close()).toThrow("rotation published its header");
		const reopened = new JsonlAuthorityPersistence({ ...options, create: false });
		reopened.integrityCheck();
		const recovered = new AuthorityEngine(reopened, "reopened");
		recovered.recover();
		expect(recovered.resolveReceipt("fill-1")?.requestId).toBe("fill-1");
		recovered.close();
	});
});

describe.skipIf(!xfsCapacityHost)("JSONL rotation capacity", () => {
	async function fundedStore(maxFrames: number) {
		const directory = await makeDirectory();
		const capacity = await openAuthorityCapacityFile(directory);
		handles.push(capacity.handle);
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "funded.jsonl"),
			identity: identity(),
			create: true,
			capacity: { identity: capacity.identity, maxRequestBytes: 2_097_152 },
			jsonlSegment: frameLimits(maxFrames),
		};
		const engine = new AuthorityEngine(new JsonlAuthorityPersistence(options), "funded-owner");
		engine.recover();
		return { options, engine, capacity };
	}

	test("funds the rotation files and the fresh segment before writing them", async () => {
		const { options, engine } = await fundedStore(4);
		for (let index = 0; index < 12; index++)
			engine.transition(operation(index, "intent"), { requestId: `funded-${index}` });
		expect(activeSegment(options.path)).toBeGreaterThan(1);
		// Every published rotation file was allocated before it was written: no file has bytes past its allocation.
		for (const artifact of listJsonlRotationArtifacts(options.path)) {
			const stat = fsNamespace.statSync(artifact.file);
			expect(stat.blocks * 512).toBeGreaterThanOrEqual(stat.size);
		}
		engine.close();
		const reopened = new JsonlAuthorityPersistence({ ...options, create: false });
		reopened.integrityCheck();
		reopened.close();
	});

	test("refuses a rotating NEW admission before any rotation write or acknowledgement", async () => {
		const { options, engine, capacity } = await fundedStore(8);
		for (let index = 0; activeFrames(options.path) < 5; index++) terminal(engine, index, `fill-${index}`);
		engine.close();
		// A reopening process starts from an empty reserve and re-funds it; the owner's recovering and ready
		// frames consume its funded episode, and the following NEW admission is the one that rotates.
		const drained = BorrowedAuthorityCapacityPool.open(capacity.identity);
		drained.releaseDataBytes(drained.inspect().dataBytes);
		// Little free space: the mandatory reserve fits, optional pool slack (which could fund a rotation) does not.
		const statfsSync = fsNamespace.statfsSync;
		let freeBytes = 6 * 1_048_576;
		const free = spyOn(fsNamespace, "statfsSync").mockImplementation(((...args: Parameters<typeof statfsSync>) => {
			const stats = statfsSync(...args);
			return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
				bavail: Math.floor(freeBytes / Number(stats.bsize)),
			});
		}) as typeof statfsSync);
		try {
			const reopened = new AuthorityEngine(
				new JsonlAuthorityPersistence({ ...options, create: false }),
				"reopened-owner",
			);
			reopened.recover();
			expect(activeFrames(options.path)).toBe(8);
			const revision = reopened.recoveryState().revision;
			const before = fsNamespace.readFileSync(options.path);
			freeBytes = 0;
			expect(() => terminal(reopened, 500, "refused")).toThrow(AuthorityCapacityRefusedError);
			expect(artifactNames(options.path)).toEqual([]);
			expect(fsNamespace.readFileSync(options.path)).toEqual(before);
			expect(reopened.recoveryState().revision).toBe(revision);
			expect(reopened.resolveReceipt("refused")).toBeUndefined();
			// With capacity available again the same command rotates and commits.
			const actual = statfsSync(directoryOf(options.path));
			freeBytes = Number(actual.bavail) * Number(actual.bsize);
			expect(terminal(reopened, 500, "refused").revision).toBe(revision + 1);
			expect(activeSegment(options.path)).toBe(1);
			reopened.close();
		} finally {
			free.mockRestore();
		}
	});

	test("defers rotation for a command that consumes a funded promise", async () => {
		const { options, engine, capacity } = await fundedStore(4);
		engine.transition(operation(0, "intent"), { requestId: "promised-intent" });
		for (let index = 1; activeFrames(options.path) < 4; index++)
			engine.transition(operation(index, "intent"), { requestId: `fill-${index}` });
		const drained = BorrowedAuthorityCapacityPool.open(capacity.identity);
		const growth = spyOn(BorrowedAuthorityCapacityPool.prototype, "ensureDataBytes").mockImplementation(() => {
			throw new Error("no fresh capacity");
		});
		try {
			expect(drained.inspect().dataBytes).toBeGreaterThan(0);
			// Abandoning an admitted intent consumes the promise its admission funded.
			engine.transition(operation(0, "abandoned"), { requestId: "promised-abandon" });
		} finally {
			growth.mockRestore();
		}
		expect(activeSegment(options.path)).toBe(0);
		expect(artifactNames(options.path)).toEqual([]);
		expect(engine.resolveReceipt("promised-abandon")).toBeDefined();
		engine.close();
	});
});
