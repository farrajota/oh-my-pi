import type { ToolSession } from ".";

import { cfgEvalJs, cfgEvalPy } from "../eval/settings";

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
