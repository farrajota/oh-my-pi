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
import * as sdkModule from "../../src/sdk";
import { installSessionOperationLedger } from "../../src/registry/operation-lease";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
const tempRoots: string[] = [];
const authoritySessions = new Set<AgentSession>();
/** Order of worktree captures and the run's IRC wake release. */
let events: string[] = [];

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

function makeParkableAuthoritySession(sessionFile: string, afterDispose?: () => Promise<void>): AgentSession {
	const sessionManager = { getSessionFile: () => sessionFile };
	const operationControl = installSessionOperationLedger(sessionManager);
	let disposed = false;
	return {
		sessionManager,
		beginDispose: () => {
			if (disposed) return;
			disposed = true;
			void operationControl.close();
		},
		get isDisposed() {
			return disposed;
		},
		dispose: async () => {
			disposed = true;
			await operationControl.close();
			await afterDispose?.();
		},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of authoritySessions) await session.dispose();
	authoritySessions.clear();
	resetAgentLifecycleForTests();
	events = [];
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

interface DeferredCleanupProbe {
	physicalStarted: Promise<void>;
	signalPhysicalStarted(): void;
	releasePhysical: Promise<void>;
	releasePhysicalNow(): void;
	signalFinalizerReturned(): void;
	finalizerReturned: Promise<void>;
	signalSubprocessResult(): void;
	subprocessResult: Promise<void>;
}

/**
 * Runs a kept-alive branch-mode isolated agent whose workspace delta is
 * `runEndPatch` when it finishes and `releasePatch` when it is released, and
 * returns how many times a task branch was committed.
 */
async function commitsAcrossRelease(
	id: string,
	runEndPatch: string,
	releasePatch: string,
	deferredCleanupProbe?: DeferredCleanupProbe,
): Promise<number> {
	const { registry, root, createAuthoritySession } = await createAuthorityFixture();
	const lifecycle = getAgentLifecycleManager(registry);
	let exactRef: AgentRef | undefined;
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
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
		events.push("commit");
		return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: runEndPatch, nestedPatches: [] };
	});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const grandchildId = `${options.id}/grandchild`;
		const childSession = makeParkableAuthoritySession(
			`/tmp/${options.id}.jsonl`,
			deferredCleanupProbe
				? async () => {
						deferredCleanupProbe.signalPhysicalStarted();
						await deferredCleanupProbe.releasePhysical;
					}
				: undefined,
		);
		const grandchildSession = makeParkableAuthoritySession(`/tmp/${grandchildId}.jsonl`);
		authoritySessions.add(childSession);
		authoritySessions.add(grandchildSession);
		vi.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce({ session: childSession } as sdkModule.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: grandchildSession } as sdkModule.CreateAgentSessionResult);
		const { session } = await options.createAuthoritySession({ agentId: options.id });
		const childBinding = bindInternalAgentAuthoritySession(registry, session);
		if (!childBinding) throw new Error("Expected the live child authority binding");
		await childBinding.create({ agentId: grandchildId });
		const attachedRef = lookupAgentRef(registry, options.id);
		if (!attachedRef) throw new Error("Expected attached child authority ref before lifecycle adoption.");
		exactRef = attachedRef;
		options.onHistoryAuthorityClaimed?.(session);
		if (!(await setAgentStatus(registry, options.id, "idle", session))) {
			throw new Error("Expected live child authority fixture");
		}
		adoptAgent(lifecycle, options.id, { idleTtlMs: 0, onRelease: options.onRelease }, attachedRef);
		// A held peer message would wake a turn in the worktree once released.
		options.deferIrcWakeRelease?.(() => events.push("irc wakes released"));
		let deferredCompletion: Promise<void> | undefined;
		await executorModule.finalizeSubagentLifecycle({
			id: options.id,
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: 0,
			agentRegistry: registry,
			agentLifecycle: lifecycle,
			...(deferredCleanupProbe
				? {
						cleanupDeadlineAt: Date.now() - 1,
						onCleanupDeferred: (completion: Promise<void>) => {
							deferredCompletion = completion;
							options.onCleanupDeferred?.(completion);
						},
					}
				: {}),
		});
		if (deferredCleanupProbe) {
			if (!deferredCompletion) throw new Error("Expected cleanup deferral to retain the lifecycle completion");
			deferredCleanupProbe.signalFinalizerReturned();
		}
		expect(registry.get(options.id)?.status).toBe("parked");
		expect(lookupAgentRef(registry, options.id)?.session).toBeNull();
		expect(lookupAgentRef(registry, grandchildId)).toBeUndefined();
		expect(session.isDisposed).toBe(true);
		expect(grandchildSession.isDisposed).toBe(true);
		return result(options.id);
	});

	const isolatedRun = runIsolatedSubprocess({
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
		onSubprocessResult: () => deferredCleanupProbe?.signalSubprocessResult(),
	});
	if (deferredCleanupProbe) {
		await deferredCleanupProbe.physicalStarted;
		await deferredCleanupProbe.finalizerReturned;
		await deferredCleanupProbe.subprocessResult;
		expect(commitSpy).not.toHaveBeenCalled();
		deferredCleanupProbe.releasePhysicalNow();
	}
	await isolatedRun;
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

	it("lets held peer messages wake the agent only after the run-end branch is committed", async () => {
		await commitsAcrossRelease("ReleaseAfterCapture", patch, patch);
		expect(events).toEqual(["commit", "irc wakes released"]);
	});
	it("waits for deferred authority park cleanup before capturing the workspace", async () => {
		const physicalStarted = Promise.withResolvers<void>();
		const releasePhysical = Promise.withResolvers<void>();
		const finalizerReturned = Promise.withResolvers<void>();
		const subprocessResult = Promise.withResolvers<void>();
		const probe: DeferredCleanupProbe = {
			physicalStarted: physicalStarted.promise,
			signalPhysicalStarted: () => physicalStarted.resolve(),
			releasePhysical: releasePhysical.promise,
			releasePhysicalNow: () => releasePhysical.resolve(),
			finalizerReturned: finalizerReturned.promise,
			signalFinalizerReturned: () => finalizerReturned.resolve(),
			subprocessResult: subprocessResult.promise,
			signalSubprocessResult: () => subprocessResult.resolve(),
		};

		expect(await commitsAcrossRelease("ReleaseDeferred", patch, patch, probe)).toBe(1);
	});
});
