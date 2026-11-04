# Session Operations: export, dump, share, fresh, clear, fork, resume/continue

This document describes operator-visible behavior for session export, sharing, conversation reset, lifecycle, fork, and resume operations as currently implemented.

## Implementation files

- [`src/slash-commands/builtin-collaboration.ts`](../packages/coding-agent/src/slash-commands/builtin-collaboration.ts) — export/dump/share command specs
- [`src/slash-commands/builtin-lifecycle.ts`](../packages/coding-agent/src/slash-commands/builtin-lifecycle.ts) — lifecycle command specs
- [`src/slash-commands/seance.ts`](../packages/coding-agent/src/slash-commands/seance.ts) — `/seance` command and session-picker adapter
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — TUI execution
- [`src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts) — resume/import picker and cwd transition
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`src/export/share.ts`](../packages/coding-agent/src/export/share.ts)
- [`src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`src/cli/flag-tables.ts`](../packages/coding-agent/src/cli/flag-tables.ts) — restart argument rewriting
- [`src/main.ts`](../packages/coding-agent/src/main.ts)

## Operation matrix

| Operation                               | Entry path                   | Session mutation                              | Session file creation/switch                                                               | Output artifact                                                                     |
| --------------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/dump [all]`                           | Slash command (TUI/headless) | No                                            | No                                                                                         | Clipboard/command text plus best-effort temporary JSON sidecar; `all`: temp zip    |
| `/export [--themes] [path]`             | Slash command (TUI/headless) | No                                            | No                                                                                         | HTML file                                                                           |
| `--export <session.jsonl> [outputPath]` | CLI startup fast-path        | No runtime session mutation                   | No active session; reads target file                                                       | HTML file                                                                           |
| `/share`                                | Slash command (TUI/headless) | No                                            | No                                                                                         | Encrypted share link (gist or share server); temp HTML only for TUI custom handlers |
| `/new`                                  | Interactive slash command    | Yes (starts an empty conversation)            | Switches identity and materializes a new header in persistent mode                         | None                                                                                |
| `/fresh`                                | Slash command (TUI/headless) | Yes (provider-facing in-memory id/state only) | No; keeps current session file/header                                                      | None                                                                                |
| `/clear`                                | Interactive slash command    | Yes (clears live/model conversation context)  | Retains identity/file/history; a lazy session still follows the normal persistence gate    | Appends `reset_boundary`                                                            |
| `/delete`                               | Interactive slash command    | Yes (starts an empty conversation)            | Attempts to delete the current persisted session and artifacts, then switches to a lazy successor (no empty file until content) | None                                                                                |
| `/fork`                                 | Interactive slash command    | Yes (active session identity changes)         | Creates new session file and switches current session to it (persistent mode only)         | Copies artifact directory to new session namespace when present                     |
| `/fork pane`, `/fork window`, `/fork tab` | Interactive slash command  | No (parent session retained)                   | Opens a child OMP process from the flushed current transcript in a multiplexer pane/group (tmux window, Zellij/Herdr/Orca tab, or CMUX workspace) | Child receives a separate forked session                                            |
| `--fork <id\|path>`                     | CLI startup                  | Yes after session creation                    | Creates a new session fork from the selected source into current cwd/session dir           | Copies source artifacts recursively by default                                      |
| `/seance [id\|path] [--model sel]`      | Interactive slash command    | No (active session and model unchanged)       | Forks the source transcript into a read-only consultant subagent under the current session  | None; the consultant reads the source's artifacts in place                          |
| `/resume [id\|@claude\|@codex]`         | Interactive slash command    | Yes (active in-memory state replaced)         | Switches to a selected/matched session, or imports a selected foreign session              | None                                                                                |
| `--resume`                              | CLI startup picker           | Yes after session creation                    | Opens selected existing session file (picker opens in current-folder scope; the global list is preloaded only for the empty-everything early exit and instant Tab switching) | None                |
| `--resume <id\|path>`                   | CLI startup                  | Yes after session creation                    | Opens existing session; a missing recorded cwd may be re-rooted into the current directory | None                                                                                |
| `/restart`                              | Interactive slash command    | Yes (process relaunches)                      | Keeps configuration flags; resumes a materialized session, otherwise starts fresh          | None                                                                                |
| `--continue`                            | CLI startup                  | Yes after session creation                    | Opens terminal breadcrumb or most-recent session; creates new one if none exists           | None                                                                                |
| `omp session repair <session-id-or-path> [--apply]` | CLI command | Dry-run is read-only; legacy apply appends verified terminal-ancestor closures; selected format-2 repair is integrity/export inspection only | No transcript switch or provider mutation; legacy apply requires the owning client to be stopped | Diagnosis; legacy repair may retain a backup and report a fresh-process resume command |

## Export and dump

### `/export [--themes] [outputPath]` (slash command)

Flow:

1. The collaboration command spec (`src/slash-commands/builtin-collaboration.ts`) parses headless arguments with `parseExportArgs`; the TUI delegates to `CommandController.handleExportCommand`, which uses the same parser.
2. `--themes` selects the configured dark/light TUI themes instead of the standalone web palette. After removing that flag, at most one whitespace-delimited path is accepted; extra tokens produce `Usage: /export [--themes] [path]`.
3. `AgentSession.exportToHtml()` calls `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`.
4. The TUI shows the path and opens the file in a browser. Headless command execution prints the path without opening it.

In the TUI, `/export` targets `viewSession`: a focused subagent exports its own
transcript and descendants, not the main session. `/dump` and `/share` still
target the main session.

Behavior details:

- `--copy`, `clipboard`, and `copy` arguments are explicitly rejected with a warning to use `/dump`.
- Export embeds session header/entries/leaf plus current `systemPrompt` and tool descriptions from agent state. `previousSessionFiles` is omitted from exported headers.
- Subagent transcripts stored next to the session file (`<session>/<AgentId>.jsonl`, recursively for nested spawns) are embedded as `subSessions` (`collectSubSessions` in `src/session/sub-sessions.ts`; disable with `includeSubSessions: false` in `ExportOptions`). Discovery skips advisor transcripts (`__advisor*.jsonl`), descends only into real child directories, and flags tombstoned (killed) agents as `aborted`. In the page, agent ids in task tool cards open a breadcrumbed sub-session overlay.
- Tool calls render through the `<omp-tool-view>` web component — the React per-tool renderers shared with collab-web (`packages/collab-web/src/tool-render/`), prebuilt into `src/export/html/tool-views.generated.js` by `bun run gen:tool-views`.
- No session entries are appended during export.
- The default filename is `omp-session-<session-file-stem>.html` in the current directory. HTML export is not secret-redacted or encrypted; it can contain raw context, image data, and extension payloads.

Caveat:

- Parsing is whitespace-based, so quoted paths with spaces are not preserved. Use a path without spaces.

### `--export <inputSessionFile> [outputPath]` (CLI)

Flow in `main.ts`:

1. Handled early (before interactive/session startup).
2. Calls `exportFromFile(inputPath, outputPath?)`.
3. `SessionManager.open(inputPath, ..., { suppressBreadcrumb: true, throwIfMissing: true })` loads entries, then HTML is generated and written.
4. Process prints `Exported to: ...` and exits.

Behavior details:

- Missing input file surfaces as `File not found: <path>`; empty/malformed-header files fail without creating or replacing the input.
- This path does not create an `AgentSession`, update terminal breadcrumbs, or mutate any running session.
- Standalone export has no live agent state, so it does not add current system-prompt/tool descriptions. It embeds the loaded entries and subagent transcripts.

### `/dump` (clipboard/headless text export)

Flow:

1. The command calls `session.formatSessionAsText()`.
2. If it returns an empty string, the command reports `No messages to dump yet.`
3. Otherwise it also attempts `session.dumpLlmRequestToTmpDir()` and appends the resulting path to the transcript. The TUI copies the combined text to the clipboard; headless/ACP command execution returns it as command output.

Dump uses the live agent message array, not every branch or every historical
JSONL entry. After `/clear` or compaction it reflects the current live context;
use HTML export for the persisted conversation graph.

Dump transcript content includes:

- System prompt
- Active model/thinking level
- Tool definitions + parameters
- User/developer/assistant messages
- Thinking blocks and tool calls
- Tool results and execution blocks (except `excludeFromContext` bash/python entries)
- Custom/hook/file mention/branch summary/compaction summary entries

The best-effort JSON sidecar is named `omp-llm-request-<id>.json` under the OS temporary directory. It contains the current model, thinking level, service tier, system prompt, wire tool schemas, and LLM-converted messages. It persists after the command and can contain raw context or secrets; protect or remove it accordingly. A sidecar failure does not suppress the transcript (the TUI reports the failure; headless execution silently omits the path).

No session persistence entries are appended by dumping.

### `/dump all` (zip of per-agent dumps)

`/dump all` calls `session.dumpSessionArchiveToTmpDir()`, which writes
`omp-dump-<id>.zip` under the OS temporary directory with:

- `session.md` — the same main transcript `/dump` copies
- `llm-request.json` — the same payload as the `/dump` sidecar (best-effort; omitted if conversion fails)
- `subagents/<path>.md` — one file per persisted subagent found by `collectSubSessions` (e.g. `subagents/Scout.md`, `subagents/Scout/Helper.md`), headed `# Subagent: <path>` with the persisted model, thinking level, `Status: aborted` for killed agents, and the messages on the subagent's last-entry branch, deobfuscated like the main session

Subagent system prompts and tool inventories are not persisted, so subagent files omit them. Subagents with no messages are skipped. If subagent discovery fails, the archive still holds the main dump and the report says why subagents are missing. The TUI copies the archive path to the clipboard and lists its members; headless/ACP returns the same report as command output. Like the sidecar, the archive persists and can contain raw context or secrets.

## Share

`/share` publishes an end-to-end encrypted snapshot of the session and prints
a viewer link. Implementation: [`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts).

### TUI phase 1: custom share handler (if present)

The interactive TUI's `loadCustomShare()` checks the active agent directory
(default `~/.omp/agent`) for the first existing candidate:

- `share.ts`
- `share.js`
- `share.mjs`

Requirements:

- Module must default-export a function `(htmlPath) => Promise<CustomShareResult | string | undefined>`.

If present and valid, the legacy contract is preserved: the session is
exported to a temp HTML file (`${os.tmpdir()}/${Snowflake.next()}.html`),
the handler receives its path, and the temp file is removed afterwards.
Handler result interpretation:

- string => treated as URL, shown and opened
- object => `url` and/or `message` shown; `url` opened
- `undefined`/falsy => generic `Session shared`

Critical fallback behavior:

- If custom handler exists but loading fails, command errors and returns.
- If custom handler executes and throws, command errors and returns.
- In both failure cases, it **does not** fall back to the default flow.
- The default flow runs only when no custom share script exists.
- Headless/ACP slash-command execution does not load custom share scripts; it always uses the default encrypted flow.

Custom handlers receive ordinary HTML export, not the default redacted/encrypted
snapshot. Their publishing, encryption, and privacy policy are entirely their
own. The HTML-export contract also means a custom handler cannot share an
in-memory session through this path.

### Default encrypted share

For headless execution, or in the TUI only when no custom share handler is found, `shareSession()`:

1. Builds the main-session snapshot (`header`, `entries`, `leafId`, plus current
   `systemPrompt` and tool descriptions from agent state), omitting header
   `previousSessionFiles`. Unlike HTML export, this flow does not collect
   subagent transcript files.
2. If `share.redactSecrets` is enabled (default) and the obfuscator has configured or regex-discovered secrets, a typed per-field redaction pass rewrites text-bearing header, prompt, tool, entry, sub-session, and message fields. Inline image bytes remain for the later size pass. Opaque provider replay fields and untyped extension payloads (`details`, `data`, `outputSchema`, compaction preserve data) are dropped rather than traversed.
3. The JSON is gzipped and sealed with a fresh AES-256-GCM key
   (`[12B IV][ciphertext+tag]`).
4. Upload target is chosen by `share.store`:
   - **Share server** (default, `store: "blob"`) — `POST <share.serverUrl>`
     (default `https://my.omp.sh/s`) with the raw blob, capped at 1 MB.
     Oversized snapshots are trimmed until they fit: inline images first,
     then long strings (32,768 → 8,192 → 2,048 → 512 character caps), then
     oldest entries. If the reduced snapshot still exceeds the budget, sharing
     fails rather than uploading an oversized blob.
   - **Secret gist** (`store: "gist"`) — when `gh` is installed and
     authenticated, the sealed blob is pushed base64-encoded as
     `session.ompshare.txt` (budget 5 MB sealed; gist raw fetches cap at
     10 MB), falling back to the share server when `gh` is unusable or gist
     creation fails.
5. The link is `<share.serverUrl>/<id>#<base64url key>` in both cases. The
   viewer page served there fetches the blob (hex ids via the GitHub gist
   API, anything else from the server's blob store) and decrypts it
   client-side; the key lives only in the URL fragment and never appears in
   any HTTP request.

The UI reports the share URL (plus the underlying gist URL and a truncation
note when applicable). Headless `/share` prints the same lines. Unlike
`/export`, `/share` works for in-memory (`--no-session`) sessions: the
snapshot is built from live entries, no session file required.

Cancellation/abort semantics in share:

- Loader has `onAbort` hook that restores editor UI and reports `Share cancelled`.
- The upload itself is not aborted mid-flight; cancellation is UI-level and
  checked after the upload returns.

## New and delete

Interactive `/new` starts a new conversation identity. The TUI first aborts any
active compaction; `AgentSession.newSession()` emits the cancellable
`session_before_switch` event, aborts the old run, cancels owned async jobs,
closes provider state, and drains outgoing writes/advisor recorders. Persistent
`SessionManager.newSession()` writes the new header before returning, even
before the first assistant response.

The new session keeps the current model/settings and configured thinking
selector, but clears conversation/queues, todo/checkpoint/tool state, inherited
cache identity, advisor spend, and promoted memory context. Workspace roots are
seeded from current settings, and project instructions are refreshed from disk.
The TUI leaves a focused subagent view and clears its transcript.

`/delete` uses the same transition with `drop: true`. It requires a session-file
path, attempts to delete the old JSONL and artifact tree instead of retaining
them, and still starts a new session if deletion fails. Unlike `/new`, that
successor is lazy: no header is written until it has content, so quitting
without a message leaves no zero-turn session behind. A before-switch hook can
cancel either operation. Both are rejected while vibe mode is active.

## Fresh

`/fresh` (TUI/headless) resets the provider-facing stream state of the current
session **without touching the local transcript, session file, or header**. Use
it to recover from a wedged or corrupted provider stream (stale prompt cache,
a mid-turn glitch, or a server-side conversation id that has drifted) while
keeping the conversation you can see.

`AgentSession.freshSession()`:

- Is rejected while the agent is streaming — wait for the response to finish or
  abort it first.
- Closes every cached provider-session state entry (server-side conversation /
  prompt-cache handles) and reports how many were pruned.
- Mints a fresh provider session id, re-keys memory state, and invalidates the
  append-only context so the next turn rebuilds from the local conversation.
- Leaves the local transcript, session file, and OMP session-manager identity
  unchanged; the provider-facing `AgentSession.sessionId` changes.

Because it keeps both the visible and model-facing conversation, `/fresh`
differs from `/clear` (clear the live/model conversation in place), `/new`
(start a brand-new empty session), and `/delete` (attempt to delete the current
session and start a new one). Only `/fresh` preserves the existing conversation
while giving the provider stream state a clean slate.

## Clear

Interactive `/clear` clears the current conversation context in place. It is
available only in the TUI and is rejected while a response is streaming or a
foreground bash/Python execution is running. If compaction is active, the
command aborts it and waits for it to stop before resetting.

`AgentSession.resetSessionContext()`:

- Drops live messages, queued steer/follow-up turns, pending tool calls, error
  state, checkpoint/rewind and deferred tool state, and session-stop
  continuation state. It also cancels this agent's queued continuation work and
  async bash/task jobs.
- Rotates provider-side session state, re-primes advisors, invalidates
  append-only model context, and resets memory promotion so the next turn
  rebuilds from the base system prompt and current project instructions.
- Retains the session id, title, cwd, model, settings, active plan path, and
  transcript file.
- Appends `reset_boundary` through the normal persistence pipeline. For an
  already materialized session it is durable; an in-memory or still-lazy
  session retains the marker in memory. The collapsed live transcript and
  rebuilt model context begin after the latest boundary, while persisted JSONL
  and full-transcript export retain the pre-reset history.

The TUI clears its rendered transcript after a successful clear. This differs
from `/fresh`, which rotates provider stream state without clearing the
conversation; `/new`, which creates a new session identity and transcript file;
and `/delete`, which attempts to delete the old persisted session before starting
a new one.

## BTW history

`/btw` history is stored alongside session artifacts and remains outside the main
conversation. See the [BTW command reference](slash-command-internals.md#11-built-in-command-note-btw)
for keyboard controls, follow-ups, persistence, and migration safety.

## Fork

Bare `/fork` creates a new session from the current one and switches the active
session identity. `/fork pane` opens a separate OMP process in a new pane;
`/fork window` and `/fork tab` open it in a new multiplexer group (a tmux
window, Zellij/Herdr/Orca tab, or CMUX workspace). The child starts from the current
persisted transcript, while the parent session stays active and continues
running.

Typing `/fork ` shows `[pane|window|tab]` as dim inline text, and Enter still
runs the bare in-place fork. Typing a prefix (`/fork w`) opens the suggestions
with the rest of the selected argument as dim inline text; Tab accepts it.

Placement commands autodetect tmux, Zellij, Herdr, CMUX, or Orca from the terminal;
`/fork auto` is not a subcommand (valid arguments are `pane`, `window`, and
`tab`). `window` maps to a tmux window, a Zellij/Herdr/Orca tab, or a CMUX workspace.
Plain terminals, `screen`, and `wmux` cannot host this fork placement and receive
an explicit error; use bare `/fork` there instead.

### Preconditions and immediate guards

- Bare `/fork` is rejected with a warning while the agent is streaming.
- A placement fork during streaming asks before launching. The child can omit
  the partial response, and confirming does not stop the parent response.
- Forking is rejected while vibe mode is active.
- Placement forks require an already persisted session transcript; pending
  writes are flushed before the child launches. The parent never switches
  sessions.
- A CLI `--api-key` override cannot be safely passed through a multiplexer command;
  placement forks refuse it rather than exposing the key.
- UI status/loading indicators are cleared only for the original bare `/fork`
  flow.

### Terminal placement flow

For a placement command, the controller rebuilds the child CLI command from the
current CLI entry point and restart-safe launch flags (one-shot selectors such
as `--goal` and positional prompts are dropped). It replaces stale startup
model, thinking, profile, prompt-cache-key, and working-directory flags with the
active session values; the child is pinned to the parent's prompt-cache key so
it reads the cache the parent populated. The child also receives the effective
agent/config directories, the resolved config overlays (which retain their
original paths after `/move`), and the parent's session-dir and XDG base
directories; scope variables the parent does not set are unset rather than
exported empty. It starts with `--fork` and the absolute path of the current transcript. The
generic terminal launcher handles provider-specific execution and reports
capability or launch failures in the TUI. CMUX and Orca launches require
explicit confirmation that the destination's configured interactive shell
accepts POSIX syntax; this is never inferred from the local OS or `SHELL`.
Declining confirmation stops before the session is flushed or a terminal is
launched. `window` and `tab` both map to the multiplexer group placement. The Orca
CLI is resolved in Orca's documented order (`ORCA_CLI_COMMAND`, then `orca-dev` in an
Orca development checkout, then `orca-ide` on Linux outside an Orca terminal, then
`orca`).

Orca's CLI `--command` accepts shell text, not argv, and has no `--cwd`; after
confirmation, OMP supplies `cd <quoted-cwd> && <quoted-command>` using shared
POSIX shell quoting. When Orca cannot show the new tab and starts the child in a
background terminal instead, `/fork` reports that as a warning rather than a
visible tab.

### Session-level flow

The original bare `/fork` uses `AgentSession.fork()`:

1. Emits `session_before_switch` with `reason: "fork"` (cancellable).
2. Flushes pending bash/session writes and drains/detaches advisor recorders.
3. Calls `SessionManager.fork()`, preserving the conversation and its usage attribution.
4. Copies artifacts directory from old session namespace to new namespace (best-effort; non-ENOENT copy failures are logged, not fatal).
5. Updates `agent.sessionId` and inherits the previous provider prompt-cache key unless an explicit prompt-cache key is already pinned.
6. Emits `session_switch` with `reason: "fork"`.

`SessionManager.fork()` behavior:

- Requires persistent mode and an assigned session-file path; the source need not already be materialized on disk.
- Creates new session id and new JSONL file path.
- Rewrites header with:
  - new `id`
  - new timestamp
  - `cwd` unchanged
  - `parentSession` set to previous session id
  - `providerPromptCacheKey` set to the previous header's inherited key, or the previous session id when none was pinned
- Keeps all non-header entries unchanged in the new file.

### Non-persistent behavior

- In-memory session manager returns `undefined` from `fork()`.
- `AgentSession.fork()` returns `false`.
- UI reports `Fork failed (session not persisted or cancelled)`.

### Fork at an entry (`AgentSession.fork(entryId)`, RPC `fork`)

`AgentSession.fork(entryId)` forks from a transcript point instead of the whole session. The RPC `fork` command calls it when `entryId` is given and plain `fork()` otherwise.

- Like the whole-session fork, it is rejected while vibe mode is active.
- `entryId` must be a `message` entry (user, assistant, or any other message role); anything else throws `Invalid entry ID for forking`.
- It throws `SessionBusyError` while `AgentSession.isBusyForSnapshot` is true (a response is streaming, or user bash/eval, compaction, handoff, or retry work is running). The check runs before `session_before_branch`, again after it, and once more after pending bash output and session writes flush. That last check comes before anything of the old session is discarded (pending next-turn messages, async jobs, the auto-learn capture), so a refused fork leaves the session as it was. A prompt admitted during the remaining drain awaits is dropped by the prompt-generation bump at the cut, as for `branch()`. `/btw` branches use the same predicate.
- When `entryId` sits inside an assistant tool-call batch (the assistant message, or a tool result answering it), the cut extends through the batch's recorded tool results, following the tree from `entryId` and stepping over lone non-message entries between results. A fork therefore never ends on tool calls whose results exist in the source session; calls that never got a result stay as they are.
- The transition is the one `AgentSession.branch()` uses, cut at the resolved entry rather than before it: `session_before_branch` with reason `"fork"` (cancellable; `entryId` is the last kept entry, not a dropped one as for `branch()`), `SessionManager.createBranchedSession(leafId, { copyArtifacts: true })`, rebuilt agent messages, then `session_branch` with reason `"fork"`.
- The new file keeps the root-to-entry path including the resolved entry, carries labels for kept entries, keeps the title, and sets `parentSession` to the previous session file. The whole artifact directory is copied in the background (including artifacts only cited by dropped entries), and the new session's artifact manager waits for the copy before allocating ids or resolving `artifact://`, so kept `artifact://N` references still resolve and new artifacts get fresh ids. Unlike the whole-session fork, the provider prompt-cache key is not inherited (same as `branch()`).
- Works in non-persistent mode (in-memory replacement), unlike the whole-session fork.
- `AgentSession.fork(undefined, { requireIdle: true })` applies the same idle rule to the whole-session fork (before `session_before_switch` and again after the flushes). RPC `fork` passes it for both variants, so both reject with `code: "session_busy"`. Interactive `/fork` does not, so it can still carry a running bash command into the new session.

### CLI `--fork <id|path>`

Startup `--fork` is resolved before normal session creation:

1. `--fork` is rejected with `--no-session`.
2. Path-like values (`/`, `\`, or `.jsonl`) fork directly from the given path.
3. Other values resolve via `resolveResumableSession(...)`: local sessions first, then global search when `sessionDir` is not forced. Matching accepts lowercased session id prefixes, full JSONL filename prefixes, and timestamp-stripped filename id suffixes.
4. The forked file is created in the current cwd/session-dir scope and becomes the active session manager for startup. Source artifacts are copied recursively by default. Missing source files fail instead of producing an empty fork.
   An unresolved tool call on the copied active branch is paired with an
   outcome-unknown result in the child, rather than being marked never executed.
   For a length stop, the never-executed guard is retained only when no
   execution-start marker exists. A source whose process exit was recorded
   after its last message is not repaired here: the child warns about the
   pending calls and pairs them through the normal process-exit recovery.
   The parent transcript is unchanged.
5. Full-context forks automatically seed `providerPromptCacheKey` from the source header's inherited key, falling back to the source session id. Startup drops that automatic inheritance for explicit `--model`, `--thinking`, `--system-prompt`, `--system-prompt-template`, `--append-system-prompt`, `--tools`, or `--no-tools` overrides, or an applicable scoped-model override.

Use `--prompt-cache-key <key>` to pin the provider prompt-cache identity explicitly and independently from both the OMP session id and `--provider-session-id`. `--provider-session-id` continues to control provider session/routing headers and sticky credential selection; `--prompt-cache-key` controls the OpenAI Responses `prompt_cache_key` payload where supported.

## Seance

`/seance [id|path] [--model selector]` opens a source picker when no source is supplied; an id or path (`~` expands) selects directly. Typed ids search the current project, then every project. The source is read without opening a writer and is never modified.

Each consult forks only the source transcript, into `<current session artifacts>/<ConsultId>.jsonl`, with `seanceSource` in its header. Artifacts are not copied: the consultant's `history://`, `artifact://`, and `agent://` read the source's artifacts directory in place, and its own new artifact ids are allocated past the source's so inherited `artifact://<n>` references keep naming the source artifact. Consulting the current session repeatedly adds one transcript per consult, not a copy of the tree.

The model comes from the source's active branch when restorable; `--model selector` overrides it. When the source has no saved model, the model picker opens directly.

The consult excludes additional workspace roots, the workspace tree, context files, skills, rules, inherited agents, extensions, MCP, IRC, and LSP; the source's `session_init` contracts become inert `source_session_init` entries. Tools are limited to `read`, `grep`, and `glob` (as enabled); `task.structured` adds `yield`. Cold revival requires the `seanceSource` header and restores the persisted prompt with the same read-only tools.

Inherited source charges are zeroed; new consultation turns use existing task/Agent Hub usage tracking.

Ownership: [`src/slash-commands/seance.ts`](../packages/coding-agent/src/slash-commands/seance.ts) (command and pickers), [`src/task/seance.ts`](../packages/coding-agent/src/task/seance.ts) (source/model resolution, revival contract), [`src/task/seance-policy.ts`](../packages/coding-agent/src/task/seance-policy.ts) (isolation options), and `SessionManager.forkFrom(..., { seance: true })` (fork).

## Resume and continue

## Session authority backends

The durable **authority journal** records the agent tree and its lifecycle state; it is separate
from the conversation transcript. Let `S` be the complete transcript path, including its `.jsonl`
suffix. `OMP_JOURNALING_BACKEND` selects the default for a newly allocated root (`jsonl` when
unset, otherwise exactly `jsonl` or `sqlite`); a saved root's `<S>.authority.json` descriptor pins
the backend for that root and its descendants. When the environment default differs, OMP continues
with the pinned backend and prints one line with the dry-run migration command (on stderr in print,
JSON and RPC modes, or as a notification in the TUI); it also writes a `warn` entry to the log file
(`logs/omp.<date>.<pid>.log`). Changing or reverting the environment default affects new roots
only and does not migrate or roll back an existing root.

Each open root runs one authority worker thread, and a process runs at most 8 of them at once (a
frozen resource cap that bounds threads, descriptors and queued bytes per process). Child agents,
forks being initialized and short-lived commands share or briefly hold that budget; opening a ninth
root, for example from an SDK host or ACP server holding more than 8 sessions, fails with
`Authority worker/session limit of 8 active roots was reached` until another root closes.

Authority requests are bounded per root (`AUTHORITY_RESOURCE_CAPS` in
`src/registry/authority/client.ts`):

- A command that admits new work may be up to 2 MiB encoded.
- A **continuation**, a command that only advances an already-admitted record along a step its
  admission promised (an operation or resource phase such as `effect`, `committed` or `completed`,
  gate phases, construction progress, root-transition phases, local effect authorization and
  finalization), is limited to 16 KiB, request id, options and records included. A larger
  continuation is refused before anything is written or acknowledged, with a known outcome
  (`AuthorityContinuationTooLargeError`):

  ```text
  Authority transition continuation request is 20480 bytes; continuations of admitted records are limited to 16384 bytes (requestId, options and records included). Nothing was written.
  ```

  The record stays at its previous phase, so the caller can retry with a smaller request. The cap
  applies with capacity `off` and `xfs` alike; under `xfs` it is what lets the reserve price every
  promised future step at 16 KiB rather than 2 MiB.
- Responses are bounded at 64 MiB, at most 64 ordinary requests (8 MiB) may be outstanding per root,
  and each request and each open has a 60 s end-to-end deadline that includes queueing. A request
  or open that misses it fails as an unknown outcome; a timed-out open terminates its worker,
  confirms the exit, releases ownership, and the next open recovers the store as after a crash.

Use either backend for a newly allocated root by setting the environment on the launch command:

```sh
OMP_JOURNALING_BACKEND=jsonl omp
OMP_JOURNALING_BACKEND=sqlite omp
```

The unset default remains `jsonl`; these examples select a new root's default and do not authorize
production rollout or migrate an existing root.

For `/path/to/session.jsonl`, the descriptor is
`/path/to/session.jsonl.authority.json` (not `/path/to/session.authority.json`). The selected
payloads are `<S>.authority.jsonl` and `<S>.authority.sqlite`, with SQLite sidecars
`<S>.authority.sqlite-wal` and `<S>.authority.sqlite-shm` when present. After a clean exit with capacity
`off` a SQLite root leaves neither `-wal` nor `-shm`; with capacity `xfs` a 0-byte `-shm` may remain.
Neither sidecar indicates damage. The ownership lock is
`<S>.authority.lock`; the legacy journal and retained denial fence are
`<S>.authority-v1.jsonl` and `<S>.authority-v1.jsonl.quarantine`. Migration records, stages, and
backups use `<S>.authority.migration.<id>.json`, `<S>.authority.stage.<id>/`, and
`<S>.authority.backup.<id>/` respectively. A rotated JSONL store adds
`<S>.authority.segment.<k>.jsonl`, `<S>.authority.segment.<k>.index.json` and
`<S>.authority.snapshot.<n>.json` ([JSONL segment rotation](#jsonl-segment-rotation)). A
`<S>.authority-recovered.<offset>.<sha256>.bin` file is not part of the bundle: it holds bytes a
JSONL open cut from a torn tail ([interrupted appends](#jsonl-segment-rotation)).

An empty, padded, uppercase or unknown value of either variable fails with one line, for example
`Invalid OMP_JOURNALING_BACKEND value "SQLITE"; expected exactly "jsonl" or "sqlite"`, before any
authority file is written. Both variables are read once per process, at CLI startup or at the top of
`createAgentSession` for SDK hosts.

### Authority capacity and platform support

`OMP_JOURNALING_CAPACITY` selects physical capacity accounting: exactly `off` (the default when
unset) or `xfs`. It is a runtime admission policy, not a store format, so a root created under one
value opens under the other without migration.

```sh
omp                              # capacity off: any supported host and filesystem
OMP_JOURNALING_CAPACITY=xfs omp  # physical reserve: Linux x86_64 on XFS only
```

With `xfs`, OMP reserves disk for each acknowledged authority write and its promised continuations
from an anonymous, unlinked file in the session directory (not another authority store or backup).
The SQLite payload itself is also allocated ahead of use: a new or small `<S>.authority.sqlite` is
about 9 MB under `xfs` (about 0.1 MB under `off`), so its size says little about its history.
It requires Linux x86_64 with glibc, kernel `PIDFD_THREAD` (6.9+), the native calls `fallocate`,
`statx`, `fcntl` and `ioctl` (`FS_IOC_FSGETXATTR`, `FS_IOC_FIEMAP`), the source-pinned SQLite 3.53.4
build, and the session directory on XFS. Backing must be dense, private, and in the same XFS project
as the allocation it backs; project 0 is permitted and project quotas are not required. An
unsupported host, kernel or filesystem is refused before any authority write with one line, for
example `OMP_JOURNALING_CAPACITY=xfs requires the session directory on XFS, but <dir> is on
filesystem type 0x794c7630; unset OMP_JOURNALING_CAPACITY (or set it to "off") ...`. Resuming an
existing root under the refusal changes no file. Starting a new root writes no authority file, but
the new transcript `S` already exists as a header-only stub (about 600 bytes, no messages) when the
check runs; it holds no conversation and can be deleted, or resumed later with capacity `off`.

With `xfs`, a funded transfer allocates each step (24 KiB) into its target before it shrinks the pool,
so no other writer can take the space between the two. One residual window remains under real
pressure: when the filesystem has no room outside the pool for the next step, the target allocation
fails with `ENOSPC`/`EDQUOT`, and OMP releases pool data for that step and retries the allocation once. Between
that release and the retry a concurrent writer outside OMP (or another root on the same filesystem)
can take the freed blocks; the retry then fails and the reserved continuation is refused with a known
outcome before acknowledgement. Nothing acknowledged is lost, but a promised continuation is not
guaranteed when other writers compete for the last free blocks; keep the filesystem from running that
close to full.

A second residual window concerns other processes that change the payload's extents. Within one
SQLite group commit, the first write certifies the store's backing with a full extent readback and
later writes in the same group reuse that certificate while every file's size is unchanged. If another
process reflink-copies the session directory (coreutils 9 `cp` reflinks by default on XFS) or punches
a hole in the payload during that window, the shared or freed extents below end of file need new
blocks when SQLite writes them, which can fail with `ENOSPC`. The worst case is an unknown outcome
for that group and an unavailable store until the next open; nothing in the group was acknowledged,
so there is never `ENOSPC` after an acknowledgement. Do not copy or modify a live root's files; copy
a stopped root, or use `omp session pack`. A per-write recheck of only the WAL tail would not close
this window, because SQLite also rewrites WAL frames from the start after a restart and database pages
below end of file at checkpoints.

With `off`, the client opens no capacity file and the drivers get no capacity option. On a full disk
an authority write fails as it did before capacity accounting: the write is refused or reported as
an unknown outcome, and a refusal before acknowledgement is not guaranteed.

What `xfs` costs, measured on one Linux x86_64 XFS host with histories of 10,000 to 1,000,000
terminal rows (the reserve is the space held in the anonymous pool, not data written):

| | SQLite | JSONL |
| --- | --- | --- |
| Reserve per open (unresolved) operation | about 5.5–6.3 MiB | about 0.56 MiB |
| Pool held right after open | about 43 MiB (10k rows) to 59 MiB (1M rows) | about 8 MiB |
| Pool with 1,000 open operations | about 5.6–6.3 GiB | about 0.56 GiB |
| Open time | adds roughly 0.3–0.5 s | adds little |

The reserve depends on the number of open operations, not on history length. Size the session
filesystem for the open operations you expect: 100 concurrent open SQLite operations hold about
580 MiB. Capacity accounting also costs some latency and throughput (see the limitations below).

On Windows, file privacy relies on the user profile directory ACLs rather than POSIX mode bits: Node reports modes such as `0o666` there, so the group/other mode checks are skipped and every other authority check still applies.

| | `off` on Linux (any arch) | `off` on macOS / BSD | `off` on Windows | `xfs` |
| --- | --- | --- | --- | --- |
| Hosts and filesystems | Any local filesystem (ext4, btrfs, XFS, tmpfs, overlayfs) | Any local filesystem | Any local volume | Linux x86_64 on XFS only; anything else refused before writing |
| Root exclusion | Non-blocking exclusive `flock(2)` on the transcript and the persistent `<S>.authority.lock` anchor | Same `flock(2)` | Process-owned named kernel object keyed by the transcript's and anchor's volume serial and file index | Same as Linux |
| Worker lifetime before ownership release | Kernel exit of the worker's exact thread (`pidfd_open` with `PIDFD_THREAD`) on kernel 6.9+ with glibc; otherwise the worker `close` event | Worker `close` event | Worker `close` event | `PIDFD_THREAD` required |
| Disk full | No reserve; write fails as before capacity accounting | Same | Same | Refusal before acknowledgement; funded continuations still complete |
| SQLite | Any Bun SQLite build | Any Bun SQLite, including the system library | Any Bun SQLite | Source-pinned 3.53.4, Linux x86_64 ABI and VFS readback |
| Durable sync | `fsync(2)` | `fcntl(F_FULLFSYNC)`, which flushes the drive cache; SQLite also runs `fullfsync=ON` and `checkpoint_fullfsync=ON`. If the full flush fails (a filesystem without it), OMP falls back to `fsync(2)`, logs a `warn` entry once per distinct failure reason in each thread that syncs (the store worker and the main process), and shows a one-line notice once per process and session directory. The open probes the session directory once per process: a successful probe is remembered, so later opens there issue no extra drive-cache flush | `FlushFileBuffers` (Node `fsync`) | `fsync(2)` |
| Network filesystem | Not supported; NFS, SMB/CIFS, 9p, Ceph and AFS session directories open with a one-line notice | Not supported; `nfs`, `smbfs`, `afpfs` and `webdav` session directories open with the notice | Not supported; UNC session paths open with the notice | Refused: XFS required |

Every row gives an acknowledged write the same power-loss durability: SQLite runs WAL with
`synchronous=FULL`, foreign keys and a finite busy timeout, and JSONL writes, syncs and reads back
each frame before acknowledging it; every authority sync (file, directory, descriptor, ownership
anchor, migration and lifecycle step) goes through the platform's full flush in the row above. On
macOS a plain `fsync(2)` only hands data to the drive, which may keep it in a volatile cache across a
power loss, so OMP never relies on it unless `F_FULLFSYNC` itself fails. When it fails, opening the
root prints one line, the same way as the network-filesystem notice below, and logs it as `warn`:

```text
Authority: F_FULLFSYNC is not available for /path/to/sessions (fcntl(F_FULLFSYNC) failed with errno 45); OMP falls back to fsync(2), so acknowledged session writes may be lost from the drive cache on a power loss.
```

The live owner holds the
SQLite database in exclusive locking mode and proves it at open: after `BEGIN EXCLUSIVE; COMMIT`, a
second read-only connection must be refused with `SQLITE_BUSY`, or the open is refused. SQLite stores
must use 4 KiB pages, no auto-vacuum and UTF-8, so they stay openable under `xfs`.

What changes off Linux:

- **Worker lifetime.** Without `PIDFD_THREAD`, the client confirms that a worker stopped through
  Bun's worker `close` event, which Bun sends after the worker's JavaScript runtime has shut down.
  No worker JavaScript runs after it, but the kernel does not confirm that the native thread has
  exited, so native teardown on that thread can still be finishing when ownership is released. The
  worker closes its store before acknowledging close; a store left open by a crashed worker still
  holds its own SQLite file lock, so another process sees the store busy rather than writing to it.
- **Windows exclusion.** Windows has no `flock`. The lock is a named kernel object, released by
  Windows when the owning process exits. It excludes other processes on the same machine that open
  the same physical files. The object is named by a SHA-256 over the exact (64-bit) volume serial and
  file index, read as BigInts: as JavaScript numbers, file indexes at or above 2^53 (NTFS ids with a
  high sequence number) round together, which made two files share a lock and the second open fail
  with a false `Authority ownership is already held`. The 128-bit `FILE_ID_INFO` id (ReFS) is not
  read; where the 64-bit index is not unique, the worst case is the same false "already held"
  refusal, never two owners. It was not exercised on Windows for this release.
- **Network filesystems** are not supported on any platform: `flock` there is either local to one
  client or emulated (Linux NFS maps it to whole-file POSIX locks, which any close of the file in the
  process drops), so exclusion between hosts is not guaranteed. With capacity `off`, OMP detects
  them and **warns, without refusing**: Linux by `statfs` type (NFS `0x6969`, SMB `0x517b`, CIFS
  `0xff534d42`, SMB2 `0xfe534d42`, 9p `0x01021997`, Ceph, AFS), macOS by `f_fstypename` (`nfs`,
  `smbfs`, `afpfs`, `webdav`), and Windows by a UNC session path (including a mapped network drive,
  which canonicalizes to one). The notice is printed once per process and session directory, the same
  way as the backend-mismatch line (stderr in print, JSON and RPC modes, a TUI notification), and
  logged as `warn`:

  ```text
  Authority: /home/me/.omp/sessions/... is on a network filesystem (nfs); this host's processes still exclude each other, but cross-host exclusion is not guaranteed. Do not open the same session from two machines at once.
  ```

  FUSE mounts (sshfs, virtiofs) share one filesystem type with local FUSE filesystems and are not
  detected. With `xfs` the XFS requirement already refuses every network filesystem.

Authority exclusion never spans hosts. OMP binds each persistence worker before opening the
authority payload, and shutdown and replacement wait for the confirmation in the table, not merely
the return from `Worker.terminate()`.

### SQLite store format

A SQLite authority payload uses physical schema v4 (`PRAGMA user_version` 4, application id
`0x4f4d5042`). Each current-state table and the control table is one B-tree keyed by a compact order
key, so a commit touches about a quarter of the B-trees the earlier v3 layout did. Each commit is one
immutable frame row that also holds its receipt; one unique index serves idempotent replay. The
frame body is stored once, with values the row already holds and records it repeats replaced by
in-frame references, and is zstd-compressed when that is smaller. Decoding a frame needs no other
frame. Frame and receipt hashes cover the logical frame, so they do not depend on the physical
format.

This build does not open a v3 store (one written before this format change). Opening one fails with
the command that converts it:

```sh
omp session authority '/path/to/session.jsonl' --to sqlite --apply
```

The conversion is an ordinary offline migration whose target is a new v4 store. It reads the v3 store
once, verifies the complete history, keeps every frame hash, receipt, row and control unchanged, and
gives the root a new incarnation. It uses the same manifest, backup (the exact v3 payload stays in
`<S>.authority.backup.<id>/`) and `--recover finish|abort` contract as a backend migration, and it is
refused while unresolved external effects or claims remain. Without `--apply` it is a dry run that
reports `sqlite -> sqlite`. `--to jsonl --apply` also accepts a v3 source. Builds that write v3 cannot
open a v4 store, and a v4 store is never converted back to v3. A store reporting any other physical
version is refused.

Store size grows linearly with history. On the synthetic qualification histories a v4 store held
about 7.3 MiB at 10,000 terminal rows, 72 MiB at 100,000 and 719 MiB at 1,000,000; a JSONL store of
the same history held about 25, 255 and 2,166 MiB, and a v3 store about 28, 279 and 2,809 MiB.

### Group commit

Both backends let concurrent commands of one root share one durable sync, without weakening it.
The worker groups only the mutations already queued when the first member runs: there is no wait
window, so a lone command syncs immediately. A group holds at most 64 commands or 8 MiB of requests;
reads, recovery, quarantine, close and export are barriers that sync and acknowledge the open group
first. Every member is acknowledged only after the sync that covers it, responses keep request
order, and a failed sync reports every member of the group as an unknown outcome.

- **SQLite** runs the group as one `BEGIN IMMEDIATE ... COMMIT` transaction with a savepoint per
  member, so a refused member rolls back to its savepoint without touching the others, and the one
  `COMMIT` is the sync (WAL, `synchronous=FULL`).
- **JSONL** appends each member's complete line and syncs once; see [JSONL segment
  rotation](#jsonl-segment-rotation) for the member marker and torn-tail rules.

Single-command latency is bounded below by the disk's sync time on both backends. On the
qualification host (sync about 5–6 ms), one command at a time reached about 105–150 commands/s on
either backend with capacity `off` (95–150/s with `xfs`), and 16 concurrent commands about
610–1,040/s with `off` (about 370–620/s with `xfs`), across three measurement rounds.

### JSONL segment rotation

A JSONL authority is a sequence of segments so that opening it reads the current state and a short
tail, not the whole history. `<S>.authority.jsonl` is always the **active segment**. Rotation adds
three kinds of sibling files, all private (`0600`) and all members of the authority bundle:

| File | Contents |
|---|---|
| `<S>.authority.segment.<k>.jsonl` | Sealed segment `k`: the exact bytes the active segment held when it was sealed. |
| `<S>.authority.segment.<k>.index.json` | One JSON line: segment `k`'s byte length and SHA-256, its revision range and head hash, every receipt it introduced (sorted by key), and the length and SHA-256 of index `k-1`. |
| `<S>.authority.snapshot.<n>.json` | One JSON line: the rows and non-receipt controls at the start of active segment `n`, its revision, head hash and generation high-water, the length and SHA-256 of index `n-1`, and the highest owner epoch of any sealed receipt. |

Segment 0 starts with the original format-2 header line (`"version":2`, optionally seeded), so a store
that never rotated, or that was written before rotation existed, is a single segment 0 and opens
unchanged. Every later segment starts with a `"version":3` header naming its segment number and its
base: the revision, head hash and generation high-water it continues from, and the name, length and
SHA-256 of its snapshot. A binary that only knows version 2 refuses a rotated store instead of
misreading it, and this binary refuses any header version other than 2 or 3.

**Open** verifies the snapshot against the digest in the active header, loads it, and replays only the
active segment. The first commit after open re-proves only the active segment's bytes. Sealed
segments and indexes are read only by full verification (`omp session repair`, migration, packing),
which replays every segment against its index and checks the snapshot against the replayed state at
its boundary, and by evidence export, which reads the full frame history and every receipt back. A
receipt lookup by request id alone, or for an earlier owner epoch, consults the sealed indexes;
an owner's own retries never do. The first such lookup after an open reads and verifies every sealed
index once to build an in-memory lookup (about 160 bytes per sealed receipt); it took about 0.45–0.8 s
on a 1,000,000-row store and runs inside that command's 60 s deadline. Later lookups are
sub-millisecond.

**Rotation** happens before the append of a command that is a new admission, once the active segment
holds at least the larger of 4 MiB and the size of the snapshot it started from, or 16,384 frames.
Its steps are each durable before the next: publish index `k` and snapshot `k+1` (temporary file,
fsync, rename, directory fsync); hard-link the active inode to `segment.<k>.jsonl`; publish the
segment `k+1` header over `<S>.authority.jsonl`, which commits the rotation; then remove snapshot
`k`. A crash before the commit point leaves the active segment as it was, and the next owner (or a
pack, move or migration under the authority lock) removes the partial files and the extra hard link;
a crash after it leaves the complete new layout and only a stale snapshot to remove. Capacity funds
the new files and the fresh segment before anything is written and refuses before acknowledgement; a
command that consumes an already funded promise defers rotation instead.

Do not delete, rename or edit rotation files by hand: a store missing a sealed segment or index fails
closed. Packing, restore, move, delete and migration carry them with the store.

**Conversions** that write a JSONL store from an existing history (SQLite to JSONL, a legacy v1 upgrade
including automatic adoption, a bundle restore or archive replacement) write it already rotated once the
seeded history reaches the rotation threshold: segment 0 holds the seeded header, and the store's first
open reads snapshot 1 and an empty active segment instead of replaying the whole history. The rotation
files are staged and published before the payload, under the same migration and restore recovery
(`--recover finish|abort`); an abort removes them with the payload. Shorter histories stay one segment.

**Group members.** In a [group commit](#group-commit) each JSONL command appends its own complete
line without a sync, and one sync covers the group before any of them is acknowledged. A group
member's line starts with one space (insignificant JSON whitespace) that marks it as a member.
Rotation never happens inside a group: only a group's first command may rotate.

**Interrupted appends.** Every acknowledgement follows a sync that covers its line through the final
newline, so the bytes a crash leaves after the last complete line were never acknowledged. When the
active segment does not open, the next open cuts its tail only when everything after the last
complete, valid frame line is one of two crash shapes:

- zeros through end of file (the file size reached disk but the data did not); or
- one newline-less fragment that starts like a frame line (optionally after the group-member space),
  optionally followed by zeros through end of file that start on a 512-byte boundary.

Anything else refuses to open and leaves the file byte-for-byte unchanged: a complete line after a
zero run (frame or foreign), any non-zero byte after zeros, zeros that start inside a written block,
foreign text, or a tail longer than one write episode can produce. The resume refusal names the
`omp session repair <S>` dry-run as the diagnosis step. Repair, migration and packing verify a
private copy; when they meet the same tail they name the real `S` and its offset, state that the
store cannot be repaired automatically, and point to
[Refused authority stores](#refused-authority-stores) instead of naming repair again. Zeros inside
synced data come only from a faulty or lying flush
(a drive or VM write cache), and the lines after them may be acknowledged intents whose effects
already happened, so they are kept as evidence rather than dropped.

Before cutting, the open copies the dropped bytes to a private (`0600`) recovery file beside the
store, `<S>.authority-recovered.<offset>.<sha256>.bin`, where `<offset>` is where the cut starts and
`<sha256>` is the digest of the dropped bytes; it syncs that file and the directory, then truncates
and syncs the segment, and logs a `warn` entry with the recovery file's path. The open also prints
one line naming the file, the same way as the network-filesystem notice (stderr in print, JSON and RPC
modes, a TUI notification):

```text
Authority: an interrupted write left an unacknowledged torn tail in this session's JSONL store; it was cut and its bytes are kept in /path/to/session.jsonl.authority-recovered.<offset>.<sha256>.bin (inspect it, then delete it when no longer needed).
```

The recovery file is outside the authority bundle on purpose (its name does not start with
`<S>.authority.`). Repair, migration, packing, moving and adoption recognize its exact name: it is
never treated as authority evidence or copied into a bundle, so it never blocks those commands, and a
move or pack leaves it where it was. `omp session repair <S>` lists it on a `Recovery file: <path>`
line and still reports `Status: clean` when the store is clean. It is operator
evidence: inspect it (`cat -v`, or compare its frames with the transcript), then delete it with `rm`
once you have no further use for it. One shape remains indistinguishable from a torn append: if the
last block of the final acknowledged frame reads back as zeros (a lost write of a synced block), that
frame is cut like a torn append; its bytes are kept in the recovery file. If an earlier open was
killed after writing the recovery file but before cutting, the next open checks that the existing
file is a private regular file holding exactly the bytes it is about to cut (and refuses otherwise),
syncs it and the directory again before the cut, and prints the same notice.

### Refused authority stores

Some authority states have no recover command: a tail kept as evidence (above), a missing selected
payload, both a JSONL and a SQLite payload, a corrupt descriptor or one whose lock identity or root
UUID disagrees with the anchor or transcript, a legacy journal without its denial fence, or authority
files without a committed descriptor on a new root. The resume refusal, and the refusal from repair,
migration or packing, is one line that ends with `keep every <name>.authority* file unchanged and
follow "Refused authority stores" in docs/session-operations-export-share-fork-resume.md`. The session
stays unavailable; nothing is changed until you act. To recover:

1. **Preserve the evidence first.** Stop every client that has the session open, then copy the
   transcript and every sibling whose name starts with `<S>.authority` (including
   `<S>.authority-v1.jsonl*` and any `<S>.authority.backup.<id>/` directory) to a safe place, for
   example `cp -a '<S>' '<S>'.authority* /safe/place/`. Do not delete, rename or truncate any
   authority file before this copy exists; deleting them blindly discards the record of external
   effects (operations, claims, receipts) and lets a later resume start an empty authority over
   work that already happened.
2. **Inspect the refused store.** The refusal names the file and, for a tail, the byte offset after
   the last valid frame. `ls -la '<S>'.authority*` shows the files and their modes (authority files are
   `0600`); `cat '<S>'.authority.json` shows the descriptor and which payload it selects. For a refused
   JSONL tail, `tail -c +<offset+1> '<S>'.authority.jsonl | cat -v` shows the bytes after the last valid
   frame: zeros followed by complete frame lines mean a lost write inside synced data, and those lines
   may be acknowledged intents whose effects already happened.
3. **Choose a safe option.**
   - **Restore from the migration backup**, if `<S>.authority.backup.<id>/` exists and the root has
     not accepted writes since that migration (a backup older than later writes is stale and must not
     be restored). The backup holds the whole pre-migration bundle: its descriptor, payload files and
     legacy files. Move every `<S>.authority*` sibling except `<S>.authority.lock` and the backup
     directory into a new directory (keep them), copy every file of the backup except
     `<S>.authority.lock` and `migration.json` back beside the transcript with mode `0600`, and keep
     the existing `<S>.authority.lock` in place (the descriptor names that file's identity). Then run
     `omp session repair '<S>'`; it must report `clean` before you resume, and the root resumes on
     its pre-migration backend.
   - **Review the bytes after the last valid frame by hand.** If the review shows they are not
     acknowledged history (for example foreign text appended to the file), truncate the payload to
     the offset named in the refusal, on the preserved copy first, then on the real file, and run
     `omp session repair '<S>'` until it reports `clean`. If the bytes include frames that may have
     been acknowledged, do not truncate: the external effects they record must be reconciled first.
   - **Otherwise** leave the session unavailable, keep the preserved copy for later review, and
     continue the work in a new session.

`omp session repair`, `omp session authority ... --recover` and resume never delete these files for
you, and the steps above never require deleting an authority file.

Two refusals have a narrower cause:

- **Lock identity mismatch after copying or moving a session directory.** A plain `cp -r`, a
  directory copy, or a move across filesystems gives `<S>.authority.lock` a new inode, so the
  descriptor no longer matches it and none of the options above recovers the copy. Move or transfer
  sessions with `omp session pack` and `omp session unpack`, which carry the authority bundle. Keep the
  original directory if it still exists; resume it there instead.
- **A recovery file with "different bytes" after an interrupted resume.** If an earlier resume was
  interrupted while writing `<S>.authority-recovered.<offset>.<sha256>.bin`, that file can be empty or
  shorter than the bytes it names, and every later resume refuses with "exists with different bytes"
  while `omp session repair` still reports `clean` (the payload has not been cut yet, so nothing was
  lost). Check that the file is a prefix of the payload bytes from `<offset>` (for example
  `cmp <(tail -c +<offset+1> '<S>'.authority.jsonl) '<recovery file>'` reports EOF on the recovery
  file, not a difference), move that recovery file aside, then resume: the resume writes it again in
  full before cutting.

The transcript `S` remains the source for conversation messages, tool results, branches, and
compaction summaries. This flag does not switch transcript storage, the separate Hub custody
journal, artifacts, or unrelated SQLite caches. `--no-session` creates no durable authority
payload. An unavailable selected payload, unknown commit outcome, or worker failure remains
unavailable: there is no automatic fallback to another format and no retry of an external callback
to guess whether an effect happened.

After SQLite has accepted writes, returning a root to JSONL requires explicitly migrating the
current SQLite state; the pre-migration JSONL backup is stale and must not be restored over newer
state. The supported target is the versioned JSONL format in this release, not arbitrary
older-binary compatibility.

Exclusion and worker-lifetime guarantees per platform, and what `OMP_JOURNALING_CAPACITY=xfs`
adds, are in [authority capacity and platform support](#authority-capacity-and-platform-support).

Operation-scoped generated-file header protection also requires accessible Linux
`/proc/self/fd`. With the guard enabled, OMP reads the authorized open inode through that
interface and fails closed if it cannot establish that binding; it does not reopen the target
pathname as a fallback.

Session-path-scoped JSON and binary input copying, and scoped local AST directory traversal,
also require accessible `/proc/self/fd`. Native query and persistent binary-analysis hosts receive
private snapshots rather than a parent process's original input descriptor. Scoped JSON and SQLite
reads use scratch snapshots; scoped IDA databases use private cached snapshots rather than opening
the original `.i64` or `.idb` in place. This adds temporary-space and full-input copying I/O costs.
SQLite captures include existing WAL/SHM inputs and refuse a source that changes during capture.
The private analysis cache is not an authority store.
Scoped JSON reads also require successful removal of their private scratch snapshot. Cleanup
failure is reported even if the query succeeded; simultaneous query, cleanup, and admitted-input
close failures preserve their original causes rather than reporting successful output.

Ordinary copied-root admission is forbidden on every host. A UUID is not a
global lock: `flock` coordinates only participants sharing the same physical anchor and kernel.
Explicit restore is separate and requires the operator/caller to stop or fence the source root and
reconcile external effects newer than the backup before exposing restored grants. The restore input
does not identify its source, so OMP cannot locate, lock, fence, or detect a disconnected original;
automatic safety proof across disconnected inode or network domains is unsupported. A fresh restored
incarnation does not prove the source authority was revoked.

### Sessions saved before authority journaling

Resuming a root that has no `<S>.authority.json` descriptor (a session saved by an earlier release)
adopts it automatically, under the root's exclusive ownership, when OMP can account for every
authority artifact beside the transcript:

| Evidence beside `S` | Resume does |
|---|---|
| None (a lone empty `<S>.authority.lock` counts as none) | Creates a fresh versioned JSONL authority store |
| A clean `<S>.authority-v1.jsonl` journal and nothing else | Upgrades it in place to versioned JSONL with the same conversion as `omp session authority <S> --to jsonl --apply`: the original journal is kept in `<S>.authority.backup.<id>/`, and the legacy path keeps its permanent denial fence |

Adoption always selects JSONL, whatever `OMP_JOURNALING_BACKEND` says; that variable still applies
only to new roots, and a descriptor written by an earlier resume or migration always wins. Use
`--to sqlite --apply` afterwards to move an adopted root to SQLite. The transcript bytes are never
rewritten. Adoption prints one line, on stderr in print, JSON and RPC modes or as a notification in
the TUI, for example:

```text
Authority: upgraded this session's legacy v1 authority journal to versioned JSONL; original kept in /path/to/session.jsonl.authority.backup.<id>
```

It also writes an `info` log entry with the message `Adopted pre-journaling session authority` and the
fields `sessionFile`, `kind` (`bootstrapped` for a new store, `upgraded` for a legacy journal),
`backend` (`jsonl`) and, for an upgrade, `backupDirectory`.

Anything else refuses before changing a file, with the command to run:

| Evidence | Command named in the refusal |
|---|---|
| A legacy journal with unresolved effects or claims | `omp session authority <S> --to jsonl` (the dry-run lists them) |
| A corrupt or quarantined legacy journal; a denial fence, payload, backup or legacy repair backup without a descriptor; a lock file with content; an unrecognized `<S>.authority*` sibling | `omp session repair <S>` |
| The backup of an aborted upgrade beside its legacy journal | `omp session authority <S> --to jsonl --apply` |
| A migration record (`<S>.authority.migration.<id>.json`) | `omp session authority <S> --recover finish` (or `--recover abort` before the target is selected) |
| A migration stage, restore record, or hidden lifecycle marker (`.<name>.authority-*`) | `omp session authority <S> --recover finish` |
| An initialization that never became active (`initializing` descriptor or an interrupted descriptor write) | `omp session authority <S> --recover abort` |
| An older client still writing the legacy journal | Stop it, then `omp --resume <S>` |
| A transcript whose header `authorityRoot` names another path: a copy or move that left its authority bundle behind, or a child agent transcript (task subagent, seance or `/tan` fork, stamped with the root that owns it) | `omp --resume <stamped path>`; or move the session with its bundle (`omp session pack`/`unpack`), or start a new root from it with `--fork` |

Transcripts written by this release record `authorityRoot`, the canonical path of the transcript
whose authority governs them, in their header. A child agent's transcript (task subagent, seance,
`/tan`) records the root that owns its actor: its parent's own stamp, so a subagent of a subagent
names the top root. Task subagent transcripts created before this change recorded their own path and
still adopt as roots when resumed directly. The path is canonicalized once, the same way for the stamp
and for every check, through the native realpath (which resolves `subst` and mapped drives on
Windows and returns the on-disk case on case-insensitive macOS volumes). Forks and continuations get their own path, a move
through `omp session` lifecycle commands or `/move` updates it together with the bundle, and shares
and HTML exports omit it. A transcript without the field (saved by an earlier release) is adopted by
the evidence rules above.

A crash during adoption leaves either the untouched session or recoverable state: an interrupted
upgrade is a staged migration that `--recover finish|abort` resolves, and an interrupted fresh
initialization refuses until `--recover abort` removes the never-activated store (only when it holds
no authority records), after which the next resume starts over. When several processes resume the
same root at once, exactly one adopts it; the others either open the adopted store or fail with
`Authority ownership is already held`.

### Migrate or upgrade explicitly

`omp session authority <session-id-or-path> --to jsonl|sqlite` is a dry-run by default: it inspects a
migration without changing the authority artifacts or transcript, and only `--apply` performs it.
Expected refusals (unknown session, unresolved claims, ownership held by a live client) print one
line, `Session authority failed for <path>: <reason>`, and exit 1. `omp session repair`, `pack`,
`unpack` and `moved` report authority refusals (a quarantined or torn store, a pending recovery) the
same way, as `Session <action> failed for <path>: <reason>`, without a stack trace; when a refusal
also left cleanup failures, the line lists each of them after the primary reason. Transfer errors
from `pack`/`unpack` print one `error: <message>` line. Usage errors print usage, and an unexpected
internal error in `pack`, `unpack` or `moved` (a `TypeError` or similar defect) is not flattened: it
prints its stack so it can be reported. Use a session ID or quote a transcript path containing
spaces:

```sh
omp session authority '/path/to/session.jsonl' --to sqlite
```

After reviewing the dry-run, stop the client that owns the session, then add `--apply` to perform
the migration. Both JSONL-to-SQLite and SQLite-to-JSONL migrations are supported; the same explicit
command upgrades a legacy `.authority-v1.jsonl` journal into the selected current format (resume does
this automatically for a clean journal, always to JSONL; see above). Migration
preserves a backup and is refused while unresolved external effects or claims remain. If SQLite
has accepted newer writes, the reverse migration uses the current SQLite state; its older JSONL
backup is not a rollback source.

```sh
omp session authority '/path/to/session.jsonl' --to sqlite --apply
omp session authority '/path/to/session.jsonl' --to jsonl --apply
```

If a migration was interrupted, inspect and explicitly choose how to resolve its staged state:

```sh
omp session authority '/path/to/session.jsonl' --recover finish
omp session authority '/path/to/session.jsonl' --recover abort
```

For backend migration, `finish` completes the staged conversion; `abort` restores the source and
works until the descriptor selects the target. It is refused once the migration reaches
`descriptor-published` or `ready`, because the target is then selected and only `finish` is safe.
`--recover abort` also removes an initialization that never became active (its descriptor is still
the first `initializing` revision and its payload holds no authority records); `finish` refuses that
state. When there is nothing to recover, `--recover finish|abort` prints `Status: recovered` and
`Authority: <backend>` and exits 0. Backend conversion preserves the conversation transcript bytes.
`omp session repair` handles legacy v1 repair and selected format-2 integrity/export inspection;
see the branch-specific behavior below.

Runbook for one root (the same steps apply in either direction and to a v3-to-v4 conversion):

1. `omp session repair '<S>'` — full integrity check of the current store; it must report `clean`.
2. `omp session authority '<S>' --to sqlite` — dry run. It reports `Status: dry-run` and the
   direction, or refuses with one line (unresolved effects or claims, rotation recovery pending, an
   interrupted migration). A dry run changes nothing and may run while the session is open.
3. Stop every client that has the session open (including child agents and ACP or SDK hosts).
   `--apply` takes exclusive ownership and refuses with `Authority ownership is already held` while
   a client still holds it.
4. `omp session authority '<S>' --to sqlite --apply` — prints `Status: migrated` and
   `Authority: <from> -> <to>`. The original payload stays in `<S>.authority.backup.<id>/`; the
   transcript bytes are unchanged. When the root already uses the requested backend, the command
   prints `Status: already-selected` and `Authority: <backend> -> <backend>`, changes nothing and
   exits 0; the dry run (step 2) reports the same status.
5. If step 4 was interrupted (crash, kill, full disk), the next resume refuses and names the
   command: run `--recover finish`, or `--recover abort` while the descriptor still selects the
   source. Do not delete the migration record, stage or backup by hand.
6. `omp session repair '<S>'` again, then resume normally. Remove the backup directory only once you
   no longer need to return to the pre-migration payload; after the migrated root has accepted
   writes, that backup is stale and is never a rollback source.

Conversion reads and writes the history in a streaming pass, so its memory does not grow with the
history: on the qualification host the peak resident set stayed at about 230–250 MiB for a
1,000,000-row history in both directions. Its time does grow linearly: about 25–35 s at 10,000
terminal rows, 4.5–5.5 minutes at 100,000, and about 51 minutes at 1,000,000 (v3 SQLite to v4, and
v4 SQLite to JSONL, each measured under `nice`/`ionice` idle priority). Every step verifies the
complete history, so plan for the source store, its backup copy, a disposable verification copy and
the target to exist at once: roughly three times the source store plus the target. A JSONL target
is about three times the size of the equivalent SQLite v4 store. A legacy v1 journal is the
exception to bounded memory: it is read whole, as earlier releases did.

### Recover a whole-session lifecycle operation

Quiescent authority-backed moves, archive replacement of local copies, and root deletion retain
durable whole-bundle recovery material under `<S>.authority.stage.<id>/` and identified backups.
The bundle includes the transcript, artifacts, descriptor, selected payload, required SQLite WAL
state, and authority provenance. Do not remove these guards or backups to make a root reopen.

A filesystem root still bound to registry operation authority cannot be moved through the live
managed session. The move is refused with `SessionMoveRefusedError` before its shared authority
store or bundle is relocated. Close the managed session and its authority handles, then use the
quiescent lifecycle path; closing a store does not rebind the live registry. A failed adoption or
rewrite after a committed authority move fences the stale manager. Reopen the validated selected
root after any required recovery instead of continuing writes through that manager.

The same `--recover finish|abort` commands resolve interrupted lifecycle operations. Supply an
explicit source or target transcript path, including `.jsonl`, even if that transcript has already
been moved or deleted; session-ID lookup cannot find a retired transcript. Recovery checks the
retained operation before attempting backend-migration recovery.

Before the durable selection decision, `finish` completes the prepared operation and `abort`
restores verified original state. After target authority has been selected, only `finish` is
permitted: restoring old source grants would create stale authority. Deletion also retains its
durable decision and provenance; it is not undone by abort after that decision. Unlike backend
conversion, lifecycle recovery can move, replace, or delete transcript and artifact files.

An interrupted authority-backed `SessionManager.moveTo()` seals that manager against further
source writes. Recover the retained operation, then reopen the selected root; do not continue
using the old manager. Unpack refuses a pending replacement before classifying local transcript
divergence, rather than treating a second archive as a fresh operation.

Root deletion requires quiescent ownership and removes the owned active bundle while retaining
recovery provenance. Deleting a child transcript does not delete the shared root authority.
Explicit restore after deletion still requires the source-stop and post-backup reconciliation
preconditions above; retained bytes do not reverse external effects.

### Known limitations

- **Qualified platform.** Qualification ran on Linux x86_64: capacity `xfs` on XFS, capacity `off` on
  XFS, overlayfs and tmpfs (`/dev/shm`), through print-mode launches, the `omp session` commands and the test suites.
  macOS, Windows, Linux arm64, ext4 and btrfs are supported by the code paths in the platform table
  but were not exercised on real hosts, and the interactive TUI and ACP server were not driven end
  to end.
- **One host per root.** Exclusion holds between processes of one kernel. Network filesystems are
  detected and warned about, not refused; FUSE network mounts are not detected. Never open one
  session from two machines.
- **Capacity `off`** (the default) gives no disk-full guarantee: a write on a full disk can fail
  after it reached the file and is then reported as an unknown outcome.
- **Capacity `xfs` overhead.** In the final measurement against the same host with capacity `off`,
  durable-write p95 was 1.11–1.17 times higher for SQLite and 1.09–1.10 times for JSONL at 10k to 1M
  terminal rows (earlier builds measured up to 1.8 times for SQLite at some sizes), JSONL worker CPU
  per command was about 11% higher at 10,000 rows, 16% at 100,000 and 3% at 1,000,000, and
  concurrent throughput was lower (see [group commit](#group-commit)). The residual windows
  described above can refuse a promised continuation when other writers take the last free blocks,
  or make a SQLite group's outcome unknown when another process reflinks or hole-punches a live store.
- **JSONL at very long histories.** Opening a rotated JSONL store with 1,000,000 terminal rows took
  about 3–7 s (SQLite about 0.1–0.4 s), JSONL CPU per command at 1,000,000 rows was about 1.6–1.7
  times that at 10,000 rows with p95 latency level, and the first lookup of a receipt by request id
  alone after open costs about 0.45–0.8 s at that size (see [Open](#jsonl-segment-rotation)). A JSONL store written as one segment by
  a build without rotation replays its whole history on open, and at about 1,000,000 rows that
  exceeds the 60 s open deadline; convert it offline (`--to sqlite --apply`, then back with `--to
  jsonl --apply` if wanted), which was not exercised at that size.
- **Open does not verify history.** Normal open validates the header, identity, schema, the JSONL
  snapshot digest and the active segment; sealed segments and full SQLite history are verified only
  by `omp session repair`, migration and packing.
- **Torn-tail recovery.** If the last block of the final acknowledged JSONL frame reads back as zeros
  after a crash (a lost write of a synced block), it is cut like a torn append; its bytes are kept in
  the `<S>.authority-recovered.*.bin` file.
- **macOS durability** depends on `F_FULLFSYNC`; on a filesystem without it OMP falls back to
  `fsync(2)` (logged, and shown once as a notice), which may leave acknowledged data in the drive
  cache across a power loss.
- **Compatibility.** Earlier builds cannot open v4 SQLite stores or rotated JSONL stores, and v4 is
  never converted back to v3. Task subagent transcripts saved before `authorityRoot` stamping still
  adopt as separate roots when resumed directly by path.
- **Per-process limit.** At most 8 roots per process (see above).

## Session authority repair

`omp session repair <session-id-or-path>` inspects and, where supported, repairs the authority
sidecar for a saved session. It accepts a session id or a path to a `.jsonl` file; quote paths that
contain spaces.

Repair is a **dry-run by default**. It is also the integrity verification: normal session open and
resume validate the descriptor header, identity, and schema but do not run a full integrity scan,
which is O(history). A corrupted index row is therefore detected by `omp session repair`, not by
resume. Without a selected format-2 descriptor, the command validates
the legacy v1 journal and its history/lineage. A dry-run never changes the journal or quarantine
marker and reports either `clean` or a proven `repairable` diagnosis. It refuses unexplained
quarantine markers, hash/history corruption, cycles, root or lineage conflicts, scope drift, and
other states that cannot be proven safe.

Legacy repair may append closure records only for verified descendants of terminal ancestors
(`retired` or `aborted`). It may resolve a recognized quarantine marker only when whole-history
validation proves no affected actor closure remains. The repair set is closed leaf-first. After
reviewing a repairable diagnosis, stop the owning client before applying:

```sh
omp session repair '/path/to/session.jsonl' --apply
```

Legacy apply takes the journal and, when present, quarantine-marker locks; rechecks source bytes,
metadata, journal head, and affected lineage; writes exact pre-repair bytes to a retained
`.authority-repair-*` backup; and appends terminal closure records. A source change, lock conflict,
or failed verification aborts safely. Do not manually delete the journal, marker, or backup.

When a format-2 descriptor selects a backend, repair performs selected-store integrity/export
inspection only. Passing checks report `clean`; this path does not append legacy closure records,
resolve legacy quarantine, or create `.authority-repair-*` backups. A missing selected payload,
corruption, or other unavailable state fails closed rather than falling back to legacy repair.
Use the explicitly supported migration recovery or restore procedure to reconcile such state; do
not clear markers or restore a stale backup over newer authority writes.

After a successful legacy repair, start a **fresh process** with the reported command instead of
trying to hot-reload the repaired authority:

```sh
omp --resume '/path/to/session.jsonl'
```

Do not use this command to deploy, repair live provider data, revive old actor authority, or alter
unrelated session behavior.

## Interactive `/resume [value]`

Without an argument:

1. Opens the session selector populated via `SessionManager.listForPicker(currentCwd, currentSessionDir)`. Pinned sessions come first; untitled, prompt-less zero-turn stubs are hidden unless pinned. The picker always opens in current-folder scope; the empty state invites Tab into all-projects instead of auto-switching.
2. Tab toggles to all-projects scope, lazily loading and caching `SessionManager.listAllForPicker()`.
3. On selection, `SelectorController.handleResumeSession(sessionPath, { followContinuation: true })` first follows `findSessionContinuation` to the copy with the newest turn (see CLI `--resume <value>`), then calls `session.switchSession(<that path>)`. If the switch is rejected, it returns `false` and the selector stops without applying the new-session UI state.
4. After a successful switch, UI clears/rebuilds chat and todos, then reports `Resumed session` (or `Resumed session in <dir>` when the resumed session belongs to another project, in which case the process cwd and cwd-derived caches are re-pointed via `applyCwdChange`).

With an argument:

- `/resume <id>` resolves an id/filename prefix with local-first, then global fallback, and opens the copy `resolveResumeTarget` picks, the same one the CLI's `--resume <id>` opens (see CLI `--resume <value>`); an unknown value reports `Session "<value>" not found`.
- `/resume @claude` and `/resume @codex` open a foreign-session picker. Selecting one converts and persists it under a fresh OMP session identity, then switches to that new session.

## CLI `--resume`

### `--resume` (no value)

- `main.ts` uses `SessionManager.listForPicker()` for the current cwd/sessionDir and opens the picker in current-folder scope. When that list is empty it preloads `SessionManager.listAllForPicker()` so a user-initiated Tab switch is immediate; it does not auto-switch scopes. `No sessions found` is printed only when the global picker list is also empty.
- Selected path is opened with `SessionManager.open(selectedPath)` before session creation; the process/project scope then switches to the resumed session's cwd (`switchToResumedProject`), reloading cwd-scoped settings and plugin caches and re-resolving scoped models.

### `--resume <value>`

`createSessionManager()` resolution order:

1. If value looks like path (`/`, `\`, or `.jsonl`), open directly. A path that does not exist fails with `Session "<path>" not found.` rather than creating a session there.
2. Else `resolveResumableSession(...)` searches:
   - current scope (`SessionManager.list(cwd, sessionDir)`)
   - global sessions (`SessionManager.listAll()`) only when no explicit `sessionDir` was provided
3. Matching accepts case-insensitive session id prefixes, full JSONL filename prefixes, and the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.
4. When nothing matches, the resolver (`resolveResumeTarget`) looks in the same scopes for a `<timestamp>_<sessionId>.jsonl` file whose name matches but which no longer reads as a session (the listing skips it), and takes the copy that continues it (see below). Otherwise resolution fails with `Session "<value>" not found.`

Both forms then follow the session's continuations (`findSessionContinuation`, through `resolveResumeTarget` for a key): when its conversation went on in another file of the same directory (a sibling whose header names it in `continuationOf`), the copy with the newest turn opens instead, unless the named file has turns of its own that copy lacks, and a notice names both files. A file that no longer holds the session its generated `<timestamp>_<sessionId>.jsonl` name records was replaced under that session (conflict recovery leaves it as it found it); resume then opens the copy that continues the named session, when one exists. That applies to a path whose file no longer parses, and to a key that matched only the file name (the file holds another session) or found an unlisted file in step 4. A path whose file holds another session opens that session; a file without a generated name records no session id and is never taken as replaced.

Id/filename-prefix match behavior (local or global):

- If the matched session's recorded directory no longer exists, CLI asks `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`.
  - On yes (default), `SessionManager.open()` is anchored at the missing source cwd with `initialCwd`, then `manager.moveTo(cwd, sessionDir)` re-roots the existing session without duplicating it.
  - On no, startup is cancelled. In non-TTY mode, startup fails with an error directing the user to run interactively.
- If the recorded directory still exists, the matched session is opened directly. Startup later changes the process/project scope to the resumed session's cwd and reloads cwd-scoped settings and plugin caches. It is not implicitly forked.

Path-valued resume opens directly rather than using the missing-directory move
prompt. If its recorded cwd is missing or permission-blocked, startup retains
the launch cwd without relocating the transcript; a failed cwd switch/rescope
also prints a fallback warning.
The same enterability policy applies to picker selections. A missing direct path
fails with `Session "<path>" not found.`; an existing empty file or malformed
non-empty headers fail closed without modifying the file, unless the file was
replaced under a session that went on in a sibling (see above).

## CLI `--restore`

`--restore [value]` selects and opens its session exactly as `--resume [value]`
does, then, once the interactive TUI is up, goes on with what the session's last
process left unfinished when it died (`task/restore.ts`, `restoreSession`). Tern's
session daemon relaunches omp panes with it after a crash: omp reports
`omp_restore=1` (OSC 1337 user variable) beside its session file to say it
understands the flag.

1. **Subagents first.** Every persisted subagent transcript under the session
   (`<session>/<AgentId>.jsonl`, nested ones included) that its process left
   mid-turn, that was not killed (no tombstone) and that a cold revive can rebuild
   (a `session_init` contract, not isolated) runs one more monitored turn as a
   background job of its parent, under the subagent's id. The lifecycle reviver
   rebuilds it from its transcript, the turn goes on as below, and the parent
   receives the result as the job's ordinary `async-result`, so a parent waiting on
   that job finds it again.
2. **Then the session's own turn** (`AgentSession.restoreInterruptedTurn`). A turn
   cut off without a `session_exit` record (a crash, SIGKILL or power loss records
   none) is first closed the way exit recovery closes one whose exit was recorded:
   unfinished tool calls get "outcome unknown" results and an interrupted-turn
   abort ends it. That turn is then retried as `/retry` does: a batch whose every
   call was cut off runs again; otherwise the model answers from where the
   transcript stops.

Nothing is continued when the last turn finished, failed, or the user interrupted
it, or when a normal exit was recorded after it (the user quit with it
interrupted). `--restore` is interactive only, takes no prompt, and cannot be
combined with `--continue`, `--fork`, imports, `--goal` or `--no-session`.
`/restart` drops it like the other one-shot selectors.

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. Resolves the session directory for the current cwd.
2. Reads the terminal-scoped breadcrumb. A fresh breadcrumb whose lazy JSONL is still absent starts fresh rather than reopening an older conversation. Explicit `newSession()` boundaries already have a durable header.
3. If it points into a nested artifact/subagent session, resolution walks up to the top-level interactive parent session (up to eight levels).
4. A matching-cwd breadcrumb is used when it lies within an explicitly supplied session directory, if any. Otherwise discovery chooses the newest session with resumable content, skipping untitled, prompt-less zero-turn stubs.
5. For a different, missing recorded cwd, automatic re-rooting additionally requires the current directory's device/inode to match the breadcrumb's recorded directory identity and no genuine current-project session to take precedence. A deleted/unmounted path, legacy breadcrumb without identity, or cross-filesystem move is not enough evidence to relocate history.
6. When the chosen session's conversation went on in another file of the same directory (its header names the chosen session in `continuationOf`), chooses that copy instead and reports it to the `onSessionContinuation` option (the CLI prints a notice); step 5 re-roots that copy, not the file the breadcrumb names. A session the breadcrumb names is kept when it has turns its continuation lacks, as with `--resume`; a pick by write time takes the linked copy with the newest turn in either direction.
7. Opens the chosen session, or creates a new one when no candidate exists.

For compatibility, `--continue <full-UUID>` is normalized to `--resume <UUID>` when the UUID is the sole positional message. The `autoResume` setting invokes the same `continueRecent` behavior when no explicit session flag/session directory is supplied, and restores session model/thinking state when a prior transcript was found.

If implicit interactive auto-resume exhausts the saved models and model-fallback policy forbids substitution, startup closes the skipped session, warns, and starts a new session without its history or provider cache identity. It does not retry older transcripts or weaken restoration policy. When `--max-time` is set, the new session keeps the launch's original absolute deadline; time spent on the failed restore is not added back to the budget. Explicit `--continue`/`--resume`, runtime `/resume`, and headless/SDK hosts still fail closed under the same policy; an explicit model override remains an intentional way to restore the transcript with another model.

This is startup-only behavior; there is no interactive `/continue` slash command.

## Restart

Interactive `/restart` performs normal teardown, flushes postmortem cleanup and
stdout, then relaunches the CLI. `restartArgv()` preserves launch configuration
flags but strips original prompts/`@file` positionals and one-shot session
selectors (`--session`, `--resume`, `--continue`, `--fork`, and foreign imports).
It adds `--resume <current-id>` only when the session actually exists on disk;
an in-memory or never-materialized session restarts fresh.

POSIX uses process-image replacement when available. Windows or a failed exec
falls back to spawning the replacement with inherited terminal streams.

## How session switching actually mutates runtime state

`AgentSession.switchSession(sessionPath)` does the runtime transition used by resume-like operations:

1. Emit `session_before_switch` with `reason: "resume"` and `targetSessionFile` (cancellable).
2. Disconnect the agent event subscription, abort in-flight work, and run the optional pre-switch reconciler.
3. Flush pending bash/session writes and capture rollback state: session manager state; agent messages and all queues; model/thinking/service tiers; tools and prompts; provider/cache ids; memory promotion; and checkpoint rewind state.
4. Clear agent and next-turn queues. For a different file, drain/detach advisor recorders.
5. `sessionManager.setSessionFile(sessionPath)`, update provider-cache/session ids and memory keys, build the display context, resolve the recorded model, and rehydrate checkpoint state. When no recorded model can be restored for a different file, the switch fails here with `Could not restore model <provider/id>` (see below).
6. Emit `session_switch` with `reason: "resume"`.
7. Replace agent messages, reset advisor state, and synchronize todos. Close cached provider sessions for a different file, or for a same-file reload whose replay messages changed.
8. Apply the resolved (or explicitly requested) model. If the loaded branch ended with an interrupted turn, append its synthetic abort message and rebuild context.
9. Restore configured/effective thinking and per-family service tiers, falling back to current settings when the target branch has no corresponding entries.
10. For a different transcript, reset memory context; for any conversation rewrite, clear session-scoped tool state.
11. Reconnect agent events, run the optional session-switch reconciler (interactive mode uses it to re-enter persisted modes such as plan), and best-effort refresh the workspace-root system-prompt block. Reconciler/prompt-refresh errors are logged rather than rolling back the committed switch.
12. Restore target advisor cost state, finish the bash transition, notify session-change callbacks when the session id changed, and return `true`.
`switchSession()` returns `false` when a before-switch hook cancels or cwd policy rejects the transition. A cross-project switch without a cwd-change callback is rejected rather than silently adopting the target cwd; callback rejection is also cancellation. The interactive selector checks this result and leaves the existing session/UI unchanged.

If a throwing step in the guarded transition fails, `switchSession()` restores the captured session, agent queues/messages, tools/prompts, model/thinking/service-tier, provider/cache, memory, and checkpoint state; it reconnects the prior agent subscription and re-runs mode reconciliation before rethrowing.

Normal resume switching opens an existing transcript. Because it delegates to
`setSessionFile()`, a missing/empty explicit target can instead materialize a
new session at that path; malformed non-empty headers are rejected.

Model restoration fails closed, like startup resume: a switch never silently moves a transcript to a model it did not record. Only a session created with `hasUI` and `allowSessionModelFallback` (the TUI), with `retry.modelFallback` on, keeps its current model instead, and warns `Could not restore model <provider/id>. Using <provider/id>`. An explicit `model` option (RPC `open_session`/`switch_session` with `provider`/`modelId`) replaces the recorded model, and a same-file reload keeps the current one.

## Event emissions and cancellation points

### Switch/fork lifecycle hooks

For `newSession`, `fork`, and `switchSession`:

- Before event: `session_before_switch`
  - reasons: `new`, `fork`, `resume`
  - cancellable by returning `{ cancel: true }`
- After event: `session_switch`
  - same reason set
  - includes `previousSessionFile`

`ExtensionRunner.emit()` returns early on the first cancelling before-event result.
When a before-switch hook cancels, `switchSession()` returns `false` and does not emit the after-switch event.

### Custom tool `onSession` behavior

SDK bridges extension session events to custom tool `onSession` callbacks:

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

These callbacks are observational; they do not cancel switch/fork.

### Other cancellation surfaces relevant to this doc

- `/fork` is blocked while streaming (user must wait/abort current response first).
- `/resume` selector can be cancelled by user closing selector.
- Cross-project `--resume <id>` can be cancelled by declining the missing-directory move/re-root prompt.
- `/share` has a UI abort path (`Share cancelled`); the upload itself is not killed mid-flight.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path is absent.
- `/export` fails with `Cannot export in-memory session to HTML` (propagated to command error UI). `/share` still works: the snapshot is built from live entries.
- `/fork` fails because `SessionManager.fork()` requires persistence.
- `/dump` still works because it serializes in-memory agent state.
- Native CLI `--resume`, `--continue`, and `--fork` are rejected with `--no-session`; the preliminary startup parse may allocate an in-memory manager, but validation rejects these combinations before normal execution.

## Known implementation caveats (as of current code)

- `/share` custom-share failures do not degrade to the default encrypted share flow; they terminate the TUI command with an error.
- `/export` argument tokenization does not preserve quoted paths with spaces.
- `/delete` treats deletion as best-effort: it attempts to delete the current
  session JSONL and artifact directory, logs any deletion failure, and still
  creates and switches to a new session. A failed or partial deletion can leave
  the old session or its artifacts on disk, so `/delete` is not a guaranteed
  erasure boundary.
