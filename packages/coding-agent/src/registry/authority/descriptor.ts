import * as fs from "node:fs/promises";
import { durableFsync } from "./durable-sync";
import { hasPrivateMode } from "./private-mode";
import { fsyncDirectory } from "./directory-sync";
import * as path from "node:path";
import type { JournalingBackend } from "./types";
import {
	authorityPaths,
	canonicalAuthoritySession,
	manualAuthorityRecoveryRequired,
	readAuthoritySessionId,
} from "./ownership";
import type { AuthorityPaths, AuthorityPhysicalIdentity } from "./ownership";

export interface AuthorityDescriptor {
	readonly version: 1;
	readonly revision: number;
	readonly owningSessionId: string;
	readonly backend: JournalingBackend;
	readonly format: 2;
	readonly incarnation: string;
	readonly payload: string;
	readonly state: "initializing" | "active" | "migration";
	readonly physicalIdentity: AuthorityPhysicalIdentity;
	readonly migrationId?: string;
}

export async function readAuthorityDescriptor(sessionFile: string): Promise<AuthorityDescriptor | undefined> {
	const canonical = await canonicalAuthoritySession(sessionFile);
	const paths = authorityPaths(canonical);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(paths.descriptor, fs.constants.O_RDONLY | noFollow());
	} catch (error) {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	try {
		const stat = await handle.stat();
		// Every refusal below is a stopped store an operator must inspect by hand; none is repaired by a command.
		if (!stat.isFile() || !hasPrivateMode(stat.mode)) {
			throw manualAuthorityRecoveryRequired(
				canonical,
				`Authority descriptor must be a private regular file: ${paths.descriptor}`,
			);
		}
		const text = await handle.readFile("utf8");
		let descriptor: AuthorityDescriptor;
		try {
			descriptor = parseDescriptor(text, paths);
		} catch (error) {
			throw manualAuthorityRecoveryRequired(
				canonical,
				error instanceof Error ? error.message : String(error),
				error,
			);
		}
		const lockStat = await fs.lstat(paths.lock);
		if (
			!lockStat.isFile() ||
			descriptor.physicalIdentity.dev !== String(lockStat.dev) ||
			descriptor.physicalIdentity.ino !== String(lockStat.ino)
		) {
			throw manualAuthorityRecoveryRequired(
				canonical,
				`Authority descriptor physical identity does not match its lock anchor: ${paths.descriptor}`,
			);
		}
		if (descriptor.owningSessionId !== (await readAuthoritySessionId(canonical)))
			throw manualAuthorityRecoveryRequired(
				canonical,
				`Authority descriptor root UUID does not match transcript header: ${paths.descriptor}`,
			);
		return descriptor;
	} finally {
		await handle.close();
	}
}

export async function writeAuthorityDescriptor(sessionFile: string, descriptor: AuthorityDescriptor): Promise<void> {
	const canonical = await canonicalAuthoritySession(sessionFile);
	const paths = authorityPaths(canonical);
	validateDescriptor(descriptor, paths);
	const lockStat = await fs.lstat(paths.lock);
	if (
		!lockStat.isFile() ||
		descriptor.physicalIdentity.dev !== String(lockStat.dev) ||
		descriptor.physicalIdentity.ino !== String(lockStat.ino)
	) {
		throw new Error(`Authority descriptor physical identity does not match its lock anchor: ${paths.descriptor}`);
	}
	if (descriptor.owningSessionId !== (await readAuthoritySessionId(canonical)))
		throw new Error(`Authority descriptor root UUID does not match transcript header: ${paths.descriptor}`);
	const previous = await readAuthorityDescriptor(canonical);
	if (previous) {
		if (descriptor.revision <= previous.revision)
			throw new Error("Authority descriptor revision must increase monotonically");
		if (descriptor.owningSessionId !== previous.owningSessionId)
			throw new Error("Authority descriptor cannot change its owning session UUID");
		if (
			descriptor.physicalIdentity.dev !== previous.physicalIdentity.dev ||
			descriptor.physicalIdentity.ino !== previous.physicalIdentity.ino
		) {
			throw new Error("Authority descriptor cannot change its physical lock identity");
		}
	} else if (descriptor.revision !== 1 || descriptor.state !== "initializing") {
		throw new Error("First authority descriptor must be revision 1 in initializing state");
	}
	const temp = `${paths.descriptor}.tmp-${crypto.randomUUID()}`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(
			temp,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow(),
			0o600,
		);
		await handle.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
		await durableFsync(handle);
		await handle.close();
		handle = undefined;
		await fs.rename(temp, paths.descriptor);
		await fsyncDirectory(path.dirname(paths.descriptor));
	} catch (error) {
		if (handle) await handle.close();
		await fs.rm(temp, { force: true });
		throw error;
	}
}

function parseDescriptor(text: string, paths: AuthorityPaths): AuthorityDescriptor {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Authority descriptor is not valid JSON: ${paths.descriptor}`);
	}
	if (!isDescriptor(value)) throw new Error(`Authority descriptor has invalid fields: ${paths.descriptor}`);
	validateDescriptor(value, paths);
	return value;
}

function validateDescriptor(value: AuthorityDescriptor, paths: AuthorityPaths): void {
	if (!Number.isSafeInteger(value.revision) || value.revision < 1)
		throw new Error("Authority descriptor revision must be a positive safe integer");
	if (!value.owningSessionId || !value.incarnation)
		throw new Error("Authority descriptor must bind a root session UUID and store incarnation");
	if (value.format !== 2 || value.version !== 1)
		throw new Error("Unsupported authority descriptor version or payload format");
	const expectedPayload = value.backend === "sqlite" ? path.basename(paths.sqlite) : path.basename(paths.jsonl);
	if (value.payload !== expectedPayload || path.basename(value.payload) !== value.payload) {
		throw new Error("Authority descriptor payload must name the expected sibling store for its backend");
	}
	if (!value.physicalIdentity.dev || !value.physicalIdentity.ino)
		throw new Error("Authority descriptor is missing physical lock identity");
	if (value.state === "migration" && !value.migrationId)
		throw new Error("Migrating authority descriptor requires a migration ID");
	if (value.state !== "migration" && value.migrationId !== undefined)
		throw new Error("Non-migration authority descriptor cannot name a migration ID");
}

function isDescriptor(value: unknown): value is AuthorityDescriptor {
	if (typeof value !== "object" || value === null) return false;
	if (
		!("version" in value) ||
		!("revision" in value) ||
		!("owningSessionId" in value) ||
		!("backend" in value) ||
		!("format" in value) ||
		!("incarnation" in value) ||
		!("payload" in value) ||
		!("state" in value) ||
		!("physicalIdentity" in value)
	)
		return false;
	if (value.version !== 1 || value.format !== 2 || (value.backend !== "jsonl" && value.backend !== "sqlite"))
		return false;
	if (
		typeof value.revision !== "number" ||
		typeof value.owningSessionId !== "string" ||
		typeof value.incarnation !== "string" ||
		typeof value.payload !== "string"
	)
		return false;
	if (value.state !== "initializing" && value.state !== "active" && value.state !== "migration") return false;
	if (
		typeof value.physicalIdentity !== "object" ||
		value.physicalIdentity === null ||
		!("dev" in value.physicalIdentity) ||
		!("ino" in value.physicalIdentity)
	)
		return false;
	if (typeof value.physicalIdentity.dev !== "string" || typeof value.physicalIdentity.ino !== "string") return false;
	const expected = [
		"version",
		"revision",
		"owningSessionId",
		"backend",
		"format",
		"incarnation",
		"payload",
		"state",
		"physicalIdentity",
	];
	if ("migrationId" in value) expected.push("migrationId");
	return (
		Object.keys(value).sort().join("\0") === expected.sort().join("\0") &&
		(!("migrationId" in value) || typeof value.migrationId === "string")
	);
}

function isFsError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function noFollow(): number {
	return "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}
