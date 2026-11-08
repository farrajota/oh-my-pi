/**
 * The extension tool wrapper under a subagent permission scope (fork `permission-context.test.ts`, ported
 * onto upstream's wrapper): a denied call is refused before approval handlers, `tool_call` handlers or the
 * tool itself run, a handler cannot rewrite a call into a denied path, and nothing changes without an
 * enforce scope. The loop's own `tool_call` emission is covered by `session-tool-call-guard.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";

type Handler = (...args: unknown[]) => Promise<unknown>;

function extension(handlers: Record<string, Handler[]>): Extension {
	return {
		path: "/extensions/permission-test.ts",
		resolvedPath: "/extensions/permission-test.ts",
		handlers: new Map(Object.entries(handlers)),
		tools: new Map(),
		assistantThinkingRenderers: [],
		assistantTextRenderers: [],
		transcriptPresenters: [],
		linkSchemes: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

let temp: TempDir;
let cwd: string;

beforeEach(() => {
	temp = TempDir.createSync("@omp-scope-wrapper-");
	cwd = temp.path();
});
afterEach(() => {
	vi.restoreAllMocks();
	temp.removeSync();
});

function runner(extensions: Extension[] = []): ExtensionRunner {
	const subject = new ExtensionRunner(
		extensions,
		new ExtensionRuntime(),
		cwd,
		SessionManager.inMemory(cwd),
		{} as ModelRegistry,
	);
	subject.initialize(
		{} as Parameters<ExtensionRunner["initialize"]>[0],
		{} as Parameters<ExtensionRunner["initialize"]>[1],
		undefined,
		{ select: async () => "Approve" } as unknown as ExtensionUIContext,
	);
	return subject;
}

/** A path tool like read/write, whose approval targets come from `args.path`. */
function pathTool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: name === "read" ? "read" : "write",
		approvalCacheTargets: (args: unknown) =>
			isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(cwd, args.path)!] : undefined,
		execute,
	};
}

const ran = () => vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));

function contextFor(settings: Settings): AgentToolContext {
	return { settings } as AgentToolContext;
}

describe("extension tool wrapper under a permission scope", () => {
	it("blocks a denied tool before approval and tool_call handlers run", async () => {
		const approvalRequested = vi.fn(async () => undefined);
		const approvalResolved = vi.fn(async () => undefined);
		const toolCall = vi.fn(async () => undefined);
		const execute = ran();
		const wrapped = new ExtensionToolWrapper(
			pathTool("write", execute),
			runner([
				extension({
					tool_approval_requested: [approvalRequested],
					tool_approval_resolved: [approvalResolved],
					tool_call: [toolCall],
				}),
			]),
		);
		const settings = scopedSettings(enforceScope({ denyTools: ["write"] }), { "tools.approvalMode": "always-ask" });

		await expect(
			wrapped.execute("call-1", { path: "notes.txt" }, undefined, undefined, contextFor(settings)),
		).rejects.toThrow("BLOCKED: Subagent permission profile denied tool 'write'.");

		expect(approvalRequested).not.toHaveBeenCalled();
		expect(approvalResolved).not.toHaveBeenCalled();
		expect(toolCall).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("blocks a denied path before the wrapped tool runs", async () => {
		const execute = ran();
		const wrapped = new ExtensionToolWrapper(pathTool("read", execute), runner());
		const settings = scopedSettings(enforceScope({ tools: ["read"], denyPathGroups: [["blocked/**"]] }));

		await expect(
			wrapped.execute("call-2", { path: "blocked/secret.txt" }, undefined, undefined, contextFor(settings)),
		).rejects.toThrow("BLOCKED: Subagent permission profile denied path 'blocked/secret.txt'.");

		expect(execute).not.toHaveBeenCalled();
	});

	it("denies a call an extension rewrites into a path outside the allowlist", async () => {
		const rewrite = vi.fn(async () => ({ input: { path: "blocked/revised.txt" } }));
		const execute = ran();
		const wrapped = new ExtensionToolWrapper(
			pathTool("read", execute),
			runner([extension({ tool_call: [rewrite] })]),
		);
		const settings = scopedSettings(enforceScope({ tools: ["read"], allowPathGroups: [["allowed/**"]] }));

		await expect(
			wrapped.execute("call-rewrite", { path: "allowed/original.txt" }, undefined, undefined, contextFor(settings)),
		).rejects.toThrow("BLOCKED: Subagent permission profile does not allow path 'blocked/revised.txt'.");

		expect(rewrite).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
	});

	it("denies a guardrail target with the guardrail's reason", async () => {
		const execute = ran();
		const wrapped = new ExtensionToolWrapper(pathTool("read", execute), runner());
		const settings = scopedSettings(
			enforceScope({ tools: ["read"], guardrails: { noNetwork: true, secretsBlind: false } }),
		);

		await expect(
			wrapped.execute(
				"call-guardrail",
				{ path: "https://example.test/data" },
				undefined,
				undefined,
				contextFor(settings),
			),
		).rejects.toThrow("no-network guardrail");

		expect(execute).not.toHaveBeenCalled();
	});

	it("runs unchanged with no scope or a suggest-mode scope", async () => {
		const noScopeExecute = ran();
		await expect(
			new ExtensionToolWrapper(pathTool("write", noScopeExecute), runner()).execute(
				"call-3",
				{ path: "blocked/secret.txt" },
				undefined,
				undefined,
				contextFor(Settings.isolated()),
			),
		).resolves.toEqual({ content: [{ type: "text", text: "ran" }] });
		expect(noScopeExecute).toHaveBeenCalledTimes(1);

		const suggestExecute = ran();
		const suggest = scopedSettings(
			enforceScope({ mode: "suggest", denyTools: ["write"], denyPathGroups: [["blocked/**"]] }),
		);
		await expect(
			new ExtensionToolWrapper(pathTool("write", suggestExecute), runner()).execute(
				"call-4",
				{ path: "blocked/secret.txt" },
				undefined,
				undefined,
				contextFor(suggest),
			),
		).resolves.toEqual({ content: [{ type: "text", text: "ran" }] });
		expect(suggestExecute).toHaveBeenCalledTimes(1);
	});
});
