/**
 * Builders for the enforce scopes the WP10 enforcement tests run under: a subagent scope with
 * the given overrides, carried in settings the way a spawn writes it (a runtime override).
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { encodePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";

export function enforceScope(overrides: Partial<PermissionScope> = {}): PermissionScope {
	return {
		v: 2,
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "ScopedChild",
		actorKind: "sub",
		parentId: "Main",
		profiles: [],
		denyTools: [],
		allowPathGroups: [],
		denyPathGroups: [],
		guardrails: { noNetwork: false, secretsBlind: false },
		restricted: true,
		inherited: false,
		provenance: { profiles: [] },
		...overrides,
	};
}

/** Isolated settings whose runtime layer carries `scope`, plus any other overrides. */
export function scopedSettings(scope: PermissionScope, overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({ ...overrides, "task.permissions.activeScope": encodePermissionScope(scope) });
}
