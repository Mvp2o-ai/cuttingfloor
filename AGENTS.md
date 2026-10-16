# Working in this repo

## Start here
- `plans/` holds the build plan and full spec (local only, git-ignored). Read `plans/README.md` first.
- `pnpm check` must pass before every commit: Biome lint, `tsc -b`, Vitest.

## Conventions
- TypeScript run directly by Node 24 (type stripping). Only erasable syntax: no enums, namespaces or parameter properties. Relative imports carry `.ts`.
- Workspace packages export `./src/index.ts`; there is no build step for internal packages. `apps/cli` is bundled for npm with tsdown at release.
- Zod v4 (`import * as z from 'zod/v4'`) for every schema. Tool input and output schemas live in `packages/schema`.
- MCP via the v2 TypeScript SDK (`@modelcontextprotocol/server`). Spec target: MCP 2026-07-28.
- Tool names are `domain.verb`. Tools are granular editing primitives; anything that is a composition of primitives, data or derivable is not a tool. No tool involves a human.
- No provider key ever appears in a tool argument, result, error, log or project file.
- Tests use the SDK `Client` over `InMemoryTransport` against `createServer`, not internal functions.

## Commits
Conventional, small, one concern each. Add a changeset (`pnpm changeset`) for user-facing changes to `apps/cli`.
