import { describe, expect, it } from "bun:test";

const solutionSkill = await Bun.file(new URL("../SKILL.md", import.meta.url)).text();
const orchestrationSkill = await Bun.file(
  new URL("../../agent-orchestration-guide/SKILL.md", import.meta.url),
).text();
const routingContract = await Bun.file(
  new URL("../references/agent-routing-and-result-contract.md", import.meta.url),
).text();

function expectAll(text, required) {
  for (const fragment of required) {
    expect(text).toContain(fragment);
  }
}

describe("coverage-driven concurrency contract", () => {
  it("keeps runtime concurrency separate from workflow task selection", () => {
    expectAll(orchestrationSkill, [
      "Batch independent, prerequisite-ready assignments together within the active concurrency limit.",
      "Do not manufacture slices or serialize work that can safely proceed concurrently.",
    ]);
    expectAll(routingContract, [
      "There is no fixed roster, universal anchor, mandatory task-count floor, or workflow-specific concurrency ceiling here.",
      "A logical wave is the phase's frozen set of prerequisite-ready assignments; runtime concurrency schedules that set.",
    ]);
  });

  it("rejects the former fixed-role and fixed-count attractors", () => {
    const combined = `${solutionSkill}\n${orchestrationSkill}\n${routingContract}`;
    const prohibited = [
      "outcome-correctness and measurement specialist",
      "failure-risk, lifecycle-cost, simplicity, and operations specialist",
      "both core perspectives",
      "mandatory three-to-four-agent",
      "three-to-five agents",
      "up to two distinct specialized roles",
      "batches with at most two independent tasks",
      "run no more than two worker tasks at once",
      "Concurrent worker tasks | 2",
      "Concurrent worker tasks per dispatch wave | 4",
    ];

    for (const fragment of prohibited) {
      expect(combined).not.toContain(fragment);
    }
  });

  it("selects the smallest live-roster set that covers material obligations", () => {
    expectAll(solutionSkill, [
      "build a provisional domain inventory",
      "Mark each inventory item `material`, `not-material`, or `unknown`.",
      "Use one common coverage-selection policy for every agent-backed phase",
      "Select the smallest justified task set that satisfies all material obligations",
      "Recompute the roster at each wave; do not preserve a fixed eligible-agent pool.",
      "run all prerequisite-ready independent tasks in one Task call",
    ]);
  });
});

describe("worker artifact and provenance contract", () => {
  it("uses collision-safe phase paths for every worker-produced artifact", () => {
    expectAll(solutionSkill, [
      "`criteria/<stable-task-id>/<stable-slice-id>.md`",
      "`fast-path-validation/<stable-task-id>/<stable-slice-id>.md`",
      "`hypotheses/wave-<n>/<stable-task-id>/<stable-slice-id>.md`",
      "`dfs/<candidate-id>/<stable-task-id>/<stable-slice-id>.md`",
      "`selection-quorum/<stable-task-id>/<stable-slice-id>.md`",
      "`critique/round-<n>/<stable-task-id>/<stable-slice-id>.md`",
    ]);
    expect(solutionSkill).not.toMatch(/`(?:criteria|fast-path-validation|selection-quorum)\/<role>\.md`/);
    expect(solutionSkill).not.toContain("`critique/round-<n>-<role>.md`");
  });

  it("materializes exact worker bytes and stores runtime provenance only in the execution report", () => {
    expectAll(solutionSkill, [
      "The artifact bytes are exactly the UTF-8 bytes of the returned `markdown_body`; no additional bytes or transformations are permitted.",
      "recorded only in the `execution-report.md` manifest",
      "canonical candidate synthesis is separately parent-authored",
      "materialize the validated bytes exactly at `criteria/<stable-task-id>/<stable-slice-id>.md`",
    ]);
    expectAll(routingContract, [
      "The materializer MUST NOT trim the body, normalize newlines, prepend or append metadata, add wrappers, or apply parent edits.",
      "Do not create a sidecar, wrapper-based artifact hash, or second artifact representation.",
      "No result may be used semantically before this state.",
    ]);
  });

  it("preflights conflicts before materialization and accepts only after verification", () => {
    expectAll(solutionSkill, [
      "MUST pass destination preflight before materialization",
      "Before any write, compute the canonical byte length and hash and preflight",
      "conflicts without writing or overwriting anything",
      "If preflight permits a collision-free create-if-absent write",
      "Verify the destination bytes and manifest after that write or no-op.",
      "Mark the result `accepted` only after this verification succeeds.",
    ]);
    expectAll(routingContract, [
      "`planned -> dispatched -> identity-verified -> payload-validated -> destination-preflighted -> materialized -> accepted`",
      "A different-byte, identity, reservation, duplicate, or path conflict stops before any write.",
      "an atomic create-if-absent write succeeded",
      "record the conflict before materialization and do not write, overwrite, merge, or choose silently",
    ]);
    expect(solutionSkill).not.toContain("exact materialization, and conflict checks");
    expect(solutionSkill).not.toContain("Materialize each accepted result");
    expect(solutionSkill).not.toContain("require each accepted result to materialize");
  });

  it("keeps findings immutable and dispositions parent-authored", () => {
    expectAll(solutionSkill, [
      "Critics report findings and pass assessments only; they do not reject, fix, accept risk for, dispose, or close their own findings.",
      "The parent alone records each finding disposition",
      "Original critic artifacts and accepted worker artifacts remain immutable.",
    ]);
    expect(solutionSkill).not.toContain("evidence-backed findings with severity and disposition");
    expect(solutionSkill).not.toContain("synthesize `criteria/` artifacts with immutable contribution references");
  });

  it("separates assignment, accepted analysis, and evidence sufficiency", () => {
    expectAll(solutionSkill, [
      "assignment coverage, accepted returned-analysis coverage, and evidence sufficiency",
      "A returned result that is not accepted or not materialized is not coverage and remains a gap.",
      "Only unique accepted materialized worker artifacts count as returned analysis",
    ]);
  });
});
