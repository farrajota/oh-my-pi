import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, hashRawBytes } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { captureCommand, decodeWebpDimensionsBatch, parseWebpDimensions, readArtifactManifest, validateCheckObservations, validateCommandResult, validateContrastEvidence, validateFocusedHandoffResult, validateMeasurementEvidence, validateNoJsEvidence, validateOptionalBadgeEvidence, validatePrintInspection } from "./ideation-authoring-evidence.ts";
import { inspectPdfContentBounds, PDF_CONTENT_BOUNDS_TOLERANCE_POINTS } from "./ideation-pdf-content-inspection.ts";

function commandRecord(): Record<string, unknown> {
  const bare = { schema: "ideation-authoring/command-result/v1", id: "focused-01-ideation", argv: ["bun", "test"], cwd: "/workspace", exit_code: 0, stdout_path: "focused-01-ideation.stdout", stdout_sha256: "a".repeat(64), stdout_byte_count: 0, stderr_path: "focused-01-ideation.stderr", stderr_sha256: "b".repeat(64), stderr_byte_count: 0, started_at: "2026-08-12T12:00:00.000Z", completed_at: "2026-08-12T12:00:01.000Z" } as const;
  return { ...bare, result_record_sha256: hashRawBytes(Buffer.from(canonicalJson(bare), "utf8")) };
}
function pdfWithContent(stream: string): Uint8Array {
  const chunks: string[] = [];
  const offsets = [0];
  let position = 0;
  const append = (chunk: string): void => { chunks.push(chunk); position += new TextEncoder().encode(chunk).byteLength; };
  append("%PDF-1.4\n");
  offsets.push(position); append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets.push(position); append("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets.push(position); append("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n");
  offsets.push(position); append("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  offsets.push(position); append(`5 0 obj\n<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}\nendstream\nendobj\n`);
  const xrefPosition = position;
  append("xref\n0 6\n0000000000 65535 f \n");
  for (let index = 1; index <= 5; index += 1) append(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`);
  return new TextEncoder().encode(chunks.join(""));
}
test("reopens immutable v1 manifests and derives their unindexed authority binding", async () => {
  const manifestPath = join("/workspace", "ai_docs/artifacts/plans/ideation-terminal-support-dossier-lifecycle/authoring-rounds/round-2/artifact-manifest.json");
  const manifest = await readArtifactManifest(manifestPath);
  expect(manifest.raw.schema).toBe("ideation-authoring/artifact-manifest/v1");
  expect(manifest.authority.byte_count).toBeNull();
  const handoff = manifest.raw.candidate as Record<string, unknown>;
  const authority = (handoff.handoff as Record<string, unknown>).substantive_review_authority as Record<string, unknown>;
  expect(manifest.authority.path).toBe(authority.path);
  expect(manifest.authority.sha256).toBe(authority.sha256);
});


function pdfWithText(x: number, y: number, text: string): Uint8Array {
  return pdfWithContent(`BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`);
}

function webpChunk(type: string, payload: Uint8Array): Buffer {
  const padding = payload.byteLength & 1;
  const chunk = Buffer.alloc(8 + payload.byteLength + padding);
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32LE(payload.byteLength, 4);
  Buffer.from(payload).copy(chunk, 8);
  return chunk;
}
function webp(...chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const bytes = Buffer.alloc(8 + body.byteLength);
  bytes.write("RIFF", 0, 4, "ascii");
  bytes.writeUInt32LE(body.byteLength, 4);
  body.copy(bytes, 8);
  return bytes;
}
function vp8(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.set([0x10, 0, 0, 0x9d, 0x01, 0x2a]);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", payload);
}
function vp8l(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return webpChunk("VP8L", payload);
}
function vp8x(width: number, height: number, flags = 0): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", payload);
}

describe("ideation authoring evidence closed command records", () => {
  test("accepts an exact command record", () => {
    expect(validateCommandResult(commandRecord()).id).toBe("focused-01-ideation");
  });

  test("rejects an unknown command record field", () => {
    expect(() => validateCommandResult({ ...commandRecord(), extra: true })).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:command-result:keys");
  });

  test("rejects a modified result record after its hash is bound", () => {
    expect(() => validateCommandResult({ ...commandRecord(), exit_code: 1 })).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:command-result:record-hash");
  });

  test("rejects a missing result record field", () => {
    const { stderr_path: _removed, ...incomplete } = commandRecord() as Record<string, unknown>;
    expect(() => validateCommandResult(incomplete)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:command-result:keys");
  });

  test("uses raw-byte hashes rather than text normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "ideation-evidence-test-"));
    const bytes = Buffer.from("line one\r\nline two\n", "utf8");
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out", "stdout"), bytes);
    expect(hashRawBytes(await readFile(join(root, "out", "stdout")))).toBe(hashRawBytes(bytes));
  });
});

describe("measurement evidence validation", () => {
  const valid = {
    schema: "ideation-authoring/browser-viewport/v1",
    artifact_kind: "support",
    viewport: "desktop-1440x900",
    title: "Approval dossier",
    heading: "Approval",
    scroll_width: 1_440,
    client_width: 1_440,
    horizontal_overflow: false,
    offenders: [],
    internal_overflow: [],
    measured_elements: [{ selector: "body" }],
    screenshot_capture: { mode: "full-width-vertical-tiles", source_width: 1_440, source_height: 900, tile_height: 4_096, tile_count: 1 },
  } as const;

  test("accepts writer keys and rejects missing, extra, or malformed new fields", () => {
    expect(validateMeasurementEvidence(valid, "support", "desktop-1440x900", 1_440)).toEqual(valid);
    expect(() => validateMeasurementEvidence({ ...valid, schema: "ideation-authoring/browser-evidence/v1" }, "support", "desktop-1440x900", 1_440)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:measurements:schema");
    const { title: _title, ...withoutTitle } = valid;
    expect(() => validateMeasurementEvidence(withoutTitle, "support", "desktop-1440x900", 1_440)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:measurements:keys");
    expect(() => validateMeasurementEvidence({ ...valid, extra: true }, "support", "desktop-1440x900", 1_440)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:measurements:keys");
    expect(() => validateMeasurementEvidence({ ...valid, title: 7 }, "support", "desktop-1440x900", 1_440)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:measurements:metadata");
    expect(() => validateMeasurementEvidence({ ...valid, heading: null }, "support", "desktop-1440x900", 1_440)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:measurements:metadata");
    expect(() => validateMeasurementEvidence({ ...valid, internal_overflow: "none" }, "support", "desktop-1440x900", 1_440)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:measurements:metadata");
  });
});

describe("contrast evidence validation", () => {
  const valid = { scheme: "light", minimum_ratio: 4.5, measured_surface_count: 2, surfaces: [{ selector: "p", foreground: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)", ratio: 21 }, { selector: "button", foreground: "rgb(255, 255, 255)", background: "rgb(0, 80, 90)", ratio: 8.1 }] } as const;

  test("accepts every measured surface at or above the threshold", () => {
    expect(validateContrastEvidence(valid, "light")).toBeUndefined();
  });

  test("rejects one sub-threshold surface", () => {
    expect(() => validateContrastEvidence({ ...valid, surfaces: [valid.surfaces[0], { ...valid.surfaces[1], ratio: 4.49 }] }, "light")).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:contrast:evidence");
  });

  test("rejects a mismatched measured surface count", () => {
    expect(() => validateContrastEvidence({ ...valid, measured_surface_count: 1 }, "light")).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:contrast:evidence");
  });
});
describe("focused handoff evidence validation", () => {
  test("admits only the exact immutable round-two handoff shape", async () => {
    const path = join("/workspace", "ai_docs/artifacts/plans/ideation-terminal-support-dossier-lifecycle/authoring-rounds/round-2/focused-commands/focused-05-handoff.stdout");
    const legacy = JSON.parse(await readFile(path, "utf8"));
    expect(validateFocusedHandoffResult(legacy, "29150bc679d5fbabb9d5933c032b3af935769c88bd5a975ba25607b094a6d817", 2)).toBeUndefined();
    expect(() => validateFocusedHandoffResult({ ...legacy, extra: true }, "29150bc679d5fbabb9d5933c032b3af935769c88bd5a975ba25607b094a6d817", 2)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:handoff-result:keys");
    expect(() => validateFocusedHandoffResult(legacy, "0".repeat(64), 2)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:command.focused-05-handoff:legacy-binding");
    const roundThree = JSON.parse(await readFile(join("/workspace", "ai_docs/artifacts/plans/ideation-terminal-support-dossier-lifecycle/authoring-rounds/round-3/focused-commands/focused-05-handoff.stdout"), "utf8"));
    expect(validateFocusedHandoffResult(roundThree, "8bc662ab3c5b22e6ea99960d2efc1c4cfa34e1718871d51c62a2b96984ebfca8", 3)).toBeUndefined();
    expect(() => validateFocusedHandoffResult({ ...roundThree, negative_scenarios: roundThree.negative_scenarios.slice(0, 1) }, "8bc662ab3c5b22e6ea99960d2efc1c4cfa34e1718871d51c62a2b96984ebfca8", 3)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:command.focused-05-handoff:legacy-negative-scenarios");
  });
});

describe("no-JavaScript evidence validation", () => {
  const valid = { schema: "ideation-authoring/browser-viewport/v1", artifact_kind: "candidate", viewport: "desktop-1440x900", inventory: ["feedback-0001"], semantic_inventory: ["TH:Option A", "TD:Benefit", "DT:Candidate SHA-256", "DD:abc", "LABEL:Requested change", "TEXTAREA:", "CODE:abc", "PRE:# Exact plan"], linear_order: ["Approval dossier"], javascript_disabled: true, reviewed_element_count: 1, hidden_element_count: 0, hidden_ids: [] } as const;

  test("accepts a complete visible static review", () => {
    expect(validateNoJsEvidence(valid, "candidate", "desktop-1440x900")).toBeUndefined();
  });

  test("rejects hidden static review content", () => {
    expect(() => validateNoJsEvidence({ ...valid, hidden_element_count: 1, hidden_ids: ["feedback-0001"] }, "candidate", "desktop-1440x900")).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:no-js:binding");
  });

  test("rejects incomplete semantic inventory despite internally consistent visibility", () => {
    expect(() => validateNoJsEvidence({ ...valid, semantic_inventory: ["DT:Candidate SHA-256", "DD:abc", "CODE:abc", "PRE:# Exact plan"] }, "candidate", "desktop-1440x900")).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:no-js:candidate-semantic-inventory");
  });

  test("accepts only the exact immutable round-two no-JavaScript evidence identity", async () => {
    const legacy = JSON.parse(await readFile(join("/workspace", "ai_docs/artifacts/plans/ideation-terminal-support-dossier-lifecycle/authoring-rounds/round-2/browser/no-js/desktop-1440x900-candidate.json"), "utf8"));
    const identity = {
      artifact_manifest_schema: "ideation-authoring/artifact-manifest/v1" as const,
      artifact_manifest_sha256: "29150bc679d5fbabb9d5933c032b3af935769c88bd5a975ba25607b094a6d817",
      browser_manifest_sha256: "87d550feb04b82aa4c35edfcd9874ddba615cd710e3d005d92dc670f00c8f8d2",
    } as const;
    expect(validateNoJsEvidence(legacy, "candidate", "desktop-1440x900", identity)).toBeUndefined();
    expect(() => validateNoJsEvidence(legacy, "candidate", "desktop-1440x900", { ...identity, browser_manifest_sha256: "0".repeat(64) })).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:no-js:keys");
  });

  test("rejects an unknown no-JavaScript record field", () => {
    expect(() => validateNoJsEvidence({ ...valid, extra: true }, "candidate", "desktop-1440x900")).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:no-js:keys");
  });
});
describe("optional feedback badge evidence validation", () => {
  const valid = {
    text: "Optional until edit or proposal",
    visible: true,
    rect: { left: 100, top: 20, right: 300, bottom: 44, width: 200, height: 24 },
    parent_heading_rect: { left: 90, top: 10, right: 320, bottom: 60, width: 230, height: 50 },
    contained: true,
  } as const;

  test("accepts readable desktop badge geometry", () => {
    expect(validateOptionalBadgeEvidence(valid, "desktop-1440x900")).toBeUndefined();
  });

  test("rejects the narrow vertical desktop strip", () => {
    const narrow = { ...valid, rect: { left: 100, top: 20, right: 124, bottom: 100, width: 24, height: 80 }, parent_heading_rect: { left: 90, top: 10, right: 320, bottom: 110, width: 230, height: 100 } };
    expect(() => validateOptionalBadgeEvidence(narrow, "desktop-1440x900")).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:feedback:optional-badge-geometry");
  });

  test("recomputes containment instead of trusting the observed flag", () => {
    const escaped = { ...valid, rect: { ...valid.rect, left: 80, right: 280 } };
    expect(() => validateOptionalBadgeEvidence(escaped, "desktop-1440x900")).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:feedback:optional-badge-geometry");
  });
});
describe("print inspection validation", () => {
  const recomputed = inspectPdfContentBounds(pdfWithText(10, 50, "inside"));
  const valid = { schema: "ideation-authoring/print-inspection/v1", artifact_kind: "candidate", viewport: "synthetic", pdf: { path: "print/synthetic/candidate.pdf", sha256: "a".repeat(64), byte_count: 100 }, settings: { print_background: true, prefer_css_page_size: true, width: `${recomputed.pages[0]!.bounds.x1 / 0.75}px`, height: `${recomputed.pages[0]!.bounds.y1 / 0.75}px` }, page_count: recomputed.page_count, pages: recomputed.pages, clipping_checked: true, clipping_tolerance_points: PDF_CONTENT_BOUNDS_TOLERANCE_POINTS, inventory: ["inside"], extracted_text_byte_count: recomputed.extracted_text_byte_count, missing_inventory: [] } as const;

  test("accepts PDF observations that equal recomputed content geometry", () => {
    const viewportWidth = recomputed.pages[0]!.bounds.x1 / 0.75;
    const viewportHeight = recomputed.pages[0]!.bounds.y1 / 0.75;
    expect(validatePrintInspection(valid, "candidate", "synthetic", viewportWidth, viewportHeight, recomputed)).toEqual(valid);
  });

  test("rejects a forged zero-count observation", () => {
    const forged = { ...valid, pages: [{ ...valid.pages[0], block_counts: { text: 0, image: 0, vector: 0, total: 0 } }] };
    const viewportWidth = recomputed.pages[0]!.bounds.x1 / 0.75;
    const viewportHeight = recomputed.pages[0]!.bounds.y1 / 0.75;
    expect(() => validatePrintInspection(forged, "candidate", "synthetic", viewportWidth, viewportHeight, recomputed)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:print:page");
  });

  test("detects content extending beyond the media box", () => {
    const clipped = inspectPdfContentBounds(pdfWithText(95, 50, "outside"));
    expect(clipped.pages[0]?.maximum_overflow).toBeGreaterThan(PDF_CONTENT_BOUNDS_TOLERANCE_POINTS);
    expect(clipped.pages[0]?.out_of_bounds_count).toBe(1);
    expect(clipped.pages[0]?.clipped).toBe(true);
  });
  test("detects a vector painted outside the media box", () => {
    const inspection = inspectPdfContentBounds(pdfWithContent("BT /F1 12 Tf 10 50 Td (inside) Tj ET 95 40 20 20 re f"));
    expect(inspection.pages[0]?.block_counts.vector).toBe(1);
    expect(inspection.pages[0]?.maximum_overflow).toBeGreaterThan(PDF_CONTENT_BOUNDS_TOLERANCE_POINTS);
    expect(inspection.pages[0]?.clipped).toBe(true);
  });

  test("intersects vector paint with an explicit PDF clip", () => {
    const inspection = inspectPdfContentBounds(pdfWithContent("BT /F1 12 Tf 10 50 Td (inside) Tj ET q 0 0 100 100 re W n 95 40 20 20 re f Q"));
    expect(inspection.pages[0]?.block_counts.vector).toBe(1);
    expect(inspection.pages[0]?.maximum_overflow).toBeLessThanOrEqual(PDF_CONTENT_BOUNDS_TOLERANCE_POINTS);
    expect(inspection.pages[0]?.clipped).toBe(false);
  });

  test("rejects an unknown print inspection field", () => {
    const viewportWidth = recomputed.pages[0]!.bounds.x1 / 0.75;
    const viewportHeight = recomputed.pages[0]!.bounds.y1 / 0.75;
    expect(() => validatePrintInspection({ ...valid, extra: true }, "candidate", "synthetic", viewportWidth, viewportHeight, recomputed)).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:print.inspection:keys");
  });
});

test("persists and returns the exact nonzero child exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-failing-command-"));
  const outputDir = join(root, "evidence");
  const timestamps = [new Date("2026-08-12T12:00:00.000Z"), new Date("2026-08-12T12:00:01.000Z")];
  const result = await captureCommand({
    root,
    output_dir: outputDir,
    id: "focused-01-ideation",
    argv: [process.execPath, "-e", 'process.stdout.write("captured stdout"); process.stderr.write("captured stderr"); process.exit(23)'],
    now: () => timestamps.shift()!,
  });

  expect(result.exit_code).toBe(23);
  expect(await readFile(join(outputDir, result.stdout_path), "utf8")).toBe("captured stdout");
  expect(await readFile(join(outputDir, result.stderr_path), "utf8")).toBe("captured stderr");
  const persisted = validateCommandResult(JSON.parse(await readFile(join(outputDir, "focused-01-ideation.json"), "utf8")));
  expect(persisted).toEqual(result);
  expect(persisted.exit_code).toBe(23);
});

test("capture-command CLI propagates the persisted child failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-failing-cli-"));
  const outputDir = join(root, "evidence");
  const wrapper = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "ideation-authoring-evidence.ts"),
    "capture-command",
    "--root", root,
    "--output-dir", outputDir,
    "--id", "focused-01-ideation",
    "--",
    process.execPath,
    "-e",
    "process.exit(29)",
  ]);

  expect(await wrapper.exited).toBe(29);
  const persisted = validateCommandResult(JSON.parse(await readFile(join(outputDir, "focused-01-ideation.json"), "utf8")));
  expect(persisted.exit_code).toBe(29);
});

describe("local WebP dimension parser", () => {
  test("reads VP8, VP8L, and VP8X static image dimensions", () => {
    expect(parseWebpDimensions(webp(vp8(390, 844)))).toEqual({ width: 390, height: 844 });
    expect(parseWebpDimensions(webp(vp8l(1024, 768)))).toEqual({ width: 1024, height: 768 });
    expect(parseWebpDimensions(webp(vp8x(1440, 900), vp8(1440, 900)))).toEqual({ width: 1440, height: 900 });
  });

  test("rejects truncated, animated, multiple-frame, and mismatched-canvas WebP", () => {
    expect(() => parseWebpDimensions(webp(vp8(390, 844)).subarray(0, 20))).toThrow("screenshot:webp-riff-size");
    expect(() => parseWebpDimensions(webp(vp8x(390, 844, 0x02), vp8(390, 844)))).toThrow("screenshot:webp-vp8x");
    expect(() => parseWebpDimensions(webp(vp8(390, 844), vp8(390, 844)))).toThrow("screenshot:webp-multiple-frames");
    expect(() => parseWebpDimensions(webp(vp8x(391, 844), vp8(390, 844)))).toThrow("screenshot:webp-canvas-frame");
  });

  test("rejects invalid codec header bits and nonzero RIFF padding", () => {
    const invalidVp8 = vp8(390, 844);
    invalidVp8[8] = 0;
    expect(() => parseWebpDimensions(webp(invalidVp8))).toThrow("screenshot:webp-vp8");

    const invalidVp8l = vp8l(390, 844);
    invalidVp8l[12] |= 0x20;
    expect(() => parseWebpDimensions(webp(invalidVp8l))).toThrow("screenshot:webp-vp8l-version");

    const padded = webp(vp8(390, 844), webpChunk("JUNK", Buffer.from([1])));
    padded[39] = 1;
    expect(() => parseWebpDimensions(padded)).toThrow("screenshot:webp-chunk-padding");
  });

  test("uses Chromium as the codec authority without an image-decoder package", async () => {
    const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
    expect(source).not.toContain("sharp");
    expect(source).toContain("puppeteer-core");
    expect(source).toContain("await image.decode()");
  });

  test("keeps PDF inspection synchronous after asynchronous module initialization", () => {
    const inspection = inspectPdfContentBounds(pdfWithContent("BT /F1 12 Tf 10 50 Td (inside) Tj ET"));
    expect(inspection).not.toBeInstanceOf(Promise);
    expect(inspection.page_count).toBe(1);
  });

  test("decodes a real Chromium WebP with dimensions equal to the strict parser", async () => {
    const valid = Buffer.from("UklGRgACAABXRUJQVlA4WAoAAAAgAAAAAAAAAAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDhMEQAAAC8AAAAAB1CaStSq/4GI6H8AAA==", "base64");
    const parsed = parseWebpDimensions(valid);
    expect(parsed).toEqual({ width: 1, height: 1 });
    expect(await decodeWebpDimensionsBatch([valid])).toEqual([parsed]);
  }, 15_000);
});

test("requires fresh exclusive output path semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-exclusive-"));
  const path = join(root, "record.json");
  await writeFile(path, "first");
  await expect(writeFile(path, "second", { flag: "wx" })).rejects.toThrow();
});

test("does not accept a command record with a reordered stable command ID", () => {
  const record = commandRecord();
  expect(() => validateCommandResult({ ...record, id: "focused-05-handoff" })).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:command-result:record-hash");
});

test("rejects negative raw byte counts", () => {
  const record = commandRecord();
  expect(() => validateCommandResult({ ...record, stdout_byte_count: -1 })).toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:command-result.stdout-count:byte-count");
});

test("rejects an applicable pass that has no bound observation file", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain("missing-observation");
  expect(source).toContain("validateCheckObservations");
});

test("rejects manifest details that differ from the bound raw observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-observation-mismatch-"));
  const evidencePath = "checks/desktop-1440x900/support/header.json";
  await mkdir(join(root, "checks/desktop-1440x900/support"), { recursive: true });
  const raw = { schema: "ideation-authoring/check-observation/v1", artifact_kind: "support", viewport: "desktop-1440x900", check_id: "header", observations: { visible_count: 2 } };
  const bytes = Buffer.from(canonicalJson(raw), "utf8");
  await writeFile(join(root, evidencePath), bytes);
  const checks = [{ check_id: "header", artifact_kind: "support", applicability: "applicable", status: "pass", evidence_paths: [{ path: evidencePath, sha256: hashRawBytes(bytes), byte_count: bytes.byteLength }], details: { visible_count: 1 } }] as const;
  await expect(validateCheckObservations(root, "desktop-1440x900", "support", checks)).rejects.toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:check.header:observation-details-mismatch");
});
test("accepts a workspace HTML attachment beside the exact final-actions observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-observation-html-"));
  const evidencePath = "checks/desktop-1440x900/workspace/final-actions.json";
  const attachmentPath = "downloads/questionnaire.html";
  await mkdir(join(root, "checks/desktop-1440x900/workspace"), { recursive: true });
  await mkdir(join(root, "downloads"), { recursive: true });
  const raw = { schema: "ideation-authoring/check-observation/v1", artifact_kind: "workspace", viewport: "desktop-1440x900", check_id: "final-actions", observations: { reviewed_target_count: 1 } };
  const bytes = Buffer.from(canonicalJson(raw), "utf8");
  const attachmentBytes = Buffer.from("<!doctype html><title>Questionnaire</title>", "utf8");
  await writeFile(join(root, evidencePath), bytes);
  await writeFile(join(root, attachmentPath), attachmentBytes);
  const checks = [{ check_id: "final-actions", artifact_kind: "workspace", applicability: "applicable", status: "pass", evidence_paths: [{ path: attachmentPath, sha256: hashRawBytes(attachmentBytes), byte_count: attachmentBytes.byteLength }, { path: evidencePath, sha256: hashRawBytes(bytes), byte_count: bytes.byteLength }], details: { reviewed_target_count: 1 } }] as const;
  await expect(validateCheckObservations(root, "desktop-1440x900", "workspace", checks)).resolves.toBeUndefined();
});

test("rejects an applicable pass without the exact observation path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-observation-missing-"));
  const attachmentPath = "checks/desktop-1440x900/support/header.txt";
  const attachmentBytes = Buffer.from("observation", "utf8");
  await mkdir(join(root, "checks/desktop-1440x900/support"), { recursive: true });
  await writeFile(join(root, attachmentPath), attachmentBytes);
  const checks = [{ check_id: "header", artifact_kind: "support", applicability: "applicable", status: "pass", evidence_paths: [{ path: attachmentPath, sha256: hashRawBytes(attachmentBytes), byte_count: attachmentBytes.byteLength }], details: { visible_count: 1 } }] as const;
  await expect(validateCheckObservations(root, "desktop-1440x900", "support", checks)).rejects.toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:check.header:missing-observation");
});

test("rejects duplicate exact observation paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-observation-duplicate-"));
  const evidencePath = "checks/desktop-1440x900/support/header.json";
  await mkdir(join(root, "checks/desktop-1440x900/support"), { recursive: true });
  const raw = { schema: "ideation-authoring/check-observation/v1", artifact_kind: "support", viewport: "desktop-1440x900", check_id: "header", observations: { visible_count: 1 } };
  const bytes = Buffer.from(canonicalJson(raw), "utf8");
  await writeFile(join(root, evidencePath), bytes);
  const evidence = { path: evidencePath, sha256: hashRawBytes(bytes), byte_count: bytes.byteLength };
  const checks = [{ check_id: "header", artifact_kind: "support", applicability: "applicable", status: "pass", evidence_paths: [evidence, evidence], details: { visible_count: 1 } }] as const;
  await expect(validateCheckObservations(root, "desktop-1440x900", "support", checks)).rejects.toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:check.header:duplicate-observation");
});

test("rejects an observation at the wrong path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideation-evidence-observation-wrong-"));
  const evidencePath = "checks/desktop-1440x900/support/wrong-header.json";
  await mkdir(join(root, "checks/desktop-1440x900/support"), { recursive: true });
  const raw = { schema: "ideation-authoring/check-observation/v1", artifact_kind: "support", viewport: "desktop-1440x900", check_id: "header", observations: { visible_count: 1 } };
  const bytes = Buffer.from(canonicalJson(raw), "utf8");
  await writeFile(join(root, evidencePath), bytes);
  const checks = [{ check_id: "header", artifact_kind: "support", applicability: "applicable", status: "pass", evidence_paths: [{ path: evidencePath, sha256: hashRawBytes(bytes), byte_count: bytes.byteLength }], details: { visible_count: 1 } }] as const;
  await expect(validateCheckObservations(root, "desktop-1440x900", "support", checks)).rejects.toThrow("IDEATION_AUTHORING_EVIDENCE_INVALID:check.header:missing-observation");
});

test("rejects generic asserted browser pass markers", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain('"verified"');
  expect(source).toContain('"deferred"');
  expect(source).toContain('"focus_visible"');
  expect(source).toContain('"return_checks"');
  expect(source).toContain('"contracts"');
  expect(source).toContain('"saved_response_target_binding"');
  expect(source).toContain('"clipping"');
});

test("uses Bun-executable explicit-relative hidden paths for focused commands", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain("argument.startsWith(\".omp/agent/skills/ideation-with-critique/\")");
  expect(source).toContain("return `./farrajota-oh-my-pi/${argument}`;");
  expect(source).toContain('argument === ".omp/agent/extension-tests/ideation-cutover.test.ts"');
  expect(source).toContain('[common, "./farrajota-oh-my-pi/.omp/agent/skills/ideation-with-critique/scripts/ideation-handoff-check.ts"');
  expect(source).not.toContain('[common, "./.omp/agent/skills/ideation-with-critique/scripts/ideation-handoff-check.ts"');
});

test("validates the focused handoff command's bound negative scenarios", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain("validateHandoffCheckResult");
  expect(source).toContain("command.focused-05-handoff:negative-scenarios");
  expect(source).toContain("handoff.negative_scenarios.some");
});

test("rejects internally consistent but non-probative candidate pass records", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  for (const rejection of ["feedback:isolation-evidence", "draft:retention-evidence", "final-actions:evidence", "focus-restoration:evidence", "four-options:evidence", "recommendation:evidence", "responsive-tabs:desktop-semantics"])
    expect(source).toContain(rejection);
});

test("requires probative responsive-tab pointer, traversal, focus, and pane evidence", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain("responsive-tabs:interaction-evidence");
  expect(source).toContain("responsive-tabs.pointer-activation");
  expect(source).toContain("responsive-tabs.pane-traversal");
  expect(source).toContain('pointer.selected !== "review"');
  expect(source).toContain('afterRight.selected !== "feedback"');
  expect(source).toContain('afterEnd.selected !== "notes"');
	expect(source).toContain("responsive-tabs.preserved-review-state");
	expect(source).toContain('before.requested_change !== "responsive-tab-draft"');
	expect(source).toContain("canonicalJson(before) !== canonicalJson(after)");
  expect(source).toContain('afterHome.selected !== "queue"');
});

test("requires retained selection and disposition alongside the draft value", async () => {
  const source = await Bun.file(import.meta.dir + "/ideation-authoring-evidence.ts").text();
  expect(source).toContain("draft.retained-selection");
  expect(source).toContain("draft.retained-disposition");
  expect(source).toContain("retainedDisposition.disposition !== \"edit\"");
  expect(source).toContain("retainedDisposition.selected !== true");
});
