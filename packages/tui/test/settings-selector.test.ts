import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { bottomBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { type SettingsRuntimeContext, SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function createSelector(
	getStatusLinePreview: () => string,
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
		getStatusLinePreview,
		onCancel: () => {},
	});
}

/** The selector sizes itself from `process.stdout.rows`; pin it for the duration of `fn`. */
async function withTerminalRows<T>(rows: number, fn: () => T | Promise<T>): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
	try {
		return await fn();
	} finally {
		if (original) Object.defineProperty(process.stdout, "rows", original);
		else Reflect.deleteProperty(process.stdout, "rows");
	}
}

/**
 * What the terminal shows: the overlay is bottom-anchored and the compositor
 * keeps the last `rows` lines of anything taller.
 */
function painted(lines: readonly string[], rows: number): string[] {
	return lines.slice(Math.max(0, lines.length - rows)).map(line => Bun.stripANSI(line));
}

/** SGR mouse report at a 0-based frame cell (the protocol is 1-based). */
function mouse(button: number, col: number, row: number): string {
	return `\x1b[<${button};${col + 1};${row + 1}M`;
}
const WHEEL_DOWN = 65;
const LEFT_CLICK = 0;

describe("settings selector viewport", () => {
	it("bounds the frame to a short terminal and scrolls an overflowing preview with the wheel", async () => {
		await withTerminalRows(12, () => {
			const preview = Array.from({ length: 12 }, (_, index) => `STATUS-${index}`);
			const selector = createSelector(() => preview.join("\n"));

			const first = selector.render(80);
			const visible = painted(first, 12);
			expect(first).toHaveLength(12);
			expect(visible[0]).toContain("Settings");
			expect(visible.some(line => line.includes("Appearance"))).toBe(true);
			expect(visible.some(line => line.includes("Dark theme"))).toBe(true);
			expect(visible.some(line => line.includes("STATUS-11"))).toBe(false);
			expect(first.at(-1)).toBe(bottomBorder(80));

			const previewRow = visible.findIndex(line => line.includes("STATUS-0"));
			expect(previewRow).toBeGreaterThan(0);
			for (let index = 0; index < preview.length; index++) {
				selector.handleInput(mouse(WHEEL_DOWN, 2, previewRow));
			}

			const scrolled = painted(selector.render(80), 12);
			expect(scrolled).toHaveLength(12);
			expect(scrolled.some(line => line.includes("STATUS-11"))).toBe(true);
			expect(scrolled.some(line => line.includes("Dark theme"))).toBe(true);
			expect(scrolled[0]).toContain("Settings");
			expect(scrolled.at(-1)).toBe(Bun.stripANSI(bottomBorder(80)));
		});
	});

	it("hit-tests clicks against the rows a short terminal actually paints", async () => {
		await withTerminalRows(12, () => {
			// Wide enough for every tab to show its label rather than only its icon.
			const width = 240;
			const selector = createSelector(() => Array.from({ length: 6 }, (_, index) => `STATUS-${index}`).join("\n"));
			const visible = painted(selector.render(width), 12);
			const tabRow = visible.findIndex(line => line.includes("Model"));
			expect(tabRow).toBeGreaterThan(0);
			const tabLine = visible[tabRow];
			const tabCol = visibleWidth(tabLine.slice(0, tabLine.indexOf("Model")));

			selector.handleInput(mouse(LEFT_CLICK, tabCol, tabRow));

			const after = selector.render(width).map(line => Bun.stripANSI(line));
			expect(after.some(line => line.includes("Preview:"))).toBe(false);
		});
	});

	it("returns unused preview capacity to the settings list in tall terminals", async () => {
		await withTerminalRows(40, () => {
			const selector = createSelector(() => "STATUS-FIRST\nSTATUS-SECOND");
			const rendered = selector.render(80).map(line => Bun.stripANSI(line));
			const previewLabelRow = rendered.findIndex(line => line.includes("Preview:"));

			expect(rendered).toHaveLength(40);
			expect(rendered.at(-1)).toBe(Bun.stripANSI(bottomBorder(80)));
			expect(rendered.some(line => line.includes("STATUS-FIRST"))).toBe(true);
			expect(rendered.some(line => line.includes("STATUS-SECOND"))).toBe(true);
			expect(previewLabelRow).toBe(34);
			expect(rendered.slice(0, previewLabelRow).some(line => line.includes("Dark theme"))).toBe(true);
		});
	});

	it("fills the remaining viewport for search results without an appearance preview", async () => {
		await withTerminalRows(20, () => {
			const selector = createSelector(() => "PREVIEW");
			selector.handleInput("d");
			const rendered = selector.render(80);

			expect(rendered).toHaveLength(20);
			expect(rendered.at(-1)).toBe(bottomBorder(80));
		});
	});

	it("fills the remaining viewport for the Plugins tab", async () => {
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
		await withTerminalRows(20, async () => {
			const selector = createSelector(() => "", plugins);
			for (let index = 0; index < 10; index++) selector.handleInput("\x1b[C");
			for (let index = 0; index < 6; index++) await Promise.resolve();
			const rendered = selector.render(80).map(line => Bun.stripANSI(line));

			expect(rendered).toHaveLength(20);
			expect(rendered.some(line => line.includes("No plugins installed"))).toBe(true);
			expect(rendered.at(-1)).toBe(Bun.stripANSI(bottomBorder(80)));
		});
	});
});
