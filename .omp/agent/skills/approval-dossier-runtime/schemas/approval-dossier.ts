import { canonicalJson, hashCanonicalJson, hashRawBytes } from "../scripts/canonical-json.ts";

export const SEMANTIC_BINDING_SCHEMA = "approval-dossier/semantic-binding/v1" as const;
export const MARKDOWN_FILE_SCHEMA = "approval-dossier/markdown-file/v1" as const;
export const BUNDLE_BINDING_SCHEMA = "approval-dossier/bundle-binding/v1" as const;
export const RUNTIME_BINDING_SCHEMA = "approval-dossier/runtime-binding/v1" as const;
export const VISUAL_SET_SCHEMA = "approval-dossier/visual-set/v1" as const;
export const CANDIDATE_SCHEMA = "approval-dossier/candidate/v1" as const;
export const APPROVAL_RESPONSE_SCHEMA = "approval-dossier/approval-response/v1" as const;
export const PUBLICATION_RECEIPT_SCHEMA = "approval-dossier/publication-receipt/v1" as const;
export const SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA = "approval-dossier/substantive-review-authority/v1" as const;
export const AUTHORITY_FILE_BINDING_SCHEMA = "approval-dossier/authority-file-binding/v1" as const;

export const APPROVAL_DECLARATION = "I approve this exact saved HTML dossier and its embedded Markdown files." as const;
export const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8" as const;

/** Closed contract records may carry up to 1,024 bounded file descriptors. */
export const CONTRACT_CANONICAL_JSON_LIMITS = Object.freeze({ maximum_bytes: 4 * 1_024 * 1_024 });

/** Feedback remains bounded so saved response HTML has a predictable authority size. */
export const APPROVAL_FEEDBACK_LIMITS = Object.freeze({
	maximum_items: 128,
	maximum_text_bytes: 4_096,
	maximum_evidence_ids: 128,
});

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKFLOW = /^[a-z][a-z0-9-]{0,63}$/;
const RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const BASELINE_SUBSTANTIVE_REVIEW_ROLES = Object.freeze([
	"correctness",
	"security",
	"simplicity-maintainability",
	"alignment",
] as const);

export const REVIEW_ASSIGNMENT_LIMITS = Object.freeze({
	baseline_count: BASELINE_SUBSTANTIVE_REVIEW_ROLES.length,
	maximum_specialist_count: 2,
	maximum_trigger_evidence_bytes: 4_096,
});

export type ApprovalStatus = "draft" | "changes-requested" | "approved" | "rejected";
export type BaselineSubstantiveReviewRole = (typeof BASELINE_SUBSTANTIVE_REVIEW_ROLES)[number];
export type SubstantiveReviewResultVerdict = "PASS" | "BLOCK" | "UNRESOLVED";
export type SubstantiveReviewGate = "INCOMPLETE" | "BLOCK" | "UNRESOLVED" | "PASS";
export type ReviewOccurrenceResolution = "resolved" | "unresolved";
export type PublicationOutcome = "created" | "adopted-identical";
export type VisualType = "flow" | "bar" | "matrix" | "timeline" | "comparison";

export interface SemanticBinding {
	readonly schema: typeof SEMANTIC_BINDING_SCHEMA;
	readonly workflow: string;
	readonly run_id: string;
	readonly revision: number;
	readonly semantic_sha256: string;
	readonly predecessor_sha256: string | null;
}

export interface MarkdownFileRecord {
	readonly schema: typeof MARKDOWN_FILE_SCHEMA;
	readonly path: string;
	readonly sha256: string;
	readonly byte_count: number;
	readonly media_type: typeof MARKDOWN_MEDIA_TYPE;
}

export interface BundleBinding {
	readonly schema: typeof BUNDLE_BINDING_SCHEMA;
	readonly files: readonly MarkdownFileRecord[];
	readonly bundle_sha256: string;
}

export interface RuntimeBinding {
	readonly schema: typeof RUNTIME_BINDING_SCHEMA;
	readonly runtime_sha256: string;
	readonly canonical_json_schema: string;
	readonly verifier_schema: string;
}

export interface VisualRecord {
	readonly visual_id: string;
	readonly type: VisualType;
	readonly sha256: string;
}

export interface VisualSet {
	readonly schema: typeof VISUAL_SET_SCHEMA;
	readonly visual_set_sha256: string;
	readonly visuals: readonly VisualRecord[];
}

export interface CandidateBinding {
	readonly schema: typeof CANDIDATE_SCHEMA;
	readonly workflow: string;
	readonly run_id: string;
	readonly revision: number;
	readonly semantic_sha256: string;
	readonly files: readonly MarkdownFileRecord[];
	readonly bundle_sha256: string;
	readonly visual_set_sha256: string;
	readonly runtime_sha256: string;
	readonly review_authority_sha256: string;
	readonly predecessors: readonly string[];
	readonly final_paths: readonly string[];
}

/** Evidence that justifies one non-baseline, domain-specific reviewer. */
export interface SpecialistTrigger {
	readonly trigger_id: string;
	readonly evidence: string;
}

/**
 * A model-agnostic substantive-review assignment. Every assignment is blind;
 * baseline roles cannot carry a specialist trigger, while specialists require
 * one closed, durable trigger record.
 */
export interface ReviewAssignment {
	readonly role: string;
	readonly blind: true;
	readonly specialist_trigger: SpecialistTrigger | null;
}
export interface SubstantiveReviewAssignment {
	readonly assignment_id: string;
	readonly role: string;
	readonly reviewer_id: string;
	readonly blind: true;
	readonly specialist_trigger: SpecialistTrigger | null;
	readonly required_coverage_ids: readonly string[];
}

export interface SubstantiveReviewResult {
	readonly result_id: string;
	readonly result_sha256: string;
	readonly assignment_id: string;
	readonly reviewer_id: string;
	readonly subject_sha256: string;
	readonly verdict: SubstantiveReviewResultVerdict;
	readonly covered_coverage_ids: readonly string[];
	readonly occurrence_ids: readonly string[];
	readonly completed_at: string;
}

export interface ReviewOccurrence {
	readonly occurrence_id: string;
	readonly finding_id: string;
	readonly assignment_id: string;
	readonly blocking: boolean;
	readonly resolution: ReviewOccurrenceResolution;
	readonly duplicate_of: string | null;
	readonly recurrence_of: string | null;
	readonly regression_of: string | null;
	readonly caused_by: string | null;
	readonly supersedes: string | null;
}

/**
 * Closed, model-free projection of the current substantive review panel. The
 * candidate subject hash covers every candidate field except the authority's
 * own hash, avoiding a circular self-reference while binding the exact
 * workflow/run/revision/semantic/bundle/runtime/visual/path candidate state.
 */
export interface SubstantiveReviewAuthority {
	readonly schema: typeof SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA;
	readonly workflow: string;
	readonly run_id: string;
	readonly revision: number;
	readonly subject_sha256: string;
	readonly candidate_subject_sha256: string;
	readonly semantic_sha256: string;
	readonly bundle_sha256: string;
	readonly mandatory_coverage_ids: readonly string[];
	readonly assignments: readonly SubstantiveReviewAssignment[];
	readonly results: readonly SubstantiveReviewResult[];
	readonly occurrences: readonly ReviewOccurrence[];
	readonly derived_gate: SubstantiveReviewGate;
}

export interface AuthorityFileBinding {
	readonly schema: typeof AUTHORITY_FILE_BINDING_SCHEMA;
	readonly path: string;
	readonly sha256: string;
}

export interface ProtectedMarkdownFile extends MarkdownFileRecord {
	readonly bytes_base64: string;
}

export type ApprovalFeedbackKind = "edit" | "proposal";

export type ApprovalFeedbackTarget =
	| Readonly<{ target_type: "semantic-id"; semantic_id: string }>
	| Readonly<{ target_type: "markdown-path"; markdown_path: string }>
	| Readonly<{ target_type: "dossier" }>;

export interface ApprovalFeedback {
	readonly feedback_id: string;
	readonly kind: ApprovalFeedbackKind;
	readonly target: ApprovalFeedbackTarget;
	readonly requested_change: string;
	readonly rationale: string;
	readonly evidence_ids: readonly string[];
}

export interface ApprovalResponse {
	readonly schema: typeof APPROVAL_RESPONSE_SCHEMA;
	readonly candidate: CandidateBinding;
	readonly candidate_sha256: string;
	readonly approval_status: ApprovalStatus;
	readonly approval_actor: string;
	readonly submitted_at: string;
	readonly approved_at: string | null;
	readonly declaration: string;
	readonly feedback: readonly ApprovalFeedback[];
	readonly files: readonly ProtectedMarkdownFile[];
}
export interface ApprovalDossierDecisionOption {
	readonly option_id: string;
	readonly label: string;
	readonly mechanism_or_output: string;
	readonly benefit: string;
	readonly omission_cost_or_uncertainty: string;
	readonly downstream_consequence: string;
	readonly evidence_ids: readonly string[];
}
export type ApprovalDossierReviewPresentation =
	| Readonly<{ kind: "context-only" }>
	| Readonly<{
		kind: "four-option-decision";
		purpose: string;
		why_it_matters: string;
		system_position: string;
		dependency_target_ids: readonly string[];
		key_points: readonly [string, ...string[]];
		research_summary: readonly [string, ...string[]];
		options: readonly [ApprovalDossierDecisionOption, ApprovalDossierDecisionOption, ApprovalDossierDecisionOption, ApprovalDossierDecisionOption];
		recommended_option_id: string;
		recommendation_rationale: string;
		uncertainty: string;
	}>;

export interface PublicationFileReceipt {
	readonly path: string;
	readonly sha256: string;
	readonly byte_count: number;
	readonly media_type: typeof MARKDOWN_MEDIA_TYPE;
}

export interface PublicationReceipt {
	readonly schema: typeof PUBLICATION_RECEIPT_SCHEMA;
	readonly receipt_sha256: string;
	readonly receipt_path: string;
	readonly candidate_sha256: string;
	readonly candidate_subject_sha256: string;
	readonly approved_html_sha256: string;
	readonly workflow: string;
	readonly run_id: string;
	readonly revision: number;
	readonly semantic_sha256: string;
	readonly bundle_sha256: string;
	readonly files: readonly PublicationFileReceipt[];
	readonly substantive_review_authority: AuthorityFileBinding;
	readonly final_paths: readonly string[];
}

export type ContractIssueCode =
	| "INVALID_TYPE"
	| "UNKNOWN_FIELD"
	| "MISSING_FIELD"
	| "INVALID_VALUE"
	| "INVALID_ORDER"
	| "HASH_MISMATCH"
	| "INVARIANT";

export interface ContractIssue {
	readonly code: ContractIssueCode;
	readonly path: string;
}

export type ParseResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; issues: readonly ContractIssue[] }>;

export class ApprovalDossierContractError extends TypeError {
	readonly issue: ContractIssue;
	constructor(issue: ContractIssue) {
		super(`${issue.code}:${issue.path}`);
		this.name = "ApprovalDossierContractError";
		this.issue = issue;
	}
}

export function bundleSha256(files: readonly MarkdownFileRecord[]): string {
	const validated = validateMarkdownFiles(files, "$.files");
	return hashCanonicalJson(
		validated.map(file => ({ path: file.path, sha256: file.sha256 })),
		CONTRACT_CANONICAL_JSON_LIMITS,
	);
}

export function candidateSha256(candidate: CandidateBinding): string {
	return hashCanonicalJson(validateCandidateBinding(candidate), CONTRACT_CANONICAL_JSON_LIMITS);
}
/** Hashes the exact candidate state without its back-reference to review authority. */
export function candidateReviewSubjectSha256(candidate: CandidateBinding): string {
	const validated = validateCandidateBinding(candidate);
	return hashCanonicalJson(
		{
			schema: validated.schema,
			workflow: validated.workflow,
			run_id: validated.run_id,
			revision: validated.revision,
			semantic_sha256: validated.semantic_sha256,
			files: validated.files,
			bundle_sha256: validated.bundle_sha256,
			visual_set_sha256: validated.visual_set_sha256,
			runtime_sha256: validated.runtime_sha256,
			predecessors: validated.predecessors,
			final_paths: validated.final_paths,
		},
		CONTRACT_CANONICAL_JSON_LIMITS,
	);
}

export function substantiveReviewAuthoritySha256(authority: SubstantiveReviewAuthority): string {
	return hashCanonicalJson(validateSubstantiveReviewAuthority(authority), CONTRACT_CANONICAL_JSON_LIMITS);
}

export function substantiveReviewAuthorityBytes(authority: SubstantiveReviewAuthority): Uint8Array {
	return Buffer.from(
		canonicalJson(validateSubstantiveReviewAuthority(authority), CONTRACT_CANONICAL_JSON_LIMITS),
		"utf8",
	);
}


export function visualSetSha256(visuals: readonly VisualRecord[]): string {
	const normalized = validateVisualRecords(visuals, "$.visuals");
	return hashCanonicalJson(normalized, CONTRACT_CANONICAL_JSON_LIMITS);
}

export function receiptBody(receipt: Omit<PublicationReceipt, "receipt_sha256">): string {
	return canonicalJson(receipt, CONTRACT_CANONICAL_JSON_LIMITS);
}

export function publicationReceiptSha256(receipt: Omit<PublicationReceipt, "receipt_sha256">): string {
	return hashCanonicalJson(receipt, CONTRACT_CANONICAL_JSON_LIMITS);
}

/** Returns the canonical UTF-8 bytes persisted for a validated publication receipt. */
export function publicationReceiptBytes(receipt: PublicationReceipt): Uint8Array {
	return Buffer.from(canonicalJson(validatePublicationReceipt(receipt), CONTRACT_CANONICAL_JSON_LIMITS), "utf8");
}

export function parseSemanticBinding(input: unknown): ParseResult<SemanticBinding> {
	return parsePublic(() => validateSemanticBinding(input));
}
export function parseMarkdownFileRecord(input: unknown): ParseResult<MarkdownFileRecord> {
	return parsePublic(() => validateMarkdownFileRecord(input));
}
export function parseBundleBinding(input: unknown): ParseResult<BundleBinding> {
	return parsePublic(() => validateBundleBinding(input));
}
export function parseRuntimeBinding(input: unknown): ParseResult<RuntimeBinding> {
	return parsePublic(() => validateRuntimeBinding(input));
}
export function parseVisualSet(input: unknown): ParseResult<VisualSet> {
	return parsePublic(() => validateVisualSet(input));
}
export function parseCandidateBinding(input: unknown): ParseResult<CandidateBinding> {
	return parsePublic(() => validateCandidateBinding(input));
}
export function parseSubstantiveReviewAssignment(input: unknown): ParseResult<ReviewAssignment> {
	return parsePublic(() => validateSubstantiveReviewAssignment(input));
}
export function parseSubstantiveReviewAssignments(input: unknown): ParseResult<readonly ReviewAssignment[]> {
	return parsePublic(() => validateSubstantiveReviewAssignments(input));
}
export function parseSubstantiveReviewAuthority(input: unknown): ParseResult<SubstantiveReviewAuthority> {
	return parsePublic(() => validateSubstantiveReviewAuthority(input));
}
export function parseAuthorityFileBinding(input: unknown): ParseResult<AuthorityFileBinding> {
	return parsePublic(() => validateAuthorityFileBinding(input));
}
export function parseApprovalFeedback(input: unknown): ParseResult<ApprovalFeedback> {
	return parsePublic(() => validateApprovalFeedback(input));
}
export function parseApprovalResponse(input: unknown): ParseResult<ApprovalResponse> {
	return parsePublic(() => validateApprovalResponse(input));
}
export function parsePublicationReceipt(input: unknown): ParseResult<PublicationReceipt> {
	return parsePublic(() => validatePublicationReceipt(input));
}

export function validateSemanticBinding(input: unknown): SemanticBinding {
	const object = closedObject(input, "$.semantic", [
		"schema",
		"workflow",
		"run_id",
		"revision",
		"semantic_sha256",
		"predecessor_sha256",
	]);
	return Object.freeze({
		schema: exactSchema(object.schema, SEMANTIC_BINDING_SCHEMA, "$.semantic.schema"),
		workflow: workflow(object.workflow, "$.semantic.workflow"),
		run_id: runId(object.run_id, "$.semantic.run_id"),
		revision: revision(object.revision, "$.semantic.revision"),
		semantic_sha256: sha256(object.semantic_sha256, "$.semantic.semantic_sha256"),
		predecessor_sha256: nullableSha256(object.predecessor_sha256, "$.semantic.predecessor_sha256"),
	});
}

export function validateMarkdownFileRecord(input: unknown, path = "$"): MarkdownFileRecord {
	const object = closedObject(input, path, ["schema", "path", "sha256", "byte_count", "media_type"]);
	return Object.freeze({
		schema: exactSchema(object.schema, MARKDOWN_FILE_SCHEMA, `${path}.schema`),
		path: validateRepositoryRelativePath(object.path, `${path}.path`),
		sha256: sha256(object.sha256, `${path}.sha256`),
		byte_count: byteCount(object.byte_count, `${path}.byte_count`),
		media_type: exactSchema(object.media_type, MARKDOWN_MEDIA_TYPE, `${path}.media_type`),
	});
}

export function validateMarkdownFiles(input: unknown, path = "$.files"): readonly MarkdownFileRecord[] {
	if (!Array.isArray(input) || input.length === 0 || input.length > 1_024) fail(path, "INVALID_TYPE");
	const files = input.map((entry, index) => validateMarkdownFileRecord(entry, `${path}[${index}]`));
	for (let index = 1; index < files.length; index += 1) {
		if ((files[index - 1] as MarkdownFileRecord).path >= (files[index] as MarkdownFileRecord).path)
			fail(path, "INVALID_ORDER");
	}
	return Object.freeze(files);
}

export function validateBundleBinding(input: unknown): BundleBinding {
	const object = closedObject(input, "$.bundle", ["schema", "files", "bundle_sha256"]);
	const files = validateMarkdownFiles(object.files, "$.bundle.files");
	const declared = sha256(object.bundle_sha256, "$.bundle.bundle_sha256");
	if (declared !== bundleSha256(files)) fail("$.bundle.bundle_sha256", "HASH_MISMATCH");
	return Object.freeze({
		schema: exactSchema(object.schema, BUNDLE_BINDING_SCHEMA, "$.bundle.schema"),
		files,
		bundle_sha256: declared,
	});
}

export function validateRuntimeBinding(input: unknown): RuntimeBinding {
	const object = closedObject(input, "$.runtime", [
		"schema",
		"runtime_sha256",
		"canonical_json_schema",
		"verifier_schema",
	]);
	return Object.freeze({
		schema: exactSchema(object.schema, RUNTIME_BINDING_SCHEMA, "$.runtime.schema"),
		runtime_sha256: sha256(object.runtime_sha256, "$.runtime.runtime_sha256"),
		canonical_json_schema: nonEmptyText(object.canonical_json_schema, "$.runtime.canonical_json_schema"),
		verifier_schema: nonEmptyText(object.verifier_schema, "$.runtime.verifier_schema"),
	});
}

export function validateVisualRecords(input: unknown, path = "$.visuals"): readonly VisualRecord[] {
	if (!Array.isArray(input) || input.length > 1_024) fail(path, "INVALID_TYPE");
	const records = input.map((entry, index) => {
		const object = closedObject(entry, `${path}[${index}]`, ["visual_id", "type", "sha256"]);
		return Object.freeze({
			visual_id: id(object.visual_id, `${path}[${index}].visual_id`),
			type: oneOf(
				object.type,
				["flow", "bar", "matrix", "timeline", "comparison"] as const,
				`${path}[${index}].type`,
			),
			sha256: sha256(object.sha256, `${path}[${index}].sha256`),
		});
	});
	for (let index = 1; index < records.length; index += 1) {
		if ((records[index - 1] as VisualRecord).visual_id >= (records[index] as VisualRecord).visual_id)
			fail(path, "INVALID_ORDER");
	}
	return Object.freeze(records);
}

export function validateVisualSet(input: unknown): VisualSet {
	const object = closedObject(input, "$.visual_set", ["schema", "visual_set_sha256", "visuals"]);
	const visuals = validateVisualRecords(object.visuals, "$.visual_set.visuals");

	const declared = sha256(object.visual_set_sha256, "$.visual_set.visual_set_sha256");
	if (declared !== visualSetSha256(visuals)) fail("$.visual_set.visual_set_sha256", "HASH_MISMATCH");
	return Object.freeze({
		schema: exactSchema(object.schema, VISUAL_SET_SCHEMA, "$.visual_set.schema"),
		visual_set_sha256: declared,
		visuals,
	});
}
/** Validates one closed blind review assignment. */
export function validateSubstantiveReviewAssignment(input: unknown, path = "$.review_assignment"): ReviewAssignment {
	const object = closedObject(input, path, ["role", "blind", "specialist_trigger"]);
	const role = id(object.role, `${path}.role`);
	if (object.blind !== true) fail(`${path}.blind`, "INVALID_VALUE");
	const baseline = isBaselineReviewRole(role);
	const specialistTrigger = validateSpecialistTrigger(object.specialist_trigger, `${path}.specialist_trigger`);
	if ((baseline && specialistTrigger !== null) || (!baseline && specialistTrigger === null)) {
		fail(`${path}.specialist_trigger`, "INVARIANT");
	}
	return Object.freeze({ role, blind: true, specialist_trigger: specialistTrigger });
}

/**
 * Validates one complete substantive panel: the four canonical baseline roles
 * in canonical order, followed by zero to two distinct trigger-bound roles.
 */
export function validateSubstantiveReviewAssignments(input: unknown): readonly ReviewAssignment[] {
	if (
		!Array.isArray(input) ||
		input.length < REVIEW_ASSIGNMENT_LIMITS.baseline_count ||
		input.length > REVIEW_ASSIGNMENT_LIMITS.baseline_count + REVIEW_ASSIGNMENT_LIMITS.maximum_specialist_count
	) {
		fail("$.review_assignments", "INVARIANT");
	}
	const assignments = input.map((entry, index) =>
		validateSubstantiveReviewAssignment(entry, `$.review_assignments[${index}]`),
	);
	for (const [index, role] of BASELINE_SUBSTANTIVE_REVIEW_ROLES.entries()) {
		const assignment = assignments[index];
		if (!assignment || assignment.role !== role || assignment.specialist_trigger !== null)
			fail(`$.review_assignments[${index}]`, "INVARIANT");
	}
	const triggerIds = new Set<string>();
	for (let index = REVIEW_ASSIGNMENT_LIMITS.baseline_count; index < assignments.length; index += 1) {
		const assignment = assignments[index]!;
		const previous = assignments[index - 1]!;
		if (
			isBaselineReviewRole(assignment.role) ||
			(index > REVIEW_ASSIGNMENT_LIMITS.baseline_count && assignment.role <= previous.role) ||
			assignment.specialist_trigger === null ||
			triggerIds.has(assignment.specialist_trigger.trigger_id)
		) {
			fail(`$.review_assignments[${index}]`, "INVARIANT");
		}
		triggerIds.add(assignment.specialist_trigger.trigger_id);
	}
	return Object.freeze(assignments);
}
export function validateAuthorityFileBinding(input: unknown, path = "$.authority_file"): AuthorityFileBinding {
	const object = closedObject(input, path, ["schema", "path", "sha256"]);
	return Object.freeze({
		schema: exactSchema(object.schema, AUTHORITY_FILE_BINDING_SCHEMA, `${path}.schema`),
		path: validateRepositoryRelativePath(object.path, `${path}.path`),
		sha256: sha256(object.sha256, `${path}.sha256`),
	});
}

/** Validates the closed current substantive-review projection and its derived gate. */
export function validateSubstantiveReviewAuthority(input: unknown): SubstantiveReviewAuthority {
	const object = closedObject(input, "$.substantive_review_authority", [
		"schema",
		"workflow",
		"run_id",
		"revision",
		"subject_sha256",
		"candidate_subject_sha256",
		"semantic_sha256",
		"bundle_sha256",
		"mandatory_coverage_ids",
		"assignments",
		"results",
		"occurrences",
		"derived_gate",
	]);
	const mandatoryCoverageIds = sortedUniqueIdArray(
		object.mandatory_coverage_ids,
		"$.substantive_review_authority.mandatory_coverage_ids",
		128,
	);
	if (mandatoryCoverageIds.length === 0) fail("$.substantive_review_authority.mandatory_coverage_ids", "INVARIANT");
	const subjectSha256 = sha256(object.subject_sha256, "$.substantive_review_authority.subject_sha256");
	const assignments = validateAuthorityAssignments(object.assignments, mandatoryCoverageIds);
	const results = validateAuthorityResults(object.results, assignments, subjectSha256);
	const occurrences = validateReviewOccurrences(object.occurrences, assignments, results);
	const derivedGate = deriveSubstantiveReviewGate(assignments, results, occurrences, mandatoryCoverageIds);
	if (object.derived_gate !== derivedGate) fail("$.substantive_review_authority.derived_gate", "INVARIANT");
	return Object.freeze({
		schema: exactSchema(object.schema, SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA, "$.substantive_review_authority.schema"),
		workflow: workflow(object.workflow, "$.substantive_review_authority.workflow"),
		run_id: runId(object.run_id, "$.substantive_review_authority.run_id"),
		revision: revision(object.revision, "$.substantive_review_authority.revision"),
		subject_sha256: subjectSha256,
		candidate_subject_sha256: sha256(
			object.candidate_subject_sha256,
			"$.substantive_review_authority.candidate_subject_sha256",
		),
		semantic_sha256: sha256(object.semantic_sha256, "$.substantive_review_authority.semantic_sha256"),
		bundle_sha256: sha256(object.bundle_sha256, "$.substantive_review_authority.bundle_sha256"),
		mandatory_coverage_ids: mandatoryCoverageIds,
		assignments,
		results,
		occurrences,
		derived_gate: derivedGate,
	});
}

export function assertSubstantiveReviewAuthorityPass(
	input: unknown,
	candidateInput: CandidateBinding,
	authoritySha256: string,
): SubstantiveReviewAuthority {
	const authority = validateSubstantiveReviewAuthority(input);
	const candidate = validateCandidateBinding(candidateInput);
	if (
		authority.derived_gate !== "PASS" ||
		authority.workflow !== candidate.workflow ||
		authority.run_id !== candidate.run_id ||
		authority.revision !== candidate.revision ||
		authority.candidate_subject_sha256 !== candidateReviewSubjectSha256(candidate) ||
		authority.semantic_sha256 !== candidate.semantic_sha256 ||
		authority.bundle_sha256 !== candidate.bundle_sha256 ||
		candidate.review_authority_sha256 !== sha256(authoritySha256, "$.review_authority_sha256")
	) {
		fail("$.substantive_review_authority", "INVARIANT");
	}
	return authority;
}

export function assertSubstantiveReviewAuthorityPassForSubject(
	input: unknown,
	expected: Readonly<{
		workflow: string;
		run_id: string;
		revision: number;
		candidate_subject_sha256: string;
		semantic_sha256: string;
		bundle_sha256: string;
	}>,
): SubstantiveReviewAuthority {
	const authority = validateSubstantiveReviewAuthority(input);
	if (
		authority.derived_gate !== "PASS" ||
		authority.workflow !== expected.workflow ||
		authority.run_id !== expected.run_id ||
		authority.revision !== expected.revision ||
		authority.candidate_subject_sha256 !== expected.candidate_subject_sha256 ||
		authority.semantic_sha256 !== expected.semantic_sha256 ||
		authority.bundle_sha256 !== expected.bundle_sha256
	) {
		fail("$.substantive_review_authority", "INVARIANT");
	}
	return authority;
}

function validateAuthorityAssignments(
	input: unknown,
	mandatoryCoverageIds: readonly string[],
): readonly SubstantiveReviewAssignment[] {
	if (
		!Array.isArray(input) ||
		input.length < REVIEW_ASSIGNMENT_LIMITS.baseline_count ||
		input.length > REVIEW_ASSIGNMENT_LIMITS.baseline_count + REVIEW_ASSIGNMENT_LIMITS.maximum_specialist_count
	) {
		fail("$.substantive_review_authority.assignments", "INVARIANT");
	}
	const assignments = input.map((entry, index) => {
		const path = `$.substantive_review_authority.assignments[${index}]`;
		const object = closedObject(entry, path, [
			"assignment_id",
			"role",
			"reviewer_id",
			"blind",
			"specialist_trigger",
			"required_coverage_ids",
		]);
		const role = id(object.role, `${path}.role`);
		if (object.blind !== true) fail(`${path}.blind`, "INVALID_VALUE");
		const specialistTrigger = validateSpecialistTrigger(object.specialist_trigger, `${path}.specialist_trigger`);
		if (
			(isBaselineReviewRole(role) && specialistTrigger !== null) ||
			(!isBaselineReviewRole(role) && specialistTrigger === null)
		)
			fail(`${path}.specialist_trigger`, "INVARIANT");
		const requiredCoverageIds = sortedUniqueIdArray(
			object.required_coverage_ids,
			`${path}.required_coverage_ids`,
			256,
		);
		return Object.freeze({
			assignment_id: id(object.assignment_id, `${path}.assignment_id`),
			role,
			reviewer_id: id(object.reviewer_id, `${path}.reviewer_id`),
			blind: true as const,
			specialist_trigger: specialistTrigger,
			required_coverage_ids: requiredCoverageIds,
		});
	});
	for (const [index, role] of BASELINE_SUBSTANTIVE_REVIEW_ROLES.entries()) {
		if (assignments[index]?.role !== role)
			fail(`$.substantive_review_authority.assignments[${index}].role`, "INVARIANT");
	}
	const assignmentIds = new Set<string>();
	const reviewerIds = new Set<string>();
	for (let index = 0; index < assignments.length; index += 1) {
		const assignment = assignments[index]!;
		if (assignmentIds.has(assignment.assignment_id) || reviewerIds.has(assignment.reviewer_id))
			fail(`$.substantive_review_authority.assignments[${index}]`, "INVARIANT");
		assignmentIds.add(assignment.assignment_id);
		reviewerIds.add(assignment.reviewer_id);
		if (index >= REVIEW_ASSIGNMENT_LIMITS.baseline_count) {
			const previous = assignments[index - 1]!;
			if (
				isBaselineReviewRole(assignment.role) ||
				(index > REVIEW_ASSIGNMENT_LIMITS.baseline_count && assignment.role <= previous.role)
			)
				fail(`$.substantive_review_authority.assignments[${index}].role`, "INVALID_ORDER");
		}
		if (mandatoryCoverageIds.some(coverageId => !assignment.required_coverage_ids.includes(coverageId))) {
		}
	}
	return Object.freeze(assignments);
}

function validateAuthorityResults(
	input: unknown,
	assignments: readonly SubstantiveReviewAssignment[],
	subjectSha256: string,
): readonly SubstantiveReviewResult[] {
	if (!Array.isArray(input) || input.length > assignments.length)
		fail("$.substantive_review_authority.results", "INVALID_TYPE");
	const assignmentIndexes = new Map(assignments.map((assignment, index) => [assignment.assignment_id, index]));
	const seenResultIds = new Set<string>();
	const seenAssignments = new Set<string>();
	let previousAssignmentIndex = -1;
	const results = input.map((entry, index) => {
		const path = `$.substantive_review_authority.results[${index}]`;
		const object = closedObject(entry, path, [
			"result_id",
			"result_sha256",
			"assignment_id",
			"reviewer_id",
			"subject_sha256",
			"verdict",
			"covered_coverage_ids",
			"occurrence_ids",
			"completed_at",
		]);
		const resultId = id(object.result_id, `${path}.result_id`);
		const assignmentId = id(object.assignment_id, `${path}.assignment_id`);
		const assignmentIndex = assignmentIndexes.get(assignmentId);
		const assignment = assignmentIndex === undefined ? undefined : assignments[assignmentIndex];
		if (
			!assignment ||
			assignmentIndex <= previousAssignmentIndex ||
			seenResultIds.has(resultId) ||
			seenAssignments.has(assignmentId)
		)
			fail(path, "INVARIANT");
		previousAssignmentIndex = assignmentIndex;
		seenResultIds.add(resultId);
		seenAssignments.add(assignmentId);
		const reviewerId = id(object.reviewer_id, `${path}.reviewer_id`);
		if (
			reviewerId !== assignment.reviewer_id ||
			sha256(object.subject_sha256, `${path}.subject_sha256`) !== subjectSha256
		)
			fail(path, "INVARIANT");
		return Object.freeze({
			result_id: resultId,
			result_sha256: sha256(object.result_sha256, `${path}.result_sha256`),
			assignment_id: assignmentId,
			reviewer_id: reviewerId,
			subject_sha256: subjectSha256,
			verdict: oneOf(object.verdict, ["PASS", "BLOCK", "UNRESOLVED"] as const, `${path}.verdict`),
			covered_coverage_ids: sortedUniqueIdArray(object.covered_coverage_ids, `${path}.covered_coverage_ids`, 256),
			occurrence_ids: stringArray(object.occurrence_ids, `${path}.occurrence_ids`, id),
			completed_at: timestamp(object.completed_at, `${path}.completed_at`),
		});
	});
	return Object.freeze(results);
}

function validateReviewOccurrences(
	input: unknown,
	assignments: readonly SubstantiveReviewAssignment[],
	results: readonly SubstantiveReviewResult[],
): readonly ReviewOccurrence[] {
	if (!Array.isArray(input) || input.length > 1_024)
		fail("$.substantive_review_authority.occurrences", "INVALID_TYPE");
	const assignmentIds = new Set(assignments.map(assignment => assignment.assignment_id));
	const prior = new Map<string, ReviewOccurrence>();
	const occurrences = input.map((entry, index) => {
		const path = `$.substantive_review_authority.occurrences[${index}]`;
		const object = closedObject(entry, path, [
			"occurrence_id",
			"finding_id",
			"assignment_id",
			"blocking",
			"resolution",
			"duplicate_of",
			"recurrence_of",
			"regression_of",
			"caused_by",
			"supersedes",
		]);
		const occurrenceId = id(object.occurrence_id, `${path}.occurrence_id`);
		const findingId = id(object.finding_id, `${path}.finding_id`);
		const assignmentId = id(object.assignment_id, `${path}.assignment_id`);
		if (prior.has(occurrenceId) || !assignmentIds.has(assignmentId) || typeof object.blocking !== "boolean")
			fail(path, "INVARIANT");
		const relations = {
			duplicate_of: nullableId(object.duplicate_of, `${path}.duplicate_of`),
			recurrence_of: nullableId(object.recurrence_of, `${path}.recurrence_of`),
			regression_of: nullableId(object.regression_of, `${path}.regression_of`),
			caused_by: nullableId(object.caused_by, `${path}.caused_by`),
			supersedes: nullableId(object.supersedes, `${path}.supersedes`),
		};
		for (const [relation, targetId] of Object.entries(relations)) {
			if (targetId === null) continue;
			const target = prior.get(targetId);
			if (!target || targetId === occurrenceId) fail(`${path}.${relation}`, "INVARIANT");
			if (
				(relation === "recurrence_of" || relation === "regression_of" || relation === "supersedes") &&
				target.finding_id !== findingId
			)
				fail(`${path}.${relation}`, "INVARIANT");
		}
		const occurrence = Object.freeze({
			occurrence_id: occurrenceId,
			finding_id: findingId,
			assignment_id: assignmentId,
			blocking: object.blocking,
			resolution: oneOf(object.resolution, ["resolved", "unresolved"] as const, `${path}.resolution`),
			...relations,
		}) satisfies ReviewOccurrence;
		prior.set(occurrenceId, occurrence);
		return occurrence;
	});
	const claimedOccurrences = new Set<string>();
	for (const result of results) {
		for (const occurrenceId of result.occurrence_ids) {
			const occurrence = prior.get(occurrenceId);
			if (!occurrence || occurrence.assignment_id !== result.assignment_id || claimedOccurrences.has(occurrenceId))
				fail("$.substantive_review_authority.results", "INVARIANT");
			claimedOccurrences.add(occurrenceId);
		}
	}
	if (claimedOccurrences.size !== occurrences.length) fail("$.substantive_review_authority.occurrences", "INVARIANT");
	return Object.freeze(occurrences);
}

function deriveSubstantiveReviewGate(
	assignments: readonly SubstantiveReviewAssignment[],
	results: readonly SubstantiveReviewResult[],
	occurrences: readonly ReviewOccurrence[],
	mandatoryCoverageIds: readonly string[],
): SubstantiveReviewGate {
	if (results.length !== assignments.length) return "INCOMPLETE";
	for (const assignment of assignments) {
		const result = results.find(entry => entry.assignment_id === assignment.assignment_id);
		if (
			!result ||
			mandatoryCoverageIds.some(coverageId => !assignment.required_coverage_ids.includes(coverageId)) ||
			assignment.required_coverage_ids.some(coverageId => !result.covered_coverage_ids.includes(coverageId))
		)
			return "INCOMPLETE";
	}
	if (
		results.some(result => result.verdict === "BLOCK") ||
		occurrences.some(occurrence => occurrence.blocking && occurrence.resolution === "unresolved")
	)
		return "BLOCK";
	if (
		results.some(result => result.verdict === "UNRESOLVED") ||
		occurrences.some(occurrence => occurrence.resolution === "unresolved")
	)
		return "UNRESOLVED";
	return "PASS";
}

export function validateCandidateBinding(input: unknown): CandidateBinding {
	const object = closedObject(input, "$.candidate", [
		"schema",
		"workflow",
		"run_id",
		"revision",
		"semantic_sha256",
		"files",
		"bundle_sha256",
		"visual_set_sha256",
		"runtime_sha256",
		"review_authority_sha256",
		"predecessors",
		"final_paths",
	]);
	const files = validateMarkdownFiles(object.files, "$.candidate.files");
	const finalPaths = stringArray(object.final_paths, "$.candidate.final_paths", validateRepositoryRelativePath);
	if (finalPaths.length !== files.length) fail("$.candidate.final_paths", "INVARIANT");
	for (let index = 0; index < files.length; index += 1)
		if (files[index]?.path !== finalPaths[index]) fail("$.candidate.final_paths", "INVARIANT");
	const predecessors = stringArray(object.predecessors, "$.candidate.predecessors", sha256);
	for (let index = 1; index < predecessors.length; index += 1)
		if (predecessors[index - 1] >= predecessors[index]) fail("$.candidate.predecessors", "INVALID_ORDER");
	const bundle = sha256(object.bundle_sha256, "$.candidate.bundle_sha256");
	if (bundle !== bundleSha256(files)) fail("$.candidate.bundle_sha256", "HASH_MISMATCH");
	return Object.freeze({
		schema: exactSchema(object.schema, CANDIDATE_SCHEMA, "$.candidate.schema"),
		workflow: workflow(object.workflow, "$.candidate.workflow"),
		run_id: runId(object.run_id, "$.candidate.run_id"),
		revision: revision(object.revision, "$.candidate.revision"),
		semantic_sha256: sha256(object.semantic_sha256, "$.candidate.semantic_sha256"),
		files,
		bundle_sha256: bundle,
		visual_set_sha256: sha256(object.visual_set_sha256, "$.candidate.visual_set_sha256"),
		runtime_sha256: sha256(object.runtime_sha256, "$.candidate.runtime_sha256"),
		review_authority_sha256: sha256(object.review_authority_sha256, "$.candidate.review_authority_sha256"),
		predecessors,
		final_paths: finalPaths,
	});
}

export function validateProtectedMarkdownFile(input: unknown, path = "$"): ProtectedMarkdownFile {
	const object = closedObject(input, path, ["schema", "path", "sha256", "byte_count", "media_type", "bytes_base64"]);
	const record = validateMarkdownFileRecord(
		{
			schema: object.schema,
			path: object.path,
			sha256: object.sha256,
			byte_count: object.byte_count,
			media_type: object.media_type,
		},
		path,
	);
	const bytes = decodeBase64(object.bytes_base64, `${path}.bytes_base64`);
	if (bytes.byteLength !== record.byte_count) fail(`${path}.bytes_base64`, "INVARIANT");
	if (hashRawBytes(bytes) !== record.sha256) fail(`${path}.bytes_base64`, "HASH_MISMATCH");
	return Object.freeze({ ...record, bytes_base64: object.bytes_base64 as string });
}

export function validateApprovalFeedbackTarget(input: unknown, path = "$.feedback.target"): ApprovalFeedbackTarget {
	if (input === null || typeof input !== "object" || Array.isArray(input)) fail(path, "INVALID_TYPE");
	const targetType = (input as Record<string, unknown>).target_type;
	if (targetType === "semantic-id") {
		const object = closedObject(input, path, ["target_type", "semantic_id"]);
		return Object.freeze({ target_type: "semantic-id", semantic_id: id(object.semantic_id, `${path}.semantic_id`) });
	}
	if (targetType === "markdown-path") {
		const object = closedObject(input, path, ["target_type", "markdown_path"]);
		return Object.freeze({
			target_type: "markdown-path",
			markdown_path: validateRepositoryRelativePath(object.markdown_path, `${path}.markdown_path`),
		});
	}
	if (targetType === "dossier") {
		closedObject(input, path, ["target_type"]);
		return Object.freeze({ target_type: "dossier" });
	}
	fail(`${path}.target_type`, "INVALID_VALUE");
}

export function validateApprovalFeedback(input: unknown, path = "$.feedback"): ApprovalFeedback {
	const object = closedObject(input, path, [
		"feedback_id",
		"kind",
		"target",
		"requested_change",
		"rationale",
		"evidence_ids",
	]);
	const evidenceIds = sortedUniqueIdArray(
		object.evidence_ids,
		`${path}.evidence_ids`,
		APPROVAL_FEEDBACK_LIMITS.maximum_evidence_ids,
	);
	return Object.freeze({
		feedback_id: id(object.feedback_id, `${path}.feedback_id`),
		kind: oneOf(object.kind, ["edit", "proposal"] as const, `${path}.kind`),
		target: validateApprovalFeedbackTarget(object.target, `${path}.target`),
		requested_change: boundedNonEmptyText(
			object.requested_change,
			`${path}.requested_change`,
			APPROVAL_FEEDBACK_LIMITS.maximum_text_bytes,
		),
		rationale: boundedNonEmptyText(
			object.rationale,
			`${path}.rationale`,
			APPROVAL_FEEDBACK_LIMITS.maximum_text_bytes,
		),
		evidence_ids: evidenceIds,
	});
}

export function validateApprovalFeedbacks(input: unknown, path = "$.approval.feedback"): readonly ApprovalFeedback[] {
	if (!Array.isArray(input) || input.length > APPROVAL_FEEDBACK_LIMITS.maximum_items) fail(path, "INVALID_TYPE");
	const feedback = input.map((entry, index) => validateApprovalFeedback(entry, `${path}[${index}]`));
	for (let index = 1; index < feedback.length; index += 1) {
		if ((feedback[index - 1] as ApprovalFeedback).feedback_id >= (feedback[index] as ApprovalFeedback).feedback_id)
			fail(path, "INVALID_ORDER");
	}
	return Object.freeze(feedback);
}

export function validateApprovalResponse(input: unknown): ApprovalResponse {
	const object = closedObject(input, "$.approval", [
		"schema",
		"candidate",
		"candidate_sha256",
		"approval_status",
		"approval_actor",
		"submitted_at",
		"approved_at",
		"declaration",
		"feedback",
		"files",
	]);
	const candidate = validateCandidateBinding(object.candidate);
	const candidateHash = sha256(object.candidate_sha256, "$.approval.candidate_sha256");
	if (candidateHash !== candidateSha256(candidate)) fail("$.approval.candidate_sha256", "HASH_MISMATCH");
	const status = oneOf(
		object.approval_status,
		["draft", "changes-requested", "approved", "rejected"] as const,
		"$.approval.approval_status",
	);
	const submitted = timestamp(object.submitted_at, "$.approval.submitted_at");
	const approved = nullableTimestamp(object.approved_at, "$.approval.approved_at");
	if (status === "approved" && approved === null) fail("$.approval.approved_at", "INVARIANT");
	if (status !== "approved" && approved !== null) fail("$.approval.approved_at", "INVARIANT");
	if (status === "approved" && object.declaration !== APPROVAL_DECLARATION)
		fail("$.approval.declaration", "INVARIANT");
	const feedback = validateApprovalFeedbacks(object.feedback);
	if (status === "changes-requested" && feedback.length === 0) fail("$.approval.feedback", "INVARIANT");
	if (status === "approved" && feedback.length !== 0) fail("$.approval.feedback", "INVARIANT");
	const files = validateProtectedFiles(object.files, "$.approval.files");
	if (files.length !== candidate.files.length) fail("$.approval.files", "INVARIANT");
	for (let index = 0; index < files.length; index += 1) {
		const protectedFile = files[index] as ProtectedMarkdownFile;
		const candidateFile = candidate.files[index] as MarkdownFileRecord;
		if (
			protectedFile.path !== candidateFile.path ||
			protectedFile.sha256 !== candidateFile.sha256 ||
			protectedFile.byte_count !== candidateFile.byte_count ||
			protectedFile.media_type !== candidateFile.media_type
		)
			fail(`$.approval.files[${index}]`, "INVARIANT");
	}
	return Object.freeze({
		schema: exactSchema(object.schema, APPROVAL_RESPONSE_SCHEMA, "$.approval.schema"),
		candidate,
		candidate_sha256: candidateHash,
		approval_status: status,
		approval_actor: nonEmptyText(object.approval_actor, "$.approval.approval_actor"),
		submitted_at: submitted,
		approved_at: approved,
		declaration: text(object.declaration, "$.approval.declaration"),
		feedback,
		files,
	});
}


export function validatePublicationReceipt(input: unknown): PublicationReceipt {
	const object = closedObject(input, "$.receipt", [
		"schema",
		"receipt_sha256",
		"receipt_path",
		"candidate_sha256",
		"candidate_subject_sha256",
		"approved_html_sha256",
		"workflow",
		"run_id",
		"revision",
		"semantic_sha256",
		"bundle_sha256",
		"files",
		"substantive_review_authority",
		"final_paths",
	]);
	const files = validatePublicationFiles(object.files, "$.receipt.files");
	const finalPaths = stringArray(object.final_paths, "$.receipt.final_paths", validateRepositoryRelativePath);
	if (finalPaths.length !== files.length || files.some((file, index) => file.path !== finalPaths[index]))
		fail("$.receipt.final_paths", "INVARIANT");
	const substantiveReviewAuthority = validateAuthorityFileBinding(
		object.substantive_review_authority,
		"$.receipt.substantive_review_authority",
	);
	const receipt = {
		schema: exactSchema(object.schema, PUBLICATION_RECEIPT_SCHEMA, "$.receipt.schema"),
		receipt_sha256: sha256(object.receipt_sha256, "$.receipt.receipt_sha256"),
		receipt_path: validateRepositoryRelativePath(object.receipt_path, "$.receipt.receipt_path"),
		candidate_sha256: sha256(object.candidate_sha256, "$.receipt.candidate_sha256"),
		candidate_subject_sha256: sha256(object.candidate_subject_sha256, "$.receipt.candidate_subject_sha256"),
		approved_html_sha256: sha256(object.approved_html_sha256, "$.receipt.approved_html_sha256"),
		workflow: workflow(object.workflow, "$.receipt.workflow"),
		run_id: runId(object.run_id, "$.receipt.run_id"),
		revision: revision(object.revision, "$.receipt.revision"),
		semantic_sha256: sha256(object.semantic_sha256, "$.receipt.semantic_sha256"),
		bundle_sha256: sha256(object.bundle_sha256, "$.receipt.bundle_sha256"),
		files,
		substantive_review_authority: substantiveReviewAuthority,
		final_paths: finalPaths,
	} satisfies PublicationReceipt;
	const { receipt_sha256, ...body } = receipt;
	if (receipt_sha256 !== publicationReceiptSha256(body)) fail("$.receipt.receipt_sha256", "HASH_MISMATCH");
	return Object.freeze(receipt);
}

function validateProtectedFiles(input: unknown, path: string): readonly ProtectedMarkdownFile[] {
	if (!Array.isArray(input) || input.length === 0 || input.length > 1_024) fail(path, "INVALID_TYPE");
	const files = input.map((entry, index) => validateProtectedMarkdownFile(entry, `${path}[${index}]`));
	for (let index = 1; index < files.length; index += 1)
		if ((files[index - 1] as ProtectedMarkdownFile).path >= (files[index] as ProtectedMarkdownFile).path)
			fail(path, "INVALID_ORDER");
	return Object.freeze(files);
}

function validatePublicationFiles(input: unknown, path: string): readonly PublicationFileReceipt[] {
	if (!Array.isArray(input) || input.length === 0 || input.length > 1_024) fail(path, "INVALID_TYPE");
	const files = input.map((entry, index) => {
		const object = closedObject(entry, `${path}[${index}]`, ["path", "sha256", "byte_count", "media_type"]);
		return Object.freeze({
			path: validateRepositoryRelativePath(object.path, `${path}[${index}].path`),
			sha256: sha256(object.sha256, `${path}[${index}].sha256`),
			byte_count: byteCount(object.byte_count, `${path}[${index}].byte_count`),
			media_type: exactSchema(object.media_type, MARKDOWN_MEDIA_TYPE, `${path}[${index}].media_type`),
		});
	});
	for (let index = 1; index < files.length; index += 1)
		if ((files[index - 1] as PublicationFileReceipt).path >= (files[index] as PublicationFileReceipt).path)
			fail(path, "INVALID_ORDER");
	return Object.freeze(files);
}
function isBaselineReviewRole(role: string): role is BaselineSubstantiveReviewRole {
	return (BASELINE_SUBSTANTIVE_REVIEW_ROLES as readonly string[]).includes(role);
}

function validateSpecialistTrigger(input: unknown, path: string): SpecialistTrigger | null {
	if (input === null) return null;
	const object = closedObject(input, path, ["trigger_id", "evidence"]);
	return Object.freeze({
		trigger_id: id(object.trigger_id, `${path}.trigger_id`),
		evidence: boundedNonEmptyText(
			object.evidence,
			`${path}.evidence`,
			REVIEW_ASSIGNMENT_LIMITS.maximum_trigger_evidence_bytes,
		),
	});
}

function parsePublic<T>(parser: () => T): ParseResult<T> {
	try {
		return { ok: true, value: parser() };
	} catch (error) {
		if (error instanceof ApprovalDossierContractError) return { ok: false, issues: [error.issue] };
		return { ok: false, issues: [{ code: "INVALID_TYPE", path: "$" }] };
	}
}

function closedObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		fail(path, "INVALID_TYPE");
	const object = value as Record<string, unknown>;
	for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${path}.${key}`, "UNKNOWN_FIELD");
	for (const key of keys) if (!Object.hasOwn(object, key)) fail(`${path}.${key}`, "MISSING_FIELD");
	return object;
}

function exactSchema(value: unknown, expected: string, path: string): string {
	if (value !== expected) fail(path, "INVALID_VALUE");
	return expected;
}
function text(value: unknown, path: string): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1_048_576) fail(path, "INVALID_TYPE");
	return value;
}
function nonEmptyText(value: unknown, path: string): string {
	const result = text(value, path);
	if (result.length === 0) fail(path, "INVALID_VALUE");
	return result;
}
function boundedNonEmptyText(value: unknown, path: string, maximumBytes: number): string {
	const result = text(value, path);
	if (result.trim().length === 0 || Buffer.byteLength(result, "utf8") > maximumBytes) fail(path, "INVALID_VALUE");
	return result;
}
function id(value: unknown, path: string): string {
	const result = nonEmptyText(value, path);
	if (!ID.test(result)) fail(path, "INVALID_VALUE");
	return result;
}
function nullableId(value: unknown, path: string): string | null {
	return value === null ? null : id(value, path);
}
function workflow(value: unknown, path: string): string {
	const result = nonEmptyText(value, path);
	if (!WORKFLOW.test(result)) fail(path, "INVALID_VALUE");
	return result;
}
function runId(value: unknown, path: string): string {
	const result = nonEmptyText(value, path);
	if (!RUN_ID.test(result)) fail(path, "INVALID_VALUE");
	return result;
}
/** Canonical parser for every repository-relative authority and publication path. */
export function validateRepositoryRelativePath(value: unknown, path = "$.path"): string {
	const result = nonEmptyText(value, path);
	if (result.startsWith("/") || result.includes("\\") || !RELATIVE_PATH.test(result)) fail(path, "INVALID_VALUE");
	const segments = result.split("/");
	if (segments.some(segment => segment.length === 0 || segment === "." || segment === ".."))
		fail(path, "INVALID_VALUE");
	return segments.join("/");
}
function sha256(value: unknown, path: string): string {
	const result = nonEmptyText(value, path);
	if (!HASH.test(result)) fail(path, "INVALID_VALUE");
	return result;
}
function nullableSha256(value: unknown, path: string): string | null {
	return value === null ? null : sha256(value, path);
}
/** Validates an accepted canonical RFC 3339 timestamp for authority records. */
export function validateApprovalTimestamp(value: unknown, path = "$.timestamp"): string {
	return timestamp(value, path);
}

function timestamp(value: unknown, path: string): string {
	const result = nonEmptyText(value, path);
	if (!UTC_TIMESTAMP.test(result) || Number.isNaN(Date.parse(result))) fail(path, "INVALID_VALUE");
	return result;
}
function nullableTimestamp(value: unknown, path: string): string | null {
	return value === null ? null : timestamp(value, path);
}
function revision(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000)
		fail(path, "INVALID_VALUE");
	return value;
}
function byteCount(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 51_380_224)
		fail(path, "INVALID_VALUE");
	return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) fail(path, "INVALID_VALUE");
	return value as T;
}
function stringArray<T extends string>(
	value: unknown,
	path: string,
	parser: (value: unknown, path: string) => T,
): readonly T[] {
	if (!Array.isArray(value) || value.length > 1_024) fail(path, "INVALID_TYPE");
	const result = value.map((entry, index) => parser(entry, `${path}[${index}]`));
	const seen = new Set<string>();
	for (const item of result) {
		if (seen.has(item)) fail(path, "INVARIANT");
		seen.add(item);
	}
	return Object.freeze(result);
}
function sortedUniqueIdArray(value: unknown, path: string, maximumLength: number): readonly string[] {
	if (!Array.isArray(value) || value.length > maximumLength) fail(path, "INVALID_TYPE");
	const result = value.map((entry, index) => id(entry, `${path}[${index}]`));
	for (let index = 1; index < result.length; index += 1)
		if ((result[index - 1] as string) >= (result[index] as string)) fail(path, "INVALID_ORDER");
	return Object.freeze(result);
}
function decodeBase64(value: unknown, path: string): Uint8Array {
	if (typeof value !== "string") fail(path, "INVALID_TYPE");
	if (value.length > 70_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		fail(path, "INVALID_VALUE");
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) fail(path, "INVALID_VALUE");
	return bytes;
}
function fail(path: string, code: ContractIssueCode): never {
	throw new ApprovalDossierContractError({ code, path });
}
