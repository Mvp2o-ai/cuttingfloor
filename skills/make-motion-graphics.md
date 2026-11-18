---
name: make-motion-graphics
description: Make a motion graphics video like a professional motion designer, from brief to delivered master and any cutdowns. Brief, storyboard, animate each scene in HTML with professional-grade easing, camera and timing, assemble, score and export. Use when someone asks for motion graphics, an animated intro, title sequence, logo build, kinetic type, an explainer, promo or launch animation, or to animate a storyboard.
version: 7
type: playbook
source: system
author: Sanji Nai-Chien
author_url: https://www.youtube.com/watch?v=D5qpBbEWTxo
related: storyboard-before-animate:prerequisite, spend-credits-wisely:prerequisite
---

# Make motion graphics like a pro

Brief, board, build each scene, look at it, then assemble. Every frame is a function of time.

## When to use
- Someone wants a video made from nothing but a message and a look: an intro, a title sequence, a logo build, kinetic type, an explainer or promo animation.
- A storyboard exists and needs animating.

## Prerequisites
- The cuttingfloor MCP server is connected.
- A storyboard from `storyboard-before-animate` (read it with `skills.get`), as short as the piece: one line per scene does for a few seconds. Without one the scenes come out in random order and everything moves at once.
- Whatever brand the request brings: colours as hex, font files, a logo as SVG. Vector artwork stays sharp when the camera pushes in; a bitmap does not.

## Steps
1. The assistant should pin the brief before anything else: the one message, a single sentence the viewer should remember; who it is for and where it plays; what must be on screen (a name, a logo, a line of copy); the tone (for example bold, playful, calm, premium); whether there is a voice, music or only sound effects; the deliverables: the length, shape and sizes the request asks for, a master and any cutdowns.

2. The assistant should get a storyboard and keep to it. If none exists, run `storyboard-before-animate` with the brief as its source. The storyboard is the source of truth for scene order, length, on-screen content and camera: never reorder, add or drop a scene while animating. A change of content goes back to the board first.

3. The assistant should restate the board as a scene list in frames and check the sum. The scene lengths must add to exactly the board's total (its seconds × the frame rate). Pick the frame rate now: 60 fps for fast or detailed motion, the sequence rate otherwise.

4. The assistant should write one shared theme and one config before any scene. The theme holds the colours, the fonts and the easing constants; the config holds every piece of copy, every number and every colour a client might change, so a revision is a one-line edit. Use an installed font by name, or import a font file with `media.import` and pass it to `create.motion` as an asset (`url(assets/<name>)`); a fallback font in a render is a bug. Paste SVG artwork into the page, scaled by one uniform factor and centred.

5. The assistant should build each scene as its own `create.motion` page at the scene's exact length, `transparent: false` for a full-frame scene and `true` for an overlay. One call holds at most 30 s of 1080p30 in pixels × frames, so a longer or larger video needs more than one page; one page per scene also means a revision re-renders one scene. Drive every element from time (CSS animations, the Web Animations API, anime.js from `lib/`, or `window.__seek(seconds)`), never from real-time logic. Structure the page like a compositing project:
   - One camera container per scene; every pan and zoom on it uses ease-in-out, and a full-width pan takes at least 0.8 s.
   - Parenting: group related elements under one parent and animate the parent, not each piece.
   - Offset: each element in a group starts 2–4 frames after the one before it. Repeated things (letters, cards, rows) never appear all at once.
   - Overlap: start the next move during the last ~20% of the previous one.
   - Lay everything out from the canvas centre, not the edges, so the same page re-renders at other shapes. Titles stay 5% inside every edge; the key element of every shot stays inside the centre square.

6. The assistant should animate to these numbers:
   - Nothing moves linearly.
   - Entrances take ~0.5 s with a slight overshoot: `cubic-bezier(0.34, 1.56, 0.64, 1)`, or a spring with damping ~14.
   - Exits take ~60% of the entrance and ease in.
   - Anything important (a headline, a name, a number) holds at least 1.5 s.
   - Count-ups run ~1 s with ease-out, through the in-between values; a number never jumps to its final value in one frame.
   - Nothing ever fully stops: a holding element drifts slowly (scale 1 → 1.02 or ±4 px) and the camera keeps a micro push-in. Backgrounds sit behind the foreground with a light parallax.

7. The assistant should look at each scene before building the next one. Read its key frame and its first and last frames with `render.frames`. Check for text that overlaps, a fallback font, an element that left the canvas without exiting on purpose, a counter that skipped, and a group that appeared all at once. Fix the page and re-render that scene only.

8. The assistant should assemble the master. Every scene sits at the `at_frame` the scene list gives, never chained off the previous clip. Cuts between scenes are usually hard cuts on the motion; add `transition.add` only where the board calls for one. For music, import it, find its beats with `media.analyze {kind: "beats"}` and land the scene changes and the logo hit on beats; add sound effects for hits on their own tracks; set the mix with `audio.set_master`. Run `qa.check`, then `export.video`.

9. The assistant should make any cutdowns from the same pages. Re-render each scene at the cutdown's size with the same config, on a timeline of that shape, and read the frames again: a layout that works at only one shape shows here.

10. The assistant should handle a revision as the smallest change that solves it: edit the config or the one scene page, re-render that scene, swap it in with `clip.replace`, and keep everything else as it was.

## Decision table
| Situation | Do |
|---|---|
| No storyboard | Run `storyboard-before-animate` from the brief, as short as the piece |
| Only a bitmap of the logo or artwork | Rebuild it in SVG or HTML so it stays sharp when the camera moves |
| A scene does not serve the one message | Raise it on the board and cut it there, not in the animation |
| The text cannot be read in time | Lengthen the hold to 1.5 s on the board and re-reconcile the total there |
| A scene is too long for one `create.motion` call | Split it at a camera move into two pages and two clips |
| A motion feels mechanical | Add the overshoot, the offset and the overlap before adding more motion |

## Required behavior
- Keep to the storyboard: never reorder, add or drop its scenes while animating.
- Keep scene lengths in frames and make them sum to the storyboard's total exactly.
- Keep copy, numbers and colours in one config, fonts as named or imported fonts, and artwork as SVG.
- Render one page per scene and read its frames back before moving on.
- Change only what a revision asks for.
