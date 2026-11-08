# Linkup Deep Research State Reference

Use this reference to interpret the persistent queue and terminal artifacts. Treat both formats as script-owned interfaces; NEVER edit them while the script is running.

## Paths

| Resource | Repository-relative path |
| --- | --- |
| Persistent queue | `ai_docs/research/linkup/query_ids.json` |
| Terminal artifact | `ai_docs/research/linkup/<topic-slug>/<timestamp>/research.json` |

`<topic-slug>` is lowercase, hyphen-separated, and filesystem-safe. `<timestamp>` is assigned to the output directory before polling and remains stable across recovery.

## Queue Schema

The queue contains one persisted entry per submitted, non-finalized job. Each entry records:

| Datum | Meaning |
| --- | --- |
| `topic` | Original human-readable topic name |
| `slug` | Normalized topic directory name |
| `query` | Full submitted research brief |
| `research_id` | Linkup research task identifier |
| `submitted_at` | Submission timestamp |
| `output_timestamp` | Stable output-directory timestamp |
| `polling_state` | Last observed polling state |
| `last_error` | Most recent transient or terminal error, otherwise null |

Queue updates use atomic replacement. Pending, processing, and temporarily unreachable entries remain recoverable. A terminal entry remains queued until its artifact write succeeds.

## Status Semantics

| Status | Terminal | Handling |
| --- | --- | --- |
| `pending` | No | Keep queued and poll again. |
| `processing` | No | Keep queued and poll again. |
| Temporarily unreachable | No | Record `last_error`; keep queued for recovery. |
| `completed` | Yes | Atomically write the returned task envelope, then remove the queue entry. |
| `failed` | Yes | Atomically write the failed task envelope, then remove the queue entry. |

Only `completed` and `failed` are terminal. NEVER infer success from queue removal alone; locate `research.json`.

## Artifact Semantics

- `research.json` stores the terminal Linkup task envelope, not a rewritten summary.
- Completed and failed envelopes use the same stable artifact path.
- Serialization uses Pydantic `model_dump(mode="json", by_alias=True)` when available.
- Serialization falls back to safe JSON conversion for other SDK response shapes.
- Artifact writes use atomic replacement.
- Queue removal occurs only after artifact writing succeeds.
- A failed artifact records execution outcome; it contains no validated report.

## Commands

The script uses PEP 723 inline metadata; `uv` MUST resolve its pinned `linkup-sdk==0.18.3` dependency directly. Agents MUST NOT invoke the script with bare `python`, install dependencies into the workspace with `pip`, or duplicate the dependency with `--with`.

Submit one detailed brief and begin polling:

```bash
uv run "/home/node/.omp/agent/skills/linkup-deep-research/scripts/linkup_deep_research.py" --topic "Topic Name" "Detailed research query"
```

Recover all persisted jobs without a new submission:

```bash
uv run "/home/node/.omp/agent/skills/linkup-deep-research/scripts/linkup_deep_research.py" --recover-only
```

Allow either command to poll for up to 30 minutes. NEVER kill healthy polling solely because no terminal result has appeared.
