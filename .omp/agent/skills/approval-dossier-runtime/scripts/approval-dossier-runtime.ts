import {
	APPROVAL_DECLARATION,
	APPROVAL_RESPONSE_SCHEMA,
	type ApprovalFeedback,
	type ApprovalResponse,
	assertSubstantiveReviewAuthorityPass,
	bundleSha256,
	CANDIDATE_SCHEMA,
	type CandidateBinding,
	candidateReviewSubjectSha256,
	candidateSha256,
	MARKDOWN_FILE_SCHEMA,
	MARKDOWN_MEDIA_TYPE,
	type MarkdownFileRecord,
	type RuntimeBinding,
	type SemanticBinding,
	type SubstantiveReviewAuthority,
	substantiveReviewAuthoritySha256,
	type VisualSet,
	validateApprovalResponse,
	validateCandidateBinding,
	validateMarkdownFileRecord,
	validateRuntimeBinding,
	validateSemanticBinding,
	validateSubstantiveReviewAuthority,
	validateVisualSet,
} from "../schemas/approval-dossier.ts";
import { hashRawBytes } from "./canonical-json.ts";

export interface ApprovalFileBytes {
	readonly path: string;
	readonly bytes: Uint8Array;
}

/** Primitive builder for adapters that already own validated file records. */
export interface CandidateInput {
	readonly workflow: string;
	readonly run_id: string;
	readonly revision: number;
	readonly semantic_sha256: string;
	readonly files: readonly MarkdownFileRecord[];
	readonly visual_set_sha256: string;
	readonly runtime_sha256: string;
	readonly review_authority_sha256: string;
	readonly predecessors: readonly string[];
	readonly final_paths?: readonly string[];
}

/** Fully bound candidate input for workflow adapters that own closed authority records. */
export interface CandidateFromBindingsInput {
	readonly semantic: SemanticBinding;
	readonly markdown_files: readonly ApprovalFileBytes[];
	readonly runtime: RuntimeBinding;
	readonly visual_set: VisualSet;
	readonly review_authority: SubstantiveReviewAuthority;
	readonly predecessors: readonly string[];
}

export interface ApprovalResponseInput {
	readonly candidate: CandidateBinding;
	readonly approval_status: ApprovalResponse["approval_status"];
	readonly approval_actor: string;
	readonly submitted_at: string;
	readonly approved_at: string | null;
	readonly declaration?: string;
	readonly feedback: readonly ApprovalFeedback[];
	readonly files: readonly ApprovalFileBytes[];
}

/** Builds one Markdown file record from the exact downstream bytes. */
export function createMarkdownFileRecord(path: string, bytes: Uint8Array): MarkdownFileRecord {
	return validateMarkdownFileRecord({
		schema: MARKDOWN_FILE_SCHEMA,
		path,
		sha256: hashRawBytes(bytes),
		byte_count: bytes.byteLength,
		media_type: MARKDOWN_MEDIA_TYPE,
	});
}

/** Builds and closes a candidate binding from already-defined hash authority. */
export function createCandidateBinding(input: CandidateInput): CandidateBinding {
	const files = input.files.map(file => validateMarkdownFileRecord(file));
	return validateCandidateBinding({
		schema: CANDIDATE_SCHEMA,
		workflow: input.workflow,
		run_id: input.run_id,
		revision: input.revision,
		semantic_sha256: input.semantic_sha256,
		files,
		bundle_sha256: bundleSha256(files),
		visual_set_sha256: input.visual_set_sha256,
		runtime_sha256: input.runtime_sha256,
		review_authority_sha256: input.review_authority_sha256,
		predecessors: input.predecessors,
		final_paths: input.final_paths ?? files.map(file => file.path),
	});
}

/**
 * Builds a candidate directly from closed semantic/runtime/visual records and a
 * canonical review-authority record. This is the preferred adapter API.
 */
export function createCandidateFromBindings(input: CandidateFromBindingsInput): CandidateBinding {
	const semantic = validateSemanticBinding(input.semantic);
	const runtime = validateRuntimeBinding(input.runtime);
	const visualSet = validateVisualSet(input.visual_set);
	const reviewAuthority = validateSubstantiveReviewAuthority(input.review_authority);
	const files = input.markdown_files
		.map(file => createMarkdownFileRecord(file.path, file.bytes))
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const candidate = createCandidateBinding({
		workflow: semantic.workflow,
		run_id: semantic.run_id,
		revision: semantic.revision,
		semantic_sha256: semantic.semantic_sha256,
		files,
		visual_set_sha256: visualSet.visual_set_sha256,
		runtime_sha256: runtime.runtime_sha256,
		review_authority_sha256: substantiveReviewAuthoritySha256(reviewAuthority),
		predecessors: input.predecessors,
	});
	assertCandidateSemanticBinding(candidate, semantic);
	if (reviewAuthority.candidate_subject_sha256 !== candidateReviewSubjectSha256(candidate)) {
		throw new TypeError("review authority does not match candidate subject");
	}
	assertSubstantiveReviewAuthorityPass(reviewAuthority, candidate, candidate.review_authority_sha256);
	return candidate;
}

/** Confirms a candidate retains every workflow-owned semantic binding. */
export function assertCandidateSemanticBinding(
	candidateInput: CandidateBinding,
	semanticInput: SemanticBinding,
): CandidateBinding {
	const candidate = validateCandidateBinding(candidateInput);
	const semantic = validateSemanticBinding(semanticInput);
	const expectedPredecessors = semantic.predecessor_sha256 === null ? [] : [semantic.predecessor_sha256];
	if (
		candidate.workflow !== semantic.workflow ||
		candidate.run_id !== semantic.run_id ||
		candidate.revision !== semantic.revision ||
		candidate.semantic_sha256 !== semantic.semantic_sha256 ||
		candidate.predecessors.length !== expectedPredecessors.length ||
		candidate.predecessors.some((predecessor, index) => predecessor !== expectedPredecessors[index])
	) {
		throw new TypeError("candidate does not match semantic binding");
	}
	return candidate;
}

/** Creates the protected approval state that renderers encode without alteration. */
export function createApprovalResponse(input: ApprovalResponseInput): ApprovalResponse {
	const candidate = validateCandidateBinding(input.candidate);
	const files = [...input.files]
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		.map(entry => {
			const candidateFile = candidate.files.find(file => file.path === entry.path);
			if (
				!candidateFile ||
				hashRawBytes(entry.bytes) !== candidateFile.sha256 ||
				entry.bytes.byteLength !== candidateFile.byte_count
			) {
				throw new TypeError(`approval file does not match candidate: ${entry.path}`);
			}
			return {
				schema: MARKDOWN_FILE_SCHEMA,
				path: candidateFile.path,
				sha256: candidateFile.sha256,
				byte_count: candidateFile.byte_count,
				media_type: candidateFile.media_type,
				bytes_base64: Buffer.from(entry.bytes).toString("base64"),
			};
		});
	return validateApprovalResponse({
		schema: APPROVAL_RESPONSE_SCHEMA,
		candidate,
		candidate_sha256: candidateSha256(candidate),
		approval_status: input.approval_status,
		approval_actor: input.approval_actor,
		submitted_at: input.submitted_at,
		approved_at: input.approved_at,
		declaration: input.declaration ?? APPROVAL_DECLARATION,
		feedback: input.feedback,
		files,
	});
}

export * from "./approval-dossier-html.ts";
export * from "./approval-dossier-publisher.ts";
export * from "./approval-dossier-verifier.ts";
export * from "./authority-files.ts";
export * from "./review-authority-files.ts";
