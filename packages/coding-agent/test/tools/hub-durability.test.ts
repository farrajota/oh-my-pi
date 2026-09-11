import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { beginHubAdmission } from "../../src/internal/hub-admission";
import { DurableHubStore } from "../../src/internal/hub-durable-state";
import { resolveHubSessionAccess } from "../../src/internal/hub-authority";

describe("Hub durable custody", () => {
	const roots: string[] = [];

	function durablePaths(): { root: string; sessionFile: string; journal: string } {
		const root = path.join(os.tmpdir(), `omp-w4-hub-${crypto.randomUUID()}`);
		roots.push(root);
		return { root, sessionFile: path.join(root, "session.jsonl"), journal: path.join(root, "custody.jsonl") };
	}

	function directSession(registry: AgentRegistry, sessionFile: string): ToolSession {
		return {
			cwd: process.cwd(),
			settings: { get: () => undefined },
			agentRegistry: registry,
			asyncJobManager: new AsyncJobManager({}),
			getAgentId: () => "Main",
			getSessionFile: () => sessionFile,
			isDisposed: () => false,
		} as unknown as ToolSession;
	}

	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const root of roots.splice(0)) removeSyncWithRetries(root);
	});
	test("recovers every member of one complete durable batch", () => {
		const { journal } = durablePaths();
		const store = new DurableHubStore(journal);
		store.appendBatch([
			{ kind: "admission", entityId: "Main:batch", incarnationId: "attempt", payload: { state: "committed" } },
			{ kind: "consumption", entityId: "job-1", incarnationId: "job-attempt", payload: { state: "committed" } },
		]);
		const recovered = store.recover();
		expect(recovered.quarantined).toEqual([]);
		expect(recovered.records.map(record => record.kind)).toEqual(["admission", "consumption"]);
	});

	test("quarantines a truncated durable batch as one unit", () => {
		const { journal } = durablePaths();
		const store = new DurableHubStore(journal);
		store.appendBatch([
			{ kind: "admission", entityId: "Main:truncated", incarnationId: "attempt", payload: { state: "committed" } },
			{ kind: "consumption", entityId: "job-2", incarnationId: "job-attempt", payload: { state: "committed" } },
		]);
		const full = fs.readFileSync(journal, "utf8");
		fs.writeFileSync(journal, full.slice(0, Math.max(1, full.length - 7)), "utf8");
		const recovered = store.recover();
		expect(recovered.records).toEqual([]);
		expect(recovered.quarantined).toHaveLength(1);
	});

	test("does not append a partial batch when a later mutation fails validation", () => {
		const { journal } = durablePaths();
		const store = new DurableHubStore(journal);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			store.appendBatch([
				{ kind: "admission", entityId: "Main:prepare", incarnationId: "attempt", payload: { state: "committed" } },
				{ kind: "consumption", entityId: "job-3", incarnationId: "job-attempt", payload: cyclic },
			]),
		).toThrow("cycles");
		expect(store.recover().records).toEqual([]);
	});

	test("recovery forwards a committed consumption after apply was interrupted", () => {
		const { journal } = durablePaths();
		const store = new DurableHubStore(journal);
		const message = { id: "message-1", from: "Peer", to: "Main", body: "consumed", ts: 1 };
		store.appendBatch([
			{ kind: "admission", entityId: "Main:crash", incarnationId: "attempt", payload: { state: "committed" } },
			{ kind: "mailbox", entityId: message.id, incarnationId: message.id, payload: { state: "queued", message } },
			{ kind: "mailbox", entityId: message.id, incarnationId: message.id, payload: { state: "consumed", message } },
		]);
		const recovered = new IrcBus(new AgentRegistry(), undefined, undefined, store).recoverDurableState();
		expect(recovered.restoredMessageIds).toEqual([]);
	});

	test("restores queued mail by exact message identity and preserves consumed omission", async () => {
		const { journal } = durablePaths();
		const store = new DurableHubStore(journal);
		const firstRegistry = new AgentRegistry();
		firstRegistry.register({ id: "Peer", displayName: "peer", kind: "sub", session: null, status: "idle" });
		firstRegistry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: {
				deliverIrcMessage: async () => {
					throw new Error("handoff failed");
				},
			} as never,
		});
		const first = new IrcBus(firstRegistry, undefined, undefined, store);
		await first.send({ from: "Peer", to: "Main", body: "durable message" });

		const recovered = new IrcBus(new AgentRegistry(), undefined, undefined, store);
		const batch = recovered.recoverDurableState();
		expect(batch.restoredMessageIds).toHaveLength(1);
		expect(recovered.inbox("Main").map(message => message.body)).toEqual(["durable message"]);

		const afterConsumption = new IrcBus(new AgentRegistry(), undefined, undefined, store);
		afterConsumption.recoverDurableState();
		expect(afterConsumption.inbox("Main", { peek: true })).toEqual([]);
	});

	test("expired waits settle on recovery while indefinite waits are quarantined without a timer", () => {
		const { journal } = durablePaths();
		const store = new DurableHubStore(journal);
		store.append("wait", "Main:expired", "expired", {
			state: "waiting",
			agentId: "Main",
			mode: "mailbox",
			windowMs: 10,
			deadlineAt: 10,
		});
		store.append("wait", "Main:disabled", "disabled", {
			state: "waiting",
			agentId: "Main",
			mode: "mailbox",
			windowMs: 0,
			deadlineAt: null,
		});
		const bus = new IrcBus(new AgentRegistry(), undefined, undefined, store);
		const result = bus.recoverDurableState(0, 100, 20);
		expect(result.expiredWaiterIds).toEqual(["Main:expired"]);
		expect(result.quarantinedIds).toContain("Main:disabled");
	});

	test("unregistered sessions cannot mint durable Hub admission identity", () => {
		const { sessionFile } = durablePaths();
		const registry = new AgentRegistry();
		const session = directSession(registry, sessionFile);
		const access = resolveHubSessionAccess(session);
		expect(access).toEqual({ kind: "unavailable" });
		expect(() => beginHubAdmission({} as never, session, "hub-call", "jobs")).toThrow(
			"Hub admission requires an exact session authority",
		);
	});
});
