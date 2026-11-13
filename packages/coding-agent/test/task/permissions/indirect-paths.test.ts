/**
 * Indirect routes to a tool's effect answer to the subagent permission scope as the direct call
 * would: eval prelude host calls, JS tool-bridge calls, eval `agent()` and `workpool()` spawns,
 * and `xd://` device dispatches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type EvalPreludeDefinition, getEnabledEvalPreludes, invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";
import { createScopedSession } from "./scoped-session";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-indirect-");
});
afterEach(() => {
	vi.restoreAllMocks();
	tempDir.removeSync();
});

function bareSession(settings: Settings, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...extra,
	} as ToolSession;
}

describe("eval prelude host calls", () => {
	function browserPrelude(invoke: EvalPreludeDefinition["invoke"]): EvalPreludeDefinition {
		return {
			name: "browser",
			documentation: "Browser",
			javascript: "globalThis.browser = {};",
			python: "browser = object()",
			exports: ["browser"],
			approval: "read",
			invoke,
		};
	}

	it("denies a browser call when the allowlist has eval but not browser", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({ content: [] }));
		const preludes = getEnabledEvalPreludes([browserPrelude(invoke)]);
		const session = bareSession(scopedSettings(enforceScope({ tools: ["eval", "read"] })), {
			getEvalPreludes: () => preludes,
		});

		await expect(invokeEvalPrelude("browser", {}, { session, toolCallId: "prelude-1" })).rejects.toThrow(
			"BLOCKED: Subagent permission profile does not allow tool 'browser'.",
		);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("runs a browser call the allowlist names", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({ content: [] }));
		const preludes = getEnabledEvalPreludes([browserPrelude(invoke)]);
		const session = bareSession(scopedSettings(enforceScope({ tools: ["eval", "browser"] })), {
			getEvalPreludes: () => preludes,
		});

		await invokeEvalPrelude("browser", {}, { session, toolCallId: "prelude-2" });
		expect(invoke).toHaveBeenCalledTimes(1);
	});
});

describe("JS tool bridge", () => {
	it("denies a bridged read of a denied path and runs one of an open path", async () => {
		fs.mkdirSync(tempDir.join("secret"));
		fs.writeFileSync(tempDir.join("secret", "key.txt"), "hidden\n");
		fs.writeFileSync(tempDir.join("open.txt"), "visible\n");
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ tools: ["read"], denyPathGroups: [["secret"]] }),
			toolNames: ["read"],
		});
		try {
			const session = bareSession(scoped.session.settings, {
				getToolForEvalBridge: name => scoped.session.getToolForEvalBridge(name),
			});

			await expect(callSessionTool("read", { path: "secret/key.txt" }, { session })).rejects.toThrow(
				"BLOCKED: Subagent permission profile denied path 'secret/key.txt'.",
			);
			expect(JSON.stringify(await callSessionTool("read", { path: "open.txt" }, { session }))).toContain("visible");
		} finally {
			await scoped.dispose();
		}
	});
});

describe("delegation from eval", () => {
	const noDelegation = () => scopedSettings(enforceScope({ profiles: ["no-delegation"], denyTools: ["task"] }));

	it("refuses agent() from a no-delegation scope", async () => {
		await expect(
			callSessionTool("__agent__", { prompt: "do work" }, { session: bareSession(noDelegation()) }),
		).rejects.toThrow("BLOCKED: Subagent permission profile denied tool 'task'.");
	});

	it("refuses workpool() from a no-delegation scope", async () => {
		await expect(
			callSessionTool("__workpool__", { op: "create", name: "pool" }, { session: bareSession(noDelegation()) }),
		).rejects.toThrow("BLOCKED: Subagent permission profile denied tool 'task'.");
	});

	it("refuses agent() from an allowlist without task", async () => {
		await expect(
			callSessionTool(
				"__agent__",
				{ prompt: "do work" },
				{ session: bareSession(scopedSettings(enforceScope({ tools: ["eval", "read"] }))) },
			),
		).rejects.toThrow("BLOCKED: Subagent permission profile does not allow tool 'task'.");
	});
});

describe("xd:// device dispatch", () => {
	it("checks a device dispatch against the device tool's name", async () => {
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ tools: ["read", "write"] }),
			toolNames: ["read", "write", "bash"],
			settings: { "tools.xdev": true },
			calls: [{ name: "write", arguments: { path: "xd://bash", content: JSON.stringify({ command: "echo hi" }) } }],
		});
		try {
			await scoped.session.sendUserMessage("run it");
			const [result] = scoped.toolResults();
			expect(result?.isError).toBe(true);
			expect(result?.text).toContain("BLOCKED: Subagent permission profile does not allow tool 'bash'.");
		} finally {
			await scoped.dispose();
		}
	});

	it("checks a device dispatch against a device the scope denies by name", async () => {
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ denyTools: ["bash"] }),
			toolNames: ["read", "write", "bash"],
			settings: { "tools.xdev": true },
			calls: [{ name: "write", arguments: { path: "xd://bash", content: JSON.stringify({ command: "echo hi" }) } }],
		});
		try {
			await scoped.session.sendUserMessage("run it");
			const [result] = scoped.toolResults();
			expect(result?.isError).toBe(true);
			expect(result?.text).toContain("BLOCKED: Subagent permission profile denied tool 'bash'.");
		} finally {
			await scoped.dispose();
		}
	});
});
