import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "../src/chat/user-message";
import { initTheme, theme } from "../src/theme";
import { stripTerminalSequences, visibleWidth } from "../src/utils";

// Local wall-clock time, so the expected text holds in every time zone.
const SENT_AT = new Date(2026, 10, 8, 9, 5, 7).getTime();
const SENT_TEXT = "2026-11-08 09:05:07";

function plainRows(component: UserMessageComponent, width: number): string[] {
	return component.render(width).map(row => stripTerminalSequences(row));
}

describe("user prompt issued timestamp", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the send time as a dim row under the prompt bubble", () => {
		const component = new UserMessageComponent("hello there", { timestamp: SENT_AT });
		const rows = component.render(60);
		const plain = rows.map(row => stripTerminalSequences(row));
		const withoutTime = plainRows(new UserMessageComponent("hello there"), 60);

		expect(plain).toHaveLength(withoutTime.length + 1);
		expect(plain.slice(0, -1)).toEqual(withoutTime);
		expect(plain.at(-1)?.trim()).toBe(SENT_TEXT);
		expect(rows.at(-1)).toContain(theme.fg("dim", SENT_TEXT));
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
	});

	it("keeps the row within a narrow width", () => {
		const rows = new UserMessageComponent("hello there", { timestamp: SENT_AT }).render(12);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(12);
	});

	it("shows no time for agent-attributed input or without a timestamp", () => {
		const synthetic = plainRows(
			new UserMessageComponent("advisor note", { synthetic: true, timestamp: SENT_AT }),
			60,
		);
		expect(synthetic.join("\n")).not.toContain(SENT_TEXT);
		expect(synthetic).toEqual(plainRows(new UserMessageComponent("advisor note", { synthetic: true }), 60));

		const invalid = plainRows(new UserMessageComponent("hello there", { timestamp: Number.NaN }), 60);
		expect(invalid).toEqual(plainRows(new UserMessageComponent("hello there"), 60));
	});
});
