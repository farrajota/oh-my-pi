{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout` only when files are unknown.{{/if}} Prefer one agent to investigate + edit. Omit `agent` when the spawn-policy default is the best fit (`{{defaultAgent}}`); NEVER specify the default explicitly. Check the available agents below before choosing a specialist. User-tagged model agents such as `m<N>` are not specialists; use one only when the user names it.
Name one integration owner. Shared edits are not guaranteed to merge in the same file; coordinate through `write agent://<id>` before editing shared files{{#if ircEnabled}} (or broadcast to `agent://all`){{/if}}. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`).
    Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`). Use it only when that agent fits the task.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
    NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
  - `solutionSpace`: Describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if modelEnabled}}  - `model`: Available only when `task.allowModelOverride` is enabled. Pass one non-empty request-local selector for this item (for example, `pi/taskpro`), never a comma-separated fallback chain. It overrides `task.agentModelOverrides`, agent frontmatter, and the parent model for this invocation only. Resolution is exact: no parent-auth fallback, configured runtime fallback chain, or prewalk handoff. Approval/call output shows the requested selector; progress/results show requested and resolved models.
{{/if}}
  - `agentSource`: Optional exact source pin: `bundled`, `user`, or `project`.
  - `agentDefinitionSha256`: Optional lowercase SHA-256 pin for the exact file-backed agent definition bytes. A pin mismatch blocks before launch.
{{#if evalToolsEnabled}}  - `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.
{{/if}}
{{#if effortEnabled}}  - `effort`: Scale w/ how open-ended this task's problem is: `"lo"`|`"med"`|`"hi"`
{{/if}}
  - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
  - `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
  - `isolated`: Run in a dedicated worktree; successful changes are automatically applied to the parent checkout.
{{else}}
  - `isolated`: Run in a dedicated worktree; changes are retained as patch or branch artifacts without modifying the parent checkout.
{{/if}}
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`).
  Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`). Use it only when that agent fits the task.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
  NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `solutionSpace`: Describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if modelEnabled}}- `model`: Available only when `task.allowModelOverride` is enabled. Pass one non-empty request-local selector (for example, `pi/taskpro`), never a comma-separated fallback chain. It overrides `task.agentModelOverrides`, agent frontmatter, and the parent model for this invocation only. Resolution is exact: no parent-auth fallback, configured runtime fallback chain, or prewalk handoff. Approval/call output shows the requested selector; progress/results show requested and resolved models.
{{/if}}
- `agentSource`: Optional exact source pin: `bundled`, `user`, or `project`.
- `agentDefinitionSha256`: Optional lowercase SHA-256 pin for the exact file-backed agent definition bytes. A pin mismatch blocks before launch.
{{#if evalToolsEnabled}}- `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.
{{/if}}
{{#if effortEnabled}}- `effort`: Scale w/ how open-ended this task's problem is: `"lo"`|`"med"`|`"hi"`
{{/if}}
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
- `isolated`: Run in a dedicated worktree; successful changes are automatically applied to the parent checkout.
{{else}}
- `isolated`: Run in a dedicated worktree; changes are retained as patch or branch artifacts without modifying the parent checkout.
{{/if}}
{{/if}}
{{/if}}
- `toolProfile`: Optional least-privilege tool shorthand: `none`, `inspect`, `review`, `edit`, `plan`, `web-research`, or `vision`. Profiles can only restrict an agent's tools.
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
Pick the most specific agent. Omit `agent` only when the spawn-policy default is that agent.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY){{/if}}{{#if blocking}} (BLOCKING: inline result){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation; do edits yourself or assign to a writing agent.{{/if}}
{{/list}}
{{/if}}
