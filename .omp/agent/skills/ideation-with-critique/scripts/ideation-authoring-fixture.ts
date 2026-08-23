import { constants } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CandidateBinding } from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import { createApprovalResponse } from "../../approval-dossier-runtime/scripts/approval-dossier-runtime.ts";
import { encodeProtectedApprovalPayload } from "../../approval-dossier-runtime/scripts/approval-dossier-html.ts";
import { canonicalJson, hashCanonicalJson, hashRawBytes } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import {
  finalDocumentReviewResultEvidence,
  IDEATION_FINAL_REVIEW_SCHEMA,
  ideationReviewResultPath,
  ideationReviewSubjectSha256,
  ideationStateSha256,
  validateIdeationState,
  type FinalDocumentReviewResult,
  type IdeationState,
} from "../schemas/ideation-state.ts";
import { loadIdeationProjectionSnapshot } from "./ideation-projection-manifest.ts";
import { renderIdeationMarkdown } from "./ideation-projection.ts";
import { renderIdeationQuestionnaireWorkspaceHtml } from "./ideation-support-renderer.ts";
import {
  createIdeationSupportDossier,
  importQuestionnaireWorkspace,
  issueInitialWorkspace,
  issueRebaseWorkspace,
  loadIdeationSupportRendererSnapshot,
  reopenIdeationSupportDossier,
  reopenQuestionnaireWorkspace,
  saveQuestionnaireWorkspace,
} from "./ideation-support-runtime.ts";
import {
  createDeepScopeHandoffFromSavedAuthority,
  createIdeationCandidateFromSavedState,
  ideationMarkdownPath,
  ideationReceiptPath,
  importIdeationResponseFromSavedPath,
  persistIdeationState,
  persistIdeationSubstantiveReviewResults,
  publishIdeationMarkdownFromSavedRecords,
  reconcileCurrentIdeationStateAuthority,
} from "./ideation-runtime.ts";

export const IDEATION_AUTHORING_ARTIFACT_MANIFEST_SCHEMA = "ideation-authoring/artifact-manifest/v3" as const;

export interface AuthoringFixtureArguments {
  readonly repositoryRoot: string;
  readonly implementationRoot: string;
  readonly fixture: string;
  readonly submittedAt: string;
  readonly artifactManifest: string;
}
interface Artifact { readonly path: string; readonly sha256: string; readonly byte_count: number }

export function parseAuthoringFixtureArguments(argv: readonly string[]): AuthoringFixtureArguments {
  const flags = ["--repository-root", "--implementation-root", "--fixture", "--submitted-at", "--artifact-manifest"] as const;
  if (argv.length !== 12) throw new TypeError("usage: --repository-root <path> --implementation-root <path> --fixture <path> --submitted-at <RFC3339> --artifact-manifest <path>");
  const values = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || !flags.includes(flag as (typeof flags)[number]) || values.has(flag)) throw new TypeError("expected each required authoring-fixture flag exactly once");
    values.set(flag, value);
  }
  const submittedAt = values.get("--submitted-at")!;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(submittedAt) || Number.isNaN(Date.parse(submittedAt))) throw new TypeError("--submitted-at must be an RFC 3339 millisecond UTC timestamp");
  return Object.freeze({ repositoryRoot: resolve(values.get("--repository-root")!), implementationRoot: resolve(values.get("--implementation-root")!), fixture: values.get("--fixture")!, submittedAt, artifactManifest: resolve(values.get("--artifact-manifest")!) });
}

function repositoryRelative(root: string, location: string): string {
  const path = relative(root, location).replaceAll("\\", "/");
  if (path === "" || path === ".." || path.startsWith("../") || isAbsolute(path)) throw new TypeError(`path escapes root: ${location}`);
  return path;
}
async function requireFreshRoot(path: string): Promise<void> {
  try { await mkdir(path, { recursive: false, mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TypeError(`repository root must be fresh: ${path}`); throw error; }
}
async function exclusiveWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function reopenArtifact(repositoryRoot: string, path: string): Promise<Artifact> {
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) throw new TypeError(`invalid repository artifact path: ${path}`);
  const canonicalRoot = await realpath(repositoryRoot);
  const canonicalFile = await realpath(resolve(repositoryRoot, path));
  if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(`${canonicalRoot}/`)) throw new TypeError(`repository artifact path escapes root: ${path}`);
  const bytes = await readFile(canonicalFile);
  return Object.freeze({ path, sha256: hashRawBytes(bytes), byte_count: bytes.byteLength });
}

function replaceWorkspacePayload(html: Uint8Array, payload: unknown): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(html);
  const encoded = canonicalJson(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const matches = [...text.matchAll(/(<script\b[^>]*id=["']questionnaire-workspace-payload["'][^>]*>)([\s\S]*?)(<\/script>)/gi)].filter((match) => {
    try { JSON.parse(match[2]!.trim()); return true; } catch { return false; }
  });
  if (matches.length !== 1) throw new TypeError("workspace HTML must contain exactly one canonical payload");
  const match = matches[0]!;
  const start = match.index! + match[1]!.length;
  const end = start + match[2]!.length;
  return Buffer.from(`${text.slice(0, start)}${encoded}${text.slice(end)}`, "utf8");
}


/** Produces the immutable genesis → accepted-answer → final-review lineage used by browser-facing fixture evidence. */
function materializeAuthoringPassLineage(input: unknown): readonly [IdeationState, IdeationState, IdeationState, IdeationState] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("fixture must be an object");
  const fixture = input as Record<string, unknown>;
  if (Object.keys(fixture).length !== 1 || !("state" in fixture)) throw new TypeError("fixture must contain only state");
  const rawState = fixture.state as Record<string, unknown>;
  const genesis = validateIdeationState({
    ...rawState,
    revision: 1,
    predecessor_sha256: null,
    revision_kind: "non-answer",
    interview_exchanges: [],
    readiness: { ...(rawState.readiness as Record<string, unknown>), status: "draft" },
    final_document_review: { schema: IDEATION_FINAL_REVIEW_SCHEMA, episodes: [], current_episode: null, rounds: [], current_round: null },
  });
  const firstAnswer = validateIdeationState({
    ...genesis,
    revision: 2,
    predecessor_sha256: ideationStateSha256(genesis),
    revision_kind: "accepted-answer",
    title: `${genesis.title} — clarified scope`,
    interview_exchanges: [{ id: "Q1", exact_question: "What scope must the authoring evidence cover?", accepted_answer: "Cover the production state, support dossier, candidate, response, publication, and handoff lifecycle.", supersedes_exchange_id: null, affected_targets: [{ target_type: "state-field", field: "title" }], evidence_ids: [genesis.evidence[0]!.id] }],
  });
  const secondAnswer = validateIdeationState({
    ...firstAnswer,
    revision: 3,
    predecessor_sha256: ideationStateSha256(firstAnswer),
    revision_kind: "accepted-answer",
    title: `${genesis.title} — complete lifecycle evidence`,
    interview_exchanges: [...firstAnswer.interview_exchanges, { id: "Q2", exact_question: "Which scope statement remains current after lifecycle review?", accepted_answer: "The complete lifecycle evidence scope replaces the earlier clarified scope statement.", supersedes_exchange_id: "Q1", affected_targets: [{ target_type: "state-field", field: "title" }], evidence_ids: [genesis.evidence[0]!.id] }],
  });
  const reviewBase = validateIdeationState({ ...secondAnswer, revision: 4, predecessor_sha256: ideationStateSha256(secondAnswer), revision_kind: "non-answer" });
  const subjectSha256 = ideationReviewSubjectSha256(reviewBase);
  const reviewers = [
    ["reviewer-correctness", "correctness", "correctness", "semantics"],
    ["reviewer-security", "security", "security", "threat-model"],
    ["reviewer-simplicity", "simplicity-maintainability", "maintainability", "simplicity"],
    ["reviewer-alignment", "alignment", "alignment", "workflow"],
  ].map(([reviewer_id, assignment_role, primary_domain, secondary_domain]) => ({ reviewer_id, assignment_role, selector: "pi/slow", model: "pi/slow", provider: "cliproxy", blind: true, assignment_kind: "baseline", primary_domain, secondary_domains: [secondary_domain], artifact_access: ["candidate-html", "markdown", "state"], shared_invariant_ids: ["I1", "I2"], specialist_trigger: null }));
  const results = reviewers.map((reviewer) => {
    const provisional = { reviewer_id: reviewer.reviewer_id, assignment_role: reviewer.assignment_role, selector: reviewer.selector, model: reviewer.model, provider: reviewer.provider, review_subject_sha256: subjectSha256, result_path: "", result_sha256: "0".repeat(64), completed_at: "2026-08-12T12:00:00.000Z", verdict: "PASS", assessed_criteria_ids: [reviewBase.criteria[0]!.id], assessed_invariant_ids: ["I1", "I2"], findings: [], dissent: [], limitations: [] };
    const result_sha256 = hashRawBytes(Buffer.from(canonicalJson(finalDocumentReviewResultEvidence(provisional as unknown as FinalDocumentReviewResult)), "utf8"));
    return { ...provisional, result_sha256, result_path: ideationReviewResultPath(reviewBase.slug, result_sha256) };
  }).sort((left, right) => left.reviewer_id.localeCompare(right.reviewer_id));
  const finalState = validateIdeationState({
    ...reviewBase,
    readiness: { ...reviewBase.readiness, status: "ready-for-approval" },
    final_document_review: {
      schema: IDEATION_FINAL_REVIEW_SCHEMA,
      episodes: [{ episode: 1, first_round: 1, semantic_revision: reviewBase.revision, subject_sha256: subjectSha256, predecessor_episode_sha256: null, predecessor_state_sha256: null, predecessor_candidate_record_path: null, predecessor_candidate_record_sha256: null, predecessor_response_record_path: null, predecessor_response_record_sha256: null, predecessor_import_current_candidate_sha256: null }],
      current_episode: 1,
      rounds: [{ round: 1, subject: { subject_id: "authoring-subject-1", semantic_revision: reviewBase.revision, subject_sha256: subjectSha256, predecessor_subject_sha256: null }, mandatory_invariant_ids: ["I1", "I2"], reviewers, results }],
      current_round: 1,
    },
  });
  return Object.freeze([genesis, firstAnswer, secondAnswer, finalState]);
}

/** Produces valid immutable review evidence from the closed semantic fixture; persistence remains production-owned. */
export function materializeAuthoringPassState(input: unknown): IdeationState {
  return materializeAuthoringPassLineage(input)[3];
}

export async function createAuthoringFixture(input: AuthoringFixtureArguments): Promise<Record<string, unknown>> {
  await requireFreshRoot(input.repositoryRoot);
  const fixturePath = resolve(input.implementationRoot, input.fixture);
  const fixtureRelative = repositoryRelative("/workspace", fixturePath);
  const fixtureBytes = await readFile(fixturePath);
  const lineage = materializeAuthoringPassLineage(JSON.parse(new TextDecoder().decode(fixtureBytes)));
  const state = lineage[3];
  for (const revision of lineage.slice(0, 3)) await persistIdeationState({ repository_root: input.repositoryRoot, state: revision });
  await persistIdeationSubstantiveReviewResults({ repository_root: input.repositoryRoot, state });
  const persistedState = await persistIdeationState({ repository_root: input.repositoryRoot, state });

  // Historical support remains a separately issued, immutable evidence artifact.
  const support = await createIdeationSupportDossier({ repository_root: input.repositoryRoot, state_snapshot_path: persistedState.state_snapshot_path, trigger: "explicit-request", implementation_root: input.implementationRoot });
  await reopenIdeationSupportDossier({ repository_root: input.repositoryRoot, record_path: support.record_path, implementation_root: input.implementationRoot });

  const candidate = await createIdeationCandidateFromSavedState({ repository_root: input.repositoryRoot, state_path: persistedState.state_path, submitted_at: input.submittedAt });
  const candidateRecord = JSON.parse(await readFile(resolve(input.repositoryRoot, candidate.candidate_record_path), "utf8")) as { candidate?: unknown; renderer_manifest?: unknown; projection_manifest?: unknown };
  if (candidateRecord.candidate === undefined || candidateRecord.renderer_manifest === undefined || candidateRecord.projection_manifest === undefined) throw new TypeError("production candidate record has invalid closed binding");
  const candidateBinding = candidateRecord.candidate as CandidateBinding;
  if (candidateBinding.files[0] === undefined) throw new TypeError("production candidate has no Markdown file");
  const candidateHtml = await readFile(resolve(input.repositoryRoot, candidate.candidate_html_path), "utf8");
  const markdown = renderIdeationMarkdown(state);
  if (hashRawBytes(markdown) !== candidateBinding.files[0].sha256) throw new TypeError("production candidate Markdown binding mismatch");
  const files = [{ path: candidateBinding.files[0].path, bytes: markdown }];
  const draft = createApprovalResponse({ candidate: candidateBinding, approval_status: "draft", approval_actor: "user", submitted_at: input.submittedAt, approved_at: null, feedback: [], files });
  const returned = createApprovalResponse({ candidate: candidateBinding, approval_status: "changes-requested", approval_actor: "user", submitted_at: input.submittedAt, approved_at: null, feedback: [{ feedback_id: "feedback-0001", kind: "edit", target: { target_type: "semantic-id", semantic_id: "D1" }, requested_change: "Clarify the decision before approval.", rationale: "The current decision needs a precise boundary.", evidence_ids: [] }, { feedback_id: "feedback-0002", kind: "edit", target: { target_type: "semantic-id", semantic_id: "C1" }, requested_change: "Clarify the evidence binding before approval.", rationale: "The evidence boundary needs an explicit statement.", evidence_ids: [] }], files });
  const savedReturnedResponsePath = "saved-returned-response.html";
  const savedReturnedResponse = candidateHtml.replace(encodeProtectedApprovalPayload(draft), encodeProtectedApprovalPayload(returned));
  if (savedReturnedResponse === candidateHtml) throw new TypeError("production candidate lacks draft protected payload");
  await exclusiveWrite(resolve(input.repositoryRoot, savedReturnedResponsePath), Buffer.from(savedReturnedResponse, "utf8"));
  const returnedResponse = await importIdeationResponseFromSavedPath({ repository_root: input.repositoryRoot, candidate_record_path: candidate.candidate_record_path, saved_html_path: savedReturnedResponsePath });
  const approval = createApprovalResponse({ candidate: candidateBinding, approval_status: "approved", approval_actor: "user", submitted_at: input.submittedAt, approved_at: input.submittedAt, feedback: [], files });
  const savedResponsePath = "saved-approved-response.html";
  const savedResponse = candidateHtml.replace(encodeProtectedApprovalPayload(draft), encodeProtectedApprovalPayload(approval));
  await exclusiveWrite(resolve(input.repositoryRoot, savedResponsePath), Buffer.from(savedResponse, "utf8"));
  const response = await importIdeationResponseFromSavedPath({ repository_root: input.repositoryRoot, candidate_record_path: candidate.candidate_record_path, saved_html_path: savedResponsePath });

  const savedEvidencePath = (evidenceId: string): string => `ai_docs/ideation/.${state.slug}.questionnaire-saved-${evidenceId}.json`;
  const supportRenderer = await loadIdeationSupportRendererSnapshot(input.implementationRoot);
  const templateBytes = supportRenderer.template_bytes;
  const stylesheetBytes = supportRenderer.stylesheet_bytes;
  const issued = await issueInitialWorkspace({ repository_root: input.repositoryRoot, state_snapshot_path: persistedState.state_snapshot_path, implementation_root: input.implementationRoot, response_record_path: returnedResponse.response_record_path });
  const initialHtml = renderIdeationQuestionnaireWorkspaceHtml(issued.workspace, templateBytes, stylesheetBytes);
  const initialPayload = { ...issued.workspace, workspace_revision: issued.workspace.workspace_revision + 1, response_items: issued.workspace.response_items.map((item, index) => index === 0 ? { ...item, answer_text: `${item.answer_text} — first workspace edit` } : item), navigation_state: { active_view: "workspace", scroll_anchor: issued.workspace.selected_occurrence_id } };
  const beforeHash = hashRawBytes(await readFile(resolve(input.repositoryRoot, persistedState.state_path)));
  const initialEditedHtml = replaceWorkspacePayload(initialHtml, initialPayload);
  const initialSave = await saveQuestionnaireWorkspace({ repository_root: input.repositoryRoot, workspace_html: initialEditedHtml });
  if (initialSave.outcome !== "saved") throw new TypeError("initial questionnaire workspace save did not replace the stable path");
  const reopenedInitial = await reopenQuestionnaireWorkspace({ repository_root: input.repositoryRoot, slug: state.slug });
  const overwritePayload = { ...reopenedInitial.workspace, workspace_revision: reopenedInitial.workspace.workspace_revision + 1, response_items: reopenedInitial.workspace.response_items.map((item, index) => index === 0 ? { ...item, answer_text: `${item.answer_text} — overwrite` } : item) };
  const overwriteHtml = replaceWorkspacePayload(await readFile(resolve(input.repositoryRoot, reopenedInitial.workspace_path)), overwritePayload);
  const overwriteSave = await saveQuestionnaireWorkspace({ repository_root: input.repositoryRoot, workspace_html: overwriteHtml });
  if (overwriteSave.outcome !== "saved") throw new TypeError("workspace overwrite did not advance the stable path");
  const reopenedOverwrite = await reopenQuestionnaireWorkspace({ repository_root: input.repositoryRoot, slug: state.slug });
  const unchangedBytes = await readFile(resolve(input.repositoryRoot, reopenedOverwrite.workspace_path));
  const unchangedSave = await saveQuestionnaireWorkspace({ repository_root: input.repositoryRoot, workspace_html: unchangedBytes });
  if (unchangedSave.outcome !== "adopted-identical") throw new TypeError("unchanged workspace save was not idempotent");
  const protectedTamperPayload = { ...reopenedOverwrite.workspace, response_items: reopenedOverwrite.workspace.response_items.map((item, index) => index === 0 ? { ...item, occurrence_id: `${item.occurrence_id}-tampered` } : item) };
  const protectedTamperHtml = replaceWorkspacePayload(unchangedBytes, protectedTamperPayload);
  const stableBeforeTamper = await readFile(resolve(input.repositoryRoot, reopenedOverwrite.workspace_path));
  let tamperRejected = false;
  try { await saveQuestionnaireWorkspace({ repository_root: input.repositoryRoot, workspace_html: protectedTamperHtml }); } catch { tamperRejected = true; }
  if (!tamperRejected) throw new TypeError("protected workspace tamper was accepted");
  const stableAfterTamper = await readFile(resolve(input.repositoryRoot, reopenedOverwrite.workspace_path));
  if (Buffer.compare(stableBeforeTamper, stableAfterTamper) !== 0) throw new TypeError("protected workspace tamper changed stable bytes");
  const imported = await importQuestionnaireWorkspace({ repository_root: input.repositoryRoot, workspace_path: reopenedOverwrite.workspace_path });
  const rebase = await issueRebaseWorkspace({ repository_root: input.repositoryRoot, workspace: reopenedOverwrite.workspace, prior_saved_workspace_evidence_record_path: savedEvidencePath(overwriteSave.evidence.evidence_id), prior_checkpoint_record_path: issued.checkpoint_record_path, current_checkpoint_record_path: imported.continuation_checkpoint_record_path, decisions: [] });
  const rebaseHtml = replaceWorkspacePayload(await readFile(resolve(input.repositoryRoot, reopenedOverwrite.workspace_path)), rebase.workspace);
  const rebaseSave = await saveQuestionnaireWorkspace({ repository_root: input.repositoryRoot, workspace_html: rebaseHtml });
  const rebaseImported = await importQuestionnaireWorkspace({ repository_root: input.repositoryRoot, workspace_path: rebaseSave.workspace_path });
  const afterHash = hashRawBytes(await readFile(resolve(input.repositoryRoot, persistedState.state_path)));
  if (afterHash !== beforeHash) throw new TypeError("questionnaire workspace actions mutated canonical state");

  const publication = await publishIdeationMarkdownFromSavedRecords({ repository_root: input.repositoryRoot, candidate_record_path: candidate.candidate_record_path, response_record_path: response.response_record_path });
  const handoff = await createDeepScopeHandoffFromSavedAuthority({ repository_root: input.repositoryRoot, slug: state.slug });
  const reconciled = await reconcileCurrentIdeationStateAuthority(input.repositoryRoot, state.slug);
  const projection = await loadIdeationProjectionSnapshot(input.implementationRoot);
  if (canonicalJson(projection.manifest) !== canonicalJson(candidateRecord.projection_manifest)) throw new TypeError("production candidate projection manifest did not reopen exactly");
  const initialEvidence = await reopenArtifact(input.repositoryRoot, savedEvidencePath(initialSave.evidence.evidence_id));
  const overwriteEvidence = await reopenArtifact(input.repositoryRoot, savedEvidencePath(overwriteSave.evidence.evidence_id));
  const baseline = await reopenArtifact(input.repositoryRoot, issued.baseline_record_path);
  const checkpoint = await reopenArtifact(input.repositoryRoot, issued.checkpoint_record_path);
  const issuance = await reopenArtifact(input.repositoryRoot, issued.workspace_issuance_record_path);
  const importedEvidence = await reopenArtifact(input.repositoryRoot, imported.admitted_response_record_path);
  const continuationCheckpoint = await reopenArtifact(input.repositoryRoot, imported.continuation_checkpoint_record_path);
  const continuationIssuance = await reopenArtifact(input.repositoryRoot, imported.continuation_issuance_record_path);
  const rebaseIssuance = await reopenArtifact(input.repositoryRoot, rebase.workspace_issuance_record_path);
  const rebaseImportedEvidence = await reopenArtifact(input.repositoryRoot, rebaseImported.admitted_response_record_path);
  const sourceResponseRecord = await reopenArtifact(input.repositoryRoot, returnedResponse.response_record_path);
  const stateArtifacts = [await reopenArtifact(input.repositoryRoot, persistedState.state_path), await reopenArtifact(input.repositoryRoot, persistedState.state_snapshot_path)];
  const supportArtifacts = [await reopenArtifact(input.repositoryRoot, support.record_path), await reopenArtifact(input.repositoryRoot, support.html_path)];
  const candidateArtifacts = await Promise.all([candidate.submission_record_path, candidate.current_candidate_path, candidate.candidate_record_path, candidate.candidate_html_path, response.response_record_path, response.approved_html_evidence_path, ideationMarkdownPath(state.slug), ideationReceiptPath(state.slug), handoff.substantive_review_authority.path].map(path => reopenArtifact(input.repositoryRoot, path)));
  const workspaceArtifact = await reopenArtifact(input.repositoryRoot, reopenedOverwrite.workspace_path);
  const allArtifacts = [...stateArtifacts, ...supportArtifacts, ...candidateArtifacts, sourceResponseRecord, baseline, checkpoint, issuance, initialEvidence, overwriteEvidence, importedEvidence, continuationCheckpoint, continuationIssuance, rebaseIssuance, rebaseImportedEvidence, workspaceArtifact];
  const manifest = Object.freeze({
    schema: IDEATION_AUTHORING_ARTIFACT_MANIFEST_SCHEMA,
    fixture: Object.freeze({ path: fixtureRelative, sha256: hashRawBytes(fixtureBytes), byte_count: fixtureBytes.byteLength }),
    state: Object.freeze({ current: stateArtifacts[0], snapshot: stateArtifacts[1], sha256: ideationStateSha256(state) }),
    support: Object.freeze({ record: supportArtifacts[0], html: supportArtifacts[1], identity_sha256: support.support_identity_sha256 }),
    workspace: Object.freeze({ path: workspaceArtifact, workspace_id: issued.workspace.workspace_id, baseline_id: issued.workspace.baseline_id, checkpoint_id: issued.workspace.checkpoint_id, workspace_issuance_id: issued.workspace.workspace_issuance_id, baseline_record: baseline, checkpoint_record: checkpoint, workspace_issuance_record: issuance, source_response_record: sourceResponseRecord, initial_saved_workspace_evidence: initialEvidence, overwritten_saved_workspace_evidence: overwriteEvidence, unchanged_save: Object.freeze({ outcome: unchangedSave.outcome, evidence_sha256: unchangedSave.evidence.evidence_id, workspace_sha256: hashRawBytes(unchangedBytes) }), admitted_response_record: importedEvidence, continuation_checkpoint_record: continuationCheckpoint, continuation_issuance_record: continuationIssuance, rebase_workspace_issuance_record: rebaseIssuance, rebase_admitted_response_record: rebaseImportedEvidence, rebase_imported: rebaseImported.imported_response_head_sha256 === rebaseImported.admitted_response_record_sha256, canonical_before_sha256: beforeHash, canonical_after_sha256: afterHash, initial_workspace_sha256: hashRawBytes(initialEditedHtml), overwritten_workspace_sha256: hashRawBytes(overwriteHtml), unchanged_workspace_sha256: hashRawBytes(unchangedBytes), protected_tamper_rejected: tamperRejected }),
    candidate: Object.freeze({ submission: candidateArtifacts[0], current: candidateArtifacts[1], record: candidateArtifacts[2], html: candidateArtifacts[3], candidate_sha256: candidate.candidate_sha256, response: candidateArtifacts[4], approved_html: candidateArtifacts[5], publication_markdown: candidateArtifacts[6], publication_receipt: candidateArtifacts[7], substantive_review_authority: candidateArtifacts[8], handoff }),
    renderer: Object.freeze({ final_renderer_sha256: hashCanonicalJson(candidateRecord.renderer_manifest), ideation_projection_sha256: hashCanonicalJson(candidateRecord.projection_manifest), support_renderer_sha256: supportRenderer.sha256 }),
    protected: Object.freeze({ markdown_sha256: candidateBinding.files[0]!.sha256, bundle_sha256: candidateBinding.bundle_sha256, visual_sha256: candidateBinding.visual_set_sha256, runtime_sha256: candidateBinding.runtime_sha256, receipt_sha256: publication.receipt.receipt_sha256, reconciled_state_sha256: reconciled.state_sha256 }),
    command_version: "ideation-authoring-fixture/v3",
    artifact_byte_counts: Object.freeze(Object.fromEntries(allArtifacts.map(entry => [entry.path, entry.byte_count]))),
  });
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  await exclusiveWrite(input.artifactManifest, manifestBytes);
  const reopened = await readFile(input.artifactManifest);
  if (Buffer.compare(reopened, manifestBytes) !== 0) throw new TypeError("artifact manifest did not reopen exactly");
  return manifest;
}

if (import.meta.main) process.stdout.write(`${canonicalJson(await createAuthoringFixture(parseAuthoringFixtureArguments(process.argv)))}\n`);
