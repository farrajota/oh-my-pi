import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
import type { AuthorityStore, MutationOptions, MutationReceipt } from "../../src/registry/authority/types";
import type { DurableOperationRecord, DurableRegistryRecord } from "../../src/registry/durable-state";
import { AuthorityRpcClient } from "../../src/registry/authority/client";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import { SessionPathScope } from "../../src/internal/session-path-scope";

const authorityClients: AuthorityRpcClient[] = [];
const authorityDirectories: string[] = [];
async function createOperationStore(
	waitForTransition: (record: DurableRegistryRecord) => Promise<void> = async () => {},
) {
	const records: DurableRegistryRecord[] = [];
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-operation-lease-test-"));
	authorityDirectories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	await fs.writeFile(sessionFile, '{"type":"session","id":"root"}\n');
	const ownership = await acquireAuthorityOwnership(sessionFile, { owningSessionId: "root", create: true });
	const client = await AuthorityRpcClient.open(
		{
			path: ownership.paths.jsonl,
			identity: { backend: "jsonl", owningSessionId: "root", incarnation: Bun.randomUUIDv7(), format: 2 },
			create: true,
		},
		ownership,
	);
	authorityClients.push(client);
	let revision = 0;
	const store = client as AuthorityRpcClient & AuthorityStore;
	store.transition = async (record: DurableRegistryRecord, options?: MutationOptions): Promise<MutationReceipt> => {
		if (record.kind !== "operation" && record.kind !== "resource")
			throw new Error(`Unexpected durable transition: ${record.kind}`);
		records.push(record);
		await waitForTransition(record);
		revision++;
		return {
			requestId: options?.requestId ?? `request-${revision}`,
			ownerEpoch: 1,
			revision,
			payloadHash: "a".repeat(64),
			incarnation: "incarnation-1",
			commandKind: "transition",
			committedAt: revision,
			result: { kind: "mutation" },
		};
	};
	return { store, records, directory };
}

function operationPhases(records: readonly DurableRegistryRecord[]): DurableOperationRecord["phase"][] {
	return records.map(record => {
		if (record.kind !== "operation") throw new Error("Expected durable operation record.");
		return record.phase;
	});
}

function installDurableOperationManager(store: AuthorityStore): { manager: object; close: () => Promise<void> } {
	const manager = {};
	const control = operationLease.installSessionOperationLedger(manager);
	operationLease.markUnregisteredSessionOperationProjection(manager, false);
	operationLease.bindSessionOperationDurability(manager, store);
	return { manager, close: () => control.close() };
}
async function createRealOperationAuthority() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-operation-real-test-"));
	authorityDirectories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	await fs.writeFile(sessionFile, '{"type":"session","id":"root"}\n');
	const ownership = await acquireAuthorityOwnership(sessionFile, { owningSessionId: "root", create: true });
	const client = await AuthorityRpcClient.open(
		{
			path: ownership.paths.jsonl,
			identity: { backend: "jsonl", owningSessionId: "root", incarnation: Bun.randomUUIDv7(), format: 2 },
			create: true,
		},
		ownership,
	);
	authorityClients.push(client);
	return { client, store: client as AuthorityRpcClient & AuthorityStore, directory };
}

async function installBoundOperationManager(store: AuthorityStore, validate: () => boolean = () => true) {
	const manager = {};
	const control = operationLease.installSessionOperationLedger(manager);
	operationLease.bindSessionOperationDurability(manager, store);
	const authority = operationLease.issueBoundSessionOperationAuthority(
		{
			capability: {},
			actorId: "Worker",
			rootId: "Main",
			generation: 1,
			sessionFile: null,
			validate,
		},
		manager,
	);
	await operationLease.bindSessionOperationAuthority(manager, authority);
	return { manager, control, authority };
}

function gateRealTransitionAcknowledgement(
	store: AuthorityRpcClient & AuthorityStore,
	gate: (record: DurableRegistryRecord) => Promise<void>,
): void {
	const transition = store.transition.bind(store);
	store.transition = async (record, options) => {
		const receipt = await transition(record, options);
		await gate(record);
		return receipt;
	};
}

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

afterEach(async () => {
	await Promise.all(authorityClients.splice(0).map(client => client.close()));
	await Promise.all(
		authorityDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
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
		const userWaitStarted = Promise.withResolvers<void>();
		const manager = session.sessionManager;
		let operation: Promise<string> | undefined;
		try {
			operation = runFilesystemOperation(manager, "filesystem:user-wait", () =>
				runExtensionOperation(manager, "extension:user-wait", () =>
					session.waitForUser(() => {
						userWaitStarted.resolve();
						return answer.promise;
					}),
				),
			);
			await userWaitStarted.promise;
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
		const callbackStarted = Promise.withResolvers<void>();
		try {
			let callbackContinued = false;
			const stale = runEvalOperation(session.sessionManager, "eval:expiry-race", async () => {
				callbackStarted.resolve();
				const value = await completion.promise;
				callbackContinued = true;
				return value;
			});
			await callbackStarted.promise;
			setSystemTime(1_000 + 5 * 60_000 + 1);
			await expect(
				runEvalOperation(session.sessionManager, "eval:expiry-race", async () => "new attempt"),
			).rejects.toThrow("terminal");
			expect(getOperationTerminal(session.sessionManager, "eval:expiry-race")).toMatchObject({
				effectClass: "eval",
				status: "abandoned",
				detail: "Operation lease expired",
			});
			expect(callbackContinued).toBe(false);
			completion.resolve("late stale completion");
			await expect(stale).rejects.toThrow("Operation eval lease expired");
			expect(callbackContinued).toBe(true);
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
	it("serializes competing authority binds and rejects installation after ledger close", async () => {
		const manager = {};
		const control = operationLease.installSessionOperationLedger(manager);
		const issue = (target: object, actorId: string) =>
			operationLease.issueBoundSessionOperationAuthority(
				{
					capability: {},
					actorId,
					rootId: "Main",
					generation: 1,
					sessionFile: null,
					validate: () => true,
				},
				target,
			);
		try {
			const competing = await Promise.allSettled([
				operationLease.bindSessionOperationAuthority(manager, issue(manager, "WorkerA")),
				operationLease.bindSessionOperationAuthority(manager, issue(manager, "WorkerB")),
			]);
			expect(competing.filter(result => result.status === "fulfilled")).toHaveLength(1);
			expect(competing.filter(result => result.status === "rejected")).toHaveLength(1);
		} finally {
			await control.close();
		}

		const closingManager = {};
		const closingControl = operationLease.installSessionOperationLedger(closingManager);
		operationLease.markUnregisteredSessionOperationProjection(closingManager, false);
		const callback = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		const active = runFilesystemOperation(closingManager, "filesystem:bind-close-race", async () => {
			started.resolve();
			return callback.promise;
		});
		await started.promise;
		const pendingBind = operationLease.bindSessionOperationAuthority(
			closingManager,
			issue(closingManager, "WorkerC"),
		);
		const pendingBindResult = pendingBind.then(
			() => ({ kind: "fulfilled" as const }),
			error => ({ kind: "rejected" as const, error }),
		);
		try {
			const closed = closingControl.close();
			callback.resolve("late callback result");
			await expect(active).rejects.toThrow(/cancelled/i);
			await closed;
			const bindResult = await pendingBindResult;
			expect(bindResult.kind).toBe("rejected");
			if (bindResult.kind !== "rejected") throw new Error("Authority bind unexpectedly succeeded after close.");
			expect(bindResult.error).toBeInstanceOf(Error);
			if (!(bindResult.error instanceof Error)) throw bindResult.error;
			expect(bindResult.error.message).toMatch(/closed/i);
			expect(operationLease.hasBoundSessionOperationAuthority(closingManager)).toBe(false);
		} finally {
			callback.resolve("late callback result");
			await active.catch(() => undefined);
			await closingControl.close();
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
		const operationStarted = Promise.withResolvers<void>();
		const secondOperationStarted = Promise.withResolvers<void>();
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
				operationStarted.resolve();
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
				secondOperationStarted.resolve();
				return secondCompletion.promise;
			});
			await Promise.all([operationStarted.promise, secondOperationStarted.promise]);
			const opened = controller.open("root", "token");
			const quiescing = controller.quiesce(opened, session.sessionManager);
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
			await operationLease.bindSessionOperationAuthority(manager, authority);
			expect(operationLease.hasBoundSessionOperationAuthority(manager)).toBe(true);
			valid = false;
			expect(operationLease.hasBoundSessionOperationAuthority(manager)).toBe(true);
			await control.close();
			expect(operationLease.hasBoundSessionOperationAuthority(manager)).toBe(true);
		} finally {
			await control.close();
		}
	});
	it("reserves duplicate operation IDs before an awaited durable intent", async () => {
		const intent = Promise.withResolvers<void>();
		const intentStarted = Promise.withResolvers<void>();
		const { store, records } = await createOperationStore(async record => {
			if (record.kind !== "operation" || record.phase !== "intent") return;
			intentStarted.resolve();
			await intent.promise;
		});
		const { manager, close } = installDurableOperationManager(store);
		let callbacks = 0;
		try {
			const first = runFilesystemOperation(manager, "filesystem:duplicate", async () => {
				callbacks++;
				return "written";
			});
			await intentStarted.promise;
			await expect(
				runFilesystemOperation(manager, "filesystem:duplicate", async () => {
					callbacks++;
					return "duplicate";
				}),
			).rejects.toThrow(/already-active/i);
			expect(callbacks).toBe(0);
			intent.resolve();
			await expect(first).resolves.toBe("written");
			expect(callbacks).toBe(1);
			expect(operationPhases(records)).toEqual(["intent", "effect", "committed", "completed"]);
		} finally {
			await close();
		}
	});

	it("revalidates bound ownership after a durable intent wait", async () => {
		const intent = Promise.withResolvers<void>();
		const intentStarted = Promise.withResolvers<void>();
		const { store } = await createOperationStore(async record => {
			if (record.kind !== "operation" || record.phase !== "intent") return;
			intentStarted.resolve();
			await intent.promise;
		});
		const { manager, close } = installDurableOperationManager(store);
		let authorityIsCurrent = true;
		const authority = operationLease.issueBoundSessionOperationAuthority(
			{
				capability: {},
				actorId: "Worker",
				rootId: "Main",
				generation: 1,
				sessionFile: null,
				validate: () => authorityIsCurrent,
			},
			manager,
		);
		await operationLease.bindSessionOperationAuthority(manager, authority);
		let callbacks = 0;
		try {
			const pending = runFilesystemOperation(manager, "filesystem:stale", async () => {
				callbacks++;
				return "must not run";
			});
			await intentStarted.promise;
			authorityIsCurrent = false;
			intent.resolve();
			await expect(pending).rejects.toThrow(/stale|current|authority/i);
			expect(callbacks).toBe(0);
		} finally {
			await close();
		}
	});

	it("does not invoke the effect or retry an intent after a lost worker acknowledgement", async () => {
		const { store, records } = await createOperationStore(async record => {
			if (record.kind !== "operation" || record.phase !== "intent") return;
			throw Object.assign(new Error("worker acknowledgement lost"), { unknownOutcome: true });
		});
		const { manager, close } = installDurableOperationManager(store);
		let callbacks = 0;
		try {
			await expect(
				runFilesystemOperation(manager, "filesystem:lost-ack", async () => {
					callbacks++;
					return "must not run";
				}),
			).rejects.toThrow("worker acknowledgement lost");
			expect(callbacks).toBe(0);
			expect(records).toHaveLength(1);
			const [intentRecord] = records;
			if (!intentRecord || intentRecord.kind !== "operation")
				throw new Error("Lost acknowledgement must retain its operation intent.");
			expect(intentRecord.phase).toBe("intent");
		} finally {
			await close();
		}
	});
	it("awaits resource authorization before O_CREAT and resource completion before success", async () => {
		const effectAuthorization = Promise.withResolvers<void>();
		const effectStarted = Promise.withResolvers<void>();
		const resourceCompletion = Promise.withResolvers<void>();
		const completionStarted = Promise.withResolvers<void>();
		const { store, records, directory } = await createOperationStore(async record => {
			if (record.kind !== "resource") return;
			if (record.phase === "effect") {
				effectStarted.resolve();
				await effectAuthorization.promise;
			}
			if (record.phase === "completed") {
				completionStarted.resolve();
				await resourceCompletion.promise;
			}
		});
		const { manager, close } = installDurableOperationManager(store);
		const authority = operationLease.issueBoundSessionOperationAuthority(
			{
				capability: {},
				actorId: "Worker",
				rootId: "Main",
				generation: 1,
				sessionFile: null,
				validate: () => true,
			},
			manager,
		);
		await operationLease.bindSessionOperationAuthority(manager, authority);
		const scope = new SessionPathScope({
			actorId: () => "Worker",
			sessionId: () => "session-1",
			operationManager: () => manager,
			cwd: () => directory,
			permissionScope: () => undefined,
		});
		const targetPath = path.join(directory, "effect-authorized.txt");
		let callbackReturned = false;
		const operationId = "filesystem:resource-boundary";
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async operation => {
				const target = await operation.authorize(targetPath, "create");
				await operation.writeFile(target, "authorized bytes");
				callbackReturned = true;
				return "written";
			}),
		);
		try {
			await effectStarted.promise;
			await expect(fs.readFile(targetPath, "utf8")).rejects.toThrow();
			expect(callbackReturned).toBe(false);
			effectAuthorization.resolve();
			await completionStarted.promise;
			expect(await fs.readFile(targetPath, "utf8")).toBe("authorized bytes");
			expect(callbackReturned).toBe(false);
			resourceCompletion.resolve();
			await expect(pending).resolves.toBe("written");
			expect(callbackReturned).toBe(true);
			expect(records.filter(record => record.kind === "resource").map(record => record.phase)).toEqual([
				"intent",
				"effect",
				"committed",
				"completed",
			]);
		} finally {
			effectAuthorization.resolve();
			resourceCompletion.resolve();
			await close();
		}
	});
	it("does not resolve a resource handle close before durable completion", async () => {
		const resourceCompletion = Promise.withResolvers<void>();
		const completionStarted = Promise.withResolvers<void>();
		const { store, directory } = await createOperationStore(async record => {
			if (record.kind === "resource" && record.phase === "completed") {
				completionStarted.resolve();
				await resourceCompletion.promise;
			}
		});
		const { manager, close } = installDurableOperationManager(store);
		const authority = operationLease.issueBoundSessionOperationAuthority(
			{
				capability: {},
				actorId: "Worker",
				rootId: "Main",
				generation: 1,
				sessionFile: null,
				validate: () => true,
			},
			manager,
		);
		await operationLease.bindSessionOperationAuthority(manager, authority);
		const targetPath = path.join(directory, "read-resource.txt");
		await fs.writeFile(targetPath, "read bytes");
		const scope = new SessionPathScope({
			actorId: () => "Worker",
			sessionId: () => "session-1",
			operationManager: () => manager,
			cwd: () => directory,
			permissionScope: () => undefined,
		});
		let closeReturned = false;
		const operationId = "filesystem:resource-close";
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async operation => {
				const target = await operation.authorize(targetPath, "read");
				const handle = await operation.openRead(target);
				await handle.close();
				closeReturned = true;
				return "closed";
			}),
		);
		try {
			await completionStarted.promise;
			expect(closeReturned).toBe(false);
			resourceCompletion.resolve();
			await expect(pending).resolves.toBe("closed");
			expect(closeReturned).toBe(true);
		} finally {
			resourceCompletion.resolve();
			await close();
		}
	});
	it("awaits durable cancellation when a resource effect fails", async () => {
		const cancellation = Promise.withResolvers<void>();
		const cancellationStarted = Promise.withResolvers<void>();
		const { store, records, directory } = await createOperationStore(async record => {
			if (record.kind === "resource" && record.phase === "cancelled") {
				cancellationStarted.resolve();
				await cancellation.promise;
			}
		});
		const { manager, close } = installDurableOperationManager(store);
		const authority = operationLease.issueBoundSessionOperationAuthority(
			{
				capability: {},
				actorId: "Worker",
				rootId: "Main",
				generation: 1,
				sessionFile: null,
				validate: () => true,
			},
			manager,
		);
		await operationLease.bindSessionOperationAuthority(manager, authority);
		const targetPath = path.join(directory, "directory-target");
		await fs.mkdir(targetPath);
		const scope = new SessionPathScope({
			actorId: () => "Worker",
			sessionId: () => "session-1",
			operationManager: () => manager,
			cwd: () => directory,
			permissionScope: () => undefined,
		});
		const operationId = "filesystem:resource-cancel";
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async operation => {
				const target = await operation.authorize(targetPath, "write");
				await operation.writeFile(target, "cannot replace a directory");
			}),
		);
		let settled = false;
		const observedPending = pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await cancellationStarted.promise;
			await Promise.resolve();
			expect(settled).toBe(false);
			cancellation.resolve();
			await expect(pending).rejects.toThrow();
			await observedPending;
			expect(records.filter(record => record.kind === "resource").map(record => record.phase)).toEqual([
				"intent",
				"effect",
				"cancelled",
			]);
		} finally {
			cancellation.resolve();
			await close();
		}
	});
	it("does not repeat an effect after terminal acknowledgement is lost", async () => {
		const { store, records } = await createOperationStore(async record => {
			if (record.kind === "operation" && record.phase === "completed") {
				throw Object.assign(new Error("terminal acknowledgement lost"), { unknownOutcome: true });
			}
		});
		const { manager, close } = installDurableOperationManager(store);
		let callbacks = 0;
		const run = () =>
			runFilesystemOperation(manager, "filesystem:terminal-lost-ack", async () => {
				callbacks++;
				return "written";
			});
		try {
			await expect(run()).rejects.toThrow("terminal acknowledgement lost");
			await expect(run()).rejects.toThrow(/not admitted: terminal/i);
			expect(callbacks).toBe(1);
			expect(records.filter(record => record.kind === "operation").map(record => record.phase)).toEqual([
				"intent",
				"effect",
				"committed",
				"completed",
			]);
		} finally {
			await close();
		}
	});
});
