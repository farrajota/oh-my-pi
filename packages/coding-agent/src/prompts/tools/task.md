{{#if asyncEnabled}}
{{#if batchEnabled}}
Spawn `tasks[]` concurrently; IDs return immediately.
{{else}}
Spawn one agent; ID returns immediately.
{{/if}}
{{#if hasBlockingAgents}}
BLOCKING agents return inline.
{{/if}}
{{else}}
{{#if batchEnabled}}
Run `tasks[]` synchronously.
{{else}}
Run one agent synchronously.
{{/if}}
{{/if}}
{{#if asyncEnabled}}
{{#ifAny structured hasStructuredAgents}}

# Results
{{#if structured}}`outputSchema`{{else}}STRUCTURED agents'{{/if}} parsed payload, even invalid: agent://<id> (field /<field>, nested /reports/0/data); invalid preview inline.
{{/ifAny}}

{{asyncGuidance}}
{{/if}}

# Inputs
- `agent`: most specific{{#if batchEnabled}}, inside each `tasks[]` item, NEVER at the top level{{/if}}.
  - Omit only for the default (`{{defaultAgent}}`); NEVER name it.
{{#if scoutAvailable}}
  - Read-only research MUST use `scout` only when files unknown.
{{/if}}
  - Prefer one agent to investigate + edit.
{{#if batchEnabled}}
- `context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}
{{#if steps}}
- `steps`: ordered stages for one agent; each is sent only after it finishes the previous one, and the last stage's result is returned.
  - First step carries `# Target` files/non-goals{{#if batchEnabled}} beyond `context`{{/if}}.
  - Each step: one `# Change` stage.
  - Last step adds `# Acceptance` observable result.
  - Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via local://<path>, NEVER inline.
  - Independent work → separate tasks.
{{else}}
- `task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).
  - Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via local://<path>, NEVER inline.
{{/if}}
- `name`: CamelCase ≤32, auto-generated if omitted; address agent by name.{{#if structured}} `outputSchema` overrides agent/session schemas.{{/if}}
- `solutionSpace`: how open-ended the child's problem is: fix or design given, or which causes or designs remain open.
  - Volume of work does not widen it; NEVER mention sibling agents or coordination.
  - Examples: `one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`;
    `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`
{{#if evalToolsEnabled}}
- `tools`: eval-defined, run in your kernel.
{{/if}}
{{#if effortEnabled}}
- `effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}
{{#if perCallModelEnabled}}
- `model`: one exact `provider/model-id[@upstream][:level]` string for this spawn only{{#if batchEnabled}}; per `tasks[]` item{{/if}}.
  - `@upstream` pins an aggregator route and is part of the model identity.
  - Only operator-approved models; no roles, arrays, globs or partial IDs.
  - Approved:
{{#each perCallModelAdvertisement.roles}}
    - {{#list patterns join=", "}}`{{this}}`{{/list}} ({{role}})
{{/each}}
{{#unless perCallModelAdvertisement.parentModelWithheld}}
    - your own current model
{{/unless}}
    - the selected bundled/user agent's own configured model
  - A listed glob approves matching exact IDs; write the exact ID, NEVER the glob.
{{#if perCallModelAdvertisement.allowlist.length}}
  - Allowlist: {{#list perCallModelAdvertisement.allowlist join=", "}}`{{this}}`{{/list}} (must also be approved).
{{/if}}
  - An agent's `task.agentModelOverrides` entry or user-chosen effort conflicts with `model`.
  - Omit unless needed.
  - Requested model unavailable → stop and report; NEVER substitute another.
  - Every request requires an approved model; retry fallback, context promotion and prewalk are off.
{{/if}}
{{#if structured}}
- `schemaMode`: default permissive warns after retries; strict fails.
{{/if}}
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
- `isolated`: worktree; successful changes apply to parent.
{{else}}
- `isolated`: worktree; changes retained, not applied.
{{/if}}
{{/if}}
{{#if permissionsEnabled}}

# Permissions
Mode `{{permissionMode}}`{{#if permissionEnforced}}: a spawn that sets `permissions` or `toolProfile` starts with only the tools its scope allows, and every call outside the scope is refused. A spawn without `permissions` or `toolProfile` is not restricted.{{else}}: advisory; the scope is recorded and shown to the child, nothing is restricted.{{/if}} Children of a scoped child inherit its scope and can only narrow it. Guardrails, not a sandbox: NEVER ask a child to work around them.
{{#if permissionToolsEnabled}}`toolProfile`: `none`|`inspect`|`review`|`edit`|`plan`|`web-research`|`vision`; narrows the agent's tools, never widens them.
{{/if}}`permissions`{{#if batchEnabled}} (per `tasks[]` item){{/if}}: `profiles` (names below){{#if permissionToolsEnabled}}, `tools` allowlist, `denyTools`{{/if}}{{#if permissionPathsEnabled}}, `allowPaths`, `denyPaths` (a plain `dir` covers its subtree; prefer exact paths){{/if}}.{{#if permissionEnforced}}{{#if permissionToolsEnabled}} Name at least one profile that grants tools, or `tools`; modifier profiles only restrict.{{/if}}{{/if}} Tool allowlists intersect; denies and path rules accumulate; a deny wins. With path rules, bash, eval, LSP, MCP and extension tools are unavailable.
<permission-profiles>
{{#list permissionProfiles join="\n"}}
# {{name}}
{{description}}
Use when: {{useWhen}}
Tools: {{toolsSummary}}
Paths: {{pathsSummary}}
Source: {{source}}
{{/list}}
</permission-profiles>
{{#if permissionProfileErrors.length}}Profile config errors: {{#list permissionProfileErrors join="; "}}{{this}}{{/list}}
{{/if}}{{#if permissionProfileWarnings.length}}Profile config warnings: {{#list permissionProfileWarnings join="; "}}{{this}}{{/list}}
{{/if}}{{/if}}

{{#if seanceGuidance}}{{seanceGuidance}}{{/if}}Shared edits need one integration owner; give each task its files{{#unless batchEnabled}} and interfaces{{/unless}}.
Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (read-only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}{{#if structured}} (STRUCTURED; schema result){{/if}}: {{description}}
{{/list}}{{/if}}
