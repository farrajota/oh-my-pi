import {
	AgentTranscriptViewer,
	type AgentTranscriptViewerDeps,
} from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { agentTranscriptSource } from "../agent-hub-runtime";

export type ReadOnlyAgentTranscriptViewerDeps = Omit<
	AgentTranscriptViewerDeps,
	"remote" | "lifecycle" | "transcript"
>;

export function createReadOnlyAgentTranscriptViewer(
	deps: ReadOnlyAgentTranscriptViewerDeps,
): AgentTranscriptViewer {
	const expectedRef = deps.registry.get(deps.agentId);
	const pinnedRegistry: AgentTranscriptViewerDeps["registry"] = {
		get: id => {
			if (id !== deps.agentId || !expectedRef) return undefined;
			const current = deps.registry.get(id);
			if (!current || !current.lineage || !expectedRef.lineage) return undefined;
			return current.id === expectedRef.id &&
				current.lineage.rootId === expectedRef.lineage.rootId &&
				current.lineage.parentId === expectedRef.lineage.parentId &&
				current.lineage.generation === expectedRef.lineage.generation
				? current
				: undefined;
		},
		list: () => {
			const current = deps.registry.get(deps.agentId);
			return current && current.id === deps.agentId ? [current] : [];
		},
		onChange: () => () => {},
	};
	return new AgentTranscriptViewer({
		...deps,
		registry: pinnedRegistry,
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
export * from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
export * from "@oh-my-pi/pi-tui/overlays/agent-hub";
export * from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
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
export {
    BROWSER_FRAME_ROWS,
    ModelPickerComponent,
    type ModelPickerCallbacks,
    type ModelPickerOptions,
    type ModelPickerRegistry,
} from "@oh-my-pi/pi-tui/overlays/model-picker";
export * from "@oh-my-pi/pi-tui/overlays/oauth-selector";
export * from "@oh-my-pi/pi-tui/overlays/queue-mode-selector";
export * from "@oh-my-pi/pi-tui/chat/read-tool-group";
export * from "@oh-my-pi/pi-tui/overlays/rewind-selector";
export * from "@oh-my-pi/pi-tui/chrome/segment-track";
export * from "@oh-my-pi/pi-tui/overlays/session-selector";
export * from "@oh-my-pi/pi-tui/overlays/settings-selector";
export * from "@oh-my-pi/pi-tui/overlays/usage-row";
export * from "@oh-my-pi/pi-tui/overlays/show-images-selector";
export * from "@oh-my-pi/pi-tui/status-line";
export * from "@oh-my-pi/pi-tui/overlays/theme-selector";
export * from "@oh-my-pi/pi-tui/overlays/thinking-selector";
export * from "@oh-my-pi/pi-tui/overlays/tiny-title-download-progress";
export * from "@oh-my-pi/pi-tui/chat/todo-reminder";
export * from "@oh-my-pi/pi-tui/chat/tool-execution";
export * from "@oh-my-pi/pi-tui/overlays/tree-selector";
export * from "@oh-my-pi/pi-tui/chat/ttsr-notification";
export * from "@oh-my-pi/pi-tui/chat/user-message";
export * from "@oh-my-pi/pi-tui/chrome/visual-truncate";
export * from "@oh-my-pi/pi-tui/prompt/welcome";
