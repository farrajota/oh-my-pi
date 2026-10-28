import { type BaseType, type FluentType, type } from "@oh-my-pi/omptype";
import { $env, isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { AgentSessionEvent } from "../session/agent-session";
export {
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
export type {
	SubagentProgressPayload,
	SubagentLifecyclePayload,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

const TASK_TOOL_PROFILE_SCHEMA =
	"'none' | 'inspect' | 'review' | 'edit' | 'plan' | 'web-research' | 'vision' | 'browser-audit'" as const;

// Keep this explicit: ArkType serializes `unknown` as a boolean subschema, which llama.cpp grammars reject.
const outputSchemaInputSchema = type("object | boolean | string | null");
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;
const agentSourceRule = '"bundled" | "user" | "project"' as const;
const sha256Rule = type("string").matching(/^[0-9a-f]{64}$/);

// Seance-only per-spawn fields must survive batch-item undeclared-key deletion.
const SEANCE_ITEM_KEY_SET = { sourceSession: true, model: true } as const satisfies Record<SeanceItemKey, true>;
const SEANCE_ITEM_KEYS = Object.keys(SEANCE_ITEM_KEY_SET);

function keepSeanceItemKeys<T, I>(item: FluentType<T, I>): FluentType<unknown, I> {
	return item.onUndeclaredKey("ignore").pipe((input: unknown): unknown => {
		const out: unknown = item(input);
		if (out instanceof type.errors || !isRecord(out) || !isRecord(input)) return out;
		for (const key of SEANCE_ITEM_KEYS) {
			if (Object.hasOwn(input, key) && !Object.hasOwn(out, key)) out[key] = input[key];
		}
		return out;
	});
}

const taskPermissionSchema = type({
	"profiles?": "string[]",
	"tools?": "string[]",
	"denyTools?": "string[]",
	"allowPaths?": "string[]",
	"denyPaths?": "string[]",
	"+": "delete",
});

const taskPermissionSchemaToolsOnly = type({
	"profiles?": "string[]",
	"tools?": "string[]",
	"denyTools?": "string[]",
	"+": "delete",
});

const taskPermissionSchemaPathsOnly = type({
	"profiles?": "string[]",
	"allowPaths?": "string[]",
	"denyPaths?": "string[]",
	"+": "delete",
});

const taskPermissionSchemaProfilesOnly = type({
	"profiles?": "string[]",
	"+": "delete",
});

function selectTaskPermissionSchema(options: { enabled: boolean; toolsEnabled: boolean; pathsEnabled: boolean }) {
	if (!options.enabled) return undefined;
	if (options.toolsEnabled && options.pathsEnabled) return taskPermissionSchema;
	if (options.toolsEnabled) return taskPermissionSchemaToolsOnly;
	if (options.pathsEnabled) return taskPermissionSchemaPathsOnly;
	return taskPermissionSchemaProfilesOnly;
}

function createTaskItemSchema(options: {
	isolationEnabled: boolean;
	permissions: { enabled: boolean; toolsEnabled: boolean; pathsEnabled: boolean };
	defaultAgent?: string;
	effortEnabled: boolean;
	modelEnabled: boolean;
	evalToolsEnabled?: boolean;
	structured?: boolean;
	seanceFields?: SeanceTaskSchemaFields;
}) {
	const shape: Record<string, unknown> = {
		"name?": "string",
		agent: taskAgentSchemaRule(options.defaultAgent ?? "task"),
		task: "string",
		solutionSpace: "string",
		"agentSource?": agentSourceRule,
		"agentDefinitionSha256?": sha256Rule,
		"toolProfile?": TASK_TOOL_PROFILE_SCHEMA,
		"+": "delete",
	};
	if (options.structured !== false) {
		shape["outputSchema?"] = outputSchemaInputSchema;
		shape["schemaMode?"] = '"permissive" | "strict"';
	}
	if (options.effortEnabled) shape["effort?"] = effortRule;
	if (options.modelEnabled) shape["model?"] = "string | string[]";
	if (options.evalToolsEnabled) shape["tools?"] = "string[]";
	if (options.isolationEnabled) shape["isolated?"] = "boolean";
	const permissionSchema = selectTaskPermissionSchema(options.permissions);
	if (permissionSchema) shape["permissions?"] = permissionSchema;
	if (options.seanceFields) Object.assign(shape, options.seanceFields);
	return type(shape);
}

const TASK_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function taskAgentSchemaRule(defaultAgent: string): string {
	const trimmed = defaultAgent.trim();
	if (TASK_AGENT_NAME_PATTERN.test(trimmed)) {
		return `string = '${trimmed}'`;
	}
	return "string";
}

function createTaskSchema(options: {
	isolationEnabled: boolean;
	permissions: { enabled: boolean; toolsEnabled: boolean; pathsEnabled: boolean };
	defaultAgent?: string;
	effortEnabled: boolean;
	modelEnabled: boolean;
	evalToolsEnabled?: boolean;
	structured?: boolean;
	seanceFields?: SeanceTaskSchemaFields;
}) {
	const shape: Record<string, unknown> = {
		"name?": "string",
		agent: taskAgentSchemaRule(options.defaultAgent ?? "task"),
		task: "string",
		solutionSpace: "string",
		"agentSource?": agentSourceRule,
		"agentDefinitionSha256?": sha256Rule,
		"toolProfile?": TASK_TOOL_PROFILE_SCHEMA,
		"+": "delete",
	};
	if (options.structured !== false) {
		shape["outputSchema?"] = outputSchemaInputSchema;
		shape["schemaMode?"] = '"permissive" | "strict"';
	}
	if (options.effortEnabled) shape["effort?"] = effortRule;
	if (options.modelEnabled) shape["model?"] = "string | string[]";
	if (options.evalToolsEnabled) shape["tools?"] = "string[]";
	if (options.isolationEnabled) shape["isolated?"] = "boolean";
	const permissionSchema = selectTaskPermissionSchema(options.permissions);
	if (permissionSchema) shape["permissions?"] = permissionSchema;
	if (options.seanceFields) Object.assign(shape, options.seanceFields);
	return type.raw(shape);
}

function createBatchTaskSchema(options: {
	isolationEnabled: boolean;
	permissions: { enabled: boolean; toolsEnabled: boolean; pathsEnabled: boolean };
	defaultAgent?: string;
	effortEnabled: boolean;
	modelEnabled: boolean;
	evalToolsEnabled?: boolean;
	structured?: boolean;
	seanceFields?: SeanceTaskSchemaFields;
}) {
	return guardBatchContainer(
		type.raw({
			context: "string",
			tasks: keepSeanceItemKeys(createTaskItemSchema(options)).array(),
			"+": "delete",
		}),
	);
}

export const taskItemSchema = createTaskItemSchema({
	effortEnabled: true,
	modelEnabled: false,
	evalToolsEnabled: true,
	isolationEnabled: false,
	permissions: { enabled: false, toolsEnabled: false, pathsEnabled: false },
});
const taskItemSchemaIsolated = createTaskItemSchema({
	effortEnabled: true,
	modelEnabled: false,
	evalToolsEnabled: true,
	isolationEnabled: true,
	permissions: { enabled: false, toolsEnabled: false, pathsEnabled: false },
});

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	"effort?": effortRule,
	task: "string",
	solutionSpace: "string",
	"agentSource?": agentSourceRule,
	"agentDefinitionSha256?": sha256Rule,
	"model?": "string | string[]",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"toolProfile?": TASK_TOOL_PROFILE_SCHEMA,
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	solutionSpace: "string",
	"effort?": effortRule,
	"model?": "string | string[]",
	"outputSchema?": outputSchemaInputSchema,
	"agentSource?": agentSourceRule,
	"agentDefinitionSha256?": sha256Rule,
	"schemaMode?": '"permissive" | "strict"',
	"toolProfile?": TASK_TOOL_PROFILE_SCHEMA,
	"tools?": "string[]",
	"+": "delete",
});
function guardBatchContainer(schema: BaseType): BaseType {
	// Reject item-only fields before undeclared-key deletion can hide them.
	return schema.in
		.narrow((params, ctx) => {
			if (params !== null && typeof params === "object") {
				if (Object.hasOwn(params, "agent")) {
					return ctx.reject("a batch with `agent` specified in `tasks[].agent`, not at the top level");
				}
				if (Object.hasOwn(params, "model")) {
					return ctx.reject("a batch with `model` specified in `tasks[].model`, not at the top level");
				}
			}
			return true;
		})
		.pipe(schema);
}

const taskSchemaBatch = guardBatchContainer(
	type.raw({
		context: "string",
		tasks: keepSeanceItemKeys(taskItemSchemaIsolated).array(),
		"+": "delete",
	}),
);
const taskSchemaBatchNoIsolation = guardBatchContainer(
	type.raw({
		context: "string",
		tasks: keepSeanceItemKeys(taskItemSchema).array(),
		"+": "delete",
	}),
);
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema =
	| (typeof ALL_TASK_SCHEMAS)[number]
	| ReturnType<typeof createTaskSchema>
	| ReturnType<typeof createBatchTaskSchema>;
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const taskSchemaCache = new Map<string, BaseType>();

export type SeanceTaskSchemaFields = {
	"sourceSession?"?: FluentType<string>;
	"model?"?: FluentType<string | string[]>;
};

type SeanceItemKey = {
	[K in keyof SeanceTaskSchemaFields]-?: K extends `${infer Name}?` ? Name : never;
}[keyof SeanceTaskSchemaFields];
/** Build the task wire schema for the current settings and spawn policy. */
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	effortEnabled?: boolean;
	modelEnabled?: boolean;
	/** Advertise the `tools` field for eval-defined tools (`eval.tools.enabled`, default on). */
	evalToolsEnabled?: boolean;
	/** Advertise `outputSchema`/`schemaMode` (`task.structured`); default on. */
	structured?: boolean;
	defaultAgent?: string;
	permissions?: { enabled: boolean; toolsEnabled: boolean; pathsEnabled: boolean };
	/** Advertise historical source/model fields for the bundled seance agent. */
	seanceFields?: SeanceTaskSchemaFields;
}): TaskToolSchemaInstance {
	const permissions = options.permissions ?? { enabled: false, toolsEnabled: false, pathsEnabled: false };
	const defaultAgent = options.defaultAgent ?? "task";
	const effortEnabled = options.effortEnabled ?? true;
	const modelEnabled = options.modelEnabled ?? false;
	const evalToolsEnabled = options.evalToolsEnabled ?? true;
	const structured = options.structured ?? true;
	const seanceFields = options.seanceFields;
	if (
		!modelEnabled &&
		effortEnabled &&
		evalToolsEnabled &&
		!permissions.enabled &&
		defaultAgent === "task" &&
		structured &&
		options.batchEnabled &&
		seanceFields === undefined
	) {
		return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
	}
	const seanceKey = seanceFields ? "seance" : "plain";
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${defaultAgent}:${permissions.enabled ? "perm" : "noperm"}:${permissions.toolsEnabled ? "tools" : "notools"}:${permissions.pathsEnabled ? "paths" : "nopaths"}:${effortEnabled ? "effort" : "noeffort"}:${modelEnabled ? "model" : "nomodel"}:${evalToolsEnabled ? "evaltools" : "noevaltools"}:${structured ? "structured" : "prose"}:${seanceKey}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = options.batchEnabled
		? createBatchTaskSchema({
				isolationEnabled: options.isolationEnabled,
				effortEnabled,
				modelEnabled,
				evalToolsEnabled,
				permissions,
				defaultAgent,
				structured,
				seanceFields,
			})
		: createTaskSchema({
				isolationEnabled: options.isolationEnabled,
				effortEnabled,
				modelEnabled,
				evalToolsEnabled,
				permissions,
				defaultAgent,
				structured,
				seanceFields,
			});
	taskSchemaCache.set(key, schema);
	return schema;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	/** SHA-256 of exact file bytes when the definition was descriptor-read and frozen for execution. */
	definitionSha256?: string;
	/** Device identity captured from the descriptor opened with O_NOFOLLOW. */
	definitionDevice?: string;
	/** Inode identity captured from the descriptor opened with O_NOFOLLOW. */
	definitionInode?: string;
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	/** `true` = task spawns keep the `yield` tool and this agent's `output` schema even when `task.structured` is off. */
	structured?: boolean;
	autoloadSkills?: string[];
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** Prewalk hand-off for the spawned session: `true` = switch to the default prewalk target at the first edit/write, string = custom target model pattern. */
	prewalk?: boolean | string;
	/** Advisor for spawned sessions of this agent: `true` = advise with the default advisor-role model, string = advise with that model pattern (optional `:level` suffix). Absent/`false` = no advisor. */
	advisor?: boolean | string;
	source: AgentSource;
	filePath?: string;
}
