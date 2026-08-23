import { constants } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { canonicalJson, hashRawBytes } from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { publicationReceiptSha256 } from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import { createDeepScopeHandoffFromSavedAuthority, validateDeepScopeHandoff } from "./ideation-runtime.ts";
import type { DeepScopeHandoff } from "./ideation-runtime.ts";

export const IDEATION_HANDOFF_RESULT_SCHEMA = "ideation-authoring/handoff-result/v3" as const;
export interface HandoffCheckArguments { readonly repositoryRoot: string; readonly artifactManifest: string; readonly output: string }
export interface FileBinding { readonly path: string; readonly sha256: string; readonly byte_count: number }
interface AuthorityBinding { readonly path: string; readonly sha256: string }
export interface HandoffNegativeScenario {
  readonly scenario: "replayed-state-currentness" | "replayed-candidate-currentness" | "replayed-response-binding" | "replayed-receipt-binding";
  readonly artifact_manifest_sha256: string;
  readonly protected_function_reached: true;
  readonly rejected: true;
  readonly rejection_stage: "saved-authority";
  readonly rejection_code: "state-currentness" | "candidate-currentness" | "response-binding" | "receipt-binding";
}
export interface HandoffCheckResult { readonly schema: typeof IDEATION_HANDOFF_RESULT_SCHEMA; readonly artifact_manifest_sha256: string; readonly state_current: FileBinding; readonly state_snapshot: FileBinding; readonly current_candidate: FileBinding; readonly response: FileBinding; readonly markdown: FileBinding; readonly receipt: FileBinding; readonly handoff: DeepScopeHandoff; readonly negative_scenarios: readonly [HandoffNegativeScenario, HandoffNegativeScenario, HandoffNegativeScenario, HandoffNegativeScenario] }

export function parseHandoffCheckArguments(argv: readonly string[]): HandoffCheckArguments {
  if (argv.length !== 8 || argv[2] !== "--repository-root" || argv[4] !== "--artifact-manifest" || argv[6] !== "--output" || argv[3] === undefined || argv[5] === undefined || argv[7] === undefined) throw new TypeError("usage: --repository-root <path> --artifact-manifest <path> --output <path>");
  return Object.freeze({ repositoryRoot: argv[3], artifactManifest: argv[5], output: argv[7] });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function artifact(value: unknown, name: string): FileBinding {
  const entry = object(value, name);
  const keys = Object.keys(entry).sort();
  if (keys.join("\0") !== ["byte_count", "path", "sha256"].join("\0") || typeof entry.path !== "string" || !/^[0-9a-f]{64}$/.test(String(entry.sha256)) || !Number.isInteger(entry.byte_count)) throw new TypeError(`${name} is not a closed artifact binding`);
  return Object.freeze({ path: entry.path, sha256: String(entry.sha256), byte_count: entry.byte_count as number });
}
function parseManifest(value: unknown) {
  const manifest = object(value, "artifact manifest");
  const keys = Object.keys(manifest).sort();
  const baseExpected = ["artifact_byte_counts", "candidate", "command_version", "fixture", "protected", "renderer", "schema", "state", "support"].sort();
  const schema = manifest.schema;
  const isV1 = schema === "ideation-authoring/artifact-manifest/v1";
  const isV2 = schema === "ideation-authoring/artifact-manifest/v2";
  const isV3 = schema === "ideation-authoring/artifact-manifest/v3";
  const expected = isV3 ? [...baseExpected, "workspace"].sort() : baseExpected;
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) || (!isV1 && !isV2 && !isV3)) throw new TypeError("artifact manifest has invalid closed shape");
  const state = object(manifest.state, "artifact manifest state");
  const candidate = object(manifest.candidate, "artifact manifest candidate");
  const candidateKeys = isV1 ? ["approved_html", "candidate_sha256", "current", "handoff", "html", "publication_markdown", "publication_receipt", "record", "response", "submission"] : ["approved_html", "candidate_sha256", "current", "handoff", "html", "publication_markdown", "publication_receipt", "record", "response", "submission", "substantive_review_authority"];
  if (Object.keys(state).sort().join("\0") !== ["current", "sha256", "snapshot"].join("\0") || Object.keys(candidate).sort().join("\0") !== candidateKeys.sort().join("\0")) throw new TypeError("artifact manifest nested shape is not closed");
  const handoff = validateDeepScopeHandoff(candidate.handoff);
  const authority = Object.freeze({ path: handoff.substantive_review_authority.path, sha256: handoff.substantive_review_authority.sha256 });
  if (!isV1) {
    const explicit = artifact(candidate.substantive_review_authority, "substantive review authority");
    if (explicit.path !== authority.path || explicit.sha256 !== authority.sha256) throw new TypeError("artifact manifest authority binding mismatch");
  }
  return Object.freeze({ state_current: artifact(state.current, "state current"), state_snapshot: artifact(state.snapshot, "state snapshot"), current_candidate: artifact(candidate.current, "current candidate"), response: artifact(candidate.response, "response"), markdown: artifact(candidate.publication_markdown, "markdown"), receipt: artifact(candidate.publication_receipt, "receipt"), authority, handoff });
}
function slugFromStatePath(path: string): string {
  const matched = /^ai_docs\/ideation\/([a-z0-9]+(?:-[a-z0-9]+)*)\.state\.json$/.exec(path);
  if (matched === null) throw new TypeError("artifact manifest has noncanonical current state path");
  return matched[1]!;
}
async function rehash(repositoryRoot: string, binding: FileBinding): Promise<FileBinding> {
  if (binding.path.startsWith("/") || binding.path.includes("\\") || binding.path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new TypeError(`invalid repository-relative path: ${binding.path}`);
  const bytes = await readFile(`${repositoryRoot}/${binding.path}`);
  if (hashRawBytes(bytes) !== binding.sha256 || bytes.byteLength !== binding.byte_count) throw new TypeError(`artifact binding mismatch: ${binding.path}`);
  return binding;
}
async function rehashAuthority(repositoryRoot: string, binding: AuthorityBinding): Promise<void> {
  if (binding.path.startsWith("/") || binding.path.includes("\\") || binding.path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new TypeError(`invalid repository-relative path: ${binding.path}`);
  if (hashRawBytes(await readFile(`${repositoryRoot}/${binding.path}`)) !== binding.sha256) throw new TypeError(`authority binding mismatch: ${binding.path}`);
}

async function savedAuthorityMustReject(
  repositoryRoot: string,
  slug: string,
  scenario: HandoffNegativeScenario["scenario"],
  artifactManifestSha256: string,
): Promise<HandoffNegativeScenario> {
  const expectedRejection = scenario === "replayed-state-currentness"
    ? /mutable head is rolled back from immutable lineage tip/
    : scenario === "replayed-candidate-currentness"
      ? /current candidate state is stale/
      : scenario === "replayed-response-binding"
        ? /response import current candidate binding mismatch/
        : /publication receipt|receipt.*mismatch|HASH_MISMATCH|EXPECTED_MISMATCH/i;
  try {
    await createDeepScopeHandoffFromSavedAuthority({ repository_root: repositoryRoot, slug });
  } catch (error) {
    if (!(error instanceof Error) || !expectedRejection.test(error.message))
      throw new TypeError(`negative scenario rejected before saved authority: ${scenario}`);
    const rejectionCode = scenario === "replayed-state-currentness"
      ? "state-currentness"
      : scenario === "replayed-candidate-currentness"
        ? "candidate-currentness"
        : scenario === "replayed-response-binding"
          ? "response-binding"
          : "receipt-binding";
    return Object.freeze({ scenario, artifact_manifest_sha256: artifactManifestSha256, protected_function_reached: true, rejected: true, rejection_stage: "saved-authority", rejection_code: rejectionCode });
  }
  throw new TypeError(`negative scenario accepted: ${scenario}`);
}

function validateNegativeScenario(value: unknown, artifactManifestSha256: string, expected: HandoffNegativeScenario["scenario"]): HandoffNegativeScenario {
  const record = object(value, `negative scenario ${expected}`);
  const code = expected === "replayed-state-currentness"
    ? "state-currentness"
    : expected === "replayed-candidate-currentness"
      ? "candidate-currentness"
      : expected === "replayed-response-binding"
        ? "response-binding"
        : "receipt-binding";
  if (Object.keys(record).sort().join("\0") !== ["artifact_manifest_sha256", "protected_function_reached", "rejected", "rejection_code", "rejection_stage", "scenario"].join("\0") || record.scenario !== expected || record.artifact_manifest_sha256 !== artifactManifestSha256 || record.protected_function_reached !== true || record.rejected !== true || record.rejection_stage !== "saved-authority" || record.rejection_code !== code) throw new TypeError(`invalid negative scenario: ${expected}`);
  return Object.freeze({ scenario: expected, artifact_manifest_sha256: artifactManifestSha256, protected_function_reached: true, rejected: true, rejection_stage: "saved-authority", rejection_code: code });
}

export function validateHandoffCheckResult(value: unknown): HandoffCheckResult {
  const record = object(value, "handoff result");
  const expectedKeys = ["artifact_manifest_sha256", "current_candidate", "handoff", "markdown", "negative_scenarios", "receipt", "response", "schema", "state_current", "state_snapshot"].sort();
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0") || record.schema !== IDEATION_HANDOFF_RESULT_SCHEMA || !/^[0-9a-f]{64}$/.test(String(record.artifact_manifest_sha256))) throw new TypeError("handoff result has invalid closed shape");
  const artifactManifestSha256 = String(record.artifact_manifest_sha256);
  const negatives = record.negative_scenarios;
  if (!Array.isArray(negatives) || negatives.length !== 4) throw new TypeError("handoff result negative scenarios are incomplete");
  const validated = Object.freeze([
    validateNegativeScenario(negatives[0], artifactManifestSha256, "replayed-state-currentness"),
    validateNegativeScenario(negatives[1], artifactManifestSha256, "replayed-candidate-currentness"),
    validateNegativeScenario(negatives[2], artifactManifestSha256, "replayed-response-binding"),
    validateNegativeScenario(negatives[3], artifactManifestSha256, "replayed-receipt-binding"),
  ] as const);
  return Object.freeze({ schema: IDEATION_HANDOFF_RESULT_SCHEMA, artifact_manifest_sha256: artifactManifestSha256, state_current: artifact(record.state_current, "handoff result state current"), state_snapshot: artifact(record.state_snapshot, "handoff result state snapshot"), current_candidate: artifact(record.current_candidate, "handoff result current candidate"), response: artifact(record.response, "handoff result response"), markdown: artifact(record.markdown, "handoff result markdown"), receipt: artifact(record.receipt, "handoff result receipt"), handoff: validateDeepScopeHandoff(record.handoff), negative_scenarios: validated });
}

/** The checker selects provenance exclusively through createDeepScopeHandoffFromSavedAuthority. */
export async function checkSavedIdeationAuthority(input: HandoffCheckArguments): Promise<HandoffCheckResult> {
  const manifestBytes = await readFile(input.artifactManifest);
  const artifactManifestSha256 = hashRawBytes(manifestBytes);
  const manifest = parseManifest(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(manifestBytes)));
  await Promise.all([...([manifest.state_current, manifest.state_snapshot, manifest.current_candidate, manifest.response, manifest.markdown, manifest.receipt].map((entry) => rehash(input.repositoryRoot, entry))), rehashAuthority(input.repositoryRoot, manifest.authority)]);
  const slug = slugFromStatePath(manifest.state_current.path);
  const handoff = validateDeepScopeHandoff(await createDeepScopeHandoffFromSavedAuthority({ repository_root: input.repositoryRoot, slug }));
  if (handoff.markdown_path !== manifest.markdown.path || handoff.receipt_path !== manifest.receipt.path || canonicalJson(handoff) !== canonicalJson(manifest.handoff)) throw new TypeError("saved authority handoff does not bind manifest publication");
  const statePath = `${input.repositoryRoot}/${manifest.state_current.path}`;
  const candidatePath = `${input.repositoryRoot}/${manifest.current_candidate.path}`;
  const responsePath = `${input.repositoryRoot}/${manifest.response.path}`;
  const receiptPath = `${input.repositoryRoot}/${manifest.receipt.path}`;
  const [state, candidate, response, receipt] = await Promise.all([readFile(statePath), readFile(candidatePath), readFile(responsePath), readFile(receiptPath)]);
  const parsedState = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(state)), "current state");
  if (typeof parsedState.predecessor_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsedState.predecessor_sha256)) throw new TypeError("negative scenario requires a current state predecessor");
  const historicalState = await readFile(`${input.repositoryRoot}/ai_docs/ideation/.${slug}.state-${parsedState.predecessor_sha256}.json`);
  const historicalStateSha256 = hashRawBytes(historicalState);
  const replaceHash = (bytes: Uint8Array, expected: string, replacement: string, label: string): Uint8Array => {
    const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    if (!text.includes(expected)) throw new TypeError(`negative scenario lacks ${label} binding`);
    return Buffer.from(text.replace(expected, replacement), "utf8");
  };
  const replayCurrentCandidate = (bytes: Uint8Array): Uint8Array => {
    const record = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), "current candidate");
    const replayed = { ...record, state_snapshot_path: `ai_docs/ideation/.${slug}.state-${parsedState.predecessor_sha256}.json`, state_sha256: historicalStateSha256 };
    return Buffer.from(canonicalJson(replayed), "utf8");
  };
  const replayReceiptCandidate = (bytes: Uint8Array): Uint8Array => {
    const receipt = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), "publication receipt");
    const { receipt_sha256: _receiptSha256, ...body } = receipt;
    const replayed = { ...body, candidate_sha256: "0".repeat(64) };
    return Buffer.from(canonicalJson({ ...replayed, receipt_sha256: publicationReceiptSha256(replayed as Parameters<typeof publicationReceiptSha256>[0]) }), "utf8");
  };
  const scenarios: HandoffNegativeScenario[] = [];
  const exercise = async (path: string, replayed: Uint8Array, original: Uint8Array, scenario: HandoffNegativeScenario["scenario"]): Promise<void> => {
    await writeFile(path, replayed);
    try { scenarios.push(await savedAuthorityMustReject(input.repositoryRoot, slug, scenario, artifactManifestSha256)); }
    finally { await writeFile(path, original); }
  };
  await exercise(statePath, historicalState, state, "replayed-state-currentness");
  await exercise(candidatePath, replayCurrentCandidate(candidate), candidate, "replayed-candidate-currentness");
  await exercise(responsePath, replaceHash(response, manifest.current_candidate.sha256, "0".repeat(64), "response current candidate"), response, "replayed-response-binding");
  await exercise(receiptPath, replayReceiptCandidate(receipt), receipt, "replayed-receipt-binding");
  return validateHandoffCheckResult({ schema: IDEATION_HANDOFF_RESULT_SCHEMA, artifact_manifest_sha256: artifactManifestSha256, state_current: manifest.state_current, state_snapshot: manifest.state_snapshot, current_candidate: manifest.current_candidate, response: manifest.response, markdown: manifest.markdown, receipt: manifest.receipt, handoff, negative_scenarios: scenarios });
}
async function exclusiveOutput(path: string, body: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
}
if (import.meta.main) {
  const input = parseHandoffCheckArguments(process.argv);
  const result = await checkSavedIdeationAuthority(input);
  const bytes = Buffer.from(`${canonicalJson(result)}\n`, "utf8");
  await exclusiveOutput(input.output, bytes);
  process.stdout.write(new TextDecoder().decode(bytes));
}
