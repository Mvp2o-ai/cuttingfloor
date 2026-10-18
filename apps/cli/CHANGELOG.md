# cuttingfloor

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
