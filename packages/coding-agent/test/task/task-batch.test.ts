/**
 * Contracts: task.batch gating (batch spawning + shared context).
 *
 * 1. The wire schema is shape-swapped by `task.batch`: `{ context, tasks[] }`
 *    when on (per-spawn fields — including `model`, `isolated`, `outputSchema`, and
 *    `schemaMode` — live in the items), the flat form exposes those fields
 *    directly. The stale `schema` field is never accepted.
 * 2. Shape validation rejects stale `schema`, `tasks`/`context` while batch
 *    is disabled, top-level `task` in batch calls, empty/invalid items,
 *    duplicate names, and a missing shared `context`.
 * 3. With `async.enabled=true`, a batch call registers one background job per
 *    item; with `async.enabled=false`, it blocks and returns merged results.
 *    Both modes forward the shared `context`; the flat form stays accepted at
 *    runtime for internal callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { Effort, type ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	BROWSER_AUDIT_CORE_PACKAGE_IDENTITY,
	BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION,
	type BrowserAuditActor,
	type BrowserAuditAuthorization,
	type BrowserAuditDispatch,
	type BrowserAuditTuple,
} from "@oh-my-pi/pi-coding-agent/tools/browser-audit";
import type { BrowserAuditBindingInput } from "@oh-my-pi/pi-coding-agent/tools/browser-audit-production";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	bindBrowserAuditToolSession,
	installRegisteredBrowserAuditBinding,
	takeBrowserAuditRunCapability,
} from "../../src/internal/browser-audit-authority";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only research agent",
	systemPrompt: "You are a scout agent.",
	tools: ["read"],
	source: "bundled",
};

function createSession(
	options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
		agentId?: string;
		planMode?: boolean;
		taskDepth?: number;
		serviceTier?: ServiceTierByFamily;
		spawns?: string;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => options.agentId ?? null,
		getServiceTierByFamily: () => options.serviceTier,
		taskDepth: options.taskDepth,
		getPlanModeState: options.planMode ? () => ({ enabled: true }) : undefined,
	} as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const properties = toolWireSchema(tool).properties;
	return isRecord(properties) ? properties : {};
}

function getBatchItemProperties(tool: TaskTool): Record<string, unknown> {
	const tasks = getSchemaProperties(tool).tasks;
	if (!isRecord(tasks) || !isRecord(tasks.items) || !isRecord(tasks.items.properties)) return {};
	return tasks.items.properties;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(agent: AgentDefinition | AgentDefinition[] = taskAgent) {
	return vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: Array.isArray(agent) ? agent : [agent],
		projectAgentsDir: null,
	});
}
describe("task.batch schema gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.task).toBeDefined();
		expect(offProperties.name).toBeDefined();
		expect(offProperties.agentSource).toBeDefined();
		expect(offProperties.agentDefinitionSha256).toBeDefined();
		expect(offProperties.outputSchema).toBeDefined();
		expect(typeof offProperties.outputSchema).toBe("object");
		expect(offProperties.schemaMode).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const onProperties = getSchemaProperties(on);
		expect(onProperties.tasks).toBeDefined();
		expect(onProperties.context).toBeDefined();
		// The batch shape is { context, tasks[] } — the per-spawn fields live
		// only inside the task items.
		expect(onProperties.task).toBeUndefined();
		expect(onProperties.name).toBeUndefined();
		expect(onProperties.agent).toBeUndefined();
		expect(onProperties.outputSchema).toBeUndefined();
		expect(onProperties.schemaMode).toBeUndefined();
		const itemProperties = getBatchItemProperties(on);
		expect(itemProperties.task).toBeDefined();
		expect(itemProperties.name).toBeDefined();
		expect(itemProperties.agent).toBeDefined();
		expect(itemProperties.outputSchema).toBeDefined();
		expect(itemProperties.agentSource).toBeDefined();
		expect(itemProperties.agentDefinitionSha256).toBeDefined();
		expect(typeof itemProperties.outputSchema).toBe("object");
		expect(itemProperties.schemaMode).toBeDefined();
	});

	it("requires coordination instead of promising same-file auto-resolution", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));

		expect(tool.description).toContain("Same-file edits are not guaranteed to merge");
		expect(tool.description).toContain("coordinate through `hub` before editing shared files");
		expect(tool.description).toContain("Name one integration owner");
		expect(tool.description).not.toContain("Concurrent edits to the same files auto-resolve");
	});

	it("describes a restricted specialist as the spawn-policy default", async () => {
		mockDiscovery(scoutAgent);
		const tool = await TaskTool.create(createSession({ spawns: "scout" }));

		expect(tool.description).toContain("spawn-policy default (`scout`)");
		expect(tool.description).not.toContain("general-purpose worker");
		expect(tool.description).not.toContain("default worker");
		expect(tool.description).toContain("Omit `agent` when the spawn-policy default is the best fit");
		expect(tool.description).toContain("### scout (READ-ONLY)");
	});

	it("hides effort by default and exposes it when task.allowEffortOverride is enabled", async () => {
		mockDiscovery();

		const flatSession = createSession({ settings: { "task.batch": false, "task.allowEffortOverride": false } });
		const flat = await TaskTool.create(flatSession);
		expect(getSchemaProperties(flat).effort).toBeUndefined();
		expect(flat.description).not.toContain("`effort`");

		flatSession.settings.override("task.allowEffortOverride", true);
		expect(getSchemaProperties(flat).effort).toBeDefined();
		expect(flat.description).toContain("`effort`");

		const batchSession = createSession({ settings: { "task.batch": true, "task.allowEffortOverride": false } });
		const batch = await TaskTool.create(batchSession);
		expect(getBatchItemProperties(batch).effort).toBeUndefined();
		expect(batch.description).not.toContain("`effort`");

		batchSession.settings.override("task.allowEffortOverride", true);
		expect(getBatchItemProperties(batch).effort).toBeDefined();
		expect(batch.description).toContain("`effort`");
	});
	it("shows independent effort/model wire fields for all four authorization combinations", async () => {
		mockDiscovery();
		const policies: Array<{
			allowEffortOverride: boolean;
			allowModelOverride: boolean;
			effortEnabled: boolean;
			modelEnabled: boolean;
		}> = [
			{ allowEffortOverride: false, allowModelOverride: false, effortEnabled: false, modelEnabled: false },
			{ allowEffortOverride: false, allowModelOverride: true, effortEnabled: false, modelEnabled: true },
			{ allowEffortOverride: true, allowModelOverride: false, effortEnabled: true, modelEnabled: false },
			{ allowEffortOverride: true, allowModelOverride: true, effortEnabled: true, modelEnabled: true },
		];

		for (const policy of policies) {
			for (const batchEnabled of [false, true]) {
				const settings: Record<string, unknown> = {
					"task.batch": batchEnabled,
					"task.allowEffortOverride": policy.allowEffortOverride,
					"task.allowModelOverride": policy.allowModelOverride,
				};
				const tool = await TaskTool.create(createSession({ settings }));
				const properties = getSchemaProperties(tool);
				const itemProperties = getBatchItemProperties(tool);
				const effort = batchEnabled ? itemProperties.effort : properties.effort;
				const model = batchEnabled ? itemProperties.model : properties.model;

				if (policy.effortEnabled) {
					expect(effort).toBeDefined();
					expect(tool.description).toContain("- `effort`:");
				} else {
					expect(effort).toBeUndefined();
					expect(tool.description).not.toContain("- `effort`:");
				}
				if (policy.modelEnabled) {
					expect(model).toBeDefined();
					expect(tool.description).toContain("- `model`:");
				} else {
					expect(model).toBeUndefined();
					expect(tool.description).not.toContain("- `model`:");
				}
			}
		}
	});

	it("keeps dynamic schema cache entries separate for each effort/model gate combination", async () => {
		mockDiscovery();
		const createDynamicTool = (spawns: string, allowEffortOverride: boolean, allowModelOverride: boolean) =>
			TaskTool.create(
				createSession({
					spawns,
					settings: {
						"task.batch": false,
						"task.allowEffortOverride": allowEffortOverride,
						"task.allowModelOverride": allowModelOverride,
					},
				}),
			);

		const disabledDisabled = await createDynamicTool("schema-cache-dd", false, false);
		const disabledEnabled = await createDynamicTool("schema-cache-de", false, true);
		const enabledDisabled = await createDynamicTool("schema-cache-ed", true, false);
		const enabledEnabled = await createDynamicTool("schema-cache-ee", true, true);
		const disabledDisabledAgain = await createDynamicTool("schema-cache-dd", false, false);

		expect(disabledDisabled.parameters).toBe(disabledDisabledAgain.parameters);
		for (const [tool, effort, model] of [
			[disabledDisabled, false, false],
			[disabledEnabled, false, true],
			[enabledDisabled, true, false],
			[enabledEnabled, true, true],
		] as const) {
			const properties = getSchemaProperties(tool);
			expect(properties.effort !== undefined).toBe(effort);
			expect(properties.model !== undefined).toBe(model);
		}
		expect(disabledDisabled.parameters).not.toBe(disabledEnabled.parameters);
		expect(disabledDisabled.parameters).not.toBe(enabledDisabled.parameters);
		expect(disabledEnabled.parameters).not.toBe(enabledEnabled.parameters);
		expect(enabledDisabled.parameters).not.toBe(enabledEnabled.parameters);
	});

	it("keeps isolation boolean-only in the batch item schema", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.isolation.mode": "auto" } }),
		);
		const properties = getSchemaProperties(tool);
		expect(properties.isolated).toBeUndefined();
		const itemProperties = getBatchItemProperties(tool);
		const isolatedSchema = itemProperties.isolated;
		if (!isolatedSchema || typeof isolatedSchema !== "object" || !("type" in isolatedSchema)) {
			throw new Error("Expected isolated to be a boolean schema");
		}
		expect(isolatedSchema.type).toBe("boolean");
		expect(itemProperties.apply).toBeUndefined();
	});

	it("hides isolation from the dynamic batch schema in plan mode", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(
			createSession({
				planMode: true,
				settings: { "task.batch": true, "task.isolation.mode": "auto" },
			}),
		);
		const itemProperties = getBatchItemProperties(tool);
		expect(itemProperties.isolated).toBeUndefined();
		expect(tool.description).not.toContain("`isolated`");
	});

	it("exposes outputSchema but never the stale schema field", async () => {
		mockDiscovery();

		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(getSchemaProperties(flat).outputSchema).toBeDefined();
		expect(getSchemaProperties(flat).schema).toBeUndefined();

		const batch = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		expect(getSchemaProperties(batch).schema).toBeUndefined();
	});
});

describe("task.batch validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, settings: Record<string, unknown> = {}): Promise<string> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const result = await tool.execute("tool-call", params);
		return getFirstText(result);
	}

	it("rejects the stale schema argument regardless of batch mode", async () => {
		for (const batch of [false, true]) {
			const text = await executeText(
				{ agent: "task", task: "Work.", schema: '{"properties":{}}' },
				{ "task.batch": batch },
			);
			expect(text).toContain("uses `outputSchema`");
		}
	});

	it("rejects tasks and context while task.batch is disabled", async () => {
		const disabled = { "task.batch": false };
		const text = await executeText({ agent: "task", tasks: [{ task: "Work." }] }, disabled);
		expect(text).toContain("task.batch is disabled");

		const contextText = await executeText({ agent: "task", task: "Work.", context: "Background." }, disabled);
		expect(contextText).toContain("task.batch is disabled");
	});

	it("rejects top-level task in the batch shape", async () => {
		const text = await executeText({ task: "Work.", tasks: [{ task: "Other." }] }, { "task.batch": true });
		expect(text).toContain("not part of the batch shape");
	});

	it("rejects empty task arrays and items without tasks", async () => {
		const empty = await executeText({ tasks: [] }, { "task.batch": true });
		expect(empty).toContain("Missing `tasks`");

		const missing = await executeText({ tasks: [{ task: "Work." }, { name: "Beta" }] }, { "task.batch": true });
		expect(missing).toContain("Task 2 (`Beta`) is missing `task`");
	});

	it("requires a shared context for batch calls", async () => {
		const text = await executeText({ tasks: [{ task: "Work." }] }, { "task.batch": true });
		expect(text).toContain("Missing `context`");
	});

	it("rejects duplicate provided names case-insensitively", async () => {
		const text = await executeText(
			{
				tasks: [
					{ name: "Anna", task: "A." },
					{ name: "anna", task: "B." },
				],
			},
			{ "task.batch": true },
		);
		expect(text).toContain("Duplicate task name");
	});

	it("marks lenientArgValidation so execute() surfaces the actionable shape error", async () => {
		// Regression (#6039): the flat single-spawn wire schema carries
		// `"+": "delete"`, so a batch `{ context, tasks[] }` payload is stripped
		// by arktype and rejected as `task must be a string (was missing)` in the
		// agent loop — preempting the tool's own actionable message. The lenient
		// flag makes the loop forward the raw args to execute() on that failure.
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(tool.lenientArgValidation).toBe(true);

		// The raw batch payload the loop would forward reaches execute() and
		// yields the actionable reason, never arktype's misleading missing-`task`.
		const text = await executeText(
			{ context: "Background.", tasks: [{ name: "Alpha", task: "Work." }] },
			{ "task.batch": false },
		);
		expect(text).toContain("task.batch is disabled");
		expect(text).not.toContain("was missing");
	});

	it("rejects invalid effort even when task effort overrides are disabled", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const flatText = await executeText(
			{ agent: "task", task: "Work.", effort: "invalid" },
			{ "task.batch": false, "task.allowEffortOverride": false },
		);
		expect(flatText).toContain('invalid `effort` value "invalid"');

		const batchText = await executeText(
			{ context: "Background.", tasks: [{ task: "Work.", effort: "invalid" }] },
			{ "task.batch": true, "task.allowEffortOverride": false },
		);
		expect(batchText).toContain('invalid `effort` value "invalid"');
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("rejects disabled stale model fields before jobs or subprocesses are created", async () => {
		mockDiscovery();
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		for (const batch of [false, true]) {
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			try {
				const tool = await TaskTool.create(
					createSession({
						manager,
						settings: { "async.enabled": true, "task.batch": batch, "task.allowModelOverride": false },
					}),
				);
				const params = batch
					? { context: "ctx", tasks: [{ name: "StaleModel", task: "Work.", model: "manual/model" }] }
					: { agent: "task", name: "StaleModel", task: "Work.", model: "manual/model" };
				const result = await tool.execute(`disabled-model-${batch}`, params);
				const text = getFirstText(result);
				expect(text.toLowerCase()).toContain("model");
				expect(runSpy).not.toHaveBeenCalled();
				expect(manager.getJob("StaleModel")).toBeUndefined();
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		}
	});

	it("rejects disabled flat and batch model fields through the raw validator", async () => {
		mockDiscovery();
		const flat = await TaskTool.create(
			createSession({ settings: { "task.batch": false, "task.allowModelOverride": false } }),
		);
		const batch = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.allowModelOverride": false } }),
		);
		const error = new Error(
			"Task model overrides are disabled. Enable task.allowModelOverride before using `model`.",
		);

		expect(() => flat.validateRawArguments({ agent: "task", task: "Work.", model: "manual/model" })).toThrow(error);
		expect(() =>
			batch.validateRawArguments({
				context: "Background.",
				tasks: [{ name: "Manual", task: "Work.", model: "manual/model" }],
			}),
		).toThrow(error);
	});

	it("rejects empty and comma-separated model selectors", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		for (const model of ["", "   ", "first/model,second/model"]) {
			const text = await executeText(
				{ agent: "task", task: "Work.", model },
				{ "task.batch": false, "task.allowModelOverride": true },
			);
			expect(text.toLowerCase()).toContain("model");
		}
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("rejects malformed disabled effort through the raw validator while accepting valid selectors", async () => {
		mockDiscovery();
		const flat = await TaskTool.create(
			createSession({ settings: { "task.batch": false, "task.allowEffortOverride": false } }),
		);
		const batch = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.allowEffortOverride": false } }),
		);

		expect(() => flat.validateRawArguments({ agent: "task", task: "Work.", effort: "invalid" })).toThrow(
			new Error('The call has an invalid `effort` value "invalid". Use "lo", "med", or "hi".'),
		);
		expect(() =>
			batch.validateRawArguments({
				context: "Background.",
				tasks: [{ name: "Invalid", task: "Work.", effort: "invalid" }],
			}),
		).toThrow(new Error('Task 1 (`Invalid`) has an invalid `effort` value "invalid". Use "lo", "med", or "hi".'));

		expect(() => {
			for (const effort of ["lo", "med", "hi"] as const) {
				flat.validateRawArguments({ agent: "task", task: "Work.", effort });
			}
			batch.validateRawArguments({
				context: "Background.",
				tasks: [
					{ task: "Do low work.", effort: "lo" },
					{ task: "Do medium work.", effort: "med" },
					{ task: "Do high work.", effort: "hi" },
				],
			});
		}).not.toThrow();
	});
});

describe("task.batch spawning", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});
	it("spawns one background job per task item and forwards independent models and schemas with shared context", async () => {
		mockDiscovery({
			...taskAgent,
			output: { type: "object", properties: { staleAgentOutput: { type: "boolean" } } },
		});
		const seen: Array<{
			id?: string;
			context?: string;
			assignment?: string;
			parentAgentId?: string;
			requestedModel?: string;
			exactModelOverride?: boolean;
			effort?: TaskParams["effort"];
			outputSchema?: unknown;
			outputSchemaMode?: "permissive" | "strict";
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				parentAgentId: options.parentAgentId,
				requestedModel: options.requestedModel,
				exactModelOverride: options.exactModelOverride,
				effort: options.effort,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				agentId: "ParentA",
				settings: {
					"async.enabled": true,
					"task.batch": true,
					"task.allowEffortOverride": true,
					"task.allowModelOverride": true,
					"task.agentModelOverrides": { task: "settings/model" },
				},
			}),
		);
		const alphaSchema = { type: "object", properties: { alpha: { type: "string" } } };
		const betaSchema = { type: "object", properties: { beta: { type: "number" } } };
		const result = await tool.execute("tc-batch", {
			context: "# Goal\nShared background.",
			tasks: [
				{
					name: "Alpha",
					task: "Do A.",
					model: "request/alpha",
					effort: "lo",
					outputSchema: alphaSchema,
					schemaMode: "strict",
				},
				{
					name: "Beta",
					task: "Do B.",
					effort: "hi",
					model: "request/beta",
					outputSchema: betaSchema,
					schemaMode: "permissive",
				},
			],
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain("Spawned 2 background agents");
		expect(text).toContain("- `Alpha`");
		expect(text).toContain("- `Beta`");
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(result.details?.progress?.map(progress => progress.requestedModel)).toEqual([
			"request/alpha",
			"request/beta",
		]);
		expect(result.details?.async?.state).toBe("running");

		const alphaJob = manager.getJob("Alpha");
		const betaJob = manager.getJob("Beta");
		expect(alphaJob).toBeDefined();
		expect(betaJob).toBeDefined();
		await alphaJob!.promise;
		await betaJob!.promise;

		expect(seen).toHaveLength(2);
		for (const spawn of seen) {
			expect(spawn.context).toBe("# Goal\nShared background.");
			expect(spawn.outputSchemaSource).toBe("caller");
			expect(spawn.outputSchemaOverridesAgent).toBe(true);
		}
		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		expect(byId.get("Alpha")?.outputSchema).toEqual(alphaSchema);
		expect(byId.get("Alpha")?.outputSchemaMode).toBe("strict");
		expect(byId.get("Beta")?.outputSchema).toEqual(betaSchema);
		expect(byId.get("Beta")?.outputSchemaMode).toBe("permissive");
		expect(byId.get("Alpha")?.requestedModel).toBe("request/alpha");
		expect(byId.get("Beta")?.requestedModel).toBe("request/beta");
		expect(byId.get("Alpha")?.exactModelOverride).toBe(true);
		expect(byId.get("Beta")?.exactModelOverride).toBe(true);
		expect(byId.get("Alpha")?.effort).toBe("lo");
		expect(byId.get("Beta")?.effort).toBe("hi");
		expect(seen.map(spawn => spawn.assignment).sort()).toEqual(["Do A.", "Do B."]);
		for (const spawn of seen) expect(spawn.parentAgentId).toBe("ParentA");
	});

	it("accepts valid batch effort but omits it from executor options when overrides are disabled", async () => {
		mockDiscovery();
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "async.enabled": true, "task.batch": true, "task.allowEffortOverride": false },
			}),
		);
		const result = await tool.execute("tc-batch-disabled-effort", {
			context: "Shared background.",
			tasks: [
				{ name: "NoLow", task: "Do low effort work.", effort: "lo" },
				{ name: "NoHigh", task: "Do high effort work.", effort: "hi" },
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned 2 background agents");
		const lowJob = manager.getJob("NoLow")!;
		const highJob = manager.getJob("NoHigh")!;
		await Promise.all([lowJob.promise, highJob.promise]);
		expect(lowJob.status).toBe("completed");
		expect(highJob.status).toBe("completed");
		expect(runSpy).toHaveBeenCalledTimes(2);
		for (const [options] of runSpy.mock.calls) {
			expect(options).not.toHaveProperty("effort");
		}
	});

	it("routes each mixed-agent item through its selected definition while preserving caller overrides", async () => {
		const scoutSchema = { type: "object", properties: { findings: { type: "array" } } };
		const reviewerSchema = { type: "object", properties: { verdict: { type: "string" } } };
		const callerSchema = { type: "object", properties: { approved: { type: "boolean" } } };
		const scoutAgent: AgentDefinition = {
			...taskAgent,
			name: "scout",
			description: "Read-only scout",
			systemPrompt: "Investigate the assigned target.",
			tools: ["read"],
			model: ["anthropic/claude-haiku-4-5:low"],
			output: scoutSchema,
		};
		const reviewerAgent: AgentDefinition = {
			...taskAgent,
			name: "reviewer",
			description: "Code review specialist",
			systemPrompt: "Review the assigned target.",
			tools: ["read", "bash"],
			model: ["anthropic/claude-sonnet-4-6:medium"],
			output: reviewerSchema,
		};
		mockDiscovery([scoutAgent, reviewerAgent]);

		const seen: Array<{
			id?: string;
			agent: AgentDefinition;
			requestedModel?: string;
			modelOverride?: string | string[];
			outputSchema?: unknown;
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				agent: options.agent,
				requestedModel: options.requestedModel,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?", { agent: options.agent.name });
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);
		const result = await tool.execute("tc-mixed-agents", {
			context: "Shared routing context.",
			tasks: [
				{ name: "Scout", agent: "scout", task: "Investigate." },
				{
					name: "Review",
					agent: "reviewer",
					task: "Review.",
					outputSchema: callerSchema,
				},
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned 2 background agents");
		await Promise.all([manager.getJob("Scout")!.promise, manager.getJob("Review")!.promise]);

		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		const scoutSpawn = byId.get("Scout");
		const reviewerSpawn = byId.get("Review");
		expect(scoutSpawn?.agent).toEqual(scoutAgent);
		expect(scoutSpawn?.agent.tools).toEqual(["read"]);
		expect(scoutSpawn?.requestedModel).toBeUndefined();
		expect(scoutSpawn?.modelOverride).toEqual(["anthropic/claude-haiku-4-5:low"]);
		expect(scoutSpawn?.outputSchema).toBe(scoutSchema);
		expect(scoutSpawn?.outputSchemaSource).toBe("agent");
		expect(scoutSpawn?.outputSchemaOverridesAgent).toBe(false);
		expect(reviewerSpawn?.agent).toEqual(reviewerAgent);
		expect(reviewerSpawn?.agent.tools).toEqual(["read", "bash"]);
		expect(reviewerSpawn?.requestedModel).toBeUndefined();
		expect(reviewerSpawn?.modelOverride).toEqual(["anthropic/claude-sonnet-4-6:medium"]);
		expect(reviewerSpawn?.outputSchema).toBe(callerSchema);
		expect(reviewerSpawn?.outputSchemaSource).toBe("caller");
		expect(reviewerSpawn?.outputSchemaOverridesAgent).toBe(true);
	});

	it("treats a one-item batch as a single spawn and forwards context", async () => {
		mockDiscovery();
		let capturedContext: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedContext = options.context;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-single", {
			context: "Shared notes.",
			tasks: [{ name: "Solo", task: "Do the thing." }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Solo`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(capturedContext).toBe("Shared notes.");
	});

	it("accepts the flat single-spawn form at runtime under batch mode", async () => {
		// Internal callers (e.g. the commit flow) and stale transcripts use the
		// flat shape directly; the wire schema is batch-only but runtime is not.
		mockDiscovery({
			...taskAgent,
			model: ["anthropic/claude-sonnet-4"],
			output: { type: "object", properties: { agent: { type: "string" } } },
		});
		let captured:
			| {
					requestedModel?: string;
					modelOverride?: string | string[];
					outputSchema?: unknown;
					outputSchemaMode?: "permissive" | "strict";
					outputSchemaSource?: "caller" | "agent" | "session" | "none";
					outputSchemaOverridesAgent?: boolean;
			  }
			| undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = {
				requestedModel: options.requestedModel,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			};
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"async.enabled": true,
					"task.batch": true,
					"task.agentModelOverrides": { task: "openai/gpt-4.1-mini" },
				},
			}),
		);

		const callerSchema = { type: "object", properties: { caller: { type: "number" } } };
		const result = await tool.execute("tc-flat", {
			agent: "task",
			name: "Flat",
			task: "Do the thing.",
			outputSchema: callerSchema,
			schemaMode: "strict",
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Flat`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(captured?.requestedModel).toBeUndefined();
		expect(captured?.modelOverride).toEqual(["openai/gpt-4.1-mini"]);
		expect(captured?.outputSchema).toEqual(callerSchema);
		expect(captured?.outputSchemaMode).toBe("strict");
		expect(captured?.outputSchemaSource).toBe("caller");
		expect(captured?.outputSchemaOverridesAgent).toBe(true);
	});

	it("blocks batch execution when async.enabled is false even with a job manager", async () => {
		mockDiscovery();
		const seen: Array<{
			id?: string;
			context?: string;
			assignment?: string;
			modelOverride?: string | string[];
			requestedModel?: string;
		}> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				modelOverride: options.modelOverride,
				requestedModel: options.requestedModel,
			});
			return makeResult(options.id ?? "?", {
				requestedModel: options.requestedModel,
				resolvedModel: `resolved/${options.id ?? "?"}`,
			});
		});
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "async.enabled": false, "task.batch": true, "task.allowModelOverride": true },
			}),
		);

		const result = await tool.execute("tc-sync-batch", {
			context: "# Goal\nShared synchronous context.",
			tasks: [
				{ name: "Alpha", task: "Do A.", model: "request/alpha" },
				{ name: "Beta", task: "Do B.", model: "request/beta" },
				{ name: "Gamma", task: "Do C." },
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("All done.");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(item => item.id).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
		expect(result.details?.results.map(item => item.requestedModel)).toEqual([
			"request/alpha",
			"request/beta",
			undefined,
		]);
		expect(result.details?.results.map(item => item.resolvedModel)).toEqual([
			"resolved/Alpha",
			"resolved/Beta",
			"resolved/Gamma",
		]);
		expect(manager.getJob("Alpha")).toBeUndefined();
		expect(manager.getJob("Beta")).toBeUndefined();
		expect(seen.map(spawn => spawn.context)).toEqual([
			"# Goal\nShared synchronous context.",
			"# Goal\nShared synchronous context.",
			"# Goal\nShared synchronous context.",
		]);
		expect(new Map(seen.map(spawn => [spawn.id, spawn])).get("Alpha")?.requestedModel).toBe("request/alpha");
		expect(new Map(seen.map(spawn => [spawn.id, spawn])).get("Beta")?.requestedModel).toBe("request/beta");
		expect(new Map(seen.map(spawn => [spawn.id, spawn])).get("Gamma")?.requestedModel).toBeUndefined();
	});

	it("keeps a long result inline when no readable output artifact exists", async () => {
		mockDiscovery();
		const fullOutput = `REPORT:${"x".repeat(6_000)}:END`;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", {
				output: fullOutput,
				outputMeta: { lineCount: 1, charCount: fullOutput.length },
			}),
		);

		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const result = await tool.execute("tc-missing-artifact", {
			name: "MissingArtifact",
			task: "Return a long report.",
		} as TaskParams);
		const text = getFirstText(result);

		expect(text).not.toContain("agent://MissingArtifact");
		expect(text).toContain(":END");
	});

	it("settles the batch async aggregate when a queued spawn is cancelled mid-flight", async () => {
		mockDiscovery();
		const started: string[] = [];
		const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.set(id, { promise, resolve });
			await promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "async.enabled": true, "task.batch": true, "task.maxConcurrency": 1 },
			}),
		);

		const updates: Array<{ async?: { state?: string }; progress?: Array<{ id: string; status: string }> }> = [];
		const result = await tool.execute(
			"tc-batch-cancel",
			{
				context: "ctx",
				tasks: [
					{ name: "First", task: "Do A." },
					{ name: "Second", task: "Do B." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) {
					updates.push({
						async: update.details.async,
						progress: update.details.progress?.map(p => ({ id: p.id, status: p.status })),
					});
				}
			},
		);

		expect(result.details?.async?.state).toBe("running");

		const firstJob = manager.getJob("First")!;
		const secondJob = manager.getJob("Second")!;
		const deadline = Date.now() + 1_000;
		while (started.length === 0) {
			if (Date.now() > deadline) throw new Error("First spawn never reached the executor");
			await Bun.sleep(5);
		}
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;

		gates.get("First")!.resolve();
		await firstJob.promise;

		expect(secondJob.status).toBe("cancelled");
		const last = updates.at(-1);
		// The acquire-time abort path has to flow through the same `onSettled`
		// the post-acquire abort path uses, otherwise the batch aggregate sticks
		// at "running" forever after the surviving spawn completes.
		expect(last?.async?.state).toBe("failed");
		expect(last?.progress?.find(p => p.id === "Second")?.status).toBe("aborted");
		expect(last?.progress?.find(p => p.id === "First")?.status).toBe("completed");

		runSubprocess.mockImplementation(async options => {
			started.push(options.id ?? "?");
			return makeResult(options.id ?? "?");
		});
		const retryParams = {
			context: "retry",
			tasks: [{ name: "Second", agent: "task", task: "Retry B." }],
		} as TaskParams;
		const retryPreparation = await tool.prepareExecution(
			"tc-cancelled-id-reuse",
			retryParams,
			undefined,
			undefined,
			{},
		);
		const retryResult = await tool.execute(
			"tc-cancelled-id-reuse",
			retryParams,
			undefined,
			undefined,
			undefined,
			retryPreparation,
		);
		const retryJobId = retryResult.details?.async?.jobId;
		expect(retryJobId).toBeDefined();
		expect(retryJobId).toBe("Second-2");
		const retryJob = manager.getJob(retryJobId!);
		expect(retryJob).toBeDefined();
		await retryJob!.promise;
		expect(retryJob!.errorText).toBeUndefined();
		expect(retryJob!.status).toBe("completed");
		expect(started).toEqual(["First", "Second"]);
	});
});

describe("task exact preparation", () => {
	const managers: AsyncJobManager[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
	});

	it("binds prepared state to one tool call and rejects replay", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const params = { name: "Pinned", agent: "task", task: "Do exact work." } as TaskParams;
		const prepared = await tool.prepareExecution("call-pinned", params, undefined, undefined, {});

		const wrongCall = await tool.execute("call-other", params, undefined, undefined, undefined, prepared);
		expect(getFirstText(wrongCall)).toContain("execution key does not match");

		const result = await tool.execute("call-pinned", params, undefined, undefined, undefined, prepared);
		expect(result.details?.results.map(item => item.id)).toEqual(["Pinned"]);

		const replay = await tool.execute("call-pinned", params, undefined, undefined, undefined, prepared);
		expect(getFirstText(replay)).toContain("already disposed");

		await expect(tool.prepareExecution("call-pinned", params, undefined, undefined, {})).rejects.toThrow(
			"already has prepared execution state",
		);
	});

	it("claims the call key before asynchronous preparation", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const params = { name: "Concurrent", agent: "task", task: "Do exact work." } as TaskParams;
		const first = tool.prepareExecution("call-concurrent", params, undefined, undefined, {});

		await expect(tool.prepareExecution("call-concurrent", params, undefined, undefined, {})).rejects.toThrow(
			"already has prepared execution state",
		);
		await (await first).dispose();
	});

	it("rolls back the call key and output id after preparation failure", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const tool = await TaskTool.create(
			createSession({
				settings: { "async.enabled": false, "task.batch": false, "task.permissions.mode": "enforce" },
			}),
		);
		const invalid = {
			name: "PreparedFailure",
			agent: "task",
			task: "Fail preparation.",
			permissions: { profiles: ["missing-profile"] },
		} as TaskParams;
		await expect(
			tool.prepareExecution("call-preparation-retry", invalid, undefined, undefined, {}),
		).rejects.toThrow();
		const valid = { name: "PreparedFailure", agent: "task", task: "Retry preparation." } as TaskParams;
		const prepared = await tool.prepareExecution("call-preparation-retry", valid, undefined, undefined, {});

		const result = await tool.execute("call-preparation-retry", valid, undefined, undefined, undefined, prepared);

		expect(result.details?.results.map(item => item.id)).toEqual(["PreparedFailure"]);
	});

	it("freezes descriptor-read project agent bytes before execution", async () => {
		const temp = TempDir.createSync("@task-pinned-agent-");
		try {
			const targetPath = temp.join("browser-audit-specialist-target.md");
			const filePath = temp.join("browser-audit-specialist.md");
			fs.writeFileSync(
				targetPath,
				"---\nname: browser-audit-specialist\ndescription: Browser audit\n---\nFrozen prompt.\n",
			);
			fs.symlinkSync(targetPath, filePath);
			const bytes = fs.readFileSync(targetPath);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const projectAgent: AgentDefinition = {
				name: "browser-audit-specialist",
				description: "Browser audit",
				systemPrompt: "Stale discovery prompt.",
				source: "project",
				filePath,
			};
			mockDiscovery(projectAgent);
			let executedPrompt: string | undefined;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				executedPrompt = options.agent.systemPrompt;
				return makeResult(options.id ?? "?", { agent: projectAgent.name, agentSource: "project" });
			});
			const tool = await TaskTool.create(
				createSession({
					planMode: true,
					settings: {
						"async.enabled": false,
						"task.batch": false,
						"task.allowModelOverride": true,
						"task.agentModelOverrides": { "browser-audit-specialist": "fixture/model" },
					},
				}),
			);
			const params = {
				name: "FrozenAgent",
				agent: projectAgent.name,
				agentSource: "project",
				agentDefinitionSha256: sha256,
				task: "Audit exact bytes.",
				model: "pi/task",
			} as TaskParams;
			await expect(
				tool.prepareExecution(
					"call-stale-hash",
					{ ...params, agentDefinitionSha256: "0".repeat(64) },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow("SHA-256 mismatch");
			const prepared = await tool.prepareExecution("call-frozen", params, undefined, undefined, {});
			fs.writeFileSync(
				targetPath,
				"---\nname: browser-audit-specialist\ndescription: Browser audit\n---\nChanged prompt.\n",
			);

			const result = await tool.execute("call-frozen", params, undefined, undefined, undefined, prepared);

			expect(result.details?.results[0]?.agentSource).toBe("project");
			expect(executedPrompt).toContain("Frozen prompt.");
			expect(executedPrompt).not.toContain("Stale discovery prompt.");
		} finally {
			temp.removeSync();
		}
	});

	it("issues one browser audit capability through the registered Task and child factories", async () => {
		const temp = TempDir.createSync("@task-audit-binding-");
		try {
			const filePath = temp.join("browser-audit-specialist.md");
			fs.writeFileSync(
				filePath,
				"---\nname: browser-audit-specialist\ndescription: Browser audit\ntools: [browser_audit]\nblocking: true\n---\nAudit only through the reserved tool.\n",
			);
			const sha256 = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
			mockDiscovery({
				name: "browser-audit-specialist",
				description: "Browser audit",
				systemPrompt: "stale",
				source: "user",
				filePath,
			});
			let capturedOptions: executorModule.ExecutorOptions | undefined;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				capturedOptions = options;
				const nativeSession = createSession({ agentId: options.id });
				const capability = takeBrowserAuditRunCapability(options.agent);
				bindBrowserAuditToolSession(nativeSession, capability);
				const childTool = await BUILTIN_TOOLS.browser_audit(nativeSession);
				expect(childTool?.name).toBe("browser_audit");
				bindBrowserAuditToolSession(nativeSession, capability);
				expect(() => BUILTIN_TOOLS.browser_audit(nativeSession)).toThrow(
					"activation is not bound to this registry authority",
				);
				return makeResult(options.id ?? "?", { agent: options.agent.name, agentSource: options.agent.source });
			});
			const session = createSession({
				agentId: "parent",
				settings: {
					"async.enabled": false,
					"task.batch": false,
					"task.allowModelOverride": true,
					"task.permissions.mode": "enforce",
				},
			});
			const registered = await BUILTIN_TOOLS.task(session);
			if (!(registered instanceof TaskTool)) throw new Error("registered Task factory did not create TaskTool");
			const params = {
				name: "AuditBound",
				agent: "browser-audit-specialist",
				agentSource: "user",
				agentDefinitionSha256: sha256,
				task: "Audit exact artifact.",
				model: "pi/slow",
				toolProfile: "browser-audit",
				permissions: { profiles: ["browser-audit"], tools: ["browser_audit"] },
			} as TaskParams;
			const executionKey = {};
			const prepared = await registered.prepareExecution(
				"call-audit-bound",
				params,
				undefined,
				undefined,
				executionKey,
			);
			const spawnId = prepared.metadata?.spawnId;
			if (typeof spawnId !== "string") throw new Error("prepared audit spawn ID is missing");
			const toolCallFingerprint = prepared.metadata?.toolCallFingerprint;
			if (typeof toolCallFingerprint !== "string") throw new Error("prepared audit fingerprint is missing");
			const actor: BrowserAuditActor = { actor_kind: "sub", actor_id: spawnId, parent_actor_id: "parent" };
			const dispatch: BrowserAuditDispatch = {
				schema: "browser-audit-dispatch/v2",
				audit_id: "browser-audit-00000000000000aa",
				request_sha256: "a".repeat(64),
				task_sha256: "b".repeat(64),
				request_byte_count: 1,
				task_byte_count: 1,
				agent_source: "user",
				agent_logical_path: "agents/browser-audit-specialist.md",
				agent_definition_sha256: sha256,
				tool_origin_class: "builtin",
				tool_implementation_revision: BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION,
				core_package_identity: BROWSER_AUDIT_CORE_PACKAGE_IDENTITY,
				expected_spawn_id: spawnId,
				expected_parent_actor_id: "parent",
				tool_call_fingerprint: toolCallFingerprint,
			};
			const authorization: BrowserAuditAuthorization = {
				document_locators: ["https://example.test/audit"],
				origins: ["https://example.test"],
				route_states: [
					{
						route_state_id: "route",
						locator: "https://example.test/audit",
						state_assertions: [],
						allowed_action_ids: [],
					},
				],
				viewports: [{ viewport_id: "viewport", width: 800, height: 600, device_scale_factor: 1 }],
				actions: [],
				mutation_policy: { mode: "deny", allowed_action_ids: [] },
				credential_policy: { mode: "deny-raw", pre_established_state_ids: [] },
				screenshot_policy: { mode: "deny", max_count: 0, max_bytes: 0, allowed_check_ids: [] },
				resource_policy: {
					mode: "allow-listed",
					allowed_origins: ["https://example.test"],
					allow_file_subresources: false,
				},
				protected_actions: [],
			};
			const tuples: readonly BrowserAuditTuple[] = [
				{ tuple_id: "check@route@viewport", check_id: "check", route_state_id: "route", viewport_id: "viewport" },
			];
			const binding: BrowserAuditBindingInput = {
				dispatch,
				actor,
				spawn_id: spawnId,
				authorization,
				tuples,
				file_document_authority: null,
			};
			installRegisteredBrowserAuditBinding(executionKey, binding);

			const result = await registered.execute("call-audit-bound", params, undefined, undefined, undefined, prepared);
			const replay = await registered.execute("call-audit-bound", params, undefined, undefined, undefined, prepared);
			expect(getFirstText(replay)).toContain("already disposed");
			expect(result.details?.results[0]?.id).toBe(spawnId);
			expect(capturedOptions?.agent.tools).toEqual(["browser_audit"]);
			expect(capturedOptions?.agent.spawns).toEqual([]);
			expect(capturedOptions?.restrictToolNames).toBe(true);
			expect(capturedOptions?.enableIrc).toBe(false);
			expect(capturedOptions?.enableLsp).toBe(false);
			expect(capturedOptions?.preloadedExtensionPaths).toBeUndefined();
			expect(capturedOptions?.preloadedCustomToolPaths).toBeUndefined();
		} finally {
			temp.removeSync();
		}
	});

	it("releases an unconsumed reserved output id on dispose", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const params = { name: "Reusable", agent: "task", task: "Do work." } as TaskParams;
		const denied = await tool.prepareExecution("call-denied", params, undefined, undefined, {});
		await denied.dispose();
		const approved = await tool.prepareExecution("call-approved", params, undefined, undefined, {});

		const result = await tool.execute("call-approved", params, undefined, undefined, undefined, approved);

		expect(result.details?.results.map(item => item.id)).toEqual(["Reusable"]);
	});

	it("keeps the prepared permission scope after settings change", async () => {
		mockDiscovery({ ...taskAgent, tools: ["read", "write"] });
		let observedMode: string | undefined;
		let observedTools: string[] | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			observedMode = options.permissionScope?.mode;
			observedTools = options.agent.tools;
			return makeResult(options.id ?? "?");
		});
		const session = createSession({
			settings: {
				"async.enabled": false,
				"task.batch": false,
				"task.permissions.mode": "enforce",
				"task.permissions.tools.enabled": true,
			},
		});
		const tool = await TaskTool.create(session);
		const params = {
			name: "FrozenPermissions",
			agent: "task",
			task: "Use only prepared tools.",
			permissions: { tools: ["read"] },
		} as TaskParams;
		const prepared = await tool.prepareExecution("call-permissions", params, undefined, undefined, {});
		session.settings.set("task.permissions.mode", "off");

		await tool.execute("call-permissions", params, undefined, undefined, undefined, prepared);

		expect(observedMode).toBe("enforce");
		expect(observedTools).toEqual(["read", "hub"]);
	});

	it("keeps prepared model effort prewalk and child feature settings", async () => {
		mockDiscovery();
		let observed: {
			modelOverride?: string | string[];
			maxEffort?: unknown;
			prewalk?: unknown;
			agentPrewalk?: unknown;
			maxDepth?: unknown;
			enableLsp?: boolean;
			enableIrc?: boolean;
		} = {};
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			observed = {
				modelOverride: options.modelOverride,
				maxEffort: options.settings?.get("task.maxEffort"),
				prewalk: options.settings?.get("task.prewalk"),
				agentPrewalk: options.settings?.get("task.agentPrewalk"),
				maxDepth: options.settings?.get("task.maxRecursionDepth"),
				enableLsp: options.enableLsp,
				enableIrc: options.enableIrc,
			};
			return makeResult(options.id ?? "?");
		});
		const session = createSession({
			settings: {
				"async.enabled": false,
				"task.batch": false,
				"task.agentModelOverrides": { task: "prepared/model" },
				"task.maxEffort": "med",
				"task.prewalk": true,
				"task.agentPrewalk": { task: "prepared/prewalk" },
				"task.maxRecursionDepth": 2,
				"task.enableLsp": true,
			},
		});
		const tool = await TaskTool.create(session);
		const params = { name: "FrozenPolicy", agent: "task", task: "Use prepared policy." } as TaskParams;
		const prepared = await tool.prepareExecution("call-frozen-policy", params, undefined, undefined, {});
		session.settings.set("task.agentModelOverrides", { task: "mutated/model" });
		session.settings.set("task.maxEffort", Effort.High);
		session.settings.set("task.prewalk", false);
		session.settings.set("task.agentPrewalk", {});
		session.settings.set("task.maxRecursionDepth", 0);
		session.settings.set("task.enableLsp", false);

		await tool.execute("call-frozen-policy", params, undefined, undefined, undefined, prepared);

		expect(observed).toEqual({
			modelOverride: ["prepared/model"],
			maxEffort: "med",
			prewalk: true,
			agentPrewalk: { task: "prepared/prewalk" },
			maxDepth: 2,
			enableLsp: true,
			enableIrc: true,
		});
	});

	it("keeps prepared async dispatch and parent service tier", async () => {
		mockDiscovery();
		let observedTier: ServiceTierByFamily | null | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			observedTier = options.parentServiceTier;
			return makeResult(options.id ?? "?");
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const session = createSession({
			manager,
			serviceTier: { openai: "flex" },
			settings: { "async.enabled": false, "task.batch": false },
		});
		const tool = await TaskTool.create(session);
		const params = { name: "FrozenDispatch", agent: "task", task: "Use prepared dispatch." } as TaskParams;
		const prepared = await tool.prepareExecution("call-frozen-dispatch", params, undefined, undefined, {});
		session.settings.set("async.enabled", true);
		(session as ToolSession & { getServiceTierByFamily: () => ServiceTierByFamily }).getServiceTierByFamily = () => ({
			openai: "priority",
		});

		const result = await tool.execute("call-frozen-dispatch", params, undefined, undefined, undefined, prepared);

		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(item => item.id)).toEqual(["FrozenDispatch"]);
		expect(observedTier).toEqual({ openai: "flex" });
	});

	it("captures depth dispatch and tier before discovery awaits", async () => {
		const discovery = mockDiscovery();
		let observedIrc: boolean | undefined;
		let observedTier: ServiceTierByFamily | null | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			observedIrc = options.enableIrc;
			observedTier = options.parentServiceTier;
			return makeResult(options.id ?? "?");
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const session = createSession({
			manager,
			serviceTier: { openai: "flex" },
			taskDepth: 0,
			settings: { "async.enabled": false, "task.batch": false, "task.maxRecursionDepth": 2 },
		});
		const tool = await TaskTool.create(session);
		const gate = Promise.withResolvers<{ agents: AgentDefinition[]; projectAgentsDir: null }>();
		const entered = Promise.withResolvers<void>();
		discovery.mockImplementationOnce(async () => {
			entered.resolve();
			return gate.promise;
		});
		const params = { name: "EntrySnapshot", agent: "task", task: "Use entry snapshot." } as TaskParams;
		const preparing = tool.prepareExecution("call-entry-snapshot", params, undefined, undefined, {});
		await entered.promise;
		(session as ToolSession & { taskDepth: number }).taskDepth = 2;
		session.settings.set("async.enabled", true);
		(session as ToolSession & { getServiceTierByFamily: () => ServiceTierByFamily }).getServiceTierByFamily = () => ({
			openai: "priority",
		});
		gate.resolve({ agents: [taskAgent], projectAgentsDir: null });
		const prepared = await preparing;

		const result = await tool.execute("call-entry-snapshot", params, undefined, undefined, undefined, prepared);

		expect(result.details?.async).toBeUndefined();
		expect(observedIrc).toBe(true);
		expect(observedTier).toEqual({ openai: "flex" });
	});

	it("keeps prepared batch context after batch mode changes", async () => {
		mockDiscovery();
		let observedContext: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			observedContext = options.context;
			return makeResult(options.id ?? "?");
		});
		const session = createSession({ settings: { "async.enabled": false, "task.batch": true } });
		const tool = await TaskTool.create(session);
		const params = {
			context: "Frozen shared context.",
			tasks: [{ name: "FrozenBatch", agent: "task", task: "Use shared context." }],
		} as TaskParams;
		const prepared = await tool.prepareExecution("call-batch-context", params, undefined, undefined, {});
		session.settings.set("task.batch", false);

		await tool.execute("call-batch-context", params, undefined, undefined, undefined, prepared);

		expect(observedContext).toBe("Frozen shared context.");
	});

	it("releases a reserved output id on a proven prelaunch failure", async () => {
		mockDiscovery();
		vi.spyOn(fsPromises, "mkdir").mockRejectedValueOnce(new Error("prelaunch failed"));
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const params = { name: "Retryable", agent: "task", task: "Run once." } as TaskParams;
		const first = await tool.prepareExecution("call-failed-prelaunch", params, undefined, undefined, {});
		const failed = await tool.execute("call-failed-prelaunch", params, undefined, undefined, undefined, first);
		expect(getFirstText(failed)).toContain("prelaunch failed");
		const second = await tool.prepareExecution("call-retried-prelaunch", params, undefined, undefined, {});

		const retried = await tool.execute("call-retried-prelaunch", params, undefined, undefined, undefined, second);

		expect(retried.details?.results.map(item => item.id)).toEqual(["Retryable"]);
	});

	it("retains an output id when cleanup fails after execution", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(new Error("cleanup failed"));
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const params = { name: "Used", agent: "task", task: "Run once." } as TaskParams;
		const first = await tool.prepareExecution("call-postrun-failure", params, undefined, undefined, {});
		const failed = await tool.execute("call-postrun-failure", params, undefined, undefined, undefined, first);
		expect(getFirstText(failed)).toContain("cleanup failed");
		const second = await tool.prepareExecution("call-after-postrun-failure", params, undefined, undefined, {});

		const retried = await tool.execute("call-after-postrun-failure", params, undefined, undefined, undefined, second);

		expect(retried.details?.results.map(item => item.id)).toEqual(["Used-2"]);
	});
});
