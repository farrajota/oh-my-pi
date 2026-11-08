import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	defaultJsEvalWorkerFactories,
	disposeAllVmContexts,
	setJsEvalWorkerFactoriesForTests,
} from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { Tool, ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";

const ENV_KEYS = ["PI_TOKEN", "OPENAI_API_KEY", "PI_RUNTIME_SMOKE"] as const;

function makeSession(cwd: string, evalSessionId: string): ToolSession {
	const base: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "eval.autoProvision": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => evalSessionId,
		getEvalSessionId: () => evalSessionId,
	};
	const tools: Tool[] = [new ReadTool(base)];
	return { ...base, getToolByName: name => tools.find(tool => tool.name === name) };
}

const PROBE = [
	"console.log(JSON.stringify({",
	'safe: process.env.PI_RUNTIME_SMOKE === "safe",',
	"credentialsAbsent: process.env.PI_TOKEN === undefined && process.env.OPENAI_API_KEY === undefined,",
	'bridged: (await tool.read({ path: "fixture.txt" })).text,',
	"}));",
].join("\n");

describe("JS eval worker environment", () => {
	const previous: Record<string, string | undefined> = {};
	let restoreFactories: (() => void) | undefined;

	afterEach(async () => {
		restoreFactories?.();
		restoreFactories = undefined;
		await disposeAllVmContexts();
		for (const key of ENV_KEYS) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	});

	it.each([
		{ worker: "subprocess", forceThread: false },
		{ worker: "Bun Worker fallback", forceThread: true },
	])(
		"drops inherited credentials from the $worker while keeping safe env and tool bridges",
		async ({ forceThread }) => {
			for (const key of ENV_KEYS) previous[key] = process.env[key];
			process.env.PI_TOKEN = "dummy-pi-token-sentinel";
			process.env.OPENAI_API_KEY = "dummy-openai-key-sentinel";
			process.env.PI_RUNTIME_SMOKE = "safe";
			if (forceThread) {
				restoreFactories = setJsEvalWorkerFactoriesForTests({
					spawnProcess: () => {
						throw new Error("subprocess spawn unavailable in this test");
					},
					spawnWorker: defaultJsEvalWorkerFactories.spawnWorker,
				});
			}
			using workspace = TempDir.createSync("@omp-js-worker-env-");
			await Bun.write(path.join(workspace.path(), "fixture.txt"), "bridge-ok");
			const sessionId = `js-worker-env:${crypto.randomUUID()}`;
			const session = makeSession(workspace.path(), sessionId);

			const result = await executeJs(PROBE, { cwd: workspace.path(), sessionId, session });

			expect(result.exitCode).toBe(0);
			expect(result.output).not.toContain("dummy-pi-token-sentinel");
			expect(result.output).not.toContain("dummy-openai-key-sentinel");
			expect(JSON.parse(result.output.trim())).toMatchObject({
				safe: true,
				credentialsAbsent: true,
				bridged: expect.stringContaining("bridge-ok"),
			});
		},
	);
});
