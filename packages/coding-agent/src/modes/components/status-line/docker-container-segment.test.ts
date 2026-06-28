import * as os from "node:os";
import { VERSION } from "@oh-my-pi/pi-utils";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setTheme } from "../../../modes/theme/theme";
import { renderSegment } from "./segments";
import type { SegmentContext } from "./types";

const ctx = {} as SegmentContext;

describe("omp_version status-line segment", () => {
	beforeAll(async () => {
		await setTheme("dark");
	});

	test("renders the installed OMP version", () => {
		const rendered = renderSegment("omp_version", ctx);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain(`omp ${VERSION}`);
	});
});

describe("docker_container status-line segment", () => {
	const previous = process.env.DOCKER_CONTAINER_NAME;
	const previousHostname = process.env.HOSTNAME;

	beforeAll(async () => {
		await setTheme("dark");
	});

	test("falls back to os.hostname when env identifiers are unset", () => {
		delete process.env.DOCKER_CONTAINER_NAME;
		delete process.env.HOSTNAME;
		const rendered = renderSegment("docker_container", ctx);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain(os.hostname().replace(/[\r\n\t]/g, " "));
		expect(rendered.content).not.toContain("\n");
		expect(rendered.content).not.toContain("\t");
	});

	test("falls back to sanitized HOSTNAME before os.hostname", () => {
		delete process.env.DOCKER_CONTAINER_NAME;
		process.env.HOSTNAME = "container\nid\t1";
		const rendered = renderSegment("docker_container", ctx);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("container id 1");
		expect(rendered.content).not.toContain(os.hostname());
		expect(rendered.content).not.toContain("\n");
		expect(rendered.content).not.toContain("\t");
	});

	test("renders sanitized DOCKER_CONTAINER_NAME before HOSTNAME", () => {
		process.env.DOCKER_CONTAINER_NAME = "omp\nbox\t1";
		process.env.HOSTNAME = "host-fallback";
		const rendered = renderSegment("docker_container", ctx);
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("omp box 1");
		expect(rendered.content).not.toContain("host-fallback");
		expect(rendered.content).not.toContain("\n");
		expect(rendered.content).not.toContain("\t");
	});

	afterAll(() => {
		if (previous === undefined) delete process.env.DOCKER_CONTAINER_NAME;
		else process.env.DOCKER_CONTAINER_NAME = previous;
		if (previousHostname === undefined) delete process.env.HOSTNAME;
		else process.env.HOSTNAME = previousHostname;
	});
});
