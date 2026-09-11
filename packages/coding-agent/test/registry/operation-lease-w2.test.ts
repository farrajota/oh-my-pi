import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Agent, type AgentTool, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../../src/config/model-registry";
import type { AuthStorage } from "../../src/session/auth-storage";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import * as operationLease from "../../src/registry/operation-lease";
import {
	getOperationTerminal,
	runArtifactOperation,
	runEvalOperation,
	runExtensionOperation,
	runFilesystemOperation,
	runJobOperation,
	runLocalOperation,
	runMcpOperation,
	runSessionOperation,
} from "../../src/registry/operation-lease";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { Settings } from "../../src/config/settings";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function createSession(): { session: AgentSession; auth: AuthStorage } {
	const auth = createInMemoryAuthStorage();
	const session = new AgentSession({
		agent: new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth),
	});
	operationLease.markUnregisteredSessionOperationProjection(session.sessionManager, false);
	return { auth, session };
}

function passthroughRunner(): ExtensionRunner {
	return {
		sessionId: "operation-lease-test",
		hasHandlers: () => false,
		consumeToolCallEmitted: () => false,
		getPermissionScope: () => undefined,
		getCwd: () => "/tmp",
		runScoped<T>(run: () => T): T {
			return run();
		},
	} as unknown as ExtensionRunner;
}

function simpleTool(name: string, execute: () => Promise<string>): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: await execute() }], details: undefined }),
	} as unknown as AgentTool;
}

afterEach(() => {
	vi.useRealTimers();
	setSystemTime();
});

describe("W2 non-Hub operation ownership", () => {
	it("records every manager-bound class through class-fixed wrappers", async () => {
		const { session, auth } = createSession();
		const manager = session.sessionManager;
		const runners = [
			["eval", runEvalOperation],
			["mcp", runMcpOperation],
			["job", runJobOperation],
			["filesystem", runFilesystemOperation],
			["local", runLocalOperation],
			["artifact", runArtifactOperation],
			["extension", runExtensionOperation],
			["session", runSessionOperation],
		] as const;
		try {
			for (const [effectClass, run] of runners) {
				await expect(run(manager, `${effectClass}:success`, async () => effectClass)).resolves.toBe(effectClass);
				expect(getOperationTerminal(manager, `${effectClass}:success`)).toMatchObject({
					effectClass,
					status: "completed",
				});
			}
			for (const [effectClass, run] of runners) {
				await expect(
					run(manager, `${effectClass}:failure`, async () => {
						throw new Error(`${effectClass} failed`);
					}),
				).rejects.toThrow(`${effectClass} failed`);
				expect(getOperationTerminal(manager, `${effectClass}:failure`)).toMatchObject({
					effectClass,
					status: "failed",
				});
			}
			for (const compileOnly of []) {
				void compileOnly;
				// @ts-expect-error no generic caller-selected effect-class seam is exported
				operationLease.runOwnedOperation(manager, "session", "forged", async () => undefined);
				// @ts-expect-error callers cannot select or mint an operation owner
				operationLease.installSessionOperationLedger(manager, "forged-owner");
				// @ts-expect-error AgentSession does not expose its ledger
				session.operationLeases;
				// @ts-expect-error AgentSession does not expose owner capabilities
				session.operationOwners;
			}
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("fails an expired active lease closed and ignores its late completion deterministically", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const { session, auth } = createSession();
		const completion = Promise.withResolvers<string>();
		try {
			const stale = runEvalOperation(session.sessionManager, "eval:expiry-race", () => completion.promise);
			await Promise.resolve();
			setSystemTime(1_000 + 5 * 60_000 + 1);
			await expect(
				runEvalOperation(session.sessionManager, "eval:expiry-race", async () => "new attempt"),
			).rejects.toThrow("terminal");
			expect(getOperationTerminal(session.sessionManager, "eval:expiry-race")).toMatchObject({
				effectClass: "eval",
				status: "abandoned",
				detail: "Operation lease expired",
			});
			completion.resolve("late stale completion");
			await expect(stale).rejects.toThrow("Operation eval lease expired");
			expect(getOperationTerminal(session.sessionManager, "eval:expiry-race")).toMatchObject({
				status: "abandoned",
				detail: "Operation lease expired",
			});
		} finally {
			vi.useRealTimers();
			setSystemTime();
			await session.dispose();
			auth.close();
		}
	});

	it("bypasses Hub while routing the real task path to the session class", async () => {
		const { session, auth } = createSession();
		const manager = session.sessionManager;
		const runner = passthroughRunner();
		const context: AgentToolContext = {
			sessionManager: manager,
			modelRegistry: session.modelRegistry,
			model: session.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				void session.abort();
			},
			settings: Settings.isolated(),
		};
		try {
			const task = new ExtensionToolWrapper(
				simpleTool("task", async () => "task ran"),
				runner,
			);
			await expect(task.execute("task-call", {}, undefined, undefined, context)).resolves.toMatchObject({
				content: [{ type: "text", text: "task ran" }],
			});
			expect(getOperationTerminal(manager, "task:task-call")).toMatchObject({
				effectClass: "session",
				status: "completed",
			});

			session.beginDispose();
			const hub = new ExtensionToolWrapper(
				simpleTool("hub", async () => "hub ran"),
				runner,
			);
			await expect(hub.execute("hub-call", {}, undefined, undefined, context)).resolves.toMatchObject({
				content: [{ type: "text", text: "hub ran" }],
			});
			expect(getOperationTerminal(manager, "hub:hub-call")).toBeUndefined();
			await expect(task.execute("task-blocked", {}, undefined, undefined, context)).rejects.toThrow("terminal");
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("waits for every pre-close callback, signals cancellation, and rejects late success", async () => {
		const { session, auth } = createSession();
		const completion = Promise.withResolvers<string>();
		const secondCompletion = Promise.withResolvers<string>();
		const controller = new operationLease.MigrationFenceController();
		let cancellationCount = 0;
		try {
			const operation = runEvalOperation(session.sessionManager, "eval:drain", async signal => {
				if (!signal) throw new Error("Operation signal missing");
				signal.addEventListener(
					"abort",
					() => {
						cancellationCount++;
					},
					{ once: true },
				);
				return completion.promise;
			});
			const secondOperation = runMcpOperation(session.sessionManager, "mcp:drain", async signal => {
				if (!signal) throw new Error("Operation signal missing");
				signal.addEventListener(
					"abort",
					() => {
						cancellationCount++;
					},
					{ once: true },
				);
				return secondCompletion.promise;
			});
			await Promise.resolve();
			const opened = controller.open("root", "token");
			const quiescing = controller.quiesce(opened, session.sessionManager);
			await Promise.resolve();
			expect(cancellationCount).toBe(2);
			let quiesced = false;
			void quiescing.then(() => {
				quiesced = true;
			});
			await Promise.resolve();
			expect(quiesced).toBe(false);
			const operationError = operation.catch(error => error);
			const secondOperationError = secondOperation.catch(error => error);
			completion.resolve("late success");
			secondCompletion.resolve("second late success");
			const [error, secondError] = await Promise.all([operationError, secondOperationError]);
			expect(error).toBeInstanceOf(Error);
			expect(error).toHaveProperty("message", expect.stringMatching(/cancelled/i));
			expect(secondError).toBeInstanceOf(Error);
			expect(secondError).toHaveProperty("message", expect.stringMatching(/cancelled/i));
			const fence = await quiescing;
			expect(fence.state).toBe("quiesced");
			expect(getOperationTerminal(session.sessionManager, "eval:drain")).toMatchObject({
				status: "abandoned",
				detail: "Session disposed",
			});
			expect(getOperationTerminal(session.sessionManager, "mcp:drain")).toMatchObject({
				status: "abandoned",
				detail: "Session disposed",
			});
			expect(controller.validate(fence).state).toBe("validated");
		} finally {
			const firstDispose = session.dispose();
			const secondDispose = session.dispose();
			expect(secondDispose).toBe(firstDispose);
			await Promise.all([firstDispose, secondDispose]);
			auth.close();
		}
	});

	it("fails closed without an installed manager and for restricted public projections", async () => {
		const missingRun = vi.fn(async () => "unreachable");
		expect(() => runEvalOperation(undefined, "eval:missing-manager", missingRun)).toThrow(
			"installed session operation ledger",
		);
		expect(missingRun).not.toHaveBeenCalled();

		const { session, auth } = createSession();
		const restrictedRun = vi.fn(async () => "unreachable");
		try {
			operationLease.markUnregisteredSessionOperationProjection(session.sessionManager, true);
			await expect(
				runFilesystemOperation(session.sessionManager, "filesystem:restricted-projection", restrictedRun),
			).rejects.toThrow("exact bound session authority");
			expect(restrictedRun).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});
