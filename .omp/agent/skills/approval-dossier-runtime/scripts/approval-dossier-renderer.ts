import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateSha256,
  validateApprovalFeedbackTarget,
  validateApprovalResponse,
  validateCandidateBinding,
  validateVisualSet,
} from "../schemas/approval-dossier.ts";
import type {
  ApprovalDossierReviewPresentation,
  ApprovalFeedbackTarget,
  ApprovalResponse,
  CandidateBinding,
  VisualSet,
} from "../schemas/approval-dossier.ts";
import {
  decodeProtectedMarkdown,
  encodeProtectedApprovalPayload,
  encodeVisibleMarkdownProjection,
} from "./approval-dossier-html.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  projectNativeVisual,
  projectNativeVisualFallback,
  validateNativeVisuals,
} from "./native-svg-projector.ts";
import type { NativeVisual } from "./native-svg-projector.ts";

export const APPROVAL_DOSSIER_STYLE_ID = "approval-dossier-style" as const;
export const APPROVAL_DOSSIER_APP_ID = "approval-dossier-app" as const;
export const MAX_APPROVAL_DOSSIER_HTML_BYTES = 4 * 1_024 * 1_024;

export interface ApprovalDossierRendererManifest {
  readonly schema: "approval-dossier/renderer-manifest/v1";
  readonly entries: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

/** The renderer module is the sole code root; static imports determine all code dependencies. */
const APPROVAL_DOSSIER_RENDERER_ROOT_PATH = "scripts/approval-dossier-renderer.ts";
/**
 * Every byte in these templates is embedded in the rendered dossier envelope.
 * Template references are declarations, not code imports, and are therefore
 * included beside the complete static code-import closure.
 */
const APPROVAL_DOSSIER_RENDERER_TEMPLATE_PATHS = Object.freeze([
  "templates/dossier.html",
  "templates/dossier.css",
  "templates/dossier.js",
] as const);
const DETERMINISTIC_NODE_IMPORTS: Record<string, true> = {
  "node:crypto": true,
  "node:fs/promises": true,
  "node:path": true,
  "node:url": true,
};
export interface ApprovalDossierRendererSnapshot {
  readonly shell: string;
  readonly css: string;
  readonly javascript: string;
  readonly manifest: ApprovalDossierRendererManifest;
  readonly sha256: string;
}
export interface ApprovalDossierReviewPresentationInput {
  readonly target_id: string;
  readonly presentation: ApprovalDossierReviewPresentation;
}

export interface ApprovalDossierFeedbackTarget {
  readonly target: ApprovalFeedbackTarget;
  readonly label: string;
  readonly context: string;
  readonly unresolved: boolean;
}
export interface ApprovalDossierRendererInput {
  readonly title: string;
  readonly candidate: CandidateBinding;
  readonly approval: ApprovalResponse;
  readonly visual_set: VisualSet;
  readonly visuals: readonly NativeVisual[];
  readonly feedback_targets: readonly ApprovalDossierFeedbackTarget[];
  readonly review_presentations: readonly ApprovalDossierReviewPresentationInput[];
}

export interface RenderedApprovalDossier {
  readonly html: string;
  readonly bytes: Uint8Array;
  readonly candidate_sha256: string;
  readonly renderer_sha256: string;
}
export async function loadApprovalDossierRendererSnapshot(): Promise<ApprovalDossierRendererSnapshot> {
  return loadApprovalDossierRendererSnapshotFromRuntimeRoot(
    approvalDossierRuntimeRoot(),
  );
}

/**
 * Scans the renderer's static import graph from its code root and binds every
 * declared template byte. This explicit-root variant keeps identity testing
 * independent of the installed runtime location.
 */
export async function loadApprovalDossierRendererSnapshotFromRuntimeRoot(
  runtimeRoot: string,
): Promise<ApprovalDossierRendererSnapshot> {
  const componentBytes = await loadRendererComponentBytes(runtimeRoot);
  const entries = Object.freeze(
    [...componentBytes]
      .map(([path, bytes]) =>
        Object.freeze({
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      )
      .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
  );
  const manifest = Object.freeze({
    schema: "approval-dossier/renderer-manifest/v1" as const,
    entries,
  });
  return Object.freeze({
    shell: componentBytes.get("templates/dossier.html")!.toString("utf8"),
    css: componentBytes.get("templates/dossier.css")!.toString("utf8"),
    javascript: componentBytes.get("templates/dossier.js")!.toString("utf8"),
    manifest,
    sha256: createHash("sha256").update(canonicalJson(manifest)).digest("hex"),
  });
}

/** Produces a self-contained offline candidate without clocks, network, DOM, or mutable renderer state. */
export async function renderApprovalDossier(
  input: ApprovalDossierRendererInput,
  suppliedSnapshot?: ApprovalDossierRendererSnapshot,
): Promise<RenderedApprovalDossier> {
  const snapshot =
    suppliedSnapshot ?? (await loadApprovalDossierRendererSnapshot());
  const title = nonEmptyText(input.title, "title");
  const candidate = validateCandidateBinding(input.candidate);
  const approval = validateApprovalResponse(input.approval);
  const visualSet = validateVisualSet(input.visual_set);
  await validateSnapshot(snapshot);
  if (
    candidateSha256(candidate) !== approval.candidate_sha256 ||
    candidateSha256(candidate) !== candidateSha256(approval.candidate)
  )
    throw new TypeError("approval does not bind the supplied candidate");
  if (candidate.visual_set_sha256 !== visualSet.visual_set_sha256)
    throw new TypeError("candidate does not bind the supplied visual set");
  const visuals = validateNativeVisuals(input.visuals);
  const feedbackTargets = validateFeedbackTargets(input.feedback_targets);
  const presentations = validateReviewPresentations(
    feedbackTargets,
    input.review_presentations,
  );
  const files = approval.files;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const candidateFile = candidate.files[index];
    if (
      !candidateFile ||
      candidateFile.path !== file.path ||
      candidateFile.sha256 !== file.sha256 ||
      candidateFile.byte_count !== file.byte_count
    )
      throw new TypeError("protected Markdown does not match candidate");
    decodeProtectedMarkdown(file);
  }
  assertVisualBinding(visualSet, visuals);
  const csp = contentSecurityPolicy(snapshot.css, snapshot.javascript);
  const authorityHtml = `<section id="authority" aria-labelledby="authority-heading"><h2 id="authority-heading">Authority binding</h2><div class="callout reading-measure"><p>The candidate, runtime binding, semantic hash, and exact Markdown are protected. Browser controls save only a closed approval response; they cannot alter publication bytes.</p><dl class="authority-grid"><div><dt>Candidate SHA-256</dt><dd class="hash"><code>${candidateSha256(candidate)}</code></dd></div><div><dt>Runtime SHA-256</dt><dd class="hash"><code>${escapeHtml(candidate.runtime_sha256)}</code></dd></div><div><dt>Markdown bundle SHA-256</dt><dd class="hash"><code>${escapeHtml(candidate.bundle_sha256)}</code></dd></div><div><dt>Visual set SHA-256</dt><dd class="hash"><code>${escapeHtml(candidate.visual_set_sha256)}</code></dd></div></dl></div></section>`;
  const markdownHtml = `<section id="markdown" aria-labelledby="markdown-heading"><h2 id="markdown-heading">Exact Markdown files</h2><p class="reading-measure">These are the exact UTF-8 Markdown bytes bound to this candidate and visible without JavaScript.</p>${files.map((file) => markdownFileHtml(file.path, file.sha256, file.byte_count, approval.approval_status, encodeVisibleMarkdownProjection(file))).join("\n")}</section>`;
  const visualHtml = `<section id="visuals" aria-labelledby="visuals-heading"><h2 id="visuals-heading">Bound visual aids</h2><p class="reading-measure">Each optional aid comes from the bounded native-SVG vocabulary and has an adjacent textual equivalent.</p>${
    visuals.length === 0
      ? '<p class="empty-note">No candidate-bound visual aid was supplied. The review-coverage map above remains a navigation aid only.</p>'
      : visuals
          .map((visual) => {
            try {
              return projectNativeVisual(visual);
            } catch {
              return projectNativeVisualFallback(visual);
            }
          })
          .join("\n")
  }</section>`;
  const reviewHtml = reviewWorkspaceHtml(feedbackTargets, presentations);
  const unresolvedCount = feedbackTargets.filter(
    (entry) => entry.unresolved,
  ).length;
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<title>${escapeHtml(title)}</title>\n<style id="${APPROVAL_DOSSIER_STYLE_ID}">${snapshot.css}</style>\n</head>\n<body>\n${encodeProtectedApprovalPayload(approval)}\n<a class="skip-link" href="#review">Skip to review workspace</a>\n<header class="site-header"><div class="wrap header-inner"><div><p class="eyebrow">Approval dossier · ${escapeHtml(candidate.workflow)} · revision ${candidate.revision}</p><h1>${escapeHtml(title)}</h1><p class="header-summary">A bounded, offline review workspace for the exact candidate below.</p></div><dl class="header-stats"><div><dt>Review items</dt><dd>${feedbackTargets.length}</dd></div><div><dt>Unresolved</dt><dd>${unresolvedCount}</dd></div><div><dt>Revision</dt><dd>${candidate.revision}</dd></div></dl></div></header>\n<main id="dossier" class="wrap"><nav class="anchor-nav no-print" aria-label="Dossier sections"><a href="#overview">Overview</a><a href="#review">Decision review</a><a href="#source">Source &amp; authority</a></nav>\n<section id="overview" class="overview" aria-labelledby="overview-heading"><div class="section-heading"><p class="eyebrow">Recommended review route</p><h2 id="overview-heading">Review one bounded decision at a time</h2><p class="reading-measure">Use the queue to isolate a goal, criterion, decision, assumption, or ambiguity. Read its context, record a precise change when needed, then close the dossier with one final action.</p></div>${reviewMapHtml(feedbackTargets)}</section>\n${reviewHtml}\n<details id="source" class="source-drawer"><summary><span>Source, evidence, and exact Markdown</span><span class="metadata">Protected reference material</span></summary><div class="source-drawer-content">${authorityHtml}${visualHtml}${markdownHtml}</div></details>\n</main>\n<script id="${APPROVAL_DOSSIER_APP_ID}">${snapshot.javascript}</script>\n</body>\n</html>\n`;
  const bytes = Buffer.from(html, "utf8");
  if (bytes.byteLength > MAX_APPROVAL_DOSSIER_HTML_BYTES)
    throw new RangeError("approval dossier exceeds 4 MiB");
  assertEnvelope(html, csp, files.length);
  return Object.freeze({
    html,
    bytes: Uint8Array.from(bytes),
    candidate_sha256: candidateSha256(candidate),
    renderer_sha256: snapshot.sha256,
  });
}

export function contentSecurityPolicy(css: string, javascript: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${sha256Base64(javascript)}'`,
    `style-src 'sha256-${sha256Base64(css)}'`,
    "script-src-attr 'none'",
    "style-src-attr 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Names saved responses only from candidate-bound values; it never reads a clock. */
export function approvalResponseFilename(
  candidate: CandidateBinding,
  status: ApprovalResponse["approval_status"],
): string {
  const validated = validateCandidateBinding(candidate);
  const stem =
    `${validated.workflow}-${validated.run_id}-r${String(validated.revision).padStart(4, "0")}`.replace(
      /[^A-Za-z0-9._-]/g,
      "-",
    );
  return `${stem}-${status}-${candidateSha256(validated).slice(0, 12)}.html`;
}

function assertVisualBinding(
  visualSet: VisualSet,
  visuals: readonly NativeVisual[],
): void {
  if (visualSet.visuals.length !== visuals.length)
    throw new TypeError("visual projection count does not match visual set");
  for (let index = 0; index < visuals.length; index += 1) {
    const expected = visualSet.visuals[index];
    const actual = visuals[index];
    if (
      !expected ||
      !actual ||
      expected.visual_id !== actual.visual_id ||
      expected.type !== actual.type ||
      expected.sha256 !== actual.sha256
    )
      throw new TypeError("visual projection does not match visual set");
  }
}

function markdownFileHtml(
  path: string,
  sha256: string,
  byteCount: number,
  approvalStatus: ApprovalResponse["approval_status"],
  projection: string,
): string {
  const searchText = `${path} ${sha256}`.toLowerCase();
  return `<article class="markdown-file" data-review-item data-unresolved="${approvalStatus !== "approved"}" data-search-text="${escapeAttribute(searchText)}"><header><h3 class="path"><code>${escapeHtml(path)}</code></h3><p class="metadata hash">SHA-256: ${escapeHtml(sha256)} · ${byteCount} bytes</p></header>${projection}</article>`;
}

function reviewWorkspaceHtml(
  targets: readonly ApprovalDossierFeedbackTarget[],
  presentations: ReadonlyMap<string, ApprovalDossierReviewPresentation>,
): string {
  if (targets.length === 0)
    return `<section id="review" aria-labelledby="review-heading"><div class="section-heading"><p class="eyebrow">Decision Navigator</p><h2 id="review-heading">Review workspace</h2></div><div class="empty-workspace"><h3>No bounded review items</h3><p>This candidate has no feedback targets. Open the source drawer to inspect its exact Markdown and authority binding.</p></div><div id="approval-dossier-controls" class="controls" data-testid="final-actions"><noscript><p>JavaScript is disabled. The protected source remains visible below.</p></noscript></div></section>`;
  return `<section id="review" aria-labelledby="review-heading"><div class="section-heading review-heading"><div><p class="eyebrow">Decision Navigator</p><h2 id="review-heading">Review workspace</h2></div><p class="reading-measure">The queue, focused decision, and reviewer input stay separate so context never competes with the response form.</p></div><div class="mobile-review-tabs no-print"><button id="mobile-review-tab-queue" type="button" data-mobile-review-tab="queue">Queue</button><button id="mobile-review-tab-review" type="button" data-mobile-review-tab="review">Review</button><button id="mobile-review-tab-feedback" type="button" data-mobile-review-tab="feedback">Feedback</button><button id="mobile-review-tab-notes" type="button" data-mobile-review-tab="notes">Context</button></div><noscript><p class="no-js-review-notice">JavaScript is disabled. Every bound review item, comparison, feedback field, authority binding, and exact source remains available below for complete static review. Saving a response requires JavaScript.</p></noscript><div class="review-workspace">${reviewQueueHtml(targets, presentations)}${reviewSummariesHtml(targets, presentations)}<section id="review-pane-feedback" class="feedback-panel" data-review-pane="feedback" data-testid="feedback-editor"><div class="panel-heading"><div><p class="eyebrow">Reviewer input</p><h3>Typed feedback</h3></div><span class="navigation-badge">Optional until edit or proposal</span></div>${feedbackEditorsHtml(targets)}</section><section id="review-pane-notes" class="review-notes" data-review-pane="notes">${reviewMapHtml(targets)}</section></div><div id="approval-dossier-controls" class="controls" data-testid="final-actions"><noscript><p>JavaScript is disabled. The complete static review above cannot save an approval response.</p></noscript></div></section>`;
}

function reviewQueueHtml(
  targets: readonly ApprovalDossierFeedbackTarget[],
  presentations: ReadonlyMap<string, ApprovalDossierReviewPresentation>,
): string {
  return `<nav id="review-pane-queue" class="review-queue" data-review-pane="queue" data-testid="primary-navigation"><div class="panel-heading queue-heading"><div><p class="eyebrow">Review queue</p><h3>Bound items</h3></div><p class="progress" data-testid="progress"><strong data-progress-current>1</strong> / ${targets.length}</p></div><label class="queue-search"><span>Find an item</span><input type="search" autocomplete="off" placeholder="Search titles and context" data-review-search></label><div class="review-item-list">${targets.map((entry, index) => { const target = validateApprovalFeedbackTarget(entry.target); return reviewQueueItemHtml(entry, index, presentations.get(feedbackTargetId(target))!); }).join("")}</div></nav>`;
}

function reviewQueueItemHtml(
  entry: ApprovalDossierFeedbackTarget,
  index: number,
  presentation: ApprovalDossierReviewPresentation,
): string {
  const id = feedbackId(index);
  const target = validateApprovalFeedbackTarget(entry.target);
  const searchParts = [entry.label, entry.context, feedbackTargetText(target)];
  const keyPointsHtml =
    presentation.kind === "four-option-decision"
      ? `<ul class="review-item-key-points">${presentation.key_points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>`
      : "";
  if (presentation.kind === "four-option-decision")
    searchParts.push(...presentation.key_points);
  const searchText = searchParts.join(" ").toLowerCase();
  return `<button type="button" class="review-item-button" data-review-select="${id}" data-search-text="${escapeAttribute(searchText)}" aria-controls="review-summary-${id} ${id}" aria-current="${index === 0 ? "step" : "false"}"><span class="review-item-index">${String(index + 1).padStart(2, "0")}</span><span class="review-item-copy"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(feedbackTargetText(target))}</small>${keyPointsHtml}</span><span class="review-item-state" data-item-state>${entry.unresolved ? "Open" : "Ready"}</span></button>`;
}

function reviewSummariesHtml(
  targets: readonly ApprovalDossierFeedbackTarget[],
  presentations: ReadonlyMap<string, ApprovalDossierReviewPresentation>,
): string {
  return `<article id="review-pane-review" class="review-focus" data-review-pane="review" data-testid="current-item">${targets.map((entry, index) => { const id = feedbackId(index); const target = validateApprovalFeedbackTarget(entry.target); const presentation = presentations.get(feedbackTargetId(target))!; return `<section id="review-summary-${id}" class="review-summary" data-review-summary="${id}"><p class="eyebrow">Item ${String(index + 1).padStart(2, "0")} · ${escapeHtml(reviewCategory(target))}</p><h3>${escapeHtml(entry.label)}</h3><p class="review-context">${escapeHtml(entry.context)}</p>${reviewPresentationHtml(presentation)}<dl class="review-brief"><div><dt>Bound target</dt><dd>${escapeHtml(feedbackTargetText(target))}</dd></div><div><dt>Review question</dt><dd>Is this statement accurate, sufficiently bounded, and ready to carry forward?</dd></div></dl><div class="disposition-row" role="group" aria-label="Item disposition"><button type="button" data-item-disposition="accepted">No change</button><button type="button" data-item-disposition="edit">Request edit</button><button type="button" data-item-disposition="proposal">Add proposal</button></div><p class="status-line" data-item-note>Choose a disposition. Edit and proposal open the reviewer-input pane.</p></section>`; }).join("")}</article>`;
}

function reviewPresentationHtml(
  presentation: ApprovalDossierReviewPresentation,
): string {
  if (presentation.kind === "context-only")
    return `<p class="empty-note">This bounded target has contextual review metadata only.</p>`;
  const dependencies = presentation.dependency_target_ids.length === 0 ? "None" : presentation.dependency_target_ids.join(", ");
  const recommendation = presentation.options.find((option) => option.option_id === presentation.recommended_option_id)!;
  const optionRows = [
    ["Mechanism or output", (option: typeof recommendation) => option.mechanism_or_output],
    ["Benefit", (option: typeof recommendation) => option.benefit],
    ["Omission cost or uncertainty", (option: typeof recommendation) => option.omission_cost_or_uncertainty],
    ["Downstream consequence", (option: typeof recommendation) => option.downstream_consequence],
    ["Evidence", (option: typeof recommendation) => option.evidence_ids.join(", ")],
  ] as const;
  return `<section class="review-presentation"><dl class="review-brief"><div><dt>Purpose</dt><dd>${escapeHtml(presentation.purpose)}</dd></div><div><dt>Why it matters</dt><dd>${escapeHtml(presentation.why_it_matters)}</dd></div><div><dt>System position</dt><dd>${escapeHtml(presentation.system_position)}</dd></div><div><dt>Dependencies</dt><dd>${escapeHtml(dependencies)}</dd></div><div><dt>Uncertainty</dt><dd>${escapeHtml(presentation.uncertainty)}</dd></div></dl><h4>Key points</h4><ul>${presentation.key_points.slice(0, 3).map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul><h4>Research</h4><ul>${presentation.research_summary.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul><h4>Options compared</h4><div class="review-option-comparison" role="region" aria-label="Comparable decision options"><table><thead><tr><th scope="col">Comparison</th>${presentation.options.map((option) => `<th scope="col" class="review-option" data-option-label="${escapeAttribute(`${option.option_id} — ${option.label}`)}">${escapeHtml(option.option_id)} — ${escapeHtml(option.label)}</th>`).join("")}</tr></thead><tbody>${optionRows.map(([label, value]) => `<tr><th scope="row">${label}</th>${presentation.options.map((option) => `<td data-option-label="${escapeAttribute(`${option.option_id} — ${option.label}`)}">${escapeHtml(value(option))}</td>`).join("")}</tr>`).join("")}</tbody></table></div><aside class="option-recommendation" aria-label="Recommendation after option comparison"><h4>Recommendation</h4><p><strong>${escapeHtml(recommendation.option_id)} — ${escapeHtml(recommendation.label)}</strong></p><p>${escapeHtml(presentation.recommendation_rationale)}</p></aside></section>`;
}

function feedbackEditorsHtml(
  targets: readonly ApprovalDossierFeedbackTarget[],
): string {
  return targets
    .map((entry, index) => {
      const target = validateApprovalFeedbackTarget(entry.target);
      const id = feedbackId(index);
      const searchText =
        `${entry.label} ${entry.context} ${feedbackTargetText(target)}`.toLowerCase();
      const kindHelpId = `${id}-feedback-kind-help`;
      const requestedChangeHelpId = `${id}-requested-change-help`;
      const rationaleHelpId = `${id}-rationale-help`;
      const evidenceIdsHelpId = `${id}-evidence-ids-help`;
      return `<article id="${id}" class="feedback-editor" data-review-item data-unresolved="${entry.unresolved}" data-search-text="${escapeAttribute(searchText)}" data-feedback-editor="${id}" data-feedback-id="${id}" data-feedback-target="${encodeFeedbackTarget(target)}"><h4>${escapeHtml(entry.label)}</h4><p class="metadata">Feedback is saved only for ${escapeHtml(feedbackTargetText(target))}.</p><p class="empty-note feedback-prompt" data-feedback-prompt>Choose Request edit or Add proposal in the review pane to open this item's response fields.</p><div class="feedback-fields" data-feedback-fields><p class="conditional-required" data-feedback-required hidden role="status">Requested change and rationale are required when requesting an edit or adding a proposal.</p><label>Feedback kind<select aria-describedby="${kindHelpId}" data-feedback-kind><option value="edit">Decision edit</option><option value="proposal">Proposal</option></select><span id="${kindHelpId}" class="optional">Optional until feedback is requested. Use a pointer or keyboard to choose a kind.</span></label><label>Requested change<textarea aria-describedby="${requestedChangeHelpId}" data-feedback-requested-change placeholder="State the exact change needed"></textarea><span id="${requestedChangeHelpId}" class="optional">Optional until feedback is requested. Use a pointer or keyboard to enter the exact change.</span></label><label>Rationale<textarea aria-describedby="${rationaleHelpId}" data-feedback-rationale placeholder="Explain why this change improves the candidate"></textarea><span id="${rationaleHelpId}" class="optional">Optional until feedback is requested. Use a pointer or keyboard to explain the rationale.</span></label><label>Evidence IDs<input type="text" aria-describedby="${evidenceIdsHelpId}" autocomplete="off" data-feedback-evidence-ids placeholder="evidence-1, evidence-2"><span id="${evidenceIdsHelpId}" class="optional">Optional. Use a pointer or keyboard to enter comma-separated evidence IDs.</span></label><button type="button" class="clear-feedback" data-clear-feedback>Clear feedback and mark no change</button></div><p class="metadata">${escapeHtml(entry.context)}</p></article>`;
    })
    .join("");
}

function reviewMapHtml(
  targets: readonly ApprovalDossierFeedbackTarget[],
): string {
  const categories = [
    "Goal",
    "Criterion",
    "Decision",
    "Assumption",
    "Ambiguity",
    "Document",
  ];
  const counts = new Map(categories.map((category) => [category, 0]));
  for (const entry of targets) {
    const category = reviewCategory(
      validateApprovalFeedbackTarget(entry.target),
    );
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const visible = categories
    .map((category) => [category, counts.get(category) ?? 0] as const)
    .filter(([, count]) => count > 0);
  if (visible.length === 0)
    return `<p class="empty-note">No review route is available because the candidate has no bounded feedback targets.</p>`;
  const width = 720;
  const spacing = width / visible.length;
  const nodes = visible
    .map(([category, count], index) => {
      const x = Math.round(spacing * index + spacing / 2);
      return `<g><circle cx="${x}" cy="56" r="28"></circle><text x="${x}" y="53" text-anchor="middle">${count}</text><text x="${x}" y="92" text-anchor="middle">${escapeHtml(category)}</text></g>`;
    })
    .join("");
  const lines = visible
    .slice(1)
    .map((_, index) => {
      const first = Math.round(spacing * index + spacing / 2 + 28);
      const second = Math.round(spacing * (index + 1) + spacing / 2 - 28);
      return `<line x1="${first}" y1="56" x2="${second}" y2="56"></line>`;
    })
    .join("");
  const textual = visible
    .map(([category, count]) => `${category}: ${count}`)
    .join(" · ");
  return `<figure class="review-map"><div class="review-map-heading"><div><p class="eyebrow">Review coverage</p><h3>Candidate decision map</h3></div><span class="navigation-badge">Navigation aid only</span></div><svg class="review-map-svg" viewBox="0 0 ${width} 112" role="img" aria-labelledby="review-map-title review-map-description"><title id="review-map-title">Review items grouped by semantic category</title><desc id="review-map-description">${escapeHtml(textual)}</desc>${lines}${nodes}</svg><figcaption><strong>Text equivalent:</strong> ${escapeHtml(textual)}.</figcaption></figure>`;
}

function reviewCategory(target: ApprovalFeedbackTarget): string {
  if (
    target.target_type === "markdown-path" ||
    target.target_type === "dossier"
  )
    return "Document";
  const prefix = target.semantic_id.match(/^([GCDUA])\d/i)?.[1]?.toUpperCase();
  return (
    (
      {
        G: "Goal",
        C: "Criterion",
        D: "Decision",
        A: "Assumption",
        U: "Ambiguity",
      } as const
    )[prefix as "G" | "C" | "D" | "A" | "U"] ?? "Decision"
  );
}

function validateReviewPresentations(
  targets: readonly ApprovalDossierFeedbackTarget[],
  value: readonly ApprovalDossierReviewPresentationInput[],
): ReadonlyMap<string, ApprovalDossierReviewPresentation> {
  if (!Array.isArray(value) || value.length !== targets.length)
    throw new TypeError(
      "review presentations must align one-to-one with feedback targets",
    );
  const presentations = new Map<string, ApprovalDossierReviewPresentation>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2
    )
      throw new TypeError("review presentation metadata is invalid");
    const targetId = boundedText(
      entry.target_id,
      "review presentation target ID",
      128,
    );
    const presentation = validateReviewPresentation(entry.presentation);
    if (presentations.has(targetId))
      throw new TypeError("review presentation target IDs must be unique");
    presentations.set(targetId, presentation);
  }
  for (const target of targets) {
    const targetId = feedbackTargetId(
      validateApprovalFeedbackTarget(target.target),
    );
    if (!presentations.has(targetId))
      throw new TypeError(
        "review presentation target does not match a feedback target",
      );
  }
  return presentations;
}

function feedbackTargetId(target: ApprovalFeedbackTarget): string {
  if (target.target_type === "semantic-id") return target.semantic_id;
  if (target.target_type === "markdown-path") return target.markdown_path;
  return "dossier";
}

function validateReviewPresentation(
  value: unknown,
): ApprovalDossierReviewPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("review presentation is invalid");
  const data = value as Record<string, unknown>;
  if (data.kind === "context-only" && Object.keys(data).length === 1)
    return Object.freeze({ kind: "context-only" });
  if (data.kind !== "four-option-decision")
    throw new TypeError("review presentation kind is invalid");
  const keys = [
    "kind",
    "purpose",
    "why_it_matters",
    "system_position",
    "dependency_target_ids",
    "key_points",
    "research_summary",
    "options",
    "recommended_option_id",
    "recommendation_rationale",
    "uncertainty",
  ];
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !(key in data))
  )
    throw new TypeError("four-option review presentation is invalid");
  const dependencyTargetIds = boundedIdList(
    data.dependency_target_ids,
    "review presentation dependencies",
    128,
    true,
  );
  const keyPoints = boundedTextList(
    data.key_points,
    "review presentation key points",
    1,
    3,
    4_096,
  );
  const researchSummary = boundedTextList(
    data.research_summary,
    "review presentation research",
    1,
    128,
    4_096,
  );
  if (!Array.isArray(data.options) || data.options.length !== 4)
    throw new TypeError("review presentation requires exactly four options");
  const options = data.options.map((option, index) =>
    validateDecisionOption(option, index),
  );
  if (
    new Set(options.map((option) => option.option_id)).size !== options.length
  )
    throw new TypeError("review presentation option IDs must be unique");
  const recommendedOptionId = boundedText(
    data.recommended_option_id as string,
    "recommended option ID",
    128,
  );
  if (!options.some((option) => option.option_id === recommendedOptionId))
    throw new TypeError("recommended option is not one of the four options");
  return Object.freeze({
    kind: "four-option-decision",
    purpose: boundedText(
      data.purpose as string,
      "review presentation purpose",
      4_096,
    ),
    why_it_matters: boundedText(
      data.why_it_matters as string,
      "review presentation why it matters",
      4_096,
    ),
    system_position: boundedText(
      data.system_position as string,
      "review presentation system position",
      4_096,
    ),
    dependency_target_ids: dependencyTargetIds,
    key_points: keyPoints as [string, ...string[]],
    research_summary: researchSummary as [string, ...string[]],
    options: options as [
      (typeof options)[number],
      (typeof options)[number],
      (typeof options)[number],
      (typeof options)[number],
    ],
    recommended_option_id: recommendedOptionId,
    recommendation_rationale: boundedText(
      data.recommendation_rationale as string,
      "review presentation recommendation rationale",
      4_096,
    ),
    uncertainty: boundedText(
      data.uncertainty as string,
      "review presentation uncertainty",
      4_096,
    ),
  });
}

function validateDecisionOption(value: unknown, index: number) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("review option is invalid");
  const data = value as Record<string, unknown>;
  const keys = [
    "option_id",
    "label",
    "mechanism_or_output",
    "benefit",
    "omission_cost_or_uncertainty",
    "downstream_consequence",
    "evidence_ids",
  ];
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !(key in data))
  )
    throw new TypeError("review option is invalid");
  return Object.freeze({
    option_id: boundedText(
      data.option_id as string,
      `review option ${index + 1} ID`,
      128,
    ),
    label: boundedText(
      data.label as string,
      `review option ${index + 1} label`,
      4_096,
    ),
    mechanism_or_output: boundedText(
      data.mechanism_or_output as string,
      `review option ${index + 1} mechanism`,
      4_096,
    ),
    benefit: boundedText(
      data.benefit as string,
      `review option ${index + 1} benefit`,
      4_096,
    ),
    omission_cost_or_uncertainty: boundedText(
      data.omission_cost_or_uncertainty as string,
      `review option ${index + 1} omission cost`,
      4_096,
    ),
    downstream_consequence: boundedText(
      data.downstream_consequence as string,
      `review option ${index + 1} consequence`,
      4_096,
    ),
    evidence_ids: boundedIdList(
      data.evidence_ids,
      `review option ${index + 1} evidence`,
      128,
      false,
    ),
  });
}

function boundedTextList(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  maximumBytes: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new TypeError(`${name} count is invalid`);
  return Object.freeze(
    value.map((entry) => boundedText(entry as string, name, maximumBytes)),
  );
}

function boundedIdList(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty: boolean,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  )
    throw new TypeError(`${name} count is invalid`);
  const entries = value.map((entry) => boundedText(entry as string, name, 128));
  if (new Set(entries).size !== entries.length)
    throw new TypeError(`${name} must be unique`);
  return Object.freeze(entries);
}

function feedbackId(index: number): string {
  return `feedback-${String(index + 1).padStart(4, "0")}`;
}

function validateFeedbackTargets(
  value: readonly ApprovalDossierFeedbackTarget[],
): readonly ApprovalDossierFeedbackTarget[] {
  if (!Array.isArray(value))
    throw new TypeError("feedback targets are required");
  const bindings = new Set<string>();
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 4 ||
      !("target" in entry) ||
      !("label" in entry) ||
      !("context" in entry) ||
      !("unresolved" in entry)
    )
      throw new TypeError("feedback target metadata is invalid");
    const target = validateApprovalFeedbackTarget(entry.target);
    const binding = canonicalJson(target);
    if (bindings.has(binding))
      throw new TypeError("feedback target bindings must be unique");
    bindings.add(binding);
    if (typeof entry.unresolved !== "boolean")
      throw new TypeError("feedback target unresolved flag is invalid");
    return Object.freeze({
      target,
      label: boundedText(entry.label, "feedback target label", 512),
      context: boundedText(entry.context, "feedback target context", 4_096),
      unresolved: entry.unresolved,
    });
  });
}

function feedbackTargetText(target: ApprovalFeedbackTarget): string {
  if (target.target_type === "semantic-id")
    return `Semantic ID: ${target.semantic_id}`;
  if (target.target_type === "markdown-path")
    return `Markdown path: ${target.markdown_path}`;
  return "Entire dossier";
}

function encodeFeedbackTarget(target: ApprovalFeedbackTarget): string {
  return Buffer.from(canonicalJson(target), "utf8").toString("base64");
}

async function validateSnapshot(
  snapshot: ApprovalDossierRendererSnapshot,
): Promise<void> {
  if (snapshot.manifest.schema !== "approval-dossier/renderer-manifest/v1")
    throw new TypeError("renderer manifest is incomplete");
  if (
    snapshot.sha256 !==
    createHash("sha256").update(canonicalJson(snapshot.manifest)).digest("hex")
  )
    throw new TypeError(
      "renderer snapshot hash does not match exact manifested bytes",
    );
  const componentBytes = await loadRendererComponentBytes(
    approvalDossierRuntimeRoot(),
  );
  const expectedPaths = [...componentBytes.keys()].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  const manifestPaths = snapshot.manifest.entries.map((entry) => entry.path);
  if (canonicalJson(manifestPaths) !== canonicalJson(expectedPaths))
    throw new TypeError("renderer manifest is incomplete");
  for (const entry of snapshot.manifest.entries) {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256))
      throw new TypeError(`renderer manifest hash is invalid: ${entry.path}`);
    const actualSha256 = createHash("sha256")
      .update(componentBytes.get(entry.path)!)
      .digest("hex");
    if (actualSha256 !== entry.sha256)
      throw new TypeError(
        `renderer dependency bytes do not match manifest: ${entry.path}`,
      );
  }
  const activeBytes = new Map([
    ["templates/dossier.html", snapshot.shell],
    ["templates/dossier.css", snapshot.css],
    ["templates/dossier.js", snapshot.javascript],
  ]);
  for (const [path, active] of activeBytes) {
    const entry = snapshot.manifest.entries.find(
      (candidate) => candidate.path === path,
    )!;
    if (
      createHash("sha256").update(active, "utf8").digest("hex") !== entry.sha256
    )
      throw new TypeError(
        `renderer active bytes do not match manifest: ${path}`,
      );
  }
  if (
    snapshot.shell.length === 0 ||
    snapshot.css.length === 0 ||
    snapshot.javascript.length === 0
  )
    throw new TypeError("renderer snapshot is incomplete");
}

function approvalDossierRuntimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function loadRendererComponentBytes(
  runtimeRoot: string,
): Promise<ReadonlyMap<string, Buffer>> {
  const root = resolve(runtimeRoot);
  const pending = [APPROVAL_DOSSIER_RENDERER_ROOT_PATH];
  const entries = new Map<string, Buffer>();
  while (pending.length !== 0) {
    const path = pending.pop()!;
    if (entries.has(path)) continue;
    const bytes = await readFile(confinedRendererPath(root, path));
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertDeterministicRendererDependency(path, source);
    entries.set(path, bytes);
    for (const specifier of relativeImportSpecifiers(source))
      pending.push(resolveRendererImport(root, path, specifier));
  }
  for (const path of APPROVAL_DOSSIER_RENDERER_TEMPLATE_PATHS) {
    if (entries.has(path))
      throw new TypeError(`renderer dependency is duplicated: ${path}`);
    entries.set(path, await readFile(confinedRendererPath(root, path)));
  }
  return entries;
}

function confinedRendererPath(root: string, path: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path))
    throw new TypeError(`renderer dependency path is invalid: ${path}`);
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith(".."))
    throw new TypeError(`renderer dependency escapes runtime root: ${path}`);
  return absolute;
}

function relativeImportSpecifiers(source: string): readonly string[] {
  const specifiers = [
    ...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
  for (const specifier of specifiers)
    if (
      !specifier.startsWith(".") &&
      !Object.hasOwn(DETERMINISTIC_NODE_IMPORTS, specifier)
    )
      throw new TypeError(`renderer dependency is unsupported: ${specifier}`);
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

function resolveRendererImport(
  root: string,
  importer: string,
  specifier: string,
): string {
  if (!specifier.endsWith(".ts"))
    throw new TypeError(`renderer dependency import is unsupported: ${specifier}`);
  const path = relative(root, resolve(root, dirname(importer), specifier));
  if (path.startsWith("..") || path.startsWith("/"))
    throw new TypeError(`renderer dependency import escapes runtime root: ${specifier}`);
  return path;
}

function assertDeterministicRendererDependency(path: string, source: string): void {
  if (/\b(?:Date\.now|new\s+Date|performance\.now|process\.hrtime|Math\.random|crypto\.randomUUID)\b/.test(source))
    throw new TypeError(`renderer dependency is nondeterministic: ${path}`);
  if (/\bimport\s*\(/.test(source))
    throw new TypeError(`renderer dependency dynamic import is unsupported: ${path}`);
  if (
    path !== "scripts/approval-dossier-renderer.ts" &&
    /\bnode:fs(?:\/promises)?\b|\b(?:readFile|writeFile|readdir|open|stat)\s*\(/.test(source)
  )
    throw new TypeError(`renderer dependency filesystem use is unsupported: ${path}`);
}

function assertEnvelope(html: string, csp: string, fileCount: number): void {
  if (!html.endsWith("\n") || html.includes("\r"))
    throw new TypeError("approval dossier must use LF UTF-8 bytes");
  if (
    !html.includes(
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )
  )
    throw new TypeError("strict CSP is missing");
  if (count(html, `<template id="approval-dossier-protected-state"`) !== 1)
    throw new TypeError("protected approval payload is not unique");
  if (count(html, "data-approval-dossier-visible-markdown=") !== fileCount)
    throw new TypeError("every protected Markdown file must be visible");
  if (
    count(html, `<style id="${APPROVAL_DOSSIER_STYLE_ID}">`) !== 1 ||
    count(html, `<script id="${APPROVAL_DOSSIER_APP_ID}">`) !== 1
  )
    throw new TypeError("active template bytes are not unique");
}

function nonEmptyText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${name} is required`);
  return value;
}
function sha256Base64(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64");
}
function count(value: string, needle: string): number {
  let found = 0;
  let start = 0;
  while (true) {
    const index = value.indexOf(needle, start);
    if (index === -1) return found;
    found += 1;
    start = index + needle.length;
  }
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] as string,
  );
}
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function boundedText(value: string, name: string, maxBytes: number): string {
  const text = nonEmptyText(value, name).trim();
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    throw new RangeError(`${name} is too large`);
  return text;
}
