import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeToolNames } from "../tools/builtin-names";

export type SubagentPermissionMode = "off" | "suggest" | "enforce";

export interface PermissionProfile {
	description?: string;
	useWhen?: string;
	tools?: string[];
	denyTools?: string[];
	allowPaths?: string[];
	denyPaths?: string[];
}

export interface TaskPermissionRequest {
	profiles?: string[];
	tools?: string[];
	denyTools?: string[];
	allowPaths?: string[];
	denyPaths?: string[];
}

export interface PermissionProfileSummary {
	name: string;
	description: string;
	useWhen: string;
	toolsSummary: string;
	pathsSummary: string;
	source: "built-in" | "project" | "local";
}

export interface EffectiveSubagentPermissions {
	mode: SubagentPermissionMode;
	toolsEnabled: boolean;
	pathsEnabled: boolean;
	actorId: string;
	actorKind: "main" | "sub" | "advisor";
	parentId?: string;
	profiles: string[];
	tools?: string[];
	denyTools: string[];
	allowPaths: string[];
	denyPaths: string[];
}

export const BUILTIN_PERMISSION_PROFILES: Record<string, PermissionProfile> = {
	"read-only": {
		description: "Read/search/code-intelligence only. No edits, shell, browser, web search, or child delegation.",
		useWhen: "Investigation, review, planning, and file discovery.",
		tools: ["read", "search", "find", "lsp", "irc"],
		denyTools: ["edit", "write", "bash", "eval", "browser", "web_search", "task", "ast_edit"],
	},
	"focused-edit": {
		description:
			"Read/search/edit/write within the selected path scope. No shell, browser, web search, or child delegation.",
		useWhen: "Bounded source/test edits where the parent will run verification.",
		tools: ["read", "search", "find", "lsp", "edit", "write", "ast_grep", "ast_edit", "irc"],
		denyTools: ["bash", "eval", "browser", "web_search", "task"],
	},
	"test-runner": {
		description: "Read/search plus shell execution for targeted verification. No edits or child delegation.",
		useWhen: "Running a specific test/check command after implementation.",
		tools: ["read", "search", "find", "bash", "irc"],
		denyTools: ["edit", "write", "ast_edit", "browser", "web_search", "task"],
	},
	"no-network": {
		description: "Deny browser and web-search tools.",
		useWhen: "Local-repository work that should not fetch external context.",
		denyTools: ["browser", "web_search"],
	},
	"no-delegation": {
		description: "Deny spawning child subagents.",
		useWhen: "Small scoped tasks that should not fan out further.",
		denyTools: ["task"],
	},
};

type ProfileSource = PermissionProfileSummary["source"];

const PROFILE_FILES: Array<{ relativePath: string; source: ProfileSource }> = [
	{ relativePath: ".omp/permissions.json", source: "project" },
	{ relativePath: ".omp/permissions.local.json", source: "local" },
];

const PATH_KEYS = new Set(["path", "paths", "file", "file_path", "relative_path", "cwd", "dir"]);
const RUNTIME_ALLOWED_TOOLS = new Set(["yield", "report_tool_issue"]);

export async function loadPermissionProfiles(cwd: string): Promise<{
	profiles: Record<string, PermissionProfile>;
	summaries: PermissionProfileSummary[];
	errors: string[];
}> {
	const profiles: Record<string, PermissionProfile> = { ...BUILTIN_PERMISSION_PROFILES };
	const sources = new Map<string, ProfileSource>();
	for (const name of Object.keys(BUILTIN_PERMISSION_PROFILES)) sources.set(name, "built-in");
	const errors: string[] = [];

	for (const file of PROFILE_FILES) {
		const filePath = path.resolve(cwd, file.relativePath);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(filePath, "utf8"));
		} catch (error) {
			if (isMissingFileError(error)) continue;
			errors.push(`${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const fileProfiles = readProfileMap(parsed);
		if (!fileProfiles) continue;
		for (const [name, profile] of Object.entries(fileProfiles)) {
			profiles[name] = profile;
			sources.set(name, file.source);
		}
	}

	return {
		profiles,
		summaries: Object.keys(profiles).map(name =>
			summarizeProfile(name, profiles[name] ?? {}, sources.get(name) ?? "project"),
		),
		errors,
	};
}

export function composeEffectivePermissions(input: {
	mode: SubagentPermissionMode;
	toolsEnabled: boolean;
	pathsEnabled: boolean;
	actorId: string;
	actorKind: "main" | "sub" | "advisor";
	parentId?: string;
	request?: TaskPermissionRequest;
	inherited?: EffectiveSubagentPermissions;
	profiles: Record<string, PermissionProfile>;
}): { ok: true; value: EffectiveSubagentPermissions } | { ok: false; error: string } {
	const base = {
		mode: input.mode,
		toolsEnabled: input.toolsEnabled,
		pathsEnabled: input.pathsEnabled,
		actorId: input.actorId,
		actorKind: input.actorKind,
		parentId: input.parentId,
	};

	if (input.mode === "off") {
		return {
			ok: true,
			value: { ...base, profiles: [], tools: undefined, denyTools: [], allowPaths: [], denyPaths: [] },
		};
	}

	const requestedProfiles = input.request?.profiles ?? [];
	const selectedProfiles: PermissionProfile[] = [];
	for (const name of requestedProfiles) {
		const profile = input.profiles[name];
		if (!profile) {
			return {
				ok: false,
				error: `Unknown permission profile "${name}". Available: ${Object.keys(input.profiles).sort().join(", ")}`,
			};
		}
		selectedProfiles.push(profile);
	}

	const requestedTools = concatStrings(
		selectedProfiles.map(profile => profile.tools),
		input.request?.tools,
	);
	let tools = input.toolsEnabled ? uniqueTools(requestedTools) : undefined;
	const denyTools = input.toolsEnabled
		? uniqueTools(
				concatStrings(
					selectedProfiles.map(profile => profile.denyTools),
					input.request?.denyTools,
					input.inherited?.denyTools,
				),
			)
		: [];
	const allowPaths = input.pathsEnabled
		? uniqueStrings(
				concatStrings(
					selectedProfiles.map(profile => profile.allowPaths),
					input.request?.allowPaths,
					input.inherited?.allowPaths,
				),
			)
		: [];
	const denyPaths = input.pathsEnabled
		? uniqueStrings(
				concatStrings(
					selectedProfiles.map(profile => profile.denyPaths),
					input.request?.denyPaths,
					input.inherited?.denyPaths,
				),
			)
		: [];

	if (input.toolsEnabled && input.inherited?.tools) {
		const inherited = new Set(input.inherited.tools.map(tool => tool.toLowerCase()));
		tools = tools ? tools.filter(tool => inherited.has(tool.toLowerCase())) : [...input.inherited.tools];
	}

	return {
		ok: true,
		value: {
			...base,
			profiles: uniqueStrings([...(input.inherited?.profiles ?? []), ...requestedProfiles]),
			tools: tools && tools.length > 0 ? tools : undefined,
			denyTools,
			allowPaths,
			denyPaths,
		},
	};
}

export function evaluateSubagentPermission(input: {
	scope: EffectiveSubagentPermissions | undefined;
	toolName: string;
	toolInput: Record<string, unknown>;
	cwd: string;
}): { action: "allow" | "deny"; reason: string; matched: string } {
	const { scope, toolName } = input;
	if (scope?.mode !== "enforce") return allowDecision();
	const normalizedToolName = toolName.toLowerCase();
	if (RUNTIME_ALLOWED_TOOLS.has(normalizedToolName)) return allowDecision();

	if (scope.toolsEnabled) {
		const deniedTool = scope.denyTools.find(tool => tool.toLowerCase() === normalizedToolName);
		if (deniedTool) {
			return {
				action: "deny",
				reason: `BLOCKED: Subagent permission profile denied tool '${toolName}'.`,
				matched: `subagent:tool-deny:${deniedTool}`,
			};
		}
		if (scope.tools && !scope.tools.some(tool => tool.toLowerCase() === normalizedToolName)) {
			return {
				action: "deny",
				reason: `BLOCKED: Subagent permission profile does not allow tool '${toolName}'.`,
				matched: "subagent:tool-allowlist",
			};
		}
	}

	if (scope.pathsEnabled) {
		const candidates = collectPathCandidates(input.toolInput, input.cwd, normalizedToolName === "bash");
		for (const candidate of candidates) {
			const deniedPattern = scope.denyPaths.find(pattern => pathMatches(candidate, pattern, input.cwd));
			if (deniedPattern) {
				return {
					action: "deny",
					reason: `BLOCKED: Subagent permission profile denied path '${candidate.display}'.`,
					matched: `subagent:path-deny:${deniedPattern}`,
				};
			}
		}
		if (scope.allowPaths.length > 0) {
			for (const candidate of candidates) {
				if (!scope.allowPaths.some(pattern => pathMatches(candidate, pattern, input.cwd))) {
					return {
						action: "deny",
						reason: `BLOCKED: Subagent permission profile does not allow path '${candidate.display}'.`,
						matched: "subagent:path-allowlist",
					};
				}
			}
		}
	}

	return allowDecision();
}

export function formatPermissionScopeForPrompt(scope: EffectiveSubagentPermissions | undefined): string {
	if (!scope || scope.mode === "off") return "";
	return `PERMISSIONS
===================================

You are running under task guardrails, not a security sandbox.
Profiles: ${scope.profiles.length > 0 ? scope.profiles.join(", ") : "none"}
Tool allowlist: ${scope.tools && scope.tools.length > 0 ? scope.tools.join(", ") : "unrestricted"}
Denied tools: ${scope.denyTools.length > 0 ? scope.denyTools.join(", ") : "none"}
Allowed paths: ${scope.allowPaths.length > 0 ? scope.allowPaths.join(", ") : "unrestricted"}
Denied paths: ${scope.denyPaths.length > 0 ? scope.denyPaths.join(", ") : "none"}

Stay within this scope. Do not try to bypass it with bash/eval or indirect writes. If the assignment requires access outside this scope, ask Main via irc when available or yield a blocker describing the missing permission.`;
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function readProfileMap(value: unknown): Record<string, PermissionProfile> | undefined {
	if (!isRecord(value)) return undefined;
	const rawProfiles = value.profiles;
	if (!isRecord(rawProfiles)) return undefined;
	const result: Record<string, PermissionProfile> = {};
	for (const [name, rawProfile] of Object.entries(rawProfiles)) {
		if (!isRecord(rawProfile)) continue;
		const profile = normalizeProfile(rawProfile);
		if (profile) result[name] = profile;
	}
	return result;
}

function normalizeProfile(value: Record<string, unknown>): PermissionProfile | undefined {
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

function summarizeProfile(name: string, profile: PermissionProfile, source: ProfileSource): PermissionProfileSummary {
	const allowedTools = profile.tools?.length ? `allow ${profile.tools.join(", ")}` : "allow unrestricted";
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

function concatStrings(...values: Array<string[] | undefined>): string[];
function concatStrings(values: Array<string[] | undefined>, ...extra: Array<string[] | undefined>): string[];
function concatStrings(
	first: Array<string[] | undefined> | string[] | undefined,
	...extra: Array<string[] | undefined>
): string[] {
	const parts =
		Array.isArray(first) && first.every(item => Array.isArray(item) || item === undefined)
			? [...(first as Array<string[] | undefined>), ...extra]
			: [first as string[] | undefined, ...extra];
	const result: string[] = [];
	for (const part of parts) {
		if (!part) continue;
		for (const item of part) {
			if (typeof item === "string" && item.length > 0) result.push(item);
		}
	}
	return result;
}

function uniqueTools(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of normalizeToolNames(values)) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(value);
	}
	return result;
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

type PathCandidate = {
	display: string;
	absolute: string;
	relative: string;
};

function collectPathCandidates(
	input: Record<string, unknown>,
	cwd: string,
	includeBashCommand: boolean,
): PathCandidate[] {
	const raw = new Set<string>();
	collectPathStrings(input, raw, 0);
	if (includeBashCommand && typeof input.command === "string") {
		for (const token of tokenizeBashPaths(input.command)) raw.add(token);
	}
	return Array.from(raw).map(value => normalizePathCandidate(value, cwd));
}

function collectPathStrings(value: unknown, output: Set<string>, depth: number, key?: string): void {
	if (depth > 4) return;
	if (typeof value === "string") {
		if (key && PATH_KEYS.has(key)) output.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPathStrings(item, output, depth + 1, key);
		return;
	}
	if (!isRecord(value)) return;
	for (const [childKey, childValue] of Object.entries(value)) {
		if (PATH_KEYS.has(childKey)) collectPathStrings(childValue, output, depth + 1, childKey);
		else if (typeof childValue === "object" && childValue !== null) collectPathStrings(childValue, output, depth + 1);
	}
}

function tokenizeBashPaths(command: string): string[] {
	return command
		.split(/[\s;&|()<>]+/)
		.map(token => token.trim().replace(/^['"]|['"]$/g, ""))
		.filter(token => token.length > 0 && looksPathLike(token));
}

function looksPathLike(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("~/") ||
		value.includes("/")
	);
}

function normalizePathCandidate(value: string, cwd: string): PathCandidate {
	const expanded = value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value;
	const absolute = (path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded)).replace(
		/\\/g,
		"/",
	);
	let relative = path.relative(cwd, absolute).replace(/\\/g, "/");
	if (relative === "") relative = ".";
	return { display: value, absolute, relative };
}

function pathMatches(candidate: PathCandidate, pattern: string, cwd: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, "/");
	if (path.isAbsolute(normalizedPattern) || normalizedPattern.startsWith("~/")) {
		const absolutePattern = normalizePathCandidate(normalizedPattern, cwd).absolute;
		return matchesGlob(candidate.absolute, absolutePattern);
	}
	return matchesGlob(candidate.relative, normalizedPattern) || matchesGlob(candidate.absolute, normalizedPattern);
}

function regexEscape(text: string): string {
	return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
	let output = "^";
	for (const char of glob) {
		if (char === "*") output += ".*";
		else if (char === "?") output += ".";
		else output += regexEscape(char);
	}
	return new RegExp(`${output}$`, "i");
}

function matchesGlob(value: string, glob: string): boolean {
	return globToRegex(glob).test(value);
}

function allowDecision(): { action: "allow"; reason: string; matched: string } {
	return { action: "allow", reason: "", matched: "" };
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
