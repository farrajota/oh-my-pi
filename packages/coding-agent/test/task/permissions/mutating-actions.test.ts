/**
 * A scope grants tools by name, but a call's effect depends on what it does:
 * - a multi-action tool (`lsp`, `github`, `debug`, `ida`) granted for its read actions cannot run its
 *   mutating ones (`rename`, `rename_file`, `code_actions`, `pr_checkout`, `launch`, ...) unless the
 *   scope also grants writing files;
 * - a `write` to `local://` needs a write grant: the scratch root is the parent's, shared by the tree;
 * - a `write` to `proc://` drives a service's stdin or kills it, which is execution: it needs `bash`,
 *   and path rules and guardrails refuse it as they refuse `bash`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp/tool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type ApprovalSubject, approvalRestrictions, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-mutating-");
});
afterEach(() => {
	tempDir.removeSync();
});

function decide(scope: PermissionScope, subject: (session: ToolSession) => ApprovalSubject, args: object) {
	const settings = scopedSettings(scope);
	const session: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
	return resolveApproval(
		subject(session),
		args,
		"yolo",
		{},
		undefined,
		approvalRestrictions(settings, tempDir.path()),
	);
}

const lsp = (session: ToolSession) => new LspTool(session);
const github = (session: ToolSession) => new GithubTool(session);
const write = (session: ToolSession) => new WriteTool(session);
const ida = () => ({
	name: "ida",
	approval: (args: unknown) =>
		((args as { action?: string }).action === "list" ? "read" : "write") as "read" | "write",
});

/** The built-in `read-only` profile's tools: "No edits, shell, ...". */
const readOnly = enforceScope({ tools: ["read", "grep", "find", "lsp", "hub"] });

describe("mutating actions of a tool granted by name", () => {
	it("refuses LSP actions that edit or move files under a scope without a write grant", () => {
		for (const args of [
			{ action: "rename_file", file: "src/a.ts", new_name: "src/b.ts" },
			{ action: "rename", file: "src/a.ts", line: 1, symbol: "a", new_name: "b" },
			{ action: "code_actions", file: "src/a.ts", line: 1, apply: true },
		]) {
			expect(decide(readOnly, lsp, args)).toMatchObject({ policy: "deny", source: "permission" });
		}
	});

	it("keeps LSP read actions, and the mutating ones once the scope grants writing files", () => {
		expect(decide(readOnly, lsp, { action: "definition", file: "src/a.ts", line: 1, symbol: "a" }).policy).not.toBe(
			"deny",
		);
		const editor = enforceScope({ tools: ["read", "edit", "lsp"] });
		expect(decide(editor, lsp, { action: "rename_file", file: "src/a.ts", new_name: "src/b.ts" }).policy).not.toBe(
			"deny",
		);
	});

	it("applies the same rule to github and ida", () => {
		const viewer = enforceScope({ tools: ["read", "github", "ida"] });
		expect(decide(viewer, github, { op: "pr_checkout", pr: "12" })).toMatchObject({ policy: "deny" });
		expect(decide(viewer, github, { op: "repo_view" }).policy).not.toBe("deny");
		expect(decide(viewer, ida, { action: "rename", db: "a.i64" })).toMatchObject({ policy: "deny" });
		expect(decide(viewer, ida, { action: "list" }).policy).not.toBe("deny");
	});
});

describe("local:// writes", () => {
	it("refuses a local:// write under a scope without a write grant", () => {
		const inspect = enforceScope({ tools: ["read", "grep", "find"] });
		expect(decide(inspect, write, { path: "local://plan.md", content: "x" })).toMatchObject({
			policy: "deny",
			source: "permission",
		});
	});

	it("allows it with a write grant, and keeps agent:// messaging and xd:// dispatch without one", () => {
		for (const tools of [
			["read", "write"],
			["read", "edit"],
		]) {
			expect(decide(enforceScope({ tools }), write, { path: "local://plan.md", content: "x" }).policy).not.toBe(
				"deny",
			);
		}
		const messenger = enforceScope({ tools: ["read", "hub"] });
		expect(decide(messenger, write, { path: "agent://Main", content: "status" }).policy).not.toBe("deny");
	});
});

describe("proc:// writes", () => {
	it("refuses driving or killing a service without an execution grant", () => {
		const editor = enforceScope({ tools: ["read", "write", "edit"] });
		for (const args of [
			{ path: "proc://svc/stdin", content: "cat ~/.aws/config\n" },
			{ path: "proc://svc/kill", content: "" },
		]) {
			expect(decide(editor, write, args)).toMatchObject({ policy: "deny", source: "permission" });
		}
	});

	it("refuses it under path rules even with bash granted, as it refuses bash", () => {
		const shell = enforceScope({ tools: ["read", "write", "bash"], allowPathGroups: [["."]] });
		expect(decide(shell, write, { path: "proc://svc/stdin", content: "ls\n" })).toMatchObject({
			policy: "deny",
			source: "permission",
		});
	});

	it("allows it to a scope that grants bash and has no path rules or guardrails", () => {
		const shell = enforceScope({ tools: ["read", "write", "bash"] });
		expect(decide(shell, write, { path: "proc://svc/stdin", content: "ls\n" }).policy).not.toBe("deny");
	});
});
