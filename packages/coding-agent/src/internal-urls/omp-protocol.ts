/**
 * Protocol handler for omp:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - omp:// - Lists all available documentation files
 * - omp://<file>.md - Reads a specific documentation file
 */
import ompDoc from "../prompts/internal-urls/omp.md" with { type: "text" };
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import { ompDocFilename, ompDocRel, ompDocsScopeEntries } from "./omp-scope";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/**
 * Handler for omp:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class OmpProtocolHandler implements ProtocolHandler {
	readonly scheme = "omp";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true };

	/** Always advertised: harness docs are embedded in every build. */
	promptDoc(): string {
		return ompDoc.trim();
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const filename = ompDocFilename(url);
		const docPath = ompDocRel(url);
		if (!docPath) {
			return this.#listDocs(url);
		}

		const filenames = getDocFilenames();
		if (filename && filenames.includes(docPath)) {
			return this.#readDoc(docPath, filename, url);
		}
		const docPrefix = `${docPath.replace(/\/+$/, "")}/`;
		if (filenames.some(available => available.startsWith(docPrefix))) {
			return this.#listDocs(url, docPath);
		}
		if (!filename) {
			return this.#listDocs(url);
		}
		return this.#readDoc(docPath, filename, url);
	}

	async enumerate(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>> {
		const docPath = ompDocRel(url);
		if (!docPath) {
			const entries = await ompDocsScopeEntries(context);
			if (entries.length === 0) {
				throw new Error("No documentation files found");
			}
			return entries;
		}

		const filenames = getDocFilenames();
		if (filenames.includes(docPath)) {
			const resource = await this.#readDoc(docPath, ompDocFilename(url), url);
			return [{ url: `omp://${docPath}`, content: resource.content }];
		}
		const docPrefix = `${docPath.replace(/\/+$/, "")}/`;
		if (filenames.some(filename => filename.startsWith(docPrefix))) {
			const urlPrefix = `${url.href.replace(/\/+$/, "")}/`;
			const entries = (await ompDocsScopeEntries(context)).filter(entry => entry.url.startsWith(urlPrefix));
			if (entries.length === 0) {
				throw new Error("No documentation files found");
			}
			return entries;
		}

		const resource = await this.#readDoc(docPath, ompDocFilename(url), url);
		return [{ url: `omp://${docPath}`, content: resource.content }];
	}

	async complete(): Promise<UrlCompletion[]> {
		return getDocFilenames().map(value => ({ value }));
	}

	async #listDocs(url: InternalUrl, prefix?: string): Promise<InternalResource> {
		const docPrefix = prefix === undefined ? undefined : `${prefix.replace(/\/+$/, "")}/`;
		const filenames = getDocFilenames().filter(filename => !docPrefix || filename.startsWith(docPrefix));
		if (filenames.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = filenames.map(f => `- [${f}](omp://${f})`).join("\n");
		const content = `# Documentation\n\n${filenames.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			isDirectory: true,
		};
	}

	async #readDoc(docPath: string, filename: string, url: InternalUrl): Promise<InternalResource> {
		const content = await getEmbeddedDoc(docPath);
		if (content === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = getDocFilenames()
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse omp:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}
