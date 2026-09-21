---
name: fix-code-review
description: Consumes the output directory of the `code-review` skill and drives every finding to a verified fix. Parses each per-domain report, generates a TDD-shaped implementation plan per finding (with file/module/class/function/test scope), computes a file-ownership map so parallel agents never collide, then synthesises a single main plan that lists the agent roster up-front, runs implementation waves, validates the test suite, runs pre-commit quality checks, and emits a final aggregated report. The orchestrator never executes code or commands itself — every action is delegated to specialised agents. Output lands under `ai_docs/reports/fix-code-review/<timestamp>/`. Use this skill immediately after a `code-review` run when you want the findings turned into reviewable commits on a worktree or branch you can later merge.
argument-hint: "<code-review-output-dir> --target-branch <branch> [--min-severity critical|high|medium|low] [--out <dir>]"
model: pi/slow
disable-model-invocation: true
---

# Fix Code-Review Findings (Specialised-Agent Orchestration)
Default OMP model alias: `pi/slow`.
> OMP conversion note: Claude Code `SKILL.md` frontmatter hooks are not executed by OMP skills. The gate scripts remain bundled under `skill://fix-code-review/scripts/...`; do not assume automatic hook enforcement from this skill alone.

## Input Arguments

- `raw_args=$ARGUMENTS`

Parse `raw_args` to extract:

- `<input_dir>`: first positional argument — the timestamp directory produced by `code-review` (e.g. `ai_docs/reports/code-review/20260519T101500Z/`). **Required.**
- `<target_branch>`: value after `--target-branch`. The branch the user will eventually merge into (e.g. `main`). **Required.** Used as the base ref; never modified by this skill.
- `<min_severity>`: value after `--min-severity`. One of `critical|high|medium|low`. Default → `low` (i.e. include all).
- `<out_dir>`: value after `--out`. Default → `ai_docs/reports/fix-code-review/<UTC-timestamp>/`.

If any required argument is missing, **abort with a one-line error** that prints the correct invocation.

## Description

`code-review` produces evidence; this skill produces verified fixes. For every finding above `<min_severity>` it generates a self-contained plan that an agent with **no prior knowledge of the conversation** can execute, then orchestrates those plans through:

1. **Plan generation** (parallel, one delegated agent per finding) — each plan follows a strict TDD-when-applicable template with checklists.
2. **Conflict-free waves** — file-ownership map ensures parallel agents never touch the same file.
3. **Per-plan commits** — one commit per finding, message referencing the finding ID + originating report.
4. **Gated finish** — full test suite + pre-commit checks run after all plans land; failures are delegated back to fix agents.
5. **Aggregated report** — succeeded/failed/skipped, timings, delegated-agent roster, merge instructions.

The orchestrator answers three questions for every finding before any agent edits code:

1. **What is the fix** (precise scope: files, functions, tests).
2. **How to verify it** (failing test first when applicable, otherwise explicit "No test required" justification).
3. **How to roll it back** (single revertable commit).

## Usage

```
/fix-code-review ai_docs/reports/code-review/20260519T101500Z --target-branch main
/fix-code-review ai_docs/reports/code-review/20260519T101500Z --target-branch main --min-severity high
/fix-code-review ai_docs/reports/code-review/20260519T101500Z --target-branch develop --out ai_docs/reports/fix-cr-pr-123/
```

## Variables

- `<input_dir>`: resolved code-review output directory (must exist, must contain reports + manifest).
- `<reports_root>`: `<input_dir>` itself (per-domain reports live in subdirectories matching the code-review domains).
- `<out_dir>`: `<UTC-timestamp>`-stamped artefact root for this run.
- `<workspace_dir>`: `<out_dir>/.workspace/` (intermediate YAML/JSON between phases).
- `<plans_dir>`: `<out_dir>/plans/` (one Markdown plan per finding).
- `<finding_reports_dir>`: `<out_dir>/reports/` (one Markdown report per finding, written by the implementing agent).
- `<timings_path>`: `<out_dir>/timings.jsonl` (one line per delegated task: start, end, duration_ms, agent, status).
- `<findings_path>`: `<workspace_dir>/findings.yaml`.
- `<file_ownership_path>`: `<workspace_dir>/file_ownership.yaml`.
- `<waves_path>`: `<workspace_dir>/waves.yaml`.
- `<main_plan_path>`: `<out_dir>/main_plan.md`.
- `<final_report_path>`: `<out_dir>/final_report.md`.
- `<manifest_path>`: `<out_dir>/manifest.json`.
- `<templates_root>`: `skill://fix-code-review/templates/`.
- `<repo_root>`: the absolute path of the current git repository root (`git rev-parse --show-toplevel`).
- `<worktrees_root>`: `<parent(repo_root)>/<basename(repo_root)>-fix-code-review-<UTC-timestamp>/`. Parent directory for **every** worktree created during this run. It **MUST** live as a sibling of `<repo_root>` — never nested inside the repo, and never inside `<out_dir>` / `ai_docs/`. This keeps the worktrees out of `git status`, `rg`, IDE indexers, and the artefact tree.
- `<aggregation_branch>`: `fix-code-review/<UTC-timestamp>`. The internal branch this run accumulates commits onto, created off `<target_branch>` in Phase 1. Every per-finding fix and every gate fix-commit is merged into this branch. The user merges this branch into `<target_branch>` themselves after the run.
- `<integrator_worktree_path>`: `<worktrees_root>/_integrator/`. Long-lived for the duration of the run (Phase 1 → Phase 7). Has `<aggregation_branch>` checked out. Every per-finding agent runs its merge-back from this path, and the test/lint gates run inside it. Torn down by the Phase 7 cleanup dispatch.
- `<finding_worktree_path>(id)`: `<worktrees_root>/<finding-id>/`. One per finding, short-lived (created at the start of the finding's dispatch, torn down by the same agent after a successful merge-back). Each one has its own child branch `fix-code-review/<UTC-timestamp>/<finding-id>` checked out.
- `<vcs_ref>`: alias for `<aggregation_branch>`. Recorded in `<manifest_path>`. Every per-finding plan and gate dispatch references this single branch.
- `<max_parallel_agents>`: 4 (per `.claude/CLAUDE.md`). Caps concurrent per-finding worktrees per wave.

## Model Selection Policy (Cost Control)

Every `task` dispatch in this skill **MUST** Record the desired OMP model alias (`pi/slow`, `pi/default`, or `pi/smol`) in the task assignment/role when model tier matters; do not pass a `model` field to OMP `task`. Never let an agent inherit the orchestrator's pi/slow model by default — the orchestrator runs on pi/slow because it synthesises across phases, but the work it delegates rarely needs Opus-level reasoning. Use the table below; phases reference it by tier name.

| Tier | Model | When to use |
|---|---|---|
| `tier:pi/smol` | `pi/smol` | Mechanical, deterministic work: directory/branch creation, file-existence cross-checks, YAML/JSON validation. |
| `tier:pi/default` | `pi/default` | Default for code reading, structured artefact generation, report parsing, plan writing, implementation of localised fixes, test/lint fix loops, and final report synthesis. |
| `tier:pi/slow` | `pi/slow` | Reserved for deep reasoning: architecture synthesis, cross-cutting security/threat analysis, distributed-systems trade-offs. Used only where the table in each phase explicitly says so. |

**Per-agent overrides** (when the named subagent appears, prefer the indicated tier regardless of the phase default):

- `security-architect`, `systems-architecture-designer`, `distributed-systems-architect`, `zen-architect` (in architecture synthesis role) → `tier:pi/slow`.
- `python-security-reviewer` when triaging a `critical` security finding → `tier:pi/slow`; otherwise `tier:pi/default`.
- All other specialist agents (`python-backend-senior-engineer`, `python-test-specialist`, `performance-optimizer`, `devops-engineer`, `python-architect`, `python-code-reviewer`, `python-performance-reviewer`, `diataxis-documentation-architect`, `bug-hunter`, `commit-coordinator`, `technical-research-analyst`, `general-purpose`) → `tier:pi/default` unless a phase pins them higher.

Record the chosen model alongside every timing entry in `<timings_path>` (add a `model` field to each JSON line) so the final report can attribute spend per tier.

## Prompt

You are the **orchestrator** of a fix-code-review run. You **must not** edit source code, run tests, run linters, or invoke git commands yourself. Every command and tool call is delegated to a specialist agent. Your job is to:

1. Validate inputs and prepare the artefact root (Phase 0).
2. Set up the VCS workspace via a delegated agent (Phase 1).
3. Enumerate findings from the `code-review` output and filter by severity (Phase 2).
4. Generate one TDD-shaped plan per finding in parallel (Phase 3).
5. Compute the file-ownership map, derive parallel waves, and synthesise the main plan (Phase 4).
6. Hand off to the main plan: read `<main_plan_path>` and follow its instructions verbatim — every step in it is a delegation (Phase 5).
7. Delegate the final aggregated report (Phase 6).
8. Delegate the run self-validation and remove the in-progress marker on success (Phase 7).

### CRITICAL ORCHESTRATOR RULES

- You **MUST** delegate every command/edit/test/lint/git action to a sub-agent via the `task` tool. The orchestrator only performs lightweight Bash for directory creation, YAML/JSON read/write, and `read`-ing artefact files.
- You **MUST NEVER** open source files (`*.py`, `*.ts`, `*.go`, etc.), run `pytest`/`ruff`/`mypy`/`make`/`git commit`, or write fix code yourself.
- You **MAY** read workspace YAML/JSON (`findings.yaml`, `file_ownership.yaml`, `waves.yaml`, `manifest.json`), the generated plan/report Markdown files, and the templates under `<templates_root>`.
- You **MUST** load the relevant template and pass its absolute path to every delegated agent — agents must not re-derive structure.
- You **MUST** emit a one-line status message at every phase boundary.
- You **MUST** time every delegated task and append a record to `<timings_path>` (one JSON object per line: `{finding_id, phase, agent, model, started_at, ended_at, duration_ms, status}`).
- You **MUST** Record the desired OMP model alias (`pi/slow`, `pi/default`, or `pi/smol`) in the task assignment/role when model tier matters; do not pass a `model` field to OMP `task`. Never let a delegated agent inherit the orchestrator's pi/slow model.
- You **MUST** cap concurrent agents at `<max_parallel_agents>`.
- On agent failure: **continue other plans, record the failure**, and retry the failed plan once at the end using the next-priority agent from the agent map (Phase 5 implements this).
- You **MUST NEVER** merge into `<target_branch>`. Per-finding agents merge into `<aggregation_branch>` only. The final report tells the user how to merge `<aggregation_branch>` into `<target_branch>`.
- You **MUST NEVER** run `git worktree add` or `git worktree remove` yourself after Phase 1. Phase 1 creates `<integrator_worktree_path>` via a delegated agent; every per-finding worktree is created and torn down by its owning implementation agent; the final Phase 7 cleanup is delegated.
- You **MUST** serialize waves so that wave *N*'s merges into `<aggregation_branch>` complete before wave *N+1*'s worktrees are created off it. Within a wave, dispatches are parallel; between waves, the orchestrator waits for every per-finding agent in the wave to return before dispatching the next.
- You **MUST NEVER** add a `Co-Authored-By`, `Signed-off-by` (unless the repo already requires DCO), or any other authorship/attribution trailer to commit messages produced by this skill. Every commit message ends after its body. Propagate this rule verbatim into every delegated agent's prompt that may run `git commit`.
- You **MUST** maintain the run's phase tracker. Write `<workspace_dir>/phase.txt` with the literal token `phase_<N>_complete` at the end of every phase. The post-validation gate (`scripts/enforce_postvalidation_gate.sh`, wired as `PreToolUse(Agent|Bash|Write)`) reads this file and will block subsequent tool calls if a phase's required artefacts are missing.
- You **MUST** create the in-progress marker (`<out_dir>/.in_progress`) in Phase 0 and rely on Phase 7 to remove it on successful self-validation. Never remove the marker yourself outside Phase 7.

## Phase 0 — Pre-flight Validation

**Owner**: orchestrator (direct `bash` + Read).

Checks (abort with a clear error if any fails):

- [ ] **Orphan marker check**: `find ai_docs/reports/fix-code-review -maxdepth 2 -name .in_progress` returns no results. If a marker is found, abort with a one-line error pointing to the orphaned run directory; instruct the user to inspect it and remove the marker manually before re-invoking. **Never** silently delete an orphan — it represents a prior run that did not reach Phase 7.
- [ ] `<input_dir>` exists and is a directory.
- [ ] `<input_dir>` contains at least one per-domain report (search for `*.md` files in domain subdirectories) **and** a manifest (`manifest.json` or `manifest.yaml`) or an executive summary.
- [ ] `<target_branch>` exists locally: `git rev-parse --verify <target_branch>` succeeds.
- [ ] Working tree is clean enough to start: `git status --porcelain` returns no staged changes that conflict with `<target_branch>`. (If dirty, warn and continue — every fix lands inside its own worktree, so the user's working tree is never touched.)
- [ ] `<templates_root>` exists and contains `_index.md`, `per_finding_plan.md`, `main_plan.md`, `per_finding_report.md`, `final_report.md`.
- [ ] `<worktrees_root>` does **not** already exist on disk, and the user has write permission on `<parent(repo_root)>`. Abort with a one-line error if either check fails.
- [ ] `<aggregation_branch>` (= `fix-code-review/<UTC-timestamp>`) does **not** already exist: `git rev-parse --verify --quiet <aggregation_branch>` returns non-zero. Collision is effectively impossible given the timestamp, but the check is cheap and catches clock-skew or re-invocation bugs.

Create directories: `<out_dir>`, `<workspace_dir>`, `<plans_dir>`, `<finding_reports_dir>`.

Write an initial `<manifest_path>` with: input path, mode, target branch, min severity, out dir, UTC timestamps, orchestrator session id.

Then **arm the gate**:

1. `touch <out_dir>/.in_progress` — creates the marker the post-validation gate looks for.
2. `printf 'phase_0_complete' > <workspace_dir>/phase.txt` — records the run state.

From this point on, every phase below ends with a `printf 'phase_<N>_complete' > <workspace_dir>/phase.txt` write before moving on. The gate (`scripts/enforce_postvalidation_gate.sh`, wired as `PreToolUse`) reads this token and asserts the corresponding artefact checklist on every subsequent tool call.

## Phase 1 — VCS Setup

**Owner**: delegated agent (priority: `devops-engineer` → `general-purpose`).
**Model**: `tier:pi/smol` (mechanical git/worktree operations — no reasoning required).

Dispatch a single agent with a prompt containing `<target_branch>`, `<out_dir>`, `<repo_root>`, `<worktrees_root>`, `<integrator_worktree_path>`, `<aggregation_branch>`.

Required actions, **in order**:

1. `mkdir -p <worktrees_root>`. Abort if `<worktrees_root>` already exists with contents.
2. `git -C <repo_root> branch <aggregation_branch> <target_branch>`. The aggregation branch is created without being checked out anywhere.
3. `git -C <repo_root> worktree add <integrator_worktree_path> <aggregation_branch>`. This long-lived worktree is where every per-finding agent will perform its merge-back and where Phase 5 gates will run.
4. Capture `base_sha` = the SHA `<aggregation_branch>` points to immediately after creation (= `<target_branch>` HEAD at run start).

Constraints:

- **Never** modify `<target_branch>`; never force-push; never `git reset --hard`.
- Before invoking `git worktree add`, abort if `<integrator_worktree_path>` already exists.
- Place worktrees only under `<worktrees_root>`. Never inside `<repo_root>`, `<out_dir>`, or `ai_docs/`.

Output contract: write `<workspace_dir>/vcs.yaml` with the schema below and print one summary line.

```yaml
aggregation_branch: <name>
base_sha: <sha>
worktrees_root: <absolute path>
integrator_worktree_path: <absolute path>
```

The orchestrator reads `<workspace_dir>/vcs.yaml` and updates `<manifest_path>` with `vcs_ref` (= `aggregation_branch`), `base_sha`, `worktrees_root`, and `integrator_worktree_path`. Then write `phase_1_complete` to `<workspace_dir>/phase.txt`.

## Phase 2 — Enumerate Findings

**Owner**: delegated agent (priority: `general-purpose`).
**Model**: `tier:pi/default` (structured parsing across Markdown reports — pi/default handles taxonomy mapping and YAML emission reliably).

Dispatch one agent with the following inputs:

- `<input_dir>` (the code-review output to parse).
- `<min_severity>` (severities to include: `critical|high|medium|low` and everything ranked higher).
- `<findings_path>` (write target).
- Optional: the executive summary path inside `<input_dir>` to cross-check the count.

Required behaviour (encoded in the prompt):

- Walk every per-domain report under `<input_dir>` (the code-review `templates/` taxonomy: code-quality, test-quality, documentation, security, performance, observability, architecture, ci-devops, concurrency, data-privacy, dependency, configuration).
- Extract every finding in the strict report sections (`🔴 Areas for Improvement`).
- For each finding produce a YAML entry:

```yaml
- id: <stable-slug e.g. SEC-001>
  severity: critical|high|medium|low
  domain: <e.g. security/secret_management>
  source_report: <relative path inside input_dir>
  title: <short title from the finding>
  files: [<file:line>, ...]      # ALL files mentioned in the finding
  functions: [<dotted path>, ...] # best-effort extraction
  proposed_solution: <verbatim "How to fix it" block>
  candidate_agent: <see agent map below>
```

- Skip findings whose severity is below `<min_severity>`.
- Write the full list to `<findings_path>` and print counts per severity.

### Domain → Implementing Agent Map

The enumeration agent uses this map to populate `candidate_agent`. The orchestrator reuses it during retry.

| Domain | Primary | Fallback (in order) |
|---|---|---|
| `security/*`, `data-privacy/*` | `security-architect` | `python-security-reviewer` → `python-backend-senior-engineer` |
| `performance/*` | `performance-optimizer` | `python-performance-reviewer` → `python-backend-senior-engineer` |
| `concurrency/*` | `python-backend-senior-engineer` | `distributed-systems-architect` → `bug-hunter` |
| `architecture/*` | `systems-architecture-designer` | `zen-architect` → `python-architect` |
| `observability/*`, `configuration/*` | `python-backend-senior-engineer` | `general-purpose` |
| `dependency/*`, `ci-devops/*` | `devops-engineer` | `devops-sre-automation` → `general-purpose` |
| `code-quality/*` | `python-backend-senior-engineer` | `python-code-reviewer` → `elixir-code-architect` (non-Python) |
| `test-quality/*` | `python-test-specialist` | `elixir-test-architect` → `bug-hunter` |
| `documentation/*` | `diataxis-documentation-architect` | `general-purpose` |

For non-Python stacks the enumeration agent substitutes language-appropriate fallbacks (the code-review manifest names the stack).

After the agent returns and `<findings_path>` is written, the orchestrator writes `phase_2_complete` to `<workspace_dir>/phase.txt`.

## Phase 3 — Generate Per-Finding Plans

**Owner**: multiple delegated agents (priority per finding: `zen-architect` → `python-architect` → `general-purpose`).
**Model**: `tier:pi/default` by default. Escalate a single finding to `tier:pi/slow` **only if** its severity is `critical` **and** its domain is `architecture/*`, `security/*`, or `concurrency/*` (cases where the plan itself requires architectural reasoning). Every other plan generation — including `high`-severity findings — stays on pi/default; the plans are structured artefacts driven by a strict template, not original design work.

Procedure:

1. read `<findings_path>` and partition findings into batches of ≤ `<max_parallel_agents>`.
2. For each batch, dispatch agents in parallel (single message, multiple `task` calls). Each agent receives **one finding** and these inputs:
   - The finding YAML entry.
   - Path to the originating report: `<input_dir>/<source_report>`.
   - Template path: `<templates_root>/per_finding_plan.md`.
   - Output path: `<plans_dir>/<finding-id>.md`.
   - The agent map row matching the finding's domain (so the plan can name the implementing agent up-front).
3. Each agent's contract:
   - Open the report at the line(s) cited by the finding to extract surrounding context.
   - Open each file in `files` to inventory functions/classes/tests that must change.
   - Produce a plan that strictly follows `per_finding_plan.md`. **Do not deviate from the template structure.**
   - The plan must enable an implementing agent with **no other context** to act: include file paths, function names, test paths, the failing-test-first step (when applicable), exact command(s) to run for verification, and the commit message format.
   - **Checkbox discipline (HARD RULE)**: The template separates plan-author fields (definition lists, prose bullets, tables — never checkboxes) from implementer action items (checkboxes in sections E and F only — always emitted as `- [ ]`). Pre-ticking a `[x]` anywhere above the `## Strict Validation Gate` heading is a defect; the orchestrator will reject and regenerate the plan. The single planning-agent self-check block below that heading is the **only** place the agent may tick boxes, and only after the plan is otherwise complete.
   - **Path discipline (HARD RULE)**: `<templates_root>/per_finding_plan.md` is **read-only**. The agent MUST NOT `write`, `edit`, or otherwise mutate any file under `<templates_root>/`. The only file the agent writes is `<plans_dir>/<finding-id>.md`. Treat the template as a structural reference, not a scratchpad. The orchestrator verifies the templates directory's mtimes are unchanged after each batch; any mutation is logged and the offending plan is regenerated.
   - Record start/end times via Bash `date -u +%s%3N` and append to `<timings_path>` (including the `model` field per the Model Selection Policy).

After Phase 3, the orchestrator validates **every** generated plan against the rules below. A plan that fails any rule is rejected and regenerated once with the next-priority agent. Then write `phase_3_complete` to `<workspace_dir>/phase.txt`.

**Per-plan validation rules** (the orchestrator runs these with simple Bash/grep — no agent needed):

| # | Rule | Check |
|---|---|---|
| 1 | File exists | `<plans_dir>/<finding-id>.md` is a regular file, size ≥ 1 KB. |
| 2 | No pre-checked boxes in the body | The substring `- [x]` must not appear **above** the line `## Strict Validation Gate` (the gate below that heading is the only place the planning agent self-ticks). Implement as: split the file at that heading; the upper half must contain zero `- [x]` occurrences. |
| 3 | No `<placeholder>` residue | The literal substrings `<e.g.`, `<src/.../`, `<tests/.../`, `<path to`, and `<finding-id>` must not appear in sections A or C. Use a regex pass over the lines between `## A. Header` and `## D. Test Strategy`. |
| 4 | Section A is a definition list | The first 30 lines after `## A. Header` must contain at least 8 lines matching `^- \*\*[a-z_]+:\*\*` (definition-list rows) and **zero** lines matching `^- \[[ x]\]` (no checkboxes). |
| 5 | Section E is unchecked | Between `## E. Implementation Steps` and `## F. Commit`, every numbered checklist line must match `^\d+\. \[ \] ` (i.e., unchecked). No `\[x\]` allowed here. |
| 6 | Section F is unchecked | Between `## F. Commit` and `## G. Pre-flight Constraints`, every `- [ ]` / `- [x]` line must be `- [ ]`. |
| 7 | Section G has no checkboxes | Between `## G. Pre-flight Constraints` and `## H.`, no line matches `^- \[[ x]\]`. |
| 8 | Test-strategy branch selection | Exactly one of D.1 / D.2 contains filled-in fields (no `<...>` placeholders); the other is left blank under its heading. |
| 9 | Self-containment | No occurrence of the strings "the conversation", "the user", "earlier context", or "as discussed" anywhere in the plan. |
| 10 | Length bound | Plan is 90–290 lines (`wc -l`). Bumped from 250 to accommodate the mandatory worktree-lifecycle section. |
| 11 | Templates untouched | `stat -c %Y <templates_root>/*.md` snapshot taken before the batch matches the snapshot taken after. Any drift means a planning agent wrote to the template path; mark all plans in that batch for regeneration. |
| 12 | Worktree lifecycle section present | Plan contains the heading `## D.5 Worktree Lifecycle` and the literal substrings `git worktree add` and `git worktree remove`. The section must reference both `<finding_worktree_path>` and `<integrator_worktree_path>` placeholders (or their resolved paths). |
| 13 | No stale "shared worktree" wording | The literal substrings `the run's worktree`, `the shared worktree`, and `the worktree named in the run manifest` must **not** appear. The new model is per-plan worktrees + a shared integrator; older wording would mislead the implementing agent. |
| 14 | Merge-back step present in section F | Between `## F. Commit` and `## G. Pre-flight Constraints`, at least one checklist line contains `git -C <integrator_worktree_path> merge --no-ff` (placeholder accepted). |

The orchestrator records each rule's pass/fail in `<workspace_dir>/plan_validation.yaml` keyed by finding-id. On any rule failure the plan is regenerated once with the next-priority agent. If the regenerated plan also fails any rule, mark the finding `failed_planning` in `<workspace_dir>/status.yaml` and continue — the finding will be reported as skipped in the final report.

## Phase 4 — File-Ownership Map, Waves, and Main Plan

**Owner**: delegated agent (priority: `zen-architect` → `project-orchestrator` → `general-purpose`).
**Model**: `tier:pi/slow` for the primary `zen-architect` dispatch (synthesises ownership map, wave packing, and main plan — genuine cross-cutting reasoning). Fallback dispatches to `project-orchestrator` or `general-purpose` use `tier:pi/default`, since by then the structural decisions have already been narrowed.

Dispatch one agent with:

- `<findings_path>`, `<plans_dir>`, `<templates_root>/main_plan.md`, output paths `<file_ownership_path>`, `<waves_path>`, `<main_plan_path>`.

The agent must:

1. **Build the file-ownership map**: parse each plan's `files` and `tests` sections; emit `<file_ownership_path>` mapping `file → [finding-ids]` and `finding-id → [files]`.
2. **Pack into waves** using a greedy first-fit-decreasing algorithm. Disjointness within a wave now protects **merge-back** correctness: every per-finding worktree in a wave is created off the same `<aggregation_branch>` HEAD and merges back independently; file-disjoint sets guarantee those merges are conflict-free fast-forwards or trivial `--no-ff` merges. Two findings that touch the same file land in different waves, so the second one forks off an aggregation HEAD that already contains the first's commit.
   - Sort findings by severity (critical → low) then by file-set size (larger first).
   - For each finding, place it in the lowest-index wave whose union of files is disjoint from the finding's files; otherwise open a new wave.
   - Cap each wave at `<max_parallel_agents>` findings (also the cap on concurrent per-finding worktrees).
   - Emit `<waves_path>`: ordered list of waves, each wave is a list of `{finding_id, agent, files, finding_worktree_path, child_branch}`.
3. **Generate `<main_plan_path>`** from `<templates_root>/main_plan.md` filling in:
   - Agent roster table (one row per agent appearing in any wave + the test/lint agents).
   - Wave-by-wave dispatch tables. Each row names `finding_worktree_path` and the per-plan child branch `fix-code-review/<UTC>/<finding-id>` so the dispatch is self-contained.
   - An explicit **wave barrier** note between waves: the orchestrator must wait for every per-finding agent in wave *N* to return (and confirm its merge-back into `<aggregation_branch>` is visible via `git log <aggregation_branch>`) before dispatching wave *N+1*.
   - Per-wave commit policy (one commit per plan, message format `fix(<domain>): <title> [<finding-id>] (refs <source_report>)`, merged into `<aggregation_branch>` from `<integrator_worktree_path>`).
   - Test-suite gate (autodetect: `pytest`, `mix test`, `npm test`, `cargo test`; skip categories with no tests; **runs inside `<integrator_worktree_path>`**).
   - Pre-commit gate (autodetect Makefile target: `make pre-commit`, `make lint`, `make check`; otherwise run each available tool individually: `ruff`, `mypy`, `pytest -q`, `eslint`, `prettier --check`, etc.; **runs inside `<integrator_worktree_path>`**).
   - Failure handling: continue, record, retry once at end with next-priority agent.
   - Final report step pointing to Phase 6.

The orchestrator does **not** rewrite the main plan. If validation fails (missing sections, no waves, syntax issues), retry once with the next-priority agent. Then write `phase_4_complete` to `<workspace_dir>/phase.txt`.

## Phase 5 — Execute the Main Plan

**Owner**: orchestrator (reads + delegates) following `<main_plan_path>` verbatim.
**Model selection (per dispatch)**: this is the bulk of the run's token spend, so the rules are explicit:

- **Default** implementation dispatch → `tier:pi/default`. This covers `python-backend-senior-engineer`, `python-test-specialist`, `performance-optimizer`, `devops-engineer`, `diataxis-documentation-architect`, `python-code-reviewer`, `python-performance-reviewer`, and `general-purpose`.
- **Escalate to `tier:pi/slow`** only when **all** of the following hold for that finding:
  - the implementing agent is `security-architect`, `systems-architecture-designer`, `distributed-systems-architect`, or `zen-architect`, **and**
  - the finding's severity is `critical` or `high`, **and**
  - the finding's domain is `security/*`, `architecture/*`, `concurrency/*`, or `data-privacy/*`.
  Otherwise these agents also run on `tier:pi/default` (their value is taxonomy/judgment, which pi/default handles for medium/low findings).
- **Test-suite fix loop** (`bug-hunter`) → `tier:pi/default` by default; escalate to `tier:pi/slow` only after a second consecutive failure on the same finding.
- **Lint/pre-commit fix loop** (`commit-coordinator`) → `tier:pi/default` always (deterministic mechanical fixes; never needs pi/slow).
- **Retry-once policy fallback dispatches** → use the same tier as the original dispatch (do **not** upgrade to pi/slow on retry unless the agent-override rule above already requires it).

1. `read` `<main_plan_path>` end-to-end.
2. Walk its steps in order. For each step, dispatch the named agent with the inputs specified by the plan **and the model selected by the rules above**. Run intra-wave steps in parallel (single message, multiple `task` calls, ≤ `<max_parallel_agents>`), and inter-wave steps sequentially.
3. Every per-finding dispatch's prompt **MUST** include: the plan path, `<aggregation_branch>`, `<integrator_worktree_path>`, the finding's own `<finding_worktree_path>`, the per-plan child-branch name `fix-code-review/<UTC>/<finding-id>`, the completion-report template path, and the timings path. The agent owns the entire worktree lifecycle (create → fix → commit → merge-back from `<integrator_worktree_path>` → remove worktree → delete child branch). The orchestrator never runs `git worktree add`/`remove`.
4. After each delegation:
   - Append a timing record to `<timings_path>` (must include the `model` field).
   - Validate the agent's contractual outputs:
     - The per-finding report exists at `<finding_reports_dir>/<finding-id>.md`.
     - `git -C <repo_root> log --format=%s <aggregation_branch>` contains a commit subject (or merge-commit subject) referencing `[<finding-id>]`.
     - `<finding_worktree_path>` no longer exists (per-plan worktree was torn down).
     - The per-plan child branch is gone: `git -C <repo_root> branch --list 'fix-code-review/<UTC>/<finding-id>'` returns empty.
   - On any check failure, mark the finding `failed` in `<workspace_dir>/status.yaml` and record which check failed (the retry phase uses this).
5. **Wave barrier**: after dispatching a wave's findings in parallel, wait for all to return and validate all of them before opening the next wave. This guarantees the next wave's worktrees fork off an `<aggregation_branch>` HEAD that already contains the previous wave's merges.
6. Gate steps (test suite, pre-commit) run after the implementation waves, **inside `<integrator_worktree_path>`** (it already has `<aggregation_branch>` checked out with every per-finding merge applied). Failures cycle back to a single delegated `bug-hunter` (or `commit-coordinator` for lint) with the failure output as input, using the tier rules above. Their fix commits land directly on `<aggregation_branch>` from `<integrator_worktree_path>` (no per-fix worktree).
7. **Retry-once policy** for any finding marked `failed`: dispatch the next-priority agent from the agent map with the same plan and the same tier rules. The retry agent creates a **fresh** `<finding_worktree_path>` (the original was torn down or left dangling on the failed path; the retry uses the same path after first removing any leftover via `git worktree remove --force` + `rm -rf`). If retry still fails, leave it `failed`, leave the failure-state worktree intact for inspection, and continue.

The orchestrator never short-circuits the main plan and never edits files itself.

After the main plan's gates and retry loop have all run (success or recorded failure), the orchestrator writes `phase_5_complete` to `<workspace_dir>/phase.txt`.

## Phase 6 — Final Aggregated Report

**Owner**: delegated agent (priority: `technical-research-analyst` → `general-purpose`).
**Model**: `tier:pi/default` (template-driven aggregation across YAML/JSONL inputs — no novel reasoning required).

Dispatch one agent with:

- `<findings_path>`, `<waves_path>`, `<timings_path>`, `<finding_reports_dir>`, `<workspace_dir>/status.yaml`, `<manifest_path>`.
- Template: `<templates_root>/final_report.md`.
- Output: `<final_report_path>`.

Required contents (the template enforces them):

- Run header (input dir, vcs_ref = aggregation_branch, base SHA, target branch, worktrees_root, integrator_worktree_path, min severity, totals).
- Outcome tables (succeeded / failed / skipped, per severity).
- Agent roster used, with task counts and aggregate duration per agent **and the model tier used** (haiku/sonnet/opus).
- Timing summary (total wall clock, longest plan, fastest plan, parallelism factor).
- **Model spend breakdown**: task count and aggregate duration per tier (`tier:pi/smol`, `tier:pi/default`, `tier:pi/slow`), plus a flag for any dispatch where the chosen tier deviated from the policy (with the reason recorded in `<timings_path>`).
- Cross-cutting themes (deduplicate similar fixes across findings).
- Merge instructions (worktree: `git merge --no-ff <branch>` from `<target_branch>`; branch: same but no worktree dance). **The skill does not run the merge.**
- Links: each finding's plan, report, and originating code-review report.

Validation gate after the agent returns:

- `<final_report_path>` exists and is ≥ 2 KB.
- Contains at least 8 `^## ` sections.
- If invalid, retry once with the next-priority agent.

After validation passes (or after the retry), the orchestrator writes `phase_6_complete` to `<workspace_dir>/phase.txt`. **Do not** print the user summary yet — that happens after Phase 7.

## Phase 7 — Run Self-Validation

**Owner**: delegated agent (priority: `general-purpose`).
**Model**: `tier:pi/smol` (deterministic file-existence, schema, and git-log cross-checks — no reasoning required). Fall back to `tier:pi/default` only if the pi/smol run reports a parse/JSON error on the validation YAML it must emit.

Phase 7 exists because the orchestrator's per-phase checks live in the orchestrator itself — if it crashes between phases, those checks never run. The `PreToolUse` gate (`scripts/enforce_postvalidation_gate.sh`) catches that deterministically on any subsequent tool call. Phase 7 adds the **semantic** layer on top: it cross-checks consistency between the artefact tree, the recorded status, and the VCS state, then either clears the in-progress marker or annotates the final report with what is missing.

Dispatch one agent with:

- Inputs: `<findings_path>`, `<workspace_dir>/status.yaml`, `<plans_dir>`, `<finding_reports_dir>`, `<timings_path>`, `<final_report_path>`, `<manifest_path>`, `<vcs_ref>`.
- Output: `<workspace_dir>/validation.yaml` with the schema below; banner appended to `<final_report_path>` on failure.

Required cross-checks (each becomes one key in `validation.yaml`):

| Check | Pass criterion |
|---|---|
| `every_finding_has_plan` | For every finding in `<findings_path>`, `<plans_dir>/<id>.md` exists and is ≥ 1 KB. |
| `every_finding_resolved` | For every finding, either `<finding_reports_dir>/<id>.md` exists **or** `<workspace_dir>/status.yaml` marks the finding as `failed`/`skipped`. |
| `every_success_has_commit` | For every finding with `outcome: succeeded`, `git -C <repo_root> log --format=%s <aggregation_branch>` contains a commit (or merge commit) whose subject references `[<id>]`. |
| `timings_complete` | `<timings_path>` has a record for every dispatched task referenced in `status.yaml`. |
| `gate_outputs_present` | `<workspace_dir>/gate_tests.yaml` and `<workspace_dir>/gate_precommit.yaml` exist, OR the final report's section F explicitly marks them `skipped` with a reason. |
| `final_report_well_formed` | `<final_report_path>` is ≥ 2 KB and has ≥ 8 `^## ` sections (already checked in Phase 6 — re-asserted here for the audit trail). |
| `manifest_consistent` | `<manifest_path>` `vcs_ref` equals `<aggregation_branch>`; `base_sha` is an ancestor of `<aggregation_branch>` HEAD; `<worktrees_root>` is a sibling of `<repo_root>` and is **not** nested inside `<repo_root>` or `<out_dir>`. |
| `no_dangling_child_branches` | `git -C <repo_root> branch --list 'fix-code-review/<UTC>/*'` returns empty (every per-plan child branch was deleted after merge-back). Findings with `outcome: failed` are exempt — their branches may remain for inspection; the check counts only `outcome: succeeded` findings. |
| `no_dangling_finding_worktrees` | `git -C <repo_root> worktree list --porcelain` contains no entry under `<worktrees_root>/<finding-id>/` for any **succeeded** finding. The `<integrator_worktree_path>` is still expected at this point — it is torn down by the Phase 7 cleanup dispatch below. |

`validation.yaml` schema:

```yaml
status: pass | fail
checks:
  <check_name>:
    status: pass | fail
    detail: <short string; required when status == fail>
fail_count: <integer>
summary: <one-line summary string>
```

Agent post-actions:

- If `status: pass`:
  - Tear down the integrator worktree: `git -C <repo_root> worktree remove <integrator_worktree_path>`. If the worktree has uncommitted state (it should not — gates either land their fixes on `<aggregation_branch>` or the validation would have flagged the discrepancy), abort and mark the check failed instead.
  - If `<worktrees_root>` is now empty (`find <worktrees_root> -mindepth 1 -maxdepth 1 | head -n1` is empty), `rmdir <worktrees_root>`. Otherwise leave it for the user to inspect (likely a failed finding left a worktree behind).
  - `rm <out_dir>/.in_progress`. This is the **only** place the marker is removed.
- If `status: fail`: leave the marker in place; leave `<integrator_worktree_path>` and `<worktrees_root>` intact for inspection; prepend a banner section `## ⚠️ Validation Failures` to `<final_report_path>` listing each failed check with its `detail`. Do **not** remove the marker.

The orchestrator then writes `phase_7_complete` to `<workspace_dir>/phase.txt` (the gate's stale-marker cleanup uses this token to decide it is safe to remove an orphaned marker on a future tool call).

Finally, print the user summary:

- On Phase 7 pass: `<succeeded>/<total> findings fixed on <vcs_ref>; report: <final_report_path>`.
- On Phase 7 fail: `VALIDATION FAILED: <fail_count> check(s) failed; see banner at top of <final_report_path>; marker retained at <out_dir>/.in_progress for inspection`.

## Failure & Edge Cases

- **No findings above `<min_severity>`**: write an empty final report explaining the threshold and stop. No VCS ref or worktrees are created.
- **All plans fail**: still emit the final report. Do **not** delete `<aggregation_branch>`, `<integrator_worktree_path>`, or `<worktrees_root>` — the user may want to inspect.
- **Per-plan worktree setup fails** (e.g. `git worktree add` errors): the per-finding agent marks the finding `failed_setup` in `<workspace_dir>/status.yaml` and exits without touching `<aggregation_branch>`. The retry-once policy still applies; the retry agent uses the same `<finding_worktree_path>` after first removing any leftover via `git worktree remove --force <finding_worktree_path>` and `rm -rf <finding_worktree_path>`.
- **Per-plan merge-back fails** (should not occur if the file-ownership map is correct; possible if the plan touched files outside its declared scope): the per-finding agent marks the finding `failed_merge`, leaves the per-plan child branch and worktree intact for inspection, and exits. The orchestrator records this and does **not** retry merge-back automatically — manual triage is required.
- **Concurrent disk pressure**: each wave creates up to `<max_parallel_agents>` full worktree checkouts simultaneously. For very large repositories on slow storage, this multiplies disk I/O. If checkouts are unusually slow, the orchestrator does not throttle — the cap is the only knob; reduce `<max_parallel_agents>` in `.claude/CLAUDE.md` if needed.
- **Pre-commit gate detects pre-existing failures** unrelated to this run's edits: record them in the final report under "Pre-existing failures" and do not attempt to fix.
- **`<target_branch>` moved during the run**: the manifest's `base_sha` is the source of truth; the final report notes the divergence. `<aggregation_branch>` was forked from `base_sha`, so the user's later `git merge` may need a rebase or merge-commit.
- **Test suite missing**: skip the test gate, note "no tests detected" in the final report, do not fail the run.

## Output Layout

```
<out_dir>/
├── .in_progress                    # marker; Phase 0 creates, Phase 7 removes on success
├── manifest.json                   # records <aggregation_branch>, <worktrees_root>, <integrator_worktree_path>, base_sha
├── main_plan.md
├── final_report.md                 # may carry a ⚠️ Validation Failures banner if Phase 7 failed
├── timings.jsonl
├── plans/
│   ├── <finding-id>.md             # one per included finding
│   └── ...
├── reports/
│   ├── <finding-id>.md             # filled by implementing agents
│   └── ...
└── .workspace/
    ├── phase.txt                   # phase_<N>_complete; the gate script reads this
    ├── vcs.yaml
    ├── findings.yaml
    ├── file_ownership.yaml
    ├── waves.yaml
    ├── status.yaml
    ├── gate_tests.yaml             # written by the test-suite gate (or marked skipped)
    ├── gate_precommit.yaml         # written by the pre-commit gate (or marked skipped)
    └── validation.yaml             # written by Phase 7

# Sibling to <repo_root>, NOT nested inside <out_dir>:
<parent(repo_root)>/<basename(repo_root)>-fix-code-review-<UTC-timestamp>/   # <worktrees_root>
├── _integrator/                                                             # <integrator_worktree_path> — long-lived (Phase 1 → Phase 7 cleanup)
├── <finding-id-1>/                                                          # <finding_worktree_path>(id) — short-lived (per-wave); removed on success
├── <finding-id-2>/                                                          # short-lived; removed on success
└── ...                                                                      # any subdir surviving Phase 7 belongs to a failed finding
# On a fully successful run, <worktrees_root> is rmdir'd by Phase 7 and disappears.
```

## Template Catalogue

See [`templates/_index.md`](./templates/_index.md) for the authoritative list. Templates are mandatory inputs to every delegated agent that produces a structured artefact:

| Artefact | Template |
|---|---|
| Per-finding plan | `templates/per_finding_plan.md` |
| Main orchestration plan | `templates/main_plan.md` |
| Per-finding completion report | `templates/per_finding_report.md` |
| Final aggregated report | `templates/final_report.md` |
