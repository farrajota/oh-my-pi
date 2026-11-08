---
name: code-review
description: Performs a thorough, multi-domain code review by detecting the project tech stack, mapping each file to the domains it requires, and delegating fine-grained checks to specialized agents running in parallel waves. Covers code quality, test quality (unit/property/integration/e2e/performance), documentation, security, performance, observability, architecture, CI/CD, concurrency & async safety, data privacy, dependency & supply-chain hygiene, and configuration. Each agent follows a checklist template stored under `skill://code-review/templates/` and emits a structured per-domain report to `ai_docs/reports/code-review/<timestamp>/`. A final consolidated executive summary aggregates every per-domain finding into cross-cutting themes, severity-ranked counts, and a prioritized remediation order. Use this skill when the user wants a deep, evidence-based review of an entire codebase or a focused subset — beyond what linters/type checkers/security scanners already catch.
argument-hint: "[--scope <path> [<path2> ...]] [--lang <lang1,lang2>] [--domains <d1,d2>] [--out <dir>]"
model: pi/slow
disable-model-invocation: true
---

# Multi-Domain Code Review (Specialized-Agent Orchestration)
Default OMP model alias: `pi/slow`.

## Input Arguments

- `raw_args=$ARGUMENTS`

Parse `raw_args` to extract:

- `<scope_paths>`: list of paths after `--scope` (space-separated, until next `--flag` or end). Empty list → entire repo (`.`).
- `<lang_override>`: comma-separated list after `--lang` (e.g. `python,typescript`). Empty → auto-detect.
- `<domain_filter>`: comma-separated list after `--domains` (e.g. `security,performance`). Empty → all applicable.
- `<out_dir>`: path after `--out`. Default → `ai_docs/reports/code-review/<UTC-timestamp>/`.

## Description

This skill elevates code-review beyond linting and type-checking. It treats review as a quality gate covering **technical**, **architectural**, and **behavioural** dimensions. The orchestrator never reads source files itself — it detects the stack, partitions the codebase by domain relevance, then dispatches **focused specialist agents** (one per sub-topic) that each follow a saved template-as-scratchpad and emit a structured report.

Findings answer three questions for every check:

1. **What is being correctly done** (validated best practices)
2. **What needs to be improved** (file, lines, finding, justification)
3. **How to fix it** (concrete proposed solution with code snippet when applicable)

## Usage

```
/code-review                                                 # whole repo, auto-detect stack, all domains
/code-review --scope src/canivete/mcp                        # focused subset
/code-review --scope src/ tests/ --lang python               # multi-path, explicit stack
/code-review --domains security,performance,concurrency      # only selected domains
/code-review --scope src/ --out ai_docs/reports/cr-pr-123/   # custom output dir
```

## Variables

- `<scope>`: resolved space-separated review scope (from `<scope_paths>` or `.`)
- `<stack>`: detected or user-provided tech stack (list of languages + frameworks + test runners + package managers)
- `<workspace_dir>`: `ai_docs/reports/code-review/<timestamp>/.workspace/` (file-based blackboard between phases)
- `<reports_dir>`: `<out_dir>` (where per-domain reports land)
- `<file_map_path>`: `<workspace_dir>/file_map.yaml` (sub-topic → list of files to review)
- `<plan_path>`: `<workspace_dir>/execution_plan.yaml` (wave layout + agent assignments)
- `<templates_root>`: `skill://code-review/templates/`
- `<max_parallel_agents>`: 4 (per CLAUDE.md guidance)
- `<min_files_per_agent>`: 1 (skip domain if zero matching files)

## Prompt

You are the **orchestrator** of a multi-domain code review. You will **never** read source files, run linters, or write findings yourself. Your job is to:

1. Verify required tools exist (Phase 0).
2. Detect the tech stack (Phase 1).
3. Map files to domains (Phase 2) — this is the **pre-emptive structural pass** that prevents every downstream agent from re-discovering the codebase.
4. Generate the execution plan (Phase 3).
5. Dispatch specialist agents in parallel waves (Phase 4).
6. Collect reports and emit the run manifest (Phase 5).
7. Delegate a final consolidated executive summary that aggregates every per-domain finding (Phase 6).

**CRITICAL ORCHESTRATOR RULES**

- You **MUST** delegate every analytical task to a sub-agent. The orchestrator only runs lightweight `bash` + file-management.
- You **MUST** load and pass each agent its template file path **and** its pre-scoped file list. Agents **must not** re-discover files.
- You **MUST** emit a one-line status message at every phase boundary.
- You **MUST** run agents in parallel waves of ≤ `<max_parallel_agents>` per wave.
- You **MUST** skip any domain/sub-topic whose file list is empty after Phase 2.
- You **MUST NEVER** open source files (`.py`, `.ts`, `.go`, …) yourself, run pytest, run ruff/mypy/eslint, or write per-domain findings.
- You **MAY** read workspace YAML files (`file_map.yaml`, `execution_plan.yaml`) and template files for orchestration.

## Phase 0 — Pre-flight Tool Check

**Owner**: orchestrator (direct `bash`).

Verify each tool below is available. If a tool is missing, **DO NOT STOP** — record it as unavailable in `<workspace_dir>/preflight.yaml` and downgrade any check that depended on it to a `manual` note in the final report.

Required:

- `git` (to detect repo root, list tracked files)
- `rg` (ripgrep — fast file scanning)
- `find` (POSIX file enumeration)
- `jq` (YAML/JSON manipulation in shell)

Stack-conditional (checked after Phase 1 detection):

- Python stack: `uv`, `ruff`, `mypy`, `bandit`, `pytest`, `pip-audit` or `safety`
- Node stack: `npm`/`pnpm`/`yarn`, `eslint`, `tsc`, `npm audit`
- Go stack: `go`, `staticcheck`, `govulncheck`
- Container assets: `docker`, `hadolint` (optional)

Also verify the skill assets exist:

- `<templates_root>/_index.md`
- All sub-topic templates referenced by `_index.md`

Write `<workspace_dir>/preflight.yaml`:

```yaml
tools_available: [git, rg, find, jq, uv, ruff, ...]
tools_missing: [hadolint, ...]
templates_root: skill://code-review/templates/
templates_verified: true
```

**Emit**: `[Phase 0] Pre-flight complete. Tools available: <N>. Missing: <list>.`

## Phase 1 — Stack Detection

**Owner**: orchestrator (direct `bash`) — small, deterministic.

If `<lang_override>` is non-empty, use it directly and skip detection. Otherwise:

1. Look for project-root signals across `<scope>`:
   - `pyproject.toml`, `setup.py`, `requirements*.txt`, `uv.lock`, `Pipfile` → Python
   - `package.json`, `tsconfig.json`, `pnpm-lock.yaml` → JavaScript/TypeScript
   - `go.mod` → Go
   - `Cargo.toml` → Rust
   - `pom.xml`, `build.gradle` → JVM
   - `Dockerfile`, `compose.yml`, `*.tf` → infrastructure assets
2. Count file extensions across `<scope>` (`.py`, `.ts`, `.tsx`, `.js`, `.go`, `.rs`, `.java`, …) and treat any language with ≥5% of files (min 3 files) as part of the stack.
3. Detect frameworks via signature files / imports (FastAPI, Django, Flask, Pydantic, httpx, requests, pytest, hypothesis, React, Next.js, NestJS, etc.). Use shallow `rg` searches with capped depth.

Write `<workspace_dir>/stack.yaml`:

```yaml
languages: [python]
frameworks: [pydantic, mcp, fastmcp, pytest]
http_clients: [requests, httpx]
test_runners: [pytest]
package_managers: [uv]
container_assets: false
ci_assets: [github-actions]
```

**Emit**: `[Phase 1] Stack: <languages>, frameworks: <list>.`

## Phase 2 — Codebase Structure Analysis (pre-emptive file map)

**Owner**: `Explore` agent (one call) — read-only structural pass.

This is the **single most important** orchestration step. It builds the `<file_map_path>` that **every downstream agent receives** so none of them re-walks the tree.

Delegate to the `Explore` agent with this prompt skeleton:

> You are mapping files to code-review sub-topics. Read `<workspace_dir>/stack.yaml` for context. For each sub-topic listed in `<templates_root>/_index.md`, return the **minimal set of files** that an agent would need to evaluate. Apply the trigger globs and signature heuristics declared in `_index.md`. Skip sub-topics with zero matches. Output a YAML file at `<file_map_path>` with this exact schema:
>
> ```yaml
> sub_topics:
>   code-quality/structure_sizing:
>     template: skill://code-review/templates/code-quality/structure_sizing.md
>     files:
>       - src/canivete/admin/auditor.py
>       - src/canivete/admin/prober.py
>     rationale: "Python source files in <scope>, >150 lines."
>   test-quality/unit_tests:
>     template: skill://code-review/templates/test-quality/unit_tests.md
>     files:
>       - tests/unit/test_auditor.py
>       - tests/unit/test_prober.py
>     rationale: "Files under tests/unit/."
>   security/ssrf_internal:
>     files: []
>     rationale: "No outbound HTTP user-controlled URL detected."
>     skip: true
> ```
>
> Keep the total file list per sub-topic to ≤ 25 files; if larger, partition by directory and emit multiple sub-topic entries (e.g. `code-quality/structure_sizing__pkg-admin`, `code-quality/structure_sizing__pkg-mcp`) so downstream agents stay focused.

**Validation gate** (orchestrator runs):

- [ ] `<file_map_path>` exists and is valid YAML
- [ ] Every non-skipped sub_topic has a non-empty `files` list and an existing `template` file
- [ ] No file list exceeds 25 entries (otherwise re-run with partitioning hint)

**Emit**: `[Phase 2] File map complete. <N> sub-topics scheduled, <M> skipped (no relevant files).`

## Phase 3 — Plan Generation

**Owner**: orchestrator (direct `bash` + small write).

Build `<plan_path>` (the wave schedule). Apply these rules:

1. Group sub-topics into **waves of ≤ `<max_parallel_agents>`** agents.
2. Place independent sub-topics across waves; do not stack the same domain in one wave (helps cache locality across files).
3. Each sub-topic entry must include: `template`, `files`, `agent`, `report_path`.
4. Agent selection (use the mapping defined in `_index.md`; fallback to `python-code-reviewer` for Python or `general-purpose` otherwise).
5. `report_path` = `<reports_dir>/<sub_topic_id>_report.md` (slashes replaced with `__`).

Example plan slice:

```yaml
run_id: 2026-05-19T14-22-31Z
scope: ["src/", "tests/"]
stack: {languages: [python]}
waves:
  - wave: 1
    sub_topics:
      - id: code-quality/structure_sizing
        agent: python-code-reviewer
        template: skill://code-review/templates/code-quality/structure_sizing.md
        files: [...]
        report_path: ai_docs/reports/code-review/2026-05-19T14-22-31Z/code-quality__structure_sizing_report.md
      - id: security/input_validation
        agent: python-security-reviewer
        ...
```

**Emit**: `[Phase 3] Plan: <N> sub-topics across <W> waves. Agents: <distinct list>.`

## Phase 4 — Parallel Review Execution

**Owner**: orchestrator dispatches **all sub-topics in a wave simultaneously** (one message, multiple `task` tool calls), waits for the wave to complete, then dispatches the next wave.

For each sub-topic, the agent prompt must contain **exactly** these elements:

1. **Template path** — agent reads it as both the system prompt and scratchpad.
2. **Pre-scoped file list** — agent must not enumerate files itself.
3. **Stack context** — pass `<workspace_dir>/stack.yaml` contents inline.
4. **Output path** — agent must save its report there.
5. **Constraints**:
   - Read only the listed files (and their direct test counterparts if explicitly referenced).
   - Follow Phase 1 (scratchpad) → Phase 2 (report) of the template strictly.
   - Use the strict report template at the bottom of the template file — no deviations.

Example dispatch prompt:

> You are the reviewer agent for sub-topic **`<id>`**. Your operating instructions are in `<template>` — read it once, execute its Phase 1 checklist as a scratchpad (turning `[ ]` into `[x]` and adding `*Notes:*`), then write its Phase 2 report to `<report_path>`. Do not read files outside this list:
>
> ```
> <files>
> ```
>
> Stack context:
>
> ```yaml
> <inline stack.yaml>
> ```
>
> When done, return STATUS: success|partial|error and the absolute report path. Do not summarise findings in chat.

**Wave completion gate**:

- [ ] Every dispatched agent returned STATUS within timeout
- [ ] Every expected `report_path` exists and is ≥ 500 bytes
- [ ] Any `STATUS: error` is logged in `<workspace_dir>/errors.yaml`

**Emit per wave**: `[Phase 4 wave <K>/<W>] <success>/<total> succeeded. Errors: <list of ids>.`

## Phase 5 — Finalisation

**Owner**: orchestrator (direct `bash` + small write).

1. write `<reports_dir>/_manifest.yaml`:

   ```yaml
   run_id: 2026-05-19T14-22-31Z
   scope: ["src/", "tests/"]
   stack: {...}
   reports:
     - id: code-quality/structure_sizing
       report: code-quality__structure_sizing_report.md
       status: success
     - id: security/ssrf_internal
       skipped: true
       reason: "No outbound HTTP with user-controlled URLs."
   errors: []
   ```

2. Print a console index of all reports with their absolute paths.

3. The consolidated executive summary is produced in Phase 6 by a dedicated synthesis agent — the orchestrator never reads finding contents itself.

**Emit**: `[Phase 5] <N> per-domain reports written. Manifest: <reports_dir>/_manifest.yaml. Synthesising executive summary...`

## Phase 6 — Final Consolidated Report (Executive Summary)

**Owner**: a single synthesis agent dispatched by the orchestrator. The orchestrator **must not** read the per-domain reports itself; it only collects paths and hands them off.

**Why a dedicated phase**: per-domain reports answer "what's wrong in *this* slice". The executive summary answers "what should the team fix *first*, and what cross-cutting patterns are showing up across slices?" These questions require reading every report — a job for one synthesis agent, not the orchestrator.

**Agent selection** (in priority order):

1. `zen-architect` (preferred — broad cross-domain synthesis)
2. `technical-research-analyst` (fallback — strong at structured synthesis from multiple inputs)
3. `general-purpose` (last-resort fallback)

**Dispatch prompt skeleton**:

> You are the **synthesis reviewer** for code-review run `<run_id>`. Read **only** the per-domain reports listed below and the manifest at `<reports_dir>/_manifest.yaml`. Do **not** read source code, do **not** open template files, do **not** re-derive findings. Your job is consolidation, not re-review.
>
> Reports to read:
>
> ```
> <list of every report_path from the manifest, success only>
> ```
>
> Skipped sub-topics (note in the "Coverage" section but do not investigate):
>
> ```
> <list of skipped sub_topic ids with reasons>
> ```
>
> Errored sub-topics (note in the "Coverage" section under gaps):
>
> ```
> <list of errored sub_topic ids>
> ```
>
> Write the consolidated report to `<reports_dir>/_executive_summary.md` using the **strict template** below. Cite every claim with `report_filename.md#section` or `file:line` from the underlying report — never invent locations.
>
> **STRICT EXECUTIVE SUMMARY TEMPLATE**:
>
> ```markdown
> # Code Review — Executive Summary
>
> **Run ID:** <run_id>
> **Scope:** <scope paths>
> **Stack:** <languages, frameworks>
> **Reports analysed:** <N>   **Skipped:** <M>   **Errored:** <K>
>
> ## 1. Overall Verdict
> One of: **Approved** | **Approved with minor suggestions** | **Blocked pending major changes**
> Two-to-three sentence rationale grounded in the highest-severity findings.
>
> ## 2. Severity Roll-Up
> | Severity | Count | Domains contributing |
> |---|---|---|
> | Critical | <n> | security, performance, ... |
> | High     | <n> | ... |
> | Medium   | <n> | ... |
> | Low      | <n> | ... |
>
> ## 3. Top Findings (ranked by severity then blast radius)
> For each — at minimum every Critical and every High — provide:
> - **[Sub-topic id]** — *Severity* — short title
>   - **Where:** `file:line` (cite the source report)
>   - **Why it matters:** 1–2 sentences of business/operational impact
>   - **Fix sketch:** one-line pointer to the proposed solution in the source report
>
> ## 4. Cross-Cutting Themes
> Patterns that appear in ≥ 2 domains. Examples to look for:
> - Missing HTTP timeouts surfacing in HTTP-resilience AND structured-logging (retries un-logged) AND concurrency (sync-in-async).
> - PII appearing in logs (privacy) AND error messages (code-quality) AND traces (observability).
> - Unbounded growth showing up in memory-leaks AND caching AND DB-N+1.
> Each theme: 1 sentence + the list of sub-topic ids where it appeared.
>
> ## 5. Validated Strengths
> Brief consolidation of "🟢 Validated Best Practices" across reports — the things the codebase is doing well. Group by theme.
>
> ## 6. Recommended Remediation Order
> Ordered list of work items (1, 2, 3, ...). Each item:
> - **Title** — one line
> - **Effort:** S | M | L
> - **Reports addressed:** [sub-topic ids]
> - **Rationale for ordering:** dependency, blast radius, or quick-win logic
>
> Optimise the order so that early items reduce the surface area for later items (e.g. introduce typed settings before re-doing secrets handling).
>
> ## 7. Coverage & Gaps
> - **Sub-topics skipped** (and why — from manifest)
> - **Sub-topics errored** (and the error class)
> - **Tools unavailable** (from `<workspace_dir>/preflight.yaml`) and which checks degraded to manual notes
> - **Explicit out-of-scope dimensions** (e.g. "no runtime profiling performed")
>
> ## 8. Per-Domain Verdict Index
> | Sub-topic | Verdict | Report |
> |---|---|---|
> | code-quality/structure_sizing | Approved with minor suggestions | code-quality__structure_sizing_report.md |
> | security/ssrf_internal | Skipped (no entry points) | — |
> | ... | ... | ... |
>
> ## 9. Limitations
> One short paragraph: this is a static synthesis of static reviews. No runtime data, no profiling, no live dependency scans, no production traffic shaping. Severity reflects code-level evidence only.
> ```
>
> When done, return STATUS: success and the absolute path of `_executive_summary.md`. Do not summarise findings in chat — the file is the deliverable.

**Validation gate** (orchestrator runs):

- [ ] `<reports_dir>/_executive_summary.md` exists and is ≥ 1500 bytes
- [ ] The file contains all 9 required sections (`grep -c '^## '` returns ≥ 9)
- [ ] If the synthesis agent failed, retry **once** with the next-priority agent before declaring the run incomplete

**Emit**: `[Phase 6] Executive summary written: <reports_dir>/_executive_summary.md.`

## Domain & Sub-topic Catalogue

Authoritative catalogue lives in [`skill://code-review/templates/_index.md`](./templates/_index.md). At a glance:

| Domain | Sub-topics |
|---|---|
| Code Quality | structure & sizing, naming conventions, coupling & cohesion, complexity & control flow, error handling, Pythonic idioms¹, type hints¹, data modelling |
| Test Quality | unit, property-based, integration, e2e, test performance |
| Documentation | ADRs, READMEs & runbooks, code comments, API contracts |
| Security | input validation, authn/authz, secrets management, SSRF & internal-threat, least privilege |
| Performance | N+1 DB queries, algorithmic complexity, memory & resource leaks, HTTP resilience, caching |
| Observability | structured logging, metrics & alerting |
| Architecture | separation of concerns, idempotency |
| CI/CD & DevOps | containerization, pipeline efficiency |
| Concurrency | async safety |
| Data Privacy | PII handling |
| Dependency | supply-chain hygiene |
| Configuration | env & config management |

¹ Python-conditional; skipped if Python is not detected.

## Agent-to-Sub-topic Mapping (fallbacks shown last)

| Sub-topic domain | Preferred agent | Fallback |
|---|---|---|
| Code Quality (Python) | `python-code-reviewer` | `general-purpose` |
| Test Quality | `python-test-specialist` | `python-code-reviewer` |
| Documentation | `diataxis-documentation-architect` | `general-purpose` |
| Security | `python-security-reviewer` | `general-purpose` |
| Performance | `python-performance-reviewer` | `performance-optimizer` |
| Observability | `python-code-reviewer` | `general-purpose` |
| Architecture | `systems-architecture-designer` | `python-architect` |
| CI/CD | `devops-engineer` | `devops-sre-automation` |
| Concurrency | `python-performance-reviewer` | `python-code-reviewer` |
| Data Privacy | `python-security-reviewer` | `general-purpose` |
| Dependency | `python-security-reviewer` | `devops-engineer` |
| Configuration | `python-architect` | `python-code-reviewer` |
| Executive Summary (Phase 6) | `zen-architect` | `technical-research-analyst` → `general-purpose` |

For non-Python stacks, the orchestrator substitutes the closest stack-appropriate agent (e.g. `javascript-frontend-specialist`, `elixir-code-reviewer`) or falls back to `general-purpose` with the language tag carried in the template context.

## Conventions

- **No emojis in committed reports** unless already present in the template's strict format (the user-provided template examples allow status emojis like 🟢 🔴 🏁 — keep them only there).
- **All findings cite `file:line`** (or `file:start-end`) — agents that emit findings without locations are rejected and re-dispatched once.
- **Severity** is part of each finding (Critical / High / Medium / Low) inside the strict report template.
- **The orchestrator carries the run_id (UTC timestamp)** through every artifact path so multiple runs never collide.

## Failure Handling

- A single agent failure (returned STATUS: error) does **not** abort the run. The orchestrator logs it and continues.
- If > 50 % of agents in a wave fail, the orchestrator stops, prints the errors file, and exits non-zero so the user can investigate.
- Missing optional tools (Phase 0) are surfaced in the relevant report's "Limitations" section, not silently ignored.

## Example final emission

```
[Phase 0] Pre-flight complete. Tools available: 9. Missing: hadolint.
[Phase 1] Stack: [python], frameworks: [pydantic, mcp, fastmcp, pytest, httpx].
[Phase 2] File map complete. 28 sub-topics scheduled, 4 skipped (no relevant files).
[Phase 3] Plan: 28 sub-topics across 7 waves. Agents: python-code-reviewer, python-security-reviewer, python-performance-reviewer, python-test-specialist, devops-engineer, systems-architecture-designer.
[Phase 4 wave 1/7] 4/4 succeeded.
... (waves 2–7) ...
[Phase 5] 28 per-domain reports written. Manifest: ai_docs/reports/code-review/2026-05-19T14-22-31Z/_manifest.yaml. Synthesising executive summary...
[Phase 6] Executive summary written: ai_docs/reports/code-review/2026-05-19T14-22-31Z/_executive_summary.md.
```
