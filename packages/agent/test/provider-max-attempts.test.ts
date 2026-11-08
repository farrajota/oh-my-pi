import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

describe("Agent providerMaxAttempts", () => {
	it("passes the attempt cap to each provider request and follows later changes", async () => {
		const mock = createMockModel({ responses: [{ content: ["first"] }, { content: ["second"] }] });
		const seen: Array<number | undefined> = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			providerMaxAttempts: 4,
			streamFn: (model, context, options) => {
				seen.push(options?.providerMaxAttempts);
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("one");
		expect(agent.providerMaxAttempts).toBe(4);
		agent.providerMaxAttempts = 1;
		await agent.prompt("two");

		expect(seen).toEqual([4, 1]);
	});

	it("leaves the provider default in place when unset", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const seen: Array<number | undefined> = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				seen.push(options?.providerMaxAttempts);
				return mock.stream(model, context, options);
			},
		});

		await agent.prompt("one");

		expect(agent.providerMaxAttempts).toBeUndefined();
		expect(seen).toEqual([undefined]);
	});
});
