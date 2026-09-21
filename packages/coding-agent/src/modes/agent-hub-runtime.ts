import * as fs from "node:fs";
import type { AgentHubDeps, AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
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
	"registry" | "lifecycle" | "irc" | "activity" | "manageActivityLive" | "transcript" | "loadPersisted" | "getRoleInfo"
> {
	const sourceRegistry = options.registry ?? AgentRegistry.global();
	const registry = toAgentHubRegistry(sourceRegistry);
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
		loadPersisted: shouldContinue => registerPersistedSubagents(sourceRegistry, options.sessionFile, { shouldContinue }),
		getRoleInfo: options.settings ? role => getRoleInfo(role, options.settings!) : undefined,
	};
}
