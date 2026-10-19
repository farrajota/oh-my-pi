import { clearSubmittedText } from "./draft";
import { commandConsumed } from "./parse";
import type { ParsedSlashCommand, SlashCommandResult, TuiSlashCommandRuntime } from "../types";

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	clearSubmittedText(runtime);
	void runtime.ctx.shutdown();
	return commandConsumed();
};
