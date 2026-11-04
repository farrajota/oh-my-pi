/**
 * Contract (issue #11493): a session store that fails on its very first write —
 * before print mode installs its persistence subscription — still surfaces to a
 * headless consumer through the CLI shutdown path: the diagnostic reaches
 * stderr, the process terminator is handed a nonzero code, and no raw
 * postmortem fatal dump is written. `runRootCommand` rethrows the persistence
 * failure to its caller; `runRootCommandAtCliBoundary` (what `omp` launch runs)
 * turns it into that exit. The same holds when the disk is already full while
 * root startup materializes its transcript, before any session exists.
 *
 * `test/modes/print-persistence-failure.test.ts` covers the mode functions in
 * isolation; this file drives the externally observable shutdown path the three
 * review threads (3979594811, 3979644907, 3983906393) asked for.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { parseArgs, type Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommandAtCliBoundary } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir, postmortem } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

/**
 * postmortem's raw fatal dump is the renderer's own output — the error text
 * and its stack frames — written to fd 2. An indented stack-frame line is what
 * separates it from the one-line persistence diagnostics. Naming the shape
 * (rather than asserting "no text") keeps the absence check failing for the
 * right reason.
 */
const RAW_FATAL_DUMP_RE = /(?:^|\n)\s+at [^\n]*:\d+:\d+/;

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/**
 * Make every store write fail the way a full disk does, on the real write path.
 * The three primitives are the ones the file-session storage uses: the atomic
 * full-body publish (`writeFile`), the synchronous cold rewrite
 * (`writeFileSync`), and the append writer's hot path (`writeSync`). Arming all
 * three is what makes the store fail from its very first write onward.
 */
function failWrites(): () => void {
	const failure = (): never => {
		throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
	};
	const spies = [
		spyOn(fs, "writeSync").mockImplementation(failure),
		spyOn(fs, "writeFileSync").mockImplementation(failure),
		spyOn(fs.promises, "writeFile").mockImplementation(failure as never),
	];
	return () => {
		for (const spy of spies) spy.mockRestore();
	};
}

function captureStderr(): { written: () => string; restore: () => void } {
	const chunks: string[] = [];
	const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as never);
	return { written: () => chunks.join(""), restore: () => spy.mockRestore() };
}

/**
 * `AgentSession.dispose()` memoizes its first call, so awaiting it again
 * rethrows the identical rejection instead of re-running teardown
 * (agent-session.ts `#disposeCall`).
 */
function memoizingDispose(manager: SessionManager): () => Promise<void> {
	let call: Promise<void> | undefined;
	return () => {
		call ??= manager.close();
		return call;
	};
}

/**
 * Dependencies handed to `runRootCommand`: the injected session factory and
 * auth/settings seams, so the real print-mode branch and its shutdown path run
 * against a store that is already failing.
 */
interface ShutdownHarnessDeps {
	discoverAuthStorage: () => Promise<AuthStorage>;
	settings: Settings;
	createAgentSession: () => Promise<CreateAgentSessionResult>;
}

/**
 * A print-mode session backed by a real {@link SessionManager} whose store is
 * already failing. `recordFirstWrite` performs the session's very first durable
 * write — header materialization — so the failure latches before any mode
 * installs a persistence subscription, then proves the latch through the
 * manager's public replay API.
 */
interface ShutdownHarness {
	parsed: Args;
	rawArgs: string[];
	/** Calls of the injected session factory; startup failures never reach it. */
	sessionFactoryCalls: () => number;
	session: AgentSession;
	manager: SessionManager;
	authStorage: AuthStorage;
	/** Failures replayed by the manager before any mode subscribed. */
	latchedBeforeRun: Error[];
	restoreWrites: () => void;
	recordFirstWrite: () => Promise<void>;
	deps: ShutdownHarnessDeps;
}

async function createHarness(armWrites: "session" | "startup" = "session"): Promise<ShutdownHarness> {
	const dir = TempDir.createSync("@pi-headless-shutdown-");
	tempDirs.push(dir);
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
	const latchedBeforeRun: Error[] = [];

	const session = {
		extensionRunner: undefined,
		model: { provider: "anthropic", id: "test-model" },
		settings: Settings.isolated(),
		sessionManager: manager,
		subscribe: () => {},
		addDisposer: () => {},
		getAllToolNames: () => [],
		validateRetryFallbackChains: () => {},
		getLastAssistantMessage: () => undefined,
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForIdle: async () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		// Later writes keep failing on the real store path; the manager latches
		// once and reports the failure a single time.
		prompt: async () => {
			manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
		},
		dispose: memoizingDispose(manager),
	} as unknown as AgentSession;

	const parsed: Args = parseArgs(["--print", "hello"]);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = dir.path();
	const rawArgs = ["--print", "hello"];

	// Root startup materializes its own transcript before the authority store opens, so the
	// store failure is armed at session creation: the injected session's first write is the
	// first write this scenario fails.
	let disarmWrites: (() => void) | undefined = armWrites === "startup" ? failWrites() : undefined;
	const restoreWrites = () => {
		disarmWrites?.();
		disarmWrites = undefined;
	};

	async function recordFirstWrite(): Promise<void> {
		await manager.ensureOnDisk().catch(() => undefined);
		const unsubscribe = manager.onPersistenceError(error => latchedBeforeRun.push(error));
		unsubscribe();
	}

	let sessionFactoryCalls = 0;
	const deps = {
		discoverAuthStorage: async () => authStorage,
		settings,
		createAgentSession: async () => {
			sessionFactoryCalls++;
			disarmWrites ??= failWrites();
			await recordFirstWrite();
			return { session } as unknown as CreateAgentSessionResult;
		},
	};

	return {
		parsed,
		rawArgs,
		sessionFactoryCalls: () => sessionFactoryCalls,
		session,
		manager,
		authStorage,
		latchedBeforeRun,
		restoreWrites,
		recordFirstWrite,
		deps,
	};
}

async function teardown(
	harness: ShutdownHarness,
	stderr: { restore: () => void },
	quitSpy?: { mockRestore: () => void },
): Promise<void> {
	stderr.restore();
	harness.restoreWrites();
	quitSpy?.mockRestore();
	harness.authStorage.close();
	await harness.manager.close().catch(() => undefined);
}

describe("headless persistence-failure shutdown path", () => {
	it("reports a first-write store failure and exits nonzero without a raw fatal dump", async () => {
		const harness = await createHarness();
		const stderr = captureStderr();
		const quitCodes: number[] = [];
		const quitSpy = spyOn(postmortem, "quit").mockImplementation(async (code?: number) => {
			quitCodes.push(code ?? 0);
		});

		let escaped: unknown;
		try {
			await runRootCommandAtCliBoundary(harness.parsed, harness.rawArgs, harness.deps);
		} catch (error) {
			// `cli.ts` runs `runCli(...).catch(fatal)`, and `fatal()` renders
			// `Bun.inspect(error)` onto fd 2. Reproduce that here so the stderr
			// asserted below is the stderr an `omp --print` user would get.
			escaped = error;
			process.stderr.write(`${Bun.inspect(error, { colors: false })}\n`);
		} finally {
			await teardown(harness, stderr, quitSpy);
		}

		const output = stderr.written();
		// 1. No raw fatal dump.
		expect(output).not.toMatch(RAW_FATAL_DUMP_RE);
		expect(escaped).toBeUndefined();
		// 2. The persistence diagnostic reaches stderr.
		expect(output).toContain("Session persistence failed: ");
		expect(output).toContain("ENOSPC");
		// 3. The process terminator was handed a nonzero code.
		expect(quitCodes).toEqual([1]);
		// The property under test: the store already held this failure before
		// print mode subscribed, and its first write never landed.
		expect(harness.latchedBeforeRun).toHaveLength(1);
		expect(harness.latchedBeforeRun[0]?.message).toContain("ENOSPC");
		const sessionFile = harness.manager.getSessionFile();
		expect(sessionFile).toBeString();
		expect(fs.existsSync(String(sessionFile))).toBe(false);
	}, 15_000);

	it("reports a disk-full root startup cleanly and exits nonzero without a raw fatal dump", async () => {
		const harness = await createHarness("startup");
		const stderr = captureStderr();
		const quitCodes: number[] = [];
		const quitSpy = spyOn(postmortem, "quit").mockImplementation(async (code?: number) => {
			quitCodes.push(code ?? 0);
		});

		let escaped: unknown;
		try {
			await runRootCommandAtCliBoundary(harness.parsed, harness.rawArgs, harness.deps);
		} catch (error) {
			// Same reproduction of `cli.ts`'s `fatal()` rendering as above.
			escaped = error;
			process.stderr.write(`${Bun.inspect(error, { colors: false })}\n`);
		} finally {
			await teardown(harness, stderr, quitSpy);
		}

		const output = stderr.written();
		expect(output).not.toMatch(RAW_FATAL_DUMP_RE);
		expect(escaped).toBeUndefined();
		expect(output).toContain("Session persistence failed: ");
		expect(output).toContain("ENOSPC");
		expect(quitCodes).toEqual([1]);
		// Root startup could not materialize the transcript its authority needs, so no
		// session was created and no transcript landed in the session directory.
		expect(harness.sessionFactoryCalls()).toBe(0);
		const transcripts = fs
			.readdirSync(String(harness.parsed.sessionDir), { recursive: true })
			.filter(entry => String(entry).endsWith(".jsonl"));
		expect(transcripts).toEqual([]);
	}, 15_000);
});
