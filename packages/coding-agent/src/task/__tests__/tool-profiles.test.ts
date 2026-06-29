import { describe, expect, test } from "bun:test";
import { applyTaskToolProfile, resolveTaskToolProfile } from "../tool-profiles";

describe("task tool profiles", () => {
	test("none resolves to an explicit empty tool list", () => {
		expect(resolveTaskToolProfile("none")).toEqual([]);
	});

	test("inspect normalizes search/find aliases", () => {
		expect(resolveTaskToolProfile("inspect")).toEqual(["read", "grep", "glob"]);
	});

	test("edit keeps mutation tools but excludes broad execution and delegation tools", () => {
		const tools = resolveTaskToolProfile("edit");

		expect(tools).toEqual(["read", "grep", "glob", "ast_grep", "edit", "write"]);
		expect(tools).not.toEqual(expect.arrayContaining(["bash", "eval", "browser", "task"]));
	});

	test("an absent agent tool list receives the selected profile", () => {
		expect(applyTaskToolProfile(undefined, "review")).toEqual(["read", "grep", "glob", "ast_grep"]);
	});

	test("profile application preserves only the intersection with explicit agent tools", () => {
		expect(applyTaskToolProfile(["read"], "plan")).toEqual(["read"]);
		expect(applyTaskToolProfile(["write"], "plan")).toEqual([]);
	});
});
