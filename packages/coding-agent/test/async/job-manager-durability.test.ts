import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { DurableHubStore } from "../../src/internal/hub-durable-state";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager durable custody", () => {
	const roots: string[] = [];

	function journalPath(): string {
		const root = path.join(os.tmpdir(), `omp-w4-jobs-${crypto.randomUUID()}`);
		roots.push(root);
		return path.join(root, "custody.jsonl");
	}

	afterEach(() => {
		for (const root of roots.splice(0)) removeSyncWithRetries(root);
	});
	test("restores an exact queued terminal incarnation and finishes delivery forward", async () => {
		const journal = journalPath();
		const store = new DurableHubStore(journal);
		const id = "durable-job";
		const incarnationId = crypto.randomUUID();
		const text = "assembled result";
		expect(store.reserve("job", id, incarnationId)).toBe(true);
		store.append("job", id, incarnationId, {
			event: "terminal",
			type: "bash",
			status: "completed",
			label: "durable",
			startTime: 1,
			endTime: 2,
			queued: false,
			output: {
				source: "result",
				text,
				byteCount: Buffer.byteLength(text),
				sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
				truncated: false,
			},
		});
		store.append("delivery", id, incarnationId, { state: "queued", attempt: 0, nextAttemptAt: 0 });

		const delivered: string[] = [];
		const recovered = new AsyncJobManager({
			durableJournalPath: journal,
			onJobComplete: async (_jobId, text) => {
				delivered.push(text);
			},
		});
		const batch = recovered.recoverDurableState();
		expect(batch.restoredJobIds).toEqual([id]);
		await recovered.drainDeliveries({ timeoutMs: 1_000 });
		expect(delivered).toEqual(["assembled result"]);
		expect(recovered.getOutput(id)?.source).toBe("none");
	});

	test("quarantines a delivery whose external effect threw instead of retrying it", async () => {
		const journal = journalPath();
		const attempted = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			durableJournalPath: journal,
			onJobComplete: async () => {
				attempted.resolve();
				throw new Error("ambiguous commit");
			},
		});
		const id = manager.register("bash", "ambiguous delivery", async () => "result");
		await manager.getJob(id)?.promise;
		await attempted.promise;
		await manager.drainDeliveries({ timeoutMs: 1_000 });

		const recovered = new AsyncJobManager({ durableJournalPath: journal });
		const batch = recovered.recoverDurableState();
		expect(batch.quarantinedJobIds).toContain(id);
		expect(recovered.getJob(id)).toBeUndefined();
	});

	test("quarantines a running body instead of recreating execution authority", () => {
		const journal = journalPath();
		const first = new AsyncJobManager({ durableJournalPath: journal });
		const pending = Promise.withResolvers<string>();
		const id = first.register("bash", "ambiguous", async () => pending.promise);
		const recovered = new AsyncJobManager({ durableJournalPath: journal });
		const batch = recovered.recoverDurableState();
		expect(batch.quarantinedJobIds).toContain(id);
		expect(recovered.getJob(id)).toBeUndefined();
		first.cancel(id);
		pending.resolve("stopped");
	});

	test("consumed results remain omitted and pins release only after publication", async () => {
		const journal = journalPath();
		const sinkStarted = Promise.withResolvers<void>();
		const sinkRelease = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			durableJournalPath: journal,
			onJobComplete: async () => {
				sinkStarted.resolve();
				await sinkRelease.promise;
			},
		});
		const id = manager.register("task", "pin", async () => "result");
		await manager.getJob(id)?.promise;
		await sinkStarted.promise;
		expect(manager.pinJobResult(id, "artifact-set")).toBe(true);
		expect(manager.releaseJobResultPin(id, "artifact-set")).toBe(false);
		sinkRelease.resolve();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(manager.getOutput(id)?.source).toBe("none");
		expect(manager.releaseJobResultPin(id, "artifact-set")).toBe(true);
	});

	test("recovery cursor never processes more than 100 records", () => {
		const journal = journalPath();
		const store = new DurableHubStore(journal);
		for (let index = 0; index < 105; index++) {
			store.append("cancel", `job-${index}`, `incarnation-${index}`, { state: "committed" });
		}
		const manager = new AsyncJobManager({ durableStore: store });
		const first = manager.recoverDurableState(0, 1_000);
		expect(first.processed).toBe(100);
		expect(first.nextCursor).toBe(100);
		const second = manager.recoverDurableState(first.nextCursor, 1_000);
		expect(second.processed).toBe(5);
		expect(second.nextCursor).toBeUndefined();
	});
});
