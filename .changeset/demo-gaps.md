---
"cuttingfloor": minor
---

Fixes for what tripped up the agents that made the site demos.

- **Download links everywhere.** `code.run` hands back text and data files from `out/` (VTT, SRT, JSON, TXT, CSV and more) as files instead of failing on them, and every output, media and timelines too, has a signed download `url`. If one file can't be kept, that file is marked failed with the reason; the script's output and the other files still come back. `media.get` gives a download link for the file, and `render.frames` one per image.
- **JPEG frames.** `render.frames` takes `format: "jpeg"`, and a `quality` for WebP and JPEG.
- **A busy server queues work instead of failing.** Renders wait their turn for one of `CUTTINGFLOOR_MAX_RENDERS` slots (half the CPUs by default), and a time limit counts from when the render starts, not while it waits. `create.motion`, `create.still` and `code.run` no longer take a job slot from exports while the sandbox works. Inside a script, `motion()` and `still()` started together render one at a time. Two scripts running at once no longer lose each other's `out/` files.
- **Errors you can retry.** Out of memory, a sandbox that is restarting or stopped mid-render now come back as `server_busy` with "call again in about a minute"; the docker hint shows only on a local server.
- **Queued jobs say why.** `job.get` says where a waiting job stands and what it waits for ("queued: 2 ahead, waiting for a free job slot (running now: export.video, qa.check)", a render slot, or the sandbox). `code.run` says which call it is waiting on, and time spent in queues no longer counts against its `timeout_seconds`.
- **Edits.** `transition.add {kind: "crossfade"}` on a video clip crossfades its sound and leaves the picture as a hard cut, and `changed` lists each transition (with track and kind), timeline effects and `audio.set_master`. `clip.set_transform {fit: "none"}` shows a graphic at its own pixel size. Fonts that aren't installed are refused with real ones to pick from. A title or caption that covers text already on its track says so. Freezing a clip's last frame holds it after the clip. Captions made per clip meet at the cut with no gap. Speed ramps say what `at` measures, and `timeline.get` gives each point its source frame.
- **Clearer descriptions.** How exact transcript word times are and how to cut on speech instead, what `skills.search` scores mean, and that `code.run` keeps the last 16 KB of output. The cut-pauses skill's crossfade step is fixed.
