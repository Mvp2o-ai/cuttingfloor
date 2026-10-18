---
name: cut-pauses-ums-and-restarts
description: Clean up a talking video with cuttingfloor. Cut the long pauses, the ums, the lines the speaker started over, and lines said twice, then smooth every cut so nothing jumps. Use when someone asks to tighten a talking-head, vlog, interview, tutorial or listing video, remove dead air, remove filler words, or fix restarts and retakes.
version: 4
type: playbook
source: system
related: add-captions:related
---

# Cut pauses, ums and restarts

## When to use
- Someone hands over a talking video and wants it tighter: "cut the pauses", "take out the ums", "remove the bits where I start over", "make it flow".
- The video is one take or several takes in order (a phone recording, a Loom, an interview, a listing walkthrough).

## Prerequisites
- The cuttingfloor MCP server is connected.
- The video is reachable: a URL for `media.import {source: {url}}`, or a file on the user's machine sent with `media.upload` then `media.import {source: {upload_id}}`.

## Steps
1. The assistant should import every take with `media.import`, and wait with `job.get {job_id, wait_seconds: 50}` until each is ready. Several takes in order go on one timeline as they are; there is no need to join them first.
2. The assistant should transcribe each take with `media.analyze {kind: "transcript"}`. The words are right but their times are not exact: a word's end often stretches over the pause after it, and short "um"s and "uh"s are often missing from the text.
3. The assistant should measure where the speech really is with one `code.run` script over all takes (inputs: their media_ids). Read the words from `cf.media.get({media_id, include: ["transcript"]})["transcript"]["words"]` (the `analyses.transcript` entry is only a summary). FFmpeg is in the sandbox: run `silencedetect` (start at `n=-32dB:d=0.12`) on each take's audio, turn the silences into speech bursts, and print each take's words beside its bursts. Check the first burst against the first word: a soft opening ("okay, so") can sit under the threshold, and a threshold near the room noise counts breaths as speech, so adjust per take. Cut on burst edges, never on transcript times.
4. The assistant should have Jev mark the filler in the same `code.run` script, with `cf.judge.ask` (it uses cuttingfloor's own key; no key goes in the script). For each take, ask two yes/no questions per word, with the word marked `[[like this]]` in the take's text: "Is the marked word the first word of filler?" and "Is it the last word of filler?", where filler is "words the speaker can leave out so that what is left says exactly the same thing and still reads as a whole sentence: hesitations, verbal tics, a repeated word, the false start of a phrase they then say again, and throwaway asides", with a few short examples of each. Pair firsts (0.3 or more) with lasts up to 12 words on, ask "Are the marked words filler?" of each pair with the sentence as it would read without them, and keep the best spans first (0.6 or more), never overlapping. Up to 300 questions go in one call; a 10-second take needs about 7 calls in all and answers in under a second.
5. The assistant should review every span Jev marks before cutting; Jev finds the problems, the assistant decides the exact cut:
   - read the sentence without the span: if it lost meaning (a restart span that swallows the word the speaker kept, like "nobody"), choose the cut that keeps the clean last try instead;
   - move each cut to the nearest speech-burst edge, so no cut lands inside a continuous phrase (cut a whole repeated line, not "line. Just");
   - add the pauses from step 3 that are longer than about 0.6 s, trimmed to about 0.15 s each side of the speech; Jev reads text and does not see pauses;
   - keep an opening "okay, so" when it is the speaker's voice; cut it when the next words make a stronger start.
6. The assistant should build the cut on one timeline: `timeline.create` at the takes' size and frame rate, `clip.add` each take in order, then one `edit.batch` of `range.extract` ranges, latest first, so earlier frame numbers do not move. Or, often simpler: one `clip.add` per kept range with `source: {in, out}` in frames.
7. The assistant should smooth every cut: `transition.add {kind: "crossfade", duration_frames: 4, mode: "handles"}` on the clip before each cut (the video clip or its linked audio clip; either way only the sound crossfades and the picture cuts hard, and `changed` lists each crossfade added), and `clip.set_transform {scale: 1.1}` on every other section so a cut between two moments of the same shot reads as a cut-in rather than a jump.
8. The assistant should even out the sound if it needs it: `audio.set_master {gain_db, limit_db: -1}`, with the gain worked out from the loudness `qa.check` measures.
9. The assistant should look at its work before handing it over: `render.frames` on both sides of every cut, and `qa.check`.
10. The assistant should export with `export.video` (`social_9x16_h264` for vertical, `web_1080p_h264` otherwise) and hand back the file, saying how much was cut and that the order and every intended line are kept.

## Decision table
| Situation | Do |
|---|---|
| A pause is a deliberate beat before a punchline | Keep it, shortened to about 0.4 s |
| A restart changes the meaning ("no, sorry, 214 Maple") | Keep the corrected version only |
| A silent stretch shows something worth seeing (food, the room) | Keep the picture; it is B-roll, not dead air |
| The user wants captions as well | Group the kept words into captions and add them with `caption.add {in_clip: {clip_id, segments}}` per clip, in transcript seconds, then look at `render.frames` on both sides of every cut |

## Required behavior
- Never change the order of what was said, and never cut a line the speaker meant to keep.
- Cut on measured speech bursts, not transcript times.
- Say plainly what was cut: how many pauses, restarts and repeats, and the running time before and after.
