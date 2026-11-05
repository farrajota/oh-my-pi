import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { commands } from "../../src/cli-commands";
import Session from "../../src/commands/session";
import {
	canonicalDurableSha256,
	DurableStateUnavailableError,
	durableBackingSha256,
	RegistryDurableStateStore,
	registryDurableJournalPath,
} from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import { legacyDenialBytes, migrateAuthority } from "../../src/registry/authority/migration";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { authorityPaths, LEGACY_AUTHORITY_DENIAL_REASON } from "../../src/registry/authority/ownership";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import {
	deleteSessionAuthorityBundle,
	packAuthorityBundle,
	relocateSessionAuthority,
} from "../../src/registry/authority/lifecycle";
import { classifyPreJournalingEvidence } from "../../src/registry/authority/adoption";
import { repairSessionCommand, resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import { CliUsageError, type CliConfig } from "@oh-my-pi/pi-utils/cli";
import * as sessionTransfer from "../../src/session/session-transfer";

const CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };
const tempDirectories: string[] = [];
let previousExitCode: typeof process.exitCode;

function hash(value: unknown): string {
	return canonicalDurableSha256(value);
}

function appendRepairableTree(store: RegistryDurableStateStore): void {
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
	store.append({ ...construction, at: 1, phase: "reserved" });
	store.append({ ...construction, at: 2, phase: "constructing" });
	store.append({ ...construction, at: 3, phase: "constructed" });
	store.append({ kind: "root", at: 4, rootId: "Main", generation, headHash, state: "active" });
	const appendActor = (
		actorId: string,
		parentId: string | undefined,
		actorGeneration: number,
		state: "retired" | "active" | "parked",
		at: number,
	): void => {
		store.append({
			kind: "actor",
			at,
			actorId,
			rootId: "Main",
			...(parentId === undefined ? {} : { parentId }),
			generation: actorGeneration,
			rootGeneration: 1,
			rootHeadHash: headHash,
			startupHash: hash(`${actorId}:startup`),
			provenanceHash: hash(`${actorId}:provenance`),
			state,
		});
	};
	appendActor("Main", undefined, 1, "retired", 5);
	appendActor("Child", "Main", 2, "active", 6);
	appendActor("Grandchild", "Child", 3, "parked", 7);
	store.append({ ...construction, at: 8, phase: "activated" });
	store.append({ kind: "root", at: 9, rootId: "Main", generation, headHash, state: "active" });
}

async function fixture(): Promise<{ directory: string; sessionFile: string; journal: string }> {
	const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-session-repair-cli-"));
	tempDirectories.push(directory);
	const sessionFile = path.join(directory, "session with spaces.jsonl");
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", id: "019ed676-02fb-7000-8dac-396e2f84d484", timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
	);
	const journal = registryDurableJournalPath(sessionFile);
	appendRepairableTree(new RegistryDurableStateStore(journal));
	return { directory, sessionFile, journal };
}
async function cleanLegacyFixture(): Promise<{ directory: string; sessionFile: string; journal: string }> {
	const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-session-authority-cli-"));
	tempDirectories.push(directory);
	const sessionFile = path.join(directory, "clean root.jsonl");
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", id: "019ed676-02fb-7000-8dac-396e2f84d484", timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
	);
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
	const store = new RegistryDurableStateStore(registryDurableJournalPath(sessionFile));
	store.append({ ...construction, at: 1, phase: "reserved" });
	store.append({ ...construction, at: 2, phase: "constructing" });
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
	store.append({ kind: "root", at: 7, rootId: "Main", generation, headHash, state: "active" });
	return { directory, sessionFile, journal: registryDurableJournalPath(sessionFile) };
}

const execFile = promisify(execFileCallback);

async function parseShellArguments(fragment: string): Promise<string[]> {
	const { stdout } = await execFile("/bin/sh", ["-c", `set -- ${fragment}; printf '%s\\0' "$@"`]);
	return stdout.split("\0").filter(Boolean);
}

function captureOutput() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const logs: string[] = [];
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	}) as typeof process.stdout.write);
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
	return {
		text: () => stdout.join("") + stderr.join("") + logs.join("\n"),
		restore: () => {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			logSpy.mockRestore();
		},
	};
}

beforeEach(() => {
	previousExitCode = process.exitCode ?? 0;
	// Start every test from success so `toBe(1)` assertions cannot pass on an inherited exit code.
	process.exitCode = 0;
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode ?? 0;
	await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("omp session repair", () => {
	it("is registered with help metadata and defaults to a non-mutating diagnosis", async () => {
		const entry = commands.find(command => command.name === "session");
		expect(entry).toBeDefined();
		expect(entry?.help?.description).toContain("repair");
		const { sessionFile, journal } = await fixture();
		const beforeJournal = await Bun.file(journal).arrayBuffer();
		const beforeSession = await Bun.file(sessionFile).arrayBuffer();
		const output = captureOutput();
		try {
			await new Session(["repair", sessionFile], CONFIG).run();
		} finally {
			output.restore();
		}

		expect(await Bun.file(journal).arrayBuffer()).toEqual(beforeJournal);
		expect(await Bun.file(sessionFile).arrayBuffer()).toEqual(beforeSession);
		expect(output.text()).toContain("repairable");
		expect(output.text()).toContain("Child");
		expect(output.text()).toContain(journal);
		expect(output.text()).toContain("--apply");
	});

	it("formats repair and resume paths as a shell-safe single argv entry", async () => {
		const sessionFile = "/tmp/a space/'quote';$(ignored).jsonl";
		const repair = repairSessionCommand(sessionFile, { apply: true });
		const repairArguments = await parseShellArguments(repair.slice(repair.indexOf(" session repair ") + 16));
		expect(repairArguments).toEqual([sessionFile, "--apply"]);

		const resume = resumeCommand(sessionFile);
		const resumeArguments = await parseShellArguments(resume.slice(resume.indexOf(" --resume ") + 10));
		expect(resumeArguments).toEqual([sessionFile]);
	});

	it("requires explicit --apply and preserves a backup while closing the orphaned lineage", async () => {
		const { sessionFile, journal } = await fixture();
		const originalJournal = await Bun.file(journal).arrayBuffer();
		const output = captureOutput();
		try {
			await new Session(["repair", sessionFile, "--apply"], CONFIG).run();
		} finally {
			output.restore();
		}

		const repaired = new RegistryDurableStateStore(journal).snapshot();
		expect(repaired.actors.get("Main")?.state).toBe("retired");
		expect(repaired.actors.get("Child")?.state).toBe("retired");
		expect(repaired.actors.get("Grandchild")?.state).toBe("retired");
		expect(output.text()).toContain("repaired");
		expect(output.text()).toContain("Backup");
		expect(output.text()).toContain("omp --resume");
		expect(output.text()).toContain("'" + sessionFile + "'");

		const backupLine = output
			.text()
			.split("\n")
			.find(line => line.includes("Backup"));
		if (!backupLine) throw new Error("Expected backup location in repair output");
		const backupDirectory = backupLine.slice(backupLine.indexOf(":") + 1).trim();
		expect((await fs.readdir(backupDirectory)).length).toBeGreaterThan(0);
		const backupFiles = await fs.readdir(backupDirectory);
		const backupJournal = backupFiles.find(file => file.includes("authority-v1"));
		if (!backupJournal) throw new Error("Expected authority journal in repair backup");
		expect(await Bun.file(path.join(backupDirectory, backupJournal)).arrayBuffer()).toEqual(originalJournal);
	});

	it("reports a missing canonical target without invoking a provider or changing exit state", async () => {
		const output = captureOutput();
		try {
			await new Session(["repair", "missing-session-id"], CONFIG).run();
		} catch (error) {
			expect(String(error)).toContain("missing-session-id");
		}
		output.restore();
		expect(process.exitCode).toBe(1);
	});

	it("preserves non-absence filesystem errors for explicit paths", async () => {
		const output = captureOutput();
		vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("durable disk I/O failure"), { code: "EIO" }));
		try {
			await new Session(["repair", "/tmp/unreadable.jsonl"], CONFIG).run();
		} finally {
			output.restore();
		}

		expect(process.exitCode).toBe(1);
		expect(output.text()).toContain("durable disk I/O failure");
		expect(output.text()).not.toContain("not found");
	});
	it("dry-runs an explicit backend conversion without changing the transcript or legacy source", async () => {
		const { directory, sessionFile, journal } = await cleanLegacyFixture();
		const transcriptBefore = await Bun.file(sessionFile).arrayBuffer();
		const sourceBefore = await Bun.file(journal).arrayBuffer();
		const artifactsBefore = await fs.readdir(directory);
		const output = captureOutput();
		try {
			await new Session(["authority", sessionFile, "--to", "sqlite"], CONFIG).run();
		} finally {
			output.restore();
		}

		expect(await Bun.file(sessionFile).arrayBuffer()).toEqual(transcriptBefore);
		expect(await Bun.file(journal).arrayBuffer()).toEqual(sourceBefore);
		expect(await fs.readdir(directory)).toEqual(artifactsBefore);
		expect(await Bun.file(`${sessionFile}.authority.json`).exists()).toBe(false);
		expect(output.text()).toMatch(/dry-run/i);
	});

	it("rejects contradictory conversion and recovery options before touching the source", async () => {
		const { sessionFile, journal } = await cleanLegacyFixture();
		const before = await Bun.file(journal).arrayBuffer();
		await expect(
			new Session(["authority", sessionFile, "--to", "sqlite", "--recover", "finish"], CONFIG).run(),
		).rejects.toThrow();
		expect(await Bun.file(journal).arrayBuffer()).toEqual(before);
	});

	it("reports the selected backend from an actual recovered migration result", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		await expect(
			migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "descriptor-published" }),
		).rejects.toThrow(/injected migration fault/i);
		const output = captureOutput();
		try {
			await new Session(["authority", sessionFile, "--recover", "finish"], CONFIG).run();
		} finally {
			output.restore();
		}
		expect(output.text()).toContain("Authority: sqlite");
		expect(output.text()).not.toContain("undefined");
	});

	it("does not close a live authority client during dry-run inspection", async () => {
		const { directory, sessionFile } = await cleanLegacyFixture();
		await migrateAuthority(sessionFile, "sqlite", { apply: true });
		const store = await registryDurableStateForSession(sessionFile, {
			owningSessionId: "019ed676-02fb-7000-8dac-396e2f84d484",
		});
		const descriptorBefore = await Bun.file(`${sessionFile}.authority.json`).arrayBuffer();
		const artifactsBefore = await fs.readdir(directory);
		const output = captureOutput();
		try {
			await new Session(["authority", sessionFile, "--to", "jsonl"], CONFIG).run();
		} finally {
			output.restore();
		}
		expect((await store.getRoot("Main"))?.record.state).toBe("active");
		expect(await Bun.file(`${sessionFile}.authority.json`).arrayBuffer()).toEqual(descriptorBefore);
		expect(await fs.readdir(directory)).toEqual(artifactsBefore);
		await store.close();
	});
	it("does not close a live SQLite owner during selected repair dry-run", async () => {
		const { directory, sessionFile } = await cleanLegacyFixture();
		await migrateAuthority(sessionFile, "sqlite", { apply: true });
		const store = await registryDurableStateForSession(sessionFile, {
			owningSessionId: "019ed676-02fb-7000-8dac-396e2f84d484",
		});
		const descriptor = await fs.readFile(authorityPaths(sessionFile).descriptor);
		const before = (await fs.readdir(directory)).sort();
		const output = captureOutput();
		try {
			await new Session(["repair", sessionFile], CONFIG).run();
		} finally {
			output.restore();
		}
		expect((await store.getRoot("Main"))?.record.state).toBe("active");
		expect(await fs.readFile(authorityPaths(sessionFile).descriptor)).toEqual(descriptor);
		expect((await fs.readdir(directory)).sort()).toEqual(before);
		await store.close();
	});
	it("upgrades legacy v1 JSONL explicitly while keeping the transcript and original evidence", async () => {
		const { sessionFile, journal } = await cleanLegacyFixture();
		const transcriptBefore = await Bun.file(sessionFile).arrayBuffer();
		const sourceBefore = await Bun.file(journal).arrayBuffer();
		await new Session(["authority", sessionFile, "--to", "jsonl", "--apply"], CONFIG).run();
		const descriptor = await readAuthorityDescriptor(sessionFile);
		if (!descriptor) throw new Error("Expected an authority descriptor after explicit format upgrade");
		const store = await registryDurableStateForSession(sessionFile, {
			owningSessionId: "019ed676-02fb-7000-8dac-396e2f84d484",
		});
		const exported = await store.exportState();
		await store.close();
		const paths = authorityPaths(sessionFile);

		expect(descriptor.backend).toBe("jsonl");
		expect(descriptor.payload).toBe(path.basename(paths.jsonl));
		expect(await Bun.file(sessionFile).arrayBuffer()).toEqual(transcriptBefore);
		const denial = JSON.parse(await Bun.file(paths.legacy).text()) as { record: { migrationId: string } };
		expect((await fs.readFile(paths.legacy)).equals(legacyDenialBytes(denial.record.migrationId))).toBe(true);
		expect(await Bun.file(paths.legacyFence).text()).toBe(LEGACY_AUTHORITY_DENIAL_REASON);
		const backup = path.join(
			path.dirname(sessionFile),
			`${path.basename(sessionFile)}.authority.backup.${denial.record.migrationId}`,
			path.basename(journal),
		);
		expect(await Bun.file(backup).arrayBuffer()).toEqual(sourceBefore);
		expect(exported.legacy?.sourceSha256).toBe(durableBackingSha256(new Uint8Array(sourceBefore)));
		expect(exported.legacy?.entries).toHaveLength(7);
	});
	it("returns SQLite writes to JSONL without rewriting transcript or losing imported lineage", async () => {
		const { sessionFile, journal } = await cleanLegacyFixture();
		const transcriptBefore = await Bun.file(sessionFile).arrayBuffer();
		await new Session(["authority", sessionFile, "--to", "sqlite", "--apply"], CONFIG).run();
		const sqliteStore = await registryDurableStateForSession(sessionFile, {
			owningSessionId: "019ed676-02fb-7000-8dac-396e2f84d484",
		});
		const child = {
			kind: "construction" as const,
			at: Date.now(),
			actorId: "Child",
			parentId: "Main",
			rootId: "Main",
			generation: 2,
			startupHash: hash("Child:startup"),
			provenanceHash: hash("Child:provenance"),
			phase: "reserved" as const,
		};
		await sqliteStore.transition(child);
		await sqliteStore.transition({ ...child, phase: "abandoned" });
		await sqliteStore.close();

		await new Session(["authority", sessionFile, "--to", "jsonl", "--apply"], CONFIG).run();
		const jsonlStore = await registryDurableStateForSession(sessionFile, {
			owningSessionId: "019ed676-02fb-7000-8dac-396e2f84d484",
		});
		const construction = await jsonlStore.getConstruction("Main", "Child", 2);
		const exported = await jsonlStore.exportState();
		await jsonlStore.close();
		const descriptor = await readAuthorityDescriptor(sessionFile);
		if (!descriptor) throw new Error("Expected a descriptor after reverse migration");

		expect(descriptor.backend).toBe("jsonl");
		expect(construction?.record.phase).toBe("abandoned");
		expect(exported.legacy?.entries).toHaveLength(7);
		expect(await Bun.file(journal).exists()).toBe(true);
		expect(await Bun.file(sessionFile).arrayBuffer()).toEqual(transcriptBefore);
	});
	it("finishes durable whole-session deletion through an explicit retired transcript path", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		await expect(deleteSessionAuthorityBundle(sessionFile, { faultAt: "source-transcript-retired" })).rejects.toThrow(
			/injected relocation fault/i,
		);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		const output = captureOutput();
		try {
			await new Session(["authority", sessionFile, "--recover", "finish"], CONFIG).run();
			await new Session(["authority", sessionFile, "--recover", "finish"], CONFIG).run();
		} finally {
			output.restore();
		}
		expect(output.text()).toMatch(/lifecycle.*finish/i);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});

	it("reports an unknown session id as one error line with exit 1 instead of throwing", async () => {
		const output = captureOutput();
		try {
			await new Session(["authority", "00000000", "--to", "sqlite"], CONFIG).run();
		} finally {
			output.restore();
		}
		expect(process.exitCode).toBe(1);
		expect(output.text().trim().split("\n")).toHaveLength(1);
		expect(output.text()).toContain('Session authority failed for 00000000: Session "00000000" not found.');
	});

	it("reports a migration refusal as one error line naming the session with exit 1", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		await fs.rm(sessionFile);
		const output = captureOutput();
		try {
			await new Session(["authority", sessionFile, "--to", "sqlite"], CONFIG).run();
		} finally {
			output.restore();
		}
		expect(process.exitCode).toBe(1);
		expect(output.text().trim().split("\n")).toHaveLength(1);
		expect(output.text()).toContain(`Session authority failed for ${sessionFile}: `);
	});

	it("rejects --apply on pack without claiming it only applies to repair", async () => {
		await expect(new Session(["pack", "x", "/tmp/out.tar", "--apply"], CONFIG).run()).rejects.toThrow(
			"--apply only applies to authority and repair.",
		);
	});
});

const OWNING_SESSION_ID = "019ed676-02fb-7000-8dac-396e2f84d484";

/** A selected JSONL root whose reopen cut a torn tail into `<S>.authority-recovered.<offset>.<sha256>.bin`. */
async function recoveredJsonlFixture(): Promise<{
	directory: string;
	sessionFile: string;
	recovery: string;
	recoveryBytes: Buffer;
}> {
	const { directory, sessionFile } = await cleanLegacyFixture();
	await migrateAuthority(sessionFile, "jsonl", { apply: true });
	await fs.appendFile(authorityPaths(sessionFile).jsonl, '{"version":2,"kind":"commit","revi');
	const store = await registryDurableStateForSession(sessionFile, { owningSessionId: OWNING_SESSION_ID });
	await store.close();
	const recovered = (await fs.readdir(directory)).filter(name =>
		name.startsWith(`${path.basename(sessionFile)}.authority-recovered.`),
	);
	expect(recovered).toHaveLength(1);
	const recovery = path.join(directory, recovered[0]!);
	return { directory, sessionFile, recovery, recoveryBytes: await fs.readFile(recovery) };
}

describe("the JSONL tail recovery file", () => {
	it("is reported by repair dry-run and --apply without blocking a clean status", async () => {
		const { sessionFile, recovery, recoveryBytes } = await recoveredJsonlFixture();
		for (const argv of [
			["repair", sessionFile],
			["repair", sessionFile, "--apply"],
		]) {
			process.exitCode = 0;
			const output = captureOutput();
			try {
				await new Session(argv, CONFIG).run();
			} finally {
				output.restore();
			}
			expect(process.exitCode ?? 0).toBe(0);
			expect(output.text()).toContain("Status: clean");
			expect(
				output
					.text()
					.split("\n")
					.filter(line => line.startsWith("Recovery file:")),
			).toEqual([`Recovery file: ${recovery}`]);
		}
		expect((await fs.readFile(recovery)).equals(recoveryBytes)).toBe(true);
	});

	it("does not block a backend migration dry-run or --apply and stays where it is", async () => {
		const { sessionFile, recovery, recoveryBytes } = await recoveredJsonlFixture();
		for (const argv of [
			["authority", sessionFile, "--to", "sqlite"],
			["authority", sessionFile, "--to", "sqlite", "--apply"],
		]) {
			process.exitCode = 0;
			const output = captureOutput();
			try {
				await new Session(argv, CONFIG).run();
			} finally {
				output.restore();
			}
			expect(output.text()).not.toContain("failed");
			expect(process.exitCode ?? 0).toBe(0);
		}
		expect((await readAuthorityDescriptor(sessionFile))?.backend).toBe("sqlite");
		expect((await fs.readFile(recovery)).equals(recoveryBytes)).toBe(true);
	});

	it("is never packed into the authority bundle", async () => {
		const { sessionFile, recovery } = await recoveredJsonlFixture();
		const bundle = await packAuthorityBundle(sessionFile);
		expect(bundle).not.toBeNull();
		expect(bundle!.entries.map(entry => entry.name).filter(name => name.includes("recovered"))).toEqual([]);
		expect(
			bundle!.entries.some(
				entry =>
					entry.data.byteLength > 0 &&
					Buffer.from(entry.data).equals(Buffer.from('{"version":2,"kind":"commit","revi')),
			),
		).toBe(false);
		expect(await Bun.file(recovery).exists()).toBe(true);
	});

	it("is left behind when the session moves", async () => {
		const { directory, sessionFile, recovery, recoveryBytes } = await recoveredJsonlFixture();
		const target = path.join(directory, "moved", path.basename(sessionFile));
		await relocateSessionAuthority(sessionFile, target, { cwd: directory });
		expect(await Bun.file(target).exists()).toBe(true);
		expect((await fs.readFile(recovery)).equals(recoveryBytes)).toBe(true);
		expect((await fs.readdir(path.dirname(target))).filter(name => name.includes("recovered"))).toEqual([]);
	});

	it("is not authority evidence when a transcript without a bundle is adopted", async () => {
		const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-recovery-adoption-"));
		tempDirectories.push(directory);
		const sessionFile = path.join(directory, "root.jsonl");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({ type: "session", id: OWNING_SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
		);
		await fs.writeFile(`${sessionFile}.authority-recovered.19010.${"ab".repeat(32)}.bin`, "torn", { mode: 0o600 });
		expect(await classifyPreJournalingEvidence(sessionFile)).toBe("none");
		// Only the exact recovery-file shape is exempt; a lookalike is still unexplained evidence.
		await fs.writeFile(`${sessionFile}.authority-recovered.junk`, "?", { mode: 0o600 });
		await expect(classifyPreJournalingEvidence(sessionFile)).rejects.toThrow(/authority-recovered\.junk/);
	});
});

describe("repair of a JSONL tail it must keep as evidence", () => {
	it("names the real session, not its private inspection copy", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		const payload = authorityPaths(sessionFile).jsonl;
		const size = (await fs.stat(payload)).size;
		const zeros = Math.ceil(size / 512) * 512 - size + 512;
		await fs.appendFile(
			payload,
			Buffer.concat([Buffer.alloc(zeros), Buffer.from('{"version":2,"kind":"commit"}\n')]),
		);
		const before = await fs.readFile(payload);
		const output = captureOutput();
		try {
			await new Session(["repair", sessionFile], CONFIG).run();
		} finally {
			output.restore();
		}
		expect(process.exitCode).toBe(1);
		expect(output.text()).toContain(payload);
		expect(output.text()).not.toContain(".authority-inspection-");
		expect(await fs.readFile(payload)).toEqual(before);
		const packed = await packAuthorityBundle(sessionFile).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(packed).toBeInstanceOf(Error);
		expect((packed as Error).message).toContain(payload);
		expect((packed as Error).message).not.toContain(".authority-inspection-");
		expect(await fs.readFile(payload)).toEqual(before);
	});

	it("gives the documented manual procedure instead of sending repair, migration or pack back to repair", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		const payload = authorityPaths(sessionFile).jsonl;
		const size = (await fs.stat(payload)).size;
		const zeros = Math.ceil(size / 512) * 512 - size + 512;
		await fs.appendFile(
			payload,
			Buffer.concat([Buffer.alloc(zeros), Buffer.from('{"version":2,"kind":"commit"}\n')]),
		);
		const before = await fs.readFile(payload);
		const guidance = `keep every ${path.basename(sessionFile)}.authority* file unchanged and follow "Refused authority stores" in docs/session-operations-export-share-fork-resume.md`;
		const output = captureOutput();
		try {
			await new Session(["repair", sessionFile], CONFIG).run();
		} finally {
			output.restore();
		}
		expect(process.exitCode).toBe(1);
		expect(output.text()).toContain(guidance);
		expect(output.text()).toContain(`offset ${size}`);
		expect(output.text()).not.toContain(repairSessionCommand(sessionFile));
		const migrated = await migrateAuthority(sessionFile, "sqlite").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(migrated).toBeInstanceOf(Error);
		expect((migrated as Error).message).toContain(guidance);
		expect((migrated as Error).message).not.toContain(repairSessionCommand(sessionFile));
		const packed = await packAuthorityBundle(sessionFile).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((packed as Error).message).toContain(guidance);
		expect((packed as Error).message).not.toContain(repairSessionCommand(sessionFile));
		expect(await fs.readFile(payload)).toEqual(before);
	});

	it("refuses pack of that store with one line instead of an uncaught error", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		await migrateAuthority(sessionFile, "jsonl", { apply: true });
		const payload = authorityPaths(sessionFile).jsonl;
		const size = (await fs.stat(payload)).size;
		const zeros = Math.ceil(size / 512) * 512 - size + 512;
		await fs.appendFile(
			payload,
			Buffer.concat([Buffer.alloc(zeros), Buffer.from('{"version":2,"kind":"commit"}\n')]),
		);
		const before = await fs.readFile(payload);
		const archive = path.join(path.dirname(sessionFile), "refused.tar");
		const output = captureOutput();
		let outcome: unknown;
		try {
			outcome = await new Session(["pack", sessionFile, archive], CONFIG).run().then(
				() => "resolved",
				(error: unknown) => error,
			);
		} finally {
			output.restore();
		}
		expect(outcome).toBe("resolved");
		expect(process.exitCode).toBe(1);
		const lines = output.text().trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith(`Session pack failed for ${sessionFile}: `);
		expect(lines[0]).toContain(`follow "Refused authority stores"`);
		expect(await fs.readFile(payload)).toEqual(before);
		expect(await Bun.file(archive).exists()).toBe(false);
	});
});

describe("omp session pack|unpack|moved failure rendering", () => {
	it("prints a known authority refusal and every cleanup failure of its aggregate on one line", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		const primary = new DurableStateUnavailableError("authority is quarantined");
		const cleanup = new Error("could not remove the placed transcript");
		vi.spyOn(sessionTransfer, "packSession").mockRejectedValue(
			new AggregateError(
				[primary, cleanup],
				"Session placement and durable cleanup failed; retain lifecycle evidence.",
				{ cause: primary },
			),
		);
		const output = captureOutput();
		let outcome: unknown;
		try {
			outcome = await new Session(["pack", sessionFile, path.join(path.dirname(sessionFile), "out.tar")], CONFIG)
				.run()
				.then(
					() => "resolved",
					(error: unknown) => error,
				);
		} finally {
			output.restore();
		}
		expect(outcome).toBe("resolved");
		expect(process.exitCode).toBe(1);
		const lines = output.text().trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith(
			`Session pack failed for ${sessionFile}: Session placement and durable cleanup failed; retain lifecycle evidence.`,
		);
		expect(lines[0]).toContain("authority is quarantined");
		expect(lines[0]).toContain("could not remove the placed transcript");
	});

	it("rethrows an unexpected TypeError so its stack surfaces", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		const bug = new TypeError("undefined is not an object (evaluating 'result.archivePath')");
		vi.spyOn(sessionTransfer, "packSession").mockRejectedValue(bug);
		const output = captureOutput();
		let outcome: unknown;
		try {
			outcome = await new Session(["pack", sessionFile, path.join(path.dirname(sessionFile), "out.tar")], CONFIG)
				.run()
				.then(
					() => "resolved",
					(error: unknown) => error,
				);
		} finally {
			output.restore();
		}
		expect(outcome).toBe(bug);
		expect(process.exitCode).toBe(0);
		expect(output.text()).not.toContain("Session pack failed");
	});

	it("rethrows an aggregate that carries a programming error", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		const aggregate = new AggregateError(
			[new DurableStateUnavailableError("authority is quarantined"), new RangeError("offset out of range")],
			"cleanup failed",
		);
		vi.spyOn(sessionTransfer, "markSessionMoved").mockRejectedValue(aggregate);
		const output = captureOutput();
		let outcome: unknown;
		try {
			outcome = await new Session(["moved", sessionFile, "--to", "laptop"], CONFIG).run().then(
				() => "resolved",
				(error: unknown) => error,
			);
		} finally {
			output.restore();
		}
		expect(outcome).toBe(aggregate);
		expect(output.text()).not.toContain("Session moved failed");
	});

	it("still rejects usage errors raised inside the command's try", async () => {
		const { sessionFile } = await cleanLegacyFixture();
		await expect(new Session(["pack", sessionFile], CONFIG).run()).rejects.toBeInstanceOf(CliUsageError);
		await expect(
			new Session(["unpack", path.join(path.dirname(sessionFile), "in.tar")], CONFIG).run(),
		).rejects.toThrow(/Missing --cwd/);
		await expect(new Session(["moved", sessionFile], CONFIG).run()).rejects.toThrow(/Missing --to/);
		expect(process.exitCode).toBe(0);
	});
});
