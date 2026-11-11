import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let temp: TempDir;
let settingsState: SettingsTestState;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-shell-helper-");
	setAgentDir(path.join(temp.path(), "agent"));
	await fs.mkdir(path.join(temp.path(), "sub"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	AgentStorage.close();
	temp.removeSync();
});

/** A session whose `bash` tool would auto-background anything slower than 10 ms; `sh` must not. */
function makeSession(): ToolSession {
	const id = `shell-helper-${crypto.randomUUID()}`;
	return {
		cwd: temp.path(),
		hasUI: false,
		skills: [],
		settings: Settings.isolated({
			"eval.autoProvision": false,
			"bash.autoBackground.enabled": true,
			"bash.autoBackground.thresholdMs": 10,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
	};
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

const CELLS = {
	js: [
		"const quoted = await sh`sleep 0.2; printf '%s|' ${['a b', \"c'd\"]} ${'$HOME'}`;",
		"await sh('cd sub');",
		"const cwd = [(await sh('pwd -P')).trim(), (await sh('pwd -P', { cwd: 'sub' })).trim()];",
		"let failure;",
		"try { await sh('echo boom; exit 3'); } catch (error) { failure = { name: error.name, code: error.exitCode, output: error.output }; }",
		"print('RESULT ' + JSON.stringify({ quoted, cwd, failure }));",
	].join("\n"),
	py: [
		"import json",
		"quoted = sh(\"sleep 0.2; printf '%s|' 'a b' $(echo nested)\")",
		'sh("cd sub")',
		'cwd = [sh("pwd -P").strip(), sh("pwd -P", cwd="sub").strip()]',
		"try:",
		'    sh("echo boom; exit 3")',
		"except ShellError as error:",
		'    failure = {"name": type(error).__name__, "code": error.exit_code, "output": error.output}',
		'print("RESULT " + json.dumps({"quoted": quoted, "cwd": cwd, "failure": failure}))',
	].join("\n"),
};

async function runCell(language: "js" | "py"): Promise<Record<string, unknown>> {
	const result = await new EvalTool(makeSession()).execute("call", { language, code: CELLS[language], timeout: 60 });
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
	const line = text.split("\n").find(entry => entry.startsWith("RESULT "));
	if (!line) throw new Error(`no RESULT line in eval output:\n${text}`);
	return JSON.parse(line.slice("RESULT ".length));
}

describe("eval sh helper", () => {
	it("js: quotes template values, starts each command in the session cwd or `cwd`, and throws ShellError without backgrounding", async () => {
		const result = await runCell("js");
		const root = await fs.realpath(temp.path());
		expect(result).toEqual({
			quoted: "a b|c'd|$HOME|",
			cwd: [root, path.join(root, "sub")],
			failure: { name: "ShellError", code: 3, output: "boom\n" },
		});
	});

	it("js: hides secret-shaped host variables from sh() but keeps ordinary ones", async () => {
		// Host secrets reach the native shell through the environment the process
		// started with (`std::env::vars_os()` plus the captured shell env). Writing
		// `process.env` here reaches neither once the shell config is cached, so the
		// probe runs the cell in a child whose startup env carries both variables.
		const names = { secret: "OMP_SH_PROBE_API_KEY", plain: "OMP_SH_PROBE_PLAIN" };
		const code = [
			`const secret = await sh('printf %s "\${${names.secret}-unset}"');`,
			`const plain = await sh('printf %s "\${${names.plain}-unset}"');`,
			"print('RESULT ' + JSON.stringify({ secret, plain }));",
		].join("\n");
		const src = (file: string) => JSON.stringify(path.join(import.meta.dir, "../../src", file));
		const script = path.join(temp.path(), "secret-probe.ts");
		await Bun.write(
			script,
			[
				`import { setAgentDir } from ${JSON.stringify(Bun.resolveSync("@oh-my-pi/pi-utils", import.meta.dir))};`,
				`import { Settings } from ${src("config/settings.ts")};`,
				`import { disposeAllVmContexts } from ${src("eval/js/context-manager.ts")};`,
				`import { EvalTool } from ${src("tools/eval.ts")};`,
				`setAgentDir(${JSON.stringify(path.join(temp.path(), "agent"))});`,
				`const id = "shell-helper-secret-probe";`,
				"const session = {",
				`	cwd: ${JSON.stringify(temp.path())},`,
				"	hasUI: false,",
				"	skills: [],",
				`	settings: Settings.isolated({ "eval.autoProvision": false }),`,
				"	getSessionFile: () => null,",
				`	getSessionSpawns: () => "*",`,
				"	getArtifactsDir: () => null,",
				"	getSessionId: () => id,",
				"	getEvalSessionId: () => id,",
				"};",
				`const result = await new EvalTool(session).execute("call", { language: "js", code: ${JSON.stringify(code)}, timeout: 60 });`,
				`process.stdout.write(result.content.map(part => (part.type === "text" ? part.text : "")).join(""));`,
				"await disposeAllVmContexts();",
				"process.exit(0);",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script], {
			cwd: temp.path(),
			env: { ...Bun.env, [names.secret]: "probe-secret-value", [names.plain]: "probe-plain-value" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 25_000,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const line = stdout.split("\n").find(entry => entry.startsWith("RESULT "));
		if (!line) throw new Error(`no RESULT line from probe (exit ${exitCode}):\n${stdout}\n${stderr}`);
		expect(JSON.parse(line.slice("RESULT ".length))).toEqual({ secret: "unset", plain: "probe-plain-value" });
	});

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: starts each command in the session cwd or `cwd` and raises ShellError without backgrounding",
		async () => {
			const result = await runCell("py");
			const root = await fs.realpath(temp.path());
			expect(result).toEqual({
				quoted: "a b|nested|",
				cwd: [root, path.join(root, "sub")],
				failure: { name: "ShellError", code: 3, output: "boom\n" },
			});
		},
	);
});
