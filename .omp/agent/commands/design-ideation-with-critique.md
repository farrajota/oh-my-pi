---
name: Ideation with critique
description: Run a terminal-first Socratic interview, optional immutable support views, and one mandatory protected approval dossier before receipt-bound Deep Scope handoff.
argument-hint: <idea-or-concept> [max_review_rounds=1|2|3|4|5]
---

# Ideation with Critique command

## Usage

```text
/design-ideation-with-critique <idea-or-concept> [max_review_rounds=1|2|3|4|5]
```

## Invocation boundary

1. Parse `<idea-or-concept>` only with `parseIdeationInvocation`. Omission defaults `max_review_rounds` to `3`; only an exact final `max_review_rounds=1` through `=5` overrides it. Reject malformed, duplicate, non-final, zero, six, fractional, and `NaN` forms before slug construction.
2. Delegate the complete workflow to `skill://ideation-with-critique`; the command does not duplicate persistence, support, review, approval, publication, or handoff mechanics.
3. Conduct the Socratic interview in the terminal, one focused question at a time. Persist each accepted answer or correction as the next immutable `Q#` exchange before relying on it. Terminal persistence creates no HTML.
4. Create read-only support HTML only for an eligible declared trigger: `explicit-request`, `commitment-review-boundary`, `final-review-boundary`, `returned-changes`, `material-commitment-change`, or `show-stopper-contradiction`. Support is immutable, cumulative, and non-authoritative; it cannot approve, publish, mutate state, authorize Deep Scope, or substitute for the mandatory final protected dossier.
5. Present exactly one mandatory protected final approval dossier after the closed state and current substantive `PASS` are ready. Ideation final items always carry exactly four complete canonical options and one bound recommendation; this requirement does not apply to generic shared-renderer callers using `context-only`.
6. Do not launch any model review after verifier-admitted human approval. On success, provide exactly this next workflow command, substituting the canonical slug and durable state cap integer:

```text
/design-deep-scope ai_docs/ideation/<slug>.md max_review_rounds=<state.max_review_rounds>
```
