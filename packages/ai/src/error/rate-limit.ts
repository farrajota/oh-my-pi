import { extractRetryHint } from "@oh-my-pi/pi-utils/fetch-retry";

/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "INSUFFICIENT_G1_CREDITS_BALANCE"
	| "RATE_LIMIT_EXCEEDED"
	| "CONCURRENT_LIMIT"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const CONCURRENT_LIMIT_BACKOFF_MS = 5 * 1000; // 5s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
// Prepaid-credit exhaustion phrased around the credit balance rather than a
// quota: Anthropic "This request would exceed your available credits given
// your current in-flight requests" (402), OpenRouter "Insufficient credits",
// "credits exhausted". Account-local, so rotate to a sibling credential.
const CREDITS_EXHAUSTED_PATTERN =
	/\b(?:exceed\w*|insufficient|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b/i;
const SPEND_LIMIT_PATTERN = /spend.?limit/i;
const SUBSCRIPTION_CAP_PATTERN =
	/\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;
const TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN = /\bper\s+(?:second|minute)\b/i;

function matchesSubscriptionCapText(errorMessage: string): boolean {
	return SUBSCRIPTION_CAP_PATTERN.test(errorMessage) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(errorMessage);
}
const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;
// ClinePass subscription-window exhaustion ("clinepass limit …") and free-tier
// model caps ("free limit reached on model … try again in …") are account-local
// quota exhaustion, not per-minute rate limiting.
const CLINE_PASS_QUOTA_PATTERN = /clinepass limit|free limit reached on model/i;
// gRPC/Connect end-streams carry the status as its name (`resource_exhausted`),
// while HTTP bodies use the phrase ("resource exhausted"). Strip either form
// before classifying explicit details; an otherwise opaque status is transient
// model capacity, while quota/rate-limit/server wording remains authoritative.
const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/gi;
const CONCURRENT_LIMIT_PATTERN =
	// Require an actual cap signal near "concurrent". "Too many concurrent
	// requests" is itself a cap signal; bare feature rejections such as
	// "concurrent invocation is not supported" remain excluded.
	/\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b|\bconcurren[a-z]*[-_](?:[a-z]+[_-])*(?:limit|quota|exceed\w*|reach\w*)/i;
const ACCOUNT_SCOPED_403_PATTERN =
	// The bare "limit will reset" / "will reset in" phrasing also appears on
	// statusless per-minute transients ("Rate limit will reset in 30 seconds"),
	// so gate the reset-window alternative on account-specific wording (Devin's
	// "Your limit will reset in …"); the overall/account qualifiers arm above
	// already covers the rest.
	/\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;
// Simplified Chinese account-quota exhaustion phrasing. Zhipu Coding Plan
// returns e.g. "429 已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。"
// (type=1308) when the 5h window is spent; other CN providers use 额度已用完 /
// 配额已耗尽 / 余额不足. These are persistent account-local caps that must
// rotate to a sibling credential, not transient rate limits, so they are
// matched before the RATE_LIMIT_EXCEEDED branch. The 上限 arm is anchored on
// the 使用 token: a rate/concurrency cap phrased as 每分钟请求数已达上限 /
// 并发请求数已达上限 / 速率达到上限 (no 使用) must NOT match, or it would burn a
// healthy sibling credential as a false quota. "速率限制" is absent for the
// same reason.
const CN_QUOTA_EXHAUSTED_PATTERN = /使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;
// Simplified Chinese rate/concurrency caps can contain both 使用 and 上限, but
// remain transient rather than account quota exhaustion.
const CN_TRANSIENT_CAP_PATTERN =
	/速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;
// Common Simplified Chinese throttle phrasing. Consulted by
// isOpaqueStatusBody so CN transients stay in the provider backoff lane instead
// of rotating through the opaque-429 fallback.
const CN_THROTTLE_PATTERN = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/;
// DashScope / Bailian (Alibaba Model Studio) reports its per-minute token
// throttle (429 Throttling.AllocationQuota, type `insufficient_quota`) with
// OpenAI-compatible billing wording — "You exceeded your current quota,
// please check your plan and billing details. … (type=insufficient_quota
// param=insufficient_quota)" — and links the error-code doc's `token-limit`
// anchor. Per that doc section the error is a transient TPM/TPS cap that
// clears within the minute window, not an account-local quota exhaustion.
// The same doc anchor also covers permanent errors such as "Free allocated
// quota exceeded", so require both the anchor and the exact throttle wording.
// The identical wording WITHOUT the anchor stays quota-exhausted (OpenAI's
// real account-quota error uses the same sentence).
const DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN = /error-code[^()\s]*#token-limit/i;
const DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN =
	/\byou exceeded your current quota, please check your plan and billing details\b/i;
/** True for DashScope/Bailian's documented OpenAI-compatible TPM/TPS throttle. */
export function isDashScopeTokenLimitText(errorMessage: string): boolean {
	return (
		DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN.test(errorMessage) && DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN.test(errorMessage)
	);
}

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

const GOOGLE_RPC_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const ANTIGRAVITY_MODEL_QUOTA_PATTERN = /\bexhausted your capacity on this model\b/i;
const LONG_RATE_LIMIT_DELAY_MS = 5 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseJsonBody(errorMessage: string): Record<string, unknown> | undefined {
	const start = errorMessage.indexOf("{");
	const end = errorMessage.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	try {
		const parsed: unknown = JSON.parse(errorMessage.slice(start, end + 1));
		return asRecord(parsed);
	} catch {
		return undefined;
	}
}

/**
 * Classify structured Google RESOURCE_EXHAUSTED bodies before consulting text.
 * Cloud Code Assist prefixes the JSON with its HTTP error label, so accept an
 * embedded top-level object as well as a raw JSON body.
 */
function parseGoogleRpcRateLimitReason(errorMessage: string): RateLimitReason | undefined {
	const body = parseJsonBody(errorMessage);
	const error = asRecord(body?.error);
	if (typeof error?.status !== "string" || error.status.trim().toUpperCase() !== "RESOURCE_EXHAUSTED") {
		return undefined;
	}
	if (!Array.isArray(error.details)) return undefined;

	for (const value of error.details) {
		const detail = asRecord(value);
		if (detail?.["@type"] !== GOOGLE_RPC_ERROR_INFO_TYPE || typeof detail.reason !== "string") continue;
		const reason = detail.reason.trim().toUpperCase();
		switch (reason) {
			case "QUOTA_EXHAUSTED":
				return "QUOTA_EXHAUSTED";
			case "INSUFFICIENT_G1_CREDITS_BALANCE":
				// Keep Google's specific credit-balance reason available to logs
				// and callers while treating it as credential-rotatable below.
				return "INSUFFICIENT_G1_CREDITS_BALANCE";
			case "RATE_LIMIT_EXCEEDED": {
				// Cloud Code Assist also uses this reason for an account's
				// per-model quota, even when that quota resets within seconds.
				if (typeof error.message === "string" && ANTIGRAVITY_MODEL_QUOTA_PATTERN.test(error.message)) {
					return "QUOTA_EXHAUSTED";
				}
				const retryDelayMs = extractRetryHint(undefined, errorMessage);
				return retryDelayMs !== undefined && retryDelayMs >= LONG_RATE_LIMIT_DELAY_MS
					? "QUOTA_EXHAUSTED"
					: "RATE_LIMIT_EXCEEDED";
			}
		}
	}
	return undefined;
}

function isQuotaExhaustedReason(reason: RateLimitReason): boolean {
	return reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE";
}

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: explicit details in a resource-exhausted error > QUOTA
 * (Antigravity "quota will reset") > CN quota > DASHSCOPE_TOKEN_LIMIT (TPM/TPS
 * throttle) > CONCURRENT_LIMIT > MODEL_CAPACITY > QUOTA (account) > RATE_LIMIT >
 * QUOTA (generic) > SERVER_ERROR > bare resource-exhausted > UNKNOWN.
 *
 * Bare "resource exhausted" / "resource_exhausted" maps to MODEL_CAPACITY (transient, short wait).
 * Explicit details such as "quota exceeded" retain their normal classification.
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
	if (structuredReason !== undefined) return structuredReason;
	const lowerWithStatus = errorMessage.toLowerCase();
	const lower = lowerWithStatus.replace(RESOURCE_EXHAUSTED_PATTERN, "");
	const hasResourceExhaustedStatus = lower !== lowerWithStatus;

	// Antigravity / Cloud Code Assist surface multi-hour daily-quota exhaustion as
	// "You have exhausted your capacity on this model. Your quota will reset after …".
	// The literal "capacity" used to pre-empt the QUOTA branch even though "quota
	// will reset" is the long-wait signal — short-circuit here before the
	// MODEL_CAPACITY fallthrough so credential rotation (not 60s backoff) kicks in.
	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	// Simplified Chinese quota-exhaustion phrasing (Zhipu Coding Plan and other
	// CN providers). Must precede the MODEL_CAPACITY / RATE_LIMIT branches so an
	// account-local cap rotates instead of backing off as a transient.
	if (CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	// DashScope/Bailian TPM/TPS throttle: billing-worded like OpenAI's account
	// quota, but the doc anchor marks it a per-minute token cap that clears on
	// its own — short backoff on the same credential, never rotation/block.
	if (isDashScopeTokenLimitText(errorMessage)) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (CONCURRENT_LIMIT_PATTERN.test(errorMessage)) {
		return "CONCURRENT_LIMIT";
	}

	if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (SPEND_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (matchesSubscriptionCapText(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (CLINE_PASS_QUOTA_PATTERN.test(errorMessage)) {
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
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage) ||
		CREDITS_EXHAUSTED_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	if (hasResourceExhaustedStatus) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "INSUFFICIENT_G1_CREDITS_BALANCE":
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "CONCURRENT_LIMIT":
			return CONCURRENT_LIMIT_BACKOFF_MS;
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
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked|clinepass limit|free limit reached on model/i;

/**
 * HTTP status codes that, absent richer body classification, represent an
 * account-local usage cap rather than a bad credential or a transient blip.
 * HTTP 402 Payment Required represents an account-billing cap (xAI
 * Grok Build "usage balance exhausted", DeepSeek "Insufficient Balance",
 * OpenRouter credit exhaustion) when opaque, payment/deactivation/balance-worded,
 * or QUOTA_EXHAUSTED/CONCURRENT_LIMIT, while informative non-quota 402s (e.g.
 * endpoint subscription requirements) remain non-usage-limits. Always combine
 * with {@link isUsageLimitOutcome} when a message is available.
 */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}
const STATUS_402_QUOTA_PATTERN =
	/\b(?:payment(?:\s+is)?[-_.\s]*required|deactivated_workspace|insufficient.?balance)\b/i;

export function is402BillingCapBody(message: string | undefined): boolean {
	if (message === undefined || isOpaqueStatusBody(message)) return true;
	if (STATUS_402_QUOTA_PATTERN.test(message)) return true;
	const reason = parseRateLimitReason(message);
	return isQuotaExhaustedReason(reason) || reason === "CONCURRENT_LIMIT";
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account. Decision tree:
 *
 *  1. Body matches {@link isUsageLimitError} (Codex `usage_limit_reached`,
 *     Anthropic account rate-limit, Google `resource_exhausted`, OpenAI
 *     `insufficient_quota`, …) → rotate.
 *  2. Status is not a usage-limit status (429/402) → backoff (caller's domain).
 *  3. Body is absent or {@link isOpaqueStatusBody opaque} (just the status,
 *     empty JSON, HTTP framing only) → rotate conservatively: the server
 *     gave us nothing else to go on.
 *  4. Body has content → defer to {@link parseRateLimitReason}. `QUOTA_EXHAUSTED`
 *     rotates; for a 402 status a `CONCURRENT_LIMIT` body also rotates (the cap
 *     is concurrent-worded but the status is an exhausted billing cap).
 *     `RATE_LIMIT_EXCEEDED` (`Too many requests`, per-minute caps),
 *     `MODEL_CAPACITY_EXHAUSTED` (`Service overloaded`), `SERVER_ERROR`, and
 *     `UNKNOWN` (e.g. "A subscription is required for this endpoint" or
 *     "Please retry in 5s") stay in the provider's own backoff / failure
 *     layer so transient or non-quota responses don't burn sibling credentials.
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	const structuredReason = message ? parseGoogleRpcRateLimitReason(message) : undefined;
	if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (message && matchesUsageLimitText(message)) return true;
	// A 403 is normally an auth failure, but several providers deliver an
	// account-scoped cap with it (Devin/Codeium Connect `permission_denied`,
	// GitHub Copilot). Devin's end-of-stream Connect trailer carries no HTTP
	// status at all (it arrives as a `permission_denied` ValidationError), so
	// accept an undefined status too — but only when the body names a cap that
	// resets, never on a bare 403, which stays an auth failure.
	if ((status === 403 || status === undefined) && message && isAccountScopedCapText(message)) return true;
	if (status === 402 && is402BillingCapBody(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	const reason = parseRateLimitReason(message);
	return isQuotaExhaustedReason(reason);
}
/**
 * A usage-limit status body is opaque when it carries no signal beyond the
 * status itself — empty, whitespace-only, the status digits with HTTP/JSON
 * framing, or generic punctuation. Anything else (retry hints, capacity
 * wording, error descriptions) is informative enough to defer to the
 * classifier.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:429|402)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "")
		.replace(/\(?\bno body\b\)?/gi, "");
	// A body is informative when the text classifier can act on it. Any Latin
	// word or Simplified Chinese phrasing the classifier recognizes (quota
	// exhaustion or a throttle) defers to parseRateLimitReason; a body that
	// is only status digits / HTTP framing is opaque and rotates conservatively.
	// A Han-only body the classifier cannot interpret (e.g. Japanese Kanji
	// quota text, since Japanese is out of scope) must stay opaque so the
	// opaque-429 fallback still rotates. This keeps the exception scoped to
	// text we actually classify, rather than to any Han ideograph.
	return (
		!/[a-z\d]{3,}/i.test(cleaned) &&
		!CN_QUOTA_EXHAUSTED_PATTERN.test(cleaned) &&
		!CN_TRANSIENT_CAP_PATTERN.test(cleaned) &&
		!CN_THROTTLE_PATTERN.test(cleaned)
	);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. NOT part of the public
 * API — callers classify through {@link import("./flags").isUsageLimit} (the
 * flag accessor). `flags.ts` consumes this to populate `Flag.UsageLimit`, and
 * {@link isUsageLimitOutcome} uses it for the account-rotation decision.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
	if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);
	if (isDashScopeTokenLimitText(errorMessage)) return false;
	return (
		USAGE_LIMIT_PATTERN.test(errorMessage) ||
		CREDITS_EXHAUSTED_PATTERN.test(errorMessage) ||
		(CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) ||
		SPEND_LIMIT_PATTERN.test(errorMessage) ||
		ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
		matchesSubscriptionCapText(errorMessage) ||
		OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)
	);
}

/**
 * Account-scoped cap phrasing delivered on a 403 (or a statusless Connect
 * trailer): "Reached overall message rate limit", "Your limit will reset in …".
 * Kept separate from {@link matchesUsageLimitText} because the bare wording is
 * ambiguous without the 403 / statusless-account context; consumed by both
 * {@link isUsageLimitOutcome} (rotation decision) and `flags.ts` (Flag.UsageLimit).
 */
export function isAccountScopedCapText(message: string): boolean {
	return ACCOUNT_SCOPED_403_PATTERN.test(message);
}

/**
 * A concurrency cap on a non-billing status is shed-and-backoff, not
 * credential-rotatable. This mirrors the exclusion in {@link isUsageLimitOutcome}
 * for the 403 auth-retry entry points. A 402 remains an account-billing cap.
 */
export function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
	return message !== undefined && parseRateLimitReason(message) === "CONCURRENT_LIMIT" && status !== 402;
}
