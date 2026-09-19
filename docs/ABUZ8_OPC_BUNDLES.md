# OpenClaw Bundled Desktop Releases

This fork is the public source and bundle catalog for click-to-run OpenClaw desktop builds.

## Release status

No new public Windows bundle should be uploaded from an installed operator machine. A release is acceptable only after it is staged from a clean profile, scanned for credentials and private paths, and verified to launch without access to the maintainer's computer.

## Source-backed candidates (not released)

| Label | Provider base | Bundle location | Runtime |
| --- | --- | --- | --- |
| OpenClaw bundled desktop | Private staging source | Not published in git | Electron shell, gateway, engine integration, skills, model catalog, and portable home |

The following trial payloads are deliberately excluded from publication because they embed private state, model weights, or still depend on terminal launchers:

- OpenClaw Portable;
- self-extracting model bundles;
- installed-machine builds copied from a live operator profile.

Published prereleases must be built with an isolated writable profile. The native window and bundle-local gateway must be verified before release.

## Product contract

OpenClaw Desktop stores user state in a writable per-user profile rather than
inside installed resources. The inference registry follows the same contract as
Hermes and persists only normalized adapter selections there.

Each finished Windows release must be:

- launched by double-clicking one installer or portable executable;
- self-contained, with its own runtime, engine, backend, frontend, and state;
- isolated from the owner's live OpenClaw gateway and credentials;
- usable without Node, Python, Git, or terminal setup on the target machine.

## Current gaps

The OpenClaw Desktop candidate needs a clean-profile rebuild and a clean-machine test covering onboarding, provider/model selection, memory persistence, tools, skills, voice/vision settings, GPU allocation, and upstream update controls.

## What is not committed

Executable payloads, model weights, live state, OAuth credentials, tokens, and
machine-specific configuration are intentionally excluded from Git. They belong in
versioned GitHub Release assets or a separate private delivery channel. Never commit
`home`, `.openclaw` state, `.env`, token files, model weights, or local databases.

OpenClaw remains available under its upstream license. This fork's desktop packaging and integration work are separate from the upstream project.
