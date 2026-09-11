import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];
const LARGE_SESSION_BYTES = 9 * 1024 * 1024;

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

class LargeFileSessionStorage extends FileSessionStorage {
	override statSync(filePath: string) {
		return { ...super.statSync(filePath), size: LARGE_SESSION_BYTES };
	}
	override async readText(): Promise<string> {
		throw new Error("Large sessions must stream");
	}
}

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("SessionManager.peekSessionInit", () => {
	it("returns the latest session_init capability contract and the header cwd", async () => {
		const cwd = makeTempDir("@pi-peek-cwd-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendSessionInit({ systemPrompt: "first", task: "t1", tools: ["read"], spawns: "" });
		manager.appendSessionInit({
			systemPrompt: "second",
			task: "t2",
			tools: ["read", "bash", "yield"],
			spawns: "task",
			readSummarize: false,
			restrictToolNames: true,
			enableMCP: true,
			requestedPermissionProfiles: ["no-network", "focused-edit"],
			effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
		});
		// Flush buffered entries (header + inits) so the lock-free peek can read them off disk.
		manager.appendMessage(assistantMessage("flush"));

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.cwd).toBe(manager.getCwd());
		// Latest init wins — the reviver must rebuild from the most recent contract.
		expect(peek?.init?.systemPrompt).toBe("second");
		expect(peek?.init?.tools).toEqual(["read", "bash", "yield"]);
		expect(peek?.init?.spawns).toBe("task");
		expect(peek?.init?.readSummarize).toBe(false);
		expect(peek?.init?.restrictToolNames).toBe(true);
		expect(peek?.init?.enableMCP).toBe(true);
		expect(peek?.init?.requestedPermissionProfiles).toEqual(["no-network", "focused-edit"]);
		expect(peek?.init?.effectivePermissionProfiles).toEqual(["read-only", "no-network", "focused-edit"]);
	});

	it("bounds and freezes hostile persisted permission summaries", async () => {
		const cwd = makeTempDir("@pi-peek-permission-summary-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		const hostileSummary = {
			mode: "enforce",
			profiles: { items: Array.from({ length: 20 }, (_, index) => `profile-${index}`), omittedCount: 2 },
			clauses: { items: [], omittedCount: 0 },
			denyTools: { items: Array.from({ length: 40 }, (_, index) => `tool-${index}`), omittedCount: 0 },
			denyPaths: { items: ["https://user:secret@example.test/root?token=hidden"], omittedCount: 0 },
			guardrails: { noNetwork: true, secretsBlind: true },
			intrinsicTools: { yield: true, reportToolIssue: false },
			recentDenials: {
				items: Array.from({ length: 70 }, (_, index) => ({
					kind: "subagent_permission_denial",
					code: "tool-deny",
					tool: `tool-${index}`,
					targets: { items: [], omittedCount: 0 },
					matched: "subagent:tool-deny",
					reason: "blocked",
				})),
				omittedCount: 4,
			},
		};
		manager.appendSessionInit({
			systemPrompt: "summary",
			task: "task",
			tools: ["read"],
			permissionSummary: hostileSummary as never,
		});
		manager.appendMessage(assistantMessage("flush"));

		const summary = (await SessionManager.peekSessionInit(sessionFile))?.init?.permissionSummary;
		expect(summary?.profiles.items).toEqual(hostileSummary.profiles.items.slice(0, 16));
		expect(summary?.profiles.omittedCount).toBe(6);
		expect(summary?.denyTools.items).toHaveLength(32);
		expect(summary?.denyTools.omittedCount).toBe(8);
		expect(summary?.denyPaths.items).toEqual(["https://example.test/root"]);
		expect(summary?.recentDenials.items).toHaveLength(64);
		expect(summary?.recentDenials.omittedCount).toBe(10);
		expect(Object.isFrozen(summary?.recentDenials.items[0]?.targets.items)).toBe(true);
	});

	it("restores the latest valid permission summary update after session init", async () => {
		const cwd = makeTempDir("@pi-peek-permission-update-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		const baseline = {
			mode: "enforce",
			profiles: { items: ["focused-edit"], omittedCount: 0 },
			clauses: { items: [], omittedCount: 0 },
			denyTools: { items: [], omittedCount: 0 },
			denyPaths: { items: [], omittedCount: 0 },
			guardrails: { noNetwork: false, secretsBlind: false },
			intrinsicTools: { yield: true, reportToolIssue: false },
			recentDenials: { items: [], omittedCount: 0 },
		};
		manager.appendSessionInit({
			systemPrompt: "summary",
			task: "task",
			tools: ["read"],
			permissionSummary: baseline as never,
		});
		manager.appendPermissionSummaryUpdate({
			...baseline,
			recentDenials: {
				items: [
					{
						kind: "subagent_permission_denial",
						code: "tool-deny",
						tool: "write",
						targets: { items: [], omittedCount: 0 },
						matched: "subagent:tool-deny:write",
						reason: "blocked",
					},
				],
				omittedCount: 0,
			},
		} as never);
		manager.appendMessage(assistantMessage("flush"));

		const summary = (await SessionManager.peekSessionInit(sessionFile))?.init?.permissionSummary;
		expect(summary?.recentDenials.items[0]?.code).toBe("tool-deny");
		expect(Object.isFrozen(summary?.recentDenials.items)).toBe(true);
	});

	it("streams large file-backed sessions without a full read", async () => {
		const cwd = makeTempDir("@pi-peek-stream-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendSessionInit({ systemPrompt: "first", task: "task", tools: ["read"], spawns: "" });
		manager.appendSessionInit({ systemPrompt: "second", task: "task", tools: ["read"], spawns: "" });
		manager.appendMessage(assistantMessage("journal tail"));

		const peek = await SessionManager.peekSessionInit(sessionFile, new LargeFileSessionStorage());
		expect(peek?.cwd).toBe(manager.getCwd());
		expect(peek?.init?.systemPrompt).toBe("second");
	});

	it("preserves non-file storage behavior", async () => {
		const cwd = makeTempDir("@pi-peek-memory-");
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		manager.appendSessionInit({ systemPrompt: "first", task: "task", tools: ["read"], spawns: "" });
		manager.appendSessionInit({ systemPrompt: "second", task: "task", tools: ["read"], spawns: "" });
		manager.appendMessage(assistantMessage("journal tail"));

		const peek = await SessionManager.peekSessionInit(sessionFile, storage);
		expect(peek?.cwd).toBe(manager.getCwd());
		expect(peek?.init?.systemPrompt).toBe("second");
	});

	it("returns init: null for a session file with no session_init (a main/legacy session)", async () => {
		const cwd = makeTempDir("@pi-peek-legacy-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		manager.appendMessage(assistantMessage("hi"));

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.cwd).toBe(manager.getCwd());
		expect(peek?.init).toBeNull();
	});

	it("returns null when the first entry is not a session header", async () => {
		const file = path.join(makeTempDir("@pi-peek-invalid-header-"), "invalid.jsonl");
		const content = [
			{
				type: "session_init",
				id: "invalid-first",
				parentId: null,
				timestamp: "2026-08-15T00:00:00.000Z",
				systemPrompt: "invalid",
				task: "task",
				tools: [],
			},
			{
				type: "session",
				version: 3,
				id: "late-header",
				timestamp: "2026-08-15T00:00:00.000Z",
				cwd: "/wrong",
			},
			{
				type: "session_init",
				id: "late-init",
				parentId: "late-header",
				timestamp: "2026-08-15T00:00:00.000Z",
				systemPrompt: "late",
				task: "task",
				tools: [],
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n");
		await Bun.write(file, `${content}\n`);

		expect(await SessionManager.peekSessionInit(file)).toBeNull();
		expect(await SessionManager.peekSessionInit(file, new LargeFileSessionStorage())).toBeNull();
	});

	it("returns null for a file that cannot be read", async () => {
		const peek = await SessionManager.peekSessionInit(path.join(makeTempDir("@pi-peek-missing-"), "nope.jsonl"));
		expect(peek).toBeNull();
	});
});
