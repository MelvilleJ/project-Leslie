# LESLIE

An AI agent desktop companion built with Electron. LESLIE is a frameless,
transparent, always-on-top sprite character that lives on your desktop and
(eventually) talks to an AI agent.

## Run it

```bash
npm install      # installs Electron locally
npm start        # launch the companion
npm run dev      # launch with DevTools open
```

A tray icon (right-click) lets you show/hide or quit. Drag the character to
move it around the screen. Click the companion to toggle the chat input; type
and press Enter to talk (Esc hides the input).

## Connect a model

LESLIE talks to any **OpenAI-compatible** `/v1/chat/completions` server running
locally — no API keys, nothing leaves your machine. Point it at your server in
[`src/main/config.js`](src/main/config.js), or override at launch with env vars:

```bash
# defaults shown; only set what you need to change
LESLIE_BASE_URL=http://localhost:8080/v1 \  # llama-server default port
LESLIE_MODEL=local-model \                  # ignored by llama.cpp/LM Studio
LESLIE_SYSTEM_PROMPT="You are LESLIE..." \
npm start
```

Common base URLs: llama.cpp `:8080/v1`, LM Studio `:1234/v1`, Ollama `:11434/v1`.
If the bubble shows a connection error, the server isn't reachable at that URL.

## Install as an app (Arch / Hyprland)

```bash
npm run install:linux     # build + install to ~/.local/opt/leslie, enable services
systemctl --user start llama-router leslie
```

This installs per-user (no root): the app, `leslie` and `leslie-server` in
`~/.local/bin`, launcher entries, icons, and the `leslie` systemd user service
that starts the app at login. The installed app reads
`~/.config/project-leslie/.env` (a link to this repo's `.env`).

### Model server: the shared llama-router service

LESLIE doesn't own a model server. It uses `llama-router`, a general systemd user
service running llama.cpp in router mode on `127.0.0.1:8080` that any app can
use (it serves every model in `~/models` through the OpenAI API at `/v1`).
`install:linux` sets it up if it's missing; to set it up on its own:

```bash
bash scripts/setup-llama-router.sh   # MODELS=… PORT=… to override ~/models and 8080
systemctl --user start llama-router
```

| File | Owner |
|---|---|
| `~/.config/systemd/user/llama-router.service` | the service; LESLIE never writes it |
| `~/.config/llama-router/presets.ini` | shared per-model settings; LESLIE rewrites only sections tagged `; managed by LESLIE` |
| `~/.config/project-leslie/llama-server.json` | LESLIE's profiles and model presets |

LESLIE writes its sections whenever you change its model settings and before it
starts or restarts the service. Another section is left alone unless it names a
model LESLIE configures, in which case LESLIE's version replaces it. A changed
presets file takes effect on the next service restart. If the service runs
elsewhere, set `unit`, `presetsFile`, `host` and `port` in `llama-server.json`.

### Everyday / Power profiles

| Profile | Default model | GPUs |
|---|---|---|
| Everyday (loaded at login) | gpt-oss-20b | RTX 3060 only |
| Power | Qwen3.8-27B | RTX 3060 + RX 9060 XT |

Switch with `/everyday` / `/power`, the model chip's picker, the tray's **Model**
menu, **Settings → Models & GPUs** (start/stop/restart, log, VRAM, per-profile model,
GPUs, context), or the terminal: `leslie-server` (interactive) /
`leslie-server power`. llama.cpp's `--fit` sizes GPU/RAM offload to each profile's
GPUs. Everyday's section carries `load-on-startup`, so the service loads it
whenever it starts, with or without LESLIE running.

### Modes

The mode button (and `/mode`, the tray, Settings) cycles **Chat** (conversation),
**Plan** (read-only, proposes a plan), **Agent** (runs commands, changes files) and
**Assistant** (`/assistant`): every message is a one-off task with agent tools and a
blank context — nothing carries over, and on pi it runs in a separate, sessionless pi
so your chat session is untouched. Good for voice: "Leslie, launch Warframe".

### Speech recognition

`bash scripts/setup-whisper.sh` builds whisper.cpp (CUDA) and runs Whisper
large-v3-turbo as the `leslie-whisper` user service on `127.0.0.1:8178` (~0.9 GB on
the RTX 3060, ~0.2 s per utterance). It starts before `llama-router`, so llama.cpp's
`--fit` sizes the Everyday model around it. Settings → Voice → Speech recognition
switches between it and the slower in-app model.

### Home display

On Hyprland the companion lives on one monitor (`LESLIE_HOME_MONITOR`, default
`HDMI-A-1`; Settings → Behaviour → Home display): she opens there, is pinned across
its workspaces, and a wake word brings her back there without taking focus.
Left-click the tray icon or run `leslie --toggle` (bind it to a key) to show/hide her.

## The pi engine (default)

LESLIE is a desktop GUI for the [pi](https://pi.dev) agent harness: pi runs the
agent (sessions, compaction, retries, every provider, skills, prompt templates,
extensions) and LESLIE adds her own tools, voice, memory and the mascot on top.
Install pi and log in to a provider once in a terminal (`pi`, then `/login`).

```bash
# LESLIE_PI_MODEL: blank = pi's default model; 'leslie' = LESLIE_BASE_URL; or provider/model
# LESLIE_PI_CWD:   where pi runs and stores sessions (default: home folder)
# LESLIE_ENGINE=native switches back to LESLIE's built-in loop.
LESLIE_PI_MODEL= LESLIE_PI_CWD=~ npm start
```

In the chat panel:

| | |
|---|---|
| Footer chips | model (click to switch) · 🧠 thinking level · context used (click for tokens/cost) |
| Enter / Shift+Enter | send / new line |
| Typing while LESLIE works | Enter steers her after the current step; Alt+Enter queues it for when she finishes |
| Esc or ⏹ while working | stop; queued messages come back into the editor |
| `!cmd` / `!!cmd` | run a shell command (output goes to context / stays private) |
| Paste an image | attach it to the next message |
| `/model` `/thinking` `/compact` `/new` `/resume` `/name` `/session` `/fork` `/clone` `/copy` `/export` `/autocompact` `/reload` | pi's session commands |
| `/your-template`, `/skill:name`, extension commands | listed in the `/` menu and run by pi |

Tool cards expand to show their output, extension dialogs (select / confirm /
input / editor) appear inline, and **Settings → Sessions** lists pi's sessions
for the working folder, the same ones `pi --resume` shows. LESLIE reopens the
last session on launch. See [docs/pi-integration.md](docs/pi-integration.md).

## Tools (web search via SearXNG)

LESLIE can call tools through the OpenAI tools API. The first tool is
`web_search`, backed by your own **SearXNG** instance.

```bash
LESLIE_SEARXNG_URL=http://localhost:8888 \  # your SearXNG base URL
LESLIE_TOOLS=0 \                            # set to disable tools entirely
npm start
```

Requirements:

- **The model/server must support tool calling** (the OpenAI `tools` API).
  llama.cpp's `llama-server`, LM Studio, and Ollama support it with
  tool-capable models (Qwen, Llama 3.1+, Hermes, …).
- **SearXNG must have JSON output enabled** — add `json` to `search.formats`
  in its `settings.yml`, or queries come back as 403/format errors.

Tools available:

- `web_search` — searches SearXNG and feeds results back so the model can answer
  in the chat bubble.
- `open_url` — opens a web page in LESLIE's detail window ("open example.com").
- `open_search` — opens SearXNG results in the detail window to browse
  ("look up …", "show me results for …").

Tool use shows in the thought bubble (`🔧 web_search(…)`). Add more tools by
dropping a module in [`src/main/tools/`](src/main/tools/) that exports
`{ name, description, parameters, run(args, ctx) }` and listing it in
[`tools/index.js`](src/main/tools/index.js). `ctx.openUrl(url)` drives the window.

## Detailed responses (the second window)

Set `LESLIE_DETAILED=0` to turn this off; on by default. The model is asked to
reply with a short `<summary>` (shown in the bubble) and, for longer answers, a
`<details>` section. Whenever details are produced, a **second window opens
automatically** with the full answer (latest answer only). That same window
doubles as a web viewer: `open_url` / `open_search` load real pages into it
(via a `<webview>`, so sites that block iframes still render). Close it any time —
it hides and is reused next time.

## Learning mode (remembers preferences across sessions)

On by default. LESLIE remembers durable facts about you — your name, preferred
units, tone, recurring interests — and injects them into the system prompt every
session so replies stay personalized. Everything is stored locally in
`leslie-memory.json` in Electron's `userData` dir (e.g.
`%APPDATA%/LESLIE/leslie-memory.json` on Windows); nothing leaves your machine.

Memories are captured two ways:

- **The `remember` tool** — the model saves a preference when you state one
  ("remember I prefer Celsius"). Shows in the thought bubble as `🔧 remember(…)`.
  Needs a tool-capable model/server (same requirement as the other tools).
- **Background extraction** — after every few turns, a quiet, non-streaming model
  call distills any *new* lasting preferences from the conversation and saves them
  (tagged `auto`). It runs fire-and-forget, so it never slows down a reply, and
  works even when tool-calling is off.

Control it from the **tray menu**: toggle **Learning mode** on/off, **View
memories…** (opens the list in the detail window), or **Forget all memories**.

```bash
LESLIE_LEARNING=0 \      # disable learning entirely (default on)
LESLIE_LEARN_EVERY=3 \   # run background extraction every N turns (0 = off; tool still works)
npm start
```

## Voice (wake word + dictation)

Hands-free, fully local, no cloud and no API keys. A hidden "voice window" runs
the whole audio pipeline so the companion UI stays light:

```
mic → energy VAD → Whisper (local or server) → wake-word match
```

Whisper runs either **locally** (transformers.js, WebGPU/WASM — the default, no
setup) or on an external **whisper server**. Switch with `LESLIE_STT_BACKEND=server`
and point `LESLIE_STT_SERVER_URL` at any OpenAI-compatible `/audio/transcriptions`
endpoint (whisper.cpp's `whisper-server`, faster-whisper-server, speaches, LocalAI,
…). The voice window WAV-encodes each utterance and POSTs it to the server.

Say **"Hey Leslie, …"** and the companion **unhides from the tray**, your words
**type into the input**, and the message sends. Say just "Hey Leslie" to wake it,
then speak your command. Or click the 🎤 button (or `/listen`) to dictate one
utterance without the wake word. `/voice off` / `/voice on` toggle listening.

Setup / notes:

- Needs the bundle: `npm run build:voice` (runs automatically via `prestart`).
  It bundles the pipeline and copies the onnxruntime wasm into `src/renderer/ort/`.
- **Local backend's first run downloads the Whisper model** (~40 MB,
  `Xenova/whisper-tiny.en`) from Hugging Face, then caches it. After that it works
  offline. The server backend downloads nothing.
- Tunables (env): `LESLIE_VOICE=0` (disable), `LESLIE_WAKE_WORD`, `LESLIE_STT_MODEL`,
  `LESLIE_WAKE_TIMEOUT_MS`, `LESLIE_VOICE_AUTOSEND=0` (type but don't auto-send).
- Server backend (env): `LESLIE_STT_BACKEND=server`, `LESLIE_STT_SERVER_URL`,
  `LESLIE_STT_SERVER_MODEL`, `LESLIE_STT_SERVER_API_KEY`.
- No text-to-speech yet — responses stay visual (the summary bubble).

## Project layout

```
src/
  main/
    main.js           Electron main process — windows, tray, IPC, lifecycle
    agent.js          Streaming chat client + agentic tool loop + stream parser
    config.js         Endpoint, model, SearXNG, tool/detail/voice toggles (env-overridable)
    tools/            web_search, open_url, open_search + registry (index.js)
  voice/
    voice.js          Voice pipeline (mic + VAD + Whisper); bundled by build:voice
    wakeword.js       Pure fuzzy wake-word matcher (unit-tested)
  preload/
    preload.js        Bridge for the companion window (window.leslie)
    detailPreload.js  Bridge for the detail window (window.detail)
    voicePreload.js   Bridge for the hidden voice window (window.voiceBridge)
  renderer/
    index.html / renderer.js / styles.css   The companion (sprite, bubbles, input, mic)
    detail.html / detail.js / detail.css     The detail window (text + <webview>)
    voice.html        The hidden voice window (loads voice.bundle.js — generated)
scripts/
  build-voice.js         esbuild bundle of the voice pipeline + ORT wasm copy
  build-spritesheet.py   Upscale an animation sheet with Real-ESRGAN (see Sprites)
assets/
  animations/<name>/     Per-animation spritesheet.png + spritesheet.css
                         (idle, thinking, tools); .src.png/.src.json are originals
tools/
  realesrgan/            Real-ESRGAN ncnn binary (gitignored; download separately)
```

## Architecture notes

- **Process split:** the renderer never touches Node/Electron APIs directly.
  It calls `window.leslie.*` (defined in `preload.js`), which forwards to the
  main process over IPC. `contextIsolation` and `sandbox` are on.
- **Agent:** `src/main/agent.js` is a thin client over an OpenAI-compatible
  chat endpoint. It keeps conversation history, streams replies, splits the
  model's reasoning from its answer, and runs an **agentic tool loop** (offer
  tools → execute any `tool_calls` → feed results back → repeat until a final
  answer). `ipcMain.handle('agent:message', ...)` relays answer deltas on
  `agent:chunk` and reasoning/tool activity on `agent:think`. `agent:reset`
  clears history.
- **Tools:** `src/main/tools/` — each tool exports
  `{ name, description, parameters, run }`; `tools/index.js` is the registry.

## Next steps

- [ ] More sprite animations per state (talking; idle + thinking done).
- [ ] Persist conversation history across restarts.
- [ ] Dedicated tray icon asset.
- [ ] Packaging (electron-builder / electron-forge).
