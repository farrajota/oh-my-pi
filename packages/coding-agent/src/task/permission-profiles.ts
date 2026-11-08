/**
 * Compatibility entry for extensions written against the fork's `task/permission-profiles` module
 * (the activity dashboard). It only re-exports the display helpers; the permission engine lives in
 * `task/permissions/`.
 */
import type { EffectivePermissionSummary } from "@oh-my-pi/pi-wire";
import { formatPermissionSummaryLines } from "@oh-my-pi/pi-tui/overlays/permission-summary";
import { normalizePermissionSummary } from "./permissions/summary";

/** Re-own an untrusted permission summary; `undefined` when it is malformed. */
export const normalizeEffectivePermissionSummary = normalizePermissionSummary;

/** The lines the Agent Hub shows for a permission summary. */
export function formatEffectivePermissionSummaryLines(summary: EffectivePermissionSummary): string[] {
	return formatPermissionSummaryLines(summary);
}
