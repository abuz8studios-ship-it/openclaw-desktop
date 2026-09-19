# Building and releasing an ABUZ8 bundle

## Clean build inputs

Build from a clean checkout of this fork and the pinned upstream commit. Do not
copy `home`, `.openclaw`, Hermes state, model files, `.env` files, Telegram
tokens, OAuth caches, or local databases into the staging directory.

The staging directory should contain only:

- the desktop shell;
- the gateway/backend;
- the platform runtime;
- the native llama.cpp engine;
- public skills and plugins;
- a model manifest, not private model weights;
- empty state directories with safe defaults.

## Build matrix

Build each target independently:

```text
windows-x64       -> installer + portable package
macos-arm64       -> signed/notarized dmg + zip
macos-x64         -> signed/notarized dmg + zip
linux-x64         -> AppImage + deb
```

The release job must attach checksums and a machine-readable manifest containing
the upstream commit, ABUZ8 overlay commit, engine version, supported providers,
and minimum hardware requirements.

## Clean-machine acceptance

For every artifact:

1. install or extract on a clean machine/profile;
2. launch by clicking the application;
3. complete onboarding without a shell;
4. choose a hosted provider or install a compatible local model;
5. send a message and execute a harmless file/list tool;
6. restart and confirm memory persists;
7. verify logs contain no credentials;
8. uninstall and verify the documented state-retention behavior.

## Large files

Model weights and multi-gigabyte runtime payloads do not belong in normal Git
commits. Publish them as versioned release assets, an approved artifact store,
or an explicit model-download flow with checksums and licenses.
