{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.{{else}}Delegate work to ONE background subagent per call.{{/if}}
Execution does not block your turn: you receive agent and job IDs immediately, and the final results deliver themselves when the subagents finish.{{#if hasBlockingAgents}}
Exception: agents marked BLOCKING below run inline — their results return in this call, while non-blocking items in the same batch still spawn as background jobs.{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch.{{else}}Run ONE subagent synchronously per call.{{/if}}
Execution blocks your turn: the call only returns once the work is completely finished.{{/if}}

# Task Design
- **Agent typing:** Choose each item's `agent` type first. Read-only research MUST use `agent: "scout"`, which runs on a faster model. Use the default worker only when no listed specialist fits.
- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. You will run those once at the end.
- **One-pass agents:** Prefer agents that investigate **and** edit in a single pass; only spin a read-only discovery step (e.g. `agent: "scout"`) when the affected files are genuinely unknown.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type running this item (e.g. `scout`, `reviewer`). Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
{{#if isolationEnabled}}
  - `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. `scout`, `reviewer`). Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — NEVER pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
{{#if isolationEnabled}}
- `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{/if}}

# Context and Communication
Subagents start blank. They have no access to your conversation history.
{{#if ircEnabled}}- **Steering delivery:** Parent-to-subagent IRC is delivered immediately as steering; subagents blocked in `job poll` / `irc wait` do not need to poll separately for it.{{/if}}
{{#if batchEnabled}}
- Pass large payloads using `local://<path>` URIs, NEVER inline text.
{{else}}
- Write shared project state ONCE to a `local://` file (e.g., `local://ctx.md`) and reference that URL in each `task`.
{{/if}}

# Format Contracts
{{#if batchEnabled}}
- `context`: shared background prepended to every assignment — goal, constraints, shared contract (see context-fmt); REQUIRED, session-specific only
- `tasks`: tasks to spawn — one subagent per item, all in parallel:
  - `assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
  - `id`: stable agent id, CamelCase, ≤32 chars; generated when omitted
  - `description`: UI label only — subagent never sees it
  - `role`: specialist identity this subagent embodies (e.g. "Auth-flow security reviewer") — sets its system-prompt persona and roster display name; tailor every spawn rather than cloning a generic worker
  - `toolProfile`: optional least-privilege tool profile. Allowed values: `none`, `inspect`, `review`, `edit`, `plan`, `web-research`, `vision`. Meanings: `none=[]`; `inspect=read/search/find`; `review=read/search/find/ast_grep`; `edit=read/search/find/ast_grep/edit/write`; `plan=read/search/find/lsp/web_search`; `web-research=web_search/read`; `vision=read/inspect_image`.
{{#if isolationEnabled}}
  - `isolated`: run this spawn in an isolated env; returns patches. Isolated agents are torn down at completion — not addressable afterwards
{{/if}}
{{#if permissionsEnabled}}
  - `permissions`: least-privilege guardrails for this spawn. Prefer profiles; add inline path/tool overrides only when needed:
    When both toolProfile and permissions are supplied, the effective tool set is the intersection; permissions never widen toolProfile.
    - `profiles`: permission profile names. Combine multiple profiles when the task needs each capability.
{{#if permissionToolsEnabled}}
    - `tools`: optional one-off explicit tool allowlist.
    - `denyTools`: optional extra hard deny for modifier profiles or overrides; not the normal way to shape a role.
{{/if}}
{{#if permissionPathsEnabled}}
    - `allowPaths`: files/directories this spawn may access. Prefer explicit files and narrow directories.
    - `denyPaths`: files/directories this spawn must not access.
{{/if}}
{{/if}}
{{else}}
- `id`: stable agent id, CamelCase, ≤32 chars; generated when omitted
- `description`: UI label only — subagent never sees it
- `role`: specialist identity this subagent embodies (e.g. "Auth-flow security reviewer") — sets its system-prompt persona and roster display name; tailor every spawn rather than cloning a generic worker
- `assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
- `toolProfile`: optional least-privilege tool profile. Allowed values: `none`, `inspect`, `review`, `edit`, `plan`, `web-research`, `vision`. Meanings: `none=[]`; `inspect=read/search/find`; `review=read/search/find/ast_grep`; `edit=read/search/find/ast_grep/edit/write`; `plan=read/search/find/lsp/web_search`; `web-research=web_search/read`; `vision=read/inspect_image`.
{{#if isolationEnabled}}
- `isolated`: run in isolated env; returns patches. Isolated agents are torn down at completion — not addressable afterwards
{{/if}}
{{#if permissionsEnabled}}
- `permissions`: least-privilege guardrails for this spawn. Prefer profiles; add inline path/tool overrides only when needed:
  When both toolProfile and permissions are supplied, the effective tool set is the intersection; permissions never widen toolProfile.
  - `profiles`: permission profile names. Combine multiple profiles when the task needs each capability.
{{#if permissionToolsEnabled}}
  - `tools`: optional one-off explicit tool allowlist.
  - `denyTools`: optional extra hard deny for modifier profiles or overrides; not the normal way to shape a role.
{{/if}}
{{#if permissionPathsEnabled}}
  - `allowPaths`: files/directories this spawn may access. Prefer explicit files and narrow directories.
  - `denyPaths`: files/directories this spawn must not access.
{{/if}}
{{/if}}
{{/if}}
</parameters>

{{#if permissionsEnabled}}
<permission-scoping>
Before every spawn, choose a least-privilege permission envelope:
1. Choose `role` for expertise.
2. Choose at least one role permission profile that defines `tools`, or set `permissions.tools` explicitly.
3. Add modifier profiles such as `no-network`, `no-delegation`, or `secrets-blind` only alongside a role profile or explicit `permissions.tools`.
{{#if permissionPathsEnabled}}4. Add `permissions.allowPaths` for exact files/directories when the target is known, especially for edit/write/bash-capable agents, and `permissions.denyPaths` for known off-limits areas.{{/if}}
{{#if permissionToolsEnabled}}5. Add `permissions.denyTools` only for extra hard-deny constraints.{{/if}}

Mode: {{permissionMode}}. Profiles are guardrails, not a security sandbox. Do not ask subagents to bypass them with bash/eval. If the work needs access outside scope, the subagent should report the missing permission.

Tool allowlists are additive, but enforce mode requires a concrete allowlist from a role profile, inline permissions.tools, or an inherited parent allowlist. Modifier-only profiles add restrictions and do not grant tools. Path allows are additive, path denies are additive, and denied tools/paths win over allows. The global baseline permissions extension always applies and cannot be relaxed by a spawn profile.
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
{{/if}}

<rules>
- **Maximize fan-out.** Issue the widest {{#if batchEnabled}}`tasks[]` batch{{else}}set of parallel `task` calls{{/if}} the work decomposes into. NEVER serialize work that could run concurrently.
- **Subagents do not verify, lint, or format.** Every assignment MUST instruct the subagent to skip all gates, formatters, and project-wide build/test/lint. You run them once at the end across the union of changed files.
- No globs, no "update all", no package-wide scope. Fan out.
- **Tailor every spawn with a `role`.** A role naming the specialist (e.g. "Parser edge-case tester", "SSE backpressure specialist") makes a sharper agent than a bare generic `task`/`quick_task` worker; decompose into named specialists, never clones of one generic worker. A role-less generic spawn is the exception.
- NEVER slow down or serialize because tasks might overlap on some files. Agents resolve collisions among themselves in real time.
- Subagents have no conversation history. Every fact, file path, and direction they need MUST be explicit in {{#if batchEnabled}}`context` or the item's `assignment`{{else}}the `assignment`{{/if}}.
{{#if batchEnabled}}
- **Shared background** lives in `context` once — never duplicated across assignments. Pass large payloads via `local://<path>` URIs, not inline.
{{else}}
- **Shared background**: write it ONCE to a `local://` file (e.g. `local://ctx.md`) and reference that path in each assignment. Pass large payloads via `local://<path>` URIs, not inline.
{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin a read-only discovery step when affected files are genuinely unknown.
- **Read-only agents**: Agents tagged READ-ONLY (e.g. `explore`) have no edit/write/command tools. NEVER hand them an assignment that requires changing files or running commands. Use them to investigate and report back; do the edits yourself or delegate to a writing agent (`task`, `oracle`, `designer`).
- **No reasoning offload**: NEVER offload reasoning, analysis, design, or decision-making to `quick_task` or `explore` — they run minimal-effort / small models for mechanical lookups and data collection only. Keep judgment and synthesis in your own context; delegate hard thinking to `task`, `plan`, or `oracle`.
</rules>

<parallelization>
{{#if ircEnabled}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B — **unless** B can reasonably ask A for the missing piece over `irc`. Live coordination beats a serial waterfall when the contract is small and easy to describe in a DM.
Still sequence when one task produces a large, evolving contract (generated types, schema migration, core module API) the other consumes wholesale — IRC round-trips do not replace a finished artifact.
Parallel when tasks touch disjoint files, are independent refactors/tests, or only need occasional clarification that can be resolved peer-to-peer.
{{else}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B.
Sequential when one task produces a contract (types, API, schema, core module) the other consumes.
Parallel when tasks touch disjoint files or are independent refactors/tests.
{{/if}}
{{#if ircEnabled}}Sequenced follow-ups SHOULD message the agent that produced the prerequisite — it already holds the context.{{/if}}
</parallelization>

{{#if batchEnabled}}
<context-fmt>
# Goal         ← one sentence: what the batch accomplishes
# Constraints  ← MUST/NEVER rules and session decisions
# Contract     ← exact types/signatures if tasks share an interface
</context-fmt>
{{/if}}

The `task` field MUST follow this format:
# Target       ← exact files and symbols; explicit non-goals
{{#if permissionsEnabled}}# Permissions  ← selected profiles, allowed paths, denied paths, special tool grants{{/if}}
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Pick the most specific agent for each task. Use the default worker only when no specialist below fits.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY: no edit/write/command tools){{/if}}{{#if blocking}} (BLOCKING: runs inline; its result returns in this call){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation and reporting; do the edits yourself or assign them to a writing agent.{{/if}}
{{/list}}
{{/if}}
