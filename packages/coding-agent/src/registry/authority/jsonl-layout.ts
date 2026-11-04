import * as fs from "node:fs";
import * as path from "node:path";

/**
 * File layout of a rotated JSONL authority store, derived from the active payload path `A` (normally
 * `S.authority.jsonl`). With `stem` = `A` minus its `.jsonl` extension:
 *
 * - `A`: the active segment. Segment 0 starts with a version-2 header (optionally seeded); segment n >= 1
 *   starts with a version-3 header that names its base snapshot.
 * - `stem.segment.<k>.jsonl`: sealed segment k, the exact bytes the active segment held when it was sealed.
 * - `stem.segment.<k>.index.json`: index of sealed segment k (byte length, SHA-256, revision range, receipts).
 * - `stem.snapshot.<n>.json`: compacted state at the start of active segment n.
 *
 * Temporary files are `<final name>.tmp-<uuid>`; they never hold committed state.
 */
export interface JsonlLayout {
	readonly active: string;
	readonly directory: string;
	readonly stem: string;
	segment(index: number): string;
	index(index: number): string;
	snapshot(index: number): string;
}

/**
 * Longest frame line an owner writes. A frame is at most 5x its encoded request (capacity-sqlite's expansion bound)
 * plus a bounded skeleton, and requests are at most 2 MiB, so 64 MiB leaves a wide margin; a longer line is refused
 * before it is buffered. The header line is exempt: a seeded version-2 header embeds a whole export. It also bounds
 * one element of a header, snapshot or index document (json-scan): each element comes from at most one frame.
 */
export const AUTHORITY_JSONL_MAX_FRAME_LINE_BYTES = 64 * 1024 * 1024;

const SEGMENT_NUMBER = "(0|[1-9][0-9]{0,8})";
const SNAPSHOT_NUMBER = "([1-9][0-9]{0,8})";
const TEMPORARY_SUFFIX = "\\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

/** Bundle-relative names (`authority.<...>`) of the rotation artifacts beside the selected `authority.jsonl`. */
export const AUTHORITY_JSONL_ROTATION_MEMBER = new RegExp(
	`^authority\\.(?:segment\\.${SEGMENT_NUMBER}\\.(?:jsonl|index\\.json)|snapshot\\.${SNAPSHOT_NUMBER}\\.json)$`,
);

export function jsonlLayout(activePath: string): JsonlLayout {
	const active = path.resolve(activePath);
	const directory = path.dirname(active);
	const stem = active.endsWith(".jsonl") ? active.slice(0, -".jsonl".length) : active;
	return {
		active,
		directory,
		stem,
		segment: index => `${stem}.segment.${index}.jsonl`,
		index: index => `${stem}.segment.${index}.index.json`,
		snapshot: index => `${stem}.snapshot.${index}.json`,
	};
}

export type JsonlRotationArtifact =
	| { readonly kind: "segment" | "index"; readonly number: number; readonly file: string }
	| { readonly kind: "snapshot"; readonly number: number; readonly file: string }
	| { readonly kind: "temporary"; readonly file: string };

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where the bytes an open cuts from the active segment are kept: `<stem>-recovered.<offset>.<sha256>.bin` beside the
 * store, i.e. `<S>.authority-recovered.<offset>.<sha256>.bin` for session `S`. It is operator evidence, not a bundle
 * member: every classifier recognizes it through {@link isAuthorityRecoveryFileName} and neither treats it as
 * authority evidence nor copies it, so it never blocks repair, migration, packing, moving or adoption.
 */
export function jsonlRecoveryFile(layout: JsonlLayout, cut: number, sha256: string): string {
	return `${layout.stem}-recovered.${cut}.${sha256}.bin`;
}

/** Whether `name` is exactly a {@link jsonlRecoveryFile} basename of the session whose transcript basename is `sessionBase`. */
export function isAuthorityRecoveryFileName(sessionBase: string, name: string): boolean {
	return new RegExp(
		`^${escapeRegExp(sessionBase)}\\.authority-recovered\\.(0|[1-9][0-9]{0,15})\\.[a-f0-9]{64}\\.bin$`,
	).test(name);
}

/** Absolute paths of the tail recovery files beside `sessionFile`, sorted. */
export function listAuthorityRecoveryFiles(sessionFile: string): string[] {
	const directory = path.dirname(sessionFile);
	const base = path.basename(sessionFile);
	return fs
		.readdirSync(directory)
		.filter(name => isAuthorityRecoveryFileName(base, name))
		.sort()
		.map(name => path.join(directory, name));
}

/** Classifies a sibling basename of `layout.active` as one of its rotation artifacts, or undefined. */
export function classifyJsonlArtifact(layout: JsonlLayout, name: string): JsonlRotationArtifact | undefined {
	const stem = escapeRegExp(path.basename(layout.stem));
	const active = escapeRegExp(path.basename(layout.active));
	const file = path.join(layout.directory, name);
	const temporary = new RegExp(
		`^(?:${active}|${stem}\\.(?:segment\\.${SEGMENT_NUMBER}\\.(?:jsonl|index\\.json)|snapshot\\.${SNAPSHOT_NUMBER}\\.json))${TEMPORARY_SUFFIX}$`,
	);
	if (temporary.test(name)) return { kind: "temporary", file };
	const segment = new RegExp(`^${stem}\\.segment\\.${SEGMENT_NUMBER}\\.(jsonl|index\\.json)$`).exec(name);
	if (segment) return { kind: segment[2] === "jsonl" ? "segment" : "index", number: Number(segment[1]), file };
	const snapshot = new RegExp(`^${stem}\\.snapshot\\.${SNAPSHOT_NUMBER}\\.json$`).exec(name);
	if (snapshot) return { kind: "snapshot", number: Number(snapshot[1]), file };
	return undefined;
}

/** Every rotation artifact (sealed segments, indexes, snapshots and temporaries) currently beside `activePath`. */
export function listJsonlRotationArtifacts(activePath: string): JsonlRotationArtifact[] {
	const layout = jsonlLayout(activePath);
	let names: string[];
	try {
		names = fs.readdirSync(layout.directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const artifacts: JsonlRotationArtifact[] = [];
	for (const name of names.sort()) {
		const artifact = classifyJsonlArtifact(layout, name);
		if (artifact) artifacts.push(artifact);
	}
	return artifacts;
}

/**
 * The committed files of a JSONL store: the active payload plus its sealed segments, indexes and snapshot, in
 * a stable order. Temporaries are excluded; a store with temporaries left by an interrupted rotation is
 * repaired by its next owner before any of these files is trusted.
 */
export function jsonlStoreFiles(activePath: string): string[] {
	const layout = jsonlLayout(activePath);
	return [
		layout.active,
		...listJsonlRotationArtifacts(activePath)
			.filter(artifact => artifact.kind !== "temporary")
			.map(artifact => artifact.file),
	];
}
