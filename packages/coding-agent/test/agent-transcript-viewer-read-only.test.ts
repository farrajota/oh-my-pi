import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { createReadOnlyAgentTranscriptViewer, type ReadOnlyAgentTranscriptViewerDeps } from "@oh-my-pi/pi-coding-agent";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("createReadOnlyAgentTranscriptViewer", () => {
	beforeAll(() => initTheme());
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

	test("sanitizes and width-bounds agent header metadata", async () => {
		using tempDir = TempDir.createSync("@omp-agent-transcript-header-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		await Bun.write(
			sessionFile,
			`${JSON.stringify({
				type: "model_change",
				id: "model",
				parentId: null,
				timestamp: "2026-08-05T00:00:00.000Z",
				model: `model\u001b[2J${"m".repeat(80)}`,
			})}\n`,
		);
		const agentId = `Worker\u001b[2J${"x".repeat(80)}`;
		const registry = new AgentRegistry();
		registry.register({
			id: agentId,
			displayName: "Worker",
			kind: "sub",
			parentId: `Main\nInjected\u001b[2J${"p".repeat(80)}`,
			session: null,
			status: "parked",
			sessionFile,
		});
		const viewer = createReadOnlyAgentTranscriptViewer({
			agentId,
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
			const rendered = viewer.render(40);
			expect(rendered.join("\n")).not.toContain("\u001b[2J");
			for (const line of rendered.slice(1, 3)) expect(Bun.stripANSI(line).length).toBeLessThanOrEqual(40);
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
