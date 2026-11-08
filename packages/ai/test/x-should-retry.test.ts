import { describe, expect, test } from "bun:test";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as AIError from "../src/error";
import { OpenAIHttpError, postOpenAIStream } from "../src/utils/openai-http";
import { minimaxTokenPlanOpenAIModel } from "./helpers";
import { mockFetch } from "./helpers/fetch-mock";

// A retrying gateway that already exhausted its own attempts answers with a
// terminal 5xx plus `x-should-retry: false`. The removed `openai` SDK obeyed
// that verdict; the wire transport and the provider retry loops must too, or
// every layer replays a request the gateway already gave up on (#17920).
function terminal503(): Response {
	return new Response(JSON.stringify({ error: { message: "upstream unavailable", type: "server_error" } }), {
		status: 503,
		headers: { "content-type": "application/json", "x-should-retry": "false", "retry-after-ms": "1" },
	});
}

async function captureStreamError(response: () => Response): Promise<{ attempts: number; error: unknown }> {
	let attempts = 0;
	const fetch = mockFetch(() => {
		attempts++;
		return response();
	});
	const error = await postOpenAIStream({
		url: "http://gateway.local/v1/chat/completions",
		headers: {},
		body: {},
		signal: new AbortController().signal,
		fetch,
	}).then(
		() => undefined,
		(err: unknown) => err,
	);
	return { attempts, error };
}

describe("x-should-retry on the OpenAI wire (#17920)", () => {
	test("transport surfaces a terminal 503 on the first attempt", async () => {
		const { attempts, error } = await captureStreamError(terminal503);

		expect(attempts).toBe(1);
		expect(error).toBeInstanceOf(OpenAIHttpError);
		expect((error as OpenAIHttpError).status).toBe(503);
	});

	test("provider retry classification obeys the captured verdict over status", async () => {
		const { error } = await captureStreamError(terminal503);
		expect(AIError.isProviderRetryableError(error)).toBe(false);

		const forcedRetry = new OpenAIHttpError("400 try again", {
			status: 400,
			headers: new Headers({ "x-should-retry": "true" }),
		});
		expect(AIError.isProviderRetryableError(forcedRetry)).toBe(true);
	});
});

const azureModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** 503 without a verdict: the transport retries it up to its own attempt budget. */
function retryable503(): Response {
	return new Response(JSON.stringify({ error: { message: "upstream unavailable", type: "server_error" } }), {
		status: 503,
		headers: { "content-type": "application/json", "retry-after-ms": "1" },
	});
}

type ProviderRun = (fetch: FetchImpl) => Promise<AssistantMessage>;

const PROVIDERS: [label: string, run: ProviderRun][] = [
	[
		"Azure Responses",
		fetch =>
			streamAzureOpenAIResponses(azureModel, context, {
				apiKey: "test-key",
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				fetch,
				providerRetryWait: async () => {},
			}).result(),
	],
	[
		"OpenAI Completions without an explicit HTTP budget",
		fetch =>
			streamOpenAICompletions(minimaxTokenPlanOpenAIModel("minimax-code", "MiniMax-M3"), context, {
				apiKey: "test-key",
				fetch,
				providerRetryWait: async () => {},
			}).result(),
	],
];

async function countProviderAttempts(run: ProviderRun, response: () => Response) {
	let attempts = 0;
	const result = await run(
		mockFetch(() => {
			attempts++;
			return response();
		}),
	);
	return { attempts, result };
}

describe("provider replay above the OpenAI wire transport", () => {
	test.each(PROVIDERS)("%s does not replay a terminal 503", async (_label, run) => {
		const { attempts, result } = await countProviderAttempts(run, terminal503);

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
		expect(attempts).toBe(1);
	});

	test.each(PROVIDERS)("%s keeps a retryable 503 within the transport's attempt budget", async (_label, run) => {
		const { attempts, result } = await countProviderAttempts(run, retryable503);

		expect(result.errorStatus).toBe(503);
		// postOpenAIStream's default budget is 6 requests; a replay above it would send 12.
		expect(attempts).toBe(6);
	});
});

describe("Azure Responses attempt caps", () => {
	test.each([
		["maxHttpAttempts", { maxHttpAttempts: 1 }, 1],
		["providerMaxAttempts", { providerMaxAttempts: 1 }, 1],
		["lower of both", { maxHttpAttempts: 4, providerMaxAttempts: 2 }, 2],
	] as const)("limits a retryable 503 by the %s attempt cap", async (_label, caps, expected) => {
		const { attempts, result } = await countProviderAttempts(
			fetch =>
				streamAzureOpenAIResponses(azureModel, context, {
					apiKey: "test-key",
					azureBaseUrl: azureModel.baseUrl,
					azureApiVersion: "v1",
					fetch,
					providerRetryWait: async () => {},
					...caps,
				}).result(),
			retryable503,
		);

		expect(result.errorStatus).toBe(503);
		expect(attempts).toBe(expected);
	});
});
