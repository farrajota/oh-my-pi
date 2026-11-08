/**
 * The fork's `task/permission-profiles` entry, kept for extensions that import it (the user's
 * activity dashboard): it normalizes an untrusted summary and formats the lines the Agent Hub shows.
 */
import { describe, expect, it } from "bun:test";
import {
	formatEffectivePermissionSummaryLines,
	normalizeEffectivePermissionSummary,
} from "@oh-my-pi/pi-coding-agent/task/permission-profiles";
import { buildPermissionSummary } from "@oh-my-pi/pi-coding-agent/task/permissions/summary";
import type { EffectivePermissionSummary } from "@oh-my-pi/pi-wire";
import { enforceScope } from "./scope-fixtures";

describe("task/permission-profiles compatibility entry", () => {
	const summary: EffectivePermissionSummary = buildPermissionSummary(
		enforceScope({
			profiles: ["read-only", "no-network"],
			tools: ["read", "grep"],
			guardrails: { noNetwork: true, secretsBlind: false },
		}),
	);

	it("normalizes a summary as the hub and collab guest do, refusing a malformed one", () => {
		expect(normalizeEffectivePermissionSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
		expect(normalizeEffectivePermissionSummary({ mode: "enforce" })).toBeUndefined();
		expect(normalizeEffectivePermissionSummary(undefined)).toBeUndefined();
	});

	it("formats the Agent Hub's lines for a summary", () => {
		expect(formatEffectivePermissionSummaryLines(summary)).toEqual([
			"Permissions: mode enforce",
			"Profiles: read-only, no-network",
			"Guardrails: no network",
		]);
	});

	it("formats only the mode for a scope without profiles or guardrails", () => {
		const bare = buildPermissionSummary(enforceScope({ mode: "suggest", tools: ["read"] }));
		expect(formatEffectivePermissionSummaryLines(bare)).toEqual(["Permissions: mode suggest"]);
	});
});
