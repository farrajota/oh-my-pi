import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncDrain, getDbBusyTimeoutMs, getHistoryDbPath, logger } from "@oh-my-pi/pi-utils";

/** A unique prompt with provenance from its most recent submission. */
export interface HistoryEntry {
	/** Stable row identifier used by the full-text index. */
	id: number;
	/** Trimmed prompt text, unique across the history database. */
	prompt: string;
	/** Unix timestamp of the most recent submission. */
	created_at: number;
	/** Project working directory of the most recent submission. */
	cwd?: string;
	/** Session ID of the most recent submission, if known. */
	sessionId?: string;
}

type HistoryRow = {
	id: number;
	prompt: string;
	created_at: number;
	cwd: string | null;
	session_id: string | null;
};

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

// Escape LIKE wildcards so user input is treated as literal text.
// Matches the `ESCAPE '\\'` clause used by substring-search statements.
function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

/** Stores searchable prompts with only their latest project and session metadata. */
export class HistoryStorage {
	#db: Database;
	static #instance?: HistoryStorage;
	#drain = new AsyncDrain<Pick<HistoryEntry, "prompt" | "cwd" | "sessionId">>(100);
	#sessionResolver?: () => string | undefined;

	// Prepared statements
	#upsertRowStmt: Statement;
	#recentStmt: Statement;
	#searchStmt: Statement;
	// Cache substring-fallback prepared statements keyed by token count.
	#substringStmts = new Map<number, Statement>();

	private constructor(dbPath: string) {
		this.#ensureDir(dbPath);

		this.#db = new Database(dbPath);

		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		// Headless hosts bound the wait so lock contention cannot freeze the
		// protocol loop for the full interactive timeout.
		this.#db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);

		const hadFts = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT,
	session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
		`);

		const needsMigration = this.#historySchemaNeedsMigration();
		if (needsMigration) {
			this.#migrateHistorySchema();
		}

		this.#db.run(`
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
		`);

		if (needsMigration || !hadFts) {
			try {
				this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
			} catch (error) {
				logger.warn("HistoryStorage FTS rebuild failed", { error: String(error) });
			}
		}

		this.#recentStmt = this.#db.prepare(
			"SELECT id, prompt, created_at, cwd, session_id FROM history ORDER BY created_at DESC, id DESC LIMIT ?",
		);
		this.#searchStmt = this.#db.prepare(
			"SELECT h.id, h.prompt, h.created_at, h.cwd, h.session_id FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ? ORDER BY h.created_at DESC, h.id DESC LIMIT ?",
		);
		this.#upsertRowStmt = this.#db.prepare(`
INSERT INTO history (prompt, created_at, cwd, session_id)
VALUES (?, ${SQLITE_NOW_EPOCH}, ?, ?)
ON CONFLICT(prompt) DO UPDATE SET
	created_at = excluded.created_at,
	cwd = excluded.cwd,
	session_id = excluded.session_id
		`);
	}

	/** Opens the process-wide prompt history database. */
	static open(dbPath: string = getHistoryDbPath()): HistoryStorage {
		if (!HistoryStorage.#instance) {
			HistoryStorage.#instance = new HistoryStorage(dbPath);
		}
		return HistoryStorage.#instance;
	}

	/** @internal Reset the singleton and close its database — test-only. */
	static resetInstance(): void {
		const instance = HistoryStorage.#instance;
		HistoryStorage.#instance = undefined;
		if (instance) instance.#close();
	}

	#close(): void {
		for (const stmt of this.#substringStmts.values()) stmt.finalize();
		this.#substringStmts.clear();
		this.#upsertRowStmt.finalize();
		this.#recentStmt.finalize();
		this.#searchStmt.finalize();
		this.#db.close();
	}

	#insertBatch(rows: Array<Pick<HistoryEntry, "prompt" | "cwd" | "sessionId">>): void {
		this.#db.transaction((rows: Array<Pick<HistoryEntry, "prompt" | "cwd" | "sessionId">>) => {
			for (const row of rows) {
				this.#upsertRowStmt.run(row.prompt, row.cwd ?? null, row.sessionId ?? null);
			}
		})(rows);
	}

	/**
	 * Register a resolver that supplies the current session ID for prompts added
	 * without an explicit `sessionId`. Evaluated synchronously at `add()` time so
	 * batched writes capture the session active when the prompt was submitted.
	 */
	setSessionResolver(resolver: () => string | undefined): void {
		this.#sessionResolver = resolver;
	}

	/** Stores a prompt and replaces its provenance with the latest submission. */
	add(prompt: string, cwd?: string, sessionId?: string): Promise<void> {
		const trimmed = prompt.trim();
		if (!trimmed) return Promise.resolve();
		const session = sessionId ?? this.#sessionResolver?.();
		return this.#drain.push({ prompt: trimmed, cwd: cwd ?? undefined, sessionId: session || undefined }, rows => {
			this.#insertBatch(rows);
		});
	}

	/** Returns unique prompts ordered by their most recent submission. */
	getRecent(limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		try {
			const rows = this.#recentStmt.all(safeLimit) as HistoryRow[];
			return rows.map(row => this.#toEntry(row));
		} catch (error) {
			logger.error("HistoryStorage getRecent failed", { error: String(error) });
			return [];
		}
	}

	/** Finds unique prompts matching every query token, newest first. */
	search(query: string, limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const tokens = this.#tokenize(query);
		if (tokens.length === 0) return [];

		// 1. FTS5 prefix match (token AND, prefix-wildcard per token).
		//    Handles punctuation by tokenizing query the same way unicode61 tokenizer
		//    indexed the stored text, so "git-commit" -> "git"* "commit"*.
		const ftsQuery = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" ");
		let ftsRows: HistoryRow[] = [];
		try {
			ftsRows = this.#searchStmt.all(ftsQuery, safeLimit) as HistoryRow[];
		} catch (error) {
			// Malformed FTS expression - fall through to substring path.
			logger.debug("HistoryStorage FTS query failed, using substring only", { error: String(error) });
		}

		// 2. Substring fallback (token-AND LIKE). Catches infix matches FTS5's
		//    prefix-only wildcard cannot reach (e.g. "mit" -> "commit"). Bounded
		//    by safeLimit, ordered by recency - no full-table load into JS.
		let subRows: HistoryRow[] = [];
		try {
			subRows = this.#searchSubstring(tokens, safeLimit);
		} catch (error) {
			logger.error("HistoryStorage substring search failed", { error: String(error) });
		}

		if (ftsRows.length === 0) {
			return subRows.map(row => this.#toEntry(row));
		}

		const rowsById = new Map<number, HistoryRow>();
		for (const row of ftsRows) {
			rowsById.set(row.id, row);
		}
		for (const row of subRows) {
			if (!rowsById.has(row.id)) rowsById.set(row.id, row);
		}

		return [...rowsById.values()]
			.sort((a, b) => b.created_at - a.created_at || b.id - a.id)
			.slice(0, safeLimit)
			.map(row => this.#toEntry(row));
	}

	/**
	 * IDs of the sessions whose stored prompts match `query`, ordered by prompt
	 * recency and de-duplicated. Used to augment session ranking in the resume
	 * picker with prompts that the 4KB session-list prefix never sees.
	 */
	matchingSessionIds(query: string, limit = 500): string[] {
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const entry of this.search(query, limit)) {
			const id = entry.sessionId;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
		return ids;
	}

	#ensureDir(dbPath: string): void {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });
	}

	#historySchemaUsesUnixEpoch(): boolean {
		const row = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history'").get() as
			| { sql?: string | null }
			| undefined;
		return row?.sql?.includes("unixepoch(") ?? false;
	}

	#historySchemaHasColumn(column: string): boolean {
		const columns = this.#db.prepare("PRAGMA table_info(history)").all() as Array<{ name: string }>;
		return columns.some(col => col.name === column);
	}

	#historyPromptIsUnique(): boolean {
		const row = this.#db
			.prepare(`
SELECT 1 AS present
FROM pragma_index_list('history') AS indexes
WHERE indexes."unique" = 1
	AND indexes.partial = 0
	AND (SELECT COUNT(*) FROM pragma_index_info(indexes.name)) = 1
	AND (SELECT name FROM pragma_index_info(indexes.name) LIMIT 1) = 'prompt'
LIMIT 1
			`)
			.get() as { present?: number } | undefined;
		return row?.present === 1;
	}

	#historySchemaNeedsMigration(): boolean {
		return (
			this.#historySchemaUsesUnixEpoch() ||
			!this.#historySchemaHasColumn("session_id") ||
			!this.#historyPromptIsUnique()
		);
	}

	#migrateHistorySchema(): void {
		const hasSessionId = this.#historySchemaHasColumn("session_id");
		const sessionIdSelection = hasSessionId ? "session_id" : "NULL AS session_id";
		const migrate = this.#db.transaction(() => {
			this.#db.run("DROP INDEX IF EXISTS idx_history_created_at");
			this.#db.run("DROP TRIGGER IF EXISTS history_ai");
			this.#db.run("DROP TABLE IF EXISTS history_fts");
			this.#db.run("ALTER TABLE history RENAME TO history_legacy");
			this.#db.run(`
CREATE TABLE history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT,
	session_id TEXT
);
CREATE INDEX idx_history_created_at ON history(created_at DESC);
INSERT INTO history (id, prompt, created_at, cwd, session_id)
SELECT id, prompt, created_at, cwd, session_id
FROM (
	SELECT
		id,
		prompt,
		created_at,
		cwd,
		${sessionIdSelection},
		ROW_NUMBER() OVER (PARTITION BY prompt ORDER BY created_at DESC, id DESC) AS recency_rank
	FROM history_legacy
)
WHERE recency_rank = 1;
DROP TABLE history_legacy;
			`);
		});
		migrate();
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	/**
	 * Split on non-alphanumeric runs, mirroring FTS5's `unicode61` tokenizer so
	 * query tokens align with how stored prompts were indexed. Lowercases for
	 * stable substring matching.
	 */
	#tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(tok => tok.length > 0);
	}

	#searchSubstring(tokens: string[], limit: number): HistoryRow[] {
		const stmt = this.#getSubstringStmt(tokens.length);
		const params: unknown[] = tokens.map(tok => `%${escapeLikePattern(tok)}%`);
		params.push(limit);
		return stmt.all(...(params as [string, ...unknown[]])) as HistoryRow[];
	}

	#getSubstringStmt(tokenCount: number): Statement {
		let stmt = this.#substringStmts.get(tokenCount);
		if (stmt) return stmt;
		const whereClause = Array(tokenCount).fill("prompt LIKE ? ESCAPE '\\' COLLATE NOCASE").join(" AND ");
		stmt = this.#db.prepare(
			`SELECT id, prompt, created_at, cwd, session_id FROM history WHERE ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
		);
		this.#substringStmts.set(tokenCount, stmt);
		return stmt;
	}

	#toEntry(row: HistoryRow): HistoryEntry {
		return {
			id: row.id,
			prompt: row.prompt,
			created_at: row.created_at,
			cwd: row.cwd ?? undefined,
			sessionId: row.session_id ?? undefined,
		};
	}
}
