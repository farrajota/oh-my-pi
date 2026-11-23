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
import { getMemoriesDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { resolveLocalRoot } from "../../internal-urls/local-root";
import { artifactsDirsFromRegistry } from "../../internal-urls/registry-helpers";
import { AgentRegistry } from "../../registry/agent-registry";
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
 * agent dir (with its sessions and memories dirs, wherever the layout keeps them) counts as named and
 * by its real path. A profile file counts by name in any `.omp` folder,
 * and by the real path of each file the loader reads, so a symlinked `.omp` folder or a symlinked
 * user `permissions.json` is covered under the name it points to.
 */
export function protectedPathRefusal(targets: readonly string[], agentDir: string, cwd: string): string | undefined {
	// An XDG layout keeps sessions and memories outside the agent dir; they are agent-dir state all the same.
	const agentDirs = [
		...new Set(
			[agentDir, getSessionsDir(agentDir), getMemoriesDir(agentDir)].flatMap(directory => [
				path.resolve(directory),
				approvalCacheKeyForPath(path.resolve(directory)),
			]),
		),
	];
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

/** A spill file name (`<N>.log`), matched case-insensitively since a root may sit on such a filesystem. */
const SPILL_FILE_NAME = /^(\d+)\.log$/i;

/** `directory` as written and by its real path. */
function directoryVariants(directory: string): string[] {
	return [path.resolve(directory), approvalCacheKeyForPath(path.resolve(directory))];
}

/**
 * The `local://` roots of every live session, as written and by real path: `<artifactsDir>/local`, or
 * the temp root of a session without a session file.
 */
function liveLocalRoots(): string[] {
	const roots = artifactsDirsFromRegistry().map(directory => path.join(directory, "local"));
	for (const ref of AgentRegistry.global().list()) {
		const manager = ref.session?.sessionManager;
		if (!manager) continue;
		roots.push(
			resolveLocalRoot({
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			}),
		);
	}
	return [...new Set(roots.flatMap(directoryVariants))];
}

/**
 * The spill id of `target` (an absolute path) when it is a spill file at the top of a live session's
 * `local://` root, else `undefined`. The agent tree shares one root, so a spill there may be any
 * agent's raw tool output.
 */
export function liveSpillIdOf(target: string): string | undefined {
	const id = SPILL_FILE_NAME.exec(path.basename(target))?.[1];
	if (id === undefined) return undefined;
	return liveLocalRoots().includes(path.dirname(target)) ? id : undefined;
}

/**
 * Secrets-blind: why reading `targets` (absolute paths) by host path is refused, or `undefined`. The
 * sessions dir and every live session's artifacts dir hold each agent's transcript, and the spills
 * (`<N>.log`) at the top of every live `local://` root hold raw tool output; either may carry what the
 * child may not see. Its own and its descendants' records stay readable through `history://`,
 * `agent://` and `local://<N>.log`, which apply the subtree rule. The rest of the `local://` scratch
 * root is not a record: it is shared scratch space under P7.
 */
export function agentRecordReadRefusal(targets: readonly string[], agentDir: string): string | undefined {
	const artifactDirs = artifactsDirsFromRegistry();
	const recordDirs = [getSessionsDir(agentDir), ...artifactDirs].flatMap(directoryVariants);
	const scratchDirs = artifactDirs.flatMap(directory => directoryVariants(path.join(directory, "local")));
	for (const target of targets) {
		if (!path.isAbsolute(target)) continue;
		if (liveSpillIdOf(target) === undefined) {
			if (!recordDirs.some(directory => isWithin(target, directory))) continue;
			if (scratchDirs.some(directory => isWithin(target, directory))) continue;
		}
		return `BLOCKED: secrets-blind guardrail denied reading agent records at '${target}': read your own transcript and output through history://, agent:// and local://.`;
	}
	return undefined;
}
