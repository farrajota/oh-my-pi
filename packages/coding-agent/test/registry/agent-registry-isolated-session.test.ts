import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { SessionManager } from "../../src/session/session-manager";

// Extensions build private registries for sessions they create themselves (the install smoke test does exactly
// this). Once the new transcript is on disk, the registry must open a fresh root authority for it.

const directories: string[] = [];
const registries: AgentRegistry[] = [];

afterEach(async () => {
	for (const registry of registries.splice(0)) await registry.getDurableStateStore()?.close();
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("AgentRegistry.isolatedForSession", () => {
	it("opens a fresh root authority for a newly persisted session", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolated-registry-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, path.join(directory, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not allocate a transcript.");
		await manager.ensureOnDisk();
		const registry = await AgentRegistry.isolatedForSession(sessionFile);
		registries.push(registry);
		const descriptor = await readAuthorityDescriptor(sessionFile);
		expect(descriptor?.owningSessionId).toBe(manager.getSessionId());
		expect(descriptor?.backend).toBe("jsonl");
		await manager.close();
	});
});
