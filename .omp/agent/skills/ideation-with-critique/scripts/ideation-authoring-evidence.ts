import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

import { canonicalJson, hashRawBytes, type CanonicalJsonLimits } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { inspectPdfContentBounds, PDF_CONTENT_BOUNDS_TOLERANCE_POINTS, type PdfContentInspection, type PdfContentPageInspection } from "./ideation-pdf-content-inspection.ts";
import { validateHandoffCheckResult } from "./ideation-handoff-check.ts";

export const COMMAND_RESULT_SCHEMA = "ideation-authoring/command-result/v1" as const;
export const BROWSER_EVIDENCE_SCHEMA = "ideation-authoring/browser-evidence/v1" as const;
export const ARTIFACT_MANIFEST_SCHEMAS = Object.freeze(["ideation-authoring/artifact-manifest/v1", "ideation-authoring/artifact-manifest/v2", "ideation-authoring/artifact-manifest/v3"] as const);
export const BROWSER_MANIFEST_JSON_LIMITS: CanonicalJsonLimits = Object.freeze({ maximum_bytes: 8 * 1024 * 1024, maximum_items: 100_000 });
export const FOCUSED_COMMAND_IDS = [
  "focused-01-ideation", "focused-02-approval", "focused-03-cross-workflow", "focused-04-extension", "focused-05-handoff",
] as const;
export type FocusedCommandId = (typeof FOCUSED_COMMAND_IDS)[number];
const ARTIFACTS = ["support", "candidate", "workspace"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const VIEWPORTS = ["desktop-1440x900", "tablet-1024x768", "mobile-390x844"] as const;
const VIEWPORT_WIDTHS = [1_440, 1_024, 390] as const;
const VIEWPORT_HEIGHTS = [900, 768, 844] as const;
interface NoJsEvidenceIdentity {
  readonly artifact_manifest_schema: (typeof ARTIFACT_MANIFEST_SCHEMAS)[number];
  readonly artifact_manifest_sha256: string;
  readonly browser_manifest_sha256: string;
}
type HistoricalEvidenceRound = 2 | 3 | 4;
const HISTORICAL_EVIDENCE_IDENTITIES = Object.freeze([
  Object.freeze({ round: 2 as const, artifact_manifest_schema: "ideation-authoring/artifact-manifest/v1" as const, artifact_manifest_sha256: "29150bc679d5fbabb9d5933c032b3af935769c88bd5a975ba25607b094a6d817", browser_manifest_sha256: "87d550feb04b82aa4c35edfcd9874ddba615cd710e3d005d92dc670f00c8f8d2" }),
  Object.freeze({ round: 3 as const, artifact_manifest_schema: "ideation-authoring/artifact-manifest/v2" as const, artifact_manifest_sha256: "8bc662ab3c5b22e6ea99960d2efc1c4cfa34e1718871d51c62a2b96984ebfca8", browser_manifest_sha256: "d2372d2cec3abc0d87517cc4e4c9dd93dbf75c5b46c3d48acb2b8cc4ce2351a6" }),
  Object.freeze({ round: 4 as const, artifact_manifest_schema: "ideation-authoring/artifact-manifest/v2" as const, artifact_manifest_sha256: "50b9b6cb12abd21cf8148a9f4cea709ddc745e127da95b98278e6f67b1d0f052", browser_manifest_sha256: "aedb1959b1e57a44903478c769026b312b83e5e442da806fb06090350d87757e" }),
]);
function historicalEvidenceRound(identity: NoJsEvidenceIdentity | undefined): HistoricalEvidenceRound | null {
  const match = HISTORICAL_EVIDENCE_IDENTITIES.find(historical => historical.artifact_manifest_schema === identity?.artifact_manifest_schema
    && historical.artifact_manifest_sha256 === identity.artifact_manifest_sha256
    && historical.browser_manifest_sha256 === identity.browser_manifest_sha256);
  return match?.round ?? null;
}
function isLegacyRoundTwoNoJsEvidence(identity: NoJsEvidenceIdentity | undefined): boolean {
  return historicalEvidenceRound(identity) === 2;
}
function predatesBadgeGeometryEvidence(identity: NoJsEvidenceIdentity | undefined): boolean {
  return historicalEvidenceRound(identity) !== null;
}
const CHECKS = [
  "header", "authority-notice", "search-filters", "item-queue", "focused-briefing", "four-options", "recommendation", "feedback-controls", "item-feedback-isolation", "decision-dock", "relationship-map", "relationship-text", "markdown-preview", "source-drawer", "image-dialog", "research-dialog", "responsive-tabs", "final-actions", "protected-payload", "draft-retention", "keyboard-navigation", "focus-restoration", "contrast-light", "contrast-dark", "zoom-200", "reduced-motion", "forced-colours", "overflow", "no-js", "print-support", "print-candidate",
] as const;

export type IdeationAuthoringCheckId = (typeof CHECKS)[number];
type JsonObject = Record<string, unknown>;

function fail(message: string): never { throw new TypeError(`IDEATION_AUTHORING_EVIDENCE_INVALID:${message}`); }
function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label}:object`);
  return value as JsonObject;
}
function closed(value: unknown, label: string, keys: readonly string[]): JsonObject {
  const result = object(value, label);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label}:keys`);
  return result;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label}:text`);
  return value;
}
function sha(value: unknown, label: string): string { const result = text(value, label); if (!SHA256.test(result)) fail(`${label}:sha256`); return result; }
function count(value: unknown, label: string): number { if (!Number.isInteger(value) || (value as number) < 0) fail(`${label}:byte-count`); return value as number; }
function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] { if (typeof value !== "string" || !values.includes(value)) fail(`${label}:enum`); return value as T[number]; }
function list(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) fail(`${label}:array`); return value; }
function relativePath(value: unknown, label: string): string {
  const result = text(value, label);
  if (result.startsWith("/") || result.includes("\\") || result.split("/").some(segment => segment === "" || segment === "." || segment === "..")) fail(`${label}:path`);
  return result;
}
function iso(value: unknown, label: string): string { const result = text(value, label); if (!RFC3339.test(result) || Number.isNaN(Date.parse(result))) fail(`${label}:rfc3339`); return result; }
function exactArray(value: unknown, values: readonly string[], label: string): void { const actual = list(value, label); if (actual.length !== values.length || actual.some((entry, index) => entry !== values[index])) fail(`${label}:exact-array`); }
export function validateBrowserErrorEvidence(
  value: unknown,
  expectedArtifactKind: "support" | "candidate" | "workspace",
  expectedViewport: string,
  evidenceKind: "page_errors" | "console_errors" | "resource_errors",
): void {
  const resource = evidenceKind === "resource_errors";
  const parsed = closed(
    value,
    evidenceKind,
    resource
      ? ["schema", "artifact_kind", "viewport", "errors", "failed_requests", "unexpected_successful_requests"]
      : ["schema", "artifact_kind", "viewport", "errors"],
  );
  const arrays = resource
    ? [parsed.errors, parsed.failed_requests, parsed.unexpected_successful_requests]
    : [parsed.errors];
  if (
    parsed.schema !== "ideation-authoring/browser-viewport/v1" ||
    parsed.artifact_kind !== expectedArtifactKind ||
    parsed.viewport !== expectedViewport ||
    arrays.some((entries) => !Array.isArray(entries) || entries.length !== 0)
  ) fail(`${evidenceKind}:nonzero-or-binding`);
}

export function validateContrastEvidence(value: unknown, expectedScheme: "light" | "dark"): void {
  const details = closed(value, `contrast.${expectedScheme}`, ["scheme", "minimum_ratio", "measured_surface_count", "surfaces"]);
  if (details.scheme !== expectedScheme || details.minimum_ratio !== 4.5) fail("contrast:evidence");
  const surfaces = list(details.surfaces, `contrast.${expectedScheme}.surfaces`);
  if (!Number.isInteger(details.measured_surface_count) || details.measured_surface_count !== surfaces.length || surfaces.length === 0) fail("contrast:evidence");
  for (let index = 0; index < surfaces.length; index += 1) {
    const surface = closed(surfaces[index], `contrast.${expectedScheme}.surfaces.${index}`, ["selector", "foreground", "background", "ratio"]);
    text(surface.selector, `contrast.${expectedScheme}.surfaces.${index}.selector`);
    text(surface.foreground, `contrast.${expectedScheme}.surfaces.${index}.foreground`);
    text(surface.background, `contrast.${expectedScheme}.surfaces.${index}.background`);
    if (typeof surface.ratio !== "number" || !Number.isFinite(surface.ratio) || surface.ratio < 4.5) fail("contrast:evidence");
  }
}
export function validateNoJsEvidence(value: unknown, expectedKind: "support" | "candidate" | "workspace", expectedViewport: string, identity?: NoJsEvidenceIdentity): void {
  const record = object(value, "no-js");
  const legacyKeys = ["schema", "artifact_kind", "viewport", "inventory", "linear_order", "javascript_disabled", "reviewed_element_count", "hidden_element_count", "hidden_ids"] as const;
  const legacyAuthorized = isLegacyRoundTwoNoJsEvidence(identity)
    && legacyKeys.every(key => key in record);
  const noJs = closed(record, "no-js", legacyAuthorized ? legacyKeys : [...legacyKeys, "semantic_inventory"]);
  if (noJs.schema !== "ideation-authoring/browser-viewport/v1" || noJs.artifact_kind !== expectedKind || noJs.viewport !== expectedViewport || noJs.javascript_disabled !== true || !Array.isArray(noJs.inventory) || noJs.inventory.length === 0 || !Array.isArray(noJs.linear_order) || noJs.linear_order.length === 0 || !Number.isInteger(noJs.reviewed_element_count) || (noJs.reviewed_element_count as number) < 1 || noJs.hidden_element_count !== 0 || !Array.isArray(noJs.hidden_ids) || noJs.hidden_ids.length !== 0) fail("no-js:binding");
  if (legacyAuthorized) return;
  if (!Array.isArray(noJs.semantic_inventory) || noJs.semantic_inventory.length === 0) fail("no-js:binding");
  const semantics = noJs.semantic_inventory.map((entry, index) => text(entry, `no-js.semantic-inventory.${index}`));
  if (expectedKind === "candidate" && (!semantics.some(entry => entry.startsWith("DT:")) || !semantics.some(entry => entry.startsWith("DD:")) || !semantics.some(entry => entry.startsWith("CODE:")) || !semantics.some(entry => entry.startsWith("PRE:")) || !semantics.some(entry => entry.startsWith("TH:")) || !semantics.some(entry => entry.startsWith("TD:")) || !semantics.some(entry => entry.startsWith("LABEL:")) || !semantics.some(entry => entry.startsWith("TEXTAREA:")))) fail("no-js:candidate-semantic-inventory");
}
function finiteRect(value: unknown, label: string): JsonObject {
  const rect = closed(value, label, ["left", "top", "right", "bottom", "width", "height"]);
  for (const coordinate of Object.values(rect)) if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) fail(`${label}:number`);
  return rect;
}
export function validateOptionalBadgeEvidence(value: unknown, expectedViewport: string): void {
  const badge = closed(value, "feedback.optional-badge", ["text", "visible", "rect", "parent_heading_rect", "contained"]);
  const rect = finiteRect(badge.rect, "feedback.optional-badge.rect");
  const parent = finiteRect(badge.parent_heading_rect, "feedback.optional-badge.parent-heading-rect");
  const contained = (rect.left as number) >= (parent.left as number) - 0.5
    && (rect.top as number) >= (parent.top as number) - 0.5
    && (rect.right as number) <= (parent.right as number) + 0.5
    && (rect.bottom as number) <= (parent.bottom as number) + 0.5;
  if (badge.text !== "Optional until edit or proposal" || badge.visible !== true || badge.contained !== true || !contained || (rect.width as number) <= 0 || (rect.height as number) <= 0) fail("feedback:optional-badge-geometry");
  if (expectedViewport === "desktop-1440x900" && ((rect.width as number) < 160 || (rect.height as number) < 18 || (rect.width as number) < (rect.height as number) * 2)) fail("feedback:optional-badge-geometry");
}
function sameBounds(actual: JsonObject, expected: PdfContentPageInspection["bounds"]): boolean {
  return actual.x0 === expected.x0 && actual.y0 === expected.y0 && actual.x1 === expected.x1 && actual.y1 === expected.y1;
}
export function validatePrintInspection(value: unknown, expectedKind: "support" | "candidate" | "workspace", expectedViewport: string, viewportWidth: number, viewportHeight: number, recomputed: PdfContentInspection): JsonObject {
  const inspection = closed(value, "print.inspection", ["schema", "artifact_kind", "viewport", "pdf", "settings", "page_count", "pages", "clipping_checked", "clipping_tolerance_points", "inventory", "extracted_text_byte_count", "missing_inventory"]);
  const pages = list(inspection.pages, "print.inspection.pages");
  const pageCount = count(inspection.page_count, "print.inspection.page-count");
  const extractedTextByteCount = count(inspection.extracted_text_byte_count, "print.inspection.extracted-text-count");
  if (inspection.schema !== "ideation-authoring/print-inspection/v1" || inspection.artifact_kind !== expectedKind || inspection.viewport !== expectedViewport || pageCount < 1 || pages.length !== pageCount || inspection.clipping_checked !== true || inspection.clipping_tolerance_points !== PDF_CONTENT_BOUNDS_TOLERANCE_POINTS || !Array.isArray(inspection.inventory) || inspection.inventory.length === 0 || !Array.isArray(inspection.missing_inventory) || inspection.missing_inventory.length !== 0 || extractedTextByteCount < 1) fail("print:inspection");
  const normalizedExtractedText = recomputed.extracted_text.replace(/\s+/g, "").toLowerCase();
  const recomputedMissingInventory = list(inspection.inventory, "print.inspection.inventory").map((entry, index) => text(entry, `print.inspection.inventory.${index}`)).filter(entry => !normalizedExtractedText.includes(entry.replace(/\s+/g, "").toLowerCase()));
  if (recomputedMissingInventory.length !== 0) fail("print:inventory-recomputed");
  let pageTextByteCount = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = closed(pages[index], `print.inspection.pages.${index}`, ["page_index", "bounds", "content_bounds", "block_counts", "text_byte_count", "out_of_bounds_count", "maximum_overflow", "clipped"]);
    const bounds = closed(page.bounds, `print.inspection.pages.${index}.bounds`, ["x0", "y0", "x1", "y1"]);
    const contentBounds = closed(page.content_bounds, `print.inspection.pages.${index}.content-bounds`, ["x0", "y0", "x1", "y1"]);
    const blockCounts = closed(page.block_counts, `print.inspection.pages.${index}.block-counts`, ["text", "image", "vector", "total"]);
    const values = [...Object.values(bounds), ...Object.values(contentBounds), page.maximum_overflow];
    const textCount = count(blockCounts.text, `print.inspection.pages.${index}.block-counts.text`);
    const imageCount = count(blockCounts.image, `print.inspection.pages.${index}.block-counts.image`);
    const vectorCount = count(blockCounts.vector, `print.inspection.pages.${index}.block-counts.vector`);
    const totalCount = count(blockCounts.total, `print.inspection.pages.${index}.block-counts.total`);
    const outOfBoundsCount = count(page.out_of_bounds_count, `print.inspection.pages.${index}.out-of-bounds-count`);
    if (page.page_index !== index || page.clipped !== false || outOfBoundsCount !== 0 || values.some(entry => typeof entry !== "number" || !Number.isFinite(entry)) || bounds.x0 !== 0 || bounds.y0 !== 0 || Math.abs((bounds.x1 as number) - viewportWidth * 0.75) > 1 || Math.abs((bounds.y1 as number) - viewportHeight * 0.75) > 1 || totalCount < 1 || totalCount !== textCount + imageCount + vectorCount || (page.maximum_overflow as number) > PDF_CONTENT_BOUNDS_TOLERANCE_POINTS) fail("print:page");
    const textByteCount = count(page.text_byte_count, `print.inspection.pages.${index}.text-byte-count`);
    if (textByteCount < 1) fail("print:page");
    pageTextByteCount += textByteCount;
    const expected = recomputed.pages[index];
    if (!expected || page.page_index !== expected.page_index || !sameBounds(bounds, expected.bounds) || !sameBounds(contentBounds, expected.content_bounds) || textCount !== expected.block_counts.text || imageCount !== expected.block_counts.image || vectorCount !== expected.block_counts.vector || totalCount !== expected.block_counts.total || textByteCount !== expected.text_byte_count || outOfBoundsCount !== expected.out_of_bounds_count || page.maximum_overflow !== expected.maximum_overflow || page.clipped !== expected.clipped) fail("print:recomputed-page");
  }
  if (extractedTextByteCount !== pageTextByteCount + pages.length - 1 || pageCount !== recomputed.page_count || extractedTextByteCount !== recomputed.extracted_text_byte_count) fail("print:text-byte-count");
  const settings = closed(inspection.settings, "print.settings", ["print_background", "prefer_css_page_size", "width", "height"]);
  if (settings.print_background !== true || settings.prefer_css_page_size !== true || settings.width !== `${viewportWidth}px` || settings.height !== `${viewportHeight}px`) fail("print:settings");
  return inspection;
}



export interface CommandResult {
  readonly schema: typeof COMMAND_RESULT_SCHEMA;
  readonly id: FocusedCommandId;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exit_code: number;
  readonly stdout_path: string;
  readonly stdout_sha256: string;
  readonly stdout_byte_count: number;
  readonly stderr_path: string;
  readonly stderr_sha256: string;
  readonly stderr_byte_count: number;
  readonly started_at: string;
  readonly completed_at: string;
  readonly result_record_sha256: string;
}

function commandHash(record: Omit<CommandResult, "result_record_sha256">): string { return hashRawBytes(Buffer.from(canonicalJson(record), "utf8")); }
export function validateCommandResult(value: unknown): CommandResult {
  const item = closed(value, "command-result", ["schema", "id", "argv", "cwd", "exit_code", "stdout_path", "stdout_sha256", "stdout_byte_count", "stderr_path", "stderr_sha256", "stderr_byte_count", "started_at", "completed_at", "result_record_sha256"]);
  if (item.schema !== COMMAND_RESULT_SCHEMA) fail("command-result:schema");
  const argv = list(item.argv, "command-result.argv").map((entry, index) => text(entry, `command-result.argv.${index}`));
  if (argv.length === 0) fail("command-result.argv:empty");
  if (!Number.isInteger(item.exit_code) || (item.exit_code as number) < 0 || (item.exit_code as number) > 255) fail("command-result.exit-code");
  const result: CommandResult = Object.freeze({ schema: COMMAND_RESULT_SCHEMA, id: enumValue(item.id, FOCUSED_COMMAND_IDS, "command-result.id"), argv: Object.freeze(argv), cwd: text(item.cwd, "command-result.cwd"), exit_code: item.exit_code as number, stdout_path: relativePath(item.stdout_path, "command-result.stdout-path"), stdout_sha256: sha(item.stdout_sha256, "command-result.stdout-sha"), stdout_byte_count: count(item.stdout_byte_count, "command-result.stdout-count"), stderr_path: relativePath(item.stderr_path, "command-result.stderr-path"), stderr_sha256: sha(item.stderr_sha256, "command-result.stderr-sha"), stderr_byte_count: count(item.stderr_byte_count, "command-result.stderr-count"), started_at: iso(item.started_at, "command-result.started"), completed_at: iso(item.completed_at, "command-result.completed"), result_record_sha256: sha(item.result_record_sha256, "command-result.hash") });
  if (Date.parse(result.completed_at) < Date.parse(result.started_at)) fail("command-result:timestamp-order");
  const { result_record_sha256: _recordHash, ...hashable } = result;
  if (commandHash(hashable) !== result.result_record_sha256) fail("command-result:record-hash");
  return result;
}

async function exclusiveBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle?.close(); }
}
async function rehash(path: string, expected: string, expectedBytes: number): Promise<void> {
  const info = await stat(path); if (!info.isFile()) fail(`evidence:not-file:${path}`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== expectedBytes || hashRawBytes(bytes) !== expected) fail(`evidence:hash:${path}`);
}
async function beneath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(resolve(root, path));
  if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(`${canonicalRoot}/`)) fail(`path-escape:${path}`);
  return canonicalFile;
}
async function readClosedJson(path: string, label: string): Promise<unknown> { try { return JSON.parse(await readFile(path, "utf8")); } catch { fail(`${label}:json`); } }

export async function captureCommand(input: { readonly root: string; readonly output_dir: string; readonly id: FocusedCommandId; readonly argv: readonly string[]; readonly now?: () => Date }): Promise<CommandResult> {
  if (!FOCUSED_COMMAND_IDS.includes(input.id)) fail("capture:id");
  if (input.argv.length === 0 || input.argv.some(argument => typeof argument !== "string" || argument.length === 0)) fail("capture:argv");
  const root = await realpath(input.root);
  const output = resolve(input.output_dir);
  const rootRelative = relative(root, output);
  if (rootRelative === "" || rootRelative.startsWith("..") || rootRelative.includes("../")) fail("capture:output-dir");
  await mkdir(output, { recursive: true });
  const recordPath = resolve(output, `${input.id}.json`);
  try { await stat(recordPath); fail("capture:record-exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const child = spawn(input.argv[0]!, input.argv.slice(1), { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((resolveExit, reject) => { child.once("error", reject); child.once("close", code => resolveExit(code ?? 1)); });
  const completedAt = now().toISOString();
  const stdoutBytes = Buffer.concat(stdout); const stderrBytes = Buffer.concat(stderr);
  const stdoutName = `${input.id}.stdout`; const stderrName = `${input.id}.stderr`;
  await exclusiveBytes(resolve(output, stdoutName), stdoutBytes); await exclusiveBytes(resolve(output, stderrName), stderrBytes);
  const bare = { schema: COMMAND_RESULT_SCHEMA, id: input.id, argv: Object.freeze([...input.argv]), cwd: root, exit_code: exitCode, stdout_path: stdoutName, stdout_sha256: hashRawBytes(stdoutBytes), stdout_byte_count: stdoutBytes.byteLength, stderr_path: stderrName, stderr_sha256: hashRawBytes(stderrBytes), stderr_byte_count: stderrBytes.byteLength, started_at: startedAt, completed_at: completedAt } as const;
  const record = Object.freeze({ ...bare, result_record_sha256: commandHash(bare) });
  await exclusiveBytes(recordPath, Buffer.from(`${canonicalJson(record)}\n`, "utf8"));
  return validateCommandResult(record);
}

function repositoryRelativeCommandPath(argument: string): string {
  if (argument.startsWith(".omp/agent/skills/ideation-with-critique/") || argument === ".omp/agent/extension-tests/ideation-cutover.test.ts") return `./farrajota-oh-my-pi/${argument}`;
  if (argument.startsWith(".omp/")) return `./${argument}`;
  return argument;
}

function expectedCommand(id: FocusedCommandId, artifactPath: string): readonly string[] {
  const common = "bun";
  if (id === "focused-01-ideation") return [common, "test", ...[".omp/agent/skills/ideation-with-critique/scripts/ideation-state-v8.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-runtime.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-support-runtime.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-capability-probe.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-authoring-fixture.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-authoring-browser.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-authoring-evidence.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-authoring-review-lifecycle.test.ts", ".omp/agent/skills/ideation-with-critique/scripts/ideation-handoff-check.test.ts", ".omp/agent/skills/approval-dossier-runtime/scripts/authority-files.test.ts"].map(repositoryRelativeCommandPath)];
  if (id === "focused-02-approval") return [common, "test", ...[".omp/agent/skills/deep-scope/scripts/content-safety.test.ts", ".omp/agent/skills/approval-dossier-runtime/scripts/approval-dossier-contract.test.ts", ".omp/agent/skills/approval-dossier-runtime/scripts/approval-dossier-renderer.test.ts", ".omp/agent/skills/approval-dossier-runtime/scripts/approval-dossier-verifier.test.ts", ".omp/agent/skills/approval-dossier-runtime/scripts/approval-dossier-publisher.test.ts", ".omp/agent/skills/approval-dossier-runtime/scripts/approved-markdown-preflight.test.ts"].map(repositoryRelativeCommandPath)];
  if (id === "focused-03-cross-workflow") return [common, "test", ...[".omp/agent/skills/deep-scope/scripts/approval-cutover.test.ts", ".omp/agent/skills/spec-stratify/scripts/shared-approval-authority.test.ts"].map(repositoryRelativeCommandPath)];
  if (id === "focused-04-extension") return [common, "test", ...[".omp/agent/extension-tests/ideation-cutover.test.ts", ".omp/agent/extension-tests/specification-review-loop-contract.test.ts"].map(repositoryRelativeCommandPath)];
  const root = dirname(artifactPath);
  return [common, "./farrajota-oh-my-pi/.omp/agent/skills/ideation-with-critique/scripts/ideation-handoff-check.ts", "--repository-root", `${root}/runtime`, "--artifact-manifest", artifactPath, "--output", `${root}/handoff-result.json`];
}

export interface ArtifactHtml { readonly path: string; readonly sha256: string; readonly byte_count: number; }
export interface AuthorityArtifactBinding { readonly path: string; readonly sha256: string; readonly byte_count: number | null; }
export interface ArtifactManifestSummary {
  readonly sha256: string;
  readonly fixture: ArtifactHtml;
  readonly artifacts: readonly ArtifactHtml[];
  readonly authority: AuthorityArtifactBinding;
  readonly support: ArtifactHtml;
  readonly candidate: ArtifactHtml;
  readonly workspace: ArtifactHtml | null;
  readonly raw: JsonObject;
}
function artifactHtml(value: unknown, label: string): ArtifactHtml {
  const item = closed(value, label, ["path", "sha256", "byte_count"]);
  return Object.freeze({ path: relativePath(item.path, `${label}.path`), sha256: sha(item.sha256, `${label}.sha256`), byte_count: count(item.byte_count, `${label}.byte_count`) });
}
/** Validates the complete fixture-produced authority graph and its redundant byte-count index. */
export async function readArtifactManifest(path: string): Promise<ArtifactManifestSummary> {
  const bytes = await readFile(path);
  const decoded = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  const preliminary = object(decoded, "artifact-manifest");
  const schema = enumValue(preliminary.schema, ARTIFACT_MANIFEST_SCHEMAS, "artifact-manifest.schema");
  const keys = ["schema", "fixture", "state", "support", ...(schema.endsWith("/v3") ? ["workspace"] : []), "candidate", "renderer", "protected", "command_version", "artifact_byte_counts"] as const;
  const raw = closed(decoded, "artifact-manifest", keys);
  if (!bytes.equals(Buffer.from(`${canonicalJson(raw)}\n`, "utf8"))) fail("artifact-manifest:canonical-bytes");
  const expectedCommand = schema.endsWith("/v1") ? "ideation-authoring-fixture/v1" : schema.endsWith("/v2") ? "ideation-authoring-fixture/v2" : "ideation-authoring-fixture/v3";
  if (raw.command_version !== expectedCommand) fail("artifact-manifest:command-version");
  const fixture = artifactHtml(raw.fixture, "artifact-manifest.fixture");
  const state = closed(raw.state, "artifact-manifest.state", ["current", "snapshot", "sha256"]);
  const stateSha = sha(state.sha256, "artifact-manifest.state.sha256");
  const stateCurrent = artifactHtml(state.current, "artifact-manifest.state.current");
  const stateSnapshot = artifactHtml(state.snapshot, "artifact-manifest.state.snapshot");
  if (stateCurrent.sha256 !== stateSha || stateSnapshot.sha256 !== stateSha) fail("artifact-manifest:state-binding");
  const support = closed(raw.support, "artifact-manifest.support", ["record", "html", "identity_sha256"]);
  sha(support.identity_sha256, "artifact-manifest.support.identity-sha256");
  const supportRecord = artifactHtml(support.record, "artifact-manifest.support.record");
  const supportHtml = artifactHtml(support.html, "artifact-manifest.support.html");
  const workspace = schema.endsWith("/v3") ? closed(raw.workspace, "artifact-manifest.workspace", ["path", "workspace_id", "baseline_id", "checkpoint_id", "workspace_issuance_id", "baseline_record", "checkpoint_record", "workspace_issuance_record", "source_response_record", "initial_saved_workspace_evidence", "overwritten_saved_workspace_evidence", "unchanged_save", "admitted_response_record", "continuation_checkpoint_record", "continuation_issuance_record", "rebase_workspace_issuance_record", "rebase_admitted_response_record", "rebase_imported", "canonical_before_sha256", "canonical_after_sha256", "initial_workspace_sha256", "overwritten_workspace_sha256", "unchanged_workspace_sha256", "protected_tamper_rejected"]) : null;
  const workspaceHtml = workspace === null ? null : artifactHtml(workspace.path, "artifact-manifest.workspace.path");
  const workspaceArtifacts = workspace === null ? [] : [
    artifactHtml(workspace.baseline_record, "artifact-manifest.workspace.baseline-record"),
    artifactHtml(workspace.checkpoint_record, "artifact-manifest.workspace.checkpoint-record"),
    artifactHtml(workspace.workspace_issuance_record, "artifact-manifest.workspace.issuance-record"),
    artifactHtml(workspace.source_response_record, "artifact-manifest.workspace.source-response-record"),
    artifactHtml(workspace.initial_saved_workspace_evidence, "artifact-manifest.workspace.initial-evidence"),
    artifactHtml(workspace.overwritten_saved_workspace_evidence, "artifact-manifest.workspace.overwrite-evidence"),
    artifactHtml(workspace.admitted_response_record, "artifact-manifest.workspace.admitted-response-record"),
    artifactHtml(workspace.continuation_checkpoint_record, "artifact-manifest.workspace.continuation-checkpoint"),
    artifactHtml(workspace.continuation_issuance_record, "artifact-manifest.workspace.continuation-issuance"),
    artifactHtml(workspace.rebase_workspace_issuance_record, "artifact-manifest.workspace.rebase-issuance"),
    artifactHtml(workspace.rebase_admitted_response_record, "artifact-manifest.workspace.rebase-admitted-response"),
  ];
  if (workspace !== null) {
    if (workspace.rebase_imported !== true) fail("artifact-manifest.workspace.rebase-import");
    for (const field of ["canonical_before_sha256", "canonical_after_sha256", "initial_workspace_sha256", "overwritten_workspace_sha256", "unchanged_workspace_sha256"] as const) sha(workspace[field], `artifact-manifest.workspace.${field}`);
    if (workspace.canonical_before_sha256 !== workspace.canonical_after_sha256) fail("artifact-manifest.workspace.canonical-mutation");
    if (workspace.protected_tamper_rejected !== true) fail("artifact-manifest.workspace.protected-tamper");
    if (workspace.unchanged_save === null || typeof workspace.unchanged_save !== "object" || Array.isArray(workspace.unchanged_save)) fail("artifact-manifest.workspace.unchanged-save");
    const unchanged = closed(workspace.unchanged_save, "artifact-manifest.workspace.unchanged-save", ["outcome", "evidence_sha256", "workspace_sha256"]);
    if (unchanged.outcome !== "adopted-identical") fail("artifact-manifest.workspace.unchanged-save-outcome");
    sha(unchanged.evidence_sha256, "artifact-manifest.workspace.unchanged-save.evidence-sha256");
    sha(unchanged.workspace_sha256, "artifact-manifest.workspace.unchanged-save.workspace-sha256");
  }
  const candidateKeys = schema.endsWith("/v1")
    ? ["submission", "current", "record", "html", "candidate_sha256", "response", "approved_html", "publication_markdown", "publication_receipt", "handoff"]
    : ["submission", "current", "record", "html", "candidate_sha256", "response", "approved_html", "publication_markdown", "publication_receipt", "substantive_review_authority", "handoff"];
  const candidate = closed(raw.candidate, "artifact-manifest.candidate", candidateKeys);
  sha(candidate.candidate_sha256, "artifact-manifest.candidate.candidate-sha256");
  const candidateArtifacts = [
    artifactHtml(candidate.submission, "artifact-manifest.candidate.submission"), artifactHtml(candidate.current, "artifact-manifest.candidate.current"),
    artifactHtml(candidate.record, "artifact-manifest.candidate.record"), artifactHtml(candidate.html, "artifact-manifest.candidate.html"),
    artifactHtml(candidate.response, "artifact-manifest.candidate.response"), artifactHtml(candidate.approved_html, "artifact-manifest.candidate.approved-html"),
    artifactHtml(candidate.publication_markdown, "artifact-manifest.candidate.publication-markdown"), artifactHtml(candidate.publication_receipt, "artifact-manifest.candidate.publication-receipt"),
  ] as const;
  const handoff = object(candidate.handoff, "artifact-manifest.candidate.handoff");
  const handoffAuthority = closed(handoff.substantive_review_authority, "artifact-manifest.candidate.handoff.substantive-review-authority", ["schema", "path", "sha256"]);
  const authorityPath = relativePath(handoffAuthority.path, "artifact-manifest.candidate.handoff.substantive-review-authority.path");
  const authoritySha = sha(handoffAuthority.sha256, "artifact-manifest.candidate.handoff.substantive-review-authority.sha256");
  if (handoffAuthority.schema !== "approval-dossier/authority-file-binding/v1") fail("artifact-manifest:substantive-review-authority-schema");
  const authorityArtifact = schema.endsWith("/v1") ? null : artifactHtml(candidate.substantive_review_authority, "artifact-manifest.candidate.substantive-review-authority");
  if (authorityArtifact !== null && (authorityArtifact.path !== authorityPath || authorityArtifact.sha256 !== authoritySha)) fail("artifact-manifest:substantive-review-authority-binding");
  const renderer = closed(raw.renderer, "artifact-manifest.renderer", ["final_renderer_sha256", "ideation_projection_sha256", "support_renderer_sha256"]);
  for (const [key, value] of Object.entries(renderer)) sha(value, `artifact-manifest.renderer.${key}`);
  const protectedHashes = closed(raw.protected, "artifact-manifest.protected", ["markdown_sha256", "bundle_sha256", "visual_sha256", "runtime_sha256", "receipt_sha256", "reconciled_state_sha256"]);
  for (const [key, value] of Object.entries(protectedHashes)) sha(value, `artifact-manifest.protected.${key}`);
  const artifacts = Object.freeze([stateCurrent, stateSnapshot, supportRecord, supportHtml, ...(workspaceHtml === null ? [] : [workspaceHtml]), ...workspaceArtifacts, ...candidateArtifacts, ...(authorityArtifact === null ? [] : [authorityArtifact])]);
  if (new Set(artifacts.map(artifact => artifact.path)).size !== artifacts.length) fail("artifact-manifest:duplicate-artifact-path");
  const byteCounts = object(raw.artifact_byte_counts, "artifact-manifest.artifact-byte-counts");
  const expectedPaths = artifacts.map(artifact => artifact.path).sort();
  const indexedPaths = Object.keys(byteCounts).sort();
  if (canonicalJson(indexedPaths) !== canonicalJson(expectedPaths)) fail("artifact-manifest:artifact-byte-count-paths");
  for (const artifact of artifacts) if (count(byteCounts[artifact.path], `artifact-manifest.artifact-byte-counts.${artifact.path}`) !== artifact.byte_count) fail("artifact-manifest:artifact-byte-count");
  return Object.freeze({ sha256: hashRawBytes(bytes), fixture, artifacts, authority: Object.freeze({ path: authorityPath, sha256: authoritySha, byte_count: authorityArtifact?.byte_count ?? null }), support: supportHtml, candidate: candidateArtifacts[3], workspace: workspaceHtml, raw });
}

export interface BrowserEvidenceFile { readonly path: string; readonly sha256: string; readonly byte_count: number; }
export interface BrowserScreenshotTile extends BrowserEvidenceFile { readonly tile_index: number; readonly y: number; readonly height: number; }
export interface WebpDimensions { readonly width: number; readonly height: number; }
/** Decodes all supplied WebP payloads in one local Chromium process. */
export async function decodeWebpDimensionsBatch(images: readonly Uint8Array[]): Promise<readonly WebpDimensions[]> {
  if (images.length === 0) return Object.freeze([]);
  let browser: Browser | undefined;
  try {
    try {
      browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    } catch {
      fail("screenshot:chromium-launch");
    }
    const page = await browser.newPage();
    let decoded: readonly { readonly width: unknown; readonly height: unknown }[];
    try {
      const dataUrls = images.map(image => `data:image/webp;base64,${Buffer.from(image).toString("base64")}`);
      decoded = await page.evaluate(async (urls: readonly string[]) => Promise.all(urls.map(async url => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      })), dataUrls);
    } catch {
      fail("screenshot:chromium-decode");
    }
    return Object.freeze(decoded.map((dimensions, index) => {
      if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || (dimensions.width as number) < 1 || (dimensions.height as number) < 1) fail(`screenshot:chromium-dimensions:${index}`);
      return Object.freeze({ width: dimensions.width as number, height: dimensions.height as number });
    }));
  } finally {
    if (browser !== undefined) await browser.close();
  }
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}
function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}
function parseVp8Dimensions(bytes: Uint8Array, offset: number, size: number): WebpDimensions {
  if (size < 10) fail("screenshot:webp-vp8");
  const tag = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
  if ((tag & 1) !== 0 || ((tag >>> 1) & 7) > 3 || ((tag >>> 4) & 1) !== 1 || (tag >>> 5) > size - 10 || bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 0x01 || bytes[offset + 5] !== 0x2a) fail("screenshot:webp-vp8");
  const width = (bytes[offset + 6]! | (bytes[offset + 7]! << 8)) & 0x3fff;
  const height = (bytes[offset + 8]! | (bytes[offset + 9]! << 8)) & 0x3fff;
  if (width < 1 || height < 1) fail("screenshot:webp-dimensions");
  return Object.freeze({ width, height });
}
function parseVp8lDimensions(bytes: Uint8Array, offset: number, size: number): WebpDimensions {
  if (size < 5 || bytes[offset] !== 0x2f) fail("screenshot:webp-vp8l");
  const bits = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, true);
  if ((bits >>> 29) !== 0) fail("screenshot:webp-vp8l-version");
  return Object.freeze({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
}
function parseVp8xDimensions(bytes: Uint8Array, offset: number, size: number): WebpDimensions {
  if (size !== 10 || (bytes[offset]! & 0xc3) !== 0 || bytes[offset + 1] !== 0 || bytes[offset + 2] !== 0 || bytes[offset + 3] !== 0) fail("screenshot:webp-vp8x");
  return Object.freeze({ width: uint24le(bytes, offset + 4) + 1, height: uint24le(bytes, offset + 7) + 1 });
}
export function parseWebpDimensions(bytes: Uint8Array): WebpDimensions {
  if (bytes.byteLength < 20 || fourCc(bytes, 0) !== "RIFF" || fourCc(bytes, 8) !== "WEBP") fail("screenshot:webp-container");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) fail("screenshot:webp-riff-size");
  let offset = 12;
  let chunkIndex = 0;
  let canvas: WebpDimensions | undefined;
  let frame: WebpDimensions | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) fail("screenshot:webp-chunk-header");
    const type = fourCc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (size > bytes.byteLength - payload) fail("screenshot:webp-chunk-size");
    const payloadEnd = payload + size;
    const paddedEnd = payloadEnd + (size & 1);
    if (paddedEnd > bytes.byteLength || ((size & 1) !== 0 && bytes[payloadEnd] !== 0)) fail("screenshot:webp-chunk-padding");
    if (chunkIndex === 0 && type !== "VP8 " && type !== "VP8L" && type !== "VP8X") fail("screenshot:webp-first-chunk");
    if (type === "VP8X") {
      if (chunkIndex !== 0 || canvas !== undefined) fail("screenshot:webp-vp8x-order");
      canvas = parseVp8xDimensions(bytes, payload, size);
    } else if (type === "VP8 " || type === "VP8L") {
      if (frame !== undefined) fail("screenshot:webp-multiple-frames");
      frame = type === "VP8 " ? parseVp8Dimensions(bytes, payload, size) : parseVp8lDimensions(bytes, payload, size);
    } else if (type === "ANIM" || type === "ANMF") fail("screenshot:webp-animation");
    offset = paddedEnd;
    chunkIndex += 1;
  }
  if (offset !== bytes.byteLength || frame === undefined) fail("screenshot:webp-frame");
  if (canvas !== undefined && (canvas.width !== frame.width || canvas.height !== frame.height)) fail("screenshot:webp-canvas-frame");
  return canvas ?? frame;
}
function screenshotTile(value: unknown, label: string): BrowserScreenshotTile {
  const item = closed(value, label, ["tile_index", "y", "height", "path", "sha256", "byte_count"]);
  const file = fileRecord({ path: item.path, sha256: item.sha256, byte_count: item.byte_count }, label);
  const tileIndex = count(item.tile_index, `${label}.tile-index`);
  const y = count(item.y, `${label}.y`);
  const height = count(item.height, `${label}.height`);
  if (height < 1 || file.byte_count < 1) fail(`${label}:empty`);
  return Object.freeze({ tile_index: tileIndex, y, height, ...file });
}
function fileRecord(value: unknown, label: string): BrowserEvidenceFile { return artifactHtml(value, label); }
interface BrowserCheckRecord {
  readonly check_id: IdeationAuthoringCheckId;
  readonly artifact_kind: "support" | "candidate" | "workspace";
  readonly applicability: "applicable" | "not-applicable";
  readonly status: "pass" | "not-applicable";
  readonly evidence_paths: readonly BrowserEvidenceFile[];
  readonly details: JsonObject;
}
function checkRecord(value: unknown, label: string): BrowserCheckRecord {
  const item = closed(value, label, ["check_id", "artifact_kind", "applicability", "status", "evidence_paths", "details"]);
  const applicability = enumValue(item.applicability, ["applicable", "not-applicable"] as const, `${label}.applicability`);
  const status = enumValue(item.status, ["pass", "not-applicable"] as const, `${label}.status`);
  if ((applicability === "applicable") !== (status === "pass")) fail(`${label}:status`);
  const evidence_paths = Object.freeze(list(item.evidence_paths, `${label}.evidence-paths`).map((entry, index) => fileRecord(entry, `${label}.evidence-paths.${index}`)));
  const details = object(item.details, `${label}.details`);
  for (const forbidden of ["verified", "deferred", "focus_visible", "return_checks", "contracts", "saved_response_target_binding", "clipping"]) if (forbidden in details) fail(`${label}:generic-marker`);
  if (applicability === "applicable" && evidence_paths.length === 0) fail(`${label}:missing-observation`);
  return Object.freeze({ check_id: enumValue(item.check_id, CHECKS, `${label}.check-id`), artifact_kind: enumValue(item.artifact_kind, ARTIFACTS, `${label}.artifact-kind`), applicability, status, evidence_paths, details });
}
function assertApplicabilityMatrix(kind: "support" | "candidate" | "workspace", checks: readonly BrowserCheckRecord[]): void {
  for (const record of checks) {
    if (kind === "workspace") {
      if (record.applicability !== "applicable") fail("workspace:required-applicability");
      continue;
    }
    const details = record.details as Record<string, unknown>;
    if (kind === "candidate") {
      if (record.check_id === "print-support") { if (record.applicability !== "not-applicable" || details.reason !== "candidate-only") fail("candidate:print-support-applicability"); }
      else if (record.check_id === "image-dialog" || record.check_id === "research-dialog") { if (record.applicability === "not-applicable" && details.reason !== "artifact-manifest-omitted") fail("candidate:optional-applicability"); }
      else if (record.applicability !== "applicable") fail("candidate:applicability");
      continue;
    }
    const unconditional = ["header", "authority-notice", "keyboard-navigation", "focus-restoration", "contrast-light", "contrast-dark", "zoom-200", "reduced-motion", "forced-colours", "overflow", "no-js", "print-support"];
    const exchangeConditional = ["search-filters", "item-queue", "focused-briefing", "responsive-tabs"];
    if (unconditional.includes(record.check_id)) { if (record.applicability !== "applicable") fail("support:required-applicability"); }
    else if (exchangeConditional.includes(record.check_id)) { if (record.applicability === "not-applicable" && details.reason !== "zero-exchange") fail("support:conditional-applicability"); }
    else if (record.applicability !== "not-applicable" || details.reason !== "candidate-only") fail("support:candidate-only-applicability");
  }
}
export async function validateCheckObservations(root: string, viewport: string, kind: "support" | "candidate" | "workspace", checks: readonly BrowserCheckRecord[]): Promise<void> {
  for (const check of checks) {
    if (check.applicability !== "applicable") continue;
    const expectedPath = `checks/${viewport}/${kind}/${check.check_id}.json`;
    const observations = check.evidence_paths.filter(evidence => evidence.path === expectedPath);
    if (observations.length === 0) fail(`check.${check.check_id}:missing-observation`);
    if (observations.length !== 1) fail(`check.${check.check_id}:duplicate-observation`);
    const raw = await readClosedJson(await beneath(root, observations[0]!.path), `check.${check.check_id}.evidence`);
    const record = closed(raw, `check.${check.check_id}.evidence`, ["schema", "artifact_kind", "viewport", "check_id", "observations"]);
    if (record.schema !== "ideation-authoring/check-observation/v1" || record.artifact_kind !== kind || record.viewport !== viewport || record.check_id !== check.check_id) fail(`check.${check.check_id}:binding`);
    const observationDetails = object(record.observations, `check.${check.check_id}.observations`);
    for (const forbidden of ["verified", "deferred", "focus_visible", "return_checks", "contracts", "saved_response_target_binding", "clipping"]) if (forbidden in observationDetails) fail(`check.${check.check_id}:generic-marker`);
    if (Object.keys(observationDetails).length === 0) fail(`check.${check.check_id}:empty-observation`);
    if (canonicalJson(observationDetails) !== canonicalJson(check.details)) fail(`check.${check.check_id}:observation-details-mismatch`);
  }
}
function validateHistoricalResponsiveTabs(tabs: JsonObject, round: 2 | 3): void {
  if (tabs.layout === "desktop") {
    if (tabs.observed_tab_count !== 4 || tabs.visible_tab_count !== 0) fail("responsive-tabs:desktop-counts");
    if (round === 2) {
      if (tabs.visible_pane_count !== 4) fail("responsive-tabs:desktop-semantics");
    } else if (!Array.isArray(tabs.panes) || tabs.panes.length !== 4 || tabs.panes.some((pane: unknown) => {
      const item = object(pane, "responsive-tabs.desktop-pane");
      return item.role !== null || item.labelled_by !== null || item.hidden !== false || item.visible !== true;
    })) fail("responsive-tabs:desktop-semantics");
    return;
  }
  if (tabs.expected_tab_count !== 4 || tabs.selected_count !== 1 || tabs.visible_pane_count !== 1 || typeof tabs.active_id !== "string" || tabs.active_id.length === 0 || !Array.isArray(tabs.controls) || tabs.controls.length !== 4 || !Array.isArray(tabs.actions) || canonicalJson(tabs.actions) !== canonicalJson(["click", "ArrowRight", "End", "Home"])) fail("responsive-tabs:legacy-interaction-evidence");
  if (round === 3 && (tabs.tablist_role !== "tablist" || !Array.isArray(tabs.panes) || tabs.panes.length !== 4 || tabs.panes.some((pane: unknown) => {
    const item = object(pane, "responsive-tabs.legacy-pane");
    return item.role !== "tabpanel" || typeof item.labelled_by !== "string" || item.labelled_by.length === 0;
  }))) fail("responsive-tabs:legacy-semantics");
}

function validateCurrentResponsiveTabs(tabs: JsonObject): void {
  if (tabs.layout === "desktop") {
    if (!Array.isArray(tabs.panes) || tabs.panes.some((pane: unknown) => {
      const item = object(pane, "responsive-tabs.desktop-pane");
      return item.role !== null || item.labelled_by !== null || item.hidden !== false || item.visible !== true;
    })) fail("responsive-tabs:desktop-semantics");
    return;
  }
  const pointer = object(tabs.pointer_activation, "responsive-tabs.pointer-activation");
  const traversal = object(tabs.traversal, "responsive-tabs.traversal");
  const afterRight = object(traversal.after_right, "responsive-tabs.after-right");
  const afterEnd = object(traversal.after_end, "responsive-tabs.after-end");
  const afterHome = object(traversal.after_home, "responsive-tabs.after-home");
  const focus = object(tabs.visible_focus, "responsive-tabs.visible-focus");
  const panes = list(traversal.pane_traversal, "responsive-tabs.pane-traversal");
  const preserved = object(tabs.preserved_review_state, "responsive-tabs.preserved-review-state");
  const before = object(preserved.before, "responsive-tabs.preserved-before");
  const after = object(preserved.after, "responsive-tabs.preserved-after");
  if (tabs.tablist_role !== "tablist" || tabs.selected_count !== 1 || tabs.visible_pane_count !== 1 || !Array.isArray(tabs.controls) || !Array.isArray(tabs.panes) || pointer.selected !== "review" || pointer.visible_pane !== "review" || afterRight.selected !== "feedback" || afterRight.active !== "feedback" || afterEnd.selected !== "notes" || afterEnd.active !== "notes" || afterHome.selected !== "queue" || afterHome.active !== "queue" || (focus.outline_style === "none" && focus.box_shadow === "none") || panes.length !== 4 || panes.some(entry => { const pane = object(entry, "responsive-tabs.traversed-pane"); return pane.name !== pane.visible_pane || pane.selected !== "true"; }) || typeof before.selected_target !== "string" || before.selected_target.length === 0 || before.visible_summary !== before.selected_target || before.disposition !== "edit" || before.requested_change !== "responsive-tab-draft" || canonicalJson(before) !== canonicalJson(after)) fail("responsive-tabs:interaction-evidence");
}
export function validateFocusedHandoffResult(value: unknown, artifactManifestSha256: string, historicalRound: HistoricalEvidenceRound | null): void {
  if (historicalRound === 2) {
    const handoff = closed(value, "handoff-result", ["schema", "artifact_manifest_sha256", "state_current", "state_snapshot", "current_candidate", "response", "markdown", "receipt", "handoff"]);
    if (handoff.schema !== "ideation-authoring/handoff-result/v1" || handoff.artifact_manifest_sha256 !== artifactManifestSha256) fail("command.focused-05-handoff:legacy-binding");
    return;
  }
  if (historicalRound === 3) {
    const handoff = closed(value, "handoff-result", ["schema", "artifact_manifest_sha256", "state_current", "state_snapshot", "current_candidate", "response", "markdown", "receipt", "handoff", "negative_scenarios"]);
    const negatives = list(handoff.negative_scenarios, "handoff-result.negative-scenarios");
    const scenarios = ["tampered-publication-binding", "replayed-state-binding"] as const;
    if (handoff.schema !== "ideation-authoring/handoff-result/v2" || handoff.artifact_manifest_sha256 !== artifactManifestSha256 || negatives.length !== scenarios.length || negatives.some((value, index) => {
      const negative = closed(value, `handoff-result.negative-scenarios.${index}`, ["scenario", "artifact_manifest_sha256", "rejected"]);
      return negative.scenario !== scenarios[index] || negative.artifact_manifest_sha256 !== artifactManifestSha256 || negative.rejected !== true;
    })) fail("command.focused-05-handoff:legacy-negative-scenarios");
    return;
  }
  const handoff = validateHandoffCheckResult(value);
  if (handoff.artifact_manifest_sha256 !== artifactManifestSha256 || handoff.negative_scenarios.some(scenario => scenario.rejected !== true || scenario.artifact_manifest_sha256 !== artifactManifestSha256)) fail("command.focused-05-handoff:negative-scenarios");
}
export function validateMeasurementEvidence(value: unknown, expectedArtifactKind: "support" | "candidate" | "workspace", expectedViewport: string, expectedViewportWidth: number): JsonObject {
  const measurement = closed(value, "measurements", ["schema", "artifact_kind", "viewport", "title", "heading", "scroll_width", "client_width", "horizontal_overflow", "offenders", "internal_overflow", "measured_elements", "screenshot_capture"]);
  if (measurement.schema !== "ideation-authoring/browser-viewport/v1") fail("measurements:schema");
  if (typeof measurement.title !== "string" || typeof measurement.heading !== "string" || !Array.isArray(measurement.internal_overflow)) fail("measurements:metadata");
  if (measurement.artifact_kind !== expectedArtifactKind || measurement.viewport !== expectedViewport || !Number.isInteger(measurement.scroll_width) || !Number.isInteger(measurement.client_width) || measurement.horizontal_overflow !== false || measurement.scroll_width !== expectedViewportWidth || measurement.client_width !== expectedViewportWidth || !Array.isArray(measurement.offenders) || measurement.offenders.length !== 0 || !Array.isArray(measurement.measured_elements) || measurement.measured_elements.length === 0) fail("measurements:overflow");
  const capture = closed(measurement.screenshot_capture, "measurements.screenshot-capture", ["mode", "source_width", "source_height", "tile_height", "tile_count"]);
  const sourceWidth = count(capture.source_width, "measurements.screenshot-capture.source-width");
  const sourceHeight = count(capture.source_height, "measurements.screenshot-capture.source-height");
  const tileHeight = count(capture.tile_height, "measurements.screenshot-capture.tile-height");
  const tileCount = count(capture.tile_count, "measurements.screenshot-capture.tile-count");
  if (capture.mode !== "full-width-vertical-tiles" || sourceWidth !== expectedViewportWidth || sourceHeight < 1 || tileHeight !== 4_096 || tileCount !== Math.ceil(sourceHeight / tileHeight)) fail("measurements:screenshot-capture");
  return measurement;
}




export async function validateEvidence(input: { readonly artifact_manifest: string; readonly artifact_manifest_argument?: string; readonly focused_command_root: string; readonly browser_root: string; readonly output: string; readonly write_output?: boolean }): Promise<{
  readonly schema: typeof BROWSER_EVIDENCE_SCHEMA;
  readonly artifact_manifest_sha256: string;
  readonly browser_manifest_sha256: string;
  readonly focused_command_result_sha256s: readonly string[];
  readonly evidence_set_sha256: string;
}> {
  const artifact = await readArtifactManifest(input.artifact_manifest);
  await rehash(await beneath("/workspace", artifact.fixture.path), artifact.fixture.sha256, artifact.fixture.byte_count);
  const artifactRoot = resolve(dirname(resolve(input.artifact_manifest)), "runtime");
  const authorityBytes = await readFile(await beneath(artifactRoot, artifact.authority.path));
  if (hashRawBytes(authorityBytes) !== artifact.authority.sha256 || (artifact.authority.byte_count !== null && authorityBytes.byteLength !== artifact.authority.byte_count)) fail("artifact-manifest:substantive-review-authority-rehash");
  for (const runtimeArtifact of artifact.artifacts) await rehash(await beneath(artifactRoot, runtimeArtifact.path), runtimeArtifact.sha256, runtimeArtifact.byte_count);
  const browserRoot = resolve(input.browser_root);
  const browserManifestPath = resolve(browserRoot, "browser-manifest.json");
  const browserManifestBytes = await readFile(browserManifestPath);
  if (browserManifestBytes.byteLength > BROWSER_MANIFEST_JSON_LIMITS.maximum_bytes!) fail("browser-manifest:byte-limit");
  const raw = await readClosedJson(browserManifestPath, "browser-manifest");
  const browserManifestSha = hashRawBytes(Buffer.from(canonicalJson(raw, BROWSER_MANIFEST_JSON_LIMITS), "utf8"));
  const evidenceIdentity: NoJsEvidenceIdentity = {
    artifact_manifest_schema: artifact.raw.schema as (typeof ARTIFACT_MANIFEST_SCHEMAS)[number],
    artifact_manifest_sha256: artifact.sha256,
    browser_manifest_sha256: browserManifestSha,
  };
  const historicalRound = historicalEvidenceRound(evidenceIdentity);

  const manifest = closed(raw, "browser-manifest", ["schema", "artifact_manifest_path", "artifact_manifest_sha256", "chromium_version", "viewports"]);
  if (manifest.schema !== "ideation-authoring/browser-run/v1" || resolve(text(manifest.artifact_manifest_path, "browser-manifest.artifact-path")) !== resolve(input.artifact_manifest) || manifest.artifact_manifest_sha256 !== artifact.sha256 || typeof manifest.chromium_version !== "string" || manifest.chromium_version.length === 0) fail("browser-manifest:binding");
  const viewports = list(manifest.viewports, "browser-manifest.viewports"); if (viewports.length !== VIEWPORTS.length) fail("browser-manifest:viewports");
  const decodedTiles: { readonly label: string; readonly expected: WebpDimensions; readonly parser: WebpDimensions; readonly bytes: Uint8Array }[] = [];
  const allFiles: BrowserEvidenceFile[] = [];
  for (let index = 0; index < VIEWPORTS.length; index += 1) {
    const viewport = closed(viewports[index], `viewport.${index}`, ["id", "width", "height", "artifacts"]);
    if (viewport.id !== VIEWPORTS[index] || viewport.width !== VIEWPORT_WIDTHS[index] || viewport.height !== VIEWPORT_HEIGHTS[index]) fail(`viewport.${index}:identity`);
    const artifacts = list(viewport.artifacts, `viewport.${index}.artifacts`); if (artifacts.length !== ARTIFACTS.length) fail(`viewport.${index}:artifacts`);
    for (const kind of ARTIFACTS) {
      const entry = closed(artifacts.find(candidate => object(candidate, "artifact-entry").kind === kind), `viewport.${index}.${kind}`, ["kind", "html", "checks", "interactions", "focus", "measurements", "page_errors", "console_errors", "resource_errors", "no_js", "screenshots", "print"]);
      if (entry.kind !== kind) fail(`viewport.${index}.${kind}:kind`);
      const expectedHtml = kind === "support" ? artifact.support : kind === "candidate" ? artifact.candidate : artifact.workspace;
      if (expectedHtml === null) fail("artifact-manifest:workspace-missing");
      const html = fileRecord(entry.html, `viewport.${index}.${kind}.html`);
      if (html.path !== expectedHtml.path || html.sha256 !== expectedHtml.sha256 || html.byte_count !== expectedHtml.byte_count) fail(`viewport.${index}.${kind}:html-binding`);
      const checks = list(entry.checks, `viewport.${index}.${kind}.checks`).map((check, i) => checkRecord(check, `viewport.${index}.${kind}.checks.${i}`));
      if (checks.length !== CHECKS.length || new Set(checks.map(check => check.check_id)).size !== CHECKS.length) fail(`viewport.${index}.${kind}:checks`);
      assertApplicabilityMatrix(kind, checks);
      await validateCheckObservations(browserRoot, viewport.id as string, kind, checks);
      for (const check of checks) {
        if (check.artifact_kind !== kind) fail(`viewport.${index}.${kind}:check-artifact`);
        allFiles.push(...check.evidence_paths);
      }
      const byId = Object.fromEntries(checks.map(record => [record.check_id, record])) as Record<string, BrowserCheckRecord>;
      validateContrastEvidence(byId["contrast-light"]!.details, "light");
      validateContrastEvidence(byId["contrast-dark"]!.details, "dark");
      const zoom = byId["zoom-200"]!.details;
      if (zoom.zoom_percent !== 200 || typeof zoom.scroll_width !== "number" || typeof zoom.client_width !== "number" || zoom.horizontal_overflow !== false || zoom.scroll_width > zoom.client_width || !Array.isArray(zoom.offenders) || zoom.offenders.length !== 0) fail("zoom:evidence");
      const reducedMotion = byId["reduced-motion"]!.details;
      if (reducedMotion.reduced_motion !== "reduce" || reducedMotion.media_query_matches !== true) fail("reduced-motion:evidence");
      const forcedColours = byId["forced-colours"]!.details;
      if (forcedColours.forced_colours !== "active" || forcedColours.media_query_matches !== true || typeof forcedColours.scroll_width !== "number" || typeof forcedColours.client_width !== "number" || forcedColours.scroll_width > forcedColours.client_width) fail("forced-colours:evidence");
      if (kind === "support" && byId["search-filters"]!.applicability === "applicable") {
        const search = byId["search-filters"]!.details;
        if (!Number.isInteger(search.total_count) || !Number.isInteger(search.before_count) || !Number.isInteger(search.filtered_visible_count) || !Number.isInteger(search.restored_visible_count) || (search.total_count as number) < 1 || search.before_count !== search.total_count || search.filtered_visible_count !== 0 || search.restored_visible_count !== search.before_count) fail("support-search:evidence");
      }
      if (kind === "candidate") {
        const feedback = byId["feedback-controls"]!.details;
        if (historicalRound === 2) {
          const conditionalRequired = object(feedback.conditional_required, "feedback.conditional-required");
          if (!Array.isArray(conditionalRequired.observed) || conditionalRequired.observed.length === 0 || typeof conditionalRequired.selector !== "string" || conditionalRequired.selector.length === 0 || !Number.isInteger(feedback.editor_count) || (feedback.editor_count as number) < 1 || !Array.isArray(feedback.controls_per_editor) || feedback.controls_per_editor.some((controlCount: unknown) => controlCount !== 4)) fail("feedback:legacy-gating-evidence");
        } else {
          if (!predatesBadgeGeometryEvidence(evidenceIdentity)) validateOptionalBadgeEvidence(feedback.optional_badge, viewport.id as string);
          if (feedback.disabled_before_input !== true || feedback.disabled_after_requested_change !== true || feedback.disabled_after_complete_feedback !== false || !Number.isInteger(feedback.editor_count) || (feedback.editor_count as number) < 1 || !Array.isArray(feedback.controls_per_editor) || feedback.controls_per_editor.some((controlCount: unknown) => controlCount !== 4)) fail("feedback:gating-evidence");
        }
        const isolation = byId["item-feedback-isolation"]!.details;
        if (isolation.values_isolated !== true || !Array.isArray(isolation.target_indices) || isolation.target_indices.length !== 2 || !Array.isArray(isolation.restored_values) || isolation.restored_values.length !== 2 || object(isolation.saved_response, "isolation.saved-response").approval_status !== "draft") fail("feedback:isolation-evidence");
        const draft = byId["draft-retention"]!.details;
        if (typeof draft.entered_value !== "string" || draft.entered_value.length === 0 || draft.restored_value !== draft.entered_value || !Array.isArray(draft.navigation) || draft.navigation.length !== 2) fail("draft:retention-evidence");
        if (historicalRound === null || historicalRound === 4) {
          const retainedSelection = object(draft.retained_selection, "draft.retained-selection");
          const retainedDisposition = object(draft.retained_disposition, "draft.retained-disposition");
          if (typeof retainedSelection.selected_target !== "string" || retainedSelection.selected_target.length === 0 || retainedSelection.selected_target !== retainedSelection.current_target || retainedDisposition.disposition !== "edit" || retainedDisposition.selected !== true) fail("draft:retention-evidence");
        }
        const actions = byId["final-actions"]!.details;
        if (actions.disabled_before_review !== true || actions.disabled_after_review !== false || !Number.isInteger(actions.reviewed_target_count) || (actions.reviewed_target_count as number) < 1) fail("final-actions:evidence");
        const focus = byId["focus-restoration"]!.details;
        if (focus.action !== "select-second-queue-item" || typeof focus.current !== "string" || focus.current.length === 0 || typeof focus.visible_summary !== "string" || focus.visible_summary !== focus.current || typeof focus.expected_focus !== "string" || focus.expected_focus.length === 0) fail("focus-restoration:evidence");
        const options = byId["four-options"]!.details;
        if (historicalRound === 2) {
          if (!Array.isArray(options.options_per_presentation) || options.options_per_presentation.length === 0 || options.options_per_presentation.some((optionCount: unknown) => optionCount !== 4) || !Array.isArray(options.observed) || options.observed.length === 0) fail("four-options:legacy-evidence");
        } else if (!Array.isArray(options.parity) || options.parity.length === 0 || options.parity.some((entry: unknown) => { const item = object(entry, "four-options.parity"); return item.option_count !== 4 || !Array.isArray(item.row_cell_counts) || item.row_cell_counts.some((cellCount: unknown) => cellCount !== 4) || !Array.isArray(item.visible_cell_labels) || item.visible_cell_labels.some((label: unknown) => typeof label !== "string" || label.length === 0); })) fail("four-options:evidence");
        const recommendation = byId["recommendation"]!.details;
        if (historicalRound === 2) {
          if (recommendation.marker_visible !== true || typeof recommendation.associated_option_heading !== "string" || recommendation.associated_option_heading.length === 0) fail("recommendation:legacy-evidence");
        } else if (recommendation.comparison_precedes_recommendation !== true || recommendation.option_recommendation_marker_count !== 0 || typeof recommendation.recommendation_text !== "string" || recommendation.recommendation_text.length === 0) fail("recommendation:evidence");
        const tabs = byId["responsive-tabs"]!.details;
        if (historicalRound === 2 || historicalRound === 3) validateHistoricalResponsiveTabs(tabs, historicalRound);
        else validateCurrentResponsiveTabs(tabs);
      }
      for (const key of ["interactions", "focus", "measurements", "page_errors", "console_errors", "resource_errors", "no_js"] as const) allFiles.push(fileRecord(entry[key], `viewport.${index}.${kind}.${key}`));
      for (const key of ["page_errors", "console_errors"] as const) {
        validateBrowserErrorEvidence(
          await readClosedJson(await beneath(browserRoot, fileRecord(entry[key], key).path), key),
          kind,
          viewport.id as string,
          key,
        );
      }
      validateBrowserErrorEvidence(
        await readClosedJson(await beneath(browserRoot, fileRecord(entry.resource_errors, "resource_errors").path), "resource_errors"),
        kind,
        viewport.id as string,
        "resource_errors",
      );
      const measurement = validateMeasurementEvidence(await readClosedJson(await beneath(browserRoot, fileRecord(entry.measurements, "measurements").path), "measurements"), kind, viewport.id as string, viewport.width as number);
      const capture = closed(measurement.screenshot_capture, "measurements.screenshot-capture", ["mode", "source_width", "source_height", "tile_height", "tile_count"]);
      const sourceHeight = count(capture.source_height, "measurements.screenshot-capture.source-height");
      const tileHeight = count(capture.tile_height, "measurements.screenshot-capture.tile-height");
      const tileCount = count(capture.tile_count, "measurements.screenshot-capture.tile-count");
      const screenshots = list(entry.screenshots, `viewport.${index}.${kind}.screenshots`).map((value, tileIndex) => screenshotTile(value, `viewport.${index}.${kind}.screenshots.${tileIndex}`));
      if (screenshots.length !== tileCount) fail(`viewport.${index}.${kind}:screenshot-count`);
      let coveredHeight = 0;
      for (const [tileIndex, tile] of screenshots.entries()) {
        if (tile.tile_index !== tileIndex || tile.y !== coveredHeight || tile.height !== Math.min(tileHeight, sourceHeight - coveredHeight)) fail(`viewport.${index}.${kind}:screenshot-coverage`);
        const tilePath = await beneath(browserRoot, tile.path);
        await rehash(tilePath, tile.sha256, tile.byte_count);
        const bytes = await readFile(tilePath);
        decodedTiles.push(Object.freeze({ label: `viewport.${index}.${kind}:screenshot-dimensions`, expected: Object.freeze({ width: viewport.width as number, height: tile.height }), parser: parseWebpDimensions(bytes), bytes }));
        coveredHeight += tile.height;
      }
      if (coveredHeight !== sourceHeight) fail(`viewport.${index}.${kind}:screenshot-coverage`);
      const focus = closed(await readClosedJson(await beneath(browserRoot, fileRecord(entry.focus, "focus").path), "focus"), "focus", ["schema", "artifact_kind", "viewport", "keyboard_observation"]);
      const keyboardObservation = object(focus.keyboard_observation, "focus.keyboard-observation");
      if (focus.artifact_kind !== kind || focus.viewport !== viewport.id || object(keyboardObservation.initial_focus, "focus.initial")?.tag === "BODY" || object(keyboardObservation.tab_focus, "focus.tab")?.tag === "BODY") fail("focus:observation");
      validateNoJsEvidence(await readClosedJson(await beneath(browserRoot, fileRecord(entry.no_js, "no-js").path), "no-js"), kind, viewport.id as string, evidenceIdentity);
      const prints = list(entry.print, `viewport.${index}.${kind}.print`); if (prints.length !== 1) fail("print:count");
      const print = closed(prints[0], "print", ["pdf", "inspection"]); allFiles.push(fileRecord(print.pdf, "print.pdf"), fileRecord(print.inspection, "print.inspection"));
      const printedPdf = fileRecord(print.pdf, "print.pdf");
      const printedPdfPath = await beneath(browserRoot, printedPdf.path);
      await rehash(printedPdfPath, printedPdf.sha256, printedPdf.byte_count);
      const recomputed = inspectPdfContentBounds(await readFile(printedPdfPath));
      const inspection = validatePrintInspection(await readClosedJson(await beneath(browserRoot, fileRecord(print.inspection, "print.inspection").path), "print.inspection"), kind, viewport.id as string, viewport.width as number, viewport.height as number, recomputed);
      const inspectedPdf = fileRecord(inspection.pdf, "print.inspection.pdf");
      if (printedPdf.path !== inspectedPdf.path || printedPdf.sha256 !== inspectedPdf.sha256 || printedPdf.byte_count !== inspectedPdf.byte_count) fail("print:pdf-binding");
    }
  }
  const decodedDimensions = await decodeWebpDimensionsBatch(decodedTiles.map(item => item.bytes));
  for (const [tileIndex, tile] of decodedTiles.entries()) {
    const decoded = decodedDimensions[tileIndex]!;
    if (decoded.width !== tile.parser.width || decoded.height !== tile.parser.height || decoded.width !== tile.expected.width || decoded.height !== tile.expected.height) fail(tile.label);
  }
  const seen = new Set<string>();
  for (const file of allFiles) { if (seen.has(file.path)) continue; seen.add(file.path); await rehash(await beneath(browserRoot, file.path), file.sha256, file.byte_count); }
  const commandHashes: string[] = [];
  for (const id of FOCUSED_COMMAND_IDS) {
    const path = resolve(input.focused_command_root, `${id}.json`); const result = validateCommandResult(await readClosedJson(path, `command.${id}`));
    if (result.id !== id || result.exit_code !== 0 || result.cwd !== "/workspace") fail(`command.${id}:result`);
    exactArray(result.argv, expectedCommand(id, input.artifact_manifest_argument ?? input.artifact_manifest), `command.${id}.argv`);
    for (const stream of [[result.stdout_path, result.stdout_sha256, result.stdout_byte_count], [result.stderr_path, result.stderr_sha256, result.stderr_byte_count]] as const) await rehash(await beneath(input.focused_command_root, stream[0]), stream[1], stream[2]);
    if (id === "focused-05-handoff") validateFocusedHandoffResult(JSON.parse(await readFile(await beneath(input.focused_command_root, result.stdout_path), "utf8")), artifact.sha256, historicalRound);
    commandHashes.push(hashRawBytes(await readFile(path)));
  }
  const evidenceSetSha = hashRawBytes(Buffer.from(canonicalJson({ artifact_manifest_sha256: artifact.sha256, browser_manifest_sha256: browserManifestSha, focused_command_result_sha256s: commandHashes }), "utf8"));
  const output = Object.freeze({ schema: BROWSER_EVIDENCE_SCHEMA, artifact_manifest_sha256: artifact.sha256, browser_manifest_sha256: browserManifestSha, focused_command_result_sha256s: Object.freeze(commandHashes), evidence_set_sha256: evidenceSetSha });
  if (input.write_output !== false) await exclusiveBytes(input.output, Buffer.from(`${canonicalJson(output)}\n`, "utf8"));
  return output;
}

export interface ExistingEvidenceValidation {
  readonly schema: typeof BROWSER_EVIDENCE_SCHEMA;
  readonly artifact_manifest_sha256: string;
  readonly browser_manifest_sha256: string;
  readonly focused_command_result_sha256s: readonly string[];
  readonly evidence_set_sha256: string;
}

export async function validateExistingEvidence(input: { readonly artifact_manifest: string; readonly artifact_manifest_argument: string; readonly focused_command_root: string; readonly browser_root: string; readonly validated_manifest: string }): Promise<ExistingEvidenceValidation> {
  const computed = await validateEvidence({ ...input, output: input.validated_manifest, write_output: false });
  const reopened = await readFile(input.validated_manifest);
  const expected = Buffer.from(`${canonicalJson(computed)}\n`, "utf8");
  if (!reopened.equals(expected)) fail("validated-manifest:reopen-mismatch");
  return computed;
}

function parseCli(argv: readonly string[]): { readonly command: "capture-command" | "validate"; readonly options: Map<string, string>; readonly tail: readonly string[] } {
  const command = argv[0]; if (command !== "capture-command" && command !== "validate") fail("cli:command");
  const options = new Map<string, string>(); let cursor = 1; let tail: readonly string[] = [];
  while (cursor < argv.length) { if (argv[cursor] === "--") { tail = argv.slice(cursor + 1); cursor = argv.length; break; } const flag = argv[cursor]; const value = argv[cursor + 1]; if (!flag?.startsWith("--") || value === undefined || value.startsWith("--") || options.has(flag)) fail("cli:arguments"); options.set(flag, value); cursor += 2; }
  return { command, options, tail };
}

if (import.meta.main) {
  const parsed = parseCli(Bun.argv.slice(2));
  if (parsed.command === "capture-command") {
    if (parsed.options.size !== 3 || !parsed.options.has("--root") || !parsed.options.has("--output-dir") || !parsed.options.has("--id") || parsed.tail.length === 0) fail("capture:arguments");
    const result = await captureCommand({ root: parsed.options.get("--root")!, output_dir: parsed.options.get("--output-dir")!, id: enumValue(parsed.options.get("--id"), FOCUSED_COMMAND_IDS, "capture.id"), argv: parsed.tail });
    if (result.exit_code !== 0) process.exitCode = result.exit_code;
  } else {
    if (parsed.options.size !== 4 || parsed.tail.length !== 0 || !parsed.options.has("--artifact-manifest") || !parsed.options.has("--focused-command-root") || !parsed.options.has("--browser-root") || !parsed.options.has("--output")) fail("validate:arguments");
    await validateEvidence({ artifact_manifest: parsed.options.get("--artifact-manifest")!, focused_command_root: parsed.options.get("--focused-command-root")!, browser_root: parsed.options.get("--browser-root")!, output: parsed.options.get("--output")! });
  }
}
