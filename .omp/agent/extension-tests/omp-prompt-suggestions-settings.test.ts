import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import { __test__ } from "../extensions/omp-prompt-suggestions";

// Runs against the real coding-agent settings, unlike omp-prompt-suggestions.test.ts which replaces
// the package with a module mock. That mock hid the removal of `Settings.get(path)`: the extension
// then threw on the first editor keypress and took omp down. Run this file in its own `bun test`
// process so the other file's module mock cannot replace the real package here.
describe("prompt suggestions extension with real settings", () => {
	let tempDir: TempDir;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@omp-prompt-suggestions-real-settings-");
		const agentDir = tempDir.join("agent");
		await Bun.write(path.join(agentDir, "config.yml"), "promptSuggestions:\n  enabled: false\n  model: slow\n");
		await Settings.init({ cwd: tempDir.path(), agentDir });
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	test("reads the toggle and model the user configured", () => {
		expect(__test__.isPromptSuggestionsEnabled()).toBe(false);
		expect(__test__.getPromptSuggestionModelSpec()).toBe("slow");
	});
});
