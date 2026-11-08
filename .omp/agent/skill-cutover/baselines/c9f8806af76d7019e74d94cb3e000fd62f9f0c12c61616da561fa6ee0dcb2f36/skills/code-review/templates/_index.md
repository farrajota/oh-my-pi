# Code-Review Template Catalogue

This file is consumed by the **Phase 2 Structure Analysis** agent of the `code-review` skill. It declares:

1. Every reviewable sub-topic (one per file the user wants individually scored).
2. The path of the template the assigned agent must read.
3. The trigger globs / signature heuristics used to decide which files belong to that sub-topic.
4. The preferred specialist agent (with fallback) for each sub-topic.

The Phase 2 agent **never** invents sub-topics — only the ones below are scheduled. Sub-topics with zero matching files are marked `skip: true` and not dispatched.

---

## Globs & signature vocabulary

- `src_files` = repo Python source: `**/*.py` excluding `tests/**`, `**/__pycache__/**`, `**/.venv/**`, build dirs, generated stubs.
- `test_files` = `tests/**/*.py` (split below).
- `unit_tests` = `tests/unit/**/*.py`
- `integration_tests` = `tests/integration/**/*.py`
- `e2e_tests` = `tests/e2e/**/*.py` and `tests/end_to_end/**/*.py`
- `property_tests` = any test file importing `hypothesis`
- `containers` = `Dockerfile*`, `**/Dockerfile*`, `compose*.y*ml`
- `ci_files` = `.github/workflows/**/*.y*ml`, `.gitlab-ci.yml`, `Jenkinsfile`
- `api_specs` = `openapi*.y*ml`, `**/swagger*.json`, `**/*.graphql`, `**/schemas/*.json`
- `docs` = `docs/**/*.md`, `**/README*.md`, `ai_docs/adrs/**/*.md`, `docs/runbooks/**/*.md`
- `deps_manifests` = `pyproject.toml`, `uv.lock`, `requirements*.txt`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`
- `config_files` = `**/config*.py`, `**/settings*.py`, `**/*.env*`, `**/conftest.py` (excluded), `**/*.toml`, `**/*.yaml` under `config/`
- For non-Python stacks, swap `*.py` for the language's extension and apply the analogous test convention.

---

## Sub-topics

> Format:
> ```
> ### <id>
> - **template**: <path>
> - **agent**: <preferred> → <fallback>
> - **triggers**: <glob / signature rules>
> - **skip-when**: <conditions that warrant `skip: true>`>
> ```

### code-quality/structure_sizing
- **template**: `skill://code-review/templates/code-quality/structure_sizing.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: every `src_files` whose line count ≥ 150, OR all `src_files` if scope has < 30 files
- **skip-when**: no `src_files`

### code-quality/naming_conventions
- **template**: `skill://code-review/templates/code-quality/naming_conventions.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: representative sample (up to 25) of `src_files`, prioritising files with public API surface (`__init__.py`, `api/`, `models/`, top-level modules)
- **skip-when**: no `src_files`

### code-quality/coupling_cohesion
- **template**: `skill://code-review/templates/code-quality/coupling_cohesion.md`
- **agent**: `python-architect` → `python-code-reviewer`
- **triggers**: any `src_files` with ≥ 3 module imports OR class hierarchies of depth ≥ 2 (heuristic: `class \w+\([\w.]+\):`)
- **skip-when**: no `src_files`

### code-quality/complexity_control_flow
- **template**: `skill://code-review/templates/code-quality/complexity_control_flow.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: `src_files` flagged by `xenon` if available, else files with ≥ 4 levels of nesting (heuristic `rg "                "`)
- **skip-when**: no `src_files`

### code-quality/error_handling
- **template**: `skill://code-review/templates/code-quality/error_handling.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: `src_files` containing `try:`, `except`, or `raise`
- **skip-when**: no exception usage in scope

### code-quality/pythonic_idioms
- **template**: `skill://code-review/templates/code-quality/pythonic_idioms.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: `src_files` (Python only)
- **skip-when**: Python not in `<stack.languages>`

### code-quality/type_hints
- **template**: `skill://code-review/templates/code-quality/type_hints.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: `src_files` containing `typing` imports OR `# type: ignore` OR `Any`
- **skip-when**: Python not in `<stack.languages>`

### code-quality/data_modeling
- **template**: `skill://code-review/templates/code-quality/data_modeling.md`
- **agent**: `python-code-reviewer` → `python-architect`
- **triggers**: `src_files` containing `pydantic`, `@dataclass`, or `TypedDict`, OR `src_files` shaping JSON payloads (e.g. `response.json()`)
- **skip-when**: no data-shaping code

### test-quality/unit_tests
- **template**: `skill://code-review/templates/test-quality/unit_tests.md`
- **agent**: `python-test-specialist` → `python-code-reviewer`
- **triggers**: `unit_tests`
- **skip-when**: `unit_tests` is empty

### test-quality/property_tests
- **template**: `skill://code-review/templates/test-quality/property_tests.md`
- **agent**: `python-test-specialist` → `python-code-reviewer`
- **triggers**: `property_tests`
- **skip-when**: no test file imports `hypothesis`

### test-quality/integration_tests
- **template**: `skill://code-review/templates/test-quality/integration_tests.md`
- **agent**: `python-test-specialist` → `python-code-reviewer`
- **triggers**: `integration_tests`
- **skip-when**: `integration_tests` is empty

### test-quality/e2e_tests
- **template**: `skill://code-review/templates/test-quality/e2e_tests.md`
- **agent**: `python-test-specialist` → `python-code-reviewer`
- **triggers**: `e2e_tests`
- **skip-when**: `e2e_tests` is empty

### test-quality/test_performance
- **template**: `skill://code-review/templates/test-quality/test_performance.md`
- **agent**: `python-test-specialist` → `python-performance-reviewer`
- **triggers**: all `test_files` (any tier)
- **skip-when**: `test_files` is empty

### documentation/adrs
- **template**: `skill://code-review/templates/documentation/adrs.md`
- **agent**: `diataxis-documentation-architect` → `general-purpose`
- **triggers**: `ai_docs/adrs/**/*.md`, `docs/adr/**/*.md`, `docs/decisions/**/*.md`. If none exist, still trigger ONCE against the repo root to flag the **absence** of ADRs.
- **skip-when**: never (ADR absence is itself a finding)

### documentation/readme_runbooks
- **template**: `skill://code-review/templates/documentation/readme_runbooks.md`
- **agent**: `diataxis-documentation-architect` → `general-purpose`
- **triggers**: `README*.md` at repo root + `docs/runbooks/**/*.md`
- **skip-when**: never (missing README is a finding)

### documentation/code_comments
- **template**: `skill://code-review/templates/documentation/code_comments.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: `src_files` with comment density ≥ 5 lines OR containing TODO/FIXME/HACK/XXX markers
- **skip-when**: no `src_files`

### documentation/api_contracts
- **template**: `skill://code-review/templates/documentation/api_contracts.md`
- **agent**: `api-design-architect` → `diataxis-documentation-architect`
- **triggers**: `api_specs` plus any `src_files` defining FastAPI/Flask/Django/Starlette routes or MCP tool registrations
- **skip-when**: no public API endpoints detected

### security/input_validation
- **template**: `skill://code-review/templates/security/input_validation.md`
- **agent**: `python-security-reviewer` → `general-purpose`
- **triggers**: `src_files` accepting external input (route handlers, CLI argparsers, MCP tool params)
- **skip-when**: no input-handling code

### security/authn_authz
- **template**: `skill://code-review/templates/security/authn_authz.md`
- **agent**: `python-security-reviewer` → `security-architect`
- **triggers**: `src_files` containing `auth`, `jwt`, `session`, `permission`, `role`, `token`, `login`, `oauth`, or `password`
- **skip-when**: no auth-related signals

### security/secrets_management
- **template**: `skill://code-review/templates/security/secrets_management.md`
- **agent**: `python-security-reviewer` → `general-purpose`
- **triggers**: every `src_files` + `config_files` + `.env*`
- **skip-when**: never

### security/ssrf_internal
- **template**: `skill://code-review/templates/security/ssrf_internal.md`
- **agent**: `python-security-reviewer` → `general-purpose`
- **triggers**: `src_files` calling `requests.`, `httpx.`, `urllib.`, `aiohttp.`, or `urlopen` where the URL argument is non-literal
- **skip-when**: no HTTP client usage with dynamic URLs

### security/least_privilege
- **template**: `skill://code-review/templates/security/least_privilege.md`
- **agent**: `python-security-reviewer` → `devops-engineer`
- **triggers**: `containers`, `ci_files`, IaC files (`*.tf`, `*.bicep`), and `src_files` mentioning IAM/`boto3`/`google-cloud`/`azure-`
- **skip-when**: no infra-touching code

### performance/db_n_plus_1
- **template**: `skill://code-review/templates/performance/db_n_plus_1.md`
- **agent**: `python-performance-reviewer` → `python-code-reviewer`
- **triggers**: `src_files` importing `sqlalchemy`, `psycopg`, `sqlite3`, `asyncpg`, or executing SQL strings; also files matching the pattern `for .* in .*:` followed by `.execute(`/`session.query(` within 20 lines
- **skip-when**: no DB access

### performance/algorithmic_complexity
- **template**: `skill://code-review/templates/performance/algorithmic_complexity.md`
- **agent**: `python-performance-reviewer` → `performance-optimizer`
- **triggers**: `src_files` containing nested loops (`for ... for`) or sorting on collections passed as arguments
- **skip-when**: no `src_files`

### performance/memory_resource_leaks
- **template**: `skill://code-review/templates/performance/memory_resource_leaks.md`
- **agent**: `python-performance-reviewer` → `python-code-reviewer`
- **triggers**: `src_files` using `open(`, `socket.`, `threading.Thread`, `subprocess.`, `multiprocessing`, generators returning unbounded data, or global mutable state (`= []` / `= {}` at module level)
- **skip-when**: no resource-acquisition code

### performance/http_resilience
- **template**: `skill://code-review/templates/performance/http_resilience.md`
- **agent**: `python-performance-reviewer` → `python-code-reviewer`
- **triggers**: `src_files` importing `requests`, `httpx`, `aiohttp`, `urllib3`
- **skip-when**: no HTTP client

### performance/caching
- **template**: `skill://code-review/templates/performance/caching.md`
- **agent**: `python-performance-reviewer` → `performance-optimizer`
- **triggers**: `src_files` containing `functools.lru_cache`, `cachetools`, `redis`, `memcache`, or repeated heavy computations
- **skip-when**: never (absence of caching where it would help is also a finding)

### observability/structured_logging
- **template**: `skill://code-review/templates/observability/structured_logging.md`
- **agent**: `python-code-reviewer` → `general-purpose`
- **triggers**: every `src_files` + every `print(` occurrence
- **skip-when**: no `src_files`

### observability/metrics_alerting
- **template**: `skill://code-review/templates/observability/metrics_alerting.md`
- **agent**: `devops-sre-automation` → `python-code-reviewer`
- **triggers**: `src_files` importing `prometheus_client`, `opentelemetry`, `statsd`, `datadog`; OR if none, scan the request/job entry points to flag absence
- **skip-when**: never (absence of metrics on user-facing paths is a finding)

### architecture/separation_of_concerns
- **template**: `skill://code-review/templates/architecture/separation_of_concerns.md`
- **agent**: `systems-architecture-designer` → `python-architect`
- **triggers**: representative slice of `src_files` plus all `__init__.py`, framework entry points, and any file mixing HTTP/route handling with DB calls
- **skip-when**: no `src_files`

### architecture/idempotency
- **template**: `skill://code-review/templates/architecture/idempotency.md`
- **agent**: `distributed-systems-architect` → `systems-architecture-designer`
- **triggers**: `src_files` defining POST/PUT/PATCH endpoints, message-queue consumers, retry decorators, or "create"/"process" tool handlers
- **skip-when**: no write-side endpoints or consumers

### ci-devops/containerization
- **template**: `skill://code-review/templates/ci-devops/containerization.md`
- **agent**: `devops-engineer` → `devops-sre-automation`
- **triggers**: `containers`
- **skip-when**: no Dockerfile or compose files

### ci-devops/pipeline_efficiency
- **template**: `skill://code-review/templates/ci-devops/pipeline_efficiency.md`
- **agent**: `devops-engineer` → `devops-sre-automation`
- **triggers**: `ci_files`
- **skip-when**: no CI configuration

### concurrency/async_safety
- **template**: `skill://code-review/templates/concurrency/async_safety.md`
- **agent**: `python-performance-reviewer` → `python-code-reviewer`
- **triggers**: `src_files` containing `async def`, `await`, `asyncio.`, `threading.`, `concurrent.futures.`, or `multiprocessing`
- **skip-when**: no async / threading usage

### data-privacy/pii_handling
- **template**: `skill://code-review/templates/data-privacy/pii_handling.md`
- **agent**: `python-security-reviewer` → `general-purpose`
- **triggers**: `src_files` containing PII vocabulary — `email`, `phone`, `ssn`, `address`, `birthday`, `dob`, `card_number`, `iban`, `pii`, `gdpr`, `consent`, `user_id`, `name`
- **skip-when**: no PII vocabulary AND no user-data persistence

### dependency/supply_chain
- **template**: `skill://code-review/templates/dependency/supply_chain.md`
- **agent**: `python-security-reviewer` → `devops-engineer`
- **triggers**: `deps_manifests`
- **skip-when**: no manifests

### configuration/env_management
- **template**: `skill://code-review/templates/configuration/env_management.md`
- **agent**: `python-architect` → `python-code-reviewer`
- **triggers**: `config_files`, `src_files` calling `os.environ`, `os.getenv`, `dotenv`, or `pydantic_settings`
- **skip-when**: no env / config access

---

## Partitioning rule (Phase 2 must enforce)

If any sub-topic's file list would exceed **25 files**, split it by top-level directory and emit multiple entries with suffixes:

```
code-quality/structure_sizing__pkg-admin
code-quality/structure_sizing__pkg-mcp
```

Each split entry shares the same template and agent.

## Adding a new sub-topic

1. Create the template file under the matching domain folder following the strict structure of an existing template.
2. Add an entry to this index with: id, template path, agent, triggers, skip-when.
3. Phase 2 will pick it up automatically — no code changes elsewhere needed.
