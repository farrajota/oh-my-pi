/**
 * Bundled workflow command templates shared by task discovery and slash-command loading.
 *
 * Keep this module dependency-light: importing the embedded markdown must not pull in
 * discovery or the SDK import graph.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import initMd from "../prompts/agents/init.md" with { type: "text" };

const EMBEDDED_COMMANDS: { name: string; content: string }[] = [{ name: "init.md", content: prompt.render(initMd) }];

export const EMBEDDED_COMMAND_TEMPLATES: ReadonlyArray<{ name: string; content: string }> = EMBEDDED_COMMANDS;
