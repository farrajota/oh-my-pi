import { relative, resolve } from "node:path";
import {
  installImmutableAuthorityFile,
  readAuthorityFile,
} from "../../approval-dossier-runtime/scripts/authority-files.ts";
import {
  canonicalJson,
  canonicalizeValue,
  hashRawBytes,
  type JsonValue,
} from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import {
  validateExistingEvidence,
  type ExistingEvidenceValidation,
} from "./ideation-authoring-evidence.ts";

export const REVIEWER_LAUNCH_SCHEMA = "ideation-authoring/reviewer-launch/v1" as const;
export const REVIEWER_RAW_RESULT_SCHEMA = "ideation-authoring/reviewer-raw-result/v1" as const;
export const REVIEW_RECORD_SCHEMA = "ideation-authoring/review-record/v1" as const;
export const REPAIR_LEDGER_SCHEMA = "ideation-authoring/repair-ledger/v1" as const;
export const ROUND_CLOSURE_SCHEMA = "ideation-authoring/round-closure/v1" as const;
export const PREDECESSOR_EVIDENCE_EXCEPTION_SCHEMA = "ideation-authoring/predecessor-evidence-exception/v1" as const;

export const REVIEW_PERSPECTIVES = [
  "ux-design",
  "frontend-accessibility",
  "authority-security",
] as const;
export const REVIEW_VERDICTS = ["VALID", "VALID_WITH_CHANGES", "UNSOUND"] as const;

export type ReviewPerspective = (typeof REVIEW_PERSPECTIVES)[number];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type FindingClassification =
  | "binding-contract-failure"
  | "concrete-defect"
  | "advisory-preference";
export type FindingDisposition = "repaired" | "disputed" | "deferred-advisory";
export type RoundTerminalStatus = "accepted" | "requires-next-round" | "blocked";

export interface RoundClosureEvidenceInput {
  readonly artifact_manifest: string;
  readonly artifact_manifest_argument: string;
  readonly focused_command_root: string;
  readonly browser_root: string;
  readonly validated_manifest: string;
}

export type RoundClosureEvidenceValidator = (
  input: RoundClosureEvidenceInput,
) => Promise<ExistingEvidenceValidation>;
/** Test-only evidence verifier seam; production leaves this unset. */
export const ideationAuthoringReviewLifecycleHooks: {
  evidence_validator?: (reviewRound: number) => RoundClosureEvidenceValidator;
} = {};

function evidenceValidatorForRound(reviewRound: number): RoundClosureEvidenceValidator {
  return ideationAuthoringReviewLifecycleHooks.evidence_validator?.(reviewRound)
    ?? validateExistingEvidence;
}


type ObjectValue = Record<string, unknown>;

export interface ReviewerFinding {
  readonly id: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly classification: FindingClassification;
  readonly summary: string;
  readonly evidence: readonly string[];
}

/** The exact reviewer payload persisted in raw JSON and copied into a review record. */
export interface ReviewerResult {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewerFinding[];
  readonly dissent: readonly JsonValue[];
  readonly limitations: readonly JsonValue[];
}

export interface ReviewerLaunch {
  readonly schema: typeof REVIEWER_LAUNCH_SCHEMA;
  readonly round: number;
  readonly perspective: ReviewPerspective;
  readonly task_prompt_sha256: string;
  readonly reviewer_agent: string;
  readonly reviewer_config_sha256: string;
  readonly requested_model: string;
  readonly requested_provider: string;
  readonly resolved_model: string;
  readonly resolved_provider: string;
  readonly artifact_manifest_sha256: string;
  readonly browser_manifest_sha256: string;
  readonly evidence_set_sha256: string;
}

export interface ReviewerRawResult {
  readonly schema: typeof REVIEWER_RAW_RESULT_SCHEMA;
  readonly round: number;
  readonly perspective: ReviewPerspective;
  readonly launch_path: string;
  readonly launch_sha256: string;
  readonly evidence_set_sha256: string;
  /** The exact UTF-8 JSON object returned by the reviewer; never canonicalized or replaced. */
  readonly raw_result_json: string;
  readonly raw_result_sha256: string;
  readonly raw_result_byte_count: number;
}

export interface ReviewRecord extends ReviewerResult {
  readonly schema: typeof REVIEW_RECORD_SCHEMA;
  readonly record_path: string;
  readonly raw_path: string;
  readonly raw_record_sha256: string;
}

export interface ReviewReference {
  readonly perspective: ReviewPerspective;
  readonly path: string;
  readonly sha256: string;
}

export interface FindingDispositionRecord {
  readonly perspective: ReviewPerspective;
  readonly finding_id: string;
  readonly disposition: FindingDisposition;
  readonly rationale: string;
}

export interface AdvisoryDeferral {
  readonly perspective: ReviewPerspective;
  readonly finding_id: string;
  readonly rationale: string;
}

export interface RepairLedger {
  readonly schema: typeof REPAIR_LEDGER_SCHEMA;
  readonly round: number;
  readonly evidence_set_sha256: string;
  readonly reviews: readonly ReviewReference[];
  readonly dispositions: readonly FindingDispositionRecord[];
  readonly advisory_deferrals: readonly AdvisoryDeferral[];
}

export interface PreviousClosureReference {
  readonly path: string;
  readonly sha256: string;
  readonly exception?: { readonly path: string; readonly sha256: string };
}

export interface RoundClosure {
  readonly schema: typeof ROUND_CLOSURE_SCHEMA;
  readonly round: number;
  readonly previous_closure: PreviousClosureReference | null;
  readonly evidence_set_sha256: string;
  readonly launches: readonly ReviewReference[];
  readonly raw_results: readonly ReviewReference[];
  readonly review_records: readonly ReviewReference[];
  readonly repair_ledger: { readonly path: string; readonly sha256: string };
  readonly dispositions: readonly FindingDispositionRecord[];
  readonly advisory_deferrals: readonly AdvisoryDeferral[];
  readonly terminal_status: RoundTerminalStatus;
}
function authoringRoundPath(roundValue: number): string {
  assertRound(roundValue);
  return `authoring-rounds/round-${roundValue}`;
}

export function reviewerLaunchPath(round: number, perspective: ReviewPerspective): string {
  return `${authoringRoundPath(round)}/review-source/${assertPerspective(perspective)}.launch.json`;
}

export function reviewerRawResultPath(round: number, perspective: ReviewPerspective): string {
  return `${authoringRoundPath(round)}/review-source/${assertPerspective(perspective)}.raw.json`;
}

export function reviewRecordPath(round: number, perspective: ReviewPerspective): string {
  return `${authoringRoundPath(round)}/reviews/${assertPerspective(perspective)}.review.json`;
}

export function repairLedgerPath(round: number): string {
  return `${authoringRoundPath(round)}/repair-ledger.json`;
}

export function roundClosurePath(round: number): string {
  return `${authoringRoundPath(round)}/round-closure.json`;
}

export function reviewerLaunchSha256(value: ReviewerLaunch): string {
  return canonicalSha256(validateReviewerLaunch(value));
}

export function reviewerRawResultSha256(value: ReviewerRawResult): string {
  return canonicalSha256(validateReviewerRawResult(value));
}

export function reviewRecordSha256(value: ReviewRecord): string {
  return canonicalSha256(validateReviewRecord(value));
}

export function repairLedgerSha256(value: RepairLedger): string {
  return canonicalSha256(validateRepairLedger(value));
}

export function roundClosureSha256(value: RoundClosure): string {
  return canonicalSha256(validateRoundClosure(value));
}

export function validateReviewerLaunch(value: unknown): ReviewerLaunch {
  const record = closedObject(value, "launch", [
    "schema", "round", "perspective", "task_prompt_sha256", "reviewer_agent",
    "reviewer_config_sha256", "requested_model", "requested_provider", "resolved_model",
    "resolved_provider", "artifact_manifest_sha256", "browser_manifest_sha256", "evidence_set_sha256",
  ]);
  if (record.schema !== REVIEWER_LAUNCH_SCHEMA) fail("launch:schema");
  return Object.freeze({
    schema: REVIEWER_LAUNCH_SCHEMA,
    round: round(record.round, "launch.round"),
    perspective: perspective(record.perspective, "launch.perspective"),
    task_prompt_sha256: sha(record.task_prompt_sha256, "launch.task_prompt_sha256"),
    reviewer_agent: text(record.reviewer_agent, "launch.reviewer_agent"),
    reviewer_config_sha256: sha(record.reviewer_config_sha256, "launch.reviewer_config_sha256"),
    requested_model: text(record.requested_model, "launch.requested_model"),
    requested_provider: text(record.requested_provider, "launch.requested_provider"),
    resolved_model: text(record.resolved_model, "launch.resolved_model"),
    resolved_provider: text(record.resolved_provider, "launch.resolved_provider"),
    artifact_manifest_sha256: sha(record.artifact_manifest_sha256, "launch.artifact_manifest_sha256"),
    browser_manifest_sha256: sha(record.browser_manifest_sha256, "launch.browser_manifest_sha256"),
    evidence_set_sha256: sha(record.evidence_set_sha256, "launch.evidence_set_sha256"),
  });
}

export function validateReviewerResult(value: unknown): ReviewerResult {
  const record = closedObject(value, "reviewer-result", ["verdict", "findings", "dissent", "limitations"]);
  return Object.freeze({
    verdict: verdict(record.verdict, "reviewer-result.verdict"),
    findings: Object.freeze(array(record.findings, "reviewer-result.findings").map((finding, index) => validateFinding(finding, `reviewer-result.findings[${index}]`))),
    dissent: jsonArray(record.dissent, "reviewer-result.dissent"),
    limitations: jsonArray(record.limitations, "reviewer-result.limitations"),
  });
}

export function validateReviewerRawResult(value: unknown): ReviewerRawResult {
  const record = closedObject(value, "raw-result", [
    "schema", "round", "perspective", "launch_path", "launch_sha256", "evidence_set_sha256",
    "raw_result_json", "raw_result_sha256", "raw_result_byte_count",
  ]);
  if (record.schema !== REVIEWER_RAW_RESULT_SCHEMA) fail("raw-result:schema");
  const rawResultJson = text(record.raw_result_json, "raw-result.raw_result_json");
  const rawBytes = Buffer.from(rawResultJson, "utf8");
  if (sha(record.raw_result_sha256, "raw-result.raw_result_sha256") !== hashRawBytes(rawBytes)) fail("raw-result:raw-result-hash");
  if (byteCount(record.raw_result_byte_count, "raw-result.raw_result_byte_count") !== rawBytes.byteLength) fail("raw-result:raw-result-byte-count");
  try {
    validateReviewerResult(JSON.parse(rawResultJson));
  } catch (error) {
    if (error instanceof SyntaxError) fail("raw-result:raw-result-json");
    throw error;
  }
  return Object.freeze({
    schema: REVIEWER_RAW_RESULT_SCHEMA,
    round: round(record.round, "raw-result.round"),
    perspective: perspective(record.perspective, "raw-result.perspective"),
    launch_path: expectedPath(record.launch_path, "raw-result.launch_path"),
    launch_sha256: sha(record.launch_sha256, "raw-result.launch_sha256"),
    evidence_set_sha256: sha(record.evidence_set_sha256, "raw-result.evidence_set_sha256"),
    raw_result_json: rawResultJson,
    raw_result_sha256: hashRawBytes(rawBytes),
    raw_result_byte_count: rawBytes.byteLength,
  });
}

export function validateReviewRecord(value: unknown): ReviewRecord {
  const record = closedObject(value, "review-record", [
    "schema", "record_path", "raw_path", "raw_record_sha256", "verdict", "findings", "dissent", "limitations",
  ]);
  if (record.schema !== REVIEW_RECORD_SCHEMA) fail("review-record:schema");
  const result = validateReviewerResult({
    verdict: record.verdict,
    findings: record.findings,
    dissent: record.dissent,
    limitations: record.limitations,
  });
  return Object.freeze({
    schema: REVIEW_RECORD_SCHEMA,
    record_path: expectedPath(record.record_path, "review-record.record_path"),
    raw_path: expectedPath(record.raw_path, "review-record.raw_path"),
    raw_record_sha256: sha(record.raw_record_sha256, "review-record.raw_record_sha256"),
    ...result,
  });
}

export function validateRepairLedger(value: unknown): RepairLedger {
  const record = closedObject(value, "repair-ledger", [
    "schema", "round", "evidence_set_sha256", "reviews", "dispositions", "advisory_deferrals",
  ]);
  if (record.schema !== REPAIR_LEDGER_SCHEMA) fail("repair-ledger:schema");
  return Object.freeze({
    schema: REPAIR_LEDGER_SCHEMA,
    round: round(record.round, "repair-ledger.round"),
    evidence_set_sha256: sha(record.evidence_set_sha256, "repair-ledger.evidence_set_sha256"),
    reviews: references(record.reviews, "repair-ledger.reviews"),
    dispositions: Object.freeze(array(record.dispositions, "repair-ledger.dispositions").map((entry, index) => disposition(entry, `repair-ledger.dispositions[${index}]`))),
    advisory_deferrals: Object.freeze(array(record.advisory_deferrals, "repair-ledger.advisory_deferrals").map((entry, index) => advisoryDeferral(entry, `repair-ledger.advisory_deferrals[${index}]`))),
  });
}

export function validateRoundClosure(value: unknown): RoundClosure {
  const record = closedObject(value, "round-closure", [
    "schema", "round", "previous_closure", "evidence_set_sha256", "launches", "raw_results",
    "review_records", "repair_ledger", "dispositions", "advisory_deferrals", "terminal_status",
  ]);
  if (record.schema !== ROUND_CLOSURE_SCHEMA) fail("round-closure:schema");
  const closureRound = round(record.round, "round-closure.round");
  const previous = previousClosureReference(record.previous_closure, closureRound);
  if ((closureRound === 1) !== (previous === null)) fail("round-closure:previous-closure");
  if (previous !== null && previous.path !== roundClosurePath(closureRound - 1)) fail("round-closure:previous-closure-path");
  const status = terminalStatus(record.terminal_status, "round-closure.terminal_status");
  if (closureRound === 5 && status === "requires-next-round") fail("round-closure:terminal-status");
  return Object.freeze({
    schema: ROUND_CLOSURE_SCHEMA,
    round: closureRound,
    previous_closure: previous,
    evidence_set_sha256: sha(record.evidence_set_sha256, "round-closure.evidence_set_sha256"),
    launches: references(record.launches, "round-closure.launches"),
    raw_results: references(record.raw_results, "round-closure.raw_results"),
    review_records: references(record.review_records, "round-closure.review_records"),
    repair_ledger: pathHash(record.repair_ledger, "round-closure.repair_ledger"),
    dispositions: Object.freeze(array(record.dispositions, "round-closure.dispositions").map((entry, index) => disposition(entry, `round-closure.dispositions[${index}]`))),
    advisory_deferrals: Object.freeze(array(record.advisory_deferrals, "round-closure.advisory_deferrals").map((entry, index) => advisoryDeferral(entry, `round-closure.advisory_deferrals[${index}]`))),
    terminal_status: status,
  });
}

/** Creates the immutable pre-dispatch launch receipt. It never adopts a pre-existing launch. */
export async function persistReviewerLaunch(input: {
  readonly repository_root: string;
  readonly launch: ReviewerLaunch;
}): Promise<{ readonly path: string; readonly sha256: string; readonly launch: ReviewerLaunch }> {
  const launch = validateReviewerLaunch(input.launch);
  const path = reviewerLaunchPath(launch.round, launch.perspective);
  await exclusiveCreateCanonicalJson(input.repository_root, path, launch);
  await reopenReviewerLaunch(input.repository_root, path);
  return Object.freeze({ path, sha256: reviewerLaunchSha256(launch), launch });
}

/** Creates a raw result only after reopening its launch; any pre-existing raw file is rejected. */
export async function persistReviewerRawResult(input: {
  readonly repository_root: string;
  readonly round: number;
  readonly perspective: ReviewPerspective;
  readonly raw_result_json: string;
}): Promise<{ readonly path: string; readonly sha256: string; readonly raw: ReviewerRawResult }> {
  const launchPath = reviewerLaunchPath(input.round, input.perspective);
  let launch: ReviewerLaunch;
  try {
    launch = await reopenReviewerLaunch(input.repository_root, launchPath);
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "NOT_FOUND") fail("raw-result:missing-launch");
    throw error;
  }
  const raw = createReviewerRawResult(launchPath, launch, input.raw_result_json);
  const path = reviewerRawResultPath(launch.round, launch.perspective);
  await exclusiveCreateCanonicalJson(input.repository_root, path, raw);
  await reopenReviewerRawResult(input.repository_root, path);
  return Object.freeze({ path, sha256: reviewerRawResultSha256(raw), raw });
}
/** Normalizes exactly one raw result. Immutable retries adopt only byte-identical normalized evidence. */
export async function persistNormalizedReviewRecord(input: {
  readonly repository_root: string;
  readonly round: number;
  readonly perspective: ReviewPerspective;
}): Promise<{ readonly path: string; readonly sha256: string; readonly record: ReviewRecord; readonly outcome: "created" | "adopted-identical" }> {
  const rawPath = reviewerRawResultPath(input.round, input.perspective);
  const raw = await reopenReviewerRawResult(input.repository_root, rawPath);
  const launch = await reopenReviewerLaunch(input.repository_root, raw.launch_path);
  assertRawBindsLaunch(raw, launch, rawPath);
  const path = reviewRecordPath(raw.round, raw.perspective);
  const record = normalizeReviewerRawResult(raw, rawPath, path);
  const outcome = await installCanonicalJson(input.repository_root, path, record);
  const reopened = await reopenReviewRecord(input.repository_root, path);
  assertLosslessNormalizedReview(raw, reopened);
  return Object.freeze({ path, sha256: reviewRecordSha256(reopened), record: reopened, outcome });
}

export async function persistRepairLedger(input: {
  readonly repository_root: string;
  readonly round: number;
  readonly dispositions: readonly FindingDispositionRecord[];
  readonly advisory_deferrals: readonly AdvisoryDeferral[];
}): Promise<{ readonly path: string; readonly sha256: string; readonly ledger: RepairLedger; readonly outcome: "created" | "adopted-identical" }> {
  assertRound(input.round);
  const reviews = await reopenRoundReviews(input.repository_root, input.round);
  const launches = await Promise.all(REVIEW_PERSPECTIVES.map(item => reopenReviewerLaunch(input.repository_root, reviewerLaunchPath(input.round, item))));
  const raws = await Promise.all(REVIEW_PERSPECTIVES.map(item => reopenReviewerRawResult(input.repository_root, reviewerRawResultPath(input.round, item))));
  const evidenceSet = raws[0]!.evidence_set_sha256;
  for (let index = 0; index < REVIEW_PERSPECTIVES.length; index += 1) {
    assertRawBindsLaunch(raws[index]!, launches[index]!, reviewerRawResultPath(input.round, REVIEW_PERSPECTIVES[index]!));
    assertLosslessNormalizedReview(raws[index]!, reviews[index]!);
    if (raws[index]!.evidence_set_sha256 !== evidenceSet) fail("repair-ledger:mixed-evidence-set");
  }
  const ledger = validateRepairLedger({
    schema: REPAIR_LEDGER_SCHEMA,
    round: input.round,
    evidence_set_sha256: evidenceSet,
    reviews: reviewReferences(input.round, reviews),
    dispositions: input.dispositions,
    advisory_deferrals: input.advisory_deferrals,
  });
  assertRepairLedgerCompleteness(ledger, reviews);
  const path = repairLedgerPath(input.round);
  const outcome = await installCanonicalJson(input.repository_root, path, ledger);
  const reopened = await reopenRepairLedger(input.repository_root, path);
  assertRepairLedgerCompleteness(reopened, reviews);
  return Object.freeze({ path, sha256: repairLedgerSha256(reopened), ledger: reopened, outcome });
}

/** Closes one complete round after reopening and rehashing every bound record and predecessor closure. */
export async function persistRoundClosure(input: {
  readonly repository_root: string;
  readonly round: number;
  readonly terminal_status: RoundTerminalStatus;
  readonly predecessor_exception_path?: string;
}): Promise<{ readonly path: string; readonly sha256: string; readonly closure: RoundClosure; readonly outcome: "created" | "adopted-identical" }> {
  assertRound(input.round);
  if (input.round === 5 && input.terminal_status === "requires-next-round") fail("round-closure:terminal-status");
  if (input.predecessor_exception_path !== undefined && input.round !== 2) fail("round-closure:predecessor-exception-round");
  const evidenceValidator = evidenceValidatorForRound(input.round);
  const launches = await Promise.all(REVIEW_PERSPECTIVES.map(async item => reopenReviewerLaunch(input.repository_root, reviewerLaunchPath(input.round, item))));
  const rawResults = await Promise.all(REVIEW_PERSPECTIVES.map(async item => reopenReviewerRawResult(input.repository_root, reviewerRawResultPath(input.round, item))));
  const reviews = await reopenRoundReviews(input.repository_root, input.round);
  for (let index = 0; index < REVIEW_PERSPECTIVES.length; index += 1) {
    assertRawBindsLaunch(rawResults[index]!, launches[index]!, reviewerRawResultPath(input.round, REVIEW_PERSPECTIVES[index]!));
    assertLosslessNormalizedReview(rawResults[index]!, reviews[index]!);
  }
  const evidenceSet = launches[0]!.evidence_set_sha256;
  for (const launch of launches) if (launch.evidence_set_sha256 !== evidenceSet) fail("round-closure:mixed-evidence-set");
  const ledgerPath = repairLedgerPath(input.round);
  const ledger = await reopenRepairLedger(input.repository_root, ledgerPath);
  if (ledger.round !== input.round || ledger.evidence_set_sha256 !== evidenceSet) fail("round-closure:repair-ledger-binding");
  assertRepairLedgerCompleteness(ledger, reviews);
  let previous: PreviousClosureReference | null = null;
  if (input.round > 1) {
    if (input.predecessor_exception_path !== undefined) {
      previous = await exceptionalPreviousClosureReference(input.repository_root, input.round, input.predecessor_exception_path);
    } else {
      const reopened = await reopenPreviousClosure(input.repository_root, input.round - 1);
      if (reopened.terminal_status !== "requires-next-round") fail("round-closure:predecessor-not-supersedable");
      previous = Object.freeze({ path: roundClosurePath(input.round - 1), sha256: roundClosureSha256(reopened) });
    }
  }
  const closure = validateRoundClosure({
    schema: ROUND_CLOSURE_SCHEMA,
    round: input.round,
    previous_closure: previous,
    evidence_set_sha256: evidenceSet,
    launches: launchReferences(input.round, launches),
    raw_results: rawReferences(input.round, rawResults),
    review_records: reviewReferences(input.round, reviews),
    dispositions: ledger.dispositions,
    advisory_deferrals: ledger.advisory_deferrals,
    repair_ledger: { path: ledgerPath, sha256: repairLedgerSha256(ledger) },
    terminal_status: input.terminal_status,
  });
  await assertEvidenceGraph(input.repository_root, input.round, launches, evidenceSet, evidenceValidator);
  const path = roundClosurePath(input.round);
  const outcome = await installCanonicalJson(input.repository_root, path, closure);
  const reopened = await reopenRoundClosure(input.repository_root, path);
  await assertRoundClosureEvidence(input.repository_root, reopened, evidenceValidator);
  return Object.freeze({ path, sha256: roundClosureSha256(reopened), closure: reopened, outcome });
}

export function createReviewerRawResult(launchPath: string, launchInput: ReviewerLaunch, rawResultJson: string): ReviewerRawResult {
  const launch = validateReviewerLaunch(launchInput);
  if (launchPath !== reviewerLaunchPath(launch.round, launch.perspective)) fail("raw-result:launch-path");
  const bytes = Buffer.from(rawResultJson, "utf8");
  try {
    validateReviewerResult(JSON.parse(rawResultJson));
  } catch (error) {
    if (error instanceof SyntaxError) fail("raw-result:raw-result-json");
    throw error;
  }
  return validateReviewerRawResult({
    schema: REVIEWER_RAW_RESULT_SCHEMA,
    round: launch.round,
    perspective: launch.perspective,
    launch_path: launchPath,
    launch_sha256: reviewerLaunchSha256(launch),
    evidence_set_sha256: launch.evidence_set_sha256,
    raw_result_json: rawResultJson,
    raw_result_sha256: hashRawBytes(bytes),
    raw_result_byte_count: bytes.byteLength,
  });
}

export function normalizeReviewerRawResult(rawInput: ReviewerRawResult, rawPath: string, recordPath: string): ReviewRecord {
  const raw = validateReviewerRawResult(rawInput);
  if (rawPath !== reviewerRawResultPath(raw.round, raw.perspective)) fail("review-record:raw-path");
  if (recordPath !== reviewRecordPath(raw.round, raw.perspective)) fail("review-record:record-path");
  const result = validateReviewerResult(JSON.parse(raw.raw_result_json));
  return validateReviewRecord({
    schema: REVIEW_RECORD_SCHEMA,
    record_path: recordPath,
    raw_path: rawPath,
    raw_record_sha256: reviewerRawResultSha256(raw),
    ...result,
  });
}

/** Ensures normalization did not drop, add, modify, or reorder any reviewer result value. */
export function assertLosslessNormalizedReview(rawInput: ReviewerRawResult, recordInput: ReviewRecord): void {
  const raw = validateReviewerRawResult(rawInput);
  const record = validateReviewRecord(recordInput);
  const source = validateReviewerResult(JSON.parse(raw.raw_result_json));
  const normalized: ReviewerResult = {
    verdict: record.verdict,
    findings: record.findings,
    dissent: record.dissent,
    limitations: record.limitations,
  };
  if (canonicalJson(source) !== canonicalJson(normalized)) fail("review-record:not-lossless");
  if (record.raw_record_sha256 !== reviewerRawResultSha256(raw)) fail("review-record:raw-record-hash");
}

/** Reopens all closure dependencies and proves the stored hash graph is still exact. */
export async function assertRoundClosureEvidence(
  repositoryRoot: string,
  closureInput: RoundClosure,
  evidenceValidator: RoundClosureEvidenceValidator = validateExistingEvidence,
): Promise<void> {
  const closure = validateRoundClosure(closureInput);
  const launches = await Promise.all(closure.launches.map(async reference => {
    const launch = await reopenReviewerLaunch(repositoryRoot, reference.path);
    if (reviewerLaunchSha256(launch) !== reference.sha256) fail("round-closure:launch-rehash");
    return launch;
  }));
  const raws = await Promise.all(closure.raw_results.map(async reference => {
    const raw = await reopenReviewerRawResult(repositoryRoot, reference.path);
    if (reviewerRawResultSha256(raw) !== reference.sha256) fail("round-closure:raw-rehash");
    return raw;
  }));
  const reviews = await Promise.all(closure.review_records.map(async reference => {
    const review = await reopenReviewRecord(repositoryRoot, reference.path);
    if (reviewRecordSha256(review) !== reference.sha256) fail("round-closure:review-rehash");
    return review;
  }));
  assertReferenceSet(closure.launches, closure.round, "launches", reviewerLaunchPath);
  assertReferenceSet(closure.raw_results, closure.round, "raw-results", reviewerRawResultPath);
  assertReferenceSet(closure.review_records, closure.round, "review-records", reviewRecordPath);
  for (let index = 0; index < REVIEW_PERSPECTIVES.length; index += 1) {
    assertRawBindsLaunch(raws[index]!, launches[index]!, closure.raw_results[index]!.path);
    assertLosslessNormalizedReview(raws[index]!, reviews[index]!);
  }
  const evidenceSet = launches[0]!.evidence_set_sha256;
  if (closure.evidence_set_sha256 !== evidenceSet || launches.some(launch => launch.evidence_set_sha256 !== evidenceSet)) fail("round-closure:mixed-evidence-set");
  if (launches.some(launch => launch.artifact_manifest_sha256 !== launches[0]!.artifact_manifest_sha256 || launch.browser_manifest_sha256 !== launches[0]!.browser_manifest_sha256)) fail("round-closure:mixed-manifest");
  await assertEvidenceGraph(
    repositoryRoot,
    closure.round,
    launches,
    evidenceSet,
    evidenceValidator,
  );
  const ledger = await reopenRepairLedger(repositoryRoot, closure.repair_ledger.path);
  if (repairLedgerSha256(ledger) !== closure.repair_ledger.sha256 || ledger.evidence_set_sha256 !== evidenceSet) fail("round-closure:repair-ledger-rehash");
  assertRepairLedgerCompleteness(ledger, reviews);
  if (
    canonicalJson(closure.dispositions) !== canonicalJson(ledger.dispositions)
    || canonicalJson(closure.advisory_deferrals) !== canonicalJson(ledger.advisory_deferrals)
  ) fail("round-closure:dispositions-binding");
  if (closure.previous_closure !== null) {
    if (closure.previous_closure.exception !== undefined) {
      const previous = await exceptionalPreviousClosureReference(repositoryRoot, closure.round, closure.previous_closure.exception.path);
      if (canonicalJson(previous) !== canonicalJson(closure.previous_closure)) fail("round-closure:exception-rehash");
    } else {
      const previous = await reopenRoundClosure(repositoryRoot, closure.previous_closure.path);
      if (roundClosureSha256(previous) !== closure.previous_closure.sha256 || previous.round !== closure.round - 1) fail("round-closure:previous-rehash");
      if (previous.terminal_status !== "requires-next-round") fail("round-closure:predecessor-not-supersedable");
      await assertRoundClosureEvidence(repositoryRoot, previous, evidenceValidatorForRound(previous.round));
    }
  }
}

export async function reopenReviewerLaunch(repositoryRoot: string, path: string): Promise<ReviewerLaunch> {
  return reopenCanonicalJson(repositoryRoot, path, validateReviewerLaunch);
}

export async function reopenReviewerRawResult(repositoryRoot: string, path: string): Promise<ReviewerRawResult> {
  return reopenCanonicalJson(repositoryRoot, path, validateReviewerRawResult);
}

export async function reopenReviewRecord(repositoryRoot: string, path: string): Promise<ReviewRecord> {
  return reopenCanonicalJson(repositoryRoot, path, validateReviewRecord);
}
async function assertEvidenceGraph(
  repositoryRoot: string,
  reviewRound: number,
  launches: readonly ReviewerLaunch[],
  evidenceSet: string,
  evidenceValidator: RoundClosureEvidenceValidator,
): Promise<void> {
  const roundRoot = authoringRoundPath(reviewRound);
  const verifiedEvidence = await evidenceValidator({
    artifact_manifest: resolve(repositoryRoot, roundRoot, "artifact-manifest.json"),
    artifact_manifest_argument: relative("/workspace", resolve(repositoryRoot, roundRoot, "artifact-manifest.json")),
    focused_command_root: resolve(repositoryRoot, roundRoot, "focused-commands"),
    browser_root: resolve(repositoryRoot, roundRoot, "browser"),
    validated_manifest: resolve(repositoryRoot, roundRoot, "browser", "validated-browser-manifest.json"),
  });
  if (
    verifiedEvidence.artifact_manifest_sha256 !== launches[0]!.artifact_manifest_sha256
    || verifiedEvidence.browser_manifest_sha256 !== launches[0]!.browser_manifest_sha256
    || verifiedEvidence.evidence_set_sha256 !== evidenceSet
  ) fail("round-closure:evidence-graph-binding");
}


export async function reopenRepairLedger(repositoryRoot: string, path: string): Promise<RepairLedger> {
  return reopenCanonicalJson(repositoryRoot, path, validateRepairLedger);
}

export async function reopenRoundClosure(repositoryRoot: string, path: string): Promise<RoundClosure> {
  return reopenCanonicalJson(repositoryRoot, path, validateRoundClosure);
}

function validateFinding(value: unknown, label: string): ReviewerFinding {
  const finding = closedObject(value, label, ["id", "severity", "classification", "summary", "evidence"]);
  const evidence = array(finding.evidence, `${label}.evidence`).map((entry, index) => text(entry, `${label}.evidence[${index}]`));
  if (evidence.length === 0) fail(`${label}:empty-evidence`);
  return Object.freeze({
    id: text(finding.id, `${label}.id`),
    severity: enumValue(finding.severity, ["critical", "high", "medium", "low"] as const, `${label}.severity`),
    classification: enumValue(finding.classification, ["binding-contract-failure", "concrete-defect", "advisory-preference"] as const, `${label}.classification`),
    summary: text(finding.summary, `${label}.summary`),
    evidence: Object.freeze(evidence),
  });
}

function disposition(value: unknown, label: string): FindingDispositionRecord {
  const record = closedObject(value, label, ["perspective", "finding_id", "disposition", "rationale"]);
  return Object.freeze({
    perspective: perspective(record.perspective, `${label}.perspective`),
    finding_id: text(record.finding_id, `${label}.finding_id`),
    disposition: enumValue(record.disposition, ["repaired", "disputed", "deferred-advisory"] as const, `${label}.disposition`),
    rationale: text(record.rationale, `${label}.rationale`),
  });
}

function advisoryDeferral(value: unknown, label: string): AdvisoryDeferral {
  const record = closedObject(value, label, ["perspective", "finding_id", "rationale"]);
  return Object.freeze({
    perspective: perspective(record.perspective, `${label}.perspective`),
    finding_id: text(record.finding_id, `${label}.finding_id`),
    rationale: text(record.rationale, `${label}.rationale`),
  });
}

function references(value: unknown, label: string): readonly ReviewReference[] {
  const entries = array(value, label).map((entry, index) => reviewReference(entry, `${label}[${index}]`));
  if (entries.length !== REVIEW_PERSPECTIVES.length) fail(`${label}:perspective-count`);
  for (let index = 0; index < REVIEW_PERSPECTIVES.length; index += 1) {
    if (entries[index]!.perspective !== REVIEW_PERSPECTIVES[index]) fail(`${label}:perspective-order`);
  }
  return Object.freeze(entries);
}

function reviewReference(value: unknown, label: string): ReviewReference {
  const record = closedObject(value, label, ["perspective", "path", "sha256"]);
  return Object.freeze({
    perspective: perspective(record.perspective, `${label}.perspective`),
    path: expectedPath(record.path, `${label}.path`),
    sha256: sha(record.sha256, `${label}.sha256`),
  });
}

function pathHash(value: unknown, label: string): { readonly path: string; readonly sha256: string } {
  const record = closedObject(value, label, ["path", "sha256"]);
  return Object.freeze({ path: expectedPath(record.path, `${label}.path`), sha256: sha(record.sha256, `${label}.sha256`) });
}

function assertRepairLedgerCompleteness(ledgerInput: RepairLedger, reviews: readonly ReviewRecord[]): void {
  const ledger = validateRepairLedger(ledgerInput);
  if (reviews.length !== REVIEW_PERSPECTIVES.length) fail("repair-ledger:review-count");
  for (let index = 0; index < REVIEW_PERSPECTIVES.length; index += 1) {
    const reference = ledger.reviews[index]!;
    const perspectiveId = REVIEW_PERSPECTIVES[index]!;
    if (
      reference.perspective !== perspectiveId
      || reference.path !== reviewRecordPath(ledger.round, perspectiveId)
      || reference.sha256 !== reviewRecordSha256(reviews[index]!)
    ) fail("repair-ledger:review-binding");
  }
  const expected = new Map<string, FindingClassification>();
  for (let index = 0; index < reviews.length; index += 1) {
    const perspectiveId = REVIEW_PERSPECTIVES[index]!;
    const review = reviews[index]!;
    for (const finding of review.findings) {
      const key = `${perspectiveId}\u0000${finding.id}`;
      if (expected.has(key)) fail("repair-ledger:duplicate-finding");
      expected.set(key, finding.classification);
    }
  }
  const seen = new Set<string>();
  for (const entry of ledger.dispositions) {
    const key = `${entry.perspective}\u0000${entry.finding_id}`;
    const classification = expected.get(key);
    if (classification === undefined || seen.has(key)) fail("repair-ledger:disposition-finding");
    if (entry.disposition === "deferred-advisory" && classification !== "advisory-preference") fail("repair-ledger:non-advisory-deferral");
    if (entry.disposition !== "deferred-advisory" && classification === "advisory-preference") fail("repair-ledger:advisory-disposition");
    seen.add(key);
  }
  if (seen.size !== expected.size) fail("repair-ledger:missing-disposition");
  const deferrals = new Set<string>();
  for (const entry of ledger.advisory_deferrals) {
    const key = `${entry.perspective}\u0000${entry.finding_id}`;
    const disposition = ledger.dispositions.find(candidate => candidate.perspective === entry.perspective && candidate.finding_id === entry.finding_id);
    if (deferrals.has(key) || disposition?.disposition !== "deferred-advisory" || disposition.rationale !== entry.rationale) fail("repair-ledger:advisory-deferral");
    deferrals.add(key);
  }
  const deferred = ledger.dispositions.filter(entry => entry.disposition === "deferred-advisory");
  if (deferrals.size !== deferred.length) fail("repair-ledger:missing-advisory-deferral");
}

async function reopenRoundReviews(repositoryRoot: string, reviewRound: number): Promise<readonly ReviewRecord[]> {
  return Promise.all(REVIEW_PERSPECTIVES.map(item => reopenReviewRecord(repositoryRoot, reviewRecordPath(reviewRound, item))));
}


function reviewReferences(reviewRound: number, reviews: readonly ReviewRecord[]): readonly ReviewReference[] {
  return Object.freeze(reviews.map((record, index) => Object.freeze({
    perspective: REVIEW_PERSPECTIVES[index]!,
    path: reviewRecordPath(reviewRound, REVIEW_PERSPECTIVES[index]!),
    sha256: reviewRecordSha256(record),
  })));
}

function launchReferences(reviewRound: number, launches: readonly ReviewerLaunch[]): readonly ReviewReference[] {
  return Object.freeze(launches.map((launch, index) => Object.freeze({
    perspective: REVIEW_PERSPECTIVES[index]!,
    path: reviewerLaunchPath(reviewRound, REVIEW_PERSPECTIVES[index]!),
    sha256: reviewerLaunchSha256(launch),
  })));
}

function rawReferences(reviewRound: number, raws: readonly ReviewerRawResult[]): readonly ReviewReference[] {
  return Object.freeze(raws.map((raw, index) => Object.freeze({
    perspective: REVIEW_PERSPECTIVES[index]!,
    path: reviewerRawResultPath(reviewRound, REVIEW_PERSPECTIVES[index]!),
    sha256: reviewerRawResultSha256(raw),
  })));
}

function assertRawBindsLaunch(raw: ReviewerRawResult, launch: ReviewerLaunch, rawPath: string): void {
  if (
    raw.round !== launch.round || raw.perspective !== launch.perspective || raw.launch_path !== reviewerLaunchPath(launch.round, launch.perspective)
    || rawPath !== reviewerRawResultPath(launch.round, launch.perspective)
    || raw.launch_sha256 !== reviewerLaunchSha256(launch) || raw.evidence_set_sha256 !== launch.evidence_set_sha256
  ) fail("raw-result:launch-binding");
}

async function exceptionalPreviousClosureReference(
  repositoryRoot: string,
  closureRound: number,
  exceptionPath: string,
): Promise<PreviousClosureReference> {
  if (closureRound !== 2) fail("round-closure:predecessor-exception-round");
  const expectedExceptionPath = "authoring-rounds/round-2/predecessor-evidence-exception.json";
  if (exceptionPath !== expectedExceptionPath) fail("round-closure:predecessor-exception-path");
  const exceptionBytes = await readAuthorityFile(repositoryRoot, exceptionPath);
  const exceptionSource = Buffer.from(exceptionBytes).toString("utf8");
  let exceptionValue: unknown;
  try {
    exceptionValue = JSON.parse(exceptionSource);
  } catch {
    fail("round-closure:predecessor-exception-json");
  }
  const bindings = validatePredecessorEvidenceException(exceptionValue);
  if (exceptionSource !== canonicalJson(canonicalizeValue(exceptionValue))) fail("round-closure:predecessor-exception-canonical");

  const priorPath = roundClosurePath(1);
  const priorBytes = await readAuthorityFile(repositoryRoot, priorPath);
  const prior = await reopenRoundClosure(repositoryRoot, priorPath);
  const priorHash = hashRawBytes(priorBytes);
  if (prior.round !== 1 || priorHash !== bindings.round_1_closure_file_sha256 || roundClosureSha256(prior) !== priorHash) fail("round-closure:predecessor-exception-prior");
  if (prior.terminal_status !== "requires-next-round") fail("round-closure:predecessor-not-supersedable");
  await assertAuthorityFileHash(repositoryRoot, "authoring-rounds/round-2/artifact-manifest.json", bindings.artifact_manifest_file_sha256);
  await assertAuthorityFileHash(repositoryRoot, repairLedgerPath(2), bindings.repair_ledger_file_sha256);
  await assertAuthorityFileHash(repositoryRoot, "authoring-rounds/round-2/browser/validated-browser-manifest.json", bindings.validated_browser_manifest_file_sha256);
  return Object.freeze({
    path: priorPath,
    sha256: priorHash,
    exception: Object.freeze({ path: exceptionPath, sha256: hashRawBytes(exceptionBytes) }),
  });
}

function validatePredecessorEvidenceException(value: unknown): {
  readonly round_1_closure_file_sha256: string;
  readonly artifact_manifest_file_sha256: string;
  readonly repair_ledger_file_sha256: string;
  readonly validated_browser_manifest_file_sha256: string;
} {
  const record = closedObject(value, "predecessor-exception", [
    "schema", "authorization", "exception_scope", "missing_predecessor_bindings",
    "permitted_round_3_evidence", "preserved_round_2_bindings", "truth_status",
  ]);
  if (record.schema !== PREDECESSOR_EVIDENCE_EXCEPTION_SCHEMA) fail("predecessor-exception:schema");
  const authorization = closedObject(record.authorization, "predecessor-exception.authorization", ["authorized_by", "authorized_instruction", "authorized_at"]);
  if (authorization.authorized_by !== "user") fail("predecessor-exception:authorization");
  text(authorization.authorized_instruction, "predecessor-exception.authorization.authorized_instruction");
  text(authorization.authorized_at, "predecessor-exception.authorization.authorized_at");
  const scope = closedObject(record.exception_scope, "predecessor-exception.exception_scope", [
    "allowed_next_round", "missing_path", "missing_round", "prohibited_actions", "round_2_records_preserved", "round_3_only_new_evidence",
  ]);
  if (scope.allowed_next_round !== 3 || scope.missing_path !== "authoring-rounds/round-1/browser" || scope.missing_round !== 1 || scope.round_2_records_preserved !== true || scope.round_3_only_new_evidence !== true) fail("predecessor-exception:scope");
  const prohibited = array(scope.prohibited_actions, "predecessor-exception.exception_scope.prohibited_actions").map((entry, index) => text(entry, `predecessor-exception.exception_scope.prohibited_actions[${index}]`));
  const expectedProhibited = ["fabricate predecessor evidence", "overwrite or rebase round-1 records", "overwrite or rebase round-2 records", "claim missing predecessor evidence was revalidated", "use a test-only evidence-validator bypass"];
  if (canonicalJson(prohibited) !== canonicalJson(expectedProhibited)) fail("predecessor-exception:prohibited-actions");
  const missing = closedObject(record.missing_predecessor_bindings, "predecessor-exception.missing_predecessor_bindings", ["artifact_manifest_sha256", "browser_manifest_sha256", "evidence_set_sha256", "round_1_closure_file_sha256"]);
  sha(missing.artifact_manifest_sha256, "predecessor-exception.missing_predecessor_bindings.artifact_manifest_sha256");
  sha(missing.browser_manifest_sha256, "predecessor-exception.missing_predecessor_bindings.browser_manifest_sha256");
  sha(missing.evidence_set_sha256, "predecessor-exception.missing_predecessor_bindings.evidence_set_sha256");
  const permitted = closedObject(record.permitted_round_3_evidence, "predecessor-exception.permitted_round_3_evidence", ["artifact_manifest_path", "artifact_manifest_sha256", "browser_manifest_path", "browser_manifest_sha256", "evidence_set_sha256", "validated_browser_manifest_path"]);
  if (permitted.artifact_manifest_path !== "authoring-rounds/round-3/artifact-manifest.json" || permitted.browser_manifest_path !== "authoring-rounds/round-3/browser/browser-manifest.json" || permitted.validated_browser_manifest_path !== "authoring-rounds/round-3/browser/validated-browser-manifest.json") fail("predecessor-exception:round-3-paths");
  sha(permitted.artifact_manifest_sha256, "predecessor-exception.permitted_round_3_evidence.artifact_manifest_sha256");
  sha(permitted.browser_manifest_sha256, "predecessor-exception.permitted_round_3_evidence.browser_manifest_sha256");
  sha(permitted.evidence_set_sha256, "predecessor-exception.permitted_round_3_evidence.evidence_set_sha256");
  const preserved = closedObject(record.preserved_round_2_bindings, "predecessor-exception.preserved_round_2_bindings", ["artifact_manifest_file_sha256", "repair_ledger_file_sha256", "validated_browser_manifest_file_sha256"]);
  text(record.truth_status, "predecessor-exception.truth_status");
  return Object.freeze({
    round_1_closure_file_sha256: sha(missing.round_1_closure_file_sha256, "predecessor-exception.missing_predecessor_bindings.round_1_closure_file_sha256"),
    artifact_manifest_file_sha256: sha(preserved.artifact_manifest_file_sha256, "predecessor-exception.preserved_round_2_bindings.artifact_manifest_file_sha256"),
    repair_ledger_file_sha256: sha(preserved.repair_ledger_file_sha256, "predecessor-exception.preserved_round_2_bindings.repair_ledger_file_sha256"),
    validated_browser_manifest_file_sha256: sha(preserved.validated_browser_manifest_file_sha256, "predecessor-exception.preserved_round_2_bindings.validated_browser_manifest_file_sha256"),
  });
}

async function assertAuthorityFileHash(repositoryRoot: string, path: string, expectedSha256: string): Promise<void> {
  const bytes = await readAuthorityFile(repositoryRoot, path);
  if (hashRawBytes(bytes) !== expectedSha256) fail("round-closure:predecessor-exception-binding");
}

function previousClosureReference(value: unknown, closureRound: number): PreviousClosureReference | null {
  if (value === null) return null;
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) fail("round-closure.previous_closure:object");
  const hasException = Object.hasOwn(value, "exception");
  const record = closedObject(value, "round-closure.previous_closure", hasException ? ["path", "sha256", "exception"] : ["path", "sha256"]);
  const reference = {
    path: expectedPath(record.path, "round-closure.previous_closure.path"),
    sha256: sha(record.sha256, "round-closure.previous_closure.sha256"),
  };
  if (!hasException) return Object.freeze(reference);
  if (closureRound !== 2) fail("round-closure:predecessor-exception-round");
  const exception = pathHash(record.exception, "round-closure.previous_closure.exception");
  if (exception.path !== "authoring-rounds/round-2/predecessor-evidence-exception.json") fail("round-closure:predecessor-exception-path");
  return Object.freeze({ ...reference, exception });
}

async function reopenPreviousClosure(
  repositoryRoot: string,
  priorRound: number,
): Promise<RoundClosure> {
  const prior = await reopenRoundClosure(repositoryRoot, roundClosurePath(priorRound));
  await assertRoundClosureEvidence(
    repositoryRoot,
    prior,
    evidenceValidatorForRound(priorRound),
  );
  return prior;
}

function assertReferenceSet(
  references: readonly ReviewReference[],
  reviewRound: number,
  label: string,
  pathFor: (round: number, perspective: ReviewPerspective) => string,
): void {
  for (let index = 0; index < REVIEW_PERSPECTIVES.length; index += 1) {
    const item = references[index]!;
    const perspectiveId = REVIEW_PERSPECTIVES[index]!;
    if (item.perspective !== perspectiveId || item.path !== pathFor(reviewRound, perspectiveId)) fail(`round-closure:${label}`);
  }
}

async function installCanonicalJson(repositoryRoot: string, path: string, value: unknown): Promise<"created" | "adopted-identical"> {
  const bytes = canonicalBytes(value);
  const outcome = await installImmutableAuthorityFile(repositoryRoot, path, bytes);
  const reopened = await readAuthorityFile(repositoryRoot, path);
  if (Buffer.compare(Buffer.from(reopened), bytes) !== 0) fail("persistence:reopen-mismatch");
  return outcome;
}

async function exclusiveCreateCanonicalJson(repositoryRoot: string, path: string, value: unknown): Promise<void> {
  const bytes = canonicalBytes(value);
  const outcome = await installImmutableAuthorityFile(repositoryRoot, path, bytes, 0o600);
  if (outcome !== "created") fail("persistence:pre-existing");
  const reopened = await readAuthorityFile(repositoryRoot, path);
  if (Buffer.compare(Buffer.from(reopened), bytes) !== 0) fail("persistence:reopen-mismatch");
}

async function reopenCanonicalJson<T>(repositoryRoot: string, path: string, validator: (value: unknown) => T): Promise<T> {
  const bytes = await readAuthorityFile(repositoryRoot, expectedPath(path, "persistence.path"));
  const source = Buffer.from(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("persistence:json");
  }
  const value = validator(parsed);
  if (source !== canonicalJson(value)) fail("persistence:not-canonical");
  return value;
}

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

function canonicalSha256(value: unknown): string {
  return hashRawBytes(canonicalBytes(value));
}

function closedObject(value: unknown, label: string, keys: readonly string[]): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label}:object`);
  const record = value as ObjectValue;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label}:keys`);
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label}:text`);
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label}:array`);
  return value;
}

function jsonArray(value: unknown, label: string): readonly JsonValue[] {
  const entries = array(value, label);
  try {
    return Object.freeze(entries.map(entry => canonicalizeValue(entry)));
  } catch {
    fail(`${label}:json`);
  }
}

function round(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) fail(`${label}:round`);
  return value as number;
}

function assertRound(value: number): void {
  round(value, "round");
}

function perspective(value: unknown, label: string): ReviewPerspective {
  return enumValue(value, REVIEW_PERSPECTIVES, label);
}

function assertPerspective(value: ReviewPerspective): ReviewPerspective {
  return perspective(value, "perspective");
}

function verdict(value: unknown, label: string): ReviewVerdict {
  return enumValue(value, REVIEW_VERDICTS, label);
}

function terminalStatus(value: unknown, label: string): RoundTerminalStatus {
  return enumValue(value, ["accepted", "requires-next-round", "blocked"] as const, label);
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail(`${label}:enum`);
  return value as T[number];
}

function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) fail(`${label}:sha256`);
  return result;
}

function byteCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${label}:byte-count`);
  return value as number;
}

function expectedPath(value: unknown, label: string): string {
  const path = text(value, label);
  if (path.startsWith("/") || path.includes("\\") || path.includes("//") || path.split("/").some(part => part === "." || part === "..")) fail(`${label}:path`);
  return path;
}

function confinedPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, expectedPath(path, "persistence.path"));
  const contained = relative(absoluteRoot, absolute);
  if (contained === "" || contained === ".." || contained.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) fail("persistence:path");
  return absolute;
}

function fail(reason: string): never {
  throw new TypeError(`IDEATION_AUTHORING_REVIEW_INVALID:${reason}`);
}
