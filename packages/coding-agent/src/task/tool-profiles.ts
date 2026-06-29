import { normalizeToolNames } from "../tools/builtin-names";

export const TASK_TOOL_PROFILE_NAMES = ["none", "inspect", "review", "edit", "plan", "web-research", "vision"] as const;
export type TaskToolProfileName = (typeof TASK_TOOL_PROFILE_NAMES)[number];

const TASK_TOOL_PROFILE_DEFINITIONS: Record<TaskToolProfileName, readonly string[]> = {
	none: [],
	inspect: ["read", "search", "find"],
	review: ["read", "search", "find", "ast_grep"],
	edit: ["read", "search", "find", "ast_grep", "edit", "write"],
	plan: ["read", "search", "find", "lsp", "web_search"],
	"web-research": ["web_search", "read"],
	vision: ["read", "inspect_image"],
} as const;

export function isTaskToolProfileName(value: string): value is TaskToolProfileName {
	return TASK_TOOL_PROFILE_NAMES.includes(value as TaskToolProfileName);
}

export function resolveTaskToolProfile(profile: TaskToolProfileName): string[] {
	if (!isTaskToolProfileName(profile)) {
		throw new Error(`Unknown task tool profile: ${profile}`);
	}
	return normalizeToolNames([...TASK_TOOL_PROFILE_DEFINITIONS[profile]]);
}

export function applyTaskToolProfile(
	agentTools: readonly string[] | undefined,
	profile: TaskToolProfileName | undefined,
): string[] | undefined {
	const normalizedAgentTools = agentTools === undefined ? undefined : normalizeToolNames([...agentTools]);
	if (profile === undefined) {
		return normalizedAgentTools;
	}

	const profileTools = resolveTaskToolProfile(profile);
	if (normalizedAgentTools === undefined) {
		return profileTools;
	}

	return profileTools.filter(tool => normalizedAgentTools.includes(tool));
}
