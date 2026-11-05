import * as path from "node:path";
import { APP_NAME, getActiveProfile } from "@oh-my-pi/pi-utils";

/** Quote one shell argument for a POSIX shell. */
export function quoteShellArgument(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandPrefix(): string {
	const profile = getActiveProfile();
	return profile ? `${APP_NAME} --profile ${quoteShellArgument(profile)}` : APP_NAME;
}

export function resumeCommand(sessionId: string): string {
	return `${commandPrefix()} --resume ${quoteShellArgument(sessionId)}`;
}

export function repairSessionCommand(sessionId: string, options?: { apply?: boolean }): string {
	return `${commandPrefix()} session repair ${quoteShellArgument(sessionId)}${options?.apply ? " --apply" : ""}`;
}

/** `omp session authority <session> <options>`; `options` is a fixed flag string such as `--recover finish`. */
export function sessionAuthorityCommand(sessionId: string, options: string): string {
	return `${commandPrefix()} session authority ${quoteShellArgument(sessionId)} ${options}`;
}

/**
 * Guidance for an authority store that no command can recover or diagnose further: preserve the evidence and follow
 * the manual procedure in the session-operations docs. Used where naming a command would send the operator in a loop.
 */
export function refusedAuthorityStoreGuidance(sessionFile: string): string {
	return `keep every ${path.basename(sessionFile)}.authority* file unchanged and follow "Refused authority stores" in docs/session-operations-export-share-fork-resume.md`;
}

export function foreignSessionImportCommand(source: "claude" | "codex"): string {
	return `${commandPrefix()} --from-${source}`;
}
