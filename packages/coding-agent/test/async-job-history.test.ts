/**
 * The job manager keeps a bounded, metadata-only history of settled background jobs per owner,
 * so a job list (the extension job snapshot) still shows a job after its row is evicted.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager, type AsyncJobRegisterOptions } from "@oh-my-pi/pi-coding-agent/async/job-manager";

const managers: AsyncJobManager[] = [];

function createManager(options: { retentionMs?: number } = {}): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: async () => {}, ...options });
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose();
});

function registerDone(manager: AsyncJobManager, label: string, options: AsyncJobRegisterOptions): string {
	return manager.register("bash", label, async () => `${label} done`, options);
}

describe("AsyncJobManager terminal history", () => {
	it("keeps a settled job's metadata after its row is evicted", async () => {
		const manager = createManager({ retentionMs: 0 });
		const id = registerDone(manager, "echo hi", { ownerId: "Main" });
		await manager.waitForAll();
		await Bun.sleep(5);

		expect(manager.getJob(id)).toBeUndefined();
		const history = manager.getTerminalHistory({ ownerId: "Main" });
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ id, type: "bash", status: "completed", label: "echo hi", ownerId: "Main" });
		expect(history[0]?.endTime).toBeNumber();
		expect(history[0]).not.toHaveProperty("resultText");
	});

	it("keeps the 15 newest jobs per owner, counting subagent jobs apart from the others", async () => {
		const manager = createManager();
		const ids: string[] = [];
		for (let index = 0; index < 17; index++) {
			ids.push(registerDone(manager, `job ${index}`, { ownerId: "Main" }));
			await manager.waitForAll();
		}
		const agentJob = manager.register("task", "child", async () => "ok", { ownerId: "Main", agentId: "0-Child" });
		await manager.waitForAll();

		const all = manager.getTerminalHistory({ ownerId: "Main" });
		expect(all.map(entry => entry.id)).toEqual([agentJob, ...ids.slice(2).reverse()]);
		const withoutAgents = manager.getTerminalHistory({ ownerId: "Main" }, { includeAgentJobs: false });
		expect(withoutAgents.map(entry => entry.id)).toEqual(ids.slice(2).reverse());
	});

	it("scopes history to the owner the filter names", async () => {
		const manager = createManager();
		const mainJob = registerDone(manager, "main", { ownerId: "Main" });
		const childJob = registerDone(manager, "child", { ownerId: "0-Child" });
		await manager.waitForAll();

		expect(manager.getTerminalHistory({ ownerId: "Main" }).map(entry => entry.id)).toEqual([mainJob]);
		expect(manager.getTerminalHistory({ ownerId: "0-Child" }).map(entry => entry.id)).toEqual([childJob]);
		expect(new Set(manager.getTerminalHistory().map(entry => entry.id))).toEqual(new Set([mainJob, childJob]));
	});

	it("records a foreground-backed job only once it is promoted to the background", async () => {
		const manager = createManager();
		const id = registerDone(manager, "fg", { ownerId: "Main", foreground: true });
		await manager.waitForAll();
		expect(manager.getTerminalHistory({ ownerId: "Main" })).toEqual([]);

		manager.backgroundJob(id);
		expect(manager.getTerminalHistory({ ownerId: "Main" }).map(entry => entry.id)).toEqual([id]);
	});

	it("drops an owner's history when its settled jobs are evicted, including jobs still settling", async () => {
		const manager = createManager();
		registerDone(manager, "old", { ownerId: "Main" });
		const otherOwner = registerDone(manager, "other", { ownerId: "0-Child" });
		await manager.waitForAll();
		const release = Promise.withResolvers<void>();
		manager.register(
			"bash",
			"settling",
			async () => {
				await release.promise;
				return "late";
			},
			{ ownerId: "Main" },
		);

		manager.evictCompletedJobs({ ownerId: "Main" });
		release.resolve();
		await manager.waitForAll();

		expect(manager.getTerminalHistory({ ownerId: "Main" })).toEqual([]);
		expect(manager.getTerminalHistory({ ownerId: "0-Child" }).map(entry => entry.id)).toEqual([otherOwner]);
	});
});
