import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { AuthorityEngine, authorityKey } from "../../src/registry/authority/engine";
import { exportSqliteAuthorityV3, SqliteAuthorityPersistence } from "../../src/registry/authority/sqlite-driver";
import type { AuthorityIdentity, MutationReceipt } from "../../src/registry/authority/types";
import {
	canonicalDurableSha256,
	durableBackingSha256,
	durableGenesisHash,
	durableRootHeadHash,
} from "../../src/registry/durable-state";

interface EngineFixture {
	readonly identity: AuthorityIdentity;
	readonly sqliteSha256: string;
	readonly sqliteGzipBase64: string;
	readonly exportCanonicalSha256: string;
	readonly framesJsonSha256: string;
	readonly frameHashes: readonly string[];
	readonly headHash: string;
	readonly revision: number;
	readonly receipts: Record<"replayedAny" | "replayedPayload" | "localFirst", MutationReceipt> & {
		readonly missing: null;
	};
}

const directories: string[] = [];
const identity: AuthorityIdentity = {
	backend: "sqlite",
	owningSessionId: "v4-session",
	incarnation: "v4-incarnation",
	format: 2,
};

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function location(): Promise<{ directory: string; databasePath: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-v4-"));
	directories.push(directory);
	return { directory, databasePath: path.join(directory, "session.jsonl.authority.sqlite") };
}

async function engineFixture(): Promise<EngineFixture> {
	return (await Bun.file(
		path.join(import.meta.dir, "fixtures", "authority-sqlite-v3-engine.json"),
	).json()) as EngineFixture;
}

async function installV3(databasePath: string): Promise<{ fixture: EngineFixture; bytes: Buffer }> {
	const fixture = await engineFixture();
	const bytes = gunzipSync(Buffer.from(fixture.sqliteGzipBase64, "base64"));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sqliteSha256);
	await fs.writeFile(databasePath, bytes, { mode: 0o600 });
	return { fixture, bytes };
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function operation(operationId: string, phase: string, at = 1) {
	return {
		kind: "operation" as const,
		at,
		operationId,
		effectClass: "eval" as const,
		ownerId: "owner",
		classOwnerId: "owner:eval",
		acquiredAt: 1,
		expiresAt: 100_000,
		phase: phase as "intent",
	};
}

function activateRoot(engine: AuthorityEngine, rootId: string) {
	const startupHash = canonicalDurableSha256(`${rootId}-startup`);
	const provenanceHash = canonicalDurableSha256(`${rootId}-provenance`);
	const headHash = durableRootHeadHash({ rootId, generation: 1, actorId: rootId, startupHash, provenanceHash });
	const construction = {
		kind: "construction" as const,
		at: 1,
		rootId,
		actorId: rootId,
		generation: 1,
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
	const actor = {
		kind: "actor" as const,
		at: 4,
		actorId: rootId,
		rootId,
		generation: 1,
		rootGeneration: 1,
		rootHeadHash: headHash,
		startupHash,
		provenanceHash,
		state: "active" as const,
	};
	engine.activateAuthority(
		{
			root: { kind: "root", at: 4, rootId, generation: 1, headHash, state: "active" },
			actor,
			construction: { ...construction, at: 4, phase: "activated" },
			gate: { kind: "gate", at: 4, rootId, generation: 1, phase: "open" },
		},
		{ requestId: `${rootId}-activation` },
	);
	return actor;
}

function publishLocal(engine: AuthorityEngine, localId: string, count: number): string {
	let head = durableGenesisHash();
	for (let index = 0; index < count; index++) {
		const entryId = `entry-${index}`;
		const claim = engine.reserveLocal(
			{ localId, entryId, entryHash: durableBackingSha256(entryId), expectedHeadHash: head },
			{ requestId: `${localId}-${index}-claim` },
		);
		engine.authorizeLocalEffect(claim, { requestId: `${localId}-${index}-authorize` });
		head = engine.finalizeLocal({ ...claim, phase: "effect" }, "committed", {
			requestId: `${localId}-${index}-final`,
		}).headHash;
	}
	return head;
}

/** Batch-heavy history in the shape of the A9 builder: batched intents, terminal batches of 20, single lifecycles. */
function buildHistory(engine: AuthorityEngine): void {
	activateRoot(engine, "history-root");
	for (let batch = 0; batch < 12; batch++) {
		const records = Array.from({ length: 40 }, (_, index) =>
			operation(`toolu_${batch}_${String(index).padStart(3, "0")}_${"x".repeat(18)}`, "intent", 10 + batch),
		);
		engine.transitionBatch(records, { requestId: `batch-${batch}-intent` });
		for (let chunk = 0; chunk < records.length; chunk += 20)
			engine.transitionBatch(
				records
					.slice(chunk, chunk + 20)
					.map(record => ({ ...record, at: 11 + batch, phase: chunk ? "cancelled" : "abandoned" })),
				{ requestId: `batch-${batch}-terminal-${chunk}` },
			);
	}
	for (let index = 0; index < 20; index++) {
		const record = operation(`single_${index}_${"y".repeat(24)}`, "intent", 40);
		engine.transition(record, { requestId: `single-${index}-intent` });
		engine.transition({ ...record, at: 41, phase: "effect" }, { requestId: `single-${index}-effect` });
		engine.transition({ ...record, at: 42, phase: "completed" }, { requestId: `single-${index}-completed` });
	}
	publishLocal(engine, "history-local", 3);
}

describe("SQLite authority physical schema v4", () => {
	it("creates v4 stores with receipts in frame rows, no dictionary and compressed codec-v4 bodies", async () => {
		const { databasePath } = await location();
		const persistence = new SqliteAuthorityPersistence({ path: databasePath, identity, create: true });
		const engine = new AuthorityEngine(persistence, "creation-owner");
		engine.recover();
		buildHistory(engine);
		persistence.integrityCheck();
		engine.close();
		const database = new Database(databasePath, { readonly: true });
		try {
			expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
			expect(database.query("PRAGMA application_id").get()).toEqual({ application_id: 0x4f4d5042 });
			expect(
				database
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name",
					)
					.all()
					.map(row => row.name),
			).toEqual([
				"authority_actors",
				"authority_actors_by_root",
				"authority_actors_open",
				"authority_actors_root_current",
				"authority_constructions",
				"authority_constructions_open",
				"authority_controls",
				"authority_frames",
				"authority_frames_receipt",
				"authority_gates",
				"authority_gates_open",
				"authority_identity",
				"authority_legacy_source",
				"authority_local_entries",
				"authority_local_entries_match",
				"authority_local_entries_open",
				"authority_local_heads",
				"authority_local_heads_current",
				"authority_operations",
				"authority_operations_open",
				"authority_resources",
				"authority_resources_open",
				"authority_roots",
				"authority_roots_active",
				"authority_transitions",
				"authority_transitions_open",
			]);
			const bodies = database
				.query<{ codec: number; encoding: number; count: number }, []>(
					"SELECT unicode(substr(body, 1, 1)) AS codec, unicode(substr(body, 2, 1)) AS encoding, count(*) AS count FROM authority_frames GROUP BY 1, 2 ORDER BY 1, 2",
				)
				.all();
			expect(bodies.every(row => row.codec === 4)).toBe(true);
			// Every batch frame is large enough for zstd to win.
			expect(bodies.find(row => row.encoding === 1)?.count).toBeGreaterThanOrEqual(36);
		} finally {
			database.close();
		}
	});

	it("refuses a physical schema v3 store with the offline conversion command and leaves it untouched", async () => {
		const { directory, databasePath } = await location();
		const { fixture, bytes } = await installV3(databasePath);
		let failure: unknown;
		try {
			new SqliteAuthorityPersistence({ path: databasePath, identity: fixture.identity, create: false });
		} catch (error) {
			failure = error;
		}
		expect((failure as Error).message).toContain(`physical schema v3`);
		expect((failure as Error).message).toContain(
			`omp session authority ${path.join(directory, "session.jsonl")} --to sqlite --apply`,
		);
		expect((await fs.readFile(databasePath)).equals(bytes)).toBe(true);
		expect(await fs.stat(`${databasePath}-wal`).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(`${databasePath}-shm`).catch(() => undefined)).toBeUndefined();
	});

	it("refuses an unknown future physical schema version", async () => {
		const { databasePath } = await location();
		new SqliteAuthorityPersistence({ path: databasePath, identity, create: true }).close();
		const database = new Database(databasePath);
		try {
			database.exec("PRAGMA user_version=5");
		} finally {
			database.close();
		}
		expect(() => new SqliteAuthorityPersistence({ path: databasePath, identity, create: false })).toThrow(
			/unsupported physical schema version 5; this build supports only v4/,
		);
	});

	it("converts a v3 store to v4 with identical frame hashes, receipts and export", async () => {
		const { directory, databasePath } = await location();
		const { fixture } = await installV3(databasePath);
		const exported = exportSqliteAuthorityV3(databasePath, fixture.identity);
		// The v3 reader reproduces exactly what the v3 driver exported when the fixture was written.
		expect(canonicalDurableSha256(exported)).toBe(fixture.exportCanonicalSha256);
		const targetPath = path.join(directory, "converted.jsonl.authority.sqlite");
		const converted = new SqliteAuthorityPersistence({
			path: targetPath,
			identity: fixture.identity,
			create: true,
			seed: exported,
		});
		try {
			converted.integrityCheck();
			const state = converted.exportState();
			expect(state.frames.map(frame => frame.hash)).toEqual([...fixture.frameHashes]);
			expect(sha256(JSON.stringify(state.frames))).toBe(fixture.framesJsonSha256);
			expect(canonicalDurableSha256(state)).toBe(fixture.exportCanonicalSha256);
			expect({ revision: state.revision, headHash: state.headHash }).toEqual({
				revision: fixture.revision,
				headHash: fixture.headHash,
			});
			// Replay keeps the earlier choice among epochs that reused one request id: the lowest decimal-text epoch.
			expect(JSON.stringify(converted.findReceipt("replayed-request", fixture.identity.incarnation))).toBe(
				JSON.stringify(fixture.receipts.replayedAny),
			);
			expect(
				JSON.stringify(
					converted.findReceipt(
						"replayed-request",
						fixture.identity.incarnation,
						fixture.receipts.replayedPayload.payloadHash,
					),
				),
			).toBe(JSON.stringify(fixture.receipts.replayedPayload));
			expect(JSON.stringify(converted.findReceipt("local-first-final", fixture.identity.incarnation))).toBe(
				JSON.stringify(fixture.receipts.localFirst),
			);
			expect(converted.findReceipt("never-issued", fixture.identity.incarnation)).toBeUndefined();
		} finally {
			converted.close();
		}
		const reopened = new SqliteAuthorityPersistence({ path: targetPath, identity: fixture.identity, create: false });
		try {
			expect(sha256(JSON.stringify(reopened.exportState().frames))).toBe(fixture.framesJsonSha256);
		} finally {
			reopened.close();
		}
		expect((await fs.stat(targetPath)).size).toBeLessThan((await fs.stat(databasePath)).size / 2);
	});

	it("keeps CESU-8 order-key scans and cursors in JavaScript key order", async () => {
		const { databasePath } = await location();
		const persistence = new SqliteAuthorityPersistence({ path: databasePath, identity, create: true });
		const engine = new AuthorityEngine(persistence, "order-owner");
		engine.recover();
		const ids = ["op-a", "op-￿", "op-", "op-\u{1F600}", "op-퟿", "op-é", "op-\u0080"];
		for (const id of ids) engine.transition(operation(id, "intent"), { requestId: `order-${id}` });
		const expected = ids
			.map(id => authorityKey("operation", ["owner", "eval", id]))
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
		const seen: string[] = [];
		let after: string | undefined;
		for (;;) {
			const page = persistence.scan("operation", { openOnly: true, after, limit: 2 });
			seen.push(...page.rows.map(row => authorityKey("operation", ["owner", "eval", row.record.operationId])));
			if (!page.cursor) break;
			after = page.cursor;
		}
		expect(seen).toEqual(expected);
		// A cursor from an earlier domain admits every row; one from a later domain admits none.
		expect(persistence.scan("operation", { after: authorityKey("gate", ["z"]), limit: 100 }).rows).toHaveLength(
			ids.length,
		);
		expect(
			persistence.scan("operation", { after: authorityKey("resource", ["a", 1, "b"]), limit: 100 }).rows,
		).toEqual([]);
		expect(persistence.scan("operation", { after: '["operation"', limit: 100 }).rows).toHaveLength(ids.length);
		engine.close();
		persistence.close();
	});

	it("plans history-independent scans and replay through their indexes without full scans", async () => {
		const { databasePath } = await location();
		const persistence = new SqliteAuthorityPersistence({ path: databasePath, identity, create: true });
		const engine = new AuthorityEngine(persistence, "plan-owner");
		engine.recover();
		const actor = activateRoot(engine, "plan-root");
		const head = publishLocal(engine, "plan-local", 6);
		for (let index = 0; index < 30; index++)
			engine.transition(operation(`plan-${index}`, "intent"), { requestId: `plan-${index}` });
		engine.close();
		// A fresh connection prepares every statement again, so each one the reads below use is captured.
		const reader = new SqliteAuthorityPersistence({ path: databasePath, identity, create: false });
		const captured: { sql: string; database: Database }[] = [];
		const originalPrepare = Database.prototype.prepare;
		const originalQuery = Database.prototype.query;
		const capture = (original: typeof originalPrepare) =>
			function (this: Database, sql: string, ...rest: unknown[]) {
				captured.push({ sql, database: this });
				return Reflect.apply(original, this, [sql, ...rest]);
			};
		Database.prototype.prepare = capture(originalPrepare) as typeof originalPrepare;
		Database.prototype.query = capture(originalQuery as typeof originalPrepare) as typeof originalQuery;
		try {
			expect(
				reader.scan("local-entry", { localMatch: { localId: "plan-local", version: 6, headHash: head }, limit: 2 })
					.rows,
			).toHaveLength(1);
			expect(reader.scan("actor", { rootId: actor.rootId, rootGeneration: 1, limit: 10 }).rows).toHaveLength(1);
			expect(reader.scan("operation", { openOnly: true, limit: 10 }).rows).toHaveLength(10);
			expect(reader.scan("actor", { openOnly: true, limit: 10 }).rows).toHaveLength(1);
			expect(reader.findReceipt("plan-3", identity.incarnation)?.requestId).toBe("plan-3");
		} finally {
			Database.prototype.prepare = originalPrepare;
			Database.prototype.query = originalQuery;
		}
		const plan = (pattern: RegExp): string[] => {
			const statement = captured.find(entry => pattern.test(entry.sql));
			if (!statement) throw new Error(`No captured statement matches ${pattern}.`);
			return originalQuery
				.call(statement.database, `EXPLAIN QUERY PLAN ${statement.sql}`)
				.all()
				.map(row => (row as { detail: string }).detail);
		};
		const local = plan(/FROM authority_local_entries WHERE local_id = \?/);
		expect(local.join("\n")).toContain(
			"SEARCH authority_local_entries USING INDEX authority_local_entries_match (local_id=? AND version_key=? AND head_hash=?)",
		);
		expect(local.join("\n")).not.toMatch(/\bSCAN\b|TEMP B-TREE/);
		const actors = plan(/FROM authority_actors WHERE root_id = \?/);
		expect(actors.join("\n")).toMatch(/USING (COVERING )?INDEX authority_actors_by_root/);
		expect(actors.join("\n")).not.toMatch(/\bSCAN\b|TEMP B-TREE/);
		// The open-actor scan recovery and capacity run across every root must not walk terminal actor history.
		const openActors = plan(/FROM authority_actors WHERE state IN \('active', 'parked'\) ORDER BY/);
		expect(openActors.join("\n")).toContain("USING INDEX authority_actors_open");
		expect(openActors.join("\n")).not.toMatch(/SCAN authority_actors$|SCAN authority_actors\n|TEMP B-TREE/);
		const open = plan(/FROM authority_operations WHERE phase IN/);
		expect(open.join("\n")).toContain("authority_operations_open");
		expect(open.join("\n")).not.toMatch(/TEMP B-TREE/);
		const replay = plan(/FROM authority_frames WHERE incarnation = \? AND request_id = \? ORDER BY/);
		expect(replay.join("\n")).toContain("USING INDEX authority_frames_receipt (incarnation=? AND request_id=?)");
		expect(replay.join("\n")).not.toMatch(/\bSCAN\b/);
		reader.close();
	});

	it("stores a batch-heavy history within a bounded size per row and frame", async () => {
		const { databasePath } = await location();
		const persistence = new SqliteAuthorityPersistence({ path: databasePath, identity, create: true });
		const engine = new AuthorityEngine(persistence, "size-owner");
		engine.recover();
		buildHistory(engine);
		const state = persistence.exportState();
		engine.close();
		persistence.close();
		const database = new Database(databasePath, { readonly: true });
		let usedBytes: number;
		try {
			const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
			const free = database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count;
			usedBytes = (pages - free) * 4_096;
		} finally {
			database.close();
		}
		/*
		 * Bound: 25 B-tree roots (100 KiB) plus 1 KiB per current row (a ~300-byte record, its key, open-index
		 * entry and half-full pages) plus 2 KiB per frame (row columns, compact receipt and the zstd body of a
		 * 40-record batch, about 8:1 on JSON). Physical schema v3 stored this history's batch frames at about
		 * 19 KB each (A9 10k store: 29.4 MB for 1,036 frames), which exceeds the bound several times over.
		 */
		const bound = 25 * 4_096 + state.rows.length * 1_024 + state.frames.length * 2_048;
		expect(state.rows.length).toBeGreaterThan(500);
		expect(state.frames.length).toBeGreaterThan(100);
		expect(usedBytes).toBeLessThanOrEqual(bound);
	});

	it("rejects a corrupt stored frame body during export and integrity", async () => {
		const { databasePath } = await location();
		const persistence = new SqliteAuthorityPersistence({ path: databasePath, identity, create: true });
		const engine = new AuthorityEngine(persistence, "corrupt-owner");
		engine.recover();
		const records = Array.from({ length: 20 }, (_, index) => operation(`corrupt-${index}`, "intent"));
		engine.transitionBatch(records, { requestId: "corrupt-batch" });
		engine.close();
		persistence.close();
		const database = new Database(databasePath);
		let revision: number;
		try {
			const row = database
				.query<{ revision: number; body: Uint8Array }, []>(
					"SELECT revision, body FROM authority_frames WHERE unicode(substr(body, 2, 1)) = 1 LIMIT 1",
				)
				.get();
			if (!row) throw new Error("Expected a zstd-compressed frame body.");
			revision = row.revision;
			const body = Buffer.from(row.body);
			body[body.length - 8]! ^= 0x55;
			database.exec("DROP TRIGGER authority_frames_no_update");
			database.run("UPDATE authority_frames SET body = ? WHERE revision = ?", [body, revision]);
		} finally {
			database.close();
		}
		const reopened = new SqliteAuthorityPersistence({ path: databasePath, identity, create: false });
		try {
			expect(() => reopened.exportState()).toThrow(new RegExp(`frame body at revision ${revision} is corrupt`));
			expect(() => reopened.integrityCheck()).toThrow(
				/frame body at revision \d+ is corrupt|integrity check failed/,
			);
		} finally {
			reopened.close();
		}
	});
});
