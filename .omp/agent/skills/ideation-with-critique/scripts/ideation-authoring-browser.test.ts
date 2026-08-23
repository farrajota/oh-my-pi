import { describe, expect, test } from "bun:test";
import puppeteer, { type Page } from "puppeteer-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { createAuthoringFixture } from "./ideation-authoring-fixture.ts";
import { AUTHORING_VIEWPORTS, BROWSER_RUN_SCHEMA, BROWSER_VIEWPORT_SCHEMA, IDEATION_AUTHORING_CHECK_IDS, runAuthoringBrowser } from "./ideation-authoring-browser.ts";
import { validateBrowserErrorEvidence } from "./ideation-authoring-evidence.ts";
import { issueInitialWorkspace, reopenQuestionnaireWorkspace, saveQuestionnaireWorkspace } from "./ideation-support-runtime.ts";

const implementationRoot = resolve(import.meta.dir, "../../../../..");

function replaceWorkspacePayload(html: Uint8Array | string, payload: unknown): Buffer {
  const text = typeof html === "string" ? html : new TextDecoder("utf-8", { fatal: true }).decode(html);
  const encoded = canonicalJson(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return Buffer.from(text.replace(/(<script\b[^>]*id=["']questionnaire-workspace-payload["'][^>]*>)([\s\S]*?)(<\/script>)/i, `$1${encoded}$3`), "utf8");
}

describe("ideation authoring browser contract", () => {
  test("declares the three exact evidence viewports in deterministic order", () => {
    expect(AUTHORING_VIEWPORTS).toEqual([
      { id: "desktop-1440x900", width: 1440, height: 900 },
      { id: "tablet-1024x768", width: 1024, height: 768 },
      { id: "mobile-390x844", width: 390, height: 844 },
    ]);
  });

  test("keeps the complete ordered closed checklist", () => {
    expect(IDEATION_AUTHORING_CHECK_IDS).toEqual([
      "header", "authority-notice", "search-filters", "item-queue", "focused-briefing", "four-options", "recommendation", "feedback-controls", "item-feedback-isolation", "decision-dock", "relationship-map", "relationship-text", "markdown-preview", "source-drawer", "image-dialog", "research-dialog", "responsive-tabs", "final-actions", "protected-payload", "draft-retention", "keyboard-navigation", "focus-restoration", "contrast-light", "contrast-dark", "zoom-200", "reduced-motion", "forced-colours", "overflow", "no-js", "print-support", "print-candidate",
    ]);
  });

  test("uses versioned closed schemas for traversal and viewport evidence", () => {
    expect(BROWSER_RUN_SCHEMA).toBe("ideation-authoring/browser-run/v1");
    expect(BROWSER_VIEWPORT_SCHEMA).toBe("ideation-authoring/browser-viewport/v1");
  });
});

test("exposes browser declarations while keeping Puppeteer lazy", () => {
  expect(IDEATION_AUTHORING_CHECK_IDS).toHaveLength(31);
  expect(runAuthoringBrowser).toBeFunction();
});

test("writes per-check observation records instead of asserted pass markers", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  expect(source).toContain("ideation-authoring/check-observation/v1");
  expect(source).toContain("checks/${input.viewport.id}/${input.kind}/${checkId}.json");
  expect(source).not.toContain("verified: true");
  expect(source).not.toContain("deferred: true");
  expect(source).not.toContain("focus_visible: true");
  expect(source).not.toContain("return_checks: true");
  expect(source).not.toContain("saved_response_target_binding: true");
});

test("records behavioral interaction, complete semantic inventories, and recomputed PDF clipping evidence", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  const validator = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain("getBoundingClientRect");
  expect(source).toContain("restored_values");
  expect(source).toContain("disabled_before_input");
  expect(source).toContain("disabled_after_requested_change");
  expect(source).toContain("disabled_after_complete_feedback");
  expect(source).toContain("SEMANTIC_INVENTORY_SELECTOR");
  expect(source).toContain("[data-approval-dossier-visible-markdown]");
  expect(source).toContain(".option-recommendation");
  expect(source).toContain("option_recommendation_marker_count");
  expect(source).toContain("tablist_role");
  expect(source).toContain("Emulation.setScriptExecutionDisabled");
  expect(validator).toContain("feedback:gating-evidence");
  expect(validator).toContain("no-js:candidate-semantic-inventory");
  expect(validator).toContain("print:recomputed-page");
});

test("builds print and no-JavaScript inventories from every authority-bearing semantic unit", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  expect(source).toContain("async function printableInventory");
  expect(source).toContain("button,table th,table td,dt,dd,label,.optional,select,textarea,input,code,pre,#authority,.option-recommendation,[data-approval-dossier-visible-markdown]");
  expect(source).toContain("semanticInventory");
  expect(source).toContain("semantic_inventory: staticInventory.semantic_inventory");
});

test("distinguishes true right-edge overflow from an off-canvas skip link", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  expect(source).toContain("item.right > clientWidth + 0.5");
  expect(source).not.toContain("item.left < -0.5 || item.right > clientWidth + 0.5");
});

test("rejects zoom observations with any right-edge offender", async () => {
  const browserSource = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  expect(browserSource).toContain("measurements.horizontal_overflow || measurements.offenders.length !== 0");

  const evidenceSource = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(evidenceSource).toContain('zoom.horizontal_overflow !== false');
  expect(evidenceSource).toContain('zoom.scroll_width > zoom.client_width');
  expect(evidenceSource).toContain('!Array.isArray(zoom.offenders) || zoom.offenders.length !== 0');
});

test("wraps support tabs instead of using horizontal scrolling", async () => {
  const source = await Bun.file(import.meta.dir + "/../templates/ideation-support-reference.css").text();
  expect(source).toContain(".tabs{display:flex;flex-wrap:wrap;");
  expect(source).not.toContain(".tabs{overflow:auto}");
});

test("drives responsive tab behavior at tablet and mobile instead of accepting a stacked proxy", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  expect(source).toContain("ArrowRight");
  expect(source).toContain("visible_pane_count !== 1");
  expect(source).toContain('layout: viewport.startsWith("tablet") ? "tablet" : "mobile"');
  expect(source).toContain("support-tabs-state");
});

test("captures pointer activation, full roving-tab traversal, visible focus, and pane traversal", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  expect(source).toContain("tabs-pointer-activation");
  expect(source).toContain("pointer_activation: pointer");
  expect(source).toContain("pane_traversal: paneTraversal");
  expect(source).toContain('afterRight.selected !== "feedback"');
  expect(source).toContain('afterEnd.selected !== "notes"');
  expect(source).toContain('afterHome.selected !== "queue"');
  expect(source).toContain("visible_focus: afterHome.focus");
});

test("records and desktop-validates the feedback optional badge geometry", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  expect(source).toContain("#review-pane-feedback .panel-heading > .navigation-badge");
  expect(source).toContain("optional_badge");
  expect(source).toContain("feedback-optional-badge");
});

test("records retained target selection, disposition, and draft after navigation", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  const validator = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain("retained_selection");
  expect(source).toContain("retained_disposition");
  expect(source).toContain("selected_target !== restored.current_target");
  expect(validator).toContain("draft.retained-selection");
  expect(validator).toContain("draft.retained-disposition");
});

test("keeps one desktop support exchange selected without hiding queue provenance", async () => {
  const browser = await Bun.file(import.meta.dir + "/ideation-authoring-browser.ts").text();
  const supportCss = await Bun.file(import.meta.dir + "/../templates/ideation-support-reference.css").text();
  expect(browser).toContain("focused.visible_exchanges !== 1");
  expect(browser).toContain("const expectedQueueItems = focused.narrow ? 0 : exchanges");
  expect(browser).toContain("focused.visible_queue_items !== expectedQueueItems");
  expect(browser).toContain("focused.provenance_present !== 1");
  expect(supportCss).toContain(".exchange[hidden]{display:none!important}");
});

test("uses readable heading scales and non-obscuring final controls", async () => {
  const dossierCss = await Bun.file(import.meta.dir + "/../../approval-dossier-runtime/templates/dossier.css").text();
  expect(dossierCss).toContain("font-size: clamp(2.35rem, 4vw, 4.5rem)");
  expect(dossierCss).toContain("font-size: clamp(1.8rem, 3vw, 2.65rem)");
  expect(dossierCss).toContain(".controls {\n\tposition: static;");
	expect(dossierCss).toContain("position: static;");
});

test("executes every candidate check through local Chromium", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-authoring-browser-"));
  const runtime = join(root, "runtime");
  const artifactManifest = join(root, "artifact-manifest.json");
  const browserRoot = join(root, "browser");
  try {
    await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture: ".omp/agent/skills/ideation-with-critique/fixtures/authoring-review-v8.json", submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest });
    const beforeBrowser = await reopenQuestionnaireWorkspace({ repository_root: runtime, slug: "authoring-review" });
    const beforeBrowserHtml = await readFile(join(runtime, beforeBrowser.workspace_path));
    await runAuthoringBrowser({ artifact_manifest: artifactManifest, browser_root: browserRoot });
    const afterBrowser = await reopenQuestionnaireWorkspace({ repository_root: runtime, slug: "authoring-review" });
    expect(await readFile(join(runtime, afterBrowser.workspace_path))).toEqual(beforeBrowserHtml);
    expect(afterBrowser.workspace).toEqual(beforeBrowser.workspace);
    const manifest = JSON.parse(await readFile(join(browserRoot, "browser-manifest.json"), "utf8")) as { viewports: readonly { id: string; artifacts: readonly { kind: string; resource_errors: { path: string }; checks: readonly { check_id: string; status: string; details: Record<string, unknown> }[] }[] }[] };
    expect(manifest.viewports.map((viewport) => viewport.id)).toEqual(AUTHORING_VIEWPORTS.map((viewport) => viewport.id));
    for (const viewport of manifest.viewports) {
      const support = viewport.artifacts.find((artifact) => artifact.kind === "support");
      const search = support?.checks.find((check) => check.check_id === "search-filters");
      expect(search?.status).toBe("pass");
      expect(search?.details).toEqual({ query: "nonexistent-authoring-probe", total_count: 2, before_count: 2, filtered_visible_count: 0, restored_visible_count: 2 });
      const candidate = viewport.artifacts.find((artifact) => artifact.kind === "candidate");
      expect(candidate?.checks.map((check) => check.check_id)).toEqual(IDEATION_AUTHORING_CHECK_IDS);
      expect(candidate?.checks.every((check) => check.status === "pass" || check.status === "not-applicable")).toBe(true);
      const workspace = viewport.artifacts.find((artifact) => artifact.kind === "workspace");
      expect(workspace?.checks.map((check) => check.check_id)).toEqual(IDEATION_AUTHORING_CHECK_IDS);
      expect(workspace?.checks.find((check) => check.check_id === "protected-payload")?.status).toBe("pass");
      expect(workspace?.checks.find((check) => check.check_id === "draft-retention")?.status).toBe("pass");
      const workspaceFinalActions = workspace?.checks.find((check) => check.check_id === "final-actions");
      expect(workspaceFinalActions?.details.canonical_payload_unchanged).toBe(true);
      expect(workspaceFinalActions?.details.all_mutable_control_defaults).toEqual(workspaceFinalActions?.details.embedded_payload_values);
      expect(workspace?.checks.find((check) => check.check_id === "draft-retention")?.details.incompatible_cache_discarded).toEqual(["schema", "workspace_id", "workspace_issuance_id", "inventory"]);
      for (const artifact of viewport.artifacts) {
        validateBrowserErrorEvidence(
          JSON.parse(await readFile(join(browserRoot, artifact.resource_errors.path), "utf8")),
          artifact.kind as "support" | "candidate" | "workspace",
          viewport.id,
          "resource_errors",
        );
      }
    }
    const desktopWorkspace = manifest.viewports[0]?.artifacts.find((artifact) => artifact.kind === "workspace");
    const downloaded = desktopWorkspace?.checks.find((check) => check.check_id === "final-actions")?.details.downloaded_workspace as { path?: unknown } | undefined;
    expect(typeof downloaded?.path).toBe("string");
    const downloadedBytes = await readFile(join(browserRoot, downloaded!.path as string));
    const downloadedText = downloadedBytes.toString("utf8");
    expect(downloadedText).toContain("downloaded-workspace-answer");
    const downloadedPayloadMatch = downloadedText.match(/<script\b[^>]*id=["']questionnaire-workspace-payload["'][^>]*>([\s\S]*?)<\/script>/i);
    if (downloadedPayloadMatch === null) throw new TypeError("downloaded workspace payload is missing");
    const downloadedPayload = JSON.parse(downloadedPayloadMatch[1]!.trim()) as { selected_occurrence_id: string | null; navigation_state: { active_view: string; scroll_anchor: string | null }; response_items: readonly Record<string, unknown>[] };
    const downloadedByOccurrence = new Map(downloadedPayload.response_items.map(item => [item.occurrence_id, item]));
    const authorityManifest = JSON.parse(await readFile(artifactManifest, "utf8")) as { state: { snapshot: { path: string } }; workspace: { source_response_record: { path: string } } };
    const active = await issueInitialWorkspace({ repository_root: runtime, state_snapshot_path: authorityManifest.state.snapshot.path, implementation_root: implementationRoot, response_record_path: authorityManifest.workspace.source_response_record.path });
    const activeHtml = await readFile(join(runtime, active.workspace_path));
    const activeResponseItems = active.workspace.response_items.map(item => {
      const downloadedItem = downloadedByOccurrence.get(item.occurrence_id);
      if (downloadedItem === undefined) throw new TypeError("downloaded workspace occurrence inventory mismatch");
      return { ...item, answer_text: downloadedItem.answer_text, validation: downloadedItem.validation, defer_status: downloadedItem.defer_status, defer_reason: downloadedItem.defer_reason, rationale: downloadedItem.rationale, selected_option: downloadedItem.selected_option, context_requests: downloadedItem.context_requests, evidence_references: downloadedItem.evidence_references, notebook_content: downloadedItem.notebook_content };
    });
    const activeEditedWorkspace = replaceWorkspacePayload(activeHtml, { ...active.workspace, workspace_revision: active.workspace.workspace_revision + 1, selected_occurrence_id: downloadedPayload.selected_occurrence_id, response_items: activeResponseItems, navigation_state: downloadedPayload.navigation_state });
    const protectedTamperedWorkspace = Buffer.from(new TextDecoder().decode(activeEditedWorkspace).replace(/("target":)"(?:\\.|[^"\\])*"/, "$1\"tampered-protected-target\""), "utf8");
    await expect(saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: protectedTamperedWorkspace })).rejects.toThrow("occurrence identity mismatch");
    expect((await reopenQuestionnaireWorkspace({ repository_root: runtime, slug: "authoring-review" })).workspace).toEqual(active.workspace);
    const injectedWorkspace = Buffer.from(new TextDecoder().decode(activeEditedWorkspace).replace("</body>", "<img src=\"https://outside.invalid/questionnaire.png\" onerror=\"window.__injectedHandler=true\"><script>window.__injectedScript=true</script><button onclick=\"window.__injectedClick=true\">injected</button></body>"), "utf8");
    const save = await saveQuestionnaireWorkspace({ repository_root: runtime, workspace_html: injectedWorkspace });
    expect(save.outcome).toBe("saved");
    const reopened = await reopenQuestionnaireWorkspace({ repository_root: runtime, slug: "authoring-review" });
    expect(reopened.workspace.response_items[0]?.answer_text).toBe("downloaded-workspace-answer");
    const stableHtml = await readFile(join(runtime, reopened.workspace_path), "utf8");
    expect(stableHtml).not.toContain("outside.invalid/questionnaire.png");
    expect(stableHtml).not.toContain("__injectedScript");
    expect(stableHtml).not.toContain("__injectedHandler");
    expect(stableHtml).not.toContain("__injectedClick");
    const mutableFields = ["answer_text", "validation", "defer_status", "defer_reason", "rationale", "selected_option", "context_requests", "evidence_references", "notebook_content"] as const;
    const expectedWorkspace = { fields: reopened.workspace.response_items.flatMap(item => mutableFields.map(field => ({ key: `${item.occurrence_id}/${field}`, value: Array.isArray(item[field]) ? item[field].join("\n") : item[field] ?? "" }))), navigation: Object.entries(reopened.workspace.navigation_state).map(([key, value]) => ({ key, value: value ?? "" })) };
    const verificationBrowser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    try {
      const observeWorkspace = async (page: Page) => page.evaluate(() => { const payload = JSON.parse(document.getElementById("questionnaire-workspace-payload")?.textContent ?? "null"); const fields = [...document.querySelectorAll("[data-workspace-item][data-workspace-field]")].map(control => { const element = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; const value = element instanceof HTMLTextAreaElement ? element.defaultValue : element instanceof HTMLSelectElement ? [...element.options].find(option => option.defaultSelected)?.value ?? "" : element.getAttribute("value") ?? ""; return { key: `${element.dataset.workspaceItem}/${element.dataset.workspaceField}`, value }; }); const navigation = [...document.querySelectorAll("[data-workspace-navigation]")].map(control => { const element = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; const value = element instanceof HTMLTextAreaElement ? element.defaultValue : element instanceof HTMLSelectElement ? [...element.options].find(option => option.defaultSelected)?.value ?? "" : element.getAttribute("value") ?? ""; return { key: element.dataset.workspaceNavigation ?? "", value }; }); const payloadFields = payload.response_items.flatMap((item: Record<string, unknown>) => ["answer_text", "validation", "defer_status", "defer_reason", "rationale", "selected_option", "context_requests", "evidence_references", "notebook_content"].map(field => ({ key: `${item.occurrence_id}/${field}`, value: Array.isArray(item[field]) ? item[field].join("\n") : item[field] ?? "" }))); const payloadNavigation = Object.entries(payload.navigation_state).map(([key, value]) => ({ key, value: value ?? "" })); return { defaults: { fields, navigation }, payload: { fields: payloadFields, navigation: payloadNavigation } }; });
      const downloadedPage = await verificationBrowser.newPage();
      await downloadedPage.goto(pathToFileURL(join(browserRoot, downloaded!.path as string)).href, { waitUntil: "networkidle0" });
      expect(await observeWorkspace(downloadedPage)).toEqual({ defaults: expectedWorkspace, payload: expectedWorkspace });
      await downloadedPage.close();
      const javaScriptStablePage = await verificationBrowser.newPage();
      await javaScriptStablePage.goto(pathToFileURL(join(runtime, reopened.workspace_path)).href, { waitUntil: "networkidle0" });
      expect(await observeWorkspace(javaScriptStablePage)).toEqual({ defaults: expectedWorkspace, payload: expectedWorkspace });
      await javaScriptStablePage.close();
      const noJavaScriptStablePage = await verificationBrowser.newPage();
      await noJavaScriptStablePage.setJavaScriptEnabled(false);
      await noJavaScriptStablePage.goto(pathToFileURL(join(runtime, reopened.workspace_path)).href, { waitUntil: "networkidle0" });
      expect(await observeWorkspace(noJavaScriptStablePage)).toEqual({ defaults: expectedWorkspace, payload: expectedWorkspace });
      await noJavaScriptStablePage.close();
    } finally { await verificationBrowser.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
