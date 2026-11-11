/**
 * Reserved eval bridges answer to the session's subagent permission scope with the grant of the
 * registry tool they stand in for, before their handler runs.
 */
import { $ } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { enforceScope, scopedSettings } from "../task/permissions/scope-fixtures";

let temp: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-bridge-permissions-");
	setAgentDir(path.join(temp.path(), "agent"));
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	AgentStorage.close();
	temp.removeSync();
});

function session(settings: Settings): ToolSession {
	const id = `bridge-permissions-${crypto.randomUUID()}`;
	return {
		cwd: temp.path(),
		hasUI: false,
		skills: [],
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
	};
}

/** Writes a marker file, so a test can tell whether the command ran. */
function markerCommand(): { command: string; marker: string } {
	const marker = temp.join("ran.txt");
	return { command: `printf ran > '${marker}'; printf done`, marker };
}

describe("sh() bridge needs the bash grant", () => {
	it("refuses __shell__ when the scope does not grant bash, before the command runs", async () => {
		const { command, marker } = markerCommand();
		const settings = scopedSettings(enforceScope({ tools: ["eval", "read"] }));

		await expect(callSessionTool("__shell__", { command }, { session: session(settings) })).rejects.toThrow(
			"BLOCKED: Subagent permission profile does not allow tool 'bash'.",
		);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("refuses __shell__ when the scope denies bash", async () => {
		const { command, marker } = markerCommand();
		const settings = scopedSettings(enforceScope({ denyTools: ["bash"] }));

		await expect(callSessionTool("__shell__", { command }, { session: session(settings) })).rejects.toThrow(
			"BLOCKED: Subagent permission profile denied tool 'bash'.",
		);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("runs __shell__ when the scope grants bash", async () => {
		const { command, marker } = markerCommand();
		const settings = scopedSettings(enforceScope({ tools: ["eval", "bash", "read"] }));

		expect(await callSessionTool("__shell__", { command }, { session: session(settings) })).toEqual({
			output: "done",
			exitCode: 0,
		});
		expect(fs.readFileSync(marker, "utf8")).toBe("ran");
	});

	it("runs __shell__ under a suggest scope, which restricts nothing", async () => {
		const { command, marker } = markerCommand();
		const settings = scopedSettings(enforceScope({ mode: "suggest", tools: ["eval", "read"] }));

		await callSessionTool("__shell__", { command }, { session: session(settings) });
		expect(fs.readFileSync(marker, "utf8")).toBe("ran");
	});
});

describe("delegation and model bridges need the task grant", () => {
	const withoutTask = () => scopedSettings(enforceScope({ tools: ["eval", "bash", "read"] }));
	const TASK_REFUSAL = "BLOCKED: Subagent permission profile does not allow tool 'task'.";

	it("refuses __workpool__ before it looks the pool up", async () => {
		await expect(
			callSessionTool(
				"__workpool__",
				{ op: "push", name: "pool", items: ["x"] },
				{ session: session(withoutTask()) },
			),
		).rejects.toThrow(TASK_REFUSAL);
	});

	it("refuses __agent__ before it parses the request", async () => {
		await expect(callSessionTool("__agent__", {}, { session: session(withoutTask()) })).rejects.toThrow(TASK_REFUSAL);
	});

	it("refuses __completion__, __judge__ and __judge_batch__, which run models outside the agent's turn", async () => {
		for (const name of ["__completion__", "__judge__", "__judge_batch__"]) {
			await expect(callSessionTool(name, {}, { session: session(withoutTask()) })).rejects.toThrow(TASK_REFUSAL);
		}
	});

	it("keeps the bridges' own errors when the scope grants task", async () => {
		const settings = scopedSettings(enforceScope({ tools: ["eval", "bash", "read", "task"] }));

		await expect(
			callSessionTool("__workpool__", { op: "push", name: "pool", items: ["x"] }, { session: session(settings) }),
		).rejects.toThrow('unknown workpool "pool"');
	});
});

describe("bookkeeping bridges need no grant", () => {
	it("answers __budget__ and __status__ under a scope that grants only read", async () => {
		const settings = scopedSettings(enforceScope({ tools: ["read"] }));

		expect(await callSessionTool("__budget__", {}, { session: session(settings) })).toMatchObject({ total: null });
		await expect(
			callSessionTool("__status__", { item: { kind: "agent", id: "missing" } }, { session: session(settings) }),
		).rejects.toThrow("unknown agent handle missing");
	});
});

describe("bridge table and module load order", () => {
	const PACKAGE_ROOT = path.resolve(import.meta.dir, "../..");

	// agent-bridge and workpool-bridge import tool-bridge through their dependencies, so loading one
	// first evaluates tool-bridge before the bridge's own name constant exists. A fresh process is
	// the only way to control which module loads first; this file's own imports already loaded both.
	for (const first of ["agent-bridge", "workpool-bridge"]) {
		it(`dispatches a bridge call when ${first} is the first module loaded`, async () => {
			const code = [
				`import "./src/eval/${first}.ts";`,
				'const { callSessionTool } = await import("./src/eval/js/tool-bridge.ts");',
				'console.log(JSON.stringify(await callSessionTool("__budget__", {}, { session: { cwd: process.cwd() } })));',
			].join("\n");
			const result = await $`${process.execPath} --no-env-file -e ${code}`.cwd(PACKAGE_ROOT).quiet().nothrow();

			expect(result.stderr.toString()).not.toContain("before initialization");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({ total: null });
		});
	}
});
