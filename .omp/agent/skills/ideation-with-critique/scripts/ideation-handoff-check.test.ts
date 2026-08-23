import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAuthoringFixture } from "./ideation-authoring-fixture.ts";
import { checkSavedIdeationAuthority, IDEATION_HANDOFF_RESULT_SCHEMA, parseHandoffCheckArguments, validateHandoffCheckResult } from "./ideation-handoff-check.ts";

const implementationRoot = resolve(import.meta.dir, "../../../../..");

describe("saved Ideation authority handoff checker", () => {
  test("accepts only the exact closed CLI", () => {
    expect(parseHandoffCheckArguments(["bun", "check", "--repository-root", "/tmp/runtime", "--artifact-manifest", "/tmp/artifact.json", "--output", "/tmp/result.json"])).toEqual({ repositoryRoot: "/tmp/runtime", artifactManifest: "/tmp/artifact.json", output: "/tmp/result.json" });
    expect(() => parseHandoffCheckArguments(["bun", "check", "--slug", "x", "--repository-root", "/tmp"])).toThrow("usage");
  });

  test("reopens saved authority and records protected currentness and replay rejections", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-check-"));
    const runtime = join(root, "runtime");
    const artifactManifest = join(root, "artifact-manifest.json");
    try {
      await createAuthoringFixture({ repositoryRoot: runtime, implementationRoot, fixture: ".omp/agent/skills/ideation-with-critique/fixtures/authoring-review-v8.json", submittedAt: "2026-08-12T12:00:00.000Z", artifactManifest });
      const result = await checkSavedIdeationAuthority({ repositoryRoot: runtime, artifactManifest, output: join(root, "handoff.json") });
      expect(result.schema).toBe(IDEATION_HANDOFF_RESULT_SCHEMA);
      expect(result.negative_scenarios).toEqual([
        { scenario: "replayed-state-currentness", artifact_manifest_sha256: result.artifact_manifest_sha256, protected_function_reached: true, rejected: true, rejection_stage: "saved-authority", rejection_code: "state-currentness" },
        { scenario: "replayed-candidate-currentness", artifact_manifest_sha256: result.artifact_manifest_sha256, protected_function_reached: true, rejected: true, rejection_stage: "saved-authority", rejection_code: "candidate-currentness" },
        { scenario: "replayed-response-binding", artifact_manifest_sha256: result.artifact_manifest_sha256, protected_function_reached: true, rejected: true, rejection_stage: "saved-authority", rejection_code: "response-binding" },
        { scenario: "replayed-receipt-binding", artifact_manifest_sha256: result.artifact_manifest_sha256, protected_function_reached: true, rejected: true, rejection_stage: "saved-authority", rejection_code: "receipt-binding" },
      ]);
      expect(result.negative_scenarios.map((scenario) => scenario.protected_function_reached)).toEqual([true, true, true, true]);
      expect(result.negative_scenarios.map((scenario) => scenario.rejection_code)).toEqual(["state-currentness", "candidate-currentness", "response-binding", "receipt-binding"]);
      expect(() => validateHandoffCheckResult({ ...result, negative_scenarios: [result.negative_scenarios[0]] })).toThrow("negative scenarios are incomplete");
      expect(() => validateHandoffCheckResult({ ...result, negative_scenarios: [{ ...result.negative_scenarios[0], protected_function_reached: false }, ...result.negative_scenarios.slice(1)] })).toThrow("invalid negative scenario");
      expect(() => validateHandoffCheckResult({ ...result, negative_scenarios: [{ ...result.negative_scenarios[0], rejection_code: "receipt-binding" }, ...result.negative_scenarios.slice(1)] })).toThrow("invalid negative scenario");
      const markdownPath = join(runtime, result.markdown.path);
      const markdown = await readFile(markdownPath);
      await writeFile(markdownPath, "replayed content");
      await expect(checkSavedIdeationAuthority({ repositoryRoot: runtime, artifactManifest, output: join(root, "tampered.json") })).rejects.toThrow("artifact binding mismatch");
      await writeFile(markdownPath, markdown);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
