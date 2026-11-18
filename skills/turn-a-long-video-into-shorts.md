---
name: turn-a-long-video-into-shorts
description: Turn a long video (a gaming stream, a livestream, a podcast, a film, a lecture) into several vertical 9:16 Shorts with cuttingfloor. Find the strongest moments, cut each to 15 to 60 seconds with the hook first, reframe the wide picture to full-screen vertical by following the subject shot by shot (one transform for the whole Short, from shot changes and face boxes), add captions, and export each once. Use when someone asks for Shorts, Reels, TikToks or clips from a long video, to "repurpose", "clip" or "cut down" a stream or episode, or to make a wide video vertical.
version: 1
type: playbook
source: system
author: Ken Wiltshire
related: spend-credits-wisely:prerequisite, shorts-style-captions:related
---

# Turn a long video into Shorts

One import, the analyses once, then one timeline and one export per Short.

## When to use
- Someone hands over a long video and wants several short vertical clips from it.
- Someone wants a wide (16:9 or wider) video made vertical without black bars.

## Prerequisites
- The cuttingfloor MCP server is connected.
- The video is reachable as a file: a direct public link, an upload, or the user's upload page. A video site's page (YouTube, Twitch) is not a file; ask the user for the file itself.

## Steps
1. The assistant should import the video once with `media.import` and start the analyses together, waiting on them in one `job.get {job_ids}`: `transcript` (model `base` is about three times faster than `small`; use `small` only when the words come out wrong), `scenes {threshold: 10}` for every shot change, and `faces` (or `track` from a box, for a subject that is not a face: a car, a player, the action). Scenes and faces cover the whole video; their results are what the reframe is built from.
2. The assistant should find the moments. It reads the transcript as a script (`media.get {include: ["transcript"]}` in pieces for a long video) and asks `media.seek` in plain words for what the user cares about ("a big win", "a funny reaction", "the crowd going wild"). Each Short is 15 to 60 seconds and opens on its hook: the line or the action that makes someone stop scrolling, within the first two seconds. It checks each candidate with one 16-frame `render.frames` sheet of the media (free) before building it. Transcript entries in brackets (`[Music playing]`, `(dramatic music)`) are not speech: leave them out of captions.
3. The assistant should build each Short on its own timeline: `timeline.create` at 1080×1920 with the video's frame rate, and `clip.add` with `source: {in, out}` in frames.
4. The assistant should reframe the whole Short with one `clip.set_transform {fit: "cover", x: {keyframes}}`, one keyframe per shot with `ease: "hold"`, so the crop jumps on each cut and never drifts. For each shot (between two scene times):
   - keyframe frame = (shot start − the clip's source in, in seconds) × fps, from 0;
   - subject centre c (a fraction of the source width) = the centre of the largest face (x + w/2), or the midpoint of two faces when both fit in the visible width;
   - with cover, the picture is P = source width × (1920 ÷ source height) pixels wide, and the visible width is V = 1080 ÷ P of the source; clamp c between V/2 and 1 − V/2;
   - x = (540 + P/2 − c × P) ÷ 1080 (for a 1280×534 film, P = 4602 and x = (2841 − 4602 × c) ÷ 1080);
   - a shot with no face keeps the previous value.

   The result's `placements` give, per shot, the `source` box that shows: check it is the subject.
5. The assistant should look at one frame per shot with `render.frames` (up to 16 on a sheet, free) and fix any shot whose crop misses the subject by changing that keyframe.
6. The assistant should add captions with `caption.add {in_clip: {clip_id, segments}}` in transcript seconds, 3 to 6 words a segment, with word timings for highlighting. For a styled band or box behind them, it follows shorts-style-captions.
7. The assistant should export each finished Short once with `export.video` (`mp4_h264`), all of them started together, and hand back each download link and page link, with where in the long video each one came from.

## Decision table
| Situation | Do |
|---|---|
| Two people far apart in one shot, both needed | A stack: the same clip twice on two video tracks, each `fit: "cover"` with its x on one face, each shown only in its half with `clip.set_mask` (a rectangle over the top or bottom half), and moved with `y` so its face sits in that half |
| A gaming stream with a facecam in a corner | Two copies of the clip: the facecam cropped (`crop`) and scaled across the top third, the gameplay `cover` below, its x on the action |
| The action is spread across the whole wide picture (a strategy game, a wide landscape) | Picture `fit: "contain"` in the middle over a blurred `cover` copy of itself (`filter.add` blur, radius a fraction of the frame height, about 0.04, background `scale` 1.2 so its blurred edges sit off screen) |
| No face in the video at all | `track` the subject from a box at its first appearance, and use the box centres the same way as face centres |
| Music or effects drown the speech in the transcript | Retime or retype those captions from `render.frames` and listening; don't caption bracketed sound tags |
| The user wants several Shorts | One import and one set of analyses for all of them; one timeline and one export each |

## Required behavior
- Import and analyse the long video once, never once per Short.
- One keyframe per shot with hold, never a drifting crop between cuts.
- Look at one frame per shot before exporting.
- Say where each Short came from in the long video (start and end times).
