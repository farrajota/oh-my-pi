/** Default number of terminal output rows shown before expansion. */
export const DEFAULT_TERMINAL_PREVIEW_LINES = 10;

/** Preview limits shared by tool renderers without importing the TUI utility graph. */
export const PREVIEW_LIMITS = {
	COLLAPSED_LINES: 3,
	EXPANDED_LINES: 12,
	COLLAPSED_ITEMS: 8,
	OUTPUT_COLLAPSED: 3,
	OUTPUT_EXPANDED: 10,
	COMPUTER_CODE_COLLAPSED: 10,
	DIFF_COLLAPSED_HUNKS: 8,
	DIFF_COLLAPSED_LINES: 40,
} as const;
