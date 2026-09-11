/**
 * A/B caller-root resolution contracts for the internal URL tools.
 *
 * Two top-level roots (A and B) both contain a same-named parked `Worker`
 * (transcript + manager-published output). Bound callers provide the exact
 * registry/session root, so each lookup sees only its own root:
 *
 * - `history://Worker` serves the caller's transcript,
 * - `agent://Worker` serves the caller's published logical head,
 * - bare indexes/completion do not enumerate another root,
 * - a caller root with no resource fails closed,
 * - no caller session keeps the explicit contextless global display behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { expandInternalUrls } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

/** Transcript with a distinguishable user line: header + session_init + message. */
async function writeTranscriptWithLine(sessionFile: string, id: string, secret: string): Promise<void> {
	await Bun.write(
		sessionFile,
		`${[
			sessionHeader(id),
			JSON.stringify({
				type: "session_init",
				id: `si-${id}`,
				parentId: null,
				timestamp: "2026-08-13T17:14:49.000Z",
				systemPrompt: "review",
				task: `task-${secret}`,
				tools: ["read"],
			}),
			JSON.stringify({
				type: "message",
				id: `m-${id}`,
				parentId: null,
				timestamp: "2026-08-13T17:14:50.000Z",
				message: { role: "user", content: `secret-${secret}-line`, timestamp: 1 },
			}),
		].join("\n")}\n`,
	);
}

function makeSession(cwd: string, sessionFile: string | null = null, agentRegistry?: AgentRegistry): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		...(agentRegistry ? { agentRegistry } : {}),
	};
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * Lay out the A/B trees: both roots hold a same-named `Worker`. The caller's
 * session file is `rootA` unless a test overrides it.
 */
async function setupAbRoots(
	dir: string,
): Promise<{ rootA: string; rootB: string; artifactA: string; artifactB: string }> {
	const rootA = path.join(dir, "a", "main.jsonl");
	const rootB = path.join(dir, "b", "main.jsonl");
	const artifactA = path.join(dir, "a", "main", "Worker.md");
	const artifactB = path.join(dir, "b", "main", "Worker.md");
	await Bun.write(rootA, `${sessionHeader("a")}\n`);
	await Bun.write(rootB, `${sessionHeader("b")}\n`);
	await writeTranscriptWithLine(path.join(dir, "a", "main", "Worker.jsonl"), "worker", "A");
	await writeTranscriptWithLine(path.join(dir, "b", "main", "Worker.jsonl"), "worker", "B");
	await Promise.all([
		new ArtifactManager(path.dirname(artifactA)).publishAgentArtifacts("Worker", "A OUTPUT"),
		new ArtifactManager(path.dirname(artifactB)).publishAgentArtifacts("Worker", "B OUTPUT"),
	]);
	return { rootA, rootB, artifactA, artifactB };
}

/** Install the A/B trap: B's roster scan ran first AND the global Main ref is B. */
async function installGlobalMainB(registry: AgentRegistry, rootB: string): Promise<void> {
	await ensurePersistedRoster(registry, rootB);
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session: null,
		sessionFile: rootB,
		status: "running",
	});
}

describe("internal URL tools resolve against the caller root (A/B same ids)", () => {
	let dir: string;
	let rootA: string;
	let rootB: string;
	let artifactA: string;
	let artifactB: string;

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
		dir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "caller-root-ab-")));
		({ rootA, rootB, artifactA, artifactB } = await setupAbRoots(dir));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("grep history://Worker serves the caller root's transcript when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		const tool = new GrepTool(makeSession(dir, rootA, registry));
		const result = await tool.execute("grep-history-a", { pattern: "secret-A-line", path: "history://Worker" });
		const text = getResultText(result);
		expect(text).toContain("secret-A-line");
		expect(text).not.toContain("secret-B-line");

		const again = await tool.execute("grep-history-a-again", { pattern: "secret-A-line", path: "history://Worker" });
		expect(getResultText(again)).toContain("secret-A-line");
		const agent = await tool.execute("grep-agent-a", { pattern: "A OUTPUT", path: "agent://Worker" });
		expect(getResultText(agent)).toContain("A OUTPUT");
	});

	it("scopes bare history index and completion to the caller root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);
		await Bun.write(path.join(dir, "a", "main", "OnlyA.jsonl"), sessionHeader("only-a"));
		await Bun.write(path.join(dir, "b", "main", "OnlyB.jsonl"), sessionHeader("only-b"));
		const context = { agentRegistry: registry, sessionFile: rootA };
		const handler = new HistoryProtocolHandler();
		const index = await handler.resolve(parseInternalUrl("history://"), context);
		const completions = await handler.complete(undefined, context);
		expect(index.content).toContain("OnlyA");
		expect(index.content).not.toContain("OnlyB");
		expect(completions.map(entry => entry.value)).toContain("OnlyA");
		expect(completions.map(entry => entry.value)).not.toContain("OnlyB");
		const agentCompletions = (await InternalUrlRouter.instance().complete("agent", "", context)) ?? [];
		expect(agentCompletions.map(entry => entry.value)).not.toContain("Worker");
	});

	it("grep agent://Worker serves the caller root's output artifact when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		const tool = new GrepTool(makeSession(dir, rootA, registry));
		const result = await tool.execute("grep-agent-a", { pattern: "A OUTPUT", path: "agent://Worker" });
		expect(getResultText(result)).toContain("A OUTPUT");
		expect(getResultText(result)).not.toContain("B OUTPUT");
	});

	it("find history://Worker resolves the caller root's transcript file when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		const tool = new GlobTool(makeSession(dir, rootA, registry));
		const result = await tool.execute("find-history-a", { path: "history://Worker" });
		const text = getResultText(result);
		expect(text).toContain("# a/main/");
		expect(text).toContain("Worker.jsonl");
		expect(text).not.toContain("# b/main/");
	});

	it("bash agent:// expansion resolves the caller root's output path when the global Main is the other root", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);
		const expanded = await expandInternalUrls("cat agent://Worker", {
			skills: [],
			internalRouter: InternalUrlRouter.instance(),
			cwd: dir,
			sessionFile: rootA,
			agentRegistry: registry,
		});
		expect(expanded).toContain(artifactA);
		expect(expanded).not.toContain(artifactB);

		// No caller session file: keep the pre-existing global behavior (B's
		// Main-owned dir wins) instead of guessing a caller root.
		const noSession = await expandInternalUrls("cat agent://Worker", {
			skills: [],
			internalRouter: InternalUrlRouter.instance(),
			cwd: dir,
		});
		expect(noSession).toContain(artifactB);
		expect(noSession).not.toContain(artifactA);
	});

	it("switching the caller root switches which root's history and agent output win", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		// Caller A: A's refs replace B's and A's output wins.
		const toolA = new GrepTool(makeSession(dir, rootA, registry));
		const aHistory = await toolA.execute("grep-history-a", { pattern: "secret-A-line", path: "history://Worker" });
		expect(getResultText(aHistory)).toContain("secret-A-line");
		expect(getResultText(aHistory)).not.toContain("secret-B-line");
		const aAgent = await toolA.execute("grep-agent-a", { pattern: "A OUTPUT", path: "agent://Worker" });
		expect(getResultText(aAgent)).toContain("A OUTPUT");

		const toolB = new GrepTool(makeSession(dir, rootB, registry));
		const bHistory = await toolB.execute("grep-history-b", { pattern: "secret-B-line", path: "history://Worker" });
		expect(getResultText(bHistory)).toContain("secret-B-line");
		expect(getResultText(bHistory)).not.toContain("secret-A-line");
		const bAgent = await toolB.execute("grep-agent-b", { pattern: "B OUTPUT", path: "agent://Worker" });
		expect(getResultText(bAgent)).toContain("B OUTPUT");
		expect(getResultText(bAgent)).not.toContain("A OUTPUT");
	});
	it("fails closed when a caller root has no matching registry or disk resource", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		const rootC = path.join(dir, "c", "main.jsonl");
		const tool = new GrepTool(makeSession(dir, rootC, registry));
		await expect(
			tool.execute("grep-history-c", { pattern: "secret-B-line", path: "history://Worker" }),
		).rejects.toThrow("Unknown agent: Worker");
		await expect(tool.execute("grep-agent-c", { pattern: "B OUTPUT", path: "agent://Worker" })).rejects.toThrow(
			"No artifacts directory found",
		);
	});

	it("agent://Worker/<field> pairs the sidecar with the SAME root as the matched Worker.md", async () => {
		const registry = AgentRegistry.global();
		await installGlobalMainB(registry, rootB);

		// Root A has no sidecar; root B has one with a different payload. A's
		// caller must never answer with B's sidecar.
		await new ArtifactManager(path.join(dir, "a", "main")).publishAgentArtifacts(
			"Worker",
			JSON.stringify({ count: 1 }),
		);
		await new ArtifactManager(path.join(dir, "b", "main")).publishAgentArtifacts(
			"Worker",
			JSON.stringify({ count: 2 }),
			JSON.stringify({ count: 2 }),
		);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("agent://Worker/count", { sessionFile: rootA });
		expect(JSON.parse(resource.content)).toBe(1);
		expect(resource.sourcePath?.endsWith(path.join("a", "main", "Worker.md"))).toBe(true);
	});
});
