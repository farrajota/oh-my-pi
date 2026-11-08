/**
 * P5: a subagent under an enforce-restricted scope cannot write the agent directory (its sessions,
 * whose `session_init` records the scope revival restores, and config.yml) or the permission profile
 * files, whatever its scope otherwise allows. It can still write its `local://` scratch space and
 * message other agents through `agent://`. Design 7, step 17.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ApprovalSubject,
	approvalRestrictions,
	type ResolvedApproval,
	resolveApproval,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { LearnTool } from "@oh-my-pi/pi-coding-agent/tools/learn";
import { ManageSkillTool } from "@oh-my-pi/pi-coding-agent/tools/manage-skill";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";
import { createScopedSession } from "./scoped-session";

let tempDir: TempDir;
let agentDir: string;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-protected-");
	agentDir = tempDir.join("agent");
	fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
	fs.mkdirSync(tempDir.join(".omp"));
	fs.mkdirSync(tempDir.join("nested", ".omp"), { recursive: true });
	// The scope's settings take the agent dir at construction.
	setAgentDir(agentDir);
});

afterEach(() => {
	__resetDirsFromEnvForTests();
	tempDir.removeSync();
});

const writer = enforceScope({ tools: ["read", "write", "edit", "hub"] });

/** A write-tier tool that reports no approval targets, so the guard reads its path arguments. */
function writeTier(name: string): ApprovalSubject {
	return { name, approval: "write" };
}

function resolveIn(settings: Settings, subject: ApprovalSubject, args: Record<string, unknown>): ResolvedApproval {
	return resolveApproval(subject, args, "yolo", {}, undefined, approvalRestrictions(settings, tempDir.path()));
}

function write(target: string) {
	return { name: "write", arguments: { path: target, content: "tampered" } };
}

describe("protected paths under an enforce-restricted scope", () => {
	it("refuses writes into the agent dir and to permission profile files, and keeps other writes", async () => {
		fs.writeFileSync(path.join(agentDir, "config.yml"), "original\n");
		const scoped = await createScopedSession({
			tempDir,
			scope: writer,
			toolNames: ["read", "write", "edit"],
			calls: [
				write(path.join(agentDir, "config.yml")),
				write(path.join(agentDir, "sessions", "child.jsonl")),
				write(path.join(agentDir, "permissions.json")),
				write(".omp/permissions.json"),
				write(".omp/permissions.local.json"),
				write("nested/.omp/permissions.json"),
				write("local://notes.md"),
				write("work.txt"),
			],
		});
		try {
			await scoped.session.prompt("go");
			const results = scoped.toolResults();

			expect(results.slice(0, 6).map(result => [result.isError, result.text.startsWith("BLOCKED:")])).toEqual(
				Array.from({ length: 6 }, () => [true, true]),
			);
			expect(results[0]?.text).toContain("protected path");
			expect(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")).toBe("original\n");
			expect(fs.existsSync(path.join(agentDir, "sessions", "child.jsonl"))).toBe(false);
			expect(fs.existsSync(path.join(agentDir, "permissions.json"))).toBe(false);
			expect(fs.existsSync(tempDir.join(".omp", "permissions.json"))).toBe(false);
			expect(fs.existsSync(tempDir.join(".omp", "permissions.local.json"))).toBe(false);
			expect(fs.existsSync(tempDir.join("nested", ".omp", "permissions.json"))).toBe(false);

			expect(results[6]?.isError).toBe(false);
			expect(results[7]?.isError).toBe(false);
			expect(fs.readFileSync(tempDir.join("work.txt"), "utf8")).toBe("tampered");
		} finally {
			await scoped.dispose();
		}
	});

	it("refuses any write-tier tool on a protected path, and lets reads through", () => {
		const settings = scopedSettings(enforceScope({ tools: ["read", "edit", "ast_edit"] }));
		for (const name of ["edit", "ast_edit"]) {
			expect(resolveIn(settings, writeTier(name), { path: ".omp/permissions.json" })).toMatchObject({
				policy: "deny",
				source: "permission",
			});
		}
		expect(
			resolveIn(settings, { name: "read", approval: "read" }, { path: ".omp/permissions.json" }).policy,
		).not.toBe("deny");
	});

	it("refuses a write into the agent dir by its real path when the agent dir is a symlink", () => {
		const realAgentDir = tempDir.join("real-agent");
		fs.mkdirSync(realAgentDir);
		const linkedAgentDir = tempDir.join("linked-agent");
		fs.symlinkSync(realAgentDir, linkedAgentDir);
		setAgentDir(linkedAgentDir);
		const settings = scopedSettings(writer);

		expect(resolveIn(settings, writeTier("write"), { path: path.join(realAgentDir, "config.yml") })).toMatchObject({
			policy: "deny",
			source: "permission",
		});
	});

	it("still lets the child message another agent through agent://", () => {
		const decision = resolveIn(scopedSettings(writer), writeTier("write"), {
			path: "agent://Main",
			content: "need access to config",
		});

		expect(decision.policy).not.toBe("deny");
	});

	it("leaves the same writes to an unscoped session and to a suggest scope", () => {
		for (const settings of [
			Settings.isolated(),
			scopedSettings(enforceScope({ mode: "suggest", tools: ["read"] })),
		]) {
			const decision = resolveIn(settings, writeTier("write"), { path: path.join(agentDir, "config.yml") });
			expect(decision.policy).not.toBe("deny");
		}
	});

	it("refuses resolving a conflict whose registered file is a protected path", async () => {
		fs.writeFileSync(
			tempDir.join(".omp", "permissions.json"),
			'{\n<<<<<<< HEAD\n  "a": 1\n=======\n  "a": 2\n>>>>>>> branch\n}\n',
		);
		const settings = scopedSettings(writer);
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		// Reading the file is allowed and registers its conflict block as conflict://1.
		await new ReadTool(session).execute("read", { path: ".omp/permissions.json" });
		const write = new WriteTool(session);
		for (const target of ["conflict://1", "conflict://*", "src/a.ts:conflict://1"]) {
			const args = { path: target, content: "@theirs" };
			expect(resolveIn(settings, write, args)).toMatchObject({ policy: "deny", source: "permission" });
		}
	});

	it("refuses learn and manage_skill writes into the agent dir, which name no path", () => {
		// Path rules only, so no allowlist removes learn: the agent-dir write is what refuses it.
		const pathScoped = enforceScope({ allowPathGroups: [["src"]] });
		const skill = { action: "create", name: "deploy-notes", description: "when deploying", body: "steps" };
		for (const [settings, args] of [
			[scopedSettings(pathScoped, { "memory.backend": "hindsight" }), { memory: "lesson", skill }],
			[scopedSettings(pathScoped, { "memory.backend": "local" }), { memory: "lesson" }],
		] as const) {
			const session = {
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*" as const,
				settings,
			};
			expect(resolveIn(settings, new LearnTool(session), args)).toMatchObject({
				policy: "deny",
				source: "permission",
			});
		}
		const settings = scopedSettings(pathScoped);
		expect(
			resolveIn(settings, new ManageSkillTool(), { action: "create", name: "deploy-notes", body: "steps" }),
		).toMatchObject({
			policy: "deny",
			source: "permission",
		});
	});

	it("still lets learn store a lesson in a remote memory backend", () => {
		const settings = scopedSettings(enforceScope({ allowPathGroups: [["src"]] }), { "memory.backend": "hindsight" });
		const session = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*" as const,
			settings,
		};
		expect(resolveIn(settings, new LearnTool(session), { memory: "lesson" }).policy).not.toBe("deny");
	});

	it("refuses a profile file reached through a symlinked .omp folder, by either name", () => {
		const realFolder = tempDir.join("dotfiles-omp");
		fs.mkdirSync(realFolder);
		fs.rmSync(tempDir.join(".omp"), { recursive: true });
		fs.symlinkSync(realFolder, tempDir.join(".omp"));
		const settings = scopedSettings(writer);
		for (const target of [
			".omp/permissions.json",
			"dotfiles-omp/permissions.json",
			"dotfiles-omp/permissions.local.json",
		]) {
			expect(resolveIn(settings, writeTier("write"), { path: target })).toMatchObject({
				policy: "deny",
				source: "permission",
			});
		}
	});

	it("refuses the user profile file by its real path when it is a symlink out of the agent dir", () => {
		const realFile = tempDir.join("dotfiles-permissions.json");
		fs.writeFileSync(realFile, "{}\n");
		fs.symlinkSync(realFile, path.join(agentDir, "permissions.json"));
		const settings = scopedSettings(writer);
		expect(resolveIn(settings, writeTier("write"), { path: realFile })).toMatchObject({
			policy: "deny",
			source: "permission",
		});
	});

	it("refuses a write through a symlinked folder inside the agent dir that resolves outside it", () => {
		const dotfilesSkills = tempDir.join("dotfiles-skills");
		fs.mkdirSync(dotfilesSkills);
		fs.symlinkSync(dotfilesSkills, path.join(agentDir, "skills"));
		const settings = scopedSettings(writer);
		expect(
			resolveIn(settings, writeTier("write"), { path: path.join(agentDir, "skills", "deploy", "SKILL.md") }),
		).toMatchObject({ policy: "deny", source: "permission" });
	});
});
