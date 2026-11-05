import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { isSyntheticToolResultMessage } from "@oh-my-pi/pi-agent-core";
import {
	collectPendingToolCalls,
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { canonicalDurableSha256, durableRootHeadHash } from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import {
	AuthorityAdoptionRefusedError,
	closeSessionAuthority,
	registryDurableStateForSession,
} from "@oh-my-pi/pi-coding-agent/registry/authority";
import { authorityPaths } from "@oh-my-pi/pi-coding-agent/registry/authority/ownership";
import { readAuthorityDescriptor } from "@oh-my-pi/pi-coding-agent/registry/authority/descriptor";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { isTaskToolDetails, type TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as authority from "@oh-my-pi/pi-coding-agent/registry/authority";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

async function createSessionWithArtifacts(root: string): Promise<{
	cwd: string;
	sessionDir: string;
	sourceFile: string;
	sourceArtifactsDir: string;
}> {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	const sourceFile = path.join(sessionDir, "source.jsonl");
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "source-with-artifacts",
		timestamp: new Date().toISOString(),
		cwd,
	};
	await fs.mkdir(path.join(sourceArtifactsDir, "nested"), { recursive: true });
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	await Bun.write(path.join(sourceArtifactsDir, "1.read.log"), "tool output");
	await Bun.write(path.join(sourceArtifactsDir, "nested", "result.txt"), "nested output");
	return { cwd, sessionDir, sourceFile, sourceArtifactsDir };
}

/** Load a session file's transcript entries, dropping the non-entry session header. */
async function loadHistory(file: string): Promise<SessionEntry[]> {
	const entries = await loadEntriesFromFile(file);
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

describe("SessionManager.forkFrom", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "omp-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("copies source artifacts recursively into the fork by default", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-artifacts-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).text()).toBe("tool output");
		expect(await Bun.file(path.join(forkArtifactsDir, "nested", "result.txt")).text()).toBe("nested output");
		expect(await Bun.file(path.join(sourceArtifactsDir, "1.read.log")).text()).toBe("tool output");
	});

	it("forks a seance in place: source untouched, history kept, startup contracts inert, artifacts not copied", async () => {
		using tempDir = TempDir.createSync("@omp-session-seance-fork-");
		const { cwd, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source-session",
			timestamp,
			cwd,
			additionalDirectories: [path.join(tempDir.path(), "parent-workspace")],
		};
		const inheritedInit = {
			type: "session_init",
			id: "inherited-init",
			parentId: null,
			timestamp,
			systemPrompt: ["unrestricted source prompt"],
			task: "unrestricted source task",
			tools: ["read", "write", "task"],
			agent: "task",
			spawns: "*",
		};
		const request = {
			type: "message",
			id: "witness-request",
			parentId: "inherited-init",
			timestamp,
			message: { role: "user", content: "early request before resume", timestamp: 1 },
		};
		const laterInit = {
			...inheritedInit,
			id: "later-inherited-init",
			parentId: "witness-request",
			systemPrompt: ["later unrestricted resume prompt"],
		};
		const laterMessage = {
			type: "message",
			id: "later-source-message",
			parentId: "later-inherited-init",
			timestamp,
			message: { role: "user", content: "later source turn", timestamp: 3 },
		};
		const sourceText = `${[sourceHeader, inheritedInit, request, laterInit, laterMessage]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`;
		await Bun.write(sourceFile, sourceText);

		const forkFile = path.join(tempDir.path(), "forks", "seance.jsonl");
		const forked = await SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: forkFile,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		try {
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
			const asSourceInit = { type: "custom", customType: "source_session_init" };
			expect(await loadHistory(forkFile)).toEqual([
				{ ...asSourceInit, id: inheritedInit.id, parentId: null, timestamp, data: inheritedInit },
				request,
				{ ...asSourceInit, id: laterInit.id, parentId: laterInit.parentId, timestamp, data: laterInit },
				laterMessage,
			] as unknown as SessionEntry[]);
			// Revival reads the header's source pointer and finds no inherited contract to resurrect.
			expect(await SessionManager.peekSessionInit(forkFile)).toMatchObject({
				seanceSource: path.resolve(sourceFile),
				init: null,
			});
			expect(forked.getSeanceSourceArtifactsDir()).toBe(sourceArtifactsDir);
			expect(forked.getAdditionalDirectories()).toEqual([]);
			await expect(fs.stat(forkFile.slice(0, -".jsonl".length))).rejects.toMatchObject({ code: "ENOENT" });
			// A seance consult is a child transcript: its actor lives in the consulting root's
			// authority, so the fork gets no root authority bundle of its own.
			const sidecars = authorityPaths(forkFile);
			for (const sidecar of [
				sidecars.descriptor,
				sidecars.jsonl,
				sidecars.sqlite,
				sidecars.legacyFence,
				sidecars.lock,
			]) {
				expect(await Bun.file(sidecar).exists()).toBe(false);
			}
		} finally {
			await forked.close();
		}
	});

	it("does not copy artifacts when the caller opts out", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-no-artifacts-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).exists()).toBe(false);
	});

	it("does not treat an extensionless source's parent directory as artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-extensionless-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const forkDir = path.join(tempDir.path(), "forks");
		const sourceFile = path.join(sessionDir, "source");
		const unrelatedFile = path.join(sessionDir, "unrelated.txt");
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "extensionless-source",
			timestamp: new Date().toISOString(),
			cwd,
		};
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
		await Bun.write(unrelatedFile, "must not be copied");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, forkDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "unrelated.txt")).exists()).toBe(false);
		expect(await Bun.file(unrelatedFile).text()).toBe("must not be copied");
	});

	it("zeroes inherited cost while preserving token counts only when reset is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-cost-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cost-source",
			timestamp,
			cwd,
		};
		const assistantEntry = {
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "task-call-1", name: "task", arguments: { task: "inspect" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 165,
					premiumRequests: 2,
					credits: { cost: 3, committedCost: 3, acuCost: 1 },
					cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 0.5, total: 6 },
				},
			},
		};
		const taskUsage = {
			input: 40,
			output: 10,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 53,
			premiumRequests: 3,
			credits: { cost: 10, committedCost: 10, acuCost: 2 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedUsage = {
			input: 5,
			output: 3,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 11,
			premiumRequests: 1,
			credits: { cost: 4, committedCost: 4, acuCost: 1 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedTaskSnapshot = (
			id: string,
			usage: typeof taskUsage,
			progressCost: number,
			nestedTask?: TaskToolDetails,
		): TaskToolDetails => ({
			projectAgentsDir: null,
			usage,
			totalDurationMs: 1,
			results: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					task: "inspect nested",
					exitCode: 0,
					output: "done",
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: usage.totalTokens,
					requests: 1,
					usage,
					...(nestedTask ? { extractedToolData: { task: [nestedTask] } } : {}),
				},
			],
			progress: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					status: "completed",
					task: "inspect nested",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					requests: 1,
					tokens: usage.totalTokens,
					cost: progressCost,
					durationMs: 1,
				},
			],
		});
		const grandchildUsage = { ...nestedUsage, input: 8, totalTokens: 16 };
		const inflightUsage = { ...nestedUsage, input: 6, totalTokens: 12 };
		const inflightGrandchildUsage = { ...nestedUsage, input: 9, totalTokens: 18 };
		const progressGrandchildUsage = { ...nestedUsage, input: 7, totalTokens: 14 };
		const grandchildDetails = nestedTaskSnapshot("grandchild", grandchildUsage, 17);
		const inflightGrandchildDetails = nestedTaskSnapshot("inflight-grandchild", inflightGrandchildUsage, 19);
		const inflightTaskDetails = nestedTaskSnapshot("inflight", inflightUsage, 9, inflightGrandchildDetails);
		const progressGrandchildDetails = nestedTaskSnapshot("progress-grandchild", progressGrandchildUsage, 21);
		const taskResultEntry = {
			type: "message",
			id: "task-result-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "task-call-1",
				toolName: "task",
				content: [{ type: "text", text: "completed worker" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					usage: taskUsage,
					results: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							task: "inspect",
							exitCode: 0,
							output: "done",
							stderr: "",
							truncated: false,
							durationMs: 1,
							tokens: 11,
							requests: 1,
							usage: nestedUsage,
							extractedToolData: { task: [grandchildDetails] },
						},
					],
					progress: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							status: "completed",
							task: "inspect",
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							requests: 1,
							tokens: 11,
							cost: 10,
							inflightTaskDetails,
							extractedToolData: { task: [progressGrandchildDetails] },
							durationMs: 1,
						},
					],
				},
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(sourceHeader)}\n${JSON.stringify(assistantEntry)}\n${JSON.stringify(taskResultEntry)}\n`,
		);
		const sourceText = await Bun.file(sourceFile).text();
		const sourceManager = await SessionManager.open(sourceFile, sessionDir, undefined, { suppressBreadcrumb: true });

		const findAssistant = async (file: string) => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find((e): e is SessionMessageEntry => e.type === "message");
			if (entry?.message.role !== "assistant") throw new Error("expected assistant message");
			return entry.message;
		};
		const findTaskDetails = async (file: string): Promise<TaskToolDetails> => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find(
				(e): e is SessionMessageEntry =>
					e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "task",
			);
			if (!entry || entry.message.role !== "toolResult") throw new Error("expected task tool result");
			if (!isTaskToolDetails(entry.message.details)) throw new Error("expected task tool details");
			return entry.message.details;
		};
		const findNestedTaskDetails = (extractedToolData: Record<string, unknown[]> | undefined): TaskToolDetails => {
			const nested = extractedToolData?.task?.[0];
			if (!isTaskToolDetails(nested)) throw new Error("expected nested task details");
			return nested;
		};
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const expectUsagePreserved = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(expected.cost);
			expect(actual?.credits).toEqual(expected.credits);
			expect(actual?.premiumRequests).toBe(expected.premiumRequests);
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};
		const expectUsageReset = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(zeroCost);
			expect(actual?.credits).toBeUndefined();
			expect(actual?.premiumRequests).toBeUndefined();
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};

		const preserved = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "keep"), undefined, {
			suppressBreadcrumb: true,
		});
		const preservedFile = preserved.getSessionFile();
		if (!preservedFile) throw new Error("expected preserved fork file");
		const preservedMessage = await findAssistant(preservedFile);
		expect(preservedMessage.usage.cost.total).toBe(6);
		expect(preservedMessage.usage.premiumRequests).toBe(2);
		const preservedTaskDetails = await findTaskDetails(preservedFile);
		expect(preserved.getUsageStatistics().cost).toBe(16);
		expect(preservedTaskDetails.usage?.cost).toEqual(taskUsage.cost);
		expect(preservedTaskDetails.usage?.credits).toEqual(taskUsage.credits);
		expect(preservedTaskDetails.usage?.premiumRequests).toBe(taskUsage.premiumRequests);
		expect(preservedTaskDetails.results[0]?.usage?.cost).toEqual(nestedUsage.cost);
		expect(preservedTaskDetails.results[0]?.usage?.credits).toEqual(nestedUsage.credits);
		expect(preservedTaskDetails.results[0]?.usage?.premiumRequests).toBe(nestedUsage.premiumRequests);
		expect(preservedTaskDetails.progress?.[0]?.cost).toBe(10);
		const preservedTaskResult = preservedTaskDetails.results[0];
		if (!preservedTaskResult) throw new Error("expected direct task result");
		const preservedGrandchild = findNestedTaskDetails(preservedTaskResult.extractedToolData);
		expectUsagePreserved(preservedGrandchild.usage, grandchildUsage);
		expectUsagePreserved(preservedGrandchild.results[0]?.usage, grandchildUsage);
		expect(preservedGrandchild.progress?.[0]?.cost).toBe(17);
		const preservedProgress = preservedTaskDetails.progress?.[0];
		if (!preservedProgress) throw new Error("expected task progress");
		const preservedInflight = preservedProgress.inflightTaskDetails;
		if (!preservedInflight) throw new Error("expected in-flight task details");
		expectUsagePreserved(preservedInflight.usage, inflightUsage);
		expectUsagePreserved(preservedInflight.results[0]?.usage, inflightUsage);
		expect(preservedInflight.progress?.[0]?.cost).toBe(9);
		const preservedInflightGrandchild = findNestedTaskDetails(preservedInflight.results[0]?.extractedToolData);
		expectUsagePreserved(preservedInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsagePreserved(preservedInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(preservedInflightGrandchild.progress?.[0]?.cost).toBe(19);
		const preservedProgressGrandchild = findNestedTaskDetails(preservedProgress.extractedToolData);
		expectUsagePreserved(preservedProgressGrandchild.usage, progressGrandchildUsage);
		expectUsagePreserved(preservedProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(preservedProgressGrandchild.progress?.[0]?.cost).toBe(21);

		const reset = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "reset"), undefined, {
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});
		const resetFile = reset.getSessionFile();
		if (!resetFile) throw new Error("expected reset fork file");
		const resetMessage = await findAssistant(resetFile);
		expect(resetMessage.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(resetMessage.usage.credits).toBeUndefined();
		expect(resetMessage.usage.premiumRequests).toBeUndefined();
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetMessage.usage.input).toBe(100);
		expect(resetMessage.usage.output).toBe(50);
		expect(resetMessage.usage.totalTokens).toBe(165);
		const resetTaskDetails = await findTaskDetails(resetFile);
		expectUsageReset(resetTaskDetails.usage, taskUsage);
		expect(resetTaskDetails.results[0]?.usage?.cost).toEqual(zeroCost);
		expect(resetTaskDetails.results[0]?.usage?.credits).toBeUndefined();
		expect(resetTaskDetails.results[0]?.usage?.premiumRequests).toBeUndefined();
		expect(resetTaskDetails.progress?.[0]?.cost).toBe(0);
		expect(resetTaskDetails.progress?.[0]?.tokens).toBe(11);
		const resetTaskResult = resetTaskDetails.results[0];
		if (!resetTaskResult) throw new Error("expected direct task result");
		expectUsageReset(resetTaskResult.usage, nestedUsage);
		const resetGrandchild = findNestedTaskDetails(resetTaskResult.extractedToolData);
		expectUsageReset(resetGrandchild.usage, grandchildUsage);
		expectUsageReset(resetGrandchild.results[0]?.usage, grandchildUsage);
		expect(resetGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetGrandchild.progress?.[0]?.tokens).toBe(grandchildUsage.totalTokens);
		const resetProgress = resetTaskDetails.progress?.[0];
		if (!resetProgress) throw new Error("expected task progress");
		const resetInflight = resetProgress.inflightTaskDetails;
		if (!resetInflight) throw new Error("expected in-flight task details");
		expectUsageReset(resetInflight.usage, inflightUsage);
		expectUsageReset(resetInflight.results[0]?.usage, inflightUsage);
		expect(resetInflight.progress?.[0]?.cost).toBe(0);
		expect(resetInflight.progress?.[0]?.tokens).toBe(inflightUsage.totalTokens);
		const resetInflightGrandchild = findNestedTaskDetails(resetInflight.results[0]?.extractedToolData);
		expectUsageReset(resetInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsageReset(resetInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(resetInflightGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetInflightGrandchild.progress?.[0]?.tokens).toBe(inflightGrandchildUsage.totalTokens);
		const resetProgressGrandchild = findNestedTaskDetails(resetProgress.extractedToolData);
		expectUsageReset(resetProgressGrandchild.usage, progressGrandchildUsage);
		expectUsageReset(resetProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(resetProgressGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetProgressGrandchild.progress?.[0]?.tokens).toBe(progressGrandchildUsage.totalTokens);
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetTaskDetails.usage?.input).toBe(40);
		expect(resetTaskDetails.usage?.cacheRead).toBe(2);
		expect(resetTaskDetails.usage?.totalTokens).toBe(53);
		expect(resetTaskDetails.results[0]?.usage?.input).toBe(5);
		expect(resetTaskDetails.results[0]?.usage?.cacheRead).toBe(1);
		expect(resetTaskDetails.results[0]?.usage?.totalTokens).toBe(11);
		const sourceMessage = sourceManager.getEntries().find(entry => entry.type === "message");
		if (sourceMessage?.type !== "message" || sourceMessage.message.role !== "assistant") {
			throw new Error("expected source assistant message");
		}
		expect(sourceMessage.message.usage.cost.total).toBe(6);
		expect(sourceMessage.message.usage.premiumRequests).toBe(2);
		expect(await Bun.file(sourceFile).text()).toBe(sourceText);
		await sourceManager.close();
	});

	for (const { name, createStorage, padding } of [
		{ name: "buffered file", createStorage: () => new FileSessionStorage(), padding: "" },
		{ name: "streamed file", createStorage: () => new FileSessionStorage(), padding: "x".repeat(8 * 1024 * 1024) },
		{ name: "memory", createStorage: () => new MemorySessionStorage(), padding: "" },
	]) {
		it(`keeps independently loaded ${name} entries unchanged when the fork migrates and branches`, async () => {
			using tempDir = TempDir.createSync("@omp-session-fork-ownership-");
			const cwd = tempDir.path();
			const sessionDir = path.join(cwd, "sessions");
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const storage = createStorage();
			const timestamp = new Date().toISOString();
			const sourceText =
				[
					{ type: "session", version: 2, id: "legacy-source", timestamp, cwd },
					{
						type: "message",
						id: "user",
						parentId: null,
						timestamp,
						message: { role: "user", content: "source", timestamp: 1 },
					},
					{
						type: "message",
						id: "hook",
						parentId: "user",
						timestamp,
						message: {
							role: "hookMessage",
							customType: "legacy",
							content: padding || "legacy output",
							display: true,
							timestamp: 2,
						},
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n") + "\n";
			await storage.writeText(sourceFile, sourceText);
			const loadedBeforeFork = await loadEntriesFromFile(sourceFile, storage);
			const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "forks"), storage, {
				suppressBreadcrumb: true,
				copyArtifacts: false,
			});
			const migrated = forked.getEntries().find(entry => entry.id === "hook");
			expect(migrated).toMatchObject({ type: "message", message: { role: "custom", customType: "legacy" } });
			forked.branch("user");
			forked.appendMessage({ role: "user", content: "fork-only continuation", timestamp: 3 });
			expect(forked.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "source" },
				{ role: "user", content: "fork-only continuation" },
			]);
			await forked.close();
			expect(loadedBeforeFork[0]).toMatchObject({ type: "session", version: 2 });
			expect(loadedBeforeFork[2]).toMatchObject({ type: "message", message: { role: "hookMessage" } });
			expect(loadedBeforeFork).toEqual(await loadEntriesFromFile(sourceFile, storage));
			expect(await storage.readText(sourceFile)).toBe(sourceText);
		});
	}

	it("pairs an unresolved tool call with an unknown-outcome result only when repair is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "live-parent",
			timestamp,
			cwd,
		};
		// Parent is mid-turn: the assistant emitted a tool call whose result was
		// delivered only to the parent, so the forked tail is non-terminal.
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_live", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

		const untouched = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "untouched"),
			undefined,
			{
				suppressBreadcrumb: true,
			},
		);
		const untouchedEntries = await loadHistory(untouched.getSessionFile()!);
		expect(collectPendingToolCalls(untouchedEntries).map(call => call.toolCallId)).toEqual(["toolu_live"]);

		const repaired = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "repaired"),
			undefined,
			{
				suppressBreadcrumb: true,
				repairInterruptedTail: true,
			},
		);
		const repairedEntries = await loadHistory(repaired.getSessionFile()!);
		expect(collectPendingToolCalls(repairedEntries)).toEqual([]);
		const result = repairedEntries.find(
			(entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "toolResult",
		);
		if (!result || result.message.role !== "toolResult") throw new Error("expected an unknown tool result");
		expect(result.message.toolCallId).toBe("toolu_live");
		expect(result.message.isError).toBe(true);
		expect(result.message).not.toHaveProperty("details");
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
	});

	it("leaves an exited source's interrupted tail to resume recovery", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-exited-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const entries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "crashed-parent", timestamp, cwd },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "toolu_crashed", name: "bash", arguments: { command: "make" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					stopReason: "toolUse",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
			{
				type: "custom",
				id: "m2",
				parentId: "m1",
				timestamp,
				customType: SESSION_EXIT_CUSTOM_TYPE,
				data: { reason: "uncaughtException", kind: "fatal", recordedAt: timestamp },
			},
		];
		await Bun.write(sourceFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch).map(call => call.toolCallId)).toEqual(["toolu_crashed"]);
		expect(describePendingToolCalls(branch)).toContain("toolu_crashed");
		expect(createInterruptedTurnAbortMessage(branch)?.stopReason).toBe("aborted");
		const [result] = createInterruptedToolResults(branch);
		expect(result?.toolCallId).toBe("toolu_crashed");
		expect(
			result?.content.some(block => block.type === "text" && block.text.includes("Previous OMP process exited")),
		).toBe(true);
	});

	it("retains the length-stop guard only when a call has no start marker", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-length-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "length-limited-parent",
			timestamp,
			cwd,
		};
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_truncated",
						name: "write",
						arguments: { path: "partial.txt", content: "incomplete payload" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "length",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const result = branch.find(
			(entry): entry is SessionMessageEntry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				isSyntheticToolResultMessage(entry.message),
		);
		if (!result || !isSyntheticToolResultMessage(result.message)) {
			throw new Error("expected a synthetic tool result for the truncated call");
		}
		expect(result.message.toolCallId).toBe("toolu_truncated");
		expect(result.message.details).toMatchObject({ source: "assistant_stop_length", executed: false });
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("truncated and unsafe to run"),
			),
		).toBe(true);
		const startedSourceFile = path.join(sessionDir, "started-source.jsonl");
		const startedHeader = { ...header, id: "length-started-parent" };
		const startMarker = {
			type: "custom",
			id: "m2",
			parentId: "m1",
			timestamp,
			customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
			data: { toolCallId: "toolu_truncated", toolName: "write", startedAt: timestamp },
		};
		await Bun.write(
			startedSourceFile,
			`${JSON.stringify(startedHeader)}\n${JSON.stringify(assistant)}\n${JSON.stringify(startMarker)}\n`,
		);
		const startedFork = await SessionManager.forkFrom(
			startedSourceFile,
			cwd,
			path.join(tempDir.path(), "started-fork"),
			undefined,
			{
				suppressBreadcrumb: true,
				repairInterruptedTail: true,
			},
		);
		const startedEntries = await loadHistory(startedFork.getSessionFile()!);
		expect(collectPendingToolCalls(startedEntries)).toEqual([]);
		const startedResult = startedEntries.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "toolu_truncated",
		);
		if (startedResult?.type !== "message" || startedResult.message.role !== "toolResult") {
			throw new Error("expected the started length-stopped call to be paired");
		}
		expect(isSyntheticToolResultMessage(startedResult.message)).toBe(false);
		expect(startedResult.message).not.toHaveProperty("details");
		expect(
			startedResult.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
	});

	it("repairs only the active branch when sibling paths contain assistants and results", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-branch-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "branched-parent",
			timestamp,
			cwd,
		};
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const activeAssistant = {
			type: "message",
			id: "active-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_active", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const siblingResult = {
			type: "message",
			id: "sibling-result",
			parentId: "active-assistant",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_active",
				toolName: "bash",
				content: [{ type: "text", text: "completed on abandoned branch" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const siblingAssistant = {
			type: "message",
			id: "sibling-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_sibling", name: "read", arguments: { path: "old.txt" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const activeLeaf = {
			type: "message",
			id: "active-leaf",
			parentId: "active-assistant",
			timestamp,
			message: { role: "user", content: "continue on this branch", timestamp: Date.now() },
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(activeAssistant)}\n${JSON.stringify(siblingResult)}\n${JSON.stringify(siblingAssistant)}\n${JSON.stringify(activeLeaf)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const result = branch.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "toolu_active",
		);
		if (result?.type !== "message" || result.message.role !== "toolResult") {
			throw new Error("expected the active branch's unknown tool result");
		}
		expect(result.message).not.toHaveProperty("details");
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
		expect(
			(await loadHistory(forked.getSessionFile()!)).some(
				entry =>
					entry.type === "message" &&
					isSyntheticToolResultMessage(entry.message) &&
					entry.message.toolCallId === "toolu_sibling",
			),
		).toBe(false);
	});

	it("leaves an already-terminal tail with a completed tool call untouched when repair is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-terminal-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "settled-parent",
			timestamp,
			cwd,
		};
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_done", name: "bash", arguments: { command: "echo hi" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		const toolResult = {
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_done",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n${JSON.stringify(toolResult)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const forkedEntries = await loadHistory(forked.getSessionFile()!);
		const messageEntries = forkedEntries.filter(entry => entry.type === "message");
		expect(messageEntries).toHaveLength(2);
		expect(collectPendingToolCalls(forkedEntries)).toEqual([]);
		expect(forkedEntries.some(entry => entry.type === "message" && isSyntheticToolResultMessage(entry.message))).toBe(
			false,
		);
	});
	it("revokes persistCopy allocation when transcript publication fails", async () => {
		using tempDir = TempDir.createSync("@omp-copy-allocation-failure-");
		const source = SessionManager.inMemory(tempDir.path());
		source.appendMessage({ role: "user", content: "copy", timestamp: 1 });
		const storage = new FileSessionStorage();
		let failedPath: string | undefined;
		const original = storage.writeTextAtomic.bind(storage);
		const publish = spyOn(storage, "writeTextAtomic").mockImplementation(async (file, content, options) => {
			failedPath = file;
			await original(file, content, options);
			throw new Error("publication outcome unknown");
		});
		try {
			await expect(
				source.persistCopy({ sessionDir: tempDir.path(), suppressBreadcrumb: true }, storage),
			).rejects.toThrow(/publication outcome unknown/);
		} finally {
			publish.mockRestore();
		}
		if (!failedPath) throw new Error("Expected attempted publication.");
		const header = (await loadEntriesFromFile(failedPath))[0] as SessionHeader;
		await expect(
			registryDurableStateForSession(failedPath, { create: true, owningSessionId: header.id }),
		).rejects.toThrow(/allocation/i);
	});

	it("closes an attempted direct fork open and preserves initialization and cleanup errors", async () => {
		using tempDir = TempDir.createSync("@omp-direct-fork-cleanup-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		await manager.ensureOnDisk();
		const opening = new Error("unknown open");
		const cleanup = new Error("unknown cleanup");
		const open = spyOn(authority, "registryDurableStateForSession").mockRejectedValue(opening);
		const close = spyOn(authority, "closeSessionAuthority").mockRejectedValue(cleanup);
		try {
			let failure: unknown;
			try {
				await manager.fork();
			} catch (error) {
				failure = error;
			}
			expect(close).toHaveBeenCalledWith(manager.getSessionFile());
			expect(failure).toBeInstanceOf(AggregateError);
			if (!(failure instanceof AggregateError)) throw failure;
			expect(failure.errors).toEqual([opening, cleanup]);
		} finally {
			open.mockRestore();
			close.mockRestore();
			await manager.close();
		}
	});

	it("directly forks memory storage without filesystem authority or sidecars", async () => {
		using tempDir = TempDir.createSync("@omp-memory-direct-fork-");
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "memory"), storage);
		manager.appendMessage({ role: "user", content: "memory", timestamp: 1 });
		await manager.ensureOnDisk();
		const result = await manager.fork();
		if (!result) throw new Error("Expected persistent storage fork.");
		expect(await storage.readText(result.newSessionFile)).toContain("memory");
		expect(await Bun.file(result.newSessionFile).exists()).toBe(false);
		expect(await Bun.file(`${result.newSessionFile}.authority.lock`).exists()).toBe(false);
		await manager.close();
	});
	it("revokes the fresh allocation when fork authority initialization fails", async () => {
		using tempDir = TempDir.createSync("@omp-fork-allocation-failure-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());
		const forkFile = path.join(sessionDir, "failed-fork.jsonl");
		await fs.writeFile(`${forkFile}.authority.jsonl`, "unrelated", { mode: 0o600 });
		await expect(
			SessionManager.forkFrom(sourceFile, cwd, sessionDir, new FileSessionStorage(), {
				sessionFile: forkFile,
				copyArtifacts: false,
				suppressBreadcrumb: true,
			}),
		).rejects.toThrow();
		const header = (await loadEntriesFromFile(forkFile))[0] as SessionHeader;
		await fs.rm(`${forkFile}.authority.jsonl`);
		await expect(
			registryDurableStateForSession(forkFile, { owningSessionId: header.id, create: true }),
		).rejects.toThrow(/allocation/i);
	});
	it("forks root authority into a fresh incarnation without changing the source transcript", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-fork-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const owner = SessionManager.create(cwd, sessionDir);
		owner.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await owner.ensureOnDisk();
		const sourceFile = owner.getSessionFile()!;
		const sourceId = owner.getSessionId();
		const source = await registryDurableStateForSession(sourceFile, {
			owningSessionId: sourceId,
			backend: "jsonl",
			create: true,
		});
		const startupHash = canonicalDurableSha256("Main:startup");
		const provenanceHash = canonicalDurableSha256("Main:provenance");
		const headHash = durableRootHeadHash({
			rootId: "Main",
			generation: 1,
			actorId: "Main",
			startupHash,
			provenanceHash,
		});
		const construction = {
			kind: "construction" as const,
			at: 1,
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			startupHash,
			provenanceHash,
		};
		await source.transitionBatch(
			[
				{ ...construction, phase: "reserved" as const },
				{ ...construction, at: 2, phase: "constructing" as const },
				{ ...construction, at: 3, phase: "constructed" as const },
			],
			{ requestId: "fork-source-construction" },
		);
		await source.activateAuthority(
			{
				root: { kind: "root", at: 4, rootId: "Main", generation: 1, headHash, state: "active" },
				actor: {
					kind: "actor",
					at: 4,
					actorId: "Main",
					rootId: "Main",
					generation: 1,
					rootGeneration: 1,
					rootHeadHash: headHash,
					startupHash,
					provenanceHash,
					state: "active",
				},
				construction: { ...construction, at: 4, phase: "activated" },
				gate: { kind: "gate", at: 4, rootId: "Main", generation: 1, phase: "open" },
			},
			{ requestId: "fork-source-activation" },
		);
		await source.close();
		await owner.close();

		const sourceDescriptor = await readAuthorityDescriptor(sourceFile);
		if (!sourceDescriptor) throw new Error("Expected the source authority descriptor.");
		const sourceTranscript = await fs.readFile(sourceFile);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
			copyArtifacts: false,
		});
		try {
			const forkPath = forked.getSessionFile()!;
			const forkHeader = (await loadEntriesFromFile(forkPath))[0] as SessionHeader;
			const forkDescriptor = await readAuthorityDescriptor(forkPath);
			if (!forkDescriptor) throw new Error("Expected a fork authority descriptor.");
			expect(forkDescriptor.owningSessionId).toBe(forkHeader.id);
			expect(forkDescriptor.incarnation).not.toBe(sourceDescriptor.incarnation);
			expect(forkDescriptor.backend).toBe("jsonl");
			expect(await fs.readFile(sourceFile)).toEqual(sourceTranscript);
			const forkAuthority = await registryDurableStateForSession(forkPath, { owningSessionId: forkHeader.id });
			try {
				expect(await forkAuthority.getRoot("Main")).toBeUndefined();
				expect(await forkAuthority.getActor("Main")).toBeUndefined();
			} finally {
				await forkAuthority.close();
			}
			const sourceAuthority = await registryDurableStateForSession(sourceFile, { owningSessionId: sourceId });
			try {
				expect((await sourceAuthority.getRoot("Main"))?.record.state).toBe("active");
				expect((await sourceAuthority.getActor("Main"))?.record.state).toBe("active");
			} finally {
				await sourceAuthority.close();
			}
		} finally {
			await forked.close();
		}
	});
	it("moves the selected authority bundle with its persisted root session", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-move-");
		const cwd = path.join(tempDir.path(), "source-project");
		const targetCwd = path.join(tempDir.path(), "target-project");
		const sourceDir = path.join(tempDir.path(), "source-sessions");
		const targetDir = path.join(tempDir.path(), "target-sessions");
		await fs.mkdir(sourceDir, { recursive: true });
		const owner = SessionManager.create(cwd, sourceDir);
		owner.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await owner.ensureOnDisk();
		const sourceFile = owner.getSessionFile()!;
		const sourceId = owner.getSessionId();
		const source = await registryDurableStateForSession(sourceFile, {
			owningSessionId: sourceId,
			backend: "jsonl",
			create: true,
		});
		await source.close();
		await owner.close();
		const manager = await SessionManager.open(sourceFile, sourceDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			await manager.moveTo(targetCwd, targetDir);
			const targetFile = manager.getSessionFile()!;
			const targetDescriptor = await readAuthorityDescriptor(targetFile);
			if (!targetDescriptor) throw new Error("Expected a moved authority descriptor.");
			expect(targetDescriptor.owningSessionId).toBe(sourceId);
			expect(targetDescriptor.backend).toBe("jsonl");
			expect(await Bun.file(authorityPaths(sourceFile).descriptor).exists()).toBe(false);
			// The moved transcript names its new location, so adoption does not mistake it for a bundle-less copy.
			expect(await diskAuthorityRoot(targetFile)).toBe(await fs.realpath(targetFile));
		} finally {
			await manager.close();
		}
		const targetFile = manager.getSessionFile()!;
		const reopened = await registryDurableStateForSession(targetFile, { owningSessionId: sourceId });
		try {
			expect(reopened.identity.backend).toBe("jsonl");
		} finally {
			await closeSessionAuthority(targetFile);
		}
	});

	it("refuses to adopt a root transcript copied without its authority bundle, leaving the copy untouched", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-copy-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const copyDir = path.join(tempDir.path(), "copies");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.mkdir(copyDir, { recursive: true });
		const owner = SessionManager.create(tempDir.path(), sessionDir);
		owner.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await owner.ensureOnDisk();
		const sourceFile = owner.getSessionFile()!;
		const sourceId = owner.getSessionId();
		await registryDurableStateForSession(sourceFile, { owningSessionId: sourceId, backend: "jsonl", create: true });
		await closeSessionAuthority(sourceFile);
		await owner.close();
		expect(await diskAuthorityRoot(sourceFile)).toBe(await fs.realpath(sourceFile));

		const copy = path.join(copyDir, path.basename(sourceFile));
		await fs.copyFile(sourceFile, copy);
		const copied = await fs.readFile(copy);
		const outcome = await registryDurableStateForSession(copy, { owningSessionId: sourceId }).then(
			() => undefined,
			(error: unknown) => error,
		);
		await closeSessionAuthority(copy);
		expect(outcome).toBeInstanceOf(AuthorityAdoptionRefusedError);
		expect((outcome as AuthorityAdoptionRefusedError).command).toContain(await fs.realpath(sourceFile));
		expect(await fs.readdir(copyDir)).toEqual([path.basename(copy)]);
		expect(await fs.readFile(copy)).toEqual(copied);
		// The original, with its bundle, still resumes.
		const original = await registryDurableStateForSession(sourceFile, { owningSessionId: sourceId });
		try {
			expect(original.identity.backend).toBe("jsonl");
		} finally {
			await closeSessionAuthority(sourceFile);
		}
	});

	it("stamps every fork with its own path and never inherits the source's", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-fork-stamp-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const owner = SessionManager.create(tempDir.path(), sessionDir);
		owner.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await owner.ensureOnDisk();
		const sourceFile = owner.getSessionFile()!;
		await owner.close();
		const sourceStamp = await diskAuthorityRoot(sourceFile);
		expect(sourceStamp).toBe(await fs.realpath(sourceFile));

		const forked = await SessionManager.forkFrom(sourceFile, tempDir.path(), sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
			copyArtifacts: false,
		});
		const forkPath = forked.getSessionFile()!;
		try {
			expect(await diskAuthorityRoot(forkPath)).toBe(await fs.realpath(forkPath));
			const direct = await forked.fork();
			if (!direct) throw new Error("Expected a persisted direct fork.");
			expect(await diskAuthorityRoot(direct.newSessionFile)).toBe(await fs.realpath(direct.newSessionFile));
		} finally {
			await forked.close();
		}
		expect(await diskAuthorityRoot(forkPath)).not.toBe(sourceStamp);
	});

	it("stamps a child fork with its owning parent so it can never be adopted as a root", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-child-stamp-");
		const { cwd, sourceFile } = await createSessionWithArtifacts(tempDir.path());
		const parentFile = path.join(tempDir.path(), "sessions", "parent.jsonl");
		await Bun.write(
			parentFile,
			`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "parent", timestamp: new Date().toISOString(), cwd })}\n`,
		);
		for (const kind of ["seance", "childAgent"] as const) {
			const childFile = path.join(tempDir.path(), "children", `${kind}.jsonl`);
			const child = await SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
				[kind]: true,
				suppressBreadcrumb: true,
				sessionFile: childFile,
				authorityParent: parentFile,
			});
			await child.close();
			expect(await diskAuthorityRoot(childFile)).toBe(await fs.realpath(parentFile));
			const header = (await loadEntriesFromFile(childFile))[0] as SessionHeader;
			const outcome = await registryDurableStateForSession(childFile, { owningSessionId: header.id }).then(
				() => undefined,
				(error: unknown) => error,
			);
			await closeSessionAuthority(childFile);
			expect(outcome).toBeInstanceOf(AuthorityAdoptionRefusedError);
			for (const sidecar of Object.values(authorityPaths(childFile)).filter(file => file !== childFile)) {
				expect(await Bun.file(sidecar).exists()).toBe(false);
			}
		}
	});
});

/** The `authorityRoot` stamp in a transcript's on-disk session header. */
async function diskAuthorityRoot(file: string): Promise<string | undefined> {
	const header = (await loadEntriesFromFile(file)).find(entry => entry.type === "session") as
		| SessionHeader
		| undefined;
	return header?.authorityRoot;
}

describe("task subagent transcripts carry their owner's authority root", () => {
	async function persistedRoot(directory: string): Promise<{ rootFile: string; rootId: string }> {
		const sessionDir = path.join(directory, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const root = SessionManager.create(directory, sessionDir);
		root.appendMessage({ role: "user", content: "root", timestamp: 1 });
		await root.ensureOnDisk();
		const rootFile = root.getSessionFile()!;
		const rootId = root.getSessionId();
		await root.close();
		return { rootFile, rootId };
	}

	async function openChild(childFile: string, parentFile: string): Promise<string> {
		const child = await SessionManager.open(childFile, undefined, undefined, {
			parentSession: parentFile,
			authorityParent: parentFile,
			suppressBreadcrumb: true,
		});
		const id = child.getSessionId();
		await child.close();
		return id;
	}

	it("refuses resuming a subagent transcript directly and still resumes its parent", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-subagent-stamp-");
		const { rootFile, rootId } = await persistedRoot(tempDir.path());
		const childFile = path.join(tempDir.path(), "artifacts", "Probe.jsonl");
		const childId = await openChild(childFile, rootFile);
		expect(await diskAuthorityRoot(childFile)).toBe(await fs.realpath(rootFile));
		const outcome = await registryDurableStateForSession(childFile, { owningSessionId: childId }).then(
			() => undefined,
			(error: unknown) => error,
		);
		await closeSessionAuthority(childFile);
		expect(outcome).toBeInstanceOf(AuthorityAdoptionRefusedError);
		expect((outcome as AuthorityAdoptionRefusedError).command).toContain(await fs.realpath(rootFile));
		for (const sidecar of Object.values(authorityPaths(childFile)).filter(file => file !== childFile))
			expect(await Bun.file(sidecar).exists()).toBe(false);
		const parent = await registryDurableStateForSession(rootFile, { owningSessionId: rootId });
		try {
			expect(parent.identity.backend).toBe("jsonl");
		} finally {
			await closeSessionAuthority(rootFile);
		}
	});

	it("stamps a nested subagent with the top root, not its intermediate parent", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-nested-stamp-");
		const { rootFile } = await persistedRoot(tempDir.path());
		const childFile = path.join(tempDir.path(), "artifacts", "Child.jsonl");
		await openChild(childFile, rootFile);
		const grandchildFile = path.join(tempDir.path(), "artifacts", "Child", "Grandchild.jsonl");
		await openChild(grandchildFile, childFile);
		expect(await diskAuthorityRoot(grandchildFile)).toBe(await fs.realpath(rootFile));
	});

	it("keeps an existing child transcript's stamp when the subagent is reopened", async () => {
		using tempDir = TempDir.createSync("@omp-session-authority-reopen-stamp-");
		const { rootFile } = await persistedRoot(tempDir.path());
		const childFile = path.join(tempDir.path(), "artifacts", "Probe.jsonl");
		await openChild(childFile, rootFile);
		const reopened = await SessionManager.open(childFile, undefined, undefined, { suppressBreadcrumb: true });
		await reopened.close();
		expect(await diskAuthorityRoot(childFile)).toBe(await fs.realpath(rootFile));
	});
});
