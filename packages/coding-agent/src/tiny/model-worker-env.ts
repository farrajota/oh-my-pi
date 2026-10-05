import { isSettingsInitialized, settings } from "../config/settings";
import { cfgProvidersTinyModelDevice, cfgProvidersTinyModelDtype } from "../session/settings";
import { inferenceWorkerEnv } from "../subprocess/worker-client";
import { tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";

/**
 * Map resolved tiny-model settings to worker environment variables. Only
 * resolved values are returned, so worker defaults apply when a setting is
 * unset. This pure mapping is also used to test device/dtype resolution.
 * @internal
 */
export function tinyWorkerEnvOverlay(
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	const device = tinyModelDeviceSettingToEnv(deviceSetting);
	if (device) overlay.PI_TINY_DEVICE = device;
	const dtype = tinyModelDtypeSettingToEnv(dtypeSetting);
	if (dtype) overlay.PI_TINY_DTYPE = dtype;
	return overlay;
}

/** Resolved device/dtype vars for this process. */
export function tinyModelEnv(): Record<string, string> {
	return tinyWorkerEnvOverlay(
		isSettingsInitialized() ? cfgProvidersTinyModelDevice.get(settings) : cfgProvidersTinyModelDevice.envValue(),
		isSettingsInitialized() ? cfgProvidersTinyModelDtype.get(settings) : cfgProvidersTinyModelDtype.envValue(),
	);
}

/** Identity of the resolved device/dtype; a worker started under a different key is stale. */
export function tinyModelEnvKey(): string {
	const env = tinyModelEnv();
	return `${env.PI_TINY_DEVICE ?? ""}|${env.PI_TINY_DTYPE ?? ""}`;
}

/**
 * Env for an ONNX inference subprocess with the resolved device/dtype —
 * used for the tiny worker and reused verbatim by the STT and TTS workers,
 * which share the same device/dtype resolution.
 */
export function tinyWorkerEnv(): Record<string, string> {
	return inferenceWorkerEnv(tinyModelEnv());
}
