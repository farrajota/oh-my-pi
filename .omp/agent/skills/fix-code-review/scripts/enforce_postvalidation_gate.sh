#!/usr/bin/env bash
# fix-code-review post-validation gate.
#
# Wired as PreToolUse(Agent|Bash|Write). Fires before every significant tool
# call. If a fix-code-review run is in progress (marker file present) the gate
# reads the run's recorded phase and asserts the deterministic file-presence
# checklist for that phase. Exits non-zero to block the next tool call when a
# required artefact is missing — this catches crashes and silent skips that
# the orchestrator's own checks would otherwise miss.
#
# Lifecycle:
#   - Phase 0 creates <out_dir>/.in_progress and writes <out_dir>/.workspace/phase.txt
#   - Every subsequent phase rewrites phase.txt at its boundary
#   - Phase 7 removes .in_progress on successful self-validation
#
# Orphan detection:
#   - If a marker is found but phase.txt says phase_7_complete, the marker is
#     stale (post-success cleanup didn't run) — the gate removes it.
#   - If a marker is found and phase.txt is missing or absent of recognised
#     content, the gate is silent (run is still bootstrapping).
#   - Otherwise, missing artefacts produce a clear non-zero exit and the
#     orchestrator (or user) must investigate.
#
# Exit codes:
#   0 — no in-progress run, or all expected artefacts present
#   2 — one or more required artefacts missing for the recorded phase

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${PWD}}"
REPORTS_ROOT="${PROJECT_DIR}/ai_docs/reports/fix-code-review"

if [[ ! -d "$REPORTS_ROOT" ]]; then
  exit 0
fi

shopt -s nullglob
markers=("$REPORTS_ROOT"/*/.in_progress)
if [[ ${#markers[@]} -eq 0 ]]; then
  exit 0
fi

file_size() {
  # Portable size-in-bytes; returns 0 if file missing.
  local f="$1"
  if [[ ! -f "$f" ]]; then
    echo 0
    return
  fi
  if stat -c%s "$f" >/dev/null 2>&1; then
    stat -c%s "$f"
  else
    stat -f%z "$f"
  fi
}

overall_status=0
declare -a problems=()

record() {
  problems+=("$1")
  overall_status=2
}

for marker in "${markers[@]}"; do
  out_dir="$(dirname "$marker")"
  phase_file="$out_dir/.workspace/phase.txt"

  if [[ ! -f "$phase_file" ]]; then
    # Marker created but phase tracker not yet written — Phase 0 in flight.
    continue
  fi

  phase="$(tr -d '[:space:]' < "$phase_file")"

  case "$phase" in
    phase_0_complete)
      [[ $(file_size "$out_dir/manifest.json") -gt 0 ]] || record "missing $out_dir/manifest.json (phase_0_complete)"
      ;;
    phase_1_complete)
      vcs_yaml="$out_dir/.workspace/vcs.yaml"
      if [[ $(file_size "$vcs_yaml") -le 0 ]]; then
        record "missing $vcs_yaml (phase_1_complete)"
      else
        # New schema (per-plan worktrees + integrator): require all four keys.
        for key in aggregation_branch base_sha worktrees_root integrator_worktree_path; do
          if ! grep -q "^${key}:" "$vcs_yaml" 2>/dev/null; then
            record "missing key '$key' in $vcs_yaml (phase_1_complete)"
          fi
        done
      fi
      ;;
    phase_2_complete)
      [[ $(file_size "$out_dir/.workspace/findings.yaml") -gt 0 ]] || record "missing $out_dir/.workspace/findings.yaml (phase_2_complete)"
      ;;
    phase_3_complete)
      if [[ ! -d "$out_dir/plans" ]]; then
        record "missing $out_dir/plans/ (phase_3_complete)"
      else
        plan_count=$(find "$out_dir/plans" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$plan_count" -eq 0 ]]; then
          record "no plan files in $out_dir/plans (phase_3_complete)"
        fi
        small=$(find "$out_dir/plans" -maxdepth 1 -type f -name '*.md' -size -1c 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$small" -gt 0 ]]; then
          record "$small empty plan file(s) under $out_dir/plans (phase_3_complete)"
        fi
      fi
      ;;
    phase_4_complete)
      for rel in main_plan.md .workspace/file_ownership.yaml .workspace/waves.yaml; do
        [[ $(file_size "$out_dir/$rel") -gt 0 ]] || record "missing $out_dir/$rel (phase_4_complete)"
      done
      ;;
    phase_5_complete)
      [[ $(file_size "$out_dir/.workspace/status.yaml") -gt 0 ]] || record "missing $out_dir/.workspace/status.yaml (phase_5_complete)"
      [[ $(file_size "$out_dir/timings.jsonl") -gt 0 ]] || record "missing $out_dir/timings.jsonl (phase_5_complete)"
      ;;
    phase_6_complete)
      report_path="$out_dir/final_report.md"
      size=$(file_size "$report_path")
      if [[ "$size" -lt 2048 ]]; then
        record "$report_path too small (${size} bytes, need >=2048) (phase_6_complete)"
      fi
      if [[ -f "$report_path" ]]; then
        sections=$(grep -c '^## ' "$report_path" 2>/dev/null || echo 0)
        if [[ "$sections" -lt 8 ]]; then
          record "$report_path has $sections '## ' sections, need >=8 (phase_6_complete)"
        fi
      fi
      ;;
    phase_7_complete)
      val_yaml="$out_dir/.workspace/validation.yaml"
      [[ $(file_size "$val_yaml") -gt 0 ]] || record "missing $val_yaml (phase_7_complete)"
      # Phase 7 success should have removed the marker. Clean it up so the
      # gate stops firing on subsequent unrelated tool calls.
      echo "[fix-code-review gate] removing stale marker after phase_7_complete: $marker" >&2
      rm -f "$marker"
      ;;
    *)
      # Unknown phase token — do not block; surface a one-line warning so
      # the orchestrator notices a malformed phase.txt early.
      echo "[fix-code-review gate] unrecognised phase token in $phase_file: '$phase'" >&2
      ;;
  esac
done

if [[ $overall_status -ne 0 ]]; then
  {
    echo "[fix-code-review gate] BLOCKING: required artefacts missing for an in-progress run."
    for p in "${problems[@]}"; do echo "  - $p"; done
    echo ""
    echo "Resolve by either:"
    echo "  1. Completing the missing phase outputs, or"
    echo "  2. Removing the marker file(s) below after manual inspection:"
    for marker in "${markers[@]}"; do echo "       $marker"; done
  } >&2
  exit 2
fi

exit 0
