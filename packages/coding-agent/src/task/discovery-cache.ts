import * as path from "node:path";
import type { EffectiveExtensionRoots } from "../capability/types";
import * as discovery from "./discovery";
import type { AgentDefinition } from "./types";
import type { DiscoveryResult } from "./discovery";

/**
 * Process-level create-time discovery memo and published reload snapshots,
 * keyed by resolved cwd plus the exact effective extension-root struct.
 *
 * TaskTool.create runs for every (sub)agent session in this process. Sessions
 * may share a cwd while carrying different overlay/runtime extension settings,
 * so cwd alone is not an isolation boundary. Explicit plugin reloads replace
 * only the matching cwd+extensions snapshot. Execution-time discovery stays
 * fresh. The live discovery binding also lets test spies invalidate both
 * caches automatically when they replace it.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
const discoverySnapshots = new Map<string, AgentDefinition[]>();
let discoveryMemoFn: typeof discovery.discoverAgents | undefined;

/** Stable cache identity for the filesystem root and the full effective extension-root struct. */
function discoveryCacheKey(cwd: string, extensionRoots?: EffectiveExtensionRoots): string {
	return `${path.resolve(cwd)}\0${JSON.stringify(extensionRoots ?? null)}`;
}

export function discoverAgentsForCreate(
	cwd: string,
	extensionRoots?: EffectiveExtensionRoots,
): Promise<DiscoveryResult> {
	const fn = discovery.discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
		discoverySnapshots.clear();
	}
	const key = discoveryCacheKey(cwd, extensionRoots);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		const discovered = fn(cwd, undefined, extensionRoots);
		pending = discovered.then(result => {
			if (discoveryMemo.get(key) === pending) {
				discoverySnapshots.set(key, result.agents);
			}
			return result;
		});
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

export function getDiscoveredAgentSnapshot(
	cwd: string,
	extensionRoots?: EffectiveExtensionRoots,
): AgentDefinition[] | undefined {
	return discoverySnapshots.get(discoveryCacheKey(cwd, extensionRoots));
}

/** Rescan one cwd and publish its definitions to existing and future task tools. */
export async function refreshAgentDiscovery(cwd: string, extensionRoots?: EffectiveExtensionRoots): Promise<void> {
	const key = discoveryCacheKey(cwd, extensionRoots);
	discoveryMemo.delete(key);
	const pending = discoverAgentsForCreate(cwd, extensionRoots);
	const { agents } = await pending;
	if (discoveryMemo.get(key) === pending) {
		discoverySnapshots.set(key, agents);
	}
}
