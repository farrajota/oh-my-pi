import type { Usage } from "@oh-my-pi/pi-ai";
import { formatContextUsage } from "../chrome/context-thresholds";
import {
	FEED_MODEL_BADGE_WIDTH,
	formatBadge,
	formatDuration,
	formatFeedModelBadge,
	formatNumber,
	formatStatusIcon,
	isFeedModelBadgeEnabled,
	truncateToWidth,
	type ConfiguredThinkingLevel,
} from "../render/render-utils";
import { theme as defaultTheme, type Theme, type ThemeColor } from "../theme/theme";
import { visibleWidth } from "../utils";

/** Host-resolved role metadata shared by task rows and Agent Hub. */
export interface AgentRoleDisplay {
	color?: ThemeColor;
	tag?: string;
	name?: string;
}

/** Format a role label without importing coding-agent settings into the TUI. */
export function formatRoleBadge(role: string, info: AgentRoleDisplay = {}, targetTheme: Theme = defaultTheme): string {
	const label = (info.tag ?? info.name ?? role).replace(/[\r\n]+/g, " ");
	return targetTheme.fg(info.color ?? "muted", label);
}

/** Format token counts for compact metadata cells. */
export function formatCompactTokens(value: number | undefined): string {
	const amount = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
	if (amount < 1000) return String(Math.floor(amount));
	if (amount < 1_000_000) return `${(amount / 1000).toFixed(1)}k`;
	return `${(amount / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** Format a dollar amount with enough precision to keep low costs visible. */
export function formatCost(cost: number | undefined): string {
	const amount = typeof cost === "number" && Number.isFinite(cost) ? Math.max(0, cost) : 0;
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3)}`;
	return `$${amount.toFixed(2)}`;
}

/** Format elapsed milliseconds for a row. */
export function formatElapsed(elapsedMs: number | undefined, nowMs?: number): string {
	const value = nowMs === undefined ? elapsedMs : elapsedMs === undefined ? undefined : nowMs - elapsedMs;
	const elapsed = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
	return elapsed > 0 ? formatDuration(elapsed).replace(/([a-z]+)(?=\d)/g, "$1 ") : "0s";
}

/** Compact a resolved `provider/model` identity without misreading colons inside model ids. */
export function formatAgentModel(model: string | undefined, targetTheme: Theme = defaultTheme): string {
	if (!model) return "—";
	const clean = model.replace(/[\r\n]+/g, " ");
	const slash = clean.indexOf("/");
	return targetTheme.fg("muted", slash >= 0 ? clean.slice(slash + 1) : clean);
}
export interface AgentRowMetadata {
	id?: string;
	model?: string;
	role?: string;
	elapsedMs?: number;
	startedAtMs?: number;
	nowMs?: number;
	usage?: Usage;
	cost?: number;
}

/** Render metadata cells in the order shared by task rows and Agent Hub. */
export function formatRowMetadata(
	metadata: AgentRowMetadata,
	targetTheme: Theme = defaultTheme,
	stats?: AgentStats,
): string {
	const elapsedMs =
		metadata.elapsedMs ??
		(metadata.startedAtMs !== undefined
			? Math.max(0, (metadata.nowMs ?? Date.now()) - metadata.startedAtMs)
			: undefined);
	const input = (metadata.usage?.input ?? 0) + (metadata.usage?.cacheWrite ?? 0);
	const output = metadata.usage?.output ?? 0;
	const cost = metadata.usage?.cost?.total ?? metadata.cost ?? stats?.cost;
	const cells = [
		...(metadata.id ? [metadata.id] : []),
		formatAgentModel(metadata.model, targetTheme),
		metadata.role ?? "—",
		formatElapsed(elapsedMs),
		`${formatCompactTokens(input)} in`,
		`${formatCompactTokens(output)} out`,
		...(stats ? formatAgentStatCells({ ...stats, cost: undefined }, targetTheme) : []),
		formatCost(cost),
	];
	return cells.join(targetTheme.sep.dot);
}

/** Descriptive alias for consumers that prefer the agent-specific name. */
export const formatAgentRowMetadata = formatRowMetadata;

/** Counters displayed alongside an agent name. */
export interface AgentStats {
	toolCount?: number;
	requests?: number;
	contextTokens?: number;
	contextWindow?: number;
	cost?: number;
}

function formatAgentStatCells(stats: AgentStats, theme: Theme): string[] {
	const cells: string[] = [];
	if (stats.toolCount) {
		cells.push(theme.fg("dim", `${formatNumber(stats.toolCount)} ${theme.icon.extensionTool}`));
	}
	if (stats.requests) {
		cells.push(theme.fg("dim", `${formatNumber(stats.requests)} req`));
	}
	if (stats.contextTokens && stats.contextTokens > 0) {
		const context =
			stats.contextWindow && stats.contextWindow > 0
				? formatContextUsage((stats.contextTokens / stats.contextWindow) * 100, stats.contextWindow)
				: formatNumber(stats.contextTokens);
		cells.push(theme.fg("dim", context));
	}
	if (stats.cost && stats.cost > 0) {
		cells.push(theme.fg("statusLineCost", `$${stats.cost.toFixed(2)}`));
	}
	return cells;
}

/** Format the shared tool-count, request, context, and cost stat run. */
export function formatAgentStatRun(stats: AgentStats, theme: Theme): string {
	return formatAgentStatCells(stats, theme)
		.map(cell => `${theme.sep.dot}${cell}`)
		.join("");
}

/** Tool-specific presentation layered onto a bounded agent progress row. */
export interface AgentTreeRowOptions {
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	presentation: "task" | "eval";
	prefix: string;
	id: string;
	width: number;
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	advisor?: boolean;
	spinnerFrame?: number;
	frozen?: boolean;
	roleBadge?: string;
	statusBadge?: string;
	description?: string;
	preview?: string;
	stats?: AgentStats;
	durationMs?: number;
	metadata?: AgentRowMetadata;
}

/** Render an agent row while reserving its identifier and required status badges. */
export function renderAgentTreeRow(
	options: AgentTreeRowOptions,
	theme: Theme,
): { line: string; descriptionShown: boolean } {
	const { status, width, description } = options;
	const task = options.presentation === "task";
	const live = status === "pending" || status === "running";
	const failed = status === "failed" || status === "aborted";
	const iconColor = status === "completed" ? "success" : failed ? "error" : "accent";
	const nameColor = task && live && options.frozen ? "dim" : task && status === "completed" ? "text" : "accent";
	const iconStatus = status === "failed" ? "error" : status === "completed" ? "done" : status;
	const icon =
		task && status === "completed"
			? theme.styledSymbol("status.done", nameColor)
			: !task && status === "completed"
				? theme.styledSymbol("tool.eval", "accent")
				: theme.fg(
						iconColor,
						formatStatusIcon(iconStatus, theme, status === "running" ? options.spinnerFrame : undefined),
					);
	const lead = `${options.prefix}${options.prefix || !task ? " " : ""}${icon} `;
	const statusBadge = options.statusBadge ?? (failed ? ` ${formatBadge(status, iconColor, theme)}` : "");
	const id = Number.isFinite(width)
		? truncateToWidth(options.id, Math.max(0, width - visibleWidth(lead) - visibleWidth(statusBadge)))
		: options.id;
	const roleBadge = options.roleBadge ?? "";
	const badges = `${roleBadge}${statusBadge}`;
	const modelWidth = width - visibleWidth(lead) - visibleWidth(id) - visibleWidth(badges) - 1;
	const model =
		(options.metadata || isFeedModelBadgeEnabled()) && (task || options.model)
			? formatFeedModelBadge(
					options.model,
					options.thinkingLevel,
					options.advisor,
					theme,
					Math.min(FEED_MODEL_BADGE_WIDTH, task ? Math.max(0, modelWidth) : modelWidth),
				)
			: "";
	const metadata = options.metadata
		? formatRowMetadata(
				{
					...options.metadata,
					model: options.metadata.model ?? options.model,
					role: options.metadata.role ?? roleBadge,
				},
				theme,
				options.stats,
			)
		: undefined;
	const modelLead = model ? `${model} ` : "";
	const descriptionShown = Boolean(
		!metadata && description && visibleWidth(`${lead}${id}: ${description}${modelLead}${badges}`) <= width,
	);
	let title = descriptionShown ? `${theme.bold(id)}: ${description}` : task ? id : theme.bold(id);
	if (task && live && descriptionShown) {
		title = `${theme.fg(nameColor, theme.bold(id))}${theme.fg(nameColor, ":")} ${theme.fg(nameColor, description!)}`;
	} else {
		title = theme.fg(nameColor, title);
	}
	let line = metadata
		? `${lead}${title}`
		: `${lead}${task ? `${title}${modelLead}` : `${modelLead}${title}`}${badges}`;
	if (options.preview && !metadata) line += options.preview;
	if (!metadata && options.stats) line += formatAgentStatRun(options.stats, theme);
	if (!metadata && options.durationMs !== undefined && options.durationMs > 0) {
		line += `${theme.sep.dot}${theme.fg("dim", formatDuration(options.durationMs))}`;
	}
	if (metadata) {
		if (!Number.isFinite(width)) {
			line += `${theme.sep.dot}${metadata}`;
		} else {
			const metadataWidth = width - visibleWidth(line) - visibleWidth(theme.sep.dot) - visibleWidth(statusBadge);
			if (metadataWidth > 0) {
				const boundedMetadata = truncateToWidth(metadata, metadataWidth, "");
				if (boundedMetadata) line += `${theme.sep.dot}${boundedMetadata}`;
			}
		}
		line += statusBadge;
	}
	return { line: Number.isFinite(width) ? truncateToWidth(line, width, "") : line, descriptionShown };
}
