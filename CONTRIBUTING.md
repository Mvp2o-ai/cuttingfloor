# Contributing

1. Docker, plus Node 24+ and pnpm 10 (`corepack enable`) for the fast loop.
2. `pnpm install`, then `pnpm check` (lint, typecheck, unit and protocol tests).
3. `docker build --target test .` runs everything, including the FFmpeg/MLT engine and end-to-end tests.
4. Branch from `main`, keep changes focused, add tests, and add a changeset (`pnpm changeset`) for user-facing changes.
5. Open a pull request; CI runs the checks on the host and in the image, then smoke-tests the built image.

Security issues: see [SECURITY.md](SECURITY.md), not the issue tracker.
