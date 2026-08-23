import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AuthorityFileBinding,
	assertSubstantiveReviewAuthorityPass,
	type CandidateBinding,
	candidateReviewSubjectSha256,
	candidateSha256,
	PUBLICATION_RECEIPT_SCHEMA,
	type PublicationOutcome,
	type PublicationReceipt,
	publicationReceiptBytes,
	publicationReceiptSha256,
	validateCandidateBinding,
	validatePublicationReceipt,
	validateRepositoryRelativePath,
} from "../schemas/approval-dossier.ts";
import {
	assertCandidateContext,
	type CandidateVerificationContext,
	type ImportedHtmlVerification,
	verifyApprovedImportedHtml,
} from "./approval-dossier-verifier.ts";
import { reopenSubstantiveReviewAuthority } from "./review-authority-files.ts";

export type PublicationErrorCode =
	| "PATH_ESCAPE"
	| "DESTINATION_COLLISION"
	| "DESTINATION_NOT_REGULAR"
	| "SUBSTANTIVE_REVIEW_INVALID"
	| "CANDIDATE_MISMATCH"
	| "IO_FAILURE";

export class ApprovalDossierPublicationError extends Error {
	readonly code: PublicationErrorCode;
	readonly path: string;

	constructor(code: PublicationErrorCode, path: string) {
		super(`${code}:${path}`);
		this.name = "ApprovalDossierPublicationError";
		this.code = code;
		this.path = path;
	}
}

export interface PublicationInput {
	readonly repository_root: string;
	/** Repository-relative immutable location for canonical receipt bytes. */
	readonly receipt_path: string;
	/** Exact saved HTML bytes; publisher re-verifies rather than trusting a summary. */
	readonly approved_html: string | Uint8Array;
	readonly candidate: CandidateBinding;
	/** Exact immutable repository evidence; raw or hash-only review input is not accepted. */
	readonly substantive_review_authority: AuthorityFileBinding;
	/** Exact canonical candidate HTML and its independently bound runtime authority. */
	readonly context: CandidateVerificationContext;
}

export interface PublicationResult {
	readonly imported: ImportedHtmlVerification;
	readonly receipt: PublicationReceipt;
	readonly receipt_bytes: Uint8Array;
	readonly outcomes: readonly PublicationOutcome[];
	readonly receipt_outcome: PublicationOutcome;
}

/**
 * Re-verifies saved approval HTML and current substantive PASS authority, then
 * installs only protected Markdown bytes. Existing byte-identical files are
 * adopted; any different byte sequence blocks publication without overwrite.
 */
export async function publishApprovedMarkdown(input: PublicationInput): Promise<PublicationResult> {
	const candidate = validateCandidateBinding(input.candidate);
	const receiptPath = normalizeRepositoryRelativePath(input.receipt_path);
	try {
		const substantiveReviewAuthority = await reopenSubstantiveReviewAuthority(
			input.repository_root,
			input.substantive_review_authority,
		);
		assertSubstantiveReviewAuthorityPass(
			substantiveReviewAuthority,
			candidate,
			input.substantive_review_authority.sha256,
		);
	} catch {
		throw new ApprovalDossierPublicationError(
			"SUBSTANTIVE_REVIEW_INVALID",
			input.substantive_review_authority?.path ?? "substantive_review_authority",
		);
	}
	const context = input.context;
	assertCandidateContext(candidate, context);
	const imported = verifyApprovedImportedHtml(input.approved_html, candidate, context);

	const root = await validatedRepositoryRoot(input.repository_root);
	try {
		const markdownByPath = new Map(imported.markdown_files.map(file => [file.path, file.bytes]));
		const targets = candidate.files.map(file => {
			const bytes = markdownByPath.get(file.path);
			if (!bytes || bytes.byteLength !== file.byte_count)
				throw new ApprovalDossierPublicationError("CANDIDATE_MISMATCH", file.path);
			return { path: file.path, bytes };
		});
		assertUniqueTargets([...targets.map(target => target.path), receiptPath]);

		const receiptBody = {
			schema: PUBLICATION_RECEIPT_SCHEMA,
			receipt_path: receiptPath,
			candidate_sha256: candidateSha256(candidate),
			candidate_subject_sha256: candidateReviewSubjectSha256(candidate),
			approved_html_sha256: imported.document_sha256,
			workflow: candidate.workflow,
			run_id: candidate.run_id,
			revision: candidate.revision,
			semantic_sha256: candidate.semantic_sha256,
			bundle_sha256: candidate.bundle_sha256,
			files: candidate.files.map(file => ({
				path: file.path,
				sha256: file.sha256,
				byte_count: file.byte_count,
				media_type: file.media_type,
			})),
			substantive_review_authority: input.substantive_review_authority,
			final_paths: [...candidate.final_paths],
		};
		const receipt = validatePublicationReceipt({
			...receiptBody,
			receipt_sha256: publicationReceiptSha256(receiptBody),
		});
		const receiptBytes = publicationReceiptBytes(receipt);
		const allTargets = [...targets, { path: receiptPath, bytes: receiptBytes }];

		// Preflight is advisory only: every later operation reopens from the held root descriptor.
		await Promise.all(allTargets.map(target => inspectDestination(root, target.path, target.bytes)));
		const outcomes: PublicationOutcome[] = [];
		for (const target of targets) outcomes.push(await installNoClobber(root, target.path, target.bytes));
		const receiptOutcome = await installNoClobber(root, receiptPath, receiptBytes);
		return Object.freeze({
			imported,
			receipt,
			receipt_bytes: Uint8Array.from(receiptBytes),
			outcomes: Object.freeze(outcomes),
			receipt_outcome: receiptOutcome,
		});
	} finally {
		await root.close();
	}
}

/** Validates a repository-relative publication destination without touching disk. */
export function normalizeRepositoryRelativePath(path: string): string {
	try {
		return validateRepositoryRelativePath(path, "$.path");
	} catch {
		throw new ApprovalDossierPublicationError("PATH_ESCAPE", path || ".");
	}
}

async function validatedRepositoryRoot(root: string): Promise<FileHandle> {
	const rootPath = resolve(root);
	try {
		const stat = await lstat(rootPath);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ApprovalDossierPublicationError("PATH_ESCAPE", ".");
		const handle = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isDirectory()) {
			await handle.close();
			throw new ApprovalDossierPublicationError("PATH_ESCAPE", ".");
		}
		return handle;
	} catch (error) {
		if (error instanceof ApprovalDossierPublicationError) throw error;
		throw new ApprovalDossierPublicationError("PATH_ESCAPE", ".");
	}
}

async function inspectDestination(root: FileHandle, path: string, bytes: Uint8Array): Promise<PublicationOutcome> {
	const destination = await openParentDirectory(root, path);
	try {
		let file: FileHandle | undefined;
		try {
			file = await open(
				descriptorRelativePath(destination.parent, destination.leaf),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			const stat = await file.stat();
			if (!stat.isFile()) throw new ApprovalDossierPublicationError("DESTINATION_NOT_REGULAR", path);
			const existing = await file.readFile();
			if (Buffer.compare(existing, bytes) !== 0)
				throw new ApprovalDossierPublicationError("DESTINATION_COLLISION", path);
			return "adopted-identical";
		} catch (error) {
			if (error instanceof ApprovalDossierPublicationError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "created";
			if ((error as NodeJS.ErrnoException).code === "ELOOP")
				throw new ApprovalDossierPublicationError("DESTINATION_NOT_REGULAR", path);
			throw new ApprovalDossierPublicationError("IO_FAILURE", path);
		} finally {
			await file?.close();
		}
	} finally {
		await destination.parent.close();
	}
}

async function installNoClobber(root: FileHandle, path: string, bytes: Uint8Array): Promise<PublicationOutcome> {
	const destination = await openParentDirectory(root, path);
	try {
		let file: FileHandle | undefined;
		try {
			file = await open(
				descriptorRelativePath(destination.parent, destination.leaf),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o644,
			);
			await file.writeFile(bytes);
			return "created";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST")
				throw new ApprovalDossierPublicationError("IO_FAILURE", path);
			return inspectDestination(root, path, bytes);
		} finally {
			await file?.close();
		}
	} finally {
		await destination.parent.close();
	}
}

async function openParentDirectory(
	root: FileHandle,
	path: string,
): Promise<{ readonly parent: FileHandle; readonly leaf: string }> {
	const normalized = normalizeRepositoryRelativePath(path);
	const segments = normalized.split("/");
	let parent = await open(
		`/proc/self/fd/${root.fd}/.`,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		for (const segment of segments.slice(0, -1)) {
			const child = await openOrCreateDirectory(parent, segment, path);
			await parent.close();
			parent = child;
		}
		return Object.freeze({ parent, leaf: segments.at(-1)! });
	} catch (error) {
		await parent.close();
		throw error;
	}
}

async function openOrCreateDirectory(parent: FileHandle, segment: string, path: string): Promise<FileHandle> {
	const childPath = descriptorRelativePath(parent, segment);
	try {
		return await open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
			throw new ApprovalDossierPublicationError("PATH_ESCAPE", path);
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new ApprovalDossierPublicationError("IO_FAILURE", path);
	}
	try {
		await mkdir(childPath, { mode: 0o755 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST")
			throw new ApprovalDossierPublicationError("IO_FAILURE", path);
	}
	try {
		return await open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
			throw new ApprovalDossierPublicationError("PATH_ESCAPE", path);
		throw new ApprovalDossierPublicationError("IO_FAILURE", path);
	}
}

function descriptorRelativePath(parent: FileHandle, name: string): string {
	return `/proc/self/fd/${parent.fd}/${name}`;
}

function assertUniqueTargets(paths: readonly string[]): void {
	const seen = new Set<string>();
	for (const path of paths) {
		const normalized = normalizeRepositoryRelativePath(path);
		if (seen.has(normalized)) throw new ApprovalDossierPublicationError("PATH_ESCAPE", path);
		seen.add(normalized);
	}
}
