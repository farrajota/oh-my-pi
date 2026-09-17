import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateSimplificationDisposition,
  validateSimplificationDispositionContent,
  type ContentValidationInput,
} from "./validate-simplification-disposition";

const topicId = "simplification-review-abcdef123456";
const frameRevision = "r1";
const candidateId = "baseline";
const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "simplification-disposition-"));
const canonicalPath = join(root, "ai_docs", "research", `${topicId}.md`);

const baseBlock = {
  schema_version: 1,
  topic_id: topicId,
  frame_revision: frameRevision,
  candidate_id: candidateId,
  disposition: "NO_SIMPLER_CHANGE",
  recheck_categories: ["mechanism"],
};

type Block = Record<string, unknown>;

function blockText(block: Block = baseBlock): string {
  return [
    "### Simplification disposition",
    "```json",
    JSON.stringify(block, null, 2),
    "```",
  ].join("\n");
}

function input(artifactText: string, overrides: Partial<ContentValidationInput> = {}): ContentValidationInput {
  return {
    artifactPath: canonicalPath,
    artifactText,
    expectedTopicId: topicId,
    expectedFrameRevision: frameRevision,
    expectedCandidateId: candidateId,
    changedCategories: [],
    ...overrides,
  };
}

beforeAll(async () => {
  await mkdir(join(root, "ai_docs", "research"), { recursive: true });
  await writeFile(canonicalPath, blockText(), "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("closed simplification disposition schema contract", () => {
  it("requires version 1 and the six closed fields", async () => {
    const schema = await Bun.file(new URL("../references/simplification-disposition.schema.json", import.meta.url)).json();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schema_version.const).toBe(1);
    expect(schema.required).toEqual([
      "schema_version",
      "topic_id",
      "frame_revision",
      "candidate_id",
      "disposition",
      "recheck_categories",
    ]);
    expect(schema.properties.recheck_categories.uniqueItems).toBe(true);
    expect(schema.properties.topic_id.pattern).toContain("[0-9]{8}T[0-9]{6}Z");
    expect(schema.properties.topic_id.pattern).toContain("-20");
  });
});

describe("full and STANDARD_FAST_PATH success fixtures", () => {
  it("accepts a completed full-path artifact", () => {
    const result = validateSimplificationDispositionContent(
      input(`# Full solution\n\n## Simplicity and cost challenge\n\n${blockText()}`),
    );
    expect(result).toEqual({ status: "current" });
  });

  it("accepts a completed STANDARD_FAST_PATH artifact", () => {
    const result = validateSimplificationDispositionContent(
      input(`# Fast solution\n\n## Simplest baseline and bounded alternative scan\n\n${blockText({ ...baseBlock, disposition: "SCRIPT_COMPONENT_ONLY" })}`),
    );
    expect(result).toEqual({ status: "current" });
  });

  it.each([
    "simplification-review-abcdef123456-20260831T123456Z",
    "simplification-review-abcdef123456-20",
  ])("accepts canonical collided topic path %s", (collidedTopicId) => {
    const collidedPath = join(root, "ai_docs", "research", `${collidedTopicId}.md`);
    const result = validateSimplificationDispositionContent(
      input(blockText({ ...baseBlock, topic_id: collidedTopicId }), {
        artifactPath: collidedPath,
        expectedTopicId: collidedTopicId,
      }),
    );
    expect(result).toEqual({ status: "current" });
  });

  it.each([
    "simplification-review-abcdef123456-21",
    "simplification-review-abcdef123456-20260831T123456",
    "simplification-review-abcdef123456-20260831123456Z",
  ])("rejects malformed collided topic path %s", (collidedTopicId) => {
    const collidedPath = join(root, "ai_docs", "research", `${collidedTopicId}.md`);
    const result = validateSimplificationDispositionContent(
      input(blockText({ ...baseBlock, topic_id: collidedTopicId }), {
        artifactPath: collidedPath,
        expectedTopicId: collidedTopicId,
      }),
    );
    expect(result).toMatchObject({ status: "invalid" });
  });

  it("accepts a canonical artifact through the file-backed API", async () => {
    await writeFile(canonicalPath, blockText(), "utf8");
    const result = await validateSimplificationDisposition({
      artifactPath: canonicalPath,
      expectedTopicId: topicId,
      expectedFrameRevision: frameRevision,
      expectedCandidateId: candidateId,
      changedCategories: [],
    });
    expect(result).toEqual({ status: "current" });
  });

  it("marks a valid produced disposition stale after a later relevant change", () => {
    const result = validateSimplificationDispositionContent(
      input(blockText(), { changedCategories: ["mechanism"] }),
    );
    expect(result).toEqual({ status: "stale" });
  });

  it("stays current when later changes do not intersect future rechecks", () => {
    const result = validateSimplificationDispositionContent(
      input(blockText(), { changedCategories: ["correctness"] }),
    );
    expect(result).toEqual({ status: "current" });
  });
});

describe("block shape and identity failures", () => {
  it("rejects a missing block", () => {
    expect(validateSimplificationDispositionContent(input("# Final solution"))).toMatchObject({ status: "invalid" });
  });

  it("rejects duplicate blocks", () => {
    expect(validateSimplificationDispositionContent(input(`${blockText()}\n\n${blockText()}`))).toMatchObject({ status: "invalid" });
  });

  it("rejects malformed JSON", () => {
    const malformed = "### Simplification disposition\n```json\n{not-json}\n```";
    expect(validateSimplificationDispositionContent(input(malformed))).toMatchObject({ status: "invalid" });
  });

  it("rejects a noncanonical artifact path", () => {
    expect(
      validateSimplificationDispositionContent(
        input(blockText(), { artifactPath: join(root, "ai_docs", "artifacts", "research", `${topicId}.md`) }),
      ),
    ).toMatchObject({ status: "invalid" });
  });

  it("rejects path and expected topic mismatch", () => {
    expect(
      validateSimplificationDispositionContent(
        input(blockText(), { expectedTopicId: "different-topic-abcdef123456" }),
      ),
    ).toMatchObject({ status: "invalid" });
  });

  it.each([
    ["topic_id", { topic_id: "different-topic-abcdef123456" }],
    ["frame_revision", { frame_revision: "r2" }],
    ["candidate_id", { candidate_id: "alternative" }],
  ])("rejects disposition %s identity mismatch", (_field, patch) => {
    expect(validateSimplificationDispositionContent(input(blockText({ ...baseBlock, ...patch })))).toMatchObject({ status: "invalid" });
  });
});

describe("closed properties, enums, and category sets", () => {
  it("rejects unknown properties", () => {
    expect(validateSimplificationDispositionContent(input(blockText({ ...baseBlock, extra: true })))).toMatchObject({ status: "invalid" });
  });

  it("rejects unknown disposition values", () => {
    expect(validateSimplificationDispositionContent(input(blockText({ ...baseBlock, disposition: "SIMPLIFY" })))).toMatchObject({ status: "invalid" });
  });

  it("rejects unknown recheck categories", () => {
    expect(validateSimplificationDispositionContent(input(blockText({ ...baseBlock, recheck_categories: ["lifecycle"] })))).toMatchObject({ status: "invalid" });
  });

  it("rejects duplicate recheck categories", () => {
    expect(validateSimplificationDispositionContent(input(blockText({ ...baseBlock, recheck_categories: ["mechanism", "mechanism"] })))).toMatchObject({ status: "invalid" });
  });

  it("rejects duplicate caller changed categories", () => {
    expect(
      validateSimplificationDispositionContent(input(blockText(), { changedCategories: ["mechanism", "mechanism"] })),
    ).toMatchObject({ status: "invalid" });
  });

  it("rejects unknown caller changed categories", () => {
    expect(
      validateSimplificationDispositionContent(input(blockText(), { changedCategories: ["lifecycle"] })),
    ).toMatchObject({ status: "invalid" });
  });
});
