import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { validateRepositoryRelativePath } from "../schemas/approval-dossier.ts";

export type IdeationLineageLockOperation =
	| "slug-validation"
	| "open"
	| "spawn"
	| "unexpected-exit"
	| "close";

export class IdeationLineageLockError extends Error {
	readonly code = "IDEATION_LOCK_IO_FAILURE" as const;
	readonly slug: string;
	readonly path: string;
	readonly operation: IdeationLineageLockOperation;

	constructor(slug: string, path: string, operation: IdeationLineageLockOperation) {
		super(`IDEATION_LOCK_IO_FAILURE:${slug}:${path}:${operation}`);
		this.name = "IdeationLineageLockError";
		this.slug = slug;
		this.path = path;
		this.operation = operation;
	}
}

export async function withIdeationLineageLock<T>(repositoryRoot: string, slug: string, operation: () => Promise<T>): Promise<T> {
	const path = `ai_docs/ideation/.${slug}.lineage.lock`;
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
		throw new IdeationLineageLockError(slug, path, "slug-validation");
	let location: { readonly root: FileHandle; readonly parent: FileHandle; readonly leaf: string };
	try {
		location = await openAuthorityParent(repositoryRoot, path, true);
	} catch {
		throw new IdeationLineageLockError(slug, path, "open");
	}
	let handle: FileHandle | undefined;
	try {
		try {
			handle = await open(descriptorPath(location.parent, location.leaf), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
		} catch {
			throw new IdeationLineageLockError(slug, path, "open");
		}
		const lockStat = await handle.stat().catch(() => {
			throw new IdeationLineageLockError(slug, path, "open");
		});
		if (!lockStat.isFile() || lockStat.size !== 0)
			throw new IdeationLineageLockError(slug, path, "open");
		const exitCode = await new Promise<number>((resolveExit, reject) => {
			const child = spawn("/usr/bin/flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", handle!.fd] });
			child.once("error", error => reject(error));
			child.once("exit", code => resolveExit(code ?? -1));
		}).catch(() => {
			throw new IdeationLineageLockError(slug, path, "spawn");
		});
		if (exitCode === 1)
			throw Object.assign(new Error(`IDEATION_LINEAGE_LOCKED:${slug}:${path}`), {
				code: "IDEATION_LINEAGE_LOCKED" as const,
				slug,
				path,
				operation: "acquire" as const,
			});
		if (exitCode !== 0)
			throw new IdeationLineageLockError(slug, path, "unexpected-exit");
		return await operation();
	} finally {
		try {
			await handle?.close();
			await location.parent.close();
			await location.root.close();
		} catch {
			throw new IdeationLineageLockError(slug, path, "close");
		}
	}
}

/** Lists a descriptor-confined authority directory without following path components. */
export async function listAuthorityDirectory(repositoryRoot: string, path: string): Promise<readonly string[]> {
	const normalized = normalizedAuthorityPath(path);
	let location: { readonly root: FileHandle; readonly parent: FileHandle; readonly leaf: string };
	try {
		location = await openAuthorityParent(repositoryRoot, `${normalized}/.directory-listing`, false);
	} catch (error) {
		throw authorityError(error, normalized);
	}
	try {
		return Object.freeze(await readdir(descriptorPath(location.parent, ".")));
	} catch (error) {
		throw authorityError(error, normalized);
	} finally {
		await location.parent.close();
		await location.root.close();
	}
}

export type AuthorityFileErrorCode =
	| "PATH_ESCAPE"
	| "NOT_FOUND"
	| "NOT_REGULAR"
	| "DESTINATION_COLLISION"
	| "IO_FAILURE";

/** A fail-closed error for descriptor-relative authority-file operations. */
export class AuthorityFileError extends Error {
	readonly code: AuthorityFileErrorCode;
	readonly path: string;

	constructor(code: AuthorityFileErrorCode, path: string) {
		super(`${code}:${path}`);
		this.name = "AuthorityFileError";
		this.code = code;
		this.path = path;
	}
}

export type ImmutableAuthorityFileOutcome = "created" | "adopted-identical";

/**
 * Opens an existing regular authority file without resolving an untrusted path
 * outside a held repository-root descriptor chain.
 */
export async function readAuthorityFile(repositoryRoot: string, path: string): Promise<Uint8Array> {
	const location = await openAuthorityParent(repositoryRoot, path, false);
	try {
		let file: FileHandle | undefined;
		try {
			file = await open(descriptorPath(location.parent, location.leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
			const stat = await file.stat();
			if (!stat.isFile()) throw new AuthorityFileError("NOT_REGULAR", path);
			return Uint8Array.from(await file.readFile());
		} catch (error) {
			throw authorityError(error, path);
		} finally {
			await file?.close();
		}
	} finally {
		await location.parent.close();
		await location.root.close();
	}
}

/**
 * Atomically replaces an explicitly mutable repository-relative authority file.
 * Immutable candidate, review, and receipt records must use
 * installImmutableAuthorityFile instead.
 */
export async function writeAuthorityFile(
	repositoryRoot: string,
	path: string,
	bytes: Uint8Array,
	mode = 0o644,
): Promise<void> {
	if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
		throw new AuthorityFileError("IO_FAILURE", path);
	}
	const location = await openAuthorityParent(repositoryRoot, path, true);
	let temporary: string | undefined;
	try {
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const candidate = `.${location.leaf}.${randomUUID()}.tmp`;
			let file: FileHandle | undefined;
			try {
				file = await open(
					descriptorPath(location.parent, candidate),
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					mode,
				);
				temporary = candidate;
				await file.writeFile(bytes);
				await file.sync();
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw authorityError(error, path);
			} finally {
				await file?.close();
			}
		}
		if (!temporary) throw new AuthorityFileError("IO_FAILURE", path);
		try {
			await rename(descriptorPath(location.parent, temporary), descriptorPath(location.parent, location.leaf));
			temporary = undefined;
		} catch (error) {
			throw authorityError(error, path);
		}
	} finally {
		if (temporary) {
			try {
				// The temporary name was created exclusively under this held parent.
				await removeTemporary(location.parent, temporary);
			} catch {
				// Preserve the authority operation's original outcome.
			}
		}
		await location.parent.close();
		await location.root.close();
	}
}

/**
 * Installs immutable bytes under a held descriptor chain. The target becomes
 * visible only after a synced private temporary file is hard-linked into place,
 * so concurrent writers either adopt identical bytes or reject a conflict.
 */
export async function installImmutableAuthorityFile(
	repositoryRoot: string,
	path: string,
	bytes: Uint8Array,
	mode = 0o644,
): Promise<ImmutableAuthorityFileOutcome> {
	if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new AuthorityFileError("IO_FAILURE", path);
	const location = await openAuthorityParent(repositoryRoot, path, true);
	let temporary: string | undefined;
	try {
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const candidate = `.${location.leaf}.${randomUUID()}.tmp`;
			let file: FileHandle | undefined;
			try {
				file = await open(
					descriptorPath(location.parent, candidate),
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					mode,
				);
				temporary = candidate;
				await file.writeFile(bytes);
				await file.sync();
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw authorityError(error, path);
			} finally {
				await file?.close();
			}
		}
		if (!temporary) throw new AuthorityFileError("IO_FAILURE", path);
		try {
			await link(descriptorPath(location.parent, temporary), descriptorPath(location.parent, location.leaf));
			await removeTemporary(location.parent, temporary);
			temporary = undefined;
			return "created";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw authorityError(error, path);
			return await adoptIdenticalAuthorityFile(location.parent, location.leaf, path, bytes);
		}
	} finally {
		if (temporary) {
			try {
				await removeTemporary(location.parent, temporary);
			} catch {
				// Preserve the authority operation's original outcome.
			}
		}
		await location.parent.close();
		await location.root.close();
	}
}

async function openAuthorityParent(
	repositoryRoot: string,
	path: string,
	createParents: boolean,
): Promise<{ readonly root: FileHandle; readonly parent: FileHandle; readonly leaf: string }> {
	const normalized = normalizedAuthorityPath(path);
	const root = await openRepositoryRoot(repositoryRoot);
	let parent: FileHandle | undefined;
	try {
		parent = await open(descriptorPath(root, "."), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		for (const segment of normalized.split("/").slice(0, -1)) {
			const path = descriptorPath(parent, segment);
			let child: FileHandle;
			try {
				child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			} catch (error) {
				if (!createParents || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				try {
					await mkdir(path, { mode: 0o755 });
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
				child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			}
			await parent.close();
			parent = child;
		}
		return Object.freeze({ root, parent, leaf: normalized.split("/").at(-1)! });
	} catch (error) {
		await parent?.close();
		await root.close();
		throw authorityError(error, path);
	}
}

async function openRepositoryRoot(repositoryRoot: string): Promise<FileHandle> {
	try {
		const root = await open(
			resolve(repositoryRoot),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const stat = await root.stat();
		if (!stat.isDirectory()) {
			await root.close();
			throw new AuthorityFileError("PATH_ESCAPE", ".");
		}
		return root;
	} catch (error) {
		throw authorityError(error, ".");
	}
}

function normalizedAuthorityPath(path: string): string {
	try {
		return validateRepositoryRelativePath(path, "$.path");
	} catch {
		throw new AuthorityFileError("PATH_ESCAPE", path || ".");
	}
}

function descriptorPath(parent: FileHandle, name: string): string {
	return `/proc/self/fd/${parent.fd}/${name}`;
}

async function removeTemporary(parent: FileHandle, name: string): Promise<void> {
	await unlink(descriptorPath(parent, name));
}

async function adoptIdenticalAuthorityFile(
	parent: FileHandle,
	leaf: string,
	path: string,
	expected: Uint8Array,
): Promise<ImmutableAuthorityFileOutcome> {
	let file: FileHandle | undefined;
	try {
		file = await open(descriptorPath(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await file.stat();
		if (!stat.isFile()) throw new AuthorityFileError("NOT_REGULAR", path);
		const actual = await file.readFile();
		if (Buffer.compare(actual, expected) !== 0) throw new AuthorityFileError("DESTINATION_COLLISION", path);
		return "adopted-identical";
	} catch (error) {
		throw authorityError(error, path);
	} finally {
		await file?.close();
	}
}

function authorityError(error: unknown, path: string): AuthorityFileError {
	if (error instanceof AuthorityFileError) return error;
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ELOOP" || code === "ENOTDIR") return new AuthorityFileError("PATH_ESCAPE", path);
	if (code === "ENOENT") return new AuthorityFileError("NOT_FOUND", path);
	return new AuthorityFileError("IO_FAILURE", path);
}
