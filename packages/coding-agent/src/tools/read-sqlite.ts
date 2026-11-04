import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AuthorizedFilesystemTarget } from "../internal/session-path-scope";
import type { ToolSession } from "../sdk";
import { DEFAULT_MAX_LINES, truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { applyListLimit } from "@oh-my-pi/pi-tui/tools/list-limit";
import { resolveReadPath } from "./path-utils";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { prependSuffixResolutionNotice, toReadTruncationStats } from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import {
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	getTableSchema,
	isSqliteFile,
	looksLikeSqlite,
	listTables,
	MAX_RAW_QUERY_ROWS,
	openSqliteReadConnection,
	parseSqlitePathCandidates,
	parseSqliteSelector,
	queryRows,
	renderRow,
	renderSchema,
	renderTable,
	renderTableList,
	resolveTableRowLookup,
} from "./sqlite-reader";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";

interface ResolvedSqliteReadPath {
	absolutePath: string;
	sqliteSubPath: string;
	queryString: string;
	suffixResolution?: { from: string; to: string };
	authorizedTargets?: readonly AuthorizedFilesystemTarget[];
}
async function authorizeSqlitePath(
	session: ToolSession,
	absolutePath: string,
	requireDatabase: boolean,
): Promise<{ absolutePath: string; targets?: readonly AuthorizedFilesystemTarget[] }> {
	if (!session.pathScope) return { absolutePath };
	const operation = session.pathScope.currentOperation();
	const probes = await operation.preflight([
		{ path: absolutePath, kind: "probe" },
		{ path: `${absolutePath}-wal`, kind: "probe" },
		{ path: `${absolutePath}-shm`, kind: "probe" },
	]);
	if (!requireDatabase) return { absolutePath: probes[0]!.canonicalTarget, targets: probes };
	const finalCandidates = probes.map((target, index) => ({
		path: target.canonicalTarget,
		kind: index === 0 || target.existed ? ("read" as const) : ("probe" as const),
	}));
	const targets = await operation.preflight(finalCandidates);
	return { absolutePath: targets[0]!.canonicalTarget, targets };
}

async function sniffSqlite(session: ToolSession, absolutePath: string): Promise<boolean> {
	if (!session.pathScope) return isSqliteFile(absolutePath);
	const operation = session.pathScope.currentOperation();
	const target = await operation.authorize(absolutePath, "read");
	const handle = await operation.openRead(target);
	let result: boolean;
	try {
		const header = Buffer.alloc(16);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		result = looksLikeSqlite(header.subarray(0, bytesRead));
	} catch (error) {
		try {
			await handle.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "SQLite header read and close failed.");
		}
		throw error;
	}
	await handle.close();
	return result;
}

export async function resolveSqliteReadPath(
	session: ToolSession,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedSqliteReadPath | null> {
	const candidates = parseSqlitePathCandidates(readPath);
	for (const candidate of candidates) {
		let absolutePath = resolveReadPath(candidate.sqlitePath, session.cwd);
		const initial = await authorizeSqlitePath(session, absolutePath, false);
		absolutePath = initial.absolutePath;

		let exists = false;
		try {
			const stat = await Bun.file(absolutePath).stat();
			exists = stat.isFile();
		} catch (error) {
			if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;
			const suffixMatch = await findSuffixMatchCached(session, suffixCache, candidate.sqlitePath, signal);
			if (!suffixMatch) continue;
			absolutePath = (await authorizeSqlitePath(session, suffixMatch.absolutePath, false)).absolutePath;
			try {
				exists = (await Bun.file(absolutePath).stat()).isFile();
			} catch (retryError) {
				if (isNotFoundError(retryError)) continue;
				throw retryError;
			}
			if (!exists || !(await sniffSqlite(session, absolutePath))) continue;
			const authorized = await authorizeSqlitePath(session, absolutePath, true);
			return {
				absolutePath: authorized.absolutePath,
				sqliteSubPath: candidate.subPath,
				queryString: candidate.queryString,
				suffixResolution: { from: candidate.sqlitePath, to: suffixMatch.displayPath },
				authorizedTargets: authorized.targets,
			};
		}
		if (!exists || !(await sniffSqlite(session, absolutePath))) continue;
		const authorized = await authorizeSqlitePath(session, absolutePath, true);
		return {
			absolutePath: authorized.absolutePath,
			sqliteSubPath: candidate.subPath,
			queryString: candidate.queryString,
			authorizedTargets: authorized.targets,
		};
	}

	return null;
}
export async function readSqlite(
	session: ToolSession,
	resolvedSqlitePath: ResolvedSqliteReadPath,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);
	if (session.pathScope && resolvedSqlitePath.authorizedTargets?.length !== 3) {
		throw new Error("Missing authorized filesystem targets for SQLite read");
	}

	const selectorInput = {
		subPath: resolvedSqlitePath.sqliteSubPath,
		queryString: resolvedSqlitePath.queryString,
	};
	const selector = parseSqliteSelector(selectorInput.subPath, selectorInput.queryString);
	const details: ReadToolDetails = {
		resolvedPath: resolvedSqlitePath.absolutePath,
		suffixResolution: resolvedSqlitePath.suffixResolution,
	};

	let db: Database | null = null;
	const inputHandles: fs.FileHandle[] = [];
	let snapshotDirectory: string | undefined;
	let result: AgentToolResult<ReadToolDetails> | undefined;
	let operationError: unknown;
	let operationFailed = false;
	try {
		let inputPath = resolvedSqlitePath.absolutePath;
		if (session.pathScope && resolvedSqlitePath.authorizedTargets) {
			const operation = session.pathScope.currentOperation();
			// SQLite discovers sidecars by basename and cannot consume our held descriptors.
			// Give it a private, stable copy of every admitted input, never the mutable source paths.
			const targets = resolvedSqlitePath.authorizedTargets;
			for (const target of targets) {
				if (target.existed) inputHandles.push(await operation.openRead(target, "sqlite"));
				else await operation.verify(target);
			}
			const before = await Promise.all(inputHandles.map(handle => handle.stat({ bigint: true })));
			snapshotDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-read-"));
			inputPath = path.join(snapshotDirectory, "input.sqlite");
			let index = 0;
			for (const [targetIndex, target] of targets.entries()) {
				if (!target.existed) continue;
				const handle = inputHandles[index++]!;
				const bytes = await handle.readFile();
				operation.assertActive();
				throwIfAborted(signal);
				await fs.writeFile(`${inputPath}${targetIndex === 0 ? "" : targetIndex === 1 ? "-wal" : "-shm"}`, bytes);
			}
			// Reject an in-place writer/checkpointer crossing the multi-file capture. WAL
			// remains a real WAL; readonly SQLite performs its normal recovery/read logic.
			for (const [index, handle] of inputHandles.entries()) {
				const after = await handle.stat({ bigint: true });
				const prior = before[index]!;
				if (prior.size !== after.size || prior.mtimeNs !== after.mtimeNs || prior.ctimeNs !== after.ctimeNs) {
					throw new Error("SQLite input changed during snapshot capture.");
				}
			}
			for (const target of targets) await operation.verify(target);
			operation.assertActive();
		}
		throwIfAborted(signal);
		db = await openSqliteReadConnection(inputPath);
		session.pathScope?.currentOperation().assertActive();
		throwIfAborted(signal);

		switch (selector.kind) {
			case "list": {
				const listLimit = applyListLimit(listTables(db), { limit: 500 });
				const output = prependSuffixResolutionNotice(
					renderTableList(listLimit.items),
					resolvedSqlitePath.suffixResolution,
				);
				const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
				details.truncation = truncation.truncated ? toReadTruncationStats(truncation) : undefined;
				const resultBuilder = toolResult<ReadToolDetails>(details)
					.text(truncation.content)
					.sourcePath(resolvedSqlitePath.absolutePath)
					.limits({ resultLimit: listLimit.meta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}
				result = resultBuilder.done();
				break;
			}
			case "schema": {
				const sampleRows = queryRows(db, selector.table, { limit: selector.sampleLimit, offset: 0 });
				let output = renderSchema(getTableSchema(db, selector.table), {
					columns: sampleRows.columns,
					rows: sampleRows.rows,
				});
				if (sampleRows.rows.length < sampleRows.totalCount) {
					const remaining = sampleRows.totalCount - sampleRows.rows.length;
					output += `\n[${remaining} more rows; append :${selector.table}?limit=20&offset=${sampleRows.rows.length} to the database path to continue]`;
				}
				result = toolResult<ReadToolDetails>(details)
					.text(prependSuffixResolutionNotice(output, resolvedSqlitePath.suffixResolution))
					.sourcePath(resolvedSqlitePath.absolutePath)
					.done();
				break;
			}
			case "row": {
				const lookup = resolveTableRowLookup(db, selector.table);
				const row =
					lookup.kind === "pk"
						? getRowByKey(db, selector.table, lookup, selector.key)
						: getRowByRowId(db, selector.table, selector.key);
				if (!row) {
					result = toolResult<ReadToolDetails>(details)
						.text(
							prependSuffixResolutionNotice(
								`No row found in table '${selector.table}' for key '${selector.key}'.`,
								resolvedSqlitePath.suffixResolution,
							),
						)
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
					break;
				}
				result = toolResult<ReadToolDetails>(details)
					.text(prependSuffixResolutionNotice(renderRow(row), resolvedSqlitePath.suffixResolution))
					.sourcePath(resolvedSqlitePath.absolutePath)
					.done();
				break;
			}
			case "query": {
				const page = queryRows(db, selector.table, selector);
				result = toolResult<ReadToolDetails>(details)
					.text(
						prependSuffixResolutionNotice(
							renderTable(page.columns, page.rows, {
								totalCount: page.totalCount,
								offset: selector.offset,
								limit: selector.limit,
								table: selector.table,
								dbPath: resolvedSqlitePath.absolutePath,
								where: selector.where,
								order: selector.order,
							}),
							resolvedSqlitePath.suffixResolution,
						),
					)
					.sourcePath(resolvedSqlitePath.absolutePath)
					.done();
				break;
			}
			case "raw": {
				const queryResult = executeReadQuery(db, selector.sql, selector.page);
				let output = renderTable(queryResult.columns, queryResult.rows, {
					totalCount: queryResult.rows.length,
					offset: 0,
					limit: queryResult.rows.length || DEFAULT_MAX_LINES,
					table: "query",
					dbPath: resolvedSqlitePath.absolutePath,
				});
				if (queryResult.truncated && selector.page) {
					const next = new URLSearchParams({
						q: selector.sql,
						limit: String(selector.page.limit),
						offset: String(selector.page.offset + queryResult.rows.length),
					});
					output += `\n[More rows; append ?${next} to the database path to continue]`;
				} else if (queryResult.truncated) {
					output += `\n[Output capped at ${MAX_RAW_QUERY_ROWS} rows; add a LIMIT/OFFSET clause to the query to page through more]`;
				}
				result = toolResult<ReadToolDetails>(details)
					.text(prependSuffixResolutionNotice(output, resolvedSqlitePath.suffixResolution))
					.sourcePath(resolvedSqlitePath.absolutePath)
					.done();
				break;
			}
		}

		if (result === undefined) throw new ToolError("Unsupported SQLite selector");
	} catch (error) {
		operationFailed = true;
		operationError = error;
	}

	const errors: unknown[] = operationFailed ? [operationError] : [];
	try {
		db?.close();
	} catch (error) {
		errors.push(error);
	}
	// Attempt every close even when another physical close or terminal ACK failed.
	for (const handle of inputHandles) {
		try {
			await handle.close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (snapshotDirectory) {
		try {
			await fs.rm(snapshotDirectory, { recursive: true, force: true });
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "SQLite read and input cleanup failed.");
	if (result === undefined) throw new ToolError("Unsupported SQLite selector");
	return result;
}
