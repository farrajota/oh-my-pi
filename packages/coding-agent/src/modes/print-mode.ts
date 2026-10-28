import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { presentNarrationAsAnswer } from "@oh-my-pi/pi-ai/utils/narration";
import { $flag, logger, postmortem, sanitizeText } from "@oh-my-pi/pi-utils";
import type { MCPManager } from "../mcp/manager";
import { resolveMCPTimeoutMs } from "../mcp/timeout";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { COST_GATE_NOTICE_SOURCE } from "../session/cost-gate";
import { CREDENTIAL_DISABLED_NOTICE_SOURCE } from "../session/credential-disabled-notice";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
// Populate the shared builtin reservation set before extension command discovery.
import "../slash-commands/builtin-registry";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { parseSlashCommand, parseSubcommand } from "../slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { reconnectMcpManagerServer } from "../mcp/oauth-reauth";
import { initializeExtensions } from "./runtime-init";
import {
	formatPersistenceDurabilityFailure,
	formatPersistenceFailure,
	formatPersistenceNotice,
} from "./persistence-failure";

import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "../plan-mode/settings";
import { cfgAsyncPrintWake } from "../tools/settings";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
	printThoughts?: boolean;
	planYolo?: boolean;
	/** Manager returned by session creation; only print mode waits for its servers. */
	mcpManager?: MCPManager;
	/** `--max-time` deadline (epoch ms). It aborts running turns; the background-job wait enforces it itself. */
	deadline?: number;
}

export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;
/** Largest setTimeout delay before 32-bit overflow (Node/Bun fire in ~1 ms past this). */
const MAX_TIMER_MS = 2_147_483_647;
/** Exit status of a run the cost gate stopped (`--max-cost` / `session.maxCost` reached). */
export const PRINT_MODE_COST_CAP_EXIT_CODE = 3;

/** Sanitize untrusted text (server names, errors) into one stderr-safe line. */
function singleLine(text: string): string {
	return sanitizeText(text).replace(/[\r\n\t]+/g, " ");
}

/** Drop the provider-opaque replay payload (e.g. encrypted reasoning items) before printing. */
function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

export function printableEvent(event: AgentSessionEvent): unknown {
	switch (event.type) {
		case "tool_stream_update":
			return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}

export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, planYolo = false } = options;
	session.disableStopTimeTodoReminders();

	// process.stdout.write is fire-and-forget: a large final record (e.g. a
	// multi-MB agent_end) can be dropped when the process exits before the pipe
	// drains, truncating the record mid-line while the process still exits 0.
	// Serialize every stdout write on the previous write's completion callback so
	// records stay ordered and honor backpressure, then block shutdown on the
	// tail before dispose/exit. Same truncation class as issue #5309 (issue #7635).
	let stdoutTail: Promise<void> = Promise.resolve();
	let stderrTail: Promise<void> = Promise.resolve();
	let durabilityFailure = false;
	let persistenceError: Error | undefined;
	let signalShutdown = false;
	let pendingDispose: Promise<void> | undefined;
	const disposeSession = (reason?: postmortem.Reason): Promise<void> => {
		pendingDispose ??= session.dispose({
			mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS,
			reason,
		});
		return pendingDispose;
	};
	const preexistingPersistenceError = session.sessionManager.getPersistenceError?.();
	const writeStdoutLine = (text: string): void => {
		stdoutTail = stdoutTail.then(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			try {
				process.stdout.write(text, err => {
					if (err) durabilityFailure = true;
					resolve();
				});
			} catch {
				durabilityFailure = true;
				resolve();
			}
			return promise;
		});
	};
	const writeStderrLine = (text: string): void => {
		stderrTail = stderrTail.then(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			try {
				if (
					process.stderr.write(`${text}\n`, err => {
						if (err) durabilityFailure = true;
						resolve();
					})
				)
					resolve();
			} catch {
				durabilityFailure = true;
				resolve();
			}
			return promise;
		});
	};
	const unsubscribePersistenceError = session.sessionManager.onPersistenceError?.(error => {
		if (persistenceError) return;
		persistenceError = error;
		writeStderrLine(formatPersistenceFailure(error.message));
	});
	const unregisterSignalTeardown = postmortem.register("print-session-teardown", async reason => {
		signalShutdown ||=
			reason === postmortem.Reason.SIGINT ||
			reason === postmortem.Reason.SIGTERM ||
			reason === postmortem.Reason.SIGHUP;
		try {
			await disposeSession(reason);
		} finally {
			await stdoutTail;
			await stderrTail;
		}
	});

	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) writeStdoutLine(`${JSON.stringify(header)}\n`);
	}
	await initializeExtensions(session, {
		mode: mode === "json" ? "json" : "print",
		reportSendError: (action, err) => {
			process.stderr.write(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
			);
		},
		reportRuntimeError: err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		},
	});

	const planStartupIgnored =
		cfgPlanDefaultOnStartup.get(session.settings) &&
		cfgPlanEnabled.get(session.settings) &&
		session.sessionManager.buildSessionContext().messages.length === 0 &&
		!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		!planYolo;
	if (planStartupIgnored) {
		process.stderr.write(
			"Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.\n",
		);
	}

	const unsubscribePersistenceNotice = session.sessionManager.onPersistenceNotice?.(notice => {
		writeStderrLine(`Warning: ${formatPersistenceNotice(notice)}`);
	});
	// Route CLI-authored slash commands through the shared dispatcher; piped or
	// file-backed initial input remains a prompt and is never command-dispatched.
	const mcpManager = options.mcpManager;
	const builtinRuntimeFor = (): SlashCommandRuntime => ({
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		cwd: session.sessionManager.getCwd(),
		output: writeStderrLine,
		refreshCommands: () => {},
		reloadPlugins: () => Promise.resolve(),
		mcpManager,
		reconnectMcpServer: mcpManager
			? async (name, selected) => {
					const state = await reconnectMcpManagerServer(mcpManager, name, selected);
					if (state) await session.refreshMCPTools(mcpManager.getTools());
					return state;
				}
			: undefined,
		keepTurnOpenUntilIdle: async () => {
			await session.waitForIdle();
		},
	});
	let builtinFailed = false;
	let admittedAgentTurn = false;
	let costCapRefusalBeforeTurn = session.costCapRefusal;
	const PRINT_DISPATCHED_COMMANDS: Record<string, true> = { compact: true, handoff: true, retry: true };
	const dispatchCliMessage = async (message: string): Promise<boolean> => {
		const parsed = parseSlashCommand(message);
		const dispatched =
			parsed !== null &&
			(parsed.name === "mcp"
				? parseSubcommand(parsed.args).verb === "reauth"
				: Object.hasOwn(PRINT_DISPATCHED_COMMANDS, parsed.name));
		if (!dispatched) return false;
		if (signalShutdown) return true;
		if (parsed.name === "retry" && !(await prepareAgentTurn())) return true;
		const refusalBeforeCommand = session.costCapRefusal;
		const result = await executeAcpBuiltinSlashCommand(message, builtinRuntimeFor());
		if (result === false || "prompt" in result) return false;
		if (result.failed) builtinFailed = true;
		if (result.agentInvoked) {
			admittedAgentTurn = true;
			costCapRefusalBeforeTurn = refusalBeforeCommand;
		}
		return true;
	};
	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			writeStdoutLine(`${JSON.stringify(printableEvent(event))}\n`);
		} else if (
			event.type === "notice" &&
			(event.source === CREDENTIAL_DISABLED_NOTICE_SOURCE || event.source === COST_GATE_NOTICE_SOURCE)
		) {
			// Text mode renders no session notices, but an automatic sign-out must not stay
			// hidden behind a sibling account that quietly answers the prompt, and a run
			// must say when it crossed its cost thresholds.
			writeStderrLine(event.source === COST_GATE_NOTICE_SOURCE ? event.message : `Warning: ${event.message}`);
		}
	});

	const timeoutMs = resolveMCPTimeoutMs();
	const strict = $flag("OMP_MCP_REQUIRE_READY");
	let strictMCPFailure = false;
	// Warn once per unavailable server across evaluations: readiness is
	// re-evaluated after a dispatched recovery command, and a still-broken
	// server must not repeat its warning on every pass.
	const warnedUnavailable = new Set<string>();
	/** Await manager startup and bind its current tool set; report unavailable server names. */
	const evaluateReadiness = async (): Promise<string[]> => {
		if (!options.mcpManager) return [];
		const readiness = await options.mcpManager.waitForStartup(timeoutMs);
		// The manager's initial callback may have fired before SDK wiring, or a
		// reconnect may have fired it without awaiting the session mutation.
		// Refresh is serialized by AgentSession, so turn one sees the final snapshot.
		await session.refreshMCPTools(options.mcpManager.getTools());
		const unavailable: string[] = [];
		for (const name of readiness.pending) {
			const server = singleLine(name);
			unavailable.push(server);
			if (warnedUnavailable.has(server)) continue;
			warnedUnavailable.add(server);
			const after = timeoutMs > 0 ? ` after ${timeoutMs}ms` : "";
			writeStderrLine(`Warning: MCP server "${server}" not ready${after}; its tools are unavailable for this run.`);
		}
		for (const { name, error } of readiness.failed) {
			const server = singleLine(name);
			unavailable.push(server);
			if (warnedUnavailable.has(server)) continue;
			warnedUnavailable.add(server);
			writeStderrLine(
				`Warning: MCP server "${server}" failed to connect: ${singleLine(error)}; its tools are unavailable for this run.`,
			);
		}
		return unavailable;
	};
	// Readiness is evaluated lazily — before the first model turn, and again
	// after a dispatched recovery command — never up front: `/mcp reauth` must
	// run before the strict gate decides, or strict automation could never
	// repair the very server the gate failed on.
	let unavailable: string[] = [];
	let readinessDirty = true;
	const ensureReadiness = async (): Promise<void> => {
		if (!readinessDirty) return;
		unavailable = await evaluateReadiness();
		readinessDirty = false;
	};
	const reportStrictFailure = (): void => {
		if (strictMCPFailure) return;
		writeStderrLine(`Error: MCP servers not ready: ${unavailable.join(", ")}`);
		strictMCPFailure = true;
	};

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};
	/** Prepare a model turn after MCP readiness and the strict automation gate. */
	const prepareAgentTurn = async (): Promise<boolean> => {
		if (signalShutdown) return false;
		await ensureReadiness();
		if (signalShutdown) return false;
		if (strict && unavailable.length > 0) {
			reportStrictFailure();
			return false;
		}
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		return true;
	};
	/** Prompt the model with one input, gated on strict MCP readiness. */
	const promptTurn = async (text: string, images?: PrintModeOptions["initialImages"]): Promise<void> => {
		if (!(await prepareAgentTurn())) return;
		admittedAgentTurn = true;
		costCapRefusalBeforeTurn = session.costCapRefusal;
		await logger.time("print:prompt", () =>
			images !== undefined ? session.prompt(text, { images }) : session.prompt(text),
		);
	};

	// Inputs run in order. The merged stdin/@file message is never dispatched
	// (see dispatchCliMessage): it always prompts the model with its text.
	if (initialMessage !== undefined) {
		await promptTurn(initialMessage, initialImages);
	}
	// Remaining messages are CLI-authored: dispatch the recovery command as
	// reached, prompt everything else.
	for (const message of messages) {
		if (strictMCPFailure || signalShutdown) break;
		if (await dispatchCliMessage(message)) {
			readinessDirty = true;
			continue;
		}
		await promptTurn(message);
	}
	// A run with no model turn (every input consumed locally, or none) still
	// reports strict unreadiness: `OMP_MCP_REQUIRE_READY=1 omp -p '/mcp reauth
	// foo'` that failed to repair its server exits with the strict error, not
	// only the builtin's own failure.
	if (strict && !admittedAgentTurn && !strictMCPFailure && !signalShutdown) {
		await ensureReadiness();
		if (unavailable.length > 0) reportStrictFailure();
	}

	// Opt-in async wake keeps background work started by the admitted run alive
	// until its result and any follow-up turns settle, subject to --max-time.
	let asyncWaitExpired = false;
	if (admittedAgentTurn && !strictMCPFailure && !signalShutdown && cfgAsyncPrintWake.get(session.settings)) {
		const { deadline } = options;
		const deadlineReached = Promise.withResolvers<true>();
		let deadlineTimer: NodeJS.Timeout | undefined;
		const armDeadline = (): void => {
			if (deadline === undefined) return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) deadlineReached.resolve(true);
			else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, MAX_TIMER_MS));
		};
		armDeadline();
		const expires = async (work: Promise<void>): Promise<boolean> => {
			const expired = await Promise.race([work.then(() => false), deadlineReached.promise]);
			if (!expired) return false;
			work.catch(() => {});
			return !signalShutdown;
		};
		try {
			asyncWaitExpired = (await expires(session.waitForIdle())) && session.hasPendingAsyncWork();
			while (!asyncWaitExpired && session.hasPendingAsyncWork() && !session.isDisposed && !signalShutdown) {
				if (deadline !== undefined && Date.now() >= deadline && !signalShutdown) {
					asyncWaitExpired = true;
					break;
				}
				asyncWaitExpired = await expires(session.settleAsyncWork());
			}
		} finally {
			clearTimeout(deadlineTimer);
		}
		if (asyncWaitExpired) {
			writeStderrLine("Error: --max-time reached before background work settled; any running jobs were cancelled.");
		}
	}

	session.prepareForHeadlessAdvisorDrain();
	// Past --max-time a follow-up turn can still sit in retry backoff, which this wait
	// includes and only dispose cancels: skip it so teardown can run.
	if (!asyncWaitExpired && !signalShutdown) await session.waitForIdle();

	// Read via the session accessor, not the raw state tail: a classifier
	// refusal is pruned from active context at settle, and an aborted turn
	// can trail synthetic tool results — both would hide the terminal
	// assistant message (and its error) from a last-element read.
	const assistantMsg = admittedAgentTurn ? session.getLastAssistantMessage() : undefined;
	const costCapped = admittedAgentTurn && !strictMCPFailure && session.costCapRefusal !== costCapRefusalBeforeTurn;
	const terminalFailure =
		!strictMCPFailure &&
		!costCapped &&
		assistantMsg !== undefined &&
		(assistantMsg.stopReason === "error" || (assistantMsg.stopReason === "aborted" && !signalShutdown)) &&
		!isSilentAbort(assistantMsg);

	// In text mode, output the final response. A terminal failure prints only
	// the error line below; JSON mode already emitted the assistant message and
	// stop reason through the event subscription.
	if (mode === "text" && !terminalFailure && !strictMCPFailure && !asyncWaitExpired && !costCapped) {
		if (assistantMsg) {
			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content; narration the provider returned as thinking is part of the reply.
			for (const content of presentNarrationAsAnswer(assistantMsg).content) {
				if (content.type === "text") {
					writeStdoutLine(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					writeStdoutLine(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
		session.setTextOutputCommitted(true);
	}

	// Fatal exits and expired background waits skip the normal advisor drain.
	if (!strictMCPFailure && !signalShutdown && !asyncWaitExpired) {
		// Print mode's drain budget covers a fallback-chain switch; the reviewer's
		// verdict is the point of a headless advisor run, so wait through recovery,
		// and wait on `strict` reviewers past the budget like every primary boundary.
		await session.waitForAdvisorCatchup(
			terminalFailure || costCapped
				? PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS
				: PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS,
			{ waitThroughRecovery: true, strictWithoutDeadline: true },
		);
	}
	// Error spans must reach the exporter; the postmortem `exit` handler can't await.
	if (terminalFailure) await flushTelemetryExport();
	await stdoutTail;
	try {
		await disposeSession();
	} catch (error) {
		if (!persistenceError || error !== persistenceError) throw error;
	} finally {
		unsubscribePersistenceError?.();
		unsubscribePersistenceNotice?.();
		unregisterSignalTeardown();
	}
	if (persistenceError) {
		const currentFailure = session.sessionManager.getPersistenceError?.();
		if (currentFailure) {
			writeStderrLine(formatPersistenceDurabilityFailure(currentFailure.message));
			durabilityFailure = true;
		} else if (preexistingPersistenceError) {
			writeStderrLine("Session persistence recovered.");
		}
	}

	if (mode === "text" && terminalFailure && assistantMsg) {
		const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
		if (!process.stderr.write(`${errorLine}\n`)) {
			const { promise, resolve } = Promise.withResolvers<void>();
			process.stderr.once("drain", resolve);
			await promise;
		}
	}

	await stderrTail;
	if (terminalFailure || durabilityFailure || strictMCPFailure || builtinFailed || asyncWaitExpired) return 1;
	return costCapped ? PRINT_MODE_COST_CAP_EXIT_CODE : 0;
}
