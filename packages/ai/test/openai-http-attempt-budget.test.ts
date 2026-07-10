import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { OpenAIHttpError, postOpenAIStream } from "@oh-my-pi/pi-ai/utils/openai-http";

function createCooldownFetch(): { fetch: FetchImpl; calls: () => number } {
	let count = 0;
	const fetch: FetchImpl = async () => {
		count += 1;
		return new Response(JSON.stringify({ error: { message: "cooldown", type: "model_cooldown" } }), {
			status: 429,
			headers: { "content-type": "application/json" },
		});
	};

	return { fetch, calls: () => count };
}

async function expectOneAttempt(maxAttempts: number): Promise<void> {
	const { fetch, calls } = createCooldownFetch();
	let thrown: unknown;

	try {
		await postOpenAIStream<unknown>({
			url: "https://example.test/v1/responses",
			headers: {},
			body: {},
			signal: new AbortController().signal,
			fetch,
			maxAttempts,
		});
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(OpenAIHttpError);
	expect((thrown as OpenAIHttpError).status).toBe(429);
	expect(calls()).toBe(1);
}

describe("postOpenAIStream attempt budget", () => {
	it("makes exactly one request for a retryable 429 when maxAttempts is one", async () => {
		await expectOneAttempt(1);
	});

	it.each([0, -1] as const)("normalizes finite maxAttempts %d to one request", async maxAttempts => {
		await expectOneAttempt(maxAttempts);
	});
});
