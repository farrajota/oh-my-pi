# Per-Finding Implementation Plan

> **Two kinds of content live in this plan, and the planning agent MUST keep them separate:**
>
> 1. **Plan-author fields** — definition lists and bullet items. These are *filled in* by the planning agent while writing the plan. They are descriptions, not tasks. Never render them as checkboxes.
> 2. **Implementer action items** — checkboxes (`- [ ]`). These are *ticked by the implementing agent during execution*. They MUST be emitted unchecked. The implementing agent is the only entity that ever turns `[ ]` into `[x]`.
>
> A pre-checked `[x]` anywhere in the body (outside the planning-agent self-check gate at the bottom) is a defect. Phase 3's validation gate will reject the plan.

## Role & Context (for the implementing agent)

You are the **implementing agent** for **one** code-review finding. You have **no prior conversation context** — this plan plus the linked `source_report` are your only inputs. Adopt this posture for the entire execution:

- **Surgical, not creative.** Do exactly what sections C–F prescribe. No refactors, no abstractions, no "while I'm here" cleanups, no opportunistic renames.
- **Scope-respecting.** Touch only the files in `target_files` / `target_tests`. If the fix demands more, **stop**, record the divergence in the completion report's *Deviations* section, and exit without committing.
- **TDD when applicable.** If section D selects D.1, write the failing test first; only then change production code. If D.2 is selected, follow the verification command literally.
- **One commit, one revert.** Your work lands as a single commit per section F so a reviewer can revert this finding independently.
- **Read the source report.** Before editing, open `source_report` at the cited lines so the fix matches the reviewer's intent, not just the plan's paraphrase.

## Purpose

A self-contained, TDD-shaped plan for fixing **one** code-review finding. Any implementing agent must be able to execute it with **no prior conversation context**.

## What this template MUST produce

- Header block referencing the originating report (so the implementing agent can re-read it).
- Concrete file/function/test scope — no vague "refactor module X".
- Explicit test strategy (failing test first, or "No test required" with justification).
- Step-by-step checklist the implementing agent ticks during execution — emitted unchecked.
- Commit instruction (one commit per plan).
- A completion-report stub the implementing agent fills in.

## What this template MUST NOT produce

- Pre-checked `[x]` boxes anywhere in the body.
- New abstractions, refactors, or features beyond the finding's scope.
- Multiple commits per plan (split into separate findings instead).
- Hidden assumptions about tools, environments, or prior steps.

---

## A. Header (plan-author fields — definition list, no checkboxes)

- **finding_id:** `<e.g. SEC-001>`
- **severity:** `critical | high | medium | low`
- **domain:** `<e.g. security/secret_management>`
- **source_report:** `<path to the originating code-review report, relative to repo root>`
- **title:** `<one-sentence summary>`
- **assigned_agent:** `<primary agent name from the agent map>`
- **fallback_agents:** `<comma-separated fallbacks in priority order>`
- **target_files:** (relative to repo root)
  - `<src/.../file.py>`
- **target_tests:** (relative to repo root)
  - `<tests/.../test_file.py>`
- **estimated_loc:** `<rough net lines changed; for ownership sizing only>`

*Provenance notes (optional, ≤ 3 lines)*: if `findings.yaml` and the source report disagree on file paths, or if the plan deliberately narrows scope, record the reconciliation here as plain prose. Not a checkbox.

## B. Context (≤ 200 words, plan-author prose)

Quote two verbatim blocks from the source report and add ≤ 3 lines of additional context the planning agent learned by opening the cited files. No code dumps, no checkboxes.

**Verbatim — "What needs to be improved" (cite file:line):**
> `<paste verbatim, with file:line attribution>`

**Verbatim — "How to fix it":**
> `<paste verbatim>`

**Additional context (≤ 3 lines):**
- `<e.g. "function lives inside a @dataclass; tests use pytest.mark.asyncio">`

## C. Scope Inventory (plan-author table)

Concrete list of code locations the implementing agent will touch. Each row must point to a real line range. No checkboxes — this is a descriptor, not a task list.

| Kind | Path | Symbol | Action |
|---|---|---|---|
| source | `<src/.../file.py>` | `<ClassName.method>` | add / modify / delete |
| test | `<tests/.../test_file.py>` | `<test_name>` | add / modify / delete |
| config/docs | `<path>` | n/a | add / modify / delete |

## D. Test Strategy (plan-author prose — choose ONE branch, fill it in, leave the other blank)

The planning agent describes the strategy below as plain prose. **The implementing agent does not tick anything in this section** — execution happens in section E.

### D.1 — Test-driven (preferred)

- **Red — tests to add first:**
  - test file path: `<tests/.../test_file.py>`
  - test function name(s): `<test_a>, <test_b>`
  - assertion(s) each test will make: `<one line each>`
  - exact command to run only these tests: `<e.g. uv run pytest tests/.../test_file.py::test_a -q>`
- **Green — minimal production change to pass the Red tests:** `<one or two sentences, no speculative code>`
- **Refactor — clean-up that keeps the tests green (optional):** `<one sentence, or "none">`
- **Coverage rationale (one sentence):** `<why these tests exercise the fix and nothing else>`

### D.2 — Non-testable (docs, comments, configuration, dependency pin, etc.)

- **Reason for skipping tests (one sentence):** `<e.g. "README copy change; verified by markdown lint and manual read">`
- **Verification alternative:** `<command(s) or visual check that prove the change works, e.g. markdownlint README.md>`

> The implementing agent MUST follow D.1 unless this plan explicitly selects D.2.
> If D.1 is selected, leave D.2 blank (do not delete the heading — downstream parsers expect both). If D.2 is selected, leave D.1 blank.

## D.5 Worktree Lifecycle (plan-author fields — definition list, no checkboxes)

This finding runs inside its own short-lived worktree. The planning agent fills in the values; the implementing agent runs the literal commands in sections E and F using these values.

- **finding_worktree_path:** `<worktrees_root>/<finding-id>/` (absolute path; resolved from the run manifest)
- **child_branch:** `fix-code-review/<UTC-timestamp>/<finding-id>`
- **aggregation_branch:** `fix-code-review/<UTC-timestamp>` (from `<vcs_ref>` in the run manifest)
- **integrator_worktree_path:** `<worktrees_root>/_integrator/` (long-lived; created by Phase 1; **never** removed by a per-finding agent)
- **fork_point:** the HEAD of `<aggregation_branch>` at dispatch time (= the union of every preceding wave's merges)

The implementing agent owns the entire lifecycle: create the worktree, do the fix, commit, merge back into `<aggregation_branch>` from `<integrator_worktree_path>`, remove the worktree, delete the child branch. Failure modes are described in section G.

## E. Implementation Steps (implementer checklist — emitted unchecked)

Numbered checklist the implementing agent ticks **as it works**. The planning agent MUST emit every box as `- [ ]`. Each step must be either a `bash`, `edit`/`write`, or `read` action — nothing else. **All `cwd`-sensitive commands run inside `<finding_worktree_path>` unless explicitly noted; merge-back in section F runs inside `<integrator_worktree_path>`.**

1. [ ] **Worktree setup**: from `<repo_root>`, run `git worktree add -b <child_branch> <finding_worktree_path> <aggregation_branch>`. Record the resulting HEAD SHA (= fork_point) in the completion report.
2. [ ] **Red phase** (skip if D.2): inside `<finding_worktree_path>`, create or edit the test file(s) from D.1. Run the test and confirm it fails for the expected reason.
3. [ ] **Green phase**: apply the minimal production change to the files in C (inside `<finding_worktree_path>`).
4. [ ] **Re-run targeted test** (skip if D.2): confirm it now passes.
5. [ ] **Wider check** (lightweight): run the directory-scoped test (e.g. `uv run pytest tests/unit/<area> -q`) to catch local regressions. **Do not** run the full suite here — the main plan owns that.
6. [ ] **Refactor pass** (optional): only if it keeps every targeted test green.
7. [ ] **Self-review**: `git -C <finding_worktree_path> diff <aggregation_branch>..HEAD` and confirm every change traces back to section C.

## F. Commit, Merge-Back, and Teardown (implementer checklist — emitted unchecked)

All commands below run from `<finding_worktree_path>` unless explicitly prefixed with `git -C <integrator_worktree_path>` or `git -C <repo_root>`.

### F.1 Commit (inside `<finding_worktree_path>`)

- [ ] **Message** (exact format):
  ```
  fix(<domain>): <title> [<finding-id>] (refs <source_report>)
  ```
- [ ] **Body** (≤ 5 lines): bullet of the fix, link to source report path, list of touched files.
- [ ] **No trailer**. NEVER add `Co-Authored-By`, `Signed-off-by` (unless the repo already requires DCO), or any other authorship/attribution trailer. The commit message ends after the body.
- [ ] Run `git add` on **only** the files in section C. Never use `git add -A`.
- [ ] `git commit` (NOT `--amend`, never `--no-verify`).
- [ ] Record the commit SHA in the completion report.

### F.2 Merge-back into `<aggregation_branch>` (from `<integrator_worktree_path>`)

- [ ] Confirm `<integrator_worktree_path>` is on `<aggregation_branch>`: `git -C <integrator_worktree_path> symbolic-ref --short HEAD` returns `<aggregation_branch>`.
- [ ] Pull the child branch into the aggregation branch:
  ```
  git -C <integrator_worktree_path> merge --no-ff <child_branch> -m "merge(<domain>): <title> [<finding-id>]"
  ```
  Wave packing guarantees no file conflicts; if `merge` reports conflicts, set `outcome: failed_merge` in the completion report, leave the child branch and worktree intact, and stop here. Do **not** force the merge.
- [ ] Record the merge commit SHA (or the fast-forward SHA, if applicable) in the completion report.

### F.3 Teardown (from `<repo_root>`)

- [ ] `git -C <repo_root> worktree remove <finding_worktree_path>`. If the worktree refuses to remove (uncommitted state would be unexpected here), abort and mark `failed_teardown` in the completion report.
- [ ] `git -C <repo_root> branch -d <child_branch>` (regular delete; the branch is now fully merged into `<aggregation_branch>`).
- [ ] Confirm `<finding_worktree_path>` no longer exists on disk.

## G. Pre-flight Constraints (rules — not tasks, never checkboxes)

The implementing agent MUST obey every constraint below. These are runtime rules, not work items.

- Operate inside `<finding_worktree_path>`. The aggregation branch `<vcs_ref>` is touched **only** by the merge-back step in F.2, and only from `<integrator_worktree_path>`.
- Never check out `<aggregation_branch>` in `<finding_worktree_path>`, never reset `<integrator_worktree_path>`, never remove `<integrator_worktree_path>` (it is owned by the orchestrator's Phase 7 cleanup).
- Do not run the full test suite, `make pre-commit`, or `git push` — the main plan runs the gates inside `<integrator_worktree_path>` after every wave completes.
- Do not edit files outside `target_files` / `target_tests`. If the fix demands more, **stop**, record the divergence in the completion report's *Deviations* section, and exit without committing (do not merge back; do `git worktree remove --force <finding_worktree_path>` and `git branch -D <child_branch>` to clean up).
- Time the work: capture `START=$(date -u +%s%3N)` before step E.1 and `END=$(date -u +%s%3N)` after section F.3; append a JSONL record to `<timings_path>` with `{finding_id, phase: "implement", agent, model, started_at, ended_at, duration_ms, status}`.

## H. Completion Report (required fields)

The implementing agent must produce `<finding_reports_dir>/<finding-id>.md` using `templates/per_finding_report.md`. The report MUST include:

- outcome (`succeeded` | `failed` | `partial`)
- commit SHA (or `none`)
- files actually touched
- tests added / modified
- verification commands run, with exit codes
- timing record (start, end, duration_ms, model)
- deviations from this plan, if any

## I. Rollback

Two cases, depending on how far the run progressed:

1. **Merge-back completed (F.2 done, F.3 done or partially done)**: a single revert of the merge commit on `<aggregation_branch>` undoes the finding cleanly:
   ```
   git -C <integrator_worktree_path> revert -m 1 <merge_commit_sha>
   ```
   The `-m 1` flag picks the first parent (the prior aggregation-branch HEAD).
2. **Commit created but merge-back failed (F.1 done, F.2 failed)**: nothing landed on `<aggregation_branch>`; just remove the leftover worktree and branch:
   ```
   git -C <repo_root> worktree remove --force <finding_worktree_path>
   git -C <repo_root> branch -D <child_branch>
   ```
3. **Failure before F.1**: nothing to roll back. Run the same cleanup commands from case 2.

---

## Strict Validation Gate (planning agent self-check before saving)

These are the **only** checkboxes the planning agent itself ticks, and only after the plan is otherwise complete. They live below the `---` so downstream parsers can ignore them.

- [ ] Section A is a definition list (no `- [ ]` / `- [x]` items).
- [ ] Section C's table is filled with concrete paths and symbols (no `<placeholder>` residue).
- [ ] Exactly **one** of D.1 / D.2 is filled; the other is left blank under its heading.
- [ ] Section D.5 is a definition list (no checkboxes) and names `finding_worktree_path`, `child_branch`, `aggregation_branch`, `integrator_worktree_path`, `fork_point`.
- [ ] Section E has ≥ 6 items, starts with the worktree-setup step, and **every** item is rendered `- [ ]` (none pre-checked).
- [ ] Section F is split into F.1 / F.2 / F.3, every checklist item is `- [ ]`, and F.2 contains the literal substring `git -C <integrator_worktree_path> merge --no-ff`.
- [ ] No `- [x]` appears anywhere above the `---` line.
- [ ] Section G is prose bullets (no checkboxes).
- [ ] No section refers to "the conversation", "the user", "earlier context", "the run's worktree", "the shared worktree", or "the worktree named in the run manifest" — the plan is self-contained and uses the per-plan worktree vocabulary.
- [ ] Total plan length: 90–290 lines. Beyond 290 lines means the finding should be split.
