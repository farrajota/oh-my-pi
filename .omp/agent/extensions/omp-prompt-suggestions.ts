import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	convertToLlm,
	getAgentDir,
	settings,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { completeSimple, type AssistantMessage, type Effort, type Message, type Model } from "@oh-my-pi/pi-ai";
import { Key, matchesKey, truncateToWidth, type AutocompleteProvider, type EditorTheme, type TUI } from "@oh-my-pi/pi-tui";

const WIDGET_KEY = "next-prompt-suggestion";
const DEFAULT_MAX_CHARS = 80;
const DEFAULT_MAX_TOKENS = 256;
const GLOBAL_CONFIG_RELATIVE_PATHS = [
	["extensions", "prompt-suggestions.json"],
	["prompt-suggestions.json"],
] as const;
const PROJECT_CONFIG_RELATIVE_PATHS = [
	[".omp", "prompt-suggestions.json"],
	[".pi", "prompt-suggestions.json"],
] as const;
const JSON_ENABLED_WARNING = "prompt-suggestions: ignore enabled from JSON config; use /settings → Interaction → Input → Prompt Suggestions";
const DEFAULT_SUGGESTION_MODEL = "pi/smol";
const JSON_MODEL_WARNING = "prompt-suggestions: ignore model from JSON config; use /settings -> Interaction -> Input -> Prompt Suggestions Model";
const PROMPT_SUGGESTION_MODEL_ROLE_ALIASES: Record<string, string> = {
	smol: "pi/smol",
	default: "pi/default",
	slow: "pi/slow",
};
const ALLOWED_SINGLE_WORD_SUGGESTIONS: Record<string, true> = {
	"yes": true,
	"yeah": true,
	"yep": true,
	"yea": true,
	"yup": true,
	"sure": true,
	"ok": true,
	"okay": true,
	"push": true,
	"commit": true,
	"deploy": true,
	"stop": true,
	"continue": true,
	"check": true,
	"exit": true,
	"quit": true,
	"no": true,
};

type SuggestionDisplayMode = "ghost" | "belowEditor";

interface PromptSuggestionsConfig {
	acceptTab: boolean;
	display: SuggestionDisplayMode;
	maxChars: number;
	maxTokens: number;
}

type PromptSuggestionsConfigInput = Partial<PromptSuggestionsConfig>;
type PromptSuggestionSettingPath = "promptSuggestions.enabled" | "promptSuggestions.model";

let cachedSuggestion: string | undefined;
let visibleSuggestion: string | undefined;
let suggestionHiddenByUserEdit = false;
let generationId = 0;
let lastCtx: ExtensionContext | undefined;
let currentConfig: PromptSuggestionsConfig = mergeConfigInputs();
let currentEditor: SuggestionEditor | undefined;

class SuggestionEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings?: unknown) {
		super(tui, coerceEditorTheme(theme), keybindings);
	}

	requestRender(): void {
		this.tui.requestRender(true);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(wrapSuggestionAutocompleteProvider(provider));
	}

	handleInput(data: string): void {
		if (!isPromptSuggestionsEnabled()) {
			super.handleInput(data);
			return;
		}

		if (this.getText().length === 0 && visibleSuggestion) {
			if (matchesKey(data, Key.right) || (currentConfig.acceptTab && matchesKey(data, Key.tab))) {
				this.setText(acceptSuggestion() ?? "");
				return;
			}

			if (matchesKey(data, Key.enter)) {
				this.setText(acceptSuggestion() ?? "");
				super.handleInput(data);
				return;
			}
		}

		if (visibleSuggestion && isPrintableOrMutatingEditKey(data)) hideVisibleSuggestion();

		super.handleInput(data);

		if (canRestoreSuggestionAfterKey(data)) restoreVisibleSuggestionIfEditorEmpty();
	}
}

export default function ompPromptSuggestions(pi: ExtensionAPI): void {
	pi.setLabel("OMP prompt suggestions");

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		currentConfig = loadConfig(ctx.cwd, (message) => debug(ctx, message));
		resetSuggestion(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			currentEditor = new SuggestionEditor(tui, theme, keybindings);
			return currentEditor;
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		resetSuggestion(ctx);
	});

	pi.on("input", (_event, ctx) => {
		lastCtx = ctx;
		resetSuggestion(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		resetSuggestion(ctx);
		ctx.ui.setEditorComponent(undefined);
		currentEditor = undefined;
		lastCtx = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		lastCtx = ctx;
		resetSuggestion(ctx);

		if (!isPromptSuggestionsEnabled()) {
			resetSuggestion(ctx);
			return;
		}

		const config = loadConfig(ctx.cwd, (message) => debug(ctx, message));
		if (!ctx.hasUI) return;
		if (ctx.hasPendingMessages()) return debug(ctx, "skipped: pending messages");
		if (ctx.ui.getEditorText().trim().length > 0) return debug(ctx, "skipped: editor is not empty");

		const model = resolveSuggestionModel(ctx, getPromptSuggestionModelSpec());
		if (!model) return debug(ctx, "skipped: no model selected");

		const id = ++generationId;
		debug(ctx, "generating...");

		try {
			const text = await generateSuggestion(event.messages, ctx, model, config);
			debug(ctx, `raw: ${JSON.stringify(truncatePlain(text, 160))}`);
			if (id !== generationId) return debug(ctx, "ignored: stale result");
			if (ctx.hasPendingMessages()) return debug(ctx, "ignored: pending messages appeared");
			if (ctx.ui.getEditorText().trim().length > 0) return debug(ctx, "ignored: editor became non-empty");

			const clean = sanitizeSuggestion(text, config.maxChars);
			if (!clean) return debug(ctx, `rejected: ${JSON.stringify(truncatePlain(text, 160))}`);

			showSuggestion(clean, ctx);
			debug(ctx, `shown: ${clean}`);
		} catch (error) {
			debug(ctx, `error: ${error instanceof Error ? error.message : String(error)}`);
			// Suggestion generation is best-effort and must never interrupt normal use.
		}
	});
}

function readPromptSuggestionSetting(path: PromptSuggestionSettingPath, fallback: unknown): unknown {
	try {
		return settings.get(path as never);
	} catch (error) {
		if (error instanceof TypeError && String(error.message).includes("segments")) return fallback;
		throw error;
	}
}

function isPromptSuggestionsEnabled(): boolean {
	return readPromptSuggestionSetting("promptSuggestions.enabled", true) !== false;
}

function resetSuggestion(ctx = lastCtx): void {
	const hadVisibleSuggestion = visibleSuggestion !== undefined;
	generationId++;
	cachedSuggestion = undefined;
	visibleSuggestion = undefined;
	suggestionHiddenByUserEdit = false;
	ctx?.ui.setWidget(WIDGET_KEY, undefined);
	if (hadVisibleSuggestion && currentConfig.display === "ghost") currentEditor?.requestRender();
}

function showSuggestion(text: string, ctx = lastCtx): void {
	if (!isPromptSuggestionsEnabled()) {
		resetSuggestion(ctx);
		return;
	}
	cachedSuggestion = text;
	visibleSuggestion = text;
	suggestionHiddenByUserEdit = false;
	renderSuggestion(ctx);
}

function hideVisibleSuggestion(ctx = lastCtx): void {
	const hadVisibleSuggestion = visibleSuggestion !== undefined;
	visibleSuggestion = undefined;
	if (cachedSuggestion) suggestionHiddenByUserEdit = true;
	ctx?.ui.setWidget(WIDGET_KEY, undefined);
	if (hadVisibleSuggestion && currentConfig.display === "ghost") currentEditor?.requestRender();
}

function restoreVisibleSuggestionIfEditorEmpty(ctx = lastCtx): void {
	if (
		isPromptSuggestionsEnabled() &&
		cachedSuggestion &&
		!visibleSuggestion &&
		suggestionHiddenByUserEdit &&
		currentEditor?.getText().length === 0 &&
		ctx?.hasPendingMessages() === false
	) {
		visibleSuggestion = cachedSuggestion;
		suggestionHiddenByUserEdit = false;
		renderSuggestion(ctx);
	}
}

function acceptSuggestion(ctx = lastCtx): string | undefined {
	const accepted = visibleSuggestion;
	resetSuggestion(ctx);
	return accepted;
}

function renderSuggestion(ctx = lastCtx): void {
	if (!ctx) return;
	currentConfig = loadConfig(ctx.cwd, (message) => debug(ctx, message));
	if (!isPromptSuggestionsEnabled() || !visibleSuggestion) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (currentConfig.display === "ghost") currentEditor?.requestRender();
		return;
	}
	if (currentConfig.display === "ghost") {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		currentEditor?.requestRender();
		return;
	}
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render: (width: number) => [truncateToWidth(theme.fg("dim", `→ ${visibleSuggestion}`), width)],
			invalidate: () => {},
		}),
		{ placement: "belowEditor" },
	);
}



function getSuggestionReasoningEffort(model: Model<any>): Effort | undefined {
	if (!model.reasoning) return undefined;
	const efforts = model.thinking?.efforts;
	if (Array.isArray(efforts) && efforts.length > 0) return efforts.includes("minimal" as Effort) ? ("minimal" as Effort) : efforts[0];
	return "minimal" as Effort;
}
async function generateSuggestion(
	messages: AgentEndEvent["messages"],
	ctx: ExtensionContext,
	model: Model<any>,
	config: PromptSuggestionsConfig,
): Promise<string> {
	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) {
		debug(ctx, `auth unavailable: no API key for ${model.provider}/${model.id}`);
		return "";
	}

	const llmMessages = convertToLlm(messages);
	const context = buildSuggestionContext(llmMessages);
	debug(ctx, `context: ${JSON.stringify(truncatePlain(context, 240))}`);
	const options = {
		apiKey: ctx.modelRegistry.resolver(model),
		maxTokens: config.maxTokens,
		reasoning: getSuggestionReasoningEffort(model),
	};

	const response = await completeSimple(
		model,
		{
			systemPrompt: loadSuggestionSystemPrompt(ctx.cwd, (message) => debug(ctx, message)),
			messages: [
				{
					role: "user",
					content: context,
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	debug(
		ctx,
		`response: ${response.stopReason}; ${response.content.map((part) => part.type).join(",")}; ${response.errorMessage ?? ""}`,
	);
	if (response.diagnostics?.length) {
		debug(ctx, `diagnostics: ${JSON.stringify(response.diagnostics).slice(0, 500)}`);
	}
	return extractAssistantText(response);
}

function loadSuggestionSystemPrompt(cwd: string, onWarning?: (message: string) => void): string {
	for (const promptPath of [
		join(cwd, ".omp", "prompt-suggestions-system-prompt.md"),
		join(getAgentDir(), "extensions", "prompt-suggestions-system-prompt.md"),
	]) {
		if (!existsSync(promptPath)) continue;
		try {
			return readFileSync(promptPath, "utf-8").trim();
		} catch (error) {
			onWarning?.(`prompt load failed: ${promptPath}: ${error instanceof Error ? error.message : String(error)}`);
			return FALLBACK_SUGGESTION_SYSTEM_PROMPT;
		}
	}
	return FALLBACK_SUGGESTION_SYSTEM_PROMPT;
}

const FALLBACK_SUGGESTION_SYSTEM_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into pi.]

First, look at the user's recent messages, original request, and the assistant's latest response.
Predict what the user would naturally type next, not what you think they should do.

The test: would the user think "I was just about to type that"?

Good suggestions:
- are 2-12 words
- match the user's style
- are specific
- continue an obvious workflow
- are imperative user prompts like "run the tests" or "commit this"
- follow an explicit user-stated next request

Examples:
- User asked to fix a bug and tests were not run: run the tests
- User asked to create or edit package.json with a test script and tests were not run: run the tests
- User said "count to 10 and then I will ask you to count to 20" and assistant counted to 10: count to 20
- Code was written and obvious manual check remains: try it out
- Assistant asks whether to continue: yes
- Task complete and changes are ready: commit this

Never suggest:
- thanks / looks good / evaluative replies
- questions
- new ideas the user did not ask about
- multiple sentences
- unsafe or sensitive actions, including security incidents, credentials, harm, or private data

If the user explicitly said what they will ask next, suggest that exact next request.
If a file was created/edited and tests/checks were not run, the next step is clear: suggest running the relevant test/check.
Only reply with nothing when there is genuinely no plausible next user prompt.
Reply with only the suggestion text.`;

function buildSuggestionContext(messages: Message[]): string {
	const recent = messages.slice(-8).map(formatMessageForSuggestion).filter(Boolean);
	return `Recent conversation from the just-finished agent turn:\n\n${recent.join("\n\n")}`;
}

function formatMessageForSuggestion(message: Message): string {
	const role = getMessageRole(message);
	const text = extractMessageText(message).trim();
	if (!text) return `${role}: [no text]`;
	return `${role}: ${truncatePlain(text, 2_000)}`;
}

function getMessageRole(message: unknown): string {
	if (isRecord(message) && typeof message.role === "string") return message.role;
	if (isRecord(message) && typeof message.type === "string") return message.type;
	return "message";
}

function extractMessageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(message);
	return content
		.map((part) => {
			if (!isRecord(part) || typeof part.type !== "string") return "";
			if (part.type === "text" && typeof part.text === "string") return part.text;
			if (part.type === "thinking") return "";
			if (part.type === "toolCall" && typeof part.name === "string") return `[tool call: ${part.name}]`;
			if (part.type === "image") return "[image]";
			return "";
		})
		.join("\n");
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const IDENTITY_STYLE = (text: string): string => text;
const FALLBACK_BOX_SYMBOLS = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeDown: "┬",
	teeUp: "┴",
	teeLeft: "┤",
	teeRight: "├",
	cross: "┼",
};
const FALLBACK_SYMBOLS = {
	cursor: "❯",
	inputCursor: "▏",
	boxRound: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	boxSharp: FALLBACK_BOX_SYMBOLS,
	table: FALLBACK_BOX_SYMBOLS,
	quoteBorder: "▏",
	hrChar: "─",
	spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} satisfies EditorTheme["symbols"];
const FALLBACK_SELECT_LIST_THEME = {
	selectedPrefix: IDENTITY_STYLE,
	selectedText: IDENTITY_STYLE,
	description: IDENTITY_STYLE,
	scrollInfo: IDENTITY_STYLE,
	noMatch: IDENTITY_STYLE,
	symbols: FALLBACK_SYMBOLS,
	hovered: IDENTITY_STYLE,
} satisfies EditorTheme["selectList"];

function isEditorTheme(value: unknown): value is EditorTheme {
	return (
		isRecord(value) &&
		typeof value.borderColor === "function" &&
		isRecord(value.selectList) &&
		isRecord(value.symbols) &&
		isRecord(value.symbols.boxRound)
	);
}

function coerceEditorTheme(value: unknown): EditorTheme {
	if (isEditorTheme(value)) return value;
	const hostTheme = isRecord(value) ? value : {};
	const fg = typeof hostTheme.fg === "function" ? (name: string, text: string) => (hostTheme.fg as (name: string, text: string) => string)(name, text) : undefined;
	const boxRound = isRecord(hostTheme.boxRound) ? { ...FALLBACK_SYMBOLS.boxRound, ...hostTheme.boxRound } : FALLBACK_SYMBOLS.boxRound;
	const boxSharp = isRecord(hostTheme.boxSharp) ? { ...FALLBACK_BOX_SYMBOLS, ...hostTheme.boxSharp } : FALLBACK_BOX_SYMBOLS;
	const symbols = isRecord(hostTheme.symbols) ? { ...FALLBACK_SYMBOLS, ...hostTheme.symbols, boxRound, boxSharp, table: boxSharp } : { ...FALLBACK_SYMBOLS, boxRound, boxSharp, table: boxSharp };
	return {
		borderColor: (text: string) => (fg ? fg("borderMuted", text) : text),
		selectList: { ...FALLBACK_SELECT_LIST_THEME, symbols },
		symbols,
		hintStyle: (text: string) => (fg ? fg("dim", text) : text),
	};
}

function sanitizeSuggestion(text: string, maxChars = DEFAULT_MAX_CHARS): string | undefined {
	let clean = text.trim();
	if (!clean) return undefined;
	if (clean.includes("\n")) return undefined;

	clean = clean.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
	clean = clean.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
	clean = clean.replace(/\.$/, "").trim();

	if (!clean) return undefined;
	if (clean.length > maxChars) return undefined;
	if (clean.endsWith("?")) return undefined;
	if (/[.!?].+\S/.test(clean)) return undefined;
	if (/[\n*]|\*\*/.test(clean)) return undefined;
	if (/^\w+:\s/.test(clean)) return undefined;
	if (/^\(.*\)$|^\[.*\]$/.test(clean)) return undefined;

	const lower = clean.toLowerCase();
	const wordCount = clean.split(/\s+/).length;
	if (lower === "done") return undefined;
	if (isMetaSuggestion(lower)) return undefined;
	if (isErrorSuggestion(lower)) return undefined;
	if (wordCount > 12) return undefined;
	if (wordCount < 2 && !isAllowedSingleWordSuggestion(lower, clean)) return undefined;
	if (/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)\b/i.test(clean)) return undefined;
	if (/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/i.test(clean)) return undefined;

	return clean;
}

function isMetaSuggestion(lower: string): boolean {
	return (
		lower === "nothing found" ||
		lower.startsWith("nothing to suggest") ||
		lower.startsWith("no suggestion") ||
		/\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
		/^\W*silence\W*$/.test(lower)
	);
}

function isErrorSuggestion(lower: string): boolean {
	return (
		lower.startsWith("api error:") ||
		lower.startsWith("prompt is too long") ||
		lower.startsWith("request timed out") ||
		lower.startsWith("invalid api key") ||
		lower.startsWith("image was too large")
	);
}

function isAllowedSingleWordSuggestion(lower: string, clean: string): boolean {
	if (clean.startsWith("/")) return true;
	return ALLOWED_SINGLE_WORD_SUGGESTIONS[lower] === true;
}

function isPrintableOrMutatingEditKey(data: string): boolean {
	if (data.length === 1 && data.charCodeAt(0) >= 32) return true;
	return matchesKey(data, Key.backspace) || matchesKey(data, Key.delete) || matchesKey(data, Key.enter) || matchesKey(data, Key.tab);
}

function canRestoreSuggestionAfterKey(data: string): boolean {
	return matchesKey(data, Key.backspace) || matchesKey(data, Key.delete);
}

function truncatePlain(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function loadConfig(cwd: string, onWarning?: (message: string) => void): PromptSuggestionsConfig {
	const globalPath = firstExistingPath(getAgentDir(), GLOBAL_CONFIG_RELATIVE_PATHS);
	const projectPath = firstExistingPath(cwd, PROJECT_CONFIG_RELATIVE_PATHS);
	return mergeConfigInputs(
		globalPath ? readConfigFile(globalPath, onWarning) : {},
		projectPath ? readConfigFile(projectPath, onWarning) : {},
	);
}

function firstExistingPath(base: string, relativePaths: readonly (readonly string[])[]): string | undefined {
	for (const relativePath of relativePaths) {
		const candidate = join(base, ...relativePath);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function readConfigFile(path: string, onWarning?: (message: string) => void): PromptSuggestionsConfigInput {
	if (!existsSync(path)) return {};
	try {
		return parseConfigInput(JSON.parse(readFileSync(path, "utf-8")), path, onWarning);
	} catch (error) {
		onWarning?.(`config ignored: ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function parseConfigInput(
	value: unknown,
	path = "config",
	onWarning?: (message: string) => void,
): PromptSuggestionsConfigInput {
	if (!isRecord(value)) {
		onWarning?.(`config ignored: ${path}: expected object`);
		return {};
	}

	const config: PromptSuggestionsConfigInput = {};
	if ("enabled" in value) onWarning?.(JSON_ENABLED_WARNING);
	if ("model" in value) onWarning?.(JSON_MODEL_WARNING);
	if ("acceptTab" in value) {
		if (typeof value.acceptTab === "boolean") config.acceptTab = value.acceptTab;
		else onWarning?.(`config ignored: ${path}: acceptTab must be boolean`);
	}
	if ("display" in value) {
		if (value.display === "ghost" || value.display === "belowEditor") config.display = value.display;
		else onWarning?.(`config ignored: ${path}: display must be "ghost" or "belowEditor"`);
	}
	if ("maxChars" in value) {
		if (isPositiveInteger(value.maxChars)) config.maxChars = value.maxChars;
		else onWarning?.(`config ignored: ${path}: maxChars must be positive integer`);
	}
	if ("maxTokens" in value) {
		if (isPositiveInteger(value.maxTokens)) config.maxTokens = value.maxTokens;
		else onWarning?.(`config ignored: ${path}: maxTokens must be positive integer`);
	}
	return config;
}

function mergeConfigInputs(...configs: PromptSuggestionsConfigInput[]): PromptSuggestionsConfig {
	return {
		acceptTab: true,
		display: "ghost",
		maxChars: DEFAULT_MAX_CHARS,
		maxTokens: DEFAULT_MAX_TOKENS,
		...Object.assign({}, ...configs),
	};
}

function getPromptSuggestionModelSpec(): string {
	const value = readPromptSuggestionSetting("promptSuggestions.model", DEFAULT_SUGGESTION_MODEL);
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	return DEFAULT_SUGGESTION_MODEL;
}

function normalizeSuggestionModelSpec(spec: string): string {
	const trimmed = spec.trim();
	return PROMPT_SUGGESTION_MODEL_ROLE_ALIASES[trimmed] ?? trimmed;
}

function resolveSuggestionModel(ctx: ExtensionContext, configuredModel: string | undefined): Model<any> | undefined {
	if (!configuredModel) return ctx.model;
	const modelSpec = normalizeSuggestionModelSpec(configuredModel);
	const model = ctx.models.resolve(modelSpec);
	if (!model) {
		debug(ctx, `configured model not found: ${configuredModel}`);
		return ctx.model;
	}
	return model;
}


function wrapSuggestionAutocompleteProvider(provider: AutocompleteProvider): AutocompleteProvider {
	return {
		getSuggestions: (lines, cursorLine, cursorCol) => provider.getSuggestions(lines, cursorLine, cursorCol),
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		getInlineHint: (lines, cursorLine, cursorCol) => {
			const upstreamHint = provider.getInlineHint?.(lines, cursorLine, cursorCol);
			if (upstreamHint !== null && upstreamHint !== undefined) return upstreamHint;
			if (!isPromptSuggestionsEnabled()) return null;
			if (currentConfig.display !== "ghost") return null;
			if (!visibleSuggestion) return null;
			if (currentEditor?.getText().length !== 0) return null;
			return visibleSuggestion;
		},
		trySyncSlashCompletion: provider.trySyncSlashCompletion?.bind(provider),
		trySyncInlineReplace: provider.trySyncInlineReplace?.bind(provider),
	};
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function debug(ctx: ExtensionContext, message: string): void {
	if (process.env.PI_PROMPT_SUGGESTIONS_DEBUG !== "1") return;
	ctx.ui.setStatus("next-suggestion", `suggestion: ${message}`);
	ctx.ui.notify(`next-suggestion: ${message}`, "info");
}

function __resetForTest(): void {
	cachedSuggestion = undefined;
	visibleSuggestion = undefined;
	suggestionHiddenByUserEdit = false;
	generationId = 0;
	lastCtx = undefined;
	currentConfig = mergeConfigInputs();
	currentEditor = undefined;
}

export const __test__ = {
	SuggestionEditor,
	coerceEditorTheme,
	__resetForTest,
	acceptSuggestion,
	buildSuggestionContext,
	canRestoreSuggestionAfterKey,
	extractAssistantText,
	extractMessageText,
	formatMessageForSuggestion,
	getMessageRole,
	getPromptSuggestionModelSpec,
	getSuggestionReasoningEffort,
	isEditorTheme,
	hideVisibleSuggestion,
	isPrintableOrMutatingEditKey,
	isPromptSuggestionsEnabled,
	loadConfig,
	readPromptSuggestionSetting,
	loadSuggestionSystemPrompt,
	mergeConfigInputs,
	normalizeSuggestionModelSpec,
	parseConfigInput,
	resolveSuggestionModel,
	renderSuggestion,
	resetSuggestion,
	wrapSuggestionAutocompleteProvider,
	restoreVisibleSuggestionIfEditorEmpty,
	sanitizeSuggestion,
	showSuggestion,
	truncatePlain,
};
