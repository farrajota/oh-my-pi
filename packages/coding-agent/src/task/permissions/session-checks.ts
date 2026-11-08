/**
 * Checks of the session's subagent permission scope for effects that do not pass through one
 * approval resolve: spawning a subagent outside the `task` tool.
 */
import type { Settings } from "../../config/settings";
import { permissionApprovalGuard } from "./guard";

/**
 * Why the session's scope refuses to spawn a subagent, or `undefined`. A spawn through eval
 * `agent()` or `workpool()` is delegation exactly like a `task` call, so it needs the same grant
 * (`no-delegation` denies it; an allowlist must name `task`).
 */
export function permissionDelegationRefusal(settings: Settings, cwd: string): string | undefined {
	return permissionApprovalGuard(settings, cwd)?.check({ name: "task" }, {}, { tier: "exec" })?.reason;
}
