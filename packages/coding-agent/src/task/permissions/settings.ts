/**
 * Settings of the subagent permission profiles. `config/all-settings.ts` registers this domain.
 */
import { register } from "../../config/registry";

/**
 * The compiled scope the session runs under, as `encodePermissionScope` text. Only a runtime override
 * counts (the subagent spawn writes one into the child's settings overlay); a value in a config file
 * is ignored. It is stored as one string, so an overlay can only replace an inherited scope, never
 * merge its fields with the child's.
 */
export const cfgTaskPermissionsActiveScope = register({
	id: "task.permissions.activeScope",
	type: "string",
	default: undefined,
	runtimeOnly: true,
});
