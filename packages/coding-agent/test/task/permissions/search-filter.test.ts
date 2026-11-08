/**
 * Recursive search under a subagent scope: the approval guard sees only the search root, so grep,
 * glob, find and ast_grep drop every entry the scope's deny paths or secrets-blind would refuse, and
 * still return the rest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { JudgmentRequest, JudgmentResult, NoulAnswer, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import { enforceScope, scopedSettings } from "./scope-fixtures";

let temp: TempDir;

beforeEach(() => {
	temp = TempDir.createSync("@omp-scope-search-");
	const files: Record<string, string> = {
		"src/app.ts": "export const token = 1;\n",
		"restricted/keys.ts": "export const token = 2;\n",
		"credentials/db.ts": "export const token = 3;\n",
		".env": "token=4\n",
	};
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(temp.join(...name.split("/").slice(0, -1)), { recursive: true });
		fs.writeFileSync(temp.join(...name.split("/")), content);
	}
});
afterEach(() => {
	vi.restoreAllMocks();
	temp.removeSync();
});

const denyRestricted = () => enforceScope({ denyPathGroups: [["restricted"]] });
const secretsBlind = () => enforceScope({ guardrails: { noNetwork: false, secretsBlind: true } });

function session(settings: Settings): ToolSession {
	return {
		cwd: temp.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
	} as ToolSession;
}

function text(result: AgentToolResult<unknown>): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

/** Each file has a unique basename; outputs group files under directory headers. */
const cases: { scope: () => PermissionScope; label: string; hidden: string[]; shown: string[] }[] = [
	{
		label: "deny paths",
		scope: denyRestricted,
		hidden: ["keys.ts"],
		shown: ["app.ts", "db.ts"],
	},
	{
		label: "secrets-blind",
		scope: secretsBlind,
		hidden: ["db.ts", ".env"],
		shown: ["app.ts", "keys.ts"],
	},
];

describe.each(cases)("search results under $label", ({ scope, hidden, shown }) => {
	it("grep omits refused files and keeps the rest", async () => {
		const output = text(await new GrepTool(session(scopedSettings(scope()))).execute("grep", { pattern: "token" }));
		for (const name of shown) expect(output).toContain(name);
		for (const name of hidden) expect(output).not.toContain(name);
	});

	it("glob omits refused entries and keeps the rest", async () => {
		const output = text(await new GlobTool(session(scopedSettings(scope()))).execute("glob", { path: "**/*" }));
		for (const name of shown) expect(output).toContain(name);
		for (const name of hidden) expect(output).not.toContain(name);
	});

	it("ast_grep omits refused files and keeps the rest", async () => {
		const output = text(
			await new AstGrepTool(session(scopedSettings(scope()))).execute("ast", { pat: "export const $X = $Y" }),
		);
		for (const name of shown) expect(output).toContain(name);
		for (const name of hidden.filter(name => name.endsWith(".ts"))) expect(output).not.toContain(name);
	});

	it("find never shows a refused file to the judge or in its hits", async () => {
		const judged: string[] = [];
		vi.spyOn(ChainJudge.prototype, "judge").mockImplementation(
			async <Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> => {
				judged.push(JSON.stringify(request));
				const answers: Record<string, NoulAnswer> = {};
				for (const key in request.questions) answers[key] = { type: "noul", noul: 0.9 };
				return {
					api: "typesafe",
					provider: "fake",
					model: "fake",
					answers: answers as JudgmentResult<Q>["answers"],
					usage: tokenUsage(100, 0, 0.001),
				};
			},
		);
		const tool = new FindTool(session(scopedSettings(scope(), { "find.enabled": "on" })));

		const output = text(await tool.execute("find", { query: "exported token constant", grep_keywords: ["token"] }));

		expect(output).toContain("app.ts");
		for (const name of hidden) {
			expect(output).not.toContain(name);
			expect(judged.join("\n")).not.toContain(name);
		}
	});
});

describe("search results without an enforce scope", () => {
	it("grep keeps every match under a suggest scope", async () => {
		const suggest = enforceScope({ mode: "suggest", denyPathGroups: [["restricted"]] });
		const output = text(await new GrepTool(session(scopedSettings(suggest))).execute("grep", { pattern: "token" }));
		expect(output).toContain("keys.ts");
	});
});

describe("ast_edit under a permission scope", () => {
	it("previews and applies rewrites only to the files the scope permits", async () => {
		const pending: Array<(input: unknown) => Promise<AgentToolResult<unknown>>> = [];
		const tool = new AstEditTool({
			...session(scopedSettings(denyRestricted())),
			getToolChoiceQueue: () =>
				({
					registerPendingInvoker: (
						_id: string,
						_tool: string,
						invoke: (input: unknown) => Promise<AgentToolResult<unknown>>,
					) => pending.push(invoke),
					removePendingInvoker: () => {},
				}) as never,
		} as ToolSession);

		const preview = text(
			await tool.execute("edit", {
				ops: [{ pat: "export const token = $V", out: "export const token = 0" }],
				paths: ["."],
			}),
		);
		expect(preview).toContain("app.ts");
		expect(preview).not.toContain("keys.ts");

		expect(pending).toHaveLength(1);
		await pending[0]!({ action: "apply", reason: "apply the rewrite" });
		expect(fs.readFileSync(temp.join("src", "app.ts"), "utf8")).toStartWith("export const token = 0");
		expect(fs.readFileSync(temp.join("restricted", "keys.ts"), "utf8")).toBe("export const token = 2;\n");
	});
});

describe("parse diagnostics under a permission scope", () => {
	beforeEach(() => {
		fs.writeFileSync(temp.join("restricted", "broken.ts"), "export const = = ;\n");
		fs.writeFileSync(temp.join("src", "torn.ts"), "export const = = ;\n");
	});

	it("ast_grep does not name a refused file in its parse errors", async () => {
		const output = text(
			await new AstGrepTool(session(scopedSettings(denyRestricted()))).execute("ast", {
				pat: "export const $X = $Y",
			}),
		);
		expect(output).toContain("torn.ts");
		expect(output).not.toContain("broken.ts");
	});

	it("ast_edit does not name a refused file in its parse errors", async () => {
		const output = text(
			await new AstEditTool(session(scopedSettings(denyRestricted()))).execute("edit", {
				ops: [{ pat: "export const token = $V", out: "export const token = 0" }],
				paths: ["."],
			}),
		);
		expect(output).toContain("torn.ts");
		expect(output).not.toContain("broken.ts");
	});
});
