# Guided Install: Implementation Plan

How someone with no coding experience goes from downloading LESLIE to talking
to her, on any Linux desktop and any GPU, without touching a terminal or a
`.env` file. LESLIE stays an Electron app; the guided setup is a first-run
window inside it.

---

## 1. Goals and non-goals

**Goals**

- One download, double-click, follow the screens, done.
- Works on NVIDIA, AMD, Intel and CPU-only machines, with one or several GPUs.
- Every choice the setup makes can be changed later in Settings, and setup can
  be re-run or a single part repaired.
- Nothing needs root except installing missing system packages, and that asks
  for a password through polkit, never a terminal.
- An existing hand-built install (this machine) is detected and adopted, never
  overwritten.

**Non-goals (for now)**

- Windows and macOS. Linux with systemd and a Wayland or X11 desktop only.
- Docker. Native binaries plus systemd user units remain the only path; a
  Compose file for running the model servers on another machine can come later.
- Building anything from source on the user's machine.

---

## 2. What gets installed, and from where

| Component | Today | After |
|---|---|---|
| LESLIE app | repo checkout, `npm run install:linux` | AUR package (Arch, primary) and a tarball/AppImage for other distros |
| llama.cpp | `llama-server` on PATH (AUR `llama-cpp`) | Prebuilt release tarball downloaded by setup, matched to the GPU |
| Speech (Whisper) | whisper.cpp built locally with CUDA `sm_86` | Python sidecar via `uv`, CUDA wheels on NVIDIA, CPU elsewhere (see 6.3) |
| Vision | `uv` venv, `onnxruntime-gpu` | Same, with a CPU variant so AMD/Intel/no-GPU do not pull CUDA wheels |
| pi | installed by hand, `/login` in a terminal | Bundled at a pinned version, run with Electron's Node (see 6.4) |
| uv | `pacman -S uv` | Standalone `uv` binary downloaded by setup if missing |
| Models | files dropped in `~/models` by hand | Picked from a curated catalog and downloaded with progress |
| Desktop tools | assumed present (`grim`, `slurp`, `wf-recorder`, `playerctl`, `mpv`, `yt-dlp`, `wl-clipboard`) | Checked; missing ones installed via polkit or their features greyed out |

### llama.cpp builds available

The `bNNNNN` releases on ggml-org/llama.cpp ship Linux x64 tarballs for each
backend. Setup picks one:

| Hardware | Build | Needs on the host |
|---|---|---|
| NVIDIA | `ubuntu-cuda-12.8-x64` + matching `cudart-…` tarball | NVIDIA driver only (cudart bundles the runtime) |
| NVIDIA, new driver | `ubuntu-cuda-13.4-x64` + `cudart-…` | Driver new enough for CUDA 13 |
| AMD | `ubuntu-vulkan-x64` (default) | Mesa Vulkan (RADV), present on almost every desktop |
| AMD with ROCm installed | `ubuntu-rocm-10.0-x64` (opt-in) | `/opt/rocm` runtime |
| Intel | `ubuntu-vulkan-x64` | Mesa Vulkan (ANV) |
| Mixed vendors (e.g. RTX + Radeon) | `ubuntu-vulkan-x64` | Sees every card as `VulkanN` |
| No GPU | `ubuntu-x64` (CPU) | nothing |

The builds are tagged prerelease and appear daily, so LESLIE pins a tested
build number per LESLIE release (`setup/pins.json`) and offers an update
button rather than following nightly.

Mixed-vendor machines that want CUDA on the NVIDIA card and Vulkan on the
other (this machine's `CUDA0,Vulkan0`) need a custom build; setup offers
"Use my own llama-server" for that, which is how this machine is adopted.

---

## 3. Getting the app onto the machine

1. **Arch (AUR `leslie`, primary).** Installs to `/usr/lib/leslie`, a launcher
   entry, icons. No units, no downloads: those are per-user and done by setup.
2. **Other distros: tarball.** Extract anywhere and run `leslie`. The first
   setup screen offers "Add LESLIE to my applications", which writes the
   launcher entry and icons into `~/.local/share` (what `install-linux.sh`
   does today, moved into the app).
3. **AppImage** is optional: it needs FUSE 2, which several distros (Arch
   included) no longer ship by default, so it is a convenience, not the main
   route.

The installed app must not depend on a source checkout. Today it does in two
places: the `.env` symlink back into the repo (`install-linux.sh:59`) and
`setup-vision.sh` installing from `$ROOT/vision`. Both go: settings live in
`leslie-settings.json`, and `vision/` ships inside the app's unpacked resources.

### Where things live

```
~/.config/project-leslie/      leslie-settings.json, llama-server.json, setup-state.json
~/.local/share/leslie/
  engines/llama.cpp/b11718-vulkan/   downloaded llama.cpp build (one dir per build)
  engines/uv                         standalone uv, if it was missing
  sidecars/speech/                   uv venv
  sidecars/vision/                   uv venv
  models/llm/  models/speech/  models/vision/
~/.config/systemd/user/        llama-router, leslie-speech, leslie-vision, leslie (.service)
```

If `~/models` already holds GGUFs, setup offers to use that folder instead of
copying anything.

---

## 4. The setup window

A new window (`src/renderer/setup.html`, `setup.js`, `setup.css`,
`src/preload/setupPreload.js`), opened instead of the companion when
`setup-state.json` is missing or unfinished, and from **Settings → About →
Run setup again**. Same theme as Settings.

The user answers every question first; the long work (downloads, sidecar
installs) **starts in the background as soon as its choice is made**, so by
the last question most of it is done.

### Screens

1. **Welcome.** What LESLIE is, that everything runs on this computer, the
   disk space and time estimate (filled in after screen 3), a "Keep my current
   setup" link when an existing install is detected (section 7).
2. **System check.** A list with a green tick, amber "optional, missing" or red
   "needed" for each item: systemd user session, Wayland/X11, PipeWire,
   microphone, camera, free disk, RAM, desktop tools. One **Install missing
   packages** button runs the distro's package manager through `pkexec`
   (shows the exact command first). Anything optional can be skipped and the
   features that need it are greyed out with a reason.
3. **Your computer.** Detected GPUs with name, vendor and VRAM, system RAM,
   and the engine build chosen for them in plain words ("NVIDIA RTX 3060, 12 GB:
   using the CUDA engine"). An **Advanced** expander: pick another build, use an
   existing `llama-server`, or connect to a server on another machine (URL test
   button). Choosing here starts the engine download.
4. **Her brain.** Model cards from the catalog that fit this machine's tier,
   the recommended one preselected: name, download size, "fast / balanced /
   smartest", whether it can see images. Also: "Use a cloud model instead"
   (pi provider login inside the window, see 6.4). Choosing starts the model
   download.
5. **Listening.** Mic picker with a live level meter, "Say *Hey Leslie*" test
   that lights up on a match, speech engine chosen automatically (GPU when
   there is room, CPU otherwise) with an override. Skippable.
6. **Her voice.** TTS voice list with play buttons, speed slider. Skippable.
7. **Camera.** Off by default. Camera picker with a preview, then "Look at the
   camera" to enrol the owner (existing `presence/people.js` owner role), and
   the guest-mode explanation. Skippable.
8. **Desktop.** Home display picked from a picture of the monitor layout
   (Hyprland: `hyprctl monitors`; otherwise the Electron screen list), start
   at login, a toggle-shortcut recorder. Only shows what this desktop supports.
9. **About you.** Your name, how she addresses you, a persona preset
   (Friendly, Butler, Concise, Custom) that becomes the system prompt.
   Optional web search: SearXNG URL with a test button, or skip.
10. **Installing.** One row per task with its own progress bar, a "Show
    details" log, and **Retry** per failed task. Failures in optional parts do
    not block finishing.
11. **Ready.** Services started, the companion appears and greets the user by
    name. A short "things to try" card.

---

## 5. Main-process modules

New folder `src/main/setup/`, with no Electron imports except in `index.js`, so
a terminal CLI (`bin/leslie-setup`, like `bin/leslie-server`) can share it and
it can be unit-tested.

| Module | Job |
|---|---|
| `probe.js` | System check: systemd user bus, session type, PipeWire, `/dev/video*`, disk, RAM, each desktop tool on PATH, distro from `/etc/os-release` |
| `hardware.js` | GPU detection (6.1) and tier choice |
| `catalog.js` + `catalog.json` | Curated models per tier (6.2) |
| `pins.json` | Tested llama.cpp build, uv version, pi version, sidecar lockfiles |
| `download.js` | Resumable HTTP downloads (`Range`), sha256 check, free-space check, progress events, cancel |
| `engines.js` | Fetch and unpack the chosen llama.cpp build, run `llama-server --list-devices` |
| `sidecars.js` | Get `uv`, create the speech and vision venvs with the right extra (`cuda` or `cpu`), fetch their models |
| `units.js` | Write and enable the systemd user units; single source for what `setup-llama-router.sh`, `setup-whisper.sh`, `setup-vision.sh` and `install-linux.sh` do today (the scripts become thin wrappers around `leslie-setup`, or go) |
| `packages.js` | Map missing tools to distro package names (pacman, apt, dnf, zypper) and run one `pkexec` install |
| `state.js` | `setup-state.json`: choices made, each task's status, so a closed window or reboot resumes where it stopped |
| `index.js` | IPC for the setup window; runs tasks in dependency order with limited parallelism |

Every task is **check, then do**: it first looks for its result (unit exists,
file has the right hash, venv imports) and skips if present. That gives
resume, retry and repair for free.

### Task graph

```
probe ─▶ hardware ─▶ engine download ─▶ list-devices ─▶ write profile + presets ┐
              │                                                                  │
              ├─▶ model download ───────────────────────────────────────────────┤
              ├─▶ uv ─▶ speech venv + model ─▶ leslie-speech.service ──────────┤
              └─▶ uv ─▶ vision venv + models ─▶ leslie-vision.service ─────────┤
                                                                                 ▼
                                 llama-router.service (after the sidecars, so --fit
                                 sizes the model around their VRAM) ─▶ leslie.service
```

---

## 6. Details by part

### 6.1 Hardware detection

Two passes, because the right llama.cpp build has to be picked before there is
a `llama-server` to ask:

1. **Before download: vendor and VRAM.** Read `/sys/class/drm/card*/device/vendor`
   (`0x10de` NVIDIA, `0x1002` AMD, `0x8086` Intel). VRAM from `nvidia-smi
   --query-gpu=name,memory.total,compute_cap,driver_version` on NVIDIA and from
   `mem_info_vram_total` on AMD. Intel integrated graphics share system RAM and
   count as CPU-tier unless it is an Arc card. This picks the build (section 2)
   and the tier.
2. **After download: the truth.** `llama-server --list-devices` gives the exact
   device names (`CUDA0`, `Vulkan1`, …) and free memory for that build. Profiles
   are written from this, never from hard-coded names, and the Settings device
   dropdown is filled from it too (replacing `DEVICE_OPTIONS` in
   `settings.js:941` and the RTX 3060 labels in `main.js:244`,
   `renderer.js:994,1689`, `modelProfile.js:3`).

`gpus()` in `llamaServer.js:300` moves into `hardware.js` and gains Intel and
a device-name mapping.

**Tiers** (usable memory = largest single GPU's VRAM, or the sum across GPUs
when there are several; system RAM for CPU):

| Tier | Memory | Profiles created |
|---|---|---|
| CPU | no usable GPU | one: small model, 8-16k context |
| Small | 6-8 GB | one |
| Medium | 10-16 GB | one |
| Large | 20 GB+ on one card | one, plus an optional second |
| Multi-GPU | two or more cards | Everyday on the biggest card, Power across all |

This means profiles become a list instead of the fixed `['everyday','power']`
pair in `llamaServer.js:20`. A single-GPU machine gets one profile and the
Everyday/Power UI shows just one entry. The `/everyday` and `/power` commands
stay as aliases when those profiles exist.

### 6.2 Model catalog

`catalog.json` ships with each release, so the list is tested rather than
scraped live:

```json
{
  "id": "qwen3.5-9b-q4",
  "label": "Qwen 3.5 9B",
  "repo": "unsloth/…-GGUF",
  "files": ["…Q4_K_M.gguf"],
  "mmproj": "mmproj-F16.gguf",
  "bytes": 5800000000,
  "sha256": ["…"],
  "minMemoryGB": 7,
  "tiers": ["small", "medium"],
  "ctx": 32768,
  "cacheType": "",
  "toolCalling": true,
  "vision": true
}
```

Rules: tool calling is required (pi depends on it); prefer a model that fits
fully on the GPU with room for context over a bigger one that spills to RAM;
mark one recommended per tier. Entries are filled in and benchmarked by hand
for each release, starting from the models this machine already runs.

Context: the catalog's `ctx` only goes into the router preset (the server's
`-c`, which already lives in `llama-server.json`). LESLIE keeps reading the
real context size back from llama.cpp (`contextWindow.js`); nothing is added
to `.env`, Settings or pi's settings.

### 6.3 Speech recognition

whisper.cpp publishes no Linux binaries, and building it needs cmake plus the
CUDA toolkit, so it cannot be the default for non-coders. Options:

| Option | GPU | Setup cost |
|---|---|---|
| **A. Python sidecar with faster-whisper (recommended)** | CUDA via pip wheels (like vision's `onnxruntime-gpu`); CPU int8 elsewhere | Reuses the `uv` path vision already needs |
| B. In-app transformers.js (the existing `local` backend) | WebGPU in Electron, behind flags on Linux | None, but slower and less reliable |
| C. whisper.cpp built by setup | CUDA or Vulkan | Needs a compiler toolchain; keep only as "Advanced" |

With A, the sidecar answers the same OpenAI-style `/v1/audio/transcriptions`
endpoint, so `sttServerUrl` and the voice window do not change. It replaces
`leslie-whisper.service` with `leslie-speech.service`; this machine keeps its
whisper.cpp unit through the adopt path. B stays as the fallback when the user
skips the sidecar.

### 6.4 pi

Bundle pi as a pinned npm dependency (`@earendil-works/pi-coding-agent`)
and launch it with Electron's own Node (`process.execPath` plus
`ELECTRON_RUN_AS_NODE=1`), so there is no separate install and the LESLIE
extension is always run against a version it was tested with. `piCommand`
stays in Settings as "Use my own pi", which this machine keeps using
(`~/.local/bin/pi`, managed install).

To check before committing to this: that pi runs under Electron's Node
version, and that `--ignore-scripts` (which pi's own README uses) means it
needs no native build step.

Local models need no pi login: the default `piModel` is LESLIE's managed
server through the existing `leslie` provider (`pi/backend.js:88`), so setup
never writes pi's `auth.json` or `settings.json`. Cloud providers are an
optional screen-4 path that drives pi's login flow over RPC and shows its
prompts in the window.

### 6.5 Vision

`vision/pyproject.toml` gains optional extras: `cuda` (`onnxruntime-gpu[cuda,cudnn]`)
and `cpu` (`onnxruntime`), so AMD, Intel and CPU machines do not download
gigabytes of CUDA wheels. `models.py:25` already falls back to the CPU; the
Camera settings say which one is in use instead of only logging it.

### 6.6 Desktop tools

`packages.js` maps each tool to its package per distro and to the features
that need it:

| Tool | Feature |
|---|---|
| `grim`, `slurp` | screenshots, "what is this?" |
| `wf-recorder` | screen recording (VAAPI node picked from detected GPUs, not `renderD128`) |
| `playerctl` | media control |
| `mpv`, `yt-dlp` | play video |
| `wl-clipboard` | copy |
| `hyprctl` | home display, window control (Hyprland only; never offered elsewhere) |

The tools register only when their program exists, so a missing tool removes a
capability instead of failing mid-conversation.

---

## 7. Adopting an existing install (this machine)

Before writing anything, setup looks for: `llama-router.service`,
`leslie-whisper.service`, `leslie-vision.service`, `presets.ini`,
`llama-server.json`, GGUFs in `~/models`, `pi` on PATH, a `.env` next to the
app. When found, screen 1 offers **Keep my current setup**, which:

- marks those tasks done in `setup-state.json` without touching their files,
- keeps the existing `llama-server` and `pi` commands,
- imports any `.env` values into `leslie-settings.json` once (secrets into
  `safeStorage`), then leaves `.env` as an optional developer override,
- still runs the screens for anything missing.

Units and `presets.ini` follow the rule already in `setup-llama-router.sh`:
an existing file is kept, and LESLIE only rewrites sections tagged
`; managed by LESLIE`.

---

## 8. Prerequisites in the existing code

These have to land before the setup can work for anyone else:

1. **Remove personal defaults from `config.js`.** `baseURL` and `searxngUrl` go
   blank (blank SearXNG means `web_search` is off), `homeMonitor` and
   `recordMonitor` go blank (blank means the focused monitor), `cameraDevice`
   goes blank (blank means the first camera), `recordRenderNode` is detected.
   Keep your own values in your settings.
2. **Profile defaults in `llamaServer.js`** stop naming your models, devices and
   split; setup writes them.
3. **Settings for every key setup writes.** Most are already in `configStore.js`;
   add the voice on/off switch, docs folders and live docs.
4. **Store secrets with `safeStorage`.** `apiKey` (and later the IMAP password)
   are stored as plain text in `leslie-settings.json` today.
5. **Remove the `.env` symlink** from `install-linux.sh` and ship `vision/`
   inside the app resources.
6. **Feature flags from the probe:** voice, camera, screenshots and so on hide
   cleanly when their part was skipped.

---

## 9. After setup: repair, update, uninstall

- **Settings → About → Run setup again**, and a **Repair** button on each
  section (Models & GPUs, Voice, Camera) that re-runs that part's tasks.
- **Updates:** a LESLIE update can bump `pins.json`; Settings then shows
  "A newer engine is available" and swaps the build directory, keeping the old
  one until the new one loads a model.
- **Uninstall:** stops and removes the user units, deletes
  `~/.local/share/leslie/engines` and `sidecars`, and asks separately about
  models (large) and memories, settings and sessions (personal).

---

## 10. Phases

Each phase is usable on its own.

| Phase | Delivers | Main files |
|---|---|---|
| **0. Groundwork** | Section 8: no personal defaults, secrets in safeStorage, vision extras, no repo dependency | `config.js`, `configStore.js`, `llamaServer.js`, `install-linux.sh`, `vision/pyproject.toml` |
| **1. Setup core + CLI** | `src/main/setup/*` with probe, hardware, catalog, download, engines, units, state; `bin/leslie-setup` runs it end to end in a terminal | new `src/main/setup/`, `bin/leslie-setup`, tests |
| **2. Profiles as a list** | Any number of profiles, device names from `--list-devices`, GPU labels from detection | `llamaServer.js`, `settings.js`, `main.js`, `renderer.js`, `modelProfile.js` |
| **3. Setup window** | Screens 1-11 over the phase 1 modules, adopt path | `setup.html/js/css`, `setupPreload.js`, `main.js` first-run check |
| **4. Sidecars for every GPU** | Speech sidecar (6.3), vision CPU/CUDA, bundled pi | `vision/`, new `speech/`, `pi/rpcClient.js` |
| **5. Packaging** | AUR package, tarball, self-install of launcher entries | `package.json` build, `PKGBUILD` |
| **6. Repair, update, uninstall** | Section 9 | `settings.js`, `src/main/setup/` |

### Testing

- Unit tests for `hardware.js` against recorded `nvidia-smi` output and fake
  `/sys/class/drm` trees (NVIDIA only, AMD only, Intel iGPU, NVIDIA + AMD, none),
  tier choice, catalog filtering, package-name mapping, and the adopt check.
- `leslie-setup --dry-run` prints the task plan for a machine without doing it.
- End to end in a fresh user account on this machine (the GPUs are real, the
  home folder is empty), then in VMs for CPU-only and a Debian/Fedora desktop.

---

## 11. Decisions (taken)

1. **Speech engine:** the faster-whisper sidecar (`speech/`), CUDA through pip
   wheels or CPU. whisper.cpp stays supported for installs that already have it.
2. **pi:** bundled at the tested version (1.1.0). A pi on PATH still wins, so
   an existing install keeps its own.
3. **Distros:** the AUR package first, plus a tarball. Setup's package
   installs know pacman, apt, dnf and zypper.
4. **Model folder:** `~/.local/share/leslie/models`.

## 12. What was built, and where it differs from the plan

| Phase | Where | Notes |
|---|---|---|
| 0 | `config.js`, `configStore.js`, `llamaServer.js`, `vision/` | as planned |
| 1 | `src/main/setup/`, `bin/leslie-setup`, `speech/` | as planned |
| 2 | `llamaServer.js`, Settings, tray | Power became optional (an on/off switch) instead of profiles becoming a list: it gives single-GPU machines one profile without touching every caller of Everyday/Power |
| 3 | `src/renderer/setup.*`, `src/main/setup/index.js` | camera enrolment happens after setup (the vision service only runs once installed): "Start and teach her my face" opens Settings → Camera |
| 4 | `src/main/pi/launcher.js`, `cloud.js` | pi's RPC mode has no login, so cloud models use an API key LESLIE keeps sealed and hands to pi as the provider's environment variable |
| 5 | `packaging/` | `leslie-setup` and `leslie-server` run through `packaging/leslie-cli` on the app's own Electron, so no system Node is needed |
| 6 | `src/main/setup/maintain.js`, Settings → About | as planned |

Not done:

- `scripts/setup-*.sh` were kept as the hand-install path rather than turned
  into wrappers around `leslie-setup`; they write the same units.
- The repo has no LICENSE file; the PKGBUILD declares MIT (from package.json),
  and namcap wants the file installed under /usr/share/licenses/leslie.
- The other 51 env-only settings were not moved into Settings; setup only
  needed the ones it writes.
