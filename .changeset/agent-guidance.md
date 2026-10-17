---
"cuttingfloor": minor
---

Agents no longer have to guess. The server instructions now offer two ways to work: make new media with `create.*`, where a reference the user shows you is rebuilt in HTML rather than imported, or `media.import` the user's own files. `timeline.create` returns its tracks, so the first `clip.add` knows its `track_id`. `job.get {wait_seconds}` holds the call until a job finishes, instead of repeated polling. Output schemas no longer forbid extra fields, so a field added in a later release doesn't fail results in clients still holding the old schema. Media at exactly 24, 30 or 60 fps is no longer read as 23.976, 29.97 or 59.94.
