import { beforeAll, describe, expect, it } from "bun:test";
import { AttachmentChipsBand } from "@oh-my-pi/pi-coding-agent/modes/components/attachment-chips";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { chipLabel } from "@oh-my-pi/pi-coding-agent/modes/image-references";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageBudget } from "@oh-my-pi/pi-tui";

// 2x2 red PNG — real header so the band's dimension probe decodes 2x2.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBhQAAA9+AQBHYLp7wAAAABJRU5ErkJggg==";

function makeBand(): { editor: CustomEditor; band: AttachmentChipsBand } {
	const editor = new CustomEditor(getEditorTheme());
	return { editor, band: new AttachmentChipsBand(editor, new ImageBudget(8)) };
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AttachmentChipsBand", () => {
	it("renders nothing while no attachment is staged", () => {
		const { band } = makeBand();
		expect(band.render(80)).toEqual([]);
	});

	it("renders a 6-row card with the chip token caption and paste line caption", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("line1\nline2\nline3");
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows).toHaveLength(6);
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[5]).toContain("+3 lines");
		// Snippet: leading content rows inside the border rails.
		expect(rows[1]).toContain("line1");
		expect(rows[2]).toContain("line2");
	});

	it("captions a single-line paste with its character count", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("x".repeat(42));
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows[5]).toContain("42 chars");
	});

	it("hides the card once its inline token is deleted from the buffer", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("line1\nline2");
		expect(band.render(80)).toHaveLength(6);
		editor.setText("no token here");
		expect(band.render(80)).toEqual([]);
	});

	it("captions an image card with probed pixel dimensions and shows both cards side by side", () => {
		const { editor, band } = makeBand();
		editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
		editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
		editor.insertTextAttachment("hello");
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows).toHaveLength(6);
		expect(rows[0]).toContain(chipLabel("image", 1));
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[5]).toContain("2x2");
		expect(rows[5]).toContain("5 chars");
	});

	it("omits cards that do not fit the terminal width instead of wrapping", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("first");
		editor.insertTextAttachment("second");
		// 14 cols per card + 2 gap: at width 20 only the first card fits.
		const rows = band.render(20).map(Bun.stripANSI);
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[0]).not.toContain(chipLabel("paste", 2));
	});
});
