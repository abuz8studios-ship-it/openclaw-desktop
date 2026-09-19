# ABUZ8 platform support

## What a GitHub download provides

The repository provides source, documentation, checksums, and release metadata.
Downloadable desktop applications are published separately under GitHub Releases.
A Windows release cannot be installed directly on macOS.

## Current verified state

| Product | Windows GUI | macOS GUI | Linux GUI |
| --- | --- | --- | --- |
| ABUZ8 Sovereign | Verified on owner machine | Not built | Not built |
| ABUZ8 OPC-1 / OpenClaw Desktop | Verified on owner machine | Not built | Not built |
| Hermes Desktop | Verified on owner machine | Upstream build path exists; ABUZ8 bundle not published | Upstream build path exists; ABUZ8 bundle not published |
| Portable launchers | Start local runtime; terminal-based | No | No |

“Not built” is intentional truth, not a promise that Windows binaries run
elsewhere. macOS and Linux require native packaging, native engine builds, and
platform smoke tests.

## Cross-platform target

The target is one product experience with platform-native artifacts:

- Electron/Tauri desktop shell;
- shared provider and model registry;
- shared memory, skills, tool, and permission contracts;
- native llama.cpp engine selected per operating system;
- optional remote vLLM/SGLang/OpenAI-compatible endpoints;
- signed installers and checksums for each platform.

The target does not mean every model runs on every computer. Hardware, model
license, VRAM, operating-system security, and accelerator support still apply.
