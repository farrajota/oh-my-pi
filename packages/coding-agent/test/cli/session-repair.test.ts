import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { commands } from "../../src/cli-commands";
import Session from "../../src/commands/session";
import {
	canonicalDurableSha256,
	RegistryDurableStateStore,
	registryDurableJournalPath,
} from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import { repairSessionCommand, resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

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
});
