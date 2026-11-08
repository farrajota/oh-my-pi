/**
 * The lines that show a subagent's permission scope: the Agent Hub inspector renders them, and
 * extensions get them through coding-agent's `task/permission-profiles` entry.
 */
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { BoundedList, EffectivePermissionSummary } from "@oh-my-pi/pi-wire";
import { truncateToWidth } from "../render/render-utils";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";

function boundedNames(list: BoundedList<string>, width: number): string {
	const names = list.items.map(name => truncateToWidth(sanitizeDisplaySingleLine(name), width)).filter(Boolean);
	const omitted = list.omittedCount > 0 ? ` (+${formatNumber(list.omittedCount)} omitted)` : "";
	return `${names.join(", ")}${omitted}`;
}

/**
 * The active permission scope as display lines: the mode, then the profiles and the guardrails when
 * there are any. None for an unscoped agent.
 */
export function formatPermissionSummaryLines(summary: EffectivePermissionSummary | undefined): string[] {
	if (!summary) return [];
	const lines = [`Permissions: mode ${summary.mode}`];
	if (summary.profiles.items.length > 0 || summary.profiles.omittedCount > 0) {
		lines.push(`Profiles: ${boundedNames(summary.profiles, 40)}`);
	}
	const guardrails = [
		...(summary.guardrails.noNetwork ? ["no network"] : []),
		...(summary.guardrails.secretsBlind ? ["secrets blind"] : []),
	];
	if (guardrails.length > 0) lines.push(`Guardrails: ${guardrails.join(", ")}`);
	return lines;
}
