import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const managers: AsyncJobManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.dispose()));
});

/** A session whose own settings cap output lines far below the 768-column default the global settings keep. */
function sessionWithColumnCap(managedJob: boolean): ToolSession {
	const asyncJobManager = managedJob ? new AsyncJobManager({}) : undefined;
	if (asyncJobManager) managers.push(asyncJobManager);
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => "bash-session-output-settings",
		asyncJobManager,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": managedJob,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"tools.outputMaxColumns": 256,
		}),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("bash output limits", () => {
	it.each([
		{ path: "direct run", managedJob: false },
		{ path: "foreground job run", managedJob: true },
	])("caps output lines at the session's tools.outputMaxColumns on the $path path", async ({ managedJob }) => {
		const tool = new BashTool(sessionWithColumnCap(managedJob));
		const result = await tool.execute("wide-line", { command: "printf 'x%.0s' $(seq 1 600); echo" }, undefined);
		const wideLine = textOf(result)
			.split("\n")
			.find(line => line.startsWith("xxx"));
		expect(wideLine).toBeDefined();
		expect(wideLine!.length).toBeLessThanOrEqual(260);
	});
});
