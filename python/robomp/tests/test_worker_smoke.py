"""Hermetic end-to-end smoke test for the real OMP RPC subprocess.

Runs only when ``ROBOMP_INTEGRATION=1``. The fixture registers a deterministic
loopback model provider, so it never consumes ambient provider credentials.
It spins up a local bare repository, mocked GitHub API, real OMP CLI, built-in
OMP tools, and robomp host tools, then verifies the complete fix-and-PR flow.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest


class _FixtureModelServer:
    """Deterministic OpenAI chat-completions SSE server for the real omp RPC child."""

    def __init__(self) -> None:
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length))
                with fixture._lock:
                    fixture.requests.append(request)
                    response = fixture._response(request)
                encoded = response.encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                self.wfile.flush()

            def log_message(self, _format: str, *_args: object) -> None:
                return

        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_port}/v1"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    @staticmethod
    def _available(request: dict[str, Any]) -> dict[str, dict[str, Any]]:
        result: dict[str, dict[str, Any]] = {}
        for item in request.get("tools", []):
            function = item.get("function", {}) if isinstance(item, dict) else {}
            name = function.get("name")
            parameters = function.get("parameters", {})
            if isinstance(name, str):
                result[name] = parameters if isinstance(parameters, dict) else {}
        return result

    @staticmethod
    def _prior_calls(messages: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
        calls: list[tuple[str, dict[str, Any]]] = []
        for message in messages:
            if message.get("role") != "assistant":
                continue
            for call in message.get("tool_calls", []):
                function = call.get("function", {})
                name = function.get("name")
                if not isinstance(name, str):
                    continue
                try:
                    args = json.loads(function.get("arguments", "{}"))
                except (TypeError, json.JSONDecodeError):
                    args = {}
                calls.append((name, args if isinstance(args, dict) else {}))
        return calls

    def _response(self, request: dict[str, Any]) -> str:
        available = self._available(request)

        def available_name(name: str) -> str | None:
            if name in available:
                return name
            namespaced = f"xd://{name}"
            return namespaced if namespaced in available else None

        calls = self._prior_calls(request.get("messages", []))
        names = [name.removeprefix("xd://") for name, _args in calls]
        bash_commands = [
            args.get("command", "")
            for name, args in calls
            if name.removeprefix("xd://") == "bash" and isinstance(args.get("command"), str)
        ]
        tool_name: str | None = None
        args: dict[str, Any] = {}
        if "read" not in names and available_name("read") is not None:
            tool_name, args = "read", {"path": "test.js"}
        elif "fetch_issue_thread" not in names and available_name("fetch_issue_thread") is not None:
            tool_name, args = "fetch_issue_thread", {}
        elif "gh_search_issues" not in names and available_name("gh_search_issues") is not None:
            tool_name, args = "gh_search_issues", {"query": '"2+2 should be 4"', "limit": 10}
        elif "classify_issue" not in names and available_name("classify_issue") is not None:
            tool_name, args = (
                "classify_issue",
                {
                    "primary": "bug",
                    "priority": "prio:p1",
                    "rationale": "The assertion expects the wrong result for a deterministic arithmetic expression.",
                },
            )
        elif not bash_commands and available_name("bash") is not None:
            tool_name, args = "bash", {"command": "node test.js"}
        elif "repro_record" not in names and available_name("repro_record") is not None:
            first_output = next(
                (
                    str(message.get("content", ""))
                    for message in reversed(request.get("messages", []))
                    if message.get("role") == "tool"
                ),
                "AssertionError: 2 + 2 !== 5",
            )
            tool_name, args = (
                "repro_record",
                {
                    "title": "2+2 assertion fails",
                    "command": "node test.js",
                    "output": first_output,
                    "exit_code": 1,
                },
            )
        elif (
            not any("replace('2 + 2, 5'" in command for command in bash_commands) and available_name("bash") is not None
        ):
            tool_name, args = (
                "bash",
                {
                    "command": (
                        "python3 -c \"from pathlib import Path; p=Path('test.js'); "
                        "p.write_text(p.read_text().replace('2 + 2, 5', '2 + 2, 4'))\""
                    )
                },
            )
        elif bash_commands.count("node test.js") < 2 and available_name("bash") is not None:
            tool_name, args = "bash", {"command": "node test.js"}
        elif (
            not any(command.startswith("git add test.js") for command in bash_commands)
            and available_name("bash") is not None
        ):
            tool_name, args = "bash", {"command": "git add test.js && git commit -m 'fix: correct 2 + 2 assertion'"}
        elif "gh_push_branch" not in names and available_name("gh_push_branch") is not None:
            tool_name, args = "gh_push_branch", {"skip_checks": True}
        elif "gh_post_comment" not in names and available_name("gh_post_comment") is not None:
            tool_name, args = (
                "gh_post_comment",
                {
                    "body": "Reproduced the failing assertion, corrected test.js to expect 4, and verified node test.js passes.",
                },
            )
        elif "gh_open_pr" not in names and available_name("gh_open_pr") is not None:
            tool_name, args = (
                "gh_open_pr",
                {
                    "title": "Fix 2+2 assertion",
                    "body": (
                        "## Repro\nnode test.js failed because the assertion expected 5.\n\n"
                        "## Cause\nThe expected arithmetic result was incorrect.\n\n"
                        "## Fix\nUpdated test.js to assert 2 + 2 equals 4.\n\n"
                        "## Verification\nnode test.js passes after the committed fix.\n\nFixes #1"
                    ),
                    "skip_checks": True,
                },
            )
        if tool_name is None:
            return self._text_response(request.get("model", "fixture/fallback"))
        actual_tool_name = available_name(tool_name) or tool_name
        call_id = f"fixture-call-{len(calls) + 1}"
        model = request.get("model", "fixture/fallback")
        chunk = {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": model}
        delta = {
            "role": "assistant",
            "tool_calls": [
                {
                    "index": 0,
                    "id": call_id,
                    "type": "function",
                    "function": {"name": actual_tool_name, "arguments": json.dumps(args)},
                }
            ],
        }
        return (
            f"data: {json.dumps({**chunk, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]})}\n\n"
            f"data: {json.dumps({**chunk, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]})}\n\n"
            "data: [DONE]\n\n"
        )

    @staticmethod
    def _text_response(model: str) -> str:
        chunk = {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": model}
        return (
            f"data: {json.dumps({**chunk, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Fixture workflow complete.'}, 'finish_reason': None}]})}\n\n"
            f"data: {json.dumps({**chunk, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
            "data: [DONE]\n\n"
        )


INTEGRATION = os.environ.get("ROBOMP_INTEGRATION") == "1"

pytestmark = pytest.mark.skipif(
    not INTEGRATION,
    reason="ROBOMP_INTEGRATION=1 required to run the omp-backed smoke test",
)


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ | {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
    }
    return subprocess.run(["git", *args], cwd=str(cwd), check=check, capture_output=True, text=True, env=env)


def _seed_failing_repo(tmp_path: Path) -> Path:
    bare = tmp_path / "upstream.git"
    bare.mkdir()
    _git(bare.parent, "init", "--initial-branch=main", "--bare", str(bare))
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init", "--initial-branch=main")
    (seed / "test.js").write_text(
        "const assert = require('assert');\n"
        "// FIXME: this assertion is wrong; the answer is 4.\n"
        "assert.strictEqual(2 + 2, 5);\n"
    )
    (seed / "README.md").write_text("toy repo\n")
    _git(seed, "add", ".")
    _git(seed, "commit", "-m", "init")
    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "origin", "main")
    return bare


def _start_model_fixture(tmp_path: Path) -> tuple[_FixtureModelServer, Path]:
    server = _FixtureModelServer()
    agent_dir = tmp_path / "omp-agent"
    agent_dir.mkdir()
    (agent_dir / "config.yml").write_text("tools:\n  xdev: false\n", encoding="utf-8")
    extension_path = tmp_path / "fixture-provider.mjs"
    extension_path.write_text(
        "export default function (api) {\n"
        "  api.registerProvider('fixture', {\n"
        f"    baseUrl: {json.dumps(server.base_url)},\n"
        "    apiKey: 'offline-fixture-key',\n"
        "    api: 'openai-completions',\n"
        "    models: [{\n"
        "      id: 'fallback', name: 'fallback', reasoning: false, input: ['text'],\n"
        "      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},\n"
        "      contextWindow: 128000, maxTokens: 2048,\n"
        "    }],\n"
        "  });\n"
        "}\n",
        encoding="utf-8",
    )
    wrapper_path = tmp_path / "omp-fixture"
    cli_path = Path(__file__).parents[3] / "packages/coding-agent/src/cli.ts"
    wrapper_path.write_text(
        "#!/bin/sh\n"
        f"PI_CODING_AGENT_DIR={shlex.quote(str(agent_dir))}; export PI_CODING_AGENT_DIR\n"
        f'exec bun {shlex.quote(str(cli_path))} --extension {shlex.quote(str(extension_path))} "$@"\n',
        encoding="utf-8",
    )
    wrapper_path.chmod(0o755)
    return server, wrapper_path


def test_triage_end_to_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from robomp.config import Settings, reset_settings_cache
    from robomp.db import Database
    from robomp.github_client import GitHubClient
    from robomp.sandbox import LocalGitTransport, SandboxManager
    from robomp.tasks import triage_issue

    bare = _seed_failing_repo(tmp_path)
    model_server, omp_command = _start_model_fixture(tmp_path)

    monkeypatch.setenv("ROBOMP_GH_PROXY_URL", "http://gh-proxy.invalid:8081")
    monkeypatch.setenv("ROBOMP_GH_PROXY_HMAC_KEY", "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "secret")
    monkeypatch.setenv("ROBOMP_BOT_LOGIN", "robomp-bot")
    monkeypatch.setenv("ROBOMP_GIT_AUTHOR_NAME", "robomp-test")
    monkeypatch.setenv("ROBOMP_GIT_AUTHOR_EMAIL", "robomp-test@example.invalid")
    monkeypatch.setenv("ROBOMP_REPO_ALLOWLIST", "octo/widget")
    monkeypatch.setenv("ROBOMP_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("ROBOMP_SQLITE_PATH", str(tmp_path / "robomp.sqlite"))
    monkeypatch.setenv("ROBOMP_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("ROBOMP_TASK_TIMEOUT_SECONDS", "300")
    monkeypatch.setenv("ROBOMP_OMP_COMMAND", str(omp_command))
    monkeypatch.setenv("ROBOMP_MODEL", "fixture/fallback")
    monkeypatch.setenv("ROBOMP_THINKING", "off")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    comments: list[dict[str, Any]] = []
    prs: list[dict[str, Any]] = []
    applied_labels: list[str] = []
    next_comment_id = [100]

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        if method == "GET" and path == "/repos/octo/widget":
            return httpx.Response(
                200,
                json={
                    "full_name": "octo/widget",
                    "default_branch": "main",
                    "clone_url": str(bare),
                    "private": False,
                },
            )
        if method == "GET" and path == "/repos/octo/widget/issues/1":
            return httpx.Response(
                200,
                json={
                    "number": 1,
                    "title": "2+2 should be 4",
                    "body": "Running `node test.js` exits non-zero because the assertion claims 2+2 is 5.",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [],
                },
            )
        if method == "GET" and path == "/repos/octo/widget/issues/1/comments":
            return httpx.Response(200, json=comments)
        if method == "GET" and path == "/search/issues":
            return httpx.Response(200, json={"items": []})
        if method == "POST" and path == "/repos/octo/widget/issues/1/comments":
            body = json.loads(request.content)
            next_comment_id[0] += 1
            comment = {
                "id": next_comment_id[0],
                "user": {"login": "robomp-bot"},
                "body": body["body"],
                "created_at": "now",
            }
            comments.append(comment)
            return httpx.Response(201, json=comment)
        if method == "POST" and path == "/repos/octo/widget/issues/1/labels":
            body = json.loads(request.content)
            applied_labels.extend(body["labels"])
            return httpx.Response(200, json=[{"name": label} for label in body["labels"]])
        if method == "POST" and path == "/repos/octo/widget/pulls":
            body = json.loads(request.content)
            pr = {
                "number": 7,
                "html_url": "https://example.invalid/octo/widget/pull/7",
                "head": {"ref": body["head"]},
                "base": {"ref": body["base"]},
                "state": "open",
                "title": body["title"],
                "body": body["body"],
            }
            prs.append(pr)
            return httpx.Response(201, json=pr)
        return httpx.Response(404, json={"message": f"unmocked {method} {path}"})

    transport = httpx.MockTransport(handler)

    payload = {
        "action": "opened",
        "issue": {
            "number": 1,
            "title": "2+2 should be 4",
            "body": "Running `node test.js` exits non-zero because the assertion claims 2+2 is 5.",
            "state": "open",
            "user": {"login": "alice"},
            "labels": [],
        },
        "repository": {
            "full_name": "octo/widget",
            "default_branch": "main",
            "clone_url": str(bare),
            "private": False,
        },
    }

    async def _go() -> None:
        db = Database(cfg.sqlite_path)
        github = GitHubClient("ghp_test", transport=transport)
        sandbox = SandboxManager(cfg.workspace_root)
        await triage_issue(
            settings=cfg,
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            sandbox=sandbox,
            payload=payload,
            delivery_id="smoke-test",
        )
        row = db.get_issue("octo/widget#1")
        assert row is not None, "issue row missing"
        assert row.state in {"opened"}, f"unexpected state {row.state}"
        db.close()

    try:
        asyncio.run(_go())
    finally:
        model_server.close()

    assert prs, "no PR opened"
    pr = prs[0]
    for section in ("## Repro", "## Cause", "## Fix", "## Verification"):
        assert section in pr["body"], f"PR body missing {section}"
    assert "Fixes #1" in pr["body"]
    # Branch should be pushed to the bare repo.
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
    pushed_branch = next(
        r.removeprefix("refs/heads/") for r in refs.stdout.splitlines() if r.startswith("refs/heads/farm/")
    )
    branch_file = subprocess.run(
        ["git", "-C", str(bare), "show", f"{pushed_branch}:test.js"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "bug" in applied_labels
    assert "assert.strictEqual(2 + 2, 4);" in branch_file.stdout
    assert comments, "expected at least one comment"
