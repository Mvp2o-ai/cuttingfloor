# cuttingfloor

A headless video editor for agents, as an MCP server. An agent imports footage, cuts it on a timeline with granular editing tools, looks at the result after every edit, checks it, and exports a file.

- **Every edit returns a new timeline id**, plus a preview image of the result. Timelines are immutable, so going back is just using an older id.
- **Nothing is stored for you.** Timelines, media and outputs live in a cache with a time limit (24 hours for timelines, 7 days for media and exports). Export to keep work.
- **One Docker image** runs locally (free) and hosted. Engines (FFmpeg, MLT) ship inside it; Docker is the only thing you install.

> Status: Phase 3 in progress. Import, timelines, clip editing, compositing (transforms, keyframes, masks, blend modes, animations), previews, exact QA checks and H.264/ProRes export work end to end. Speed and timing tools, transitions, titles and captions, audio tools, effects, `create.*` and NLE interchange come next.

## Run it

```sh
docker compose up -d          # local mode: one node on 127.0.0.1:8787
```

Connect an MCP client over Streamable HTTP:

```json
{ "mcpServers": { "cuttingfloor": { "url": "http://127.0.0.1:8787/mcp" } } }
```

Or over stdio, for clients that only launch commands. The stdio process forwards to the running container, so long exports keep going after the client exits:

```json
{ "mcpServers": { "cuttingfloor": { "command": "docker", "args": ["exec", "-i", "cuttingfloor", "cuttingfloor", "mcp"] } } }
```

Folders (set them in a `.env` next to `compose.yaml`, see `.env.example`):

| On your machine | In the container | What |
|---|---|---|
| `$CUTTINGFLOOR_MEDIA` (default `~/Movies`) | `/media/videos` (read-only) | Footage. Import with `{"path": "/media/videos/clip.mp4"}` |
| `$CUTTINGFLOOR_EXPORTS` (default `~/cuttingfloor/exports`) | `/exports` | Finished exports |
| Docker volume `cuttingfloor-data` | `/data` | Timelines, proxies, jobs (with time limits) |

The image includes `/samples/sample.mp4` (10 s test pattern with a tone) and `/samples/card.png` to try things with nothing mounted.

On Docker Desktop for Mac, raise the memory limit for long 4K timelines; bind-mounted footage reads go through VirtioFS. On Linux, create the exports folder before the first start so it belongs to you.

## How an agent uses it

1. `media.import` each file. It's long-running: a task for clients that support MCP Tasks, otherwise a `job_id` to poll with `job.get`. The `media_id` is usable once the job reports `processing`.
2. `timeline.create` with a sequence (`{width, height, fps: {num, den}}`).
3. Edit: `clip.add`, `clip.trim` (with `side` for J/L cuts), `clip.split`, `clip.move`, `clip.remove` (with `ripple`), `clip.link`, `track.*`, or `edit.batch` to apply many edits at once, using `{"$ref": "ops[0].clip_id"}` for ids made earlier in the batch.
4. Composite: put a clip on a higher video track, then `clip.set_transform` (position, scale, rotation, opacity, crop, flip, fit; any number can take keyframes with easing), `clip.set_mask` (rectangle, ellipse, linear, mirror, heart, star, polygon), `clip.set_blend` and `clip.set_animation` (entrance, exit and loop presets). The accepted names are resources at `video://catalog/{name}`.
5. Look: `preview: "inline"` on any edit returns the image; `render.frames` returns up to 16 frames as a contact sheet.
6. `qa.check` runs exact checks: gaps, offline media, black frames, silence, loudness, frame count.
7. `export.video` with `web_1080p_h264` or `master_prores_422hq`. The result has a signed download URL and, locally, the file in your exports folder.

Time is integer frames at the sequence rate, end-exclusive. `timeline.get` returns the whole timeline as JSON; `timeline.load` restores it after it expires. `video://server/health` reports engine versions and limits.

## Hosted mode

The same image with `CUTTINGFLOOR_MODE=hosted`: no path imports (URLs only), no exports folder, and every request needs `Authorization: Bearer <key>` from `CUTTINGFLOOR_API_KEYS` (`owner:key,owner2:key2`, or the `cuttingfloor_api_keys` Docker secret). Each key's owner has separate timelines, media and jobs. Set `CUTTINGFLOOR_PUBLIC_URL` so download links point at the right host.

| Variable | Default | |
|---|---|---|
| `CUTTINGFLOOR_DATA` | `/data` | Data root |
| `CUTTINGFLOOR_MAX_JOBS` | cores ÷ 4 | Concurrent imports, exports and QA runs |
| `CUTTINGFLOOR_OUTPUT_URL_TTL_HOURS` | `24` | Signed download link lifetime |
| `CUTTINGFLOOR_MAX_DOWNLOAD_BYTES` | 10 GiB | URL import size cap |

## Develop

```sh
pnpm install && pnpm check       # lint, typecheck, unit and protocol tests (Node 24+, pnpm 10)
docker build --target test .     # everything, including engine and end-to-end tests
docker build -t cuttingfloor:dev . && node scripts/smoke-image.ts cuttingfloor:dev
```

## Layout

| Path | What |
|---|---|
| `apps/cli` | `cuttingfloor serve` (HTTP) and `cuttingfloor mcp` (stdio) |
| `apps/hosted` | The HTTP node: MCP endpoint, signed downloads, API keys |
| `packages/server` | MCP tools, resources and the Tasks adapter |
| `packages/schema` | Zod schemas for every tool, the timeline document and errors |
| `packages/core` | Timeline document, edit math, content hashing, storage with TTLs |
| `packages/engine` | FFmpeg and MLT as subprocesses: probe, conform, proxies, frames, export, QA |
| `packages/jobs` | File-backed job store and runner behind MCP Tasks and `job.*` |
| `packages/credentials` | Bring-your-own provider keys |

## Licence

Not chosen yet. Until a licence is added, all rights are reserved.
