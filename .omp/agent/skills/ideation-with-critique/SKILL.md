---
name: ideation-with-critique
description: This skill MUST be used when developing or committing an idea through structured interview, critique, protected approval, or a Deep Scope handoff. Defined solution comparisons belong to solution-research; specification versioning belongs to spec-stratify.
---

# Ideation with Critique

Develop an idea into a closed, critique-tested semantic record and publish only its exact Markdown projection with a deterministic receipt. The closed Ideation state is semantic authority; the shared approval-dossier runtime is final human-approval and publication authority.

## Lifecycle and authority map

1. **Terminal interview is the default.** Ask one focused Socratic question at a time. Persistence creates or replaces canonical state and immutable snapshots only; it creates no HTML.
2. **Accepted answers are durable before reliance.** Append each accepted answer or correction as the next immutable `Q#` exchange. Preserve every predecessor exchange byte-for-byte; a correction appends a backward-referencing exchange instead of editing history. Derived active/superseded status is never persisted input.
3. **Support HTML is optional.** An Ideation support dossier is an immutable, cumulative, read-only projection of an exact immutable state snapshot. It is non-authoritative and cannot collect durable feedback, approve, publish, mutate state, authorize Deep Scope, or enter candidate, response, publication, recovery, receipt, or handoff APIs.
4. **Final approval is mandatory and singular.** After closed state and a current substantive `PASS`, create one current verifier-protected candidate through the shared approval runtime. This is the only human-approval surface and the only saved-response path.
5. **Downstream authority is Markdown plus receipt.** Deep Scope receives only current published `ai_docs/ideation/<slug>.md` and its verified receipt provenance, never HTML or browser state.

## Active mutable questionnaire workspace

The active intermediary is one runtime-issued, stable workspace at `ai_docs/ideation/<slug>/questionnaire.html`. It is distinct from preserved historical immutable support bytes. The workspace payload embeds the runtime-issued baseline, checkpoint, and issuance path/SHA bindings plus exact `response_items`; occurrence IDs, feedback IDs, targets, response-record bindings, inventory, baseline, checkpoint, issuance, and navigation bindings are protected provenance. Only answer text, validation, defer status/reason, rationale, selected option, context requests, evidence references, notebook content, and local navigation are mutable.

Save validates the embedded payload and its immutable bindings before atomically replacing only the stable workspace path; unchanged saves are idempotent and failures leave prior bytes unchanged. LocalStorage is draft-only cache, incompatible drafts are discarded, and only downloaded `questionnaire.html` is importable after runtime validation. Workspace import admits immutable response evidence and continuation checkpoint/issuance bindings only; it cannot approve, publish, hand off, or mutate canonical state. Canonical corrections/revisions use the explicit validated Ideation transition and append a new `Q#` exchange.
Terminal state persistence itself creates no HTML. A separately issued active workspace creates the stable questionnaire HTML; historical support remains evidence-only import and is never the questionnaire path.

## Canonical files and locking

1. Persist current state at `ai_docs/ideation/<slug>.state.json`; immutable snapshots preserve the adjacent predecessor chain.
2. Serialize mutable current-state, candidate-pointer, response, publication, recovery, and handoff authority through the per-slug lineage lock. Reconcile the current head to the unique immutable chain tip before relying on it.
3. Candidate creation is read-only over the reconciled saved state. Support and candidate creation do not create state revisions.
4. Historical `state/v7` authority is unsupported provenance: identify and reject it; never validate it as v8, migrate it, reconstruct authority from it, or parse/rewrite historical legacy HTML.
5. Render exact Markdown only from validated state. Never reconstruct semantics from Markdown, HTML, a DOM, visible text, drafts, screenshots, or a response comment.

## Sensitive-content boundary

1. Before lineage-lock lookup, acquisition, or any filesystem operation for a newly appended exchange, run the deterministic shared high-confidence secret detector against the exact question and accepted answer bytes.
2. On a match, fail with content-free `IDEATION_EXCHANGE_SENSITIVE_CONTENT` fields limited to `field` and `category`. Never include rejected content, excerpts, hashes, paths derived from the rejected bytes, or detector details that reveal the value; make no filesystem change.
3. This detector recognizes only its declared deterministic high-confidence classes. It does **not** claim to detect arbitrary personal data, confidential prose, privileged communications, health data, financial data, or every secret format.
4. Operators must not enter raw personal data, privileged material, private customer content, or credentials. Redact or replace such content before accepting it even when the detector reports no match.

## Run terminal-first Socratic ideation

1. Begin with one open question about the problem, affected people, context, constraints, or success signal. Do not propose a solution before intent is established.
2. After the first intent answer, classify commitment as `exploration`, `planning`, or `building` and persist it through an accepted-answer transition.
3. Adapt depth: Exploration covers intent and a sketch outcome; Planning adds boundaries; Building adds execution and applicable risks.
4. Before relying on a newly accepted fact, persist and reopen the adjacent state revision with exactly one appended exchange whose affected targets equal the actual semantic delta.
5. Ask one focused follow-up at a time. Offer meaningful alternatives and a disconfirming question while defining boundaries.
6. Preserve stable IDs without renumbering: `G#`, `C#`, `D#`, `A#`, `E#`, `U#`, and `V#`. Keep assumptions separate from decisions and retain evidence referenced by the interview ledger.

## Run commitment critique
1. Trigger commitment critique only when an approach is committed, a medium-or-higher confidence Building decision is introduced, or a non-goal is established. Do not trigger it during uncommitted Exploration.
2. Launch exactly two independent blind `pi/slow` critics against the same closed snapshot and bounded question. Reject one, three, duplicate, non-blind, or non-`pi/slow` critic records.
3. Preserve bounded findings, evidence, explicit dispositions, rationale, and dissent. Continue the terminal interview after presenting critique; conversational readiness is not approval.
## Create optional historical support dossiers

The terminal default is no support generation. Historical support is preserved only as an immutable, cumulative, read-only projection of an exact snapshot and one recorded trigger:

- `explicit-request`
- `commitment-review-boundary`
- `final-review-boundary`
- `returned-changes`
- `material-commitment-change`
- `show-stopper-contradiction`

Historical support is never the active questionnaire path, has no mutable latest pointer, and is never overwritten. It contains the full ordered accepted Q&A ledger plus bounded target, evidence, and provenance references; it contains no full state JSON, exact final Markdown, workspace payload, drafts, feedback editor, approval controls, protected payload, response, publication, or receipt claims. Support paths remain explicitly non-authoritative and cannot enter candidate, response, publication, recovery, receipt, or handoff APIs.

Apply checks proportionally: verify historical support identity, trigger eligibility, immutability, complete ledger/status/supersession content, escaping, keyboard navigation, responsive Queue/Exchange/Provenance views, no-JS/print completeness, no external resources, and the authority notice. Mark candidate-only checks—feedback serialization, approval gating, protected payload, exact Markdown drawer, and final actions—`N/A` for historical support rather than imposing final-candidate obligations.

## Prepare the mandatory protected final dossier

1. Parse `max_review_rounds` only from the exact final token `^max_review_rounds=([1-5])$`; default to `3`. Preserve that persisted cap across adjacent revisions.
2. Require the canonical substantive panel: exactly four blind baseline roles (`correctness`, `security`, `simplicity-maintainability`, `alignment`) plus zero to two distinctly triggered blind specialists.
3. Persist each immutable substantive reviewer result at its closed `result_path`; preserve stable finding occurrence IDs, evidence, dissent, and gate lineage across bounded retries.
4. Preserve immutable result evidence, finding occurrence lineage, dissent, and gate precedence `INCOMPLETE` → `BLOCK` → `UNRESOLVED` → `PASS`. Retries within an episode remain bounded by `state.max_review_rounds`. A verifier-admitted changes-requested or rejected response may open a later episode only with exact predecessor candidate/response provenance.
5. Require a current substantive `PASS`, all readiness gates, and complete Ideation review presentations before candidate creation.
6. Create the candidate only from the canonical current saved-state path. Use one current candidate pointer and preserve historical candidates as immutable stale provenance after state or renderer advancement.

## Ideation-only four-option authority

Every governed Ideation final review target—goal, every P0 criterion, every active decision, every assumption, and every bounded ambiguity—must have one canonical presentation containing exactly four distinct, semantically complete options in source order and one recommendation naming one of those option IDs.

Each option must independently state its label, mechanism or output, benefit, omission/cost/uncertainty, downstream consequence, and evidence IDs. Missing, duplicate, incomplete, unbound, or non-parity option data blocks readiness; the renderer must never invent or pad options.

The shared renderer is workflow-neutral and supports the closed variants `context-only` and `four-option-decision`. Ideation always projects `four-option-decision`. Deep Scope, Spec Stratify, fixtures, and other generic callers explicitly retain `context-only`; they do not acquire Ideation's four-option obligation, and saved-response/publication authority is unchanged.

## Final reviewer information architecture

1. Use a Decision Navigator with three distinct regions: persistent item queue, focused review/context pane, and item-bound feedback pane. On narrow screens expose Queue, Review, and Feedback tabs over the same target-keyed draft state.
2. Give each region one role. `key_points` is the one-to-three-bullet queue/dock orientation summary and is always complete and unclipped. `research_summary` is concise evidence synthesis. The option block is the only comparison surface. The recommendation and rationale explain the preferred canonical option without restating key points, research, or option prose.
3. Preserve all four conditional feedback controls—feedback kind, requested change, rationale, and evidence IDs. Each label must visibly say that feedback is optional and have concise, programmatically associated pointer and keyboard help. After `Request edit` or `Add proposal`, state which fields become required. Preserve `No change` as an explicit reviewed disposition with no durable feedback.
4. Keep target-keyed drafts and dispositions isolated across item and tab navigation. Gate approval until every item is reviewed and feedback is cleared; enable request-changes only for valid feedback. Preserve protected-payload and verifier behavior.
5. Keep exact Markdown, hashes, native visuals, source locators, and authority metadata in a collapsed source drawer outside the primary reading flow. Use only deterministic native SVG/table visuals with complete textual equivalents when canonical semantics justify them; otherwise use `no_visual`. Generated imagery is not part of support v1 or the protected candidate.

## Authoring review and validation

1. Against the same exact final candidate bytes and evidence, run independent UX/design, frontend/accessibility, and authority/security review plus complete Chromium traversal at 1440×900, 1024×768, and 390×844.
2. Repair concrete defects at source, regenerate, and repeat the complete round. The default authoring review/fix cap is three; explicit user authority may extend one complete candidate through rounds four and five, but round six is prohibited. This authoring cap is separate from `state.max_review_rounds` and does not append canonical substantive rounds.
3. Preserve no-JS, print, keyboard, focus, responsive tabs, draft isolation, option/recommendation parity, contrast, reflow, forced-colour, reduced-motion, overflow, resource, console, and final-action evidence.
4. Reuse the completed root-cause analysis, prototypes, selection evidence, and screenshots as evidence inputs. Do not regenerate the ten-way exploration.

## Import, publish, recover, and hand off

1. Import saved responses only through `importIdeationResponseFromSavedPath`. Support paths fail explicitly as non-authoritative.
2. Treat draft, feedback-bearing, changes-requested, and rejected responses as revision input. Only a current verifier-admitted `approved` response with the exact declaration and no feedback is approval authority.
3. Publish only through `publishIdeationMarkdownFromSavedRecords`; reopen current state, candidate, response, substantive `PASS`, unchanged Markdown, and canonical receipt. Never rerender Markdown during publication.
4. Recover only current saved authority. Create downstream input only with `createDeepScopeHandoffFromSavedAuthority({ repository_root, slug })` while current authority is locked and reverified.
5. Do not launch any mandatory model review after human approval.
6. Instruct the next workflow exactly:

   `/design-deep-scope ai_docs/ideation/<slug>.md max_review_rounds=<state.max_review_rounds>`

## Prohibitions

- No automatic support generation, mutable support artifact, legacy HTML alias, HTML-derived state, complete state source in support, generated imagery, compatibility handoff alias, second final renderer, second publication path, network dependency, or post-approval model review.
- Never supply support HTML, final candidate HTML, DOM state, or historical caller-selected authority to Deep Scope.
