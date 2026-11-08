import { normalizeToolNames } from "../../tools/builtin-names";

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
