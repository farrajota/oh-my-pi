import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionHelp as commandHelp } from "../cli/command-help";
import { resolveSessionFileArg } from "../cli/session-arg";
import { migrateAuthority, recoverAuthorityMigration, repairSelectedAuthority } from "../registry/authority/migration";
import { recoverAbandonedAuthorityInitialization } from "../registry/authority/adoption";
import { recoverAuthorityRelocationIfPresent } from "../registry/authority/lifecycle";
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

const ACTIONS = ["authority", "repair", "pack", "unpack", "moved"] as const;
type SessionAction = (typeof ACTIONS)[number];

const USAGE: Record<Exclude<SessionAction, "repair">, string> = {
	authority: "omp session authority <session> --to jsonl|sqlite [--apply] | --recover finish|abort",
	pack: "omp session pack <session> <out.tar>",
	unpack: "omp session unpack <archive.tar> --cwd <dir>",
	moved: "omp session moved <session> --to <label>",
};

const UNPACK_NOTE: Record<UnpackMode, string> = {
	created: "Unpacked session",
	replaced: "Replaced the local copy of this session",
	forked: "The local copy of this session diverged; unpacked as a fork",
};

/**
 * One-line message for an expected command failure. It includes the cause chain and, for an AggregateError, every
 * member (such as the cleanup failures after a primary refusal), so the part the operator must act on is not lost.
 */
export function describeSessionCommandFailure(error: unknown, depth = 0): string {
	if (!(error instanceof Error)) return String(error);
	if (error instanceof AggregateError && error.errors.length > 0 && depth < 4) {
		const members = error.errors.map(member => describeSessionCommandFailure(member, depth + 1));
		return `${error.message} (failures: ${members.join("; ")})`;
	}
	const causes: string[] = [];
	let cause: unknown = error.cause;
	for (let level = 0; cause !== undefined && level < 4; level++) {
		causes.push(cause instanceof Error ? cause.message : String(cause));
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return causes.length > 0 ? `${error.message} (cause: ${causes.join("; ")})` : error.message;
}

/**
 * Names of the refusals pack, unpack and moved report as one line. The authority and transfer layers raise most of
 * their refusals as plain `Error` (as do filesystem failures such as EACCES); the rest are these named classes.
 * Errors forwarded from the authority worker keep their original name, so a worker-side TypeError is not mistaken
 * for a refusal. Anything else (TypeError, RangeError, ReferenceError, unknown subclasses) is a defect and keeps its stack.
 */
const OPERATOR_REFUSAL_NAMES = new Set([
	"Error",
	"DurableStateUnavailableError",
	"DurableStateConflictError",
	"AuthorityRecoveryRequiredError",
	"AuthorityAdoptionRefusedError",
	"AuthorityCapacityUnsupportedError",
	"AuthorityCapacityRefusedError",
	"AuthorityRelocationInterruptedError",
	"SessionLockError",
	// An authority worker deadline that expired (a slow or stuck disk): the operator retries, nothing to report.
	"TimeoutError",
]);

function isOperatorRefusal(error: unknown, depth = 0): boolean {
	if (!(error instanceof Error) || depth > 4) return false;
	if (error instanceof AggregateError)
		return error.errors.length > 0 && error.errors.every(member => isOperatorRefusal(member, depth + 1));
	return OPERATOR_REFUSAL_NAMES.has(error.name);
}

function isSessionAction(value: string): value is SessionAction {
	return ACTIONS.some(action => action === value);
}

export default class Session extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "authority, repair, pack, unpack, or moved",
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
			description: "Apply an explicit offline authority migration or repair",
			default: false,
		}),
		cwd: Flags.string({ description: "Directory the session continues in on this machine (unpack)" }),
		to: Flags.string({ description: "Target authority backend or destination label" }),
		recover: Flags.string({
			description:
				'Recover an interrupted authority migration or lifecycle operation: finish completes it, abort restores the original state (refused once the target is selected). With nothing to recover it prints "Status: recovered" and exits 0',
			options: ["finish", "abort"],
		}),
	};

	static examples = [
		"# Dry-run an authority migration, then apply it explicitly\n  omp session authority <session-id-or-path> --to sqlite\n  omp session authority <session-id-or-path> --to sqlite --apply",
		"# Authority migration is dry-run by default; --apply performs it (stop the owning client first)\n  omp session authority <session-id-or-path> --to jsonl --apply",
		"# Recover an interrupted migration or lifecycle operation by finishing it\n  omp session authority <session-id-or-path> --recover finish",
		"# Recover by aborting: restore the original state (refused once the target is selected)\n  omp session authority <session-id-or-path> --recover abort",
		"# Repair selected authority (dry-run unless --apply)\n  omp session repair <session-id-or-path>",
		"# Pack a session with its artifacts, image blobs, and authority bundle\n  omp session pack ~/.omp/agent/sessions/<project>/<file>.jsonl /tmp/session.tar",
		"# Unpack it on another machine; prints the session file path\n  omp session unpack /tmp/session.tar --cwd ~/src/project",
		"# Mark the local copy stale; resuming it later forks it\n  omp session moved <file>.jsonl --to cloud",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Session);
		const action = args.action ?? "";
		if (!isSessionAction(action)) throw new CliUsageError(`Unknown action: ${action}`);
		const source = args.source;
		if (!source) throw new CliUsageError(`Missing ${action === "unpack" ? "archive" : "session"}.`);

		if (action === "authority") {
			if (argv.length > 2)
				throw new CliUsageError(`Unexpected argument "${argv.at(-1)}". Usage: ${USAGE.authority}`);
			if (flags.cwd !== undefined || args.output !== undefined) {
				throw new CliUsageError("Transfer options do not apply to authority migration.");
			}
			if (flags.recover !== undefined) {
				if (flags.recover !== "finish" && flags.recover !== "abort") {
					throw new CliUsageError("--recover must be finish or abort.");
				}
				if (flags.to !== undefined || flags.apply) {
					throw new CliUsageError("--recover cannot be combined with --to or --apply.");
				}
			} else if (flags.to !== "jsonl" && flags.to !== "sqlite") {
				throw new CliUsageError(`Authority migration requires --to jsonl|sqlite. Usage: ${USAGE.authority}`);
			}
			let target = source;
			try {
				const explicitRecoveryPath =
					flags.recover !== undefined &&
					(source.includes("/") || source.includes("\\") || source.endsWith(".jsonl"));
				const sessionPath = explicitRecoveryPath ? path.resolve(source) : await this.#resolveSession(source);
				target = sessionPath;
				if (flags.recover !== undefined) {
					if (await recoverAuthorityRelocationIfPresent(sessionPath, flags.recover)) {
						console.log(`Status: lifecycle ${flags.recover} complete`);
						return;
					}
					if (await recoverAbandonedAuthorityInitialization(sessionPath, flags.recover)) {
						console.log("Status: recovered");
						console.log(
							"Authority: none (removed an initialization that never became active; the next resume creates a fresh store)",
						);
						return;
					}
					const result = await recoverAuthorityMigration(sessionPath, flags.recover);
					console.log(`Status: ${result.status}`);
					console.log(`Authority: ${result.targetBackend}`);
					return;
				}
				const result = await migrateAuthority(sessionPath, flags.to === "sqlite" ? "sqlite" : "jsonl", {
					apply: flags.apply,
				});
				console.log(`Status: ${result.status}`);
				console.log(`Authority: ${result.sourceBackend} -> ${result.targetBackend}`);
				if (!flags.apply)
					console.log(
						"Dry-run complete; no authority artifacts or transcript were changed. Use --apply to migrate.",
					);
			} catch (error) {
				process.stderr.write(`Session authority failed for ${target}: ${describeSessionCommandFailure(error)}\n`);
				process.exitCode = 1;
			}
			return;
		}

		if (action === "repair") {
			if (
				flags.cwd !== undefined ||
				flags.to !== undefined ||
				flags.recover !== undefined ||
				args.output !== undefined
			) {
				throw new CliUsageError("Transfer and migration options do not apply to repair.");
			}
			let sessionPath = source;
			try {
				const resolvedSessionPath = await this.#resolveRepairSessionPath(source);
				if (!resolvedSessionPath) return;
				sessionPath = resolvedSessionPath;
				const result = await repairSelectedAuthority(sessionPath, { apply: flags.apply });
				const affected = result.affectedActorIds;
				console.log(`Status: ${result.status}`);
				console.log(`Journal: ${result.journalPath}`);
				console.log(`Affected actors: ${affected.length}${affected.length ? ` (${affected.join(", ")})` : ""}`);
				for (const file of result.recoveryFiles) console.log(`Recovery file: ${file}`);
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
				process.stderr.write(`Session repair failed for ${sessionPath}: ${describeSessionCommandFailure(error)}\n`);
				process.exitCode = 1;
			}
			return;
		}
		if (flags.recover !== undefined) throw new CliUsageError("--recover only applies to authority migrations.");

		if (flags.apply) throw new CliUsageError("--apply only applies to authority and repair.");
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
			// Usage errors keep their own rendering; programming errors propagate so their stack surfaces.
			if (error instanceof CliUsageError || !isOperatorRefusal(error)) throw error;
			// Authority refusals (quarantine, torn tail, recovery required) are expected operator outcomes, not crashes.
			process.stderr.write(`Session ${action} failed for ${source}: ${describeSessionCommandFailure(error)}\n`);
			process.exitCode = 1;
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
