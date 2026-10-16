# cuttingfloor

A headless, agent-native video editor exposed as an MCP server. An agent cuts, grades, titles, mixes and exports through granular editing tools. Every edit returns its visual or audible result, every edit is a revision, and the cut hands off to Premiere, Resolve or Final Cut.

- **Local mode:** stdio, free, runs on your machine. Footage never leaves it unless you use a provider that needs it to.
- **Hosted mode:** Streamable HTTP with OAuth. Render offload, cloud ingest, teams.

> Status: scaffold. Nothing edits video yet.

## Run it

Requires Node 24+ and pnpm 10. Local builds target macOS on Apple silicon; hosted runs in Docker on Linux.

```sh
pnpm install
pnpm check            # lint, typecheck, test
pnpm dev:stdio        # the MCP server over stdio
pnpm inspect          # the same, under the MCP Inspector
```

MCP client config (local):

```json
{
  "mcpServers": {
    "cuttingfloor": { "command": "node", "args": ["/path/to/cuttingfloor/apps/cli/src/main.ts", "mcp"] }
  }
}
```

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

Some tools call third-party services with your own key (Jev for QA; ElevenLabs, Deepgram, OpenAI and others for `create.*`). Keys are never passed through tools. Locally they come from the environment variables in `.env.example` or the OS keychain.

## Licence

Not chosen yet. Until a licence is added, all rights are reserved.
