---
name: make-motion-graphics
description: Make a motion graphics video like a professional motion designer, from brief to delivered master and cutdowns. Brief, storyboard, animate each scene in HTML with After Effects-grade easing, camera and cursor work, assemble, score and export. Use when someone asks for a launch, promo, explainer or product video, a SaaS or app launch video, animated product UI, kinetic type, an animated logo or CTA, to animate a storyboard or Figma screens, or for motion graphics in general.
version: 1
type: playbook
source: system
related: storyboard-before-animate:prerequisite
---

# Make motion graphics

Brief, board, build each scene, look at it, then assemble. Every frame is a function of time.

## When to use
- Someone wants a video made from nothing but a product, a message and its brand: a launch, promo or explainer, animated UI, kinetic type, a logo build.
- A storyboard exists and needs animating, or Figma screens need to move.

## Prerequisites
- The cuttingfloor MCP server is connected.
- A locked storyboard from `storyboard-before-animate` (read it with `skills.get`). Without one the scenes come out in random order and everything moves at once.
- The brand: colours as hex, font files, logo as SVG. UI screens exported from Figma as SVG, not screenshots.

## Steps
1. The assistant should pin the brief before anything else, in seven lines: what the product is and who it helps; the audience (roles, company size); where it plays (launch page, site hero, paid social); the one message, a single sentence the viewer should remember; the must-show list (hook: the pain in one image; problem: what the user does today and why it hurts; product: the key feature in the real UI; payoff: the result; logo and CTA); the tone (for example confident, clean, fast, premium rather than cartoonish) and whether there is a voice or only music and sound effects; the deliverables (by default a 30 s 16:9 master at 1920 × 1080, plus 9:16 and 1:1 cutdowns). Ask for what is missing rather than inventing it.

2. The assistant should get a locked storyboard. If none exists, run `storyboard-before-animate` with the brief as its source. The storyboard is the source of truth for scene order, length, on-screen content and camera: never reorder, add or drop a scene while animating. A change of content goes back to the board first.

3. The assistant should restate the board as a scene list in frames and check the sum. At 60 fps a 30.0 s video is 1800 frames, and the scene lengths must add to exactly that. Pick the frame rate now: 60 fps for UI and cursor work, the sequence rate otherwise.

4. The assistant should write one shared theme and one config before any scene. The theme holds the colours, the `@font-face` rules and the easing constants; the config holds every piece of copy, every number and every colour a client might change, so a revision is a one-line edit. Import each font file with `media.import` and pass it to `create.motion` as an asset (`url(assets/<name>)`); a fallback font in a render is a bug. Paste the Figma SVG markup into the page, scaled by one uniform factor (a 1440-wide frame is ×1.333 to fill 1920) and centred, because SVG stays sharp when the camera pushes into a button and a screenshot does not.

5. The assistant should build each scene as its own `create.motion` page at the scene's exact length, `transparent: false` for a full-frame scene and `true` for an overlay. One call holds at most 30 s of 1080p30 in pixels × frames, so a 30 s 1080p60 master does not fit in one page; one page per scene also means a revision re-renders one scene. Drive every element from time (CSS animations, the Web Animations API, anime.js from `lib/`, or `window.__seek(seconds)`), never from real-time logic. Structure the page like an After Effects comp:
   - One camera container per scene; every pan and zoom on it uses ease-in-out, and a full-width pan takes at least 0.8 s.
   - Parenting: group related elements under one parent and animate the parent, not each piece.
   - Offset: each element in a group starts 2–4 frames after the one before it. Repeated things (cards, rows, checkmarks) never appear all at once.
   - Overlap: start the next move during the last ~20% of the previous one.
   - Lay everything out from the canvas centre, not the edges, so the same page re-renders at 1080 × 1920 and 1080 × 1080. Titles stay 5% inside every edge; the key element of every shot stays inside the centre square.

6. The assistant should animate to these numbers:
   - Nothing moves linearly.
   - Entrances take ~0.5 s with a slight overshoot: `cubic-bezier(0.34, 1.56, 0.64, 1)`, or a spring with damping ~14.
   - Exits take ~60% of the entrance and ease in.
   - Anything important (a headline, a number, a key UI state) holds at least 1.5 s.
   - Count-ups run ~1 s with ease-out, through the in-between values; a number never jumps to its final value in one frame.
   - Every click is a press: scale 1 → 0.96 → 1 over ~8 frames.
   - The cursor travels on an arc (a quadratic Bézier with its control point offset ~15% of the distance), eases in and out, and settles with a tiny overshoot.
   - Nothing ever fully stops: a holding element drifts slowly (scale 1 → 1.02 or ±4 px) and the camera keeps a micro push-in. Backgrounds sit behind the UI with a light parallax.

7. The assistant should look at each scene before building the next one. Lay the scene on a timeline at its storyboard frame with `clip.add` and read its key frame and its first and last frames with `render.frames`. Check for text that overlaps, a fallback font, an element that left the canvas without exiting on purpose, a counter that skipped, and a group that appeared all at once. Fix the page and re-render that scene only.

8. The assistant should assemble the master. Every scene sits at the `at_frame` the scene list gives, never chained off the previous clip. Cuts between scenes are usually hard cuts on the motion; add `transition.add` only where the board calls for one. For music, import it, find its beats with `media.analyze {kind: "beats"}` and land the scene changes and the logo hit on beats; add sound effects for clicks and hits on their own tracks; set the mix with `audio.set_master`. Run `qa.check`, then `export.video` (H.264).

9. The assistant should make the cutdowns from the same pages. Re-render each scene at 1080 × 1920 and 1080 × 1080 with the same config, on a timeline of that shape, and read the frames again: a layout that works only at 16:9 shows here.

10. The assistant should handle a revision as the smallest change that solves it: edit the config or the one scene page, re-render that scene, swap it in with `clip.replace`, and keep everything else as it was.

## Decision table
| Situation | Do |
|---|---|
| No storyboard | Run `storyboard-before-animate` from the brief; do not animate without one |
| Only screenshots of the UI | Ask for the Figma SVG export; failing that, rebuild the screens in HTML and SVG |
| A scene does not serve hook, problem, fix or payoff | Raise it on the board and cut it there, not in the animation |
| The text cannot be read in time | Lengthen the hold to 1.5 s on the board and re-reconcile the total there |
| A scene is too long for one `create.motion` call | Split it at a camera move into two pages and two clips |
| A motion feels mechanical | Add the overshoot, the offset and the overlap before adding more motion |

## Required behavior
- Never animate without a locked storyboard, and never reorder, add or drop its scenes while animating.
- Keep scene lengths in frames and make them sum to the storyboard's total exactly.
- Keep copy, numbers and colours in one config, fonts as assets, and UI as SVG.
- Render one page per scene and read its frames back before moving on.
- Change only what a revision asks for.
