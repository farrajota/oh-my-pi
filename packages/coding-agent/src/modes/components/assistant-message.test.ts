import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { initTheme } from "../theme/theme";
import { AssistantMessageComponent } from "./assistant-message";

function stripAnsi(lines: readonly string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function assistantTextMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("AssistantMessageComponent completion footer", () => {
	beforeAll(async () => {
		await initTheme();
	});
	it("renders a completion footer after a stable text message fast-path render", () => {
		const component = new AssistantMessageComponent(assistantTextMessage("ok"));

		component.updateContent(assistantTextMessage("ok"));
		component.setCompletionFooter("Completed in 3s · +42 tokens");

		const rendered = stripAnsi(component.render(80));
		expect(rendered).toContain("ok");
		expect(rendered).toContain("Completed in 3s · +42 tokens");
	});

	it("keeps the completion footer when finalized after message_end", () => {
		const component = new AssistantMessageComponent(assistantTextMessage("done"));

		component.setCompletionFooter("Completed in 4s · +99 tokens");
		component.markTranscriptBlockFinalized();

		const rendered = stripAnsi(component.render(80));
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(rendered).toContain("done");
		expect(rendered).toContain("Completed in 4s · +99 tokens");
	});
});
