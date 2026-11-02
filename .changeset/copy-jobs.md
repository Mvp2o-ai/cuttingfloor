---
"cuttingfloor": patch
---

In-between frames (clip.set_speed interpolate) are now a job of their own, like fills. They show in job.list with progress per frame, an export waits for them without being stopped as stalled, and render.frames answers media_not_ready naming the job instead of timing out. A render only waits on copies for clips at the frames it shows. A fill or an in-between copy is now made once per clip, whatever size it is shown at. A not-ready answer gives the job's place in the queue or its measured time left, not a guess. A fill also reuses the real picture from earlier frames where the area showed, and the description says what follows: something that never moves against its background leaves a smudge. A slowed clip no longer shows its first frame twice. A stalled export now says that copies it had finished are kept for the next try.
