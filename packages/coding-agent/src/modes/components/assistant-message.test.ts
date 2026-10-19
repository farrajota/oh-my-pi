import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";

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

describe("AssistantMessageComponent run completion", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const startedAt = new Date(2026, 0, 2, 3, 4, 5).getTime();
	const stoppedAt = startedAt + 4_000;
	const completion = { startedAt, stoppedAt, outcome: "completed" as const };
	const stoppedLabel = new Date(stoppedAt).toLocaleString(undefined, { timeZoneName: "short" });

	it("renders elapsed and local stopped-at data on a finalized assistant response", () => {
		const component = new AssistantMessageComponent({
			...assistantTextMessage("done"),
			runCompletion: completion,
		});
		component.markTranscriptBlockFinalized();

		const rendered = stripAnsi(component.render(80));
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(rendered).toContain("done");
		const elapsed = rendered.match(/\bCompleted in (\d+(?:\.\d+)?)s\b/);
		expect(Number(elapsed?.[1])).toBe((stoppedAt - startedAt) / 1_000);
		expect(rendered).toContain("Stopped at");
		expect(rendered).toContain(stoppedLabel);
	});
	it.each(["failed", "interrupted"] as const)("renders elapsed and stopped-at data for a %s run", outcome => {
		const component = new AssistantMessageComponent({
			...assistantTextMessage("stopped"),
			runCompletion: { ...completion, outcome },
		});
		const rendered = stripAnsi(component.render(80));
		const label = outcome === "failed" ? "Failed" : "Interrupted";
		const elapsed = rendered.match(new RegExp(`\\b${label} in (\\d+(?:\\.\\d+)?)s\\b`));
		expect(Number(elapsed?.[1])).toBe((stoppedAt - startedAt) / 1_000);
		expect(rendered).toContain("Stopped at");
		expect(rendered).toContain(stoppedLabel);
	});
});
