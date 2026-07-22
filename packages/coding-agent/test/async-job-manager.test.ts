import { describe, expect, setSystemTime, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

describe("AsyncJobManager", () => {
	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"task",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("cancellation retains its eviction deadline when runs settle later", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		const manager = new AsyncJobManager({ retentionMs: 100, onJobComplete: async () => {} });
		const resolvedRun = Promise.withResolvers<string>();
		const rejectedRun = Promise.withResolvers<string>();
		try {
			const resolvedJobId = manager.register("task", "resolves after cancellation", async () => resolvedRun.promise);
			const rejectedJobId = manager.register("task", "rejects after cancellation", async () => rejectedRun.promise);

			expect(manager.cancel(resolvedJobId)).toBe(true);
			expect(manager.cancel(rejectedJobId)).toBe(true);
			expect(manager.getSnapshot().recent.map(job => [job.id, job.endTime])).toEqual([
				[rejectedJobId, 1_000],
				[resolvedJobId, 1_000],
			]);

			vi.advanceTimersByTime(50);
			resolvedRun.resolve("late result");
			rejectedRun.reject(new Error("late error"));
			await manager.waitForAll();

			expect(manager.getJob(resolvedJobId)?.endTime).toBe(1_000);
			expect(manager.getJob(rejectedJobId)?.endTime).toBe(1_000);
			expect(manager.getSnapshot().recent.map(job => [job.id, job.endTime])).toEqual([
				[rejectedJobId, 1_000],
				[resolvedJobId, 1_000],
			]);

			vi.advanceTimersByTime(49);
			expect(manager.getJob(resolvedJobId)?.status).toBe("cancelled");
			expect(manager.getJob(rejectedJobId)?.status).toBe("cancelled");
			vi.advanceTimersByTime(1);
			expect(manager.getJob(resolvedJobId)).toBeUndefined();
			expect(manager.getJob(rejectedJobId)).toBeUndefined();
			expect(manager.getSnapshot().recent.map(job => [job.id, job.endTime])).toEqual([
				[rejectedJobId, 1_000],
				[resolvedJobId, 1_000],
			]);
		} finally {
			await manager.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("queued jobs do not count toward the cap until markRunning", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queuedJobId = manager.register(
			"task",
			"queued",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return "queued done";
			},
			{ queued: true },
		);

		// Queued job holds no slot: another job registers fine at cap 1.
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		// Free the slot, then let the queued job start: it now occupies the slot.
		manager.cancel(runningJobId);
		gate.resolve();
		await started.promise;
		expect(() => manager.register("bash", "third", async () => "third")).toThrow(/Background job limit reached/);

		release.resolve();
		await manager.waitForAll();
		expect(manager.getJob(queuedJobId)?.status).toBe("completed");
	});

	test("markRunning cannot clear queued state after cancellation", async () => {
		vi.useFakeTimers();
		setSystemTime(1_000);
		let markRunning: (() => void) | undefined;
		const manager = new AsyncJobManager({ retentionMs: 100, onJobComplete: async () => {} });
		try {
			const jobId = manager.register(
				"task",
				"queued cancellation race",
				async ({ markRunning: capturedMarkRunning, signal }) => {
					markRunning = capturedMarkRunning;
					await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
					return "late result";
				},
				{ queued: true },
			);

			expect(markRunning).toBeDefined();
			expect(manager.cancel(jobId)).toBe(true);
			const terminalBeforeLateCallback = manager.getSnapshot({ recentLimit: 1 }).recent;
			expect(manager.getJob(jobId)).toMatchObject({ status: "cancelled", queued: true, endTime: 1_000 });

			markRunning!();
			expect(manager.getJob(jobId)).toMatchObject({ status: "cancelled", queued: true, endTime: 1_000 });
			expect(manager.getSnapshot({ recentLimit: 1 }).recent).toEqual(terminalBeforeLateCallback);

			await manager.waitForAll();
			expect(manager.getSnapshot({ recentLimit: 1 }).recent).toEqual(terminalBeforeLateCallback);
			vi.advanceTimersByTime(100);
			expect(manager.getJob(jobId)).toBeUndefined();
			expect(manager.getSnapshot({ recentLimit: 1 }).recent).toEqual(terminalBeforeLateCallback);
		} finally {
			await manager.dispose();
			vi.useRealTimers();
			setSystemTime();
		}
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await Bun.sleep(60);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async () => {},
		});

		const completedJobId = manager.register("task", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		const completedDeadline = Date.now() + 2_000;
		while (manager.getJob(completedJobId)?.status === "running") {
			if (Date.now() >= completedDeadline) throw new Error("Timed out waiting for completed job");
			await Bun.sleep(5);
		}
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Bun.sleep(80);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery failed");
			},
		});

		const jobId = manager.register("task", "awaited-job", async () => "done");
		await manager.waitForAll();

		const firstAttemptDeadline = Date.now() + 2_000;
		while (attempts === 0) {
			if (Date.now() >= firstAttemptDeadline) throw new Error("Timed out waiting for first delivery attempt");
			await Bun.sleep(5);
		}

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([jobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		await Bun.sleep(700);
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("dispose honors timeout when a cancelled job never settles", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		manager.register("bash", "ignores-abort", async () => {
			await Promise.withResolvers<never>().promise;
			return "unreachable";
		});

		const startedAt = Date.now();
		const result = await Promise.race([
			manager.dispose({ timeoutMs: 25 }).then(drained => ({ drained, settled: true })),
			Bun.sleep(150).then(() => ({ drained: true, settled: false })),
		]);

		expect(result.settled).toBe(true);
		expect(result.drained).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(150);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (jobId, text) => {
				if (jobId === mainJobId) {
					notifyMainDeliveryStarted();
					await mainDeliveryReleased;
					return;
				}
				subagentCompletions.push({ jobId, text });
			},
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await Bun.sleep(0);
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let mainJobId = "";
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				if (jobId === mainJobId) {
					notifyMainDeliveryStarted();
					await mainDeliveryReleased;
					return;
				}
				if (jobId === targetJobId) {
					notifyTargetDeliveryStarted();
					await targetDeliveryReleased;
					completions.push(jobId);
				}
			},
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});

	test("snapshots expose only immutable terminal metadata with fixed durations", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		manager.register("bash", "safe label", async () => "sensitive result body", { id: "metadata", ownerId: "Main" });

		await manager.waitForAll();
		const snapshot = manager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 99 });

		expect(snapshot.running).toEqual([]);
		expect(snapshot.recent).toHaveLength(1);
		expect(snapshot.recent[0]).toMatchObject({
			id: "metadata",
			label: "safe label",
			status: "completed",
			queued: false,
		});
		expect(snapshot.recent[0]?.endTime).toEqual(expect.any(Number));
		expect(Object.keys(snapshot.recent[0] ?? {}).sort()).toEqual([
			"endTime",
			"id",
			"label",
			"queued",
			"startTime",
			"status",
			"type",
		]);
		expect(Object.isFrozen(snapshot.recent[0]!)).toBe(true);

		manager.register("bash", "agent metadata", async () => "sensitive agent result", {
			id: "agent-metadata",
			ownerId: "Main",
			agentId: "MetadataAgent",
		});
		await manager.waitForAll();
		const agentSnapshot = manager
			.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 15 })
			.recent.find(job => job.id === "agent-metadata");
		expect(agentSnapshot).toMatchObject({ id: "agent-metadata", agentId: "MetadataAgent" });
		expect(Object.isFrozen(agentSnapshot!)).toBe(true);
		expect(agentSnapshot).not.toHaveProperty("resultText");
		expect(agentSnapshot).not.toHaveProperty("errorText");
		expect(agentSnapshot).not.toHaveProperty("latestDetails");
	});

	test("filters snapshot rows only when agentId is defined while preserving delivery", async () => {
		const deliveryGate = Promise.withResolvers<void>();
		const deliveryStarted = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			maxRunningJobs: 8,
			onJobComplete: async jobId => {
				if (jobId === "agent-completed") {
					deliveryStarted.resolve();
					await deliveryGate.promise;
				}
			},
		});
		const activeGate = Promise.withResolvers<string>();
		const markerlessTerminal = manager.register("task", "markerless task terminal", async () => "done", {
			id: "markerless-terminal",
			ownerId: "Main",
		});
		const agentCompleted = manager.register("task", "agent task terminal", async () => "done", {
			id: "agent-completed",
			ownerId: "Main",
			agentId: "",
		});
		const agentBash = manager.register("bash", "agent bash terminal", async () => "done", {
			id: "agent-bash",
			ownerId: "Main",
			agentId: "BashAgent",
		});
		const agentFailed = manager.register(
			"task",
			"agent failed",
			async () => {
				throw new Error("failed");
			},
			{ id: "agent-failed", ownerId: "Main", agentId: "FailureAgent" },
		);
		const agentCancelled = manager.register(
			"task",
			"agent cancelled",
			async ({ signal }) =>
				await new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
			{ id: "agent-cancelled", ownerId: "Main", agentId: "CancelledAgent" },
		);
		expect(manager.cancel(agentCancelled)).toBe(true);
		await manager.waitForAll();
		await deliveryStarted.promise;

		manager.register("task", "markerless task active", async () => activeGate.promise, {
			id: "markerless-active",
			ownerId: "Main",
		});
		manager.register("bash", "agent bash active", async () => activeGate.promise, {
			id: "agent-bash-active",
			ownerId: "Main",
			agentId: "ActiveBashAgent",
		});
		manager.register("task", "agent queued", async () => activeGate.promise, {
			id: "agent-queued",
			ownerId: "Main",
			agentId: "QueuedAgent",
			queued: true,
		});
		await Promise.resolve();

		const defaultSnapshot = manager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 15 });
		const explicitSnapshot = manager.getSnapshot({
			filter: { ownerId: "Main" },
			recentLimit: 15,
			includeAgentJobs: true,
		});
		expect(defaultSnapshot.running).toEqual(explicitSnapshot.running);
		expect(defaultSnapshot.recent).toEqual(explicitSnapshot.recent);
		expect(defaultSnapshot.running.map(job => job.id)).toEqual([
			"markerless-active",
			"agent-bash-active",
			"agent-queued",
		]);
		expect(defaultSnapshot.running.find(job => job.id === "agent-queued")?.queued).toBe(true);

		const filtered = manager.getSnapshot({
			filter: { ownerId: "Main" },
			recentLimit: 15,
			includeAgentJobs: false,
		});
		expect(filtered.running.map(job => job.id)).toEqual(["markerless-active"]);
		expect(filtered.recent.map(job => job.id)).toEqual([markerlessTerminal]);
		expect(filtered.recent).not.toContainEqual(expect.objectContaining({ id: agentCompleted }));
		expect(filtered.recent).not.toContainEqual(expect.objectContaining({ id: agentBash }));
		expect(filtered.recent).not.toContainEqual(expect.objectContaining({ id: agentFailed }));
		expect(filtered.recent).not.toContainEqual(expect.objectContaining({ id: agentCancelled }));
		expect(filtered.delivery.pendingJobIds).toContain(agentCompleted);

		deliveryGate.resolve();
		activeGate.resolve("done");
		await manager.waitForAll();
		await manager.dispose();
	});

	test("filters before the terminal limit and retains each category independently", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(50);
		const filterManager = new AsyncJobManager({ onJobComplete: async () => {} });
		const nonAgentManager = new AsyncJobManager({ maxRunningJobs: 20, onJobComplete: async () => {} });
		const agentManager = new AsyncJobManager({ maxRunningJobs: 20, onJobComplete: async () => {} });
		try {
			filterManager.register("task", "older markerless task", async () => "done", { id: "filtered-markerless" });
			await filterManager.waitForAll();
			now.mockReturnValue(100);
			filterManager.register("task", "newer agent task", async () => "done", {
				id: "filtered-agent",
				agentId: "Filtered",
			});
			await filterManager.waitForAll();
			expect(
				filterManager.getSnapshot({ recentLimit: 1, includeAgentJobs: false }).recent.map(job => job.id),
			).toEqual(["filtered-markerless"]);

			now.mockReturnValue(100);
			nonAgentManager.register("task", "older markerless task", async () => "done", {
				id: "markerless",
				ownerId: "Main",
			});
			await nonAgentManager.waitForAll();
			now.mockReturnValue(50);
			for (let index = 0; index < 16; index++) {
				nonAgentManager.register("task", `agent churn ${index}`, async () => "done", {
					id: `agent-${index}`,
					ownerId: "Main",
					agentId: `Agent${index}`,
				});
			}
			await nonAgentManager.waitForAll();
			expect(
				nonAgentManager
					.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 15, includeAgentJobs: false })
					.recent.map(job => job.id),
			).toEqual(["markerless"]);

			now.mockReturnValue(100);
			agentManager.register("task", "older agent task", async () => "done", {
				id: "agent-survivor",
				ownerId: "Main",
				agentId: "Survivor",
			});
			await agentManager.waitForAll();
			now.mockReturnValue(50);
			for (let index = 0; index < 16; index++) {
				agentManager.register("task", `markerless churn ${index}`, async () => "done", {
					id: `markerless-${index}`,
					ownerId: "Main",
				});
			}
			await agentManager.waitForAll();
			expect(
				agentManager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 1 }).recent.map(job => job.id),
			).toEqual(["agent-survivor"]);
		} finally {
			now.mockRestore();
			await filterManager.dispose();
			await nonAgentManager.dispose();
			await agentManager.dispose();
		}
	});

	test("matches owners exactly with agent filtering and suppresses both terminal buckets", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const completionGate = Promise.withResolvers<string>();
		manager.register("task", "unowned markerless", async () => "done", { id: "unowned-markerless" });
		manager.register("task", "unowned agent", async () => "done", { id: "unowned-agent", agentId: "Unowned" });
		manager.register("task", "owned markerless", async () => "done", { id: "owned-markerless", ownerId: "Main" });
		manager.register("task", "owned agent", async () => "done", {
			id: "owned-agent",
			ownerId: "Main",
			agentId: "Owned",
		});
		manager.register("task", "suppressed markerless", async () => completionGate.promise, {
			id: "suppressed-markerless",
		});
		manager.register("task", "suppressed agent", async () => completionGate.promise, {
			id: "suppressed-agent",
			agentId: "Suppressed",
		});
		await Promise.resolve();
		manager.clearHistory({ ownerId: undefined });
		completionGate.resolve("done");
		await manager.waitForAll();

		expect(
			manager
				.getSnapshot({ filter: { ownerId: undefined }, includeAgentJobs: false, recentLimit: 15 })
				.recent.map(job => job.id),
		).toEqual([]);
		expect(manager.getSnapshot({ filter: { ownerId: undefined } }).recent).toEqual([]);
		expect(
			manager.getSnapshot({ filter: { ownerId: "Main" }, includeAgentJobs: false }).recent.map(job => job.id),
		).toEqual(["owned-markerless"]);
		expect(manager.getSnapshot({ filter: { ownerId: "Main" } }).recent.map(job => job.id)).toEqual([
			"owned-agent",
			"owned-markerless",
		]);
		await manager.dispose();
		expect(manager.getSnapshot({ includeAgentJobs: false }).recent).toEqual([]);
	});

	test("snapshot owner filters include undefined exactly and never limit active rows", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 3, onJobComplete: async () => {} });
		const gate = Promise.withResolvers<void>();
		manager.register("bash", "unowned terminal", async () => "done");
		manager.register("bash", "owned terminal", async () => "done", { ownerId: "Main" });
		manager.register(
			"task",
			"queued active",
			async () => {
				await gate.promise;
				return "done";
			},
			{ ownerId: undefined, queued: true },
		);
		manager.register(
			"bash",
			"running active",
			async () => {
				await gate.promise;
				return "done";
			},
			{ ownerId: undefined },
		);

		await Promise.resolve();
		const unowned = manager.getSnapshot({ filter: { ownerId: undefined }, recentLimit: 0 });
		expect(unowned.recent).toEqual([]);
		expect(unowned.running.map(job => job.label).sort()).toEqual(["queued active", "running active"]);
		expect(unowned.running.find(job => job.label === "queued active")?.queued).toBe(true);
		expect(manager.getSnapshot({ filter: { ownerId: "Main" } }).running).toEqual([]);

		gate.resolve();
		await manager.waitForAll();
		expect(manager.getSnapshot({ filter: { ownerId: undefined } }).recent.map(job => job.label)).toContain(
			"unowned terminal",
		);
		expect(manager.getSnapshot({ filter: { ownerId: undefined } }).recent.map(job => job.label)).not.toContain(
			"owned terminal",
		);
		const filteredUnownedHistory = manager.getSnapshot({ filter: { ownerId: undefined }, includeAgentJobs: false });
		expect(filteredUnownedHistory.recent.map(job => job.label)).toContain("unowned terminal");
		expect(filteredUnownedHistory.recent.map(job => job.label)).not.toContain("owned terminal");
	});

	test("caps terminal metadata history per owner and clears it without changing live eviction", async () => {
		const manager = new AsyncJobManager({ maxRunningJobs: 20, retentionMs: 25, onJobComplete: async () => {} });
		const ids = Array.from({ length: 16 }, (_, index) =>
			manager.register("task", `job ${index}`, async () => "done", { id: `job-${index}`, ownerId: "Main" }),
		);

		await manager.waitForAll();
		expect(manager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 15 }).recent).toHaveLength(15);
		expect(manager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: -1 }).recent).toEqual([]);
		expect(manager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 2.9 }).recent).toHaveLength(2);
		expect(manager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: Number.NaN }).recent).toEqual([]);
		manager.clearHistory({ ownerId: "Main" });
		expect(manager.getSnapshot({ filter: { ownerId: "Main" } }).recent).toEqual([]);

		await Bun.sleep(60);
		expect(ids.every(id => manager.getJob(id) === undefined)).toBe(true);
	});

	test("orders equal-time terminal history across agent buckets and records cancellation once", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		try {
			manager.register("task", "first", async () => "done", { id: "first", ownerId: "Main" });
			manager.register("task", "second", async () => "done", { id: "second", ownerId: "Main", agentId: "Second" });
			const cancelled = manager.register(
				"task",
				"cancelled",
				async ({ signal }) =>
					await new Promise<string>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
					}),
				{ id: "cancelled", ownerId: "Main" },
			);

			expect(manager.cancel(cancelled)).toBe(true);
			expect(manager.cancel(cancelled)).toBe(false);
			await manager.waitForAll();

			const history = manager.getSnapshot({ filter: { ownerId: "Main" }, recentLimit: 15 }).recent;
			expect(history.map(job => job.id)).toEqual(["second", "first", "cancelled"]);
			expect(history.filter(job => job.id === "cancelled")).toHaveLength(1);
		} finally {
			now.mockRestore();
			await manager.dispose();
		}
	});

	test("retains terminal history for distinct jobs that reuse a default id", async () => {
		const manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		try {
			const firstId = manager.register("task", "first default job", async () => "first");
			expect(firstId).toBe("bg_1");
			await manager.waitForAll();
			expect(manager.getJob(firstId)).toBeUndefined();

			const secondId = manager.register("task", "second default job", async () => "second");
			expect(secondId).toBe("bg_1");
			await manager.waitForAll();

			expect(manager.getSnapshot({ recentLimit: 15 }).recent.map(job => [job.id, job.label])).toEqual([
				["bg_1", "second default job"],
				["bg_1", "first default job"],
			]);
		} finally {
			await manager.dispose();
		}
	});

	test("clears one owner's terminal history without exposing another owner's rows", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		manager.register("task", "main history", async () => "main output", { ownerId: "Main" });
		manager.register("task", "child history", async () => "child output", { ownerId: "Child" });
		await manager.waitForAll();

		manager.clearHistory({ ownerId: "Child" });
		expect(manager.getSnapshot({ filter: { ownerId: "Child" } }).recent).toEqual([]);
		expect(manager.getSnapshot({ filter: { ownerId: "Main" } }).recent.map(job => job.label)).toEqual([
			"main history",
		]);
		await manager.dispose();
	});
});

describe("AsyncJobManager smart poll-wait escalation", () => {
	const newManager = () => new AsyncJobManager({ onJobComplete: async () => {} });

	test("first poll waits the ladder floor", () => {
		const m = newManager();
		expect(m.nextPollWaitMs("Main", 1_000)).toBe(5_000);
		// A fresh owner also starts at the floor.
		expect(m.nextPollWaitMs("Other", 1_000)).toBe(5_000);
	});

	test("back-to-back polls climb the ladder to the top rung", () => {
		const m = newManager();
		const owner = "Main";
		const t = 1_000;
		const waits: number[] = [];
		for (let i = 0; i < 6; i++) {
			// Same timestamp every time → zero gap → always escalates.
			waits.push(m.nextPollWaitMs(owner, t));
			m.recordPollWaitEnd(owner, t);
		}
		// Climbs the rungs, then saturates at the top.
		expect(waits).toEqual([5_000, 10_000, 30_000, 60_000, 300_000, 300_000]);
	});

	test("a quiet gap of a minute resets back to the floor", () => {
		const m = newManager();
		const owner = "Main";

		expect(m.nextPollWaitMs(owner, 0)).toBe(5_000);
		m.recordPollWaitEnd(owner, 0);

		// Still within the reset window (just under a minute) → keeps climbing.
		expect(m.nextPollWaitMs(owner, 59_999)).toBe(10_000);
		m.recordPollWaitEnd(owner, 60_000);

		// A full minute without polling resets the climb to the floor.
		expect(m.nextPollWaitMs(owner, 120_000)).toBe(5_000);
	});

	test("escalation is tracked independently per owner", () => {
		const m = newManager();
		const t = 1_000;

		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);
		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);

		// A fresh owner starts at the floor regardless of A's escalation.
		expect(m.nextPollWaitMs("B", t)).toBe(5_000);
		// A keeps climbing from where it left off.
		expect(m.nextPollWaitMs("A", t)).toBe(30_000);
	});
});
