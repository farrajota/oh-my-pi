import { describe, expect, it } from "bun:test";
import { resolveTaskToolProfile } from "@oh-my-pi/pi-coding-agent/task/tool-profiles";
import { BUILTIN_TOOLS } from "@oh-my-pi/pi-coding-agent/tools";
import * as builtinNames from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import {
	assertToolNameNotReserved,
	BUILTIN_TOOL_NAMES,
	HIDDEN_TOOL_NAMES,
	isReservedCoreToolName,
	normalizeToolName,
} from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/essential-tools";

describe("reserved core tool names", () => {
	it("keeps browser audit native while reserving its external ingress", () => {
		expect(isReservedCoreToolName("browser_audit")).toBe(true);
		expect(BUILTIN_TOOL_NAMES).toContain("browser_audit");
		expect(Object.hasOwn(BUILTIN_TOOLS, "browser_audit")).toBe(true);
		expect(HIDDEN_TOOL_NAMES).not.toContain("browser_audit");
		expect(Object.hasOwn(ESSENTIAL_BUILTIN_TOOL_NAMES, "browser_audit")).toBe(false);
		expect(normalizeToolName("browser_audit")).toBe("browser_audit");
		expect(resolveTaskToolProfile("browser-audit")).toContain("browser_audit");
	});

	it("rejects external mutation without disabling the trusted core factory", () => {
		expect("RESERVED_CORE_TOOL_NAMES" in builtinNames).toBe(false);
		// oxlint-disable-next-line no-import-assign -- verifies namespace immutability
		expect(Reflect.set(builtinNames, "RESERVED_CORE_TOOL_NAMES", {})).toBe(false);
		expect(() => assertToolNameNotReserved("browser_audit")).toThrow(
			'Tool name "browser_audit" is reserved by the core runtime',
		);
		expect(typeof BUILTIN_TOOLS.browser_audit).toBe("function");
	});
});
