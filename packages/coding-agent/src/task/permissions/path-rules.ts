import * as os from "node:os";
import * as path from "node:path";
import type { PathConstraintGroup, PermissionScope } from "./types";

/** One path a call names, in the forms patterns are matched against. */
export interface PathCandidate {
	/** As the call named it. */
	readonly display: string;
	/** Absolute, `/`-separated. */
	readonly absolute: string;
	/** Relative to the cwd, `/`-separated; `.` for the cwd itself. */
	readonly relative: string;
}

// Linux and other case-sensitive hosts must keep filesystem identity; Windows and default macOS
// filesystems compare case-insensitively.
const CASE_INSENSITIVE_HOST = process.platform === "win32" || process.platform === "darwin";

export function toPathConstraintGroup(values: readonly string[] | undefined): PathConstraintGroup | undefined {
	if (!values || values.length === 0) return undefined;
	return [values[0]!, ...values.slice(1)];
}

export function toPathGroups(values: readonly string[] | undefined): PathConstraintGroup[] {
	const group = toPathConstraintGroup(values);
	return group ? [group] : [];
}

export function flattenPathGroups(groups: readonly PathConstraintGroup[]): string[] {
	return [...new Set(groups.flatMap(group => [...group]))];
}

/** Whether the scope constrains filesystem targets at all. */
export function hasPathRules(scope: Pick<PermissionScope, "pathsEnabled" | "allowPathGroups" | "denyPathGroups">) {
	return scope.pathsEnabled && (scope.allowPathGroups.length > 0 || scope.denyPathGroups.length > 0);
}

function expandHome(value: string): string {
	return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function toPathCandidate(value: string, cwd: string): PathCandidate {
	const expanded = expandHome(value);
	const absolute = (path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded)).replace(
		/\\/g,
		"/",
	);
	let relative = path.relative(cwd, absolute).replace(/\\/g, "/");
	if (relative === "") relative = ".";
	return { display: value, absolute, relative };
}

/**
 * Whether `candidate` matches one path rule pattern.
 *
 * Glob patterns: `*` matches any characters including `/`, `?` matches one character, and a leading
 * `**` segment also matches at the root. A relative glob is tried against the cwd-relative and the
 * absolute path; an absolute or `~/` glob against the absolute path.
 *
 * A pattern without `*` or `?` names a path: it covers that path and everything below it, the way
 * upstream's restricted folders do, so a directory entry `src` covers `src/**`.
 *
 * `src/**` does not match `src` itself (fork-era glob semantics, kept): under `allowPaths: ["src/**"]`
 * a grep or find rooted at `src` is refused. Write `src` to cover the folder and its contents.
 */
export function pathMatchesPattern(candidate: PathCandidate, pattern: string, cwd: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, "/");
	if (!/[*?]/.test(normalizedPattern)) {
		const root = toPathCandidate(normalizedPattern, cwd).absolute;
		return coversPath(root, candidate.absolute);
	}
	if (path.isAbsolute(normalizedPattern) || normalizedPattern.startsWith("~/")) {
		return matchesGlob(candidate.absolute, toPathCandidate(normalizedPattern, cwd).absolute);
	}
	return matchesGlob(candidate.relative, normalizedPattern) || matchesGlob(candidate.absolute, normalizedPattern);
}

function coversPath(root: string, value: string): boolean {
	const left = CASE_INSENSITIVE_HOST ? root.toLowerCase() : root;
	const right = CASE_INSENSITIVE_HOST ? value.toLowerCase() : value;
	if (left === right) return true;
	return right.startsWith(left.endsWith("/") ? left : `${left}/`);
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
	return new RegExp(`${output}$`, CASE_INSENSITIVE_HOST ? "i" : "");
}

function matchesGlob(value: string, glob: string): boolean {
	if (glob.startsWith("**/") && matchesGlob(value, glob.slice(3))) return true;
	return globToRegex(glob).test(value);
}

/** Argument keys whose string values name filesystem targets. */
const PATH_KEYS: ReadonlySet<string> = new Set(["path", "paths", "file", "file_path", "relative_path", "cwd", "dir"]);

function collectPathStrings(value: unknown, output: Set<string>, depth: number, key?: string): void {
	if (depth > 4) return;
	if (typeof value === "string") {
		if (key !== undefined && PATH_KEYS.has(key)) output.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPathStrings(item, output, depth + 1, key);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [childKey, childValue] of Object.entries(value)) {
		if (PATH_KEYS.has(childKey)) collectPathStrings(childValue, output, depth + 1, childKey);
		else if (typeof childValue === "object" && childValue !== null) collectPathStrings(childValue, output, depth + 1);
	}
}

/** The strings a call names under a path argument key (`path`, `paths`, `file`, `cwd`, ...), deduplicated. */
export function permissionPathArguments(toolInput: Record<string, unknown>): string[] {
	const named = new Set<string>();
	collectPathStrings(toolInput, named, 0);
	return [...named];
}

const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\//i;

/** The top-level `;` entries of `target` (braces and backslash escapes protect a `;`), quotes stripped. */
function semicolonEntries(target: string): string[] {
	const entries: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < target.length; i++) {
		const ch = target[i];
		if (ch === "\\") i++;
		else if (ch === "{") depth++;
		else if (ch === "}" && depth > 0) depth--;
		else if (ch === ";" && depth === 0) {
			entries.push(target.slice(start, i));
			start = i + 1;
		}
	}
	entries.push(target.slice(start));
	return entries.map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(entry => entry.length > 0);
}

/**
 * What one path string stands for. Tools that take path lists (`read`, the search tools) open each
 * entry of a `;` list, so a list is judged by its entries: `local://x;.env` is the scratch file `x`
 * and `.env`, never one exempt URL. A plain string is judged whole too, because a literal file name
 * may contain `;`. A URL-shaped string is a list or one URL of its first entry's scheme, so its
 * entries cover it. Comma and whitespace lists split only when their entries exist; the approval
 * targets a tool reports resolve those.
 */
export function permissionListTargets(target: string): string[] {
	if (!target.includes(";")) return [target];
	const entries = semicolonEntries(target);
	if (entries.length <= 1) return [target];
	return URL_SCHEME_PREFIX.test(target.trim()) ? entries : [target, ...entries];
}

export function expandListTargets(targets: Iterable<string>): string[] {
	const expanded = new Set<string>();
	for (const target of targets) for (const entry of permissionListTargets(target)) expanded.add(entry);
	return [...expanded];
}
