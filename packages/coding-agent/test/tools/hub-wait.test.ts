/**
 * Unified `hub` wait: one blocking primitive racing background jobs against
 * incoming peer messages. These contracts are new to the merge — the halves
 * (pure message wait, pure job poll) are covered by the pre-existing
 * messaging/job suites.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails } from "@oh-my-pi/pi-tui/tools/hub";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { lookupAgentRef } from "../../src/internal/agent-registry-bridge";
import { createHubAuthorityFixture, type HubAuthorityFixture } from "./hub-fixtures";
const SELF_ID = "Main";

let authorityFixture: HubAuthorityFixture;
let authorityOwner: AgentSession;

function makeSession(manager: AsyncJobManager | undefined): ToolSession {
	const session = authorityFixture.createToolSession(SELF_ID) as ToolSession & {
		asyncJobManager?: AsyncJobManager;
	};
	session.asyncJobManager = manager;
	session.settings.override("irc.timeoutMs", 120_000);
	session.settings.override("async.pollWaitDuration", "smart");
	return session;
}

/** Register a job that never settles on its own; returns its id + resolver. */
function registerHangingJob(manager: AsyncJobManager, label: string): { id: string; finish: (text: string) => void } {
	const { promise, resolve } = Promise.withResolvers<string>();
	const id = manager.register("bash", label, async () => promise, { ownerId: SELF_ID });
	return { id, finish: resolve };
}

describe("hub unified wait", () => {
	beforeEach(async () => {
		IrcBus.resetGlobalForTests();
		const registry = new AgentRegistry();
		AgentRegistry.installGlobal(registry);
		authorityFixture = await createHubAuthorityFixture(registry, SELF_ID);
		const ref = lookupAgentRef(registry, SELF_ID);
		if (!ref?.session) throw new Error("Expected hub authority fixture root");
		authorityOwner = ref.session;
		authorityOwner.deliverIrcMessage = () => Promise.reject(new Error("session disposed"));
	});
	afterEach(async () => {
		vi.useRealTimers();
		await authorityFixture.dispose();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("back-to-back job waits climb the adaptive window without cancelling unfinished work", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "unfinished job");
		const tool = new HubTool(makeSession(manager));
		const waitFor = async (windowMs: number) => {
			let settled = false;
			const pending = tool.execute("deadline", { op: "wait" }).then(result => {
				settled = true;
				return result;
			});
			vi.advanceTimersByTime(windowMs - 1);
			for (let turn = 0; turn < 10; turn++) await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			return pending;
		};
		try {
			// First wait sits on the ladder floor; an immediate re-wait climbs a rung.
			const first = await waitFor(5_000);
			expect(first.useless).toBe(true);
			expect(first.details).toMatchObject({ op: "wait", jobs: [{ id: job.id, status: "running" }] });
			const second = await waitFor(10_000);
			expect(second.useless).toBe(true);
			expect(manager.getJob(job.id)?.status).toBe("running");
		} finally {
			manager.cancel(job.id);
		}
	});

	test("an incoming message settles the wait while watched jobs keep running", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "sleep forever");
		const tool = new HubTool(makeSession(manager));

		// The bus waiter is parked synchronously before execute()'s first
		// suspension, so the send below cannot race the park.
		const pending = tool.execute("call_1", { op: "wait" });
		await authorityFixture.bus.send({ from: "Peer", to: SELF_ID, body: "shared file is yours" });

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(result.isError).not.toBe(true);
		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("shared file is yours");
		// The job was not consumed by the message win.
		expect(manager.getJob(job.id)?.status).toBe("running");

		manager.cancel(job.id);
	});

	test("a settling job returns the snapshot exactly like the old poll", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "quick job");
		const tool = new HubTool(makeSession(manager));

		const pending = tool.execute("call_2", { op: "wait", ids: [job.id] });
		job.finish("done output");

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(details.op).toBe("wait");
		expect(details.jobs?.map(j => j.status)).toEqual(["completed"]);
		expect(details.jobs?.[0]?.resultText).toBe("done output");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("## Completed (1)");
	});

	test("bare wait with no jobs and no running peers returns immediately", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Sleeper", displayName: "task", kind: "sub", session: null, status: "idle" });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const tool = new HubTool(makeSession(manager));

		// A regression to a blocking message wait fails via the test timeout.
		const result = await tool.execute("call_3", { op: "wait" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No running background jobs to wait for.");
		expect(result.useless).toBe(true);
	});

	test("bare wait ignores a detached ref whose running status is stale", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Zombie",
			displayName: "stale task",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "running",
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		// Opening the message-wait gate would exceed the test deadline.
		const result = await new HubTool(makeSession(manager)).execute("call_4", { op: "wait" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("No running background jobs to wait for.");
		// The stale ref is reported (not silently dropped): it is the only handle
		// the caller has for clearing it with `hub cancel`.
		expect(text).toContain("Zombie");
		expect(text).toContain("no turn in flight");
	});

	test("bare wait returns a message already queued on the bus", async () => {
		const registry = AgentRegistry.global();
		// A recipient whose live hand-off throws is the only way a message
		// reaches the mailbox: `IrcBus.send` buffers solely from that catch.
		(authorityOwner as AgentSession).deliverIrcMessage = () => Promise.reject(new Error("session disposed"));
		// Idle peer: nothing is running, so the liveness gate would otherwise
		// short-circuit the wait before the mailbox is ever consulted.
		registry.register({
			id: "Peer",
			displayName: "task",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "idle",
		});

		const firstReceipt = await authorityFixture.bus.send({ from: "Peer", to: SELF_ID, body: "picked up the lock" });
		const secondReceipt = await authorityFixture.bus.send({ from: "Peer", to: SELF_ID, body: "starting the edit" });
		expect(firstReceipt.outcome).toBe("failed");
		expect(secondReceipt.outcome).toBe("failed");
		expect(authorityFixture.bus.unreadCount(SELF_ID)).toBe(2);

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_5", { op: "wait" });
		const details = result.details as CoordinationDetails;

		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("picked up the lock");
		// Consumed exactly one message, not merely peeked or drained the backlog.
		expect(authorityFixture.bus.unreadCount(SELF_ID)).toBe(1);
		expect(
			authorityFixture.bus
				.inbox(SELF_ID)
				.map(message => message.body),
		).toEqual(["starting the edit"]);
	});
	test("direct sessions cannot wait on peer messages or caller-owned jobs", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({ id: "Peer", displayName: "peer", kind: "sub", session: null, status: "idle" });
		const tool = new HubTool({
			cwd: process.cwd(),
			settings: { get: () => undefined },
			agentRegistry: registry,
			asyncJobManager: new AsyncJobManager({}),
			getAgentId: () => SELF_ID,
			isDisposed: () => false,
		} as unknown as ToolSession);
		const result = await tool.execute("direct-wait", { op: "wait", timeoutMs: 1 });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("unavailable");
	});

});
