import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as sdk from "../../src/sdk";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import { hasBoundSessionOperationAuthority, runLocalOperation } from "../../src/registry/operation-lease";
import { AgentSession } from "../../src/session/agent-session";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthorityCleanupError } from "../../src/registry/authority/private-cleanup";
import {
	AuthorityRelocationInterruptedError,
	deleteAuthorityBundle,
	deleteSessionAuthorityBundle,
	moveAuthorityBundle,
	packAuthorityBundle,
	recoverAuthorityRelocation,
	relocateSessionAuthority,
	replaceSessionAuthorityBundle,
	restoreAuthorityBundle,
} from "../../src/registry/authority/lifecycle";
import { openAuthorityPersistence } from "../../src/registry/authority/persistence";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import {
	canonicalDurableSha256,
	durableRootHeadHash,
	RegistryDurableStateStore,
	registryDurableJournalPath,
} from "../../src/registry/durable-state";
import { FileSessionStorage, SessionWriteConflictError } from "../../src/session/session-storage";
import { authorityPaths } from "../../src/registry/authority/ownership";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { SessionManager } from "../../src/session/session-manager";
import { parseSessionContent } from "../../src/session/session-loader";
import { durableGenesisHash } from "../../src/registry/durable-state";
import type { AuthorityExport, JournalingBackend } from "../../src/registry/authority/types";
import type { AuthorityBundle } from "../../src/registry/authority/lifecycle";

const directories: string[] = [];
const sourceId = "019ed676-02fb-7000-8dac-396e2f84d484";
const restoredId = "019ed677-02fb-7000-8dac-396e2f84d484";

async function sessionFile(directory: string, id: string): Promise<string> {
	const file = path.join(directory, `${id}.jsonl`);
	await Bun.write(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: directory })}\n`,
	);
	return file;
}

async function freshSessionFile(
	directory: string,
	backend: JournalingBackend = "jsonl",
): Promise<{ file: string; id: string }> {
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "authority fixture", timestamp: 1 });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Fresh fixture did not create a transcript.");
	const id = manager.getSessionId();
	const store = await registryDurableStateForSession(file, { owningSessionId: id, backend, create: true });
	await store.close();
	await manager.close();
	return { file, id };
}

// The live SQLite connection holds an exclusive lock, so no second reader can pin
// its WAL, and a clean close checkpoints and removes it. A WAL-bearing fixture is
// the real quiescent main/WAL pair captured after the last COMMIT and reinstalled
// after close: exactly the installed image of a crash before checkpoint.
async function captureSqliteCrashImage(database: string): Promise<() => Promise<void>> {
	const [main, wal] = await Promise.all([fs.readFile(database), fs.readFile(`${database}-wal`)]);
	return async () => {
		await fs.writeFile(database, main);
		await fs.writeFile(`${database}-wal`, wal, { mode: 0o600 });
	};
}

async function offlineState(file: string): Promise<AuthorityExport> {
	const descriptor = await readAuthorityDescriptor(file);
	if (!descriptor) throw new Error("Expected selected authority evidence.");
	const driver = openAuthorityPersistence({
		path: path.join(path.dirname(file), descriptor.payload),
		identity: {
			backend: descriptor.backend,
			owningSessionId: descriptor.owningSessionId,
			incarnation: descriptor.incarnation,
			format: 2,
		},
		create: false,
	});
	try {
		driver.integrityCheck();
		return driver.exportState();
	} finally {
		driver.close();
	}
}

async function settledEvidence(file: string, id: string, backend: JournalingBackend): Promise<AuthorityExport> {
	const store = await registryDurableStateForSession(file, { owningSessionId: id });
	let reinstallCrashImage: (() => Promise<void>) | undefined;
	try {
		const startupHash = canonicalDurableSha256("Main:startup");
		const provenanceHash = canonicalDurableSha256("Main:provenance");
		const headHash = durableRootHeadHash({
			rootId: "Main",
			generation: 1,
			actorId: "Main",
			startupHash,
			provenanceHash,
		});
		const construction = {
			kind: "construction" as const,
			at: 1,
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			startupHash,
			provenanceHash,
		};
		await store.transitionBatch(
			[
				{ ...construction, phase: "reserved" },
				{ ...construction, at: 2, phase: "constructing" },
				{ ...construction, at: 3, phase: "constructed" },
			],
			{ requestId: "move-root-construction" },
		);
		await store.activateAuthority(
			{
				root: { kind: "root", at: 4, rootId: "Main", generation: 1, headHash, state: "active" },
				actor: {
					kind: "actor",
					at: 4,
					actorId: "Main",
					rootId: "Main",
					generation: 1,
					rootGeneration: 1,
					rootHeadHash: headHash,
					startupHash,
					provenanceHash,
					state: "active",
				},
				construction: { ...construction, at: 4, phase: "activated" },
				gate: { kind: "gate", at: 4, rootId: "Main", generation: 1, phase: "open" },
			},
			{ requestId: "move-root-activation" },
		);
		const child = {
			kind: "construction" as const,
			at: 5,
			actorId: "Child",
			parentId: "Main",
			rootId: "Main",
			generation: 2,
			startupHash: canonicalDurableSha256("Child:startup"),
			provenanceHash: canonicalDurableSha256("Child:provenance"),
		};
		await store.transitionBatch(
			[
				{ ...child, phase: "reserved" },
				{ ...child, at: 6, phase: "constructing" },
				{ ...child, at: 7, phase: "constructed" },
			],
			{ requestId: "move-child-construction" },
		);
		const actor = {
			kind: "actor" as const,
			at: 8,
			actorId: "Child",
			parentId: "Main",
			rootId: "Main",
			generation: 2,
			rootGeneration: 1,
			rootHeadHash: headHash,
			startupHash: child.startupHash,
			provenanceHash: child.provenanceHash,
			state: "active" as const,
		};
		await store.activateAuthority(
			{ actor, construction: { ...child, at: 8, phase: "activated" } },
			{ requestId: "move-child-activation" },
		);
		await store.transition({ ...actor, at: 9, state: "retired" }, { requestId: "move-child-retirement" });
		const claim = await store.reserveLocal(
			{
				localId: "publication",
				entryId: "first",
				entryHash: canonicalDurableSha256("first"),
				expectedHeadHash: durableGenesisHash(),
			},
			{ requestId: "move-local-claim" },
		);
		await store.authorizeLocalEffect(claim, { requestId: "move-local-authorization" });
		await store.finalizeLocal({ ...claim, phase: "effect" }, "committed", { requestId: "move-local-publication" });
		if (backend === "sqlite") reinstallCrashImage = await captureSqliteCrashImage(authorityPaths(file).sqlite);
	} finally {
		await store.close();
	}
	await reinstallCrashImage?.();
	if (backend === "sqlite") expect((await fs.stat(`${authorityPaths(file).sqlite}-wal`)).size).toBeGreaterThan(32);
	const evidence = await offlineState(file);
	// Offline inspection checkpoints and removes the WAL; callers operate on the same installed crash image.
	await reinstallCrashImage?.();
	return evidence;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

it("refuses moving a live registry-bound AgentSession before changing its root", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-session-move-refusal-"));
	directories.push(directory);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model.");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "managed root transcript", timestamp: 1 });
	await manager.ensureOnDisk();
	const source = manager.getSessionFile();
	if (!source) throw new Error("Expected a physical managed session root.");
	const artifactId = await manager.saveArtifact("managed root evidence", "read");
	if (artifactId === undefined) throw new Error("Expected a managed-root artifact.");
	const artifactPath = await manager.getArtifactPath(artifactId);
	if (!artifactPath) throw new Error("Expected a persisted managed-root artifact path.");
	const root = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["ok"] }) }).stream,
		}),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage, path.join(directory, "models.yml")),
		agentId: "Main",
	});
	const store = await registryDurableStateForSession(source, {
		owningSessionId: manager.getSessionId(),
		backend: "jsonl",
		create: true,
	});
	const registry = await AgentRegistry.create({ durableState: store });
	const createSession = spyOn(sdk, "createAgentSession").mockResolvedValue({
		session: root,
	} as sdk.CreateAgentSessionResult);
	const targetDirectory = path.join(directory, "moved");
	try {
		await createAgentRootSession(registry, { agentId: "Main" });
		expect(hasBoundSessionOperationAuthority(manager)).toBe(true);
		const transcript = await fs.readFile(source);
		const descriptor = await readAuthorityDescriptor(source);
		const artifact = await fs.readFile(artifactPath);
		await expect(root.moveSession(path.join(directory, "next-workspace"), targetDirectory)).rejects.toThrow(
			/live.*authority|bound.*authority|close.*handle/i,
		);
		expect(await fs.readFile(source)).toEqual(transcript);
		expect(await Bun.file(targetDirectory).exists()).toBe(false);
		expect(await readAuthorityDescriptor(source)).toEqual(descriptor);
		expect(await fs.readFile(artifactPath)).toEqual(artifact);
		expect(manager.getCwd()).toBe(directory);
		expect(manager.getSessionFile()).toBe(source);
		expect(await Bun.file(path.join(targetDirectory, path.basename(source))).exists()).toBe(false);
		expect(await store.getActor("Main")).toBeDefined();
		let effectRan = false;
		await runLocalOperation(manager, "managed-move-refusal-effect", async () => {
			effectRan = true;
		});
		expect(effectRan).toBe(true);
	} finally {
		createSession.mockRestore();
		await manager.close();
		await store.close();
		authStorage.close();
	}
});

it("rechecks a selected manager bound during artifact inspection before relocation", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-late-bound-session-move-"));
	directories.push(directory);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model.");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "late-bound managed root transcript", timestamp: 1 });
	await manager.ensureOnDisk();
	const source = manager.getSessionFile();
	if (!source) throw new Error("Expected a physical managed session root.");
	const artifactId = await manager.saveArtifact("late-bound root evidence", "read");
	if (artifactId === undefined) throw new Error("Expected a managed-root artifact.");
	const artifactPath = await manager.getArtifactPath(artifactId);
	if (!artifactPath) throw new Error("Expected a persisted managed-root artifact path.");
	const root = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["ok"] }) }).stream,
		}),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage, path.join(directory, "models.yml")),
		agentId: "Main",
	});
	const store = await registryDurableStateForSession(source, {
		owningSessionId: manager.getSessionId(),
		backend: "jsonl",
		create: true,
	});
	const registry = await AgentRegistry.create({ durableState: store });
	const createSession = spyOn(sdk, "createAgentSession").mockResolvedValue({
		session: root,
	} as sdk.CreateAgentSessionResult);
	const targetDirectory = path.join(directory, "moved");
	const target = path.join(targetDirectory, path.basename(source));
	const inspectionReached = Promise.withResolvers<void>();
	const resumeInspection = Promise.withResolvers<void>();
	const readDirectory = fs.readdir;
	let inspectionPaused = false;
	const readdirSpy = spyOn(fs, "readdir").mockImplementation(
		new Proxy<typeof readDirectory>(readDirectory, {
			async apply(method, thisArg, args) {
				const names = await Reflect.apply(method, thisArg, args);
				if (!inspectionPaused && path.resolve(String(args[0])) === path.dirname(source)) {
					inspectionPaused = true;
					inspectionReached.resolve();
					await resumeInspection.promise;
				}
				return names;
			},
		}),
	);
	const moveOutcome = manager.moveTo(path.join(directory, "next-workspace"), targetDirectory).then(
		() => undefined,
		error => error,
	);
	try {
		await inspectionReached.promise;
		readdirSpy.mockRestore();
		await createAgentRootSession(registry, { agentId: "Main" });
		expect(hasBoundSessionOperationAuthority(manager)).toBe(true);
		const transcript = await fs.readFile(source);
		const descriptor = await readAuthorityDescriptor(source);
		const artifact = await fs.readFile(artifactPath);
		resumeInspection.resolve();
		const failure = await moveOutcome;
		if (!(failure instanceof Error)) throw new Error("Expected a live-authority move refusal.");
		expect(failure.message).toMatch(/live.*authority|bound.*authority|close.*handle/i);
		expect(await fs.readFile(source)).toEqual(transcript);
		expect(await readAuthorityDescriptor(source)).toEqual(descriptor);
		expect(await fs.readFile(artifactPath)).toEqual(artifact);
		expect(await Bun.file(target).exists()).toBe(false);
		expect(manager.getCwd()).toBe(directory);
		expect(manager.getSessionFile()).toBe(source);
		expect(await store.getActor("Main")).toBeDefined();
		let effectRan = false;
		await runLocalOperation(manager, "late-bound-move-refusal-effect", async () => {
			effectRan = true;
		});
		expect(effectRan).toBe(true);
	} finally {
		resumeInspection.resolve();
		readdirSpy.mockRestore();
		createSession.mockRestore();
		await moveOutcome;
		await manager.close();
		await store.close();
		authStorage.close();
	}
});

describe("authority lifecycle bundles", () => {
	it("round-trips selected authority evidence into a fresh root incarnation", async () => {
		const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-bundle-source-"));
		const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-bundle-target-"));
		directories.push(sourceDirectory, targetDirectory);
		const { file: source, id: sourceId } = await freshSessionFile(sourceDirectory);
		const target = await sessionFile(targetDirectory, restoredId);
		const original = await registryDurableStateForSession(source, { owningSessionId: sourceId });
		const originalIdentity = original.identity;
		const startupHash = canonicalDurableSha256("Main:startup");
		const provenanceHash = canonicalDurableSha256("Main:provenance");
		const headHash = durableRootHeadHash({
			rootId: "Main",
			generation: 1,
			actorId: "Main",
			startupHash,
			provenanceHash,
		});
		const construction = {
			kind: "construction" as const,
			at: 1,
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			startupHash,
			provenanceHash,
		};
		await original.transitionBatch(
			[
				{ ...construction, phase: "reserved" as const },
				{ ...construction, at: 2, phase: "constructing" as const },
				{ ...construction, at: 3, phase: "constructed" as const },
			],
			{ requestId: "root-construction" },
		);
		await original.activateAuthority(
			{
				root: { kind: "root", at: 4, rootId: "Main", generation: 1, headHash, state: "active" },
				actor: {
					kind: "actor",
					at: 4,
					actorId: "Main",
					rootId: "Main",
					generation: 1,
					rootGeneration: 1,
					rootHeadHash: headHash,
					startupHash,
					provenanceHash,
					state: "active",
				},
				construction: { ...construction, at: 4, phase: "activated" },
				gate: { kind: "gate", at: 4, rootId: "Main", generation: 1, phase: "open" },
			},
			{ requestId: "root-activation" },
		);
		await original.close();

		const sourceDescriptor = await readAuthorityDescriptor(source);
		if (!sourceDescriptor) throw new Error("Expected the source authority descriptor.");
		const sourceDriver = openAuthorityPersistence({
			path: path.join(sourceDirectory, sourceDescriptor.payload),
			identity: originalIdentity,
			create: false,
		});
		const originalState = sourceDriver.exportState();
		sourceDriver.close();
		const bundle = await packAuthorityBundle(source);
		expect(
			JSON.parse(Buffer.from(bundle!.entries.find(entry => entry.name === "authority.json")!.data).toString("utf8"))
				.payload,
		).toBe("authority.jsonl");
		expect(bundle?.owningSessionId).toBe(sourceId);
		expect(bundle?.entries.some(entry => entry.name === "authority.lock")).toBe(true);
		expect(bundle?.entries.some(entry => entry.name === "authority-v1.jsonl.quarantine")).toBe(true);
		await restoreAuthorityBundle(target, bundle!);

		const targetDescriptor = await readAuthorityDescriptor(target);
		if (!targetDescriptor) throw new Error("Expected the restored authority descriptor.");
		const targetIdentity = {
			backend: targetDescriptor.backend,
			owningSessionId: targetDescriptor.owningSessionId,
			incarnation: targetDescriptor.incarnation,
			format: 2 as const,
		};
		const restoredDriver = openAuthorityPersistence({
			path: path.join(targetDirectory, targetDescriptor.payload),
			identity: targetIdentity,
			create: false,
		});
		const restoredState = restoredDriver.exportState();
		restoredDriver.close();
		expect(targetIdentity.backend).toBe(originalIdentity.backend);
		expect(targetIdentity.owningSessionId).toBe(restoredId);
		expect(targetIdentity.incarnation).not.toBe(originalIdentity.incarnation);
		expect({ ...restoredState, sourceIdentity: originalState.sourceIdentity }).toEqual(originalState);
		const selected = await registryDurableStateForSession(target, { owningSessionId: restoredId });
		try {
			const originalRoot = originalState.rows.find(row => row.record.kind === "root");
			const originalActor = originalState.rows.find(row => row.record.kind === "actor");
			const originalConstruction = originalState.rows.find(row => row.record.kind === "construction");
			const originalGate = originalState.rows.find(row => row.record.kind === "gate");
			const originalOwnerFrame = originalState.frames.at(-1);
			if (
				!originalRoot ||
				!originalActor ||
				!originalConstruction ||
				!originalGate ||
				!originalOwnerFrame ||
				originalOwnerFrame.command.kind !== "owner"
			)
				throw new Error("Expected complete closed-owner source evidence.");
			const originalOwner = originalOwnerFrame.command.owner;
			expect(originalOwner.phase).toBe("closed");
			const recovery = await selected.recoveryState();
			const owner = recovery.owner;
			expect(owner).toEqual({
				incarnation: targetIdentity.incarnation,
				epoch: originalOwner.epoch + 1,
				token: expect.any(String),
				phase: "ready",
			});
			expect(owner.token).not.toBe(originalOwner.token);
			expect(recovery.blocked).toEqual([]);
			expect((await selected.getRoot("Main"))?.record.state).toBe("active");
			const gate = await selected.getGate("Main");
			if (!gate) throw new Error("Expected recovery to retain the restored root gate.");
			if (gate.record.kind !== "gate" || originalGate.record.kind !== "gate")
				throw new Error("Expected closed-owner recovery to retain gate records.");
			expect(originalGate.record).toMatchObject({ rootId: "Main", generation: 1, phase: "open" });
			expect(gate).toEqual({
				record: { ...originalGate.record, at: expect.any(Number), phase: "closed" },
				version: originalGate.version + 1,
			});
			const recoveryKey = `root-recovery:${JSON.stringify(["Main"])}`;
			const recoveryEvidence = {
				version: 1,
				incarnation: targetIdentity.incarnation,
				ownerEpoch: owner.epoch,
				ownerToken: owner.token,
				rootId: "Main",
				generation: 1,
				rootHeadHash: headHash,
				rootVersion: originalRoot.version,
				actorVersion: originalActor.version,
				constructionVersion: originalConstruction.version,
				gateVersion: gate.version,
			};
			const reopenedState = await selected.exportState();
			const recoveryFrames = reopenedState.frames.slice(originalState.frames.length);
			expect(recoveryFrames).toHaveLength(3);
			const [recoveringFrame, gateFrame, readyFrame] = recoveryFrames;
			if (!recoveringFrame || !gateFrame || !readyFrame)
				throw new Error("Expected owner acquisition, gate closure and readiness evidence.");
			expect(recoveryFrames.map(frame => frame.command)).toEqual([
				{ kind: "owner", owner: { ...owner, phase: "recovering" } },
				{ kind: "transition", record: gate.record },
				{ kind: "owner", owner },
			]);
			expect(recoveryFrames.map(frame => frame.changes)).toEqual([[], [gate], []]);
			expect(recoveryFrames.map(frame => frame.expected)).toEqual([
				[],
				[{ domain: "gate", key: ["Main"], version: originalGate.version }],
				[],
			]);
			let previousHash = originalState.headHash;
			for (const [index, frame] of recoveryFrames.entries()) {
				expect(frame.revision).toBe(originalState.revision + index + 1);
				expect(frame.previousHash).toBe(previousHash);
				expect(frame.request).toEqual({
					requestId: expect.any(String),
					incarnation: targetIdentity.incarnation,
					ownerEpoch: owner.epoch,
					ownerToken: owner.token,
				});
				expect(frame.payloadHash).toBe(canonicalDurableSha256(frame.command));
				expect(frame.receipt).toEqual({
					requestId: frame.request.requestId,
					ownerEpoch: owner.epoch,
					revision: frame.revision,
					payloadHash: frame.payloadHash,
					incarnation: targetIdentity.incarnation,
					commandKind: frame.command.kind,
					committedAt: frame.committedAt,
					result: { kind: "mutation" },
				});
				const commandControl =
					frame.command.kind === "owner"
						? { key: "owner", deleted: false, value: frame.command.owner }
						: { key: recoveryKey, deleted: false, value: recoveryEvidence };
				expect(frame.controls).toEqual([
					commandControl,
					{
						key: "meta",
						deleted: false,
						value: {
							revision: frame.revision,
							generationHighWater: originalState.generationHighWater,
							status: "ready",
						},
					},
					{
						key: `receipt:${JSON.stringify([targetIdentity.incarnation, owner.epoch, frame.request.requestId])}`,
						deleted: false,
						value: frame.receipt,
					},
				]);
				previousHash = frame.hash;
			}
			expect(reopenedState.sourceIdentity).toEqual(targetIdentity);
			expect(reopenedState.revision).toBe(originalState.revision + 3);
			expect(reopenedState.headHash).toBe(readyFrame.hash);
			expect(reopenedState.frames.slice(0, originalState.frames.length)).toEqual([...originalState.frames]);
			expect(reopenedState.rows).toEqual(originalState.rows.map(row => (row.record.kind === "gate" ? gate : row)));
			expect(reopenedState.generationHighWater).toBe(originalState.generationHighWater);
			expect(reopenedState.legacy).toEqual(originalState.legacy);
			const expectedControls = [
				...originalState.controls.filter(control => control.key !== "owner" && control.key !== "meta"),
				{ key: "owner", value: owner },
				{
					key: "meta",
					value: {
						revision: originalState.revision + 3,
						headHash: readyFrame.hash,
						generationHighWater: originalState.generationHighWater,
						status: "ready",
					},
				},
				{ key: recoveryKey, value: recoveryEvidence },
				...recoveryFrames.map(frame => ({
					key: `receipt:${JSON.stringify([targetIdentity.incarnation, owner.epoch, frame.request.requestId])}`,
					value: frame.receipt,
				})),
			];
			expect([...reopenedState.controls].sort((left, right) => left.key.localeCompare(right.key))).toEqual(
				expectedControls.sort((left, right) => left.key.localeCompare(right.key)),
			);
		} finally {
			await selected.close();
		}
	});
	it("refuses a symlinked authority member before deleting any selected bytes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-bundle-symlink-"));
		directories.push(directory);
		const { file: source, id: sourceId } = await freshSessionFile(directory);
		const store = await registryDurableStateForSession(source, { owningSessionId: sourceId });
		await store.close();
		const paths = authorityPaths(source);
		await fs.unlink(paths.legacyFence);
		await fs.symlink(path.join(directory, "unrelated"), paths.legacyFence);

		await expect(deleteAuthorityBundle(source)).rejects.toThrow();
		expect(await Bun.file(paths.descriptor).exists()).toBe(true);
		expect(await Bun.file(paths.jsonl).exists()).toBe(true);
	});

	it("refuses deletion of an orphan v2 payload without changing the transcript", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-orphan-delete-"));
		directories.push(directory);
		const { file: source, id: sourceId } = await freshSessionFile(directory);
		const transcript = await fs.readFile(source);
		const store = await registryDurableStateForSession(source, { owningSessionId: sourceId });
		await store.close();
		const paths = authorityPaths(source);
		await fs.rm(paths.descriptor);

		await expect(deleteAuthorityBundle(source)).rejects.toThrow(/orphan|descriptor|ambiguous/i);
		expect(await fs.readFile(source)).toEqual(transcript);
		expect(await Bun.file(paths.jsonl).exists()).toBe(true);
	});

	it("refuses legacy deletion with unresolved effects before deleting the transcript", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-legacy-delete-"));
		directories.push(directory);
		const source = await sessionFile(directory, sourceId);
		const transcript = await fs.readFile(source);
		const journal = registryDurableJournalPath(source);
		const legacy = new RegistryDurableStateStore(journal);
		const now = Date.now();
		legacy.append({
			kind: "operation",
			at: now,
			operationId: "pending-delete",
			effectClass: "session",
			ownerId: "Main",
			classOwnerId: "Main",
			actorId: "Main",
			rootId: "Main",
			generation: 1,
			acquiredAt: now,
			expiresAt: now + 60_000,
			phase: "intent",
		});

		await expect(new FileSessionStorage().deleteSessionWithArtifacts(source)).rejects.toThrow(/unresolved|effects/i);
		expect(await fs.readFile(source)).toEqual(transcript);
		expect(await Bun.file(journal).exists()).toBe(true);
	});

	it("moves a quiescent legacy manager and adopts its rewritten transcript without manufacturing a v2 selection", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-manager-move-"));
		directories.push(directory);
		const source = await sessionFile(directory, sourceId);
		const legacy = new RegistryDurableStateStore(registryDurableJournalPath(source));
		const construction = {
			kind: "construction" as const,
			at: 1,
			actorId: "Abandoned",
			rootId: "Abandoned",
			generation: 1,
			startupHash: canonicalDurableSha256("legacy-startup"),
			provenanceHash: canonicalDurableSha256("legacy-provenance"),
		};
		legacy.append({ ...construction, phase: "reserved" });
		legacy.append({ ...construction, at: 2, phase: "abandoned" });
		const original = await fs.readFile(registryDurableJournalPath(source));
		const manager = await SessionManager.open(source, directory);
		const targetDirectory = path.join(directory, "relocated");
		try {
			await manager.moveTo(path.join(directory, "workspace"), targetDirectory);
			const target = manager.getSessionFile();
			if (!target) throw new Error("Expected the relocated legacy transcript.");
			expect(await readAuthorityDescriptor(target)).toBeUndefined();
			expect(await fs.readFile(registryDurableJournalPath(target))).toEqual(original);
			expect(manager.getHeader()?.previousSessionFiles).toContain(source);
			manager.appendMessage({
				role: "user",
				content: "legacy transcript remains writable after move",
				timestamp: 3,
			});
			await manager.flush();
			expect(await fs.readFile(target, "utf8")).toContain("legacy transcript remains writable after move");
			expect(await Bun.file(source).exists()).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("repacks nested displaced backup provenance after restore", async () => {
		const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-nested-source-"));
		const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-nested-target-"));
		directories.push(sourceDirectory, targetDirectory);
		const { file: source, id: sourceId } = await freshSessionFile(sourceDirectory);
		const target = await sessionFile(targetDirectory, restoredId);
		const store = await registryDurableStateForSession(source, { owningSessionId: sourceId });
		await store.close();
		const bundle = await packAuthorityBundle(source);
		if (!bundle) throw new Error("Expected a selected authority bundle.");
		const nestedName = "authority.backup.00000000-0000-4000-8000-000000000001/displaced/authority.lock";
		const withDisplaced = {
			...bundle,
			entries: [...bundle.entries, { name: nestedName, data: Buffer.from("retained lock provenance") }],
		};
		await restoreAuthorityBundle(target, withDisplaced);
		const repacked = await packAuthorityBundle(target);
		expect(repacked?.entries.some(entry => entry.name === nestedName)).toBe(true);
	});
	for (const invalid of ["missing", "changed", "competing"] as const) {
		it(`rejects ${invalid} selected bundle artifacts before restore publication`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bundle-admission-"));
			directories.push(directory);
			const { file: source } = await freshSessionFile(directory);
			const bundle = await packAuthorityBundle(source);
			if (!bundle) throw new Error("Expected selected bundle.");
			const target = await sessionFile(directory, restoredId);
			const entries = bundle.entries.filter(
				entry => invalid === "competing" || entry.name !== "authority-v1.jsonl.quarantine",
			);
			if (invalid === "changed")
				entries.push({ name: "authority-v1.jsonl.quarantine", data: Buffer.from("arbitrary quarantine") });
			if (invalid === "competing")
				entries.push({ name: "authority.sqlite", data: Buffer.from("competing payload") });
			await expect(restoreAuthorityBundle(target, { ...bundle, entries })).rejects.toThrow(
				/fence|marker|unselected|competing/i,
			);
			expect(await Bun.file(authorityPaths(target).descriptor).exists()).toBe(false);
			expect(await Bun.file(authorityPaths(target).jsonl).exists()).toBe(false);
		});
	}
	for (const invalid of ["missing", "changed", "competing"] as const) {
		it(`refuses packing ${invalid} selected artifacts`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pack-admission-"));
			directories.push(directory);
			const { file } = await freshSessionFile(directory);
			const paths = authorityPaths(file);
			if (invalid === "missing") await fs.rm(paths.legacyFence);
			else if (invalid === "changed") await fs.writeFile(paths.legacyFence, "arbitrary quarantine", { mode: 0o600 });
			else await fs.writeFile(paths.sqlite, "competing payload", { mode: 0o600 });
			await expect(packAuthorityBundle(file)).rejects.toThrow(/fence|marker|unselected|competing/i);
		});
	}
	for (const cut of ["manifest", "payload", "initializing", "active", "finalized"] as const) {
		it(`restores a real WAL-bearing bundle after the ${cut} durable cut`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wal-restore-"));
			directories.push(directory);
			const { file: source, id } = await freshSessionFile(directory, "sqlite");
			const paths = authorityPaths(source);
			let bundle: AuthorityBundle | null = null;
			let expected: AuthorityExport | undefined;
			{
				const store = await registryDurableStateForSession(source, { owningSessionId: id });
				let reinstallCrashImage: (() => Promise<void>) | undefined;
				try {
					const claim = await store.reserveLocal({
						localId: "wal",
						entryId: "entry",
						entryHash: "a".repeat(64),
						expectedHeadHash: durableGenesisHash(),
					});
					await store.authorizeLocalEffect(claim);
					await store.finalizeLocal({ ...claim, phase: "effect" }, "committed");
					reinstallCrashImage = await captureSqliteCrashImage(paths.sqlite);
				} finally {
					await store.close();
				}
				await reinstallCrashImage?.();
				expect((await fs.stat(`${paths.sqlite}-wal`)).size).toBeGreaterThan(32);
				bundle = await packAuthorityBundle(source);
				expect(bundle?.entries.some(entry => entry.name === "authority.sqlite-wal" && entry.data.length > 32)).toBe(
					true,
				);
				const descriptor = await readAuthorityDescriptor(source);
				if (!descriptor) throw new Error("Expected SQLite selection.");
				const driver = openAuthorityPersistence({
					path: paths.sqlite,
					identity: { backend: "sqlite", owningSessionId: id, incarnation: descriptor.incarnation, format: 2 },
					create: false,
				});
				try {
					expected = driver.exportState();
				} finally {
					driver.close();
				}
			}
			if (!bundle) throw new Error("Expected WAL bundle.");
			const target = await sessionFile(directory, restoredId);
			const targetPaths = authorityPaths(target);
			const rename = fs.rename;
			const remove = fs.rm;
			let injected = false;
			const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
				await rename(from, to);
				if (injected) return;
				const destination = String(to);
				let matches = cut === "manifest" && destination.startsWith(`${target}.authority.restore.`);
				matches ||= cut === "payload" && destination === targetPaths.sqlite;
				if (destination === targetPaths.descriptor && (cut === "initializing" || cut === "active"))
					matches = (await readAuthorityDescriptor(target))?.state === cut;
				if (matches) {
					injected = true;
					throw new Error("injected restore interruption");
				}
			});
			const removeSpy = spyOn(fs, "rm").mockImplementation(async (file, options) => {
				await remove(file, options);
				if (!injected && cut === "finalized" && String(file).startsWith(`${target}.authority.restore.`)) {
					injected = true;
					throw new Error("injected restore interruption");
				}
			});
			try {
				await expect(restoreAuthorityBundle(target, bundle)).rejects.toThrow(/injected restore interruption/);
			} finally {
				renameSpy.mockRestore();
				removeSpy.mockRestore();
			}
			expect(injected).toBe(true);
			await restoreAuthorityBundle(target, bundle);
			const descriptor = await readAuthorityDescriptor(target);
			expect(descriptor?.state).toBe("active");
			if (!descriptor || !expected) throw new Error("Expected complete restore evidence.");
			const driver = openAuthorityPersistence({
				path: targetPaths.sqlite,
				identity: {
					backend: "sqlite",
					owningSessionId: restoredId,
					incarnation: descriptor.incarnation,
					format: 2,
				},
				create: false,
			});
			try {
				expect({ ...driver.exportState(), sourceIdentity: expected.sourceIdentity }).toEqual(expected);
			} finally {
				driver.close();
			}
			const store = await registryDurableStateForSession(target, { owningSessionId: restoredId });
			try {
				expect(await store.localBacking("wal")).toMatchObject({
					entryId: "entry",
					entryHash: "a".repeat(64),
					version: 1,
				});
			} finally {
				await store.close();
			}
		});
	}
});

for (const backend of ["jsonl", "sqlite"] as const) {
	it(`moves a complete ${backend} bundle to an absent target without changing its incarnation`, async () => {
		const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		directories.push(sourceDirectory, targetDirectory);
		const { file: source, id } = await freshSessionFile(sourceDirectory, backend);
		const target = path.join(targetDirectory, path.basename(source));
		const descriptor = await readAuthorityDescriptor(source);
		const transcript = await fs.readFile(source);
		await fs.mkdir(source.slice(0, -6), { mode: 0o700 });
		await fs.writeFile(path.join(source.slice(0, -6), "artifact.txt"), "artifact", { mode: 0o600 });
		await moveAuthorityBundle(source, target);
		const moved = await readAuthorityDescriptor(target);
		expect(moved?.incarnation).toBe(descriptor?.incarnation);
		expect(moved?.owningSessionId).toBe(id);
		// The transcript moves unchanged except its header's authorityRoot, which now names the target, so
		// resume-time adoption never mistakes the moved root for a copy that left its bundle behind.
		const canonicalTarget = await fs.realpath(target);
		const restamped = transcript
			.toString("utf8")
			.split("\n")
			.map(line => {
				if (!line.startsWith("{")) return line;
				const entry = JSON.parse(line) as Record<string, unknown>;
				return entry.type === "session" && typeof entry.authorityRoot === "string"
					? JSON.stringify({ ...entry, authorityRoot: canonicalTarget })
					: line;
			})
			.join("\n");
		expect(transcript.toString("utf8")).toContain('"authorityRoot"');
		expect((await fs.readFile(target)).toString("utf8")).toBe(restamped);
		expect(await fs.readFile(path.join(target.slice(0, -6), "artifact.txt"), "utf8")).toBe("artifact");
		expect(await Bun.file(source).exists()).toBe(false);
		expect(await Bun.file(authorityPaths(source).descriptor).exists()).toBe(false);
		const store = await registryDurableStateForSession(target, { owningSessionId: id });
		await store.close();
	});

	it(`finishes a ${backend} move interrupted immediately after target selection without restoring stale source grants`, async () => {
		const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-cut-source-"));
		const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-cut-target-"));
		directories.push(sourceDirectory, targetDirectory);
		const { file: source, id } = await freshSessionFile(sourceDirectory, backend);
		const target = path.join(targetDirectory, path.basename(source));
		const before = await readAuthorityDescriptor(source);
		const rename = fs.rename;
		let interrupted = false;
		const cut = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (
				!interrupted &&
				String(to) === authorityPaths(target).descriptor &&
				(await readAuthorityDescriptor(target))?.state === "active"
			) {
				interrupted = true;
				throw new Error("injected relocation selection interruption");
			}
		});
		try {
			await expect(moveAuthorityBundle(source, target)).rejects.toThrow(
				/injected relocation selection interruption/,
			);
		} finally {
			cut.mockRestore();
		}
		expect(interrupted).toBe(true);
		for (const file of [source, target]) {
			expect(
				(await fs.readdir(path.dirname(file))).some(name =>
					name.startsWith(`${path.basename(file)}.authority.stage.`),
				),
			).toBe(true);
			await expect(registryDurableStateForSession(file, { owningSessionId: id })).rejects.toThrow();
		}
		await moveAuthorityBundle(source, target);
		expect((await readAuthorityDescriptor(target))?.incarnation).toBe(before?.incarnation);
		expect(await Bun.file(source).exists()).toBe(false);
		const store = await registryDurableStateForSession(target, { owningSessionId: id });
		await store.close();
	});
}

// Each matrix case performs several real authority opens (funded capacity, exclusive
// SQLite configuration) plus fsync-durable relocation steps: 1.8-6.5 s per case on the
// shared XFS host, so Bun's 5 s default cuts off functionally completing cases.
const AUTHORITY_MATRIX_TIMEOUT_MS = 30_000;
const relocationCuts = [
	"guards-installed",
	"target-transcript",
	"target-artifacts",
	"target-payload",
	"before-selection",
	"selected",
	"source-authority-retired",
	"source-transcript-retired",
	"completed",
] as const;
for (const backend of ["jsonl", "sqlite"] as const) {
	for (const cut of relocationCuts) {
		for (const action of ["finish", "abort"] as const) {
			it(
				`${backend} relocation ${action} preserves its decision at ${cut}`,
				async () => {
					const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relocation-matrix-"));
					directories.push(directory);
					const { file: source, id } = await freshSessionFile(directory, backend);
					const targetDirectory = path.join(directory, "target");
					await fs.mkdir(targetDirectory);
					const target = path.join(targetDirectory, path.basename(source));
					const before = await settledEvidence(source, id, backend);
					const originalTranscript = await fs.readFile(source);
					const originalDescriptor = await readAuthorityDescriptor(source);
					await expect(
						relocateSessionAuthority(source, target, { cwd: targetDirectory, faultAt: cut }),
					).rejects.toThrow(/injected relocation fault/i);
					const selected = [
						"selected",
						"source-authority-retired",
						"source-transcript-retired",
						"completed",
					].includes(cut);
					if (action === "abort" && selected) {
						await expect(recoverAuthorityRelocation(target, "abort")).rejects.toThrow(/selected|finish/i);
						await recoverAuthorityRelocation(target, "finish");
					} else {
						await recoverAuthorityRelocation(target, action);
					}
					if (action === "abort" && !selected) {
						expect(await fs.readFile(source)).toEqual(originalTranscript);
						expect((await readAuthorityDescriptor(source))?.incarnation).toBe(originalDescriptor?.incarnation);
						expect(await Bun.file(target).exists()).toBe(false);
						expect(await offlineState(source)).toEqual(before);
						await recoverAuthorityRelocation(source, "abort");
					} else {
						await recoverAuthorityRelocation(target, "finish");
						expect((await readAuthorityDescriptor(target))?.incarnation).toBe(originalDescriptor?.incarnation);
						expect(await fs.readFile(target, "utf8")).toContain(`"cwd":"${targetDirectory}"`);
						expect(await Bun.file(source).exists()).toBe(false);
						expect(await offlineState(target)).toEqual(before);
						const store = await registryDurableStateForSession(target, { owningSessionId: id });
						await store.close();
					}
				},
				AUTHORITY_MATRIX_TIMEOUT_MS,
			);
		}
	}
}

for (const backend of ["jsonl", "sqlite"] as const) {
	for (const cut of [
		"guards-installed",
		"before-selection",
		"selected",
		"source-authority-retired",
		"source-transcript-retired",
		"completed",
	] as const) {
		for (const action of ["finish", "abort"] as const) {
			it(
				`${backend} deletion ${action} at ${cut} retains a completely restorable authority export`,
				async () => {
					const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delete-matrix-"));
					directories.push(directory);
					const { file, id } = await freshSessionFile(directory, backend);
					const before = await settledEvidence(file, id, backend);
					const transcript = await fs.readFile(file);
					await expect(deleteSessionAuthorityBundle(file, { faultAt: cut })).rejects.toThrow(
						/injected relocation fault/i,
					);
					const guard = (await fs.readdir(directory)).find(name =>
						name.startsWith(`${path.basename(file)}.authority.stage.`),
					);
					if (!guard) throw new Error("Expected durable deletion provenance.");
					const selected = cut !== "guards-installed" && cut !== "before-selection";
					if (action === "abort" && !selected) {
						await recoverAuthorityRelocation(file, "abort");
						expect(await fs.readFile(file)).toEqual(transcript);
						expect(await offlineState(file)).toEqual(before);
					} else {
						if (action === "abort")
							await expect(recoverAuthorityRelocation(file, "abort")).rejects.toThrow(/selected|finish/i);
						await recoverAuthorityRelocation(file, "finish");
						await recoverAuthorityRelocation(file, "finish");
						expect(await Bun.file(file).exists()).toBe(false);
						expect(await Bun.file(authorityPaths(file).descriptor).exists()).toBe(false);
						const retained = path.join(directory, guard);
						const envelope = JSON.parse(await fs.readFile(path.join(retained, "relocation.json"), "utf8")) as {
							manifest: { snapshots: { entries: { name: string; kind: string }[] }[] };
						};
						const entries: { name: string; data: Uint8Array }[] = [];
						for (const [index, entry] of envelope.manifest.snapshots[0].entries.entries()) {
							if (entry.kind !== "file" || !entry.name.startsWith("authority/")) continue;
							let data = await fs.readFile(path.join(retained, "original", "0", String(index)));
							const name = entry.name.slice(10);
							if (name === "authority.json") {
								const descriptor = JSON.parse(data.toString("utf8")) as {
									backend: JournalingBackend;
									payload: string;
								};
								descriptor.payload = `authority.${descriptor.backend === "sqlite" ? "sqlite" : "jsonl"}`;
								data = Buffer.from(`${JSON.stringify(descriptor)}\n`);
							}
							entries.push({ name, data });
						}
						const recoveryDirectory = path.join(directory, "recovered");
						await fs.mkdir(recoveryDirectory);
						const target = await sessionFile(recoveryDirectory, restoredId);
						await restoreAuthorityBundle(target, { version: 1, owningSessionId: id, entries });
						expect({ ...(await offlineState(target)), sourceIdentity: before.sourceIdentity }).toEqual(before);
					}
				},
				AUTHORITY_MATRIX_TIMEOUT_MS,
			);
		}
	}
}

for (const backend of ["jsonl", "sqlite"] as const) {
	for (const cut of relocationCuts) {
		for (const action of ["finish", "abort"] as const) {
			it(
				`${backend} all-copy replacement ${action} retains complete displaced evidence at ${cut}`,
				async () => {
					const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-replace-matrix-"));
					directories.push(directory);
					const { file: source, id } = await freshSessionFile(directory, backend);
					const before = await settledEvidence(source, id, backend);
					const incoming = await packAuthorityBundle(source);
					if (!incoming) throw new Error("Expected selected incoming authority.");
					const copyDirectory = path.join(directory, "copy");
					const targetDirectory = path.join(directory, "target");
					await fs.mkdir(copyDirectory);
					await fs.mkdir(targetDirectory);
					const copy = await sessionFile(copyDirectory, id);
					await restoreAuthorityBundle(copy, incoming);
					const copyBefore = await offlineState(copy);
					const target = path.join(targetDirectory, path.basename(source));
					await fs.mkdir(source.slice(0, -6), { mode: 0o700 });
					const displacedArtifact = path.join(source.slice(0, -6), "7.bash.log");
					await fs.writeFile(displacedArtifact, "displaced collision", { mode: 0o640 });
					await fs.chmod(displacedArtifact, 0o640);
					expect((await fs.stat(displacedArtifact)).mode & 0o777).toBe(0o640);
					const transcript = await fs.readFile(source);
					await expect(
						replaceSessionAuthorityBundle({
							sources: [source, copy],
							target,
							owningSessionId: id,
							transcript,
							artifacts: [{ name: "7.bash.log", data: Buffer.from("incoming collision") }],
							authority: incoming,
							cwd: targetDirectory,
							faultAt: cut,
						}),
					).rejects.toThrow(/injected relocation fault/i);
					const selected = [
						"selected",
						"source-authority-retired",
						"source-transcript-retired",
						"completed",
					].includes(cut);
					if (action === "abort" && selected) {
						await expect(recoverAuthorityRelocation(target, "abort")).rejects.toThrow(/selected|finish/i);
						await recoverAuthorityRelocation(target, "finish");
					} else await recoverAuthorityRelocation(target, action);
					if (action === "abort" && !selected) {
						expect(await fs.readFile(source)).toEqual(transcript);
						expect(await offlineState(source)).toEqual(before);
						expect(await offlineState(copy)).toEqual(copyBefore);
						expect(await Bun.file(target).exists()).toBe(false);
						await recoverAuthorityRelocation(copy, "abort");
					} else {
						await recoverAuthorityRelocation(target, "finish");
						const restored = await offlineState(target);
						expect(restored.sourceIdentity.incarnation).not.toBe(before.sourceIdentity.incarnation);
						expect({ ...restored, sourceIdentity: before.sourceIdentity }).toEqual(before);
						expect(await Bun.file(source).exists()).toBe(false);
						expect(await Bun.file(copy).exists()).toBe(false);
						expect(await fs.readFile(path.join(target.slice(0, -6), "7.bash.log"), "utf8")).toBe(
							"incoming collision",
						);
						const receipt = (await fs.readdir(targetDirectory)).find(name =>
							name.startsWith(`${path.basename(target)}.authority.backup.`),
						);
						if (!receipt) throw new Error("Expected durable whole-bundle provenance.");
						const retained = path.join(targetDirectory, receipt);
						const envelope = JSON.parse(await fs.readFile(path.join(retained, "relocation.json"), "utf8")) as {
							manifest: { snapshots: { sessionFile: string; entries: { name: string; mode: number }[] }[] };
						};
						expect(envelope.manifest.snapshots).toHaveLength(3);
						const snapshotIndex = envelope.manifest.snapshots.findIndex(
							snapshot => snapshot.sessionFile === source,
						);
						const entryIndex = envelope.manifest.snapshots[snapshotIndex].entries.findIndex(
							entry => entry.name === "artifacts/7.bash.log",
						);
						expect(envelope.manifest.snapshots[snapshotIndex].entries[entryIndex].mode).toBe(0o640);
						expect(
							await fs.readFile(
								path.join(retained, "original", String(snapshotIndex), String(entryIndex)),
								"utf8",
							),
						).toBe("displaced collision");
					}
				},
				AUTHORITY_MATRIX_TIMEOUT_MS,
			);
		}
	}
}

it("preserves transcript mode and artifact symlink metadata during a genuine move", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-metadata-"));
	directories.push(directory);
	const { file: source } = await freshSessionFile(directory);
	await fs.chmod(source, 0o640);
	expect((await fs.stat(source)).mode & 0o777).toBe(0o640);
	await fs.mkdir(source.slice(0, -6), { mode: 0o750 });
	await fs.chmod(source.slice(0, -6), 0o750);
	expect((await fs.stat(source.slice(0, -6))).mode & 0o777).toBe(0o750);
	await fs.symlink("external-reference", path.join(source.slice(0, -6), "link"));
	const target = path.join(directory, "target", path.basename(source));
	await moveAuthorityBundle(source, target);
	expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
	expect((await fs.stat(target.slice(0, -6))).mode & 0o777).toBe(0o750);
	expect(await fs.readlink(path.join(target.slice(0, -6), "link"))).toBe("external-reference");
});

it("recovers a completed move when retiring the source guard reports failure after rename", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-guard-retirement-"));
	directories.push(directory);
	const { file: source, id } = await freshSessionFile(directory);
	const target = path.join(directory, "target", path.basename(source));
	const before = await settledEvidence(source, id, "jsonl");
	const rename = fs.rename;
	let interrupted = false;
	const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		await rename(from, to);
		if (!interrupted && String(to).includes(".authority-retired-guard.")) {
			interrupted = true;
			throw new Error("injected source guard retirement");
		}
	});
	try {
		await expect(moveAuthorityBundle(source, target)).rejects.toThrow(/injected source guard retirement/);
	} finally {
		spy.mockRestore();
	}
	expect(interrupted).toBe(true);
	await moveAuthorityBundle(source, target);
	await recoverAuthorityRelocation(target, "finish");
	expect(await offlineState(target)).toEqual(before);
	expect(await Bun.file(source).exists()).toBe(false);
	expect((await fs.readdir(directory)).some(name => name.includes(".authority-retired-guard."))).toBe(false);
});

it("completes an abort whose durable source receipt publication reports an unknown rename outcome", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-abort-receipt-"));
	directories.push(directory);
	const { file: source, id } = await freshSessionFile(directory);
	const target = path.join(directory, "target", path.basename(source));
	const before = await settledEvidence(source, id, "jsonl");
	await expect(relocateSessionAuthority(source, target, { faultAt: "before-selection" })).rejects.toThrow(
		/injected relocation fault/i,
	);
	const rename = fs.rename;
	let interrupted = false;
	const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		await rename(from, to);
		if (!interrupted && String(from).includes(".authority-receipt.")) {
			interrupted = true;
			throw new Error("injected receipt publication");
		}
	});
	try {
		await expect(recoverAuthorityRelocation(target, "abort")).rejects.toThrow(/injected receipt publication/);
	} finally {
		spy.mockRestore();
	}
	expect(interrupted).toBe(true);
	await recoverAuthorityRelocation(target, "abort");
	await recoverAuthorityRelocation(source, "abort");
	expect(await offlineState(source)).toEqual(before);
	await moveAuthorityBundle(source, target);
	expect(await offlineState(target)).toEqual(before);
});

it("reuses only the exact empty target anchor left by a refused preparation", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-empty-target-reservation-"));
	directories.push(directory);
	const { file: source } = await freshSessionFile(directory);
	const marker = await fs.readFile(authorityPaths(source).legacyFence);
	await fs.unlink(authorityPaths(source).legacyFence);
	const target = path.join(directory, "target", path.basename(source));
	await expect(moveAuthorityBundle(source, target)).rejects.toThrow();
	expect(await Bun.file(source).exists()).toBe(true);
	expect(await Bun.file(target).exists()).toBe(false);
	const anchor = await fs.stat(authorityPaths(target).lock);
	await fs.writeFile(authorityPaths(source).legacyFence, marker, { mode: 0o600 });
	await moveAuthorityBundle(source, target);
	expect((await readAuthorityDescriptor(target))?.physicalIdentity).toEqual({
		dev: String(anchor.dev),
		ino: String(anchor.ino),
	});
	expect(await Bun.file(source).exists()).toBe(false);
});

it("restores an archived session after whole-session deletion without discarding the deletion receipt", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-deleted-root-"));
	directories.push(directory);
	const { file, id } = await freshSessionFile(directory);
	const before = await settledEvidence(file, id, "jsonl");
	const transcript = await fs.readFile(file);
	const bundle = await packAuthorityBundle(file);
	if (!bundle) throw new Error("Expected archived authority.");
	await deleteSessionAuthorityBundle(file);
	await recoverAuthorityRelocation(file, "finish");
	await replaceSessionAuthorityBundle({
		sources: [],
		target: file,
		owningSessionId: id,
		transcript,
		artifacts: [],
		authority: bundle,
		cwd: directory,
	});
	const after = await offlineState(file);
	expect(after.sourceIdentity.incarnation).not.toBe(before.sourceIdentity.incarnation);
	expect({ ...after, sourceIdentity: before.sourceIdentity }).toEqual(before);
	expect(
		(await fs.readdir(directory)).some(name => name.startsWith(`.${path.basename(file)}.authority-deleted.`)),
	).toBe(true);
});

it("rejects a file/directory artifact collision before reserving or publishing a replacement", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-replace-artifact-collision-"));
	directories.push(directory);
	const { file: source, id } = await freshSessionFile(directory);
	const target = path.join(directory, "target", path.basename(source));
	await expect(
		replaceSessionAuthorityBundle({
			sources: [],
			target,
			owningSessionId: id,
			transcript: await fs.readFile(source),
			artifacts: [
				{ name: "a/b", data: Buffer.from("nested") },
				{ name: "a", data: Buffer.from("file") },
			],
			cwd: directory,
		}),
	).rejects.toThrow(/collid|directory/i);
	expect(await Bun.file(target).exists()).toBe(false);
	expect(await Bun.file(authorityPaths(target).lock).exists()).toBe(false);
});

it("does not silently finish a retained move as a different requested cwd", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-request-binding-"));
	directories.push(directory);
	const { file: source } = await freshSessionFile(directory);
	const target = path.join(directory, "target", path.basename(source));
	await expect(
		relocateSessionAuthority(source, target, { cwd: directory, faultAt: "before-selection" }),
	).rejects.toThrow(/injected relocation fault/i);
	const changedCwd = path.join(directory, "another-workspace");
	await expect(relocateSessionAuthority(source, target, { cwd: changedCwd })).rejects.toThrow(
		/cwd|different.*request/i,
	);
	await recoverAuthorityRelocation(target, "abort");
	await relocateSessionAuthority(source, target, { cwd: changedCwd });
	expect(await fs.readFile(target, "utf8")).toContain(`"cwd":"${changedCwd}"`);
});

it("moves a real selected manager with its cwd, title and authority incarnation intact", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selected-manager-move-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "persisted request", timestamp: 1 });
	await manager.ensureOnDisk();
	await manager.setSessionName("Selected move title", "user");
	const source = manager.getSessionFile();
	if (!source) throw new Error("Expected manager-owned physical root.");
	const id = manager.getSessionId();
	const initial = await registryDurableStateForSession(source, {
		owningSessionId: id,
		backend: "jsonl",
		create: true,
	});
	await initial.close();
	const before = await settledEvidence(source, id, "jsonl");
	const cwd = path.join(directory, "workspace");
	const additionalRoot = path.join(directory, "other-workspace");
	await fs.mkdir(cwd);
	await manager.addWorkspaceDirectory(cwd);
	await manager.addWorkspaceDirectory(additionalRoot);
	const sourceSize = (await fs.stat(source)).size;
	const targetDirectory = path.join(directory, "relocated");
	try {
		await manager.moveTo(cwd, targetDirectory);
		const target = manager.getSessionFile();
		if (!target) throw new Error("Expected relocated physical root.");
		expect(path.dirname(target)).toBe(targetDirectory);
		expect(manager.getCwd()).toBe(cwd);
		expect(await fs.readFile(target, "utf8")).toContain("Selected move title");
		expect(await fs.readFile(target, "utf8")).toContain(`"cwd":"${cwd}"`);
		expect((await fs.stat(target)).size).not.toBe(sourceSize);
		expect(manager.getAdditionalDirectories()).toEqual([additionalRoot]);
		expect(manager.getHeader()?.previousSessionFiles).toContain(source);
		manager.appendMessage({ role: "user", content: "written after selected move", timestamp: 2 });
		await manager.flush();
		expect(await manager.setSessionName("Post-move title", "user")).toBe(true);
		await manager.addWorkspaceDirectory(path.join(directory, "post-move-root"));
		const reopenedManager = await SessionManager.open(target, targetDirectory);
		try {
			expect(reopenedManager.getCwd()).toBe(cwd);
			expect(reopenedManager.getAdditionalDirectories()).toEqual([
				additionalRoot,
				path.join(directory, "post-move-root"),
			]);
			expect(reopenedManager.getSessionName()).toBe("Post-move title");
			expect(
				reopenedManager
					.getEntries()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === "written after selected move",
					),
			).toBe(true);
		} finally {
			await reopenedManager.close();
		}
		expect(await offlineState(target)).toEqual(before);
		expect(await Bun.file(source).exists()).toBe(false);
		await expect(registryDurableStateForSession(source, { owningSessionId: id })).rejects.toThrow();
	} finally {
		await manager.close();
	}
});

for (const changed of ["size", "identity"] as const) {
	it(`refuses a selected-manager target whose ${changed} changes after grouped publication without overwriting it`, async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selected-manager-freshness-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		manager.appendMessage({ role: "user", content: "owned source", timestamp: 1 });
		await manager.ensureOnDisk();
		const source = manager.getSessionFile();
		if (!source) throw new Error("Expected manager-owned physical root.");
		const store = await registryDurableStateForSession(source, {
			owningSessionId: manager.getSessionId(),
			backend: "jsonl",
			create: true,
		});
		await store.close();
		const retainedAuthority = await offlineState(source);
		const targetDirectory = path.join(directory, "relocated");
		const target = path.join(targetDirectory, path.basename(source));
		const open = fs.open;
		const restoreHandles: (() => void)[] = [];
		let published: Buffer | undefined;
		let changedBytes: Buffer | undefined;
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await open(file, flags, mode);
			if (
				String(file) === authorityPaths(source).lock &&
				typeof flags === "number" &&
				(flags & fs.constants.O_RDWR) !== 0
			) {
				const close = handle.close.bind(handle);
				const closeSpy = spyOn(handle, "close").mockImplementation(async () => {
					await close();
					if (published) return;
					published = await fs.readFile(target);
					if (changed === "size") {
						changedBytes = Buffer.concat([published, Buffer.from('{"type":"custom","external":true}\n')]);
						await fs.writeFile(target, changedBytes);
					} else {
						changedBytes = Buffer.from(published.toString("utf8").replace("owned source", "other source"));
						expect(changedBytes.byteLength).toBe(published.byteLength);
						await fs.rename(target, `${target}.displaced`);
						await fs.writeFile(target, changedBytes, { mode: 0o600 });
					}
				});
				restoreHandles.push(() => closeSpy.mockRestore());
			}
			return handle;
		});
		let caught: unknown;
		try {
			await manager.moveTo(path.join(directory, "longer-workspace"), targetDirectory);
		} catch (error) {
			caught = error;
		} finally {
			openSpy.mockRestore();
			for (const restore of restoreHandles) restore();
		}
		let managerClosed = false;
		try {
			if (!published || !changedBytes) throw new Error("Expected a real post-publication target change.");
			if (changed === "size") {
				expect(caught).toBeInstanceOf(SessionWriteConflictError);
				expect(caught).toMatchObject({ expectedSize: published.byteLength, actualSize: changedBytes.byteLength });
			} else {
				expect(caught).toBeInstanceOf(Error);
				expect((caught as Error).message).toMatch(/destination identity changed/i);
			}
			expect((await fs.readFile(target)).equals(changedBytes)).toBe(true);
			expect(await Bun.file(source).exists()).toBe(false);
			expect(await manager.setSessionName("must not rewrite rejected relocation", "user")).toBe(false);
			manager.appendMessage({ role: "user", content: "must not recreate retired source", timestamp: 2 });
			let flushFailure: unknown;
			try {
				await manager.flush();
			} catch (error) {
				flushFailure = error;
			}
			let workspaceFailure: unknown;
			try {
				await manager.addWorkspaceDirectory(path.join(directory, "must-not-publish-workspace"));
			} catch (error) {
				workspaceFailure = error;
			}
			expect(await Bun.file(source).exists()).toBe(false);
			expect((await fs.readFile(target)).equals(changedBytes)).toBe(true);
			expect(await offlineState(target)).toEqual(retainedAuthority);
			let closeFailure: unknown;
			try {
				await manager.close();
			} catch (error) {
				closeFailure = error;
			}
			managerClosed = true;
			expect(flushFailure).toBe(changed === "size" ? caught : undefined);
			expect(workspaceFailure).toBeUndefined();
			expect(closeFailure).toBe(changed === "size" ? caught : undefined);
		} finally {
			if (!managerClosed) {
				try {
					await manager.close();
				} catch (error) {
					if (changed !== "size" || error !== caught) throw error;
				}
			}
		}
	});
}
for (const publication of ["rename", "directory-sync"] as const) {
	for (const action of ["finish", "abort"] as const) {
		it(`seals a real manager after preparation ${publication} and grouped release both fail, retaining ${action} recovery`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-selected-manager-combined-failure-"));
			directories.push(directory);
			const manager = SessionManager.create(directory, directory);
			manager.appendMessage({ role: "user", content: "retained source", timestamp: 1 });
			await manager.ensureOnDisk();
			const source = manager.getSessionFile();
			if (!source) throw new Error("Expected manager-owned physical root.");
			const id = manager.getSessionId();
			const store = await registryDurableStateForSession(source, {
				owningSessionId: id,
				backend: "jsonl",
				create: true,
			});
			await store.close();
			const initialWorkspace = path.join(directory, "initial-workspace");
			await fs.mkdir(initialWorkspace);
			await manager.addWorkspaceDirectory(initialWorkspace);
			const before = await settledEvidence(source, id, "jsonl");
			const transcript = await fs.readFile(source);
			const sourcePaths = authorityPaths(source);
			const descriptor = await fs.readFile(sourcePaths.descriptor);
			const receipt = await fs.readFile(sourcePaths.jsonl);
			const initialDirectories = [initialWorkspace];
			const initialHeader = structuredClone(manager.getHeader());
			const targetDirectory = path.join(directory, "relocated");
			const target = path.join(targetDirectory, path.basename(source));
			const publicationFailure = new Error(`injected preparation ${publication} outcome`);
			const cleanupFailure = new Error("injected grouped source anchor close failure");
			const rename = fs.rename;
			const open = fs.open;
			const restoreHandles: (() => void)[] = [];
			let preparationRenamed = false;
			let publicationFailed = false;
			let cleanupFailed = false;
			const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
				await rename(from, to);
				if (
					!preparationRenamed &&
					String(from).startsWith(path.join(targetDirectory, `.${path.basename(target)}.relocation-`)) &&
					String(to).startsWith(`${target}.authority.stage.`)
				) {
					preparationRenamed = true;
					if (publication === "rename") {
						publicationFailed = true;
						throw publicationFailure;
					}
				}
			});
			const openSpy = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
				const handle = await open(file, flags, mode);
				if (String(file) === targetDirectory && publication === "directory-sync") {
					const sync = handle.sync.bind(handle);
					const syncSpy = spyOn(handle, "sync").mockImplementation(async () => {
						await sync();
						if (preparationRenamed && !publicationFailed) {
							publicationFailed = true;
							throw publicationFailure;
						}
					});
					restoreHandles.push(() => syncSpy.mockRestore());
				}
				if (String(file) === sourcePaths.lock && typeof flags === "number" && (flags & fs.constants.O_RDWR) !== 0) {
					const close = handle.close.bind(handle);
					const closeSpy = spyOn(handle, "close").mockImplementation(async () => {
						await close();
						if (publicationFailed && !cleanupFailed) {
							cleanupFailed = true;
							throw cleanupFailure;
						}
					});
					restoreHandles.push(() => closeSpy.mockRestore());
				}
				return handle;
			});
			let caught: unknown;
			try {
				await manager.moveTo(path.join(directory, "workspace"), targetDirectory);
			} catch (error) {
				caught = error;
			} finally {
				renameSpy.mockRestore();
				openSpy.mockRestore();
				for (const restore of restoreHandles) restore();
			}
			try {
				expect(publicationFailed).toBe(true);
				expect(cleanupFailed).toBe(true);
				expect(caught).toBeInstanceOf(AuthorityCleanupError);
				if (!(caught instanceof AuthorityCleanupError) || !caught.pending)
					throw new Error("Expected the original pending authority cleanup owner.");
				const interrupted = caught.errors.find(
					(error: unknown): error is AuthorityRelocationInterruptedError =>
						error instanceof AuthorityRelocationInterruptedError,
				);
				expect(interrupted).toBeInstanceOf(AuthorityRelocationInterruptedError);
				if (!interrupted) throw new Error("Expected retained relocation interruption in the cleanup error graph.");
				expect(interrupted.recoverySessionFile).toBe(target);
				expect(interrupted.cause).toBe(publicationFailure);
				expect(caught.cause).toBe(interrupted);
				expect(caught.errors).toContain(cleanupFailure);
				const assertTranscriptWorkspace = (content: Buffer) => {
					const parsed = parseSessionContent(content.toString("utf8"));
					expect(parsed.invalidHeader).toBe(false);
					const header = parsed.entries[0];
					expect(header?.type).toBe("session");
					if (!header || header.type !== "session")
						throw new Error("Expected a session header in the retained transcript.");
					expect(header.id).toBe(id);
					expect(header.additionalDirectories).toEqual(initialDirectories);
				};
				const assertSourceUntouched = async () => {
					expect(await fs.readFile(source)).toEqual(transcript);
					expect(await fs.readFile(sourcePaths.descriptor)).toEqual(descriptor);
					expect(await fs.readFile(sourcePaths.jsonl)).toEqual(receipt);
					expect(await offlineState(source)).toEqual(before);
				};
				const assertMutationFence = async () => {
					expect(manager.getAdditionalDirectories()).toEqual(initialDirectories);
					expect(manager.getHeader()).toEqual(initialHeader);
					expect(initialHeader?.additionalDirectories).toEqual(initialDirectories);
					assertTranscriptWorkspace(transcript);
					manager.appendMessage({ role: "user", content: "must not write after interruption", timestamp: 2 });
					await manager.flush();
					expect(await manager.setSessionName("must not replace retained source", "user")).toBe(false);
					expect(
						await manager.addWorkspaceDirectory(path.join(directory, "must-not-publish-workspace")),
					).toBeNull();
					expect(manager.getAdditionalDirectories()).toEqual(initialDirectories);
					expect(manager.getHeader()).toEqual(initialHeader);
					expect(await manager.removeWorkspaceDirectory(initialWorkspace)).toBeNull();
					expect(manager.getAdditionalDirectories()).toEqual(initialDirectories);
					expect(manager.getHeader()).toEqual(initialHeader);
					await manager.setAdditionalDirectories([path.join(directory, "must-not-set-workspace")]);
					expect(manager.getAdditionalDirectories()).toEqual(initialDirectories);
					expect(manager.getHeader()).toEqual(initialHeader);
				};
				await assertMutationFence();
				await assertSourceUntouched();
				expect(
					(await fs.readdir(targetDirectory)).some(name =>
						name.startsWith(`${path.basename(target)}.authority.stage.`),
					),
				).toBe(true);
				await caught.cleanup();
				expect<boolean>(caught.pending).toBe(false);
				await assertMutationFence();
				await assertSourceUntouched();
				await recoverAuthorityRelocation(target, action);
				await recoverAuthorityRelocation(target, action);
				const recoveryEvidence = action === "finish" ? target : source;
				const recoveryTranscript = await fs.readFile(recoveryEvidence);
				const recoveryPaths = authorityPaths(recoveryEvidence);
				const recoveryDescriptor = await fs.readFile(recoveryPaths.descriptor);
				const recoveryReceipt = await fs.readFile(recoveryPaths.jsonl);
				assertTranscriptWorkspace(recoveryTranscript);
				if (action === "finish") {
					expect(await offlineState(target)).toEqual(before);
					expect(await Bun.file(source).exists()).toBe(false);
					await expect(registryDurableStateForSession(source, { owningSessionId: id })).rejects.toThrow();
				} else {
					expect(await offlineState(source)).toEqual(before);
					expect(await fs.readFile(source)).toEqual(transcript);
					expect(await Bun.file(target).exists()).toBe(false);
				}
				await assertMutationFence();
				if (action === "abort") await assertSourceUntouched();
				else {
					expect(await fs.readFile(target)).toEqual(recoveryTranscript);
					expect(await fs.readFile(recoveryPaths.descriptor)).toEqual(recoveryDescriptor);
					expect(await fs.readFile(recoveryPaths.jsonl)).toEqual(recoveryReceipt);
					expect(await offlineState(target)).toEqual(before);
				}
			} finally {
				if (caught instanceof AuthorityCleanupError && caught.pending) await caught.cleanup();
				manager.seal();
				await manager.close();
			}
		});
	}
}
