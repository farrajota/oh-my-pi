export const CONTENT_SAFETY_DETECTOR_VERSION = "deep-scope-content-safety/v2" as const;

export interface PromptInjectionFinding { readonly rule_id: string; readonly location: string; }
export interface SecretFinding { readonly rule_id: string; readonly location: string; }
type SafetyRule = Readonly<{ rule_id: string; pattern: RegExp }>;
const PROMPT_INJECTION_RULES: readonly SafetyRule[] = [
 { rule_id: "instruction_override", pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|earlier|the)\s+instructions?\b/i },
 { rule_id: "system_message", pattern: /\b(?:system|developer)\s+(?:prompt|message|instructions?)\s*:/i },
 { rule_id: "role_override", pattern: /\b(?:you are now|act as)\s+(?:the )?(?:system|developer|root)\b/i },
 { rule_id: "tool_exfiltration", pattern: /\b(?:exfiltrate|upload|send)\b.{0,80}\b(?:secret|credential|token|private key)\b/i },
];
const SECRET_RULES: readonly SafetyRule[] = [
 { rule_id: "private_key_pem", pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i },
 { rule_id: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
 { rule_id: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
 { rule_id: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
 { rule_id: "slack_token", pattern: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/ },
 { rule_id: "bearer_token", pattern: /\bbearer[ \t]+[A-Za-z0-9._~+/=-]{16,}\b/i },
 { rule_id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
 { rule_id: "credential_uri", pattern: /\b(?:https?|ssh|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s/@:]{1,128}:[^\s/@]{1,256}@[^\s/]+/i },
 { rule_id: "assigned_secret", pattern: /(["'])?\b(?:api[_-]?key|secret|password|passphrase|token|client[_-]?secret|private[_-]?key)\b\1\s*(?:=|:)\s*["']?[A-Za-z0-9._~+/=-]{16,}/i },
];
export function scanPromptInjection(text: string): readonly PromptInjectionFinding[] { return scanLines(text, PROMPT_INJECTION_RULES); }
export function scanHighConfidenceSecrets(text: string): readonly SecretFinding[] { return scanLines(text, SECRET_RULES); }
export function containsHighConfidenceSecret(text: string): boolean { return scanHighConfidenceSecrets(text).length > 0; }
export function assertIdeationExchangeContentSafe(input: { readonly exact_question: string; readonly accepted_answer: string }): void {
 const fields = [["exact_question", input.exact_question], ["accepted_answer", input.accepted_answer]] as const;
 for (const [field, value] of fields) {
  if (typeof value !== "string") continue;
  for (const finding of scanHighConfidenceSecrets(value)) {
   const category = finding.rule_id === "private_key_pem" ? "private-key" : ["bearer_token", "jwt"].includes(finding.rule_id) ? "bearer-token" : ["aws_access_key", "github_token", "gitlab_token", "slack_token"].includes(finding.rule_id) ? "provider-token" : "authorization-credential";
   const error = new Error(`IDEATION_EXCHANGE_SENSITIVE_CONTENT:${field}:${category}`) as Error & { code: string; field: string; category: string };
   error.code = "IDEATION_EXCHANGE_SENSITIVE_CONTENT"; error.field = field; error.category = category; throw error;
  }
 }
}
function scanLines(text: string, rules: readonly SafetyRule[]): readonly { readonly rule_id: string; readonly location: string }[] {
 const findings = new Map<string, { rule_id: string; location: string; line: number }>();
 const lines = text.split(/\r\n|[\n\r]/);
 for (const [index, lineText] of lines.entries()) for (const rule of rules) if (rule.pattern.test(lineText)) { const line = index + 1; findings.set(`${line}\u0000${rule.rule_id}`, { rule_id: rule.rule_id, location: `line:${line}`, line }); }
 return [...findings.values()].sort((a,b)=>a.line-b.line || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0)).map(({rule_id,location})=>({rule_id,location}));
}
