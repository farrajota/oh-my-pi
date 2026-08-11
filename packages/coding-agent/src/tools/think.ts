import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Component, Markdown } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";

const thinkSchema = type({
	thoughts: type("string").describe("private scratchpad reasoning to retain before the next response"),
	"+": "reject",
}).describe("record private intermediate reasoning before answering");

type ThinkParams = typeof thinkSchema.infer;

export type ThinkRenderArgs = {
	thoughts?: string;
};

export const thinkToolRenderer = {
	inline: true,
	renderCall(args: ThinkRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const thoughts =
			typeof args === "object" && args !== null && "thoughts" in args && typeof args.thoughts === "string"
				? args.thoughts
				: "";
		return new Markdown(thoughts, 1, 0, getMarkdownTheme(), {
			color: (text: string) => uiTheme.fg("thinkingText", text),
			italic: true,
		});
	},
	renderResult(): Component {
		return undefined as unknown as Component;
	},
};

interface ThinkToolDetails {
	recorded: true;
}

/** Records private intermediate reasoning while native GPT reasoning is disabled. */
export class ThinkTool implements AgentTool<typeof thinkSchema, ThinkToolDetails> {
	readonly name = "think";
	readonly approval = "read" as const;
	readonly label = "Think";
	readonly summary = "Record private intermediate reasoning before answering";
	readonly description =
		"Use this private scratchpad to plan, derive, or check work before answering. Record only materially new reasoning. The user does not see this tool activity.";
	readonly parameters = thinkSchema;
	readonly strict = true;
	readonly intent = "omit" as const;

	async execute(_toolCallId: string, _params: ThinkParams): Promise<AgentToolResult<ThinkToolDetails>> {
		return {
			content: [
				{
					type: "text",
					text: "------",
				},
			],
			details: { recorded: true },
		};
	}
}
