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

/**
 * Targets the filesystem path rules never see: `local://` is the subagent's own scratch space, and a
 * `write` to `agent://` (a message) or `xd://` (a device, checked as its own tool when it runs) is a
 * transport rather than a file.
 */
function isPathRuleExempt(toolKey: string, target: string): boolean {
	if (hasScheme(target, "local://")) return true;
	return toolKey === "write" && (hasScheme(target, "agent://") || hasScheme(target, "xd://"));
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

	const targets = [...new Set([...permissionPathArguments(input.toolInput), ...(input.targets ?? [])])];

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
	if (scope.guardrails.secretsBlind) {
		const secret = (input.targets ?? []).find(isSecretPath);
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
	if (hasPathRules(scope) && !isPathRuleExempt(permissionToolKey(toolName), input.path)) {
		const pathDecision = evaluatePathCandidates(scope, toolName, [toPathCandidate(input.path, input.cwd)], input.cwd);
		if (pathDecision.action === "deny") return pathDecision;
	}
	if (scope.guardrails.secretsBlind && isSecretPath(input.path)) return secretsBlindDenial(toolName, [input.path]);
	return ALLOW;
}
