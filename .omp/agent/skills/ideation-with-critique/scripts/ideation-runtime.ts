import { resolve } from "node:path";
import {
  type ApprovalResponse,
  AUTHORITY_FILE_BINDING_SCHEMA,
  type AuthorityFileBinding,
  assertSubstantiveReviewAuthorityPass,
  type CandidateBinding,
  candidateReviewSubjectSha256,
  candidateSha256,
  PUBLICATION_RECEIPT_SCHEMA,
  type PublicationReceipt,
  publicationReceiptBytes,
  publicationReceiptSha256,
  RUNTIME_BINDING_SCHEMA,
  type RuntimeBinding,
  SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA,
  type SubstantiveReviewAuthority,
  substantiveReviewAuthoritySha256,
  type VisualSet,
  validateApprovalResponse,
  validateAuthorityFileBinding,
  validateCandidateBinding,
  validatePublicationReceipt,
  validateApprovalTimestamp,
  validateRepositoryRelativePath,
  validateSubstantiveReviewAuthority,
} from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import { normalizeRepositoryRelativePath } from "../../approval-dossier-runtime/scripts/approval-dossier-publisher.ts";
import {
  loadApprovalDossierRendererSnapshot,
  type ApprovalDossierRendererSnapshot,
  type RenderedApprovalDossier,
  renderApprovalDossier,
} from "../../approval-dossier-runtime/scripts/approval-dossier-renderer.ts";
import {
  createApprovalResponse,
  createCandidateBinding,
  createCandidateFromBindings,
  createMarkdownFileRecord,
  persistSubstantiveReviewAuthority,
  publishApprovedMarkdown,
  reopenSubstantiveReviewAuthority,
  verifyApprovedImportedHtml,
  verifyImportedHtml,
} from "../../approval-dossier-runtime/scripts/approval-dossier-runtime.ts";
import {
  type ApprovedMarkdownExpected,
  verifyApprovedMarkdownProjection,
} from "../../approval-dossier-runtime/scripts/approved-markdown-preflight.ts";
import type { NativeVisual } from "../../approval-dossier-runtime/scripts/native-svg-projector.ts";
import {
  AuthorityFileError,
  installImmutableAuthorityFile,
  listAuthorityDirectory,
  readAuthorityFile,
  writeAuthorityFile,
  withIdeationLineageLock,
} from "../../approval-dossier-runtime/scripts/authority-files.ts";
import {
  canonicalJson,
  hashCanonicalJson,
  hashRawBytes,
} from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import {
  createIdeationNativeVisuals,
  createIdeationVisualSet,
  feedbackTargets as projectFeedbackTargets,
  projectIdeationReviewPresentations,
  renderIdeationMarkdown,
} from "./ideation-projection.ts";
import { loadIdeationProjectionSnapshot } from "./ideation-projection-manifest.ts";
import {
  createIdeationSemanticBinding,
  deriveChangedExchangeTargets,
  type IdeationExchangeTarget,
  deriveFinalDocumentReviewGate,
  finalDocumentReviewEpisodeSha256,
  finalDocumentReviewResultEvidence,
  IDEATION_STATE_SCHEMA,
  IDEATION_WORKFLOW,
  type IdeationState,
  ideationReviewSubjectSha256,
  ideationStateSha256,
  validateIdeationState,
} from "../schemas/ideation-state.ts";

const IDEATION_IMPLEMENTATION_ROOT = resolve(import.meta.dir, "../../../../..");

export const IDEATION_RUNTIME_SCHEMA =
  "ideation-with-critique/runtime/v3" as const;
export const IDEATION_HANDOFF_SCHEMA =
  "ideation-with-critique/deep-scope-handoff/v4" as const;
export const IDEATION_CANDIDATE_RECORD_SCHEMA =
  "ideation-with-critique/candidate-record/v2" as const;
export const IDEATION_RESPONSE_RECORD_SCHEMA =
  "ideation-with-critique/response-record/v2" as const;
export const IDEATION_CANDIDATE_SUBMISSION_SCHEMA =
  "ideation-with-critique/candidate-submission/v1" as const;
export const IDEATION_CURRENT_CANDIDATE_SCHEMA =
  "ideation-with-critique/current-candidate/v1" as const;

interface IdeationCandidate {
  readonly state: IdeationState;
  readonly markdown: Uint8Array;
  readonly candidate: CandidateBinding;
  readonly approval: ApprovalResponse;
  readonly runtime: RuntimeBinding;
  readonly visual_set: VisualSet;
  readonly visuals: readonly NativeVisual[];
  readonly substantive_review_authority: SubstantiveReviewAuthority;
  readonly substantive_review_authority_binding: AuthorityFileBinding;
  readonly rendered: RenderedApprovalDossier;
}
interface IdeationCandidateSubmissionRecord {
  readonly schema: typeof IDEATION_CANDIDATE_SUBMISSION_SCHEMA;
  readonly slug: string;
  readonly run_id: string;
  readonly state_snapshot_path: string;
  readonly state_sha256: string;
  readonly renderer_sha256: string;
  readonly projection_sha256: string;
  readonly submitted_at: string;
}

interface IdeationCurrentCandidateRecord {
  readonly schema: typeof IDEATION_CURRENT_CANDIDATE_SCHEMA;
  readonly slug: string;
  readonly run_id: string;
  readonly state_snapshot_path: string;
  readonly state_sha256: string;
  readonly renderer_sha256: string;
  readonly projection_sha256: string;
  readonly submission_record_path: string;
  readonly submission_record_sha256: string;
  readonly candidate_record_path: string;
  readonly candidate_record_sha256: string;
}
export interface ReconciledIdeationStateAuthority {
  readonly state: IdeationState;
  readonly state_path: string;
  readonly state_snapshot_path: string;
  readonly state_sha256: string;
  readonly outcome: "current";
}

export interface PersistedIdeationState {
  readonly state_path: string;
  readonly state_snapshot_path: string;
  readonly state_sha256: string;
}

export interface PersistedIdeationCandidate {
  readonly candidate_record_path: string;
  readonly candidate_html_path: string;
  readonly candidate_sha256: string;
  readonly state_snapshot_path: string;
  readonly substantive_review_authority: AuthorityFileBinding;
  readonly submission_record_path: string;
  readonly current_candidate_path: string;
  readonly outcome: "created" | "adopted-identical";
}
export interface PersistedIdeationResponse {
  readonly response_record_path: string;
  readonly approved_html_evidence_path: string;
  readonly approved_html_sha256: string;
  readonly approval_status: ApprovalResponse["approval_status"];
  readonly current_candidate_at_import_sha256: string;
}
export interface IdeationPublication {
  readonly receipt: PublicationReceipt;
  readonly receipt_path: string;
  readonly approved_html_evidence_path: string;
}

/** The only downstream Ideation API; intentionally contains no raw HTML or DOM data. */
export interface DeepScopeHandoff extends ApprovedMarkdownExpected {
  readonly schema: typeof IDEATION_HANDOFF_SCHEMA;
  readonly max_review_rounds: 1 | 2 | 3 | 4 | 5;
}

export interface RecoveredIdeationAuthority {
  readonly state: IdeationState;
  readonly candidate: CandidateBinding;
  readonly response: PersistedIdeationResponse;
  readonly substantive_review_authority: AuthorityFileBinding;
  readonly publication: IdeationPublication | null;
}

export async function assertIdeationReturnedResponseAuthority(
  repositoryRoot: string,
  stateInput: IdeationState,
): Promise<void> {
  const state = validateIdeationState(stateInput);
  const episodeNumber = state.final_document_review.current_episode;
  const episode =
    episodeNumber === null
      ? null
      : state.final_document_review.episodes[episodeNumber - 1] ?? null;
  if (
    episode === null ||
    episode.episode < 2 ||
    episode.predecessor_state_sha256 === null ||
    episode.predecessor_candidate_record_path === null ||
    episode.predecessor_candidate_record_sha256 === null ||
    episode.predecessor_response_record_path === null ||
    episode.predecessor_response_record_sha256 === null ||
    episode.predecessor_import_current_candidate_sha256 === null ||
    state.predecessor_sha256 !== episode.predecessor_state_sha256
  ) {
    throw new TypeError(
      "Ideation returned response requires complete current successor episode authority",
    );
  }
  const candidatePath = textPath(
    episode.predecessor_candidate_record_path,
    "returned response candidate record",
  );
  const responsePath = textPath(
    episode.predecessor_response_record_path,
    "returned response record",
  );
  rejectIdeationSupportPath(candidatePath);
  rejectIdeationSupportPath(responsePath);
  const candidateBytes = await readConfinedBytes(
    repositoryRoot,
    candidatePath,
    256 * 1_024,
  );
  const responseBytes = await readConfinedBytes(
    repositoryRoot,
    responsePath,
    256 * 1_024,
  );
  if (
    hashRawBytes(candidateBytes) !==
      episode.predecessor_candidate_record_sha256 ||
    hashRawBytes(responseBytes) !== episode.predecessor_response_record_sha256
  ) {
    throw new TypeError("Ideation returned response record hash mismatch");
  }
  const candidate = await reopenCandidate(
    repositoryRoot,
    candidatePath,
    false,
  );
  if (
    ideationStateSha256(candidate.state) !== episode.predecessor_state_sha256
  ) {
    throw new TypeError(
      "Ideation returned response candidate does not bind predecessor state",
    );
  }
  const response = await reopenResponse(
    repositoryRoot,
    responsePath,
    candidatePath,
    candidate,
    false,
  );
  if (
    responsePath !==
    ideationResponseRecordPath(state.slug, response.response_html_sha256)
  ) {
    throw new TypeError("Ideation returned response record path mismatch");
  }
  if (
    response.approval.approval_status !== "changes-requested" &&
    response.approval.approval_status !== "rejected"
  ) {
    throw new TypeError(
      "Ideation returned response requires changes-requested or rejected verifier authority",
    );
  }
  const responseRecord = closedObject(
    await readCanonicalJson(repositoryRoot, responsePath),
    "$response",
    [
      "schema",
      "candidate_record_path",
      "candidate_sha256",
      "current_candidate_at_import",
      "current_candidate_at_import_sha256",
      "response_html_path",
      "response_html_sha256",
      "approval",
    ],
  );
  if (
    responseRecord.current_candidate_at_import_sha256 !==
    episode.predecessor_import_current_candidate_sha256
  ) {
    throw new TypeError(
      "Ideation returned response import-current-candidate binding mismatch",
    );
  }
}

/** Reopens one canonical returned-changes response against its exact candidate state. */
export async function reopenIdeationReturnedResponseAuthority(
  repositoryRoot: string,
  stateInput: IdeationState,
  responseRecordPath: string,
): Promise<{
  readonly response_record_path: string;
  readonly response_record_sha256: string;
  readonly approval: ApprovalResponse;
}> {
  const state = validateIdeationState(stateInput);
  const responsePath = textPath(responseRecordPath, "returned response record");
  rejectIdeationSupportPath(responsePath);
  const decoded = closedObject(
    await readCanonicalJson(repositoryRoot, responsePath),
    "$response",
    [
      "schema",
      "candidate_record_path",
      "candidate_sha256",
      "current_candidate_at_import",
      "current_candidate_at_import_sha256",
      "response_html_path",
      "response_html_sha256",
      "approval",
    ],
  );
  const candidatePath = textPath(
    decoded.candidate_record_path,
    "returned response candidate record",
  );
  rejectIdeationSupportPath(candidatePath);
  const candidate = await reopenCandidate(
    repositoryRoot,
    candidatePath,
    false,
  );
  if (ideationStateSha256(candidate.state) !== ideationStateSha256(state))
    throw new TypeError("Ideation returned response candidate does not bind requested state");
  const response = await reopenResponse(
    repositoryRoot,
    responsePath,
    candidatePath,
    candidate,
    false,
  );
  if (
    response.approval.approval_status !== "changes-requested" &&
    response.approval.approval_status !== "rejected"
  )
    throw new TypeError(
      "Ideation returned response requires changes-requested or rejected verifier authority",
    );
  if (
    responsePath !==
    ideationResponseRecordPath(state.slug, response.response_html_sha256)
  )
    throw new TypeError("Ideation returned response record path mismatch");
  return Object.freeze({
    response_record_path: responsePath,
    response_record_sha256: hashRawBytes(
      utf8(canonicalJson(decoded)),
    ),
    approval: response.approval,
  });
}

/** Applies one exact admitted questionnaire occurrence only while its continuation remains current. */
export async function applyQuestionnaireCorrectionTransition(input: {
  readonly repository_root: string;
  readonly admitted_response_evidence_path: string;
  readonly occurrence_id: string;
  readonly successor: IdeationState;
}): Promise<PersistedIdeationState> {
  const successor = validateIdeationState(input.successor);
  const evidencePath = textPath(input.admitted_response_evidence_path, "questionnaire admitted response evidence");
  if (typeof input.occurrence_id !== "string" || input.occurrence_id.length === 0) throw new TypeError("questionnaire correction requires an occurrence_id");
  return withIdeationLineageLock(input.repository_root, successor.slug, async () => {
    const requiredText = (value: unknown, label: string): string => {
      if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${label}`);
      return value;
    };
    const readBoundCanonical = async (pathValue: unknown, shaValue: unknown, label: string, limit = 4 * 1_024 * 1_024): Promise<{ readonly path: string; readonly sha256: string; readonly value: unknown }> => {
      const path = textPath(pathValue, `${label} path`);
      const expectedSha256 = sha256(shaValue, `${label} hash`);
      const bytes = await readConfinedBytes(input.repository_root, path, limit);
      if (hashRawBytes(bytes) !== expectedSha256) throw new TypeError(`${label} hash mismatch`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new TypeError(`invalid ${label}`); }
      if (text !== canonicalJson(value)) throw new TypeError(`${label} is not canonical`);
      return { path, sha256: expectedSha256, value };
    };
    const occurrence = (value: unknown, label: string) => {
      const record = closedObject(value, label, ["occurrence_id", "feedback_id", "target", "response_record_path", "response_record_sha256"]);
      const target = requiredText(record.target, `${label}.target`);
      let parsedTarget: unknown;
      try { parsedTarget = JSON.parse(target); } catch { throw new TypeError(`invalid ${label}.target`); }
      if (target !== canonicalJson(parsedTarget)) throw new TypeError(`${label}.target is not canonical`);
      const normalized = { occurrence_id: requiredText(record.occurrence_id, `${label}.occurrence_id`), feedback_id: requiredText(record.feedback_id, `${label}.feedback_id`), target, response_record_path: textPath(record.response_record_path, `${label}.response_record_path`), response_record_sha256: sha256(record.response_record_sha256, `${label}.response_record_sha256`) } as const;
      if (normalized.occurrence_id !== hashCanonicalJson({ response_record_path: normalized.response_record_path, response_record_sha256: normalized.response_record_sha256, feedback_id: normalized.feedback_id, target: normalized.target })) throw new TypeError(`${label} identity mismatch`);
      return normalized;
    };

    const headPath = `ai_docs/ideation/.${successor.slug}.questionnaire-imported-response-head.json`;
    const head = closedObject(await readCanonicalJson(input.repository_root, headPath), "$questionnaire_head", ["schema", "dossier_id", "admitted_response_record_path", "admitted_response_record_sha256", "continuation_checkpoint_record_path", "continuation_checkpoint_record_sha256", "continuation_issuance_record_path", "continuation_issuance_record_sha256"]);
    const admittedSha256 = sha256(head.admitted_response_record_sha256, "questionnaire admitted response");
    if (head.schema !== "ideation-questionnaire/imported-response-head/v2" || head.dossier_id !== successor.slug || evidencePath !== head.admitted_response_record_path || evidencePath !== `ai_docs/ideation/.${successor.slug}.questionnaire-admitted-response-${admittedSha256}.json`) throw new TypeError("questionnaire correction requires the current admitted head");
    const admittedBinding = await readBoundCanonical(evidencePath, admittedSha256, "questionnaire admitted response record");
    const admitted = closedObject(admittedBinding.value, "$questionnaire_admitted_response", ["schema", "dossier_id", "response_items", "occurrence_inventory", "occurrence_inventory_sha256", "baseline_record_path", "baseline_record_sha256", "checkpoint_record_path", "checkpoint_record_sha256", "workspace_issuance_record_path", "workspace_issuance_record_sha256", "saved_workspace_evidence_record_path", "saved_workspace_evidence_record_sha256", "saved_workspace_snapshot_path", "saved_workspace_snapshot_sha256", "workspace_revision", "workspace_raw_sha256", "source_response_record_path", "source_response_record_sha256", "predecessor_imported_response_sha256"]);
    if (admitted.schema !== "ideation-questionnaire/admitted-response/v2" || admitted.dossier_id !== successor.slug || !Array.isArray(admitted.response_items) || !Array.isArray(admitted.occurrence_inventory)) throw new TypeError("questionnaire correction admitted record binding mismatch");
    const items = admitted.response_items.map((value, index) => {
      const item = closedObject(value, `$questionnaire_item[${index}]`, ["occurrence_id", "feedback_id", "target", "response_record_path", "response_record_sha256", "answer_text", "validation", "defer_status", "defer_reason", "rationale", "selected_option", "context_requests", "evidence_references", "notebook_content"]);
      const identity = occurrence({ occurrence_id: item.occurrence_id, feedback_id: item.feedback_id, target: item.target, response_record_path: item.response_record_path, response_record_sha256: item.response_record_sha256 }, `$questionnaire_item[${index}]`);
      if (typeof item.answer_text !== "string" || !["unvalidated", "valid", "invalid"].includes(item.validation as string) || !["not-deferred", "deferred"].includes(item.defer_status as string) || (item.defer_reason !== null && typeof item.defer_reason !== "string") || (item.selected_option !== null && typeof item.selected_option !== "string") || !Array.isArray(item.context_requests) || !item.context_requests.every(entry => typeof entry === "string") || !Array.isArray(item.evidence_references) || !item.evidence_references.every(entry => typeof entry === "string") || typeof item.rationale !== "string" || typeof item.notebook_content !== "string") throw new TypeError("invalid questionnaire admitted response item");
      return { ...item, ...identity };
    });
    const inventory = admitted.occurrence_inventory.map((value, index) => occurrence(value, `$questionnaire_inventory[${index}]`));
    if (new Set(items.map(item => item.occurrence_id)).size !== items.length || canonicalJson(inventory) !== canonicalJson(items.map(({ occurrence_id, feedback_id, target, response_record_path, response_record_sha256 }) => ({ occurrence_id, feedback_id, target, response_record_path, response_record_sha256 }))) || sha256(admitted.occurrence_inventory_sha256, "questionnaire occurrence inventory") !== hashCanonicalJson(inventory)) throw new TypeError("questionnaire correction occurrence inventory mismatch");

    const savedEvidenceBinding = await readBoundCanonical(admitted.saved_workspace_evidence_record_path, admitted.saved_workspace_evidence_record_sha256, "questionnaire saved workspace evidence");
    const savedEvidence = closedObject(savedEvidenceBinding.value, "$questionnaire_saved_evidence", ["schema", "evidence_id", "dossier_id", "baseline_record_path", "baseline_record_sha256", "checkpoint_record_path", "checkpoint_record_sha256", "workspace_issuance_record_path", "workspace_issuance_record_sha256", "workspace_path", "workspace_sha256", "workspace_snapshot_path", "workspace_snapshot_sha256", "workspace_revision", "saved_at"]);
    const workspaceRawSha256 = sha256(admitted.workspace_raw_sha256, "questionnaire workspace raw");
    if (savedEvidence.schema !== "ideation-questionnaire/saved-workspace-evidence/v1" || savedEvidence.dossier_id !== successor.slug || savedEvidence.evidence_id !== workspaceRawSha256 || savedEvidenceBinding.path !== `ai_docs/ideation/.${successor.slug}.questionnaire-saved-${workspaceRawSha256}.json` || savedEvidence.workspace_path !== `ai_docs/ideation/${successor.slug}/questionnaire.html` || savedEvidence.workspace_sha256 !== workspaceRawSha256 || savedEvidence.workspace_snapshot_path !== admitted.saved_workspace_snapshot_path || savedEvidence.workspace_snapshot_sha256 !== admitted.saved_workspace_snapshot_sha256 || savedEvidence.workspace_revision !== admitted.workspace_revision || savedEvidence.baseline_record_path !== admitted.baseline_record_path || savedEvidence.baseline_record_sha256 !== admitted.baseline_record_sha256 || savedEvidence.checkpoint_record_path !== admitted.checkpoint_record_path || savedEvidence.checkpoint_record_sha256 !== admitted.checkpoint_record_sha256 || savedEvidence.workspace_issuance_record_path !== admitted.workspace_issuance_record_path || savedEvidence.workspace_issuance_record_sha256 !== admitted.workspace_issuance_record_sha256) throw new TypeError("questionnaire correction saved evidence mismatch");
    const snapshotPath = textPath(savedEvidence.workspace_snapshot_path, "questionnaire saved workspace snapshot");
    const snapshotSha256 = sha256(savedEvidence.workspace_snapshot_sha256, "questionnaire saved workspace snapshot");
    if (snapshotPath !== `ai_docs/ideation/.${successor.slug}.questionnaire-workspace-${snapshotSha256}.html` || hashRawBytes(await readConfinedBytes(input.repository_root, snapshotPath, 8 * 1_024 * 1_024)) !== snapshotSha256) throw new TypeError("questionnaire correction saved snapshot mismatch");

    const checkpointBinding = await readBoundCanonical(head.continuation_checkpoint_record_path, head.continuation_checkpoint_record_sha256, "questionnaire continuation checkpoint", 256 * 1_024);
    const checkpoint = closedObject(checkpointBinding.value, "$questionnaire_checkpoint", ["schema", "checkpoint_id", "dossier_id", "dossier_identity", "baseline_record_path", "baseline_record_sha256", "source_state_path", "source_state_sha256", "snapshot_inventory_sha256", "renderer_manifest_sha256", "base_imported_response_sha256", "issued_at"]);
    const checkpointId = sha256(checkpoint.checkpoint_id, "questionnaire checkpoint id");
    const { checkpoint_id: _checkpointId, ...checkpointRest } = checkpoint;
    if (checkpoint.schema !== "ideation-questionnaire/checkpoint/v1" || checkpoint.dossier_id !== successor.slug || checkpoint.base_imported_response_sha256 !== admittedSha256 || checkpoint.baseline_record_path !== admitted.baseline_record_path || checkpoint.baseline_record_sha256 !== admitted.baseline_record_sha256 || checkpointBinding.path !== `ai_docs/ideation/.${successor.slug}.questionnaire-checkpoint-${checkpointId}.json` || hashCanonicalJson(checkpointRest) !== checkpointId) throw new TypeError("questionnaire correction continuation checkpoint is stale");

    const issuanceBinding = await readBoundCanonical(head.continuation_issuance_record_path, head.continuation_issuance_record_sha256, "questionnaire continuation issuance", 256 * 1_024);
    const issuance = closedObject(issuanceBinding.value, "$questionnaire_continuation_issuance", ["schema", "issuance_id", "dossier_id", "issuance_kind", "baseline_record_path", "baseline_record_sha256", "checkpoint_record_path", "checkpoint_record_sha256", "prior_issuance_record_path", "prior_issuance_record_sha256", "issued_at"]);
    const issuanceId = sha256(issuance.issuance_id, "questionnaire continuation issuance id");
    const { issuance_id: _issuanceId, ...issuanceRest } = issuance;
    if (issuance.schema !== "ideation-questionnaire/issuance/v1" || issuance.issuance_kind !== "continuation" || issuance.dossier_id !== successor.slug || issuance.baseline_record_path !== admitted.baseline_record_path || issuance.baseline_record_sha256 !== admitted.baseline_record_sha256 || issuance.checkpoint_record_path !== checkpointBinding.path || issuance.checkpoint_record_sha256 !== checkpointBinding.sha256 || issuance.prior_issuance_record_path !== admitted.workspace_issuance_record_path || issuance.prior_issuance_record_sha256 !== admitted.workspace_issuance_record_sha256 || issuanceBinding.path !== `ai_docs/ideation/.${successor.slug}.questionnaire-issuance-${issuanceId}.json` || hashCanonicalJson(issuanceRest) !== issuanceId) throw new TypeError("questionnaire correction continuation issuance mismatch");

    const selected = items.find(item => item.occurrence_id === input.occurrence_id);
    if (selected === undefined || selected.validation !== "valid" || selected.defer_status !== "not-deferred" || typeof selected.answer_text !== "string" || selected.answer_text.length === 0) throw new TypeError("questionnaire correction occurrence is not eligible");
    const current = await reconcileCurrentIdeationStateAuthority(input.repository_root, successor.slug);
    const baselineBinding = await readBoundCanonical(admitted.baseline_record_path, admitted.baseline_record_sha256, "questionnaire baseline record", 256 * 1_024);
    const baseline = closedObject(baselineBinding.value, "$questionnaire_baseline", ["schema", "baseline_id", "dossier_id", "source_state_path", "source_state_sha256", "source_head_revision", "interview_ledger_sha256", "snapshot_inventory_sha256", "renderer_manifest_sha256", "dossier_identity", "response_record_path", "response_record_sha256", "occurrence_inventory", "occurrence_inventory_sha256"]);
    const baselineId = sha256(baseline.baseline_id, "questionnaire baseline id");
    const { baseline_id: _baselineId, ...baselineRest } = baseline;
    if (baseline.schema !== "ideation-questionnaire/baseline/v1" || baseline.dossier_id !== successor.slug || baselineBinding.path !== `ai_docs/ideation/.${successor.slug}.questionnaire-baseline-${baselineId}.json` || hashCanonicalJson(baselineRest) !== baselineId || baseline.source_state_path !== current.state_snapshot_path || baseline.source_state_sha256 !== current.state_sha256 || baseline.source_head_revision !== current.state.revision || admitted.baseline_record_path !== baselineBinding.path || admitted.baseline_record_sha256 !== baselineBinding.sha256) throw new TypeError("questionnaire correction requires the admitted baseline to bind the current predecessor");
    if (current.state_sha256 !== successor.predecessor_sha256 || successor.revision !== current.state.revision + 1 || successor.revision_kind !== "accepted-answer") throw new TypeError("questionnaire correction requires current canonical predecessor");
    const appended = successor.interview_exchanges.slice(current.state.interview_exchanges.length);
    let selectedTarget: unknown;
    try { selectedTarget = JSON.parse(selected.target); } catch { throw new TypeError("questionnaire correction occurrence target is invalid"); }
    const changedTargets = deriveChangedExchangeTargets(current.state, successor);
    const allowedTargets = new Set<string>([selected.target, canonicalJson({ target_type: "state-field", field: "readiness" })]);
    if (selectedTarget !== null && typeof selectedTarget === "object" && "target_type" in selectedTarget && selectedTarget.target_type === "semantic-id" && "semantic_id" in selectedTarget && typeof selectedTarget.semantic_id === "string") {
      const semanticId = selectedTarget.semantic_id;
      const containsSemanticId = (field: string): boolean => {
        if (field === "goal") return current.state.goal.id === semanticId;
        if (field === "criteria") return current.state.criteria.some((entry) => entry.id === semanticId);
        if (field === "decisions") return current.state.decisions.some((entry) => entry.id === semanticId);
        if (field === "assumptions") return current.state.assumptions.some((entry) => entry.id === semanticId);
        if (field === "evidence") return current.state.evidence.some((entry) => entry.id === semanticId);
        if (field === "visuals") return current.state.visuals.some((entry) => entry.id === semanticId);
        if (field === "review-item-presentations") return current.state.review_item_presentations.some((entry) => entry.semantic_id === semanticId);
        return false;
      };
      const parentFields = changedTargets.filter((target) => target.target_type === "state-field" && target.field !== "readiness" && containsSemanticId(target.field)).map((target) => target.target_type === "state-field" ? target.field : "");
      if (parentFields.length !== 1) throw new TypeError("questionnaire correction semantic target is absent or ambiguous");
      allowedTargets.add(canonicalJson({ target_type: "state-field", field: parentFields[0] }));
    }
    const changedTargetKeys = changedTargets.map((target) => canonicalJson(target));
    if (appended.length !== 1 || appended[0]!.id !== `Q${current.state.interview_exchanges.length + 1}` || appended[0]!.accepted_answer !== selected.answer_text || canonicalJson(appended[0]!.affected_targets) !== canonicalJson(changedTargets) || !changedTargetKeys.includes(selected.target) || changedTargetKeys.some((target) => !allowedTargets.has(target))) throw new TypeError("questionnaire correction does not bind the admitted occurrence and semantic delta");
    return persistIdeationStateLocked(input.repository_root, successor);
  });
}
export const persistQuestionnaireCorrection = applyQuestionnaireCorrectionTransition;

/** Test-only interleaving seam; production leaves every hook unset. */
export const ideationRuntimeHooks: {
  before_publication_commit?: () => Promise<void> | void;
} = {};

async function persistIdeationStateLocked(
  repositoryRoot: string,
  state: IdeationState,
): Promise<PersistedIdeationState> {
  const stateSha256 = ideationStateSha256(state);
  const bytes = utf8(canonicalJson(state));
  const statePath = ideationStatePath(state.slug);
  const existing = await reopenCurrentStateIfPresent(repositoryRoot, statePath);
  const snapshots = await enumerateImmutableV8Lineage(repositoryRoot, state.slug);
  const tip =
    snapshots.size === 0
      ? null
      : await validateUniqueImmutableV8Lineage(repositoryRoot, state.slug, snapshots);
  let shouldInstallSnapshot = false;

  if (existing === null) {
    if (tip === null) {
      if (state.revision !== 1)
        throw new TypeError(
          "later Ideation revisions require a persisted adjacent predecessor",
        );
      shouldInstallSnapshot = true;
    } else if (
      tip.state.revision !== 1 ||
      tip.sha256 !== stateSha256 ||
      canonicalJson(tip.state) !== canonicalJson(state)
    ) {
      throw new TypeError(
        "Ideation state authority has immutable lineage without an identical proposed genesis head",
      );
    }
  } else {
    const existingSha256 = ideationStateSha256(existing);
    const currentSnapshot = snapshots.get(existingSha256);
    if (
      currentSnapshot === undefined ||
      canonicalJson(currentSnapshot.state) !== canonicalJson(existing)
    )
      throw new TypeError(
        "IDEATION_STATE_LINEAGE_CORRUPTION:mutable head lacks exact immutable v8 snapshot",
      );
    if (tip === null)
      throw new TypeError(
        "IDEATION_STATE_LINEAGE_CORRUPTION:mutable head lacks immutable lineage",
      );
    if (tip.sha256 !== existingSha256) {
      if (
        tip.state.revision !== existing.revision + 1 ||
        tip.state.predecessor_sha256 !== existingSha256 ||
        tip.state.run_id !== existing.run_id ||
        tip.sha256 !== stateSha256 ||
        canonicalJson(tip.state) !== canonicalJson(state)
      )
        throw new TypeError(
          "IDEATION_STATE_LINEAGE_CORRUPTION:mutable head is rolled back from immutable lineage tip",
        );
      if (state.max_review_rounds !== existing.max_review_rounds)
        throw new TypeError(
          "Ideation max_review_rounds is immutable across adjacent successor states",
        );
      await assertSuccessorStateTransition(repositoryRoot, existing, state);
    } else if (existingSha256 !== stateSha256) {
      if (
        state.revision !== existing.revision + 1 ||
        state.predecessor_sha256 !== existingSha256 ||
        state.slug !== existing.slug ||
        state.run_id !== existing.run_id
      )
        throw new TypeError(
          "Ideation state revision does not reopen its exact same-run adjacent immutable predecessor",
        );
      if (state.max_review_rounds !== existing.max_review_rounds)
        throw new TypeError(
          "Ideation max_review_rounds is immutable across adjacent successor states",
        );
      await assertSuccessorStateTransition(repositoryRoot, existing, state);
      shouldInstallSnapshot = true;
    }
  }
  if (state.readiness.status === "ready-for-approval")
    await reopenSubstantiveReviewResults(repositoryRoot, state);
  if (shouldInstallSnapshot)
    await installImmutableFile(
      repositoryRoot,
      ideationStateSnapshotPath(state.slug, stateSha256),
      bytes,
    );
  await writeCurrentState(repositoryRoot, statePath, bytes);
  const reconciled = await reconcileCurrentIdeationStateAuthority(
    repositoryRoot,
    state.slug,
  );
  if (reconciled.state_sha256 !== stateSha256)
    throw new TypeError("reopened Ideation state hash mismatch");
  return Object.freeze({
    state_path: statePath,
    state_snapshot_path: ideationStateSnapshotPath(state.slug, stateSha256),
    state_sha256: stateSha256,
  });
}

/** Persists the mutable current state plus an immutable state snapshot, then reopens both. */
export async function persistIdeationState(input: {
  readonly repository_root: string;
  readonly state: IdeationState;
}): Promise<PersistedIdeationState> {
  const state = validateIdeationState(input.state);
  return withIdeationLineageLock(input.repository_root, state.slug, () =>
    persistIdeationStateLocked(input.repository_root, state),
  );
}

/** Reopens the unique canonical mutable v8 head without modifying authority. */
export async function reconcileCurrentIdeationStateAuthority(
  repositoryRoot: string,
  slug: string,
): Promise<ReconciledIdeationStateAuthority> {
  assertSlug(slug);
  const statePath = ideationStatePath(slug);
  const current = await reopenCurrentStateIfPresent(repositoryRoot, statePath);
  if (current === null)
    throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:missing mutable current head");
  const snapshots = await enumerateImmutableV8Lineage(repositoryRoot, slug);
  const tip = await validateUniqueImmutableV8Lineage(repositoryRoot, slug, snapshots);
  const currentSha256 = ideationStateSha256(current);
  const currentSnapshot = snapshots.get(currentSha256);
  if (currentSnapshot === undefined || canonicalJson(currentSnapshot.state) !== canonicalJson(current))
    throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:mutable head lacks exact immutable v8 snapshot");
  if (tip.sha256 !== currentSha256)
    throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:mutable head is rolled back from immutable lineage tip");
  return Object.freeze({
    state: current,
    state_path: statePath,
    state_snapshot_path: currentSnapshot.path,
    state_sha256: currentSha256,
    outcome: "current",
  });
}

/** Stores exact substantive-review result bytes before they can support readiness. */
export async function persistIdeationSubstantiveReviewResults(input: {
  readonly repository_root: string;
  readonly state: IdeationState;
}): Promise<void> {
  const state = validateIdeationState(input.state);
  const review = state.final_document_review;
  if (review.current_round === null)
    throw new TypeError("Ideation substantive review has no current round");
  const current = review.rounds[review.current_round - 1]!;
  if (current.subject.subject_sha256 !== ideationReviewSubjectSha256(state))
    throw new TypeError("stale substantive review subject");
  for (const result of review.rounds.flatMap((round) => round.results)) {
    const bytes = utf8(
      canonicalJson(finalDocumentReviewResultEvidence(result)),
    );
    if (hashRawBytes(bytes) !== result.result_sha256)
      throw new TypeError(
        `substantive review result SHA-256 does not bind its result: ${result.reviewer_id}`,
      );
    await installImmutableFile(
      input.repository_root,
      result.result_path,
      bytes,
    );
    const reopened = await readConfinedBytes(
      input.repository_root,
      result.result_path,
      4 * 1_024 * 1_024,
    );
    if (Buffer.compare(Buffer.from(reopened), Buffer.from(bytes)) !== 0)
      throw new TypeError(
        `substantive review result did not reopen exactly: ${result.result_path}`,
      );
  }
}

/** Creates a candidate only from reconciled saved current-state authority. */
export async function createIdeationCandidateFromSavedState(input: {
  readonly repository_root: string;
  readonly state_path: string;
  readonly submitted_at: string;
  readonly implementation_root?: never;
}): Promise<PersistedIdeationCandidate> {
  const statePath = normalizeRepositoryRelativePath(input.state_path);
  rejectIdeationSupportPath(statePath);
  const slug = slugFromCanonicalStatePath(statePath);
  return withIdeationLineageLock(input.repository_root, slug, async () => {
    const reconciled = await reconcileCurrentIdeationStateAuthority(
      input.repository_root,
      slug,
    );
    if (statePath !== reconciled.state_path)
      throw new TypeError(
        "candidate state path is not the canonical Ideation state path",
      );
    const snapshot = await loadApprovalDossierRendererSnapshot();
    const projection = await loadIdeationProjectionSnapshot(IDEATION_IMPLEMENTATION_ROOT);
    const projectionSha256 = projection.sha256;
    const submissionPath = ideationCandidateSubmissionPath(
      reconciled.state.slug,
      reconciled.state_sha256,
      snapshot.sha256,
      projectionSha256,
    );
    const existingSubmission = await reopenCandidateSubmissionIfPresent(
      input.repository_root,
      submissionPath,
    );
    const submittedAt =
      existingSubmission === null
        ? validateApprovalTimestamp(
            input.submitted_at,
            "candidate submission timestamp",
          )
        : existingSubmission.submitted_at;
    const candidate = await createCandidate(
      input.repository_root,
      reconciled.state,
      submittedAt,
      snapshot,
    );
    const candidateHash = candidateSha256(candidate.candidate);
    const candidateHtmlPath = ideationCandidateHtmlPath(
      reconciled.state.slug,
      candidateHash,
    );
    const recordPath = ideationCandidateRecordPath(
      reconciled.state.slug,
      candidateHash,
    );
    const submission: IdeationCandidateSubmissionRecord = Object.freeze({
      schema: IDEATION_CANDIDATE_SUBMISSION_SCHEMA,
      slug: reconciled.state.slug,
      run_id: reconciled.state.run_id,
      state_snapshot_path: reconciled.state_snapshot_path,
      state_sha256: reconciled.state_sha256,
      renderer_sha256: snapshot.sha256,
      projection_sha256: projectionSha256,
      submitted_at: submittedAt,
    });
    if (
      existingSubmission !== null &&
      canonicalJson(existingSubmission) !== canonicalJson(submission)
    )
      throw new TypeError(
        "candidate submission does not bind reconciled authority",
      );
    const submissionBytes = utf8(canonicalJson(submission));
    await installImmutableFile(
      input.repository_root,
      submissionPath,
      submissionBytes,
    );
    await installImmutableFile(
      input.repository_root,
      candidateHtmlPath,
      candidate.rendered.bytes,
    );
    await installCanonicalJson(input.repository_root, recordPath, {
      schema: IDEATION_CANDIDATE_RECORD_SCHEMA,
      state_snapshot_path: reconciled.state_snapshot_path,
      state_sha256: reconciled.state_sha256,
      substantive_review_authority:
        candidate.substantive_review_authority_binding,
      candidate: candidate.candidate,
      candidate_sha256: candidateHash,
      candidate_html_path: candidateHtmlPath,
      candidate_html_sha256: hashRawBytes(candidate.rendered.bytes),
      renderer_manifest: snapshot.manifest,
      projection_manifest: projection.manifest,
    });
    await reopenCandidate(input.repository_root, recordPath);
    const candidateRecordSha256 = hashRawBytes(
      utf8(
        canonicalJson(
          await readCanonicalJson(input.repository_root, recordPath),
        ),
      ),
    );
    const current: IdeationCurrentCandidateRecord = Object.freeze({
      schema: IDEATION_CURRENT_CANDIDATE_SCHEMA,
      slug: reconciled.state.slug,
      run_id: reconciled.state.run_id,
      state_snapshot_path: reconciled.state_snapshot_path,
      state_sha256: reconciled.state_sha256,
      renderer_sha256: snapshot.sha256,
      projection_sha256: projectionSha256,
      submission_record_path: submissionPath,
      submission_record_sha256: hashRawBytes(submissionBytes),
      candidate_record_path: recordPath,
      candidate_record_sha256: candidateRecordSha256,
    });
    const currentPath = ideationCurrentCandidatePath(reconciled.state.slug);
    const existingCurrent = await reopenCurrentCandidateIfPresent(
      input.repository_root,
      reconciled.state.slug,
    );
    const outcome =
      existingCurrent !== null &&
      canonicalJson(existingCurrent) === canonicalJson(current)
        ? ("adopted-identical" as const)
        : ("created" as const);
    await writeCurrentState(
      input.repository_root,
      currentPath,
      utf8(canonicalJson(current)),
    );
    const reopenedCurrent = await reopenCurrentCandidate(
      input.repository_root,
      reconciled.state.slug,
    );
    if (canonicalJson(reopenedCurrent) !== canonicalJson(current))
      throw new TypeError("current candidate did not reopen exactly");
    return Object.freeze({
      candidate_record_path: recordPath,
      candidate_html_path: candidateHtmlPath,
      candidate_sha256: candidateHash,
      state_snapshot_path: reconciled.state_snapshot_path,
      substantive_review_authority:
        candidate.substantive_review_authority_binding,
      submission_record_path: submissionPath,
      current_candidate_path: currentPath,
      outcome,
    });
  });
}

/** Imports a human-saved response only against current candidate authority. */
export async function importIdeationResponseFromSavedPath(input: {
  readonly repository_root: string;
  readonly candidate_record_path: string;
  readonly saved_html_path: string;
}): Promise<PersistedIdeationResponse> {
  rejectIdeationSupportPath(input.candidate_record_path);
  rejectIdeationSupportPath(input.saved_html_path);
  const preliminary = await reopenCandidate(
    input.repository_root,
    input.candidate_record_path,
  );
  return withIdeationLineageLock(
    input.repository_root,
    preliminary.state.slug,
    async () => {
      const reconciled = await reconcileCurrentIdeationStateAuthority(
        input.repository_root,
        preliminary.state.slug,
      );
      const current = await reopenCurrentCandidate(
        input.repository_root,
        reconciled.state.slug,
      );
      if (current.candidate_record_path !== input.candidate_record_path)
        throw staleCurrentCandidate(
          input.candidate_record_path,
          reconciled.state_sha256,
          current.state_sha256,
        );
      const candidate = await reopenCandidate(
        input.repository_root,
        current.candidate_record_path,
      );
      const savedBytes = await readConfinedBytes(
        input.repository_root,
        input.saved_html_path,
        4 * 1_024 * 1_024,
      );
      const imported = verifyImportedHtml(
        savedBytes,
        candidate.candidate,
        ideationContext(
          candidate.candidate_html,
          candidate.runtime,
          candidate.substantive_review_authority.sha256,
          candidate.state,
        ),
      );
      const evidencePath =
        imported.approval.approval_status === "approved"
          ? ideationApprovedHtmlEvidencePath(
              candidate.state.slug,
              imported.document_sha256,
            )
          : ideationResponseHtmlPath(
              candidate.state.slug,
              imported.document_sha256,
            );
      await installImmutableFile(
        input.repository_root,
        evidencePath,
        savedBytes,
      );
      const recordPath = ideationResponseRecordPath(
        candidate.state.slug,
        imported.document_sha256,
      );
      const currentSha256 = hashRawBytes(utf8(canonicalJson(current)));
      await installCanonicalJson(input.repository_root, recordPath, {
        schema: IDEATION_RESPONSE_RECORD_SCHEMA,
        candidate_record_path: current.candidate_record_path,
        candidate_sha256: candidate.candidate_sha256,
        current_candidate_at_import: current,
        current_candidate_at_import_sha256: currentSha256,
        response_html_path: evidencePath,
        response_html_sha256: imported.document_sha256,
        approval: imported.approval,
      });
      const reopened = await reopenResponse(
        input.repository_root,
        recordPath,
        current.candidate_record_path,
        candidate,
      );
      return Object.freeze({
        response_record_path: recordPath,
        approved_html_evidence_path: reopened.response_html_path,
        approved_html_sha256: reopened.response_html_sha256,
        approval_status: reopened.approval.approval_status,
        current_candidate_at_import_sha256: currentSha256,
      });
    },
  );
}

/** Publishes only current pointer-bound approved authority under the lineage lock. */
export async function publishIdeationMarkdownFromSavedRecords(input: {
  readonly repository_root: string;
  readonly candidate_record_path: string;
  readonly response_record_path: string;
}): Promise<IdeationPublication> {
  closedObject(input, "$publish_input", [
    "repository_root",
    "candidate_record_path",
    "response_record_path",
  ]);
  rejectIdeationSupportPath(input.candidate_record_path);
  rejectIdeationSupportPath(input.response_record_path);
  const preliminary = await reopenCandidate(
    input.repository_root,
    input.candidate_record_path,
  );
  return withIdeationLineageLock(
    input.repository_root,
    preliminary.state.slug,
    async () => {
      await reconcileCurrentIdeationStateAuthority(
        input.repository_root,
        preliminary.state.slug,
      );
      const current = await reopenCurrentCandidate(
        input.repository_root,
        preliminary.state.slug,
      );
      if (current.candidate_record_path !== input.candidate_record_path)
        throw staleCurrentCandidate(
          input.candidate_record_path,
          current.state_sha256,
          current.state_sha256,
        );
      const authority = await reopenApprovedAuthority(
        input.repository_root,
        current.candidate_record_path,
        input.response_record_path,
      );
      const receiptPath = ideationReceiptPath(authority.candidate.state.slug);
      const guard = ideationRuntimeHooks.before_publication_commit;
      rejectIdeationSupportPath(receiptPath);
      if (guard) await guard();
      await assertCurrentCanonicalState(
        input.repository_root,
        authority.candidate.state,
        "candidate state changed during publication",
      );
      await reconcileCurrentIdeationStateAuthority(
        input.repository_root,
        authority.candidate.state.slug,
      );
      if (
        (
          await reopenCurrentCandidate(
            input.repository_root,
            authority.candidate.state.slug,
          )
        ).candidate_record_path !== current.candidate_record_path
      )
        throw new TypeError("candidate state changed during publication");
      await publishApprovedMarkdown({
        repository_root: input.repository_root,
        receipt_path: receiptPath,
        approved_html: authority.responseBytes,
        candidate: authority.candidate.candidate,
        substantive_review_authority:
          authority.candidate.substantive_review_authority,
        context: ideationContext(
          authority.candidate.candidate_html,
          authority.candidate.runtime,
          authority.candidate.substantive_review_authority.sha256,
          authority.candidate.state,
        ),
      });
      return reopenPublication(
        input.repository_root,
        authority.candidate,
        authority.response,
      );
    },
  );
}

/** Recovers only current pointer-bound response authority under the lineage lock. */
export async function recoverIdeationAuthority(input: {
  readonly repository_root: string;
  readonly candidate_record_path: string;
  readonly response_record_path: string;
}): Promise<RecoveredIdeationAuthority> {
  rejectIdeationSupportPath(input.candidate_record_path);
  rejectIdeationSupportPath(input.response_record_path);
  const preliminary = await reopenCandidate(
    input.repository_root,
    input.candidate_record_path,
  );
  return withIdeationLineageLock(
    input.repository_root,
    preliminary.state.slug,
    async () => {
      await reconcileCurrentIdeationStateAuthority(
        input.repository_root,
        preliminary.state.slug,
      );
      const current = await reopenCurrentCandidate(
        input.repository_root,
        preliminary.state.slug,
      );
      if (current.candidate_record_path !== input.candidate_record_path)
        throw staleCurrentCandidate(
          input.candidate_record_path,
          current.state_sha256,
          current.state_sha256,
        );
      const authority = await reopenApprovedAuthority(
        input.repository_root,
        current.candidate_record_path,
        input.response_record_path,
      );
      const receiptPath = ideationReceiptPath(authority.candidate.state.slug);
      rejectIdeationSupportPath(receiptPath);
      const receiptExists = await fileExists(
        input.repository_root,
        receiptPath,
      );
      const markdownExists = await fileExists(
        input.repository_root,
        ideationMarkdownPath(authority.candidate.state.slug),
      );
      if (receiptExists !== markdownExists)
        throw new TypeError(
          "incomplete Ideation publication recovery evidence",
        );
      const publication = receiptExists
        ? await reopenPublication(
            input.repository_root,
            authority.candidate,
            authority.response,
          )
        : null;
      return Object.freeze({
        state: authority.candidate.state,
        candidate: authority.candidate.candidate,
        response: Object.freeze({
          response_record_path: input.response_record_path,
          approved_html_evidence_path: authority.response.response_html_path,
          approved_html_sha256: authority.response.response_html_sha256,
          approval_status: authority.response.approval.approval_status,
          current_candidate_at_import_sha256: hashRawBytes(
            utf8(canonicalJson(current)),
          ),
        }),
        substantive_review_authority:
          authority.candidate.substantive_review_authority,
        publication,
      });
    },
  );
}

/** Reopens only current saved authority and emits a receipt-bound handoff under the lineage lock. */
export async function createDeepScopeHandoffFromSavedAuthority(input: {
  readonly repository_root: string;
  readonly slug: string;
}): Promise<DeepScopeHandoff> {
  assertSlug(input.slug);
  return withIdeationLineageLock(
    input.repository_root,
    input.slug,
    async () => {
      await reconcileCurrentIdeationStateAuthority(
        input.repository_root,
        input.slug,
      );
      const current = await reopenCurrentCandidate(
        input.repository_root,
        input.slug,
      );
      const receiptPath = ideationReceiptPath(input.slug);
      rejectIdeationSupportPath(receiptPath);
      const receipt = validatePublicationReceipt(
        await readCanonicalJson(input.repository_root, receiptPath),
      );
      const responseRecordPath = ideationResponseRecordPath(
        input.slug,
        receipt.approved_html_sha256,
      );
      rejectIdeationSupportPath(responseRecordPath);
      const authority = await reopenApprovedAuthority(
        input.repository_root,
        current.candidate_record_path,
        responseRecordPath,
      );
      const publication = await reopenPublication(
        input.repository_root,
        authority.candidate,
        authority.response,
      );
      const markdownPath = ideationMarkdownPath(input.slug);
      rejectIdeationSupportPath(markdownPath);
      const markdown = await readConfinedBytes(
        input.repository_root,
        markdownPath,
        4 * 1_024 * 1_024,
      );
      if (
        hashRawBytes(markdown) !==
          authority.candidate.candidate.files[0]?.sha256 ||
        receipt.candidate_sha256 !== authority.candidate.candidate_sha256 ||
        receipt.approved_html_sha256 !==
          authority.response.response_html_sha256 ||
        canonicalJson(receipt) !== canonicalJson(publication.receipt)
      )
        throw new TypeError(
          "current Ideation handoff authority does not bind publication",
        );
      return Object.freeze({
        schema: IDEATION_HANDOFF_SCHEMA,
        markdown_path: markdownPath,
        receipt_path: publication.receipt_path,
        workflow: IDEATION_WORKFLOW,
        run_id: authority.candidate.candidate.run_id,
        revision: authority.candidate.candidate.revision,
        max_review_rounds: authority.candidate.state.max_review_rounds,
        receipt_sha256: receipt.receipt_sha256,
        candidate_sha256: receipt.candidate_sha256,
        candidate_subject_sha256: receipt.candidate_subject_sha256,
        semantic_sha256: receipt.semantic_sha256,
        bundle_sha256: receipt.bundle_sha256,
        approved_html_sha256: receipt.approved_html_sha256,
        substantive_review_authority: receipt.substantive_review_authority,
      });
    },
  );
}

/** Confirms the handoff remains receipt-bound without reading raw HTML or Markdown structure. */
export function validateDeepScopeHandoff(input: unknown): DeepScopeHandoff {
  const value = closedObject(input, "$", [
    "schema",
    "markdown_path",
    "receipt_path",
    "workflow",
    "run_id",
    "revision",
    "max_review_rounds",
    "receipt_sha256",
    "candidate_sha256",
    "candidate_subject_sha256",
    "semantic_sha256",
    "bundle_sha256",
    "approved_html_sha256",
    "substantive_review_authority",
  ]);
  if (
    value.schema !== IDEATION_HANDOFF_SCHEMA ||
    value.workflow !== IDEATION_WORKFLOW
  )
    throw new TypeError("invalid Ideation handoff schema or workflow");
  const markdownPath = textPath(value.markdown_path, "handoff Markdown path");
  const receiptPath = textPath(value.receipt_path, "handoff receipt path");
  if (
    markdownPath !==
      ideationMarkdownPath(
        markdownPath.match(
          /^ai_docs\/ideation\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/,
        )?.[1] ?? "",
      ) ||
    receiptPath !== markdownPath.replace(/\.md$/, ".receipt.json")
  )
    throw new TypeError("invalid handoff paths");
  if (
    typeof value.run_id !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    ![1, 2, 3, 4, 5].includes(value.max_review_rounds as number)
  )
    throw new TypeError("invalid handoff run binding");
  for (const key of [
    "receipt_sha256",
    "candidate_sha256",
    "candidate_subject_sha256",
    "semantic_sha256",
    "bundle_sha256",
    "approved_html_sha256",
  ] as const)
    sha256(value[key], key);
  return Object.freeze({
    ...value,
    markdown_path: markdownPath,
    receipt_path: receiptPath,
    substantive_review_authority: validateAuthorityFileBinding(
      value.substantive_review_authority,
    ),
  } as DeepScopeHandoff);
}

export function ideationMarkdownPath(slug: string): string {
  assertSlug(slug);
  return `ai_docs/ideation/${slug}.md`;
}

export function ideationReceiptPath(slug: string): string {
  return ideationMarkdownPath(slug).replace(/\.md$/, ".receipt.json");
}

export function ideationStatePath(slug: string): string {
  return ideationMarkdownPath(slug).replace(/\.md$/, ".state.json");
}

/** Returns the runtime binding for one exact renderer snapshot. */
export function createIdeationRuntimeBinding(
  rendererSha256: string,
): RuntimeBinding {
  return Object.freeze({
    schema: RUNTIME_BINDING_SCHEMA,
    runtime_sha256: sha256(rendererSha256, "Ideation renderer snapshot hash"),
    canonical_json_schema: IDEATION_STATE_SCHEMA,
    verifier_schema: "approval-dossier/approval-response/v1",
  });
}

export function createIdeationSubstantiveReviewAuthority(
  stateInput: IdeationState,
  candidateSubjectSha256: string,
  bundleSha256: string,
): SubstantiveReviewAuthority {
  const state = validateIdeationState(stateInput);
  const review = state.final_document_review;
  if (review.current_episode === null || review.current_round === null)
    throw new TypeError("Ideation substantive review has no current episode");
  const episode = review.episodes[review.current_episode - 1]!;
  const currentRound = review.rounds[review.current_round - 1]!;
  const mandatoryCriteria = new Set(
    state.criteria
      .filter((criterion) => criterion.priority === "P0")
      .map((criterion) => criterion.id),
  );
  if (
    deriveFinalDocumentReviewGate(
      review,
      mandatoryCriteria,
      state.max_review_rounds,
    ).outcome !== "PASS"
  )
    throw new TypeError(
      "Ideation substantive review authority requires a current PASS episode",
    );
  if (currentRound.round < episode.first_round)
    throw new TypeError(
      "Ideation current review round is outside its current episode",
    );
  const subjectSha256 = finalDocumentReviewEpisodeSha256(
    review,
    episode.episode,
  );
  const mandatoryCoverageIds = Object.freeze(["current-episode-pass"]);
  const resultByReviewer = new Map(
    currentRound.results.map((result) => [result.reviewer_id, result]),
  );
  const assignmentPairs = currentRound.reviewers.map((reviewer, index) => {
    const result = resultByReviewer.get(reviewer.reviewer_id);
    if (result === undefined)
      throw new TypeError(
        `Ideation current PASS episode is missing reviewer result: ${reviewer.reviewer_id}`,
      );
    const requiredCoverageIds = Object.freeze(
      [
        ...new Set([
          ...mandatoryCoverageIds,
          ...result.assessed_criteria_ids,
          ...result.assessed_invariant_ids,
        ]),
      ].sort(),
    );
    const assignmentId = `assignment-${index + 1}`;
    return Object.freeze({
      assignment: Object.freeze({
        assignment_id: assignmentId,
        role: reviewer.assignment_role,
        reviewer_id: reviewer.reviewer_id,
        blind: true as const,
        specialist_trigger: reviewer.specialist_trigger,
        required_coverage_ids: requiredCoverageIds,
      }),
      result: Object.freeze({
        result_id: `result-${index + 1}`,
        result_sha256: result.result_sha256,
        assignment_id: assignmentId,
        reviewer_id: reviewer.reviewer_id,
        subject_sha256: subjectSha256,
        verdict: result.verdict,
        covered_coverage_ids: requiredCoverageIds,
        occurrence_ids: Object.freeze(
          result.findings.map((finding) => finding.occurrence_id),
        ),
        completed_at: result.completed_at,
      }),
      occurrences: result.findings.map((finding) =>
        Object.freeze({
          occurrence_id: finding.occurrence_id,
          finding_id: finding.stable_id,
          assignment_id: assignmentId,
          blocking: finding.severity === "blocking",
          resolution:
            finding.disposition === "accepted" ||
            finding.disposition === "mitigated" ||
            finding.disposition === "rejected"
              ? ("resolved" as const)
              : ("unresolved" as const),
          duplicate_of: null,
          recurrence_of: null,
          regression_of: null,
          caused_by: null,
          supersedes: null,
        }),
      ),
    });
  });
  return validateSubstantiveReviewAuthority({
    schema: SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA,
    workflow: IDEATION_WORKFLOW,
    run_id: state.run_id,
    revision: state.revision,
    subject_sha256: subjectSha256,
    candidate_subject_sha256: sha256(
      candidateSubjectSha256,
      "candidate review subject hash",
    ),
    semantic_sha256: ideationStateSha256(state),
    bundle_sha256: sha256(bundleSha256, "Markdown bundle hash"),
    mandatory_coverage_ids: mandatoryCoverageIds,
    assignments: assignmentPairs.map((entry) => entry.assignment),
    results: assignmentPairs.map((entry) => entry.result),
    occurrences: assignmentPairs.flatMap((entry) => entry.occurrences),
    derived_gate: "PASS",
  });
}

function createCandidateProjection(
  input: IdeationState,
  submittedAt: string,
  rendererSha256: string,
): Omit<IdeationCandidate, "rendered"> {
  const state = validateIdeationState(input);
  if (state.readiness.status !== "ready-for-approval")
    throw new TypeError(
      "only ready-for-approval Ideation state can create a candidate",
    );
  const mandatoryCriteria = new Set(
    state.criteria
      .filter((criterion) => criterion.priority === "P0")
      .map((criterion) => criterion.id),
  );
  if (
    deriveFinalDocumentReviewGate(
      state.final_document_review,
      mandatoryCriteria,
      state.max_review_rounds,
    ).outcome !== "PASS"
  )
    throw new TypeError(
      "candidate creation requires a current substantive review PASS",
    );
  const markdown = renderIdeationMarkdown(state);
  const runtime = createIdeationRuntimeBinding(rendererSha256);
  const visuals = createIdeationNativeVisuals(state);
  const visualSet = createIdeationVisualSet(state);
  const semantic = createIdeationSemanticBinding(state);
  const markdownFile = createMarkdownFileRecord(
    ideationMarkdownPath(state.slug),
    markdown,
  );
  const predecessors =
    state.predecessor_sha256 === null ? [] : [state.predecessor_sha256];
  const provisionalCandidate = createCandidateBinding({
    workflow: semantic.workflow,
    run_id: semantic.run_id,
    revision: semantic.revision,
    semantic_sha256: semantic.semantic_sha256,
    files: [markdownFile],
    visual_set_sha256: visualSet.visual_set_sha256,
    runtime_sha256: runtime.runtime_sha256,
    review_authority_sha256: "0".repeat(64),
    predecessors,
  });
  const substantiveReviewAuthority = createIdeationSubstantiveReviewAuthority(
    state,
    candidateReviewSubjectSha256(provisionalCandidate),
    provisionalCandidate.bundle_sha256,
  );
  const authoritySha256 = substantiveReviewAuthoritySha256(
    substantiveReviewAuthority,
  );
  const substantiveReviewAuthorityBinding = validateAuthorityFileBinding({
    schema: AUTHORITY_FILE_BINDING_SCHEMA,
    path: ideationSubstantiveReviewAuthorityPath(state.slug, authoritySha256),
    sha256: authoritySha256,
  });
  const candidate = createCandidateFromBindings({
    semantic,
    markdown_files: [{ path: markdownFile.path, bytes: markdown }],
    runtime,
    visual_set: visualSet,
    review_authority: substantiveReviewAuthority,
    predecessors,
  });
  const approval = createApprovalResponse({
    candidate,
    approval_status: "draft",
    approval_actor: "user",
    submitted_at: submittedAt,
    approved_at: null,
    feedback: [],
    files: [{ path: markdownFile.path, bytes: markdown }],
  });
  return Object.freeze({
    state,
    markdown,
    candidate,
    approval,
    runtime,
    visual_set: visualSet,
    visuals,
    substantive_review_authority: substantiveReviewAuthority,
    substantive_review_authority_binding: substantiveReviewAuthorityBinding,
  });
}

async function createCandidate(
  repositoryRoot: string,
  input: IdeationState,
  submittedAt: string,
  snapshot: ApprovalDossierRendererSnapshot,
): Promise<IdeationCandidate> {
  const projected = createCandidateProjection(
    input,
    submittedAt,
    snapshot.sha256,
  );
  const persistedAuthority = await persistSubstantiveReviewAuthority(
    repositoryRoot,
    projected.substantive_review_authority_binding.path,
    projected.substantive_review_authority,
  );
  if (
    canonicalJson(persistedAuthority.binding) !==
    canonicalJson(projected.substantive_review_authority_binding)
  )
    throw new TypeError(
      "persisted Ideation substantive review authority binding mismatch",
    );
  const rendered = await renderApprovalDossier(
    {
      title: `Ideation approval: ${projected.state.title}`,
      candidate: projected.candidate,
      approval: projected.approval,
      visual_set: projected.visual_set,
      visuals: projected.visuals,
      feedback_targets: projectFeedbackTargets(projected.state),
      review_presentations: projectIdeationReviewPresentations(projected.state),
    },
    snapshot,
  );
  if (rendered.renderer_sha256 !== projected.runtime.runtime_sha256)
    throw new TypeError(
      "rendered Ideation dossier does not bind its exact renderer snapshot",
    );
  return Object.freeze({ ...projected, rendered });
}

interface DurableCandidate {
  readonly state: IdeationState;
  readonly state_snapshot_path: string;
  readonly candidate: CandidateBinding;
  readonly candidate_sha256: string;
  readonly candidate_html_path: string;
  readonly candidate_html_sha256: string;
  readonly candidate_html: Uint8Array;
  readonly runtime: RuntimeBinding;
  readonly substantive_review_authority: AuthorityFileBinding;
}
interface DurableResponse {
  readonly response_html_path: string;
  readonly response_html_sha256: string;
  readonly approval: ApprovalResponse;
}

async function assertCurrentCanonicalState(
  repositoryRoot: string,
  expected: IdeationState,
  message: string,
): Promise<void> {
  const current = await reopenState(
    repositoryRoot,
    ideationStatePath(expected.slug),
  );
  if (
    ideationStateSha256(current) !== ideationStateSha256(expected) ||
    canonicalJson(current) !== canonicalJson(expected)
  )
    throw new TypeError(message);
}

async function reopenCandidate(
  repositoryRoot: string,
  recordPath: string,
  requireCurrentState = true,
): Promise<DurableCandidate> {
  const record = closedObject(
    await readCanonicalJson(repositoryRoot, recordPath),
    "$candidate",
    [
      "schema",
      "state_snapshot_path",
      "state_sha256",
      "substantive_review_authority",
      "candidate",
      "candidate_sha256",
      "candidate_html_path",
      "candidate_html_sha256",
      "renderer_manifest",
      "projection_manifest",
    ],
  );
  if (record.schema !== IDEATION_CANDIDATE_RECORD_SCHEMA)
    throw new TypeError("invalid Ideation candidate record schema");
  const stateSnapshotPath = textPath(
    record.state_snapshot_path,
    "candidate state snapshot",
  );
  const state = await reopenState(repositoryRoot, stateSnapshotPath);
  const stateSha256 = ideationStateSha256(state);
  if (
    record.state_sha256 !== stateSha256 ||
    stateSnapshotPath !== ideationStateSnapshotPath(state.slug, stateSha256)
  )
    throw new TypeError("candidate state snapshot hash mismatch");
  if (requireCurrentState)
    await assertCurrentCanonicalState(
      repositoryRoot,
      state,
      "candidate state is not the current canonical Ideation state",
    );
  const substantiveReviewAuthority = validateAuthorityFileBinding(
    record.substantive_review_authority,
  );
  const reopenedSubstantiveReviewAuthority =
    await reopenSubstantiveReviewAuthority(
      repositoryRoot,
      substantiveReviewAuthority,
    );
  const candidate = validateCandidateBinding(record.candidate);
  const candidateHash = candidateSha256(candidate);
  if (
    record.candidate_sha256 !== candidateHash ||
    candidate.workflow !== IDEATION_WORKFLOW ||
    candidate.run_id !== state.run_id ||
    candidate.revision !== state.revision ||
    candidate.semantic_sha256 !== stateSha256 ||
    candidate.files.length !== 1 ||
    candidate.files[0]?.path !== ideationMarkdownPath(state.slug)
  )
    throw new TypeError("candidate does not bind reopened Ideation state");
  const expectedPredecessors =
    state.predecessor_sha256 === null ? [] : [state.predecessor_sha256];
  if (
    candidate.predecessors.join("\u0000") !==
    expectedPredecessors.join("\u0000")
  )
    throw new TypeError(
      "candidate predecessor authority does not match semantic predecessor authority",
    );
  const snapshot = await loadApprovalDossierRendererSnapshot();
  const projection = await loadIdeationProjectionSnapshot(IDEATION_IMPLEMENTATION_ROOT);
  const projectionManifest = projection.manifest;
  const projectionSha256 = projection.sha256;
  if (
    canonicalJson(record.renderer_manifest) !==
      canonicalJson(snapshot.manifest) ||
    canonicalJson(record.projection_manifest) !==
      canonicalJson(projectionManifest)
  )
    throw new TypeError(
      "candidate manifest does not bind current renderer or projection",
    );
  const submissionPath = ideationCandidateSubmissionPath(
    state.slug,
    stateSha256,
    snapshot.sha256,
    projectionSha256,
  );
  const submission = await reopenCandidateSubmissionIfPresent(
    repositoryRoot,
    submissionPath,
  );
  if (
    submission === null ||
    canonicalJson(submission) !==
      canonicalJson({
        schema: IDEATION_CANDIDATE_SUBMISSION_SCHEMA,
        slug: state.slug,
        run_id: state.run_id,
        state_snapshot_path: stateSnapshotPath,
        state_sha256: stateSha256,
        renderer_sha256: snapshot.sha256,
        projection_sha256: projectionSha256,
        submitted_at: submission.submitted_at,
      })
  )
    throw new TypeError(
      "candidate submission does not bind reopened projection",
    );
  const expected = createCandidateProjection(
    state,
    submission.submitted_at,
    snapshot.sha256,
  );
  if (canonicalJson(candidate) !== canonicalJson(expected.candidate))
    throw new TypeError(
      "candidate does not match immutable submission projection",
    );
  assertSubstantiveReviewAuthorityPass(
    reopenedSubstantiveReviewAuthority,
    candidate,
    substantiveReviewAuthority.sha256,
  );
  const htmlPath = textPath(record.candidate_html_path, "candidate HTML");
  const htmlSha256 = sha256(
    record.candidate_html_sha256,
    "candidate HTML hash",
  );
  if (htmlPath !== ideationCandidateHtmlPath(state.slug, candidateHash))
    throw new TypeError("candidate HTML path mismatch");
  const html = await readConfinedBytes(
    repositoryRoot,
    htmlPath,
    4 * 1_024 * 1_024,
  );
  if (htmlSha256 !== hashRawBytes(html))
    throw new TypeError("candidate HTML hash mismatch");
  verifyImportedHtml(
    html,
    candidate,
    ideationContext(
      html,
      expected.runtime,
      substantiveReviewAuthority.sha256,
      state,
    ),
  );
  return Object.freeze({
    state,
    state_snapshot_path: stateSnapshotPath,
    candidate,
    candidate_sha256: candidateHash,
    candidate_html_path: htmlPath,
    candidate_html_sha256: htmlSha256,
    candidate_html: Uint8Array.from(html),
    runtime: expected.runtime,
    substantive_review_authority: substantiveReviewAuthority,
  });
}

async function reopenResponse(
  repositoryRoot: string,
  recordPath: string,
  candidateRecordPath: string,
  durableCandidate: DurableCandidate,
  requireCurrentCandidate = true,
): Promise<DurableResponse> {
  const decoded = await readCanonicalJson(repositoryRoot, recordPath);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    throw new TypeError("invalid Ideation response record");
  const actualSchema = (decoded as Record<string, unknown>).schema;
  if (actualSchema !== IDEATION_RESPONSE_RECORD_SCHEMA) {
    throw Object.assign(new TypeError("IDEATION_UNSUPPORTED_RESPONSE_SCHEMA"), {
      path: normalizeRepositoryRelativePath(recordPath),
      expected_schema: IDEATION_RESPONSE_RECORD_SCHEMA,
      actual_schema: actualSchema,
    });
  }
  const record = closedObject(decoded, "$response", [
    "schema",
    "candidate_record_path",
    "candidate_sha256",
    "current_candidate_at_import",
    "current_candidate_at_import_sha256",
    "response_html_path",
    "response_html_sha256",
    "approval",
  ]);
  if (
    textPath(record.candidate_record_path, "response candidate record") !==
      normalizeRepositoryRelativePath(candidateRecordPath) ||
    record.candidate_sha256 !== durableCandidate.candidate_sha256
  )
    throw new TypeError("response candidate binding mismatch");
  const current = await reopenCurrentCandidate(
    repositoryRoot,
    durableCandidate.state.slug,
    requireCurrentCandidate,
  );
  if (
    canonicalJson(record.current_candidate_at_import) !==
      canonicalJson(current) ||
    record.current_candidate_at_import_sha256 !==
      hashRawBytes(utf8(canonicalJson(current)))
  )
    throw new TypeError("response import current candidate binding mismatch");
  const responsePath = textPath(record.response_html_path, "response HTML");
  const responseSha256 = sha256(
    record.response_html_sha256,
    "response HTML hash",
  );
  const responseBytes = await readConfinedBytes(
    repositoryRoot,
    responsePath,
    4 * 1_024 * 1_024,
  );
  if (responseSha256 !== hashRawBytes(responseBytes))
    throw new TypeError("response HTML hash mismatch");
  const imported = verifyImportedHtml(
    responseBytes,
    durableCandidate.candidate,
    ideationContext(
      durableCandidate.candidate_html,
      durableCandidate.runtime,
      durableCandidate.substantive_review_authority.sha256,
      durableCandidate.state,
    ),
  );
  const approval = validateApprovalResponse(record.approval);
  if (canonicalJson(approval) !== canonicalJson(imported.approval))
    throw new TypeError("response approval record does not match saved HTML");
  const expectedEvidencePath =
    imported.approval.approval_status === "approved"
      ? ideationApprovedHtmlEvidencePath(
          durableCandidate.state.slug,
          imported.document_sha256,
        )
      : ideationResponseHtmlPath(
          durableCandidate.state.slug,
          imported.document_sha256,
        );
  if (responsePath !== expectedEvidencePath)
    throw new TypeError("response evidence path mismatch");
  return Object.freeze({
    response_html_path: responsePath,
    response_html_sha256: imported.document_sha256,
    approval,
  });
}

async function reopenCurrentCandidate(
  repositoryRoot: string,
  slug: string,
  requireCurrentState = true,
): Promise<IdeationCurrentCandidateRecord> {
  const path = ideationCurrentCandidatePath(slug);
  const record = closedObject(
    await readCanonicalJson(repositoryRoot, path),
    "$current_candidate",
    [
      "schema",
      "slug",
      "run_id",
      "state_snapshot_path",
      "state_sha256",
      "renderer_sha256",
      "projection_sha256",
      "submission_record_path",
      "submission_record_sha256",
      "candidate_record_path",
      "candidate_record_sha256",
    ],
  );
  if (
    record.schema !== IDEATION_CURRENT_CANDIDATE_SCHEMA ||
    record.slug !== slug
  )
    throw new TypeError("invalid current Ideation candidate record");
  const state = await reopenState(
    repositoryRoot,
    textPath(record.state_snapshot_path, "current candidate state snapshot"),
  );
  const stateSha = ideationStateSha256(state);
  if (
    record.run_id !== state.run_id ||
    record.state_sha256 !== stateSha ||
    record.state_snapshot_path !== ideationStateSnapshotPath(slug, stateSha)
  )
    throw new TypeError("current candidate state binding mismatch");
  if (requireCurrentState)
    await assertCurrentCanonicalState(
      repositoryRoot,
      state,
      "current candidate state is stale",
    );
  const submissionPath = textPath(
    record.submission_record_path,
    "candidate submission record",
  );
  const submissionBytes = await readConfinedBytes(
    repositoryRoot,
    submissionPath,
    64 * 1_024,
  );
  if (record.submission_record_sha256 !== hashRawBytes(submissionBytes))
    throw new TypeError("candidate submission hash mismatch");
  const submission = closedObject(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(submissionBytes),
    ),
    "$candidate_submission",
    [
      "schema",
      "slug",
      "run_id",
      "state_snapshot_path",
      "state_sha256",
      "renderer_sha256",
      "projection_sha256",
      "submitted_at",
    ],
  );
  if (
    submission.schema !== IDEATION_CANDIDATE_SUBMISSION_SCHEMA ||
    canonicalJson(submission) !==
      canonicalJson({
        schema: IDEATION_CANDIDATE_SUBMISSION_SCHEMA,
        slug,
        run_id: state.run_id,
        state_snapshot_path: ideationStateSnapshotPath(slug, stateSha),
        state_sha256: stateSha,
        renderer_sha256: record.renderer_sha256,
        projection_sha256: record.projection_sha256,
        submitted_at: submission.submitted_at,
      }) ||
    submissionPath !==
      ideationCandidateSubmissionPath(
        slug,
        stateSha,
        record.renderer_sha256 as string,
        record.projection_sha256 as string,
      )
  )
    throw new TypeError("candidate submission binding mismatch");
  const candidatePath = textPath(
    record.candidate_record_path,
    "current candidate record",
  );
  const candidateBytes = utf8(
    canonicalJson(await readCanonicalJson(repositoryRoot, candidatePath)),
  );
  if (record.candidate_record_sha256 !== hashRawBytes(candidateBytes))
    throw new TypeError("current candidate record hash mismatch");
  const candidate = await reopenCandidate(
    repositoryRoot,
    candidatePath,
    requireCurrentState,
  );
  const projection = await loadIdeationProjectionSnapshot(IDEATION_IMPLEMENTATION_ROOT);
  if (
    candidatePath !==
      ideationCandidateRecordPath(slug, candidate.candidate_sha256) ||
    candidate.state_snapshot_path !==
      ideationStateSnapshotPath(slug, stateSha) ||
    candidate.runtime.runtime_sha256 !== record.renderer_sha256 ||
    projection.sha256 !== record.projection_sha256
  )
    throw new TypeError("current candidate projection binding mismatch");
  return Object.freeze({
    schema: IDEATION_CURRENT_CANDIDATE_SCHEMA,
    slug,
    run_id: state.run_id,
    state_snapshot_path: ideationStateSnapshotPath(slug, stateSha),
    state_sha256: stateSha,
    renderer_sha256: record.renderer_sha256 as string,
    projection_sha256: record.projection_sha256 as string,
    submission_record_path: submissionPath,
    submission_record_sha256: record.submission_record_sha256 as string,
    candidate_record_path: candidatePath,
    candidate_record_sha256: record.candidate_record_sha256 as string,
  });
}

async function reopenApprovedAuthority(
  repositoryRoot: string,
  candidateRecordPath: string,
  responseRecordPath: string,
) {
  const candidate = await reopenCandidate(repositoryRoot, candidateRecordPath);
  const response = await reopenResponse(
    repositoryRoot,
    responseRecordPath,
    candidateRecordPath,
    candidate,
  );
  const responseBytes = await readConfinedBytes(
    repositoryRoot,
    response.response_html_path,
    4 * 1_024 * 1_024,
  );
  const imported = verifyApprovedImportedHtml(
    responseBytes,
    candidate.candidate,
    ideationContext(
      candidate.candidate_html,
      candidate.runtime,
      candidate.substantive_review_authority.sha256,
      candidate.state,
    ),
  );
  if (imported.document_sha256 !== response.response_html_sha256)
    throw new TypeError("approved response evidence hash mismatch");
  return Object.freeze({ candidate, response, responseBytes, imported });
}
async function reopenPublication(
  repositoryRoot: string,
  candidate: DurableCandidate,
  response: DurableResponse,
): Promise<IdeationPublication> {
  const markdownPath = ideationMarkdownPath(candidate.state.slug);
  const receiptPath = ideationReceiptPath(candidate.state.slug);
  const receiptBody = {
    schema: PUBLICATION_RECEIPT_SCHEMA,
    receipt_path: receiptPath,
    candidate_sha256: candidate.candidate_sha256,
    candidate_subject_sha256: candidateReviewSubjectSha256(candidate.candidate),
    approved_html_sha256: response.response_html_sha256,
    workflow: IDEATION_WORKFLOW,
    run_id: candidate.candidate.run_id,
    revision: candidate.candidate.revision,
    semantic_sha256: candidate.candidate.semantic_sha256,
    bundle_sha256: candidate.candidate.bundle_sha256,
    files: candidate.candidate.files.map(
      ({ path, sha256, byte_count, media_type }) => ({
        path,
        sha256,
        byte_count,
        media_type,
      }),
    ),
    substantive_review_authority: candidate.substantive_review_authority,
    final_paths: candidate.candidate.final_paths,
  } as const;
  const expected: ApprovedMarkdownExpected = {
    markdown_path: markdownPath,
    receipt_path: receiptPath,
    workflow: IDEATION_WORKFLOW,
    run_id: candidate.candidate.run_id,
    revision: candidate.candidate.revision,
    receipt_sha256: publicationReceiptSha256(receiptBody),
    candidate_sha256: candidate.candidate_sha256,
    candidate_subject_sha256: candidateReviewSubjectSha256(candidate.candidate),
    semantic_sha256: candidate.candidate.semantic_sha256,
    bundle_sha256: candidate.candidate.bundle_sha256,
    approved_html_sha256: response.response_html_sha256,
    substantive_review_authority: candidate.substantive_review_authority,
  };
  const projection = await verifyApprovedMarkdownProjection({
    repository_root: repositoryRoot,
    markdown_path: markdownPath,
    receipt_path: receiptPath,
    expected,
  });
  const receiptBytes = await readConfinedBytes(
    repositoryRoot,
    receiptPath,
    64 * 1_024,
  );
  const receipt = validatePublicationReceipt(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)),
  );
  if (
    Buffer.compare(
      Buffer.from(receiptBytes),
      Buffer.from(publicationReceiptBytes(receipt)),
    ) !== 0 ||
    receipt.receipt_sha256 !== expected.receipt_sha256 ||
    projection.receipt_sha256 !== expected.receipt_sha256
  )
    throw new TypeError("canonical Ideation publication receipt mismatch");
  const evidence = await readConfinedBytes(
    repositoryRoot,
    response.response_html_path,
    4 * 1_024 * 1_024,
  );

  if (hashRawBytes(evidence) !== response.response_html_sha256)
    throw new TypeError("approved HTML evidence cannot be reopened");
  return Object.freeze({
    receipt,
    receipt_path: receiptPath,
    approved_html_evidence_path: response.response_html_path,
  });
}
function stateSemanticIds(state: IdeationState): ReadonlySet<string> {
  return new Set([
    state.goal.id,
    ...state.criteria.map((entry) => entry.id),
    ...state.decisions.map((entry) => entry.id),
    ...state.assumptions.map((entry) => entry.id),
    ...state.evidence.map((entry) => entry.id),
    ...state.readiness.bounded_ambiguities.map((entry) => entry.id),
    ...state.visuals.map((entry) => entry.id),
  ]);
}
function canonicalTargetSet(
  targets: readonly IdeationExchangeTarget[],
): string {
  return canonicalJson(
    [...targets].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  );
}
async function assertSuccessorStateTransition(
  repositoryRoot: string,
  predecessor: IdeationState,
  successor: IdeationState,
): Promise<void> {
  const inheritedExchangeCount = predecessor.interview_exchanges.length;
  if (
    canonicalJson(
      successor.interview_exchanges.slice(0, inheritedExchangeCount),
    ) !== canonicalJson(predecessor.interview_exchanges)
  ) {
    throw new TypeError(
      "Ideation successor must preserve the complete predecessor exchange prefix byte-for-byte",
    );
  }
  const appended = successor.interview_exchanges.slice(inheritedExchangeCount);
  const predecessorEvidenceIds = new Set(
    predecessor.evidence.map((entry) => entry.id),
  );
  const successorEvidenceIds = new Set(
    successor.evidence.map((entry) => entry.id),
  );
  for (const exchange of predecessor.interview_exchanges) {
    for (const evidenceId of exchange.evidence_ids) {
      if (
        predecessorEvidenceIds.has(evidenceId) &&
        !successorEvidenceIds.has(evidenceId)
      ) {
        throw new TypeError(
          "Ideation successor cannot remove evidence referenced by the exchange ledger",
        );
      }
    }
  }
  if (successor.revision_kind === "accepted-answer") {
    const changedTargets = deriveChangedExchangeTargets(predecessor, successor);
    if (appended.length !== 1)
      throw new TypeError(
        "accepted-answer Ideation successor must append exactly one exchange",
      );
    if (
      changedTargets.length === 0 ||
      canonicalTargetSet(changedTargets) !==
        canonicalTargetSet(appended[0]!.affected_targets)
    ) {
      throw new TypeError(
        "accepted-answer Ideation successor exchange targets must exactly match its non-empty semantic delta",
      );
    }
    const semanticIds = new Set([
      ...stateSemanticIds(predecessor),
      ...stateSemanticIds(successor),
    ]);
    for (const target of appended[0]!.affected_targets) {
      if (
        target.target_type === "semantic-id" &&
        !semanticIds.has(target.semantic_id)
      ) {
        throw new TypeError(
          `accepted-answer Ideation successor references unknown semantic ID: ${target.semantic_id}`,
        );
      }
    }
    if (
      canonicalJson(successor.final_document_review) !==
      canonicalJson(predecessor.final_document_review)
    ) {
      await assertSuccessorReviewHistory(repositoryRoot, predecessor, successor);
      if (
        successor.final_document_review.rounds.length !==
          predecessor.final_document_review.rounds.length + 1 ||
        successor.final_document_review.current_round !==
          successor.final_document_review.rounds.length ||
        successor.final_document_review.rounds.at(-1)!.results.length !== 0
      )
        throw new TypeError(
          "accepted-answer Ideation successor may only append one empty current review round",
        );
    }
    return;
  }
  if (appended.length !== 0)
    throw new TypeError(
      "non-answer Ideation successor cannot append interview exchanges",
    );
  await assertSuccessorReviewHistory(repositoryRoot, predecessor, successor);
  const changedTargets = deriveChangedExchangeTargets(predecessor, successor);
  const appendedReviewAuthority =
    successor.final_document_review.rounds.length ===
    predecessor.final_document_review.rounds.length + 1;
  const readinessStatusOnly =
    appendedReviewAuthority &&
    changedTargets.length === 1 &&
    changedTargets[0]!.target_type === "state-field" &&
    changedTargets[0]!.field === "readiness" &&
    canonicalJson(successor.readiness.blockers) ===
      canonicalJson(predecessor.readiness.blockers) &&
    canonicalJson(successor.readiness.bounded_ambiguities) ===
      canonicalJson(predecessor.readiness.bounded_ambiguities);
  const readinessPromotion =
    readinessStatusOnly &&
    predecessor.readiness.status === "draft" &&
    successor.readiness.status === "ready-for-approval" &&
    deriveFinalDocumentReviewGate(
      successor.final_document_review,
      new Set(
        successor.criteria
          .filter((criterion) => criterion.priority === "P0")
          .map((criterion) => criterion.id),
      ),
      successor.max_review_rounds,
    ).outcome === "PASS";
  if (changedTargets.length !== 0 && !readinessPromotion)
    throw new TypeError(
      "non-answer Ideation successor cannot change mapped semantic state",
    );
}

async function assertSuccessorReviewHistory(
  repositoryRoot: string,
  predecessor: IdeationState,
  successor: IdeationState,
): Promise<void> {
  if (successor.max_review_rounds !== predecessor.max_review_rounds)
    throw new TypeError("Ideation max_review_rounds is immutable across adjacent successor states");
  const inheritedRounds = predecessor.final_document_review.rounds;
  const proposedRounds = successor.final_document_review.rounds;
  const inheritedEpisodes = predecessor.final_document_review.episodes;
  const proposedEpisodes = successor.final_document_review.episodes;
  if (
    proposedRounds.length < inheritedRounds.length ||
    proposedRounds.length > inheritedRounds.length + 1 ||
    canonicalJson(proposedRounds.slice(0, inheritedRounds.length)) !==
      canonicalJson(inheritedRounds) ||
    proposedEpisodes.length < inheritedEpisodes.length ||
    proposedEpisodes.length > inheritedEpisodes.length + 1 ||
    canonicalJson(proposedEpisodes.slice(0, inheritedEpisodes.length)) !==
      canonicalJson(inheritedEpisodes)
  ) {
    throw new TypeError(
      "Ideation successor must preserve complete immutable predecessor review episode history and append at most one episode and round",
    );
  }
  if (
    proposedEpisodes.length !== inheritedEpisodes.length + 1 ||
    inheritedEpisodes.length === 0
  )
    return;
  const episode = proposedEpisodes.at(-1)!;
  if (episode.predecessor_state_sha256 !== ideationStateSha256(predecessor))
    throw new TypeError(
      "Ideation successor review episode does not bind its exact predecessor state",
    );
  const candidatePath = episode.predecessor_candidate_record_path;
  const responsePath = episode.predecessor_response_record_path;
  if (
    candidatePath === null ||
    responsePath === null ||
    episode.predecessor_candidate_record_sha256 === null ||
    episode.predecessor_response_record_sha256 === null ||
    episode.predecessor_import_current_candidate_sha256 === null
  )
    throw new TypeError(
      "Ideation successor review episode requires complete saved-response predecessor authority",
    );
  rejectIdeationSupportPath(candidatePath);
  rejectIdeationSupportPath(responsePath);
  const candidateBytes = await readConfinedBytes(
    repositoryRoot,
    candidatePath,
    256 * 1_024,
  );
  const responseBytes = await readConfinedBytes(
    repositoryRoot,
    responsePath,
    256 * 1_024,
  );
  if (
    hashRawBytes(candidateBytes) !==
      episode.predecessor_candidate_record_sha256 ||
    hashRawBytes(responseBytes) !== episode.predecessor_response_record_sha256
  )
    throw new TypeError(
      "Ideation successor review episode predecessor record hash mismatch",
    );
  const candidate = await reopenCandidate(repositoryRoot, candidatePath, false);
  if (ideationStateSha256(candidate.state) !== ideationStateSha256(predecessor))
    throw new TypeError(
      "Ideation successor review episode candidate does not bind predecessor state",
    );
  const response = await reopenResponse(
    repositoryRoot,
    responsePath,
    candidatePath,
    candidate,
    false,
  );
  if (
    response.approval.approval_status !== "changes-requested" &&
    response.approval.approval_status !== "rejected"
  )
    throw new TypeError(
      "Ideation successor review episode requires a returned response",
    );
  const responseRecord = closedObject(
    await readCanonicalJson(repositoryRoot, responsePath),
    "$response",
    [
      "schema",
      "candidate_record_path",
      "candidate_sha256",
      "current_candidate_at_import",
      "current_candidate_at_import_sha256",
      "response_html_path",
      "response_html_sha256",
      "approval",
    ],
  );
  if (
    responseRecord.current_candidate_at_import_sha256 !==
    episode.predecessor_import_current_candidate_sha256
  )
    throw new TypeError(
      "Ideation successor review episode import-current-candidate binding mismatch",
    );
  for (const prior of inheritedEpisodes) {
    if (
      prior.predecessor_response_record_sha256 ===
      episode.predecessor_response_record_sha256
    )
      throw new TypeError(
        "Ideation response authority cannot reopen more than one review episode",
      );
  }
}

interface ImmutableV8Snapshot {
  readonly sha256: string;
  readonly path: string;
  readonly state: IdeationState;
}

/** Enumerates only canonical immutable v8 snapshots and rejects legacy same-slug state authority. */
async function enumerateImmutableV8Lineage(
  repositoryRoot: string,
  slug: string,
): Promise<ReadonlyMap<string, ImmutableV8Snapshot>> {
  let entries: readonly string[];
  try {
    entries = await listAuthorityDirectory(repositoryRoot, "ai_docs/ideation");
  } catch (error) {
    if (isAuthorityNotFound(error)) return new Map();
    throw error;
  }
  const exact = new RegExp(`^\\.${slug}\\.state-([0-9a-f]{64})\\.json$`);
  const stateLike = new RegExp(`^\\.?${slug}\\.state(?:-|\\.)`);
  const snapshots = new Map<string, ImmutableV8Snapshot>();
  for (const entry of entries) {
    const match = exact.exec(entry);
    if (match === null) {
      if (stateLike.test(entry) && entry !== `${slug}.state.json`)
        throw new TypeError(
          `IDEATION_STATE_LINEAGE_CORRUPTION:legacy state authority:${entry}`,
        );
      continue;
    }
    const path = `ai_docs/ideation/${entry}`;
    const state = await reopenState(repositoryRoot, path);
    const stateSha256 = ideationStateSha256(state);
    if (
      state.schema !== IDEATION_STATE_SCHEMA ||
      state.slug !== slug ||
      stateSha256 !== match[1]
    )
      throw new TypeError(
        `IDEATION_STATE_LINEAGE_CORRUPTION:invalid immutable snapshot:${path}`,
      );
    if (snapshots.has(stateSha256))
      throw new TypeError(`IDEATION_STATE_LINEAGE_CORRUPTION:duplicate immutable snapshot:${path}`);
    snapshots.set(stateSha256, Object.freeze({ sha256: stateSha256, path, state }));
  }
  return snapshots;
}

/** Proves the immutable snapshots are one contiguous same-run predecessor chain with one tip. */
async function validateUniqueImmutableV8Lineage(
  repositoryRoot: string,
  slug: string,
  snapshots: ReadonlyMap<string, ImmutableV8Snapshot>,
): Promise<ImmutableV8Snapshot> {
  if (snapshots.size === 0)
    throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:missing immutable v8 snapshots");
  const successors = new Set<string>();
  let runId: string | null = null;
  for (const snapshot of snapshots.values()) {
    const { state } = snapshot;
    if (state.slug !== slug || (runId !== null && state.run_id !== runId))
      throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:mixed immutable state lineage");
    runId ??= state.run_id;
    if (state.revision === 1) {
      if (state.predecessor_sha256 !== null)
        throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:genesis predecessor");
      continue;
    }
    if (state.predecessor_sha256 === null)
      throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:missing predecessor");
    const predecessor = snapshots.get(state.predecessor_sha256);
    if (
      predecessor === undefined ||
      predecessor.state.revision !== state.revision - 1 ||
      predecessor.state.run_id !== state.run_id
    )
      throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:missing adjacent predecessor");
    if (successors.has(state.predecessor_sha256))
      throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:immutable lineage fork");
    if (
      canonicalJson(
        state.interview_exchanges.slice(0, predecessor.state.interview_exchanges.length),
      ) !== canonicalJson(predecessor.state.interview_exchanges)
    )
      throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:predecessor ledger prefix");
    await assertSuccessorStateTransition(
      repositoryRoot,
      predecessor.state,
      state,
    );
    successors.add(state.predecessor_sha256);
  }
  const tips = [...snapshots.values()].filter(({ sha256 }) => !successors.has(sha256));
  if (tips.length !== 1)
    throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:immutable lineage lacks unique tip");
  const tip = tips[0]!;
  let cursor: ImmutableV8Snapshot | undefined = tip;
  let depth = 0;
  while (cursor !== undefined) {
    depth += 1;
    cursor = cursor.state.predecessor_sha256 === null
      ? undefined
      : snapshots.get(cursor.state.predecessor_sha256);
  }
  if (depth !== snapshots.size || tip.state.revision !== snapshots.size)
    throw new TypeError("IDEATION_STATE_LINEAGE_CORRUPTION:orphan or noncontiguous immutable snapshot");
  return tip;
}

/** Reopens every referenced substantive result file before a ready state is accepted. */
async function reopenSubstantiveReviewResults(
  repositoryRoot: string,
  state: IdeationState,
): Promise<void> {
  const review = state.final_document_review;
  if (review.current_round === null)
    throw new TypeError(
      "ready Ideation state has no current substantive review",
    );
  const current = review.rounds[review.current_round - 1]!;
  if (current.subject.subject_sha256 !== ideationReviewSubjectSha256(state))
    throw new TypeError("stale substantive review subject");
  const mandatoryCriteria = new Set(
    state.criteria
      .filter((criterion) => criterion.priority === "P0")
      .map((criterion) => criterion.id),
  );
  const gate = deriveFinalDocumentReviewGate(
    review,
    mandatoryCriteria,
    state.max_review_rounds,
  );
  if (gate.outcome !== "PASS")
    await assertIdeationReturnedResponseAuthority(repositoryRoot, state);
  for (const result of review.rounds.flatMap((round) => round.results)) {
    const bytes = await readConfinedBytes(
      repositoryRoot,
      result.result_path,
      4 * 1_024 * 1_024,
    );
    if (hashRawBytes(bytes) !== result.result_sha256)
      throw new TypeError(
        `substantive review result hash mismatch: ${result.result_path}`,
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const actual = JSON.parse(text);
    const expected = finalDocumentReviewResultEvidence(result);
    if (
      text !== canonicalJson(actual) ||
      canonicalJson(actual) !== canonicalJson(expected)
    )
      throw new TypeError(
        `substantive review result bytes do not match bound result: ${result.result_path}`,
      );
  }
}

async function reopenCandidateSubmissionIfPresent(
  repositoryRoot: string,
  path: string,
): Promise<IdeationCandidateSubmissionRecord | null> {
  try {
    const submission = closedObject(
      await readCanonicalJson(repositoryRoot, path),
      "$candidate_submission",
      [
        "schema",
        "slug",
        "run_id",
        "state_snapshot_path",
        "state_sha256",
        "renderer_sha256",
        "projection_sha256",
        "submitted_at",
      ],
    );
    if (submission.schema !== IDEATION_CANDIDATE_SUBMISSION_SCHEMA)
      throw new TypeError("invalid Ideation candidate submission schema");
    return Object.freeze({
      schema: IDEATION_CANDIDATE_SUBMISSION_SCHEMA,
      slug: textPath(submission.slug, "candidate submission slug"),
      run_id: textPath(submission.run_id, "candidate submission run ID"),
      state_snapshot_path: textPath(
        submission.state_snapshot_path,
        "candidate submission state snapshot",
      ),
      state_sha256: sha256(
        submission.state_sha256,
        "candidate submission state hash",
      ),
      renderer_sha256: sha256(
        submission.renderer_sha256,
        "candidate submission renderer hash",
      ),
      projection_sha256: sha256(
        submission.projection_sha256,
        "candidate submission projection hash",
      ),
      submitted_at: validateSubmissionTimestamp(submission.submitted_at),
    });
  } catch (error) {
    if (isAuthorityNotFound(error)) return null;
    throw error;
  }
}

async function reopenCurrentCandidateIfPresent(
  repositoryRoot: string,
  slug: string,
): Promise<IdeationCurrentCandidateRecord | null> {
  try {
    return await reopenCurrentCandidate(repositoryRoot, slug);
  } catch (error) {
    if (isAuthorityNotFound(error)) return null;
    throw error;
  }
}

async function reopenState(
  repositoryRoot: string,
  path: string,
): Promise<IdeationState> {
  const bytes = await readConfinedBytes(
    repositoryRoot,
    path,
    4 * 1_024 * 1_024,
  );
  const state = validateIdeationState(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    Buffer.compare(
      Buffer.from(bytes),
      Buffer.from(utf8(canonicalJson(state))),
    ) !== 0
  )
    throw new TypeError("Ideation state is not canonical durable JSON");
  return state;
}

async function reopenCurrentStateIfPresent(
  repositoryRoot: string,
  path: string,
): Promise<IdeationState | null> {
  try {
    return await reopenState(repositoryRoot, path);
  } catch (error) {
    if (isAuthorityNotFound(error)) return null;
    throw error;
  }
}

async function installCanonicalJson(
  repositoryRoot: string,
  path: string,
  value: unknown,
): Promise<void> {
  await installImmutableFile(repositoryRoot, path, utf8(canonicalJson(value)));
  await readCanonicalJson(repositoryRoot, path);
}

async function readCanonicalJson(
  repositoryRoot: string,
  path: string,
): Promise<unknown> {
  const bytes = await readConfinedBytes(
    repositoryRoot,
    path,
    4 * 1_024 * 1_024,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  if (text !== canonicalJson(value))
    throw new TypeError(`durable record is not canonical JSON: ${path}`);
  return value;
}

/** Installs immutable evidence through the shared descriptor-confined no-clobber primitive. */
async function installImmutableFile(
  repositoryRoot: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await installImmutableAuthorityFile(repositoryRoot, path, bytes, 0o600);
  const reopened = await readAuthorityFile(repositoryRoot, path);
  if (Buffer.compare(Buffer.from(reopened), Buffer.from(bytes)) !== 0)
    throw new TypeError(
      `immutable Ideation evidence did not reopen exactly: ${path}`,
    );
}

function ideationCandidateSubmissionPath(
  slug: string,
  stateSha256: string,
  rendererSha256: string,
  projectionSha256: string,
): string {
  assertSlug(slug);
  const identitySha256 = hashCanonicalJson({
    state_sha256: sha256(stateSha256, "state hash"),
    renderer_sha256: sha256(rendererSha256, "renderer hash"),
    projection_sha256: sha256(projectionSha256, "projection hash"),
  });
  return `ai_docs/ideation/.${slug}.candidate-submission-${identitySha256}.json`;
}

/** Replaces the canonical mutable state through descriptor-confined shared authority I/O. */
async function writeCurrentState(
  repositoryRoot: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await writeAuthorityFile(repositoryRoot, path, bytes, 0o600);
  const reopened = await readAuthorityFile(repositoryRoot, path);
  if (Buffer.compare(Buffer.from(reopened), Buffer.from(bytes)) !== 0)
    throw new TypeError(
      `current Ideation state write did not persist exact bytes: ${path}`,
    );
}

async function readConfinedBytes(
  repositoryRoot: string,
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const bytes = await readAuthorityFile(repositoryRoot, path);
  if (bytes.byteLength > maximumBytes)
    throw new TypeError(`invalid confined Ideation file: ${path}`);
  return Uint8Array.from(bytes);
}

async function fileExists(
  repositoryRoot: string,
  path: string,
): Promise<boolean> {
  try {
    await readConfinedBytes(repositoryRoot, path, 4 * 1_024 * 1_024);
    return true;
  } catch (error) {
    if (isAuthorityNotFound(error)) return false;
    throw error;
  }
}

function slugFromCanonicalStatePath(path: string): string {
  const matched =
    /^ai_docs\/ideation\/([a-z0-9]+(?:-[a-z0-9]+)*)\.state\.json$/.exec(path);
  if (matched === null)
    throw new TypeError(
      "candidate state path is not the canonical Ideation state path",
    );
  assertSlug(matched[1]!);
  return matched[1]!;
}

function validateSubmissionTimestamp(value: unknown): string {
  return validateApprovalTimestamp(value, "candidate submission timestamp");
}

function ideationStateSnapshotPath(slug: string, stateSha256: string): string {
  assertSlug(slug);
  return `ai_docs/ideation/.${slug}.state-${sha256(stateSha256, "state hash")}.json`;
}
function ideationCandidateRecordPath(
  slug: string,
  candidateSha: string,
): string {
  assertSlug(slug);
  return `ai_docs/ideation/.${slug}.candidate-${sha256(candidateSha, "candidate hash")}.json`;
}
function ideationCandidateHtmlPath(slug: string, candidateSha: string): string {
  assertSlug(slug);
  return `ai_docs/ideation/.${slug}.candidate-${sha256(candidateSha, "candidate hash")}.html`;
}
function ideationResponseRecordPath(slug: string, responseSha: string): string {
  assertSlug(slug);
  return `ai_docs/ideation/.${slug}.response-${sha256(responseSha, "response hash")}.json`;
}
function ideationResponseHtmlPath(slug: string, responseSha: string): string {
  assertSlug(slug);
  return `ai_docs/ideation/.${slug}.response-${sha256(responseSha, "response hash")}.html`;
}
function ideationApprovedHtmlEvidencePath(
  slug: string,
  responseSha: string,
): string {
  assertSlug(slug);
  return `ai_docs/ideation/${slug}.approved-${sha256(responseSha, "response hash")}.html`;
}
function ideationSubstantiveReviewAuthorityPath(
  slug: string,
  authoritySha256: string,
): string {
  assertSlug(slug);
  return `ai_docs/ideation/.${slug}.substantive-review-authority-${sha256(authoritySha256, "substantive review authority hash")}.json`;
}


function ideationCurrentCandidatePath(slug: string): string {
  assertSlug(slug);
  return `ai_docs/ideation/.${slug}.current-candidate.json`;
}
function ideationContext(
  candidateHtml: Uint8Array,
  runtime: RuntimeBinding,
  reviewAuthoritySha256: string,
  state: IdeationState,
) {
  return Object.freeze({
    runtime,
    visual_set: createIdeationVisualSet(state),
    candidate_html: Uint8Array.from(candidateHtml),
    review_authority_sha256: sha256(
      reviewAuthoritySha256,
      "review authority hash",
    ),
  });
}
function isAuthorityNotFound(error: unknown): boolean {
  return error instanceof AuthorityFileError && error.code === "NOT_FOUND";
}
function utf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}
function textPath(value: unknown, label: string): string {
  return validateRepositoryRelativePath(value, label);
}
function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new TypeError(`invalid ${label}`);
  return value;
}
function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new TypeError("invalid ideation slug");
}

function rejectIdeationSupportPath(path: string): void {
  if (
    /^ai_docs\/ideation\/[.][a-z0-9]+(?:-[a-z0-9]+)*[.]support-[0-9a-f]{64}[.](?:html|record[.]json)$/.test(
      path,
    )
  ) {
    throw Object.assign(
      new TypeError("IDEATION_NON_AUTHORITATIVE_SUPPORT_REJECTED"),
      {
        code: "IDEATION_NON_AUTHORITATIVE_SUPPORT_REJECTED" as const,
        path,
        artifact_kind: "non-authoritative-support" as const,
      },
    );
  }
}
function staleCurrentCandidate(
  path: string,
  expectedStateSha256: string,
  actualStateSha256: string,
): TypeError {
  return Object.assign(new TypeError("IDEATION_STALE_CURRENT_CANDIDATE"), {
    code: "IDEATION_STALE_CURRENT_CANDIDATE" as const,
    path,
    expected_state_sha256: expectedStateSha256,
    actual_state_sha256: actualStateSha256,
  });
}

function closedObject(
  input: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError(`${path}: expected object`);
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      throw new TypeError(`${path}.${key}: unknown field`);
  for (const key of keys)
    if (!(key in value)) throw new TypeError(`${path}.${key}: missing field`);
  return value;
}
