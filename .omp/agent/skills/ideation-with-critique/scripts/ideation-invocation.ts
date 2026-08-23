import { DEFAULT_IDEATION_MAX_REVIEW_ROUNDS } from "../schemas/ideation-state.ts";

export interface IdeationInvocation {
	readonly idea: string;
	readonly max_review_rounds: 1 | 2 | 3 | 4 | 5;
}

const REVIEW_CAP = /^max_review_rounds=([1-5])$/;
const REVIEW_CAP_PREFIX = /^max_review_rounds/;

/**
 * Parses the command tail before slug construction. Only one exact final option
 * is admitted; every lookalike remains an invocation error rather than idea text.
 */
export function parseIdeationInvocation(input: string): IdeationInvocation {
	if (typeof input !== "string") throw new TypeError("Ideation invocation must be text");
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) throw new TypeError("Ideation invocation requires an idea or concept");
	const optionIndexes = tokens.flatMap((token, index) => (REVIEW_CAP_PREFIX.test(token) ? [index] : []));
	if (optionIndexes.length > 1) throw new TypeError("max_review_rounds may occur exactly once as the final token");
	if (optionIndexes.length === 1 && optionIndexes[0] !== tokens.length - 1)
		throw new TypeError("max_review_rounds must be the final token");
	const final = tokens.at(-1)!;
	const option = REVIEW_CAP.exec(final);
	if (optionIndexes.length === 1 && option === null)
		throw new TypeError("max_review_rounds must use an integer from 1 through 5");
	const ideaTokens = option === null ? tokens : tokens.slice(0, -1);
	if (ideaTokens.length === 0) throw new TypeError("Ideation invocation requires an idea or concept");
	return Object.freeze({
		idea: ideaTokens.join(" "),
		max_review_rounds:
			option === null ? DEFAULT_IDEATION_MAX_REVIEW_ROUNDS : (Number(option[1]) as 1 | 2 | 3 | 4 | 5),
	});
}
