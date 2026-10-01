/**
 * A child that finished and wrote its output, followed by a failure in a later
 * step (the isolation merge), still owes the parent its exit status and the
 * artifact. Without them the parent sees a bare error and redoes the work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resetAgentLifecycleForTests } from "../../src/internal/agent-lifecycle-bridge";
import { bindInternalAgentAuthoritySession, createAgentRootSession } from "../../src/internal/agent-registry-bridge";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

const authoritySessions: AgentSession[] = [];

/**
 * Fork contract: task execution runs only under a parent-bound agent registry
 * and authority session creator, so the parent session is a real registry root.
 */
async function createParentSession(cwd: string, settings: Settings): Promise<ToolSession> {
	const registry = new AgentRegistry();
	const root = await createAgentRootSession(registry, {
		agentId: "Main",
		agentDisplayName: "Main",
		cwd,
		agentDir: cwd,
		settings,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		toolNames: [],
		skipPythonPreflight: true,
	});
	const authority = bindInternalAgentAuthoritySession(registry, root.session);
	if (!authority) throw new Error("Test fixture requires parent authority");
	authoritySessions.push(root.session);
	const createAuthoritySession: NonNullable<ToolSession["createAuthoritySession"]> = (createOptions, reviveRef) =>
		authority.create(createOptions, reviveRef);
	return {
		cwd,
		hasUI: false,
		settings,
		agentRegistry: registry,
		createAuthoritySession,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	resetAgentLifecycleForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of authoritySessions.splice(0)) await session.dispose();
	resetAgentLifecycleForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	resetSettingsForTest();
});

describe("failed child evidence", () => {
	it("hands the parent the finished child's exit status and readable artifact when the merge throws", async () => {
		using tempDir = TempDir.createSync("@omp-failed-child-");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: tempDir.path(), stdout: "ignore" });
		git("init", "-q");
		await fs.writeFile(path.join(tempDir.path(), "README.md"), "seed\n");
		git("add", "README.md");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
		let artifactPath = "";
		let childArtifactsDir = "";
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions, agentId }) => {
			// The real isolation context was prepared; the checkout stops being a
			// git repository after the child finishes, so the merge step throws.
			await fs.rm(path.join(tempDir.path(), ".git"), { recursive: true, force: true });
			const artifactsDir = baseOptions.artifactsDir;
			if (!artifactsDir) throw new Error("artifactsDir missing");
			childArtifactsDir = artifactsDir;
			// Fork contract: agent:// discloses only outputs published as a
			// durable named head, which is how the real child publishes them.
			const published = await new ArtifactManager(artifactsDir).publishAgentArtifacts(agentId, "Findings: 42 rows.");
			artifactPath = published.outputPath;
			return {
				index: 0,
				id: agentId,
				agent: "worker",
				agentSource: "bundled",
				task: "Inspect the target.",
				exitCode: 0,
				output: "Findings: 42 rows.",
				stderr: "",
				truncated: false,
				durationMs: 3,
				tokens: 30,
				requests: 2,
				outputPath: artifactPath,
				patchPath: path.join(artifactsDir, `${agentId}.patch`),
			};
		});

		const tool = await TaskTool.create(
			await createParentSession(
				tempDir.path(),
				Settings.isolated({
					"task.isolation.enabled": true,
					"task.isolation.apply": true,
					"isolation.backend": "rcopy",
				}),
			),
		);
		const result = await tool.execute("tc-failed", {
			agent: "worker",
			task: "Inspect the target.",
			isolated: true,
		} as TaskParams);

		const text = result.content.find(part => part.type === "text");
		const salvaged = result.details?.results[0];
		expect(result.isError).toBe(true);
		expect(salvaged?.exitCode).toBe(0);
		expect(salvaged?.outputPath).toBe(artifactPath);
		expect(text?.type === "text" ? text.text : "").toContain(`exit 0. Its output is at \`agent://${salvaged?.id}\``);
		// The artifact the failure points at survives the run's cleanup.
		// Fork contract: a parent with no session file reads its children's
		// outputs as a bound caller that owns the run's artifacts dir.
		const resolved = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${salvaged?.id}`), {
			localProtocolOptions: { getArtifactsDir: () => childArtifactsDir },
		});
		expect(resolved.content).toBe("Findings: 42 rows.");
		await fs.rm(childArtifactsDir, { recursive: true, force: true });
	});
});
