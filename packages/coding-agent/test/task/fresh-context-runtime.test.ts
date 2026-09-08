import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession, discoverContextFiles, discoverSkills } from "@oh-my-pi/pi-coding-agent/sdk";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

const tempRoots: string[] = [];
const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeRoots(): Promise<{ projectDir: string; agentDir: string; worktree: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fresh-child-"));
	tempRoots.push(root);
	const projectDir = path.join(root, "project");
	const agentDir = path.join(root, "child-agent");
	const worktree = path.join(root, "worktree");
	await Promise.all([
		fs.mkdir(projectDir, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(worktree, { recursive: true }),
	]);
	return { projectDir, agentDir, worktree };
}

describe("fresh child discovery identity", () => {
	test("discovers native user context and authored skills from an explicit child agentDir", async () => {
		const { projectDir, agentDir } = await makeRoots();
		await fs.writeFile(path.join(agentDir, "AGENTS.md"), "child native instructions\n");
		await fs.mkdir(path.join(agentDir, "skills", "child-skill"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "managed-skills", "child-managed"), { recursive: true });
		await Promise.all([
			fs.writeFile(
				path.join(agentDir, "skills", "child-skill", "SKILL.md"),
				"---\nname: child-skill\ndescription: authored by the child\n---\nUse the child skill.\n",
			),
			fs.writeFile(
				path.join(agentDir, "managed-skills", "child-managed", "SKILL.md"),
				"---\nname: child-managed\ndescription: managed by the child\n---\nUse the managed child skill.\n",
			),
		]);

		const contextFiles = await discoverContextFiles(projectDir, agentDir);
		const skills = await discoverSkills(projectDir, agentDir, {
			enablePiUser: true,
			enablePiProject: true,
		});

		expect(contextFiles.some(file => file.path === path.join(agentDir, "AGENTS.md"))).toBe(true);
		expect(skills.skills.some(skill => skill.name === "child-skill" && skill.filePath.startsWith(agentDir))).toBe(
			true,
		);
		expect(skills.skills.some(skill => skill.name === "child-managed" && skill.filePath.startsWith(agentDir))).toBe(
			true,
		);
	});

	test("constructs a session that rediscovers context and skills under child-owned roots", async () => {
		const { projectDir, agentDir } = await makeRoots();
		const extensionDir = path.join(path.dirname(projectDir), "explicit-extension");
		const ambientExtensionDir = path.join(path.dirname(projectDir), "ambient-extension");
		await Promise.all([
			fs.mkdir(path.join(agentDir, "skills", "child-session-skill"), { recursive: true }),
			fs.mkdir(path.join(extensionDir, "skills", "extension-session-skill"), { recursive: true }),
			fs.mkdir(path.join(ambientExtensionDir, "skills", "ambient-session-skill"), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(path.join(agentDir, "AGENTS.md"), "CHILD_SESSION_CONTEXT_SENTINEL\n"),
			fs.writeFile(
				path.join(agentDir, "skills", "child-session-skill", "SKILL.md"),
				"---\nname: child-session-skill\ndescription: child session skill\n---\nChild skill body.\n",
			),
			fs.writeFile(
				path.join(extensionDir, "skills", "extension-session-skill", "SKILL.md"),
				"---\nname: extension-session-skill\ndescription: extension session skill\n---\nExtension skill body.\n",
			),
			fs.writeFile(
				path.join(ambientExtensionDir, "skills", "ambient-session-skill", "SKILL.md"),
				"---\nname: ambient-session-skill\ndescription: ambient session skill\n---\nMust stay excluded.\n",
			),
		]);
		const authStorage = await AuthStorage.create(path.join(path.dirname(projectDir), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "test-key");
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");
		const settings = Settings.isolated({ extensions: [ambientExtensionDir] }, { cwd: projectDir, agentDir });
		let extensionRootReads = 0;
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			settings,
			model,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(projectDir),
			extensionRoots: () => {
				extensionRootReads += 1;
				return {
					explicit: [extensionDir],
					mode: "explicit-only",
					configured: [ambientExtensionDir],
					configuredLevel: "project",
				};
			},
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		expect(
			session.skills.some(skill => skill.name === "child-session-skill" && skill.filePath.startsWith(agentDir)),
		).toBe(true);
		expect(
			session.skills.some(
				skill => skill.name === "extension-session-skill" && skill.filePath.startsWith(extensionDir),
			),
		).toBe(true);
		expect(session.skills.some(skill => skill.name === "ambient-session-skill")).toBe(false);
		expect(extensionRootReads).toBe(1);
		const initialSystemPrompt = session.agent.state.systemPrompt.join("\n\n");
		expect(initialSystemPrompt).toContain("CHILD_SESSION_CONTEXT_SENTINEL");
		expect(initialSystemPrompt).not.toContain("PARENT_CONTEXT_SENTINEL");
	});

	test("isolated settings preserve explicit cwd and agentDir", async () => {
		const { projectDir, agentDir } = await makeRoots();
		const settings = Settings.isolated({}, { cwd: projectDir, agentDir });

		expect(settings.getCwd()).toBe(path.normalize(projectDir));
		expect(settings.getAgentDir()).toBe(path.normalize(agentDir));
	});

	test("fresh subagent settings use child cwd while retaining parent agentDir", async () => {
		const { projectDir, agentDir, worktree } = await makeRoots();
		const parent = Settings.isolated({}, { cwd: projectDir, agentDir });
		const child = createSubagentSettings(parent, undefined, undefined, { cwd: worktree });

		expect(child.getCwd()).toBe(path.normalize(worktree));
		expect(child.getAgentDir()).toBe(path.normalize(agentDir));
	});
});
