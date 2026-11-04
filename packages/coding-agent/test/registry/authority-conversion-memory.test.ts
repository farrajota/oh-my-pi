import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registryDurableStateForSession } from "../../src/registry/authority";
import { readAuthorityDescriptor } from "../../src/registry/authority/descriptor";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import { listJsonlRotationArtifacts } from "../../src/registry/authority/jsonl-layout";
import { authorityPaths } from "../../src/registry/authority/ownership";
import { openAuthorityPersistence } from "../../src/registry/authority/persistence";
import type { AuthorityExport, AuthorityIdentity } from "../../src/registry/authority/types";
import type { DurableRegistryRecord } from "../../src/registry/durable-state";
import { SessionManager } from "../../src/session/session-manager";

// An offline conversion must hold memory bounded independently of the history it converts: the production
// conversion of a 1M-row history used to run out of memory because it materialized the whole export (several
// times over). Each conversion here runs in a fresh process that reports its kernel peak RSS, at two history
// sizes four times apart; the peak growth may not follow the history.

const directories: string[] = [];
const PEAK_SCRIPT = path.join(import.meta.dir, "fixtures", "authority-conversion-peak.ts");
// Each size builds a multi-MiB history and converts it three times, verifying it in full every time.
const MEMORY_TEST_TIMEOUT_MS = 600_000;
const SMALL_BATCHES = 80;
const LARGE_BATCHES = 4 * SMALL_BATCHES;
// The peaks of a bounded conversion differ between the sizes only by garbage-collector slack (measured up to about
// 50 MiB, at either size: it does not follow the history), while holding the export adds 300 MiB or more at LARGE.
const PEAK_GROWTH_MARGIN_KIB = 128 * 1024;

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function selected(file: string): Promise<{ readonly payload: string; readonly identity: AuthorityIdentity }> {
	const descriptor = await readAuthorityDescriptor(file);
	if (!descriptor) throw new Error("Expected a selected authority descriptor.");
	return {
		payload: path.join(path.dirname(file), descriptor.payload),
		identity: {
			backend: descriptor.backend,
			owningSessionId: descriptor.owningSessionId,
			incarnation: descriptor.incarnation,
			format: 2,
		},
	};
}

async function offlineState(file: string): Promise<Omit<AuthorityExport, "sourceIdentity">> {
	const { payload, identity } = await selected(file);
	const driver = openAuthorityPersistence({ path: payload, identity, create: false });
	try {
		driver.integrityCheck();
		const { sourceIdentity: _identity, ...state } = driver.exportState();
		return state;
	} finally {
		driver.close();
	}
}

/** A selected JSONL root holding `batches` frames of 50 terminal operations each, written by an offline owner (so it rotates natively). */
async function historySession(batches: number): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-convert-memory-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage({ role: "user", content: "conversion memory fixture", timestamp: 1 });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Fixture did not create a transcript.");
	const store = await registryDurableStateForSession(file, {
		owningSessionId: manager.getSessionId(),
		backend: "jsonl",
		create: true,
	});
	await store.close();
	await manager.close();
	const { payload, identity } = await selected(file);
	const engine = new AuthorityEngine(
		new JsonlAuthorityPersistence({ path: payload, identity, create: false }),
		"memory-owner",
	);
	engine.recover();
	for (let batch = 0; batch < batches; batch++) {
		const records: DurableRegistryRecord[] = [];
		for (let index = 0; index < 50; index++) {
			const operation = {
				kind: "operation" as const,
				at: 10,
				operationId: `op-${batch}-${index}-${"p".repeat(160)}`,
				effectClass: "eval" as const,
				ownerId: "actor-1",
				classOwnerId: "root-1",
				actorId: "actor-1",
				rootId: "root-1",
				generation: 1,
				acquiredAt: 10,
				expiresAt: 100,
			};
			records.push({ ...operation, phase: "intent" }, { ...operation, phase: "abandoned" });
		}
		engine.transitionBatch(records, { requestId: `memory-${batch}` });
	}
	engine.close();
	return file;
}

/** Converts in a fresh process and returns its peak RSS above its resident set just before the conversion. */
async function convertMeasured(file: string, target: "jsonl" | "sqlite"): Promise<number> {
	// --smol collects eagerly: without it the heap grows to the same ~250 MiB lazy-GC ceiling at any history size
	// (the 1M-row conversion peaks there too), so the peak measured slack rather than what the conversion retains.
	const child = Bun.spawn([process.execPath, "--smol", PEAK_SCRIPT, file, target], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Conversion to ${target} failed (${exitCode}): ${stderr}`);
	const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
		status: string;
		beforeKiB: number;
		peakKiB: number;
	};
	expect(report.status).toBe("migrated");
	return report.peakKiB - report.beforeKiB;
}

describe("offline authority conversion memory", () => {
	it(
		"converts JSONL to SQLite, to rotated JSONL and back with a peak that does not grow with the history",
		async () => {
			const growth: Record<"toSqlite" | "toJsonl" | "backToSqlite", number[]> = {
				toSqlite: [],
				toJsonl: [],
				backToSqlite: [],
			};
			for (const batches of [SMALL_BATCHES, LARGE_BATCHES]) {
				const file = await historySession(batches);
				// Guard the fixture: the source rotated natively, so every reader path (sealed segments, snapshot) is exercised.
				expect(
					listJsonlRotationArtifacts(authorityPaths(file).jsonl).some(artifact => artifact.kind === "segment"),
				).toBe(true);
				const source = await offlineState(file);
				growth.toSqlite.push(await convertMeasured(file, "sqlite"));
				expect(await offlineState(file)).toEqual(source);
				growth.toJsonl.push(await convertMeasured(file, "jsonl"));
				// A converted long history starts rotated: its segment 0 is one line holding the whole seeded export.
				expect(
					listJsonlRotationArtifacts(authorityPaths(file).jsonl)
						.map(artifact => artifact.kind)
						.sort(),
				).toEqual(["index", "segment", "snapshot"]);
				expect(await offlineState(file)).toEqual(source);
				growth.backToSqlite.push(await convertMeasured(file, "sqlite"));
				expect(await offlineState(file)).toEqual(source);
			}
			// Reported per conversion, so a failure shows every measured growth.
			const differences = Object.entries(growth).map(([conversion, [small, large]]) => ({
				conversion,
				small,
				large,
				bounded: large! - small! < PEAK_GROWTH_MARGIN_KIB,
			}));
			expect(differences).toEqual(differences.map(difference => ({ ...difference, bounded: true })));
		},
		MEMORY_TEST_TIMEOUT_MS,
	);
});
