import type { ToolSession } from ".";

import { getCachedPythonKernelAvailability } from "../eval/py/kernel";
import { cfgEvalJs, cfgEvalPy, cfgPythonInterpreter } from "../eval/settings";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/** Read per-backend allowance from settings (py/js default on). */
export function readEvalBackendsAllowance(session: Pick<ToolSession, "settings">): EvalBackendsAllowance {
	return {
		python: cfgEvalPy.get(session.settings) ?? true,
		js: cfgEvalJs.get(session.settings) ?? true,
	};
}

/** Active eval backend allowance (`eval.py` / `eval.js`; `PI_PY` / `PI_JS` override). */
export function resolveEvalBackends(session: Pick<ToolSession, "settings">): EvalBackendsAllowance {
	return {
		python: cfgEvalPy.get(session.settings),
		js: cfgEvalJs.get(session.settings),
	};
}

/** Advertise settings-allowed runtimes unless a definitive probe found Python unavailable. */
export function resolveAdvertisedEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const allowed = resolveEvalBackends(session);
	if (!allowed.python) return allowed;
	const availability = getCachedPythonKernelAvailability(
		session.cwd,
		cfgPythonInterpreter.get(session.settings)?.trim() || undefined,
	);
	return { python: availability?.ok !== false, js: allowed.js };
}
