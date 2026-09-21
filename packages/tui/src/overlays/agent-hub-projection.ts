import type { AgentMetricsSummary, AgentRecordLike, AgentStatus } from "./agent-hub-types";
import { MAIN_AGENT_ID } from "./agent-hub-types";
import type { ObservableSession } from "./session-observer-registry";

export type AgentMetrics = AgentMetricsSummary;

export interface AggregateMetrics extends AgentMetrics {
	reportedAgents: number;
	/** Rows whose duration is an observer-measured active runtime. */
	activeDurationAgents: number;
}

interface AgentTreeProjection<TRecord extends AgentRecordLike> {
	rows: TRecord[];
	depthById: Map<string, number>;
	parentById: Map<string, string>;
	lastSiblingById: Map<string, boolean>;
}

export const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

function finiteMetric(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Exact observer usage for one roster entry. */
export function progressMetrics(observed: ObservableSession | undefined): AgentMetrics | undefined {
	const progress = observed?.progress;
	if (!progress) return undefined;
	const tokens = usageTotal(progress.usage) ?? progress.tokens;
	const { requests, toolCount: tools, cost, durationMs } = progress;
	if (
		typeof tokens !== "number" ||
		!Number.isFinite(tokens) ||
		typeof requests !== "number" ||
		!Number.isFinite(requests) ||
		typeof tools !== "number" ||
		!Number.isFinite(tools) ||
		typeof cost !== "number" ||
		!Number.isFinite(cost) ||
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs)
	) {
		return undefined;
	}
	return {
		tokens,
		requests,
		tools,
		cost,
		durationMs,
		durationKind: "active",
		contextTokens:
			typeof progress.contextTokens === "number" && Number.isFinite(progress.contextTokens)
				? progress.contextTokens
				: undefined,
		contextWindow:
			typeof progress.contextWindow === "number" && Number.isFinite(progress.contextWindow)
				? progress.contextWindow
				: undefined,
	};
}

function usageTotal(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const source = usage as Record<string, unknown>;
	const explicit = source.totalTokens;
	if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
	const canonical = source.total;
	if (typeof canonical === "number" && Number.isFinite(canonical)) return canonical;
	const orchestration = source.orchestration;
	const orchestrationSource =
		orchestration && typeof orchestration === "object" ? (orchestration as Record<string, unknown>) : undefined;
	const fields = [
		source.input,
		source.output,
		source.cacheRead,
		source.cacheWrite,
		orchestrationSource?.input,
		orchestrationSource?.output,
		orchestrationSource?.cacheRead,
	];
	if (!fields.some(value => typeof value === "number" && Number.isFinite(value))) return undefined;
	return fields.reduce<number>(
		(total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0),
		0,
	);
}

function usageCost(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const cost = (usage as Record<string, unknown>).cost;
	if (!cost || typeof cost !== "object") return 0;
	const total = (cost as Record<string, unknown>).total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function directEntryUsage(entry: unknown): { usage: unknown; assistant: boolean; content?: unknown } | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const source = entry as Record<string, unknown>;
	if (source.type === "model_usage" && source.usage !== undefined) return { usage: source.usage, assistant: false };
	if (source.type !== "message" || !source.message || typeof source.message !== "object") return undefined;
	const message = source.message as Record<string, unknown>;
	return message.role === "assistant" && message.usage !== undefined
		? { usage: message.usage, assistant: true, content: message.content }
		: undefined;
}

function contentToolCalls(content: unknown): number {
	return Array.isArray(content)
		? content.reduce(
				(count, block) =>
					count +
					(block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall" ? 1 : 0),
				0,
			)
		: 0;
}

function readSessionMetrics(session: NonNullable<AgentRecordLike["session"]>): AgentMetrics | undefined {
	try {
		const stats = session.getSessionStats();
		const entries = (
			session as typeof session & { sessionManager?: { getEntries?: () => readonly unknown[] } }
		).sessionManager?.getEntries?.();
		let tokens = 0;
		let requests = 0;
		let tools = 0;
		let cost = 0;
		let sawDirectUsage = false;
		if (entries) {
			for (const entry of entries) {
				const direct = directEntryUsage(entry);
				if (!direct) continue;
				const total = usageTotal(direct.usage);
				if (total === undefined) continue;
				sawDirectUsage = true;
				requests++;
				tokens += total;
				cost += usageCost(direct.usage);
				if (direct.assistant) tools += contentToolCalls(direct.content);
			}
		} else {
			const messages = session.agent?.state?.messages;
			if (Array.isArray(messages)) {
				for (const message of messages) {
					if (message.role !== "assistant") continue;
					const total = usageTotal(message.usage);
					if (total === undefined) continue;
					sawDirectUsage = true;
					requests++;
					tokens += total;
					tools += contentToolCalls(message.content);
					cost += usageCost(message.usage);
				}
			}
		}
		if (!sawDirectUsage && !entries) {
			tokens = usageTotal(stats.tokens) ?? 0;
			requests = stats.assistantMessages;
			tools = stats.toolCalls;
			cost = stats.cost;
		}
		return {
			tokens,
			requests,
			tools,
			cost,
			durationMs: 0,
			durationKind: "unknown",
			contextTokens: stats.contextUsage?.tokens,
			contextWindow: stats.contextUsage?.contextWindow,
		};
	} catch {
		return undefined;
	}
}

export function aggregateMetrics<TRecord extends AgentRecordLike>(args: {
	rows: readonly TRecord[];
	observedById: ReadonlyMap<string, ObservableSession>;
	metricsFor: (ref: TRecord, observed: ObservableSession | undefined) => AgentMetrics | undefined;
	fallbackStatsSession: (
		ref: TRecord,
		observed: ObservableSession | undefined,
	) => NonNullable<AgentRecordLike["session"]> | undefined;
	sessionMetrics: WeakMap<object, { metrics: AgentMetrics | undefined }>;
	refreshFallback: boolean;
}): { metrics: AggregateMetrics; hasFallbackLiveSessions: boolean } {
	const total: AggregateMetrics = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: 0,
		durationKind: "active",
		reportedAgents: 0,
		activeDurationAgents: 0,
	};
	let hasFallbackLiveSessions = false;
	const countedFallbackSessions = new Set<NonNullable<AgentRecordLike["session"]>>();
	for (const ref of args.rows) {
		const observed = args.observedById.get(ref.id);
		const fallbackSession = args.fallbackStatsSession(ref, observed);
		if (fallbackSession) {
			hasFallbackLiveSessions = true;
			if (args.refreshFallback || !args.sessionMetrics.has(fallbackSession)) {
				args.sessionMetrics.set(fallbackSession, { metrics: readSessionMetrics(fallbackSession) });
			}
		}
		const metrics =
			args.metricsFor(ref, observed) ??
			(fallbackSession ? args.sessionMetrics.get(fallbackSession)?.metrics : undefined);
		if (!metrics || (fallbackSession && countedFallbackSessions.has(fallbackSession))) continue;
		if (fallbackSession) countedFallbackSessions.add(fallbackSession);
		total.reportedAgents++;
		total.tokens += finiteMetric(metrics.tokens);
		total.requests += finiteMetric(metrics.requests);
		total.tools += finiteMetric(metrics.tools);
		total.cost += finiteMetric(metrics.cost);
		if (metrics.durationKind === "active") {
			total.durationMs += finiteMetric(metrics.durationMs);
			total.activeDurationAgents++;
		}
	}
	return { metrics: total, hasFallbackLiveSessions };
}

/** Parent-before-child projection preserving the roster's stable sibling order. */
export function projectAgentTree<TRecord extends AgentRecordLike>(
	refs: readonly TRecord[],
): AgentTreeProjection<TRecord> {
	const ids = new Set<string>();
	const operationalIndex = new Map<string, number>();
	for (let i = 0; i < refs.length; i++) {
		ids.add(refs[i].id);
		operationalIndex.set(refs[i].id, i);
	}

	const parentById = new Map<string, string>();
	const children = new Map<string, TRecord[]>();
	for (const ref of refs) {
		const parent =
			ref.parentId && ref.parentId !== MAIN_AGENT_ID && ids.has(ref.parentId) ? ref.parentId : MAIN_AGENT_ID;
		parentById.set(ref.id, parent);
		const siblings = children.get(parent);
		if (siblings) siblings.push(ref);
		else children.set(parent, [ref]);
	}

	// A tree group occupies the position of its earliest operational row.
	// Compute subtree minima iteratively so pathological lineage depth remains stack-safe.
	const subtreeOrder = new Map<string, number>();
	const visiting = new Set<string>();
	const ranked = new Set<string>();
	for (const start of refs) {
		if (ranked.has(start.id)) continue;
		const stack: Array<{ ref: TRecord; expanded: boolean }> = [{ ref: start, expanded: false }];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) continue;
			if (current.expanded) {
				let order = operationalIndex.get(current.ref.id) ?? Number.MAX_SAFE_INTEGER;
				for (const child of children.get(current.ref.id) ?? []) {
					order = Math.min(order, subtreeOrder.get(child.id) ?? Number.MAX_SAFE_INTEGER);
				}
				subtreeOrder.set(current.ref.id, order);
				visiting.delete(current.ref.id);
				ranked.add(current.ref.id);
				continue;
			}
			if (ranked.has(current.ref.id) || visiting.has(current.ref.id)) continue;
			visiting.add(current.ref.id);
			stack.push({ ref: current.ref, expanded: true });
			const descendants = children.get(current.ref.id);
			if (!descendants) continue;
			for (let i = descendants.length - 1; i >= 0; i--) {
				const child = descendants[i];
				if (!ranked.has(child.id) && !visiting.has(child.id)) stack.push({ ref: child, expanded: false });
			}
		}
	}
	for (const siblings of children.values()) {
		siblings.sort(
			(a, b) =>
				(subtreeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (subtreeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
				(operationalIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
					(operationalIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
		);
	}

	const lastSiblingById = new Map<string, boolean>();
	for (const siblings of children.values()) {
		for (let i = 0; i < siblings.length; i++) lastSiblingById.set(siblings[i].id, i === siblings.length - 1);
	}

	const rows: TRecord[] = [];
	const visited = new Set<string>();
	const depthById = new Map<string, number>();
	const visit = (root: TRecord, rootDepth: number): void => {
		const stack: Array<{ ref: TRecord; depth: number }> = [{ ref: root, depth: rootDepth }];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current || visited.has(current.ref.id)) continue;
			visited.add(current.ref.id);
			depthById.set(current.ref.id, current.depth);
			rows.push(current.ref);
			const descendants = children.get(current.ref.id);
			if (!descendants) continue;
			for (let i = descendants.length - 1; i >= 0; i--)
				stack.push({ ref: descendants[i], depth: current.depth + 1 });
		}
	};
	for (const root of children.get(MAIN_AGENT_ID) ?? []) visit(root, 0);
	// Corrupt persisted parent cycles remain visible as roots instead of disappearing.
	for (const ref of refs) visit(ref, 0);
	return { rows, depthById, parentById, lastSiblingById };
}
