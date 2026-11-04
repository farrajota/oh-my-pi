import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/authority";
import { readAuthorityDescriptor } from "@oh-my-pi/pi-coding-agent/registry/authority/descriptor";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import * as authority from "@oh-my-pi/pi-coding-agent/registry/authority";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

describe("SessionManager.createEmptySessionFile", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-empty-session-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("creates a valid session file with a header pointing at the given cwd", async () => {
		const file = await SessionManager.createEmptySessionFile(cwd);
		expect(file).toMatch(/\.jsonl$/);
		expect(fs.existsSync(file)).toBe(true);

		const entries = await loadEntriesFromFile(file);
		expect(entries.length).toBe(1);
		const header = entries[0] as SessionHeader;
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(header.id).toBeTruthy();
		expect(header.cwd).toBe(path.resolve(cwd));
	});

	it("places the file in the cwd-derived default session directory", async () => {
		const file = await SessionManager.createEmptySessionFile(cwd);
		const expectedDir = SessionManager.getDefaultSessionDir(cwd);
		expect(path.dirname(file)).toBe(expectedDir);
	});

	it("can be loaded by setSessionFile to start a fresh session at that path", async () => {
		const file = await SessionManager.createEmptySessionFile(cwd);
		const manager = SessionManager.create(cwd);
		await manager.setSessionFile(file);

		// The session adopts the header's cwd and has no entries beyond the header.
		expect(manager.getCwd()).toBe(path.resolve(cwd));
		expect(manager.getSessionFile()).toBe(path.resolve(file));
		expect(manager.getEntries().length).toBe(0);
	});

	it("produces unique file paths across calls", async () => {
		const fileA = await SessionManager.createEmptySessionFile(cwd);
		const fileB = await SessionManager.createEmptySessionFile(cwd);
		expect(fileA).not.toBe(fileB);
	});
	it("returns a closed selected empty root that reopens without allocation proof", async () => {
		const file = await SessionManager.createEmptySessionFile(cwd);
		const descriptor = await readAuthorityDescriptor(file);
		expect(descriptor?.state).toBe("active");
		const store = await registryDurableStateForSession(file);
		try {
			expect(await store.getRoot("Main")).toBeUndefined();
		} finally {
			await store.close();
		}
	});

	it("publishes custom storage without creating filesystem authority", async () => {
		const storage = new MemorySessionStorage();
		const file = await SessionManager.createEmptySessionFile(cwd, storage);
		expect((await loadEntriesFromFile(file, storage))[0]).toMatchObject({ type: "session", cwd: path.resolve(cwd) });
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(`${file}.authority.lock`)).toBe(false);
	});
	it("revokes ordinary creation on close rather than granting from its valid header", async () => {
		const manager = SessionManager.create(cwd);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await manager.close();
		await expect(registryDurableStateForSession(file, { create: true })).rejects.toThrow(/allocation/i);
	});

	it("revokes the old allocation on reset and materializes the independently branched root", async () => {
		const manager = SessionManager.create(cwd);
		await manager.ensureOnDisk();
		const old = manager.getSessionFile()!;
		await manager.newSession();
		await expect(registryDurableStateForSession(old, { create: true })).rejects.toThrow(/allocation/i);
		const entry = manager.appendMessage({ role: "user", content: "branch", timestamp: 1 });
		const branch = manager.createBranchedSession(entry);
		if (!branch) throw new Error("Expected branch file.");
		const store = await registryDurableStateForSession(branch, { create: true });
		try {
			expect(await store.getRoot("Main")).toBeUndefined();
		} finally {
			await store.close();
			await manager.close();
		}
	});

	it("revokes abandoned evidence when adopting a different existing transcript", async () => {
		const adopted = await SessionManager.createEmptySessionFile(cwd);
		const manager = SessionManager.create(cwd);
		await manager.ensureOnDisk();
		const abandoned = manager.getSessionFile()!;
		await manager.setSessionFile(adopted);
		await expect(registryDurableStateForSession(abandoned, { create: true })).rejects.toThrow(/allocation/i);
		const store = await registryDurableStateForSession(adopted);
		await store.close();
		await manager.close();
	});

	it("retains creation ownership through a fresh unselected relocation", async () => {
		const manager = SessionManager.create(cwd);
		await manager.ensureOnDisk();
		const old = manager.getSessionFile()!;
		const targetCwd = path.join(testAgentDir, "relocated-project");
		await fsp.mkdir(targetCwd);
		await manager.moveTo(targetCwd);
		const relocated = manager.getSessionFile()!;
		expect(relocated).not.toBe(old);
		const store = await registryDurableStateForSession(relocated, { create: true });
		await store.close();
		await manager.close();
	});

	it("publishes an independent copy with real creation ownership and preserved title", async () => {
		const source = SessionManager.inMemory(cwd);
		await source.setSessionName("independent copy");
		source.appendMessage({ role: "user", content: "copy", timestamp: 1 });
		const copy = await source.persistCopy({ suppressBreadcrumb: true });
		const file = copy.getSessionFile()!;
		expect((await loadEntriesFromFile(file))[0]).toMatchObject({ title: "independent copy", cwd });
		const store = await registryDurableStateForSession(file, { create: true });
		try {
			expect(await store.getActor("Main")).toBeUndefined();
		} finally {
			await store.close();
			await copy.close();
		}
	});

	it("closes every attempted empty-root open and preserves both unknown failures", async () => {
		const opening = new Error("empty open outcome unknown");
		const cleanup = new Error("empty close outcome unknown");
		const open = spyOn(authority, "registryDurableStateForSession").mockRejectedValue(opening);
		const close = spyOn(authority, "closeSessionAuthority").mockRejectedValue(cleanup);
		try {
			let failure: unknown;
			try {
				await SessionManager.createEmptySessionFile(cwd);
			} catch (error) {
				failure = error;
			}
			expect(close).toHaveBeenCalledTimes(1);
			expect(failure).toBeInstanceOf(AggregateError);
			if (!(failure instanceof AggregateError)) throw failure;
			expect(failure.errors).toEqual([opening, cleanup]);
		} finally {
			open.mockRestore();
			close.mockRestore();
		}
	});

	it("revokes empty-root creation evidence after pre-open publication failure", async () => {
		const storage = new FileSessionStorage();
		const original = storage.writeTextAtomic.bind(storage);
		let file: string | undefined;
		const write = spyOn(storage, "writeTextAtomic").mockImplementation(async (target, content, options) => {
			file = target;
			await original(target, content, options);
			throw new Error("empty publication outcome unknown");
		});
		try {
			await expect(SessionManager.createEmptySessionFile(cwd, storage)).rejects.toThrow();
		} finally {
			write.mockRestore();
		}
		if (!file) throw new Error("Expected attempted transcript publication.");
		await expect(registryDurableStateForSession(file, { create: true })).rejects.toThrow(/allocation/i);
	});
});
