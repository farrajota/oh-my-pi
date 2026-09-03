import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/** Narrow a successful omptype object result for property assertions. */
function parsedObject(parsed: unknown): Record<string, unknown> {
	if (parsed instanceof type.errors) throw new Error(`schema rejected input: ${parsed.summary}`);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected an object parse result");
	}
	return parsed as Record<string, unknown>;
}

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields and keeps model gated by
// `task.allowModelOverride`; dynamic schemas accept caller `model` only when
// that independent gate is enabled. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("accepts {agent, task}", () => {
		const parsed = parsedObject(taskSchema({ agent: "scout", task: "Map the auth module." }));
		expect(parsed.agent).toBe("scout");
	});

	it("defaults agent to `task` when omitted", () => {
		const parsed = parsedObject(taskSchema({ task: "Map the auth module." }));
		expect(parsed.agent).toBe("task");
	});

	it("defaults a custom agent name containing punctuation", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			defaultAgent: "qa's reviewer",
		});
		const parsed = parsedObject(schema({ task: "Map the auth module." }));
		expect(parsed.agent).toBe("qa's reviewer");
	});

	it("defaults custom agent names in batch items", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: true,
			defaultAgent: "review agent",
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});
		const parsed = parsedObject(schema({ context: "Shared context", tasks: [{ task: "Review the change." }] }));
		expect((parsed.tasks as Array<{ agent?: unknown }>)[0]?.agent).toBe("review agent");
	});

	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("retains caller outputSchema and schemaMode while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = parsedObject(
			taskSchema({
				agent: "scout",
				task: "Map the auth module.",
				outputSchema,
				schemaMode: "strict",
				context: "shared background",
				tasks: [{ name: "A", task: "..." }],
				schema: '{"properties":{}}',
			}),
		);
		expect(parsed.outputSchema).toEqual(outputSchema);
		expect(parsed.schemaMode).toBe("strict");
		// Unknown keys are stripped: batch/context exist only on the batch
		// schema and the per-call schema input was removed outright.
		expect("tasks" in parsed).toBe(false);
		expect("context" in parsed).toBe(false);
		expect("schema" in parsed).toBe(false);
	});

	it("retains structured output fields when permissions select a dynamic schema", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			defaultAgent: "task",
			permissions: { enabled: true, toolsEnabled: true, pathsEnabled: true },
		});
		const parsed = parsedObject(
			schema({
				task: "Map the auth module.",
				outputSchema,
				schemaMode: "strict",
				permissions: { denyTools: ["write"] },
			}),
		);
		expect(parsed.outputSchema).toEqual(outputSchema);
		expect(parsed.schemaMode).toBe("strict");
		expect(parsed.permissions).toEqual({ denyTools: ["write"] });
	});

	it("retains a request model only when the model gate is enabled", () => {
		const enabled = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			defaultAgent: "task",
			modelEnabled: true,
		});
		const parsed = parsedObject(enabled({ task: "Map the auth module.", model: "request/model" }));
		expect(parsed.model).toBe("request/model");
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});
});
