import { evaluatePermissionGuardrails, isSecretPath, secretsBlindDenial } from "./guardrails";
import { hasPathRules, type PathCandidate, pathMatchesPattern, toPathCandidate } from "./path-rules";
import {
	isUnprovableEffectTool,
	MESSAGING_GRANT,
	normalizePermissionToolName,
	permissionToolKey,
	permissionToolOwner,
} from "./tool-names";
import type { PermissionDecision, PermissionDenialCode, PermissionScope } from "./types";

const ALLOW: PermissionDecision = Object.freeze({ action: "allow", reason: "", matched: "" });

/** Argument keys whose string values name filesystem targets. */
const PATH_KEYS: ReadonlySet<string> = new Set(["path", "paths", "file", "file_path", "relative_path", "cwd", "dir"]);

export interface PermissionCallInput {
	readonly scope: PermissionScope | undefined;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	/** Directory relative targets and relative patterns resolve against. */
	readonly cwd: string;
	/**
	 * Further absolute targets the call touches, such as realpath-resolved approval targets. Each must
	 * pass the same path rules as the targets named in `toolInput`, and the secrets-blind check.
	 */
	readonly targets?: readonly string[];
}

/** Whether path rules or guardrails apply, so a tool's effects must be provable from its targets. */
export function hasUnprovableEffects(scope: PermissionScope): boolean {
	return hasPathRules(scope) || scope.guardrails.noNetwork || scope.guardrails.secretsBlind;
}

function deny(
	code: PermissionDenialCode,
	reason: string,
	matched: string,
	tool: string,
	targets: readonly string[],
): PermissionDecision {
	return {
		action: "deny",
		reason,
		matched,
		details: { kind: "subagent_permission_denial", code, tool, targets: [...targets], matched, reason },
	};
}

function collectPathStrings(value: unknown, output: Set<string>, depth: number, key?: string): void {
	if (depth > 4) return;
	if (typeof value === "string") {
		if (key !== undefined && PATH_KEYS.has(key)) output.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPathStrings(item, output, depth + 1, key);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [childKey, childValue] of Object.entries(value)) {
		if (PATH_KEYS.has(childKey)) collectPathStrings(childValue, output, depth + 1, childKey);
		else if (typeof childValue === "object" && childValue !== null) collectPathStrings(childValue, output, depth + 1);
	}
}

/** The strings a call names under a path argument key (`path`, `paths`, `file`, `cwd`, ...), deduplicated. */
export function permissionPathArguments(toolInput: Record<string, unknown>): string[] {
	const named = new Set<string>();
	collectPathStrings(toolInput, named, 0);
	return [...named];
}

function hasScheme(target: string, scheme: string): boolean {
	return target.toLowerCase().startsWith(scheme);
}

const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\//i;

/** The top-level `;` entries of `target` (braces and backslash escapes protect a `;`), quotes stripped. */
function semicolonEntries(target: string): string[] {
	const entries: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < target.length; i++) {
		const ch = target[i];
		if (ch === "\\") i++;
		else if (ch === "{") depth++;
		else if (ch === "}" && depth > 0) depth--;
		else if (ch === ";" && depth === 0) {
			entries.push(target.slice(start, i));
			start = i + 1;
		}
	}
	entries.push(target.slice(start));
	return entries.map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(entry => entry.length > 0);
}

/**
 * What one path string stands for. Tools that take path lists (`read`, the search tools) open each
 * entry of a `;` list, so a list is judged by its entries: `local://x;.env` is the scratch file `x`
 * and `.env`, never one exempt URL. A plain string is judged whole too, because a literal file name
 * may contain `;`. A URL-shaped string is a list or one URL of its first entry's scheme, so its
 * entries cover it. Comma and whitespace lists split only when their entries exist; the approval
 * targets a tool reports resolve those.
 */
function permissionListTargets(target: string): string[] {
	if (!target.includes(";")) return [target];
	const entries = semicolonEntries(target);
	if (entries.length <= 1) return [target];
	return URL_SCHEME_PREFIX.test(target.trim()) ? entries : [target, ...entries];
}

function expandListTargets(targets: Iterable<string>): string[] {
	const expanded = new Set<string>();
	for (const target of targets) for (const entry of permissionListTargets(target)) expanded.add(entry);
	return [...expanded];
}

/**
 * Targets the filesystem path rules never see: one `local://` URL is the subagent's own scratch
 * space, and a `write` to `agent://` (a message) or `xd://` (a device, checked as its own tool when
 * it runs) is a transport rather than a file. Lists are expanded before this check, so a list that
 * starts with an exempt URL never exempts the entries after it.
 */
function isPathRuleExempt(toolKey: string, target: string): boolean {
	if (target.includes(";")) return false;
	if (hasScheme(target, "local://")) return true;
	return toolKey === "write" && (hasScheme(target, "agent://") || hasScheme(target, "xd://"));
}

/** Schemes that expose another agent's work: its transcript and its output, with the noun a denial names. */
const AGENT_RECORD_SCHEMES: readonly (readonly [scheme: string, noun: string])[] = [
	["history://", "history"],
	["agent://", "output"],
];

/**
 * The noun for `target` when it reads the transcript or output of an agent outside `actorId`'s own
 * subtree, else `undefined`. Nested agents have dot-qualified ids (`Parent.Child`), and a descendant
 * runs under its ancestor's scope, so the agent itself and its descendants stay readable. An index
 * (`history://`, `agent://`) names ids only, and `history://current` is the caller's own branch.
 */
function outsideOwnSubtree(target: string, actorId: string): string | undefined {
	for (const [scheme, noun] of AGENT_RECORD_SCHEMES) {
		if (!hasScheme(target, scheme)) continue;
		const id = target.slice(scheme.length).split(/[/:?#]/, 1)[0] ?? "";
		if (id.length === 0 || id === actorId || id.startsWith(`${actorId}.`)) return undefined;
		return scheme === "history://" && id.toLowerCase() === "current" ? undefined : noun;
	}
	return undefined;
}

/**
 * P7: a secrets-blind subagent cannot read the transcript or output of an agent outside its own
 * subtree, which may hold what it may not see. A `write` to `agent://` is a message, not a read.
 */
function otherAgentRecordDenial(
	scope: PermissionScope,
	toolName: string,
	targets: readonly string[],
): PermissionDecision | undefined {
	if (!scope.guardrails.secretsBlind) return undefined;
	const key = permissionToolKey(toolName);
	for (const target of targets) {
		if (key === "write" && hasScheme(target, "agent://")) continue;
		const noun = outsideOwnSubtree(target, scope.actorId);
		if (noun === undefined) continue;
		return deny(
			"guardrail",
			`BLOCKED: secrets-blind guardrail denied another agent's ${noun} '${target}'.`,
			`guardrail:secrets-blind-${noun}`,
			toolName,
			[target],
		);
	}
	return undefined;
}

function evaluateToolName(
	scope: PermissionScope,
	toolName: string,
	key: string,
	targets: readonly string[],
): PermissionDecision {
	const denied = (name: string) => scope.denyTools.find(tool => permissionToolKey(tool) === name);
	const listed = (name: string) =>
		scope.tools === undefined || scope.tools.some(tool => permissionToolKey(tool) === name);
	const owner = permissionToolOwner(key);
	const messagingUse = key === "wait" || (key === "write" && targets.some(target => hasScheme(target, "agent://")));
	const deniedTool =
		denied(key) ??
		(owner !== undefined ? denied(owner) : undefined) ??
		(messagingUse ? denied(MESSAGING_GRANT) : undefined);
	if (deniedTool !== undefined) {
		return deny(
			"tool-deny",
			`BLOCKED: Subagent permission profile denied tool '${toolName}'.`,
			`subagent:tool-deny:${normalizePermissionToolName(deniedTool)}`,
			toolName,
			targets,
		);
	}
	if (listed(key) || (owner !== undefined && listed(owner))) return ALLOW;
	const messaging = listed(MESSAGING_GRANT);
	if (key === "wait" && messaging) return ALLOW;
	// Without a write grant, `write` still reaches internal transports: its own `local://` space, `xd://`
	// devices, and `agent://` when messaging is granted. One filesystem target makes it a file write.
	if (
		key === "write" &&
		targets.length > 0 &&
		targets.every(
			target =>
				hasScheme(target, "local://") || hasScheme(target, "xd://") || (messaging && hasScheme(target, "agent://")),
		)
	) {
		return ALLOW;
	}
	return deny(
		"tool-not-allowed",
		`BLOCKED: Subagent permission profile does not allow tool '${toolName}'.`,
		"subagent:tool-allowlist",
		toolName,
		targets,
	);
}

function evaluatePathCandidates(
	scope: PermissionScope,
	toolName: string,
	candidates: readonly PathCandidate[],
	cwd: string,
): PermissionDecision {
	for (const candidate of candidates) {
		for (const group of scope.denyPathGroups) {
			const pattern = group.find(entry => pathMatchesPattern(candidate, entry, cwd));
			if (pattern !== undefined) {
				return deny(
					"path-deny",
					`BLOCKED: Subagent permission profile denied path '${candidate.display}'.`,
					`subagent:path-deny:${pattern}`,
					toolName,
					[candidate.display],
				);
			}
		}
	}
	for (const candidate of candidates) {
		if (!scope.allowPathGroups.every(group => group.some(entry => pathMatchesPattern(candidate, entry, cwd)))) {
			return deny(
				"path-not-allowed",
				`BLOCKED: Subagent permission profile does not allow path '${candidate.display}'.`,
				"subagent:path-allowlist",
				toolName,
				[candidate.display],
			);
		}
	}
	return ALLOW;
}

/**
 * Decide one tool call under a subagent scope. Only `enforce` denies; `off` and `suggest` allow.
 *
 * Order: intrinsic tools (`yield` always, `report_tool_issue` in a restricted scope), tool deny, tool
 * allowlist (with the messaging grant and write transports), unprovable effects, path deny, path
 * allowlist, then the guardrails.
 */
export function evaluateSubagentPermission(input: PermissionCallInput): PermissionDecision {
	const { scope, toolName } = input;
	if (scope?.mode !== "enforce") return ALLOW;
	const key = permissionToolKey(toolName);
	if (key === "yield") return ALLOW;
	if (key === "report_tool_issue" && scope.restricted) return ALLOW;

	const targets = expandListTargets([...permissionPathArguments(input.toolInput), ...(input.targets ?? [])]);

	if (scope.toolsEnabled) {
		const toolDecision = evaluateToolName(scope, toolName, key, targets);
		if (toolDecision.action === "deny") return toolDecision;
	}
	if (hasUnprovableEffects(scope) && isUnprovableEffectTool(key)) {
		return deny(
			"guardrail",
			`BLOCKED: Subagent permission scope cannot verify the effects of tool '${toolName}' while path rules or guardrails apply.`,
			"guardrail:unprovable-effect",
			toolName,
			[],
		);
	}
	if (hasPathRules(scope)) {
		const candidates = targets
			.filter(target => !isPathRuleExempt(key, target))
			.map(target => toPathCandidate(target, input.cwd));
		const pathDecision = evaluatePathCandidates(scope, toolName, candidates, input.cwd);
		if (pathDecision.action === "deny") return pathDecision;
	}
	const guardrailDecision = evaluatePermissionGuardrails({ scope, toolName, toolInput: input.toolInput });
	if (guardrailDecision.action === "deny") return guardrailDecision;
	const recordDenial = otherAgentRecordDenial(scope, toolName, targets);
	if (recordDenial) return recordDenial;
	if (scope.guardrails.secretsBlind) {
		const secret = expandListTargets(input.targets ?? []).find(isSecretPath);
		if (secret !== undefined) return secretsBlindDenial(toolName, [secret]);
	}
	return ALLOW;
}

/**
 * Decide one filesystem path a tool reached on its own, such as an entry a recursive search found:
 * the path rules and the secrets-blind check, without any tool-level rule.
 */
export function evaluatePermissionPath(input: {
	readonly scope: PermissionScope | undefined;
	readonly toolName: string;
	readonly path: string;
	readonly cwd: string;
}): PermissionDecision {
	const { scope, toolName } = input;
	if (scope?.mode !== "enforce") return ALLOW;
	const targets = permissionListTargets(input.path);
	if (hasPathRules(scope)) {
		const key = permissionToolKey(toolName);
		const candidates = targets
			.filter(target => !isPathRuleExempt(key, target))
			.map(target => toPathCandidate(target, input.cwd));
		const pathDecision = evaluatePathCandidates(scope, toolName, candidates, input.cwd);
		if (pathDecision.action === "deny") return pathDecision;
	}
	const recordDenial = otherAgentRecordDenial(scope, toolName, targets);
	if (recordDenial) return recordDenial;
	const secret = scope.guardrails.secretsBlind ? targets.find(isSecretPath) : undefined;
	if (secret !== undefined) return secretsBlindDenial(toolName, [secret]);
	return ALLOW;
}

/**
 * Decide the file an internal URL resolves to (P7): `url` as the caller named it, `path` the file it
 * located. Deny paths and secrets-blind apply to every scheme's files. The allowlist applies to every
 * scheme but `local://`, the subagent's own scratch space, which stays writable under `allowPaths`.
 */
export function evaluateInternalUrlFile(input: {
	readonly scope: PermissionScope | undefined;
	readonly url: string;
	readonly path: string;
	readonly cwd: string;
}): PermissionDecision {
	const { scope } = input;
	if (scope?.mode !== "enforce") return ALLOW;
	const toolName = "internal-url";
	if (hasPathRules(scope)) {
		const candidate: PathCandidate = { ...toPathCandidate(input.path, input.cwd), display: input.url };
		const rules = hasScheme(input.url, "local://") ? { ...scope, allowPathGroups: [] } : scope;
		const pathDecision = evaluatePathCandidates(rules, toolName, [candidate], input.cwd);
		if (pathDecision.action === "deny") return pathDecision;
	}
	if (scope.guardrails.secretsBlind && isSecretPath(input.path)) return secretsBlindDenial(toolName, [input.url]);
	return ALLOW;
}
