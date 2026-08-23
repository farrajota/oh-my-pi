import type {
  DerivedIdeationExchange,
  IdeationExchangeTarget,
  IdeationInterviewExchange,
  IdeationReviewItemPresentation,
  IdeationState,
} from "../schemas/ideation-state.ts";
import {
  deriveIdeationExchangeHistory,
  validateIdeationState,
} from "../schemas/ideation-state.ts";
import { canonicalJson, hashCanonicalJson } from "../../approval-dossier-runtime/scripts/canonical-json.ts";

export const IDEATION_SUPPORT_RENDERER_MANIFEST_SCHEMA = "ideation-support-renderer/v1" as const;
export const IDEATION_SUPPORT_TRIGGERS = Object.freeze([
  "explicit-request",
  "commitment-review-boundary",
  "final-review-boundary",
  "returned-changes",
  "material-commitment-change",
  "show-stopper-contradiction",
] as const);
export type IdeationSupportTrigger = (typeof IDEATION_SUPPORT_TRIGGERS)[number];

export interface IdeationSupportProjectionExchange extends DerivedIdeationExchange {
  readonly ordinal: number;
  readonly target_labels: readonly string[];
  readonly target_presentations: readonly IdeationReviewItemPresentation[];
  readonly unavailable_target_semantic_ids: readonly string[];
  readonly evidence_locators: readonly string[];
}
export interface IdeationSupportProjection {
  readonly schema: typeof IDEATION_SUPPORT_RENDERER_MANIFEST_SCHEMA;
  readonly artifact_kind: "non-authoritative-support";
  readonly workflow: "ideation";
  readonly slug: string;
  readonly run_id: string;
  readonly revision: number;
  readonly trigger: IdeationSupportTrigger;
  readonly currentness?: "current" | "historical";
  readonly title: string;
  readonly commitment_level: IdeationState["commitment_level"];
  readonly state_sha256: string;
  readonly interview_ledger_sha256: string;
  readonly exchanges: readonly IdeationSupportProjectionExchange[];
  readonly evidence: readonly { readonly id: string; readonly locator: string; readonly description: string }[];
  readonly provenance: readonly { readonly field: string; readonly value: string }[];
  readonly empty_state: boolean;
}

function targetLabel(target: IdeationExchangeTarget): string {
  return target.target_type === "semantic-id" ? `semantic:${target.semantic_id}` : `state:${target.field}`;
}

export function projectIdeationSupport(
  input: IdeationState,
  trigger: IdeationSupportTrigger,
  ancestorInputs: readonly IdeationState[],
): IdeationSupportProjection {
  const state = validateIdeationState(input);
  const ancestors = ancestorInputs.map((ancestor) => validateIdeationState(ancestor));
  if (!IDEATION_SUPPORT_TRIGGERS.includes(trigger)) throw new TypeError("IDEATION_SUPPORT_CORRUPTION:invalid trigger");
  if (ancestors.length !== state.revision - 1) {
    throw new TypeError("IDEATION_SUPPORT_CORRUPTION:incomplete ancestor lineage");
  }

  let expectedSuccessor = state;
  for (const [index, ancestor] of ancestors.entries()) {
    if (
      ancestor.slug !== state.slug ||
      ancestor.run_id !== state.run_id ||
      ancestor.revision !== expectedSuccessor.revision - 1 ||
      expectedSuccessor.predecessor_sha256 !== hashCanonicalJson(ancestor)
    ) {
      throw new TypeError(`IDEATION_SUPPORT_CORRUPTION:invalid ancestor lineage at index ${index}`);
    }
    expectedSuccessor = ancestor;
  }
  if (expectedSuccessor.revision !== 1 || expectedSuccessor.predecessor_sha256 !== null) {
    throw new TypeError("IDEATION_SUPPORT_CORRUPTION:genesis ancestor is invalid");
  }

  const evidenceById = new Map(state.evidence.map((entry) => [entry.id, entry]));
  const history = deriveIdeationExchangeHistory(state.interview_exchanges);
  const exchanges = history.map((exchange, index) => {
    const affectedSemanticIds = [
      ...new Set(
        exchange.affected_targets
          .filter((target) => target.target_type === "semantic-id")
          .map((target) => target.semantic_id),
      ),
    ];
    const affectedSemanticIdSet = new Set(affectedSemanticIds);
    const presentedSemanticIds = new Set<string>();
    const targetPresentations = Object.freeze(
      [state, ...ancestors].flatMap((snapshot) =>
        snapshot.review_item_presentations.filter((presentation) => {
          if (!affectedSemanticIdSet.has(presentation.semantic_id) || presentedSemanticIds.has(presentation.semantic_id)) {
            return false;
          }
          presentedSemanticIds.add(presentation.semantic_id);
          return true;
        }),
      ),
    );
    const unavailableTargetSemanticIds = Object.freeze(
      affectedSemanticIds.filter((semanticId) => !presentedSemanticIds.has(semanticId)),
    );

    return Object.freeze({
      ...exchange,
      ordinal: index + 1,
      target_labels: Object.freeze(exchange.affected_targets.map(targetLabel)),
      target_presentations: targetPresentations,
      unavailable_target_semantic_ids: unavailableTargetSemanticIds,
      evidence_locators: Object.freeze(exchange.evidence_ids.map((id) => evidenceById.get(id)?.locator ?? id)),
    });
  });
  const projection = {
    schema: IDEATION_SUPPORT_RENDERER_MANIFEST_SCHEMA,
    artifact_kind: "non-authoritative-support" as const,
    workflow: "ideation" as const,
    slug: state.slug,
    run_id: state.run_id,
    revision: state.revision,
    trigger,
    title: state.title,
    commitment_level: state.commitment_level,
    state_sha256: hashCanonicalJson(state),
    interview_ledger_sha256: hashCanonicalJson(state.interview_exchanges),
    exchanges: Object.freeze(exchanges),
    evidence: Object.freeze(state.evidence.map(({ id, locator, description }) => Object.freeze({ id, locator, description }))),
    provenance: Object.freeze([
      Object.freeze({ field: "state_snapshot", value: `revision ${state.revision}` }),
      Object.freeze({ field: "interview_ledger", value: `${state.interview_exchanges.length} exchange(s)` }),
      Object.freeze({ field: "commitment", value: state.commitment_level }),
    ]),
    empty_state: state.interview_exchanges.length === 0,
  } satisfies IdeationSupportProjection;
  return Object.freeze(projection);
}

export function ideationSupportProjectionSha256(projection: IdeationSupportProjection): string {
  return hashCanonicalJson(projection);
}

export function ideationSupportTriggerSha256(trigger: IdeationSupportTrigger): string {
  return hashCanonicalJson(trigger);
}

export function ideationSupportLedgerSha256(exchanges: readonly IdeationInterviewExchange[]): string {
  return hashCanonicalJson(exchanges);
}

export function ideationSupportProjectionCanonicalJson(projection: IdeationSupportProjection): string {
  return canonicalJson(projection);
}
