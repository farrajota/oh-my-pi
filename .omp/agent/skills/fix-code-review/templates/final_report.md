# Final Aggregated Report — fix-code-review

> Filled by the Phase 6 synthesis agent. Aggregates every per-finding report, gate result, and timing record into a single authoritative summary. Keep section order — downstream tools (and humans) read this top-to-bottom.

## What this report MUST include

- Run header with all inputs and the resulting VCS ref.
- Outcome roll-up by severity and by domain.
- Agent roster with task counts and aggregate timing.
- Cross-cutting themes (similar fixes deduplicated).
- Pre-existing failures separated from this-run failures.
- Merge instructions — verbatim commands the user runs themselves.
- A complete link index to every plan and per-finding report.

## What this report MUST NOT include

- Recommendations to merge automatically.
- Source-code dumps. Reference paths only.
- Verbose logs — link to `<workspace_dir>/logs/` instead.

---

## A. Run Header

- `run_id`: `<UTC-timestamp>`
- `input_dir`: `<code-review output dir>`
- `out_dir`: `<artefact root>`
- `vcs_ref`: `<aggregation_branch>` (the branch the user will merge into `<target_branch>`)
- `aggregation_branch`: `fix-code-review/<UTC-timestamp>`
- `base_sha`: `<sha at run start>` (= `<target_branch>` HEAD when Phase 1 ran)
- `head_sha`: `<sha at run end>` (= `<aggregation_branch>` HEAD after the last gate commit)
- `target_branch`: `<target_branch>` (never modified by this skill)
- `worktrees_root`: `<absolute path>`
- `integrator_worktree_path`: `<absolute path>` (removed at the end of Phase 7 on success)
- `min_severity`: `<critical|high|medium|low>`
- `total_findings_enumerated`: `<N>`
- `total_findings_included`: `<M>` (after `--min-severity` filter)
- `started_at`: `<ISO-8601 UTC>`
- `ended_at`: `<ISO-8601 UTC>`
- `wall_clock_duration_ms`: `<integer>`

## B. Outcome Roll-Up

### B.1 By severity

| Severity | Included | Succeeded | Failed | Partial | Skipped |
|---|---:|---:|---:|---:|---:|
| critical | | | | | |
| high | | | | | |
| medium | | | | | |
| low | | | | | |
| **total** | | | | | |

### B.2 By domain

| Domain | Included | Succeeded | Failed |
|---|---:|---:|---:|
| security/* | | | |
| performance/* | | | |
| concurrency/* | | | |
| architecture/* | | | |
| observability/* | | | |
| configuration/* | | | |
| dependency/* | | | |
| ci-devops/* | | | |
| code-quality/* | | | |
| test-quality/* | | | |
| data-privacy/* | | | |
| documentation/* | | | |

## C. Findings — Detailed Index

| finding_id | severity | domain | outcome | fix commit | merge commit | plan | report | source |
|---|---|---|---|---|---|---|---|---|
| `<id>` | `<sev>` | `<domain>` | `<succeeded\|failed\|partial>` | `<sha or none>` | `<merge_sha or ff>` | [plan](`<plans/<id>.md>`) | [report](`<reports/<id>.md>`) | [source](`<input_dir>/<source_report>`) |

- The `merge commit` column distinguishes per-finding merges (`--no-ff` merge SHA) from fast-forwards (`ff`) and from failed merge-backs (`none`).

- One row per included finding.
- Sort by severity (critical → low), then by domain.

## D. Cross-Cutting Themes

Group fixes that share root causes or touched the same architectural seam. Each theme:

- `theme`: `<short title>`
- `findings`: `[<ids>]`
- `pattern`: one-sentence description of the shared problem.
- `recommendation`: optional follow-up if the theme suggests systemic work (out of scope for this run).

## E. Agent Roster — Usage

| task | Role | Tasks dispatched | Successes | Failures | Aggregate duration | p50 ms | p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| `<agent-name>` | implementation/`<domain>` or gate | | | | | | |

- Derived from `<timings_path>`.

## F. Gates

### F.1 Test-Suite Gate

- `status`: `passed | failed | skipped`
- `runner(s)`: `<pytest|mix test|...>`
- `categories_run`: `<unit, integration, smoke, property, e2e>`
- `categories_skipped`: `<which and why>`
- `fix_iterations`: `<integer 0–3>`
- `fix_commits`: `[<sha>, ...]`
- `notes`: any flaky tests, env issues, etc.

### F.2 Pre-Commit / Quality Gate

- `status`: `passed | failed`
- `tool(s)`: `<make pre-commit | ruff | mypy | eslint | ...>`
- `fix_iterations`: `<integer 0–3>`
- `fix_commits`: `[<sha>, ...]`
- `notes`: any rules disabled (should be `none`), any warnings ignored, etc.

## G. Pre-Existing Failures (not introduced by this run)

Tests, lints, or type errors that were broken **before** this run started and were not fixed because they are out of scope. Listed so reviewers do not blame this run.

| Category | Item | First seen on | Notes |
|---|---|---|---|
| test | `<test path::name>` | `<base_sha>` | unrelated to any included finding |
| lint | `<file:line: rule>` | `<base_sha>` | unrelated to any included finding |

## H. Timing Summary

- `wall_clock_duration_ms`: from header
- `parallelism_factor`: `total_agent_duration_ms / wall_clock_duration_ms`
- `longest_plan`: `<finding-id>` — `<duration_ms>`
- `fastest_plan`: `<finding-id>` — `<duration_ms>`
- `median_plan_duration_ms`: `<value>`
- `p95_plan_duration_ms`: `<value>`
- Gate timings: tests `<ms>`, pre-commit `<ms>`
- Final report duration: `<ms>`

## I. Merge Instructions

The skill **never merges into `<target_branch>`**. Run the commands below from your main checkout when you are ready.

```sh
cd <repo_root>
git fetch
git checkout <target_branch>
git merge --no-ff <aggregation_branch>

# After you are satisfied (CI green, code review approved), clean up:
git branch -d <aggregation_branch>

# If Phase 7 left <worktrees_root> behind (a failed finding kept a worktree for inspection),
# remove it manually after reviewing:
#   git worktree list                 # confirm nothing important is under <worktrees_root>
#   git worktree remove <path>        # for each leftover
#   rmdir <worktrees_root>            # once empty
```

- Recommend `--no-ff` so the merge commit groups every per-finding commit on `<target_branch>`'s history.
- Per-finding merges into `<aggregation_branch>` are already `--no-ff` (or fast-forward when no prior wave touched the same files), so `git log --first-parent <aggregation_branch>` reads as one entry per finding.
- The user MUST run their own pre-merge checks (CI, code review).
- **Do not** force-push.

## J. Artefact Index

- Manifest: `<manifest_path>`
- Findings YAML: `<findings_path>`
- File-ownership map: `<file_ownership_path>`
- Waves: `<waves_path>`
- Status: `<workspace_dir>/status.yaml`
- Gate outputs: `<workspace_dir>/gate_tests.yaml`, `<workspace_dir>/gate_precommit.yaml`
- Timings: `<timings_path>`
- Plans: `<plans_dir>/*.md`
- Per-finding reports: `<finding_reports_dir>/*.md`
- Main plan: `<main_plan_path>`

## K. Caveats & Limitations

- Severities lower than `<min_severity>` were not addressed (count: `<N>`).
- `<aggregation_branch>` is not pushed to a remote.
- Pre-existing failures (section G) remain — open follow-up issues if needed.
- Any finding marked `partial` or `failed_*` requires manual completion before merging `<aggregation_branch>`.
- Any leftover subdirectory inside `<worktrees_root>` corresponds to a finding that did not reach successful merge-back; inspect before removing.

## L. One-Line User Summary

> `<succeeded>/<total> findings fixed on <aggregation_branch>; merge with: git merge --no-ff <aggregation_branch>`

## Validation Gate (synthesis agent self-check before saving)

- [ ] Every included finding has a row in section C, including the `merge commit` column.
- [ ] Section B counts match section C row counts.
- [ ] Section E rows match the agents actually dispatched (per `<timings_path>`).
- [ ] Section F reflects the latest gate YAMLs.
- [ ] Section I is a single block (no `worktree` / `branch` split) targeting `<aggregation_branch>`.
- [ ] Section A's `worktrees_root` and `integrator_worktree_path` are absolute paths.
- [ ] Total length: 200–600 lines. Beyond 600 means too much narrative — trim.
