import {
	type AuthorityFileBinding,
	assertSubstantiveReviewAuthorityPassForSubject,
	AUTHORITY_FILE_BINDING_SCHEMA,
	bundleSha256,
	MARKDOWN_FILE_SCHEMA,
	MARKDOWN_MEDIA_TYPE,
	type MarkdownFileRecord,
	PUBLICATION_RECEIPT_SCHEMA,
	type PublicationReceipt,
	publicationReceiptBytes,
	publicationReceiptSha256,
	validateAuthorityFileBinding,
	validatePublicationReceipt,
} from "../schemas/approval-dossier.ts";
import { normalizeRepositoryRelativePath } from "./approval-dossier-publisher.ts";
import { AuthorityFileError, readAuthorityFile } from "./authority-files.ts";
import { hashRawBytes } from "./canonical-json.ts";
import { reopenSubstantiveReviewAuthority } from "./review-authority-files.ts";

export const APPROVED_MARKDOWN_PROJECTION_SCHEMA = "approval-dossier/approved-markdown-projection/v1" as const;

export type ApprovedMarkdownPreflightErrorCode =
	| "PATH_ESCAPE"
	| "NOT_MARKDOWN"
	| "MISSING_RECEIPT"
	| "IO_FAILURE"
	| "INVALID_RECEIPT"
	| "RECEIPT_PATH_MISMATCH"
	| "INVALID_SUBSTANTIVE_REVIEW"
	| "BUNDLE_MISMATCH"
	| "MARKDOWN_NOT_RECEIPTED"
	| "MARKDOWN_NOT_UTF8"
	| "MARKDOWN_BYTE_COUNT_MISMATCH"
	| "MARKDOWN_SHA256_MISMATCH"
	| "EXPECTED_MISMATCH";

/** A stable, fail-closed error that names the untrusted authority location. */
export class ApprovedMarkdownPreflightError extends Error {
	readonly code: ApprovedMarkdownPreflightErrorCode;
	readonly path: string;

	constructor(code: ApprovedMarkdownPreflightErrorCode, path: string) {
		super(`${code}:${path}`);
		this.name = "ApprovedMarkdownPreflightError";
		this.code = code;
		this.path = path;
	}
}

/** Trusted current handoff provenance is mandatory; no receipt field is self-expected. */
export interface ApprovedMarkdownExpected {
	readonly markdown_path: string;
	readonly receipt_path: string;
	readonly workflow: string;
	readonly run_id: string;
	readonly revision: number;
	readonly receipt_sha256: string;
	readonly candidate_sha256: string;
	readonly candidate_subject_sha256: string;
	readonly semantic_sha256: string;
	readonly bundle_sha256: string;
	readonly approved_html_sha256: string;
	readonly substantive_review_authority: AuthorityFileBinding;
}

export interface ApprovedMarkdownProvenance extends ApprovedMarkdownExpected {
	readonly schema: typeof APPROVED_MARKDOWN_PROJECTION_SCHEMA;
	readonly markdown_sha256: string;
	readonly markdown_byte_count: number;
}

export interface ApprovedMarkdownProjection extends ApprovedMarkdownProvenance {
	readonly markdown_text: string;
}

export interface ApprovedMarkdownPreflightInput {
	readonly repository_root: string;
	readonly markdown_path: string;
	readonly receipt_path: string;
	readonly expected: ApprovedMarkdownExpected;
}

/**
 * Admits only exact published Markdown backed by trusted current provenance,
 * a path-bound canonical receipt, and reopened substantive PASS authority.
 * Raw HTML is never opened.
 */
export async function verifyApprovedMarkdownProjection(
	input: ApprovedMarkdownPreflightInput,
): Promise<ApprovedMarkdownProjection> {
	const root = input.repository_root;
	const markdownPath = normalizedPath(input.markdown_path);
	const receiptPath = normalizedPath(input.receipt_path);
	if (!markdownPath.endsWith(".md")) throw new ApprovedMarkdownPreflightError("NOT_MARKDOWN", input.markdown_path);
	const expected = parseApprovedMarkdownExpected(input.expected);
	if (expected.markdown_path !== markdownPath)
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected.markdown_path");
	if (expected.receipt_path !== receiptPath)
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected.receipt_path");

	const receiptBytes = await readRegularFile(root, receiptPath, "MISSING_RECEIPT");
	const receipt = parseCanonicalReceipt(receiptBytes, receiptPath);
	if (receipt.receipt_path !== receiptPath)
		throw new ApprovedMarkdownPreflightError("RECEIPT_PATH_MISMATCH", receiptPath);

	const provenanceWithoutMarkdown = Object.freeze({
		markdown_path: markdownPath,
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
	});
	assertExpected(provenanceWithoutMarkdown, expected);

	try {
		const authority = await reopenSubstantiveReviewAuthority(root, receipt.substantive_review_authority);
		assertSubstantiveReviewAuthorityPassForSubject(authority, receipt);
	} catch {
		throw new ApprovedMarkdownPreflightError("INVALID_SUBSTANTIVE_REVIEW", receipt.substantive_review_authority.path);
	}

	const bundleFiles: MarkdownFileRecord[] = receipt.files.map(file => ({
		schema: MARKDOWN_FILE_SCHEMA,
		path: file.path,
		sha256: file.sha256,
		byte_count: file.byte_count,
		media_type: file.media_type,
	}));
	if (bundleSha256(bundleFiles) !== receipt.bundle_sha256)
		throw new ApprovedMarkdownPreflightError("BUNDLE_MISMATCH", receiptPath);

	const receiptFile = receipt.files.find(file => file.path === markdownPath);
	const finalPathCount = receipt.final_paths.filter(path => path === markdownPath).length;
	if (!receiptFile || finalPathCount !== 1)
		throw new ApprovedMarkdownPreflightError("MARKDOWN_NOT_RECEIPTED", markdownPath);

	const markdownBytes = await readRegularFile(root, markdownPath, "IO_FAILURE");
	if (markdownBytes.byteLength !== receiptFile.byte_count)
		throw new ApprovedMarkdownPreflightError("MARKDOWN_BYTE_COUNT_MISMATCH", markdownPath);
	const markdownSha256 = hashRawBytes(markdownBytes);
	if (markdownSha256 !== receiptFile.sha256)
		throw new ApprovedMarkdownPreflightError("MARKDOWN_SHA256_MISMATCH", markdownPath);
	const markdownText = decodeExactUtf8(markdownBytes, markdownPath);

	return Object.freeze({
		schema: APPROVED_MARKDOWN_PROJECTION_SCHEMA,
		...provenanceWithoutMarkdown,
		markdown_sha256: markdownSha256,
		markdown_byte_count: markdownBytes.byteLength,
		markdown_text: markdownText,
	});
}

/** Parses the complete closed provenance boundary supplied by a workflow handoff. */
export function parseApprovedMarkdownExpected(input: unknown): ApprovedMarkdownExpected {
	const expected = expectedRecord(input);
	const markdownPath = expectedPath(expected.markdown_path, "expected.markdown_path");
	if (!markdownPath.endsWith(".md"))
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected.markdown_path");
	const receiptPath = expectedPath(expected.receipt_path, "expected.receipt_path");
	const substantiveReviewAuthority = expectedBinding(expected.substantive_review_authority, "expected.substantive_review_authority");
	const receiptSha256 = expectedBinding({ schema: AUTHORITY_FILE_BINDING_SCHEMA, path: "expected.receipt", sha256: expected.receipt_sha256 }, "expected.receipt_sha256").sha256;
	try {
		const receiptBody = {
			schema: PUBLICATION_RECEIPT_SCHEMA,
			receipt_path: receiptPath,
			candidate_sha256: expected.candidate_sha256,
			candidate_subject_sha256: expected.candidate_subject_sha256,
			approved_html_sha256: expected.approved_html_sha256,
			workflow: expected.workflow,
			run_id: expected.run_id,
			revision: expected.revision,
			semantic_sha256: expected.semantic_sha256,
			bundle_sha256: expected.bundle_sha256,
			files: [{ path: markdownPath, sha256: expected.candidate_sha256, byte_count: 0, media_type: MARKDOWN_MEDIA_TYPE }],
			substantive_review_authority: substantiveReviewAuthority,
			final_paths: [markdownPath],
		};
		const validated = validatePublicationReceipt({
			...receiptBody,
			receipt_sha256: publicationReceiptSha256(receiptBody as Omit<PublicationReceipt, "receipt_sha256">),
		});
		return Object.freeze({
			markdown_path: markdownPath,
			receipt_path: validated.receipt_path,
			workflow: validated.workflow,
			run_id: validated.run_id,
			revision: validated.revision,
			receipt_sha256: receiptSha256,
			candidate_sha256: validated.candidate_sha256,
			candidate_subject_sha256: validated.candidate_subject_sha256,
			semantic_sha256: validated.semantic_sha256,
			bundle_sha256: validated.bundle_sha256,
			approved_html_sha256: validated.approved_html_sha256,
			substantive_review_authority: validated.substantive_review_authority,
		});
	} catch (error) {
		if (error instanceof ApprovedMarkdownPreflightError) throw error;
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected");
	}
}

function expectedRecord(input: unknown): Record<string, unknown> {
	const fields = [
		"markdown_path", "receipt_path", "workflow", "run_id", "revision", "receipt_sha256", "candidate_sha256",
		"candidate_subject_sha256", "semantic_sha256", "bundle_sha256", "approved_html_sha256",
		"substantive_review_authority",
	] as const;
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected");
	const record = input as Record<string, unknown>;
	if (Reflect.ownKeys(record).length !== fields.length)
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected");
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(record, field);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected");
	}
	return record;
}

function expectedPath(value: unknown, field: string): string {
	if (typeof value !== "string") throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", field);
	const normalized = normalizedExpectedPath(value, field);
	if (normalized !== value) throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", field);
	return normalized;
}

function expectedBinding(value: unknown, field: string): AuthorityFileBinding {
	try {
		return validateAuthorityFileBinding(value);
	} catch {
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", field);
	}
}


function normalizedPath(path: string): string {
	try {
		return normalizeRepositoryRelativePath(path);
	} catch {
		throw new ApprovedMarkdownPreflightError("PATH_ESCAPE", path || ".");
	}
}

function normalizedExpectedPath(path: string, field: string): string {
	try {
		return normalizeRepositoryRelativePath(path);
	} catch {
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", field);
	}
}

async function readRegularFile(
	root: string,
	path: string,
	missingCode: "MISSING_RECEIPT" | "IO_FAILURE",
): Promise<Uint8Array> {
	try {
		return await readAuthorityFile(root, path);
	} catch (error) {
		if (error instanceof AuthorityFileError) {
			if (
				(error.path === "." && error.code !== "IO_FAILURE") ||
				error.code === "PATH_ESCAPE" ||
				error.code === "NOT_REGULAR"
			)
				throw new ApprovedMarkdownPreflightError("PATH_ESCAPE", path);
			if (error.code === "NOT_FOUND" && missingCode === "MISSING_RECEIPT")
				throw new ApprovedMarkdownPreflightError("MISSING_RECEIPT", path);
		}
		throw new ApprovedMarkdownPreflightError("IO_FAILURE", path);
	}
}

function parseCanonicalReceipt(bytes: Uint8Array, path: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeExactUtf8(bytes, path));
	} catch (error) {
		if (error instanceof ApprovedMarkdownPreflightError) throw error;
		throw new ApprovedMarkdownPreflightError("INVALID_RECEIPT", path);
	}
	try {
		const receipt = validatePublicationReceipt(parsed);
		if (Buffer.compare(Buffer.from(publicationReceiptBytes(receipt)), Buffer.from(bytes)) !== 0)
			throw new ApprovedMarkdownPreflightError("INVALID_RECEIPT", path);
		return receipt;
	} catch (error) {
		if (error instanceof ApprovedMarkdownPreflightError) throw error;
		throw new ApprovedMarkdownPreflightError("INVALID_RECEIPT", path);
	}
}

function decodeExactUtf8(bytes: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ApprovedMarkdownPreflightError("MARKDOWN_NOT_UTF8", path);
	}
}

function assertExpected(provenance: ApprovedMarkdownExpected, expected: ApprovedMarkdownExpected): void {
	if (!expected.substantive_review_authority)
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected");
	const scalarKeys = [
		"markdown_path",
		"receipt_path",
		"workflow",
		"run_id",
		"revision",
		"receipt_sha256",
		"candidate_sha256",
		"candidate_subject_sha256",
		"semantic_sha256",
		"bundle_sha256",
		"approved_html_sha256",
	] as const;
	for (const key of scalarKeys) {
		if (expected[key] !== provenance[key])
			throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", `expected.${key}`);
	}
	if (!sameBinding(expected.substantive_review_authority, provenance.substantive_review_authority))
		throw new ApprovedMarkdownPreflightError("EXPECTED_MISMATCH", "expected.substantive_review_authority");
}

function sameBinding(left: AuthorityFileBinding, right: AuthorityFileBinding): boolean {
	return left.schema === right.schema && left.path === right.path && left.sha256 === right.sha256;
}
