/**
 * Extension job controls (the activity dashboard's surface): owner-scoped job snapshots with a
 * bounded history, job output, job cancel and subagent termination through the agent lifecycle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AsyncJobOutputSnapshot,
	AsyncJobSnapshot,
	AsyncJobSnapshotItem,
	BackgroundControlResult,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager, type AsyncJobManagerApi } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function bareRunner(): ExtensionRunner {
	const runtime = { flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime;
	return new ExtensionRunner([], runtime, "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
}

describe("extension job controls outside a session", () => {
	it("returns no output and reports cancel and terminate targets as not found", async () => {
		const ctx = bareRunner().createContext();

		expect(ctx.getAsyncJobOutput("bg_1")).toBeNull();
		expect(await ctx.cancelAsyncJob("bg_1")).toMatchObject({ id: "bg_1", status: "not_found" });
		expect(await ctx.terminateSubagent("0-Child")).toMatchObject({ id: "0-Child", status: "not_found" });
	});
});

describe("extension job controls in a session", () => {
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession;
	let ctx: ExtensionContext;
	let manager: AsyncJobManagerApi;
	const calls: string[] = [];

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ext-job-controls-shared-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		calls.length = 0;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-ext-job-controls-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		let captured: ExtensionContext | undefined;
		const capture = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, eventCtx) => {
				captured = eventCtx;
			});
		};
		({ session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [capture],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry,
		}));
		ctx = captured ?? session.extensionRunner!.createContext();
		const sessionManager = session.asyncJobManager;
		if (!sessionManager) throw new Error("expected a session job manager");
		manager = sessionManager;
	});

	afterEach(async () => {
		await session.dispose();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		removeSyncWithRetries(tempDir);
	});

	function blockedJob(label: string, options: { ownerId?: string; agentId?: string; queued?: boolean } = {}) {
		const release = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			label,
			async ({ signal, reportProgress }) => {
				const aborted = Promise.withResolvers<string>();
				signal.addEventListener("abort", () => aborted.resolve("aborted"), { once: true });
				await reportProgress(`${label} progress`);
				return Promise.race([release.promise, aborted.promise]);
			},
			{ ownerId: "Main", ...options },
		);
		return { id, release };
	}

	it("lists this session's jobs, filters subagent jobs, and on request lists settled jobs from bounded history", async () => {
		const running = blockedJob("sleep 60");
		const queued = blockedJob("queued", { queued: true });
		const agentJob = blockedJob("child task", { agentId: "0-Child" });
		const foreign = blockedJob("other owner", { ownerId: "0-Other" });
		for (let index = 0; index < 17; index++) {
			manager.register("bash", `done ${index}`, async () => "ok", { ownerId: "Main" });
		}
		await Bun.sleep(5);

		const snapshot: AsyncJobSnapshot | null = ctx.getAsyncJobSnapshot({
			recentLimit: 99,
			includeAgentJobs: false,
			history: true,
		});
		const runningIds = snapshot?.running.map(job => job.id) ?? [];
		expect(runningIds).toContain(running.id);
		expect(runningIds).toContain(queued.id);
		expect(runningIds).not.toContain(agentJob.id);
		expect(runningIds).not.toContain(foreign.id);
		const queuedItem: AsyncJobSnapshotItem | undefined = snapshot?.running.find(job => job.id === queued.id);
		expect(queuedItem?.queued).toBe(true);
		expect(snapshot?.recent).toHaveLength(15);
		expect(ctx.getAsyncJobSnapshot({ recentLimit: 3, history: true })?.recent).toHaveLength(3);
		expect(ctx.getAsyncJobSnapshot({ recentLimit: 99, includeAgentJobs: false })?.recent).toHaveLength(17);
		expect(ctx.getAsyncJobSnapshot()?.recent).toHaveLength(5);
		expect(ctx.getAsyncJobSnapshot()?.running.map(job => job.id)).toContain(agentJob.id);

		for (const job of [running, queued, agentJob, foreign]) job.release.resolve("done");
		await manager.waitForAll();
	});

	it("lists by default exactly the jobs upstream's session snapshot lists", async () => {
		const running = blockedJob("sleep 60");
		for (let index = 0; index < 17; index++) {
			manager.register("bash", `done ${index}`, async () => "ok", { ownerId: "Main" });
		}
		await Bun.sleep(5);

		expect(ctx.getAsyncJobSnapshot({ recentLimit: 20 })).toEqual(session.getAsyncJobSnapshot({ recentLimit: 20 }));
		expect(ctx.getAsyncJobSnapshot()).toEqual(session.getAsyncJobSnapshot());
		expect(ctx.getAsyncJobSnapshot({ recentLimit: 20 })?.recent).toHaveLength(17);

		running.release.resolve("done");
		await manager.waitForAll();
	});

	it("reads a job's live progress, then its result or error, only for this session's jobs", async () => {
		const live = blockedJob("tail -f");
		const foreign = blockedJob("other", { ownerId: "0-Other" });
		await Bun.sleep(1);

		const progress: AsyncJobOutputSnapshot | null = ctx.getAsyncJobOutput(live.id);
		expect(progress).toEqual({
			id: live.id,
			status: "running",
			source: "progress",
			text: "tail -f progress",
			truncated: false,
		});
		expect(ctx.getAsyncJobOutput(foreign.id)).toBeNull();

		live.release.resolve("final output");
		const failing = manager.register(
			"bash",
			"false",
			async () => {
				throw new Error("exit 1");
			},
			{ ownerId: "Main" },
		);
		foreign.release.resolve("done");
		await manager.waitForAll();

		expect(ctx.getAsyncJobOutput(live.id)).toMatchObject({
			status: "completed",
			source: "result",
			text: "final output",
		});
		expect(ctx.getAsyncJobOutput(failing)).toMatchObject({ status: "failed", source: "error", text: "exit 1" });
	});

	it("cancels a running job and waits for it to settle", async () => {
		const job = blockedJob("sleep 60");

		const result: BackgroundControlResult = await ctx.cancelAsyncJob(job.id);

		expect(result).toMatchObject({ id: job.id, status: "cancelled" });
		expect(manager.getJob(job.id)?.status).toBe("cancelled");
		expect(manager.getJob(job.id)?.endTime).toBeNumber();
		expect(await ctx.cancelAsyncJob(job.id)).toMatchObject({ status: "already_completed" });
		expect(await ctx.cancelAsyncJob("bg_missing")).toMatchObject({ status: "not_found" });
	});

	it("does not cancel another owner's job", async () => {
		const foreign = blockedJob("other", { ownerId: "0-Other" });

		expect(await ctx.cancelAsyncJob(foreign.id)).toMatchObject({ status: "not_found" });
		expect(manager.getJob(foreign.id)?.status).toBe("running");

		foreign.release.resolve("done");
		await manager.waitForAll();
	});

	function registerSubagent(id: string, parentId: string, status: "running" | "aborted" = "running") {
		return AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId,
			status,
			sessionFile: path.join(tempDir, `${id}.jsonl`),
			session:
				status === "running"
					? ({
							abort: async () => {
								calls.push(`abort:${id}`);
							},
							dispose: async () => {
								calls.push(`dispose:${id}`);
							},
						} as never)
					: null,
		});
	}

	it("terminates a descendant subagent through the lifecycle and leaves an aborted tombstone", async () => {
		registerSubagent("0-Child", "Main");
		registerSubagent("0-Child.0-Grandchild", "0-Child");

		const result = await ctx.terminateSubagent("0-Child.0-Grandchild");

		expect(result).toMatchObject({ id: "0-Child.0-Grandchild", status: "cancelled" });
		expect(calls).toEqual(["abort:0-Child.0-Grandchild", "dispose:0-Child.0-Grandchild"]);
		const ref = AgentRegistry.global().get("0-Child.0-Grandchild");
		expect(ref?.status).toBe("aborted");
		expect(ref?.session).toBeNull();
		expect(AgentRegistry.global().get("0-Child")?.status).toBe("running");
	});

	it("treats agents outside this session's tree, itself and unknown ids as not found", async () => {
		registerSubagent("0-Stranger", "OtherRoot");

		expect(await ctx.terminateSubagent("0-Stranger")).toMatchObject({ status: "not_found" });
		expect(await ctx.terminateSubagent(ctx.agent.id)).toMatchObject({ status: "not_found" });
		expect(await ctx.terminateSubagent("0-Nobody")).toMatchObject({ status: "not_found" });
		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("0-Stranger")?.status).toBe("running");
	});

	it("reports an already aborted subagent as completed", async () => {
		registerSubagent("0-Done", "Main", "aborted");

		expect(await ctx.terminateSubagent("0-Done")).toMatchObject({ status: "already_completed" });
	});

	it("exposes the session's agent identity as ctx.actor too", () => {
		expect(ctx.actor).toBe(ctx.agent);
		expect(ctx.actor.id).toBe("Main");
	});
});
