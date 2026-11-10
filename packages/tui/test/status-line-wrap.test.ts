import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDir, setProjectDir, TempDir, VERSION } from "@oh-my-pi/pi-utils";
import { getComposerStyle } from "../src/components/composer/registry";
import { CustomEditor } from "../src/prompt/custom-editor";
import type { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme, theme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import { createStatusLineFixture } from "./helpers/status-line";
import { defaultEditorTheme } from "./test-themes";

const PROJECT_DIR_NAME = "wrap-project-dir";
const CONTAINER = "wrap-container";
const SESSION_TITLE = "wrap-session-title";

/** Every configured segment's text, in configured order (left group, then right). */
const SEGMENT_TEXTS = [VERSION, "Test Model", "Plan", PROJECT_DIR_NAME, CONTAINER, SESSION_TITLE];

function settings(overrides: Partial<StatusLineSettings> = {}): StatusLineSettings {
	return {
		preset: "custom",
		leftSegments: ["omp_version", "model", "mode", "path", "docker_container"],
		rightSegments: ["session_name"],
		separator: "powerline-thin",
		sessionAccent: false,
		contextLine: "annotated",
		segmentOptions: {
			model: { showThinkingLevel: false },
			path: { abbreviate: false, maxLength: 200, stripWorkPrefix: false },
		},
		...overrides,
	};
}

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

/** Asserts each text occurs exactly once across the rows, in the given order. */
function expectEachOnceInOrder(rows: readonly string[], texts: readonly string[]): void {
	const vertical = defaultEditorTheme.symbols.boxRound.vertical;
	const cap = theme.sep.powerlineLeft;
	// Continuation rows add layout chrome even when they split one segment's text.
	const joined = plainRows(rows)
		.map(row => {
			let body = row.trim();
			if (body.startsWith(vertical) && body.endsWith(vertical))
				body = body.slice(vertical.length, -vertical.length).trim();
			if (cap && body.endsWith(cap)) body = body.slice(0, -cap.length).trimEnd();
			return body;
		})
		.join("");
	let previous = -1;
	for (const text of texts) {
		expect(joined.split(text).length - 1).toBe(1);
		const index = joined.indexOf(text);
		expect(index).toBeGreaterThan(previous);
		previous = index;
	}
}

function expectRowsWithin(rows: readonly string[], width: number): void {
	for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
}

describe("status line wraps overflowing segments onto continuation rows", () => {
	const originalProjectDir = getProjectDir();
	const originalContainer = process.env.DOCKER_CONTAINER_NAME;
	let tempDir: TempDir;
	let component: StatusLineComponent | undefined;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@omp-status-wrap-");
		fs.mkdirSync(path.join(tempDir.path(), PROJECT_DIR_NAME));
	});
	afterEach(() => {
		component?.dispose();
		component = undefined;
		setProjectDir(originalProjectDir);
		if (originalContainer === undefined) delete process.env.DOCKER_CONTAINER_NAME;
		else process.env.DOCKER_CONTAINER_NAME = originalContainer;
	});
	afterAll(async () => {
		await tempDir.remove();
	});

	function statusLine(overrides: Partial<StatusLineSettings> = {}, container = CONTAINER): StatusLineComponent {
		setProjectDir(path.join(tempDir.path(), PROJECT_DIR_NAME));
		process.env.DOCKER_CONTAINER_NAME = container;
		component = createStatusLineFixture({
			settings: settings(overrides),
			sessionName: SESSION_TITLE,
			context: { tokens: 20_000, contextWindow: 200_000 },
		});
		component.setPlanModeStatus({ enabled: true, paused: false });
		return component;
	}

	/** The editor's rows with the status line attached for `shape`, at terminal `width`. */
	function editorRows(status: StatusLineComponent, shape: string, width: number, maxHeight?: number): string[] {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.setBorderStyle(shape);
		if (maxHeight !== undefined) editor.setMaxHeight(maxHeight);
		status.attachToEditor(editor, getComposerStyle(shape));
		return [...editor.render(width)];
	}

	it("leaves a bar that fits on one row exactly as upstream renders it", () => {
		const status = statusLine();
		const width = 200;
		expect(status.getPreviewLines(width, { statusAttachment: "top-border", bottomBar: "none" })).toEqual([
			status.getTopBorder(width).content,
		]);
		expect(status.getPreviewLines(width, { statusAttachment: "top-band", bottomBar: "none" })).toEqual([
			status.getBandTopBorder(width).content,
		]);
		status.setComposerStyle(getComposerStyle("pi"));
		expect(status.render(width)).toEqual([status.renderBottomBar(width, "full")]);

		const editor = new CustomEditor(defaultEditorTheme);
		status.attachToEditor(editor, getComposerStyle("box"));
		const rows = editor.render(width);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain(status.getTopBorder(editor.getTopBorderAvailableWidth(width)).content);
	});

	it("wraps the box top border inside the frame without dropping segments", () => {
		const width = 64;
		const rows = editorRows(statusLine(), "box", width);
		// Top border, at least one continuation row, the input row.
		expect(rows.length).toBeGreaterThan(2);
		for (const row of rows) expect(visibleWidth(row)).toBe(width);
		const continuation = plainRows(rows.slice(1, -1));
		for (const row of continuation) {
			expect(row.startsWith(defaultEditorTheme.symbols.boxRound.vertical)).toBe(true);
			expect(row.endsWith(defaultEditorTheme.symbols.boxRound.vertical)).toBe(true);
		}
		expectEachOnceInOrder(rows, SEGMENT_TEXTS);
		expectEachOnceInOrder(rows, [getProjectDir()]);
	});

	it("wraps the band and rule-chip layouts within the terminal width", () => {
		const width = 56;
		const band = editorRows(statusLine(), "band", width);
		expect(band.length).toBeGreaterThan(2);
		expectRowsWithin(band, width);
		// The band relocates the session title to the working row.
		expectEachOnceInOrder(
			band,
			SEGMENT_TEXTS.filter(text => text !== SESSION_TITLE),
		);
		expectEachOnceInOrder(band, [getProjectDir()]);

		// The rule chip carries only the right group; the left group lives on the bottom bar.
		component?.dispose();
		const status = statusLine({ rightSegments: ["model", "session_name"] });
		const chip = editorRows(status, "claude", 24);
		expectRowsWithin(chip, 24);
		expectEachOnceInOrder(chip, ["Test Model", SESSION_TITLE]);
	});

	it("wraps the standalone bottom bar and the settings preview the same way", () => {
		const width = 56;
		const status = statusLine();
		status.setComposerStyle(getComposerStyle("pi"));
		const rows = status.render(width);
		expect(rows.length).toBeGreaterThan(1);
		expectRowsWithin(rows, width);
		expectEachOnceInOrder(rows, SEGMENT_TEXTS);
		expectEachOnceInOrder(rows, [getProjectDir()]);
		expect(status.getPreviewLines(width)).toEqual([...rows]);
	});

	it("wraps one overwide segment across rows without clipping it", () => {
		const container = `container-${"x".repeat(70)}-end`;
		const width = 24;
		const status = statusLine({ leftSegments: ["docker_container"], rightSegments: [] }, container);
		status.setComposerStyle(getComposerStyle("pi"));
		const rows = status.render(width);
		expect(rows.length).toBeGreaterThan(2);
		expectRowsWithin(rows, width);
		expect(plainRows(rows).join("").replaceAll(/\s/g, "")).toContain(container);
	});

	it("measures wide CJK characters by cell width when wrapping", () => {
		const container = "容器名称很长的名字用于测试换行宽度计算是否正确";
		const width = 15;
		const status = statusLine({ leftSegments: ["omp_version", "docker_container"], rightSegments: [] }, container);
		status.setComposerStyle(getComposerStyle("pi"));
		const rows = status.render(width);
		expect(rows.length).toBeGreaterThan(2);
		expectRowsWithin(rows, width);
		expect(plainRows(rows).join("").replaceAll(/\s/g, "")).toContain(container);

		const boxRows = editorRows(status, "box", width + 4);
		for (const row of boxRows) expect(visibleWidth(row)).toBe(width + 4);
		const hanText = [...plainRows(boxRows).join("")].filter(char => /\p{Script=Han}/u.test(char)).join("");
		expect(hanText).toBe(container);
	});

	it("counts continuation rows against the editor's height limit", () => {
		const width = 64;
		const status = statusLine();
		const unlimited = editorRows(status, "box", width);
		const maxHeight = unlimited.length + 1;
		const editor = new CustomEditor(defaultEditorTheme);
		editor.setBorderStyle("box");
		editor.setMaxHeight(maxHeight);
		status.attachToEditor(editor, getComposerStyle("box"));
		editor.setText(Array.from({ length: 10 }, (_, line) => `line-${line}`).join("\n"));

		const rows = editor.render(width);
		expect(rows.length).toBeLessThanOrEqual(maxHeight);
		expectEachOnceInOrder(rows, SEGMENT_TEXTS);
		expectEachOnceInOrder(rows, [getProjectDir()]);
	});
});
