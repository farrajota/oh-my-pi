import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolPreparedExecution } from "@oh-my-pi/pi-agent-core";
import type {
	BoundedList,
	EffectivePermissionSummary,
	PermissionDenialDetails,
	PermissionTargetSummary,
} from "@oh-my-pi/pi-wire";
import { normalizeToolNames } from "../tools/builtin-names";

/** Exact effective registry descriptor. The tool field is identity-bearing and never normalized. */
export interface EffectiveToolDescriptor {
	readonly name: string;
	readonly normalizedName: string;
	readonly source: "builtin" | "eval" | "mcp" | "custom" | "opaque";
	readonly origin: string;
	readonly descriptorId: string;
	readonly tool: object;
}

/** Session-local authority used to mint one-use execution preparations. */
export interface ToolExecutionAuthority {
	readonly getDescriptor: (name: string) => EffectiveToolDescriptor | undefined;
	readonly registerDescriptor: (descriptor: EffectiveToolDescriptor) => void;
	readonly prepare: (
		name: string,
		toolCallId: string,
		input: object,
		inner: AgentToolPreparedExecution | undefined,
	) => AgentToolPreparedExecution;
	readonly validatePrepared: (
		prepared: AgentToolPreparedExecution,
		name: string,
		toolCallId: string,
		input: object,
	) => void;
}
/**
 * Deep readonly projection used at internal permission boundaries. Arrays and
 * tuples retain their shape, so a readonly tuple cannot silently widen to a
 * mutable string array while a scope is being handed between runtimes.
 */
export type DeepImmutable<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly unknown[]
		? { readonly [K in keyof T]: DeepImmutable<T[K]> }
		: T extends object
			? { readonly [K in keyof T]: DeepImmutable<T[K]> }
			: T;

/** Non-empty path clause group; an empty tuple is intentionally not a clause. */
export type PathConstraintGroup = readonly [string, ...string[]];

/** A normalized immutable permission clause used by internal evaluators. */
export interface PermissionClause {
	readonly kind: "tool-allow" | "tool-deny" | "path-allow" | "path-deny";
	readonly values: readonly string[];
	/** Path rows are preserved as groups: OR within one row, AND across rows. */
	readonly groups?: readonly PathConstraintGroup[];
}

/** Frozen state carried by a composed permission scope. */
export interface PermissionState {
	readonly mode: SubagentPermissionMode;
	readonly toolsEnabled: boolean;
	readonly pathsEnabled: boolean;
	readonly requestShape: TaskPermissionRequestShape;
	readonly clauses: readonly PermissionClause[];
}
/** A compiled clause retains the descriptor identities that supplied it. */
export interface CompiledPermissionClause {
	readonly source: "profile" | "inline" | "ambient" | "inherited";
	readonly name?: string;
	readonly kind?: PermissionClause["kind"];
	readonly descriptorIds?: readonly string[];
	readonly allowPathSets?: readonly PathConstraintGroup[];
	readonly denyPathSets?: readonly PathConstraintGroup[];
}

export interface CompiledGuardrails {
	readonly noNetwork: boolean;
	readonly secretsBlind: boolean;
}

export type RestrictedPermissionState = "unrestricted-root-ambient" | "restricted";

/** Internal immutable compilation contract. */
export type CompiledSubagentPermissions = Omit<
	EffectiveSubagentPermissions,
	| "clauses"
	| "guardrails"
	| "intrinsicTools"
	| "restrictedState"
	| "availableTools"
	| "availableDescriptors"
	| "allowedDescriptorIds"
> & {
	readonly clauses: readonly CompiledPermissionClause[];
	readonly guardrails: CompiledGuardrails;
	readonly intrinsicTools: { readonly yield: true; readonly reportToolIssue: boolean };
	readonly restrictedState: RestrictedPermissionState;
	readonly availableTools: readonly string[] | undefined;
	readonly availableDescriptors: readonly EffectiveToolDescriptor[];
	readonly allowedDescriptorIds: readonly string[] | undefined;
};
export interface EffectiveSubagentPermissions {
	readonly mode: SubagentPermissionMode;
	readonly toolsEnabled: boolean;
	readonly pathsEnabled: boolean;
	readonly actorId: string;
	readonly actorKind: "main" | "sub" | "advisor";
	readonly parentId?: string;
	readonly profiles: readonly string[];
	readonly tools?: readonly string[];
	readonly denyTools: readonly string[];
	readonly allowPaths: readonly string[];
	readonly denyPaths: readonly string[];
	/** Canonical path rows; the flat fields above are display compatibility only. */
	readonly allowPathGroups?: readonly PathConstraintGroup[];
	readonly denyPathGroups?: readonly PathConstraintGroup[];
	/** Complete live route availability, including intrinsic routes. */
	readonly availableTools?: readonly string[];
	/** Exact effective registry descriptors backing availableTools. */
	readonly availableDescriptors?: readonly EffectiveToolDescriptor[];
	/** Exact descriptor IDs allowed by the compiled tool clauses. */
	readonly allowedDescriptorIds?: readonly string[];
	/** Immutable descriptor/source provenance for drift checks. */
	readonly provenance?: PermissionProvenance;
	/** Internal compiled constraints retained across nested composition. */
	readonly clauses?: readonly CompiledPermissionClause[];
	readonly guardrails?: CompiledGuardrails;
	readonly intrinsicTools?: { readonly yield: true; readonly reportToolIssue: boolean };
	readonly restrictedState?: RestrictedPermissionState;
}

/** Stable summary metadata suitable for prompts and diagnostics. */
export interface PermissionSummary {
	readonly profiles: readonly string[];
	readonly tools: readonly string[] | undefined;
	readonly denyTools: readonly string[];
	readonly allowPaths: readonly string[];
	readonly denyPaths: readonly string[];
}

/** Capability classification for an internal tool route. */
export interface PermissionCapability {
	readonly name: string;
	readonly source: EffectiveToolDescriptor["source"];
	readonly intrinsic?: boolean;
	/** Exact post-precedence descriptor; name is display metadata only. */
	readonly descriptor?: EffectiveToolDescriptor;
}

/** Lifetime lease metadata; W1 only defines the immutable contract. */
export interface PermissionLease {
	readonly actorId: string;
	readonly parentId?: string;
	readonly expiresAt?: number;
}

export interface PermissionProfileIdentity {
	readonly name: string;
	readonly source: "built-in" | "project" | "local" | "request" | "inherited";
	readonly canonicalSha256: string;
}

/** Provenance for a frozen permission scope, including exact selected descriptor identities. */
export interface PermissionProvenance {
	readonly source: "builtin" | "project" | "local" | "request" | "inherited";
	readonly profileNames: readonly string[];
	readonly profiles: readonly PermissionProfileIdentity[];
}

/** Request classification used by composition and guardrail preflight. */
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
declare const canonicalImmutableSnapshotV1Brand: unique symbol;

/** Branded immutable snapshot; callers must use a canonicalized value/hash pair. */
export interface CanonicalImmutableSnapshotV1<T> {
	readonly [canonicalImmutableSnapshotV1Brand]: never;
	readonly value: DeepImmutable<T>;
	readonly canonicalSha256: string;
}

export type PermissionDenial =
	| { readonly action: "allow"; readonly reason: ""; readonly matched: ""; readonly details?: never }
	| {
			readonly action: "deny";
			readonly reason: string;
			readonly matched: string;
			readonly details: PermissionDenialDetails;
	  };

export type SubagentPermissionMode = "off" | "suggest" | "enforce";

export interface PermissionProfile {
	description?: string;
	useWhen?: string;
	tools?: string[];
	denyTools?: string[];
	allowPaths?: string[];
	denyPaths?: string[];
}

export interface TaskPermissionRequest {
	profiles?: string[];
	tools?: string[];
	denyTools?: string[];
	allowPaths?: string[];
	denyPaths?: string[];
}

export interface PermissionProfileSummary {
	name: string;
	description: string;
	useWhen: string;
	toolsSummary: string;
	pathsSummary: string;
	source: "built-in" | "project" | "local";
}

const SUMMARY_PROFILE_LIMIT = 16;
const SUMMARY_CLAUSE_LIMIT = 32;
const SUMMARY_CLAUSE_TOOL_LIMIT = 32;
const SUMMARY_PATH_SET_LIMIT = 16;
const SUMMARY_PATH_PATTERN_LIMIT = 16;
const SUMMARY_DENY_LIMIT = 32;
const SUMMARY_RECENT_DENIAL_LIMIT = 64;
const SUMMARY_DENIAL_TARGET_LIMIT = 16;
const SUMMARY_SHORT_TEXT_BYTES = 128;
const SUMMARY_PATH_TEXT_BYTES = 512;
const SUMMARY_REASON_TEXT_BYTES = 4096;
const SUMMARY_TEXT_SCAN_FACTOR = 4;
const textEncoder = new TextEncoder();

type EffectivePermissionClauseSummary = EffectivePermissionSummary["clauses"]["items"][number];

function summaryRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function summaryOmittedCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function addSummaryOmittedCount(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function redactSummarySecrets(value: string): string {
	return value
		.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:[^/\s@]+@)([^/\s?#]+)/gu, "$1$2")
		.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]+)[?#][^\s]*/gu, "$1")
		.replace(
			/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			(_match, key: string, separator: string) => `${key}${separator}[redacted]`,
		)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]");
}

function truncateSanitizedSummaryText(value: string, maxBytes: number): string {
	const scan = redactSummarySecrets(value.slice(0, maxBytes * SUMMARY_TEXT_SCAN_FACTOR));
	let output = "";
	let outputBytes = 0;
	let pendingSpace = false;
	for (const character of scan) {
		if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
			pendingSpace = output.length > 0;
			continue;
		}
		if (pendingSpace) {
			if (outputBytes + 1 > maxBytes) break;
			output += " ";
			outputBytes++;
			pendingSpace = false;
		}
		const characterBytes = textEncoder.encode(character).byteLength;
		if (outputBytes + characterBytes > maxBytes) break;
		output += character;
		outputBytes += characterBytes;
	}
	return output.trim();
}

function sanitizeSummaryPathOrUri(value: string, maxBytes = SUMMARY_PATH_TEXT_BYTES): string {
	const sanitized = truncateSanitizedSummaryText(value, maxBytes * 2).replaceAll("\\", "/");
	const uri = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(.*)$/u.exec(sanitized);
	if (!uri) return truncateSanitizedSummaryText(sanitized, maxBytes);
	const prefix = uri[1]!;
	const remainder = uri[2]!;
	const pathStart = remainder.indexOf("/");
	const queryStart = remainder.search(/[?#]/u);
	const authorityEnd = Math.min(
		pathStart < 0 ? remainder.length : pathStart,
		queryStart < 0 ? remainder.length : queryStart,
	);
	const authority = remainder.slice(0, authorityEnd);
	const suffix =
		pathStart >= 0 && (queryStart < 0 || pathStart < queryStart)
			? remainder.slice(pathStart, queryStart < 0 ? undefined : queryStart)
			: "";
	const safeAuthority = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
	return truncateSanitizedSummaryText(`${prefix}${safeAuthority}${suffix}`, maxBytes);
}

function normalizeSummaryString(value: unknown, maxBytes: number, pathLike = false): string | undefined {
	if (typeof value !== "string") return undefined;
	return pathLike ? sanitizeSummaryPathOrUri(value, maxBytes) : truncateSanitizedSummaryText(value, maxBytes);
}

function normalizeBoundedSummaryList<T>(
	value: unknown,
	limit: number,
	normalizeItem: (item: unknown) => T | undefined,
): BoundedList<T> | undefined {
	const record = summaryRecord(value);
	const sourceItems = record?.items;
	const sourceOmittedCount = summaryOmittedCount(record?.omittedCount);
	if (!Array.isArray(sourceItems) || sourceOmittedCount === undefined) return undefined;
	const items: T[] = [];
	let omittedCount = sourceOmittedCount;
	for (const sourceItem of sourceItems) {
		if (items.length >= limit) {
			omittedCount = addSummaryOmittedCount(omittedCount, 1);
			continue;
		}
		const item = normalizeItem(sourceItem);
		if (item === undefined) {
			omittedCount = addSummaryOmittedCount(omittedCount, 1);
			continue;
		}
		items.push(item);
	}
	return Object.freeze({ items: Object.freeze(items), omittedCount });
}

function boundedSummarySource<T>(items: readonly T[]): BoundedList<T> {
	return { items, omittedCount: 0 };
}

function normalizePermissionTargetSummary(value: unknown): PermissionTargetSummary | undefined {
	const record = summaryRecord(value);
	if (!record) return undefined;
	const kind = record.kind;
	if (kind !== "path" && kind !== "uri" && kind !== "network" && kind !== "process" && kind !== "opaque") {
		return undefined;
	}
	const display = normalizeSummaryString(
		record.display,
		SUMMARY_PATH_TEXT_BYTES,
		kind === "path" || kind === "uri" || kind === "network",
	);
	if (display === undefined) return undefined;
	return Object.freeze({ kind, display });
}

function normalizePermissionDenialDetails(value: unknown): PermissionDenialDetails | undefined {
	const record = summaryRecord(value);
	if (record?.kind !== "subagent_permission_denial") return undefined;
	const code = record.code;
	if (
		code !== "tool-deny" &&
		code !== "tool-not-allowed" &&
		code !== "path-deny" &&
		code !== "path-not-allowed" &&
		code !== "guardrail" &&
		code !== "artifact-root"
	)
		return undefined;
	const tool = normalizeSummaryString(record.tool, SUMMARY_SHORT_TEXT_BYTES);
	const matched = normalizeSummaryString(record.matched, SUMMARY_PATH_TEXT_BYTES, true);
	const reason = normalizeSummaryString(record.reason, SUMMARY_REASON_TEXT_BYTES);
	const targets = normalizeBoundedSummaryList(
		record.targets,
		SUMMARY_DENIAL_TARGET_LIMIT,
		normalizePermissionTargetSummary,
	);
	if (tool === undefined || matched === undefined || reason === undefined || targets === undefined) return undefined;
	return Object.freeze({ kind: "subagent_permission_denial", code, tool, targets, matched, reason });
}

function normalizeEffectivePermissionClauseSummary(value: unknown): EffectivePermissionClauseSummary | undefined {
	const record = summaryRecord(value);
	if (!record) return undefined;
	const tools = normalizeBoundedSummaryList(record.tools, SUMMARY_CLAUSE_TOOL_LIMIT, item =>
		normalizeSummaryString(item, SUMMARY_SHORT_TEXT_BYTES),
	);
	const allowPathSets = normalizeBoundedSummaryList(record.allowPathSets, SUMMARY_PATH_SET_LIMIT, item =>
		normalizeBoundedSummaryList(item, SUMMARY_PATH_PATTERN_LIMIT, pattern =>
			normalizeSummaryString(pattern, SUMMARY_PATH_TEXT_BYTES, true),
		),
	);
	if (!tools || !allowPathSets) return undefined;
	return Object.freeze({ tools, allowPathSets });
}

/**
 * Parse and re-own untrusted display metadata. Every returned object and array
 * is newly allocated, bounded, sanitized, and deeply frozen.
 */
export function normalizeEffectivePermissionSummary(value: unknown): EffectivePermissionSummary | undefined {
	const record = summaryRecord(value);
	if (!record) return undefined;
	const mode = record.mode;
	if (mode !== "off" && mode !== "suggest" && mode !== "enforce") return undefined;
	const profiles = normalizeBoundedSummaryList(record.profiles, SUMMARY_PROFILE_LIMIT, item =>
		normalizeSummaryString(item, SUMMARY_SHORT_TEXT_BYTES),
	);
	const clauses = normalizeBoundedSummaryList(
		record.clauses,
		SUMMARY_CLAUSE_LIMIT,
		normalizeEffectivePermissionClauseSummary,
	);
	const denyTools = normalizeBoundedSummaryList(record.denyTools, SUMMARY_DENY_LIMIT, item =>
		normalizeSummaryString(item, SUMMARY_SHORT_TEXT_BYTES),
	);
	const denyPaths = normalizeBoundedSummaryList(record.denyPaths, SUMMARY_DENY_LIMIT, item =>
		normalizeSummaryString(item, SUMMARY_PATH_TEXT_BYTES, true),
	);
	const recentDenials = normalizeBoundedSummaryList(
		record.recentDenials,
		SUMMARY_RECENT_DENIAL_LIMIT,
		normalizePermissionDenialDetails,
	);
	const guardrails = summaryRecord(record.guardrails);
	const intrinsicTools = summaryRecord(record.intrinsicTools);
	if (
		!profiles ||
		!clauses ||
		!denyTools ||
		!denyPaths ||
		!recentDenials ||
		typeof guardrails?.noNetwork !== "boolean" ||
		typeof guardrails.secretsBlind !== "boolean" ||
		intrinsicTools?.yield !== true ||
		typeof intrinsicTools.reportToolIssue !== "boolean"
	)
		return undefined;
	return Object.freeze({
		mode,
		profiles,
		clauses,
		denyTools,
		denyPaths,
		guardrails: Object.freeze({ noNetwork: guardrails.noNetwork, secretsBlind: guardrails.secretsBlind }),
		intrinsicTools: Object.freeze({ yield: true, reportToolIssue: intrinsicTools.reportToolIssue }),
		recentDenials,
	});
}

/** Canonical projection from the complete private scope to bounded display-only metadata. */
export function buildEffectivePermissionSummary(
	scope: EffectiveSubagentPermissions,
	recentDenials: readonly PermissionDenialDetails[] | BoundedList<PermissionDenialDetails> = [],
): EffectivePermissionSummary {
	const recentDenialSource = Array.isArray(recentDenials) ? boundedSummarySource(recentDenials) : recentDenials;
	const source = {
		mode: scope.mode,
		profiles: boundedSummarySource(scope.profiles),
		clauses: boundedSummarySource(
			(scope.clauses ?? []).map(clause => ({
				tools: boundedSummarySource(clause.descriptorIds ?? []),
				allowPathSets: boundedSummarySource(
					(clause.allowPathSets ?? []).map(pathSet => boundedSummarySource(pathSet)),
				),
			})),
		),
		denyTools: boundedSummarySource(scope.denyTools),
		denyPaths: boundedSummarySource(scope.denyPaths),
		guardrails: scope.guardrails ?? { noNetwork: false, secretsBlind: false },
		intrinsicTools: scope.intrinsicTools ?? { yield: true as const, reportToolIssue: false },
		recentDenials: recentDenialSource,
	};
	const summary = normalizeEffectivePermissionSummary(source);
	if (!summary) throw new TypeError("Compiled permission scope could not be summarized.");
	return summary;
}

/** Append one denial through the canonical sanitizer while retaining the newest bounded history. */
export function appendPermissionDenialToSummary(
	summary: EffectivePermissionSummary,
	denial: PermissionDenialDetails,
): EffectivePermissionSummary {
	const current = normalizeEffectivePermissionSummary(summary);
	if (!current) throw new TypeError("Current permission summary is not canonical.");
	const candidate = normalizeEffectivePermissionSummary({
		...current,
		recentDenials: { items: [denial], omittedCount: 0 },
	});
	const normalizedDenial = candidate?.recentDenials.items[0];
	let omittedCount = current.recentDenials.omittedCount;
	let items = [...current.recentDenials.items];
	if (normalizedDenial === undefined) {
		omittedCount = addSummaryOmittedCount(omittedCount, 1);
	} else {
		items.push(normalizedDenial);
		if (items.length > SUMMARY_RECENT_DENIAL_LIMIT) {
			const evicted = items.length - SUMMARY_RECENT_DENIAL_LIMIT;
			items = items.slice(evicted);
			omittedCount = addSummaryOmittedCount(omittedCount, evicted);
		}
	}
	const replacement = normalizeEffectivePermissionSummary({
		...current,
		recentDenials: { items, omittedCount },
	});
	if (!replacement) throw new TypeError("Permission denial could not be recorded.");
	return replacement;
}
function formatBoundedItems(items: readonly string[], omittedCount: number): string {
	if (items.length === 0) return omittedCount > 0 ? `+${omittedCount} omitted` : "none";
	return `${items.join(", ")}${omittedCount > 0 ? ` (+${omittedCount} omitted)` : ""}`;
}

/**
 * Deterministic display projection of the canonical bounded permission summary.
 * Only explicitly display-safe fields are read: this must never grow provenance,
 * hashes, snapshots, denial reasons, or denial targets into a UI surface.
 */
export function formatEffectivePermissionSummaryLines(summary: EffectivePermissionSummary): string[] {
	const lines = [
		`Permissions: mode ${summary.mode}`,
		`Profiles: ${formatBoundedItems(summary.profiles.items, summary.profiles.omittedCount)}`,
	];
	if (summary.clauses.items.length === 0) lines.push("Clauses: none");
	else {
		for (const [index, clause] of summary.clauses.items.entries()) {
			const pathSets = clause.allowPathSets.items.map(set => `[${formatBoundedItems(set.items, set.omittedCount)}]`);
			lines.push(
				`Clause ${index + 1}: tools ${formatBoundedItems(clause.tools.items, clause.tools.omittedCount)}; path sets ${formatBoundedItems(pathSets, clause.allowPathSets.omittedCount)}`,
			);
		}
	}
	if (summary.clauses.omittedCount > 0) lines.push(`Clauses omitted: ${summary.clauses.omittedCount}`);
	lines.push(
		`Deny tools: ${formatBoundedItems(summary.denyTools.items, summary.denyTools.omittedCount)}`,
		`Deny paths: ${formatBoundedItems(summary.denyPaths.items, summary.denyPaths.omittedCount)}`,
		`Guardrails: no-network ${summary.guardrails.noNetwork ? "on" : "off"}; secrets-blind ${summary.guardrails.secretsBlind ? "on" : "off"}`,
		`Intrinsic tools: yield on; report-tool-issue ${summary.intrinsicTools.reportToolIssue ? "on" : "off"}`,
		`Recent denial codes: ${formatBoundedItems(
			summary.recentDenials.items.map(denial => denial.code),
			summary.recentDenials.omittedCount,
		)}`,
	);
	return lines;
}

export const BUILTIN_PERMISSION_PROFILES: Record<string, PermissionProfile> = {
	"read-only": {
		description: "Read/search/code-intelligence only. No edits, shell, browser, web search, or child delegation.",
		useWhen: "Investigation, review, planning, and file discovery.",
		tools: ["read", "search", "find", "lsp", "hub"],
	},
	"focused-edit": {
		description:
			"Read/search/edit/write within the selected path scope. No shell, browser, web search, or child delegation.",
		useWhen: "Bounded source/test edits where the parent will run verification.",
		tools: ["read", "search", "find", "lsp", "edit", "write", "ast_grep", "ast_edit", "hub"],
	},
	"test-runner": {
		description: "Read/search plus shell execution for targeted verification. No edits or child delegation.",
		useWhen: "Running a specific test/check command after implementation.",
		tools: ["read", "search", "find", "bash", "hub"],
	},
	"no-network": {
		description:
			"Modifier-only profile that denies browser and web-search tools; pair with a role profile or inline permissions.tools when tool enforcement is in enforce mode.",
		useWhen:
			"Local-repository work that should not fetch external context; use alongside a role profile or inline permissions.tools in enforce mode.",
		denyTools: ["browser", "web_search"],
	},
	"no-delegation": {
		description:
			"Modifier-only profile that denies spawning child subagents; pair with a role profile or inline permissions.tools when tool enforcement is in enforce mode.",
		useWhen:
			"Small scoped tasks that should not fan out further; use alongside a role profile or inline permissions.tools in enforce mode.",
		denyTools: ["task"],
	},
	"secrets-blind": {
		description:
			"Modifier-only profile that prevents access to local secrets, credentials, and private key material without granting tools.",
		useWhen:
			"Pair with a role profile or inline permissions.tools when tool enforcement is in enforce mode and the task should avoid environment files, credentials, SSH material, or Kubernetes config.",
		denyPaths: ["**/.env", "**/.env.*", "**/*secret*", "**/*credential*", "**/*private*key*", ".ssh/**", ".kube/**"],
	},
	"browser-audit": {
		description: "Fail-closed browser audit with no raw browser or child delegation capability.",
		useWhen: "Host-authorized browser inspection and interaction in a spawned specialist.",
		tools: ["browser_audit"],
		denyTools: ["browser", "task", "hub", "web_search"],
	},
};

type ProfileSource = PermissionProfileSummary["source"];

const PROFILE_FILES: Array<{ relativePath: string; source: ProfileSource }> = [
	{ relativePath: ".omp/permissions.json", source: "project" },
	{ relativePath: ".omp/permissions.local.json", source: "local" },
];

const PATH_KEYS = new Set(["path", "paths", "file", "file_path", "relative_path", "cwd", "dir"]);
const RESERVED_PERMISSION_PROFILE_NAMES = new Set(["browser-audit", "secrets-blind", "no-network"]);

/** Permission files may use the historical IRC spelling; runtime tools use hub. */
export function normalizePermissionToolName(name: string): string {
	return name.trim().toLowerCase() === "irc" ? "hub" : (normalizeToolNames([name])[0] ?? name);
}

function normalizePermissionTools(values: readonly string[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = normalizePermissionToolName(value);
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

function canonicalProfileName(name: string): string {
	return name.trim().toLowerCase();
}

function canonicalProfile(profile: PermissionProfile): PermissionProfile {
	return {
		...(profile.description === undefined ? {} : { description: profile.description }),
		...(profile.useWhen === undefined ? {} : { useWhen: profile.useWhen }),
		...(profile.tools === undefined ? {} : { tools: uniqueStrings(profile.tools) }),
		...(profile.denyTools === undefined ? {} : { denyTools: uniqueStrings(profile.denyTools) }),
		...(profile.allowPaths === undefined ? {} : { allowPaths: uniqueStrings(profile.allowPaths) }),
		...(profile.denyPaths === undefined ? {} : { denyPaths: uniqueStrings(profile.denyPaths) }),
	};
}

function normalizedProfileForComparison(profile: PermissionProfile): PermissionProfile {
	const canonical = canonicalProfile(profile);
	return {
		...canonical,
		...(canonical.tools === undefined ? {} : { tools: normalizePermissionTools(canonical.tools) }),
		...(canonical.denyTools === undefined ? {} : { denyTools: normalizePermissionTools(canonical.denyTools) }),
	};
}

function profilesEqual(left: PermissionProfile | undefined, right: PermissionProfile | undefined): boolean {
	return (
		JSON.stringify(normalizedProfileForComparison(left ?? {})) ===
		JSON.stringify(normalizedProfileForComparison(right ?? {}))
	);
}

/** Classify omitted, no-op, ambient, and concrete request shapes without mutating the wire object. */
export function classifyTaskPermissionRequest(
	request: TaskPermissionRequest | undefined,
	profiles: Record<string, PermissionProfile> = BUILTIN_PERMISSION_PROFILES,
): TaskPermissionRequestShape {
	if (request === undefined) return "omitted";
	const profileNames = request.profiles ?? [];
	const selected = profileNames.map(name => profiles[name] ?? {}).map(canonicalProfile);
	const hasProfiles = profileNames.length > 0;
	const hasPositiveProfile = selected.some(profile => Object.hasOwn(profile, "tools"));
	const hasToolAllow = request.tools !== undefined;
	const hasToolDeny = (request.denyTools?.length ?? 0) > 0;
	const hasPath = (request.allowPaths?.length ?? 0) > 0 || (request.denyPaths?.length ?? 0) > 0;
	const hasAnyEffectiveField =
		profileNames.length > 0 ||
		request.tools !== undefined ||
		(request.denyTools?.length ?? 0) > 0 ||
		(request.allowPaths?.length ?? 0) > 0 ||
		(request.denyPaths?.length ?? 0) > 0;
	if (!hasAnyEffectiveField) return "empty";
	if (hasToolAllow && request.tools?.length === 0) return "explicit-tools-allow-none";
	if (hasToolAllow && request.tools && request.tools.length > 0)
		return hasPath || hasToolDeny || hasProfiles ? "mixed" : "explicit-tools-allowlist";
	if (hasProfiles && hasPositiveProfile) return hasPath || hasToolDeny ? "mixed" : "profile-positive";
	if (hasToolDeny && !hasProfiles && !hasPath) return "deny-only";
	if (hasPath && !hasProfiles && !hasToolDeny) return "path-only-ambient";
	if ((hasProfiles || hasToolDeny) && !hasPositiveProfile) return "modifier-only";
	return "mixed";
}

/** Short alias retained for internal adapters that describe this as request shape. */
export const classifyPermissionRequest = classifyTaskPermissionRequest;

export async function loadPermissionProfiles(cwd: string): Promise<{
	profiles: Record<string, PermissionProfile>;
	profileIdentities: Record<string, PermissionProfileIdentity>;
	summaries: PermissionProfileSummary[];
	errors: string[];
}> {
	const profiles: Record<string, PermissionProfile> = {};
	const sources = new Map<string, ProfileSource>();
	for (const [name, profile] of Object.entries(BUILTIN_PERMISSION_PROFILES)) {
		const canonicalName = canonicalProfileName(name);
		profiles[canonicalName] = canonicalProfile(profile);
		sources.set(canonicalName, "built-in");
	}
	const errors: string[] = [];

	for (const file of PROFILE_FILES) {
		const filePath = path.resolve(cwd, file.relativePath);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(filePath, "utf8"));
		} catch (error) {
			if (isMissingFileError(error)) continue;
			errors.push(`${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const fileProfiles = readProfileMap(parsed);
		if (!fileProfiles) continue;
		for (const [rawName, rawProfile] of Object.entries(fileProfiles)) {
			const name = canonicalProfileName(rawName);
			const profile = canonicalProfile(rawProfile);
			const existing = profiles[name];
			if (existing !== undefined && RESERVED_PERMISSION_PROFILE_NAMES.has(name)) {
				if (!profilesEqual(existing, profile)) {
					errors.push(`${file.relativePath}: permission profile "${name}" is reserved and cannot be overridden`);
				}
				continue;
			}
			if (
				existing !== undefined &&
				sources.get(name) !== file.source &&
				name === "no-network" &&
				!profilesEqual(existing, profile)
			) {
				errors.push(`${file.relativePath}: permission profile "${name}" is reserved and cannot be overridden`);
				continue;
			}
			profiles[name] = profile;
			sources.set(name, file.source);
		}
	}

	const profileIdentities = Object.fromEntries(
		Object.keys(profiles).map(name => {
			const source = sources.get(name) ?? "project";
			const canonicalSha256 = createHash("sha256")
				.update(canonicalPermissionValue(normalizedProfileForComparison(profiles[name] ?? {})))
				.digest("hex");
			return [name, Object.freeze({ name, source, canonicalSha256 })];
		}),
	) as Record<string, PermissionProfileIdentity>;
	return {
		profiles,
		profileIdentities,
		summaries: Object.keys(profiles).map(name =>
			summarizeProfile(name, profiles[name] ?? {}, sources.get(name) ?? "project"),
		),
		errors,
	};
}
export function composeEffectivePermissions(input: {
	mode: SubagentPermissionMode;
	toolsEnabled: boolean;
	pathsEnabled: boolean;
	actorId: string;
	actorKind: "main" | "sub" | "advisor";
	parentId?: string;
	request?: TaskPermissionRequest;
	inherited?: EffectiveSubagentPermissions;
	profiles: Record<string, PermissionProfile>;
	/** Complete runtime route inventory, including eval, MCP, and intrinsic tools. */
	capabilities?: readonly PermissionCapability[];
	/** Exact loader/source identities for profile descriptors. */
	profileIdentities?: Readonly<Record<string, PermissionProfileIdentity>>;
}): { ok: true; value: CompiledSubagentPermissions } | { ok: false; error: string } {
	const requestShape = classifyTaskPermissionRequest(input.request, input.profiles);
	const base = {
		mode: input.mode,
		toolsEnabled: input.toolsEnabled,
		pathsEnabled: input.pathsEnabled,
		actorId: input.actorId,
		actorKind: input.actorKind,
		parentId: input.parentId,
	};
	const requestedProfiles = input.request?.profiles ?? [];
	const selectedProfiles: Array<{ name: string; profile: PermissionProfile; identity: PermissionProfileIdentity }> =
		[];
	for (const requestedName of requestedProfiles) {
		const name = canonicalProfileName(requestedName);
		const profile = input.profiles[name] ?? input.profiles[requestedName];
		if (!profile) {
			return {
				ok: false,
				error: `Unknown permission profile "${requestedName}". Available: ${Object.keys(input.profiles).sort().join(", ")}`,
			};
		}
		selectedProfiles.push({
			name,
			profile: canonicalProfile(profile),
			identity:
				input.profileIdentities?.[name] ??
				Object.freeze({
					name,
					source: "request",
					canonicalSha256: createHash("sha256")
						.update(canonicalPermissionValue(normalizedProfileForComparison(profile)))
						.digest("hex"),
				}),
		});
	}
	if (input.mode === "off") {
		return {
			ok: true,
			value: compilePermissionScope({
				...base,
				profiles: [],
				tools: undefined,
				denyTools: [],
				allowPaths: [],
				denyPaths: [],
				allowPathGroups: [],
				denyPathGroups: [],
				requestShape,
				inherited: undefined,
				capabilities: input.capabilities,
			}),
		};
	}
	const selectedProfilesOnly = selectedProfiles.map(entry => entry.profile);
	const profileAllowlists = selectedProfilesOnly.flatMap(profile =>
		Object.hasOwn(profile, "tools") ? [uniqueTools(profile.tools ?? [])] : [],
	);
	const profileHasAllowlist = profileAllowlists.length > 0;
	const hasProfileToolControls = selectedProfilesOnly.some(
		profile => Object.hasOwn(profile, "tools") || (profile.denyTools?.length ?? 0) > 0,
	);
	const hasProfilePathControls = selectedProfilesOnly.some(
		profile => (profile.allowPaths?.length ?? 0) > 0 || (profile.denyPaths?.length ?? 0) > 0,
	);
	const requestTools = input.request?.tools;
	const requestDenyTools = input.request?.denyTools;
	const requestAllowPaths = input.request?.allowPaths;
	const requestDenyPaths = input.request?.denyPaths;
	const hasToolControls = requestTools !== undefined || (requestDenyTools?.length ?? 0) > 0 || hasProfileToolControls;
	const hasPathControls =
		(requestAllowPaths?.length ?? 0) > 0 || (requestDenyPaths?.length ?? 0) > 0 || hasProfilePathControls;
	if (!input.toolsEnabled && hasToolControls)
		return {
			ok: false,
			error: "Subagent tool permissions are disabled; remove tool clauses or enable task.permissions.tools.enabled.",
		};
	if (!input.pathsEnabled && hasPathControls)
		return {
			ok: false,
			error: "Subagent path permissions are disabled; remove path clauses or enable task.permissions.paths.enabled.",
		};
	const noOpInherit = input.inherited !== undefined && (requestShape === "omitted" || requestShape === "empty");
	let tools: string[] | undefined;
	if (profileHasAllowlist) tools = intersectToolRows(profileAllowlists);
	if (requestTools !== undefined)
		tools = tools === undefined ? uniqueTools(requestTools) : intersectTools(tools, uniqueTools(requestTools));
	if (input.inherited?.tools !== undefined)
		tools = tools === undefined ? [...input.inherited.tools] : intersectTools(tools, input.inherited.tools);
	const toolAllowlistDefined = tools !== undefined || input.inherited?.tools !== undefined;
	if (
		input.mode === "enforce" &&
		input.toolsEnabled &&
		requestNeedsToolAllowlist(input.request) &&
		!toolAllowlistDefined
	)
		return {
			ok: false,
			error: "Subagent tool permissions require a concrete allowlist. Add permissions.tools or at least one role profile with tools; modifier-only profiles only add restrictions.",
		};
	const denyTools = input.toolsEnabled
		? uniqueTools([
				...selectedProfilesOnly.flatMap(profile => profile.denyTools ?? []),
				...(requestDenyTools ?? []),
				...(input.inherited?.denyTools ?? []),
			])
		: [];
	const profileAllowGroups = selectedProfilesOnly.flatMap(profile => {
		const group = toPathConstraintGroup(profile.allowPaths);
		return group ? [group] : [];
	});
	const requestAllowGroups = toPathConstraintGroup(requestAllowPaths);
	const inheritedAllowGroups = input.inherited?.allowPathGroups ?? toPathGroups(input.inherited?.allowPaths);
	const allowPathGroups = input.pathsEnabled
		? [...(inheritedAllowGroups ?? []), ...profileAllowGroups, ...(requestAllowGroups ? [requestAllowGroups] : [])]
		: [];
	const profileDenyGroups = selectedProfilesOnly.flatMap(profile => {
		const group = toPathConstraintGroup(profile.denyPaths);
		return group ? [group] : [];
	});
	const requestDenyGroups = toPathConstraintGroup(requestDenyPaths);
	const inheritedDenyGroups = input.inherited?.denyPathGroups ?? toPathGroups(input.inherited?.denyPaths);
	const denyPathGroups = input.pathsEnabled
		? [...(inheritedDenyGroups ?? []), ...profileDenyGroups, ...(requestDenyGroups ? [requestDenyGroups] : [])]
		: [];
	const inheritedProfiles = input.inherited?.profiles ?? [];
	return {
		ok: true,
		value: compilePermissionScope({
			...base,
			profiles: noOpInherit
				? [...inheritedProfiles]
				: uniqueStrings([...inheritedProfiles, ...selectedProfiles.map(entry => entry.name)]),
			tools: noOpInherit
				? input.inherited?.tools === undefined
					? undefined
					: [...input.inherited.tools]
				: toolAllowlistDefined
					? (tools ?? [])
					: undefined,
			denyTools: noOpInherit ? [...(input.inherited?.denyTools ?? [])] : denyTools,
			allowPaths: flattenPathGroups(noOpInherit ? (inheritedAllowGroups ?? []) : allowPathGroups),
			denyPaths: flattenPathGroups(noOpInherit ? (inheritedDenyGroups ?? []) : denyPathGroups),
			allowPathGroups: noOpInherit ? [...(inheritedAllowGroups ?? [])] : allowPathGroups,
			denyPathGroups: noOpInherit ? [...(inheritedDenyGroups ?? [])] : denyPathGroups,
			requestShape,
			inherited: input.inherited,
			selectedProfiles: noOpInherit ? undefined : selectedProfiles,
			capabilities: input.capabilities,
		}),
	};
}
export interface PermissionGuardrailPreflightInput {
	readonly mode: SubagentPermissionMode;
	readonly toolsEnabled: boolean;
	readonly pathsEnabled: boolean;
	readonly actorId: string;
	readonly actorKind: "main" | "sub" | "advisor";
	readonly parentId?: string;
	readonly request?: TaskPermissionRequest;
	readonly inherited?: EffectiveSubagentPermissions;
	readonly profiles: Record<string, PermissionProfile>;
	readonly capabilities?: readonly PermissionCapability[];
	readonly profileIdentities?: Readonly<Record<string, PermissionProfileIdentity>>;
}
export function preflightPermissionGuardrails(
	input: PermissionGuardrailPreflightInput,
): { ok: true; value: CompiledSubagentPermissions } | { ok: false; error: string } {
	const composed = composeEffectivePermissions(input);
	if (!composed.ok) return composed;
	const scope = composed.value;
	if (input.mode !== "enforce" || scope.restrictedState === "unrestricted-root-ambient") return composed;
	const available = new Set(scope.availableTools?.map(tool => normalizePermissionToolName(tool).toLowerCase()));
	const exposedUnclassified = (input.capabilities ?? []).filter(
		capability =>
			(capability.source === "custom" || capability.source === "opaque") &&
			(available.size === 0 || available.has(normalizePermissionToolName(capability.name).toLowerCase())),
	);
	if (exposedUnclassified.length > 0 && scope.tools === undefined) {
		return {
			ok: false,
			error: "Cannot enforce subagent permissions while custom or opaque tool routes are exposed without a concrete tool allowlist.",
		};
	}
	return composed;
}
function descriptorRecords(
	capabilities: readonly PermissionCapability[] | undefined,
	inherited: EffectiveSubagentPermissions | undefined,
): readonly EffectiveToolDescriptor[] {
	const source = capabilities?.flatMap(capability => (capability.descriptor ? [capability.descriptor] : []));
	if (source && source.length > 0)
		return Object.freeze([...new Map(source.map(descriptor => [descriptor.descriptorId, descriptor])).values()]);
	return inherited?.availableDescriptors ?? [];
}

function descriptorIdsForNames(
	values: readonly string[] | undefined,
	descriptors: readonly EffectiveToolDescriptor[],
): readonly string[] | undefined {
	if (values === undefined) return undefined;
	if (descriptors.length === 0) return [...values];
	const byName = new Map<string, EffectiveToolDescriptor>();
	for (const descriptor of descriptors) byName.set(descriptor.normalizedName, descriptor);
	return uniqueStrings(
		values.map(value => byName.get(normalizePermissionToolName(value).toLowerCase())?.descriptorId ?? value),
	);
}

/** Compile immutable scopes while retaining exact post-precedence descriptors. */
function compilePermissionScope(input: {
	mode: SubagentPermissionMode;
	toolsEnabled: boolean;
	pathsEnabled: boolean;
	actorId: string;
	actorKind: "main" | "sub" | "advisor";
	parentId?: string;
	profiles: string[];
	tools?: string[];
	denyTools: string[];
	allowPaths: string[];
	denyPaths: string[];
	allowPathGroups?: PathConstraintGroup[];
	denyPathGroups?: PathConstraintGroup[];
	requestShape: TaskPermissionRequestShape;
	inherited?: EffectiveSubagentPermissions;
	selectedProfiles?: Array<{ name: string; profile: PermissionProfile; identity: PermissionProfileIdentity }>;
	capabilities?: readonly PermissionCapability[];
}): CompiledSubagentPermissions {
	const restrictedState: RestrictedPermissionState =
		input.mode === "off"
			? "unrestricted-root-ambient"
			: input.requestShape === "omitted" || input.requestShape === "empty"
				? input.inherited === undefined
					? "unrestricted-root-ambient"
					: "restricted"
				: "restricted";
	const allowPathGroups = input.allowPathGroups ?? toPathGroups(input.allowPaths);
	const denyPathGroups = input.denyPathGroups ?? toPathGroups(input.denyPaths);
	const descriptors = descriptorRecords(input.capabilities, input.inherited);
	const clauses: CompiledPermissionClause[] = [];
	for (const selected of input.selectedProfiles ?? []) {
		const descriptorIds =
			descriptorIdsForNames(
				normalizePermissionTools(concatStrings(selected.profile.tools, selected.profile.denyTools)),
				descriptors,
			) ?? [];
		const allowPathSets = toPathConstraintGroup(selected.profile.allowPaths);
		const denyPathSets = toPathConstraintGroup(selected.profile.denyPaths);
		clauses.push({
			source: "profile",
			name: selected.name,
			...(descriptorIds.length > 0 ? { descriptorIds } : {}),
			...(allowPathSets ? { allowPathSets: [allowPathSets] } : {}),
			...(denyPathSets ? { denyPathSets: [denyPathSets] } : {}),
		});
	}
	if (
		input.tools !== undefined ||
		input.denyTools.length > 0 ||
		allowPathGroups.length > 0 ||
		denyPathGroups.length > 0
	)
		clauses.push({
			source: "inline",
			...(input.tools === undefined ? {} : { descriptorIds: descriptorIdsForNames(input.tools, descriptors) }),
			...(allowPathGroups.length > 0 ? { allowPathSets: allowPathGroups } : {}),
			...(denyPathGroups.length > 0 ? { denyPathSets: denyPathGroups } : {}),
		});
	if (input.inherited !== undefined)
		clauses.push({
			source: "inherited",
			...(input.inherited.tools
				? {
						descriptorIds:
							input.inherited.allowedDescriptorIds ?? descriptorIdsForNames(input.inherited.tools, descriptors),
					}
				: {}),
			...(input.inherited.allowPathGroups ? { allowPathSets: input.inherited.allowPathGroups } : {}),
			...(input.inherited.denyPathGroups ? { denyPathSets: input.inherited.denyPathGroups } : {}),
		});
	const availableTools = input.capabilities
		? uniqueTools(input.capabilities.map(capability => capability.name))
		: input.inherited?.availableTools
			? [...input.inherited.availableTools]
			: input.tools;
	const allowedDescriptorIds =
		input.tools !== undefined
			? descriptorIdsForNames(input.tools, descriptors)
			: (input.inherited?.allowedDescriptorIds ??
				uniqueStrings(clauses.flatMap(clause => clause.descriptorIds ?? [])));
	const inheritedProfileIdentities = input.inherited?.provenance?.profiles ?? [];
	const selectedProfileIdentities = input.selectedProfiles?.map(selected => selected.identity) ?? [];
	const profileIdentities = [...inheritedProfileIdentities, ...selectedProfileIdentities].filter(
		(identity, index, values) => values.findIndex(candidate => candidate.name === identity.name) === index,
	);
	const source: PermissionProvenance["source"] = input.inherited
		? "inherited"
		: profileIdentities.some(identity => identity.source === "local")
			? "local"
			: profileIdentities.some(identity => identity.source === "project")
				? "project"
				: input.selectedProfiles?.length
					? "request"
					: "builtin";
	const provenance: PermissionProvenance = Object.freeze({
		source,
		profileNames: Object.freeze([...input.profiles]),
		profiles: Object.freeze(profileIdentities.map(identity => Object.freeze({ ...identity }))),
	});
	return Object.freeze({
		mode: input.mode,
		toolsEnabled: input.toolsEnabled,
		pathsEnabled: input.pathsEnabled,
		actorId: input.actorId,
		actorKind: input.actorKind,
		parentId: input.parentId,
		profiles: Object.freeze([...input.profiles]),
		tools: input.tools === undefined ? undefined : Object.freeze([...input.tools]),
		denyTools: Object.freeze([...input.denyTools]),
		allowPaths: Object.freeze(flattenPathGroups(allowPathGroups)),
		denyPaths: Object.freeze(flattenPathGroups(denyPathGroups)),
		allowPathGroups: Object.freeze(allowPathGroups.map(group => Object.freeze([...group]) as PathConstraintGroup)),
		denyPathGroups: Object.freeze(denyPathGroups.map(group => Object.freeze([...group]) as PathConstraintGroup)),
		availableTools: availableTools === undefined ? undefined : Object.freeze([...availableTools]),
		availableDescriptors: Object.freeze([...descriptors]),
		allowedDescriptorIds: allowedDescriptorIds === undefined ? undefined : Object.freeze([...allowedDescriptorIds]),
		clauses: Object.freeze(clauses.map(clause => Object.freeze(clause))),
		guardrails: Object.freeze({
			noNetwork: input.denyTools.some(tool => ["browser", "web_search"].includes(normalizePermissionToolName(tool))),
			secretsBlind: input.denyPaths.some(
				pattern =>
					pattern.includes("secret") ||
					pattern.includes("credential") ||
					pattern.includes("private*key") ||
					pattern.includes(".env"),
			),
		}),
		intrinsicTools: Object.freeze({ yield: true as const, reportToolIssue: restrictedState === "restricted" }),
		restrictedState,
		provenance,
	} satisfies CompiledSubagentPermissions);
}

export function evaluateSubagentPermission(input: {
	scope: EffectiveSubagentPermissions | undefined;
	toolName: string;
	toolInput: Record<string, unknown>;
	cwd: string;
}): PermissionDenial {
	const { scope, toolName } = input;
	if (scope?.mode !== "enforce") return allowDecision();
	const normalizedToolName = normalizePermissionToolName(toolName);
	if (normalizedToolName === "yield") return allowDecision();
	if (normalizedToolName === "report_tool_issue") {
		const restrictedState = "restrictedState" in scope ? scope.restrictedState : "restricted";
		if (restrictedState === "restricted") return allowDecision();
	}
	const pathCandidates = (): PathCandidate[] =>
		collectPathCandidates(input.toolInput, input.cwd, normalizedToolName === "bash");
	const filesystemPathCandidates = (): PathCandidate[] =>
		pathCandidates().filter(candidate => !candidate.display.toLowerCase().startsWith("local://"));
	const targets = (candidates: readonly PathCandidate[]): BoundedList<PermissionTargetSummary> => ({
		items: candidates.map(candidate => ({ kind: "path" as const, display: candidate.display })),
		omittedCount: 0,
	});
	const deny = (
		code: PermissionDenialDetails["code"],
		reason: string,
		matched: string,
		candidates: readonly PathCandidate[] = [],
	): PermissionDenial => ({
		action: "deny",
		reason,
		matched,
		details: {
			kind: "subagent_permission_denial",
			code,
			tool: toolName,
			targets: targets(candidates),
			matched,
			reason,
		},
	});

	if (scope.toolsEnabled) {
		const deniedTool = scope.denyTools.find(
			tool => normalizePermissionToolName(tool).toLowerCase() === normalizedToolName,
		);
		if (deniedTool) {
			const reason = `BLOCKED: Subagent permission profile denied tool '${toolName}'.`;
			return deny(
				"tool-deny",
				reason,
				`subagent:tool-deny:${normalizePermissionToolName(deniedTool)}`,
				pathCandidates(),
			);
		}
		if (
			scope.tools &&
			!scope.tools.some(tool => normalizePermissionToolName(tool).toLowerCase() === normalizedToolName)
		) {
			const reason = `BLOCKED: Subagent permission profile does not allow tool '${toolName}'.`;
			return deny("tool-not-allowed", reason, "subagent:tool-allowlist", pathCandidates());
		}
	}

	if (scope.pathsEnabled) {
		const candidates = filesystemPathCandidates();
		const denyGroups = scope.denyPathGroups ?? toPathGroups(scope.denyPaths);
		const allowGroups = scope.allowPathGroups ?? toPathGroups(scope.allowPaths);
		for (const candidate of candidates) {
			const deniedPattern = denyGroups.find(group =>
				group.some(pattern => pathMatches(candidate, pattern, input.cwd)),
			)?.[0];
			if (deniedPattern !== undefined) {
				const reason = `BLOCKED: Subagent permission profile denied path '${candidate.display}'.`;
				return deny("path-deny", reason, `subagent:path-deny:${deniedPattern}`, [candidate]);
			}
		}
		if (allowGroups.length > 0) {
			for (const candidate of candidates) {
				if (!allowGroups.every(group => group.some(pattern => pathMatches(candidate, pattern, input.cwd)))) {
					const reason = `BLOCKED: Subagent permission profile does not allow path '${candidate.display}'.`;
					return deny("path-not-allowed", reason, "subagent:path-allowlist", [candidate]);
				}
			}
		}
	}

	return allowDecision();
}

export function formatPermissionScopeForPrompt(scope: EffectiveSubagentPermissions | undefined): string {
	if (!scope || scope.mode === "off") return "";
	return `PERMISSIONS
===================================

You are running under task guardrails, not a security sandbox.
Profiles: ${scope.profiles.length > 0 ? scope.profiles.join(", ") : "none"}
Tool allowlist: ${scope.tools === undefined ? "unrestricted" : scope.tools.length > 0 ? scope.tools.join(", ") : "none"}
Denied tools: ${scope.denyTools.length > 0 ? scope.denyTools.join(", ") : "none"}
Allowed paths: ${scope.allowPaths.length > 0 ? scope.allowPaths.join(", ") : "unrestricted"}
Denied paths: ${scope.denyPaths.length > 0 ? scope.denyPaths.join(", ") : "none"}

Stay within this scope. Do not try to bypass it with bash/eval or indirect writes. If the assignment requires access outside this scope, ask Main via irc when available or yield a blocker describing the missing permission.`;
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function readProfileMap(value: unknown): Record<string, PermissionProfile> | undefined {
	if (!isRecord(value)) return undefined;
	const rawProfiles = value.profiles;
	if (!isRecord(rawProfiles)) return undefined;
	const result: Record<string, PermissionProfile> = {};
	for (const [name, rawProfile] of Object.entries(rawProfiles)) {
		if (!isRecord(rawProfile)) continue;
		const profile = normalizeProfile(rawProfile);
		if (profile) result[name] = profile;
	}
	return result;
}

function normalizeProfile(value: Record<string, unknown>): PermissionProfile | undefined {
	const profile: PermissionProfile = {};
	if (typeof value.description === "string") profile.description = value.description;
	if (typeof value.useWhen === "string") profile.useWhen = value.useWhen;
	const tools = stringArray(value.tools);
	if (tools) profile.tools = tools;
	const denyTools = stringArray(value.denyTools);
	if (denyTools) profile.denyTools = denyTools;
	const allowPaths = stringArray(value.allowPaths);
	if (allowPaths) profile.allowPaths = allowPaths;
	const denyPaths = stringArray(value.denyPaths);
	if (denyPaths) profile.denyPaths = denyPaths;
	return Object.keys(profile).length > 0 ? profile : undefined;
}

function requestNeedsToolAllowlist(request: TaskPermissionRequest | undefined): boolean {
	if (!request) return false;
	return (request.profiles?.length ?? 0) > 0 || request.tools !== undefined || (request.denyTools?.length ?? 0) > 0;
}

function summarizeProfile(name: string, profile: PermissionProfile, source: ProfileSource): PermissionProfileSummary {
	const allowedTools =
		profile.tools === undefined
			? "no tool allowlist (modifier-only)"
			: profile.tools.length > 0
				? `allow ${profile.tools.join(", ")}`
				: "allow none";
	const deniedTools = profile.denyTools?.length ? `deny ${profile.denyTools.join(", ")}` : "deny none";
	const allowedPaths = profile.allowPaths?.length ? `allow ${profile.allowPaths.join(", ")}` : "allow unrestricted";
	const deniedPaths = profile.denyPaths?.length ? `deny ${profile.denyPaths.join(", ")}` : "deny none";
	return {
		name,
		description: profile.description ?? "",
		useWhen: profile.useWhen ?? "",
		toolsSummary: `${allowedTools}; ${deniedTools}`,
		pathsSummary: `${allowedPaths}; ${deniedPaths}`,
		source,
	};
}

function concatStrings(...values: Array<readonly string[] | undefined>): string[];
function concatStrings(
	values: ReadonlyArray<readonly string[] | undefined>,
	...extra: Array<readonly string[] | undefined>
): string[];
function concatStrings(
	first: ReadonlyArray<readonly string[] | undefined> | readonly string[] | undefined,
	...extra: Array<readonly string[] | undefined>
): string[] {
	const parts =
		Array.isArray(first) && first.every(item => Array.isArray(item) || item === undefined)
			? [...(first as ReadonlyArray<readonly string[] | undefined>), ...extra]
			: [first as readonly string[] | undefined, ...extra];
	const result: string[] = [];
	for (const part of parts) {
		if (!part) continue;
		for (const item of part) {
			if (typeof item === "string" && item.length > 0) result.push(item);
		}
	}
	return result;
}

function uniqueTools(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = normalizePermissionToolName(value);
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}
function toPathConstraintGroup(values: readonly string[] | undefined): PathConstraintGroup | undefined {
	if (!values || values.length === 0) return undefined;
	return [values[0]!, ...values.slice(1)];
}

type PathCandidate = {
	display: string;
	absolute: string;
	relative: string;
};
function intersectTools(left: readonly string[], right: readonly string[]): string[] {
	const allowed = new Set(right.map(value => normalizePermissionToolName(value).toLowerCase()));
	return uniqueTools([...left].filter(value => allowed.has(normalizePermissionToolName(value).toLowerCase())));
}

function intersectToolRows(rows: readonly (readonly string[])[]): string[] {
	const first = rows[0] ?? [];
	return rows.slice(1).reduce<string[]>((current, row) => intersectTools(current, row), uniqueTools([...first]));
}

function toPathGroups(values: readonly string[] | undefined): PathConstraintGroup[] {
	const group = toPathConstraintGroup(values);
	return group ? [group] : [];
}

function flattenPathGroups(groups: readonly PathConstraintGroup[]): string[] {
	return uniqueStrings(groups.flatMap(group => [...group]));
}

/** Structural, fail-closed no-broader check. Globs are compared canonically only. */
export function isScopeNoBroader(parent: EffectiveSubagentPermissions, child: EffectiveSubagentPermissions): boolean {
	if (parent.mode === "enforce" && child.mode !== "enforce") return false;
	if (parent.toolsEnabled && !child.toolsEnabled) return false;
	if (parent.pathsEnabled && !child.pathsEnabled) return false;
	if (!isSubset(child.tools, parent.tools)) return false;
	if (!isSubset(child.availableTools, parent.availableTools)) return false;
	const parentDenies = new Set(parent.denyTools.map(value => normalizePermissionToolName(value).toLowerCase()));
	const childDenies = new Set(child.denyTools.map(value => normalizePermissionToolName(value).toLowerCase()));
	if ([...parentDenies].some(value => !childDenies.has(value))) return false;
	const parentAllowGroups = parent.allowPathGroups ?? toPathGroups(parent.allowPaths);
	const childAllowGroups = child.allowPathGroups ?? toPathGroups(child.allowPaths);
	if (!containsExactGroups(childAllowGroups, parentAllowGroups)) return false;
	const parentDenyGroups = parent.denyPathGroups ?? toPathGroups(parent.denyPaths);
	const childDenyGroups = child.denyPathGroups ?? toPathGroups(child.denyPaths);
	if (!containsExactGroups(childDenyGroups, parentDenyGroups)) return false;
	if (parent.guardrails?.noNetwork && !child.guardrails?.noNetwork) return false;
	if (parent.guardrails?.secretsBlind && !child.guardrails?.secretsBlind) return false;
	if (parent.intrinsicTools?.yield && !child.intrinsicTools?.yield) return false;
	if (parent.intrinsicTools?.reportToolIssue && !child.intrinsicTools?.reportToolIssue) return false;
	return true;
}

function isSubset(child: readonly string[] | undefined, parent: readonly string[] | undefined): boolean {
	if (parent === undefined) return true;
	if (child === undefined) return false;
	const parentValues = new Set(parent.map(value => normalizePermissionToolName(value).toLowerCase()));
	return child.every(value => parentValues.has(normalizePermissionToolName(value).toLowerCase()));
}

function containsExactGroups(
	candidates: readonly PathConstraintGroup[],
	required: readonly PathConstraintGroup[],
): boolean {
	const candidateGroups = new Set(candidates.map(canonicalGroup));
	return required.every(group => candidateGroups.has(canonicalGroup(group)));
}

function canonicalGroup(group: PathConstraintGroup): string {
	return JSON.stringify([...new Set(group.map(value => value.replaceAll("\\", "/")))].sort());
}

function collectPathCandidates(
	input: Record<string, unknown>,
	cwd: string,
	includeBashCommand: boolean,
): PathCandidate[] {
	const raw = new Set<string>();
	collectPathStrings(input, raw, 0);
	if (includeBashCommand && typeof input.command === "string") {
		for (const token of tokenizeBashPaths(input.command)) raw.add(token);
	}
	return Array.from(raw).map(value => normalizePathCandidate(value, cwd));
}

function collectPathStrings(value: unknown, output: Set<string>, depth: number, key?: string): void {
	if (depth > 4) return;
	if (typeof value === "string") {
		if (key && PATH_KEYS.has(key)) output.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPathStrings(item, output, depth + 1, key);
		return;
	}
	if (!isRecord(value)) return;
	for (const [childKey, childValue] of Object.entries(value)) {
		if (PATH_KEYS.has(childKey)) collectPathStrings(childValue, output, depth + 1, childKey);
		else if (typeof childValue === "object" && childValue !== null) collectPathStrings(childValue, output, depth + 1);
	}
}

function tokenizeBashPaths(command: string): string[] {
	return command
		.split(/[\s;&|()<>]+/)
		.map(token => token.trim().replace(/^['"]|['"]$/g, ""))
		.filter(token => token.length > 0 && looksPathLike(token));
}

function looksPathLike(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("~/") ||
		value.includes("/")
	);
}
export interface PermissionScopeSnapshot {
	readonly scope: DeepImmutable<EffectiveSubagentPermissions>;
	readonly canonicalSha256: string;
}

function canonicalPermissionSnapshot(scope: EffectiveSubagentPermissions): EffectiveSubagentPermissions {
	if (Object.getPrototypeOf(scope) !== Object.prototype && Object.getPrototypeOf(scope) !== null) {
		throw new TypeError("Permission snapshots may contain only plain objects and arrays.");
	}
	const { availableDescriptors: _availableDescriptors, ...snapshot } = scope;
	return snapshot;
}

/** Canonical typed representation used both for the content hash and drift detection. */
function canonicalPermissionValue(value: unknown): string {
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
	return `object:{${Object.keys(value as Record<string, unknown>)
		.filter(key => (value as Record<string, unknown>)[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalPermissionValue((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}

function cloneAndFreezePermissionValue<T>(value: T, active = new WeakSet<object>()): DeepImmutable<T> {
	if (value === null || typeof value !== "object") return value as DeepImmutable<T>;
	if (active.has(value)) throw new TypeError("Permission snapshots cannot contain cyclic values.");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			return Object.freeze(value.map(item => cloneAndFreezePermissionValue(item, active))) as DeepImmutable<T>;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			throw new TypeError("Permission snapshots may contain only plain objects and arrays.");
		}
		const clone: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>)) {
			clone[key] = cloneAndFreezePermissionValue((value as Record<string, unknown>)[key], active);
		}
		return Object.freeze(clone) as DeepImmutable<T>;
	} finally {
		active.delete(value);
	}
}

export function freezePermissionScope(scope: EffectiveSubagentPermissions): PermissionScopeSnapshot {
	const frozen = cloneAndFreezePermissionValue(canonicalPermissionSnapshot(scope));
	const canonicalSha256 = createHash("sha256").update(canonicalPermissionValue(frozen)).digest("hex");
	return Object.freeze({ scope: frozen, canonicalSha256 });
}

export function permissionScopeDrifted(
	snapshot: PermissionScopeSnapshot,
	scope: EffectiveSubagentPermissions,
): boolean {
	return (
		snapshot.canonicalSha256 !==
		createHash("sha256")
			.update(canonicalPermissionValue(canonicalPermissionSnapshot(scope)))
			.digest("hex")
	);
}

function normalizePathCandidate(value: string, cwd: string): PathCandidate {
	const expanded = value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value;
	const absolute = (path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded)).replace(
		/\\/g,
		"/",
	);
	let relative = path.relative(cwd, absolute).replace(/\\/g, "/");
	if (relative === "") relative = ".";
	return { display: value, absolute, relative };
}

function pathMatches(candidate: PathCandidate, pattern: string, cwd: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, "/");
	if (path.isAbsolute(normalizedPattern) || normalizedPattern.startsWith("~/")) {
		const absolutePattern = normalizePathCandidate(normalizedPattern, cwd).absolute;
		return matchesGlob(candidate.absolute, absolutePattern);
	}
	return matchesGlob(candidate.relative, normalizedPattern) || matchesGlob(candidate.absolute, normalizedPattern);
}

function regexEscape(text: string): string {
	return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
	let output = "^";
	for (const char of glob) {
		if (char === "*") output += ".*";
		else if (char === "?") output += ".";
		else output += regexEscape(char);
	}
	// Linux and other case-sensitive hosts must preserve filesystem identity.
	// Windows and the default macOS filesystem semantics remain case-insensitive.
	const caseInsensitiveHost = process.platform === "win32" || process.platform === "darwin";
	return new RegExp(`${output}$`, caseInsensitiveHost ? "i" : "");
}

function matchesGlob(value: string, glob: string): boolean {
	if (glob.startsWith("**/") && matchesGlob(value, glob.slice(3))) return true;
	return globToRegex(glob).test(value);
}

function allowDecision(): PermissionDenial {
	return { action: "allow", reason: "", matched: "" };
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
