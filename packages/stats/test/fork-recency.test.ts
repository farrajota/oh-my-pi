import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getRecentRequests } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import type { SyncWorkerRequest, SyncWorkerResponse } from "../src/sync-worker";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-fork-recency-");

interface AssistantOptions {
	entryId: string;
	parentId?: string | null;
	timestamp: string;
}

function buildUserEntry(entryId: string, timestamp: string, content: string) {
	return {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp,
		message: { role: "user", content },
	};
}

function buildAssistantEntry(opts: AssistantOptions) {
	return {
		type: "message",
		id: opts.entryId,
		parentId: opts.parentId ?? null,
		timestamp: opts.timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			responseId: `resp-${opts.entryId}`,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: Date.parse(opts.timestamp),
			duration: 10,
			ttft: 5,
		},
	};
}

async function writeSessionFile(
	folderSlug: string,
	fileName: string,
	header: { id: string; cwd: string; parentSession?: string },
	entries: unknown[],
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), folderSlug);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const headerEntry = {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: new Date().toISOString(),
		cwd: header.cwd,
		...(header.parentSession ? { parentSession: header.parentSession } : {}),
	};
	const lines = [headerEntry, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

function installOrderedParseWorkers(firstFile: string) {
	const firstDelivered = Promise.withResolvers<void>();
	const completionOrder: string[] = [];
	// Replace only the worker transport: parse real transcripts, but control
	// response delivery without timing-dependent sleeps or worker startup races.
	const observer = spyOn(globalThis, "Worker").mockImplementation(() => {
		let terminated = false;
		const worker = {
			onmessage: null as ((event: MessageEvent<SyncWorkerResponse>) => void) | null,
			postMessage(request: SyncWorkerRequest) {
				void (async () => {
					try {
						if (request.kind === "ping") throw new Error("Expected a parse request");
						if (request.sessionFile !== firstFile) await firstDelivered.promise;
						const result = await parseSessionFile(
							request.sessionFile,
							request.fromOffset,
							request.parserState,
							request.replay,
						);
						if (terminated) return;
						completionOrder.push(request.sessionFile);
						worker.onmessage?.(new MessageEvent("message", { data: { ok: true, result } }));
						if (request.sessionFile === firstFile) firstDelivered.resolve();
					} catch (error) {
						firstDelivered.resolve();
						if (terminated) return;
						worker.onmessage?.(new MessageEvent("message", { data: { ok: false, error: String(error) } }));
					}
				})();
			},
			terminate() {
				terminated = true;
				firstDelivered.resolve();
			},
		};
		return worker as unknown as Worker;
	});
	return { observer, completionOrder };
}

describe("stats sync orders forks by recency tier", () => {
	it("lets a recent fork own copied requests when its parent is idle beyond a day", async () => {
		const copiedTimestamp = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const copiedUser = buildUserEntry("user01ab", copiedTimestamp, "hello");
		const copiedAssistant = buildAssistantEntry({
			entryId: "asst01ab",
			parentId: "user01ab",
			timestamp: copiedTimestamp,
		});
		const parentFile = await writeSessionFile(
			"--tmp--fork-recency",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[copiedUser, copiedAssistant],
		);
		const now = Date.now();
		const idleParentTime = new Date(now - 25 * 60 * 60 * 1000);
		await fs.utimes(parentFile, idleParentTime, idleParentTime);

		const forkOnlyTimestamp = new Date("2026-06-24T10:05:00.000Z").toISOString();
		const forkOnlyUser = buildUserEntry("user02cd", forkOnlyTimestamp, "follow-up");
		const forkOnlyAssistant = buildAssistantEntry({
			entryId: "asst02cd",
			parentId: "user02cd",
			timestamp: forkOnlyTimestamp,
		});
		const forkFile = await writeSessionFile(
			"--tmp--fork-recency",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[copiedUser, copiedAssistant, forkOnlyUser, forkOnlyAssistant],
		);
		await fs.utimes(forkFile, new Date(now), new Date(now));

		await syncAllSessions({ workers: 1 });

		const requests = getRecentRequests(10).filter(
			request => request.entryId === "asst01ab" || request.entryId === "asst02cd",
		);
		expect(requests).toHaveLength(2);
		expect(Object.fromEntries(requests.map(request => [request.entryId, request.sessionFile]))).toEqual({
			asst01ab: forkFile,
			asst02cd: forkFile,
		});

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		expect(overall.totalInputTokens).toBe(200);
		expect(overall.totalOutputTokens).toBe(100);
		expect(overall.totalCost).toBeCloseTo(0.006, 8);
	});

	for (const recentFork of [false, true]) {
		for (const forkFinishesFirst of [true, false]) {
			it(`preserves ${recentFork ? "recent-fork" : "equal-tier parent"} ownership with workers: 2 when ${forkFinishesFirst ? "fork" : "parent"} finishes first`, async () => {
				const copiedTimestamp = "2026-06-24T10:00:00.000Z";
				const copiedUser = buildUserEntry("user01ab", copiedTimestamp, "hello");
				const copiedAssistant = buildAssistantEntry({
					entryId: "asst01ab",
					parentId: "user01ab",
					timestamp: copiedTimestamp,
				});
				const parentFile = await writeSessionFile(
					"--tmp--fork-recency",
					"01_parent.jsonl",
					{ id: "parent00", cwd: "/tmp/project" },
					[copiedUser, copiedAssistant],
				);
				const novelTimestamp = "2026-06-24T10:05:00.000Z";
				const forkFile = await writeSessionFile(
					"--tmp--fork-recency",
					"02_fork.jsonl",
					{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
					[
						copiedUser,
						copiedAssistant,
						buildUserEntry("user02cd", novelTimestamp, "follow-up"),
						buildAssistantEntry({ entryId: "asst02cd", parentId: "user02cd", timestamp: novelTimestamp }),
					],
				);
				const now = Date.now();
				const parentTime = new Date(now - (recentFork ? 25 * 60 * 60 * 1000 : 0));
				await fs.utimes(parentFile, parentTime, parentTime);
				await fs.utimes(forkFile, new Date(now), new Date(now));

				const firstFile = forkFinishesFirst ? forkFile : parentFile;
				const secondFile = forkFinishesFirst ? parentFile : forkFile;
				const { observer, completionOrder } = installOrderedParseWorkers(firstFile);
				try {
					await syncAllSessions({ workers: 2 });
				} finally {
					observer.mockRestore();
				}
				expect(completionOrder).toEqual([firstFile, secondFile]);
				const requests = getRecentRequests(10);
				expect(requests).toHaveLength(2);
				expect(Object.fromEntries(requests.map(request => [request.entryId, request.sessionFile]))).toEqual({
					asst01ab: recentFork ? forkFile : parentFile,
					asst02cd: forkFile,
				});
				const overall = getOverallStats();
				expect(overall.totalRequests).toBe(2);
				expect(overall.totalInputTokens).toBe(200);
				expect(overall.totalOutputTokens).toBe(100);
				expect(overall.totalCost).toBeCloseTo(0.006, 8);
			});
		}
	}
});
