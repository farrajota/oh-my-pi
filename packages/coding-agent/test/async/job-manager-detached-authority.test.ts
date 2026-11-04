/**
 * A registered async job (background bash, async task, eval auto-background)
 * belongs to the job manager, not to the tool call that registered it. The
 * call is a session operation whose authority effect scope joins every nested
 * effect and stops admitting new ones once the call returns, so a job body
 * must admit its own root-level operations: otherwise a job that acts after
 * the call settled is refused, and a job that acts immediately holds the call
 * open and fails it with the job's own error. Late continuations that are not
 * registered jobs keep being refused.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async/job-manager";
import { getOperationTerminal, runJobOperation, runSessionOperation } from "../../src/registry/operation-lease";
import { createBoundOperationLedger, createRootAuthorityStore } from "../helpers/operation-authority";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createFixture(): Promise<{ manager: object; jobs: AsyncJobManager }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-detached-authority-"));
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	const authority = await createRootAuthorityStore(directory);
	cleanups.push(authority.close);
	const ledger = await createBoundOperationLedger(authority.store);
	cleanups.push(ledger.close);
	const jobs = new AsyncJobManager({});
	cleanups.push(() => jobs.waitForAll());
	return { manager: ledger.manager, jobs };
}

async function settledJob(jobs: AsyncJobManager, id: string) {
	const job = jobs.getJob(id);
	if (!job) throw new Error(`Job ${id} is not registered`);
	await job.promise;
	return job;
}

describe("async job authority ownership", () => {
	test("a job admits its own operation after the registering call settled", async () => {
		const { manager, jobs } = await createFixture();
		const callSettled = Promise.withResolvers<void>();
		let jobId = "";
		let jobOperationId = "";

		await runSessionOperation(manager, "session:registering-call", async () => {
			jobId = jobs.register("bash", "late job", async ({ incarnationId }) => {
				await callSettled.promise;
				jobOperationId = `job:${incarnationId}`;
				return runJobOperation(manager, jobOperationId, async () => "job done");
			});
		});
		expect(getOperationTerminal(manager, "session:registering-call")?.status).toBe("completed");
		callSettled.resolve();

		const job = await settledJob(jobs, jobId);
		expect(job.errorText ?? "").not.toContain("Authority effect scope is no longer active");
		expect(job.status).toBe("completed");
		expect(job.resultText).toBe("job done");
		expect(getOperationTerminal(manager, jobOperationId)?.status).toBe("completed");
	});

	test("a job that starts its operation at once does not fail the call that registered it", async () => {
		const { manager, jobs } = await createFixture();
		let jobId = "";
		let jobOperationId = "";

		// A joined job would make the call wait for it and adopt its failure.
		await runSessionOperation(manager, "session:registering-call", async () => {
			jobId = jobs.register("bash", "failing job", async ({ incarnationId }) => {
				jobOperationId = `job:${incarnationId}`;
				return runJobOperation(manager, jobOperationId, async () => {
					await Promise.resolve();
					throw new Error("background job failed");
				});
			});
		});

		const job = await settledJob(jobs, jobId);
		expect(job.status).toBe("failed");
		expect(job.errorText).toBe("background job failed");
		expect(getOperationTerminal(manager, jobOperationId)?.status).toBe("failed");
		expect(getOperationTerminal(manager, "session:registering-call")?.status).toBe("completed");
	});

	test("a late continuation that is not a registered job is still refused", async () => {
		const { manager } = await createFixture();
		const callSettled = Promise.withResolvers<void>();
		let continuation: Promise<string> | undefined;

		await runSessionOperation(manager, "session:registering-call", async () => {
			continuation = (async () => {
				await callSettled.promise;
				return runJobOperation(manager, "job:escaped-continuation", async () => "must not run");
			})();
		});
		callSettled.resolve();

		const refusal = await continuation!.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toContain("Authority effect scope is no longer active");
		expect(getOperationTerminal(manager, "job:escaped-continuation")?.status).toBe("failed");
	});
});
