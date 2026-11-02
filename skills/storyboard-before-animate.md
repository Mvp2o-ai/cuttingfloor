---
name: storyboard-before-animate
description: Storyboard a video before any motion code is written. Lay out panel frames against a timed beat sheet, prove the timing against the audio, and lock a frame map. Use when someone asks to storyboard, board out, build a beat sheet or animatic, plan the timing or shot order of a talking-head, explainer, teaser or vertical video, lay out a script as frames, or work out screen time per beat before animating.
version: 1
type: playbook
source: system
---

# Storyboard before animate

References first, frames second, pictures last.

## When to use
- Someone has a script, transcript or idea and wants it planned before anything moves: "storyboard this", "board it out", "how long should each part be", "lay the script out as frames".
- Motion code is about to be written and the timing has not been settled yet.

## Prerequisites
- The cuttingfloor MCP server is connected.
- The spoken source is imported as media and carries a transcript analysis with word times.
- A timeline exists at the sequence's width, height and frame rate.

## Steps
1. The assistant should codify the references before any panel exists. Import each image that fixes how the video looks — the logo, the type sample, a colour or texture swatch — and record it on a reference sheet beside the palette, type sizes and framing rule it establishes. A file handed over as an asset is passed to the renderer and named `assets/<name>` in the page, so it appears exactly as it is. A look that was only shown, such as someone else's screenshot or video, is rebuilt in HTML and SVG and not imported, because importing it puts their pixels in the frame.

2. The assistant should derive the beat sheet in frames. Read the transcript words with their times, group them into beats — one beat per thought, not per sentence — and convert each beat's start and end into frames with the sequence rate. `influencer.mp4` at 50 seconds and 30 fps is 1500 frames. The sheet stays in frame numbers, because seconds get rounded wrong at least once per project.

3. The assistant should reconcile the beat sheet against the source before drawing a panel. Sum the beat lengths and compare with the take's frame count. A still's duration is null until one is given, so the storyboard is exactly as long as the panels placed: three 45-frame panels on a 1500-frame take come back as 135 frames, the other 1365 simply absent, and no tool reports it. Correct the budget here, because every correction after this point re-times the whole sequence.

4. The assistant should lay one still per beat, drawn at the sequence's exact width and height, because a 16:9 panel on a 9:16 sequence is a crop rather than a fit. Every panel renders from the step 1 reference set, so the palette and type are the same object in each one rather than a recollection of it. Each panel takes its beat length and an `at_frame` equal to the running sum computed in the sheet, never chained off the previous clip, because one wrong-length panel shifts every panel after it and the result still looks correct.

5. The assistant should read the stills back before locking. Render the panel start frames and look at each at full size: the render is the only thing that shows a crop, a clipped caption, a face the layout pushed past the frame edge, or a reference asset that failed to load. Verification costs 16 frames per contact sheet and 4 per call at full size, so 13 beats is four calls.

6. The assistant should lock the storyboard as the reference sheet, the beat sheet and the approved panels together, saved outside the server, which is not storage. Each locked panel is the reference for the beat it covers, so the reference set resolves once and downstream work needs no new reference pass.

7. The assistant should hand the locked frame map to the playbook that owns motion production and not write motion code here.

## Decision table
| Situation | Do |
|---|---|
| A beat's length is unsettled | Give it the length of its words; a beat with no words sits on the music, not on the clock |
| A panel works only because the HTML reflowed | Reject it and re-render at the sequence size |
| The reference set and the panels disagree | Fix the reference sheet and re-render the affected panels, not the whole board |
| The board runs long | Cut beats, then re-reconcile; trimming each panel spreads the loss rather than removing it |

## Required behavior
- Codify the references before the first panel, so palette, type and framing are the same object in every panel.
- Keep the beat sheet in frame numbers and reconcile the board against the take's frame count before drawing a panel.
- Read every panel back at the sequence size before locking, and lock the reference sheet, the beat sheet and the approved panels together.
- Hand the locked frame map to motion production rather than writing motion code in this step.
