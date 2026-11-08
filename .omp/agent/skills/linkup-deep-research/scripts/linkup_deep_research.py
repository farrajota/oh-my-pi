#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["linkup-sdk==0.18.3"]
# ///
"""Submit, recover, and persist deep Linkup research tasks.

The queue is deliberately local and append-safe: a research identifier is written to
it before any result is polled, so an interrupted invocation can resume later.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence, TextIO
from uuid import uuid4


QUEUE_RELATIVE_PATH = Path("ai_docs/research/linkup/query_ids.json")
ARTIFACT_RELATIVE_DIRECTORY = Path("ai_docs/research/linkup")
TERMINAL_STATUSES = frozenset({"completed", "failed"})


class ResearchClient(Protocol):
    """The subset of ``LinkupClient`` used by this command."""

    def research(
        self,
        query: str,
        *,
        output_type: str,
        reasoning_depth: str,
        mode: str,
    ) -> Any:
        """Create a research task."""

    def get_research(self, research_id: str) -> Any:
        """Retrieve a research task."""


@dataclass(slots=True)
class QueueEntry:
    """Durable information necessary to resume one Linkup task."""

    topic: str
    slug: str
    query: str
    research_id: str
    submitted_at: str
    output_timestamp: str
    polling_state: str = "submitted"
    last_error: str | None = None

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> "QueueEntry":
        """Validate and construct an entry read from the durable queue."""
        required = (
            "topic",
            "slug",
            "query",
            "research_id",
            "submitted_at",
            "output_timestamp",
            "polling_state",
        )
        missing = [name for name in required if name not in value]
        if missing:
            raise ValueError(f"Queue entry is missing fields: {', '.join(missing)}")
        return cls(
            topic=str(value["topic"]),
            slug=str(value["slug"]),
            query=str(value["query"]),
            research_id=str(value["research_id"]),
            submitted_at=str(value["submitted_at"]),
            output_timestamp=str(value["output_timestamp"]),
            polling_state=str(value["polling_state"]),
            last_error=(None if value.get("last_error") is None else str(value["last_error"])),
        )


def topic_slug(topic: str) -> str:
    """Return a lower-case, hyphenated filesystem-safe topic identifier."""
    normalized = topic.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    if not slug:
        raise ValueError("Topic must contain at least one ASCII letter or digit")
    return slug


def utc_now() -> datetime:
    """Return the current UTC time, factored for deterministic tests."""
    return datetime.now(timezone.utc)


def artifact_timestamp(when: datetime) -> str:
    """Return a collision-resistant, filesystem-safe UTC directory name."""
    return when.strftime("%Y%m%dT%H%M%S%fZ")


def atomic_write_json(path: Path, value: Any) -> None:
    """Atomically replace ``path`` with JSON encoded as UTF-8."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def load_queue(path: Path) -> list[QueueEntry]:
    """Load the queue, accepting the current envelope and legacy bare lists."""
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        decoded = json.load(handle)
    raw_entries: Any
    if isinstance(decoded, list):
        raw_entries = decoded
    elif isinstance(decoded, Mapping) and isinstance(decoded.get("entries"), list):
        raw_entries = decoded["entries"]
    else:
        raise ValueError(f"Queue file {path} must contain an entries list")
    if not all(isinstance(entry, Mapping) for entry in raw_entries):
        raise ValueError(f"Queue file {path} contains a non-object entry")
    return [QueueEntry.from_json(entry) for entry in raw_entries]


def save_queue(path: Path, entries: Iterable[QueueEntry]) -> None:
    """Persist all outstanding entries in one atomically replaced envelope."""
    atomic_write_json(path, {"entries": [asdict(entry) for entry in entries]})


def object_field(value: Any, name: str, default: Any = None) -> Any:
    """Read a field from either an SDK model or a mapping."""
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def research_id_from(value: Any) -> str:
    """Extract the research identifier returned by the Linkup SDK."""
    for name in ("id", "research_id"):
        identifier = object_field(value, name)
        if identifier is not None:
            return str(identifier)
    raise ValueError("Linkup research response did not include an id")


def status_from(task: Any) -> str:
    """Extract and normalize a task status without assuming one SDK model version."""
    status = object_field(task, "status")
    if status is None:
        return "unknown"
    value = object_field(status, "value", status)
    return str(value).lower()


def json_safe(value: Any) -> Any:
    """Convert SDK objects to JSON-compatible data when ``model_dump`` is absent."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_safe(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "__dict__"):
        return {
            str(key): json_safe(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    return str(value)


def task_envelope(task: Any) -> Any:
    """Serialize a full Linkup task envelope using Pydantic when it is available."""
    model_dump = getattr(task, "model_dump", None)
    if callable(model_dump):
        try:
            return model_dump(mode="json", by_alias=True)
        except (TypeError, ValueError):
            # Some compatible SDK models expose a narrower model_dump signature.
            return json_safe(task)
    return json_safe(task)


def artifact_path(workspace_root: Path, entry: QueueEntry) -> Path:
    """Return the stable terminal artifact path for an entry."""
    return (
        workspace_root
        / ARTIFACT_RELATIVE_DIRECTORY
        / entry.slug
        / entry.output_timestamp
        / "research.json"
    )


def is_not_found(error: BaseException) -> bool:
    """Identify common SDK/HTTP forms of a missing research task."""
    status_code = getattr(error, "status_code", None)
    if status_code == 404:
        return True
    response = getattr(error, "response", None)
    if getattr(response, "status_code", None) == 404:
        return True
    name = type(error).__name__.lower()
    return "notfound" in name or "not_found" in name


def describe_error(error: BaseException) -> str:
    """Produce a compact, durable retrieval error description."""
    message = str(error).strip()
    return f"{type(error).__name__}: {message}" if message else type(error).__name__


def poll_once(
    client: ResearchClient,
    workspace_root: Path,
    queue_path: Path,
    entries: list[QueueEntry],
    *,
    stderr: TextIO,
    stdout: TextIO,
) -> bool:
    """Poll every tracked entry once and return whether anything remains pending.

    Queue mutations are written immediately. A terminal entry is removed only after
    its task envelope has been atomically persisted.
    """
    remaining = False
    for entry in tuple(entries):
        try:
            task = client.get_research(entry.research_id)
        except Exception as error:  # SDK and transport errors are recoverable.
            entry.last_error = describe_error(error)
            if is_not_found(error):
                entry.polling_state = "unreachable"
            save_queue(queue_path, entries)
            print(
                f"research {entry.research_id}: {entry.polling_state} ({entry.last_error})",
                file=stderr,
            )
            remaining = True
            continue

        status = status_from(task)
        entry.polling_state = status
        entry.last_error = None
        if status in TERMINAL_STATUSES:
            destination = artifact_path(workspace_root, entry)
            atomic_write_json(destination, task_envelope(task))
            entries.remove(entry)
            save_queue(queue_path, entries)
            print(f"research {entry.research_id}: {status}", file=stderr)
            print(destination, file=stdout)
        else:
            save_queue(queue_path, entries)
            print(f"research {entry.research_id}: {status}", file=stderr)
            remaining = True
    return remaining


def poll_until_terminal(
    client: ResearchClient,
    workspace_root: Path,
    queue_path: Path,
    entries: list[QueueEntry],
    *,
    sleep: Callable[[float], None] = time.sleep,
    stderr: TextIO = sys.stderr,
    stdout: TextIO = sys.stdout,
) -> None:
    """Poll all outstanding entries with the required 2/4/8/10-second backoff."""
    delay = 2.0
    while entries:
        if not poll_once(client, workspace_root, queue_path, entries, stderr=stderr, stdout=stdout):
            return
        sleep(delay)
        delay = min(delay * 2, 10.0)


def create_client() -> ResearchClient:
    """Import and instantiate Linkup only for commands that actually contact it."""
    try:
        from linkup import LinkupClient
    except ImportError as error:
        raise RuntimeError(
            "linkup-sdk is required to submit or recover research; install it first"
        ) from error
    return LinkupClient()


def submit_entry(
    client: ResearchClient,
    topic: str,
    query: str,
    *,
    now: Callable[[], datetime] = utc_now,
) -> QueueEntry:
    """Submit a maximum-depth task and return its durable queue representation."""
    slug = topic_slug(topic)
    response = client.research(
        query,
        output_type="sourcedAnswer",
        reasoning_depth="XL",
        mode="research",
    )
    submitted = now()
    return QueueEntry(
        topic=topic,
        slug=slug,
        query=query,
        research_id=research_id_from(response),
        submitted_at=submitted.isoformat(),
        output_timestamp=artifact_timestamp(submitted),
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--topic", help="Human-readable topic name")
    parser.add_argument(
        "--recover-only",
        action="store_true",
        help="Resume persisted jobs without submitting a new query",
    )
    parser.add_argument(
        "--workspace-root",
        type=Path,
        default=Path.cwd(),
        help="Workspace root (default: current directory)",
    )
    parser.add_argument("query", nargs="?", help="Detailed research query")
    return parser


def run(
    arguments: Sequence[str] | None = None,
    *,
    client_factory: Callable[[], ResearchClient] = create_client,
    environ: Mapping[str, str] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    stderr: TextIO = sys.stderr,
    stdout: TextIO = sys.stdout,
) -> int:
    """Execute the CLI and return a process status, with injectable dependencies."""
    parser = build_parser()
    namespace = parser.parse_args(arguments)
    if namespace.recover_only:
        if namespace.query is not None or namespace.topic is not None:
            parser.error("--recover-only does not accept --topic or a query")
    elif not namespace.topic or not namespace.query:
        parser.error("--topic and a detailed research query are required")
    environment = os.environ if environ is None else environ
    if not namespace.recover_only:
        try:
            topic_slug(namespace.topic)
        except ValueError as error:
            parser.error(str(error))
        if not environment.get("LINKUP_API_KEY"):
            print("LINKUP_API_KEY is required to submit research", file=stderr)
            return 2

    workspace_root = namespace.workspace_root.resolve()
    queue_path = workspace_root / QUEUE_RELATIVE_PATH
    entries = load_queue(queue_path)

    try:
        client: ResearchClient | None = None
        if entries:
            client = client_factory()
            print(f"recovering {len(entries)} persisted research job(s)", file=stderr)
            poll_until_terminal(
                client,
                workspace_root,
                queue_path,
                entries,
                sleep=sleep,
                stderr=stderr,
                stdout=stdout,
            )

        if namespace.recover_only:
            return 0

        if client is None:
            client = client_factory()
        new_entry = submit_entry(client, namespace.topic, namespace.query)
        entries.append(new_entry)
        # This durable write is intentionally before the first poll.
        save_queue(queue_path, entries)
        print(f"submitted research {new_entry.research_id}", file=stderr)
        poll_until_terminal(
            client,
            workspace_root,
            queue_path,
            entries,
            sleep=sleep,
            stderr=stderr,
            stdout=stdout,
        )
        return 0
    except KeyboardInterrupt:
        print("interrupted; outstanding research remains in the queue", file=stderr)
        return 130
    except RuntimeError as error:
        print(str(error), file=stderr)
        return 2


def main() -> None:
    """Run the command-line entry point."""
    raise SystemExit(run())


if __name__ == "__main__":
    main()
