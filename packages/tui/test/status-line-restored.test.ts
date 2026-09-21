import * as os from "node:os";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { VERSION } from "@oh-my-pi/pi-utils";
import { CUSTOM_STATUS_LINE_DEFAULTS, STATUS_LINE_SEGMENT_IDS } from "../src/status-line/schema";
import { getPreset } from "../src/status-line/presets";
import { ALL_SEGMENT_IDS, SEGMENTS, renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

const context = { startupPlaceholder: false } as SegmentContext;

const originalDockerName = process.env.DOCKER_CONTAINER_NAME;
const originalHostname = process.env.HOSTNAME;

afterEach(() => {
	if (originalDockerName === undefined) delete process.env.DOCKER_CONTAINER_NAME;
	else process.env.DOCKER_CONTAINER_NAME = originalDockerName;
	if (originalHostname === undefined) delete process.env.HOSTNAME;
	else process.env.HOSTNAME = originalHostname;
});

describe("restored status-line segments", () => {
	test("includes the historical identifiers and default order", () => {
		expect(STATUS_LINE_SEGMENT_IDS).toContain("omp_version");
		expect(STATUS_LINE_SEGMENT_IDS).toContain("docker_container");
		expect(STATUS_LINE_SEGMENT_IDS.slice(0, 3)).toEqual(["pi", "omp_version", "docker_container"]);
		expect(getPreset("default").leftSegments.slice(0, 3)).toEqual(["pi", "omp_version", "docker_container"]);
		expect(CUSTOM_STATUS_LINE_DEFAULTS.left).not.toContain("omp_version");
	});

	test("resolves restored renderers from the registry", () => {
		expect(SEGMENTS.omp_version).toBeDefined();
		expect(SEGMENTS.docker_container).toBeDefined();
		expect(ALL_SEGMENT_IDS).toContain("omp_version");
		expect(ALL_SEGMENT_IDS).toContain("docker_container");
	});

	test("renders the supported version", () => {
		const rendered = renderSegment("omp_version", context);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain(VERSION);
	});

	test("renders the seven-day quota window", () => {
		const rendered = renderSegment("usage", {
			...context,
			usage: { sevenDay: { percent: 42, resetHours: 12 } },
		} as SegmentContext);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("7d");
	});

	test("uses docker container name before hostname", () => {
		process.env.DOCKER_CONTAINER_NAME = "named-container";
		process.env.HOSTNAME = "host-name";
		expect(renderSegment("docker_container", context).content).toContain("named-container");
	});

	test("falls back from hostname to os.hostname", () => {
		delete process.env.DOCKER_CONTAINER_NAME;
		process.env.HOSTNAME = "host-name";
		expect(renderSegment("docker_container", context).content).toContain("host-name");

		delete process.env.HOSTNAME;
		expect(renderSegment("docker_container", context).content).toContain(os.hostname());
	});

	test("sanitizes container labels before rendering", () => {
		process.env.DOCKER_CONTAINER_NAME = "safe\u001b[31m-name";
		const rendered = renderSegment("docker_container", context);
		expect(rendered.content).not.toContain("[31m");
		expect(rendered.content).toContain("safe-name");
	});
});
