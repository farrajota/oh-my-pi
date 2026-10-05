import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../../src/config/settings";
import { executePython } from "../../../src/eval/py/executor";

describe("Python kernel runtime environment", () => {
	it("keeps safe PI runtime settings while excluding inherited token and API key values", async () => {
		using workspace = TempDir.createSync("@omp-py-kernel-env-");
		const sessionId = `py-kernel-env:${crypto.randomUUID()}`;
		const envKeys = ["PI_TOKEN", "OPENAI_API_KEY", "PI_RUNTIME_SMOKE"] as const;
		const shellEnv = (await Settings.init()).getShellConfig().env;
		const previous: Record<string, string | undefined> = Object.fromEntries(envKeys.map(key => [key, shellEnv[key]]));
		const chunks: string[] = [];
		try {
			shellEnv.PI_TOKEN = "dummy-pi-token-sentinel";
			shellEnv.OPENAI_API_KEY = "dummy-openai-key-sentinel";
			shellEnv.PI_RUNTIME_SMOKE = "safe";

			const result = await executePython(
				[
					"import json, os",
					"print(json.dumps({",
					'    "safe": os.environ.get("PI_RUNTIME_SMOKE") == "safe",',
					'    "piTokenAbsent": "PI_TOKEN" not in os.environ,',
					'    "apiKeyAbsent": "OPENAI_API_KEY" not in os.environ,',
					"}))",
				].join("\n"),
				{
					cwd: workspace.path(),
					sessionId,
					kernelMode: "per-call",
					onChunk: chunk => {
						chunks.push(chunk);
					},
				},
			);

			const expected = { safe: true, piTokenAbsent: true, apiKeyAbsent: true };
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output.trim())).toEqual(expected);
			expect(JSON.parse(chunks.join("").trim())).toEqual(expected);
			expect(result.output).not.toContain("dummy-pi-token-sentinel");
			expect(result.output).not.toContain("dummy-openai-key-sentinel");
		} finally {
			for (const key of envKeys) {
				const value = previous[key];
				if (value === undefined) delete shellEnv[key];
				else shellEnv[key] = value;
			}
		}
	});
});
