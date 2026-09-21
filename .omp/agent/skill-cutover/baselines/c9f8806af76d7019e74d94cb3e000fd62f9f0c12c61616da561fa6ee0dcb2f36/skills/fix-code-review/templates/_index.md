# Templates — fix-code-review

Authoritative catalogue of every template used by the `fix-code-review` skill. The orchestrator and every delegated agent **must** pass the absolute path to the relevant template; agents must not improvise structure.

All paths below are relative to this `templates/` directory and to the repo root: `skill://fix-code-review/templates/`.

## Catalogue

| Template | Path | Used by | Purpose |
|---|---|---|---|
| Per-finding plan | [`per_finding_plan.md`](./per_finding_plan.md) | Phase 3 planning agents | TDD-shaped implementation plan for one finding; checklist-driven; self-contained for an agent with no prior context. |
| Main orchestration plan | [`main_plan.md`](./main_plan.md) | Phase 4 synthesis agent | Roster + waves + gates + retry policy; the orchestrator reads it verbatim in Phase 5. |
| Per-finding completion report | [`per_finding_report.md`](./per_finding_report.md) | Implementing agents during Phase 5 | Standard structure recording outcome, files touched, tests, commit SHA, deviations, timing. |
| Final aggregated report | [`final_report.md`](./final_report.md) | Phase 6 synthesis agent | Aggregates all per-finding reports + gate results + timings + merge instructions. |

## How agents consume these templates

1. The orchestrator passes the **absolute path** of the relevant template to each delegated agent.
2. The agent opens the template once with `read`, then produces an artefact that follows the section order **exactly**.
3. Every template ends with a **Validation Gate** the agent must self-check before saving.
4. If validation fails, the orchestrator retries once with the next-priority agent from the agent map in `SKILL.md`.

## Strict rules

- **No new top-level sections** may be added by an agent. New material goes in the existing sections.
- **Section order is significant** — downstream parsers (the Phase 6 synthesiser, in particular) read by section header.
- Placeholders use `<angle-brackets>`; every placeholder must be filled before the artefact is saved.
- Checkboxes (`- [ ]`) are scratchpads for the agent during work and proof of completion at validation; all relevant boxes must be ticked.

## Cross-references

- Skill orchestrator: [`../SKILL.md`](../SKILL.md)
- Code-review template catalogue (upstream): [`../../code-review/templates/_index.md`](../../code-review/templates/_index.md)
- Project-wide development guidelines: [`/workspace/CLAUDE.md`](/workspace/CLAUDE.md) and [`/workspace/.claude/CLAUDE.md`](/workspace/.claude/CLAUDE.md)
