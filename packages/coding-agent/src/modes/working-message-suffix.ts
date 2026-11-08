import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WorkingMessageSuffixContext } from "../extensibility/extensions/types";

/** The parts of a viewed session a working-row suffix context is built from. */
export interface WorkingMessageSuffixSource {
	readonly runStartedAt: number | undefined;
	readonly state: { readonly messages: readonly AgentMessage[] };
}

/**
 * Tokens billed by assistant messages that started at or after `startedAt`, counted like the
 * turn usage line (`TurnUsageTally`): input, cache writes and orchestration input, plus output.
 * Messages are chronological, so the scan stops at the first one older than the run.
 */
export function runUsageTokens(messages: readonly AgentMessage[], startedAt: number | undefined): number {
	if (startedAt === undefined) return 0;
	let total = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.timestamp < startedAt) break;
		if (message.role !== "assistant") continue;
		const { usage } = message;
		total +=
			usage.input +
			usage.cacheWrite +
			usage.output +
			(usage.orchestration?.input ?? 0) +
			(usage.orchestration?.output ?? 0);
	}
	return total;
}

/**
 * Context for the working-row suffix renderers, read from the viewed session itself so a
 * focus switch or a recreated loader keeps the run's elapsed time and tokens.
 */
export function workingMessageSuffixContext(
	session: WorkingMessageSuffixSource,
	cwd: string,
	now: number,
): WorkingMessageSuffixContext {
	const startedAt = session.runStartedAt;
	return {
		now,
		startedAt,
		elapsedMs: startedAt === undefined ? undefined : Math.max(0, now - startedAt),
		runTokenDelta: runUsageTokens(session.state.messages, startedAt),
		cwd,
	};
}
