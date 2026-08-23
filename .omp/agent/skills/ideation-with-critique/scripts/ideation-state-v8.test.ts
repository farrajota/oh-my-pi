import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IDEATION_EXCHANGE_ANSWER_MAX_UTF8_BYTES,
  IDEATION_EXCHANGE_EVIDENCE_MAX_COUNT,
  IDEATION_EXCHANGE_QUESTION_MAX_UTF8_BYTES,
  IDEATION_EXCHANGE_TARGET_MAX_COUNT,
  IDEATION_FINAL_REVIEW_SCHEMA,
  IDEATION_STATE_SCHEMA,
  deriveChangedExchangeTargets,
  deriveIdeationExchangeHistory,
  finalDocumentReviewEpisodeSha256,
  ideationReviewSubjectSha256,
  ideationStateSha256,
  validateIdeationState,
} from "../schemas/ideation-state.ts";
import { renderIdeationMarkdown } from "./ideation-projection.ts";
import {
  feedbackTargets,
  projectIdeationReviewPresentation,
  projectIdeationReviewPresentations,
} from "./ideation-projection.ts";
import {
  assertIdeationExchangeContentSafe,
  scanHighConfidenceSecrets,
} from "../../approval-dossier-runtime/scripts/content-safety.ts";

const fixturePath = join(
  import.meta.dir,
  "..",
  "fixtures",
  "ideation-to-deep-scope-receipt-preflight.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  state: Record<string, any>;
  expected: Record<string, any>;
};

function draftState(overrides: Record<string, unknown> = {}) {
  return validateIdeationState({
    ...fixture.state,
    schema: IDEATION_STATE_SCHEMA,
    revision: 1,
    predecessor_sha256: null,
    revision_kind: "non-answer",
    interview_exchanges: [],
    readiness: { ...fixture.state.readiness, status: "draft" },
    final_document_review: {
      schema: IDEATION_FINAL_REVIEW_SCHEMA,
      episodes: [],
      current_episode: null,
      rounds: [],
      current_round: null,
    },
    ...overrides,
  });
}

function presentation(state = draftState()) {
  return state.review_item_presentations[0]!;
}

function exchange(overrides: Record<string, unknown> = {}) {
  return {
    id: "Q1",
    exact_question: "Which boundary is accepted?",
    accepted_answer: "The first release remains bounded.",
    supersedes_exchange_id: null,
    affected_targets: [{ target_type: "state-field", field: "title" }],
    evidence_ids: ["E1"],
    ...overrides,
  };
}

describe("Ideation state/v8 schema", () => {
  test("accepts the canonical v8 fixture and rejects v7/unknown schemas", () => {
    expect(fixture.state.schema).toBe(IDEATION_STATE_SCHEMA);
    expect(() => validateIdeationState(fixture.state)).not.toThrow();
    expect(() =>
      validateIdeationState({
        ...fixture.state,
        schema: "ideation-with-critique/state/v7",
      }),
    ).toThrow(/schema/);
    expect(() =>
      validateIdeationState({
        ...fixture.state,
        schema: "ideation-with-critique/state/v1",
      }),
    ).toThrow(/schema/);
    expect(() =>
      validateIdeationState({ ...fixture.state, unexpected: true }),
    ).toThrow(/unknown field/);
  });

  test("enforces genesis and revision-kind truth table at schema boundary", () => {
    expect(() => draftState({ revision_kind: "accepted-answer" })).toThrow(
      /genesis/,
    );
    expect(() => draftState({ revision: 2, predecessor_sha256: null })).toThrow(
      /predecessor/,
    );
    const predecessor = draftState();
    const successor = {
      ...predecessor,
      revision: 2,
      predecessor_sha256: "a".repeat(64),
      revision_kind: "accepted-answer",
      interview_exchanges: [exchange()],
    };
    expect(() => validateIdeationState(successor)).not.toThrow();
    expect(() =>
      validateIdeationState({ ...successor, revision_kind: "non-answer" }),
    ).not.toThrow();
    expect(() =>
      validateIdeationState({
        ...successor,
        revision_kind: "accepted-answer",
        interview_exchanges: [],
      }),
    ).toThrow(/appended exchange/);
  });

  test("derives Q10 numerically, preserves exchange order, and enforces limits/order/supersession", () => {
    const exchanges = Array.from({ length: 10 }, (_, index) => ({
      ...exchange({
        id: `Q${index + 1}`,
        supersedes_exchange_id: index === 9 ? "Q8" : null,
      }),
      affected_targets: [{ target_type: "state-field", field: "title" }],
    }));
    const history = deriveIdeationExchangeHistory(exchanges as any);
    expect(history[7]!.active).toBe(false);
    expect(history[7]!.successor_exchange_id).toBe("Q10");
    expect(history[9]!.active).toBe(true);
    expect(() =>
      validateIdeationState({
        ...draftState(),
        revision: 2,
        predecessor_sha256: "a".repeat(64),
        revision_kind: "accepted-answer",
        interview_exchanges: exchanges,
      }),
    ).not.toThrow();
    expect(() =>
      validateIdeationState({
        ...draftState(),
        revision: 2,
        predecessor_sha256: "a".repeat(64),
        revision_kind: "accepted-answer",
        interview_exchanges: [
          {
            ...exchange(),
            exact_question: "x".repeat(
              IDEATION_EXCHANGE_QUESTION_MAX_UTF8_BYTES + 1,
            ),
          },
        ],
      }),
    ).toThrow(/at most 4096 UTF-8 bytes/);
    expect(() =>
      validateIdeationState({
        ...draftState(),
        revision: 2,
        predecessor_sha256: "a".repeat(64),
        revision_kind: "accepted-answer",
        interview_exchanges: [
          {
            ...exchange(),
            accepted_answer: "x".repeat(
              IDEATION_EXCHANGE_ANSWER_MAX_UTF8_BYTES + 1,
            ),
          },
        ],
      }),
    ).toThrow(/at most 32768 UTF-8 bytes/);
    expect(() =>
      validateIdeationState({
        ...draftState(),
        revision: 2,
        predecessor_sha256: "a".repeat(64),
        revision_kind: "accepted-answer",
        interview_exchanges: [
          {
            ...exchange(),
            affected_targets: Array.from(
              { length: IDEATION_EXCHANGE_TARGET_MAX_COUNT + 1 },
              () => ({ target_type: "state-field", field: "title" }),
            ),
          },
        ],
      }),
    ).toThrow(/128/);
    expect(() =>
      validateIdeationState({
        ...draftState(),
        revision: 2,
        predecessor_sha256: "a".repeat(64),
        revision_kind: "accepted-answer",
        interview_exchanges: [
          {
            ...exchange(),
            evidence_ids: Array.from(
              { length: IDEATION_EXCHANGE_EVIDENCE_MAX_COUNT + 1 },
              () => "E1",
            ),
          },
        ],
      }),
    ).toThrow(/evidence/);
    expect(() =>
      validateIdeationState({
        ...draftState(),
        revision: 2,
        predecessor_sha256: "a".repeat(64),
        revision_kind: "accepted-answer",
        interview_exchanges: [{ ...exchange(), id: "Q2" }],
      }),
    ).toThrow(/position/);
  });

  test("maps every mutable field, includes readiness, and ignores interview ledger changes", () => {
    const base = draftState();
    const cases: Record<string, (state: any) => any> = {
      title: (s) => ({ ...s, title: "Changed title" }),
      "commitment-level": (s) => ({ ...s, commitment_level: "building" }),
      goal: (s) => ({ ...s, goal: { ...s.goal, statement: "Changed goal" } }),
      criteria: (s) => ({
        ...s,
        criteria: [{ ...s.criteria[0], threshold: "Changed threshold" }],
      }),
      "scope-in": (s) => ({
        ...s,
        scope: { ...s.scope, in_scope: ["Changed scope"] },
      }),
      "scope-non-goal": (s) => ({
        ...s,
        scope: { ...s.scope, non_goals: ["Changed non-goal"] },
      }),
      "scope-deferred": (s) => ({
        ...s,
        scope: { ...s.scope, deferred: ["Changed deferred"] },
      }),
      decisions: (s) => ({
        ...s,
        decisions: [{ ...s.decisions[0], rationale: "Changed rationale" }],
      }),
      assumptions: (s) => ({
        ...s,
        assumptions: [{ ...s.assumptions[0], if_wrong: "Changed consequence" }],
      }),
      evidence: (s) => ({
        ...s,
        evidence: [{ ...s.evidence[0], description: "Changed evidence" }],
      }),
      visuals: (s) => ({
        ...s,
        visuals: [{ ...s.visuals[0], title: "Changed visual" }],
      }),
      "review-item-presentations": (s) => ({
        ...s,
        review_item_presentations: s.review_item_presentations.map(
          (p: any, i: number) =>
            i === 0 ? { ...p, purpose: "Changed purpose" } : p,
        ),
      }),
      "commitment-critique": (s) => ({
        ...s,
        commitment_critique: {
          ...s.commitment_critique,
          critics: s.commitment_critique.critics.map((c: any) => ({
            ...c,
            findings: c.findings.map((f: any) => ({
              ...f,
              issue: `${f.issue} changed`,
            })),
          })),
        },
      }),
      readiness: (s) => ({
        ...s,
        readiness: { ...s.readiness, blockers: ["B1"] },
      }),
    };
    for (const [field, mutate] of Object.entries(cases)) {
      const changed = validateIdeationState(mutate(base));
      expect(deriveChangedExchangeTargets(base, changed)).toContainEqual({
        target_type: "state-field",
        field,
      });
    }
    const ledgerOnly = validateIdeationState({
      ...base,
      revision: 2,
      predecessor_sha256: "a".repeat(64),
      revision_kind: "accepted-answer",
      interview_exchanges: [exchange()],
    });
    expect(deriveChangedExchangeTargets(base, ledgerOnly)).toEqual([]);
  });

  test("deduplicates semantic targets when a criterion and its presentation change together", () => {
    const base = draftState();
    const criterionId = base.criteria[0]!.id;
    const changed = validateIdeationState({
      ...base,
      criteria: base.criteria.map((criterion, index) =>
        index === 0 ? { ...criterion, threshold: "Changed criterion threshold" } : criterion,
      ),
      review_item_presentations: base.review_item_presentations.map((item) =>
        item.semantic_id === criterionId
          ? { ...item, purpose: "Changed criterion review purpose" }
          : item,
      ),
    });

    const targets = deriveChangedExchangeTargets(base, changed);
    expect(targets).toContainEqual({ target_type: "state-field", field: "criteria" });
    expect(targets).toContainEqual({
      target_type: "state-field",
      field: "review-item-presentations",
    });
    expect(
      targets.filter(
        (target) =>
          target.target_type === "semantic-id" && target.semantic_id === criterionId,
      ),
    ).toHaveLength(1);
  });

  test("review subject binds revision_kind, interview exchanges, and presentations", () => {
    const base = draftState();
    const accepted = validateIdeationState({
      ...base,
      revision: 2,
      predecessor_sha256: "a".repeat(64),
      revision_kind: "accepted-answer",
      interview_exchanges: [exchange()],
    });
    const presentationChanged = validateIdeationState({
      ...base,
      review_item_presentations: base.review_item_presentations.map((p, i) =>
        i === 0 ? { ...p, purpose: "Different purpose" } : p,
      ),
    });
    expect(ideationReviewSubjectSha256(base)).not.toBe(
      ideationReviewSubjectSha256(accepted),
    );
    expect(ideationReviewSubjectSha256(base)).not.toBe(
      ideationReviewSubjectSha256(presentationChanged),
    );
  });

  test("shared content detector covers both fields, near misses, CRLF, no decoding, and content-free errors", () => {
    const positives = [
      "-----BEGIN PRIVATE KEY-----",
      "AKIA1234567890ABCDEF",
      "ghp_12345678901234567890",
      "glpat-12345678901234567890",
      "xoxb-1234567890",
      "Bearer abcdefghijklmnop",
      "eyJabcdefgh.eyJabcdefgh.eyJabcdefgh",
      "https://user:password@example.test",
      "password = abcdefghijklmnop",
    ];
    for (const value of positives)
      expect(scanHighConfidenceSecrets(value).length).toBeGreaterThan(0);
    expect(
      scanHighConfidenceSecrets("AKIA1234567890ABCDE".replace("AKIA", "akia"))
        .length,
    ).toBe(0);
    expect(() =>
      assertIdeationExchangeContentSafe({
        exact_question: "safe",
        accepted_answer: "safe\r\nBearer abcdefghijklmnop",
      }),
    ).toThrow(
      /IDEATION_EXCHANGE_SENSITIVE_CONTENT:accepted_answer:bearer-token/,
    );
    expect(() =>
      assertIdeationExchangeContentSafe({
        exact_question: "Bearer abcdefghijklmnop",
        accepted_answer: "safe",
      }),
    ).toThrow(/exact_question/);
    expect(() =>
      assertIdeationExchangeContentSafe({
        exact_question: "https%3A%2F%2Fuser%3Apass@example",
        accepted_answer: "safe",
      }),
    ).not.toThrow();
    expect(() =>
      assertIdeationExchangeContentSafe({
        exact_question: "safe",
        accepted_answer: "password = short",
      }),
    ).not.toThrow();
  });

  test("requires complete governed target coverage and exact four-option recommendation contract", () => {
    const base = draftState();
    expect(() =>
      validateIdeationState({
        ...base,
        review_item_presentations: base.review_item_presentations.slice(1),
      }),
    ).toThrow(/exactly cover governed targets/);
    const item = presentation(base);
    expect(item.options).toHaveLength(4);
    expect(() =>
      validateIdeationState({
        ...base,
        review_item_presentations: base.review_item_presentations.map((p, i) =>
          i === 0 ? { ...p, options: p.options.slice(0, 3) } : p,
        ),
      }),
    ).toThrow(/exactly four/);
    expect(() =>
      validateIdeationState({
        ...base,
        review_item_presentations: base.review_item_presentations.map((p, i) =>
          i === 0 ? { ...p, recommended_option_id: "missing" } : p,
        ),
      }),
    ).toThrow(/recommendation/);
    expect(() =>
      validateIdeationState({
        ...base,
        review_item_presentations: base.review_item_presentations.map((p, i) =>
          i === 0
            ? {
                ...p,
                options: p.options.map((o, j) =>
                  j === 3 ? { ...o, option_id: p.options[0]!.option_id } : o,
                ),
              }
            : p,
        ),
      }),
    ).toThrow(/recommendation/);
  });

  test("rejects normalized prose duplicates and unknown evidence/dependencies", () => {
    const base = draftState();
    expect(() =>
      validateIdeationState({
        ...base,
        review_item_presentations: base.review_item_presentations.map((p, i) =>
          i === 0 ? { ...p, purpose: p.key_points[0]!.toUpperCase() } : p,
        ),
      }),
    ).toThrow(/normalized duplicates/);
    expect(() =>
      validateIdeationState({
        ...base,
        review_item_presentations: base.review_item_presentations.map((p, i) =>
          i === 0 ? { ...p, dependency_semantic_ids: ["missing"] } : p,
        ),
      }),
    ).toThrow(/unknown semantic ID/);
    expect(() =>
      validateIdeationState({
        ...base,
        review_item_presentations: base.review_item_presentations.map((p, i) =>
          i === 0
            ? {
                ...p,
                options: p.options.map((o, j) =>
                  j === 0 ? { ...o, evidence_ids: ["missing"] } : o,
                ),
              }
            : p,
        ),
      }),
    ).toThrow(/unknown evidence ID/);
  });

  test("projects neutral four-option presentations field-for-field and keeps import direction one-way", () => {
    const state = draftState();
    const item = presentation(state);
    expect(projectIdeationReviewPresentation(item)).toEqual({
      kind: "four-option-decision",
      purpose: item.purpose,
      why_it_matters: item.why_it_matters,
      system_position: item.system_position,
      dependency_target_ids: item.dependency_semantic_ids,
      key_points: item.key_points,
      research_summary: item.research_summary,
      options: item.options,
      recommended_option_id: item.recommended_option_id,
      recommendation_rationale: item.recommendation_rationale,
      uncertainty: item.uncertainty,
    });
    expect(
      projectIdeationReviewPresentations(state).map((entry) => entry.target_id),
    ).toEqual(
      state.review_item_presentations.map((entry) => entry.semantic_id),
    );
    expect(
      feedbackTargets(state).map((entry) => entry.target.semantic_id),
    ).toEqual(
      state.review_item_presentations.map((entry) => entry.semantic_id),
    );
  });

  test("keeps Markdown parity for canonical option and recommendation data", () => {
    const state = draftState();
    const markdown = new TextDecoder().decode(renderIdeationMarkdown(state));
    expect(markdown).toContain(state.title);
    expect(markdown).toContain(state.goal.statement);
    expect(markdown).toContain("## Visual Semantics");
  });

  test("keeps five episode predecessor fields explicit for genesis and response-driven episodes", () => {
    const episode = fixture.state.final_document_review.episodes[0];
    expect(Object.keys(episode).sort()).toEqual(
      [
        "episode",
        "first_round",
        "predecessor_candidate_record_path",
        "predecessor_candidate_record_sha256",
        "predecessor_episode_sha256",
        "predecessor_import_current_candidate_sha256",
        "predecessor_response_record_path",
        "predecessor_response_record_sha256",
        "predecessor_state_sha256",
        "semantic_revision",
        "subject_sha256",
      ].sort(),
    );
    expect(episode.predecessor_candidate_record_path).toBeNull();
    expect(episode.predecessor_response_record_path).toBeNull();
    expect(episode.predecessor_import_current_candidate_sha256).toBeNull();
  });

  test("rejects predecessor authority on episode one and partial authority on later episodes", () => {
    expect(() =>
      validateIdeationState({
        ...fixture.state,
        final_document_review: {
          ...fixture.state.final_document_review,
          episodes: [
            {
              ...fixture.state.final_document_review.episodes[0],
              predecessor_candidate_record_path:
                "ai_docs/ideation/.unexpected-candidate.json",
            },
          ],
        },
      }),
    ).toThrow(/initial episode cannot bind predecessor authority/);

    const predecessor = validateIdeationState(fixture.state);
    const successorShell = validateIdeationState({
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
    const successorRound = {
      ...previousRound,
      round: previousRound.round + 1,
      subject: {
        ...previousRound.subject,
        subject_id: "subject-2",
        semantic_revision: successorShell.revision,
        subject_sha256: ideationReviewSubjectSha256(successorShell),
        predecessor_subject_sha256: previousRound.subject.subject_sha256,
      },
      results: [],
    };
    const successorEpisode = {
      episode: 2,
      first_round: successorRound.round,
      semantic_revision: successorShell.revision,
      subject_sha256: successorRound.subject.subject_sha256,
      predecessor_episode_sha256: finalDocumentReviewEpisodeSha256(
        predecessor.final_document_review,
        1,
      ),
      predecessor_state_sha256: ideationStateSha256(predecessor),
      predecessor_candidate_record_path:
        "ai_docs/ideation/.code-review-tool.candidate.json",
      predecessor_candidate_record_sha256: "a".repeat(64),
      predecessor_response_record_path:
        "ai_docs/ideation/.code-review-tool.response.json",
      predecessor_response_record_sha256: "b".repeat(64),
      predecessor_import_current_candidate_sha256: "c".repeat(64),
    };
    const validLaterEpisodeState = {
      ...successorShell,
      readiness: predecessor.readiness,
      final_document_review: {
        schema: IDEATION_FINAL_REVIEW_SCHEMA,
        episodes: [
          ...predecessor.final_document_review.episodes,
          successorEpisode,
        ],
        current_episode: 2,
        rounds: [
          ...predecessor.final_document_review.rounds,
          successorRound,
        ],
        current_round: successorRound.round,
      },
    };
    expect(() => validateIdeationState(validLaterEpisodeState)).not.toThrow();
    expect(() =>
      validateIdeationState({
        ...validLaterEpisodeState,
        final_document_review: {
          ...validLaterEpisodeState.final_document_review,
          episodes: [
            predecessor.final_document_review.episodes[0],
            {
              ...successorEpisode,
              predecessor_response_record_sha256: null,
            },
          ],
        },
      }),
    ).toThrow(/response-driven later episode requires complete predecessor authority/);
  });
});
