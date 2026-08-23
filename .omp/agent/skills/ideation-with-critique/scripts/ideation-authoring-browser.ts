import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { canonicalJson, hashRawBytes, type CanonicalJsonLimits } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { BROWSER_MANIFEST_JSON_LIMITS, readArtifactManifest, type ArtifactHtml, type BrowserEvidenceFile, type IdeationAuthoringCheckId } from "./ideation-authoring-evidence.ts";
import { inspectPdfContentBounds } from "./ideation-pdf-content-inspection.ts";

export const BROWSER_RUN_SCHEMA = "ideation-authoring/browser-run/v1" as const;
export const BROWSER_VIEWPORT_SCHEMA = "ideation-authoring/browser-viewport/v1" as const;
export const IDEATION_AUTHORING_CHECK_IDS = ["header", "authority-notice", "search-filters", "item-queue", "focused-briefing", "four-options", "recommendation", "feedback-controls", "item-feedback-isolation", "decision-dock", "relationship-map", "relationship-text", "markdown-preview", "source-drawer", "image-dialog", "research-dialog", "responsive-tabs", "final-actions", "protected-payload", "draft-retention", "keyboard-navigation", "focus-restoration", "contrast-light", "contrast-dark", "zoom-200", "reduced-motion", "forced-colours", "overflow", "no-js", "print-support", "print-candidate"] as const satisfies readonly IdeationAuthoringCheckId[];
export const AUTHORING_VIEWPORTS = [{ id: "desktop-1440x900", width: 1440, height: 900 }, { id: "tablet-1024x768", width: 1024, height: 768 }, { id: "mobile-390x844", width: 390, height: 844 }] as const;
export const MAX_SCREENSHOT_TILE_HEIGHT = 4_096;
type ArtifactKind = "support" | "candidate" | "workspace";
type Details = Record<string, unknown>;

function fail(message: string): never { throw new Error(`IDEATION_AUTHORING_BROWSER_FAILED:${message}`); }
async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function watchPage(page: Page, expectedArtifactUrl: string, pageErrors: string[], consoleErrors: string[], resourceErrors: string[], unexpectedResources: string[]): void {
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", request => resourceErrors.push(request.url()));
  page.on("requestfinished", request => { const url = request.url(); if (url !== expectedArtifactUrl && !url.startsWith("blob:")) unexpectedResources.push(url); });
}
async function artifactUrl(repositoryRoot: string, html: ArtifactHtml): Promise<string> { const root = await realpath(repositoryRoot); const requested = resolve(repositoryRoot, html.path); const absolute = await realpath(requested); const relativePath = relative(root, absolute); if (relativePath === "" || relativePath.startsWith("../") || relativePath === ".." || relativePath.includes("\\")) fail("artifact-path-outside-repository"); const bytes = await readFile(absolute); if (bytes.byteLength !== html.byte_count || hashRawBytes(bytes) !== html.sha256) fail("artifact-html-binding"); return `${pathToFileURL(absolute).href}?evidence=${html.sha256}`; }
async function outputJson(root: string, path: string, value: unknown, limits: number | CanonicalJsonLimits = 65_536): Promise<BrowserEvidenceFile> { return outputFile(root, path, Buffer.from(`${canonicalJson(value, limits)}\n`, "utf8")); }
async function outputFile(root: string, path: string, bytes: Uint8Array): Promise<BrowserEvidenceFile> { const target = resolve(root, path); const relativePath = relative(root, target); if (relativePath === "" || relativePath.startsWith("../") || relativePath === ".." || relativePath.includes("\\")) fail("output-path"); await writeExclusive(target, bytes); return Object.freeze({ path, sha256: hashRawBytes(bytes), byte_count: bytes.byteLength }); }
async function elementCount(page: Page, selector: string): Promise<number> { return page.$$eval(selector, elements => elements.length); }
async function visibleElementCount(page: Page, selector: string): Promise<number> { return page.$$eval(selector, elements => elements.filter(element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !(element as HTMLElement).hidden; }).length); }
async function elementAt(page: Page, selector: string, index = 0) { const elements = await page.$$(selector); const element = elements[index]; if (!element) fail(`missing-element:${selector}:${index}`); return element; }
async function clickAt(page: Page, selector: string, index = 0): Promise<void> { const element = await elementAt(page, selector, index); try { await element.click(); } catch (error) { const observed = await element.evaluate(target => { const rect = target.getBoundingClientRect(); const style = getComputedStyle(target); const pane = target.closest("[data-review-pane],[data-support-pane]") as HTMLElement | null; return { hidden: (target as HTMLElement).hidden, disabled: (target as HTMLButtonElement).disabled ?? false, display: style.display, visibility: style.visibility, rect: { left: rect.left, right: rect.right, width: rect.width, height: rect.height }, pane: pane === null ? null : { id: pane.id, hidden: pane.hidden, display: getComputedStyle(pane).display } }; }); fail(`click:${error instanceof Error ? error.message : "unknown"}:${canonicalJson({ selector, index, ...observed })}`); } finally { await element.dispose(); } }
async function fillAt(page: Page, selector: string, value: string, index = 0): Promise<void> { const element = await elementAt(page, selector, index); try { await element.evaluate((target, nextValue) => { const control = target as HTMLInputElement | HTMLTextAreaElement; control.focus(); control.value = nextValue; control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true })); }, value); } finally { await element.dispose(); } }
async function pressAt(page: Page, selector: string, key: string, index = 0): Promise<void> { const element = await elementAt(page, selector, index); try { await element.focus(); await page.keyboard.press(key); } finally { await element.dispose(); } }
async function textAt(page: Page, selector: string, index = 0): Promise<string> { const element = await elementAt(page, selector, index); try { return await element.evaluate(target => target.textContent ?? ""); } finally { await element.dispose(); } }
async function inputValueAt(page: Page, selector: string, index = 0): Promise<string> { const element = await elementAt(page, selector, index); try { return await element.evaluate(target => (target as HTMLInputElement | HTMLTextAreaElement).value); } finally { await element.dispose(); } }
async function disabledAt(page: Page, selector: string, index = 0): Promise<boolean> { const element = await elementAt(page, selector, index); try { return await element.evaluate(target => (target as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled); } finally { await element.dispose(); } }
function check(kind: ArtifactKind, checkId: IdeationAuthoringCheckId, applicable: boolean, details: Details, evidencePaths: readonly BrowserEvidenceFile[] = []) { return Object.freeze({ check_id: checkId, artifact_kind: kind, applicability: applicable ? "applicable" : "not-applicable", status: applicable ? "pass" : "not-applicable", evidence_paths: Object.freeze([...evidencePaths]), details: Object.freeze(details) }); }
async function visibleDetails(page: Page, selector: string, label: string): Promise<Details> { const observed = await page.evaluate((query) => [...document.querySelectorAll(query)].map(element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return { text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200), display: style.display, visibility: style.visibility, hidden: (element as HTMLElement).hidden, rect: { left: rect.left, right: rect.right, width: rect.width, height: rect.height }, visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !(element as HTMLElement).hidden }; }), selector); if (observed.length === 0 || observed.some(item => !item.visible || item.text.length === 0)) fail(label); return { selector, observed }; }
async function overflowDetails(page: Page): Promise<Details> {
  const measurements = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll("body *")].map(element => { const rect = element.getBoundingClientRect(); return { tag: element.tagName, id: element.id, class_name: element.getAttribute("class") ?? "", text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120), left: rect.left, right: rect.right, width: rect.width }; }).filter(item => item.right > clientWidth + 0.5).slice(0, 20);
    const internal_overflow = [...document.querySelectorAll("body *")].map(element => { const style = getComputedStyle(element); return { tag: element.tagName, id: element.id, class_name: element.getAttribute("class") ?? "", text: (element.textContent ?? "").replace(/\s+/g, " " ).trim().slice(0, 120), scroll_width: element.scrollWidth, client_width: element.clientWidth, overflow_x: style.overflowX }; }).filter(item => item.scroll_width > item.client_width + 0.5 && item.overflow_x === "visible").slice(0, 20);
    return { title: document.title, heading: document.querySelector("h1")?.textContent ?? "", scroll_width: document.documentElement.scrollWidth, client_width: clientWidth, horizontal_overflow: document.documentElement.scrollWidth > clientWidth, offenders, internal_overflow };
  });
  if (measurements.horizontal_overflow || measurements.offenders.length !== 0) fail(`overflow:${canonicalJson(measurements)}`);
  return measurements;
}
function rgb(value: string): readonly [number, number, number] | null {
  const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}
function contrastRatio(foreground: readonly [number, number, number], background: readonly [number, number, number]): number {
  const luminance = (channel: number) => { const normalized = channel / 255; return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4; };
  const first = 0.2126 * luminance(foreground[0]) + 0.7152 * luminance(foreground[1]) + 0.0722 * luminance(foreground[2]);
  const second = 0.2126 * luminance(background[0]) + 0.7152 * luminance(background[1]) + 0.0722 * luminance(background[2]);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
async function contrastDetails(page: Page, scheme: "light" | "dark"): Promise<Details> {
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  const surfaces = await page.evaluate(() => [...document.querySelectorAll("h1,h2,h3,p,a,button,input,select,textarea,.status,.metadata,.option-recommendation")].map((element) => {
    const style = getComputedStyle(element);
    let background = style.backgroundColor;
    let parent = element.parentElement;
    while ((background === "rgba(0, 0, 0, 0)" || background === "transparent") && parent) { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; }
    return { selector: element.tagName.toLowerCase(), foreground: style.color, background };
  }));
  const measured = surfaces.map((surface) => { const foreground = rgb(surface.foreground); const background = rgb(surface.background); return { ...surface, ratio: foreground === null || background === null ? null : contrastRatio(foreground, background) }; });
  const failures = measured.filter((surface) => surface.ratio === null || surface.ratio < 4.5);
  if (measured.length === 0 || failures.length > 0) fail(`contrast-${scheme}:${canonicalJson(failures)}`);
  return { scheme, minimum_ratio: 4.5, measured_surface_count: measured.length, surfaces: measured };
}
async function zoomDetails(page: Page, viewport: typeof AUTHORING_VIEWPORTS[number]): Promise<Details> {
  await page.setViewport({ width: Math.ceil(viewport.width / 2), height: Math.ceil(viewport.height / 2), deviceScaleFactor: 1 });
  const result = await overflowDetails(page); await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
  return { zoom_percent: 200, ...result };
}
async function forcedColoursDetails(page: Page): Promise<Details> {
  const session = await page.target().createCDPSession();
  try {
    await session.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "forced-colors", value: "active" }] });
    const result = await page.evaluate(() => { const selected = document.querySelector("[aria-selected='true'],[aria-current]:not([aria-current='false']),[aria-pressed='true']") as HTMLElement | null; const focusable = [...document.querySelectorAll("a,button,input,select,textarea")].filter((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && !(element as HTMLButtonElement).disabled; }); const selectedStyle = selected ? getComputedStyle(selected) : null; return { media_query_matches: matchMedia("(forced-colors: active)").matches, focusable_control_count: focusable.length, selected: selected ? { text: selected.textContent?.trim() ?? "", color: selectedStyle?.color ?? "", background: selectedStyle?.backgroundColor ?? "", border: selectedStyle?.borderColor ?? "" } : null }; });
    if (!result.media_query_matches || result.focusable_control_count === 0 || result.selected === null) fail(`forced-colours-usability:${JSON.stringify(result)}`);
    return { forced_colours: "active", ...result, ...(await overflowDetails(page)) };
  } finally { await session.send("Emulation.setEmulatedMedia", { media: "screen", features: [] }); await session.detach(); }
}
async function keyboardDetails(page: Page): Promise<Details> { const first = await elementAt(page, "a,button,input,select,textarea"); try { await first.focus(); } finally { await first.dispose(); } const before = await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? "", id: (document.activeElement as HTMLElement | null)?.id ?? "" })); await page.keyboard.press("Tab"); const after = await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; const style = active ? getComputedStyle(active) : undefined; return { tag: active?.tagName ?? "", id: active?.id ?? "", outline_style: style?.outlineStyle ?? "", outline_width: style?.outlineWidth ?? "", box_shadow: style?.boxShadow ?? "" }; }); if (before.tag === "BODY" || after.tag === "BODY" || after.tag.length === 0 || (after.outline_style === "none" && after.box_shadow === "none")) fail("keyboard"); return { initial_focus: before, tab_focus: after, action: "Tab" }; }

async function candidateDetails(page: Page, checkId: IdeationAuthoringCheckId, viewport: string): Promise<Details> {
  if (checkId === "header") return visibleDetails(page, "header h1", "header");
  if (checkId === "authority-notice") return visibleDetails(page, "#authority", "authority-notice");
  if (checkId === "search-filters") { await fillAt(page, "[data-review-search]", "nonexistent-authoring-probe"); const filtered = await visibleElementCount(page, "[data-review-select]"); await fillAt(page, "[data-review-search]", ""); const restored = await visibleElementCount(page, "[data-review-select]"); if (filtered >= restored || restored < 2) fail("search-filter-action"); return { query: "nonexistent-authoring-probe", filtered_visible_count: filtered, restored_visible_count: restored }; }
  if (checkId === "item-queue") return visibleDetails(page, "[data-review-select]", "item-queue");
  if (checkId === "focused-briefing") { await openReviewTarget(page, viewport, 0); return visibleDetails(page, "[data-review-summary]:not([hidden])", "focused-briefing"); }
  if (checkId === "four-options") {
    const comparison = await visibleDetails(page, "[data-review-summary]:not([hidden]) .review-option-comparison table", "four-option-comparison");
    const parity = await page.evaluate(() => [...document.querySelectorAll("[data-review-summary]")].map(item => ({
      option_count: item.querySelectorAll(".review-option").length,
      row_cell_counts: [...item.querySelectorAll(".review-option-comparison tbody tr")].map(row => row.querySelectorAll("td").length),
      visible_cell_labels: [...item.querySelectorAll(".review-option-comparison td")].map(cell => cell.getAttribute("data-option-label") ?? ""),
      contained: [...item.querySelectorAll(".review-option-comparison td")].every(cell => {
        const { left, right } = cell.getBoundingClientRect();
        return left >= 0 && right <= document.documentElement.clientWidth;
      }),
    })));
    if (parity.length === 0 || parity.some(item => item.option_count !== 4 || item.row_cell_counts.some(count => count !== 4) || item.visible_cell_labels.some(label => label.length === 0) || !item.contained)) fail("four-options");
    return { ...comparison, parity };
  }
  if (checkId === "recommendation") { const result = await page.evaluate(() => { const comparison = document.querySelector("[data-review-summary]:not([hidden]) .review-option-comparison"); const recommendation = document.querySelector("[data-review-summary]:not([hidden]) .option-recommendation"); const optionMarkers = comparison?.querySelectorAll(".recommendation-marker,.recommended-option").length ?? 0; return { comparison_precedes_recommendation: Boolean(comparison && recommendation && (comparison.compareDocumentPosition(recommendation) & Node.DOCUMENT_POSITION_FOLLOWING)), recommendation_text: recommendation?.textContent?.replace(/\s+/g, " ").trim() ?? "", option_recommendation_marker_count: optionMarkers }; }); if (!result.comparison_precedes_recommendation || result.recommendation_text.length === 0 || result.option_recommendation_marker_count !== 0) fail("recommendation-association"); return result; }
  if (checkId === "feedback-controls") {
    const controls = await page.evaluate(() => [...document.querySelectorAll("[data-feedback-editor]")].map(editor => [...editor.querySelectorAll("select,textarea,input")].map(field => {
      const describedBy = field.getAttribute("aria-describedby");
      return {
        label: field.closest("label")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        described_by: describedBy ?? "",
        help: describedBy ? document.getElementById(describedBy)?.textContent?.trim() ?? "" : "",
      };
    })));
    await openReviewTarget(page, viewport, 0);
    await clickAt(page, "[data-review-summary]:not([hidden]) [data-item-disposition='edit']");
    const disabled_before_input = await disabledAt(page, "#approval-dossier-controls [data-action='changes-requested']");
    await showMobilePane(page, viewport, "feedback");
    const optional_badge = await page.evaluate(() => {
      const badge = document.querySelector("#review-pane-feedback .panel-heading > .navigation-badge");
      const heading = badge?.parentElement;
      const emptyRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      if (!(badge instanceof HTMLElement) || !(heading instanceof HTMLElement)) return { text: "", visible: false, rect: emptyRect, parent_heading_rect: emptyRect, contained: false };
      const rect = badge.getBoundingClientRect();
      const style = getComputedStyle(badge);
      const parentRect = heading.getBoundingClientRect();
      return {
        text: (badge.textContent ?? "").replace(/\s+/g, " ").trim(),
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !badge.hidden,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        parent_heading_rect: { left: parentRect.left, top: parentRect.top, right: parentRect.right, bottom: parentRect.bottom, width: parentRect.width, height: parentRect.height },
        contained: rect.left >= parentRect.left - 0.5 && rect.top >= parentRect.top - 0.5 && rect.right <= parentRect.right + 0.5 && rect.bottom <= parentRect.bottom + 0.5,
      };
    });
    const desktop_optional_badge_readable = optional_badge.text === "Optional until edit or proposal" && optional_badge.visible && optional_badge.contained && optional_badge.rect.width >= 160 && optional_badge.rect.height >= 18;
    const conditional_required_after_selection = await visibleDetails(page, "[data-feedback-editor]:not([hidden]) [data-feedback-required]:not([hidden])", "conditional-required-state");
    await fillAt(page, "[data-feedback-editor]:not([hidden]) textarea", "requested change", 0);
    const disabled_after_requested_change = await disabledAt(page, "#approval-dossier-controls [data-action='changes-requested']");
    await fillAt(page, "[data-feedback-editor]:not([hidden]) textarea", "rationale", 1);
    const disabled_after_complete_feedback = await disabledAt(page, "#approval-dossier-controls [data-action='changes-requested']");
    const conditional_required_hidden_after_complete = await page.$eval("[data-feedback-editor]:not([hidden]) [data-feedback-required]", element => (element as HTMLElement).hidden || element.getClientRects().length === 0 || getComputedStyle(element).display === "none");
    if (controls.length === 0 || controls.some(group => group.length !== 4 || group.some(control => control.label.length === 0 || control.described_by.length === 0 || control.help.length === 0)) || !disabled_before_input || !disabled_after_requested_change || disabled_after_complete_feedback || !conditional_required_hidden_after_complete) fail("feedback-controls");
    if (viewport.startsWith("desktop") && !desktop_optional_badge_readable) fail("feedback-optional-badge");
    return { editor_count: controls.length, controls_per_editor: controls.map(group => group.length), conditional_required_after_selection, conditional_required_hidden_after_complete, disabled_before_input, disabled_after_requested_change, disabled_after_complete_feedback, optional_badge };
  }
  if (checkId === "item-feedback-isolation") return feedbackIsolation(page, viewport);
  if (checkId === "decision-dock") { await showMobilePane(page, viewport, "review"); return visibleDetails(page, "[data-review-summary]:not([hidden]) .disposition-row", "decision-dock"); }
  if (checkId === "relationship-map") { await showMobilePane(page, viewport, "notes"); return visibleDetails(page, ".review-map-svg", "relationship-map"); }
  if (checkId === "relationship-text") { await showMobilePane(page, viewport, "notes"); return visibleDetails(page, ".review-map figcaption", "relationship-text"); }
  if (checkId === "markdown-preview") return visibleDetails(page, "#markdown", "markdown-preview");
  if (checkId === "source-drawer") { const result = await page.evaluate(() => { const element = document.querySelector(".source-drawer"); if (!(element instanceof HTMLDetailsElement)) return { present: false, before: false, after: false, text: "" }; const before = element.open; element.open = true; return { present: true, before, after: element.open, text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 512) }; }); if (!result.present || !result.after || result.text.length === 0) fail("source-drawer"); return result; }
  if (checkId === "protected-payload") { const state = await page.evaluate(() => { const element = document.getElementById("approval-dossier-protected-state"); const payload = element instanceof HTMLTemplateElement ? element.content.textContent?.trim() ?? "" : element?.textContent?.trim() ?? ""; return { id: element?.id ?? "", payload, encoding: element?.getAttribute("data-approval-dossier-encoding") ?? "" }; }); if (state.id.length === 0 || state.payload.length === 0 || state.encoding !== "base64-canonical-json") fail("protected-payload"); return { id: state.id, encoding: state.encoding, payload_byte_count: Buffer.byteLength(state.payload), payload_sha256: hashRawBytes(Buffer.from(state.payload)) }; }
  if (checkId === "image-dialog" || checkId === "research-dialog") return { reason: "artifact-manifest-omitted" };
  if (checkId === "responsive-tabs") return tabDetails(page, viewport);
  if (checkId === "final-actions") { await page.reload({ waitUntil: "networkidle0" }); const disabled_before_review = await disabledAt(page, "#approval-dossier-controls [data-action='approved']"); const targetIds = await page.$$eval("[data-review-select]", (controls) => controls.map((control) => (control as HTMLElement).dataset.reviewSelect ?? "")); for (const targetId of targetIds) { await showMobilePane(page, viewport, "queue"); await page.$eval(`[data-review-select='${targetId}']`, (control) => { (control as HTMLButtonElement).click(); }); await showMobilePane(page, viewport, "review"); await page.$eval(`[data-review-summary='${targetId}'] [data-item-disposition='accepted']`, (control) => { (control as HTMLButtonElement).click(); }); } const disabled_after_review = await disabledAt(page, "#approval-dossier-controls [data-action='approved']"); if (!disabled_before_review || disabled_after_review) fail("final-action-gating"); return { disabled_before_review, disabled_after_review, reviewed_target_count: targetIds.length }; }
  if (checkId === "draft-retention") return draftRetention(page, viewport);
  if (checkId === "keyboard-navigation") return keyboardDetails(page);
  if (checkId === "focus-restoration") { await openReviewTarget(page, viewport, 1); const selected = await page.evaluate(() => { const current = document.querySelector("[data-review-select][aria-current='step']") as HTMLElement | null; return { current: current?.getAttribute("data-review-select") ?? "", focused: (document.activeElement as HTMLElement | null)?.id ?? "", focused_target: (document.activeElement as HTMLElement | null)?.getAttribute("data-review-select") ?? "", selected_visible: current instanceof HTMLElement && current.getClientRects().length > 0, visible_summary: document.querySelector("[data-review-summary]:not([hidden])")?.getAttribute("data-review-summary") ?? "" }; }); const responsive = !viewport.startsWith("desktop"); if (!selected.current || selected.visible_summary !== selected.current || (responsive ? !selected.focused.includes("mobile-review-tab-review") : !selected.selected_visible || selected.focused_target !== selected.current)) fail("focus-restoration"); return { action: "select-second-queue-item", expected_focus: responsive ? "review-tab" : "selected-queue-control", ...selected }; }
  if (checkId === "contrast-light") return contrastDetails(page, "light");
  if (checkId === "contrast-dark") return contrastDetails(page, "dark");
  if (checkId === "zoom-200") return zoomDetails(page, AUTHORING_VIEWPORTS.find(item => item.id === viewport)!);
  if (checkId === "reduced-motion") { await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]); const active = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches); if (!active) fail("reduced-motion-not-active"); return { reduced_motion: "reduce", media_query_matches: active, animation_play_states: await page.evaluate(() => document.getAnimations().map(animation => animation.playState)) }; }
  if (checkId === "forced-colours") return forcedColoursDetails(page);
  if (checkId === "overflow") return overflowDetails(page);
  if (checkId === "no-js") return { observation_source: "javascript-disabled-visibility" };
  if (checkId === "print-candidate") return { observation_source: "reopened-pdf-clipping" };
  fail(`candidate-check:${checkId}`);
}

async function showMobilePane(page: Page, viewport: string, name: "queue" | "review" | "feedback" | "notes"): Promise<void> { const hidden = await page.$eval(`[data-review-pane='${name}']`, pane => (pane as HTMLElement).hidden || pane.getClientRects().length === 0); if (hidden) await pressAt(page, `[data-mobile-review-tab='${name}']`, "Enter"); const state = await page.evaluate((targetName) => ({ target_name: targetName, inner_width: window.innerWidth, selected_tabs: [...document.querySelectorAll("[data-mobile-review-tab][aria-selected='true']")].map(tab => (tab as HTMLElement).dataset.mobileReviewTab ?? ""), panes: [...document.querySelectorAll("[data-review-pane]")].map(pane => ({ name: (pane as HTMLElement).dataset.reviewPane ?? "", hidden: (pane as HTMLElement).hidden, rect_count: pane.getClientRects().length, display: getComputedStyle(pane).display })) }), name); const target = state.panes.find(pane => pane.name === name); if (target === undefined || target.hidden || target.rect_count === 0 || target.display === "none") fail(`pane-transition:${viewport}:${canonicalJson(state)}`); }
async function openReviewTarget(page: Page, viewport: string, index: number): Promise<void> { await showMobilePane(page, viewport, "queue"); await clickAt(page, "[data-review-select]", index); await showMobilePane(page, viewport, "review"); }
async function feedbackIsolation(page: Page, viewport: string): Promise<Details> {
  const targets = await page.evaluate(() => [...document.querySelectorAll("[data-review-select]")].slice(0, 2).map((control) => {
    const feedbackId = (control as HTMLElement).dataset.reviewSelect ?? "";
    const editor = document.querySelector(`[data-feedback-editor='${feedbackId}']`);
    const encodedTarget = editor?.getAttribute("data-feedback-target") ?? "";
    return { feedback_id: feedbackId, target: encodedTarget.length > 0 ? JSON.parse(atob(encodedTarget)) : null };
  }));
  if (targets.length !== 2 || targets.some((target) => target.feedback_id.length === 0 || target.target === null)) fail("isolation-targets");
  const dispositions = ["edit", "proposal"] as const;
  for (const [index, target] of targets.entries()) {
    await showMobilePane(page, viewport, "queue");
    await page.$eval(`[data-review-select='${target.feedback_id}']`, (control) => { (control as HTMLButtonElement).click(); });
    await showMobilePane(page, viewport, "review");
    const current = await page.$eval("[data-review-select][aria-current='step']", (control) => (control as HTMLElement).dataset.reviewSelect ?? "");
    if (current !== target.feedback_id) fail(`isolation-selection:${target.feedback_id}:${current}`);
    await page.$eval(`[data-review-summary='${target.feedback_id}'] [data-item-disposition='${dispositions[index]}']`, (control) => { (control as HTMLButtonElement).click(); });
    const selectedDisposition = await page.$eval(`[data-feedback-editor='${target.feedback_id}']`, (editor) => (editor as HTMLElement).dataset.disposition ?? "");
    if (selectedDisposition !== dispositions[index]) fail(`isolation-disposition:${target.feedback_id}:${selectedDisposition}`);
    await showMobilePane(page, viewport, "feedback");
    const editor = `[data-feedback-editor='${target.feedback_id}']`;
    await fillAt(page, `${editor} textarea`, `requested-${index}`, 0);
    await fillAt(page, `${editor} textarea`, `rationale-${index}`, 1);
    await fillAt(page, `${editor} input`, `evidence-${index}`, 0);
  }
  for (const pane of ["queue", "review", "feedback", "notes"] as const) await showMobilePane(page, viewport, pane);
  const fields = await page.evaluate((feedbackIds) => feedbackIds.map((feedbackId) => {
    const editor = document.querySelector(`[data-feedback-editor='${feedbackId}']`);
    return [...(editor?.querySelectorAll("select,textarea,input") ?? [])].map((control) => (control as HTMLInputElement).value);
  }), targets.map((target) => target.feedback_id));
  if (fields.length !== 2 || canonicalJson(fields[0]) === canonicalJson(fields[1])) fail("cross-item-bleed");
  const realm = page.mainFrame().mainRealm();
  await realm.evaluate(() => {
    type Saved = { readonly status: string; readonly feedback: readonly { readonly feedback_id: string; readonly kind: string; readonly requested_change: string; readonly rationale: string; readonly target: unknown }[] };
    const saved = Promise.withResolvers<Saved>();
    const originalClick = HTMLAnchorElement.prototype.click;
    const originalCreateObjectURL = URL.createObjectURL;
    let settled = false;
    let createCount = 0;
    let clickCount = 0;
    const restore = (): void => { HTMLAnchorElement.prototype.click = originalClick; URL.createObjectURL = originalCreateObjectURL; };
    const reject = (error: Error): void => { if (settled) return; settled = true; window.clearTimeout(timer); restore(); saved.reject(error); };
    const resolve = (value: Saved): void => { if (settled) return; settled = true; window.clearTimeout(timer); restore(); saved.resolve(value); };
    const timer = window.setTimeout(() => {
      const controls = document.getElementById("approval-dossier-controls");
      const diagnostics = { create_count: createCount, click_count: clickCount, status: controls?.querySelector(".status-line")?.textContent ?? "", draft_count: controls?.querySelectorAll("[data-action='draft']").length ?? 0, draft_disabled: (controls?.querySelector("[data-action='draft']") as HTMLButtonElement | null)?.disabled ?? null, editors: [...document.querySelectorAll("[data-feedback-editor]")].map((editor) => ({ disposition: (editor as HTMLElement).dataset.disposition ?? "", values: [...editor.querySelectorAll("select,textarea,input")].map((control) => (control as HTMLInputElement).value) })) };
      reject(new Error(`saved-response-capture-timeout:${JSON.stringify(diagnostics)}`));
    }, 5_000);
    URL.createObjectURL = function (blob: Blob): string {
      createCount += 1;
      const url = originalCreateObjectURL.call(URL, blob);
      void blob.text().then((html) => {
        const payload = document.implementation.createHTMLDocument("");
        payload.documentElement.innerHTML = html;
        const template = payload.getElementById("approval-dossier-protected-state") as HTMLTemplateElement | null;
        const encoded = template?.content.textContent?.trim() ?? "";
        if (!encoded) throw new Error("saved-response-payload-missing");
        const parsed = JSON.parse(atob(encoded));
        resolve({ status: parsed.approval_status, feedback: parsed.feedback });
      }).catch((error) => reject(new Error(`saved-response-parse-failed:${error instanceof Error ? error.message : "unknown"}`)));
      return url;
    };
    HTMLAnchorElement.prototype.click = function (): void { if (this.download && this.href.startsWith("blob:")) { clickCount += 1; return; } originalClick.call(this); };
    (window as Window & { savedAuthoringResponse?: Promise<Saved> }).savedAuthoringResponse = saved.promise;
  });
  await clickAt(page, "#approval-dossier-controls [data-action='draft']");
  const saved = await realm.evaluate(async () => await (window as Window & { savedAuthoringResponse?: Promise<{ readonly status: string; readonly feedback: readonly { readonly feedback_id: string; readonly kind: string; readonly requested_change: string; readonly rationale: string; readonly target: unknown }[] }> }).savedAuthoringResponse);
  const expectedBindings = targets.map((target, index) => ({ feedback_id: target.feedback_id, kind: dispositions[index], requested_change: `requested-${index}`, rationale: `rationale-${index}`, target: target.target }));
  const observedBindings = saved?.feedback.map((item) => ({ feedback_id: item.feedback_id, kind: item.kind, requested_change: item.requested_change, rationale: item.rationale, target: item.target }));
  if (saved?.status !== "draft" || canonicalJson(observedBindings) !== canonicalJson(expectedBindings)) fail(`saved-response-serialization:${canonicalJson(saved)}`);
  return { target_indices: [0, 1], target_bindings: targets, dispositions, restored_values: fields, values_isolated: canonicalJson(fields[0]) !== canonicalJson(fields[1]), saved_response: { approval_status: saved.status, feedback_count: saved.feedback.length, requested_changes: saved.feedback.map((item) => item.requested_change), rationales: saved.feedback.map((item) => item.rationale) } };
}
async function tabDetails(page: Page, viewport: string): Promise<Details> { const tabCount = await elementCount(page, "[data-mobile-review-tab]"); if (tabCount !== 4) fail("tabs-count"); if (viewport.startsWith("desktop")) { const state = await page.evaluate(() => ({ visible_tab_count: [...document.querySelectorAll("[data-mobile-review-tab]")].filter(tab => tab.getClientRects().length > 0).length, panes: [...document.querySelectorAll("[data-review-pane]")].map(pane => ({ role: pane.getAttribute("role"), labelled_by: pane.getAttribute("aria-labelledby"), hidden: (pane as HTMLElement).hidden, visible: pane.getClientRects().length > 0 })) })); if (state.visible_tab_count !== 0 || state.panes.length !== 4 || state.panes.some(pane => !pane.visible || pane.hidden || pane.role !== null || pane.labelled_by !== null)) fail("desktop-tabs-state"); return { layout: "desktop", observed_tab_count: tabCount, ...state }; } const tabs = "[data-mobile-review-tab]"; await openReviewTarget(page, viewport, 0); await clickAt(page, "[data-review-summary]:not([hidden]) [data-item-disposition='edit']"); await fillAt(page, "[data-feedback-editor]:not([hidden]) textarea", "responsive-tab-draft"); const preservedState = async () => page.evaluate(() => { const current = document.querySelector("[data-review-select][aria-current='step']")?.getAttribute("data-review-select") ?? ""; const summary = document.querySelector("[data-review-summary]:not([hidden])") as HTMLElement | null; const editor = document.querySelector("[data-feedback-editor]:not([hidden])") as HTMLElement | null; return { selected_target: current, visible_summary: summary?.getAttribute("data-review-summary") ?? "", disposition: editor?.dataset.disposition ?? "", requested_change: (editor?.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? "" }; }); const stateBeforeTraversal = await preservedState(); await clickAt(page, "[data-mobile-review-tab='queue']"); await clickAt(page, tabs, 1); const pointer = await page.evaluate(() => ({ selected: document.querySelector("[data-mobile-review-tab][aria-selected='true']")?.getAttribute("data-mobile-review-tab") ?? "", active: (document.activeElement as HTMLElement | null)?.getAttribute("data-mobile-review-tab") ?? "", visible_pane: document.querySelector("[data-review-pane]:not([hidden])")?.getAttribute("data-review-pane") ?? "" })); if (pointer.selected !== "review" || pointer.visible_pane !== "review") fail(`tabs-pointer-activation:${canonicalJson({ viewport, pointer })}`); await pressAt(page, tabs, "ArrowRight", 1); const afterRight = await page.evaluate(() => ({ selected: document.querySelector("[data-mobile-review-tab][aria-selected='true']")?.getAttribute("data-mobile-review-tab") ?? "", active: (document.activeElement as HTMLElement | null)?.getAttribute("data-mobile-review-tab") ?? "" })); await pressAt(page, tabs, "End", 2); const afterEnd = await page.evaluate(() => ({ selected: document.querySelector("[data-mobile-review-tab][aria-selected='true']")?.getAttribute("data-mobile-review-tab") ?? "", active: (document.activeElement as HTMLElement | null)?.getAttribute("data-mobile-review-tab") ?? "" })); await pressAt(page, tabs, "Home", 3); const afterHome = await page.evaluate(() => ({ selected: document.querySelector("[data-mobile-review-tab][aria-selected='true']")?.getAttribute("data-mobile-review-tab") ?? "", active: (document.activeElement as HTMLElement | null)?.getAttribute("data-mobile-review-tab") ?? "", focus: (() => { const active = document.activeElement as HTMLElement | null; const style = active ? getComputedStyle(active) : null; return { outline_style: style?.outlineStyle ?? "", outline_width: style?.outlineWidth ?? "", box_shadow: style?.boxShadow ?? "" }; })() })); const paneTraversal: { name: string; selected: string; visible_pane: string }[] = []; for (const index of [0, 1, 2, 3]) { await clickAt(page, tabs, index); paneTraversal.push(await page.evaluate(() => ({ name: document.querySelector("[data-mobile-review-tab][aria-selected='true']")?.getAttribute("data-mobile-review-tab") ?? "", selected: document.querySelector("[data-mobile-review-tab][aria-selected='true']")?.getAttribute("aria-selected") ?? "", visible_pane: document.querySelector("[data-review-pane]:not([hidden])")?.getAttribute("data-review-pane") ?? "" }))); } const stateAfterTraversal = await preservedState(); const state = await page.evaluate(() => ({ tablist_role: document.querySelector(".mobile-review-tabs")?.getAttribute("role") ?? "", selected_count: document.querySelectorAll("[data-mobile-review-tab][aria-selected='true']").length, visible_pane_count: [...document.querySelectorAll("[data-review-pane]")].filter(item => !(item as HTMLElement).hidden).length, active_id: (document.activeElement as HTMLElement | null)?.id ?? "", controls: [...document.querySelectorAll("[data-mobile-review-tab]")].map(tab => ({ id: (tab as HTMLElement).id, role: tab.getAttribute("role") ?? "", controls: tab.getAttribute("aria-controls") ?? "", selected: tab.getAttribute("aria-selected") ?? "" })), panes: [...document.querySelectorAll("[data-review-pane]")].map(pane => ({ role: pane.getAttribute("role") ?? "", labelled_by: pane.getAttribute("aria-labelledby") ?? "" })) })); const focusVisible = afterHome.focus.outline_style !== "none" || afterHome.focus.box_shadow !== "none"; if (state.tablist_role !== "tablist" || state.selected_count !== 1 || state.visible_pane_count !== 1 || state.active_id.length === 0 || state.controls.some(control => control.role !== "tab" || control.controls.length === 0) || state.panes.some(pane => pane.role !== "tabpanel" || pane.labelled_by.length === 0) || afterRight.selected !== "feedback" || afterRight.active !== "feedback" || afterEnd.selected !== "notes" || afterEnd.active !== "notes" || afterHome.selected !== "queue" || afterHome.active !== "queue" || !focusVisible || paneTraversal.length !== 4 || paneTraversal.some(item => item.name !== item.visible_pane || item.selected !== "true") || canonicalJson(stateBeforeTraversal) !== canonicalJson(stateAfterTraversal)) fail("tabs-state"); return { layout: viewport.startsWith("tablet") ? "tablet" : "mobile", expected_tab_count: 4, pointer_activation: pointer, traversal: { after_right: afterRight, after_end: afterEnd, after_home: afterHome, pane_traversal: paneTraversal }, preserved_review_state: { before: stateBeforeTraversal, after: stateAfterTraversal }, visible_focus: afterHome.focus, ...state }; }
async function draftRetention(page: Page, viewport: string): Promise<Details> { await openReviewTarget(page, viewport, 0); await clickAt(page, "[data-review-summary]:not([hidden]) [data-item-disposition='edit']"); await fillAt(page, "[data-feedback-editor]:not([hidden]) textarea", "retained-draft"); await openReviewTarget(page, viewport, 1); await openReviewTarget(page, viewport, 0); if (viewport.startsWith("mobile")) await clickAt(page, "[data-mobile-review-tab='feedback']"); const restored = await page.evaluate(() => { const summary = document.querySelector("[data-review-summary]:not([hidden])") as HTMLElement | null; const editor = document.querySelector("[data-feedback-editor]:not([hidden])") as HTMLElement | null; const selectedDisposition = summary?.querySelector("[data-item-disposition='edit'][aria-pressed='true']") !== null; return { value: (editor?.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? "", selected_target: summary?.getAttribute("data-review-summary") ?? "", current_target: document.querySelector("[data-review-select][aria-current='step']")?.getAttribute("data-review-select") ?? "", disposition: editor?.dataset.disposition ?? "", selected_disposition: selectedDisposition }; }); if (restored.value !== "retained-draft" || restored.selected_target.length === 0 || restored.selected_target !== restored.current_target || restored.disposition !== "edit" || !restored.selected_disposition) fail("draft-retention"); return { entered_value: "retained-draft", restored_value: restored.value, navigation: [1, 0], retained_selection: { selected_target: restored.selected_target, current_target: restored.current_target }, retained_disposition: { disposition: restored.disposition, selected: restored.selected_disposition } }; }

const SEMANTIC_INVENTORY_SELECTOR = "h1,h2,h3,h4,h5,p,li,button,table th,table td,dt,dd,label,.optional,select,textarea,input,code,pre,#authority,.option-recommendation,[data-approval-dossier-visible-markdown]";

async function semanticInventory(page: Page): Promise<readonly string[]> {
  const inventory = await page.evaluate((selector) => [...document.querySelectorAll(selector)].filter(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !(element as HTMLElement).hidden;
  }).map(element => `${element.tagName}:${(element.textContent || (element as HTMLInputElement).value || element.getAttribute("aria-describedby") || "").replace(/\s+/g, " ").trim()}`).filter(value => value.length > 3), SEMANTIC_INVENTORY_SELECTOR);
  if (inventory.length === 0) fail("semantic-inventory");
  return Object.freeze(inventory);
}

async function printableInventory(page: Page): Promise<readonly string[]> {
  const values = await page.evaluate(() => {
    const selectors = [
      "header h1",
      "#authority dt",
      "#authority dd",
      "[data-review-summary] h2",
      "[data-review-summary] h3",
      "[data-review-summary] p",
      "[data-review-summary] li",
      "[data-review-summary] dt",
      "[data-review-summary] dd",
      "[data-review-summary] .review-option-comparison td",
      "[data-review-summary] .option-recommendation",
      "[data-feedback-editor] label > span:first-child",
      "[data-feedback-editor] [id$='-help']",
      "[data-approval-dossier-visible-markdown]",
      ".notice",
      ".exchange h3",
      ".exchange dt",
      ".exchange dd",
      ".workspace-question h2",
      ".workspace-question label > span:first-child",
      ".workspace-question small",
      ".workspace-provenance-pane li",
      ".provenance-disclosure li",
    ];
    const seen = new Set<string>();
    return [...document.querySelectorAll(selectors.join(","))]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !(element as HTMLElement).hidden;
      })
      .map(element => (element.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(value => value.length > 0 && !seen.has(value) && Boolean(seen.add(value)));
  });
  if (values.length === 0) fail("print-inventory");
  return Object.freeze(values);
}

async function domInventory(page: Page, kind: ArtifactKind): Promise<{ readonly inventory: readonly string[]; readonly semantic_inventory: readonly string[]; readonly linear_order: readonly string[] }> {
  const result = await page.evaluate((artifactKind, selector) => {
    const inventorySelector = artifactKind === "candidate" ? "[data-review-select],.review-option,#markdown,#authority" : artifactKind === "workspace" ? "[data-workspace-question],[data-workspace-field],#authority" : ".exchange,.notice,.queue";
    return {
      inventory: [...document.querySelectorAll(inventorySelector)].map((element, index) => element.getAttribute("data-review-select") || element.id || element.getAttribute("data-workspace-field") || `${element.tagName}-${index}`),
      linear_order: [...document.querySelectorAll(selector)].map(element => (element.textContent || (element as HTMLInputElement).value || element.getAttribute("aria-describedby") || "").trim()).filter(Boolean),
    };
  }, kind, SEMANTIC_INVENTORY_SELECTOR);
  if (result.inventory.length === 0 || result.linear_order.length === 0) fail(`inventory:${kind}`);
  return Object.freeze({ inventory: Object.freeze(result.inventory), semantic_inventory: await semanticInventory(page), linear_order: Object.freeze(result.linear_order) });
}
async function printRecord(page: Page, root: string, kind: ArtifactKind, viewport: typeof AUTHORING_VIEWPORTS[number]) {
  let inventory: readonly string[];
  let bytes: Uint8Array;
  await page.emulateMediaType("print");
  try {
    inventory = await printableInventory(page);
    bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true, width: `${viewport.width}px`, height: `${viewport.height}px` });
  } finally {
    await page.emulateMediaType("screen");
  }
  const content = inspectPdfContentBounds(bytes);
  const normalizedExtractedText = content.extracted_text.replace(/\s+/g, "").toLowerCase();
  const missingInventory = inventory.filter(item => !normalizedExtractedText.includes(item.replace(/\s+/g, "").toLowerCase()));
  if (content.page_count < 1 || content.pages.some(item => item.clipped || item.out_of_bounds_count !== 0) || missingInventory.length !== 0) fail(`pdf-content:${kind}:${canonicalJson({ page_count: content.page_count, pages: content.pages.map(item => ({ page_index: item.page_index, clipped: item.clipped, out_of_bounds_count: item.out_of_bounds_count, maximum_overflow: item.maximum_overflow })), missing_inventory: missingInventory })}`);
  const pdf = await outputFile(root, `print/${viewport.id}/${kind}.pdf`, bytes);
  const inspection = await outputJson(root, `print/${viewport.id}/${kind}.json`, {
    schema: "ideation-authoring/print-inspection/v1",
    artifact_kind: kind,
    viewport: viewport.id,
    pdf,
    settings: { print_background: true, prefer_css_page_size: true, width: `${viewport.width}px`, height: `${viewport.height}px` },
    page_count: content.page_count,
    pages: content.pages,
    clipping_checked: true,
    clipping_tolerance_points: 1,
    inventory,
    extracted_text_byte_count: content.extracted_text_byte_count,
    missing_inventory: missingInventory,
  });
  return Object.freeze({ pdf, inspection });
}


async function workspaceDetails(page: Page, checkId: IdeationAuthoringCheckId, viewport: string, root: string): Promise<Details> {
  if (checkId === "header") return visibleDetails(page, "header h1", "workspace-header");
  if (checkId === "authority-notice") return visibleDetails(page, "#authority", "workspace-authority");
  if (checkId === "item-queue") return visibleDetails(page, "[data-workspace-queue]", "workspace-queue");
  if (checkId === "focused-briefing") return visibleDetails(page, ".workspace-question", "workspace-question");
  if (checkId === "feedback-controls") {
    const fields = await page.$$eval("[data-workspace-item][data-workspace-field]", controls => controls.map(control => ({ field: (control as HTMLElement).dataset.workspaceField ?? "", item: (control as HTMLElement).dataset.workspaceItem ?? "", label: control.closest("label")?.textContent?.replace(/\s+/g, " ").trim() ?? "" })));
    const mutableFieldNames = ["answer_text", "validation", "defer_status", "defer_reason", "rationale", "selected_option", "context_requests", "evidence_references", "notebook_content"] as const;
    const itemIds = fields.map(field => field.item).filter((item, index, items) => items.indexOf(item) === index);
    const navigationFields = await page.$$eval("[data-workspace-navigation]", controls => controls.map(control => (control as HTMLElement).dataset.workspaceNavigation ?? ""));
    if (fields.length !== itemIds.length * mutableFieldNames.length || itemIds.length === 0 || fields.some(field => !mutableFieldNames.some(name => name === field.field) || field.item.length === 0 || field.label.length === 0) || itemIds.some(item => mutableFieldNames.some(name => !fields.some(field => field.item === item && field.field === name))) || canonicalJson(navigationFields) !== canonicalJson(["active_view", "scroll_anchor"])) fail("workspace-mutable-fields");
    await page.$$eval("[data-workspace-item][data-workspace-field]", controls => controls.forEach((control, index) => { const input = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; if (input instanceof HTMLSelectElement) input.selectedIndex = Math.min(1, input.options.length - 1); else input.value = `${input.value || "workspace"}-${index}`; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }));
    await page.$$eval("[data-workspace-navigation]", controls => controls.forEach((control, index) => { const input = control as HTMLInputElement; input.value = `${input.value || "navigation"}-${index}`; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }));
    const interaction = await page.evaluate(() => ({ mutable_controls: document.querySelectorAll("[data-workspace-item][data-workspace-field]").length, navigation_controls: document.querySelectorAll("[data-workspace-navigation]").length, values: [...document.querySelectorAll("[data-workspace-item][data-workspace-field]")].map(control => (control as HTMLInputElement).value) }));
    return { mutable_field_count: fields.length, fields, ...interaction };
  }
  if (checkId === "protected-payload") {
    const result = await page.evaluate(() => { const node = document.getElementById("questionnaire-workspace-payload"); const fields = [...document.querySelectorAll("[data-workspace-field]")].map(field => field.getAttribute("data-workspace-field") ?? ""); return { payload_present: node?.getAttribute("type") === "application/json" && (node.textContent ?? "").trim().length > 0, protected_controls: fields.filter(field => ["occurrence_id", "feedback_id", "target", "response_record_path", "response_record_sha256"].includes(field)) }; });
    if (!result.payload_present || result.protected_controls.length !== 0) fail("workspace-protected-boundary");
    return result;
  }
  if (checkId === "final-actions") {
    const before = await page.$eval("#questionnaire-workspace-payload", node => node.textContent ?? "");
    const expected = await page.evaluate(() => ({ fields: [...document.querySelectorAll("[data-workspace-item][data-workspace-field]")].map(control => ({ key: `${(control as HTMLElement).dataset.workspaceItem}/${(control as HTMLElement).dataset.workspaceField}`, value: (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value })), navigation: [...document.querySelectorAll("[data-workspace-navigation]")].map(control => ({ key: (control as HTMLElement).dataset.workspaceNavigation ?? "", value: (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value })) }));
    const realm = page.mainFrame().mainRealm();
    await realm.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (object: Blob | MediaSource) => { (window as Window & { __workspaceDownload?: Blob }).__workspaceDownload = object as Blob; return original(object); } });
    });
    await realm.evaluate(() => document.body.insertAdjacentHTML("beforeend", "<script>window.__workspaceOutOfPayloadScript=true</script><button type=\"button\" onclick=\"window.__workspaceOutOfPayloadHandler=true\">injected control</button><script type=\"text/plain\" src=\"https://outside.invalid/workspace\"></script>"));
    await fillAt(page, "[data-workspace-field='answer_text']", "downloaded-workspace-answer");
    await page.select("[data-workspace-navigation='active_view']", "workspace");
    const answer = expected.fields.find(field => field.key.endsWith("/answer_text"));
    if (answer === undefined) fail("workspace-answer-control");
    answer.value = "downloaded-workspace-answer";
    const activeView = expected.navigation.find(field => field.key === "active_view");
    if (activeView === undefined) fail("workspace-active-view-control");
    activeView.value = "workspace";
    await clickAt(page, "[data-workspace-action='save']");
    const result = await realm.evaluate(async () => { const download = await (window as Window & { __workspaceDownload?: Blob }).__workspaceDownload?.text() ?? ""; const downloaded = new DOMParser().parseFromString(download, "text/html"); const payload = JSON.parse(downloaded.getElementById("questionnaire-workspace-payload")?.textContent ?? "null"); const controlValues = (selector: string) => [...downloaded.querySelectorAll(selector)].map(control => { const element = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; const key = selector.includes("workspace-item") ? `${element.dataset.workspaceItem}/${element.dataset.workspaceField}` : element.dataset.workspaceNavigation ?? ""; const value = element instanceof HTMLTextAreaElement ? element.defaultValue : element instanceof HTMLSelectElement ? [...element.options].find(option => option.defaultSelected)?.value ?? "" : element.getAttribute("value") ?? ""; return { key, value }; }); const payloadFields = payload === null ? [] : payload.response_items.flatMap((item: Record<string, unknown>) => ["answer_text", "validation", "defer_status", "defer_reason", "rationale", "selected_option", "context_requests", "evidence_references", "notebook_content"].map(field => ({ key: `${item.occurrence_id}/${field}`, value: Array.isArray(item[field]) ? item[field].join("\\n") : item[field] ?? "" }))); const payloadNavigation = payload === null ? [] : Object.entries(payload.navigation_state).map(([key, value]) => ({ key, value: value ?? "" })); return { status: document.querySelector("[data-workspace-status]")?.textContent ?? "", payload: document.querySelector("#questionnaire-workspace-payload")?.textContent ?? "", download, control_defaults: { fields: controlValues("[data-workspace-item][data-workspace-field]"), navigation: controlValues("[data-workspace-navigation]") }, payload_values: { fields: payloadFields, navigation: payloadNavigation } }; });
    if (!result.status.includes("Downloaded questionnaire.html") || result.payload !== before || !result.download.includes("questionnaire-workspace-payload") || result.download.includes("__workspaceOutOfPayloadScript") || result.download.includes("__workspaceOutOfPayloadHandler") || result.download.includes("outside.invalid/workspace") || canonicalJson(result.control_defaults) !== canonicalJson(expected) || canonicalJson(result.payload_values) !== canonicalJson(expected)) fail(`workspace-download-or-canonical-mutation:${canonicalJson({ expected, result: { status: result.status, payload_unchanged: result.payload === before, control_defaults: result.control_defaults, payload_values: result.payload_values } })}`);
    const downloadedWorkspace = await outputFile(root, `downloads/${viewport}/questionnaire.html`, Buffer.from(result.download, "utf8"));
    return { downloaded: true, status: result.status, canonical_payload_unchanged: result.payload === before, all_mutable_control_defaults: result.control_defaults, embedded_payload_values: result.payload_values, downloaded_workspace: downloadedWorkspace };
  }
  if (checkId === "draft-retention") {
    const canonical = await page.evaluate(() => { const payload = JSON.parse(document.getElementById("questionnaire-workspace-payload")?.textContent ?? "null"); const item = payload.response_items[0]; return { answer: item.answer_text, active_view: payload.navigation_state.active_view, protected_tuple: [item.occurrence_id, item.feedback_id, item.target, item.response_record_path, item.response_record_sha256], draft_key: `ideation-questionnaire-draft:${payload.workspace_id}`, occurrence_id: item.occurrence_id }; });
    await fillAt(page, "[data-workspace-field='answer_text']", "workspace-browser-edit");
    await page.select("[data-workspace-navigation='active_view']", "workspace");
    await page.evaluate(({ draftKey, occurrenceId }) => { const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null"); if (draft === null) throw new Error("missing-compatible-draft"); draft.fields[`${occurrenceId}/target`] = "draft-protected-tamper"; localStorage.setItem(draftKey, JSON.stringify(draft)); }, { draftKey: canonical.draft_key, occurrenceId: canonical.occurrence_id });
    await page.reload({ waitUntil: "networkidle0" });
    const compatible = await page.evaluate(() => ({ answer: (document.querySelector("[data-workspace-field='answer_text']") as HTMLTextAreaElement | null)?.value ?? "", active_view: (document.querySelector("[data-workspace-navigation='active_view']") as HTMLSelectElement | null)?.value ?? "", payload: JSON.parse(document.getElementById("questionnaire-workspace-payload")?.textContent ?? "null"), protected_visible: document.querySelector(".workspace-protected")?.textContent ?? "" }));
    if (compatible.answer !== "workspace-browser-edit" || compatible.active_view !== "workspace" || canonicalJson([compatible.payload.response_items[0].occurrence_id, compatible.payload.response_items[0].feedback_id, compatible.payload.response_items[0].target, compatible.payload.response_items[0].response_record_path, compatible.payload.response_items[0].response_record_sha256]) !== canonicalJson(canonical.protected_tuple) || compatible.protected_visible.includes("draft-protected-tamper")) fail("workspace-compatible-draft-retention");
    const incompatibleDiscarded: string[] = [];
    for (const field of ["schema", "workspace_id", "workspace_issuance_id", "inventory"] as const) {
      await fillAt(page, "[data-workspace-field='answer_text']", `draft-${field}`);
      await page.evaluate(({ draftKey, field }) => { const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null"); if (draft === null) throw new Error("missing-draft-before-incompatible-check"); draft[field] = field === "inventory" ? [] : `incompatible-${field}`; localStorage.setItem(draftKey, JSON.stringify(draft)); }, { draftKey: canonical.draft_key, field });
      await page.reload({ waitUntil: "networkidle0" });
      const discarded = await page.evaluate((draftKey) => ({ answer: (document.querySelector("[data-workspace-field='answer_text']") as HTMLTextAreaElement | null)?.value ?? "", active_view: (document.querySelector("[data-workspace-navigation='active_view']") as HTMLSelectElement | null)?.value ?? "", cached: localStorage.getItem(draftKey) }), canonical.draft_key);
      if (discarded.answer !== canonical.answer || discarded.active_view !== canonical.active_view || discarded.cached !== null) fail(`workspace-incompatible-draft:${field}:${canonicalJson({ canonical, discarded })}`);
      incompatibleDiscarded.push(field);
    }
    await fillAt(page, "[data-workspace-field='answer_text']", "discarded-draft");
    await clickAt(page, "[data-workspace-action='clear-draft']");
    const cleared = await page.evaluate((draftKey) => ({ cached: localStorage.getItem(draftKey), status: document.querySelector("[data-workspace-status]")?.textContent ?? "" }), canonical.draft_key);
    const workspaceUrl = page.url();
    await page.goto("about:blank", { waitUntil: "networkidle0" });
    await page.goto(workspaceUrl, { waitUntil: "networkidle0" });
    const afterCloseReopen = await page.evaluate(() => ({ answer: (document.querySelector("[data-workspace-field='answer_text']") as HTMLTextAreaElement | null)?.value ?? "", active_view: (document.querySelector("[data-workspace-navigation='active_view']") as HTMLSelectElement | null)?.value ?? "" }));
    if (cleared.cached !== null || !cleared.status.includes("Draft cache discarded") || afterCloseReopen.answer !== canonical.answer || afterCloseReopen.active_view !== canonical.active_view) fail("workspace-clear-draft");
    return { compatible_cache_restores_mutable_navigation: { answer: compatible.answer, active_view: compatible.active_view }, protected_fields_not_restored: canonical.protected_tuple, incompatible_cache_discarded: incompatibleDiscarded, discard_action_clears_cache: cleared, close_reopen_defaults: afterCloseReopen, local_storage_is_draft_only: true };
  }
  if (checkId === "keyboard-navigation") return keyboardDetails(page);
  if (checkId === "focus-restoration") { await clickAt(page, "[data-workspace-queue]", 0); return { action: "select-first-workspace-queue-item", active: await page.evaluate(() => document.activeElement?.getAttribute("data-workspace-queue") ?? "") }; }
  if (checkId === "responsive-tabs") return { tabs: await elementCount(page, ".tabs a"), viewport, navigation: "anchor-links" };
  if (checkId === "no-js") return { observation_source: "javascript-disabled-visibility", payload_present: await elementCount(page, "#questionnaire-workspace-payload") };
  if (checkId === "print-candidate") return { observation_source: "reopened-pdf-clipping" };
  if (["contrast-light", "contrast-dark"].includes(checkId)) return contrastDetails(page, checkId === "contrast-light" ? "light" : "dark");
  if (checkId === "zoom-200") return zoomDetails(page, AUTHORING_VIEWPORTS.find(item => item.id === viewport)!);
  if (checkId === "reduced-motion") { await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]); return { reduced_motion: "reduce", media_query_matches: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches) }; }
  if (checkId === "forced-colours") return forcedColoursDetails(page);
  if (checkId === "overflow") return overflowDetails(page);
  return { observation_source: "workspace-static-contract", check_id: checkId };
}

async function collect(input: { readonly root: string; readonly repositoryRoot: string; readonly browser: Browser; readonly kind: ArtifactKind; readonly html: ArtifactHtml; readonly viewport: typeof AUTHORING_VIEWPORTS[number]; readonly chromiumVersion: string }): Promise<Details> {
  const context = await input.browser.createBrowserContext(); const page = await context.newPage(); const pageErrors: string[] = []; const consoleErrors: string[] = []; const resourceErrors: string[] = []; const unexpectedResources: string[] = [];
  try {
    await page.setViewport({ width: input.viewport.width, height: input.viewport.height, deviceScaleFactor: 1 }); const url = await artifactUrl(input.repositoryRoot, input.html); watchPage(page, url, pageErrors, consoleErrors, resourceErrors, unexpectedResources); await page.goto(url, { waitUntil: "networkidle0" }); const exchanges = input.kind === "support" ? await elementCount(page, ".exchange") : 0; const checks = [];
    for (const checkId of IDEATION_AUTHORING_CHECK_IDS) {
      if (input.kind === "workspace") {
        const details = await workspaceDetails(page, checkId, input.viewport.id, input.root);
        const observation = await outputJson(input.root, `checks/${input.viewport.id}/${input.kind}/${checkId}.json`, { schema: "ideation-authoring/check-observation/v1", artifact_kind: input.kind, viewport: input.viewport.id, check_id: checkId, observations: details });
        const evidencePaths = checkId === "final-actions" ? [details.downloaded_workspace as BrowserEvidenceFile, observation] : [observation];
        checks.push(check(input.kind, checkId, true, details, evidencePaths));
        continue;
      }
      if (input.kind === "support") {
        const applicable = ["header", "authority-notice", "keyboard-navigation", "focus-restoration", "contrast-light", "contrast-dark", "zoom-200", "reduced-motion", "forced-colours", "overflow", "no-js", "print-support"].includes(checkId) || (exchanges > 0 && ["search-filters", "item-queue", "focused-briefing", "responsive-tabs"].includes(checkId));
        let details: Details = { reason: exchanges === 0 && ["search-filters", "item-queue", "focused-briefing", "responsive-tabs"].includes(checkId) ? "zero-exchange" : "candidate-only" };
        if (applicable) {
          if (checkId === "header") details = await visibleDetails(page, "header h1", "support-header");
          else if (checkId === "authority-notice") details = await visibleDetails(page, ".notice", "support-notice");
          else if (checkId === "search-filters") { await clickAt(page, "[data-support-filter='all']"); const total = await elementCount(page, "[data-support-queue-item]"); const before = await visibleElementCount(page, "[data-support-queue-item]"); await fillAt(page, "[data-support-search]", "nonexistent-authoring-probe"); const filtered = await visibleElementCount(page, "[data-support-queue-item]"); await fillAt(page, "[data-support-search]", ""); const restored = await visibleElementCount(page, "[data-support-queue-item]"); if (total !== exchanges || before < 1 || before !== total || filtered !== 0 || restored !== before) fail("support-search-filter"); details = { query: "nonexistent-authoring-probe", total_count: total, before_count: before, filtered_visible_count: filtered, restored_visible_count: restored }; }
          else if (checkId === "item-queue") { await clickAt(page, "[data-support-filter='all']"); details = await visibleDetails(page, ".queue button", "support-queue"); }
          else if (checkId === "focused-briefing") { await clickAt(page, "[data-support-filter='all']"); await clickAt(page, "[data-support-select]", 1); const focused = await page.evaluate(() => ({ narrow: matchMedia("(max-width:68rem)").matches, visible_exchanges: [...document.querySelectorAll(".exchange")].filter(item => !(item as HTMLElement).hidden).length, active_exchange: document.querySelector(".queue button[aria-current='true']")?.getAttribute("data-support-select") ?? "", focused: (document.activeElement as HTMLElement | null)?.id ?? "", visible_queue_items: [...document.querySelectorAll("[data-support-queue-item]")].filter(item => item.getClientRects().length > 0).length, provenance_present: document.querySelectorAll(".provenance-disclosure").length })); const expectedQueueItems = focused.narrow ? 0 : exchanges; if (!focused.active_exchange || !focused.focused || focused.visible_exchanges !== 1 || focused.visible_queue_items !== expectedQueueItems || focused.provenance_present !== 1) fail(`support-focused-exchange:${canonicalJson(focused)}`); details = focused; }
          else if (checkId === "responsive-tabs") { const count = await elementCount(page, "[data-support-tab]"); if (input.viewport.id.startsWith("desktop")) { const state = await page.evaluate(() => ({ inner_width: window.innerWidth, media_narrow: matchMedia("(max-width:68rem)").matches, visible_tab_count: [...document.querySelectorAll("[data-support-tab]")].filter(tab => tab.getClientRects().length > 0).length, tablist_role: document.querySelector(".tabs")?.getAttribute("role"), panes: [...document.querySelectorAll("[data-support-pane]")].map(pane => ({ id: (pane as HTMLElement).id, role: pane.getAttribute("role"), labelled_by: pane.getAttribute("aria-labelledby"), hidden: (pane as HTMLElement).hidden, display: getComputedStyle(pane).display, visible: pane.getClientRects().length > 0 })) })); if (count !== 3 || state.visible_tab_count !== 0 || state.tablist_role !== null || state.panes.some(pane => pane.role !== null || pane.labelled_by !== null || pane.hidden || !pane.visible)) fail(`support-desktop-tabs-state:${canonicalJson(state)}`); details = { layout: "desktop", tab_count: count, ...state }; } else { const tabs = "[data-support-tab]"; await clickAt(page, tabs, 1); const pointer = await page.evaluate(() => ({ selected: document.querySelector("[data-support-tab][aria-selected='true']")?.getAttribute("data-support-tab") ?? "", visible_pane: document.querySelector("[data-support-pane]:not([hidden])")?.getAttribute("data-support-pane") ?? "" })); await pressAt(page, tabs, "ArrowRight", 1); const afterRight = await page.evaluate(() => ({ selected: document.querySelector("[data-support-tab][aria-selected='true']")?.getAttribute("data-support-tab") ?? "", active: (document.activeElement as HTMLElement | null)?.getAttribute("data-support-tab") ?? "" })); await pressAt(page, tabs, "End", 2); const afterEnd = await page.evaluate(() => ({ selected: document.querySelector("[data-support-tab][aria-selected='true']")?.getAttribute("data-support-tab") ?? "", active: (document.activeElement as HTMLElement | null)?.getAttribute("data-support-tab") ?? "" })); await pressAt(page, tabs, "Home", 2); const afterHome = await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; const style = active ? getComputedStyle(active) : null; return { selected: active?.getAttribute("data-support-tab") ?? "", focus: { outline_style: style?.outlineStyle ?? "", box_shadow: style?.boxShadow ?? "" } }; }); const paneTraversal: { name: string; visible_pane: string }[] = []; for (const index of [0, 1, 2]) { await clickAt(page, tabs, index); paneTraversal.push(await page.evaluate(() => ({ name: document.querySelector("[data-support-tab][aria-selected='true']")?.getAttribute("data-support-tab") ?? "", visible_pane: document.querySelector("[data-support-pane]:not([hidden])")?.getAttribute("data-support-pane") ?? "" }))); } const state = await page.evaluate(() => ({ selected_count: document.querySelectorAll("[data-support-tab][aria-selected='true']").length, visible_pane_count: [...document.querySelectorAll("[data-support-pane]")].filter(item => !(item as HTMLElement).hidden).length, active_id: (document.activeElement as HTMLElement | null)?.id ?? "" })); if (count !== 3 || state.selected_count !== 1 || state.visible_pane_count !== 1 || !state.active_id || pointer.selected.length === 0 || pointer.selected !== pointer.visible_pane || afterRight.selected.length === 0 || afterRight.selected !== afterRight.active || afterEnd.selected.length === 0 || afterEnd.selected !== afterEnd.active || afterHome.selected.length === 0 || (afterHome.focus.outline_style === "none" && afterHome.focus.box_shadow === "none") || paneTraversal.length !== count || paneTraversal.some(item => item.name !== item.visible_pane)) fail("support-tabs-state"); details = { layout: input.viewport.id.startsWith("tablet") ? "tablet" : "mobile", tab_count: count, pointer_activation: pointer, traversal: { after_right: afterRight, after_end: afterEnd, after_home: afterHome, pane_traversal: paneTraversal }, visible_focus: afterHome.focus, ...state }; } }
          else if (checkId === "overflow") details = await overflowDetails(page);
          else if (checkId === "zoom-200") details = await zoomDetails(page, input.viewport);
          else if (checkId === "contrast-light") details = await contrastDetails(page, "light");
          else if (checkId === "contrast-dark") details = await contrastDetails(page, "dark");
          else if (checkId === "reduced-motion") { await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]); const active = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches); if (!active) fail("reduced-motion-not-active"); details = { reduced_motion: "reduce", media_query_matches: active, animation_play_states: await page.evaluate(() => document.getAnimations().map(animation => animation.playState)) }; }
          else if (checkId === "forced-colours") details = await forcedColoursDetails(page);
          else if (checkId === "keyboard-navigation" || checkId === "focus-restoration") details = await keyboardDetails(page);
          else details = { observation_source: checkId === "no-js" ? "javascript-disabled-visibility" : "reopened-pdf-clipping" };
        }
        const evidencePaths = applicable ? [await outputJson(input.root, `checks/${input.viewport.id}/${input.kind}/${checkId}.json`, { schema: "ideation-authoring/check-observation/v1", artifact_kind: input.kind, viewport: input.viewport.id, check_id: checkId, observations: details })] : [];
        checks.push(check(input.kind, checkId, applicable, details, evidencePaths));
      } else if (checkId === "print-support" || checkId === "image-dialog" || checkId === "research-dialog") {
        checks.push(check(input.kind, checkId, false, { reason: checkId === "print-support" ? "candidate-only" : "artifact-manifest-omitted" }));
      } else {
        const details = await candidateDetails(page, checkId, input.viewport.id);
        const evidencePaths = [await outputJson(input.root, `checks/${input.viewport.id}/${input.kind}/${checkId}.json`, { schema: "ideation-authoring/check-observation/v1", artifact_kind: input.kind, viewport: input.viewport.id, check_id: checkId, observations: details })];
        checks.push(check(input.kind, checkId, true, details, evidencePaths));
      }
    }
    const interactions = await outputJson(input.root, `interactions/${input.viewport.id}-${input.kind}.json`, { schema: BROWSER_VIEWPORT_SCHEMA, artifact_kind: input.kind, viewport: input.viewport.id, chromium_version: input.chromiumVersion, checks, actions: checks.map(item => item.check_id) });
    const focus = await outputJson(input.root, `focus/${input.viewport.id}-${input.kind}.json`, { schema: BROWSER_VIEWPORT_SCHEMA, artifact_kind: input.kind, viewport: input.viewport.id, keyboard_observation: await keyboardDetails(page) });
    if (input.kind === "candidate") await showMobilePane(page, input.viewport.id, "review");
    else if (!input.viewport.id.startsWith("desktop") && exchanges > 0) await clickAt(page, "[data-support-tab='exchange']");
    const measuredElements = await page.evaluate((kind) => { const selector = kind === "candidate" ? ".key-point, .review-option, .review-presentation" : kind === "workspace" ? ".workspace-question, .workspace-editor, .workspace-provenance-pane" : ".exchange, .notice"; return [...document.querySelectorAll(selector)].filter(element => { if (kind === "candidate") { const owner = element.closest("[data-review-summary]") as HTMLElement | null; return owner === null || !owner.hidden; } return !(element as HTMLElement).hidden; }).map(element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return { text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160), left: rect.left, right: rect.right, width: rect.width, height: rect.height, display: style.display, visibility: style.visibility, hidden: (element as HTMLElement).hidden }; }); }, input.kind); const invalidMeasurements = measuredElements.filter(element => element.width <= 0 || element.height <= 0 || element.left < 0 || element.right > input.viewport.width || element.display === "none" || element.visibility === "hidden" || element.hidden); if (measuredElements.length === 0 || invalidMeasurements.length > 0) fail(`measurements-visible-unclipped:${canonicalJson(invalidMeasurements)}`);
    const screenshotCapture = await page.evaluate((tileHeight) => {
      window.scrollTo(0, 0);
      const source_width = document.documentElement.scrollWidth;
      const source_height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      return { mode: "full-width-vertical-tiles" as const, source_width, source_height, tile_height: tileHeight, tile_count: Math.ceil(source_height / tileHeight) };
    }, MAX_SCREENSHOT_TILE_HEIGHT);
    if (screenshotCapture.source_width !== input.viewport.width || screenshotCapture.source_height < 1 || screenshotCapture.tile_count < 1) fail(`screenshot-geometry:${input.viewport.id}:${input.kind}`);
    const measurements = await outputJson(input.root, `measurements/${input.viewport.id}-${input.kind}.json`, { schema: BROWSER_VIEWPORT_SCHEMA, artifact_kind: input.kind, viewport: input.viewport.id, ...(await overflowDetails(page)), measured_elements: measuredElements, screenshot_capture: screenshotCapture });
    const screenshots = [];
    for (let tileIndex = 0, y = 0; y < screenshotCapture.source_height; tileIndex += 1, y += screenshotCapture.tile_height) {
      const height = Math.min(screenshotCapture.tile_height, screenshotCapture.source_height - y);
      const bytes = await page.screenshot({ type: "webp", captureBeyondViewport: true, clip: { x: 0, y, width: screenshotCapture.source_width, height } });
      if (bytes.byteLength === 0) fail(`screenshot-empty:${input.viewport.id}:${input.kind}:${tileIndex}`);
      const file = await outputFile(input.root, `screenshots/${input.viewport.id}-${input.kind}-${String(tileIndex).padStart(4, "0")}.webp`, bytes);
      screenshots.push(Object.freeze({ tile_index: tileIndex, y, height, ...file }));
    }
    if (screenshots.length !== screenshotCapture.tile_count) fail(`screenshot-tile-count:${input.viewport.id}:${input.kind}`);
    const baseline = await domInventory(page, input.kind); const disabledContext = await input.browser.createBrowserContext(); let noJs: BrowserEvidenceFile;
    try {
      const staticPage = await disabledContext.newPage();
      watchPage(staticPage, url, pageErrors, consoleErrors, resourceErrors, unexpectedResources);
      const session = await staticPage.target().createCDPSession();
      await session.send("Emulation.setScriptExecutionDisabled", { value: true });
      await staticPage.setViewport({ width: input.viewport.width, height: input.viewport.height });
      await staticPage.goto(url, { waitUntil: "networkidle0" });
      const staticInventory = await domInventory(staticPage, input.kind);
      const staticVisibility = await staticPage.evaluate((kind) => { const selector = kind === "candidate" ? "[data-review-summary],[data-feedback-editor],[data-feedback-fields]" : kind === "workspace" ? ".workspace-question,[data-workspace-field],#authority" : ".exchange,[data-support-pane]"; const elements = [...document.querySelectorAll(selector)]; const hidden = elements.filter(element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return (element as HTMLElement).hidden || style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0; }); return { reviewed_element_count: elements.length, hidden_element_count: hidden.length, hidden_ids: hidden.map(element => (element as HTMLElement).id || element.getAttribute("data-review-summary") || element.getAttribute("data-feedback-editor") || element.getAttribute("data-workspace-field") || "") }; }, input.kind);
      if (canonicalJson(staticInventory.inventory) !== canonicalJson(baseline.inventory) || staticVisibility.hidden_element_count !== 0) fail(`no-js-visibility:${input.kind}:${canonicalJson(staticVisibility.hidden_ids)}`);
      noJs = await outputJson(input.root, `no-js/${input.viewport.id}-${input.kind}.json`, { schema: BROWSER_VIEWPORT_SCHEMA, artifact_kind: input.kind, viewport: input.viewport.id, inventory: staticInventory.inventory, semantic_inventory: staticInventory.semantic_inventory, linear_order: staticInventory.linear_order, javascript_disabled: true, ...staticVisibility });
    } finally { await disabledContext.close(); }
    const print = await printRecord(page, input.root, input.kind, input.viewport);
    const pageErrorFile = await outputJson(input.root, `page-errors/${input.viewport.id}-${input.kind}.json`, { schema: BROWSER_VIEWPORT_SCHEMA, artifact_kind: input.kind, viewport: input.viewport.id, errors: pageErrors });
    const consoleErrorFile = await outputJson(input.root, `console-errors/${input.viewport.id}-${input.kind}.json`, { schema: BROWSER_VIEWPORT_SCHEMA, artifact_kind: input.kind, viewport: input.viewport.id, errors: consoleErrors });
    const resourceErrorFile = await outputJson(input.root, `resource-errors/${input.viewport.id}-${input.kind}.json`, { schema: BROWSER_VIEWPORT_SCHEMA, artifact_kind: input.kind, viewport: input.viewport.id, errors: resourceErrors, failed_requests: resourceErrors, unexpected_successful_requests: unexpectedResources });
    if (pageErrors.length !== 0 || consoleErrors.length !== 0 || resourceErrors.length !== 0 || unexpectedResources.length !== 0) fail(`browser-evidence:${canonicalJson({ page_errors: pageErrors, console_errors: consoleErrors, failed_requests: resourceErrors, unexpected_successful_requests: unexpectedResources })}`);
    return Object.freeze({ kind: input.kind, html: input.html, checks, interactions, focus, measurements, page_errors: pageErrorFile, console_errors: consoleErrorFile, resource_errors: resourceErrorFile, no_js: noJs, screenshots, print: [print] });
  } finally { await context.close(); }
}
function parseCli(argv: readonly string[]): { readonly artifact_manifest: string; readonly browser_root: string } {
  if (argv.length !== 4 || argv[0] !== "--artifact-manifest" || argv[2] !== "--browser-root" || argv[1]?.startsWith("--") || argv[3]?.startsWith("--")) fail("cli-arguments");
  return { artifact_manifest: argv[1]!, browser_root: argv[3]! };
}

export async function runAuthoringBrowser(input: { readonly artifact_manifest: string; readonly browser_root: string }): Promise<void> {
  const artifactManifest = resolve(input.artifact_manifest);
  const artifact = await readArtifactManifest(artifactManifest);
  const repositoryRoot = resolve(dirname(artifactManifest), "runtime");
  const browserRoot = resolve(input.browser_root);
  try { await stat(browserRoot); fail("browser-root-exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const chromiumVersion = await browser.version();
    const viewports = [];
    for (const viewport of AUTHORING_VIEWPORTS) {
      const support = await collect({ root: browserRoot, repositoryRoot, browser, kind: "support", html: artifact.support, viewport, chromiumVersion });
      const candidate = await collect({ root: browserRoot, repositoryRoot, browser, kind: "candidate", html: artifact.candidate, viewport, chromiumVersion });
      if (artifact.workspace === null) fail("workspace-artifact-missing");
      const workspace = await collect({ root: browserRoot, repositoryRoot, browser, kind: "workspace", html: artifact.workspace, viewport, chromiumVersion });
      viewports.push({ id: viewport.id, width: viewport.width, height: viewport.height, artifacts: [support, candidate, workspace] });
    }
    await outputJson(browserRoot, "browser-manifest.json", { schema: BROWSER_RUN_SCHEMA, artifact_manifest_path: artifactManifest, artifact_manifest_sha256: artifact.sha256, chromium_version: chromiumVersion, viewports }, BROWSER_MANIFEST_JSON_LIMITS);
  } finally { await browser.close(); }
}

if (import.meta.main) await runAuthoringBrowser(parseCli(Bun.argv.slice(2)));
