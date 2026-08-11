import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { formatUsageTimestamp } from "@oh-my-pi/pi-coding-agent/modes/components/usage-row";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { Container } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	Settings.instance.set("tui.hyperlinks", "always");
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

const ISSUED_AT = new Date(2026, 0, 2, 3, 4, 5).getTime();
const ISSUED_AT_LABEL = "2026-01-02 03:04:05";

function render(text: string): string {
	return new UserMessageComponent(text).render(80).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("UserMessageComponent magic-keyword highlighting", () => {
	it("gradient-paints a magic keyword in the rendered (sent) message bubble", () => {
		const raw = render("please orchestrate the rollout");
		// Visible text is preserved.
		expect(Bun.stripANSI(raw)).toContain("please orchestrate the rollout");
		// The keyword is gradient-painted: a per-character foreground sequence is emitted,
		// and the word no longer survives as a contiguous run in the rendered bytes.
		expect(raw).toContain("\x1b[38");
		expect(raw).not.toContain("orchestrate");
	});

	it("does not paint a keyword inside an inline code span", () => {
		const raw = render("ship the `orchestrate` helper");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		// Code spans render through the code style as a single run — the word stays intact.
		expect(raw).toContain("orchestrate");
	});

	it("does not paint a keyword inside a fenced code block", () => {
		const raw = render("intro\n```\norchestrate\n```");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		expect(raw).toContain("orchestrate");
	});

	it("closes the OSC 133 prompt zone and leaves no command zone open", () => {
		const raw = render("first line\nsecond line");
		expect(raw).toContain("\x1b]133;A\x07");
		expect(raw).toContain("\x1b]133;B\x07");
		// #8030: the command-start marker is required. Terminals latch a sticky
		// `.input` cursor semantic on 133;B that only 133;C clears; without it every
		// later cell stays tagged as prompt input and click-to-move injects arrow
		// keys into the pty.
		expect(raw).toContain("\x1b]133;C\x07");
		// ...but the zone is closed inside the same render, so terminals still cannot
		// group later assistant/tool output under the submitted prompt.
		expect(raw).toContain("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07");
		expect(raw.endsWith("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07")).toBe(true);
		// Exactly one balanced command zone per bubble.
		expect(countOccurrences(raw, "\x1b]133;C\x07")).toBe(1);
		expect(countOccurrences(raw, "\x1b]133;D;0\x07")).toBe(1);
	});

	it("closes the OSC 133 command zone for a single-line message too", () => {
		const raw = render("only line");
		expect(raw).toContain("\x1b]133;A\x07");
		expect(raw.endsWith("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07")).toBe(true);
		expect(countOccurrences(raw, "\x1b]133;C\x07")).toBe(1);
		expect(countOccurrences(raw, "\x1b]133;D;0\x07")).toBe(1);
	});

	it("bolds and underlines image references in the rendered message bubble", () => {
		const raw = render("please inspect [Image #1] before continuing");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b[1m");
		expect(raw).toContain("\x1b[4m");
	});

	it("preserves image hyperlinks when timestamp is the trailing constructor argument", () => {
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		const raw = new UserMessageComponent("please inspect [Image #1]", false, [imagePath], ISSUED_AT)
			.render(80)
			.join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
		expect(Bun.stripANSI(raw)).toContain(ISSUED_AT_LABEL);
	});

	it("wraps draft editor image references in file hyperlinks when a blob path is available", () => {
		const editor = new CustomEditor(getEditorTheme());
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("please inspect [Image #1]");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("rebuilds user messages with image hyperlinks when image links are not precomputed", () => {
		const displayPath = path.resolve("/tmp/abc123.png");
		const displayUri = url.pathToFileURL(path.resolve(displayPath)).href;
		const chatContainer = new Container();
		const sessionManagerMock = {
			putBlobSync: () => ({
				hash: "abc123",
				path: path.resolve("/tmp/abc123"),
				displayPath,
				get ref() {
					return "blob:sha256:abc123";
				},
			}),
		};
		const helpers = new UiHelpers({
			chatContainer,
			getUserMessageText: () => "please inspect [Image #1]",
			sessionManager: sessionManagerMock,
			viewSession: { sessionManager: sessionManagerMock },
			transcriptMessageComponents: new WeakMap(),
		} as unknown as InteractiveModeContext);
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "please inspect [Image #1]" },
				{ type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: ISSUED_AT,
		};

		helpers.addMessageToChat(message);
		const component = chatContainer.children.at(-1);
		if (!component) throw new Error("Expected user message component to be appended");
		const raw = component.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(displayUri);
		expect(Bun.stripANSI(raw)).toContain(ISSUED_AT_LABEL);
	});

	it("highlights paste markers in the draft editor without a hyperlink", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("see [Paste #1, +30 lines] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Paste #1, +30 lines]");
		// The marker label is bold-wrapped (highlighted), unlike surrounding plain text.
		expect(raw).toContain("\x1b[1m[Paste #1, +30 lines]");
		// Paste markers are not clickable, so no OSC-8 hyperlink is emitted (contrast with images).
		expect(raw).not.toContain("\x1b]8;id=");
	});

	it("hyperlinks the metadata-bearing image marker format", () => {
		const editor = new CustomEditor(getEditorTheme());
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("see [Image #1, 800x600] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1, 800x600]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});
});

describe("UserMessageComponent issued timestamp footer", () => {
	it("exports the local timestamp formatter and renders a valid timestamp as a dim footer", () => {
		expect(formatUsageTimestamp(ISSUED_AT)).toBe(ISSUED_AT_LABEL);

		const raw = new UserMessageComponent("please inspect this", false, undefined, ISSUED_AT).render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain(ISSUED_AT_LABEL);
		expect(raw).toContain(theme.fg("dim", ISSUED_AT_LABEL));
	});

	it("omits the footer for synthetic messages", () => {
		const raw = new UserMessageComponent("synthetic context", true, undefined, ISSUED_AT).render(80).join("\n");
		expect(Bun.stripANSI(raw)).not.toContain(ISSUED_AT_LABEL);
	});

	it("omits the footer for missing and invalid timestamps", () => {
		for (const timestamp of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const raw = new UserMessageComponent("prompt body", false, undefined, timestamp).render(80).join("\n");
			expect(Bun.stripANSI(raw)).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
		}
	});

	it("keeps the footer below fenced Markdown rather than extending the code block", () => {
		const raw = new UserMessageComponent("```ts\nconst emittedAt = 1;\n```", false, undefined, ISSUED_AT)
			.render(80)
			.join("\n");
		const lines = Bun.stripANSI(raw).split("\n");

		expect(lines.some(line => line.includes("const emittedAt = 1;"))).toBe(true);
		expect(lines.at(-1)?.trim()).toBe(ISSUED_AT_LABEL);
	});

	it("renders the canonical timestamp when rebuilding a stored transcript", () => {
		const builder = new ChatTranscriptBuilder({
			ui: {} as never,
			cwd: process.cwd(),
			requestRender: () => {},
		});
		builder.rebuild([
			{
				message: { role: "user", content: "restored prompt", timestamp: ISSUED_AT },
			} as never,
		]);

		expect(Bun.stripANSI(builder.container.render(80).join("\n"))).toContain(ISSUED_AT_LABEL);
	});
});
