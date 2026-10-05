import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
	setAgentStatus,
} from "../../src/internal/agent-registry-bridge";
import {
	adoptAgent,
	getAgentLifecycleManager,
	releaseAgent,
	resetAgentLifecycleForTests,
} from "../../src/internal/agent-lifecycle-bridge";
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
const tempRoots: string[] = [];
const authoritySessions = new Set<AgentSession>();

async function createAuthorityFixture() {
	const registry = AgentRegistry.global();
	const root = await createAgentRootSession(registry, {
		cwd: process.cwd(),
		agentDir: "/tmp",
		settings: Settings.isolated({}),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
		skipPythonPreflight: true,
	});
	const authority = bindInternalAgentAuthoritySession(registry, root.session);
	authoritySessions.add(root.session);
	if (!authority) throw new Error("Test fixture requires a live parent-bound authority session.");
	return {
		registry,
		root: root.session,
		createAuthoritySession: (
			options: Parameters<NonNullable<ToolSession["createAuthoritySession"]>>[0],
			reviveRef?: Parameters<NonNullable<ToolSession["createAuthoritySession"]>>[1],
		) => authority.create(options, reviveRef),
	};
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of authoritySessions) await session.dispose();
	authoritySessions.clear();
	resetAgentLifecycleForTests();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

/**
 * Runs a kept-alive branch-mode isolated agent whose workspace delta is
 * `runEndPatch` when it finishes and `releasePatch` when it is released, and
 * returns how many times a task branch was committed.
 */
async function commitsAcrossRelease(id: string, runEndPatch: string, releasePatch: string): Promise<number> {
	const { registry, root, createAuthoritySession } = await createAuthorityFixture();
	const lifecycle = getAgentLifecycleManager(registry);
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-"));
	tempRoots.push(artifactsDir);
	const baseline = {
		root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
		nested: [],
	};
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: "/repo/isolated",
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: releasePatch, nestedPatches: [] });
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
		branchName: `omp/task/${id}`,
		baseSha: "base",
		rootPatch: runEndPatch,
		nestedPatches: [],
	});
	const session = {
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	let exactRef: AgentRef | undefined;
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		registry.register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: `/tmp/${options.id}.jsonl`,
			status: "running",
		});
		const attachedRef = lookupAgentRef(registry, options.id);
		if (!attachedRef) throw new Error("Expected attached child registry ref before lifecycle adoption.");
		exactRef = attachedRef;
		options.onHistoryAuthorityClaimed?.(session);
		if (!setAgentStatus(registry, options.id, "idle", session)) {
			throw new Error("Expected live child authority fixture");
		}
		adoptAgent(lifecycle, options.id, { idleTtlMs: 0, onRelease: options.onRelease }, attachedRef);
		await executorModule.finalizeSubagentLifecycle({
			id: options.id,
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: 0,
			agentRegistry: registry,
			agentLifecycle: lifecycle,
		});
		return result(options.id);
	});

	await runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
			agentRegistry: registry,
			createAuthoritySession,
		},
		context: { repoRoot: "/repo" },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "branch",
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	if (!exactRef) throw new Error("Expected attached child registry ref after isolated execution.");
	await releaseAgent(lifecycle, id, exactRef);
	return commitSpy.mock.calls.length;
}

describe("isolated agent release", () => {
	const patch = "diff --git a/task.txt b/task.txt\n+work\n";

	it("does not re-commit a workspace that is unchanged since the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseUnchanged", patch, patch)).toBe(1);
	});

	it("commits follow-up work made after the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseChanged", patch, `${patch}+follow-up\n`)).toBe(2);
	});
});
