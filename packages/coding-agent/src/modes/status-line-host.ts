import type { StatusLineHost, StatusLineSession } from "@oh-my-pi/pi-tui/status-line/host";
import { STATUS_LINE_SEGMENT_IDS, type StatusLineSegmentId } from "@oh-my-pi/pi-tui/status-line/schema";
import { settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { getSessionCompactionBoundaries } from "../session/context-usage-runtime";
import { limitMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";
import { resolveActiveRepoContextSync } from "../utils/active-repo-context";
import { GH_COMMAND_TIMEOUT_MS, github } from "../utils/github";
import { calculateTokensPerSecond } from "../utils/token-rate";

function normalizeStatusLineSegments(segments: readonly string[]): StatusLineSegmentId[] {
	return segments.filter((segment): segment is StatusLineSegmentId =>
		STATUS_LINE_SEGMENT_IDS.includes(segment as StatusLineSegmentId),
	);
}

/**
 * Session capabilities the host consults beyond the display subset. Every
 * field is optional so display-only sessions (collab guest replicas, test
 * fixtures) still render; a live `AgentSession` satisfies it structurally.
 */
export type StatusLineHostSession = StatusLineSession &
	Partial<Pick<AgentSession, "settings" | "modelRegistry" | "sessionId" | "fetchUsageReports">>;

/** Application policy and runtime services consumed by the portable status renderer. */
export const statusLineHost: StatusLineHost<StatusLineHostSession> = {
	getSettings: () => ({
		preset: settings.get("statusLine.preset"),
		leftSegments: normalizeStatusLineSegments(settings.get("statusLine.leftSegments")),
		rightSegments: normalizeStatusLineSegments(settings.get("statusLine.rightSegments")),
		separator: settings.get("statusLine.separator"),
		showHookStatus: settings.get("statusLine.showHookStatus"),
		segmentOptions: settings.getGroup("statusLine").segmentOptions,
		sessionAccent: settings.get("statusLine.sessionAccent"),
		transparent: settings.get("statusLine.transparent"),
		compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
		contextLine: settings.get("statusLine.contextLine"),
	}),
	gitEnabled: () => settings.get("git.enabled"),
	codexResetFireworksEnabled: () => settings.get("tui.codexResetFireworks"),
	getSettingsRevision: () => settings.revision,
	getSessionSettingsIdentity: session => session.settings,
	getSessionSettingsRevision: session => session.settings?.revision ?? 0,
	goalStatusInFooter: session => (session.settings ?? settings).get("goal.statusInFooter"),
	activeAccount: (session, provider) =>
		session.modelRegistry?.authStorage?.getOAuthAccountIdentity(provider, session.sessionId),
	canFetchUsageReports: session => typeof session.fetchUsageReports === "function",
	fetchUsageReports: (session, signal) => session.fetchUsageReports?.(signal) ?? Promise.resolve(null),
	resolveActiveRepo: resolveActiveRepoContextSync,
	lookupPullRequest: cwd =>
		github.run(cwd, ["pr", "view", "--json", "number,url"], AbortSignal.timeout(GH_COMMAND_TIMEOUT_MS)),
	calculateTokensPerSecond,
	limitMatchesActiveAccount,
	computeCompactionBoundaries: (session, contextWindow, model) => {
		const source = session.settings;
		return getSessionCompactionBoundaries(
			typeof source?.getGroup === "function" ? source : settings,
			contextWindow,
			model,
		);
	},
};
