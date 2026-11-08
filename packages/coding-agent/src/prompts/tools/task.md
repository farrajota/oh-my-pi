{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}{{#ifAny structured hasStructuredAgents}}

# Results
{{#if structured}}`outputSchema`{{else}}STRUCTURED agents'{{/if}} parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/ifAny}}

{{asyncGuidance}}
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout` only when files unknown.{{/if}} Prefer one agent to investigate + edit. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
{{#if batchEnabled}}Specialist `agent` selectors belong inside each `tasks[]` item; NEVER put `agent` at the top level.
{{/if}}
Shared edits need one integration owner; give each task its files. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Inputs
{{#if file}}`taskFile`: absolute path or `local://` file; contents become the task, read once at dispatch. Exactly one of `task`/`taskFile`.
{{/if}}
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name.{{#if structured}} `outputSchema` overrides agent/session schemas.{{/if}}
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if seanceGuidance}}{{seanceGuidance}}{{/if}}
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}{{#if perCallModelEnabled}}`model`: one exact `provider/model-id[@upstream][:level]` string for this spawn only{{#if batchEnabled}}; per `tasks[]` item{{/if}}. `@upstream` pins an aggregator route and is part of the model identity. Only operator-approved models; no roles, arrays, globs or partial IDs. Approved: {{#list perCallModelAdvertisement.roles join=", "}}{{#list patterns join=", "}}`{{this}}`{{/list}} ({{role}}){{/list}}{{#if perCallModelAdvertisement.roles.length}}; {{/if}}{{#if perCallModelAdvertisement.parentModelWithheld}}{{else}}your own current model; {{/if}}the selected bundled/user agent's own configured model. A listed glob approves matching exact IDs; write the exact ID, NEVER the glob.{{#if perCallModelAdvertisement.allowlist.length}} Allowlist: {{#list perCallModelAdvertisement.allowlist join=", "}}`{{this}}`{{/list}} (must also be approved).{{/if}} An agent's `task.agentModelOverrides` entry or user-chosen effort conflicts with `model`. Omit unless needed. Requested model unavailable → stop and report; NEVER substitute another. Every request requires an approved model; retry fallback, context promotion and prewalk are off.
{{/if}}{{#if structured}}`schemaMode`: default permissive warns after retries; strict fails.
{{/if}}{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.
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

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`{{#if file}} or the contents of `taskFile`{{/if}}: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}{{#if structured}} (STRUCTURED; schema result){{/if}}: {{description}}
{{/list}}{{/if}}
