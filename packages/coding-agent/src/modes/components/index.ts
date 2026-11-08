import {
	AgentTranscriptViewer,
	type AgentTranscriptViewerDeps,
} from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import type { AgentRef } from "../../registry/agent-registry";
import { agentTranscriptSource } from "../agent-hub-runtime";

/** Inputs of {@link createReadOnlyAgentTranscriptViewer}: the viewer's deps minus everything that acts. */
export type ReadOnlyAgentTranscriptViewerDeps = Omit<
	AgentTranscriptViewerDeps,
	"registry" | "remote" | "lifecycle" | "transcript"
> & {
	registry: { get(id: string): AgentRef | undefined };
};

/**
 * A transcript viewer for one local agent that can only read: no messaging, revive or kill, and
 * no collab remote. It stays on the agent generation registered when it opens; a later agent
 * reusing the id is not shown.
 */
export function createReadOnlyAgentTranscriptViewer(deps: ReadOnlyAgentTranscriptViewerDeps): AgentTranscriptViewer {
	const opened = deps.registry.get(deps.agentId);
	const current = (): AgentRef | undefined => {
		const ref = deps.registry.get(deps.agentId);
		return ref && opened && ref.generation === opened.generation ? ref : undefined;
	};
	const pinned: AgentTranscriptViewerDeps["registry"] = {
		get: id => (id === deps.agentId ? current() : undefined),
		list: () => {
			const ref = current();
			return ref ? [ref] : [];
		},
		onChange: () => () => {},
	};
	return new AgentTranscriptViewer({
		...deps,
		registry: pinned,
		transcript: agentTranscriptSource,
		remote: undefined,
		lifecycle: undefined,
	});
}

// UI Components barrel export

export {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigCallbacks,
	type AdvisorConfigDeps,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";
export * from "@oh-my-pi/pi-tui/chat/assistant-message";
export * from "@oh-my-pi/pi-tui/chat/bash-execution";
export * from "@oh-my-pi/pi-tui/overlays/bordered-loader";
export * from "@oh-my-pi/pi-tui/chat/compaction-summary-message";
export * from "@oh-my-pi/pi-tui/chrome/countdown-timer";
export * from "@oh-my-pi/pi-tui/prompt/custom-editor";
export * from "@oh-my-pi/pi-tui/chat/custom-message";
export * from "@oh-my-pi/pi-tui/chrome/diff";
export * from "@oh-my-pi/pi-tui/chrome/dynamic-border";
export * from "@oh-my-pi/pi-tui/status-line/footer";
export * from "@oh-my-pi/pi-tui/overlays/hook-editor";
export * from "@oh-my-pi/pi-tui/overlays/hook-input";
export * from "@oh-my-pi/pi-tui/chat/hook-message";
export * from "@oh-my-pi/pi-tui/overlays/hook-selector";
export * from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
export * from "@oh-my-pi/pi-tui/overlays/login-dialog";
export * from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
export * from "@oh-my-pi/pi-tui/overlays/model-browser";
export * from "@oh-my-pi/pi-tui/overlays/model-hub";
export * from "@oh-my-pi/pi-tui/overlays/model-picker";
export * from "@oh-my-pi/pi-tui/overlays/oauth-selector";
export * from "@oh-my-pi/pi-tui/overlays/queue-mode-selector";
export * from "@oh-my-pi/pi-tui/chat/read-tool-group";
export * from "@oh-my-pi/pi-tui/overlays/rewind-selector";
export * from "@oh-my-pi/pi-tui/chrome/segment-track";
export * from "@oh-my-pi/pi-tui/overlays/session-selector";
export * from "@oh-my-pi/pi-tui/overlays/settings-selector";
export * from "@oh-my-pi/pi-tui/overlays/show-images-selector";
export * from "@oh-my-pi/pi-tui/status-line";
export * from "@oh-my-pi/pi-tui/overlays/theme-selector";
export * from "@oh-my-pi/pi-tui/overlays/thinking-selector";
export * from "@oh-my-pi/pi-tui/chat/todo-reminder";
export * from "@oh-my-pi/pi-tui/chat/tool-execution";
export * from "@oh-my-pi/pi-tui/overlays/tree-selector";
export * from "@oh-my-pi/pi-tui/chat/ttsr-notification";
export * from "@oh-my-pi/pi-tui/chat/user-message";
export * from "@oh-my-pi/pi-tui/chrome/visual-truncate";
export * from "@oh-my-pi/pi-tui/prompt/welcome";
