import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getStreamingPartialJson, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";

function createPartial(text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("AssistantMessageEventStream", () => {
	it("queues adjacent delta events immediately without throttling or merging", () => {
		const stream = new AssistantMessageEventStream();

		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: createPartial("a") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial: createPartial("ab") });

		expect(stream.queue).toHaveLength(2);
		expect(stream.queue[0]).toMatchObject({ type: "text_delta", delta: "a" });
		expect(stream.queue[1]).toMatchObject({ type: "text_delta", delta: "b" });
	});

	it("snapshots synchronously buffered partials and shares finalized blocks", async () => {
		const stream = new AssistantMessageEventStream();
		const partial = createPartial();
		partial.content = [];
		stream.push({ type: "start", partial });

		const textBlock = { type: "text" as const, text: "" };
		partial.content.push(textBlock);
		stream.push({ type: "text_start", contentIndex: 0, partial });
		textBlock.text = "a";
		partial.usage.output = 1;
		partial.usage.cost.output = 0.1;
		stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial });
		textBlock.text = "ab";
		partial.usage.output = 2;
		partial.usage.cost.output = 0.2;
		stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial });
		stream.push({ type: "text_end", contentIndex: 0, content: "ab", partial });

		const toolCall = {
			type: "toolCall" as const,
			id: "call-1",
			name: "search",
			arguments: { query: { text: "" } },
			providerMetadata: {
				type: "computer" as const,
				providerItemId: "item-1",
				actions: [{ type: "type" as const, text: "" }],
				pendingSafetyChecks: [],
			},
		};
		partial.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex: 1, partial });
		toolCall.arguments.query.text = "first";
		toolCall.providerMetadata.actions[0] = { type: "type", text: "first" };
		partial.usage.output = 3;
		partial.usage.cost.output = 0.3;
		stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "first", partial });
		toolCall.arguments.query.text = "second";
		toolCall.providerMetadata.actions[0] = { type: "type", text: "second" };
		partial.usage.output = 4;
		partial.usage.cost.output = 0.4;
		stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "second", partial });
		toolCall.arguments.query.text = "final";
		toolCall.providerMetadata.actions[0] = { type: "type", text: "final" };
		stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial });
		toolCall.arguments.query.text = "mutated after end";
		toolCall.providerMetadata.actions[0] = { type: "type", text: "mutated after end" };
		stream.push({ type: "done", reason: "stop", message: createPartial("final") });

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const partials: AssistantMessage[] = [];
		for (const event of events) {
			if ("partial" in event) partials.push(event.partial);
		}

		expect(partials.map(message => message.content.length)).toEqual([0, 1, 1, 1, 1, 2, 2, 2, 2]);
		expect(partials[1]?.content[0]).toMatchObject({ type: "text", text: "" });
		expect(partials[2]?.content[0]).toMatchObject({ type: "text", text: "a" });
		expect(partials[3]?.content[0]).toMatchObject({ type: "text", text: "ab" });
		expect(partials[4]?.content[0]).not.toBe(partials[3]?.content[0]);
		expect(partials[5]?.content[0]).toBe(partials[4]?.content[0]);
		expect(partials[6]?.content[0]).toBe(partials[5]?.content[0]);
		expect(partials.map(message => message.usage.output)).toEqual([0, 0, 1, 2, 2, 2, 3, 4, 4]);
		expect(partials.map(message => message.usage.cost.output)).toEqual([0, 0, 0.1, 0.2, 0.2, 0.2, 0.3, 0.4, 0.4]);
		expect(partials[5]?.content[1]).not.toBe(toolCall);
		expect(partials[5]?.content[1]).toMatchObject({
			arguments: { query: { text: "" } },
			providerMetadata: { actions: [{ text: "" }] },
		});
		expect(partials[6]?.content[1]).toMatchObject({
			arguments: { query: { text: "first" } },
			providerMetadata: { actions: [{ text: "first" }] },
		});
		expect(partials[7]?.content[1]).toMatchObject({
			arguments: { query: { text: "second" } },
			providerMetadata: { actions: [{ text: "second" }] },
		});
		expect(events[8]).toMatchObject({
			type: "toolcall_end",
			toolCall: {
				arguments: { query: { text: "final" } },
				providerMetadata: { actions: [{ text: "final" }] },
			},
		});
		expect(partial.content[0]).toBe(textBlock);
		expect(partial.content[1]).toBe(toolCall);
		expect(toolCall.arguments.query.text).toBe("mutated after end");
	});

	it("retains interleaved open blocks and streamed tool JSON at push time", () => {
		const stream = new AssistantMessageEventStream();
		const partial = createPartial();
		const a = partial.content[0] as { type: "text"; text: string };
		const b = { type: "text" as const, text: "B" };
		const c = { type: "text" as const, text: "C" };
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		partial.content.push(b);
		stream.push({ type: "text_start", contentIndex: 1, partial });
		partial.content.push(c);
		stream.push({ type: "text_start", contentIndex: 2, partial });
		const cEvent = stream.queue[3];
		b.text = "B2";
		stream.push({ type: "text_delta", contentIndex: 1, delta: "2", partial });
		expect(
			(cEvent as Extract<AssistantMessageEvent, { partial: AssistantMessage }>).partial.content[1],
		).toMatchObject({ text: "B" });
		expect(
			(stream.queue[4] as Extract<AssistantMessageEvent, { partial: AssistantMessage }>).partial.content[1],
		).toMatchObject({ text: "B2" });
		a.text = "A2";
		expect(
			(cEvent as Extract<AssistantMessageEvent, { partial: AssistantMessage }>).partial.content[0],
		).toMatchObject({ text: "" });

		const toolCall = { type: "toolCall" as const, id: "id", name: "search", arguments: { input: "initial" } };
		partial.content.push(toolCall);
		setStreamingPartialJson(toolCall, '{"input":"initial"}');
		stream.push({ type: "toolcall_start", contentIndex: 3, partial });
		setStreamingPartialJson(toolCall, '{"input":"updated"}');
		toolCall.arguments.input = "updated";
		stream.push({ type: "toolcall_delta", contentIndex: 3, delta: "updated", partial });
		const endCall = { ...toolCall, arguments: { input: "finished" } };
		setStreamingPartialJson(endCall, '{"input":"finished"}');
		stream.push({ type: "toolcall_end", contentIndex: 3, toolCall: endCall, partial });
		expect(
			getStreamingPartialJson(
				(stream.queue[5] as Extract<AssistantMessageEvent, { partial: AssistantMessage }>).partial
					.content[3] as typeof toolCall,
			),
		).toBe('{"input":"initial"}');
		expect(
			getStreamingPartialJson(
				(stream.queue[6] as Extract<AssistantMessageEvent, { partial: AssistantMessage }>).partial
					.content[3] as typeof toolCall,
			),
		).toBe('{"input":"updated"}');
		expect(
			getStreamingPartialJson(
				(stream.queue[7] as Extract<AssistantMessageEvent, { type: "toolcall_end" }>).toolCall,
			),
		).toBe('{"input":"finished"}');
	});

	it("rejects result() when ended without a terminal value", async () => {
		const stream = new AssistantMessageEventStream();
		stream.end();
		await expect(stream.result()).rejects.toThrow(/ended without a final result/);
	});

	it("keeps the pushed terminal result when end() follows a done event", async () => {
		const stream = new AssistantMessageEventStream();
		const message = createPartial("final");
		const event = { type: "done" as const, reason: "stop" as const, message };
		stream.push(event);
		stream.end();
		expect(stream.queue[0]).toBe(event);
		await expect(stream.result()).resolves.toBe(message);
	});

	it("stamps terminal error events with a classified errorId", async () => {
		const stream = new AssistantMessageEventStream();
		const message = createPartial();
		message.stopReason = "error";
		message.errorMessage = "usage limit reached";
		const event = { type: "error" as const, reason: "error" as const, error: message };

		stream.push(event);

		const result = await stream.result();
		expect(stream.queue[0]).toBe(event);
		expect(result).toBe(message);
		expect(AIError.is(result.errorId, AIError.Flag.UsageLimit)).toBe(true);
	});

	it("leaves successful terminal messages without errorId", async () => {
		const stream = new AssistantMessageEventStream();
		const message = createPartial("ok");

		stream.push({ type: "done", reason: "stop", message });

		const result = await stream.result();
		expect(result.errorId).toBeUndefined();
	});

	it("upgrades raw status fallback ids after final terminal text is available", async () => {
		const stream = new AssistantMessageEventStream();
		const message = createPartial();
		message.stopReason = "error";
		message.errorId = 503;
		message.errorStatus = 503;
		message.errorMessage = "stream stall";

		stream.push({ type: "error", reason: "error", error: message });

		const result = await stream.result();
		expect(AIError.is(result.errorId, AIError.Flag.Class)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});
});
