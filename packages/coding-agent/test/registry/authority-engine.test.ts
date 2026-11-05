import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalDurableSha256,
	durableBackingSha256,
	durableGenesisHash,
	durableRootHeadHash,
	importLegacyAuthorityJournal,
	RegistryDurableStateStore,
} from "../../src/registry/durable-state";
import type { DurableRegistryRecord } from "../../src/registry/durable-state";
import {
	AuthorityContinuationTooLargeError,
	authorityCommandIsContinuation,
	AuthorityEngine,
	authorityExportFromLegacy,
	authorityExportFromLegacySource,
	authorityFrameContentHash,
	authorityFrameHash,
	authorityKey,
	authorityRecordKey,
	authorityRequestBytes,
	validateAuthorityFrame,
	validateAuthorityFrameState,
} from "../../src/registry/authority/engine";
import type { AuthorityFrameState } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";
import type {
	AuthorityActivation,
	AuthorityCommand,
	AuthorityCommitFrame,
	AuthorityControlChange,
	AuthorityDomain,
	AuthorityDriverOptions,
	AuthorityExport,
	AuthorityIdentity,
	AuthorityKey,
	AuthorityMeta,
	AuthorityOwner,
	AuthorityPersistence,
	AuthorityRecordMap,
	AuthorityRow,
	LocalClaim,
} from "../../src/registry/authority/types";
import { AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES } from "../../src/registry/authority/types";

function stagedOwnerFrame(driver: AuthorityPersistence): AuthorityCommitFrame {
	const meta = driver.getControl("meta") as AuthorityMeta;
	const owner = driver.getControl("owner") as AuthorityOwner;
	const nextOwner: AuthorityOwner = { ...owner, phase: "quiescing" };
	const command: AuthorityCommand = { kind: "owner", owner: nextOwner };
	const request = {
		requestId: "rollback-stage",
		incarnation: driver.identity.incarnation,
		ownerEpoch: owner.epoch,
		ownerToken: owner.token,
	};
	const payloadHash = canonicalDurableSha256(command);
	const committedAt = Date.now();
	const revision = meta.revision + 1;
	const receipt = {
		requestId: request.requestId,
		ownerEpoch: request.ownerEpoch,
		revision,
		payloadHash,
		incarnation: request.incarnation,
		commandKind: command.kind,
		committedAt,
		result: { kind: "mutation" as const },
	};
	const frameBase = {
		version: 2 as const,
		kind: "commit" as const,
		revision,
		request,
		command,
		payloadHash,
		expected: [],
		changes: [],
		controls: [
			{ key: "owner", deleted: false as const, value: nextOwner },
			{
				key: "meta",
				deleted: false as const,
				value: { revision, generationHighWater: meta.generationHighWater, status: "ready" as const },
			},
			{
				key: `receipt:${JSON.stringify([request.incarnation, request.ownerEpoch, request.requestId])}`,
				deleted: false as const,
				value: receipt,
			},
		],
		receipt,
		previousHash: meta.headHash,
		committedAt,
	};
	const contentHash = authorityFrameContentHash(frameBase);
	return {
		...frameBase,
		contentHash,
		hash: authorityFrameHash({ version: 2, revision, previousHash: meta.headHash, contentHash }),
	};
}

const temporaryDirectories: string[] = [];
const backends: AuthorityIdentity["backend"][] = ["jsonl", "sqlite"];

async function openDriver(backend: AuthorityIdentity["backend"]): Promise<AuthorityPersistence> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-engine-"));
	temporaryDirectories.push(directory);
	const identity: AuthorityIdentity = {
		backend,
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = {
		path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
		identity,
		create: true,
	};
	return backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
}

function operation(phase: "intent" | "effect" | "committed" | "completed") {
	return {
		kind: "operation" as const,
		at: 10,
		operationId: "op-1",
		effectClass: "eval" as const,
		ownerId: "actor-1",
		classOwnerId: "root-1",
		actorId: "actor-1",
		rootId: "root-1",
		generation: 1,
		acquiredAt: 10,
		expiresAt: 100,
		phase,
	};
}
function installRoot(engine: AuthorityEngine, rootId = "root", generation = 1) {
	const startupHash = "1".repeat(64);
	const provenanceHash = "2".repeat(64);
	const headHash = durableRootHeadHash({ rootId, generation, actorId: rootId, startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		at: 1,
		actorId: rootId,
		rootId,
		generation,
		startupHash,
		provenanceHash,
		phase: "reserved" as const,
	};
	engine.transitionBatch(
		[
			construction,
			{ ...construction, at: 2, phase: "constructing" },
			{ ...construction, at: 3, phase: "constructed" },
		],
		{ requestId: `${rootId}-construction` },
	);
	const root = { kind: "root" as const, at: 4, rootId, generation, headHash, state: "active" as const };
	const actor = {
		kind: "actor" as const,
		at: 4,
		actorId: rootId,
		rootId,
		generation,
		rootGeneration: generation,
		rootHeadHash: headHash,
		startupHash,
		provenanceHash,
		state: "active" as const,
	};
	const activatedConstruction = { ...construction, at: 4, phase: "activated" as const };
	const gate = { kind: "gate" as const, at: 4, rootId, generation, phase: "open" as const };
	engine.activateAuthority(
		{ root, actor, construction: activatedConstruction, gate },
		{ requestId: `${rootId}-activation` },
	);
	return { root, actor, construction: activatedConstruction, gate, headHash, startupHash, provenanceHash };
}

function localClaimFrom(driver: AuthorityPersistence, localId: string): LocalClaim {
	const control = driver.getControl(`local-claim:${JSON.stringify(localId)}`);
	if (!control || typeof control !== "object") throw new Error("Test fixture has no persisted local claim.");
	return control as LocalClaim;
}

function rehashFrame(frame: AuthorityCommitFrame): AuthorityCommitFrame {
	const command = frame.command;
	const payloadHash = canonicalDurableSha256(command);
	const receipt = { ...frame.receipt, payloadHash, commandKind: command.kind };
	const receiptKey = `receipt:${JSON.stringify([frame.request.incarnation, frame.request.ownerEpoch, frame.request.requestId])}`;
	const controls = frame.controls.map(change => (change.key === receiptKey ? { ...change, value: receipt } : change));
	const { contentHash: _contentHash, hash: _hash, ...content } = frame;
	const base = { ...content, command, payloadHash, receipt, controls };
	const contentHash = authorityFrameContentHash(base);
	return {
		...base,
		contentHash,
		hash: authorityFrameHash({ version: 2, revision: frame.revision, previousHash: frame.previousHash, contentHash }),
	};
}

function exportedFrameState(snapshot: AuthorityExport): AuthorityFrameState {
	return {
		get<D extends AuthorityDomain>(domain: D, key: AuthorityKey): AuthorityRow<AuthorityRecordMap[D]> | undefined {
			return snapshot.rows.find(
				row => authorityKey(row.record.kind, authorityRecordKey(row.record)) === authorityKey(domain, key),
			) as AuthorityRow<AuthorityRecordMap[D]> | undefined;
		},
		getControl: key => snapshot.controls.find(control => control.key === key)?.value,
		*localEntriesAt(localId, version) {
			for (const row of snapshot.rows) {
				if (row.record.kind === "local-entry" && row.record.localId === localId && row.record.version === version)
					yield row as AuthorityRow<AuthorityRecordMap["local-entry"]>;
			}
		},
	};
}

function genericFrame(
	prefix: AuthorityExport,
	command: Extract<AuthorityCommand, { kind: "transition" | "transition-batch" }>,
	requestId: string,
): AuthorityCommitFrame {
	const state = exportedFrameState(prefix);
	const owner = state.getControl("owner") as AuthorityOwner;
	const records = command.kind === "transition" ? [command.record] : command.records;
	const finalRecords = new Map(records.map(record => [authorityKey(record.kind, authorityRecordKey(record)), record]));
	const changes = [...finalRecords.values()].map(record => ({
		record,
		version: (state.get(record.kind, authorityRecordKey(record))?.version ?? 0) + 1,
	}));
	const expected = changes.map(row => ({
		domain: row.record.kind,
		key: authorityRecordKey(row.record),
		version: state.get(row.record.kind, authorityRecordKey(row.record))?.version ?? null,
	}));
	const controls: AuthorityControlChange[] = [];
	for (const record of finalRecords.values()) {
		if (record.kind === "root") {
			const key = `root-generation:${JSON.stringify([record.rootId, record.generation])}`;
			const previous = state.getControl(key) as AuthorityRow | undefined;
			controls.push({ key, deleted: false, value: { record, version: (previous?.version ?? 0) + 1 } });
		} else if (record.kind === "actor") {
			const key = `actor-generation:${JSON.stringify([record.actorId, record.generation])}`;
			const previous = state.getControl(key) as { row: AuthorityRow; parentGeneration?: number } | undefined;
			const parentGeneration =
				previous?.parentGeneration ??
				(record.parentId === undefined ? undefined : state.get("actor", [record.parentId])?.record.generation);
			if (record.parentId !== undefined && parentGeneration === undefined)
				throw new Error("Generic actor fixture lacks first-parent evidence.");
			controls.push({
				key,
				deleted: false,
				value: {
					row: { record, version: (previous?.row.version ?? 0) + 1 },
					...(parentGeneration === undefined ? {} : { parentGeneration }),
				},
			});
		}
	}
	let generationHighWater = prefix.generationHighWater;
	for (const record of records) {
		if (record.kind === "transition")
			generationHighWater = Math.max(generationHighWater, record.sourceGeneration, record.destinationGeneration);
		else if ("generation" in record) generationHighWater = Math.max(generationHighWater, record.generation ?? 0);
	}
	const revision = prefix.revision + 1;
	const request = { requestId, incarnation: owner.incarnation, ownerEpoch: owner.epoch, ownerToken: owner.token };
	const payloadHash = canonicalDurableSha256(command);
	const committedAt = revision;
	const receipt = {
		requestId,
		incarnation: request.incarnation,
		ownerEpoch: request.ownerEpoch,
		revision,
		payloadHash,
		commandKind: command.kind,
		committedAt,
		result: { kind: "mutation" as const },
	};
	controls.push(
		{ key: "meta", deleted: false, value: { revision, generationHighWater, status: "ready" } },
		{
			key: `receipt:${JSON.stringify([request.incarnation, request.ownerEpoch, requestId])}`,
			deleted: false,
			value: receipt,
		},
	);
	const base = {
		version: 2 as const,
		kind: "commit" as const,
		revision,
		request,
		command,
		payloadHash,
		expected,
		changes,
		controls,
		receipt,
		previousHash: prefix.headHash,
		committedAt,
	};
	const contentHash = authorityFrameContentHash(base);
	return {
		...base,
		contentHash,
		hash: authorityFrameHash({ version: 2, revision, previousHash: prefix.headHash, contentHash }),
	};
}

function namedActivationFrame(
	prefix: AuthorityExport,
	activation: Extract<AuthorityCommand, { kind: "activate-authority" }>["activation"],
	requestId: string,
): AuthorityCommitFrame {
	const state = exportedFrameState(prefix);
	const owner = state.getControl("owner") as AuthorityOwner;
	const command: AuthorityCommand = { kind: "activate-authority", activation };
	const records: DurableRegistryRecord[] = [activation.actor];
	if (state.get("construction", authorityRecordKey(activation.construction))?.record.phase !== "activated")
		records.unshift(activation.construction);
	const changes = records.map(record => ({
		record,
		version: (state.get(record.kind, authorityRecordKey(record))?.version ?? 0) + 1,
	}));
	const expected = changes.map(row => ({
		domain: row.record.kind,
		key: authorityRecordKey(row.record),
		version: state.get(row.record.kind, authorityRecordKey(row.record))?.version ?? null,
	}));
	const actorHistoryKey = `actor-generation:${JSON.stringify([activation.actor.actorId, activation.actor.generation])}`;
	const previousActorHistory = state.getControl(actorHistoryKey) as
		| { row?: AuthorityRow; parentGeneration?: number }
		| undefined;
	const parentGeneration =
		previousActorHistory?.parentGeneration ??
		(activation.actor.parentId === undefined
			? undefined
			: state.get("actor", [activation.actor.parentId])?.record.generation);
	const controls: AuthorityControlChange[] = [
		{
			key: actorHistoryKey,
			deleted: false,
			value: {
				row: { record: activation.actor, version: (previousActorHistory?.row?.version ?? 0) + 1 },
				...(parentGeneration === undefined ? {} : { parentGeneration }),
			},
		},
	];
	const revision = prefix.revision + 1;
	const request = { requestId, incarnation: owner.incarnation, ownerEpoch: owner.epoch, ownerToken: owner.token };
	const payloadHash = canonicalDurableSha256(command);
	const committedAt = revision;
	const receipt = {
		requestId,
		incarnation: request.incarnation,
		ownerEpoch: request.ownerEpoch,
		revision,
		payloadHash,
		commandKind: command.kind,
		committedAt,
		result: { kind: "mutation" as const },
	};
	controls.push(
		{
			key: "meta",
			deleted: false,
			value: { revision, generationHighWater: prefix.generationHighWater, status: "ready" },
		},
		{
			key: `receipt:${JSON.stringify([request.incarnation, request.ownerEpoch, requestId])}`,
			deleted: false,
			value: receipt,
		},
	);
	const base = {
		version: 2 as const,
		kind: "commit" as const,
		revision,
		request,
		command,
		payloadHash,
		expected,
		changes,
		controls,
		receipt,
		previousHash: prefix.headHash,
		committedAt,
	};
	const contentHash = authorityFrameContentHash(base);
	return {
		...base,
		contentHash,
		hash: authorityFrameHash({ version: 2, revision, previousHash: prefix.headHash, contentHash }),
	};
}

function exportWithFrame(prefix: AuthorityExport, frame: AuthorityCommitFrame): AuthorityExport {
	const rows = new Map(prefix.rows.map(row => [authorityKey(row.record.kind, authorityRecordKey(row.record)), row]));
	const controls = new Map(prefix.controls.map(control => [control.key, control.value]));
	for (const row of frame.changes) rows.set(authorityKey(row.record.kind, authorityRecordKey(row.record)), row);
	for (const change of frame.controls) {
		if (change.deleted) controls.delete(change.key);
		else
			controls.set(
				change.key,
				change.key === "meta" ? { ...(change.value as object), headHash: frame.hash } : change.value,
			);
	}
	const meta = controls.get("meta") as AuthorityMeta;
	return {
		...prefix,
		revision: frame.revision,
		headHash: frame.hash,
		generationHighWater: meta.generationHighWater,
		rows: [...rows.values()],
		controls: [...controls].map(([key, value]) => ({ key, value })),
		frames: [...prefix.frames, frame],
	};
}

function lexicalCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function operationWith(
	ownerId: string,
	operationId: string,
	phase: "intent" | "effect" | "committed" | "completed" = "intent",
) {
	return { ...operation(phase), ownerId, operationId };
}

function constructActor(
	engine: AuthorityEngine,
	root: { readonly root: { readonly rootId: string; readonly generation: number }; readonly headHash: string },
	actorId: string,
	parentId: string,
	startupHash: string,
	provenanceHash: string,
	at: number,
	permissions?: { readonly scopeHash?: string; readonly parentScopeHash?: string },
) {
	const construction = {
		kind: "construction" as const,
		at,
		actorId,
		rootId: root.root.rootId,
		parentId,
		generation: 1,
		startupHash,
		provenanceHash,
		...permissions,
		phase: "reserved" as const,
	};
	engine.transitionBatch(
		[
			construction,
			{ ...construction, at: at + 1, phase: "constructing" },
			{ ...construction, at: at + 2, phase: "constructed" },
		],
		{ requestId: `${actorId}-construction` },
	);
	return {
		actor: {
			kind: "actor" as const,
			at: at + 3,
			actorId,
			rootId: root.root.rootId,
			parentId,
			generation: 1,
			rootGeneration: root.root.generation,
			rootHeadHash: root.headHash,
			startupHash,
			provenanceHash,
			...permissions,
			state: "active" as const,
		},
		construction: { ...construction, at: at + 3, phase: "activated" as const },
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

test("retries failed SQLite physical closure through the same engine without replaying owner closure", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-engine-close-retry-"));
	temporaryDirectories.push(directory);
	const options: AuthorityDriverOptions = {
		path: path.join(directory, "store.sqlite"),
		identity: { backend: "sqlite", owningSessionId: "root-session", incarnation: crypto.randomUUID(), format: 2 },
		create: true,
	};
	const driver = new SqliteAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner");
	engine.recover();
	const intent = operation("intent");
	const originalReceipt = engine.transition(intent, { requestId: "close-retry-intent" });
	engine.transition({ ...intent, at: 11, phase: "effect" }, { requestId: "close-retry-effect" });
	const closeFailure = new Error("injected first physical SQLite close failure");
	const originalClose = Database.prototype.close;
	let targetDatabase: Database | undefined;
	const attemptedDatabases: Database[] = [];
	const physicallyClosedDatabases: Database[] = [];
	const installCloseBoundary = () => {
		Database.prototype.close = new Proxy(originalClose, {
			apply(target, database, args) {
				if (database instanceof Database && (targetDatabase === undefined || database === targetDatabase)) {
					targetDatabase ??= database;
					attemptedDatabases.push(database);
					if (attemptedDatabases.length === 1) throw closeFailure;
					const result = Reflect.apply(target, database, args);
					physicallyClosedDatabases.push(database);
					return result;
				}
				return Reflect.apply(target, database, args);
			},
		});
	};
	let firstFailure: unknown;
	let closedSnapshot: AuthorityExport | undefined;
	try {
		installCloseBoundary();
		try {
			engine.close();
		} catch (error) {
			firstFailure = error;
		}
		Database.prototype.close = originalClose;
		expect(firstFailure).toBe(closeFailure);
		expect(attemptedDatabases).toHaveLength(1);
		expect(physicallyClosedDatabases).toHaveLength(0);
		expect(() =>
			engine.transition({ ...intent, at: 12, phase: "committed" }, { requestId: "must-not-reopen-access" }),
		).toThrow();

		const observer = new SqliteAuthorityPersistence({ ...options, create: false });
		closedSnapshot = observer.exportState();
		observer.close();
		const ownerCloseFrames = closedSnapshot.frames.filter(
			frame => frame.command.kind === "owner" && frame.command.owner.phase === "closed",
		);
		expect(ownerCloseFrames).toHaveLength(1);
		const ownerCloseFrame = ownerCloseFrames[0];
		if (!ownerCloseFrame) throw new Error("SQLite close did not persist an owner-close frame.");
		const ownerCloseReceiptKey = `receipt:${JSON.stringify([ownerCloseFrame.receipt.incarnation, ownerCloseFrame.receipt.ownerEpoch, ownerCloseFrame.receipt.requestId])}`;
		expect(closedSnapshot.controls.find(control => control.key === ownerCloseReceiptKey)?.value).toEqual(
			ownerCloseFrame.receipt,
		);
		expect(closedSnapshot.controls.find(control => control.key === "owner")?.value).toMatchObject({
			phase: "closed",
		});

		installCloseBoundary();
		engine.close();
		engine.close();
		Database.prototype.close = originalClose;
		expect(attemptedDatabases).toHaveLength(2);
		expect(attemptedDatabases[1]).toBe(attemptedDatabases[0]);
		expect(physicallyClosedDatabases).toEqual([attemptedDatabases[0]]);
		if (!closedSnapshot) throw new Error("SQLite owner-close evidence was not captured.");

		const reopened = new SqliteAuthorityPersistence({ ...options, create: false });
		expect(reopened.exportState()).toEqual(closedSnapshot);
		expect(reopened.getControl(ownerCloseReceiptKey)).toEqual(ownerCloseFrame.receipt);
		expect(
			reopened.getControl(
				`receipt:${JSON.stringify([originalReceipt.incarnation, originalReceipt.ownerEpoch, originalReceipt.requestId])}`,
			),
		).toEqual(originalReceipt);
		expect(reopened.get("operation", [intent.ownerId, intent.effectClass, intent.operationId])).toMatchObject({
			record: { phase: "effect" },
		});
		const recovering = new AuthorityEngine(reopened, "reopened-owner");
		expect(recovering.recover().blocked.length).toBeGreaterThan(0);
		recovering.close();
	} finally {
		Database.prototype.close = originalClose;
	}
});

describe.each(backends)("shared authority engine on %s", backend => {
	test("normal commits persist owner recovery and mutation evidence after staged callbacks return", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-normal-commit-"));
		temporaryDirectories.push(directory);
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "source"),
			create: true,
			identity: { backend, owningSessionId: "root-session", incarnation: crypto.randomUUID(), format: 2 },
		};
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "owner");
		expect(driver.getControl("owner")).toMatchObject({ epoch: 1, token: "owner", phase: "recovering" });
		expect(engine.recover().owner.phase).toBe("ready");
		engine.transition(operation("intent"), { requestId: "normal-intent" });
		engine.transition(operation("effect"), { requestId: "normal-effect" });
		const receipt = engine.transition(operation("completed"), { requestId: "normal-completion" });
		const prefix = driver.exportState();
		const bytesBeforeStage = backend === "jsonl" ? syncFs.readFileSync(options.path, "utf8") : undefined;
		if (backend === "jsonl" && bytesBeforeStage === undefined)
			throw new Error("JSONL staging requires the original journal bytes.");
		const staged = stagedOwnerFrame(driver);
		expect(
			driver.transaction(() => {
				driver.commit(staged);
				expect(driver.getControl("owner")).toMatchObject({ phase: "quiescing" });
				expect(driver.getControl("meta")).toMatchObject({ revision: staged.revision, headHash: staged.hash });
				expect(
					driver.getControl(
						`receipt:${JSON.stringify([staged.receipt.incarnation, staged.receipt.ownerEpoch, staged.receipt.requestId])}`,
					),
				).toEqual(staged.receipt);
				if (backend === "jsonl") {
					if (bytesBeforeStage === undefined)
						throw new Error("JSONL staging requires the original journal bytes.");
					expect(syncFs.readFileSync(options.path, "utf8")).toBe(bytesBeforeStage);
				}
				return "callback-result";
			}),
		).toBe("callback-result");
		if (backend === "jsonl")
			expect(syncFs.readFileSync(options.path, "utf8")).toBe(`${bytesBeforeStage}${JSON.stringify(staged)}\n`);
		const committed = driver.exportState();
		expect(committed.frames).toEqual([...prefix.frames, staged]);
		expect(
			driver.getControl(`receipt:${JSON.stringify([receipt.incarnation, receipt.ownerEpoch, receipt.requestId])}`),
		).toEqual(receipt);
		driver.integrityCheck();
		driver.close();
		const reopened =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		expect(reopened.exportState()).toEqual(committed);
		expect(reopened.get("operation", ["actor-1", "eval", "op-1"])).toEqual({
			record: operation("completed"),
			version: 3,
		});
		reopened.integrityCheck();
		const current = new AuthorityEngine(reopened, "next-owner");
		expect(current.recover().owner).toMatchObject({ epoch: 2, token: "next-owner", phase: "ready" });
		current.transition(operationWith("next-actor", "next-operation"), { requestId: "post-reopen-mutation" });
		expect(reopened.exportState().frames.slice(0, committed.frames.length)).toEqual<readonly AuthorityCommitFrame[]>(
			committed.frames,
		);
		current.close();
	});

	test.each([
		"initial-root",
		"root-generation",
		"initial-actor",
		"actor-generation",
		"construction-activation",
		"gate-opening",
		"root-CAS",
		"root-recovery",
		"local-intent",
		"local-effect",
		"local-commit",
		"local-head",
		"local-head-advance",
		"local-publication",
	] as const)(
		"rejects coherent generic %s bypasses on live admission, seed import, and offline integrity",
		async scenario => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-generic-admission-"));
			temporaryDirectories.push(directory);
			const identity: AuthorityIdentity = {
				backend,
				owningSessionId: "root-session",
				incarnation: crypto.randomUUID(),
				format: 2,
			};
			const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
			const source =
				backend === "jsonl"
					? new JsonlAuthorityPersistence(sourceOptions)
					: new SqliteAuthorityPersistence(sourceOptions);
			const engine = new AuthorityEngine(source, "owner");
			engine.recover();
			let records: readonly DurableRegistryRecord[];
			let admissionError: string;
			if (scenario === "initial-root") {
				const headHash = durableRootHeadHash({
					rootId: "root",
					generation: 1,
					actorId: "root",
					startupHash: "1".repeat(64),
					provenanceHash: "2".repeat(64),
				});
				records = [{ kind: "root", at: 10, rootId: "root", generation: 1, headHash, state: "active" }];
				admissionError =
					"Root creation and generation activation require activateAuthority or commitRootTransition.";
			} else if (scenario.startsWith("local-")) {
				const input = {
					localId: "repo",
					entryId: "entry",
					entryHash: "a".repeat(64),
					expectedHeadHash: durableGenesisHash(),
				};
				if (scenario === "local-intent") {
					const headHash = canonicalDurableSha256({
						localId: input.localId,
						entryId: input.entryId,
						version: 1,
						previousHeadHash: input.expectedHeadHash,
						entryHash: input.entryHash,
					});
					records = [{ kind: "local-entry", at: 10, ...input, version: 1, headHash, phase: "intent" }];
				} else {
					let claim = engine.reserveLocal(input);
					if (scenario !== "local-effect") engine.authorizeLocalEffect(claim);
					if (scenario === "local-head-advance") {
						engine.finalizeLocal({ ...claim, phase: "effect" }, "committed");
						claim = engine.reserveLocal({
							...input,
							entryId: "next",
							entryHash: "b".repeat(64),
							expectedHeadHash: claim.headHash,
						});
						engine.authorizeLocalEffect(claim);
					}
					const entry = engine.getLocalEntry(claim.localId, claim.entryId, claim.version)!.record;
					const committedEntry = { ...entry, at: 20, phase: "committed" as const };
					const head = {
						kind: "local-head" as const,
						at: 20,
						localId: claim.localId,
						version: claim.version,
						previousHeadHash: claim.previousHeadHash,
						headHash: claim.headHash,
						phase: "current" as const,
					};
					records =
						scenario === "local-effect"
							? [{ ...entry, at: 20, phase: "effect" }]
							: scenario === "local-commit"
								? [committedEntry]
								: scenario === "local-publication"
									? [committedEntry, head]
									: [head];
				}
				admissionError = "Local publication records require named local commands.";
			} else {
				const root = installRoot(engine);
				if (scenario === "root-generation") {
					const headHash = durableRootHeadHash({
						rootId: "root",
						generation: 2,
						actorId: "root",
						startupHash: "3".repeat(64),
						provenanceHash: "4".repeat(64),
					});
					records = [{ ...root.root, at: 10, generation: 2, headHash }];
					admissionError =
						"Root creation and generation activation require activateAuthority or commitRootTransition.";
				} else if (
					scenario === "initial-actor" ||
					scenario === "actor-generation" ||
					scenario === "construction-activation"
				) {
					const construction = {
						...root.construction,
						actorId: "child",
						parentId: "root",
						at: 10,
						phase: "reserved" as const,
					};
					engine.transitionBatch([
						construction,
						{ ...construction, at: 11, phase: "constructing" },
						{ ...construction, at: 12, phase: "constructed" },
					]);
					const actor = { ...root.actor, actorId: "child", parentId: "root", at: 13 };
					if (scenario === "actor-generation") {
						engine.activateAuthority({ actor, construction: { ...construction, at: 13, phase: "activated" } });
						const nextConstruction = { ...construction, at: 14, generation: 2 };
						engine.transitionBatch([
							nextConstruction,
							{ ...nextConstruction, at: 15, phase: "constructing" },
							{ ...nextConstruction, at: 16, phase: "constructed" },
						]);
						records = [{ ...actor, at: 17, generation: 2 }];
					} else
						records = scenario === "initial-actor" ? [actor] : [{ ...construction, at: 13, phase: "activated" }];
					admissionError =
						scenario === "construction-activation"
							? "Construction activation requires activateAuthority."
							: "Actor admission requires activateAuthority.";
				} else if (scenario === "gate-opening") {
					engine.transition({ ...root.gate, at: 10, phase: "closed" });
					records = [{ ...root.gate, at: 11 }];
					admissionError = "Opening a gate requires an authority activation command.";
				} else {
					const transition = {
						kind: "transition" as const,
						at: 10,
						rootId: "root",
						transitionId: "replacement",
						sourceGeneration: 1,
						destinationGeneration: 2,
						sourceHeadHash: root.headHash,
						destinationHeadHash: "8".repeat(64),
					};
					engine.transitionBatch([
						{ ...transition, phase: "staged" },
						{ ...transition, at: 11, phase: "quiescing" },
						{ ...transition, at: 12, phase: "quiesced" },
						{ ...transition, at: 13, phase: "validated" },
						{ ...root.gate, at: 13, phase: "quiesced" },
					]);
					records =
						scenario === "root-CAS"
							? [{ ...transition, at: 14, phase: "cas-committed" }]
							: [{ ...transition, at: 14, phase: "recovered", recovery: true }];
					admissionError =
						scenario === "root-CAS"
							? "Root transition CAS requires commitRootTransition."
							: "Root transition recovery requires the constrained commitRootTransition command.";
				}
			}
			const prefix = source.exportState();
			expect(() => source.integrityCheck()).not.toThrow();
			const baselineOptions: AuthorityDriverOptions = {
				path: path.join(directory, "baseline"),
				identity: { ...identity, incarnation: crypto.randomUUID() },
				create: true,
				seed: prefix,
			};
			const baseline =
				backend === "jsonl"
					? new JsonlAuthorityPersistence(baselineOptions)
					: new SqliteAuthorityPersistence(baselineOptions);
			try {
				expect(() => baseline.integrityCheck()).not.toThrow();
				expect(baseline.exportState().rows).toEqual(prefix.rows);
				expect(baseline.exportState().controls).toEqual(prefix.controls);
				expect(baseline.exportState().frames).toEqual(prefix.frames);
			} finally {
				baseline.close();
			}
			for (const kind of ["transition", "transition-batch"] as const) {
				if (kind === "transition" && records.length !== 1) continue;
				const command = kind === "transition" ? { kind, record: records[0]! } : { kind, records };
				expect(() =>
					kind === "transition" ? engine.transition(records[0]!) : engine.transitionBatch(records),
				).toThrow(admissionError);
				expect(source.exportState()).toEqual(prefix);
				const forged = genericFrame(prefix, command, `${scenario}-${kind}`);
				expect(() => validateAuthorityFrame(forged, prefix.headHash)).not.toThrow();
				expect(() => validateAuthorityFrameState(forged, exportedFrameState(prefix))).toThrow(admissionError);
				if (backend === "jsonl") {
					expect(() => source.transaction(() => source.commit(forged))).toThrow(admissionError);
					expect(source.exportState()).toEqual(prefix);
				}
				const inconsistent = exportWithFrame(prefix, forged);
				expect(inconsistent.frames.slice(0, prefix.frames.length)).toEqual<readonly AuthorityCommitFrame[]>(
					prefix.frames,
				);
				for (const control of prefix.controls.filter(control => control.key.startsWith("receipt:")))
					expect(inconsistent.controls.find(retained => retained.key === control.key)).toEqual(control);
				const seedOptions: AuthorityDriverOptions = {
					path: path.join(directory, `${kind}-seed`),
					identity: { ...identity, incarnation: crypto.randomUUID() },
					create: true,
					seed: inconsistent,
				};
				expect(() =>
					backend === "jsonl"
						? new JsonlAuthorityPersistence(seedOptions)
						: new SqliteAuthorityPersistence(seedOptions),
				).toThrow(admissionError);
				const integrityOptions: AuthorityDriverOptions = {
					path: path.join(directory, `${kind}-integrity`),
					identity,
					create: true,
					seed: prefix,
				};
				const integrity =
					backend === "jsonl"
						? new JsonlAuthorityPersistence(integrityOptions)
						: new SqliteAuthorityPersistence(integrityOptions);
				try {
					expect(() => integrity.integrityCheck()).not.toThrow();
					if (backend === "jsonl") {
						await fs.appendFile(integrityOptions.path, `${JSON.stringify(forged)}\n`);
					} else {
						integrity.transaction(() => integrity.commit(forged));
						expect(integrity.exportState().frames).toEqual(inconsistent.frames);
						for (const row of forged.changes)
							expect(integrity.get(row.record.kind, authorityRecordKey(row.record))).toEqual(row);
						for (const control of inconsistent.controls)
							expect(integrity.getControl(control.key)).toEqual(control.value);
					}
					expect(() => integrity.integrityCheck()).toThrow(admissionError);
				} finally {
					integrity.close();
				}
			}
			source.close();
		},
	);
	test("rejects replayed child activation after the persisted root gate closes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-activation-admission-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
		const driver =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(sourceOptions)
				: new SqliteAuthorityPersistence(sourceOptions);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const root = installRoot(engine, "activation-root");
		const construction = {
			kind: "construction" as const,
			at: 10,
			actorId: "activation-child",
			rootId: root.root.rootId,
			parentId: root.actor.actorId,
			generation: 1,
			startupHash: root.startupHash,
			provenanceHash: root.provenanceHash,
			phase: "reserved" as const,
		};
		engine.transitionBatch([
			construction,
			{ ...construction, at: 11, phase: "constructing" },
			{ ...construction, at: 12, phase: "constructed" },
		]);
		engine.transition({ ...root.gate, at: 13, phase: "closed" }, { requestId: "close-activation-gate" });
		const prefix = driver.exportState();
		const activation = {
			construction: { ...construction, at: 14, phase: "activated" as const },
			actor: { ...root.actor, at: 14, actorId: "activation-child", parentId: root.actor.actorId },
		};
		const forged = namedActivationFrame(prefix, activation, "closed-gate-child-activation");
		expect(() => validateAuthorityFrame(forged, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(forged, exportedFrameState(prefix))).toThrow(
			"Authority activation requires the current open root gate, a closed predecessor gate, or exact recovered-root evidence.",
		);
		expect(() => engine.activateAuthority(activation, { requestId: "live-closed-gate-child-activation" })).toThrow();
		expect(driver.exportState()).toEqual(prefix);
		expect(() => driver.integrityCheck()).not.toThrow();
		const invalidSeed = exportWithFrame(prefix, forged);
		const seedOptions: AuthorityDriverOptions = {
			path: path.join(directory, "invalid-seed"),
			identity: { ...identity, incarnation: crypto.randomUUID() },
			create: true,
			seed: invalidSeed,
		};
		expect(() =>
			backend === "jsonl" ? new JsonlAuthorityPersistence(seedOptions) : new SqliteAuthorityPersistence(seedOptions),
		).toThrow();
		if (backend === "jsonl") {
			await fs.appendFile(sourceOptions.path, `${JSON.stringify(forged)}\n`);
			expect(() => driver.integrityCheck()).toThrow();
		}
		if (backend === "jsonl") expect(() => driver.get("actor", ["activation-child"])).toThrow();
		driver.close();
	});

	test("requires first actor-history parent generation to match admission-time state", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-first-parent-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
		const createDriver = (options: AuthorityDriverOptions): AuthorityPersistence =>
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const driver = createDriver(sourceOptions);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const root = installRoot(engine, "first-parent-root");
		const activation = constructActor(
			engine,
			root,
			"first-parent-child",
			root.actor.actorId,
			"3".repeat(64),
			"4".repeat(64),
			10,
		);
		const prefix = driver.exportState();
		const historyKey = `actor-generation:${JSON.stringify([activation.actor.actorId, activation.actor.generation])}`;
		const validFrame = namedActivationFrame(prefix, activation, "valid-first-parent-generation");
		const forgedFrame = rehashFrame({
			...validFrame,
			controls: validFrame.controls.map(change =>
				change.key === historyKey && !change.deleted
					? { ...change, value: { ...(change.value as Record<string, unknown>), parentGeneration: 999 } }
					: change,
			),
		});
		expect(() => validateAuthorityFrame(forgedFrame, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(validFrame, exportedFrameState(prefix))).not.toThrow();
		expect(() => validateAuthorityFrameState(forgedFrame, exportedFrameState(prefix))).toThrow(
			"Actor first-admission parent generation does not match its persisted parent.",
		);

		const validOptions: AuthorityDriverOptions = {
			path: path.join(directory, "valid-seed"),
			identity,
			create: true,
			seed: exportWithFrame(prefix, validFrame),
		};
		const baseline = createDriver(validOptions);
		try {
			baseline.integrityCheck();
			expect(baseline.getControl(historyKey)).toMatchObject({ parentGeneration: root.actor.generation });
			expect(baseline.get("actor", [activation.actor.actorId])?.record.state).toBe("active");
		} finally {
			baseline.close();
		}

		const invalidOptions: AuthorityDriverOptions = {
			path: path.join(directory, "invalid-seed"),
			identity,
			create: true,
			seed: exportWithFrame(prefix, forgedFrame),
		};
		expect(() => createDriver(invalidOptions)).toThrow(
			"Actor first-admission parent generation does not match its persisted parent.",
		);
		const integrityOptions: AuthorityDriverOptions = {
			path: path.join(directory, "integrity"),
			identity,
			create: true,
			seed: prefix,
		};
		const integrity = createDriver(integrityOptions);
		try {
			if (backend === "jsonl") await fs.appendFile(integrityOptions.path, `${JSON.stringify(forgedFrame)}\n`);
			else integrity.transaction(() => integrity.commit(forgedFrame));
			expect(() => integrity.integrityCheck()).toThrow(
				"Actor first-admission parent generation does not match its persisted parent.",
			);
		} finally {
			integrity.close();
		}

		engine.activateAuthority(activation, { requestId: "live-first-parent-generation" });
		expect(driver.getControl(historyKey)).toMatchObject({ parentGeneration: root.actor.generation });
		engine.close();
	});
	test.each(["root", "child"] as const)(
		"revives an exact parked %s without rewriting construction or first-admission evidence",
		async actorKind => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-parked-revival-"));
			temporaryDirectories.push(directory);
			const options: AuthorityDriverOptions = {
				path: path.join(directory, "source"),
				create: true,
				identity: { backend, owningSessionId: "root-session", incarnation: crypto.randomUUID(), format: 2 },
			};
			const createDriver = (input: AuthorityDriverOptions): AuthorityPersistence =>
				backend === "jsonl" ? new JsonlAuthorityPersistence(input) : new SqliteAuthorityPersistence(input);
			const driver = createDriver(options);
			const engine = new AuthorityEngine(driver, "owner-token");
			engine.recover();
			const root = installRoot(engine, "revival-root");
			let activation: AuthorityActivation = { actor: root.actor, construction: root.construction };
			let parentGeneration: number | undefined;
			if (actorKind === "child") {
				const parent = constructActor(
					engine,
					root,
					"revival-parent",
					root.actor.actorId,
					"3".repeat(64),
					"4".repeat(64),
					10,
					{ scopeHash: "5".repeat(64) },
				);
				engine.activateAuthority(parent, { requestId: "revival-parent-activation" });
				activation = constructActor(
					engine,
					root,
					"revival-child",
					parent.actor.actorId,
					"6".repeat(64),
					"7".repeat(64),
					20,
					{ scopeHash: "8".repeat(64), parentScopeHash: parent.actor.scopeHash },
				);
				engine.activateAuthority(activation, { requestId: "revival-child-activation" });
				parentGeneration = parent.actor.generation;
			}
			const actor = activation.actor;
			const historyKey = `actor-generation:${JSON.stringify([actor.actorId, actor.generation])}`;
			const construction = engine.getConstruction(actor.rootId, actor.actorId, actor.generation);
			if (!construction || construction.record.phase !== "activated")
				throw new Error("Revival fixture requires an activated construction.");
			const parked = { ...actor, at: 40, state: "parked" as const };
			engine.transition(parked, { requestId: "park-for-revival" });
			const parkedRow = engine.getActor(actor.actorId);
			const history = engine.getActorGeneration(actor.actorId, actor.generation);
			if (!parkedRow || !history)
				throw new Error("Revival fixture requires current and historical parked actor rows.");
			expect(parkedRow.record).toEqual(parked);
			expect(history.record).toEqual(parked);
			expect(driver.getControl(historyKey)).toEqual({
				row: history,
				...(parentGeneration === undefined ? {} : { parentGeneration }),
			});
			const prefix = driver.exportState();
			const input = {
				actorId: actor.actorId,
				rootId: actor.rootId,
				parentId: actor.parentId,
				generation: actor.generation,
				scopeHash: actor.scopeHash,
			};
			expect(engine.validateRevival(input)).toBe(true);
			expect(engine.validateRevival({ ...input, generation: actor.generation + 1 })).toBe(false);
			expect(engine.validateRevival({ ...input, parentId: "stale-parent" })).toBe(false);
			expect(engine.validateRevival({ ...input, rootId: "stale-root" })).toBe(false);
			expect(engine.validateRevival({ ...input, scopeHash: "9".repeat(64) })).toBe(false);
			expect(driver.exportState()).toEqual(prefix);
			const revival: AuthorityActivation = {
				actor: { ...actor, at: 41, state: "active" },
				construction: { ...construction.record, at: 42 },
			};
			const validFrame = namedActivationFrame(prefix, revival, "contextual-parked-revival");
			expect(validFrame.changes.map(row => row.record.kind)).toEqual(["actor"]);
			expect(() => validateAuthorityFrame(validFrame, prefix.headHash)).not.toThrow();
			expect(() => validateAuthorityFrameState(validFrame, exportedFrameState(prefix))).not.toThrow();
			const rewriteFrame = rehashFrame({
				...validFrame,
				changes: [...validFrame.changes, { record: revival.construction, version: construction.version + 1 }],
				expected: [
					...validFrame.expected,
					{ domain: "construction", key: authorityRecordKey(revival.construction), version: construction.version },
				],
			});
			expect(() => validateAuthorityFrame(rewriteFrame, prefix.headHash)).not.toThrow();
			expect(() => validateAuthorityFrameState(rewriteFrame, exportedFrameState(prefix))).toThrow();
			const receipt = engine.activateAuthority(revival, {
				requestId: "live-parked-revival",
				expected: [{ domain: "actor", key: [actor.actorId], version: parkedRow.version }],
			});
			const committed = driver.exportState();
			const frame = committed.frames.at(-1);
			if (!frame) throw new Error("Revival must retain its committed frame.");
			expect(() => validateAuthorityFrameState(frame, exportedFrameState(prefix))).not.toThrow();
			expect(frame.command).toEqual({ kind: "activate-authority", activation: revival });
			expect(frame.changes).toEqual([{ record: revival.actor, version: parkedRow.version + 1 }]);
			expect(engine.getConstruction(actor.rootId, actor.actorId, actor.generation)).toEqual(construction);
			expect(engine.getActorGeneration(actor.actorId, actor.generation)).toEqual({
				record: revival.actor,
				version: history.version + 1,
			});
			expect(driver.getControl(historyKey)).toEqual({
				row: { record: revival.actor, version: history.version + 1 },
				...(parentGeneration === undefined ? {} : { parentGeneration }),
			});
			expect(committed.generationHighWater).toBe(prefix.generationHighWater);
			expect(committed.frames.slice(0, prefix.frames.length)).toEqual<readonly AuthorityCommitFrame[]>(
				prefix.frames,
			);
			expect(
				committed.controls.filter(
					control =>
						control.key.startsWith("receipt:") &&
						control.key !==
							`receipt:${JSON.stringify([receipt.incarnation, receipt.ownerEpoch, receipt.requestId])}`,
				),
			).toEqual(prefix.controls.filter(control => control.key.startsWith("receipt:")));
			expect(frame.receipt).toEqual(receipt);
			expect(engine.resolveReceipt(receipt.requestId)).toEqual(receipt);
			expect(() =>
				engine.transition({ ...construction.record, at: 43 }, { requestId: "generic-construction-rewrite" }),
			).toThrow();
			expect(driver.exportState()).toEqual(committed);
			driver.integrityCheck();
			driver.close();
			const reopened = createDriver({ ...options, create: false });
			try {
				expect(reopened.exportState()).toEqual(committed);
				reopened.integrityCheck();
			} finally {
				reopened.close();
			}
			const imported = createDriver({ ...options, path: path.join(directory, "imported"), seed: committed });
			try {
				expect(imported.exportState()).toEqual(committed);
				expect(imported.get("construction", [actor.rootId, actor.actorId, actor.generation])).toEqual(construction);
				expect(imported.getControl(historyKey)).toEqual(
					committed.controls.find(control => control.key === historyKey)?.value,
				);
				imported.integrityCheck();
			} finally {
				imported.close();
			}
		},
	);

	test.each(["active", "parked"] as const)(
		"recovers and explicitly reactivates the same-generation %s root with exact evidence",
		async actorState => {
			const driver = await openDriver(backend);
			const original = new AuthorityEngine(driver, "original-owner");
			original.recover();
			const root = installRoot(original, `recovered-${actorState}`);
			if (actorState === "parked")
				original.transition({ ...root.actor, at: 5, state: "parked" }, { requestId: "park-root-before-recovery" });
			const oldRoot = original.getRoot(root.root.rootId);
			const oldActor = original.getActor(root.root.rootId);
			const oldConstruction = original.getConstruction(root.root.rootId, root.root.rootId, root.root.generation);
			if (!oldRoot || !oldActor || !oldConstruction)
				throw new Error("Recovery fixture is missing retained root rows.");

			const recovering = new AuthorityEngine(driver, "recovering-owner");
			const recovery = recovering.recover();
			const gate = recovering.getGate(root.root.rootId);
			if (!gate) throw new Error("Recovery fixture is missing its closed gate.");
			const recoveryKey = `root-recovery:${JSON.stringify([root.root.rootId])}`;
			const evidence = driver.getControl(recoveryKey) as Record<string, unknown> | undefined;
			expect(recovery.owner.phase).toBe("ready");
			expect(gate).toMatchObject({ record: { generation: root.root.generation, phase: "closed" } });
			expect(evidence).toEqual({
				version: 1,
				incarnation: driver.identity.incarnation,
				ownerEpoch: recovery.owner.epoch,
				ownerToken: recovery.owner.token,
				rootId: root.root.rootId,
				generation: root.root.generation,
				rootHeadHash: root.headHash,
				rootVersion: oldRoot.version,
				actorVersion: oldActor.version,
				constructionVersion: oldConstruction.version,
				gateVersion: gate.version,
			});
			const issued = driver.exportState();
			recovering.recover();
			expect(driver.exportState()).toEqual(issued);

			const openGate: AuthorityRecordMap["gate"] = { ...gate.record, at: 10, phase: "open" };
			const activation: AuthorityActivation = {
				actor: { ...root.actor, at: 10, state: "active" },
				construction: oldConstruction.record,
				gate: openGate,
			};
			const prefix = driver.exportState();
			expect(() =>
				recovering.activateAuthority(
					{ actor: activation.actor, construction: activation.construction },
					{ requestId: "recovered-root-requires-explicit-gate" },
				),
			).toThrow();
			expect(driver.exportState()).toEqual(prefix);
			const receipt = recovering.activateAuthority(activation, { requestId: "recovered-root-reactivation" });
			const committed = driver.exportState();
			const frame = committed.frames.at(-1);
			if (!frame) throw new Error("Recovered root activation must retain its frame.");
			expect(frame.changes.map(row => row.record.kind).sort()).toEqual(["actor", "gate"]);
			expect(frame.controls.find(change => change.key === recoveryKey)).toEqual({ key: recoveryKey, deleted: true });
			expect(recovering.getRoot(root.root.rootId)).toEqual(oldRoot);
			expect(recovering.getConstruction(root.root.rootId, root.root.rootId, root.root.generation)).toEqual(
				oldConstruction,
			);
			expect(recovering.getGate(root.root.rootId)).toEqual({ record: openGate, version: gate.version + 1 });
			expect(recovering.getActor(root.root.rootId)).toEqual({
				record: activation.actor,
				version: oldActor.version + 1,
			});
			expect(recovering.getActorGeneration(root.root.rootId, root.root.generation)?.record).toEqual(
				activation.actor,
			);
			expect(committed.generationHighWater).toBe(prefix.generationHighWater);
			expect(committed.frames.slice(0, prefix.frames.length)).toEqual<readonly AuthorityCommitFrame[]>(
				prefix.frames,
			);
			expect(frame.receipt).toEqual(receipt);
			expect(() => validateAuthorityFrameState(frame, exportedFrameState(prefix))).not.toThrow();
			const duplicate = recovering.activateAuthority(activation, { requestId: "recovered-root-reactivation" });
			expect(duplicate).toEqual(receipt);
			expect(driver.exportState()).toEqual(committed);
			expect(
				recovering.resolveReceipt(receipt.requestId, receipt.ownerEpoch, receipt.incarnation, receipt.payloadHash),
			).toEqual(receipt);
			recovering.recover();
			expect(driver.exportState()).toEqual(committed);
			expect(driver.getControl(recoveryKey)).toBeUndefined();
			driver.integrityCheck();
			const seedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-recovered-root-seed-"));
			temporaryDirectories.push(seedDirectory);
			const importedOptions: AuthorityDriverOptions = {
				path: path.join(seedDirectory, "imported"),
				identity: driver.identity,
				create: true,
				seed: committed,
			};
			const imported =
				backend === "jsonl"
					? new JsonlAuthorityPersistence(importedOptions)
					: new SqliteAuthorityPersistence(importedOptions);
			try {
				imported.integrityCheck();
				expect(imported.getControl(recoveryKey)).toBeUndefined();
				expect(imported.get("root", [root.root.rootId])).toEqual(oldRoot);
				expect(imported.get("construction", [root.root.rootId, root.root.rootId, root.root.generation])).toEqual(
					oldConstruction,
				);
			} finally {
				imported.close();
			}
			recovering.close();
		},
	);

	test("refuses a different recovered-root identity without consuming issued evidence", async () => {
		const driver = await openDriver(backend);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "identity-recovery-root");
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		const recovery = recovering.recover();
		const rootRow = recovering.getRoot(root.root.rootId);
		const actorRow = recovering.getActor(root.root.rootId);
		const construction = recovering.getConstruction(root.root.rootId, root.root.rootId, root.root.generation);
		const gate = recovering.getGate(root.root.rootId);
		const history = recovering.getActorGeneration(root.root.rootId, root.root.generation);
		if (!rootRow || !actorRow || !construction || !gate || !history)
			throw new Error("Identity recovery fixture lacks retained rows.");
		const key = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const historyKey = `actor-generation:${JSON.stringify([root.root.rootId, root.root.generation])}`;
		const evidence = driver.getControl(key);
		expect(recovery.owner.phase).toBe("ready");
		expect(gate.record).toMatchObject({ generation: root.root.generation, phase: "closed" });
		expect(construction.record.phase).toBe("activated");
		expect(evidence).toEqual({
			version: 1,
			incarnation: driver.identity.incarnation,
			ownerEpoch: recovery.owner.epoch,
			ownerToken: recovery.owner.token,
			rootId: root.root.rootId,
			generation: root.root.generation,
			rootHeadHash: root.headHash,
			rootVersion: rootRow.version,
			actorVersion: actorRow.version,
			constructionVersion: construction.version,
			gateVersion: gate.version,
		});
		const activation: AuthorityActivation = {
			actor: { ...root.actor, at: 10, state: "active" },
			construction: construction.record,
			gate: { ...gate.record, at: 10, phase: "open" },
		};
		const wrongIdentity: AuthorityActivation = {
			...activation,
			actor: { ...activation.actor, startupHash: "9".repeat(64) },
			construction: { ...activation.construction, startupHash: "9".repeat(64) },
		};
		const prefix = driver.exportState();
		const requestId = "reject-recovered-root-identity";
		const receiptKey = `receipt:${JSON.stringify([recovery.owner.incarnation, recovery.owner.epoch, requestId])}`;
		expect(driver.getControl(receiptKey)).toBeUndefined();
		expect(() => recovering.activateAuthority(wrongIdentity, { requestId })).toThrow(
			"matching constructed reservation",
		);
		expect(driver.exportState()).toEqual(prefix);
		expect(driver.getControl(key)).toEqual(evidence);
		expect(driver.getControl(receiptKey)).toBeUndefined();
		expect(recovering.getActorGeneration(root.root.rootId, root.root.generation)).toEqual(history);

		// Start from a real consumption frame, then change its command and projections together.
		recovering.activateAuthority(activation, { requestId: "valid-identity-recovery" });
		const frame = driver.exportState().frames.at(-1);
		if (!frame) throw new Error("Recovered root activation must retain its frame.");
		expect(() => validateAuthorityFrameState(frame, exportedFrameState(prefix))).not.toThrow();
		const invalidFrame = rehashFrame({
			...frame,
			command: { kind: "activate-authority", activation: wrongIdentity },
			changes: frame.changes.map(row =>
				row.record.kind === "actor" ? { ...row, record: wrongIdentity.actor } : row,
			),
			controls: frame.controls.map(change =>
				change.key === historyKey
					? {
							key: historyKey,
							deleted: false as const,
							value: { row: { record: wrongIdentity.actor, version: history.version + 1 } },
						}
					: change,
			),
		});
		expect(() => validateAuthorityFrame(invalidFrame, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(invalidFrame, exportedFrameState(prefix))).toThrow(
			"matching constructed reservation",
		);
		recovering.close();
	});

	test("root recovery consumption deduplicates its original receipt after reopening", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-recovery-receipt-"));
		temporaryDirectories.push(directory);
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
			identity: { backend, owningSessionId: "root-session", incarnation: crypto.randomUUID(), format: 2 },
			create: true,
		};
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "receipt-recovery-root");
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		recovering.recover();
		const gate = recovering.getGate(root.root.rootId);
		const construction = recovering.getConstruction(root.root.rootId, root.root.rootId, root.root.generation);
		if (!gate || !construction) throw new Error("Receipt recovery fixture lacks the root gate or construction.");
		const activation: AuthorityActivation = {
			actor: { ...root.actor, at: 10, state: "active" },
			construction: construction.record,
			gate: { ...gate.record, at: 10, phase: "open" },
		};
		const requestId = "root-recovery-original-request";
		const receipt = recovering.activateAuthority(activation, { requestId });
		const committed = driver.exportState();
		expect(recovering.activateAuthority(activation, { requestId })).toEqual(receipt);
		expect(driver.exportState()).toEqual(committed);
		const recoveryKey = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		expect(driver.getControl(recoveryKey)).toBeUndefined();
		const payloadHash = canonicalDurableSha256({ kind: "activate-authority", activation });
		recovering.close();

		const reopenedDriver =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		const reopened = new AuthorityEngine(reopenedDriver, "receipt-resolver");
		expect(reopened.resolveReceipt(requestId, receipt.ownerEpoch, receipt.incarnation, payloadHash)).toEqual(receipt);
		expect(reopened.getGate(root.root.rootId)?.record.phase).toBe("open");
		expect(reopenedDriver.getControl(recoveryKey)).toBeUndefined();
		reopened.close();
	});

	test("rolls back recovered-root gate opening and evidence consumption together", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-recovery-rollback-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const options: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "rollback-recovery-root");
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		recovering.recover();
		const gate = recovering.getGate(root.root.rootId);
		const construction = recovering.getConstruction(root.root.rootId, root.root.rootId, root.root.generation);
		if (!gate || !construction) throw new Error("Rollback fixture lacks the root gate or construction.");
		const prefix = driver.exportState();
		const activation: AuthorityActivation = {
			actor: { ...root.actor, at: 10, state: "active" },
			construction: construction.record,
			gate: { ...gate.record, at: 10, phase: "open" },
		};
		recovering.activateAuthority(activation, { requestId: "rollback-recovery-consumption" });
		const frame = driver.exportState().frames.at(-1);
		if (!frame) throw new Error("Recovered-root activation must retain its exact commit frame.");
		recovering.close();

		const targetOptions: AuthorityDriverOptions = {
			...options,
			path: path.join(directory, "rollback-target"),
			seed: prefix,
		};
		const target =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(targetOptions)
				: new SqliteAuthorityPersistence(targetOptions);
		const recoveryKey = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const receiptKey = `receipt:${JSON.stringify([frame.receipt.incarnation, frame.receipt.ownerEpoch, frame.receipt.requestId])}`;
		try {
			expect(() =>
				target.transaction(() => {
					target.commit(frame);
					expect(target.get("gate", [root.root.rootId])?.record.phase).toBe("open");
					expect(target.getControl(recoveryKey)).toBeUndefined();
					throw new Error("abort recovered-root consumption");
				}),
			).toThrow("abort recovered-root consumption");
			expect(target.exportState()).toEqual(prefix);
			expect(target.get("gate", [root.root.rootId])).toEqual(gate);
			expect(target.getControl(recoveryKey)).toBeDefined();
			expect(target.getControl(receiptKey)).toBeUndefined();
			target.integrityCheck();
		} finally {
			target.close();
		}
	});

	test("revalidates imported root evidence before a fresh-incarnation owner can consume it", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-imported-recovery-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
		const source =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(sourceOptions)
				: new SqliteAuthorityPersistence(sourceOptions);
		const original = new AuthorityEngine(source, "original-owner");
		original.recover();
		const root = installRoot(original, "imported-recovery-root");
		const previousOwner = new AuthorityEngine(source, "previous-recovery-owner");
		previousOwner.recover();
		const recoveryKey = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const importedEvidence = source.getControl(recoveryKey);
		const seed = source.exportState();
		const sourceGate = previousOwner.getGate(root.root.rootId);
		const sourceConstruction = previousOwner.getConstruction(
			root.root.rootId,
			root.root.rootId,
			root.root.generation,
		);
		if (!importedEvidence || !sourceGate || !sourceConstruction)
			throw new Error("Imported evidence fixture must retain the previous owner's control, gate, and construction.");
		const staleSourceActivation: AuthorityActivation = {
			actor: { ...root.actor, at: 10, state: "active" },
			construction: sourceConstruction.record,
			gate: { ...sourceGate.record, at: 10, phase: "open" },
		};
		const currentOwner = new AuthorityEngine(source, "current-recovery-owner");
		currentOwner.recover();
		expect(source.getControl(recoveryKey)).not.toEqual(importedEvidence);
		const beforeOldOwnerAttempt = source.exportState();
		expect(() =>
			previousOwner.activateAuthority(staleSourceActivation, { requestId: "stale-previous-owner-consumption" }),
		).toThrow();
		expect(source.exportState()).toEqual(beforeOldOwnerAttempt);
		currentOwner.close();

		const freshIdentity: AuthorityIdentity = { ...identity, incarnation: crypto.randomUUID() };
		const targetOptions: AuthorityDriverOptions = {
			path: path.join(directory, "target"),
			identity: freshIdentity,
			create: true,
			seed,
		};
		const target =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(targetOptions)
				: new SqliteAuthorityPersistence(targetOptions);
		try {
			const recovering = new AuthorityEngine(target, "fresh-incarnation-owner");
			const recoveringOwner = target.getControl("owner") as AuthorityOwner;
			expect(recoveringOwner).toMatchObject({ incarnation: freshIdentity.incarnation, phase: "recovering" });
			expect(target.getControl(recoveryKey)).toEqual(importedEvidence);
			const oldGate = recovering.getGate(root.root.rootId);
			const construction = recovering.getConstruction(root.root.rootId, root.root.rootId, root.root.generation);
			if (!oldGate || !construction) throw new Error("Imported recovery fixture lacks the gate or construction.");
			const staleActivation: AuthorityActivation = {
				actor: { ...root.actor, at: 10, state: "active" },
				construction: construction.record,
				gate: { ...oldGate.record, at: 10, phase: "open" },
			};
			const beforeRevalidation = target.exportState();
			expect(() =>
				recovering.activateAuthority(staleActivation, { requestId: "reject-imported-old-owner-evidence" }),
			).toThrow();
			expect(target.exportState()).toEqual(beforeRevalidation);

			const recovery = recovering.recover();
			const freshEvidence = target.getControl(recoveryKey) as Record<string, unknown> | undefined;
			expect(recovery.owner.phase).toBe("ready");
			expect(freshEvidence).not.toEqual(importedEvidence);
			expect(freshEvidence).toMatchObject({
				incarnation: freshIdentity.incarnation,
				ownerEpoch: recoveringOwner.epoch,
				ownerToken: "fresh-incarnation-owner",
				gateVersion: oldGate.version + 1,
			});
			const freshGate = recovering.getGate(root.root.rootId);
			if (!freshGate) throw new Error("Fresh recovery must retain the closed root gate.");
			const activation: AuthorityActivation = {
				actor: { ...root.actor, at: 11, state: "active" },
				construction: construction.record,
				gate: { ...freshGate.record, at: 11, phase: "open" },
			};
			recovering.activateAuthority(activation, { requestId: "consume-fresh-incarnation-evidence" });
			expect(recovering.getGate(root.root.rootId)?.record.phase).toBe("open");
			expect(target.getControl(recoveryKey)).toBeUndefined();
			target.integrityCheck();
			recovering.close();
		} finally {
			target.close();
		}
	});

	test("consumes root recovery evidence without lowering retained generation high-water", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-recovery-high-water-"));
		temporaryDirectories.push(directory);
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
			identity: { backend, owningSessionId: "root-session", incarnation: crypto.randomUUID(), format: 2 },
			create: true,
		};
		const firstDriver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const firstOwner = new AuthorityEngine(firstDriver, "first-owner");
		firstOwner.recover();
		const root = installRoot(firstOwner, "high-water-recovery-root");
		const abandoned = {
			kind: "construction" as const,
			at: 10,
			actorId: "abandoned-generation",
			rootId: root.root.rootId,
			parentId: root.root.rootId,
			generation: 9,
			startupHash: "3".repeat(64),
			provenanceHash: "4".repeat(64),
			phase: "reserved" as const,
		};
		firstOwner.transitionBatch([abandoned, { ...abandoned, at: 11, phase: "abandoned" }], {
			requestId: "retain-high-water-nine",
		});
		expect(firstDriver.exportState().generationHighWater).toBe(9);
		firstOwner.close();

		const reopenedDriver =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		const recovering = new AuthorityEngine(reopenedDriver, "second-owner");
		const recovery = recovering.recover();
		const gate = recovering.getGate(root.root.rootId);
		const construction = recovering.getConstruction(root.root.rootId, root.root.rootId, root.root.generation);
		if (!gate || !construction) throw new Error("High-water fixture lacks the recovered root gate or construction.");
		expect(recovery.owner.phase).toBe("ready");
		expect(reopenedDriver.getControl(`root-recovery:${JSON.stringify([root.root.rootId])}`)).toBeDefined();
		const activation: AuthorityActivation = {
			actor: { ...root.actor, at: 12, state: "active" },
			construction: construction.record,
			gate: { ...gate.record, at: 12, phase: "open" },
		};
		const prefix = reopenedDriver.exportState();
		recovering.activateAuthority(activation, { requestId: "consume-with-high-water-nine" });
		expect(reopenedDriver.exportState().generationHighWater).toBe(prefix.generationHighWater);
		expect(reopenedDriver.exportState().generationHighWater).toBe(9);
		expect(recovering.getGate(root.root.rootId)?.record.phase).toBe("open");
		expect(reopenedDriver.getControl(`root-recovery:${JSON.stringify([root.root.rootId])}`)).toBeUndefined();
		reopenedDriver.integrityCheck();
		recovering.close();
	});

	test("a fresh recovering owner reissues evidence after interrupted blocked recovery", async () => {
		const driver = await openDriver(backend);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "reissued-root");
		original.transition(operation("intent"), { requestId: "interrupt-recovery-before-ready" });
		const firstOwner = new AuthorityEngine(driver, "first-recovery-owner");
		const firstRecovery = firstOwner.recover();
		const key = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const firstEvidence = driver.getControl(key);
		const closedGate = firstOwner.getGate(root.root.rootId);
		if (!closedGate) throw new Error("First recovery must close the root gate.");
		expect(firstRecovery.owner.phase).toBe("recovering");
		expect(firstRecovery.blocked).toContain("operation:actor-1:op-1:intent");
		expect(firstEvidence).toBeDefined();

		const secondOwner = new AuthorityEngine(driver, "second-recovery-owner");
		const secondRecovery = secondOwner.recover();
		const secondEvidence = driver.getControl(key) as Record<string, unknown> | undefined;
		expect(secondRecovery.owner.phase).toBe("recovering");
		expect(secondRecovery.blocked).toContain("operation:actor-1:op-1:intent");
		expect(secondEvidence).not.toEqual(firstEvidence);
		expect(secondEvidence).toMatchObject({
			ownerEpoch: 3,
			ownerToken: "second-recovery-owner",
			gateVersion: closedGate.version + 1,
		});
		expect(secondOwner.getGate(root.root.rootId)).toEqual({
			record: { ...closedGate.record, at: expect.any(Number) },
			version: closedGate.version + 1,
		});
		secondOwner.close();
	});

	test("recovered root evidence cannot authorize a child activation", async () => {
		const driver = await openDriver(backend);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "root-only-evidence");
		const child = constructActor(
			original,
			root,
			"recovery-child",
			root.root.rootId,
			"3".repeat(64),
			"4".repeat(64),
			10,
		);
		original.activateAuthority(child, { requestId: "activate-child-before-recovery" });
		original.transition({ ...child.actor, at: 20, state: "parked" }, { requestId: "park-child-before-recovery" });
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		const recovery = recovering.recover();
		const key = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const evidence = driver.getControl(key);
		const childActor = recovering.getActor(child.actor.actorId);
		const childConstruction = recovering.getConstruction(
			root.root.rootId,
			child.actor.actorId,
			child.actor.generation,
		);
		const gate = recovering.getGate(root.root.rootId);
		expect(recovery.owner.phase).toBe("ready");
		expect(recovery.blocked).toEqual([]);
		expect(childActor?.record.state).toBe("parked");
		expect(childConstruction?.record.phase).toBe("activated");
		expect(evidence).toBeDefined();
		if (!gate) throw new Error("Recovered root fixture is missing its closed gate.");
		const before = driver.exportState();
		expect(() =>
			recovering.activateAuthority(
				{
					actor: { ...child.actor, at: 21, state: "active" },
					construction: child.construction,
					gate: { ...gate.record, at: 21, phase: "open" },
				},
				{ requestId: "child-cannot-use-root-recovery" },
			),
		).toThrow();
		expect(driver.exportState()).toEqual(before);
		recovering.close();
	});

	test("repeated blocked recovery preserves same-epoch gate evidence", async () => {
		const driver = await openDriver(backend);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "idempotent-recovery-root");
		original.transition(operation("intent"), { requestId: "hold-recovery-in-recovering-phase" });
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		const first = recovering.recover();
		const key = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const evidence = driver.getControl(key);
		expect(first.owner.phase).toBe("recovering");
		expect(evidence).toBeDefined();
		const issued = driver.exportState();
		recovering.recover();
		expect(driver.exportState()).toEqual(issued);
		recovering.close();
	});

	test("recovery closes but grants no evidence to a terminal root actor", async () => {
		const driver = await openDriver(backend);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "terminal-root-actor");
		original.transition({ ...root.actor, at: 10, state: "retired" }, { requestId: "retire-root-actor" });
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		recovering.recover();
		expect(recovering.getGate(root.root.rootId)?.record.phase).toBe("closed");
		expect(driver.getControl(`root-recovery:${JSON.stringify([root.root.rootId])}`)).toBeUndefined();
		recovering.close();
	});

	test("recovery issuance and consumption require exact pre-frame evidence in live and offline validation", async () => {
		const driver = await openDriver(backend);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "contextual-recovery-root");
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		const prefix = driver.exportState();
		recovering.recover();
		const issuance = driver.exportState().frames[prefix.frames.length];
		if (!issuance) throw new Error("Recovery must retain its closed-gate issuance frame.");
		expect(() => validateAuthorityFrame(issuance, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(issuance, exportedFrameState(prefix))).not.toThrow();
		const key = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const recoveryChange = issuance.controls.find(change => change.key === key);
		if (
			!recoveryChange ||
			recoveryChange.deleted ||
			typeof recoveryChange.value !== "object" ||
			!recoveryChange.value
		)
			throw new Error("Recovery frame is missing its issuance evidence.");
		const issuedValue = recoveryChange.value as Record<string, unknown>;
		const actorVersion = issuedValue.actorVersion;
		const rootVersion = issuedValue.rootVersion;
		if (typeof actorVersion !== "number" || typeof rootVersion !== "number")
			throw new Error("Recovery evidence lacks bound row versions.");
		const wrongBoundFrames = (["actorVersion", "rootVersion", "constructionVersion", "gateVersion"] as const).map(
			field => {
				const version = issuedValue[field];
				if (typeof version !== "number") throw new Error(`Recovery evidence lacks its ${field} binding.`);
				return rehashFrame({
					...issuance,
					controls: issuance.controls.map(change =>
						change.key === key && !change.deleted
							? { ...change, value: { ...issuedValue, [field]: version + 1 } }
							: change,
					),
				});
			},
		);
		const forged = wrongBoundFrames[0]!;
		expect(() => validateAuthorityFrame(forged, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(forged, exportedFrameState(prefix))).toThrow();
		const missing = rehashFrame({ ...issuance, controls: issuance.controls.filter(change => change.key !== key) });
		expect(() => validateAuthorityFrame(missing, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(missing, exportedFrameState(prefix))).toThrow();
		const extra = rehashFrame({
			...issuance,
			controls: [
				...issuance.controls,
				{
					key: `root-recovery:${JSON.stringify(["unrelated-root"])}`,
					deleted: false as const,
					value: { ...issuedValue, rootId: "unrelated-root" },
				},
			],
		});
		expect(() => validateAuthorityFrame(extra, prefix.headHash)).toThrow();
		const ordinaryFrame = genericFrame(
			prefix,
			{ kind: "transition", record: operation("intent") },
			"generic-recovery-control",
		);
		const genericRecoveryControl = rehashFrame({
			...ordinaryFrame,
			controls: [...ordinaryFrame.controls, { key, deleted: false as const, value: issuedValue }],
		});
		expect(() => validateAuthorityFrame(genericRecoveryControl, prefix.headHash)).toThrow();
		expect(() => validateAuthorityFrameState(genericRecoveryControl, exportedFrameState(prefix))).toThrow();
		const malformedSchema = rehashFrame({
			...issuance,
			controls: issuance.controls.map(change =>
				change.key === key && !change.deleted ? { ...change, value: { ...issuedValue, extra: true } } : change,
			),
		});
		const missingFieldValue = { ...issuedValue };
		delete missingFieldValue.rootVersion;
		const missingField = rehashFrame({
			...issuance,
			controls: issuance.controls.map(change =>
				change.key === key && !change.deleted ? { ...change, value: missingFieldValue } : change,
			),
		});
		expect(() => validateAuthorityFrame(missingField, prefix.headHash)).toThrow();
		expect(() => validateAuthorityFrame(malformedSchema, prefix.headHash)).toThrow();
		const noncanonicalKey = rehashFrame({
			...issuance,
			controls: issuance.controls.map(change =>
				change.key === key ? { ...change, key: `root-recovery:[ "${root.root.rootId}" ]` } : change,
			),
		});
		expect(() => validateAuthorityFrame(noncanonicalKey, prefix.headHash)).toThrow();

		const seedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-recovery-seed-"));
		temporaryDirectories.push(seedDirectory);
		const createDriver = (options: AuthorityDriverOptions): AuthorityPersistence =>
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const imported = createDriver({
			path: path.join(seedDirectory, "valid"),
			identity: driver.identity,
			create: true,
			seed: exportWithFrame(prefix, issuance),
		});
		try {
			imported.integrityCheck();
		} finally {
			imported.close();
		}
		const invalidIssuanceFrames = [
			forged,
			missing,
			extra,
			genericRecoveryControl,
			...wrongBoundFrames,
			malformedSchema,
			missingField,
			noncanonicalKey,
		];
		for (const [index, invalidFrame] of invalidIssuanceFrames.entries()) {
			expect(() =>
				createDriver({
					path: path.join(seedDirectory, `invalid-seed-${index}`),
					identity: driver.identity,
					create: true,
					seed: exportWithFrame(prefix, invalidFrame),
				}),
			).toThrow();
		}
		const issuanceReplayFrames =
			backend === "jsonl" ? [forged, missing, extra, genericRecoveryControl] : [forged, missing];
		for (const [index, invalidFrame] of issuanceReplayFrames.entries()) {
			const integrityOptions: AuthorityDriverOptions = {
				path: path.join(seedDirectory, `issuance-integrity-${index}`),
				identity: driver.identity,
				create: true,
				seed: prefix,
			};
			const integrity = createDriver(integrityOptions);
			try {
				if (backend === "jsonl") await fs.appendFile(integrityOptions.path, `${JSON.stringify(invalidFrame)}\n`);
				else integrity.transaction(() => integrity.commit(invalidFrame));
				expect(() => integrity.integrityCheck()).toThrow();
			} finally {
				integrity.close();
			}
		}

		const activationPrefix = driver.exportState();
		const rootGate = recovering.getGate(root.root.rootId);
		if (!rootGate) throw new Error("Recovered root lacks its closed gate.");
		recovering.activateAuthority(
			{
				actor: { ...root.actor, at: 20, state: "active" },
				construction: root.construction,
				gate: { ...rootGate.record, at: 20, phase: "open" },
			},
			{ requestId: "contextual-consume-root-recovery" },
		);
		const activationFrame = driver.exportState().frames.at(-1);
		if (!activationFrame) throw new Error("Recovered root activation must retain its frame.");
		expect(() => validateAuthorityFrameState(activationFrame, exportedFrameState(activationPrefix))).not.toThrow();
		const missingConsumption = rehashFrame({
			...activationFrame,
			controls: activationFrame.controls.filter(change => change.key !== key),
		});
		expect(() => validateAuthorityFrame(missingConsumption, activationPrefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(missingConsumption, exportedFrameState(activationPrefix))).toThrow();
		const extraConsumption = rehashFrame({
			...activationFrame,
			controls: [
				...activationFrame.controls,
				{ key: `root-recovery:${JSON.stringify(["unrelated-root"])}`, deleted: true as const },
			],
		});
		expect(() => validateAuthorityFrame(extraConsumption, activationPrefix.headHash)).toThrow();
		for (const [index, invalidFrame] of [missingConsumption, extraConsumption].entries()) {
			expect(() =>
				createDriver({
					path: path.join(seedDirectory, `invalid-consumption-seed-${index}`),
					identity: driver.identity,
					create: true,
					seed: exportWithFrame(activationPrefix, invalidFrame),
				}),
			).toThrow();
		}
		const consumptionReplayFrames =
			backend === "jsonl" ? [missingConsumption, extraConsumption] : [missingConsumption];
		for (const [index, invalidFrame] of consumptionReplayFrames.entries()) {
			const integrityOptions: AuthorityDriverOptions = {
				path: path.join(seedDirectory, `consumption-integrity-${index}`),
				identity: driver.identity,
				create: true,
				seed: activationPrefix,
			};
			const integrity = createDriver(integrityOptions);
			try {
				if (backend === "jsonl") await fs.appendFile(integrityOptions.path, `${JSON.stringify(invalidFrame)}\n`);
				else integrity.transaction(() => integrity.commit(invalidFrame));
				expect(() => integrity.integrityCheck()).toThrow();
			} finally {
				integrity.close();
			}
		}
		const forgedPrefix: AuthorityExport = {
			...activationPrefix,
			controls: activationPrefix.controls.map(control =>
				control.key === key ? { ...control, value: { ...issuedValue, rootVersion: rootVersion + 1 } } : control,
			),
		};
		expect(() => validateAuthorityFrameState(activationFrame, exportedFrameState(forgedPrefix))).toThrow();
		driver.integrityCheck();
		recovering.close();
	});

	test("ready-owner gate rewrites invalidate recovery evidence without renewal", async () => {
		const driver = await openDriver(backend);
		const original = new AuthorityEngine(driver, "original-owner");
		original.recover();
		const root = installRoot(original, "stale-recovery-root");
		const recovering = new AuthorityEngine(driver, "recovering-owner");
		recovering.recover();
		const key = `root-recovery:${JSON.stringify([root.root.rootId])}`;
		const evidence = driver.getControl(key);
		const gate = recovering.getGate(root.root.rootId);
		if (!gate) throw new Error("Recovery fixture is missing its closed gate.");
		recovering.transition(
			{ ...gate.record, at: gate.record.at + 1, phase: "closed" },
			{ requestId: "invalidate-root-recovery" },
		);
		expect(driver.getControl(key)).toEqual(evidence);
		const stale = driver.exportState();
		recovering.recover();
		expect(driver.exportState()).toEqual(stale);
		expect(driver.getControl(key)).toEqual(evidence);
		const before = driver.exportState();
		expect(() =>
			recovering.activateAuthority(
				{
					actor: { ...root.actor, at: 20, state: "active" },
					construction: root.construction,
					gate: { ...gate.record, at: 20, phase: "open" },
				},
				{ requestId: "stale-root-recovery" },
			),
		).toThrow();
		expect(driver.exportState()).toEqual(before);
		recovering.close();
	});

	test.each(["root-row-version", "actor-row-version", "terminal-actor"] as const)(
		"refuses recovered-root activation after post-issuance %s invalidation",
		async scenario => {
			const driver = await openDriver(backend);
			const original = new AuthorityEngine(driver, "original-owner");
			original.recover();
			const root = installRoot(original, `invalidated-${scenario}`);
			const recovering = new AuthorityEngine(driver, "recovering-owner");
			const recovery = recovering.recover();
			const key = `root-recovery:${JSON.stringify([root.root.rootId])}`;
			const evidence = driver.getControl(key);
			expect(recovery.owner.phase).toBe("ready");
			expect(evidence).toBeDefined();
			if (scenario === "root-row-version") {
				const currentRoot = recovering.getRoot(root.root.rootId);
				if (!currentRoot) throw new Error("Root-version invalidation fixture lacks its current root row.");
				recovering.transition(
					{ ...currentRoot.record, at: currentRoot.record.at + 1 },
					{ requestId: "change-bound-root-version" },
				);
			} else {
				const state = scenario === "actor-row-version" ? ("parked" as const) : ("retired" as const);
				recovering.transition({ ...root.actor, at: 20, state }, { requestId: `change-bound-actor-${state}` });
			}
			const stale = driver.exportState();
			recovering.recover();
			expect(driver.exportState()).toEqual(stale);
			expect(driver.getControl(key)).toEqual(evidence);
			const gate = recovering.getGate(root.root.rootId);
			if (!gate) throw new Error("Invalidated recovery fixture lacks its closed gate.");
			expect(() =>
				recovering.activateAuthority(
					{
						actor: { ...root.actor, at: 30, state: "active" },
						construction: root.construction,
						gate: { ...gate.record, at: 30, phase: "open" },
					},
					{ requestId: `reject-${scenario}-root-revival` },
				),
			).toThrow();
			expect(driver.exportState()).toEqual(stale);
			recovering.close();
		},
	);

	test.each(["retired", "aborted", "parked-parent", "replaced-parent", "replaced-root"] as const)(
		"refuses parked revival after %s without changing retained evidence",
		async scenario => {
			const driver = await openDriver(backend);
			const engine = new AuthorityEngine(driver, "owner-token");
			engine.recover();
			const root = installRoot(engine, "stale-revival-root");
			const parent = constructActor(
				engine,
				root,
				"stale-revival-parent",
				root.actor.actorId,
				"3".repeat(64),
				"4".repeat(64),
				10,
				{ scopeHash: "5".repeat(64) },
			);
			engine.activateAuthority(parent, { requestId: "stale-revival-parent-activation" });
			const child = constructActor(
				engine,
				root,
				"stale-revival-child",
				parent.actor.actorId,
				"6".repeat(64),
				"7".repeat(64),
				20,
				{ scopeHash: "8".repeat(64), parentScopeHash: parent.actor.scopeHash },
			);
			engine.activateAuthority(child, { requestId: "stale-revival-child-activation" });
			engine.transition({ ...child.actor, at: 30, state: "parked" }, { requestId: "park-stale-revival-child" });
			if (scenario === "retired" || scenario === "aborted") {
				engine.transition({ ...child.actor, at: 31, state: scenario }, { requestId: "terminate-revival-child" });
			} else if (scenario === "parked-parent") {
				engine.transition({ ...parent.actor, at: 31, state: "parked" }, { requestId: "park-revival-parent" });
			} else if (scenario === "replaced-parent") {
				const construction = { ...parent.construction, at: 31, generation: 2, phase: "reserved" as const };
				engine.transitionBatch(
					[
						construction,
						{ ...construction, at: 32, phase: "constructing" },
						{ ...construction, at: 33, phase: "constructed" },
					],
					{ requestId: "replacement-parent-construction" },
				);
				engine.activateAuthority(
					{
						actor: { ...parent.actor, at: 34, generation: 2 },
						construction: { ...construction, at: 34, phase: "activated" },
					},
					{ requestId: "replacement-parent-activation" },
				);
			} else {
				const transition = {
					kind: "transition" as const,
					at: 31,
					transitionId: "replace-revival-root",
					rootId: root.root.rootId,
					sourceGeneration: root.root.generation,
					destinationGeneration: 2,
					sourceHeadHash: root.headHash,
					destinationHeadHash: "a".repeat(64),
				};
				engine.transitionBatch(
					[
						{ ...transition, phase: "staged" },
						{ ...transition, at: 32, phase: "quiescing" },
						{ ...transition, at: 33, phase: "quiesced" },
						{ ...transition, at: 34, phase: "validated" },
						{ ...root.gate, at: 34, phase: "quiesced" },
					],
					{ requestId: "replacement-revival-root-validation" },
				);
				engine.commitRootTransition(
					{
						transition: { ...transition, at: 35, phase: "cas-committed" },
						expectedRootGeneration: root.root.generation,
						expectedRootHeadHash: root.headHash,
						root: { ...root.root, at: 35, generation: 2, headHash: transition.destinationHeadHash },
						gate: { ...root.gate, at: 35, phase: "closed" },
					},
					{ requestId: "replacement-revival-root-cas" },
				);
			}
			const prefix = driver.exportState();
			const historyKey = `actor-generation:${JSON.stringify([child.actor.actorId, child.actor.generation])}`;
			const history = driver.getControl(historyKey);
			expect(history).toMatchObject({ parentGeneration: parent.actor.generation });
			const revival: AuthorityActivation = {
				actor: { ...child.actor, at: 40, state: "active" },
				construction: { ...child.construction, at: 41 },
			};
			const frame = namedActivationFrame(prefix, revival, "stale-contextual-revival");
			expect(() => validateAuthorityFrame(frame, prefix.headHash)).not.toThrow();
			expect(() => validateAuthorityFrameState(frame, exportedFrameState(prefix))).toThrow();
			expect(
				engine.validateRevival({
					actorId: child.actor.actorId,
					rootId: child.actor.rootId,
					parentId: child.actor.parentId,
					generation: child.actor.generation,
					scopeHash: child.actor.scopeHash,
				}),
			).toBe(false);
			expect(() => engine.activateAuthority(revival, { requestId: "stale-live-revival" })).toThrow();
			expect(driver.exportState()).toEqual(prefix);
			expect(driver.getControl(historyKey)).toEqual(history);
			driver.integrityCheck();
			engine.close();
		},
	);

	test("first activation still requires a constructed reservation and its changed construction row", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const root = installRoot(engine, "initial-activation-root");
		const construction = {
			kind: "construction" as const,
			at: 10,
			actorId: "initial-activation-child",
			rootId: root.root.rootId,
			parentId: root.actor.actorId,
			generation: 1,
			startupHash: "3".repeat(64),
			provenanceHash: "4".repeat(64),
			phase: "reserved" as const,
		};
		const activation: AuthorityActivation = {
			actor: {
				...root.actor,
				at: 13,
				actorId: construction.actorId,
				parentId: construction.parentId,
				startupHash: construction.startupHash,
				provenanceHash: construction.provenanceHash,
			},
			construction: { ...construction, at: 13, phase: "activated" },
		};
		for (const phase of [undefined, "reserved", "constructing"] as const) {
			if (phase) engine.transition({ ...construction, phase }, { requestId: `incomplete-construction-${phase}` });
			const prefix = driver.exportState();
			const frame = namedActivationFrame(prefix, activation, `incomplete-activation-${phase}`);
			expect(() => validateAuthorityFrame(frame, prefix.headHash)).not.toThrow();
			expect(() => validateAuthorityFrameState(frame, exportedFrameState(prefix))).toThrow();
			expect(() =>
				engine.activateAuthority(activation, { requestId: `live-incomplete-activation-${phase}` }),
			).toThrow();
			expect(driver.exportState()).toEqual(prefix);
		}
		engine.transition({ ...construction, at: 12, phase: "constructed" }, { requestId: "complete-construction" });
		const prefix = driver.exportState();
		const validFrame = namedActivationFrame(prefix, activation, "complete-first-activation");
		expect(() => validateAuthorityFrameState(validFrame, exportedFrameState(prefix))).not.toThrow();
		const omittedConstruction = rehashFrame({
			...validFrame,
			changes: validFrame.changes.filter(row => row.record.kind !== "construction"),
			expected: validFrame.expected.filter(expectation => expectation.domain !== "construction"),
		});
		expect(() => validateAuthorityFrame(omittedConstruction, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(omittedConstruction, exportedFrameState(prefix))).toThrow();
		engine.activateAuthority(activation, { requestId: "live-complete-first-activation" });
		expect(
			engine.getConstruction(construction.rootId, construction.actorId, construction.generation)?.record.phase,
		).toBe("activated");
		driver.integrityCheck();
		engine.close();
	});

	test("contextual replay shares live parent relationship admission in ordered batches", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-relationships-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
		const createDriver = (options: AuthorityDriverOptions): AuthorityPersistence =>
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const driver = createDriver(sourceOptions);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const root = installRoot(engine, "relationship-root");
		const parent = constructActor(
			engine,
			root,
			"relationship-parent",
			root.actor.actorId,
			"3".repeat(64),
			"4".repeat(64),
			10,
		);
		engine.activateAuthority(parent, { requestId: "relationship-parent-activation" });
		const child = constructActor(
			engine,
			root,
			"relationship-child",
			parent.actor.actorId,
			"5".repeat(64),
			"6".repeat(64),
			20,
		);
		engine.activateAuthority(child, { requestId: "relationship-child-activation" });
		engine.transitionBatch(
			[
				{ ...child.actor, at: 30, state: "parked" },
				{ ...parent.actor, at: 31, state: "parked" },
			],
			{ requestId: "park-parent-and-child" },
		);
		const prefix = driver.exportState();
		const parentActive = { ...parent.actor, at: 32, state: "active" as const };
		const childActive = { ...child.actor, at: 33, state: "active" as const };
		const forgedFrame = genericFrame(prefix, { kind: "transition", record: childActive }, "child-before-parent");
		const validBatch = genericFrame(
			prefix,
			{ kind: "transition-batch", records: [parentActive, childActive] },
			"parent-before-child",
		);
		const reversedBatch = genericFrame(
			prefix,
			{ kind: "transition-batch", records: [childActive, parentActive] },
			"child-before-parent-batch",
		);
		expect(() => validateAuthorityFrame(forgedFrame, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(forgedFrame, exportedFrameState(prefix))).toThrow(
			"Actor references a missing or invalid parent.",
		);
		expect(() => validateAuthorityFrameState(validBatch, exportedFrameState(prefix))).not.toThrow();
		expect(() => validateAuthorityFrameState(reversedBatch, exportedFrameState(prefix))).toThrow(
			"Actor references a missing or invalid parent.",
		);

		const validOptions: AuthorityDriverOptions = {
			path: path.join(directory, "valid-seed"),
			identity,
			create: true,
			seed: exportWithFrame(prefix, validBatch),
		};
		const baseline = createDriver(validOptions);
		try {
			baseline.integrityCheck();
			expect(baseline.get("actor", [parent.actor.actorId])?.record.state).toBe("active");
			expect(baseline.get("actor", [child.actor.actorId])?.record.state).toBe("active");
		} finally {
			baseline.close();
		}
		const invalidOptions: AuthorityDriverOptions = {
			path: path.join(directory, "invalid-seed"),
			identity,
			create: true,
			seed: exportWithFrame(prefix, forgedFrame),
		};
		expect(() => createDriver(invalidOptions)).toThrow("Actor references a missing or invalid parent.");
		const integrityOptions: AuthorityDriverOptions = {
			path: path.join(directory, "integrity"),
			identity,
			create: true,
			seed: prefix,
		};
		const integrity = createDriver(integrityOptions);
		try {
			if (backend === "jsonl") await fs.appendFile(integrityOptions.path, `${JSON.stringify(forgedFrame)}\n`);
			else integrity.transaction(() => integrity.commit(forgedFrame));
			expect(() => integrity.integrityCheck()).toThrow("Actor references a missing or invalid parent.");
		} finally {
			integrity.close();
		}

		expect(() => engine.transition(childActive, { requestId: "live-child-before-parent" })).toThrow(
			"Actor references a missing or invalid parent.",
		);
		expect(driver.exportState()).toEqual(prefix);
		engine.transitionBatch([parentActive, childActive], { requestId: "live-parent-before-child" });
		expect(engine.getActor(parent.actor.actorId)?.record.state).toBe("active");
		expect(engine.getActor(child.actor.actorId)?.record.state).toBe("active");
		engine.close();
	});

	test.each(["operation", "resource"] as const)(
		"persisted batches cannot combine %s effect authorization with intent",
		async domain => {
			const driver = await openDriver(backend);
			const engine = new AuthorityEngine(driver, "owner");
			engine.recover();
			const intent: AuthorityRecordMap["operation" | "resource"] =
				domain === "operation"
					? operation("intent")
					: {
							kind: "resource",
							at: 10,
							resourceId: "resource",
							resourceClass: "filesystem",
							operationId: "operation",
							actorId: "actor",
							rootId: "root",
							generation: 1,
							targetHash: "a".repeat(64),
							phase: "intent",
						};
			const effect = { ...intent, phase: "effect" as const };
			const prefix = driver.exportState();
			const command = { kind: "transition-batch" as const, records: [intent, effect] };
			const forged = genericFrame(prefix, command, "batched-effect");
			expect(() => engine.transitionBatch(command.records)).toThrow(
				"Effect authorization and post-effect phases require a single ordered authority command.",
			);
			expect(() => validateAuthorityFrame(forged, prefix.headHash)).toThrow(
				"Effect authorization and post-effect phases require a single ordered authority command.",
			);
			expect(() => validateAuthorityFrameState(forged, exportedFrameState(prefix))).toThrow(
				"Effect authorization and post-effect phases require a single ordered authority command.",
			);
			expect(driver.exportState()).toEqual(prefix);
			engine.close();
		},
	);

	test("repeated actor and root updates advance persisted generation history once per ordered batch", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-history-batch-"));
		temporaryDirectories.push(directory);
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "source"),
			create: true,
			identity: { backend, owningSessionId: "root-session", incarnation: crypto.randomUUID(), format: 2 },
		};
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "owner");
		engine.recover();
		const source = installRoot(engine);
		engine.transitionBatch([
			{ ...source.actor, at: 5, state: "parked" },
			{ ...source.actor, at: 6, state: "active" },
			{ ...source.root, at: 5 },
			{ ...source.root, at: 6 },
		]);
		expect(driver.get("actor", ["root"])).toEqual({ record: { ...source.actor, at: 6 }, version: 2 });
		expect(driver.get("root", ["root"])).toEqual({ record: { ...source.root, at: 6 }, version: 2 });
		expect(driver.getControl('actor-generation:["root",1]')).toEqual({ row: driver.get("actor", ["root"]) });
		expect(driver.getControl('root-generation:["root",1]')).toEqual(driver.get("root", ["root"]));
		const before = driver.exportState();
		expect(() =>
			engine.transitionBatch([
				{ ...source.actor, at: 7, state: "retired" },
				{ ...source.actor, at: 8, state: "active" },
			]),
		).toThrow();
		expect(driver.exportState()).toEqual(before);
		driver.integrityCheck();
		engine.close();
		const reopened =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		reopened.integrityCheck();
		const seed = reopened.exportState();
		expect(seed.frames.slice(0, before.frames.length)).toEqual<readonly AuthorityCommitFrame[]>(before.frames);
		reopened.close();
		const importedOptions = {
			...options,
			path: path.join(directory, "target"),
			identity: { ...options.identity, incarnation: crypto.randomUUID() },
			seed,
		};
		const imported =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(importedOptions)
				: new SqliteAuthorityPersistence(importedOptions);
		imported.integrityCheck();
		expect(imported.exportState().rows).toEqual(seed.rows);
		expect(imported.exportState().controls).toEqual(seed.controls);
		expect(imported.exportState().frames).toEqual(seed.frames);
		imported.close();
	});

	test("authorization and finalization evidence require current-owner claims in their exact phases", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner");
		engine.recover();
		const claim = engine.reserveLocal({
			localId: "repo",
			entryId: "entry",
			entryHash: "a".repeat(64),
			expectedHeadHash: durableGenesisHash(),
		});
		const beforeAuthorization = driver.exportState();
		engine.authorizeLocalEffect(claim);
		const authorization = driver.exportState().frames.at(-1)!;
		const authorized = localClaimFrom(driver, "repo");
		const beforeFinalization = driver.exportState();
		engine.finalizeLocal(authorized, "committed");
		const finalization = driver.exportState().frames.at(-1)!;
		for (const frame of [authorization, finalization]) {
			if (frame.command.kind !== "authorize-local-effect" && frame.command.kind !== "finalize-local")
				throw new Error("Missing named local evidence.");
			for (const invalidClaim of [
				{ ...frame.command.claim, ownerEpoch: frame.request.ownerEpoch + 1 },
				{ ...frame.command.claim, incarnation: "previous-incarnation" },
				{
					...frame.command.claim,
					phase: frame.command.kind === "authorize-local-effect" ? ("effect" as const) : ("reserved" as const),
				},
			]) {
				const forged = rehashFrame({ ...frame, command: { ...frame.command, claim: invalidClaim } });
				expect(() => validateAuthorityFrame(forged)).toThrow();
			}
		}
		for (const [frame, snapshot] of [
			[authorization, beforeAuthorization],
			[finalization, beforeFinalization],
		] as const) {
			const owner = snapshot.controls.find(control => control.key === "owner")!.value as AuthorityOwner;
			const state: AuthorityFrameState = {
				get<D extends AuthorityDomain>(
					domain: D,
					key: AuthorityKey,
				): AuthorityRow<AuthorityRecordMap[D]> | undefined {
					return snapshot.rows.find(
						row => authorityKey(row.record.kind, authorityRecordKey(row.record)) === authorityKey(domain, key),
					) as AuthorityRow<AuthorityRecordMap[D]> | undefined;
				},
				getControl: key => snapshot.controls.find(control => control.key === key)?.value,
				localEntriesAt: () => [],
			};
			expect(() => validateAuthorityFrameState(frame, state)).not.toThrow();
			expect(() =>
				validateAuthorityFrameState(frame, {
					...state,
					getControl: key =>
						key === 'local-claim:"repo"'
							? { ...(state.getControl(key) as LocalClaim), claimToken: "different-retained-token" }
							: state.getControl(key),
				}),
			).toThrow();
			if (frame.command.kind === "finalize-local") {
				expect(() =>
					validateAuthorityFrameState(frame, {
						...state,
						getControl: key => (key === "owner" ? { ...owner, phase: "quiescing" } : state.getControl(key)),
					}),
				).not.toThrow();
			}
			for (const replacement of [
				{ ...owner, token: "stale-token" },
				{ ...owner, epoch: owner.epoch + 1 },
				{ ...owner, incarnation: "fresh-incarnation" },
				{ ...owner, phase: "recovering" as const },
				{ ...owner, phase: "closed" as const },
			]) {
				expect(() =>
					validateAuthorityFrameState(frame, {
						...state,
						getControl: key => (key === "owner" ? replacement : state.getControl(key)),
					}),
				).toThrow();
			}
		}
		for (const snapshot of [beforeFinalization, driver.exportState()]) {
			const last = snapshot.frames.at(-1)!;
			const forged = rehashFrame({ ...last, request: { ...last.request, ownerToken: "not-the-current-owner" } });
			expect(() => validateAuthorityFrame(forged)).not.toThrow();
			const seed = {
				...snapshot,
				headHash: forged.hash,
				frames: [...snapshot.frames.slice(0, -1), forged],
				controls: snapshot.controls.map(control =>
					control.key === "meta"
						? { ...control, value: { ...(control.value as object), headHash: forged.hash } }
						: control,
				),
			};
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-stale-owner-evidence-"));
			temporaryDirectories.push(directory);
			const options: AuthorityDriverOptions = {
				path: path.join(directory, "target"),
				identity: { ...driver.identity, incarnation: crypto.randomUUID() },
				create: true,
				seed,
			};
			expect(() =>
				backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options),
			).toThrow();
		}
		engine.close();
	});
	test("rejects forged genesis predecessor observations in reconciliation evidence", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner");
		engine.recover();
		const claim = engine.reserveLocal({
			localId: "repo",
			entryId: "entry",
			entryHash: "d".repeat(64),
			expectedHeadHash: durableGenesisHash(),
		});
		engine.reconcileLocal({ claim, action: "restore-predecessor", observedEntryHash: durableGenesisHash() });
		const frame = driver.exportState().frames.at(-1)!;
		if (frame.command.kind !== "reconcile-local") throw new Error("Missing reconciliation evidence.");
		const forged = rehashFrame({
			...frame,
			command: { ...frame.command, input: { ...frame.command.input, observedEntryHash: "f".repeat(64) } },
		});
		expect(() => validateAuthorityFrame(forged)).toThrow();
		engine.close();
	});

	test("rejects forged reconciliation evidence for unapproved or unobserved effects", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner");
		engine.recover();
		const claim = engine.reserveLocal({
			localId: "repo",
			entryId: "entry",
			entryHash: "d".repeat(64),
			expectedHeadHash: durableGenesisHash(),
		});
		engine.authorizeLocalEffect(claim);
		const authorized = localClaimFrom(driver, "repo");
		engine.reconcileLocal({ claim: authorized, action: "commit", observedEntryHash: authorized.entryHash });
		const frame = driver.exportState().frames.at(-1)!;
		if (frame.command.kind !== "reconcile-local") throw new Error("Missing reconciliation evidence.");
		const command = frame.command;
		for (const input of [
			{ ...command.input, claim: { ...authorized, phase: "reserved" as const } },
			{ ...command.input, observedEntryHash: "e".repeat(64) },
		]) {
			const forged = rehashFrame({ ...frame, command: { ...command, input } });
			expect(() => validateAuthorityFrame(forged)).toThrow();
		}
		const exported = driver.exportState();
		const invalidCommand = {
			...command,
			input: { ...command.input, claim: { ...authorized, phase: "reserved" as const } },
		};
		const forgedFrame = rehashFrame({ ...frame, command: invalidCommand });
		const receiptKey = `receipt:${JSON.stringify([frame.request.incarnation, frame.request.ownerEpoch, frame.request.requestId])}`;
		const invalidSeed = {
			...exported,
			headHash: forgedFrame.hash,
			frames: [...exported.frames.slice(0, -1), forgedFrame],
			controls: exported.controls.map(control =>
				control.key === "meta"
					? { ...control, value: { ...(control.value as object), headHash: forgedFrame.hash } }
					: control.key === receiptKey
						? { ...control, value: forgedFrame.receipt }
						: control,
			),
		};
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-forged-seed-"));
		temporaryDirectories.push(directory);
		const options: AuthorityDriverOptions = {
			path: path.join(directory, "target"),
			identity: { ...driver.identity, incarnation: crypto.randomUUID() },
			create: true,
			seed: invalidSeed,
		};
		expect(() =>
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options),
		).toThrow();
		engine.close();
	});

	test("fresh incarnation reconciles retained claims without granting stale effects", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-import-claims-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
		const source =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(sourceOptions)
				: new SqliteAuthorityPersistence(sourceOptions);
		const original = new AuthorityEngine(source, "old-owner");
		original.recover();
		const reserved = original.reserveLocal({
			localId: "reserved",
			entryId: "a",
			entryHash: "a".repeat(64),
			expectedHeadHash: durableGenesisHash(),
		});
		const effect = original.reserveLocal({
			localId: "effect",
			entryId: "b",
			entryHash: "b".repeat(64),
			expectedHeadHash: durableGenesisHash(),
		});
		original.authorizeLocalEffect(effect);
		const authorized = localClaimFrom(source, "effect");
		const seed = source.exportState();
		original.close();
		const targetOptions: AuthorityDriverOptions = {
			path: path.join(directory, "target"),
			identity: { ...identity, incarnation: crypto.randomUUID() },
			create: true,
			seed,
		};
		const target =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(targetOptions)
				: new SqliteAuthorityPersistence(targetOptions);
		const current = new AuthorityEngine(target, "new-owner");
		expect(current.recover().owner.phase).toBe("recovering");
		expect(() => current.authorizeLocalEffect(reserved)).toThrow();
		expect(() =>
			current.reconcileLocal({ claim: reserved, action: "commit", observedEntryHash: reserved.entryHash }),
		).toThrow();
		expect(() =>
			current.reconcileLocal({
				claim: { ...authorized, claimToken: "forged" },
				action: "commit",
				observedEntryHash: authorized.entryHash,
			}),
		).toThrow();
		expect(() =>
			current.reconcileLocal({ claim: authorized, action: "commit", observedEntryHash: "c".repeat(64) }),
		).toThrow();
		current.reconcileLocal({
			claim: reserved,
			action: "restore-predecessor",
			observedEntryHash: durableGenesisHash(),
		});
		current.reconcileLocal({ claim: authorized, action: "commit", observedEntryHash: authorized.entryHash });
		expect(current.recover().owner.phase).toBe("ready");
		current.transition(operation("intent"), { requestId: "new-mutation" });
		expect(target.exportState().frames.slice(0, seed.frames.length)).toEqual<readonly AuthorityCommitFrame[]>(
			seed.frames,
		);
		current.close();
		const reopenOptions: AuthorityDriverOptions = {
			path: targetOptions.path,
			identity: targetOptions.identity,
			create: false,
		};
		const reopened =
			backend === "jsonl"
				? new JsonlAuthorityPersistence(reopenOptions)
				: new SqliteAuthorityPersistence(reopenOptions);
		expect(reopened.get("local-entry", ["effect", "b", 1])?.record.phase).toBe("committed");
		expect(reopened.get("operation", ["actor-1", "eval", "op-1"])?.record.phase).toBe("intent");
		reopened.integrityCheck();
		reopened.close();
	});

	test("preserves ordered construction batches and rejects illegal intermediate edges", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const construction = {
			kind: "construction" as const,
			at: 1,
			actorId: "batch",
			rootId: "batch",
			generation: 1,
			startupHash: "1".repeat(64),
			provenanceHash: "2".repeat(64),
			phase: "reserved" as const,
		};
		engine.transitionBatch([
			construction,
			{ ...construction, phase: "constructing" },
			{ ...construction, phase: "constructed" },
		]);
		expect(driver.get("construction", ["batch", "batch", 1])?.record.phase).toBe("constructed");
		const other = { ...construction, actorId: "other", rootId: "other" };
		expect(() => engine.transitionBatch([other, { ...other, phase: "constructed" }])).toThrow();
		engine.transitionBatch([other, { ...other, phase: "abandoned" }]);
		expect(driver.get("construction", ["other", "other", 1])?.record.phase).toBe("abandoned");
		driver.integrityCheck();
		engine.close();
	});

	test("healthy empty and populated authority passes integrity", async () => {
		const driver = await openDriver(backend);
		driver.integrityCheck();
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		engine.transition(operation("intent"));
		driver.integrityCheck();
		engine.close();
	});
	test("rejects a phase skip and stale expected row version without changing authority", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();

		expect(() => engine.transition(operation("effect"), { requestId: "skip-phase" })).toThrow();
		expect(() =>
			engine.transitionBatch([operation("intent"), operation("effect")], { requestId: "batch-effect" }),
		).toThrow();
		expect(() =>
			engine.transition(operation("intent"), {
				requestId: "intent",
				expected: [{ domain: "operation", key: ["actor-1", "eval", "op-1"], version: 1 }],
			}),
		).toThrow();
		expect(driver.get("operation", ["actor-1", "eval", "op-1"])).toBeUndefined();
		driver.close();
	});

	test("commits root CAS with a closed source gate before destination activation", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const startupHash = "1".repeat(64);
		const provenanceHash = "2".repeat(64);
		const sourceHeadHash = durableRootHeadHash({
			rootId: "root",
			generation: 1,
			actorId: "root",
			startupHash,
			provenanceHash,
		});
		const sourceConstruction = {
			kind: "construction" as const,
			at: 1,
			actorId: "root",
			rootId: "root",
			generation: 1,
			startupHash,
			provenanceHash,
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				sourceConstruction,
				{ ...sourceConstruction, at: 2, phase: "constructing" },
				{ ...sourceConstruction, at: 3, phase: "constructed" },
			],
			{ requestId: "source-construction" },
		);
		engine.activateAuthority(
			{
				root: { kind: "root", at: 4, rootId: "root", generation: 1, headHash: sourceHeadHash, state: "active" },
				actor: {
					kind: "actor",
					at: 4,
					actorId: "root",
					rootId: "root",
					generation: 1,
					rootGeneration: 1,
					rootHeadHash: sourceHeadHash,
					startupHash,
					provenanceHash,
					state: "active",
				},
				construction: { ...sourceConstruction, at: 4, phase: "activated" },
				gate: { kind: "gate", at: 4, rootId: "root", generation: 1, phase: "open" },
			},
			{ requestId: "source-activation" },
		);
		const destinationStartupHash = "3".repeat(64);
		const destinationProvenanceHash = "4".repeat(64);
		const destinationHeadHash = durableRootHeadHash({
			rootId: "root",
			generation: 2,
			actorId: "root",
			startupHash: destinationStartupHash,
			provenanceHash: destinationProvenanceHash,
		});
		const rootTransition = {
			kind: "transition" as const,
			at: 5,
			transitionId: "root-switch",
			rootId: "root",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash,
			destinationHeadHash,
		};
		engine.transitionBatch(
			[
				{ ...rootTransition, phase: "staged" },
				{ ...rootTransition, phase: "quiescing" },
				{ ...rootTransition, phase: "quiesced" },
				{ ...rootTransition, phase: "validated" },
				{ kind: "gate", at: 5, rootId: "root", generation: 1, phase: "quiesced" },
			],
			{ requestId: "validate-root-switch" },
		);
		const casPrefix = driver.exportState();
		const revision = casPrefix.revision;
		engine.commitRootTransition(
			{
				transition: { ...rootTransition, phase: "cas-committed" },
				expectedRootGeneration: 1,
				expectedRootHeadHash: sourceHeadHash,
				root: {
					kind: "root",
					at: 6,
					rootId: "root",
					generation: 2,
					headHash: destinationHeadHash,
					state: "active",
				},
				gate: { kind: "gate", at: 6, rootId: "root", generation: 1, phase: "closed" },
			},
			{ requestId: "root-switch-cas" },
		);
		const casFrame = driver.exportState().frames.at(-1)!;
		if (casFrame.command.kind !== "commit-root-transition") throw new Error("Root CAS command frame is missing.");
		const forgedCas = rehashFrame({
			...casFrame,
			command: { ...casFrame.command, transition: { ...casFrame.command.transition, expectedRootGeneration: 2 } },
		});
		expect(() => validateAuthorityFrame(forgedCas, casPrefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(forgedCas, exportedFrameState(casPrefix))).toThrow(
			"Root transition identity or source compare-and-swap changed.",
		);
		expect((driver.getControl("meta") as AuthorityMeta).revision).toBe(revision + 1);
		expect(engine.getRoot("root")?.record).toMatchObject({ generation: 2, headHash: destinationHeadHash });
		expect(engine.getGate("root")?.record).toMatchObject({ generation: 1, phase: "closed" });
		expect(engine.getTransition("root", "root-switch")?.record.phase).toBe("cas-committed");
		const destinationConstruction = {
			kind: "construction" as const,
			at: 7,
			actorId: "root",
			rootId: "root",
			generation: 2,
			startupHash: destinationStartupHash,
			provenanceHash: destinationProvenanceHash,
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				destinationConstruction,
				{ ...destinationConstruction, at: 8, phase: "constructing" },
				{ ...destinationConstruction, at: 9, phase: "constructed" },
			],
			{ requestId: "destination-construction" },
		);
		engine.activateAuthority(
			{
				actor: {
					kind: "actor",
					at: 10,
					actorId: "root",
					rootId: "root",
					generation: 2,
					rootGeneration: 2,
					rootHeadHash: destinationHeadHash,
					startupHash: destinationStartupHash,
					provenanceHash: destinationProvenanceHash,
					state: "active",
				},
				construction: { ...destinationConstruction, at: 10, phase: "activated" },
				gate: { kind: "gate", at: 10, rootId: "root", generation: 2, phase: "open" },
			},
			{ requestId: "destination-activation" },
		);
		expect(engine.getGate("root")?.record).toMatchObject({ generation: 2, phase: "open" });
		engine.transition({ ...rootTransition, at: 11, phase: "activated" }, { requestId: "root-switch-activated" });
		engine.transition({ ...rootTransition, at: 12, phase: "retired" }, { requestId: "root-switch-retired" });
		engine.close();
	});
	test("rejects request-id reuse with a different payload and keeps the original receipt", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const intent = operation("intent");
		const receipt = engine.transition(intent, { requestId: "same-request" });
		expect(() => engine.transition({ ...intent, phase: "effect" }, { requestId: "same-request" })).toThrow();
		expect(engine.getOperation("actor-1", "eval", "op-1")?.record.phase).toBe("intent");
		expect(
			driver.getControl(`receipt:${JSON.stringify([receipt.incarnation, receipt.ownerEpoch, receipt.requestId])}`),
		).toEqual(receipt);
		engine.close();
	});

	test("resolves a committed receipt after reopening without retrying the command", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-receipt-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
			identity,
			create: true,
		};
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const record = operation("intent");
		engine.transition(record, { requestId: "lost-ack" });
		const owner = driver.getControl("owner") as AuthorityOwner;
		const payloadHash = canonicalDurableSha256({ kind: "transition", record });
		engine.close();
		const reopened =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		const recovering = new AuthorityEngine(reopened, "owner-token-2");
		const receipt = recovering.resolveReceipt("lost-ack", owner.epoch, identity.incarnation, payloadHash);
		expect(receipt).toMatchObject({
			requestId: "lost-ack",
			payloadHash,
			incarnation: identity.incarnation,
			revision: 3,
		});
		expect(recovering.getOperation("actor-1", "eval", "op-1")?.record.phase).toBe("intent");
		recovering.close();
	});
	test("resolves the exact staged receipt-control value through the private persistence query", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "staged-receipt-owner");
		engine.recover();
		const staged = stagedOwnerFrame(driver);
		const receiptKey = `receipt:${JSON.stringify([staged.receipt.incarnation, staged.receipt.ownerEpoch, staged.receipt.requestId])}`;
		const originalControl = staged.controls.find(change => change.key === receiptKey);
		if (
			!originalControl ||
			originalControl.deleted ||
			!originalControl.value ||
			typeof originalControl.value !== "object" ||
			Array.isArray(originalControl.value)
		)
			throw new Error("Staged receipt fixture lacks its logical receipt control.");
		const reorderedControl = Object.fromEntries(Object.entries(originalControl.value).reverse());
		const reorderedFrame = {
			...staged,
			controls: staged.controls.map(change =>
				change.key === receiptKey && !change.deleted ? { ...change, value: reorderedControl } : change,
			),
		};
		const expected = JSON.stringify(reorderedControl);
		driver.transaction(() => {
			driver.commit(reorderedFrame);
			expect(JSON.stringify(engine.resolveReceipt(staged.request.requestId))).toBe(expected);
		});
		expect(JSON.stringify(engine.resolveReceipt(staged.request.requestId))).toBe(expected);
		driver.close();
	});
	test("selects the first matching receipt control key before payload filtering across epochs", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-receipt-order-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
			identity,
			create: true,
		};
		let driver: AuthorityPersistence =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		let engine = new AuthorityEngine(driver, "receipt-order-owner-1");
		for (let expectedEpoch = 1; expectedEpoch <= 10; expectedEpoch++) {
			engine.recover();
			const owner = driver.getControl("owner") as AuthorityOwner;
			if (owner.epoch === 2 || owner.epoch === 10) {
				const record = { ...operation("intent"), operationId: `receipt-order-${owner.epoch}` };
				engine.transition(record, { requestId: "ordered-receipt" });
				engine.transition(
					{ ...record, at: 11, phase: "effect" },
					{ requestId: `receipt-order-${owner.epoch}-effect` },
				);
				engine.transition(
					{ ...record, at: 12, phase: "committed" },
					{ requestId: `receipt-order-${owner.epoch}-committed` },
				);
				engine.transition(
					{ ...record, at: 13, phase: "completed" },
					{ requestId: `receipt-order-${owner.epoch}-completed` },
				);
			}
			if (owner.epoch === 10) break;
			engine.close();
			const reopenedOptions = { ...options, create: false };
			driver =
				backend === "jsonl"
					? new JsonlAuthorityPersistence(reopenedOptions)
					: new SqliteAuthorityPersistence(reopenedOptions);
			engine = new AuthorityEngine(driver, `receipt-order-owner-${expectedEpoch + 1}`);
		}
		const snapshot = driver.exportState();
		const receipts = snapshot.frames
			.map(frame => frame.receipt)
			.filter(receipt => receipt.requestId === "ordered-receipt");
		const epochTwo = receipts.find(receipt => receipt.ownerEpoch === 2);
		const epochTen = receipts.find(receipt => receipt.ownerEpoch === 10);
		if (!epochTwo || !epochTen) throw new Error("Receipt-order fixture did not persist epochs two and ten.");
		expect(engine.resolveReceipt("ordered-receipt")).toEqual(epochTen);
		expect(engine.resolveReceipt("ordered-receipt", undefined, undefined, epochTwo.payloadHash)).toEqual(epochTwo);
		expect(engine.resolveReceipt("ordered-receipt", undefined, identity.incarnation, "f".repeat(64))).toBeUndefined();
		expect(() => engine.resolveReceipt("ordered-receipt", 2, identity.incarnation, epochTen.payloadHash)).toThrow(
			/different payload/i,
		);
		engine.close();
	});

	test("keeps an uncertain first local publication claimed until exact backing reconciliation", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const claim = engine.reserveLocal(
			{
				localId: "repo",
				entryId: "entry-1",
				entryHash: "a".repeat(64),
				expectedHeadHash: durableGenesisHash(),
			},
			{ requestId: "reserve" },
		);
		engine.authorizeLocalEffect(claim, { requestId: "authorize" });
		const effectClaim = { ...claim, phase: "effect" as const };
		engine.finalizeLocal(effectClaim, "uncertain", { requestId: "uncertain" });
		expect(engine.localBacking("repo")).toBeNull();
		expect(() =>
			engine.reserveLocal(
				{
					localId: "repo",
					entryId: "entry-2",
					entryHash: "b".repeat(64),
					expectedHeadHash: durableGenesisHash(),
				},
				{ requestId: "second" },
			),
		).toThrow();
		engine.reconcileLocal(
			{ claim: { ...effectClaim, phase: "uncertain" }, observedEntryHash: "a".repeat(64), action: "commit" },
			{ requestId: "reconcile" },
		);
		expect(engine.localBacking("repo")).toMatchObject({ entryId: "entry-1", entryHash: "a".repeat(64), version: 1 });
		driver.close();
	});

	test("rejects stale local-head compare-and-swap without changing committed evidence", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const claim = engine.reserveLocal(
			{ localId: "repo-head", entryId: "first", entryHash: "a".repeat(64), expectedHeadHash: durableGenesisHash() },
			{ requestId: "local-head-reserve" },
		);
		engine.authorizeLocalEffect(claim, { requestId: "local-head-authorize" });
		engine.finalizeLocal({ ...claim, phase: "effect" as const }, "committed", { requestId: "local-head-commit" });
		const before = engine.exportState();
		expect(() =>
			engine.reserveLocal(
				{
					localId: "repo-head",
					entryId: "stale",
					entryHash: "b".repeat(64),
					expectedHeadHash: durableGenesisHash(),
				},
				{ requestId: "stale-local-head" },
			),
		).toThrow();
		expect(engine.exportState()).toEqual(before);
		expect(engine.localBacking("repo-head")).toMatchObject({
			entryId: "first",
			entryHash: "a".repeat(64),
			version: 1,
		});
		engine.close();
	});

	test("admits only the exact committed predecessor and next local version on reservation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-reservation-admission-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source"), identity, create: true };
		const createDriver = (options: AuthorityDriverOptions): AuthorityPersistence =>
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const driver = createDriver(sourceOptions);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const localId = "reservation-local";
		const first = engine.reserveLocal(
			{ localId, entryId: "first", entryHash: "a".repeat(64), expectedHeadHash: durableGenesisHash() },
			{ requestId: "first-reservation" },
		);
		engine.authorizeLocalEffect(first, { requestId: "first-authorization" });
		engine.finalizeLocal({ ...first, phase: "effect" }, "committed", { requestId: "first-commit" });
		const prefix = driver.exportState();
		const backing = engine.localBacking(localId);
		if (!backing) throw new Error("Test fixture did not commit its initial local head.");
		const staleInput = {
			localId,
			entryId: "stale",
			entryHash: "b".repeat(64),
			expectedHeadHash: durableGenesisHash(),
		};
		expect(() => engine.reserveLocal(staleInput, { requestId: "stale-predecessor" })).toThrow(
			"Local expected head does not match current durable head.",
		);
		expect(driver.exportState()).toEqual(prefix);

		const successorInput = {
			localId,
			entryId: "successor",
			entryHash: "c".repeat(64),
			expectedHeadHash: backing.headHash,
		};
		const successor = engine.reserveLocal(successorInput, { requestId: "valid-successor" });
		const successorFrame = driver.exportState().frames.at(-1)!;
		if (successorFrame.command.kind !== "reserve-local" || successorFrame.receipt.result.kind !== "local-claim")
			throw new Error("Test fixture did not retain its named local reservation frame.");
		const expectedSuccessorHead = canonicalDurableSha256({
			localId,
			entryId: successorInput.entryId,
			version: backing.version + 1,
			previousHeadHash: backing.headHash,
			entryHash: successorInput.entryHash,
		});
		expect(successor).toMatchObject({
			version: backing.version + 1,
			previousHeadHash: backing.headHash,
			headHash: expectedSuccessorHead,
		});
		expect(() => validateAuthorityFrameState(successorFrame, exportedFrameState(prefix))).not.toThrow();

		const staleHeadHash = canonicalDurableSha256({
			localId,
			entryId: successorInput.entryId,
			version: successor.version,
			previousHeadHash: durableGenesisHash(),
			entryHash: successorInput.entryHash,
		});
		const staleClaim: LocalClaim = { ...successor, previousHeadHash: durableGenesisHash(), headHash: staleHeadHash };
		const claimKey = `local-claim:${JSON.stringify(localId)}`;
		const forgedFrame = rehashFrame({
			...successorFrame,
			command: {
				...successorFrame.command,
				input: { ...successorFrame.command.input, expectedHeadHash: durableGenesisHash() },
			},
			changes: successorFrame.changes.map(row =>
				row.record.kind === "local-entry"
					? { ...row, record: { ...row.record, expectedHeadHash: durableGenesisHash(), headHash: staleHeadHash } }
					: row,
			),
			controls: successorFrame.controls.map(change =>
				change.key === claimKey ? { ...change, value: staleClaim } : change,
			),
			receipt: { ...successorFrame.receipt, result: { kind: "local-claim", claim: staleClaim } },
		});
		expect(() => validateAuthorityFrame(forgedFrame, prefix.headHash)).not.toThrow();
		expect(() => validateAuthorityFrameState(forgedFrame, exportedFrameState(prefix))).toThrow(
			"Local expected head does not match current durable head.",
		);

		const validOptions: AuthorityDriverOptions = {
			path: path.join(directory, "valid-seed"),
			identity,
			create: true,
			seed: exportWithFrame(prefix, successorFrame),
		};
		const baseline = createDriver(validOptions);
		try {
			baseline.integrityCheck();
			expect(baseline.getControl(claimKey)).toEqual(successor);
			expect(baseline.get("local-entry", [localId, successor.entryId, successor.version])?.record.headHash).toBe(
				expectedSuccessorHead,
			);
		} finally {
			baseline.close();
		}
		const invalidOptions: AuthorityDriverOptions = {
			path: path.join(directory, "invalid-seed"),
			identity,
			create: true,
			seed: exportWithFrame(prefix, forgedFrame),
		};
		expect(() => createDriver(invalidOptions)).toThrow("Local expected head does not match current durable head.");
		const integrityOptions: AuthorityDriverOptions = {
			path: path.join(directory, "integrity"),
			identity,
			create: true,
			seed: prefix,
		};
		const integrity = createDriver(integrityOptions);
		try {
			if (backend === "jsonl") await fs.appendFile(integrityOptions.path, `${JSON.stringify(forgedFrame)}\n`);
			else integrity.transaction(() => integrity.commit(forgedFrame));
			expect(() => integrity.integrityCheck()).toThrow("Local expected head does not match current durable head.");
		} finally {
			integrity.close();
		}
		engine.close();
	});

	test("preserves first-parent generations and high-water while recovery closes an unresolved root gate", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-lineage-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
			identity,
			create: true,
		};
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const startupHash = "1".repeat(64);
		const provenanceHash = "2".repeat(64);
		const rootHeadHash = durableRootHeadHash({
			rootId: "root",
			generation: 1,
			actorId: "root",
			startupHash,
			provenanceHash,
		});
		const root = {
			kind: "root" as const,
			at: 1,
			rootId: "root",
			generation: 1,
			headHash: rootHeadHash,
			state: "active" as const,
		};
		const rootActor = {
			kind: "actor" as const,
			at: 1,
			actorId: "root",
			rootId: "root",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash,
			startupHash,
			provenanceHash,
			state: "active" as const,
		};
		const rootConstruction = {
			kind: "construction" as const,
			at: 1,
			actorId: "root",
			rootId: "root",
			generation: 1,
			startupHash,
			provenanceHash,
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				rootConstruction,
				{ ...rootConstruction, at: 2, phase: "constructing" },
				{ ...rootConstruction, at: 3, phase: "constructed" },
			],
			{ requestId: "root-construction" },
		);
		engine.activateAuthority(
			{
				root,
				actor: rootActor,
				construction: { ...rootConstruction, at: 4, phase: "activated" },
				gate: { kind: "gate", at: 4, rootId: "root", generation: 1, phase: "open" },
			},
			{ requestId: "root-activation" },
		);
		const childStartupHash = "3".repeat(64);
		const childProvenanceHash = "4".repeat(64);
		const childConstruction = {
			kind: "construction" as const,
			at: 5,
			actorId: "child",
			rootId: "root",
			parentId: "root",
			generation: 1,
			startupHash: childStartupHash,
			provenanceHash: childProvenanceHash,
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				childConstruction,
				{ ...childConstruction, at: 6, phase: "constructing" },
				{ ...childConstruction, at: 7, phase: "constructed" },
			],
			{ requestId: "child-construction" },
		);
		const child = {
			kind: "actor" as const,
			at: 8,
			actorId: "child",
			rootId: "root",
			parentId: "root",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash,
			startupHash: childStartupHash,
			provenanceHash: childProvenanceHash,
			state: "active" as const,
		};
		engine.activateAuthority(
			{ actor: child, construction: { ...childConstruction, at: 8, phase: "activated" } },
			{ requestId: "child-activation" },
		);
		const abandoned = {
			kind: "construction" as const,
			at: 9,
			actorId: "later",
			rootId: "root",
			parentId: "root",
			generation: 9,
			startupHash: "5".repeat(64),
			provenanceHash: "6".repeat(64),
			phase: "reserved" as const,
		};
		engine.transitionBatch([abandoned, { ...abandoned, at: 10, phase: "abandoned" }], {
			requestId: "abandoned-high-water",
		});
		const childLineage = engine
			.exportState()
			.controls.find(control => control.key === 'actor-generation:["child",1]');
		expect(childLineage?.value).toMatchObject({ parentGeneration: 1 });
		const rootTransition = {
			kind: "transition" as const,
			transitionId: "replace-root",
			rootId: "root",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: rootHeadHash,
			destinationHeadHash: "7".repeat(64),
		};
		engine.transitionBatch(
			[
				{ ...rootTransition, at: 11, phase: "staged" },
				{ ...rootTransition, at: 12, phase: "quiescing" },
				{ kind: "gate", at: 12, rootId: "root", generation: 1, phase: "quiescing" },
			],
			{ requestId: "interrupted-root-transition" },
		);
		engine.close();

		const reopened =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		const recovering = new AuthorityEngine(reopened, "owner-token-2");
		const recovered = recovering.recover();
		expect(recovered.generationHighWater).toBe(9);
		expect(recovered.blocked).toEqual(["transition:root:replace-root:quiescing"]);
		expect(recovered.owner.phase).toBe("recovering");
		expect(recovering.getTransition("root", "replace-root")?.record.phase).toBe("quiescing");
		expect(recovering.getRoot("root")?.record.state).toBe("active");
		expect(recovering.getGate("root")?.record.phase).toBe("closed");
		recovering.close();
	});
	test("discards a staged commit when the transaction callback fails", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const before = driver.getControl("owner");
		const beforeExport = driver.exportState();
		const frame = stagedOwnerFrame(driver);
		const stagedOwner = frame.controls.find(change => change.key === "owner");
		if (!stagedOwner || stagedOwner.deleted !== false) throw new Error("Staged owner frame must update owner.");
		expect(() =>
			driver.transaction(() => {
				driver.commit(frame);
				expect(driver.getControl("owner")).toEqual(stagedOwner.value);
				throw new Error("abort staged transaction");
			}),
		).toThrow("abort staged transaction");
		expect(driver.getControl("owner")).toEqual(before);
		expect(driver.exportState().revision).toBe(frame.revision - 1);
		expect(driver.exportState()).toEqual(beforeExport);
		driver.close();
	});
	test("imports legacy ordinals and lineage without inventing receipts", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-legacy-"));
		temporaryDirectories.push(directory);
		const legacyPath = path.join(directory, "legacy.jsonl");
		const legacyStore = new RegistryDurableStateStore(legacyPath);
		const startupHash = "1".repeat(64);
		const provenanceHash = "2".repeat(64);
		const headHash = durableRootHeadHash({
			rootId: "root",
			generation: 1,
			actorId: "root",
			startupHash,
			provenanceHash,
		});
		legacyStore.append({ kind: "root", at: 1, rootId: "root", generation: 1, headHash, state: "active" });
		legacyStore.append({
			kind: "actor",
			at: 2,
			actorId: "root",
			rootId: "root",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: headHash,
			startupHash,
			provenanceHash,
			state: "active",
		});
		const sourceBytes = await fs.readFile(legacyPath);
		const imported = importLegacyAuthorityJournal(legacyPath);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const seed = authorityExportFromLegacy(identity, imported);
		const fromEmbeddedSource = authorityExportFromLegacySource(identity, {
			sourceSha256: imported.sourceSha256,
			entries: imported.entries,
		});
		expect(fromEmbeddedSource.rows).toEqual(seed.rows);
		expect(fromEmbeddedSource.controls).toEqual(seed.controls);
		const alteredRoots = new Map(imported.snapshot.roots);
		alteredRoots.set("root", { ...imported.snapshot.roots.get("root")!, state: "retired" });
		const fabricatedSnapshot = { ...imported, snapshot: { ...imported.snapshot, roots: alteredRoots } };
		expect(() => authorityExportFromLegacy(identity, fabricatedSnapshot)).toThrow();
		const brokenEntries = [imported.entries[0]!, { ...imported.entries[1]!, previousHash: "f".repeat(64) }];
		expect(() =>
			authorityExportFromLegacySource(identity, { sourceSha256: imported.sourceSha256, entries: brokenEntries }),
		).toThrow();
		expect(imported.sourceSha256).toBe(durableBackingSha256(sourceBytes));
		expect(imported.entries.map(entry => entry.sequence)).toEqual([1, 2]);
		expect(seed.frames).toEqual([]);
		expect(seed.legacy?.entries).toEqual(imported.entries);
		expect(seed.controls.some(control => control.key.startsWith("receipt:"))).toBe(false);
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "imported.jsonl" : "imported.sqlite"),
			identity,
			create: true,
			seed,
		};
		const importedDriver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		expect(importedDriver.get("root", ["root"])?.record.headHash).toBe(headHash);
		const actorHistory = importedDriver.getControl('actor-generation:["root",1]');
		expect(actorHistory).toMatchObject({ row: { record: { actorId: "root", generation: 1 } } });
		expect(importedDriver.exportState().legacy?.entries.map(entry => entry.sequence)).toEqual([1, 2]);
		importedDriver.close();
	});
	test("recovery is repeatable and safely reconciles a crash-retained reservation from the new owner", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-reserved-recovery-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
			identity,
			create: true,
		};
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const firstOwner = new AuthorityEngine(driver, "owner-token");
		firstOwner.recover();
		const revision = (driver.getControl("meta") as AuthorityMeta).revision;
		expect(firstOwner.recover().owner.phase).toBe("ready");
		expect((driver.getControl("meta") as AuthorityMeta).revision).toBe(revision);
		firstOwner.reserveLocal(
			{ localId: "repo", entryId: "reserved", entryHash: "a".repeat(64), expectedHeadHash: durableGenesisHash() },
			{ requestId: "reserved-before-crash" },
		);
		firstOwner.close();

		const reopened =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		const recovering = new AuthorityEngine(reopened, "owner-token-after-crash");
		expect(recovering.recover().blocked).toContain(`local-claim:${JSON.stringify("repo")}`);
		const staleClaim = localClaimFrom(reopened, "repo");
		recovering.reconcileLocal(
			{ claim: staleClaim, observedEntryHash: durableGenesisHash(), action: "restore-predecessor" },
			{ requestId: "cancel-unstarted-reservation" },
		);
		expect(recovering.recover().owner.phase).toBe("ready");
		expect(reopened.getControl(`local-claim:${JSON.stringify("repo")}`)).toBeUndefined();
		expect(recovering.getLocalEntry("repo", "reserved", 1)?.record.phase).toBe("cancelled");
		recovering.close();
	});

	test("reconciles a crash-retained authorized local effect only against observed exact bytes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-effect-recovery-"));
		temporaryDirectories.push(directory);
		const identity: AuthorityIdentity = {
			backend,
			owningSessionId: "root-session",
			incarnation: crypto.randomUUID(),
			format: 2,
		};
		const options: AuthorityDriverOptions = {
			path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
			identity,
			create: true,
		};
		const driver =
			backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
		const firstOwner = new AuthorityEngine(driver, "owner-token");
		firstOwner.recover();
		const claim = firstOwner.reserveLocal(
			{ localId: "repo", entryId: "effect", entryHash: "b".repeat(64), expectedHeadHash: durableGenesisHash() },
			{ requestId: "effect-reserve" },
		);
		firstOwner.authorizeLocalEffect(claim, { requestId: "effect-authorize" });
		firstOwner.close();

		const reopened =
			backend === "jsonl"
				? new JsonlAuthorityPersistence({ ...options, create: false })
				: new SqliteAuthorityPersistence({ ...options, create: false });
		const recovering = new AuthorityEngine(reopened, "owner-token-after-crash");
		expect(recovering.recover().owner.phase).toBe("recovering");
		const staleClaim = localClaimFrom(reopened, "repo");
		expect(() =>
			recovering.reconcileLocal(
				{ claim: staleClaim, observedEntryHash: "c".repeat(64), action: "commit" },
				{ requestId: "unproven-effect" },
			),
		).toThrow();
		recovering.reconcileLocal(
			{ claim: staleClaim, observedEntryHash: "b".repeat(64), action: "commit" },
			{ requestId: "reconcile-effect-bytes" },
		);
		expect(recovering.recover().owner.phase).toBe("ready");
		expect(recovering.localBacking("repo")).toMatchObject({ entryId: "effect", entryHash: "b".repeat(64) });
		recovering.close();
	});

	test("activation rejects incoherent construction, root identity, gate, and root-generation bypass", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const source = installRoot(engine);
		const childConstruction = {
			kind: "construction" as const,
			at: 10,
			actorId: "child",
			rootId: "root",
			parentId: "root",
			generation: 1,
			startupHash: "3".repeat(64),
			provenanceHash: "4".repeat(64),
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				childConstruction,
				{ ...childConstruction, at: 11, phase: "constructing" },
				{ ...childConstruction, at: 12, phase: "constructed" },
			],
			{ requestId: "child-construction" },
		);
		const child = {
			kind: "actor" as const,
			at: 13,
			actorId: "child",
			rootId: "root",
			parentId: "root",
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: source.headHash,
			startupHash: "5".repeat(64),
			provenanceHash: childConstruction.provenanceHash,
			state: "active" as const,
		};
		expect(() =>
			engine.activateAuthority(
				{ actor: child, construction: { ...childConstruction, at: 13, phase: "activated" } },
				{ requestId: "mismatched-startup" },
			),
		).toThrow();
		expect(() =>
			engine.activateAuthority(
				{
					actor: { ...child, startupHash: childConstruction.startupHash, generation: 2 },
					construction: { ...childConstruction, at: 13, phase: "activated" },
				},
				{ requestId: "root-generation-mismatch" },
			),
		).toThrow();
		expect(() =>
			engine.activateAuthority(
				{
					actor: { ...child, startupHash: childConstruction.startupHash },
					construction: { ...childConstruction, at: 13, phase: "activated" },
					gate: { kind: "gate", at: 13, rootId: "other-root", generation: 1, phase: "open" },
				},
				{ requestId: "unrelated-gate" },
			),
		).toThrow();
		const nextStartup = "6".repeat(64);
		const nextProvenance = "7".repeat(64);
		const nextHead = durableRootHeadHash({
			rootId: "root",
			generation: 2,
			actorId: "root",
			startupHash: nextStartup,
			provenanceHash: nextProvenance,
		});
		const nextConstruction = {
			kind: "construction" as const,
			at: 14,
			actorId: "root",
			rootId: "root",
			generation: 2,
			startupHash: nextStartup,
			provenanceHash: nextProvenance,
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				nextConstruction,
				{ ...nextConstruction, at: 15, phase: "constructing" },
				{ ...nextConstruction, at: 16, phase: "constructed" },
			],
			{ requestId: "uncommitted-root-construction" },
		);
		expect(() =>
			engine.activateAuthority(
				{
					root: { kind: "root", at: 17, rootId: "root", generation: 2, headHash: nextHead, state: "active" },
					actor: {
						kind: "actor",
						at: 17,
						actorId: "root",
						rootId: "root",
						generation: 2,
						rootGeneration: 2,
						rootHeadHash: nextHead,
						startupHash: nextStartup,
						provenanceHash: nextProvenance,
						state: "active",
					},
					construction: { ...nextConstruction, at: 17, phase: "activated" },
					gate: { kind: "gate", at: 17, rootId: "root", generation: 2, phase: "open" },
				},
				{ requestId: "activation-cas-bypass" },
			),
		).toThrow();
		expect(engine.getRoot("root")?.record).toEqual(source.root);
		expect(engine.getActor("child")).toBeUndefined();
		engine.transition(
			{ kind: "gate", at: 18, rootId: "root", generation: 1, phase: "closed" },
			{ requestId: "close-root-gate" },
		);
		const closedGateConstruction = {
			...childConstruction,
			actorId: "closed-gate-child",
			at: 19,
			startupHash: "a".repeat(64),
			phase: "reserved" as const,
		};
		engine.transitionBatch(
			[
				closedGateConstruction,
				{ ...closedGateConstruction, at: 20, phase: "constructing" },
				{ ...closedGateConstruction, at: 21, phase: "constructed" },
			],
			{ requestId: "closed-gate-construction" },
		);
		expect(() =>
			engine.activateAuthority(
				{
					actor: { ...child, actorId: "closed-gate-child", startupHash: closedGateConstruction.startupHash },
					construction: { ...closedGateConstruction, at: 22, phase: "activated" },
				},
				{ requestId: "admit-with-closed-gate" },
			),
		).toThrow();
		engine.close();
	});

	test("root replacement recovery is constrained to pre-CAS state and preserves consumed generation", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const source = installRoot(engine);
		const transition = {
			kind: "transition" as const,
			at: 20,
			transitionId: "replace",
			rootId: "root",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: source.headHash,
			destinationHeadHash: "8".repeat(64),
		};
		engine.transitionBatch(
			[
				{ ...transition, phase: "staged" },
				{ ...transition, at: 21, phase: "quiescing" },
				{ ...transition, at: 22, phase: "quiesced" },
				{ ...transition, at: 23, phase: "validated" },
				{ kind: "gate", at: 23, rootId: "root", generation: 1, phase: "quiesced" },
			],
			{ requestId: "validated-before-cas" },
		);
		engine.commitRootTransition(
			{
				transition: { ...transition, at: 24, phase: "recovered", recovery: true },
				expectedRootGeneration: 1,
				expectedRootHeadHash: source.headHash,
				root: source.root,
				gate: { kind: "gate", at: 24, rootId: "root", generation: 1, phase: "open" },
			},
			{ requestId: "recover-before-cas" },
		);
		expect(engine.getRoot("root")?.record).toEqual(source.root);
		expect(engine.getGate("root")?.record).toMatchObject({ generation: 1, phase: "open" });
		expect(engine.getTransition("root", "replace")?.record).toMatchObject({ phase: "recovered", recovery: true });
		expect(driver.getControl('root-generation:["root",2]')).toMatchObject({
			record: { state: "invalidated", generation: 2, headHash: transition.destinationHeadHash },
		});
		expect((driver.getControl("meta") as AuthorityMeta).generationHighWater).toBe(2);
		const revision = (driver.getControl("meta") as AuthorityMeta).revision;
		expect(engine.recover().owner.phase).toBe("ready");
		expect((driver.getControl("meta") as AuthorityMeta).revision).toBe(revision);
		const retry = { ...transition, transitionId: "retry-consumed-generation" };
		engine.transitionBatch([
			{ ...retry, phase: "staged" },
			{ ...retry, phase: "quiescing" },
			{ ...retry, phase: "quiesced" },
			{ ...retry, phase: "validated" },
			{ ...source.gate, at: 25, phase: "quiesced" },
		]);
		const beforeRetry = driver.exportState();
		expect(() =>
			engine.commitRootTransition({
				transition: { ...retry, at: 26, phase: "cas-committed" },
				expectedRootGeneration: 1,
				expectedRootHeadHash: source.headHash,
				root: { ...source.root, at: 26, generation: 2, headHash: retry.destinationHeadHash },
				gate: { ...source.gate, at: 26, phase: "closed" },
			}),
		).toThrow();
		expect(driver.exportState()).toEqual(beforeRetry);
		driver.integrityCheck();
		engine.close();
	});

	test("refuses source restoration after root-transition CAS commits", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const source = installRoot(engine);
		const destinationHead = "9".repeat(64);
		const transition = {
			kind: "transition" as const,
			at: 20,
			transitionId: "forward-only",
			rootId: "root",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: source.headHash,
			destinationHeadHash: destinationHead,
		};
		engine.transitionBatch(
			[
				{ ...transition, phase: "staged" },
				{ ...transition, at: 21, phase: "quiescing" },
				{ ...transition, at: 22, phase: "quiesced" },
				{ ...transition, at: 23, phase: "validated" },
				{ kind: "gate", at: 23, rootId: "root", generation: 1, phase: "quiesced" },
			],
			{ requestId: "forward-transition-staging" },
		);
		engine.commitRootTransition(
			{
				transition: { ...transition, at: 24, phase: "cas-committed" },
				expectedRootGeneration: 1,
				expectedRootHeadHash: source.headHash,
				root: { kind: "root", at: 24, rootId: "root", generation: 2, headHash: destinationHead, state: "active" },
				gate: { kind: "gate", at: 24, rootId: "root", generation: 1, phase: "closed" },
			},
			{ requestId: "forward-transition-cas" },
		);
		expect(() =>
			engine.commitRootTransition(
				{
					transition: { ...transition, at: 25, phase: "recovered", recovery: true },
					expectedRootGeneration: 1,
					expectedRootHeadHash: source.headHash,
					root: source.root,
					gate: { kind: "gate", at: 25, rootId: "root", generation: 1, phase: "open" },
				},
				{ requestId: "forbidden-post-cas-recovery" },
			),
		).toThrow();
		expect(engine.getRoot("root")?.record).toMatchObject({
			generation: 2,
			headHash: destinationHead,
			state: "active",
		});
		expect(engine.getGate("root")?.record).toMatchObject({ generation: 1, phase: "closed" });
		expect(engine.getTransition("root", "forward-only")?.record.phase).toBe("cas-committed");
		engine.close();
	});

	test("prevents transition retirement skips and generic recovered-phase bypass", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const transition = {
			kind: "transition" as const,
			at: 1,
			transitionId: "skip",
			rootId: "root",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: "1".repeat(64),
			destinationHeadHash: "2".repeat(64),
		};
		engine.transition({ ...transition, phase: "staged" }, { requestId: "stage" });
		expect(() =>
			engine.transition({ ...transition, at: 2, phase: "retired" }, { requestId: "skip-to-retired" }),
		).toThrow();
		expect(() =>
			engine.transition(
				{ ...transition, at: 2, phase: "recovered", recovery: true },
				{ requestId: "generic-recovered" },
			),
		).toThrow();
		expect(engine.getTransition("root", "skip")?.record.phase).toBe("staged");
		engine.close();
	});

	test("enforces exact row versions and immutable identities across shared domains", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		engine.transition(operation("intent"), {
			requestId: "version-one",
			expected: [{ domain: "operation", key: ["actor-1", "eval", "op-1"], version: null }],
		});
		engine.transition(operation("effect"), {
			requestId: "version-two",
			expected: [{ domain: "operation", key: ["actor-1", "eval", "op-1"], version: 1 }],
		});
		const before = engine.exportState();
		expect(() =>
			engine.transition(operation("committed"), {
				requestId: "stale-version",
				expected: [{ domain: "operation", key: ["actor-1", "eval", "op-1"], version: 1 }],
			}),
		).toThrow();
		expect(engine.exportState()).toEqual(before);
		const root = installRoot(engine, "immutable-root");
		const resource = {
			kind: "resource" as const,
			at: 10,
			resourceId: "resource",
			resourceClass: "filesystem" as const,
			operationId: "resource-operation",
			actorId: "immutable-root",
			rootId: "immutable-root",
			generation: 1,
			targetHash: "9".repeat(64),
			phase: "intent" as const,
		};
		engine.transition(resource, { requestId: "resource-intent" });
		expect(() =>
			engine.transition(
				{ ...resource, at: 11, operationId: "different-operation", phase: "effect" },
				{ requestId: "resource-identity-change" },
			),
		).toThrow();
		expect(() =>
			engine.transition({ ...resource, at: 12, phase: "completed" }, { requestId: "resource-phase-skip" }),
		).toThrow();
		const skippedConstruction = {
			kind: "construction" as const,
			at: 12,
			actorId: "unreserved",
			rootId: "immutable-root",
			parentId: "immutable-root",
			generation: 1,
			startupHash: "3".repeat(64),
			provenanceHash: "4".repeat(64),
			phase: "constructing" as const,
		};
		expect(() => engine.transition(skippedConstruction, { requestId: "construction-phase-skip" })).toThrow();
		const openGate = engine.getGate("immutable-root")!.record;
		engine.transition({ ...openGate, at: 12, phase: "quiesced" }, { requestId: "quiesce-gate" });
		expect(() =>
			engine.transition({ ...openGate, at: 13, phase: "open" }, { requestId: "reopen-quiesced-gate" }),
		).toThrow();
		const actor = { ...root.actor, at: 12, state: "aborted" as const };
		engine.transition(actor, { requestId: "actor-abort" });
		expect(() =>
			engine.transition({ ...actor, at: 13, state: "active" }, { requestId: "actor-terminal-reuse" }),
		).toThrow();
		expect(engine.getResource("immutable-root", 1, "resource")?.record).toEqual(resource);
		engine.close();
	});

	test("frame validation rejects unrelated owner controls, result kinds, and inconsistent generation high-water", async () => {
		const driver = await openDriver(backend);
		const engine = new AuthorityEngine(driver, "owner-token");
		engine.recover();
		const ownerFrame = stagedOwnerFrame(driver);
		const missingOwner = rehashFrame({
			...ownerFrame,
			controls: ownerFrame.controls.filter(change => change.key !== "owner"),
		});
		expect(() => validateAuthorityFrame(missingOwner, missingOwner.previousHash)).toThrow();
		const claim = engine.reserveLocal(
			{
				localId: "frame-result",
				entryId: "entry",
				entryHash: "a".repeat(64),
				expectedHeadHash: durableGenesisHash(),
			},
			{ requestId: "frame-result-reserve" },
		);
		const reserveFrame = driver.exportState().frames.at(-1)!;
		const wrongResult = rehashFrame({
			...reserveFrame,
			receipt: { ...reserveFrame.receipt, result: { kind: "mutation" } } as AuthorityCommitFrame["receipt"],
		});
		expect(() => validateAuthorityFrame(wrongResult, wrongResult.previousHash)).toThrow();
		expect(claim.phase).toBe("reserved");
		engine.transition(operation("intent"), { requestId: "high-water-frame" });
		const operationFrame = driver.exportState().frames.at(-1)!;
		const invalidControls = operationFrame.controls.map(change =>
			change.key === "meta" && !change.deleted
				? { ...change, value: { ...(change.value as object), generationHighWater: 0 } }
				: change,
		);
		const invalidHighWater = rehashFrame({ ...operationFrame, controls: invalidControls });
		expect(() => validateAuthorityFrame(invalidHighWater, invalidHighWater.previousHash)).toThrow();
		expect(() =>
			validateAuthorityFrame(
				rehashFrame({
					...ownerFrame,
					controls: ownerFrame.controls.map(change =>
						change.key === "owner" && !change.deleted
							? { ...change, value: { ...(change.value as object), token: "unrelated-owner" } }
							: change,
					),
				}),
				ownerFrame.previousHash,
			),
		).toThrow();
		engine.close();
	});
});

test("JSONL reopens past a torn unacknowledged frame prefix but refuses a suffix no append could leave", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-torn-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "store.jsonl");
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: file, identity, create: true };
	const driver = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	engine.transition(operation("intent"), { requestId: "committed" });
	driver.close();
	const committed = await fs.readFile(file);
	// A crash between the frame's write and its fsync: never acknowledged, so the reopen drops it.
	await fs.appendFile(file, '{"version":2,"kind":"commit"');
	const reopened = new AuthorityEngine(new JsonlAuthorityPersistence({ ...options, create: false }), "owner-token-2");
	expect(reopened.resolveReceipt("committed")).toBeDefined();
	reopened.close();
	expect((await fs.readFile(file)).subarray(0, committed.byteLength)).toEqual(committed);
	// Bytes after the last frame that no append writes are evidence, never dropped.
	await fs.appendFile(file, "not a frame");
	const evidence = await fs.readFile(file);
	expect(() => new JsonlAuthorityPersistence({ ...options, create: false })).toThrow();
	expect(await fs.readFile(file)).toEqual(evidence);
});

test("JSONL rejects a modified committed frame even when its JSON remains valid", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-corrupt-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "store.jsonl");
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: file, identity, create: true };
	const driver = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	engine.transition(operation("intent"), { requestId: "committed" });
	driver.close();
	const contents = await fs.readFile(file, "utf8");
	await fs.writeFile(file, contents.replace('"operationId":"op-1"', '"operationId":"op-2"'));
	expect(() => new JsonlAuthorityPersistence({ ...options, create: false })).toThrow();
});

test("JSONL marks an active owner unavailable when its verified journal changes", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-fingerprint-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "store.jsonl");
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: file, identity, create: true };
	const driver = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	engine.transition(operation("intent"), { requestId: "verified-frame" });
	await fs.appendFile(file, "{}\n");
	expect(() => driver.integrityCheck()).toThrow();
	expect(() => driver.get("operation", ["actor-1", "eval", "op-1"])).toThrow();
	driver.close();
});
test("JSONL seed export preserves committed rows and historical receipts across incarnations", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-export-"));
	temporaryDirectories.push(directory);
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const sourceOptions: AuthorityDriverOptions = { path: path.join(directory, "source.jsonl"), identity, create: true };
	const source = new JsonlAuthorityPersistence(sourceOptions);
	const engine = new AuthorityEngine(source, "owner-token");
	engine.recover();
	const record = operation("intent");
	const receipt = engine.transition(record, { requestId: "exported-receipt" });
	const seed = source.exportState();
	engine.close();
	const restoredIdentity: AuthorityIdentity = { ...identity, incarnation: crypto.randomUUID() };
	const receiptKey = `receipt:${JSON.stringify([receipt.incarnation, receipt.ownerEpoch, receipt.requestId])}`;
	const invalidSeed = {
		...seed,
		controls: seed.controls.map(control =>
			control.key === receiptKey ? { ...control, value: { ...receipt, payloadHash: "f".repeat(64) } } : control,
		),
	};
	expect(
		() =>
			new JsonlAuthorityPersistence({
				path: path.join(directory, "invalid-seed.jsonl"),
				identity: restoredIdentity,
				create: true,
				seed: invalidSeed,
			}),
	).toThrow();
	const restored = new JsonlAuthorityPersistence({
		path: path.join(directory, "restored.jsonl"),
		identity: restoredIdentity,
		create: true,
		seed,
	});
	expect(restored.get("operation", ["actor-1", "eval", "op-1"])?.record).toEqual(record);
	expect(
		restored.getControl(`receipt:${JSON.stringify([receipt.incarnation, receipt.ownerEpoch, receipt.requestId])}`),
	).toEqual(receipt);
	expect(restored.exportState().frames).toEqual(seed.frames);
	restored.close();
});

test("JSONL rejects complete frame corruption and mismatched store identity", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-corrupt-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "store.jsonl");
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: file, identity, create: true };
	const driver = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	engine.transition(operation("intent"), { requestId: "committed" });
	driver.close();
	expect(
		() =>
			new JsonlAuthorityPersistence({
				...options,
				identity: { ...identity, incarnation: crypto.randomUUID() },
				create: false,
			}),
	).toThrow();
	const contents = await fs.readFile(file, "utf8");
	await fs.writeFile(file, contents.replace('"kind":"commit"', '"kind":"corrupt"'));
	expect(() => new JsonlAuthorityPersistence({ ...options, create: false })).toThrow();
});

test("JSONL pagination uses one deterministic complete-key order for filtering and sorting", async () => {
	const driver = await openDriver("jsonl");
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	const ids = ["a", "A", "é", "z", "aa", "Á", "_", "0", "Ω"];
	for (const [index, id] of ids.entries())
		engine.transition(operationWith(id, `operation-${index}`), { requestId: `cursor-${index}` });
	const expected = ids
		.map((id, index) => authorityKey("operation", [id, "eval", `operation-${index}`]))
		.sort(lexicalCompare);
	const actual: string[] = [];
	let after: string | undefined;
	while (true) {
		const page = engine.listOpen("operation", after, 2);
		for (const row of page.rows) {
			if (row.record.kind !== "operation") throw new Error("Unexpected domain in operation page.");
			actual.push(authorityKey("operation", [row.record.ownerId, row.record.effectClass, row.record.operationId]));
		}
		if (!page.cursor) break;
		after = page.cursor;
	}
	expect(actual).toEqual(expected);
	engine.close();
});

test("JSONL preserves explicit unknown outcome, cause, and request after fsync boundary failure", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-unknown-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "store.jsonl");
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: file, identity, create: true };
	const driver = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	const cause = new Error("simulated fsync acknowledgement loss after the real sync");
	const fsync = syncFs.fsyncSync;
	let injected = false;
	const sync = spyOn(syncFs, "fsyncSync").mockImplementation(fd => {
		const result = fsync(fd);
		if (!injected) {
			injected = true;
			throw cause;
		}
		return result;
	});
	let failure: unknown;
	const record = operation("intent");
	try {
		engine.transition(record, { requestId: "append-unknown" });
	} catch (error) {
		failure = error;
	} finally {
		sync.mockRestore();
	}
	expect(failure).toMatchObject({
		unknownOutcome: true,
		cause,
		request: {
			requestId: "append-unknown",
			incarnation: identity.incarnation,
			ownerEpoch: 1,
		},
	});
	expect(() => driver.get("operation", ["actor-1", "eval", "op-1"])).toThrow();
	driver.close();
	const reopened = new JsonlAuthorityPersistence({ ...options, create: false });
	const recovering = new AuthorityEngine(reopened, "owner-token-after-boundary");
	const payloadHash = canonicalDurableSha256({ kind: "transition", record });
	expect(recovering.resolveReceipt("append-unknown", 1, identity.incarnation, payloadHash)).toMatchObject({
		requestId: "append-unknown",
	});
	expect(recovering.getOperation("actor-1", "eval", "op-1")?.record.phase).toBe("intent");
	recovering.close();
});

test("JSONL revalidates the opened append descriptor before writing same-size changed bytes", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-append-race-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "store.jsonl");
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: file, identity, create: true };
	const driver = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(driver, "owner-token");
	engine.recover();
	const before = await fs.readFile(file);
	const originalOpen = syncFs.openSync;
	let rewritten = false;
	const open = spyOn(syncFs, "openSync").mockImplementation((...args) => {
		const [target, flags] = args;
		if (target === file && typeof flags === "number" && (flags & syncFs.constants.O_APPEND) !== 0 && !rewritten) {
			rewritten = true;
			const changed = syncFs.readFileSync(file);
			changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
			syncFs.writeFileSync(file, changed);
		}
		return originalOpen(...args);
	});
	try {
		expect(() => engine.transition(operation("intent"), { requestId: "raced-append" })).toThrow();
	} finally {
		open.mockRestore();
	}
	expect(rewritten).toBe(true);
	expect((await fs.readFile(file)).byteLength).toBe(before.byteLength);
	driver.close();
});

test("JSONL seed reconciliation rejects omitted current rows and altered owner controls", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-seed-reconcile-"));
	temporaryDirectories.push(directory);
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const source = new JsonlAuthorityPersistence({ path: path.join(directory, "source.jsonl"), identity, create: true });
	const engine = new AuthorityEngine(source, "owner-token");
	engine.recover();
	engine.transition(operation("intent"), { requestId: "seed-operation" });
	const seed = source.exportState();
	const restoredIdentity: AuthorityIdentity = { ...identity, incarnation: crypto.randomUUID() };
	expect(
		() =>
			new JsonlAuthorityPersistence({
				path: path.join(directory, "omitted-row.jsonl"),
				identity: restoredIdentity,
				create: true,
				seed: { ...seed, rows: seed.rows.filter(row => row.record.kind !== "operation") },
			}),
	).toThrow();
	expect(
		() =>
			new JsonlAuthorityPersistence({
				path: path.join(directory, "altered-owner.jsonl"),
				identity: restoredIdentity,
				create: true,
				seed: {
					...seed,
					controls: seed.controls.map(control =>
						control.key === "owner"
							? { ...control, value: { ...(control.value as object), token: "forged-owner" } }
							: control,
					),
				},
			}),
	).toThrow();
	engine.close();
});

test("JSONL integrity rejects cached rows that diverge from replayed evidence", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-cached-replay-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "store.jsonl");
	const identity: AuthorityIdentity = {
		backend: "jsonl",
		owningSessionId: "root-session",
		incarnation: crypto.randomUUID(),
		format: 2,
	};
	const options: AuthorityDriverOptions = { path: file, identity, create: true };
	const created = new JsonlAuthorityPersistence(options);
	const engine = new AuthorityEngine(created, "owner-token");
	engine.recover();
	engine.transition(operation("intent"), { requestId: "cached-replay" });
	engine.close();
	const reopened = new JsonlAuthorityPersistence({ ...options, create: false });
	const row = reopened.get("operation", ["actor-1", "eval", "op-1"]);
	if (!row) throw new Error("Test fixture has no persisted operation.");
	(row.record as { phase: string }).phase = "completed";
	expect(() => reopened.integrityCheck()).toThrow();
	reopened.close();
});

describe.each(backends)("listActors on %s", backend => {
	test("lists every actor of exactly one root generation, terminal ones included, and requires the generation", async () => {
		const engine = new AuthorityEngine(await openDriver(backend), "list-owner");
		engine.recover();
		const root = installRoot(engine, "listed-root");
		const active = constructActor(
			engine,
			root,
			"listed-active",
			root.root.rootId,
			"3".repeat(64),
			"4".repeat(64),
			10,
		);
		engine.activateAuthority(active, { requestId: "activate-listed-active" });
		const retired = constructActor(
			engine,
			root,
			"listed-retired",
			root.root.rootId,
			"5".repeat(64),
			"6".repeat(64),
			20,
		);
		engine.activateAuthority(retired, { requestId: "activate-listed-retired" });
		engine.transition({ ...retired.actor, at: 30, state: "retired" }, { requestId: "retire-listed" });
		const listed = engine.listActors(root.root.rootId, root.root.generation, undefined, 10);
		expect(listed.rows.map(row => [row.record.actorId, row.record.state]).sort()).toEqual([
			["listed-active", "active"],
			["listed-retired", "retired"],
			["listed-root", "active"],
		]);
		expect(engine.listActors(root.root.rootId, root.root.generation + 1, undefined, 10).rows).toEqual([]);
		// A generation-less listing would walk every past incarnation's actors; it is refused, not served.
		expect(() => engine.listActors(root.root.rootId, undefined as unknown as number, undefined, 10)).toThrow(
			RangeError,
		);
		engine.close();
	});
});

describe("continuation request bound", () => {
	const bound = AUTHORITY_MAX_CONTINUATION_REQUEST_BYTES;
	/** A requestId that makes `command` exactly `bytes` long as the engine measures a request. */
	const requestIdFor = (prefix: string, command: AuthorityCommand, bytes: number): string => {
		const padding = bytes - authorityRequestBytes(command, { requestId: prefix });
		return prefix + '"'.repeat(Math.floor(padding / 2)) + (padding % 2 === 0 ? "" : "a");
	};

	for (const backend of backends) {
		test(`${backend} refuses an oversized continuation before acknowledgement and keeps 2 MiB-class admissions`, async () => {
			const driver = await openDriver(backend);
			const engine = new AuthorityEngine(driver, "owner-token");
			engine.recover();
			// A new admission is not a continuation: the engine imposes no continuation cap on it.
			const admissionId = `admission-${"a".repeat(1_000_000)}`;
			engine.transition(operation("intent"), { requestId: admissionId });
			expect(engine.resolveReceipt(admissionId)?.commandKind).toBe("transition");
			const effect = operation("effect");
			const command: AuthorityCommand = { kind: "transition", record: effect };
			const before = driver.exportState();
			const oversized = requestIdFor("effect-oversized", command, bound + 1);
			let refusal: unknown;
			try {
				engine.transition(effect, { requestId: oversized });
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toBeInstanceOf(AuthorityContinuationTooLargeError);
			expect(refusal).toMatchObject({
				name: "AuthorityContinuationTooLargeError",
				unknownOutcome: false,
				commandKind: "transition",
				requestBytes: bound + 1,
				maximumBytes: bound,
			});
			expect(driver.exportState()).toEqual(before);
			expect(engine.resolveReceipt(oversized)).toBeUndefined();
			const maximal = requestIdFor("effect-maximal", command, bound);
			engine.transition(effect, { requestId: maximal });
			expect(engine.resolveReceipt(maximal)?.revision).toBe(before.revision + 1);
			expect(engine.getOperation("actor-1", "eval", "op-1")?.record.phase).toBe("effect");
			engine.close();
		});
	}

	test("classifies continuations from the persisted future-debt model", () => {
		const hash = "1".repeat(64);
		const rows = new Map<string, AuthorityRow>();
		const put = (record: DurableRegistryRecord): void => {
			rows.set(authorityKey(record.kind, authorityRecordKey(record)), { record, version: 1 });
		};
		const get = <D extends AuthorityDomain>(domain: D, key: AuthorityKey) =>
			rows.get(authorityKey(domain, key)) as AuthorityRow<AuthorityRecordMap[D]> | undefined;
		const transition = (record: DurableRegistryRecord): AuthorityCommand => ({ kind: "transition", record });
		const open = operation("intent");
		put(open);
		put({ ...operation("completed"), operationId: "done" });
		const gate = { kind: "gate" as const, at: 1, rootId: "root", generation: 1, phase: "open" as const };
		put(gate);
		const staged = {
			kind: "transition" as const,
			at: 1,
			rootId: "root",
			transitionId: "t",
			sourceGeneration: 1,
			destinationGeneration: 2,
			sourceHeadHash: hash,
			destinationHeadHash: hash,
			phase: "staged" as const,
		};
		put(staged);
		const constructed = {
			kind: "construction" as const,
			at: 1,
			rootId: "root",
			actorId: "child",
			parentId: "root",
			generation: 1,
			startupHash: hash,
			provenanceHash: hash,
			phase: "constructed" as const,
		};
		put(constructed);
		const reserved = { ...constructed, actorId: "other", phase: "reserved" as const };
		put(reserved);
		put({ kind: "root", at: 1, rootId: "root", generation: 1, headHash: hash, state: "active" });
		const actor = (actorId: string, parentId?: string) => ({
			kind: "actor" as const,
			at: 2,
			actorId,
			rootId: "root",
			...(parentId ? { parentId } : {}),
			generation: 1,
			rootGeneration: 1,
			rootHeadHash: hash,
			startupHash: hash,
			provenanceHash: hash,
			state: "active" as const,
		});
		const claim: LocalClaim = {
			localId: "l",
			entryId: "e",
			version: 1,
			entryHash: hash,
			headHash: hash,
			previousHeadHash: hash,
			claimToken: "c",
			ownerEpoch: 1,
			incarnation: "i",
			phase: "reserved",
		};
		const cases: Array<[string, AuthorityCommand, boolean]> = [
			["new operation admission", transition({ ...open, operationId: "new" }), false],
			["promised operation step", transition(operation("effect")), true],
			["multi-step promised operation path", transition(operation("completed")), true],
			["unpromised same-phase rewrite", transition({ ...open, at: 99 }), false],
			[
				"advance of a terminal operation",
				transition({ ...operation("intent"), operationId: "done", phase: "cancelled" }),
				false,
			],
			["different generation of an admitted key", transition({ ...operation("effect"), generation: 2 }), false],
			[
				"batch of promised steps",
				{
					kind: "transition-batch",
					records: [
						{ ...gate, phase: "quiescing" },
						{ ...staged, phase: "quiescing" },
					],
				},
				true,
			],
			[
				"batch carrying a new admission",
				{
					kind: "transition-batch",
					records: [
						{ ...gate, phase: "quiescing" },
						{ ...open, operationId: "new" },
					],
				},
				false,
			],
			["new transition admission", transition({ ...staged, transitionId: "t2" }), false],
			[
				"activation of a constructed reservation",
				{
					kind: "activate-authority",
					activation: { actor: actor("child", "root"), construction: { ...constructed, phase: "activated" } },
				},
				true,
			],
			[
				"activation without a constructed reservation",
				{
					kind: "activate-authority",
					activation: { actor: actor("other", "root"), construction: { ...reserved, phase: "activated" } },
				},
				false,
			],
			[
				"root-actor activation of an active root",
				{
					kind: "activate-authority",
					activation: {
						actor: actor("root"),
						construction: { ...constructed, actorId: "root", parentId: undefined, phase: "activated" },
					},
				},
				true,
			],
			[
				"root transition commit",
				{
					kind: "commit-root-transition",
					transition: {
						transition: { ...staged, phase: "recovered", recovery: true },
						expectedRootGeneration: 1,
						expectedRootHeadHash: hash,
						root: { kind: "root", at: 1, rootId: "root", generation: 1, headHash: hash, state: "active" },
						gate,
					},
				},
				true,
			],
			["local effect authorization", { kind: "authorize-local-effect", claim }, true],
			[
				"local finalization",
				{ kind: "finalize-local", claim: { ...claim, phase: "effect" }, outcome: "committed" },
				true,
			],
			[
				"local reconciliation",
				{ kind: "reconcile-local", input: { claim, observedEntryHash: hash, action: "restore-predecessor" } },
				true,
			],
			[
				"new local reservation",
				{ kind: "reserve-local", input: { localId: "l", entryId: "e2", entryHash: hash, expectedHeadHash: hash } },
				false,
			],
			["owner phase", { kind: "owner", owner: { incarnation: "i", epoch: 1, token: "t", phase: "ready" } }, false],
		];
		for (const [name, command, expected] of cases)
			expect([name, authorityCommandIsContinuation(command, get)]).toEqual([name, expected]);
	});
});

describe("quarantined close", () => {
	for (const backend of backends) {
		test(`${backend} closes a quarantined store without appending an owner-close frame`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-quarantine-close-"));
			temporaryDirectories.push(directory);
			const identity: AuthorityIdentity = {
				backend,
				owningSessionId: "root-session",
				incarnation: crypto.randomUUID(),
				format: 2,
			};
			const options: AuthorityDriverOptions = {
				path: path.join(directory, backend === "jsonl" ? "store.jsonl" : "store.sqlite"),
				identity,
				create: true,
			};
			const driver =
				backend === "jsonl" ? new JsonlAuthorityPersistence(options) : new SqliteAuthorityPersistence(options);
			const engine = new AuthorityEngine(driver, "owner-token");
			engine.recover();
			const reason = "quarantine before close";
			expect(() => engine.quarantine(reason)).toThrow(reason);
			const quarantined = driver.exportState();

			engine.close();
			engine.close();
			expect(() => engine.transition(operation("intent"), { requestId: "after-quarantined-close" })).toThrow();

			const reopenOptions: AuthorityDriverOptions = { path: options.path, identity, create: false };
			const reopened =
				backend === "jsonl"
					? new JsonlAuthorityPersistence(reopenOptions)
					: new SqliteAuthorityPersistence(reopenOptions);
			try {
				const after = reopened.exportState();
				expect(after.frames).toEqual(quarantined.frames);
				expect(after.frames.at(-1)?.command.kind).toBe("quarantine");
				expect(reopened.getControl("meta")).toMatchObject({ status: "quarantined", quarantineReason: reason });
				expect(reopened.getControl("owner")).not.toMatchObject({ phase: "closed" });
			} finally {
				reopened.close();
			}
		});
	}
});
