# Ideation dossier production checklist

**Audience:** Operators and fresh implementation agents
**Prerequisites:** `skill://ideation-with-critique`, shared approval runtime, and the generation rules
**Last updated:** 2026-08-13

Use this checklist to execute the terminal interview, optional support lifecycle, and mandatory protected approval lifecycle without crossing authority boundaries.

## 0. Select the current lifecycle layer

- [ ] **Terminal:** Ask one focused Socratic question and persist accepted state; do not generate HTML.
- [ ] **Optional support:** Create immutable read-only HTML only for one eligible declared trigger; do not collect feedback or approval.
- [ ] **Mandatory final:** Create the sole protected approval candidate only after closed state and current substantive `PASS`.
- [ ] Never substitute support HTML for the final protected dossier.
- [ ] Never use HTML, DOM text, browser state, screenshots, drafts, or conversation as semantic, approval, publication, or handoff authority.

**Immediate stop:** stop if the proposed action mixes layers, creates support unconditionally, mutates a support artifact, or routes support into an authority API.

## 0.1 Active mutable questionnaire workspace

- [ ] Use one stable `ai_docs/ideation/<slug>/questionnaire.html` for the active intermediary; do not repurpose content-addressed historical support bytes.
- [ ] Verify baseline, checkpoint, and workspace-issuance record path/SHA bindings before rendering or saving.
- [ ] Keep inventory, occurrence IDs, feedback IDs, targets, response-record bindings, baseline/checkpoint/issuance bindings protected; expose only the approved answer/workflow/navigation fields as mutable.
- [ ] Save through runtime validation and atomic replacement; unchanged save succeeds idempotently and failed validation preserves prior bytes.
- [ ] Treat LocalStorage as draft-only; invalidate incompatible drafts and never import a draft. Only downloaded self-contained `questionnaire.html` crosses the runtime import boundary.
- [ ] Import admits immutable response evidence and continuation checkpoint/issuance bindings only. Browser actions cannot approve, publish, hand off, or mutate canonical state; corrections use the explicit validated Ideation transition.
Terminal state persistence itself creates no HTML; a separately issued active workspace creates HTML, while historical support remains evidence-only import and never the questionnaire path.

## 1. Terminal-first interview and durable acceptance

- [ ] Parse only an exact final `max_review_rounds=1|2|3|4|5`; default to `3`; reject malformed, duplicate, or non-final forms.
- [ ] Ask one open intent question, then one focused follow-up at a time.
- [ ] Classify commitment as `exploration`, `planning`, or `building` after the first intent answer.
- [ ] Before relying on a new answer or correction, prepare one adjacent accepted-answer state revision.
- [ ] Append exactly one next positional `Q#` exchange; preserve the predecessor ledger byte-for-byte.
- [ ] For a correction, point backward to one active exchange rather than editing history.
- [ ] Ensure the exchange's sorted affected targets exactly equal the mapped semantic delta.
- [ ] Do not combine an exchange append with a final-review history change.
- [ ] Preserve stable `G#`, `C#`, `D#`, `A#`, `E#`, `U#`, and `V#` IDs and retain ledger-referenced evidence.
- [ ] Reopen the immutable predecessor and persisted successor before relying on the transition.

## 2. Sensitive-content pre-write boundary

- [ ] Before lineage-lock lookup/acquisition or any filesystem operation, scan the exact new question and accepted answer with the shared deterministic high-confidence secret detector.
- [ ] If rejected, confirm `IDEATION_EXCHANGE_SENSITIVE_CONTENT` contains only `field` and `category`.
- [ ] Confirm the error contains no rejected content, excerpt, hash, derived path, or secret-revealing diagnostic.
- [ ] Confirm rejection wrote nothing.
- [ ] Do not claim arbitrary personal-data detection. The detector covers only its declared deterministic high-confidence classes.
- [ ] Do not enter raw personal data, customer-private material, health/financial data, privileged communications, or credentials. Redact or replace them even when the detector finds no match.

## 3. Canonical authority and state cutover

- [ ] Treat closed v8 state and immutable snapshots as sole semantic authority.
- [ ] Serialize mutable head/candidate/response/publication/recovery/handoff authority through the per-slug lineage lock.
- [ ] Reconcile the current head to the unique immutable chain tip before relying on it.
- [ ] Confirm terminal persistence creates no HTML.
- [ ] Confirm support and candidate operations create no state revision.
- [ ] Confirm candidate creation reads only the reconciled current saved state and snapshot.
- [ ] Reject historical v7 state as unsupported; never validate as v8, migrate, reconstruct, or rewrite it.
- [ ] Never parse or rewrite historical legacy HTML.
- [ ] Render exact Markdown only from validated state.

## 4. Commitment critique and review limits

- [ ] Trigger commitment critique only for a committed approach, medium-or-higher-confidence Building decision, or non-goal.
- [ ] Run exactly two independent blind `pi/slow` critics on the same snapshot and bounded question.
- [ ] Preserve findings, evidence, dispositions, rationale, and dissent.
- [ ] For final substantive review, use exactly four blind baseline roles plus zero to two distinctly triggered blind specialists.
- [ ] Preserve gate order `INCOMPLETE` → `BLOCK` → `UNRESOLVED` → `PASS` and immutable finding/occurrence lineage.
- [ ] Enforce persisted `state.max_review_rounds` per substantive episode.
- [ ] Keep the authoring review/fix cap at three by default; permit rounds four and five only under explicit user authority, and reject round six.
- [ ] Never launch model review after verifier-admitted human approval.

## 5. Historical support trigger admission

Historical support is optional, immutable, and never the active questionnaire workspace. Use the active workspace checklist in section 0.1 for mutable questionnaire actions.
## 6. Optional immutable historical support artifact contract

- [ ] Create content-addressed immutable HTML and record only for an eligible historical support trigger; adopt only byte-identical existing artifacts.
- [ ] Confirm there is no mutable latest-support pointer and no overwrite path.
- [ ] Include artifact kind, revision/hash, trigger, current/historical label where applicable, and explicit notice that support cannot approve, publish, mutate state, or authorize Deep Scope.
- [ ] Include exact question/accepted answer, derived status, supersession navigation, affected targets, bounded evidence/source locators, and provenance.
- [ ] Exclude full state JSON, exact final Markdown, workspace payload, Markdown download, forms, local storage, drafts, feedback, approval/declaration, protected payload, candidate, response, publication, receipt, or Deep Scope claims.
- [ ] Confirm historical support paths are explicitly rejected by candidate, response, publication, recovery, receipt, and handoff APIs.

The active questionnaire workspace is governed by section 0.1 and is never treated as support evidence.

## 7. Proportional historical support usability checks

- [ ] Desktop uses Q# Queue / focused Exchange / Provenance.
- [ ] Tablet/mobile use Queue / Exchange / Provenance tabs over the same read-only DOM.
- [ ] Keyboard selection, previous/next, Home/End, filters, and provenance disclosure work when exchanges exist.
- [ ] Zero-exchange support shows the authority/provenance banner and empty explanation without inactive queue controls.
- [ ] No-JavaScript and print preserve the full ledger, statuses, supersession, targets, evidence, provenance, and authority notice.
- [ ] State-derived strings are escaped text only; locators are text, not caller-controlled links.
- [ ] There are no external resources, page/console/resource errors, unintended overflow, or inaccessible focus.
- [ ] Mark feedback serialization, protected payload, approval gating, exact Markdown drawer, and final actions `N/A`; do not impose candidate-only checks on historical support.


## 8. Final readiness and current candidate

- [ ] State is closed, blockers are removed, at least one P0 criterion exists, required commitment critique is complete, and current substantive gate is `PASS`.
- [ ] Every final review target has a complete Ideation presentation.
- [ ] Create the candidate only from the canonical current saved-state path.
- [ ] Confirm one immutable submission record and one current-candidate pointer bind current state, renderer, Ideation projection, and candidate records.
- [ ] Preserve historical candidates unchanged; reject them as stale after state, renderer, or projection advancement.
- [ ] Confirm the protected candidate is the only durable reviewer-feedback and human-approval surface.

## 9. Ideation-only four-option authority

For goal, every P0 criterion, active decision, assumption, and bounded ambiguity:

- [ ] Exactly four distinct canonical options exist in source order.
- [ ] One recommendation names one of those exact option IDs.
- [ ] Every option has label, mechanism/output, benefit, omission/cost/uncertainty, downstream consequence, and evidence IDs.
- [ ] All options receive comparable semantic and visual treatment.
- [ ] No filler, synthesis from prose, renderer padding, missing option, or accidental visual privilege exists.
- [ ] Protected Markdown and visible HTML preserve equivalent options, recommendation, consequences, evidence, and uncertainty.
- [ ] Ideation projects `four-option-decision` only.
- [ ] Generic Deep Scope, Spec Stratify, fixtures, and other callers remain explicit `context-only`; they do not acquire Ideation option requirements or changed response/publication authority.

## 10. Distinct final reviewer regions

- [ ] Desktop has persistent queue, focused review/context, and item-bound feedback regions.
- [ ] Narrow layouts expose Queue / Review / Feedback tabs over the same target-keyed draft state.
- [ ] `key_points` is the one-to-three-bullet queue/dock orientation summary and is complete and unclipped at every viewport.
- [ ] `research_summary` is concise evidence synthesis and does not restate Key points.
- [ ] The options block is the sole comparison surface.
- [ ] Recommendation/rationale identifies and explains the preferred option without restating Key points, research, or option prose.
- [ ] Exact Markdown, hashes, native visuals, source locators, and authority metadata remain in a collapsed source drawer outside the primary flow.

## 11. Feedback controls and action gates

- [ ] Each target has `No change`, `Request edit`, and `Add proposal` dispositions.
- [ ] Conditional fields remain hidden until edit or proposal is selected.
- [ ] Preserve all four conditional controls: feedback kind, requested change, rationale, evidence IDs.
- [ ] Every control label visibly states that feedback is optional.
- [ ] Every control has concise programmatically associated pointer and keyboard help.
- [ ] After edit/proposal selection, the UI states which fields are required for a valid response.
- [ ] Draft values and disposition survive item, pane, and tab navigation and do not bleed between targets.
- [ ] `No change` creates an explicit reviewed state with no durable feedback.
- [ ] Approval remains disabled until all targets are reviewed and feedback is cleared.
- [ ] Request-changes is enabled only with valid feedback; non-draft final actions require confirmation.

## 12. Visual and source limits

- [ ] Use deterministic native SVG/table only for supported canonical relationship or quantitative semantics.
- [ ] Provide a complete textual equivalent and bounded evidence/provenance.
- [ ] Prefer `no_visual` to invented labels, edges, values, causality, rankings, completeness, safety, authorization, or consequences.
- [ ] Confirm generated imagery is absent from support v1 and the protected candidate.
- [ ] Confirm support contains bounded locators/provenance only, not full source/state/Markdown authority.

## 13. Three-perspective authoring review

Against the same exact final candidate bytes and evidence:

- [ ] UX/design reviews hierarchy, density, distinct regions, key points, four-option parity, recommendation visibility, responsive composition, and comprehension.
- [ ] Frontend/accessibility reviews DOM/ARIA, keyboard/pointer, focus, target isolation, feedback help, tabs, contrast, reflow, reduced motion, forced colours, overflow, scripts, and saved-response behavior.
- [ ] Authority/security reviews state boundary, renderer variant boundary, protected payload, provenance, stable targets, currentness, import/publication, support rejection, and handoff integrity.
- [ ] Concrete defects are repaired at source, the artifact is regenerated, and the complete round repeats.
- [ ] No more than three authoring review/fix rounds occur; unresolved concrete defects at round three block acceptance.
- [ ] Completed prototype/root-cause/selection evidence is reused; the ten-way exploration is not regenerated.

## 14. Final Chromium and print/no-JS evidence

At 1440×900, 1024×768, and 390×844:

- [ ] Traverse every final review target and all four options.
- [ ] Verify Key points are fully visible and content regions are non-duplicative.
- [ ] Exercise all dispositions and every conditional feedback field with distinct values on at least two targets.
- [ ] Verify exact target restoration and no cross-item bleed across tabs/panes.
- [ ] Verify optional labels/help and conditional-required messaging.
- [ ] Verify approval/request-changes gates and confirmation behavior.
- [ ] Verify queue/tabs keyboard operation, visible focus, source drawer, no-JS inventory, viewport-bound print, 200% reflow, contrast, reduced motion, forced colours, and no horizontal overflow.
- [ ] Record zero dossier-attributable page, console, and resource errors.

## 15. Response import and later episodes

- [ ] Save and import only through the protected response mechanism and `importIdeationResponseFromSavedPath`.
- [ ] Reopen current-candidate pointer, candidate/submission, renderer/projection bindings, candidate HTML, and exact saved response.
- [ ] Treat draft, feedback-bearing, changes-requested, and rejected responses as revision input, never approval.
- [ ] A later response-driven episode binds exact predecessor state, candidate, response, and import-currentness evidence and cannot replay response evidence.
- [ ] Only a current verifier-admitted `approved` response with exact declaration and no feedback is approval authority.

## 16. Publication, recovery, and handoff

- [ ] Publish only with `publishIdeationMarkdownFromSavedRecords` while current authority is locked and reverified.
- [ ] Install unchanged Markdown at `ai_docs/ideation/<slug>.md` and receipt at `ai_docs/ideation/<slug>.receipt.json`; reopen exact evidence before success.
- [ ] Recover only current saved authority; reject historical, stale, tampered, partial, or support evidence.
- [ ] Create Deep Scope input only with `createDeepScopeHandoffFromSavedAuthority({ repository_root, slug })`.
- [ ] Supply only receipt-bound Markdown/provenance, never support/final HTML, DOM/browser/visual state, or caller-selected historical receipts.
- [ ] Do not run a model review after approval.
- [ ] Emit exactly: `/design-deep-scope ai_docs/ideation/<slug>.md max_review_rounds=<state.max_review_rounds>`.

## 17. Completion record

- [ ] Current state/snapshot/ledger identity and sensitive-content boundary result recorded.
- [ ] Support record(s), trigger(s), current/historical labels, hashes, and proportional evidence recorded when support was requested or triggered.
- [ ] Commitment critics, substantive episode cap/results, gate, and immutable findings recorded.
- [ ] Current candidate/submission/pointer, renderer/projection, Markdown, native visual, and authority hashes recorded.
- [ ] Four-option and recommendation parity recorded for every target.
- [ ] Three-perspective authoring evidence and complete three-viewport final evidence recorded within caps.
- [ ] Saved response, verifier result, publication, receipt, recovery, and saved-authority handoff reopened.
- [ ] No legacy HTML alias, mutable/automatic support, generated imagery, complete-source support, generic four-option imposition, or post-approval review language remains.

**Done means:** every applicable item passes; support-only checks are explicitly proportional; one current protected final authority publishes unchanged receipt-bound Markdown; and the exact Deep Scope command is the only downstream instruction.
