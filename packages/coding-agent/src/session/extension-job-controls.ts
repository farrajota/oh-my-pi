import type { AsyncJobManagerApi } from "../async/job-manager";
import type { ExtensionAsyncJobControls } from "../extensibility/extensions/types";
import { terminateSubagent } from "../registry/agent-control";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { asyncJobHistorySnapshot, asyncJobOutput, cancelOwnedAsyncJobAndSettle } from "./async-job-views";

/** What the controls read from the session they serve. */
export interface ExtensionJobControlSession {
	readonly asyncJobManager: AsyncJobManagerApi | undefined;
	getAgentId(): string | undefined;
}

/**
 * Background-job controls for a session's extension contexts. `getSession` is read on every call,
 * so the controls can be bound before the session exists; until then they behave as with no session.
 */
export function createExtensionAsyncJobControls(
	getSession: () => ExtensionJobControlSession | undefined,
): ExtensionAsyncJobControls {
	return {
		getSnapshot: options => {
			const session = getSession();
			const manager = session?.asyncJobManager;
			return session && manager ? asyncJobHistorySnapshot(manager, session.getAgentId(), options) : null;
		},
		getOutput: jobId => {
			const session = getSession();
			const manager = session?.asyncJobManager;
			return session && manager ? asyncJobOutput(manager, session.getAgentId(), jobId) : null;
		},
		cancel: async jobId => {
			const session = getSession();
			const manager = session?.asyncJobManager;
			if (!session || !manager) {
				return { id: jobId, status: "not_found", message: "Background jobs are unavailable in this session." };
			}
			return cancelOwnedAsyncJobAndSettle(manager, session.getAgentId(), jobId);
		},
		terminateSubagent: async agentId => {
			const ownerId = getSession()?.getAgentId();
			if (!ownerId) {
				return { id: agentId, status: "not_found", message: "Subagent control is unavailable in this session." };
			}
			return terminateSubagent({
				registry: AgentRegistry.global(),
				lifecycle: AgentLifecycleManager.global(),
				ownerId,
				targetId: agentId,
			});
		},
	};
}
