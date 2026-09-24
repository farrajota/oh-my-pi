import * as fs from "node:fs";
import type { AgentHubDeps, AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type {
	AgentHubLiveMetrics,
	AgentHubSessionFacts,
	AgentRecordLike,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import { lookupAgentRef } from "../internal/agent-registry-bridge";
import { toAgentHubRegistry } from "../registry/agent-hub-registry-adapter";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import { parseSessionEntries } from "../session/session-loader";

/** Filesystem and parser used by local and host-backed transcript viewers. */
export const agentTranscriptSource: AgentTranscriptSource = {
	fs,
	parseEntries: text =>
		parseSessionEntries(text).filter(entry => entry.type === "message" || entry.type === "model_change"),
};

/** Host services used by the roster, without exposing runtime implementation to tui. */
export function createAgentHubRuntime(
	options: {
		registry?: AgentRegistry;
		lifecycle?: AgentLifecycleManager;
		irc?: IrcBus;
		activity?: AgentActivityIndex;
		remote?: AgentHubRemote;
		settings?: Settings;
		sessionFile?: string | null;
	} = {},
): Pick<
	AgentHubDeps<AgentRecordLike>,
	| "registry"
	| "lifecycle"
	| "irc"
	| "activity"
	| "manageActivityLive"
	| "transcript"
	| "loadPersisted"
	| "getRoleInfo"
	| "getSessionFacts"
	| "getLiveMetrics"
> {
	const sourceRegistry = options.registry ?? AgentRegistry.global();
	const registry = toAgentHubRegistry(sourceRegistry);
	const samples = new WeakMap<object, AgentHubLiveMetrics>();
	let nextGeneration = 0;
	return {
		registry,
		lifecycle: () => {
			const lifecycle = options.lifecycle ?? AgentLifecycleManager.global();
			return {
				ensureLive: async id => {
					const session = await lifecycle.ensureLive(id);
					return { prompt: (text, promptOptions) => session.prompt(text, promptOptions) };
				},
				release: async (id, _expected, releaseOptions) => {
					const ref = sourceRegistry.get(id);
					return ref ? lifecycle.release(id, ref, releaseOptions) : false;
				},
			};
		},
		irc: options.irc ?? IrcBus.global(),
		activity: options.activity ?? new AgentActivityIndex({ remote: options.remote }),
		manageActivityLive: !options.activity,
		transcript: agentTranscriptSource,
		loadPersisted: shouldContinue =>
			registerPersistedSubagents(sourceRegistry, options.sessionFile, { shouldContinue }),
		getRoleInfo: options.settings ? role => getRoleInfo(role, options.settings!) : undefined,
		getLiveMetrics: (id, sample) => {
			const ref = lookupAgentRef(sourceRegistry, id);
			const session = ref?.session;
			if (!ref || !session || typeof session.getSessionStats !== "function") return undefined;
			const cached = samples.get(session);
			if (cached && !sample) return cached;
			let metrics: AgentHubLiveMetrics["metrics"];
			try {
				const stats = session.getSessionStats();
				metrics = {
					tokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
					requests: stats.assistantMessages,
					tools: stats.toolCalls,
					cost: stats.cost,
					durationMs: Math.max(0, Date.now() - ref.createdAt),
					durationKind: "span",
					contextTokens: stats.contextUsage?.tokens,
					contextWindow: stats.contextUsage?.contextWindow,
				};
			} catch {
				metrics = undefined;
			}
			const snapshot = { generation: cached?.generation ?? ++nextGeneration, metrics };
			samples.set(session, snapshot);
			return snapshot;
		},
		getSessionFacts: (id: string): AgentHubSessionFacts | undefined => {
			const session = lookupAgentRef(sourceRegistry, id)?.session;
			if (!session) return undefined;
			const servingModel = session.servingModel;
			return {
				modelId: session.model?.id,
				modelSupportsThinking: Boolean(session.model?.thinking),
				thinkingLevel: session.thinkingLevel,
				servingModel: servingModel
					? { selector: servingModel.selector, isFallback: servingModel.isFallback }
					: undefined,
			};
		},
	};
}
