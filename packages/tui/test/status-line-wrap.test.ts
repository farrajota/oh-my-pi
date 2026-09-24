import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getProjectDir, VERSION } from "@oh-my-pi/pi-utils";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";

const projectName = path.basename(getProjectDir());

beforeAll(async () => {
	await initTheme();
});

const originalDockerName = process.env.DOCKER_CONTAINER_NAME;

afterEach(() => {
	if (originalDockerName === undefined) delete process.env.DOCKER_CONTAINER_NAME;
	else process.env.DOCKER_CONTAINER_NAME = originalDockerName;
});

function createStatusLine(
	options: {
		leftSegments?: readonly string[];
		rightSegments?: readonly string[];
		totalTokens?: number;
		reasoning?: number;
		mode?: boolean;
	} = {},
): StatusLineComponent {
	const leftSegments = options.leftSegments ?? ["omp_version", "docker_container"];
	const rightSegments = options.rightSegments ?? ["session_name"];
	const session = {
		state: { messages: [] },
		messages: [],
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => "wide-session-name",
			getSessionId: () => "session-id",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: options.totalTokens ?? 0,
				reasoning: options.reasoning ?? 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => undefined,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => (options.mode ? { enabled: true, paused: false } : undefined),
	} as StatusLineSession;
	const host = {
		getSettings: () => ({
			preset: "custom" as const,
			leftSegments,
			rightSegments,
			separator: "dot" as const,
		}),
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: async () => [],
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	} as unknown as StatusLineHost;
	const component = new StatusLineComponent(session, host);
	component.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
	component.setGoalModeStatus(options.mode ? { enabled: true, paused: false } : undefined);
	return component;
}

describe("status-line overflow", () => {
	test("wraps configured segments once in source order across all composer layouts", () => {
		const status = createStatusLine({ leftSegments: ["omp_version", "path"], rightSegments: ["mode"], mode: true });
		const rows = [
			{ lines: status.renderBottomBarLines(10, "full"), order: [VERSION, projectName, "Goal"] },
			{ lines: status.getTopBorderLines(10), order: [VERSION, projectName, "Goal"] },
			{ lines: status.getBandTopBorderLines(10), order: [VERSION, projectName, "Goal"] },
			{ lines: status.getStandaloneTopBorderLines(10), order: ["Goal"] },
			{ lines: status.renderBottomBarLines(10, "left"), order: [VERSION, projectName] },
		];
		for (const { lines, order } of rows) {
			const plain = lines.map(line => Bun.stripANSI(line)).join("");
			if (order.length > 1) expect(lines.length).toBeGreaterThan(1);
			expect(lines.every(line => visibleWidth(line) <= 10)).toBe(true);
			for (const segment of order) expect(plain.split(segment).length - 1).toBe(1);
			for (let index = 1; index < order.length; index++) {
				expect(plain.indexOf(order[index - 1])).toBeLessThan(plain.indexOf(order[index]));
			}
		}
	});

	test("preserves repeated configured segment output across overflow rows", () => {
		const status = createStatusLine({ leftSegments: ["omp_version", "path", "omp_version"], rightSegments: [] });
		const lines = status.renderBottomBarLines(10, "left");
		const plain = lines.map(line => Bun.stripANSI(line)).join("");
		const firstVersion = plain.indexOf(VERSION);
		const pathIndex = plain.indexOf(projectName);
		const secondVersion = plain.indexOf(VERSION, firstVersion + VERSION.length);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every(line => visibleWidth(line) <= 10)).toBe(true);
		expect(plain.split(VERSION).length - 1).toBe(2);
		expect(plain.split(projectName).length - 1).toBe(1);
		expect(firstVersion).toBeGreaterThanOrEqual(0);
		expect(firstVersion).toBeLessThan(pathIndex);
		expect(pathIndex).toBeLessThan(secondVersion);
	});

	test("wraps one overwide segment without clipping it", () => {
		const overwide = "container-" + "x".repeat(80);
		process.env.DOCKER_CONTAINER_NAME = overwide;
		const lines = createStatusLine().getBandTopBorderLines(8);
		const plain = lines.map(line => Bun.stripANSI(line)).join("");
		expect(lines.every(line => visibleWidth(line) <= 8)).toBe(true);
		expect(plain.match(new RegExp(overwide, "g")) ?? []).toHaveLength(1);
	});
	test("preserves path before mode when both overflow", () => {
		const lines = createStatusLine({
			leftSegments: ["path", "mode"],
			rightSegments: [],
			mode: true,
		}).getTopBorderLines(10);
		const plain = lines.map(line => Bun.stripANSI(line)).join("");
		expect(lines.every(line => visibleWidth(line) <= 10)).toBe(true);
		expect(plain).toContain("Goal");
		expect(plain.indexOf(projectName)).toBeLessThan(plain.indexOf("Goal"));
	});

	test("uses authoritative totalTokens without adding reasoning", () => {
		const line = createStatusLine({
			leftSegments: [],
			rightSegments: ["token_total"],
			totalTokens: 123,
			reasoning: 900,
		})
			.getTopBorderLines(200)
			.join("");
		const plain = Bun.stripANSI(line);
		expect(plain).toContain("123");
		expect(plain).not.toContain("1023");
	});

	test("keeps fitting content byte-for-byte on one row", () => {
		process.env.DOCKER_CONTAINER_NAME = "container";
		const status = createStatusLine();
		expect(status.renderBottomBarLines(200, "full")).toEqual([status.renderBottomBar(200, "full")]);
		expect(status.getTopBorderLines(200)).toEqual([status.getTopBorder(200).content]);
		expect(status.getBandTopBorderLines(200)).toEqual([status.getBandTopBorder(200).content]);
		expect(status.getStandaloneTopBorderLines(200)).toEqual([status.getStandaloneTopBorder(200).content]);
		expect(status.render(200)).toHaveLength(1);
	});
});
