import { TempDir } from "@oh-my-pi/pi-utils";
import {
	closeSessionAuthority,
	registryDurableStateForSession,
	validateJournalingEnvironment,
} from "../registry/authority";
import { SessionManager } from "../session/session-manager";
import type { AuthorityStore } from "../registry/authority/types";

/** Exercise the selected worker path without touching the user's session directory. */
export async function smokeTestAuthorityWorker(): Promise<void> {
	using tempDir = TempDir.createSync("@omp-authority-worker-smoke-");
	const sessionManager = SessionManager.create(process.cwd(), tempDir.path());
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Authority worker smoke requires a persisted session file");
	const header = sessionManager.getHeader();
	if (!header || header.id !== sessionManager.getSessionId()) {
		throw new Error("Authority worker smoke session header does not match its session UUID");
	}

	let store: AuthorityStore | undefined;
	try {
		await sessionManager.ensureOnDisk();
		try {
			store = await registryDurableStateForSession(sessionFile, {
				backend: validateJournalingEnvironment(),
				owningSessionId: header.id,
				create: true,
			});
		} catch (error) {
			if (
				process.platform !== "linux" &&
				error instanceof Error &&
				error.message.includes("requires Linux filesystem flock")
			) {
				return;
			}
			throw error;
		}
		if (store.identity.owningSessionId !== header.id || store.identity.backend !== "jsonl") {
			throw new Error("Authority worker smoke opened an inconsistent root identity");
		}
		const recovery = await store.recoveryState();
		if (recovery.owner.phase !== "ready" || recovery.blocked.length > 0) {
			throw new Error("Authority worker smoke recovery did not reach a ready root");
		}
	} finally {
		try {
			await store?.close();
		} finally {
			try {
				await closeSessionAuthority(sessionFile);
			} finally {
				await sessionManager.close();
			}
		}
	}
}
