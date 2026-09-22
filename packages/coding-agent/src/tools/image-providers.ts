export type ImageProvider = "antigravity" | "deepinfra" | "gemini" | "openai" | "openai-codex" | "openrouter" | "xai";

export const AUTO_IMAGE_PROVIDER_ORDER: readonly ImageProvider[] = [
	"openai",
	"openai-codex",
	"antigravity",
	"xai",
	"openrouter",
	"gemini",
	"deepinfra",
];

export const IMAGE_PROVIDER_CHOICES = [
	{
		value: "openai",
		label: "OpenAI",
		description: "OPENAI_API_KEY (gpt-image-2) or active GPT model; falls back to a connected Codex subscription",
	},
	{
		value: "openai-codex",
		label: "OpenAI Codex (ChatGPT)",
		description: "Uses a connected Codex / ChatGPT subscription — no OPENAI_API_KEY needed",
	},
	{
		value: "antigravity",
		label: "Antigravity",
		description: "Requires google-antigravity OAuth",
	},
	{
		value: "xai",
		label: "xAI Grok Imagine",
		description: "Requires xAI Grok OAuth or XAI_API_KEY",
	},
	{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
	{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
	{ value: "deepinfra", label: "DeepInfra", description: "Requires DEEPINFRA_API_KEY" },
] as const satisfies ReadonlyArray<{ value: ImageProvider; label: string; description: string }>;

export function isImageProviderId(value: unknown): value is ImageProvider {
	return typeof value === "string" && AUTO_IMAGE_PROVIDER_ORDER.includes(value as ImageProvider);
}
