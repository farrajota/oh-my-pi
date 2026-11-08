import { isMCPToolName } from "../../tools/builtin-names";
import { permissionToolKey } from "./tool-names";
import type { PermissionDecision, PermissionGuardrails, PermissionScope } from "./types";

const NETWORK_TOOLS: ReadonlySet<string> = new Set(["browser", "computer", "github", "web_search", "generate_image"]);

/**
 * Payload fields of the native mutation tools that carry file content or instructions, not targets.
 * Scanning them would deny an edit for merely mentioning a credential.
 */
const MUTATION_INERT_INPUT_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["ast_edit", new Set(["i", "ops"])],
	["edit", new Set(["i", "input", "old_string", "new_string"])],
	["write", new Set(["i", "content"])],
]);
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
const SECRETS_BLIND_REASON =
	"BLOCKED: secrets-blind guardrail denied an environment, credential, or private-key source.";

/** Guardrails implied by deny lists: browser or web_search denied, or a secret-like deny path. */
export function derivePermissionGuardrails(
	denyTools: readonly string[],
	denyPatterns: readonly string[],
): PermissionGuardrails {
	return {
		noNetwork: denyTools.some(tool => {
			const key = permissionToolKey(tool);
			return key === "browser" || key === "web_search";
		}),
		secretsBlind: denyPatterns.some(
			pattern =>
				pattern.includes("secret") ||
				pattern.includes("credential") ||
				pattern.includes("private*key") ||
				pattern.includes(".env"),
		),
	};
}

/** Whether a path names environment files, SSH or Kubernetes material, credentials or private keys. */
export function isSecretPath(value: string): boolean {
	return SECRET_PATH.test(value);
}

export function secretsBlindDenial(toolName: string, targets: readonly string[]): PermissionDecision {
	return guardrailDenial(SECRETS_BLIND_REASON, "guardrail:secrets-blind", toolName, targets);
}

function guardrailDenial(
	reason: string,
	matched: string,
	tool: string,
	targets: readonly string[] = [],
): PermissionDecision {
	return {
		action: "deny",
		reason,
		matched,
		details: { kind: "subagent_permission_denial", code: "guardrail", tool, targets: [...targets], matched, reason },
	};
}

/** Visit every string in `value`, stopping at the first the visitor flags. */
function visitInput(
	value: unknown,
	visitor: (value: string, key?: string) => boolean,
	key?: string,
	seen = new WeakSet<object>(),
	ignoredRootKeys?: ReadonlySet<string>,
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
		if (atRoot && ignoredRootKeys?.has(childKey)) continue;
		if (visitInput(child, visitor, childKey, seen, ignoredRootKeys, false)) return true;
	}
	return false;
}

function visitEditInput(value: Record<string, unknown>, visitor: (value: string, key?: string) => boolean): boolean {
	const ignored = new Set(MUTATION_INERT_INPUT_FIELDS.get("edit"));
	// Only native replace and patch payloads are inert; nested destinations and unknown keys stay visible.
	if (
		typeof value.path !== "string" ||
		Array.isArray(value.edits) ||
		typeof value.old_string !== "string" ||
		typeof value.new_string !== "string"
	) {
		ignored.delete("old_string");
		ignored.delete("new_string");
	}
	const seen = new WeakSet<object>();
	for (const [key, child] of Object.entries(value)) {
		if (ignored.has(key)) continue;
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

/**
 * The no-network and secrets-blind guardrails for one call. They read the call's arguments, so they
 * also catch targets no path rule names (`/proc/self/environ`, a URL, `printenv`). Enforce mode only:
 * suggest is advisory.
 */
export function evaluatePermissionGuardrails(input: {
	readonly scope: PermissionScope | undefined;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
}): PermissionDecision {
	const { scope, toolName, toolInput } = input;
	if (scope?.mode !== "enforce") return { action: "allow", reason: "", matched: "" };
	const key = permissionToolKey(toolName);
	if (scope.guardrails.noNetwork) {
		if (NETWORK_TOOLS.has(key) || isMCPToolName(key)) {
			return guardrailDenial(
				`BLOCKED: no-network guardrail denied tool '${toolName}'.`,
				"guardrail:no-network:tool",
				toolName,
			);
		}
		if (key === "read") {
			const target = typeof toolInput.path === "string" ? toolInput.path.trim() : "";
			if (EXTERNAL_READ_SCHEME.test(target) || BARE_NETWORK_TARGET.test(target)) {
				return guardrailDenial(
					`BLOCKED: no-network guardrail denied network read target '${target}'.`,
					"guardrail:no-network:read-url",
					toolName,
					[target],
				);
			}
		}
		if (key === "bash" && visitInput(toolInput, value => NETWORK_COMMAND.test(value))) {
			return guardrailDenial(
				"BLOCKED: no-network guardrail denied a network-capable shell request.",
				"guardrail:no-network:bash",
				toolName,
			);
		}
		if (key === "eval" && visitInput(toolInput, value => EVAL_NETWORK_ACCESS.test(value))) {
			return guardrailDenial(
				"BLOCKED: no-network guardrail denied raw network or browser access from eval.",
				"guardrail:no-network:eval",
				toolName,
			);
		}
	}
	if (scope.guardrails.secretsBlind) {
		const executes = key === "bash" || key === "eval";
		const inspect = (value: string, field?: string): boolean => {
			if (SECRET_PATH.test(value)) return true;
			if (executes && ENV_ACCESS.test(value)) return true;
			return executes && field !== undefined && /^(?:env|environment)$/i.test(field);
		};
		const sensitive =
			key === "edit"
				? visitEditInput(toolInput, inspect)
				: visitInput(toolInput, inspect, undefined, new WeakSet<object>(), MUTATION_INERT_INPUT_FIELDS.get(key));
		if (sensitive) return secretsBlindDenial(toolName, []);
	}
	return { action: "allow", reason: "", matched: "" };
}
