import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { lookupAgentRef, setAgentStatus } from "../../src/internal/agent-registry-bridge";
import { createHubAuthorityFixture, type HubAuthorityFixture } from "./hub-fixtures";

let authorityFixture: HubAuthorityFixture;

function session(manager?: AsyncJobManager, agentId = "Main", launch = false): ToolSession {
	// Only the fixture root carries Hub authority. Other ids are bare peers whose
	// message-only waits never reach the Hub-backed job result path.
	if (agentId !== "Main") {
		return {
			cwd: process.cwd(),
			settings: Settings.isolated({ "launch.enabled": launch }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => agentId,
		} as unknown as ToolSession;
	}
	const toolSession = authorityFixture.createToolSession(agentId) as ToolSession & {
		asyncJobManager?: AsyncJobManager;
	};
	toolSession.settings = Settings.isolated({ "launch.enabled": launch });
	toolSession.asyncJobManager = manager;
	return toolSession;
}

describe("wait", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		const registry = new AgentRegistry();
		AgentRegistry.installGlobal(registry);
		authorityFixture = await createHubAuthorityFixture(registry, "Main");
	});
	afterEach(async () => {
		vi.useRealTimers();
		await authorityFixture.dispose();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a settling job is recovered once, suppressing its async duplicate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
	});

	test("does not expose local job details when Hub authority is unavailable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "private command label", async () => promise, { ownerId: "Main" });
		const boundSession = session(manager);
		const unboundSession = Object.assign(
			Object.create(Object.getPrototypeOf(boundSession)),
			boundSession,
		) as ToolSession;
		const waiting = new WaitTool(unboundSession).execute("unbound-wait", {});
		resolve("private command output");
		const result = await waiting;
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: "Hub coordination authority is unavailable for this session." },
		]);
		expect(result.details?.jobs).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain(id);
		expect(JSON.stringify(result)).not.toContain("private command label");
		expect(JSON.stringify(result)).not.toContain("private command output");
	});

	test("errors for a subagent whose only running work is its parent's job on it", async () => {
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		const parent = lookupAgentRef(registry, "Main")?.session;
		if (!parent) throw new Error("Expected wait authority fixture root");
		Object.defineProperty(parent, "isStreaming", { value: true, configurable: true });
		expect(setAgentStatus(registry, "Main", "running", parent)).toBe(true);
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		// Subagents share the process job manager with their owner.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		try {
			const waiting = new WaitTool(session(manager, "Child")).execute("child-wait", {});
			await expect(waiting).rejects.toThrow("Nothing to wait for");
		} finally {
			Reflect.deleteProperty(parent, "isStreaming");
			childRun.resolve("done");
			await manager.waitForAll();
		}
	});

	test("an interrupted wait leaves later job completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("Operation aborted");
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("a message interrupt returns a non-error result and leaves the completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted-by-message", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Wait interrupted by message." }]);
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("returns a settled job whose delivery has not reached the transcript yet", async () => {
		const manager = new AsyncJobManager({});
		// The owner's sink parks the result like a yield-queue receipt awaiting injection.
		const injected = Promise.withResolvers<void>();
		const sinkEntered = Promise.withResolvers<string>();
		manager.registerDeliverySink("Main", async (_id, text) => {
			sinkEntered.resolve(text);
			await injected.promise;
		});
		const id = manager.register("task", "EchoPeer", async () => "received=kestrel42", {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		expect(await sinkEntered.promise).toBe("received=kestrel42");

		const result = await new WaitTool(session(manager)).execute("wait-undelivered", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "received=kestrel42" });
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		injected.resolve();
	});

	test("allows a child to wait for its own job while its parent task is still running", async () => {
		await authorityFixture.createChild("Child");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const parentRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => parentRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		const childRun = Promise.withResolvers<string>();
		const childJobId = manager.register("bash", "child-owned", async () => childRun.promise, {
			ownerId: "Child",
		});
		const childSession = authorityFixture.createToolSession("Child") as ToolSession & {
			asyncJobManager?: AsyncJobManager;
		};
		childSession.asyncJobManager = manager;
		const waiting = new WaitTool(childSession).execute("child-own-job", {});
		childRun.resolve("child work complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({
			id: childJobId,
			status: "completed",
			resultText: "child work complete",
		});
		expect(manager.isJobResultConsumed(childJobId)).toBe(true);
		parentRun.resolve("parent task complete");
		await manager.waitForAll();
	});

	test("recovers one settled job while another remains running and consumes the parked delivery once", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const deliveryRelease = Promise.withResolvers<void>();
		const deliveryStarted = Promise.withResolvers<string>();
		const deliveries: string[] = [];
		manager.registerDeliverySink("Main", async (_id, text) => {
			deliveries.push(text);
			deliveryStarted.resolve(text);
			await deliveryRelease.promise;
		});
		const recoverable = Promise.withResolvers<string>();
		const stillRunning = Promise.withResolvers<string>();
		const recoveredId = manager.register("bash", "recoverable", async () => recoverable.promise, {
			ownerId: "Main",
		});
		const runningId = manager.register("bash", "still running", async () => stillRunning.promise, {
			ownerId: "Main",
		});
		recoverable.resolve("recovered exactly once");
		expect(await deliveryStarted.promise).toBe("recovered exactly once");
		const waiting = new WaitTool(session(manager)).execute("mixed-wait", {});
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
		vi.advanceTimersByTime(1);
		const result = await waiting;
		expect(result.details?.jobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: recoveredId,
					status: "completed",
					resultText: "recovered exactly once",
				}),
				expect.objectContaining({ id: runningId, status: "running" }),
			]),
		);
		expect(manager.isJobResultConsumed(recoveredId)).toBe(true);
		expect(manager.isDeliverySuppressed(recoveredId)).toBe(true);
		deliveryRelease.resolve();
		stillRunning.resolve("finished after wait");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(deliveries.filter(text => text === "recovered exactly once")).toEqual(["recovered exactly once"]);
	});

	test("consumes a foreground completion without auto-delivery while another initially running job stays live", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const deliveries: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			deliveries.push(text);
		});
		const completed = Promise.withResolvers<string>();
		const stillRunning = Promise.withResolvers<string>();
		const completedId = manager.register("bash", "foreground completion", async () => completed.promise, {
			ownerId: "Main",
		});
		const runningId = manager.register("bash", "still running", async () => stillRunning.promise, {
			ownerId: "Main",
		});
		const waiting = new WaitTool(session(manager)).execute("mixed-foreground-wait", {});
		completed.resolve("consumed in foreground");
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
		vi.advanceTimersByTime(1);
		const result = await waiting;
		expect(result.details?.jobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: completedId,
					status: "completed",
					resultText: "consumed in foreground",
				}),
				expect.objectContaining({ id: runningId, status: "running" }),
			]),
		);
		expect(manager.isJobResultConsumed(completedId)).toBe(true);
		expect(manager.isDeliverySuppressed(completedId)).toBe(true);
		expect(manager.getJob(runningId)?.status).toBe("running");
		expect(deliveries).toEqual([]);
		stillRunning.resolve("delivered after foreground wait");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(deliveries).toEqual(["delivered after foreground wait"]);
	});

	test("rechecks late child-owned work when the last independent sibling stops while its blocked parent streams", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const parent = await authorityFixture.createChild("Parent");
		await authorityFixture.createChild("Child", "Parent");
		Object.defineProperty(parent.session, "isStreaming", { value: true, configurable: true });
		expect(setAgentStatus(registry, "Parent", "running", parent.session)).toBe(true);
		registry.register({
			id: "Sibling",
			displayName: "Sibling",
			kind: "sub",
			parentId: "Parent",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const parentRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => parentRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Parent",
		});
		const childSession = authorityFixture.createToolSession("Child") as ToolSession & {
			asyncJobManager?: AsyncJobManager;
		};
		childSession.settings = Settings.isolated({ "launch.enabled": false });
		childSession.asyncJobManager = manager;
		const finalized = Promise.withResolvers<string>();
		const controller = new AbortController();
		const messageWaitInstalled = Promise.withResolvers<void>();
		const jobWaitInstalled = Promise.withResolvers<string[]>();
		const bus = IrcBus.global();
		const wait = bus.wait.bind(bus);
		const waitSpy = vi.spyOn(bus, "wait").mockImplementation((...args) => {
			const pending = wait(...args);
			if (args[0] === "Child" && args[4]?.liveness) messageWaitInstalled.resolve();
			return pending;
		});
		const waiting = new WaitTool(childSession).execute("child-late-job", {}, controller.signal, update => {
			jobWaitInstalled.resolve(update.details?.jobs?.map(job => job.id) ?? []);
		});
		const settledWait = Promise.allSettled([waiting]);
		try {
			expect(waitSpy).toHaveBeenCalledTimes(1);
			expect(waitSpy.mock.calls[0]?.[4]?.liveness?.senderId).toBe("Child");
			await messageWaitInstalled.promise;
			expect(manager.getRunningJobs({ ownerId: "Child" })).toEqual([]);
			vi.advanceTimersByTime(1_000);
			const id = manager.register("bash", "late child work", async () => finalized.promise, { ownerId: "Child" });
			expect(registry.setStatus("Sibling", "idle")).toBe(true);
			expect(await Promise.race([jobWaitInstalled.promise, waiting])).toEqual([id]);
			vi.advanceTimersByTime(300_000);
			finalized.resolve("child followup complete");
			const result = await waiting;
			expect(result.details?.jobs).toEqual([
				expect.objectContaining({ id, status: "completed", resultText: "child followup complete" }),
			]);
			expect(manager.isJobResultConsumed(id)).toBe(true);
			expect(manager.isDeliverySuppressed(id)).toBe(true);
			expect(manager.getJob("Child")?.status).toBe("running");
			expect(registry.isRunning(registry.get("Parent")!)).toBe(true);
			expect(registry.get("Sibling")?.status).toBe("idle");
		} finally {
			controller.abort();
			finalized.resolve("child followup complete");
			parentRun.resolve("parent task complete");
			await settledWait;
			await manager.waitForAll();
			waitSpy.mockRestore();
			Reflect.deleteProperty(parent.session, "isStreaming");
		}
	});

	test("rejects a child wait when its last independent sibling idles and only its streaming blocked parent remains", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const parent = await authorityFixture.createChild("Parent");
		await authorityFixture.createChild("Child", "Parent");
		Object.defineProperty(parent.session, "isStreaming", { value: true, configurable: true });
		expect(setAgentStatus(registry, "Parent", "running", parent.session)).toBe(true);
		registry.register({
			id: "Sibling",
			displayName: "Sibling",
			kind: "sub",
			parentId: "Parent",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const parentRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => parentRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Parent",
		});
		try {
			const waiting = new WaitTool(session(manager, "Child")).execute("child-peer-idle", {});
			const stopped = waiting.then(
				result => ({ result, error: undefined }),
				error => ({ result: undefined, error }),
			);
			expect(registry.setStatus("Sibling", "idle")).toBe(true);
			for (let turn = 0; turn < 10; turn++) await Promise.resolve();
			vi.advanceTimersByTime(5_000);
			const outcome = await stopped;
			expect(outcome.result).toBeUndefined();
			expect(outcome.error).toBeInstanceOf(Error);
			expect(outcome.error.message).toContain("Nothing to wait for");
			expect(manager.getJob("Child")?.status).toBe("running");
			expect(registry.isRunning(registry.get("Parent")!)).toBe(true);
			expect(registry.get("Sibling")?.status).toBe("idle");
		} finally {
			Reflect.deleteProperty(parent.session, "isStreaming");
			parentRun.resolve("parent task complete");
			await manager.waitForAll();
		}
	});

	test("blocks on a peer's completion job registered after the wait started", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("wait-peer-yield", {});
		// The peer's yield is accepted mid-turn: its completion job exists before the ref goes idle.
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		finalized.resolve("followup-done");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "followup-done" });
	});

	test("a message-only wait hands the turn back on a growing window while its parent streams", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		// The fixture root "Main" is authority-owned and idle; a separate streaming root plays the parent.
		registry.register({ id: "Lead", displayName: "Lead", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Lead",
			session: streaming,
			status: "running",
		});
		registry.register({
			id: "Sibling",
			displayName: "Sibling",
			kind: "sub",
			parentId: "Lead",
			session: null,
			status: "idle",
		});
		const tool = new WaitTool(session(undefined, "Child"));
		const waitOut = async (ms: number) => {
			const waiting = tool.execute("message-window", {});
			vi.advanceTimersByTime(ms);
			const result = await waiting;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toStartWith(`No message within ${ms / 1000}.0s`);
			// Nobody is blocked on this agent's result, so no owner is singled out.
			expect(text).not.toContain("agent://Lead");
			expect(result.useless).toBe(true);
		};
		await waitOut(5_000);
		await waitOut(10_000);
		await waitOut(30_000);
		// Stepping away from the wait loop restarts the ladder at its floor.
		vi.advanceTimersByTime(60_000);
		await waitOut(5_000);
	});

	test("an owned job that appears mid-wait is not cut off by the message window", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("message-then-job", {});
		vi.advanceTimersByTime(1_000);
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
		// Past the top message rung: only the job-wait cap may end this wait.
		vi.advanceTimersByTime(300_000);
		finalized.resolve("late result");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "late result" });
	});

	test("points a message-only wait at an owner blocked in wait on its result, not at a delivery watch", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		// The fixture root "Main" is authority-owned and not streaming, so a running
		// sibling keeps the child's message-only wait open.
		registry.register({
			id: "Sibling",
			displayName: "Sibling",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		// Subagents share the process job manager with their owner.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		const childWaitText = async () => {
			const waiting = new WaitTool(session(manager, "Child")).execute("child-wait", {});
			vi.advanceTimersByTime(5_000);
			const result = await waiting;
			return result.content[0]?.type === "text" ? result.content[0].text : "";
		};
		// A workpool watches each member turn to suppress auto-delivery while its owner keeps working.
		manager.watchJobs(["Child"]);
		expect(await childWaitText()).not.toContain("agent://Main");
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const text = await childWaitText();
		expect(text).toStartWith("No message within 5.0s");
		expect(text).toContain("agent://Main");
		childRun.resolve("migration API ready");
		expect((await parentWait).details?.jobs?.[0]).toMatchObject({ id: "Child", status: "completed" });
	});

	test("returns an incoming peer message without any background jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const waiting = new WaitTool(session()).execute("message-only", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "shared file released" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "shared file released" });
	});
	test("returns an incoming peer message while the watched job remains live", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise } = Promise.withResolvers<string>();
		const id = manager.register("bash", "unfinished", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-3", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "the file is yours" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the file is yours" });
		expect(manager.getJob(id)?.status).toBe("running");
		manager.cancel(id);
	});

	test("a hung daemon broker does not fail the wait; the job result still arrives", async () => {
		const hungBroker = {
			request: async () => {
				throw new Error("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(hungBroker);
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager, "Main", true)).execute("wait-hung-broker", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
	});
});
