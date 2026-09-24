import type { BoundedList, PermissionDenialDetails, PermissionTargetSummary } from "@oh-my-pi/pi-wire";
import type { EffectiveSubagentPermissions, PermissionDenial } from "../task/permission-profiles";
import { normalizePermissionToolName } from "../task/permission-profiles";

export interface RestrictedStartupPolicy {
	readonly restricted: boolean;
	readonly noNetwork: boolean;
	readonly secretsBlind: boolean;
	/** Whether the effective scope constrains filesystem targets. */
	readonly hasPathConstraints: boolean;
	readonly toolNames: readonly string[] | undefined;
	readonly zeroTools: boolean;
	readonly allowExtensions: boolean;
	readonly allowCustomTools: boolean;
	readonly allowProviderDiscovery: boolean;
	readonly enableMCP: boolean;
	readonly enableLsp: boolean;
	readonly lspReadOnly: boolean;
}

export interface RestrictedStartupPolicyInput {
	readonly permissionScope?: EffectiveSubagentPermissions;
	readonly restrictToolNames?: boolean;
	readonly toolNames?: readonly string[];
	readonly allowRestrictedCustomTools?: boolean;
	readonly allowRestrictedExtensions?: boolean;
	readonly enableMCP?: boolean;
	readonly enableLsp?: boolean;
	readonly lspReadOnly?: boolean;
}

const NETWORK_TOOLS: Readonly<Record<string, true>> = Object.freeze({
	browser: true,
	computer: true,
	github: true,
	web_search: true,
	generate_image: true,
});

const MUTATION_TOOLS: Readonly<Record<string, true>> = Object.freeze({ ast_edit: true, edit: true, write: true });
const MUTATION_INERT_INPUT_FIELDS: Readonly<Record<string, Readonly<Record<string, true>>>> = Object.freeze({
	ast_edit: Object.freeze({ i: true, ops: true }),
	edit: Object.freeze({ i: true, input: true, old_string: true, new_string: true }),
	write: Object.freeze({ i: true, content: true }),
});
const EXTERNAL_READ_SCHEME = /^(?:https?|ftp|ssh|mcp|issue|pr):\/\//i;
const BARE_NETWORK_TARGET = /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}):\d+(?:\/|$)/i;
const NETWORK_COMMAND =
	/(?:\b(?:curl|wget|fetch|ssh|scp|sftp|telnet|ping|traceroute|nc|ncat|netcat|socat|dig|nslookup|host|gh)\b|\/dev\/(?:tcp|udp)\/|\b(?:git\s+(?:clone|fetch|pull|push|ls-remote)|(?:npm|pnpm|yarn|bun|pip|pip3|cargo)\s+(?:add|install|update)|go\s+get)\b|(?:https?|ftp|ssh):\/\/)/i;
const EVAL_NETWORK_ACCESS =
	/(?:\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\b(?:requests|httpx|urllib3?|aiohttp)\b|\b(?:node:)?https?\b|\b(?:browser|computer)\s*\.)/i;
const PROC_ENVIRON = String.raw`\/proc\/(?:self|thread-self|\d+(?:\/task\/\d+)?)\/environ`;
const SECRET_PATH = new RegExp(
	String.raw`(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.kube)(?:[\\/]|$)|${PROC_ENVIRON}|(?:secret|credential)|private[^\\/]*key`,
	"i",
);
const ENV_ACCESS = new RegExp(
	String.raw`(?:\bprocess\.env\b|\bBun\.env\b|\bos\.environ\b|\bgetenv\s*\(|\bENV\s*\[|${PROC_ENVIRON}|\b(?:printenv|env)\b|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)`,
	"i",
);

function uniqueNormalizedToolNames(values: readonly string[]): string[] {
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

function isRestrictedScope(scope: EffectiveSubagentPermissions | undefined): boolean {
	return scope !== undefined;
}

export function deriveRestrictedStartupPolicy(input: RestrictedStartupPolicyInput): RestrictedStartupPolicy {
	const scope = input.permissionScope;
	const noNetwork = scope?.guardrails?.noNetwork === true;
	const secretsBlind = scope?.guardrails?.secretsBlind === true;
	const hasPathConstraints =
		scope?.pathsEnabled === true &&
		(scope.allowPaths.length > 0 ||
			scope.denyPaths.length > 0 ||
			(scope.allowPathGroups?.length ?? 0) > 0 ||
			(scope.denyPathGroups?.length ?? 0) > 0);
	const restricted = input.restrictToolNames === true || noNetwork || secretsBlind || isRestrictedScope(scope);
	const unprovableEffects = noNetwork || secretsBlind || hasPathConstraints;
	const denied = new Set((scope?.denyTools ?? []).map(name => normalizePermissionToolName(name).toLowerCase()));
	const explicit = input.toolNames === undefined ? undefined : uniqueNormalizedToolNames(input.toolNames);
	const scoped = scope?.tools === undefined ? undefined : uniqueNormalizedToolNames(scope.tools);
	let toolNames: string[] | undefined;
	if (restricted) {
		if (explicit && scoped) {
			const scopedNames = new Set(scoped.map(name => name.toLowerCase()));
			toolNames = explicit.filter(name => scopedNames.has(name.toLowerCase()));
		} else {
			toolNames = explicit ?? scoped ?? [];
		}
		toolNames = toolNames.filter(name => !denied.has(name.toLowerCase()));
		if (unprovableEffects) {
			toolNames = toolNames.filter(name => {
				const normalized = name.toLowerCase();
				return (
					normalized !== "bash" &&
					normalized !== "eval" &&
					!normalized.startsWith("mcp__") &&
					(!noNetwork || NETWORK_TOOLS[normalized] !== true)
				);
			});
		}
	} else if (explicit) {
		toolNames = explicit;
	}
	const frozenToolNames = toolNames === undefined ? undefined : Object.freeze([...toolNames]);
	const deniesAllPaths =
		scope?.pathsEnabled === true && scope.denyPaths.some(pattern => /^(?:\*\*|\*\*\/\*)$/.test(pattern.trim()));
	const hasMutationAuthority =
		frozenToolNames?.some(name => MUTATION_TOOLS[name.toLowerCase()] === true) === true && !deniesAllPaths;
	const enableLsp =
		input.enableLsp !== false && (!restricted || frozenToolNames?.includes("lsp") === true) && !unprovableEffects;
	return Object.freeze({
		restricted,
		noNetwork,
		secretsBlind,
		hasPathConstraints,
		toolNames: frozenToolNames,
		zeroTools: restricted && frozenToolNames?.length === 0,
		allowExtensions: !restricted || input.allowRestrictedExtensions === true,
		allowCustomTools:
			!restricted ||
			(!unprovableEffects && input.allowRestrictedCustomTools === true && frozenToolNames !== undefined),
		allowProviderDiscovery: !restricted && !noNetwork,
		enableMCP: !restricted && !unprovableEffects && input.enableMCP !== false,
		enableLsp,
		lspReadOnly: input.lspReadOnly === true || (restricted && (!hasMutationAuthority || !enableLsp)),
	});
}

function visitInput(
	value: unknown,
	visitor: (value: string, key?: string) => boolean,
	key?: string,
	seen = new WeakSet<object>(),
	ignoredRootKeys?: Readonly<Record<string, true>>,
	atRoot = true,
): boolean {
	if (typeof value === "string") return visitor(value, key);
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		return value.some(item => visitInput(item, visitor, key, seen, ignoredRootKeys, false));
	}
	for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
		if (atRoot && ignoredRootKeys?.[childKey] === true) continue;
		if (visitInput(child, visitor, childKey, seen, ignoredRootKeys, false)) return true;
	}
	return false;
}
function visitEditInput(value: Record<string, unknown>, visitor: (value: string, key?: string) => boolean): boolean {
	const ignored = { ...MUTATION_INERT_INPUT_FIELDS.edit };
	// Only native replace and patch payloads are inert; nested destinations and unknown keys remain visible.
	if (
		typeof value.path !== "string" ||
		Array.isArray(value.edits) ||
		typeof value.old_string !== "string" ||
		typeof value.new_string !== "string"
	) {
		delete ignored.old_string;
		delete ignored.new_string;
	}
	const seen = new WeakSet<object>();
	for (const [key, child] of Object.entries(value)) {
		if (ignored[key] === true) continue;
		if (
			key === "edits" &&
			typeof value.path === "string" &&
			Array.isArray(child) &&
			value.old_string === undefined &&
			value.new_string === undefined
		) {
			for (const entry of child) {
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
					if (visitInput(entry, visitor, key, seen)) return true;
					continue;
				}
				for (const [entryKey, entryValue] of Object.entries(entry)) {
					if (entryKey === "diff" && typeof entryValue === "string") continue;
					if (visitInput(entryValue, visitor, entryKey, seen)) return true;
				}
			}
			continue;
		}
		if (visitInput(child, visitor, key, seen)) return true;
	}
	return false;
}

function deny(
	reasonText: string,
	matched: string,
	tool: string,
	targetItems: readonly PermissionTargetSummary[] = [],
): PermissionDenial {
	const reason = `BLOCKED: ${reasonText}`;
	const targets: BoundedList<PermissionTargetSummary> = { items: [...targetItems], omittedCount: 0 };
	const details: PermissionDenialDetails = {
		kind: "subagent_permission_denial",
		code: "guardrail",
		tool,
		targets,
		matched,
		reason,
	};
	return { action: "deny", reason, matched, details };
}

/** Semantic guardrails applied before extension callbacks, approval prompts, or tool effects. */
export function evaluateRestrictedToolGuardrails(input: {
	readonly scope?: EffectiveSubagentPermissions;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly canonicalFilesystemTarget?: true;
}): PermissionDenial {
	const guardrails = input.scope?.guardrails;
	const toolName = normalizePermissionToolName(input.toolName).toLowerCase();
	if (input.canonicalFilesystemTarget !== true && guardrails?.noNetwork) {
		if (NETWORK_TOOLS[toolName] === true || toolName.startsWith("mcp__")) {
			return deny(
				`no-network guardrail denied tool '${input.toolName}'.`,
				"guardrail:no-network:tool",
				input.toolName,
			);
		}
		if (toolName === "read") {
			const target = typeof input.toolInput.path === "string" ? input.toolInput.path.trim() : "";
			if (EXTERNAL_READ_SCHEME.test(target) || BARE_NETWORK_TARGET.test(target)) {
				return deny(
					`no-network guardrail denied network read target '${target}'.`,
					"guardrail:no-network:read-url",
					input.toolName,
					[{ kind: "network", display: target }],
				);
			}
		}
		if (toolName === "bash" && visitInput(input.toolInput, value => NETWORK_COMMAND.test(value))) {
			return deny(
				"no-network guardrail denied a network-capable shell request.",
				"guardrail:no-network:bash",
				input.toolName,
			);
		}
		if (toolName === "eval" && visitInput(input.toolInput, value => EVAL_NETWORK_ACCESS.test(value))) {
			return deny(
				"no-network guardrail denied raw network or browser access from eval.",
				"guardrail:no-network:eval",
				input.toolName,
			);
		}
	}
	if (guardrails?.secretsBlind) {
		const inspect = (value: string, key?: string): boolean => {
			if (SECRET_PATH.test(value)) return true;
			if ((toolName === "bash" || toolName === "eval") && ENV_ACCESS.test(value)) return true;
			return (toolName === "bash" || toolName === "eval") && key !== undefined && /^(?:env|environment)$/i.test(key);
		};
		const sensitive =
			input.canonicalFilesystemTarget === true
				? typeof input.toolInput.path === "string" && SECRET_PATH.test(input.toolInput.path)
				: toolName === "edit"
					? visitEditInput(input.toolInput, inspect)
					: visitInput(
							input.toolInput,
							inspect,
							undefined,
							new WeakSet<object>(),
							MUTATION_INERT_INPUT_FIELDS[toolName],
						);
		if (sensitive) {
			return deny(
				"secrets-blind guardrail denied an environment, credential, or private-" + "key source.",
				"guardrail:secrets-blind",
				input.toolName,
			);
		}
	}
	return { action: "allow", reason: "", matched: "" };
}

/** Clone plain startup metadata while retaining executable/class identities as opaque private handles. */
export function cloneAndFreezeStartupValue<T>(value: T, active = new WeakSet<object>()): T {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
	if (typeof value === "function") return value;
	if (active.has(value)) throw new TypeError("Startup metadata cannot contain cyclic plain values.");
	if (Array.isArray(value)) {
		active.add(value);
		try {
			return Object.freeze(value.map(item => cloneAndFreezeStartupValue(item, active))) as T;
		} finally {
			active.delete(value);
		}
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	active.add(value);
	try {
		const clone: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			clone[key] = cloneAndFreezeStartupValue(child, active);
		}
		return Object.freeze(clone) as T;
	} finally {
		active.delete(value);
	}
}
