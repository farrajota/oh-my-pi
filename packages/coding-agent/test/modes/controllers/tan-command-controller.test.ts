import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { AsyncJobRegisterOptions } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import { createAgentRootSession, lookupAgentRef } from "../../../src/internal/agent-registry-bridge";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry, MAIN_AGENT_ID, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface CapturedJobRunContext {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
}

type CapturedJobRun = (ctx: CapturedJobRunContext) => Promise<string>;

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;
const rootSessions: Array<{ dispose: () => Promise<void> }> = [];

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

interface TanSessionEvent {
	type: string;
	result?: unknown;
	aborted?: boolean;
}
interface TanCloneStub {
	clone: object;
	attachSessionManager(sessionManager: CreateAgentSessionOptions["sessionManager"]): void;
}

function createCloneStub(overrides?: {
	prompt?: () => Promise<void>;
	abort?: () => void;
	sessionManager?: { appendSessionInit: (init: unknown) => void };
	lastAssistantText?: string;
	activeToolNames?: string[];
	enabledToolNames?: string[];
}) {
	const appendMessage = vi.fn();
	const dispose = vi.fn(async () => {});
	let listener: ((event: TanSessionEvent) => void) | undefined;
	const clone = {
		agent: { appendMessage },
		sessionManager: undefined as CreateAgentSessionOptions["sessionManager"],
		setTodoPhases: vi.fn(),
		getActiveToolNames: vi.fn(() => overrides?.activeToolNames ?? ["read", "bash"]),
		getEnabledToolNames: vi.fn(() => overrides?.enabledToolNames ?? overrides?.activeToolNames ?? ["read", "bash"]),
		subscribe: vi.fn((l: (event: TanSessionEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		}),
		prompt: vi.fn(overrides?.prompt ?? (async () => {})),
		waitForIdle: vi.fn(async () => {}),
		getLastAssistantMessage: vi.fn(() => assistantText(overrides?.lastAssistantText ?? "done")),
		abort: vi.fn(overrides?.abort ?? (() => {})),
		dispose,
	};
	return {
		clone,
		dispose,
		appendMessage,
		attachSessionManager(sessionManager: CreateAgentSessionOptions["sessionManager"]) {
			if (!sessionManager) throw new Error("Tan test session requires a session manager");
			const fixtureSessionManager = Object.assign(
				{ getSessionFile: sessionManager.getSessionFile.bind(sessionManager) },
				overrides?.sessionManager,
			);
			clone.sessionManager = fixtureSessionManager as CreateAgentSessionOptions["sessionManager"];
		},
		get compactionListener() {
			return listener;
		},
	};
}

function mockTanSessionCreation(
	stub: TanCloneStub,
	onCreate?: (options: CreateAgentSessionOptions) => void,
) {
	return vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("Tan test session requires create options");
		onCreate?.(options);
		stub.attachSessionManager(options.sessionManager);
		return { session: stub.clone } as unknown as CreateAgentSessionResult;
	});
}

async function createContext(overrides?: {
	isStreaming?: boolean;
	model?: Model;
	agentId?: string;
	parentPromptCacheKey?: string;
	register?: (run: CapturedJobRun, options?: AsyncJobRegisterOptions) => string;
	activeToolNames?: string[];
	enabledToolNames?: string[];
	preparedExtensions?: unknown;
	effectiveExtensionRoots?: unknown;
	extensionPaths?: unknown;
}) {
	const tempDir = TempDir.createSync("@omp-tan-controller-");
	const parentFile = path.join(tempDir.path(), "parent.jsonl");
	// The clone nests inside the parent's artifact directory, like a subagent.
	const cloneFile = path.join(parentFile.slice(0, -6), "clone.jsonl");
	let capturedRun: CapturedJobRun | undefined;
	let capturedOptions: AsyncJobRegisterOptions | undefined;
	const sequence: string[] = [];
	const register = vi.fn(
		(_type: "bash" | "task", _label: string, run: CapturedJobRun, options?: AsyncJobRegisterOptions): string => {
			sequence.push("register");
			capturedRun = run;
			capturedOptions = options;
			return overrides?.register ? overrides.register(run, options) : "job-123";
		},
	);
	const session = {
		isStreaming: overrides?.isStreaming ?? false,
		agent: { promptCacheKey: overrides?.parentPromptCacheKey },
		model: overrides?.model ?? model,
		asyncJobManager: { register },
		sessionId: "parent-session",
		configuredThinkingLevel: vi.fn(() => undefined),
		systemPrompt: ["system prompt"],
		getActiveToolNames: vi.fn(() => overrides?.activeToolNames ?? ["read", "bash"]),
		getEnabledToolNames: vi.fn(() => overrides?.enabledToolNames ?? overrides?.activeToolNames ?? ["read", "bash"]),
		modelRegistry: { authStorage: { marker: "auth" } },
		preparedExtensions: overrides?.preparedExtensions,
		effectiveExtensionRoots: overrides?.effectiveExtensionRoots,
		extensionPaths: overrides?.extensionPaths,
		getAgentId: vi.fn(() => overrides?.agentId),
		sendCustomMessage: vi.fn(async () => {
			sequence.push("sendCustomMessage");
		}),
	} as unknown as InteractiveModeContext["session"];
	const parentArtifactsDir = parentFile.slice(0, -6);
	const getArtifactsDir = vi.fn(() => parentArtifactsDir);
	const getSessionId = vi.fn(() => "parent-local-session");
	const sessionManager = {
		getSessionFile: vi.fn(() => parentFile),
		getCwd: vi.fn(() => tempDir.path()),
		getSessionDir: vi.fn(() => tempDir.path()),
		getArtifactsDir,
		getSessionId,
		ensureOnDisk: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["sessionManager"];
	Object.assign(session, { sessionManager, dispose: vi.fn(async () => {}) });
	const cloneManager = {
		getSessionFile: vi.fn(() => cloneFile),
		appendCustomEntry: vi.fn(),
	} as unknown as SessionManager;
	const ctx = {
		session,
		sessionManager,
		settings: Settings.isolated({ "task.enableLsp": true }),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
	} as unknown as InteractiveModeContext;
	const rootCreate = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValueOnce({
		session,
	} as unknown as CreateAgentSessionResult);
	try {
		await createAgentRootSession(AgentRegistry.global(), { agentId: overrides?.agentId ?? MAIN_AGENT_ID, sessionManager });
	} finally {
		rootCreate.mockRestore();
	}
	rootSessions.push(session);
	return {
		tempDir,
		parentFile,
		parentArtifactsDir,
		cloneFile,
		cloneManager,
		ctx,
		getArtifactsDir,
		getSessionId,
		register,
		sequence,
		get capturedRun() {
			return capturedRun;
		},
		get capturedOptions() {
			return capturedOptions;
		},
	};
}

describe("TanCommandController", () => {
	afterEach(async () => {
		for (const root of rootSessions.splice(0)) await root.dispose();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
	});

	it("rejects empty work before forking", async () => {
		const harness = await createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("   ");

		expect(forkSpy).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Usage: /tan <work>");
	});

	it("dispatches without disturbing an in-flight turn while streaming", async () => {
		const harness = await createContext({ isStreaming: true });
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("check something");

		expect(forkSpy).toHaveBeenCalled();
		expect(harness.ctx.showWarning).not.toHaveBeenCalled();
		// The breadcrumb is queued for the next turn, not steered into the live one,
		// and the live chat is left to the streaming renderer (no synchronous rebuild).
		expect(harness.ctx.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-tan-dispatch" }),
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		expect(harness.ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Dispatched background tan job-123");
	});

	it("forks with breadcrumb suppression, registers under Main, and dispatches after receiving the job id", async () => {
		const harness = await createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const stub = createCloneStub();
		let creationOptions: CreateAgentSessionOptions | undefined;
		mockTanSessionCreation(stub, options => {
			creationOptions = options;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("write the release note");

		expect(forkSpy).toHaveBeenCalledWith(
			harness.parentFile,
			harness.tempDir.path(),
			harness.parentFile.slice(0, -6),
			undefined,
			{
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: expect.stringMatching(/Tan-.+\.jsonl$/),
				resetInheritedCost: true,
			},
		);
		expect(harness.register).toHaveBeenCalledWith("task", "/tan write the release note", expect.any(Function));
		expect(harness.capturedOptions).toBeUndefined();
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });
		const agentId = creationOptions?.agentId;
		if (!agentId) throw new Error("Tan child agent id was not passed to session creation");
		expect(AgentRegistry.global().get(agentId)).toEqual(
			expect.objectContaining({
				id: agentId,
				parentId: MAIN_AGENT_ID,
				kind: "sub",
				sessionFile: harness.cloneFile,
				status: "parked",
			}),
		);
		expect(harness.sequence).toEqual(["register", "sendCustomMessage"]);
		expect(harness.ctx.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "background-tan-dispatch",
				details: {
					jobId: "job-123",
					work: "write the release note",
					sessionFile: expect.stringMatching(/Tan-.+\.jsonl$/),
				},
			}),
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		expect(harness.ctx.rebuildChatFromMessages).toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Dispatched background tan job-123");
	});

	it("keeps the dispatching session's local:// root after the interactive session switches", async () => {
		const harness = await createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const stub = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		mockTanSessionCreation(stub, options => {
			capturedOptions = options;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("read local://paste-1.md");
		harness.getArtifactsDir.mockReturnValue(path.join(harness.tempDir.path(), "other-session"));
		harness.getSessionId.mockReturnValue("other-session");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = capturedOptions?.localProtocolOptions;
		if (!opts) throw new Error("localProtocolOptions was not passed");
		expect(resolveLocalRoot(opts)).toBe(path.join(harness.parentArtifactsDir, "local"));
		// The local mapping keys off the session-manager id (not `session.sessionId`,
		// still "parent-session"), matching the parent's large-paste / local:// writes.
		expect(opts.getSessionId?.()).toBe("parent-local-session");
	});

	it("forwards the parent's prepared extensions and root policy so the tan child rebinds runtime providers", async () => {
		// Regression: the tan clone reuses the parent's shared ModelRegistry. If it
		// is built without the parent's extensions, the SDK's syncExtensionSources
		// prune unregisters extension-provided providers from that shared registry,
		// so the child fails its API-key check ("No API key found for <provider>")
		// and the parent loses the registration too. The child MUST rebind the
		// parent's prepared extensions before that prune runs.
		const preparedExtensions: PreparedExtension[] = [
			{ path: "/ext/provider.ts", resolvedPath: "/ext/provider.ts", factory: null, error: null },
		];
		const effectiveExtensionRoots: EffectiveExtensionRoots = {
			explicit: ["/ext/provider.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const extensionPaths = ["/ext/provider.ts"];
		const harness = await createContext({ preparedExtensions, effectiveExtensionRoots, extensionPaths });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const stub = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		mockTanSessionCreation(stub, options => {
			capturedOptions = options;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("chase the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(capturedOptions?.preloadedPreparedExtensions).toEqual(preparedExtensions);
		// Path-list fallback is forwarded (fresh copy) for parent builds without prepared factories.
		expect(capturedOptions?.preloadedExtensionPaths).toEqual(extensionPaths);
		expect(capturedOptions?.extensionRoots?.()).toEqual(effectiveExtensionRoots);
		expect(capturedOptions?.disableExtensionDiscovery).toBe(true);
	});

	it("collapses an empty prepared-extensions list to undefined so the child selects the path fallback", async () => {
		// `[]` is truthy: if forwarded verbatim the child would bind an empty
		// factory list and skip the populated path fallback, then prune the shared
		// registry from an empty source set — the exact failure the fix prevents.
		const effectiveExtensionRoots: EffectiveExtensionRoots = {
			explicit: ["/ext/provider.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const extensionPaths = ["/ext/provider.ts"];
		const harness = await createContext({ preparedExtensions: [], effectiveExtensionRoots, extensionPaths });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const stub = createCloneStub({ lastAssistantText: "done" });
		let capturedOptions: CreateAgentSessionOptions | undefined;
		mockTanSessionCreation(stub, options => {
			capturedOptions = options;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("chase the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(capturedOptions?.preloadedPreparedExtensions).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual(extensionPaths);
	});

	it("aborts the cloned agent when the background job signal aborts", async () => {
		const harness = await createContext({ agentId: MAIN_AGENT_ID });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const promptStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const stub = createCloneStub({
			prompt: async () => {
				promptStarted.resolve();
				await abortObserved.promise;
			},
			abort: () => {
				abortObserved.resolve();
			},
			lastAssistantText: "finished",
		});
		const { clone } = stub;
		const createAgentSessionSpy = mockTanSessionCreation(stub);
		const controller = new TanCommandController(harness.ctx);
		await controller.start("follow the tangent");
		const capturedRun = harness.capturedRun;
		expect(capturedRun).toBeDefined();
		if (!capturedRun) throw new Error("run function was not captured");
		const abortController = new AbortController();

		const resultPromise = capturedRun({
			jobId: "job-123",
			signal: abortController.signal,
			reportProgress: async () => {},
		});
		await promptStarted.promise;
		abortController.abort();
		await expect(resultPromise).rejects.toThrow(/^Operation job cancelled:/);

		expect(clone.abort).toHaveBeenCalled();
		expect(stub.dispose).toHaveBeenCalled();
		expect(createAgentSessionSpy.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				providerPromptCacheKey: "parent-session",
				parentTaskPrefix: expect.stringMatching(/^Tan-/) as unknown as string,
				agentDisplayName: "tan",
			}),
		);
	});

	it("parents the tan clone to the spawning agent, not to the clone itself", async () => {
		const harness = await createContext({ agentId: "FocusedParent" });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const stub = createCloneStub();
		const { clone } = stub;
		const createAgentSessionSpy = mockTanSessionCreation(stub);
		const controller = new TanCommandController(harness.ctx);
		await controller.start("follow the tangent");
		const capturedRun = harness.capturedRun;
		if (!capturedRun) throw new Error("run function was not captured");
		await capturedRun({ jobId: "job-1", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = createAgentSessionSpy.mock.calls[0]?.[0];
		const child = opts?.agentId ? AgentRegistry.global().get(opts.agentId) : undefined;
		expect(child?.parentId).toBe("FocusedParent");
		expect(opts?.parentTaskPrefix).toMatch(/^Tan-/);
		expect(opts?.parentTaskPrefix).not.toBe("FocusedParent");
	});

	it("pins the parent's effective cache key when the parent itself carries a pinned promptCacheKey", async () => {
		// A parent that is itself a fork/tan caches under `agent.promptCacheKey`,
		// not its own session id — the clone must read that exact shard.
		const harness = await createContext({ parentPromptCacheKey: "grandparent-cache-key" });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const stub = createCloneStub();
		const { clone } = stub;
		const createAgentSessionSpy = mockTanSessionCreation(stub);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-1", signal: new AbortController().signal, reportProgress: async () => {} });

		const opts = createAgentSessionSpy.mock.calls[0]?.[0];
		expect(opts?.providerPromptCacheKey).toBe("grandparent-cache-key");
		expect(opts?.providerSessionId).toMatch(/^parent-session:tan:/);
	});

	it("parks the finished tan in the registry so it stays visible in the Agent Hub", async () => {
		const harness = await createContext();
		const registry = AgentRegistry.global();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const appendSessionInit = vi.fn();
		const stub = createCloneStub({ sessionManager: { appendSessionInit } });
		const { clone } = stub;
		let childId: string | undefined;
		let childBeforeDispose: AgentRef | undefined;
		let childSessionBeforeDispose: unknown;
		mockTanSessionCreation(stub, options => {
			childId = options.agentId;
		});
		stub.dispose.mockImplementation(async () => {
			if (!childId) throw new Error("Tan child id was not passed to session creation");
			childBeforeDispose = registry.get(childId);
			childSessionBeforeDispose = lookupAgentRef(registry, childId)?.session;
		});
		const controller = new TanCommandController(harness.ctx);

		await controller.start("park me");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		const result = await run({
			jobId: "job-123",
			signal: new AbortController().signal,
			reportProgress: async () => {},
		});

		expect(result).toBe("done");
		expect(appendSessionInit).toHaveBeenCalledWith({
			systemPrompt: "system prompt",
			task: "park me",
			tools: ["read", "bash"],
		});
		if (!childId) throw new Error("Tan child id was not passed to session creation");
		expect(childBeforeDispose).toEqual(
			expect.objectContaining({
				id: childId,
				parentId: MAIN_AGENT_ID,
				kind: "sub",
				status: "parked",
				sessionFile: harness.cloneFile,
			}),
		);
		expect(childSessionBeforeDispose).toBe(clone);
		const childAfterDispose = registry.get(childId);
		expect(childAfterDispose).toEqual(
			expect.objectContaining({ id: childId, status: "parked", sessionFile: harness.cloneFile }),
		);
		expect(lookupAgentRef(registry, childId)?.session).toBeNull();
		expect(stub.dispose).toHaveBeenCalledTimes(1);
	});

	it("copies and persists the full enabled tool set", async () => {
		const enabledToolNames = ["eval", "read", "bash"];
		const harness = await createContext({ activeToolNames: ["eval"], enabledToolNames });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const appendSessionInit = vi.fn();
		const stub = createCloneStub({
			sessionManager: { appendSessionInit },
			activeToolNames: ["eval"],
			enabledToolNames,
		});
		const { clone } = stub;
		const createAgentSessionSpy = mockTanSessionCreation(stub);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("preserve bridge tools");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });

		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.toolNames).toEqual(enabledToolNames);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: enabledToolNames }));
	});

	it("isolates the fork: clears inherited todos, injects the fork notice, and re-injects after compaction", async () => {
		const harness = await createContext();
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const compacted = Promise.withResolvers<void>();
		const stub = createCloneStub({
			prompt: async () => {
				// Simulate the clone's history compacting mid-run: the summarizer
				// erases the fork notice, so the controller must append it again.
				stub.compactionListener?.({ type: "auto_compaction_end", result: {}, aborted: false });
				compacted.resolve();
			},
		});
		mockTanSessionCreation(stub);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("follow the tangent");
		const run = harness.capturedRun;
		if (!run) throw new Error("run function was not captured");
		await run({ jobId: "job-123", signal: new AbortController().signal, reportProgress: async () => {} });
		await compacted.promise;

		// Inherited parent todos are wiped both in-memory and in the persisted
		// session so reloads agree; otherwise todo reminders drag the tan back
		// onto the parent's task.
		expect(stub.clone.setTodoPhases).toHaveBeenCalledWith([]);
		expect(harness.cloneManager.appendCustomEntry).toHaveBeenCalledWith("user_todo_edit", { phases: [] });
		// Fork notice injected before the prompt and again after compaction.
		expect(stub.appendMessage).toHaveBeenCalledTimes(2);
		for (const call of stub.appendMessage.mock.calls) {
			expect(call[0]).toEqual(
				expect.objectContaining({
					role: "developer",
					content: expect.stringContaining('<system-notice cause="fork">'),
				}),
			);
		}
		// The compaction listener is released once the tan finishes.
		expect(stub.compactionListener).toBeUndefined();
	});
});
