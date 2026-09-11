import type { Database } from "bun:sqlite";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AuthorizedFilesystemTarget, DurableOpenResource } from "../internal/session-path-scope";
import type { ToolSession } from "../sdk";
import { DEFAULT_MAX_LINES, truncateHead } from "../session/streaming-output";
import { applyListLimit } from "./list-limit";
import { resolveReadPath } from "./path-utils";
import type { ReadToolDetails } from "./read";
import { prependSuffixResolutionNotice } from "./read-format";
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
import { ToolError, throwIfAborted } from "./tool-errors";
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

		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory() || !(await isSqliteFile(absolutePath))) continue;
			const authorized = await authorizeSqlitePath(session, absolutePath, true);
			return {
				absolutePath: authorized.absolutePath,
				sqliteSubPath: candidate.subPath,
				queryString: candidate.queryString,
				authorizedTargets: authorized.targets,
			};
		} catch (error) {
			if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;
			const suffixMatch = await findSuffixMatchCached(session, suffixCache, candidate.sqlitePath, signal);
			if (!suffixMatch) continue;

			try {
				const probe = await authorizeSqlitePath(session, suffixMatch.absolutePath, false);
				const retryStat = await Bun.file(probe.absolutePath).stat();
				if (retryStat.isDirectory() || !(await isSqliteFile(probe.absolutePath))) continue;
				const authorized = await authorizeSqlitePath(session, probe.absolutePath, true);
				return {
					absolutePath: authorized.absolutePath,
					sqliteSubPath: candidate.subPath,
					queryString: candidate.queryString,
					suffixResolution: { from: candidate.sqlitePath, to: suffixMatch.displayPath },
					authorizedTargets: authorized.targets,
				};
			} catch (retryError) {
				if (!isNotFoundError(retryError)) throw retryError;
			}
		}
	}

	return null;
}
export async function readSqlite(
	session: ToolSession,
	resolvedSqlitePath: ResolvedSqliteReadPath,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);

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
	let durableResource: DurableOpenResource | undefined;
	let result: AgentToolResult<ReadToolDetails> | undefined;
	let operationError: unknown;
	let operationFailed = false;
	try {
		if (session.pathScope && resolvedSqlitePath.authorizedTargets) {
			const operation = session.pathScope.currentOperation();
			for (const target of resolvedSqlitePath.authorizedTargets) await operation.verify(target);
		}
		if (session.pathScope && resolvedSqlitePath.authorizedTargets?.[0]) {
			durableResource = session.pathScope
				.currentOperation()
				.beginOpenResource(resolvedSqlitePath.authorizedTargets[0], "sqlite");
		}
		db = await openSqliteReadConnection(resolvedSqlitePath.absolutePath);
		durableResource?.effect();
		if (session.pathScope && resolvedSqlitePath.authorizedTargets) {
			const operation = session.pathScope.currentOperation();
			for (const target of resolvedSqlitePath.authorizedTargets) await operation.verify(target);
		}
		throwIfAborted(signal);

		switch (selector.kind) {
			case "list": {
				const listLimit = applyListLimit(listTables(db), { limit: 500 });
				const output = prependSuffixResolutionNotice(
					renderTableList(listLimit.items),
					resolvedSqlitePath.suffixResolution,
				);
				const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
				details.truncation = truncation.truncated ? truncation : undefined;
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
							}),
							resolvedSqlitePath.suffixResolution,
						),
					)
					.sourcePath(resolvedSqlitePath.absolutePath)
					.done();
				break;
			}
			case "raw": {
				const queryResult = executeReadQuery(db, selector.sql);
				let output = renderTable(queryResult.columns, queryResult.rows, {
					totalCount: queryResult.rows.length,
					offset: 0,
					limit: queryResult.rows.length || DEFAULT_MAX_LINES,
					table: "query",
					dbPath: resolvedSqlitePath.absolutePath,
				});
				if (queryResult.truncated) {
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

	if (db) {
		try {
			db.close();
			durableResource?.complete();
		} catch (error) {
			durableResource?.cancel();
			throw error;
		}
	} else {
		durableResource?.cancel();
	}
	if (operationFailed) {
		if (operationError instanceof ToolError) throw operationError;
		throw new ToolError(operationError instanceof Error ? operationError.message : String(operationError));
	}
	if (result === undefined) throw new ToolError("Unsupported SQLite selector");
	return result;
}
