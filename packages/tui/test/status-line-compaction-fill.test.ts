import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { StatusLineComponent } from "../src/status-line/component";
import type { CompactionBoundaries } from "../src/status-line/context-usage";
import { describeSegment } from "../src/status-line/segments";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import { createStatusLineFixture } from "./helpers/status-line";

const WINDOW = 200_000;
const THRESHOLD: CompactionBoundaries = { thresholdPercent: 60, speculationPercent: null };

const SEGMENT_SETTINGS: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["context_pct"],
	rightSegments: [],
	separator: "pipe",
	sessionAccent: false,
	contextLine: "off",
};

const EMBEDDED_SETTINGS: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["model"],
	rightSegments: ["context_pct"],
	separator: "pipe",
	sessionAccent: false,
	contextLine: "embedded",
	segmentOptions: { model: { showThinkingLevel: false } },
};

describe("auto-compaction fill prefix", () => {
	let component: StatusLineComponent | undefined;

	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		component?.dispose();
		component = undefined;
	});

	function statusLine(options: {
		settings: StatusLineSettings;
		tokens: number;
		autoCompact: boolean;
		boundaries?: CompactionBoundaries | null;
	}): StatusLineComponent {
		component?.dispose();
		component = createStatusLineFixture({
			settings: options.settings,
			context: { tokens: options.tokens, contextWindow: WINDOW },
			compactionBoundaries: options.boundaries === undefined ? THRESHOLD : options.boundaries,
		});
		component.setAutoCompactEnabled(options.autoCompact);
		return component;
	}

	function bar(status: StatusLineComponent, width = 120): string {
		return Bun.stripANSI(status.getTopBorder(width).content);
	}

	it("prefixes the context segment with the fill toward the auto-compaction threshold", () => {
		// 30% of the window against a 60% threshold is half way to compaction.
		const text = bar(statusLine({ settings: SEGMENT_SETTINGS, tokens: 60_000, autoCompact: true }));
		expect(text).toContain("[50%]/30.0%/200K");
	});

	it("caps the fill at 100% once usage passes the threshold", () => {
		const text = bar(statusLine({ settings: SEGMENT_SETTINGS, tokens: 140_000, autoCompact: true }));
		expect(text).toContain("[100%]/70.0%/200K");
	});

	it("shows no prefix when auto-compaction is off or has no threshold", () => {
		const off = bar(statusLine({ settings: SEGMENT_SETTINGS, tokens: 60_000, autoCompact: false }));
		expect(off).toContain("30.0%/200K");
		expect(off).not.toContain("[");

		const unknown = bar(
			statusLine({ settings: SEGMENT_SETTINGS, tokens: 60_000, autoCompact: true, boundaries: null }),
		);
		expect(unknown).toContain("30.0%/200K");
		expect(unknown).not.toContain("[");
	});

	it("puts the prefix on the embedded gauge label within the bar width", () => {
		const width = 120;
		const status = statusLine({ settings: EMBEDDED_SETTINGS, tokens: 60_000, autoCompact: true });
		const border = status.getTopBorder(width);
		expect(Bun.stripANSI(border.content)).toContain("[50%]/30%");
		expect(visibleWidth(border.content)).toBeLessThanOrEqual(width);

		const plain = bar(statusLine({ settings: EMBEDDED_SETTINGS, tokens: 60_000, autoCompact: false }), width);
		expect(plain).toContain("30%");
		expect(plain).not.toContain("[");
	});

	it("keeps the prefixed label on a narrow gauge where it must cover the markers", () => {
		const boundaries: CompactionBoundaries = { thresholdPercent: 60, speculationPercent: 50 };
		const status = statusLine({ settings: EMBEDDED_SETTINGS, tokens: 60_000, autoCompact: true, boundaries });
		// The model group plus the smallest gauge that still carries both labels.
		const width = status.getTopBorder(0).width + "[50%]/30%".length + "200K".length + 4;
		const border = status.getTopBorder(width);
		expect(Bun.stripANSI(border.content)).toContain("[50%]/30%");
		expect(Bun.stripANSI(border.content)).toContain("200K");
		expect(visibleWidth(border.content)).toBeLessThanOrEqual(width);
	});

	it("drops the prefix once usage is past the context window", () => {
		const text = bar(statusLine({ settings: SEGMENT_SETTINGS, tokens: 240_000, autoCompact: true }));
		expect(text).toContain("120.0%/200K");
		expect(text).not.toContain("[");
	});

	it("describes the prefix for the native composer facts", () => {
		const view = describeSegment("context_pct", {
			contextPercent: 30,
			contextWindow: WINDOW,
			contextTokens: 60_000,
			autoCompactEnabled: true,
			compactionThresholdPercent: 60,
			compactionSpeculation: "idle",
			options: {},
		} as unknown as Parameters<typeof describeSegment>[1]);
		expect(view?.spans[0]?.t).toBe("[50%]/30.0%/200K");
	});
});
