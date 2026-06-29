import { describe, expect, test, vi } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import type { EffectiveSubagentPermissions } from "../../../task/permission-profiles";
import { ExtensionRunner } from "../runner";
import type { Extension, ExtensionRuntime } from "../types";
import { ExtensionToolWrapper } from "../wrapper";

const cwd = "/workspace/project";
const paramsSchema = type({
	"path?": "string",
	"+": "delete",
});

function extension(handlers: Extension["handlers"] = new Map()): Extension {
	return {
		path: "/extensions/test.ts",
		resolvedPath: "/extensions/test.ts",
		handlers,
		tools: new Map(),
		assistantThinkingRenderers: [],
		messageRenderers: new Map(),
		workingMessageSuffixes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function runner(
	extensions: Extension[] = [],
	sessionScope?: ConstructorParameters<typeof ExtensionRunner>[7],
): ExtensionRunner {
	return new ExtensionRunner(
		extensions,
		{} as ExtensionRuntime,
		cwd,
		{ getSessionId: () => "session-1" } as ConstructorParameters<typeof ExtensionRunner>[3],
		{} as ConstructorParameters<typeof ExtensionRunner>[4],
		undefined,
		undefined,
		sessionScope,
	);
}

function scope(overrides: Partial<EffectiveSubagentPermissions> = {}): EffectiveSubagentPermissions {
	return {
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "SubagentA",
		actorKind: "sub",
		parentId: "Main",
		profiles: ["test-profile"],
		tools: undefined,
		denyTools: [],
		allowPaths: [],
		denyPaths: [],
		...overrides,
	};
}

function fakeTool(name: string, execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }))) {
	return {
		name,
		description: `${name} test tool`,
		label: name,
		parameters: paramsSchema,
		strict: true,
		approval: "write",
		execute,
	} as unknown as AgentTool<typeof paramsSchema, unknown>;
}

const autoApprovedContext = { autoApprove: true } as AgentToolContext;

describe("extension permission context", () => {
	test("createContext exposes actor identity and permission scope", () => {
		const permissionScope = scope({
			actorId: "WorkerA",
			parentId: "ParentA",
			profiles: ["read-only"],
			tools: ["read"],
		});
		const subject = runner([], {
			actor: { id: "WorkerA", kind: "sub", parentId: "ParentA" },
			permissionScope,
		});

		const context = subject.createContext();

		expect(context.actor).toEqual({ id: "WorkerA", kind: "sub", parentId: "ParentA" });
		expect(context.permissionScope).toBe(permissionScope);
	});

	test("execute blocks a denied tool before approval handlers run", async () => {
		const approvalRequested = vi.fn(async () => undefined);
		const approvalResolved = vi.fn(async () => undefined);
		const toolCall = vi.fn(async () => undefined);
		const subject = runner(
			[
				extension(
					new Map([
						["tool_approval_requested", [approvalRequested]],
						["tool_approval_resolved", [approvalResolved]],
						["tool_call", [toolCall]],
					]) as Extension["handlers"],
				),
			],
			{ permissionScope: scope({ denyTools: ["write"] }) },
		);
		const execute = vi.fn(async () => ({ content: [{ type: "text", text: "should not run" }] }));
		const wrapped = new ExtensionToolWrapper(fakeTool("write", execute), subject);

		await expect(wrapped.execute("call-1", {}, undefined, undefined, autoApprovedContext)).rejects.toThrow(
			"BLOCKED: Subagent permission profile denied tool 'write'.",
		);

		expect(approvalRequested).not.toHaveBeenCalled();
		expect(approvalResolved).not.toHaveBeenCalled();
		expect(toolCall).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	test("execute blocks a denied path before the wrapped tool runs", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text", text: "should not run" }] }));
		const wrapped = new ExtensionToolWrapper(
			fakeTool("read", execute),
			runner([], { permissionScope: scope({ tools: ["read"], denyPaths: ["blocked/**"] }) }),
		);

		await expect(
			wrapped.execute("call-2", { path: "blocked/secret.txt" }, undefined, undefined, autoApprovedContext),
		).rejects.toThrow("BLOCKED: Subagent permission profile denied path");

		expect(execute).not.toHaveBeenCalled();
	});

	test("execute runs unchanged with no scope or suggest-mode scope", async () => {
		const noScopeExecute = vi.fn(async () => ({ content: [{ type: "text", text: "no scope ok" }] }));
		const noScopeWrapped = new ExtensionToolWrapper(fakeTool("write", noScopeExecute), runner());

		await expect(noScopeWrapped.execute("call-3", {}, undefined, undefined, autoApprovedContext)).resolves.toEqual({
			content: [{ type: "text", text: "no scope ok" }],
		});
		expect(noScopeExecute).toHaveBeenCalledTimes(1);

		const suggestExecute = vi.fn(async () => ({ content: [{ type: "text", text: "suggest ok" }] }));
		const suggestWrapped = new ExtensionToolWrapper(
			fakeTool("write", suggestExecute),
			runner([], { permissionScope: scope({ mode: "suggest", denyTools: ["write"], denyPaths: ["blocked/**"] }) }),
		);

		await expect(
			suggestWrapped.execute("call-4", { path: "blocked/secret.txt" }, undefined, undefined, autoApprovedContext),
		).resolves.toEqual({ content: [{ type: "text", text: "suggest ok" }] });
		expect(suggestExecute).toHaveBeenCalledTimes(1);
	});
});
