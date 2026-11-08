/**
 * A child spawned under an enforce-restricted subagent scope gets no extension or custom-tool code from
 * its parent: extension handlers run unconstrained by the scope's tool rules, and custom tool modules
 * execute when they load. Other children keep upstream's pass-through.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult, PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../../helpers/session-defaults";
import { enforceScope, scopedSettings } from "./scope-fixtures";

function yieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-1",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "done" }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
			return true;
		},
	} as unknown as AgentSession;
}

function sessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const extensionPath = "/parent/.omp/extensions/audit.ts";
const preparedExtensions: PreparedExtension[] = [
	{ path: extensionPath, resolvedPath: extensionPath, factory: () => {}, error: null },
];
const customToolPaths: ToolPathWithSource[] = [
	{ path: "/parent/.omp/tools/x.ts", source: { provider: "config", providerName: "Config", level: "project" } },
];

async function spawnUnder(settings: Settings) {
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(yieldingSession()));
	const result = await runSubprocess({
		cwd: "/tmp",
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "do work",
		index: 0,
		id: "ScopedSpawn",
		settings,
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		preloadedExtensionPaths: [extensionPath],
		preloadedPreparedExtensions: preparedExtensions,
		preloadedCustomToolPaths: customToolPaths,
	});
	expect(result.exitCode).toBe(0);
	return spy.mock.calls[0]?.[0];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("extension code for a child under a permission scope", () => {
	const restricted: PermissionScope = enforceScope({ tools: ["read"] });

	it("withholds prepared extensions, extension paths and custom tools from an enforce-restricted child", async () => {
		const forwarded = await spawnUnder(scopedSettings(restricted));

		expect(forwarded?.preloadedPreparedExtensions).toEqual([]);
		expect(forwarded?.preloadedExtensionPaths).toEqual([]);
		expect(forwarded?.preloadedCustomToolPaths).toEqual([]);
	});

	it("withholds them when the inherited scope does not decode", async () => {
		const forwarded = await spawnUnder(Settings.isolated({ "task.permissions.activeScope": "not a scope" }));

		expect(forwarded?.preloadedPreparedExtensions).toEqual([]);
	});

	it("passes them through to a child under a suggest scope", async () => {
		const forwarded = await spawnUnder(scopedSettings(enforceScope({ mode: "suggest", tools: ["read"] })));

		expect(forwarded?.preloadedPreparedExtensions).toBe(preparedExtensions);
		expect(forwarded?.preloadedExtensionPaths).toEqual([extensionPath]);
		expect(forwarded?.preloadedCustomToolPaths).toBe(customToolPaths);
	});
});
