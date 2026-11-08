---
name: quality-checklist
description: This skill MUST be used when assessing whether changes are ready to commit or performing a read-only pre-commit readiness review. Remediation belongs to fix-precommit.
---

# Quality Checklist

## Quick Navigation

- [Pre-Commit Quality Gates](#pre-commit-quality-gates)
- [Test Guidelines](#test-guidelines)
- [Quick Validation Workflow](#quick-validation-workflow)
- [Common Pre-Commit Failures](#common-pre-commit-failures-and-fixes)

---

## Tool Usage Constraints

Use OMP `read`, `grep`, and `glob` for repository inspection before falling back to validation commands.

**`bash` usage**: Limited to readonly diagnostic and validation commands:
- ✅ Allowed: `git status`, `git diff`, `uv run pytest`, `uv run ruff check .`, `uv run mypy src/`, `grep`, `find`, `ls`
- ❌ Not allowed: `rm`, `git push`, `git commit`, `git add`, file modifications, destructive operations

When using `bash`, verify the command is readonly or validation-only before execution.

---

## When to Use This Checklist

Use this skill when:
- Preparing to commit changes
- User asks "is this ready?" or "can you verify everything?"
- Completing a feature or bugfix
- Before creating a pull request
- After resolving code review feedback

---

## Pre-Commit Quality Gates

### Definition of Done

Work through this checklist systematically before committing:

#### ✅ Tests Written and Passing

**Verification Commands**:
```bash
# Run all tests
uv run pytest tests/

# Run specific test file
uv run pytest tests/test_specific.py

# Run with verbose output
uv run pytest -v tests/

# Check test coverage (if coverage installed)
uv run pytest --cov=src tests/
```

**Checklist**:
- [ ] Unit tests exist for new functionality
- [ ] Integration tests updated if API changed
- [ ] All tests pass locally
- [ ] No skipped tests without good reason
- [ ] Test coverage meets project standards (typically >80%)

**Common Issues**:
- Forgot to add test file to git
- Tests pass individually but fail when run together
- Tests depend on specific execution order (fix: make deterministic)

---

#### ✅ Code Follows Project Conventions

**Verification Commands**:
```bash
# Check which files were modified
git status

# Review actual changes
git diff

# Check if code matches patterns in similar files
grep -r "similar_pattern" src/
```

**Checklist**:
- [ ] Follows directory structure conventions (scrapers/, chumbawamba/, etc.)
- [ ] Uses project-specific patterns (existing scraper patterns for new scrapers)
- [ ] Naming conventions match existing code
- [ ] Import structure consistent with codebase
- [ ] Uses `woodpecker` for logging (NOT `logging`)
- [ ] Uses `uv run` commands (NOT `python` directly)
- [ ] Uses `datetime.now(timezone.utc)` (NOT `datetime.utcnow()`)

**Taipan-Specific Checks**:
- [ ] Utilities only in `src/utils/` (nowhere else)
- [ ] NumPy style docstrings used
- [ ] Function signatures have type hints

---

#### ✅ No Linter/Formatter Warnings

**Verification Commands**:
```bash
# Run ruff linter
uv run ruff check .

# Auto-fix issues where possible
uv run ruff check . --fix

# Run type checker
uv run mypy src/
```

**Checklist**:
- [ ] Ruff reports no errors
- [ ] Mypy reports no type errors
- [ ] No unused imports
- [ ] No undefined variables
- [ ] No unreachable code

**Common Issues**:
- Import ordering incorrect (ruff can auto-fix)
- Type hints missing or incorrect
- Unused function parameters (prefix with `_` if intentional)

---

#### ✅ Commit Messages Are Clear

**Verification**:
- Review planned commit message against changes

**Checklist**:
- [ ] Uses conventional commits format: `type(scope): description`
  - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
  - Example: `feat(scrapers): add Vestas API scraper`
- [ ] First line ≤50 chars (summary)
- [ ] Body explains "why" not "what" (code shows "what")
- [ ] References issue numbers if applicable

**Good Example**:
```
feat(scrapers): add Vestas API scraper

Implements scraper for WindCorp's Vestas turbine data API.
Uses OAuth2 authentication and handles rate limiting.
Follows pattern from greenbyte.py for consistency.

Closes #123
```

**Bad Example**:
```
update code
```

---

#### ✅ Implementation Matches Plan

**Verification**:
```bash
# Check if IMPLEMENTATION_PLAN.md exists
ls IMPLEMENTATION_PLAN.md

# Review plan against changes
git diff
```

**Checklist**:
- [ ] All planned features implemented
- [ ] No scope creep (extra unplanned changes)
- [ ] Architecture decisions followed
- [ ] No significant deviations without documentation

**If Deviations Exist**:
- Document why in commit message
- Update plan file if it exists
- Consider if deviation should be separate commit

---

#### ✅ No TODOs Without Issue Numbers

**Verification Commands**:
```bash
# Find all TODOs in changed files
git diff --cached | grep -i "TODO"

# Or search in specific directories
grep -r "TODO" src/
```

**Checklist**:
- [ ] No `TODO` comments without issue references
- [ ] Temporary debugging code removed
- [ ] No commented-out code blocks
- [ ] No placeholder functions/classes

**Acceptable**:
```python
# TODO(#456): Implement caching layer for API responses
```

**Not Acceptable**:
```python
# TODO: fix this later
# TODO: make this better
```

---

## Test Guidelines

When writing or reviewing tests, follow these principles:

### Test Behavior, Not Implementation

**Good**: Test that function returns correct output for given input
```python
def test_calculate_quality_score_returns_expected_value():
    score = calculate_quality_score(data={'accuracy': 0.95})
    assert score == 95.0
```

**Bad**: Test internal implementation details
```python
def test_calculate_quality_score_calls_internal_method():
    # Don't test that private methods were called
    assert scraper._internal_calc() was called
```

---

### One Assertion Per Test When Possible

**Good**: Each test verifies one behavior
```python
def test_scraper_handles_valid_data():
    result = scraper.parse(valid_data)
    assert result is not None

def test_scraper_returns_correct_data_type():
    result = scraper.parse(valid_data)
    assert isinstance(result, DataFrame)
```

**Acceptable**: Multiple assertions for same behavior
```python
def test_scraper_parses_turbine_data_correctly():
    result = scraper.parse(valid_data)
    assert result['turbine_id'] == 'T01'
    assert result['power'] == 2500
    assert result['timestamp'] is not None
```

---

### Clear Test Names Describing Scenario

**Good**: Name describes what's being tested and expected outcome
```python
def test_scraper_raises_error_when_api_key_invalid():
    ...

def test_transformer_handles_missing_timestamps():
    ...

def test_uploader_retries_on_network_failure():
    ...
```

**Bad**: Vague or unclear names
```python
def test_scraper():
    ...

def test_1():
    ...

def test_edge_case():
    ...
```

---

### Use Existing Test Utilities/Helpers

**Verification**:
```bash
# Find existing test fixtures
grep -r "@pytest.fixture" tests/

# Find test utilities
ls tests/utils/ tests/conftest.py
```

**Checklist**:
- [ ] Use existing fixtures instead of duplicating setup
- [ ] Import shared test utilities
- [ ] Follow existing test patterns in similar test files

**Example**:
```python
# Good: Reuse existing fixture
def test_scraper_with_mock_api(mock_api_client):
    ...

# Bad: Duplicate fixture setup
def test_scraper():
    mock_api_client = MockAPIClient()  # Already exists as fixture
    ...
```

---

### Tests Should Be Deterministic

**Checklist**:
- [ ] Tests produce same result on every run
- [ ] No dependency on external services (use mocks)
- [ ] No dependency on system time (use fixed timestamps)
- [ ] No dependency on file system state (clean up after tests)
- [ ] No dependency on test execution order

**Good**: Deterministic test
```python
def test_parser_with_fixed_timestamp():
    fixed_time = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    result = parser.parse(data, timestamp=fixed_time)
    assert result['time'] == fixed_time
```

**Bad**: Non-deterministic test
```python
def test_parser_with_current_time():
    result = parser.parse(data)  # Uses current time
    assert result['time'] < datetime.now()  # Flaky!
```

---

## Quick Validation Workflow

Run this sequence before committing:

```bash
# 1. Check what's changed
git status
git diff

# 2. Run tests
uv run pytest tests/

# 3. Run linters
uv run ruff check . --fix
uv run mypy src/

# 4. Review changes one more time
git diff

# 5. Stage and commit (if all checks pass)
git add <files>
git commit -m "type(scope): description"
```

---

## Common Pre-Commit Failures and Fixes

| Issue | Detection | Fix |
|-------|-----------|-----|
| **Tests failing** | `uv run pytest` errors | Fix tests or code; never commit failing tests |
| **Linter errors** | `ruff check` shows errors | Run `ruff check . --fix` or fix manually |
| **Type errors** | `mypy` shows errors | Add/fix type hints |
| **Untracked files** | `git status` shows `??` | Verify if should be committed or ignored |
| **Large files** | `git add` warns | Check if should be in .gitignore |
| **Merge conflicts** | `git status` shows conflicts | Resolve conflicts before committing |

---

## Quality Gate Philosophy

**Remember**: These checks aren't bureaucracy - they're protection:
- **Tests** prevent regressions
- **Conventions** enable team collaboration
- **Linters** catch bugs early
- **Clear commits** enable debugging later
- **No TODOs** prevent technical debt accumulation

Taking 5 minutes for this checklist saves hours of debugging later.
