import { afterEach, describe, expect, it } from "bun:test";
import { FileLock } from "@oh-my-pi/pi-natives";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthorityAdoption, AuthorityBackendMismatch } from "../../src/registry/authority";
import {
	AuthorityAdoptionRefusedError,
	closeSessionAuthority,
	formatAuthorityBackendMismatchNotice,
	registryDurableStateForSession,
} from "../../src/registry/authority";
import { recoverAbandonedAuthorityInitialization } from "../../src/registry/authority/adoption";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { migrateAuthority, recoverAuthorityMigration } from "../../src/registry/authority/migration";
import { authorityPaths, LEGACY_AUTHORITY_DENIAL_REASON } from "../../src/registry/authority/ownership";
import {
	canonicalDurableSha256,
	RegistryDurableStateStore,
	registryDurableJournalPath,
} from "../../src/registry/durable-state";

const rootId = "019ed676-02fb-7000-8dac-396e2f84d484";
const directories: string[] = [];
const sessions: string[] = [];
const childScript = path.join(import.meta.dir, "authority-adoption-process.ts");
const killPreload = path.join(import.meta.dir, "authority-adoption-kill.ts");

afterEach(async () => {
	for (const session of sessions.splice(0)) await closeSessionAuthority(session);
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function hash(value: unknown): string {
	return canonicalDurableSha256(value);
}

/** A root transcript as written before authority journaling existed; its bytes must never change. */
async function transcriptOnlyRoot(
	options: { authorityRoot?: (sessionFile: string) => string } = {},
): Promise<{ sessionFile: string; directory: string; transcript: Buffer<ArrayBuffer> }> {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-adoption-")));
	directories.push(directory);
	const sessionFile = path.join(directory, `2026-01-01T00-00-00-000Z_${rootId}.jsonl`);
	const stamp = options.authorityRoot ? { authorityRoot: options.authorityRoot(sessionFile) } : {};
	const transcript = Buffer.from(
		`${JSON.stringify({ type: "session", version: 3, id: rootId, timestamp: "2026-01-01T00:00:00.000Z", cwd: directory, ...stamp })}\n` +
			`${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } })}\n`,
	);
	await fs.writeFile(sessionFile, transcript);
	sessions.push(sessionFile);
	return { sessionFile, directory, transcript };
}

/** The legacy v1 journal the pre-feature binary wrote beside the root; `unresolved` stops mid-construction. */
async function legacyRoot(
	options: { unresolved?: boolean } = {},
): Promise<{ sessionFile: string; directory: string; transcript: Buffer<ArrayBuffer>; journal: Buffer<ArrayBuffer> }> {
	const root = await transcriptOnlyRoot();
	const generation = 1;
	const startupHash = hash("Main:startup");
	const provenanceHash = hash("Main:provenance");
	const headHash = hash({ rootId: "Main", generation, actorId: "Main", startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		actorId: "Main",
		rootId: "Main",
		generation,
		startupHash,
		provenanceHash,
	};
	const store = new RegistryDurableStateStore(registryDurableJournalPath(root.sessionFile));
	store.append({ ...construction, at: 1, phase: "reserved" });
	store.append({ ...construction, at: 2, phase: "constructing" });
	if (!options.unresolved) {
		store.append({ ...construction, at: 3, phase: "constructed" });
		store.append({ kind: "root", at: 4, rootId: "Main", generation, headHash, state: "active" });
		store.append({
			kind: "actor",
			at: 5,
			actorId: "Main",
			rootId: "Main",
			generation,
			rootGeneration: generation,
			rootHeadHash: headHash,
			startupHash,
			provenanceHash,
			state: "active",
		});
		store.append({ ...construction, at: 6, phase: "activated" });
	}
	return { ...root, journal: await fs.readFile(registryDurableJournalPath(root.sessionFile)) };
}

/** Every name and content digest in the root's directory, recursively; refusals must leave it identical. */
async function snapshot(directory: string): Promise<string[]> {
	const rows: string[] = [];
	const walk = async (current: string, prefix: string): Promise<void> => {
		for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				rows.push(`${prefix}${entry.name}/`);
				await walk(full, `${prefix}${entry.name}/`);
			} else {
				rows.push(
					`${prefix}${entry.name}\t${createHash("sha256")
						.update(await fs.readFile(full))
						.digest("hex")}`,
				);
			}
		}
	};
	await walk(directory, "");
	return rows;
}

async function resume(
	sessionFile: string,
	backend?: "jsonl" | "sqlite",
): Promise<{ adoptions: AuthorityAdoption[]; backend: string; close: () => Promise<void> }> {
	const adoptions: AuthorityAdoption[] = [];
	const store = await registryDurableStateForSession(sessionFile, {
		owningSessionId: rootId,
		...(backend ? { backend } : {}),
		onAdopted: adoption => adoptions.push(adoption),
	});
	return { adoptions, backend: store.identity.backend, close: () => closeSessionAuthority(sessionFile) };
}

async function refusal(sessionFile: string): Promise<Error> {
	const outcome = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId }).then(
		() => new Error("expected the resume to be refused"),
		(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
	);
	await closeSessionAuthority(sessionFile);
	return outcome;
}

async function legacyEntries(sessionFile: string): Promise<unknown[] | undefined> {
	const store = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
	try {
		return (await store.exportState()).legacy?.entries as unknown[] | undefined;
	} finally {
		await closeSessionAuthority(sessionFile);
	}
}

function journalLines(journal: Buffer): unknown[] {
	return journal
		.toString("utf8")
		.trimEnd()
		.split("\n")
		.map(line => JSON.parse(line));
}

async function runChild(
	sessionFile: string,
	env: Record<string, string> = {},
	holdMs = 0,
): Promise<{ exitCode: number | null; signalCode: string | null; stdout: string; stderr: string }> {
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			...(Object.keys(env).length ? ["--preload", killPreload] : []),
			childScript,
			sessionFile,
			rootId,
			String(holdMs),
		],
		{
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	return { exitCode: child.exitCode, signalCode: child.signalCode, stdout, stderr };
}

describe("resume adoption of pre-journaling sessions", () => {
	it("bootstraps a versioned JSONL authority for a transcript-only root and reports it once", async () => {
		const { sessionFile, transcript } = await transcriptOnlyRoot();
		const first = await resume(sessionFile);
		expect(first.backend).toBe("jsonl");
		expect(first.adoptions).toEqual([{ kind: "bootstrapped", sessionFile, backend: "jsonl" }]);
		await first.close();
		const descriptor = await readAuthorityDescriptor(sessionFile);
		expect(descriptor).toMatchObject({ state: "active", backend: "jsonl", owningSessionId: rootId });
		expect(await fs.readFile(authorityPaths(sessionFile).legacyFence, "utf8")).toBe(LEGACY_AUTHORITY_DENIAL_REASON);
		const second = await resume(sessionFile);
		expect(second.adoptions).toEqual([]);
		await second.close();
		expect(await fs.readFile(sessionFile)).toEqual(transcript);
	});

	it("upgrades a clean legacy v1 journal in place, retains its backup and keeps its history readable", async () => {
		const { sessionFile, transcript, journal } = await legacyRoot();
		const first = await resume(sessionFile);
		expect(first.backend).toBe("jsonl");
		expect(first.adoptions).toHaveLength(1);
		const adoption = first.adoptions[0];
		if (adoption?.kind !== "upgraded") throw new Error(`expected a legacy upgrade, got ${JSON.stringify(adoption)}`);
		await first.close();
		expect(
			await fs.readFile(path.join(adoption.backupDirectory, path.basename(registryDurableJournalPath(sessionFile)))),
		).toEqual(journal);
		// The canonical legacy path now holds the unsupported-version denial record behind the permanent fence.
		expect(await fs.readFile(registryDurableJournalPath(sessionFile))).not.toEqual(journal);
		expect(await fs.readFile(authorityPaths(sessionFile).legacyFence, "utf8")).toBe(LEGACY_AUTHORITY_DENIAL_REASON);
		expect(await readAuthorityDescriptor(sessionFile)).toMatchObject({ state: "active", backend: "jsonl" });
		expect(await legacyEntries(sessionFile)).toEqual(journalLines(journal));
		const reopened = await resume(sessionFile);
		expect(reopened.adoptions).toEqual([]);
		await reopened.close();
		expect(await fs.readFile(sessionFile)).toEqual(transcript);
	});

	it.each(["transcript-only", "legacy"] as const)(
		"adopts a %s root to JSONL even when the requested default is sqlite",
		async kind => {
			const { sessionFile } = kind === "legacy" ? await legacyRoot() : await transcriptOnlyRoot();
			const opened = await resume(sessionFile, "sqlite");
			expect(opened.backend).toBe("jsonl");
			expect(opened.adoptions.map(adoption => adoption.kind)).toEqual([
				kind === "legacy" ? "upgraded" : "bootstrapped",
			]);
			await opened.close();
			expect(await readAuthorityDescriptor(sessionFile)).toMatchObject({ backend: "jsonl" });
			expect(await Bun.file(authorityPaths(sessionFile).sqlite).exists()).toBe(false);
		},
	);

	it("adopts past a bare ownership anchor left before any authority write", async () => {
		const bare = await transcriptOnlyRoot();
		await fs.writeFile(authorityPaths(bare.sessionFile).lock, "", { mode: 0o600 });
		const bootstrapped = await resume(bare.sessionFile);
		expect(bootstrapped.adoptions.map(adoption => adoption.kind)).toEqual(["bootstrapped"]);
		await bootstrapped.close();
		const legacy = await legacyRoot();
		await fs.writeFile(authorityPaths(legacy.sessionFile).lock, "", { mode: 0o600 });
		const upgraded = await resume(legacy.sessionFile);
		expect(upgraded.adoptions.map(adoption => adoption.kind)).toEqual(["upgraded"]);
		await upgraded.close();
	});

	it("refuses a transcript created under authority journaling elsewhere and copied without its bundle", async () => {
		const original = "/srv/sessions/original/2026-01-01T00-00-00-000Z_root.jsonl";
		const { sessionFile, directory, transcript } = await transcriptOnlyRoot({ authorityRoot: () => original });
		const before = await snapshot(directory);
		const error = await refusal(sessionFile);
		expect(error).toBeInstanceOf(AuthorityAdoptionRefusedError);
		expect(error.message).toContain(`created under authority journaling at ${original}`);
		expect((error as AuthorityAdoptionRefusedError).command).toBe(`omp --resume ${original}`);
		// No fresh store is created for the copy: its directory, transcript included, is unchanged.
		expect(await snapshot(directory)).toEqual(before);
		expect(await fs.readFile(sessionFile)).toEqual(transcript);
	});

	it("bootstraps a transcript stamped at its own path whose authority was never created", async () => {
		const { sessionFile } = await transcriptOnlyRoot({ authorityRoot: file => file });
		const opened = await resume(sessionFile);
		expect(opened.adoptions).toEqual([{ kind: "bootstrapped", sessionFile, backend: "jsonl" }]);
		await opened.close();
		expect(await readAuthorityDescriptor(sessionFile)).toMatchObject({ state: "active", backend: "jsonl" });
	});

	it("retries a refused opening afresh in the same process once its cause is removed", async () => {
		const { sessionFile, directory } = await transcriptOnlyRoot();
		const stray = path.join(directory, `${path.basename(sessionFile)}.authority.migration.stray`);
		await fs.writeFile(stray, "", { mode: 0o600 });
		const first = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(first).toBeInstanceOf(AuthorityAdoptionRefusedError);
		await fs.rm(stray);
		// No closeSessionAuthority in between: the refused opening must not be replayed from a cache.
		const retried = await resume(sessionFile);
		expect(retried.adoptions.map(adoption => adoption.kind)).toEqual(["bootstrapped"]);
		await retried.close();
	});

	it("reports a persisted backend that differs from the environment default to the opener, every time it is opened", async () => {
		const { sessionFile } = await transcriptOnlyRoot();
		// Adoption always selects JSONL; this root is then migrated to SQLite while the default stays JSONL.
		await (await resume(sessionFile)).close();
		const migrated = await migrateAuthority(sessionFile, "sqlite", { apply: true });
		expect(migrated.status).toBe("migrated");
		const mismatches: AuthorityBackendMismatch[] = [];
		await registryDurableStateForSession(sessionFile, {
			owningSessionId: rootId,
			onBackendMismatch: mismatch => mismatches.push(mismatch),
		});
		await registryDurableStateForSession(sessionFile, {
			owningSessionId: rootId,
			onBackendMismatch: mismatch => mismatches.push(mismatch),
		});
		await closeSessionAuthority(sessionFile);
		const expected: AuthorityBackendMismatch = { sessionFile, requestedDefault: "jsonl", actualBackend: "sqlite" };
		expect(mismatches).toEqual([expected, expected]);
		expect(formatAuthorityBackendMismatchNotice(expected)).toContain(`session authority ${sessionFile} --to jsonl`);
	});

	it("refuses a legacy journal with unresolved work without touching anything", async () => {
		const { sessionFile, directory } = await legacyRoot({ unresolved: true });
		const before = await snapshot(directory);
		const error = await refusal(sessionFile);
		expect(error).toBeInstanceOf(AuthorityAdoptionRefusedError);
		expect(error.message).toContain("construction:Main:1:constructing");
		expect((error as AuthorityAdoptionRefusedError).command).toMatch(/session authority \S+ --to jsonl$/);
		expect(await snapshot(directory)).toEqual(before);
	});

	it("refuses a corrupt legacy journal without touching anything", async () => {
		const { sessionFile, directory, journal } = await legacyRoot();
		await fs.writeFile(registryDurableJournalPath(sessionFile), journal.subarray(0, journal.length - 7), {
			mode: 0o600,
		});
		const before = await snapshot(directory);
		const error = await refusal(sessionFile);
		expect(error).toBeInstanceOf(AuthorityAdoptionRefusedError);
		expect((error as AuthorityAdoptionRefusedError).command).toMatch(/session repair \S+$/);
		expect(await snapshot(directory)).toEqual(before);
	});

	const strayEvidence: ReadonlyArray<readonly [string, (sessionFile: string) => Promise<void>, RegExp]> = [
		[
			"a permanent denial fence without a descriptor",
			file => fs.writeFile(authorityPaths(file).legacyFence, LEGACY_AUTHORITY_DENIAL_REASON, { mode: 0o600 }),
			/session repair \S+$/,
		],
		[
			"a quarantined legacy journal",
			async file => {
				await fs.writeFile(registryDurableJournalPath(file), "", { mode: 0o600 });
				await fs.writeFile(
					authorityPaths(file).legacyFence,
					"Durable recovery cursor does not match the journal head chain.\n",
					{ mode: 0o600 },
				);
			},
			/session repair \S+$/,
		],
		[
			"an orphan versioned payload",
			file => fs.writeFile(authorityPaths(file).jsonl, "{}\n", { mode: 0o600 }),
			/session repair \S+$/,
		],
		[
			"an orphan migration backup",
			file => fs.mkdir(`${file}.authority.backup.0b1e`, { mode: 0o700 }),
			/session repair \S+$/,
		],
		[
			"an aborted upgrade backup beside its journal",
			async file => {
				await fs.writeFile(registryDurableJournalPath(file), "{}\n", { mode: 0o600 });
				await fs.mkdir(`${file}.authority.backup.0b1e`, { mode: 0o700 });
			},
			/session authority \S+ --to jsonl --apply$/,
		],
		[
			"a lifecycle relocation guard",
			file =>
				fs.mkdir(path.join(path.dirname(file), `.${path.basename(file)}.authority-guard.0b1e`), { mode: 0o700 }),
			/session authority \S+ --recover finish$/,
		],
		[
			"an interrupted descriptor write",
			file => fs.writeFile(`${authorityPaths(file).descriptor}.tmp-0b1e`, "{", { mode: 0o600 }),
			/session authority \S+ --recover abort$/,
		],
		[
			"a lock anchor that records content",
			file => fs.writeFile(authorityPaths(file).lock, "owner", { mode: 0o600 }),
			/session repair \S+$/,
		],
		[
			"legacy repair history without its journal",
			async file => {
				const backup = path.join(path.dirname(file), ".authority-repair-0b1e");
				await fs.mkdir(backup, { mode: 0o700 });
				await fs.writeFile(path.join(backup, path.basename(registryDurableJournalPath(file))), "{}\n", {
					mode: 0o600,
				});
			},
			/session repair \S+$/,
		],
		[
			"an unrecognized authority sibling",
			file => fs.writeFile(`${file}.authority.segment-0001`, "", { mode: 0o600 }),
			/session repair \S+$/,
		],
	];
	it.each(strayEvidence)("refuses %s unchanged and names its command", async (_label, plant, command) => {
		const { sessionFile, directory } = await transcriptOnlyRoot();
		await plant(sessionFile);
		const before = await snapshot(directory);
		const error = await refusal(sessionFile);
		expect(error).toBeInstanceOf(AuthorityAdoptionRefusedError);
		expect((error as AuthorityAdoptionRefusedError).command).toMatch(command);
		expect(error.message).toContain((error as AuthorityAdoptionRefusedError).command);
		expect(await snapshot(directory)).toEqual(before);
	});

	it("prints a CLI resume refusal as one line naming the command, with exit 1 and no stack", async () => {
		const { sessionFile, directory } = await legacyRoot();
		await fs.writeFile(
			authorityPaths(sessionFile).legacyFence,
			"Durable recovery cursor does not match the journal head chain.\n",
			{ mode: 0o600 },
		);
		const before = await snapshot(directory);
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-adoption-home-"));
		directories.push(home);
		const child = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				path.resolve(import.meta.dir, "../../src/cli.ts"),
				"--no-title",
				"--no-lsp",
				"--no-tools",
				"--no-extensions",
				"-p",
				"--resume",
				sessionFile,
				"hello",
			],
			{
				cwd: home,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					PI_CONFIG_DIR: path.join(home, ".omp"),
					PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
					TMPDIR: process.env.TMPDIR,
					NO_COLOR: "1",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr.trim().split("\n")).toEqual([
			`Unable to resume ${sessionFile}: Cannot adopt pre-journaling session ${sessionFile}: the legacy authority journal is quarantined (Durable recovery cursor does not match the journal head chain.). Run: omp session repair ${sessionFile}`,
		]);
		expect(await snapshot(directory)).toEqual(before);
	}, 30_000);

	it.each(["target-staged", "descriptor-published"] as const)(
		"refuses a legacy root interrupted mid-migration at %s with the --recover command",
		async cut => {
			const { sessionFile, directory } = await legacyRoot();
			await expect(migrateAuthority(sessionFile, "jsonl", { apply: true, faultAt: cut })).rejects.toThrow(
				`Injected migration fault at ${cut}`,
			);
			const before = await snapshot(directory);
			const error = await refusal(sessionFile);
			expect(error.message).toMatch(/session authority \S+ --recover finish/);
			expect(await snapshot(directory)).toEqual(before);
		},
	);

	it.each([
		["transcript-only", "bootstrapped"],
		["legacy", "upgraded"],
	] as const)(
		"lets exactly one of several concurrent resumers adopt a %s root; the rest see the result or held ownership",
		async (kind, adopted) => {
			const legacy = kind === "legacy" ? await legacyRoot() : undefined;
			const { sessionFile } = legacy ?? (await transcriptOnlyRoot());
			const outcomes = await Promise.all([0, 1, 2, 3].map(() => runChild(sessionFile, {}, 300)));
			const reports = outcomes.map(
				outcome =>
					JSON.parse(outcome.stdout.trim().split("\n").at(-1) ?? "{}") as {
						ok: boolean;
						adoption?: string | null;
						error?: string;
					},
			);
			expect(reports.filter(report => report.ok && report.adoption === adopted)).toHaveLength(1);
			for (const report of reports) {
				if (report.ok) expect<(string | null)[]>([null, adopted]).toContain(report.adoption ?? null);
				else expect(report.error).toMatch(/ownership is already held|authority filesystem flock/);
			}
			const later = JSON.parse((await runChild(sessionFile)).stdout.trim()) as {
				ok: boolean;
				adoption?: string | null;
			};
			expect(later).toMatchObject({ ok: true, adoption: null });
			const backups = (await fs.readdir(path.dirname(sessionFile))).filter(name =>
				name.includes(".authority.backup."),
			);
			expect(backups).toHaveLength(kind === "legacy" ? 1 : 0);
			if (legacy) expect(await legacyEntries(sessionFile)).toEqual(journalLines(legacy.journal));
		},
		60_000,
	);

	it("refuses unchanged while an older client still holds the legacy journal writer lock", async () => {
		const { sessionFile, directory } = await legacyRoot();
		const before = await snapshot(directory);
		const writer = FileLock.tryAcquire(registryDurableJournalPath(sessionFile));
		expect(writer.acquired).toBe(true);
		try {
			const error = await refusal(sessionFile);
			expect(error.message).toContain("another client still writes the legacy authority journal");
			expect((error as AuthorityAdoptionRefusedError).command).toMatch(/--resume \S+$/);
		} finally {
			writer.release();
		}
		expect(await snapshot(directory)).toEqual(before);
	});

	const manifestPhases = [
		"started",
		"backed-up",
		"source-frozen",
		"target-staged",
		"target-verified",
		"legacy-fenced",
		"target-publishing",
		"target-published",
		"before-descriptor-publication",
		"descriptor-published",
		"ready",
	] as const;
	const abortable = new Set<string>(manifestPhases.slice(0, manifestPhases.indexOf("descriptor-published")));
	describe.each([...manifestPhases])("a resume killed after the upgrade manifest reaches %s", phase => {
		it("leaves the transcript intact and a migration that --recover finish completes", async () => {
			const { sessionFile, transcript, journal } = await legacyRoot();
			const killed = await runChild(sessionFile, { ADOPTION_KILL_MANIFEST_PHASE: phase });
			expect(killed.signalCode, killed.stdout + killed.stderr).toBe("SIGKILL");
			expect(await fs.readFile(sessionFile)).toEqual(transcript);
			expect((await refusal(sessionFile)).message).toMatch(/--recover finish/);
			expect((await recoverAuthorityMigration(sessionFile, "finish")).targetBackend).toBe("jsonl");
			expect(await legacyEntries(sessionFile)).toEqual(journalLines(journal));
			expect(await fs.readFile(sessionFile)).toEqual(transcript);
		}, 30_000);
		if (abortable.has(phase)) {
			it("or that --recover abort restores to the exact legacy source", async () => {
				const { sessionFile, journal } = await legacyRoot();
				const killed = await runChild(sessionFile, { ADOPTION_KILL_MANIFEST_PHASE: phase });
				expect(killed.signalCode, killed.stdout + killed.stderr).toBe("SIGKILL");
				await recoverAuthorityMigration(sessionFile, "abort");
				expect(await fs.readFile(registryDurableJournalPath(sessionFile))).toEqual(journal);
				// The aborted attempt keeps its backup, so a later upgrade is explicit, never a silent retry.
				const error = await refusal(sessionFile);
				expect((error as AuthorityAdoptionRefusedError).command).toMatch(/--to jsonl --apply$/);
				await migrateAuthority(sessionFile, "jsonl", { apply: true });
				expect(await legacyEntries(sessionFile)).toEqual(journalLines(journal));
			}, 30_000);
		}
	});

	it("recovers a bootstrap killed after its initializing descriptor with --recover abort, then bootstraps", async () => {
		const { sessionFile, transcript } = await transcriptOnlyRoot();
		const killed = await runChild(sessionFile, { ADOPTION_KILL_DESCRIPTOR_STATE: "initializing" });
		expect(killed.signalCode, killed.stdout + killed.stderr).toBe("SIGKILL");
		expect((await refusal(sessionFile)).message).toMatch(/session authority \S+ --recover abort/);
		await expect(recoverAbandonedAuthorityInitialization(sessionFile, "finish")).rejects.toThrow(/--recover abort/);
		expect(await recoverAbandonedAuthorityInitialization(sessionFile, "abort")).toBe(true);
		expect((await fs.readdir(path.dirname(sessionFile))).sort()).toEqual(
			[path.basename(sessionFile), path.basename(authorityPaths(sessionFile).lock)].sort(),
		);
		const opened = await resume(sessionFile);
		expect(opened.adoptions.map(adoption => adoption.kind)).toEqual(["bootstrapped"]);
		await opened.close();
		expect(await fs.readFile(sessionFile)).toEqual(transcript);
	}, 30_000);

	it("removes an abandoned initialization only while its payload holds no authority records", async () => {
		const { sessionFile } = await transcriptOnlyRoot();
		const opened = await resume(sessionFile);
		await opened.close();
		const descriptorPath = authorityPaths(sessionFile).descriptor;
		const active = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as Record<string, unknown>;
		// Reinstall the pre-activation descriptor exactly as a crash before activation leaves it.
		await fs.writeFile(descriptorPath, `${JSON.stringify({ ...active, revision: 1, state: "initializing" })}\n`, {
			mode: 0o600,
		});
		expect(await recoverAbandonedAuthorityInitialization(sessionFile, "abort")).toBe(true);
		expect(await Bun.file(authorityPaths(sessionFile).jsonl).exists()).toBe(false);

		const used = await resume(sessionFile);
		await used.close();
		const store = await registryDurableStateForSession(sessionFile, { owningSessionId: rootId });
		const construction = {
			kind: "construction" as const,
			at: 10,
			actorId: "Evidence",
			rootId: "Evidence",
			generation: 2,
			startupHash: hash("Evidence:startup"),
			provenanceHash: hash("Evidence:provenance"),
		};
		await store.transitionBatch([{ ...construction, phase: "reserved" }], { requestId: "evidence-reserved" });
		await closeSessionAuthority(sessionFile);
		const usedDescriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as Record<string, unknown>;
		await fs.writeFile(
			descriptorPath,
			`${JSON.stringify({ ...usedDescriptor, revision: 1, state: "initializing" })}\n`,
			{ mode: 0o600 },
		);
		const payload = await fs.readFile(authorityPaths(sessionFile).jsonl);
		await expect(recoverAbandonedAuthorityInitialization(sessionFile, "abort")).rejects.toThrow(
			/already holds authority records/,
		);
		expect(await fs.readFile(authorityPaths(sessionFile).jsonl)).toEqual(payload);
	}, 30_000);
});
