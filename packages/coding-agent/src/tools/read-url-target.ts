import { repairCollapsedScheme } from "@oh-my-pi/pi-tui/tools/fetch";
import { isReadableUrlPath } from "@oh-my-pi/pi-tui/tools/read";

/**
 * Whether `read` fetches `value` from the web rather than opening a file: an `http(s)://` URL (a
 * collapsed `http:/` repaired first) or a `www.` host. {@link parseReadUrlTarget} admits exactly
 * these, and the permission scope's no-network guardrail decides with the same function.
 */
export function isReadUrlTarget(value: string): boolean {
	return isReadableUrlPath(repairCollapsedScheme(value));
}
