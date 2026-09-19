# OpenClaw Desktop

A permanent local home for your AI, on [OpenClaw](https://github.com/openclaw/openclaw).
Double-click an installer, pick a model, press Start, chat. No Node, no Python, no
terminal, no cloud account required.

This repository is **an overlay, not a fork.** It holds only the files that sit on top of
upstream OpenClaw — an Electron shell, a boot self-heal doctor, a model panel, and a brain
discovery lane. Upstream is pinned and consumed as a dependency; nothing from it is copied
here.

```bash
git submodule add https://github.com/abuz8studios-ship-it/openclaw-desktop.git desktop/opc-1
```

Wiring: [integration/SUBMODULE.md](integration/SUBMODULE.md).

## Download

Binaries are **GitHub Release assets, never Git objects** —
[Releases](https://github.com/abuz8studios-ship-it/openclaw-desktop/releases):

| | |
| --- | --- |
| **Installer** | `OpenClaw-Desktop-OPC-1-Setup-1.2.2.exe` — 739 MB, app + Vulkan/CPU + CUDA engines |
| **Portable** | `Zait-OPC-1-Portable-1.2.2.exe` — 181 MB, one file, self-extracts on first run |

Verified download: `./integration/install.ps1` — refuses the file if the SHA256 does not
match [`release/manifest.json`](release/manifest.json).

## What's in the box

Everything below is in the shipped 1.2.2 binary. Nothing here is a roadmap item.

**Native MCP** — full MCP manager API, runtime config and harness. Add servers and use them
from a desktop app, no config file spelunking.

**Local inference, bundled** — llama.cpp ships inside: Vulkan, RPC, `mtmd` multimodal,
`llama-tts`, and 14 CPU microarchitecture builds from sandybridge to zen4 and
sapphirerapids, so an old laptop and a new workstation both get a fast path. Full list:
[`docs/ENGINE.txt`](docs/ENGINE.txt).

**60 extensions** ([`docs/EXTENSIONS.txt`](docs/EXTENSIONS.txt)):

- *Cloud providers* — anthropic, openai, google, microsoft, microsoft-foundry, xai, nvidia, alibaba, together, minimax, openrouter, litellm, clawrouter, github-copilot, copilot-proxy
- *Local engines* — llama.cpp (bundled), ollama, lmstudio, vllm, sglang
- *Hugging Face* — model catalogue and API, browse and pull GGUFs from the panel
- *Memory* — memory-core, active-memory, memory-wiki, logbook, workboard
- *Computer & web* — browser, cua-computer, canvas, document-extract, web-readability, file-transfer, geolocation
- *Voice & vision* — elevenlabs, deepgram, azure-speech, senseaudio, talk-voice, tts-local-cli, image-generation-core, fal, runway
- *Channels* — telegram, imap, webhooks, a2a, bonjour, device-pair
- *Secrets & policy* — vault, onepassword, policy, admin-http-rpc, crabbox, reef
- *Migration* — **migrate-claude**, migrate-hermes

**Skills** — the upstream skill system plus custodian skills for the jobs a desktop app
should do for itself: `add-model-provider`, `configure-channel`, `diagnose-gateway`,
`cloud-image-bake`.

**A home that repairs itself** — the boot doctor checks the workspace before the gateway
starts and restores anything damaged or deleted from a sealed template vault. The shipped
acceptance run deletes `SOUL.md` and `IDENTITY.md` and proves both come back byte-identical:
[`release/SMOKE_RECEIPT-1.2.2.json`](release/SMOKE_RECEIPT-1.2.2.json).

**Your state is yours** — everything lives in a writable per-user profile
(`%USERPROFILE%\.openclaw-OPC-1`, or wherever `OPC1_HOME` points), never inside installed
resources. Back it up by copying a folder. Works fully offline once a model is downloaded.

## The overlay

| File | What it does |
| --- | --- |
| `desktop/electron-main.cjs` | Native window, bundle-local gateway, per-user profile, boot doctor hook |
| `desktop/abuz8-doctor.cjs` | Boot self-heal and workspace restore |
| `desktop/abuz8-body-vault/` | Sealed templates the doctor restores from |
| `desktop/abuz8-models.cjs` + `.html` | Model panel: local GGUF scan, one-click download, engine start/stop, GPU layers, low-RAM mode |
| `desktop/models-registry.cjs` | Normalized adapter/model selection persisted to the profile |
| `desktop/brain-discover.cjs` | Finds already-running local inference servers and binds them as providers |
| `desktop/abuz8-daemon-worker.cjs` | Background worker lane |
| `desktop/voice-pack.json` | Offline voice bundle manifest |

~180 KB of overlay. Everything else at runtime is upstream OpenClaw.

## Honest state

- **Windows 10/11 x64 only.** macOS and Linux are *not built* — a statement of fact, not a
  promise that the `.exe` runs elsewhere. Cross-platform plan: [`docs/ABUZ8_PLATFORM_SUPPORT.md`](docs/ABUZ8_PLATFORM_SUPPORT.md).
- **Unsigned build** — SmartScreen will say "More info → Run anyway".
- **Voice**: the in-app one-click voice install needs a published download URL that does not
  exist yet. The voice pack is attached to the release; text chat, tools, browser and
  desktop control all work now.
- Five known cosmetic warts are listed in [`integration/SUBMODULE.md`](integration/SUBMODULE.md#known-warts)
  rather than quietly patched, so the source here matches the smoke-tested binary exactly.

## Upstream

Pinned to OpenClaw `2026.9.2`. Boundary and update procedure: [UPSTREAM.md](UPSTREAM.md).

Licensed MIT, same as upstream. Built by ABUZ8 LLC.
