/**
 * A scripted OpenAI-compatible model server for the end-to-end permission tests: a real child
 * session, on main or on a worker, finds it through `models.yml` and runs a scripted write.
 */
import * as path from "node:path";

interface ChatMessage {
	role: string;
	content?: unknown;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

function isChatMessage(value: unknown): value is ChatMessage {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "role") === "string";
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function chunks(reply: Reply): string {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const delta =
		"text" in reply
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${reply.tool}`,
							type: "function",
							function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
						},
					],
				};
	const frames = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** What the scripted model reacts to. */
export interface FakeModelScript {
	/** Text in the system prompt of the agent the script drives. */
	readonly agentMarker: string;
	/** Text in a user message that makes the agent write {@link target}. */
	readonly writeTask: string;
	/** Relative path the agent writes. */
	readonly target: string;
}

/**
 * Scripted OpenAI-compatible model: the scripted agent's turn (its system prompt carries the marker)
 * whose last user message holds the write task writes the target; a tool result is answered with
 * `tool said: …`; anything else gets `pong`. Every system prompt and tool result of the run is kept
 * so a test can read them.
 */
export class FakeModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly #script: FakeModelScript;
	readonly systemPrompts: string[] = [];
	readonly toolResults: string[] = [];

	constructor(script: FakeModelScript) {
		this.#script = script;
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#fetch(request) });
	}

	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${this.#server.port}/v1`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
				"",
			].join("\n"),
		);
		return file;
	}

	stop(): void {
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body: unknown = await request.json();
		const rawMessages: unknown =
			typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
		const messages = Array.isArray(rawMessages) ? rawMessages.filter(isChatMessage) : [];
		const last = messages.at(-1);
		const lastUser = messages.findLast(message => message.role === "user");
		const systemText = messages
			.filter(message => message.role === "system" || message.role === "developer")
			.map(message => messageText(message.content))
			.join("\n");
		const runTurn = systemText.includes(this.#script.agentMarker);
		if (runTurn) this.systemPrompts.push(systemText);
		let reply: Reply = { text: "pong" };
		if (runTurn && last?.role === "tool") {
			this.toolResults.push(messageText(last.content));
			reply = { text: `tool said: ${messageText(last.content)}` };
		} else if (runTurn && lastUser && messageText(lastUser.content).includes(this.#script.writeTask)) {
			reply = { tool: "write", args: { path: this.#script.target, content: "leak" } };
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
	}
}
