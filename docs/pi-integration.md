# pi Integration — LESLIE as a GUI for the pi agent harness

pi ([earendil-works/pi](https://github.com/earendil-works/pi), cloned to
`src/SampleRepos/pi`, gitignored) is a ~225k-line TypeScript agent harness.
Rather than port it into LESLIE's ~3.6k-line loop (a permanent fork to keep in
sync by hand), LESLIE drives pi as its **engine** and becomes its **GUI**. Every
pi feature is then available and stays current with `pi update`.

pi is the only engine; LESLIE's own agent loop has been removed.

---

## 1. How pi's harness works

| Layer | Package | What it owns |
|---|---|---|
| LLM API | `packages/ai` | One streaming API over OpenAI, Anthropic, Google, Bedrock, llama.cpp router, OAuth logins, model catalog |
| Agent core | `packages/agent` | The turn loop: stream → tool calls → results → next turn; steering/follow-up queues |
| Coding agent | `packages/coding-agent` | Sessions, compaction, retries, tools, skills, prompt templates, extensions, TUI/print/JSON/RPC modes |

**Loop.** A prompt is appended to the active branch; pi streams the assistant
reply, runs each tool call, records results, and repeats while tools or queued
messages need another turn. `agent_end` closes one low-level run; `agent_settled`
means nothing further (retry, overflow recovery, compaction, queued
steering/follow-ups) will happen automatically.

**Sessions** are JSONL *trees*: every entry has a parent, so you can branch
from any earlier point, fork, or clone. Compaction inserts a summary entry
while keeping the originals in the tree.

**Tools** (built in): `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`,
plus optional `codemode` / `tool_search`. pi has **no permission system** —
extensions add gating via the `tool_call` event.

**Extensions** are TS/JS modules loaded with `jiti`. They can register tools,
slash commands, providers, MCP servers, and hook every lifecycle event
(`before_agent_start`, `tool_call`, `tool_result`, `context`, `turn_end`, …).

**Interfaces** all share one runtime: interactive TUI, print, JSON event
stream, **RPC** (JSONL over stdin/stdout — built for GUIs and IDEs), and an
in-process SDK.

## 2. What's built (phase 1)

```
Renderer ──IPC──▶ main.js ──▶ agent.js ──▶ pi/backend.js
                                                 │  JSONL stdin/stdout
                                                 ▼
                                           pi --mode rpc --extension src/pi-extension/leslie.ts
                                                 │  JSONL over local socket
                                                 ▼
                                           pi/bridge.js ──▶ LESLIE tools / memory / confirm UI
```

| File | Role |
|---|---|
| `src/main/agent.js` | Thin facade over the pi backend (task mode → `runTask`) |
| `src/main/pi/rpcClient.js` | Spawns pi, LF-only JSONL framing (not `readline` — it splits on U+2028), id-correlated commands, events, extension-UI requests |
| `src/main/pi/backend.js` | Maps pi events → LESLIE's `thinking`/`summary`/`details`/`tool`/`confirm` events, links LESLIE conversations to pi session files, restarts pi when its settings change |
| `src/main/pi/bridge.js` | Unix socket / named pipe the extension calls back on, so tools run in the Electron main process |
| `src/main/pi/sessions.js` | Lists and reads pi's session files for the Sessions panel (active branch only) |
| `src/main/pi/policy.js` | LESLIE mode → pi tool set (below) and the bridged tool catalog |
| `src/pi-extension/leslie.ts` | Registers bridged tools and the `leslie` provider, injects persona/memory/reply-format/plan-mode as prompt sections, gates `bash`/`write`/`edit` |

**Bridged LESLIE tools** (no pi equivalent): `web_search`, `deep_search`,
`deep_research`, `open_url`, `open_search`, `open_app`, `create_document`,
`read_document`, `remember`, `install_software`, `set_mode`. Not bridged
because pi's are better: `run_command`→`bash`, `read_file`→`read`,
`list_directory`→`ls`/`find`, `write_file`→`write`/`edit`.

**Modes → pi tools**

| Mode | pi built-ins | LESLIE tools |
|---|---|---|
| chat | `read grep find ls` | all except `install_software` |
| plan | `read grep find ls bash edit write` (held to read-only and live docs) | read-only ones plus `doc_create`/`doc_edit` |
| agent | + `bash edit write` | all |

**Gating.** `bash` goes through LESLIE's allowlist + Approve/Deny bubble
(`agentShell.gate`). `write`/`edit` are allowed inside `fsWriteRoots`, asked
outside them. pi `confirm` dialogs from other extensions use the same bubble.

**Plan mode** (`tools/lib/planGuard.js`) refuses instead of asking: `bash`
runs only when every command in the line is read-only (`ls`, `cat`, `grep`,
`git log`, `systemctl status`, `pacman -Q`...) and any output redirect or `tee`
targets `/dev/null` or a `.md` file directly in the live docs folder;
`write`/`edit` only touch those `.md` files. A doc Leslie creates or edits in
plan mode is marked as a plan and shows an Approve section in the browser.
Approving switches to agent mode and sends the doc, as it stands after the
user's edits, as the next chat turn; her summary lands back on the doc.

**Verified** against pi 0.87.1 + local Qwen: streaming reply, thinking,
bridged tool (`open_url`), bash deny/approve, per-mode tool sets, cancel.

## 3. The GUI (phase 2 — done)

pi is the default engine. Everything pi's terminal UI does for a session is
reachable from the companion panel:

| pi TUI | LESLIE | RPC |
|---|---|---|
| Footer: model, thinking, context % | Chips in the composer row (click to change / for stats) | `get_state`, `get_session_stats` |
| `/model`, `/thinking` | Picker above the composer | `get_available_models`, `set_model`, `get_available_thinking_levels`, `set_thinking_level` |
| Typing while it works; Alt+Enter | Enter = steer, Alt+Enter = follow-up; queued bubbles + "n queued" chip; the reply splits at delivery | `steer`, `follow_up`, `queue_update` |
| Esc | Esc / ⏹ clears the queue back into the editor, then aborts | `clear_queue`, `abort` |
| `!cmd`, `!!cmd` | Same, with streamed output card | `bash`, `bash_execution_update` |
| Tool output | Expandable tool cards, live while running | `tool_execution_update/end` |
| Extension dialogs, notify, status, editor text | Inline cards, system lines, status line, input fill | extension UI sub-protocol |
| `/compact`, auto-compaction, retries | `/compact [focus]`, `/autocompact`, system lines with before/after tokens | `compact`, `set_auto_compaction`, compaction/retry events |
| `/new`, `/resume`, `/name`, `/fork`, `/clone`, `/export`, `/copy`, `/session` | Same commands; Settings → Sessions lists pi's session files | session commands |
| Prompt templates, skills, extension commands | Listed in the `/` menu, run by pi | `get_commands`, `prompt` |
| `pi --continue` | LESLIE reopens the last session on launch | `--session` |
| Images | Paste into the editor | `prompt.images` |

Removed with the native loop: LESLIE's separate conversation store (pi's
sessions replace it), its settings (temperature, max tool calls, tool RAG, loop
guards), and the direct `/research` pipeline (it now asks pi to use the
`deep_research` tool, so it runs on pi's model inside the session).

### Still open

- **Branch tree view** (`/tree`, `get_tree`): forking from any earlier message
  works; a visual tree of all branches does not exist yet.
- **Provider login**: pi's RPC has no `/login`; log in once with `pi` in a
  terminal.
- `extractMemories` uses LESLIE's own server (`baseURL`), not pi's model.
- Next: integrate LESLIE into the Arch Linux desktop.
