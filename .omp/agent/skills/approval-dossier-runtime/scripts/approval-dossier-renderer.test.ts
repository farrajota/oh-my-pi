import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateSha256,
  visualSetSha256,
} from "../schemas/approval-dossier.ts";
import type { VisualSet } from "../schemas/approval-dossier.ts";
import {
  createApprovalResponse,
  createCandidateBinding,
  createMarkdownFileRecord,
} from "./approval-dossier-runtime.ts";
import { extractProtectedApprovalPayload } from "./approval-dossier-html.ts";
import { createApprovalDossierBrowserFixture } from "./approval-dossier-browser-fixture.ts";
import {
  approvalResponseFilename,
  contentSecurityPolicy,
  loadApprovalDossierRendererSnapshot,
  loadApprovalDossierRendererSnapshotFromRuntimeRoot,
  renderApprovalDossier,
} from "./approval-dossier-renderer.ts";
import {
  nativeVisualSha256,
  projectNativeVisual,
  projectNativeVisualFallback,
} from "./native-svg-projector.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { NativeVisual } from "./native-svg-projector.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const MARKDOWN = Buffer.from("# Exact plan\n\nKeep every byte.\n", "utf8");
function contextOnlyPresentation(target_id: string) {
  return { target_id, presentation: { kind: "context-only" as const } };
}
function fourOptionDecisionPresentation(
  target_id: string,
): ApprovalDossierReviewPresentationInput {
  return {
    target_id,
    presentation: {
      kind: "four-option-decision" as const,
      purpose: "Select the bounded review path.",
      why_it_matters: "The decision governs the review sequence.",
      system_position: "The first decision in the review queue.",
      dependency_target_ids: [] as const,
      key_points: [
        "Queue point one",
        "Queue point two",
        "Queue point three",
      ] as const,
      research_summary: ["Research supports the recommended path."] as const,
      options: [
        {
          option_id: "option-1",
          label: "First option",
          mechanism_or_output: "First output",
          benefit: "First benefit",
          omission_cost_or_uncertainty: "First uncertainty",
          downstream_consequence: "First consequence",
          evidence_ids: ["E-1"],
        },
        {
          option_id: "option-2",
          label: "Second option",
          mechanism_or_output: "Second output",
          benefit: "Second benefit",
          omission_cost_or_uncertainty: "Second uncertainty",
          downstream_consequence: "Second consequence",
          evidence_ids: ["E-2"],
        },
        {
          option_id: "option-3",
          label: "Third option",
          mechanism_or_output: "Third output",
          benefit: "Third benefit",
          omission_cost_or_uncertainty: "Third uncertainty",
          downstream_consequence: "Third consequence",
          evidence_ids: ["E-3"],
        },
        {
          option_id: "option-4",
          label: "Fourth option",
          mechanism_or_output: "Fourth output",
          benefit: "Fourth benefit",
          omission_cost_or_uncertainty: "Fourth uncertainty",
          downstream_consequence: "Fourth consequence",
          evidence_ids: ["E-4"],
        },
      ] as const,
      recommended_option_id: "option-1",
      recommendation_rationale: "The first option is the most bounded.",
      uncertainty: "No material uncertainty remains.",
    },
  };
}

function fixture() {
  const files = [createMarkdownFileRecord("ai_docs/example.md", MARKDOWN)];
  const candidate = createCandidateBinding({
    workflow: "ideation",
    run_id: "renderer-fixture",
    revision: 7,
    semantic_sha256: HASH_A,
    files,
    visual_set_sha256: visualSetSha256([]),
    runtime_sha256: HASH_B,
    review_authority_sha256: HASH_A,
    predecessors: [],
  });
  const approval = createApprovalResponse({
    candidate,
    approval_status: "draft",
    approval_actor: "Reviewer",
    submitted_at: "2026-08-03T12:00:00.000Z",
    approved_at: null,
    files: [{ path: "ai_docs/example.md", bytes: MARKDOWN }],
    feedback: [],
  });
  const feedback_targets = [
    {
      target: {
        target_type: "semantic-id" as const,
        semantic_id: "decision.review-order",
      },
      label: "Review order decision",
      context: "Confirm whether the selected review sequence is appropriate.",
      unresolved: true,
    },
  ];
  const review_presentations = [
    contextOnlyPresentation("decision.review-order"),
  ];
  const visual_set: VisualSet = {
    schema: "approval-dossier/visual-set/v1",
    visual_set_sha256: visualSetSha256([]),
    visuals: [],
  };
  return {
    title: "Hostile </title> dossier",
    candidate,
    approval,
    visual_set,
    visuals: [] as readonly NativeVisual[],
    feedback_targets,
    review_presentations,
  };
}

describe("approval dossier renderer", () => {
  test("renders deterministic UTF-8 LF candidate bytes from fixed closed inputs", async () => {
    const input = fixture();
    const snapshot = await loadApprovalDossierRendererSnapshot();
    const first = await renderApprovalDossier(input, snapshot);
    const second = await renderApprovalDossier(input, snapshot);
    expect(first.html).toBe(second.html);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.html.endsWith("\n")).toBeTrue();
    expect(first.html).not.toContain("\r");
    expect(first.candidate_sha256).toBe(candidateSha256(input.candidate));
  });

  test("uses Unicode simple lowercasing for locale-independent serialized search data", async () => {
    const input = fixture();
    const rendered = await renderApprovalDossier({
      ...input,
      feedback_targets: [
        {
          target: { target_type: "dossier" },
          label: "İstanbul I",
          context: "ID I",
          unresolved: true,
        },
      ],
      review_presentations: [contextOnlyPresentation("dossier")],
    });
    expect(rendered.html).toContain(
      'data-search-text="i̇stanbul i id i entire dossier"',
    );
    expect(rendered.html).not.toContain(
      'data-search-text="istanbul ı ıd ı entire dossier"',
    );
  });

  test("keeps every exact Markdown file visible in static anchor-navigable HTML", async () => {
    const rendered = await renderApprovalDossier(fixture());
    expect(rendered.html).toContain('href="#source"');
    expect(rendered.html).toContain(
      'data-approval-dossier-visible-markdown="ai_docs/example.md"',
    );
    expect(rendered.html).toContain("# Exact plan");
    expect(rendered.html).toContain("Keep every byte.");
    expect(rendered.html).not.toContain('role="tablist"');
    expect(rendered.html).not.toContain('role="tabpanel"');
    expect(rendered.html).not.toContain("<section hidden");
    expect(rendered.html).toContain("JavaScript is disabled");
  });

  test("hash-authorizes exact active bytes under strict offline CSP", async () => {
    const snapshot = await loadApprovalDossierRendererSnapshot();
    const rendered = await renderApprovalDossier(fixture(), snapshot);
    const csp = contentSecurityPolicy(snapshot.css, snapshot.javascript);
    expect(rendered.html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "worker-src 'none'",
      "img-src 'none'",
      "script-src-attr 'none'",
      "style-src-attr 'none'",
    ])
      expect(csp).toContain(directive);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("ships authored responsive review-workspace, accessibility, and source-drawer rules", async () => {
    const snapshot = await loadApprovalDossierRendererSnapshot();
    for (const rule of [
      "max-width: 52rem",
      "prefers-color-scheme: dark",
      "@media print",
      "forced-colors: active",
      "prefers-reduced-motion: reduce",
      ".review-workspace",
      ".mobile-review-tabs",
      ".source-drawer",
      "scroll-margin-top: 4.5rem",
      ".anchor-nav { position: static; }",
      "button:disabled",
    ])
      expect(snapshot.css).toContain(rule);
  });

  test("keeps the feedback header optional badge in a full left-aligned grid row", async () => {
    const snapshot = await loadApprovalDossierRendererSnapshot();
    expect(snapshot.css).toContain(
      "\t#review-pane-feedback .panel-heading > .navigation-badge {\n\t\tgrid-column: 1 / -1;\n\t\tjustify-self: start;\n\t}",
    );
    const rendered = await renderApprovalDossier(fixture(), snapshot);
    expect(rendered.html).toContain('class="navigation-badge">Optional until edit or proposal</');
  });

  test("hydrates from protected template content and serializes only durable typed feedback", async () => {
    const snapshot = await loadApprovalDossierRendererSnapshot();
    for (const forbidden of [
      "innerHTML",
      "insertAdjacentHTML",
      "eval(",
      "Function(",
      "import(",
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "<svg",
      "data-local-review-note",
      "local review aid",
      "not serialized",
    ])
      expect(snapshot.javascript).not.toContain(forbidden);
    expect(snapshot.javascript).toContain("element.content.textContent");
    expect(snapshot.javascript).not.toContain(
      "const encoded = element.textContent",
    );
    expect(snapshot.javascript).toContain(
      "protected approval payload encoding is not canonical UTF-8",
    );
    expect(snapshot.javascript).toContain("collectFeedback");
    expect(snapshot.javascript).toMatch(
      /const feedback = collectFeedback\(dispositions\);[\s\S]*?const next = \{[\s\S]*?\bfeedback\b[\s\S]*?\};[\s\S]*?base64Utf8\(JSON\.stringify\(next\)\)/,
    );
    expect(snapshot.javascript).toContain(
      "changes requested requires at least one feedback item",
    );
    expect(snapshot.javascript).toContain(
      "approval requires all feedback to be cleared",
    );
    expect(snapshot.javascript).toContain("approval requires reviewing all");
    expect(snapshot.javascript).toContain(
      "Item drafts stay in this page while you navigate.",
    );
    expect(snapshot.javascript).toContain(
      '["ArrowLeft", "ArrowRight", "Home", "End"]',
    );
    expect(snapshot.javascript).toContain("tab.tabIndex = selected ? 0 : -1");
    expect(snapshot.javascript).toContain("tab.getClientRects().length > 0");
    expect(snapshot.javascript).toContain(
      'base64Utf8(JSON.stringify(feedback.target)) !== item.getAttribute("data-feedback-target")',
    );
    expect(snapshot.javascript).toContain("const dispositions = new Map()");
    expect(snapshot.javascript).toContain("syncDisposition(activeId)");
    expect(snapshot.javascript).toContain("fields.hidden = !open");
    expect(snapshot.javascript).toContain(
      'action.disabled = action.dataset.action === "approved"',
    );
    expect(snapshot.javascript).toContain('let pendingAction = ""');
    expect(snapshot.javascript).toContain("pendingAction !== approvalStatus");
    expect(snapshot.javascript).toContain(
      "Review the selected final action, then activate it again",
    );
    expect(snapshot.javascript).not.toContain("canonical(feedback.target)");
    const rendered = await renderApprovalDossier(fixture(), snapshot);
    expect(rendered.html).toContain("Review order decision");
    expect(rendered.html).toContain(
      "Confirm whether the selected review sequence is appropriate.",
    );
    expect(rendered.html).toContain("data-feedback-target=");
    expect(rendered.html).toContain("data-feedback-kind");
    expect(rendered.html).toContain("data-feedback-requested-change");
    expect(rendered.html).toContain("data-feedback-rationale");
    expect(rendered.html).toContain("data-feedback-evidence-ids");
    expect(rendered.html).toContain("data-feedback-prompt");
    expect(rendered.html).toContain('class="feedback-fields" data-feedback-fields>');
    expect(rendered.html).toContain("Clear feedback and mark no change");
    expect(rendered.html).toContain(
      "This bounded target has contextual review metadata only.",
    );
    const feedbackTarget = fixture().feedback_targets[0]!.target;
    expect(rendered.html).toContain(
      `data-feedback-target="${Buffer.from(canonicalJson(feedbackTarget), "utf8").toString("base64")}"`,
    );
  });

  test("renders every four-option key point in the queue while retaining compact context-only queue items", async () => {
    const input = fixture();
    const decision = await renderApprovalDossier({
      ...input,
      review_presentations: [
        fourOptionDecisionPresentation("decision.review-order"),
      ],
    });
    const decisionQueue =
      decision.html.match(/<nav id="review-pane-queue"[\s\S]*?<\/nav>/)?.[0] ??
      "";
    expect(decisionQueue).toContain('class="review-item-key-points"');
    for (const point of [
      "Queue point one",
      "Queue point two",
      "Queue point three",
    ])
      expect(decisionQueue).toContain(`<li>${point}</li>`);

    const contextual = await renderApprovalDossier(input);
    const contextOnlyQueue =
      contextual.html.match(
        /<nav id="review-pane-queue"[\s\S]*?<\/nav>/,
      )?.[0] ?? "";
    expect(contextOnlyQueue).not.toContain('class="review-item-key-points"');
    expect(contextOnlyQueue).toContain(
      'data-search-text="review order decision confirm whether the selected review sequence is appropriate. semantic id: decision.review-order"',
    );
  });

  test("describes every feedback control with distinct optional pointer and keyboard help", async () => {
    const rendered = await renderApprovalDossier(fixture());
    const feedbackEditor =
      rendered.html.match(
        /<article id="feedback-0001"[\s\S]*?<\/article>/,
      )?.[0] ?? "";
    const controls = [
      ["data-feedback-kind", "feedback-0001-feedback-kind-help"],
      ["data-feedback-requested-change", "feedback-0001-requested-change-help"],
      ["data-feedback-rationale", "feedback-0001-rationale-help"],
      ["data-feedback-evidence-ids", "feedback-0001-evidence-ids-help"],
    ] as const;
    for (const [control, helpId] of controls) {
      expect(feedbackEditor).toMatch(
        new RegExp(
          `<[^>]*${control}[^>]*aria-describedby="${helpId}"|<[^>]*aria-describedby="${helpId}"[^>]*${control}`,
        ),
      );
      expect(feedbackEditor).toContain(`id="${helpId}"`);
    }
    expect(controls.map(([, helpId]) => helpId)).toEqual([
      "feedback-0001-feedback-kind-help",
      "feedback-0001-requested-change-help",
      "feedback-0001-rationale-help",
      "feedback-0001-evidence-ids-help",
    ]);
    expect(feedbackEditor.match(/Optional/g)?.length).toBe(4);
    expect(feedbackEditor.match(/pointer or keyboard/g)?.length).toBe(4);
  });

  test("renders a bounded decision navigator instead of one undifferentiated feedback disclosure", async () => {
    const rendered = await renderApprovalDossier(fixture());
    for (const marker of [
      'class="review-workspace"',
      'data-testid="primary-navigation"',
      'data-testid="current-item"',
      'data-testid="feedback-editor"',
      'data-testid="progress"',
      'data-testid="final-actions"',
      'data-mobile-review-tab="queue"',
      'data-mobile-review-tab="review"',
      'data-mobile-review-tab="feedback"',
      'id="mobile-review-tab-queue"',
      'id="review-pane-review"',
      'class="review-map-svg"',
      'class="source-drawer"',
    ])
      expect(rendered.html).toContain(marker);
    expect(rendered.html).toContain("Review one bounded decision at a time");
    expect(rendered.html).toContain("Navigation aid only");
    expect(rendered.html).not.toContain(
      "<details><summary>Bound feedback targets</summary>",
    );
  });

  test("renders a neutral parity-preserving four-option comparison with recommendation after the options", async () => {
    const rendered = await renderApprovalDossier({
      ...fixture(),
      review_presentations: [fourOptionDecisionPresentation("decision.review-order")],
    });
    expect(rendered.html).toContain('class="review-option-comparison"');
    expect(rendered.html).toContain("Options compared");
    expect(rendered.html.match(/class="review-option"/g)?.length).toBe(4);
    expect(rendered.html).toContain('class="option-recommendation"');
    expect(rendered.html.indexOf('class="review-option-comparison"')).toBeLessThan(rendered.html.indexOf('class="option-recommendation"'));
    expect(rendered.html).not.toContain("recommended-option");
    expect(rendered.html).not.toContain("recommendation-marker");
    expect(rendered.html).toContain("Requested change and rationale are required when requesting an edit or adding a proposal.");
  });

  test("includes an explicit complete static-review path without browser authority", async () => {
    const rendered = await renderApprovalDossier(fixture());
    expect(rendered.html).toContain("Every bound review item, comparison, feedback field, authority binding, and exact source remains available below");
    expect(rendered.html).toContain("Saving a response requires JavaScript.");
    expect(rendered.html).toContain("[data-review-summary][hidden]");
  });

  test("ships valid conditional-feedback gating and responsive semantic tab cleanup", async () => {
    const snapshot = await loadApprovalDossierRendererSnapshot();
    expect(snapshot.javascript).toContain("function validConditionalFeedback()");
    expect(snapshot.javascript).toContain("feedback === null || feedback.length === 0");
    expect(snapshot.javascript).toContain('addEventListener("input", () => { resetPendingAction(); syncActionGates(); })');
    expect(snapshot.javascript).toContain('addEventListener("change", () => { resetPendingAction(); syncActionGates(); })');
    expect(snapshot.javascript).toContain("function syncTabSemantics()");
    expect(snapshot.javascript).toContain('pane.removeAttribute("role")');
    expect(snapshot.javascript).toContain('pane.removeAttribute("aria-labelledby")');
    expect(snapshot.css).toContain("@media (max-width: 84rem)");
    expect(snapshot.css).toContain(".review-option-comparison td::before");
    expect(snapshot.css).toContain(".review-option-comparison { overflow: clip; }");
  });

  test("requires an explicit closed feedback-target list while accepting an empty list", async () => {
    const input = fixture();
    const snapshot = await loadApprovalDossierRendererSnapshot();
    expect(snapshot.javascript).toContain(
      "const complete = dispositions.size === editors.length",
    );
    const empty = await renderApprovalDossier(
      { ...input, feedback_targets: [], review_presentations: [] },
      snapshot,
    );
    expect(empty.html).toContain("No bounded review items");
    expect(empty.html).not.toContain("local review");
    await expect(
      renderApprovalDossier({ ...input, review_presentations: [] }, snapshot),
    ).rejects.toThrow(
      "review presentations must align one-to-one with feedback targets",
    );
    await expect(
      renderApprovalDossier(
        {
          ...input,
          review_presentations: [contextOnlyPresentation("dossier")],
        },
        snapshot,
      ),
    ).rejects.toThrow(
      "review presentation target does not match a feedback target",
    );
    await expect(
      renderApprovalDossier({
        ...input,
        feedback_targets: undefined as unknown as readonly [],
      }),
    ).rejects.toThrow("feedback targets are required");
  });

  test("escapes feedback target metadata without treating it as browser authority", async () => {
    const input = fixture();
    const rendered = await renderApprovalDossier({
      ...input,
      feedback_targets: [
        {
          target: { target_type: "dossier" },
          label: "<review>",
          context: "Context & rationale",
          unresolved: false,
        },
      ],
      review_presentations: [contextOnlyPresentation("dossier")],
    });
    expect(rendered.html).toContain("&lt;review&gt;");
    expect(rendered.html).toContain("Context &amp; rationale");
    expect(rendered.html).toContain('data-unresolved="false"');
  });

  test("preserves protected candidate and exact Markdown payload when rendering", async () => {
    const input = fixture();
    const rendered = await renderApprovalDossier(input);
    const protectedResponse = extractProtectedApprovalPayload(rendered.html);
    expect(protectedResponse.candidate_sha256).toBe(
      input.approval.candidate_sha256,
    );
    expect(protectedResponse.files).toEqual(input.approval.files);
    expect(protectedResponse.feedback).toEqual([]);
    expect(protectedResponse.candidate.bundle_sha256).toBe(
      input.candidate.bundle_sha256,
    );
  });

  test("uses a deterministic candidate-bound response filename", () => {
    const { candidate } = fixture();
    expect(approvalResponseFilename(candidate, "approved")).toBe(
      `ideation-renderer-fixture-r0007-approved-${candidateSha256(candidate).slice(0, 12)}.html`,
    );
    expect(approvalResponseFilename(candidate, "approved")).toBe(
      approvalResponseFilename(candidate, "approved"),
    );
  });

  test("projects bounded native SVG beside an exact textual equivalent and retains fallback text", () => {
    const material = {
      visual_id: "bar-1",
      type: "bar" as const,
      title: "Evidence coverage",
      description: "Coverage by section.",
      units: "items",
      source_evidence_ids: ["E-1"],
      textual_equivalent: "Coverage by section\nScope: 3 items",
      data: { entries: [{ label: "Scope", value: 3 }] },
    };
    const visual: NativeVisual = {
      ...material,
      sha256: nativeVisualSha256(material),
    };
    const projected = projectNativeVisual(visual);
    expect(projected).toContain("<svg");
    expect(projected).toContain("<title");
    expect(projected).toContain("Source/evidence IDs: E-1");
    expect(projected).toContain("Coverage by section\nScope: 3 items");
    const fallback = projectNativeVisualFallback({
      ...visual,
      data: { entries: "invalid" },
    });
    expect(fallback).toContain("Native visual unavailable");
    expect(fallback).toContain("Coverage by section\nScope: 3 items");
  });

  test("emits a deterministic real-browser fixture without workflow authority", async () => {
    const first = await createApprovalDossierBrowserFixture();
    const second = await createApprovalDossierBrowserFixture();
    expect(first).toBe(second);
    expect(first).toContain("Approval dossier browser fixture");
    expect(first).toContain("Fixture coverage");
  });
});

test("rejects active renderer bytes that do not match their manifest", async () => {
  const input = fixture();
  const snapshot = await loadApprovalDossierRendererSnapshot();
  await expect(
    renderApprovalDossier(input, {
      ...snapshot,
      css: `${snapshot.css}\n/* mutation */`,
    }),
  ).rejects.toThrow(
    "renderer active bytes do not match manifest: templates/dossier.css",
  );
});

test("rejects a stale source-dependency hash even when the supplied manifest hash is self-consistent", async () => {
  const input = fixture();
  const snapshot = await loadApprovalDossierRendererSnapshot();
  const entries = snapshot.manifest.entries.map((entry) =>
    entry.path === "scripts/canonical-json.ts"
      ? { ...entry, sha256: "0".repeat(64) }
      : entry,
  );
  const manifest = { ...snapshot.manifest, entries };
  const staleSnapshot = {
    ...snapshot,
    manifest,
    sha256: new Bun.CryptoHasher("sha256")
      .update(canonicalJson(manifest))
      .digest("hex"),
  };
  await expect(renderApprovalDossier(input, staleSnapshot)).rejects.toThrow(
    "renderer dependency bytes do not match manifest: scripts/canonical-json.ts",
  );
});

test("derives canonical renderer identity from declared roots and every relative transitive dependency", async () => {
  const snapshot = await loadApprovalDossierRendererSnapshot();
  const paths = snapshot.manifest.entries.map((entry) => entry.path);
  expect(paths).toEqual([...paths].sort());
  for (const required of [
    "scripts/approval-dossier-renderer.ts",
    "scripts/approval-dossier-html.ts",
    "scripts/canonical-json.ts",
    "scripts/native-svg-projector.ts",
    "schemas/approval-dossier.ts",
    "templates/dossier.html",
    "templates/dossier.css",
    "templates/dossier.js",
  ])
    expect(paths).toContain(required);
  expect(snapshot.manifest.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
  expect((await loadApprovalDossierRendererSnapshot()).sha256).toBe(snapshot.sha256);
});

test("includes and rehashes every transitive static renderer dependency", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "approval-renderer-closure-"));
  await Promise.all([
    mkdir(join(runtimeRoot, "scripts"), { recursive: true }),
    mkdir(join(runtimeRoot, "schemas"), { recursive: true }),
    mkdir(join(runtimeRoot, "templates"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(runtimeRoot, "scripts/approval-dossier-renderer.ts"), 'import { intermediate } from "./intermediate.ts";\nexport const renderer = intermediate;\n'),
    writeFile(join(runtimeRoot, "scripts/intermediate.ts"), 'export { transitive } from "../schemas/transitive.ts";\n'),
    writeFile(join(runtimeRoot, "schemas/transitive.ts"), 'export const transitive = "original";\n'),
    writeFile(join(runtimeRoot, "templates/dossier.html"), "<main></main>\n"),
    writeFile(join(runtimeRoot, "templates/dossier.css"), "body {}\n"),
    writeFile(join(runtimeRoot, "templates/dossier.js"), "void 0;\n"),
  ]);
  const first = await loadApprovalDossierRendererSnapshotFromRuntimeRoot(runtimeRoot);
  const transitivePath = "schemas/transitive.ts";
  const firstEntry = first.manifest.entries.find((entry) => entry.path === transitivePath);
  expect(first.manifest.entries.map((entry) => entry.path)).toContain(transitivePath);
  await writeFile(join(runtimeRoot, transitivePath), 'export const transitive = "mutated";\n');
  const second = await loadApprovalDossierRendererSnapshotFromRuntimeRoot(runtimeRoot);
  const secondEntry = second.manifest.entries.find((entry) => entry.path === transitivePath);
  expect(secondEntry?.sha256).not.toBe(firstEntry?.sha256);
  expect(second.sha256).not.toBe(first.sha256);
});
