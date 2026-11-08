import { isRecord } from "@oh-my-pi/pi-utils";
import { derivePermissionGuardrails } from "./guardrails";
import { flattenPathGroups, toPathGroups } from "./path-rules";
import type { DeepImmutable, PathConstraintGroup, PermissionScope, PermissionScopeSnapshot } from "./types";

/**
 * Canonical typed text of a plain value, used for scope and profile content hashes. It must stay
 * byte-identical to the fork-era encoder, or snapshots and profile identities recorded by earlier
 * releases stop verifying.
 */
export function canonicalPermissionValue(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "undefined":
			return "undefined";
		case "string":
			return `string:${JSON.stringify(value)}`;
		case "boolean":
			return `boolean:${value}`;
		case "number":
			return Number.isNaN(value) ? "number:NaN" : Object.is(value, -0) ? "number:-0" : `number:${value}`;
		case "bigint":
			return `bigint:${value}`;
		case "symbol":
		case "function":
			throw new TypeError("Permission snapshots cannot contain executable or symbolic values.");
	}
	if (Array.isArray(value)) return `array:[${value.map(item => canonicalPermissionValue(item)).join(",")} ]`;
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new TypeError("Permission snapshots may contain only plain objects and arrays.");
	}
	const record = value as Record<string, unknown>;
	return `object:{${Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalPermissionValue(record[key])}`)
		.join(",")}}`;
}

export function sha256Hex(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function permissionScopeHash(scope: PermissionScope | DeepImmutable<PermissionScope>): string {
	return sha256Hex(canonicalPermissionValue(scope));
}

function cloneAndFreeze<T>(value: T, active = new WeakSet<object>()): DeepImmutable<T> {
	if (value === null || typeof value !== "object") return value as DeepImmutable<T>;
	if (active.has(value)) throw new TypeError("Permission snapshots cannot contain cyclic values.");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			return Object.freeze(value.map(item => cloneAndFreeze(item, active))) as DeepImmutable<T>;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			throw new TypeError("Permission snapshots may contain only plain objects and arrays.");
		}
		const clone: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (child !== undefined) clone[key] = cloneAndFreeze(child, active);
		}
		return Object.freeze(clone) as DeepImmutable<T>;
	} finally {
		active.delete(value);
	}
}

/** Deep-frozen copy of `scope` with its canonical hash. */
export function freezePermissionScope(
	scope: PermissionScope | DeepImmutable<PermissionScope>,
): PermissionScopeSnapshot {
	const frozen = cloneAndFreeze(scope) as DeepImmutable<PermissionScope>;
	return Object.freeze({ scope: frozen, canonicalSha256: permissionScopeHash(frozen) });
}

export type PermissionSnapshotReadResult =
	| { readonly ok: true; readonly version: 1 | 2; readonly snapshot: PermissionScopeSnapshot }
	| { readonly ok: false; readonly error: string };

type FieldCheck = (value: unknown) => boolean;
interface FieldSpec {
	readonly required: boolean;
	readonly check: FieldCheck;
}

const MODES: ReadonlySet<unknown> = new Set(["off", "suggest", "enforce"]);
const ACTOR_KINDS: ReadonlySet<unknown> = new Set(["main", "sub", "advisor"]);
const IDENTITY_SOURCES: ReadonlySet<unknown> = new Set([
	"built-in",
	"user",
	"project",
	"local",
	"request",
	"inherited",
]);
const RESTRICTED_STATES: ReadonlySet<unknown> = new Set(["unrestricted-root-ambient", "restricted"]);

const isString: FieldCheck = value => typeof value === "string";
const isBoolean: FieldCheck = value => typeof value === "boolean";
const isStringArray: FieldCheck = value => Array.isArray(value) && value.every(isString);
const isPathGroups: FieldCheck = value =>
	Array.isArray(value) && value.every(group => Array.isArray(group) && group.length > 0 && group.every(isString));
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const isGuardrails: FieldCheck = value =>
	isRecord(value) &&
	hasExactKeys(value, ["noNetwork", "secretsBlind"]) &&
	isBoolean(value.noNetwork) &&
	isBoolean(value.secretsBlind);
const isIdentityList: FieldCheck = value =>
	Array.isArray(value) &&
	value.every(
		identity =>
			isRecord(identity) &&
			hasExactKeys(identity, ["name", "source", "canonicalSha256"]) &&
			isString(identity.name) &&
			IDENTITY_SOURCES.has(identity.source) &&
			isString(identity.canonicalSha256),
	);
const required = (check: FieldCheck): FieldSpec => ({ required: true, check });
const optional = (check: FieldCheck): FieldSpec => ({ required: false, check });

const IDENTITY_FIELDS = {
	mode: required(value => MODES.has(value)),
	toolsEnabled: required(isBoolean),
	pathsEnabled: required(isBoolean),
	actorId: required(isString),
	actorKind: required(value => ACTOR_KINDS.has(value)),
	parentId: optional(isString),
	profiles: required(isStringArray),
	tools: optional(isStringArray),
	denyTools: required(isStringArray),
} satisfies Record<string, FieldSpec>;

const V2_FIELDS: Readonly<Record<string, FieldSpec>> = {
	v: required(value => value === 2),
	...IDENTITY_FIELDS,
	allowPathGroups: required(isPathGroups),
	denyPathGroups: required(isPathGroups),
	guardrails: required(isGuardrails),
	restricted: required(isBoolean),
	inherited: required(isBoolean),
	provenance: required(
		value => isRecord(value) && hasExactKeys(value, ["profiles"]) && isIdentityList(value.profiles),
	),
};

/**
 * Fields of a fork-era scope. Descriptor ids, `availableTools` and `intrinsicTools` served the retired
 * authority layer or are constants; they are validated for shape and then dropped.
 */
const V1_FIELDS: Readonly<Record<string, FieldSpec>> = {
	...IDENTITY_FIELDS,
	allowPaths: required(isStringArray),
	denyPaths: required(isStringArray),
	allowPathGroups: optional(isPathGroups),
	denyPathGroups: optional(isPathGroups),
	guardrails: optional(isGuardrails),
	restrictedState: optional(value => RESTRICTED_STATES.has(value)),
	clauses: optional(
		value => Array.isArray(value) && value.every(clause => isRecord(clause) && isString(clause.source)),
	),
	provenance: optional(value => isRecord(value) && isIdentityList(value.profiles)),
	availableTools: optional(isStringArray),
	allowedDescriptorIds: optional(isStringArray),
	intrinsicTools: optional(isRecord),
};

function fieldProblem(scope: Record<string, unknown>, fields: Readonly<Record<string, FieldSpec>>): string | undefined {
	for (const [key, value] of Object.entries(scope)) {
		if (value !== undefined && !Object.hasOwn(fields, key))
			return `permission snapshot scope has unknown field "${key}"`;
	}
	for (const [key, spec] of Object.entries(fields)) {
		const value = scope[key];
		if (value === undefined ? spec.required : !spec.check(value)) {
			return `permission snapshot scope field "${key}" is malformed`;
		}
	}
	return undefined;
}

/** Fork-era scopes are hashed without their descriptor records, as the fork froze them. */
function hashedV1Scope(scope: Record<string, unknown>): Record<string, unknown> {
	const { availableDescriptors: _availableDescriptors, ...hashed } = scope;
	return hashed;
}

function projectV1Scope(scope: Record<string, unknown>): PermissionScope {
	const denyTools = scope.denyTools as string[];
	const allowPathGroups =
		(scope.allowPathGroups as PathConstraintGroup[] | undefined) ?? toPathGroups(scope.allowPaths as string[]);
	const denyPathGroups =
		(scope.denyPathGroups as PathConstraintGroup[] | undefined) ?? toPathGroups(scope.denyPaths as string[]);
	const clauses = scope.clauses as Array<{ source: string }> | undefined;
	const provenance = scope.provenance as
		| { source?: unknown; profiles: PermissionScope["provenance"]["profiles"] }
		| undefined;
	return {
		v: 2,
		mode: scope.mode as PermissionScope["mode"],
		toolsEnabled: scope.toolsEnabled as boolean,
		pathsEnabled: scope.pathsEnabled as boolean,
		actorId: scope.actorId as string,
		actorKind: scope.actorKind as PermissionScope["actorKind"],
		...(scope.parentId === undefined ? {} : { parentId: scope.parentId as string }),
		profiles: scope.profiles as string[],
		...(scope.tools === undefined ? {} : { tools: scope.tools as string[] }),
		denyTools,
		allowPathGroups,
		denyPathGroups,
		// Fork scopes always carried guardrails; deriving them for a scope without is the stricter reading.
		guardrails:
			(scope.guardrails as PermissionScope["guardrails"] | undefined) ??
			derivePermissionGuardrails(denyTools, flattenPathGroups(denyPathGroups)),
		// The fork evaluator treated a scope without a recorded state as restricted.
		restricted: scope.restrictedState !== "unrestricted-root-ambient",
		inherited: clauses ? clauses.some(clause => clause.source === "inherited") : provenance?.source === "inherited",
		provenance: { profiles: provenance?.profiles ?? [] },
	};
}

/**
 * Verify and read a persisted `{scope, canonicalSha256}` snapshot. Accepts the current v2 scope and
 * the fork-era v1 scope, which is projected to v2 without changing any field enforcement reads. The
 * returned snapshot is v2 with its own hash.
 */
export function readPermissionSnapshot(value: unknown): PermissionSnapshotReadResult {
	if (!isRecord(value) || !isRecord(value.scope) || typeof value.canonicalSha256 !== "string") {
		return { ok: false, error: "permission snapshot must be an object with a scope and a canonicalSha256" };
	}
	const scope = value.scope;
	const version = scope.v === undefined ? 1 : scope.v === 2 ? 2 : undefined;
	if (version === undefined) return { ok: false, error: "permission snapshot has an unknown scope version" };
	let hash: string;
	try {
		hash = sha256Hex(canonicalPermissionValue(version === 1 ? hashedV1Scope(scope) : scope));
	} catch (error) {
		return { ok: false, error: `permission snapshot scope is not plain data: ${(error as Error).message}` };
	}
	if (hash !== value.canonicalSha256) return { ok: false, error: "permission snapshot hash does not match its scope" };
	const problem = fieldProblem(version === 1 ? hashedV1Scope(scope) : scope, version === 1 ? V1_FIELDS : V2_FIELDS);
	if (problem !== undefined) return { ok: false, error: problem };
	const projected = version === 1 ? projectV1Scope(scope) : (scope as unknown as PermissionScope);
	return { ok: true, version, snapshot: freezePermissionScope(projected) };
}

/** Text form of a scope for the runtime `task.permissions.activeScope` setting. */
export function encodePermissionScope(scope: PermissionScope | DeepImmutable<PermissionScope>): string {
	return JSON.stringify(freezePermissionScope(scope));
}

/** Read the text form back; only a verified v2 snapshot is accepted. */
export function decodePermissionScope(text: string): PermissionSnapshotReadResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `permission scope is not valid JSON: ${(error as Error).message}` };
	}
	const read = readPermissionSnapshot(parsed);
	if (read.ok && read.version !== 2) return { ok: false, error: "permission scope must be a v2 snapshot" };
	return read;
}
