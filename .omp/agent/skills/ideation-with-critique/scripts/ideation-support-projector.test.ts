import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  deriveChangedExchangeTargets,
  ideationStateSha256,
  validateIdeationState,
  type IdeationState,
} from "../schemas/ideation-state.ts";
import { projectIdeationSupport } from "./ideation-support-projector.ts";

const fixturePath = new URL("../fixtures/authoring-review-v8.json", import.meta.url);

test("projects each affected semantic presentation once in canonical state order", async () => {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { readonly state: unknown };
  const base = validateIdeationState(raw.state);
  const successorWithoutExchange = {
    ...base,
    revision: 2,
    predecessor_sha256: ideationStateSha256(base),
    revision_kind: "non-answer" as const,
    readiness: {
      ...base.readiness,
      bounded_ambiguities: base.readiness.bounded_ambiguities.map((ambiguity) =>
        ambiguity.id === "U1" ? { ...ambiguity, id: "U2" } : ambiguity,
      ),
    },
    review_item_presentations: base.review_item_presentations
      .map((presentation) =>
        presentation.semantic_id === "U1"
          ? { ...presentation, semantic_id: "U2" }
          : presentation.semantic_id === "G1"
            ? { ...presentation, dependency_semantic_ids: ["A1", "C1", "D1", "U2"] }
            : presentation,
      )
      .sort((left, right) => left.semantic_id.localeCompare(right.semantic_id)),
  };
  const affectedTargets = deriveChangedExchangeTargets(base, validateIdeationState(successorWithoutExchange));
  const state: IdeationState = validateIdeationState({
    ...successorWithoutExchange,
    interview_exchanges: [
      {
        id: "Q1",
        exact_question: "Which governed review item changed?",
        accepted_answer: "The bounded uncertainty is now U2.",
        supersedes_exchange_id: null,
        affected_targets: affectedTargets,
        evidence_ids: [base.evidence[0]!.id],
      },
    ],
  });

  const projection = projectIdeationSupport(state, "explicit-request", [base]);
  const exchange = projection.exchanges[0]!;

  const presentationIds = exchange.target_presentations.map((presentation) => presentation.semantic_id);
  const unavailableIds = exchange.unavailable_target_semantic_ids;
  const affectedSemanticIds = [
    ...new Set(
      affectedTargets
        .filter((target) => target.target_type === "semantic-id")
        .map((target) => target.semantic_id),
    ),
  ];
  expect(presentationIds).toEqual(["G1", "U2", "U1"]);
  expect(exchange.target_presentations[0]).toEqual(
    state.review_item_presentations.find(({ semantic_id }) => semantic_id === "G1"),
  );
  expect(exchange.target_presentations[1]).toEqual(
    state.review_item_presentations.find(({ semantic_id }) => semantic_id === "U2"),
  );
  expect(exchange.target_presentations[2]).toEqual(
    base.review_item_presentations.find(({ semantic_id }) => semantic_id === "U1"),
  );
  expect(presentationIds.slice(0, 2)).toEqual(
    state.review_item_presentations
      .filter((presentation) => affectedSemanticIds.includes(presentation.semantic_id))
      .map((presentation) => presentation.semantic_id),
  );
  expect(presentationIds[2]).toBe("U1");
  expect(unavailableIds).toEqual([]);
  expect(presentationIds.every((semanticId) => !unavailableIds.includes(semanticId))).toBe(true);
  expect(new Set(presentationIds).size + unavailableIds.length).toBe(new Set(affectedSemanticIds).size);
  expect([...new Set([...presentationIds, ...unavailableIds])].sort()).toEqual([...new Set(affectedSemanticIds)].sort());
  expect(exchange.target_labels).toContain("state:readiness");
  expect(exchange.target_labels).toContain("state:review-item-presentations");
  expect(Object.isFrozen(exchange.target_presentations)).toBe(true);
  expect(Object.isFrozen(exchange.unavailable_target_semantic_ids)).toBe(true);
  expect(Object.isFrozen(projection.exchanges)).toBe(true);
});

test("prefers the successor presentation when both snapshots contain a target", async () => {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { readonly state: unknown };
  const base = validateIdeationState(raw.state);
  const successor = validateIdeationState({
    ...base,
    revision: 2,
    predecessor_sha256: ideationStateSha256(base),
    revision_kind: "non-answer" as const,
    review_item_presentations: base.review_item_presentations.map((presentation) =>
      presentation.semantic_id === "G1"
        ? { ...presentation, purpose: "Successor presentation wins" }
        : presentation,
    ),
    interview_exchanges: [
      {
        id: "Q1",
        exact_question: "Which review item changed?",
        accepted_answer: "The successor presentation is authoritative for support ordering.",
        supersedes_exchange_id: null,
        affected_targets: [{ target_type: "semantic-id", semantic_id: "G1" }],
        evidence_ids: [base.evidence[0]!.id],
      },
    ],
  });

  const exchange = projectIdeationSupport(successor, "explicit-request", [base]).exchanges[0]!;
  expect(exchange.target_presentations).toHaveLength(1);
  expect(exchange.target_presentations[0]).toEqual(
    successor.review_item_presentations.find(({ semantic_id }) => semantic_id === "G1"),
  );
  expect(exchange.target_presentations[0]).not.toEqual(
    base.review_item_presentations.find(({ semantic_id }) => semantic_id === "G1"),
  );
});

test("projects a three-revision carried ledger with current and nearest precedence", async () => {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { readonly state: unknown };
  const genesis = validateIdeationState(raw.state);
  const revision2 = validateIdeationState({
    ...genesis,
    revision: 2,
    predecessor_sha256: ideationStateSha256(genesis),
    revision_kind: "non-answer" as const,
    readiness: {
      ...genesis.readiness,
      bounded_ambiguities: genesis.readiness.bounded_ambiguities.map((ambiguity) =>
        ambiguity.id === "U1" ? { ...ambiguity, id: "U2" } : ambiguity,
      ),
    },
    review_item_presentations: genesis.review_item_presentations
      .map((presentation) =>
        presentation.semantic_id === "U1"
          ? { ...presentation, semantic_id: "U2" }
          : presentation.semantic_id === "G1"
            ? { ...presentation, purpose: "Nearest ancestor wins", dependency_semantic_ids: ["A1", "C1", "D1", "U2"] }
            : presentation,
      )
      .sort((left, right) => left.semantic_id.localeCompare(right.semantic_id)),
  });
  const current = validateIdeationState({
    ...revision2,
    revision: 3,
    predecessor_sha256: ideationStateSha256(revision2),
    revision_kind: "non-answer" as const,
    goal: { ...revision2.goal, id: "G2" },
    review_item_presentations: revision2.review_item_presentations
      .map((presentation) => {
        const semantic_id = presentation.semantic_id === "G1" ? "G2" : presentation.semantic_id;
        const dependency_semantic_ids = [...new Set(
          presentation.dependency_semantic_ids.map((dependencyId) => dependencyId === "G1" ? "G2" : dependencyId),
        )].sort((left, right) => left.localeCompare(right));
        return presentation.semantic_id === "G1"
          ? { ...presentation, semantic_id, purpose: "Current presentation wins", dependency_semantic_ids }
          : { ...presentation, dependency_semantic_ids };
      })
      .sort((left, right) => left.semantic_id.localeCompare(right.semantic_id)),
    interview_exchanges: [
      {
        id: "Q1",
        exact_question: "Which carried targets need support?",
        accepted_answer: "Resolve current, nearest ancestor, then genesis presentations.",
        supersedes_exchange_id: null,
        affected_targets: [
          { target_type: "semantic-id", semantic_id: "G1" },
          { target_type: "semantic-id", semantic_id: "G2" },
          { target_type: "semantic-id", semantic_id: "MISSING" },
          { target_type: "semantic-id", semantic_id: "U1" },
        ],
        evidence_ids: [genesis.evidence[0]!.id],
      },
    ],
  });

  const exchange = projectIdeationSupport(current, "explicit-request", [revision2, genesis]).exchanges[0]!;
  expect(exchange.target_presentations.map(({ semantic_id }) => semantic_id)).toEqual(["G2", "G1", "U1"]);
  expect(exchange.target_presentations[0]).toEqual(
    current.review_item_presentations.find(({ semantic_id }) => semantic_id === "G2"),
  );
  expect(exchange.target_presentations[1]).toEqual(
    revision2.review_item_presentations.find(({ semantic_id }) => semantic_id === "G1"),
  );
  expect(exchange.target_presentations[2]).toEqual(
    genesis.review_item_presentations.find(({ semantic_id }) => semantic_id === "U1"),
  );
  expect(exchange.target_presentations[0]?.options).toHaveLength(4);
  expect(exchange.unavailable_target_semantic_ids).toEqual(["MISSING"]);
  const resolvedIds = exchange.target_presentations.map(({ semantic_id }) => semantic_id);
  expect(new Set(resolvedIds).size).toBe(resolvedIds.length);
  expect(resolvedIds.filter((semanticId) => exchange.unavailable_target_semantic_ids.includes(semanticId))).toEqual([]);
  expect([...new Set([...resolvedIds, ...exchange.unavailable_target_semantic_ids])].sort()).toEqual(
    ["G1", "G2", "MISSING", "U1"],
  );
  expect(Object.isFrozen(exchange.target_presentations)).toBe(true);
  expect(Object.isFrozen(exchange.unavailable_target_semantic_ids)).toBe(true);
  expect(Object.isFrozen(exchange.target_labels)).toBe(true);
  expect(Object.isFrozen(exchange.evidence_locators)).toBe(true);
  expect(Object.isFrozen(exchange)).toBe(true);
  expect(Object.isFrozen(current.review_item_presentations)).toBe(true);
  expect(Object.isFrozen(projectIdeationSupport(current, "explicit-request", [revision2, genesis]))).toBe(true);
});

test("rejects missing, tampered, forked, reordered, or extra ancestors", async () => {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { readonly state: unknown };
  const genesis = validateIdeationState(raw.state);
  const revision2 = validateIdeationState({
    ...genesis,
    revision: 2,
    predecessor_sha256: ideationStateSha256(genesis),
    revision_kind: "non-answer" as const,
  });
  const current = validateIdeationState({
    ...revision2,
    revision: 3,
    predecessor_sha256: ideationStateSha256(revision2),
    revision_kind: "non-answer" as const,
  });

  expect(() => projectIdeationSupport(current, "explicit-request", [])).toThrow("IDEATION_SUPPORT_CORRUPTION");
  expect(() => projectIdeationSupport(current, "explicit-request", [genesis, revision2])).toThrow("IDEATION_SUPPORT_CORRUPTION");
  expect(() => projectIdeationSupport(current, "explicit-request", [{ ...revision2, title: "Tampered ancestor" }, genesis])).toThrow("IDEATION_SUPPORT_CORRUPTION");
  expect(() => projectIdeationSupport(current, "explicit-request", [{ ...revision2, run_id: "forked-run" }, genesis])).toThrow("IDEATION_SUPPORT_CORRUPTION");
  expect(() => projectIdeationSupport(current, "explicit-request", [revision2, genesis, genesis])).toThrow("IDEATION_SUPPORT_CORRUPTION");
});

test("reports a semantic target unavailable only when both snapshots omit it", async () => {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { readonly state: unknown };
  const base = validateIdeationState(raw.state);
  const successor = validateIdeationState({
    ...base,
    revision: 2,
    predecessor_sha256: ideationStateSha256(base),
    revision_kind: "non-answer" as const,
    interview_exchanges: [
      {
        id: "Q1",
        exact_question: "Which target is unavailable?",
        accepted_answer: "Neither snapshot contains it.",
        supersedes_exchange_id: null,
        affected_targets: [{ target_type: "semantic-id", semantic_id: "MISSING" }],
        evidence_ids: [base.evidence[0]!.id],
      },
    ],
  });

  const exchange = projectIdeationSupport(successor, "explicit-request", [base]).exchanges[0]!;
  expect(exchange.target_presentations).toEqual([]);
  expect(exchange.unavailable_target_semantic_ids).toEqual(["MISSING"]);
  expect(new Set([
    ...exchange.target_presentations.map(({ semantic_id }) => semantic_id),
    ...exchange.unavailable_target_semantic_ids,
  ])).toEqual(new Set(["MISSING"]));
});

describe("Ideation support projector contract", () => {
  test("keeps state-only exchanges free of semantic target projections", async () => {
    const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { readonly state: unknown };
    const base = validateIdeationState(raw.state);
    const state = validateIdeationState({
      ...base,
      revision: 2,
      predecessor_sha256: ideationStateSha256(base),
      revision_kind: "accepted-answer",
      interview_exchanges: [
        {
          id: "Q1",
          exact_question: "What changed outside semantic review items?",
          accepted_answer: "Only readiness metadata changed.",
          supersedes_exchange_id: null,
          affected_targets: [{ target_type: "state-field", field: "readiness" }],
          evidence_ids: ["E1"],
        },
      ],
    });

    const exchange = projectIdeationSupport(state, "explicit-request", [base]).exchanges[0]!;
    expect(exchange.target_presentations).toEqual([]);
    expect(exchange.unavailable_target_semantic_ids).toEqual([]);
  });
});
