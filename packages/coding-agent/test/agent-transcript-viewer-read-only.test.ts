import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { writeFileSync } from "node:fs";
import { createReadOnlyAgentTranscriptViewer, type ReadOnlyAgentTranscriptViewerDeps } from "@oh-my-pi/pi-coding-agent";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("createReadOnlyAgentTranscriptViewer", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: "/workspace" });
		await initTheme();
	});
	afterAll(() => resetSettingsForTest());
	afterEach(() => vi.useRealTimers());

	test("opens the exact agent transcript without send capability", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Main/Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		const deps: ReadOnlyAgentTranscriptViewerDeps = {
			agentId: "Main/Worker",
			registry,
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
			cwd: "/workspace",
			expandKeys: ["ctrl+o"],
			hubKeys: ["alt+d"],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		};
		const viewer = createReadOnlyAgentTranscriptViewer(deps);
		try {
			const rendered = Bun.stripANSI(viewer.render(80).join("\n"));
			expect(rendered).toContain("Main/Worker");
			expect(rendered).not.toContain("Enter:send");
		} finally {
			viewer.dispose();
		}
	});

	test("stays on the agent generation it was opened for", async () => {
		using tempDir = TempDir.createSync("@omp-agent-transcript-generation-");
		vi.useFakeTimers();
		const entry = (model: string) =>
			`${JSON.stringify({ type: "model_change", id: "model", parentId: null, timestamp: "2026-08-05T00:00:00.000Z", model })}\n`;
		const firstFile = path.join(tempDir.path(), "first.jsonl");
		const secondFile = path.join(tempDir.path(), "second.jsonl");
		writeFileSync(firstFile, entry("first-generation"));
		writeFileSync(secondFile, entry("second-generation"));
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
			sessionFile: firstFile,
		});
		const viewer = createReadOnlyAgentTranscriptViewer({
			agentId: "Worker",
			registry,
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
			cwd: "/workspace",
			expandKeys: ["ctrl+o"],
			hubKeys: ["alt+d"],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});
		try {
			expect(Bun.stripANSI(viewer.render(80).join("\n"))).toContain("first-generation");

			registry.register({
				id: "Worker",
				displayName: "Worker",
				kind: "sub",
				parentId: "Main",
				session: null,
				status: "parked",
				sessionFile: secondFile,
			});
			vi.advanceTimersByTime(250);
			// A changed transcript path reloads off the UI thread; give that read time to land.
			vi.useRealTimers();
			await Bun.sleep(50);

			expect(Bun.stripANSI(viewer.render(80).join("\n"))).not.toContain("second-generation");
		} finally {
			viewer.dispose();
		}
	});

	test("disposal is idempotent and stops polling callbacks", () => {
		vi.useFakeTimers();
		const registry = new AgentRegistry();
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		let renders = 0;
		const viewer = createReadOnlyAgentTranscriptViewer({
			agentId: "Worker",
			registry,
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
			cwd: "/workspace",
			expandKeys: ["ctrl+o"],
			hubKeys: ["alt+d"],
			requestRender: () => {
				renders += 1;
			},
			onClose: () => {},
			onHubClose: () => {},
		});
		const rendersBeforeDispose = renders;
		viewer.dispose();
		viewer.dispose();
		vi.advanceTimersByTime(1_000);
		expect(renders).toBe(rendersBeforeDispose);
	});
});
