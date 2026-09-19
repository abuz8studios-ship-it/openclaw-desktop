# Upstream boundary

## Pin

| | |
| --- | --- |
| Upstream project | [openclaw/openclaw](https://github.com/openclaw/openclaw) |
| Pinned version | `2026.9.2` |
| Consumed as | Prebuilt `dist/` inside the shipped bundle — never vendored into this repo |
| License | MIT (upstream and overlay alike) |

## The rule

**Nothing from upstream is copied into this repository.** Not `dist/`, not `extensions/`,
not `package.json`, not the docs. If a file exists in `openclaw/openclaw`, it does not
exist here.

This repo previously *was* a fork of openclaw/openclaw — 3.6 GB of tree to carry four
markdown files and a set of release assets. That is the confusion this layout removes.
What remains is the ~180 KB that is genuinely ours.

## What the boundary looks like at runtime

```
Zait OPC-1.exe
└── resources/
    ├── app/
    │   ├── dist/            ← upstream OpenClaw 2026.9.2, verbatim
    │   ├── electron-main.cjs    ← this repo
    │   ├── abuz8-doctor.cjs     ← this repo
    │   ├── abuz8-models.*       ← this repo
    │   ├── brain-discover.cjs   ← this repo
    │   ├── models-registry.cjs  ← this repo
    │   └── abuz8-body-vault/    ← this repo
    └── engine/              ← llama.cpp, platform-native
```

The overlay files are dropped beside upstream's `dist/` at package time. They import from
it; upstream never imports from them. The dependency arrow points one way, which is what
makes this a submodule rather than a fork.

## Updating the pin

1. Build upstream at the new tag, or take its published `dist/`.
2. Drop this repo's `desktop/` files beside it.
3. Run the clean-profile acceptance in [`docs/ABUZ8_BUILD_AND_RELEASE.md`](docs/ABUZ8_BUILD_AND_RELEASE.md).
4. Record the new pin here and in `release/manifest.json`.
5. Publish binaries as Release assets with checksums.

The overlay touches upstream through documented seams only — the gateway HTTP API, the
config file, and the extension/provider contracts. An upstream bump that keeps those
stable needs no overlay change.

## State, secrets, and what is never committed

User state lives in a writable per-user profile (`%USERPROFILE%\.openclaw-OPC-1`,
overridable with `OPC1_HOME`), never inside installed resources.

Never committed here: executable payloads, model weights, live state, OAuth credentials,
tokens, machine-specific config, `home/`, `.openclaw/`, `.env`, local databases.
Those belong in Release assets or a private delivery channel.
