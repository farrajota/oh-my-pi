import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, UserMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem, EditorTheme } from "@oh-my-pi/pi-tui";

const testAgentDir = join(tmpdir(), `omp-prompt-suggestions-${process.pid}`);
mkdirSync(join(testAgentDir, "extensions"), { recursive: true });

const settingsValues = new Map<string, unknown>();
const settingsGetMock = mock((path: string) => settingsValues.get(path));
const completeSimpleMock = mock(async (_model: Model, _context: Context, _options?: SimpleStreamOptions): Promise<AssistantMessage> => ({
	role: "assistant",
	content: [{ type: "text", text: "run the tests" }],
	api: "openai-completions",
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
	timestamp: 0,
}));

const visibleWidth = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").length;

function createTestModel(id: string, reasoning = false, efforts?: readonly Effort[]): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning,
		thinking: efforts ? { mode: "effort", efforts } : undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

function createAssistantMessage(content: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "openai-completions",
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
		timestamp: 0,
	};
}

interface AutocompleteProviderMock {
	getSuggestions: (lines: string[], cursorLine: number, cursorCol: number) => Promise<{ items: AutocompleteItem[]; prefix: string } | null>;
	applyCompletion: (
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
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
		constructor(tui: { requestRender: (force?: boolean) => void }, private theme: EditorTheme) {
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
	cfgPromptSuggestionsEnabled: { get: () => settingsGetMock("promptSuggestions.enabled") },
	cfgPromptSuggestionsModel: { get: () => settingsGetMock("promptSuggestions.model") },
	cfgPromptSuggestionsFallbackModel: { get: () => settingsGetMock("promptSuggestions.fallbackModel") ?? "pi/smol" },
	convertToLlm: (messages: Message[]): Message[] => messages,
	getAgentDir: () => testAgentDir,
	settings: {},
}));

// Dynamic import is required here because Bun test module mocks must be
// installed before this extension's static @oh-my-pi imports are evaluated.
const { __test__, default: ompPromptSuggestions } = await import("../extensions/omp-prompt-suggestions");

function resetTestState() {
	settingsValues.clear();
	settingsValues.set("promptSuggestions.enabled", true);
	settingsValues.set("promptSuggestions.model", "pi/smol");
	settingsValues.set("promptSuggestions.fallbackModel", "pi/smol");
	settingsGetMock.mockClear();
	completeSimpleMock.mockClear();
	settingsGetMock.mockImplementation((path: string) => settingsValues.get(path));
	completeSimpleMock.mockImplementation(async () => createAssistantMessage("run the tests"));
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

let cancelOutstandingTestGeneration: (() => void) | undefined;

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
		model: createTestModel("model"),
		models: {
			resolve: mock((_spec: string): Model | undefined => undefined),
			list: mock((): Model[] => []),
			current: mock((): Model | undefined => undefined),
			family: mock((_model: Model): string => "test-family"),
		},
		modelRegistry: {
			getApiKey: mock(async (_model: Model) => "test"),
			resolver: mock((_model: Model) => "test-resolver"),
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
	const fakePi: Pick<ExtensionAPI, "on" | "setLabel"> = {
		setLabel: mock(() => {}),
		on(event: string, handler: Function): void {
			handlers.set(event, handler);
		},
	};
	ompPromptSuggestions(fakePi);
	cancelOutstandingTestGeneration = () => handlers.get("input")?.({}, ctx);
	handlers.get("session_start")?.({}, ctx);
	editor?.setAutocompleteProvider({
		getSuggestions: async () => ({ items: [], prefix: "" }),
		applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
	});
	return { ctx, editor: () => editor!, fakePi, handlers, requestRender, submit, widgets };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks() {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function withControlledTimers(run: (advance: (milliseconds: number) => Promise<void>) => Promise<void>) {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	// Controlled timers use numeric handles at this test-only boundary.
	function fakeSetTimeout(callback: () => void, delay = 0) {
		const id = ++nextId;
		timers.set(id, { at: now + Number(delay), callback });
		return id;
	}
	globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id: number) => {
		timers.delete(id);
	}) as typeof clearTimeout;
	const advance = async (milliseconds: number) => {
		const target = now + milliseconds;
		while (true) {
			const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			now = next[1].at;
			timers.delete(next[0]);
			next[1].callback();
			await flushMicrotasks();
		}
		now = target;
		await flushMicrotasks();
	};
	try {
		await run(advance);
	} finally {
		cancelOutstandingTestGeneration?.();
		cancelOutstandingTestGeneration = undefined;
		await flushMicrotasks();
		__test__.__resetForTest();
		timers.clear();
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
}

describe("omp prompt suggestions", () => {
	test("default export registers OMP extension handlers", () => {
		resetTestState();
		const handlers: string[] = [];
		const fakePi: Pick<ExtensionAPI, "on" | "setLabel"> = {
			setLabel: mock(() => {}),
			on(event: string): void {
				handlers.push(event);
			},
		};

		ompPromptSuggestions(fakePi);

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

		expect(__test__.getPromptSuggestionModelSpec()).toBe("pi/smol");
		expect(settingsValues.get("promptSuggestions.fallbackModel")).toBe("pi/smol");
		settingsValues.delete("promptSuggestions.fallbackModel");
		expect(__test__.getPromptSuggestionFallbackModelSpec()).toBe("pi/smol");
		settingsValues.set("promptSuggestions.fallbackModel", "  ");
		expect(__test__.getPromptSuggestionFallbackModelSpec()).toBe("pi/smol");
		expect(__test__.normalizeSuggestionModelSpec("smol")).toBe("pi/smol");
		expect(__test__.normalizeSuggestionModelSpec("default")).toBe("pi/default");
		expect(__test__.normalizeSuggestionModelSpec("slow")).toBe("pi/slow");
		expect(__test__.normalizeSuggestionModelSpec("pi/slow")).toBe("pi/slow");
		expect(__test__.normalizeSuggestionModelSpec("cliproxy-codex/gpt-5.5")).toBe("cliproxy-codex/gpt-5.5");
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
		const slowModel = createTestModel("slow");
		settingsValues.set("promptSuggestions.model", "slow");
		settingsValues.set("promptSuggestions.fallbackModel", "provider/custom-fallback");
		harness.ctx.models.resolve.mockImplementation((spec: string) => (spec === "pi/slow" ? slowModel : undefined));

		harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
		await flushMicrotasks();

		expect(harness.ctx.models.resolve).toHaveBeenCalledWith("pi/slow");
		expect(completeSimpleMock.mock.calls[0]?.[0]).toBe(slowModel);
		expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("provider/custom-fallback");
	});

	test("agent_end authenticates suggestions through model registry resolver", async () => {
		const harness = createHarness();
		const selectedModel = createTestModel("gpt-5.4-mini");
		settingsValues.set("promptSuggestions.model", "cliproxy-codex/gpt-5.4-mini");
		harness.ctx.models.resolve.mockImplementation((spec: string) =>
			spec === "cliproxy-codex/gpt-5.4-mini" ? selectedModel : undefined,
		);

		harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
		await flushMicrotasks();

		expect(harness.ctx.models.resolve).toHaveBeenCalledWith("cliproxy-codex/gpt-5.4-mini");
		expect(harness.ctx.modelRegistry.getApiKey).toHaveBeenCalledWith(selectedModel);
		expect(harness.ctx.modelRegistry.resolver).toHaveBeenCalledWith(selectedModel);
		expect(completeSimpleMock.mock.calls[0]?.[2]?.apiKey).toBe("test-resolver");
	});

	test("agent_end uses the lowest supported reasoning effort for suggestion model", async () => {
		const harness = createHarness();
		const selectedModel = createTestModel("gpt-5.4-mini", true, [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		settingsValues.set("promptSuggestions.model", "cliproxy-codex/gpt-5.4-mini");
		harness.ctx.models.resolve.mockImplementation((spec: string) =>
			spec === "cliproxy-codex/gpt-5.4-mini" ? selectedModel : undefined,
		);

		harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
		await flushMicrotasks();

		expect(__test__.getSuggestionReasoningEffort(selectedModel)).toBe(Effort.Low);
		expect(completeSimpleMock.mock.calls[0]?.[2]?.reasoning).toBe(Effort.Low);
	});

	test("agent_end falls back to session model when configured model cannot resolve", async () => {
		const harness = createHarness();
		settingsValues.set("promptSuggestions.model", "missing-role");
		harness.ctx.models.resolve.mockImplementation(() => undefined);

		harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
		await flushMicrotasks();

		expect(harness.ctx.models.resolve).toHaveBeenCalledWith("missing-role");
		expect(completeSimpleMock.mock.calls[0]?.[0]).toBe(harness.ctx.model);
	});

	test("agent_end returns immediately and keeps the primary result before its deadline", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			settingsValues.set("promptSuggestions.fallbackModel", "provider/custom-fallback");
			completeSimpleMock.mockImplementation((model: Model) => model === primaryModel ? primary.promise : Promise.resolve(createAssistantMessage("unexpected fallback")));

			const returned = harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			expect(returned).toBeUndefined();
			await flushMicrotasks();
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			await advance(29_999);
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("pi/smol");
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("provider/custom-fallback");
			primary.resolve(createAssistantMessage("continue with the plan"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).toContain("continue with the plan");
			await advance(1);
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("pi/smol");
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("provider/custom-fallback");
		});
	});

	test("primary timeout uses the configured fallback with its own ten-second deadline", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const fallback = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			const fallbackModel = createTestModel("custom-fallback");
			harness.ctx.models.resolve.mockImplementation((spec: string) =>
				spec === "configured-role" ? primaryModel : spec === "provider/custom-fallback" ? fallbackModel : undefined,
			);
			settingsValues.set("promptSuggestions.model", "configured-role");
			settingsValues.set("promptSuggestions.fallbackModel", "provider/custom-fallback");
			completeSimpleMock.mockImplementation((model: Model) => model === primaryModel ? primary.promise : fallback.promise);

			const returned = harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			expect(returned).toBeUndefined();
			await flushMicrotasks();
			const primarySignal = completeSimpleMock.mock.calls[0]?.[2]?.signal;
			await advance(30_000);
			expect(primarySignal?.aborted).toBe(true);
			expect(harness.ctx.models.resolve).toHaveBeenCalledWith("provider/custom-fallback");
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("pi/smol");
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			const fallbackSignal = completeSimpleMock.mock.calls[1]?.[2]?.signal;
			expect(fallbackSignal).toBeDefined();
			expect(fallbackSignal).not.toBe(primarySignal);
			await advance(9_999);
			expect(harness.editor().render(40).join("\n")).not.toContain("fallback suggestion");
			fallback.resolve(createAssistantMessage("continue with fallback suggestion"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).toContain("continue with fallback suggestion");
			await advance(1);
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		});
	});

	test("fallback timeout aborts and ignores late primary and fallback results", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const fallback = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			const fallbackModel = createTestModel("smol");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : spec === "pi/smol" ? fallbackModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			completeSimpleMock.mockImplementation((model: Model) => model === primaryModel ? primary.promise : fallback.promise);
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			await advance(30_000);
			const fallbackSignal = completeSimpleMock.mock.calls[1]?.[2]?.signal;
			await advance(10_000);
			expect(fallbackSignal?.aborted).toBe(true);
			primary.resolve(createAssistantMessage("late primary text"));
			fallback.resolve(createAssistantMessage("late fallback text"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).not.toContain("late primary text");
			expect(harness.editor().render(40).join("\n")).not.toContain("late fallback text");
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		});
	});
	test("primary timeout normalizes a trimmed fallback role alias", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const fallback = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			const fallbackModel = createTestModel("slow");
			harness.ctx.models.resolve.mockImplementation((spec: string) =>
				spec === "configured-role" ? primaryModel : spec === "pi/slow" ? fallbackModel : undefined,
			);
			settingsValues.set("promptSuggestions.model", "configured-role");
			settingsValues.set("promptSuggestions.fallbackModel", " slow ");
			completeSimpleMock.mockImplementation((model: Model) => model === primaryModel ? primary.promise : fallback.promise);

			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			await advance(30_000);

			expect(harness.ctx.models.resolve).toHaveBeenCalledWith("pi/slow");
			expect(completeSimpleMock.mock.calls[1]?.[0]).toBe(fallbackModel);
			fallback.resolve(createAssistantMessage("continue with the slow fallback"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).toContain("continue with the slow fallback");
		});
	});

	test("unresolved configured fallback is skipped without session or default substitution", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			settingsValues.set("promptSuggestions.fallbackModel", "missing-fallback");
			completeSimpleMock.mockImplementation(() => primary.promise);

			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			await advance(30_000);

			expect(harness.ctx.models.resolve).toHaveBeenCalledWith("missing-fallback");
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("pi/smol");
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			expect(harness.editor().render(40).join("\n")).not.toContain("fallback");
		});
	});

	test("same resolved role receives a fresh pi/smol fallback attempt", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const fallback = deferred<AssistantMessage>();
			const sameModel = createTestModel("smol");
			harness.ctx.models.resolve.mockImplementation(() => sameModel);
			settingsValues.set("promptSuggestions.model", "pi/smol");
			let calls = 0;
			completeSimpleMock.mockImplementation(() => ++calls === 1 ? primary.promise : fallback.promise);
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			const primarySignal = completeSimpleMock.mock.calls[0]?.[2]?.signal;
			await advance(30_000);
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			expect(completeSimpleMock.mock.calls[1]?.[0]).toBe(sameModel);
			expect(completeSimpleMock.mock.calls[1]?.[2]?.signal).not.toBe(primarySignal);
			fallback.resolve(createAssistantMessage("retry on the same model"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).toContain("retry on the same model");
		});
	});

	test("typing in the editor before timeout prevents fallback", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			completeSimpleMock.mockImplementation(() => primary.promise);
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			harness.editor().handleInput("x");
			await advance(30_000);
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("pi/smol");
			expect(harness.editor().getText()).toBe("x");
		});
	});

	test("unresolved pi/smol fallback never substitutes the session model", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			completeSimpleMock.mockImplementation(() => primary.promise);
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			await advance(30_000);
			expect(harness.ctx.models.resolve).toHaveBeenCalledWith("pi/smol");
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			expect(completeSimpleMock.mock.calls[0]?.[0]).toBe(primaryModel);
		});
	});

	test("ordinary primary errors and empty output do not trigger fallback", async () => {
		for (const result of [() => Promise.reject(new Error("primary failed")), () => Promise.resolve(createAssistantMessage(""))]) {
			const harness = createHarness();
			const primaryModel = createTestModel("primary");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			completeSimpleMock.mockImplementation(() => result());
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("pi/smol");
		}
	});

	test("new input cancels a pending primary timeout without fallback", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			completeSimpleMock.mockImplementation(() => primary.promise);
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			const signal = completeSimpleMock.mock.calls[0]?.[2]?.signal;
			harness.handlers.get("input")?.({}, harness.ctx);
			expect(signal?.aborted).toBe(true);
			await advance(30_000);
			expect(harness.ctx.models.resolve).not.toHaveBeenCalledWith("pi/smol");
			primary.resolve(createAssistantMessage("stale primary result"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).not.toContain("stale primary result");
		});
	});

	test("agent and session starts cancel pending primary work", async () => {
		for (const eventName of ["agent_start", "session_start"]) {
			await withControlledTimers(async () => {
				const harness = createHarness();
				const primary = deferred<AssistantMessage>();
				const primaryModel = createTestModel("primary");
				harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
				settingsValues.set("promptSuggestions.model", "configured-role");
				completeSimpleMock.mockImplementation(() => primary.promise);
				harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
				await flushMicrotasks();
				const signal = completeSimpleMock.mock.calls[0]?.[2]?.signal;
				harness.handlers.get(eventName)?.({}, harness.ctx);
				expect(signal?.aborted).toBe(true);
			});
		}
	});

	test("a newer agent_end cancels and invalidates the previous generation", async () => {
		await withControlledTimers(async () => {
			const harness = createHarness();
			const previous = deferred<AssistantMessage>();
			const current = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			let calls = 0;
			completeSimpleMock.mockImplementation(() => ++calls === 1 ? previous.promise : current.promise);
			const event = { messages: [createAssistantMessage("done")] };
			harness.handlers.get("agent_end")?.(event, harness.ctx);
			await flushMicrotasks();
			const previousSignal = completeSimpleMock.mock.calls[0]?.[2]?.signal;
			harness.handlers.get("agent_end")?.(event, harness.ctx);
			await flushMicrotasks();
			const currentSignal = completeSimpleMock.mock.calls[1]?.[2]?.signal;
			expect(previousSignal?.aborted).toBe(true);
			expect(currentSignal).toBeDefined();
			expect(currentSignal?.aborted).toBe(false);
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);

			previous.resolve(createAssistantMessage("stale previous result"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).not.toContain("stale previous result");
			expect(harness.editor().render(40).join("\n")).not.toContain("current generation result");

			current.resolve(createAssistantMessage("current generation result"));
			await flushMicrotasks();
			expect(harness.editor().render(40).join("\n")).toContain("current generation result");
		});
	});

	test("late primary authentication after timeout cannot start a stale completion", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primaryAuth = deferred<string>();
			const fallback = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			const fallbackModel = createTestModel("smol");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : spec === "pi/smol" ? fallbackModel : undefined);
			harness.ctx.modelRegistry.getApiKey.mockImplementation((model: Model) => model === primaryModel ? primaryAuth.promise : Promise.resolve("fallback-key"));
			settingsValues.set("promptSuggestions.model", "configured-role");
			completeSimpleMock.mockImplementation(() => fallback.promise);
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			expect(completeSimpleMock).not.toHaveBeenCalled();
			await advance(30_000);
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			primaryAuth.resolve("late-primary-key");
			await flushMicrotasks();
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		});
	});

	test("session shutdown cancels pending fallback and ignores its late result", async () => {
		await withControlledTimers(async (advance) => {
			const harness = createHarness();
			const primary = deferred<AssistantMessage>();
			const fallback = deferred<AssistantMessage>();
			const primaryModel = createTestModel("primary");
			const fallbackModel = createTestModel("smol");
			harness.ctx.models.resolve.mockImplementation((spec: string) => spec === "configured-role" ? primaryModel : spec === "pi/smol" ? fallbackModel : undefined);
			settingsValues.set("promptSuggestions.model", "configured-role");
			completeSimpleMock.mockImplementation((model: Model) => model === primaryModel ? primary.promise : fallback.promise);
			harness.handlers.get("agent_end")?.({ messages: [createAssistantMessage("done")] }, harness.ctx);
			await flushMicrotasks();
			await advance(30_000);
			const fallbackSignal = completeSimpleMock.mock.calls[1]?.[2]?.signal;
			harness.handlers.get("session_shutdown")?.({}, harness.ctx);
			expect(fallbackSignal?.aborted).toBe(true);
			fallback.resolve(createAssistantMessage("stale fallback result"));
			await flushMicrotasks();
			expect(harness.ctx.ui.setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
		});
	});

	test("settings toggle disables suggestions", async () => {
		const harness = createHarness();
		settingsValues.set("promptSuggestions.enabled", false);

		harness.handlers.get("agent_end")?.({ messages: [] }, harness.ctx);
		await flushMicrotasks();
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
		const messages: UserMessage[] = Array.from({ length: 10 }, (_value, index) => ({
			role: "user",
			content: `message ${index}`,
			timestamp: index,
		}));

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
