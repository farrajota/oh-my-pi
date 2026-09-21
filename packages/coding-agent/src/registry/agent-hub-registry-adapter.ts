import type { AgentHubRegistry } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { AgentRegistry } from "./agent-registry";

const adapters = new WeakMap<AgentRegistry, AgentHubRegistry>();

/**
 * Read-only `AgentRegistry` view for tui consumers (agent hub roster, running
 * subagents badge): refs come back with `session` detached so the overlay
 * cannot reach live runtime state.
 *
 * The adapter is cached per source registry because callers compare adapter
 * identity to decide whether they are already subscribed
 * ({@link import("../modes/interactive-mode").InteractiveMode.syncRunningSubagentBadge}).
 * Allocating a fresh adapter per call makes that check always miss, so the
 * badge listener unsubscribes and resubscribes from inside its own dispatch.
 */
export function toAgentHubRegistry(registry: AgentRegistry): AgentHubRegistry {
	const cached = adapters.get(registry);
	if (cached) return cached;
	const adapter: AgentHubRegistry = {
		list: () => registry.list().map(ref => ({ ...ref, session: null })),
		get: id => {
			const ref = registry.get(id);
			return ref ? { ...ref, session: null } : undefined;
		},
		onChange: listener => registry.onChange(() => listener()),
	};
	adapters.set(registry, adapter);
	return adapter;
}
