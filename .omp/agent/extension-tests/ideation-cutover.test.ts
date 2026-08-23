import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const forkRoot = join(import.meta.dir, "..", "..", "..");
const agentRoot = join(forkRoot, ".omp", "agent");
const ideationRoot = join(agentRoot, "skills", "ideation-with-critique");
const docsRoot = join(forkRoot, "ai_docs");
const commandPath = join(
  agentRoot,
  "commands",
  "design-ideation-with-critique.md",
);
const skillPath = join(ideationRoot, "SKILL.md");
const statePath = join(ideationRoot, "schemas", "ideation-state.ts");
const runtimePath = join(ideationRoot, "scripts", "ideation-runtime.ts");
const questionnaireRuntimePath = join(
  ideationRoot,
  "scripts",
  "ideation-support-runtime.ts",
);
const rulesPath = join(
  docsRoot,
  "ideation-dossier-generation-rules.md",
);
const checklistPath = join(
  docsRoot,
  "ideation-dossier-production-checklist.md",
);
const referenceTemplatePath = join(
  ideationRoot,
  "templates",
  "ideation-support-reference.html",
);
const referenceStylesheetPath = join(
  ideationRoot,
  "templates",
  "ideation-support-reference.css",
);

describe("Ideation approval-dossier cutover", () => {
  test("keeps the command as a thin closed-state workflow adapter", async () => {
    const command = await readFile(commandPath, "utf8");
    expect(command).toContain(
      "Delegate the complete workflow to `skill://ideation-with-critique`;",
    );
    expect(command).toContain("mandatory protected final approval dossier");
    expect(command).toContain(
      "/design-deep-scope ai_docs/ideation/<slug>.md max_review_rounds=<state.max_review_rounds>",
    );
    expect(command).not.toMatch(
      /semantic-fidelity|dossier-fidelity|post_approval_reviews/i,
    );
    expect(command).toContain("Omission defaults `max_review_rounds` to `3`");
    expect(command).not.toContain("## Deep-Scope Handoff");
    expect(command).not.toMatch(/\/deep-scope(?:\s|$)/);
    expect(command).not.toMatch(
      /(?:post[- ]human[- ]approval|post[- ]approval)[\s\S]{0,240}pi\/slow[\s\S]{0,120}\bpass\b/i,
    );
  });

  test("binds the immutable non-authoritative support procedure", async () => {
    const [command, skill, rules, checklist, template, stylesheet] =
      await Promise.all([
        readFile(commandPath, "utf8"),
        readFile(skillPath, "utf8"),
        readFile(rulesPath, "utf8"),
        readFile(checklistPath, "utf8"),
        readFile(referenceTemplatePath, "utf8"),
        readFile(referenceStylesheetPath, "utf8"),
      ]);
    const procedure = [command, skill, rules, checklist].join("\n");
    expect(procedure).toContain("support");
    expect(procedure).toContain("non-authoritative");
    expect(procedure).toContain("mandatory protected final approval dossier");
    expect(skill).toContain("## Create optional historical support dossiers");
    expect(procedure).toContain("UX/design");
    expect(procedure).toContain("frontend/accessibility");
    expect(procedure).toContain("authority/security");
    expect(procedure).toMatch(/at most three|no more than three/i);
    for (const viewport of ["1440×900", "1024×768", "390×844"]) expect(procedure).toContain(viewport);
    expect(checklist).toContain("Optional support");
    expect(template).toContain("non-authoritative support");
    expect(template).toContain("__IDEATION_SUPPORT_BODY__");
    expect(template).toContain("__IDEATION_SUPPORT_STYLES__");
    expect(template).not.toMatch(/https?:\/\//);
    expect(stylesheet).toMatch(/overflow:auto|overflow-wrap/);
    expect(stylesheet).not.toContain("overflow-x:hidden");
    expect(procedure).toMatch(/never reconstruct|never parses or rewrites/i);
  });

  test("distinguishes active workspace from preserved historical support", async () => {
    const [command, skill, rules, checklist, renderer, template, questionnaireRuntime] = await Promise.all([
      readFile(commandPath, "utf8"),
      readFile(skillPath, "utf8"),
      readFile(rulesPath, "utf8"),
      readFile(checklistPath, "utf8"),
      readFile(join(ideationRoot, "scripts", "ideation-support-renderer.ts"), "utf8"),
      readFile(referenceTemplatePath, "utf8"),
      readFile(questionnaireRuntimePath, "utf8"),
    ]);
    const procedure = [command, skill, rules, checklist].join("\n");
    expect(procedure).toContain("questionnaire.html");
    expect(procedure).toMatch(/LocalStorage.*draft-only/i);
    expect(procedure).toMatch(/evidence-only import/i);
    expect(procedure).toMatch(/explicit validated Ideation transition/i);
    expect(renderer).toContain("response_items");
    expect(renderer).toContain("questionnaire-workspace-payload");
    expect(renderer).not.toMatch(/data-workspace-field=\\?\"(?:occurrence_id|feedback_id|target|response_record_path|response_record_sha256)/);
    expect(renderer).toContain("evidence-only import");
    expect(skill).toMatch(/Persistence creates or replaces canonical state.*creates no HTML/i);
    expect(template).toContain("non-authoritative support");
    expect(questionnaireRuntime).toContain("QUESTIONNAIRE_ADMITTED_RESPONSE_SCHEMA");
    expect(questionnaireRuntime).toContain("workspace_snapshot_path");
    expect(questionnaireRuntime).toContain("questionnaire checkpoint CAS conflict");
    expect(questionnaireRuntime).toContain("rebase decisions are forged, incomplete, or unsorted");
    expect(questionnaireRuntime).toContain("admitted_response_record_sha256");
  });

  test("defines closed state, deterministic rendering, verifier import, and receipt-bound publication", async () => {
    const [skill, state, runtime] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(statePath, "utf8"),
      readFile(runtimePath, "utf8"),
    ]);
    expect(state).toContain("IDEATION_STATE_SCHEMA");
    expect(state).toContain("unknown field");
    expect(state).toContain('model: "pi/slow"');
    expect(state).toContain("critics.length !== 2");
    expect(state).toContain("BASELINE_SUBSTANTIVE_REVIEW_ROLES");
    expect(state).toContain("validateSubstantiveReviewAssignments(");
    expect(state).not.toContain("correctness");
    expect(state).not.toContain("simplicity-maintainability");
    expect(state).not.toContain("architecture-integration");
    expect(runtime).toContain("renderApprovalDossier");
    expect(runtime).toContain("persistSubstantiveReviewAuthority");
    expect(runtime).not.toContain("persistPostApprovalReviewRecord");
    expect(runtime).toContain("candidateReviewSubjectSha256");
    expect(runtime).toContain("review_authority_sha256");
    expect(runtime).toContain("verifyImportedHtml");
    expect(runtime).toContain("installImmutableAuthorityFile");
    expect(runtime).not.toContain("receipt.review_hashes");
    expect(runtime).not.toContain("review_record_paths");
    expect([skill, state, runtime].join("\n")).not.toMatch(
      /post_approval_reviews|persistPostApprovalReviewRecord/i,
    );
    expect([skill, state, runtime].join("\n")).not.toMatch(
      /(?:post[- ]human[- ]approval|post[- ]approval)[\s\S]{0,240}pi\/slow[\s\S]{0,120}\bpass\b/i,
    );
    expect(skill).toContain("terminal-first");
    expect(skill).toMatch(/saved response/i);
    expect(skill).toContain("focused review/context pane");
    expect(skill).toContain("responsive tabs");
    expect(skill).toContain(
      "Continue the terminal interview after presenting critique; conversational readiness is not approval.",
    );
  });
});
