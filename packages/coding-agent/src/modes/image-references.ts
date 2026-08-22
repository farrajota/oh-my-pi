import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobPutResult, blobExtensionForImageMimeType } from "../session/blob-store";
import { fileHyperlink } from "../tui/hyperlink";
import { SYMBOL_PRESETS } from "./theme/symbols";
import { theme } from "./theme/theme";

/** Attachment chip kinds staged in the composer: pasted images and large text pastes. */
export type ChipKind = "image" | "paste";

const CHIP_ICON_KEY = { image: "chip.image", paste: "chip.paste" } as const;

/** Compact atomic composer token for attachment `n` — `<icon> #n` in the active symbol preset.
 *  The token lives verbatim in the editor buffer (layout math needs real cells) and expands to
 *  its bracketed marker / paste content on submit via the editor's atom table. */
export function chipLabel(kind: ChipKind, n: number): string {
	// `theme` is assigned by initTheme(); fall back to the default (unicode) preset before that
	// (tests, early boot) so labels are stable rather than `undefined #1`.
	const icon =
		typeof theme === "undefined" ? SYMBOL_PRESETS.unicode[CHIP_ICON_KEY[kind]] : theme.symbol(CHIP_ICON_KEY[kind]);
	return `${icon} #${n}`;
}

/** Every glyph a chip token may start with, across all symbol presets — so a draft written
 *  under one preset stays atomic and decorated after the user switches presets. */
const CHIP_ICONS: Record<ChipKind, readonly string[]> = {
	image: [...new Set(Object.values(SYMBOL_PRESETS).map(m => m[CHIP_ICON_KEY.image]))],
	paste: [...new Set(Object.values(SYMBOL_PRESETS).map(m => m[CHIP_ICON_KEY.paste]))],
};

// ASCII-preset icons are bare words (`img`, `txt`); require a non-letter on the left so prose
// like `boximg #1` never becomes an atomic token. Glyph icons need no guard.
const CHIP_TOKEN_SOURCE = `(?:${[...CHIP_ICONS.image, ...CHIP_ICONS.paste]
	.map(icon => (/^[a-z]+$/i.test(icon) ? `(?<![A-Za-z])${RegExp.escape(icon)}` : RegExp.escape(icon)))
	.join("|")}) #[1-9]\\d*`;

/** Whether chip token `label` references an image attachment (vs a text paste). */
export function chipLabelKind(label: string): ChipKind {
	return CHIP_ICONS.image.some(icon => label.startsWith(icon)) ? "image" : "paste";
}

/** omp2's six-color attachment identity palette (chip border + inline token). */
const ATTACHMENT_PALETTE: readonly [number, number, number][] = [
	[255, 179, 102],
	[125, 207, 255],
	[189, 147, 249],
	[105, 220, 158],
	[255, 141, 188],
	[240, 223, 120],
];

/** Identity color for attachment `n` of `kind`. Paste numbering is offset into the palette so
 *  `image #1` and `paste #1` (separate counters) never share a color. */
export function attachmentRgb(kind: ChipKind, n: number): readonly [number, number, number] {
	const index = kind === "image" ? (n - 1) % ATTACHMENT_PALETTE.length : (n + 2) % ATTACHMENT_PALETTE.length;
	return ATTACHMENT_PALETTE[index];
}

/** Truecolor SGR foreground for {@link attachmentRgb}; reset with `\x1b[39m`. */
export function attachmentSgr(kind: ChipKind, n: number): string {
	const [r, g, b] = attachmentRgb(kind, n);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Probed pixel dimensions riding on the draft image object itself; `null` records a failed
 *  probe so the chips band never re-decodes a corrupt header every frame. */
const kImageDims = Symbol("omp.imageDimensions");

interface ImageContentWithDims extends ImageContent {
	[kImageDims]?: { width: number; height: number } | null;
}

/** Cached probe result for a draft image: dimensions, `null` (probe failed), or `undefined`
 *  (never probed). */
export function cachedImageDimensions(image: ImageContent): { width: number; height: number } | null | undefined {
	return (image as ImageContentWithDims)[kImageDims];
}

/** Record a probe result for a draft image (see {@link cachedImageDimensions}). */
export function setCachedImageDimensions(image: ImageContent, dims: { width: number; height: number } | null): void {
	(image as ImageContentWithDims)[kImageDims] = dims;
}

/** Matches `[Image #N]`/`[Image #N, WxH]` and `[Paste #N, +X lines]`/`[Paste #N, Y chars]` tokens.
 *  Group 1 is the kind (`Image`/`Paste`), group 2 the 1-based index. The optional metadata
 *  tail (`, …`) is captured loosely (no `]`/newline) so future label tweaks keep matching. */
export const PLACEHOLDER_REGEX = /\[(Image|Paste) #([1-9]\d*)(?:,[^\]\n]*)?\]/g;

/** Union of bracketed markers and compact chip tokens: the editor's atomic-token pattern and
 *  the decoration scanner both need to treat either form as one indivisible reference. */
export const COMPOSER_TOKEN_REGEX = new RegExp(`${PLACEHOLDER_REGEX.source}|${CHIP_TOKEN_SOURCE}`, "gu");

/** Matches a single `[Image #N]` / `[Image #N, WxH]` marker and its optional
 *  immediately following `attachment://N` URI (legacy drafts only — new pastes
 *  insert the bare marker). Groups 1 and 3 are the 1-based
 *  marker and attachment indices; group 2 is the optional metadata tail
 *  (leading comma, no `]` or newline). Paste markers are excluded on purpose:
 *  their numbering is owned by the editor's paste store, not by the
 *  pending-image buffer. */
const IMAGE_MARKER_REGEX = /\[Image #([1-9]\d*)((?:,[^\]\n]*)?)\](?: attachment:\/\/(\1))?/g;

/** Renumber every `[Image #N]` marker — and, in legacy drafts, its immediately
 *  following `attachment://N` URI — in `text` by `offset` (added to each existing index),
 *  preserving the optional `, WxH` tail. Paste markers and unrelated attachment
 *  URIs are left untouched. Used when restoring queued image-messages back into
 *  a draft that already holds pending images so the merged text's positional
 *  references still line up with `pendingImages`. */
export function shiftImageMarkers(text: string, offset: number): string {
	if (offset === 0) return text;
	return text.replace(IMAGE_MARKER_REGEX, (_match, idx: string, tail: string, attachmentIdx: string | undefined) => {
		const marker = `[Image #${Number(idx) + offset}${tail}]`;
		return attachmentIdx === undefined ? marker : `${marker} attachment://${Number(attachmentIdx) + offset}`;
	});
}

/** Collapse every bracketed `[Image #N, tail]` marker with `N <= imageCount` — plus any legacy
 *  trailing `attachment://N` URI — into the compact chip token, calling `register` with the
 *  token and its bracketed expansion so the editor's atom table round-trips it on submit.
 *  Restores chips (and their band cards) for historical prompts, queued-message dequeues, and
 *  failed-submit recoveries whose stored text carries the expanded marker form. */
export function collapseImageMarkers(
	text: string,
	imageCount: number,
	register: (label: string, expansion: string) => void,
): string {
	if (imageCount === 0) return text;
	return text.replace(IMAGE_MARKER_REGEX, (match, idx: string, tail: string) => {
		const n = Number(idx);
		if (n > imageCount) return match;
		const label = chipLabel("image", n);
		register(label, `[Image #${n}${tail}]`);
		return label;
	});
}

/** Renumber a submission's bracketed image markers to a dense 1..K after the user deleted some
 *  chip tokens from the draft: markers referencing `1..imageCount` are compacted in ascending
 *  order (legacy `attachment://N` URIs follow), references beyond `imageCount` are left alone
 *  (prose about earlier messages). Returns `null` when every image is still referenced — the
 *  draft already satisfies the positional `[Image #N] ↔ images[N-1]` contract. Otherwise
 *  `keep` lists the surviving 0-based image indices in marker order; unreferenced images are
 *  dropped from the submission. */
export function compactImageMarkers(text: string, imageCount: number): { text: string; keep: number[] } | null {
	if (imageCount === 0) return null;
	const referenced = new Set<number>();
	const scanner = new RegExp(IMAGE_MARKER_REGEX.source, "g");
	for (;;) {
		const match = scanner.exec(text);
		if (match === null) break;
		const n = Number(match[1]);
		if (n <= imageCount) referenced.add(n);
	}
	if (referenced.size === imageCount) return null;
	const keep = [...referenced].sort((a, b) => a - b);
	const remap = new Map<number, number>(keep.map((n, i) => [n, i + 1]));
	const rewritten = text.replace(
		IMAGE_MARKER_REGEX,
		(match, idx: string, tail: string, attachmentIdx: string | undefined) => {
			const mapped = remap.get(Number(idx));
			if (mapped === undefined) return match;
			const marker = `[Image #${mapped}${tail}]`;
			return attachmentIdx === undefined ? marker : `${marker} attachment://${mapped}`;
		},
	);
	return { text: rewritten, keep: keep.map(n => n - 1) };
}

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<BlobPutResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => BlobPutResult;

export type PlaceholderKind = "image" | "paste";

export interface PlaceholderRenderers {
	renderText: (text: string) => string;
	/** `form` distinguishes a bracketed `[Image #N, …]` marker from a compact `<icon> #N` chip
	 *  token so hosts can style chips with their attachment identity color. */
	renderReference: (label: string, kind: PlaceholderKind, index: number, form: "marker" | "chip") => string;
}

export function renderPlaceholders(text: string, renderers: PlaceholderRenderers): string {
	COMPOSER_TOKEN_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	let matched = false;

	for (;;) {
		const match = COMPOSER_TOKEN_REGEX.exec(text);
		if (match === null) break;
		matched = true;
		if (match.index > last) {
			result += renderers.renderText(text.slice(last, match.index));
		}
		const label = match[0];
		if (label.startsWith("[")) {
			const kind: PlaceholderKind = match[1] === "Paste" ? "paste" : "image";
			result += renderers.renderReference(label, kind, Number(match[2]), "marker");
		} else {
			const index = Number(label.slice(label.lastIndexOf("#") + 1));
			result += renderers.renderReference(label, chipLabelKind(label), index, "chip");
		}
		last = match.index + match[0].length;
	}

	if (!matched) {
		return renderers.renderText(text);
	}
	if (last < text.length) {
		result += renderers.renderText(text.slice(last));
	}
	return result;
}

export function imageReferenceHyperlink(
	label: string,
	index: number,
	imageLinks: readonly (string | undefined)[] | undefined,
	renderLabel: (text: string) => string,
): string {
	const rendered = renderLabel(label);
	const target = imageLinks?.[index - 1];
	return target ? fileHyperlink(target, rendered) : rendered;
}

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		const result = await putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		const result = putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}
