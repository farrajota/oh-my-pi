{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.
Execution does not block — you receive IDs immediately.{{else}}Delegate work to ONE background subagent per call.
Execution does not block — you receive an ID immediately.{{/if}}{{#if hasBlockingAgents}}
Agents marked BLOCKING run inline — results return in this call; non-blocking items in the same batch still spawn as background jobs.{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch. Execution blocks until all work finishes.{{else}}Run ONE subagent synchronously. Execution blocks until work finishes.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Async Job Contract
- Results auto-deliver. A settled `hub jobs`/`hub wait` snapshot is the delivery; no duplicate `async-result` follows.
- Job IDs are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
{{/if}}

# Task Design
- **Agent typing:** Pick each item's `agent` type. Read-only research MUST use `agent: "scout"` (faster model). Use default worker only when no specialist fits.
- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.
- **One-pass:** Prefer agents that investigate AND edit in one pass; spin a read-only scout only when affected files are genuinely unknown.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type running this item (e.g. `scout`, `reviewer`). Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
  - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
  - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
  - `isolated`: Run in dedicated worktree, return patches. Destroyed on completion, cannot be addressed afterward.
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. `scout`, `reviewer`). Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
- `isolated`: Run in dedicated worktree, return patches.
{{/if}}
{{/if}}
- `toolProfile`: Optional least-privilege tool shorthand: `none`, `inspect`, `review`, `edit`, `plan`, `web-research`, or `vision`. It can only restrict an agent's tools.
{{#if permissionsEnabled}}
- `permissions`: Least-privilege guardrails. In a batch, set this on each `tasks[]` item. With a `toolProfile`, the effective tools are their intersection; permissions never widen the profile.
  - `profiles`: Permission profile names. Combine a tool-granting profile with modifier profiles as needed.
{{#if permissionToolsEnabled}}
  - `tools`: Optional explicit tool allowlist.
  - `denyTools`: Optional additional hard-deny tool list.
{{/if}}
{{#if permissionPathsEnabled}}
  - `allowPaths`: Files or directories this spawn may access; prefer exact paths.
  - `denyPaths`: Files or directories this spawn must not access.
{{/if}}
{{/if}}
<permission-scoping>
Mode: {{permissionMode}}. Profiles are guardrails, not a security sandbox. Do not ask subagents to bypass them with bash/eval. If work needs access outside scope, the subagent should report the missing permission.

In enforce mode, select at least one permission profile that defines `tools`, or specify `permissions.tools` explicitly. Modifier-only profiles add restrictions and do not grant tools. Path allows and denies accumulate; denies win. When both a `toolProfile` and permissions apply, the effective tool set is their intersection.
</permission-scoping>

<permission-profiles>
{{#list permissionProfiles join="\n"}}
# {{name}}
{{description}}
Use when: {{useWhen}}
Tools: {{toolsSummary}}
Paths: {{pathsSummary}}
Source: {{source}}
{{/list}}
{{#if permissionProfileErrors}}
Profile config errors: {{permissionProfileErrors}}
{{/if}}
</permission-profiles>


# Communication
Subagents start blank — no conversation history.{{#if ircEnabled}} Parent-to-subagent messages are delivered immediately as steering.{{/if}}
Pass large payloads via `local://<path>` URIs, NEVER inline text.

# Format Contracts
{{#if batchEnabled}}
<context-fmt>
# Goal         ← one sentence: what the batch accomplishes
# Constraints  ← MUST/NEVER rules and session decisions
# Contract     ← exact types/signatures if tasks share an interface
</context-fmt>
{{/if}}

`task` format:
# Target       ← exact files and symbols; explicit non-goals
{{#if permissionsEnabled}}# Permissions  ← selected profiles, allowed paths, denied paths, special tool grants{{/if}}
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Pick the most specific agent; use default worker only when no specialist fits.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY){{/if}}{{#if blocking}} (BLOCKING: inline result){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation; do edits yourself or assign to a writing agent.{{/if}}
{{/list}}
{{/if}}
