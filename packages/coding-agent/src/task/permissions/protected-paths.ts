/**
 * P5: paths a subagent under an enforce-restricted scope may never write, whatever its scope allows.
 *
 * The agent directory holds the session transcripts whose `session_init` records the scope a revived
 * child gets back, and config.yml; the permission profile files define the profiles a later spawn or
 * revival trusts. A child that could write them could widen its own or a sibling's scope. Tools that
 * write the agent dir without naming a path (`learn`, `manage_skill`) report what they write as
 * restriction paths, so they are judged here too. The `local://` scratch space and `agent://`
 * messages are internal URLs, never filesystem targets, so they are not protected paths.
 */
import * as path from "node:path";
import { approvalCacheKeyForPath } from "../../tools/approval-cache";

/** `permissions.json`, `permissions.local.json`, and any other `permissions*.json` in a `.omp` folder. */
const PROFILE_FILE = /^permissions.*\.json$/i;

/** The profile files the loader reads, relative to the agent dir and to the cwd. */
const USER_PROFILE_FILE = "permissions.json";
const PROJECT_PROFILE_FILES = [".omp/permissions.json", ".omp/permissions.local.json"];

function isWithin(target: string, directory: string): boolean {
	const relative = path.relative(directory, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Why writing `targets` (absolute paths, as named and as resolved) is refused, or `undefined`. The
 * agent dir counts as named and by its real path. A profile file counts by name in any `.omp` folder,
 * and by the real path of each file the loader reads, so a symlinked `.omp` folder or a symlinked
 * user `permissions.json` is covered under the name it points to.
 */
export function protectedPathRefusal(targets: readonly string[], agentDir: string, cwd: string): string | undefined {
	const agentDirs = [...new Set([path.resolve(agentDir), approvalCacheKeyForPath(path.resolve(agentDir))])];
	const profileFiles = new Set(
		[path.join(agentDir, USER_PROFILE_FILE), ...PROJECT_PROFILE_FILES.map(file => path.join(cwd, file))].map(file =>
			approvalCacheKeyForPath(path.resolve(file)),
		),
	);
	const projectProfileDir = approvalCacheKeyForPath(path.resolve(cwd, ".omp"));
	for (const target of targets) {
		if (!path.isAbsolute(target)) continue;
		const inAgentDir = agentDirs.some(directory => isWithin(target, directory));
		const name = path.basename(target);
		const parent = path.dirname(target);
		const profileFile =
			profileFiles.has(target) ||
			(PROFILE_FILE.test(name) && (path.basename(parent) === ".omp" || parent === projectProfileDir));
		if (inAgentDir || profileFile) {
			return `BLOCKED: Subagent permission scope denied a write to protected path '${target}': the agent directory and permission profile files are not writable under a restricted scope.`;
		}
	}
	return undefined;
}
