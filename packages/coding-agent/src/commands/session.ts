import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionHelp as commandHelp } from "../cli/command-help";
import { resolveSessionFileArg } from "../cli/session-arg";
import { repairSessionAuthority } from "../registry/durable-state";
import { resolveResumableSession } from "../session/session-listing";
import { SessionMoveRefusedError } from "../session/session-manager";
import {
	markSessionMoved,
	packSession,
	SessionTransferError,
	unpackSession,
	type UnpackMode,
} from "../session/session-transfer";
import { repairSessionCommand, resumeCommand } from "../utils/resume-command";

const ACTIONS = ["repair", "pack", "unpack", "moved"] as const;
type SessionAction = (typeof ACTIONS)[number];

const USAGE: Record<Exclude<SessionAction, "repair">, string> = {
	pack: "omp session pack <session> <out.tar>",
	unpack: "omp session unpack <archive.tar> --cwd <dir>",
	moved: "omp session moved <session> --to <label>",
};

const UNPACK_NOTE: Record<UnpackMode, string> = {
	created: "Unpacked session",
	replaced: "Replaced the local copy of this session",
	forked: "The local copy of this session diverged; unpacked as a fork",
};

function isSessionAction(value: string): value is SessionAction {
	return ACTIONS.some(action => action === value);
}

export default class Session extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "repair, pack, unpack, or moved",
			required: false,
			options: ACTIONS,
		}),
		source: Args.string({
			description: "Session id or path; archive path for unpack",
			required: false,
		}),
		output: Args.string({
			description: "Archive file to write (pack)",
			required: false,
		}),
	};

	static flags = {
		apply: Flags.boolean({
			description: "Apply a verified offline authority repair",
			default: false,
		}),
		cwd: Flags.string({ description: "Directory the session continues in on this machine (unpack)" }),
		to: Flags.string({ description: "Where the session went, e.g. a machine name (moved)" }),
	};

	static examples = [
		"# Repair session authority (dry-run unless --apply)\n  omp session repair <session-id-or-path>",
		"# Pack a session with its artifacts and image blobs\n  omp session pack ~/.omp/agent/sessions/<project>/<file>.jsonl /tmp/session.tar",
		"# Unpack it on another machine; prints the session file path\n  omp session unpack /tmp/session.tar --cwd ~/src/project",
		"# Mark the local copy stale; resuming it later forks it\n  omp session moved <file>.jsonl --to cloud",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Session);
		const action = args.action ?? "";
		if (!isSessionAction(action)) throw new CliUsageError(`Unknown action: ${action}`);
		const source = args.source;
		if (!source) throw new CliUsageError(`Missing ${action === "unpack" ? "archive" : "session"}.`);

		if (action === "repair") {
			if (flags.cwd !== undefined || flags.to !== undefined || args.output !== undefined) {
				throw new CliUsageError("Transfer options do not apply to repair.");
			}
			let sessionPath = source;
			try {
				const resolvedSessionPath = await this.#resolveRepairSessionPath(source);
				if (!resolvedSessionPath) return;
				sessionPath = resolvedSessionPath;
				const result = await repairSessionAuthority(sessionPath, { apply: flags.apply });
				const affected = result.affectedActorIds;
				console.log(`Status: ${result.status}`);
				console.log(`Journal: ${result.journalPath}`);
				console.log(`Affected actors: ${affected.length}${affected.length ? ` (${affected.join(", ")})` : ""}`);
				if (result.status === "repairable" && !flags.apply) {
					console.log(`Apply: ${repairSessionCommand(sessionPath, { apply: true })}`);
					console.log("Dry-run complete; no journal or quarantine marker was changed.");
					console.log("Before --apply, stop the owning client and review this diagnosis.");
				}
				if (result.status === "repaired") {
					console.log(`Backup: ${result.backupDirectory}`);
					console.log(`Fresh process: ${resumeCommand(sessionPath)}`);
				}
			} catch (error) {
				process.stderr.write(
					`Session repair failed for ${sessionPath}: ${error instanceof Error ? error.message : String(error)}\n`,
				);
				process.exitCode = 1;
			}
			return;
		}

		if (flags.apply) throw new CliUsageError("--apply only applies to repair.");
		const usage = USAGE[action];
		if (argv.length > (action === "pack" ? 3 : 2)) {
			throw new CliUsageError(`Unexpected argument "${argv.at(-1)}". Usage: ${usage}`);
		}
		if (action !== "unpack" && flags.cwd !== undefined) {
			throw new CliUsageError(`--cwd only applies to unpack. Usage: ${usage}`);
		}
		if (action !== "moved" && flags.to !== undefined) {
			throw new CliUsageError(`--to only applies to moved. Usage: ${usage}`);
		}

		try {
			switch (action) {
				case "pack": {
					if (!args.output) throw new CliUsageError(`Missing output archive path. Usage: ${usage}`);
					const result = await packSession(await this.#resolveSession(source), args.output);
					if (result.missingBlobs.length > 0) {
						process.stderr.write(
							`${chalk.yellow(`warning: ${result.missingBlobs.length} referenced blob(s) are missing from the local blob store and were not packed; those images will not load after unpacking.`)}\n`,
						);
					}
					process.stdout.write(`${result.archivePath}\n`);
					return;
				}
				case "unpack": {
					if (!flags.cwd) throw new CliUsageError(`Missing --cwd <dir>. Usage: ${usage}`);
					const result = await unpackSession(source, { cwd: flags.cwd });
					process.stderr.write(`${chalk.dim(`${UNPACK_NOTE[result.mode]} (${result.id}).`)}\n`);
					process.stdout.write(`${result.sessionFile}\n`);
					return;
				}
				case "moved": {
					if (flags.to === undefined) throw new CliUsageError(`Missing --to <label>. Usage: ${usage}`);
					await markSessionMoved(await this.#resolveSession(source), flags.to);
					return;
				}
			}
		} catch (error) {
			if (error instanceof SessionTransferError || error instanceof SessionMoveRefusedError) {
				process.stderr.write(`${chalk.red(`error: ${error.message}`)}\n`);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
	}

	async #resolveRepairSessionPath(sessionArg: string): Promise<string | undefined> {
		const looksLikePath = sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl");
		if (looksLikePath) {
			const sessionPath = path.resolve(sessionArg);
			try {
				if ((await fs.stat(sessionPath)).isFile()) return sessionPath;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			}
			process.stderr.write(`Session "${sessionArg}" not found.\n`);
			process.exitCode = 1;
			return undefined;
		}
		const match = await resolveResumableSession(sessionArg, process.cwd());
		if (!match) {
			process.stderr.write(`Session "${sessionArg}" not found.\n`);
			process.exitCode = 1;
			return undefined;
		}
		return path.resolve(match.session.path);
	}

	/** A session path or id resolved to a file, with lookup failures reported as transfer errors. */
	async #resolveSession(source: string): Promise<string> {
		try {
			return await resolveSessionFileArg(source, process.cwd());
		} catch (error) {
			throw new SessionTransferError(error instanceof Error ? error.message : String(error));
		}
	}
}
