import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(cwd = "/tmp/eval-test"): ToolSession {
	const sessionId = `eval-display-${crypto.randomUUID()}`;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => sessionId,
		getEvalKernelOwnerId: () => sessionId,
		settings: Settings.isolated(),
	};
}

function baseResult(
	outputOrDisplay: string | { displayOutputs: EvalDisplayOutput[] } = "",
	displayOutputs: EvalDisplayOutput[] = [],
) {
	const output = typeof outputOrDisplay === "string" ? outputOrDisplay : "";
	const outputs = typeof outputOrDisplay === "string" ? displayOutputs : outputOrDisplay.displayOutputs;
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: outputs,
	};
}

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(c => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toString("base64");
}

describe("EvalTool printed views", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
	});

	it("gives the model exactly the printed text and puts the view on the cell", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const printed = "  a  b\n0  1  2";
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult(`before\n${printed}\n`, [
				{
					type: "view",
					text: `${printed}\n`,
					view: {
						kind: "table",
						columns: [{ head: "" }, { head: "a", numeric: true }, { head: "b", numeric: true }],
						rows: [["0", "1", "2"]],
					},
				},
			]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-view", { language: "js", code: "print(df)" });

		expect(modelText(result)).toBe(`before\n${printed}`);
		const cell = result.details?.cells?.[0];
		expect(cell?.output).toBe(`before\n${printed}`);
		expect(cell?.views).toEqual([
			{
				// Stored text is trimmed; the renderer still finds it inside `output`.
				text: printed.trim(),
				view: {
					kind: "table",
					columns: [{ head: "" }, { head: "a", numeric: true }, { head: "b", numeric: true }],
					rows: [["0", "1", "2"]],
				},
			},
		]);
	});

	it("caps views at 16 per cell, drops oversized and empty ones, and leaves cells without views bare", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const views: EvalDisplayOutput[] = [
			{ type: "view", text: "huge", view: { kind: "markdown", text: "x".repeat(33 * 1024) } },
			{ type: "view", text: "  \n", view: { kind: "markdown", text: "blank" } },
		];
		for (let i = 0; i < 20; i++) views.push({ type: "view", text: `v${i}`, view: { kind: "json", value: [i] } });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(baseResult("text\n", views) as never);

		const result = await new EvalTool(makeSession()).execute("call-caps", { language: "js", code: "print(x)" });

		const kept = result.details?.cells?.[0]?.views ?? [];
		expect(kept).toHaveLength(16);
		expect(kept.map(entry => entry.text)).toEqual(Array.from({ length: 16 }, (_, i) => `v${i}`));
		expect(modelText(result)).toBe("text");
	});

	it("omits views when nothing qualified", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(baseResult("plain\n") as never);

		const result = await new EvalTool(makeSession()).execute("call-plain", { language: "js", code: "print(1)" });

		expect(result.details?.cells?.[0]?.views).toBeUndefined();
	});

	it("surfaces printed images to the model as ImageContent blocks, not inlined base64", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const base64 = Buffer.from([0, 1, 2, 3]).toString("base64");
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult("", [{ type: "image", data: base64, mimeType: "image/png" }]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-image", { language: "js", code: "print(img)" });

		const imageBlocks = result.content.filter(c => c.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({ type: "image", data: base64, mimeType: "image/png" });
		const text = modelText(result);
		expect(text).not.toContain(base64);
		expect(text).toMatch(/\(1 image; no text output\)/);
		expect(result.details?.images).toBeUndefined();
	});

	it("downscales printed images before returning ImageContent", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const base64 = await makeRedPng(2400, 1200);
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult("", [{ type: "image", data: base64, mimeType: "image/png" }]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-large-image", {
			language: "js",
			code: "print(largePng)",
		});

		const image = result.content.find(c => c.type === "image");
		if (image?.type !== "image") throw new Error("Expected image content");
		expect(image.data).not.toBe(base64);
		const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(1568);
		expect(height).toBeLessThanOrEqual(1568);
		const text = modelText(result);
		expect(text).toContain("original 2400x1200");
		expect(text).not.toContain(base64);
	});

	it("still reports (no text output) when nothing was printed or displayed", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(baseResult() as never);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-empty", {
			language: "js",
			code: "```js\nconst x = 1;\n```\n",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("(no output)");
	});

	it("includes display() JSON values in the text content the model sees", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult("", [{ type: "json", data: { stdout: "hi", exit_code: 0 } }]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-display-json", {
			language: "js",
			code: "display({ stdout: 'hi', exit_code: 0 });",
		});

		const text = modelText(result);
		expect(text).toContain("display[1]");
		expect(text).toContain('"stdout": "hi"');
		expect(text).toContain('"exit_code": 0');
		expect(text).not.toBe("(no text output)");
	});

	it("renders display() once in the TUI while model text and jsonOutputs keep it (issue #10778)", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult("before\n", [{ type: "json", data: { marker: "ZZUNIQUE" } }]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-small-display", {
			language: "js",
			code: "print('before'); display(value);",
		});

		const text = modelText(result);
		expect(text).toContain('"marker": "ZZUNIQUE"');
		expect(result.details?.jsonOutputs).toEqual([{ marker: "ZZUNIQUE" }]);

		const theme = (await getThemeByName("dark"))!;
		const rendered = Bun.stripANSI(
			evalToolRenderer
				.renderResult(result, { expanded: true, isPartial: false, spinnerFrame: 0 }, theme)
				.render(120)
				.join("\n"),
		);
		expect(rendered).toContain("before");
		expect(rendered.split("ZZUNIQUE")).toHaveLength(2);
	});

	it("interleaves stdout text and display() JSON values", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult("before\n", [{ type: "json", data: [1, 2, 3] }]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-mixed", {
			language: "js",
			code: "print('before'); display([1,2,3]);",
		});

		const text = modelText(result);
		expect(text).toContain("before");
		expect(text.indexOf("before")).toBeLessThan(text.indexOf("display[1]"));
		expect(text).toContain("[\n  1,\n  2,\n  3\n]");
	});

	it("routes JavaScript display() values from the real runtime to model text and jsonOutputs", async () => {
		const result = await new EvalTool(makeSession(process.cwd())).execute("call-real-js-display", {
			language: "js",
			code: "print('before'); display({ source: 'javascript' });",
		});

		expect(modelText(result)).toContain('"source": "javascript"');
		expect(result.details?.jsonOutputs).toEqual([{ source: "javascript" }]);
	});

	it("routes Python display() values from the real kernel to model text and jsonOutputs", async () => {
		const result = await new EvalTool(makeSession(process.cwd())).execute("call-real-python-display", {
			language: "py",
			code: "print('before')\ndisplay({'source': 'python'})",
		});

		expect(modelText(result)).toContain('"source": "python"');
		expect(result.details?.jsonOutputs).toEqual([{ source: "python" }]);
	});

	it("truncates oversized display values rather than blasting the context", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const huge = "x".repeat(20000);
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-huge", {
			language: "js",
			code: "```js\ndisplay({ payload: 'x'.repeat(20000) });\n```\n",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("ch elided");
		expect(text.length).toBeLessThan(20000);
	});

	it("keeps oversized display details bounded and spills the full value to the artifact", async () => {
		using tempDir = TempDir.createSync("@omp-eval-display-");
		const artifactPath = tempDir.join("eval.log");
		const huge = `start-${"x".repeat(100_000)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool({
			...makeSession(),
			allocateOutputArtifact: async () => ({ id: "large-display", path: artifactPath }),
		});
		const result = await tool.execute("call-huge-details", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(Buffer.byteLength(JSON.stringify(result.details), "utf-8")).toBeLessThan(20_000);
		expect(await Bun.file(artifactPath).text()).toContain(huge);
		expect(result.details?.meta?.limits?.columnTruncated?.artifactId).toBe("large-display");
	});

	it("retains the full display value in details when no artifact is available", async () => {
		const huge = `start-${"x".repeat(100_000)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		// makeSession() has no allocateOutputArtifact, mirroring a non-persistent
		// SDK session: there is no session JSONL to bloat, so the full structured
		// value must survive in details for SDK consumers.
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-huge-no-artifact", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(result.details?.jsonOutputs?.[0]).toEqual({ payload: huge });
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("ch elided");
		expect(text).not.toContain(huge);
	});

	it("restores the full display value when the artifact write fails", async () => {
		using tempDir = TempDir.createSync("@omp-eval-display-fail-");
		// Parent directory is never created, so the spill FileSink cannot open —
		// OutputSink swallows the error, so persistence must be treated as
		// unconfirmed and the full value restored into details.
		const artifactPath = tempDir.join("missing", "eval.log");
		const huge = `start-${"x".repeat(100_000)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool({
			...makeSession(),
			allocateOutputArtifact: async () => ({ id: "doomed-display", path: artifactPath }),
		});
		const result = await tool.execute("call-huge-failed-spill", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(await Bun.file(artifactPath).exists()).toBe(false);
		expect(result.details?.jsonOutputs?.[0]).toEqual({ payload: huge });
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});

	it("restores the full display value when the artifact cap cut the spill", async () => {
		using tempDir = TempDir.createSync("@omp-eval-display-capped-");
		const artifactPath = tempDir.join("eval.log");
		// 3 MiB spill against a 1 MB artifact cap: the middle of the value is
		// never written, so the artifact cannot stand in for it.
		const huge = `start-${"x".repeat(3 * 1024 * 1024)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool({
			...makeSession(),
			settings: Settings.isolated({ "tools.artifactMaxBytes": 1 }),
			allocateOutputArtifact: async () => ({ id: "capped-display", path: artifactPath }),
		});
		const result = await tool.execute("call-huge-capped-spill", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(await Bun.file(artifactPath).text()).toContain("[ARTIFACT TRUNCATED:");
		expect(result.details?.jsonOutputs?.[0]).toEqual({ payload: huge });
		expect(result.details?.meta?.truncation?.artifactId).toBe("capped-display");
		expect(result.details?.meta?.truncation?.artifactElidedBytes).toBeGreaterThan(0);
		const notice = formatOutputNotice(result.details?.meta);
		expect(notice).toContain("Read artifact://capped-display for a head/tail sample of the output");
		expect(notice).not.toContain("for full output");
	});
});
