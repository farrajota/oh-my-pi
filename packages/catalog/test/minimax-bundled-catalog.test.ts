import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { getSupportedEfforts, mapEffortToAnthropicAdaptiveEffort, minimumSupportedEffort } from "../src/model-thinking";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "../src/provider-models/openai-compat";
import modelsJson from "../src/models.json";

const CODE_PROVIDERS = ["minimax-code", "minimax-code-cn"] as const;
const CODE_API_MODELS = ["MiniMax-M2", "MiniMax-M3", "MiniMax-M3.1-Flash-Preview"] as const;

function buildAnthropicCodeModels(provider: (typeof CODE_PROVIDERS)[number]) {
	const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(
		entry => entry.providerId === provider && entry.api === "anthropic-messages",
	);
	if (descriptor === undefined) {
		throw new Error(`Missing Anthropic model descriptor for ${provider}`);
	}
	const models = Object.fromEntries(CODE_API_MODELS.map(id => [id, { tool_call: true, reasoning: true }]));
	return mapModelsDevToModels({ [descriptor.modelsDevKey]: { models } }, [descriptor]).map(buildModel);
}

describe("minimax bundled catalog", () => {
	it("pins MiniMax-M3 long-context entries to 1M context", () => {
		const providers = [
			{ id: "minimax", models: modelsJson.minimax },
			{ id: "minimax-cn", models: modelsJson["minimax-cn"] },
			{ id: "minimax-code", models: modelsJson["minimax-code"] },
			{ id: "minimax-code-cn", models: modelsJson["minimax-code-cn"] },
		];

		for (const provider of providers) {
			const model = provider.models["MiniMax-M3"];

			expect(model).toBeDefined();
			expect(model.provider).toBe(provider.id);
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(128_000);
		}
	});

	it("separates bundled OpenAI Code rows from the Anthropic API consumer contract", () => {
		for (const provider of CODE_PROVIDERS) {
			for (const model of Object.values(modelsJson[provider])) {
				expect(model.api).toBe("openai-completions");
				expect(
					model.thinking !== undefined && "effortMap" in model.thinking ? model.thinking.effortMap : undefined,
				).toBeUndefined();
				if (model.thinking !== undefined) {
					expect(model.thinking.mode).toBe("effort");
				}
			}

			const anthropicModels = buildAnthropicCodeModels(provider);
			const modelFor = (id: string) => {
				const model = anthropicModels.find(candidate => candidate.id === id);
				if (model === undefined) {
					throw new Error(`Missing Anthropic Code model ${provider}/${id}`);
				}
				return model;
			};
			const expectedBaseUrl =
				provider === "minimax-code" ? "https://api.minimax.io/anthropic" : "https://api.minimaxi.com/anthropic";

			const m2 = modelFor("MiniMax-M2");
			expect(m2.api).toBe("anthropic-messages");
			expect(m2.baseUrl).toBe(expectedBaseUrl);
			expect(m2.thinking?.mode).toBe("anthropic-adaptive");
			expect(getSupportedEfforts(m2)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
			expect(m2.thinking?.requiresEffort).toBe(true);

			const m3 = modelFor("MiniMax-M3");
			expect(m3.api).toBe("anthropic-messages");
			expect(m3.baseUrl).toBe(expectedBaseUrl);
			expect(m3.thinking?.mode).toBe("anthropic-adaptive");
			expect(getSupportedEfforts(m3)).toEqual([Effort.Low, Effort.Medium, Effort.High]);

			for (const model of [m2, m3]) {
				for (const effort of [Effort.Low, Effort.Medium, Effort.High]) {
					expect(mapEffortToAnthropicAdaptiveEffort(model, effort)).toBe("adaptive");
				}
			}

			const flash = modelFor("MiniMax-M3.1-Flash-Preview");
			expect(flash.api).toBe("anthropic-messages");
			expect(flash.baseUrl).toBe(expectedBaseUrl);
			expect(flash.thinking?.mode).toBe("anthropic-adaptive");
			expect(getSupportedEfforts(flash)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
			expect(flash.thinking?.requiresEffort).toBe(true);
			expect(minimumSupportedEffort(flash)).toBe(Effort.Low);
			expect(mapEffortToAnthropicAdaptiveEffort(flash, Effort.Max)).toBe("max");
		}
	});
});
