import { describe, expect, test } from "bun:test";

import { ExtensionRunner } from "../runner";
import type {
	Extension,
	ExtensionError,
	ExtensionRuntime,
	WorkingMessageSuffixContext,
	WorkingMessageSuffixRenderer,
} from "../types";

function extension(resolvedPath: string, suffixes: Extension["workingMessageSuffixes"]): Extension {
	return {
		path: resolvedPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		assistantThinkingRenderers: [],
		messageRenderers: new Map(),
		workingMessageSuffixes: suffixes,
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function runner(extensions: Extension[]): ExtensionRunner {
	return new ExtensionRunner(
		extensions,
		{} as ExtensionRuntime,
		"/workspace/project",
		{} as ConstructorParameters<typeof ExtensionRunner>[3],
		{} as ConstructorParameters<typeof ExtensionRunner>[4],
	);
}

const context: WorkingMessageSuffixContext = {
	now: 1_700_000_005_250,
	startedAt: 1_700_000_000_000,
	elapsedMs: 5_250,
	runTokenDelta: 42,
	cwd: "/workspace/project",
};

describe("ExtensionRunner.renderWorkingMessageSuffix", () => {
	test("returns an empty string when no suffix renderer returns text", () => {
		const suffix = runner([
			extension(
				"/extensions/empty.ts",
				new Map<string, WorkingMessageSuffixRenderer>([
					["undefined", () => undefined],
					["empty", () => ""],
				]),
			),
		]).renderWorkingMessageSuffix("Working", context);

		expect(suffix).toBe("");
	});

	test("concatenates suffixes by extension order then registration order", () => {
		const suffix = runner([
			extension(
				"/extensions/first.ts",
				new Map([
					["a", message => ` [${message}]`],
					[
						"b",
						(_message, suffixContext) => ` [${suffixContext.elapsedMs}ms/+${suffixContext.runTokenDelta} tokens]`,
					],
				]),
			),
			extension("/extensions/second.ts", new Map([["c", () => " [second]"]])),
		]).renderWorkingMessageSuffix("Working", context);

		expect(suffix).toBe(" [Working] [5250ms/+42 tokens] [second]");
	});

	test("isolates a throwing renderer, emits one error, and disables it after the first failure", () => {
		let throwingCalls = 0;
		const errors: ExtensionError[] = [];
		const subject = runner([
			extension(
				"/extensions/faulty.ts",
				new Map([
					[
						"faulty",
						() => {
							throwingCalls += 1;
							throw new Error("suffix failed");
						},
					],
					["healthy", () => " [healthy]"],
				]),
			),
			extension("/extensions/next.ts", new Map([["next", () => " [next]"]])),
		]);
		subject.onError(error => errors.push(error));

		expect(subject.renderWorkingMessageSuffix("Working", context)).toBe(" [healthy] [next]");
		expect(subject.renderWorkingMessageSuffix("Working", context)).toBe(" [healthy] [next]");
		expect(throwingCalls).toBe(1);
		expect(errors).toEqual([
			{
				extensionPath: "/extensions/faulty.ts",
				event: "working_message_suffix:faulty",
				error: "suffix failed",
				stack: expect.any(String),
			},
		]);
	});
});
