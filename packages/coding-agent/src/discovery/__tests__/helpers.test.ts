import { describe, expect, test } from "bun:test";
import { parseAgentFields } from "../helpers";

describe("parseAgentFields tools frontmatter", () => {
	test("preserves an explicit empty tools list", () => {
		expect(parseAgentFields({ name: "empty", description: "Empty tools", tools: [] })?.tools).toEqual([]);
	});

	test("adds yield to non-empty explicit tools", () => {
		expect(parseAgentFields({ name: "reader", description: "Reader", tools: ["read"] })?.tools).toEqual([
			"read",
			"yield",
		]);
	});
});
