---
name: agent-orchestration-guide
description: This skill MUST be used when decomposing delegated work, coordinating concurrent agents, assigning shared-surface ownership, or integrating worker results. Dispatch classification, model routing, and reviewed repair escalation belong to reviewed-execution-task-escalation.
---

# Agent Orchestration Guide

Coordinate decomposition, scheduling, ownership, handoffs, and integration. Keep the parent responsible for the overall scope, authoritative task state, reconciliation, and final deliverable. Leave dispatch classification, model selection, acceptance-review requirements, and repair transitions to `skill://reviewed-execution-task-escalation`.

## Scope and schedule

1. Apply the active session and workflow instructions for direct execution versus delegation; do not introduce a competing delegation default. Where discretion remains, delegate for genuinely independent concurrency, relevant specialist expertise, or required independent review, not merely because another agent is available.
2. Settle the overall approach in the parent before dispatch. Define the deliverable, non-goals, dependencies, and cross-slice interfaces; leave only slice-local design to workers.
3. Batch independent, prerequisite-ready assignments together within the active concurrency limit. Do not manufacture slices or serialize work that can safely proceed concurrently.
4. Assign one writer to each shared file, artifact, database surface, or external effect. Parallelize disjoint ownership; serialize unavoidable shared mutations. Isolated workspaces do not isolate shared services or external state. If new overlap appears, pause the overlapping mutation and have the integration owner reconcile state and reassign ownership before either worker continues.
5. Name the integration owner and define shared formats, signatures, and handoff conditions before dispatch. Do not leave siblings to independently invent incompatible contracts.

## Assignment handoff

Give each worker a bounded contract containing:

- **Outcome:** the required result and its acceptance evidence, consistent with the canonical escalation contract.
- **Scope:** owned surfaces, explicit non-goals, prerequisites, and dependencies.
- **Interfaces:** shared types, formats, signatures, and producer/consumer handoff conditions.
- **Inputs:** relevant authoritative source paths, established decisions, and reconciled state; do not assume inherited parent or sibling context.
- **Authority:** the minimum permitted tools, paths, network access, authentication material, and effects under the applicable session and workflow rules.
- **Return:** result and evidence locations, actual verification performed, unresolved findings, effects or uncertain state, and the reconciliation owner.

Load `skill://reviewed-execution-task-escalation` before every subagent spawn. Follow its pre-dispatch classification, routing, records, and readiness requirements without copying its model-selection algorithm or repair state machine here. Delegate reviewer selection and acceptance-verdict handling to that policy as well.

## Authority and effects

Treat delegation as work assignment, never as a grant of authority. Do not widen tools, paths, network access, authentication material, or effects to compensate for missing information. Prefer deterministic collection of bounded evidence over granting an agent access to the system producing it.

Identify the applicable effect-specific workflow before any consequential mutation. Follow its authorization, enforcement, audit, and reconciliation requirements. If the required authority, workflow, enforcement mechanism, or authoritative state is unavailable, stop that effect and continue only independent authorized work. Do not interpret this guide's lack of a risk taxonomy as permission to bypass existing controls.

Distinguish acceptance review from effect-specific risk audit. Preserve the independent acceptance review required by the escalation skill; apply additional risk audits only under their owning workflow. An audit verdict does not itself grant mutation authority.

Report permission declarations as guardrails, not proof of OS sandboxing or interception of external tool calls. Reconcile uncertain effects and establish retry safety before any repeat invocation.

## Integrate and finish

1. Inspect returned results and their evidence rather than treating worker completion as acceptance. Preserve settled evidence before another worker changes its surface.
2. Reconcile authoritative files, artifacts, and effects. Resolve conflicting outputs through the integration owner; never silently overwrite another owner's work.
3. Route review findings and repair attempts through the canonical escalation policy. Do not self-select stronger models, weaken acceptance criteria, or duplicate retry rules.
4. Run shared integration validation after relevant writers finish; keep project-wide checks out of concurrent writing slices. Verify the actual changed behavior and report only checks that ran.
5. Report the integrated outcome, verification evidence, remaining findings, and any unresolved authority or state. Keep the parent responsible until the requested deliverable is complete or a genuine blocker is identified.
