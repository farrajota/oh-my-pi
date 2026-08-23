import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashRawBytes } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { createAuthoringFixture, IDEATION_AUTHORING_ARTIFACT_MANIFEST_SCHEMA, materializeAuthoringPassState, parseAuthoringFixtureArguments } from "./ideation-authoring-fixture.ts";

const implementationRoot = resolve(import.meta.dir, "../../../../..");
const fixture = ".omp/agent/skills/ideation-with-critique/fixtures/authoring-review-v8.json";

describe("authoring fixture harness", () => {
  test("parses exactly the closed CLI flags", () => {
    expect(parseAuthoringFixtureArguments(["bun", "fixture", "--repository-root", "/tmp/runtime", "--implementation-root", implementationRoot, "--fixture", fixture, "--submitted-at", "2026-08-12T12:00:00.000Z", "--artifact-manifest", "/tmp/artifact-manifest.json"])).toMatchObject({ repositoryRoot: "/tmp/runtime", implementationRoot, fixture });
    expect(() => parseAuthoringFixtureArguments(["bun", "fixture"])).toThrow("usage");
    expect(() => parseAuthoringFixtureArguments(["bun", "fixture", "--repository-root", "/tmp/runtime", "--implementation-root", "/workspace", "--fixture", fixture, "--submitted-at", "2026-08-12", "--artifact-manifest", "/tmp/a.json"])).toThrow("RFC 3339");
  });

  test("materializes a verifier-admitted PASS with governed four-option presentations", async () => {
    const raw = JSON.parse(await readFile(join(implementationRoot, fixture), "utf8"));
    const state = materializeAuthoringPassState(raw);
    expect(state.readiness.status).toBe("ready-for-approval");
    expect(state.final_document_review.rounds[0]?.results.every((result) => result.verdict === "PASS")).toBe(true);
    expect(state.review_item_presentations.map((item) => item.semantic_id)).toEqual(["A1", "C1", "D1", "G1", "U1"]);
    expect(state.review_item_presentations.every((item) => item.options.length === 4 && item.options.some((option) => option.option_id === item.recommended_option_id))).toBe(true);
  });

  test("creates a closed hash-bound manifest and rejects root reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "authoring-fixture-"));
    const runtime = join(root, "runtime");
    const manifestPath = join(root, "artifact-manifest.json");
    try {
      const manifest = await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath });
      expect(manifest.schema).toBe(IDEATION_AUTHORING_ARTIFACT_MANIFEST_SCHEMA);
      const saved = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(Object.keys(saved).sort()).toEqual(["artifact_byte_counts", "candidate", "command_version", "fixture", "protected", "renderer", "schema", "state", "support", "workspace"]);
      const artifacts = [saved.state.current, saved.state.snapshot, saved.support.record, saved.support.html, saved.workspace.path, saved.workspace.baseline_record, saved.workspace.checkpoint_record, saved.workspace.workspace_issuance_record, saved.workspace.source_response_record, saved.workspace.initial_saved_workspace_evidence, saved.workspace.overwritten_saved_workspace_evidence, saved.workspace.admitted_response_record, saved.workspace.continuation_checkpoint_record, saved.workspace.continuation_issuance_record, saved.workspace.rebase_workspace_issuance_record, saved.workspace.rebase_admitted_response_record, saved.candidate.submission, saved.candidate.current, saved.candidate.record, saved.candidate.html, saved.candidate.response, saved.candidate.approved_html, saved.candidate.publication_markdown, saved.candidate.publication_receipt, saved.candidate.substantive_review_authority, saved.candidate.handoff.substantive_review_authority];
      for (const artifact of artifacts) {
        expect(artifact.path.startsWith("/")).toBe(false);
        expect(hashRawBytes(await readFile(join(runtime, artifact.path)))).toBe(artifact.sha256);
      }
      expect(saved.schema).toBe("ideation-authoring/artifact-manifest/v3");
      expect(saved.fixture.path).toBe("farrajota-oh-my-pi/.omp/agent/skills/ideation-with-critique/fixtures/authoring-review-v8.json");
      expect(saved.command_version).toBe("ideation-authoring-fixture/v3");
      expect(saved.workspace.unchanged_save.outcome).toBe("adopted-identical");
      expect(saved.workspace.canonical_before_sha256).toBe(saved.workspace.canonical_after_sha256);
      expect(saved.workspace.protected_tamper_rejected).toBe(true);
      expect(saved.workspace.rebase_imported).toBe(true);
      const admitted = JSON.parse(await readFile(join(runtime, saved.workspace.admitted_response_record.path), "utf8"));
      expect(Object.keys(admitted).sort()).toEqual(["baseline_record_path", "baseline_record_sha256", "checkpoint_record_path", "checkpoint_record_sha256", "dossier_id", "occurrence_inventory", "occurrence_inventory_sha256", "predecessor_imported_response_sha256", "response_items", "saved_workspace_evidence_record_path", "saved_workspace_evidence_record_sha256", "saved_workspace_snapshot_path", "saved_workspace_snapshot_sha256", "schema", "source_response_record_path", "source_response_record_sha256", "workspace_issuance_record_path", "workspace_issuance_record_sha256", "workspace_raw_sha256", "workspace_revision"]);
      expect(admitted.workspace_raw_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(admitted.response_items[0].answer_text).toContain("overwrite");
      expect(saved.candidate.substantive_review_authority.path).toBe(saved.candidate.handoff.substantive_review_authority.path);
      expect(saved.candidate.substantive_review_authority.sha256).toBe(saved.candidate.handoff.substantive_review_authority.sha256);
      await writeFile(join(runtime, saved.candidate.html.path), "tampered");
      expect(hashRawBytes(await readFile(join(runtime, saved.candidate.html.path)))).not.toBe(saved.candidate.html.sha256);
      await expect(createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: join(root, "second.json") })).rejects.toThrow("fresh");
      await expect(createAuthoringFixture({ repositoryRoot: join(root, "other-runtime"), implementationRoot, fixture, submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest: manifestPath })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
