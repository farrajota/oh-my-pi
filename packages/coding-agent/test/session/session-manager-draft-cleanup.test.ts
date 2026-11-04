import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { authorityPaths } from "../../src/registry/authority/ownership";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function armedDraft(
	storage: FileSessionStorage,
): Promise<{ manager: SessionManager; sessionFile: string; owningSessionId: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-draft-cleanup-deferral-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, path.join(directory, "sessions"), storage);
	await manager.saveDraft("draft text");
	await manager.saveDraft("");
	const sessionFile = manager.getSessionFile()!;
	const owningSessionId = manager.getSessionId();
	const store = await registryDurableStateForSession(sessionFile, { owningSessionId, backend: "jsonl", create: true });
	await store.close();
	return { manager, sessionFile, owningSessionId };
}

describe("SessionManager draft cleanup deferral", () => {
	it("closes the writer but defers transcript and authority deletion until the last release", async () => {
		const { manager, sessionFile } = await armedDraft(new FileSessionStorage());
		const firstRelease = manager.deferDraftCleanup();
		const finalRelease = manager.deferDraftCleanup();

		await manager.close();
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await Bun.file(authorityPaths(sessionFile).descriptor).exists()).toBe(true);

		await firstRelease();
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		await finalRelease();
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(await Bun.file(authorityPaths(sessionFile).descriptor).exists()).toBe(false);
		await finalRelease();
	});

	it("propagates deferred cleanup failures and retains the session authority", async () => {
		class FailingCleanupStorage extends FileSessionStorage {
			override async deleteSessionWithArtifactsIf(
				_sessionPath: string,
				_shouldDelete: (content: string) => boolean,
			): Promise<boolean> {
				throw new Error("injected draft cleanup failure");
			}
		}
		const { manager, sessionFile } = await armedDraft(new FailingCleanupStorage());
		const release = manager.deferDraftCleanup();

		await manager.close();
		await expect(release()).rejects.toThrow("injected draft cleanup failure");
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await Bun.file(authorityPaths(sessionFile).descriptor).exists()).toBe(true);
	});

	it("waits for delayed writer drain before releasing deferred draft cleanup", async () => {
		const entered = Promise.withResolvers<void>();
		const unblock = Promise.withResolvers<void>();
		class DelayedDrainStorage extends FileSessionStorage {
			override drain(): Promise<void> {
				entered.resolve();
				return unblock.promise;
			}
		}
		const { manager, sessionFile } = await armedDraft(new DelayedDrainStorage());
		const release = manager.deferDraftCleanup();
		const closing = manager.close();
		await entered.promise;
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await Bun.file(authorityPaths(sessionFile).descriptor).exists()).toBe(true);
		unblock.resolve();
		await closing;
		await release();
		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});

	it("returns the same rejected promise when the deferred cleanup release is repeated", async () => {
		class FailingCleanupStorage extends FileSessionStorage {
			override async deleteSessionWithArtifactsIf(
				_sessionPath: string,
				_shouldDelete: (content: string) => boolean,
			): Promise<boolean> {
				throw new Error("injected repeated cleanup failure");
			}
		}
		const { manager } = await armedDraft(new FailingCleanupStorage());
		const release = manager.deferDraftCleanup();
		await manager.close();
		const rejected = release();
		await expect(rejected).rejects.toThrow("injected repeated cleanup failure");
		await expect(release()).rejects.toThrow("injected repeated cleanup failure");
		expect(release()).toBe(rejected);
	});
});
