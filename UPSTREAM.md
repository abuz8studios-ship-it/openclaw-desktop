# Upstream boundary

## Pin

| | |
| --- | --- |
| Upstream project | [openclaw/openclaw](https://github.com/openclaw/openclaw) |
| Pinned version | `2026.10.7` |
| Consumed as | Published npm tarball `dist/` overlaid into the shipped bundle — never vendored into this repo |
| Bundled Node | `v24.22.1` (ABI 137) at `resources/runtime/node/` — 2026.10.7 requires `>=24.22.1 <25` |
| License | MIT (upstream and overlay alike) |

Pin history: `2026.9.2` (1.2.2 release) → `2026.9.5` → `2026.10.5` → `2026.10.7`.
Overlay sync for this pin: [`release/PIN_RECEIPT-2026.10.7.json`](release/PIN_RECEIPT-2026.10.7.json).
`release/manifest.json` still describes the shipped 1.2.2 binaries (9.2-era assets);
it changes only when new binaries are published.

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
    │   ├── dist/            ← upstream OpenClaw 2026.10.7, verbatim (one exception below)
    │   ├── electron-main.cjs    ← this repo
    │   ├── abuz8-*.cjs          ← this repo (doctor, models, registry, upgrade, ledger, …)
    │   ├── brain-discover.cjs   ← this repo
    │   ├── models-registry.cjs  ← this repo
    │   └── abuz8-body-vault/    ← this repo
    ├── runtime/node/        ← bundled Node v24.22.1 (ABI 137)
    └── engine/              ← llama.cpp, platform-native
```

The overlay files are dropped beside upstream's `dist/` at package time. They import from
it; upstream never imports from them. The dependency arrow points one way, which is what
makes this a submodule rather than a fork.

**The one exception inside `dist/`:** `dist/control-ui/opc1-side-calendar.js` — the sidebar
session calendar (source: [`desktop/control-ui/`](desktop/control-ui/)). It is a sidecar,
not a bundle patch: one self-contained file plus one `<script>` tag in
`dist/control-ui/index.html`, applied by `apply-side-calendar.cjs` after every overlay.
It reads session dates through the Control UI host's own seams
(`selectedAgentSessionRows`, `recencyAt ?? updatedAt ?? createdAt`) and never edits an
upstream bundle. The 2026.9.5 calendar was a deep bundle patch and died on every bump;
this is its successor.

## Updating the pin

1. Build upstream at the new tag, or take its published `dist/`.
2. Drop this repo's `desktop/` files beside it.
3. Re-apply the Control UI sidecar: `node desktop/control-ui/apply-side-calendar.cjs`.
4. Run the clean-profile acceptance in [`docs/ABUZ8_BUILD_AND_RELEASE.md`](docs/ABUZ8_BUILD_AND_RELEASE.md).
5. Record the new pin here; record release assets in `release/manifest.json` when binaries ship.
6. Publish binaries as Release assets with checksums.

The overlay touches upstream through documented seams only — the gateway HTTP API, the
config file, and the extension/provider contracts. An upstream bump that keeps those
stable needs no overlay change.

## State, secrets, and what is never committed

User state lives in a writable per-user profile (`%USERPROFILE%\.openclaw-OPC-1`,
overridable with `OPC1_HOME`), never inside installed resources.

Never committed here: executable payloads, model weights, live state, OAuth credentials,
tokens, machine-specific config, `home/`, `.openclaw/`, `.env`, local databases.
Those belong in Release assets or a private delivery channel.
