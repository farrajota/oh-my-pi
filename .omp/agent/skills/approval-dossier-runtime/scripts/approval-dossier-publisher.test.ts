import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_SUBSTANTIVE_REVIEW_ROLES,
  type CandidateBinding,
  candidateReviewSubjectSha256,
  SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA,
  type SubstantiveReviewAuthority,
  substantiveReviewAuthoritySha256,
  visualSetSha256,
} from "../schemas/approval-dossier.ts";
import { renderApprovalDossier } from "./approval-dossier-renderer.ts";
import {
  createApprovalResponse,
  createCandidateBinding,
  createMarkdownFileRecord,
  encodeProtectedApprovalPayload,
  type PublicationInput,
  persistSubstantiveReviewAuthority,
  publishApprovedMarkdown,
} from "./approval-dossier-runtime.ts";
import { hashRawBytes } from "./canonical-json.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

type AuthorityMode =
  | "pass"
  | "missing-result"
  | "missing-coverage"
  | "block"
  | "unresolved"
  | "stale-candidate"
  | "semantic-mismatch"
  | "bundle-mismatch";

function authorityFor(
  candidate: CandidateBinding,
  mode: AuthorityMode,
): SubstantiveReviewAuthority {
  const mandatoryCoverageIds = ["candidate-binding", "requirements"];
  const assignments = BASELINE_SUBSTANTIVE_REVIEW_ROLES.map((role, index) => ({
    assignment_id: `assignment-${index + 1}`,
    role,
    reviewer_id: `substantive-reviewer-${index + 1}`,
    blind: true as const,
    specialist_trigger: null,
    required_coverage_ids: mandatoryCoverageIds,
  }));
  let results = assignments.map((assignment, index) => ({
    result_id: `result-${index + 1}`,
    result_sha256: hashRawBytes(Buffer.from(`result-${index + 1}`)),
    assignment_id: assignment.assignment_id,
    reviewer_id: assignment.reviewer_id,
    subject_sha256: HASH_C,
    verdict: "PASS" as "PASS" | "BLOCK" | "UNRESOLVED",
    covered_coverage_ids: mandatoryCoverageIds,
    occurrence_ids: [],
    completed_at: "2026-08-04T00:00:00Z",
  }));
  if (mode === "missing-result") results = results.slice(0, -1);
  if (mode === "missing-coverage")
    results = results.map((result, index) =>
      index === 0
        ? { ...result, covered_coverage_ids: ["candidate-binding"] }
        : result,
    );
  if (mode === "block")
    results = results.map((result, index) =>
      index === 0 ? { ...result, verdict: "BLOCK" as const } : result,
    );
  if (mode === "unresolved")
    results = results.map((result, index) =>
      index === 0 ? { ...result, verdict: "UNRESOLVED" as const } : result,
    );
  const derivedGate =
    mode === "missing-result" || mode === "missing-coverage"
      ? "INCOMPLETE"
      : mode === "block"
        ? "BLOCK"
        : mode === "unresolved"
          ? "UNRESOLVED"
          : "PASS";
  return {
    schema: SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA,
    workflow: candidate.workflow,
    run_id: candidate.run_id,
    revision: candidate.revision,
    subject_sha256: HASH_C,
    candidate_subject_sha256:
      mode === "stale-candidate"
        ? HASH_C
        : candidateReviewSubjectSha256(candidate),
    semantic_sha256:
      mode === "semantic-mismatch" ? HASH_B : candidate.semantic_sha256,
    bundle_sha256:
      mode === "bundle-mismatch" ? HASH_B : candidate.bundle_sha256,
    mandatory_coverage_ids: mandatoryCoverageIds,
    assignments,
    results,
    occurrences: [],
    derived_gate: derivedGate,
  };
}

async function fixture(mode: AuthorityMode = "pass", path = "docs/plan.md") {
  const markdown = Buffer.from("# Approved plan\n", "utf8");
  const candidateInput = {
    workflow: "deep-scope",
    run_id: "scope-1",
    revision: 1,
    semantic_sha256: HASH_A,
    files: [createMarkdownFileRecord(path, markdown)],
    visual_set_sha256: visualSetSha256([]),
    runtime_sha256: HASH_C,
    predecessors: [],
  };
  const provisional = createCandidateBinding({
    ...candidateInput,
    review_authority_sha256: HASH_B,
  });
  const authority = authorityFor(provisional, mode);
  const candidate = createCandidateBinding({
    ...candidateInput,
    review_authority_sha256: substantiveReviewAuthoritySha256(authority),
  });
  const baselineApproval = createApprovalResponse({
    candidate,
    approval_status: "draft",
    approval_actor: "approver",
    submitted_at: "2026-08-03T00:00:00Z",
    approved_at: null,
    files: [{ path, bytes: markdown }],
    feedback: [],
  });
  const approval = createApprovalResponse({
    candidate,
    approval_status: "approved",
    approval_actor: "approver",
    submitted_at: "2026-08-03T00:00:00Z",
    approved_at: "2026-08-03T00:01:00Z",
    files: [{ path, bytes: markdown }],
    feedback: [],
  });
  const renderedCandidate = await renderApprovalDossier({
    title: "Approved publication fixture",
    candidate,
    approval: baselineApproval,
    visual_set: {
      schema: "approval-dossier/visual-set/v1",
      visual_set_sha256: visualSetSha256([]),
      visuals: [],
    },
    visuals: [],
    feedback_targets: [],
    review_presentations: [],
  });
  const html = renderedCandidate.html.replace(
    encodeProtectedApprovalPayload(baselineApproval),
    encodeProtectedApprovalPayload(approval),
  );
  return {
    authority,
    candidate,
    markdown,
    html,
    candidate_html: renderedCandidate.html,
  };
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "approval-dossier-runtime-"));
}

async function publicationInput(
  directory: string,
  mode: AuthorityMode = "pass",
): Promise<PublicationInput> {
  const source = await fixture(mode);
  const authority = await persistSubstantiveReviewAuthority(
    directory,
    `reviews/substantive-${mode}.json`,
    source.authority,
  );
  return {
    repository_root: directory,
    receipt_path: "receipts/plan.json",
    approved_html: source.html,
    candidate: source.candidate,
    substantive_review_authority: authority.binding,
    context: {
      candidate_html: source.candidate_html,
      review_authority_sha256: authority.binding.sha256,
    },
  };
}

describe("immutable Markdown publication", () => {
  test("publishes exact protected Markdown and a path-bound independently verifiable receipt", async () => {
    const directory = await root();
    try {
      const input = await publicationInput(directory);
      const first = await publishApprovedMarkdown(input);
      expect(await readFile(join(directory, "docs/plan.md"), "utf8")).toBe(
        "# Approved plan\n",
      );
      expect(first.receipt.receipt_path).toBe(input.receipt_path);
      expect(first.receipt.substantive_review_authority).toEqual(
        input.substantive_review_authority,
      );
      const second = await publishApprovedMarkdown(input);
      expect(second.outcomes).toEqual(["adopted-identical"]);
      expect(second.receipt_outcome).toBe("adopted-identical");
      expect(second.receipt_bytes).toEqual(first.receipt_bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects missing and hash-only substantive authority before output", async () => {
    for (const authority of [undefined, { sha256: HASH_B }]) {
      const directory = await root();
      try {
        const input = await publicationInput(directory);
        await expect(
          publishApprovedMarkdown({
            ...input,
            substantive_review_authority: authority,
          } as unknown as PublicationInput),
        ).rejects.toThrow("SUBSTANTIVE_REVIEW_INVALID");
        await expect(
          readFile(join(directory, "docs/plan.md")),
        ).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("rejects incomplete, BLOCK, UNRESOLVED, stale, and mismatched substantive authorities", async () => {
    for (const mode of [
      "missing-result",
      "missing-coverage",
      "block",
      "unresolved",
      "stale-candidate",
      "semantic-mismatch",
      "bundle-mismatch",
    ] as const) {
      const directory = await root();
      try {
        await expect(
          publishApprovedMarkdown(await publicationInput(directory, mode)),
        ).rejects.toThrow("SUBSTANTIVE_REVIEW_INVALID");
        await expect(
          readFile(join(directory, "docs/plan.md")),
        ).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
