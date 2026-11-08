import { normalizeToolNames } from "../../tools/builtin-names";

/** Named tool sets a task item may pick with `toolProfile`; they narrow the agent's own tool list. */
export const TASK_TOOL_PROFILE_NAMES = ["none", "inspect", "review", "edit", "plan", "web-research", "vision"] as const;
export type TaskToolProfileName = (typeof TASK_TOOL_PROFILE_NAMES)[number];

const TASK_TOOL_PROFILE_DEFINITIONS: Record<TaskToolProfileName, readonly string[]> = {
	none: [],
	inspect: ["read", "search", "find"],
	review: ["read", "search", "find", "ast_grep"],
	edit: ["read", "search", "find", "ast_grep", "edit", "write"],
	plan: ["read", "search", "find", "ast_grep", "task", "todo"],
	"web-research": ["read", "search", "find", "web_search"],
	// `read` renders images itself; the separate image-inspection tool is gone.
	vision: ["read", "search", "find"],
};

export function isTaskToolProfileName(value: string): value is TaskToolProfileName {
	return (TASK_TOOL_PROFILE_NAMES as readonly string[]).includes(value);
}

export function resolveTaskToolProfile(profile: TaskToolProfileName): string[] {
	if (!isTaskToolProfileName(profile)) {
		throw new Error(`Unknown task tool profile: ${profile}`);
	}
	return normalizeToolNames(TASK_TOOL_PROFILE_DEFINITIONS[profile]);
}

/**
 * The agent's tools narrowed by `profile`: the profile's tools when the agent declares none,
 * otherwise their intersection. An empty result is an explicit "no tools".
 */
export function applyTaskToolProfile(
	agentTools: readonly string[] | undefined,
	profile: TaskToolProfileName | undefined,
): string[] | undefined {
	const normalizedAgentTools = agentTools === undefined ? undefined : normalizeToolNames(agentTools);
	if (profile === undefined) return normalizedAgentTools;
	const profileTools = resolveTaskToolProfile(profile);
	if (normalizedAgentTools === undefined) return profileTools;
	return profileTools.filter(tool => normalizedAgentTools.includes(tool));
}
