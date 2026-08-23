import {
	type ApprovalResponse,
	type ProtectedMarkdownFile,
	validateApprovalResponse,
} from "../schemas/approval-dossier.ts";
import { canonicalJson, hashRawBytes } from "./canonical-json.ts";

/** The sole protected payload marker accepted by the model-free importer. */
export const PROTECTED_STATE_TEMPLATE_ID = "approval-dossier-protected-state" as const;
export const PROTECTED_STATE_ENCODING = "base64-canonical-json" as const;
export const VISIBLE_MARKDOWN_ATTRIBUTE = "data-approval-dossier-visible-markdown" as const;
export const VISIBLE_MARKDOWN_HASH_ATTRIBUTE = "data-approval-dossier-sha256" as const;
export const VISIBLE_MARKDOWN_BYTES_ATTRIBUTE = "data-approval-dossier-byte-count" as const;

/** Leaves room in the 4 MiB HTML cap for base64 and visible exact projections. */
export const MAX_PROTECTED_STATE_JSON_BYTES = 1 * 1_024 * 1_024;

export type HtmlPayloadErrorCode =
	| "PROTECTED_PAYLOAD_MISSING"
	| "PROTECTED_PAYLOAD_DUPLICATE"
	| "PROTECTED_PAYLOAD_INVALID"
	| "VISIBLE_MARKDOWN_MISSING"
	| "VISIBLE_MARKDOWN_INVALID"
	| "VISIBLE_MARKDOWN_DUPLICATE";

export class ApprovalDossierHtmlPayloadError extends TypeError {
	readonly code: HtmlPayloadErrorCode;
	readonly path: string;

	constructor(code: HtmlPayloadErrorCode, path: string) {
		super(`${code}:${path}`);
		this.name = "ApprovalDossierHtmlPayloadError";
		this.code = code;
		this.path = path;
	}
}

export interface VisibleMarkdownPayload {
	readonly path: string;
	readonly sha256: string;
	readonly byte_count: number;
	readonly bytes: Uint8Array;
}

/**
 * Emits a non-executable, canonical protected state element. Renderers append this
 * exact element unchanged; importers deliberately accept no alternative encoding.
 */
export function encodeProtectedApprovalPayload(approval: ApprovalResponse): string {
	const validated = validateApprovalResponse(approval);
	const base64 = Buffer.from(canonicalJson(validated, { maximum_bytes: MAX_PROTECTED_STATE_JSON_BYTES }), "utf8").toString("base64");
	return `<template id="${PROTECTED_STATE_TEMPLATE_ID}" data-approval-dossier-encoding="${PROTECTED_STATE_ENCODING}">${base64}</template>`;
}

/**
 * Emits the visible, escaped Markdown projection and its deterministic source
 * markers. The markers prove correspondence; protected payload bytes remain the
 * publication authority.
 */
export function encodeVisibleMarkdownProjection(file: ProtectedMarkdownFile): string {
	const bytes = decodeProtectedMarkdown(file);
	const markdown = decodeUtf8(bytes, file.path, "VISIBLE_MARKDOWN_INVALID");
	return `<pre ${VISIBLE_MARKDOWN_ATTRIBUTE}="${file.path}" ${VISIBLE_MARKDOWN_HASH_ATTRIBUTE}="${file.sha256}" ${VISIBLE_MARKDOWN_BYTES_ATTRIBUTE}="${file.byte_count}">${escapeHtmlText(markdown)}</pre>`;
}

/** Extracts and validates the canonical protected approval payload from source bytes. */
export function extractProtectedApprovalPayload(source: string): ApprovalResponse {
	const opening = `<template id="${PROTECTED_STATE_TEMPLATE_ID}" data-approval-dossier-encoding="${PROTECTED_STATE_ENCODING}">`;
	const start = source.indexOf(opening);
	if (start < 0) throw new ApprovalDossierHtmlPayloadError("PROTECTED_PAYLOAD_MISSING", PROTECTED_STATE_TEMPLATE_ID);
	if (source.indexOf(opening, start + opening.length) >= 0) {
		throw new ApprovalDossierHtmlPayloadError("PROTECTED_PAYLOAD_DUPLICATE", PROTECTED_STATE_TEMPLATE_ID);
	}
	const contentStart = start + opening.length;
	const end = source.indexOf("</template>", contentStart);
	if (end < 0) throw new ApprovalDossierHtmlPayloadError("PROTECTED_PAYLOAD_INVALID", PROTECTED_STATE_TEMPLATE_ID);
	const encoded = source.slice(contentStart, end);
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
		throw new ApprovalDossierHtmlPayloadError("PROTECTED_PAYLOAD_INVALID", PROTECTED_STATE_TEMPLATE_ID);
	}
	let payload: unknown;
	try {
		const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
		payload = JSON.parse(json);
	} catch {
		throw new ApprovalDossierHtmlPayloadError("PROTECTED_PAYLOAD_INVALID", PROTECTED_STATE_TEMPLATE_ID);
	}
	try {
		return validateApprovalResponse(payload);
	} catch {
		throw new ApprovalDossierHtmlPayloadError("PROTECTED_PAYLOAD_INVALID", PROTECTED_STATE_TEMPLATE_ID);
	}
}

/**
 * Reads only the renderer's explicit projection markers from static source. It
 * never interprets a parsed DOM as semantic authority.
 */
export function extractVisibleMarkdownPayloads(source: string): readonly VisibleMarkdownPayload[] {
	const pattern = new RegExp(
		`<pre ${VISIBLE_MARKDOWN_ATTRIBUTE}="([A-Za-z0-9][A-Za-z0-9._/-]{0,255})" ${VISIBLE_MARKDOWN_HASH_ATTRIBUTE}="([0-9a-f]{64})" ${VISIBLE_MARKDOWN_BYTES_ATTRIBUTE}="(0|[1-9][0-9]*)">([\\s\\S]*?)</pre>`,
		"g",
	);
	const payloads: VisibleMarkdownPayload[] = [];
	const paths = new Set<string>();
	for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
		const path = match[1] as string;
		if (paths.has(path)) throw new ApprovalDossierHtmlPayloadError("VISIBLE_MARKDOWN_DUPLICATE", path);
		paths.add(path);
		const markdown = unescapeHtmlText(match[4] as string, path);
		const bytes = Buffer.from(markdown, "utf8");
		const declaredByteCount = Number(match[3]);
		if (!Number.isSafeInteger(declaredByteCount) || declaredByteCount !== bytes.byteLength) {
			throw new ApprovalDossierHtmlPayloadError("VISIBLE_MARKDOWN_INVALID", path);
		}
		const sha256 = match[2] as string;
		if (hashRawBytes(bytes) !== sha256) throw new ApprovalDossierHtmlPayloadError("VISIBLE_MARKDOWN_INVALID", path);
		payloads.push(Object.freeze({ path, sha256, byte_count: declaredByteCount, bytes: Uint8Array.from(bytes) }));
	}
	return Object.freeze(payloads);
}

export function decodeProtectedMarkdown(file: ProtectedMarkdownFile): Uint8Array {
	return Uint8Array.from(Buffer.from(file.bytes_base64, "base64"));
}

function decodeUtf8(bytes: Uint8Array, path: string, code: HtmlPayloadErrorCode): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ApprovalDossierHtmlPayloadError(code, path);
	}
}

function escapeHtmlText(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			case "\"": return "&quot;";
			case "'": return "&#39;";
			default: return character;
		}
	});
}

function unescapeHtmlText(value: string, path: string): string {
	if (value.includes("<")) throw new ApprovalDossierHtmlPayloadError("VISIBLE_MARKDOWN_INVALID", path);
	return value.replace(/&(amp|lt|gt|quot|#39);|&/g, (_match, entity?: string) => {
		if (entity === undefined) throw new ApprovalDossierHtmlPayloadError("VISIBLE_MARKDOWN_INVALID", path);
		switch (entity) {
			case "amp": return "&";
			case "lt": return "<";
			case "gt": return ">";
			case "quot": return "\"";
			case "#39": return "'";
			default: throw new ApprovalDossierHtmlPayloadError("VISIBLE_MARKDOWN_INVALID", path);
		}
	});
}
