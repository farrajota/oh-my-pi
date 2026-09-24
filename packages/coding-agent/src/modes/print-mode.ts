import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { $flag, logger, postmortem, sanitizeText } from "@oh-my-pi/pi-utils";
import type { MCPManager } from "../mcp/manager";
import { resolveMCPTimeoutMs } from "../mcp/timeout";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";
import { formatPersistenceFailure } from "./persistence-failure";

export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
	printThoughts?: boolean;
	planYolo?: boolean;
	/** Manager returned by session creation; only print mode waits for its servers. */
	mcpManager?: MCPManager;
}

export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;

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
		if (!preexistingPersistenceError)
			writeStderrLine(`${formatPersistenceFailure(error.message)} Writes are retried.`);
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
		session.settings.get("plan.defaultOnStartup") &&
		session.settings.get("plan.enabled") &&
		session.sessionManager.buildSessionContext().messages.length === 0 &&
		!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		!planYolo;
	if (planStartupIgnored) {
		process.stderr.write(
			"Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.\n",
		);
	}

	session.subscribe(event => {
		if (mode === "json") writeStdoutLine(`${JSON.stringify(printableEvent(event))}\n`);
	});

	const timeoutMs = resolveMCPTimeoutMs();
	let strictMCPFailure = false;
	if (options.mcpManager) {
		const readiness = await options.mcpManager.waitForStartup(timeoutMs);
		// The manager's initial callback may have fired before SDK wiring, or a
		// reconnect may have fired it without awaiting the session mutation.
		// Refresh is serialized by AgentSession, so turn one sees the final snapshot.
		await session.refreshMCPTools(options.mcpManager.getTools());
		const unavailable: string[] = [];
		for (const name of readiness.pending) {
			const server = singleLine(name);
			unavailable.push(server);
			const after = timeoutMs > 0 ? ` after ${timeoutMs}ms` : "";
			writeStderrLine(`Warning: MCP server "${server}" not ready${after}; its tools are unavailable for this run.`);
		}
		for (const { name, error } of readiness.failed) {
			const server = singleLine(name);
			unavailable.push(server);
			writeStderrLine(
				`Warning: MCP server "${server}" failed to connect: ${singleLine(error)}; its tools are unavailable for this run.`,
			);
		}
		if ($flag("OMP_MCP_REQUIRE_READY") && unavailable.length > 0) {
			writeStderrLine(`Error: MCP servers not ready: ${unavailable.join(", ")}`);
			strictMCPFailure = true;
		}
	}

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	// Send initial message with attachments
	if (!strictMCPFailure && !signalShutdown && initialMessage !== undefined) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
	}

	// Send remaining messages
	if (!strictMCPFailure) {
		for (const message of messages) {
			if (signalShutdown) break;
			writeTextWorkingIndicator();
			if (mode === "text") session.setTextOutputCommitted(false);
			await logger.time("print:prompt:next", () => session.prompt(message));
		}
	}

	session.prepareForHeadlessAdvisorDrain();
	const assistantMsg = session.getLastAssistantMessage();
	const terminalFailure =
		!strictMCPFailure &&
		assistantMsg !== undefined &&
		(assistantMsg.stopReason === "error" || (assistantMsg.stopReason === "aborted" && !signalShutdown)) &&
		!isSilentAbort(assistantMsg);

	// In text mode, output the final response. A terminal failure prints only
	// the error line below; JSON mode already emitted the assistant message and
	// stop reason through the event subscription.
	if (mode === "text" && !terminalFailure && !strictMCPFailure) {
		if (assistantMsg) {
			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}
			for (const content of assistantMsg.content) {
				if (content.type === "text") writeStdoutLine(`${sanitizeText(content.text)}\n`);
				else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0)
					writeStdoutLine(`${sanitizeText(content.thinking)}\n`);
			}
		}
		session.setTextOutputCommitted(true);
	}

	// A turn-fatal exit cannot hold automation for the full normal drain budget.
	if (!strictMCPFailure && !signalShutdown) {
		await session.waitForAdvisorCatchup(
			terminalFailure ? PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS : PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS,
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
		unregisterSignalTeardown();
	}
	if (persistenceError) {
		const currentFailure = session.sessionManager.getPersistenceError?.();
		if (currentFailure) {
			if (preexistingPersistenceError) writeStderrLine(formatPersistenceFailure(persistenceError.message));
			else writeStderrLine("Session persistence failed: Session transcript is not durable.");
			durabilityFailure = true;
		} else if (preexistingPersistenceError) {
			writeStderrLine(
				`${formatPersistenceFailure(persistenceError.message)} Writes are retried; transcript recovered.`,
			);
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
	return terminalFailure || durabilityFailure || strictMCPFailure ? 1 : 0;
}
