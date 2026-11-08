# Per-Finding Completion Report

> Filled by the implementing agent **after** executing a per-finding plan. One file per finding at `<finding_reports_dir>/<finding-id>.md`. Keep the section order exactly — the final-report agent parses it.

## A. Header

- `finding_id`: `<e.g. SEC-001>`
- `severity`: `<critical|high|medium|low>`
- `domain`: `<e.g. security/secret_management>`
- `plan_path`: `<plans/<finding-id>.md>`
- `source_report`: `<path to originating code-review report>`
- `assigned_agent`: `<the agent that produced this report>`
- `outcome`: `succeeded` | `failed` | `partial` | `failed_setup` | `failed_merge` | `failed_teardown`
- `finding_worktree_path`: `<worktrees_root>/<finding-id>/`
- `child_branch`: `fix-code-review/<UTC>/<finding-id>`
- `fork_point_sha`: `<sha of <aggregation_branch> when this worktree was created>`
- `worktree_teardown_ok`: `yes | no`
- `started_at`: `<ISO-8601 UTC>`
- `ended_at`: `<ISO-8601 UTC>`
- `duration_ms`: `<integer>`

## B. Summary (≤ 60 words)

One short paragraph: what changed, why it satisfies the finding, what evidence proves it.

## C. Files Touched

| Path | Change | Lines added | Lines removed |
|---|---|---|---|
| `<src/.../file.py>` | modify | `<N>` | `<M>` |
| `<tests/.../test_file.py>` | add | `<N>` | `0` |

- All paths must match — or be a strict subset of — `target_files` + `target_tests` declared in the plan.

## D. Tests

| Test path | Test name | Added/Modified | Outcome before fix | Outcome after fix |
|---|---|---|---|---|
| `<tests/.../test_file.py>` | `<test_function>` | added | failed (red) | passed (green) |
| ... | ... | ... | ... | ... |

If the plan selected **D.2 (non-testable)**:

- `tests_status`: `n/a`
- `verification_command`: `<exact command run>`
- `verification_exit_code`: `<0>`

## E. Verification Evidence

Paste exit codes (not full output) for each command the implementing agent ran:

```
$ <pytest path/to/test::name -q>
exit=0 (1 passed)

$ <pytest tests/unit/<area> -q>
exit=0 (<N> passed)
```

- Do **not** paste full stack traces or large logs. Reference `<workspace_dir>/logs/<finding-id>.log` if a log was saved.

## F. Commit and Merge-Back

- `commit_sha`: `<full SHA on <child_branch>>` (or `none` if outcome is `failed` before commit)
- `commit_message`:
  ```
  fix(<domain>): <title> [<finding-id>] (refs <source_report>)
  ```
- `merge_commit_sha`: `<full SHA on <aggregation_branch>>` or `ff` (fast-forward) or `none` (merge failed / not reached)
- `merge_kind`: `--no-ff merge` | `fast-forward` | `not-attempted`
- `aggregation_branch`: `<vcs_ref>` (= `fix-code-review/<UTC>`)
- `child_branch_deleted`: `yes | no` (must be `yes` for `outcome: succeeded`)

## G. Deviations from Plan

Required when the plan was not executed exactly as written.

- [ ] **None** — strike out section if not applicable.
- [ ] **Scope expansion**: list any files touched that were not in the plan, with one-sentence justification.
- [ ] **Test-strategy change**: e.g. plan said D.1 but the test turned out non-trivial → describe and explain.
- [ ] **Aborted steps**: list steps the agent could not complete and the reason.

If deviations exist, set `outcome: partial` (or `failed` if the finding is not actually fixed).

## H. Follow-ups (optional)

Issues discovered while implementing that are out of scope for this finding. Each entry should be implementable as its own future plan.

| Description | Suggested severity | Suggested domain | Files involved |
|---|---|---|---|
| ... | ... | ... | ... |

## I. Rollback

- `revert_command`:
  - If `merge_commit_sha` is a real SHA: `git -C <integrator_worktree_path> revert -m 1 <merge_commit_sha>` (reverts the merge of this finding from `<aggregation_branch>` cleanly).
  - If `merge_kind` is `fast-forward`: `git -C <integrator_worktree_path> revert <commit_sha>` reverts the single fix commit on `<aggregation_branch>`.
  - If no commit reached `<aggregation_branch>`: `n/a` (nothing landed).
- `rollback_safety_notes`: any caveats (e.g. "subsequent waves built on top of this commit — `git revert` will require manual conflict resolution").

## Validation Gate (implementing agent self-check before saving)

- [ ] Section A has every field filled, including `finding_worktree_path`, `child_branch`, `fork_point_sha`, and `worktree_teardown_ok`.
- [ ] Section C lists every file `git -C <repo_root> diff <fork_point_sha>..<commit_sha> --name-only` reports for this finding's commit (or `n/a` if no commit).
- [ ] Section D contains at least one row (or section D.2 fields if non-testable).
- [ ] Section E shows the exit codes of every command the agent ran.
- [ ] Section F has either a real `merge_commit_sha`/`ff` or a clear `outcome: failed_*` explanation.
- [ ] On `outcome: succeeded`, `worktree_teardown_ok: yes` and `child_branch_deleted: yes`.
- [ ] Report length: 40–160 lines.
