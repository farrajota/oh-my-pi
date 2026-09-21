import { beforeAll, describe, expect, it } from "bun:test";
import { SettingsSelectorComponent, type SettingsRuntimeContext } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { bottomBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function createSelector(
	getStatusLinePreview: () => readonly string[],
	onThemePreview?: (value: string) => void,
	plugins: SettingsRuntimeContext["plugins"] = {} as SettingsRuntimeContext["plugins"],
): SettingsSelectorComponent {
	const values: Record<string, unknown> = { "theme.dark": "dark" };
	const entries = [
		{
			path: "theme.dark",
			type: "string",
			defaultValue: "dark",
			ui: {
				tab: "appearance",
				group: "Theme",
				label: "Dark theme",
				description: "Theme used in dark terminals.",
				options: "runtime",
			},
		},
	];
	const context = {
		settings: {
			entries,
			get: (path: string) => values[path],
			set: (path: string, value: unknown) => {
				values[path] = value;
			},
			normalizeProviderLimits: () => ({}),
			validateProviderLimits: () => ({}),
		},
		plugins,
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: ["dark", "light"],
		providers: [],
	} as unknown as SettingsRuntimeContext;
	return new SettingsSelectorComponent(context, {
		onChange: () => {},
		...(onThemePreview ? { onThemePreview } : {}),
		getStatusLinePreview,
		onCancel: () => {},
	});
}

describe("settings selector previews", () => {
	it("refreshes every theme preview row after selection without embedding newlines", () => {
		let theme = "dark";
		const selector = createSelector(
			() => [`THEME-${theme}-FIRST`, `THEME-${theme}-SECOND`],
			value => {
				theme = value;
			},
		);

		selector.render(80);
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		const lines = selector.render(80).map(line => Bun.stripANSI(line));

		expect(lines.some(line => line.includes("THEME-light-FIRST"))).toBe(true);
		expect(lines.some(line => line.includes("THEME-light-SECOND"))).toBe(true);
		expect(lines.every(line => !line.includes("\n"))).toBe(true);
	});

	it("bounds and scrolls overflowing appearance preview rows within the fullscreen frame", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
		try {
			const preview = Array.from({ length: 12 }, (_, index) => `STATUS-${index}`);
			const selector = createSelector(() => preview);
			const first = selector.render(80);
			expect(first.length).toBeLessThanOrEqual(12);
			expect(first.some(line => Bun.stripANSI(line).includes("Dark theme"))).toBe(true);
			expect(first.at(-1)).toBe(bottomBorder(80));

			const previewRow = first.findIndex(line => Bun.stripANSI(line).includes("STATUS-0"));
			expect(previewRow).toBeGreaterThanOrEqual(0);
			for (let index = 0; index < preview.length; index++) {
				selector.handleInput(`\x1b[<65;3;${previewRow + 1}M`);
			}
			const scrolled = selector.render(80).map(line => Bun.stripANSI(line));
			expect(scrolled.some(line => line.includes("STATUS-11"))).toBe(true);
			expect(scrolled).toHaveLength(12);
			expect(scrolled.at(-1)).toBe(Bun.stripANSI(bottomBorder(80)));
			expect(scrolled.every(line => !line.includes("\n"))).toBe(true);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});
	it("returns unused preview capacity to the settings list in tall terminals", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
		try {
			const selector = createSelector(() => ["STATUS-FIRST", "STATUS-SECOND"]);
			const rendered = selector.render(80).map(line => Bun.stripANSI(line));
			const previewLabelRow = rendered.findIndex(line => line.includes("Preview:"));

			expect(rendered).toHaveLength(40);
			expect(rendered.at(-1)).toBe(Bun.stripANSI(bottomBorder(80)));
			expect(rendered.some(line => line.includes("STATUS-FIRST"))).toBe(true);
			expect(rendered.some(line => line.includes("STATUS-SECOND"))).toBe(true);
			expect(previewLabelRow).toBe(34);
			expect(rendered.slice(0, previewLabelRow).some(line => line.includes("Dark theme"))).toBe(true);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});
	it("fills the remaining viewport for search results without an appearance preview", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 20 });
		try {
			const selector = createSelector(() => ["PREVIEW"]);
			selector.handleInput("d");
			const rendered = selector.render(80);
			expect(rendered).toHaveLength(20);
			expect(rendered.at(-1)).toBe(bottomBorder(80));
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("fills the remaining viewport for the Plugins tab", async () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 20 });
		try {
			const plugins = {
				manager: {
					list: async () => [],
					getPlugin: async () => undefined,
					getPluginSettings: async () => ({}),
					setEnabled: async () => {},
					getEnabledFeatures: async () => null,
					setEnabledFeatures: async () => {},
					setPluginSetting: async () => {},
				},
				createMarketplaceManager: async () => ({
					listInstalledPlugins: async () => [],
					setPluginEnabled: async () => {},
				}),
				parsePluginId: () => null,
			} as SettingsRuntimeContext["plugins"];
			const selector = createSelector(() => [], undefined, plugins);
			for (let index = 0; index < 10; index++) selector.handleInput("\x1b[C");
			for (let index = 0; index < 6; index++) await Promise.resolve();
			const rendered = selector.render(80).map(line => Bun.stripANSI(line));
			expect(rendered).toHaveLength(20);
			expect(rendered.some(line => line.includes("No plugins installed"))).toBe(true);
			expect(rendered.at(-1)).toBe(Bun.stripANSI(bottomBorder(80)));
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});
});
