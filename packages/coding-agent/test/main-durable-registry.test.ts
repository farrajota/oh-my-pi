import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CompressProtocol } from "@oh-my-pi/pi-coding-agent/compress/protocol";
import { createCompressSession } from "@oh-my-pi/pi-coding-agent/compress/session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	attachRootAuthorityDisposal,
	createAcpSessionFactory,
	createSessionManager,
	disposeRootSession,
	runRootCommand,
} from "@oh-my-pi/pi-coding-agent/main";
import { createAgentRootSession } from "@oh-my-pi/pi-coding-agent/internal/agent-registry-bridge";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { closeSessionAuthority, registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/authority";
import type { AuthorityStore } from "@oh-my-pi/pi-coding-agent/registry/authority/types";
import { migrateAuthority } from "@oh-my-pi/pi-coding-agent/registry/authority/migration";
import { recoverAbandonedAuthorityInitialization } from "@oh-my-pi/pi-coding-agent/registry/authority/adoption";
import { sessionAuthorityCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, postmortem, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const priorRegistry = AgentRegistry.global();

afterEach(() => {
	AgentRegistry.installGlobal(priorRegistry);
});

function offlineModel(authStorage: AuthStorage) {
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	return { ...model, baseUrl: "http://127.0.0.1:1", compat: { ...model.compat, firstPartyProvider: false } };
}

function refreshModelsOffline() {
	const refresh = ModelRegistry.prototype.refresh;
	return vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(function (this: ModelRegistry) {
		return refresh.call(this, "offline");
	});
}

async function captureMainRootOptions(noSession: boolean): Promise<{
	options: CreateAgentSessionOptions;
	installedRegistry: AgentRegistry;
	expectedDurableState: AuthorityStore | undefined;
}> {
	using tempDir = TempDir.createSync("@omp-main-durable-registry-");
	const previousAgentDir = getAgentDir();
	setAgentDir(tempDir.path());
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const rawArgs = noSession ? ["--no-session", "--print", "hello"] : ["--print", "hello"];
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	let captured: CreateAgentSessionOptions | undefined;
	let installedRegistry: AgentRegistry | undefined;
	let expectedDurableState: AuthorityStore | undefined;
	const stop = new Error("stop after root options");

	try {
		await runRootCommand(parsed, rawArgs, {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async options => {
				if (!options) throw new Error("Expected root session options");
				captured = options;
				installedRegistry = AgentRegistry.global();
				expectedDurableState = installedRegistry?.getDurableStateStore();
				throw stop;
			},
		});
	} catch (error) {
		if (error !== stop) throw error;
	} finally {
		authStorage.close();
		const sessionFile = captured?.sessionManager?.getSessionFile();
		if (sessionFile) await closeSessionAuthority(sessionFile);
		await captured?.sessionManager?.close();
		setAgentDir(previousAgentDir);
	}

	if (!captured || !installedRegistry) {
		throw new Error("Main root creation was not reached");
	}
	return { options: captured, installedRegistry, expectedDurableState };
}

describe("Main durable registry startup", () => {
	it("installs the registry backed by the resolved persisted session before root creation", async () => {
		const { options, installedRegistry, expectedDurableState } = await captureMainRootOptions(false);
		const sessionManager = options.sessionManager;
		if (!sessionManager?.getSessionFile()) throw new Error("Expected a persisted Main session file");
		const header = sessionManager.getHeader();

		expect(options.agentRegistry).toBe(installedRegistry);
		expect(expectedDurableState).toBe(installedRegistry.getDurableStateStore());
		expect(expectedDurableState?.identity.owningSessionId).toBe(header?.id);
		expect(header?.id).toBe(sessionManager.getSessionId());
	});

	it("uses a storeless unrestricted projection for --no-session", async () => {
		const { options, installedRegistry } = await captureMainRootOptions(true);

		expect(options.sessionManager?.getSessionFile()).toBeUndefined();
		expect(options.agentRegistry).toBe(installedRegistry);
		expect(installedRegistry.getDurableStateStore()).toBeUndefined();
	});

	it("completes normal persisted startup and drains the real root before closing its authority", async () => {
		using tempDir = TempDir.createSync("@omp-main-successful-root-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const rawArgs = ["--print", "hello"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const modelRefresh = refreshModelsOffline();
		let created: AgentSession | undefined;
		let store: AuthorityStore | undefined;
		let sessionFile: string | undefined;
		let authorityOpenAfterDisposal = false;
		const prompt = vi.fn(async () => true);
		try {
			await runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options?.agentRegistry || !options.sessionManager) throw new Error("Missing root options");
					store = options.agentRegistry.getDurableStateStore();
					sessionFile = options.sessionManager.getSessionFile();
					const result = await createAgentRootSession(options.agentRegistry, {
						...options,
						model: offlineModel(authStorage),
						cacheWarming: false,
						bindProcessState: false,
						enableMCP: false,
						enableIrc: false,
					});
					created = result.session;
					created.prompt = prompt;
					const dispose = created.dispose.bind(created);
					created.dispose = async (...args) => {
						await dispose(...args);
						if (!store) throw new Error("Missing root authority");
						await store.getRoot("shutdown-probe");
						authorityOpenAfterDisposal = true;
					};
					return result;
				},
			});
			if (!created || !store || !sessionFile) throw new Error("Expected a constructed persisted root");
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(created.isDisposed).toBe(true);
			expect(authorityOpenAfterDisposal).toBe(true);
			await expect(store.getRoot("shutdown-probe")).rejects.toThrow(/closed|quiescing/i);
			expect(quit).toHaveBeenCalledWith(0);
		} finally {
			quit.mockRestore();
			try {
				if (created && !created.isDisposed) await disposeRootSession(created);
				if (sessionFile) await closeSessionAuthority(sessionFile);
			} finally {
				modelRefresh.mockRestore();
				authStorage.close();
				setAgentDir(previousAgentDir);
			}
		}
	});
});

it("propagates the exact print persistence failure when real root finalization is incomplete", async () => {
	using tempDir = TempDir.createSync("@omp-main-print-incomplete-root-");
	const previousAgentDir = getAgentDir();
	setAgentDir(tempDir.path());
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const rawArgs = ["--print", "hello"];
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
	const modelRefresh = refreshModelsOffline();
	const persistenceError = Object.assign(new Error("ENOSPC: root transcript write failed"), { code: "ENOSPC" });
	let created: AgentSession | undefined;
	let store: AuthorityStore | undefined;
	let sessionManager: SessionManager | undefined;
	let sessionFile: string | undefined;
	let disposeCalls = 0;
	let managerCloseCalls = 0;
	let draftCleanupReleaseCalls = 0;
	let retainedMemoryResetCalls = 0;
	let restoreManagerOverrides: (() => void) | undefined;
	let restoreAgentReset: (() => void) | undefined;
	let restoreWriteFailure: (() => void) | undefined;

	try {
		await expect(
			runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options?.agentRegistry || !options.sessionManager) throw new Error("Missing root options");
					store = options.agentRegistry.getDurableStateStore();
					const manager = options.sessionManager;
					sessionManager = manager;
					sessionFile = manager.getSessionFile();
					const closeManager = manager.close.bind(manager);
					const deferDraftCleanup = manager.deferDraftCleanup.bind(manager);
					manager.close = async () => {
						managerCloseCalls++;
						await closeManager();
					};
					manager.deferDraftCleanup = () => {
						const release = deferDraftCleanup();
						return async () => {
							draftCleanupReleaseCalls++;
							await release();
						};
					};
					restoreManagerOverrides = () => {
						manager.close = closeManager;
						manager.deferDraftCleanup = deferDraftCleanup;
					};
					const result = await createAgentRootSession(options.agentRegistry, {
						...options,
						model: offlineModel(authStorage),
						cacheWarming: false,
						bindProcessState: false,
						enableMCP: false,
						enableIrc: false,
					});
					const rootSession = result.session;
					created = rootSession;
					const dispose = rootSession.dispose.bind(rootSession);
					rootSession.dispose = (...args: Parameters<AgentSession["dispose"]>) => {
						disposeCalls++;
						return dispose(...args);
					};
					const reset = rootSession.agent.reset.bind(rootSession.agent);
					rootSession.agent.reset = (...args: Parameters<AgentSession["agent"]["reset"]>) => {
						retainedMemoryResetCalls++;
						return reset(...args);
					};
					restoreAgentReset = () => {
						rootSession.agent.reset = reset;
					};
					rootSession.prompt = async () => {
						const writeFailure = vi.spyOn(fsSync, "writeSync").mockImplementation(() => {
							throw persistenceError;
						});
						restoreWriteFailure = () => writeFailure.mockRestore();
						manager.appendMessage({
							role: "user",
							content: "trigger persisted root teardown failure",
							timestamp: Date.now(),
						});
						return true;
					};
					return result;
				},
			}),
		).rejects.toBe(persistenceError);

		if (!created || !store || !sessionManager || !sessionFile) throw new Error("Expected a real persisted root");
		expect(sessionManager.getPersistenceError()).toBe(persistenceError);
		expect(created.isDisposed).toBe(true);
		expect(disposeCalls).toBe(1);
		expect(managerCloseCalls).toBe(1);
		expect(retainedMemoryResetCalls).toBe(0);
		expect(draftCleanupReleaseCalls).toBe(0);
		await expect(store.getRoot("shutdown-probe")).resolves.toBeUndefined();
		expect(quit).not.toHaveBeenCalled();
	} finally {
		restoreWriteFailure?.();
		restoreAgentReset?.();
		restoreManagerOverrides?.();
		quit.mockRestore();
		try {
			if (managerCloseCalls === 0) await sessionManager?.close();
			if (sessionFile) await closeSessionAuthority(sessionFile);
		} finally {
			modelRefresh.mockRestore();
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	}
});

it("finishes real root teardown after print persistence recovers before close", async () => {
	using tempDir = TempDir.createSync("@omp-main-print-recovered-root-");
	const previousAgentDir = getAgentDir();
	setAgentDir(tempDir.path());
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const rawArgs = ["--print", "hello"];
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
	const modelRefresh = refreshModelsOffline();
	const persistenceError = Object.assign(new Error("ENOSPC: transient root transcript write failed"), {
		code: "ENOSPC",
	});
	let created: AgentSession | undefined;
	let store: AuthorityStore | undefined;
	let sessionManager: SessionManager | undefined;
	let sessionFile: string | undefined;
	let resetCalls = 0;
	let restoreAgentReset: (() => void) | undefined;
	let restoreWriteFailure: (() => void) | undefined;

	try {
		await runRootCommand(parsed, rawArgs, {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async options => {
				if (!options?.agentRegistry || !options.sessionManager) throw new Error("Missing root options");
				store = options.agentRegistry.getDurableStateStore();
				const manager = options.sessionManager;
				sessionManager = manager;
				sessionFile = manager.getSessionFile();
				const result = await createAgentRootSession(options.agentRegistry, {
					...options,
					model: offlineModel(authStorage),
					cacheWarming: false,
					bindProcessState: false,
					enableMCP: false,
					enableIrc: false,
				});
				const rootSession = result.session;
				created = rootSession;
				const reset = rootSession.agent.reset.bind(rootSession.agent);
				rootSession.agent.reset = (...args: Parameters<AgentSession["agent"]["reset"]>) => {
					resetCalls++;
					return reset(...args);
				};
				restoreAgentReset = () => {
					rootSession.agent.reset = reset;
				};
				rootSession.prompt = async () => {
					const writeFailure = vi.spyOn(fsSync, "writeSync").mockImplementationOnce(() => {
						throw persistenceError;
					});
					restoreWriteFailure = () => writeFailure.mockRestore();
					manager.appendMessage({
						role: "user",
						content: "trigger recoverable persistence failure",
						timestamp: Date.now(),
					});
					await manager.recoverPersistenceFromCurrentState();
					return true;
				};
				return result;
			},
		});

		if (!created || !store || !sessionManager || !sessionFile) throw new Error("Expected a real persisted root");
		expect(sessionManager.getPersistenceError()).toBeUndefined();
		expect(created.isDisposed).toBe(true);
		expect(resetCalls).toBeGreaterThan(0);
		await expect(store.getRoot("shutdown-probe")).rejects.toThrow(/closed|quiescing/i);
		expect(quit).toHaveBeenCalledWith(0);
	} finally {
		restoreWriteFailure?.();
		restoreAgentReset?.();
		quit.mockRestore();
		try {
			if (created && !created.isDisposed) await disposeRootSession(created);
			if (sessionFile) await closeSessionAuthority(sessionFile);
		} finally {
			modelRefresh.mockRestore();
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	}
});

it("propagates a distinct root disposal failure without retrying or closing authority", async () => {
	using tempDir = TempDir.createSync("@omp-main-print-distinct-root-failure-");
	const previousAgentDir = getAgentDir();
	setAgentDir(tempDir.path());
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const rawArgs = ["--print", "hello"];
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
	const modelRefresh = refreshModelsOffline();
	const disposalError = new Error("distinct root disposal failure");
	let created: AgentSession | undefined;
	let store: AuthorityStore | undefined;
	let sessionFile: string | undefined;
	let disposeCalls = 0;
	let resetCalls = 0;
	let restoreAgentReset: (() => void) | undefined;

	try {
		await expect(
			runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options?.agentRegistry || !options.sessionManager) throw new Error("Missing root options");
					store = options.agentRegistry.getDurableStateStore();
					sessionFile = options.sessionManager.getSessionFile();
					const result = await createAgentRootSession(options.agentRegistry, {
						...options,
						model: offlineModel(authStorage),
						cacheWarming: false,
						bindProcessState: false,
						enableMCP: false,
						enableIrc: false,
					});
					const rootSession = result.session;
					created = rootSession;
					const reset = rootSession.agent.reset.bind(rootSession.agent);
					rootSession.agent.reset = (...args: Parameters<AgentSession["agent"]["reset"]>) => {
						resetCalls++;
						return reset(...args);
					};
					restoreAgentReset = () => {
						rootSession.agent.reset = reset;
					};
					const dispose = rootSession.dispose.bind(rootSession);
					rootSession.dispose = async (...args: Parameters<AgentSession["dispose"]>) => {
						disposeCalls++;
						await dispose(...args);
						throw disposalError;
					};
					rootSession.prompt = async () => true;
					return result;
				},
			}),
		).rejects.toBe(disposalError);

		if (!created || !store || !sessionFile) throw new Error("Expected a real persisted root");
		expect(created.isDisposed).toBe(true);
		expect(disposeCalls).toBe(1);
		expect(resetCalls).toBeGreaterThan(0);
		await expect(store.getRoot("shutdown-probe")).resolves.toBeUndefined();
		expect(quit).not.toHaveBeenCalled();
	} finally {
		restoreAgentReset?.();
		quit.mockRestore();
		try {
			if (created && !created.isDisposed) await disposeRootSession(created);
			if (sessionFile) await closeSessionAuthority(sessionFile);
		} finally {
			modelRefresh.mockRestore();
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	}
});

describe("Main durable registry startup cleanup", () => {
	for (const noSession of [false, true]) {
		it(`disposes a successfully constructed ${noSession ? "storeless" : "persisted"} root when later setup fails`, async () => {
			using tempDir = TempDir.createSync("@omp-main-created-root-");
			const previousAgentDir = getAgentDir();
			setAgentDir(tempDir.path());
			const authStorage = await AuthStorage.create(":memory:");
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			const rawArgs = noSession ? ["--no-session", "--print", "hello"] : ["--print", "hello"];
			const parsed = parseArgs(rawArgs);
			parsed.noExtensions = true;
			parsed.noSkills = true;
			parsed.noRules = true;
			parsed.noTools = true;
			parsed.noLsp = true;
			const modelRefresh = refreshModelsOffline();
			const setupFailure = new Error("failure after real root construction");
			let created: AgentSession | undefined;
			let store: AuthorityStore | undefined;
			let sessionFile: string | undefined;
			let authorityOpenAfterDisposal = false;
			try {
				await expect(
					runRootCommand(parsed, rawArgs, {
						discoverAuthStorage: async () => authStorage,
						settings,
						createAgentSession: async options => {
							if (!options?.agentRegistry || !options.sessionManager) throw new Error("Missing root options");
							store = options.agentRegistry.getDurableStateStore();
							sessionFile = options.sessionManager.getSessionFile();
							const result = await createAgentRootSession(options.agentRegistry, {
								...options,
								model: offlineModel(authStorage),
								cacheWarming: false,
								bindProcessState: false,
								enableMCP: false,
								enableIrc: false,
							});
							created = result.session;
							const dispose = created.dispose.bind(created);
							created.dispose = async (...args) => {
								await dispose(...args);
								if (store) {
									await store.getRoot("shutdown-probe");
									authorityOpenAfterDisposal = true;
								}
							};
							created.validateRetryFallbackChains = () => {
								throw setupFailure;
							};
							return result;
						},
					}),
				).rejects.toBe(setupFailure);
				if (!created) throw new Error("Root construction was not reached");
				expect(created.isDisposed).toBe(true);
				if (noSession) {
					expect(store).toBeUndefined();
					expect(sessionFile).toBeUndefined();
				} else {
					if (!store || !sessionFile) throw new Error("Expected persisted root authority");
					expect(authorityOpenAfterDisposal).toBe(true);
					await expect(store.getRoot("shutdown-probe")).rejects.toThrow(/closed|quiescing/i);
				}
			} finally {
				try {
					if (created && !created.isDisposed) await disposeRootSession(created);
					if (sessionFile) await closeSessionAuthority(sessionFile);
				} finally {
					modelRefresh.mockRestore();
					authStorage.close();
					setAgentDir(previousAgentDir);
				}
			}
		});
	}
});

describe("Compression authority session factory", () => {
	it("returns usable protocol-only tools and closes authority after real root disposal", async () => {
		using tempDir = TempDir.createSync("@omp-compress-authority-root-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const settingsInit = vi.spyOn(Settings, "init").mockResolvedValue(settings);
		const discoverAuth = vi.spyOn(sdk, "discoverAuthStorage").mockResolvedValue(authStorage);
		const refreshOffline = refreshModelsOffline();
		offlineModel(authStorage);
		const protocol = new CompressProtocol("Retain exact session identities and close authority last.");
		let session: AgentSession | undefined;
		try {
			({ session } = await createCompressSession({
				cwd: tempDir.path(),
				protocol,
				model: "anthropic/claude-sonnet-4-5",
			}));
			const sessionFile = session.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted compression root");
			const store = await registryDurableStateForSession(sessionFile, {
				owningSessionId: session.sessionManager.getSessionId(),
				create: false,
			});
			expect(session.isDisposed).toBe(false);
			expect(session.getActiveToolNames().sort()).toEqual(["approve", "rewrite"]);
			expect(() => session!.setForcedToolChoice("bash")).toThrow(/not currently active/i);
			const rewrite = session.agent.state.tools.find(tool => tool.name === "rewrite");
			const approve = session.agent.state.tools.find(tool => tool.name === "approve");
			if (!rewrite || !approve) throw new Error("Compression protocol tools are unavailable");
			await rewrite.execute("compress-rewrite", { text: "Keep identities; close authority last.", losses: [] });
			expect(protocol.latest).toMatchObject({
				round: 1,
				text: "Keep identities; close authority last.",
				losses: [],
			});
			protocol.markReviewed(1);
			await approve.execute("compress-approve", { verdict: "Both requirements remain intact." });
			expect(protocol.approved).toBe(true);
			expect(protocol.verdict).toBe("Both requirements remain intact.");

			let authorityOpenDuringDisposal = false;
			session.addDisposer(async () => {
				await store.getRoot("shutdown-probe");
				authorityOpenDuringDisposal = true;
			});
			const disposal = session.dispose();
			expect(session.dispose()).toBe(disposal);
			await disposal;
			expect(session.isDisposed).toBe(true);
			expect(authorityOpenDuringDisposal).toBe(true);
			await expect(store.getRoot("shutdown-probe")).rejects.toThrow(/closed|quiescing/i);
		} finally {
			try {
				await session?.dispose();
			} finally {
				settingsInit.mockRestore();
				discoverAuth.mockRestore();
				refreshOffline.mockRestore();
				authStorage.close();
				setAgentDir(previousAgentDir);
			}
		}
	});
});

describe("authority root shutdown", () => {
	it("drains real root registry work before closing authority and releasing an armed draft", async () => {
		using tempDir = TempDir.createSync("@omp-main-root-close-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const modelRefresh = refreshModelsOffline();
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(process.cwd(), path.join(tempDir.path(), "sessions"));
		await sessionManager.saveDraft("draft retained until durable root teardown completes");
		await sessionManager.consumeDraft();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted root session");
		const header = sessionManager.getHeader();
		if (!header) throw new Error("Expected a root session header");
		let authorityStore: AuthorityStore | undefined;
		let session: AgentSession | undefined;
		let transcriptRetainedAfterRegistryDisposal = false;
		let authorityRemainedOpenAfterRegistryDisposal = false;

		try {
			authorityStore = await registryDurableStateForSession(sessionFile, {
				backend: "jsonl",
				owningSessionId: header.id,
				create: true,
			});
			const agentRegistry = await AgentRegistry.create({ durableState: authorityStore });
			({ session } = await createAgentRootSession(agentRegistry, {
				cwd: process.cwd(),
				sessionManager,
				authStorage,
				modelRegistry,
				model: offlineModel(authStorage),
				settings,
				cacheWarming: false,
				bindProcessState: false,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				hasUI: false,
				autoTitle: false,
				restrictToolNames: true,
				toolNames: [],
				customTools: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				systemPrompt: [],
			}));
			const completeAgentDisposal = session.dispose.bind(session);
			let forwardedDisposeOptions: { drainTimeoutMs?: number } | undefined;
			session.dispose = async (...args) => {
				forwardedDisposeOptions = args[0];
				await completeAgentDisposal(...args);
				transcriptRetainedAfterRegistryDisposal = await Bun.file(sessionFile).exists();
				const currentStore = await registryDurableStateForSession(sessionFile, {
					backend: "jsonl",
					owningSessionId: header.id,
					create: false,
				});
				authorityRemainedOpenAfterRegistryDisposal = currentStore === authorityStore;
			};
			attachRootAuthorityDisposal(session, sessionFile);
			const disposeOptions = { drainTimeoutMs: 0 };
			await session.dispose(disposeOptions);

			expect(forwardedDisposeOptions).toBe(disposeOptions);
			expect(transcriptRetainedAfterRegistryDisposal).toBe(true);
			expect(authorityRemainedOpenAfterRegistryDisposal).toBe(true);
			expect(await Bun.file(sessionFile).exists()).toBe(false);
		} finally {
			try {
				await closeSessionAuthority(sessionFile);
				await sessionManager.close();
			} finally {
				modelRefresh.mockRestore();
				authStorage.close();
				setAgentDir(previousAgentDir);
			}
		}
	});
});

describe("Main durable resume remediation", () => {
	it("prints repair and fresh-process guidance for a quarantined authority store", async () => {
		using tempDir = TempDir.createSync("@omp-main-resume-remediation-");
		const previousAgentDir = getAgentDir();
		const agentDir = await fs.mkdtemp(path.join(tempDir.path(), "agent dir 'quoted' "));
		setAgentDir(agentDir);
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const sessionManager = SessionManager.create(process.cwd(), path.join(agentDir, "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted test session");
		const header = sessionManager.getHeader();
		if (!header) throw new Error("Expected a session header");
		await sessionManager.ensureOnDisk();
		const store = await registryDurableStateForSession(sessionFile, {
			backend: "jsonl",
			owningSessionId: header.id,
			create: true,
		});
		// `await expect(p).rejects` starves the authority worker replies this call still needs on Bun 1.4.4.
		const quarantineOutcome = await store.quarantine("test quarantine").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(() => {
			throw quarantineOutcome;
		}).toThrow("test quarantine");
		await store.close();
		await closeSessionAuthority(sessionFile);
		await sessionManager.close();

		const parsed = parseArgs(["--resume", sessionFile, "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`EXIT:${code ?? 0}`);
		}) as never);
		const stderr: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);

		try {
			await expect(
				runRootCommand(parsed, ["--resume", sessionFile, "--print", "hello"], {
					discoverAuthStorage: async () => authStorage,
					settings,
				}),
			).rejects.toThrow("EXIT:1");
		} finally {
			stderrSpy.mockRestore();
			exit.mockRestore();
			await closeSessionAuthority(sessionFile);
			authStorage.close();
			setAgentDir(previousAgentDir);
		}

		expect(stderr.join(" ")).toContain("omp session repair");
		expect(stderr.join(" ")).toContain("--apply");
		expect(stderr.join(" ")).toContain("fresh process");
		expect(stderr.join(" ")).toContain("omp session repair '");
		expect(stderr.join(" ")).toContain("'\\''");
		// The diagnosis and the repair instruction are separate lines, not one line with an escaped "\n".
		const guidance = stderr.join("");
		expect(guidance).not.toContain("\\n");
		expect(guidance).toMatch(/^Unable to resume [^\n]*test quarantine\nRun omp session repair '/m);
		expect(guidance.endsWith("Start a fresh process after repair.\n")).toBe(true);
		expect(AgentRegistry.global()).toBe(priorRegistry);
	});
});

describe("Main resume after an interrupted migration", () => {
	it("refuses with one line naming the recovery command, not an uncaught error dump", async () => {
		using tempDir = TempDir.createSync("@omp-main-resume-migration-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const sessionManager = SessionManager.create(process.cwd(), path.join(tempDir.path(), "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		const header = sessionManager.getHeader();
		if (!sessionFile || !header) throw new Error("Expected a persisted test session");
		await sessionManager.ensureOnDisk();
		const store = await registryDurableStateForSession(sessionFile, {
			backend: "jsonl",
			owningSessionId: header.id,
			create: true,
		});
		await store.close();
		await closeSessionAuthority(sessionFile);
		await sessionManager.close();
		const interrupted = await migrateAuthority(sessionFile, "sqlite", { apply: true, faultAt: "target-staged" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(interrupted).toBeInstanceOf(Error);

		const argv = ["--resume", sessionFile, "--print", "hello"];
		const parsed = parseArgs(argv);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`EXIT:${code ?? 0}`);
		}) as never);
		const stderr: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
		let outcome: unknown;
		try {
			outcome = await runRootCommand(parsed, argv, { discoverAuthStorage: async () => authStorage, settings }).then(
				() => undefined,
				(error: unknown) => error,
			);
		} finally {
			stderrSpy.mockRestore();
			exit.mockRestore();
			await closeSessionAuthority(sessionFile);
			authStorage.close();
			setAgentDir(previousAgentDir);
		}

		expect((outcome as Error | undefined)?.message).toBe("EXIT:1");
		const text = stderr.join("");
		expect(text.endsWith("\n")).toBe(true);
		expect(text.trimEnd().split("\n")).toHaveLength(1);
		expect(text).toStartWith(`Unable to resume ${sessionFile}: `);
		expect(text).toContain(sessionAuthorityCommand(sessionFile, "--recover finish"));
	});

	it("refuses a store left initializing by a crash during first creation with one line naming --recover abort", async () => {
		using tempDir = TempDir.createSync("@omp-main-resume-initializing-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const sessionManager = SessionManager.create(process.cwd(), path.join(tempDir.path(), "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		const header = sessionManager.getHeader();
		if (!sessionFile || !header) throw new Error("Expected a persisted test session");
		await sessionManager.ensureOnDisk();
		const store = await registryDurableStateForSession(sessionFile, {
			backend: "jsonl",
			owningSessionId: header.id,
			create: true,
		});
		await store.close();
		await closeSessionAuthority(sessionFile);
		await sessionManager.close();
		// A kill inside the first open leaves the rev-1 initializing descriptor and no migration evidence.
		const descriptorPath = `${sessionFile}.authority.json`;
		const active = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as Record<string, unknown>;
		await fs.writeFile(descriptorPath, `${JSON.stringify({ ...active, revision: 1, state: "initializing" })}\n`, {
			mode: 0o600,
		});

		const argv = ["--resume", sessionFile, "--print", "hello"];
		const parsed = parseArgs(argv);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`EXIT:${code ?? 0}`);
		}) as never);
		const stderr: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
		let outcome: unknown;
		try {
			outcome = await runRootCommand(parsed, argv, { discoverAuthStorage: async () => authStorage, settings }).then(
				() => undefined,
				(error: unknown) => error,
			);
		} finally {
			stderrSpy.mockRestore();
			exit.mockRestore();
			await closeSessionAuthority(sessionFile);
			authStorage.close();
			setAgentDir(previousAgentDir);
		}

		expect((outcome as Error | undefined)?.message).toBe("EXIT:1");
		const text = stderr.join("");
		expect(text.trimEnd().split("\n")).toHaveLength(1);
		expect(text).toStartWith(`Unable to resume ${sessionFile}: `);
		expect(text).toContain(sessionAuthorityCommand(sessionFile, "--recover abort"));
		expect(text).not.toContain("--recover finish");
		// The named command is the one that recovers this shape.
		expect(await recoverAbandonedAuthorityInitialization(sessionFile, "abort")).toBe(true);
	});
});

describe("root allocation evidence", () => {
	it("signals explicit root allocations but not an empty --continue fallback", async () => {
		using tempDir = TempDir.createSync("@omp-root-allocation-evidence-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(cwd, { recursive: true });
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let freshManager: SessionManager | undefined;
		let autoResumedManager: SessionManager | undefined;
		let continuedManager: SessionManager | undefined;
		try {
			const explicitAllocation = vi.fn();
			freshManager = await createSessionManager(parseArgs(["--session-dir", sessionDir]), cwd, settings, undefined, {
				onNewRoot: explicitAllocation,
			});
			if (!freshManager) throw new Error("Expected an explicitly allocated root manager");
			expect(explicitAllocation).toHaveBeenCalledTimes(1);
			expect(explicitAllocation).toHaveBeenCalledWith(freshManager);

			const emptyContinueAllocation = vi.fn();
			continuedManager = await createSessionManager(
				parseArgs(["--continue", "--session-dir", sessionDir]),
				cwd,
				settings,
				undefined,
				{ onNewRoot: emptyContinueAllocation },
			);
			if (!continuedManager) throw new Error("Expected a manager from empty --continue");
			expect(continuedManager.getSessionId()).not.toBe(freshManager.getSessionId());
			expect(emptyContinueAllocation).not.toHaveBeenCalled();

			const autoResumeAllocation = vi.fn();
			autoResumedManager = await createSessionManager(
				parseArgs([]),
				cwd,
				Settings.isolated({ "marketplace.autoUpdate": "off", autoResume: true }),
				undefined,
				{ onNewRoot: autoResumeAllocation },
			);
			if (!autoResumedManager) throw new Error("Expected a manager from empty implicit auto-resume");
			expect(autoResumeAllocation).not.toHaveBeenCalled();
		} finally {
			try {
				await autoResumedManager?.close();
				await continuedManager?.close();
			} finally {
				setAgentDir(previousAgentDir);
			}
		}
	});

	it("does not send empty --continue roots to the opener as fresh allocations", async () => {
		using tempDir = TempDir.createSync("@omp-main-continue-allocation-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const rawArgs = ["--continue", "--session-dir", path.join(tempDir.path(), "sessions"), "--print", "hello"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const stop = new Error("stop after selected opener options");
		let requestedCreate: boolean | undefined;
		let closeCalls = 0;

		try {
			await expect(
				runRootCommand(parsed, rawArgs, {
					discoverAuthStorage: async () => authStorage,
					settings,
					openAuthority: async (_sessionFile, options) => {
						if (!options) throw new Error("Missing authority opener options");
						requestedCreate = options.create;
						throw stop;
					},
					closeAuthority: async () => {
						closeCalls++;
					},
				}),
			).rejects.toBe(stop);
			expect(requestedCreate).toBe(false);
			expect(closeCalls).toBe(1);
		} finally {
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});
});

describe("ACP host authority startup", () => {
	it("does not allocate a preliminary root before the per-session factory runs", async () => {
		using tempDir = TempDir.createSync("@omp-main-acp-host-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const rawArgs = ["--mode", "acp"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const createManager = vi.fn(async () => {
			throw new Error("ACP host must not create a preliminary session manager");
		});
		const openAuthority = vi.fn(async () => {
			throw new Error("ACP host must not open a preliminary authority store");
		});
		const stop = new Error("stop after ACP host bootstrap");

		try {
			await expect(
				runRootCommand(parsed, rawArgs, {
					discoverAuthStorage: async () => authStorage,
					settings,
					createSessionManager: createManager,
					openAuthority,
					runAcpMode: async () => {
						throw stop;
					},
				}),
			).rejects.toBe(stop);
			expect(createManager).not.toHaveBeenCalled();
			expect(openAuthority).not.toHaveBeenCalled();
		} finally {
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});
});

describe("ACP authority session factory", () => {
	it("returns the real created root session and its UI-context setter to the ACP owner", async () => {
		using tempDir = TempDir.createSync("@omp-main-acp-handle-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const modelRefresh = refreshModelsOffline();
		const modelRegistry = new ModelRegistry(authStorage);
		let sessionFile: string | undefined;
		let sessionManager: SessionManager | undefined;
		let createdResult: CreateAgentSessionResult | undefined;
		let authorityStore: AuthorityStore | undefined;

		try {
			const factory = createAcpSessionFactory({
				baseOptions: {
					cwd: process.cwd(),
					settings,
					authStorage,
					modelRegistry,
					model: offlineModel(authStorage),
					cacheWarming: false,
					bindProcessState: false,
					disableExtensionDiscovery: true,
					enableMCP: false,
					enableIrc: false,
					enableLsp: false,
					hasUI: false,
					autoTitle: false,
					restrictToolNames: true,
					toolNames: [],
					customTools: [],
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					systemPrompt: [],
				},
				settings,
				sessionDir: path.join(tempDir.path(), "sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { apiKey: undefined, trustedExtensions: undefined, tools: undefined, invalidFlagValues: [] },
				rawArgs: [],
				createSession: async options => {
					sessionManager = options.sessionManager;
					if (!sessionManager) throw new Error("ACP factory did not pass its session manager");
					sessionFile = sessionManager.getSessionFile();
					const registry = options.agentRegistry;
					if (!registry) throw new Error("ACP factory did not pass its isolated registry");
					authorityStore = registry.getDurableStateStore();
					createdResult = await createAgentRootSession(registry, options);
					return createdResult;
				},
			});

			const handle = await factory(process.cwd());
			const resumedSessionFile = sessionFile;
			const createdManager = sessionManager;
			if (!resumedSessionFile) throw new Error("Expected a persisted ACP session file");
			if (!createdManager) throw new Error("Expected a persisted ACP session manager");
			if (!createdResult) throw new Error("Expected a real ACP session result");
			expect(handle.session).toBe(createdResult.session);
			expect(handle.setToolUIContext).toBe(createdResult.setToolUIContext);
			expect(handle.session.sessionManager).toBe(createdManager);
			expect(handle.session.isDisposed).toBe(false);
			await handle.session.dispose();
			expect(handle.session.isDisposed).toBe(true);
			if (!authorityStore) throw new Error("Expected ACP root authority");
			await expect(authorityStore.getRoot("shutdown-probe")).rejects.toThrow(/closed|quiescing/i);
			expect(await Bun.file(resumedSessionFile).exists()).toBe(true);
			const resumed = await SessionManager.open(resumedSessionFile);
			try {
				expect(resumed.getSessionId()).toBe(createdManager.getSessionId());
			} finally {
				await resumed.close();
			}
		} finally {
			try {
				if (createdResult) await disposeRootSession(createdResult.session);
				else if (sessionFile) {
					await closeSessionAuthority(sessionFile);
					await sessionManager?.close();
				}
			} finally {
				modelRefresh.mockRestore();
				authStorage.close();
				setAgentDir(previousAgentDir);
			}
		}
	});
});

describe("root startup cleanup after attempted authority open", () => {
	it("retains an armed draft when both open and outcome-aware authority cleanup fail", async () => {
		using tempDir = TempDir.createSync("@omp-main-rejected-open-cleanup-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		const sessionManager = SessionManager.create(process.cwd(), path.join(tempDir.path(), "sessions"));
		await sessionManager.saveDraft("draft that must remain recoverable");
		await sessionManager.consumeDraft();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted root session");
		const closeManager = vi.spyOn(sessionManager, "close");
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(["--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const openFailure = new Error("authority open outcome is unknown");
		const closeFailure = new Error("authority outcome cleanup failed");
		let openCalls = 0;
		let closeCalls = 0;

		try {
			await expect(
				runRootCommand(parsed, ["--print", "hello"], {
					discoverAuthStorage: async () => authStorage,
					settings,
					createSessionManager: async (_parsed, _cwd, _settings, _ask, options) => {
						options?.onNewRoot?.(sessionManager);
						return sessionManager;
					},
					openAuthority: async () => {
						openCalls++;
						throw openFailure;
					},
					closeAuthority: async () => {
						closeCalls++;
						throw closeFailure;
					},
				}),
			).rejects.toThrow("cleanup was incomplete");

			expect(openCalls).toBe(1);
			expect(closeCalls).toBe(1);
			expect(closeManager).not.toHaveBeenCalled();
			expect((await fs.stat(sessionFile)).isFile()).toBe(true);
		} finally {
			closeManager.mockRestore();
			try {
				await closeSessionAuthority(sessionFile);
				await sessionManager.close();
			} finally {
				authStorage.close();
				setAgentDir(previousAgentDir);
			}
		}
	});
});
