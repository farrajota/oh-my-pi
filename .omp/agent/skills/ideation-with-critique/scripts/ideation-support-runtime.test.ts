import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson, hashCanonicalJson, hashRawBytes } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { type ApprovalResponse, validateCandidateBinding } from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import { encodeProtectedApprovalPayload } from "../../approval-dossier-runtime/scripts/approval-dossier-html.ts";
import { createApprovalResponse } from "../../approval-dossier-runtime/scripts/approval-dossier-runtime.ts";
import { IDEATION_FINAL_REVIEW_SCHEMA, deriveChangedExchangeTargets, finalDocumentReviewEpisodeSha256, ideationReviewSubjectSha256, ideationStateSha256, validateIdeationState } from "../schemas/ideation-state.ts";
import { applyQuestionnaireCorrectionTransition, importIdeationResponseFromSavedPath, persistIdeationState, reconcileCurrentIdeationStateAuthority } from "./ideation-runtime.ts";
import { createAuthoringFixture } from "./ideation-authoring-fixture.ts";
import {
  createIdeationSupportDossier,
  deriveQuestionnaireOccurrenceId,
  ideationSupportRuntimeHooks,
  loadIdeationSupportRendererSnapshot,
  importQuestionnaireWorkspace,
  issueInitialWorkspace,
  parseQuestionnaireResponseItem,
  parseWorkspaceIssuanceRecord,
  issueRebaseWorkspace,
  reopenIdeationSupportDossier,
  reopenQuestionnaireWorkspace,
  saveQuestionnaireWorkspace,
} from "./ideation-support-runtime.ts";


const implementationRoot = dirname(dirname(dirname(dirname(dirname(import.meta.dir)))));
const fixture = ".omp/agent/skills/ideation-with-critique/fixtures/authoring-review-v8.json";
const hash = "a".repeat(64);
function replaceQuestionnairePayload(html: string, payload: unknown): string {
  const encoded = canonicalJson(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return html.replace(/(<script\b[^>]*type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/, (all, open, content, close) => content.includes("ideation-questionnaire/workspace/v1") ? `${open}${encoded}${close}` : all);
}

describe("Ideation support dossier runtime", () => {
  test("rejects renderer closures that resolve outside the implementation root", async () => {
    const root = await mkdtemp(join(tmpdir(), "support-renderer-symlink-"));
    try {
      await symlink(join(implementationRoot, ".omp"), join(root, ".omp"), "dir");
      await expect(loadIdeationSupportRendererSnapshot(root)).rejects.toThrow("path escape");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("creates and reopens an explicit current support dossier with escaped read-only content", async () => {
    const root = await mkdtemp(join(tmpdir(), "support-runtime-"));
    const runtime = join(root, "runtime");
    try {
      const manifest = await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: join(root, "manifest.json") });
      const supportBinding = manifest.support;
      const stateBinding = manifest.state;
      if (supportBinding === undefined || stateBinding === undefined || typeof supportBinding !== "object" || supportBinding === null || typeof stateBinding !== "object" || stateBinding === null || !("record" in supportBinding) || !("snapshot" in stateBinding)) throw new TypeError("fixture manifest is incomplete");
      const supportRecord = supportBinding.record;
      const stateSnapshot = stateBinding.snapshot;
      if (typeof supportRecord !== "object" || supportRecord === null || !("path" in supportRecord) || typeof supportRecord.path !== "string" || typeof stateSnapshot !== "object" || stateSnapshot === null || !("path" in stateSnapshot) || typeof stateSnapshot.path !== "string") throw new TypeError("fixture manifest bindings are invalid");
      const reopened = await reopenIdeationSupportDossier({ repository_root: runtime, record_path: supportRecord.path, implementation_root: implementationRoot });
      expect(reopened.outcome).toMatch(/created|adopted-identical/);
      expect((await readFile(join(runtime, reopened.html_path), "utf8")).toLowerCase()).toContain("support");
      const duplicate = await createIdeationSupportDossier({ repository_root: runtime, state_snapshot_path: stateSnapshot.path, trigger: "explicit-request", implementation_root: implementationRoot });
      expect(duplicate.outcome).toBe("adopted-identical");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("rejects noncanonical paths, invalid triggers, and tampered support bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "support-runtime-"));
    const runtime = join(root, "runtime");
    try {
      const manifest = await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: join(root, "manifest.json") });
      const stateBinding = manifest.state;
      const candidateBinding = manifest.candidate;
      const supportBinding = manifest.support;
      if (stateBinding === undefined || candidateBinding === undefined || supportBinding === undefined || typeof stateBinding !== "object" || stateBinding === null || typeof candidateBinding !== "object" || candidateBinding === null || typeof supportBinding !== "object" || supportBinding === null || !("snapshot" in stateBinding) || !("response" in candidateBinding) || !("html" in supportBinding) || !("record" in supportBinding)) throw new TypeError("fixture manifest is incomplete");
      const stateSnapshot = stateBinding.snapshot;
      const responseBinding = candidateBinding.response;
      const supportHtml = supportBinding.html;
      const supportRecord = supportBinding.record;
      if (typeof stateSnapshot !== "object" || stateSnapshot === null || !("path" in stateSnapshot) || typeof stateSnapshot.path !== "string" || typeof responseBinding !== "object" || responseBinding === null || !("path" in responseBinding) || typeof responseBinding.path !== "string" || typeof supportHtml !== "object" || supportHtml === null || !("path" in supportHtml) || typeof supportHtml.path !== "string" || typeof supportRecord !== "object" || supportRecord === null || !("path" in supportRecord) || typeof supportRecord.path !== "string") throw new TypeError("fixture manifest bindings are invalid");
      const response: unknown = JSON.parse(await readFile(join(runtime, responseBinding.path), "utf8"));
      if (typeof response !== "object" || response === null || !("approval" in response) || typeof response.approval !== "object" || response.approval === null || !("approval_status" in response.approval)) throw new TypeError("fixture response is invalid");
      expect(response.approval.approval_status).toBe("approved");
      await expect(createIdeationSupportDossier({ repository_root: runtime, state_snapshot_path: stateSnapshot.path, trigger: "returned-changes", implementation_root: implementationRoot })).rejects.toThrow("ineligible trigger");
      await expect(reopenIdeationSupportDossier({ repository_root: runtime, record_path: "ai_docs/ideation/not-a-support.json", implementation_root: implementationRoot })).rejects.toThrow();
      await writeFile(join(runtime, supportHtml.path), "<script>tampered</script>");
      await expect(reopenIdeationSupportDossier({ repository_root: runtime, record_path: supportRecord.path, implementation_root: implementationRoot })).rejects.toThrow("html mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  test("hashes every transitive support dependency and rejects dependency-policy drift", async () => {
    const snapshot = await loadIdeationSupportRendererSnapshot(implementationRoot);
    const paths = snapshot.manifest.entries.map(entry => entry.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain(".omp/agent/skills/ideation-with-critique/schemas/ideation-state.ts");
    expect(paths).not.toContain(".omp/agent/skills/ideation-with-critique/scripts/ideation-support-runtime.ts");
    expect(paths).toContain(".omp/agent/skills/approval-dossier-runtime/scripts/canonical-json.ts");
    expect(paths).toContain(".omp/agent/skills/approval-dossier-runtime/schemas/approval-dossier.ts");
    expect(paths).toContain(".omp/agent/skills/approval-dossier-runtime/scripts/content-safety.ts");
    expect(paths).toContain(".omp/agent/skills/ideation-with-critique/templates/ideation-support-reference.html");
    expect(snapshot.manifest.entries.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    expect((await loadIdeationSupportRendererSnapshot(implementationRoot)).sha256).toBe(snapshot.sha256);

    const root = await mkdtemp(join(tmpdir(), "support-dependencies-"));
    try {
      for (const entry of snapshot.manifest.entries) {
        const destination = join(root, entry.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(join(implementationRoot, entry.path)));
      }
      for (const entry of snapshot.manifest.entries) {
        const destination = join(root, entry.path);
        const original = await readFile(destination, "utf8");
        await writeFile(destination, `${original}\n// dependency identity mutation\n`);
        expect((await loadIdeationSupportRendererSnapshot(root)).sha256).not.toBe(snapshot.sha256);
        await writeFile(destination, original);
      }
      const projector = join(root, ".omp/agent/skills/ideation-with-critique/scripts/ideation-support-projector.ts");
      const original = await readFile(projector, "utf8");
      await writeFile(projector, `${original}\nconst forbiddenClock = Date.now();\n`);
      await expect(loadIdeationSupportRendererSnapshot(root)).rejects.toThrow("clock use");
      await writeFile(projector, `${original}\nimport { readFile } from "node:fs/promises";\n`);
      await expect(loadIdeationSupportRendererSnapshot(root)).rejects.toThrow("filesystem use");
      await writeFile(projector, `${original}\nimport \"undeclared-package\";\n`);
      await expect(loadIdeationSupportRendererSnapshot(root)).rejects.toThrow("undeclared import");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("loads every canonical ancestor for create and reopen and rejects tampered or missing lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "support-predecessor-"));
    const runtime = join(root, "runtime");
    try {
      const rawFixture: unknown = JSON.parse(await readFile(join(implementationRoot, fixture), "utf8"));
      if (rawFixture === null || typeof rawFixture !== "object" || !("state" in rawFixture)) throw new TypeError("fixture state is missing");
      const genesis = validateIdeationState(rawFixture.state);
      const genesisSha256 = ideationStateSha256(genesis);
      const revision2WithoutExchange = validateIdeationState({
        ...genesis,
        revision: 2,
        predecessor_sha256: genesisSha256,
        revision_kind: "non-answer",
        title: `${genesis.title} successor`,
        readiness: { ...genesis.readiness, bounded_ambiguities: [] },
        review_item_presentations: genesis.review_item_presentations
          .filter((presentation) => presentation.semantic_id !== "U1")
          .map((presentation) => ({
            ...presentation,
            dependency_semantic_ids: presentation.dependency_semantic_ids.filter((semanticId) => semanticId !== "U1"),
          })),
        interview_exchanges: [],
      });
      const revision2ChangedTargets = deriveChangedExchangeTargets(genesis, revision2WithoutExchange);
      const revision2 = validateIdeationState({
        ...revision2WithoutExchange,
        revision_kind: "accepted-answer",
        interview_exchanges: [{
          id: "Q1",
          exact_question: "What changed?",
          accepted_answer: "The successor records the accepted answer.",
          supersedes_exchange_id: null,
          affected_targets: revision2ChangedTargets,
          evidence_ids: [genesis.evidence[0]!.id],
        }],
      });
      const revision2Sha256 = ideationStateSha256(revision2);
      const revision3 = validateIdeationState({
        ...revision2,
        revision: 3,
        predecessor_sha256: revision2Sha256,
        revision_kind: "non-answer",
      });
      await mkdir(runtime, { recursive: true });
      await persistIdeationState({ repository_root: runtime, state: genesis });
      await persistIdeationState({ repository_root: runtime, state: revision2 });
      const persistedRevision3 = await persistIdeationState({ repository_root: runtime, state: revision3 });
      const created = await createIdeationSupportDossier({ repository_root: runtime, state_snapshot_path: persistedRevision3.state_snapshot_path, trigger: "explicit-request", implementation_root: implementationRoot });
      const createdHtml = await readFile(join(runtime, created.html_path), "utf8");
      expect(createdHtml).toContain('data-semantic-id="U1"');
      const reopened = await reopenIdeationSupportDossier({ repository_root: runtime, record_path: created.record_path, implementation_root: implementationRoot });
      expect(await readFile(join(runtime, created.html_path), "utf8")).toBe(await readFile(join(runtime, reopened.html_path), "utf8"));

      const genesisPath = join(runtime, "ai_docs/ideation", `.${genesis.slug}.state-${genesisSha256}.json`);
      const genesisBytes = await readFile(genesisPath);
      await writeFile(genesisPath, "tampered");
      await expect(reopenIdeationSupportDossier({ repository_root: runtime, record_path: created.record_path, implementation_root: implementationRoot })).rejects.toThrow();
      await writeFile(genesisPath, genesisBytes);
      const revision2Path = join(runtime, "ai_docs/ideation", `.${genesis.slug}.state-${revision2Sha256}.json`);
      await rm(revision2Path);
      await expect(createIdeationSupportDossier({ repository_root: runtime, state_snapshot_path: persistedRevision3.state_snapshot_path, trigger: "explicit-request", implementation_root: implementationRoot })).rejects.toThrow();
      await expect(reopenIdeationSupportDossier({ repository_root: runtime, record_path: created.record_path, implementation_root: implementationRoot })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("admits material support only for each real immediate accepted-answer commitment delta", async () => {
    const root = await mkdtemp(join(tmpdir(), "support-trigger-"));
    const rawFixture: unknown = JSON.parse(await readFile(join(implementationRoot, fixture), "utf8"));
    if (rawFixture === null || typeof rawFixture !== "object" || !("state" in rawFixture)) throw new TypeError("fixture state is missing");
    const genesis = validateIdeationState(rawFixture.state);
    const materialFields = ["commitment-level", "goal", "criteria", "scope-in", "scope-non-goal", "scope-deferred"] as const;
    const changedState = (field: (typeof materialFields)[number]) => {
      const changed = field === "commitment-level"
        ? { ...genesis, commitment_level: "building" as const }
        : field === "goal"
          ? { ...genesis, goal: { ...genesis.goal, statement: `${genesis.goal.statement} with a fixed commitment` } }
          : field === "criteria"
            ? { ...genesis, criteria: genesis.criteria.map((criterion) => ({ ...criterion, threshold: `${criterion.threshold} with a fixed commitment` })) }
            : field === "scope-in"
              ? { ...genesis, scope: { ...genesis.scope, in_scope: [...genesis.scope.in_scope, "A fixed commitment boundary"].sort() } }
              : field === "scope-non-goal"
                ? { ...genesis, scope: { ...genesis.scope, non_goals: [...genesis.scope.non_goals, "An excluded commitment boundary"].sort() } }
                : { ...genesis, scope: { ...genesis.scope, deferred: [...genesis.scope.deferred, "A deferred commitment boundary"].sort() } };
      const affectedTargets = deriveChangedExchangeTargets(genesis, changed);
      return validateIdeationState({ ...changed, revision: 2, predecessor_sha256: ideationStateSha256(genesis), revision_kind: "accepted-answer", interview_exchanges: [{ id: "Q1", exact_question: "What commitment changed?", accepted_answer: "The accepted answer changes the bounded commitment.", supersedes_exchange_id: null, affected_targets: affectedTargets, evidence_ids: [genesis.evidence[0]!.id] }] });
    };
    try {
      for (const field of materialFields) {
        const runtime = join(root, field);
        await mkdir(runtime, { recursive: true });
        await persistIdeationState({ repository_root: runtime, state: genesis });
        const accepted = await persistIdeationState({ repository_root: runtime, state: changedState(field) });
        await expect(createIdeationSupportDossier({ repository_root: runtime, state_snapshot_path: accepted.state_snapshot_path, trigger: "material-commitment-change", implementation_root: implementationRoot })).resolves.toBeDefined();
      }
      const titleOnlyRoot = join(root, "title-only");
      await mkdir(titleOnlyRoot, { recursive: true });
      const titleOnly = validateIdeationState({ ...genesis, revision: 2, predecessor_sha256: ideationStateSha256(genesis), revision_kind: "accepted-answer", title: `${genesis.title} only`, interview_exchanges: [{ id: "Q1", exact_question: "What title changed?", accepted_answer: "Only the title changed.", supersedes_exchange_id: null, affected_targets: [{ target_type: "state-field", field: "title" }], evidence_ids: [genesis.evidence[0]!.id] }] });
      await persistIdeationState({ repository_root: titleOnlyRoot, state: genesis });
      const persistedTitleOnly = await persistIdeationState({ repository_root: titleOnlyRoot, state: titleOnly });
      await expect(createIdeationSupportDossier({ repository_root: titleOnlyRoot, state_snapshot_path: persistedTitleOnly.state_snapshot_path, trigger: "material-commitment-change", implementation_root: implementationRoot })).rejects.toThrow("ineligible trigger:material-commitment-change");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("requires the derived current final-review gate rather than an episode alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "support-trigger-"));
    const rawFixture: unknown = JSON.parse(await readFile(join(implementationRoot, fixture), "utf8"));
    if (rawFixture === null || typeof rawFixture !== "object" || !("state" in rawFixture)) throw new TypeError("fixture state is missing");
    const genesis = validateIdeationState(rawFixture.state);
    const reviewBase = validateIdeationState({ ...genesis, revision: 2, predecessor_sha256: ideationStateSha256(genesis), revision_kind: "non-answer" });
    const subjectSha256 = ideationReviewSubjectSha256(reviewBase);
    const reviewers = [["reviewer-correctness", "correctness", "correctness", "semantics"], ["reviewer-security", "security", "security", "threat-model"], ["reviewer-simplicity", "simplicity-maintainability", "maintainability", "simplicity"], ["reviewer-alignment", "alignment", "alignment", "workflow"]].map(([reviewer_id, assignment_role, primary_domain, secondary_domain]) => ({ reviewer_id, assignment_role, selector: "pi/slow", model: "pi/slow", provider: "cliproxy", blind: true, assignment_kind: "baseline", primary_domain, secondary_domains: [secondary_domain], artifact_access: ["candidate-html", "markdown", "state"], shared_invariant_ids: ["I1", "I2"], specialist_trigger: null }));
    const incomplete = validateIdeationState({ ...reviewBase, final_document_review: { schema: IDEATION_FINAL_REVIEW_SCHEMA, episodes: [{ episode: 1, first_round: 1, semantic_revision: reviewBase.revision, subject_sha256: subjectSha256, predecessor_episode_sha256: null, predecessor_state_sha256: null, predecessor_candidate_record_path: null, predecessor_candidate_record_sha256: null, predecessor_response_record_path: null, predecessor_response_record_sha256: null, predecessor_import_current_candidate_sha256: null }], current_episode: 1, rounds: [{ round: 1, subject: { subject_id: "incomplete-subject", semantic_revision: reviewBase.revision, subject_sha256: subjectSha256, predecessor_subject_sha256: null }, mandatory_invariant_ids: ["I1", "I2"], reviewers, results: [] }], current_round: 1 } });
    try {
      await persistIdeationState({ repository_root: root, state: genesis });
      const persistedIncomplete = await persistIdeationState({ repository_root: root, state: incomplete });
      await expect(createIdeationSupportDossier({ repository_root: root, state_snapshot_path: persistedIncomplete.state_snapshot_path, trigger: "final-review-boundary", implementation_root: implementationRoot })).rejects.toThrow("ineligible trigger:final-review-boundary");
      const acceptedRoot = join(root, "opened-gate");
      const manifest = await createAuthoringFixture({ repositoryRoot: acceptedRoot, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: join(root, "manifest.json") });
      const stateBinding = manifest.state;
      if (stateBinding === undefined || typeof stateBinding !== "object" || stateBinding === null || !("snapshot" in stateBinding) || stateBinding.snapshot === null || typeof stateBinding.snapshot !== "object" || !("path" in stateBinding.snapshot) || typeof stateBinding.snapshot.path !== "string") throw new TypeError("fixture snapshot is invalid");
      await expect(createIdeationSupportDossier({ repository_root: acceptedRoot, state_snapshot_path: stateBinding.snapshot.path, trigger: "final-review-boundary", implementation_root: implementationRoot })).resolves.toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);
  test("rejects closed-key and protected occurrence tuple violations", () => {
    const occurrence_id = deriveQuestionnaireOccurrenceId({ response_record_path: "ai_docs/ideation/.authoring.response.json", response_record_sha256: hash, feedback_id: "feedback-1", target: "{\"semantic_id\":\"D1\"}" });
    const item = { occurrence_id, feedback_id: "feedback-1", target: "{\"semantic_id\":\"D1\"}", response_record_path: "ai_docs/ideation/.authoring.response.json", response_record_sha256: hash, answer_text: "answer", validation: "valid", defer_status: "not-deferred", defer_reason: null, rationale: "because", selected_option: null, context_requests: [], evidence_references: [], notebook_content: "" };
    expect(parseQuestionnaireResponseItem(item)).toMatchObject(item);
    expect(() => parseQuestionnaireResponseItem({ ...item, extra: true })).toThrow("missing or extra");
    expect(() => parseQuestionnaireResponseItem({ ...item, feedback_id: "substituted" })).toThrow("identity mismatch");
    expect(() => parseQuestionnaireResponseItem({ ...item, occurrence_id: item.occurrence_id.slice(1) })).toThrow("identity mismatch");
  });

  test("accepts a closed reconciled manual-merge issuance and rejects unresolved drafts", () => {
    const issuance = { schema: "ideation-questionnaire/issuance/v1", issuance_id: hash, dossier_id: "authoring-review", issuance_kind: "rebase", baseline_record_path: `ai_docs/ideation/.authoring-review.questionnaire-baseline-${hash}.json`, baseline_record_sha256: hash, checkpoint_record_path: `ai_docs/ideation/.authoring-review.questionnaire-checkpoint-${hash}.json`, checkpoint_record_sha256: hash, prior_saved_workspace_evidence_record_path: `ai_docs/ideation/.authoring-review.questionnaire-saved-${hash}.json`, prior_saved_workspace_evidence_record_sha256: hash, prior_checkpoint_record_path: `ai_docs/ideation/.authoring-review.questionnaire-checkpoint-${hash}.json`, prior_checkpoint_record_sha256: hash, compared_current_imported_response_sha256: hash, authenticated_ancestry: [{ record_path: `ai_docs/ideation/.authoring-review.questionnaire-admitted-response-${hash}.json`, record_sha256: hash }], decisions: [{ question_id: "feedback-1", prior_item_sha256: null, current_item_sha256: hash, disposition: "manual-merge" }], reconciled: true, issued_at: "1970-01-01T00:00:00.000Z" };
    expect(parseWorkspaceIssuanceRecord(issuance).issuance_kind).toBe("rebase");
    expect(() => parseWorkspaceIssuanceRecord({ ...issuance, reconciled: false })).toThrow("unresolved");
    expect(() => parseWorkspaceIssuanceRecord({ ...issuance, decisions: [...issuance.decisions, { question_id: "feedback-1", prior_item_sha256: null, current_item_sha256: hash, disposition: "discard-local" }] })).toThrow("unresolved");
  });
  test("parses every closed rebase disposition without accepting unresolved mixes", () => {
    const dispositions = ["keep-current", "discard-local", "carry-local", "manual-merge"] as const;
    const issuance = { schema: "ideation-questionnaire/issuance/v1", issuance_id: hash, dossier_id: "authoring-review", issuance_kind: "rebase", baseline_record_path: `ai_docs/ideation/.authoring-review.questionnaire-baseline-${hash}.json`, baseline_record_sha256: hash, checkpoint_record_path: `ai_docs/ideation/.authoring-review.questionnaire-checkpoint-${hash}.json`, checkpoint_record_sha256: hash, prior_saved_workspace_evidence_record_path: `ai_docs/ideation/.authoring-review.questionnaire-saved-${hash}.json`, prior_saved_workspace_evidence_record_sha256: hash, prior_checkpoint_record_path: `ai_docs/ideation/.authoring-review.questionnaire-checkpoint-${hash}.json`, prior_checkpoint_record_sha256: hash, compared_current_imported_response_sha256: hash, authenticated_ancestry: [{ record_path: `ai_docs/ideation/.authoring-review.questionnaire-admitted-response-${hash}.json`, record_sha256: hash }], decisions: [{ question_id: "feedback-1", prior_item_sha256: null, current_item_sha256: hash, disposition: "keep-current" }, { question_id: "feedback-2", prior_item_sha256: hash, current_item_sha256: null, disposition: "discard-local" }, { question_id: "feedback-3", prior_item_sha256: hash, current_item_sha256: hash, disposition: "carry-local" }, { question_id: "feedback-4", prior_item_sha256: hash, current_item_sha256: hash, disposition: "manual-merge" }], reconciled: true, issued_at: "1970-01-01T00:00:00.000Z" };
    expect(parseWorkspaceIssuanceRecord(issuance).decisions.map((decision) => decision.disposition)).toEqual(dispositions);
    expect(() => parseWorkspaceIssuanceRecord({ ...issuance, decisions: [...issuance.decisions, { ...issuance.decisions[0], question_id: "feedback-1" }] })).toThrow("unresolved");
  });

  test("keeps rebase question identity stable across revised response occurrences", () => {
    const priorId = deriveQuestionnaireOccurrenceId({ response_record_path: "ai_docs/ideation/.prior.response.json", response_record_sha256: hash, feedback_id: "feedback-stable", target: "{\"semantic_id\":\"D1\"}" });
    const currentHash = "b".repeat(64);
    const currentId = deriveQuestionnaireOccurrenceId({ response_record_path: "ai_docs/ideation/.current.response.json", response_record_sha256: currentHash, feedback_id: "feedback-stable", target: "{\"semantic_id\":\"D1\"}" });
    expect(priorId).not.toBe(currentId);
    expect({ question_id: "feedback-stable", prior_item_sha256: hashCanonicalJson({ occurrence_id: priorId }), current_item_sha256: hashCanonicalJson({ occurrence_id: currentId }), disposition: "carry-local" }).toMatchObject({ question_id: "feedback-stable", disposition: "carry-local" });
  });

  test("enforces inventory and same-base workspace CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "questionnaire-cas-"));
    const runtime = join(root, "runtime");
    const manifestPath = join(root, "manifest.json");
    try {
      await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { state: { snapshot: { path: string } }; workspace: { source_response_record: { path: string } } };
      await issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: manifest.workspace.source_response_record.path });
      const reopened = await reopenQuestionnaireWorkspace({ repository_root: runtime, slug: "authoring-review" });
      const stable = await readFile(join(runtime, reopened.workspace_path), "utf8");
      const revise = (response_items: unknown) => replaceQuestionnairePayload(stable, { ...reopened.workspace, workspace_revision: reopened.workspace.workspace_revision + 1, response_items });
      await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: revise([...reopened.workspace.response_items].reverse()) })).rejects.toThrow("inventory");
      await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: revise([]) })).rejects.toThrow("inventory");
      await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: revise(reopened.workspace.response_items.map((item) => ({ ...item, response_record_sha256: hash }))) })).rejects.toThrow("identity mismatch");
      const sameBase = revise(reopened.workspace.response_items.map((item) => ({ ...item, answer_text: `${item.answer_text} CAS` })));
      const competingSameBase = revise(reopened.workspace.response_items.map((item) => ({ ...item, answer_text: `${item.answer_text} competing CAS` })));
      expect((await saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: sameBase })).outcome).toBe("saved");
      await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: competingSameBase })).rejects.toThrow("CAS");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25_000);

  test("allows exactly one same-checkpoint import winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "questionnaire-import-race-"));
    const runtime = join(root, "runtime");
    const manifestPath = join(root, "manifest.json");
    const importedHeadPath = "ai_docs/ideation/.authoring-review.questionnaire-imported-response-head.json";
    try {
      await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { state: { current: { path: string }; snapshot: { path: string } }; workspace: { source_response_record: { path: string } } };
      const issued = await issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: manifest.workspace.source_response_record.path });
      const canonicalStateBytes = await readFile(join(runtime, manifest.state.current.path));
      const attempts = await Promise.allSettled([
        importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path }),
        importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path }),
      ]);
      const fulfilled = attempts.filter((result) => result.status === "fulfilled");
      const rejected = attempts.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "QUESTIONNAIRE_CAS_CONFLICT" });
      const headAfterRace = await readFile(join(runtime, importedHeadPath));
      await expect(importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path })).rejects.toMatchObject({ code: "QUESTIONNAIRE_CAS_CONFLICT" });
      expect(await readFile(join(runtime, importedHeadPath))).toEqual(headAfterRace);
      expect(await readFile(join(runtime, manifest.state.current.path))).toEqual(canonicalStateBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("rejects stale saves after import and workspace reissue", async () => {
    const root = await mkdtemp(join(tmpdir(), "questionnaire-authority-cas-"));
    const runtime = join(root, "runtime");
    const manifestPath = join(root, "manifest.json");
    try {
      await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { state: { snapshot: { path: string } }; workspace: { source_response_record: { path: string } } };
      const issue = () => issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: manifest.workspace.source_response_record.path });
      const first = await issue();
      const firstHtml = await readFile(join(runtime, first.workspace_path), "utf8");
      const staleDraft = replaceQuestionnairePayload(firstHtml, { ...first.workspace, workspace_revision: first.workspace.workspace_revision + 1, response_items: first.workspace.response_items.map((item) => ({ ...item, answer_text: `${item.answer_text} stale` })) });
      await importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: first.workspace_path });
      await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: firstHtml })).rejects.toThrow("checkpoint is stale");
      await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: staleDraft })).rejects.toThrow("checkpoint is stale");
      expect(await readFile(join(runtime, first.workspace_path), "utf8")).toBe(firstHtml);
      const second = await issue();
      expect(second.workspace.workspace_issuance_record_sha256).not.toBe(first.workspace.workspace_issuance_record_sha256);
      await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: staleDraft })).rejects.toThrow("checkpoint is stale");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  test("issues reconciled rebases for every real two-item authority difference", async () => {
    const root = await mkdtemp(join(tmpdir(), "questionnaire-rebase-authority-"));
    type MutableResponse = {
      answer_text: string;
      validation: "unvalidated" | "valid" | "invalid";
      defer_status: "not-deferred" | "deferred";
      defer_reason: string | null;
    };
    type RebaseDecision = {
      question_id: string;
      prior_item_sha256: string | null;
      current_item_sha256: string | null;
      disposition: "keep-current" | "discard-local" | "carry-local" | "manual-merge";
    };
    const setup = async (name: string, priorFeedback: "full" | "empty", currentFeedback: "full" | "empty", priorValues: readonly MutableResponse[], currentValues: readonly MutableResponse[]) => {
      const runtime = join(root, name);
      const manifestPath = join(root, `${name}.manifest.json`);
      await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        state: { snapshot: { path: string } };
        workspace: { source_response_record: { path: string } };
      };
      const originalRecord = JSON.parse(await readFile(join(runtime, manifest.workspace.source_response_record.path), "utf8")) as {
        candidate_record_path: string;
        response_html_path: string;
        approval: ApprovalResponse;
      };
      const candidateRecord = JSON.parse(await readFile(join(runtime, originalRecord.candidate_record_path), "utf8")) as { candidate: unknown };
      const candidate = validateCandidateBinding(candidateRecord.candidate);
      const responseHtml = await readFile(join(runtime, originalRecord.response_html_path), "utf8");
      const authorityPath = async (feedback: "full" | "empty") => {
        if (feedback === "full") return manifest.workspace.source_response_record.path;
        const approval = createApprovalResponse({
          candidate,
          approval_status: "rejected",
          approval_actor: "user",
          submitted_at: "2026-08-12T12:01:00.000Z",
          approved_at: null,
          feedback: [],
          files: await Promise.all(candidate.files.map(async (file) => ({ path: file.path, bytes: await readFile(join(runtime, file.path)) }))),
        });
        const savedPath = `ai_docs/ideation/${name}-empty-response.html`;
        const savedHtml = responseHtml.replace(encodeProtectedApprovalPayload(originalRecord.approval), encodeProtectedApprovalPayload(approval));
        if (savedHtml === responseHtml) throw new TypeError("failed to replace returned response payload");
        await writeFile(join(runtime, savedPath), savedHtml);
        return (await importIdeationResponseFromSavedPath({ repository_root: runtime, candidate_record_path: originalRecord.candidate_record_path, saved_html_path: savedPath })).response_record_path;
      };
      const admit = async (feedback: "full" | "empty", values: readonly MutableResponse[]) => {
        const issued = await issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: await authorityPath(feedback) });
        expect(issued.workspace.response_items).toHaveLength(values.length);
        const html = await readFile(join(runtime, issued.workspace_path), "utf8");
        const response_items = issued.workspace.response_items.map((item, index) => ({ ...item, ...values[index]! }));
        const saved = await saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: replaceQuestionnairePayload(html, { ...issued.workspace, workspace_revision: issued.workspace.workspace_revision + 1, response_items }) });
        const imported = await importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path });
        return { saved, imported };
      };
      const prior = await admit(priorFeedback, priorValues);
      const current = await admit(currentFeedback, currentValues);
      await writeFile(join(runtime, `ai_docs/ideation/${prior.saved.workspace.dossier_id}/questionnaire.html`), await readFile(join(runtime, prior.saved.evidence.workspace_snapshot_path)));
      const decision = (question_id: string, disposition: RebaseDecision["disposition"]): RebaseDecision => {
        const priorItem = prior.saved.workspace.response_items.find((item) => item.feedback_id === question_id);
        const currentItem = current.saved.workspace.response_items.find((item) => item.feedback_id === question_id);
        return { question_id, prior_item_sha256: priorItem === undefined ? null : hashCanonicalJson(priorItem), current_item_sha256: currentItem === undefined ? null : hashCanonicalJson(currentItem), disposition };
      };
      const rebase = (workspace: typeof prior.saved.workspace, decisions: RebaseDecision[]) => issueRebaseWorkspace({ repository_root: runtime, workspace, prior_saved_workspace_evidence_record_path: `ai_docs/ideation/.${workspace.dossier_id}.questionnaire-saved-${prior.saved.evidence.evidence_id}.json`, prior_checkpoint_record_path: prior.saved.workspace.checkpoint_record_path, current_checkpoint_record_path: current.imported.continuation_checkpoint_record_path, decisions });
      return { runtime, prior, current, decision, rebase };
    };
    try {
      const priorOnly = await setup("prior-only", "full", "empty", [
        { answer_text: "Discard this prior-only local answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
        { answer_text: "Discard this second prior-only answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
      ], []);
      const discardDecisions = priorOnly.prior.saved.workspace.response_items.map((item) => priorOnly.decision(item.feedback_id, "discard-local")).sort((left, right) => left.question_id.localeCompare(right.question_id));
      expect(discardDecisions.every((item) => item.prior_item_sha256 !== null && item.current_item_sha256 === null)).toBe(true);
      expect(discardDecisions.map((item) => item.prior_item_sha256)).toEqual([...priorOnly.prior.saved.workspace.response_items].sort((left, right) => left.feedback_id.localeCompare(right.feedback_id)).map((item) => hashCanonicalJson(item)));
      const discarded = await priorOnly.rebase(priorOnly.prior.saved.workspace, discardDecisions);
      expect(discarded.workspace.response_items).toEqual([]);

      const currentOnly = await setup("current-only", "empty", "full", [], [
        { answer_text: "Keep this current-only admitted answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
        { answer_text: "Keep this second current-only answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
      ]);
      const currentOnlyItem = currentOnly.current.saved.workspace.response_items[0]!;
      const keepCurrentOnlyDecisions = currentOnly.current.saved.workspace.response_items.map((item) => currentOnly.decision(item.feedback_id, "keep-current")).sort((left, right) => left.question_id.localeCompare(right.question_id));
      expect(keepCurrentOnlyDecisions.every((item) => item.prior_item_sha256 === null && item.current_item_sha256 !== null)).toBe(true);
      expect(keepCurrentOnlyDecisions.map((item) => item.current_item_sha256)).toEqual([...currentOnly.current.saved.workspace.response_items].sort((left, right) => left.feedback_id.localeCompare(right.feedback_id)).map((item) => hashCanonicalJson(item)));
      const keptCurrentOnly = await currentOnly.rebase(currentOnly.prior.saved.workspace, keepCurrentOnlyDecisions);
      expect(keptCurrentOnly.workspace.response_items[0]).toMatchObject({ occurrence_id: currentOnlyItem.occurrence_id, answer_text: "Keep this current-only admitted answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null });

      const carry = await setup("changed-and-unchanged", "full", "full", [
        { answer_text: "Carry this local answer.", validation: "invalid", defer_status: "not-deferred", defer_reason: null },
        { answer_text: "Semantically unchanged answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
      ], [
        { answer_text: "Current admitted replacement.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
        { answer_text: "Semantically unchanged answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
      ]);
      const changedPrior = carry.prior.saved.workspace.response_items[0]!;
      const changedCurrent = carry.current.saved.workspace.response_items[0]!;
      const unchangedCurrent = carry.current.saved.workspace.response_items[1]!;
      expect(hashCanonicalJson(carry.prior.saved.workspace.response_items[1]!)).toBe(hashCanonicalJson(unchangedCurrent));
      const carryDecision = carry.decision(changedCurrent.feedback_id, "carry-local");
      const navigationOccurrence = carry.prior.saved.workspace.response_items.find((item) => item.occurrence_id !== carry.prior.saved.workspace.selected_occurrence_id)!.occurrence_id;
      expect(navigationOccurrence).not.toBe(carry.prior.saved.workspace.selected_occurrence_id);
      const navigationOnlyDraft = { ...carry.prior.saved.workspace, selected_occurrence_id: navigationOccurrence };
      const carried = await carry.rebase(navigationOnlyDraft, [carryDecision]);
      expect(carried.issuance.decisions).toEqual([carryDecision]);
      expect(carried.workspace.response_items.find((item) => item.feedback_id === changedCurrent.feedback_id)).toMatchObject({ occurrence_id: changedCurrent.occurrence_id, answer_text: changedPrior.answer_text, validation: "invalid", defer_status: "not-deferred", defer_reason: null });
      expect(carried.workspace.response_items.find((item) => item.feedback_id === unchangedCurrent.feedback_id)).toMatchObject({ occurrence_id: unchangedCurrent.occurrence_id, answer_text: "Semantically unchanged answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null });

      const manual = await setup("manual-and-current", "full", "full", [
        { answer_text: "Prior answer awaiting reconciliation.", validation: "invalid", defer_status: "not-deferred", defer_reason: null },
        { answer_text: "Prior answer to discard.", validation: "invalid", defer_status: "not-deferred", defer_reason: null },
      ], [
        { answer_text: "Current answer awaiting reconciliation.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
        { answer_text: "Authoritative current answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null },
      ]);
      const manualCurrent = manual.current.saved.workspace.response_items[0]!;
      const keepCurrent = manual.current.saved.workspace.response_items[1]!;
      const manualDraft = {
        ...manual.prior.saved.workspace,
        response_items: manual.prior.saved.workspace.response_items.map((item) => item.feedback_id === manualCurrent.feedback_id
          ? { ...item, answer_text: "Manually merged prior and current answer.", validation: "valid" as const, defer_status: "deferred" as const, defer_reason: "Awaiting merged-answer evidence." }
          : item),
      };
      const decisions = [manual.decision(manualCurrent.feedback_id, "manual-merge"), manual.decision(keepCurrent.feedback_id, "keep-current")].sort((left, right) => left.question_id.localeCompare(right.question_id));
      expect(decisions).toEqual([...decisions].sort((left, right) => left.question_id.localeCompare(right.question_id)));
      await expect(manual.rebase(manualDraft, decisions.slice(1))).rejects.toThrow(/incomplete|missing.*decision/i);
      const forgedHash = decisions[0]!.prior_item_sha256 === hash ? "b".repeat(64) : hash;
      await expect(manual.rebase(manualDraft, decisions.map((item, index) => index === 0 ? { ...item, prior_item_sha256: forgedHash } : item))).rejects.toThrow(/forged|hash|decision/i);
      const reconciled = await manual.rebase(manualDraft, decisions);
      expect(reconciled.issuance.issuance_kind).toBe("rebase");
      expect(reconciled.issuance.decisions).toEqual(decisions);
      expect(reconciled.workspace.response_items.find((item) => item.feedback_id === manualCurrent.feedback_id)).toMatchObject({ answer_text: "Manually merged prior and current answer.", validation: "valid", defer_status: "deferred", defer_reason: "Awaiting merged-answer evidence." });
      expect(reconciled.workspace.response_items.find((item) => item.feedback_id === keepCurrent.feedback_id)).toMatchObject({ occurrence_id: keepCurrent.occurrence_id, answer_text: "Authoritative current answer.", validation: "valid", defer_status: "not-deferred", defer_reason: null });
      const priorHtml = await readFile(join(manual.runtime, `ai_docs/ideation/${reconciled.workspace.dossier_id}/questionnaire.html`), "utf8");
      await saveQuestionnaireWorkspace({ repository_root: manual.runtime, workspace_html: replaceQuestionnairePayload(priorHtml, reconciled.workspace) });
      const reopened = await reopenQuestionnaireWorkspace({ repository_root: manual.runtime, slug: "authoring-review" });
      expect(reopened.workspace.workspace_issuance_record_sha256).toBe(reconciled.workspace.workspace_issuance_record_sha256);
      expect(reopened.workspace.checkpoint_record_sha256).toBe(reconciled.workspace.checkpoint_record_sha256);
      expect(reopened.workspace.baseline_record_sha256).toBe(reconciled.workspace.baseline_record_sha256);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  test("adopts the exact staged import authorities when only the imported-response head is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "questionnaire-import-recovery-"));
    const runtime = join(root, "runtime");
    const manifestPath = join(root, "manifest.json");
    const importedHeadPath = "ai_docs/ideation/.authoring-review.questionnaire-imported-response-head.json";
    try {
      await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { state: { current: { path: string }; snapshot: { path: string } }; workspace: { source_response_record: { path: string } } };
      const first = await issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: manifest.workspace.source_response_record.path });
      const predecessor = await importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: first.workspace_path });
      const issued = await issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: manifest.workspace.source_response_record.path });
      expect(issued.checkpoint.base_imported_response_sha256).toBe(predecessor.imported_response_head_sha256);
      expect(issued.workspace.response_items).toHaveLength(2);
      const html = await readFile(join(runtime, issued.workspace_path), "utf8");
      const response_items = issued.workspace.response_items.map((item, index) => ({ ...item, answer_text: `Deterministic recovered answer ${index + 1}.`, validation: "valid" as const, defer_status: "not-deferred" as const, defer_reason: null }));
      await saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: replaceQuestionnairePayload(html, { ...issued.workspace, workspace_revision: issued.workspace.workspace_revision + 1, response_items }) });
      const canonicalStateBytes = await readFile(join(runtime, manifest.state.current.path));
      const staged = await importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path });
      expect(await readFile(join(runtime, manifest.state.current.path))).toEqual(canonicalStateBytes);
      const stagedPaths = [staged.admitted_response_record_path, staged.continuation_checkpoint_record_path, staged.continuation_issuance_record_path];
      const stagedHashes = [staged.admitted_response_record_sha256, staged.continuation_checkpoint_record_sha256, staged.continuation_issuance_record_sha256];
      const stagedBytes = await Promise.all(stagedPaths.map((path) => readFile(join(runtime, path))));
      expect(stagedBytes.map((bytes) => hashRawBytes(bytes))).toEqual(stagedHashes);
      const stagedHeadBytes = await readFile(join(runtime, importedHeadPath));
      const authorityInventory = (await readdir(join(runtime, "ai_docs/ideation"))).filter((name) => name.includes(".questionnaire-admitted-") || name.includes(".questionnaire-checkpoint-") || name.includes(".questionnaire-issuance-")).sort();

      await rm(join(runtime, importedHeadPath));
      const genuineCheckpoint = JSON.parse(stagedBytes[1]!.toString("utf8")) as Record<string, unknown>;
      const { checkpoint_id: _checkpointId, ...genuineCheckpointRest } = genuineCheckpoint;
      const forgedCheckpointRest = { ...genuineCheckpointRest, issued_at: "1970-01-01T00:00:00.001Z" };
      const forgedCheckpoint = { ...forgedCheckpointRest, checkpoint_id: hashCanonicalJson(forgedCheckpointRest) };
      const forgedCheckpointPath = `ai_docs/ideation/.authoring-review.questionnaire-checkpoint-${forgedCheckpoint.checkpoint_id}.json`;
      const forgedCheckpointBytes = Buffer.from(canonicalJson(forgedCheckpoint));
      await writeFile(join(runtime, forgedCheckpointPath), forgedCheckpointBytes);
      const genuineIssuance = JSON.parse(stagedBytes[2]!.toString("utf8")) as Record<string, unknown>;
      const { issuance_id: _issuanceId, ...genuineIssuanceRest } = genuineIssuance;
      const forgedIssuanceRest = { ...genuineIssuanceRest, checkpoint_record_path: forgedCheckpointPath, checkpoint_record_sha256: hashRawBytes(forgedCheckpointBytes), issued_at: "1970-01-01T00:00:00.001Z" };
      const forgedIssuance = { ...forgedIssuanceRest, issuance_id: hashCanonicalJson(forgedIssuanceRest) };
      const forgedIssuancePath = `ai_docs/ideation/.authoring-review.questionnaire-issuance-${forgedIssuance.issuance_id}.json`;
      await writeFile(join(runtime, forgedIssuancePath), canonicalJson(forgedIssuance));
      await rm(join(runtime, staged.continuation_checkpoint_record_path));
      await rm(join(runtime, staged.continuation_issuance_record_path));
      await expect(importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path })).rejects.toThrow();
      await expect(readFile(join(runtime, importedHeadPath))).rejects.toThrow();
      expect(await readFile(join(runtime, manifest.state.current.path))).toEqual(canonicalStateBytes);
      await rm(join(runtime, forgedCheckpointPath));
      await rm(join(runtime, forgedIssuancePath));
      await writeFile(join(runtime, staged.continuation_checkpoint_record_path), stagedBytes[1]!);
      await writeFile(join(runtime, staged.continuation_issuance_record_path), stagedBytes[2]!);
      const recovered = await importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path });
      expect([recovered.admitted_response_record_path, recovered.continuation_checkpoint_record_path, recovered.continuation_issuance_record_path]).toEqual(stagedPaths);
      expect([recovered.admitted_response_record_sha256, recovered.continuation_checkpoint_record_sha256, recovered.continuation_issuance_record_sha256]).toEqual(stagedHashes);
      expect(recovered.continuation_checkpoint).toEqual(staged.continuation_checkpoint);
      expect(recovered.continuation_issuance).toEqual(staged.continuation_issuance);
      expect(recovered.imported_response_head_sha256).toBe(staged.imported_response_head_sha256);
      expect(await Promise.all(stagedPaths.map((path) => readFile(join(runtime, path))))).toEqual(stagedBytes);
      expect(await readFile(join(runtime, importedHeadPath))).toEqual(stagedHeadBytes);
      expect((await readdir(join(runtime, "ai_docs/ideation"))).filter((name) => name.includes(".questionnaire-admitted-") || name.includes(".questionnaire-checkpoint-") || name.includes(".questionnaire-issuance-")).sort()).toEqual(authorityInventory);
      expect(await readFile(join(runtime, manifest.state.current.path))).toEqual(canonicalStateBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);


  test("serializes initial issuance reconciliation and applies only an exact valid non-deferred correction", async () => {
    const root = await mkdtemp(join(tmpdir(), "questionnaire-correction-"));
    type FixtureManifest = { state: { current: { path: string }; snapshot: { path: string } }; workspace: { source_response_record: { path: string } } };
    const createImportedCase = async (name: "valid" | "invalid" | "deferred") => {
      const runtime = join(root, name);
      const manifestPath = join(root, `${name}.manifest.json`);
      await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
      if (name === "valid") {
        const copiedResponsePath = "ai_docs/ideation/copied-questionnaire-response.json";
        await writeFile(join(runtime, copiedResponsePath), await readFile(join(runtime, manifest.workspace.source_response_record.path)));
        await expect(issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: copiedResponsePath })).rejects.toThrow("record path mismatch");
      }
      const issued = await issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: manifest.workspace.source_response_record.path });
      expect(issued.workspace.response_items).toHaveLength(2);
      const html = await readFile(join(runtime, issued.workspace_path), "utf8");
      const response_items = issued.workspace.response_items.map((item, index) => {
        if (index === 1) return { ...item, answer_text: "Valid answer for a different semantic target.", validation: "valid" as const, defer_status: "not-deferred" as const, defer_reason: null };
        if (name === "invalid") return { ...item, answer_text: "Invalid admitted D1 answer.", validation: "invalid" as const, defer_status: "not-deferred" as const, defer_reason: null };
        if (name === "deferred") return { ...item, answer_text: "Deferred admitted D1 answer.", validation: "valid" as const, defer_status: "deferred" as const, defer_reason: "Awaiting required supporting evidence." };
        return { ...item, answer_text: "Apply the exact admitted D1 questionnaire correction.", validation: "valid" as const, defer_status: "not-deferred" as const, defer_reason: null };
      });
      await saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: replaceQuestionnairePayload(html, { ...issued.workspace, workspace_revision: issued.workspace.workspace_revision + 1, response_items }) });
      const imported = await importQuestionnaireWorkspace({ repository_root: runtime, workspace_path: issued.workspace_path });
      return { runtime, manifest, response_items, imported };
    };
    const buildSuccessor = async (runtime: string, manifest: FixtureManifest, answer: string, unrelatedSemanticId?: string) => {
      const current = validateIdeationState(JSON.parse(await readFile(join(runtime, manifest.state.current.path))));
      const reviewItemPresentations = current.review_item_presentations.map((item) => item.semantic_id === "D1" || item.semantic_id === unrelatedSemanticId ? { ...item, purpose: `${item.purpose} Exact questionnaire correction.` } : item);
      const successorBase = { ...current, revision: current.revision + 1, predecessor_sha256: ideationStateSha256(current), revision_kind: "accepted-answer" as const, review_item_presentations: reviewItemPresentations, readiness: { ...current.readiness, status: "draft" as const } };
      const affectedTargets = deriveChangedExchangeTargets(current, successorBase as typeof current);
      const withExchange = { ...successorBase, interview_exchanges: [...current.interview_exchanges, { id: `Q${current.interview_exchanges.length + 1}`, exact_question: "Apply this admitted questionnaire correction?", accepted_answer: answer, supersedes_exchange_id: null, affected_targets: affectedTargets, evidence_ids: [current.evidence[0]!.id] }] };
      const previousRound = current.final_document_review.rounds.at(-1)!;
      const reviewSubjectState = validateIdeationState({ ...withExchange, final_document_review: { schema: IDEATION_FINAL_REVIEW_SCHEMA, episodes: [], current_episode: null, rounds: [], current_round: null } });
      const returnedResponseBytes = await readFile(join(runtime, manifest.workspace.source_response_record.path));
      const returnedResponseRecord = JSON.parse(returnedResponseBytes.toString("utf8")) as { candidate_record_path: string; current_candidate_at_import_sha256: string };
      const appendedRound = { ...previousRound, round: previousRound.round + 1, subject: { ...previousRound.subject, subject_id: `review-subject-${previousRound.round + 1}`, semantic_revision: withExchange.revision, subject_sha256: ideationReviewSubjectSha256(reviewSubjectState), predecessor_subject_sha256: previousRound.subject.subject_sha256 }, results: [] };
      const appendedEpisode = { episode: current.final_document_review.episodes.length + 1, first_round: appendedRound.round, semantic_revision: withExchange.revision, subject_sha256: appendedRound.subject.subject_sha256, predecessor_episode_sha256: finalDocumentReviewEpisodeSha256(current.final_document_review, current.final_document_review.current_episode!), predecessor_state_sha256: ideationStateSha256(current), predecessor_candidate_record_path: returnedResponseRecord.candidate_record_path, predecessor_candidate_record_sha256: hashRawBytes(await readFile(join(runtime, returnedResponseRecord.candidate_record_path))), predecessor_response_record_path: manifest.workspace.source_response_record.path, predecessor_response_record_sha256: hashRawBytes(returnedResponseBytes), predecessor_import_current_candidate_sha256: returnedResponseRecord.current_candidate_at_import_sha256 };
      return validateIdeationState({ ...withExchange, final_document_review: { schema: IDEATION_FINAL_REVIEW_SCHEMA, episodes: [...current.final_document_review.episodes, appendedEpisode], current_episode: appendedEpisode.episode, rounds: [...current.final_document_review.rounds, appendedRound], current_round: appendedRound.round } });
    };
    try {
      const preLockRuntime = join(root, "initial-issuance-pre-lock");
      const preLockManifestPath = join(root, "initial-issuance-pre-lock.manifest.json");
      await createAuthoringFixture({ repositoryRoot: preLockRuntime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: preLockManifestPath });
      const preLockManifest = JSON.parse(await readFile(preLockManifestPath, "utf8")) as FixtureManifest;
      const preLockSuccessor = await buildSuccessor(preLockRuntime, preLockManifest, "Advance canonical authority before initial questionnaire issuance.");
      const questionnaireAuthoritiesBefore = (await readdir(join(preLockRuntime, "ai_docs/ideation"))).filter((name) => name.includes(".questionnaire-")).sort();
      const preLockWorkspace = join(preLockRuntime, "ai_docs/ideation/authoring-review/questionnaire.html");
      const preLockWorkspaceBytes = await readFile(preLockWorkspace);
      const previousPreLockHook = ideationSupportRuntimeHooks.before_initial_workspace_lock;
      ideationSupportRuntimeHooks.before_initial_workspace_lock = () => persistIdeationState({ repository_root: preLockRuntime, state: preLockSuccessor });
      try {
        await expect(issueInitialWorkspace({ repository_root: preLockRuntime, state_snapshot_path: preLockManifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: preLockManifest.workspace.source_response_record.path })).rejects.toThrow("current canonical state snapshot");
      } finally {
        ideationSupportRuntimeHooks.before_initial_workspace_lock = previousPreLockHook;
      }
      expect(await readFile(join(preLockRuntime, preLockManifest.state.current.path), "utf8")).toBe(canonicalJson(preLockSuccessor));
      expect((await readdir(join(preLockRuntime, "ai_docs/ideation"))).filter((name) => name.includes(".questionnaire-")).sort()).toEqual(questionnaireAuthoritiesBefore);
      expect(await readFile(preLockWorkspace)).toEqual(preLockWorkspaceBytes);

      const valid = await createImportedCase("valid");
      const selected = valid.response_items[0]!;
      const wrongTarget = valid.response_items[1]!;
      expect(wrongTarget.target).not.toBe(selected.target);
      const selectedSuccessor = await buildSuccessor(valid.runtime, valid.manifest, selected.answer_text);
      const wrongTargetSuccessor = await buildSuccessor(valid.runtime, valid.manifest, wrongTarget.answer_text);
      const canonicalBeforeValidRejections = await readFile(join(valid.runtime, valid.manifest.state.current.path));
      const unrelatedTarget = JSON.parse(wrongTarget.target);
      if (unrelatedTarget === null || typeof unrelatedTarget !== "object" || !("semantic_id" in unrelatedTarget) || typeof unrelatedTarget.semantic_id !== "string") throw new TypeError("expected semantic unrelated target");
      const expandedSuccessor = await buildSuccessor(valid.runtime, valid.manifest, selected.answer_text, unrelatedTarget.semantic_id);
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: valid.runtime, admitted_response_evidence_path: valid.imported.admitted_response_record_path, occurrence_id: selected.occurrence_id, successor: expandedSuccessor })).rejects.toThrow(/target|correction/i);
      expect(await readFile(join(valid.runtime, valid.manifest.state.current.path))).toEqual(canonicalBeforeValidRejections);
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: valid.runtime, admitted_response_evidence_path: valid.imported.admitted_response_record_path, occurrence_id: "f".repeat(64), successor: selectedSuccessor })).rejects.toThrow("not eligible");
      expect(await readFile(join(valid.runtime, valid.manifest.state.current.path))).toEqual(canonicalBeforeValidRejections);
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: valid.runtime, admitted_response_evidence_path: valid.imported.admitted_response_record_path, occurrence_id: wrongTarget.occurrence_id, successor: wrongTargetSuccessor })).rejects.toThrow(/target|eligible|correction/i);
      expect(await readFile(join(valid.runtime, valid.manifest.state.current.path))).toEqual(canonicalBeforeValidRejections);
      const admittedEvidenceBytes = await readFile(join(valid.runtime, valid.imported.admitted_response_record_path));
      await writeFile(join(valid.runtime, valid.imported.admitted_response_record_path), "tampered admitted evidence");
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: valid.runtime, admitted_response_evidence_path: valid.imported.admitted_response_record_path, occurrence_id: selected.occurrence_id, successor: selectedSuccessor })).rejects.toThrow();
      expect(await readFile(join(valid.runtime, valid.manifest.state.current.path))).toEqual(canonicalBeforeValidRejections);
      await writeFile(join(valid.runtime, valid.imported.admitted_response_record_path), admittedEvidenceBytes);
      const persisted = await applyQuestionnaireCorrectionTransition({ repository_root: valid.runtime, admitted_response_evidence_path: valid.imported.admitted_response_record_path, occurrence_id: selected.occurrence_id, successor: selectedSuccessor });
      expect(persisted.state_sha256).toBe(ideationStateSha256(selectedSuccessor));
      expect((await reconcileCurrentIdeationStateAuthority(valid.runtime, selectedSuccessor.slug)).state).toEqual(selectedSuccessor);
      const canonicalAfterTransition = await readFile(join(valid.runtime, valid.manifest.state.current.path));
      const replayBase = { ...selectedSuccessor, revision: selectedSuccessor.revision + 1, predecessor_sha256: ideationStateSha256(selectedSuccessor), review_item_presentations: selectedSuccessor.review_item_presentations.map((item) => item.semantic_id === "D1" ? { ...item, purpose: `${item.purpose} Fresh replay correction.` } : item), readiness: { ...selectedSuccessor.readiness, status: "draft" as const } };
      const replayTargets = deriveChangedExchangeTargets(selectedSuccessor, replayBase as typeof selectedSuccessor);
      const replaySuccessor = validateIdeationState({ ...replayBase, interview_exchanges: [...selectedSuccessor.interview_exchanges, { id: `Q${selectedSuccessor.interview_exchanges.length + 1}`, exact_question: "Reuse the old admitted questionnaire occurrence?", accepted_answer: selected.answer_text, supersedes_exchange_id: null, affected_targets: replayTargets, evidence_ids: [selectedSuccessor.evidence[0]!.id] }], final_document_review: { schema: IDEATION_FINAL_REVIEW_SCHEMA, episodes: [], current_episode: null, rounds: [], current_round: null } });
      expect(replaySuccessor.predecessor_sha256).toBe(ideationStateSha256(selectedSuccessor));
      expect(replaySuccessor.revision).toBe(selectedSuccessor.revision + 1);
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: valid.runtime, admitted_response_evidence_path: valid.imported.admitted_response_record_path, occurrence_id: selected.occurrence_id, successor: replaySuccessor })).rejects.toThrow("questionnaire correction requires the admitted baseline to bind the current predecessor");
      expect(await readFile(join(valid.runtime, valid.manifest.state.current.path))).toEqual(canonicalAfterTransition);
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: valid.runtime, admitted_response_evidence_path: valid.imported.admitted_response_record_path, occurrence_id: selected.occurrence_id, successor: selectedSuccessor })).rejects.toThrow(/stale|predecessor|current/i);
      expect(await readFile(join(valid.runtime, valid.manifest.state.current.path))).toEqual(canonicalAfterTransition);
      await expect(issueInitialWorkspace({ repository_root: valid.runtime, state_snapshot_path: valid.manifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: valid.manifest.workspace.source_response_record.path })).rejects.toThrow(/current canonical|stale|snapshot/i);

      const invalid = await createImportedCase("invalid");
      const invalidItem = invalid.response_items[0]!;
      const invalidSuccessor = await buildSuccessor(invalid.runtime, invalid.manifest, invalidItem.answer_text);
      const canonicalBeforeInvalid = await readFile(join(invalid.runtime, invalid.manifest.state.current.path));
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: invalid.runtime, admitted_response_evidence_path: invalid.imported.admitted_response_record_path, occurrence_id: invalidItem.occurrence_id, successor: invalidSuccessor })).rejects.toThrow("not eligible");
      expect(await readFile(join(invalid.runtime, invalid.manifest.state.current.path))).toEqual(canonicalBeforeInvalid);

      const deferred = await createImportedCase("deferred");
      const deferredItem = deferred.response_items[0]!;
      const deferredSuccessor = await buildSuccessor(deferred.runtime, deferred.manifest, deferredItem.answer_text);
      const canonicalBeforeDeferred = await readFile(join(deferred.runtime, deferred.manifest.state.current.path));
      await expect(applyQuestionnaireCorrectionTransition({ repository_root: deferred.runtime, admitted_response_evidence_path: deferred.imported.admitted_response_record_path, occurrence_id: deferredItem.occurrence_id, successor: deferredSuccessor })).rejects.toThrow("not eligible");
      expect(await readFile(join(deferred.runtime, deferred.manifest.state.current.path))).toEqual(canonicalBeforeDeferred);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 90_000);
});
