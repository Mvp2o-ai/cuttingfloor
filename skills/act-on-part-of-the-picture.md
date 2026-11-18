---
name: act-on-part-of-the-picture
description: Act on one area or one thing in the picture of a video and leave the rest of the frame untouched, with cuttingfloor. Select it (a shape, a box from faces, tracking or judge.ask, or a cutout of the subject), then act on that selection only - blur or pixelate it, grade it, or paint it out of the shot. Use when someone asks to blur or pixelate a face, a logo, a screen or a number plate, or to grade or paint out one object in a shot.
version: 2
type: playbook
source: system
author: Ken Wiltshire
related: spend-credits-wisely:prerequisite
---

# Act on part of the picture

## When to use
- Someone wants one area or one thing changed and the rest of the picture untouched: "blur my face for the first 5 seconds", "pixelate the number plate", "brighten the mug", "make the sign black and white", "remove the logo".
- The change can last the whole clip or one stretch of it, and the area can stay still or move.

## Prerequisites
- The cuttingfloor MCP server is connected.
- The video is imported (`media.import`) and on a timeline with `clip.add`.

## Steps
1. The assistant should find the area, as fractions of the frame:
   - one thing that may move (a face, a product, a sign): its boxes over time from `media.analyze {kind: "faces"}`, or `{kind: "track"}` from a box you give at one moment;
   - one thing you can describe but not box: `judge.ask` with a box question on a frame from `render.frames`;
   - a whole subject with its own outline (a person, an animal, a product): `create.cutout`, whose alpha becomes a `matte` mask;
   - a fixed area (a corner, a band, a screen): a shape you set yourself.
2. The assistant should put a copy of the clip on the video track above it, covering only the stretch to change: `clip.add` of the same media with `av: "video"` at the same timeline frame and the same source frames, so the copy lines up frame for frame. An adjustment clip will not do here: its effects cover the whole picture, and a mask does not narrow them.
3. The assistant should select the area on the copy: `clip.set_mask {mode: "show"}` with the shape (ellipse, rectangle, polygon) or the matte, a little larger than the thing itself, and a small `feather` so the edge does not show. For a thing that moves, key the mask's `x`, `y`, `width` and `height` from the boxes, a keyframe at each box time. The rest of the copy is clear, so the original shows through everywhere else.
4. The assistant should act on the copy, which is now only the selection:
   - blur: `filter.add {name: "blur"}`; its radius is a fraction of the frame height (0.05 to 0.1 makes a face unrecognisable);
   - pixelate, grade, brighten, black and white: the matching effect from `video://catalog/effects`.
   To remove the thing instead, skip the copy: `clip.set_mask {mode: "fill"}` on the original clip paints the area from the picture around it.
5. The assistant should check the result with `render.frames` at the start, middle and end of the stretch, and wherever the thing moves fastest: the selection must cover it on every frame, and nothing outside it should change.

## Decision table
| Situation | Do |
|---|---|
| The thing barely moves over the stretch | One fixed mask, sized from its largest box |
| The thing moves | Mask keyframes from the boxes, one per box time |
| Tracking or face boxes lose it for a few frames | Hold the last good box through the gap |
| The area must vanish, not just blur | `mode: "fill"` on the original clip; check frames where the background shows, since a fill can leave a smudge |
| A person's whole outline, not a box | `create.cutout`, then a `matte` mask on the copy |

## Required behavior
- The assistant should change only the area asked for, for only the time asked for.
- The assistant should look at frames before saying the area is covered.
