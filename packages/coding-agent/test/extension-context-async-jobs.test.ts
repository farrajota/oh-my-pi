import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	AsyncJobOutputSnapshot,
	AsyncJobSnapshot,
	BackgroundControlResult,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function createRunner(getAsyncJobSnapshot?: () => AsyncJobSnapshot | null): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner(
		[],
		runtime,
		"/tmp",
		{ getCwd: () => "/tmp" } as never,
		{} as never,
		undefined,
		undefined,
		undefined,
		getAsyncJobSnapshot,
	);
}

describe("ExtensionRunner async job context", () => {
	it("defaults to null outside a session", () => {
		expect(createRunner().createContext().getAsyncJobSnapshot()).toBeNull();
	});

	it("provides safe output and mutation defaults outside a session", async () => {
		const context = createRunner().createContext();
		expect(context.getAsyncJobOutput("missing")).toBeNull();
		await expect(context.cancelAsyncJob("missing")).resolves.toMatchObject({ id: "missing", status: "not_found" });
		await expect(context.terminateSubagent("missing")).resolves.toMatchObject({ id: "missing", status: "not_found" });
	});

	it("exposes the owning session snapshot", () => {
		const snapshot: AsyncJobSnapshot = {
			running: [{ id: "bg-1", type: "bash", status: "running", label: "sleep 30", startTime: 1, queued: false }],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		};
		expect(
			createRunner(() => snapshot)
				.createContext()
				.getAsyncJobSnapshot(),
		).toBe(snapshot);
	});

	it("exposes selected output and owner-scoped mutations from initialized actions", async () => {
		const runner = createRunner();
		const output: AsyncJobOutputSnapshot = {
			id: "bg-1",
			status: "running",
			source: "progress",
			text: "working",
			truncated: false,
		};
		const cancelled: BackgroundControlResult = {
			id: "bg-1",
			status: "cancelled",
			message: "Background job cancelled.",
		};
		runner.initialize({} as never, {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
			getAsyncJobOutput: id => (id === "bg-1" ? output : null),
			cancelAsyncJob: async id => (id === "bg-1" ? cancelled : { id, status: "not_found", message: "missing" }),
		});
		const context = runner.createContext();
		expect(context.getAsyncJobOutput("bg-1")).toBe(output);
		expect(context.getAsyncJobOutput("other")).toBeNull();
		await expect(context.cancelAsyncJob("bg-1")).resolves.toBe(cancelled);
		await expect(context.cancelAsyncJob("other")).resolves.toMatchObject({ status: "not_found" });
	});
	it("does not terminate a prior-session descendant with the same owner id", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-termination-scope-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Owner",
		});
		const ownerRoot = path.resolve(sessionManager.getSessionFile()!.slice(0, -6));
		const priorRoot = path.join(tempDir.path(), "prior-session-owner");
		mkdirSync(ownerRoot, { recursive: true });
		mkdirSync(priorRoot, { recursive: true });

		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const registry = AgentRegistry.global();
		const prior = registry.register({
			id: "same-owner-prior-child",
			displayName: "Prior child",
			kind: "sub",
			parentId: "Owner",
			session: null,
			status: "parked",
			sessionFile: path.join(priorRoot, "same-owner-prior-child.jsonl"),
		});
		const current = registry.register({
			id: "same-owner-current-child",
			displayName: "Current child",
			kind: "sub",
			parentId: "Owner",
			session: null,
			status: "parked",
			sessionFile: path.join(ownerRoot, "same-owner-current-child.jsonl"),
		});

		try {
			await expect(session.terminateSubagent(prior.id)).resolves.toMatchObject({
				id: prior.id,
				status: "not_found",
			});
			expect(registry.get(prior.id)).toBe(prior);
			expect(registry.get(prior.id)?.status).toBe("parked");

			await expect(session.terminateSubagent(current.id)).resolves.toMatchObject({
				id: current.id,
				status: "cancelled",
			});
			expect(registry.get(current.id)?.status).toBe("aborted");
		} finally {
			await session.dispose();
			authStorage.close();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});
});
