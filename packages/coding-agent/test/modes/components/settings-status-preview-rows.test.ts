import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

describe("settings appearance status-line preview", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("draws each row of a wrapped status line as its own framed row", () => {
		const width = 80;
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{
				onChange: () => {},
				onCancel: () => {},
				getStatusLinePreview: () => "status-row-one\nstatus-row-two",
			},
		);

		const rows = selector.render(width);
		for (const row of rows) {
			expect(row).not.toContain("\n");
			expect(visibleWidth(row)).toBe(width);
		}
		const plain = rows.map(row => Bun.stripANSI(row));
		const first = plain.findIndex(row => row.includes("status-row-one"));
		expect(first).toBeGreaterThan(-1);
		expect(plain[first + 1]).toContain("status-row-two");
	});
});
