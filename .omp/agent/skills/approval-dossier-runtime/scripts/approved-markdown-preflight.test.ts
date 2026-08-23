import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASELINE_SUBSTANTIVE_REVIEW_ROLES,
	bundleSha256,
	MARKDOWN_MEDIA_TYPE,
	PUBLICATION_RECEIPT_SCHEMA,
	type PublicationReceipt,
	publicationReceiptBytes,
	publicationReceiptSha256,
	SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA,
	type SubstantiveReviewAuthority,
	validatePublicationReceipt,
} from "../schemas/approval-dossier.ts";
import {
	createMarkdownFileRecord,
	persistSubstantiveReviewAuthority,
} from "./approval-dossier-runtime.ts";
import {
	APPROVED_MARKDOWN_PROJECTION_SCHEMA,
	parseApprovedMarkdownExpected,
	type ApprovedMarkdownExpected,
	type ApprovedMarkdownPreflightError,
	verifyApprovedMarkdownProjection,
} from "./approved-markdown-preflight.ts";
import { canonicalJson, hashRawBytes } from "./canonical-json.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const RECEIPT_PATH = "receipts/scope.receipt.json";
const MARKDOWN_PATH = "ai_docs/scoping/plan.md";

type AuthorityMode = "pass" | "incomplete" | "block" | "unresolved" | "stale-candidate";

interface Fixture {
	readonly root: string;
	readonly receipt: PublicationReceipt;
	readonly expected: ApprovedMarkdownExpected;
}

function substantiveAuthority(mode: AuthorityMode): SubstantiveReviewAuthority {
	const coverage = ["candidate-binding", "requirements"];
	const assignments = BASELINE_SUBSTANTIVE_REVIEW_ROLES.map((role, index) => ({
		assignment_id: `assignment-${index + 1}`,
		role,
		reviewer_id: `reviewer-${index + 1}`,
		blind: true as const,
		specialist_trigger: null,
		required_coverage_ids: coverage,
	}));
	let results = assignments.map((assignment, index) => ({
		result_id: `result-${index + 1}`,
		result_sha256: hashRawBytes(Buffer.from(`result-${index + 1}`)),
		assignment_id: assignment.assignment_id,
		reviewer_id: assignment.reviewer_id,
		subject_sha256: HASH_D,
		verdict: "PASS" as "PASS" | "BLOCK" | "UNRESOLVED",
		covered_coverage_ids: coverage,
		occurrence_ids: [],
		completed_at: "2026-08-04T00:00:00Z",
	}));
	if (mode === "incomplete") results = results.slice(0, -1);
	if (mode === "block")
		results = results.map((result, index) => (index === 0 ? { ...result, verdict: "BLOCK" as const } : result));
	if (mode === "unresolved")
		results = results.map((result, index) => (index === 0 ? { ...result, verdict: "UNRESOLVED" as const } : result));
	return {
		schema: SUBSTANTIVE_REVIEW_AUTHORITY_SCHEMA,
		workflow: "deep-scope",
		run_id: "scope-1",
		revision: 1,
		subject_sha256: HASH_D,
		candidate_subject_sha256: mode === "stale-candidate" ? HASH_D : HASH_B,
		semantic_sha256: HASH_C,
		bundle_sha256: HASH_A,
		mandatory_coverage_ids: coverage,
		assignments,
		results,
		occurrences: [],
		derived_gate:
			mode === "incomplete"
				? "INCOMPLETE"
				: mode === "block"
					? "BLOCK"
					: mode === "unresolved"
						? "UNRESOLVED"
						: "PASS",
	};
}


async function writeFixture(
	options: Readonly<{
		authorityMode?: AuthorityMode;
		receiptPath?: string;
	}> = {},
): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "approved-markdown-preflight-"));
	const markdown = Buffer.from("# Plan\n", "utf8");
	await mkdir(join(root, MARKDOWN_PATH, ".."), { recursive: true });
	await writeFile(join(root, MARKDOWN_PATH), markdown);
	const record = createMarkdownFileRecord(MARKDOWN_PATH, markdown);
	const bundleHash = bundleSha256([record]);
	const authorityRecord = { ...substantiveAuthority(options.authorityMode ?? "pass"), bundle_sha256: bundleHash };
	const authority = await persistSubstantiveReviewAuthority(root, "reviews/substantive.json", authorityRecord);
	const receiptPath = options.receiptPath ?? RECEIPT_PATH;
	const body = {
		schema: PUBLICATION_RECEIPT_SCHEMA,
		receipt_path: receiptPath,
		candidate_sha256: HASH_A,
		candidate_subject_sha256: HASH_B,
		approved_html_sha256: HASH_D,
		workflow: "deep-scope",
		run_id: "scope-1",
		revision: 1,
		semantic_sha256: HASH_C,
		bundle_sha256: bundleHash,
		files: [
			{ path: record.path, sha256: record.sha256, byte_count: record.byte_count, media_type: MARKDOWN_MEDIA_TYPE },
		],
		substantive_review_authority: authority.binding,
		final_paths: [record.path],
	};
	const receipt = validatePublicationReceipt({ ...body, receipt_sha256: publicationReceiptSha256(body) });
	await mkdir(join(root, receiptPath, ".."), { recursive: true });
	await writeFile(join(root, receiptPath), publicationReceiptBytes(receipt));
	const expected: ApprovedMarkdownExpected = {
		markdown_path: MARKDOWN_PATH,
		receipt_path: receiptPath,
		workflow: receipt.workflow,
		run_id: receipt.run_id,
		revision: receipt.revision,
		receipt_sha256: receipt.receipt_sha256,
		candidate_sha256: receipt.candidate_sha256,
		candidate_subject_sha256: receipt.candidate_subject_sha256,
		semantic_sha256: receipt.semantic_sha256,
		bundle_sha256: receipt.bundle_sha256,
		approved_html_sha256: receipt.approved_html_sha256,
		substantive_review_authority: receipt.substantive_review_authority,
	};
	return { root, receipt, expected };
}

function expectPreflightFailure(
	promise: Promise<unknown>,
	code: ApprovedMarkdownPreflightError["code"],
	path: string,
): Promise<void> {
	return expect(promise).rejects.toMatchObject({ code, path });
}

describe("approved Markdown receipt preflight", () => {
	test("returns exact Markdown only after reopening current substantive PASS authority", async () => {
		const fixture = await writeFixture();
		try {
			expect(parseApprovedMarkdownExpected(fixture.expected)).toEqual(fixture.expected);
			expect(() => parseApprovedMarkdownExpected({ ...fixture.expected, unexpected: true })).toThrow("EXPECTED_MISMATCH:expected");
			expect(() => parseApprovedMarkdownExpected({ ...fixture.expected, post_approval_reviews: [] })).toThrow("EXPECTED_MISMATCH:expected");
			const projection = await verifyApprovedMarkdownProjection({
				repository_root: fixture.root,
				markdown_path: MARKDOWN_PATH,
				receipt_path: RECEIPT_PATH,
				expected: fixture.expected,
			});
			expect(projection.schema).toBe(APPROVED_MARKDOWN_PROJECTION_SCHEMA);
			expect(projection.markdown_text).toBe("# Plan\n");
			expect(projection.substantive_review_authority).toEqual(fixture.receipt.substantive_review_authority);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects absent trusted expected provenance and every stale expected identifier", async () => {
		const fixture = await writeFixture();
		try {
			await expectPreflightFailure(
				verifyApprovedMarkdownProjection({
					repository_root: fixture.root,
					markdown_path: MARKDOWN_PATH,
					receipt_path: RECEIPT_PATH,
				} as never),
				"EXPECTED_MISMATCH",
				"expected",
			);
			for (const [field, value] of [
				["receipt_path", "receipts/stale.json"],
				["revision", 2],
				["candidate_sha256", HASH_B],
				["approved_html_sha256", HASH_A],
				["semantic_sha256", HASH_A],
				["bundle_sha256", HASH_C],
			] as const) {
				await expectPreflightFailure(
					verifyApprovedMarkdownProjection({
						repository_root: fixture.root,
						markdown_path: MARKDOWN_PATH,
						receipt_path: RECEIPT_PATH,
						expected: { ...fixture.expected, [field]: value },
					}),
					"EXPECTED_MISMATCH",
					`expected.${field}`,
				);
			}
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects copied receipt bytes at a sibling repository path", async () => {
		const fixture = await writeFixture();
		const sibling = "receipts/copied.receipt.json";
		try {
			await writeFile(join(fixture.root, sibling), await readFile(join(fixture.root, RECEIPT_PATH)));
			await expectPreflightFailure(
				verifyApprovedMarkdownProjection({
					repository_root: fixture.root,
					markdown_path: MARKDOWN_PATH,
					receipt_path: sibling,
					expected: { ...fixture.expected, receipt_path: sibling },
				}),
				"RECEIPT_PATH_MISMATCH",
				sibling,
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});


	test("rejects non-PASS and stale substantive review authority", async () => {
		for (const authorityMode of ["incomplete", "block", "unresolved", "stale-candidate"] as const) {
			const fixture = await writeFixture({ authorityMode });
			try {
				await expectPreflightFailure(
					verifyApprovedMarkdownProjection({
						repository_root: fixture.root,
						markdown_path: MARKDOWN_PATH,
						receipt_path: RECEIPT_PATH,
						expected: fixture.expected,
					}),
					"INVALID_SUBSTANTIVE_REVIEW",
					fixture.receipt.substantive_review_authority.path,
				);
			} finally {
				await rm(fixture.root, { recursive: true, force: true });
			}
		}
	});

	test("rejects tampered Markdown and legacy extra-field receipts", async () => {
		const fixture = await writeFixture();
		try {
			await writeFile(join(fixture.root, MARKDOWN_PATH), "# Sham\n");
			await expectPreflightFailure(
				verifyApprovedMarkdownProjection({
					repository_root: fixture.root,
					markdown_path: MARKDOWN_PATH,
					receipt_path: RECEIPT_PATH,
					expected: fixture.expected,
				}),
				"MARKDOWN_SHA256_MISMATCH",
				MARKDOWN_PATH,
			);
			const legacyBody = {
				...Object.fromEntries(Object.entries(fixture.receipt).filter(([key]) => key !== "receipt_sha256")),
				review_hashes: [HASH_A, HASH_B],
			};
			await writeFile(
				join(fixture.root, RECEIPT_PATH),
				canonicalJson({ ...legacyBody, receipt_sha256: hashRawBytes(Buffer.from(canonicalJson(legacyBody))) }),
			);
			await expectPreflightFailure(
				verifyApprovedMarkdownProjection({
					repository_root: fixture.root,
					markdown_path: MARKDOWN_PATH,
					receipt_path: RECEIPT_PATH,
					expected: fixture.expected,
				}),
				"INVALID_RECEIPT",
				RECEIPT_PATH,
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
});
