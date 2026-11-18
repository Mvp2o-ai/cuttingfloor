---
name: pan-and-scan
description: Pan and scan with cuttingfloor - fit a picture into a frame of another shape (wide to vertical 9:16, wide to square or 4:5, vertical to wide) with no bars, by moving a crop window over it shot by shot to keep the subject in view, in one transform for the whole clip. Use when someone asks to make a video vertical, square or wide, to reframe or resize it for TikTok, Reels, Shorts, Stories or a feed, to get rid of black bars, or to crop to a subject without losing them.
version: 3
type: playbook
source: system
author: Ken Wiltshire
related: subject-tracking:prerequisite, spend-credits-wisely:prerequisite
---

# Pan and scan

The picture covers the frame (`fit: "cover"`) and one `clip.set_transform` moves it under the frame: one keyframe per shot, held until the next cut, so the crop jumps on cuts and never drifts.

## When to use
- A picture must fill a frame of another shape: 16:9 or wider into 9:16, 1:1 or 4:5, or 9:16 into 16:9.
- Someone wants no black bars and the subject kept in view.

## Prerequisites
- The cuttingfloor MCP server is connected.
- A timeline at the target size with the clip on it.
- The subject's positions over time (subject-tracking) and the shot changes: `media.analyze {kind: "scenes", threshold: 10}`.

## Steps
1. The assistant should work out how much of the picture shows. With cover on a frame W × H, a wider picture is P = source width × (H ÷ source height) pixels wide and shows V = W ÷ P of its width; a taller picture is Q = source height × (W ÷ source width) pixels tall and shows V = H ÷ Q of its height. A `scale` above 1 multiplies P or Q and narrows V.
2. The assistant should pick each shot's subject centre c, a fraction of the source width (or height): from the subject's boxes in that shot (the median centre), the midpoint of two subjects only when their outer edges are less than V apart, and the previous shot's value when the shot has no subject. When two subjects are farther apart than V, one crop can't hold both: follow whoever is speaking (keyframes at the turns, from the transcript or `media.analyze {kind: "speakers"}`), or stack them (decision table). It clamps c between V/2 and 1 − V/2, so no edge shows.
3. The assistant should turn each c into the transform value: for a wider picture x = (W/2 + P/2 − c × P) ÷ W; for a taller picture y = (H/2 + Q/2 − c × Q) ÷ H. Example: a 1280×534 film into 1080×1920 has P = 4602 and x = (2841 − 4602 × c) ÷ 1080.
4. The assistant should set it in one call: `clip.set_transform {fit: "cover", x: {keyframes}}` (or `y`), one keyframe per shot at frame = (shot start − the clip's source in, in seconds) × fps, each with `ease: "hold"`. In a long shot where the subject walks across, it adds `smooth` keyframes inside that shot from the subject's boxes.
5. The assistant should read the result's `placements`: for each shot, the `source` box is the part of the picture that shows, which must hold the subject. Then it looks at one frame per shot with `render.frames` (up to 16 on a sheet, free) and fixes any keyframe that misses.

## Decision table
| Situation | Do |
|---|---|
| Two subjects farther apart than V, talking in turns | Follow the speaker: a keyframe at each turn, `smooth` for a quick pan or `hold` for a cut |
| Two subjects too far apart to fit in V, both needed at once | A stack: the clip twice on two video tracks, each panned to one subject and shown in its half with `clip.set_mask` |
| A small subject in a wide shot | `scale` above 1 to punch in, with P or Q scaled to match |
| The action fills the whole wide picture (a game, a landscape) | Letterbox instead: `fit: "contain"` over a blurred `cover` copy of itself (`filter.add` blur, radius a fraction of the frame height, about 0.04; background `scale` 1.2 so its blurred edges sit off screen) |
| A screen recording, slides or text across the width | Letterbox or a stack; panning would cut words |
| One shot inside the clip is a title card or wide text ("40 YEARS LATER") | Split the clip at that shot (`clip.split`) and letterbox only that piece; panning cuts the words |

## Required behavior
- One transform for the clip, one held keyframe per shot; never a crop that drifts across a cut.
- Never a frame edge or bar showing: c clamped within the picture.
- Check one frame per shot before exporting.
