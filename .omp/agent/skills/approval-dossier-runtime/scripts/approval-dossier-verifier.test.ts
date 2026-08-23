import { describe, expect, test } from "bun:test";
import {
  APPROVAL_DECLARATION,
  type ApprovalResponse,
  type CandidateBinding,
  visualSetSha256,
} from "../schemas/approval-dossier.ts";
import { renderApprovalDossier } from "./approval-dossier-renderer.ts";
import {
  createApprovalResponse,
  createCandidateBinding,
  createMarkdownFileRecord,
  encodeProtectedApprovalPayload,
  verifyApprovedImportedHtml,
  verifyImportedHtml,
} from "./approval-dossier-runtime.ts";
import { hashRawBytes } from "./canonical-json.ts";

const HASH_A = "a".repeat(64);
const HASH_C = "c".repeat(64);
const EMPTY_VISUAL_SET_SHA256 = visualSetSha256([]);

interface RenderedFixture {
  readonly candidate: CandidateBinding;
  readonly approval: ApprovalResponse;
  readonly html: string;
  readonly candidate_html: string;
  readonly markdown: Uint8Array;
}

async function renderedFixture(
  status: "draft" | "changes-requested" | "approved" | "rejected" = "approved",
): Promise<RenderedFixture> {
  const markdown = Buffer.from(
    "# Plan\n\nExact <Markdown> & evidence.\n",
    "utf8",
  );
  const candidate = createCandidateBinding({
    workflow: "ideation",
    run_id: "run-1",
    revision: 1,
    semantic_sha256: HASH_A,
    files: [createMarkdownFileRecord("docs/plan.md", markdown)],
    visual_set_sha256: EMPTY_VISUAL_SET_SHA256,
    runtime_sha256: HASH_C,
    review_authority_sha256: HASH_A,
    predecessors: [],
  });
  const baselineApproval = createApprovalResponse({
    candidate,
    approval_status: "draft",
    approval_actor: "reviewer",
    submitted_at: "2026-08-03T00:00:00Z",
    approved_at: null,
    declaration: APPROVAL_DECLARATION,
    files: [{ path: "docs/plan.md", bytes: markdown }],
    feedback: [],
  });
  const approval = createApprovalResponse({
    candidate,
    approval_status: status,
    approval_actor: "reviewer",
    submitted_at: "2026-08-03T00:00:00Z",
    approved_at: status === "approved" ? "2026-08-03T00:01:00Z" : null,
    declaration: APPROVAL_DECLARATION,
    files: [{ path: "docs/plan.md", bytes: markdown }],
    feedback:
      status === "changes-requested"
        ? [
            {
              feedback_id: "feedback-1",
              kind: "edit",
              target: { target_type: "semantic-id", semantic_id: "decision-1" },
              requested_change: "Clarify the decision.",
              rationale: "The decision requires an explicit explanation.",
              evidence_ids: ["evidence-1"],
            },
          ]
        : [],
  });
  const renderedCandidate = await renderApprovalDossier({
    title: "Saved approval dossier",
    candidate,
    approval: baselineApproval,
    visual_set: {
      schema: "approval-dossier/visual-set/v1",
      visual_set_sha256: EMPTY_VISUAL_SET_SHA256,
      visuals: [],
    },
    visuals: [],
    feedback_targets: [],
    review_presentations: [],
  });
  const html = renderedCandidate.html.replace(
    encodeProtectedApprovalPayload(baselineApproval),
    encodeProtectedApprovalPayload(approval),
  );
  return {
    candidate,
    approval,
    html,
    candidate_html: renderedCandidate.html,
    markdown,
  };
}

function context(fixture: RenderedFixture) {
  return {
    candidate_html: fixture.candidate_html,
    review_authority_sha256: fixture.candidate.review_authority_sha256,
  };
}

describe("saved HTML verifier", () => {
  test("accepts renderer-produced exact protected JSON and visible Markdown", async () => {
    const fixture = await renderedFixture();
    const verified = verifyImportedHtml(
      Buffer.from(fixture.html),
      fixture.candidate,
      {
        candidate_html: Buffer.from(fixture.candidate_html),
        review_authority_sha256: fixture.candidate.review_authority_sha256,
      },
    );
    expect(verified.document_sha256).toBe(
      hashRawBytes(Buffer.from(fixture.html)),
    );
    expect(Buffer.from(verified.markdown_files[0]?.bytes ?? [])).toEqual(
      fixture.markdown,
    );
    expect(
      verifyApprovedImportedHtml(
        fixture.html,
        fixture.candidate,
        context(fixture),
      ).approval,
    ).toEqual(fixture.approval);
  });

  test("imports every renderer-produced contract-valid response state", async () => {
    for (const status of ["draft", "changes-requested", "rejected"] as const) {
      const fixture = await renderedFixture(status);
      expect(
        verifyImportedHtml(fixture.html, fixture.candidate, context(fixture))
          .approval.approval_status,
      ).toBe(status);
      expect(() =>
        verifyApprovedImportedHtml(
          fixture.html,
          fixture.candidate,
          context(fixture),
        ),
      ).toThrow("APPROVAL_NOT_GRANTED");
    }
  });

  test("accepts a browser-style saved response that changes only the protected payload", async () => {
    const fixture = await renderedFixture("draft");
    const changed = createApprovalResponse({
      candidate: fixture.candidate,
      approval_status: "changes-requested",
      approval_actor: fixture.approval.approval_actor,
      submitted_at: fixture.approval.submitted_at,
      approved_at: null,
      files: [{ path: "docs/plan.md", bytes: fixture.markdown }],
      feedback: [
        {
          feedback_id: "feedback-1",
          kind: "edit",
          target: { target_type: "semantic-id", semantic_id: "decision-1" },
          requested_change: "Clarify the decision.",
          rationale: "The decision requires an explicit explanation.",
          evidence_ids: ["evidence-1"],
        },
      ],
    });
    const saved = fixture.html.replace(
      encodeProtectedApprovalPayload(fixture.approval),
      encodeProtectedApprovalPayload(changed),
    );
    expect(
      verifyImportedHtml(saved, fixture.candidate, context(fixture)).approval,
    ).toEqual(changed);
  });

  test("requires the exact no-feedback draft candidate baseline", async () => {
    const fixture = await renderedFixture();
    expect(() =>
      verifyImportedHtml(
        fixture.html,
        fixture.candidate,
        undefined as unknown as {
          candidate_html: string;
          review_authority_sha256: string;
        },
      ),
    ).toThrow("DOSSIER_ENVELOPE_INVALID:candidate_html");
    expect(() =>
      verifyImportedHtml(fixture.html, fixture.candidate, {
        candidate_html: fixture.html,
        review_authority_sha256: fixture.candidate.review_authority_sha256,
      }),
    ).toThrow("DOSSIER_ENVELOPE_INVALID:candidate_html");
  });

  test("rejects hand-built, CSP-modified, and active-content wrappers before payload retention", async () => {
    const fixture = await renderedFixture();
    const payload =
      fixture.html.match(
        /<template id="approval-dossier-protected-state"[\s\S]*?<\/template>/,
      )?.[0] ?? "";
    const visible =
      fixture.html.match(
        /<pre data-approval-dossier-visible-markdown[\s\S]*?<\/pre>/,
      )?.[0] ?? "";
    const cases = [
      `<!doctype html><html><body>${payload}${visible}</body></html>`,
      fixture.html.replace("default-src 'none'", "default-src *"),
      fixture.html.replace(
        "</body>",
        "<script>globalThis.pwned = true</script></body>",
      ),
      fixture.html.replace(
        '<main id="dossier"',
        '<main id="dossier" onclick="globalThis.pwned = true"',
      ),
      fixture.html.replace(
        "</body>",
        '<a href="https://attacker.invalid">outside</a></body>',
      ),
    ];
    for (const html of cases)
      expect(() =>
        verifyImportedHtml(html, fixture.candidate, context(fixture)),
      ).toThrow("DOSSIER_ENVELOPE_INVALID");
  });

  test("rejects every non-payload byte drift, including inert UI additions", async () => {
    const fixture = await renderedFixture();
    const cases = [
      fixture.html.replace("</title>", "</title><title>Injected title</title>"),
      fixture.html.replace("</body>", "</body><body>Injected body</body>"),
      fixture.html.replace(
        "</body>",
        "<dialog>Injected dialog</dialog></body>",
      ),
      fixture.html.replace(
        "</body>",
        '<svg aria-label="Injected SVG"><title>Injected SVG</title></svg></body>',
      ),
    ];
    for (const html of cases)
      expect(() =>
        verifyImportedHtml(html, fixture.candidate, context(fixture)),
      ).toThrow("DOSSIER_ENVELOPE_INVALID:envelope");
  });

  test("rejects residual meta tags case-insensitively", async () => {
    const fixture = await renderedFixture();
    for (const tag of [
      '<meta http-equiv="refresh" content="0; url=https://attacker.invalid">',
      '<META HTTP-EQUIV="REFRESH" CONTENT="0; url=https://attacker.invalid">',
      '<mEtA hTtP-EqUiV="ReFrEsH" cOnTeNt="0; url=https://attacker.invalid">',
    ]) {
      const html = fixture.html.replace("</head>", `${tag}\n</head>`);
      expect(() =>
        verifyImportedHtml(html, fixture.candidate, context(fixture)),
      ).toThrow("DOSSIER_ENVELOPE_INVALID");
    }
  });

  test("rejects protected payload and candidate-envelope drift", async () => {
    const fixture = await renderedFixture();
    expect(() =>
      verifyImportedHtml(
        fixture.html.replace(
          'base64-canonical-json">',
          'base64-canonical-json">X',
        ),
        fixture.candidate,
        context(fixture),
      ),
    ).toThrow("PROTECTED_PAYLOAD_INVALID");
    expect(() =>
      verifyImportedHtml(
        fixture.html.replace("<noscript>", "<aside>"),
        fixture.candidate,
        context(fixture),
      ),
    ).toThrow("DOSSIER_ENVELOPE_INVALID");
    const differentCandidate = createCandidateBinding({
      ...fixture.candidate,
      revision: 2,
    });
    expect(() =>
      verifyImportedHtml(fixture.html, differentCandidate, context(fixture)),
    ).toThrow("CANDIDATE_MISMATCH");
  });
});
