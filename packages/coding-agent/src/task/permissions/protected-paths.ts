/**
 * P5: paths a subagent under an enforce-restricted scope may never write, whatever its scope allows.
 *
 * The agent directory holds the session transcripts whose `session_init` records the scope a revived
 * child gets back, and config.yml; the permission profile files define the profiles a later spawn or
 * revival trusts. A child that could write them could widen its own or a sibling's scope. Its
 * `local://` scratch space and `agent://` messages are internal URLs, never filesystem targets, so
 * they stay usable.
 */
import * as path from "node:path";
import { approvalCacheKeyForPath } from "../../tools/approval-cache";

/** `permissions.json`, `permissions.local.json`, and any other `permissions*.json` in a `.omp` folder. */
const PROFILE_FILE = /^permissions.*\.json$/i;

function isWithin(target: string, directory: string): boolean {
	const relative = path.relative(directory, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Why writing `targets` (absolute paths) is refused, or `undefined`. The agent dir counts as named and
 * by its real path, so a symlinked agent dir is covered too.
 */
export function protectedPathRefusal(targets: readonly string[], agentDir: string): string | undefined {
	const agentDirs = [...new Set([path.resolve(agentDir), approvalCacheKeyForPath(path.resolve(agentDir))])];
	for (const target of targets) {
		if (!path.isAbsolute(target)) continue;
		const inAgentDir = agentDirs.some(directory => isWithin(target, directory));
		const profileFile = path.basename(path.dirname(target)) === ".omp" && PROFILE_FILE.test(path.basename(target));
		if (inAgentDir || profileFile) {
			return `BLOCKED: Subagent permission scope denied a write to protected path '${target}': the agent directory and permission profile files are not writable under a restricted scope.`;
		}
	}
	return undefined;
}
