/**
 * Session-derived caller contexts for the internal URL router. Tools build
 * their {@link ResolveContext}/{@link WriteContext} here instead of assembling
 * per-tool literals, so every handler sees the same caller identity.
 */
import type { ToolSession } from "../tools";
import { getExperimentalContextSession } from "../tools/context-notes";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./local-protocol";
import type { ResolveContext, WriteContext } from "./types";

import { cfgCompactionExperimentalContextManagement } from "../session/context-settings";

/**
 * The session's `local://` mapping: its pinned {@link LocalProtocolOptions}
 * (subagents and multi-session hosts pin a parent/foreign root) or else its own
 * artifacts dir and session id, so `local://` never falls through to another
 * session's root.
 */
export function sessionLocalProtocolOptions(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? null,
		}
	);
}

/**
 * Router-facing `local://` mapping. Caller-owned options or artifacts wiring
 * take precedence. Only an unbound legacy ToolSession may inherit the process
 * mapping; callers with session identity but no mapping stay unresolved.
 */
export function contextLocalProtocolOptions(session: ToolSession): LocalProtocolOptions | undefined {
	if (session.localProtocolOptions || session.getArtifactsDir) return sessionLocalProtocolOptions(session);
	const sessionId = session.getSessionId?.();
	if (
		session.sessionManager ||
		session.agentRegistry ||
		session.getSessionFile() !== null ||
		(sessionId !== null && sessionId !== undefined)
	) {
		return undefined;
	}
	return LocalProtocolHandler.resolveOptions();
}

/** The single ResolveContext builder for a tool session; replaces per-tool literal assembly. */
export function sessionResolveContext(
	session: ToolSession,
	options: { signal?: AbortSignal; skipDirectoryListing?: boolean } = {},
): ResolveContext {
	return {
		cwd: session.cwd,
		settings: session.settings,
		signal: options.signal,
		sessionFile: session.getSessionFile() ?? undefined,
		experimentalContextManagement: cfgCompactionExperimentalContextManagement.get(session.settings) === true,
		getSessionBranch: () => getExperimentalContextSession(session).getBranch(),
		sessionId: session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? undefined,
		agentRegistry: session.agentRegistry,
		localProtocolOptions: contextLocalProtocolOptions(session),
		skills: session.skills,
		rules: session.activeRules,
		session,
		skipDirectoryListing: options.skipDirectoryListing,
	};
}

/** The single WriteContext builder for a tool session; replaces per-tool literal assembly. */
export function sessionWriteContext(
	session: ToolSession,
	options: { signal?: AbortSignal; toolCall?: WriteContext["toolCall"] } = {},
): WriteContext {
	return {
		cwd: session.cwd,
		signal: options.signal,
		localProtocolOptions: contextLocalProtocolOptions(session),
		session,
		toolCall: options.toolCall,
	};
}
