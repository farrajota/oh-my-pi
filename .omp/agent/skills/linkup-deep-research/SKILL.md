---
name: linkup-deep-research
description: This skill should be used for in-depth online investigations, multi-source synthesis, comparative research, and cited reports requiring Linkup /research at maximum depth with crash-safe recovery and stable JSON artifacts.
---

# Linkup Deep Research

Run user-global Linkup `/research` jobs at maximum reasoning depth. Persist every submitted job for recovery, poll to a terminal state, and consume a stable cited JSON artifact.

## Requirements

- MUST run from the repository workspace root.
- MUST use Python 3.10 or newer.
- MUST provide `LINKUP_API_KEY` through the environment only.
- NEVER place secrets in prompts, arguments, files, or reports.
- The script uses PEP 723 inline metadata; `uv` MUST resolve its pinned `linkup-sdk==0.18.3` dependency directly.
- Agents MUST NOT invoke the script with bare `python`, install dependencies into the workspace with `pip`, or duplicate the dependency with `--with`.
- MUST preserve `mode="research"`.
- MUST preserve `reasoning_depth="XL"`.
- MUST preserve `output_type="sourcedAnswer"`.

The submission contract is:

```python
LinkupClient.research(
    query,
    output_type="sourcedAnswer",
    reasoning_depth="XL",
    mode="research",
)
```

NEVER replace `/research` with search, standard depth, or an uncited output type.

## Prepare the Research Brief

Write one detailed query before submission. The query MUST specify:

1. **Scope:** Define subject, geography, period, exclusions, and boundaries.
2. **Verification targets:** Name claims, numbers, events, or comparisons to establish.
3. **Source preferences:** Request primary, authoritative, recent sources where available.
4. **Contradictions:** Require conflicting evidence, reconciliation, and explicit uncertainty.
5. **Report structure:** Define headings, tables, chronology, comparisons, and citation needs.

Include enough context for independent execution. NEVER assume the research service can infer repository context or unstated decision criteria.

## Submit and Poll

Run:

```bash
uv run "/home/node/.omp/agent/skills/linkup-deep-research/scripts/linkup_deep_research.py" --topic "Topic Name" "Detailed research query"
```

- MUST use a stable, human-readable topic name.
- MUST allow the command to poll until terminal state.
- MUST allow up to 30 minutes for a deep-research job.
- NEVER kill a healthy polling command because it appears quiet.
- MAY interrupt only for an external requirement; recover afterward.

The script normalizes the topic to a lowercase, hyphen-separated, filesystem-safe slug.

## Recover Interrupted Jobs

Resume every persisted non-terminal job without submitting another:

```bash
uv run "/home/node/.omp/agent/skills/linkup-deep-research/scripts/linkup_deep_research.py" --recover-only
```

- MUST use `--recover-only` after crashes, timeouts, or deliberate interruption.
- NEVER resubmit a query while its queue entry remains recoverable.
- MUST leave pending, processing, or temporarily unreachable jobs queued.

## Locate Results

- Queue: `ai_docs/research/linkup/query_ids.json`
- Artifact: `ai_docs/research/linkup/<topic-slug>/<timestamp>/research.json`

Read [the state reference](references/api_reference.md) when inspecting recovery state or artifact semantics.

## Consume the Artifact

- MUST use `research.json` as the handoff to later agents.
- MUST retain the artifact beside any derived report.
- MUST verify cited sources before consequential use.
- MUST distinguish sourced findings, contradictions, and unresolved uncertainty.
- NEVER treat a terminal `failed` envelope as research evidence.
- SHOULD cross-check material claims against primary sources.

Consequential use includes publication, executive decisions, production changes, and legal, security, medical, or financial conclusions.

## Completion Contract

- MUST produce either a `completed` or `failed` terminal artifact.
- MUST preserve queued work until terminal artifact writing succeeds.
- MUST recover interrupted work instead of duplicating submissions.
- NEVER expose `LINKUP_API_KEY` in any artifact or response.
- NEVER claim completion without locating and reading `research.json`.
