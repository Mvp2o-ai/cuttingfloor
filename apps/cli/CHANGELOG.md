# cuttingfloor

## 0.20.1

### Patch Changes

- 3a9d1cc: A job no longer misses a cancel, or ends "interrupted" while still running, after two writes to its record landed in the same millisecond.

## 0.20.0

### Minor Changes

- 63bf48b: Hosted plans are enforced as sold. Each plan's render minutes are counted per job, and at the limit new jobs wait for the renewal (editing and previews keep working; nothing is billed past the price). Jobs at once, the largest export and judgments a day follow the plan. Account checks fail closed, a failed payment keeps working for 7 days, and account email (welcome, trial ending, minutes at 80% and 100%, payment failed) comes from support@cuttingfloor.ai. Self-hosted servers are unchanged: no plan, no limits.

## 0.19.2

### Patch Changes

- 5e54fe8: `create.cutout` runs in its own slot, one at a time by default (`CUTTINGFLOOR_HEAVY_JOBS`), at a lower CPU priority. A voiceover, import or export no longer waits minutes behind cut-outs, and a queued cut-out says what it waits for.

## 0.19.1

### Patch Changes

- cf35307: Parallel `create.motion` renders on the hosted server no longer fail with `server_busy`. The sandbox's process limit counted gVisor's own host threads, so three browsers at 1080x1920 crossed it and the whole sandbox crashed, failing every job in it. The cap now sits inside the sandbox, where a runaway script fails only its own job. A job waiting its turn hears its place in line every 20 seconds, so a long wait behind other renders no longer drops it after five minutes.

## 0.19.0

### Minor Changes

- 77e50b9: The hosted server moves to `https://api.cuttingfloor.ai/mcp`. The old address redirects there, and the site shows the new one.

## 0.18.0

### Minor Changes

- 9f7ad00: More ways to get a file in. `media.import` takes a small file as a `data:` URI (up to 8 MB, refused if it doesn't match the `sha256` given), and a file the user attached in the chat as `file` (`{download_url, file_id, mime_type, file_name}`, declared in `openai/fileParams` so ChatGPT passes attachments). Dropbox and Google Drive share links import as they are. A `media.upload` link opened in a browser is a page to drop the file on; it sends in parts and resumes on its own.

## 0.17.1

### Patch Changes

- 40802fd: New demo: let AI pick your best take, then make the thumbnail. Jev watches four takes of a channel intro, keeps the best and picks the thumbnail frame.
- 9a67ff8: New demo: add a talking head to a slide explainer, then make it a Short (Tip 1 of the infinite agentic memory explainer). Watch pages read right for a demo that adds rather than cuts.

## 0.17.0

### Minor Changes

- c90739c: Fixes for what tripped up the agents that made the site demos.

  - **Download links everywhere.** `code.run` hands back text and data files from `out/` (VTT, SRT, JSON, TXT, CSV and more) as files instead of failing on them, and every output, media and timelines too, has a signed download `url`. If one file can't be kept, that file is marked failed with the reason; the script's output and the other files still come back. `media.get` gives a download link for the file, and `render.frames` one per image.
  - **JPEG frames.** `render.frames` takes `format: "jpeg"`, and a `quality` for WebP and JPEG.
  - **A busy server queues work instead of failing.** Renders wait their turn for one of `CUTTINGFLOOR_MAX_RENDERS` slots (half the CPUs by default), and a time limit counts from when the render starts, not while it waits. `create.motion`, `create.still` and `code.run` no longer take a job slot from exports while the sandbox works. Inside a script, `motion()` and `still()` started together render one at a time. Two scripts running at once no longer lose each other's `out/` files.
  - **Errors you can retry.** Out of memory, a sandbox that is restarting or stopped mid-render now come back as `server_busy` with "call again in about a minute"; the docker hint shows only on a local server.
  - **Queued jobs say why.** `job.get` says where a waiting job stands and what it waits for ("queued: 2 ahead, waiting for a free job slot (running now: export.video, qa.check)", a render slot, or the sandbox). `code.run` says which call it is waiting on, and time spent in queues no longer counts against its `timeout_seconds`.
  - **Edits.** `transition.add {kind: "crossfade"}` on a video clip crossfades its sound and leaves the picture as a hard cut, and `changed` lists each transition (with track and kind), timeline effects and `audio.set_master`. `clip.set_transform {fit: "none"}` shows a graphic at its own pixel size. Fonts that aren't installed are refused with real ones to pick from. A title or caption that covers text already on its track says so. Freezing a clip's last frame holds it after the clip. Captions made per clip meet at the cut with no gap. Speed ramps say what `at` measures, and `timeline.get` gives each point its source frame.
  - **Clearer descriptions.** How exact transcript word times are and how to cut on speech instead, what `skills.search` scores mean, and that `code.run` keeps the last 16 KB of output. The cut-pauses skill's crossfade step is fixed.

## 0.16.0

### Minor Changes

- cf7ab12: **skills.search and skills.get:** step-by-step instructions for common jobs, found and read through cuttingfloor itself. `skills.search {query}` takes the user's words ("remove the ums from my video") and returns the skills that fit, best first, scored on each skill's name and description by keywords (BM25) and by meaning with a small model that runs on the CPU in the image, with no provider key. Without the model, search is keywords only. `skills.get {slug}` returns the whole skill as Markdown, ready to follow. The skills are `skills/*.md` in the repo, checked against one-mcp's playbook format.
- 9b5bb71: **Granular tools with full contracts.** Every tool declares its output schema, and the code.run SDK types every result. Tools no longer make choices for the agent:

  - `audio.set_loudness` and `audio.duck` are gone: set the mix with `audio.set_master` and `audio.set_gain` keyframes, and read loudness from audio previews or `qa.check`.
  - `qa.check` returns measurements (gaps, frame counts, loudness, true peak, and black or silent stretches with the settings you give), not pass or fail.
  - `caption.add {in_clip}` places captions timed in a clip's source seconds, through speed changes; `from_transcript` is gone, so you group the words.
  - `media.analyze` gains `silence` and `scenes`, with required settings; import no longer detects them.
  - `faces` returns face boxes only.
  - Tasks clients get tasks from long-running tools again.

## 0.15.0

### Minor Changes

- 47a372d: **judge.ask:** ask TypeSafe Jev your questions (yes/no, choice, score, box) about any state you name, and get typed answers back in about a second. An entry is text, JSON, an imported image `{media_id}` or a video frame `{media_id, at_seconds}`, mixed freely; questions refer to entries by name in backticks. Up to 32 questions, 8 pictures and 200k characters of text a call; a call too large for Jev fails with `limit_exceeded` and says to split it. Works in code.run as `cf.judge.ask(...)`, e.g. to mark filler words sentence by sentence.

  **look takes state:** `media.analyze {kind: 'look', state}` shows your text or JSON entries beside `frame` on every sampled frame, so questions can refer to a script line or a definition.

  **One daily budget (hosted):** look and judge.ask share `CUTTINGFLOOR_JUDGMENTS_PER_DAY` (default 5000; `CUTTINGFLOOR_LOOK_FRAMES_PER_DAY` still sets it). A look frame counts one; a judge.ask call counts one, plus one for each picture past the first.

## 0.14.0

### Minor Changes

- d25eb67: Uploads: `media.upload {name, bytes?}` gives a signed URL to PUT one of the user's files to, so a hosted server can take files it can't read from a path. Uploads resume (HEAD for `Upload-Offset`, then `Content-Range` from there), take browsers (CORS), are capped at `CUTTINGFLOOR_MAX_DOWNLOAD_BYTES` and kept a day; `media.import {source: {upload_id}}` moves the file into the media.
- 0bd36b3: Site: the home page session is drawn in the page from data instead of a video, and walkthroughs arrive: a template at /walkthroughs/[slug] fed by one data module, a hub at /walkthroughs, and the first walkthrough, fix-jagged-cuts.

## 0.13.0

### Minor Changes

- 011b544: `create.motion` renders frames in several browsers at once, about one per two CPUs (`CUTTINGFLOOR_MOTION_WORKERS` to set it). Every browser steps through every frame, so output is frame-identical to a single browser; a 5-second graphic renders 1.6–2× faster on six CPUs. The sandbox now gets 4 CPUs locally and 6 CPUs and 6 GB on the hosted server.

## 0.12.0

### Minor Changes

- 96921a6: Agents no longer have to guess. The server instructions now offer two ways to work: make new media with `create.*`, where a reference the user shows you is rebuilt in HTML rather than imported, or `media.import` the user's own files. `timeline.create` returns its tracks, so the first `clip.add` knows its `track_id`. `job.get {wait_seconds}` holds the call until a job finishes, instead of repeated polling. Output schemas no longer forbid extra fields, so a field added in a later release doesn't fail results in clients still holding the old schema. Media at exactly 24, 30 or 60 fps is no longer read as 23.976, 29.97 or 59.94.

  Titles and captions placed after the first frame of a timeline now render (libass was timed from the clip, but reads timeline time). Edit results say where each added or moved clip now sits (`track_id`, `start`, `end`). A transition left short of source by a speed change, trim or slip is shortened to fit instead of removed. A title with a reveal previews once it's fully shown. Cached preview frames are cleared on start, so a new build never serves an old render.

  `media.import {source: {job_id}}` imports a completed `export.video` render as media, so a finished edit can be re-cut, baked, or placed in a sequence of another shape. Nesting a timeline of a different shape is refused with that route as the hint (it rendered wrongly); same-shape nesting is unchanged. Each nesting level decodes media with its own producers, which fixes multi-frame previews when the same media is fitted differently inside and outside a nested timeline. `job.get` shows a job whose tool failed as `failed`, not `completed`.

  Job status keeps up: a progress update that arrives within a second of the last is held and shown, not dropped, so a job no longer sits on "fetching inputs" or "downloading the model" after it has moved on, and jobs waiting on the same model download see its progress. Exports report progress while they render. A `media.analyze` result too long to return (a long talk's transcript) comes back as its summary and a note on reading it in `code.run`; short results are unchanged. `code.run` marks output it cut ("[N earlier characters of stdout cut…]"), its description lists the `out` option of `motion()` and `still()`, and its result warns when a rendered page kept the placeholder name.

  A model that takes video in can now watch a cut. The new `review_h264` preset renders a small MP4 with sound at the sequence rate. Every `export.video` result links its file twice, as `video://jobs/{job_id}/output` and as the signed https URL, with MCP `annotations.audience` set to `assistant` for a review and `user` for any other render, so a host knows which to show its model. Results also give `fps` and `duration_seconds`. `job.get` now carries a finished job's links and media, as `tasks/result` does. Models without video keep using `render.frames`.

  Hosted mode refuses to start without `CUTTINGFLOOR_PUBLIC_URL`, instead of handing out download links to the server's own loopback address.

- cf078f4: Hosted servers take OAuth: set `CUTTINGFLOOR_OAUTH_ISSUER` and MCP clients sign in through that authorization server (Protected Resource Metadata, audience-bound JWT access tokens). API keys keep working alongside.
- 6603aa0: Hosted plans: a signed-in account works for a 3-day trial, then with a subscription (or a comped admin or lifetime account). Past that, tools return `subscription_required` with where to subscribe. API keys, for maintenance, are never gated.
- 754899c: Safe for many accounts on several servers that share one data root.
  - **Analyses:** each analysis is its own file beside the media. Two servers analysing the same media at once both keep their results. Records that held analyses inline move them out on first read.
  - **Jobs:** each job carries its server's name (`CUTTINGFLOOR_NODE`; hosted defaults to the hostname) and a heartbeat every 30 s.
    - A server restarting ends only its own jobs as `interrupted`.
    - Any server ends a job whose heartbeat has stopped for 2 minutes.
    - A cancel made through one server stops a job running on another.
  - **Hosted look cap:** hosted servers limit look frames per account per day (`CUTTINGFLOOR_LOOK_FRAMES_PER_DAY`, default 5000). A call that would pass the limit fails at once with `quota_exceeded`, naming what's used, what's left and when the limit resets.
  - **Deploy:** `deploy/hetzner` runs one hosted server on Hetzner Cloud with TLS and the sandbox under gVisor.
- 3fae5e9: `media.analyze {kind: "look"}` answers your own questions about what is on screen. TypeSafe's Jev, a fast judgment model (images are in preview), answers every question on frames sampled `every_seconds` or `at_seconds` (optionally between `from_seconds` and `until_seconds`), about 0.15 s a frame. Questions use Jev's own types: noul (yes/no probability), choice (one of named options), score (a degree on ordered levels) and box (where one thing is, as `{x, y, w, h}` fractions like faces and track). `with_previous` also shows the frame sampled before, as `previous`, for questions about what changed. The tool description teaches how to write questions Jev answers well. The result gives each question's spans; every frame's answers stay with the media (`media.get include ['look']`, the last 10 runs). Up to 600 frames and 32 questions a call.

  It needs `TYPESAFE_API_KEY` in the `.env` next to `compose.yaml`; without one, a look fails at once with `credential_required`, before any job starts. The key never appears in a result, error or stored file. Hosted servers use their own TypeSafe key for every account, with requests from all jobs sharing one limit per server.

## 0.11.0

### Minor Changes

- edf2072: `code.run` runs a Node, Python or bash script in the sandbox, sharing the workspace with the tools: inside it every tool is `cf.domain.verb(args)` (the new SDK, generated from the tool registry; Python `from cuttingfloor import cf`; bash `cf domain.verb '{json}'`), inputs arrive in `in/`, `importFile(path)` brings a made file in as media at once, and files left in `out/` come back as media or (`*.timeline.json`) timelines. Scripts run in their own user, PID and network namespaces with no network; their tool calls travel back over the job's own stream and run as the caller, so the sandbox still can't reach the server. `create.motion` now renders any animated page frame-exactly on a virtual clock (CSS animations and transitions, Web Animations, SVG, `requestAnimationFrame`, timers, `window.__seek`), with anime.js, three.js, Lottie and D3 bundled under `lib/`; HyperFrames and GSAP are gone. The image adds Python (numpy, Pillow, OpenCV) for scripts, and the sandbox's memory limit rises to 4 GB.
- 94ee94b: `create.cutout` cuts out any subject, not just people: `subject: "any"` uses BiRefNet lite (MIT, on ONNX Runtime) for products, animals and objects, and is the default for pictures; `subject: "people"` keeps MODNet, fast enough for video and the default there.
- a62d003: Export: `export.video` adds the `social_9x16_h264`, `web_1080p_av1`, `gif`, `audio_wav_48k` and `audio_mp3` presets and `overrides` for size, frame rate, bitrate and quality (`video://catalog/presets`). `export.timeline` writes the edit as FCPXML, OTIO or a CMX 3600 EDL, or the captions as SRT or VTT, listing what each format can't carry; `media: "collect"` zips the media alongside. `render.frames {size: "full"}` renders up to four frames at full size from the original media.

### Patch Changes

- b7cbff8: Previews of real footage, and exports of media bigger than the sequence (4K in a 1080p timeline), no longer come out garbled: full-frame clips are kept off a shortcut in MLT's qtblend that returned the picture at its source size. Those renders also use far less memory.

## 0.10.0

### Minor Changes

- 16c8988: `create.voiceover` speaks English text in one of 28 natural voices (Kokoro via sherpa-onnx, on the CPU; the model downloads once) and times every word, so `caption.add {from_transcript}` captions it exactly. `create.cutout` removes the background behind people in a video or picture (MODNet), giving ProRes 4444 with alpha and the original sound, or a PNG.

## 0.9.0

### Minor Changes

- 82e1b1e: Create new media: `create.motion` renders animated HTML (HyperFrames with GSAP) to a video with alpha, `create.still` renders an HTML page to a PNG, and `create.matte` makes a solid or gradient picture. Each is a job that returns a `media_id`, and the same recipe returns the same media. HTML runs only in the new `motion` compose service: a sandbox with no route out, no data volume, no capabilities, a read-only filesystem and fixed limits, with Chromium's own sandbox on (seccomp profile in `tools/motion/seccomp.json`). The image now includes Chromium.

## 0.8.0

### Minor Changes

- 89716cb: Analysis: `media.analyze` finds what is in imported media, as data for edits. `transcript` gives every word with its time (whisper.cpp on the CPU, models tiny/base/small downloaded once and checksummed), `beats` gives tempo, beat and downbeat times, `faces` gives face boxes over time and a smoothed focus point for reframing, and `track` follows a region you give. Results stay with the media (`media.get` with `include`). Transcripts drive edits: `clip.add {source: {words: [i, j]}}` cuts a clip to a range of words, and `caption.add {from_transcript: {clip_id}}` captions a clip from its transcript, timed where its words play (speed changes included).

## 0.7.0

### Minor Changes

- 7ca8a2c: Effects: `filter.add`, `filter.set` and `filter.remove` put registry effects on a clip, every clip on a track, or the whole timeline, and `adjustment.add` adds a clip whose effects change everything below it while it runs. 21 video effects (brightness and contrast, saturation, exposure, temperature, hue, vibrance, curves, LUTs, grayscale, sepia, invert, blur, sharpen, vignette, grain, chromatic aberration, pixelate, glitch, denoise, chroma key) and 12 audio effects (EQ, compressor, noise reduction, de-esser, dialogue enhance, reverb, echo, pitch, high-pass, low-pass, telephone), with their params at `video://catalog/effects`; number params take keyframes. `.cube` LUTs import with `media.import`. `timeline.load` now keeps numbering ids after transitions and effects in the loaded timeline.

## 0.6.0

### Minor Changes

- 45b0065: Audio tools: `audio.set_gain` (dB, with keyframes for rides), `audio.set_pan`, `audio.fade`, `audio.duck` (lowers a music track wherever the other audio tracks have sound, as gain keyframes on its clips), `audio.set_master` (master gain and limiter) and `audio.set_loudness` (measures the mix and sets the master to a loudness target, -14 LUFS by default, with peaks under the true-peak ceiling). Audio edits preview as a waveform image with the measured loudness, also readable at `video://timeline/{id}/waveform/{start}_{end}.webp`.

## 0.5.0

### Minor Changes

- 6cd2dbe: Titles and captions: `title.add`, `caption.add` (from segments with word timings, or from SRT/VTT, including WebVTT word timestamps) and `text.set` to retext or restyle many at once. Text renders with libass over the picture: fonts, size, colour, outline, soft shadow, box, karaoke/fill/word/pop highlights driven by word timings, and typewriter and word reveals. Titles and captions are clips, so transforms, masks, animations and transitions apply. A curated set of free fonts ships in the image (`video://catalog/fonts`), and `.ttf`/`.otf` files import with `media.import` for use through `font_media_id`.

## 0.4.0

### Minor Changes

- f60a602: Transitions: `transition.add`, `transition.set` and `transition.remove` at the cut between two touching clips. 19 kinds (dissolve, dip to black or white, wipes, slides, pushes, zoom in and out, iris, spin), listed at `video://catalog/transitions`; linked audio gets an equal-power crossfade at the same cut. By default the clips overlap by the transition's length and later clips move earlier; `mode: "handles"` uses source past the cut and moves nothing. An edit that breaks a transition removes it and says so in `warnings`.

## 0.3.0

### Minor Changes

- 34a6579: Timing tools: `clip.set_speed` (constant rate, speed-ramp curves and reverse, with pitch kept unless `preserve_pitch: false`), `clip.freeze`, `clip.roll`, `clip.slip`, `clip.slide`, `clip.replace`, and `range.lift` / `range.extract` to cut a span out of every track at once. Nested timelines: `clip.add {nested_timeline_id}` puts a whole timeline in as one clip (a compound clip) that can be trimmed, moved, transformed and masked like any other, and is transparent where it is empty. Keyframes stay on their content through speed changes.

## 0.2.0

### Minor Changes

- 33dd088: Clip compositing for overlays and picture-in-picture: `clip.set_transform` (position, scale, rotation, opacity, crop, flip and fit, each number animatable with keyframes and 34 eases), `clip.set_mask` (rectangle with rounded corners, ellipse, linear, mirror, heart, star and polygon, with feather and invert), `clip.set_blend` (13 blend modes) and `clip.set_animation` (entrance, exit and loop presets). Accepted names are resources at `video://catalog/{name}`. Pictures with an alpha channel keep it through conform and previews. Timeline documents are now version 2; `timeline.load` still accepts version 1 JSON.

## 0.1.0

### Minor Changes

- 5a66d33: Phase 1 editor: media import with conform and proxies, immutable timelines with clip editing and `edit.batch`, image previews on every edit, `render.frames`, exact `qa.check`, H.264 and ProRes export with signed downloads, and long-running work as MCP Tasks or `job.*`.
