import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { cfgPromptSuggestionsEnabled, cfgPromptSuggestionsModel, Settings } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";

// The image-installed prompt-suggestions extension reads these handles from the package entry point
// on every editor keypress; an unregistered path made config.yml unloadable and the keypress throw.
describe("prompt suggestion settings", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-prompt-suggestions-settings-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("loads promptSuggestions values from config.yml", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(path.join(agentDir, "config.yml"), "promptSuggestions:\n  enabled: false\n  model: slow\n");

		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });

		expect(cfgPromptSuggestionsEnabled.get(settings)).toBe(false);
		expect(cfgPromptSuggestionsModel.get(settings)).toBe("slow");
	});

	it("enables suggestions on the smol role when config.yml omits them", () => {
		const settings = Settings.isolated();

		expect(cfgPromptSuggestionsEnabled.get(settings)).toBe(true);
		expect(cfgPromptSuggestionsModel.get(settings)).toBe("pi/smol");
	});
});
