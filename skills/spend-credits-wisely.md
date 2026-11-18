---
name: spend-credits-wisely
description: Get the most out of a cuttingfloor account's credits on any job. What spends credits (server time on imports, analysis, exports and create.*, and judgments) and what is free (every edit, previews, frames, reading kept results), so the assistant checks its work for free, imports and analyses once, makes many outputs from one import, and does one full export per finished piece. Use before any long video, any job with several outputs (Shorts, versions, languages), any repeated graphic such as subtitles or labels, or when credits are low or a job was refused with quota_exceeded.
version: 1
type: playbook
source: system
author: Ken Wiltshire
---

# Spend credits wisely

Credits pay for the server's working time, not for the length of the video: a job spends one credit for each minute it runs (importing, analysing, exporting, creating), and judgments (judge.ask, media.seek, look) spend 200 to a credit. Everything else is free.

## When to use
- Before working on a long video (a stream, a film, a lecture): importing and analysing it is most of the cost.
- Before a job with several outputs: Shorts cut from one video, versions, sizes, languages.
- Before making the same kind of graphic many times: subtitles, labels, lower thirds, callouts.
- When credits are low, or a job came back refused with `quota_exceeded`.

## Prerequisites
- The cuttingfloor MCP server is connected.

## Steps
1. The assistant should import each source once. The same file always returns the same media_id, so every timeline, Short and version reuses it; nothing is imported twice, and a finished export that is needed as a source is imported by its job_id.
2. The assistant should analyse only the kinds the job needs (a transcript to cut by words, beats to cut to music, faces or track to reframe), once per media. Results stay with the media: read them again with `media.get {include}`, which is free, instead of running the analysis again.
3. The assistant should check its work with the free previews: the inline preview an edit returns, `render.frames` (up to 16 frames on one sheet), `timeline.get` and `timeline.diff`. To watch motion or hear sound, it exports only the few seconds in question (a range, with `mp4_h264_fast`), never the whole edit.
4. The assistant should make one graphic and reuse it rather than one per line: a band, box or card behind changing text is one `create.matte`, `create.still` or `create.motion` placed for as long as needed, and the words that change are `caption.add` or `title.add`, which are free edits.
5. The assistant should build every output from the same imported media, on its own timeline (one per Short or version), and run one full `export.video` per finished piece, at the end, once it has looked at it.
6. The assistant should start independent jobs together (several imports, analyses or exports) and wait for them in one `job.get {job_ids}`, so the work finishes sooner without costing more.
7. The assistant should, when a job is refused with `quota_exceeded`, tell the user plainly that jobs wait for credits while editing and previews still work, and carry on with the free work.

## Decision table
| Situation | Do |
|---|---|
| A long video, but the user only needs part of it | Import it once and cut that part; don't import the same file again for each output |
| The transcript or another analysis was already run | Read it with `media.get {include}`; don't analyse again |
| Checking whether a cut, transition or overlay looks right | `render.frames` at those frames; free |
| Checking motion or sound | Export a short range with `mp4_h264_fast` |
| Subtitles or labels in a styled box or band | One graphic for the band, `caption.add` for the words; not one picture per line |
| Several Shorts or versions from one video | One import, one timeline each, one full export each |
| A full export to "see how it looks" | Don't: frames and a short range show it for a fraction of the cost |

## Required behavior
- Never re-import a file or re-run an analysis that already exists.
- Never run a full export just to check work; export the whole piece once, when it is done.
- Never draw text that changes over time as one picture per line.
- Say plainly when a step will spend a lot (a long import or analysis) before starting it on a short budget.
