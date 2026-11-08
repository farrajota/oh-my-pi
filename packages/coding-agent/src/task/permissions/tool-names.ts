import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES, isMCPToolName, normalizeToolNames } from "../../tools/builtin-names";

/**
 * Permission name of the messaging grant. Profile files spell it `irc` or `hub`; the fork-era hub
 * tool is gone, and the grant now means `wait` plus `write` to `agent://` targets.
 */
export const MESSAGING_GRANT = "hub";

/**
 * Canonical spelling of a tool name in permission lists: `irc` becomes the messaging grant and
 * built-in aliases such as `search` become their tool (`grep`). Other names keep their spelling,
 * because profile identity hashes recorded by earlier releases depend on it.
 */
export function normalizePermissionToolName(name: string): string {
	return name.trim().toLowerCase() === "irc" ? MESSAGING_GRANT : (normalizeToolNames([name])[0] ?? name);
}

/** Case-insensitive key used when comparing permission tool names. */
export function permissionToolKey(name: string): string {
	return normalizePermissionToolName(name).toLowerCase();
}

/** Normalize and deduplicate (case-insensitively) while keeping first-seen order. */
export function uniquePermissionTools(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = normalizePermissionToolName(value);
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

/**
 * Permissions a tool checks under a name of its own (`tools.approval["computer.control"]`). A profile
 * grants or denies them through the owning tool's name, and can also deny them by their own name.
 */
const SUB_PERMISSION_OWNERS: ReadonlyMap<string, string> = new Map([["computer.control", "computer"]]);

/** The tool that owns a sub-permission key (`computer` for `computer.control`), or `undefined`. */
export function permissionToolOwner(key: string): string | undefined {
	return SUB_PERMISSION_OWNERS.get(key);
}

/** Tools that ship with the agent; anything else is an extension, custom, MCP or eval route. */
const NATIVE_TOOL_KEYS: ReadonlySet<string> = new Set([
	...BUILTIN_TOOL_NAMES,
	...HIDDEN_TOOL_NAMES,
	"report_tool_issue",
]);

/**
 * Native tools whose effects reach beyond the paths their arguments name: shells and interpreters,
 * debuggers that launch programs, LSP workspace edits, GitHub checkouts and pushes into the working
 * tree, managed skill files, and security scans that read (and may upload) the whole repository.
 */
const UNPROVABLE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
	"bash",
	"eval",
	"lsp",
	"debug",
	"ida",
	"github",
	"manage_skill",
	"security_scan",
]);

/**
 * Whether a tool's effects cannot be checked against path rules (normalized name, any case). A scope
 * with path rules or guardrails denies these. The messaging grant is not a tool and never counts.
 */
export function isUnprovableEffectTool(toolName: string): boolean {
	const key = permissionToolKey(toolName);
	if (key === MESSAGING_GRANT) return false;
	return UNPROVABLE_NATIVE_TOOLS.has(key) || isMCPToolName(key) || !NATIVE_TOOL_KEYS.has(key);
}
