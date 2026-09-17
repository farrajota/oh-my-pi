import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

export const DISPOSITIONS = [
  "NO_SIMPLER_CHANGE",
  "INLINE_SIMPLIFICATION",
  "SCRIPT_COMPONENT_ONLY",
  "SCRIPT_PRIMARY",
  "MORE_EVIDENCE_REQUIRED",
  "NOT_APPLICABLE",
  "BLOCKED",
] as const;

export const RECHECK_CATEGORIES = [
  "frame",
  "mechanism",
  "correctness",
  "security",
  "state-concurrency",
  "decisive-evidence",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];
export type RecheckCategory = (typeof RECHECK_CATEGORIES)[number];
export type ValidationStatus = "invalid" | "stale" | "current";

export interface ValidationResult {
  status: ValidationStatus;
  reason?: string;
}

export interface ValidationInput {
  artifactPath: string;
  expectedTopicId: string;
  expectedFrameRevision: string;
  expectedCandidateId: string;
  changedCategories: readonly string[] | ReadonlySet<string>;
}

export interface ContentValidationInput extends ValidationInput {
  artifactText: string;
}

const TOPIC_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?-[0-9a-f]{12}(?:-[1-9]|-1[0-9]|-20|-[0-9]{8}T[0-9]{6}Z)?$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_FIELDS = [
  "schema_version",
  "topic_id",
  "frame_revision",
  "candidate_id",
  "disposition",
  "recheck_categories",
] as const;

const dispositionSet = new Set<string>(DISPOSITIONS);
const categorySet = new Set<string>(RECHECK_CATEGORIES);
const requiredFieldSet = new Set<string>(REQUIRED_FIELDS);

function invalid(reason: string): ValidationResult {
  return { status: "invalid", reason };
}

function canonicalTopicFromPath(artifactPath: string): string | null {
  if (typeof artifactPath !== "string" || artifactPath.length === 0 || artifactPath.includes("\0")) {
    return null;
  }

  // Reject lexical aliases for relative canonical paths. Absolute paths are accepted
  // so fixtures and checked-out repositories can be validated from any working dir.
  if (!isAbsolute(artifactPath) && normalize(artifactPath) !== artifactPath) {
    return null;
  }

  const resolved = resolve(artifactPath);
  const researchDirectory = dirname(resolved);
  if (basename(researchDirectory) !== "research" || basename(dirname(researchDirectory)) !== "ai_docs") {
    return null;
  }

  const filename = basename(resolved);
  if (!filename.endsWith(".md")) {
    return null;
  }

  const topicId = filename.slice(0, -3);
  return TOPIC_ID_PATTERN.test(topicId) ? topicId : null;
}

function extractDispositionBlock(artifactText: string):
  | { ok: true; jsonText: string }
  | { ok: false; reason: string } {
  if (typeof artifactText !== "string") {
    return { ok: false, reason: "artifact is not text" };
  }

  const headings = [...artifactText.matchAll(/^### Simplification disposition[ \t]*$/gm)];
  if (headings.length === 0) {
    return { ok: false, reason: "missing simplification disposition block" };
  }
  if (headings.length !== 1) {
    return { ok: false, reason: "duplicate simplification disposition blocks" };
  }

  const heading = headings[0];
  const afterHeading = artifactText.slice((heading.index ?? 0) + heading[0].length);
  const fence = afterHeading.match(
    /^\r?\n```([^\r\n]*)\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/,
  );
  if (!fence) {
    return { ok: false, reason: "simplification disposition block is not a fenced JSON block" };
  }
  if (fence[1].trim() !== "json") {
    return { ok: false, reason: "simplification disposition block must use the json fence" };
  }

  return { ok: true, jsonText: fence[2] };
}

function validateChangedCategories(changedCategories: readonly string[] | ReadonlySet<string>):
  | { ok: true; values: Set<RecheckCategory> }
  | { ok: false; reason: string } {
  const categories = Array.isArray(changedCategories)
    ? changedCategories
    : changedCategories instanceof Set
      ? [...changedCategories]
      : null;
  if (categories === null) {
    return { ok: false, reason: "changed category set is not an array or set" };
  }

  const values = new Set<RecheckCategory>();
  for (const category of categories) {
    if (typeof category !== "string" || !categorySet.has(category)) {
      return { ok: false, reason: "changed category set contains an unknown category" };
    }
    if (values.has(category as RecheckCategory)) {
      return { ok: false, reason: "changed category set contains duplicates" };
    }
    values.add(category as RecheckCategory);
  }
  return { ok: true, values };
}

function validateBlock(value: unknown):
  | { ok: true; categories: RecheckCategory[] }
  | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "disposition JSON must be an object" };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== REQUIRED_FIELDS.length || keys.some((key) => !requiredFieldSet.has(key))) {
    return { ok: false, reason: "disposition JSON has unknown or missing properties" };
  }

  if (record.schema_version !== 1 || !Number.isInteger(record.schema_version)) {
    return { ok: false, reason: "schema_version must be integer 1" };
  }
  if (typeof record.topic_id !== "string" || !TOPIC_ID_PATTERN.test(record.topic_id)) {
    return { ok: false, reason: "topic_id is not canonical" };
  }
  if (typeof record.frame_revision !== "string" || !ID_PATTERN.test(record.frame_revision)) {
    return { ok: false, reason: "frame_revision is invalid" };
  }
  if (typeof record.candidate_id !== "string" || !ID_PATTERN.test(record.candidate_id)) {
    return { ok: false, reason: "candidate_id is invalid" };
  }
  if (typeof record.disposition !== "string" || !dispositionSet.has(record.disposition)) {
    return { ok: false, reason: "disposition is not a closed enum value" };
  }
  if (!Array.isArray(record.recheck_categories)) {
    return { ok: false, reason: "recheck_categories must be an array" };
  }

  const categories: RecheckCategory[] = [];
  const seen = new Set<string>();
  for (const category of record.recheck_categories) {
    if (typeof category !== "string" || !categorySet.has(category)) {
      return { ok: false, reason: "recheck_categories contains an unknown category" };
    }
    if (seen.has(category)) {
      return { ok: false, reason: "recheck_categories contains duplicates" };
    }
    seen.add(category);
    categories.push(category as RecheckCategory);
  }

  return { ok: true, categories };
}

export function validateSimplificationDispositionContent(
  input: ContentValidationInput,
): ValidationResult {
  const pathTopicId = canonicalTopicFromPath(input.artifactPath);
  if (pathTopicId === null) {
    return invalid("artifact path is not canonical");
  }
  if (
    typeof input.expectedTopicId !== "string" ||
    !TOPIC_ID_PATTERN.test(input.expectedTopicId) ||
    pathTopicId !== input.expectedTopicId
  ) {
    return invalid("artifact path and expected topic identity do not match");
  }
  if (typeof input.expectedFrameRevision !== "string" || !ID_PATTERN.test(input.expectedFrameRevision)) {
    return invalid("expected frame identity is invalid");
  }
  if (typeof input.expectedCandidateId !== "string" || !ID_PATTERN.test(input.expectedCandidateId)) {
    return invalid("expected candidate identity is invalid");
  }

  const changed = validateChangedCategories(input.changedCategories);
  if (!changed.ok) {
    return invalid(changed.reason);
  }

  const extracted = extractDispositionBlock(input.artifactText);
  if (!extracted.ok) {
    return invalid(extracted.reason);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    return invalid("simplification disposition JSON is malformed");
  }

  const block = validateBlock(parsed);
  if (!block.ok) {
    return invalid(block.reason);
  }
  const disposition = parsed as Record<string, unknown>;
  if (
    disposition.topic_id !== input.expectedTopicId ||
    disposition.frame_revision !== input.expectedFrameRevision ||
    disposition.candidate_id !== input.expectedCandidateId
  ) {
    return invalid("disposition identity does not match expected topic, frame, or candidate");
  }

  const intersection = block.categories.some((category) => changed.values.has(category));
  return intersection ? { status: "stale" } : { status: "current" };
}

export async function validateSimplificationDisposition(input: ValidationInput): Promise<ValidationResult> {
  try {
    const artifactText = await Bun.file(input.artifactPath).text();
    return validateSimplificationDispositionContent({ ...input, artifactText });
  } catch {
    return invalid("canonical artifact could not be read");
  }
}

function usage(): string {
  return [
    "Usage:",
    "  bun run validate-simplification-disposition.ts <canonical-artifact-path> --topic-id <id> --frame-revision <revision> --candidate-id <id> --changed-categories <comma-separated-set>",
    "  bun run validate-simplification-disposition.ts <canonical-artifact-path> <topic-id> <frame-revision> <candidate-id> [comma-separated-set]",
  ].join("\n");
}

function parseCli(args: string[]): ValidationInput | null {
  if (args.length >= 4 && !args[1]?.startsWith("--")) {
    if (args.length > 5) return null;
    return {
      artifactPath: args[0],
      expectedTopicId: args[1],
      expectedFrameRevision: args[2],
      expectedCandidateId: args[3],
      changedCategories: parseCategories(args[4] ?? ""),
    };
  }

  const artifactPath = args[0];
  if (!artifactPath) return null;
  const values = new Map<string, string>();
  const aliases = new Map([
    ["topic-id", "topic-id"],
    ["topic", "topic-id"],
    ["frame-revision", "frame-revision"],
    ["frame", "frame-revision"],
    ["candidate-id", "candidate-id"],
    ["candidate", "candidate-id"],
    ["changed-categories", "changed-categories"],
    ["changed", "changed-categories"],
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) return null;
    const equals = token.indexOf("=");
    const rawKey = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    const key = aliases.get(rawKey);
    const value = equals >= 0 ? token.slice(equals + 1) : args[++index];
    if (!key || value === undefined || values.has(key)) return null;
    values.set(key, value);
  }

  const topicId = values.get("topic-id");
  const frameRevision = values.get("frame-revision");
  const candidateId = values.get("candidate-id");
  const changed = values.get("changed-categories");
  if (!topicId || !frameRevision || !candidateId || changed === undefined) return null;

  return {
    artifactPath,
    expectedTopicId: topicId,
    expectedFrameRevision: frameRevision,
    expectedCandidateId: candidateId,
    changedCategories: parseCategories(changed),
  };
}

function parseCategories(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [trimmed];
    } catch {
      return [trimmed];
    }
  }
  return trimmed.split(",").map((category) => category.trim());
}

if (import.meta.main) {
  const input = parseCli(process.argv.slice(2));
  if (!input) {
    console.error(usage());
    console.log(JSON.stringify({ status: "invalid", reason: "invalid command-line arguments" }));
    process.exitCode = 2;
  } else {
    const result = await validateSimplificationDisposition(input);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "current" ? 0 : result.status === "stale" ? 1 : 2;
  }
}
