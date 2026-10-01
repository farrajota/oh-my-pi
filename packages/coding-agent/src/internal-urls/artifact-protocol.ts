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
import { artifactsDirsForContext, isBoundResourceContext } from "./registry-helpers";
import { ArtifactManager } from "../session/artifacts";
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

/** Resolve an `artifact://` URL to its backing file without reading artifact bytes. */
async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const id = parseArtifactId(url);

	const dirs = artifactsDirsForContext(context);
	if (isBoundResourceContext(context) && dirs.length === 0) {
		throw new Error("No caller-owned artifacts available");
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
		try {
			return (await resolveArtifactFile(url, context)).path;
		} catch (error) {
			if (error instanceof MissingArtifactError) return null;
			throw error;
		}
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
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
		return (await listArtifactIds(artifactsDirsForContext(context))).map(value => ({ value }));
	}
}
