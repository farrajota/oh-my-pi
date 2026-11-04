import { afterEach, describe, expect, it, vi } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { EditTool } from "../../src/edit";
import { attemptEditAutoRepair } from "../../src/edit/auto-repair";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";
import { applyEditsThenRename, applyWorkspaceEdit } from "../../src/lsp/edits";
import { fileToUri } from "../../src/lsp/utils";
import { filesystemMutationHooks } from "../../src/tools/file-write-fallback";
import { SessionPathScope } from "../../src/internal/session-path-scope";
import * as nodeFs from "node:fs";
import type { LocalProtocolOptions } from "../../src/internal-urls/local-protocol";
import { DurableLocalState } from "../../src/registry/authority-local";
import {
	AuthorityRpcClient,
	AuthorityRpcError,
	detachFromAuthorityEffect,
	withAuthorityEffect,
} from "../../src/registry/authority/client";
import * as lspConfig from "../../src/lsp/config";
import * as lspClient from "../../src/lsp/client";
import { createLspWritethrough } from "../../src/lsp/writethrough";
import { BiomeClient } from "../../src/lsp/clients/biome-client";
import type { LinterClient, LspClient, ServerConfig } from "../../src/lsp/types";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import { durableBackingSha256, durableTargetHash, canonicalDurableSha256 } from "../../src/registry/durable-state";
import type { AuthorityStore } from "../../src/registry/authority/types";
import type { DurableRegistryRecord } from "../../src/registry/durable-state";
import {
	bindSessionOperationDurability,
	bindSessionOperationAuthority,
	getOperationTerminal,
	installSessionOperationLedger,
	issueBoundSessionOperationAuthority,
	runFilesystemOperation,
	runLocalOperation,
} from "../../src/registry/operation-lease";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "../../src/tools/write";
import { ReadTool } from "../../src/tools/read";
import { createTools } from "../../src/tools";
import { ToolChoiceQueue } from "../../src/session/tool-choice-queue";
import { locateIdb } from "../../src/ida/store";
import * as sqliteReader from "../../src/tools/sqlite-reader";
import { readJson, parseJsonSelector } from "../../src/tools/read-json";
import { readBinary } from "../../src/tools/read-binary";
import * as ida from "../../src/ida";
import { prepareStoreDir } from "../../src/ida/store";
import { AstEditTool } from "../../src/tools/ast-edit";
import { IdaDatabase } from "../../src/ida";
import * as launchClient from "../../src/launch/client";
import type { DaemonBrokerClient } from "../../src/launch/client";
import { Shell } from "@oh-my-pi/pi-natives";
import { ToolAbortError, ToolError } from "../../src/tools/tool-errors";

const clients: AuthorityRpcClient[] = [];
const directories: string[] = [];
const closeControls: Array<() => Promise<void>> = [];

async function createAuthorityStore(directory: string): Promise<AuthorityRpcClient & AuthorityStore> {
	const sessionFile = path.join(directory, "session.jsonl");
	await fs.writeFile(sessionFile, '{"type":"session","id":"root"}\n');
	const ownership = await acquireAuthorityOwnership(sessionFile, { owningSessionId: "root", create: true });
	const client = await AuthorityRpcClient.open(
		{
			path: ownership.paths.jsonl,
			identity: { backend: "jsonl", owningSessionId: "root", incarnation: Bun.randomUUIDv7(), format: 2 },
			create: true,
		},
		ownership,
	);
	clients.push(client);
	return client as AuthorityRpcClient & AuthorityStore;
}

async function createOperationContext(store: AuthorityStore, cwd: string, validate: () => boolean = () => true) {
	const manager = {};
	const control = installSessionOperationLedger(manager);
	closeControls.push(() => control.close());
	bindSessionOperationDurability(manager, store);
	const authority = issueBoundSessionOperationAuthority(
		{
			capability: {},
			actorId: "Worker",
			rootId: "Main",
			generation: 1,
			sessionFile: null,
			validate,
		},
		manager,
	);
	await bindSessionOperationAuthority(manager, authority);
	const scope = new SessionPathScope({
		actorId: () => "Worker",
		sessionId: () => "root",
		operationManager: () => manager,
		cwd: () => cwd,
		permissionScope: () => undefined,
	});
	return { manager, scope, authority };
}

function createWriteTool(
	cwd: string,
	scope: SessionPathScope,
	localProtocolOptions?: LocalProtocolOptions,
	bridge?: {
		readonly capabilities: { readonly writeTextFile: boolean };
		writeTextFile(request: { path: string; content: string }): Promise<void>;
	},
): WriteTool {
	const session = {
		cwd,
		enableLsp: false,
		getSessionFile: () => null,
		pathScope: scope,
		settings: Settings.isolated(),
		localProtocolOptions,
		getClientBridge: bridge ? () => bridge : undefined,
	} as unknown as ToolSession;
	return new WriteTool(session);
}

function executeWrite(
	manager: object,
	scope: SessionPathScope,
	tool: WriteTool,
	operationId: string,
	effectClass: "filesystem" | "local",
	filePath: string,
	content: string,
	signal?: AbortSignal,
) {
	const execute = () =>
		scope.withOperationLease(operationId, () =>
			tool.execute(`write-${operationId}`, { path: filePath, content }, signal),
		);
	if (effectClass === "local") return runLocalOperation(manager, operationId, execute, signal);
	return runFilesystemOperation(manager, operationId, execute, signal);
}

/** Holds the host response only after the real worker/store commit has returned. */
function holdCommittedTransitionAcknowledgements(
	client: AuthorityRpcClient & AuthorityStore,
	afterCommit: (record: DurableRegistryRecord) => Promise<void>,
): void {
	const transition = client.transition.bind(client);
	client.transition = async (record, options) => {
		const receipt = await transition(record, options);
		await afterCommit(record);
		return receipt;
	};
}

function errorConstituents(error: unknown): readonly unknown[] {
	const pending = [error];
	const seen = new Set<unknown>();
	for (let index = 0; index < pending.length; index++) {
		const current = pending[index];
		if (seen.has(current)) continue;
		seen.add(current);
		if (current instanceof AggregateError) pending.push(...current.errors);
		if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
	}
	return [...seen];
}

async function removeDirectories(): Promise<void> {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
}

afterEach(async () => {
	await Promise.all(closeControls.splice(0).map(close => close()));
	await Promise.all(clients.splice(0).map(client => client.close()));
	await removeDirectories();
});

describe("authority-managed filesystem effects", () => {
	it("runs the JSON query against admitted bytes after pathname replacement", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-inode-authority-"));
		directories.push(root);
		const target = path.join(root, "input.json");
		await fs.writeFile(target, '{"value":"original-value"}');
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		let opens = 0;
		let replaced = false;
		const open = nodeFs.promises.open;
		const spy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === target && ++opens === 2) {
				await fs.rename(target, `${target}.old`);
				await fs.writeFile(target, '{"value":"replacement-value"}');
				replaced = true;
			}
			return handle;
		});
		const tool = new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			pathScope: scope,
		} as unknown as ToolSession);
		try {
			const result = await runFilesystemOperation(manager, "filesystem:json-inode", () =>
				scope.withOperationLease("filesystem:json-inode", () =>
					tool.execute("read-json", { path: `${target}?q=.value` }),
				),
			);
			expect(replaced).toBe(true);
			expect(result.content.some(item => item.type === "text" && item.text.includes("original-value"))).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe('{"value":"replacement-value"}');
		} finally {
			spy.mockRestore();
		}
	});

	it("holds unrestricted AST apply until its actual file mutation is authorized", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-apply-authority-"));
		directories.push(root);
		const target = path.join(root, "input.ts");
		await fs.writeFile(target, "legacyWrap(a, b)\n");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const queue = new ToolChoiceQueue();
		const session = {
			cwd: root,
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "tools.xdev": false }),
			pathScope: scope,
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		} as unknown as ToolSession;
		const tools = await createTools(session, ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		if (!tool) throw new Error("Missing AST edit tool");
		await runFilesystemOperation(manager, "filesystem:ast-preview-apply", () =>
			scope.withOperationLease("filesystem:ast-preview-apply", () =>
				tool.execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: [target],
				}),
			),
		);
		const invoker = queue.peekPendingInvoker();
		if (!invoker) throw new Error("Missing AST preview action");
		const identity = await fs.lstat(target, { bigint: true });
		const operationId = "filesystem:ast-apply-real";
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: target,
			identity,
		});
		const effectEntered = Promise.withResolvers<void>();
		const releaseEffect = Promise.withResolvers<void>();
		const terminalEntered = Promise.withResolvers<void>();
		const releaseTerminal = Promise.withResolvers<void>();
		let writing = false;
		let mutationResourceId: string | undefined;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind !== "resource" || record.operationId !== operationId || record.targetHash !== targetHash)
				return;
			if (record.phase === "effect" && writing) {
				mutationResourceId = record.resourceId;
				effectEntered.resolve();
				await releaseEffect.promise;
			}
			if (record.phase === "completed" && record.resourceId === mutationResourceId) {
				terminalEntered.resolve();
				await releaseTerminal.promise;
			}
		});
		let settled = false;
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async operation => {
				const write = operation.writeFile.bind(operation);
				operation.writeFile = async (...args) => {
					writing = true;
					return write(...args);
				};
				return invoker({ action: "apply", reason: "apply authorized preview" });
			}),
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await effectEntered.promise;
			expect(settled).toBe(false);
			expect(await fs.readFile(target, "utf8")).toBe("legacyWrap(a, b)\n");
			releaseEffect.resolve();
			await terminalEntered.promise;
			expect(settled).toBe(false);
			expect(await fs.readFile(target, "utf8")).toBe("modernWrap(a, b)\n");
			releaseTerminal.resolve();
			await pending;
		} finally {
			releaseEffect.resolve();
			releaseTerminal.resolve();
			await pending.catch(() => undefined);
		}
	});

	it("does not downgrade a SQLite header close failure to a format fallback", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-sniff-authority-"));
		directories.push(root);
		const target = path.join(root, "rows.sqlite");
		const db = new Database(target);
		db.run("CREATE TABLE entries (value TEXT)");
		db.close();
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const failure = Object.assign(new Error("SQLite sniff close failed"), { code: "ENOENT" });
		let closed = false;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.operationId === "filesystem:sqlite-sniff" &&
				record.resourceClass === "filesystem" &&
				record.phase === "completed"
			) {
				closed = true;
				throw failure;
			}
		});
		const tool = new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			pathScope: scope,
		} as unknown as ToolSession);
		// Await real authority Worker settlement before synchronous matching; Bun 1.4.4 promise matchers starve Worker replies.
		await assert.rejects(
			runFilesystemOperation(manager, "filesystem:sqlite-sniff", () =>
				scope.withOperationLease("filesystem:sqlite-sniff", () =>
					tool.execute("read-sqlite", { path: `${target}:entries` }),
				),
			),
			error => error === failure,
		);
		expect(closed).toBe(true);
		const observer = new Database(target, { readonly: true });
		try {
			expect(observer.query("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 0 });
		} finally {
			observer.close();
		}
	});

	it("hashes the admitted binary inode after its pathname is replaced", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ida-hash-inode-"));
		directories.push(root);
		const target = path.join(root, "program");
		const original = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
		await fs.writeFile(target, original);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		await runFilesystemOperation(manager, "filesystem:ida-hash", () =>
			scope.withOperationLease("filesystem:ida-hash", async operation => {
				const handle = await operation.openRead(await operation.authorize(target, "read"));
				try {
					await fs.rename(target, `${target}.old`);
					await fs.writeFile(target, "replacement");
					const location = await locateIdb(target, { sourceReadPath: `/proc/${process.pid}/fd/${handle.fd}` });
					const hash = new Bun.CryptoHasher("sha256").update(original).digest("hex");
					expect(location.id.startsWith(hash.slice(0, 16))).toBe(true);
				} finally {
					await handle.close();
				}
			}),
		);
		expect(await fs.readFile(target, "utf8")).toBe("replacement");
	});

	it("propagates the real binary dispatch header read close failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-binary-sniff-authority-"));
		directories.push(root);
		const install = path.join(root, "ida");
		await fs.mkdir(install);
		for (const name of ["libidalib.dylib", "libidalib.so", "idalib.dll"])
			await fs.writeFile(path.join(install, name), "");
		const target = path.join(root, "program");
		await fs.writeFile(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const failure = new Error("binary header close failed");
		let closed = false;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.operationId === "filesystem:binary-sniff" &&
				record.phase === "completed"
			) {
				closed = true;
				throw failure;
			}
		});
		const tool = new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "ida.installDir": install }),
			pathScope: scope,
		} as unknown as ToolSession);
		await assert.rejects(
			runFilesystemOperation(manager, "filesystem:binary-sniff", () =>
				scope.withOperationLease("filesystem:binary-sniff", () =>
					tool.execute("read-binary", { path: `${target}:imports` }),
				),
			),
			error => error === failure,
		);
		expect(closed).toBe(true);
		expect(await fs.readFile(target)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
	});

	it("authorizes unrestricted AST preview and revalidates actual bytes before apply", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-authority-"));
		directories.push(root);
		const target = path.join(root, "input.ts");
		await fs.writeFile(target, "legacyWrap(a, b)\n");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const queue = new ToolChoiceQueue();
		const session = {
			cwd: root,
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "tools.xdev": false }),
			pathScope: scope,
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		} as unknown as ToolSession;
		const tools = await createTools(session, ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		if (!tool) throw new Error("Missing AST edit tool");
		const records: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource") records.push(record);
		});
		const preview = await runFilesystemOperation(manager, "filesystem:ast-preview", () =>
			scope.withOperationLease("filesystem:ast-preview", () =>
				tool.execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: [target],
				}),
			),
		);
		expect(preview.details).toMatchObject({ totalReplacements: 1, applied: false });
		expect(await fs.readFile(target, "utf8")).toBe("legacyWrap(a, b)\n");
		expect(
			records.some(
				record =>
					record.kind === "resource" &&
					record.operationId === "filesystem:ast-preview" &&
					record.phase === "completed",
			),
		).toBe(true);
		await fs.writeFile(target, "legacyWrap(c, d)\n");
		const invoker = queue.peekPendingInvoker();
		if (!invoker) throw new Error("Missing AST preview action");
		await assert.rejects(
			runFilesystemOperation(manager, "filesystem:ast-apply", () =>
				scope.withOperationLease(
					"filesystem:ast-apply",
					async () => await invoker({ action: "apply", reason: "reject stale preview" }),
				),
			),
			/AST edit preview is stale/,
		);
		expect(await fs.readFile(target, "utf8")).toBe("legacyWrap(c, d)\n");
	});

	it("awaits real SQLite read admission and close before returning query rows", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-read-authority-"));
		directories.push(root);
		const target = path.join(root, "rows.sqlite");
		const db = new Database(target);
		db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
		db.run("INSERT INTO entries VALUES (1, 'visible-row')");
		db.close();
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let completed = false;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind !== "resource" ||
				record.operationId !== "filesystem:sqlite-read" ||
				record.resourceClass !== "sqlite"
			)
				return;
			if (record.phase === "effect") {
				entered.resolve();
				await release.promise;
			}
			if (record.phase === "completed") completed = true;
		});
		const tool = new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			pathScope: scope,
		} as unknown as ToolSession);
		const pending = runFilesystemOperation(manager, "filesystem:sqlite-read", () =>
			scope.withOperationLease("filesystem:sqlite-read", () =>
				tool.execute("read-sqlite", { path: `${target}:entries` }),
			),
		);
		const settled = Promise.withResolvers<void>();
		void pending.then(
			() => settled.resolve(),
			() => settled.resolve(),
		);
		try {
			expect(await Promise.race([entered.promise.then(() => "effect"), settled.promise.then(() => "settled")])).toBe(
				"effect",
			);
			release.resolve();
			const result = await pending;
			expect(result.content.some(item => item.type === "text" && item.text.includes("visible-row"))).toBe(true);
			expect(completed).toBe(true);
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
		}
	});

	it("preserves JSON input close failure instead of falling back to another read route", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-read-authority-"));
		directories.push(root);
		const target = path.join(root, "input.json");
		await fs.writeFile(target, '{"value":"actual"}');
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const failure = Object.assign(new Error("JSON input close failed"), { code: "ENOENT" });
		let closed = false;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.operationId === "filesystem:json-read" &&
				record.phase === "completed"
			) {
				closed = true;
				throw failure;
			}
		});
		const tool = new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			pathScope: scope,
		} as unknown as ToolSession);
		await assert.rejects(
			runFilesystemOperation(manager, "filesystem:json-read", () =>
				scope.withOperationLease("filesystem:json-read", () =>
					tool.execute("read-json", { path: `${target}?q=.value` }),
				),
			),
			error => error === failure,
		);
		expect(closed).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe('{"value":"actual"}');
	});

	for (const replace of ["main", "wal", "shm"] as const) {
		it(`prevents SQLite physical input opening after ${replace} replacement during effect acknowledgement`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-held-input-"));
			directories.push(root);
			const target = path.join(root, "rows.sqlite");
			const writer = new Database(target);
			writer.run("PRAGMA journal_mode = WAL");
			writer.run("CREATE TABLE entries (value TEXT)");
			writer.run("INSERT INTO entries VALUES ('wal-only-row')");
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			const operationId = `filesystem:sqlite-replace-${replace}`;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const replacedPath = replace === "main" ? target : `${target}-${replace}`;
			const identity = await fs.lstat(replacedPath, { bigint: true });
			const hash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId,
				canonicalTarget: replacedPath,
				identity,
			});
			holdCommittedTransitionAcknowledgements(store, async record => {
				if (
					record.kind === "resource" &&
					record.resourceClass === "sqlite" &&
					record.targetHash === hash &&
					record.phase === "effect"
				) {
					entered.resolve();
					await release.promise;
				}
			});
			const connection = vi.spyOn(sqliteReader, "openSqliteReadConnection");
			const tool = new ReadTool({
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				pathScope: scope,
			} as unknown as ToolSession);
			let settled = false;
			const pending = runFilesystemOperation(manager, operationId, () =>
				scope.withOperationLease(operationId, () => tool.execute("read", { path: `${target}:entries` })),
			);
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await entered.promise;
				expect(settled).toBe(false);
				expect(connection).not.toHaveBeenCalled();
				await fs.rename(replacedPath, `${replacedPath}.old`);
				await fs.writeFile(replacedPath, "not admitted bytes");
				release.resolve();
				await assert.rejects(pending, /changed/);
				expect(connection).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await pending.catch(() => undefined);
				connection.mockRestore();
				writer.close();
			}
		});
	}

	it("reads real readonly WAL rows and holds every SQLite input terminal acknowledgement", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-wal-input-"));
		directories.push(root);
		const target = path.join(root, "rows.sqlite");
		const writer = new Database(target);
		writer.run("PRAGMA journal_mode = WAL");
		writer.run("CREATE TABLE entries (value TEXT)");
		writer.run("INSERT INTO entries VALUES ('wal-only-row')");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const operationId = "filesystem:sqlite-wal-terminals";
		const hashes = await Promise.all(
			[target, `${target}-wal`, `${target}-shm`].map(async canonicalTarget =>
				durableTargetHash({
					actorId: "Worker",
					generation: 1,
					operationId,
					canonicalTarget,
					identity: await fs.lstat(canonicalTarget, { bigint: true }),
				}),
			),
		);
		const terminals = new Set<string>();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind !== "resource" ||
				record.operationId !== operationId ||
				record.resourceClass !== "sqlite" ||
				record.phase !== "completed"
			)
				return;
			terminals.add(record.targetHash);
			entered.resolve();
			await release.promise;
		});
		const tool = new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			pathScope: scope,
		} as unknown as ToolSession);
		let settled = false;
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, () => tool.execute("read", { path: `${target}:entries` })),
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await entered.promise;
			expect(settled).toBe(false);
			release.resolve();
			const result = await pending;
			expect(result.content.some(item => item.type === "text" && item.text.includes("wal-only-row"))).toBe(true);
			expect(terminals).toEqual(new Set(hashes));
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
			writer.close();
		}
	});

	it("propagates query-input close failure after the actual jq query, separately from sniffing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-query-close-"));
		directories.push(root);
		const target = path.join(root, "input.jsonl");
		await fs.writeFile(target, '{"value":1}\n{"value":2}\n');
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const failure = new AuthorityRpcError("query close unknown", "query-close", true);
		const selector = parseJsonSelector("q=.value&offset=1&limit=1");
		if (!selector) throw new Error("Missing JSON selector");
		let queried = false;
		const run = Shell.prototype.run;
		const querySpy = vi.spyOn(Shell.prototype, "run").mockImplementation(async function (this: Shell, ...args) {
			const result = await run.apply(this, args);
			expect(result.exitCode).toBe(0);
			queried = true;
			return result;
		});
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "completed") {
				expect(queried).toBe(true);
				throw failure;
			}
		});
		const operationId = "filesystem:json-query-close";
		try {
			await assert.rejects(
				runFilesystemOperation(manager, operationId, () =>
					scope.withOperationLease(operationId, () =>
						readJson({ cwd: root, pathScope: scope } as ToolSession, { absolutePath: target, selector }),
					),
				),
				error => error === failure,
			);
			expect(getOperationTerminal(manager, operationId)).toMatchObject({
				status: "abandoned",
				detail: "Authority outcome is unknown; durable terminal state was not asserted.",
			});
		} finally {
			querySpy.mockRestore();
		}
	});

	for (const kind of ["json", "ast"] as const) {
		it(`joins held ${kind} source reading and close after cancellation before operation settlement`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-${kind}-cancel-read-`));
			directories.push(root);
			const target = path.join(root, kind === "json" ? "input.json" : "input.ts");
			await fs.writeFile(target, kind === "json" ? '{"value":1}' : "legacyWrap(a, b)\n");
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			const readEntered = Promise.withResolvers<void>();
			const releaseRead = Promise.withResolvers<void>();
			let closed = false;
			const open = nodeFs.promises.open;
			// Bun spies on `node:fs` promises do not reach `node:fs/promises` bindings, so patch the namespace read-json uses.
			const copy = fs.copyFile;
			const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
				if (kind === "json" && String(args[0]).startsWith("/proc/self/fd/")) {
					readEntered.resolve();
					await releaseRead.promise;
				}
				await copy(...args);
			});
			const spy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				if (args[0] === target) {
					const read = handle.readFile.bind(handle);
					handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
						readEntered.resolve();
						await releaseRead.promise;
						return read(...readArgs);
					}) as typeof handle.readFile;
					const close = handle.close.bind(handle);
					handle.close = async () => {
						closed = true;
						await close();
					};
				}
				return handle;
			});
			const controller = new AbortController();
			const operationId = `filesystem:${kind}-held-cancel`;
			const session = {
				cwd: root,
				pathScope: scope,
				settings: Settings.isolated(),
				getSessionFile: () => null,
			} as unknown as ToolSession;
			const selector = parseJsonSelector("q=.value");
			if (!selector) throw new Error("Missing selector");
			let settled = false;
			const pending = runFilesystemOperation(
				manager,
				operationId,
				() =>
					scope.withOperationLease(operationId, async () => {
						if (kind === "json")
							await readJson(session, { absolutePath: target, selector }, undefined, controller.signal);
						else
							await new AstEditTool(session).execute(
								"preview",
								{ ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }], paths: [target] },
								controller.signal,
							);
					}),
				controller.signal,
			);
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await readEntered.promise;
				controller.abort();
				await Promise.resolve();
				expect(settled).toBe(false);
				expect(closed).toBe(false);
				expect(getOperationTerminal(manager, operationId)).toBeUndefined();
				releaseRead.resolve();
				await assert.rejects(pending, error => error !== undefined);
				expect(closed).toBe(true);
			} finally {
				releaseRead.resolve();
				await pending.catch(() => undefined);
				spy.mockRestore();
				copySpy.mockRestore();
			}
		});
	}

	for (const extension of [".i64", ".idb"]) {
		it(`stages admitted ${extension} bytes before a persistent IDA consumer opens them`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ida-database-input-"));
			directories.push(root);
			const target = path.join(root, `${"database".repeat(12)}${extension}`);
			await fs.writeFile(target, "original-idb-bytes");
			await fs.chmod(target, 0o400);
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			await runFilesystemOperation(manager, "filesystem:idb-stage", () =>
				scope.withOperationLease("filesystem:idb-stage", async operation => {
					const handle = await operation.openRead(await operation.authorize(target, "read"));
					try {
						await fs.rename(target, `${target}.old`);
						await fs.writeFile(target, "replacement-idb-bytes");
						const loc = await locateIdb(target, { sourceReadPath: `/proc/${process.pid}/fd/${handle.fd}` });
						expect(loc.kind).toBe("store");
						// Isolate the actual private staging primitive from the process-wide IDA cache.
						loc.dir = path.join(root, "private-cache");
						loc.openPath = path.join(loc.dir, path.basename(target));
						loc.lockTarget = path.join(loc.dir, "db");
						await prepareStoreDir(loc);
						expect(loc.isNew).toBe(false);
						expect(path.extname(loc.openPath)).toBe(extension);
						expect(await fs.readFile(loc.openPath, "utf8")).toBe("original-idb-bytes");
						expect((await fs.stat(loc.openPath)).mode & 0o777).toBe(0o600);
						expect(await fs.readFile(target, "utf8")).toBe("replacement-idb-bytes");
					} finally {
						await handle.close();
					}
				}),
			);
		});
	}
	it("uses admitted AST snapshots for both hashline phases without reopening the source", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-hashline-source-"));
		directories.push(root);
		const target = path.join(root, "input.ts");
		await fs.writeFile(target, "legacyWrap(a, b)\n");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const queue = new ToolChoiceQueue();
		const session = {
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated({ "edit.mode": "hashline" }),
			getSessionFile: () => null,
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		} as unknown as ToolSession;
		const original = Bun.file;
		let bypassReads = 0;
		const spy = vi.spyOn(Bun, "file").mockImplementation((requestedPath, options) => {
			if (typeof requestedPath === "string" || requestedPath instanceof URL) {
				if (requestedPath === target) {
					bypassReads++;
					throw new Error("Unadmitted source reopen");
				}
				return original(requestedPath, options);
			}
			if (typeof requestedPath === "number") return original(requestedPath, options);
			return original(requestedPath, options);
		});
		try {
			const preview = await runFilesystemOperation(manager, "filesystem:ast-hash-preview", () =>
				scope.withOperationLease("filesystem:ast-hash-preview", () =>
					new AstEditTool(session).execute("preview", {
						ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
						paths: [target],
					}),
				),
			);
			expect(preview.content.some(item => item.type === "text" && /#[0-9A-Fa-f]+/.test(item.text))).toBe(true);
			const invoker = queue.peekPendingInvoker();
			if (!invoker) throw new Error("Missing preview");
			const applied = await runFilesystemOperation(manager, "filesystem:ast-hash-apply", () =>
				scope.withOperationLease("filesystem:ast-hash-apply", async () =>
					invoker({ action: "apply", reason: "apply snapshots" }),
				),
			);
			if (
				typeof applied !== "object" ||
				applied === null ||
				!("content" in applied) ||
				!Array.isArray(applied.content)
			) {
				throw new Error("AST resolve returned no tool content.");
			}
			expect(
				applied.content.some((item: unknown) => {
					if (
						typeof item !== "object" ||
						item === null ||
						!("type" in item) ||
						item.type !== "text" ||
						!("text" in item)
					)
						return false;
					return typeof item.text === "string" && /#[0-9A-Fa-f]+/.test(item.text);
				}),
			).toBe(true);
			expect(bypassReads).toBe(0);
			expect(await fs.readFile(target, "utf8")).toBe("modernWrap(a, b)\n");
		} finally {
			spy.mockRestore();
		}
	});

	it("publishes permitted local URL AST rewrites through the current local head", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-local-publication-"));
		directories.push(root);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const state = new DurableLocalState(store, "root");
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => root,
			getSessionId: () => "root",
			getPathScope: () => scope,
			getDurableLocalState: () => state,
		};
		await executeWrite(
			manager,
			scope,
			createWriteTool(root, scope, localProtocolOptions),
			"local:ast-original",
			"local",
			"local://input.ts",
			"legacyWrap(a, b)\n",
		);
		const before = await state.current();
		const queue = new ToolChoiceQueue();
		const session = {
			cwd: root,
			pathScope: scope,
			localProtocolOptions,
			settings: Settings.isolated({ "edit.mode": "hashline" }),
			getSessionFile: () => null,
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		} as unknown as ToolSession;
		await runLocalOperation(manager, "local:ast-url-preview", () =>
			scope.withOperationLease("local:ast-url-preview", () =>
				new AstEditTool(session).execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: ["local://input.ts"],
				}),
			),
		);
		expect((await state.current())?.headHash).toBe(before?.headHash);
		expect(await fs.readFile(path.join(root, "local/input.ts"), "utf8")).toBe("legacyWrap(a, b)\n");
		const invoker = queue.peekPendingInvoker();
		if (!invoker) throw new Error("Missing local preview");
		const localInvocations: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "operation" && record.effectClass === "local") localInvocations.push(record);
		});
		// xd://resolve arrives as a write/filesystem invocation, not the old preview's local lease.
		await runFilesystemOperation(manager, "filesystem:ast-url-resolve", () =>
			scope.withOperationLease("filesystem:ast-url-resolve", async () =>
				invoker({ action: "apply", reason: "publish local AST" }),
			),
		);
		expect(localInvocations.some(record => record.kind === "operation" && record.phase === "completed")).toBe(true);
		expect(await fs.readFile(path.join(root, "local/input.ts"), "utf8")).toBe("modernWrap(a, b)\n");
		expect((await state.current())?.headHash).not.toBe(before?.headHash);
		expect(await store.localBacking("root")).toMatchObject({
			entryId: canonicalDurableSha256({ localId: "root", url: "local://input.ts" }),
			entryHash: durableBackingSha256("modernWrap(a, b)\n"),
		});
	});

	it("relays current resolve cancellation into the local AST child before any physical write", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-local-resolve-cancel-"));
		directories.push(root);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const state = new DurableLocalState(store, "root");
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => root,
			getSessionId: () => "root",
			getPathScope: () => scope,
			getDurableLocalState: () => state,
		};
		await executeWrite(
			manager,
			scope,
			createWriteTool(root, scope, localProtocolOptions),
			"local:ast-cancel-original",
			"local",
			"local://input.ts",
			"legacyWrap(a, b)\n",
		);
		const before = await state.current();
		const queue = new ToolChoiceQueue();
		const session = {
			cwd: root,
			pathScope: scope,
			localProtocolOptions,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getToolChoiceQueue: () => queue,
		} as unknown as ToolSession;
		await runLocalOperation(manager, "local:ast-cancel-preview", () =>
			scope.withOperationLease("local:ast-cancel-preview", () =>
				new AstEditTool(session).execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: ["local://input.ts"],
				}),
			),
		);
		const invoker = queue.peekPendingInvoker();
		if (!invoker) throw new Error("Missing preview");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		let publishing = false;
		const authorize = store.authorizeLocalEffect.bind(store);
		store.authorizeLocalEffect = async claim => {
			const receipt = await authorize(claim);
			publishing = true;
			return receipt;
		};
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				publishing &&
				record.kind === "resource" &&
				record.resourceClass === "local" &&
				record.phase === "effect" &&
				record.operationId.includes("filesystem:ast-cancel-resolve")
			) {
				entered.resolve();
				await release.promise;
			}
		});
		let settled = false;
		const pending = runFilesystemOperation(
			manager,
			"filesystem:ast-cancel-resolve",
			() =>
				scope.withOperationLease("filesystem:ast-cancel-resolve", async () =>
					invoker({ action: "apply", reason: "cancel current invocation" }),
				),
			controller.signal,
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await entered.promise;
			controller.abort();
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(await fs.readFile(path.join(root, "local/input.ts"), "utf8")).toBe("legacyWrap(a, b)\n");
			release.resolve();
			await assert.rejects(pending, error => error !== undefined);
			expect((await state.current())?.headHash).toBe(before?.headHash);
			expect(await fs.readFile(path.join(root, "local/input.ts"), "utf8")).toBe("legacyWrap(a, b)\n");
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
		}
	});

	it("retains compound unknown read and close evidence through deferred AST resolve", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-compound-reread-"));
		directories.push(root);
		const target = path.join(root, "input.ts");
		await fs.writeFile(target, "legacyWrap(a, b)\n");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const queue = new ToolChoiceQueue();
		const session = {
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getToolChoiceQueue: () => queue,
			buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			steer: () => {},
		} as unknown as ToolSession;
		await runFilesystemOperation(manager, "filesystem:ast-compound-preview", () =>
			scope.withOperationLease("filesystem:ast-compound-preview", () =>
				new AstEditTool(session).execute("preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: [target],
				}),
			),
		);
		const invoker = queue.peekPendingInvoker();
		if (!invoker) throw new Error("Missing preview");
		const primary = new AuthorityRpcError("read outcome unknown", "ast-reread", true);
		const closeFailure = new Error("physical read close failed");
		const open = nodeFs.promises.open;
		const spy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === target) {
				let consumed = false;
				handle.readFile = async () => {
					consumed = true;
					throw primary;
				};
				const close = handle.close.bind(handle);
				handle.close = async () => {
					await close();
					if (consumed) throw closeFailure;
				};
			}
			return handle;
		});
		const operationId = "filesystem:ast-compound-apply";
		try {
			const failure = await runFilesystemOperation(manager, operationId, () =>
				scope.withOperationLease(operationId, async () =>
					invoker({ action: "apply", reason: "retain unknown constituents" }),
				),
			).catch(error => error);
			if (!(failure instanceof Error)) throw failure;
			const cause = failure.cause;
			if (!(cause instanceof AggregateError)) throw failure;
			expect(failure.cause).toBeInstanceOf(AggregateError);
			expect(cause.errors).toEqual([primary, closeFailure]);
			expect(primary.requestId).toBe("ast-reread");
			expect(getOperationTerminal(manager, operationId)).toMatchObject({
				status: "abandoned",
				detail: "Authority outcome is unknown; durable terminal state was not asserted.",
			});
			const terminal = getOperationTerminal(manager, operationId);
			if (!terminal) throw new Error("Missing operation disposition");
			expect((await store.getOperation(terminal.ownerId, "filesystem", operationId))?.record.phase).toBe("effect");
			expect(await fs.readFile(target, "utf8")).toBe("legacyWrap(a, b)\n");
		} finally {
			spy.mockRestore();
		}
	});

	it("rejects successful scoped JSON output when awaited private snapshot removal fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-snapshot-removal-"));
		directories.push(root);
		const target = path.join(root, "input.json");
		await fs.writeFile(target, '{"value":"private-source"}');
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const operationId = "filesystem:json-snapshot-removal";
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: target,
			identity: await fs.lstat(target, { bigint: true }),
		});
		const selector = parseJsonSelector("q=.value&raw=true");
		if (!selector) throw new Error("Missing JSON selector");
		const removalFailure = Object.assign(new Error("private snapshot removal failed"), { code: "EIO" });
		const cleanupEntered = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		let snapshotDirectory = "";
		let queried = false;
		let physicallyClosed = false;
		let completedResourceId = "";
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.operationId === operationId && record.phase === "completed") {
				expect(physicallyClosed).toBe(true);
				completedResourceId = record.resourceId;
			}
		});
		const copy = fs.copyFile;
		const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
			if (String(args[0]).startsWith("/proc/self/fd/") && path.basename(String(args[1])) === "input.json") {
				snapshotDirectory = path.dirname(String(args[1]));
				directories.push(snapshotDirectory);
			}
			await copy(...args);
		});
		const open = nodeFs.promises.open;
		const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === target) {
				const close = handle.close.bind(handle);
				handle.close = async () => {
					await close();
					physicallyClosed = true;
				};
			}
			return handle;
		});
		const run = Shell.prototype.run;
		const querySpy = vi.spyOn(Shell.prototype, "run").mockImplementation(async function (this: Shell, ...args) {
			const result = await run.apply(this, args);
			expect(result.exitCode).toBe(0);
			queried = true;
			return result;
		});
		const rm = fs.rm;
		const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
			if (String(args[0]) === snapshotDirectory) {
				expect(await fs.readFile(path.join(snapshotDirectory, "input.json"), "utf8")).toBe(
					'{"value":"private-source"}',
				);
				cleanupEntered.resolve();
				await releaseCleanup.promise;
				throw removalFailure;
			}
			await rm(...args);
		});
		let settled = false;
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, () =>
				readJson({ cwd: root, pathScope: scope } as ToolSession, { absolutePath: target, selector }),
			),
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await cleanupEntered.promise;
			expect(queried).toBe(true);
			expect(settled).toBe(false);
			expect(physicallyClosed).toBe(false);
			expect(completedResourceId).toBe("");
			expect(getOperationTerminal(manager, operationId)).toBeUndefined();
			releaseCleanup.resolve();
			await assert.rejects(pending, error => error === removalFailure);
			expect(physicallyClosed).toBe(true);
			if (!completedResourceId) throw new Error("Original JSON input did not reach terminal close");
			expect((await store.getResource("Worker", 1, completedResourceId))?.record).toMatchObject({
				targetHash,
				phase: "completed",
			});
			const terminal = getOperationTerminal(manager, operationId);
			expect(terminal?.status).toBe("failed");
			if (!terminal) throw new Error("Missing operation disposition");
			expect((await store.getOperation(terminal.ownerId, "filesystem", operationId))?.record.phase).toBe("failed");
			expect(await fs.readFile(target, "utf8")).toBe('{"value":"private-source"}');
		} finally {
			releaseCleanup.resolve();
			await pending.catch(() => undefined);
			removeSpy.mockRestore();
			querySpy.mockRestore();
			openSpy.mockRestore();
			copySpy.mockRestore();
		}
	});

	for (const failureKind of ["query", "abort"] as const) {
		it(`retains scoped JSON ${failureKind}, stderr and snapshot removal failures plus original-input close uncertainty`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-query-cleanup-compound-"));
			directories.push(root);
			const target = path.join(root, "input.json");
			await fs.writeFile(target, '{"value":"private-source"}');
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			const operationId = `filesystem:json-cleanup-${failureKind}`;
			const targetHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId,
				canonicalTarget: target,
				identity: await fs.lstat(target, { bigint: true }),
			});
			const selector = parseJsonSelector(failureKind === "query" ? "q=error(%22query-primary%22)" : "q=.value");
			if (!selector) throw new Error("Missing JSON selector");
			const stderrFailure = Object.assign(new Error("stderr removal failed"), { code: "EIO" });
			const snapshotFailure = Object.assign(new Error("snapshot removal failed"), { code: "EIO" });
			const unknown = new AuthorityRpcError("original input close unknown", `json-cleanup-${failureKind}`, true);
			const abortReason = new Error("current JSON query cancelled");
			const controller = new AbortController();
			const cleanup: string[] = [];
			let snapshotDirectory = "";
			let queried = false;
			let completedResourceId = "";
			holdCommittedTransitionAcknowledgements(store, async record => {
				if (record.kind === "resource" && record.operationId === operationId && record.phase === "completed") {
					cleanup.push("terminal");
					completedResourceId = record.resourceId;
					throw unknown;
				}
			});
			const copy = fs.copyFile;
			const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
				if (String(args[0]).startsWith("/proc/self/fd/") && path.basename(String(args[1])) === "input.json") {
					snapshotDirectory = path.dirname(String(args[1]));
					directories.push(snapshotDirectory);
				}
				await copy(...args);
			});
			const open = nodeFs.promises.open;
			const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				if (args[0] === target) {
					const close = handle.close.bind(handle);
					handle.close = async () => {
						await close();
						cleanup.push("source");
					};
				}
				return handle;
			});
			const run = Shell.prototype.run;
			const querySpy = vi.spyOn(Shell.prototype, "run").mockImplementation(async function (this: Shell, ...args) {
				expect(await fs.readFile(path.join(snapshotDirectory, "input.json"), "utf8")).toBe(
					'{"value":"private-source"}',
				);
				const result = await run.apply(this, args);
				expect(result.exitCode === 0).toBe(failureKind === "abort");
				queried = true;
				if (failureKind === "abort") controller.abort(abortReason);
				return result;
			});
			const rm = fs.rm;
			const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
				const candidate = String(args[0]);
				if (candidate === snapshotDirectory) {
					cleanup.push("snapshot");
					throw snapshotFailure;
				}
				if (path.basename(candidate).startsWith("omp-jq-") && candidate.endsWith(".err")) {
					directories.push(candidate);
					cleanup.push("stderr");
					throw stderrFailure;
				}
				await rm(...args);
			});
			try {
				const failure = await runFilesystemOperation(
					manager,
					operationId,
					() =>
						scope.withOperationLease(operationId, () =>
							readJson(
								{ cwd: root, pathScope: scope } as ToolSession,
								{ absolutePath: target, selector },
								undefined,
								controller.signal,
							),
						),
					controller.signal,
				).catch(error => error);
				expect(queried).toBe(true);
				expect(failure).toBeInstanceOf(AggregateError);
				const constituents = errorConstituents(failure);
				expect(constituents).toEqual(expect.arrayContaining([stderrFailure, snapshotFailure, unknown]));
				if (failureKind === "query") {
					const primary = constituents.find(error => error instanceof ToolError);
					expect(primary).toBeInstanceOf(ToolError);
					expect(primary).toMatchObject({ message: expect.stringContaining("query-primary") });
				} else {
					expect(constituents.some(error => error instanceof ToolAbortError)).toBe(true);
					expect(constituents).toContain(abortReason);
				}
				expect(cleanup).toEqual(["stderr", "snapshot", "source", "terminal"]);
				expect(unknown.requestId).toBe(`json-cleanup-${failureKind}`);
				if (!completedResourceId) throw new Error("Original JSON input terminal boundary was not reached");
				expect((await store.getResource("Worker", 1, completedResourceId))?.record).toMatchObject({
					targetHash,
					phase: "completed",
				});
				const terminal = getOperationTerminal(manager, operationId);
				expect(terminal).toMatchObject({
					status: "abandoned",
					detail: "Authority outcome is unknown; durable terminal state was not asserted.",
				});
				if (!terminal) throw new Error("Missing operation disposition");
				expect((await store.getOperation(terminal.ownerId, "filesystem", operationId))?.record.phase).toBe(
					"effect",
				);
				expect(await fs.readFile(target, "utf8")).toBe('{"value":"private-source"}');
			} finally {
				removeSpy.mockRestore();
				querySpy.mockRestore();
				openSpy.mockRestore();
				copySpy.mockRestore();
			}
		});
	}

	for (const failureSite of ["directory-read", "stat", "child-terminal"] as const) {
		it(`retains AST traversal ${failureSite} and all later close failures until ancestor cleanup settles`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-traversal-compound-"));
			directories.push(root);
			const scan = path.join(root, "scan");
			await fs.mkdir(scan);
			const target = path.join(scan, "input.ts");
			await fs.writeFile(target, "legacyWrap(a, b)\n");
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			const operationId = `filesystem:ast-traversal-${failureSite}`;
			const unknownTarget = failureSite === "directory-read" ? scan : target;
			const unknownHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId,
				canonicalTarget: unknownTarget,
				identity: await fs.lstat(unknownTarget, { bigint: true }),
			});
			const original = new Error(`${failureSite} failed inside traversal`);
			const unknown = new AuthorityRpcError("traversal terminal outcome unknown", `traversal-${failureSite}`, true);
			const iteratorFailure = new Error("ancestor iterator close failed");
			const ancestorFailure = new Error("ancestor physical handle close failed");
			const closeEntered = Promise.withResolvers<void>();
			const releaseClose = Promise.withResolvers<void>();
			const opened = new Map<number, string>();
			const closed: string[] = [];
			let targetOpens = 0;
			let traversalClosed = false;
			let sourceRead = false;
			let unknownResourceId = "";
			holdCommittedTransitionAcknowledgements(store, async record => {
				if (
					record.kind === "resource" &&
					record.operationId === operationId &&
					record.targetHash === unknownHash &&
					record.phase === "completed" &&
					(failureSite === "directory-read" || traversalClosed)
				) {
					unknownResourceId = record.resourceId;
					throw unknown;
				}
			});
			const open = nodeFs.promises.open;
			const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				const source = String(args[0]);
				opened.set(handle.fd, source);
				if (source === scan) {
					const close = handle.close.bind(handle);
					handle.close = async () => {
						await close();
						closed.push("ancestor");
						closeEntered.resolve();
						await releaseClose.promise;
						if (failureSite !== "directory-read") throw ancestorFailure;
					};
				}
				if (source === target) {
					const traversal = ++targetOpens === 1;
					const stat = handle.stat.bind(handle);
					let stats = 0;
					handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
						if (traversal && failureSite === "stat" && ++stats === 2) throw original;
						return stat(...statArgs);
					}) as typeof handle.stat;
					const read = handle.readFile.bind(handle);
					handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
						sourceRead = true;
						return read(...readArgs);
					}) as typeof handle.readFile;
					const close = handle.close.bind(handle);
					handle.close = async () => {
						await close();
						closed.push(traversal ? "child-traversal" : "source");
						if (traversal) traversalClosed = true;
					};
				}
				return handle;
			});
			const opendir = nodeFs.promises.opendir;
			const directorySpy = vi.spyOn(nodeFs.promises, "opendir").mockImplementation(async (...args) => {
				const directory = await opendir(...args);
				if (opened.get(Number(path.basename(String(args[0])))) === scan) {
					if (failureSite === "directory-read")
						directory.read = async () => {
							throw original;
						};
					const close = directory.close.bind(directory);
					directory.close = async () => {
						await close();
						closed.push("iterator");
						throw iteratorFailure;
					};
				}
				return directory;
			});
			const queue = new ToolChoiceQueue();
			const session = {
				cwd: root,
				pathScope: scope,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getToolChoiceQueue: () => queue,
			} as unknown as ToolSession;
			let settled = false;
			const pending = runFilesystemOperation(manager, operationId, () =>
				scope.withOperationLease(operationId, () =>
					new AstEditTool(session).execute("preview", {
						ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
						paths: [scan],
					}),
				),
			);
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await closeEntered.promise;
				expect(settled).toBe(false);
				expect(getOperationTerminal(manager, operationId)).toBeUndefined();
				expect(closed).toContain("iterator");
				if (failureSite !== "directory-read") expect(closed).toContain("child-traversal");
				releaseClose.resolve();
				const failure = await pending.catch(error => error);
				expect(failure).toBeInstanceOf(AggregateError);
				const constituents = errorConstituents(failure);
				expect(constituents).toEqual(expect.arrayContaining([unknown, iteratorFailure]));
				if (failureSite !== "child-terminal") expect(constituents).toContain(original);
				if (failureSite !== "directory-read") expect(constituents).toContain(ancestorFailure);
				expect(sourceRead).toBe(failureSite === "child-terminal");
				expect(unknown.requestId).toBe(`traversal-${failureSite}`);
				if (!unknownResourceId) throw new Error("Traversal terminal boundary was not reached");
				expect((await store.getResource("Worker", 1, unknownResourceId))?.record).toMatchObject({
					targetHash: unknownHash,
					phase: "completed",
				});
				const terminal = getOperationTerminal(manager, operationId);
				expect(terminal).toMatchObject({
					status: "abandoned",
					detail: "Authority outcome is unknown; durable terminal state was not asserted.",
				});
				if (!terminal) throw new Error("Missing operation disposition");
				expect((await store.getOperation(terminal.ownerId, "filesystem", operationId))?.record.phase).toBe(
					"effect",
				);
				expect(await fs.readFile(target, "utf8")).toBe("legacyWrap(a, b)\n");
				expect(queue.peekPendingInvoker()).toBeUndefined();
			} finally {
				releaseClose.resolve();
				await pending.catch(() => undefined);
				directorySpy.mockRestore();
				openSpy.mockRestore();
			}
		});
	}

	for (const failureSite of ["rule-iteration", "ignore-stat", "ignore-read"] as const) {
		it(`preserves gitignore ${failureSite}, terminal uncertainty and every enclosing cleanup failure`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gitignore-traversal-compound-"));
			directories.push(root);
			const scan = path.join(root, "scan");
			await fs.mkdir(scan);
			const ignore = path.join(scan, ".gitignore");
			await fs.writeFile(ignore, "ignored.ts\n");
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			const operationId = `filesystem:gitignore-${failureSite}`;
			const unknownTarget = failureSite === "rule-iteration" ? scan : ignore;
			const unknownHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId,
				canonicalTarget: unknownTarget,
				identity: await fs.lstat(unknownTarget, { bigint: true }),
			});
			const original = new Error(`${failureSite} failed`);
			const unknown = new AuthorityRpcError("gitignore terminal outcome unknown", `gitignore-${failureSite}`, true);
			const iteratorFailure = new Error("gitignore rule iterator close failed");
			const ancestorFailure = new Error("gitignore ancestor close failed");
			const closed: string[] = [];
			let unknownResourceId = "";
			holdCommittedTransitionAcknowledgements(store, async record => {
				if (
					record.kind === "resource" &&
					record.operationId === operationId &&
					record.targetHash === unknownHash &&
					record.phase === "completed"
				) {
					unknownResourceId = record.resourceId;
					throw unknown;
				}
			});
			const open = nodeFs.promises.open;
			const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				if (args[0] === ignore) {
					const stat = handle.stat.bind(handle);
					let stats = 0;
					handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
						if (failureSite === "ignore-stat" && ++stats === 2) throw original;
						return stat(...statArgs);
					}) as typeof handle.stat;
					if (failureSite === "ignore-read")
						handle.readFile = async () => {
							throw original;
						};
					const close = handle.close.bind(handle);
					handle.close = async () => {
						await close();
						closed.push("ignore");
					};
				}
				if (args[0] === scan) {
					const close = handle.close.bind(handle);
					handle.close = async () => {
						await close();
						closed.push("ancestor");
						if (failureSite !== "rule-iteration") throw ancestorFailure;
					};
				}
				return handle;
			});
			const opendir = nodeFs.promises.opendir;
			const directorySpy = vi.spyOn(nodeFs.promises, "opendir").mockImplementation(async (...args) => {
				const directory = await opendir(...args);
				if (String(args[0]).startsWith("/proc/self/fd/")) {
					if (failureSite === "rule-iteration")
						directory.read = async () => {
							throw original;
						};
					const close = directory.close.bind(directory);
					directory.close = async () => {
						await close();
						closed.push("rule-iterator");
						throw iteratorFailure;
					};
				}
				return directory;
			});
			try {
				const failure = await runFilesystemOperation(manager, operationId, () =>
					scope.withOperationLease(operationId, async operation => {
						await operation.walkAuthorized(await operation.authorize(scan, "search"), {
							gitignore: true,
							readFiles: true,
						});
					}),
				).catch(error => error);
				expect(failure).toBeInstanceOf(AggregateError);
				expect(errorConstituents(failure)).toEqual(
					expect.arrayContaining([
						original,
						unknown,
						iteratorFailure,
						...(failureSite === "rule-iteration" ? [] : [ancestorFailure]),
					]),
				);
				expect(closed).toEqual(
					failureSite === "rule-iteration"
						? ["rule-iterator", "ancestor"]
						: ["ignore", "rule-iterator", "ancestor"],
				);
				if (!unknownResourceId) throw new Error("Gitignore terminal boundary was not reached");
				expect((await store.getResource("Worker", 1, unknownResourceId))?.record).toMatchObject({
					targetHash: unknownHash,
					phase: "completed",
				});
				expect(unknown.requestId).toBe(`gitignore-${failureSite}`);
				const terminal = getOperationTerminal(manager, operationId);
				expect(terminal).toMatchObject({
					status: "abandoned",
					detail: "Authority outcome is unknown; durable terminal state was not asserted.",
				});
				if (!terminal) throw new Error("Missing operation disposition");
				expect((await store.getOperation(terminal.ownerId, "filesystem", operationId))?.record.phase).toBe(
					"effect",
				);
				expect(await fs.readFile(ignore, "utf8")).toBe("ignored.ts\n");
			} finally {
				directorySpy.mockRestore();
				openSpy.mockRestore();
			}
		});
	}

	for (const unknownOutcome of [true, false]) {
		it(`settles deferred AST errors with cyclic cause and aggregate graphs as ${unknownOutcome ? "unknown" : "known"}`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-cyclic-resolve-"));
			directories.push(root);
			const target = path.join(root, "input.ts");
			await fs.writeFile(target, "legacyWrap(a, b)\n");
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			const queue = new ToolChoiceQueue();
			const session = {
				cwd: root,
				pathScope: scope,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getToolChoiceQueue: () => queue,
			} as unknown as ToolSession;
			await runFilesystemOperation(manager, "filesystem:cyclic-preview", () =>
				scope.withOperationLease("filesystem:cyclic-preview", () =>
					new AstEditTool(session).execute("preview", {
						ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
						paths: [target],
					}),
				),
			);
			const invoker = queue.peekPendingInvoker();
			if (!invoker) throw new Error("Missing preview");
			const original = new AuthorityRpcError("deferred source failure", "cyclic-reread", unknownOutcome);
			const graph = new AggregateError([], "cyclic deferred read");
			const wrapper = new Error("source wrapper", { cause: original });
			graph.errors.push(graph, wrapper);
			graph.cause = wrapper;
			original.cause = graph;
			const open = nodeFs.promises.open;
			const spy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				if (args[0] === target)
					handle.readFile = async () => {
						throw graph;
					};
				return handle;
			});
			const operationId = "filesystem:cyclic-apply";
			try {
				const failure = await runFilesystemOperation(manager, operationId, () =>
					scope.withOperationLease(operationId, async () =>
						invoker({ action: "apply", reason: "retain cyclic evidence" }),
					),
				).catch(error => error);
				if (!(failure instanceof Error)) throw failure;
				expect(failure).toBeInstanceOf(ToolError);
				expect(failure.cause).toBe(graph);
				expect(errorConstituents(failure)).toContain(original);
				expect(original.requestId).toBe("cyclic-reread");
				const terminal = getOperationTerminal(manager, operationId);
				expect(terminal?.status).toBe(unknownOutcome ? "abandoned" : "failed");
				if (!terminal) throw new Error("Missing operation disposition");
				if (unknownOutcome)
					expect(terminal.detail).toBe("Authority outcome is unknown; durable terminal state was not asserted.");
				expect((await store.getOperation(terminal.ownerId, "filesystem", operationId))?.record.phase).toBe(
					unknownOutcome ? "effect" : "failed",
				);
				expect(await fs.readFile(target, "utf8")).toBe("legacyWrap(a, b)\n");
			} finally {
				spy.mockRestore();
			}
		});
	}

	it("admits actual in-place IDA read inputs and holds them through view and terminal work", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-idb-view-ownership-"));
		directories.push(root);
		const target = path.join(root, "database.i64");
		await fs.writeFile(target, "admitted-idb");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const effectEntered = Promise.withResolvers<void>();
		const releaseEffect = Promise.withResolvers<void>();
		const viewEntered = Promise.withResolvers<void>();
		const releaseView = Promise.withResolvers<void>();
		const terminalEntered = Promise.withResolvers<void>();
		const releaseTerminal = Promise.withResolvers<void>();
		const controller = new AbortController();
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind !== "resource") return;
			if (record.phase === "effect") {
				effectEntered.resolve();
				await releaseEffect.promise;
			}
			if (record.phase === "completed") {
				terminalEntered.resolve();
				await releaseTerminal.promise;
			}
		});
		let admittedSource: string | undefined;
		const acquire = vi.spyOn(ida, "acquireIdaDatabase").mockImplementation(async (_session, _source, options) => {
			admittedSource = options?.sourceReadPath;
			if (!admittedSource) throw new Error("IDA input bypassed resource admission");
			expect(await fs.readFile(admittedSource, "utf8")).toBe("admitted-idb");
			return {
				id: "private-idb",
				request: async () => {
					viewEntered.resolve();
					await releaseView.promise;
					return { text: "real-view-boundary" };
				},
			} as unknown as IdaDatabase;
		});
		const operationId = "filesystem:ida-view-held";
		let settled = false;
		const pending = runFilesystemOperation(
			manager,
			operationId,
			() =>
				scope.withOperationLease(operationId, () =>
					readBinary(
						{ cwd: root, pathScope: scope } as ToolSession,
						{ absolutePath: target, view: "imports" },
						{ kind: "none" },
						controller.signal,
					),
				),
			controller.signal,
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await effectEntered.promise;
			expect(acquire).not.toHaveBeenCalled();
			expect(settled).toBe(false);
			releaseEffect.resolve();
			await viewEntered.promise;
			controller.abort();
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(await fs.readFile(admittedSource!, "utf8")).toBe("admitted-idb");
			releaseView.resolve();
			await terminalEntered.promise;
			expect(settled).toBe(false);
			releaseTerminal.resolve();
			await assert.rejects(pending, error => error !== undefined);
			expect(acquire).toHaveBeenCalledTimes(1);
		} finally {
			releaseEffect.resolve();
			releaseView.resolve();
			releaseTerminal.resolve();
			await pending.catch(() => undefined);
			acquire.mockRestore();
		}
	});

	it("preserves SQLite configuration failure together with physical close uncertainty", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-config-compound-"));
		directories.push(root);
		const target = path.join(root, "rows.sqlite");
		new Database(target).close();
		const primary = new Error("configuration query failed");
		const cleanup = new AuthorityRpcError("close outcome unknown", "sqlite-close", true);
		const close = Database.prototype.close;
		const runSpy = vi.spyOn(Database.prototype, "run").mockImplementation(() => {
			throw primary;
		});
		const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database) {
			close.call(this);
			throw cleanup;
		});
		try {
			const error = await sqliteReader.openSqliteReadConnection(target).catch(error => error);
			expect(error).toBeInstanceOf(AggregateError);
			expect(error.errors).toEqual([primary, cleanup]);
			expect(cleanup.requestId).toBe("sqlite-close");
		} finally {
			runSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});

	it("drains all SQLite inputs and preserves unknown plus physical input close failures", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-input-compound-"));
		directories.push(root);
		const target = path.join(root, "rows.sqlite");
		const writer = new Database(target);
		writer.run("PRAGMA journal_mode = WAL");
		writer.run("CREATE TABLE entries (value TEXT)");
		writer.run("INSERT INTO entries VALUES ('wal-only-row')");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const primary = new AuthorityRpcError("WAL read outcome unknown", "sqlite-wal-read", true);
		const cleanup = new Error("WAL physical close failed");
		const closed: string[] = [];
		const open = nodeFs.promises.open;
		const spy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			const source = String(args[0]);
			if ([target, `${target}-wal`, `${target}-shm`].includes(source)) {
				if (source.endsWith("-wal"))
					handle.readFile = async () => {
						throw primary;
					};
				const close = handle.close.bind(handle);
				handle.close = async () => {
					await close();
					closed.push(source);
					if (source.endsWith("-wal")) throw cleanup;
				};
			}
			return handle;
		});
		const operationId = "filesystem:sqlite-compound-input";
		const tool = new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			pathScope: scope,
		} as unknown as ToolSession);
		try {
			const failure = await runFilesystemOperation(manager, operationId, () =>
				scope.withOperationLease(operationId, () => tool.execute("read", { path: `${target}:entries` })),
			).catch(error => error);
			expect(failure).toBeInstanceOf(AggregateError);
			expect(failure.errors).toEqual([primary, cleanup]);
			expect(closed).toContain(`${target}-shm`);
			expect(getOperationTerminal(manager, operationId)).toMatchObject({
				status: "abandoned",
				detail: "Authority outcome is unknown; durable terminal state was not asserted.",
			});
		} finally {
			spy.mockRestore();
			writer.close();
		}
	});

	it("captures current IDB bytes even when reusing an already-open private daemon", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-idb-cache-source-"));
		directories.push(root);
		const target = path.join(root, "database.idb");
		await fs.writeFile(target, "cache-idb-bytes");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const broker = { projectDir: root, request: async () => ({ op: "ping" }) } as unknown as DaemonBrokerClient;
		const brokerSpy = vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue(broker);
		const snapshots: string[] = [];
		const copy = fs.copyFile;
		const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
			await copy(...args);
			snapshots.push(String(args[1]));
		});
		let views = 0;
		const db = {
			connected: true,
			status: { state: "open" },
			refresh: async () => ({ state: "open" }),
			request: async () => {
				views++;
				return { text: "cached private view" };
			},
			flush: async () => {},
			disconnect: () => {},
		} as unknown as IdaDatabase;
		const attachSpy = vi.spyOn(IdaDatabase, "attach").mockImplementation(async name => {
			const hash = new Bun.CryptoHasher("sha256").update("cache-idb-bytes").digest("hex");
			expect(name).toContain(hash.slice(0, 16));
			return db;
		});
		try {
			for (const invocation of ["attach", "cache"]) {
				const operationId = `filesystem:idb-${invocation}`;
				const result = await runFilesystemOperation(manager, operationId, () =>
					scope.withOperationLease(operationId, () =>
						readBinary(
							{
								cwd: root,
								pathScope: scope,
								settings: Settings.isolated(),
								getSessionFile: () => null,
							} as unknown as ToolSession,
							{ absolutePath: target, view: "imports" },
							{ kind: "none" },
						),
					),
				);
				expect(result.content.some(item => item.type === "text" && item.text.includes("cached private view"))).toBe(
					true,
				);
			}
			expect(views).toBe(2);
			expect(attachSpy).toHaveBeenCalledTimes(1);
			expect(snapshots).toHaveLength(2);
			for (const snapshot of snapshots) await expect(fs.stat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await ida.releaseIdaDatabases();
			attachSpy.mockRestore();
			brokerSpy.mockRestore();
			copySpy.mockRestore();
		}
	});

	it("stages only the admitted fat slice and retains finished executable cache reuse", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fat-slice-admission-"));
		directories.push(root);
		const target = path.join(root, "universal");
		const bytes = Buffer.alloc(80);
		bytes.writeUInt32BE(0xcafebabe, 0);
		bytes.writeUInt32BE(1, 4);
		bytes.writeUInt32BE(0x01000007, 8);
		bytes.writeUInt32BE(3, 12);
		bytes.writeUInt32BE(64, 16);
		bytes.writeUInt32BE(8, 20);
		bytes.set(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]), 64);
		await fs.writeFile(target, bytes);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		await runFilesystemOperation(manager, "filesystem:fat-source", () =>
			scope.withOperationLease("filesystem:fat-source", async operation => {
				const handle = await operation.openRead(await operation.authorize(target, "read"));
				try {
					await fs.rename(target, `${target}.old`);
					await fs.writeFile(target, "replacement");
					const loc = await locateIdb(target, {
						arch: "x86_64",
						sourceReadPath: `/proc/${process.pid}/fd/${handle.fd}`,
					});
					loc.dir = path.join(root, "cache");
					loc.lockTarget = path.join(loc.dir, "db");
					await prepareStoreDir(loc);
					expect(await fs.readFile(loc.openPath)).toEqual(bytes.subarray(64, 72));
					await fs.writeFile(`${loc.openPath}.i64`, "finished-cache");
					await prepareStoreDir(loc);
					expect(loc.isNew).toBe(false);
					expect(await fs.readFile(loc.openPath, "utf8")).toBe("finished-cache");
					expect(await fs.readFile(target, "utf8")).toBe("replacement");
				} finally {
					await handle.close();
				}
			}),
		);
	});

	it("joins a disk-mutating formatter past timeout before parent disposition and ownership release", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-formatter-physical-drain-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const operationId = "filesystem:formatter-physical";
		const target = path.join(root, "input.ts");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const timeout = new AbortController();
		const failure = new Error("late formatter physical failure");
		const records: DurableRegistryRecord[] = [];
		let ownerId = "";
		let formatterSignal: AbortSignal | undefined;
		let physicalFinished = false;
		let settled = false;
		let closed = false;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.operationId === operationId) records.push(record);
			if (record.kind === "operation" && record.operationId === operationId) ownerId = record.ownerId;
		});
		const formatter: ServerConfig = {
			command: "held-physical-formatter",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () =>
				({
					format: async (filePath, content, signal, hooks) => {
						formatterSignal = signal;
						started.resolve();
						expect(hooks?.readText).toBeFunction();
						await release.promise;
						await fs.writeFile(filePath, content.replace("=1", " = 1;"));
						physicalFinished = true;
						throw failure;
					},
					lint: async () => [],
				}) satisfies LinterClient,
		};
		const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const serverSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["held-physical", formatter]]);
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const session = {
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated({ "lsp.formatOnWrite": true, "lsp.diagnosticsOnWrite": false }),
			enableLsp: true,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const pending = executeWrite(
			manager,
			scope,
			new WriteTool(session),
			operationId,
			"filesystem",
			target,
			"const a=1\n",
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await started.promise;
			const identity = await fs.lstat(target, { bigint: true });
			const targetHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId,
				canonicalTarget: target,
				identity,
			});
			expect(records).toContainEqual(expect.objectContaining({ targetHash, phase: "effect" }));
			expect((await store.getOperation(ownerId, "filesystem", operationId))?.record.phase).toBe("effect");
			timeout.abort(new Error("formatter budget expired"));
			await Promise.resolve();
			expect(formatterSignal?.aborted).toBe(true);
			expect(settled).toBe(false);
			expect(getOperationTerminal(manager, operationId)).toBeUndefined();
			const closing = store.close().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			release.resolve();
			await assert.rejects(pending, error => error === failure);
			await closing;
			expect(physicalFinished).toBe(true);
			expect(closed).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe("const a = 1;\n");
			expect(getOperationTerminal(manager, operationId)?.status).toBe("failed");
			expect(records).toContainEqual(expect.objectContaining({ targetHash, phase: "cancelled" }));
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
			timeoutSpy.mockRestore();
			serverSpy.mockRestore();
			configSpy.mockRestore();
		}
	});

	it("uses real Biome formatter read authority and propagates its durable read close failure", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-biome-read-close-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "biome.ts");
		const operationId = "filesystem:biome-read";
		const failure = new Error("Biome read close failed");
		const events: string[] = [];
		let spawned = 0;
		const open = nodeFs.promises.open;
		const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === target) {
				const readFile = handle.readFile.bind(handle);
				handle.readFile = ((...readArgs: Parameters<typeof handle.readFile>) => {
					events.push("read");
					return readFile(...readArgs);
				}) as typeof handle.readFile;
			}
			return handle;
		});
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind !== "resource" || record.operationId !== operationId) return;
			events.push(record.phase);
			if (events.includes("read") && record.phase === "completed") throw failure;
		});
		const formatter: ServerConfig = {
			command: "biome",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: BiomeClient.create,
		};
		const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const serverSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["real-biome", formatter]]);
		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(((
			_command: string[],
			options: { signal?: AbortSignal },
		) => {
			spawned++;
			expect(options.signal).toBeInstanceOf(AbortSignal);
			expect(events.at(-1)).toBe("effect");
			return {
				stdout: new Blob([]).stream(),
				stderr: new Blob([]).stream(),
				exited: fs.writeFile(target, "const a = 1;\n").then(() => 0),
			};
		}) as typeof Bun.spawn);
		const session = {
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated({ "lsp.formatOnWrite": true, "lsp.diagnosticsOnWrite": false }),
			enableLsp: true,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		try {
			await assert.rejects(
				executeWrite(manager, scope, new WriteTool(session), operationId, "filesystem", target, "const a=1\n"),
				error => error === failure,
			);
			expect(spawned).toBe(1);
			expect(events).toContain("read");
			expect(events.indexOf("read")).toBeGreaterThan(events.lastIndexOf("effect"));
			expect(await fs.readFile(target, "utf8")).toBe("const a = 1;\n");
			expect(getOperationTerminal(manager, operationId)?.status).toBe("failed");
		} finally {
			spawnSpy.mockRestore();
			serverSpy.mockRestore();
			configSpy.mockRestore();
			openSpy.mockRestore();
		}
	});

	it("drains the actual Biome process after timeout and a late output failure before releasing authority", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-biome-process-drain-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "held-biome.ts");
		const operationId = "filesystem:biome-process";
		const timeout = new AbortController();
		const started = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const failure = new Error("late Biome output failure");
		let output: ReadableStreamDefaultController<Uint8Array> | undefined;
		let processSignal: AbortSignal | undefined;
		let settled = false;
		let closed = false;
		let effects = 0;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "effect") effects++;
		});
		const formatter: ServerConfig = {
			command: "biome",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: BiomeClient.create,
		};
		const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const serverSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["held-biome", formatter]]);
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(((
			_command: string[],
			options: { signal?: AbortSignal },
		) => {
			processSignal = options.signal;
			started.resolve();
			expect(effects).toBe(2);
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						output = controller;
					},
				}),
				stderr: new Blob([]).stream(),
				exited: exited.promise,
			};
		}) as typeof Bun.spawn);
		const session = {
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated({ "lsp.formatOnWrite": true, "lsp.diagnosticsOnWrite": false }),
			enableLsp: true,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const pending = executeWrite(
			manager,
			scope,
			new WriteTool(session),
			operationId,
			"filesystem",
			target,
			"const a=1\n",
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await started.promise;
			timeout.abort(new Error("Biome budget expired"));
			output!.error(failure);
			await Promise.resolve();
			expect(processSignal?.aborted).toBe(true);
			expect(settled).toBe(false);
			expect(getOperationTerminal(manager, operationId)).toBeUndefined();
			const closing = store.close().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			await fs.writeFile(target, "const a = 1;\n");
			exited.resolve(1);
			await assert.rejects(pending, error => error === failure);
			await closing;
			expect(closed).toBe(true);
			expect(getOperationTerminal(manager, operationId)?.status).toBe("failed");
			expect(await fs.readFile(target, "utf8")).toBe("const a = 1;\n");
		} finally {
			output?.error(failure);
			exited.resolve(1);
			await pending.catch(() => undefined);
			spawnSpy.mockRestore();
			timeoutSpy.mockRestore();
			serverSpy.mockRestore();
			configSpy.mockRestore();
		}
	});

	it("joins a frozen LSP refresh read and its late durable close error despite optional caller fallback", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-refresh-read-drain-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "refresh.ts");
		await fs.writeFile(target, "export const value = 1;\n");
		const uri = fileToUri(target);
		const openDocument = { version: 1, lastUsedAt: 1, languageId: "typescript" };
		const client = {
			name: "refresh-read",
			diagnostics: new Map(),
			openFiles: new Map([[uri, openDocument]]),
		} as unknown as LspClient;
		const closeStarted = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		const callbackReturned = Promise.withResolvers<void>();
		const failure = new Error("late refresh read close failed");
		let settled = false;
		let effects = 0;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind !== "resource") return;
			if (record.phase === "effect") effects++;
			if (record.phase === "completed") {
				closeStarted.resolve();
				await releaseClose.promise;
				throw failure;
			}
		});
		const operationId = "filesystem:frozen-refresh-read";
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async () => {
				const refresh = lspClient.refreshFile(client, target);
				void refresh.catch(() => undefined);
				await Promise.race([closeStarted.promise, refresh]);
				callbackReturned.resolve();
			}),
		);
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			const stage = await Promise.race([
				closeStarted.promise.then(() => "read"),
				pending.then(
					() => "settled",
					() => "settled",
				),
			]);
			expect(stage).toBe("read");
			await callbackReturned.promise;
			expect(effects).toBe(1);
			expect(settled).toBe(false);
			expect(getOperationTerminal(manager, operationId)).toBeUndefined();
			expect(openDocument.version).toBe(1);
			releaseClose.resolve();
			await assert.rejects(pending, error => error === failure);
			expect(getOperationTerminal(manager, operationId)?.status).toBe("failed");
			expect(await fs.readFile(target, "utf8")).toBe("export const value = 1;\n");
		} finally {
			releaseClose.resolve();
			await pending.catch(() => undefined);
		}
	});

	it("resource-scopes ordinary write convention bytes, including split CRLF and BOM", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-convention-authority-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		for (const rejectClose of [false, true]) {
			const target = path.join(root, `convention-${rejectClose}.txt`);
			const original = `\uFEFF${"a".repeat(8188)}\r\nold\r\n`;
			await fs.writeFile(target, original);
			const operationId = `filesystem:convention-${rejectClose}`;
			const failure = Object.assign(new Error("convention read close failed"), { code: "ENOENT" });
			const identity = await fs.lstat(target, { bigint: true });
			const targetHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId,
				canonicalTarget: target,
				identity,
			});
			let conventionReadOpened = false;
			let conventionResourceId: string | undefined;
			let writeEffects = 0;
			const tool = new WriteTool({
				cwd: root,
				enableLsp: false,
				getSessionFile: () => null,
				pathScope: scope,
				settings: Settings.isolated({ "edit.blockAutoGenerated": false }),
			} as unknown as ToolSession);
			const open = nodeFs.promises.open;
			const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				if (args[0] === target) {
					const opened = await handle.stat({ bigint: true });
					if (opened.dev === identity.dev && opened.ino === identity.ino && opened.mode === identity.mode) {
						conventionReadOpened = true;
					}
				}
				return handle;
			});
			holdCommittedTransitionAcknowledgements(store, async record => {
				if (
					record.kind !== "resource" ||
					record.operationId !== operationId ||
					record.resourceClass !== "filesystem" ||
					record.targetHash !== targetHash
				)
					return;
				if (record.phase === "effect" && conventionReadOpened) writeEffects++;
				if (record.phase !== "completed" || !conventionReadOpened) return;
				if (!(await fs.readFile(target)).equals(Buffer.from(original))) return;
				conventionResourceId = record.resourceId;
				if (rejectClose) throw failure;
			});
			try {
				const pending = executeWrite(manager, scope, tool, operationId, "filesystem", target, "new\ntext\n");
				if (rejectClose) {
					await assert.rejects(pending, error => error === failure);
					expect(await fs.readFile(target, "utf8")).toBe(original);
					expect(writeEffects).toBe(0);
				} else {
					await pending;
					expect(await fs.readFile(target, "utf8")).toBe("\uFEFFnew\r\ntext\r\n");
					expect(writeEffects).toBe(1);
				}
				expect(conventionReadOpened).toBe(true);
				const resourceId = conventionResourceId;
				if (!resourceId) throw new Error("Convention read resource did not reach its physical close boundary.");
				expect((await store.getResource("Worker", 1, resourceId))?.record).toMatchObject({
					resourceClass: "filesystem",
					targetHash,
					phase: "completed",
				});
			} finally {
				openSpy.mockRestore();
			}
		}
	});
	it("detects generated bytes from the admitted inode after pathname replacement", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-generated-admission-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "generated.ts");
		const replacementPath = path.join(root, "replacement.ts");
		const original = "// @generated\nexport const value = 1;\n";
		const replacement = "// ordinary replacement\nexport const value = 2;\n";
		await fs.writeFile(target, original);
		await fs.writeFile(replacementPath, replacement);
		const originalIdentity = await fs.lstat(target, { bigint: true });
		const operationId = "filesystem:generated-admission";
		const originalTargetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: target,
			identity: originalIdentity,
		});
		const readEffect = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		let admittedResourceId: string | undefined;
		let pathReplaced = false;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.operationId === operationId &&
				record.resourceClass === "filesystem" &&
				record.targetHash === originalTargetHash &&
				record.phase === "effect"
			) {
				admittedResourceId = record.resourceId;
				readEffect.resolve();
				await releaseRead.promise;
			}
		});
		const originalOpen = nodeFs.promises.open;
		const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await originalOpen(...args);
			if (args[0] === target && !pathReplaced) {
				await fs.rename(replacementPath, target);
				pathReplaced = true;
			}
			return handle;
		});
		const pending = executeWrite(
			manager,
			scope,
			createWriteTool(root, scope),
			operationId,
			"filesystem",
			target,
			"replacement\n",
		);
		const settled = Promise.withResolvers<void>();
		void pending.then(
			() => settled.resolve(),
			() => settled.resolve(),
		);
		try {
			const boundary = await Promise.race([
				readEffect.promise.then(() => "admitted"),
				settled.promise.then(() => "settled"),
			]);
			expect(boundary).toBe("admitted");
			await Promise.resolve();
			await expect(fs.readFile(target, "utf8")).resolves.toBe(original);
			releaseRead.resolve();
			await assert.rejects(pending, /auto-generated/i);
			expect(pathReplaced).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe(replacement);
			const resourceId = admittedResourceId;
			if (!resourceId) throw new Error("Generated-header read resource was not admitted.");
			expect((await store.getResource("Worker", 1, resourceId))?.record).toMatchObject({
				resourceClass: "filesystem",
				targetHash: originalTargetHash,
				phase: "completed",
			});
		} finally {
			releaseRead.resolve();
			await pending.catch(() => undefined);
			openSpy.mockRestore();
		}
	});

	it("propagates generated-header read close failure before writing", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-generated-read-close-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "generated.ts");
		const original = "// @generated\nexport const value = 1;\n";
		await fs.writeFile(target, original);
		const identity = await fs.lstat(target, { bigint: true });
		const operationId = "filesystem:generated-read-close";
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: target,
			identity,
		});
		const closeFailure = Object.assign(new Error("generated-header read close failed"), { code: "ENOENT" });
		let resourceId: string | undefined;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.operationId === operationId &&
				record.resourceClass === "filesystem" &&
				record.targetHash === targetHash &&
				record.phase === "completed"
			) {
				resourceId = record.resourceId;
				throw closeFailure;
			}
		});
		const pending = executeWrite(
			manager,
			scope,
			createWriteTool(root, scope),
			operationId,
			"filesystem",
			target,
			"replacement\n",
		);
		await assert.rejects(pending, error => error === closeFailure);
		expect(await fs.readFile(target, "utf8")).toBe(original);
		if (!resourceId) throw new Error("Generated-header read resource did not reach durable close.");
		expect((await store.getResource("Worker", 1, resourceId))?.record).toMatchObject({
			resourceClass: "filesystem",
			targetHash,
			phase: "completed",
		});
	});

	it("awaits SQLite header read admission and close before row mutation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-sqlite-header-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const databasePath = path.join(root, "data.sqlite");
		const observer = new Database(databasePath);
		observer.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
		observer.run("INSERT INTO entries VALUES (1, 'before')");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const readEffect = Promise.withResolvers<void>();
		const releaseRead = Promise.withResolvers<void>();
		const closeFailure = Object.assign(new Error("SQLite header read close failed"), { code: "ENOENT" });
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind !== "resource" ||
				record.operationId !== "filesystem:sqlite-header-close" ||
				record.resourceClass !== "filesystem"
			)
				return;
			if (record.phase === "effect") {
				readEffect.resolve();
				await releaseRead.promise;
			}
			if (record.phase === "completed") throw closeFailure;
		});
		const pending = executeWrite(
			manager,
			scope,
			createWriteTool(root, scope),
			"filesystem:sqlite-header-close",
			"filesystem",
			`${databasePath}:entries:1`,
			"{ value: 'after' }",
		);
		const settled = Promise.withResolvers<void>();
		void pending.then(
			() => settled.resolve(),
			() => settled.resolve(),
		);
		try {
			const boundary = await Promise.race([
				readEffect.promise.then(() => "admitted"),
				settled.promise.then(() => "settled"),
			]);
			expect(boundary).toBe("admitted");
			expect(observer.query("SELECT value FROM entries WHERE id=1").get()).toEqual({ value: "before" });
			releaseRead.resolve();
			await assert.rejects(pending, error => error === closeFailure);
			expect(observer.query("SELECT value FROM entries WHERE id=1").get()).toEqual({ value: "before" });
		} finally {
			releaseRead.resolve();
			await pending.catch(() => undefined);
			observer.close();
		}
	});

	it("awaits truncation guard read close and never writes a shorter ordinary projection", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-projection-authority-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const { manager, scope } = await createOperationContext(store, directory);
		const target = path.join(directory, "projection.txt");
		const original = "one\ntwo\nthree\nfour\n";
		await fs.writeFile(target, original);
		const failure = new Error("projection read close failed");
		const operationId = "filesystem:projection";
		const identity = await fs.lstat(target, { bigint: true });
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: target,
			identity,
		});
		let projectionRead = false;
		let closedResource: string | undefined;
		const open = nodeFs.promises.open;
		const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === target) {
				const readFile = handle.readFile.bind(handle);
				handle.readFile = (async (...readArgs: Parameters<typeof readFile>) => {
					const bytes = await readFile(...readArgs);
					if (bytes === original) projectionRead = true;
					return bytes;
				}) as typeof handle.readFile;
			}
			return handle;
		});
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.operationId === operationId &&
				record.resourceClass === "filesystem" &&
				record.targetHash === targetHash &&
				record.phase === "completed" &&
				projectionRead
			) {
				closedResource = record.resourceId;
				throw failure;
			}
		});
		const tool = new WriteTool({
			cwd: directory,
			enableLsp: false,
			getSessionFile: () => null,
			pathScope: scope,
			settings: Settings.isolated({ "edit.blockAutoGenerated": false }),
		} as unknown as ToolSession);
		const content = "one\n\n[Showing lines 1-1 of 4. Use :2 to continue]";
		try {
			await assert.rejects(
				executeWrite(manager, scope, tool, operationId, "filesystem", target, content),
				error => error === failure,
			);
			expect(projectionRead).toBe(true);
			if (!closedResource) throw new Error("Projection read did not reach durable close.");
			expect((await store.getResource("Worker", 1, closedResource))?.record).toMatchObject({
				resourceClass: "filesystem",
				targetHash,
				phase: "completed",
			});
			expect(await fs.readFile(target, "utf8")).toBe(original);
		} finally {
			openSpy.mockRestore();
		}
	});

	it("does not turn real edit auto-repair read close failure into optional success", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-repair-read-authority-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const { manager, scope } = await createOperationContext(store, directory);
		const target = path.join(directory, "repair.ts");
		const model = createMockModel({ id: "repair-reader" });
		const failure = Object.assign(new Error("auto-repair read close failed"), { code: "ENOENT" });
		const original = "export const value = 1;\n";
		const broken = "export const value = ;\n";
		await fs.writeFile(target, original);
		let autoRepairStarted = false;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => {
				autoRepairStarted = true;
				return "test-key";
			},
		};
		const session = {
			cwd: directory,
			pathScope: scope,
			settings: Settings.isolated({
				"edit.autoRepair.enabled": true,
				"edit.enforceSeenLines": false,
				modelRoles: { smol: `${model.provider}/${model.id}` },
			}),
			modelRegistry: registry,
			enableLsp: false,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		let repairRead = false;
		const open = nodeFs.promises.open;
		const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === target) {
				const readFile = handle.readFile.bind(handle);
				handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
					const result = await readFile(...readArgs);
					if (autoRepairStarted && result.toString() === broken) repairRead = true;
					return result;
				}) as typeof handle.readFile;
			}
			return handle;
		});
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "completed" && repairRead) throw failure;
		});
		try {
			expect(
				await runFilesystemOperation(manager, "filesystem:auto-repair-read", () =>
					scope.withOperationLease("filesystem:auto-repair-read", () =>
						attemptEditAutoRepair({
							session,
							snapshot: { path: target, prev: original, next: broken },
							writethrough: async () => {
								throw new Error("repair must stop before completion");
							},
						}),
					),
				),
			).toBeUndefined();
			expect(repairRead).toBe(false);
			autoRepairStarted = false;
			await assert.rejects(
				runFilesystemOperation(manager, "filesystem:auto-repair-close", () =>
					scope.withOperationLease("filesystem:auto-repair-close", () =>
						new EditTool(session, "replace").execute("repair", {
							path: target,
							old_string: "= 1",
							new_string: "= ",
						}),
					),
				),
				error => error === failure,
			);
			expect(repairRead).toBe(true);
			expect(await fs.readFile(target, "utf8")).toBe(broken);
		} finally {
			openSpy.mockRestore();
		}
	});

	for (const terminal of ["sqlite", "archive", "acp"] as const) {
		it(`flushes a real ordinary write before a terminal ${terminal} write with fresh current authority`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), `omp-terminal-${terminal}-batch-`));
			directories.push(directory);
			const root = await fs.realpath(directory);
			const store = await createAuthorityStore(root);
			const { manager, scope } = await createOperationContext(store, root);
			const first = path.join(root, "first.ts");
			const destination = path.join(
				root,
				terminal === "sqlite" ? "data.sqlite" : terminal === "archive" ? "data.zip" : "editor.txt",
			);
			const database = terminal === "sqlite" ? new Database(destination) : undefined;
			database?.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
			database?.run("INSERT INTO entries VALUES (1, 'old')");
			const session = {
				cwd: root,
				pathScope: scope,
				settings: Settings.isolated({ "lsp.formatOnWrite": true, "lsp.diagnosticsOnWrite": false }),
				enableLsp: true,
				getSessionFile: () => null,
			} as unknown as ToolSession;
			const formatter: ServerConfig = {
				command: "test-formatter",
				fileTypes: ["ts"],
				rootMarkers: [],
				createClient: () =>
					({
						format: async (_path: string, text: string) => text.replace("=1", " = 1;"),
						lint: async () => [],
					}) satisfies LinterClient,
			};
			const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
			const serverSpy = vi
				.spyOn(lspConfig, "getServersForFile")
				.mockReturnValue([[`terminal-${terminal}`, formatter]]);
			const toolCalls = [{ name: "write" }, { name: "write" }];
			const batchId = `terminal-${terminal}`;
			const records: DurableRegistryRecord[] = [];
			holdCommittedTransitionAcknowledgements(store, async record => {
				if (record.kind === "resource" && record.operationId === `filesystem:${terminal}-final`)
					records.push(record);
			});
			try {
				await runFilesystemOperation(manager, `filesystem:${terminal}-first`, () =>
					scope.withOperationLease(`filesystem:${terminal}-first`, () =>
						new WriteTool(session).execute(
							"first",
							{ path: first, content: "const a=1\n" },
							undefined,
							undefined,
							{ toolCall: { batchId, index: 0, toolCalls } } as never,
						),
					),
				);
				const identity = await fs.lstat(first, { bigint: true });
				if (terminal === "acp")
					session.getClientBridge = () => ({
						capabilities: { writeTextFile: true },
						writeTextFile: async request => {
							await fs.writeFile(request.path, request.content);
						},
					});
				const finalPath =
					terminal === "sqlite"
						? `${destination}:entries:1`
						: terminal === "archive"
							? `${destination}:note.txt`
							: destination;
				const content = terminal === "sqlite" ? "{ value: 'new' }" : "terminal bytes";
				await runFilesystemOperation(manager, `filesystem:${terminal}-final`, () =>
					scope.withOperationLease(`filesystem:${terminal}-final`, () =>
						new WriteTool(session).execute("final", { path: finalPath, content }, undefined, undefined, {
							toolCall: { batchId, index: 1, toolCalls },
						} as never),
					),
				);
				expect(await fs.readFile(first, "utf8")).toBe("const a = 1;\n");
				const targetHash = durableTargetHash({
					actorId: "Worker",
					generation: 1,
					operationId: `filesystem:${terminal}-final`,
					canonicalTarget: first,
					identity,
				});
				expect(
					records.filter(
						record =>
							record.kind === "resource" && record.targetHash === targetHash && record.phase === "completed",
					).length,
				).toBeGreaterThanOrEqual(2);
				if (database)
					expect(database.query("SELECT value FROM entries WHERE id=1").get()).toEqual({ value: "new" });
				else if (terminal === "archive")
					expect((await readArchiveEntries({ path: destination, format: "zip" })).get("note.txt")).toEqual(
						new TextEncoder().encode("terminal bytes"),
					);
				else expect(await fs.readFile(destination, "utf8")).toBe("terminal bytes");
			} finally {
				database?.close();
				serverSpy.mockRestore();
				configSpy.mockRestore();
			}
		});
	}
	it("preserves malformed archive parsing failure with admitted read-close uncertainty", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-archive-parse-close-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const archivePath = path.join(root, "data.zip");
		await fs.writeFile(archivePath, "not an archive");
		const archiveIdentity = await fs.lstat(archivePath, { bigint: true });
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const operationId = "filesystem:archive-parse-close";
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: archivePath,
			identity: archiveIdentity,
		});
		const closeFailure = new AuthorityRpcError(
			"archive read close outcome unknown",
			"archive-parse-close-request",
			true,
		);
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.operationId === operationId &&
				record.targetHash === targetHash &&
				record.phase === "completed"
			) {
				throw closeFailure;
			}
		});
		const tool = new WriteTool({
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated(),
			getSessionFile: () => null,
		} as unknown as ToolSession);
		const outcome = await runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, () =>
				tool.execute("archive", { path: `${archivePath}:note.txt`, content: "after" }),
			),
		).catch(error => error);
		expect(outcome).toBeInstanceOf(AggregateError);
		const errors = (outcome as AggregateError).errors;
		expect(errors).toHaveLength(2);
		expect(errors[0]).toBeInstanceOf(Error);
		expect((errors[0] as Error).message).toMatch(/archive|invalid|zip/i);
		expect(errors[1]).toBe(closeFailure);
		expect(errors[1]).toMatchObject({ unknownOutcome: true, requestId: "archive-parse-close-request" });
		expect(await fs.readFile(archivePath, "utf8")).toBe("not an archive");
	});

	it("preserves archive close uncertainty and pending batch flush constituents", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-archive-unknown-close-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const archivePath = path.join(root, "data.zip");
		await writeArchive(archivePath, "zip", new Map([["note.txt", "before"]]));
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const firstPath = path.join(root, "first.ts");
		const calls = [{ name: "write" }, { name: "write" }];
		const batchId = "archive-unknown-close";
		await runFilesystemOperation(manager, "filesystem:archive-batch-first", () =>
			scope.withOperationLease("filesystem:archive-batch-first", () =>
				new WriteTool({
					cwd: root,
					pathScope: scope,
					settings: Settings.isolated(),
					getSessionFile: () => null,
				} as unknown as ToolSession).execute(
					"first",
					{ path: firstPath, content: "const a=1\n" },
					undefined,
					undefined,
					{ toolCall: { batchId, index: 0, toolCalls: calls } } as never,
				),
			),
		);
		const archiveStat = await fs.lstat(archivePath, { bigint: true });
		const firstStat = await fs.lstat(firstPath, { bigint: true });
		const operationId = "filesystem:archive-unknown-final";
		const archiveHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: archivePath,
			identity: archiveStat,
		});
		const firstHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: firstPath,
			identity: firstStat,
		});
		const archiveFailure = new AuthorityRpcError("archive close outcome unknown", "archive-read-close-request", true);
		const flushFailure = new Error("pending archive batch flush failed");
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind !== "resource" || record.operationId !== operationId || record.phase !== "completed") return;
			if (record.targetHash === archiveHash) throw archiveFailure;
			if (record.targetHash === firstHash) throw flushFailure;
		});
		const tool = new WriteTool({
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated(),
			getSessionFile: () => null,
		} as unknown as ToolSession);
		const outcome = await runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, () =>
				tool.execute("archive", { path: `${archivePath}:note.txt`, content: "after" }, undefined, undefined, {
					toolCall: { batchId, index: 1, toolCalls: calls },
				} as never),
			),
		).catch(error => error);
		expect(outcome).toBeInstanceOf(AggregateError);
		expect((outcome as AggregateError).errors).toEqual([archiveFailure, flushFailure]);
		expect((outcome as AggregateError).errors[0]).toMatchObject({
			unknownOutcome: true,
			requestId: "archive-read-close-request",
		});
		expect(getOperationTerminal(manager, operationId)).toMatchObject({
			status: "abandoned",
			detail: "Authority outcome is unknown; durable terminal state was not asserted.",
		});
		expect(await readArchiveEntries({ path: archivePath, format: "zip" })).toEqual(
			new Map([["note.txt", new TextEncoder().encode("before")]]),
		);
	});

	it("preserves unknown replacement acknowledgement after the archive is physically replaced", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-archive-unknown-replace-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const archivePath = path.join(root, "data.zip");
		await writeArchive(archivePath, "zip", new Map([["note.txt", "before"]]));
		const archiveIdentity = await fs.lstat(archivePath, { bigint: true });
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const operationId = "filesystem:archive-replace-unknown";
		const archiveTargetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: archivePath,
			identity: archiveIdentity,
		});
		const failure = new AuthorityRpcError("archive replacement outcome unknown", "archive-replace-request", true);
		let earlierReadCompleted = false;
		let replacementAcknowledgementFailed = false;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind !== "resource" ||
				record.operationId !== operationId ||
				record.resourceClass !== "filesystem" ||
				record.targetHash !== archiveTargetHash ||
				record.phase !== "completed"
			)
				return;
			const entries = await readArchiveEntries({ path: archivePath, format: "zip" });
			if (!earlierReadCompleted) {
				expect(entries.get("note.txt")).toEqual(new TextEncoder().encode("before"));
				earlierReadCompleted = true;
				return;
			}
			expect(entries.get("note.txt")).toEqual(new TextEncoder().encode("after"));
			replacementAcknowledgementFailed = true;
			throw failure;
		});
		const tool = new WriteTool({
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated(),
			getSessionFile: () => null,
		} as unknown as ToolSession);
		const outcome = await runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, () =>
				tool.execute("archive", { path: `${archivePath}:note.txt`, content: "after" }),
			),
		).catch(error => error);
		expect(outcome).toBe(failure);
		expect(earlierReadCompleted).toBe(true);
		expect(replacementAcknowledgementFailed).toBe(true);
		expect(getOperationTerminal(manager, operationId)).toMatchObject({
			status: "abandoned",
			detail: "Authority outcome is unknown; durable terminal state was not asserted.",
		});
		expect(await readArchiveEntries({ path: archivePath, format: "zip" })).toEqual(
			new Map([["note.txt", new TextEncoder().encode("after")]]),
		);
	});

	it("retains a terminal SQLite mutation failure together with earlier batch read close failure", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-terminal-batch-errors-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const first = path.join(root, "first.ts");
		const databasePath = path.join(root, "data.sqlite");
		const database = new Database(databasePath);
		database.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
		database.run("INSERT INTO entries VALUES (1, 'old')");
		const failure = new Error("terminal batch read close failed");
		const session = {
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated(),
			enableLsp: true,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const toolCalls = [{ name: "write" }, { name: "write" }];
		const batchId = "terminal-compound";
		try {
			await runFilesystemOperation(manager, "filesystem:compound-first", () =>
				scope.withOperationLease("filesystem:compound-first", () =>
					new WriteTool(session).execute("first", { path: first, content: "const a=1\n" }, undefined, undefined, {
						toolCall: { batchId, index: 0, toolCalls },
					} as never),
				),
			);
			const identity = await fs.lstat(first, { bigint: true });
			const targetHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId: "filesystem:compound-final",
				canonicalTarget: first,
				identity,
			});
			holdCommittedTransitionAcknowledgements(store, async record => {
				if (record.kind === "resource" && record.targetHash === targetHash && record.phase === "completed")
					throw failure;
			});
			const outcome = await runFilesystemOperation(manager, "filesystem:compound-final", () =>
				scope.withOperationLease("filesystem:compound-final", () =>
					new WriteTool(session).execute(
						"final",
						{ path: `${databasePath}:entries:1`, content: "{ value: null }" },
						undefined,
						undefined,
						{ toolCall: { batchId, index: 1, toolCalls } } as never,
					),
				),
			).catch(error => error);
			expect(outcome).toBeInstanceOf(AggregateError);
			expect((outcome as AggregateError).errors[0]).toBeInstanceOf(Error);
			expect(((outcome as AggregateError).errors[0] as Error).message).toMatch(/NOT NULL/i);
			expect((outcome as AggregateError).errors[1]).toBe(failure);
			expect(database.query("SELECT value FROM entries WHERE id=1").get()).toEqual({ value: "old" });
			expect(await fs.readFile(first, "utf8")).toBe("const a=1\n");
		} finally {
			database.close();
		}
	});

	it("returns the callback value and persists the publication independently", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-local-result-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const state = new DurableLocalState(store, "root");
		const entryId = canonicalDurableSha256({ localId: "root", url: "local://result.md" });
		const entryHash = durableBackingSha256("published bytes");
		const target = path.join(directory, "result.md");
		const result = await state.publishWithEffect(entryId, entryHash, "0".repeat(64), async () => {
			await fs.writeFile(target, "published bytes");
			return "effect result";
		});
		expect(result).toBe("effect result");
		expect(await fs.readFile(target, "utf8")).toBe("published bytes");
		expect(await store.localBacking("root")).toMatchObject({ entryId, entryHash, version: 1 });
	});
	it("rejects a late child after its parent callback returns while another child drains", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-late-child-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const releaseChild = Promise.withResolvers<void>();
		const attemptLate = Promise.withResolvers<void>();
		const callbackReturned = Promise.withResolvers<void>();
		let late: Promise<void> | undefined;
		const parent = withAuthorityEffect(store, async () => {
			void withAuthorityEffect(store, async () => {
				await releaseChild.promise;
			});
			late = attemptLate.promise.then(() => withAuthorityEffect(store, async () => {}));
			callbackReturned.resolve();
		});
		await callbackReturned.promise;
		await Promise.resolve();
		attemptLate.resolve();
		await assert.rejects(late!, /no longer active/i);
		releaseChild.resolve();
		await parent;
	});

	it("detaches work into root-level scopes whether its launcher still accepts or has settled, and refuses nested late effects that do not detach", async () => {
		// Detached work never inherits the launcher's scope or lease: each effect it admits is its own root-level scope,
		// drained by close and refused once the root is closing. So a late detach (a queued background job, a detached
		// subagent) is allowed; only a late effect that tries to nest in the settled scope is refused.
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-late-detach-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		let detachedDuringScope: Promise<void> | undefined;
		let lateDetached: Promise<void> | undefined;
		let lateNested: Promise<void> | undefined;
		const attemptLate = Promise.withResolvers<void>();
		await withAuthorityEffect(store, async () => {
			detachedDuringScope = detachFromAuthorityEffect(store, async () => {
				await Bun.sleep(0);
				await withAuthorityEffect(store, async () => {});
			});
			// Continuations registered inside the scope keep its async context and run after the scope settled.
			lateDetached = attemptLate.promise.then(() =>
				detachFromAuthorityEffect(store, () => withAuthorityEffect(store, async () => {})),
			);
			lateNested = attemptLate.promise.then(() => withAuthorityEffect(store, async () => {}));
		});
		await detachedDuringScope;
		attemptLate.resolve();
		await lateDetached;
		const nested = await lateNested!.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(nested).toBeInstanceOf(Error);
		expect((nested as Error).message).toMatch(/no longer active/i);
	});

	it("formats an earlier batch target under the current real operation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-batch-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const formatter: ServerConfig = {
			command: "test-formatter",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () =>
				({
					format: async (_path: string, content: string) => content.replace("=1", " = 1;"),
					lint: async () => [],
				}) satisfies LinterClient,
		};
		const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const serverSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["formatter", formatter]]);
		const first = path.join(root, "first.ts");
		const second = path.join(root, "second.ts");
		const secondRecords: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.operationId === "filesystem:batch-second") secondRecords.push(record);
		});
		const run = (id: string, target: string, flush: boolean) =>
			runFilesystemOperation(manager, id, () =>
				scope.withOperationLease(id, async () => {
					const operation = scope.currentOperation();
					const writethrough = createLspWritethrough(root, {
						enableFormat: true,
						mutationHooks: filesystemMutationHooks(operation),
					});
					return writethrough(target, "const a=1\n", undefined, undefined, { id: "real-authority-batch", flush });
				}),
			);
		try {
			await run("filesystem:batch-first", first, false);
			const identity = await fs.lstat(first, { bigint: true });
			await run("filesystem:batch-second", second, true);
			const targetHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId: "filesystem:batch-second",
				canonicalTarget: first,
				identity,
			});
			expect(secondRecords).toContainEqual(
				expect.objectContaining({ kind: "resource", targetHash, phase: "completed" }),
			);
			expect(await fs.readFile(first, "utf8")).toBe("const a = 1;\n");
		} finally {
			configSpy.mockRestore();
			serverSpy.mockRestore();
		}
	});

	it("explicit edit deletion flushes earlier writes and propagates batch read close failure", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-explicit-flush-read-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const session = {
			cwd: root,
			pathScope: scope,
			settings: Settings.isolated({
				"lsp.formatOnWrite": true,
				"lsp.diagnosticsOnWrite": false,
				"edit.enforceSeenLines": false,
			}),
			enableLsp: true,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const formatter: ServerConfig = {
			command: "test-formatter",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () =>
				({
					format: async (_path: string, text: string) => text.replace("=1", " = 1;"),
					lint: async () => [],
				}) satisfies LinterClient,
		};
		const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const serverSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["formatter", formatter]]);
		try {
			for (const rejectReadClose of [false, true]) {
				const first = path.join(root, `first-${rejectReadClose}.ts`);
				const victim = path.join(root, `victim-${rejectReadClose}.ts`);
				await fs.writeFile(victim, "delete me\n");
				const toolCalls = [{ name: "write" }, { name: "edit" }];
				const batchId = `explicit-${rejectReadClose}`;
				const firstId = `filesystem:${batchId}-write`;
				await runFilesystemOperation(manager, firstId, () =>
					scope.withOperationLease(firstId, () =>
						new WriteTool(session).execute(
							firstId,
							{ path: first, content: "const a=1\n" },
							undefined,
							undefined,
							{ toolCall: { batchId, index: 0, toolCalls } } as never,
						),
					),
				);
				const identity = await fs.lstat(first, { bigint: true });
				const editId = `filesystem:${batchId}-edit`;
				const targetHash = durableTargetHash({
					actorId: "Worker",
					generation: 1,
					operationId: editId,
					canonicalTarget: first,
					identity,
				});
				const failure = new Error("batch read close failed");
				let completedReads = 0;
				holdCommittedTransitionAcknowledgements(store, async record => {
					if (
						record.kind === "resource" &&
						record.operationId === editId &&
						record.targetHash === targetHash &&
						record.phase === "completed"
					) {
						completedReads++;
						if (rejectReadClose) throw failure;
					}
				});
				const execute = runFilesystemOperation(manager, editId, () =>
					scope.withOperationLease(editId, () =>
						new EditTool(session, "patch").execute(
							editId,
							{ path: victim, edits: [{ op: "delete" }] },
							undefined,
							undefined,
							{ toolCall: { batchId, index: 1, toolCalls } } as never,
						),
					),
				);
				if (rejectReadClose) {
					await assert.rejects(execute, error => error === failure);
					expect(await fs.readFile(first, "utf8")).toBe("const a=1\n");
					expect(completedReads).toBe(1);
				} else {
					expect((await execute).isError).not.toBe(true);
					expect(await fs.readFile(first, "utf8")).toBe("const a = 1;\n");
					expect(completedReads).toBeGreaterThanOrEqual(2);
				}
				await expect(fs.lstat(victim)).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			configSpy.mockRestore();
			serverSpy.mockRestore();
		}
	});

	it("restores an overwritten workspace destination and durably cleans displacement after a physical rename failure", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-restore-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const source = path.join(root, "source.txt");
		const destination = path.join(root, "destination.txt");
		await fs.writeFile(source, "source bytes");
		await fs.writeFile(destination, "destination bytes");
		const rename = fs.rename;
		const failure = Object.assign(new Error("physical rename refused"), { code: "EXDEV" });
		const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (from === source) throw failure;
			await rename(from, to);
		});
		const records: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource") records.push(record);
		});
		try {
			await assert.rejects(
				runFilesystemOperation(manager, "filesystem:restore-displacement", () =>
					scope.withOperationLease("filesystem:restore-displacement", operation =>
						applyWorkspaceEdit(
							{
								documentChanges: [
									{
										kind: "rename",
										oldUri: fileToUri(source),
										newUri: fileToUri(destination),
										options: { overwrite: true },
									},
								],
							},
							root,
							undefined,
							{ operation, authorizePath: async () => {} },
						),
					),
				),
				error => error === failure,
			);
			expect(await fs.readFile(source, "utf8")).toBe("source bytes");
			expect(await fs.readFile(destination, "utf8")).toBe("destination bytes");
			expect((await fs.readdir(root)).filter(name => name.startsWith(".omp-displaced-"))).toEqual([]);
			expect(
				records.filter(record => record.kind === "resource" && record.phase === "completed").length,
			).toBeGreaterThanOrEqual(6);
			expect(records).toContainEqual(expect.objectContaining({ phase: "cancelled" }));
		} finally {
			renameSpy.mockRestore();
		}
	});

	it("accepts only physical ACP read denial while retaining durable read cancellation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-unreadable-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const { manager, scope } = await createOperationContext(store, directory);
		const target = path.join(directory, "unreadable.txt");
		const open = nodeFs.promises.open;
		const openSpy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			if (args[0] === target) throw Object.assign(new Error("physical read denied"), { code: "EACCES" });
			return open(...args);
		});
		const records: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource") records.push(record);
		});
		const tool = createWriteTool(directory, scope, undefined, {
			capabilities: { writeTextFile: true },
			writeTextFile: async request => {
				await fs.writeFile(request.path, request.content);
			},
		});
		try {
			const result = await executeWrite(
				manager,
				scope,
				tool,
				"filesystem:unreadable-acp",
				"filesystem",
				target,
				"broker bytes",
			);
			expect(result.content).toContainEqual(
				expect.objectContaining({ text: expect.stringContaining("Successfully wrote") }),
			);
			expect(await fs.readFile(target, "utf8")).toBe("broker bytes");
			expect(records.filter(record => record.kind === "resource" && record.phase === "effect")).toHaveLength(2);
			expect(records).toContainEqual(expect.objectContaining({ phase: "completed" }));
			expect(records).toContainEqual(expect.objectContaining({ phase: "cancelled" }));
		} finally {
			openSpy.mockRestore();
		}
	});

	it("propagates a detached child failure after the parent callback returns and drains siblings", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-child-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const releaseFailure = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		const failure = new Error("child terminal failed");
		let siblingSettled = false;
		let parentSettled = false;
		const parent = withAuthorityEffect(store, async () => {
			void withAuthorityEffect(store, async () => {
				await releaseFailure.promise;
				throw failure;
			}).catch(() => {});
			void withAuthorityEffect(store, async () => {
				await releaseSibling.promise;
				siblingSettled = true;
			});
			return "parent success";
		});
		void parent.then(
			() => {
				parentSettled = true;
			},
			() => {
				parentSettled = true;
			},
		);
		releaseFailure.resolve();
		await Promise.resolve();
		expect(parentSettled).toBe(false);
		releaseSibling.resolve();
		await assert.rejects(parent, error => error === failure);
		expect(siblingSettled).toBe(true);
	});

	it("surfaces a parent failure that already carries its nested effect failure without re-aggregating it", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-carried-child-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const nested = new Error("nested effect cancelled");
		const sibling = new Error("sibling close failed");
		const parentFailure = new AggregateError([new Error("primary", { cause: nested }), sibling], "parent failed");
		const parent = withAuthorityEffect(store, async () => {
			await withAuthorityEffect(store, async () => {
				throw nested;
			}).catch(() => {});
			await withAuthorityEffect(store, async () => {
				throw sibling;
			}).catch(() => {});
			throw parentFailure;
		});
		await assert.rejects(parent, error => error === parentFailure);
	});

	it("still aggregates a nested effect failure that the parent failure does not carry", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-uncarried-child-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const nested = new Error("nested effect failed");
		const parentFailure = new Error("parent replaced the nested failure");
		const outcome = await withAuthorityEffect(store, async () => {
			await withAuthorityEffect(store, async () => {
				throw nested;
			}).catch(() => {});
			throw parentFailure;
		}).catch(error => error);
		expect(outcome).toBeInstanceOf(AggregateError);
		expect((outcome as AggregateError).errors).toEqual([parentFailure, nested]);
	});

	it("reconciles detached child failures before durable parent completion", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parent-disposition-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const { manager } = await createOperationContext(store, directory);
		const releaseFailure = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		const returned = Promise.withResolvers<void>();
		const failure = new Error("nested durable completion failed");
		let siblingDrained = false;
		let ownerId = "";
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "operation" && record.operationId === "filesystem:nested-disposition")
				ownerId = record.ownerId;
		});
		const id = "filesystem:nested-disposition";
		const pending = runFilesystemOperation(manager, id, async () => {
			void withAuthorityEffect(store, async () => {
				await releaseFailure.promise;
				throw failure;
			}).catch(() => {});
			void withAuthorityEffect(store, async () => {
				await releaseSibling.promise;
				siblingDrained = true;
			});
			returned.resolve();
			return "must not commit";
		});
		await returned.promise;
		releaseFailure.resolve();
		await Promise.resolve();
		expect((await store.getOperation(ownerId, "filesystem", id))?.record.phase).toBe("effect");
		expect(getOperationTerminal(manager, id)).toBeUndefined();
		releaseSibling.resolve();
		await assert.rejects(pending, error => error === failure);
		expect(siblingDrained).toBe(true);
		expect((await store.getOperation(ownerId, "filesystem", id))?.record.phase).toBe("failed");
		expect(getOperationTerminal(manager, id)?.status).toBe("failed");
	});

	it("flushes a real write then edit batch with current exact resource authority", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-edit-authority-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const settings = Settings.isolated({
			"lsp.formatOnWrite": true,
			"lsp.diagnosticsOnEdit": false,
			"lsp.diagnosticsOnWrite": false,
			"edit.enforceSeenLines": false,
		});
		const session = {
			cwd: root,
			pathScope: scope,
			settings,
			enableLsp: true,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const formatter: ServerConfig = {
			command: "test-formatter",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () =>
				({
					format: async (_path: string, text: string) => text.replace("=1", " = 1;"),
					lint: async () => [],
				}) satisfies LinterClient,
		};
		const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const serverSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["formatter", formatter]]);
		const first = path.join(root, "first.ts");
		const second = path.join(root, "second.ts");
		await fs.writeFile(second, "const b=0\n");
		const toolCalls = [{ name: "write" }, { name: "edit" }];
		const records: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.operationId === "filesystem:real-edit") records.push(record);
		});
		try {
			await runFilesystemOperation(manager, "filesystem:real-write", () =>
				scope.withOperationLease("filesystem:real-write", () =>
					new WriteTool(session).execute("write", { path: first, content: "const a=1\n" }, undefined, undefined, {
						toolCall: { batchId: "write-edit", index: 0, toolCalls },
					} as never),
				),
			);
			const identity = await fs.lstat(first, { bigint: true });
			const result = await runFilesystemOperation(manager, "filesystem:real-edit", () =>
				scope.withOperationLease("filesystem:real-edit", () =>
					new EditTool(session, "replace").execute(
						"edit",
						{ path: second, old_string: "=0", new_string: "=1" },
						undefined,
						undefined,
						{ toolCall: { batchId: "write-edit", index: 1, toolCalls } } as never,
					),
				),
			);
			expect(result.isError).not.toBe(true);
			expect(await fs.readFile(first, "utf8")).toBe("const a = 1;\n");
			expect(await fs.readFile(second, "utf8")).toBe("const b = 1;\n");
			const targetHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId: "filesystem:real-edit",
				canonicalTarget: first,
				identity,
			});
			expect(records).toContainEqual(expect.objectContaining({ targetHash, phase: "completed" }));
			expect(
				records.filter(
					record => record.kind === "resource" && record.targetHash === targetHash && record.phase === "completed",
				).length,
			).toBeGreaterThanOrEqual(2);
		} finally {
			configSpy.mockRestore();
			serverSpy.mockRestore();
		}
	});

	it("keeps committed local batch bytes immutable when an ordinary entry enables formatting", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-batch-policy-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const state = new DurableLocalState(store, "root");
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => root,
			getSessionId: () => "root",
			getPathScope: () => scope,
			getDurableLocalState: () => state,
		};
		const session = {
			cwd: root,
			pathScope: scope,
			localProtocolOptions,
			settings: Settings.isolated({ "lsp.formatOnWrite": true, "lsp.diagnosticsOnWrite": false }),
			enableLsp: true,
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const formatter: ServerConfig = {
			command: "test-formatter",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () =>
				({
					format: async (_path: string, text: string) => text.replace("=1", " = 1;"),
					lint: async () => [],
				}) satisfies LinterClient,
		};
		const configSpy = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const serverSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["formatter", formatter]]);
		try {
			for (const localFirst of [true, false]) {
				const batchId = `mixed-${localFirst}`;
				const localUrl = `local://local-${localFirst}.ts`;
				const ordinary = path.join(root, `ordinary-${localFirst}.ts`);
				const paths = localFirst ? [localUrl, ordinary] : [ordinary, localUrl];
				for (let index = 0; index < paths.length; index++) {
					const target = paths[index]!;
					const id = `${target.startsWith("local:") ? "local" : "filesystem"}:${batchId}-${index}`;
					const run = () =>
						scope.withOperationLease(id, () =>
							new WriteTool(session).execute(
								id,
								{ path: target, content: "const a=1\n" },
								undefined,
								undefined,
								{ toolCall: { batchId, index, toolCalls: [{ name: "write" }, { name: "write" }] } } as never,
							),
						);
					await (target.startsWith("local:")
						? runLocalOperation(manager, id, run)
						: runFilesystemOperation(manager, id, run));
				}
				expect(await fs.readFile(path.join(root, "local", `local-${localFirst}.ts`), "utf8")).toBe("const a=1\n");
				expect(await fs.readFile(ordinary, "utf8")).toBe("const a = 1;\n");
				expect(await store.localBacking("root")).toMatchObject({ entryHash: durableBackingSha256("const a=1\n") });
			}
		} finally {
			configSpy.mockRestore();
			serverSpy.mockRestore();
		}
	});

	it("resource-scopes real workspace mutations and rename rollback in an unrestricted invocation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-resources-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const reference = path.join(root, "reference.ts");
		const missing = path.join(root, "missing.ts");
		await fs.writeFile(reference, "old\n");
		const identity = await fs.lstat(reference, { bigint: true });
		const records: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource") records.push(record);
		});
		const rollbackOutcome = await runFilesystemOperation(manager, "filesystem:rollback", () =>
			scope.withOperationLease("filesystem:rollback", operation =>
				applyEditsThenRename(
					[
						{
							filePath: reference,
							edits: [
								{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" },
							],
						},
					],
					missing,
					path.join(root, "dest.ts"),
					operation,
				),
			),
		).then(
			value => ({ status: "fulfilled" as const, value }),
			reason => ({ status: "rejected" as const, reason }),
		);
		if (rollbackOutcome.status !== "rejected") throw new Error("Expected rollback to reject.");
		expect(() => {
			throw rollbackOutcome.reason;
		}).toThrow();
		expect(await fs.readFile(reference, "utf8")).toBe("old\n");
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId: "filesystem:rollback",
			canonicalTarget: reference,
			identity,
		});
		expect(
			records.filter(
				record => record.kind === "resource" && record.targetHash === targetHash && record.phase === "completed",
			).length,
		).toBeGreaterThanOrEqual(3);
		await runFilesystemOperation(manager, "filesystem:workspace", () =>
			scope.withOperationLease("filesystem:workspace", operation =>
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "create", uri: fileToUri(path.join(root, "created.ts")) },
							{ kind: "rename", oldUri: fileToUri(reference), newUri: fileToUri(path.join(root, "renamed.ts")) },
							{ kind: "delete", uri: fileToUri(path.join(root, "created.ts")) },
						],
					},
					root,
					undefined,
					{ operation, authorizePath: async () => {} },
				),
			),
		);
		expect(await fs.readFile(path.join(root, "renamed.ts"), "utf8")).toBe("old\n");
		await expect(fs.lstat(reference)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.lstat(path.join(root, "created.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(records).toContainEqual(
			expect.objectContaining({ operationId: "filesystem:workspace", phase: "completed" }),
		);
	});

	it("durably authorizes each ordinary text directory and file before mutation, then waits for completion", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-text-effect-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const parent = path.join(root, "nested");
		const target = path.join(parent, "note.txt");
		const operationId = "filesystem:text-resource-order";
		const parentHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: parent,
		});
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: target,
		});
		const parentEffect = Promise.withResolvers<void>();
		const releaseParent = Promise.withResolvers<void>();
		const fileEffect = Promise.withResolvers<void>();
		const releaseFile = Promise.withResolvers<void>();
		const fileCompletion = Promise.withResolvers<void>();
		const releaseCompletion = Promise.withResolvers<void>();
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind !== "resource") return;
			if (record.phase === "effect" && record.targetHash === parentHash) {
				parentEffect.resolve();
				await releaseParent.promise;
			}
			if (record.phase === "effect" && record.targetHash === targetHash) {
				fileEffect.resolve();
				await releaseFile.promise;
			}
			if (record.phase === "completed" && record.targetHash === targetHash) {
				fileCompletion.resolve();
				await releaseCompletion.promise;
			}
		});
		const tool = createWriteTool(root, scope);
		const pending = executeWrite(manager, scope, tool, operationId, "filesystem", target, "authorized text");
		const settled = Promise.withResolvers<void>();
		void pending.then(
			() => settled.resolve(),
			() => settled.resolve(),
		);
		const firstBoundary = await Promise.race([
			parentEffect.promise.then(() => "authorized"),
			settled.promise.then(() => "settled"),
		]);
		expect(firstBoundary).toBe("authorized");
		await expect(fs.lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
		releaseParent.resolve();

		const secondBoundary = await Promise.race([
			fileEffect.promise.then(() => "authorized"),
			settled.promise.then(() => "settled"),
		]);
		expect(secondBoundary).toBe("authorized");
		expect((await fs.stat(parent)).isDirectory()).toBe(true);
		await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
		releaseFile.resolve();

		const completionBoundary = await Promise.race([
			fileCompletion.promise.then(() => "committing"),
			settled.promise.then(() => "settled"),
		]);
		expect(completionBoundary).toBe("committing");
		expect(await fs.readFile(target, "utf8")).toBe("authorized text");
		let operationSettled = false;
		void pending.then(
			() => {
				operationSettled = true;
			},
			() => {
				operationSettled = true;
			},
		);
		await Promise.resolve();
		expect(operationSettled).toBe(false);
		releaseCompletion.resolve();
		const result = await pending;
		expect(result).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
		});
		expect((await store.getResource("Worker", 1, `${operationId}:resource:1`))?.record.phase).toBe("completed");
		expect((await store.getResource("Worker", 1, `${operationId}:resource:2`))?.record.phase).toBe("completed");
	});

	it("revalidates cancellation after resource authorization before opening a file", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-resource-cancel-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "cancelled.txt");
		const operationId = "filesystem:resource-authorization-cancel";
		const targetHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: target,
		});
		const effectStarted = Promise.withResolvers<void>();
		const releaseEffect = Promise.withResolvers<void>();
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "effect" && record.targetHash === targetHash) {
				effectStarted.resolve();
				await releaseEffect.promise;
			}
		});
		const controller = new AbortController();
		const pending = runFilesystemOperation(
			manager,
			operationId,
			() =>
				scope.withOperationLease(operationId, async operation => {
					const authorized = await operation.authorize(target, "create");
					await operation.writeFile(authorized, "must not be created after cancellation");
				}),
			controller.signal,
		);
		let rootClosed = false;
		try {
			await effectStarted.promise;
			await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
			controller.abort(new Error("cancelled while resource authorization was pending"));
			const closing = store.close().then(() => {
				rootClosed = true;
			});
			await Promise.resolve();
			expect(rootClosed).toBe(false);
			releaseEffect.resolve();
			await assert.rejects(pending, /cancelled/i);
			await closing;
			expect(rootClosed).toBe(true);
			expect(await fs.lstat(target).catch(() => undefined)).toBeUndefined();
		} finally {
			releaseEffect.resolve();
			await pending.catch(() => undefined);
		}
	});

	it("keeps a real bridge write inside the operation and authority drain after cancellation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-drain-effect-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		let completedResource: DurableRegistryRecord | undefined;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "completed") completedResource = record;
		});
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "bridge.txt");
		const bridgeStarted = Promise.withResolvers<void>();
		const releaseBridge = Promise.withResolvers<void>();
		const bridge = {
			capabilities: { writeTextFile: true },
			async writeTextFile(request: { path: string; content: string }): Promise<void> {
				bridgeStarted.resolve();
				await releaseBridge.promise;
				await fs.writeFile(request.path, request.content, "utf8");
			},
		};
		const tool = createWriteTool(root, scope, undefined, bridge);
		const controller = new AbortController();
		const operationId = "filesystem:bridge-abort-drain";
		let operationSettled = false;
		let authorityClosed = false;
		const operation = executeWrite(
			manager,
			scope,
			tool,
			operationId,
			"filesystem",
			target,
			"bridge bytes",
			controller.signal,
		);
		const observedOperation = operation.then(
			() => {
				operationSettled = true;
			},
			() => {
				operationSettled = true;
			},
		);
		await bridgeStarted.promise;
		const closing = store.close().then(() => {
			authorityClosed = true;
		});
		controller.abort(new Error("cancelled during bridge write"));
		await Promise.resolve();
		expect(operationSettled).toBe(false);
		expect(authorityClosed).toBe(false);
		await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
		releaseBridge.resolve();
		await assert.rejects(operation, /cancelled/i);
		await observedOperation;
		await closing;
		expect(authorityClosed).toBe(true);
		expect(await fs.readFile(target, "utf8")).toBe("bridge bytes");
		expect(completedResource).toMatchObject({ resourceClass: "filesystem", phase: "completed" });
	});

	it("does not swallow an ACP verification read's durable close failure or replay its write", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-read-close-"));
		directories.push(directory);
		const store = await createAuthorityStore(directory);
		const { manager, scope } = await createOperationContext(store, directory);
		const target = path.join(directory, "acp.txt");
		const failure = new Error("verification read terminal failed");
		let effects = 0;
		let writes = 0;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind !== "resource") return;
			if (record.phase === "effect") effects++;
			if (effects === 2 && record.phase === "completed") throw failure;
		});
		const tool = createWriteTool(directory, scope, undefined, {
			capabilities: { writeTextFile: true },
			writeTextFile: async request => {
				writes++;
				await fs.writeFile(request.path, request.content);
			},
		});
		await assert.rejects(
			executeWrite(manager, scope, tool, "filesystem:acp-verification", "filesystem", target, "actual bytes"),
			error => error === failure,
		);
		expect(writes).toBe(1);
		expect(effects).toBe(2);
		expect(await fs.readFile(target, "utf8")).toBe("actual bytes");
	});

	it("authorizes a SQLite database mutation before the real row update", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-sqlite-effect-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const databasePath = path.join(root, "data.sqlite");
		const observer = new Database(databasePath);
		observer.run("PRAGMA journal_mode = WAL");
		observer.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
		observer.prepare("INSERT INTO entries (id, value) VALUES (1, ?)").run("before");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const operationId = "filesystem:sqlite-resource-order";
		const stat = await fs.lstat(databasePath, { bigint: true });
		const databaseHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId,
			canonicalTarget: databasePath,
			identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode },
		});
		const databaseEffect = Promise.withResolvers<void>();
		const releaseEffect = Promise.withResolvers<void>();
		let mutationResourceId: string | undefined;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (
				record.kind === "resource" &&
				record.resourceClass === "sqlite" &&
				record.phase === "effect" &&
				record.targetHash === databaseHash
			) {
				mutationResourceId = record.resourceId;
				databaseEffect.resolve();
				await releaseEffect.promise;
			}
		});
		const tool = createWriteTool(root, scope);
		const pending = executeWrite(
			manager,
			scope,
			tool,
			operationId,
			"filesystem",
			`${databasePath}:entries:1`,
			"{ value: 'after' }",
		);
		const settled = Promise.withResolvers<void>();
		void pending.then(
			() => settled.resolve(),
			() => settled.resolve(),
		);
		try {
			const boundary = await Promise.race([
				databaseEffect.promise.then(() => "authorized"),
				settled.promise.then(() => "settled"),
			]);
			expect(boundary).toBe("authorized");
			expect(observer.prepare("SELECT value FROM entries WHERE id = 1").get()).toEqual({ value: "before" });
			releaseEffect.resolve();
			await pending;
			expect(observer.prepare("SELECT value FROM entries WHERE id = 1").get()).toEqual({ value: "after" });
			const resourceId = mutationResourceId;
			if (!resourceId) throw new Error("SQLite mutation resource was not admitted.");
			expect((await store.getResource("Worker", 1, resourceId))?.record).toMatchObject({
				resourceClass: "sqlite",
				targetHash: databaseHash,
				phase: "completed",
			});
		} finally {
			releaseEffect.resolve();
			observer.close();
		}
	});

	it("preserves local writethrough results and validates the actual predecessor across filenames", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-local-effects-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const localState = new DurableLocalState(store, "root");
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => root,
			getSessionId: () => "root",
			getPathScope: () => scope,
			getDurableLocalState: () => localState,
		};
		const tool = createWriteTool(root, scope, localProtocolOptions);
		const localRoot = path.join(root, "local");
		const firstPath = path.join(localRoot, "first.md");
		const secondPath = path.join(localRoot, "second.md");
		const firstOperationId = "local:publication-first";
		const localRootHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId: firstOperationId,
			canonicalTarget: localRoot,
		});
		const firstFileHash = durableTargetHash({
			actorId: "Worker",
			generation: 1,
			operationId: firstOperationId,
			canonicalTarget: firstPath,
		});
		const directoryEffect = Promise.withResolvers<void>();
		const releaseDirectory = Promise.withResolvers<void>();
		const fileEffect = Promise.withResolvers<void>();
		const releaseFile = Promise.withResolvers<void>();
		const predecessorReads: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.operationId === "local:publication-second")
				predecessorReads.push(record);
			if (record.kind !== "resource" || record.phase !== "effect") return;
			if (record.targetHash === localRootHash) {
				directoryEffect.resolve();
				await releaseDirectory.promise;
			}
			if (record.targetHash === firstFileHash) {
				fileEffect.resolve();
				await releaseFile.promise;
			}
		});

		const firstPending = executeWrite(
			manager,
			scope,
			tool,
			firstOperationId,
			"local",
			"local://first.md",
			"first local bytes",
		);
		const firstSettled = Promise.withResolvers<void>();
		void firstPending.then(
			() => firstSettled.resolve(),
			() => firstSettled.resolve(),
		);
		const directoryBoundary = await Promise.race([
			directoryEffect.promise.then(() => "authorized"),
			firstSettled.promise.then(() => "settled"),
		]);
		expect(directoryBoundary).toBe("authorized");
		await expect(fs.lstat(localRoot)).rejects.toMatchObject({ code: "ENOENT" });
		releaseDirectory.resolve();
		const fileBoundary = await Promise.race([
			fileEffect.promise.then(() => "authorized"),
			firstSettled.promise.then(() => "settled"),
		]);
		expect(fileBoundary).toBe("authorized");
		expect((await fs.stat(localRoot)).isDirectory()).toBe(true);
		await expect(fs.lstat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
		releaseFile.resolve();

		const firstResult = await firstPending;
		expect(firstResult).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
		});
		const secondResult = await executeWrite(
			manager,
			scope,
			tool,
			"local:publication-second",
			"local",
			"local://second.md",
			"second local bytes",
		);
		expect(secondResult).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
		});
		expect(await fs.readFile(firstPath, "utf8")).toBe("first local bytes");
		expect(await fs.readFile(secondPath, "utf8")).toBe("second local bytes");
		expect(await store.localBacking("root")).toMatchObject({
			entryId: canonicalDurableSha256({ localId: "root", url: "local://second.md" }),
			entryHash: durableBackingSha256("second local bytes"),
		});
		for (const target of [localRoot, firstPath]) {
			const identity = await fs.lstat(target, { bigint: true });
			const targetHash = durableTargetHash({
				actorId: "Worker",
				generation: 1,
				operationId: "local:publication-second",
				canonicalTarget: target,
				identity,
			});
			expect(predecessorReads).toContainEqual(
				expect.objectContaining({ kind: "resource", targetHash, phase: "completed" }),
			);
		}
		expect((await store.getResource("Worker", 1, `${firstOperationId}:resource:1`))?.record.phase).toBe("completed");
		expect((await store.getResource("Worker", 1, `${firstOperationId}:resource:2`))?.record.phase).toBe("completed");
		expect(await store.getResource("Worker", 1, `${firstOperationId}:resource:3`)).toMatchObject({
			record: { resourceClass: "filesystem", phase: "completed" },
		});
	});

	it("preserves unknown write authorization when parent close also fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-write-parent-close-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const target = path.join(root, "write.txt");
		await fs.writeFile(target, "original bytes");
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const operationId = "filesystem:write-authorization-parent-close";
		const unknown = new AuthorityRpcError("resource effect acknowledgement lost", "write-effect-request", true);
		const closeFailure = new Error("write parent close failed");
		const closeStarted = Promise.withResolvers<void>();
		const releaseClose = Promise.withResolvers<void>();
		let interceptParent = false;
		let parentCloses = 0;
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.operationId === operationId && record.phase === "effect")
				throw unknown;
		});
		const open = nodeFs.promises.open;
		const spy = vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (
				interceptParent &&
				args[0] === root &&
				args[1] === (nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY)
			) {
				interceptParent = false;
				const close = handle.close.bind(handle);
				handle.close = async () => {
					parentCloses++;
					await close();
					closeStarted.resolve();
					await releaseClose.promise;
					throw closeFailure;
				};
			}
			return handle;
		});
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async operation => {
				const authorized = await operation.authorize(target, "write");
				interceptParent = true;
				await operation.writeFile(authorized, "replacement bytes");
			}),
		);
		const outcome = pending.then(
			() => undefined,
			error => error,
		);
		try {
			const boundary = await Promise.race([closeStarted.promise.then(() => "close"), outcome.then(() => "settled")]);
			expect(boundary).toBe("close");
			let settled = false;
			void outcome.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(await fs.readFile(target, "utf8")).toBe("original bytes");
			releaseClose.resolve();
			const failure: unknown = await outcome;
			expect(failure).toBeInstanceOf(AggregateError);
			expect(errorConstituents(failure)).toEqual(expect.arrayContaining([unknown, closeFailure]));
			expect(unknown).toMatchObject({ unknownOutcome: true, requestId: "write-effect-request" });
			expect(parentCloses).toBe(1);
			expect(await fs.readFile(target, "utf8")).toBe("original bytes");
			const terminal = getOperationTerminal(manager, operationId);
			expect(terminal).toMatchObject({
				status: "abandoned",
				detail: "Authority outcome is unknown; durable terminal state was not asserted.",
			});
			if (!terminal) throw new Error("Missing operation disposition");
			expect((await store.getOperation(terminal.ownerId, "filesystem", operationId))?.record.phase).toBe("effect");
			expect((await store.getResource("Worker", 1, `${operationId}:resource:1`))?.record.phase).toBe("effect");
		} finally {
			releaseClose.resolve();
			await outcome;
			spy.mockRestore();
		}
	});

	it("shares one pending close promise across concurrent durable read close callers", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-read-close-race-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "read.txt");
		await fs.writeFile(target, "read bytes");
		const operationId = "filesystem:read-close-race";
		const completionStarted = Promise.withResolvers<void>();
		const releaseCompletion = Promise.withResolvers<void>();
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "completed") {
				completionStarted.resolve();
				await releaseCompletion.promise;
			}
		});
		const closes = Promise.withResolvers<{
			handle: { close(): Promise<void> };
			first: Promise<void>;
			second: Promise<void>;
		}>();
		const operation = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async filesystemOperation => {
				const targetProof = await filesystemOperation.authorize(target, "read");
				const handle = await filesystemOperation.openRead(targetProof);
				const first = handle.close();
				const second = handle.close();
				closes.resolve({ handle, first, second });
				await first;
				return "closed";
			}),
		);
		try {
			const { handle, first, second } = await closes.promise;
			const third = handle.close();
			expect(second).toBe(first);
			expect(third).toBe(first);
			await completionStarted.promise;
			let closeSettled = false;
			void first.then(
				() => {
					closeSettled = true;
				},
				() => {
					closeSettled = true;
				},
			);
			await Promise.resolve();
			expect(closeSettled).toBe(false);
			releaseCompletion.resolve();
			await Promise.all([first, second, third]);
			expect(await operation).toBe("closed");
			expect(await store.getResource("Worker", 1, `${operationId}:resource:1`)).toMatchObject({
				record: { phase: "completed" },
			});
		} finally {
			releaseCompletion.resolve();
			await operation.catch(() => undefined);
		}
	});

	it("shares a durable read close failure with every repeated caller", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-read-close-failure-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "read.txt");
		await fs.writeFile(target, "read bytes");
		const operationId = "filesystem:read-close-failure";
		const closeFailure = new Error("durable read close acknowledgement failed");
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "completed") throw closeFailure;
		});
		const closes = Promise.withResolvers<{
			handle: { close(): Promise<void> };
			first: Promise<void>;
			second: Promise<void>;
		}>();
		const operation = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async filesystemOperation => {
				const targetProof = await filesystemOperation.authorize(target, "read");
				const handle = await filesystemOperation.openRead(targetProof);
				const first = handle.close();
				const second = handle.close();
				closes.resolve({ handle, first, second });
				await first;
				return "closed";
			}),
		);
		try {
			const { handle, first, second } = await closes.promise;
			const third = handle.close();
			expect(second).toBe(first);
			expect(third).toBe(first);
			await assert.rejects(first, error => error === closeFailure);
			await assert.rejects(second, error => error === closeFailure);
			await assert.rejects(third, error => error === closeFailure);
			await assert.rejects(operation, error => error === closeFailure);
			expect(await store.getResource("Worker", 1, `${operationId}:resource:1`)).toMatchObject({
				record: { phase: "completed" },
			});
		} finally {
			await operation.catch(() => undefined);
		}
	});

	it("rejects stale success after terminal acknowledgement without discarding committed evidence", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-terminal-race-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		let authorityCurrent = true;
		const { manager } = await createOperationContext(store, root, () => authorityCurrent);
		const terminalAck = Promise.withResolvers<void>();
		const releaseTerminalAck = Promise.withResolvers<void>();
		const persisted: DurableRegistryRecord[] = [];
		holdCommittedTransitionAcknowledgements(store, async record => {
			persisted.push(record);
			if (record.kind === "operation" && record.phase === "completed") {
				terminalAck.resolve();
				await releaseTerminalAck.promise;
			}
		});
		const operationId = "filesystem:terminal-authority-race";
		let callbacks = 0;
		const pending = runFilesystemOperation(manager, operationId, async () => {
			callbacks++;
			return "effect completed";
		});
		await terminalAck.promise;
		authorityCurrent = false;
		releaseTerminalAck.resolve();
		await assert.rejects(pending, /stale|authority/i);
		expect(callbacks).toBe(1);
		expect(persisted.filter(record => record.kind === "operation").map(record => record.phase)).toEqual([
			"intent",
			"effect",
			"committed",
			"completed",
		]);
		const terminal = getOperationTerminal(manager, operationId);
		expect(terminal?.status).toBe("completed");
		if (!terminal) throw new Error("Operation terminal evidence was not retained.");
		expect(await store.getOperation(terminal.ownerId, "filesystem", operationId)).toMatchObject({
			record: { phase: "completed" },
		});
	});

	it("makes every read-handle close caller share the same durable failure", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-read-close-"));
		directories.push(directory);
		const root = await fs.realpath(directory);
		const store = await createAuthorityStore(root);
		const { manager, scope } = await createOperationContext(store, root);
		const target = path.join(root, "read.txt");
		await fs.writeFile(target, "read bytes", "utf8");
		const completionStarted = Promise.withResolvers<void>();
		const releaseCompletion = Promise.withResolvers<void>();
		const failure = new Error("durable close acknowledgement failed");
		holdCommittedTransitionAcknowledgements(store, async record => {
			if (record.kind === "resource" && record.phase === "completed") {
				completionStarted.resolve();
				await releaseCompletion.promise;
				throw failure;
			}
		});
		const handleReady = Promise.withResolvers<{ close(): Promise<void> }>();
		const closeCallsReady = Promise.withResolvers<readonly [Promise<void>, Promise<void>]>();
		const operationId = "filesystem:read-close-shared";
		const pending = runFilesystemOperation(manager, operationId, () =>
			scope.withOperationLease(operationId, async operation => {
				const authorized = await operation.authorize(target, "read");
				const handle = await operation.openRead(authorized);
				handleReady.resolve(handle);
				const closeCalls = [handle.close(), handle.close()] as const;
				closeCallsReady.resolve(closeCalls);
				await Promise.all(closeCalls);
				return "closed";
			}),
		);
		let settledCloseCalls = 0;
		const handle = await handleReady.promise;
		const [firstClose, secondClose] = await closeCallsReady.promise;
		const firstResult = firstClose.then(
			() => {
				settledCloseCalls++;
				return undefined;
			},
			error => {
				settledCloseCalls++;
				return error;
			},
		);
		const secondResult = secondClose.then(
			() => {
				settledCloseCalls++;
				return undefined;
			},
			error => {
				settledCloseCalls++;
				return error;
			},
		);
		try {
			await completionStarted.promise;
			const thirdResult = handle.close().then(
				() => {
					settledCloseCalls++;
					return undefined;
				},
				error => {
					settledCloseCalls++;
					return error;
				},
			);
			await Promise.resolve();
			expect(settledCloseCalls).toBe(0);
			releaseCompletion.resolve();
			await assert.rejects(pending, /durable close acknowledgement failed/);
			const results = await Promise.all([firstResult, secondResult, thirdResult]);
			expect(results).toEqual([failure, failure, failure]);
		} finally {
			releaseCompletion.resolve();
			await pending.catch(() => undefined);
		}
	});
});
