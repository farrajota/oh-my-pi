import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { Api, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import * as lspDaemon from "@oh-my-pi/pi-coding-agent/lsp/mux/daemon";
import { cfgLspLazy, cfgLspShared } from "@oh-my-pi/pi-coding-agent/lsp/settings";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const modelSpec: ModelSpec<Api> = {
	id: "shared-lsp-binding",
	name: "Shared LSP binding",
	api: "test-shared-lsp-binding",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
};
const model = buildModel(modelSpec);

// SDK eager warmup uses the session's captured policy, not a process-global flag.
describe("shared LSP warmup policy with subagents and helper sessions", () => {
	const sessions: AgentSession[] = [];
	const workspaces = new Set<string>();

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) {
			if (!session.isDisposed) await session.dispose();
		}
		await lspClient.shutdownAll();
		for (const cwd of workspaces) lspConfig.configCache.delete(cwd);
		workspaces.clear();
		vi.restoreAllMocks();
		resetCapabilityForTests();
	});

	const starter = async (tempDir: TempDir) => {
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const start = async (
			settings: Settings,
			extra: Pick<
				CreateAgentSessionOptions,
				"parentTaskPrefix" | "taskDepth" | "agentId" | "bindProcessState" | "enableLsp" | "hasUI"
			> = {},
		) => {
			const cwd = tempDir.join(`session-${workspaces.size}`);
			await fs.mkdir(cwd);
			workspaces.add(cwd);
			const result = await createAgentSession({
				cwd,
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(cwd),
				authStorage,
				modelRegistry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				...extra,
			});
			sessions.push(result.session);
			return result;
		};
		return { start, close: () => authStorage.close() };
	};

	it("a subagent or helper cannot change its parent's captured shared warmup policy", async () => {
		using tempDir = TempDir.createSync("@pi-shared-lsp-binding-");
		const { start, close } = await starter(tempDir);
		const command = tempDir.join("policy-language-server");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { policy: { command, fileTypes: [".policy"], rootMarkers: ["."] } },
		});
		const sharedAttempt = Promise.withResolvers<string>();
		const privateAttempt = Promise.withResolvers<string>();
		// Stop only at external I/O; SDK discovery, warmup and scoped client selection stay real.
		const shared = vi.spyOn(lspDaemon, "connectSharedLspTransport").mockImplementation(async options => {
			sharedAttempt.resolve(options.cwd);
			throw new Error("Fixture shared transport boundary");
		});
		const spawn = ptree.spawn;
		let privateAttempts = 0;
		vi.spyOn(ptree, "spawn").mockImplementation((args, options) => {
			if (args[0] === command) {
				privateAttempts++;
				privateAttempt.resolve(String(options?.cwd));
				throw new Error("Fixture private transport boundary");
			}
			return spawn(args, options);
		});
		try {
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"lsp.shared": true,
				"lsp.lazy": true,
			});
			const parent = await start(settings, { enableLsp: true, hasUI: true });
			expect(parent.lspServers).toEqual([{ name: "policy", status: "available", fileTypes: [".policy"] }]);
			expect(cfgLspShared.get(parent.session.settings)).toBe(true);
			expect(shared).not.toHaveBeenCalled();
			expect(privateAttempts).toBe(0);

			const child = await start(await createSubagentSettings(parent.session.settings), {
				parentTaskPrefix: "0-Sub",
				taskDepth: 1,
				agentId: "0-Sub",
				enableLsp: false,
				hasUI: true,
			});
			expect(child.lspServers).toBeUndefined();
			expect(shared).not.toHaveBeenCalled();
			expect(privateAttempts).toBe(0);

			const helper = await start(await parent.session.settings.cloneForCwd(tempDir.path()), {
				bindProcessState: false,
				enableLsp: false,
				hasUI: true,
			});
			expect(helper.lspServers).toBeUndefined();
			expect(shared).not.toHaveBeenCalled();
			expect(privateAttempts).toBe(0);

			// A settings edit affects a new session, not this parent's captured warmup policy.
			cfgLspShared.override(parent.session.settings, false);
			cfgLspLazy.override(parent.session.settings, false);
			expect(await sharedAttempt.promise).toBe(parent.session.sessionManager.getCwd());
			expect(shared).toHaveBeenCalledTimes(1);
			expect(shared.mock.calls[0]?.[0]).toMatchObject({
				command,
				cwd: parent.session.sessionManager.getCwd(),
			});
			expect(privateAttempts).toBe(0);

			const privateParent = await start(await parent.session.settings.cloneForCwd(tempDir.path()), {
				enableLsp: true,
				hasUI: true,
			});
			expect(cfgLspShared.get(privateParent.session.settings)).toBe(false);
			expect(await privateAttempt.promise).toBe(privateParent.session.sessionManager.getCwd());
			expect(privateAttempts).toBe(1);
			expect(shared).toHaveBeenCalledTimes(1);
		} finally {
			close();
		}
	});
});
