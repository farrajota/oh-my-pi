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

export function foreignSessionImportCommand(source: "claude" | "codex"): string {
	return `${commandPrefix()} --from-${source}`;
}
