import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireAuthorityOwnership,
	authorityPaths,
	withAuthorityRelocationExclusive,
	type AuthorityRelocationLockRequest,
	type AuthorityPhysicalIdentity,
} from "../../src/registry/authority/ownership";
import {
	canonicalDurableSha256,
	durableRootHeadHash,
	RegistryDurableStateStore,
} from "../../src/registry/durable-state";
import { AuthorityCleanupError } from "../../src/registry/authority/private-cleanup";

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-relocation-"));
	directories.push(directory);
	return directory;
}

async function makeSession(directory: string, name: string): Promise<string> {
	const session = path.join(directory, name);
	await fs.writeFile(session, '{"type":"session","id":"root-uuid"}\n', { mode: 0o600 });
	return session;
}

async function makeLegacySession(directory: string, name: string): Promise<string> {
	const session = await makeSession(directory, name);
	const store = new RegistryDurableStateStore(authorityPaths(session).legacy);
	const startupHash = canonicalDurableSha256("Main:startup");
	const provenanceHash = canonicalDurableSha256("Main:provenance");
	const construction = {
		kind: "construction" as const,
		actorId: "Main",
		rootId: "Main",
		generation: 1,
		startupHash,
		provenanceHash,
	};
	const headHash = durableRootHeadHash({
		rootId: "Main",
		generation: 1,
		actorId: "Main",
		startupHash,
		provenanceHash,
	});
	store.append({ ...construction, at: 1, phase: "reserved" });
	store.append({ ...construction, at: 2, phase: "constructing" });
	store.append({ ...construction, at: 3, phase: "constructed" });
	store.append({ kind: "root", at: 4, rootId: "Main", generation: 1, headHash, state: "active" });
	store.append({
		kind: "actor",
		at: 5,
		actorId: "Main",
		rootId: "Main",
		generation: 1,
		rootGeneration: 1,
		rootHeadHash: headHash,
		startupHash,
		provenanceHash,
		state: "active",
	});
	store.append({ ...construction, at: 6, phase: "activated" });
	return session;
}

async function createAnchor(session: string): Promise<AuthorityPhysicalIdentity> {
	const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
	try {
		return ownership.physicalIdentity;
	} finally {
		await ownership.release();
	}
}

function nestedErrors(error: unknown): unknown[] {
	if (!(error instanceof AggregateError)) return [error];
	return [error, ...error.errors.flatMap(nestedErrors)];
}

function relocationRequest(
	sources: AuthorityRelocationLockRequest["sources"],
	target: AuthorityRelocationLockRequest["target"],
	operationId = "relocation-test",
): AuthorityRelocationLockRequest {
	return { owningSessionId: "root-uuid", operationId, sources, target };
}

interface FileHandlePrototype {
	sync(this: fs.FileHandle): Promise<void>;
	stat(this: fs.FileHandle): Promise<fsSync.Stats>;
	close(this: fs.FileHandle): Promise<void>;
}

async function afterFirstHandleSync<T>(
	directory: string,
	effect: () => Promise<void>,
	run: () => Promise<T>,
): Promise<T> {
	const probe = await fs.open(directory, fs.constants.O_RDONLY);
	const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
	const originalSync = prototype.sync;
	await probe.close();
	let triggered = false;
	prototype.sync = async function (this: fs.FileHandle): Promise<void> {
		await originalSync.call(this);
		if (!triggered) {
			triggered = true;
			await effect();
		}
	};
	try {
		const result = await run();
		if (!triggered) throw new Error("The controlled first file-sync race did not occur");
		return result;
	} finally {
		prototype.sync = originalSync;
	}
}

async function afterHandleStat<T>(
	directory: string,
	callNumber: number,
	effect: () => Promise<void>,
	run: () => Promise<T>,
): Promise<T> {
	const probe = await fs.open(directory, fs.constants.O_RDONLY);
	const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
	const originalStat = prototype.stat;
	await probe.close();
	let calls = 0;
	prototype.stat = async function (this: fs.FileHandle): Promise<fsSync.Stats> {
		const stat = await originalStat.call(this);
		calls++;
		if (calls === callNumber) await effect();
		return stat;
	};
	try {
		const result = await run();
		if (calls < callNumber) throw new Error("The controlled endpoint-stat race did not reach acquisition");
		return result;
	} finally {
		prototype.stat = originalStat;
	}
}

function spawnRelocationProcess(
	mode: "hold" | "hold-fail" | "try" | "ordinary-try" | "reserve-target",
	request: AuthorityRelocationLockRequest,
): Bun.PipedSubprocess {
	return Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "authority-relocation-process.ts"), mode, JSON.stringify(request)],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
}

async function readProcessResult(stream: ReadableStream<Uint8Array>): Promise<{
	acquired: boolean;
	error?: string;
	sourceCount?: number;
	targetPhysicalIdentity?: AuthorityPhysicalIdentity;
}> {
	const reader = stream.getReader();
	let output = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`Relocation process exited before reporting: ${output}`);
			output += new TextDecoder().decode(value, { stream: true });
			const newline = output.indexOf("\n");
			if (newline >= 0)
				return JSON.parse(output.slice(0, newline)) as {
					acquired: boolean;
					error?: string;
					sourceCount?: number;
					targetPhysicalIdentity?: AuthorityPhysicalIdentity;
				};
		}
	} finally {
		reader.releaseLock();
	}
}

async function readProcessOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
	// Readiness has already disturbed stdout; another reader can still consume its remainder.
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return output + decoder.decode();
			output += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

async function stopProcess(child: Bun.PipedSubprocess): Promise<void> {
	child.stdin.write("release\n");
	child.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		readProcessOutput(child.stdout),
		readProcessOutput(child.stderr),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Relocation process failed: ${stdout}${stderr}`);
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("grouped authority relocation ownership", () => {
	it("drains reader-consumed readiness output and both release pipes before successful process settlement", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "cleanup-target.jsonl");
		const request = relocationRequest([], { sessionFile: target }, "cleanup-output");
		const owner: Bun.PipedSubprocess = spawnRelocationProcess("hold", request);
		let targetIdentity: AuthorityPhysicalIdentity | undefined;
		try {
			const ready = await readProcessResult(owner.stdout);
			expect(ready).toMatchObject({ acquired: true, sourceCount: 0 });
			targetIdentity = ready.targetPhysicalIdentity;
			expect(owner.stdout.locked).toBe(false);
			expect(owner.exitCode).toBeNull();
		} finally {
			await stopProcess(owner);
		}
		expect(owner.exitCode).toBe(0);
		for (const stream of [owner.stdout, owner.stderr]) {
			const reader = stream.getReader();
			try {
				expect(await reader.read()).toEqual({ done: true, value: undefined });
			} finally {
				reader.releaseLock();
			}
		}
		if (!targetIdentity) throw new Error("Cleanup process omitted its reserved target identity");
		const recoveredIdentity = await withAuthorityRelocationExclusive(
			{
				...request,
				target: { sessionFile: target, expectedPhysicalIdentity: targetIdentity },
			},
			async context => context.target.physicalIdentity,
		);
		expect(recoveredIdentity).toEqual(targetIdentity);
		expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
	});

	it("retains post-readiness stdout and stderr diagnostics for a real nonzero release outcome", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "failed-cleanup-target.jsonl");
		const request = relocationRequest([], { sessionFile: target }, "cleanup-failure-output");
		const owner: Bun.PipedSubprocess = spawnRelocationProcess("hold-fail", request);
		let targetIdentity: AuthorityPhysicalIdentity | undefined;
		try {
			const ready = await readProcessResult(owner.stdout);
			expect(ready).toMatchObject({ acquired: true, sourceCount: 0 });
			targetIdentity = ready.targetPhysicalIdentity;
			expect(owner.exitCode).toBeNull();
		} finally {
			await expect(stopProcess(owner)).rejects.toThrow(
				'Relocation process failed: Relocation locks released\n{"acquired":false,"error":"injected relocation failure after release"}\nRelocation release diagnostics\n',
			);
		}
		expect(owner.exitCode).toBe(1);
		if (!targetIdentity) throw new Error("Failed cleanup process omitted its reserved target identity");
		const recoveredIdentity = await withAuthorityRelocationExclusive(
			{
				...request,
				target: { sessionFile: target, expectedPhysicalIdentity: targetIdentity },
			},
			async context => context.target.physicalIdentity,
		);
		expect(recoveredIdentity).toEqual(targetIdentity);
		expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
	});

	it("creates the first anchor for an existing legacy journal and excludes ordinary processes through callback settlement", async () => {
		const directory = await makeDirectory();
		const source = await makeLegacySession(directory, "legacy-source.jsonl");
		const paths = authorityPaths(source);
		const transcript = await fs.readFile(source);
		const journal = await fs.readFile(paths.legacy);
		expect(await fs.stat(paths.lock).catch(() => undefined)).toBeUndefined();
		const target = path.join(directory, "legacy-target.jsonl");
		let sourceIdentity: AuthorityPhysicalIdentity | undefined;
		let entered = false;
		await withAuthorityRelocationExclusive(
			relocationRequest([{ sessionFile: source }], { sessionFile: target }, "legacy-first-anchor"),
			async context => {
				entered = true;
				sourceIdentity = context.sources[0]?.physicalIdentity;
				const anchor = await fs.lstat(paths.lock);
				expect(sourceIdentity).toEqual({ dev: String(anchor.dev), ino: String(anchor.ino) });
				expect(anchor.isFile()).toBe(true);
				expect(anchor.nlink).toBe(1);
				expect(anchor.mode & 0o077).toBe(0);
				const contender = spawnRelocationProcess(
					"ordinary-try",
					relocationRequest([], { sessionFile: source }, "legacy-ordinary-contender"),
				);
				expect(await readProcessResult(contender.stdout)).toMatchObject({
					acquired: false,
					error: expect.stringMatching(/ownership|flock/i),
				});
				expect(await contender.exited).toBe(0);
				expect(await fs.readFile(paths.legacy)).toEqual(journal);
				expect(await fs.readFile(source)).toEqual(transcript);
			},
		);
		expect(entered).toBe(true);
		const afterRelease = await fs.lstat(paths.lock);
		expect(sourceIdentity).toEqual({ dev: String(afterRelease.dev), ino: String(afterRelease.ino) });
		const after = spawnRelocationProcess(
			"ordinary-try",
			relocationRequest([], { sessionFile: source }, "legacy-after-release"),
		);
		expect(await readProcessResult(after.stdout)).toMatchObject({ acquired: true });
		expect(await after.exited).toBe(0);
		expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
		for (const selected of [paths.descriptor, paths.sqlite, paths.jsonl]) {
			expect(await fs.stat(selected).catch(() => undefined)).toBeUndefined();
		}
	});

	it("does not replace a supplied expected anchor with a legacy first anchor", async () => {
		const directory = await makeDirectory();
		const source = await makeLegacySession(directory, "legacy-expected-anchor.jsonl");
		const target = path.join(directory, "unused-target.jsonl");
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest(
					[{ sessionFile: source, expectedPhysicalIdentity: { dev: "0", ino: "0" } }],
					{ sessionFile: target },
					"legacy-missing-expected-anchor",
				),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/Expected authority relocation anchor is missing/i);
		expect(entered).toBe(false);
		expect(await fs.stat(authorityPaths(source).lock).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(authorityPaths(target).lock).catch(() => undefined)).toBeUndefined();
	});

	it("refuses every selected artifact without an anchor even beside a genuine legacy journal", async () => {
		const directory = await makeDirectory();
		for (const selected of ["descriptor", "sqlite", "jsonl"] as const) {
			const source = await makeLegacySession(directory, `legacy-with-${selected}.jsonl`);
			const paths = authorityPaths(source);
			const evidence = `selected ${selected} evidence\n`;
			await fs.writeFile(paths[selected], evidence, { mode: 0o600 });
			let entered = false;
			await expect(
				withAuthorityRelocationExclusive(
					relocationRequest(
						[{ sessionFile: source }],
						{ sessionFile: path.join(directory, `${selected}-target.jsonl`) },
						`missing-${selected}-anchor`,
					),
					async () => {
						entered = true;
					},
				),
			).rejects.toThrow(/artifacts exist without their persistent lock anchor/i);
			expect(entered).toBe(false);
			expect(await fs.stat(paths.lock).catch(() => undefined)).toBeUndefined();
			expect(await fs.readFile(paths[selected], "utf8")).toBe(evidence);
		}
	});

	it("refuses unexplained stages, migration, backups, quarantine and other siblings beside an anchorless legacy journal", async () => {
		const directory = await makeDirectory();
		const suffixes = [
			".authority.stage.legacy-unexplained",
			".authority.migration.other.json",
			".authority.backup.other",
			".authority-v1.jsonl.quarantine",
			".authority.json.tmp-other",
			".authority.unexplained",
		];
		for (const [index, suffix] of suffixes.entries()) {
			const source = await makeLegacySession(directory, `ambiguous-legacy-${index}.jsonl`);
			const artifact = `${source}${suffix}`;
			const isDirectory = suffix.includes(".stage.") || suffix.includes(".backup.");
			if (isDirectory) {
				await fs.mkdir(artifact, { mode: 0o700 });
				await fs.writeFile(path.join(artifact, "evidence.json"), "unexplained provenance\n", { mode: 0o600 });
			} else {
				await fs.writeFile(artifact, "unexplained provenance\n", { mode: 0o600 });
			}
			let entered = false;
			await expect(
				withAuthorityRelocationExclusive(
					relocationRequest(
						[{ sessionFile: source }],
						{ sessionFile: path.join(directory, `ambiguous-target-${index}.jsonl`) },
						"legacy-unexplained",
					),
					async () => {
						entered = true;
					},
				),
			).rejects.toThrow(/artifacts exist without their persistent lock anchor/i);
			expect(entered).toBe(false);
			expect(await fs.stat(authorityPaths(source).lock).catch(() => undefined)).toBeUndefined();
			expect(await fs.readFile(isDirectory ? path.join(artifact, "evidence.json") : artifact, "utf8")).toBe(
				"unexplained provenance\n",
			);
		}
	});

	it("never bootstraps a missing recovery source from its retained legacy journal", async () => {
		const directory = await makeDirectory();
		const source = await makeLegacySession(directory, "absent-legacy-source.jsonl");
		await fs.unlink(source);
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest(
					[{ sessionFile: source }],
					{ sessionFile: path.join(directory, "unused-target.jsonl") },
					"absent-legacy-source",
				),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/artifacts exist without their persistent lock anchor/i);
		expect(entered).toBe(false);
		expect(await fs.stat(authorityPaths(source).lock).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
	});

	it("holds an existing source and reserves an absent target across processes without creating a target transcript", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const alias = path.join(directory, "source-alias.jsonl");
		await fs.symlink(source, alias);
		const target = path.join(directory, "target.jsonl");
		const ordinary = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid", create: true });
		const sourceIdentity = ordinary.physicalIdentity;
		await ordinary.release();
		const request: AuthorityRelocationLockRequest = {
			owningSessionId: "root-uuid",
			operationId: "relocation-1",
			sources: [
				{ sessionFile: alias, expectedPhysicalIdentity: sourceIdentity },
				{ sessionFile: source, expectedPhysicalIdentity: sourceIdentity },
			],
			target: { sessionFile: target },
		};
		const owner = spawnRelocationProcess("hold", request);
		try {
			const ownerResult = await readProcessResult(owner.stdout);
			expect(ownerResult).toMatchObject({ acquired: true });
			if (!ownerResult.targetPhysicalIdentity)
				throw new Error("Relocation process omitted its reserved target identity");
			const ordinaryContender = spawnRelocationProcess("ordinary-try", {
				...request,
				target: { sessionFile: source },
				sources: [],
			});
			expect(await readProcessResult(ordinaryContender.stdout)).toMatchObject({ acquired: false });
			expect(await ordinaryContender.exited).toBe(0);
			expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
			const anchor = authorityPaths(target).lock;
			expect((await fs.stat(anchor)).isFile()).toBe(true);
			const duplicateUuid = spawnRelocationProcess("try", {
				...request,
				target: { sessionFile: target, expectedPhysicalIdentity: ownerResult.targetPhysicalIdentity },
			});
			expect(await readProcessResult(duplicateUuid.stdout)).toMatchObject({ acquired: false });
			expect(await duplicateUuid.exited).toBe(0);
		} finally {
			await stopProcess(owner);
		}
		const afterRelease = await fs.stat(authorityPaths(target).lock);
		expect(afterRelease.isFile()).toBe(true);
		expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
	});

	it("reserves an absent target anchor against another process independently of source locks", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "reserved-target.jsonl");
		const request: AuthorityRelocationLockRequest = {
			owningSessionId: "root-uuid",
			operationId: "target-only-reservation",
			sources: [],
			target: { sessionFile: target },
		};
		const owner = spawnRelocationProcess("reserve-target", request);
		try {
			const ownerResult = await readProcessResult(owner.stdout);
			expect(ownerResult).toMatchObject({ acquired: true });
			if (!ownerResult.targetPhysicalIdentity) throw new Error("Target reservation omitted its anchor identity");
			const contender = spawnRelocationProcess("try", {
				...request,
				target: { sessionFile: target, expectedPhysicalIdentity: ownerResult.targetPhysicalIdentity },
			});
			expect(await readProcessResult(contender.stdout)).toMatchObject({
				acquired: false,
				error: expect.stringMatching(/flock|ownership/i),
			});
			expect(await contender.exited).toBe(0);
			expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
		} finally {
			await stopProcess(owner);
		}
		expect((await fs.stat(authorityPaths(target).lock)).isFile()).toBe(true);
	});
	it("deduplicates physical source aliases and reports stable canonical contexts", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const alias = path.join(directory, "source-alias.jsonl");
		await fs.symlink(source, alias);
		const ownership = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid", create: true });
		const expected = ownership.physicalIdentity;
		await ownership.release();
		const target = path.join(directory, "target.jsonl");
		const result = await withAuthorityRelocationExclusive(
			{
				owningSessionId: "root-uuid",
				operationId: "alias-relocation",
				sources: [
					{ sessionFile: alias, expectedPhysicalIdentity: expected },
					{ sessionFile: source, expectedPhysicalIdentity: expected },
				],
				target: { sessionFile: target },
			},
			async context => ({
				sourceCount: context.sources.length,
				sourceFile: context.sources[0]?.sessionFile,
				targetFile: context.target.sessionFile,
				operationId: context.operationId,
			}),
		);
		expect(result).toEqual({
			sourceCount: 1,
			sourceFile: source,
			targetFile: target,
			operationId: "alias-relocation",
		});
	});

	it("requires exact pre-existing anchor evidence for an absent recovery source", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "recovery.jsonl");
		const ownership = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid", create: true });
		const identity = ownership.physicalIdentity;
		await ownership.release();
		await fs.unlink(source);
		const target = await makeSession(directory, "recovered.jsonl");
		const targetOwnership = await acquireAuthorityOwnership(target, { owningSessionId: "root-uuid", create: true });
		const targetIdentity = targetOwnership.physicalIdentity;
		await targetOwnership.release();
		const result = await withAuthorityRelocationExclusive(
			{
				owningSessionId: "root-uuid",
				operationId: "recover-source",
				sources: [{ sessionFile: source, expectedPhysicalIdentity: identity }],
				target: { sessionFile: target, expectedPhysicalIdentity: targetIdentity },
			},
			async context => context.sources.length,
		);
		expect(result).toBe(1);
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
	});

	it("accepts exact missing-source recovery evidence in a separate process without synthesizing a transcript", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "recovery-source.jsonl");
		const sourceOwnership = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid", create: true });
		const sourceIdentity = sourceOwnership.physicalIdentity;
		await sourceOwnership.release();
		await fs.unlink(source);
		const target = await makeSession(directory, "recovery-target.jsonl");
		const targetOwnership = await acquireAuthorityOwnership(target, { owningSessionId: "root-uuid", create: true });
		const targetIdentity = targetOwnership.physicalIdentity;
		await targetOwnership.release();
		const request: AuthorityRelocationLockRequest = {
			owningSessionId: "root-uuid",
			operationId: "cross-process-recovery",
			sources: [{ sessionFile: source, expectedPhysicalIdentity: sourceIdentity }],
			target: { sessionFile: target, expectedPhysicalIdentity: targetIdentity },
		};
		const recovery = spawnRelocationProcess("hold", request);
		try {
			expect(await readProcessResult(recovery.stdout)).toMatchObject({ acquired: true });
			expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
			const wrongAnchor = spawnRelocationProcess("try", {
				...request,
				sources: [{ sessionFile: source, expectedPhysicalIdentity: { dev: "0", ino: "0" } }],
			});
			expect(await readProcessResult(wrongAnchor.stdout)).toMatchObject({
				acquired: false,
				error: expect.stringMatching(/identity|anchor/i),
			});
			expect(await wrongAnchor.exited).toBe(0);
		} finally {
			await stopProcess(recovery);
		}
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
	});
	it("admits an absent source's exact same-operation guard only for lifecycle provenance validation", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "guarded-source.jsonl");
		const identity = await createAnchor(source);
		const operationId = "source-recovery";
		const stage = `${source}.authority.stage.${operationId}`;
		await fs.mkdir(stage, { mode: 0o700 });
		await fs.writeFile(path.join(stage, "guard.json"), "source guard provenance\n", { mode: 0o600 });
		await fs.unlink(source);
		const target = await makeSession(directory, "guarded-target.jsonl");
		const targetIdentity = await createAnchor(target);
		const request = relocationRequest(
			[{ sessionFile: source, expectedPhysicalIdentity: identity }],
			{ sessionFile: target, expectedPhysicalIdentity: targetIdentity },
			operationId,
		);
		let entered = false;
		const provenanceFailure = new Error("source guard provenance rejected by lifecycle");
		await expect(
			withAuthorityRelocationExclusive(request, async context => {
				entered = true;
				expect(context.sources[0]?.physicalIdentity).toEqual(identity);
				expect(await fs.readFile(path.join(stage, "guard.json"), "utf8")).toBe("source guard provenance\n");
				throw provenanceFailure;
			}),
		).rejects.toBe(provenanceFailure);
		expect(entered).toBe(true);
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		entered = false;
		const refuse = async (candidate: AuthorityRelocationLockRequest) => {
			await expect(
				withAuthorityRelocationExclusive(candidate, async () => {
					entered = true;
				}),
			).rejects.toThrow(/anchor|identity|stage|artifact/i);
			expect(entered).toBe(false);
		};
		await refuse(relocationRequest([{ sessionFile: source }], request.target, operationId));
		await refuse(
			relocationRequest(
				[{ sessionFile: source, expectedPhysicalIdentity: { dev: "0", ino: "0" } }],
				request.target,
				operationId,
			),
		);
		await refuse({ ...request, operationId: "other-operation" });
		await fs.mkdir(`${source}.authority.stage.other-operation`, { mode: 0o700 });
		await refuse(request);
		await fs.rm(`${source}.authority.stage.other-operation`, { recursive: true });
		for (const artifact of [authorityPaths(source).descriptor, authorityPaths(source).jsonl]) {
			await fs.writeFile(artifact, "unexplained\n", { mode: 0o600 });
			await refuse(request);
			await fs.unlink(artifact);
		}
		await fs.unlink(authorityPaths(source).lock);
		await refuse(request);
	});

	it("refuses an absent target with unexplained authority artifacts and preserves evidence", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "ambiguous-target.jsonl");
		const descriptor = authorityPaths(target).descriptor;
		const evidence = "unexplained descriptor evidence\n";
		await fs.writeFile(descriptor, evidence, { mode: 0o600 });
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				{
					owningSessionId: "root-uuid",
					operationId: "ambiguous-target",
					sources: [],
					target: { sessionFile: target },
				},
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/artifact|anchor/i);
		expect(entered).toBe(false);
		expect(await fs.readFile(descriptor, "utf8")).toBe(evidence);
		expect(await fs.stat(authorityPaths(target).lock).catch(() => undefined)).toBeUndefined();
	});
	it("validates endpoint identities before opening any group lock", async () => {
		const directory = await makeDirectory();
		const validSource = await makeSession(directory, "valid-source.jsonl");
		const invalidTarget = path.join(directory, "invalid-target.jsonl");
		await fs.writeFile(invalidTarget, '{"type":"session","id":"other-root"}\n', { mode: 0o600 });
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest([{ sessionFile: validSource }], { sessionFile: invalidTarget }, "endpoint-preflight"),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/UUID mismatch/i);
		expect(entered).toBe(false);
		expect(await fs.stat(authorityPaths(validSource).lock).catch(() => undefined)).toBeUndefined();
	});
	it("rejects mismatched UUID and physical identities before invoking the callback", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const target = path.join(directory, "target.jsonl");
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				{
					owningSessionId: "wrong-uuid",
					operationId: "wrong-owner",
					sources: [{ sessionFile: source }],
					target: { sessionFile: target },
				},
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/UUID|session/i);
		expect(entered).toBe(false);
		await expect(
			withAuthorityRelocationExclusive(
				{
					owningSessionId: "root-uuid",
					operationId: "wrong-anchor",
					sources: [{ sessionFile: source, expectedPhysicalIdentity: { dev: "0", ino: "0" } }],
					target: { sessionFile: target },
				},
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/identity|anchor/i);
		expect(entered).toBe(false);
		expect(await fs.stat(authorityPaths(target).descriptor).catch(() => undefined)).toBeUndefined();
		const ownership = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid", create: true });
		await ownership.release();
	});

	it("releases grouped locks after callback rejection and recovers the exact reserved target anchor", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const target = path.join(directory, "target.jsonl");
		const failure = new Error("relocation callback failed");
		let reservedTargetIdentity: AuthorityPhysicalIdentity | undefined;
		await expect(
			withAuthorityRelocationExclusive(
				{
					owningSessionId: "root-uuid",
					operationId: "callback-failure",
					sources: [{ sessionFile: source }],
					target: { sessionFile: target },
				},
				async context => {
					reservedTargetIdentity = context.target.physicalIdentity;
					throw failure;
				},
			),
		).rejects.toBe(failure);
		const ownership = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" });
		await ownership.release();
		if (!reservedTargetIdentity) throw new Error("The failed relocation did not report its reserved target anchor");
		await expect(
			withAuthorityRelocationExclusive(
				{
					owningSessionId: "root-uuid",
					operationId: "callback-failure",
					sources: [{ sessionFile: source }],
					target: { sessionFile: target },
				},
				async () => undefined,
			),
		).rejects.toThrow(/exact expected anchor identity/i);
		const result = await withAuthorityRelocationExclusive(
			{
				owningSessionId: "root-uuid",
				operationId: "callback-failure",
				sources: [{ sessionFile: source }],
				target: { sessionFile: target, expectedPhysicalIdentity: reservedTargetIdentity },
			},
			async () => "released",
		);
		expect(result).toBe("released");
	});

	it("deduplicates whole-directory aliases only after resolving their shared sibling anchor", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const aliasDirectory = path.join(directory, "whole-directory-alias");
		await fs.symlink(directory, aliasDirectory, "dir");
		const alias = path.join(aliasDirectory, path.basename(source));
		const expected = await createAnchor(source);
		const result = await withAuthorityRelocationExclusive(
			relocationRequest(
				[
					{ sessionFile: alias, expectedPhysicalIdentity: expected },
					{ sessionFile: source, expectedPhysicalIdentity: expected },
				],
				{ sessionFile: path.join(directory, "target.jsonl") },
				"whole-directory-alias",
			),
			async context => context.sources.map(item => item.sessionFile),
		);
		expect(result).toEqual([source]);
	});

	it("holds distinct same-UUID sources and target in one actual process group", async () => {
		const directory = await makeDirectory();
		const firstSource = await makeSession(directory, "first-source.jsonl");
		const secondSource = await makeSession(directory, "second-source.jsonl");
		const target = await makeSession(directory, "existing-target.jsonl");
		const firstIdentity = await createAnchor(firstSource);
		const secondIdentity = await createAnchor(secondSource);
		const targetIdentity = await createAnchor(target);
		const request = relocationRequest(
			[
				{ sessionFile: firstSource, expectedPhysicalIdentity: firstIdentity },
				{ sessionFile: secondSource, expectedPhysicalIdentity: secondIdentity },
			],
			{ sessionFile: target, expectedPhysicalIdentity: targetIdentity },
			"distinct-process-group",
		);
		const owner = spawnRelocationProcess("hold", request);
		try {
			const result = await readProcessResult(owner.stdout);
			expect(result).toMatchObject({ acquired: true, sourceCount: 2 });
			for (const endpoint of [secondSource, target]) {
				const contender = spawnRelocationProcess(
					"try",
					relocationRequest([], { sessionFile: endpoint }, "distinct-contender"),
				);
				expect(await readProcessResult(contender.stdout)).toMatchObject({ acquired: false });
				expect(await contender.exited).toBe(0);
			}
		} finally {
			await stopProcess(owner);
		}
	});

	it("reserves the UUID synchronously while grouped endpoint acquisition is pending", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const firstTarget = path.join(directory, "first-target.jsonl");
		const secondTarget = path.join(directory, "second-target.jsonl");
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const first = withAuthorityRelocationExclusive(
			relocationRequest([{ sessionFile: source }], { sessionFile: firstTarget }, "awaiting-acquisition"),
			async () => {
				entered.resolve();
				await finish.promise;
			},
		);
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest([], { sessionFile: secondTarget }, "same-process-contender"),
				async () => undefined,
			),
		).rejects.toThrow(/already held/i);
		await entered.promise;
		finish.resolve();
		await first;
	});

	it("refuses grouped acquisition while an ordinary owner already holds the UUID", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const ordinary = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid", create: true });
		let entered = false;
		try {
			await expect(
				withAuthorityRelocationExclusive(
					relocationRequest(
						[{ sessionFile: source }],
						{ sessionFile: path.join(directory, "target.jsonl") },
						"ordinary-owner-held",
					),
					async () => {
						entered = true;
					},
				),
			).rejects.toThrow(/already held/i);
			expect(entered).toBe(false);
		} finally {
			await ordinary.release();
		}
	});

	it("refuses absent sources without exact existing anchors and refuses missing recovery anchors", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "missing-source.jsonl");
		const identity = await createAnchor(source);
		await fs.unlink(source);
		const target = path.join(directory, "unused-target.jsonl");
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest([{ sessionFile: source }], { sessionFile: target }, "absent-source-no-anchor"),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/expected anchor identity/i);
		expect(entered).toBe(false);
		await fs.unlink(authorityPaths(source).lock);
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest(
					[{ sessionFile: source, expectedPhysicalIdentity: identity }],
					{ sessionFile: target },
					"absent-source-missing-anchor",
				),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/anchor/i);
		expect(entered).toBe(false);
		expect(await fs.stat(authorityPaths(source).lock).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(authorityPaths(target).lock).catch(() => undefined)).toBeUndefined();
	});

	it("admits only exact same-operation target stage recovery with the existing anchor", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "staged-target.jsonl");
		const operationId = "same-operation";
		let identity: AuthorityPhysicalIdentity | undefined;
		await withAuthorityRelocationExclusive(
			relocationRequest([], { sessionFile: target }, operationId),
			async context => {
				identity = context.target.physicalIdentity;
			},
		);
		if (!identity) throw new Error("Initial target reservation omitted its physical identity");
		const stage = `${target}.authority.stage.${operationId}`;
		await fs.mkdir(stage, { mode: 0o700 });
		await fs.writeFile(path.join(stage, "guard.json"), "same-operation relocation guard\n", { mode: 0o600 });
		await fs.writeFile(path.join(stage, "manifest.json"), "opaque manifest owned by lifecycle recovery\n", {
			mode: 0o600,
		});
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(relocationRequest([], { sessionFile: target }, operationId), async () => {
				entered = true;
			}),
		).rejects.toThrow(/stage|artifact|anchor/i);
		expect(entered).toBe(false);
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest(
					[],
					{ sessionFile: target, expectedPhysicalIdentity: { dev: "0", ino: "0" } },
					operationId,
				),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/identity|anchor/i);
		expect(entered).toBe(false);
		const provenanceFailure = new Error("Lifecycle manifest provenance validation refused recovery");
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest([], { sessionFile: target, expectedPhysicalIdentity: identity }, operationId),
				async () => {
					entered = true;
					throw provenanceFailure;
				},
			),
		).rejects.toBe(provenanceFailure);
		expect(entered).toBe(true);
	});

	it("rejects unrelated stages and unexplained artifacts despite a matching target anchor", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "staged-target.jsonl");
		let identity: AuthorityPhysicalIdentity | undefined;
		await withAuthorityRelocationExclusive(
			relocationRequest([], { sessionFile: target }, "stage-anchor-setup"),
			async context => {
				identity = context.target.physicalIdentity;
			},
		);
		if (!identity) throw new Error("Target reservation omitted its expected anchor identity");
		const expectedStage = `${target}.authority.stage.expected-operation`;
		await fs.mkdir(expectedStage, { mode: 0o700 });
		await fs.writeFile(path.join(expectedStage, "manifest.json"), "opaque provenance\n", { mode: 0o600 });
		await fs.mkdir(`${target}.authority.stage.other-operation`, { mode: 0o700 });
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest([], { sessionFile: target, expectedPhysicalIdentity: identity }, "expected-operation"),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/stage|artifact/i);
		expect(entered).toBe(false);
		await fs.rm(`${target}.authority.stage.other-operation`, { recursive: true });
		await fs.writeFile(authorityPaths(target).descriptor, "arbitrary descriptor\n", { mode: 0o600 });
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest([], { sessionFile: target, expectedPhysicalIdentity: identity }, "expected-operation"),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/stage|artifact/i);
		expect(entered).toBe(false);
		await fs.rm(authorityPaths(target).descriptor);
		await fs.writeFile(authorityPaths(target).jsonl, "unselected payload\n", { mode: 0o600 });
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest([], { sessionFile: target, expectedPhysicalIdentity: identity }, "expected-operation"),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/stage|artifact/i);
		expect(entered).toBe(false);
	});
	it("refuses a wrong-UUID transcript published during absent-target anchor acquisition", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "raced-target.jsonl");
		let entered = false;
		await afterFirstHandleSync(
			directory,
			() => fs.writeFile(target, '{"type":"session","id":"other-root"}\n', { mode: 0o600 }),
			async () => {
				await expect(
					withAuthorityRelocationExclusive(
						relocationRequest([], { sessionFile: target }, "wrong-transcript-race"),
						async () => {
							entered = true;
						},
					),
				).rejects.toThrow(/appeared|changed|UUID|regular/i);
			},
		);
		expect(entered).toBe(false);
		expect((await fs.readFile(target, "utf8")).includes("other-root")).toBe(true);
	});

	it("refuses a symlink published during absent-target anchor acquisition", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "raced-symlink-target.jsonl");
		const linked = await makeSession(directory, "linked-transcript.jsonl");
		let entered = false;
		await afterFirstHandleSync(
			directory,
			() => fs.symlink(linked, target),
			async () => {
				await expect(
					withAuthorityRelocationExclusive(
						relocationRequest([], { sessionFile: target }, "symlink-race"),
						async () => {
							entered = true;
						},
					),
				).rejects.toThrow(/appeared|changed|regular|symbolic/i);
			},
		);
		expect(entered).toBe(false);
		expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
	});
	it("rechecks an absent recovery source after locking its exact existing anchor", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "raced-recovery-source.jsonl");
		const sourceIdentity = await createAnchor(source);
		await fs.unlink(source);
		const target = await makeSession(directory, "recovery-target.jsonl");
		const targetIdentity = await createAnchor(target);
		let entered = false;
		await afterHandleStat(
			directory,
			2,
			() => fs.writeFile(source, '{"type":"session","id":"other-root"}\n', { mode: 0o600 }),
			async () => {
				await expect(
					withAuthorityRelocationExclusive(
						relocationRequest(
							[{ sessionFile: source, expectedPhysicalIdentity: sourceIdentity }],
							{ sessionFile: target, expectedPhysicalIdentity: targetIdentity },
							"absent-source-publication-race",
						),
						async () => {
							entered = true;
						},
					),
				).rejects.toThrow(/UUID mismatch|identity changed/i);
			},
		);
		expect(entered).toBe(false);
	});

	it("ties discovered endpoint identity to the transcript actually acquired", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "replaced-source.jsonl");
		await createAnchor(source);
		let entered = false;
		await afterHandleStat(
			directory,
			2,
			async () => {
				await fs.rename(source, `${source}.displaced`);
				await fs.writeFile(source, '{"type":"session","id":"root-uuid"}\n', { mode: 0o600 });
			},
			async () => {
				await expect(
					withAuthorityRelocationExclusive(
						relocationRequest(
							[{ sessionFile: source }],
							{ sessionFile: path.join(directory, "target.jsonl") },
							"endpoint-identity-race",
						),
						async () => {
							entered = true;
						},
					),
				).rejects.toThrow(/identity changed|endpoint changed|transcript identity/i);
			},
		);
		expect(entered).toBe(false);
		const ownership = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" });
		await ownership.release();
	});

	it("refuses hard-linked transcript aliases instead of redirecting between sibling anchors", async () => {
		const directory = await makeDirectory();
		const sourceDirectory = path.join(directory, "source-bundle");
		const aliasDirectory = path.join(directory, "alias-bundle");
		await fs.mkdir(sourceDirectory, { mode: 0o700 });
		await fs.mkdir(aliasDirectory, { mode: 0o700 });
		const source = await makeSession(sourceDirectory, "root.jsonl");
		await createAnchor(source);
		const alias = path.join(aliasDirectory, "root.jsonl");
		await fs.link(source, alias);
		await fs.writeFile(authorityPaths(alias).lock, "separate sibling anchor\n", { mode: 0o600 });
		let entered = false;
		await expect(
			withAuthorityRelocationExclusive(
				relocationRequest(
					[{ sessionFile: source }, { sessionFile: alias }],
					{ sessionFile: path.join(directory, "unused-target.jsonl") },
					"unsupported-transcript-alias",
				),
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow(/singly linked|identity|anchor/i);
		expect(entered).toBe(false);
	});

	it("preserves target acquisition failure while closing earlier source locks", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "source.jsonl");
		const sourceIdentity = await createAnchor(source);
		const target = path.join(directory, "contended-target.jsonl");
		const owner = spawnRelocationProcess(
			"reserve-target",
			relocationRequest([], { sessionFile: target }, "target-anchor-only"),
		);
		const probe = await fs.open(directory, fs.constants.O_RDONLY);
		const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
		const originalClose = prototype.close;
		await probe.close();
		const cleanupFailure = new Error("injected earlier source-anchor close failure");
		let cleanupFailed = false;
		let caught: unknown;
		prototype.close = async function (this: fs.FileHandle): Promise<void> {
			const descriptorPath = await fs.readlink(`/proc/self/fd/${this.fd}`).catch(() => undefined);
			await originalClose.call(this);
			if (!cleanupFailed && descriptorPath === authorityPaths(source).lock) {
				cleanupFailed = true;
				throw cleanupFailure;
			}
		};
		try {
			const ownerResult = await readProcessResult(owner.stdout);
			if (!ownerResult.targetPhysicalIdentity) throw new Error("Target process omitted its anchor identity");
			try {
				await withAuthorityRelocationExclusive(
					relocationRequest(
						[{ sessionFile: source, expectedPhysicalIdentity: sourceIdentity }],
						{ sessionFile: target, expectedPhysicalIdentity: ownerResult.targetPhysicalIdentity },
						"later-anchor-acquisition-failure",
					),
					async () => undefined,
				);
			} catch (error) {
				caught = error;
			}
			const errors = nestedErrors(caught);
			expect(
				errors.some(error => error instanceof Error && /acquire authority filesystem flock/i.test(error.message)),
			).toBe(true);
			expect(errors).toContain(cleanupFailure);
			expect(cleanupFailed).toBe(true);
			if (!(caught instanceof AuthorityCleanupError))
				throw new Error("Expected retained acquisition cleanup ownership");
			expect(caught.pending).toBe(true);
			await expect(acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" })).rejects.toThrow(
				/already held/i,
			);
		} finally {
			prototype.close = originalClose;
			try {
				if (caught instanceof AuthorityCleanupError) await caught.cleanup();
			} finally {
				await stopProcess(owner);
			}
		}
		const ordinary = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" });
		await ordinary.release();
	});
	it("preserves header inspection and close failures after transcript flock acquisition", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "header-fault-source.jsonl");
		const identity = await createAnchor(source);
		const target = path.join(directory, "header-fault-target.jsonl");
		const probe = await fs.open(directory, fs.constants.O_RDONLY);
		const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
		const originalStat = prototype.stat;
		const originalClose = prototype.close;
		await probe.close();
		const inspectionFailure = new Error("injected header stat failure");
		const closeFailure = new Error("injected header close failure");
		let sourceStats = 0;
		let failedHandle: fs.FileHandle | undefined;
		let closed = false;
		prototype.stat = async function (this: fs.FileHandle): Promise<fsSync.Stats> {
			const descriptorPath = await fs.readlink(`/proc/self/fd/${this.fd}`).catch(() => undefined);
			if (descriptorPath === source && ++sourceStats === 5) {
				failedHandle = this;
				throw inspectionFailure;
			}
			return originalStat.call(this);
		};
		prototype.close = async function (this: fs.FileHandle): Promise<void> {
			await originalClose.call(this);
			if (this === failedHandle) {
				closed = true;
				throw closeFailure;
			}
		};
		let caught: unknown;
		let entered = false;
		try {
			await withAuthorityRelocationExclusive(
				relocationRequest(
					[{ sessionFile: source, expectedPhysicalIdentity: identity }],
					{ sessionFile: target },
					"header-fault",
				),
				async () => {
					entered = true;
				},
			);
		} catch (error) {
			caught = error;
		} finally {
			prototype.stat = originalStat;
			prototype.close = originalClose;
		}
		expect(sourceStats).toBe(5);
		expect(closed).toBe(true);
		expect(entered).toBe(false);
		expect(caught).toBeInstanceOf(AggregateError);
		if (!(caught instanceof AuthorityCleanupError))
			throw new Error("Expected retained header inspection cleanup ownership");
		try {
			expect(caught.errors).toEqual([inspectionFailure, closeFailure]);
			expect(caught.cause).toBe(inspectionFailure);
			expect(caught.pending).toBe(true);
			await expect(acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" })).rejects.toThrow(
				/already held/i,
			);
		} finally {
			await caught.cleanup();
		}
		expect(caught.pending).toBe(false);
		const ordinary = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" });
		await ordinary.release();
		await withAuthorityRelocationExclusive(
			relocationRequest(
				[{ sessionFile: source, expectedPhysicalIdentity: identity }],
				{ sessionFile: target },
				"header-fault",
			),
			async () => "reacquired",
		);
	});

	it("preserves a primary anchor-directory sync failure and its directory close failure", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "sync-failure-target.jsonl");
		const probe = await fs.open(directory, fs.constants.O_RDONLY);
		const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
		const originalSync = prototype.sync;
		const originalClose = prototype.close;
		await probe.close();
		const syncFailure = new Error("injected authority anchor directory sync failure");
		const closeFailure = new Error("injected authority anchor directory close failure");
		let syncCalls = 0;
		let directoryCloseFailed = false;
		prototype.sync = async function (this: fs.FileHandle): Promise<void> {
			syncCalls++;
			if (syncCalls === 2) throw syncFailure;
			await originalSync.call(this);
		};
		prototype.close = async function (this: fs.FileHandle): Promise<void> {
			const descriptorPath = await fs.readlink(`/proc/self/fd/${this.fd}`).catch(() => undefined);
			await originalClose.call(this);
			if (!directoryCloseFailed && descriptorPath === directory) {
				directoryCloseFailed = true;
				throw closeFailure;
			}
		};
		let caught: unknown;
		try {
			await withAuthorityRelocationExclusive(
				relocationRequest([], { sessionFile: target }, "sync-and-close-fault"),
				async () => undefined,
			);
		} catch (error) {
			caught = error;
		} finally {
			prototype.sync = originalSync;
			prototype.close = originalClose;
		}
		expect(caught).toBeInstanceOf(AggregateError);
		if (!(caught instanceof AuthorityCleanupError))
			throw new Error("Expected retained anchor directory cleanup ownership");
		try {
			expect(caught.errors[0]).toBe(syncFailure);
			expect(caught.errors[1]).toBe(closeFailure);
			expect(caught.cause).toBe(syncFailure);
			expect(directoryCloseFailed).toBe(true);
			expect(caught.pending).toBe(true);
			await expect(
				withAuthorityRelocationExclusive(
					relocationRequest([], { sessionFile: target }, "sync-and-close-held"),
					async () => undefined,
				),
			).rejects.toThrow(/already held/i);
		} finally {
			await caught.cleanup();
		}
		expect(caught.pending).toBe(false);
		const stat = await fs.stat(authorityPaths(target).lock);
		await withAuthorityRelocationExclusive(
			relocationRequest(
				[],
				{
					sessionFile: target,
					expectedPhysicalIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
				},
				"sync-and-close-fault",
			),
			async () => "recovered",
		);
	});

	it("preserves post-close error evidence after kernel exclusion is already released", async () => {
		const directory = await makeDirectory();
		const target = path.join(directory, "close-failure-target.jsonl");
		const probe = await fs.open(directory, fs.constants.O_RDONLY);
		const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
		const originalClose = prototype.close;
		await probe.close();
		const closeFailure = new Error("injected authority lock close failure");
		let injected = false;
		let identity: AuthorityPhysicalIdentity | undefined;
		prototype.close = async function (this: fs.FileHandle): Promise<void> {
			const descriptorPath = await fs.readlink(`/proc/self/fd/${this.fd}`).catch(() => undefined);
			await originalClose.call(this);
			if (!injected && descriptorPath === authorityPaths(target).lock) {
				injected = true;
				throw closeFailure;
			}
		};
		let caught: unknown;
		try {
			await withAuthorityRelocationExclusive(
				relocationRequest([], { sessionFile: target }, "close-fault"),
				async context => {
					identity = context.target.physicalIdentity;
				},
			);
		} catch (error) {
			caught = error;
		} finally {
			prototype.close = originalClose;
		}
		expect(injected).toBe(true);
		if (!(caught instanceof AuthorityCleanupError))
			throw new Error("Expected retained grouped-close cleanup ownership");
		try {
			expect(nestedErrors(caught).filter(error => !(error instanceof AggregateError))).toEqual([closeFailure]);
			if (!identity) throw new Error("Post-close callback omitted the reserved target identity");
			const probe = spawnRelocationProcess(
				"try",
				relocationRequest([], { sessionFile: target, expectedPhysicalIdentity: identity }, "post-close-released"),
			);
			const acquired = await readProcessResult(probe.stdout);
			expect(await probe.exited).toBe(0);
			expect(acquired).toMatchObject({ acquired: true, targetPhysicalIdentity: identity });
		} finally {
			await caught.cleanup();
		}
		expect(caught.pending).toBe(false);
		if (!identity) throw new Error("Close-fault callback omitted the reserved target identity");
		await withAuthorityRelocationExclusive(
			relocationRequest([], { sessionFile: target, expectedPhysicalIdentity: identity }, "close-fault"),
			async () => "released",
		);
	});

	it("retains kernel exclusion after physical close failure until same-owner retry", async () => {
		const directory = await makeDirectory();
		const source = await makeSession(directory, "close-source.jsonl");
		const target = path.join(directory, "close-target.jsonl");
		const targetLock = authorityPaths(target).lock;
		const closeFailure = new Error("injected target-anchor physical close failure");
		const open = fs.open;
		let targetHandle: fs.FileHandle | undefined;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await open(file, flags, mode);
			if (String(file) === targetLock) targetHandle = handle;
			return handle;
		});
		let targetIdentity: AuthorityPhysicalIdentity | undefined;
		let restoreClose: (() => void) | undefined;
		let closeFailed = false;
		let caught: unknown;
		try {
			await withAuthorityRelocationExclusive(
				relocationRequest([{ sessionFile: source }], { sessionFile: target }, "physical-close-fault"),
				async context => {
					targetIdentity = context.target.physicalIdentity;
					if (!targetHandle) throw new Error("Close-fault callback omitted the actual target FileHandle");
					const handle = targetHandle;
					const closeSpy = spyOn(handle, "close").mockImplementationOnce(async () => {
						closeFailed = true;
						throw closeFailure;
					});
					restoreClose = () => closeSpy.mockRestore();
				},
			);
		} catch (error) {
			caught = error;
		} finally {
			restoreClose?.();
			openSpy.mockRestore();
		}
		if (!(caught instanceof AuthorityCleanupError))
			throw new Error("Expected retained physical close cleanup ownership");
		try {
			expect(closeFailed).toBe(true);
			expect(nestedErrors(caught)).toContain(closeFailure);
			expect(caught.pending).toBe(true);
			await expect(acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" })).rejects.toThrow(
				/already held/i,
			);
			if (!targetHandle || !targetIdentity)
				throw new Error("Close fault omitted its retained target handle and identity");
			expect(await fs.readlink(`/proc/self/fd/${targetHandle.fd}`)).toBe(targetLock);
			const contender = spawnRelocationProcess(
				"try",
				relocationRequest(
					[],
					{ sessionFile: target, expectedPhysicalIdentity: targetIdentity },
					"physical-close-held",
				),
			);
			const refused = await readProcessResult(contender.stdout);
			expect(await contender.exited).toBe(0);
			expect(refused).toMatchObject({ acquired: false, error: expect.stringMatching(/flock/i) });
		} finally {
			await caught.cleanup();
		}
		expect(caught.pending).toBe(false);
		const ordinary = await acquireAuthorityOwnership(source, { owningSessionId: "root-uuid" });
		await ordinary.release();
		if (!targetIdentity) throw new Error("Close-fault callback omitted the reserved target identity");
		const after = spawnRelocationProcess(
			"try",
			relocationRequest(
				[],
				{ sessionFile: target, expectedPhysicalIdentity: targetIdentity },
				"physical-close-released",
			),
		);
		const reacquired = await readProcessResult(after.stdout);
		expect(await after.exited).toBe(0);
		expect(reacquired).toMatchObject({ acquired: true, targetPhysicalIdentity: targetIdentity });
		await withAuthorityRelocationExclusive(
			relocationRequest(
				[{ sessionFile: source }],
				{ sessionFile: target, expectedPhysicalIdentity: targetIdentity },
				"physical-close-fault",
			),
			async () => "released",
		);
	});
});
