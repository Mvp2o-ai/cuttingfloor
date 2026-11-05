---
name: storyboard-before-animate
description: Storyboard a video before any motion code is written. Lay out panel frames against a timed beat sheet, write what is on screen, how it moves, where the camera goes and how long it stays, prove the timing against the audio, and lock a frame map. Use when someone asks to storyboard, board out, build a beat sheet or animatic, plan the timing or shot order of a talking-head, explainer, launch, promo, teaser or vertical video, lay out a script or brief as frames, or work out screen time per beat before animating.
version: 2
type: playbook
source: system
related: make-motion-graphics:related
---

# Storyboard before animate

References first, frames second, pictures last.

## When to use
- Someone has a script, transcript, brief or idea and wants it planned before anything moves: "storyboard this", "board it out", "how long should each part be", "lay the script out as frames".
- Motion code is about to be written and the timing has not been settled yet.

## Prerequisites
- The cuttingfloor MCP server is connected.
- With speech: the spoken source is imported as media and carries a transcript analysis with word times.
- Without speech (music and sound effects only): a brief that fixes the total length and what must be shown, and the music, if chosen, imported with a beats analysis.
- A timeline exists at the sequence's width, height and frame rate.

## Steps
1. The assistant should codify the references before any panel exists. Import each image that fixes how the video looks — the logo, the type sample, a colour or texture swatch — and record it on a reference sheet beside the palette, type sizes and framing rule it establishes. A file handed over as an asset is passed to the renderer and named `assets/<name>` in the page, so it appears exactly as it is. A look that was only shown, such as someone else's screenshot or video, is rebuilt in HTML and SVG and not imported, because importing it puts their pixels in the frame.

2. The assistant should derive the beat sheet in frames. With speech, read the transcript words with their times, group them into beats — one beat per thought, not per sentence — and convert each beat's start and end into frames with the sequence rate. `influencer.mp4` at 50 seconds and 30 fps is 1500 frames. Without speech, take the beats from the brief's must-show list and split the total among them, landing each boundary on a music beat where there is music. The sheet stays in frame numbers, because seconds get rounded wrong at least once per project.

   Give every beat its job in the story: hook (grab attention), problem, fix (the product or idea solving it), payoff, and close (logo and call to action). A beat that serves none of these is cut here. Then write four things per beat, since a panel shows only one instant:
   - On screen: every element and every word of copy.
   - Motion: how each element enters, works and leaves (drops in staggered, counts up over 1 s, types into the bar, word by word).
   - Camera: where it goes (slow push-in 100% → 106%, pan left to right following the cursor, zoom to 130% on the click, pull back to reveal).
   - Length: start and end frame. Anything the viewer must read — a headline, a number, a key UI state — holds at least 1.5 s (45 frames at 30 fps, 90 at 60 fps).

   For example: `Scene 1 · Pile-up (hook) — frames 0–240. On screen: task cards drop and stack into a pile; counter "Open tasks 0 → 200"; headline "200 tasks. Before lunch." Motion: cards drop with overshoot, staggered; counter counts up over 1 s; headline word by word. Camera: slow push-in 100% → 106%.`

3. The assistant should reconcile the beat sheet against the source before drawing a panel. Sum the beat lengths and compare with the take's frame count. A still's duration is null until one is given, so the storyboard is exactly as long as the panels placed: three 45-frame panels on a 1500-frame take come back as 135 frames, the other 1365 simply absent, and no tool reports it. Correct the budget here, because every correction after this point re-times the whole sequence.

4. The assistant should lay one still per beat, drawn at the sequence's exact width and height, because a 16:9 panel on a 9:16 sequence is a crop rather than a fit. Every panel renders from the step 1 reference set, so the palette and type are the same object in each one rather than a recollection of it. Each panel takes its beat length and an `at_frame` equal to the running sum computed in the sheet, never chained off the previous clip, because one wrong-length panel shifts every panel after it and the result still looks correct.

5. The assistant should read the stills back before locking. Render the panel start frames and look at each at full size: the render is the only thing that shows a crop, a clipped caption, a face the layout pushed past the frame edge, or a reference asset that failed to load. Verification costs 16 frames per contact sheet and 4 per call at full size, so 13 beats is four calls.

6. The assistant should lock the storyboard as the reference sheet, the beat sheet and the approved panels together, saved outside the server, which is not storage. Each locked panel is the reference for the beat it covers, so the reference set resolves once and downstream work needs no new reference pass.

7. The assistant should hand the locked frame map to `make-motion-graphics` (read it with `skills.get`) and not write motion code here. From here the board is the source of truth: animation never reorders, adds or drops a beat, and a change of content comes back to the board first.

## Decision table
| Situation | Do |
|---|---|
| A beat's length is unsettled | Give it the length of its words; a beat with no words sits on the music, not on the clock |
| A beat holds something to read for under 1.5 s | Lengthen it and take the frames from a beat that has room, then re-reconcile |
| Only a brief, no script | Draft the beats from the must-show list in story order: hook, problem, fix, payoff, close |
| A panel works only because the HTML reflowed | Reject it and re-render at the sequence size |
| The reference set and the panels disagree | Fix the reference sheet and re-render the affected panels, not the whole board |
| The board runs long | Cut beats, then re-reconcile; trimming each panel spreads the loss rather than removing it |

## Required behavior
- Codify the references before the first panel, so palette, type and framing are the same object in every panel.
- Give every beat a story job and write on screen, motion, camera and length for each; cut a beat with no job.
- Keep the beat sheet in frame numbers and reconcile the board against the take's frame count before drawing a panel.
- Read every panel back at the sequence size before locking, and lock the reference sheet, the beat sheet and the approved panels together.
- Hand the locked frame map to motion production rather than writing motion code in this step.
