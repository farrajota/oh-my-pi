import { mock } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

const outputPath = Bun.env.OMP_TITLE_PROBE_PATH;
if (!outputPath) {
	throw new Error("OMP_TITLE_PROBE_PATH is required");
}

// Let title-model credential resolution reach the mocked completion boundary without a real provider call.
process.env.ANTHROPIC_API_KEY = "title-probe";

let generatedFrom: string | undefined;

const provider = createMockModel({
	responses: [{ content: ["The implementation is complete."] }],
});

// Keep the CLI's real prompt, provider-response, and title lifecycle; replace only
// the external provider stream and completion boundaries with deterministic responses.
mock.module("@oh-my-pi/pi-ai", () => ({
	...ai,
	streamSimple: provider.stream,
	completeSimple: async (_model: ai.Model<ai.Api>, context: ai.Context) => {
		const input = context.messages.findLast(message => message.role === "user")?.content;
		if (typeof input === "string") {
			const wrappedInput = /^<user>\n([\s\S]*)\n<\/user>$/.exec(input);
			generatedFrom = wrappedInput?.[1] ?? input;
		}
		return {
			role: "assistant",
			content: [{ type: "text", text: "<title>CLI Initial Title</title>" }],
			api: _model.api,
			provider: _model.provider,
			model: _model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	},
}));
// Load the CLI session graph only after Bun's preload mock replaces its provider boundary.
const { AgentSession } = await import("../../src/session/agent-session");

const prompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = async function (...args) {
	const titleChanged = new Promise<void>(resolve => {
		const unsubscribe = this.sessionManager.onSessionNameChanged(async () => {
			unsubscribe();
			await Bun.write(outputPath, JSON.stringify({ generatedFrom, sessionName: this.sessionName }));
			process.kill(process.pid, "SIGINT");
			resolve();
		});
	});
	const result = await prompt.apply(this, args);
	await titleChanged;
	return result;
};
