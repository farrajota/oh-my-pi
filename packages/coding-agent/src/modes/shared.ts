import type { TabBarTheme } from "@oh-my-pi/pi-tui";
import { theme } from "./theme/theme";

export { sanitizeStatusText } from "./sanitize-status-text";

/** Render the current terminal-specific escape hint used by the working loader. */
export function interruptHint(): string {
	return ` ${theme.format.bracketLeft}esc${theme.format.bracketRight}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Bar Theme
// ═══════════════════════════════════════════════════════════════════════════

/** Shared tab bar theme used by fullscreen overlays (settings, agent hub). */
export function getTabBarTheme(): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg("accent", text)),
		activeTab: (text: string) => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
		inactiveTab: (text: string) => theme.fg("muted", text),
		mutedTab: (text: string) => theme.fg("dim", text),
		hoverTab: (text: string) => theme.bg("selectedBg", theme.fg("text", text)),
		hint: (text: string) => theme.fg("dim", text),
	};
}

export { parseCommandArgs } from "../utils/command-args";
