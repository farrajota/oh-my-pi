const agentLifecycleCapability = Object.freeze({});

export function getAgentLifecycleCapability(): object {
	return agentLifecycleCapability;
}

export function assertAgentLifecycleCapability(value: unknown): void {
	if (value !== agentLifecycleCapability) throw new Error("Agent lifecycle authority is internal.");
}
