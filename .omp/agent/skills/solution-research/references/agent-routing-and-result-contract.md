# Agent routing and result contract

This reference defines how a solution-research phase discovers material domains, selects work from the live roster, transports worker results, and accepts immutable worker artifacts. It does not define research scoring, publication, budgets, or model routing.

## 1. Discover domains and decide materiality

1. Inventory the problem statement, goals, non-goals, hard constraints, taxonomy and failure modes, evaluation criteria, evidence requirements, implementation boundaries, and phase checkpoint. Record every plausible domain or concern before selecting work.
2. Classify each inventory item as exactly one of:
   - `MATERIAL`: omission could change admissibility, correctness, safety, evidence sufficiency, a phase decision, or the proposed implementation;
   - `NOT_MATERIAL`: omission cannot affect those outcomes under the frozen frame;
   - `UNKNOWN`: available information cannot yet determine materiality.
3. Record the basis, affected phase, owner, and provenance for every classification. Do not turn an `UNKNOWN` into `NOT_MATERIAL` merely because no worker is available.
4. Resolve an `UNKNOWN` with the narrowest authoritative source available: the frozen frame, repository/runtime evidence, the relevant domain owner, or an explicitly assigned discovery task. Reconcile conflicting classifications at the next phase checkpoint and preserve the conflict until resolved.
5. Repeat the inventory and reconciliation at frame freeze, before each materially different phase, after a failed or partial dispatch, and before parent synthesis. A newly material domain creates missing coverage; it does not retroactively make an unrelated result sufficient.

## 2. Non-exclusive domain-trigger map

Use this map only as a discovery hint. It is neither a fixed roster nor a requirement to dispatch one worker per entry; examples do not establish eligibility.

| Domain | Discovery hints |
| --- | --- |
| Systems | component boundaries, operating-system/runtime behavior, resource ownership, lifecycle, failure containment |
| Data | schemas, data quality, lineage, migration, retention, query semantics, analytical validity |
| Distributed systems | consistency, ordering, retries, partitions, coordination, concurrency, replication |
| API | contracts, compatibility, versioning, errors, idempotency, clients, integration boundaries |
| Security | trust boundaries, authentication, authorization, privacy, abuse, threat impact |
| SRE/DevOps | deployment, observability, incidents, rollback, runbooks, operational load, ownership |
| Performance | latency, throughput, capacity, resource cost, contention, tail behavior, scaling |
| Customer validation | user outcome, workflow fit, usability, adoption, support burden, acceptance evidence |
| Pricing | cost model, unit economics, packaging, incentives, budget exposure, value capture |
| Strategy | objectives, sequencing, reversibility, opportunity cost, competitive or organizational fit |
| Regulatory | jurisdiction, obligations, auditability, retention, accessibility, safety, compliance risk |
| Language architecture | parsing, type or schema semantics, compiler/interpreter boundaries, compatibility, static analysis |
| Bounded simplification | simplest viable baseline, removable complexity, lifecycle cost, local versus system-wide change |

Domains may overlap. Select a domain only when the frozen frame makes its perspective material or when it resolves an `UNKNOWN`; do not dispatch duplicated perspectives solely to increase agreement.

## 3. Live-roster selection

For each proposed assignment, perform these steps in order:

1. Enumerate the agent definitions that are currently dispatchable. Treat current definitions, permissions, availability, native output restrictions, and native contracts as authoritative; do not use a remembered or fixed eligible-agent pool.
2. Shortlist definitions using their descriptions and the domain-trigger map. The map is advisory and cannot override a definition's actual contract.
3. Inspect each shortlisted definition in full, including its native input/output contract, permissions, availability, and authorship restrictions. Verify runtime availability immediately before dispatch.
4. Filter candidates by the operation, material domain, phase, authority, resolved prerequisites, permissions, output compatibility, and authorship/independence requirements. Reject a candidate that cannot produce the assigned artifact or would review its own work.
5. Resolve overlaps with explicit task/slice boundaries and phase-specific independence. Discovery and DFS primary ownership is disjoint; quorum, critique, and re-review may intentionally assess the same versioned artifact when distinct independence groups are required. Retain the smallest set justified by material coverage plus the phase's minimum independent-assessment requirement. Never treat a user hard maximum or frozen run budget as a prohibited cosmetic workflow quota.
6. Record consequential alternatives that were considered and rejected, with the rejection reason (for example: unavailable, insufficient authority, incompatible output, duplicate coverage, or unresolved prerequisite).
7. Dispatch only the selected set. Do not invent invocation identity, resolved model/provider identity, or other post-dispatch runtime facts before the runtime supplies them. Classification and selector resolution remain solely in `reviewed-execution-task-escalation`; this reference must not duplicate or replace that skill.

There is no fixed roster, universal anchor, mandatory task-count floor, or workflow-specific concurrency ceiling here. A logical wave is the phase's frozen set of prerequisite-ready assignments; runtime concurrency schedules that set.

## 4. Coverage record

Keep these dimensions separate for every material domain, assignment, and slice:

- **Assignment coverage**: `planned`, `dispatched`, `completed`, `failed`, `blocked`, or `not_required`; record task/slice identity, phase, prerequisites, and the reason for the terminal state.
- **Accepted-result coverage**: `not_returned`, `invalid`, `stale`, `partial`, `payload_validated`, `destination_preflighted`, `materialized`, or `accepted`; record the artifact path, frame revision, and exact covered slices when available. A returned result is not accepted coverage until all acceptance gates pass.
- **Evidence sufficiency**: `sufficient`, `conditional`, `insufficient`, or `unknown`; record supporting provenance, unresolved gaps, whether the gap could change the phase decision, and the decisive reconciliation or validation action.

Parent ownership, synthesis, or agreement never satisfies a checkpoint requiring independent assessment. Mark parent-owned coverage separately and do not count it as an independent worker result.

## 5. Independence, overlap, and provenance

Apply phase-specific rules:

- **Discovery and hypothesis work** must remain blind to peer conclusions where the phase requires blindness. Give each task a disjoint slice or explicitly bounded perspective.
- **Comparative or evidence work** must give surviving alternatives comparable disconfirming attention when applicable. Overlap is permitted only when the second task has a distinct question, source set, or failure mode; record the relationship.
- **Synthesis** is parent-authored. Workers contribute immutable, independently attributable slices; they do not silently merge peer results.
- **Critique and re-review** must be performed by a role with no authorship of the reviewed artifact. A critic may not repair its own artifact and then count that repair as independent review.

Assign an independence/correlation group to every material claim and result. Correlate claims sharing a model/provider, source, retrieval path, prompt lineage, upstream artifact, or other common causal input. Agreement inside one group is correlated corroboration, not independent evidence. Preserve dissent and use provenance to qualify confidence; never substitute majority vote for evidence.

## 6. Worker transport envelope

Transport a result in an envelope containing at least:

```yaml
contract_version: <frozen contract version>
task_id: <parent-derived stable task identity>
slice_id: <parent-derived stable slice identity>
candidate_id: <parent-derived stable candidate identity, required only for DFS>
frame_revision: <frozen frame revision>
artifact_type: <assigned artifact schema>
status: complete | partial | invalid | failed
markdown_body: <exact returned Markdown string>
missing_coverage: []
```

`task_id`, `slice_id`, and any DFS `candidate_id` must equal the identities reserved before dispatch or candidate-path creation. Use `task-<slug>-<digest12>`, `slice-<slug>-<digest12>`, and `candidate-<slug>-<digest12>`: the parent NFKD-normalizes the descriptive label, removes combining marks, lowercases it, replaces non-ASCII-alphanumeric runs with `-`, trims `-`, retains at most 32 ASCII slug characters with `item` as the empty fallback, and appends the first 12 lowercase hexadecimal SHA-256 characters of the complete canonical identity. Each component is at most 64 ASCII bytes and never embeds a runtime invocation unknown before dispatch. `missing_coverage` lists every unaddressed or uncertain assigned item, with a reason when known. The `markdown_body` must be a complete Markdown artifact satisfying the assigned schema, including its ordinary artifact metadata block (`artifact_type`, `topic_id`, `frame_revision`, `created_at_utc`, `producer_role`, and `source_refs`). Worker-authored metadata is descriptive artifact metadata; authoritative runtime identity comes only from the dispatch record.

## 7. Byte-exact materialization

Define canonical artifact bytes as exactly the UTF-8 encoding of the returned `markdown_body` string. Compute their byte length and SHA-256 before materialization so destination preflight can compare any existing artifact without writing. The materializer MUST NOT trim the body, normalize newlines, prepend or append metadata, add wrappers, or apply parent edits. After preflight passes, the worker artifact at its reserved phase path is byte-identical to the validated returned body; semantic acceptance occurs only after the write or idempotent no-op and manifest verification succeed.

Record runtime invocation identity, authoritative resolved model/provider identity, materializer identity, reserved destination, canonical byte length, and the SHA-256 of those canonical bytes only in the existing `execution-report.md` task/artifact manifest. Do not create a sidecar, wrapper-based artifact hash, or second artifact representation. Do not claim a runtime identity before dispatch; obtain mandatory identity fields from the post-dispatch job record.

## 8. Acceptance and recovery

Use these ordered states:

`planned -> dispatched -> identity-verified -> payload-validated -> destination-preflighted -> materialized -> accepted`

- `identity-verified` requires the post-dispatch job record and a match to the requested route and stable task/slice/frame identity. Missing or mismatched mandatory identity is an environment failure; the result is not semantic evidence.
- `payload-validated` requires the envelope fields, frame revision, artifact type, complete Markdown schema, metadata block, and missing-coverage declaration to be valid.
- `destination-preflighted` requires the proposed location's task/slice IDs and any DFS candidate ID to equal the reservation, the path derived from that reserved identity to match the reserved destination, and the manifest reservation to match. It also requires no duplicate or superseded assignment and either no existing destination or an existing destination whose canonical bytes and identity match exactly. A different-byte, identity, reservation, duplicate, or path conflict stops before any write.
- `materialized` means an atomic create-if-absent write succeeded, or a byte-identical existing destination was verified as an idempotent no-op, and the exact canonical bytes and materialization facts were recorded in the manifest. It is not yet semantic acceptance.
- `accepted` requires post-materialization verification of the destination bytes and manifest with no unresolved conflict. No result may be used semantically before this state.

Retain invalid, stale, failed, and partial envelopes as recovery records; never silently coerce them to complete. A stale frame, task, slice, or superseded assignment remains stale even if its prose appears useful. Retry or replacement follows the governing execution controls and receives explicit missing-coverage accounting.

Recovery is idempotent only when the same task/slice/path identity resolves to the same canonical bytes. Destination preflight may classify a matching existing artifact as a no-op; revalidate its bytes and manifest before acceptance. If the same reserved identity has different bytes, or the path, reservation, assignment, or identity conflicts, record the conflict before materialization and do not write, overwrite, merge, or choose silently; resolve it with a new explicit task/slice identity or an owner decision recorded in the execution report. Never use a partial, invalid, stale, or conflicting result as semantic evidence.

## 9. Authorship and worker-artifact paths

Workers own the semantic analysis in their assigned body and its cited provenance. The parent owns orchestration, exact-byte materialization, coverage reconciliation, and canonical candidate synthesis. Give each worker artifact a unique reserved phase path derived from stable task/slice identity; never reuse a path for an unrelated slice. Keep parent-authored synthesis on a separate path and cite immutable accepted worker artifacts rather than copying or editing their bytes.

A critic or re-reviewer owns only its independent review artifact and may emit only open findings with `finding_status: UNRESOLVED`. It must not author, rewrite, or accept the artifact it reviews, and it cannot reject, fix, accept risk for, dispose, or close its own findings. The parent alone records `UNRESOLVED`, `REJECTED_WITH_EVIDENCE`, `FIXED`, or `ACCEPTED_RISK` dispositions, closure evidence, and revisions; none of those actions erase original provenance or acceptance history.

## 10. Explicit boundary

Agent/model classification and selector resolution are solely the responsibility of `reviewed-execution-task-escalation`. This reference may require that its resolved fields be present and verified, but must not restate, infer, or override that skill's classification, selector, model choice, escalation, or routing algorithm.
