import type {
	ApprovalDossierDecisionOption,
	ApprovalDossierReviewPresentation,
	VisualSet,
} from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import type { ApprovalDossierFeedbackTarget } from "../../approval-dossier-runtime/scripts/approval-dossier-renderer.ts";
import { VISUAL_SET_SCHEMA, visualSetSha256 } from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import { canonicalJson } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { nativeVisualSha256, type NativeVisual } from "../../approval-dossier-runtime/scripts/native-svg-projector.ts";
import type { IdeationReviewItemPresentation, IdeationState, VisualSemantic } from "../schemas/ideation-state.ts";
import { deriveFinalDocumentReviewGate, validateIdeationState } from "../schemas/ideation-state.ts";

export const IDEATION_PROJECTION_MANIFEST_SCHEMA = "ideation-with-critique/projection-manifest/v1" as const;
export interface IdeationProjectionManifest {
	readonly schema: typeof IDEATION_PROJECTION_MANIFEST_SCHEMA;
	readonly entries: readonly { readonly path: string; readonly sha256: string }[];
}

/** Pure state-to-review-context projection with no repository or clock dependency. */
export function feedbackTargets(input: IdeationState): readonly ApprovalDossierFeedbackTarget[] {
	const state = validateIdeationState(input);
	return Object.freeze(state.review_item_presentations.map((item) => Object.freeze({ target: Object.freeze({ target_type: "semantic-id" as const, semantic_id: item.semantic_id }), label: item.semantic_id, context: item.why_it_matters, unresolved: false })));
}

export function projectIdeationReviewPresentation(item: IdeationReviewItemPresentation): ApprovalDossierReviewPresentation {
	return Object.freeze({ kind: "four-option-decision" as const, purpose: item.purpose, why_it_matters: item.why_it_matters, system_position: item.system_position, dependency_target_ids: Object.freeze([...item.dependency_semantic_ids]), key_points: item.key_points, research_summary: item.research_summary, options: Object.freeze(item.options.map((option) => Object.freeze({ option_id: option.option_id, label: option.label, mechanism_or_output: option.mechanism_or_output, benefit: option.benefit, omission_cost_or_uncertainty: option.omission_cost_or_uncertainty, downstream_consequence: option.downstream_consequence, evidence_ids: Object.freeze([...option.evidence_ids]) }))) as [ApprovalDossierDecisionOption, ApprovalDossierDecisionOption, ApprovalDossierDecisionOption, ApprovalDossierDecisionOption], recommended_option_id: item.recommended_option_id, recommendation_rationale: item.recommendation_rationale, uncertainty: item.uncertainty });
}

export function projectIdeationReviewPresentations(input: IdeationState): readonly { readonly target_id: string; readonly presentation: ApprovalDossierReviewPresentation }[] {
	const state = validateIdeationState(input);
	return Object.freeze(state.review_item_presentations.map((item) => Object.freeze({ target_id: item.semantic_id, presentation: projectIdeationReviewPresentation(item) })));
}

/** Renders the exact downstream Markdown byte sequence from closed Ideation state. */
export function renderIdeationMarkdown(input: IdeationState): Uint8Array {
	const state = validateIdeationState(input);
	const lines: string[] = [
		`# ${state.title}`, "", `## Goal (${state.goal.id})`, state.goal.statement, "", "### Beneficiaries", ...bullets(state.goal.beneficiaries), "", "### Context", state.goal.context, "",
		"## Evaluation Criteria", "| Priority | ID | Criterion | Threshold | Verification Method | Evidence IDs |", "|---|---|---|---|---|---|", ...state.criteria.map((criterion) => `| ${criterion.priority} | ${criterion.id} | ${criterion.criterion} | ${criterion.threshold} | ${criterion.verification_method} | ${criterion.evidence_ids.join(", ")} |`), "",
		"## Scope", "", "### In Scope", ...bullets(state.scope.in_scope), "", "### Non-Goals", ...bullets(state.scope.non_goals), "", "### Deferred", ...bullets(state.scope.deferred), "",
		"## Decisions", "| ID | Decision | Type | Confidence | Status | Rationale | Evidence IDs |", "|---|---|---|---|---|---|---|", ...state.decisions.map((decision) => `| ${decision.id} | ${decision.statement} | ${decision.type} | ${decision.confidence} | ${decision.status} | ${decision.rationale} | ${decision.evidence_ids.join(", ")} |`), "",
		"## Assumptions", "| ID | Assumption | Load-Bearing | If Wrong | Tested | Evidence IDs |", "|---|---|---|---|---|---|", ...state.assumptions.map((assumption) => `| ${assumption.id} | ${assumption.statement} | ${assumption.load_bearing ? "Yes" : "No"} | ${assumption.if_wrong} | ${assumption.tested} | ${assumption.evidence_ids.join(", ")} |`), "",
		"## Evidence", "| ID | Source Locator | Description | SHA-256 |", "|---|---|---|---|", ...state.evidence.map((evidence) => `| ${evidence.id} | ${evidence.locator} | ${evidence.description} | ${evidence.sha256 ?? ""} |`),
		"## Commitment Critique", ...renderCommitmentCritique(state), "", "## Final Document Review", `Configured maximum substantive review rounds: ${state.max_review_rounds}`, ...renderFinalDocumentReview(state), "",
		"## Readiness", `Status: ${state.readiness.status}`, "", "### Blockers", ...bullets(state.readiness.blockers), "", "### Bounded Ambiguities", "| ID | Bounded Unknown | Affected Fields | Resolution Needed |", "|---|---|---|---|", ...state.readiness.bounded_ambiguities.map((ambiguity) => `| ${ambiguity.id} | ${ambiguity.unknown} | ${ambiguity.affected_fields.join(", ")} | ${ambiguity.resolution_needed} |`), "",
		"## Review Item Presentations", ...state.review_item_presentations.flatMap((item) => [
			`### ${item.semantic_id}`,
			`Purpose: ${item.purpose}`,
			`Why it matters: ${item.why_it_matters}`,
			`System position: ${item.system_position}`,
			`Dependencies: ${item.dependency_semantic_ids.join(", ") || "None"}`,
			"", "#### Key Points", ...bullets(item.key_points), "", "#### Research Summary", ...bullets(item.research_summary), "",
			"#### Options", "| Option | Label | Mechanism or Output | Benefit | Omission Cost or Uncertainty | Downstream Consequence | Evidence IDs |", "|---|---|---|---|---|---|---|",
			...item.options.map((option) => `| ${option.option_id} | ${option.label} | ${option.mechanism_or_output} | ${option.benefit} | ${option.omission_cost_or_uncertainty} | ${option.downstream_consequence} | ${option.evidence_ids.join(", ")} |`),
			"", `Recommended option: ${item.recommended_option_id}`, `Recommendation rationale: ${item.recommendation_rationale}`, `Uncertainty: ${item.uncertainty}`, "",
		]),
		"## Visual Semantics", ...state.visuals.flatMap((visual) => [`### ${visual.id} — ${visual.title}`, visual.description, `Type: ${visual.type}`, `Units: ${visual.units}`, `Evidence IDs: ${visual.source_evidence_ids.join(", ") || "None"}`, `Semantic IDs: ${visual.semantic_ids.join(", ") || "None"}`, "", "#### Exact textual equivalent", "```text", visual.textual_equivalent, "```", "", "#### Bound visual data", "```json", canonicalJson(visual.data), "```", ""]), "",
	];
	return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

/** Projects the validated Ideation visual authority into the shared safe native-SVG vocabulary. */
export function createIdeationNativeVisuals(input: IdeationState): readonly NativeVisual[] {
	const state = validateIdeationState(input);
	return Object.freeze(state.visuals.map(nativeVisualFromSemantic));
}

/** Returns the hash-bound native visual set for one exact Ideation state. */
export function createIdeationVisualSet(input: IdeationState): VisualSet {
	const visuals = createIdeationNativeVisuals(input);
	const records = Object.freeze(visuals.map((visual) => Object.freeze({ visual_id: visual.visual_id, type: visual.type, sha256: visual.sha256 })));
	return Object.freeze({ schema: VISUAL_SET_SCHEMA, visuals: records, visual_set_sha256: visualSetSha256(records) });
}

function nativeVisualFromSemantic(visual: VisualSemantic): NativeVisual {
	const material = { visual_id: visual.id, title: visual.title, description: visual.description, units: visual.units, source_evidence_ids: visual.source_evidence_ids, textual_equivalent: visual.textual_equivalent, type: visual.type, data: visual.data };
	return Object.freeze({ ...material, sha256: nativeVisualSha256(material) }) as NativeVisual;
}

function renderCommitmentCritique(state: IdeationState): readonly string[] {
	if (state.commitment_critique === null) return ["No commitment critique has been triggered."];
	const lines = [`Trigger: ${state.commitment_critique.trigger}`, "", "| Critic | Finding | Severity | Disposition | Dissent |", "|---|---|---|---|---|"];
	for (const critic of state.commitment_critique.critics) for (const finding of critic.findings) lines.push(`| ${critic.critic_id} | ${finding.issue} | ${finding.severity} | ${finding.disposition}: ${finding.disposition_rationale} | ${finding.dissent ?? ""} |`);
	return lines;
}

function renderFinalDocumentReview(state: IdeationState): readonly string[] {
	const review = state.final_document_review;
	const gate = deriveFinalDocumentReviewGate(review, new Set(state.criteria.filter((criterion) => criterion.priority === "P0").map((criterion) => criterion.id)), state.max_review_rounds);
	if (review.rounds.length === 0) return ["Status: INCOMPLETE (no substantive review round has been recorded)."];
	const lines: string[] = [`Current episode: ${review.current_episode ?? "none"}`, `Current round: ${review.current_round ?? "none"}`, `Current validator-derived gate: ${gate.outcome}${gate.cap_exhausted ? "; cap exhausted" : ""}`, "", "| Episode | Round | Subject | Results | Reviewers | Findings |", "|---:|---:|---|---:|---:|---|"];
	for (const round of review.rounds) {
		let episode = review.episodes[0]!;
		for (const candidate of review.episodes) { if (candidate.first_round > round.round) break; episode = candidate; }
		const findings = round.results.flatMap((result) => result.findings).length === 0 ? "None" : round.results.flatMap((result) => result.findings).map((finding) => `${finding.occurrence_id} (${finding.severity}, ${finding.disposition})`).join("; ");
		lines.push(`| ${episode.episode} | ${round.round} | ${round.subject.subject_id} (${round.subject.subject_sha256}) | ${round.results.length} | ${round.reviewers.map((reviewer) => `${reviewer.reviewer_id}: ${reviewer.assignment_role}, provider=${reviewer.provider}`).join("; ")} | ${findings} |`);
	}
	return lines;
}

function bullets(values: readonly string[]): readonly string[] { return values.length === 0 ? ["- None."] : values.map((value) => `- ${value}`); }
