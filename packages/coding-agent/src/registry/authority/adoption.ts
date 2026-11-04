import * as fs from "node:fs/promises";
import { durableFsync } from "./durable-sync";
import { hasPrivateMode } from "./private-mode";
import { directoryFsyncSupported } from "./directory-sync";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { repairSessionCommand, resumeCommand, sessionAuthorityCommand } from "../../utils/resume-command";
import { readAuthorityDescriptor } from "./descriptor";
import { isAuthorityRecoveryFileName } from "./jsonl-layout";
import {
	checkLegacyAuthorityUpgrade,
	legacyAuthorityJournalBusy,
	upgradeLegacyAuthorityUnderOwnership,
} from "./migration";
import {
	LEGACY_AUTHORITY_DENIAL_REASON,
	authorityPaths,
	canonicalAuthoritySession,
	readAuthoritySessionId,
	withAuthorityExclusive,
} from "./ownership";
import type { AuthorityExclusiveContext } from "./ownership";
import { openAuthorityPersistence } from "./persistence";
import type { AuthorityPersistence } from "./types";

/**
 * Resume-time adoption of sessions written before authority journaling (user decision 2026-11-03).
 *
 * A root without a committed descriptor is adopted only when its sibling evidence is fully understood:
 * nothing at all (bootstrap a fresh versioned JSONL store) or one clean legacy v1 journal (the offline
 * `--to jsonl --apply` conversion, run under the opener's ownership). Every other combination refuses
 * with the operator command that handles it; absence of a descriptor alone never proves a root is new.
 */

export type AuthorityAdoption =
	| { readonly kind: "bootstrapped"; readonly sessionFile: string; readonly backend: "jsonl" }
	| {
			readonly kind: "upgraded";
			readonly sessionFile: string;
			readonly backend: "jsonl";
			readonly backupDirectory: string;
	  };

/** Pre-journaling evidence that can be adopted; refusals are thrown as {@link AuthorityAdoptionRefusedError}. */
export type AdoptableAuthorityEvidence = "none" | "legacy";

export class AuthorityAdoptionRefusedError extends Error {
	constructor(
		message: string,
		readonly command: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "AuthorityAdoptionRefusedError";
	}
}

const LEGACY_REPAIR_BACKUP_PREFIX = ".authority-repair-";
const LEGACY_WRITER_PROBES = 10;
const LEGACY_WRITER_PROBE_INTERVAL_MS = 20;

function refuse(sessionFile: string, reason: string, command: string, cause?: unknown): AuthorityAdoptionRefusedError {
	return new AuthorityAdoptionRefusedError(
		`Cannot adopt pre-journaling session ${sessionFile}: ${reason}. Run: ${command}`,
		command,
		cause === undefined ? undefined : { cause },
	);
}

/**
 * Classifies every sibling artifact that proves or suggests prior authority for a root that has no
 * descriptor. Only a bare ownership anchor (empty private lock whose identity no artifact records)
 * and legacy-repair backups beside a present journal are tolerated as non-evidence.
 */
export async function classifyPreJournalingEvidence(canonical: string): Promise<AdoptableAuthorityEvidence> {
	const paths = authorityPaths(canonical);
	const parent = path.dirname(canonical);
	const base = path.basename(canonical);
	const entries = await fs.readdir(parent);
	// A tail recovery file is operator evidence of cut bytes, never evidence of prior authority.
	const names = entries
		.filter(
			name =>
				(name.startsWith(`${base}.authority`) || name.startsWith(`.${base}.authority`)) &&
				!isAuthorityRecoveryFileName(base, name),
		)
		.sort();
	const repairHistory = await legacyRepairBackups(parent, base, entries);
	const lockName = path.basename(paths.lock);
	const legacyName = path.basename(paths.legacy);
	const fenceName = path.basename(paths.legacyFence);
	const descriptorName = path.basename(paths.descriptor);
	const recover = sessionAuthorityCommand(canonical, "--recover finish");
	const diagnose = repairSessionCommand(canonical);
	const listed = names.join(", ");

	// Ordered by the most specific recovery that applies; the first match names the command.
	if (names.includes(descriptorName))
		throw refuse(canonical, "an authority descriptor appeared during classification", recover);
	// Sibling names cannot tell a pre-feature root from a transcript that left its bundle behind; the header can.
	const createdAt = await readAuthorityRootStamp(canonical);
	if (createdAt !== undefined && createdAt !== canonical) {
		throw refuse(
			canonical,
			`this transcript was created under authority journaling at ${createdAt}: it is a child agent transcript owned by that session, or a copy or move that left its authority bundle behind; adopting it would start an empty authority for work that root may still own. Resume ${createdAt}, move the session with its bundle (omp session pack/unpack), or start a new root from it with --fork`,
			resumeCommand(createdAt),
		);
	}
	if (names.some(name => name.startsWith(`${base}.authority.migration.`))) {
		throw refuse(
			canonical,
			`an authority migration is in progress (${listed}); --recover abort also works until the target is selected`,
			recover,
		);
	}
	if (
		names.some(
			name =>
				name.startsWith(`${base}.authority.stage.`) ||
				name.startsWith(`${base}.authority.restore.`) ||
				name.startsWith(`.${base}.authority`),
		)
	) {
		throw refuse(canonical, `an authority migration or lifecycle operation is incomplete (${listed})`, recover);
	}
	if (names.some(name => name.startsWith(`${descriptorName}.tmp-`))) {
		throw refuse(
			canonical,
			`an authority initialization was interrupted (${listed})`,
			sessionAuthorityCommand(canonical, "--recover abort"),
		);
	}
	const legacy = names.includes(legacyName);
	if (names.includes(fenceName)) {
		const marker = await readSmallPrivateFile(paths.legacyFence);
		if (marker === LEGACY_AUTHORITY_DENIAL_REASON) {
			throw refuse(
				canonical,
				"the legacy authority journal is permanently fenced but no versioned authority is selected",
				diagnose,
			);
		}
		throw refuse(
			canonical,
			`the legacy authority journal is quarantined (${(marker ?? "").trim() || "no reason recorded"})`,
			diagnose,
		);
	}
	if (names.some(name => name.startsWith(`${base}.authority.backup.`))) {
		if (legacy) {
			throw refuse(
				canonical,
				"an earlier legacy upgrade was aborted and left its backup",
				sessionAuthorityCommand(canonical, "--to jsonl --apply"),
			);
		}
		throw refuse(canonical, `authority backups exist without a selected authority (${listed})`, diagnose);
	}
	const unexplained = names.filter(name => name !== lockName && name !== legacyName);
	if (unexplained.length)
		throw refuse(
			canonical,
			`unrecognized authority artifacts exist without a descriptor (${unexplained.join(", ")})`,
			diagnose,
		);
	if (names.includes(lockName) && !(await isBareAnchor(paths.lock))) {
		throw refuse(canonical, "the authority lock anchor is not an empty private file", diagnose);
	}
	if (!legacy) {
		if (repairHistory.length)
			throw refuse(
				canonical,
				`legacy authority repair backups exist but the legacy journal is missing (${repairHistory.join(", ")})`,
				diagnose,
			);
		return "none";
	}
	// Read-only conversion preflight before any lock exists, so corrupt or blocked journals refuse unchanged.
	const transcript = await fs.stat(canonical);
	await preflightLegacyUpgrade({
		sessionFile: canonical,
		owningSessionId: await readAuthoritySessionId(canonical),
		paths,
		physicalIdentity: { dev: String(transcript.dev), ino: String(transcript.ino) },
	});
	return "legacy";
}

/**
 * Pre-ownership classification for an opener. A refusal seen without exclusion may be a concurrent
 * adopter's in-flight state; every writer creates the anchor before its first artifact and holds it
 * until done, so when an anchor exists the refusal is re-judged under exclusion (or reported as held
 * ownership). Without an anchor nothing is in flight and the refusal stands with no file created.
 */
export async function classifyPreJournalingEvidenceForOpen(
	canonical: string,
	owningSessionId: string,
): Promise<AdoptableAuthorityEvidence> {
	const paths = authorityPaths(canonical);
	try {
		const evidence = await classifyPreJournalingEvidence(canonical);
		if (evidence === "legacy" && (await legacyJournalWriterActive(paths.legacy)))
			throw legacyWriterRefusal(canonical);
		return evidence;
	} catch (error) {
		if (!(error instanceof AuthorityAdoptionRefusedError)) throw error;
		if (!(await pathExists(paths.lock))) {
			// No anchor means no current-format writer; a held journal lock is an older client mid-append.
			if ((await pathExists(paths.legacy)) && (await legacyJournalWriterActive(paths.legacy)))
				throw legacyWriterRefusal(canonical);
			throw error;
		}
		return withAuthorityExclusive(
			canonical,
			async () => {
				// A concurrent adopter finished; the opener re-reads the descriptor under its own ownership.
				if (await readAuthorityDescriptor(canonical)) return "none";
				return classifyPreJournalingEvidence(canonical);
			},
			{ owningSessionId },
		);
	}
}

/**
 * Upgrades a legacy journal that {@link classifyPreJournalingEvidence} accepted under the same ownership.
 * The conversion re-validates its source before its first write; the caller then opens the
 * descriptor-selected store without releasing ownership in between.
 */
export async function upgradeLegacyAuthorityOnResume(
	context: AuthorityExclusiveContext,
): Promise<{ readonly backupDirectory: string }> {
	// Under ownership the only other journal-lock holder is an older client; refusing here writes nothing.
	if (await legacyJournalWriterActive(context.paths.legacy)) throw legacyWriterRefusal(context.sessionFile);
	const result = await upgradeLegacyAuthorityUnderOwnership(context);
	if (result.status !== "migrated" || !result.backupDirectory) {
		throw new Error(`Legacy authority upgrade did not complete for ${context.sessionFile}: ${result.status}`);
	}
	return { backupDirectory: result.backupDirectory };
}

async function preflightLegacyUpgrade(context: AuthorityExclusiveContext): Promise<void> {
	try {
		await checkLegacyAuthorityUpgrade(context);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("unresolved external effects or claims")) {
			throw refuse(
				context.sessionFile,
				`the legacy authority journal has unresolved work (${message})`,
				sessionAuthorityCommand(context.sessionFile, "--to jsonl"),
				error,
			);
		}
		throw refuse(
			context.sessionFile,
			`the legacy authority journal is invalid (${message})`,
			repairSessionCommand(context.sessionFile),
			error,
		);
	}
}

/**
 * A legacy writer holds the journal lock for its whole process lifetime, while another resumer's probe
 * holds it for microseconds; only a lock that stays held across a short bounded retry is a writer.
 */
async function legacyJournalWriterActive(journalPath: string): Promise<boolean> {
	for (let attempt = 0; attempt < LEGACY_WRITER_PROBES; attempt++) {
		if (!legacyAuthorityJournalBusy(journalPath)) return false;
		await Bun.sleep(LEGACY_WRITER_PROBE_INTERVAL_MS);
	}
	return true;
}

function legacyWriterRefusal(sessionFile: string): AuthorityAdoptionRefusedError {
	return refuse(
		sessionFile,
		"another client still writes the legacy authority journal; stop it, then resume again",
		resumeCommand(sessionFile),
	);
}

export function logAuthorityAdoption(adoption: AuthorityAdoption): void {
	logger.info("Adopted pre-journaling session authority", {
		sessionFile: adoption.sessionFile,
		kind: adoption.kind,
		backend: adoption.backend,
		...(adoption.kind === "upgraded" ? { backupDirectory: adoption.backupDirectory } : {}),
	});
}

/** One user-visible line describing what adoption did and where the backup is. */
export function formatAuthorityAdoptionNotice(adoption: AuthorityAdoption): string {
	if (adoption.kind === "bootstrapped") {
		return "Authority: this session predates authority journaling; created a new JSONL authority store for it.";
	}
	return `Authority: upgraded this session's legacy v1 authority journal to versioned JSONL; original kept in ${adoption.backupDirectory}`;
}

/**
 * `--recover abort` for an initialization that never became active: the descriptor is still the first
 * `initializing` revision (or only its temporary write exists), no migration, legacy journal or lifecycle
 * evidence exists, and any created payload holds nothing but its own owner bookkeeping. Removing it
 * returns the root to transcript-only, which the next resume bootstraps. Returns false when the root
 * is not in that state so other recovery handlers can run.
 */
export async function recoverAbandonedAuthorityInitialization(
	sessionFile: string,
	action: "finish" | "abort",
): Promise<boolean> {
	const canonical = await canonicalAuthoritySession(sessionFile);
	if (!(await looksLikeAbandonedInitialization(canonical))) return false;
	return withAuthorityExclusive(canonical, async context => {
		const plan = await abandonedInitializationPlan(context);
		if (!plan) return false;
		if (action === "finish") {
			throw new Error(
				`An abandoned authority initialization has no committed state to finish; run: ${sessionAuthorityCommand(canonical, "--recover abort")}`,
			);
		}
		for (const file of plan.remove) await fs.rm(file, { force: true });
		await syncDirectory(path.dirname(canonical));
		if (plan.descriptor) {
			await fs.rm(context.paths.descriptor);
			await syncDirectory(path.dirname(canonical));
		}
		logger.info("Removed abandoned authority initialization", {
			sessionFile: canonical,
			removed: [...plan.remove, ...(plan.descriptor ? [context.paths.descriptor] : [])],
		});
		return true;
	});
}

async function looksLikeAbandonedInitialization(canonical: string): Promise<boolean> {
	const base = path.basename(canonical);
	const names = (await fs.readdir(path.dirname(canonical))).filter(name => name.startsWith(`${base}.authority`));
	if (names.some(name => name.startsWith(`${base}.authority.migration.`))) return false;
	return (
		names.includes(`${base}.authority.json`) || names.some(name => name.startsWith(`${base}.authority.json.tmp-`))
	);
}

async function abandonedInitializationPlan(
	context: AuthorityExclusiveContext,
): Promise<{ readonly remove: string[]; readonly descriptor: boolean } | undefined> {
	const { paths } = context;
	const parent = path.dirname(context.sessionFile);
	const base = path.basename(context.sessionFile);
	const entries = await fs.readdir(parent);
	const names = entries.filter(
		name =>
			(name.startsWith(`${base}.authority`) || name.startsWith(`.${base}.authority`)) &&
			!isAuthorityRecoveryFileName(base, name),
	);
	const descriptor = await readAuthorityDescriptor(context.sessionFile);
	if (
		descriptor &&
		(descriptor.state !== "initializing" || descriptor.revision !== 1 || descriptor.migrationId !== undefined)
	)
		return undefined;
	const temporary = names.filter(name => name.startsWith(`${path.basename(paths.descriptor)}.tmp-`));
	if (!descriptor && !temporary.length) return undefined;
	const payload = descriptor ? path.join(parent, descriptor.payload) : undefined;
	const allowed = new Set(
		[paths.lock, paths.descriptor, paths.legacyFence, ...temporary.map(name => path.join(parent, name))].map(file =>
			path.basename(file),
		),
	);
	if (payload)
		for (const suffix of descriptor?.backend === "sqlite" ? ["", "-wal", "-shm"] : [""])
			allowed.add(path.basename(`${payload}${suffix}`));
	const unexplained = names.filter(name => !allowed.has(name));
	const repairHistory = await legacyRepairBackups(parent, base, entries);
	if (unexplained.length || repairHistory.length) {
		throw new Error(
			`Authority initialization at ${context.sessionFile} has other evidence (${[...unexplained, ...repairHistory].join(", ")}); refusing to remove it`,
		);
	}
	const fence = await readSmallPrivateFile(paths.legacyFence);
	if (fence !== undefined && fence !== LEGACY_AUTHORITY_DENIAL_REASON)
		throw new Error(
			`Authority initialization at ${context.sessionFile} has a non-canonical legacy marker; refusing to remove it`,
		);
	const remove: string[] = temporary.map(name => path.join(parent, name));
	if (payload && descriptor) {
		const present = names.includes(path.basename(payload));
		if (
			present &&
			!(await payloadHoldsOnlyOwnerBookkeeping(
				payload,
				descriptor.backend,
				context.owningSessionId,
				descriptor.incarnation,
			))
		) {
			throw new Error(
				`Authority initialization at ${context.sessionFile} already holds authority records; refusing to remove it`,
			);
		}
		for (const suffix of descriptor.backend === "sqlite" ? ["-wal", "-shm", ""] : [""]) {
			if (names.includes(path.basename(`${payload}${suffix}`))) remove.push(`${payload}${suffix}`);
		}
	}
	if (fence !== undefined) remove.push(paths.legacyFence);
	return { remove, descriptor: descriptor !== undefined };
}

async function payloadHoldsOnlyOwnerBookkeeping(
	payload: string,
	backend: "jsonl" | "sqlite",
	owningSessionId: string,
	incarnation: string,
): Promise<boolean> {
	let driver: AuthorityPersistence | undefined;
	try {
		driver = openAuthorityPersistence({
			path: payload,
			identity: { backend, owningSessionId, incarnation, format: 2 },
			create: false,
		});
		const state = driver.exportState();
		return (
			state.rows.length === 0 &&
			state.legacy === undefined &&
			state.controls.every(
				control =>
					control.key === "meta" ||
					control.key === "owner" ||
					(control.key.startsWith("receipt:") &&
						typeof control.value === "object" &&
						control.value !== null &&
						"commandKind" in control.value &&
						control.value.commandKind === "owner"),
			)
		);
	} catch (error) {
		throw new Error(`Authority initialization payload at ${payload} cannot be inspected; refusing to remove it`, {
			cause: error,
		});
	} finally {
		driver?.close();
	}
}

async function legacyRepairBackups(parent: string, base: string, entries: readonly string[]): Promise<string[]> {
	const owned: string[] = [];
	const journal = `${base}.authority-v1.jsonl`;
	for (const name of entries) {
		if (!name.startsWith(LEGACY_REPAIR_BACKUP_PREFIX)) continue;
		let members: string[];
		try {
			members = await fs.readdir(path.join(parent, name));
		} catch (error) {
			if (isFsError(error, "ENOTDIR") || isFsError(error, "ENOENT")) continue;
			throw error;
		}
		if (members.includes(journal) || members.includes(`${journal}.quarantine`)) owned.push(name);
	}
	return owned;
}

/**
 * Header field a transcript created by an authority-journaling build records: the canonical transcript path whose
 * authority bundle governs it (its own path for a root, the owning parent's for a child agent or seance fork). A
 * pre-feature transcript has none. A stamped transcript at that same path whose bundle is absent never committed
 * an authority there (it is adopted as before); at any other path it is a child, or a copy or move that left the
 * bundle behind, so its absence of sibling evidence proves nothing.
 */
export const AUTHORITY_ROOT_HEADER_FIELD = "authorityRoot";
const HEADER_PROBE_BYTES = 64 * 1024;

/** The header's {@link AUTHORITY_ROOT_HEADER_FIELD}, or undefined when absent or unreadable (identity checks refuse those). */
async function readAuthorityRootStamp(canonical: string): Promise<string | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(canonical, "r");
	} catch (error) {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	let text: string;
	try {
		const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		text = buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
	// A transcript opens with its title slot; the session header is the first `type: "session"` line, as
	// the ownership layer reads it.
	let header: Record<string, unknown> | undefined;
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).type === "session") {
			header = entry as Record<string, unknown>;
			break;
		}
	}
	if (header === undefined || !(AUTHORITY_ROOT_HEADER_FIELD in header)) return undefined;
	const value = header[AUTHORITY_ROOT_HEADER_FIELD];
	// A present but malformed stamp is not a pre-feature header either.
	if (typeof value !== "string" || !path.isAbsolute(value))
		throw refuse(
			canonical,
			`the transcript header's ${AUTHORITY_ROOT_HEADER_FIELD} is malformed`,
			repairSessionCommand(canonical),
		);
	return value;
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await fs.lstat(file);
		return true;
	} catch (error) {
		if (isFsError(error, "ENOENT")) return false;
		throw error;
	}
}

async function isBareAnchor(lockPath: string): Promise<boolean> {
	const stat = await fs.lstat(lockPath);
	return stat.isFile() && stat.nlink === 1 && hasPrivateMode(stat.mode) && stat.size === 0;
}

async function readSmallPrivateFile(file: string): Promise<string | undefined> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size > 64 * 1024) return "";
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isFsError(error, "ENOENT")) return undefined;
		throw error;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (!directoryFsyncSupported()) return;
	const handle = await fs.open(directory, fs.constants.O_RDONLY);
	try {
		await durableFsync(handle);
	} finally {
		await handle.close();
	}
}

function isFsError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
