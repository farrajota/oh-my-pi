/**
 * Background (`detached`) subagent runs outlive the task tool call that
 * launched them. The spawning call is a session operation whose authority
 * effect scope stops admitting nested effects once the call returns, so a
 * detached child must admit its own root-level operations on the shared root
 * authority instead of nesting under the settled call. Non-detached late
 * continuations keep being refused: that guard is what stops escaped callbacks
 * from acting after their owner published its terminal state.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { getOperationTerminal, runSessionOperation } from "../../src/registry/operation-lease";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdk from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";
import { createBoundOperationLedger, createRootAuthorityStore } from "../helpers/operation-authority";
import { createSessionDefaults } from "../helpers/session-defaults";

const directories: string[] = [];
const closeStores: Array<() => Promise<void>> = [];
const closeControls: Array<() => Promise<void>> = [];
const authorityRoots: AgentSession[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of authorityRoots.splice(0)) await root.dispose();
	await Promise.all(closeControls.splice(0).map(close => close()));
	await Promise.all(closeStores.splice(0).map(close => close()));
	await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const childAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

/** Child that answers its first prompt with a terminal `yield`. */
function createYieldingChild(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: "child done" },
				},
			} as AgentSessionEvent);
			return true;
		},
		getLastAssistantMessage: () => messages[messages.length - 1],
		beginDispose: () => {},
	};
	return session as unknown as AgentSession;
}

/**
 * Mirrors the task tool's background path: the spawning call is a session
 * operation that returns as soon as the job is registered, and the job body
 * runs the child later from a continuation created inside that call.
 */
async function runChildAfterSpawningCallSettles(detached: boolean): Promise<{
	result: SingleResult;
	manager: object;
	creationOperationId: string;
}> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-detached-child-authority-"));
	directories.push(directory);
	const authority = await createRootAuthorityStore(directory);
	closeStores.push(authority.close);
	const { manager, close } = await createBoundOperationLedger(authority.store);
	closeControls.push(close);
	const agentRegistry = new AgentRegistry();
	const root = await createAgentRootSession(agentRegistry, { agentId: "Main" });
	authorityRoots.push(root.session);
	const binding = bindInternalAgentAuthoritySession(agentRegistry, root.session);
	if (!binding) throw new Error("Test fixture requires parent authority");
	vi.spyOn(sdk, "createAgentSession").mockResolvedValue({
		session: createYieldingChild(),
		extensionsResult: {},
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as unknown as CreateAgentSessionResult);

	const creationOperationId = `session:DetachedChild:${Bun.randomUUIDv7()}`;
	const spawningCallSettled = Promise.withResolvers<void>();
	let job: Promise<SingleResult> | undefined;
	await runSessionOperation(manager, "session:spawning-task-call", async () => {
		job = (async () => {
			await spawningCallSettled.promise;
			return runSubprocess({
				cwd: directory,
				agent: childAgent,
				task: "Reply with the word ok.",
				index: 0,
				id: "DetachedChild",
				detached,
				agentRegistry,
				parentAgentId: "Main",
				createAuthoritySession: (options, reviveRef) =>
					runSessionOperation(manager, creationOperationId, () => binding.create(options, reviveRef)),
			});
		})();
	});
	expect(getOperationTerminal(manager, "session:spawning-task-call")?.status).toBe("completed");
	spawningCallSettled.resolve();
	return { result: await job!, manager, creationOperationId };
}

describe("detached subagent authority ownership", () => {
	test("detached child admits its own root-level operation after the spawning call settled", async () => {
		const { result, manager, creationOperationId } = await runChildAfterSpawningCallSettles(true);

		expect(result.error ?? "").not.toContain("Authority effect scope is no longer active");
		expect(result.exitCode).toBe(0);
		expect(getOperationTerminal(manager, creationOperationId)?.status).toBe("completed");
	});

	test("a non-detached continuation of a settled call is still refused", async () => {
		const { result, manager, creationOperationId } = await runChildAfterSpawningCallSettles(false);

		expect(result.exitCode).not.toBe(0);
		expect(result.error ?? "").toContain("Authority effect scope is no longer active");
		// Refused before any durable intent: settled locally as failed, never committed.
		expect(getOperationTerminal(manager, creationOperationId)?.status).toBe("failed");
	});
});
