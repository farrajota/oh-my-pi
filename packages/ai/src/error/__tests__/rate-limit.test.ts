import { describe, expect, it } from "bun:test";
import { classifyRecoverableLongWindowLimit } from "../rate-limit";

describe("classifyRecoverableLongWindowLimit", () => {
	it("classifies recoverable long-window session, weekly, daily, and quota reset limits", () => {
		const cases = [
			{
				name: "Claude session limit",
				input: {
					status: 429,
					message:
						"Claude usage limit reached: you have hit your 5 hour session limit. Your session limit will reset soon.",
				},
				expected: { recoverable: true, reason: "session" },
			},
			{
				name: "Claude weekly limit",
				input: {
					status: 429,
					message: "Claude weekly limit reached. Your weekly usage limit resets next week.",
				},
				expected: { recoverable: true, reason: "weekly" },
			},
			{
				name: "Codex usage_limit_reached with weekly reset wording",
				input: {
					status: 429,
					message: "usage_limit_reached: Weekly usage limit reached. Try again in 6 hours.",
				},
				expected: { recoverable: true, reason: "weekly", resetAfterMs: 6 * 60 * 60 * 1000 },
			},
			{
				name: "Codex usage_limit_reached with approximate reset wording",
				input: {
					status: 429,
					message: "usage_limit_reached: Usage limit reached. Try again in ~10 min.",
				},
				expected: { recoverable: true, reason: "quota-reset", resetAfterMs: 10 * 60 * 1000 },
			},
			{
				name: "provider quota will reset",
				input: {
					status: 429,
					message: "You have exhausted your quota. Your quota will reset after 5h.",
				},
				expected: { recoverable: true, reason: "quota-reset", resetAfterMs: 5 * 60 * 60 * 1000 },
			},
			{
				name: "daily reset duration parsing",
				input: {
					status: 429,
					message: "Daily usage limit reached; please try again in 15 minutes.",
				},
				expected: { recoverable: true, reason: "daily", resetAfterMs: 15 * 60 * 1000 },
			},
			{
				name: "multi-unit duration parsing",
				input: {
					status: 429,
					message: "usage_limit_reached: quota exhausted; reset after 1 hour 30 minutes.",
				},
				expected: { recoverable: true, reason: "quota-reset", resetAfterMs: 90 * 60 * 1000 },
			},
			{
				name: "day duration parsing",
				input: {
					status: 429,
					message: "Your quota will reset after 2 days.",
				},
				expected: { recoverable: true, reason: "quota-reset", resetAfterMs: 2 * 24 * 60 * 60 * 1000 },
			},
			{
				name: "timezone timestamp parsing",
				input: {
					status: 429,
					message: "usage_limit_reached: quota resets at 2026-07-09T12:30:00Z.",
				},
				expected: { recoverable: true, reason: "quota-reset", resetAtMs: Date.parse("2026-07-09T12:30:00Z") },
			},
		];

		for (const testCase of cases) {
			expect({ name: testCase.name, result: classifyRecoverableLongWindowLimit(testCase.input) }).toMatchObject({
				name: testCase.name,
				result: testCase.expected,
			});
		}
	});

	it("classifies only 429 aggregate provider credential cooldowns", () => {
		const acceptedCases = [
			{
				name: "structured model_cooldown code",
				input: {
					status: 429,
					code: "model_cooldown",
					message: "All credentials for model gpt-5 are cooling down via provider codex.",
				},
			},
			{
				name: "embedded model_cooldown marker with message status",
				input: {
					message: "429 All credentials for model gpt-5 are cooling down via provider codex (type=model_cooldown)",
				},
			},
		];

		for (const testCase of acceptedCases) {
			expect(classifyRecoverableLongWindowLimit(testCase.input)).toEqual({
				recoverable: true,
				reason: "provider-cooldown",
			});
		}

		const rejectedCases = [
			{
				name: "model_cooldown code without aggregate credential wording",
				input: { status: 429, code: "model_cooldown", message: "The model is cooling down." },
			},
			{
				name: "aggregate credential wording without model_cooldown code or marker",
				input: { status: 429, message: "All credentials for model gpt-5 are cooling down via provider codex." },
			},
			{
				name: "non-429 aggregate model_cooldown",
				input: {
					status: 400,
					code: "model_cooldown",
					message: "All credentials for model gpt-5 are cooling down via provider codex.",
				},
			},
		];

		for (const testCase of rejectedCases) {
			expect({ name: testCase.name, result: classifyRecoverableLongWindowLimit(testCase.input) }).toEqual({
				name: testCase.name,
				result: { recoverable: false },
			});
		}
	});

	it("does not classify entitlement, auth, transient rate, capacity, or server failures as recoverable", () => {
		const cases = [
			{
				name: "usage_not_included",
				input: { status: 429, message: "usage_not_included: this model is not included in your plan" },
			},
			{
				name: "insufficient balance",
				input: { status: 429, message: "insufficient_balance: please add billing credits" },
			},
			{
				name: "insufficient quota without reset",
				input: { status: 429, message: "insufficient_quota: quota exceeded" },
			},
			{
				name: "invalid auth grant",
				input: { status: 400, message: "invalid_grant: refresh token is invalid" },
			},
			{
				name: "401 auth failure",
				input: { status: 401, message: "expired token" },
			},
			{
				name: "403 auth failure",
				input: { status: 403, message: "Forbidden: credential was revoked" },
			},
			{
				name: "context length",
				input: { status: 400, message: "context length exceeded" },
			},
			{
				name: "maximum prompt length",
				input: { status: 400, message: "maximum prompt length exceeded" },
			},
			{
				name: "context overflow",
				input: { status: 400, message: "context overflow" },
			},
			{
				name: "per-minute 429",
				input: { status: 429, message: "Too many requests per minute. Please try again in 30 seconds." },
			},
			{
				name: "model capacity",
				input: { status: 429, message: "The model is overloaded and capacity is temporarily exhausted." },
			},
			{
				name: "resource exhausted capacity",
				input: { status: 429, message: "resource exhausted; retry later" },
			},
			{
				name: "server 500",
				input: { status: 500, message: "Internal server error" },
			},
			{
				name: "server 503",
				input: { status: 503, message: "Service unavailable" },
			},
		];

		for (const testCase of cases) {
			expect({ name: testCase.name, result: classifyRecoverableLongWindowLimit(testCase.input) }).toEqual({
				name: testCase.name,
				result: { recoverable: false },
			});
		}
	});
});
