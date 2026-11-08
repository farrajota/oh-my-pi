import { StatusLineComponent } from "../../src/status-line/component";
import type { CompactionBoundaries } from "../../src/status-line/context-usage";
import type { StatusLineHost, StatusLineSession } from "../../src/status-line/host";
import type { StatusLineSettings } from "../../src/status-line/types";

/** Inputs a status-line test controls; everything else is an idle, unnamed session. */
export interface StatusLineFixtureOptions {
	settings: StatusLineSettings;
	sessionName?: string;
	/** Context usage reported by the session; omitted means no model and no window. */
	context?: { tokens: number; contextWindow: number };
	/** Auto-compaction boundaries the host reports for the window. */
	compactionBoundaries?: CompactionBoundaries | null;
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	orchestrationInput: 0,
	orchestrationOutput: 0,
	orchestrationCacheRead: 0,
	premiumRequests: 0,
	cost: 0,
};

/**
 * A real {@link StatusLineComponent} over a stub session and host, with git off so
 * renders never touch the repository. Callers dispose it.
 */
export function createStatusLineFixture(options: StatusLineFixtureOptions): StatusLineComponent {
	const context = options.context;
	const model = context ? { id: "test-model", name: "Test Model", contextWindow: context.contextWindow } : undefined;
	const session = {
		state: { messages: [], model },
		model,
		messages: [],
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => options.sessionName,
			getSessionId: () => "fixture-session",
			getUsageStatistics: () => EMPTY_USAGE,
		},
		modelRegistry: { isUsingSubscription: () => false },
		getContextUsage: () =>
			context
				? {
						tokens: context.tokens,
						contextWindow: context.contextWindow,
						percent: (context.tokens / context.contextWindow) * 100,
					}
				: undefined,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getGoalModeState: () => undefined,
	} as unknown as StatusLineSession;
	const host = {
		getSettings: () => options.settings,
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => null,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: () => Promise.resolve(null),
		resolveActiveRepo: () => null,
		lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => options.compactionBoundaries ?? null,
	} as unknown as StatusLineHost<StatusLineSession>;
	const component = new StatusLineComponent(session, host);
	component.updateSettings(options.settings);
	return component;
}
