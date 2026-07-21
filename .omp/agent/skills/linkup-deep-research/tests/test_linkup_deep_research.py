"""Deterministic unit tests for the local Linkup deep-research runner."""

from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "linkup_deep_research.py"
)
SPEC = importlib.util.spec_from_file_location("linkup_deep_research", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
research = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = research
SPEC.loader.exec_module(research)


class FakeTask:
    """Small SDK-shaped task with Pydantic's preferred serialization surface."""

    def __init__(self, task_id: str, status: str) -> None:
        self.id = task_id
        self.status = status

    def model_dump(self, *, mode: str, by_alias: bool) -> dict[str, str]:
        assert mode == "json"
        assert by_alias is True
        return {"id": self.id, "status": self.status, "source": "fake"}


class FakeClient:
    """Returns scripted values or raises scripted retrieval failures."""

    def __init__(self, responses: list[object]) -> None:
        self.responses = iter(responses)
        self.research_calls: list[tuple[str, str, str, str]] = []

    def research(
        self,
        query: str,
        *,
        output_type: str,
        reasoning_depth: str,
        mode: str,
    ) -> dict[str, str]:
        self.research_calls.append((query, output_type, reasoning_depth, mode))
        return {"id": "submitted-id"}

    def get_research(self, research_id: str) -> object:
        response = next(self.responses)
        if isinstance(response, BaseException):
            raise response
        return response


class LinkupDeepResearchTests(unittest.TestCase):
    def entry(self, research_id: str = "research-1") -> object:
        return research.QueueEntry(
            topic="A Topic",
            slug="a-topic",
            query="Find sourced evidence.",
            research_id=research_id,
            submitted_at="2026-07-21T00:00:00+00:00",
            output_timestamp="20260721T000000000000Z",
        )

    def poll_once(
        self,
        root: Path,
        client: FakeClient,
        entries: list[object],
    ) -> tuple[bool, io.StringIO, io.StringIO]:
        stderr = io.StringIO()
        stdout = io.StringIO()
        pending = research.poll_once(
            client,
            root,
            root / research.QUEUE_RELATIVE_PATH,
            entries,
            stderr=stderr,
            stdout=stdout,
        )
        return pending, stderr, stdout

    def test_topic_slug_is_lowercase_hyphenated_and_safe(self) -> None:
        self.assertEqual(research.topic_slug("  AI / Safety: 2026!  "), "ai-safety-2026")
        with self.assertRaises(ValueError):
            research.topic_slug("---")

    def test_atomic_queue_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "queue" / "query_ids.json"
            original = self.entry()
            research.save_queue(path, [original])
            self.assertEqual(research.load_queue(path), [original])
            self.assertFalse(list(path.parent.glob("*.tmp")))

    def test_completed_recovery_writes_envelope_then_removes_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [self.entry()]
            queue_path = root / research.QUEUE_RELATIVE_PATH
            research.save_queue(queue_path, entries)
            pending, stderr, stdout = self.poll_once(
                root, FakeClient([FakeTask("research-1", "completed")]), entries
            )

            destination = research.artifact_path(root, self.entry())
            self.assertFalse(pending)
            self.assertEqual(entries, [])
            self.assertEqual(research.load_queue(queue_path), [])
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))["source"], "fake")
            self.assertIn("completed", stderr.getvalue())
            self.assertEqual(stdout.getvalue().strip(), str(destination))

    def test_failed_recovery_writes_envelope_then_removes_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [self.entry()]
            queue_path = root / research.QUEUE_RELATIVE_PATH
            research.save_queue(queue_path, entries)
            pending, _, stdout = self.poll_once(
                root, FakeClient([FakeTask("research-1", "failed")]), entries
            )

            destination = research.artifact_path(root, self.entry())
            self.assertFalse(pending)
            self.assertEqual(research.load_queue(queue_path), [])
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))["status"], "failed")
            self.assertEqual(stdout.getvalue().strip(), str(destination))

    def test_pending_task_remains_in_persisted_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [self.entry()]
            queue_path = root / research.QUEUE_RELATIVE_PATH
            research.save_queue(queue_path, entries)
            pending, _, stdout = self.poll_once(
                root, FakeClient([FakeTask("research-1", "processing")]), entries
            )

            self.assertTrue(pending)
            self.assertEqual(stdout.getvalue(), "")
            persisted = research.load_queue(queue_path)
            self.assertEqual(len(persisted), 1)
            self.assertEqual(persisted[0].polling_state, "processing")
            self.assertIsNone(persisted[0].last_error)

    def test_transient_retrieval_failure_is_persisted_for_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [self.entry()]
            queue_path = root / research.QUEUE_RELATIVE_PATH
            research.save_queue(queue_path, entries)
            pending, stderr, stdout = self.poll_once(
                root, FakeClient([TimeoutError("temporary network failure")]), entries
            )

            self.assertTrue(pending)
            self.assertEqual(stdout.getvalue(), "")
            persisted = research.load_queue(queue_path)
            self.assertEqual(len(persisted), 1)
            self.assertEqual(persisted[0].research_id, "research-1")
            self.assertEqual(persisted[0].last_error, "TimeoutError: temporary network failure")
            self.assertIn("TimeoutError", stderr.getvalue())

    def test_not_found_task_remains_marked_unreachable(self) -> None:
        class NotFoundError(Exception):
            status_code = 404

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [self.entry()]
            queue_path = root / research.QUEUE_RELATIVE_PATH
            research.save_queue(queue_path, entries)
            pending, _, _ = self.poll_once(
                root, FakeClient([NotFoundError("research task absent")]), entries
            )

            self.assertTrue(pending)
            persisted = research.load_queue(queue_path)
            self.assertEqual(len(persisted), 1)
            self.assertEqual(persisted[0].polling_state, "unreachable")

    def test_polling_backoff_caps_at_ten_seconds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [self.entry()]
            queue_path = root / research.QUEUE_RELATIVE_PATH
            research.save_queue(queue_path, entries)
            delays: list[float] = []
            research.poll_until_terminal(
                FakeClient(
                    [
                        FakeTask("research-1", "processing"),
                        FakeTask("research-1", "processing"),
                        FakeTask("research-1", "processing"),
                        FakeTask("research-1", "processing"),
                        FakeTask("research-1", "completed"),
                    ]
                ),
                root,
                queue_path,
                entries,
                sleep=delays.append,
                stderr=io.StringIO(),
                stdout=io.StringIO(),
            )

            self.assertEqual(delays, [2.0, 4.0, 8.0, 10.0])
            self.assertEqual(entries, [])

    def test_submit_uses_required_maximum_depth_arguments(self) -> None:
        client = FakeClient([])
        entry = research.submit_entry(
            client,
            "Topic",
            "Detailed query",
            now=lambda: datetime(2026, 7, 21, tzinfo=timezone.utc),
        )
        self.assertEqual(entry.research_id, "submitted-id")
        self.assertEqual(
            client.research_calls,
            [("Detailed query", "sourcedAnswer", "XL", "research")],
        )


if __name__ == "__main__":
    unittest.main()
