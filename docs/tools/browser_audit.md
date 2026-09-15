# browser_audit

> Run a host-authorized, fail-closed browser audit over a bounded set of routes, views, and interactions.

## Source

- Public runtime tool and authority binding: `packages/coding-agent/src/internal/browser-audit-authority.ts`
- Audit schema, authorization validation, engine, and result model: `packages/coding-agent/src/tools/browser-audit.ts`
- Browser interception and cleanup: `packages/coding-agent/src/tools/browser-audit-production.ts`
- Tool registration: `packages/coding-agent/src/tools/index.ts`

## Availability and metadata

- Built-in, discoverable, strict-schema tool. Its immutable external name is `browser_audit`.
- It is not the general-purpose `browser` tool: the caller does not supply arbitrary URLs, JavaScript, selectors, credentials, or browser settings.
- Registration requires an explicit `browser_audit` request and a host-installed capability whose provenance matches the `browser-audit-specialist` task, spawn, parent, agent definition, and tool-call fingerprint. Without that authority the tool is unavailable.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `operation` | `"open" \| "inspect" \| "act" \| "close"` | Yes | One lifecycle operation. |
| `audit_id` | `string` | Yes | Host-issued audit identity in the `browser-audit-<16 lowercase hex digits>` form. |
| `tuple_id` | `string` | For ordinary operations when needed | Authorized route/viewport tuple in `<check>@<route>@<viewport>` form. It may be omitted only when the audit has exactly one tuple. `close` does not accept it. |
| `action_id` | `string` | `act` | Host-authorized action ID. It is valid only for `act`; `close` and other operations reject it. |

The tool input is intentionally identifier-only. Route locators, viewports, allowed origins, state assertions, action definitions, credential policy, screenshot policy, resource policy, and tuple bindings come from the trusted host authorization, not from tool arguments.

## Operations

- `open` opens the authorized document for the tuple and verifies its route and viewport state.
- `inspect` observes the authorized state for the tuple and records host-derived evidence.
- `act` performs one authorized non-navigation action, such as click, type, press, select, or scroll. The action must be allowed by the route and mutation policy; action navigation is denied.
- `close` finalizes the audit, verifies cleanup of the exact owned browser session, and makes the terminal snapshot available to the trusted host sink. It accepts only `operation` and `audit_id`.

Ordinary operations are serialized. Each authorized operation arms interception before its browser primitive and verifies the authorized route and viewport. An operation that reaches the host executor records a `PASS` or `BLOCKED` observation; early input, authorization, bound, abort, or interception-arm failures return `BLOCKED` without recording an observation. Any invalid identity, unauthorized tuple/action, failed guard, denied channel, abort, or cleanup uncertainty fails closed and invalidates the run.

## Outputs

Each call returns one text content block and structured `details`:

- `content[0].text` is the operation status: `PASS`, `BLOCKED`, or `CLOSED`.
- `details.status` has the same status.
- `details.operation_id` is present after an ordinary operation passes input and authority resolution and is assigned an operation ID; early blocked calls omit it.
- `details.evidence_ids` lists evidence identifiers accepted for that operation. A `BLOCKED` host observation may include evidence IDs; early blocked calls, bound failures that reject an append, and `close` return an empty list.

A successful `close` hands the immutable terminal snapshot to the trusted host sink. The snapshot contains dispatch and actor provenance, observations, frozen evidence, and verified cleanup; it is not supplied by the caller and is not returned as arbitrary tool input.

## Safety and resource policy

- The browser session is dedicated to the audit and is closed and cleanup-verified before a terminal snapshot can be published.
- Request interception allows only the authorized document and allow-listed origins. Redirects, unauthorized subresources, popups, workers, downloads, WebSockets, beacons, service workers, WebRTC, WebTransport, and other forbidden channels latch a violation and block the audit.
- The audit cannot navigate through `act`, and file subresources are never allowed. Tool input has no credential or screenshot fields. Authorization is accepted only with `credential_policy.mode = "deny-raw"`; the current production adapter does not otherwise consume `pre_established_state_ids`. `screenshot_policy` is validated host metadata, but the current production adapter exposes no screenshot operation and does not enforce its `max_count`, `max_bytes`, or `allowed_check_ids` fields.
- Authorized local file documents are repository-local, document-only, and SHA-256 pinned; the host serves the pinned bytes rather than rereading a mutable path.
- A blocked observation, late operation, failed cleanup, or failed snapshot handoff never yields a partial success snapshot.

## Bounds

- At most `128` ordinary operations and `128` observations are accepted per audit.
- At most `256` cumulative evidence items and `256 KiB` of frozen evidence are retained; exceeding a bound blocks and invalidates the run rather than truncating it.
- Each host observation contributes at most `64` evidence items, and evidence descriptions are bounded by the audit validator.
- An `audit_id` is single-use. After close, invalidation, or a guard violation, later operations are blocked.

## Example calls

With a host-issued tuple:

```json
{"operation":"open","audit_id":"browser-audit-0123456789abcdef","tuple_id":"check@route@viewport"}
```

Inspect the same authorized state:

```json
{"operation":"inspect","audit_id":"browser-audit-0123456789abcdef","tuple_id":"check@route@viewport"}
```

Run a host-authorized interaction, then close:

```json
{"operation":"act","audit_id":"browser-audit-0123456789abcdef","tuple_id":"check@route@viewport","action_id":"click"}
```

```json
{"operation":"close","audit_id":"browser-audit-0123456789abcdef"}
```
