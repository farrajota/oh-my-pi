/**
 * Credential filtering for the environments eval runtimes (Python kernels, JS
 * eval workers) start with. Model-written cells read their environment, so a
 * provider key or token inherited from the agent would be one `print` away.
 */

/** Secret-shaped variable names; checked case-insensitively. */
const SECRET_ENV_KEY_PATTERN =
	/API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|COOKIE/i;

/** Whether `key` names a credential that must not reach an eval runtime. */
export function isSecretEnvKey(key: string): boolean {
	return SECRET_ENV_KEY_PATTERN.test(key);
}

/** A copy of `env` without its secret-shaped variables. */
export function withoutSecretEnv(env: Record<string, string>): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const key in env) {
		if (!isSecretEnvKey(key)) filtered[key] = env[key];
	}
	return filtered;
}
