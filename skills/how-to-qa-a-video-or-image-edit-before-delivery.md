---
name: how-to-qa-a-video-or-image-edit-before-delivery
description: QA an edit before delivery with cuttingfloor. Check the finished cut against the request in the user's own words: write the acceptance list first, measure it with qa.check (gaps, offline media, frame count, loudness, true peak, black and silent stretches, speech at every cut), check captions and on-screen text, look at rendered frames, and confirm nothing else changed with timeline.diff; for a still image check crop and aspect, resolution, artifacts, upscaling, text legibility and colour. For music made in a score, which cannot be heard from here, read it back with measurements: clipping, the tune's notes, its hits against the picture's moments, the words under it. Use when someone asks to QA, check, review or sign off an edit before it goes out, to confirm a delivery is finished, to verify a render matches what was asked, or to find what is wrong with a cut before sending it.
version: 3
type: playbook
source: system
author: Ken Wiltshire
related: cut-pauses-ums-and-restarts:related, pan-and-scan:related
---

# How to QA an edit before delivery

An edit is finished when the assistant has checked it against the request and can show the evidence. A render that plays is not a check. `qa.check` is the measuring step of this procedure: it returns facts, never a verdict; the verdict is this procedure's.

## When to use
- An edit is about to be exported and given to the user, and it has to be checked against what they asked for.
- Music was made in a score and is about to be given to the user, alone or under a video: it cannot be heard from here and has to be read back.
- Someone asks to QA, check, review, verify or sign off a video or a still image, to confirm a delivery is finished, or to find what is wrong with a cut before it goes out.
- A delivery has to show its evidence: the number, frame or quotation that decided each item on the list.

## Prerequisites
- The user's request, in their own words, available to re-read.
- The timeline_id of the edit, and the timeline_id it started from (to compare what changed).
- For speech checks, a transcript on the media (`media.analyze {kind: "transcript"}`), so `qa.check` can name the words cuts go through.

## Steps
1. The assistant should write the acceptance list first. Re-read the user's request and write one yes/no claim per thing they asked for, in their own words rather than a summary of intent. A request to tighten a piece becomes a claim about duration; a request to make it pop becomes a claim about the grade and the cuts. Where the request is ambiguous, ask before editing, not after.
2. The assistant should measure the timeline with `qa.check {timeline_id}`, adding `speech {min_probability: 0.5}` for anything with talking, `black {pixel_threshold, picture_share, min_seconds}` and `silence {threshold_db, min_seconds}` where black or dead air would be a fault (the settings are the assistant's, picked for the delivery; FFmpeg's defaults are 0.10, 0.98 and 2 s for black). It checks the timeline before export, so a failure costs no export. Read `gaps`, `offline_media` and `frames`: any gap, any offline media, or `frames.rendered` short of `frames.expected` is a hard failure, because a truncated render ends silent or frozen and playback hides it.
3. The assistant should check speech at every cut from `qa.check`'s `cuts`: `speech_before` and `speech_after`, the `silence_before_seconds` and `silence_after_seconds`, and on each edge the `out_word` or `in_word` a clip cuts through with its `seconds_cut`. A null word is a clean cut between words. A word cut with real loss is a failure unless the request asked for it; fix it at the word boundary the transcript gives (`clip.trim`, `clip.roll`), not by ear. Only junctions between two clips are listed: a lone clip's head and tail are not examined, so listen to those in step 6.
4. The assistant should check the audio level from `integrated_lufs` and `true_peak_dbtp` against the target for where it goes (the table below; say which one was picked). Too quiet or too hot: `audio.set_master {gain_db, limit_db}` with the gain worked out from the measurement, then `qa.check` again. The limiter caps sample peaks, so the true peak can still land above the ceiling; the measurement is what counts.
5. The assistant should check captions and on-screen text. Confirm from `timeline.get` that captions exist where they were asked for, then `render.frames` at the head, middle and tail of the piece to see they are in sync, inside the frame and neither cut off nor overflowing their line. Titles and overlays are checked the same way.
6. The assistant should look at the picture and listen. `render.frames` from the head, middle and tail of each section, judged against the acceptance list: framing, headroom, grade, skin tone, sharpness, safe area and aspect. `qa.check` does not measure luma or saturation, so a washed-out grade passes every number above and fails here; `judge.ask` answers a typed question on frames where one helps. For motion and sound, `export.video` a range with `mp4_h264_fast` and watch it.
7. The assistant should confirm the requested changes are present. Mark each acceptance item from the evidence just gathered, never from memory of having made the change.
8. The assistant should confirm nothing else moved: `timeline.diff {from, to}` between the starting timeline and the delivered one lists every clip, track and setting that differs. A change to something the user asked to keep (other scenes, other speakers, the source audio) is a failure.
9. The assistant should branch for a still image. For an image, skip the timeline checks and verify with `media.get` and `render.frames` at full size: crop and aspect for the stated placement; resolution adequate for that placement; no compression artifacts or banding in flat areas; no upscaling beyond source detail; text legible at final display size; colour consistent with the rest of the set.
10. The assistant should branch for music it made. Music from a score cannot be heard from here, so it is read back with measurements, and "I could not listen" is not a check. First, `score.render`'s `clipped_samples` has to be 0: samples over full scale are cut off in that file for good, so turning the render down afterwards on the timeline does not undo it; lower the parts (`score.set_part {gain_db}`) or put a `limiter` on the master, and render again. Then read the tune back: render the part that carries it alone (`score.render {parts}`), run `media.analyze {kind: "notes"}` on that media, and set its pitches and times against what was meant (the notes that were written, or the notes of what the user hummed or played). Where the music has to land on moments of the picture, `media.analyze {kind: "onsets"}` on the render says when its hits fall, to set against the times of those moments. `render.spectrogram` and `render.notes` show the same things as pictures. Under a voice, `media.analyze {kind: "transcript", timeline_id}` gives the words of the finished mix, which have to be the words of the voice alone, and `media.analyze {kind: "loudness"}` over a stretch with speech and a stretch without says how far under the voice the music sits.
11. The assistant should report the verdict with evidence. One line per acceptance item, yes or no, with the measurement or the frame that decided it, then the failures and the specific fix proposed for each. Ask before delivering anything with an open failure. Then `export.video`, and give the user the links.

## Decision table
| Situation | The assistant should |
|---|---|
| Every acceptance item is yes | Export and deliver, with the list attached. |
| A gap, offline media or a short frame count | Fix it, run `qa.check` again, then re-check the items it affected. |
| A word cut with real loss | Move the edge to the word boundary from the transcript, then `qa.check` with `speech` again. |
| Loudness or true peak off target | `audio.set_master`, then `qa.check` again. |
| A subjective miss in grade, framing or pacing | Show the frame or the cut, state the difference from the request, and propose one specific fix. |
| The request is ambiguous | Ask before editing. |
| A long timeline (`qa.check` returns a job) | `job.get {job_id, wait_seconds}` for the report. |
| The deliverable is a still image | Take step 9 in place of steps 2 to 6. |
| The work includes music made in a score | Take step 10 as well, before the report. |
| `clipped_samples` above 0 on a render | Lower the parts or limit the master, `score.render` again, and use the new media. |

## Required behavior
- The assistant writes the acceptance list before it looks at any output.
- Every item on that list resolves to yes or no, with the number, frame or quotation that decides it.
- The assistant fixes a failed item, or reports it to the user and asks. A known failure is never delivered silently.
- Where `qa.check` measures something, the assistant measures rather than judging by eye. Where nothing measures it (grade, framing, subject motion), the assistant renders frames and looks at them.

## Measured thresholds (reference)
Where a check has a published number, this is the number. Where sources conflict, the conflict is recorded rather than averaged: pick the one matching the delivery target and say which you picked.

| Check | Threshold | Source |
|---|---|---|
| Integrated loudness | -24 LKFS, +/-2 dB tolerance (broadcast); -14 LUFS typical for web/social | ATSC A/85 |
| True peak | below -2 dBTP, measured per BS.1770 (inter-sample, so sample-peak meters under-read) | ATSC A/85 |
| Head/tail black and silence | 1 s at head and tail | Netflix IMF |
| Commercial blacks | not permitted | Netflix IMF |
| Black-frame detection | three parameters, not one threshold: region + frame count + level | Tektronix |
| FFmpeg blackdetect | minimum duration default 2.0 s, picture-black ratio default 0.98, pixel threshold default 0.10 | FFmpeg docs |
| DCP container | 3996x2160 or 4096x1716; reels <=22 min; begin and end on black; 24 fps Interop | Netflix DCP |
| DCP bitrate | JPEG 2000 <=250 MB/s (500 for HDR/HFR) | Netflix DCP |
| IMF bitrate | 800 Mbit/s at <=30 fps UHD | Netflix IMF |
| Variable frame rate | rejected; telecine rejected; no upscaling; exact A/V duration match | Prime Video |
| Ad blacks | <=1-2 s | Prime Video |
| Chroma subsampling | conflicting published answers: IMF 4:4:4 (RGB full range), DPP AS-11 4:2:2, YouTube 4:2:0 | three standards |

## Not verified and must not be asserted as fact
EBU Tech 3363 test definitions, blockiness numeric threshold, freeze-frame default duration, dropped/duplicate-frame tolerance, flash/PSE numeric criteria (Harding FPA named, no figure published), caption/subtitle conformance numbers, TikTok official specs, CapCut export specs, Premiere export numbers, VMAF threshold, still-image chroma subsampling and screen pixel density.
