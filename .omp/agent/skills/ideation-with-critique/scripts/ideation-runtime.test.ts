import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CandidateBinding } from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import {
  candidateReviewSubjectSha256,
  candidateSha256,
  PUBLICATION_RECEIPT_SCHEMA,
  publicationReceiptSha256,
  validateCandidateBinding,
  validatePublicationReceipt,
} from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import { encodeProtectedApprovalPayload } from "../../approval-dossier-runtime/scripts/approval-dossier-html.ts";
import {
  loadApprovalDossierRendererSnapshot,
  renderApprovalDossier,
} from "../../approval-dossier-runtime/scripts/approval-dossier-renderer.ts";
import { createApprovalResponse } from "../../approval-dossier-runtime/scripts/approval-dossier-runtime.ts";
import {
  canonicalJson,
  hashCanonicalJson,
  hashRawBytes,
} from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import {
  DEFAULT_IDEATION_MAX_REVIEW_ROUNDS,
  deriveFinalDocumentReviewGate,
  type FinalDocumentReviewAssignment,
  type FinalDocumentReviewFinding,
  type FinalDocumentReviewResult,
  finalDocumentReviewEpisodeSha256,
  finalDocumentReviewResultEvidence,
  IDEATION_FINAL_REVIEW_SCHEMA,
  IDEATION_STATE_SCHEMA,
  type IdeationState,
  ideationReviewResultPath,
  ideationReviewSubjectSha256,
  ideationStateSha256,
  validateIdeationState,
} from "../schemas/ideation-state.ts";
import { parseIdeationInvocation } from "./ideation-invocation.ts";
import {
  createDeepScopeHandoffFromSavedAuthority,
  createIdeationCandidateFromSavedState,
  createIdeationRuntimeBinding,
  ideationStatePath,
  ideationRuntimeHooks,
  importIdeationResponseFromSavedPath,
  persistIdeationState,
  persistIdeationSubstantiveReviewResults,
  publishIdeationMarkdownFromSavedRecords,
  reconcileCurrentIdeationStateAuthority,
  recoverIdeationAuthority,
} from "./ideation-runtime.ts";
import {
  createIdeationNativeVisuals,
  createIdeationVisualSet,
  renderIdeationMarkdown,
} from "./ideation-projection.ts";
import {
  createIdeationSupportDossier,
  reopenIdeationSupportDossier,
} from "./ideation-support-runtime.ts";
import {
  assertIdeationExchangeContentSafe,
  scanHighConfidenceSecrets,
  scanPromptInjection,
} from "../../approval-dossier-runtime/scripts/content-safety.ts";

const implementationRoot = resolve(import.meta.dir, "../../../../..");

const fixturePath = join(
  import.meta.dir,
  "..",
  "fixtures",
  "ideation-to-deep-scope-receipt-preflight.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  readonly state: unknown;
  readonly expected: {
    readonly markdown_path: string;
    readonly receipt_path: string;
    readonly workflow: string;
    readonly mandatory_provenance_fields: readonly string[];
  };
};

function readyState(maxReviewRounds: 1 | 2 | 3 | 4 | 5 = 5) {
  const raw = fixture.state as Record<string, any>;
  const legacyReview = raw.final_document_review as Record<string, unknown>;
  const emptyReview = {
    schema: IDEATION_FINAL_REVIEW_SCHEMA,
    episodes: [],
    current_episode: null,
    rounds: [],
    current_round: null,
  } as const;
  const evidenceId = (raw.evidence as readonly { id: string }[])[0]!.id;
  const requiredIds = [
    (raw.goal as { id: string }).id,
    ...(raw.criteria as readonly { id: string }[]).map((entry) => entry.id),
    ...(raw.decisions as readonly { id: string; status: string }[])
      .filter((entry) => entry.status === "active")
      .map((entry) => entry.id),
    ...(raw.assumptions as readonly { id: string }[]).map((entry) => entry.id),
    ...(
      raw.readiness as { bounded_ambiguities: readonly { id: string }[] }
    ).bounded_ambiguities.map((entry) => entry.id),
  ].sort();
  const reviewItemPresentations = requiredIds.map((semanticId) => ({
    semantic_id: semanticId,
    purpose: `Purpose for ${semanticId}`,
    why_it_matters: `Why ${semanticId} matters`,
    system_position: `System position for ${semanticId}`,
    dependency_semantic_ids: [],
    key_points: [`Key point for ${semanticId}`],
    research_summary: [`Research summary for ${semanticId}`],
    options: [1, 2, 3, 4].map((option) => ({
      option_id: `${semanticId}-option-${option}`,
      label: `Option ${option}`,
      mechanism_or_output: `Mechanism ${option} for ${semanticId}`,
      benefit: `Benefit ${option} for ${semanticId}`,
      omission_cost_or_uncertainty: `Cost ${option} for ${semanticId}`,
      downstream_consequence: `Consequence ${option} for ${semanticId}`,
      evidence_ids: [evidenceId],
    })),
    recommended_option_id: `${semanticId}-option-1`,
    recommendation_rationale: `Recommendation rationale for ${semanticId}`,
    uncertainty: `Uncertainty for ${semanticId}`,
  }));
  const semantic = validateIdeationState({
    ...raw,
    schema: IDEATION_STATE_SCHEMA,
    max_review_rounds: maxReviewRounds,
    revision_kind: "non-answer",
    interview_exchanges: [],
    review_item_presentations: reviewItemPresentations,
    readiness: {
      ...(raw.readiness as Record<string, unknown>),
      status: "draft",
    },
    final_document_review: emptyReview,
  });
  const reviewSubjectSha256 = ideationReviewSubjectSha256(semantic);
  const round = (legacyReview.rounds as readonly Record<string, unknown>[])[0]!;
  const subject = {
    ...(round.subject as Record<string, unknown>),
    subject_sha256: reviewSubjectSha256,
  };
  const results = (round.results as readonly Record<string, unknown>[]).map(
    (result) => ({
      ...result,
      review_subject_sha256: reviewSubjectSha256,
    }),
  );
  const episode = {
    episode: 1,
    first_round: 1,
    semantic_revision: semantic.revision,
    subject_sha256: reviewSubjectSha256,
    predecessor_episode_sha256: null,
    predecessor_state_sha256: null,
    predecessor_candidate_record_path: null,
    predecessor_candidate_record_sha256: null,
    predecessor_response_record_path: null,
    predecessor_response_record_sha256: null,
    predecessor_import_current_candidate_sha256: null,
  } as const;
  return validateIdeationState({
    ...semantic,
    schema: IDEATION_STATE_SCHEMA,
    max_review_rounds: maxReviewRounds,
    revision_kind: "non-answer",
    interview_exchanges: [],
    review_item_presentations: reviewItemPresentations,
    final_document_review: {
      schema: IDEATION_FINAL_REVIEW_SCHEMA,
      episodes: [episode],
      current_episode: 1,
      rounds: [{ ...round, subject, results }],
      current_round: 1,
    },
  });
}

function materializeSubstantiveReviewState(stateInput = readyState()) {
  const initialRound =
    stateInput.final_document_review.rounds[
      stateInput.final_document_review.current_round! - 1
    ]!;
  const reviewSubjectSha256 = ideationReviewSubjectSha256(stateInput);
  const subject = {
    ...initialRound.subject,
    subject_sha256: reviewSubjectSha256,
  };
  const results: FinalDocumentReviewResult[] = initialRound.results.map(
    (result) => {
      const bound = { ...result, review_subject_sha256: reviewSubjectSha256 };
      const result_sha256 = hashRawBytes(
        Buffer.from(
          canonicalJson(finalDocumentReviewResultEvidence(bound)),
          "utf8",
        ),
      );
      return {
        ...bound,
        result_sha256,
        result_path: ideationReviewResultPath(stateInput.slug, result_sha256),
      };
    },
  );
  const episodes = stateInput.final_document_review.episodes.map((episode) =>
    episode.episode === stateInput.final_document_review.current_episode
      ? {
          ...episode,
          semantic_revision: subject.semantic_revision,
          subject_sha256: reviewSubjectSha256,
        }
      : episode,
  );
  return validateIdeationState({
    ...stateInput,
    readiness: {
      ...stateInput.readiness,
      status: stateInput.final_document_review.rounds.some((round) =>
        round.results.some((result) => result.verdict === "BLOCK"),
      )
        ? "draft"
        : "ready-for-approval",
    },
    final_document_review: {
      ...stateInput.final_document_review,
      episodes,
      rounds: stateInput.final_document_review.rounds.map((round) =>
        round.round === initialRound.round
          ? { ...initialRound, subject, results }
          : round,
      ),
    },
  });
}

function blockedReviewState(): IdeationState {
  const state = readyState();
  const round = state.final_document_review.rounds[0]!;
  const blocked = validateIdeationState({
    ...state,
    readiness: { ...state.readiness, status: "draft" as const },
    final_document_review: {
      ...state.final_document_review,
      rounds: [
        {
          ...round,
          results: [
            { ...round.results[0]!, verdict: "BLOCK" as const },
            ...round.results.slice(1),
          ],
        },
      ],
    },
  });
  return validateIdeationState({
    ...materializeSubstantiveReviewState(blocked),
    readiness: { ...blocked.readiness, status: "draft" },
  });
}

function successorWithAppendedReview(
  predecessor: IdeationState,
): IdeationState {
  const successorBase = validateIdeationState({
    ...predecessor,
    revision: predecessor.revision + 1,
    predecessor_sha256: ideationStateSha256(predecessor),
    revision_kind: "non-answer",
    readiness: { ...predecessor.readiness, status: "draft" },
    final_document_review: {
      schema: IDEATION_FINAL_REVIEW_SCHEMA,
      episodes: [],
      current_episode: null,
      rounds: [],
      current_round: null,
    },
  });
  const previousRound = predecessor.final_document_review.rounds.at(-1)!;
  const appendedRound = {
    round: predecessor.final_document_review.rounds.length + 1,
    subject: {
      subject_id: `subject-${predecessor.final_document_review.rounds.length + 1}`,
      semantic_revision: successorBase.revision,
      subject_sha256: ideationReviewSubjectSha256(successorBase),
      predecessor_subject_sha256: previousRound.subject.subject_sha256,
    },
    mandatory_invariant_ids: previousRound.mandatory_invariant_ids,
    reviewers: previousRound.reviewers,
    results: [],
  };
  return validateIdeationState({
    ...successorBase,
    final_document_review: {
      ...successorBase.final_document_review,
      episodes: predecessor.final_document_review.episodes,
      current_episode: predecessor.final_document_review.current_episode,
      rounds: [...predecessor.final_document_review.rounds, appendedRound],
      current_round: appendedRound.round,
    },
  });
}

type ResponseEpisodeAuthority = {
  candidate_record_path: string;
  candidate_record_sha256: string;
  response_record_path: string;
  response_record_sha256: string;
  current_candidate_at_import_sha256: string;
};

const testResponseEpisodeAuthority: ResponseEpisodeAuthority = {
  candidate_record_path: "ai_docs/ideation/.test-candidate.json",
  candidate_record_sha256: "a".repeat(64),
  response_record_path: "ai_docs/ideation/.test-response.json",
  response_record_sha256: "b".repeat(64),
  current_candidate_at_import_sha256: "c".repeat(64),
};

function successorWithReopenedEpisode(
  predecessor: IdeationState,
  maxReviewRounds = predecessor.max_review_rounds,
  authority: ResponseEpisodeAuthority = testResponseEpisodeAuthority,
): IdeationState {
  const successorBase = validateIdeationState({
    ...predecessor,
    revision: predecessor.revision + 1,
    predecessor_sha256: ideationStateSha256(predecessor),
    revision_kind: "non-answer",
    max_review_rounds: maxReviewRounds,
    readiness: { ...predecessor.readiness, status: "draft" },
    final_document_review: {
      schema: IDEATION_FINAL_REVIEW_SCHEMA,
      episodes: [],
      current_episode: null,
      rounds: [],
      current_round: null,
    },
  });
  const previousRound = predecessor.final_document_review.rounds.at(-1)!;
  const round = {
    ...previousRound,
    round: previousRound.round + 1,
    subject: {
      ...previousRound.subject,
      subject_id: `review-subject-${previousRound.round + 1}`,
      semantic_revision: successorBase.revision,
      subject_sha256: ideationReviewSubjectSha256(successorBase),
      predecessor_subject_sha256: previousRound.subject.subject_sha256,
    },
    results: [],
  };
  const episode = {
    episode: predecessor.final_document_review.episodes.length + 1,
    first_round: round.round,
    semantic_revision: successorBase.revision,
    subject_sha256: round.subject.subject_sha256,
    predecessor_episode_sha256: finalDocumentReviewEpisodeSha256(
      predecessor.final_document_review,
      predecessor.final_document_review.current_episode!,
    ),
    predecessor_state_sha256: ideationStateSha256(predecessor),
    predecessor_candidate_record_path: authority?.candidate_record_path ?? null,
    predecessor_candidate_record_sha256:
      authority?.candidate_record_sha256 ?? null,
    predecessor_response_record_path: authority?.response_record_path ?? null,
    predecessor_response_record_sha256:
      authority?.response_record_sha256 ?? null,
    predecessor_import_current_candidate_sha256:
      authority?.current_candidate_at_import_sha256 ?? null,
  };
  return validateIdeationState({
    ...successorBase,
    readiness: predecessor.readiness,
    final_document_review: {
      schema: IDEATION_FINAL_REVIEW_SCHEMA,
      episodes: [...predecessor.final_document_review.episodes, episode],
      current_episode: episode.episode,
      rounds: [...predecessor.final_document_review.rounds, round],
      current_round: round.round,
    },
  });
}

function alterInheritedReviewHistory(successor: IdeationState): IdeationState {
  const inheritedRound = successor.final_document_review.rounds[0]!;
  const original = inheritedRound.results[0]!;
  const alteredEvidence: FinalDocumentReviewResult = {
    ...original,
    limitations: ["Altered after predecessor persistence."],
  };
  const resultSha256 = hashRawBytes(
    Buffer.from(
      canonicalJson(finalDocumentReviewResultEvidence(alteredEvidence)),
      "utf8",
    ),
  );
  const altered = {
    ...alteredEvidence,
    result_sha256: resultSha256,
    result_path: ideationReviewResultPath(successor.slug, resultSha256),
  };
  return validateIdeationState({
    ...successor,
    final_document_review: {
      ...successor.final_document_review,
      rounds: [
        {
          ...inheritedRound,
          results: [altered, ...inheritedRound.results.slice(1)],
        },
        ...successor.final_document_review.rounds.slice(1),
      ],
    },
  });
}

async function persistSubstantiveReviewEvidence(
  repositoryRoot: string,
  stateInput = readyState(),
) {
  const state = materializeSubstantiveReviewState(stateInput);
  await persistIdeationSubstantiveReviewResults({
    repository_root: repositoryRoot,
    state,
  });
  return state;
}

async function persistReadyState(
  repositoryRoot: string,
  stateInput = readyState(),
) {
  const state = await persistSubstantiveReviewEvidence(
    repositoryRoot,
    stateInput,
  );
  await persistIdeationState({ repository_root: repositoryRoot, state });
  return state;
}

function candidateFromRecord(value: unknown): CandidateBinding {
  if (value === null || typeof value !== "object" || !("candidate" in value))
    throw new TypeError("missing candidate record binding");
  return validateCandidateBinding(value.candidate);
}

describe("Ideation closed-state runtime", () => {
  test("validates only closed reviewer-result fields and immutable result path bindings", () => {
    expect(DEFAULT_IDEATION_MAX_REVIEW_ROUNDS).toBe(3);
    expect(readyState().final_document_review.rounds[0]?.results).toHaveLength(
      4,
    );
    expect(() =>
      validateIdeationState({
        ...(fixture.state as Record<string, unknown>),
        unexpected: true,
      }),
    ).toThrow("unknown field");
    const raw = fixture.state as {
      readonly commitment_critique: { readonly critics: readonly unknown[] };
    };
    expect(() =>
      validateIdeationState({
        ...raw,
        commitment_critique: {
          ...raw.commitment_critique,
          critics: [raw.commitment_critique.critics[0]],
        },
      }),
    ).toThrow("exactly two critics");
    const state = readyState();
    const round = state.final_document_review.rounds[0]!;
    expect(() =>
      validateIdeationState({
        ...state,
        final_document_review: {
          ...state.final_document_review,
          rounds: [
            {
              ...round,
              results: [
                {
                  ...round.results[0]!,
                  result_path: "ai_docs/ideation/unbound.json",
                },
                ...round.results.slice(1),
              ],
            },
          ],
        },
      }),
    ).toThrow("immutable review result path");
    expect(() =>
      validateIdeationState({
        ...state,
        final_document_review: {
          ...state.final_document_review,
          rounds: [
            {
              ...round,
              results: [
                { ...round.results[0]!, review_subject_sha256: "f".repeat(64) },
                ...round.results.slice(1),
              ],
            },
          ],
        },
      }),
    ).toThrow("stale review subject");
    expect(() =>
      validateIdeationState({ ...state, title: "Mutated semantic subject" }),
    ).toThrow("latest review subject must bind the current semantic revision");
  });
  test("persists canonical state without generating HTML and renders immutable support", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-support-"));
    try {
      const persisted = await persistReadyState(root, readyState());
      expect(
        await readFile(
          join(root, ideationStatePath(readyState().slug)),
          "utf8",
        ),
      ).toContain('"schema":"ideation-with-critique/state/v8"');
      await expect(
        readFile(
          join(root, `ai_docs/ideation/${readyState().slug}.workbench.html`),
        ),
      ).rejects.toThrow();
      const support = await createIdeationSupportDossier({
        repository_root: root,
        state_snapshot_path: `ai_docs/ideation/.${persisted.slug}.state-${ideationStateSha256(persisted)}.json`,
        trigger: "explicit-request",
        implementation_root: implementationRoot,
      });
      expect(support.record.artifact_kind).toBe("non-authoritative-support");
      expect(support.record.covered_exchange_ids).toEqual([]);
      const html = await readFile(join(root, support.html_path), "utf8");
      expect(html).toContain("Non-authoritative support");
      expect(html).toContain("Support only.");
      const reopened = await reopenIdeationSupportDossier({
        repository_root: root,
        record_path: support.record_path,
        implementation_root: implementationRoot,
      });
      expect(reopened.outcome).toBe("adopted-identical");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("derives every substantive gate outcome from bound results and coverage", () => {
    const base = readyState();
    const mandatory = new Set(["C1"]);
    expect(
      deriveFinalDocumentReviewGate(
        base.final_document_review,
        mandatory,
        base.max_review_rounds,
      ).outcome,
    ).toBe("PASS");
    const round = base.final_document_review.rounds[0]!;
    const incomplete = validateIdeationState({
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [{ ...round, results: round.results.slice(1) }],
      },
    });
    expect(
      deriveFinalDocumentReviewGate(
        incomplete.final_document_review,
        mandatory,
        incomplete.max_review_rounds,
      ).outcome,
    ).toBe("INCOMPLETE");
    const unresolved = validateIdeationState({
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [
          {
            ...round,
            results: [
              { ...round.results[0]!, verdict: "UNRESOLVED" as const },
              ...round.results.slice(1),
            ],
          },
        ],
      },
    });
    expect(
      deriveFinalDocumentReviewGate(
        unresolved.final_document_review,
        mandatory,
        unresolved.max_review_rounds,
      ).outcome,
    ).toBe("UNRESOLVED");
    const uncovered = validateIdeationState({
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [
          {
            ...round,
            results: round.results.map((result) => ({
              ...result,
              assessed_criteria_ids: [],
            })),
          },
        ],
      },
    });
    const blockingVerdict = validateIdeationState({
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [
          {
            ...round,
            results: [
              { ...round.results[0]!, verdict: "BLOCK" as const },
              ...round.results.slice(1),
            ],
          },
        ],
      },
    });
    expect(
      deriveFinalDocumentReviewGate(
        blockingVerdict.final_document_review,
        mandatory,
        blockingVerdict.max_review_rounds,
      ).outcome,
    ).toBe("BLOCK");
    expect(
      deriveFinalDocumentReviewGate(
        uncovered.final_document_review,
        mandatory,
        uncovered.max_review_rounds,
      ).outcome,
    ).toBe("INCOMPLETE");
  });

  test("requires current PASS for readiness and prevents deferred blocking-finding bypass", () => {
    const base = readyState();
    const round = base.final_document_review.rounds[0]!;
    const blockingFinding = {
      stable_id: "RF-risk",
      occurrence_id: "RO1",
      severity: "blocking",
      affected_criteria_ids: ["C1"],
      affected_semantic_ids: ["G1"],
      evidence_ids: ["E1"],
      failure_mechanism: "The failure path is unspecified.",
      recommendation: "Specify recovery behavior.",
      disposition: "deferred",
      duplicate_of: null,
      recurrence_of: null,
      regression_of: null,
      caused_by: null,
      supersedes: null,
    } satisfies FinalDocumentReviewFinding;
    const blockedState = {
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [
          {
            ...round,
            results: [
              { ...round.results[0]!, findings: [blockingFinding] },
              ...round.results.slice(1),
            ],
          },
        ],
      },
    };
    const blocked = validateIdeationState(blockedState);
    expect(
      deriveFinalDocumentReviewGate(
        blocked.final_document_review,
        new Set(["C1"]),
        blocked.max_review_rounds,
      ).outcome,
    ).toBe("BLOCK");
    expect(() =>
      validateIdeationState({
        ...blockedState,
        readiness: {
          ...blockedState.readiness,
          status: "ready-for-approval" as const,
        },
      }),
    ).toThrow("current substantive review PASS unless a response-driven later episode preserves readiness");
    expect(
      deriveFinalDocumentReviewGate(
        base.final_document_review,
        new Set(["C1"]),
        1,
      ).cap_exhausted,
    ).toBe(false);
  });

  test("requires successor lineage for deferred blocking findings", () => {
    const base = readyState();
    const firstRound = base.final_document_review.rounds[0]!;
    const blockingFinding = {
      stable_id: "RF-deferred",
      occurrence_id: "RO-deferred-1",
      severity: "blocking",
      affected_criteria_ids: ["C1"],
      affected_semantic_ids: ["G1"],
      evidence_ids: ["E1"],
      failure_mechanism: "The failure path is unspecified.",
      recommendation: "Specify recovery behavior.",
      disposition: "deferred",
      duplicate_of: null,
      recurrence_of: null,
      regression_of: null,
      caused_by: null,
      supersedes: null,
    } satisfies FinalDocumentReviewFinding;
    const blocked = validateIdeationState({
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [
          {
            ...firstRound,
            results: [
              { ...firstRound.results[0]!, findings: [blockingFinding] },
              ...firstRound.results.slice(1),
            ],
          },
        ],
      },
    });
    const revisedSemantic = validateIdeationState({
      ...blocked,
      revision: 2,
      predecessor_sha256: ideationStateSha256(blocked),
      title: "Revised review workflow",
      final_document_review: {
        ...blocked.final_document_review,
        episodes: [],
        current_episode: null,
        rounds: [],
        current_round: null,
      },
    });
    const successorSubjectSha256 = ideationReviewSubjectSha256(revisedSemantic);
    const resultHashes = [
      "5".repeat(64),
      "6".repeat(64),
      "7".repeat(64),
      "8".repeat(64),
    ];
    const successorResults = firstRound.results.map((result, index) => ({
      ...result,
      review_subject_sha256: successorSubjectSha256,
      result_sha256: resultHashes[index]!,
      result_path: ideationReviewResultPath(base.slug, resultHashes[index]!),
      findings: [],
    }));
    const successorRound = {
      ...firstRound,
      round: 2,
      subject: {
        subject_id: "review-subject-2",
        semantic_revision: 2,
        subject_sha256: successorSubjectSha256,
        predecessor_subject_sha256: firstRound.subject.subject_sha256,
      },
      results: successorResults,
    };
    expect(() =>
      validateIdeationState({
        ...revisedSemantic,
        final_document_review: {
          ...revisedSemantic.final_document_review,
          episodes: blocked.final_document_review.episodes,
          current_episode: 1,
          rounds: [blocked.final_document_review.rounds[0]!, successorRound],
          current_round: 2,
        },
      }),
    ).toThrow("carry or explicitly resolve pending finding");
  });

  test("treats advisory deferred findings as unresolved and mandatory carry-forward", () => {
    const base = readyState();
    const round = base.final_document_review.rounds[0]!;
    const finding = {
      stable_id: "RF-advisory",
      occurrence_id: "RO-advisory-1",
      severity: "advisory",
      affected_criteria_ids: ["C1"],
      affected_semantic_ids: ["G1"],
      evidence_ids: ["E1"],
      failure_mechanism: "An advisory edge remains deferred.",
      recommendation: "Resolve the edge before approval.",
      disposition: "deferred",
      duplicate_of: null,
      recurrence_of: null,
      regression_of: null,
      caused_by: null,
      supersedes: null,
    } satisfies FinalDocumentReviewFinding;
    const deferred = validateIdeationState({
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [
          {
            ...round,
            results: [
              {
                ...round.results[0]!,
                verdict: "PASS" as const,
                findings: [finding],
              },
              ...round.results.slice(1),
            ],
          },
        ],
      },
    });
    expect(
      deriveFinalDocumentReviewGate(
        deferred.final_document_review,
        new Set(["C1"]),
        deferred.max_review_rounds,
      ).outcome,
    ).toBe("UNRESOLVED");
    expect(() => successorWithAppendedReview(deferred)).toThrow(
      "carry or explicitly resolve pending finding RF-advisory",
    );
  });

  test("rejects non-predecessor finding lineage and duplicate occurrence identifiers", () => {
    const base = readyState();
    const round = base.final_document_review.rounds[0]!;
    const first = {
      stable_id: "RF-risk",
      occurrence_id: "RO1",
      severity: "advisory",
      affected_criteria_ids: ["C1"],
      affected_semantic_ids: ["G1"],
      evidence_ids: ["E1"],
      failure_mechanism: "An edge case is unspecified.",
      recommendation: "Define the boundary.",
      disposition: "accepted",
      duplicate_of: null,
      recurrence_of: null,
      regression_of: null,
      caused_by: null,
      supersedes: null,
    } satisfies FinalDocumentReviewFinding;
    const recurrence = {
      ...first,
      occurrence_id: "RO2",
      recurrence_of: "RO1",
      disposition: "open" as const,
    } satisfies FinalDocumentReviewFinding;
    const invalid = {
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [
          {
            ...round,
            results: [
              { ...round.results[0]!, findings: [first] },
              { ...round.results[1]!, findings: [recurrence] },
              ...round.results.slice(2),
            ],
          },
        ],
      },
    };
    expect(() => validateIdeationState(invalid)).toThrow(
      "immutable predecessor-round occurrence",
    );
  });

  test("accepts trigger-bound specialists and rejects retired or untriggered roles", () => {
    const base = readyState();
    const round = base.final_document_review.rounds[0]!;
    const specialist = {
      reviewer_id: "reviewer-specialist",
      assignment_role: "application-security",
      selector: "pi/slow",
      model: "pi/slow",
      provider: "cliproxy",
      blind: true,
      assignment_kind: "specialist",
      primary_domain: "security",
      secondary_domains: ["abuse-cases"],
      artifact_access: ["candidate-html", "markdown", "state"],
      shared_invariant_ids: ["I1", "I2"],
      specialist_trigger: {
        trigger_id: "T-security",
        evidence: "Abuse-case evidence E1 requires specialist review.",
      },
    } satisfies FinalDocumentReviewAssignment;
    const withSpecialist = {
      ...base,
      readiness: { ...base.readiness, status: "draft" as const },
      final_document_review: {
        ...base.final_document_review,
        rounds: [{ ...round, reviewers: [...round.reviewers, specialist] }],
      },
    };
    expect(
      validateIdeationState(withSpecialist).final_document_review.rounds[0]
        ?.reviewers,
    ).toHaveLength(5);
    const untriggered = { ...specialist, specialist_trigger: null };
    expect(() =>
      validateIdeationState({
        ...withSpecialist,
        final_document_review: {
          ...withSpecialist.final_document_review,
          rounds: [{ ...round, reviewers: [...round.reviewers, untriggered] }],
        },
      }),
    ).toThrow();
    const retired = {
      ...round.reviewers[0]!,
      assignment_role: "architecture-integration",
    };
    expect(() =>
      validateIdeationState({
        ...base,
        final_document_review: {
          ...base.final_document_review,
          rounds: [
            { ...round, reviewers: [retired, ...round.reviewers.slice(1)] },
          ],
        },
      }),
    ).toThrow();
  });

  test("parses the final review cap option exactly", () => {
    expect(parseIdeationInvocation("Review workflow quality")).toEqual({
      idea: "Review workflow quality",
      max_review_rounds: 3,
    });
    expect(
      parseIdeationInvocation("Review workflow quality max_review_rounds=5"),
    ).toEqual({
      idea: "Review workflow quality",
      max_review_rounds: 5,
    });
    for (const invocation of [
      "Review max_review_rounds=0",
      "Review max_review_rounds=6",
      "Review max_review_rounds=1.5",
      "Review max_review_rounds=NaN",
      "Review max_review_rounds=2 extra",
      "Review max_review_rounds=2 max_review_rounds=3",
    ])
      expect(() => parseIdeationInvocation(invocation)).toThrow();
  });

  test("renders deterministic Markdown with final-document review evidence", () => {
    const first = renderIdeationMarkdown(readyState());
    const second = renderIdeationMarkdown(readyState());
    expect(Buffer.compare(first, second)).toBe(0);
    const markdown = Buffer.from(first).toString("utf8");
    expect(markdown).toContain("## Final Document Review");
    expect(markdown).toContain(
      "Configured maximum substantive review rounds: 5",
    );
    expect(markdown).toContain("simplicity-maintainability");
    expect(markdown).toContain("PASS");
    expect(markdown).not.toContain("## Deep-Scope Handoff");
  });

  test("projects state visuals into hash-bound native dossier visuals", async () => {
    const state = readyState();
    const visuals = createIdeationNativeVisuals(state);
    const visualSet = createIdeationVisualSet(state);
    expect(visuals).toHaveLength(1);
    expect(visuals[0]).toMatchObject({
      visual_id: "V1",
      type: "comparison",
      title: "First-release boundary",
      units: "scope flags",
    });
    expect(visualSet.visuals).toEqual([
      { visual_id: "V1", type: "comparison", sha256: visuals[0]!.sha256 },
    ]);

    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const persistedState = await persistReadyState(root, state);
      const candidate = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(persistedState.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const html = await readFile(
        join(root, candidate.candidate_html_path),
        "utf8",
      );
      expect(html).toContain("<svg");
      expect(html).toContain("First-release boundary");
      expect(html).toContain("Style feedback: included 1, excluded 0");
      expect(html).not.toContain("No candidate-bound visual aid was supplied");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a ready state is missing or has tampered substantive result bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const materialized = materializeSubstantiveReviewState();
      await expect(
        persistIdeationState({ repository_root: root, state: materialized }),
      ).rejects.toThrow();
      await persistIdeationSubstantiveReviewResults({
        repository_root: root,
        state: materialized,
      });
      await expect(
        persistIdeationState({
          repository_root: root,
          state: {
            ...materialized,
            title: "Materially changed review subject",
          },
        }),
      ).rejects.toThrow("latest review subject");
      await persistIdeationState({
        repository_root: root,
        state: materialized,
      });
      const result = materialized.final_document_review.rounds[0]!.results[0]!;
      await writeFile(join(root, result.result_path), "tampered");
      await expect(
        persistIdeationState({ repository_root: root, state: materialized }),
      ).rejects.toThrow("substantive review result hash mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("atomically adopts identical immutable evidence and rejects an occupied collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const state = await persistReadyState(root, readyState());
      const first = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(state.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const second = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(state.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      expect(first.outcome).toBe("created");
      expect(second).toEqual({ ...first, outcome: "adopted-identical" });
      await writeFile(
        join(root, first.candidate_html_path),
        "occupied by incompatible bytes",
      );
      await expect(
        createIdeationCandidateFromSavedState({
          repository_root: root,
          state_path: ideationStatePath(state.slug),
          submitted_at: "2026-08-03T00:00:00Z",
        }),
      ).rejects.toThrow();
      await expect(
        createIdeationCandidateFromSavedState({
          repository_root: root,
          state_path: "../outside.state.json",
          submitted_at: "2026-08-03T00:00:00Z",
        }),
      ).rejects.toThrow("PATH_ESCAPE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists only adjacent same-run revisions with exact inherited review history", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const initial = blockedReviewState();
      await persistIdeationSubstantiveReviewResults({
        repository_root: root,
        state: initial,
      });
      await persistIdeationState({ repository_root: root, state: initial });
      const successor = successorWithAppendedReview(initial);
      await expect(
        persistIdeationState({
          repository_root: root,
          state: alterInheritedReviewHistory(successor),
        }),
      ).rejects.toThrow(
        "complete immutable predecessor review episode history",
      );
      await expect(
        persistIdeationState({ repository_root: root, state: successor }),
      ).resolves.toBeDefined();
      const skipped = validateIdeationState({
        ...successor,
        title: "Skipped predecessor",
        revision: 3,
        predecessor_sha256: ideationStateSha256(initial),
        final_document_review: {
          ...successor.final_document_review,
          episodes: [],
          current_episode: null,
          rounds: [],
          current_round: null,
        },
      });
      await expect(
        persistIdeationState({ repository_root: root, state: skipped }),
      ).rejects.toThrow("adjacent immutable predecessor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps reconciliation read-only and recovers only the identical proposed genesis or orphan successor", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const genesis = blockedReviewState();
      await persistIdeationSubstantiveReviewResults({ repository_root: root, state: genesis });
      await persistIdeationState({ repository_root: root, state: genesis });
      const statePath = join(root, ideationStatePath(genesis.slug));
      await rm(statePath);
      await expect(reconcileCurrentIdeationStateAuthority(root, genesis.slug)).rejects.toThrow("missing mutable current head");
      await expect(createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(genesis.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      })).rejects.toThrow("missing mutable current head");
      await expect(readFile(statePath)).rejects.toThrow();
      await persistIdeationState({ repository_root: root, state: genesis });
      expect(await readFile(statePath, "utf8")).toBe(canonicalJson(genesis));

      const successor = successorWithAppendedReview(genesis);
      await persistIdeationState({ repository_root: root, state: successor });
      await writeFile(statePath, canonicalJson(genesis));
      await expect(reconcileCurrentIdeationStateAuthority(root, genesis.slug)).rejects.toThrow("rolled back from immutable lineage tip");
      await expect(createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(genesis.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      })).rejects.toThrow("rolled back from immutable lineage tip");
      expect(await readFile(statePath, "utf8")).toBe(canonicalJson(genesis));
      await expect(persistIdeationState({ repository_root: root, state: genesis })).rejects.toThrow("rolled back from immutable lineage tip");
      expect(await readFile(statePath, "utf8")).toBe(canonicalJson(genesis));
      await persistIdeationState({ repository_root: root, state: successor });
      expect(await readFile(statePath, "utf8")).toBe(canonicalJson(successor));

      await writeFile(statePath, canonicalJson(genesis));
      const invalidOrphan = alterInheritedReviewHistory(successor);
      await rm(join(root, `ai_docs/ideation/.${genesis.slug}.state-${ideationStateSha256(successor)}.json`));
      const orphanPath = join(root, `ai_docs/ideation/.${genesis.slug}.state-${ideationStateSha256(invalidOrphan)}.json`);
      await writeFile(orphanPath, canonicalJson(invalidOrphan));
      await expect(
        reconcileCurrentIdeationStateAuthority(root, genesis.slug),
      ).rejects.toThrow("complete immutable predecessor review episode history");
      await expect(persistIdeationState({ repository_root: root, state: invalidOrphan })).rejects.toThrow("complete immutable predecessor review episode history");
      expect(await readFile(statePath, "utf8")).toBe(canonicalJson(genesis));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  test("preserves a PASS episode when changes-requested reopens substantive review", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const state = await persistReadyState(root);
      const persistedCandidate = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(state.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const candidate = candidateFromRecord(
        JSON.parse(
          await readFile(
            join(root, persistedCandidate.candidate_record_path),
            "utf8",
          ),
        ),
      );
      const markdown = renderIdeationMarkdown(state);
      const draft = createApprovalResponse({
        candidate,
        approval_status: "draft",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: null,
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const responseValue = createApprovalResponse({
        candidate,
        approval_status: "changes-requested",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:01:00Z",
        approved_at: null,
        feedback: [
          {
            feedback_id: "feedback-1",
            kind: "edit",
            target: { target_type: "semantic-id", semantic_id: "G1" },
            requested_change: "Clarify the recovery goal.",
            rationale: "The approval candidate is incomplete.",
            evidence_ids: ["E1"],
          },
        ],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const alteredEnvelope = await renderApprovalDossier({
        title: "Changed Ideation dossier",
        candidate,
        approval: responseValue,
        visual_set: createIdeationVisualSet(state),
        visuals: createIdeationNativeVisuals(state),
        feedback_targets: [],
        review_presentations: [],
      });
      await writeFile(
        join(root, "altered-envelope.html"),
        alteredEnvelope.bytes,
      );
      await expect(
        importIdeationResponseFromSavedPath({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          saved_html_path: "altered-envelope.html",
        }),
      ).rejects.toThrow("DOSSIER_ENVELOPE_INVALID");
      const candidateHtml = await readFile(
        join(root, persistedCandidate.candidate_html_path),
        "utf8",
      );
      const savedBytes = Buffer.from(
        candidateHtml.replace(
          encodeProtectedApprovalPayload(draft),
          encodeProtectedApprovalPayload(responseValue),
        ),
        "utf8",
      );
      await writeFile(join(root, "changes-requested.html"), savedBytes);
      const response = await importIdeationResponseFromSavedPath({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        saved_html_path: "changes-requested.html",
      });
      expect(response.approval_status).toBe("changes-requested");
      await expect(
        recoverIdeationAuthority({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow();
      const rejected = createApprovalResponse({
        candidate,
        approval_status: "rejected",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:02:00Z",
        approved_at: null,
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const rejectedBytes = Buffer.from(
        candidateHtml.replace(
          encodeProtectedApprovalPayload(draft),
          encodeProtectedApprovalPayload(rejected),
        ),
        "utf8",
      );
      await writeFile(join(root, "rejected.html"), rejectedBytes);
      const rejectedResponse = await importIdeationResponseFromSavedPath({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        saved_html_path: "rejected.html",
      });
      expect(rejectedResponse.approval_status).toBe("rejected");
      await expect(
        recoverIdeationAuthority({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: rejectedResponse.response_record_path,
        }),
      ).rejects.toThrow();
      const successor = successorWithReopenedEpisode(
        state,
        state.max_review_rounds,
        {
          candidate_record_path: persistedCandidate.candidate_record_path,
          candidate_record_sha256: hashRawBytes(
            await readFile(
              join(root, persistedCandidate.candidate_record_path),
            ),
          ),
          response_record_path: response.response_record_path,
          response_record_sha256: hashRawBytes(
            await readFile(join(root, response.response_record_path)),
          ),
          current_candidate_at_import_sha256:
            response.current_candidate_at_import_sha256,
        },
      );
      expect(successor.final_document_review.episodes).toHaveLength(2);
      expect(
        deriveFinalDocumentReviewGate(
          successor.final_document_review,
          new Set(["C1"]),
          successor.max_review_rounds,
        ).outcome,
      ).toBe("INCOMPLETE");
      await expect(
        persistIdeationState({ repository_root: root, state: successor }),
      ).resolves.toBeDefined();
      await expect(
        createIdeationCandidateFromSavedState({
          repository_root: root,
          state_path: ideationStatePath(successor.slug),
          submitted_at: "2026-08-03T00:02:00Z",
        }),
      ).rejects.toThrow("current substantive review PASS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("rejects increasing max_review_rounds across an adjacent successor", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const predecessor = await persistReadyState(root, readyState(1));
      const successor = successorWithReopenedEpisode(predecessor, 2);
      await expect(
        persistIdeationState({ repository_root: root, state: successor }),
      ).rejects.toThrow("max_review_rounds is immutable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds candidate identity to the exact loaded renderer snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      const state = await persistReadyState(root);
      const persisted = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(state.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const candidate = candidateFromRecord(
        JSON.parse(
          await readFile(join(root, persisted.candidate_record_path), "utf8"),
        ),
      );
      const snapshot = await loadApprovalDossierRendererSnapshot();
      expect(candidate.runtime_sha256).toBe(snapshot.sha256);
      const alteredManifest = {
        ...snapshot.manifest,
        entries: snapshot.manifest.entries.map((entry) =>
          entry.path === "templates/dossier.css"
            ? { ...entry, sha256: "f".repeat(64) }
            : entry,
        ),
      };
      const alteredSnapshotSha256 = hashCanonicalJson(alteredManifest);
      expect(alteredSnapshotSha256).not.toBe(snapshot.sha256);
      const alteredRuntime = createIdeationRuntimeBinding(
        alteredSnapshotSha256,
      );
      expect(alteredRuntime.runtime_sha256).toBe(alteredSnapshotSha256);
      const alteredCandidate = validateCandidateBinding({
        ...candidate,
        runtime_sha256: alteredRuntime.runtime_sha256,
      });
      expect(candidateSha256(alteredCandidate)).not.toBe(
        candidateSha256(candidate),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects static symlinked authority parents and saved-response leaves", async () => {
    const state = materializeSubstantiveReviewState();
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    const outside = await mkdtemp(join(tmpdir(), "ideation-outside-"));
    try {
      await symlink(outside, join(root, "ai_docs"));
      await expect(
        persistIdeationState({ repository_root: root, state }),
      ).rejects.toMatchObject({
        code: "IDEATION_LOCK_IO_FAILURE",
        slug: state.slug,
        path: `ai_docs/ideation/.${state.slug}.lineage.lock`,
        operation: "open",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }

    const safeRoot = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    const safeOutside = await mkdtemp(join(tmpdir(), "ideation-outside-"));
    try {
      const materializedState = await persistReadyState(safeRoot, state);
      const persistedCandidate = await createIdeationCandidateFromSavedState({
        repository_root: safeRoot,
        state_path: ideationStatePath(materializedState.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const candidate = candidateFromRecord(
        JSON.parse(
          await readFile(
            join(safeRoot, persistedCandidate.candidate_record_path),
            "utf8",
          ),
        ),
      );
      const markdown = renderIdeationMarkdown(materializedState);
      const draft = createApprovalResponse({
        candidate,
        approval_status: "draft",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: null,
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const approval = createApprovalResponse({
        candidate,
        approval_status: "approved",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:01:00Z",
        approved_at: "2026-08-03T00:01:00Z",
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const candidateHtml = await readFile(
        join(safeRoot, persistedCandidate.candidate_html_path),
        "utf8",
      );
      const saved = Buffer.from(
        candidateHtml.replace(
          encodeProtectedApprovalPayload(draft),
          encodeProtectedApprovalPayload(approval),
        ),
        "utf8",
      );
      await writeFile(join(safeOutside, "saved-response.html"), saved);
      await symlink(
        join(safeOutside, "saved-response.html"),
        join(safeRoot, "saved-response.html"),
      );
      await expect(
        importIdeationResponseFromSavedPath({
          repository_root: safeRoot,
          candidate_record_path: persistedCandidate.candidate_record_path,
          saved_html_path: "saved-response.html",
        }),
      ).rejects.toThrow("PATH_ESCAPE");
      await rm(join(safeRoot, "saved-response.html"));
      await writeFile(join(safeRoot, "saved-response.html"), saved);
      await writeFile(
        join(safeRoot, persistedCandidate.candidate_html_path),
        "tampered candidate",
      );
      await expect(
        importIdeationResponseFromSavedPath({
          repository_root: safeRoot,
          candidate_record_path: persistedCandidate.candidate_record_path,
          saved_html_path: "saved-response.html",
        }),
      ).rejects.toThrow("candidate HTML hash mismatch");
    } finally {
      await rm(safeRoot, { recursive: true, force: true });
      await rm(safeOutside, { recursive: true, force: true });
    }
  });

  test("publishes directly from reopened approved response and substantive authority", async () => {
    let state = readyState();
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      state = await persistReadyState(root, state);
      const persistedCandidate = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(state.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const substantiveAuthorityPath =
        persistedCandidate.substantive_review_authority.path;
      const substantiveAuthorityBytes = await readFile(
        join(root, substantiveAuthorityPath),
      );
      await rm(join(root, substantiveAuthorityPath));
      await expect(
        importIdeationResponseFromSavedPath({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          saved_html_path: persistedCandidate.candidate_html_path,
        }),
      ).rejects.toThrow();
      await writeFile(
        join(root, substantiveAuthorityPath),
        substantiveAuthorityBytes,
      );
      const candidate = candidateFromRecord(
        JSON.parse(
          await readFile(
            join(root, persistedCandidate.candidate_record_path),
            "utf8",
          ),
        ),
      );
      const markdown = renderIdeationMarkdown(state);
      const draft = createApprovalResponse({
        candidate,
        approval_status: "draft",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: null,
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const approval = createApprovalResponse({
        candidate,
        approval_status: "approved",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: "2026-08-03T00:01:00Z",
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const candidateHtml = await readFile(
        join(root, persistedCandidate.candidate_html_path),
        "utf8",
      );
      const savedBytes = Buffer.from(
        candidateHtml.replace(
          encodeProtectedApprovalPayload(draft),
          encodeProtectedApprovalPayload(approval),
        ),
        "utf8",
      );
      await writeFile(join(root, "saved-response.html"), savedBytes);
      const response = await importIdeationResponseFromSavedPath({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        saved_html_path: "saved-response.html",
      });
      await writeFile(
        join(root, substantiveAuthorityPath),
        "tampered substantive authority",
      );
      await expect(
        recoverIdeationAuthority({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow();
      await expect(
        publishIdeationMarkdownFromSavedRecords({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow();
      await writeFile(
        join(root, substantiveAuthorityPath),
        substantiveAuthorityBytes,
      );
      const recoveredBeforePublication = await recoverIdeationAuthority({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        response_record_path: response.response_record_path,
      });
      expect(recoveredBeforePublication.publication).toBeNull();
      const publication = await publishIdeationMarkdownFromSavedRecords({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        response_record_path: response.response_record_path,
      });
      expect(
        Buffer.compare(
          await readFile(join(root, "ai_docs/ideation/code-review-tool.md")),
          markdown,
        ),
      ).toBe(0);
      expect(publication.receipt.schema).toBe(PUBLICATION_RECEIPT_SCHEMA);
      expect(publication.receipt.substantive_review_authority).toEqual(
        persistedCandidate.substantive_review_authority,
      );
      const handoff = await createDeepScopeHandoffFromSavedAuthority({
        repository_root: root,
        slug: state.slug,
      });
      expect(handoff.markdown_path).toBe(fixture.expected.markdown_path);
      expect(handoff.receipt_path).toBe(fixture.expected.receipt_path);
      expect(handoff.workflow).toBe(fixture.expected.workflow);
      expect(handoff.max_review_rounds).toBe(5);
      expect(handoff.candidate_subject_sha256).toBe(
        candidateReviewSubjectSha256(candidate),
      );
      expect(handoff.substantive_review_authority).toEqual(
        persistedCandidate.substantive_review_authority,
      );
      expect(Object.keys(handoff).sort()).toEqual(
        [...fixture.expected.mandatory_provenance_fields].sort(),
      );
      expect(Object.keys(handoff)).not.toContain("html");
      await expect(
        publishIdeationMarkdownFromSavedRecords({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
          unexpected: true,
        } as Parameters<typeof publishIdeationMarkdownFromSavedRecords>[0]),
      ).rejects.toThrow("unknown field");
      await rm(join(root, substantiveAuthorityPath));
      await expect(
        recoverIdeationAuthority({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow();
      await writeFile(
        join(root, substantiveAuthorityPath),
        substantiveAuthorityBytes,
      );
      const recovered = await recoverIdeationAuthority({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        response_record_path: response.response_record_path,
      });
      expect(recovered.publication?.approved_html_evidence_path).toBe(
        response.approved_html_evidence_path,
      );
      await writeFile(
        join(root, response.approved_html_evidence_path),
        "tampered",
      );
      await expect(
        recoverIdeationAuthority({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow("response HTML hash mismatch");
      await writeFile(
        join(root, persistedCandidate.candidate_html_path),
        "tampered candidate",
      );
      await expect(
        recoverIdeationAuthority({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow("candidate HTML hash mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("aborts publication when canonical state changes during the commit window", async () => {
    let state = readyState();
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-race-"));
    try {
      state = await persistReadyState(root, state);
      const persistedCandidate = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(state.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const candidate = candidateFromRecord(
        JSON.parse(
          await readFile(
            join(root, persistedCandidate.candidate_record_path),
            "utf8",
          ),
        ),
      );
      const markdown = renderIdeationMarkdown(state);
      const draft = createApprovalResponse({
        candidate,
        approval_status: "draft",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: null,
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const approval = createApprovalResponse({
        candidate,
        approval_status: "approved",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: "2026-08-03T00:01:00Z",
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const candidateHtml = await readFile(
        join(root, persistedCandidate.candidate_html_path),
        "utf8",
      );
      await writeFile(
        join(root, "saved-response.html"),
        candidateHtml.replace(
          encodeProtectedApprovalPayload(draft),
          encodeProtectedApprovalPayload(approval),
        ),
      );
      const response = await importIdeationResponseFromSavedPath({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        saved_html_path: "saved-response.html",
      });
      const successor = successorWithReopenedEpisode(state);
      ideationRuntimeHooks.before_publication_commit = async () => {
        await writeFile(
          join(root, ideationStatePath(successor.slug)),
          canonicalJson(successor),
        );
        await writeFile(
          join(
            root,
            `ai_docs/ideation/.${successor.slug}.state-${ideationStateSha256(successor)}.json`,
          ),
          canonicalJson(successor),
        );
      };
      await expect(
        publishIdeationMarkdownFromSavedRecords({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow("candidate state changed during publication");
      await expect(
        readFile(join(root, "ai_docs/ideation/code-review-tool.md")),
      ).rejects.toThrow();
    } finally {
      delete ideationRuntimeHooks.before_publication_commit;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an approved predecessor after canonical state advances", async () => {
    let state = readyState();
    const root = await mkdtemp(join(tmpdir(), "ideation-runtime-"));
    try {
      state = await persistReadyState(root, state);
      const persistedCandidate = await createIdeationCandidateFromSavedState({
        repository_root: root,
        state_path: ideationStatePath(state.slug),
        submitted_at: "2026-08-03T00:00:00Z",
      });
      const candidate = candidateFromRecord(
        JSON.parse(
          await readFile(
            join(root, persistedCandidate.candidate_record_path),
            "utf8",
          ),
        ),
      );
      const markdown = renderIdeationMarkdown(state);
      const draft = createApprovalResponse({
        candidate,
        approval_status: "draft",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: null,
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const approval = createApprovalResponse({
        candidate,
        approval_status: "approved",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:00:00Z",
        approved_at: "2026-08-03T00:01:00Z",
        feedback: [],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      const candidateHtml = await readFile(
        join(root, persistedCandidate.candidate_html_path),
        "utf8",
      );
      await writeFile(
        join(root, "saved-response.html"),
        candidateHtml.replace(
          encodeProtectedApprovalPayload(draft),
          encodeProtectedApprovalPayload(approval),
        ),
      );
      const response = await importIdeationResponseFromSavedPath({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        saved_html_path: "saved-response.html",
      });
      const returned = createApprovalResponse({
        candidate,
        approval_status: "changes-requested",
        approval_actor: "user",
        submitted_at: "2026-08-03T00:02:00Z",
        approved_at: null,
        feedback: [
          {
            feedback_id: "returned-change",
            kind: "edit",
            target: { target_type: "semantic-id", semantic_id: "D1" },
            requested_change: "Clarify the decision before approval.",
            rationale: "The current decision needs a precise boundary.",
            evidence_ids: [],
          },
        ],
        files: [{ path: candidate.files[0]!.path, bytes: markdown }],
      });
      await writeFile(
        join(root, "returned-response.html"),
        candidateHtml.replace(
          encodeProtectedApprovalPayload(draft),
          encodeProtectedApprovalPayload(returned),
        ),
      );
      const returnedResponse = await importIdeationResponseFromSavedPath({
        repository_root: root,
        candidate_record_path: persistedCandidate.candidate_record_path,
        saved_html_path: "returned-response.html",
      });
      const successor = successorWithReopenedEpisode(
        state,
        state.max_review_rounds,
        {
          candidate_record_path: persistedCandidate.candidate_record_path,
          candidate_record_sha256: hashRawBytes(
            await readFile(
              join(root, persistedCandidate.candidate_record_path),
            ),
          ),
          response_record_path: returnedResponse.response_record_path,
          response_record_sha256: hashRawBytes(
            await readFile(join(root, returnedResponse.response_record_path)),
          ),
          current_candidate_at_import_sha256:
            returnedResponse.current_candidate_at_import_sha256,
        },
      );
      await persistIdeationState({ repository_root: root, state: successor });
      await expect(
        publishIdeationMarkdownFromSavedRecords({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow(
        "candidate state is not the current canonical Ideation state",
      );
      await expect(
        recoverIdeationAuthority({
          repository_root: root,
          candidate_record_path: persistedCandidate.candidate_record_path,
          response_record_path: response.response_record_path,
        }),
      ).rejects.toThrow(
        "candidate state is not the current canonical Ideation state",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
