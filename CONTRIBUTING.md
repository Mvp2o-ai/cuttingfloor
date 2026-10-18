# Contributing

## Setup

1. Docker, plus Node 24+ and pnpm 10 (`corepack enable`) for the fast loop.
2. `pnpm install`, then `pnpm check` (lint, typecheck, unit and protocol tests).
3. `docker build --target test .` runs everything, including the FFmpeg/MLT engine and end-to-end tests.

## Branches

- `develop` is where every change lands first, and the default branch.
- `main` is the released code. It only ever takes a promotion of `develop`; merging a promotion
  that carries changesets is the release (version, changelog, tag, image).

## Making a change

1. Fork the repo and branch from `develop`.
2. Keep the change focused. Add tests, and add a changeset (`pnpm changeset`) for user-facing
   changes. Commits are conventional (`feat(scope): …`, `fix(scope): …`).
3. Open a pull request into `develop`. CI runs the checks on the host and in the image, then
   smoke-tests the built image. A maintainer reviews and merges.

A pull request into `main` from anywhere but `develop` fails the Flow check and cannot merge;
change its base to `develop`. Workflows on a first-time contributor's pull request wait for a
maintainer's approval, and they run without access to secrets.

Security issues: see [SECURITY.md](SECURITY.md), not the issue tracker.
