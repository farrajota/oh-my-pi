import type { QuestionnaireWorkspacePayload } from "./ideation-support-runtime.ts";
import { renderIdeationQuestionnaireWorkspaceHtml } from "./ideation-support-renderer.ts";
import { describe, expect, test } from "bun:test";
import type { IdeationSupportProjection } from "./ideation-support-projector.ts";
import { renderIdeationSupportHtml } from "./ideation-support-renderer.ts";

function presentationFixture() {
  return {
    semantic_id: "success-metrics",
    purpose: "Choose a measurable success signal <script>alert('x')</script> & keep it honest",
    why_it_matters: "Metrics steer trade-offs and prevent proxy drift",
    system_position: "Decision boundary after outcome definition",
    dependency_semantic_ids: ["goal"],
    key_points: ["Measure the user outcome", "Keep the threshold explicit"],
    research_summary: ["Research token: <evidence>", "Offline synthesis only"],
    options: [
      { option_id: "metric-1", label: "Direct outcome", mechanism_or_output: "Counts the intended outcome", benefit: "Closest to user value", omission_cost_or_uncertainty: "Needs reliable instrumentation", downstream_consequence: "Supports clear iteration", evidence_ids: ["E1"] },
      { option_id: "metric-2", label: "Recommended <two>", mechanism_or_output: "Combines outcome and quality", benefit: "Balances the main trade-off", omission_cost_or_uncertainty: "Adds interpretation work & review", downstream_consequence: "Guides prioritisation", evidence_ids: ["E2", "E3"] },
      { option_id: "metric-3", label: "Proxy signal", mechanism_or_output: "Tracks an observable proxy", benefit: "Fast to collect", omission_cost_or_uncertainty: "May reward the wrong behaviour", downstream_consequence: "Requires guardrails", evidence_ids: ["E4"] },
      { option_id: "metric-4", label: "Qualitative check", mechanism_or_output: "Uses structured interviews", benefit: "Explains why results move", omission_cost_or_uncertainty: "Slower and less comparable", downstream_consequence: "Adds research cycles", evidence_ids: ["E5"] },
    ],
    recommended_option_id: "metric-2",
    recommendation_rationale: "It makes the success-metric trade-off explicit",
    uncertainty: "The threshold still needs validation",
  } as const;
}

test("renders complete semantic support presentations in escaped no-JS markup", () => {
  const presentation = presentationFixture();
  const projection = {
    schema: "ideation-support-renderer/v1",
    artifact_kind: "non-authoritative-support",
    workflow: "ideation",
    slug: "metrics",
    run_id: "run-1",
    revision: 1,
    trigger: "explicit-request",
    title: "Metrics",
    commitment_level: "planning",
    state_sha256: "a".repeat(64),
    interview_ledger_sha256: "b".repeat(64),
    exchanges: [{
      id: "Q10",
      exact_question: "Which success metric trade-off is acceptable?",
      accepted_answer: "Use the bound recommendation.",
      supersedes_exchange_id: null,
      affected_targets: [{ target_type: "semantic-id", semantic_id: "success-metrics" }],
      evidence_ids: ["E1"],
      active: true,
      predecessor_exchange_id: null,
      successor_exchange_id: null,
      ordinal: 10,
      target_labels: ["semantic:success-metrics"],
      evidence_locators: ["offline://E1"],
      target_presentations: [presentation],
      unavailable_target_semantic_ids: [],
    }],
    evidence: [{ id: "E1", locator: "offline://E1", description: "Metric evidence" }],
    provenance: [],
    empty_state: false,
  } as unknown as IdeationSupportProjection;
  const template = new TextEncoder().encode("<html><head><title>__IDEATION_SUPPORT_TITLE__</title><style>__IDEATION_SUPPORT_STYLES__</style></head><body>__IDEATION_SUPPORT_BODY__</body></html>");
  const html = new TextDecoder().decode(renderIdeationSupportHtml(projection, template, new TextEncoder().encode("")));

  expect(html).toContain("Semantic context: success-metrics");
  for (const field of ["Purpose", "Why it matters", "System position", "Key points", "Research summary", "Four options", "Mechanism / output", "Benefit", "Omission / cost / uncertainty", "Downstream consequence", "Evidence IDs", "Bound recommendation", "Recommendation ID", "Recommendation label", "Rationale", "Residual uncertainty"]) expect(html).toContain(field);
  expect((html.match(/class=\"review-option\"/g) ?? []).length).toBe(4);
  expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert('x')</script>");
  expect(html).toContain("Recommendation ID</dt><dd>metric-2");
  expect(html).toContain("Recommendation label</dt><dd>Recommended &lt;two&gt;");
  expect(html).toContain("E2");
  expect(html).toContain("research token: &lt;evidence&gt;");
  expect(html).toContain("research token: &lt;evidence&gt;");
  expect(html).toMatch(/data-exchange-search=\"[^\"]*research token: &lt;evidence&gt;[^\"]*success-metric trade-off[^\"]*\"/i);
  expect(html.indexOf("Semantic context: success-metrics")).toBeLessThan(html.indexOf("<script>"));
  expect(html).toContain("Read-only transcript. Support only.");
  expect(html).not.toMatch(/data-approval|<button[^>]*(?:approval|publish|approve)/i);
  expect(html).not.toMatch(/(?:href|src)=\"https?:\/\//i);
});

test("renders escaped unavailable target disclosures in no-JS markup and search", () => {
  const unavailableIds = ["removed<target&\"'", "renamed-target"];
  const projection = {
    schema: "ideation-support-renderer/v1",
    artifact_kind: "non-authoritative-support",
    workflow: "ideation",
    slug: "metrics",
    run_id: "run-1",
    revision: 1,
    trigger: "explicit-request",
    title: "Metrics",
    commitment_level: "planning",
    state_sha256: "a".repeat(64),
    interview_ledger_sha256: "b".repeat(64),
    exchanges: [{
      id: "Q11",
      exact_question: "What changed?",
      accepted_answer: "The current snapshot is authoritative for this disclosure.",
      supersedes_exchange_id: null,
      affected_targets: unavailableIds.map((semantic_id) => ({ target_type: "semantic-id" as const, semantic_id })),
      evidence_ids: [],
      active: true,
      predecessor_exchange_id: null,
      successor_exchange_id: null,
      ordinal: 11,
      target_labels: unavailableIds.map((semanticId) => `semantic:${semanticId}`),
      evidence_locators: [],
      target_presentations: [],
      unavailable_target_semantic_ids: unavailableIds,
    }],
    evidence: [],
    provenance: [],
    empty_state: false,
  } as unknown as IdeationSupportProjection;
  const template = new TextEncoder().encode("<html><head><title>__IDEATION_SUPPORT_TITLE__</title><style>__IDEATION_SUPPORT_STYLES__</style></head><body>__IDEATION_SUPPORT_BODY__</body></html>");
  const html = new TextDecoder().decode(renderIdeationSupportHtml(projection, template, new TextEncoder().encode("")));

  const escapedId = "removed&lt;target&amp;&quot;&#39;";
  const notice = `Semantic target ${escapedId} is absent from the validated lineage; no support presentation is available.`;
  expect(html).toContain("Unavailable semantic targets");
  expect(html).toContain(notice);
  expect(html).toContain("Semantic target renamed-target is absent from the validated lineage; no support presentation is available.");
  expect(html).not.toContain("Semantic target removed<target&\"'");
  expect(html).toMatch(new RegExp(`data-exchange-search=\"[^\"]*${escapedId}[^\"]*is absent from the validated lineage; no support presentation is available\.[^\"]*\"`, "i"));
  expect(html.indexOf("Unavailable semantic targets")).toBeLessThan(html.indexOf("<script>"));
});

test("renders the canonical mutable response items with protected provenance", () => {
  const payload = {
    schema: "ideation-questionnaire/workspace/v1",
    workspace_id: "workspace-1",
    dossier_id: "dossier-1",
    baseline_id: "baseline-1",
    baseline_record_path: "ai_docs/ideation/.baseline.json",
    baseline_record_sha256: "a".repeat(64),
    checkpoint_id: "checkpoint-1",
    checkpoint_record_path: "ai_docs/ideation/.checkpoint.json",
    checkpoint_record_sha256: "b".repeat(64),
    workspace_issuance_id: "issuance-1",
    workspace_issuance_record_path: "ai_docs/ideation/.issuance.json",
    workspace_issuance_record_sha256: "c".repeat(64),
    workspace_revision: 1,
    selected_occurrence_id: "occurrence-1",
    response_items: [{
      occurrence_id: "occurrence-1",
      feedback_id: "feedback-1",
      target: "Goal <script>alert(1)</script>",
      response_record_path: "ai_docs/ideation/.response.json",
      response_record_sha256: "d".repeat(64),
      answer_text: "Answer & details",
      validation: "unvalidated",
      defer_status: "not-deferred",
      defer_reason: null,
      rationale: "Because it matters",
      selected_option: "option-1",
      context_requests: ["Need context"],
      evidence_references: ["E1"],
      notebook_content: "Notebook",
    }],
    navigation_state: { active_view: "workspace", scroll_anchor: "questionnaire-occurrence-1" },
  } as QuestionnaireWorkspacePayload;
  const template = new TextEncoder().encode("<html><head><title>__IDEATION_SUPPORT_TITLE__</title><style>__IDEATION_SUPPORT_STYLES__</style></head><body>__IDEATION_SUPPORT_BODY__</body></html>");
  const html = new TextDecoder().decode(renderIdeationQuestionnaireWorkspaceHtml(payload, template, new TextEncoder().encode(".workspace-question{display:block}")));
  expect(html).toContain("Mutable questionnaire workspace");
  for (const field of ["Answer text", "Validation", "Defer status", "Defer reason", "Rationale", "Selected option", "Context requests", "Evidence references", "Notebook content"]) expect(html).toContain(field);
  expect(html).toContain("occurrence-1");
  expect(html).toContain("ai_docs/ideation/.response.json");
  expect(html).toContain("type=\"application/json\"");
  expect(html.match(/<\/script>/g)).toHaveLength(2);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  expect(scripts).toHaveLength(2);
  expect(() => new Function(scripts[1]![1]!)).not.toThrow();
  expect(JSON.parse(scripts[0]![1]!)).toEqual(payload);
  expect(html).toContain("Answer &amp; details");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toMatch(/data-workspace-field=\"(?:occurrence_id|feedback_id|target|response_record_path|response_record_sha256)\"/);
  expect(html).toContain("questionnaire.html");
  expect(html).toContain("Draft cache");
  expect(html).not.toMatch(/(?:href|src)=\"https?:\/\//i);
  expect(html).toContain("data-workspace-navigation=\"active_view\"");
  expect(html).toContain("data-workspace-navigation=\"scroll_anchor\"");
});

test("rejects renderer templates without the exact backend placeholders", () => {
  const payload = {
    schema: "ideation-questionnaire/workspace/v1",
    workspace_id: "workspace-1",
    dossier_id: "dossier-1",
    baseline_id: "baseline-1",
    baseline_record_path: "ai_docs/ideation/.baseline.json",
    baseline_record_sha256: "a".repeat(64),
    checkpoint_id: "checkpoint-1",
    checkpoint_record_path: "ai_docs/ideation/.checkpoint.json",
    checkpoint_record_sha256: "b".repeat(64),
    workspace_issuance_id: "issuance-1",
    workspace_issuance_record_path: "ai_docs/ideation/.issuance.json",
    workspace_issuance_record_sha256: "c".repeat(64),
    workspace_revision: 1,
    selected_occurrence_id: null,
    response_items: [],
    navigation_state: { active_view: "workspace", scroll_anchor: null },
  } as QuestionnaireWorkspacePayload;
  expect(() => renderIdeationQuestionnaireWorkspaceHtml(payload, new TextEncoder().encode("<html>__IDEATION_SUPPORT_BODY__</html>"), new TextEncoder().encode(""))).toThrow("__IDEATION_SUPPORT_TITLE__");
});
