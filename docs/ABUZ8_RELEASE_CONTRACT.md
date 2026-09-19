# ABUZ8 bundled desktop release contract

ABUZ8 bundles are meant to be installed by a normal user, not assembled from a
terminal. A release is only ready when the user can:

1. download the installer for their operating system;
2. launch the desktop app;
3. complete onboarding in the app;
4. connect a subscription, an API provider, or a local model;
5. send a first message with memory and tools enabled.

## Platform truth

GitHub hosts source code and release files; it does not translate a Windows
`.exe` into a Mac application. Each platform needs its own build:

| Platform | Artifact | Native engine |
| --- | --- | --- |
| Windows x64 | `.exe` installer or portable package | llama.cpp Windows build |
| macOS Apple Silicon | `.dmg` / `.zip` | llama.cpp Metal build |
| macOS Intel | `.dmg` / `.zip` | llama.cpp Metal/CPU build |
| Linux x64 | AppImage / `.deb` | llama.cpp Vulkan/CUDA/CPU build |

The app shell, onboarding, provider adapters, memory format, skills, and tool
contracts should stay shared. The launcher, native engine, signing, and model
runtime are platform-specific.

## Bundle boundary

Every downloadable bundle must own its:

- desktop frontend and native launcher;
- backend/gateway;
- embedded runtime;
- local model engine;
- model manifest and optional model downloads;
- isolated state directory;
- skills, tools, permissions, logs, and recovery path.

Credentials and personal state are created during onboarding and must never be
copied from the maintainer machine into a release.

## Provider and model setup

The first-run UI should offer:

- hosted subscriptions and OAuth providers supported by the upstream project;
- API-key providers with encrypted local storage;
- OpenAI-compatible endpoints;
- local GGUF models through the bundled llama.cpp engine;
- a model catalog with hardware-aware recommendations.

Provider selection and model selection are separate. A provider adapter must not
assume a specific model server. Local inference may use llama.cpp today and can
later add vLLM or SGLang through the same OpenAI-compatible adapter contract.

## Performance controls

The model settings surface should expose validated presets for context length,
batch size, GPU layers, parallel requests, speculative decoding when supported,
and KV-cache quantization. Features such as MTP or tokenizer prefill must be
enabled only when the selected engine and model advertise support; unsupported
flags must be rejected with a visible explanation rather than silently ignored.

## Release gate

Do not publish a bundle as “easy install” until a clean-machine smoke test proves
that the installer launches, onboarding completes, a local or hosted model
answers, memory persists across restart, one tool executes, and uninstall leaves
user data under the documented retention policy.
