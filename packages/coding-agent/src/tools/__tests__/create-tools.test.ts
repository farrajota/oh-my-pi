import { describe, expect, test, vi } from "bun:test";
import { Settings } from "../../config/settings";
import type { SettingPath } from "../../config/settings-schema";
import * as pyKernel from "../../eval/py/kernel";
import { createTools, type ToolSession } from "../index";

function makeSession(
	overrides: Partial<ToolSession> = {},
	settingOverrides: Partial<Record<SettingPath, unknown>> = {},
): ToolSession {
	const settings = Settings.isolated({
		"astGrep.enabled": true,
		"astEdit.enabled": true,
		"bash.enabled": true,
		"browser.enabled": true,
		"debug.enabled": true,
		"dev.autoqa": false,
		"eval.js": true,
		"eval.py": true,
		"glob.enabled": true,
		"grep.enabled": true,
		"inspect_image.enabled": true,
		"lsp.enabled": true,
		"task.maxRecursionDepth": 0,
		"web_search.enabled": true,
		...settingOverrides,
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => "create-tools-test",
		getEvalSessionId: () => "create-tools-eval-test",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		...overrides,
	} as ToolSession;
}

async function namesFor(
	toolNames?: string[],
	sessionOverrides?: Partial<ToolSession>,
	settingOverrides?: Partial<Record<SettingPath, unknown>>,
) {
	const tools = await createTools(makeSession(sessionOverrides, settingOverrides), toolNames);
	return tools.map(tool => tool.name);
}

describe("createTools explicit tool lists", () => {
	test("default tools include current essential built-ins", async () => {
		const names = await namesFor(undefined);

		expect(names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "glob", "eval"]));
	});

	test("an explicit empty tool list excludes agent-authored built-ins and resolve", async () => {
		const names = await namesFor([]);

		expect(names).not.toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "glob", "eval", "resolve"]));
	});

	test("an explicit empty tool list includes yield only when the session requires it", async () => {
		expect(await namesFor([])).not.toContain("yield");
		expect(await namesFor([], { requireYieldTool: true })).toContain("yield");
	});

	test("autoQA still injects report_tool_issue into an explicit empty tool list", async () => {
		const names = await namesFor([], undefined, { "dev.autoqa": true });

		expect(names).toContain("report_tool_issue");
	});

	test("an explicit empty tool list does not invoke Python eval preflight when JS eval is disabled", async () => {
		const pythonSpy = vi.spyOn(pyKernel, "checkPythonKernelAvailability");

		await namesFor([], undefined, { "eval.js": false, "eval.py": true });

		expect(pythonSpy).not.toHaveBeenCalled();
		pythonSpy.mockRestore();
	});
});
