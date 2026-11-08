/**
 * The display-only summary of a permission scope (P6): what the Agent Hub, the registry history and
 * the collab snapshots show. It is derived from a verified scope, bounded and sanitized, and carries
 * no denial history: approval resolves a call several times (preview, pre-gate, full gate), so
 * counting denials there would be wrong.
 */
import type { BoundedList, EffectivePermissionSummary } from "@oh-my-pi/pi-wire";
import { readPermissionSnapshot } from "./snapshot";
import { MESSAGING_GRANT, permissionToolKey } from "./tool-names";
import type { DeepImmutable, PermissionScope } from "./types";

const PROFILE_LIMIT = 16;
const TOOL_LIMIT = 32;
const PATH_SET_LIMIT = 16;
const PATH_PATTERN_LIMIT = 16;
const DENY_LIMIT = 32;
const NAME_BYTES = 128;
const PATTERN_BYTES = 512;
const MODES: ReadonlySet<unknown> = new Set(["off", "suggest", "enforce"]);
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One display line: control and format characters become spaces, then it is cut to `maxBytes`. */
function displayText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	let output = "";
	let bytes = 0;
	for (const character of value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim()) {
		const size = encoder.encode(character).byteLength;
		if (bytes + size > maxBytes) break;
		output += character;
		bytes += size;
	}
	return output.length > 0 ? output : undefined;
}

/** A bounded list re-owned from untrusted input; items that do not normalize count as omitted. */
function boundedList<T>(
	value: unknown,
	limit: number,
	item: (value: unknown) => T | undefined,
): BoundedList<T> | undefined {
	if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
	const sourceOmitted = value.omittedCount;
	if (typeof sourceOmitted !== "number" || !Number.isSafeInteger(sourceOmitted) || sourceOmitted < 0) {
		return undefined;
	}
	const items: T[] = [];
	let omittedCount = sourceOmitted;
	for (const source of value.items) {
		const normalized = items.length < limit ? item(source) : undefined;
		if (normalized === undefined) omittedCount = Math.min(Number.MAX_SAFE_INTEGER, omittedCount + 1);
		else items.push(normalized);
	}
	return Object.freeze({ items: Object.freeze(items), omittedCount });
}

const nameList = (value: unknown, limit: number) => boundedList(value, limit, item => displayText(item, NAME_BYTES));
const patternList = (value: unknown, limit: number) =>
	boundedList(value, limit, item => displayText(item, PATTERN_BYTES));

/**
 * Re-own an untrusted summary (a collab snapshot, a transcript): every list is bounded, every string
 * sanitized, and the result deeply frozen. Unknown fields, such as the fork's `recentDenials`, are
 * dropped. `undefined` when a required field is missing or malformed.
 */
export function normalizePermissionSummary(value: unknown): EffectivePermissionSummary | undefined {
	if (!isRecord(value) || !MODES.has(value.mode)) return undefined;
	const profiles = nameList(value.profiles, PROFILE_LIMIT);
	const tools = value.tools === undefined ? undefined : nameList(value.tools, TOOL_LIMIT);
	const denyTools = nameList(value.denyTools, DENY_LIMIT);
	const allowPathSets = boundedList(value.allowPathSets, PATH_SET_LIMIT, set => patternList(set, PATH_PATTERN_LIMIT));
	const denyPaths = patternList(value.denyPaths, DENY_LIMIT);
	const guardrails = value.guardrails;
	if (
		!profiles ||
		(value.tools !== undefined && !tools) ||
		!denyTools ||
		!allowPathSets ||
		!denyPaths ||
		!isRecord(guardrails) ||
		typeof guardrails.noNetwork !== "boolean" ||
		typeof guardrails.secretsBlind !== "boolean"
	) {
		return undefined;
	}
	return Object.freeze({
		mode: value.mode as EffectivePermissionSummary["mode"],
		profiles,
		...(tools ? { tools } : {}),
		denyTools,
		allowPathSets,
		denyPaths,
		guardrails: Object.freeze({ noNetwork: guardrails.noNetwork, secretsBlind: guardrails.secretsBlind }),
	});
}

function source<T>(items: readonly T[]): BoundedList<T> {
	return { items, omittedCount: 0 };
}

/** The display summary of `scope`. */
export function buildPermissionSummary(
	scope: PermissionScope | DeepImmutable<PermissionScope>,
): EffectivePermissionSummary {
	const summary = normalizePermissionSummary({
		mode: scope.mode,
		profiles: source(scope.profiles),
		...(scope.tools
			? {
					tools: source(
						scope.tools.map(tool => (permissionToolKey(tool) === MESSAGING_GRANT ? "messaging" : tool)),
					),
				}
			: {}),
		denyTools: source(scope.denyTools),
		allowPathSets: source(scope.allowPathGroups.map(group => source(group))),
		denyPaths: source(scope.denyPathGroups.flat()),
		guardrails: scope.guardrails,
	});
	if (!summary) throw new TypeError("A permission scope could not be summarized.");
	return summary;
}

/** The registry history fields of a subagent's permission provenance. */
export interface PermissionHistory {
	requestedPermissionProfiles?: string[];
	effectivePermissionProfiles?: string[];
	permissionSummary?: EffectivePermissionSummary;
}

function nameArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap(item => displayText(item, NAME_BYTES) ?? []).slice(0, PROFILE_LIMIT);
}

/**
 * The permission history of a transcript's `session_init` record (or a collab snapshot): its profile
 * lists, and a summary built from its snapshot only when that snapshot verifies. A persisted fork
 * summary is ignored.
 */
export function permissionHistoryOf(record: Record<string, unknown>): PermissionHistory {
	const requested = nameArray(record.requestedPermissionProfiles);
	const effective = nameArray(record.effectivePermissionProfiles);
	const read = record.permissionSnapshot === undefined ? undefined : readPermissionSnapshot(record.permissionSnapshot);
	return {
		...(requested ? { requestedPermissionProfiles: requested } : {}),
		...(effective ? { effectivePermissionProfiles: effective } : {}),
		...(read?.ok ? { permissionSummary: buildPermissionSummary(read.snapshot.scope) } : {}),
	};
}

/** The permission history of a collab agent snapshot: its profile lists and its re-owned summary. */
export function permissionHistoryOfSnapshot(snapshot: {
	requestedPermissionProfiles?: unknown;
	effectivePermissionProfiles?: unknown;
	permissionSummary?: unknown;
}): PermissionHistory {
	const requested = nameArray(snapshot.requestedPermissionProfiles);
	const effective = nameArray(snapshot.effectivePermissionProfiles);
	const summary = normalizePermissionSummary(snapshot.permissionSummary);
	return {
		...(requested ? { requestedPermissionProfiles: requested } : {}),
		...(effective ? { effectivePermissionProfiles: effective } : {}),
		...(summary ? { permissionSummary: summary } : {}),
	};
}
