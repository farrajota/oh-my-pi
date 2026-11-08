/**
 * Read-only views of the async jobs one agent owns, computed from the
 * process-root `AsyncJobManager`. Shared by `AgentSession` (its own jobs) and
 * the main thread's mirror of a worker-homed session, which scopes the same
 * root manager to the child's agent id.
 */
import type { AsyncJob, AsyncJobManagerApi } from "../async";
import type { JobWidgetRegistry } from "../job-widgets/types";
import { AgentRegistry } from "../registry/agent-registry";
import type { JobWidgetEntry } from "@oh-my-pi/pi-tui/tools/job-widget";
import { truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { TERMINAL_HISTORY_LIMIT } from "../async/job-manager";
import type {
	AsyncJobInspection,
	AsyncJobOutputSnapshot,
	AsyncJobSnapshot,
	AsyncJobSnapshotItem,
	AsyncJobSnapshotOptions,
	AsyncJobTree,
	BackgroundControlResult,
} from "./agent-session-types";

/** The public summary of `job` (see {@link AsyncJobSnapshotItem}); its caption shows only while widgets are on. */
function jobSnapshotItem(job: AsyncJob, widgets: JobWidgetRegistry | undefined): AsyncJobSnapshotItem {
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		label: job.label,
		intent: job.intent,
		caption: widgets?.caption(job),
		command: job.process?.command,
		startTime: job.startTime,
		endTime: job.endTime,
		agentId: job.agentId,
		ownerId: job.ownerId,
		...(job.status === "running" && job.queued === true ? { queued: true } : {}),
	};
}

/** Running and recent jobs `agentId` owns (every job when it is undefined), with their delivery state. */
export function asyncJobSnapshot(
	manager: AsyncJobManagerApi,
	agentId: string | undefined,
	options?: { recentLimit?: number },
): AsyncJobSnapshot {
	const ownerFilter = agentId ? { ownerId: agentId } : undefined;
	const running = manager.getRunningJobs(ownerFilter).map(job => jobSnapshotItem(job, manager.widgets));
	const recent = manager
		.getRecentJobs(options?.recentLimit ?? 5, ownerFilter)
		.map(job => jobSnapshotItem(job, manager.widgets));
	const delivery = manager.getDeliveryState(ownerFilter);
	return { running, recent, delivery };
}

/**
 * Live widgets of the running jobs `agentId` owns (the owner scope of
 * {@link asyncJobSnapshot}), in job order. Reading a widget marks it shown,
 * which is what lets its spec be written.
 */
export function runningJobWidgets(manager: AsyncJobManagerApi, agentId: string | undefined): JobWidgetEntry[] {
	const widgets = manager.widgets;
	if (!widgets) return [];
	const entries: JobWidgetEntry[] = [];
	for (const job of manager.getRunningJobs(agentId ? { ownerId: agentId } : undefined)) {
		const view = widgets.view(job);
		if (view) entries.push({ id: job.id, type: job.type, view });
	}
	return entries;
}

/** Each agent's parent: the registry's link, else the owner of the task job that runs it. */
function jobTreeParents(manager: AsyncJobManagerApi): Map<string, string> {
	const parents = new Map<string, string>();
	for (const job of [...manager.getRunningJobs(), ...manager.getRecentJobs(Number.POSITIVE_INFINITY)]) {
		if (job.agentId !== undefined && job.ownerId !== undefined) parents.set(job.agentId, job.ownerId);
	}
	for (const ref of AgentRegistry.global().list()) {
		if (ref.parentId !== undefined) parents.set(ref.id, ref.parentId);
	}
	return parents;
}

/** Whether `job`'s owner is `rootId` or descends from it; every job when `rootId` is undefined. */
function inJobTree(job: AsyncJob, rootId: string | undefined, parents: ReadonlyMap<string, string>): boolean {
	if (!rootId) return true;
	const seen = new Set<string>();
	for (let id = job.ownerId; id !== undefined && !seen.has(id); id = parents.get(id)) {
		if (id === rootId) return true;
		seen.add(id);
	}
	return false;
}

/**
 * Async jobs of `rootId` and every subagent below it: the running ones and
 * the `recentLimit` (default 10) newest settled ones across the tree, with the subagents
 * that own them and the ancestors linking those to the root. Lineage comes
 * from the agent registry, falling back to the task job that runs a subagent
 * once its registry entry is gone.
 */
export function asyncJobTree(
	manager: AsyncJobManagerApi,
	rootId: string | undefined,
	options?: { recentLimit?: number },
): AsyncJobTree {
	const parents = jobTreeParents(manager);
	const running = manager.getRunningJobs().filter(job => inJobTree(job, rootId, parents));
	const recent = manager
		.getRecentJobs(Number.POSITIVE_INFINITY)
		.filter(job => inJobTree(job, rootId, parents))
		.slice(0, options?.recentLimit ?? 10);
	const agents = new Map<string, { id: string; parentId?: string }>();
	for (const job of [...running, ...recent]) {
		for (let id = job.ownerId; id !== undefined && id !== rootId && !agents.has(id); id = parents.get(id)) {
			agents.set(id, { id, parentId: parents.get(id) });
		}
	}
	return {
		running: running.map(job => jobSnapshotItem(job, manager.widgets)),
		recent: recent.map(job => jobSnapshotItem(job, manager.widgets)),
		rootId,
		agents: [...agents.values()],
	};
}

/** Ask for the captions of the running commands in `rootId`'s job tree (see {@link asyncJobTree}). */
export function requestJobTreeCaptions(manager: AsyncJobManagerApi, rootId: string | undefined): void {
	const widgets = manager.widgets;
	if (!widgets) return;
	const parents = jobTreeParents(manager);
	for (const job of manager.getRunningJobs()) {
		if (inJobTree(job, rootId, parents)) widgets.requestCaption(job);
	}
}

/**
 * One async job in `rootId`'s tree (see {@link asyncJobTree}): its command,
 * live pids, exit status and output. Undefined when the job is unknown, owned
 * outside the tree, or evicted.
 */
export function inspectAsyncJob(
	manager: AsyncJobManagerApi,
	rootId: string | undefined,
	id: string,
): AsyncJobInspection | undefined {
	const job = manager.getJob(id);
	if (!job || job.foreground || !inJobTree(job, rootId, jobTreeParents(manager))) return undefined;
	const details = job.latestDetails;
	const reported = typeof details?.exitCode === "number" ? details.exitCode : undefined;
	// Bash reports only non-zero exits; a completed command exited 0.
	const exitCode = reported ?? (job.type === "bash" && job.status === "completed" ? 0 : undefined);
	const output = job.status === "running" ? job.progressText : (job.resultText ?? job.errorText ?? job.progressText);
	return {
		command: job.process?.command,
		cwd: job.process?.cwd,
		pids: job.status === "running" ? (job.process?.pids() ?? []) : [],
		exitCode,
		output,
		artifactId: details?.meta?.truncation?.artifactId,
		widget: manager.widgets?.view(job),
	};
}

/** A listed job by id, under the owner scope of {@link asyncJobSnapshot}. */
export function ownedAsyncJob(
	manager: AsyncJobManagerApi,
	agentId: string | undefined,
	id: string,
): AsyncJob | undefined {
	const job = manager.getJob(id);
	if (!job || job.foreground) return undefined;
	return !agentId || job.ownerId === agentId ? job : undefined;
}

/** Cancel a running job `agentId` owns; false when there is none by that id. */
export function cancelOwnedAsyncJob(manager: AsyncJobManagerApi, agentId: string | undefined, id: string): boolean {
	const job = ownedAsyncJob(manager, agentId, id);
	return job !== undefined && manager.cancel(id, { ownerId: job.ownerId });
}

/**
 * The extension job snapshot (`ctx.getAsyncJobSnapshot`). By default it lists what
 * {@link asyncJobSnapshot} lists: running jobs `agentId` owns and its newest settled rows. With
 * `history`, `recent` comes from the manager's terminal history instead, which outlives evicted
 * rows, so a dashboard keeps showing jobs whose results were already delivered.
 */
export function extensionAsyncJobSnapshot(
	manager: AsyncJobManagerApi,
	agentId: string | undefined,
	options?: AsyncJobSnapshotOptions,
): AsyncJobSnapshot {
	const ownerFilter = agentId ? { ownerId: agentId } : undefined;
	const includeAgentJobs = options?.includeAgentJobs !== false;
	const listed = (job: { agentId?: string }): boolean => includeAgentJobs || job.agentId === undefined;
	const running = manager
		.getRunningJobs(ownerFilter)
		.filter(listed)
		.map(job => jobSnapshotItem(job, manager.widgets));
	const requested = options?.recentLimit ?? 5;
	let recent: AsyncJobSnapshotItem[];
	if (options?.history === true) {
		const recentLimit = Number.isNaN(requested)
			? 0
			: Math.min(TERMINAL_HISTORY_LIMIT, Math.max(0, Math.trunc(requested)));
		recent = manager
			.getTerminalHistory(ownerFilter, { includeAgentJobs })
			.slice(0, recentLimit)
			.map(entry => ({ ...entry }));
	} else {
		recent = manager
			.getRecentJobs(Number.POSITIVE_INFINITY, ownerFilter)
			.filter(listed)
			.slice(0, requested)
			.map(job => jobSnapshotItem(job, manager.widgets));
	}
	return { running, recent, delivery: manager.getDeliveryState(ownerFilter) };
}

/**
 * Output of a job `agentId` owns: the latest progress while it runs, then its result (or its
 * error when it failed, or was cancelled with one), as a bounded tail. Null for unknown,
 * evicted and other owners' jobs.
 */
export function asyncJobOutput(
	manager: AsyncJobManagerApi,
	agentId: string | undefined,
	id: string,
): AsyncJobOutputSnapshot | null {
	const job = ownedAsyncJob(manager, agentId, id);
	if (!job) return null;
	const sourced =
		job.status === "running"
			? { source: "progress" as const, text: job.progressText }
			: job.status === "completed"
				? { source: "result" as const, text: job.resultText }
				: job.status === "failed" || job.errorText !== undefined
					? { source: "error" as const, text: job.errorText }
					: { source: "result" as const, text: job.resultText };
	if (sourced.text === undefined) return { id, status: job.status, source: "none", text: "", truncated: false };
	const bounded = truncateTail(sourced.text);
	return {
		id,
		status: job.status,
		source: sourced.source,
		text: bounded.content,
		truncated: bounded.truncated === true,
	};
}

/**
 * Cancel a running job `agentId` owns and wait for it to settle, so the caller's next snapshot
 * already shows it cancelled.
 */
export async function cancelOwnedAsyncJobAndSettle(
	manager: AsyncJobManagerApi,
	agentId: string | undefined,
	id: string,
): Promise<BackgroundControlResult> {
	const job = ownedAsyncJob(manager, agentId, id);
	if (!job) return { id, status: "not_found", message: "Background job not found." };
	if (job.status !== "running") {
		return { id, status: "already_completed", message: "Background job is already complete." };
	}
	if (cancelOwnedAsyncJob(manager, agentId, id)) {
		await job.promise;
		return { id, status: "cancelled", message: "Background job cancelled." };
	}
	return ownedAsyncJob(manager, agentId, id)
		? { id, status: "already_completed", message: "Background job completed before cancellation." }
		: { id, status: "not_found", message: "Background job is no longer available." };
}
