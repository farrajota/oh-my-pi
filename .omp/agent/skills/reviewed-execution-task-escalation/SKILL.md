---
name: reviewed-execution-task-escalation
description: This skill MUST be used when preparing any subagent spawn or TaskTool dispatch to classify its purpose and resolve its model selector. Multi-agent workflow coordination belongs to agent-orchestration-guide.
---

# Purpose and non-goals

Use baseline model capacity for objectively reviewable delegated execution, then use stronger model capacity only after independent evidence proves that the same bounded assignment failed frozen acceptance criteria.

Use a bounded repair ladder within each strategy cycle, not a bound on completing the assignment. It is not a quality ranking, complexity router, permission policy, or reason to assign an initially stronger model. Assignment purpose and objective evaluability determine coverage. Agent permissions, role names, artifact types, urgency, importance, and perceived difficulty do not.

A read-only agent may own a covered bounded diagnosis or verification. A write-capable agent performing architecture, broad research, independent review, audit, or advice is not covered. Purpose controls classification.

# Mandatory pre-delegation classification

Before selecting a request-local model or spawning **any** candidate assignment—whether implementation, diagnosis, repair, verification, configuration, documentation, generation, execution, architecture, design, brainstorming, review, audit, research, advisory analysis, or human decision support:

1. Write the bounded assignment.
2. Write stable, objectively observable acceptance criteria with identifiers.
3. Apply the conjunctive trivial exemption.
4. If not trivial, apply Gates A-D.
5. Record exactly one policy decision: `TRIVIAL_EXEMPT`, `NOT_COVERED`, `PRECONDITION_BLOCKED`, or `COVERED`.
6. Dispatch only after the decision and required authoritative record exist.

Classify each candidate subtask independently. Split mixed-purpose work when architecture, design, broad research, independent review or audit, advisory analysis, or human decision support could change the acceptance criteria, expected output, chosen approach, or completion judgment. An incidental execution step does not make an otherwise excluded assignment covered.

The coverage formula is:

```text
Covered = CANDIDATE
          ∧ ¬TRIVIAL
          ∧ BOUNDED
          ∧ FROZEN_OBJECTIVE
          ∧ INDEPENDENTLY_REVIEWABLE
          ∧ RETRYABLE_RECONCILED
```

## Conjunctive trivial exemption

An assignment is `TRIVIAL_EXEMPT` only when every condition is true:

1. It consists of one deterministic mechanical operation.
2. It requires no interpretation, diagnosis, design, implementation judgment, or semantic synthesis.
3. It has no external or persistent side effect.
4. The parent can verify the exact result directly without independent semantic review.
5. An incorrect result cannot plausibly appear correct while violating an unstated invariant.
6. It does not cross a public API, schema, configuration, generated-artifact, security, concurrency, deployment, or persistent-data boundary.

Small size alone is not triviality. If any condition is false or uncertain, continue through Gates A-D. After classification, `TRIVIAL_EXEMPT` uses the outside-ladder resolver below and does not use the repair ladder.

## Gate A - bounded execution responsibility

The assignment must own one defined implementation, diagnosis, repair, verification, configuration or documentation update, generated artifact, execution, or other deliverable result.

Positive examples: implement an endpoint against an approved contract; repair a reproducible defect; diagnose one failing command; run a defined verification scenario; update documentation to match established source behavior; create a specified migration without applying an uncontrolled production mutation.

Purpose exclusions include comparing architectures, brainstorming approaches, broad background research, general repository context collection, independently reviewing or auditing another worker, and advising a human among materially different product or policy options. Classify these `NOT_COVERED`; after classification, use the outside-ladder resolver below rather than the repair ladder.

## Gate B - frozen objective acceptance criteria

Before the first attempt, every criterion must:

- have a stable identifier;
- state an observable expected result;
- remain unchanged across all model tiers.

If an unresolved requirement, design choice, authority decision, user decision, prerequisite, or authoritative state could change a criterion or expected output, classify `PRECONDITION_BLOCKED` and do not dispatch. Preference-based or inherently subjective outcomes are `NOT_COVERED`.

## Gate C - independently reviewable

A separate reviewer must be able to inspect observable evidence and return `PASS`, `FIX`, or `BLOCKED` against every frozen criterion.

Suitable evidence includes actual changed files, workspace state, command output, tests, diagnostics, generated artifacts, reproduction scenarios, source-backed documentation, or a bounded diagnosis with cited evidence. The reviewer must inspect the result and evidence, not only a worker summary, and must use its configured reviewer routing without this escalation override.

## Gate D - retryable, revisable, and reconciled

A fresh attempt must be able to revise the result from reviewer findings without unsafe ambiguity about prior effects.

For workspace-local or read-only work, identify the authoritative files, artifacts, state, or evidence. For external effects, define reconciliation before dispatch. Before any retry or stronger tier, execute reconciliation, record the authoritative post-attempt state, and establish either idempotence or safe accounting for the prior partial effect.

If authoritative state cannot be established before the first attempt, classify `PRECONDITION_BLOCKED`. If it cannot be established after a possible attempt or effect, classify `BLOCKED`. Uncertain external state never transitions directly to `FIX` or another execution attempt.

# Classification examples

| Assignment | Classification | Reason |
| --- | --- | --- |
| Count lines in one known file | `TRIVIAL_EXEMPT` | Every triviality condition passes. |
| Implement an endpoint against an approved contract | `COVERED` | Bounded, objective, reviewable, revisable. |
| Fix a reproducible failing test | `COVERED` | Objective defect and verification evidence. |
| Diagnose a specific crash and identify responsible code | `COVERED` | Bounded read-only diagnosis. |
| Run a defined smoke scenario and report acceptance | `COVERED` | Objective verification. |
| Update documentation to match current CLI behavior | `COVERED` | Source-verifiable documentation result. |
| Create migration code without production application | `COVERED` | Controlled reviewable artifact. |
| Scout for possibly relevant modules | `NOT_COVERED` | General context collection. |
| Research libraries and recommend one | `NOT_COVERED` | Broad advisory research. |
| Design service architecture | `NOT_COVERED` | Architecture assignment. |
| Independently review an implementation | `NOT_COVERED` | Reviewer retains configured routing. |
| Audit code for vulnerabilities | `NOT_COVERED` | Independent audit purpose. |
| Implement an approved UI specification | `COVERED` | Frozen observable criteria. |
| Implement while the required API contract is undecided | `PRECONDITION_BLOCKED` | Criteria may materially change. |
| Investigate why one known deployment command fails locally | `COVERED` | Bounded diagnosis. |
| Explore possible causes of generally poor reliability | `NOT_COVERED` | Open-ended investigation. |
| Apply an irreversible production mutation with uncertain state | `PRECONDITION_BLOCKED` | Unsafe unreconciled execution. |

Narrow evidence gathering may be subordinate to a covered assignment. Stable formatting does not make broad research or advisory work covered.

# Authoritative pre-spawn model-routing algorithm

This section is the sole model-routing authority for every spawn. Classification is terminal before any baseline or preference is resolved. Do not use a linear precedence list that lets a user, workflow, operator, or frontmatter value bypass classification, and do not create a second routing authority in a caller or orchestration guide.

For every candidate assignment, apply exactly one row:

| Classification | Allowed dispatch branch | Selector source | Failure rule |
| --- | --- | --- | --- |
| `PRECONDITION_BLOCKED` | No dispatch; record the missing prerequisite, authority, decision, or reconciled state. | None. No TaskTool request is permitted. | Fail closed before launch; zero TaskTool invocation and zero `tasks[].model` argument. |
| `COVERED` | Start each strategy cycle at `pi/task`; advance only through valid reviewed transitions to `pi/taskpro`, `pi/taskbest`, and `pi/taskultra`. After ultra `FIX`, reconcile, record a revised strategy, recheck readiness, increment the cycle, and restart the original covered assignment at `pi/task`. | Request-local reviewed tier selected by the state machine. Outside-ladder user, workflow, operator, and frontmatter preferences are not consulted. | A missing or mismatched request-local route is `ENVIRONMENT_FAILED`; do not promote or substitute a baseline. Ladder exhaustion alone never terminates work or requires user approval. |
| `NOT_COVERED` | Resolve one outside-ladder baseline using the ordered resolver below. | First usable exact selector in this order: current-turn explicit user selector; loaded workflow-contract selector; active operator override for the exact selected agent; specialized-agent frontmatter; `pi/slow` only for generic `task`. | A selected but empty, unavailable, or unresolved selector fails closed as `ENVIRONMENT_FAILED`; do not fall through to a lower source after a source was selected. A specialized agent with no model from any allowed source has no fallback and is not dispatched. |
| `TRIVIAL_EXEMPT` | Resolve one outside-ladder baseline using the ordered resolver below. | First usable exact selector in this order: current-turn explicit user selector; loaded workflow-contract selector; active operator override for the exact selected agent; specialized-agent frontmatter; `pi/slow` only for generic `task`. | A selected but empty, unavailable, or unresolved selector fails closed as `ENVIRONMENT_FAILED`; do not fall through to a lower source after a source was selected. A specialized agent with no model from any allowed source has no fallback and is not dispatched. |

The outside-ladder resolver is mechanical and applies only to `NOT_COVERED` and `TRIVIAL_EXEMPT`:

1. Use an explicit, concrete model selector supplied in the current turn for this spawn.
2. Otherwise use an explicit, concrete selector declared by the loaded workflow contract for this spawn. A workflow selector is bounded to that loaded contract (for example, a spec-stratify-style validated default or user-supplied roster), not inferred from general prose or from the parent.
3. Otherwise use the active runtime operator override for the exact selected agent definition. Do not infer a global preference or an override for another agent.
4. Otherwise use the selected specialized agent's frontmatter model.
5. If the selected agent is generic `task` and no earlier source exists, use `pi/slow`. This fallback never applies to a named specialized agent and never applies to `COVERED` work.

Resolve operator configuration and specialized frontmatter from evidence, never from a guessed filename or remembered default:

1. For a named selected agent, inspect the effective `task.agentModelOverrides.<agent-name>` value before consulting frontmatter. Use the active settings-layer order: runtime override, explicit launch overlay, project configuration, then user-global configuration. When the runtime does not expose an effective-settings API, inspect every observable loaded source in that order: any launch-contract overlay path, `.omp/config.yml` or `.omp/config.yaml` for the active workspace, and `~/.omp/agent/config.yml` or `~/.omp/agent/config.yaml`. The exact-agent key only is authoritative. If a higher-precedence active layer is known but not inspectable, terminate `ENVIRONMENT_FAILED`; do not pretend it is absent or fall through.
2. Resolve a specialized agent definition by exact frontmatter `name: <agent-name>`, not by assuming `<agent-name>.md`. Search the active project and user agent roots exposed to the session, apply normal discovery precedence, require one active definition, and read that definition's frontmatter `model` exactly. A missing, duplicate-at-the-same-precedence, unreadable, or ambiguous definition is `ENVIRONMENT_FAILED`.
3. Record the concrete configuration or definition path inspected and the exact source/value selected. Do not claim `operator-config` or `frontmatter-preservation` without this evidence. Do not dispatch until the baseline record is complete.

An exact selector from an allowed source is preserved verbatim, including `pi/task`, `pi/taskpro`, `pi/taskbest`, or `pi/taskultra`. Those spellings are outside-ladder baseline values when supplied by the user, workflow contract, operator configuration, or specialized frontmatter; they are not repair-tier transitions. Only a parent-inferred ladder alias is prohibited outside the `COVERED` branch.

For every dispatch, distinguish the configured baseline from the wire value: record the configured baseline source and exact value, the exact `Dispatch model selector` sent in the TaskTool `tasks[].model` field, and one `Selection reason` from `covered-tier`, `explicit-user`, `workflow-contract`, `operator-config`, `frontmatter-preservation`, or `generic-fallback`. The dispatch selector must be non-empty and equal the actual `tasks[].model` value. Then record the authoritative resolved model identifier and execution invocation ID. A missing, unexpected, or mismatched resolved identity is `ENVIRONMENT_FAILED` and does not consume a semantic tier.

After dispatch, obtain resolved identity only from the spawned TaskTool job's authoritative runtime record. A host-side machine-readable `hub wait` or `hub jobs` record may contain `jobs[].resolvedModel`; copy that exact field when it is visible to the orchestrator. Some caller-visible TaskTool renderings omit structured detail fields that remain present in the host JSONL trace; in a controlled workflow with an outer trace verifier, record identity verification as pending and let that verifier bind the exact field before completion. Without either a caller-visible TaskTool identity or an authorized outer trace verifier, terminate `ENVIRONMENT_FAILED`. Never infer the resolved identity from an alias map, and never call a selector verified merely because configuration predicts its resolution.

Positive and negative routing examples:

| Scenario | Classification and result |
| --- | --- |
| A `security-architect` design request with no user, workflow, or operator selector and frontmatter `model: pi/slow` | Positive: `NOT_COVERED`; dispatch `pi/slow`; reason `frontmatter-preservation`. The reported design case must not be forced to `pi/task` merely because the work is important or technically difficult. |
| An outside-ladder advisory specialist whose frontmatter is `model: pi/task` | Positive: `NOT_COVERED`; preserve exact dispatch selector `pi/task`; reason `frontmatter-preservation`. This is not a covered repair attempt and must not be rewritten to `pi/slow` or treated as a ladder transition. |
| Covered implementation with user `pi/taskultra`, operator `pi/taskpro`, and agent frontmatter `pi/slow` | Positive: `COVERED`; initial dispatch selector `pi/task`; reason `covered-tier`. All outside-ladder preferences are ignored; only a valid reviewed `FIX` plus reconciliation can select the next tier. |
| A specialized architecture agent with no user, workflow, operator, or frontmatter model | Negative: `NOT_COVERED`; no generic `pi/slow` fallback exists for a specialized agent, so dispatch fails closed with `ENVIRONMENT_FAILED`. |
| A parent chooses `pi/taskultra` for an advisory specialist without an allowed explicit source | Negative: `NOT_COVERED`; the parent-inferred ladder alias is prohibited and must not be dispatched. |

# Request-local routing and resolved identity

Use these fixed aliases exactly:

1. `pi/task`
2. `pi/taskpro`
3. `pi/taskbest`
4. `pi/taskultra`

Start every `COVERED` assignment and every reassessed strategy cycle at request-local `pi/task`. Never select an initially stronger tier because of complexity, importance, urgency, cost, risk, agent reputation, role, permissions, or parent preference.

Preserve the execution agent's definition and immutable configuration across tiers within a strategy cycle. Change only the request-local model selector. Preserve the prompt contract, tools, permissions, path scope, output schema, isolation policy, configured reasoning or effort, and reviewer standard. Revise the strategy between cycles only through the reassessment procedure below. Never mutate `task.agentModelOverrides` or another shared model setting for a semantic attempt.

Use the supported TaskTool request-local `tasks[].model` field when the active runtime exposes it and `task.allowModelOverride` authorizes it:

```json
{
  "tasks": [{
    "agent": "<execution-agent>",
    "model": "pi/task",
    "task": "<bounded assignment>"
  }]
}
```

If TaskTool does not expose or authorize request-local `tasks[].model`, terminate `ENVIRONMENT_FAILED`. Do not emulate request-local selection through shared settings.

For every dispatch, record:

- configured baseline source;
- configured baseline exact value (the generic fallback records source `generic-fallback` and value `pi/slow`);
- `Dispatch model selector`: the exact non-empty value sent in TaskTool `tasks[].model`;
- `Selection reason`: exactly one of `covered-tier`, `explicit-user`, `workflow-contract`, `operator-config`, `frontmatter-preservation`, or `generic-fallback`;
- authoritative resolved model identifier;
- execution invocation ID.

The dispatch selector must equal the actual TaskTool `tasks[].model` value. A missing resolved identity, unexpected fallback, or unresolved/mismatched selector is `ENVIRONMENT_FAILED` and does not consume that tier. Alias normalization is valid only when authoritative runtime evidence explicitly maps the alias to the reported identifier; record both. For `PRECONDITION_BLOCKED`, record the no-dispatch blocker instead and send no model argument.

Keep model and effort selection independent. Do not add or change effort unless separately authorized. Provider transport retries do not consume a semantic attempt only when authoritative runtime evidence proves the prior request never began execution.

# Mandatory state machine

Use exactly one semantic execution attempt per tier per strategy cycle:

```text
CANDIDATE
    trivial exemption passes          -> TRIVIAL_EXEMPT
    purpose exclusion applies         -> NOT_COVERED
    prerequisite/readiness gate fails -> PRECONDITION_BLOCKED
    all coverage gates pass           -> PI_TASK_DISPATCH

ANY_TIER_DISPATCH
    selector/runtime unavailable before execution -> ENVIRONMENT_FAILED
    requested/resolved model mismatch             -> ENVIRONMENT_FAILED
    dispatch proven not to start execution        -> ENVIRONMENT_FAILED
    execution or effect uncertain                 -> RECONCILIATION_PENDING
    semantic attempt settles                      -> REVIEW_PENDING

REVIEW_PENDING
    valid PASS                          -> COMPLETE
    valid BLOCKED                       -> BLOCKED
    invalid review                      -> REVIEW_RETRY_PENDING
    valid FIX at pi/task, pi/taskpro, or pi/taskbest -> RECONCILIATION_PENDING
    valid FIX at pi/taskultra                        -> RECONCILIATION_PENDING

REVIEW_RETRY_PENDING
    valid verdict  -> apply the corresponding REVIEW_PENDING transition
    invalid review -> REVIEW_BLOCKED

RECONCILIATION_PENDING
    authoritative state unavailable -> BLOCKED
    reconciled after pi/task FIX     -> PI_TASKPRO_DISPATCH
    reconciled after pi/taskpro FIX  -> PI_TASKBEST_DISPATCH
    reconciled after pi/taskbest FIX -> PI_TASKULTRA_DISPATCH
    reconciled after pi/taskultra FIX -> STRATEGY_REASSESSMENT_PENDING
    reconciled uncertain dispatch with no execution/effect proven
        -> same-tier dispatch, subject to environment-recovery budget
    reconciled uncertain dispatch with an actual result found
        -> REVIEW_PENDING for that result

STRATEGY_REASSESSMENT_PENDING
    revised strategy recorded; coverage gates pass -> increment cycle; PI_TASK_DISPATCH
    supporting research/design needed             -> classify separate supporting subtask; remain STRATEGY_REASSESSMENT_PENDING
    required prerequisite or authority unavailable -> BLOCKED; resolve the named prerequisite
    authoritative prior state unavailable          -> BLOCKED; reconcile before any dispatch

BLOCKED (entered during post-ultra reconciliation or reassessment)
    prerequisite restored and state reconciled -> STRATEGY_REASSESSMENT_PENDING; recheck gates and resume automatically
```

After a valid `FIX` at `pi/taskultra`, end only the current strategy cycle, not the assignment. Reconcile the result, then have the parent reassess the approach against the accumulated failure evidence. Record why the strategy failed, the concrete adjustment, redesign, or alternative approach, and how the next attempt will test that change. Preserve correct work; do not blindly replay the same strategy or add another semantic repair at `pi/taskultra`.

Continue automatically under the same assignment ID and frozen acceptance criteria, preserving the complete attempt and review history. Record a new cycle ID and revised strategy contract before restarting at `pi/task`; advance again through `pi/taskpro`, `pi/taskbest`, and `pi/taskultra` only on valid independent `FIX` verdicts and successful reconciliation. Repeat reassessment and cycles as needed until `PASS`; impose no exhaustion-based cycle cap, terminal `UNRESOLVED` outcome, or requirement for user approval to continue.

Permit in-scope strategy changes without weakening acceptance criteria or expanding authorization. Keep the original bounded execution assignment `COVERED`; do not reclassify it as `TRIVIAL_EXEMPT` or `NOT_COVERED` to escape its ladder, review, or completion obligations. Re-run readiness gates and record any changed execution definition or configuration fingerprint at the cycle boundary; freeze them again within that cycle. Classify genuinely distinct supporting research, design, or advice subtasks separately through the canonical resolver, incorporate their results into the strategy revision, and then resume the original assignment at `pi/task`. Supporting-subtask completion never completes or replaces the original assignment. Reassessment is parent-owned, not a worker self-restart. Model exhaustion, repeated correctable defects, or needing a different strategy are not blockers. Preserve genuine safety, authority, prerequisite, and environment constraints; resolve agent-actionable blockers and continue reachable work rather than asking the user to authorize another cycle.

Permit at most one same-tier recovery dispatch after `ENVIRONMENT_FAILED`, only after the environment is demonstrably repaired and authoritative state proves no unreconciled execution or effect. A second environment failure at that tier terminates `ENVIRONMENT_FAILED`. Timeout, unknown delivery, disconnected response, or missing result does not prove non-execution; reconcile first.

# Reviewer contract

The reviewer must not have produced or modified the attempt, must be a different invocation from the execution worker, must inspect the actual result and required evidence, must use its configured reviewer routing without this escalation override, and cannot approve its own output.

Every review must return:

```text
Review:
- assignment_id:
- execution_attempt_id:
- reviewer_agent_definition:
- reviewer_invocation_id:
- evidence_inspected:
- criterion_results:
  - criterion_id:
  - status: satisfied | violated | not_judgeable
  - observed:
  - expected:
  - evidence:
- verdict: PASS | FIX | BLOCKED
- findings:
  - criterion_id:
  - materiality:
  - observed:
  - expected:
  - evidence:
  - assignment_ownership:
- blocker:
  - missing_prerequisite:
  - why_required:
  - evidence:
```

Derive verdicts deterministically:

- `PASS`: every criterion is `satisfied`.
- `FIX`: at least one criterion is `violated`, and every promoted finding is material, evidenced, non-duplicative, and owned by the bounded assignment.
- `BLOCKED`: at least one criterion is `not_judgeable` because of a named unavailable prerequisite or authority.

Every `FIX` finding must identify the violated frozen criterion, observed behavior, expected behavior, supporting evidence, and why the defect belongs to the assignment. Style preferences, optional improvements, changed criteria, uncertainty, and immaterial findings are not `FIX`.

A review is invalid only when independence is violated; the actual result or required evidence was not inspected; required fields are missing; evidence is absent or inaccessible; verdict and criterion results/evidence contradict each other; changed criteria were applied; or no verdict was returned.

Retry an invalid review at most once against the same settled attempt with a fresh reviewer invocation and corrected instructions. The retry consumes no execution tier. Disagreement with a contract-valid evidence-backed verdict is not a retry reason. A second invalid review terminates `REVIEW_BLOCKED`. Never convert reviewer uncertainty into `FIX`.

# Mutually exclusive outcomes

Apply this precedence to the current assignment state, not to historical review verdicts. After successful reconciliation of a valid `pi/taskultra` `FIX`, select `STRATEGY_REASSESSMENT_PENDING` instead of generic `FIX`; preserve `FIX` as the attempt's review verdict in the ledger, not as the assignment's current state.

1. `ENVIRONMENT_FAILED`: requested selector, model, provider, credential, permission, tool, or runtime is unavailable; requested/resolved identity mismatches; or non-execution is proven. The semantic tier is not consumed. Same-tier recovery is bounded by the state machine.
2. `PRECONDITION_BLOCKED`: before dispatch, a prerequisite, authority, user decision, materially clarified requirement, or authoritative reconciled state is unavailable.
3. `BLOCKED`: after dispatch or a settled result, reliable judgment or safe continuation requires an unavailable prerequisite, authority, user decision, or authoritative external state.
4. `NOT_COVERED`: purpose-based exclusion; resolve the selected agent through the canonical outside-ladder resolver.
5. `PASS`: observable evidence satisfies every frozen criterion.
6. `FIX`: a settled attempt materially violates at least one frozen criterion through a task-owned defect or omission.
7. `REVIEW_BLOCKED`: one corrected review retry still cannot produce a valid independent verdict.
8. `STRATEGY_REASSESSMENT_PENDING`: reconciled valid `FIX` after the reviewed `pi/taskultra` attempt; nonterminal parent-owned strategy revision followed by a new cycle at `pi/task`, not an approval gate.

A clear frozen requirement that the result failed is `FIX`, not a prerequisite blocker. Only a valid independent `FIX`, followed by successful reconciliation, advances from `pi/task`, `pi/taskpro`, or `pi/taskbest`.

# Parent ownership and invariant execution definition

The parent owns classification, frozen acceptance criteria, initial `pi/task` selection for each cycle, requested/resolved identity verification, independent reviewer selection, verdict validation, reconciliation, strategy reassessment, fresh repair delegation, ordered cross-cycle history, and terminal reporting. Subagents must not self-escalate or independently restart cycles.

Before a covered dispatch, create an authoritative in-context assignment record with:

- assignment ID and bounded assignment;
- strategy cycle ID and strategy contract (including evidence-backed changes from the previous cycle);
- frozen acceptance criteria;
- classification and gate results;
- stable execution-agent definition;
- immutable configuration fingerprint;
- configured baseline source and exact value;
- dispatch model selector and selection reason;
- requested model alias.

Before any promotion or cycle restart, append the resolved identifier, execution invocation ID, settled result, review identity, valid verdict, evidence-backed open findings, reconciliation evidence, and transition. Fail closed: do not dispatch the next attempt when the record or required evidence is absent; recover missing agent-accessible evidence rather than treating this as an exhaustion-based stop.

Every stronger attempt is a fresh invocation of the same execution-agent definition and configuration fingerprint within its cycle. Give it the authoritative reconciled state, exact material open findings, relevant failure evidence, and instructions to preserve correct work while revising incorrect work. Do not change the agent definition or invariant configuration during tier promotion. At a reassessed cycle boundary, recheck readiness and record the revised definition and fingerprint under the same covered assignment history before restarting at `pi/task`.

# Tracking and batch isolation

Track each assignment independently and never overwrite prior execution or review attempts:

```text
Assignment:
- ID:
- Bounded assignment:
- Frozen acceptance criteria:
- Classification:
  - Trivial exemption:
  - Bounded:
  - Frozen and objective:
  - Independently reviewable:
  - Retryable and reconciled:
- Policy decision: trivial_exempt | not_covered | precondition_blocked | covered
- Stable execution-agent definition:
- Invariant configuration fingerprint:
- Configured baseline source/value:
- Dispatch model selector:
- Selection reason:
- Terminal status:

Strategy cycles:
- cycle_id:
- strategy_contract:
- prior_cycle_failure_evidence:
- strategy_change_and_verification_rationale:
- classification_and_configuration_changes:

Execution attempts:
- attempt_id:
- cycle_id:
- tier:
- requested_model_alias:
- resolved_model_identifier:
- execution_invocation_id:
- configuration_fingerprint:
- authoritative_state_before:
- result:
- authoritative_state_after:
- reconciliation_evidence:

  Review attempts:
  - review_attempt_id:
  - reviewer_agent_definition:
  - reviewer_invocation_id:
  - independence_valid:
  - evidence_inspected:
  - validity:
  - invalidity_reason:
  - criterion_results:
  - verdict:
  - findings:
  - transition:
```

Before parallel dispatch, identify dependencies and overlapping files, artifacts, databases, services, and external state. Parallelize only genuinely disjoint assignments or assignments with isolated authoritative state. Serialize unavoidable ownership or state overlap. Preserve each settled attempt's evidence before a sibling can mutate its surface. Schedule each repair tier independently from sibling verdicts; one batch item's verdict never advances another item's tier.

# Completion reporting

Always report a compact completion record containing:

- assignment ID;
- policy decision;
- execution agent definition;
- ordered strategy cycles, reassessment decisions, requested aliases, and resolved model identifiers;
- configured baseline source/value;
- exact dispatch model selectors and selection reasons;
- reviewer identities and verdicts;
- terminal status;
- verification actually inspected;
- remaining findings or blockers for non-complete states.

For batches, escalations, strategy-cycle restarts, or any non-complete terminal status, expose the relevant ordered ledger. A successful single-tier assignment may use one concise row. Report cycle exhaustion as continuing strategy reassessment, never as assignment completion or a request for permission to keep working.
