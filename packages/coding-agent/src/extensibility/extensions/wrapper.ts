/** Tool wrappers for extensions. */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolPreparedExecution,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { ComputerSafetyCheck, ImageContent, Static, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import type { PermissionDenialDetails } from "@oh-my-pi/pi-wire";
import { sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import {
	truncateForPrompt,
	type ApprovalMode,
	denyError,
	formatApprovalPrompt,
	resolveApproval,
} from "../../tools/approval";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import {
	runArtifactOperation,
	runExtensionOperation,
	runFilesystemOperation,
	runLocalOperation,
	runMcpOperation,
	runEvalOperation,
	runSessionOperation,
} from "../../registry/operation-lease";
import { rewriteAuthorizedInput, type SessionPathScope } from "../../internal/session-path-scope";
import { evaluateRestrictedToolGuardrails } from "../../internal/restricted-startup-policy";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { withFileMutationSession } from "../../tools/file-write-fallback";
import {
	evaluateSubagentPermission,
	type EffectiveSubagentPermissions,
	type EffectiveToolDescriptor,
	type ToolExecutionAuthority,
} from "../../task/permission-profiles";
import type { Theme } from "../../modes/theme/theme";
import { withLspSessionPolicy } from "../../lsp/client";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolCallEventResult, ToolResultEventResult } from "./types";
type ClassFixedOperationRunner = typeof runMcpOperation;

let descriptorSequence = 0;
type PreparationRecord = {
	descriptor: EffectiveToolDescriptor;
	toolCallId: string;
	input: object;
	inner: AgentToolPreparedExecution | undefined;
	consumed: boolean;
	disposed: boolean;
};

/** Session-local authority for exact descriptor-bound, one-use preparations. */
export class EffectiveToolRegistry implements ToolExecutionAuthority {
	readonly #descriptors = new Map<string, EffectiveToolDescriptor>();
	readonly #preparations = new WeakMap<object, PreparationRecord>();

	registerDescriptor(descriptor: EffectiveToolDescriptor): void {
		const normalizedName = descriptor.normalizedName || descriptor.name.trim().toLowerCase();
		const frozen = Object.freeze({
			...descriptor,
			normalizedName,
			descriptorId: descriptor.descriptorId || `descriptor:${++descriptorSequence}`,
		});
		this.#descriptors.set(normalizedName, frozen);
	}

	getDescriptor(name: string): EffectiveToolDescriptor | undefined {
		return this.#descriptors.get(name.trim().toLowerCase());
	}

	prepare(name: string, toolCallId: string, input: object, inner: AgentToolPreparedExecution | undefined) {
		const descriptor = this.getDescriptor(name);
		if (!descriptor) throw new Error(`Tool "${name}" is not registry-authorized.`);
		const record: PreparationRecord = { descriptor, toolCallId, input, inner, consumed: false, disposed: false };
		const handle = {
			metadata: Object.freeze({
				descriptorId: descriptor.descriptorId,
				origin: descriptor.origin,
				tool: descriptor.normalizedName,
			}),
			consume: <T>(owner: object, expectedToolCallId: string): T => {
				if (record.consumed) throw new Error("Registry execution preparation was already consumed.");
				if (record.disposed) throw new Error("Registry execution preparation is stale.");
				if (this.#descriptors.get(descriptor.normalizedName) !== descriptor)
					throw new Error("Registry execution preparation is stale after tool registry refresh.");
				if (descriptor.tool !== owner)
					throw new Error("Registry execution preparation targets a different tool object.");
				if (expectedToolCallId !== toolCallId)
					throw new Error("Registry execution preparation targets a different tool call.");
				record.consumed = true;
				return (inner ? inner.consume<T>(owner, expectedToolCallId) : undefined) as T;
			},
			dispose: async () => {
				if (record.disposed) return;
				record.disposed = true;
				if (!record.consumed) await inner?.dispose();
			},
		} satisfies AgentToolPreparedExecution;
		this.#preparations.set(handle, record);
		return handle;
	}

	validatePrepared(prepared: AgentToolPreparedExecution, name: string, toolCallId: string, input: object): void {
		const record = this.#preparations.get(prepared);
		const descriptor = this.getDescriptor(name);
		if (!record || !descriptor || record.descriptor !== descriptor)
			throw new Error("Registry execution preparation is missing or stale.");
		if (record.toolCallId !== toolCallId)
			throw new Error("Registry execution preparation targets a different tool call.");
		if (record.input !== input) throw new Error("Registry execution preparation targets different final input.");
		if (record.consumed) throw new Error("Registry execution preparation was already consumed.");
		if (record.disposed) throw new Error("Registry execution preparation is stale.");
	}
}
function operationRunnerForTool(tool: AgentTool, params: unknown): ClassFixedOperationRunner | undefined {
	if (tool.name === "hub") return undefined;
	const candidate = tool as AgentTool & { mcpServerName?: string };
	if (candidate.mcpServerName !== undefined) return runMcpOperation;
	if (tool.name === "eval") return runEvalOperation;
	if (tool.name === "task") return runSessionOperation;
	if (["read", "write", "edit", "grep", "glob", "ast_edit", "ast_grep", "lsp", "bash"].includes(tool.name)) {
		const values = JSON.stringify(params);
		if (values.includes("artifact://")) return runArtifactOperation;
		if (values.includes("local://")) return runLocalOperation;
		return runFilesystemOperation;
	}
	return runExtensionOperation;
}

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<any, any, any> {
	declare name: string;
	declare description: string;
	declare parameters: any;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: any, options: any, theme: any) => any;
	renderResult?: (result: any, options: any, theme: any, args?: any) => any;
	readonly loadMode: ToolLoadMode;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);
		this.loadMode = defaultLoadModeForToolName(registeredTool.definition.name, registeredTool.definition.loadMode);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				registeredTool.definition.renderCall!(args, options, theme as Theme);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result: any, options: any, theme: any, args?: any) =>
				registeredTool.definition.renderResult!(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
		context?: AgentToolContext,
		preparedExecution?: AgentToolPreparedExecution,
	) {
		// Bind the extension context to this tool's own name so `ctx.invokeTool` delegates to the
		// native built-in of the same name (present only when this tool re-registers a built-in). The
		// wrapper's own context, abort signal, and progress callback are inherited by the delegated
		// call, so a bare `ctx.invokeTool(params)` keeps the caller's `toolCall`/provider metadata
		// (write/edit LSP batching, computer safety acknowledgement), stops when the outer call is
		// aborted, and still streams native progress.
		return this.registeredTool.definition.execute(
			toolCallId,
			params,
			signal,
			onUpdate,
			this.runner.createContext(undefined, {
				toolName: this.registeredTool.definition.name,
				context,
				signal,
				onUpdate,
			}),
			preparedExecution,
		);
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

function computerSafetyChecks(context: AgentToolContext | undefined): ComputerSafetyCheck[] {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? metadata.pendingSafetyChecks : [];
}

function approvalArgs(params: unknown, context: AgentToolContext | undefined): unknown {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? { actions: metadata.actions } : params;
}

function toolEventArgs(params: unknown, context: AgentToolContext | undefined): Record<string, unknown> {
	const metadata = context?.toolCall?.providerMetadata;
	if (metadata?.type === "computer") {
		return {
			actions: metadata.actions,
			pendingSafetyChecks: metadata.pendingSafetyChecks,
		};
	}
	return recordParams(params);
}
function recordParams(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const record: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) record[key] = entry;
	return record;
}

type OptionalRunnerCapabilities = {
	hasHandlers?: (eventType: string) => boolean;
	consumeToolCallEmitted?: (toolCallId: string, toolName: string) => boolean;
	emitToolCall?: (event: unknown, signal?: AbortSignal) => Promise<unknown>;
	emitToolResult?: (event: unknown) => Promise<unknown>;
	emit?: ExtensionRunner["emit"];
	getPermissionScope?: () => EffectiveSubagentPermissions | undefined;
	getToolExecutionAuthority?: () => ToolExecutionAuthority | undefined;
	getPathScope?: () => SessionPathScope | undefined;
	getCwd?: () => string;
	recordPermissionDenial?: (details: PermissionDenialDetails) => void;
	runScoped?: <T>(fn: () => T) => T;
	isSharedLspEnabled?: () => boolean;
	sessionId?: string;
};
function optionalRunnerCapabilities(runner: ExtensionRunner): OptionalRunnerCapabilities {
	return runner as unknown as OptionalRunnerCapabilities;
}

function hasRunnerHandlers(runner: ExtensionRunner, eventType: string): boolean {
	const method = optionalRunnerCapabilities(runner).hasHandlers;
	return typeof method === "function" && method.call(runner, eventType);
}

function hasRunnerEmitter(runner: ExtensionRunner): boolean {
	return typeof optionalRunnerCapabilities(runner).emit === "function";
}

function approvalData(value: string): string {
	const sanitized = sanitizeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim();
	const truncated = truncateForPrompt(sanitized, 500);
	return truncated.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

function safetyCheckLines(checks: readonly ComputerSafetyCheck[]): string[] {
	return checks.map((check, index) => {
		const value = check.message || check.code || check.id;
		return `${index + 1}. ${approvalData(value)}`;
	});
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown> implements AgentTool<
	TParameters,
	TDetails
> {
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	/** Exact underlying executor used for registry descriptor identity. */
	get executionTarget(): AgentTool<TParameters, TDetails> {
		return this.tool;
	}
	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
		preparedExecution?: AgentToolPreparedExecution,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		// The agent loop emits `tool_call` at arg-prep time (session
		// `beforeToolCall` wiring) so a handler revision lands before concurrency
		// scheduling and `tool_execution_start`. Consume the marker
		// unconditionally so it cannot go stale; emit here only for dispatches
		// the loop never saw — nested xd:// device dispatches and direct
		// (non-loop) execution such as Cursor exec handlers.
		const runner = optionalRunnerCapabilities(this.runner);
		const loopEmittedToolCall = runner.consumeToolCallEmitted?.call(this.runner, toolCallId, this.tool.name) ?? false;
		const assertAuthorized = (candidate: Static<TParameters>): void => {
			const scope = runner.getPermissionScope?.call(this.runner);
			if (scope === undefined) return;
			const toolInput = recordParams(candidate);
			const permissionDecision = evaluateSubagentPermission({
				scope,
				toolName: this.tool.name,
				toolInput,
				cwd: runner.getCwd?.call(this.runner) ?? "",
			});
			if (permissionDecision.action === "deny") {
				runner.recordPermissionDenial?.call(this.runner, permissionDecision.details);
				throw new Error(permissionDecision.reason);
			}
			const guardrailDecision = evaluateRestrictedToolGuardrails({
				scope,
				toolName: this.tool.name,
				toolInput,
			});
			if (guardrailDecision.action === "deny") {
				runner.recordPermissionDenial?.call(this.runner, guardrailDecision.details);
				throw new Error(guardrailDecision.reason);
			}
		};
		assertAuthorized(params);

		// 1. Emit tool_call event first - extensions can block execution or revise the input the tool
		// runs with. Doing this BEFORE the approval gate means approval (below) resolves against the
		// input that actually executes, closing the "approve one thing, run another" gap: the prompt
		// text, policy resolution, and provider safety checks all see `effectiveParams`.
		let effectiveParams = params;
		if (
			!loopEmittedToolCall &&
			hasRunnerHandlers(this.runner, "tool_call") &&
			typeof runner.emitToolCall === "function"
		) {
			try {
				const callResult = (await runner.emitToolCall.call(
					this.runner,
					{
						type: "tool_call",
						toolName: this.tool.name,
						toolCallId,
						input: normalizeToolEventInput(
							this.tool.name,
							resolveToolEventInput(this.tool, toolEventArgs(params, context)),
						),
					},
					signal,
				)) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}
				if (callResult?.input !== undefined && context?.toolCall?.providerMetadata?.type !== "computer") {
					effectiveParams = callResult.input as typeof params;
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}
		assertAuthorized(effectiveParams);
		const pathScope = runner.getPathScope?.call(this.runner);
		const pathInput = recordParams(effectiveParams);
		if (pathScope && Object.keys(pathInput).length > 0) {
			const replacements = await pathScope.authorizeInput(this.tool.name, pathInput);
			effectiveParams = rewriteAuthorizedInput(pathInput, replacements) as typeof effectiveParams;
		}
		const settings = context?.settings;
		const approvalMode: ApprovalMode =
			context?.autoApprove === true ? "yolo" : (settings?.get("tools.approvalMode") ?? "yolo");
		const userPolicies = (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
		const scope = runner.getPermissionScope?.call(this.runner);
		const enforcePreparation = scope?.mode === "enforce";
		const authority = runner.getToolExecutionAuthority?.call(this.runner);
		const ownsPreparation = preparedExecution === undefined;
		const executionKey = ownsPreparation ? Object.freeze({}) : undefined;
		let effectivePreparedExecution = preparedExecution;
		try {
			if (enforcePreparation) {
				if (!authority) throw new Error(`Tool "${this.tool.name}" has no registry execution authority.`);
				if (effectivePreparedExecution !== undefined) {
					authority.validatePrepared(
						effectivePreparedExecution,
						this.tool.name,
						toolCallId,
						effectiveParams as object,
					);
				} else {
					const innerPreparation = await this.tool.prepareExecution?.(
						toolCallId,
						effectiveParams,
						signal,
						context,
						executionKey!,
					);
					effectivePreparedExecution = authority.prepare(
						this.tool.name,
						toolCallId,
						effectiveParams as object,
						innerPreparation,
					);
					if (innerPreparation === undefined) {
						effectivePreparedExecution.consume(this.tool, toolCallId);
						effectivePreparedExecution = undefined;
					}
				}
			} else if (effectivePreparedExecution === undefined) {
				effectivePreparedExecution = await this.tool.prepareExecution?.(
					toolCallId,
					effectiveParams,
					signal,
					context,
					executionKey!,
				);
			}
			// 2. Full approval gate against the (possibly revised) input that will actually run — resolves
			// policy and prompts on `effectiveParams`, so the user approves exactly what executes. A revised
			// input that newly resolves to `deny` is caught here even though the original passed the
			// short-circuit above.
			const resolvedArgs = approvalArgs(effectiveParams, context);
			const resolved = resolveApproval(this.tool, resolvedArgs, approvalMode, userPolicies);
			context?.xdevTierResolved?.(resolved.tier);
			if (resolved.policy === "deny") {
				throw denyError(resolved, this.tool.name);
			}
			const pendingSafetyChecks = computerSafetyChecks(context);
			// An xd:// device dispatch already cleared the write tool's outer gate at
			// this tool's tier — re-prompting would double-ask for one action. The
			// bypass only holds while the input is exactly what that outer gate
			// approved: a handler revision here may have raised the tier, so revised
			// input always faces the full gate. Explicit per-tool "prompt" policies
			// and tool-demanded overrides still prompt. Provider safety checks are
			// stronger: yolo, per-tool allow, and xdev approval never acknowledge
			// them on the user's behalf.
			const explicitPrompt = resolved.override || Object.hasOwn(userPolicies, resolved.policyKey ?? this.tool.name);
			const xdevBypass = context?.xdevApproved === true && effectiveParams === params;
			const approvalCheck = {
				required:
					pendingSafetyChecks.length > 0 || (resolved.policy === "prompt" && (explicitPrompt || !xdevBypass)),
				reason: resolved.reason,
			};

			if (approvalCheck.required) {
				const scheduledCall = context?.toolCall?.toolCalls[context.toolCall.index];
				if (
					scheduledCall?.id === toolCallId &&
					(scheduledCall.name === this.tool.name || scheduledCall.name === this.tool.customWireName)
				) {
					await untilAborted(signal, () => this.runner.waitForToolApprovalPreview(toolCallId));
				}

				const hasApprovalHandlers =
					hasRunnerEmitter(this.runner) &&
					(hasRunnerHandlers(this.runner, "tool_approval_requested") ||
						hasRunnerHandlers(this.runner, "tool_approval_resolved"));
				const sessionId = context?.sessionManager?.getSessionId() ?? "";
				if (hasApprovalHandlers) {
					await runner.emit?.call(this.runner, {
						type: "tool_approval_requested",
						sessionId,
						toolName: this.tool.name,
						toolCallId,
						...(approvalCheck.reason ? { reason: approvalCheck.reason } : {}),
						approvalMode,
					});
				}

				const emitApprovalResolved = async (approved: boolean, reason?: string) => {
					if (!hasApprovalHandlers) return;
					await runner.emit?.call(this.runner, {
						type: "tool_approval_resolved",
						sessionId,
						toolName: this.tool.name,
						toolCallId,
						approved,
						...(reason ? { reason } : {}),
					});
				};

				if (!this.runner.hasUI()) {
					const reason = "no interactive UI available";
					await emitApprovalResolved(false, reason);
					if (pendingSafetyChecks.length > 0) {
						throw new Error(
							`Tool "${this.tool.name}" has pending provider safety checks but no interactive UI is available.`,
						);
					}
					throw new Error(
						`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` +
							`Options:\n` +
							`  1. Set tools.approvalMode: yolo in /settings\n` +
							`  2. Add tools.approval.${this.tool.name}: allow to config\n` +
							`  3. Use an interactive UI to approve the tool call`,
					);
				}

				const uiContext = this.runner.getUIContext();
				const basePrompt = formatApprovalPrompt(this.tool, resolvedArgs, approvalCheck.reason);
				const safetyPrompt =
					pendingSafetyChecks.length > 0
						? `${basePrompt}\nProvider safety checks:\n${safetyCheckLines(pendingSafetyChecks).join("\n")}`
						: basePrompt;
				let choice: string | undefined;
				try {
					choice = await uiContext.select(safetyPrompt, ["Approve", "Deny"]);
				} catch (err) {
					await emitApprovalResolved(false, err instanceof Error ? err.message : "approval aborted");
					throw err;
				}
				const approved = choice === "Approve";
				await emitApprovalResolved(approved, approved ? undefined : "denied by user");
				if (!approved) {
					throw new Error(`Tool call denied by user: ${this.tool.name}`);
				}
				if (pendingSafetyChecks.length > 0) {
					if (!context) throw new Error("Provider safety approval context is unavailable");
					context.providerSafetyApproved = true;
				}
			}

			// Execute the actual tool
			let result: AgentToolResult<TDetails, TParameters>;
			let executionError: Error | undefined;

			try {
				const executeTool = (executionSignal?: AbortSignal) => {
					const runTool = () =>
						this.tool.execute(
							toolCallId,
							effectiveParams,
							executionSignal ?? signal,
							onUpdate,
							context,
							effectivePreparedExecution,
						);
					const sessionId = runner.sessionId;
					const runWithMutation =
						typeof sessionId === "string" && sessionId.length > 0
							? () => withFileMutationSession(sessionId, runTool)
							: runTool;
					const runScoped = runner.runScoped ? () => runner.runScoped!(runWithMutation) : runWithMutation;
					return withLspSessionPolicy(
						{ shared: runner.isSharedLspEnabled?.call(this.runner) === true },
						runScoped,
					);
				};
				const operationRunner = context?.sessionManager
					? operationRunnerForTool(this.tool, effectiveParams)
					: undefined;
				const leasedExecuteTool = pathScope
					? (executionSignal?: AbortSignal) =>
							pathScope.withOperationLease(`${this.tool.name}:${toolCallId}`, () => executeTool(executionSignal))
					: executeTool;
				result = operationRunner
					? await operationRunner(
							context?.sessionManager,
							`${this.tool.name}:${toolCallId}`,
							leasedExecuteTool,
							signal,
						)
					: await leasedExecuteTool(signal);
			} catch (err) {
				executionError = err instanceof Error ? err : new Error(String(err));
				result = {
					content: [{ type: "text", text: executionError.message }],
					details: undefined as TDetails,
				};
			}

			// Emit tool_result event - extensions can modify the result and error status.
			if (hasRunnerHandlers(this.runner, "tool_result") && typeof runner.emitToolResult === "function") {
				const resultResult = (await runner.emitToolResult.call(this.runner, {
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, toolEventArgs(effectiveParams, context)),
					),
					content: result.content,
					details: result.details,
					isError: !!executionError,
				})) as ToolResultEventResult | undefined;

				if (resultResult) {
					const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
					const modifiedDetails = (resultResult.details ?? result.details) as TDetails;
					const effectiveError = resultResult.isError ?? !!executionError;
					return {
						content: modifiedContent,
						details: modifiedDetails,
						providerMetadata: result.providerMetadata,
						...(effectiveError ? { isError: true } : {}),
					};
				}
			}

			// No extension modification
			if (executionError) {
				throw executionError;
			}
			return result;
		} finally {
			if (ownsPreparation) await effectivePreparedExecution?.dispose();
		}
	}
}
