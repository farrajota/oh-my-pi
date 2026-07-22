/**
 * SessionFocusController - Weak retargeting primitive between the rendering/
 * input layer and the AgentSession it displays.
 *
 * Focusing re-points the transcript, streaming event subscription, status
 * line, and editor prompt/interrupt at a subagent's live AgentSession (from
 * AgentRegistry) without touching the main session underneath; unfocusing
 * re-attaches the main session and rebuilds the transcript from its
 * authoritative state.
 */

import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { InteractiveModeContext } from "../types";

export class SessionFocusController {
	#focusedAgentId: string | undefined;
	/** Session currently attached while focused; undefined when unfocused. */
	#attachedSession: AgentSession | undefined;
	#registryUnsubscribe: (() => void) | undefined;
	#focusGeneration = 0;

	constructor(
		private ctx: InteractiveModeContext,
		private registry: AgentRegistry = AgentRegistry.global(),
		private lifecycle: () => AgentLifecycleManager = () => AgentLifecycleManager.global(),
	) {}

	get focusedAgentId(): string | undefined {
		return this.#focusedAgentId;
	}

	/** Focused live session, undefined when unfocused. */
	get target(): AgentSession | undefined {
		return this.#attachedSession;
	}

	/** Focus the main view on an agent's live session. Throws an Error with a user-displayable message. */
	async focusAgent(id: string): Promise<void> {
		if (this.ctx.collabGuest) throw new Error("Viewing agents is unavailable in a collab session.");
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const generation = ++this.#focusGeneration;
		const session = await this.lifecycle().ensureLive(id);
		if (generation !== this.#focusGeneration) return;
		const ref = this.registry.get(id);
		if (!ref || ref.status === "parked" || ref.status === "aborted" || ref.session !== session) {
			await this.unfocus();
			return;
		}
		this.#focusedAgentId = id;
		this.#attachedSession = session;
		this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
		await this.#attach(session, generation);
		if (generation !== this.#focusGeneration) return;
		this.ctx.showStatus(`Viewing agent ${id} — Esc returns to main, ←← hops to parent`);
	}

	/** Focus the focused agent's parent agent, falling back to the main session. No-op when unfocused. */
	async focusParent(): Promise<void> {
		if (!this.#focusedAgentId) return;
		const parentId = this.registry.get(this.#focusedAgentId)?.parentId;
		if (parentId && parentId !== MAIN_AGENT_ID && this.registry.get(parentId)) {
			return this.focusAgent(parentId);
		}
		return this.unfocus();
	}

	/** Return to the main session. No-op when unfocused. */
	async unfocus(): Promise<void> {
		const generation = ++this.#focusGeneration;
		if (!this.#focusedAgentId) return;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		await this.#attach(this.ctx.session, generation);
		if (generation !== this.#focusGeneration) return;
		this.ctx.showStatus("Returned to main session");
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !dead) return;
		void this.unfocus().then(() => {
			if (!this.#focusedAgentId) {
				this.ctx.showStatus(
					`Agent ${event.ref.id} is ${gone ? "gone" : event.ref.status}; returned to main session`,
				);
			}
		});
	}

	/** Retarget core, both directions: swap subscription, transcript, and status line onto `target`. */
	async #attach(target: AgentSession, generation: number): Promise<void> {
		if (generation !== this.#focusGeneration) return;
		this.ctx.unsubscribe?.();
		this.ctx.clearTransientSessionUi();
		this.ctx.eventController.resetTranscriptAnchors();
		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async event => {
			if (generation !== this.#focusGeneration || target !== (this.#attachedSession ?? this.ctx.session)) return;
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				if (generation !== this.#focusGeneration || target !== (this.#attachedSession ?? this.ctx.session)) return;
				await this.ctx.eventController.handleEvent(target, { type: "message_start", message: event.message });
			}
			if (generation !== this.#focusGeneration || target !== (this.#attachedSession ?? this.ctx.session)) return;
			await this.ctx.eventController.handleEvent(target, event);
		});
		this.ctx.statusLine.setSession(target, this.#focusedAgentId);
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		if (target.isStreaming) {
			await this.ctx.eventController.rehydrateActiveRun(target);
			if (generation !== this.#focusGeneration) return;
		}
		if (generation !== this.#focusGeneration) return;
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}
}
