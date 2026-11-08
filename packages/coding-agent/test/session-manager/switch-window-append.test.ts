import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Holds the next read of one file until the test releases it, opening a window inside setSessionFile. */
class ReadGatedStorage extends FileSessionStorage {
	#gate: { filePath: string; started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;

	gateNextRead(filePath: string): { started: Promise<void>; release: () => void } {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#gate = { filePath, started, release };
		return { started: started.promise, release: release.resolve };
	}

	async #wait(filePath: string): Promise<void> {
		const gate = this.#gate;
		if (gate?.filePath !== filePath) return;
		this.#gate = undefined;
		gate.started.resolve();
		await gate.release.promise;
	}

	override async readText(filePath: string): Promise<string> {
		await this.#wait(filePath);
		return super.readText(filePath);
	}

	override async readTextSlices(
		filePath: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[string, string]> {
		await this.#wait(filePath);
		return super.readTextSlices(filePath, prefixBytes, suffixBytes);
	}
}

async function persistedSession(dir: string, storage: FileSessionStorage, marker: string): Promise<SessionManager> {
	const manager = SessionManager.create(dir, dir, storage);
	manager.appendCustomEntry(marker);
	await manager.ensureOnDisk();
	await manager.flush();
	return manager;
}

function requireSessionFile(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	return file;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SessionManager.setSessionFile switch window", () => {
	it("keeps an entry appended while the target loads in the previous file, and later entries in the target", async () => {
		using dir = TempDir.createSync("@pi-switch-window-load-");
		const storage = new ReadGatedStorage();
		const target = await persistedSession(dir.path(), storage, "target-only");
		const targetFile = requireSessionFile(target);
		await target.close();
		const manager = await persistedSession(dir.path(), storage, "source-only");
		const sourceFile = requireSessionFile(manager);

		const read = storage.gateNextRead(targetFile);
		const switching = manager.setSessionFile(targetFile);
		await read.started;
		manager.appendCustomEntry("appended-during-load");
		await manager.flush();
		read.release();
		await switching;
		expect(manager.getSessionFile()).toBe(targetFile);
		manager.appendCustomEntry("appended-after-switch");
		await manager.flush();
		await manager.close();

		const targetText = await fs.readFile(targetFile, "utf8");
		const sourceText = await fs.readFile(sourceFile, "utf8");
		expect(targetText).toContain("appended-after-switch");
		expect(targetText).not.toContain("appended-during-load");
		expect(sourceText).toContain("appended-during-load");
		expect(sourceText).not.toContain("appended-after-switch");
	});

	it("does not write a previous-session entry into the target while the target's entries are prepared", async () => {
		using dir = TempDir.createSync("@pi-switch-window-prepare-");
		const storage = new FileSessionStorage();
		const target = await persistedSession(dir.path(), storage, "target-only");
		const targetFile = requireSessionFile(target);
		await target.close();
		const manager = await persistedSession(dir.path(), storage, "source-only");
		const sourceFile = requireSessionFile(manager);
		const sourceSessionId = manager.getSessionId();

		const prepareStarted = Promise.withResolvers<void>();
		const releasePrepare = Promise.withResolvers<void>();
		const resolveBlobRefs = sessionLoader.resolveBlobRefsInEntries;
		vi.spyOn(sessionLoader, "resolveBlobRefsInEntries").mockImplementation(async (...args) => {
			prepareStarted.resolve();
			await releasePrepare.promise;
			return resolveBlobRefs(...args);
		});
		const switching = manager.setSessionFile(targetFile);
		await prepareStarted.promise;
		manager.appendCustomEntry("appended-during-prepare", { sessionId: sourceSessionId });
		await manager.flush();
		releasePrepare.resolve();
		await switching;
		// The switch lands on the requested target, not on a sibling forked off by a write conflict.
		expect(manager.getSessionFile()).toBe(targetFile);
		await manager.close();

		expect(await fs.readFile(targetFile, "utf8")).not.toContain(sourceSessionId);
		expect(await fs.readFile(sourceFile, "utf8")).toContain("appended-during-prepare");
	});
});
