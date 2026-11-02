---
"cuttingfloor": patch
---

Fixes for fills and in-between frames:

- A cancelled or failed fill or in-between job no longer stays attached to its clip: the next render starts a new one.
- An export waiting for a fill or in-between job now gives up its job slot until that work is done, so it no longer holds up other jobs.
- job.get wait_seconds now answers when a job finishes, fails or is cancelled (or when the wait runs out), not at each step of progress.
- render.frames no longer shows an earlier frame in place of the last frames of a clip whose in-between copy ends with the media.
- A fill on a clip cut from the middle of a file whose frame rate is odd or varies now covers the clip's first frames.
- media.analyze on a stretch of a timeline only waits for copies of the clips in that stretch, as render.frames does.
- A fill's level follows the picture around it in each frame, which makes it blend in better during a flash.
