import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { cfgPromptSuggestionsEnabled, cfgPromptSuggestionsModel, Settings } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createSettingsHost } from "../src/config/settings-ui";
import { lookup } from "../src/config/registry";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// The image-installed prompt-suggestions extension reads these handles from the package entry point
// on every editor keypress; an unregistered path made config.yml unloadable and the keypress throw.
describe("prompt suggestion settings", () => {
	let tempDir: TempDir;
	let state: SettingsTestState | undefined;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-prompt-suggestions-settings-");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		tempDir.removeSync();
	});

	it("loads promptSuggestions values from config.yml", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(path.join(agentDir, "config.yml"), "promptSuggestions:\n  enabled: false\n  model: slow\n");

		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });

		expect(cfgPromptSuggestionsEnabled.get(settings)).toBe(false);
		expect(cfgPromptSuggestionsModel.get(settings)).toBe("slow");
	});

	it("shows, persists, and clears the fallback model without changing the primary", async () => {
		const agentDir = tempDir.join("agent");
		await Settings.init({ cwd: tempDir.path(), agentDir });

		const fallbackSetting = lookup("promptSuggestions.fallbackModel");
		expect(fallbackSetting).toBeDefined();
		const host = createSettingsHost();
		const fallbackEntry = host.entries.find(entry => entry.path === "promptSuggestions.fallbackModel");
		const primaryEntry = host.entries.find(entry => entry.path === "promptSuggestions.model");
		expect(fallbackEntry).toBeDefined();
		expect(primaryEntry).toBeDefined();
		expect(fallbackEntry!.ui).toMatchObject({
			tab: "interaction",
			group: "Input",
			label: "Prompt Suggestions Fallback Model",
		});
		expect(primaryEntry!.ui).toMatchObject({ tab: "interaction", group: "Input" });
		expect(host.entries.indexOf(fallbackEntry!)).toBe(host.entries.indexOf(primaryEntry!) + 1);
		expect(fallbackSetting!.get(Settings.instance)).toBe("pi/smol");

		host.set("promptSuggestions.model", "provider/primary");
		host.set("promptSuggestions.fallbackModel", "provider/custom-fallback");
		await Settings.instance.flush();

		const saved = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		expect(fallbackSetting!.get(saved)).toBe("provider/custom-fallback");
		expect(cfgPromptSuggestionsModel.get(saved)).toBe("provider/primary");

		host.unset("promptSuggestions.fallbackModel");
		await Settings.instance.flush();

		const cleared = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
		expect(fallbackSetting!.get(cleared)).toBe("pi/smol");
		expect(cfgPromptSuggestionsModel.get(cleared)).toBe("provider/primary");
		const savedConfig = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
			promptSuggestions?: { fallbackModel?: string };
		};
		expect(savedConfig.promptSuggestions?.fallbackModel).toBeUndefined();
	});

	it("enables suggestions on the smol role when config.yml omits them", () => {
		const settings = Settings.isolated();

		expect(cfgPromptSuggestionsEnabled.get(settings)).toBe(true);
		expect(cfgPromptSuggestionsModel.get(settings)).toBe("pi/smol");
	});
});
