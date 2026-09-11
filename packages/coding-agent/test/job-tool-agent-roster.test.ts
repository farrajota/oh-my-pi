/**
 * The `job` tool's snapshot contract: `list` and empty-poll results must never
 * come back as empty text, and they must surface running subagents that have
 * no backing job (irc-woken/revived agents, spawns owned by another agent) so
 * the tool's picture matches the UI's running-agent count. Regression for the
 * QA report "job list returned no status output despite known running
 * background jobs and subagents".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { CreateAgentSessionResult } from "../src/sdk";
import { terminateSubagent } from "../src/registry/agent-control";
import {
	adoptAgent,
	disposeAgentLifecycle,
	getAgentLifecycleManager,
	lifecycleHasAgent,
	releaseAgent,
	registerToolSessionLifecycleAuthority,
} from "../src/internal/agent-lifecycle-bridge";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
	unregisterAgentRef,
	setAgentStatus,
} from "../src/internal/agent-registry-bridge";
import { type CoordinationDetails, HubTool } from "../src/tools/hub";

interface ManagerFixture {
	readonly manager: AsyncJobManager;
	readonly registry: AgentRegistry;
	readonly root: CreateAgentSessionResult;
	readonly dir: string;
}

const managerFixtures: ManagerFixture[] = [];
const lifecycles: AgentLifecycleManager[] = [];

function createLifecycle(registry: AgentRegistry): AgentLifecycleManager {
	const lifecycle = getAgentLifecycleManager(registry);
	lifecycles.push(lifecycle);
	return lifecycle;
}

async function createManager(registry = new AgentRegistry()): Promise<ManagerFixture> {
	const dir = await mkdtemp(join(tmpdir(), "job-tool-agent-roster-"));
	let root: CreateAgentSessionResult | undefined;
	try {
		root = await createAgentRootSession(registry, {
			agentId: "Main",
			agentDisplayName: "main",
			cwd: dir,
			agentDir: dir,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managerFixtures.push({ manager, registry, root, dir });
		return { manager, registry, root, dir };
	} catch (error) {
		await root?.session.dispose();
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

function createToolSession(options: { fixture: ManagerFixture; agentId?: string; authorized?: boolean }): ToolSession {
	const { fixture } = options;
	const toolSession = {
		cwd: fixture.dir,
		hasUI: false,
		settings: Settings.isolated({ "async.pollWaitDuration": "5s" }),
		getSessionFile: () => lookupAgentRef(fixture.registry, "Main")?.sessionFile ?? null,
		getSessionSpawns: () => "*",
		getAgentId: () => options.agentId ?? "Main",
		isDisposed: () => fixture.root.session.isDisposed,
		asyncJobManager: fixture.manager,
		sessionManager: fixture.root.session.sessionManager,
		agentRegistry: fixture.registry,
	} satisfies ToolSession;
	if (options.authorized !== false)
		registerToolSessionLifecycleAuthority(toolSession, fixture.registry, fixture.root.session);
	return toolSession;
}

async function createTrustedHubChild(id: string, status: "idle" | "running") {
	const registry = new AgentRegistry();
	const dir = await mkdtemp(join(tmpdir(), "job-tool-agent-roster-"));
	let root: CreateAgentSessionResult | undefined;
	let child: CreateAgentSessionResult | undefined;
	try {
		root = await createAgentRootSession(registry, {
			agentId: "Main",
			agentDisplayName: "main",
			cwd: dir,
			agentDir: dir,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
		});
		const authority = bindInternalAgentAuthoritySession(registry, root.session);
		if (!authority) throw new Error("Expected root authority");
		child = await authority.create({
			agentId: id,
			agentDisplayName: id,
			cwd: dir,
			agentDir: dir,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
		});
		if (status === "idle" && !setAgentStatus(registry, id, "idle", child.session)) {
			throw new Error(`Failed to idle ${id}`);
		}
		const exact = lookupAgentRef(registry, id);
		if (!exact) throw new Error(`Expected registered child ${id}`);
		const lifecycle = getAgentLifecycleManager(registry);
		adoptAgent(lifecycle, id, { idleTtlMs: 60_000 }, exact);
		const hub = root.session.getToolByName("hub");
		if (!hub) throw new Error("Expected root Hub tool");
		const manager = root.session.asyncJobManager;
		if (!manager) throw new Error("Expected root job manager");
		const ownedRoot = root;
		const ownedChild = child;
		return {
			registry,
			lifecycle,
			child: ownedChild,
			hub,
			manager,
			async dispose() {
				await ownedChild.session.dispose();
				await ownedRoot.session.dispose();
				await rm(dir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await child?.session.dispose();
		await root?.session.dispose();
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

function registerRunningSub(registry: AgentRegistry, id: string, parentId = "Main"): void {
	registry.register({ id, displayName: id, kind: "sub", parentId, session: null });
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

const runsUntilAborted = ({ signal }: { signal: AbortSignal }) =>
	new Promise<string>(resolve => {
		if (signal.aborted) {
			resolve("");
			return;
		}
		signal.addEventListener("abort", () => resolve(""), { once: true });
	});

afterEach(async () => {
	for (const fixture of managerFixtures.splice(0).reverse()) {
		await fixture.manager.dispose({ timeoutMs: 200 });
		await fixture.root.session.dispose();
		await rm(fixture.dir, { recursive: true, force: true });
	}
	for (const lifecycle of lifecycles.splice(0)) {
		await disposeAgentLifecycle(lifecycle);
	}
});

describe("hub jobs snapshot", () => {
	test("empty jobs snapshot reports 'no jobs' instead of empty output", async () => {
		const fixture = await createManager();
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "jobs" });

		expect(resultText(result)).toBe("No background jobs.");
		expect((result.details as CoordinationDetails)?.jobs).toEqual([]);
	});

	test("omits result bodies already auto-delivered to the owning agent", async () => {
		const fixture = await createManager();
		const { manager } = fixture;
		const deliveries: string[] = [];
		manager.registerDeliverySink("Main", (_jobId, text) => {
			deliveries.push(text);
		});
		const jobId = manager.register("eval", "completed cell", async () => "already delivered eval body", {
			ownerId: "Main",
		});
		await manager.getJob(jobId)!.promise;
		await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "Main" } });

		const tool = new HubTool(createToolSession({ fixture }));
		const result = await tool.execute("call", { op: "jobs" });

		expect(deliveries).toEqual(["already delivered eval body"]);
		expect(resultText(result)).not.toContain("already delivered eval body");
		expect(resultText(result)).toContain("Delivery: already delivered or recovered.");
		expect((result.details as CoordinationDetails)?.jobs?.[0]?.resultText).toBeUndefined();
	});

	test("withholds a result while auto-delivery awaits consumer injection", async () => {
		const fixture = await createManager();
		const { manager } = fixture;
		const deliveryStarted = Promise.withResolvers<void>();
		const allowInjection = Promise.withResolvers<void>();
		const injected: string[] = [];
		manager.registerDeliverySink("Main", async (jobId, text) => {
			deliveryStarted.resolve();
			await allowInjection.promise;
			if (!manager.isDeliverySuppressed(jobId)) injected.push(text);
		});
		const jobId = manager.register("task", "queued child", async () => "queued child report", {
			ownerId: "Main",
		});
		await manager.getJob(jobId)!.promise;
		await deliveryStarted.promise;

		const tool = new HubTool(createToolSession({ fixture }));
		const recovered = await tool.execute("recover", { op: "jobs" });
		allowInjection.resolve();
		await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "Main" } });

		expect(resultText(recovered)).not.toContain("queued child report");
		expect(resultText(recovered)).toContain("Delivery: already delivered or recovered.");
		expect(injected).toEqual(["queued child report"]);
	});

	test("returns an undelivered result body once for manual recovery", async () => {
		const fixture = await createManager();
		const { manager } = fixture;
		const jobId = manager.register("task", "orphaned child", async () => "recover this child report", {
			ownerId: "Main",
		});
		await manager.getJob(jobId)!.promise;
		await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "Main" } });

		const tool = new HubTool(createToolSession({ fixture }));
		const recovered = await tool.execute("first", { op: "jobs" });
		const consumed = await tool.execute("second", { op: "jobs" });

		expect(resultText(recovered)).toContain("recover this child report");
		expect(resultText(recovered)).toContain("Delivery: not auto-delivered; recovered by this snapshot.");
		expect(resultText(consumed)).not.toContain("recover this child report");
		expect(resultText(consumed)).toContain("Delivery: already delivered or recovered.");
		expect((consumed.details as CoordinationDetails)?.jobs?.[0]?.resultText).toBeUndefined();
	});

	test("list surfaces running subagents that have no backing job", async () => {
		const fixture = await createManager();
		const { registry } = fixture;
		registerRunningSub(registry, "Worker");
		registerRunningSub(registry, "Idler");
		registry.setStatus("Idler", "idle");
		registry.register({ id: "advisor", displayName: "advisor", kind: "advisor", session: null });
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "jobs" });

		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["Worker"]);
		const text = resultText(result);
		expect(text).toContain("Running Agents (1)");
		expect(text).toContain("Worker");
		expect(result.useless).toBeUndefined();
	});

	test("agents covered by the caller's running jobs are not double-listed", async () => {
		const fixture = await createManager();
		const { manager, registry } = fixture;
		// Task-style spawn: job id == agent id.
		manager.register("task", "AgentA", runsUntilAborted, {
			id: "AgentA",
			agentId: "AgentA",
			ownerId: "Main",
		});
		registerRunningSub(registry, "AgentA");
		// Vibe-style turn job: job id differs from the agent id; linkage via agentId.
		manager.register("task", "vibe turn", runsUntilAborted, {
			id: "vibe-1-t1",
			agentId: "vibe-1",
			ownerId: "Main",
		});
		registerRunningSub(registry, "vibe-1");
		// Woken via irc: running agent with no job at all.
		registerRunningSub(registry, "Loner");
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "jobs" });

		expect((result.details as CoordinationDetails)?.jobs?.map(job => job.id).sort()).toEqual(["AgentA", "vibe-1-t1"]);
		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["Loner"]);
		manager.cancel("AgentA");
		manager.cancel("vibe-1-t1");
	});

	test("a settled job in retention does not hide its re-woken agent", async () => {
		const fixture = await createManager();
		const { manager, registry } = fixture;
		manager.register("task", "AgentB", async () => "done", { id: "AgentB", agentId: "AgentB", ownerId: "Main" });
		await manager.waitForAll();
		// The agent was re-woken (e.g. via irc) after its job completed.
		registerRunningSub(registry, "AgentB");
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "jobs" });

		expect((result.details as CoordinationDetails)?.jobs?.find(job => job.id === "AgentB")?.status).toBe("completed");
		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["AgentB"]);
	});
});

describe("hub wait with no matching jobs", () => {
	test("bare wait with nothing running stays a useless no-op message", async () => {
		const fixture = await createManager();
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "wait" });

		expect(resultText(result)).toBe("No running background jobs to wait for.");
		expect(result.useless).toBe(true);
	});

	test("bare wait reports running agents outside job control", async () => {
		const fixture = await createManager();
		const { registry } = fixture;
		registerRunningSub(registry, "Worker");
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "wait" });

		const text = resultText(result);
		expect(text).toContain("No running background jobs to wait for.");
		expect(text).toContain("Worker");
		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["Worker"]);
		expect(result.useless).toBeUndefined();
	});

	test("waiting on an agent id that has no job explains the agent's state", async () => {
		const fixture = await createManager();
		const { registry } = fixture;
		registerRunningSub(registry, "Worker");
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "wait", ids: ["Worker"] });

		const text = resultText(result);
		expect(text).toContain("No matching jobs found for IDs: Worker");
		expect(text).toContain("running agent with no job entry");
		expect(text).toContain("history://Worker");
	});
});

describe("hub cancel of a non-job-backed agent registration (#6315)", () => {
	function fakeSession(onAbort?: () => void) {
		let aborts = 0;
		let disposes = 0;
		const session = {
			abort: async () => {
				aborts += 1;
				onAbort?.();
			},
			dispose: async () => {
				disposes += 1;
			},
		};
		return { session, abortCalls: () => aborts, disposeCalls: () => disposes };
	}

	test("cancel kills an owned idle agent that has no backing job", async () => {
		const fixture = await createTrustedHubChild("Zombie", "idle");
		const disposeSpy = spyOn(fixture.child.session, "dispose");
		try {
			const result = await fixture.hub.execute("call", { op: "cancel", ids: ["Zombie"] });

			expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Zombie", status: "cancelled" }]);
			expect(resultText(result)).toContain("Cancelled agent Zombie");
			const killed = fixture.registry.get("Zombie");
			expect(killed?.status).toBe("aborted");
			expect(lookupAgentRef(fixture.registry, "Zombie")?.session).toBeNull();
			expect(lifecycleHasAgent(fixture.lifecycle, "Zombie")).toBe(false);
			expect(disposeSpy).toHaveBeenCalledTimes(1);
		} finally {
			disposeSpy.mockRestore();
			await fixture.dispose();
		}
	}, 15_000);

	test("cancel aborts the in-flight turn of a running agent before releasing it", async () => {
		const fixture = await createTrustedHubChild("Runner", "running");
		const abortSpy = spyOn(fixture.child.session, "abort");
		const disposeSpy = spyOn(fixture.child.session, "dispose");
		try {
			const result = await fixture.hub.execute("call", { op: "cancel", ids: ["Runner"] });

			expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Runner", status: "cancelled" }]);
			expect(abortSpy).toHaveBeenCalledTimes(1);
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			expect(fixture.registry.get("Runner")?.status).toBe("aborted");
		} finally {
			abortSpy.mockRestore();
			disposeSpy.mockRestore();
			await fixture.dispose();
		}
	});

	test("cancel refuses an agent spawned by someone else", async () => {
		const fixture = await createManager();
		const { registry } = fixture;
		const fake = fakeSession();
		registry.register({
			id: "OtherKid",
			displayName: "OtherKid",
			kind: "sub",
			parentId: "SomeoneElse",
			session: fake.session as never,
			status: "idle",
		});
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "cancel", ids: ["OtherKid"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "OtherKid", status: "not_found" }]);
		expect(registry.get("OtherKid")).toBeDefined();
		expect(fake.disposeCalls()).toBe(0);
	});

	test("synthetic ToolSession cannot cancel a public legacy registration", async () => {
		const fixture = await createManager();
		const { registry } = fixture;
		const fake = fakeSession();
		registry.register({
			id: "LegacyKid",
			displayName: "LegacyKid",
			kind: "sub",
			parentId: "Main",
			session: fake.session as never,
			status: "idle",
		});
		const tool = new HubTool(createToolSession({ fixture, authorized: false }));

		const result = await tool.execute("call", { op: "cancel", ids: ["LegacyKid"] });

		expect(result.isError).toBe(true);
		expect(resultText(result)).toBe("Hub coordination authority is unavailable for this session.");
		expect(registry.get("LegacyKid")?.status).toBe("idle");
		expect(fake.abortCalls()).toBe(0);
		expect(fake.disposeCalls()).toBe(0);
	});

	test("cancel of a truly unknown id still reports not_found", async () => {
		const fixture = await createManager();
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "cancel", ids: ["Ghost"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Ghost", status: "not_found" }]);
		expect(resultText(result)).toContain("Background job not found: Ghost");
	});
	test("cancel kills the registration even while the settled job row is still retained", async () => {
		const fixture = await createTrustedHubChild("Zombie", "idle");
		const disposeSpy = spyOn(fixture.child.session, "dispose");
		try {
			fixture.manager.register("task", "Zombie", async () => "done", {
				id: "Zombie",
				agentId: "Zombie",
				ownerId: "Main",
			});
			await fixture.manager.waitForAll();

			const result = await fixture.hub.execute("call", { op: "cancel", ids: ["Zombie"] });

			expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Zombie", status: "cancelled" }]);
			expect(fixture.registry.get("Zombie")?.status).toBe("aborted");
			expect(lifecycleHasAgent(fixture.lifecycle, "Zombie")).toBe(false);
			expect(disposeSpy).toHaveBeenCalledTimes(1);
		} finally {
			disposeSpy.mockRestore();
			await fixture.dispose();
		}
	});

	test("cancel of a settled job with no lingering registration stays already_completed", async () => {
		const fixture = await createManager();
		const { manager } = fixture;
		manager.register("task", "DoneJob", async () => "done", { id: "DoneJob", agentId: "DoneJob", ownerId: "Main" });
		await manager.waitForAll();
		const tool = new HubTool(createToolSession({ fixture }));

		const result = await tool.execute("call", { op: "cancel", ids: ["DoneJob"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([
			{ id: "DoneJob", status: "already_completed" },
		]);
		expect(resultText(result)).toContain("already completed");
	});

	test("descendant scope terminates nested children while direct-child scope fails closed", async () => {
		const registry = new AgentRegistry();
		const lifecycle = createLifecycle(registry);
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const grandchild = fakeSession();
		registry.register({
			id: "Grandchild",
			displayName: "Grandchild",
			kind: "sub",
			parentId: "Child",
			session: grandchild.session as never,
			status: "idle",
		});
		const exact = lookupAgentRef(registry, "Grandchild")!;
		adoptAgent(lifecycle, "Grandchild", { idleTtlMs: 0 }, exact);

		await expect(
			terminateSubagent({
				registry,
				lifecycle,
				targetId: "Grandchild",
				expectedRef: exact,
				policy: { scope: "direct-child", ownerId: "Main" },
			}),
		).resolves.toMatchObject({ status: "not_found" });
		await expect(
			terminateSubagent({
				registry,
				lifecycle,
				targetId: "Grandchild",
				expectedRef: exact,
				policy: { scope: "descendant", ownerId: "Main" },
			}),
		).resolves.toMatchObject({ status: "cancelled" });
		expect(registry.get("Grandchild")?.status).toBe("aborted");
		expect(grandchild.disposeCalls()).toBe(1);
	});

	test("a stale termination cannot kill a replacement generation", async () => {
		const registry = new AgentRegistry();
		const lifecycle = createLifecycle(registry);
		let replacement: AgentRef | undefined;
		const stale = fakeSession(() => {
			replacement = registry.register({
				id: "Runner",
				displayName: "Replacement",
				kind: "sub",
				parentId: "Main",
				session: null,
				status: "idle",
			});
		});
		registry.register({
			id: "Runner",
			displayName: "Runner",
			kind: "sub",
			parentId: "Main",
			session: stale.session as never,
			status: "running",
		});
		const exact = lookupAgentRef(registry, "Runner")!;
		adoptAgent(lifecycle, "Runner", { idleTtlMs: 0 }, exact);

		await expect(
			terminateSubagent({
				registry,
				lifecycle,
				targetId: "Runner",
				expectedRef: exact,
				policy: { scope: "direct-child", ownerId: "Main" },
			}),
		).resolves.toMatchObject({ status: "already_completed" });
		if (!replacement) throw new Error("Expected replacement generation");
		expect(registry.get("Runner")).toMatchObject({
			id: replacement.id,
			lineage: replacement.lineage,
			status: "idle",
		});
		expect(lookupAgentRef(registry, "Runner")?.session).toBeNull();
		expect(replacement.status).toBe("idle");
	});

	test("rejects a replacement that appeared after caller authorization", async () => {
		const registry = new AgentRegistry();
		const lifecycle = createLifecycle(registry);
		registry.register({
			id: "Runner",
			displayName: "Authorized",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const authorized = lookupAgentRef(registry, "Runner")!;
		if (!unregisterAgentRef(registry, "Runner", authorized))
			throw new Error("Failed to retire authorized generation");
		const replacement = registry.register({
			id: "Runner",
			displayName: "Replacement",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});

		await expect(
			terminateSubagent({
				registry,
				lifecycle,
				targetId: "Runner",
				expectedRef: authorized,
				policy: { scope: "direct-child", ownerId: "Main" },
			}),
		).resolves.toMatchObject({ status: "not_found" });
		expect(registry.get("Runner")).toMatchObject({
			id: replacement.id,
			lineage: replacement.lineage,
			status: "idle",
		});
		expect(lookupAgentRef(registry, "Runner")?.session).toBeNull();
		expect(replacement.status).toBe("idle");
	});
	test("blocks same-id replacement until manager-owned termination finishes", async () => {
		const registry = new AgentRegistry();
		const lifecycle = createLifecycle(registry);
		const disposeStarted = Promise.withResolvers<void>();
		const finishDispose = Promise.withResolvers<void>();
		const fake = fakeSession();
		fake.session.dispose = async () => {
			disposeStarted.resolve();
			await finishDispose.promise;
		};
		registry.register({
			id: "Runner",
			displayName: "Runner",
			kind: "sub",
			parentId: "Main",
			session: fake.session as never,
			status: "idle",
		});
		const current = lookupAgentRef(registry, "Runner")!;
		adoptAgent(lifecycle, "Runner", { idleTtlMs: 0 }, current);
		const termination = terminateSubagent({
			registry,
			lifecycle,
			targetId: "Runner",
			expectedRef: current,
			policy: { scope: "direct-child", ownerId: "Main" },
		});
		try {
			await disposeStarted.promise;
			expect(() =>
				registry.register({
					id: "Runner",
					displayName: "Replacement",
					kind: "sub",
					parentId: "Main",
					session: null,
				}),
			).toThrow('Agent "Runner" is being terminated.');
			expect(registry.get("Runner")).toMatchObject({ id: current.id, lineage: current.lineage, status: "aborted" });
			expect(lookupAgentRef(registry, "Runner")?.session).toBeNull();
			expect(current.status).toBe("aborted");
			finishDispose.resolve();
			await termination;
			// Releasing the completed tombstone removes it through the same lifecycle owner.
			expect(await releaseAgent(lifecycle, "Runner", current)).toBe(true);
			expect(
				registry.register({
					id: "Runner",
					displayName: "Replacement",
					kind: "sub",
					parentId: "Main",
					session: null,
				}),
			).not.toBe(current);
		} finally {
			finishDispose.resolve();
			await termination;
			await disposeAgentLifecycle(lifecycle);
		}
	});
});
