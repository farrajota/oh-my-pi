import { describe, expect, it } from "bun:test";
import { streamOpenAIAnthropicShim } from "@oh-my-pi/pi-ai/providers/openai-anthropic-shim";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// The shim serves Kimi Code and Synthetic over either surface. `providerMaxAttempts` caps
// every outbound request of one stream call, as on the OpenAI-family providers, so a
// repeated-retry probe through the shim is one request on either surface.

const model = getBundledModel<"openai-completions">("openai", "gpt-4o-mini") as Model<"openai-completions">;
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

const ANTHROPIC_SSE = [
	{
		type: "message_start",
		message: {
			id: "msg_shim",
			type: "message",
			role: "assistant",
			model: model.id,
			content: [],
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

/** Fails the first request with a retryable 503, then serves `success` to any later one. */
function failOnceFetch(success: () => Response): { fetch: FetchImpl; requests: () => number } {
	let requests = 0;
	const impl = async (): Promise<Response> => {
		requests++;
		if (requests === 1) {
			return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "temporary failure" } }), {
				status: 503,
				headers: { "content-type": "application/json", "retry-after": "0" },
			});
		}
		return success();
	};
	return { fetch: Object.assign(impl, { preconnect: fetch.preconnect }) as FetchImpl, requests: () => requests };
}

function shim(format: "openai" | "anthropic", fetchImpl: FetchImpl, providerMaxAttempts: number | undefined) {
	return streamOpenAIAnthropicShim(
		model,
		context,
		{ apiKey: "test-key", fetch: fetchImpl, format, providerMaxAttempts },
		{ anthropicBaseUrl: "https://anthropic.shim.test", defaultFormat: "openai" },
	).result();
}

describe("OpenAI/Anthropic shim attempt budget", () => {
	it("sends one request on the OpenAI surface under providerMaxAttempts: 1", async () => {
		const upstream = failOnceFetch(() => new Response("unexpected second request", { status: 500 }));

		const result = await shim("openai", upstream.fetch, 1);

		expect(upstream.requests()).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
	});

	it("sends one request on the Anthropic surface under providerMaxAttempts: 1 and keeps its error", async () => {
		const upstream = failOnceFetch(
			() => new Response(ANTHROPIC_SSE, { headers: { "content-type": "text/event-stream" } }),
		);

		const result = await shim("anthropic", upstream.fetch, 1);

		expect(upstream.requests()).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("temporary failure");
	});

	it("still retries on the Anthropic surface without a budget", async () => {
		const upstream = failOnceFetch(
			() => new Response(ANTHROPIC_SSE, { headers: { "content-type": "text/event-stream" } }),
		);

		const result = await shim("anthropic", upstream.fetch, undefined);

		expect(upstream.requests()).toBe(2);
		expect(result.stopReason).toBe("stop");
	});
});
