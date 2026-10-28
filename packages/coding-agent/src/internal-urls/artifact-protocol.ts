/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against the artifacts directories of every active
 * session. Unlike agent://, artifacts are raw text with no JSON extraction.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import { artifactsDirsForContext, artifactsDirsFromRegistry, isBoundResourceContext } from "./registry-helpers";
import { ArtifactManager } from "../session/artifacts";
import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import artifactDoc from "../prompts/internal-urls/artifact.md" with { type: "text" };
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;

/**
 * Sorted artifact ids for `complete()`, keyed by the scanned dir set.
 * Completion runs per keystroke; a short reuse window avoids re-reading every
 * artifacts dir on each key.
 */
const completionIds = new LRUCache<string, Promise<string[]>>({ max: 8, ttl: 2000 });

async function scanArtifactIds(dirs: string[]): Promise<string[]> {
	const listings = await Promise.all(
		dirs.map(async dir => {
			try {
				return await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) return [];
				throw err;
			}
		}),
	);
	const ids = new Set<string>();
	for (const files of listings) {
		for (const f of files) {
			const m = f.match(/^(\d+)\./);
			if (m) ids.add(m[1]!);
		}
	}
	return [...ids].sort((a, b) => Number(a) - Number(b));
}

function artifactIdsForCompletion(): Promise<string[]> {
	const dirs = artifactsDirsFromRegistry();
	const key = dirs.join("\0");
	const cached = completionIds.get(key);
	if (cached) return cached;
	const ids = scanArtifactIds(dirs);
	completionIds.set(key, ids);
	ids.catch(() => completionIds.delete(key));
	return ids;
}

/** Filesystem location for a session artifact, resolved without materializing its content. */
interface ResolvedArtifactFile {
	id: string;
	path: string;
	size: number;
}

function parseArtifactId(url: InternalUrl): string {
	const id = url.rawHost || url.hostname;
	if (!id) {
		throw new Error("artifact:// URL requires a numeric ID: artifact://0");
	}
	if (!/^\d+$/.test(id)) {
		throw new Error(`artifact:// ID must be numeric, got: ${id}`);
	}
	return id;
}

/** An artifact id no session artifacts dir backs; `locate` maps it to null, `resolve` surfaces it. */
class MissingArtifactError extends Error {}

async function listArtifactIds(dirs: readonly string[]): Promise<string[]> {
	const ids = new Set<string>();
	for (const dir of dirs) {
		const manager = new ArtifactManager(dir);
		for (const file of await manager.listFiles()) {
			const id = file.match(/^(\d+)\./)?.[1];
			if (id) ids.add(id);
		}
	}
	return [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

/**
 * The caller's own in-memory spill for `id`, when the caller has no artifacts
 * dir (`--no-session`, SDK). It wins over registry-backed files: ids are
 * per-session counters, so another session's `<id>.*` file is not this one.
 */
function callerInMemoryArtifact(id: string, context?: ResolveContext): string | null {
	if (context?.localProtocolOptions?.getArtifactsDir?.()) return null;
	if (context?.session?.seanceSourceArtifactsDir) return null;
	return context?.session?.sessionManager?.getArtifactContent?.(id) ?? null;
}

/** Resolve an `artifact://` URL to its backing file without reading artifact bytes. */
async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const id = parseArtifactId(url);

	// Seance artifact reads are limited to the consulted source tree.
	const seanceDir = context?.session?.seanceSourceArtifactsDir ?? context?.seanceSourceArtifactsDir;
	const bound = isBoundResourceContext(context);
	const pinnedDir = context?.localProtocolOptions?.getArtifactsDir?.() ?? null;
	const dirs = seanceDir ? [seanceDir] : bound ? artifactsDirsForContext(context) : artifactsDirsFromRegistry();
	if (bound && dirs.length === 0) {
		throw new Error("No caller-owned artifacts available");
	}
	// Artifact ids are per-session counters; resolve the caller's own id first.
	if (!seanceDir && pinnedDir && dirs.includes(pinnedDir)) {
		dirs.splice(dirs.indexOf(pinnedDir), 1);
		dirs.unshift(pinnedDir);
	}
	if (dirs.length === 0) throw new MissingArtifactError("No session - artifacts unavailable");

	let foundPath: string | null = null;
	for (const dir of dirs) {
		const manager = new ArtifactManager(dir);
		foundPath = await manager.getPath(id);
		if (foundPath) break;
	}
	if (!foundPath) {
		const available = await listArtifactIds(dirs);
		const detail = available.length > 0 ? `. Available: ${available.join(", ")}` : "";
		throw new MissingArtifactError(`Artifact ${id} not found${detail}`);
	}

	const stat = await Bun.file(foundPath).stat();
	return { id, path: foundPath, size: stat.size };
}
export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		immutable: true,
		artifactStore: true,
		linkable: true,
	};

	promptDoc(): string {
		return artifactDoc.trim();
	}

	/** Backing artifact file; null for unknown ids, throws the resolve errors for malformed ones. */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		// No backing file: the read tool falls through to `resolve` and applies selectors in memory.
		if (callerInMemoryArtifact(parseArtifactId(url), context) !== null) return null;
		try {
			return (await resolveArtifactFile(url, context)).path;
		} catch (error) {
			if (error instanceof MissingArtifactError) return null;
			throw error;
		}
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		// A non-persistent session (`--no-session`, SDK) spills into memory
		// instead of an artifacts dir; the `artifact://` link the truncation
		// footer advertises must read that copy. The bytes are already resident,
		// so the size gate below (which avoids loading a large file) does not
		// apply; the read tool pages and limits the content it returns.
		const inMemory = callerInMemoryArtifact(parseArtifactId(url), context);
		if (inMemory !== null) {
			return {
				url: url.href,
				content: inMemory,
				contentType: "text/plain",
				size: Buffer.byteLength(inMemory, "utf8"),
			};
		}
		const artifact = await resolveArtifactFile(url, context);

		// Path consumers (search, the shell filesystem) use `locate`, which never
		// reads the bytes; only content materialization is size-gated.
		if (artifact.size > MAX_INLINE_ARTIFACT_BYTES) {
			throw new Error(
				`Artifact ${artifact.id} is ${artifact.size} bytes; full internal resolution is blocked. Use read selectors such as artifact://${artifact.id}:1-3000 or artifact://${artifact.id}:raw:1-3000.`,
			);
		}

		const content = await Bun.file(artifact.path).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: artifact.size,
			sourcePath: artifact.path,
		};
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const seanceDir = context?.session?.seanceSourceArtifactsDir ?? context?.seanceSourceArtifactsDir;
		const dirs = seanceDir ? [seanceDir] : artifactsDirsForContext(context);
		const ids =
			isBoundResourceContext(context) || seanceDir ? await listArtifactIds(dirs) : await artifactIdsForCompletion();
		return ids.map(value => ({ value }));
	}
}
