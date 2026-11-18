---
name: subject-tracking
description: Subject tracking with cuttingfloor - get where a person, face or object is in the picture over time, and turn those positions into keyframes that make something follow it - a title, sticker, arrow or logo pinned to it, a mask that moves with it (blur, grade, hide), or a crop window that keeps it in frame. Use when something must stay on or with a moving subject, when someone asks to follow, pin to, stick to, track or keep someone in frame, or when another job needs a subject's position at each moment.
version: 1
type: playbook
source: system
author: Ken Wiltshire
related: spend-credits-wisely:prerequisite
---

# Subject tracking

Positions come from the server's analyses as boxes in fractions of the picture (x, y the top-left corner, w, h the size); keyframes come from boxes.

## When to use
- A title, sticker, arrow, logo or label must stay on a moving person or thing.
- A mask (blur, grade, hide, fill) must move with its subject.
- A crop window must keep a subject in frame (see pan-and-scan).

## Prerequisites
- The cuttingfloor MCP server is connected.
- The media is imported and ready.

## Steps
1. The assistant should get the subject's boxes with the analysis that fits it:
   - faces: `media.analyze {kind: "faces"}`, every face five times a second over the whole media, read with `media.get {include: ["faces"], from_seconds, to_seconds}` for the stretch it needs;
   - anything else that moves: `media.analyze {kind: "track", region: {x, y, w, h, at_seconds}}`, from a box drawn where the subject is at one moment (find that box with `judge.ask` box on one frame, or by looking with `render.frames`); `found: false` marks where it was lost;
   - a thing described in words that comes and goes: `look` with a box question and a yes/no question about whether it is there, using the box only on frames where the answer is yes.
2. The assistant should pick one subject per moment when there are several boxes: the largest box, or the box nearest the subject's previous position, so the choice doesn't jump between people.
3. The assistant should turn boxes into keyframes: frame = the timeline frame where the clip plays that media second (clip start + (box time − source in seconds) × fps), minus the clip's start; centre x = box x + w/2, centre y = box y + h/2, plus any offset. That holds for an overlay on a clip that fills the frame unchanged; for a clip that is scaled, moved or cropped, it maps the box through that clip's transform first (the clip's `placements` say which source pixels show where).
4. The assistant should keep the motion clean: skip boxes with `found: false` or a low score, keep one keyframe every two to five samples with `ease: "smooth"` for steady motion, and use `ease: "hold"` at shot changes (from `media.analyze {kind: "scenes", threshold: 10}`) so nothing slides across a cut.
5. The assistant should apply the keyframes: `clip.set_transform {x, y}` for an overlay, or `clip.set_mask {x, y, width, height}` for a moving selection.
6. The assistant should check a few frames across the stretch with `render.frames` (free) and correct a keyframe where the subject was missed.

## Decision table
| Situation | Do |
|---|---|
| The subject is a face | `faces`, read for the stretch needed |
| The subject is not a face (a car, a ball, a product) | `track` from a box at one moment |
| The subject leaves and comes back | `look` with a box question and a "is it there" question; keyframes only where it is there |
| Several people, one to follow | The largest box, or the nearest to the last position |
| The overlay should sit beside the subject, not on it | Add a fixed offset to every keyframe |

## Required behavior
- Positions come from the analyses, never guessed from a few looks.
- No keyframe slides across a shot change.
- Check frames before exporting.
