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

	it("counts overlapping user waits once and resumes the active lease budget afterward", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const { session, auth } = createSession();
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		const waitsEnded = Promise.withResolvers<void>();
		const activeWork = Promise.withResolvers<string>();
		const manager = session.sessionManager;
		let operation: Promise<string> | undefined;
		try {
			operation = runFilesystemOperation(manager, "filesystem:overlap-waits", async () => {
				const waits = [session.waitForUser(() => first.promise), session.waitForUser(() => second.promise)];
				await Promise.all(waits);
				waitsEnded.resolve();
				return activeWork.promise;
			});
			await Promise.resolve();
			setSystemTime(1_000 + 60_000);
			first.resolve("first");
			await Promise.resolve();
			setSystemTime(1_000 + 2 * 60_000);
			second.resolve("second");
			await waitsEnded.promise;
			setSystemTime(1_000 + 7 * 60_000);
			activeWork.resolve("active work ran out of lease");
			await expect(operation).rejects.toThrow("lease expired");
			expect(getOperationTerminal(manager, "filesystem:overlap-waits")).toMatchObject({
				status: "abandoned",
				detail: "Operation lease expired",
			});
		} finally {
			first.resolve("first");
			second.resolve("second");
			activeWork.resolve("active work ran out of lease");
			waitsEnded.resolve();
			await operation?.catch(() => undefined);
			await session.dispose();
			auth.close();
		}
	});

	it("preserves nested filesystem and extension leases during an explicit user wait", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const { session, auth } = createSession();
		const answer = Promise.withResolvers<string>();
		const manager = session.sessionManager;
		let operation: Promise<string> | undefined;
		try {
			operation = runFilesystemOperation(manager, "filesystem:user-wait", () =>
				runExtensionOperation(manager, "extension:user-wait", () => session.waitForUser(() => answer.promise)),
			);
			await Promise.resolve();
			setSystemTime(1_000 + 5 * 60_000 + 1);
			await expect(runFilesystemOperation(manager, "filesystem:user-wait", async () => "duplicate")).rejects.toThrow(
				"already-active",
			);
			answer.resolve("selected answer");
			await expect(operation).resolves.toBe("selected answer");
			expect(getOperationTerminal(manager, "filesystem:user-wait")).toMatchObject({ status: "completed" });
			expect(getOperationTerminal(manager, "extension:user-wait")).toMatchObject({ status: "completed" });
		} finally {
			answer.resolve("selected answer");
			await operation?.catch(() => undefined);
			await session.dispose();
			auth.close();
		}
	});

	it("does not pause an active operation or revive pre-expired work", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const { session, auth } = createSession();
		const completion = Promise.withResolvers<string>();
		const manager = session.sessionManager;
		let active: Promise<string> | undefined;
		try {
			active = runFilesystemOperation(manager, "filesystem:active-work", () => completion.promise);
			await Promise.resolve();
			setSystemTime(1_000 + 5 * 60_000 + 1);
			completion.resolve("late result");
			await expect(active).rejects.toThrow("lease expired");
			expect(getOperationTerminal(manager, "filesystem:active-work")).toMatchObject({
				status: "abandoned",
				detail: "Operation lease expired",
			});
		} finally {
			completion.resolve("late result");
			await active?.catch(() => undefined);
			await session.dispose();
			auth.close();
		}
	});

	it("does not enter a user wait after the operation lease has expired", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const { session, auth } = createSession();
		const startWait = Promise.withResolvers<void>();
		const manager = session.sessionManager;
		let dialogStarted = false;
		let operation: Promise<string> | undefined;
		try {
			operation = runFilesystemOperation(manager, "filesystem:pre-expired-wait", async () => {
				await startWait.promise;
				return session.waitForUser(async () => {
					dialogStarted = true;
					return "too late";
				});
			});
			await Promise.resolve();
			setSystemTime(1_000 + 5 * 60_000 + 1);
			startWait.resolve();
			await expect(operation).rejects.toThrow("lease expired");
			expect(dialogStarted).toBe(false);
			expect(getOperationTerminal(manager, "filesystem:pre-expired-wait")).toMatchObject({
				status: "abandoned",
				detail: "Operation lease expired",
			});
		} finally {
			startWait.resolve();
			await operation?.catch(() => undefined);
			await session.dispose();
			auth.close();
		}
	});

	it("rejects late user consent after cancellation while waiting", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const { session, auth } = createSession();
		const answer = Promise.withResolvers<string>();
		const controller = new AbortController();
		const manager = session.sessionManager;
		let operation: Promise<string> | undefined;
		try {
			operation = runFilesystemOperation(
				manager,
				"filesystem:cancelled-wait",
				() => session.waitForUser(() => answer.promise),
				controller.signal,
			);
			await Promise.resolve();
			controller.abort(new Error("cancelled"));
			answer.resolve("late consent");
			await expect(operation).rejects.toThrow("cancelled");
			expect(getOperationTerminal(manager, "filesystem:cancelled-wait")).toMatchObject({ status: "abandoned" });
		} finally {
			answer.resolve("late consent");
			await operation?.catch(() => undefined);
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
	it("continues to report installed bound authority after its generation becomes stale or the ledger closes", async () => {
		const manager = {};
		const control = operationLease.installSessionOperationLedger(manager);
		let valid = true;
		const authority = operationLease.issueBoundSessionOperationAuthority(
			{
				capability: {},
				actorId: "Worker",
				rootId: "Main",
				generation: 2,
				sessionFile: null,
				validate: () => valid,
			},
			manager,
		);
		try {
			expect(operationLease.hasBoundSessionOperationAuthority(manager)).toBe(false);
			operationLease.bindSessionOperationAuthority(manager, authority);
			expect(operationLease.hasBoundSessionOperationAuthority(manager)).toBe(true);
			valid = false;
			expect(operationLease.hasBoundSessionOperationAuthority(manager)).toBe(true);
			await control.close();
			expect(operationLease.hasBoundSessionOperationAuthority(manager)).toBe(true);
		} finally {
			await control.close();
		}
	});
});
