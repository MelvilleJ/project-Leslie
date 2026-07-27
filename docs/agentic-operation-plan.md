# Agentic Operation — Implementation Plan

How opencode runs its agent loop, and a phased plan to adopt the parts that
matter into project-Leslie's existing loop ([src/main/agent/](../src/main/agent/)).

---

## 1. How opencode's agentic operation works

opencode is an Effect/TypeScript coding agent. Its agent runtime lives in
`src/SampleRepos/opencode/packages/opencode/src/session/`.

### 1.1 The step loop (`prompt.ts` → `runLoop`)

A `while (true)` loop, one **step** per iteration:

```
loop:
  filter compacted messages → find last user / assistant
  EXIT if the last assistant finished with no pending tool calls
  handle: subtask (subagent) | compaction task | context overflow → compact
  agent = agents.get(lastUser.agent)        // permission ruleset, model, maxSteps, prompt
  msgs  = reminders.apply(msgs, agent)      // inject system reminders
  build system prompt: env + instructions + skills + MCP
  create assistant message + processor
  tools = SessionTools.resolve(agent, …)    // per-agent, permission-filtered
  result = processor.process({ system, messages, tools, model })
  result === "stop"     → break
  result === "compact"  → compaction.create(); continue
  result === "continue" → loop again (so tool results go back to the model)
```

The loop keeps going while the model emits tool calls; it exits when the model
returns a normal finish with no outstanding tool calls, or on stop/error.

### 1.2 The streaming processor (`processor.ts`)

`processor.process()` consumes **one** LLM stream (via the Vercel AI SDK) and
converts a flat event stream into typed, persisted **message parts**:

| Stream event | Becomes |
|---|---|
| `reasoning-start/delta/end` | `reasoning` part (streamed live) |
| `text-start/delta/end` | `text` part (the answer, streamed) |
| `tool-input-start/delta/end`, `tool-call` | `tool` part: `pending → running` |
| `tool-result` / `tool-error` | `tool` part: `completed` / `error` (with `{title, output, metadata}`) |
| `step-start` / `step-finish` | `step` parts + usage/cost/token accounting |

Cross-cutting behavior baked into the processor:

- **Doom-loop detection** — if the last `DOOM_LOOP_THRESHOLD` (3) parts are the
  same tool with identical input, raise a `doom_loop` **permission** ask.
- **Overflow → compaction** — on `step-finish`, if token usage exceeds the
  model's context, set `needsCompaction`; the loop compacts and continues.
- **Snapshots** — git-like snapshot before/after each step; file changes become
  a `patch` part (used for diff view + revert).
- **Retry** — provider errors run through `SessionRetry.policy` (backoff, with a
  `retry` status surfaced to the UI).
- **Abort/interrupt** — `Effect.onInterrupt` marks `aborted`; `cleanup()` settles
  or fails in-flight tool calls and finalizes the message.

### 1.3 Tools (`tool/tool.ts`, `session/tools.ts`)

A tool is a `Def`:

```ts
{ id, description, parameters (schema), execute(args, ctx) → { title, metadata, output, attachments } }
```

The **context** (`ctx`) passed to `execute` is the important part:

- `ctx.abort` — an `AbortSignal` so long tools stop promptly on cancel.
- `ctx.metadata({ title, metadata })` — **live progress** streamed into the tool
  part while it runs (e.g. a shell tool streaming child output).
- `ctx.ask(request)` — request a **permission** (`read` / `edit` / a pattern);
  blocks until the ruleset auto-decides or the user answers.
- `ctx.messages` — the conversation so far.

`SessionTools.resolve()` builds the per-agent tool set: filters by the agent's
permission ruleset, wires `ctx.ask` to `permission.ask`, runs
`tool.execute.before/after` plugin hooks, and enforces the `abort` signal. Bad
arguments throw a typed `InvalidArgumentsError` whose message tells the model to
**rewrite the input** (self-correction instead of a dead turn).

### 1.4 Agents & permissions

- **Agents** (`agent/agent.ts`) are named configs: `mode` (`primary`/`subagent`/
  `all`), `permission` ruleset, `model`, `prompt`, `temperature`, `steps`
  (max steps), `tools`. Built-ins include **default**, **plan** ("disallows all
  edit tools"), **explore**, plus internal ones (compaction, title, summary).
- **Permissions** (`permission/`) are **rulesets** of `allow`/`ask`/`deny` by
  pattern. A tool's `ctx.ask` consults the merged agent+session ruleset; `ask`
  prompts the user, `allow` runs silently, `deny` fails the call.
- **Subagents** — a `task` tool spawns a **child session** running another agent
  (e.g. "explore") with its own loop; its result returns as the tool output.

### 1.5 Compaction (`compaction.ts`)

When context overflows, a compaction "turn" summarizes the conversation into a
`compaction` part (a `tail_start_id` marks where live history resumes), then the
loop optionally auto-continues with a synthetic "continue or ask" prompt.

### 1.6 File-writing tools (`tool/write.ts`, `tool/edit.ts`, `tool/apply_patch.ts`)

opencode's write path is a good template for doing file creation *safely*:

- **`write`** creates or overwrites a file. Before touching disk it checks
  whether the file `exists` (add vs change), builds a unified **diff** of the
  old vs new content, and calls `ctx.ask({ permission: "edit", … })` with that
  diff — so the user approves against a preview, not a blind path. On success it
  emits a `change`/`add` event.
- **`edit`** does targeted find-and-replace within an existing file (same
  permission + diff-preview flow), and **`apply_patch`** applies a multi-file
  patch. All three route through the agent's **permission ruleset** (§1.4), so
  an agent in a read-only mode simply can't call them.

The reusable ideas for Leslie: resolve the path, **diff-preview before writing**,
gate on a permission, and distinguish create from overwrite.

---

## 2. What Leslie already has

Leslie's loop is a leaner version of the same shape:

| opencode | Leslie today |
|---|---|
| `runLoop` step loop | [loop.js](../src/main/agent/loop.js) `runConversation` — `for step in 0..maxToolCalls` |
| Stream → parts | [streamTurn.js](../src/main/agent/streamTurn.js) — streams `summary`/`details`/`thinking`/`tool_calls` |
| Doom-loop / step guards | [loopGuards.js](../src/main/agent/loopGuards.js) — `recordToolRound` (stuck/runaway), `intentNudge`, `forceAnswer` |
| Permission ruleset | [toolPolicy.js](../src/main/agent/toolPolicy.js) — **binary** plan-mode gating + `wrapUntrusted` |
| `ctx.ask` permission | [agent/index.js](../src/main/agent/index.js) `makeCtx` → `ctx.confirm(message)` (single yes/no) |
| Agents/modes | `config.planMode/agentMode` → chat / plan / agent |
| Tool `Def` + `ctx` | tools: `{ name, description, parameters, run(args, ctx) }` |
| Tool cards / reasoning UI | the new sidebar (`agent:tool` start/end, reasoning block, confirm cards) |

**Gaps** (what opencode has that Leslie doesn't):

1. **No cancellation** — a running turn/tool can't be stopped. No `AbortSignal`.
2. **Thin tool context** — `run(args, ctx)` gets only `confirm`/`openUrl`; no
   `abort`, no live progress, no structured result (`{title, output}`).
3. **Binary permissions** — plan-mode on/off + one confirm dialog, versus
   granular allow/ask/deny rulesets by pattern.
4. **No subagents** — modes only; no spawning a scoped child loop.
5. **No compaction** — long conversations will eventually blow the context.
6. **No retry policy** — a transient provider error fails the whole turn.
7. **No self-correcting tool errors** — a bad-args call returns a plain string,
   not a typed "rewrite the input" signal.
8. **Can't create arbitrary files** — `create_document` makes rich-format docs
   (docx/pdf/xlsx/…) but only by base filename into `config.docsDir`; there's no
   way to write a plain **text/code/config file at a chosen path** (a `write`/
   `edit` equivalent), and the read-only fs tools obviously can't either.

---

## 3. What to adopt (and what to skip)

Leslie is a **desktop companion**, not a code editor, so skip the *code-editor*
machinery — **git snapshots/patch parts, worktrees, LSP**. But **file creation
itself is wanted** (§3 was revised for this): a companion that can save a note,
write a config, or drop a script to disk is squarely in scope. What we skip is
the editor scaffolding *around* it, not the ability to write files. Adopt the
runtime-agnostic improvements, ordered by value-for-effort:

| Adopt | Why it fits Leslie |
|---|---|
| **A. Cancellation (AbortSignal)** | You already added collapse/Stop affordances; users need to abort a long turn (esp. deep research). Highest value. |
| **B. Rich tool context** (`abort`, `progress`, structured result) | Feeds the new tool cards live; unlocks deep-research progress; cleaner than string outputs. |
| **C. Permission rulesets** | Replace binary confirm with allow/ask/deny patterns (e.g. allow `git status`, ask for `rm -rf`, deny nothing). **Prerequisite for safe file writing (H).** |
| **D. Retry policy** | Local model servers hiccup; one retry with backoff avoids dead turns. |
| **E. Self-correcting tool errors** | Typed invalid-args → model rewrites; fewer wasted rounds. Bad file paths self-correct instead of dying. |
| **F. Subagents** | A `task` tool that runs a scoped child loop — pairs perfectly with the deep-research engine as a "researcher" subagent. |
| **G. Compaction** | Keep long companion chats alive past the context window. |
| **H. File creation (`write_file` / `edit_file`)** | The requested capability: write plain text/code/config files at a chosen path, with diff-preview approval. Rides on C's permissions, B's structured result, A's signal, and E's self-correction. |

---

## 4. Phased plan

### Phase A — Cancellation (AbortSignal through the loop)

- `agent/index.js` — `sendMessage(text, onEvent, mentionContext, { signal })`.
  Create an `AbortController` per turn; store it so a new IPC (`agent:cancel`)
  can abort it.
- `loop.js` — accept `signal`; check `signal.aborted` at the top of each step
  and before executing each tool; pass `signal` into `ctx`.
- `streamTurn.js` — pass `signal` to `fetch(...)` so the streaming response is
  cut off promptly.
- `tools/lib/*` (e.g. `deepSearch`, future `deep_research`) — thread `ctx.signal`
  into their own `fetch`/loops.
- **preload/main/renderer** — add `cancel()` (`window.leslie.cancel()` →
  `agent:cancel`), and a **Stop** button in the sidebar composer that shows while
  `streaming` (reuse the send-button slot). On abort, finalize the assistant
  message with an "interrupted" note.

### Phase B — Rich tool context + structured results

- Extend `makeCtx(onEvent)` in `agent/index.js` to also provide:
  - `signal` (from Phase A),
  - `onProgress(text)` → `onEvent({ type: 'tool', phase: 'progress', id, ... })`
    (loop.js already owns the `toolId`; pass a bound `onProgress` per call).
- `loop.js` — after `tools.run`, accept either a string (today) **or** a
  structured `{ title, output, metadata }`; use `title` for the tool-card label
  and `output` for the model-facing result. Keep back-compat with string returns.
- `renderer.js` — add a `phase === 'progress'` branch in `onToolCall` that
  updates the card's `.tc-detail` live (mirrors the deep-research plan §3.4).
- Migrate `run_command`/`deep_search` to emit progress; everything else keeps
  returning a string (auto-wrapped).

### Phase C — Permission rulesets (replace binary confirm)

- New `agent/permission.js`: a ruleset `{ allow: [patterns], ask: [patterns],
  deny: [patterns] }` with `evaluate(tool, args) → 'allow'|'ask'|'deny'`. Seed
  per-mode defaults (plan = deny effectful, agent = ask for `run_command`/
  `install_software`, allow read-only).
- `toolPolicy.js` — fold plan-mode gating into the ruleset (`deny` list) so
  there's one decision path.
- `makeCtx` — `ctx.ask({ tool, patterns, message })`:
  `allow` → run; `deny` → return a typed refusal string; `ask` → the existing
  `agent:confirm` flow (reuse the sidebar confirm card). Persist "always allow X"
  choices to settings so repeat approvals aren't needed.
- Config/UI — a Settings pane to edit the rulesets (later; ship code first).

### Phase D — Retry policy

- New `agent/retry.js`: classify errors from `streamTurn` (network/5xx/timeout =
  retryable; 4xx/abort = fatal). Retry the `streamTurn` call up to N times with
  exponential backoff; emit a `status`/`thinking` note ("retrying…") so the UI
  shows it. Port the shape of opencode's `SessionRetry.policy`.

### Phase E — Self-correcting tool errors

- Define `InvalidArgumentsError` (a small class) in `agent/`. Tool `run`
  functions throw it on bad args (or `loop.js` catches JSON/schema failures and
  synthesizes it). In `appendResults`, feed its message back as the tool result
  so the model rewrites the call instead of the turn dying.

### Phase F — Subagents (the `task` tool)

- New `tools/task.js`: `run({ agent, prompt }, ctx)` starts a **nested**
  `runConversation` with a restricted tool set + its own guards, forwarding child
  progress up via `ctx.onProgress`, returning the child's final answer as output.
- Wire the **deep-research engine** (see [deep-research-plan.md](./deep-research-plan.md))
  as a built-in subagent/tool so "research X deeply" spawns a scoped loop.
- Guard recursion depth and total step budget.

### Phase G — Compaction

- `agent/compaction.js`: track token usage from `streamTurn` responses; when it
  crosses a threshold (config), summarize older turns via one LLM call into a
  compact system note, drop the raw history behind a marker, and continue. Store
  the summary in [conversations.js](../src/main/conversations.js). Auto-trigger
  from `loop.js` between steps, mirroring opencode's `needsCompaction` → compact
  → continue.

### Phase H — File creation (`write_file`, later `edit_file`)

The requested capability. **Do this after Phase C** — permission rulesets are
what make arbitrary file writes safe; without them we'd only have the single
blunt confirm, which is a regression waiting to happen for something destructive.

- **New tool `tools/writeFile.js`** — `name: 'write_file'`, **`readOnly: false`**
  (so plan mode filters it out automatically, and agent mode gates it).
  - `parameters`: `path` (string — absolute, `~/…`, or a named location),
    `content` (string), optional `overwrite` (boolean, default `false`).
  - `run({ path, content, overwrite }, ctx)`:
    1. Resolve with [`osPaths.resolvePath`](../src/main/tools/lib/osPaths.js) (same
       primitive the read tools use — keeps behavior consistent and OS-aware).
    2. **Confinement check** — the resolved path must sit under a configured
       write root (see config below); otherwise deny with a clear message.
    3. **Overwrite guard** — if the file exists and `overwrite` isn't set, don't
       clobber: request approval (below) framed as "overwrite X?".
    4. **Diff-preview approval** — build a small unified diff (old vs new, or
       "new file") and `ctx.ask({ tool: 'write_file', path, diff, … })` so the
       confirm card shows *what will change*, mirroring opencode's `write`. On
       deny, return a typed refusal string (Phase E) — never write.
    5. `fs.mkdir(dirname, { recursive })` then `fs.writeFile`. Return a
       structured result (Phase B) `{ title: 'Wrote <path>', output: '<n> bytes
       written' }` so the tool card reads cleanly.
  - Reject binary/oversized content (`content` non-string, or `> fsWriteMaxBytes`)
    with a typed error the model can correct (Phase E).

- **Config** (`config.js`, default *closed* like `agentMode`):
  - `fsWriteEnabled` (`LESLIE_FS_WRITE`, default off) — master switch; the tool
    only registers in `tools/index.js` `agentTools` when on.
  - `fsWriteRoots` (`LESLIE_FS_WRITE_ROOTS`) — allowed roots (default:
    `config.docsDir` + a scratch/workspace dir). Writes outside → denied, or
    `ask` with a louder warning, per the ruleset.
  - `fsWriteMaxBytes` (default e.g. 512 KiB).

- **Permissions (Phase C)** — seed defaults: `deny` system/dangerous paths
  (`/etc`, `/usr`, `~/.ssh`, `C:\Windows`, dotfiles like `.bashrc`), `allow`
  inside `fsWriteRoots` for *new* files, `ask` for overwrites and anything else.
  Persist "always allow this folder" like other approvals.

- **UI** — the confirm card renders the diff/preview (path, create-vs-overwrite,
  byte count, first N lines). The `write_file` tool card gets an icon
  (`fa-file-pen`) in `renderer.js`'s `TOOL_ICON`.

- **`create_document` stays** for rich formats (docx/pdf/xlsx); optionally give it
  an `path`/`dir` param so it can target a folder too, sharing the same
  confinement + approval path.

- **Follow-on `edit_file`** — targeted find-and-replace in an existing file
  (opencode's `edit.ts`): read → replace exact string(s) → same diff-preview
  approval → write. Add once `write_file` is solid.

---

## 5. Mapping cheat-sheet (opencode → Leslie)

| opencode | Leslie target |
|---|---|
| `processor.process` (stream → parts) | `streamTurn` (already emits typed events) |
| `runLoop` result `continue/stop/compact` | `runConversation` return + a new `compact` branch (Phase G) |
| `ctx.abort` | `ctx.signal` (Phase A) |
| `ctx.metadata()` progress | `ctx.onProgress()` (Phase B) |
| `ctx.ask()` permission | `ctx.ask()` ruleset + `agent:confirm` (Phase C) |
| `SessionRetry.policy` | `agent/retry.js` (Phase D) |
| `InvalidArgumentsError` | same, small class (Phase E) |
| `task` tool / subagents | `tools/task.js` (Phase F) |
| doom-loop permission | already `loopGuards.recordToolRound` — keep |
| `compaction.ts` | `agent/compaction.js` (Phase G) |
| `write.ts` (create/overwrite + diff-preview) | `tools/writeFile.js` (Phase H) |
| `edit.ts` (find-and-replace + diff-preview) | `tools/editFile.js` (Phase H follow-on) |
| `apply_patch.ts`, snapshots/worktrees, LSP | **skip** (code-editor scaffolding) |

---

## 6. Suggested order & risk

1. **A (cancel)** and **B (rich ctx/progress)** first — small, high UX payoff,
   and they unblock live deep-research progress + a Stop button.
2. **D (retry)** and **E (self-correct)** next — cheap robustness wins.
3. **C (permissions)** — medium effort; improves safety and reduces confirm
   fatigue. Ship the engine before the settings UI.
4. **C (permissions)** then **H (file creation)** together — H depends on C for
   safety, and file writing is likely the highest-value *new capability* here, so
   land the ruleset and immediately cash it in with `write_file`.
5. **F (subagents)** — do alongside the deep-research engine; they reinforce each
   other.
6. **G (compaction)** — last; only bites on very long sessions.

**Risks:** threading `AbortSignal` everywhere is invasive but mechanical; the
permission ruleset must default *closed* for effectful tools (don't regress the
current confirm safety). **File writing (H) is the sharpest edge** — it can
overwrite or clobber real user data, so it must ship *with* path confinement,
overwrite guards, diff-preview approval, and a default-off master switch; never
land `write_file` before Phase C's ruleset exists. Compaction summaries can lose
detail — keep the marker so nothing is silently dropped. None of this requires
the Effect runtime — Leslie's plain async/JS maps cleanly onto every pattern.

---

## 7. Verification

- **A**: start a long `deep_search`, hit Stop → turn ends promptly, message shows
  "interrupted", no orphaned spinning tool card.
- **B**: a tool card's detail line updates mid-run.
- **C**: plan mode denies `run_command`; agent mode asks once, "always allow"
  persists.
- **D**: kill the LLM endpoint for one request → it retries and recovers.
- **E**: force a bad-args tool call → model rewrites and succeeds next round.
- **F**: "research X deeply" spawns a subagent whose progress nests in the card.
- **G**: hold a very long conversation → it compacts and keeps responding.
- **H**: ask it to "save a note to ~/notes/todo.txt" → confirm card shows the
  diff/new-file preview; approve → file appears with exactly that content.
  Then: plan mode refuses `write_file`; a write to `/etc/hosts` is denied; a
  second write to the same file prompts an overwrite confirm; a path outside the
  write roots is blocked.
