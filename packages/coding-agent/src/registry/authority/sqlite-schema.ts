import type { AuthorityDomain } from "./types";

// The application marker distinguishes the authority layout from unrelated SQLite files.
export const SQLITE_AUTHORITY_APPLICATION_ID = 0x4f4d5042;
/** Physical schema written and opened by this build. */
export const SQLITE_AUTHORITY_SCHEMA_VERSION = 4;
/** Earlier physical schema: refused on open, readable only by the offline conversion (`--to sqlite --apply`). */
export const SQLITE_AUTHORITY_LEGACY_SCHEMA_VERSION = 3;

/** Frame-body codec version: the first byte of every stored frame body. */
export const SQLITE_AUTHORITY_CODEC_VERSION = 4;
/**
 * Largest uncompressed frame body the codec writes or decodes. A frame is bounded by its request (2 MiB
 * admission bound) times a small expansion, so this cap is never reached by a valid commit; it bounds
 * decompression of a corrupt or hostile body instead of trusting its declared size.
 */
export const SQLITE_AUTHORITY_MAX_FRAME_BODY_BYTES = 64 * 1024 * 1024;

export interface SqliteAuthorityDomainSchema {
	readonly table: string;
	/**
	 * Columns projected from the record for indexed filters and partial-index predicates, as
	 * [column, record field] in table order. The primary key is the compact order key (see sqlite-codec).
	 */
	readonly columns: readonly (readonly [column: string, field: string])[];
	/** Whether a scan may filter by `rootId`; through `root_id` when projected, else through the record. */
	readonly rootFilter: boolean;
}

export const SQLITE_AUTHORITY_DOMAINS: Readonly<Record<AuthorityDomain, SqliteAuthorityDomainSchema>> = {
	root: { table: "authority_roots", columns: [["state", "state"]], rootFilter: true },
	actor: {
		table: "authority_actors",
		columns: [
			["root_id", "rootId"],
			["root_generation", "rootGeneration"],
			["state", "state"],
		],
		rootFilter: true,
	},
	construction: { table: "authority_constructions", columns: [["phase", "phase"]], rootFilter: true },
	gate: { table: "authority_gates", columns: [["phase", "phase"]], rootFilter: true },
	operation: { table: "authority_operations", columns: [["phase", "phase"]], rootFilter: true },
	transition: { table: "authority_transitions", columns: [["phase", "phase"]], rootFilter: true },
	resource: { table: "authority_resources", columns: [["phase", "phase"]], rootFilter: true },
	"local-entry": {
		table: "authority_local_entries",
		columns: [
			["local_id", "localId"],
			["version_key", "version"],
			["head_hash", "headHash"],
			["phase", "phase"],
		],
		rootFilter: false,
	},
	"local-head": { table: "authority_local_heads", columns: [["phase", "phase"]], rootFilter: false },
};

/*
 * Physical schema v4. Every current-state table and the control table is one WITHOUT ROWID B-tree keyed by the
 * compact order key, so a point read, uniqueness and ordered range scans share one tree. Receipts are columns of
 * their immutable frame row; one UNIQUE index serves idempotent replay. Hashes are 32-byte BLOBs. Identifier columns
 * are CESU-8 BLOBs: a TEXT binding would replace a lone surrogate with U+FFFD and merge distinct ids. Partial indexes
 * keep open-row and local-head scans independent of history (A8), the cross-root open-actor scan included; the
 * local-entry match index ends in the order key so a match scan needs no sort.
 */
export const SQLITE_AUTHORITY_SCHEMA = `
CREATE TABLE authority_identity (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL CHECK (json_valid(value)));
CREATE TABLE authority_controls (order_key BLOB NOT NULL, value TEXT NOT NULL CHECK (json_valid(value)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE TABLE authority_frames (revision INTEGER PRIMARY KEY CHECK (revision > 0), incarnation BLOB NOT NULL, request_id BLOB NOT NULL, epoch INTEGER NOT NULL CHECK (epoch > 0), hash BLOB NOT NULL CHECK (length(hash) = 32), previous_hash BLOB NOT NULL CHECK (length(previous_hash) = 32), content_hash BLOB NOT NULL CHECK (length(content_hash) = 32), receipt TEXT NOT NULL CHECK (json_valid(receipt)), body BLOB NOT NULL);
CREATE UNIQUE INDEX authority_frames_receipt ON authority_frames(incarnation, request_id, epoch);
CREATE TRIGGER authority_frames_no_update BEFORE UPDATE ON authority_frames BEGIN SELECT RAISE(ABORT, 'authority frame history is immutable'); END;
CREATE TRIGGER authority_frames_no_delete BEFORE DELETE ON authority_frames BEGIN SELECT RAISE(ABORT, 'authority frame history is immutable'); END;
CREATE TABLE authority_legacy_source (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL CHECK (json_valid(value)));
CREATE TABLE authority_roots (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), state TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_roots_active ON authority_roots(order_key) WHERE state = 'active';
CREATE TABLE authority_actors (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), root_id BLOB NOT NULL, root_generation INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_actors_by_root ON authority_actors(root_id, root_generation, order_key);
CREATE INDEX authority_actors_root_current ON authority_actors(root_id, root_generation, order_key) WHERE state IN ('active', 'parked');
CREATE INDEX authority_actors_open ON authority_actors(order_key) WHERE state IN ('active', 'parked');
CREATE TABLE authority_constructions (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), phase TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_constructions_open ON authority_constructions(order_key) WHERE phase NOT IN ('activated', 'abandoned');
CREATE TABLE authority_gates (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), phase TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_gates_open ON authority_gates(order_key) WHERE phase IN ('open', 'quiescing', 'quiesced');
CREATE TABLE authority_operations (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), phase TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_operations_open ON authority_operations(order_key) WHERE phase IN ('intent', 'effect', 'committed');
CREATE TABLE authority_transitions (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), phase TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_transitions_open ON authority_transitions(order_key) WHERE phase NOT IN ('retired', 'recovered');
CREATE TABLE authority_resources (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), phase TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_resources_open ON authority_resources(order_key) WHERE phase IN ('intent', 'effect', 'committed');
CREATE TABLE authority_local_entries (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), local_id BLOB NOT NULL, version_key INTEGER NOT NULL, head_hash BLOB NOT NULL CHECK (length(head_hash) = 32), phase TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_local_entries_open ON authority_local_entries(order_key) WHERE phase IN ('intent', 'effect');
CREATE INDEX authority_local_entries_match ON authority_local_entries(local_id, version_key, head_hash, order_key);
CREATE TABLE authority_local_heads (order_key BLOB NOT NULL, version INTEGER NOT NULL CHECK (version > 0), wrapper_order INTEGER NOT NULL CHECK (wrapper_order IN (0, 1)), phase TEXT NOT NULL, record TEXT NOT NULL CHECK (json_valid(record)), PRIMARY KEY (order_key)) WITHOUT ROWID;
CREATE INDEX authority_local_heads_current ON authority_local_heads(order_key) WHERE phase = 'current';
`;

/** Physical schema v3, kept only so the offline conversion can recognise and read a v3 store. */
export const SQLITE_AUTHORITY_V3_DOMAIN_TABLES: Readonly<Record<AuthorityDomain, string>> = {
	root: "authority_roots",
	actor: "authority_actors",
	construction: "authority_constructions",
	gate: "authority_gates",
	operation: "authority_operations",
	transition: "authority_transitions",
	resource: "authority_resources",
	"local-entry": "authority_local_entries",
	"local-head": "authority_local_heads",
};
