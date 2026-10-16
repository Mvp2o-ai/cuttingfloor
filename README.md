# cuttingfloor

A headless video editor for agents, as an MCP server. An agent imports footage, cuts it on a timeline with granular editing tools, looks at the result after every edit, checks it, and exports a file.

- **Every edit returns a new timeline id**, plus a preview image of the result. Timelines are immutable, so going back is just using an older id.
- **Nothing is stored for you.** Timelines, media and outputs live in a cache with a time limit (24 hours for timelines, 7 days for media and exports). Export to keep work.
- **One Docker image** runs locally (free) and hosted. Engines (FFmpeg, MLT) ship inside it; Docker is the only thing you install.

> Status: Phase 3 in progress. Import, timelines, clip editing, timing (speed, ramps, reverse, freeze frames, roll/slip/slide, range extract, nested timelines), transitions, titles and captions, audio (gain, pan, fades, ducking, loudness), effects (colour, LUTs, blur, chroma key and more; EQ, compressor, denoise, pitch), analysis (transcripts, beats, faces, tracking), compositing (transforms, keyframes, masks, blend modes, animations), motion graphics and HTML stills (sandboxed), mattes, previews, exact QA checks and H.264/ProRes export work end to end. Voiceover, cutouts, provider tools and NLE interchange come next.

## Run it

```sh
docker compose up -d          # local mode: one node on 127.0.0.1:8787, plus the motion sandbox
```

Compose starts two containers from the same image: `cuttingfloor` (the server) and `cuttingfloor-motion`, the sandbox where agent-written HTML for `create.motion` and `create.still` runs. The sandbox has no route out, no data volume, no capabilities, a read-only filesystem and fixed CPU, memory and process limits; Chromium's own sandbox stays on inside it, using the seccomp profile at `tools/motion/seccomp.json` (Docker's default plus namespace creation). Run compose from a checkout of this repository so that file is there.

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
2. `media.analyze` turns media into data an agent can edit with: `transcript` (every word with its time; whisper.cpp on the CPU, the model downloads once), `beats` (tempo, beats, downbeats), `faces` (face boxes over time and a smoothed focus point for reframing) and `track` (follow a region). Then cut by words with `clip.add {source: {words: [i, j]}}` and caption with `caption.add {from_transcript: {clip_id}}`.
3. `timeline.create` with a sequence (`{width, height, fps: {num, den}}`).
4. Edit: `clip.add`, `clip.trim` (with `side` for J/L cuts), `clip.split`, `clip.move`, `clip.remove` (with `ripple`), `clip.link`, `track.*`, or `edit.batch` to apply many edits at once, using `{"$ref": "ops[0].clip_id"}` for ids made earlier in the batch.
5. Time: `clip.set_speed` (constant rate, a speed-ramp `curve`, `reverse`; pitch is kept), `clip.freeze`, `clip.roll`, `clip.slip`, `clip.slide`, `clip.replace`, and `range.extract` / `range.lift` to cut a span out of every track at once. `clip.add {nested_timeline_id}` nests a whole timeline as one clip.
6. Transition: `transition.add` at the cut after a clip: dissolve, dip to black or white, wipes, slides, pushes, zooms, iris and spin. Linked audio crossfades at the same cut. By default the clips overlap and later clips move earlier; `mode: "handles"` uses source past the cut and moves nothing.
7. Text: `title.add` and `caption.add` (from segments with word timings, or from SRT/VTT) put text on a video track, rendered with libass: font, size, colour, outline, shadow, box, karaoke and word highlights, typewriter and word reveals. `text.set` restyles many at once. Fonts are listed at `video://catalog/fonts`; import your own `.ttf`/`.otf` with `media.import` and use it with `font_media_id`.
8. Audio: `audio.set_gain` (dB, with keyframes for rides), `audio.set_pan`, `audio.fade`, `audio.duck` (lowers a music track wherever the other tracks have sound, as gain keyframes you can see), `audio.set_master`, and `audio.set_loudness` to hit a loudness target such as -14 LUFS with peaks under -1 dBTP. Audio edits preview as a waveform image with the measured loudness.
9. Effects: `filter.add` on a clip, every clip on a track, or the whole timeline: colour (brightness, contrast, saturation, exposure, temperature, curves, LUTs imported as `.cube`), blur, sharpen, vignette, grain, glitch, pixelate, chroma key; for sound EQ, compressor, noise reduction, de-esser, dialogue enhance, reverb, echo, pitch. `adjustment.add` adds a clip whose effects change everything below it while it runs. The list with params is at `video://catalog/effects`.
10. Composite: put a clip on a higher video track, then `clip.set_transform` (position, scale, rotation, opacity, crop, flip, fit; any number can take keyframes with easing), `clip.set_mask` (rectangle, ellipse, linear, mirror, heart, star, polygon), `clip.set_blend` and `clip.set_animation` (entrance, exit and loop presets). The accepted names are resources at `video://catalog/{name}`.
11. Create: `create.motion` renders animated HTML (a HyperFrames composition with a GSAP timeline; GSAP is provided) to a video with alpha, for lower thirds, animated titles, callouts and kinetic type. `create.still` renders an HTML page to a PNG, and `create.matte` makes a solid or gradient picture. Each returns a `media_id` for `clip.add`; the same recipe returns the same media. Pages can't reach the network, so images and fonts go in as `assets` (imported media) and are referred to as `assets/<name>`.
12. Look: `preview: "inline"` on any edit returns the image; `render.frames` returns up to 16 frames as a contact sheet.
13. `qa.check` runs exact checks: gaps, offline media, black frames, silence, loudness, frame count.
14. `export.video` with `web_1080p_h264` or `master_prores_422hq`. The result has a signed download URL and, locally, the file in your exports folder.

Time is integer frames at the sequence rate, end-exclusive. `timeline.get` returns the whole timeline as JSON; `timeline.load` restores it after it expires. `video://server/health` reports engine versions and limits.

## Hosted mode

The same image with `CUTTINGFLOOR_MODE=hosted`: no path imports (URLs only), no exports folder, and every request needs `Authorization: Bearer <key>` from `CUTTINGFLOOR_API_KEYS` (`owner:key,owner2:key2`, or the `cuttingfloor_api_keys` Docker secret). Each key's owner has separate timelines, media and jobs. Set `CUTTINGFLOOR_PUBLIC_URL` so download links point at the right host.

| Variable | Default | |
|---|---|---|
| `CUTTINGFLOOR_DATA` | `/data` | Data root |
| `CUTTINGFLOOR_MAX_JOBS` | cores ÷ 4 | Concurrent imports, exports and QA runs |
| `CUTTINGFLOOR_OUTPUT_URL_TTL_HOURS` | `24` | Signed download link lifetime |
| `CUTTINGFLOOR_MAX_DOWNLOAD_BYTES` | 10 GiB | URL import size cap |
| `CUTTINGFLOOR_MOTION_URL` | unset (compose sets it) | The motion sandbox for `create.motion` and `create.still`; without it those tools explain how to start one |

## Develop

```sh
pnpm install && pnpm check       # lint, typecheck, unit and protocol tests (Node 24+, pnpm 10)
docker build --target test .     # everything, including engine and end-to-end tests
docker build -t cuttingfloor:dev . && node scripts/smoke-image.ts cuttingfloor:dev
node scripts/smoke-motion.ts cuttingfloor:dev   # the motion sandbox in compose, attacked
```

## Layout

| Path | What |
|---|---|
| `apps/cli` | `cuttingfloor serve` (HTTP), `cuttingfloor mcp` (stdio) and `cuttingfloor motion-worker` (the sandbox role) |
| `apps/hosted` | The HTTP node: MCP endpoint, signed downloads, API keys |
| `packages/server` | MCP tools, resources and the Tasks adapter |
| `packages/schema` | Zod schemas for every tool, the timeline document and errors |
| `packages/core` | Timeline document, edit math, content hashing, storage with TTLs |
| `packages/engine` | FFmpeg and MLT as subprocesses: probe, conform, proxies, frames, export, QA |
| `packages/motion` | The motion sandbox's worker: HyperFrames and Chromium renders, one at a time |
| `tools/` | Native helpers built into the image (`cf-vision`) and the motion sandbox's Chromium wrapper and seccomp profile |
| `packages/jobs` | File-backed job store and runner behind MCP Tasks and `job.*` |
| `packages/credentials` | Bring-your-own provider keys |

## Licence

Not chosen yet. Until a licence is added, all rights are reserved.
