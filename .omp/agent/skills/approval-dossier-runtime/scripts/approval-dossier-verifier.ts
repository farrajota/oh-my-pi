import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	APPROVAL_DECLARATION,
	type ApprovalResponse,
	type CandidateBinding,
	candidateSha256,
	type RuntimeBinding,
	type VisualSet,
	validateCandidateBinding,
	validateRuntimeBinding,
	validateVisualSet,
} from "../schemas/approval-dossier.ts";
import {
	ApprovalDossierHtmlPayloadError,
	decodeProtectedMarkdown,
	extractProtectedApprovalPayload,
	extractVisibleMarkdownPayloads,
	type HtmlPayloadErrorCode,
	type VisibleMarkdownPayload,
} from "./approval-dossier-html.ts";
import {
	APPROVAL_DOSSIER_APP_ID,
	APPROVAL_DOSSIER_STYLE_ID,
	contentSecurityPolicy,
} from "./approval-dossier-renderer.ts";
import { hashRawBytes } from "./canonical-json.ts";

export const MAX_IMPORTED_HTML_BYTES = 4 * 1_024 * 1_024;

export type VerificationErrorCode =
	| "INVALID_HTML"
	| HtmlPayloadErrorCode
	| "DOSSIER_ENVELOPE_INVALID"
	| "CANDIDATE_MISMATCH"
	| "RUNTIME_MISMATCH"
	| "VISUAL_SET_MISMATCH"
	| "REVIEW_AUTHORITY_MISMATCH"
	| "APPROVAL_NOT_GRANTED"
	| "VISIBLE_MARKDOWN_MISMATCH";

export class ApprovalDossierVerificationError extends Error {
	readonly code: VerificationErrorCode;
	readonly path: string;

	constructor(code: VerificationErrorCode, path: string) {
		super(`${code}:${path}`);
		this.name = "ApprovalDossierVerificationError";
		this.code = code;
		this.path = path;
	}
}

/** Candidate-bound inputs required to authenticate an imported saved response. */
export interface CandidateVerificationContext {
	/** Exact UTF-8 bytes produced for this candidate before a reviewer saved a response. */
	readonly candidate_html: string | Uint8Array;
	readonly runtime?: RuntimeBinding;
	readonly visual_set?: VisualSet;
	readonly review_authority_sha256: string;
}

export interface ImportedHtmlVerification {
	readonly document_sha256: string;
	readonly approval: ApprovalResponse;
	readonly markdown_files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
	readonly visible_paths: readonly string[];
}

/**
 * Verifies exact saved HTML bytes against the closed shared renderer envelope.
 * Protected canonical JSON is authoritative; static markers prove exact visible
 * Markdown fidelity after active content and wrapper drift are rejected.
 */
export function verifyImportedHtml(
	html: string | Uint8Array,
	expectedCandidate: CandidateBinding,
	context: CandidateVerificationContext,
): ImportedHtmlVerification {
	const candidate = assertCandidateContext(expectedCandidate, context);
	const baseline = verifyCanonicalCandidateBaseline(context.candidate_html, candidate);
	const { bytes, source } = decodeHtml(html);
	assertDeterministicDossierEnvelope(source);
	let approval: ApprovalResponse;
	try {
		approval = extractProtectedApprovalPayload(source);
	} catch (error) {
		throwHtmlPayloadError(error);
	}
	assertApprovalCandidate(approval, candidate);
	if (normalizeProtectedPayload(source) !== normalizeProtectedPayload(baseline)) {
		throw new ApprovalDossierVerificationError("DOSSIER_ENVELOPE_INVALID", "envelope");
	}
	const markdownFiles = verifiedMarkdownFiles(source, approval);
	return Object.freeze({
		document_sha256: hashRawBytes(bytes),
		approval,
		markdown_files: markdownFiles,
		visible_paths: Object.freeze(markdownFiles.map(file => file.path)),
	});
}

export function verifyApprovedImportedHtml(
	html: string | Uint8Array,
	expectedCandidate: CandidateBinding,
	context: CandidateVerificationContext,
): ImportedHtmlVerification {
	const imported = verifyImportedHtml(html, expectedCandidate, context);
	const { approval } = imported;
	if (
		approval.approval_status !== "approved" ||
		approval.declaration !== APPROVAL_DECLARATION ||
		approval.approved_at === null ||
		approval.feedback.length !== 0
	) {
		throw new ApprovalDossierVerificationError("APPROVAL_NOT_GRANTED", "approval");
	}
	return imported;
}

/** Validates runtime, visual, review-authority, and exact candidate-baseline bindings. */
export function assertCandidateContext(
	candidateInput: CandidateBinding,
	context: CandidateVerificationContext,
): CandidateBinding {
	const candidate = validateCandidateBinding(candidateInput);
	if (
		!context ||
		!("candidate_html" in context) ||
		(typeof context.candidate_html !== "string" && !(context.candidate_html instanceof Uint8Array))
	) {
		throw new ApprovalDossierVerificationError("DOSSIER_ENVELOPE_INVALID", "candidate_html");
	}
	if (context.runtime && candidate.runtime_sha256 !== validateRuntimeBinding(context.runtime).runtime_sha256) {
		throw new ApprovalDossierVerificationError("RUNTIME_MISMATCH", "runtime_sha256");
	}
	if (context.visual_set && candidate.visual_set_sha256 !== validateVisualSet(context.visual_set).visual_set_sha256) {
		throw new ApprovalDossierVerificationError("VISUAL_SET_MISMATCH", "visual_set_sha256");
	}
	if (candidate.review_authority_sha256 !== context.review_authority_sha256) {
		throw new ApprovalDossierVerificationError("REVIEW_AUTHORITY_MISMATCH", "review_authority_sha256");
	}
	return candidate;
}

function sameCanonicalCandidate(left: CandidateBinding, right: CandidateBinding): boolean {
	return candidateSha256(left) === candidateSha256(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;
}

function throwHtmlPayloadError(error: unknown): never {
	if (error instanceof ApprovalDossierHtmlPayloadError) {
		throw new ApprovalDossierVerificationError(error.code, error.path);
	}
	throw new ApprovalDossierVerificationError("INVALID_HTML", "payload");
}

function decodeHtml(html: string | Uint8Array): Readonly<{ bytes: Uint8Array; source: string }> {
	const bytes = typeof html === "string" ? Buffer.from(html, "utf8") : Uint8Array.from(html);
	if (bytes.byteLength > MAX_IMPORTED_HTML_BYTES) throw new ApprovalDossierVerificationError("INVALID_HTML", "bytes");
	try {
		return Object.freeze({ bytes, source: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
	} catch {
		throw new ApprovalDossierVerificationError("INVALID_HTML", "utf8");
	}
}

/** The candidate has the sole initial, no-feedback draft payload. */
function verifyCanonicalCandidateBaseline(html: string | Uint8Array, candidate: CandidateBinding): string {
	const { source } = decodeHtml(html);
	assertDeterministicDossierEnvelope(source);
	let approval: ApprovalResponse;
	try {
		approval = extractProtectedApprovalPayload(source);
	} catch (error) {
		throwHtmlPayloadError(error);
	}
	assertApprovalCandidate(approval, candidate);
	if (
		approval.approval_status !== "draft" ||
		approval.approved_at !== null ||
		approval.feedback.length !== 0 ||
		approval.declaration !== APPROVAL_DECLARATION
	) {
		throw new ApprovalDossierVerificationError("DOSSIER_ENVELOPE_INVALID", "candidate_html");
	}
	verifiedMarkdownFiles(source, approval);
	return source;
}

function assertApprovalCandidate(approval: ApprovalResponse, candidate: CandidateBinding): void {
	if (
		approval.candidate_sha256 !== candidateSha256(candidate) ||
		!sameCanonicalCandidate(approval.candidate, candidate)
	) {
		throw new ApprovalDossierVerificationError("CANDIDATE_MISMATCH", "candidate");
	}
}

function verifiedMarkdownFiles(
	source: string,
	approval: ApprovalResponse,
): readonly Readonly<{ path: string; bytes: Uint8Array }>[] {
	let visible: readonly VisibleMarkdownPayload[];
	try {
		visible = extractVisibleMarkdownPayloads(source);
	} catch (error) {
		throwHtmlPayloadError(error);
	}
	if (visible.length !== approval.files.length) {
		throw new ApprovalDossierVerificationError("VISIBLE_MARKDOWN_MISMATCH", "visible-markdown");
	}
	const visibleByPath = new Map(visible.map(entry => [entry.path, entry]));
	const markdownFiles: Readonly<{ path: string; bytes: Uint8Array }>[] = [];
	for (const file of approval.files) {
		const projection = visibleByPath.get(file.path);
		if (!projection || projection.sha256 !== file.sha256 || projection.byte_count !== file.byte_count) {
			throw new ApprovalDossierVerificationError("VISIBLE_MARKDOWN_MISMATCH", file.path);
		}
		const protectedBytes = decodeProtectedMarkdown(file);
		if (!sameBytes(protectedBytes, projection.bytes)) {
			throw new ApprovalDossierVerificationError("VISIBLE_MARKDOWN_MISMATCH", file.path);
		}
		markdownFiles.push(Object.freeze({ path: file.path, bytes: Uint8Array.from(protectedBytes) }));
	}
	return Object.freeze(markdownFiles);
}

/** Replaces only the validated base64 payload text; every other UTF-8 byte remains bound. */
function normalizeProtectedPayload(source: string): string {
	const opening =
		'<template id="approval-dossier-protected-state" data-approval-dossier-encoding="base64-canonical-json">';
	const start = source.indexOf(opening);
	const contentStart = start + opening.length;
	const end = source.indexOf("</template>", contentStart);
	if (start < 0 || end < 0)
		throw new ApprovalDossierVerificationError("DOSSIER_ENVELOPE_INVALID", "protected-payload");
	return `${source.slice(0, contentStart)}__APPROVAL_DOSSIER_PROTECTED_PAYLOAD__${source.slice(end)}`;
}

/**
 * Saved responses may replace only the base64 protected payload. Everything
 * executable is pinned to the shared renderer's authored bytes; this prevents
 * a payload copied into a hand-built or active-content wrapper becoming durable
 * approval evidence.
 */
function assertDeterministicDossierEnvelope(source: string): void {
	const css = templateSource("dossier.css");
	const javascript = templateSource("dossier.js");
	const csp = contentSecurityPolicy(css, javascript);
	const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
	const protectedPayloadTag =
		'<template id="approval-dossier-protected-state" data-approval-dossier-encoding="base64-canonical-json">';
	const canonicalMetaTags = [
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		cspTag,
	];
	const styleTag = `<style id="${APPROVAL_DOSSIER_STYLE_ID}">${css}</style>`;
	const scriptTag = `<script id="${APPROVAL_DOSSIER_APP_ID}">${javascript}</script>`;
	// Inspect document markup only; authored script strings may contain literal tag examples.
	const inert = source.replace(styleTag, "").replace(scriptTag, "");
	const metaTags = inert.match(/<meta\b[^>]*>/gi) ?? [];
	const templateTags = inert.match(/<template\b[^>]*>/gi) ?? [];
	if (
		!source.startsWith(
			'<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n',
		) ||
		source.includes("\r") ||
		!source.endsWith("</html>\n") ||
		count(inert, '<meta http-equiv="Content-Security-Policy"') !== 1 ||
		metaTags.length !== canonicalMetaTags.length ||
		metaTags.some((tag, index) => tag !== canonicalMetaTags[index]) ||
		templateTags.length !== 1 ||
		templateTags[0] !== protectedPayloadTag ||
		count(inert, "</template>") !== 1 ||
		!inert.includes('<main id="dossier"') ||
		!inert.includes('id="approval-dossier-controls"') ||
		!inert.includes("<noscript>") ||
		!inert.includes("data-review-item") ||
		count(inert, cspTag) !== 1 ||
		count(source, styleTag) !== 1 ||
		count(source, scriptTag) !== 1
	) {
		throw new ApprovalDossierVerificationError("DOSSIER_ENVELOPE_INVALID", "envelope");
	}

	// The only authorized executable blocks were removed before markup inspection.
	if (
		/<\/?(?:script|style|base|link|object|embed|iframe|frame|portal|applet|form|img|video|audio|source|track|animate|set|foreignObject)\b/i.test(
			inert,
		) ||
		/\bon[a-z0-9_-]+\s*=/i.test(inert) ||
		/\bsrcdoc\s*=/i.test(inert)
	) {
		throw new ApprovalDossierVerificationError("DOSSIER_ENVELOPE_INVALID", "active-content");
	}
	assertNoExternalUrlAttributes(inert);
}

function assertNoExternalUrlAttributes(source: string): void {
	const attributes =
		/\b(src|href|action|formaction|poster|data|cite|background|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
	for (let match = attributes.exec(source); match !== null; match = attributes.exec(source)) {
		const name = (match[1] as string).toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		if (name !== "href" || !value.startsWith("#")) {
			throw new ApprovalDossierVerificationError("DOSSIER_ENVELOPE_INVALID", "external-url");
		}
	}
}

function templateSource(name: "dossier.css" | "dossier.js"): string {
	return readFileSync(fileURLToPath(new URL(`../templates/${name}`, import.meta.url)), "utf8");
}

function count(source: string, needle: string): number {
	let total = 0;
	let start = 0;
	while (true) {
		const index = source.indexOf(needle, start);
		if (index === -1) return total;
		total += 1;
		start = index + needle.length;
	}
}
