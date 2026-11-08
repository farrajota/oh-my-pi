/**
 * Subagent permission profiles.
 *
 * Threat model: the scope is a set of guardrails, not a sandbox. It decides each tool call, filters what
 * searches, listings and internal URLs show, and keeps unprovable tools and extension code out of a
 * restricted child. It does not filter these channels:
 * - memory recall: `recall`, `reflect` and the memory backends return what any agent stored, which the
 *   scope's path rules and secrets-blind never see (only a `memory://` URL that resolves to a file is
 *   checked);
 * - races: a path is checked when the call is approved or the result is produced, so another process
 *   that swaps it in between is not caught.
 * The PERMISSIONS prompt block must say the same.
 */
export * from "./compose";
export * from "./evaluate";
export * from "./guardrails";
export * from "./path-rules";
export * from "./profiles";
export * from "./snapshot";
export * from "./tool-names";
export * from "./tool-profiles";
export * from "./types";
