import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testAgentDir = join(tmpdir(), `omp-prompt-suggestions-${process.pid}`);
mkdirSync(join(testAgentDir, "extensions"), { recursive: true });

const settingsValues = new Map<string, unknown>();
const settingsGetMock = mock((path: string) => settingsValues.get(path));
const completeSimpleMock = mock(async () => ({
	stopReason: "stop",
	content: [{ type: "text", text: "run the tests" }],
}));

const visibleWidth = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").length;

interface AutocompleteProviderMock {
	getSuggestions: (lines: string[], cursorLine: number, cursorCol: number) => unknown;
	applyCompletion: (
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: unknown,
		prefix: string,
	) => { lines: string[]; cursorLine: number; cursorCol: number };
	getInlineHint?: (lines: string[], cursorLine: number, cursorCol: number) => string | null | undefined;
}

mock.module("@oh-my-pi/pi-tui", () => ({
	Key: {
		backspace: "backspace",
		delete: "delete",
		enter: "enter",
		right: "right",
		tab: "tab",
	},
	matchesKey: (data: string, key: string) => data === key,
	truncateToWidth: (text: string, width: number) => text.slice(0, Math.max(0, width)),
	visibleWidth,
}));

mock.module("@oh-my-pi/pi-ai", () => ({
	completeSimple: completeSimpleMock,
}));

mock.module("@oh-my-pi/pi-coding-agent", () => ({
	CustomEditor: class {
		onSubmit?: (value: string) => void;
		protected tui: { requestRender: (force?: boolean) => void };
		private value = "";
		private autocompleteProvider?: AutocompleteProviderMock;
		constructor(tui: { requestRender: (force?: boolean) => void }, private theme: any) {
			this.tui = tui;
		}

		getText() {
			return this.value;
		}

		setText(value: string) {
			this.value = value;
		}

		setAutocompleteProvider(provider: AutocompleteProviderMock) {
			this.autocompleteProvider = provider;
		}

		render(width: number) {
			void this.theme.symbols.boxRound;
			const hint = this.value.length === 0 ? (this.autocompleteProvider?.getInlineHint?.([""], 0, 0) ?? "") : "";
			const content = this.value || `|${hint}`;
			return ["top".padEnd(width), content.slice(0, Math.max(0, width)).padEnd(width), "bottom".padEnd(width)];
		}

		handleInput(data: string) {
			if (data === "enter") {
				this.onSubmit?.(this.value);
				return;
			}
			if (data === "backspace") {
				this.value = this.value.slice(0, -1);
				return;
			}
			if (data === "delete") {
				this.value = "";
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) this.value += data;
		}
	},
	convertToLlm: (messages: unknown[]) => messages,
	getAgentDir: () => testAgentDir,
	settings: {
		get: settingsGetMock,
	},
}));

// Dynamic import is required here because Bun test module mocks must be
// installed before this extension's static @oh-my-pi imports are evaluated.
const { __test__, default: ompPromptSuggestions } = await import("../extensions/omp-prompt-suggestions");

function resetTestState() {
	settingsValues.clear();
	settingsValues.set("promptSuggestions.enabled", true);
	settingsValues.set("promptSuggestions.model", "pi/smol");
	settingsGetMock.mockClear();
	settingsGetMock.mockImplementation((path: string) => settingsValues.get(path));
	completeSimpleMock.mockClear();
	__test__.__resetForTest();
}

function createEditorTheme() {
	const style = (text: string) => text;
	const boxRound = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" };
	const boxSharp = {
		...boxRound,
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		teeDown: "┬",
		teeUp: "┴",
		teeLeft: "┤",
		teeRight: "├",
		cross: "┼",
	};
	const symbols = { cursor: "❯", inputCursor: "▏", boxRound, boxSharp, table: boxSharp, quoteBorder: "▏", hrChar: "─", spinnerFrames: ["-"] };
	return {
		borderColor: style,
		selectList: { selectedPrefix: style, selectedText: style, description: style, scrollInfo: style, noMatch: style, symbols, hovered: style },
		symbols,
		hintStyle: style,
	};
}

function createHarness(options: { cwd?: string; editorTheme?: unknown } = {}) {
	resetTestState();
	const handlers = new Map<string, Function>();
	const widgets = new Map<string, unknown>();
	let editor: InstanceType<typeof __test__.SuggestionEditor> | undefined;
	const requestRender = mock(() => {});
	const submit = mock(() => {});
	const ctx = {
		cwd: options.cwd ?? "/workspace",
		hasUI: true,
		hasPendingMessages: mock(() => false),
		model: { provider: "test", id: "model", reasoning: false },
		models: {
			resolve: mock(() => undefined),
			list: mock(() => []),
			current: mock(() => undefined),
			family: mock(() => undefined),
		},
		modelRegistry: {
			getApiKey: mock(async () => "test"),
			resolver: mock(() => "test-resolver"),
		},
		ui: {
			setEditorComponent: mock((factory?: Function) => {
				if (!factory) {
					editor = undefined;
					return;
				}
				editor = factory({ requestRender }, options.editorTheme ?? createEditorTheme(), {});
				editor!.onSubmit = submit;
			}),
			getEditorText: () => editor?.getText() ?? "",
			setWidget: mock((key: string, value: unknown) => widgets.set(key, value)),
			setStatus: mock(() => {}),
			notify: mock(() => {}),
		},
	};
	const fakePi = {
		setLabel: mock(() => {}),
		on: mock((event: string, handler: Function) => handlers.set(event, handler)),
	};
	ompPromptSuggestions(fakePi as never);
	handlers.get("session_start")?.({}, ctx);
	editor?.setAutocompleteProvider({
		getSuggestions: () => null,
		applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
	});
	return { ctx, editor: () => editor!, fakePi, handlers, requestRender, submit, widgets };
}

describe("omp prompt suggestions", () => {
	test("default export registers OMP extension handlers", () => {
		resetTestState();
		const handlers: string[] = [];
		const fakePi = {
			setLabel: mock(() => {}),
			on: mock((event: string) => handlers.push(event)),
		};

		ompPromptSuggestions(fakePi as never);

		expect(fakePi.setLabel).toHaveBeenCalledWith("OMP prompt suggestions");
		expect(handlers.sort()).toEqual(["agent_end", "agent_start", "input", "session_shutdown", "session_start"].sort());
	});

	test("defaults accept Tab for OMP", () => {
		resetTestState();
		const config = __test__.mergeConfigInputs();
		expect(config.acceptTab).toBe(true);
		expect(config.display).toBe("ghost");
		expect(config.maxTokens).toBe(256);
		expect(config.maxChars).toBe(80);
		expect("enabled" in config).toBe(false);
	});

	test("defaults use smol suggestion model role", () => {
		resetTestState();
		settingsValues.delete("promptSuggestions.model");

		expect(__test__.getPromptSuggestionModelSpec()).toBe("pi/smol");
		expect(__test__.normalizeSuggestionModelSpec("smol")).toBe("pi/smol");
		expect(__test__.normalizeSuggestionModelSpec("default")).toBe("pi/default");
		expect(__test__.normalizeSuggestionModelSpec("slow")).toBe("pi/slow");
		expect(__test__.normalizeSuggestionModelSpec("pi/slow")).toBe("pi/slow");
		expect(__test__.normalizeSuggestionModelSpec("cliproxy-codex/gpt-5.5")).toBe("cliproxy-codex/gpt-5.5");
	});

	test("settings getters fall back when schema path segments are missing", () => {
		resetTestState();
		settingsGetMock.mockImplementation(() => {
			throw new TypeError("undefined is not an object (evaluating 'segments')");
		});

		expect(__test__.isPromptSuggestionsEnabled()).toBe(true);
		expect(__test__.getPromptSuggestionModelSpec()).toBe("pi/smol");
	});

	test("settings getters rethrow unrelated settings errors", () => {
		resetTestState();
		settingsGetMock.mockImplementation(() => {
			throw new Error("settings unavailable");
		});

		expect(() => __test__.isPromptSuggestionsEnabled()).toThrow("settings unavailable");
	});

	test("agent_end resolves configured role model through ctx models", async () => {
		const harness = createHarness();
		const slowModel = { provider: "test", id: "slow", reasoning: false };
		settingsValues.set("promptSuggestions.model", "slow");
		harness.ctx.models.resolve.mockImplementation((spec: string) => (spec === "pi/slow" ? slowModel : undefined));

		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: "done" }] }, harness.ctx);

		expect(harness.ctx.models.resolve).toHaveBeenCalledWith("pi/slow");
		expect(completeSimpleMock.mock.calls[0]?.[0]).toBe(slowModel);
	});

	test("agent_end authenticates suggestions through model registry resolver", async () => {
		const harness = createHarness();
		const selectedModel = { provider: "cliproxy-codex", id: "gpt-5.4-mini", reasoning: false };
		settingsValues.set("promptSuggestions.model", "cliproxy-codex/gpt-5.4-mini");
		harness.ctx.models.resolve.mockImplementation((spec: string) =>
			spec === "cliproxy-codex/gpt-5.4-mini" ? selectedModel : undefined,
		);

		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: "done" }] }, harness.ctx);

		expect(harness.ctx.models.resolve).toHaveBeenCalledWith("cliproxy-codex/gpt-5.4-mini");
		expect(harness.ctx.modelRegistry.getApiKey).toHaveBeenCalledWith(selectedModel);
		expect(harness.ctx.modelRegistry.resolver).toHaveBeenCalledWith(selectedModel);
		expect(completeSimpleMock.mock.calls[0]?.[2]?.apiKey).toBe("test-resolver");
	});

	test("agent_end uses the lowest supported reasoning effort for suggestion model", async () => {
		const harness = createHarness();
		const selectedModel = {
			provider: "cliproxy-codex",
			id: "gpt-5.4-mini",
			reasoning: true,
			thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh"] },
		};
		settingsValues.set("promptSuggestions.model", "cliproxy-codex/gpt-5.4-mini");
		harness.ctx.models.resolve.mockImplementation((spec: string) =>
			spec === "cliproxy-codex/gpt-5.4-mini" ? selectedModel : undefined,
		);

		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: "done" }] }, harness.ctx);

		expect(__test__.getSuggestionReasoningEffort(selectedModel)).toBe("low");
		expect(completeSimpleMock.mock.calls[0]?.[2]?.reasoning).toBe("low");
	});

	test("agent_end falls back to session model when configured model cannot resolve", async () => {
		const harness = createHarness();
		settingsValues.set("promptSuggestions.model", "missing-role");
		harness.ctx.models.resolve.mockImplementation(() => undefined);

		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: "done" }] }, harness.ctx);

		expect(harness.ctx.models.resolve).toHaveBeenCalledWith("missing-role");
		expect(completeSimpleMock.mock.calls[0]?.[0]).toBe(harness.ctx.model);
	});

	test("settings toggle disables suggestions", async () => {
		const harness = createHarness();
		settingsValues.set("promptSuggestions.enabled", false);

		await harness.handlers.get("agent_end")?.({ messages: [] }, harness.ctx);
		expect(completeSimpleMock).not.toHaveBeenCalled();

		settingsValues.set("promptSuggestions.enabled", true);
		__test__.showSuggestion("run the tests", harness.ctx);
		settingsValues.set("promptSuggestions.enabled", false);
		expect(harness.editor().render(40).join("\n")).not.toContain("run the tests");
		harness.editor().handleInput("tab");
		expect(harness.editor().getText()).toBe("");

		settingsValues.set("promptSuggestions.enabled", true);
		__test__.showSuggestion("run the tests", harness.ctx);
		harness.editor().handleInput("r");
		settingsValues.set("promptSuggestions.enabled", false);
		harness.editor().handleInput("backspace");
		expect(harness.editor().render(40).join("\n")).not.toContain("run the tests");
	});

	test("config can disable Tab acceptance", () => {
		resetTestState();
		expect(__test__.mergeConfigInputs({ acceptTab: false }).acceptTab).toBe(false);
	});

	test("JSON enabled is ignored with warning", () => {
		resetTestState();
		const warnings: string[] = [];
		const parsed = __test__.parseConfigInput({ enabled: false, acceptTab: true }, "config", (message: string) => warnings.push(message));
		const merged = __test__.mergeConfigInputs(parsed);

		expect(merged.acceptTab).toBe(true);
		expect("enabled" in merged).toBe(false);
		expect(warnings).toContain("prompt-suggestions: ignore enabled from JSON config; use /settings → Interaction → Input → Prompt Suggestions");
	});

	test("JSON model is ignored with warning", () => {
		resetTestState();
		const warnings: string[] = [];
		const parsed = __test__.parseConfigInput({ model: "slow", acceptTab: true }, "config", (message: string) => warnings.push(message));
		const merged = __test__.mergeConfigInputs(parsed);

		expect(merged.acceptTab).toBe(true);
		expect("model" in merged).toBe(false);
		expect(warnings).toEqual([
			"prompt-suggestions: ignore model from JSON config; use /settings -> Interaction -> Input -> Prompt Suggestions Model",
		]);
	});

	test("ghost suggestion renders through inline hint without cursor sentinel", () => {
		const harness = createHarness();

		__test__.showSuggestion("run the tests", harness.ctx);

		const rendered = harness.editor().render(40).join("\n");
		expect(rendered).toContain("run the tests");
		expect(rendered).toContain("|run the tests");
		expect(harness.requestRender).toHaveBeenCalled();
	});

	test("custom editor normalizes partial editor theme", () => {
		const harness = createHarness({ editorTheme: {} });

		__test__.showSuggestion("run the tests", harness.ctx);

		expect(harness.editor().render(40).join("\n")).toContain("run the tests");
	});

	test("belowEditor display still renders widget", () => {
		const cwd = join(tmpdir(), `omp-prompt-suggestions-below-${process.pid}-${Date.now()}`);
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(join(cwd, ".omp", "prompt-suggestions.json"), JSON.stringify({ display: "belowEditor" }));
		const harness = createHarness({ cwd });

		__test__.showSuggestion("run the tests", harness.ctx);

		expect(harness.ctx.ui.setWidget).toHaveBeenCalledWith("next-prompt-suggestion", expect.any(Function), {
			placement: "belowEditor",
		});
		const widgetFactory = harness.ctx.ui.setWidget.mock.calls.at(-1)?.[1] as Function;
		const widget = widgetFactory({}, { fg: (_name: string, text: string) => text });
		const rendered = widget.render(40).join("\n");
		expect(rendered).toContain("run the tests");
	});

	test("Tab accepts visible suggestion without submitting", () => {
		const harness = createHarness();
		__test__.showSuggestion("run the tests", harness.ctx);

		harness.editor().handleInput("tab");

		expect(harness.editor().getText()).toBe("run the tests");
		for (const _char of "run the tests") harness.editor().handleInput("backspace");
		expect(harness.editor().render(40).join("\n")).not.toContain("run the tests");
		expect(harness.submit).not.toHaveBeenCalled();
	});

	test("typing hides ghost but preserves cache", () => {
		const harness = createHarness();
		__test__.showSuggestion("run the tests", harness.ctx);

		harness.editor().handleInput("r");

		expect(harness.editor().getText()).toBe("r");
		expect(harness.editor().render(40).join("\n")).not.toContain("run the tests");
		harness.editor().handleInput("backspace");
		expect(harness.editor().render(40).join("\n")).toContain("run the tests");
	});

	test("deleting back to empty restores same suggestion", () => {
		const harness = createHarness();
		__test__.showSuggestion("run the tests", harness.ctx);
		harness.editor().handleInput("r");
		harness.editor().handleInput("u");

		harness.editor().handleInput("backspace");
		expect(harness.editor().render(40).join("\n")).not.toContain("run the tests");
		harness.editor().handleInput("backspace");

		expect(harness.editor().getText()).toBe("");
		expect(harness.editor().render(40).join("\n")).toContain("run the tests");
	});

	test("accepted suggestion does not reappear after deletion", () => {
		const harness = createHarness();
		__test__.showSuggestion("run the tests", harness.ctx);
		harness.editor().handleInput("tab");

		for (const _char of "run the tests") harness.editor().handleInput("backspace");

		expect(harness.editor().getText()).toBe("");
		expect(harness.editor().render(40).join("\n")).not.toContain("run the tests");
	});

	test("context uses last eight messages", () => {
		resetTestState();
		const messages = Array.from({ length: 10 }, (_value, index) => ({ role: "user", content: `message ${index}` }));
		const context = __test__.buildSuggestionContext(messages);

		expect(context).not.toContain("message 0");
		expect(context).not.toContain("message 1");
		for (let index = 2; index < 10; index++) expect(context).toContain(`message ${index}`);
	});

	test("sanitize rejects questions/meta/overlong output and accepts imperative prompt", () => {
		resetTestState();
		expect(__test__.sanitizeSuggestion("run the tests")).toBe("run the tests");
		expect(__test__.sanitizeSuggestion("what next?")).toBeUndefined();
		expect(__test__.sanitizeSuggestion("No suggestion")).toBeUndefined();
		expect(__test__.sanitizeSuggestion("this suggestion is too long", 10)).toBeUndefined();
	});
});
