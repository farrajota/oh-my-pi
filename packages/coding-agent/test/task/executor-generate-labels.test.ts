/**
 * `task.generateLabels: false` must keep runSubprocess from sending the auxiliary
 * label-model request, so a caller can account for every model request a task makes.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as taskLabel from "@oh-my-pi/pi-coding-agent/task/label";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

function yieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
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
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
			return true;
		},
	};
	return session as unknown as AgentSession;
}

function sessionResult(): CreateAgentSessionResult {
	return {
		session: yieldingSession(),
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

async function runWithSettings(settings: Settings) {
	return runSubprocess({
		cwd: "/tmp",
		agent,
		task: "Do the task.",
		assignment: "Do the task.",
		index: 0,
		id: "LabelTest",
		settings,
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	});
}

describe("runSubprocess task label generation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("generates a task label by default when an assignment is supplied", async () => {
		const settings = Settings.isolated();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult());
		const labelSpy = vi.spyOn(taskLabel, "generateTaskLabel").mockResolvedValue(null);

		const result = await runWithSettings(settings);

		expect(result.exitCode).toBe(0);
		expect(lookup("task.generateLabels")?.get(settings)).toBe(true);
		expect(labelSpy).toHaveBeenCalledTimes(1);
		expect(labelSpy).toHaveBeenCalledWith(
			"Do the task.",
			expect.anything(),
			settings,
			"LabelTest",
			expect.any(AbortSignal),
		);
	});

	it("sends no label-model request when task.generateLabels is false", async () => {
		const settings = Settings.isolated({ "task.generateLabels": false });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult());
		const labelSpy = vi.spyOn(taskLabel, "generateTaskLabel").mockResolvedValue(null);

		const result = await runWithSettings(settings);

		expect(result.exitCode).toBe(0);
		expect(labelSpy).not.toHaveBeenCalled();
	});
});
