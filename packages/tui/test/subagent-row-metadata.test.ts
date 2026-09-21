import { beforeAll, describe, expect, test } from "bun:test";
import { formatCompactTokens, formatCost, formatRoleBadge, formatRowMetadata } from "../src/tools";
import { renderAgentTreeRow } from "../src/tools/agent-tree";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

describe("subagent row metadata", () => {
	test("formats compact token boundaries deterministically", () => {
		expect(formatCompactTokens(0)).toBe("0");
		expect(formatCompactTokens(999)).toBe("999");
		expect(formatCompactTokens(1_000)).toBe("1.0k");
		expect(formatCompactTokens(31_200)).toBe("31.2k");
		expect(formatCompactTokens(999_999)).toBe("1000.0k");
		expect(formatCompactTokens(1_000_000)).toBe("1m");
	});

	test("renders model role time usage and cost in the requested order", () => {
		const role = formatRoleBadge("task", { tag: "TASK", color: "accent" }, theme);
		const row = Bun.stripANSI(
			formatRowMetadata(
				{
					id: "SubagentTuiHistory",
					model: "cliproxy-codex/gpt-5.6-luna",
					role,
					elapsedMs: 109_000,
					usage: {
						input: 30_000,
						output: 4_800,
						cacheRead: 7_000,
						cacheWrite: 1_200,
						totalTokens: 43_000,
						cost: { input: 0.02, output: 0.02, cacheRead: 0, cacheWrite: 0.0021, total: 0.0421 },
					},
				},
				theme,
			),
		);
		expect(row).toBe("SubagentTuiHistory · gpt-5.6-luna · TASK · 1m 49s · 31.2k in · 4.8k out · $0.042");
	});

	test("formats low costs at threshold precision", () => {
		expect(formatCost(0.0421)).toBe("$0.042");
		expect(formatCost(0.00421)).toBe("$0.0042");
	});

	test("animates running task rows and reserves done for completed rows", () => {
		const base = {
			presentation: "task" as const,
			prefix: "",
			id: "Worker",
			width: 120,
			metadata: { model: "provider/model", role: "TASK", elapsedMs: 1_000 },
		};
		const frame0 = Bun.stripANSI(renderAgentTreeRow({ ...base, status: "running", spinnerFrame: 0 }, theme).line);
		const frame1 = Bun.stripANSI(renderAgentTreeRow({ ...base, status: "running", spinnerFrame: 1 }, theme).line);
		const completed = Bun.stripANSI(renderAgentTreeRow({ ...base, status: "completed" }, theme).line);
		expect(frame0).not.toBe(frame1);
		expect(frame0).not.toStartWith(`${theme.status.done} `);
		expect(completed).toStartWith(`${theme.status.done} `);
	});
});
