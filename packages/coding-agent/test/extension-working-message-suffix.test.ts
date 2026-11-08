/**
 * `pi.registerWorkingMessageSuffix(name, renderer)` lets an extension append live run
 * metrics (elapsed time, run tokens) to the interactive working row.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAPI,
	ExtensionError,
	ExtensionFactory,
	WorkingMessageSuffixContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { runUsageTokens, workingMessageSuffixContext } from "@oh-my-pi/pi-coding-agent/modes/working-message-suffix";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const CONTEXT: WorkingMessageSuffixContext = {
	now: 1_700_000_005_250,
	startedAt: 1_700_000_000_000,
	elapsedMs: 5_250,
	runTokenDelta: 42,
	cwd: "/workspace/project",
};

function assistant(
	timestamp: number,
	usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		stopReason: "toolUse",
		timestamp,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			totalTokens: usage.input + usage.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

function user(timestamp: number): AgentMessage {
	return { role: "user", content: "go", timestamp } as AgentMessage;
}

describe("ExtensionRunner.renderWorkingMessageSuffix", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-working-suffix-runner-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	async function runnerFor(factories: Array<[string, ExtensionFactory]>): Promise<ExtensionRunner> {
		const runtime = new ExtensionRuntime();
		const extensions = [];
		for (const [name, factory] of factories) {
			extensions.push(await loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, name));
		}
		return new ExtensionRunner(
			extensions,
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		);
	}

	it("reports no suffix renderers when no extension registered one", async () => {
		const runner = await runnerFor([["/ext/none.ts", () => {}]]);

		expect(runner.hasWorkingMessageSuffixes()).toBe(false);
		expect(runner.renderWorkingMessageSuffix("Working", CONTEXT)).toBe("");
	});

	it("concatenates suffixes in extension order, then registration order", async () => {
		const runner = await runnerFor([
			[
				"/ext/first.ts",
				(pi: ExtensionAPI) => {
					pi.registerWorkingMessageSuffix("message", message => ` [${message}]`);
					pi.registerWorkingMessageSuffix(
						"metrics",
						(_message, state) => ` [${state.elapsedMs}ms/+${state.runTokenDelta} tokens]`,
					);
					pi.registerWorkingMessageSuffix("empty", () => undefined);
				},
			],
			["/ext/second.ts", pi => pi.registerWorkingMessageSuffix("second", () => " [second]")],
		]);

		expect(runner.hasWorkingMessageSuffixes()).toBe(true);
		expect(runner.renderWorkingMessageSuffix("Working", CONTEXT)).toBe(" [Working] [5250ms/+42 tokens] [second]");
	});

	it("reports a throwing renderer once and skips it afterwards", async () => {
		let throwingCalls = 0;
		const runner = await runnerFor([
			[
				"/ext/faulty.ts",
				pi => {
					pi.registerWorkingMessageSuffix("faulty", () => {
						throwingCalls += 1;
						throw new Error("suffix failed");
					});
					pi.registerWorkingMessageSuffix("healthy", () => " [healthy]");
				},
			],
		]);
		const errors: ExtensionError[] = [];
		runner.onError(error => errors.push(error));

		expect(runner.renderWorkingMessageSuffix("Working", CONTEXT)).toBe(" [healthy]");
		expect(runner.renderWorkingMessageSuffix("Working", CONTEXT)).toBe(" [healthy]");
		expect(throwingCalls).toBe(1);
		expect(errors).toEqual([
			{
				extensionPath: "/ext/faulty.ts",
				event: "working_message_suffix:faulty",
				error: "suffix failed",
				stack: expect.any(String),
			},
		]);
	});
});

describe("working message suffix context", () => {
	it("counts the billed tokens of assistant messages sent since the run started", () => {
		const messages: AgentMessage[] = [
			assistant(900, { input: 5_000, output: 100 }),
			user(999),
			assistant(1_000, { input: 300, output: 50, cacheRead: 9_000, cacheWrite: 200 }),
			assistant(1_500, { input: 40, output: 10 }),
		];

		// Cache reads re-read context the run did not add, so they stay out, as in the turn usage line.
		expect(runUsageTokens(messages, 1_000)).toBe(300 + 50 + 200 + 40 + 10);
		expect(runUsageTokens(messages, undefined)).toBe(0);
	});

	it("measures elapsed time from the session's run start", () => {
		const context = workingMessageSuffixContext(
			{ runStartedAt: 1_000, state: { messages: [assistant(1_200, { input: 10, output: 5 })] } },
			"/repo",
			3_500,
		);

		expect(context).toEqual({ now: 3_500, startedAt: 1_000, elapsedMs: 2_500, runTokenDelta: 15, cwd: "/repo" });
	});

	it("leaves elapsed time unset while the session is idle", () => {
		const context = workingMessageSuffixContext({ runStartedAt: undefined, state: { messages: [] } }, "/repo", 3_500);

		expect(context.startedAt).toBeUndefined();
		expect(context.elapsedMs).toBeUndefined();
		expect(context.runTokenDelta).toBe(0);
	});
});

describe("InteractiveMode working row suffix", () => {
	const COLUMNS = 100;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	const contexts: WorkingMessageSuffixContext[] = [];

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-working-suffix-mode-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerWorkingMessageSuffix("metrics", (_message, state) => {
					contexts.push(state);
					return ` +${state.runTokenDelta ?? 0} tokens`;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"/ext/metrics.ts",
		);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [user(Date.now() - 2_000), assistant(Date.now() - 1_000, { input: 1_000, output: 234 })],
				},
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		const runStartedAt = Date.now() - 1_500;
		Object.defineProperty(session, "runStartedAt", { configurable: true, get: () => runStartedAt });
		mode = new InteractiveMode(session, "test");
		Object.defineProperty(mode.ui.terminal, "columns", { get: () => COLUMNS, configurable: true });
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
	});

	function workingRow(): string {
		const rows = mode.statusContainer
			.render(COLUMNS)
			.map(line => Bun.stripANSI(line).trimEnd())
			.filter(line => line.length > 0);
		expect(rows).toHaveLength(1);
		return rows[0] ?? "";
	}

	it("appends extension suffixes to the default and to a custom working message", () => {
		mode.ensureLoadingAnimation();
		expect(workingRow()).toContain("+1234 tokens");

		mode.setWorkingMessage("Reading files");
		const row = workingRow();
		expect(row).toContain("Reading files +1234 tokens");

		const last = contexts.at(-1);
		expect(last?.startedAt).toBe(session.runStartedAt);
		expect(last?.elapsedMs).toBeGreaterThanOrEqual(1_500);
		expect(last?.cwd).toBe(tempDir.path());
	});
});
