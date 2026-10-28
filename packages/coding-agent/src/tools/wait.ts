import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import type { ToolSession } from ".";
import { HubTool } from "./hub";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { nothingToWaitForResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import { lookupAgentRef } from "../internal/agent-registry-bridge";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled } from "./settings";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;

const MESSAGE_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 5 * 60_000];
const MESSAGE_WAIT_LADDER_RESET_MS = 60_000;

interface MessageWindow {
	level: number;
	openedAt: number;
	deadline: number;
}

const activeJobWaiters = new WeakMap<AsyncJobManager, Map<string, Set<string>>>();

function trackJobWaiter(manager: AsyncJobManager, jobId: string, ownerId: string): () => void {
	let byJob = activeJobWaiters.get(manager);
	if (!byJob) {
		byJob = new Map();
		activeJobWaiters.set(manager, byJob);
	}
	let owners = byJob.get(jobId);
	if (!owners) {
		owners = new Set();
		byJob.set(jobId, owners);
	}
	owners.add(ownerId);
	return () => {
		owners.delete(ownerId);
		if (owners.size === 0) byJob.delete(jobId);
	};
}

function noMessageResult(
	messaging: WaitMessaging | undefined,
	manager: AsyncJobManager | undefined,
	window: MessageWindow,
): AgentToolResult<CoordinationDetails> {
	const seconds = (window.deadline - window.openedAt) / 1_000;
	const lines = [`No message within ${seconds.toFixed(1)}s.`];
	if (messaging && manager) {
		const job = manager.getJob(messaging.senderId);
		const owners = job?.agentId === messaging.senderId ? activeJobWaiters.get(manager)?.get(job.id) : undefined;
		for (const owner of owners ?? []) lines.push(`An owner is waiting for this agent's result: agent://${owner}`);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "wait", jobs: [] },
		useless: true,
	};
}

interface WaitMessaging {
	registry: AgentRegistry;
	senderId: string;
	bus: IrcBus;
}

function waitBusForAgent(registry: AgentRegistry, senderId: string): IrcBus {
	const rootId = lookupAgentRef(registry, senderId)?.lineage?.rootId;
	return rootId ? IrcBus.forRoot(registry, rootId) : IrcBus.forRegistry(registry);
}

function takeQueuedMessage(messaging: WaitMessaging | undefined): IrcMessage | undefined {
	if (!messaging) return undefined;
	return drainPendingInbox(messaging.registry, messaging.senderId) ?? messaging.bus.take(messaging.senderId);
}

interface PendingReplies {
	/** Agents asked that can still answer: running, or holding the question for a turn of its own, and not blocked on the caller. */
	from: string[];
	/** Agents asked that cannot answer before the caller finishes (see `AgentAwaits.blocksOn`). */
	blocked: string[];
	/** Agents asked whose turn ended without an answer, or that are gone. */
	stopped: string[];
}

/**
 * Agents the caller messaged during its current run that have not answered
 * yet, split by whether a reply can still come. A message back answers, and
 * so does a settled job of the agent the caller owns, which delivers its
 * result. Only a running agent, or one still holding the question for a turn
 * of its own (a subagent answers a message that reached it as it finished
 * after its result is out), can answer: one that went idle otherwise has
 * finished the turn it got it in, and any automatic reply (a woken subagent's
 * relayed output) has arrived by then.
 */
function pendingReplies(messaging: WaitMessaging): PendingReplies {
	const { registry, senderId, bus } = messaging;
	const replies: PendingReplies = { from: [], blocked: [], stopped: [] };
	const since = lookupAgentRef(registry, senderId)?.session?.runStartedAt ?? 0;
	for (const { to, sentAt } of bus.unansweredSends(senderId, since)) {
		const session = lookupAgentRef(registry, to)?.session;
		if (session && registry.awaits.blocksOn(to, senderId, sentAt)) replies.blocked.push(to);
		else if (session?.isStreaming || session?.hasQueuedIrcFrom(senderId)) replies.from.push(to);
		else replies.stopped.push(to);
	}
	return replies;
}

/** Why a reply wait cannot (or can no longer) get its answer. */
function noReplyText(replies: PendingReplies): string {
	const ids = (list: string[]) => list.map(id => `\`${id}\``).join(", ");
	if (replies.blocked.length > 0) {
		return `${ids(replies.blocked)} cannot reply before you finish: it is waiting on your result. Finish without the answer.`;
	}
	if (replies.stopped.length > 0) {
		return `${ids(replies.stopped)} finished its turn without replying. Ask again, or finish without the answer.`;
	}
	return "no background job or service you started is running, and no agent you messaged this run owes a reply. Other agents' results and messages arrive on their own.";
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

/**
 * Blocks on owned background jobs and services, or messages from independent
 * running peers. A parent blocked awaiting this agent and its ancestry cannot
 * sustain a message-only wait. When the last eligible peer stops, recheck owned
 * work before applying that restriction. An incoming message still ends a wait.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	#hubTool: HubTool | undefined;
	#lastMessageWait: { level: number; endedAt: number } | undefined;
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started, or a reply you asked for";
	readonly description = prompt.render(waitDescription);
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly handlesToolInterrupt = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(
		toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging =
			registry && senderId ? { registry, senderId, bus: waitBusForAgent(registry, senderId) } : undefined;
		const manager = this.session.asyncJobManager;

		const pending = takeQueuedMessage(messaging);
		if (pending && messaging) return messageResult(messaging.senderId, pending);
		// Refreshes owned-service tracking only; jobs and peers are in-process, so a
		// hung broker must not turn every wait into an error.
		if (cfgLaunchEnabled.get(this.session.settings)) {
			try {
				await listServicesTolerant(this.session, signal);
			} catch (error) {
				// An interrupt landing during the refresh (most often the notice
				// of the job this wait is for) ends the wait as one landing just
				// after it does: the checks below and the aborted wake path.
				if (signal?.reason !== TOOL_INTERRUPT_ABORT_REASON) throw error;
			}
			const queued = takeQueuedMessage(messaging);
			if (queued && messaging) return messageResult(messaging.senderId, queued);
		}
		const deadline = Date.now() + WAIT_MAX_MS;
		// Opened by the first message-only block and kept across re-evaluations,
		// so a peer stopping mid-window cannot restart it.
		let messageWindow: MessageWindow | undefined;
		try {
			for (;;) {
				const queued = takeQueuedMessage(messaging);
				if (queued && messaging) return messageResult(messaging.senderId, queued);
				const jobs = manager?.getRunningJobs({ ownerId: senderId }) ?? [];
				// An accepted completion whose delivery has not reached the transcript
				// yet (queued, parked on the yield queue, or skipped while an earlier
				// wait watched it) is exactly what this wait is for: return it now
				// instead of reporting nothing to wait for.
				const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
				if (manager && undelivered.length > 0) {
					// Watching marks this wait as the result's consumer, which lets the
					// hub recover a delivery its owner sink already parked.
					const undeliveredIds = undelivered.map(job => job.id);
					manager.watchJobs(undeliveredIds);
					try {
						return await this.#buildJobResult(toolCallId, [...undelivered, ...jobs]);
					} finally {
						manager.unwatchJobs(undeliveredIds);
					}
				}
				const serviceRunning = hasLiveOwnedService(this.session);
				const callerJob = manager?.getJob(senderId ?? "");
				const blockedParentJob =
					senderId !== undefined &&
					callerJob !== undefined &&
					callerJob.agentId === senderId &&
					callerJob.ownerId !== senderId &&
					callerJob.status === "running";
				const blockedAncestry = new Set<string>();
				if (blockedParentJob && callerJob) {
					let ancestorId: string | undefined = callerJob.ownerId;
					while (ancestorId && !blockedAncestry.has(ancestorId)) {
						blockedAncestry.add(ancestorId);
						ancestorId = messaging?.registry.get(ancestorId)?.parentId;
					}
				}
				const replies = messaging ? pendingReplies(messaging) : { from: [], blocked: [], stopped: [] };
				const eligiblePeer = (ref: AgentRef): boolean =>
					!blockedAncestry.has(ref.id) && !replies.blocked.includes(ref.id);
				const independentRunningPeer =
					messaging?.registry
						.listVisibleTo(messaging.senderId)
						.some(ref => eligiblePeer(ref) && messaging.registry.isRunning(ref)) ?? false;
				const hasReplyState = replies.from.length > 0 || replies.blocked.length > 0 || replies.stopped.length > 0;
				if (blockedParentJob && jobs.length === 0 && !serviceRunning && !independentRunningPeer && !hasReplyState) {
					throw new ToolError(
						"Nothing to wait for: no background job or service you started is running. Other agents' results and messages arrive on their own.",
					);
				}
				if (jobs.length === 0 && !serviceRunning && replies.from.length === 0 && !independentRunningPeer) {
					if (replies.blocked.length > 0 || replies.stopped.length > 0) {
						return {
							content: [{ type: "text", text: `Nothing to wait for: ${noReplyText(replies)}` }],
							details: { op: "wait", jobs: [] },
						};
					}
					const result: AgentToolResult<CoordinationDetails> = {
						...nothingToWaitForResult(this.session),
						details: { op: "wait", jobs: [] },
					};
					if (messaging) {
						result.content = result.content.map(item =>
							item.type === "text"
								? { ...item, text: `${item.text} Also, no agent you messaged this run owes a reply.` }
								: item,
						);
					}
					if (signal?.aborted && signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
						return {
							...result,
							content: [
								{ type: "text", text: `Wait interrupted. Nothing to wait for: ${noReplyText(replies)}` },
							],
							useless: undefined,
						};
					}
					return result;
				}
				const window =
					jobs.length === 0 && !serviceRunning ? (messageWindow ??= this.#openMessageWindow()) : undefined;
				const result = await this.#blockUntilWake({
					toolCallId,
					jobs,
					manager,
					messaging,
					serviceRunning,
					eligiblePeer,
					deadline: window ? Math.min(window.deadline, deadline) : deadline,
					messageWindow: window,
					signal,
					onUpdate,
				});
				if (result) return result;
			}
		} finally {
			if (messageWindow) this.#lastMessageWait = { level: messageWindow.level, endedAt: Date.now() };
		}
	}

	async #buildJobResult(toolCallId: string, jobs: AsyncJob[]): Promise<AgentToolResult<CoordinationDetails>> {
		const hubTool = (this.#hubTool ??= new HubTool(this.session));
		const result = await hubTool.execute(toolCallId, {
			op: "wait",
			ids: jobs.map(job => job.id),
			...(jobs.some(job => job.status === "running") ? { timeoutMs: 1 } : {}),
		});
		return {
			...result,
			details: {
				...result.details,
				op: "wait",
			},
		};
	}

	#openMessageWindow(): MessageWindow {
		const now = Date.now();
		const last = this.#lastMessageWait;
		const level =
			!last || now - last.endedAt >= MESSAGE_WAIT_LADDER_RESET_MS
				? 0
				: Math.min(last.level + 1, MESSAGE_WAIT_LADDER_MS.length - 1);
		return { level, openedAt: now, deadline: now + MESSAGE_WAIT_LADDER_MS[level] };
	}

	/**
	 * Block on one snapshot of wake sources. Returns undefined when the last
	 * running peer stopped with nothing else to report: its accepted result may
	 * register or settle a job right after, so the caller re-evaluates.
	 */
	async #blockUntilWake(args: {
		toolCallId: string;
		jobs: AsyncJob[];
		manager: AsyncJobManager | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		eligiblePeer: (ref: AgentRef) => boolean;
		deadline: number;
		messageWindow: MessageWindow | undefined;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails> | undefined> {
		const { toolCallId, jobs, manager, messaging, serviceRunning, deadline, messageWindow, signal, onUpdate } = args;
		const watchedIds = jobs.map(job => job.id);
		const stopTracking =
			manager && messaging ? jobs.map(job => trackJobWaiter(manager, job.id, messaging.senderId)) : [];
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const busAbort = new AbortController();
		const awaitingReply =
			messaging !== undefined && jobs.length === 0 && !serviceRunning && pendingReplies(messaging).from.length > 0;
		const replyWait = awaitingReply;
		const busLeg = messaging
			? messaging.bus
					.wait(messaging.senderId, {}, 0, busAbort.signal, {
						...(jobs.length === 0 && !serviceRunning && !awaitingReply
							? {
									liveness: {
										registry: messaging.registry,
										senderId: messaging.senderId,
										eligiblePeer: args.eligiblePeer,
									},
								}
							: {}),
					})
					.then(
						message => message,
						error => {
							if (
								!busAbort.signal.aborted &&
								error instanceof Error &&
								error.message === "IRC wait aborted: no running peers remain"
							)
								return "peer-stopped" as const;
							return null;
						},
					)
			: undefined;
		// A reply wait re-checks whether an agent asked can still answer on
		// every block change, status change, and end of an asked agent's turn
		// (after any automatic reply that turn owes has been sent).
		const replyGone = Promise.withResolvers<void>();
		const unsubscribers: Array<() => void> = [];
		if (replyWait) {
			const checkReplies = () => {
				const replies = pendingReplies(messaging);
				if (replies.from.length > 0) return;
				replyGone.resolve();
			};
			unsubscribers.push(messaging.registry.awaits.onChange(checkReplies));
			unsubscribers.push(messaging.registry.onChange(checkReplies));
			for (const id of pendingReplies(messaging).from) {
				const session = lookupAgentRef(messaging.registry, id)?.session;
				if (!session) continue;
				unsubscribers.push(
					session.subscribe(event => {
						if (event.type === "agent_end") void session.waitForIrcReplies().then(checkReplies);
					}),
				);
			}
			checkReplies();
		}
		// A wait that only these subagents' results can end blocks the caller on
		// them, which their own reply waits read. A bash job or service is
		// another way out, so such a wait blocks on no one.
		const watchedAgents = jobs.flatMap(job => (job.agentId ? [job.agentId] : []));
		const releaseHold =
			messaging && !serviceRunning && watchedAgents.length === jobs.length
				? messaging.registry.awaits.hold(messaging.senderId, watchedAgents, { interruptible: true })
				: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, Math.max(0, Math.min(deadline, Date.now() + WAIT_MAX_MS) - Date.now()));
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		if (jobs.length > 0) emitProgress();
		let wake: "job" | "message" | "peer-stopped" | "service" | "unanswerable" | "timeout" | "abort";
		try {
			wake = await Promise.race([
				...jobs.map(job => job.promise.then(() => "job" as const)),
				...(busLeg ? [busLeg.then(message => (message === "peer-stopped" ? "peer-stopped" : "message"))] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(replyWait ? [replyGone.promise.then(() => "unanswerable" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			]);
		} finally {
			clearTimeout(timer);
			clearInterval(progressTimer);
			busAbort.abort();
			serviceAbort.abort();
			for (const unsubscribe of unsubscribers) unsubscribe();
			releaseHold?.();
			signal?.removeEventListener("abort", onAbort);
		}
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (message or interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			// A dequeued message wins a photo-finish with a job: the job remains
			// deliverable, whereas a lost message cannot be recovered from the bus.
			const message = await busLeg;
			if (message && message !== "peer-stopped" && messaging) return messageResult(messaging.senderId, message);
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
					// Not `useless`: a message woke the agent, which the loop guard
					// must treat as progress rather than an idle poll.
					return {
						content: [{ type: "text", text: "Wait interrupted by message." }],
						details: { op: "wait", jobs: [], interrupted: true },
					};
				}
				throwIfAborted(signal);
			}
			if (wake === "peer-stopped" || wake === "unanswerable") return undefined;
			if (manager && jobs.length > 0) return await this.#buildJobResult(toolCallId, jobs);
			if (wake === "timeout" && messageWindow) return noMessageResult(messaging, manager, messageWindow);
			return {
				content: [
					{
						type: "text",
						text:
							wake === "service"
								? "A service finished. Read proc:// for its status and output."
								: replyWait
									? "Wait limit reached with no reply. Ask again, or finish without the answer."
									: "Wait limit reached; background work may still be running. Read proc:// for status.",
					},
				],
				details: { op: "wait", jobs: [] },
				// A wait that ran out with nothing to report is an idle poll.
				...(wake === "timeout" ? { useless: true } : {}),
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
			for (const stop of stopTracking) stop();
		}
	}
}
