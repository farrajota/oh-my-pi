import {
	BASELINE_SUBSTANTIVE_REVIEW_ROLES,
	type BaselineSubstantiveReviewRole,
	SEMANTIC_BINDING_SCHEMA,
	type SemanticBinding,
	validateSubstantiveReviewAssignment,
	validateSubstantiveReviewAssignments,
} from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import { assertIdeationExchangeContentSafe } from "../../approval-dossier-runtime/scripts/content-safety.ts";
import { canonicalJson, hashCanonicalJson } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
export const IDEATION_STATE_SCHEMA = "ideation-with-critique/state/v8" as const;
export const IDEATION_FINAL_REVIEW_SCHEMA = "ideation-with-critique/final-document-review/v5" as const;
export const IDEATION_WORKFLOW = "ideation" as const;
export const DEFAULT_IDEATION_MAX_REVIEW_ROUNDS = 3 as const;
export const IDEATION_EXCHANGE_QUESTION_MAX_UTF8_BYTES = 4096 as const;
export const IDEATION_EXCHANGE_ANSWER_MAX_UTF8_BYTES = 32768 as const;
export const IDEATION_EXCHANGE_TARGET_MAX_COUNT = 128 as const;
export const IDEATION_EXCHANGE_EVIDENCE_MAX_COUNT = 128 as const;

export type IdeationExchangeTarget =
	| Readonly<{ target_type: "semantic-id"; semantic_id: string }>
	| Readonly<{ target_type: "state-field"; field: "title" | "commitment-level" | "goal" | "criteria" | "scope-in" | "scope-non-goal" | "scope-deferred" | "decisions" | "assumptions" | "evidence" | "visuals" | "review-item-presentations" | "commitment-critique" | "readiness" }>;
export interface IdeationInterviewExchange {
	readonly id: `Q${number}`;
	readonly exact_question: string;
	readonly accepted_answer: string;
	readonly supersedes_exchange_id: `Q${number}` | null;
	readonly affected_targets: readonly IdeationExchangeTarget[];
	readonly evidence_ids: readonly string[];
}
export interface DerivedIdeationExchange extends IdeationInterviewExchange {
	readonly active: boolean;
	readonly predecessor_exchange_id: `Q${number}` | null;
	readonly successor_exchange_id: `Q${number}` | null;
}
export interface IdeationReviewOption {
	readonly option_id: string;
	readonly label: string;
	readonly mechanism_or_output: string;
	readonly benefit: string;
	readonly omission_cost_or_uncertainty: string;
	readonly downstream_consequence: string;
	readonly evidence_ids: readonly string[];
}
export interface IdeationReviewItemPresentation {
	readonly semantic_id: string;
	readonly purpose: string;
	readonly why_it_matters: string;
	readonly system_position: string;
	readonly dependency_semantic_ids: readonly string[];
	readonly key_points: readonly [string, ...string[]];
	readonly research_summary: readonly [string, ...string[]];
	readonly options: readonly [IdeationReviewOption, IdeationReviewOption, IdeationReviewOption, IdeationReviewOption];
	readonly recommended_option_id: string;
	readonly recommendation_rationale: string;
	readonly uncertainty: string;
}

export type CommitmentLevel = "exploration" | "planning" | "building";
export type ReadinessStatus = "draft" | "ready-for-approval";
export type Confidence = "low" | "medium" | "high";
export type CritiqueSeverity = "show-stopper" | "important" | "minor";
export type CritiqueDisposition = "accepted" | "mitigated" | "deferred" | "rejected";
export type VisualType = "flow" | "bar" | "matrix" | "timeline" | "comparison";
export type FinalReviewGateOutcome = "PASS" | "BLOCK" | "UNRESOLVED" | "INCOMPLETE";
export type FinalReviewFindingSeverity = "blocking" | "advisory";
export type FinalReviewFindingDisposition =
	| "open"
	| "accepted-for-correction"
	| "accepted"
	| "mitigated"
	| "deferred"
	| "rejected";
export type FinalReviewBaselineRole = BaselineSubstantiveReviewRole;

export interface IdeationGoal {
	readonly id: string;
	readonly statement: string;
	readonly beneficiaries: readonly string[];
	readonly context: string;
}

export interface EvaluationCriterion {
	readonly id: string;
	readonly priority: "P0" | "P1" | "P2";
	readonly criterion: string;
	readonly threshold: string;
	readonly verification_method: string;
	readonly evidence_ids: readonly string[];
}

export interface Scope {
	readonly in_scope: readonly string[];
	readonly non_goals: readonly string[];
	readonly deferred: readonly string[];
}

export interface Decision {
	readonly id: string;
	readonly statement: string;
	readonly type: "goal" | "non-goal" | "constraint" | "critique-resolution";
	readonly confidence: Confidence;
	readonly status: "active" | "superseded";
	readonly rationale: string;
	readonly evidence_ids: readonly string[];
}

export interface Assumption {
	readonly id: string;
	readonly statement: string;
	readonly load_bearing: boolean;
	readonly if_wrong: string;
	readonly tested: "yes" | "no" | "partial";
	readonly evidence_ids: readonly string[];
}

export interface Evidence {
	readonly id: string;
	readonly locator: string;
	readonly description: string;
	readonly sha256: string | null;
}

export interface CritiqueFinding {
	readonly id: string;
	readonly severity: CritiqueSeverity;
	readonly issue: string;
	readonly impact: string;
	readonly alternative: string;
	readonly evidence_ids: readonly string[];
	readonly disposition: CritiqueDisposition;
	readonly disposition_rationale: string;
	readonly dissent: string | null;
}

export interface BlindCommitmentCritique {
	readonly critic_id: string;
	readonly model: "pi/slow";
	readonly blind: true;
	readonly findings: readonly CritiqueFinding[];
}

export interface CommitmentCritiquePair {
	readonly trigger: "approach-commitment" | "medium-confidence-decision" | "non-goal";
	readonly critics: readonly [BlindCommitmentCritique, BlindCommitmentCritique];
}

export interface Readiness {
	readonly status: ReadinessStatus;
	readonly blockers: readonly string[];
	readonly bounded_ambiguities: readonly BoundedAmbiguity[];
}

export interface BoundedAmbiguity {
	readonly id: string;
	readonly unknown: string;
	readonly affected_fields: readonly string[];
	readonly resolution_needed: string;
}

interface VisualSemanticBase {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly units: string;
	readonly source_evidence_ids: readonly string[];
	readonly semantic_ids: readonly string[];
	/** Exact visible authority; the diagram must add no facts beyond this text. */
	readonly textual_equivalent: string;
}

export interface FlowVisualSemantic extends VisualSemanticBase {
	readonly type: "flow";
	readonly data: Readonly<{
		readonly nodes: readonly Readonly<{
			readonly node_id: string;
			readonly label: string;
			readonly description: string;
		}>[];
		readonly edges: readonly Readonly<{ readonly from: string; readonly to: string; readonly label: string }>[];
	}>;
}

export interface BarVisualSemantic extends VisualSemanticBase {
	readonly type: "bar";
	readonly data: Readonly<{ readonly entries: readonly Readonly<{ readonly label: string; readonly value: number }>[] }>;
}

export interface MatrixVisualSemantic extends VisualSemanticBase {
	readonly type: "matrix";
	readonly data: Readonly<{
		readonly x_axis: string;
		readonly y_axis: string;
		readonly points: readonly Readonly<{ readonly label: string; readonly x: number; readonly y: number }>[];
	}>;
}

export interface TimelineVisualSemantic extends VisualSemanticBase {
	readonly type: "timeline";
	readonly data: Readonly<{
		readonly entries: readonly Readonly<{ readonly label: string; readonly start: number; readonly end: number }>[];
	}>;
}

export interface ComparisonVisualSemantic extends VisualSemanticBase {
	readonly type: "comparison";
	readonly data: Readonly<{
		readonly entries: readonly Readonly<{ readonly label: string; readonly left: number; readonly right: number }>[];
	}>;
}

export type VisualSemantic =
	| FlowVisualSemantic
	| BarVisualSemantic
	| MatrixVisualSemantic
	| TimelineVisualSemantic
	| ComparisonVisualSemantic;
export interface FinalDocumentReviewSubject {
	readonly subject_id: string;
	readonly semantic_revision: number;
	readonly subject_sha256: string;
	readonly predecessor_subject_sha256: string | null;
}

export interface FinalDocumentReviewAssignment {
	readonly reviewer_id: string;
	readonly assignment_role: string;
	readonly selector: "pi/slow";
	readonly model: "pi/slow";
	readonly provider: string;
	readonly blind: true;
	readonly assignment_kind: "baseline" | "specialist";
	readonly primary_domain: string;
	readonly secondary_domains: readonly string[];
	readonly artifact_access: readonly string[];
	readonly shared_invariant_ids: readonly string[];
	readonly specialist_trigger: FinalDocumentReviewSpecialistTrigger | null;
}
export interface FinalDocumentReviewSpecialistTrigger {
	readonly trigger_id: string;
	readonly evidence: string;
}

export interface FinalDocumentReviewFinding {
	readonly stable_id: string;
	readonly occurrence_id: string;
	readonly severity: FinalReviewFindingSeverity;
	readonly affected_criteria_ids: readonly string[];
	readonly affected_semantic_ids: readonly string[];
	readonly evidence_ids: readonly string[];
	readonly failure_mechanism: string;
	readonly recommendation: string;
	readonly disposition: FinalReviewFindingDisposition;
	readonly duplicate_of: string | null;
	readonly recurrence_of: string | null;
	readonly regression_of: string | null;
	readonly caused_by: string | null;
	readonly supersedes: string | null;
}

/**
 * A substantive reviewer result is a closed mirror of an immutable persisted
 * result file. The runtime reopens that file and rejects it unless its exact
 * canonical bytes hash to `result_sha256` and reproduce this record.
 */
export interface FinalDocumentReviewResult {
	readonly reviewer_id: string;
	readonly assignment_role: string;
	readonly selector: "pi/slow";
	readonly model: "pi/slow";
	readonly provider: string;
	readonly review_subject_sha256: string;
	readonly result_path: string;
	readonly result_sha256: string;
	readonly completed_at: string;
	readonly verdict: "PASS" | "BLOCK" | "UNRESOLVED";
	readonly assessed_criteria_ids: readonly string[];
	readonly assessed_invariant_ids: readonly string[];
	readonly findings: readonly FinalDocumentReviewFinding[];
	readonly dissent: readonly string[];
	readonly limitations: readonly string[];
}

/** Validator-derived only; this shape is never accepted from state input. */
export interface FinalDocumentReviewGate {
	readonly outcome: FinalReviewGateOutcome;
	readonly assessed_criteria_ids: readonly string[];
	readonly assessed_invariant_ids: readonly string[];
	readonly blocking_occurrence_ids: readonly string[];
	readonly missing_reviewer_ids: readonly string[];
	readonly dissent: readonly string[];
	readonly limitations: readonly string[];
	readonly cap_exhausted: boolean;
}

export interface FinalDocumentReviewRound {
	readonly round: number;
	readonly subject: FinalDocumentReviewSubject;
	readonly mandatory_invariant_ids: readonly string[];
	readonly reviewers: readonly FinalDocumentReviewAssignment[];
	readonly results: readonly FinalDocumentReviewResult[];
}


export interface FinalDocumentReviewEpisode {
	readonly episode: number;
	readonly first_round: number;
	readonly semantic_revision: number;
	readonly subject_sha256: string;
	readonly predecessor_episode_sha256: string | null;
	readonly predecessor_state_sha256: string | null;
	readonly predecessor_candidate_record_path: string | null;
	readonly predecessor_candidate_record_sha256: string | null;
	readonly predecessor_response_record_path: string | null;
	readonly predecessor_response_record_sha256: string | null;
	readonly predecessor_import_current_candidate_sha256: string | null;
}

export interface FinalDocumentReview {
	readonly schema: typeof IDEATION_FINAL_REVIEW_SCHEMA;
	readonly episodes: readonly FinalDocumentReviewEpisode[];
	readonly current_episode: number | null;
	readonly rounds: readonly FinalDocumentReviewRound[];
	readonly current_round: number | null;
}

export interface IdeationState {
	readonly schema: typeof IDEATION_STATE_SCHEMA;
	readonly slug: string;
	readonly run_id: string;
	readonly revision: number;
	readonly predecessor_sha256: string | null;
	readonly max_review_rounds: 1 | 2 | 3 | 4 | 5;
	readonly revision_kind: "accepted-answer" | "non-answer";
	readonly title: string;
	readonly commitment_level: CommitmentLevel;
	readonly goal: IdeationGoal;
	readonly criteria: readonly EvaluationCriterion[];
	readonly scope: Scope;
	readonly decisions: readonly Decision[];
	readonly assumptions: readonly Assumption[];
	readonly evidence: readonly Evidence[];
	readonly commitment_critique: CommitmentCritiquePair | null;
	readonly final_document_review: FinalDocumentReview;
	readonly readiness: Readiness;
	readonly visuals: readonly VisualSemantic[];
	readonly interview_exchanges: readonly IdeationInterviewExchange[];
	readonly review_item_presentations: readonly IdeationReviewItemPresentation[];
}

const HASH = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function validateIdeationState(input: unknown): IdeationState {
	const state = closedObject(input, "$", [
		"schema", "slug", "run_id", "revision", "predecessor_sha256", "max_review_rounds", "revision_kind",
		"title", "commitment_level", "goal", "criteria", "scope", "decisions", "assumptions", "evidence",
		"commitment_critique", "final_document_review", "readiness", "visuals", "interview_exchanges", "review_item_presentations",
	]);
	const validatedRevision = positiveInteger(state.revision, "$.revision");
	const validatedPredecessor = nullableHash(state.predecessor_sha256, "$.predecessor_sha256");
	if (validatedRevision === 1 && validatedPredecessor !== null)
		fail("$.predecessor_sha256", "revision 1 must have a null predecessor");
	if (validatedRevision > 1 && validatedPredecessor === null)
		fail("$.predecessor_sha256", "later revisions require an immutable predecessor");
	const validatedSlug = slug(state.slug, "$.slug");
	const validatedRunId = runId(state.run_id, "$.run_id");
	const goal = validateGoal(state.goal);
	const evidence = sortedUnique(state.evidence, "$.evidence", validateEvidence);
	const evidenceIds = new Set(evidence.map(entry => entry.id));
	const criteria = sortedUnique(state.criteria, "$.criteria", (entry, path) =>
		validateCriterion(entry, path, evidenceIds),
	);
	const decisions = sortedUnique(state.decisions, "$.decisions", (entry, path) =>
		validateDecision(entry, path, evidenceIds),
	);
	const assumptions = sortedUnique(state.assumptions, "$.assumptions", (entry, path) =>
		validateAssumption(entry, path, evidenceIds),
	);
	const critique =
		state.commitment_critique === null ? null : validateCommitmentCritique(state.commitment_critique, evidenceIds);
	const readiness = validateReadiness(state.readiness);
	const scope = validateScope(state.scope);
	const baseSemanticIds = new Set([
		goal.id,
		...criteria.map(entry => entry.id),
		...decisions.map(entry => entry.id),
		...assumptions.map(entry => entry.id),
		...readiness.bounded_ambiguities.map(entry => entry.id),
	]);
	const visuals = sortedUnique(state.visuals, "$.visuals", (entry, path) =>
		validateVisual(entry, path, evidenceIds, baseSemanticIds),
	);
	const semanticIds = new Set([...baseSemanticIds, ...visuals.map(entry => entry.id)]);
	const interviewExchanges = validateInterviewExchanges(state.interview_exchanges, evidenceIds);
	const maxReviewRounds = reviewRoundCount(state.max_review_rounds, "$.max_review_rounds");
	const revisionKind = oneOf(state.revision_kind, ["accepted-answer", "non-answer"] as const, "$.revision_kind");
	const reviewItemPresentations = validateReviewItemPresentations(state.review_item_presentations, evidenceIds, semanticIds, goal, criteria, decisions, assumptions, readiness);
	const allCriterionIds = new Set(criteria.map(criterion => criterion.id));
	const mandatoryCriterionIds = new Set(criteria.filter(criterion => criterion.priority === "P0").map(criterion => criterion.id));
	const currentReviewSubjectSha256 = hashIdeationSemanticReviewSubject({ run_id: validatedRunId, revision: validatedRevision, predecessor_sha256: validatedPredecessor, max_review_rounds: maxReviewRounds, revision_kind: revisionKind, title: nonEmpty(state.title, "$.title"), commitment_level: oneOf(state.commitment_level, ["exploration", "planning", "building"] as const, "$.commitment_level"), goal, criteria, scope, decisions, assumptions, evidence, commitment_critique: critique, readiness, visuals, interview_exchanges: interviewExchanges, review_item_presentations: reviewItemPresentations });
	const finalDocumentReview = validateFinalDocumentReview(state.final_document_review, validatedSlug, maxReviewRounds, evidenceIds, allCriterionIds, mandatoryCriterionIds, semanticIds, validatedRevision, currentReviewSubjectSha256);
	if (validatedRevision === 1 && (revisionKind !== "non-answer" || interviewExchanges.length !== 0)) fail("$", "genesis requires non-answer and zero exchanges");
	if (validatedRevision > 1 && revisionKind === "accepted-answer" && interviewExchanges.length === 0) fail("$.interview_exchanges", "accepted-answer requires an appended exchange");
	if (readiness.status !== "draft" && critique === null) fail("$.commitment_critique", "a commitment critique pair is required after commitment");
	if (readiness.status !== "draft" && !criteria.some(criterion => criterion.priority === "P0")) fail("$.criteria", "a ready state requires a P0 criterion");
	if (readiness.status !== "draft" && evidence.length === 0) fail("$.evidence", "a ready state requires at least one source locator");
	if (readiness.status !== "draft" && readiness.blockers.length !== 0) fail("$.readiness.blockers", "a ready state cannot retain blockers");
	if (readiness.status === "ready-for-approval" && deriveFinalDocumentReviewGate(finalDocumentReview, mandatoryCriterionIds, maxReviewRounds).outcome !== "PASS") {
		const currentEpisode = finalDocumentReview.episodes.at(-1);
		const responseDrivenReopen = currentEpisode !== undefined && currentEpisode.episode > 1 && currentEpisode.predecessor_candidate_record_path !== null && currentEpisode.predecessor_candidate_record_sha256 !== null && currentEpisode.predecessor_response_record_path !== null && currentEpisode.predecessor_response_record_sha256 !== null && currentEpisode.predecessor_import_current_candidate_sha256 !== null;
		if (!responseDrivenReopen) fail("$.final_document_review", "ready-for-approval requires a current substantive review PASS unless a response-driven later episode preserves readiness");
	}
	return Object.freeze({ schema: exact(state.schema, IDEATION_STATE_SCHEMA, "$.schema"), slug: validatedSlug, run_id: validatedRunId, revision: validatedRevision, predecessor_sha256: validatedPredecessor, max_review_rounds: maxReviewRounds, revision_kind: revisionKind, title: nonEmpty(state.title, "$.title"), commitment_level: oneOf(state.commitment_level, ["exploration", "planning", "building"] as const, "$.commitment_level"), goal, criteria, scope, decisions, assumptions, evidence, commitment_critique: critique, final_document_review: finalDocumentReview, readiness, visuals, interview_exchanges: interviewExchanges, review_item_presentations: reviewItemPresentations });
}

export function ideationStateSha256(input: IdeationState): string {
	return hashCanonicalJson(validateIdeationState(input));
}

/** Hashes only validated semantic fields; review records cannot influence their subject. */
export function ideationReviewSubjectSha256(input: IdeationState): string {
	const state = validateIdeationState(input);
	return hashIdeationSemanticReviewSubject(state);
}

function hashIdeationSemanticReviewSubject(
	state: Pick<
		IdeationState,
		| "run_id"
		| "revision"
		| "predecessor_sha256"
		| "max_review_rounds"
		| "revision_kind"
		| "title"
		| "commitment_level"
		| "goal"
		| "criteria"
		| "scope"
		| "decisions"
		| "assumptions"
		| "evidence"
		| "commitment_critique"
		| "readiness"
		| "visuals"
		| "interview_exchanges"
		| "review_item_presentations"
	>,
): string {
	return hashCanonicalJson({
		schema: "ideation-with-critique/review-subject/v1",
		workflow: IDEATION_WORKFLOW,
		run_id: state.run_id,
		revision: state.revision,
		predecessor_sha256: state.predecessor_sha256,
		max_review_rounds: state.max_review_rounds,
		revision_kind: state.revision_kind,
		title: state.title,
		commitment_level: state.commitment_level,
		goal: state.goal,
		criteria: state.criteria,
		scope: state.scope,
		decisions: state.decisions,
		assumptions: state.assumptions,
		evidence: state.evidence,
		commitment_critique: state.commitment_critique,
		readiness: { blockers: state.readiness.blockers, bounded_ambiguities: state.readiness.bounded_ambiguities },
		visuals: state.visuals,
		interview_exchanges: state.interview_exchanges,
		review_item_presentations: state.review_item_presentations,
	});
}

export function createIdeationSemanticBinding(input: IdeationState): SemanticBinding {
	const state = validateIdeationState(input);
	return Object.freeze({
		schema: SEMANTIC_BINDING_SCHEMA,
		workflow: IDEATION_WORKFLOW,
		run_id: state.run_id,
		revision: state.revision,
		semantic_sha256: ideationStateSha256(state),
		predecessor_sha256: state.predecessor_sha256,
	});
}

function validateGoal(input: unknown): IdeationGoal {
	const value = closedObject(input, "$.goal", ["id", "statement", "beneficiaries", "context"]);
	return Object.freeze({
		id: prefixedId(value.id, "G", "$.goal.id"),
		statement: nonEmpty(value.statement, "$.goal.statement"),
		beneficiaries: textList(value.beneficiaries, "$.goal.beneficiaries"),
		context: nonEmpty(value.context, "$.goal.context"),
	});
}

function validateCriterion(input: unknown, path: string, evidenceIds: ReadonlySet<string>): EvaluationCriterion {
	const value = closedObject(input, path, [
		"id",
		"priority",
		"criterion",
		"threshold",
		"verification_method",
		"evidence_ids",
	]);
	return Object.freeze({
		id: prefixedId(value.id, "C", `${path}.id`),
		priority: oneOf(value.priority, ["P0", "P1", "P2"] as const, `${path}.priority`),
		criterion: nonEmpty(value.criterion, `${path}.criterion`),
		threshold: nonEmpty(value.threshold, `${path}.threshold`),
		verification_method: nonEmpty(value.verification_method, `${path}.verification_method`),
		evidence_ids: evidenceReferences(value.evidence_ids, `${path}.evidence_ids`, evidenceIds),
	});
}

function validateScope(input: unknown): Scope {
	const value = closedObject(input, "$.scope", ["in_scope", "non_goals", "deferred"]);
	return Object.freeze({
		in_scope: textList(value.in_scope, "$.scope.in_scope"),
		non_goals: textList(value.non_goals, "$.scope.non_goals"),
		deferred: textList(value.deferred, "$.scope.deferred"),
	});
}

function validateDecision(input: unknown, path: string, evidenceIds: ReadonlySet<string>): Decision {
	const value = closedObject(input, path, [
		"id",
		"statement",
		"type",
		"confidence",
		"status",
		"rationale",
		"evidence_ids",
	]);
	return Object.freeze({
		id: prefixedId(value.id, "D", `${path}.id`),
		statement: nonEmpty(value.statement, `${path}.statement`),
		type: oneOf(value.type, ["goal", "non-goal", "constraint", "critique-resolution"] as const, `${path}.type`),
		confidence: oneOf(value.confidence, ["low", "medium", "high"] as const, `${path}.confidence`),
		status: oneOf(value.status, ["active", "superseded"] as const, `${path}.status`),
		rationale: nonEmpty(value.rationale, `${path}.rationale`),
		evidence_ids: evidenceReferences(value.evidence_ids, `${path}.evidence_ids`, evidenceIds),
	});
}

function validateAssumption(input: unknown, path: string, evidenceIds: ReadonlySet<string>): Assumption {
	const value = closedObject(input, path, ["id", "statement", "load_bearing", "if_wrong", "tested", "evidence_ids"]);
	if (typeof value.load_bearing !== "boolean") fail(`${path}.load_bearing`, "must be boolean");
	return Object.freeze({
		id: prefixedId(value.id, "A", `${path}.id`),
		statement: nonEmpty(value.statement, `${path}.statement`),
		load_bearing: value.load_bearing,
		if_wrong: nonEmpty(value.if_wrong, `${path}.if_wrong`),
		tested: oneOf(value.tested, ["yes", "no", "partial"] as const, `${path}.tested`),
		evidence_ids: evidenceReferences(value.evidence_ids, `${path}.evidence_ids`, evidenceIds),
	});
}

function validateEvidence(input: unknown, path: string): Evidence {
	const value = closedObject(input, path, ["id", "locator", "description", "sha256"]);
	return Object.freeze({
		id: prefixedId(value.id, "E", `${path}.id`),
		locator: nonEmpty(value.locator, `${path}.locator`),
		description: nonEmpty(value.description, `${path}.description`),
		sha256: nullableHash(value.sha256, `${path}.sha256`),
	});
}

function validateCommitmentCritique(input: unknown, evidenceIds: ReadonlySet<string>): CommitmentCritiquePair {
	const value = closedObject(input, "$.commitment_critique", ["trigger", "critics"]);
	if (!Array.isArray(value.critics) || value.critics.length !== 2)
		fail("$.commitment_critique.critics", "exactly two critics are required");
	const critics = value.critics.map((critic, index) =>
		validateCritic(critic, `$.commitment_critique.critics[${index}]`, evidenceIds),
	) as [BlindCommitmentCritique, BlindCommitmentCritique];
	if (critics[0].critic_id === critics[1].critic_id) fail("$.commitment_critique.critics", "critics must be distinct");
	return Object.freeze({
		trigger: oneOf(
			value.trigger,
			["approach-commitment", "medium-confidence-decision", "non-goal"] as const,
			"$.commitment_critique.trigger",
		),
		critics: Object.freeze(critics),
	});
}

function validateCritic(input: unknown, path: string, evidenceIds: ReadonlySet<string>): BlindCommitmentCritique {
	const value = closedObject(input, path, ["critic_id", "model", "blind", "findings"]);
	if (value.blind !== true) fail(`${path}.blind`, "critics must be blind");
	return Object.freeze({
		critic_id: nonEmpty(value.critic_id, `${path}.critic_id`),
		model: exact(value.model, "pi/slow", `${path}.model`),
		blind: true,
		findings: sortedUnique(value.findings, `${path}.findings`, (finding, findingPath) =>
			validateFinding(finding, findingPath, evidenceIds),
		),
	});
}

function validateFinding(input: unknown, path: string, evidenceIds: ReadonlySet<string>): CritiqueFinding {
	const value = closedObject(input, path, [
		"id",
		"severity",
		"issue",
		"impact",
		"alternative",
		"evidence_ids",
		"disposition",
		"disposition_rationale",
		"dissent",
	]);
	return Object.freeze({
		id: id(value.id, `${path}.id`),
		severity: oneOf(value.severity, ["show-stopper", "important", "minor"] as const, `${path}.severity`),
		issue: nonEmpty(value.issue, `${path}.issue`),
		impact: nonEmpty(value.impact, `${path}.impact`),
		alternative: nonEmpty(value.alternative, `${path}.alternative`),
		evidence_ids: evidenceReferences(value.evidence_ids, `${path}.evidence_ids`, evidenceIds),
		disposition: oneOf(
			value.disposition,
			["accepted", "mitigated", "deferred", "rejected"] as const,
			`${path}.disposition`,
		),
		disposition_rationale: nonEmpty(value.disposition_rationale, `${path}.disposition_rationale`),
		dissent: nullableText(value.dissent, `${path}.dissent`),
	});
}
function validateFinalDocumentReview(
	input: unknown,
	slugValue: string,
	maxReviewRounds: 1 | 2 | 3 | 4 | 5,
	evidenceIds: ReadonlySet<string>,
	criterionIds: ReadonlySet<string>,
	mandatoryCriterionIds: ReadonlySet<string>,
	semanticIds: ReadonlySet<string>,
	currentSemanticRevision: number,
	currentSubjectSha256: string,
): FinalDocumentReview {
	const value = closedObject(input, "$.final_document_review", [
		"schema",
		"episodes",
		"current_episode",
		"rounds",
		"current_round",
	]);
	exact(value.schema, IDEATION_FINAL_REVIEW_SCHEMA, "$.final_document_review.schema");
	if (!Array.isArray(value.rounds)) fail("$.final_document_review.rounds", "must be an array");
	const occurrenceIds = new Set<string>();
	let predecessorRoundOccurrenceIds = new Set<string>();
	const rounds = value.rounds.map((entry, index) => {
		const round = validateFinalReviewRound(
			entry,
			`$.final_document_review.rounds[${index}]`,
			slugValue,
			evidenceIds,
			criterionIds,
			semanticIds,
			occurrenceIds,
			predecessorRoundOccurrenceIds,
		);
		predecessorRoundOccurrenceIds = new Set(
			round.results.flatMap(result => result.findings).map(finding => finding.occurrence_id),
		);
		if (round.round !== index + 1) fail("$.final_document_review.rounds", "rounds must be consecutive starting at 1");
		return round;
	});
	if (!Array.isArray(value.episodes)) fail("$.final_document_review.episodes", "must be an array");
	const episodes = value.episodes.map((entry, index) =>
		validateFinalReviewEpisode(entry, `$.final_document_review.episodes[${index}]`),
	);
	if ((rounds.length === 0) !== (episodes.length === 0))
		fail("$.final_document_review", "review rounds and episodes must both be empty or both be present");
	for (let index = 0; index < episodes.length; index += 1) {
		const episode = episodes[index]!;
		if (episode.episode !== index + 1)
			fail("$.final_document_review.episodes", "episodes must be consecutive starting at 1");
		const nextFirstRound = episodes[index + 1]?.first_round ?? rounds.length + 1;
		const episodeRounds = rounds.slice(episode.first_round - 1, nextFirstRound - 1);
		if (
			episode.first_round > rounds.length ||
			episodeRounds.length === 0 ||
			(index === 0 ? episode.first_round !== 1 : episode.first_round <= episodes[index - 1]!.first_round)
		)
			fail("$.final_document_review.episodes", "episodes must partition consecutive review rounds");
		if (episodeRounds.length > maxReviewRounds)
			fail(`$.final_document_review.episodes[${index}]`, "exceeds configured review cap");
		const first = episodeRounds[0]!;
		if (
			episode.semantic_revision !== first.subject.semantic_revision ||
			episode.subject_sha256 !== first.subject.subject_sha256
		)
			fail(
				`$.final_document_review.episodes[${index}]`,
				"episode must bind its exact initial semantic revision and subject",
			);
		if (index === 0) {
			if (
				episode.predecessor_episode_sha256 !== null ||
				episode.predecessor_state_sha256 !== null ||
				episode.predecessor_candidate_record_path !== null ||
				episode.predecessor_candidate_record_sha256 !== null ||
				episode.predecessor_response_record_path !== null ||
				episode.predecessor_response_record_sha256 !== null ||
				episode.predecessor_import_current_candidate_sha256 !== null ||
				first.subject.predecessor_subject_sha256 !== null
			)
				fail(
					`$.final_document_review.episodes[${index}]`,
					"the initial episode cannot bind predecessor authority",
				);
		} else {
			if (
				episode.predecessor_candidate_record_path === null ||
				episode.predecessor_candidate_record_sha256 === null ||
				episode.predecessor_response_record_path === null ||
				episode.predecessor_response_record_sha256 === null ||
				episode.predecessor_import_current_candidate_sha256 === null
			)
				fail(
					`$.final_document_review.episodes[${index}]`,
					"a response-driven later episode requires complete predecessor authority",
				);
			const predecessorEpisode = episodes[index - 1]!;
			const predecessorRounds = rounds.slice(predecessorEpisode.first_round - 1, episode.first_round - 1);
			const predecessor = predecessorRounds.at(-1)!;
			if (
				episode.predecessor_episode_sha256 !== hashFinalReviewEpisode(predecessorEpisode, predecessorRounds) ||
				episode.predecessor_state_sha256 === null
			)
				fail(
					`$.final_document_review.episodes[${index}]`,
					"successor episode must bind the immutable predecessor episode and state",
				);
			if (
				first.subject.predecessor_subject_sha256 !== predecessor.subject.subject_sha256 ||
				first.subject.semantic_revision !== predecessor.subject.semantic_revision + 1
			)
				fail(
					`$.final_document_review.episodes[${index}]`,
					"successor episode must bind the immediate predecessor subject and increment semantic revision once",
				);
			const predecessorGate = deriveFinalReviewRoundGate(
				predecessor,
				mandatoryCriterionIds,
				maxReviewRounds,
				predecessorRounds.length,
			);
			if (predecessorGate.outcome !== "PASS")
				fail(
					`$.final_document_review.episodes[${index}]`,
					"a reopened review episode requires an immediate predecessor PASS",
				);
			assertPendingFindingsCarried(predecessor, first, `$.final_document_review.rounds[${episode.first_round - 1}]`);
		}
		for (let offset = 1; offset < episodeRounds.length; offset += 1) {
			const predecessor = episodeRounds[offset - 1]!;
			const successor = episodeRounds[offset]!;
			if (
				successor.subject.predecessor_subject_sha256 !== predecessor.subject.subject_sha256 ||
				successor.subject.semantic_revision !== predecessor.subject.semantic_revision + 1
			)
				fail(
					"$.final_document_review.rounds",
					"a successor must bind the immediate predecessor subject and increment semantic revision once",
				);
			const predecessorGate = deriveFinalReviewRoundGate(
				predecessor,
				mandatoryCriterionIds,
				maxReviewRounds,
				offset,
			);
			if (predecessorGate.outcome !== "BLOCK" && predecessorGate.outcome !== "UNRESOLVED")
				fail(
					"$.final_document_review.rounds",
					"a successor round requires an immediate BLOCK or UNRESOLVED predecessor within its episode",
				);
			assertPendingFindingsCarried(
				predecessor,
				successor,
				`$.final_document_review.rounds[${episode.first_round + offset - 1}]`,
			);
		}
	}
	const subjectIds = rounds.map(round => round.subject.subject_id);
	const subjectHashes = rounds.map(round => round.subject.subject_sha256);
	if (new Set(subjectIds).size !== subjectIds.length || new Set(subjectHashes).size !== subjectHashes.length)
		fail("$.final_document_review.rounds", "round subjects must be immutable and unique");
	const currentEpisode =
		value.current_episode === null
			? null
			: positiveInteger(value.current_episode, "$.final_document_review.current_episode");
	const currentRound =
		value.current_round === null
			? null
			: positiveInteger(value.current_round, "$.final_document_review.current_round");
	if (currentEpisode !== null && currentEpisode !== episodes.length)
		fail("$.final_document_review.current_episode", "must identify the latest episode");
	if (currentRound !== null && (rounds.length === 0 || currentRound !== rounds.length))
		fail("$.final_document_review.current_round", "must identify the latest consecutive round");
	if ((currentEpisode === null) !== (currentRound === null) || (currentRound === null && rounds.length !== 0))
		fail("$.final_document_review", "current episode and round must identify the latest review authority");
	if (currentRound !== null) {
		const current = rounds.at(-1)!;
		if (
			current.subject.semantic_revision !== currentSemanticRevision ||
			current.subject.subject_sha256 !== currentSubjectSha256
		)
			fail("$.final_document_review", "latest review subject must bind the current semantic revision");
	}
	return Object.freeze({
		schema: IDEATION_FINAL_REVIEW_SCHEMA,
		episodes: Object.freeze(episodes),
		current_episode: currentEpisode,
		rounds: Object.freeze(rounds),
		current_round: currentRound,
	});
}

function validateFinalReviewEpisode(input: unknown, path: string): FinalDocumentReviewEpisode {
	const value = closedObject(input, path, ["episode", "first_round", "semantic_revision", "subject_sha256", "predecessor_episode_sha256", "predecessor_state_sha256", "predecessor_candidate_record_path", "predecessor_candidate_record_sha256", "predecessor_response_record_path", "predecessor_response_record_sha256", "predecessor_import_current_candidate_sha256"]);
	return Object.freeze({ episode: positiveInteger(value.episode, `${path}.episode`), first_round: positiveInteger(value.first_round, `${path}.first_round`), semantic_revision: positiveInteger(value.semantic_revision, `${path}.semantic_revision`), subject_sha256: hash(value.subject_sha256, `${path}.subject_sha256`), predecessor_episode_sha256: nullableHash(value.predecessor_episode_sha256, `${path}.predecessor_episode_sha256`), predecessor_state_sha256: nullableHash(value.predecessor_state_sha256, `${path}.predecessor_state_sha256`), predecessor_candidate_record_path: nullableText(value.predecessor_candidate_record_path, `${path}.predecessor_candidate_record_path`), predecessor_candidate_record_sha256: nullableHash(value.predecessor_candidate_record_sha256, `${path}.predecessor_candidate_record_sha256`), predecessor_response_record_path: nullableText(value.predecessor_response_record_path, `${path}.predecessor_response_record_path`), predecessor_response_record_sha256: nullableHash(value.predecessor_response_record_sha256, `${path}.predecessor_response_record_sha256`), predecessor_import_current_candidate_sha256: nullableHash(value.predecessor_import_current_candidate_sha256, `${path}.predecessor_import_current_candidate_sha256`) });
}


function validateFinalReviewRound(
	input: unknown,
	path: string,
	slugValue: string,
	evidenceIds: ReadonlySet<string>,
	criterionIds: ReadonlySet<string>,
	semanticIds: ReadonlySet<string>,
	occurrenceIds: Set<string>,
	priorRoundOccurrenceIds: ReadonlySet<string>,
): FinalDocumentReviewRound {
	const value = closedObject(input, path, ["round", "subject", "mandatory_invariant_ids", "reviewers", "results"]);
	const round = positiveInteger(value.round, `${path}.round`);
	const subject = validateFinalReviewSubject(value.subject, `${path}.subject`);
	const invariants = textList(value.mandatory_invariant_ids, `${path}.mandatory_invariant_ids`);
	if (invariants.length === 0) fail(`${path}.mandatory_invariant_ids`, "at least one shared invariant is required");
	if (!Array.isArray(value.reviewers)) fail(`${path}.reviewers`, "must be an array");
	if (value.reviewers.length < 4 || value.reviewers.length > 6)
		fail(`${path}.reviewers`, "panel must contain four baseline reviewers and at most two specialists");
	const reviewers = value.reviewers.map((entry, index) =>
		validateFinalReviewAssignment(entry, `${path}.reviewers[${index}]`, invariants),
	);
	validateSubstantiveReviewAssignments(
		reviewers.map(reviewer => ({
			role: reviewer.assignment_role,
			blind: reviewer.blind,
			specialist_trigger: reviewer.specialist_trigger,
		})),
	);
	const reviewerIds = reviewers.map(reviewer => reviewer.reviewer_id);
	if (new Set(reviewerIds).size !== reviewerIds.length) fail(`${path}.reviewers`, "reviewer IDs must be unique");
	const baselineRoles = reviewers
		.filter(reviewer => reviewer.assignment_kind === "baseline")
		.map(reviewer => reviewer.assignment_role);
	if (
		baselineRoles.length !== BASELINE_SUBSTANTIVE_REVIEW_ROLES.length ||
		BASELINE_SUBSTANTIVE_REVIEW_ROLES.some(role => !baselineRoles.includes(role))
	)
		fail(`${path}.reviewers`, "the canonical four baseline roles are mandatory");
	const specialists = reviewers.filter(reviewer => reviewer.assignment_kind === "specialist");
	if (specialists.length !== reviewers.length - BASELINE_SUBSTANTIVE_REVIEW_ROLES.length || specialists.length > 2)
		fail(`${path}.reviewers`, "panels contain exactly the four baseline roles plus zero to two specialists");
	const triggerIds = specialists.map(reviewer => reviewer.specialist_trigger!.trigger_id);
	if (new Set(triggerIds).size !== triggerIds.length)
		fail(`${path}.reviewers`, "specialists require distinct trigger records");
	if (!Array.isArray(value.results)) fail(`${path}.results`, "must be an array");
	const results = value.results.map((entry, index) =>
		validateFinalReviewResult(
			entry,
			`${path}.results[${index}]`,
			slugValue,
			subject,
			reviewers,
			invariants,
			evidenceIds,
			criterionIds,
			semanticIds,
			occurrenceIds,
			priorRoundOccurrenceIds,
		),
	);
	for (let index = 1; index < results.length; index += 1)
		if (results[index - 1]!.reviewer_id >= results[index]!.reviewer_id)
			fail(`${path}.results`, "reviewer results must be sorted and unique");
	return Object.freeze({
		round,
		subject,
		mandatory_invariant_ids: invariants,
		reviewers: Object.freeze(reviewers),
		results: Object.freeze(results),
	});
}

function validateFinalReviewSubject(input: unknown, path: string): FinalDocumentReviewSubject {
	const value = closedObject(input, path, [
		"subject_id",
		"semantic_revision",
		"subject_sha256",
		"predecessor_subject_sha256",
	]);
	return Object.freeze({
		subject_id: id(value.subject_id, `${path}.subject_id`),
		semantic_revision: positiveInteger(value.semantic_revision, `${path}.semantic_revision`),
		subject_sha256: hash(value.subject_sha256, `${path}.subject_sha256`),
		predecessor_subject_sha256: nullableHash(value.predecessor_subject_sha256, `${path}.predecessor_subject_sha256`),
	});
}

function validateFinalReviewAssignment(
	input: unknown,
	path: string,
	invariants: readonly string[],
): FinalDocumentReviewAssignment {
	const value = closedObject(input, path, [
		"reviewer_id",
		"assignment_role",
		"selector",
		"model",
		"provider",
		"blind",
		"assignment_kind",
		"primary_domain",
		"secondary_domains",
		"artifact_access",
		"shared_invariant_ids",
		"specialist_trigger",
	]);
	if (value.blind !== true) fail(`${path}.blind`, "reviewers must be blind");
	const assignmentKind = oneOf(value.assignment_kind, ["baseline", "specialist"] as const, `${path}.assignment_kind`);
	const sharedAssignment = validateSubstantiveReviewAssignment(
		{ role: value.assignment_role, blind: value.blind, specialist_trigger: value.specialist_trigger },
		path,
	);
	const assignmentRole =
		assignmentKind === "baseline"
			? oneOf(sharedAssignment.role, BASELINE_SUBSTANTIVE_REVIEW_ROLES, `${path}.assignment_role`)
			: sharedAssignment.role;
	if (assignmentKind === "specialist" && sharedAssignment.specialist_trigger === null)
		fail(`${path}.specialist_trigger`, "specialists require a closed non-empty trigger record");
	if (assignmentKind === "baseline" && sharedAssignment.specialist_trigger !== null)
		fail(`${path}.specialist_trigger`, "baseline reviewers require a null specialist trigger");
	const sharedInvariantIds = textList(value.shared_invariant_ids, `${path}.shared_invariant_ids`);
	if (sharedInvariantIds.join("\u0000") !== invariants.join("\u0000"))
		fail(`${path}.shared_invariant_ids`, "all reviewers must share the panel invariants");
	return Object.freeze({
		reviewer_id: id(value.reviewer_id, `${path}.reviewer_id`),
		assignment_role: assignmentRole,
		selector: exact(value.selector, "pi/slow", `${path}.selector`),
		model: exact(value.model, "pi/slow", `${path}.model`),
		provider: nonEmpty(value.provider, `${path}.provider`),
		blind: true,
		assignment_kind: assignmentKind,
		primary_domain: nonEmpty(value.primary_domain, `${path}.primary_domain`),
		secondary_domains: textList(value.secondary_domains, `${path}.secondary_domains`),
		artifact_access: textList(value.artifact_access, `${path}.artifact_access`),
		shared_invariant_ids: sharedInvariantIds,
		specialist_trigger: sharedAssignment.specialist_trigger,
	});
}

function validateFinalReviewResult(
	input: unknown,
	path: string,
	slugValue: string,
	subject: FinalDocumentReviewSubject,
	reviewers: readonly FinalDocumentReviewAssignment[],
	invariants: readonly string[],
	evidenceIds: ReadonlySet<string>,
	criterionIds: ReadonlySet<string>,
	semanticIds: ReadonlySet<string>,
	occurrenceIds: Set<string>,
	priorRoundOccurrenceIds: ReadonlySet<string>,
): FinalDocumentReviewResult {
	const value = closedObject(input, path, [
		"reviewer_id",
		"assignment_role",
		"selector",
		"model",
		"provider",
		"review_subject_sha256",
		"result_path",
		"result_sha256",
		"completed_at",
		"verdict",
		"assessed_criteria_ids",
		"assessed_invariant_ids",
		"findings",
		"dissent",
		"limitations",
	]);
	const reviewerId = id(value.reviewer_id, `${path}.reviewer_id`);
	const assignment = reviewers.find(reviewer => reviewer.reviewer_id === reviewerId);
	if (assignment === undefined) fail(`${path}.reviewer_id`, "reviewer is not assigned to this panel");
	if (
		value.assignment_role !== assignment.assignment_role ||
		value.selector !== assignment.selector ||
		value.model !== assignment.model ||
		value.provider !== assignment.provider
	)
		fail(path, "result must bind its reviewer assignment");
	const reviewSubjectSha256 = hash(value.review_subject_sha256, `${path}.review_subject_sha256`);
	if (reviewSubjectSha256 !== subject.subject_sha256) fail(`${path}.review_subject_sha256`, "stale review subject");
	const resultSha256 = hash(value.result_sha256, `${path}.result_sha256`);
	if (value.result_path !== ideationReviewResultPath(slugValue, resultSha256))
		fail(`${path}.result_path`, "must be the immutable review result path");
	if (!Array.isArray(value.findings)) fail(`${path}.findings`, "must be an array");
	const findings = value.findings.map((entry, index) =>
		validateFinalReviewFinding(
			entry,
			`${path}.findings[${index}]`,
			evidenceIds,
			criterionIds,
			semanticIds,
			occurrenceIds,
			priorRoundOccurrenceIds,
		),
	);
	for (let index = 1; index < findings.length; index += 1)
		if (findings[index - 1]!.occurrence_id >= findings[index]!.occurrence_id)
			fail(`${path}.findings`, "occurrence IDs must be sorted and unique");
	return Object.freeze({
		reviewer_id: reviewerId,
		assignment_role: assignment.assignment_role,
		selector: assignment.selector,
		model: assignment.model,
		provider: assignment.provider,
		review_subject_sha256: reviewSubjectSha256,
		result_path: value.result_path,
		result_sha256: resultSha256,
		completed_at: timestamp(value.completed_at, `${path}.completed_at`),
		verdict: oneOf(value.verdict, ["PASS", "BLOCK", "UNRESOLVED"] as const, `${path}.verdict`),
		assessed_criteria_ids: references(
			value.assessed_criteria_ids,
			`${path}.assessed_criteria_ids`,
			criterionIds,
			"criterion",
		),
		assessed_invariant_ids: references(
			value.assessed_invariant_ids,
			`${path}.assessed_invariant_ids`,
			new Set(invariants),
			"invariant",
		),
		findings: Object.freeze(findings),
		dissent: textList(value.dissent, `${path}.dissent`),
		limitations: textList(value.limitations, `${path}.limitations`),
	});
}

function validateFinalReviewFinding(
	input: unknown,
	path: string,
	evidenceIds: ReadonlySet<string>,
	criterionIds: ReadonlySet<string>,
	semanticIds: ReadonlySet<string>,
	occurrenceIds: Set<string>,
	priorRoundOccurrenceIds: ReadonlySet<string>,
): FinalDocumentReviewFinding {
	const value = closedObject(input, path, [
		"stable_id",
		"occurrence_id",
		"severity",
		"affected_criteria_ids",
		"affected_semantic_ids",
		"evidence_ids",
		"failure_mechanism",
		"recommendation",
		"disposition",
		"duplicate_of",
		"recurrence_of",
		"regression_of",
		"caused_by",
		"supersedes",
	]);
	const occurrenceId = id(value.occurrence_id, `${path}.occurrence_id`);
	if (occurrenceIds.has(occurrenceId)) fail(`${path}.occurrence_id`, "must be globally unique");
	const lineage = (field: "duplicate_of" | "recurrence_of" | "regression_of" | "caused_by" | "supersedes") => {
		const reference = value[field] === null ? null : id(value[field], `${path}.${field}`);
		if (reference !== null && !priorRoundOccurrenceIds.has(reference))
			fail(`${path}.${field}`, "must derive from an immutable predecessor-round occurrence");
		return reference;
	};
	const result = Object.freeze({
		stable_id: id(value.stable_id, `${path}.stable_id`),
		occurrence_id: occurrenceId,
		severity: oneOf(value.severity, ["blocking", "advisory"] as const, `${path}.severity`),
		affected_criteria_ids: references(
			value.affected_criteria_ids,
			`${path}.affected_criteria_ids`,
			criterionIds,
			"criterion",
		),
		affected_semantic_ids: references(
			value.affected_semantic_ids,
			`${path}.affected_semantic_ids`,
			semanticIds,
			"semantic",
		),
		evidence_ids: evidenceReferences(value.evidence_ids, `${path}.evidence_ids`, evidenceIds),
		failure_mechanism: nonEmpty(value.failure_mechanism, `${path}.failure_mechanism`),
		recommendation: nonEmpty(value.recommendation, `${path}.recommendation`),
		disposition: oneOf(
			value.disposition,
			["open", "accepted-for-correction", "accepted", "mitigated", "deferred", "rejected"] as const,
			`${path}.disposition`,
		),
		duplicate_of: lineage("duplicate_of"),
		recurrence_of: lineage("recurrence_of"),
		regression_of: lineage("regression_of"),
		caused_by: lineage("caused_by"),
		supersedes: lineage("supersedes"),
	});
	occurrenceIds.add(occurrenceId);
	return result;
}

function assertPendingFindingsCarried(
	predecessor: FinalDocumentReviewRound,
	successor: FinalDocumentReviewRound,
	path: string,
): void {
	const pending = predecessor.results
		.flatMap(result => result.findings)
		.filter(
			finding =>
				finding.severity === "blocking" ||
				finding.disposition === "open" ||
				finding.disposition === "accepted-for-correction" ||
				finding.disposition === "deferred",
		);
	for (const finding of pending) {
		const carried = successor.results
			.flatMap(result => result.findings)
			.find(
				candidate =>
					candidate.stable_id === finding.stable_id &&
					[
						candidate.duplicate_of,
						candidate.recurrence_of,
						candidate.regression_of,
						candidate.caused_by,
						candidate.supersedes,
					].includes(finding.occurrence_id),
			);
		if (carried === undefined) fail(path, `must carry or explicitly resolve pending finding ${finding.stable_id}`);
	}
}

function hashFinalReviewEpisode(
	episode: FinalDocumentReviewEpisode,
	rounds: readonly FinalDocumentReviewRound[],
): string {
	return hashCanonicalJson({ schema: "ideation-with-critique/final-document-review-episode/v2", ...episode, rounds });
}

export function finalDocumentReviewEpisodeSha256(review: FinalDocumentReview, episodeNumber: number): string {
	const episode = review.episodes[episodeNumber - 1];
	if (episode === undefined || episode.episode !== episodeNumber)
		fail("$.final_document_review.episodes", "unknown review episode");
	const nextFirstRound = review.episodes[episodeNumber]?.first_round ?? review.rounds.length + 1;
	return hashFinalReviewEpisode(episode, review.rounds.slice(episode.first_round - 1, nextFirstRound - 1));
}

function deriveFinalReviewRoundGate(
	round: FinalDocumentReviewRound,
	mandatoryCriterionIds: ReadonlySet<string>,
	maxReviewRounds: 1 | 2 | 3 | 4 | 5,
	episodeRound: number,
): FinalDocumentReviewGate {
	const resultByReviewer = new Map(round.results.map(result => [result.reviewer_id, result]));
	const missingReviewerIds = round.reviewers
		.filter(reviewer => !resultByReviewer.has(reviewer.reviewer_id))
		.map(reviewer => reviewer.reviewer_id);
	const results = round.results;
	const assessedCriteria = uniqueSorted(results.flatMap(result => result.assessed_criteria_ids));
	const assessedInvariants = uniqueSorted(results.flatMap(result => result.assessed_invariant_ids));
	const blockingOccurrenceIds = results
		.flatMap(result =>
			result.findings.filter(finding => finding.severity === "blocking").map(finding => finding.occurrence_id),
		)
		.sort();
	const hasUnresolvedFinding = results.some(result =>
		result.findings.some(
			finding =>
				finding.disposition === "open" ||
				finding.disposition === "accepted-for-correction" ||
				finding.disposition === "deferred",
		),
	);
	const dissent = uniqueSorted(results.flatMap(result => result.dissent));
	const limitations = uniqueSorted(results.flatMap(result => result.limitations));
	const missingCoverage =
		![...mandatoryCriterionIds].every(criterionId => assessedCriteria.includes(criterionId)) ||
		!round.mandatory_invariant_ids.every(invariantId => assessedInvariants.includes(invariantId));
	const outcome: FinalReviewGateOutcome =
		missingReviewerIds.length > 0 || missingCoverage
			? "INCOMPLETE"
			: blockingOccurrenceIds.length > 0 || results.some(result => result.verdict === "BLOCK")
				? "BLOCK"
				: results.some(result => result.verdict === "UNRESOLVED") || hasUnresolvedFinding
					? "UNRESOLVED"
					: "PASS";
	return Object.freeze({
		outcome,
		assessed_criteria_ids: Object.freeze(assessedCriteria),
		assessed_invariant_ids: Object.freeze(assessedInvariants),
		blocking_occurrence_ids: Object.freeze(blockingOccurrenceIds),
		missing_reviewer_ids: Object.freeze(missingReviewerIds),
		dissent: Object.freeze(dissent),
		limitations: Object.freeze(limitations),
		cap_exhausted: episodeRound === maxReviewRounds && outcome !== "PASS",
	});
}

/** Returns the only review gate used by readiness and candidate creation. */
export function deriveFinalDocumentReviewGate(
	review: FinalDocumentReview,
	mandatoryCriterionIds: ReadonlySet<string>,
	maxReviewRounds: 1 | 2 | 3 | 4 | 5,
): FinalDocumentReviewGate {
	if (review.current_round === null || review.current_episode === null)
		return Object.freeze({
			outcome: "INCOMPLETE",
			assessed_criteria_ids: Object.freeze([]),
			assessed_invariant_ids: Object.freeze([]),
			blocking_occurrence_ids: Object.freeze([]),
			missing_reviewer_ids: Object.freeze([]),
			dissent: Object.freeze([]),
			limitations: Object.freeze([]),
			cap_exhausted: false,
		});
	const round = review.rounds[review.current_round - 1]!;
	const episode = review.episodes[review.current_episode - 1]!;
	return deriveFinalReviewRoundGate(
		round,
		mandatoryCriterionIds,
		maxReviewRounds,
		round.round - episode.first_round + 1,
	);
}
export function ideationReviewResultPath(slugValue: string, resultSha256: string): string {
	return `ai_docs/ideation/.${slug(slugValue, "review result slug")}.substantive-review-${hash(resultSha256, "review result hash")}.json`;
}

export function finalDocumentReviewResultEvidence(
	result: FinalDocumentReviewResult,
): Omit<FinalDocumentReviewResult, "result_path" | "result_sha256"> {
	const { result_path: _path, result_sha256: _sha256, ...evidence } = result;
	return Object.freeze(evidence);
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function validateReadiness(input: unknown): Readiness {
	const value = closedObject(input, "$.readiness", ["status", "blockers", "bounded_ambiguities"]);
	return Object.freeze({
		status: oneOf(value.status, ["draft", "ready-for-approval"] as const, "$.readiness.status"),
		blockers: textList(value.blockers, "$.readiness.blockers"),
		bounded_ambiguities: sortedUnique(
			value.bounded_ambiguities,
			"$.readiness.bounded_ambiguities",
			validateAmbiguity,
		),
	});
}

function validateAmbiguity(input: unknown, path: string): BoundedAmbiguity {
	const value = closedObject(input, path, ["id", "unknown", "affected_fields", "resolution_needed"]);
	return Object.freeze({ id: prefixedId(value.id, "U", `${path}.id`), unknown: nonEmpty(value.unknown, `${path}.unknown`), affected_fields: textList(value.affected_fields, `${path}.affected_fields`), resolution_needed: nonEmpty(value.resolution_needed, `${path}.resolution_needed`) });
}
function validateInterviewExchanges(input: unknown, evidenceIds: ReadonlySet<string>): readonly IdeationInterviewExchange[] {
	if (!Array.isArray(input) || input.length > 10_000) fail("$.interview_exchanges", "must be an array");
	const result: IdeationInterviewExchange[] = [];
	const superseded = new Set<string>();
	for (let index = 0; index < input.length; index += 1) {
		const path = `$.interview_exchanges[${index}]`;
		const value = closedObject(input[index], path, ["id", "exact_question", "accepted_answer", "supersedes_exchange_id", "affected_targets", "evidence_ids"]);
		const exchangeIdValue = `Q${index + 1}` as `Q${number}`;
		if (value.id !== exchangeIdValue) fail(`${path}.id`, "IDs must equal array position");
		const exactQuestion = boundedNonEmpty(value.exact_question, `${path}.exact_question`, IDEATION_EXCHANGE_QUESTION_MAX_UTF8_BYTES);
		const acceptedAnswer = boundedNonEmpty(value.accepted_answer, `${path}.accepted_answer`, IDEATION_EXCHANGE_ANSWER_MAX_UTF8_BYTES);
		assertIdeationExchangeContentSafe({ exact_question: exactQuestion, accepted_answer: acceptedAnswer });
		if (!Array.isArray(value.affected_targets) || value.affected_targets.length === 0 || value.affected_targets.length > IDEATION_EXCHANGE_TARGET_MAX_COUNT) fail(`${path}.affected_targets`, "must contain one to 128 targets");
		const targets = value.affected_targets.map((entry, targetIndex) => {
			const targetPath = `${path}.affected_targets[${targetIndex}]`;
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(targetPath, "target must be an object");
			const target = entry as Record<string, unknown>;
			if (target.target_type === "semantic-id") { if (Object.keys(target).length !== 2) fail(targetPath, "semantic target shape is invalid"); return Object.freeze({ target_type: "semantic-id" as const, semantic_id: id(target.semantic_id, `${targetPath}.semantic_id`) }); }
			if (target.target_type === "state-field") { if (Object.keys(target).length !== 2) fail(targetPath, "state-field target shape is invalid"); return Object.freeze({ target_type: "state-field" as const, field: oneOf(target.field, ["title", "commitment-level", "goal", "criteria", "scope-in", "scope-non-goal", "scope-deferred", "decisions", "assumptions", "evidence", "visuals", "review-item-presentations", "commitment-critique", "readiness"] as const, `${targetPath}.field`) }); }
			fail(`${targetPath}.target_type`, "invalid exchange target type");
		});
		const targetKeys = targets.map(target => canonicalTargetIdentity(target));
		if (new Set(targetKeys).size !== targetKeys.length || targetKeys.some((key, targetIndex) => targetIndex > 0 && targetKeys[targetIndex - 1]! >= key)) fail(`${path}.affected_targets`, "targets must be sorted and unique");
		const evidence = textList(value.evidence_ids, `${path}.evidence_ids`);
		if (evidence.length > IDEATION_EXCHANGE_EVIDENCE_MAX_COUNT) fail(`${path}.evidence_ids`, "too many evidence IDs");
		for (const evidenceId of evidence) if (!evidenceIds.has(evidenceId)) fail(`${path}.evidence_ids`, `unknown evidence ID: ${evidenceId}`);
		const predecessor = value.supersedes_exchange_id === null ? null : exchangeId(value.supersedes_exchange_id, `${path}.supersedes_exchange_id`);
		if (predecessor !== null) { const predecessorIndex = Number(predecessor.slice(1)); if (predecessorIndex >= index + 1 || superseded.has(predecessor)) fail(`${path}.supersedes_exchange_id`, "must reference one earlier active exchange"); superseded.add(predecessor); }
		result.push(Object.freeze({ id: exchangeIdValue, exact_question: exactQuestion, accepted_answer: acceptedAnswer, supersedes_exchange_id: predecessor, affected_targets: Object.freeze(targets), evidence_ids: evidence }));
	}
	return Object.freeze(result);
}
function validateReviewItemPresentations(input: unknown, evidenceIds: ReadonlySet<string>, semanticIds: ReadonlySet<string>, goal: IdeationGoal, criteria: readonly EvaluationCriterion[], decisions: readonly Decision[], assumptions: readonly Assumption[], readiness: Readiness): readonly IdeationReviewItemPresentation[] {
	if (!Array.isArray(input)) fail("$.review_item_presentations", "must be an array");
	const required = new Set([goal.id, ...criteria.map(item => item.id), ...decisions.filter(item => item.status === "active").map(item => item.id), ...assumptions.map(item => item.id), ...readiness.bounded_ambiguities.map(item => item.id)]);
	const result = input.map((entry, index) => validateReviewItemPresentation(entry, `$.review_item_presentations[${index}]`, evidenceIds, semanticIds));
	for (let index = 1; index < result.length; index += 1) if (result[index - 1]!.semantic_id >= result[index]!.semantic_id) fail("$.review_item_presentations", "presentations must be sorted and unique");
	if (new Set(result.map(item => item.semantic_id)).size !== result.length || result.length !== required.size || result.some(item => !required.has(item.semantic_id))) fail("$.review_item_presentations", "presentations must exactly cover governed targets");
	return Object.freeze(result);
}

function validateReviewItemPresentation(input: unknown, path: string, evidenceIds: ReadonlySet<string>, semanticIds: ReadonlySet<string>): IdeationReviewItemPresentation {
	const value = closedObject(input, path, ["semantic_id", "purpose", "why_it_matters", "system_position", "dependency_semantic_ids", "key_points", "research_summary", "options", "recommended_option_id", "recommendation_rationale", "uncertainty"]);
	const semanticId = id(value.semantic_id, `${path}.semantic_id`);
	const dependencies = textList(value.dependency_semantic_ids, `${path}.dependency_semantic_ids`);
	for (const dependency of dependencies) if (!semanticIds.has(dependency)) fail(`${path}.dependency_semantic_ids`, `unknown semantic ID: ${dependency}`);
	const keyPoints = nonEmptyTuple(value.key_points, `${path}.key_points`, 3);
	const research = nonEmptyTuple(value.research_summary, `${path}.research_summary`, 16);
	if (!Array.isArray(value.options) || value.options.length !== 4) fail(`${path}.options`, "exactly four options are required");
	const options = value.options.map((entry, index) => validateReviewOption(entry, `${path}.options[${index}]`, evidenceIds));
	const optionIds = options.map(option => option.option_id);
	if (new Set(optionIds).size !== 4 || !optionIds.includes(String(value.recommended_option_id))) fail(`${path}.recommended_option_id`, "recommendation must bind one distinct option");
	const prose = [value.purpose, value.why_it_matters, value.system_position, ...keyPoints, ...research, ...options.flatMap(option => [option.label, option.mechanism_or_output, option.benefit, option.omission_cost_or_uncertainty, option.downstream_consequence]), value.recommendation_rationale, value.uncertainty].map((entry, index) => normalizedText(entry, `${path}.prose[${index}]`));
	if (new Set(prose).size !== prose.length) fail(path, "presentation prose must not contain normalized duplicates");
	return Object.freeze({ semantic_id: semanticId, purpose: boundedNonEmpty(value.purpose, `${path}.purpose`, 4096), why_it_matters: boundedNonEmpty(value.why_it_matters, `${path}.why_it_matters`, 4096), system_position: boundedNonEmpty(value.system_position, `${path}.system_position`, 4096), dependency_semantic_ids: dependencies, key_points: keyPoints as [string, ...string[]], research_summary: research as [string, ...string[]], options: options as [IdeationReviewOption, IdeationReviewOption, IdeationReviewOption, IdeationReviewOption], recommended_option_id: String(value.recommended_option_id), recommendation_rationale: boundedNonEmpty(value.recommendation_rationale, `${path}.recommendation_rationale`, 4096), uncertainty: boundedNonEmpty(value.uncertainty, `${path}.uncertainty`, 4096) });
}

function validateReviewOption(input: unknown, path: string, evidenceIds: ReadonlySet<string>): IdeationReviewOption {
	const value = closedObject(input, path, ["option_id", "label", "mechanism_or_output", "benefit", "omission_cost_or_uncertainty", "downstream_consequence", "evidence_ids"]);
	const evidence = textList(value.evidence_ids, `${path}.evidence_ids`);
	for (const evidenceId of evidence) if (!evidenceIds.has(evidenceId)) fail(`${path}.evidence_ids`, `unknown evidence ID: ${evidenceId}`);
	return Object.freeze({ option_id: id(value.option_id, `${path}.option_id`), label: boundedNonEmpty(value.label, `${path}.label`, 2048), mechanism_or_output: boundedNonEmpty(value.mechanism_or_output, `${path}.mechanism_or_output`, 4096), benefit: boundedNonEmpty(value.benefit, `${path}.benefit`, 4096), omission_cost_or_uncertainty: boundedNonEmpty(value.omission_cost_or_uncertainty, `${path}.omission_cost_or_uncertainty`, 4096), downstream_consequence: boundedNonEmpty(value.downstream_consequence, `${path}.downstream_consequence`, 4096), evidence_ids: evidence });
}

export function deriveChangedExchangeTargets(predecessor: IdeationState, successor: IdeationState): readonly IdeationExchangeTarget[] {
	const targets: IdeationExchangeTarget[] = [];
	const compare = (field: IdeationExchangeTarget["field"], left: unknown, right: unknown) => {
		if (canonicalJson(left) !== canonicalJson(right)) targets.push({ target_type: "state-field", field });
	};
	const compareSemanticEntries = (
		left: readonly { readonly id: string }[],
		right: readonly { readonly id: string }[],
	) => {
		const leftById = new Map(left.map(entry => [entry.id, entry]));
		const rightById = new Map(right.map(entry => [entry.id, entry]));
		for (const semanticId of new Set([...leftById.keys(), ...rightById.keys()])) {
			if (canonicalJson(leftById.get(semanticId) ?? null) !== canonicalJson(rightById.get(semanticId) ?? null)) {
				targets.push({ target_type: "semantic-id", semantic_id: semanticId });
			}
		}
	};
	compare("title", predecessor.title, successor.title);
	compare("commitment-level", predecessor.commitment_level, successor.commitment_level);
	compare("goal", predecessor.goal, successor.goal);
	compareSemanticEntries([predecessor.goal], [successor.goal]);
	compare("criteria", predecessor.criteria, successor.criteria);
	compareSemanticEntries(predecessor.criteria, successor.criteria);
	compare("scope-in", predecessor.scope.in_scope, successor.scope.in_scope);
	compare("scope-non-goal", predecessor.scope.non_goals, successor.scope.non_goals);
	compare("scope-deferred", predecessor.scope.deferred, successor.scope.deferred);
	compare("decisions", predecessor.decisions, successor.decisions);
	compareSemanticEntries(predecessor.decisions, successor.decisions);
	compare("assumptions", predecessor.assumptions, successor.assumptions);
	compareSemanticEntries(predecessor.assumptions, successor.assumptions);
	compare("evidence", predecessor.evidence, successor.evidence);
	compareSemanticEntries(predecessor.evidence, successor.evidence);
	compare("visuals", predecessor.visuals, successor.visuals);
	compareSemanticEntries(predecessor.visuals, successor.visuals);
	compare("review-item-presentations", predecessor.review_item_presentations, successor.review_item_presentations);
	compareSemanticEntries(predecessor.review_item_presentations.map(entry => ({ ...entry, id: entry.semantic_id })), successor.review_item_presentations.map(entry => ({ ...entry, id: entry.semantic_id })));
	compare("commitment-critique", predecessor.commitment_critique, successor.commitment_critique);
	compare("readiness", predecessor.readiness, successor.readiness);
	const uniqueTargets = [
		...new Map(
			targets.map(target => [canonicalTargetIdentity(target), target]),
		).values(),
	];
	return Object.freeze(
		uniqueTargets.sort((left, right) =>
			compareUnsignedUtf8(canonicalTargetIdentity(left), canonicalTargetIdentity(right)),
		),
	);
}

export function deriveIdeationExchangeHistory(exchanges: readonly IdeationInterviewExchange[]): readonly DerivedIdeationExchange[] {
	const successors = new Map<string, string>();
	for (const exchange of exchanges) if (exchange.supersedes_exchange_id !== null) successors.set(exchange.supersedes_exchange_id, exchange.id);
	return Object.freeze(exchanges.map(exchange => Object.freeze({ ...exchange, active: !successors.has(exchange.id), predecessor_exchange_id: exchange.supersedes_exchange_id, successor_exchange_id: (successors.get(exchange.id) as `Q${number}` | undefined) ?? null })));
}

function canonicalTargetIdentity(target: IdeationExchangeTarget): string { return canonicalJson(target); }
function compareUnsignedUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function exchangeId(value: unknown, path: string): `Q${number}` { if (typeof value !== "string" || !/^Q[1-9][0-9]*$/.test(value)) fail(path, "invalid exchange ID"); return value as `Q${number}`; }
function normalizedText(value: unknown, path: string): string { return boundedNonEmpty(value, path, 4096).trim().replace(/\s+/g, " ").normalize("NFKC").toLocaleLowerCase(); }
function nonEmptyTuple(value: unknown, path: string, maximum: number): readonly [string, ...string[]] { if (!Array.isArray(value) || value.length < 1 || value.length > maximum) fail(path, "must be a bounded non-empty list"); return value.map((entry, index) => boundedNonEmpty(entry, `${path}[${index}]`, 4096)) as [string, ...string[]]; }
function validateVisual(
	input: unknown,
	path: string,
	evidenceIds: ReadonlySet<string>,
	semanticIds: ReadonlySet<string>,
): VisualSemantic {
	const value = closedObject(input, path, [
		"id",
		"type",
		"title",
		"description",
		"units",
		"source_evidence_ids",
		"semantic_ids",
		"textual_equivalent",
		"data",
	]);
	const type = oneOf(value.type, ["flow", "bar", "matrix", "timeline", "comparison"] as const, `${path}.type`);
	const base = {
		id: prefixedId(value.id, "V", `${path}.id`),
		title: boundedNonEmpty(value.title, `${path}.title`, 4_096),
		description: boundedNonEmpty(value.description, `${path}.description`, 4_096),
		units: boundedNonEmpty(value.units, `${path}.units`, 256),
		source_evidence_ids: evidenceReferences(value.source_evidence_ids, `${path}.source_evidence_ids`, evidenceIds),
		semantic_ids: semanticReferences(value.semantic_ids, `${path}.semantic_ids`, semanticIds),
		textual_equivalent: boundedNonEmpty(value.textual_equivalent, `${path}.textual_equivalent`, 4_096),
	};
	const data = value.data;
	if (type === "flow") {
		const record = closedObject(data, `${path}.data`, ["nodes", "edges"]);
		const nodes = visualList(record.nodes, `${path}.data.nodes`).map((entry, index) => {
			const node = closedObject(entry, `${path}.data.nodes[${index}]`, ["node_id", "label", "description"]);
			return Object.freeze({
				node_id: id(node.node_id, `${path}.data.nodes[${index}].node_id`),
				label: boundedNonEmpty(node.label, `${path}.data.nodes[${index}].label`, 256),
				description: boundedNonEmpty(node.description, `${path}.data.nodes[${index}].description`, 256),
			});
		});
		const nodeIds = new Set(nodes.map(node => node.node_id));
		if (nodeIds.size !== nodes.length) fail(`${path}.data.nodes`, "node IDs must be unique");
		const edges = visualList(record.edges, `${path}.data.edges`).map((entry, index) => {
			const edge = closedObject(entry, `${path}.data.edges[${index}]`, ["from", "to", "label"]);
			const from = id(edge.from, `${path}.data.edges[${index}].from`);
			const to = id(edge.to, `${path}.data.edges[${index}].to`);
			if (!nodeIds.has(from) || !nodeIds.has(to)) fail(`${path}.data.edges[${index}]`, "edge references unknown node");
			return Object.freeze({
				from,
				to,
				label: boundedNonEmpty(edge.label, `${path}.data.edges[${index}].label`, 256),
			});
		});
		return Object.freeze({ ...base, type, data: Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) }) });
	}
	if (type === "bar") {
		const record = closedObject(data, `${path}.data`, ["entries"]);
		const entries = visualList(record.entries, `${path}.data.entries`).map((entry, index) => {
			const item = closedObject(entry, `${path}.data.entries[${index}]`, ["label", "value"]);
			return Object.freeze({
				label: boundedNonEmpty(item.label, `${path}.data.entries[${index}].label`, 256),
				value: finiteNumber(item.value, `${path}.data.entries[${index}].value`),
			});
		});
		return Object.freeze({ ...base, type, data: Object.freeze({ entries: Object.freeze(entries) }) });
	}
	if (type === "matrix") {
		const record = closedObject(data, `${path}.data`, ["x_axis", "y_axis", "points"]);
		const points = visualList(record.points, `${path}.data.points`).map((entry, index) => {
			const point = closedObject(entry, `${path}.data.points[${index}]`, ["label", "x", "y"]);
			return Object.freeze({
				label: boundedNonEmpty(point.label, `${path}.data.points[${index}].label`, 256),
				x: rangedNumber(point.x, `${path}.data.points[${index}].x`, 0, 100),
				y: rangedNumber(point.y, `${path}.data.points[${index}].y`, 0, 100),
			});
		});
		return Object.freeze({
			...base,
			type,
			data: Object.freeze({
				x_axis: boundedNonEmpty(record.x_axis, `${path}.data.x_axis`, 256),
				y_axis: boundedNonEmpty(record.y_axis, `${path}.data.y_axis`, 256),
				points: Object.freeze(points),
			}),
		});
	}
	if (type === "timeline") {
		const record = closedObject(data, `${path}.data`, ["entries"]);
		const entries = visualList(record.entries, `${path}.data.entries`).map((entry, index) => {
			const item = closedObject(entry, `${path}.data.entries[${index}]`, ["label", "start", "end"]);
			const start = finiteNumber(item.start, `${path}.data.entries[${index}].start`);
			const end = finiteNumber(item.end, `${path}.data.entries[${index}].end`);
			if (end < start) fail(`${path}.data.entries[${index}].end`, "must not precede start");
			return Object.freeze({ label: boundedNonEmpty(item.label, `${path}.data.entries[${index}].label`, 256), start, end });
		});
		return Object.freeze({ ...base, type, data: Object.freeze({ entries: Object.freeze(entries) }) });
	}
	const record = closedObject(data, `${path}.data`, ["entries"]);
	const entries = visualList(record.entries, `${path}.data.entries`).map((entry, index) => {
		const item = closedObject(entry, `${path}.data.entries[${index}]`, ["label", "left", "right"]);
		return Object.freeze({
			label: boundedNonEmpty(item.label, `${path}.data.entries[${index}].label`, 256),
			left: finiteNumber(item.left, `${path}.data.entries[${index}].left`),
			right: finiteNumber(item.right, `${path}.data.entries[${index}].right`),
		});
	});
	return Object.freeze({ ...base, type, data: Object.freeze({ entries: Object.freeze(entries) }) });
}

function visualList(input: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(input) || input.length > 128) fail(path, "must be an array of at most 128 items");
	return input;
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000)
		fail(path, "must be a finite number with bounded magnitude");
	return value;
}

function rangedNumber(value: unknown, path: string, minimum: number, maximum: number): number {
	const result = finiteNumber(value, path);
	if (result < minimum || result > maximum) fail(path, `must be between ${minimum} and ${maximum}`);
	return result;
}

function closedObject(input: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) fail(path, "must be an object");
	const value = input as Record<string, unknown>;
	for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, "unknown field");
	for (const key of keys) if (!(key in value)) fail(`${path}.${key}`, "missing field");
	return value;
}

function sortedUnique<T extends { readonly id: string }>(
	input: unknown,
	path: string,
	parser: (entry: unknown, path: string) => T,
): readonly T[] {
	if (!Array.isArray(input)) fail(path, "must be an array");
	const result = input.map((entry, index) => parser(entry, `${path}[${index}]`));
	for (let index = 1; index < result.length; index += 1)
		if (result[index - 1]!.id >= result[index]!.id) fail(path, "IDs must be sorted and unique");
	return Object.freeze(result);
}

function evidenceReferences(input: unknown, path: string, evidenceIds: ReadonlySet<string>): readonly string[] {
	const values = textList(input, path);
	for (const value of values) if (!evidenceIds.has(value)) fail(path, `unknown evidence ID: ${value}`);
	return values;
}

function semanticReferences(input: unknown, path: string, semanticIds: ReadonlySet<string>): readonly string[] {
	const values = textList(input, path);
	for (const value of values) if (!semanticIds.has(value)) fail(path, `unknown semantic ID: ${value}`);
	return values;
}

function textList(input: unknown, path: string): readonly string[] {
	if (!Array.isArray(input)) fail(path, "must be an array");
	const values = input.map((entry, index) => nonEmpty(entry, `${path}[${index}]`));
	for (let index = 1; index < values.length; index += 1)
		if (values[index - 1]! >= values[index]!) fail(path, "values must be sorted and unique");
	return Object.freeze(values);
}

function reviewRoundCount(value: unknown, path: string): 1 | 2 | 3 | 4 | 5 {
	if (value !== 1 && value !== 2 && value !== 3 && value !== 4 && value !== 5)
		fail(path, "must be an integer from 1 through 5");
	return value;
}
function hash(value: unknown, path: string): string {
	const result = nonEmpty(value, path);
	if (!HASH.test(result)) fail(path, "invalid SHA-256");
	return result;
}
function references(input: unknown, path: string, known: ReadonlySet<string>, label: string): readonly string[] {
	const values = textList(input, path);
	for (const value of values) if (!known.has(value)) fail(path, `unknown ${label} ID: ${value}`);
	return values;
}
function id(value: unknown, path: string): string {
	const text = nonEmpty(value, path);
	if (!ID.test(text)) fail(path, "invalid stable ID");
	return text;
}
function prefixedId(value: unknown, prefix: string, path: string): string {
	const result = id(value, path);
	if (!new RegExp(`^${prefix}[1-9][0-9]*$`).test(result)) fail(path, `must use ${prefix}N`);
	return result;
}
function slug(value: unknown, path: string): string {
	const result = nonEmpty(value, path);
	if (!SLUG.test(result)) fail(path, "invalid slug");
	return result;
}
function runId(value: unknown, path: string): string {
	const result = nonEmpty(value, path);
	if (!RUN_ID.test(result)) fail(path, "invalid run ID");
	return result;
}
function timestamp(value: unknown, path: string): string {
	const result = nonEmpty(value, path);
	if (!UTC_TIMESTAMP.test(result)) fail(path, "invalid UTC timestamp");
	return result;
}
function positiveInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(path, "must be a positive integer");
	return value;
}
function nullableHash(value: unknown, path: string): string | null {
	if (value === null) return null;
	const result = nonEmpty(value, path);
	if (!HASH.test(result)) fail(path, "invalid SHA-256");
	return result;
}
function nullableText(value: unknown, path: string): string | null {
	return value === null ? null : nonEmpty(value, path);
}
function exact<T extends string>(value: unknown, expected: T, path: string): T {
	if (value !== expected) fail(path, `must equal ${expected}`);
	return expected;
}
function nonEmpty(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be non-empty text");
	return value;
}
function boundedNonEmpty(value: unknown, path: string, maximumLength: number): string {
	const result = nonEmpty(value, path);
	if (Buffer.byteLength(result, "utf8") > maximumLength) fail(path, `must contain at most ${maximumLength} UTF-8 bytes`);
	return result;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) fail(path, `must be one of ${choices.join(", ")}`);
	return value as T;
}
function fail(path: string, message: string): never {
	throw new TypeError(`${path}: ${message}`);
}
