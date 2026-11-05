import { logger } from "@oh-my-pi/pi-utils";
import { durableFsync } from "./authority/durable-sync";
import { fsyncDirectory } from "./authority/directory-sync";
import { hasPrivateMode } from "./authority/private-mode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { consumeFreshAuthorityRootAllocation } from "./authority/allocation";
import { AuthorityRpcClient, AuthorityRpcError } from "./authority/client";
import { readAuthorityDescriptor, writeAuthorityDescriptor } from "./authority/descriptor";
import type { AuthorityDescriptor } from "./authority/descriptor";
import {
	acquireAuthorityOwnership,
	assertAuthorityCapacityHost,
	AuthorityRecoveryRequiredError,
	authorityPaths,
	manualAuthorityRecoveryRequired,
	canonicalAuthoritySession,
	detectWeakLockFilesystem,
	inspectAuthorityArtifacts,
	LEGACY_AUTHORITY_DENIAL_REASON,
	readAuthoritySessionId,
} from "./authority/ownership";
import type { AuthorityOwnership, AuthorityPaths, AuthorityWeakLockFilesystem } from "./authority/ownership";
import { type AuthorityFullFsyncFallback, detectFullFsyncFallback } from "./authority/durable-sync";
import type { AuthorityStore, AuthorityDriverOptions, JournalingBackend } from "./authority/types";
import { journalingEnvironment } from "./authority/journaling-env";
import type { JournalingCapacity } from "./authority/journaling-env";
import {
	classifyPreJournalingEvidence,
	classifyPreJournalingEvidenceForOpen,
	logAuthorityAdoption,
	upgradeLegacyAuthorityOnResume,
} from "./authority/adoption";
import type { AuthorityAdoption } from "./authority/adoption";
import { sessionAuthorityCommand } from "../utils/resume-command";

export {
	journalingCapacity,
	journalingEnvironment,
	parseJournalingBackend,
	parseJournalingCapacity,
	validateJournalingEnvironment,
	type JournalingCapacity,
} from "./authority/journaling-env";
export {
	AuthorityCapacityUnsupportedError,
	AuthorityRecoveryRequiredError,
	type AuthorityWeakLockFilesystem,
} from "./authority/ownership";
export type { AuthorityFullFsyncFallback } from "./authority/durable-sync";
export {
	AuthorityAdoptionRefusedError,
	formatAuthorityAdoptionNotice,
	type AuthorityAdoption,
} from "./authority/adoption";

interface Opening {
	readonly promise: Promise<AuthorityRpcClient>;
	readonly paths: Set<string>;
	sessionId?: string;
	anchorKey?: string;
	client?: AuthorityRpcClient;
	ownership?: AuthorityOwnership;
	releasePromise?: Promise<void>;
	closePromise?: Promise<void>;
	published?: boolean;
	shared?: Opening;
}
const openings = new Map<string, Opening>();
const anchors = new Map<string, Opening>();
const payloadByBackend: Record<JournalingBackend, (paths: AuthorityPaths) => string> = {
	jsonl: paths => paths.jsonl,
	sqlite: paths => paths.sqlite,
};

export interface AuthorityOpenOptions {
	readonly backend?: JournalingBackend;
	/** Capacity admission for this open; defaults to the OMP_JOURNALING_CAPACITY choice parsed at bootstrap. */
	readonly capacity?: JournalingCapacity;
	readonly owningSessionId?: string;
	/** Fresh-root creation evidence; without it a root lacking a descriptor goes through pre-journaling adoption. */
	readonly create?: boolean;
	/** Called once when this open adopted a pre-journaling session (bootstrap or legacy upgrade). */
	readonly onAdopted?: (adoption: AuthorityAdoption) => void;
	/** Called when the root's persisted backend differs from the environment default (the persisted one is used). */
	readonly onBackendMismatch?: (mismatch: AuthorityBackendMismatch) => void;
	/** Called once per process and session directory when capacity is off and that directory is on a network filesystem. */
	readonly onWeakLockFilesystem?: (notice: AuthorityWeakLockFilesystem) => void;
	/** Called for each recovery file this open wrote when it cut a torn JSONL tail an interrupted write left. */
	readonly onTailRecovered?: (recovery: AuthorityTailRecovery) => void;
	/** Called once per process and session directory when darwin's F_FULLFSYNC fails there and syncs fall back to fsync. */
	readonly onFullFsyncFallback?: (fallback: AuthorityFullFsyncFallback) => void;
}

/** One user-visible line: acknowledged writes in this directory may sit in the drive cache across a power loss. */
export function formatAuthorityFullFsyncNotice(fallback: AuthorityFullFsyncFallback): string {
	return `Authority: F_FULLFSYNC is not available for ${fallback.directory} (${fallback.reason}); OMP falls back to fsync(2), so acknowledged session writes may be lost from the drive cache on a power loss.`;
}

export interface AuthorityTailRecovery {
	readonly sessionFile: string;
	readonly recoveryFile: string;
}

/** One user-visible line: the open cut unacknowledged bytes, and where they are kept. */
export function formatAuthorityTailRecoveryNotice(recovery: AuthorityTailRecovery): string {
	return `Authority: an interrupted write left an unacknowledged torn tail in this session's JSONL store; it was cut and its bytes are kept in ${recovery.recoveryFile} (inspect it, then delete it when no longer needed).`;
}

export interface AuthorityBackendMismatch {
	readonly sessionFile: string;
	readonly requestedDefault: JournalingBackend;
	readonly actualBackend: JournalingBackend;
}

/** One user-visible line: the persisted backend is kept, and the dry-run command that would migrate it. */
export function formatAuthorityBackendMismatchNotice(mismatch: AuthorityBackendMismatch): string {
	return `Authority: this session keeps its persisted ${mismatch.actualBackend} backend; the ${mismatch.requestedDefault} default (OMP_JOURNALING_BACKEND) applies only to new sessions. To migrate it, run: ${sessionAuthorityCommand(mismatch.sessionFile, `--to ${mismatch.requestedDefault}`)}`;
}

/** One user-visible line: the open proceeds, but two hosts sharing this directory may both own a root. */
export function formatAuthorityWeakLockNotice(notice: AuthorityWeakLockFilesystem): string {
	return `Authority: ${notice.directory} is on a network filesystem (${notice.filesystem}); this host's processes still exclude each other, but cross-host exclusion is not guaranteed. Do not open the same session from two machines at once.`;
}

const reportedWeakLockDirectories = new Set<string>();

const reportedFullFsyncDirectories = new Set<string>();

/** Darwin syncs need F_FULLFSYNC; show (never refuse) once per directory when its filesystem lacks it. */
function reportFullFsyncFallback(canonical: string, options: AuthorityOpenOptions): void {
	if (reportedFullFsyncDirectories.has(path.dirname(canonical))) return;
	let fallback: AuthorityFullFsyncFallback | undefined;
	try {
		fallback = detectFullFsyncFallback(canonical);
	} catch (error) {
		logger.warn(
			"Authority could not probe F_FULLFSYNC for the session directory; the fallback notice was not checked",
			{ sessionFile: canonical, error: String(error) },
		);
		return;
	}
	if (!fallback) return;
	reportedFullFsyncDirectories.add(fallback.directory);
	logger.warn("Authority session directory does not support F_FULLFSYNC; syncs fall back to fsync", { ...fallback });
	options.onFullFsyncFallback?.(fallback);
}

/** Capacity-off exclusion is flock; warn (never refuse) once per directory when its filesystem weakens it across hosts. */
async function reportWeakLockFilesystem(
	canonical: string,
	capacity: JournalingCapacity,
	options: AuthorityOpenOptions,
): Promise<void> {
	// Under xfs the capacity host check already requires a local XFS directory.
	if (capacity !== "off") return;
	let notice: AuthorityWeakLockFilesystem | undefined;
	try {
		notice = await detectWeakLockFilesystem(canonical);
	} catch (error) {
		logger.warn(
			"Authority could not classify the session directory filesystem; network-filesystem exclusion was not checked",
			{ sessionFile: canonical, error: String(error) },
		);
		return;
	}
	if (!notice || reportedWeakLockDirectories.has(notice.directory)) return;
	reportedWeakLockDirectories.add(notice.directory);
	logger.warn("Authority session directory is on a network filesystem; cross-host flock exclusion is not guaranteed", {
		...notice,
	});
	options.onWeakLockFilesystem?.(notice);
}

export async function registryDurableStateForSession(
	sessionFile: string,
	options: AuthorityOpenOptions = {},
): Promise<AuthorityStore> {
	const environment = journalingEnvironment();
	const processDefault = environment.backend;
	const capacity = options.capacity ?? environment.capacity;
	const requested = path.resolve(sessionFile);
	const previous = openings.get(requested);
	if (previous) {
		await previous.promise;
		const canonical = await canonicalAuthoritySession(requested);
		const id = await readAuthoritySessionId(canonical);
		if (options.owningSessionId !== undefined && options.owningSessionId !== id)
			throw new Error(
				`Authority root UUID mismatch: requested ${options.owningSessionId}, transcript records ${id}`,
			);
		return shareOpening(previous, canonical, id, processDefault, options);
	}
	const result = Promise.withResolvers<AuthorityRpcClient>();
	const opening: Opening = { promise: result.promise, paths: new Set([requested]) };
	openings.set(requested, opening);
	void (async () => {
		const canonical = await canonicalAuthoritySession(requested);
		const headerId = await readAuthoritySessionId(canonical);
		opening.sessionId = headerId;
		if (options.owningSessionId !== undefined && options.owningSessionId !== headerId) {
			throw new Error(
				`Authority root UUID mismatch: requested ${options.owningSessionId}, transcript records ${headerId}`,
			);
		}
		const canonicalOpening = openings.get(canonical);
		if (canonicalOpening && canonicalOpening !== opening) {
			const store = await shareOpening(canonicalOpening, canonical, headerId, processDefault, options);
			opening.shared = canonicalOpening;
			openings.set(requested, canonicalOpening);
			canonicalOpening.paths.add(requested);
			return store;
		}
		openings.set(canonical, opening);
		opening.paths.add(canonical);
		let anchorKey: string | undefined;
		try {
			const stat = await fs.lstat(authorityPaths(canonical).lock);
			if (!stat.isFile() || stat.nlink !== 1)
				throw new Error(`Authority lock anchor must be a singly linked regular file: ${canonical}`);
			anchorKey = `${stat.dev}:${stat.ino}:${headerId}`;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (anchorKey) {
			const existing = anchors.get(anchorKey);
			if (existing && existing !== opening) {
				const store = await shareOpening(existing, canonical, headerId, processDefault, options);
				opening.shared = existing;
				for (const key of opening.paths) {
					openings.set(key, existing);
					existing.paths.add(key);
				}
				return store;
			}
			anchors.set(anchorKey, opening);
			opening.anchorKey = anchorKey;
		}
		const store = await openSessionAuthority(
			canonical,
			headerId,
			processDefault,
			capacity,
			options,
			opening,
			client => {
				opening.client = client;
				client.onClosed(() => {
					if (opening.published) removeOpening(opening);
				});
			},
		);
		if (!opening.anchorKey) {
			const stat = await fs.lstat(authorityPaths(canonical).lock);
			opening.anchorKey = `${stat.dev}:${stat.ino}:${headerId}`;
			anchors.set(opening.anchorKey, opening);
		}
		reportBackendMismatch(processDefault, store.identity.backend, canonical, options);
		return store;
	})().then(
		store => {
			opening.published = true;
			result.resolve(store);
		},
		async (error: unknown) => {
			// A refusal that left nothing behind is not cached: a retry after its cause is fixed opens afresh.
			if (await openingLeftNothingBehind(opening, error)) removeOpening(opening);
			result.reject(error);
		},
	);
	return opening.promise;
}

/**
 * Whether a rejected opening can be forgotten. It must keep its entry (so closeSessionAuthority can finish
 * cleanup) when a client was created, the outcome is unknown, cleanup itself failed, or ownership was
 * acquired and not confirmed released.
 */
async function openingLeftNothingBehind(opening: Opening, error: unknown): Promise<boolean> {
	if (opening.client || opening.shared) return false;
	if (error instanceof AggregateError) return false;
	if (error instanceof AuthorityRpcError && error.unknownOutcome) return false;
	if (!opening.ownership) return true;
	if (!opening.releasePromise) return false;
	try {
		await opening.releasePromise;
		return true;
	} catch {
		// The rejected release keeps the opening so closeSessionAuthority reports the retained lock.
		return false;
	}
}

async function shareOpening(
	opening: Opening,
	canonical: string,
	sessionId: string,
	processDefault: JournalingBackend,
	options: AuthorityOpenOptions,
): Promise<AuthorityRpcClient> {
	const store = await opening.promise;
	const anchor = await fs.lstat(authorityPaths(canonical).lock);
	if (!anchor.isFile() || anchor.nlink !== 1 || `${anchor.dev}:${anchor.ino}:${sessionId}` !== opening.anchorKey) {
		throw new Error(`Authority lock anchor changed for ${canonical}; explicit recovery is required`);
	}
	const descriptor = await readAuthorityDescriptor(canonical);
	if (
		!descriptor ||
		descriptor.state !== "active" ||
		descriptor.owningSessionId !== sessionId ||
		descriptor.incarnation !== store.identity.incarnation ||
		descriptor.backend !== store.identity.backend
	) {
		throw new Error(`Authority alias descriptor disagrees with the selected store at ${canonical}`);
	}
	const paths = authorityPaths(canonical);
	if (
		!(await fileExists(payloadByBackend[descriptor.backend](paths))) ||
		(await fileExists(descriptor.backend === "jsonl" ? paths.sqlite : paths.jsonl))
	) {
		throw new Error(`Authority alias payload selection is missing or ambiguous at ${canonical}`);
	}
	await validateLegacyDenialFence(canonical, authorityPaths(canonical).legacyFence);
	reportBackendMismatch(processDefault, store.identity.backend, canonical, options);
	return store;
}

export async function closeSessionAuthority(sessionFile: string): Promise<void> {
	const requested = path.resolve(sessionFile);
	let opening = openings.get(requested);
	if (!opening) {
		const canonical = await canonicalAuthoritySession(requested);
		opening = openings.get(canonical);
	}
	if (!opening) return;
	return (opening.closePromise ??= closeOpening(opening));
}
async function closeOpening(opening: Opening): Promise<void> {
	let store = opening.client;
	try {
		store = await opening.promise;
	} catch (error) {
		// The worker may have opened before later resolver bookkeeping failed.
		store = opening.client;
		if (!store && error instanceof AuthorityRpcError && error.unknownOutcome) {
			if (!opening.sessionId || !(await AuthorityRpcClient.closeFailedOpen(opening.sessionId))) throw error;
		}
		if (!store && opening.ownership) {
			try {
				await releaseOpeningOwnership(opening);
			} catch (cleanupError) {
				if (error instanceof AggregateError && error.errors.includes(cleanupError)) throw error;
				throw new AggregateError([error, cleanupError], "Authority opening and ownership cleanup both failed");
			}
		}
	}
	if (opening.shared) return (opening.shared.closePromise ??= closeOpening(opening.shared));
	if (store) await store.close();
	removeOpening(opening);
}

function removeOpening(opening: Opening): void {
	for (const key of opening.paths) if (openings.get(key) === opening) openings.delete(key);
	if (opening.anchorKey && anchors.get(opening.anchorKey) === opening) anchors.delete(opening.anchorKey);
}

function releaseOpeningOwnership(opening: Opening): Promise<void> {
	const ownership = opening.ownership;
	if (!ownership) return Promise.resolve();
	return (opening.releasePromise ??= Promise.resolve().then(() => ownership.release()));
}
async function openSessionAuthority(
	canonical: string,
	owningSessionId: string,
	processDefault: JournalingBackend,
	capacity: JournalingCapacity,
	options: AuthorityOpenOptions,
	opening: Opening,
	onOpened: (store: AuthorityRpcClient) => void,
): Promise<AuthorityRpcClient> {
	// Refuse an unsupported capacity host before adoption, allocation or the lock anchor can write anything.
	await assertAuthorityCapacityHost(canonical, capacity);
	await reportWeakLockFilesystem(canonical, capacity, options);
	reportFullFsyncFallback(canonical, options);
	const paths = authorityPaths(canonical);
	const recoverFinish = sessionAuthorityCommand(canonical, "--recover finish");
	const beforeLock = await inspectAuthorityArtifacts(canonical);
	// An existing root opened without a descriptor predates authority journaling or lost its bundle;
	// classification adopts only fully explained evidence and refuses everything else.
	const adopting = !beforeLock.descriptor && !options.create;
	if (adopting) {
		await classifyPreJournalingEvidenceForOpen(canonical, owningSessionId);
	} else {
		if (beforeLock.legacyJournal || beforeLock.legacyFence) {
			if (!beforeLock.descriptor)
				throw new Error(
					`Legacy authority journal/fence at ${canonical} requires explicit v1 upgrade; refusing implicit initialization`,
				);
			if (beforeLock.legacyJournal && !beforeLock.legacyFence)
				throw manualAuthorityRecoveryRequired(
					canonical,
					`Legacy authority journal at ${canonical} lacks its required denial fence`,
				);
		}
		// With a selected descriptor this evidence may belong to a live owner mid-write (a descriptor replacement's
		// temporary, a migration in progress), so only the re-inspection under ownership below may call it stranded;
		// a live owner then surfaces as held ownership instead of a spurious recovery demand.
		if (!beforeLock.descriptor && (beforeLock.migration || beforeLock.staging || beforeLock.temporary)) {
			throw new AuthorityRecoveryRequiredError(
				`Authority migration or initialization evidence at ${canonical} requires explicit recovery; run: ${recoverFinish}`,
				recoverFinish,
			);
		}
		if (!beforeLock.descriptor && (beforeLock.sqlite || beforeLock.jsonl || beforeLock.backup)) {
			throw manualAuthorityRecoveryRequired(
				canonical,
				`Authority payload or backup exists without a committed descriptor at ${canonical}; refusing selection by file presence`,
			);
		}
		if (!beforeLock.descriptor) {
			if (beforeLock.any)
				throw manualAuthorityRecoveryRequired(
					canonical,
					`Authority initialization evidence at ${canonical} requires explicit recovery`,
				);
			await consumeFreshAuthorityRootAllocation(canonical, owningSessionId);
		}
	}

	let ownership: AuthorityOwnership | undefined;
	let ownershipTransferred = false;
	try {
		ownership = await acquireAuthorityOwnership(canonical, {
			owningSessionId,
			capacity,
			create: options.create || adopting || beforeLock.legacyJournal || beforeLock.legacyFence,
		});
		opening.ownership = ownership;
		const clientOwnership: AuthorityOwnership = { ...ownership, release: () => releaseOpeningOwnership(opening) };
		const artifacts = await inspectAuthorityArtifacts(canonical);
		if (artifacts.migration || artifacts.staging || artifacts.temporary) {
			throw new AuthorityRecoveryRequiredError(
				`Authority migration or initialization evidence at ${canonical} requires explicit recovery; run: ${recoverFinish}`,
				recoverFinish,
			);
		}
		let existingDescriptor = await readAuthorityDescriptor(canonical);
		let adoption: AuthorityAdoption | undefined;
		if (!existingDescriptor && adopting) {
			// Re-classify under exclusion: a concurrent resumer may have adopted or changed the bundle.
			if ((await classifyPreJournalingEvidence(canonical)) === "legacy") {
				const { backupDirectory } = await upgradeLegacyAuthorityOnResume(ownership);
				adoption = { kind: "upgraded", sessionFile: canonical, backend: "jsonl", backupDirectory };
				logAuthorityAdoption(adoption);
				existingDescriptor = await readAuthorityDescriptor(canonical);
				if (!existingDescriptor)
					throw new AuthorityRecoveryRequiredError(
						`Legacy authority upgrade left no selected descriptor at ${canonical}; run: ${recoverFinish}`,
						recoverFinish,
					);
			}
		}
		if (existingDescriptor) {
			if (
				existingDescriptor.physicalIdentity.dev !== ownership.physicalIdentity.dev ||
				existingDescriptor.physicalIdentity.ino !== ownership.physicalIdentity.ino
			) {
				throw new Error(`Authority selected anchor changed while acquiring ownership at ${canonical}`);
			}
			if (existingDescriptor.state !== "active") {
				const command =
					existingDescriptor.state === "initializing" && existingDescriptor.revision === 1
						? sessionAuthorityCommand(canonical, "--recover abort")
						: recoverFinish;
				throw new AuthorityRecoveryRequiredError(
					`Authority descriptor is ${existingDescriptor.state} at ${canonical}; explicit recovery is required; run: ${command}`,
					command,
				);
			}
			if (existingDescriptor.owningSessionId !== owningSessionId)
				throw manualAuthorityRecoveryRequired(
					canonical,
					`Authority descriptor UUID does not match transcript header at ${canonical}`,
				);
			const selectedPayload = payloadByBackend[existingDescriptor.backend](paths);
			const unselectedPayload = existingDescriptor.backend === "jsonl" ? paths.sqlite : paths.jsonl;
			if (!(await fileExists(selectedPayload)))
				throw manualAuthorityRecoveryRequired(
					canonical,
					`Selected ${existingDescriptor.backend} authority payload is missing at ${selectedPayload}; refusing recreation`,
				);
			if (await fileExists(unselectedPayload))
				throw manualAuthorityRecoveryRequired(
					canonical,
					`Ambiguous authority payloads exist at ${canonical}; explicit recovery is required`,
				);
			await validateLegacyDenialFence(canonical, paths.legacyFence);
			const descriptor = existingDescriptor;
			const driver: AuthorityDriverOptions = {
				path: selectedPayload,
				identity: { backend: descriptor.backend, owningSessionId, incarnation: descriptor.incarnation, format: 2 },
				create: false,
			};
			ownershipTransferred = true;
			const store = await AuthorityRpcClient.open(driver, clientOwnership, undefined, capacity);
			onOpened(store);
			// The worker's open reports its own cut, including one that completes an earlier crashed open's cut.
			if (store.tailRecoveryFile !== undefined)
				options.onTailRecovered?.({ sessionFile: canonical, recoveryFile: store.tailRecoveryFile });
			if (!sameIdentity(store.identity, driver.identity)) {
				await store.close();
				throw new Error(`Selected authority store identity disagrees with its descriptor at ${canonical}`);
			}
			if (adoption) options.onAdopted?.(adoption);
			return store;
		}

		if (adopting) {
			// Classification under exclusion proved there is no prior authority beyond a bare anchor.
			// Adoption always selects JSONL; the environment default applies only to new roots.
			const store = await initializeAuthorityStore(
				canonical,
				owningSessionId,
				"jsonl",
				capacity,
				ownership,
				clientOwnership,
				() => {
					ownershipTransferred = true;
				},
				onOpened,
			);
			const bootstrapped: AuthorityAdoption = { kind: "bootstrapped", sessionFile: canonical, backend: "jsonl" };
			logAuthorityAdoption(bootstrapped);
			options.onAdopted?.(bootstrapped);
			return store;
		}
		if (
			beforeLock.any &&
			!(beforeLock.legacyJournal || beforeLock.legacyFence || (beforeLock.lock && !beforeLock.descriptor))
		) {
			throw manualAuthorityRecoveryRequired(
				canonical,
				`Authority artifacts exist without a committed descriptor at ${canonical}; refusing empty-store creation`,
			);
		}
		if (beforeLock.lock && !beforeLock.descriptor)
			throw manualAuthorityRecoveryRequired(canonical, `Authority initialization is incomplete at ${canonical}`);
		if (artifacts.sqlite || artifacts.jsonl || artifacts.backup || artifacts.migration || artifacts.staging) {
			throw manualAuthorityRecoveryRequired(
				canonical,
				`Authority artifacts exist without a committed descriptor at ${canonical}; refusing empty-store creation`,
			);
		}
		if (artifacts.legacyJournal || artifacts.legacyFence) {
			throw new Error(
				`Legacy authority journal/fence at ${canonical} requires explicit v1 upgrade; refusing implicit initialization`,
			);
		}
		if (!options.create)
			throw new Error(`New authority allocation at ${canonical} requires explicit root creation evidence`);
		return await initializeAuthorityStore(
			canonical,
			owningSessionId,
			options.backend ?? processDefault,
			capacity,
			ownership,
			clientOwnership,
			() => {
				ownershipTransferred = true;
			},
			onOpened,
		);
	} catch (error) {
		if (ownership && !ownershipTransferred) {
			try {
				await releaseOpeningOwnership(opening);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Authority opening failed and ownership cleanup failed");
			}
		}
		throw error;
	}
}

/** Fresh store creation under held ownership: initializing descriptor, legacy fence, payload, then active. */
async function initializeAuthorityStore(
	canonical: string,
	owningSessionId: string,
	backend: JournalingBackend,
	capacity: JournalingCapacity,
	ownership: AuthorityOwnership,
	clientOwnership: AuthorityOwnership,
	transferOwnership: () => void,
	onOpened: (store: AuthorityRpcClient) => void,
): Promise<AuthorityRpcClient> {
	const paths = authorityPaths(canonical);
	const payload = payloadByBackend[backend](paths);
	const identity = { backend, owningSessionId, incarnation: crypto.randomUUID(), format: 2 as const };
	const descriptor: AuthorityDescriptor = {
		version: 1,
		revision: 1,
		owningSessionId,
		backend,
		format: 2,
		incarnation: identity.incarnation,
		payload: path.basename(payload),
		state: "initializing",
		physicalIdentity: ownership.physicalIdentity,
	};
	await writeAuthorityDescriptor(canonical, descriptor);
	await installLegacyDenialFence(paths.legacyFence);
	const driver: AuthorityDriverOptions = { path: payload, identity, create: true };
	transferOwnership();
	const store = await AuthorityRpcClient.open(driver, clientOwnership, undefined, capacity);
	onOpened(store);
	if (!sameIdentity(store.identity, identity)) {
		await store.close();
		throw new Error(`New authority store identity disagrees with its initialization descriptor at ${canonical}`);
	}
	try {
		await writeAuthorityDescriptor(canonical, { ...descriptor, revision: 2, state: "active" });
	} catch (error) {
		await store.close();
		throw error;
	}
	return store;
}

async function installLegacyDenialFence(fencePath: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(
			fencePath,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		const stat = await handle.stat();
		if (!stat.isFile() || !hasPrivateMode(stat.mode))
			throw new Error(`Legacy authority denial fence must be a private regular file: ${fencePath}`);
		await handle.writeFile(LEGACY_AUTHORITY_DENIAL_REASON, "utf8");
		await durableFsync(handle);
		await handle.close();
		handle = undefined;
		await fsyncDirectory(path.dirname(fencePath));
	} catch (error) {
		if (handle) await handle.close();
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
			throw new Error(`Legacy authority denial fence already exists at ${fencePath}`, { cause: error });
		throw new Error(`Unable to durably install legacy authority denial fence at ${fencePath}`, { cause: error });
	}
}

async function validateLegacyDenialFence(canonical: string, fencePath: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(fencePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			!hasPrivateMode(stat.mode) ||
			(await handle.readFile("utf8")) !== LEGACY_AUTHORITY_DENIAL_REASON
		) {
			throw new Error("unrecognized or unsafe denial fence");
		}
	} catch (error) {
		throw manualAuthorityRecoveryRequired(
			canonical,
			`Legacy authority denial fence is missing or invalid at ${fencePath}`,
			error,
		);
	} finally {
		await handle?.close();
	}
}

function sameIdentity(left: AuthorityStore["identity"], right: AuthorityStore["identity"]): boolean {
	return (
		left.backend === right.backend &&
		left.owningSessionId === right.owningSessionId &&
		left.incarnation === right.incarnation &&
		left.format === right.format
	);
}

function reportBackendMismatch(
	requestedDefault: JournalingBackend,
	actual: JournalingBackend,
	sessionFile: string,
	options: AuthorityOpenOptions,
): void {
	if (requestedDefault === actual) return;
	logger.warn(
		"Authority backend default differs from this session's persisted backend; use explicit offline migration to change it",
		{
			sessionFile,
			requestedDefault,
			actualBackend: actual,
		},
	);
	options.onBackendMismatch?.({ sessionFile, requestedDefault, actualBackend: actual });
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error(`Selected authority payload is not a regular file: ${filePath}`);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
