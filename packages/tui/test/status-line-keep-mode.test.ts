import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import type { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import { createStatusLineFixture } from "./helpers/status-line";

const LONG_DIR_NAME = "controlled-path-boundary-for-mode";

function settings(leftSegments: StatusLineSettings["leftSegments"]): StatusLineSettings {
	return {
		preset: "custom",
		leftSegments,
		rightSegments: [],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "off",
		segmentOptions: { path: { abbreviate: false, maxLength: 120, stripWorkPrefix: false } },
	};
}

describe("status line keeps the active mode on overflow", () => {
	const originalProjectDir = getProjectDir();
	let tempDir: TempDir;
	let component: StatusLineComponent | undefined;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@omp-status-mode-");
		fs.mkdirSync(path.join(tempDir.path(), LONG_DIR_NAME));
	});
	afterEach(() => {
		component?.dispose();
		component = undefined;
		setProjectDir(originalProjectDir);
	});
	afterAll(async () => {
		await tempDir.remove();
	});

	function planStatusLine(leftSegments: StatusLineSettings["leftSegments"]): StatusLineComponent {
		component?.dispose();
		component = createStatusLineFixture({ settings: settings(leftSegments), context: undefined });
		component.setPlanModeStatus({ enabled: true, paused: false });
		return component;
	}

	it("drops the model before the plan-mode label when the bar overflows", () => {
		// A filesystem root renders a path too short to shrink, so overflow must drop a segment.
		setProjectDir(path.parse(originalProjectDir).root);
		// Width 0 renders the groups unconstrained: the exact width of mode + path.
		const modeAndPath = planStatusLine(["mode", "path"]).getTopBorder(0).width;
		const bar = planStatusLine(["model", "mode", "path"]).getTopBorder(modeAndPath + 1);
		const text = Bun.stripANSI(bar.content);

		expect(bar.width).toBeLessThanOrEqual(modeAndPath + 1);
		expect(text).toContain("Plan");
		expect(text).not.toContain("Test Model");
	});

	it("keeps a one-sided box bar within its width budget", () => {
		const dir = path.join(tempDir.path(), LONG_DIR_NAME);
		setProjectDir(dir);
		const status = planStatusLine(["mode", "path"]);
		// The box layout always draws a gauge cell between the group and the border edge,
		// so a group exactly as wide as the budget must give up a cell of path.
		const budget = status.getTopBorder(0).width;
		const bar = status.getTopBorder(budget);
		const text = Bun.stripANSI(bar.content);

		expect(visibleWidth(bar.content)).toBeLessThanOrEqual(budget);
		expect(text).toContain("Plan");
		expect(text).toContain("controlled-path");
	});

	it("leaves a one-sided plain bar that fits exactly unchanged", () => {
		setProjectDir(path.join(tempDir.path(), LONG_DIR_NAME));
		const status = planStatusLine(["mode", "path"]);
		const unconstrained = status.renderBottomBar(0, "left");
		const budget = visibleWidth(unconstrained);

		expect(status.renderBottomBar(budget, "left")).toBe(unconstrained);
	});
});
