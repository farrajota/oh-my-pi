import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/authority";
import { authorityPaths } from "@oh-my-pi/pi-coding-agent/registry/authority/ownership";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

async function selectedSession(directory: string): Promise<{ file: string; id: string }> {
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile()!;
	const id = manager.getSessionId();
	const store = await registryDurableStateForSession(file, { owningSessionId: id, backend: "jsonl", create: true });
	await store.close();
	await manager.close();
	return { file, id };
}

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tmpRoot = "";

	afterEach(async () => {
		if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
		tmpRoot = "";
	});

	it("removes stale .bak siblings so the picker cannot resurrect the session (issue #11499)", async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delete-bak-"));
		const sessionPath = path.join(tmpRoot, "2026-09-21T00-00-00-000Z_abc123.jsonl");
		await Bun.write(sessionPath, '{"type":"session"}\n');
		const ownBak = `${sessionPath}.999.bak`;
		const otherBak = path.join(tmpRoot, "other.jsonl.111.bak");
		await Bun.write(ownBak, "stale backup");
		await Bun.write(otherBak, "unrelated backup");

		const storage = new FileSessionStorage();
		await storage.deleteSessionWithArtifacts(sessionPath);

		expect(await Bun.file(sessionPath).exists()).toBe(false);
		expect(await Bun.file(ownBak).exists()).toBe(false);
		expect(await Bun.file(otherBak).exists()).toBe(true);
	});
	it("deletes root authority sidecars before the transcript", async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delete-authority-"));
		const { file: sessionPath } = await selectedSession(tmpRoot);

		await new FileSessionStorage().deleteSessionWithArtifacts(sessionPath);

		const paths = authorityPaths(sessionPath);
		expect(await Bun.file(sessionPath).exists()).toBe(false);
		expect(await Bun.file(paths.descriptor).exists()).toBe(false);
		expect(await Bun.file(paths.sqlite).exists()).toBe(false);
		expect(await Bun.file(paths.jsonl).exists()).toBe(false);
		expect(await Bun.file(paths.lock).exists()).toBe(true);
	});
	it("deleting a child transcript does not delete its owning root authority", async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delete-child-authority-"));
		const { file: rootFile, id: rootId } = await selectedSession(tmpRoot);
		const childId = "019ed67b-02fb-7000-8dac-396e2f84d484";
		const childFile = path.join(tmpRoot, "child.jsonl");
		await Bun.write(
			childFile,
			`${JSON.stringify({ type: "session", version: 3, id: childId, parentSession: rootId, timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpRoot })}\n`,
		);

		await new FileSessionStorage().deleteSessionWithArtifacts(childFile);

		expect(await Bun.file(childFile).exists()).toBe(false);
		expect(await Bun.file(authorityPaths(rootFile).descriptor).exists()).toBe(true);
	});

	it("applies conditional root deletion to authority sidecars only after the predicate accepts", async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delete-authority-if-"));
		const { file: sessionPath } = await selectedSession(tmpRoot);
		const storage = new FileSessionStorage();

		expect(await storage.deleteSessionWithArtifactsIf(sessionPath, () => false)).toBe(false);
		expect(await Bun.file(authorityPaths(sessionPath).descriptor).exists()).toBe(true);
		expect(await storage.deleteSessionWithArtifactsIf(sessionPath, () => true)).toBe(true);
		expect(await Bun.file(authorityPaths(sessionPath).descriptor).exists()).toBe(false);
	});
});
