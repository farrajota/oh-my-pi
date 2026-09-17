import * as path from "node:path";
import { hasBoundSessionOperationAuthority } from "../registry/operation-lease";
import { foreignSessionImportCommand, resumeCommand } from "../utils/resume-command";

interface SessionSwitchManager {
	getSessionFile(): string | undefined;
}

type SessionSwitchTarget =
	| { readonly kind: "session"; readonly path: string }
	| { readonly kind: "foreign-import"; readonly source: "claude" | "codex"; readonly sourceName: string };

/**
 * Reject a bound session's cross-session transition before a caller flushes,
 * prepares UI, imports a transcript, or mutates the active session.
 */
export function assertSessionSwitchPreflight(manager: SessionSwitchManager, target: SessionSwitchTarget): void {
	const currentSessionFile = manager.getSessionFile();
	const switchingToDifferentSession =
		target.kind === "foreign-import"
			? true
			: !currentSessionFile || path.resolve(currentSessionFile) !== path.resolve(target.path);
	if (!switchingToDifferentSession || !hasBoundSessionOperationAuthority(manager)) return;

	if (target.kind === "session") {
		throw new Error(
			`Cross-session resume is unavailable in this live session. Start a fresh process with ${resumeCommand(target.path)}.`,
		);
	}

	throw new Error(
		`Importing a ${target.sourceName} session is unavailable in this live session. Start a fresh process with ${foreignSessionImportCommand(target.source)}.`,
	);
}
