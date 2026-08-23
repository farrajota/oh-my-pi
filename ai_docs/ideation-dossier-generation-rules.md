# Ideation dossier generation rules

**Status:** Normative authoring rules for `/design-ideation-with-critique`
**Primary audience:** Ideation workflow implementers and operators
**Complexity:** Advanced
**Prerequisites:** Closed Ideation state/runtime contracts and shared approval-dossier runtime
**Last updated:** 2026-08-13

## 1. Three-layer lifecycle

The workflow has three deliberately separate layers. A fresh implementation must preserve every boundary below.

| Layer | Default/trigger | Mutable input | Artifact | Authority |
|---|---|---|---|---|
| Terminal interview | Default; one focused question at a time | Accepted answer or correction | Canonical state plus immutable snapshot and appended `Q#` exchange | Sole semantic authoring path |
| Optional support dossier | Only one eligible declared trigger | None; exact immutable snapshot only | Immutable cumulative read-only HTML plus support record | Non-authoritative; never approval evidence |
| Mandatory final approval dossier | Closed state, readiness gates, current substantive `PASS` | Protected target-bound reviewer response | One current verifier-protected candidate and immutable history | Sole human-approval and saved-response path |

Terminal persistence **MUST NOT** generate HTML. Support creation and candidate creation **MUST NOT** create an Ideation state revision. The final protected dossier is mandatory before publication; support can never substitute for it.

### 1.1 Active mutable questionnaire workspace

The active intermediary is the single stable `ai_docs/ideation/<slug>/questionnaire.html`, not a historical support dossier. Runtime-issued baseline, checkpoint, and workspace-issuance records are immutable path/SHA bindings; inventory, occurrence IDs, feedback IDs, targets, response-record bindings, and those authority bindings are protected. Answer text, validation, defer status/reason, rationale, selected option, context requests, evidence references, notebook content, and local navigation are mutable. Save validates and atomically replaces only the stable path, with unchanged-save idempotence and prior-byte preservation on failure.

LocalStorage is draft-only and incompatible drafts are invalidated. Only downloaded self-contained `questionnaire.html` can cross the runtime import boundary. Import admits immutable response evidence and continuation checkpoint/issuance bindings only; it cannot approve, publish, hand off, or mutate canonical Ideation. Canonical corrections/revisions require the explicit validated transition and append a new `Q#` exchange.
Terminal state persistence itself creates no HTML; only a separately issued active workspace creates the stable questionnaire HTML. Historical support remains immutable evidence-only import, never the questionnaire path.

## 2. Terminal-first Socratic interview

1. Ask one focused question at a time. Begin with problem, affected people, context, constraints, or success; do not propose a solution before intent is established.
2. Classify commitment after the first intent answer as `exploration`, `planning`, or `building`. Adapt depth accordingly.
3. Before relying on any accepted answer or correction, persist and reopen the adjacent canonical state revision.
4. Append exactly one immutable exchange for an accepted-answer transition. IDs are positional `Q1`, `Q2`, … and must be compared numerically so `Q10` follows `Q9`.
5. Preserve every predecessor exchange byte-for-byte. A correction appends a new exchange whose `supersedes_exchange_id` points backward to one currently active exchange. Active/superseded status is derived, never caller-authored state.
6. The new exchange's sorted affected targets must equal the actual mapped semantic delta. An accepted answer cannot also change final-review history.
7. Keep issued semantic IDs stable without renumbering: `G#`, `C#`, `D#`, `A#`, `E#`, `U#`, and `V#`. Retain evidence referenced by any persisted exchange.
8. Non-answer revisions are limited to the exact permitted final-review retry or response-driven later-episode transitions. They cannot change mapped semantic fields or append exchanges.

## 3. Sensitive-content lock before persistence

1. Scan every newly appended exact question and accepted answer with the shared deterministic high-confidence secret detector before lineage-lock lookup/acquisition or any filesystem operation.
2. A match **MUST** fail with `IDEATION_EXCHANGE_SENSITIVE_CONTENT`, containing only `field` and the closed detector `category`. The failure must not include content, excerpt, hash, path derived from the rejected bytes, or secret-specific diagnostic text, and it must leave the filesystem unchanged.
3. The detector is deterministic and recognizes only declared high-confidence classes such as private keys, bearer/JWT tokens, provider tokens, and authorization credentials. It **does not claim to detect arbitrary personal data** or every confidential/secret format.
4. Operators **MUST NOT** enter raw personal data, customer-private material, health or financial data, privileged communications, or credentials. Redact or replace them before acceptance; a detector no-match is not permission to persist them.

## 4. Canonical state and current authority
1. Closed Ideation state is the sole semantic authority. HTML, DOM text, browser state, local drafts, screenshots, visible summaries, and conversational approval are never semantic authority.
2. Persist current state at `ai_docs/ideation/<slug>.state.json` and preserve immutable adjacent snapshots. Serialize mutable current authority through the per-slug lineage lock and reconcile the head to the unique immutable chain tip.
3. Candidate creation reads only the reconciled current state and immutable snapshot. It never calls persistence to manufacture or repair a state revision.
4. Historical `state/v7` JSON is minimally schema-decoded only to reject unsupported authority. It is never validated as v8, migrated, reconstructed, or rewritten. Historical legacy HTML is never parsed or rewritten.
5. Render exact Markdown from validated state only. Publication never parses or rerenders Markdown from HTML.

## 5. Optional immutable historical support dossiers

Historical support is preserved as immutable evidence only. It is not the active questionnaire workspace and remains content-addressed, cumulative, read-only, and never overwritten. The stable mutable path is governed only by the active workspace rules above.

### 5.1 Exact trigger set

The terminal default is no support generation. One of these exact triggers must be selected, recorded, hashed, and visibly rendered:

- `explicit-request`
- `commitment-review-boundary`
- `final-review-boundary`
- `returned-changes`
- `material-commitment-change`
- `show-stopper-contradiction`

`explicit-request` may target a descriptor-verified current or historical immutable snapshot in the unique canonical lineage and must visibly label it `current` or `historical`. Every other trigger is admissible only for the reconciled current snapshot and its exact closed lifecycle predicate.

### 5.2 Content and immutability

1. Historical support HTML and its record are content-addressed by state, renderer, and trigger. They are create-or-adopt-identical immutable artifacts, have no mutable latest pointer, and are never overwritten.
2. Support is cumulative: `covered_exchange_ids` equals the complete ledger in canonical order. Callers cannot select a subset.
3. Include artifact/revision/hash identity, selected trigger, authority notice, complete ordered accepted Q&A ledger, derived status and supersession navigation, affected targets, bounded evidence/source locators, and provenance.
4. Exclude full state JSON, exact final Markdown, workspace payload, browser Markdown download, forms, local storage, drafts, feedback, declaration, approval controls/status, protected payload, candidate/response/publication/receipt data, and Deep Scope authorization claims.
5. Support cannot enter candidate, response import, publication, recovery, receipt, or handoff APIs. Those APIs must reject recognizable support paths explicitly as `non-authoritative-support`.

### 5.3 Historical support information architecture and checks

- Desktop: chronological `Q#` queue, one focused Exchange pane, and Provenance pane.
- Narrow screen: Queue / Exchange / Provenance tabs over the same read-only DOM.
- No-JavaScript and print: full ordered ledger, statuses, supersession, targets, evidence, provenance, and authority notice in linear form.
- Zero-exchange genesis: identity/provenance banner and explanatory empty state; no inactive queue/filter/navigation controls.

Apply validation proportionally. Historical support must pass trigger/identity/reopen, immutability, escaping, content completeness, keyboard/tab, no-JS, print, responsive, overflow, focus, and resource/console checks. Candidate-only feedback serialization, protected payload, approval gating, exact Markdown drawer, and final actions are explicitly `N/A` for historical support.

## 6. Commitment critique and substantive review caps

1. Trigger commitment critique only for a committed approach, a medium-or-higher-confidence Building decision, or a non-goal. Uncommitted Exploration does not trigger it.
2. Use exactly two independent blind `pi/slow` critics with the same closed state and bounded question. Preserve findings, evidence, dispositions, rationale, and dissent.
3. The canonical final-document panel uses exactly four blind baseline roles—`correctness`, `security`, `simplicity-maintainability`, and `alignment`—plus zero to two distinctly triggered specialists.
4. Preserve immutable result evidence and gate order `INCOMPLETE` → `BLOCK` → `UNRESOLVED` → `PASS`.
5. Persisted `state.max_review_rounds` bounds substantive retries within each episode. The separate authoring UX/accessibility/authority review has an absolute maximum of three complete review/fix rounds. Neither cap may be silently expanded or conflated with the other.
6. A verifier-admitted changes-requested or rejected response may open a later episode only when bound to exact predecessor state, candidate, imported response, and import-currentness evidence. There is no post-human-approval model review.

## 7. Mandatory protected final authority

1. Create exactly one logical current protected candidate only after state is closed, readiness gates pass, and the current substantive gate is `PASS`.
2. Candidate identity binds current state, exact Markdown, Ideation projection, shared renderer, native visuals, submission record, and current-candidate pointer. Historical candidates remain immutable provenance and become stale after authority advances.
3. The shared protected response schema is the only durable reviewer-feedback and approval path. Browser convenience state is not authority.
4. Only a current verifier-admitted `approved` response with the exact declaration and no feedback may publish. Draft, feedback-bearing, changes-requested, rejected, stale, malformed, or support evidence cannot publish.
5. Publication installs unchanged Markdown at `ai_docs/ideation/<slug>.md` and a canonical receipt at `ai_docs/ideation/<slug>.receipt.json`, then reopens both and approved evidence while current authority remains locked.

## 8. Ideation-only four-option decision authority

Every final Ideation review target—goal, each P0 criterion, each active decision, each assumption, and each bounded ambiguity—must have one canonical `four-option-decision` presentation.

1. Each item contains exactly four distinct options in source order and one recommendation naming one option ID.
2. Every option independently contains a label, mechanism/output, benefit, omission/cost/uncertainty, downstream consequence, and evidence IDs. All four receive comparable semantic and visual treatment.
3. Missing, duplicate, filler, incomplete, unbound, or non-parity options block readiness. The renderer never derives alternatives from prose, invents them, or pads a short list.
4. Protected Markdown and visible HTML must carry equivalent option, recommendation, consequence, evidence, and uncertainty semantics.
5. The generic shared renderer remains workflow-neutral with the closed variants `context-only` and `four-option-decision`. Ideation always uses `four-option-decision`; Deep Scope, Spec Stratify, fixtures, and other callers explicitly use `context-only` and do not inherit Ideation's option invariant. Their saved-response/publication authority remains unchanged.

## 9. Distinct reviewer regions and content roles

The protected final dossier uses a Decision Navigator with three distinct regions: item queue, focused review/context, and item-bound feedback. On narrow screens these become Queue, Review, and Feedback tabs over the same target-keyed state.

Each content region has one non-duplicative role:

- `key_points`: one to three complete queue/dock orientation bullets; never clipped, ellipsized, line-clamped, hidden, or repeated as research prose.
- `research_summary`: concise evidence synthesis following Key points.
- options: the sole comparison surface for the four alternatives.
- recommendation and rationale: identify and explain the preferred option without reproducing key points, research, or option text.

Exact source/authority material remains in a collapsed source drawer outside the primary reading flow.

## 10. Feedback controls and gating

1. Each item has explicit `No change`, `Request edit`, and `Add proposal` dispositions. Conditional fields remain hidden until edit or proposal is selected.
2. Preserve all four conditional controls: feedback kind, requested change, rationale, and evidence IDs.
3. Every control label visibly states that feedback is optional and has concise programmatically associated keyboard and pointer help. After edit/proposal selection, state which fields are required for a valid response.
4. Drafts and dispositions are keyed by exact target and survive item/pane/tab navigation without cross-item bleed.
5. `No change` is an explicit reviewed state with no durable feedback. Approval stays disabled until every target is reviewed and feedback is cleared. Request-changes is enabled only for valid feedback; non-draft final actions require confirmation.

## 11. Visual and source policy

1. Use deterministic native SVG or semantic tables only when canonical relationship or quantitative semantics justify a visual. Provide a complete textual equivalent and bounded evidence/provenance.
2. Prefer `no_visual` to invention. Do not infer labels, edges, values, causality, rankings, completeness, safety, authorization, or consequences.
3. Generated imagery is not part of support v1 or the protected candidate. Do not retain image-generation, image-dialog, complete-source, or legacy intermediate-HTML guidance in this lifecycle.
4. Support exposes only bounded locators/provenance. The protected candidate may expose exact Markdown, hashes, native visual authority, and source locators in its collapsed source drawer.

## 12. Authoring review and browser evidence

1. Review the same exact final candidate bytes and evidence from three independent perspectives: UX/design, frontend/accessibility, and authority/security.
2. Exercise every applicable route at 1440×900, 1024×768, and 390×844, including keyboard/focus, responsive tabs, target-keyed draft isolation, feedback help, four-option parity, final-action gating, source drawer, no-JS, print, 200% reflow, reduced motion, forced colours, contrast, overflow, and page/console/resource errors.
3. Repair concrete defects at source, regenerate, and repeat the complete round. Round three blocks acceptance if any concrete defect remains unresolved.
4. Reuse completed root-cause analysis, ten prototypes, selection evidence, and prior screenshots. Do not regenerate the ten-way exploration during this cutover.

## 13. Import, recovery, and Deep Scope handoff

1. Import response evidence only through `importIdeationResponseFromSavedPath` and current candidate authority.
2. Publish through `publishIdeationMarkdownFromSavedRecords`; recover only current saved authority.
3. Create the downstream handoff only through `createDeepScopeHandoffFromSavedAuthority({ repository_root, slug })`. Raw HTML, DOM extraction, browser state, visual state, support artifacts, and caller-selected historical receipts are prohibited.
4. After verifier-admitted approval, do not launch semantic-fidelity, dossier-fidelity, or any other model review.
5. Emit exactly:

   `/design-deep-scope ai_docs/ideation/<slug>.md max_review_rounds=<state.max_review_rounds>`

## 14. Release questions

A fresh agent must be able to answer all of these without inference:

- Is the next action terminal persistence, optional support creation, or mandatory protected approval?
- Has every accepted answer been durably appended before use and screened at the pre-write sensitive-content boundary?
- Is support tied to exactly one eligible trigger, immutable, cumulative, and visibly non-authoritative?
- Is the current final candidate the only approval surface and bound to current substantive `PASS`?
- Does every Ideation target have exactly four complete canonical options and one recommendation, while generic callers remain `context-only`?
- Are Key points, research, options, recommendation, and feedback separate and non-duplicative?
- Are all four optional feedback controls labelled and helped, with correct conditional requirements and target isolation?
- Were support checks applied proportionally and final candidate checks applied completely within preserved caps?
- Is downstream input only receipt-bound Markdown with the exact Deep Scope command and no post-approval model review?
