import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hasBoundSessionOperationAuthority } from "@oh-my-pi/pi-coding-agent/registry/operation-lease";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAgentRootSession } from "../src/internal/agent-registry-bridge";
import { AgentRegistry } from "../src/registry/agent-registry";
import { registryDurableStateForSession } from "../src/registry/durable-state";
import { createAgentSession, type CreateAgentSessionOptions } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

async function createSessionHarness(options: { bound?: boolean } = {}): Promise<{
	tempDir: TempDir;
	authStorage: AuthStorage;
	sessionManager: SessionManager;
	session: AgentSession;
}> {
	const tempDir = TempDir.createSync("@omp-resume-authority-");
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
	await sessionManager.newSession();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted source session");
	const createOptions = {
		agentId: "Main",
		cwd: tempDir.path(),
		agentDir: tempDir.join("agent"),
		authStorage,
		modelRegistry,
		sessionManager,
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames: [],
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		skipPythonPreflight: true,
	} satisfies CreateAgentSessionOptions;
	const created =
		options.bound === false
			? await createAgentSession(createOptions)
			: await createAgentRootSession(
					new AgentRegistry({ durableState: registryDurableStateForSession(sessionFile) }),
					createOptions,
				);
	return { tempDir, authStorage, sessionManager, session: created.session };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentSession resume authority", () => {
	it("rejects a cross-session switch before abort or session-manager mutation", async () => {
		const harness = await createSessionHarness();
		const currentFile = harness.sessionManager.getSessionFile();
		if (!currentFile) throw new Error("Expected a persisted source session");
		const targetFile = harness.tempDir.join("target session.jsonl");
		const abort = vi.spyOn(harness.session, "abort");
		const setSessionFile = vi.spyOn(harness.sessionManager, "setSessionFile");

		try {
			expect(hasBoundSessionOperationAuthority(harness.sessionManager)).toBe(true);
			await expect(harness.session.switchSession(targetFile)).rejects.toThrow(/fresh process|--resume/);
			expect(abort).not.toHaveBeenCalled();
			expect(setSessionFile).not.toHaveBeenCalled();
			expect(harness.sessionManager.getSessionFile()).toBe(currentFile);
		} finally {
			await harness.session.dispose();
			harness.authStorage.close();
			harness.tempDir.removeSync();
		}
	});

	it("keeps same-session reload compatible when authority is bound", async () => {
		const harness = await createSessionHarness();
		const currentFile = harness.sessionManager.getSessionFile();
		if (!currentFile) throw new Error("Expected a persisted source session");

		try {
			expect(hasBoundSessionOperationAuthority(harness.sessionManager)).toBe(true);
			expect(await harness.session.switchSession(currentFile)).toBe(true);
			expect(harness.sessionManager.getSessionFile()).toBe(currentFile);
		} finally {
			await harness.session.dispose();
			harness.authStorage.close();
			harness.tempDir.removeSync();
		}
	});

	it("switches to a different session when operation authority is unbound", async () => {
		const harness = await createSessionHarness({ bound: false });
		const sourceFile = harness.sessionManager.getSessionFile();
		if (!sourceFile) throw new Error("Expected a persisted source session");
		const targetManager = SessionManager.create(harness.tempDir.path(), harness.tempDir.join("target-sessions"));
		await targetManager.newSession();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected a persisted target session");
		await targetManager.close();

		try {
			expect(hasBoundSessionOperationAuthority(harness.sessionManager)).toBe(false);
			expect(await harness.session.switchSession(targetFile)).toBe(true);
			expect(harness.sessionManager.getSessionFile()).toBe(targetFile);
			expect(harness.sessionManager.getSessionFile()).not.toBe(sourceFile);
		} finally {
			await harness.session.dispose();
			harness.authStorage.close();
			harness.tempDir.removeSync();
		}
	});
});
