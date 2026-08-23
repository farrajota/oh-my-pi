import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEWER_LAUNCH_SCHEMA,
  REVIEW_PERSPECTIVES,
  assertLosslessNormalizedReview,
  assertRoundClosureEvidence,
  ideationAuthoringReviewLifecycleHooks,
  createReviewerRawResult,
  normalizeReviewerRawResult,
  persistNormalizedReviewRecord,
  persistRepairLedger,
  persistReviewerLaunch,
  persistReviewerRawResult,
  persistRoundClosure,
  reviewerLaunchPath,
  reviewRecordPath,
  validateReviewerLaunch,
  reviewerRawResultPath,
} from "./ideation-authoring-review-lifecycle.ts";
import type {
  FindingDispositionRecord,
  ReviewPerspective,
  ReviewerLaunch,
  RoundClosureEvidenceInput,
  RoundClosureEvidenceValidator,
} from "./ideation-authoring-review-lifecycle.ts";
import { canonicalJson, hashRawBytes } from "../../approval-dossier-runtime/scripts/canonical-json.ts";

const HASH = "a".repeat(64);

function launch(round: number, perspective: ReviewPerspective, evidence = "e".repeat(64)): ReviewerLaunch {
  return {
    schema: REVIEWER_LAUNCH_SCHEMA,
    round,
    perspective,
    task_prompt_sha256: HASH,
    reviewer_agent: `reviewer-${perspective}`,
    reviewer_config_sha256: "b".repeat(64),
    requested_model: "pi/slow",
    requested_provider: "cliproxy",
    resolved_model: "pi/slow",
    resolved_provider: "cliproxy",
    artifact_manifest_sha256: "c".repeat(64),
    browser_manifest_sha256: "d".repeat(64),
    evidence_set_sha256: evidence,
  };
}

function reviewerResult(classification: "binding-contract-failure" | "concrete-defect" | "advisory-preference" = "concrete-defect"): string {
  return JSON.stringify({
    verdict: "VALID_WITH_CHANGES",
    findings: [
      { id: "F-1", severity: "medium", classification, summary: "A concrete observation", evidence: ["candidate.html#item-1"] },
      { id: "F-2", severity: "low", classification, summary: "A second ordered observation", evidence: ["candidate.html#item-2"] },
    ],
    dissent: [{ reviewer: "independent", note: "retain alternate view" }],
    limitations: [{ scope: "local files only" }],
  });
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ideation-review-lifecycle-"));
}
function evidenceValidator(round: number): RoundClosureEvidenceValidator {
  return async (input: RoundClosureEvidenceInput) => {
    expect(input.artifact_manifest).toEndWith(`authoring-rounds/round-${round}/artifact-manifest.json`);
    expect(input.focused_command_root).toEndWith(`authoring-rounds/round-${round}/focused-commands`);
    expect(input.browser_root).toEndWith(`authoring-rounds/round-${round}/browser`);
    expect(input.validated_manifest).toEndWith(`authoring-rounds/round-${round}/browser/validated-browser-manifest.json`);
    return {
      schema: "ideation-authoring/browser-evidence/v1",
      artifact_manifest_sha256: "c".repeat(64),
      browser_manifest_sha256: "d".repeat(64),
      focused_command_result_sha256s: Object.freeze([]),
      evidence_set_sha256: "e".repeat(64),
    };
  };
}


async function completeReviews(repositoryRoot: string, round: number, evidence?: readonly string[]): Promise<void> {
  for (let index = 0; index < REVIEW_PERSPECTIVES.length; index += 1) {
    const perspective = REVIEW_PERSPECTIVES[index]!;
    await persistReviewerLaunch({ repository_root: repositoryRoot, launch: launch(round, perspective, evidence?.[index]) });
    await persistReviewerRawResult({ repository_root: repositoryRoot, round, perspective, raw_result_json: reviewerResult() });
    await persistNormalizedReviewRecord({ repository_root: repositoryRoot, round, perspective });
  }
}
function dispositions(): readonly FindingDispositionRecord[] {
  return REVIEW_PERSPECTIVES.flatMap(perspective => ["F-1", "F-2"].map(finding_id => ({ perspective, finding_id, disposition: "repaired" as const, rationale: "Repair committed." })));
}
async function writePredecessorException(repositoryRoot: string, wrongPriorHash = false): Promise<string> {
  const round1Closure = await readFile(join(repositoryRoot, "authoring-rounds/round-1/round-closure.json"));
  const artifactPath = join(repositoryRoot, "authoring-rounds/round-2/artifact-manifest.json");
  const validatedPath = join(repositoryRoot, "authoring-rounds/round-2/browser/validated-browser-manifest.json");
  await mkdir(join(repositoryRoot, "authoring-rounds/round-2/browser"), { recursive: true });
  await writeFile(artifactPath, "{}");
  await writeFile(validatedPath, "{}");
  const ledger = await readFile(join(repositoryRoot, "authoring-rounds/round-2/repair-ledger.json"));
  const exceptionPath = "authoring-rounds/round-2/predecessor-evidence-exception.json";
  const exception = {
    schema: "ideation-authoring/predecessor-evidence-exception/v1",
    authorization: {
      authorized_by: "user",
      authorized_instruction: "Proceed to the next complete authoring review even though predecessor artifacts are currently missing.",
      authorized_at: "2026-08-13T18:45:00.000Z",
    },
    exception_scope: {
      allowed_next_round: 3,
      missing_path: "authoring-rounds/round-1/browser",
      missing_round: 1,
      prohibited_actions: [
        "fabricate predecessor evidence",
        "overwrite or rebase round-1 records",
        "overwrite or rebase round-2 records",
        "claim missing predecessor evidence was revalidated",
        "use a test-only evidence-validator bypass",
      ],
      round_2_records_preserved: true,
      round_3_only_new_evidence: true,
    },
    missing_predecessor_bindings: {
      artifact_manifest_sha256: "1".repeat(64),
      browser_manifest_sha256: "2".repeat(64),
      evidence_set_sha256: "3".repeat(64),
      round_1_closure_file_sha256: wrongPriorHash ? "f".repeat(64) : hashRawBytes(round1Closure),
    },
    permitted_round_3_evidence: {
      artifact_manifest_path: "authoring-rounds/round-3/artifact-manifest.json",
      artifact_manifest_sha256: "4".repeat(64),
      browser_manifest_path: "authoring-rounds/round-3/browser/browser-manifest.json",
      browser_manifest_sha256: "5".repeat(64),
      evidence_set_sha256: "6".repeat(64),
      validated_browser_manifest_path: "authoring-rounds/round-3/browser/validated-browser-manifest.json",
    },
    preserved_round_2_bindings: {
      artifact_manifest_file_sha256: hashRawBytes(await readFile(artifactPath)),
      repair_ledger_file_sha256: hashRawBytes(ledger),
      validated_browser_manifest_file_sha256: hashRawBytes(await readFile(validatedPath)),
    },
    truth_status: "Round 3 is authorized against its own evidence without claiming lost predecessor browser revalidation.",
  };
  await writeFile(join(repositoryRoot, exceptionPath), canonicalJson(exception));
  return exceptionPath;
}

describe("closed Ideation authoring reviewer lifecycle", () => {
  test("rejects unknown launch fields", () => {
    expect(() => validateReviewerLaunch({ ...launch(1, "ux-design"), unexpected: true })).toThrow("IDEATION_AUTHORING_REVIEW_INVALID:launch:keys");
  });

  test("rejects raw creation before its pre-dispatch launch", async () => {
    const repositoryRoot = await root();
    await expect(persistReviewerRawResult({ repository_root: repositoryRoot, round: 1, perspective: "ux-design", raw_result_json: reviewerResult() })).rejects.toThrow();
  });

  test("preserves reviewer verdict/findings/dissent/limitations byte-semantically and in order", () => {
    const source = reviewerResult();
    const raw = createReviewerRawResult(reviewerLaunchPath(1, "ux-design"), launch(1, "ux-design"), source);
    const record = normalizeReviewerRawResult(raw, reviewerRawResultPath(1, "ux-design"), "authoring-rounds/round-1/reviews/ux-design.review.json");
    expect(() => assertLosslessNormalizedReview(raw, { ...record, findings: [...record.findings].reverse() })).toThrow("IDEATION_AUTHORING_REVIEW_INVALID:review-record:not-lossless");
    expect(() => assertLosslessNormalizedReview(raw, { ...record, verdict: "UNSOUND" })).toThrow("IDEATION_AUTHORING_REVIEW_INVALID:review-record:not-lossless");
    expect(() => assertLosslessNormalizedReview(raw, { ...record, dissent: [] })).toThrow("IDEATION_AUTHORING_REVIEW_INVALID:review-record:not-lossless");
  });

  test("rejects a pre-created raw result even when its bytes are identical", async () => {
    const repositoryRoot = await root();
    const receipt = launch(1, "ux-design");
    await persistReviewerLaunch({ repository_root: repositoryRoot, launch: receipt });
    const raw = createReviewerRawResult(reviewerLaunchPath(1, "ux-design"), receipt, reviewerResult());
    const rawPath = join(repositoryRoot, reviewerRawResultPath(1, "ux-design"));
    await writeFile(rawPath, canonicalJson(raw));
    await expect(persistReviewerRawResult({ repository_root: repositoryRoot, round: 1, perspective: "ux-design", raw_result_json: reviewerResult() })).rejects.toThrow("IDEATION_AUTHORING_REVIEW_INVALID:persistence:pre-existing");
  });
  test("rejects a repair ledger with a missing finding disposition", async () => {
    const repositoryRoot = await root();
    await completeReviews(repositoryRoot, 1);
    await expect(persistRepairLedger({ repository_root: repositoryRoot, round: 1, dispositions: dispositions().slice(0, 2), advisory_deferrals: [] })).rejects.toThrow("IDEATION_AUTHORING_REVIEW_INVALID:repair-ledger:missing-disposition");
  });

  test("requires one identical evidence set across all three perspectives", async () => {
    const repositoryRoot = await root();
    await completeReviews(repositoryRoot, 1, ["1".repeat(64), "2".repeat(64), "1".repeat(64)]);
    await expect(persistRepairLedger({ repository_root: repositoryRoot, round: 1, dispositions: dispositions(), advisory_deferrals: [] })).rejects.toThrow("IDEATION_AUTHORING_REVIEW_INVALID:repair-ledger:mixed-evidence-set");
  });

  test("rehashes closed dependencies and rejects later mutation", async () => {
    const repositoryRoot = await root();
    ideationAuthoringReviewLifecycleHooks.evidence_validator = evidenceValidator;
    try {
      await completeReviews(repositoryRoot, 1);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 1, dispositions: dispositions(), advisory_deferrals: [] });
      const closed = await persistRoundClosure({ repository_root: repositoryRoot, round: 1, terminal_status: "accepted" });
      const launchPath = join(repositoryRoot, reviewerLaunchPath(1, "ux-design"));
      const original = await readFile(launchPath);
      await writeFile(launchPath, Buffer.from(canonicalJson({ ...launch(1, "ux-design"), reviewer_agent: "mutated" }), "utf8"));
      await expect(assertRoundClosureEvidence(repositoryRoot, closed.closure, evidenceValidator(1))).rejects.toThrow();
      await writeFile(launchPath, original);
    } finally {
      delete ideationAuthoringReviewLifecycleHooks.evidence_validator;
    }
  });

  test("requires the complete evidence graph before immutable closure installation", async () => {
    const repositoryRoot = await root();
    ideationAuthoringReviewLifecycleHooks.evidence_validator = () => async () => {
      throw new TypeError("full evidence graph rejected");
    };
    try {
      await completeReviews(repositoryRoot, 1);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 1, dispositions: dispositions(), advisory_deferrals: [] });
      await expect(persistRoundClosure({ repository_root: repositoryRoot, round: 1, terminal_status: "accepted" })).rejects.toThrow("full evidence graph rejected");
      await expect(readFile(join(repositoryRoot, "authoring-rounds/round-1/round-closure.json"))).rejects.toThrow();
    } finally {
      delete ideationAuthoringReviewLifecycleHooks.evidence_validator;
    }
  });

  test("rejects a closure whose reviewer launches bind different artifact manifests", async () => {
    const repositoryRoot = await root();
    ideationAuthoringReviewLifecycleHooks.evidence_validator = evidenceValidator;
    try {
      await completeReviews(repositoryRoot, 1);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 1, dispositions: dispositions(), advisory_deferrals: [] });
      const closed = await persistRoundClosure({ repository_root: repositoryRoot, round: 1, terminal_status: "accepted" });
      const perspective = "frontend-accessibility";
      const launchPath = join(repositoryRoot, reviewerLaunchPath(1, perspective));
      const launchRecord = JSON.parse(await readFile(launchPath, "utf8"));
      const alteredLaunch = { ...launchRecord, artifact_manifest_sha256: "f".repeat(64) };
      await writeFile(launchPath, canonicalJson(alteredLaunch));
      const rawPath = join(repositoryRoot, reviewerRawResultPath(1, perspective));
      const rawRecord = JSON.parse(await readFile(rawPath, "utf8"));
      const alteredLaunchSha256 = hashRawBytes(Buffer.from(canonicalJson(alteredLaunch), "utf8"));
      const alteredRaw = { ...rawRecord, launch_sha256: alteredLaunchSha256 };
      await writeFile(rawPath, canonicalJson(alteredRaw));
      const alteredRawSha256 = hashRawBytes(Buffer.from(canonicalJson(alteredRaw), "utf8"));
      const reviewPath = join(repositoryRoot, reviewRecordPath(1, perspective));
      const reviewRecord = JSON.parse(await readFile(reviewPath, "utf8"));
      const alteredReview = { ...reviewRecord, raw_record_sha256: alteredRawSha256 };
      await writeFile(reviewPath, canonicalJson(alteredReview));
      const altered = {
        ...closed.closure,
        launches: closed.closure.launches.map(reference => reference.perspective === perspective ? { ...reference, sha256: alteredLaunchSha256 } : reference),
        raw_results: closed.closure.raw_results.map(reference => reference.perspective === perspective ? { ...reference, sha256: alteredRawSha256 } : reference),
        review_records: closed.closure.review_records.map(reference => reference.perspective === perspective ? { ...reference, sha256: hashRawBytes(Buffer.from(canonicalJson(alteredReview), "utf8")) } : reference),
      };
      await expect(assertRoundClosureEvidence(repositoryRoot, altered, evidenceValidator(1))).rejects.toThrow("IDEATION_AUTHORING_REVIEW_INVALID:round-closure:mixed-manifest");
    } finally {
      delete ideationAuthoringReviewLifecycleHooks.evidence_validator;
    }
  });

  test("binds an immutable round-four predecessor, proves the full supersession chain, and rejects round six", async () => {
    const repositoryRoot = await root();
    ideationAuthoringReviewLifecycleHooks.evidence_validator = evidenceValidator;
    try {
      for (const reviewRound of [1, 2, 3, 4] as const) {
        await completeReviews(repositoryRoot, reviewRound);
        await persistRepairLedger({ repository_root: repositoryRoot, round: reviewRound, dispositions: dispositions(), advisory_deferrals: [] });
        await persistRoundClosure({ repository_root: repositoryRoot, round: reviewRound, terminal_status: "requires-next-round" });
      }
      const fourthPath = join(repositoryRoot, "authoring-rounds/round-4/round-closure.json");
      const fourthBytes = await readFile(fourthPath);
      await completeReviews(repositoryRoot, 5);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 5, dispositions: dispositions(), advisory_deferrals: [] });
      await expect(persistRoundClosure({ repository_root: repositoryRoot, round: 5, terminal_status: "requires-next-round" })).rejects.toThrow("IDEATION_AUTHORING_REVIEW_INVALID:round-closure:terminal-status");
      const fifth = await persistRoundClosure({ repository_root: repositoryRoot, round: 5, terminal_status: "accepted" });
      expect(fifth.closure.previous_closure).toEqual({
        path: "authoring-rounds/round-4/round-closure.json",
        sha256: hashRawBytes(fourthBytes),
      });
      await assertRoundClosureEvidence(repositoryRoot, fifth.closure, evidenceValidator(5));
      await expect(persistReviewerLaunch({ repository_root: repositoryRoot, launch: launch(6, "ux-design") })).rejects.toThrow("IDEATION_AUTHORING_REVIEW_INVALID:launch.round:round");
    } finally {
      delete ideationAuthoringReviewLifecycleHooks.evidence_validator;
    }
  });

  test("uses the typed round-two predecessor exception then restores the normal round chain", async () => {
    const repositoryRoot = await root();
    ideationAuthoringReviewLifecycleHooks.evidence_validator = evidenceValidator;
    try {
      await completeReviews(repositoryRoot, 1);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 1, dispositions: dispositions(), advisory_deferrals: [] });
      await persistRoundClosure({ repository_root: repositoryRoot, round: 1, terminal_status: "requires-next-round" });
      await completeReviews(repositoryRoot, 2);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 2, dispositions: dispositions(), advisory_deferrals: [] });
      const exceptionPath = await writePredecessorException(repositoryRoot);
      const second = await persistRoundClosure({ repository_root: repositoryRoot, round: 2, terminal_status: "requires-next-round", predecessor_exception_path: exceptionPath });
      expect(second.closure.previous_closure?.exception?.path).toBe(exceptionPath);
      await completeReviews(repositoryRoot, 3);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 3, dispositions: dispositions(), advisory_deferrals: [] });
      const third = await persistRoundClosure({ repository_root: repositoryRoot, round: 3, terminal_status: "requires-next-round" });
      expect(third.closure.previous_closure?.path).toBe("authoring-rounds/round-2/round-closure.json");
      await completeReviews(repositoryRoot, 4);
      await persistRepairLedger({ repository_root: repositoryRoot, round: 4, dispositions: dispositions(), advisory_deferrals: [] });
      const fourth = await persistRoundClosure({ repository_root: repositoryRoot, round: 4, terminal_status: "accepted" });
      expect(fourth.closure.previous_closure?.path).toBe("authoring-rounds/round-3/round-closure.json");
    } finally {
      delete ideationAuthoringReviewLifecycleHooks.evidence_validator;
    }
  });

  test("rejects predecessor exceptions with the wrong round, path, or bound hash", async () => {
    const wrongRoundRoot = await root();
    await expect(persistRoundClosure({ repository_root: wrongRoundRoot, round: 3, terminal_status: "blocked", predecessor_exception_path: "authoring-rounds/round-2/predecessor-evidence-exception.json" })).rejects.toThrow("IDEATION_AUTHORING_REVIEW_INVALID:round-closure:predecessor-exception-round");

    for (const failure of ["path", "hash"] as const) {
      const repositoryRoot = await root();
      ideationAuthoringReviewLifecycleHooks.evidence_validator = evidenceValidator;
      try {
        await completeReviews(repositoryRoot, 1);
        await persistRepairLedger({ repository_root: repositoryRoot, round: 1, dispositions: dispositions(), advisory_deferrals: [] });
        await persistRoundClosure({ repository_root: repositoryRoot, round: 1, terminal_status: "requires-next-round" });
        await completeReviews(repositoryRoot, 2);
        await persistRepairLedger({ repository_root: repositoryRoot, round: 2, dispositions: dispositions(), advisory_deferrals: [] });
        const exceptionPath = await writePredecessorException(repositoryRoot, failure === "hash");
        const suppliedPath = failure === "path" ? "authoring-rounds/round-2/wrong-exception.json" : exceptionPath;
        await expect(persistRoundClosure({ repository_root: repositoryRoot, round: 2, terminal_status: "blocked", predecessor_exception_path: suppliedPath })).rejects.toThrow(
          failure === "path"
            ? "IDEATION_AUTHORING_REVIEW_INVALID:round-closure:predecessor-exception-path"
            : "IDEATION_AUTHORING_REVIEW_INVALID:round-closure:predecessor-exception-prior",
        );
      } finally {
        delete ideationAuthoringReviewLifecycleHooks.evidence_validator;
      }
    }
  });

  test("binds raw bytes rather than reformatted reviewer JSON", () => {
    const result = reviewerResult();
    const raw = createReviewerRawResult(reviewerLaunchPath(1, "ux-design"), launch(1, "ux-design"), result);
    expect(raw.raw_result_sha256).toBe(hashRawBytes(Buffer.from(result, "utf8")));
  });
});
