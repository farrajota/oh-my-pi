/**
 * The bash tool's persistent shell: state set by one call (variables,
 * functions, options) is visible to the next call through the default
 * auto-background path, including after a call moved to the background and
 * after a call that exited non-zero. That `exit` and errexit keep the native
 * session is pinned in `crates/pi-shell` (`exit_and_errexit_keep_session_state`):
 * pull-request CI runs these tests against main's native addon.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { releaseShellSessions } from "../src/exec/bash-executor";
import { getSessionLocalProtocolOptions } from "../src/internal-urls";
import { registerToolSessionLifecycleAuthority } from "../src/internal/agent-lifecycle-bridge";
import { createAgentRootSession } from "../src/internal/agent-registry-bridge";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

let cwd: string;
let manager: AsyncJobManager;
let owner: AgentSession | undefined;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-session-state-"));
});

afterEach(async () => {
	if (owner) {
		releaseShellSessions(owner.sessionManager.getSessionId());
		await owner.dispose();
		owner = undefined;
	}
	releaseShellSessions(cwd);
	await fs.rm(cwd, { recursive: true, force: true });
});

async function bashTool(
	settings: Record<string, unknown> = {},
	overrides: Partial<ToolSession> = {},
): Promise<BashTool> {
	const registry = new AgentRegistry();
	const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	await sessionManager.ensureOnDisk();
	({ session: owner } = await createAgentRootSession(registry, {
		cwd,
		agentDir: cwd,
		agentId: "Main",
		sessionManager,
		settings: Settings.isolated({
			"async.enabled": true,
			"launch.enabled": false,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			...settings,
		}),
		toolNames: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	}));
	const ownedManager = owner.asyncJobManager;
	if (!ownedManager) throw new Error("Expected the shell fixture's owned async job manager");
	manager = ownedManager;
	const localProtocolOptions = getSessionLocalProtocolOptions(sessionManager);
	if (!localProtocolOptions) throw new Error("Expected the shell fixture's registered local protocol scope");
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		sessionManager,
		agentRegistry: registry,
		localProtocolOptions,
		pathScope: localProtocolOptions.getPathScope?.(),
		settings: owner.settings,
		...overrides,
	};
	registerToolSessionLifecycleAuthority(session, registry, owner);
	return new BashTool(session);
}

async function run(tool: BashTool, command: string) {
	const result = await tool.execute("bash-session-state", { command });
	const text = result.content.find(block => block.type === "text")?.text ?? "";
	return { text, async: result.details?.async };
}

it.skipIf(process.platform === "win32")("keeps a variable set by one call for the next call", async () => {
	const tool = await bashTool();
	await run(tool, "PI_STATE_VAR=kept");
	expect((await run(tool, 'printf "%s" "$PI_STATE_VAR"')).text).toBe("kept");
});

it.skipIf(process.platform === "win32")("keeps a function defined by one call callable in the next call", async () => {
	const tool = await bashTool();
	await run(tool, "pi_state_fn() { printf 'called %s' \"$1\"; }");
	expect((await run(tool, "pi_state_fn twice")).text).toBe("called twice");
});

it.skipIf(process.platform === "win32")(
	"keeps state set by a call that moved to the background once it finishes",
	async () => {
		const tool = await bashTool({ "bash.autoBackground.thresholdMs": 100 });
		const started = await run(tool, "PI_STATE_VAR=from-bg; pi_bg_fn() { printf fn; }; sleep 1");
		expect(started.async?.state).toBe("running");
		await manager.waitForAll();
		expect((await run(tool, 'printf "%s:" "$PI_STATE_VAR"; pi_bg_fn')).text).toBe("from-bg:fn");
	},
	10_000,
);

it.skipIf(process.platform === "win32")("keeps state and options after a call that exits non-zero", async () => {
	const tool = await bashTool();
	await run(tool, "set -uo pipefail; PI_STATE_VAR=kept");
	expect((await run(tool, "false")).text).toContain("Command exited with code 1");
	expect((await run(tool, 'printf "%s %s" "$PI_STATE_VAR" "$-"')).text).toMatch(/^kept \S*u\S*$/);
});

it.skipIf(process.platform === "win32")(
	"reports calls that overlap a backgrounded one and leaves the session shell intact",
	async () => {
		const tool = await bashTool({ "bash.autoBackground.thresholdMs": 100 });
		await run(tool, "PI_STATE_VAR=kept");
		expect((await run(tool, "sleep 2")).async?.state).toBe("running");

		const overlapping = await run(tool, 'printf "[%s]" "$PI_STATE_VAR"; PI_STATE_VAR=lost');
		expect(overlapping.text).toStartWith("[]");
		expect(overlapping.text).toContain("Ran in a temporary shell");
		// An overlapping call that itself moves to the background says so in its start result.
		const promoted = await run(tool, "sleep 0.5");
		expect(promoted.async?.state).toBe("running");
		expect(promoted.text).toContain("Ran in a temporary shell");

		await manager.waitForAll();
		expect((await run(tool, 'printf "%s" "$PI_STATE_VAR"')).text).toBe("kept");
	},
	10_000,
);

it.skipIf(process.platform === "win32")(
	"runs a call in the shell of the session it started in when the session changes first",
	async () => {
		const heldAllocation = Promise.withResolvers<{ id?: string; path?: string }>();
		let allocations = 0;
		const tool = await bashTool(
			{ "bash.autoBackground.thresholdMs": 100 },
			{
				// Holds the first call before its shell starts, so the session changes underneath it.
				allocateOutputArtifact: async () => (allocations++ === 0 ? heldAllocation.promise : {}),
			},
		);
		const sessionManager = owner!.sessionManager;
		const first = sessionManager.getSessionId();
		const firstFile = sessionManager.getSessionFile();
		if (!firstFile) throw new Error("Expected the shell fixture's persisted first session");
		let second: string | undefined;
		try {
			expect((await run(tool, "PI_STATE_VAR=from-first")).async?.state).toBe("running");
			await sessionManager.newSession();
			second = sessionManager.getSessionId();
			heldAllocation.resolve({});
			await manager.waitForAll();

			expect((await run(tool, 'printf "[%s]" "$PI_STATE_VAR"')).text).toBe("[]");
			// The left session's shell was dropped when that call finished.
			await sessionManager.setSessionFile(firstFile);
			expect((await run(tool, 'printf "[%s]" "$PI_STATE_VAR"')).text).toBe("[]");
		} finally {
			releaseShellSessions(first);
			if (second) releaseShellSessions(second);
		}
	},
	10_000,
);
