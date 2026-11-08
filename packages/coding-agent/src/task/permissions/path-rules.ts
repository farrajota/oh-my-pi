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
