import { readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { hashCanonicalJson, hashRawBytes } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { IDEATION_PROJECTION_MANIFEST_SCHEMA, type IdeationProjectionManifest } from "./ideation-projection.ts";

const ROOTS = [
	".omp/agent/skills/ideation-with-critique/schemas/ideation-state.ts",
	".omp/agent/skills/ideation-with-critique/scripts/ideation-projection.ts",
] as const;
const RELATIVE_IMPORT = /(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g;

export interface IdeationProjectionSnapshot {
	readonly manifest: IdeationProjectionManifest;
	readonly sha256: string;
}

/** Loads the complete output-affecting repository source closure from one explicit implementation root. */
export async function loadIdeationProjectionSnapshot(implementationRoot: string): Promise<IdeationProjectionSnapshot> {
	const pending: string[] = [...ROOTS];
	const seen = new Set<string>();
	const folded = new Map<string, string>();
	const entries: { path: string; sha256: string }[] = [];
	while (pending.length > 0) {
		const path = validateSourcePath(pending.pop()!);
		if (seen.has(path)) continue;
		const lower = path.toLocaleLowerCase("en-US");
		const collision = folded.get(lower);
		if (collision !== undefined && collision !== path) throw new TypeError(`Ideation projection dependency case collision: ${collision} and ${path}`);
		folded.set(lower, path);
		seen.add(path);
		const bytes = await readFile(resolve(implementationRoot, path));
		entries.push({ path, sha256: hashRawBytes(bytes) });
		if (!path.endsWith(".ts")) continue;
		const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		for (const match of source.matchAll(RELATIVE_IMPORT)) {
			const specifier = match[1]!;
			const dependency = posix.normalize(posix.join(dirname(path).replaceAll("\\", "/"), specifier));
			pending.push(validateSourcePath(dependency));
		}
	}
	entries.sort((left, right) => new TextEncoder().encode(left.path).reduce((order, byte, index) => order === 0 ? byte - (new TextEncoder().encode(right.path)[index] ?? -1) : order, 0) || left.path.length - right.path.length);
	const manifest: IdeationProjectionManifest = Object.freeze({ schema: IDEATION_PROJECTION_MANIFEST_SCHEMA, entries: Object.freeze(entries.map((entry) => Object.freeze(entry))) });
	return Object.freeze({ manifest, sha256: hashCanonicalJson(manifest) });
}

function validateSourcePath(input: string): string {
	if (input.length === 0 || input.startsWith("/") || input.includes("\\") || input.includes("\0")) throw new TypeError(`invalid Ideation projection source path: ${input}`);
	const segments = input.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new TypeError(`invalid Ideation projection source path: ${input}`);
	if (segments[0] !== ".omp") throw new TypeError(`Ideation projection source escapes implementation root: ${input}`);
	return segments.join("/");
}
