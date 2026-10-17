---
"cuttingfloor": minor
---

Agents no longer have to guess. The server instructions now offer two ways to work: make new media with `create.*`, where a reference the user shows you is rebuilt in HTML rather than imported, or `media.import` the user's own files. `timeline.create` returns its tracks, so the first `clip.add` knows its `track_id`. `job.get {wait_seconds}` holds the call until a job finishes, instead of repeated polling. Output schemas no longer forbid extra fields, so a field added in a later release doesn't fail results in clients still holding the old schema. Media at exactly 24, 30 or 60 fps is no longer read as 23.976, 29.97 or 59.94.

Titles and captions placed after the first frame of a timeline now render (libass was timed from the clip, but reads timeline time). Edit results say where each added or moved clip now sits (`track_id`, `start`, `end`). A transition left short of source by a speed change, trim or slip is shortened to fit instead of removed. A title with a reveal previews once it's fully shown. Cached preview frames are cleared on start, so a new build never serves an old render.

Editing works like CapCut. The main (bottom) video track is magnetic: `clip.add` and `clip.move` insert, and `clip.remove`, `clip.move` and `clip.trim` ripple there by default, so no gaps open; layers above stay free-form, and `mode`/`ripple` still override. `title.add` and `caption.add` take an optional `track_id`: without one, text goes on the lowest free layer above the main track, made if needed. `clip.add` without a `track_id` goes on the main track, and `clip.add {overlay: true}` on a free layer above it.
