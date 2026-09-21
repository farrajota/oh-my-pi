# Main Orchestration Plan — fix-code-review

> Template for the Phase 4 synthesis agent. The orchestrator reads the filled plan in Phase 5 and follows it verbatim. **Every step in this plan is a delegation to a named agent — the orchestrator must not execute commands itself.**

## What this template MUST produce

- A roster of every agent involved, listed up-front.
- A wave-by-wave dispatch sequence with file-ownership disjointness proof.
- Per-plan worktree lifecycle baked into every dispatch row (path + child branch).
- Sequential gates (test suite, pre-commit) after all implementation waves, **running inside `<integrator_worktree_path>`**.
- Retry-once policy for failed plans.
- A final-report hand-off step.

## What this template MUST NOT produce

- Free-form prose telling the orchestrator to "figure out" anything.
- Steps without an explicit agent assignment.
- Auto-merge into `<target_branch>` (the skill only merges into `<aggregation_branch>`).
- A "shared worktree" — every finding gets its own; only `<integrator_worktree_path>` is shared, and only for merge-back and gates.
- Long-lived per-plan branches — every per-plan child branch is created and deleted within its own dispatch.

---

## A. Run Header

- [ ] `run_id`: `<UTC-timestamp>`
- [ ] `input_dir`: `<code-review output dir>`
- [ ] `out_dir`: `<artefact root>`
- [ ] `vcs_ref`: `<aggregation_branch>` (this is what every per-finding merge-back targets; the user later merges this into `<target_branch>`)
- [ ] `aggregation_branch`: `fix-code-review/<UTC-timestamp>`
- [ ] `base_sha`: `<sha of target_branch when this run started>`
- [ ] `target_branch`: `<target_branch>` (never modified by this skill)
- [ ] `worktrees_root`: `<parent(repo_root)>/<basename(repo_root)>-fix-code-review-<UTC-timestamp>/`
- [ ] `integrator_worktree_path`: `<worktrees_root>/_integrator/` (long-lived; holds `<aggregation_branch>`; gates run here)
- [ ] `min_severity`: `<critical|high|medium|low>`
- [ ] `total_findings_included`: `<N>`
- [ ] `max_parallel_agents`: `4`

## B. Agent Roster (declared up-front)

Every agent that will be dispatched during this run, with role and counts. The orchestrator reads this table first so failures can immediately resolve to a fallback.

| Role | Primary agent | Fallback chain | Plans assigned | Owns gates |
|---|---|---|---|---|
| Implementation — `<domain-1>` | `<agent>` | `<a → b → c>` | `<count>` | — |
| Implementation — `<domain-2>` | `<agent>` | `<a → b>` | `<count>` | — |
| Test-suite gate | `python-test-specialist` | `bug-hunter` → `general-purpose` | — | tests |
| Pre-commit gate | `commit-coordinator` | `devops-engineer` → `bug-hunter` | — | lint/format/type |
| Final report | `technical-research-analyst` | `general-purpose` | — | report |

- [ ] Roster lists every distinct agent that appears in any wave.
- [ ] Every fallback chain matches the agent map in `SKILL.md`.

## C. File-Ownership Map (summary)

- [ ] Pointer to full map: `<file_ownership_path>`.
- [ ] Hot files (touched by ≥ 2 findings) listed here with the wave in which each finding runs:

| File | Findings | Resolution |
|---|---|---|
| `<src/x.py>` | `[FIND-001, FIND-007]` | FIND-001 in Wave 1, FIND-007 in Wave 2 (different waves) |
| ... | ... | ... |

- [ ] No file appears twice in the same wave.

## D. Waves (dispatch sequence)

Each wave is one parallel dispatch (≤ `<max_parallel_agents>` agents in a single message). Waves run strictly in order.

### Wave 1 — `<name>`

| finding_id | severity | agent | plan path | finding_worktree_path | child_branch | commit policy |
|---|---|---|---|---|---|---|
| `<id>` | `<sev>` | `<agent>` | `<plans/<id>.md>` | `<worktrees_root>/<id>/` | `fix-code-review/<UTC>/<id>` | one commit per plan, merged into `<aggregation_branch>` |

- [ ] All findings in this wave have disjoint `target_files` (proves the per-plan merges into `<aggregation_branch>` are conflict-free).
- [ ] Dispatch instruction for the orchestrator:
  > In one message, call `task` once per row, passing each agent: the plan path, `<aggregation_branch>`, `<integrator_worktree_path>`, the row's `finding_worktree_path`, the row's `child_branch`, the completion-report template `<templates_root>/per_finding_report.md`, and the timings path. Each agent owns the entire worktree lifecycle for its row (create → fix → commit → merge-back from `<integrator_worktree_path>` → remove worktree → delete child branch). Wait for **all** to complete before the wave barrier.

#### Wave 1 → Wave 2 barrier

- [ ] Every wave-1 finding has either:
  - succeeded: its commit (or merge commit) is visible via `git -C <repo_root> log --format=%s <aggregation_branch>`, `<finding_worktree_path>` is gone, and the child branch is deleted; **or**
  - recorded as `failed_*` in `<workspace_dir>/status.yaml` (skill continues; the retry-once phase will revisit).
- [ ] `<integrator_worktree_path>` is still on `<aggregation_branch>` and clean.
- [ ] Only after the above is true does the orchestrator dispatch Wave 2 — its worktrees fork off the updated `<aggregation_branch>` HEAD.

### Wave 2 — `<name>`

(same shape, including a Wave 2 → Wave 3 barrier section)

### Wave N — `<name>`

(same shape)

## E. Sequential Gates (after all waves)

Run only after every wave has finished. Each gate is a single delegated agent.

### E.1 — Test-Suite Gate

- [ ] Autodetected test runners: `<pytest|mix test|npm test|cargo test|...>`.
- [ ] Skip categories with **no** matching tests (note the skip in the gate's report).
- [ ] Dispatch: `Agent(subagent_type="python-test-specialist", ...)` (fallback: `bug-hunter` → `general-purpose`).
- [ ] Agent inputs:
  - **Working directory: `<integrator_worktree_path>`** (already on `<aggregation_branch>` with every per-finding merge applied).
  - Commands to run, in this order (skip missing ones):
    - `<unit>`: e.g. `uv run pytest tests/unit -q`
    - `<integration>`: e.g. `uv run pytest tests/integration -q`
    - `<smoke>`: project-specific smoke command if present
    - `<property>`: e.g. `uv run pytest -k hypothesis -q`
    - `<e2e>`: e.g. `uv run pytest tests/e2e -q`
  - On failure: the same agent must fix the failing test(s) **with the minimum change required** and commit **directly on `<aggregation_branch>` from `<integrator_worktree_path>`** (`fix(test): <name> [<finding-id>?]`). No per-fix worktree. Maximum 3 fix iterations, then stop and record `gate: tests failed`.
- [ ] Output contract: write `<workspace_dir>/gate_tests.yaml` with `{status, categories_run, categories_skipped, failures, fix_commits[]}`.

### E.2 — Pre-Commit / Quality Gate

- [ ] Autodetection order:
  1. If `make pre-commit` exists, use it.
  2. Else if `make lint` exists, use it (plus `make typecheck`, `make format-check` if present).
  3. Else run each detected tool separately: `ruff check`, `ruff format --check`, `mypy`, `pyright`, `eslint`, `prettier --check`, `cargo clippy`, etc.
- [ ] Dispatch: `Agent(subagent_type="commit-coordinator", ...)` (fallback: `devops-engineer` → `bug-hunter`).
- [ ] Agent inputs: detected command(s), **working directory `<integrator_worktree_path>`**, max-3-iteration fix-and-commit loop. Each fix commit message: `chore(lint): fix <tool> findings`. Fix commits land directly on `<aggregation_branch>` from `<integrator_worktree_path>`.
- [ ] **Never** `--no-verify`. Never disable rules to make checks pass.
- [ ] Output contract: write `<workspace_dir>/gate_precommit.yaml` with `{tool, status, iterations, fix_commits[]}`.

## F. Retry-Once Policy (failed plans)

- [ ] After E.1 + E.2, scan `<workspace_dir>/status.yaml` for `failed` findings.
- [ ] For each failed finding, dispatch the **next** agent from its fallback chain with the original plan.
- [ ] If retry succeeds: append a record to `<finding_reports_dir>/<finding-id>.md` and append the commit SHA to `status.yaml`.
- [ ] If retry fails: leave `status: failed`. Do not retry again.
- [ ] After retries, re-run E.1 + E.2 **only if** at least one retry produced new commits.

## G. Final Report Step

- [ ] Dispatch: `Agent(subagent_type="technical-research-analyst", ...)` (fallback: `general-purpose`).
- [ ] Agent inputs: `<findings_path>`, `<waves_path>`, `<timings_path>`, `<finding_reports_dir>`, `<workspace_dir>/status.yaml`, `<workspace_dir>/gate_tests.yaml`, `<workspace_dir>/gate_precommit.yaml`, `<manifest_path>`, template `<templates_root>/final_report.md`, output `<final_report_path>`.
- [ ] Validation gate after return: file ≥ 2 KB, ≥ 8 `^## ` sections; otherwise retry once.

## H. Hand-Off to User

The skill **never merges** into `<target_branch>`. The final report contains the merge command. The orchestrator's last action is to print:

> `<succeeded>/<total> findings fixed on <aggregation_branch>; report: <final_report_path>`

## Hard Rules (applied to every step above)

- [ ] **Orchestrator runs zero source-code edits, zero test invocations, zero linter invocations, zero `git commit` calls, zero `git worktree add`/`remove` calls.** All such actions are inside delegated `task` calls.
- [ ] **No commit-message trailers.** Every delegated agent that creates a commit (per-finding fix, per-finding merge commit, test-fix commit, lint-fix commit) is forbidden from adding `Co-Authored-By`, `Signed-off-by` (unless the repo already requires DCO), or any other authorship/attribution trailer.
- [ ] Every parallel dispatch is a single message with ≤ 4 `task` calls.
- [ ] Every delegation appends one JSONL record to `<timings_path>`.
- [ ] Every gate's outputs are written to its `<workspace_dir>/gate_*.yaml` file before moving on.
- [ ] Per-plan worktrees are created and torn down by their owning agent — never by the orchestrator, never by another finding's agent.
- [ ] `<integrator_worktree_path>` is owned by Phase 1 (creation) and Phase 7 cleanup (teardown). Implementation agents read from it for merge-back only; gate agents check out, commit, and `cd` inside it but never `git worktree remove` it.
- [ ] Never `git push`, never modify `<target_branch>`, never merge `<aggregation_branch>` into anything.

## Validation Gate (synthesis agent self-check before saving)

- [ ] Section B's roster includes every agent referenced in D + E + G.
- [ ] Section D's waves use disjoint file sets within each wave (cross-checked against `<file_ownership_path>`).
- [ ] Section D's tables include the `finding_worktree_path` and `child_branch` columns and a wave-barrier subsection between every consecutive pair of waves.
- [ ] Every finding in `<findings_path>` (above `<min_severity>`) appears in exactly one wave.
- [ ] Section E gates name `<integrator_worktree_path>` as their working directory.
- [ ] Section E has both gates with autodetected commands or an explicit "skip — not detected" note.
- [ ] Plan length: 180–460 lines.
