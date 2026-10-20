import type { Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getOpenAICodexWebSocketEnvValue } from "@oh-my-pi/pi-ai/providers/openai-codex-transport";
import { $env } from "@oh-my-pi/pi-utils/env";

const APPROVED_PROVIDER = "cliproxy-codex";
const APPROVED_MODEL_ID = "gpt-6.1-sol";
const APPROVED_THINKING_LEVEL = "medium";
const APPROVED_SELECTOR = `${APPROVED_PROVIDER}/${APPROVED_MODEL_ID}:${APPROVED_THINKING_LEVEL}`;
const APPROVED_ORIGIN = "https://cliproxyapi.zay.home";
const APPROVED_BASE_PATH = "/v1";

const STREAM_ENDPOINTS = {
	"openai-codex-responses": "/codex/responses",
	"openai-responses": "/responses",
	"openai-completions": "/chat/completions",
};
type GuardedApi = keyof typeof STREAM_ENDPOINTS;

export interface SingleRequestGuardVerification {
	readonly adapter: GuardedApi | "none";
	readonly dispatchBudget: 1;
	readonly fetchBudget: 1;
	readonly selectorMatch: boolean;
	readonly destinationMatch: boolean;
}

export interface SingleRequestGuardSelection {
	readonly configuredSelector: string | undefined;
	readonly effectiveThinkingLevel: string | undefined;
}

export interface SingleRequestGuard {
	readonly verification: SingleRequestGuardVerification;
	beforeDispatch(model: Model): void;
	streamOptions(model: Model, options?: SimpleStreamOptions): SimpleStreamOptions;
}

function normalizedPath(pathname: string): string {
	return pathname.replace(/\/+$/, "") || "/";
}

function assertSafeBaseUrl(baseUrl: string): { url: URL; destinationMatch: boolean } {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Single-request guard requires an approved model destination.");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Single-request guard requires an approved model destination.");
	}
	const destinationMatch =
		url.protocol === "https:" &&
		url.origin === APPROVED_ORIGIN &&
		normalizedPath(url.pathname) === APPROVED_BASE_PATH;
	// Real CLI regressions use a loopback fixture; ordinary launches remain HTTPS-only.
	// Use the runtime accessor so compilation does not replace NODE_ENV with a build-time constant.
	const localFixture =
		$env.NODE_ENV === "test" &&
		$env.PI_SINGLE_REQUEST_TEST_LOOPBACK === "1" &&
		url.protocol === "http:" &&
		url.hostname === "127.0.0.1" &&
		url.port.length > 0 &&
		normalizedPath(url.pathname) === APPROVED_BASE_PATH;
	if (!destinationMatch && !localFixture) {
		throw new Error("Single-request guard requires an approved model destination.");
	}
	return { url, destinationMatch };
}

function assertApprovedSelector(
	model: Model,
	selection: SingleRequestGuardSelection,
): asserts model is Model & { api: GuardedApi; baseUrl: string } {
	if (
		selection.configuredSelector !== APPROVED_SELECTOR ||
		selection.effectiveThinkingLevel !== APPROVED_THINKING_LEVEL ||
		model.provider !== APPROVED_PROVIDER ||
		model.id !== APPROVED_MODEL_ID
	) {
		throw new Error("Single-request guard requires the configured approved model selector.");
	}
	if (!Object.hasOwn(STREAM_ENDPOINTS, model.api)) {
		throw new Error("Single-request guard does not support this model adapter.");
	}
	if (typeof model.baseUrl !== "string" || model.baseUrl.length === 0) {
		throw new Error("Single-request guard requires a configured model destination.");
	}
	if (model.api === "openai-codex-responses" && getOpenAICodexWebSocketEnvValue() === true) {
		throw new Error("Single-request guard cannot use Codex WebSockets when enabled by the environment.");
	}
}

export function createSingleRequestGuard(
	model: Model | undefined,
	selection: SingleRequestGuardSelection,
): SingleRequestGuard {
	let selectedModel: (Model & { api: GuardedApi; baseUrl: string }) | undefined;
	let dispatchCount = 0;
	let fetchCount = 0;
	let endpointPath: string | undefined;
	let baseUrl: URL | undefined;
	let verification: SingleRequestGuardVerification;

	if (model) {
		assertApprovedSelector(model, selection);
		selectedModel = model;
		const destination = assertSafeBaseUrl(model.baseUrl);
		baseUrl = destination.url;
		endpointPath = `${normalizedPath(baseUrl.pathname)}${STREAM_ENDPOINTS[model.api]}`;
		verification = {
			adapter: model.api,
			dispatchBudget: 1,
			fetchBudget: 1,
			selectorMatch: true,
			destinationMatch: destination.destinationMatch,
		};
	} else {
		verification = {
			adapter: "none",
			dispatchBudget: 1,
			fetchBudget: 1,
			selectorMatch: false,
			destinationMatch: false,
		};
	}

	const scopedFetch: NonNullable<SimpleStreamOptions["fetch"]> = async (input, init) => {
		if (!selectedModel || !baseUrl || !endpointPath) {
			throw new Error("Single-request guard has no configured model for dispatch.");
		}
		const requestUrl = input instanceof Request ? input.url : String(input);
		let url: URL;
		try {
			url = new URL(requestUrl, baseUrl);
		} catch {
			throw new Error("Single-request guard blocked an invalid model request.");
		}
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (
			url.origin !== baseUrl.origin ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			normalizedPath(url.pathname) !== endpointPath ||
			method.toUpperCase() !== "POST"
		) {
			throw new Error("Single-request guard blocked an unsupported model request.");
		}
		if (fetchCount >= 1) {
			throw new Error("Single-request guard exhausted its outbound request budget.");
		}
		fetchCount += 1;
		return globalThis.fetch(input, { ...init, redirect: "error" });
	};

	const beforeDispatch = (streamModel: Model): void => {
		if (!selectedModel || !baseUrl || !endpointPath) {
			throw new Error("Single-request guard has no configured model for dispatch.");
		}
		if (
			streamModel.api !== selectedModel.api ||
			streamModel.provider !== selectedModel.provider ||
			streamModel.id !== selectedModel.id ||
			streamModel.baseUrl !== selectedModel.baseUrl
		) {
			throw new Error("Single-request guard blocked a model selection change.");
		}
		if (dispatchCount >= 1) {
			throw new Error("Single-request guard exhausted its model dispatch budget.");
		}
		dispatchCount += 1;
	};

	return {
		verification,
		beforeDispatch,
		streamOptions(streamModel, options) {
			beforeDispatch(streamModel);
			return {
				...options,
				fetch: scopedFetch,
				maxHttpAttempts: 1,
				providerMaxAttempts: 1,
				...(streamModel.api === "openai-codex-responses"
					? { codexSseMaxAttempts: 1, preferWebsockets: false }
					: {}),
			};
		},
	};
}

export function formatSingleRequestGuardVerification(verification: SingleRequestGuardVerification): string {
	return [
		"single-request guard effective:",
		`adapter=${verification.adapter}`,
		`dispatch-budget=${verification.dispatchBudget}`,
		`fetch-budget=${verification.fetchBudget}`,
		`selector-match=${verification.selectorMatch}`,
		`destination-match=${verification.destinationMatch}`,
	].join(" ");
}
