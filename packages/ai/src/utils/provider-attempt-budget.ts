import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";

/**
 * Outbound request count for one provider stream call, shared by every retry
 * layer of that call: HTTP retries, stream reopens, transport fallbacks,
 * request-shape fallbacks, and replays of empty or failed attempts.
 */
export interface ProviderAttemptBudget {
	/** Total outbound attempts allowed; `undefined` leaves each layer's own limit in charge. */
	readonly maxAttempts: number | undefined;
	attempts: number;
}

/** Normalize `providerMaxAttempts`: finite values become an integer of at least 1, anything else is unbounded. */
export function createProviderAttemptBudget(providerMaxAttempts: number | undefined): ProviderAttemptBudget {
	return {
		maxAttempts:
			typeof providerMaxAttempts === "number" && Number.isFinite(providerMaxAttempts)
				? Math.max(1, Math.floor(providerMaxAttempts))
				: undefined,
		attempts: 0,
	};
}

export function canStartProviderAttempt(budget: ProviderAttemptBudget): boolean {
	return budget.maxAttempts === undefined || budget.attempts < budget.maxAttempts;
}

/** Attempts still allowed, or `undefined` when the budget is unbounded. */
export function remainingProviderAttempts(budget: ProviderAttemptBudget): number | undefined {
	return budget.maxAttempts === undefined ? undefined : Math.max(0, budget.maxAttempts - budget.attempts);
}

/**
 * Attempt cap for one HTTP retry loop: the lower of a finite `maxHttpAttempts`
 * and the attempts left in `budget`. A non-finite `maxHttpAttempts` never lifts
 * the budget's cap.
 */
export function resolveHttpAttemptCap(
	maxHttpAttempts: number | undefined,
	budget: ProviderAttemptBudget,
): number | undefined {
	const remaining = remainingProviderAttempts(budget);
	if (typeof maxHttpAttempts !== "number" || !Number.isFinite(maxHttpAttempts)) {
		return remaining ?? maxHttpAttempts;
	}
	return remaining === undefined ? maxHttpAttempts : Math.min(maxHttpAttempts, remaining);
}

export function createProviderAttemptLimitError(provider: string | undefined): AIError.ProviderResponseError {
	return new AIError.ProviderResponseError("Provider transport attempt limit reached", {
		provider,
		kind: "runtime",
	});
}

/** Throw before an attempt the budget no longer allows. */
export function assertProviderAttemptAvailable(budget: ProviderAttemptBudget, provider: string | undefined): void {
	if (!canStartProviderAttempt(budget)) throw createProviderAttemptLimitError(provider);
}

/**
 * Count every request sent through `fetchImpl` against `budget`. A request past
 * the budget fails before it leaves the process, whichever layer issued it.
 */
export function wrapFetchWithProviderAttemptBudget(
	fetchImpl: FetchImpl,
	budget: ProviderAttemptBudget,
	provider: string | undefined,
): FetchImpl {
	if (budget.maxAttempts === undefined) return fetchImpl;
	const counted: FetchImpl = async (input, init) => {
		assertProviderAttemptAvailable(budget, provider);
		budget.attempts += 1;
		return fetchImpl(input, init);
	};
	return counted;
}
