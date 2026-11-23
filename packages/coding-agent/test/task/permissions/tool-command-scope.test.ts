/**
 * Tools run as bash tool commands answer to the subagent permission scope as their direct call
 * would: each command is judged as its own tool, never as the `bash` call that ran it. This replaces
 * the `xd://` device dispatch, where `write xd://<tool>` was checked against the device tool's name.
 * Mounted commands meet the scope through the registry's `ExtensionToolWrapper`; the special
 * commands (`resolve`, `reject`, `propose`, `report_issue`) are built per run and meet it in the
 * command host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createToolCommandHandler } from "@oh-my-pi/pi-coding-agent/exec/tool-command-host";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveToolCommand, type ToolCommandState } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import type { ShellCommandRequest } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";

const GRANTED = "probe_lookup";
const UNGRANTED = "probe_fetch";

let temp: TempDir;

beforeEach(() => {
	temp = TempDir.createSync("@omp-scope-tool-commands-");
});
afterEach(() => {
	vi.restoreAllMocks();
	temp.removeSync();
});

function settingsFor(scope: PermissionScope): Settings {
	// yolo: the scope is the only thing that can refuse a call, so a refusal is the scope's.
	return scopedSettings(scope, { "tools.approvalMode": "yolo" });
}

/** The session's runner, built with the session's settings as `createAgentSession` builds it. */
function runner(settings: Settings): ExtensionRunner {
	const cwd = temp.path();
	const subject = new ExtensionRunner(
		[],
		new ExtensionRuntime(),
		cwd,
		SessionManager.inMemory(cwd),
		{} as ModelRegistry,
		undefined,
		settings,
	);
	subject.initialize(
		{} as Parameters<ExtensionRunner["initialize"]>[0],
		{} as Parameters<ExtensionRunner["initialize"]>[1],
		undefined,
		{ select: async () => "Approve" } as unknown as ExtensionUIContext,
	);
	return subject;
}

const querySchema = type({ query: "string" });

function commandTool(name: string, executed: string[]): AgentTool<typeof querySchema> {
	return {
		name,
		label: name,
		description: `${name} fixture tool command`,
		parameters: querySchema,
		approval: "read",
		async execute(_id, args) {
			executed.push(`${name}:${args.query}`);
			return { content: [{ type: "text", text: `${name} ran` }] };
		},
	};
}

/** Both tools mounted as commands with `bash` active; registry entries are wrapped as in a live session. */
function mountedSession(scope: PermissionScope, executed: string[], extra: Partial<ToolSession> = {}): ToolSession {
	const settings = settingsFor(scope);
	const wrapperRunner = runner(settings);
	const tools = new Map<string, Tool>();
	for (const name of [GRANTED, UNGRANTED]) {
		tools.set(name, new ExtensionToolWrapper(commandTool(name, executed), wrapperRunner) as Tool);
	}
	const toolCommands: ToolCommandState = {
		tools,
		mountedNames: new Set([GRANTED, UNGRANTED]),
		builtInNames: new Set(),
		isActive: () => false,
		resolve: name => resolveToolCommand(toolCommands, name),
	};
	return {
		cwd: temp.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		toolCommands,
		isToolActive: name => name === "bash",
		...extra,
	};
}

function request(name: string, argv: string[]): ShellCommandRequest {
	return { name, argv, cwd: temp.path(), stdin: "" };
}

function run(session: ToolSession, name: string, argv: string[]) {
	return createToolCommandHandler({ session, toolCallId: "bash-call" })(request(name, argv));
}

describe("mounted tool commands under a permission scope", () => {
	it("refuses a tool the allowlist does not grant, judged by its own name", async () => {
		const executed: string[] = [];
		const session = mountedSession(enforceScope({ tools: ["read", "bash", GRANTED] }), executed);

		const reply = await run(session, UNGRANTED, ["--query", "x"]);

		expect(reply.exitCode).toBe(1);
		expect(reply.stderr).toContain(`BLOCKED: Subagent permission profile does not allow tool '${UNGRANTED}'.`);
		expect(executed).toEqual([]);
	});

	it("runs a tool the allowlist grants", async () => {
		const executed: string[] = [];
		const session = mountedSession(enforceScope({ tools: ["read", "bash", GRANTED] }), executed);

		const reply = await run(session, GRANTED, ["--query", "x"]);

		expect(reply).toEqual({ stdout: `${GRANTED} ran\n`, stderr: "", exitCode: 0 });
		expect(executed).toEqual([`${GRANTED}:x`]);
	});

	it("refuses a tool the scope denies by name, though bash itself is allowed", async () => {
		const executed: string[] = [];
		const session = mountedSession(enforceScope({ denyTools: [UNGRANTED] }), executed);

		const denied = await run(session, UNGRANTED, ["--query", "x"]);
		const allowed = await run(session, GRANTED, ["--query", "y"]);

		expect(denied.exitCode).toBe(1);
		expect(denied.stderr).toContain(`BLOCKED: Subagent permission profile denied tool '${UNGRANTED}'.`);
		expect(allowed.exitCode).toBe(0);
		expect(executed).toEqual([`${GRANTED}:y`]);
	});
});

describe("special tool commands under a permission scope", () => {
	function specialSession(scope: PermissionScope, invocations: unknown[]): ToolSession {
		return mountedSession(scope, [], {
			peekPendingInvoker: () => async (input: unknown) => {
				invocations.push(input);
				return { content: [{ type: "text", text: "invoked" }] } satisfies AgentToolResult<unknown>;
			},
		});
	}

	it("refuses resolve when the allowlist does not grant it", async () => {
		const invocations: unknown[] = [];
		const session = specialSession(enforceScope({ tools: ["read", "bash"] }), invocations);

		const reply = await run(session, "resolve", ["ship it"]);

		expect(reply.exitCode).toBe(1);
		expect(reply.stderr).toContain("BLOCKED: Subagent permission profile does not allow tool 'resolve'.");
		expect(invocations).toEqual([]);
	});

	it("runs resolve when the allowlist grants it", async () => {
		const invocations: unknown[] = [];
		const session = specialSession(enforceScope({ tools: ["read", "bash", "resolve"] }), invocations);

		const reply = await run(session, "resolve", ["ship it"]);

		expect(reply.exitCode).toBe(0);
		expect(reply.stdout).toContain("invoked");
		expect(invocations).toEqual([{ action: "apply", reason: "ship it" }]);
	});

	it("refuses every special command while the scope does not decode", async () => {
		const invocations: unknown[] = [];
		const session = specialSession(enforceScope({ tools: ["read", "bash", "resolve"] }), invocations);
		const unreadable = Settings.isolated({
			"task.permissions.activeScope": "not json",
			"tools.approvalMode": "yolo",
		});

		const reply = await run({ ...session, settings: unreadable }, "resolve", ["ship it"]);

		expect(reply.exitCode).toBe(1);
		expect(reply.stderr).toContain("BLOCKED: Subagent permission scope is unreadable");
		expect(invocations).toEqual([]);
	});
});
