# cuttingfloor

A headless, agent-native video editor exposed as an MCP server. An agent cuts, grades, titles, mixes and exports through granular editing tools. Every edit returns its visual or audible result, every edit is a revision, and the cut hands off to Premiere, Resolve or Final Cut.

- **Hosted mode:** Streamable HTTP with OAuth, on Hetzner. Render offload, cloud ingest, teams.
- **Local mode:** the same Docker image as one node on your machine, free. Footage never leaves it unless you use a provider that needs it to.

> Status: scaffold. Nothing edits video yet.

## Run it

The only requirement is Docker.

```sh
docker compose up -d          # local mode: one node on 127.0.0.1:8787
```

Connect an MCP client over HTTP:

```json
{ "mcpServers": { "cuttingfloor": { "url": "http://127.0.0.1:8787/mcp" } } }
```

Or over stdio, for clients that only launch commands:

```json
{ "mcpServers": { "cuttingfloor": { "command": "docker", "args": ["exec", "-i", "cuttingfloor", "cuttingfloor", "mcp"] } } }
```

Footage is read from `$CUTTINGFLOOR_MEDIA` (default `~/Movies`, mounted read-only). Projects and exports go to `$CUTTINGFLOOR_PROJECTS` (default `~/cuttingfloor`). Provider keys go in a `.env` next to `compose.yaml` (see `.env.example`).

## Develop

```sh
docker build --target test .  # lint, typecheck and tests, inside the image
```

Or on the host with Node 24+ and pnpm 10: `pnpm install && pnpm check`.

## Layout

| Path | What |
|---|---|
| `apps/cli` | `cuttingfloor` binary: `mcp` (stdio), `daemon`, `keys` |
| `apps/hosted` | Streamable HTTP server |
| `packages/server` | MCP server: tools, resources, the Tasks adapter |
| `packages/schema` | Zod schemas: ids, project document, tool inputs, errors |
| `packages/core` | Project store: `.vproj` folders, op log, commits |
| `packages/jobs` | Durable job store behind MCP Tasks and `job.*` |
| `packages/credentials` | Bring-your-own provider keys |
| `packages/providers` | Jev (QA), speech, voice, music and image providers |
| `packages/engine` | Engine adapter to the native frame worker and job workers |
| `native/frame-worker` | MLT frame worker (C++) |

## Provider keys

Some tools call third-party services with your own key (Jev for QA; ElevenLabs, Deepgram, OpenAI and others for `create.*`). Keys are never passed through tools. Locally they come from `.env`, Docker secrets or the local keys page.

## Licence

Not chosen yet. Until a licence is added, all rights are reserved.
