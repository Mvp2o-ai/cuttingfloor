# Working in this repo

## Start here
- `plans/` holds the build plan and full spec (local only, git-ignored). Read `plans/README.md` first.
- `pnpm check` must pass before every commit: Biome lint, `tsc -b`, Vitest. Engine and end-to-end tests skip on hosts without FFmpeg and MLT; `docker build --target test .` runs everything (it sets `CUTTINGFLOOR_REQUIRE_ENGINES=1`, so a missing engine fails instead of skipping).
- Docker is the product's only runtime requirement. Engines and tools ship inside the image; never add a host dependency.

## Conventions
- TypeScript run directly by Node 24 (type stripping). Only erasable syntax: no enums, namespaces or parameter properties. Relative imports carry `.ts`.
- Workspace packages export `./src/index.ts`; there is no build step. The Docker image runs the source directly.
- Zod v4 (`import * as z from 'zod/v4'`) for every schema. Tool input and output schemas live in `packages/schema`.
- MCP via the v2 TypeScript SDK (`@modelcontextprotocol/server`). Spec target: MCP 2026-07-28. HTTP goes through `createMcpHandler` (modern plus stateless 2025 fallback).
- Stateless: timelines are immutable and content-addressed; every durable thing is a file with a TTL under the data root. No database, no project folders, no in-memory state a restart would lose.
- Engines are subprocesses (`packages/engine`), always called with argument lists, never a shell. Only the server writes MLT XML, with forced producers.
- Tool names are `domain.verb`. Tools are granular editing primitives; anything that is a composition of primitives, data or derivable is not a tool. No tool involves a human.
- Domain errors are `CfError` (typed code, actionable hint) and reach clients as `isError` results.
- No provider key ever appears in a tool argument, result, error, log or stored file.
- Tests use the SDK `Client` against `createServer` (InMemoryTransport) or the HTTP server, not internal functions.

## Branches and releases
Open source: outside contributors fork, branch from `develop` and open pull requests into `develop` (CONTRIBUTING.md). Agents follow the same flow from worktrees:
- The main checkout (first in `git worktree list`) is the person's and stays on `develop`. Never edit, commit or switch branches there.
- Start: a worktree off `origin/develop` on a branch prefixed with the harness (`claude/…`, `cursor/…`, `codex/…`). Claude Code worktrees live in `.claude/worktrees/`; run `scripts/worktree-setup.sh` in a new one (env files and its own `pnpm install`).
- Ship: `pnpm check` in the worktree, then `git push origin HEAD:develop` (rebase on `origin/develop` if rejected), or a pull request into `develop`.
- Promote: `scripts/promote-develop.sh "<summary>"` opens the develop → main pull request, waits for its checks and merges it. Changesets on `main` cut the release, tag the image and merge back into `develop`. Only `develop` may open a pull request into `main` (the Flow check).
- Finish: `scripts/finish-release.sh <worktree>` waits for main's runs, removes the worktree and fast-forwards the main checkout.
- Whether something exists is answered from `origin/develop` and `origin/main` (`git grep -n <term> origin/develop --`), not a working tree that may be behind.

## Commits
Conventional, small, one concern each. Add a changeset (`pnpm changeset`) for user-facing changes; only the `cuttingfloor` app is versioned, and releases tag the image.
