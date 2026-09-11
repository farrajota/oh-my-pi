import { type AgentTool, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { describe, expect, it } from "bun:test";
import {
	EffectiveToolRegistry,
	ExtensionToolWrapper,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { EffectiveSubagentPermissions } from "@oh-my-pi/pi-coding-agent/task/permission-profiles";

const emptyScope = {
	mode: "enforce",
	toolsEnabled: true,
	pathsEnabled: false,
	actorId: "test",
	actorKind: "sub",
	profiles: [],
	tools: ["core", "custom", "plugin"],
	denyTools: [],
	allowPaths: [],
	denyPaths: [],
} as unknown as EffectiveSubagentPermissions;

function makeTool(name: string, seen: object[]): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({ "value?": "string" }),
		execute: async (_id, input) => {
			if (input === null || typeof input !== "object" || Array.isArray(input)) {
				throw new Error("Expected object tool input");
			}
			seen.push(input);
			return { content: [{ type: "text", text: name }], details: undefined } satisfies AgentToolResult;
		},
	};
}

function makeRunner(authority?: EffectiveToolRegistry, emitInput?: Record<string, unknown>) {
	const runner = {
		consumeToolCallEmitted: () => false,
		hasHandlers: (event: string) => event === "tool_call" && emitInput !== undefined,
		emitToolCall: async () => (emitInput === undefined ? undefined : { input: emitInput }),
		getPermissionScope: () => emptyScope,
		getToolExecutionAuthority: () => authority,
		getCwd: () => "/tmp",
		getPathScope: () => undefined,
		hasUI: () => false,
		getUIContext: () => ({ select: async () => "Approve" }),
		runScoped: <T>(fn: () => T) => fn(),
		isSharedLspEnabled: () => false,
		sessionId: "test",
	} as unknown as ExtensionRunner;
	return runner;
}

describe("exact tool descriptor authority", () => {
	it("rejects same-name origin substitution and stale refreshes", () => {
		const authority = new EffectiveToolRegistry();
		const first = {};
		const second = {};
		authority.registerDescriptor({
			name: "custom",
			normalizedName: "custom",
			source: "custom",
			origin: "extension-a",
			descriptorId: "a",
			tool: first,
		});
		const prepared = authority.prepare("custom", "call", {}, undefined);
		authority.registerDescriptor({
			name: "custom",
			normalizedName: "custom",
			source: "opaque",
			origin: "extension-b",
			descriptorId: "b",
			tool: second,
		});
		expect(() => authority.validatePrepared(prepared, "custom", "call", {})).toThrow("stale");
	});

	it("binds object identity, final input, call id, and one-use consumption", () => {
		const authority = new EffectiveToolRegistry();
		const tool = {};
		const otherTool = {};
		const input = {};
		authority.registerDescriptor({
			name: "core",
			normalizedName: "core",
			source: "builtin",
			origin: "builtin",
			descriptorId: "core-id",
			tool,
		});
		const prepared = authority.prepare("core", "call", input, undefined);
		expect(() => authority.validatePrepared(prepared, "core", "call", {})).toThrow("different final input");
		expect(() => prepared.consume(otherTool, "call")).toThrow("different tool object");
		prepared.consume(tool, "call");
		expect(() => prepared.consume(tool, "call")).toThrow("already consumed");
	});

	it("executes core, custom, and plugin routes only through registry-backed wrappers", async () => {
		for (const name of ["core", "custom", "plugin"]) {
			const seen: object[] = [];
			const tool = makeTool(name, seen);
			const authority = new EffectiveToolRegistry();
			authority.registerDescriptor({
				name,
				normalizedName: name,
				source: name === "core" ? "builtin" : name === "plugin" ? "opaque" : "custom",
				origin: name,
				descriptorId: `${name}-id`,
				tool,
			});
			const wrapped = new ExtensionToolWrapper(tool, makeRunner(authority));
			const result = await wrapped.execute("call", {});
			expect(result.content).toEqual([{ type: "text", text: name }]);
			expect(seen).toHaveLength(1);
		}
	});

	it("binds the final rewritten input and rejects an unregistered direct wrapper", async () => {
		const seen: object[] = [];
		const tool = makeTool("custom", seen);
		const authority = new EffectiveToolRegistry();
		authority.registerDescriptor({
			name: "custom",
			normalizedName: "custom",
			source: "custom",
			origin: "extension",
			descriptorId: "custom-id",
			tool,
		});
		const rewritten = { value: "rewritten" };
		const wrapped = new ExtensionToolWrapper(tool, makeRunner(authority, rewritten));
		await wrapped.execute("call", { value: "original" });
		expect(seen).toEqual([rewritten]);
		const unregistered = new ExtensionToolWrapper(tool, makeRunner());
		await expect(unregistered.execute("missing", {})).rejects.toThrow("no registry execution authority");
	});
});
