import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  installImmutableAuthorityFile,
  readAuthorityFile,
  withIdeationLineageLock,
  writeAuthorityFile,
} from "../../approval-dossier-runtime/scripts/authority-files.ts";
import {
  canonicalJson,
  hashCanonicalJson,
  hashRawBytes,
} from "../../approval-dossier-runtime/scripts/canonical-json.ts";
import { validateRepositoryRelativePath } from "../../approval-dossier-runtime/schemas/approval-dossier.ts";
import {
  deriveChangedExchangeTargets,
  deriveFinalDocumentReviewGate,
  ideationStateSha256,
  validateIdeationState,
  type IdeationState,
} from "../schemas/ideation-state.ts";
import {
  IDEATION_SUPPORT_RENDERER_MANIFEST_SCHEMA,
  IDEATION_SUPPORT_TRIGGERS,
  type IdeationSupportProjection,
  type IdeationSupportTrigger,
  projectIdeationSupport,
} from "./ideation-support-projector.ts";
import {
  ideationSupportHtmlSha256,
  renderIdeationSupportHtml,
} from "./ideation-support-renderer.ts";
import { renderIdeationQuestionnaireWorkspaceHtml } from "./ideation-support-renderer.ts";
import {
  assertIdeationReturnedResponseAuthority,
  reconcileCurrentIdeationStateAuthority,
  reopenIdeationReturnedResponseAuthority,
} from "./ideation-runtime.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROOT = "ai_docs/ideation";
const SUPPORT_SKILL_ROOT = ".omp/agent/skills/ideation-with-critique";
const SUPPORT_RENDERER_ENTRY_PATHS = Object.freeze([
  "scripts/ideation-support-projector.ts",
  "scripts/ideation-support-renderer.ts",
] as const);
const SUPPORT_RENDERER_RESOURCE_PATHS = Object.freeze([
  "templates/ideation-support-reference.html",
  "templates/ideation-support-reference.css",
] as const);

export const IDEATION_SUPPORT_RECORD_SCHEMA =
  "ideation-with-critique/support-record/v1" as const;
export interface IdeationSupportRecord {
  readonly schema: typeof IDEATION_SUPPORT_RECORD_SCHEMA;
  readonly artifact_kind: "non-authoritative-support";
  readonly workflow: "ideation";
  readonly run_id: string;
  readonly revision: number;
  readonly trigger: IdeationSupportTrigger;
  readonly trigger_sha256: string;
  readonly state_snapshot_path: string;
  readonly state_sha256: string;
  readonly interview_ledger_sha256: string;
  readonly exchange_count: number;
  readonly covered_exchange_ids: readonly string[];
  readonly renderer_sha256: string;
  readonly html_path: string;
  readonly html_sha256: string;
  readonly html_byte_count: number;
}
export interface PersistedIdeationSupport {
  readonly record_path: string;
  readonly html_path: string;
  readonly support_identity_sha256: string;
  readonly record: IdeationSupportRecord;
  readonly outcome: "created" | "adopted-identical";
}

function assertSlug(slug: string): void {
  if (!SLUG.test(slug))
    throw new Error(`IDEATION_SUPPORT_CORRUPTION:invalid slug:${slug}`);
}
function supportPaths(
  slug: string,
  identity: string,
): { readonly html: string; readonly record: string } {
  assertSlug(slug);
  if (!/^[0-9a-f]{64}$/.test(identity))
    throw new Error("IDEATION_SUPPORT_CORRUPTION:invalid identity");
  return {
    html: `${ROOT}/.${slug}.support-${identity}.html`,
    record: `${ROOT}/.${slug}.support-${identity}.record.json`,
  };
}
function stateSnapshotPath(state: IdeationState): string {
  return `${ROOT}/.${state.slug}.state-${ideationStateSha256(state)}.json`;
}
function stateSnapshotPathFromIdentity(slug: string, sha256: string): string {
  if (!SLUG.test(slug) || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("IDEATION_SUPPORT_CORRUPTION:invalid snapshot identity");
  return `${ROOT}/.${slug}.state-${sha256}.json`;
}
function utf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}
function supportIdentity(
  stateSha256: string,
  rendererSha256: string,
  triggerSha256: string,
): string {
  return hashCanonicalJson({
    state_sha256: stateSha256,
    renderer_sha256: rendererSha256,
    trigger_sha256: triggerSha256,
  });
}

/**
 * Hashes the complete, ordered local import closure that can affect support
 * projection or rendering. A snapshot fails closed on imports outside the
 * implementation root, unsupported specifiers, or nondeterministic I/O.
 */
export async function loadIdeationSupportRendererSnapshot(
  implementationRoot: string,
) {
  const root = resolve(implementationRoot);
  const pending = SUPPORT_RENDERER_ENTRY_PATHS.map(path => `${SUPPORT_SKILL_ROOT}/${path}`);
  const entries = new Map<string, { readonly path: string; readonly sha256: string }>();
  while (pending.length !== 0) {
    const path = pending.pop()!;
    if (entries.has(path)) continue;
    const bytes = await readConfinedImplementationFile(root, path);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertDeterministicSupportDependency(path, source);
    entries.set(path, { path, sha256: hashRawBytes(bytes) });
    const imports = relativeImportSpecifiers(source);
    for (const specifier of imports)
      pending.push(resolveSupportImport(root, path, specifier));
  }
  const templateBytes = await readConfinedImplementationFile(
    root,
    `${SUPPORT_SKILL_ROOT}/templates/ideation-support-reference.html`,
  );
  const stylesheetBytes = await readConfinedImplementationFile(
    root,
    `${SUPPORT_SKILL_ROOT}/templates/ideation-support-reference.css`,
  );
  for (const [resource, bytes] of [
    [SUPPORT_RENDERER_RESOURCE_PATHS[0], templateBytes],
    [SUPPORT_RENDERER_RESOURCE_PATHS[1], stylesheetBytes],
  ] as const) {
    const path = `${SUPPORT_SKILL_ROOT}/${resource}`;
    if (entries.has(path)) throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:duplicate resource:${path}`);
    entries.set(path, { path, sha256: hashRawBytes(bytes) });
  }
  const ordered = [...entries.values()].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  const manifest = Object.freeze({
    schema: IDEATION_SUPPORT_RENDERER_MANIFEST_SCHEMA,
    entries: Object.freeze(ordered),
  });
  return Object.freeze({
    manifest,
    sha256: hashCanonicalJson(manifest),
    template_bytes: Uint8Array.from(templateBytes),
    stylesheet_bytes: Uint8Array.from(stylesheetBytes),
  });
}

function confinedImplementationPath(root: string, path: string): string {
  if (!/^(?:\.omp|[A-Za-z0-9])[A-Za-z0-9._/-]*$/.test(path))
    throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:invalid path:${path}`);
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith(".."))
    throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:path escape:${path}`);
  return absolute;
}

async function readConfinedImplementationFile(root: string, path: string): Promise<Uint8Array> {
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(confinedImplementationPath(root, path));
  if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(`${canonicalRoot}/`))
    throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:path escape:${path}`);
  return readFile(canonicalFile);
}

function relativeImportSpecifiers(source: string): readonly string[] {
  const imports = [
    ...source.matchAll(/\bimport\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\bexport\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g),
  ].map(match => match[1]!);
  for (const specifier of imports) {
    if (specifier.startsWith("node:fs"))
      throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:filesystem import:${specifier}`);
    if (!specifier.startsWith(".") && specifier !== "node:crypto")
      throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:undeclared import:${specifier}`);
  }
  return imports.filter(specifier => specifier.startsWith("."));
}

function resolveSupportImport(root: string, importer: string, specifier: string): string {
  if (!specifier.endsWith(".ts"))
    throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:unsupported import:${specifier}`);
  const path = relative(root, resolve(root, dirname(importer), specifier));
  if (path.startsWith("..") || path.startsWith("/"))
    throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:import escape:${specifier}`);
  return path;
}

function assertDeterministicSupportDependency(path: string, source: string): void {
  if (/\bnode:fs(?:\/promises)?\b|\b(?:readFile|writeFile|readdir|open|stat)\s*\(/.test(source))
    throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:filesystem use:${path}`);
  if (/\b(?:Date\.now|new\s+Date|performance\.now|process\.hrtime)\b/.test(source))
    throw new Error(`IDEATION_SUPPORT_RENDERER_DEPENDENCY:clock use:${path}`);
}


function hasMaterialCommitmentDelta(
  predecessor: IdeationState,
  successor: IdeationState,
): boolean {
  return deriveChangedExchangeTargets(predecessor, successor).some(
    (target) =>
      target.target_type === "state-field" &&
      (target.field === "commitment-level" ||
        target.field === "goal" ||
        target.field === "criteria" ||
        target.field === "scope-in" ||
        target.field === "scope-non-goal" ||
        target.field === "scope-deferred"),
  );
}

/** A derived non-incomplete current review gate is the only final-review boundary. */
function finalReviewGateIsOpen(state: IdeationState): boolean {
  const mandatoryCriteria = new Set(
    state.criteria
      .filter((criterion) => criterion.priority === "P0")
      .map((criterion) => criterion.id),
  );
  return (
    deriveFinalDocumentReviewGate(
      state.final_document_review,
      mandatoryCriteria,
      state.max_review_rounds,
    ).outcome !== "INCOMPLETE"
  );
}

async function assertTriggerEligible(
  repositoryRoot: string,
  state: IdeationState,
  trigger: IdeationSupportTrigger,
  ancestors: readonly IdeationState[],
): Promise<void> {
  if (trigger === "explicit-request") return;
  if (
    trigger === "commitment-review-boundary" &&
    state.commitment_critique !== null
  )
    return;
  if (trigger === "final-review-boundary" && finalReviewGateIsOpen(state))
    return;
  if (
    trigger === "material-commitment-change" &&
    state.revision_kind === "accepted-answer" &&
    state.predecessor_sha256 !== null
  ) {
    const predecessor = ancestors[0];
    if (predecessor !== undefined && hasMaterialCommitmentDelta(predecessor, state))
      return;
  }
  if (
    trigger === "show-stopper-contradiction" &&
    state.commitment_critique?.critics.some((critic) =>
      critic.findings.some((finding) => finding.severity === "show-stopper"),
    ) === true
  )
    return;
  if (trigger === "returned-changes") {
    try {
      await assertIdeationReturnedResponseAuthority(repositoryRoot, state);
      return;
    } catch {
      throw new Error(
        "IDEATION_SUPPORT_CORRUPTION:ineligible trigger:returned-changes",
      );
    }
  }
  throw new Error(`IDEATION_SUPPORT_CORRUPTION:ineligible trigger:${trigger}`);
}

async function loadCanonicalAncestors(
  repositoryRoot: string,
  stateInput: IdeationState,
): Promise<readonly IdeationState[]> {
  const state = validateIdeationState(stateInput);
  const ancestors: IdeationState[] = [];
  let cursor = state;
  while (cursor.revision > 1) {
    if (cursor.predecessor_sha256 === null)
      throw new Error("IDEATION_SUPPORT_CORRUPTION:non-genesis predecessor is required");
    const predecessor = await reopenSnapshot(
      repositoryRoot,
      stateSnapshotPathFromIdentity(cursor.slug, cursor.predecessor_sha256),
    );
    if (
      ideationStateSha256(predecessor) !== cursor.predecessor_sha256 ||
      predecessor.slug !== state.slug ||
      predecessor.run_id !== state.run_id ||
      predecessor.revision !== cursor.revision - 1
    )
      throw new Error("IDEATION_SUPPORT_CORRUPTION:invalid predecessor lineage");
    ancestors.push(predecessor);
    cursor = predecessor;
  }
  if (cursor.predecessor_sha256 !== null)
    throw new Error("IDEATION_SUPPORT_CORRUPTION:genesis predecessor must be null");
  if (ancestors.length !== state.revision - 1)
    throw new Error("IDEATION_SUPPORT_CORRUPTION:incomplete predecessor lineage");
  return Object.freeze(ancestors);
}

function recordBytes(record: IdeationSupportRecord): Uint8Array {
  return utf8(canonicalJson(record));
}
function parseRecord(bytes: Uint8Array): IdeationSupportRecord {
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error("IDEATION_SUPPORT_CORRUPTION:record JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("IDEATION_SUPPORT_CORRUPTION:record shape");
  const record = value as Record<string, unknown>;
  const keys = [
    "schema", "artifact_kind", "workflow", "run_id", "revision", "trigger",
    "trigger_sha256", "state_snapshot_path", "state_sha256", "interview_ledger_sha256",
    "exchange_count", "covered_exchange_ids", "renderer_sha256", "html_path", "html_sha256",
    "html_byte_count",
  ];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key)))
    throw new Error("IDEATION_SUPPORT_CORRUPTION:record shape");
  if (
    record.schema !== IDEATION_SUPPORT_RECORD_SCHEMA ||
    record.artifact_kind !== "non-authoritative-support" ||
    record.workflow !== "ideation" ||
    typeof record.run_id !== "string" || record.run_id.length === 0 ||
    !Number.isSafeInteger(record.revision) || (record.revision as number) < 1 ||
    typeof record.trigger !== "string" || !IDEATION_SUPPORT_TRIGGERS.includes(record.trigger as IdeationSupportTrigger) ||
    typeof record.state_snapshot_path !== "string" ||
    !Array.isArray(record.covered_exchange_ids) ||
    !record.covered_exchange_ids.every((id) => typeof id === "string") ||
    !Number.isSafeInteger(record.exchange_count) || (record.exchange_count as number) < 0 ||
    !Number.isSafeInteger(record.html_byte_count) || (record.html_byte_count as number) < 0 ||
    [record.trigger_sha256, record.state_sha256, record.interview_ledger_sha256, record.renderer_sha256, record.html_sha256]
      .some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) ||
    typeof record.html_path !== "string"
  )
    throw new Error("IDEATION_SUPPORT_CORRUPTION:record values");
  if (text !== canonicalJson(record))
    throw new Error("IDEATION_SUPPORT_CORRUPTION:record is not canonical JSON");
  return Object.freeze({
    schema: IDEATION_SUPPORT_RECORD_SCHEMA,
    artifact_kind: "non-authoritative-support",
    workflow: "ideation",
    run_id: record.run_id,
    revision: record.revision as number,
    trigger: record.trigger as IdeationSupportTrigger,
    trigger_sha256: record.trigger_sha256 as string,
    state_snapshot_path: validateRepositoryRelativePath(record.state_snapshot_path),
    state_sha256: record.state_sha256 as string,
    interview_ledger_sha256: record.interview_ledger_sha256 as string,
    exchange_count: record.exchange_count as number,
    covered_exchange_ids: Object.freeze([...record.covered_exchange_ids] as string[]),
    renderer_sha256: record.renderer_sha256 as string,
    html_path: validateRepositoryRelativePath(record.html_path),
    html_sha256: record.html_sha256 as string,
    html_byte_count: record.html_byte_count as number,
  });
}

async function reopenSnapshot(
  repositoryRoot: string,
  path: string,
): Promise<IdeationState> {
  const normalized = validateRepositoryRelativePath(path);
  const bytes = await readAuthorityFile(repositoryRoot, normalized);
  let decoded: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded = JSON.parse(text);
  } catch {
    throw new Error(`IDEATION_SUPPORT_CORRUPTION:invalid snapshot:${normalized}`);
  }
  const state = validateIdeationState(decoded);
  if (text !== canonicalJson(state))
    throw new Error(`IDEATION_SUPPORT_CORRUPTION:noncanonical snapshot:${normalized}`);
  if (stateSnapshotPath(state) !== normalized)
    throw new Error(
      `IDEATION_SUPPORT_CORRUPTION:noncanonical snapshot:${normalized}`,
    );
  return state;
}

async function assertCanonicalLineageMembership(
  repositoryRoot: string,
  state: IdeationState,
): Promise<"current" | "historical"> {
  const reconciled = await reconcileCurrentIdeationStateAuthority(
    repositoryRoot,
    state.slug,
  );
  let cursor = reconciled.state;
  while (true) {
    if (ideationStateSha256(cursor) === ideationStateSha256(state))
      return cursor.revision === reconciled.state.revision
        ? "current"
        : "historical";
    if (cursor.predecessor_sha256 === null) break;
    cursor = await reopenSnapshot(
      repositoryRoot,
      stateSnapshotPathFromIdentity(state.slug, cursor.predecessor_sha256),
    );
  }
  throw new Error(
    "IDEATION_SUPPORT_CORRUPTION:snapshot outside canonical lineage",
  );
}


export async function createIdeationSupportDossier(input: {
  readonly repository_root: string;
  readonly state_snapshot_path: string;
  readonly trigger: IdeationSupportTrigger;
  readonly implementation_root: string;
}): Promise<PersistedIdeationSupport> {
  const preliminary = validateIdeationState(
    JSON.parse(
      new TextDecoder().decode(
        await readAuthorityFile(
          input.repository_root,
          validateRepositoryRelativePath(input.state_snapshot_path),
        ),
      ),
    ),
  );
  return withIdeationLineageLock(
    input.repository_root,
    preliminary.slug,
    async () => {
      const state = await reopenSnapshot(
        input.repository_root,
        input.state_snapshot_path,
      );
      const ancestors = await loadCanonicalAncestors(
        input.repository_root,
        state,
      );
      await assertTriggerEligible(
        input.repository_root,
        state,
        input.trigger,
        ancestors,
      );
      const currentness = await assertCanonicalLineageMembership(
        input.repository_root,
        state,
      );
      if (input.trigger !== "explicit-request" && currentness !== "current")
        throw new Error(
          "IDEATION_SUPPORT_CORRUPTION:non-current trigger snapshot",
        );
      const renderer = await loadIdeationSupportRendererSnapshot(
        input.implementation_root,
      );
      const projection = Object.freeze({
        ...projectIdeationSupport(state, input.trigger, ancestors),
        currentness,
      });
      const html = renderIdeationSupportHtml(
        projection,
        renderer.template_bytes,
        renderer.stylesheet_bytes,
      );
      const stateSha = ideationStateSha256(state);
      const triggerSha = hashCanonicalJson(input.trigger);
      const identity = supportIdentity(stateSha, renderer.sha256, triggerSha);
      const paths = supportPaths(state.slug, identity);
      const record: IdeationSupportRecord = Object.freeze({
        schema: IDEATION_SUPPORT_RECORD_SCHEMA,
        artifact_kind: "non-authoritative-support",
        workflow: "ideation",
        run_id: state.run_id,
        revision: state.revision,
        trigger: input.trigger,
        trigger_sha256: triggerSha,
        state_snapshot_path: validateRepositoryRelativePath(
          input.state_snapshot_path,
        ),
        state_sha256: stateSha,
        interview_ledger_sha256: hashCanonicalJson(state.interview_exchanges),
        exchange_count: state.interview_exchanges.length,
        covered_exchange_ids: Object.freeze(
          state.interview_exchanges.map((exchange) => exchange.id),
        ),
        renderer_sha256: renderer.sha256,
        html_path: paths.html,
        html_sha256: ideationSupportHtmlSha256(html),
        html_byte_count: html.byteLength,
      });
      const htmlOutcome = await installImmutableAuthorityFile(
        input.repository_root,
        paths.html,
        html,
      );
      const recordOutcome = await installImmutableAuthorityFile(
        input.repository_root,
        paths.record,
        recordBytes(record),
        0o600,
      );
      const reopenedHtml = await readAuthorityFile(
        input.repository_root,
        paths.html,
      );
      const reopenedRecord = parseRecord(
        await readAuthorityFile(input.repository_root, paths.record),
      );
      if (
        ideationSupportHtmlSha256(reopenedHtml) !== record.html_sha256 ||
        canonicalJson(reopenedRecord) !== canonicalJson(record)
      )
        throw new Error("IDEATION_SUPPORT_CORRUPTION:reopen mismatch");
      return Object.freeze({
        record_path: paths.record,
        html_path: paths.html,
        support_identity_sha256: identity,
        record,
        outcome:
          htmlOutcome === "adopted-identical" &&
          recordOutcome === "adopted-identical"
            ? "adopted-identical"
            : "created",
      });
    },
  );
}

export async function reopenIdeationSupportDossier(input: {
  readonly repository_root: string;
  readonly record_path: string;
  readonly implementation_root: string;
}): Promise<PersistedIdeationSupport> {
  const suppliedPath = validateRepositoryRelativePath(input.record_path);
  const bytes = await readAuthorityFile(input.repository_root, suppliedPath);
  const record = parseRecord(bytes);
  const snapshotMatch =
    /^ai_docs\/ideation\/.([a-z0-9-]+)\.state-[0-9a-f]{64}\.json$/.exec(
      record.state_snapshot_path,
    );
  if (snapshotMatch === null)
    throw new Error("IDEATION_SUPPORT_CORRUPTION:noncanonical snapshot path");
  const identity = supportIdentity(
    record.state_sha256,
    record.renderer_sha256,
    record.trigger_sha256,
  );
  const paths = supportPaths(snapshotMatch[1]!, identity);
  if (suppliedPath !== paths.record || record.html_path !== paths.html)
    throw new Error("IDEATION_SUPPORT_CORRUPTION:noncanonical path");
  const state = await reopenSnapshot(
    input.repository_root,
    record.state_snapshot_path,
  );
  const renderer = await loadIdeationSupportRendererSnapshot(
    input.implementation_root,
  );
  if (
    state.run_id !== record.run_id ||
    state.revision !== record.revision ||
    ideationStateSha256(state) !== record.state_sha256 ||
    record.state_snapshot_path !== stateSnapshotPath(state) ||
    record.trigger_sha256 !== hashCanonicalJson(record.trigger) ||
    record.interview_ledger_sha256 !== hashCanonicalJson(state.interview_exchanges) ||
    record.exchange_count !== state.interview_exchanges.length ||
    canonicalJson(record.covered_exchange_ids) !== canonicalJson(state.interview_exchanges.map((exchange) => exchange.id)) ||
    renderer.sha256 !== record.renderer_sha256
  )
    throw new Error("IDEATION_SUPPORT_CORRUPTION:hash mismatch");
  const currentness = await withIdeationLineageLock(
    input.repository_root,
    state.slug,
    () => assertCanonicalLineageMembership(input.repository_root, state),
  );
  const ancestors = await loadCanonicalAncestors(
    input.repository_root,
    state,
  );
  if (record.trigger !== "explicit-request" && currentness !== "current")
    throw new Error("IDEATION_SUPPORT_CORRUPTION:non-current trigger snapshot");
  await assertTriggerEligible(
    input.repository_root,
    state,
    record.trigger,
    ancestors,
  );
  const projection = Object.freeze({
    ...projectIdeationSupport(state, record.trigger, ancestors),
    currentness,
  });
  const html = renderIdeationSupportHtml(
    projection,
    renderer.template_bytes,
    renderer.stylesheet_bytes,
  );
  const actual = await readAuthorityFile(input.repository_root, paths.html);
  if (
    ideationSupportHtmlSha256(html) !== record.html_sha256 ||
    record.html_byte_count !== html.byteLength ||
    Buffer.compare(Buffer.from(actual), Buffer.from(html)) !== 0
  )
    throw new Error("IDEATION_SUPPORT_CORRUPTION:html mismatch");
  return Object.freeze({
    record_path: paths.record,
    html_path: paths.html,
    support_identity_sha256: identity,
    record,
    outcome: "adopted-identical",
  });
}

export const QUESTIONNAIRE_BASELINE_SCHEMA = "ideation-questionnaire/baseline/v1" as const;
export const QUESTIONNAIRE_WORKSPACE_SCHEMA = "ideation-questionnaire/workspace/v1" as const;
export const QUESTIONNAIRE_CHECKPOINT_SCHEMA = "ideation-questionnaire/checkpoint/v1" as const;
export const QUESTIONNAIRE_SAVED_WORKSPACE_EVIDENCE_SCHEMA = "ideation-questionnaire/saved-workspace-evidence/v1" as const;
export const QUESTIONNAIRE_ISSUANCE_SCHEMA = "ideation-questionnaire/issuance/v1" as const;
export const QUESTIONNAIRE_ADMITTED_RESPONSE_SCHEMA = "ideation-questionnaire/admitted-response/v2" as const;
export const QUESTIONNAIRE_HEAD_SCHEMA = "ideation-questionnaire/imported-response-head/v2" as const;
export type RebaseDisposition = "carry-local" | "keep-current" | "discard-local" | "manual-merge";
export type RepositoryRelativeRecordPath = string;
export type Sha256 = string;

export interface QuestionnaireOccurrence { readonly occurrence_id: string; readonly feedback_id: string; readonly target: string; readonly response_record_path: RepositoryRelativeRecordPath; readonly response_record_sha256: Sha256; }
export interface DossierBaselineRecord { readonly schema: typeof QUESTIONNAIRE_BASELINE_SCHEMA; readonly baseline_id: string; readonly dossier_id: string; readonly source_state_path: RepositoryRelativeRecordPath; readonly source_state_sha256: Sha256; readonly source_head_revision: number; readonly interview_ledger_sha256: Sha256; readonly snapshot_inventory_sha256: Sha256; readonly renderer_manifest_sha256: Sha256; readonly dossier_identity: string; readonly response_record_path: RepositoryRelativeRecordPath; readonly response_record_sha256: Sha256; readonly occurrence_inventory: readonly QuestionnaireOccurrence[]; readonly occurrence_inventory_sha256: Sha256; }
export interface QuestionnaireResponseItem extends QuestionnaireOccurrence { answer_text: string; validation: "unvalidated" | "valid" | "invalid"; defer_status: "not-deferred" | "deferred"; defer_reason: string | null; rationale: string; selected_option: string | null; context_requests: readonly string[]; evidence_references: readonly string[]; notebook_content: string; }
export interface QuestionnaireWorkspacePayload { readonly schema: typeof QUESTIONNAIRE_WORKSPACE_SCHEMA; readonly workspace_id: string; readonly dossier_id: string; readonly baseline_id: string; readonly baseline_record_path: RepositoryRelativeRecordPath; readonly baseline_record_sha256: Sha256; readonly checkpoint_id: string; readonly checkpoint_record_path: RepositoryRelativeRecordPath; readonly checkpoint_record_sha256: Sha256; readonly workspace_issuance_id: string; readonly workspace_issuance_record_path: RepositoryRelativeRecordPath; readonly workspace_issuance_record_sha256: Sha256; workspace_revision: number; selected_occurrence_id: string | null; response_items: readonly QuestionnaireResponseItem[]; navigation_state: { active_view: string; scroll_anchor: string | null }; }
export interface CheckpointAuthorityRecord { readonly schema: typeof QUESTIONNAIRE_CHECKPOINT_SCHEMA; readonly checkpoint_id: string; readonly dossier_id: string; readonly dossier_identity: string; readonly baseline_record_path: RepositoryRelativeRecordPath; readonly baseline_record_sha256: Sha256; readonly source_state_path: RepositoryRelativeRecordPath; readonly source_state_sha256: Sha256; readonly snapshot_inventory_sha256: Sha256; readonly renderer_manifest_sha256: Sha256; readonly base_imported_response_sha256: Sha256 | null; readonly issued_at: string; }
export interface SavedWorkspaceEvidenceRecord { readonly schema: typeof QUESTIONNAIRE_SAVED_WORKSPACE_EVIDENCE_SCHEMA; readonly evidence_id: string; readonly dossier_id: string; readonly baseline_record_path: RepositoryRelativeRecordPath; readonly baseline_record_sha256: Sha256; readonly checkpoint_record_path: RepositoryRelativeRecordPath; readonly checkpoint_record_sha256: Sha256; readonly workspace_issuance_record_path: RepositoryRelativeRecordPath; readonly workspace_issuance_record_sha256: Sha256; readonly workspace_path: RepositoryRelativeRecordPath; readonly workspace_sha256: Sha256; readonly workspace_snapshot_path: RepositoryRelativeRecordPath; readonly workspace_snapshot_sha256: Sha256; readonly workspace_revision: number; readonly saved_at: string; }
export interface AuthenticatedAncestryEntry { readonly record_path: RepositoryRelativeRecordPath; readonly record_sha256: Sha256; }
export interface RebaseDecision { readonly question_id: string; readonly prior_item_sha256: Sha256 | null; readonly current_item_sha256: Sha256 | null; readonly disposition: RebaseDisposition; }
export interface InitialWorkspaceIssuanceRecord { readonly schema: typeof QUESTIONNAIRE_ISSUANCE_SCHEMA; readonly issuance_id: string; readonly dossier_id: string; readonly issuance_kind: "initial"; readonly baseline_record_path: RepositoryRelativeRecordPath; readonly baseline_record_sha256: Sha256; readonly checkpoint_record_path: RepositoryRelativeRecordPath; readonly checkpoint_record_sha256: Sha256; readonly issued_at: string; }
export interface ContinuationWorkspaceIssuanceRecord { readonly schema: typeof QUESTIONNAIRE_ISSUANCE_SCHEMA; readonly issuance_id: string; readonly dossier_id: string; readonly issuance_kind: "continuation"; readonly baseline_record_path: RepositoryRelativeRecordPath; readonly baseline_record_sha256: Sha256; readonly checkpoint_record_path: RepositoryRelativeRecordPath; readonly checkpoint_record_sha256: Sha256; readonly prior_issuance_record_path: RepositoryRelativeRecordPath; readonly prior_issuance_record_sha256: Sha256; readonly issued_at: string; }
export interface RebaseWorkspaceIssuanceRecord { readonly schema: typeof QUESTIONNAIRE_ISSUANCE_SCHEMA; readonly issuance_id: string; readonly dossier_id: string; readonly issuance_kind: "rebase"; readonly baseline_record_path: RepositoryRelativeRecordPath; readonly baseline_record_sha256: Sha256; readonly checkpoint_record_path: RepositoryRelativeRecordPath; readonly checkpoint_record_sha256: Sha256; readonly prior_saved_workspace_evidence_record_path: RepositoryRelativeRecordPath; readonly prior_saved_workspace_evidence_record_sha256: Sha256; readonly prior_checkpoint_record_path: RepositoryRelativeRecordPath; readonly prior_checkpoint_record_sha256: Sha256; readonly compared_current_imported_response_sha256: Sha256; readonly authenticated_ancestry: readonly AuthenticatedAncestryEntry[]; readonly decisions: readonly RebaseDecision[]; readonly reconciled: true; readonly issued_at: string; }
export type WorkspaceIssuanceRecord = InitialWorkspaceIssuanceRecord | ContinuationWorkspaceIssuanceRecord | RebaseWorkspaceIssuanceRecord;
export interface AdmittedQuestionnaireResponseRecord { readonly schema: typeof QUESTIONNAIRE_ADMITTED_RESPONSE_SCHEMA; readonly dossier_id: string; readonly response_items: readonly QuestionnaireResponseItem[]; readonly occurrence_inventory: readonly QuestionnaireOccurrence[]; readonly occurrence_inventory_sha256: Sha256; readonly baseline_record_path: string; readonly baseline_record_sha256: Sha256; readonly checkpoint_record_path: string; readonly checkpoint_record_sha256: Sha256; readonly workspace_issuance_record_path: string; readonly workspace_issuance_record_sha256: Sha256; readonly saved_workspace_evidence_record_path: string; readonly saved_workspace_evidence_record_sha256: Sha256; readonly saved_workspace_snapshot_path: string; readonly saved_workspace_snapshot_sha256: Sha256; readonly workspace_revision: number; readonly workspace_raw_sha256: Sha256; readonly source_response_record_path: string; readonly source_response_record_sha256: Sha256; readonly predecessor_imported_response_sha256: Sha256 | null; }
export interface ImportedQuestionnaireResponseEvidence { readonly admitted_response_record_path: string; readonly admitted_response_record_sha256: Sha256; readonly imported_response_head_sha256: Sha256; readonly continuation_checkpoint: CheckpointAuthorityRecord; readonly continuation_checkpoint_record_path: string; readonly continuation_checkpoint_record_sha256: Sha256; readonly continuation_issuance: ContinuationWorkspaceIssuanceRecord; readonly continuation_issuance_record_path: string; readonly continuation_issuance_record_sha256: string; }

const QUESTIONNAIRE_HASH = /^[0-9a-f]{64}$/;
function questionnaireHash(value: unknown, label: string): string { if (typeof value !== "string" || !QUESTIONNAIRE_HASH.test(value)) throw new TypeError(`invalid questionnaire ${label}`); return value; }
function questionnaireString(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid questionnaire ${label}`); return value; }
function questionnairePath(value: unknown, label: string): string { return validateRepositoryRelativePath(questionnaireString(value, label), label); }
function questionnaireInteger(value: unknown, label: string, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`invalid questionnaire ${label}`); return value as number; }
function questionnaireObject(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`); return value as Record<string, unknown>; }
function questionnaireClosed(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> { const object = questionnaireObject(value, label); const actual = Object.keys(object); if (actual.length !== keys.length || actual.some(key => !keys.includes(key)) || keys.some(key => !(key in object))) throw new TypeError(`${label} has missing or extra fields`); return object; }
function questionnaireArray(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`); return value; }
function questionnaireTimestamp(value: unknown, label: string): string { const text = questionnaireString(value, label); if (Number.isNaN(Date.parse(text))) throw new TypeError(`invalid questionnaire ${label}`); return text; }
function questionnaireText(value: unknown, label: string): string { if (typeof value !== "string") throw new TypeError(`invalid questionnaire ${label}`); return value; }
function questionnaireNow(): string {
  return "1970-01-01T00:00:00.000Z";
}
function questionnaireRecordPath(slug: string, kind: string, identity: string): string { assertSlug(slug); return `${ROOT}/.${slug}.questionnaire-${kind}-${questionnaireHash(identity, `${kind} identity`)}.json`; }
function questionnaireWorkspacePath(slug: string): string { assertSlug(slug); return `${ROOT}/${slug}/questionnaire.html`; }
function questionnaireBaselinePath(slug: string, identity: string): string { return questionnaireRecordPath(slug, "baseline", identity); }
function questionnaireCheckpointPath(slug: string, identity: string): string { return questionnaireRecordPath(slug, "checkpoint", identity); }
function questionnaireIssuancePath(slug: string, identity: string): string { return questionnaireRecordPath(slug, "issuance", identity); }
function questionnaireSavedEvidencePath(slug: string, identity: string): string { return questionnaireRecordPath(slug, "saved", identity); }
function questionnaireSnapshotPath(slug: string, identity: string): string { assertSlug(slug); return `${ROOT}/.${slug}.questionnaire-workspace-${questionnaireHash(identity, "workspace snapshot identity")}.html`; }
function questionnaireAdmittedResponsePath(slug: string, identity: string): string { return questionnaireRecordPath(slug, "admitted-response", identity); }
function questionnaireHeadPath(slug: string): string { assertSlug(slug); return `${ROOT}/.${slug}.questionnaire-imported-response-head.json`; }

export function questionnaireOccurrenceIdentity(input: { readonly response_record_path: string; readonly response_record_sha256: string; readonly feedback_id: string; readonly target: string }): string { return hashCanonicalJson({ response_record_path: questionnairePath(input.response_record_path, "response_record_path"), response_record_sha256: questionnaireHash(input.response_record_sha256, "response_record_sha256"), feedback_id: questionnaireString(input.feedback_id, "feedback_id"), target: questionnaireString(input.target, "target") }); }
export const deriveQuestionnaireOccurrenceId = questionnaireOccurrenceIdentity;
function occurrence(item: QuestionnaireResponseItem | QuestionnaireOccurrence): QuestionnaireOccurrence { return Object.freeze({ occurrence_id: item.occurrence_id, feedback_id: item.feedback_id, target: item.target, response_record_path: item.response_record_path, response_record_sha256: item.response_record_sha256 }); }
function occurrenceInventory(items: readonly (QuestionnaireResponseItem | QuestionnaireOccurrence)[]): readonly QuestionnaireOccurrence[] { return Object.freeze(items.map(occurrence)); }
function occurrenceInventorySha256(items: readonly (QuestionnaireResponseItem | QuestionnaireOccurrence)[]): string { return hashCanonicalJson(occurrenceInventory(items)); }

function parseQuestionnaireOccurrence(value: unknown): QuestionnaireOccurrence { const object = questionnaireClosed(value, "$occurrence", ["occurrence_id", "feedback_id", "target", "response_record_path", "response_record_sha256"]); const item = { occurrence_id: questionnaireString(object.occurrence_id, "occurrence_id"), feedback_id: questionnaireString(object.feedback_id, "feedback_id"), target: questionnaireString(object.target, "target"), response_record_path: questionnairePath(object.response_record_path, "response_record_path"), response_record_sha256: questionnaireHash(object.response_record_sha256, "response_record_sha256") }; if (questionnaireOccurrenceIdentity(item) !== item.occurrence_id) throw new TypeError("questionnaire occurrence identity mismatch"); return Object.freeze(item); }
function parseQuestionnaireBaseline(value: unknown): DossierBaselineRecord { const object = questionnaireClosed(value, "$baseline", ["schema", "baseline_id", "dossier_id", "source_state_path", "source_state_sha256", "source_head_revision", "interview_ledger_sha256", "snapshot_inventory_sha256", "renderer_manifest_sha256", "dossier_identity", "response_record_path", "response_record_sha256", "occurrence_inventory", "occurrence_inventory_sha256"]); if (object.schema !== QUESTIONNAIRE_BASELINE_SCHEMA) throw new TypeError("invalid questionnaire baseline schema"); const inventory = Object.freeze(questionnaireArray(object.occurrence_inventory, "occurrence_inventory").map(parseQuestionnaireOccurrence)); const baseline = { schema: QUESTIONNAIRE_BASELINE_SCHEMA, baseline_id: questionnaireHash(object.baseline_id, "baseline_id"), dossier_id: questionnaireString(object.dossier_id, "dossier_id"), source_state_path: questionnairePath(object.source_state_path, "source_state_path"), source_state_sha256: questionnaireHash(object.source_state_sha256, "source_state_sha256"), source_head_revision: questionnaireInteger(object.source_head_revision, "source_head_revision", 1), interview_ledger_sha256: questionnaireHash(object.interview_ledger_sha256, "interview_ledger_sha256"), snapshot_inventory_sha256: questionnaireHash(object.snapshot_inventory_sha256, "snapshot_inventory_sha256"), renderer_manifest_sha256: questionnaireHash(object.renderer_manifest_sha256, "renderer_manifest_sha256"), dossier_identity: questionnaireHash(object.dossier_identity, "dossier_identity"), response_record_path: questionnairePath(object.response_record_path, "response_record_path"), response_record_sha256: questionnaireHash(object.response_record_sha256, "response_record_sha256"), occurrence_inventory: inventory, occurrence_inventory_sha256: questionnaireHash(object.occurrence_inventory_sha256, "occurrence_inventory_sha256") } as const; if (baseline.occurrence_inventory_sha256 !== occurrenceInventorySha256(inventory)) throw new TypeError("questionnaire occurrence inventory hash mismatch"); return Object.freeze(baseline); }
export const parseDossierBaselineRecord = parseQuestionnaireBaseline;
export const validateDossierBaselineRecord = parseQuestionnaireBaseline;
function parseQuestionnaireItem(value: unknown): QuestionnaireResponseItem { const object = questionnaireClosed(value, "$response_item", ["occurrence_id", "feedback_id", "target", "response_record_path", "response_record_sha256", "answer_text", "validation", "defer_status", "defer_reason", "rationale", "selected_option", "context_requests", "evidence_references", "notebook_content"]); const identity = parseQuestionnaireOccurrence({ occurrence_id: object.occurrence_id, feedback_id: object.feedback_id, target: object.target, response_record_path: object.response_record_path, response_record_sha256: object.response_record_sha256 }); const context = questionnaireArray(object.context_requests, "context_requests"); const evidence = questionnaireArray(object.evidence_references, "evidence_references"); const item = { ...identity, answer_text: questionnaireText(object.answer_text, "answer_text"), validation: object.validation, defer_status: object.defer_status, defer_reason: object.defer_reason, rationale: questionnaireText(object.rationale, "rationale"), selected_option: object.selected_option, context_requests: context, evidence_references: evidence, notebook_content: questionnaireText(object.notebook_content, "notebook_content") }; if (!["unvalidated", "valid", "invalid"].includes(item.validation as string) || !["not-deferred", "deferred"].includes(item.defer_status as string) || (item.defer_reason !== null && typeof item.defer_reason !== "string") || (item.selected_option !== null && typeof item.selected_option !== "string") || !context.every(v => typeof v === "string") || !evidence.every(v => typeof v === "string")) throw new TypeError("invalid questionnaire response item"); return Object.freeze({ ...item, validation: item.validation as QuestionnaireResponseItem["validation"], defer_status: item.defer_status as QuestionnaireResponseItem["defer_status"], defer_reason: item.defer_reason as string | null, selected_option: item.selected_option as string | null, context_requests: Object.freeze([...context] as string[]), evidence_references: Object.freeze([...evidence] as string[]) }); }
export const parseQuestionnaireResponseItem = parseQuestionnaireItem;
export const validateQuestionnaireResponseItem = parseQuestionnaireItem;
function parseQuestionnaireWorkspace(value: unknown): QuestionnaireWorkspacePayload { const object = questionnaireClosed(value, "$workspace", ["schema", "workspace_id", "dossier_id", "baseline_id", "baseline_record_path", "baseline_record_sha256", "checkpoint_id", "checkpoint_record_path", "checkpoint_record_sha256", "workspace_issuance_id", "workspace_issuance_record_path", "workspace_issuance_record_sha256", "workspace_revision", "selected_occurrence_id", "response_items", "navigation_state"]); if (object.schema !== QUESTIONNAIRE_WORKSPACE_SCHEMA) throw new TypeError("invalid questionnaire workspace schema"); const navigation = questionnaireClosed(object.navigation_state, "$workspace.navigation_state", ["active_view", "scroll_anchor"]); const response_items = Object.freeze(questionnaireArray(object.response_items, "$workspace.response_items").map(parseQuestionnaireItem)); const ids = new Set(response_items.map(item => item.occurrence_id)); if (ids.size !== response_items.length || (object.selected_occurrence_id !== null && (typeof object.selected_occurrence_id !== "string" || !ids.has(object.selected_occurrence_id))) || typeof navigation.active_view !== "string" || (navigation.scroll_anchor !== null && typeof navigation.scroll_anchor !== "string")) throw new TypeError("invalid questionnaire workspace navigation or occurrences"); return Object.freeze({ schema: QUESTIONNAIRE_WORKSPACE_SCHEMA, workspace_id: questionnaireHash(object.workspace_id, "workspace_id"), dossier_id: questionnaireString(object.dossier_id, "dossier_id"), baseline_id: questionnaireHash(object.baseline_id, "baseline_id"), baseline_record_path: questionnairePath(object.baseline_record_path, "baseline_record_path"), baseline_record_sha256: questionnaireHash(object.baseline_record_sha256, "baseline_record_sha256"), checkpoint_id: questionnaireHash(object.checkpoint_id, "checkpoint_id"), checkpoint_record_path: questionnairePath(object.checkpoint_record_path, "checkpoint_record_path"), checkpoint_record_sha256: questionnaireHash(object.checkpoint_record_sha256, "checkpoint_record_sha256"), workspace_issuance_id: questionnaireHash(object.workspace_issuance_id, "workspace_issuance_id"), workspace_issuance_record_path: questionnairePath(object.workspace_issuance_record_path, "workspace_issuance_record_path"), workspace_issuance_record_sha256: questionnaireHash(object.workspace_issuance_record_sha256, "workspace_issuance_record_sha256"), workspace_revision: questionnaireInteger(object.workspace_revision, "workspace_revision", 1), selected_occurrence_id: object.selected_occurrence_id as string | null, response_items, navigation_state: { active_view: navigation.active_view as string, scroll_anchor: navigation.scroll_anchor as string | null } }); }
export const parseQuestionnaireWorkspacePayload = parseQuestionnaireWorkspace;
export const validateQuestionnaireWorkspacePayload = parseQuestionnaireWorkspace;
export function questionnaireWorkspaceCanonicalJson(payload: QuestionnaireWorkspacePayload): string { return canonicalJson(parseQuestionnaireWorkspace(payload)); }
function parseQuestionnaireCheckpoint(value: unknown): CheckpointAuthorityRecord { const object = questionnaireClosed(value, "$checkpoint", ["schema", "checkpoint_id", "dossier_id", "dossier_identity", "baseline_record_path", "baseline_record_sha256", "source_state_path", "source_state_sha256", "snapshot_inventory_sha256", "renderer_manifest_sha256", "base_imported_response_sha256", "issued_at"]); if (object.schema !== QUESTIONNAIRE_CHECKPOINT_SCHEMA) throw new TypeError("invalid questionnaire checkpoint schema"); return Object.freeze({ schema: QUESTIONNAIRE_CHECKPOINT_SCHEMA, checkpoint_id: questionnaireHash(object.checkpoint_id, "checkpoint_id"), dossier_id: questionnaireString(object.dossier_id, "dossier_id"), dossier_identity: questionnaireHash(object.dossier_identity, "dossier_identity"), baseline_record_path: questionnairePath(object.baseline_record_path, "baseline_record_path"), baseline_record_sha256: questionnaireHash(object.baseline_record_sha256, "baseline_record_sha256"), source_state_path: questionnairePath(object.source_state_path, "source_state_path"), source_state_sha256: questionnaireHash(object.source_state_sha256, "source_state_sha256"), snapshot_inventory_sha256: questionnaireHash(object.snapshot_inventory_sha256, "snapshot_inventory_sha256"), renderer_manifest_sha256: questionnaireHash(object.renderer_manifest_sha256, "renderer_manifest_sha256"), base_imported_response_sha256: object.base_imported_response_sha256 === null ? null : questionnaireHash(object.base_imported_response_sha256, "base_imported_response_sha256"), issued_at: questionnaireTimestamp(object.issued_at, "issued_at") }); }
export const parseCheckpointAuthorityRecord = parseQuestionnaireCheckpoint;
export const validateCheckpointAuthorityRecord = parseQuestionnaireCheckpoint;
function parseQuestionnaireSavedEvidence(value: unknown): SavedWorkspaceEvidenceRecord { const object = questionnaireClosed(value, "$saved_workspace_evidence", ["schema", "evidence_id", "dossier_id", "baseline_record_path", "baseline_record_sha256", "checkpoint_record_path", "checkpoint_record_sha256", "workspace_issuance_record_path", "workspace_issuance_record_sha256", "workspace_path", "workspace_sha256", "workspace_snapshot_path", "workspace_snapshot_sha256", "workspace_revision", "saved_at"]); if (object.schema !== QUESTIONNAIRE_SAVED_WORKSPACE_EVIDENCE_SCHEMA) throw new TypeError("invalid questionnaire saved evidence schema"); return Object.freeze({ schema: QUESTIONNAIRE_SAVED_WORKSPACE_EVIDENCE_SCHEMA, evidence_id: questionnaireHash(object.evidence_id, "evidence_id"), dossier_id: questionnaireString(object.dossier_id, "dossier_id"), baseline_record_path: questionnairePath(object.baseline_record_path, "baseline_record_path"), baseline_record_sha256: questionnaireHash(object.baseline_record_sha256, "baseline_record_sha256"), checkpoint_record_path: questionnairePath(object.checkpoint_record_path, "checkpoint_record_path"), checkpoint_record_sha256: questionnaireHash(object.checkpoint_record_sha256, "checkpoint_record_sha256"), workspace_issuance_record_path: questionnairePath(object.workspace_issuance_record_path, "workspace_issuance_record_path"), workspace_issuance_record_sha256: questionnaireHash(object.workspace_issuance_record_sha256, "workspace_issuance_record_sha256"), workspace_path: questionnairePath(object.workspace_path, "workspace_path"), workspace_sha256: questionnaireHash(object.workspace_sha256, "workspace_sha256"), workspace_snapshot_path: questionnairePath(object.workspace_snapshot_path, "workspace_snapshot_path"), workspace_snapshot_sha256: questionnaireHash(object.workspace_snapshot_sha256, "workspace_snapshot_sha256"), workspace_revision: questionnaireInteger(object.workspace_revision, "workspace_revision", 1), saved_at: questionnaireTimestamp(object.saved_at, "saved_at") }); }
export const parseSavedWorkspaceEvidenceRecord = parseQuestionnaireSavedEvidence;
export const validateSavedWorkspaceEvidenceRecord = parseQuestionnaireSavedEvidence;
function parseQuestionnaireIssuance(value: unknown): WorkspaceIssuanceRecord {
  const object = questionnaireObject(value, "$issuance");
  if (object.schema !== QUESTIONNAIRE_ISSUANCE_SCHEMA) throw new TypeError("invalid questionnaire issuance schema");
  const common = ["schema", "issuance_id", "dossier_id", "issuance_kind", "baseline_record_path", "baseline_record_sha256", "checkpoint_record_path", "checkpoint_record_sha256", "issued_at"];
  if (object.issuance_kind === "initial") { const x = questionnaireClosed(value, "$issuance.initial", common); return Object.freeze({ schema: QUESTIONNAIRE_ISSUANCE_SCHEMA, issuance_id: questionnaireHash(x.issuance_id, "issuance_id"), dossier_id: questionnaireString(x.dossier_id, "dossier_id"), issuance_kind: "initial", baseline_record_path: questionnairePath(x.baseline_record_path, "baseline_record_path"), baseline_record_sha256: questionnaireHash(x.baseline_record_sha256, "baseline_record_sha256"), checkpoint_record_path: questionnairePath(x.checkpoint_record_path, "checkpoint_record_path"), checkpoint_record_sha256: questionnaireHash(x.checkpoint_record_sha256, "checkpoint_record_sha256"), issued_at: questionnaireTimestamp(x.issued_at, "issued_at") }); }
  if (object.issuance_kind === "continuation") { const x = questionnaireClosed(value, "$issuance.continuation", [...common.slice(0, -1), "prior_issuance_record_path", "prior_issuance_record_sha256", "issued_at"]); return Object.freeze({ schema: QUESTIONNAIRE_ISSUANCE_SCHEMA, issuance_id: questionnaireHash(x.issuance_id, "issuance_id"), dossier_id: questionnaireString(x.dossier_id, "dossier_id"), issuance_kind: "continuation", baseline_record_path: questionnairePath(x.baseline_record_path, "baseline_record_path"), baseline_record_sha256: questionnaireHash(x.baseline_record_sha256, "baseline_record_sha256"), checkpoint_record_path: questionnairePath(x.checkpoint_record_path, "checkpoint_record_path"), checkpoint_record_sha256: questionnaireHash(x.checkpoint_record_sha256, "checkpoint_record_sha256"), prior_issuance_record_path: questionnairePath(x.prior_issuance_record_path, "prior_issuance_record_path"), prior_issuance_record_sha256: questionnaireHash(x.prior_issuance_record_sha256, "prior_issuance_record_sha256"), issued_at: questionnaireTimestamp(x.issued_at, "issued_at") }); }
  if (object.issuance_kind !== "rebase") throw new TypeError("invalid questionnaire issuance kind");
  const x = questionnaireClosed(value, "$issuance.rebase", [...common.slice(0, -1), "prior_saved_workspace_evidence_record_path", "prior_saved_workspace_evidence_record_sha256", "prior_checkpoint_record_path", "prior_checkpoint_record_sha256", "compared_current_imported_response_sha256", "authenticated_ancestry", "decisions", "reconciled", "issued_at"]);
  const ancestry = Object.freeze(questionnaireArray(x.authenticated_ancestry, "ancestry").map(entry => { const a = questionnaireClosed(entry, "$ancestry", ["record_path", "record_sha256"]); return Object.freeze({ record_path: questionnairePath(a.record_path, "record_path"), record_sha256: questionnaireHash(a.record_sha256, "record_sha256") }); }));
  const decisions = Object.freeze(questionnaireArray(x.decisions, "decisions").map(entry => { const d = questionnaireClosed(entry, "$decision", ["question_id", "prior_item_sha256", "current_item_sha256", "disposition"]); if (!["carry-local", "keep-current", "discard-local", "manual-merge"].includes(d.disposition as string)) throw new TypeError("invalid questionnaire rebase disposition"); return Object.freeze({ question_id: questionnaireString(d.question_id, "question_id"), prior_item_sha256: d.prior_item_sha256 === null ? null : questionnaireHash(d.prior_item_sha256, "prior_item_sha256"), current_item_sha256: d.current_item_sha256 === null ? null : questionnaireHash(d.current_item_sha256, "current_item_sha256"), disposition: d.disposition as RebaseDisposition }); }));
  if (x.reconciled !== true || decisions.some((decision, index) => index > 0 && decisions[index - 1]!.question_id >= decision.question_id)) throw new TypeError("questionnaire rebase issuance is unresolved");
  return Object.freeze({ schema: QUESTIONNAIRE_ISSUANCE_SCHEMA, issuance_id: questionnaireHash(x.issuance_id, "issuance_id"), dossier_id: questionnaireString(x.dossier_id, "dossier_id"), issuance_kind: "rebase", baseline_record_path: questionnairePath(x.baseline_record_path, "baseline_record_path"), baseline_record_sha256: questionnaireHash(x.baseline_record_sha256, "baseline_record_sha256"), checkpoint_record_path: questionnairePath(x.checkpoint_record_path, "checkpoint_record_path"), checkpoint_record_sha256: questionnaireHash(x.checkpoint_record_sha256, "checkpoint_record_sha256"), prior_saved_workspace_evidence_record_path: questionnairePath(x.prior_saved_workspace_evidence_record_path, "prior_saved_workspace_evidence_record_path"), prior_saved_workspace_evidence_record_sha256: questionnaireHash(x.prior_saved_workspace_evidence_record_sha256, "prior_saved_workspace_evidence_record_sha256"), prior_checkpoint_record_path: questionnairePath(x.prior_checkpoint_record_path, "prior_checkpoint_record_path"), prior_checkpoint_record_sha256: questionnaireHash(x.prior_checkpoint_record_sha256, "prior_checkpoint_record_sha256"), compared_current_imported_response_sha256: questionnaireHash(x.compared_current_imported_response_sha256, "compared_current_imported_response_sha256"), authenticated_ancestry: ancestry, decisions, reconciled: true, issued_at: questionnaireTimestamp(x.issued_at, "issued_at") });
}
export const parseWorkspaceIssuanceRecord = parseQuestionnaireIssuance;
export const validateWorkspaceIssuanceRecord = parseQuestionnaireIssuance;
function parseAdmittedResponse(value: unknown): AdmittedQuestionnaireResponseRecord { const keys = ["schema", "dossier_id", "response_items", "occurrence_inventory", "occurrence_inventory_sha256", "baseline_record_path", "baseline_record_sha256", "checkpoint_record_path", "checkpoint_record_sha256", "workspace_issuance_record_path", "workspace_issuance_record_sha256", "saved_workspace_evidence_record_path", "saved_workspace_evidence_record_sha256", "saved_workspace_snapshot_path", "saved_workspace_snapshot_sha256", "workspace_revision", "workspace_raw_sha256", "source_response_record_path", "source_response_record_sha256", "predecessor_imported_response_sha256"]; const x = questionnaireClosed(value, "$admitted_response", keys); if (x.schema !== QUESTIONNAIRE_ADMITTED_RESPONSE_SCHEMA) throw new TypeError("invalid admitted response schema"); const response_items = Object.freeze(questionnaireArray(x.response_items, "response_items").map(parseQuestionnaireItem)); const inventory = Object.freeze(questionnaireArray(x.occurrence_inventory, "occurrence_inventory").map(parseQuestionnaireOccurrence)); const result = { schema: QUESTIONNAIRE_ADMITTED_RESPONSE_SCHEMA, dossier_id: questionnaireString(x.dossier_id, "dossier_id"), response_items, occurrence_inventory: inventory, occurrence_inventory_sha256: questionnaireHash(x.occurrence_inventory_sha256, "occurrence_inventory_sha256"), baseline_record_path: questionnairePath(x.baseline_record_path, "baseline_record_path"), baseline_record_sha256: questionnaireHash(x.baseline_record_sha256, "baseline_record_sha256"), checkpoint_record_path: questionnairePath(x.checkpoint_record_path, "checkpoint_record_path"), checkpoint_record_sha256: questionnaireHash(x.checkpoint_record_sha256, "checkpoint_record_sha256"), workspace_issuance_record_path: questionnairePath(x.workspace_issuance_record_path, "workspace_issuance_record_path"), workspace_issuance_record_sha256: questionnaireHash(x.workspace_issuance_record_sha256, "workspace_issuance_record_sha256"), saved_workspace_evidence_record_path: questionnairePath(x.saved_workspace_evidence_record_path, "saved_workspace_evidence_record_path"), saved_workspace_evidence_record_sha256: questionnaireHash(x.saved_workspace_evidence_record_sha256, "saved_workspace_evidence_record_sha256"), saved_workspace_snapshot_path: questionnairePath(x.saved_workspace_snapshot_path, "saved_workspace_snapshot_path"), saved_workspace_snapshot_sha256: questionnaireHash(x.saved_workspace_snapshot_sha256, "saved_workspace_snapshot_sha256"), workspace_revision: questionnaireInteger(x.workspace_revision, "workspace_revision", 1), workspace_raw_sha256: questionnaireHash(x.workspace_raw_sha256, "workspace_raw_sha256"), source_response_record_path: questionnairePath(x.source_response_record_path, "source_response_record_path"), source_response_record_sha256: questionnaireHash(x.source_response_record_sha256, "source_response_record_sha256"), predecessor_imported_response_sha256: x.predecessor_imported_response_sha256 === null ? null : questionnaireHash(x.predecessor_imported_response_sha256, "predecessor_imported_response_sha256") } as const; if (result.occurrence_inventory_sha256 !== occurrenceInventorySha256(inventory) || canonicalJson(inventory) !== canonicalJson(occurrenceInventory(response_items))) throw new TypeError("admitted response occurrence inventory mismatch"); return Object.freeze(result); }
async function questionnaireInstallJson(repositoryRoot: string, path: string, value: unknown): Promise<{ readonly path: string; readonly sha256: string }> { const normalized = questionnairePath(path, "record path"); const bytes = utf8(canonicalJson(value)); await installImmutableAuthorityFile(repositoryRoot, normalized, bytes, 0o600); const reopened = await readAuthorityFile(repositoryRoot, normalized); if (Buffer.compare(Buffer.from(reopened), Buffer.from(bytes)) !== 0) throw new TypeError(`questionnaire authority reopen mismatch:${normalized}`); return Object.freeze({ path: normalized, sha256: hashRawBytes(reopened) }); }
async function questionnaireBinding(repositoryRoot: string, path: string): Promise<{ readonly value: unknown; readonly sha256: string }> { const bytes = await readAuthorityFile(repositoryRoot, questionnairePath(path, "authority path")); const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); let value: unknown; try { value = JSON.parse(text); } catch { throw new TypeError(`invalid questionnaire JSON:${path}`); } if (text !== canonicalJson(value)) throw new TypeError(`questionnaire authority is not canonical:${path}`); return { value, sha256: hashRawBytes(bytes) }; }
async function questionnaireReadJson(repositoryRoot: string, path: string): Promise<unknown> { return (await questionnaireBinding(repositoryRoot, path)).value; }
function extractQuestionnairePayload(bytes: Uint8Array | string): QuestionnaireWorkspacePayload {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const payloads = [...text.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]!.trim()).filter(value => value.includes(QUESTIONNAIRE_WORKSPACE_SCHEMA));
  if (payloads.length !== 1) throw new TypeError("questionnaire HTML must embed exactly one workspace payload");
  const parsed = JSON.parse(payloads[0]!);
  const expected = canonicalJson(parsed).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  if (payloads[0] !== expected) throw new TypeError("questionnaire workspace payload is not canonical");
  return parseQuestionnaireWorkspace(parsed);
}
async function renderTrustedWorkspace(workspace: QuestionnaireWorkspacePayload, rendererManifestSha256: string): Promise<Uint8Array> {
  const implementationRoot = resolve(import.meta.dir, "../../../../..");
  const renderer = await loadIdeationSupportRendererSnapshot(implementationRoot);
  if (renderer.sha256 !== rendererManifestSha256) throw new TypeError("questionnaire renderer manifest changed; issue a new workspace");
  return renderIdeationQuestionnaireWorkspaceHtml(workspace, renderer.template_bytes, renderer.stylesheet_bytes);
}
async function questionnaireHead(repositoryRoot: string, slug: string): Promise<{ readonly sha256: string; readonly record: AdmittedQuestionnaireResponseRecord; readonly path: string } | null> {
  let binding: { value: unknown; sha256: string };
  try { binding = await questionnaireBinding(repositoryRoot, questionnaireHeadPath(slug)); } catch (error) { if (error instanceof Error && /NOT_FOUND|not found|ENOENT/i.test(error.message)) return null; throw error; }
  const x = questionnaireClosed(binding.value, "$questionnaire_head", ["schema", "dossier_id", "admitted_response_record_path", "admitted_response_record_sha256", "continuation_checkpoint_record_path", "continuation_checkpoint_record_sha256", "continuation_issuance_record_path", "continuation_issuance_record_sha256"]);
  if (x.schema !== QUESTIONNAIRE_HEAD_SCHEMA || x.dossier_id !== slug) throw new TypeError("invalid questionnaire head schema");
  const path = questionnairePath(x.admitted_response_record_path, "admitted response head path");
  const sha256 = questionnaireHash(x.admitted_response_record_sha256, "admitted response head");
  if (path !== questionnaireAdmittedResponsePath(slug, sha256)) throw new TypeError("noncanonical admitted response head path");
  const admittedBinding = await questionnaireBinding(repositoryRoot, path);
  if (admittedBinding.sha256 !== sha256) throw new TypeError("questionnaire admitted head binding mismatch");
  const record = parseAdmittedResponse(admittedBinding.value);
  const checkpointPath = questionnairePath(x.continuation_checkpoint_record_path, "continuation checkpoint path");
  if (record.dossier_id !== slug || record.predecessor_imported_response_sha256 === sha256) throw new TypeError("questionnaire admitted head record mismatch");
  const checkpointBinding = await questionnaireBinding(repositoryRoot, checkpointPath);
  if (checkpointBinding.sha256 !== questionnaireHash(x.continuation_checkpoint_record_sha256, "continuation checkpoint sha")) throw new TypeError("questionnaire continuation checkpoint hash mismatch");
  const checkpoint = parseQuestionnaireCheckpoint(checkpointBinding.value);
  if (checkpointPath !== questionnaireCheckpointPath(slug, checkpoint.checkpoint_id) || checkpoint.base_imported_response_sha256 !== sha256) throw new TypeError("questionnaire continuation checkpoint head mismatch");
  const issuancePath = questionnairePath(x.continuation_issuance_record_path, "continuation issuance path");
  const issuanceBinding = await questionnaireBinding(repositoryRoot, issuancePath);
  if (issuanceBinding.sha256 !== questionnaireHash(x.continuation_issuance_record_sha256, "continuation issuance sha")) throw new TypeError("questionnaire continuation issuance hash mismatch");
  const issuance = parseQuestionnaireIssuance(issuanceBinding.value);
  if (issuance.issuance_kind !== "continuation" || issuancePath !== questionnaireIssuancePath(slug, issuance.issuance_id) || issuance.checkpoint_record_path !== checkpointPath || issuance.checkpoint_record_sha256 !== checkpointBinding.sha256) throw new TypeError("questionnaire continuation issuance head mismatch");
  return Object.freeze({ sha256, record, path });
}
async function assertAdmittedAncestry(repositoryRoot: string, slug: string, head: { readonly sha256: string; readonly record: AdmittedQuestionnaireResponseRecord; readonly path: string }): Promise<readonly AuthenticatedAncestryEntry[]> {
  const ancestry: AuthenticatedAncestryEntry[] = [];
  const seen = new Set<string>();
  let sha256: string | null = head.sha256;
  let record: AdmittedQuestionnaireResponseRecord | null = head.record;
  while (sha256 !== null && record !== null) {
    if (seen.has(sha256)) throw new TypeError("questionnaire admitted ancestry cycle");
    seen.add(sha256);
    const path = questionnaireAdmittedResponsePath(slug, sha256);
    const binding = await questionnaireBinding(repositoryRoot, path);
    if (binding.sha256 !== sha256) throw new TypeError("questionnaire admitted ancestry hash mismatch");
    record = parseAdmittedResponse(binding.value);
    if (record.dossier_id !== slug) throw new TypeError("questionnaire admitted ancestry dossier mismatch");
    ancestry.push(Object.freeze({ record_path: path, record_sha256: sha256 }));
    sha256 = record.predecessor_imported_response_sha256;
  }
  return Object.freeze(ancestry);
}
async function questionnaireFeedbackItems(repositoryRoot: string, responsePath: string, responseSha256: string): Promise<readonly QuestionnaireResponseItem[]> { const root = questionnaireObject(await questionnaireReadJson(repositoryRoot, responsePath), "$response"); const approval = questionnaireObject(root.approval, "$response.approval"); const feedback = questionnaireArray(approval.feedback, "$response.approval.feedback"); return Object.freeze(feedback.map((entry, index) => { const item = questionnaireObject(entry, `$response.approval.feedback[${index}]`); const feedback_id = questionnaireString(item.feedback_id, "feedback_id"); const target = canonicalJson(item.target); return parseQuestionnaireItem({ occurrence_id: questionnaireOccurrenceIdentity({ response_record_path: responsePath, response_record_sha256: responseSha256, feedback_id, target }), feedback_id, target, response_record_path: responsePath, response_record_sha256: responseSha256, answer_text: typeof item.requested_change === "string" ? item.requested_change : "", validation: "unvalidated", defer_status: "not-deferred", defer_reason: null, rationale: typeof item.rationale === "string" ? item.rationale : "", selected_option: null, context_requests: [], evidence_references: [], notebook_content: "" }); })); }
async function assertBaselineResponseAuthority(repositoryRoot: string, baseline: DossierBaselineRecord): Promise<void> { const state = await reopenSnapshot(repositoryRoot, baseline.source_state_path); await reopenIdeationReturnedResponseAuthority(repositoryRoot, state, baseline.response_record_path); if (ideationStateSha256(state) !== baseline.source_state_sha256) throw new TypeError("questionnaire baseline state hash mismatch"); const responseBinding = await questionnaireBinding(repositoryRoot, baseline.response_record_path); if (responseBinding.sha256 !== baseline.response_record_sha256) throw new TypeError("questionnaire baseline response hash mismatch"); const response = questionnaireClosed(responseBinding.value, "$returned_response", ["schema", "candidate_record_path", "candidate_sha256", "current_candidate_at_import", "current_candidate_at_import_sha256", "response_html_path", "response_html_sha256", "approval"]); const candidatePath = questionnairePath(response.candidate_record_path, "returned response candidate path"); const candidateBinding = await questionnaireBinding(repositoryRoot, candidatePath); const candidate = questionnaireClosed(candidateBinding.value, "$returned_response.candidate", ["schema", "state_snapshot_path", "state_sha256", "substantive_review_authority", "candidate", "candidate_sha256", "candidate_html_path", "candidate_html_sha256", "renderer_manifest", "projection_manifest"]); if (candidate.schema !== "ideation-with-critique/candidate-record/v2" || candidate.state_sha256 !== baseline.source_state_sha256 || candidate.candidate_sha256 !== response.candidate_sha256) throw new TypeError("questionnaire returned response candidate/state binding mismatch"); const approval = questionnaireObject(response.approval, "$returned_response.approval"); if (approval.approval_status !== "changes-requested" && approval.approval_status !== "rejected") throw new TypeError("questionnaire requires returned changes authority"); const actual = await questionnaireFeedbackItems(repositoryRoot, baseline.response_record_path, baseline.response_record_sha256); if (canonicalJson(occurrenceInventory(actual)) !== canonicalJson(baseline.occurrence_inventory) || occurrenceInventorySha256(actual) !== baseline.occurrence_inventory_sha256) throw new TypeError("questionnaire baseline returned-response inventory mismatch"); }
function assertWorkspaceInventory(workspace: QuestionnaireWorkspacePayload, baseline: DossierBaselineRecord): void { if (canonicalJson(occurrenceInventory(workspace.response_items)) !== canonicalJson(baseline.occurrence_inventory) || occurrenceInventorySha256(workspace.response_items) !== baseline.occurrence_inventory_sha256) throw new TypeError("questionnaire protected occurrence inventory mismatch"); }
async function validateQuestionnaireAuthority(repositoryRoot: string, workspace: QuestionnaireWorkspacePayload): Promise<{ readonly baseline: DossierBaselineRecord; readonly checkpoint: CheckpointAuthorityRecord; readonly issuance: WorkspaceIssuanceRecord }> {
  const baselineBinding = await questionnaireBinding(repositoryRoot, workspace.baseline_record_path);
  if (baselineBinding.sha256 !== workspace.baseline_record_sha256) throw new TypeError("questionnaire baseline binding mismatch");
  const baseline = parseQuestionnaireBaseline(baselineBinding.value);
  if (workspace.baseline_record_path !== questionnaireBaselinePath(workspace.dossier_id, baseline.baseline_id)) throw new TypeError("noncanonical baseline path");
  const checkpointBinding = await questionnaireBinding(repositoryRoot, workspace.checkpoint_record_path);
  if (checkpointBinding.sha256 !== workspace.checkpoint_record_sha256) throw new TypeError("questionnaire checkpoint binding mismatch");
  const checkpoint = parseQuestionnaireCheckpoint(checkpointBinding.value);
  if (workspace.checkpoint_record_path !== questionnaireCheckpointPath(workspace.dossier_id, checkpoint.checkpoint_id)) throw new TypeError("noncanonical checkpoint path");
  const issuanceBinding = await questionnaireBinding(repositoryRoot, workspace.workspace_issuance_record_path);
  if (issuanceBinding.sha256 !== workspace.workspace_issuance_record_sha256) throw new TypeError("questionnaire issuance binding mismatch");
  const issuance = parseQuestionnaireIssuance(issuanceBinding.value);
  if (workspace.workspace_issuance_record_path !== questionnaireIssuancePath(workspace.dossier_id, issuance.issuance_id) || workspace.workspace_id !== hashCanonicalJson({ baseline: workspace.baseline_record_sha256, issuance: workspace.workspace_issuance_record_sha256 }) || workspace.dossier_id !== baseline.dossier_id || workspace.dossier_id !== checkpoint.dossier_id || workspace.dossier_id !== issuance.dossier_id || workspace.baseline_id !== baseline.baseline_id || workspace.checkpoint_id !== checkpoint.checkpoint_id || workspace.workspace_issuance_id !== issuance.issuance_id || checkpoint.dossier_identity !== baseline.dossier_identity || checkpoint.baseline_record_path !== workspace.baseline_record_path || checkpoint.baseline_record_sha256 !== workspace.baseline_record_sha256 || checkpoint.source_state_path !== baseline.source_state_path || checkpoint.source_state_sha256 !== baseline.source_state_sha256 || checkpoint.snapshot_inventory_sha256 !== baseline.snapshot_inventory_sha256 || checkpoint.renderer_manifest_sha256 !== baseline.renderer_manifest_sha256 || issuance.baseline_record_path !== workspace.baseline_record_path || issuance.baseline_record_sha256 !== workspace.baseline_record_sha256 || issuance.checkpoint_record_path !== workspace.checkpoint_record_path || issuance.checkpoint_record_sha256 !== workspace.checkpoint_record_sha256) throw new TypeError("questionnaire authority binding contradiction");
  await assertBaselineResponseAuthority(repositoryRoot, baseline);
  assertWorkspaceInventory(workspace, baseline);
  return Object.freeze({ baseline, checkpoint, issuance });
}
async function questionnaireSaveEvidence(repositoryRoot: string, workspace: QuestionnaireWorkspacePayload, bytes: Uint8Array): Promise<{ readonly record: SavedWorkspaceEvidenceRecord; readonly path: string; readonly sha256: string }> { const raw = hashRawBytes(bytes); const snapshotPath = questionnaireSnapshotPath(workspace.dossier_id, raw); await installImmutableAuthorityFile(repositoryRoot, snapshotPath, bytes, 0o600); const snapshot = await readAuthorityFile(repositoryRoot, snapshotPath); if (hashRawBytes(snapshot) !== raw || Buffer.compare(Buffer.from(snapshot), Buffer.from(bytes)) !== 0) throw new TypeError("questionnaire saved workspace snapshot mismatch"); const record = parseQuestionnaireSavedEvidence({ schema: QUESTIONNAIRE_SAVED_WORKSPACE_EVIDENCE_SCHEMA, evidence_id: raw, dossier_id: workspace.dossier_id, baseline_record_path: workspace.baseline_record_path, baseline_record_sha256: workspace.baseline_record_sha256, checkpoint_record_path: workspace.checkpoint_record_path, checkpoint_record_sha256: workspace.checkpoint_record_sha256, workspace_issuance_record_path: workspace.workspace_issuance_record_path, workspace_issuance_record_sha256: workspace.workspace_issuance_record_sha256, workspace_path: questionnaireWorkspacePath(workspace.dossier_id), workspace_sha256: raw, workspace_snapshot_path: snapshotPath, workspace_snapshot_sha256: raw, workspace_revision: workspace.workspace_revision, saved_at: questionnaireNow() }); const binding = await questionnaireInstallJson(repositoryRoot, questionnaireSavedEvidencePath(workspace.dossier_id, raw), record); return Object.freeze({ record, ...binding }); }
async function questionnaireReopenEvidence(repositoryRoot: string, workspace: QuestionnaireWorkspacePayload, path: string, bytes: Uint8Array): Promise<SavedWorkspaceEvidenceRecord> { const raw = hashRawBytes(bytes); const binding = await questionnaireBinding(repositoryRoot, questionnaireSavedEvidencePath(workspace.dossier_id, raw)); const evidence = parseQuestionnaireSavedEvidence(binding.value); if (evidence.evidence_id !== raw || evidence.workspace_path !== path || evidence.workspace_sha256 !== raw || evidence.workspace_snapshot_path !== questionnaireSnapshotPath(workspace.dossier_id, raw) || evidence.workspace_snapshot_sha256 !== raw || evidence.workspace_revision !== workspace.workspace_revision) throw new TypeError("questionnaire saved evidence mismatch"); const snapshot = await readAuthorityFile(repositoryRoot, evidence.workspace_snapshot_path); if (Buffer.compare(Buffer.from(snapshot), Buffer.from(bytes)) !== 0) throw new TypeError("questionnaire saved workspace evidence snapshot mismatch"); return evidence; }
function baselineId(value: Omit<DossierBaselineRecord, "baseline_id">): string { return hashCanonicalJson(value); }
function checkpointId(value: Omit<CheckpointAuthorityRecord, "checkpoint_id">): string { return hashCanonicalJson(value); }
export const ideationSupportRuntimeHooks: {
  before_initial_workspace_lock?: () => Promise<void> | void;
} = {};

export async function issueInitialWorkspace(input: {
  readonly repository_root: string;
  readonly state_snapshot_path: string;
  readonly implementation_root: string;
  readonly response_record_path: string;
}): Promise<{ readonly workspace_path: string; readonly workspace: QuestionnaireWorkspacePayload; readonly baseline: DossierBaselineRecord; readonly baseline_record_path: string; readonly baseline_record_sha256: string; readonly checkpoint: CheckpointAuthorityRecord; readonly checkpoint_record_path: string; readonly checkpoint_record_sha256: string; readonly issuance: InitialWorkspaceIssuanceRecord; readonly workspace_issuance_record_path: string; readonly workspace_issuance_record_sha256: string }> {
  const stateSnapshotPath = questionnairePath(input.state_snapshot_path, "state snapshot path");
  const snapshotMatch = /^ai_docs\/ideation\/\.([a-z0-9]+(?:-[a-z0-9]+)*)\.state-[0-9a-f]{64}\.json$/.exec(stateSnapshotPath);
  if (snapshotMatch === null) throw new TypeError("questionnaire issuance requires canonical state snapshot path");
  const slug = snapshotMatch[1]!;
  const hook = ideationSupportRuntimeHooks.before_initial_workspace_lock;
  if (hook) await hook();

  return withIdeationLineageLock(input.repository_root, slug, async () => {
    const current = await reconcileCurrentIdeationStateAuthority(input.repository_root, slug);
    if (stateSnapshotPath !== current.state_snapshot_path) throw new TypeError("questionnaire issuance requires the current canonical state snapshot");
    const state = await reopenSnapshot(input.repository_root, stateSnapshotPath);
    if (ideationStateSha256(state) !== current.state_sha256) throw new TypeError("questionnaire issuance state snapshot is stale");
    const renderer = await loadIdeationSupportRendererSnapshot(input.implementation_root);
    const responsePath = questionnairePath(input.response_record_path, "initial returned response path");
    const responseAuthority = await reopenIdeationReturnedResponseAuthority(input.repository_root, state, responsePath);
    const responseSha = responseAuthority.response_record_sha256;
    const items = await questionnaireFeedbackItems(input.repository_root, responsePath, responseSha);
    const common = { schema: QUESTIONNAIRE_BASELINE_SCHEMA, dossier_id: state.slug, source_state_path: stateSnapshotPath, source_state_sha256: current.state_sha256, source_head_revision: state.revision, interview_ledger_sha256: hashCanonicalJson(state.interview_exchanges), snapshot_inventory_sha256: hashCanonicalJson(state.review_item_presentations), renderer_manifest_sha256: renderer.sha256, dossier_identity: hashCanonicalJson({ slug: state.slug, run_id: state.run_id }), response_record_path: responsePath, response_record_sha256: responseSha, occurrence_inventory: occurrenceInventory(items), occurrence_inventory_sha256: occurrenceInventorySha256(items) } as const;
    const baseline = parseQuestionnaireBaseline({ ...common, baseline_id: baselineId(common) });
    await assertBaselineResponseAuthority(input.repository_root, baseline);
    const baselineBinding = await questionnaireInstallJson(input.repository_root, questionnaireBaselinePath(state.slug, baseline.baseline_id), baseline);
    const head = await questionnaireHead(input.repository_root, state.slug);
    const checkpointRest = { schema: QUESTIONNAIRE_CHECKPOINT_SCHEMA, dossier_id: state.slug, dossier_identity: baseline.dossier_identity, baseline_record_path: baselineBinding.path, baseline_record_sha256: baselineBinding.sha256, source_state_path: baseline.source_state_path, source_state_sha256: baseline.source_state_sha256, snapshot_inventory_sha256: baseline.snapshot_inventory_sha256, renderer_manifest_sha256: baseline.renderer_manifest_sha256, base_imported_response_sha256: head?.sha256 ?? null, issued_at: questionnaireNow() } as const;
    const checkpoint = parseQuestionnaireCheckpoint({ ...checkpointRest, checkpoint_id: checkpointId(checkpointRest) });
    const checkpointBinding = await questionnaireInstallJson(input.repository_root, questionnaireCheckpointPath(state.slug, checkpoint.checkpoint_id), checkpoint);
    const issuanceRest = { schema: QUESTIONNAIRE_ISSUANCE_SCHEMA, dossier_id: state.slug, issuance_kind: "initial" as const, baseline_record_path: baselineBinding.path, baseline_record_sha256: baselineBinding.sha256, checkpoint_record_path: checkpointBinding.path, checkpoint_record_sha256: checkpointBinding.sha256, issued_at: questionnaireNow() };
    const issuance = parseQuestionnaireIssuance({ ...issuanceRest, issuance_id: hashCanonicalJson(issuanceRest) }) as InitialWorkspaceIssuanceRecord;
    const issuanceBinding = await questionnaireInstallJson(input.repository_root, questionnaireIssuancePath(state.slug, issuance.issuance_id), issuance);
    const workspace = parseQuestionnaireWorkspace({ schema: QUESTIONNAIRE_WORKSPACE_SCHEMA, workspace_id: hashCanonicalJson({ baseline: baselineBinding.sha256, issuance: issuanceBinding.sha256 }), dossier_id: state.slug, baseline_id: baseline.baseline_id, baseline_record_path: baselineBinding.path, baseline_record_sha256: baselineBinding.sha256, checkpoint_id: checkpoint.checkpoint_id, checkpoint_record_path: checkpointBinding.path, checkpoint_record_sha256: checkpointBinding.sha256, workspace_issuance_id: issuance.issuance_id, workspace_issuance_record_path: issuanceBinding.path, workspace_issuance_record_sha256: issuanceBinding.sha256, workspace_revision: 1, selected_occurrence_id: null, response_items: items, navigation_state: { active_view: "workspace", scroll_anchor: null } });
    const bytes = renderIdeationQuestionnaireWorkspaceHtml(workspace, renderer.template_bytes, renderer.stylesheet_bytes);
    await questionnaireSaveEvidence(input.repository_root, workspace, bytes);
    await writeAuthorityFile(input.repository_root, questionnaireWorkspacePath(state.slug), bytes, 0o644);
    return Object.freeze({ workspace_path: questionnaireWorkspacePath(state.slug), workspace, baseline, baseline_record_path: baselineBinding.path, baseline_record_sha256: baselineBinding.sha256, checkpoint, checkpoint_record_path: checkpointBinding.path, checkpoint_record_sha256: checkpointBinding.sha256, issuance, workspace_issuance_record_path: issuanceBinding.path, workspace_issuance_record_sha256: issuanceBinding.sha256 });
  });
}
export async function saveQuestionnaireWorkspace(input: { readonly repository_root: string; readonly workspace_html?: Uint8Array | string }): Promise<{ readonly workspace_path: string; readonly workspace: QuestionnaireWorkspacePayload; readonly evidence: SavedWorkspaceEvidenceRecord; readonly outcome: "saved" | "adopted-identical" }> { if (input.workspace_html === undefined) throw new TypeError("questionnaire save requires HTML"); const supplied = typeof input.workspace_html === "string" ? utf8(input.workspace_html) : Uint8Array.from(input.workspace_html); const proposed = extractQuestionnairePayload(supplied); const path = questionnaireWorkspacePath(proposed.dossier_id); return withIdeationLineageLock(input.repository_root, proposed.dossier_id, async () => { const prior = await readAuthorityFile(input.repository_root, path); const previous = extractQuestionnairePayload(prior); await validateQuestionnaireAuthority(input.repository_root, previous); const proposedAuthority = await validateQuestionnaireAuthority(input.repository_root, proposed); const importedHead = await questionnaireHead(input.repository_root, proposed.dossier_id); if ((importedHead?.sha256 ?? null) !== proposedAuthority.checkpoint.base_imported_response_sha256) throw Object.assign(new TypeError("questionnaire workspace checkpoint is stale"), { code: "QUESTIONNAIRE_CAS_CONFLICT" as const }); if (Buffer.compare(Buffer.from(prior), Buffer.from(supplied)) === 0) return { workspace_path: path, workspace: previous, evidence: await questionnaireReopenEvidence(input.repository_root, previous, path, prior), outcome: "adopted-identical" as const }; const sameAuthority = proposed.baseline_record_path === previous.baseline_record_path && proposed.baseline_record_sha256 === previous.baseline_record_sha256 && proposed.checkpoint_record_path === previous.checkpoint_record_path && proposed.checkpoint_record_sha256 === previous.checkpoint_record_sha256 && proposed.workspace_issuance_record_path === previous.workspace_issuance_record_path && proposed.workspace_issuance_record_sha256 === previous.workspace_issuance_record_sha256; let continuesByRebase = false; if (!sameAuthority && proposedAuthority.issuance.issuance_kind === "rebase") { const previousRaw = hashRawBytes(prior); const previousEvidencePath = questionnaireSavedEvidencePath(previous.dossier_id, previousRaw); await questionnaireReopenEvidence(input.repository_root, previous, path, prior); const previousEvidenceBinding = await questionnaireBinding(input.repository_root, previousEvidencePath); const currentHead = await questionnaireHead(input.repository_root, previous.dossier_id); const rebase = proposedAuthority.issuance; continuesByRebase = rebase.reconciled === true && currentHead !== null && rebase.prior_saved_workspace_evidence_record_path === previousEvidencePath && rebase.prior_saved_workspace_evidence_record_sha256 === previousEvidenceBinding.sha256 && rebase.prior_checkpoint_record_path === previous.checkpoint_record_path && rebase.prior_checkpoint_record_sha256 === previous.checkpoint_record_sha256 && rebase.compared_current_imported_response_sha256 === currentHead.sha256 && proposedAuthority.checkpoint.base_imported_response_sha256 === currentHead.sha256; } if (!sameAuthority && !continuesByRebase) throw Object.assign(new TypeError("questionnaire workspace authority CAS conflict"), { code: "QUESTIONNAIRE_CAS_CONFLICT" as const }); if (proposed.workspace_revision !== previous.workspace_revision + 1) throw Object.assign(new TypeError("questionnaire workspace revision CAS conflict"), { code: "QUESTIONNAIRE_CAS_CONFLICT" as const }); const bytes = await renderTrustedWorkspace(proposed, proposedAuthority.baseline.renderer_manifest_sha256); const evidence = await questionnaireSaveEvidence(input.repository_root, proposed, bytes); await writeAuthorityFile(input.repository_root, path, bytes, 0o644); return { workspace_path: path, workspace: proposed, evidence: evidence.record, outcome: "saved" as const }; }); }
export async function reopenQuestionnaireWorkspace(input: { readonly repository_root: string; readonly slug: string }): Promise<{ readonly workspace_path: string; readonly workspace: QuestionnaireWorkspacePayload; readonly evidence: SavedWorkspaceEvidenceRecord }> { const path = questionnaireWorkspacePath(input.slug); const bytes = await readAuthorityFile(input.repository_root, path); const workspace = extractQuestionnairePayload(bytes); if (workspace.dossier_id !== input.slug) throw new TypeError("questionnaire workspace dossier mismatch"); await validateQuestionnaireAuthority(input.repository_root, workspace); return { workspace_path: path, workspace, evidence: await questionnaireReopenEvidence(input.repository_root, workspace, path, bytes) }; }
interface QuestionnaireAuthorityBinding {
  readonly value: unknown;
  readonly sha256: string;
}

async function recoverStagedQuestionnaireImport(input: {
  readonly repositoryRoot: string;
  readonly slug: string;
  readonly workspace: QuestionnaireWorkspacePayload;
  readonly pending: AdmittedQuestionnaireResponseRecord;
  readonly admittedSha256: string;
}): Promise<ImportedQuestionnaireResponseEvidence | null> {
  const admittedPath = questionnaireAdmittedResponsePath(input.slug, input.admittedSha256);
  let admittedBinding: QuestionnaireAuthorityBinding;
  try {
    admittedBinding = await questionnaireBinding(input.repositoryRoot, admittedPath);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "NOT_FOUND" || code === "ENOENT") return null;
    throw error;
  }
  const admitted = parseAdmittedResponse(admittedBinding.value);
  if (admittedBinding.sha256 !== input.admittedSha256 || canonicalJson(admitted) !== canonicalJson(input.pending)) throw new TypeError("questionnaire staged admitted response mismatch");
  const baselineBinding = await questionnaireBinding(input.repositoryRoot, input.workspace.baseline_record_path);
  const baseline = parseQuestionnaireBaseline(baselineBinding.value);
  if (baselineBinding.sha256 !== input.workspace.baseline_record_sha256 || input.workspace.baseline_record_path !== questionnaireBaselinePath(input.slug, baseline.baseline_id) || baseline.dossier_id !== input.slug || admitted.baseline_record_path !== input.workspace.baseline_record_path || admitted.baseline_record_sha256 !== input.workspace.baseline_record_sha256) throw new TypeError("questionnaire staged baseline binding mismatch");

  const checkpointRest = {
    schema: QUESTIONNAIRE_CHECKPOINT_SCHEMA,
    dossier_id: input.slug,
    dossier_identity: baseline.dossier_identity,
    baseline_record_path: input.workspace.baseline_record_path,
    baseline_record_sha256: input.workspace.baseline_record_sha256,
    source_state_path: baseline.source_state_path,
    source_state_sha256: baseline.source_state_sha256,
    snapshot_inventory_sha256: baseline.snapshot_inventory_sha256,
    renderer_manifest_sha256: baseline.renderer_manifest_sha256,
    base_imported_response_sha256: input.admittedSha256,
    issued_at: questionnaireNow(),
  } as const;
  const expectedCheckpoint = parseQuestionnaireCheckpoint({ ...checkpointRest, checkpoint_id: checkpointId(checkpointRest) });
  const checkpointPath = questionnaireCheckpointPath(input.slug, expectedCheckpoint.checkpoint_id);
  const checkpointBinding = await questionnaireBinding(input.repositoryRoot, checkpointPath);
  const checkpoint = parseQuestionnaireCheckpoint(checkpointBinding.value);
  if (canonicalJson(checkpoint) !== canonicalJson(expectedCheckpoint)) throw new TypeError("questionnaire staged checkpoint binding mismatch");

  const issuanceRest = {
    schema: QUESTIONNAIRE_ISSUANCE_SCHEMA,
    dossier_id: input.slug,
    issuance_kind: "continuation" as const,
    baseline_record_path: input.workspace.baseline_record_path,
    baseline_record_sha256: input.workspace.baseline_record_sha256,
    checkpoint_record_path: checkpointPath,
    checkpoint_record_sha256: checkpointBinding.sha256,
    prior_issuance_record_path: input.workspace.workspace_issuance_record_path,
    prior_issuance_record_sha256: input.workspace.workspace_issuance_record_sha256,
    issued_at: questionnaireNow(),
  };
  const expectedIssuance = parseQuestionnaireIssuance({ ...issuanceRest, issuance_id: hashCanonicalJson(issuanceRest) }) as ContinuationWorkspaceIssuanceRecord;
  const issuancePath = questionnaireIssuancePath(input.slug, expectedIssuance.issuance_id);
  const issuanceBinding = await questionnaireBinding(input.repositoryRoot, issuancePath);
  const issuance = parseQuestionnaireIssuance(issuanceBinding.value);
  if (issuance.issuance_kind !== "continuation" || canonicalJson(issuance) !== canonicalJson(expectedIssuance)) throw new TypeError("questionnaire staged issuance binding mismatch");

  const headValue = { schema: QUESTIONNAIRE_HEAD_SCHEMA, dossier_id: input.slug, admitted_response_record_path: admittedPath, admitted_response_record_sha256: input.admittedSha256, continuation_checkpoint_record_path: checkpointPath, continuation_checkpoint_record_sha256: checkpointBinding.sha256, continuation_issuance_record_path: issuancePath, continuation_issuance_record_sha256: issuanceBinding.sha256 };
  await writeAuthorityFile(input.repositoryRoot, questionnaireHeadPath(input.slug), utf8(canonicalJson(headValue)), 0o600);
  const committed = await questionnaireHead(input.repositoryRoot, input.slug);
  if (committed?.sha256 !== input.admittedSha256) throw new TypeError("questionnaire staged head recovery mismatch");
  return Object.freeze({ admitted_response_record_path: admittedPath, admitted_response_record_sha256: input.admittedSha256, imported_response_head_sha256: input.admittedSha256, continuation_checkpoint: checkpoint, continuation_checkpoint_record_path: checkpointPath, continuation_checkpoint_record_sha256: checkpointBinding.sha256, continuation_issuance: issuance, continuation_issuance_record_path: issuancePath, continuation_issuance_record_sha256: issuanceBinding.sha256 });
}

export async function importQuestionnaireWorkspace(input: { readonly repository_root: string; readonly workspace_path?: string; readonly slug?: string }): Promise<ImportedQuestionnaireResponseEvidence> {
  const slug = input.slug ?? (() => {
    if (input.workspace_path === undefined) throw new TypeError("questionnaire import requires stable workspace path or slug");
    const match = /^ai_docs\/ideation\/([a-z0-9]+(?:-[a-z0-9]+)*)\/questionnaire\.html$/.exec(input.workspace_path);
    if (match === null) throw new TypeError("questionnaire import requires stable workspace path");
    return match[1]!;
  })();
  assertSlug(slug);
  const source = input.workspace_path ?? questionnaireWorkspacePath(slug);
  if (source !== questionnaireWorkspacePath(slug)) throw new TypeError("questionnaire import requires stable workspace path");
  try {
    return await withIdeationLineageLock(input.repository_root, slug, async () => {
    const bytes = await readAuthorityFile(input.repository_root, source);
    const workspace = extractQuestionnairePayload(bytes);
    if (workspace.dossier_id !== slug) throw new TypeError("questionnaire import dossier mismatch");
    const authority = await validateQuestionnaireAuthority(input.repository_root, workspace);
    if (authority.issuance.issuance_kind === "rebase" && authority.issuance.reconciled !== true) throw new TypeError("unresolved rebase questionnaire draft is not importable");
    const evidence = await questionnaireReopenEvidence(input.repository_root, workspace, source, bytes);
    const expectedPredecessor = authority.checkpoint.base_imported_response_sha256;
    const head = await questionnaireHead(input.repository_root, slug);
    const pending = parseAdmittedResponse({
      schema: QUESTIONNAIRE_ADMITTED_RESPONSE_SCHEMA,
      dossier_id: slug,
      response_items: workspace.response_items,
      occurrence_inventory: occurrenceInventory(workspace.response_items),
      occurrence_inventory_sha256: occurrenceInventorySha256(workspace.response_items),
      baseline_record_path: workspace.baseline_record_path,
      baseline_record_sha256: workspace.baseline_record_sha256,
      checkpoint_record_path: workspace.checkpoint_record_path,
      checkpoint_record_sha256: workspace.checkpoint_record_sha256,
      workspace_issuance_record_path: workspace.workspace_issuance_record_path,
      workspace_issuance_record_sha256: workspace.workspace_issuance_record_sha256,
      saved_workspace_evidence_record_path: questionnaireSavedEvidencePath(slug, evidence.evidence_id),
      saved_workspace_evidence_record_sha256: hashRawBytes(await readAuthorityFile(input.repository_root, questionnaireSavedEvidencePath(slug, evidence.evidence_id))),
      saved_workspace_snapshot_path: evidence.workspace_snapshot_path,
      saved_workspace_snapshot_sha256: evidence.workspace_snapshot_sha256,
      workspace_revision: workspace.workspace_revision,
      workspace_raw_sha256: hashRawBytes(bytes),
      source_response_record_path: authority.baseline.response_record_path,
      source_response_record_sha256: authority.baseline.response_record_sha256,
      predecessor_imported_response_sha256: expectedPredecessor,
    });
    const admittedBytes = utf8(canonicalJson(pending));
    const admittedSha = hashRawBytes(admittedBytes);
    if (head !== null && head.sha256 !== expectedPredecessor) throw Object.assign(new TypeError("questionnaire checkpoint CAS conflict"), { code: "QUESTIONNAIRE_CAS_CONFLICT" as const });
    const recovered = await recoverStagedQuestionnaireImport({ repositoryRoot: input.repository_root, slug, workspace, pending, admittedSha256: admittedSha });
    if (recovered !== null) return recovered;
    if ((head?.sha256 ?? null) !== expectedPredecessor) throw Object.assign(new TypeError("questionnaire checkpoint CAS conflict"), { code: "QUESTIONNAIRE_CAS_CONFLICT" as const });

    const continuationRest = { schema: QUESTIONNAIRE_CHECKPOINT_SCHEMA, dossier_id: slug, dossier_identity: authority.baseline.dossier_identity, baseline_record_path: workspace.baseline_record_path, baseline_record_sha256: workspace.baseline_record_sha256, source_state_path: authority.baseline.source_state_path, source_state_sha256: authority.baseline.source_state_sha256, snapshot_inventory_sha256: authority.baseline.snapshot_inventory_sha256, renderer_manifest_sha256: authority.baseline.renderer_manifest_sha256, base_imported_response_sha256: admittedSha, issued_at: questionnaireNow() } as const;
    const checkpoint = parseQuestionnaireCheckpoint({ ...continuationRest, checkpoint_id: checkpointId(continuationRest) });
    const checkpointBinding = await questionnaireInstallJson(input.repository_root, questionnaireCheckpointPath(slug, checkpoint.checkpoint_id), checkpoint);
    const issuanceRest = { schema: QUESTIONNAIRE_ISSUANCE_SCHEMA, dossier_id: slug, issuance_kind: "continuation" as const, baseline_record_path: workspace.baseline_record_path, baseline_record_sha256: workspace.baseline_record_sha256, checkpoint_record_path: checkpointBinding.path, checkpoint_record_sha256: checkpointBinding.sha256, prior_issuance_record_path: workspace.workspace_issuance_record_path, prior_issuance_record_sha256: workspace.workspace_issuance_record_sha256, issued_at: questionnaireNow() };
    const issuance = parseQuestionnaireIssuance({ ...issuanceRest, issuance_id: hashCanonicalJson(issuanceRest) }) as ContinuationWorkspaceIssuanceRecord;
    const issuanceBinding = await questionnaireInstallJson(input.repository_root, questionnaireIssuancePath(slug, issuance.issuance_id), issuance);
    const admittedPath = questionnaireAdmittedResponsePath(slug, admittedSha);
    await installImmutableAuthorityFile(input.repository_root, admittedPath, admittedBytes, 0o600);
    if (hashRawBytes(await readAuthorityFile(input.repository_root, admittedPath)) !== admittedSha) throw new TypeError("admitted response reopen mismatch");
    const headValue = { schema: QUESTIONNAIRE_HEAD_SCHEMA, dossier_id: slug, admitted_response_record_path: admittedPath, admitted_response_record_sha256: admittedSha, continuation_checkpoint_record_path: checkpointBinding.path, continuation_checkpoint_record_sha256: checkpointBinding.sha256, continuation_issuance_record_path: issuanceBinding.path, continuation_issuance_record_sha256: issuanceBinding.sha256 };
    await writeAuthorityFile(input.repository_root, questionnaireHeadPath(slug), utf8(canonicalJson(headValue)), 0o600);
    const committed = await questionnaireHead(input.repository_root, slug);
    if (committed?.sha256 !== admittedSha) throw new TypeError("questionnaire head commit mismatch");
    return Object.freeze({ admitted_response_record_path: admittedPath, admitted_response_record_sha256: admittedSha, imported_response_head_sha256: admittedSha, continuation_checkpoint: checkpoint, continuation_checkpoint_record_path: checkpointBinding.path, continuation_checkpoint_record_sha256: checkpointBinding.sha256, continuation_issuance: issuance, continuation_issuance_record_path: issuanceBinding.path, continuation_issuance_record_sha256: issuanceBinding.sha256 });
    });
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "IDEATION_LINEAGE_LOCKED") throw Object.assign(new TypeError("questionnaire checkpoint CAS conflict"), { code: "QUESTIONNAIRE_CAS_CONFLICT" as const });
    throw error;
  }
}
export async function issueRebaseWorkspace(input: { readonly repository_root: string; readonly workspace: QuestionnaireWorkspacePayload; readonly prior_saved_workspace_evidence_record_path: string; readonly prior_checkpoint_record_path: string; readonly current_checkpoint_record_path: string; readonly decisions: readonly RebaseDecision[] }): Promise<{ readonly workspace: QuestionnaireWorkspacePayload; readonly issuance: RebaseWorkspaceIssuanceRecord; readonly workspace_issuance_record_path: string; readonly workspace_issuance_record_sha256: string }> {
  const draft = parseQuestionnaireWorkspace(input.workspace);
  return withIdeationLineageLock(input.repository_root, draft.dossier_id, async () => {
    const priorEvidenceBinding = await questionnaireBinding(input.repository_root, input.prior_saved_workspace_evidence_record_path);
    const priorEvidence = parseQuestionnaireSavedEvidence(priorEvidenceBinding.value);
    if (priorEvidence.workspace_snapshot_path !== questionnaireSnapshotPath(draft.dossier_id, priorEvidence.workspace_snapshot_sha256)) throw new TypeError("questionnaire rebase noncanonical prior snapshot path");
    const priorSnapshot = await readAuthorityFile(input.repository_root, priorEvidence.workspace_snapshot_path);
    if (hashRawBytes(priorSnapshot) !== priorEvidence.workspace_snapshot_sha256) throw new TypeError("questionnaire rebase prior snapshot hash mismatch");
    const prior = extractQuestionnairePayload(priorSnapshot);
    await validateQuestionnaireAuthority(input.repository_root, prior);
    if (draft.dossier_id !== prior.dossier_id || draft.workspace_revision !== prior.workspace_revision || draft.workspace_id !== prior.workspace_id || draft.baseline_record_path !== prior.baseline_record_path || draft.baseline_record_sha256 !== prior.baseline_record_sha256 || draft.checkpoint_record_path !== prior.checkpoint_record_path || draft.checkpoint_record_sha256 !== prior.checkpoint_record_sha256 || draft.workspace_issuance_record_path !== prior.workspace_issuance_record_path || draft.workspace_issuance_record_sha256 !== prior.workspace_issuance_record_sha256 || priorEvidence.workspace_revision !== prior.workspace_revision || priorEvidence.workspace_path !== questionnaireWorkspacePath(draft.dossier_id) || input.prior_checkpoint_record_path !== prior.checkpoint_record_path) throw new TypeError("questionnaire rebase stale or unsaved workspace");
    const priorCheckpointBinding = await questionnaireBinding(input.repository_root, input.prior_checkpoint_record_path);
    if (priorCheckpointBinding.sha256 !== prior.checkpoint_record_sha256) throw new TypeError("questionnaire rebase prior checkpoint mismatch");
    const currentHead = await questionnaireHead(input.repository_root, draft.dossier_id);
    if (currentHead === null) throw new TypeError("questionnaire rebase requires an admitted head");
    const ancestry = await assertAdmittedAncestry(input.repository_root, draft.dossier_id, currentHead);
    const currentCheckpointBinding = await questionnaireBinding(input.repository_root, input.current_checkpoint_record_path);
    const currentCheckpoint = parseQuestionnaireCheckpoint(currentCheckpointBinding.value);
    const currentBaselineBinding = await questionnaireBinding(input.repository_root, currentHead.record.baseline_record_path);
    const currentBaseline = parseQuestionnaireBaseline(currentBaselineBinding.value);
    if (currentHead.record.baseline_record_sha256 !== currentBaselineBinding.sha256 || input.current_checkpoint_record_path !== questionnaireCheckpointPath(draft.dossier_id, currentCheckpoint.checkpoint_id) || currentCheckpoint.base_imported_response_sha256 !== currentHead.sha256 || currentCheckpoint.dossier_id !== draft.dossier_id || currentCheckpoint.baseline_record_path !== currentHead.record.baseline_record_path || currentCheckpoint.baseline_record_sha256 !== currentHead.record.baseline_record_sha256 || currentBaseline.dossier_id !== draft.dossier_id) throw new TypeError("questionnaire rebase current checkpoint or baseline mismatch");
    await assertBaselineResponseAuthority(input.repository_root, currentBaseline);
    const feedbackMap = (items: readonly QuestionnaireResponseItem[], label: string): ReadonlyMap<string, QuestionnaireResponseItem> => {
      const map = new Map(items.map(item => [item.feedback_id, item]));
      if (map.size !== items.length) throw new TypeError(`questionnaire rebase duplicate ${label} feedback_id`);
      return map;
    };
    const priorByFeedback = feedbackMap(prior.response_items, "prior");
    const currentByFeedback = feedbackMap(currentHead.record.response_items, "current");
    const draftByFeedback = feedbackMap(draft.response_items, "draft");
    const feedbackIds = [...new Set([...priorByFeedback.keys(), ...currentByFeedback.keys()])].sort();
    const differences = feedbackIds.filter(feedbackId => hashCanonicalJson(priorByFeedback.get(feedbackId) ?? null) !== hashCanonicalJson(currentByFeedback.get(feedbackId) ?? null));
    const decisions = Object.freeze([...input.decisions].map(decision => Object.freeze({ ...decision })));
    if (decisions.length !== differences.length || decisions.some((decision, index) => decision.question_id !== differences[index] || decision.prior_item_sha256 !== (priorByFeedback.has(decision.question_id) ? hashCanonicalJson(priorByFeedback.get(decision.question_id)!) : null) || decision.current_item_sha256 !== (currentByFeedback.has(decision.question_id) ? hashCanonicalJson(currentByFeedback.get(decision.question_id)!) : null))) throw new TypeError("questionnaire rebase decisions are forged, incomplete, or unsorted");
    const decisionByFeedback = new Map(decisions.map(decision => [decision.question_id, decision]));
    const responseItems = currentHead.record.response_items.map(current => {
      const priorItem = priorByFeedback.get(current.feedback_id);
      const decision = decisionByFeedback.get(current.feedback_id);
      if (priorItem === undefined) {
        if (decision?.disposition === "carry-local") throw new TypeError("questionnaire rebase cannot carry a missing local feedback item");
        if (decision?.disposition !== "manual-merge") return current;
        const merged = draftByFeedback.get(current.feedback_id);
        if (merged === undefined || canonicalJson(occurrence(merged)) !== canonicalJson(occurrence(current))) throw new TypeError("questionnaire rebase manual merge protected tuple mismatch");
        return parseQuestionnaireItem({ ...merged, ...occurrence(current) });
      }
      if (decision === undefined || decision.disposition === "keep-current" || decision.disposition === "discard-local") return current;
      if (decision.disposition === "carry-local") return parseQuestionnaireItem({ ...priorItem, ...occurrence(current) });
      const merged = draftByFeedback.get(current.feedback_id);
      if (merged === undefined || (canonicalJson(occurrence(merged)) !== canonicalJson(occurrence(current)) && canonicalJson(occurrence(merged)) !== canonicalJson(occurrence(priorItem)))) throw new TypeError("questionnaire rebase manual merge protected tuple mismatch");
      return parseQuestionnaireItem({ ...merged, ...occurrence(current) });
    });
    for (const feedbackId of priorByFeedback.keys()) if (!currentByFeedback.has(feedbackId) && decisionByFeedback.get(feedbackId)?.disposition !== "discard-local") throw new TypeError("questionnaire rebase removed feedback requires discard-local");
    if ([...draftByFeedback.keys()].some(feedbackId => !currentByFeedback.has(feedbackId) && decisionByFeedback.get(feedbackId)?.disposition !== "discard-local") || canonicalJson(occurrenceInventory(responseItems)) !== canonicalJson(currentBaseline.occurrence_inventory)) throw new TypeError("questionnaire rebase final occurrence inventory mismatch");
    const issuanceRest = { schema: QUESTIONNAIRE_ISSUANCE_SCHEMA, dossier_id: draft.dossier_id, issuance_kind: "rebase" as const, baseline_record_path: currentHead.record.baseline_record_path, baseline_record_sha256: currentHead.record.baseline_record_sha256, checkpoint_record_path: input.current_checkpoint_record_path, checkpoint_record_sha256: currentCheckpointBinding.sha256, prior_saved_workspace_evidence_record_path: input.prior_saved_workspace_evidence_record_path, prior_saved_workspace_evidence_record_sha256: priorEvidenceBinding.sha256, prior_checkpoint_record_path: input.prior_checkpoint_record_path, prior_checkpoint_record_sha256: priorCheckpointBinding.sha256, compared_current_imported_response_sha256: currentHead.sha256, authenticated_ancestry: ancestry, decisions, reconciled: true as const, issued_at: questionnaireNow() };
    const issuance = parseQuestionnaireIssuance({ ...issuanceRest, issuance_id: hashCanonicalJson(issuanceRest) }) as RebaseWorkspaceIssuanceRecord;
    const issuanceBinding = await questionnaireInstallJson(input.repository_root, questionnaireIssuancePath(draft.dossier_id, issuance.issuance_id), issuance);
    const selected = draft.selected_occurrence_id !== null && responseItems.some(item => item.occurrence_id === draft.selected_occurrence_id) ? draft.selected_occurrence_id : null;
    const workspace = parseQuestionnaireWorkspace({ ...draft, workspace_id: hashCanonicalJson({ baseline: currentBaselineBinding.sha256, issuance: issuanceBinding.sha256 }), baseline_id: currentBaseline.baseline_id, baseline_record_path: currentHead.record.baseline_record_path, baseline_record_sha256: currentBaselineBinding.sha256, checkpoint_id: currentCheckpoint.checkpoint_id, checkpoint_record_path: input.current_checkpoint_record_path, checkpoint_record_sha256: currentCheckpointBinding.sha256, workspace_issuance_id: issuance.issuance_id, workspace_issuance_record_path: issuanceBinding.path, workspace_issuance_record_sha256: issuanceBinding.sha256, workspace_revision: prior.workspace_revision + 1, selected_occurrence_id: selected, response_items: responseItems });
    await validateQuestionnaireAuthority(input.repository_root, workspace);
    if ((await questionnaireHead(input.repository_root, draft.dossier_id))?.sha256 !== currentHead.sha256) throw Object.assign(new TypeError("questionnaire rebase head CAS conflict"), { code: "QUESTIONNAIRE_CAS_CONFLICT" as const });
    return Object.freeze({ workspace, issuance, workspace_issuance_record_path: issuanceBinding.path, workspace_issuance_record_sha256: issuanceBinding.sha256 });
  });
}
