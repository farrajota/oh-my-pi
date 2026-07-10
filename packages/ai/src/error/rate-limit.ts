/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;

export type RecoverableLongWindowLimit = {
	recoverable: boolean;
	reason?: "session" | "weekly" | "daily" | "quota-reset" | "provider-cooldown";
	resetAfterMs?: number;
	resetAtMs?: number;
};

const LONG_WINDOW_NEGATIVE_PATTERN =
	/usage_not_included|insufficient.?balance|invalid.?grant|invalid.?auth|unauthori[sz]ed|forbidden|revoked|expired.?token|bad.?credential|context.?length|maximum.?prompt.?length|context.?overflow|too many requests|per.?minute|requests?\s*\/\s*min|overloaded|model.?capacity|resource.?exhausted|internal server error|internal error/i;
const INSUFFICIENT_QUOTA_PATTERN = /insufficient.?quota/i;
const SERVER_STATUS_PATTERN = /\b(?:500|502|503|504|529)\b/;
const SESSION_LIMIT_PATTERN =
	/\b(?:session|5[\s-]*hours?|five[\s-]*hours?)\b[\s\S]{0,80}\b(?:limit|usage|window|reset)\b|\b(?:limit|usage|window|reset)\b[\s\S]{0,80}\b(?:session|5[\s-]*hours?|five[\s-]*hours?)\b/i;
const WEEKLY_LIMIT_PATTERN =
	/\b(?:weekly|week)\b[\s\S]{0,80}\b(?:limit|usage|quota|reset|window)\b|\b(?:limit|usage|quota|reset|window)\b[\s\S]{0,80}\b(?:weekly|week)\b/i;
const DAILY_LIMIT_PATTERN =
	/\b(?:daily|day)\b[\s\S]{0,80}\b(?:limit|usage|quota|reset|window)\b|\b(?:limit|usage|quota|reset|window)\b[\s\S]{0,80}\b(?:daily|day)\b/i;
const RESETTABLE_QUOTA_PATTERN =
	/\b(?:usage_limit_reached|usage.?limit|quota|limit_reached)\b[\s\S]{0,120}\b(?:reset|resets|retry after|try again in|available again|available in)\b|\b(?:reset|resets|retry after|try again in|available again|available in)\b[\s\S]{0,120}\b(?:usage_limit_reached|usage.?limit|quota|limit_reached)\b/i;
const RELATIVE_RESET_PATTERN =
	/\b(?:try again in|retry after|reset(?:s)?(?:\s+after|\s+in)|quota will reset after|available again in|available in)\s+~?\s*((?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b(?:\s*(?:,|and)?\s*(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b)*)/i;
const RELATIVE_DURATION_PART_PATTERN =
	/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi;
const ABSOLUTE_RESET_PATTERN =
	/\b(?:reset(?:s)?|quota will reset|try again|retry)\s+(?:at|on|after)\s+([^\n;]+?)(?=$|[.)\]]\s|[,;]\s)/i;
const EXPLICIT_429_STATUS_PATTERN = /\b429\b/;
const AGGREGATE_PROVIDER_COOLDOWN_PATTERN = /\ball\s+credentials\b[\s\S]{0,120}\bcooling\s+down\b/i;
const PROVIDER_COOLDOWN_MESSAGE_MARKER = "type=model_cooldown";

const WORD_NUMBER_VALUES: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
};

/**
 * Narrow classifier for long-window usage limits that are safe for repeated
 * session-level retry. This intentionally excludes entitlement, auth,
 * per-minute throttles, capacity, and server failures even when they also use
 * generic rate-limit wording.
 */
export function classifyRecoverableLongWindowLimit(input: {
	status?: number;
	message?: string;
	errorId?: number;
	code?: string;
}): RecoverableLongWindowLimit {
	void input.errorId;

	if (input.status === 401 || input.status === 403 || (input.status !== undefined && input.status >= 500)) {
		return { recoverable: false };
	}

	const message = input.message?.trim();
	if (!message) return { recoverable: false };

	if (LONG_WINDOW_NEGATIVE_PATTERN.test(message) || SERVER_STATUS_PATTERN.test(message)) {
		return { recoverable: false };
	}

	if (isAggregateProviderCooldown(input.status, input.code, message)) {
		return { recoverable: true, reason: "provider-cooldown" };
	}

	const resetAfterMs = parseRelativeResetAfterMs(message);
	const resetAtMs = parseAbsoluteResetAtMs(message);
	const hasResetSignal =
		resetAfterMs !== undefined ||
		resetAtMs !== undefined ||
		/\b(?:reset|resets|retry after|try again in|available again|available in)\b/i.test(message);
	const reason = classifyLongWindowReason(message, hasResetSignal);
	if (!reason) return { recoverable: false };

	if (INSUFFICIENT_QUOTA_PATTERN.test(message) && !hasResetSignal) {
		return { recoverable: false };
	}

	return {
		recoverable: true,
		reason,
		...(resetAfterMs !== undefined ? { resetAfterMs } : {}),
		...(resetAtMs !== undefined ? { resetAtMs } : {}),
	};
}

function classifyLongWindowReason(
	message: string,
	hasResetSignal: boolean,
): RecoverableLongWindowLimit["reason"] | undefined {
	if (SESSION_LIMIT_PATTERN.test(message)) return "session";
	if (WEEKLY_LIMIT_PATTERN.test(message)) return "weekly";
	if (DAILY_LIMIT_PATTERN.test(message)) return "daily";
	if (hasResetSignal && RESETTABLE_QUOTA_PATTERN.test(message)) return "quota-reset";
	return undefined;
}

function isAggregateProviderCooldown(status: number | undefined, code: string | undefined, message: string): boolean {
	const has429Status = status === 429 || (status === undefined && EXPLICIT_429_STATUS_PATTERN.test(message));
	return (
		has429Status &&
		AGGREGATE_PROVIDER_COOLDOWN_PATTERN.test(message) &&
		(code === "model_cooldown" || message.includes(PROVIDER_COOLDOWN_MESSAGE_MARKER))
	);
}

function parseRelativeResetAfterMs(message: string): number | undefined {
	const match = RELATIVE_RESET_PATTERN.exec(message);
	if (!match) return undefined;
	const durationText = match[1];
	if (!durationText) return undefined;

	let totalMs = 0;
	RELATIVE_DURATION_PART_PATTERN.lastIndex = 0;
	for (const part of durationText.matchAll(RELATIVE_DURATION_PART_PATTERN)) {
		const valueText = part[1];
		const unit = part[2];
		if (!valueText || !unit) continue;

		const value = parseDurationValue(valueText);
		if (value === undefined) continue;

		const normalizedUnit = unit.toLowerCase();
		if (normalizedUnit.startsWith("d")) totalMs += value * 24 * 60 * 60 * 1000;
		else if (normalizedUnit.startsWith("h")) totalMs += value * 60 * 60 * 1000;
		else totalMs += value * 60 * 1000;
	}

	return Number.isFinite(totalMs) && totalMs > 0 ? totalMs : undefined;
}

function parseDurationValue(value: string): number | undefined {
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	return WORD_NUMBER_VALUES[value.toLowerCase()];
}

function parseAbsoluteResetAtMs(message: string): number | undefined {
	const match = ABSOLUTE_RESET_PATTERN.exec(message);
	if (!match) return undefined;
	const timestampText = match[1];
	if (!timestampText) return undefined;

	const candidate = timestampText.trim().replace(/[.)\]]+$/, "");
	if (
		!/(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})|\b(?:UTC|GMT)\b)/i.test(
			candidate,
		)
	) {
		return undefined;
	}

	const timestamp = Date.parse(candidate);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: QUOTA (Antigravity "quota will reset") > MODEL_CAPACITY > QUOTA (account) >
 * RATE_LIMIT > QUOTA (generic) > SERVER_ERROR > UNKNOWN.
 *
 * "resource exhausted" maps to MODEL_CAPACITY (transient, short wait)
 * "quota exceeded" / "quota will reset" maps to QUOTA_EXHAUSTED (long wait, switch account)
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lower = errorMessage.toLowerCase();

	// Antigravity / Cloud Code Assist surface multi-hour daily-quota exhaustion as
	// "You have exhausted your capacity on this model. Your quota will reset after …".
	// The literal "capacity" used to pre-empt the QUOTA branch even though "quota
	// will reset" is the long-wait signal — short-circuit here before the
	// MODEL_CAPACITY fallthrough so credential rotation (not 60s backoff) kicks in.
	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("capacity") ||
		lower.includes("overloaded") ||
		lower.includes("529") ||
		lower.includes("503") ||
		lower.includes("resource exhausted")
	) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		// xAI SuperGrok: HTTP 403 "run out of credits" / spending-limit is an
		// account-local cap — rotate, don't treat as auth failure.
		lower.includes("run out of credits") ||
		lower.includes("out of credits") ||
		lower.includes("spending-limit") ||
		lower.includes("spending limit") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked/i;

/**
 * HTTP status codes that, absent richer body classification, represent an
 * account-local usage cap rather than a bad credential or a transient blip.
 * Always combine with {@link isUsageLimitOutcome} when a message is available
 * — a 429 carrying transient rate-limit wording is NOT a usage cap.
 */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429;
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account. Decision tree:
 *
 *  1. Body matches {@link isUsageLimitError} (Codex `usage_limit_reached`,
 *     Anthropic account rate-limit, Google `resource_exhausted`, OpenAI
 *     `insufficient_quota`, …) → rotate.
 *  2. Status is not 429 → backoff (caller's domain).
 *  3. Body is absent or {@link isOpaqueStatusBody opaque} (just the status,
 *     empty JSON, HTTP framing only) → rotate conservatively: the server
 *     gave us nothing else to go on.
 *  4. Body has content → defer to {@link parseRateLimitReason}. Only
 *     `QUOTA_EXHAUSTED` rotates; `RATE_LIMIT_EXCEEDED` (`Too many requests`,
 *     per-minute caps), `MODEL_CAPACITY_EXHAUSTED` (`Service overloaded`),
 *     `SERVER_ERROR`, and `UNKNOWN` (`Please retry in 5s`) stay in the
 *     provider's own backoff layer so transient 429s don't burn sibling
 *     credentials.
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	if (message && matchesUsageLimitText(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	return parseRateLimitReason(message) === "QUOTA_EXHAUSTED";
}

/**
 * A 429 body is opaque when it carries no signal beyond the status itself —
 * empty, whitespace-only, the status digits with HTTP/JSON framing, or
 * generic punctuation. Anything else (retry hints, capacity wording, error
 * descriptions) is informative enough to defer to the classifier.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b429\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");
	return !/[a-z\d]{3,}/i.test(cleaned);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. NOT part of the public
 * API — callers classify through {@link import("./flags").isUsageLimit} (the
 * flag accessor). `flags.ts` consumes this to populate `Flag.UsageLimit`, and
 * {@link isUsageLimitOutcome} uses it for the account-rotation decision.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	return USAGE_LIMIT_PATTERN.test(errorMessage) || ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage);
}
