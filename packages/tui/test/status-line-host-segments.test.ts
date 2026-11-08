import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { VERSION } from "@oh-my-pi/pi-utils";
import { getPreset } from "../src/status-line/presets";
import { CUSTOM_STATUS_LINE_DEFAULTS, STATUS_LINE_SEGMENT_IDS } from "../src/status-line/schema";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme, theme } from "../src/theme";

// Neither segment reads the context; an empty one proves they do not depend on session state.
const CONTEXT = {} as SegmentContext;

const originalDockerName = process.env.DOCKER_CONTAINER_NAME;
const originalHostname = process.env.HOSTNAME;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	if (originalDockerName === undefined) delete process.env.DOCKER_CONTAINER_NAME;
	else process.env.DOCKER_CONTAINER_NAME = originalDockerName;
	if (originalHostname === undefined) delete process.env.HOSTNAME;
	else process.env.HOSTNAME = originalHostname;
});

describe("omp_version and docker_container status-line segments", () => {
	it("accepts both ids in custom status-line settings without changing upstream presets", () => {
		expect(STATUS_LINE_SEGMENT_IDS).toContain("omp_version");
		expect(STATUS_LINE_SEGMENT_IDS).toContain("docker_container");
		expect(getPreset("default").leftSegments).not.toContain("omp_version");
		expect(getPreset("default").leftSegments).not.toContain("docker_container");
		expect(CUSTOM_STATUS_LINE_DEFAULTS.left).not.toContain("omp_version");
	});

	it("renders the installed version with the omp icon", () => {
		const rendered = renderSegment("omp_version", CONTEXT);
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.icon.omp} ${VERSION}`);
		expect(describeSegment("omp_version", CONTEXT)).toEqual({
			spans: [{ t: VERSION, s: "muted" }],
			icon: "omp",
		});
	});

	it("prefers DOCKER_CONTAINER_NAME over HOSTNAME", () => {
		process.env.DOCKER_CONTAINER_NAME = "named-container";
		process.env.HOSTNAME = "host-name";
		expect(Bun.stripANSI(renderSegment("docker_container", CONTEXT).content)).toBe(
			`${theme.icon.host} named-container`,
		);
		expect(describeSegment("docker_container", CONTEXT)?.spans).toEqual([{ t: "named-container", s: "muted" }]);
	});

	it("falls back to HOSTNAME, then the machine hostname", () => {
		delete process.env.DOCKER_CONTAINER_NAME;
		process.env.HOSTNAME = "host-name";
		expect(Bun.stripANSI(renderSegment("docker_container", CONTEXT).content)).toBe(`${theme.icon.host} host-name`);

		delete process.env.HOSTNAME;
		expect(Bun.stripANSI(renderSegment("docker_container", CONTEXT).content)).toBe(
			`${theme.icon.host} ${os.hostname()}`,
		);
	});

	it("strips terminal control sequences from the container name", () => {
		process.env.DOCKER_CONTAINER_NAME = "safe\u001b[31m-name";
		const rendered = renderSegment("docker_container", CONTEXT);
		expect(rendered.content).not.toContain("[31m");
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.icon.host} safe-name`);
	});
});
