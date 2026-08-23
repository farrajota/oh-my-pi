import {
	AUTHORITY_FILE_BINDING_SCHEMA,
	type AuthorityFileBinding,
	type SubstantiveReviewAuthority,
	substantiveReviewAuthorityBytes,
	substantiveReviewAuthoritySha256,
	validateAuthorityFileBinding,
	validateRepositoryRelativePath,
	validateSubstantiveReviewAuthority,
} from "../schemas/approval-dossier.ts";
import {
	AuthorityFileError,
	type ImmutableAuthorityFileOutcome,
	installImmutableAuthorityFile,
	readAuthorityFile,
} from "./authority-files.ts";
import { hashRawBytes } from "./canonical-json.ts";

export type ReviewAuthorityFileErrorCode =
	| "PATH_ESCAPE"
	| "NOT_FOUND"
	| "NOT_REGULAR"
	| "HASH_MISMATCH"
	| "NON_CANONICAL"
	| "INVALID_RECORD"
	| "DESTINATION_COLLISION"
	| "IO_FAILURE";

export class ReviewAuthorityFileError extends Error {
	readonly code: ReviewAuthorityFileErrorCode;
	readonly path: string;

	constructor(code: ReviewAuthorityFileErrorCode, path: string) {
		super(`${code}:${path}`);
		this.name = "ReviewAuthorityFileError";
		this.code = code;
		this.path = path;
	}
}

export interface PersistedReviewAuthority<T> {
	readonly binding: AuthorityFileBinding;
	readonly record: T;
	readonly outcome: ImmutableAuthorityFileOutcome;
}

/** Persists immutable canonical substantive-review authority and returns its exact path/hash binding. */
export async function persistSubstantiveReviewAuthority(
	repositoryRoot: string,
	path: string,
	input: SubstantiveReviewAuthority,
): Promise<PersistedReviewAuthority<SubstantiveReviewAuthority>> {
	const record = validateSubstantiveReviewAuthority(input);
	const normalizedPath = authorityPath(path);
	const bytes = substantiveReviewAuthorityBytes(record);
	const binding = validateAuthorityFileBinding({
		schema: AUTHORITY_FILE_BINDING_SCHEMA,
		path: normalizedPath,
		sha256: substantiveReviewAuthoritySha256(record),
	});
	try {
		const outcome = await installImmutableAuthorityFile(repositoryRoot, normalizedPath, bytes);
		return Object.freeze({ binding, record, outcome });
	} catch (error) {
		throw mappedAuthorityFileError(error, normalizedPath);
	}
}

/** Reopens, hash-checks, parses, and canonical-byte-checks substantive authority from repository evidence. */
export async function reopenSubstantiveReviewAuthority(
	repositoryRoot: string,
	bindingInput: AuthorityFileBinding,
): Promise<SubstantiveReviewAuthority> {
	const binding = validateAuthorityFileBinding(bindingInput);
	const bytes = await readBoundBytes(repositoryRoot, binding);
	let record: SubstantiveReviewAuthority;
	try {
		record = validateSubstantiveReviewAuthority(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	} catch {
		throw new ReviewAuthorityFileError("INVALID_RECORD", binding.path);
	}
	if (!sameBytes(bytes, substantiveReviewAuthorityBytes(record))) {
		throw new ReviewAuthorityFileError("NON_CANONICAL", binding.path);
	}
	return record;
}


async function readBoundBytes(repositoryRoot: string, binding: AuthorityFileBinding): Promise<Uint8Array> {
	let bytes: Uint8Array;
	try {
		bytes = await readAuthorityFile(repositoryRoot, binding.path);
	} catch (error) {
		throw mappedAuthorityFileError(error, binding.path);
	}
	if (hashRawBytes(bytes) !== binding.sha256) {
		throw new ReviewAuthorityFileError("HASH_MISMATCH", binding.path);
	}
	return bytes;
}

function authorityPath(path: string): string {
	try {
		return validateRepositoryRelativePath(path);
	} catch {
		throw new ReviewAuthorityFileError("PATH_ESCAPE", path || ".");
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function mappedAuthorityFileError(error: unknown, path: string): ReviewAuthorityFileError {
	if (error instanceof ReviewAuthorityFileError) return error;
	if (error instanceof AuthorityFileError) return new ReviewAuthorityFileError(error.code, error.path);
	return new ReviewAuthorityFileError("IO_FAILURE", path);
}
