import { describe, expect, it } from "bun:test";
import { isModelCooldownError } from "@oh-my-pi/pi-ai/error/rate-limit";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// CLIProxyAPI answers 429 with this envelope when every upstream credential
// for the model is cooling down, plus a Retry-After header for the reset.
const COOLDOWN_TEXT = "All credentials for model gpt-6.1-sol are cooling down via provider codex";
const COOLDOWN_BODY = JSON.stringify({
	error: {
		code: "model_cooldown",
		message: COOLDOWN_TEXT,
		model: "gpt-6.1-sol",
		reset_time: "2h0m0s",
		reset_seconds: 7200,
	},
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const modelBase = {
	id: "gpt-6.1-sol",
	name: "gpt-6.1-sol",
	baseUrl: "https://cliproxy.example.test/v1",
	reasoning: false,
	input: ["text"] as "text"[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function fetchReturning(response: () => Response): { fetch: FetchImpl; calls: () => number } {
	let calls = 0;
	const fetchImpl = Object.assign(
		async (): Promise<Response> => {
			calls += 1;
			return response();
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetch: fetchImpl as FetchImpl, calls: () => calls };
}

function cooldownResponse(): Response {
	return new Response(COOLDOWN_BODY, {
		status: 429,
		headers: { "content-type": "application/json", "retry-after": "7200" },
	});
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function codexModel(): Model<"openai-codex-responses"> {
	return buildModel({
		...modelBase,
		api: "openai-codex-responses",
		provider: "cliproxy-codex",
		preferWebsockets: false,
	});
}

describe("isModelCooldownError", () => {
	it("recognizes the structured model_cooldown code", () => {
		expect(isModelCooldownError({ errorCode: "model_cooldown", errorMessage: "ChatGPT rate limit exceeded." })).toBe(
			true,
		);
	});

	it("recognizes the cooldown envelope from the error text alone", () => {
		expect(isModelCooldownError({ errorMessage: `429 ${COOLDOWN_TEXT} (type=model_cooldown)` })).toBe(true);
		expect(isModelCooldownError({ errorMessage: `429 ${COOLDOWN_TEXT}` })).toBe(true);
	});

	it("rejects ordinary rate limits and unrelated codes", () => {
		expect(isModelCooldownError({ errorCode: "rate_limit_exceeded", errorMessage: "429 Requests per minute" })).toBe(
			false,
		);
		expect(isModelCooldownError({ errorMessage: "429 Too many requests, slow down" })).toBe(false);
		expect(isModelCooldownError({})).toBe(false);
	});
});

describe("provider error codes on terminal messages", () => {
	it("keeps the cliproxy cooldown code on OpenAI Completions and Responses errors", async () => {
		const completionsFetch = fetchReturning(cooldownResponse);
		const completions = await streamOpenAICompletions(
			buildModel({ ...modelBase, api: "openai-completions", provider: "cliproxy" }),
			context,
			{ apiKey: "test-key", fetch: completionsFetch.fetch, providerMaxAttempts: 1 },
		).result();
		const responsesFetch = fetchReturning(cooldownResponse);
		const responses = await streamOpenAIResponses(
			buildModel({ ...modelBase, api: "openai-responses", provider: "cliproxy" }),
			context,
			{ apiKey: "test-key", fetch: responsesFetch.fetch, providerMaxAttempts: 1 },
		).result();

		for (const result of [completions, responses]) {
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(429);
			expect(result.errorCode).toBe("model_cooldown");
			expect(result.errorMessage).toContain(COOLDOWN_TEXT);
		}
		expect(completionsFetch.calls()).toBe(1);
		expect(responsesFetch.calls()).toBe(1);
	});

	it("leaves errorCode unset when the provider sends no code", async () => {
		const noCode = fetchReturning(
			() =>
				new Response(JSON.stringify({ error: { message: "The model is temporarily unavailable." } }), {
					status: 503,
					headers: { "content-type": "application/json" },
				}),
		);
		const result = await streamOpenAIResponses(
			buildModel({ ...modelBase, api: "openai-responses", provider: "cliproxy" }),
			context,
			{ apiKey: "test-key", fetch: noCode.fetch, providerMaxAttempts: 1 },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBeUndefined();
	});

	it("keeps the cooldown code and the proxy's own message on Codex HTTP errors", async () => {
		const codexFetch = fetchReturning(cooldownResponse);
		const result = await streamOpenAICodexResponses(codexModel(), context, {
			apiKey: codexToken(),
			fetch: codexFetch.fetch,
			providerMaxAttempts: 1,
		}).result();

		expect(codexFetch.calls()).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorCode).toBe("model_cooldown");
		// The friendly "rate limit exceeded" rewrite alone hides which limit hit.
		expect(result.errorMessage).toContain(COOLDOWN_TEXT);
		expect(result.errorMessage).toContain("retry-after-ms=7200000");
	});

	it("keeps an in-stream Codex model_cooldown code on the terminal message", async () => {
		const codexFetch = fetchReturning(
			() =>
				new Response(
					`data: ${JSON.stringify({ type: "error", code: "model_cooldown", message: "Codex model cooldown" })}\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		const result = await streamOpenAICodexResponses(codexModel(), context, {
			apiKey: codexToken(),
			fetch: codexFetch.fetch,
			providerMaxAttempts: 1,
		}).result();

		expect(codexFetch.calls()).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorCode).toBe("model_cooldown");
	});
});
