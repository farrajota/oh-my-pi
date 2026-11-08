import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getAgentDir, isEnoent, isRecord, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { canonicalPermissionValue, sha256Hex } from "./snapshot";
import { isUnprovableEffectTool, uniquePermissionTools } from "./tool-names";
import type {
	PermissionProfile,
	PermissionProfileIdentity,
	PermissionProfileSource,
	PermissionProfileSummary,
	SubagentPermissionMode,
} from "./types";

/**
 * Built-in profiles. Their text is part of each profile's content hash, which persisted subagents
 * are revived against, so an edit here makes every subagent spawned with the old text unrevivable.
 * `hub` in a `tools` list is the messaging grant.
 */
export const BUILTIN_PERMISSION_PROFILES: Readonly<Record<string, PermissionProfile>> = {
	"read-only": {
		description: "Read/search/code-intelligence only. No edits, shell, browser, web search, or child delegation.",
		useWhen: "Investigation, review, planning, and file discovery.",
		tools: ["read", "search", "find", "lsp", "hub"],
	},
	"focused-edit": {
		description:
			"Read/search/edit/write within the selected path scope. No shell, browser, web search, or child delegation.",
		useWhen: "Bounded source/test edits where the parent will run verification.",
		tools: ["read", "search", "find", "lsp", "edit", "write", "ast_grep", "ast_edit", "hub"],
	},
	"test-runner": {
		description: "Read/search plus shell execution for targeted verification. No edits or child delegation.",
		useWhen: "Running a specific test/check command after implementation.",
		tools: ["read", "search", "find", "bash", "hub"],
	},
	"no-network": {
		description:
			"Modifier-only profile that denies browser and web-search tools; pair with a role profile or inline permissions.tools when tool enforcement is in enforce mode.",
		useWhen:
			"Local-repository work that should not fetch external context; use alongside a role profile or inline permissions.tools in enforce mode.",
		denyTools: ["browser", "web_search"],
	},
	"no-delegation": {
		description:
			"Modifier-only profile that denies spawning child subagents; pair with a role profile or inline permissions.tools when tool enforcement is in enforce mode.",
		useWhen:
			"Small scoped tasks that should not fan out further; use alongside a role profile or inline permissions.tools in enforce mode.",
		denyTools: ["task"],
	},
	"secrets-blind": {
		description:
			"Modifier-only profile that prevents access to local secrets, credentials, and private key material without granting tools.",
		useWhen:
			"Pair with a role profile or inline permissions.tools when tool enforcement is in enforce mode and the task should avoid environment files, credentials, SSH material, or Kubernetes config.",
		denyPaths: ["**/.env", "**/.env.*", "**/*secret*", "**/*credential*", "**/*private*key*", ".ssh/**", ".kube/**"],
	},
};

/** Names that always resolve to the built-in; a file may repeat the exact definition but not change it. */
const RESERVED_PERMISSION_PROFILE_NAMES: ReadonlySet<string> = new Set(["secrets-blind", "no-network"]);

/** Project files, resolved against the session cwd, in ascending precedence. */
const PROJECT_PROFILE_FILES: ReadonlyArray<{ relativePath: string; source: PermissionProfileSource }> = [
	{ relativePath: ".omp/permissions.json", source: "project" },
	{ relativePath: ".omp/permissions.local.json", source: "local" },
];

/** User-level file name inside the agent dir, next to config.yml. */
const USER_PROFILE_FILE_NAME = "permissions.json";

export interface LoadPermissionProfilesOptions {
	/** Agent dir holding the user-level permissions.json; defaults to {@link getAgentDir}. */
	agentDir?: string;
	/** Read `<agentDir>/permissions.json`. Defaults to true; mode `off` passes false. */
	includeUserProfiles?: boolean;
}

export interface LoadedPermissionProfiles {
	/** Profiles by canonical (trimmed, lower-cased) name. */
	profiles: Record<string, PermissionProfile>;
	profileIdentities: Record<string, PermissionProfileIdentity>;
	summaries: PermissionProfileSummary[];
	/** Problems that dropped a file or an entry, in file order. */
	errors: string[];
	/** Profiles that load but will not get every tool they list. */
	warnings: string[];
	/**
	 * A profile file existed but could not be read or parsed, or had a non-object root or `profiles`
	 * value. It may have defined any name, so no loaded definition can be trusted for revival.
	 */
	unreadableFile: boolean;
}

interface ProfileFile {
	readonly filePath: string;
	/** Error label: cwd-relative for project files, home-relative for the user file. */
	readonly label: string;
	readonly source: PermissionProfileSource;
}

/** Profile files in ascending precedence: user, project, local. */
function profileFiles(cwd: string, options: LoadPermissionProfilesOptions): ProfileFile[] {
	const files: ProfileFile[] = [];
	let userFileIdentity: string | undefined;
	if (options.includeUserProfiles !== false) {
		const filePath = path.resolve(options.agentDir ?? getAgentDir(), USER_PROFILE_FILE_NAME);
		files.push({ filePath, label: shortenPath(filePath), source: "user" });
		userFileIdentity = normalizePathForComparison(filePath);
	}
	for (const file of PROJECT_PROFILE_FILES) {
		const filePath = path.resolve(cwd, file.relativePath);
		// A project file that is the user file (agent dir at <cwd>/.omp, or a symlink) loads once, as user.
		if (userFileIdentity !== undefined && normalizePathForComparison(filePath) === userFileIdentity) continue;
		files.push({ filePath, label: file.relativePath, source: file.source });
	}
	return files;
}

export function canonicalProfileName(name: string): string {
	return name.trim().toLowerCase();
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/** A fresh copy with duplicate list entries removed; the loader and composition own their values. */
export function canonicalProfile(profile: PermissionProfile): PermissionProfile {
	return {
		...(profile.description === undefined ? {} : { description: profile.description }),
		...(profile.useWhen === undefined ? {} : { useWhen: profile.useWhen }),
		...(profile.tools === undefined ? {} : { tools: uniqueStrings(profile.tools) }),
		...(profile.denyTools === undefined ? {} : { denyTools: uniqueStrings(profile.denyTools) }),
		...(profile.allowPaths === undefined ? {} : { allowPaths: uniqueStrings(profile.allowPaths) }),
		...(profile.denyPaths === undefined ? {} : { denyPaths: uniqueStrings(profile.denyPaths) }),
	};
}

function normalizedProfileForComparison(profile: PermissionProfile): PermissionProfile {
	const canonical = canonicalProfile(profile);
	return {
		...canonical,
		...(canonical.tools === undefined ? {} : { tools: uniquePermissionTools(canonical.tools) }),
		...(canonical.denyTools === undefined ? {} : { denyTools: uniquePermissionTools(canonical.denyTools) }),
	};
}

/** Content hash of a profile after tool-name normalization; recorded in scope provenance. */
export function profileContentHash(profile: PermissionProfile): string {
	return sha256Hex(canonicalPermissionValue(normalizedProfileForComparison(profile)));
}

function profilesEqual(left: PermissionProfile, right: PermissionProfile): boolean {
	return (
		canonicalPermissionValue(normalizedProfileForComparison(left)) ===
		canonicalPermissionValue(normalizedProfileForComparison(right))
	);
}

const PROFILE_STRING_FIELDS: ReadonlySet<string> = new Set(["description", "useWhen"]);
const PROFILE_LIST_FIELDS: ReadonlySet<string> = new Set(["tools", "denyTools", "allowPaths", "denyPaths"]);

/** One `profiles` entry in file order: a usable profile (undefined when empty) or why it was rejected. */
type ProfileFileEntry =
	| { readonly name: string; readonly profile: PermissionProfile | undefined; readonly problem?: undefined }
	| { readonly name: string; readonly problem: string };

interface ProfileFileContent {
	readonly entries: readonly ProfileFileEntry[];
	/** The root or `profiles` value has the wrong shape, so no entry in the file was read. */
	readonly fileProblem?: string;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

/** Read only the top-level `profiles` object; other top-level keys are deliberately ignored. */
function readProfileMap(value: unknown): ProfileFileContent {
	if (!isRecord(value)) return { entries: [], fileProblem: "must contain a JSON object" };
	if (value.profiles === undefined) return { entries: [] };
	if (!isRecord(value.profiles)) return { entries: [], fileProblem: '"profiles" must be an object' };
	const entries: ProfileFileEntry[] = [];
	for (const [name, rawProfile] of Object.entries(value.profiles)) {
		if (!isRecord(rawProfile)) {
			entries.push({ name, problem: "must be an object" });
			continue;
		}
		// An entry with a misspelled or mistyped field is rejected whole: dropping only that field
		// could load a silently broader profile (for example a lost denyPaths).
		const problem = profileFieldProblem(rawProfile);
		entries.push(problem === undefined ? { name, profile: readProfile(rawProfile) } : { name, problem });
	}
	return { entries };
}

function profileFieldProblem(value: Record<string, unknown>): string | undefined {
	for (const [field, fieldValue] of Object.entries(value)) {
		if (PROFILE_STRING_FIELDS.has(field)) {
			if (typeof fieldValue !== "string") return `field "${field}" must be a string`;
		} else if (PROFILE_LIST_FIELDS.has(field)) {
			if (stringArray(fieldValue) === undefined) return `field "${field}" must be an array of strings`;
		} else {
			return `has unknown field "${field}"`;
		}
	}
	return undefined;
}

function readProfile(value: Record<string, unknown>): PermissionProfile | undefined {
	const profile: PermissionProfile = {};
	if (typeof value.description === "string") profile.description = value.description;
	if (typeof value.useWhen === "string") profile.useWhen = value.useWhen;
	const tools = stringArray(value.tools);
	if (tools) profile.tools = tools;
	const denyTools = stringArray(value.denyTools);
	if (denyTools) profile.denyTools = denyTools;
	const allowPaths = stringArray(value.allowPaths);
	if (allowPaths) profile.allowPaths = allowPaths;
	const denyPaths = stringArray(value.denyPaths);
	if (denyPaths) profile.denyPaths = denyPaths;
	return Object.keys(profile).length > 0 ? profile : undefined;
}

/**
 * Tools a profile lists that a scope with path rules never gets (see {@link isUnprovableEffectTool}).
 * Named in a load warning, because the evaluator drops them without telling the user.
 */
function unprovableToolsWithPathRules(profile: PermissionProfile): string[] {
	if ((profile.allowPaths?.length ?? 0) === 0 && (profile.denyPaths?.length ?? 0) === 0) return [];
	return (profile.tools ?? []).filter(isUnprovableEffectTool);
}

function summarizeProfile(
	name: string,
	profile: PermissionProfile,
	source: PermissionProfileSource,
): PermissionProfileSummary {
	const allowedTools =
		profile.tools === undefined
			? "no tool allowlist (modifier-only)"
			: profile.tools.length > 0
				? `allow ${profile.tools.join(", ")}`
				: "allow none";
	const deniedTools = profile.denyTools?.length ? `deny ${profile.denyTools.join(", ")}` : "deny none";
	const allowedPaths = profile.allowPaths?.length ? `allow ${profile.allowPaths.join(", ")}` : "allow unrestricted";
	const deniedPaths = profile.denyPaths?.length ? `deny ${profile.denyPaths.join(", ")}` : "deny none";
	return {
		name,
		description: profile.description ?? "",
		useWhen: profile.useWhen ?? "",
		toolsSummary: `${allowedTools}; ${deniedTools}`,
		pathsSummary: `${allowedPaths}; ${deniedPaths}`,
		source,
	};
}

async function readProfileFile(
	file: ProfileFile,
): Promise<{ parsed: unknown } | { missing: true } | { error: string }> {
	let text: string;
	try {
		text = await Bun.file(file.filePath).text();
	} catch (error) {
		if (isEnoent(error)) return { missing: true };
		return { error: error instanceof Error ? error.message : String(error) };
	}
	try {
		return { parsed: JSON.parse(text) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Load built-in, user (`<agentDir>/permissions.json`), project (`.omp/permissions.json`) and local
 * (`.omp/permissions.local.json`) profiles. A later source replaces an earlier one by name, except
 * that project and local files may not redefine a name the user file defines, and reserved names
 * always keep the built-in.
 */
export async function loadPermissionProfiles(
	cwd: string,
	options: LoadPermissionProfilesOptions = {},
): Promise<LoadedPermissionProfiles> {
	const profiles: Record<string, PermissionProfile> = {};
	const sources = new Map<string, PermissionProfileSource>();
	for (const [name, profile] of Object.entries(BUILTIN_PERMISSION_PROFILES)) {
		profiles[name] = canonicalProfile(profile);
		sources.set(name, "built-in");
	}
	const errors: string[] = [];
	const warnings: string[] = [];
	let unreadableFile = false;
	// Every name the user file mentions, valid or not: a project file must not take any of them over.
	const userNames = new Set<string>();
	let userLabel = "";

	for (const file of profileFiles(cwd, options)) {
		if (file.source === "user") userLabel = file.label;
		const read = await readProfileFile(file);
		if ("missing" in read) continue;
		if ("error" in read) {
			errors.push(`${file.label}: ${read.error}`);
			unreadableFile = true;
			continue;
		}
		const content = readProfileMap(read.parsed);
		if (content.fileProblem !== undefined) {
			errors.push(`${file.label}: ${content.fileProblem}`);
			unreadableFile = true;
			continue;
		}
		for (const entry of content.entries) {
			const name = canonicalProfileName(entry.name);
			const reserved = RESERVED_PERMISSION_PROFILE_NAMES.has(name);
			if (file.source === "user") {
				userNames.add(name);
			} else if (!reserved && userNames.has(name)) {
				errors.push(
					`${file.label}: permission profile "${name}" is defined in ${userLabel} and cannot be redefined`,
				);
				continue;
			}
			if (entry.problem !== undefined) {
				errors.push(`${file.label}: permission profile "${name}" ${entry.problem}`);
				// Reserved profiles keep the built-in. Any other name stops resolving, so neither a spawn nor
				// a revival falls back to a broader lower-precedence definition.
				if (!reserved) {
					delete profiles[name];
					sources.delete(name);
				}
				continue;
			}
			if (entry.profile === undefined) continue;
			const profile = canonicalProfile(entry.profile);
			if (reserved) {
				if (!profilesEqual(profiles[name] ?? {}, profile)) {
					errors.push(`${file.label}: permission profile "${name}" is reserved and cannot be overridden`);
				}
				continue;
			}
			profiles[name] = profile;
			sources.set(name, file.source);
			const unprovable = unprovableToolsWithPathRules(profile);
			if (unprovable.length > 0) {
				warnings.push(
					`${file.label}: permission profile "${name}" lists ${unprovable.join(", ")} together with path rules; a subagent whose scope has path rules does not get tools whose effects reach beyond their path arguments (bash, eval, LSP, MCP, extension and custom tools, github, debug, ida, manage_skill)`,
				);
			}
		}
	}

	const profileIdentities: Record<string, PermissionProfileIdentity> = {};
	const summaries: PermissionProfileSummary[] = [];
	for (const [name, profile] of Object.entries(profiles)) {
		const source = sources.get(name) ?? "project";
		profileIdentities[name] = Object.freeze({ name, source, canonicalSha256: profileContentHash(profile) });
		summaries.push(summarizeProfile(name, profile, source));
	}
	return { profiles, profileIdentities, summaries, errors, warnings, unreadableFile };
}

/**
 * Why persisted profile identities no longer match the current profile files, or undefined when
 * every one still resolves to the same source and content.
 */
export function permissionProfileDrift(
	persisted: readonly PermissionProfileIdentity[],
	current: Pick<LoadedPermissionProfiles, "profileIdentities" | "unreadableFile">,
): string | undefined {
	if (persisted.length > 0 && current.unreadableFile)
		return "a permission profile file could not be read, so no profile can be verified";
	for (const identity of persisted) {
		const now = current.profileIdentities[identity.name];
		if (!now) return `permission profile "${identity.name}" no longer exists`;
		if (now.source !== identity.source)
			return `permission profile "${identity.name}" moved from ${identity.source} to ${now.source}`;
		if (now.canonicalSha256 !== identity.canonicalSha256)
			return `permission profile "${identity.name}" changed since the subagent was spawned`;
	}
	return undefined;
}

/** Permission profile file errors to show the user; empty in mode off, which reads no file. */
export async function permissionProfileConfigErrors(
	cwd: string,
	options: { mode: SubagentPermissionMode; agentDir?: string },
): Promise<string[]> {
	if (options.mode === "off") return [];
	return (await loadPermissionProfiles(cwd, { agentDir: options.agentDir })).errors;
}
