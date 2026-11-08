import { evaluatePermissionGuardrails, isSecretPath, secretsBlindDenial } from "./guardrails";
import {
	expandListTargets,
	hasPathRules,
	type PathCandidate,
	pathMatchesPattern,
	permissionListTargets,
	permissionPathArguments,
	toPathCandidate,
} from "./path-rules";
import {
	isUnprovableEffectTool,
	MESSAGING_GRANT,
	normalizePermissionToolName,
	permissionToolKey,
	permissionToolOwner,
} from "./tool-names";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type { PermissionDecision, PermissionDenialCode, PermissionScope } from "./types";

const ALLOW: PermissionDecision = Object.freeze({ action: "allow", reason: "", matched: "" });

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
	/** The call's resolved approval tier; a multi-action tool's mutating actions report `write` or `exec`. */
	readonly tier?: ToolTier;
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

function hasScheme(target: string, scheme: string): boolean {
	return target.toLowerCase().startsWith(scheme);
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

/** Tools granted by name for their read actions whose other actions edit files or launch processes. */
const MUTATING_ACTION_TOOLS: ReadonlySet<string> = new Set(["lsp", "github", "debug", "ida"]);

/** Tools whose grant lets a scope write files. */
const FILE_WRITE_TOOLS: readonly string[] = ["write", "edit", "ast_edit"];

function evaluateToolName(
	scope: PermissionScope,
	toolName: string,
	key: string,
	targets: readonly string[],
	tier: ToolTier | undefined,
): PermissionDecision {
	const denied = (name: string) => scope.denyTools.find(tool => permissionToolKey(tool) === name);
	const listed = (name: string) =>
		scope.tools === undefined || scope.tools.some(tool => permissionToolKey(tool) === name);
	const grantsFileWrites = FILE_WRITE_TOOLS.some(name => listed(name) && denied(name) === undefined);
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
	if (listed(key) || (owner !== undefined && listed(owner))) {
		// A name grant covers what the call does only for read actions; `lsp rename_file` moves files.
		if (MUTATING_ACTION_TOOLS.has(key) && tier !== undefined && tier !== "read" && !grantsFileWrites) {
			return deny(
				"tool-not-allowed",
				`BLOCKED: Subagent permission profile allows only the read actions of tool '${toolName}'; this action changes files and the profile grants no file writes.`,
				"subagent:mutating-action",
				toolName,
				targets,
			);
		}
		return ALLOW;
	}
	const messaging = listed(MESSAGING_GRANT);
	if (key === "wait" && messaging) return ALLOW;
	// Without the `write` tool, `write` still reaches internal transports: `xd://` devices, and
	// `agent://` when messaging is granted. Its `local://` space is the parent's, shared by the whole
	// tree (plans, task files), so writing it needs a file-write grant. One filesystem target makes
	// it a file write.
	if (
		key === "write" &&
		targets.length > 0 &&
		targets.every(target =>
			hasScheme(target, "local://")
				? grantsFileWrites
				: hasScheme(target, "xd://") || (messaging && hasScheme(target, "agent://")),
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

/**
 * The `proc://` target a `write` names, if any: writing one sends a service stdin or kills it, so the
 * call executes rather than writes and answers to the `bash` grant and the unprovable-effect rule.
 */
function executionTarget(key: string, targets: readonly string[]): string | undefined {
	return key === "write" ? targets.find(target => hasScheme(target, "proc://")) : undefined;
}

function evaluateExecutionGrant(scope: PermissionScope, toolName: string, target: string): PermissionDecision {
	const bash = (tool: string) => permissionToolKey(tool) === "bash";
	if (!scope.denyTools.some(bash) && (scope.tools === undefined || scope.tools.some(bash))) return ALLOW;
	return deny(
		"tool-not-allowed",
		`BLOCKED: Subagent permission profile does not allow writing '${target}': driving a process needs the bash grant.`,
		"subagent:execution",
		toolName,
		[target],
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

	const execution = executionTarget(key, targets);
	if (scope.toolsEnabled) {
		const toolDecision = evaluateToolName(scope, toolName, key, targets, input.tier);
		if (toolDecision.action === "deny") return toolDecision;
		if (execution !== undefined) {
			const executionDecision = evaluateExecutionGrant(scope, toolName, execution);
			if (executionDecision.action === "deny") return executionDecision;
		}
	}
	if (hasUnprovableEffects(scope) && (isUnprovableEffectTool(key) || execution !== undefined)) {
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
	const guardrailDecision = evaluatePermissionGuardrails({
		scope,
		toolName,
		toolInput: input.toolInput,
		targets: input.targets,
	});
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
