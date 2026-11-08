import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec, OpenAICompat, StreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel<"openai-completions">("openai", "gpt-4o-mini");

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
}

async function expectAttemptBudget(
	options: Pick<StreamOptions, "maxHttpAttempts" | "providerMaxAttempts">,
	expectedAttempts: number,
): Promise<void> {
	let attempts = 0;
	const fetchMock: FetchImpl = async () => {
		attempts++;
		return new Response(JSON.stringify({ error: { message: "temporary failure" } }), {
			status: 503,
			headers: { "content-type": "application/json", "retry-after": "0" },
		});
	};

	const result = await streamOpenAICompletions(model, baseContext(), {
		apiKey: "test-key",
		fetch: Object.assign(fetchMock, { preconnect: fetch.preconnect }),
		...options,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(result.errorStatus).toBe(503);
	expect(attempts).toBe(expectedAttempts);
}

type AttemptBudgetCase = {
	name: string;
	options: Pick<StreamOptions, "maxHttpAttempts" | "providerMaxAttempts">;
	expectedAttempts: number;
};

const cases: AttemptBudgetCase[] = [
	{ name: "maxHttpAttempts alone", options: { maxHttpAttempts: 2 }, expectedAttempts: 2 },
	{ name: "providerMaxAttempts alone", options: { providerMaxAttempts: 2 }, expectedAttempts: 2 },
	{
		name: "the lower providerMaxAttempts cap wins",
		options: { maxHttpAttempts: 4, providerMaxAttempts: 2 },
		expectedAttempts: 2,
	},
	{
		name: "the lower maxHttpAttempts cap wins",
		options: { maxHttpAttempts: 2, providerMaxAttempts: 4 },
		expectedAttempts: 2,
	},
	{
		name: "a non-finite providerMaxAttempts does not bypass a one-attempt maxHttpAttempts",
		options: { maxHttpAttempts: 1, providerMaxAttempts: Number.NaN },
		expectedAttempts: 1,
	},
	{
		name: "a non-finite maxHttpAttempts does not bypass a one-attempt providerMaxAttempts",
		options: { maxHttpAttempts: Number.NaN, providerMaxAttempts: 1 },
		expectedAttempts: 1,
	},
	{
		name: "an infinite maxHttpAttempts does not bypass a one-attempt providerMaxAttempts",
		options: { maxHttpAttempts: Number.POSITIVE_INFINITY, providerMaxAttempts: 1 },
		expectedAttempts: 1,
	},
];

describe("OpenAI chat-completions attempt budgets", () => {
	for (const { name, options, expectedAttempts } of cases) {
		it(`limits actual HTTP attempts when ${name}`, async () => {
			await expectAttemptBudget(options, expectedAttempts);
		});
	}

	it("does not exceed providerMaxAttempts across a strict-tools fallback", async () => {
		const fallbackModel: Model<"openai-completions"> = buildModel({
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { toolStrictMode: "all_strict" } satisfies OpenAICompat,
		} as ModelSpec<"openai-completions">);
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				attempts++;
				if (attempts === 1) {
					return new Response(
						JSON.stringify({
							message: "Strict tool schema validation failed.",
							type: "invalid_request_error",
							param: "tools",
							code: "wrong_api_format",
						}),
						{ status: 422, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(
					[
						`data: ${JSON.stringify({
							id: "chatcmpl-fallback",
							object: "chat.completion.chunk",
							created: 0,
							model: fallbackModel.id,
							choices: [{ index: 0, delta: { content: "Recovered" } }],
						})}`,
						`data: ${JSON.stringify({
							id: "chatcmpl-fallback",
							object: "chat.completion.chunk",
							created: 0,
							model: fallbackModel.id,
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						})}`,
						"data: [DONE]",
						"",
					].join("\n\n"),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(
			fallbackModel,
			{
				...baseContext(),
				tools: [
					{
						name: "echo",
						description: "Echo input",
						parameters: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			},
			{ apiKey: "test-key", fetch: fetchMock, providerMaxAttempts: 1 },
		).result();

		expect(result.stopReason).toBe("error");
		expect(attempts).toBe(1);
	});
});
