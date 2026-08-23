import { describe, expect, test } from "bun:test";
import {
	APPROVAL_DECLARATION,
	BASELINE_SUBSTANTIVE_REVIEW_ROLES,
	BUNDLE_BINDING_SCHEMA,
	bundleSha256,
	CANDIDATE_SCHEMA,
	MARKDOWN_FILE_SCHEMA,
	MARKDOWN_MEDIA_TYPE,
	parseApprovalResponse,
	parseCandidateBinding,
	parsePublicationReceipt,
	validateRepositoryRelativePath,
	validateSubstantiveReviewAssignment,
	validateSubstantiveReviewAssignments,
} from "../schemas/approval-dossier.ts";
import { normalizeRepositoryRelativePath } from "./approval-dossier-publisher.ts";
import {
	createApprovalResponse,
	createCandidateBinding,
	createMarkdownFileRecord,
} from "./approval-dossier-runtime.ts";
import { hashCanonicalJson, hashRawBytes } from "./canonical-json.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function candidate() {
	return createCandidateBinding({
		workflow: "ideation",
		run_id: "run-1",
		revision: 1,
		semantic_sha256: HASH_A,
		files: [createMarkdownFileRecord("docs/plan.md", Buffer.from("# Plan\n"))],
		visual_set_sha256: HASH_B,
		runtime_sha256: HASH_C,
		review_authority_sha256: HASH_A,
		predecessors: [],
	});
}


function changesRequestedApproval() {
	const markdown = Buffer.from("# Plan\n", "utf8");
	return createApprovalResponse({
		candidate: candidate(),
		approval_status: "changes-requested",
		approval_actor: "reviewer",
		submitted_at: "2026-08-03T00:00:00Z",
		approved_at: null,
		feedback: [
			{
				feedback_id: "feedback-dossier",
				kind: "proposal",
				target: { target_type: "dossier" },
				requested_change: "Add an explicit decision summary.",
				rationale: "The overall approval basis needs a concise summary.",
				evidence_ids: [],
			},
			{
				feedback_id: "feedback-markdown",
				kind: "edit",
				target: { target_type: "markdown-path", markdown_path: "docs/plan.md" },
				requested_change: "Clarify the acceptance criteria.",
				rationale: "The published plan must remain actionable.",
				evidence_ids: ["evidence-a", "evidence-b"],
			},
			{
				feedback_id: "feedback-semantic",
				kind: "edit",
				target: { target_type: "semantic-id", semantic_id: "decision-1" },
				requested_change: "Record the chosen option.",
				rationale: "The stable decision needs an explicit disposition.",
				evidence_ids: ["evidence-c"],
			},
		],
		files: [{ path: "docs/plan.md", bytes: markdown }],
	});
}

describe("approval dossier contracts", () => {
	test("rejects unknown closed-schema fields", () => {
		const value = { ...candidate(), unexpected: true };
		const parsed = parseCandidateBinding(value);
		expect(parsed.ok).toBeFalse();
		if (!parsed.ok) expect(parsed.issues[0]).toEqual({ code: "UNKNOWN_FIELD", path: "$.candidate.unexpected" });
	});

	test("accepts sorted bounded edit and proposal feedback across closed targets", () => {
		const parsed = parseApprovalResponse(changesRequestedApproval());
		expect(parsed.ok).toBeTrue();
		if (parsed.ok) {
			expect(parsed.value.feedback.map(feedback => feedback.kind)).toEqual(["proposal", "edit", "edit"]);
			expect(parsed.value.feedback.map(feedback => feedback.target.target_type)).toEqual([
				"dossier",
				"markdown-path",
				"semantic-id",
			]);
		}
	});

	test("rejects feedback unknown fields and duplicate or unsorted stable IDs", () => {
		const approval = changesRequestedApproval();
		const [first, ...remaining] = approval.feedback;
		if (!first) throw new Error("feedback fixture must contain one item");
		const unknown = parseApprovalResponse({
			...approval,
			feedback: [{ ...first, unexpected: true }, ...remaining],
		});
		expect(unknown.ok).toBeFalse();
		const duplicate = parseApprovalResponse({ ...approval, feedback: [{ ...first }, { ...first }] });
		expect(duplicate.ok).toBeFalse();
		const unsorted = parseApprovalResponse({ ...approval, feedback: [...approval.feedback].reverse() });
		expect(unsorted.ok).toBeFalse();
	});

	test("rejects empty or oversized feedback content and unordered evidence IDs", () => {
		const approval = changesRequestedApproval();
		const [first, ...remaining] = approval.feedback;
		if (!first) throw new Error("feedback fixture must contain one item");
		expect(
			parseApprovalResponse({ ...approval, feedback: [{ ...first, requested_change: " " }, ...remaining] }).ok,
		).toBeFalse();
		expect(
			parseApprovalResponse({ ...approval, feedback: [{ ...first, rationale: "x".repeat(4_097) }, ...remaining] })
				.ok,
		).toBeFalse();
		expect(
			parseApprovalResponse({
				...approval,
				feedback: [{ ...first, evidence_ids: ["evidence-b", "evidence-a"] }, ...remaining],
			}).ok,
		).toBeFalse();
		expect(
			parseApprovalResponse({
				...approval,
				feedback: [{ ...first, evidence_ids: ["evidence-a", "evidence-a"] }, ...remaining],
			}).ok,
		).toBeFalse();
	});

	test("rejects invalid feedback target discriminants and escaped Markdown paths", () => {
		const approval = changesRequestedApproval();
		const [first, ...remaining] = approval.feedback;
		if (!first) throw new Error("feedback fixture must contain one item");
		const invalidTarget = parseApprovalResponse({
			...approval,
			feedback: [{ ...first, target: { target_type: "unknown" } }, ...remaining],
		});
		expect(invalidTarget.ok).toBeFalse();
		const escapedPath = parseApprovalResponse({
			...approval,
			feedback: [{ ...first, target: { target_type: "markdown-path", markdown_path: "../plan.md" } }, ...remaining],
		});
		expect(escapedPath.ok).toBeFalse();
	});

	test("enforces feedback status invariants", () => {
		const approval = changesRequestedApproval();
		expect(parseApprovalResponse({ ...approval, feedback: [] }).ok).toBeFalse();
		expect(
			parseApprovalResponse({
				...approval,
				approval_status: "approved",
				approved_at: "2026-08-03T00:01:00Z",
				declaration: APPROVAL_DECLARATION,
			}).ok,
		).toBeFalse();
	});

	test("uses only path and sha256 in path-sorted bundle bindings", () => {
		const first = {
			schema: MARKDOWN_FILE_SCHEMA,
			path: "a.md",
			sha256: hashRawBytes(Buffer.from("a")),
			byte_count: 1,
			media_type: MARKDOWN_MEDIA_TYPE,
		};
		const second = {
			schema: MARKDOWN_FILE_SCHEMA,
			path: "z.md",
			sha256: hashRawBytes(Buffer.from("different bytes")),
			byte_count: 15,
			media_type: MARKDOWN_MEDIA_TYPE,
		};
		const expected = hashCanonicalJson([
			{ path: "a.md", sha256: first.sha256 },
			{ path: "z.md", sha256: second.sha256 },
		]);
		expect(bundleSha256([first, second])).toBe(expected);
		expect(() => bundleSha256([second, first])).toThrow();
	});

	test("rejects a bundle hash that includes noncanonical file metadata", () => {
		const file = createMarkdownFileRecord("docs/plan.md", Buffer.from("# Plan\n"));
		const invalid = {
			schema: BUNDLE_BINDING_SCHEMA,
			files: [file],
			bundle_sha256: hashCanonicalJson([file]),
		};
		expect(bundleSha256([file])).not.toBe(invalid.bundle_sha256);
	});


	test("accepts only canonical blind baseline panels and trigger-bound specialists", () => {
		const assignments = validateSubstantiveReviewAssignments([
			...BASELINE_SUBSTANTIVE_REVIEW_ROLES.map(role => ({ role, blind: true as const, specialist_trigger: null })),
			{
				role: "accessibility",
				blind: true as const,
				specialist_trigger: {
					trigger_id: "trigger-a11y",
					evidence: "Keyboard-only operation is a stated acceptance criterion.",
				},
			},
		]);
		expect(assignments).toHaveLength(5);
		expect(() =>
			validateSubstantiveReviewAssignments([
				...BASELINE_SUBSTANTIVE_REVIEW_ROLES.map(role => ({
					role,
					blind: true as const,
					specialist_trigger: null,
				})),
				{
					role: "accessibility",
					blind: false,
					specialist_trigger: {
						trigger_id: "trigger-a11y",
						evidence: "Keyboard-only operation is a stated acceptance criterion.",
					},
				},
			]),
		).toThrow();
	});

	test("rejects unbound or open specialist assignment records", () => {
		expect(() =>
			validateSubstantiveReviewAssignment({
				role: "accessibility",
				blind: true,
				specialist_trigger: { trigger_id: "trigger-a11y", evidence: " ", unexpected: true },
			}),
		).toThrow("UNKNOWN_FIELD:$.review_assignment.specialist_trigger.unexpected");
		expect(() =>
			validateSubstantiveReviewAssignment({
				role: "accessibility",
				blind: true,
				specialist_trigger: { trigger_id: "trigger-a11y", evidence: " " },
			}),
		).toThrow("INVALID_VALUE:$.review_assignment.specialist_trigger.evidence");
		expect(() =>
			validateSubstantiveReviewAssignment({
				role: "correctness",
				blind: true,
				specialist_trigger: { trigger_id: "trigger-a11y", evidence: "Bounded evidence." },
			}),
		).toThrow("INVARIANT:$.review_assignment.specialist_trigger");
	});

	test("uses identical repository-relative path rules for contracts and publishing", () => {
		for (const path of ["", ".", "docs/./plan.md", "docs/../plan.md", "docs//plan.md", "../plan.md"]) {
			expect(() => validateRepositoryRelativePath(path)).toThrow();
			expect(() => normalizeRepositoryRelativePath(path)).toThrow("PATH_ESCAPE");
		}
		expect(validateRepositoryRelativePath("docs/a..b.md")).toBe("docs/a..b.md");
		expect(normalizeRepositoryRelativePath("docs/a..b.md")).toBe("docs/a..b.md");
	});

	test("rejects legacy receipt review fields", () => {
		const source = candidate();
		const parsed = parsePublicationReceipt({
			schema: "approval-dossier/publication-receipt/v1",
			receipt_sha256: HASH_A,
			receipt_path: "receipts/plan.json",
			candidate_sha256: HASH_A,
			candidate_subject_sha256: HASH_B,
			approved_html_sha256: HASH_B,
			workflow: source.workflow,
			run_id: source.run_id,
			revision: source.revision,
			semantic_sha256: source.semantic_sha256,
			bundle_sha256: source.bundle_sha256,
			files: source.files.map(({ path, sha256, byte_count, media_type }) => ({
				path,
				sha256,
				byte_count,
				media_type,
			})),
			substantive_review_authority: {
				schema: "approval-dossier/authority-file-binding/v1",
				path: "reviews/substantive.json",
				sha256: HASH_A,
			},
			review_hashes: [HASH_A, HASH_B],
			final_paths: source.final_paths,
		});
		expect(parsed.ok).toBeFalse();
		if (!parsed.ok) expect(parsed.issues[0]).toEqual({ code: "UNKNOWN_FIELD", path: "$.receipt.review_hashes" });
	});

	test("exposes the candidate schema constant for adapter contracts", () => {
		expect(candidate().schema).toBe(CANDIDATE_SCHEMA);
	});
});
