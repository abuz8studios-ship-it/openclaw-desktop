# Using this as a submodule

## Add it

```bash
git submodule add https://github.com/abuz8studios-ship-it/openclaw-desktop.git desktop/opc-1
git commit -m "Add OpenClaw Desktop (OPC-1) as a submodule"
```

Resulting `.gitmodules` entry:

```ini
[submodule "desktop/opc-1"]
	path = desktop/opc-1
	url = https://github.com/abuz8studios-ship-it/openclaw-desktop.git
	branch = main
```

Clone with it:

```bash
git clone --recurse-submodules https://github.com/openclaw/openclaw.git
# or, in an existing checkout:
git submodule update --init --recursive
```

## What a consumer gets

A ~180 KB directory of overlay source, plus docs and release metadata. **No binaries, no
upstream copy, no model weights.** Cloning with the submodule costs you well under a
megabyte; a clone without it costs nothing and still builds normally.

The submodule is inert until you package. Nothing in it runs, imports, or hooks into a
normal upstream build.

## Packaging a desktop bundle

The overlay files drop beside upstream's built `dist/` in the Electron resources dir:

```
staging/resources/app/
├── dist/                    # upstream build output
├── electron-main.cjs        # ← copy from desktop/
├── abuz8-doctor.cjs         # ← copy from desktop/
├── abuz8-models.cjs         # ← copy from desktop/
├── abuz8-models.html        # ← copy from desktop/
├── abuz8-daemon-worker.cjs  # ← copy from desktop/
├── brain-discover.cjs       # ← copy from desktop/
├── models-registry.cjs      # ← copy from desktop/
├── voice-pack.json          # ← copy from desktop/
└── abuz8-body-vault/        # ← copy from desktop/
```

Point `electron-builder` at `staging/`, set `main` to `electron-main.cjs`, and ship the
native llama.cpp engine at `resources/engine/`. Full procedure and the clean-machine
acceptance gate: [`../docs/ABUZ8_BUILD_AND_RELEASE.md`](../docs/ABUZ8_BUILD_AND_RELEASE.md).

## Environment contract

Every path resolves from an environment variable or the OS user home. No hardcoded machine
path is ever required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPC1_HOME` | `%USERPROFILE%\.openclaw-OPC-1` | Profile root: state, logs, body, models |
| `OPC1_MODELS` | `<OPC1_HOME>\models` | GGUF cache |
| `OPC1_GATEWAY_PORT` | `18789` | Bundle-local gateway |
| `OPC1_PANEL_PORT` | `18790` | Model panel |
| `OPC1_PRODUCT_ROOT` | app resources dir | Update slots / backups |
| `OPC1_DISABLE_E_COMPAT` | unset | Set to `1` to disable optional extra-drive model scan (clean-room verification) |

Setting `OPC1_HOME` to a scratch dir gives a fully isolated instance that cannot touch an
existing OpenClaw install. That is how the shipped build is smoke-tested — see
[`../release/SMOKE_RECEIPT-1.2.2.json`](../release/SMOKE_RECEIPT-1.2.2.json).

## Known warts

Carried deliberately so that the source in this repo matches the published, smoke-tested
1.2.2 binary byte for byte. Each is cosmetic, guarded by an existence check, and queued for
the next build rather than patched silently here:

1. `desktop/abuz8-models.cjs` — `E_MODELS` hardcodes an extra model directory
   (`E:\ABU\MODELS\llm`) as an optional scan root. Guarded by `fs.existsSync` and
   disabled by `OPC1_DISABLE_E_COMPAT=1`; absent on every other machine. Should become an
   env var.
2. `desktop/abuz8-models.cjs` — `BRAINS_MIRROR` hardcodes a maintainer mirror path for
   `brains.json`. Same treatment.
3. `desktop/abuz8-models.cjs` — `PRODUCT_ROOT` probes `C:\ABUZ8-Agents\ABUZ8-OPC-1` before
   falling back to the app's own resources dir. The fallback is correct everywhere else;
   the probe should be dropped.
4. `desktop/abuz8-models.html` — panel copy names that maintainer directory in user-facing
   text. Should read as a generic "extra model folders" line.
5. `desktop/abuz8-models.cjs` — the `FIXED` table ships an opinionated preset of specific
   models and ports. Useful defaults, but they belong in a config file, not source.

None of these affect a clean install. Fixing them changes shipped behaviour, so they land
in 1.2.3 together with a fresh acceptance run.

## Why a submodule and not a fork

The overlay is ~180 KB. Carrying it as a fork meant cloning a full copy of upstream to hold
it — a repo that read as a divergent branch of OpenClaw when it is really a packaging layer
that sits on top and improves the experience. A submodule states the actual relationship:
upstream is a dependency, pinned and untouched; this is the thin layer above it.
