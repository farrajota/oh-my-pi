/**
 * Data types for subagent permission profiles: profile files, task requests, and the compiled scope a
 * subagent runs under. Everything here is plain data so a scope can cross worker links and settings
 * overlays unchanged.
 */

/**
 * `off` does nothing. `suggest` is advisory: profiles are offered and recorded, nothing is denied.
 * `enforce` denies tool calls the scope does not allow.
 */
export type SubagentPermissionMode = "off" | "suggest" | "enforce";

export const SUBAGENT_PERMISSION_MODES: readonly SubagentPermissionMode[] = ["off", "suggest", "enforce"];

/** One named entry in a permissions.json `profiles` map. */
export interface PermissionProfile {
	description?: string;
	useWhen?: string;
	tools?: string[];
	denyTools?: string[];
	allowPaths?: string[];
	denyPaths?: string[];
}

/** The `permissions` field of a task item. */
export interface TaskPermissionRequest {
	profiles?: string[];
	tools?: string[];
	denyTools?: string[];
	allowPaths?: string[];
	denyPaths?: string[];
}

/** Where a loaded profile definition came from, in ascending precedence. */
export type PermissionProfileSource = "built-in" | "user" | "project" | "local";

/** A profile as one scope used it: its source and the hash of its normalized content. */
export interface PermissionProfileIdentity {
	readonly name: string;
	readonly source: PermissionProfileSource | "request" | "inherited";
	readonly canonicalSha256: string;
}

/** Display row for the task tool description. */
export interface PermissionProfileSummary {
	name: string;
	description: string;
	useWhen: string;
	toolsSummary: string;
	pathsSummary: string;
	source: PermissionProfileSource;
}

/** Non-empty path rule group: a path matches the group when it matches any pattern in it. */
export type PathConstraintGroup = readonly [string, ...string[]];

/**
 * Deep readonly projection. Tuples keep their arity, so a non-empty path group cannot widen to a
 * plain string array while a scope is handed around.
 */
export type DeepImmutable<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly unknown[]
		? { readonly [K in keyof T]: DeepImmutable<T[K]> }
		: T extends object
			? { readonly [K in keyof T]: DeepImmutable<T[K]> }
			: T;

/** How a task request is shaped; decides whether it restricts and whether it needs an allowlist. */
export type TaskPermissionRequestShape =
	| "omitted"
	| "empty"
	| "path-only-ambient"
	| "modifier-only"
	| "deny-only"
	| "explicit-tools-allow-none"
	| "explicit-tools-allowlist"
	| "profile-positive"
	| "mixed";

export type PermissionActorKind = "main" | "sub" | "advisor";

/** Guardrails derived from the deny lists at composition time. */
export interface PermissionGuardrails {
	/** `denyTools` names browser or web_search. */
	readonly noNetwork: boolean;
	/** A deny path names secrets, credentials, private keys or `.env` files. */
	readonly secretsBlind: boolean;
}

/**
 * A compiled subagent permission scope (snapshot version 2).
 *
 * Path groups: a path must match every allow group, and is denied when it matches any deny group.
 */
export interface PermissionScope {
	readonly v: 2;
	readonly mode: SubagentPermissionMode;
	readonly toolsEnabled: boolean;
	readonly pathsEnabled: boolean;
	readonly actorId: string;
	readonly actorKind: PermissionActorKind;
	readonly parentId?: string;
	/** Profile names in composition order: inherited first, then requested. */
	readonly profiles: readonly string[];
	/** Tool allowlist; undefined means no allowlist. `hub` in it is the messaging grant. */
	readonly tools?: readonly string[];
	readonly denyTools: readonly string[];
	readonly allowPathGroups: readonly PathConstraintGroup[];
	readonly denyPathGroups: readonly PathConstraintGroup[];
	readonly guardrails: PermissionGuardrails;
	/**
	 * False only for the ambient root state (mode off, or an omitted or empty request with nothing
	 * inherited). A restricted scope may call `report_tool_issue` whatever its allowlist says.
	 */
	readonly restricted: boolean;
	/** Composed on top of the spawning subagent's scope. */
	readonly inherited: boolean;
	readonly provenance: { readonly profiles: readonly PermissionProfileIdentity[] };
}

/** A scope with the hash revival and the active-scope setting verify it against. */
export interface PermissionScopeSnapshot {
	readonly scope: DeepImmutable<PermissionScope>;
	readonly canonicalSha256: string;
}

export type PermissionDenialCode = "tool-deny" | "tool-not-allowed" | "path-deny" | "path-not-allowed" | "guardrail";

export interface PermissionDenialDetails {
	readonly kind: "subagent_permission_denial";
	readonly code: PermissionDenialCode;
	readonly tool: string;
	/** The targets that caused the denial, as the call named them. */
	readonly targets: readonly string[];
	readonly matched: string;
	readonly reason: string;
}

export type PermissionDecision =
	| { readonly action: "allow"; readonly reason: ""; readonly matched: ""; readonly details?: undefined }
	| {
			readonly action: "deny";
			readonly reason: string;
			readonly matched: string;
			readonly details: PermissionDenialDetails;
	  };

/** A tool route the spawning session exposes, classified for the unclassified-route preflight. */
export interface PermissionCapability {
	readonly name: string;
	readonly source: "builtin" | "eval" | "mcp" | "custom" | "opaque";
}
