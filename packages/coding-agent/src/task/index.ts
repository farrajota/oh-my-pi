/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolPreparedExecution,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { ServiceTierByFamily, Usage } from "@oh-my-pi/pi-ai";
import { $env, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { Settings } from "../config/settings";
import {
	type BrowserAuditTaskAuthority,
	type BrowserAuditToolCapability,
	bindBrowserAuditRunOptions,
	takeBrowserAuditTaskAuthority,
} from "../internal/browser-audit-authority";
import type { LocalProtocolOptions } from "../internal-urls";
import { MCPManager } from "../mcp/manager";
import type { Theme } from "../modes/theme/theme";
import { loadOverallPlanReference, type OverallPlanReference } from "../plan-mode/plan-handoff";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskAsyncContractTemplate from "../prompts/tools/task-async-contract.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { TASK_EFFORTS, type TaskEffort } from "../thinking";
import { truncateForPrompt } from "../tools/approval";
import { canonicalBytes } from "../tools/browser-audit";

import { isIrcEnabled } from "../tools/hub";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { isReadOnlyAgent } from "./read-only-policy";
import { isScoutSpawnable, resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	getTaskSchema,
	oneLineLabel,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { AsyncJobManager } from "../async";
import { hasResolvableTranscript } from "../internal-urls/registry-helpers";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { parseAgent } from "./agents";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { type ExecutorOptions, runSubprocess } from "./executor";
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "./parallel";
import {
	composeEffectivePermissions,
	type EffectiveSubagentPermissions,
	loadPermissionProfiles,
	type PermissionProfileSummary,
	type SubagentPermissionMode,
} from "./permission-profiles";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import {
	type EffectiveSubagentPolicy,
	resolveEffectiveSubagentPolicy,
	StructuredSubagentError,
} from "./structured-subagent";
import { applyTaskToolProfile } from "./tool-profiles";
import { type IsoBackendKind, parseIsolationMode } from "./worktree";

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, {
		assignment: assignment.trim(),
	});
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export * from "./read-only-policy";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

function formatListForDetails(values: string[] | undefined): string | undefined {
	return values && values.length > 0 ? values.join(", ") : undefined;
}

function appendPermissionDetails(lines: string[], permissions: TaskParams["permissions"] | undefined): void {
	if (!permissions) return;
	const profiles = formatListForDetails(permissions.profiles);
	if (profiles) lines.push(`Profiles: ${truncateForPrompt(profiles)}`);
	const tools = formatListForDetails(permissions.tools);
	if (tools) lines.push(`Tools: ${truncateForPrompt(tools)}`);
	const denyTools = formatListForDetails(permissions.denyTools);
	if (denyTools) lines.push(`Denied tools: ${truncateForPrompt(denyTools)}`);
	const allowPaths = formatListForDetails(permissions.allowPaths);
	if (allowPaths) lines.push(`Allowed paths: ${truncateForPrompt(allowPaths)}`);
	const denyPaths = formatListForDetails(permissions.denyPaths);
	if (denyPaths) lines.push(`Denied paths: ${truncateForPrompt(denyPaths)}`);
}

interface TaskDescriptionOptions {
	agents: AgentDefinition[];
	isolationEnabled: boolean;
	applyIsolatedChanges: boolean;
	disabledAgents: string[];
	batchEnabled: boolean;
	effortEnabled: boolean;
	modelEnabled: boolean;
	asyncEnabled: boolean;
	ircEnabled: boolean;
	parentSpawns: string;
	permissionsEnabled: boolean;
	permissionMode: SubagentPermissionMode;
	permissionToolsEnabled: boolean;
	permissionPathsEnabled: boolean;
	permissionProfiles: PermissionProfileSummary[];
	permissionProfileErrors: string[];
}

/** Render the tool description from a cached agent list and current settings. */
function renderDescription(options: TaskDescriptionOptions): string {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns);
	const spawningDisabled = !spawnPolicy.enabled;
	let filteredAgents =
		options.disabledAgents.length > 0
			? options.agents.filter(agent => !options.disabledAgents.includes(agent.name))
			: options.agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (spawnPolicy.allowedAgents !== null) {
		const allowed = new Set(spawnPolicy.allowedAgents);
		filteredAgents = filteredAgents.filter(agent => allowed.has(agent.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
	}));
	const scoutAvailable = isScoutSpawnable(options.disabledAgents, options.parentSpawns);
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		scoutAvailable,
		spawningDisabled,
		defaultAgent: spawnPolicy.defaultAgent,
		isolationEnabled: options.isolationEnabled,
		applyIsolatedChanges: options.applyIsolatedChanges,
		batchEnabled: options.batchEnabled,
		effortEnabled: options.effortEnabled,
		modelEnabled: options.modelEnabled,
		asyncEnabled: options.asyncEnabled,
		hasBlockingAgents: renderedAgents.some(agent => agent.blocking),
		ircEnabled: options.ircEnabled,
		permissionsEnabled: options.permissionsEnabled,
		permissionMode: options.permissionMode,
		permissionToolsEnabled: options.permissionToolsEnabled,
		permissionPathsEnabled: options.permissionPathsEnabled,
		permissionProfiles: options.permissionProfiles,
		permissionProfileErrors: options.permissionProfileErrors,
	});
}

function validateModelSelector(model: unknown, label: string): string | undefined {
	if (typeof model !== "string" || model.trim() === "" || model.includes(",")) {
		return `${label} must be one non-empty model selector string (comma-separated model chains are not supported).`;
	}
	return undefined;
}

function validateIdentityPin(source: unknown, sha256: unknown, label: string): string | undefined {
	if (source !== undefined && source !== "bundled" && source !== "user" && source !== "project") {
		return `${label} \`agentSource\` must be "bundled", "user", or "project".`;
	}
	if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))) {
		return `${label} \`agentDefinitionSha256\` must be a lowercase 64-hex SHA-256.`;
	}
	return undefined;
}

function validateIdentityPins(params: TaskParams): string | undefined {
	const topLevel = validateIdentityPin(params.agentSource, params.agentDefinitionSha256, "The call's");
	if (topLevel) return topLevel;
	for (let index = 0; index < (params.tasks?.length ?? 0); index++) {
		const item = params.tasks![index]!;
		const error = validateIdentityPin(
			item.agentSource,
			item.agentDefinitionSha256,
			`Task ${index + 1}${item.name ? ` (\`${item.name}\`)` : ""}'s`,
		);
		if (error) return error;
	}
	return undefined;
}

function validateModelParams(params: TaskParams, modelEnabled: boolean): string | undefined {
	if (Object.hasOwn(params, "model")) {
		if (!modelEnabled)
			return "Task model overrides are disabled. Enable task.allowModelOverride before using `model`.";
		const error = validateModelSelector(params.model, "The call's `model`");
		if (error) return error;
	}
	for (let i = 0; i < (Array.isArray(params.tasks) ? params.tasks.length : 0); i++) {
		const item = params.tasks![i];
		if (item === null || typeof item !== "object") continue;
		if (!Object.hasOwn(item, "model")) continue;
		if (!modelEnabled)
			return "Task model overrides are disabled. Enable task.allowModelOverride before using `model`.";
		const error = validateModelSelector(item.model, `Task ${i + 1}'s \`model\``);
		if (error) return error;
	}
	return undefined;
}

/** Reject an out-of-range `effort` selector on internal/stale-transcript calls that bypass the wire schema. */
function validateEffort(effort: TaskEffort | undefined, label: string): string | undefined {
	if (effort === undefined || TASK_EFFORTS.includes(effort)) return undefined;
	return `${label} has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
}

/**
 * Validate shallow raw fields before Arktype deletes hidden unknown keys from
 * the active task wire shape.
 */
function validateRawTaskArguments(args: unknown, modelEnabled: boolean): void {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return;
	const params = args as { effort?: unknown; model?: unknown; tasks?: unknown };
	const effortError = validateEffort(params.effort as TaskEffort | undefined, "The call");
	if (effortError) throw new Error(effortError);
	if (Object.hasOwn(params, "model")) {
		if (!modelEnabled)
			throw new Error("Task model overrides are disabled. Enable task.allowModelOverride before using `model`.");
		const modelError = validateModelSelector(params.model, "The call's `model`");
		if (modelError) throw new Error(modelError);
	}

	if (!Array.isArray(params.tasks)) return;
	for (let i = 0; i < params.tasks.length; i++) {
		const item = params.tasks[i];
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
		const task = item as { effort?: unknown; model?: unknown; name?: unknown };
		const name = typeof task.name === "string" && task.name ? ` (\`${task.name}\`)` : "";
		const itemEffortError = validateEffort(task.effort as TaskEffort | undefined, `Task ${i + 1}${name}`);
		if (itemEffortError) throw new Error(itemEffortError);
		if (Object.hasOwn(task, "model")) {
			if (!modelEnabled)
				throw new Error("Task model overrides are disabled. Enable task.allowModelOverride before using `model`.");
			const modelError = validateModelSelector(task.model, `Task ${i + 1}${name}'s \`model\``);
			if (modelError) throw new Error(modelError);
		}
	}
	const identityError = validateIdentityPins(params as TaskParams);
	if (identityError) throw new Error(identityError);
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject legacy fields and shape/configuration combinations the current tool
 * cannot accept. `outputSchema` is a first-class per-spawn field; stale
 * `schema` remains an eval-only alias and is rejected.
 */
function validateShapeParams(
	batchEnabled: boolean,
	permissionsEnabled: boolean,
	params: TaskParams,
): string | undefined {
	if (Object.hasOwn(params, "schema")) {
		return "The task tool uses `outputSchema`; rename the stale `schema` field.";
	}
	if (!permissionsEnabled) {
		if (params.permissions !== undefined || params.tasks?.some(item => item.permissions !== undefined)) {
			return "Subagent permissions are disabled. Enable task.permissions.mode in /settings before using `permissions`.";
		}
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` — `tasks`
 * non-empty with per-item `task` instructions and unique names, `context`
 * non-empty, no top-level `task` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */

function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item ({ name?, agent?, task }).";
		}
		if (hasTask) {
			return "Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.task !== "string" || item.task.trim() === "") {
				return `Task ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""} is missing \`task\`. Every task needs complete, self-contained instructions.`;
			}
			const effortError = validateEffort(item.effort, `Task ${i + 1}${item.name ? ` (\`${item.name}\`)` : ""}`);
			if (effortError) return effortError;
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
			}
			seen.set(key, name);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (!hasTask) {
		return batchEnabled
			? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
			: "Missing `task`. Provide complete, self-contained instructions for the agent.";
	}
	return validateEffort(params.effort, "The call");
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — `#runSpawn`
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("agentSource" in params) item.agentSource = params.agentSource;
	if ("agentDefinitionSha256" in params) item.agentDefinitionSha256 = params.agentDefinitionSha256;
	if ("model" in params) item.model = params.model;
	if (params.permissions !== undefined) item.permissions = params.permissions;
	if (params.toolProfile !== undefined) item.toolProfile = params.toolProfile;
	if ("outputSchema" in params) item.outputSchema = params.outputSchema;
	if ("schemaMode" in params) item.schemaMode = params.schemaMode;
	if ("effort" in params) item.effort = params.effort;
	if ("isolated" in params) item.isolated = params.isolated;
	return [item];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if ("agentSource" in item) spawn.agentSource = item.agentSource;
	if ("agentDefinitionSha256" in item) spawn.agentDefinitionSha256 = item.agentDefinitionSha256;
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if ("model" in item) spawn.model = item.model;
	if (item.permissions !== undefined) spawn.permissions = item.permissions;
	if (item.toolProfile !== undefined) spawn.toolProfile = item.toolProfile;
	if (params.context !== undefined) spawn.context = params.context;
	if ("outputSchema" in item) spawn.outputSchema = item.outputSchema;
	if ("schemaMode" in item) spawn.schemaMode = item.schemaMode;
	if ("effort" in item) spawn.effort = item.effort;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	return spawn;
}

/** One sync-executed spawn: its item, position in the original call, and (for mixed calls) a pre-claimed agent id. */
interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line.
 */
function mergeSyncPayloads(
	spawns: SyncSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
	};
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	scoutAvailable = true,
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	const specialist = scoutAvailable
		? `Check the agent list for a closer specialist type — e.g. read-only research belongs on ` +
			`\`agent: "scout"\`, which runs on a faster model.`
		: `Check the agent list for a closer specialist type.`;
	return `Tip: this call spawned ${generics.length} generic \`${generics[0]}\` workers. ${specialist}`;
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via the
 * hub when one call creates ≥2 live siblings and it still holds spawn
 * capacity. Returns undefined when there is nothing to coordinate or peer
 * messaging is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return (
		`Coordinate: ${items.length} siblings are running together. If their work overlaps, have them ` +
		`message each other via \`hub\` (by id, or "all" to broadcast) before editing shared files — ` +
		`live coordination beats a serial handoff. Check \`hub\` op:"list" to see who is doing what.`
	);
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
	scoutAvailable?: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.scoutAvailable),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends Error {}

/**
 * Process-level create-time discovery memo and published reload snapshots,
 * keyed by resolved cwd plus the exact effective `extensions` array.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process. Sessions
 * may share a cwd while carrying different overlay/runtime extension settings,
 * so cwd alone is not an isolation boundary. Explicit plugin reloads replace
 * only the matching cwd+extensions snapshot. Execution-time discovery
 * (`#runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * both caches automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
const discoverySnapshots = new Map<string, AgentDefinition[]>();
let discoveryMemoFn: typeof discoverAgents | undefined;

/** Stable cache identity for the filesystem root and the full effective extension-root struct. */
function discoveryCacheKey(cwd: string, extensionRoots?: EffectiveExtensionRoots): string {
	return `${path.resolve(cwd)}\0${JSON.stringify(extensionRoots ?? null)}`;
}

function discoverAgentsForCreate(cwd: string, extensionRoots?: EffectiveExtensionRoots): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
		discoverySnapshots.clear();
	}
	const key = discoveryCacheKey(cwd, extensionRoots);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd, undefined, extensionRoots);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}
export function computePreparedTaskToolCallFingerprint(toolCallId: string, params: TaskParams): string {
	return createHash("sha256")
		.update(canonicalBytes({ tool_name: "task", tool_call_id: toolCallId, input: params }))
		.digest("hex");
}

/** Rescan one cwd and publish its definitions to existing and future task tools. */
export async function refreshAgentDiscovery(cwd: string, extensionRoots?: EffectiveExtensionRoots): Promise<void> {
	const key = discoveryCacheKey(cwd, extensionRoots);
	discoveryMemo.delete(key);
	const pending = discoverAgentsForCreate(cwd, extensionRoots);
	const { agents } = await pending;
	if (discoveryMemo.get(key) === pending) {
		discoverySnapshots.set(key, agents);
	}
}

interface PreparedSpawnReservation {
	id: string;
	index: number;
	item: TaskItem;
	params: TaskParams;
	policy: EffectiveSubagentPolicy;
	effectiveAgent: AgentDefinition;
	permissionAgent: AgentDefinition;
	permissionScope: EffectiveSubagentPermissions;
	settings: Settings;
	sharedContext?: string;
	isIsolated: boolean;
	mergeMode: "patch" | "branch";
	preferredIsolationBackend: IsoBackendKind | undefined;
	isolationContext: IsolationContext | null;
	enableLsp: boolean;
	enableIrc: boolean;
	planReference?: OverallPlanReference;
	parentServiceTier: ServiceTierByFamily | null | undefined;
	localProtocolOptions: LocalProtocolOptions;
	maxRuntimeMs: number;
	allowEffortOverride: boolean;
	handedOff: boolean;
	browserAudit?: BrowserAuditToolCapability;
}
interface PreparedTaskState {
	params: TaskParams;
	defaultAgent: string;
	asyncEnabled: boolean;
	depthCapacity: boolean;
	ircEnabled: boolean;
	batchEnabled: boolean;
	spawnItems: TaskItem[];
	normalizedSpawnParams: TaskParams[];
	resolvedAgents: string[];
	policies: EffectiveSubagentPolicy[];
	itemBlocking: boolean[];
	reservations: PreparedSpawnReservation[];
	consumed: boolean;
	disposed: boolean;
}

async function freezeDiscoveredAgent(discovery: DiscoveryResult, params: TaskParams): Promise<DiscoveryResult> {
	const agentName = params.agent ?? "";
	const agent = getAgent(discovery.agents, agentName);
	if (!agent) return discovery;
	if (params.agentSource !== undefined && params.agentSource !== agent.source) {
		throw new StructuredSubagentError(
			"preflight",
			`Agent source pin mismatch for "${agent.name}": expected ${params.agentSource}, discovered ${agent.source}.`,
		);
	}
	if (agent.source === "bundled") {
		if (params.agentDefinitionSha256 !== undefined) {
			throw new StructuredSubagentError(
				"preflight",
				`Agent definition SHA-256 pins require a file-backed user or project agent; "${agent.name}" is bundled.`,
			);
		}
		return discovery;
	}
	if (!agent.filePath) {
		throw new StructuredSubagentError("preflight", `File-backed agent "${agent.name}" has no definition path.`);
	}

	let handle: fs.FileHandle | undefined;
	try {
		const resolvedPath = await fs.realpath(agent.filePath);
		handle = await fs.open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("definition is not a regular file");
		const bytes = await handle.readFile();
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (params.agentDefinitionSha256 !== undefined && params.agentDefinitionSha256 !== sha256) {
			throw new Error(`SHA-256 mismatch: expected ${params.agentDefinitionSha256}, observed ${sha256}`);
		}
		const parsed = parseAgent(resolvedPath, bytes.toString("utf8"), agent.source);
		if (parsed.name !== agent.name) {
			throw new Error(`definition name changed from ${agent.name} to ${parsed.name}`);
		}
		const frozenAgent = Object.freeze({
			...parsed,
			filePath: resolvedPath,
			...(parsed.tools ? { tools: Object.freeze([...parsed.tools]) as string[] } : {}),
			...(parsed.model ? { model: Object.freeze([...parsed.model]) as string[] } : {}),
			definitionSha256: sha256,
			definitionDevice: String(stat.dev),
			definitionInode: String(stat.ino),
		}) as AgentDefinition;
		return {
			...discovery,
			agents: discovery.agents.map(candidate => (candidate === agent ? frozenAgent : candidate)),
		};
	} catch (error) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot freeze exact agent definition for "${agent.name}": ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		await handle?.close();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.agentSource === "string") {
			lines.push(`Agent source: ${params.agentSource}`);
		}
		if (typeof params.agentDefinitionSha256 === "string") {
			lines.push(`Agent SHA-256: ${params.agentDefinitionSha256}`);
		}
		if (typeof params.model === "string") {
			lines.push(`Model: ${truncateForPrompt(params.model)}`);
		}
		if (typeof params.name === "string" && params.name.trim()) {
			lines.push(`Name: ${truncateForPrompt(params.name)}`);
		}
		if (typeof params.task === "string") {
			lines.push(`Task:\n${truncateForPrompt(params.task)}`);
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\n${truncateForPrompt(params.context)}`);
		}
		appendPermissionDetails(lines, params.permissions);
		const tasks: TaskItem[] = Array.isArray(params.tasks)
			? params.tasks.filter((item): item is TaskItem => item !== null && typeof item === "object")
			: [];
		if (tasks.length > 0) {
			const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
			const effectiveAgent = (item: TaskItem): string => {
				if (typeof item.agent === "string" && item.agent.trim()) return item.agent.trim();
				return defaultAgent;
			};
			const agentCounts = new Map<string, number>();
			for (const item of tasks) {
				const agent = effectiveAgent(item);
				agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
			}
			const agentSummary = [...agentCounts].map(([agent, count]) => `${agent} ×${count}`).join(", ");
			lines.push(`Batch agents: ${truncateForPrompt(agentSummary)}`);
			const batchModels = tasks
				.map(item => (typeof item.model === "string" ? item.model.trim() : ""))
				.filter(Boolean);
			if (batchModels.length > 0) lines.push(`Batch models: ${truncateForPrompt(batchModels.join(", "))}`);

			const firstTask = tasks[0];
			if (firstTask && typeof firstTask === "object") {
				if ("name" in firstTask && typeof firstTask.name === "string" && firstTask.name.trim()) {
					lines.push(`Name: ${truncateForPrompt(firstTask.name)}`);
				}
				lines.push(`Agent: ${truncateForPrompt(effectiveAgent(firstTask))}`);
				if (typeof firstTask.model === "string") lines.push(`Model: ${truncateForPrompt(firstTask.model)}`);
				if (typeof firstTask.agentSource === "string") lines.push(`Agent source: ${firstTask.agentSource}`);
				if (typeof firstTask.agentDefinitionSha256 === "string") {
					lines.push(`Agent SHA-256: ${firstTask.agentDefinitionSha256}`);
				}
				if ("task" in firstTask && typeof firstTask.task === "string") {
					lines.push(`Task:\n${truncateForPrompt(firstTask.task)}`);
				}
			}
			appendPermissionDetails(lines, firstTask?.permissions);
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = false;
	readonly loadMode = "essential";
	// Arktype validates model calls against the active wire schema, but the flat
	// single-spawn schema carries `"+": "delete"`: a batch `{ context, tasks[] }`
	// payload has those keys stripped, then fails on the now-missing `task` with
	// the misleading `task must be a string (was missing)`. That preempts the
	// tool's own actionable shape checks (`validateShapeParams` /
	// `validateSpawnParams`), which never run. Lenient validation forwards the
	// raw args to `execute()` on any arktype failure so those checks surface the
	// real reason ("enable task.batch, or use the flat `task` shape"). Valid
	// calls still normalize through arktype; `execute()` resolves `agent`
	// defaults independently, so the success path is unchanged.
	readonly lenientArgValidation = true;
	readonly validateRawArguments = (args: unknown): void => {
		validateRawTaskArguments(args, this.session.settings.get("task.allowModelOverride"));
	};
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #browserAuditAuthority: BrowserAuditTaskAuthority | undefined;
	readonly #blockedAgent: string | undefined;
	readonly #permissionProfiles: PermissionProfileSummary[];
	readonly #permissionProfileErrors: string[];
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Resized in
	 * place from `task.maxConcurrency` before every acquire/release so a
	 * mid-session settings change (UI toggle, `/settings`) applies to both new
	 * spawns and work already parked in the semaphore queue.
	 */
	#spawnSemaphore: Semaphore | undefined;
	readonly #preparedSpawns = new Map<string, PreparedSpawnReservation>();
	readonly #preparedExecutionKeys = new Map<string, object>();

	get parameters(): TaskToolSchemaInstance {
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = !planMode && this.session.settings.get("task.isolation.mode") !== "none";
		const permissionMode = this.session.settings.get("task.permissions.mode") as SubagentPermissionMode;
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.allowEffortOverride"),
			modelEnabled: this.session.settings.get("task.allowModelOverride"),
			defaultAgent,
			permissions: {
				enabled: permissionMode !== "off",
				toolsEnabled: this.session.settings.get("task.permissions.tools.enabled"),
				pathsEnabled: this.session.settings.get("task.permissions.paths.enabled"),
			},
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current task settings. */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const permissionMode = this.session.settings.get("task.permissions.mode") as SubagentPermissionMode;
		return renderDescription({
			agents:
				discoverySnapshots.get(discoveryCacheKey(this.session.cwd, this.session.effectiveExtensionRoots?.())) ??
				this.#discoveredAgents,
			isolationEnabled: !planMode && isolationMode !== "none",
			applyIsolatedChanges: this.session.settings.get("task.isolation.apply"),
			disabledAgents,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.allowEffortOverride"),
			modelEnabled: this.session.settings.get("task.allowModelOverride"),
			asyncEnabled: this.session.settings.get("async.enabled"),
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			parentSpawns: this.session.getSessionSpawns() ?? "*",
			permissionsEnabled: permissionMode !== "off",
			permissionMode,
			permissionToolsEnabled: this.session.settings.get("task.permissions.tools.enabled"),
			permissionPathsEnabled: this.session.settings.get("task.permissions.paths.enabled"),
			permissionProfiles: this.#permissionProfiles,
			permissionProfileErrors: this.#permissionProfileErrors,
		});
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
		permissionProfiles: PermissionProfileSummary[],
		permissionProfileErrors: string[],
		browserAuditAuthority?: BrowserAuditTaskAuthority,
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
		this.#permissionProfiles = permissionProfiles;
		this.#permissionProfileErrors = permissionProfileErrors;
		this.#browserAuditAuthority = browserAuditAuthority;
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	#getSpawnSemaphore(): Semaphore {
		const max = this.session.settings.get("task.maxConcurrency");
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
	}
	/** Resolve and freeze one spawn policy before detached work or approval exists. */
	async #resolveSpawnPreflight(
		params: TaskParams,
		settings: Settings,
		batchEnabled: boolean,
		taskDepth: number,
	): Promise<EffectiveSubagentPolicy> {
		const discovery = await discoverAgents(this.session.cwd, undefined, this.session.effectiveExtensionRoots?.());
		const frozenDiscovery = await freezeDiscoveredAgent(discovery, params);
		return resolveEffectiveSubagentPolicy({
			session: this.session,
			settings,
			discovery: frozenDiscovery,
			invocationKind: "task",
			assignment: (params.task ?? "").trim(),
			taskDepth,
			context: batchEnabled ? params.context?.trim() || undefined : undefined,
			agent: params.agent,
			...(params.model !== undefined ? { model: params.model } : {}),
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
			blockedAgent: this.#blockedAgent,
			enableLsp: (this.session.enableLsp ?? true) && settings.get("task.enableLsp"),
			enableIrc: isIrcEnabled(settings, taskDepth),
			maxRuntimeMs: settings.get("task.maxRuntimeMs"),
		});
	}

	#getOutputManager(): AgentOutputManager {
		this.session.agentOutputManager ??= new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		return this.session.agentOutputManager;
	}

	async #releasePreparedState(state: PreparedTaskState): Promise<void> {
		if (state.disposed) return;
		state.disposed = true;
		const manager = this.#getOutputManager();
		await Promise.all(
			state.reservations.map(async reservation => {
				if (reservation.handedOff) return;
				this.#preparedSpawns.delete(reservation.id);
				await manager.release(reservation.id);
			}),
		);
	}

	#activatePreparedState(
		state: PreparedTaskState,
		executionKey: object,
		toolCallFingerprint: string,
	): PreparedTaskState {
		if (state.disposed) throw new Error("Prepared Task execution was already disposed.");
		if (state.consumed) throw new Error("Prepared Task execution cannot be replayed.");
		let auditReservations = 0;
		for (const reservation of state.reservations) {
			const requestsAudit =
				reservation.params.toolProfile === "browser-audit" ||
				reservation.permissionAgent.tools?.some(tool => tool.toLowerCase() === "browser_audit") === true;
			if (requestsAudit) {
				auditReservations++;
				const profiles = reservation.params.permissions?.profiles ?? [];
				const requestedTools = reservation.params.permissions?.tools ?? [];
				const exactRequest =
					state.reservations.length === 1 &&
					reservation.policy.agentName === "browser-audit-specialist" &&
					reservation.params.toolProfile === "browser-audit" &&
					profiles.length === 1 &&
					profiles[0] === "browser-audit" &&
					requestedTools.length === 1 &&
					requestedTools[0] === "browser_audit";
				const parentAgentId = this.session.getAgentId?.() ?? null;
				const browserAudit = exactRequest
					? this.#browserAuditAuthority?.activate(executionKey, {
							agentName: reservation.policy.agentName,
							agentSource: reservation.effectiveAgent.source,
							agentLogicalPath: reservation.effectiveAgent.filePath
								? `agents/${path.basename(reservation.effectiveAgent.filePath)}`
								: undefined,
							agentDefinitionSha256: reservation.effectiveAgent.definitionSha256,
							spawnId: reservation.id,
							parentAgentId,
							toolCallFingerprint,
						})
					: undefined;
				if (!browserAudit) {
					throw new Error(
						"Browser Audit activation is missing or does not match the exact prepared Task reservation.",
					);
				}
				reservation.browserAudit = browserAudit;
				reservation.permissionAgent = { ...reservation.permissionAgent, tools: ["browser_audit"], spawns: [] };
				reservation.enableLsp = false;
				reservation.enableIrc = false;
			}
		}
		if (auditReservations > 1) {
			throw new Error("Browser Audit activation does not belong to exactly one prepared Task reservation.");
		}
		state.consumed = true;
		for (const reservation of state.reservations) this.#preparedSpawns.set(reservation.id, reservation);
		return state;
	}
	async #prepareTaskState(rawParams: unknown, signal?: AbortSignal): Promise<PreparedTaskState> {
		signal?.throwIfAborted();
		const preparedSettings = this.session.settings.snapshot();
		const taskDepth = this.session.taskDepth ?? 0;
		const asyncEnabled = preparedSettings.get("async.enabled");
		const depthCapacity = canSpawnAtDepth(preparedSettings.get("task.maxRecursionDepth") ?? 2, taskDepth);
		const ircEnabled = isIrcEnabled(preparedSettings, taskDepth);
		const parentServiceTier = this.session.getServiceTierByFamily
			? structuredClone(this.session.getServiceTierByFamily() ?? null)
			: undefined;
		const params = repairTaskParams(rawParams as TaskParams);
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		const batchEnabled = preparedSettings.get("task.batch");
		const permissionMode = preparedSettings.get("task.permissions.mode") as SubagentPermissionMode;
		const permissionToolsEnabled = preparedSettings.get("task.permissions.tools.enabled");
		const permissionPathsEnabled = preparedSettings.get("task.permissions.paths.enabled");
		const validationError =
			validateIdentityPins(params) ??
			validateModelParams(params, preparedSettings.get("task.allowModelOverride")) ??
			validateShapeParams(batchEnabled, permissionMode !== "off", params) ??
			validateSpawnParams(params, batchEnabled);
		if (validationError) throw new StructuredSubagentError("preflight", validationError);

		const spawnItems = resolveSpawnItems(params);
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		const preflights = await Promise.all(
			normalizedSpawnParams.map(spawn =>
				this.#resolveSpawnPreflight(spawn, preparedSettings, batchEnabled, taskDepth),
			),
		);
		const loadedPermissionProfiles = await loadPermissionProfiles(this.session.cwd);
		const inheritedPermissions = this.session.getPermissionScope?.();
		const activeToolNames = this.session.getActiveToolNames?.();
		const parentId = this.session.getAgentId?.() ?? MAIN_AGENT_ID;
		const localProtocolOptions: LocalProtocolOptions = this.session.localProtocolOptions ?? {
			getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
			getSessionId: this.session.getSessionId ?? (() => null),
		};
		const maxRuntimeMs = preparedSettings.get("task.maxRuntimeMs");
		const preferredIsolationBackend = parseIsolationMode(preparedSettings.get("task.isolation.mode"));
		signal?.throwIfAborted();

		const manager = this.#getOutputManager();
		const allowEffortOverride = preparedSettings.get("task.allowEffortOverride");
		const reservations: PreparedSpawnReservation[] = [];
		const reservedIds: string[] = [];
		try {
			for (const [index, item] of spawnItems.entries()) {
				signal?.throwIfAborted();
				const id = await manager.allocate(item.name?.trim() || generateTaskName());
				reservedIds.push(id);
				const spawnParams = normalizedSpawnParams[index]!;
				const policy = preflights[index]!;
				const profiledAgent =
					policy.effectiveAgent.tools !== undefined || spawnParams.toolProfile !== undefined
						? {
								...policy.effectiveAgent,
								tools: applyTaskToolProfile(policy.effectiveAgent.tools, spawnParams.toolProfile),
							}
						: policy.effectiveAgent;
				if (policy.planMode && (profiledAgent.tools?.length ?? 0) === 0) {
					throw new StructuredSubagentError(
						"preflight",
						`Plan mode cannot spawn agent "${profiledAgent.name}" because its tool profile does not permit planning tools.`,
					);
				}
				const composedPermissions = composeEffectivePermissions({
					mode: permissionMode,
					toolsEnabled: permissionToolsEnabled,
					pathsEnabled: permissionPathsEnabled,
					actorId: id,
					actorKind: "sub",
					parentId,
					request: spawnParams.permissions,
					inherited: inheritedPermissions,
					profiles: loadedPermissionProfiles.profiles,
				});
				if (!composedPermissions.ok) throw new StructuredSubagentError("preflight", composedPermissions.error);
				const permissionScope = composedPermissions.value;
				let permissionAgent = profiledAgent;
				if (permissionScope.mode === "enforce" && permissionScope.toolsEnabled) {
					const deniedTools = new Set(permissionScope.denyTools.map(tool => tool.toLowerCase()));
					const allowlistedTools = permissionScope.tools
						? new Set(permissionScope.tools.map(tool => tool.toLowerCase()))
						: undefined;
					const candidateTools = permissionAgent.tools ?? permissionScope.tools ?? activeToolNames;
					if (candidateTools !== undefined) {
						let nextTools = candidateTools.filter(tool => {
							const normalized = tool.toLowerCase();
							if (deniedTools.has(normalized)) return false;
							if (allowlistedTools && !allowlistedTools.has(normalized)) return false;
							return this.session.getToolByName ? this.session.getToolByName(tool) !== undefined : true;
						});
						if (
							policy.enableIrc &&
							!deniedTools.has("hub") &&
							!nextTools.some(tool => tool.toLowerCase() === "hub")
						) {
							nextTools = [...nextTools, "hub"];
						}
						permissionAgent = { ...permissionAgent, tools: nextTools };
					}
				}
				const planReference = policy.planMode
					? undefined
					: await loadOverallPlanReference(
							this.session.getPlanReferencePath?.() ?? "local://PLAN.md",
							localProtocolOptions,
						);
				const isolationContext = policy.isIsolated ? await prepareIsolationContext(this.session.cwd) : null;
				reservations.push({
					id,
					index,
					item,
					params: spawnParams,
					policy,
					effectiveAgent: profiledAgent,
					permissionAgent,
					settings: preparedSettings,
					permissionScope,
					sharedContext: batchEnabled ? params.context?.trim() || undefined : undefined,
					isIsolated: policy.isIsolated,
					mergeMode: policy.mergeMode,
					preferredIsolationBackend,
					isolationContext,
					enableLsp: policy.enableLsp,
					parentServiceTier,
					planReference,
					enableIrc: policy.enableIrc,
					localProtocolOptions,
					maxRuntimeMs,
					allowEffortOverride,
					handedOff: false,
				});
			}
			signal?.throwIfAborted();
		} catch (error) {
			await Promise.all(reservedIds.map(id => manager.release(id)));
			throw error;
		}

		return {
			params,
			defaultAgent,
			batchEnabled,
			spawnItems,
			normalizedSpawnParams,
			resolvedAgents,
			asyncEnabled,
			depthCapacity,
			ircEnabled,
			policies: preflights,
			itemBlocking: preflights.map(policy => policy.effectiveAgent.blocking === true),
			reservations,
			consumed: false,
			disposed: false,
		};
	}

	async prepareExecution(
		toolCallId: string,
		rawParams: unknown,
		signal: AbortSignal | undefined,
		_context: AgentToolContext | undefined,
		executionKey: object,
	): Promise<AgentToolPreparedExecution> {
		if (this.#preparedExecutionKeys.has(toolCallId)) {
			throw new Error(`Task call ${toolCallId} already has prepared execution state.`);
		}
		this.#preparedExecutionKeys.set(toolCallId, executionKey);
		let state: PreparedTaskState | undefined;
		try {
			state = await this.#prepareTaskState(rawParams, signal);
		} catch (error) {
			this.#browserAuditAuthority?.revoke(executionKey);
			if (this.#preparedExecutionKeys.get(toolCallId) === executionKey)
				this.#preparedExecutionKeys.delete(toolCallId);
			if (state !== undefined) await this.#releasePreparedState(state);
			throw error;
		}
		if (state === undefined) throw new Error("Task preparation did not produce state.");
		let disposed = false;
		const toolCallFingerprint = computePreparedTaskToolCallFingerprint(toolCallId, state.params);
		const reservation = state.reservations.length === 1 ? state.reservations[0] : undefined;
		const metadata = Object.freeze({
			spawnCount: state.reservations.length,
			spawnId: reservation?.id ?? null,
			agentName: reservation?.policy.agentName ?? null,
			agentSource: reservation?.effectiveAgent.source ?? null,
			agentLogicalPath: reservation?.effectiveAgent.filePath
				? `agents/${path.basename(reservation.effectiveAgent.filePath)}`
				: null,
			agentDefinitionSha256: reservation?.effectiveAgent.definitionSha256 ?? null,
			agentBlocking: reservation?.effectiveAgent.blocking === true,
			requestedModel: reservation?.params.model ?? null,
			toolProfile: reservation?.params.toolProfile ?? null,
			toolCallFingerprint,
		});
		return {
			metadata,
			consume: <T>(owner: object, expectedToolCallId: string): T => {
				if (owner !== this) throw new Error("Prepared Task execution belongs to a different tool instance.");
				if (expectedToolCallId !== toolCallId || this.#preparedExecutionKeys.get(toolCallId) !== executionKey) {
					throw new Error("Prepared Task execution key does not match this tool call.");
				}
				return this.#activatePreparedState(state, executionKey, toolCallFingerprint) as T;
			},
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				this.#browserAuditAuthority?.revoke(executionKey);
				if (!state.consumed) await this.#releasePreparedState(state);
			},
		};
	}
	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const browserAuditAuthority = takeBrowserAuditTaskAuthority(session);
		const [{ agents }, profileLoad] = await Promise.all([
			discoverAgentsForCreate(session.cwd, session.effectiveExtensionRoots?.()),
			loadPermissionProfiles(session.cwd),
		]);
		return new TaskTool(session, agents, profileLoad.summaries, profileLoad.errors, browserAuditAuthority);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		_context?: AgentToolContext,
		preparedExecution?: AgentToolPreparedExecution,
	): Promise<AgentToolResult<TaskToolDetails>> {
		let localPreparation: AgentToolPreparedExecution | undefined;
		let prepared: PreparedTaskState;
		try {
			localPreparation =
				preparedExecution ??
				(await this.prepareExecution(toolCallId, rawParams, signal, undefined, Object.freeze({})));
			prepared = localPreparation.consume<PreparedTaskState>(this, toolCallId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return createTaskModeError(`Task execution failed: ${message}`);
		}
		const {
			params,
			defaultAgent,
			spawnItems,
			resolvedAgents,
			policies,
			itemBlocking,
			reservations,
			asyncEnabled,
			depthCapacity,
			ircEnabled,
		} = prepared;
		try {
			// Execution mode is per item: an item whose agent type declares
			// `blocking: true` runs inline on this turn (the parent waits on its
			// result); every other item becomes a background job when async
			// execution is available.
			const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
			const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];

			if (!manager || asyncItems.length === 0) {
				// Sync fallback: async execution disabled, orphaned host that never
				// wired a job manager, or every item's agent type declares
				// `blocking: true`.
				if (asyncEnabled && !this.session.asyncJobManager) {
					logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
				}
				const advisory = this.session.suppressSpawnAdvisory
					? undefined
					: composeSpawnAdvisory({
							agents: resolvedAgents,
							items: asyncItems,
							depthCapacity,
							ircEnabled,
							willRunAsync: false,
							scoutAvailable: isScoutSpawnable(
								this.session.settings.get("task.disabledAgents") as string[] | undefined,
								this.session.getSessionSpawns?.() ?? "*",
							),
						});
				const result = await this.#executeSyncFanout(
					toolCallId,
					params,
					reservations.map(reservation => ({
						item: reservation.item,
						index: reservation.index,
						preAllocatedId: reservation.id,
					})),
					defaultAgent,
					signal,
					onUpdate,
				);
				if (!advisory) return result;
				let appended = false;
				const content = result.content.map(part => {
					if (!appended && part.type === "text" && typeof part.text === "string") {
						appended = true;
						return { ...part, text: `${part.text}\n\n${advisory}` };
					}
					return part;
				});
				if (!appended) content.push({ type: "text", text: advisory });
				return { ...result, content };
			}

			// Coordination only makes sense for spawns that keep running after this
			// call returns (the async subset). Blocking items have already completed
			// by then, so a "coordinate while they run" hint would misfire.
			const advisory = this.session.suppressSpawnAdvisory
				? undefined
				: composeSpawnAdvisory({
						agents: resolvedAgents,
						items: asyncItems,
						depthCapacity,
						ircEnabled,
						willRunAsync: asyncItems.length > 0,
						scoutAvailable: isScoutSpawnable(
							this.session.settings.get("task.disabledAgents") as string[] | undefined,
							this.session.getSessionSpawns?.() ?? "*",
						),
					});
			// Returns a fresh result (copied content array, copied text part) rather
			// than mutating the caller's — task results are short-lived here, but an
			// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
			const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
				if (!advisory) return result;
				let appended = false;
				const content = result.content.map(part => {
					if (!appended && part.type === "text" && typeof part.text === "string") {
						appended = true;
						return { ...part, text: `${part.text}\n\n${advisory}` };
					}
					return part;
				});
				if (!appended) content.push({ type: "text", text: advisory });
				return { ...result, content };
			};
			if (asyncItems.length === 0) {
				return withAdvisory(
					await this.#executeSyncFanout(
						toolCallId,
						params,
						reservations.map(reservation => ({
							item: reservation.item,
							index: reservation.index,
							preAllocatedId: reservation.id,
						})),
						defaultAgent,
						signal,
						onUpdate,
					),
				);
			}

			const callStartedAt = Date.now();
			const spawns: Array<{
				agentId: string;
				item: TaskItem;
				index: number;
				blocking: boolean;
				progress: AgentProgress;
			}> = [];
			for (const [index, item] of spawnItems.entries()) {
				const agentType = resolvedAgents[index]!;
				const policy = policies[index]!;
				const agentSource = policy.agent.source;
				const agentId = reservations[index]!.id;
				const assignment = (item.task ?? "").trim();
				spawns.push({
					agentId,
					item,
					index,
					blocking: itemBlocking[index],
					progress: {
						index,
						id: agentId,
						agent: agentType,
						agentSource,
						modelRole: policy.modelRole,
						status: "pending",
						task: renderSubagentUserPrompt(assignment),
						assignment,
						modelOverride: policy.modelOverride,
						requestedModel: item.model,
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						requests: 0,
						tokens: 0,
						cost: 0,
						durationMs: 0,
					},
				});
			}
			const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
			const syncSpawns = spawns.filter(spawn => spawn.blocking);
			const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

			let settledCount = 0;
			let failedCount = 0;
			let primaryJobId = asyncSpawns[0].agentId;
			const syncResults: SingleResult[] = [];
			// oxlint-disable-next-line prefer-const -- updated after async job registration
			let syncUsage: Usage | undefined;
			// oxlint-disable-next-line prefer-const -- updated after async job registration
			let syncOutputPaths: string[] | undefined;
			let syncProjectAgentsDir: string | null = null;
			const buildAsyncDetails = (): TaskToolDetails => ({
				projectAgentsDir: syncProjectAgentsDir,
				results: [...syncResults],
				totalDurationMs: Date.now() - callStartedAt,
				usage: syncUsage,
				outputPaths: syncOutputPaths,
				progress: spawns.map(spawn => ({ ...spawn.progress })),
				async: {
					state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
					jobId: primaryJobId,
					type: "task",
				},
			});

			const started: Array<{ agentId: string; jobId: string }> = [];
			const failedSchedules: string[] = [];
			for (const spawn of asyncSpawns) {
				const reservation = reservations[spawn.index]!;
				reservation.handedOff = true;
				try {
					const jobId = this.#registerSpawnJob({
						manager,
						toolCallId,
						spawnParams: reservation.params,
						agentId: spawn.agentId,
						progress: spawn.progress,
						ircEnabled,
						buildDetails: buildAsyncDetails,
						onUpdate,
						onSettled: failed => {
							settledCount += 1;
							if (failed) failedCount += 1;
						},
					});
					if (started.length === 0) primaryJobId = jobId;
					started.push({ agentId: spawn.agentId, jobId });
				} catch (error) {
					reservation.handedOff = false;
					const message = error instanceof Error ? error.message : String(error);
					failedSchedules.push(`${spawn.agentId}: ${message}`);
					spawn.progress.status = "failed";
					settledCount += 1;
					failedCount += 1;
				}
			}

			if (started.length === 0 && syncSpawns.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to start background task job${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}`,
						},
					],
					details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
				};
			}

			const scheduleFailureSummary =
				failedSchedules.length > 0
					? ` Failed to schedule ${failedSchedules.length} spawn${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}.`
					: "";
			const coordinationHint = [
				started.length === 1
					? ircEnabled
						? `DM \`${started[0].agentId}\` via \`hub\` send to coordinate while it runs; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
						: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task.`
					: ircEnabled
						? `DM these ids via \`hub\` send to coordinate while they run; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
						: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task by id.`,
				taskAsyncContractTemplate.trim(),
			].join("\n");

			if (syncSpawns.length === 0) {
				if (spawns.length === 1) {
					const { agentId, jobId } = started[0];
					onUpdate?.({
						content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
						details: buildAsyncDetails(),
					});
					return withAdvisory({
						content: [
							{
								type: "text",
								text: `Spawned agent \`${agentId}\` (job \`${jobId}\`). Its result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first. ${coordinationHint}`,
							},
						],
						details: buildAsyncDetails(),
					});
				}
				const startedListing = started
					.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`)
					.join("\n");
				onUpdate?.({
					content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
					details: buildAsyncDetails(),
				});
				return withAdvisory({
					content: [
						{
							type: "text",
							text: `Spawned ${started.length} background agents using ${agentLabel}.${scheduleFailureSummary} Each result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first.\n${startedListing}\n${coordinationHint}`,
						},
					],
					details: buildAsyncDetails(),
				});
			}

			// Mixed call: the async jobs above already run detached; the blocking
			// subset runs inline and gates the call's return — exactly what each
			// agent type declares (`blocking: true` = the parent waits on it).
			const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Running ${syncLabel} inline; ${started.length} background agent${started.length === 1 ? "" : "s"} spawned...`,
					},
				],
				details: buildAsyncDetails(),
			});
			const payloads = await this.#runSyncSpawns({
				toolCallId,
				params,
				defaultAgent,
				signal,
				spawns: syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index, preAllocatedId: spawn.agentId })),
				onItemProgress: onUpdate
					? (index, progress) => {
							const spawn = spawns.find(candidate => candidate.index === index);
							if (spawn) spawn.progress = { ...progress, index };
							onUpdate({
								content: [{ type: "text", text: `Running ${syncLabel} inline...` }],
								details: buildAsyncDetails(),
							});
						}
					: undefined,
			});
			const merged = mergeSyncPayloads(
				syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
				payloads,
			);
			syncResults.push(...merged.results);
			syncUsage = merged.usage;
			syncOutputPaths = merged.outputPaths;
			syncProjectAgentsDir = merged.projectAgentsDir;
			// Settle the inline spawns' progress rows from their merged results so
			// post-return job updates carry final statuses, not the last snapshot.
			for (let position = 0; position < syncSpawns.length; position++) {
				const spawn = syncSpawns[position];
				const result = merged.results.find(r => r.id === spawn.agentId);
				if (result) {
					spawn.progress.status = result.aborted
						? "aborted"
						: result.exitCode === 0 && !result.error
							? "completed"
							: "failed";
					spawn.progress.durationMs = result.durationMs;
				} else {
					spawn.progress.status = payloads[position] ? "failed" : "aborted";
				}
			}

			const spawnedSummary =
				started.length > 0
					? `Spawned ${started.length} background agent${started.length === 1 ? "" : "s"}.${scheduleFailureSummary} Each result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first.\n${started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n")}\n${coordinationHint}`
					: scheduleFailureSummary.trim();
			const text = [merged.contentParts.join("\n\n"), spawnedSummary]
				.filter(section => section.trim().length > 0)
				.join("\n\n");
			return withAdvisory({
				content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
				details: buildAsyncDetails(),
			});
		} finally {
			await this.#releasePreparedState(prepared);
		}
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its yield text. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManager;
		toolCallId: string;
		spawnParams: TaskParams;
		agentId: string;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
	}): string {
		const { manager, toolCallId, spawnParams, agentId, progress, ircEnabled, buildDetails, onUpdate, onSettled } =
			options;
		const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
			if (aborted) {
				const ref = AgentRegistry.global().get(agentId);
				const transcript = (await hasResolvableTranscript(agentId))
					? `transcript at history://${agentId}`
					: "transcript unavailable";
				if (ref?.status === "idle" || ref?.status === "parked") {
					const followUp = ircEnabled ? "message it via `hub` to resume; " : "";
					return `\n\n${agentId} was stopped but is still resumable — ${followUp}${transcript}`;
				}
				return `\n\n${agentId} was aborted — ${transcript}`;
			}
			const followUp = ircEnabled ? "message it via `hub` to follow up; " : "";
			return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
		};
		return manager.register(
			"task",
			oneLineLabel(spawnParams.task ?? agentId),
			async ({ signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const semaphore = this.#getSpawnSemaphore();
				let semaphoreHeld = false;
				// Every release funnels through here: the flag flips before the
				// release so no path — acquire-time abort, executor failure, or a
				// future refactor that reorders the branches — can return a permit
				// twice. Releasing a permit this job never acquired would steal one
				// from a running job and let a later spawn start past
				// task.maxConcurrency.
				const releasePermit = () => {
					if (!semaphoreHeld) return;
					semaphoreHeld = false;
					this.#releaseSpawnSemaphore();
				};
				try {
					await semaphore.acquire(runSignal);
					semaphoreHeld = true;
				} catch {
					// Fall through so an acquire-time abort goes through the same
					// path as the post-acquire race below: progress + onSettled
					// have to fire even when the spawn never reached the executor,
					// otherwise the batch aggregate state stays "running" forever.
				}
				const acquiredAt = Date.now();
				if (!semaphoreHeld || runSignal.aborted) {
					await this.#getOutputManager().release(agentId);
					this.#preparedSpawns.delete(agentId);
					releasePermit();
					progress.status = "aborted";
					onSettled?.(true);
					throw new Error("Aborted before execution");
				}
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(
						`Running background task ${agentId}...`,
						buildDetails() as unknown as Record<string, unknown>,
					);
					const forwardSyncProgress: AgentToolUpdateCallback<TaskToolDetails> = async update => {
						const nextProgress = update.details?.progress?.[0];
						if (nextProgress) {
							// The job body owns status and identity (id/index/agent);
							// copy only the live metrics the subagent streams so the
							// polling row reflects the resolved model, reasoning level,
							// and running counters without reverting the "running"
							// status back to the subagent's initial "pending" snapshot.
							progress.modelRole = nextProgress.modelRole ?? progress.modelRole;
							progress.resolvedModel = nextProgress.resolvedModel;
							progress.requestedModel = nextProgress.requestedModel;
							progress.resolvedModelIsFallback =
								nextProgress.resolvedModelIsFallback ?? progress.resolvedModelIsFallback;
							progress.tokens = nextProgress.tokens;
							progress.requests = nextProgress.requests;
							progress.contextTokens = nextProgress.contextTokens;
							progress.contextWindow = nextProgress.contextWindow;
							progress.cost = nextProgress.cost;
							progress.toolCount = nextProgress.toolCount;
							progress.currentTool = nextProgress.currentTool;
							progress.lastIntent = nextProgress.lastIntent;
							progress.recentTools = nextProgress.recentTools.slice();
							progress.recentOutput = nextProgress.recentOutput.slice();
							progress.retryState = nextProgress.retryState;
							progress.retryFailure = nextProgress.retryFailure;
						}
						const updateText =
							update.content.find(part => part.type === "text")?.text ?? `Running background task ${agentId}...`;
						await reportProgress(updateText, buildDetails() as unknown as Record<string, unknown>);
					};
					const result = await this.#executeSync(
						toolCallId,
						spawnParams,
						runSignal,
						forwardSyncProgress,
						agentId,
						progress.index,
						true,
						{ invokedAt: startedAt, acquiredAt },
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					const singleResult = result.details?.results[0];
					// A missing result means the sync path failed at the tool level
					// (results: []) — treat it as a failure, not success.
					const resultFailed = !singleResult || (singleResult.aborted ?? false) || singleResult.exitCode !== 0;
					progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
					progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					progress.retryState = undefined;
					progress.modelRole = singleResult?.modelRole ?? progress.modelRole;
					progress.requestedModel = singleResult?.requestedModel;
					if (singleResult?.resolvedModel) {
						progress.resolvedModel = singleResult.resolvedModel;
						progress.resolvedModelIsFallback =
							singleResult.resolvedModelIsFallback ?? progress.resolvedModelIsFallback;
					} else {
						delete progress.resolvedModel;
						delete progress.resolvedModelIsFallback;
					}
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? `Background task ${agentId} failed.`
						: `Background task ${agentId} complete.`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const deliveryText = `${finalText}${await buildFollowUpHint(singleResult?.aborted === true)}`;
					if (resultFailed) {
						// Mark the job itself failed; the failed agent stays interrogable.
						throw new TaskJobError(deliveryText);
					}
					return deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					onSettled?.(true);
					const statusText = `Background task ${agentId} failed.`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const message = error instanceof Error ? error.message : String(error);
					const hint = AgentRegistry.global().get(agentId) ? await buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				} finally {
					releasePermit();
					this.#preparedSpawns.delete(agentId);
				}
			},
			{
				id: agentId,
				agentId,
				queued: true,
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: text => {
					onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
				},
			},
		);
	}

	/**
	 * Sync fan-out (async unavailable, or every item's agent type is
	 * `blocking: true`): run every spawn to completion inline and merge the
	 * per-spawn payloads into a single tool result. The session-scoped
	 * semaphore still bounds concurrency across parallel task calls.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawns: SyncSpawnRef[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawns.length === 1) {
			const spawn = spawns[0]!;
			const semaphore = this.#getSpawnSemaphore();
			const invokedAt = Date.now();
			await semaphore.acquire(signal);
			const acquiredAt = Date.now();
			try {
				return await this.#executeSync(
					toolCallId,
					spawnParamsFor(params, spawn.item, defaultAgent),
					signal,
					onUpdate,
					spawn.preAllocatedId,
					spawn.index,
					false,
					{ invokedAt, acquiredAt },
				);
			} finally {
				this.#releaseSpawnSemaphore();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawns.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns,
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
		});

		const merged = mergeSyncPayloads(spawns, payloads);
		return {
			content: [{ type: "text", text: merged.contentParts.join("\n\n") }],
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	/**
	 * Run a set of spawns to completion inline, bounded by the session spawn
	 * semaphore. `preAllocatedId` reuses an id claimed up front (mixed calls);
	 * `index` is each item's position in the original call so progress rows and
	 * merged results keep stable ordering. Per-item progress snapshots flow
	 * through `onItemProgress`. Returns per-spawn payloads in input order;
	 * `undefined` marks a spawn cancelled before it started.
	 */
	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const semaphore = this.#getSpawnSemaphore();
		const { results } = await mapWithConcurrencyLimitAllSettled(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const invokedAt = Date.now();
				let semaphoreHeld = false;
				try {
					await semaphore.acquire(workerSignal);
					semaphoreHeld = true;
				} catch (error) {
					if (workerSignal.aborted) return undefined;
					throw error;
				}
				const acquiredAt = Date.now();
				try {
					const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined;
					return await this.#executeSync(
						toolCallId,
						spawnParamsFor(params, spawn.item, defaultAgent),
						workerSignal,
						itemOnUpdate,
						spawn.preAllocatedId,
						spawn.index,
						false,
						{ invokedAt, acquiredAt },
					);
				} finally {
					if (semaphoreHeld) this.#releaseSpawnSemaphore();
				}
			},
			signal,
		);
		return results.map((settled, position) => {
			if (!settled) return undefined;
			if (settled.status === "fulfilled") return settled.value;
			const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
			const item = spawns[position].item;
			return {
				content: [
					{
						type: "text",
						text: `Task ${item.name?.trim() || `#${spawns[position].index + 1}`} failed: ${message}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		});
	}

	/**
	 * Synchronous execution of one spawn. Used as the body of every
	 * async job and directly by the sync fallback (no job manager / blocking
	 * agent) and by in-process callers that need the result inline (e.g. the
	 * commit flow's analyze_files tool).
	 */
	async #executeSync(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(toolCallId, params, signal, onUpdate, preAllocatedId, spawnIndex, detached, launchTiming);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		let latestProgress: AgentProgress | undefined;
		const preparedReservation = preAllocatedId ? this.#preparedSpawns.get(preAllocatedId) : undefined;
		if (!preparedReservation) {
			return createTaskModeError("Task execution is missing its exact prepared state.");
		}
		preparedReservation.handedOff = true;
		this.#preparedSpawns.delete(preAllocatedId!);
		params = preparedReservation.params;
		const preparedPolicy = preparedReservation.policy;
		const agentName = preparedPolicy.agentName;
		const agent = preparedPolicy.agent;
		const { projectAgentsDir } = preparedPolicy.discovery;
		const permissionAgent = preparedReservation.permissionAgent;
		const preparedSettings = preparedReservation.settings;
		const permissionScope = preparedReservation.permissionScope;
		const sharedContext = preparedReservation.sharedContext;
		const assignment = (params.task ?? "").trim();
		const isIsolated = preparedReservation.isIsolated;
		const mergeMode = preparedReservation.mergeMode;
		const preferredIsolationBackend = preparedReservation.preferredIsolationBackend;
		const isolationContext = preparedReservation.isolationContext;
		const parentServiceTier = preparedReservation.parentServiceTier;
		const repoRoot = isolationContext?.repoRoot ?? null;
		const subagentLspEnabled = preparedReservation.enableLsp;
		const ircEnabled = preparedReservation.enableIrc;
		const planModeEnabled = preparedPolicy.planMode;
		const maxRuntimeMs = preparedReservation.maxRuntimeMs;
		const allowEffortOverride = preparedReservation.allowEffortOverride;
		const modelOverride = preparedPolicy.modelOverride;
		const modelRole = preparedPolicy.modelRole;
		const requestedModel = params.model;
		const exactModelOverride = requestedModel !== undefined;
		const effectiveOutputSchema = preparedPolicy.schema.schema;
		const outputSchemaSource = preparedPolicy.schema.source;
		const outputSchemaMode = preparedPolicy.schema.mode;
		const outputSchemaOverridesAgent = preparedPolicy.schema.outputSchemaOverridesAgent;
		const planReference = preparedReservation.planReference;
		const browserAudit = preparedReservation.browserAudit;
		const auditConstrained = browserAudit !== undefined;
		const localProtocolOptions = preparedReservation.localProtocolOptions;

		// Derive artifacts directory
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		// Subagents adopt the parent's ArtifactManager so artifact IDs are unique
		// across the whole tree and outputs land flat in the parent's dir.
		const parentArtifactManager = this.session.getArtifactManager?.() ?? undefined;

		let executionInvoked = false;
		try {
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });

			const agentId = preAllocatedId!;

			const availableSkills = [...(this.session.skills ?? [])];
			// Resolve autoload skills from agent definition against available skills
			const resolvedAutoloadSkills =
				agent.autoloadSkills?.length && availableSkills.length > 0
					? agent.autoloadSkills
							.map(name => availableSkills.find(s => s.name === name))
							.filter((s): s is NonNullable<typeof s> => s !== undefined)
					: [];
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;
			const parentEvalSessionId = this.session.getEvalSessionId?.() ?? undefined;
			const mcpManager = this.session.mcpManager ?? MCPManager.instance();

			// Progress tracking for the single agent
			const initialProgress: AgentProgress = {
				index: spawnIndex,
				id: agentId,
				agent: agentName,
				agentSource: agent.source,
				status: "pending",
				task: renderSubagentUserPrompt(assignment),
				assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
				modelOverride,
				modelRole,
				requestedModel,
			};
			latestProgress = initialProgress;
			const emitProgress = () => {
				const progress = latestProgress;
				if (!progress) return;
				onUpdate?.({
					content: [{ type: "text", text: `Running agent ${agentId}...` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
						progress: [progress],
					},
				});
			};
			emitProgress();

			const buildCommitMessageFn = makeIsolationCommitMessage(this.session);

			const sharedRunOptions: ExecutorOptions = {
				settings: preparedSettings,
				artifactsDir: this.session.getArtifactsDir?.() ?? effectiveArtifactsDir,

				cwd: this.session.cwd,
				id: agentId,
				agent: permissionAgent,
				thinkingLevel: permissionAgent.thinkingLevel,
				task: renderSubagentUserPrompt(assignment),
				assignment,
				context: sharedContext,
				...(allowEffortOverride && params.effort !== undefined ? { effort: params.effort } : {}),
				planReference,
				outputSchema: effectiveOutputSchema,
				outputSchemaMode,
				outputSchemaSource,
				outputSchemaOverridesAgent,
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				modelOverride,
				modelRole,
				requestedModel,
				exactModelOverride,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				enableLsp: auditConstrained ? false : planModeEnabled ? false : subagentLspEnabled,
				enableIrc: auditConstrained ? false : planModeEnabled ? false : ircEnabled,
				restrictToolNames: auditConstrained || planModeEnabled || undefined,
				maxRuntimeMs,
				signal,
				onProgress: (progress: AgentProgress) => {
					const nextProgress = { ...progress, recentTools: progress.recentTools.slice() };
					latestProgress = nextProgress;
					onUpdate?.({
						content: [{ type: "text", text: `Running agent ${progress.id}...` }],
						details: {
							projectAgentsDir: null,
							results: [],
							totalDurationMs: Date.now() - startTime,
							progress: [nextProgress],
						},
					});
				},
				authStorage: this.session.authStorage,
				modelRegistry: this.session.modelRegistry,
				eventBus: this.session.eventBus,
				mcpManager,
				contextFiles,
				skills: availableSkills,
				autoloadSkills: resolvedAutoloadSkills,
				workspaceTree: this.session.workspaceTree,
				promptTemplates,
				rules: this.session.rules,
				preloadedExtensionPaths: auditConstrained ? undefined : this.session.extensionPaths,
				preloadedCustomToolPaths: auditConstrained ? undefined : this.session.customToolPaths,
				localProtocolOptions,
				parentArtifactManager,
				parentHindsightSessionState: this.session.getHindsightSessionState?.(),
				parentMnemopiSessionState: this.session.getMnemopiSessionState?.(),
				parentTelemetry: this.session.getTelemetry?.(),
				parentEvalSessionId,
				parentAgentId: this.session.getAgentId?.() ?? MAIN_AGENT_ID,
				permissionScope,
				parentServiceTier,
			} satisfies ExecutorOptions;
			bindBrowserAuditRunOptions(sharedRunOptions.agent, browserAudit);

			const runTask = async (): Promise<SingleResult> => {
				if (!isIsolated) {
					executionInvoked = true;
					return runSubprocess(sharedRunOptions);
				}
				if (!isolationContext) {
					throw new Error("Isolated task execution not initialized.");
				}
				const taskStart = Date.now();
				executionInvoked = true;
				return runIsolatedSubprocess({
					baseOptions: sharedRunOptions,
					context: isolationContext,
					preferredBackend: preferredIsolationBackend,
					agentId,
					mergeMode,
					artifactsDir: effectiveArtifactsDir,
					buildCommitMessage: buildCommitMessageFn,
					buildFailureResult: err => {
						const message = err instanceof Error ? err.message : String(err);
						return {
							index: spawnIndex,
							id: agentId,
							agent: agent.name,
							agentSource: agent.source,
							task: renderSubagentUserPrompt(assignment),
							assignment,
							exitCode: 1,
							output: "",
							stderr: message,
							truncated: false,
							durationMs: Date.now() - taskStart,
							tokens: 0,
							requests: 0,
							modelOverride,
							modelRole,
							requestedModel,
							error: message,
						};
					},
				});
			};

			const result = await runTask();

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let mergedBranchForNestedPatches = false;
			if (isIsolated && repoRoot) {
				const outcome = await mergeIsolatedChanges({ result, repoRoot, mergeMode });
				mergeSummary = outcome.summary;
				changesApplied = outcome.changesApplied;
				mergedBranchForNestedPatches = outcome.mergedBranchForNestedPatches;
			}

			// Apply nested repo patches (separate from parent git).
			if (isIsolated && repoRoot) {
				mergeSummary += await applyEligibleNestedPatches({
					result,
					repoRoot,
					mergeMode,
					changesApplied,
					mergedBranchForNestedPatches,
					commitMessage: buildCommitMessageFn(),
				});
			}

			// Cleanup temp directory if used
			const shouldCleanupTempArtifacts =
				tempArtifactsDir && (!isIsolated || changesApplied === true || changesApplied === null);
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			return this.#buildResultPayload(result, projectAgentsDir, Date.now() - startTime, mergeSummary);
		} catch (err) {
			if (!executionInvoked) await this.#getOutputManager().release(preAllocatedId!);
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Task execution failed: ${message}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
					...(latestProgress ? { progress: [latestProgress] } : {}),
				},
			};
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		const status = result.aborted
			? "cancelled"
			: result.exitCode === 0 && result.error
				? "merge failed"
				: result.exitCode === 0
					? "completed"
					: `failed (exit ${result.exitCode})`;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold && result.outputPath) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
		// the parent so it can resume via irc instead of redoing the work.
		const refStatus = AgentRegistry.global().get(result.id)?.status;
		const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? result.abortReason : undefined,
			resumable,
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}
