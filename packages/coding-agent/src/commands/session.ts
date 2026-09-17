import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionHelp as commandHelp } from "../cli/command-help";
import { repairSessionAuthority } from "../registry/durable-state";
import { resolveResumableSession } from "../session/session-listing";
import { repairSessionCommand, resumeCommand } from "../utils/resume-command";

const ACTIONS = ["repair"] as const;

type SessionAction = (typeof ACTIONS)[number];

export default class Session extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "Session action",
			required: false,
			options: ACTIONS,
		}),
		session: Args.string({
			description: "Session id or path to a session .jsonl",
			required: false,
		}),
	};

	static flags = {
		apply: Flags.boolean({
			description: "Apply a verified offline authority repair",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Session);
		const action = args.action as SessionAction | undefined;
		if (action !== "repair") {
			process.stderr.write("Usage: omp session repair <session-id-or-path> [--apply]\n");
			process.exitCode = 1;
			return;
		}

		const sessionArg = args.session ?? "";
		if (!sessionArg) {
			process.stderr.write("Session repair requires a session id or path.\n");
			process.exitCode = 1;
			return;
		}

		let sessionPath: string | undefined;
		try {
			sessionPath = await this.#resolveSessionPath(sessionArg);
		} catch (error) {
			process.stderr.write(
				`Session repair failed for ${sessionArg}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
			return;
		}
		if (!sessionPath) return;

		try {
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
	}
	async #resolveSessionPath(sessionArg: string): Promise<string | undefined> {
		const looksLikePath = sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl");
		if (looksLikePath) {
			const sessionPath = path.resolve(sessionArg);
			try {
				if (!(await fs.stat(sessionPath)).isFile()) {
					process.stderr.write(`Session "${sessionArg}" not found.\n`);
					process.exitCode = 1;
					return undefined;
				}
				return sessionPath;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
				process.stderr.write(`Session "${sessionArg}" not found.\n`);
				process.exitCode = 1;
				return undefined;
			}
		}

		const match = await resolveResumableSession(sessionArg, process.cwd());
		if (!match) {
			process.stderr.write(`Session "${sessionArg}" not found.\n`);
			process.exitCode = 1;
			return undefined;
		}
		return path.resolve(match.session.path);
	}
}
