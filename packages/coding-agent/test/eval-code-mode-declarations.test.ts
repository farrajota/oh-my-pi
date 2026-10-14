import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { EvalTool, getEvalToolDescription } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { generateCodeModeDeclarations } from "@oh-my-pi/pi-tui/tools/eval-format/code-mode-declarations";
import { createArchivePrelude } from "../src/archive/prelude-definition";
import { computerPreludeAssets } from "../src/tools/computer/prelude-definition";

const prelude: EvalPreludeDefinition = {
	name: "fixture",
	documentation: "Fixture prelude.",
	javascript: "",
	python: "",
	exports: [],
	codeModeDeclarations: "declare const fixture: { run(): Promise<void> };",
	async invoke() {
		return { content: [] };
	},
};

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	const read = { name: "read", parameters: type({ path: "string" }) };
	const write = { name: "write", parameters: type({ path: "string", content: "string" }) };
	return {
		cwd: "/tmp/eval-code-mode-test",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionSpawns: () => "",
		toolRegistry: new Map([
			["read", read],
			["write", write],
		]),
		getCodeModeDirectToolNames: () => ["eval"],
		getEvalBridgeToolNames: () => ["eval", "read"],
		getEvalPreludes: () => [prelude],
		getAdvertisedEvalPreludes: () => [prelude],
		...overrides,
	} as unknown as ToolSession;
}

describe("generateCodeModeDeclarations", () => {
	test("emits typed signatures from tool schemas", () => {
		const declarations = generateCodeModeDeclarations([
			{
				name: "read",
				parameters: {
					type: "object",
					properties: { path: { type: "string" }, limit: { type: "number" } },
					required: ["path"],
				},
			},
			{
				name: "grep",
				parameters: {
					type: "object",
					properties: { pattern: { type: "string" }, case: { type: "boolean" } },
					required: ["pattern"],
				},
			},
		]);
		expect(declarations.split("\n")).toEqual([
			"  read(args: { path: string; limit?: number }): Promise<unknown>;",
			"  grep(args: { pattern: string; case?: boolean }): Promise<unknown>;",
		]);
	});

	test("preserves enum unions, quoted keys, and quoted tool names", () => {
		const declarations = generateCodeModeDeclarations([
			{
				name: "my-tool",
				parameters: {
					type: "object",
					properties: { "some-flag": { enum: ["on", "off"] } },
					required: ["some-flag"],
				},
			},
		]);
		expect(declarations).toContain('"my-tool"(args: { "some-flag": "on" | "off" }): Promise<unknown>;');
	});

	test("parenthesizes union item types and degrades unsupported schemas to unknown", () => {
		const declarations = generateCodeModeDeclarations([
			{
				name: "chmod",
				parameters: {
					type: "object",
					properties: { modes: { type: "array", items: { enum: ["read", "write"] } } },
					required: ["modes"],
				},
			},
			{ name: "weird", parameters: { allOf: [{ type: "string" }] } },
		]);
		expect(declarations).toContain('modes: ("read" | "write")[]');
		expect(declarations).toContain("weird(args: unknown): Promise<unknown>;");
	});
});

describe("EvalTool Code Mode description", () => {
	test("advertises only authorized bridged tools and their schema signatures", () => {
		const description = new EvalTool(makeSession()).description;
		expect(description).toContain("read(args: { path: string })");
		expect(description).not.toContain("write(args:");
		expect(description).toContain("declare const fixture: { run(): Promise<void> };");
		expect(getEvalToolDescription({ preludes: [prelude] })).not.toContain("declare const fixture");
	});

	test("omits tools that remain directly callable", () => {
		const description = new EvalTool(
			makeSession({
				getEvalBridgeToolNames: () => ["eval", "read", "write"],
				getCodeModeDirectToolNames: () => ["eval", "write"],
			}),
		).description;
		expect(description).toContain("read(args:");
		expect(description).not.toContain("write(args:");
	});

	test("uses the advertised prelude snapshot for declarations", () => {
		const description = new EvalTool(
			makeSession({ getAdvertisedEvalPreludes: () => [], getEvalPreludes: () => [prelude] }),
		).description;
		expect(description).not.toContain("declare const fixture");
	});
	test("removes prelude declarations after a non-snapshot prelude is disabled", () => {
		let enabled = true;
		const enabledPrelude: EvalPreludeDefinition = { ...prelude, enabled: () => enabled };
		const session = makeSession({
			getAdvertisedEvalPreludes: undefined,
			getEvalPreludes: () => [enabledPrelude],
		});
		const tool = new EvalTool(session);
		expect(tool.description).toContain("declare const fixture");
		enabled = false;
		expect(tool.description).not.toContain("declare const fixture");
	});

	test("withholds Code Mode transport support when JavaScript is disabled", () => {
		const session = makeSession({ settings: Settings.isolated({ "eval.js": false, "eval.py": true }) });
		expect(new EvalTool(session).supportsCodeModeTransport()).toBe(false);
	});

	test("advertises browser API declarations in active Code Mode", () => {
		const browser = createBrowserPrelude(makeSession());
		const description = new EvalTool(
			makeSession({ getEvalPreludes: () => [browser], getAdvertisedEvalPreludes: () => [browser] }),
		).description;
		expect(description).toContain("Codex Code Mode is active");
		expect(description).toContain("open(options?: BrowserOpenOptions): Promise<BrowserTab>");
		expect(description).toContain("tab(name?: string): BrowserTab");
	});
	test("retains computer and archive declaration assets", () => {
		expect(computerPreludeAssets.codeModeDeclarations).toContain("declare const computer");
		const archive = createArchivePrelude(makeSession());
		expect(archive.codeModeDeclarations).toContain("declare const archive");
		const description = new EvalTool(
			makeSession({ getEvalPreludes: () => [archive], getAdvertisedEvalPreludes: () => [archive] }),
		).description;
		expect(description).toContain("projects(options?: ArchiveOptions)");
	});
});
