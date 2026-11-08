/**
 * Settings of the subagent permission profiles. `config/all-settings.ts` registers this domain.
 */
import { register } from "../../config/registry";

export const cfgTaskPermissionsMode = register({
	id: "task.permissions.mode",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "suggest", "enforce"] as const,
	default: "off",
	ui: {
		tab: "tasks",
		group: "Subagent Permissions",
		label: "Subagent Permission Mode",
		description:
			"Whether the task tool offers permission profiles and inline permission clauses, and whether they restrict the subagents that use them",
		options: [
			{
				value: "off",
				label: "Off",
				description: "The task tool offers no permission profiles; subagents are not restricted",
			},
			{
				value: "suggest",
				label: "Suggest",
				description:
					"Advisory only: profiles are offered to the model and recorded on the spawn; nothing is restricted (no startup narrowing, no per-call checks)",
			},
			{
				value: "enforce",
				label: "Enforce",
				description:
					"Restrict only subagents spawned with `permissions` or `toolProfile`: their tools are cut to the scope at startup and every call is checked",
			},
		],
	},
});

export const cfgTaskPermissionsToolsEnabled = register({
	id: "task.permissions.tools.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagent Permissions",
		label: "Subagent Tool Permissions",
		description: "Allow permission profiles, inline clauses and `toolProfile` to constrain subagent tools",
	},
});

export const cfgTaskPermissionsPathsEnabled = register({
	id: "task.permissions.paths.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagent Permissions",
		label: "Subagent Path Permissions",
		description: "Allow permission profiles and inline clauses to constrain subagent file paths",
	},
});

/**
 * The compiled scope the session runs under, as `encodePermissionScope` text. Only a runtime override
 * counts (the subagent spawn writes one into the child's settings overlay); a value in a config file
 * is ignored. It is stored as one string, so an overlay can only replace an inherited scope, never
 * merge its fields with the child's.
 */
export const cfgTaskPermissionsActiveScope = register({
	id: "task.permissions.activeScope",
	type: "string",
	default: undefined,
	runtimeOnly: true,
});
