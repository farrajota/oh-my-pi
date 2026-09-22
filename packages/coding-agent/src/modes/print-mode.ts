import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";

export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
	printThoughts?: boolean;
	planYolo?: boolean;
}

export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;

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
	const writeStdoutLine = (text: string): void => {
		stdoutTail = stdoutTail.then(() => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			process.stdout.write(text, err => {
				if (err) reject(err);
				else resolve();
			});
			return promise;
		});
	};

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

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	if (initialMessage !== undefined) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
	}
	for (const message of messages) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:next", () => session.prompt(message));
	}

	session.prepareForHeadlessAdvisorDrain();
	const assistantMsg = session.getLastAssistantMessage();
	const terminalFailure =
		assistantMsg !== undefined &&
		(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
		!isSilentAbort(assistantMsg);

	if (mode === "text" && !terminalFailure) {
		if (assistantMsg) {
			if (assistantMsg.errorMessage && assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
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

	await session.waitForAdvisorCatchup(
		terminalFailure ? PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS : PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS,
	);
	if (terminalFailure) await flushTelemetryExport();
	await stdoutTail;
	await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });

	if (mode === "text" && terminalFailure && assistantMsg) {
		const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
		if (!process.stderr.write(`${errorLine}\n`)) {
			const { promise, resolve } = Promise.withResolvers<void>();
			process.stderr.once("drain", resolve);
			await promise;
		}
	}
	return terminalFailure ? 1 : 0;
}
