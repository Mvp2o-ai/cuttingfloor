---
name: how-to-qa-a-video-or-image-edit-before-delivery
description: QA an edit before delivery with cuttingfloor. Check the finished cut against the request in the user's own words: write the acceptance list first, measure the technical envelope, frame integrity, speech at every cut, loudness against the delivery target, captions and on-screen text, then look at rendered frames; for a still image check crop and aspect, resolution, artifacts, upscaling, text legibility and colour. Use when someone asks to QA, check, review or sign off an edit before it goes out, to confirm a delivery is finished, to verify a render matches what was asked, or to find what is wrong with a cut before sending it.
version: 1
type: playbook
source: system
author: Ken Wiltshire
related: cut-pauses-ums-and-restarts:related, pan-and-scan:related
---

# How to QA an edit before delivery

An edit is finished when the assistant has checked it against the request and can show the evidence. A render that plays is not a check.

## When to use
- An edit is about to be delivered, exported or sent, and it has to be checked against what the user asked for.
- Someone asks to QA, check, review, verify or sign off a video or a still image, to confirm a delivery is finished, or to find what is wrong with a cut before it goes out.
- A delivery has to show its evidence: the number, frame or quotation that decided each item on the list.

## Prerequisites
- The user's request, in their own words, available to re-read.
- The timeline or project handle for the edit.
- The editing system's measurement and quality-check tools, discovered fresh with a tool search, because names and parameters change and are not to be assumed.

## Steps
1. The assistant should write the acceptance list first. Re-read the user's request and write one yes/no claim per thing they asked for, in their own words rather than a summary of intent. A request to tighten a piece becomes a claim about duration; a request to make it pop becomes a claim about the grade and the cuts. Where the request is ambiguous, ask before editing, not after.
2. The assistant should measure the technical envelope. Discover the editing system's current measurement tools and run the quality check on the timeline. Read gaps in the picture, offline media, rendered against expected frame count, integrated loudness in LUFS and true peak in dBTP. A gap, an offline clip or a truncated render is a hard failure, because a truncated render is silent or frozen at the end and playback hides it.
3. The assistant should check frame integrity. Confirm the rendered frame count matches the timeline duration at the sequence frame rate, and that no clip plays past the frames its source actually holds.
4. The assistant should check speech at every cut. Read the speech facts at each junction: the speech probability either side, the seconds without speech, and the word a clip edge cuts through where one exists. A cut through a word with real loss is a failure unless the request asked for it. Use the measured word-boundary procedure rather than nudging by ear.
5. The assistant should check the audio level. Compare integrated loudness and true peak against the delivery target, taken from the loudness target procedure rather than chosen at the moment.
6. The assistant should check captions and on-screen text. Confirm captions exist where they were asked for, are in sync at the head, middle and tail of the piece, and are neither cut off nor overflowing their line. Titles and overlays are checked the same way.
7. The assistant should look at the picture. Render frames from the head, middle and tail of each section and judge them against the acceptance list: framing, headroom, grade, skin tone, sharpness, safe area and aspect. The machine check does not measure luma or saturation, so a washed-out grade passes every number above and fails here.
8. The assistant should confirm the requested changes are present. Mark each acceptance item from the evidence just gathered, never from memory of having made the change.
9. The assistant should confirm nothing else moved. Compare the delivered cut against what the user asked to keep untouched, including other scenes, other speakers and the source audio. An unrequested change is reported as a failure.
10. The assistant should branch for a still image. For an image, skip the timeline checks and verify: crop and aspect for the stated placement; resolution adequate for that placement; absence of compression artifacts or banding in flat areas; no upscaling beyond source detail; legibility of text at final display size; colour consistent with the rest of the set.
11. The assistant should report the verdict with evidence. One line per acceptance item, yes or no, with the measurement or the frame that decided it, then the failures and the specific fix proposed for each. Ask before delivering anything with an open failure.

## Decision table
| Situation | The assistant should |
|---|---|
| Every acceptance item is yes | Deliver, with the list attached. |
| A technical failure | Fix it, re-run the measurement, then re-check the items it affected. |
| A subjective miss in grade, framing or pacing | Show the frame or the cut, state the difference from the request, and propose one specific fix. |
| The request is ambiguous | Ask before editing. |
| A measurement tool is unavailable | Say which check could not be measured, and judge from rendered frames instead. |
| The deliverable is a still image | Take step 10 in place of steps 2 to 7. |

## Required behavior
- The assistant writes the acceptance list before it looks at any output.
- Every item on that list resolves to yes or no, with the number, frame or quotation that decides it.
- The assistant fixes a failed item, or reports it to the user and asks. A known failure is never delivered silently.
- Where a tool can measure something, the assistant measures rather than judging by eye. Where no tool exists — grade, framing, subject motion — the assistant renders frames and looks at them.

## Measured thresholds (reference)
Where a check has a published number, this is the number. Where sources conflict, the conflict is recorded rather than averaged — pick the one matching the delivery target and say which you picked.

| Check | Threshold | Source |
|---|---|---|
| Integrated loudness | -24 LKFS, +/-2 dB tolerance (broadcast); -14 LUFS typical for web/social | ATSC A/85 |
| True peak | below -2 dBTP, measured per BS.1770 (inter-sample, so sample-peak meters under-read) | ATSC A/85 |
| Head/tail black and silence | 1 s at head and tail | Netflix IMF |
| Commercial blacks | not permitted | Netflix IMF |
| Black-frame detection | three parameters, not one threshold: region + frame count + level | Tektronix |
| FFmpeg blackdetect | minimum duration default 2.0 s, picture-black ratio default 0.98 | FFmpeg docs |
| DCP container | 3996x2160 or 4096x1716; reels <=22 min; begin and end on black; 24 fps Interop | Netflix DCP |
| DCP bitrate | JPEG 2000 <=250 MB/s (500 for HDR/HFR) | Netflix DCP |
| IMF bitrate | 800 Mbit/s at <=30 fps UHD | Netflix IMF |
| Variable frame rate | rejected; telecine rejected; no upscaling; exact A/V duration match | Prime Video |
| Ad blacks | <=1-2 s | Prime Video |
| Chroma subsampling | conflicting published answers: IMF 4:4:4 (RGB full range), DPP AS-11 4:2:2, YouTube 4:2:0 | three standards |

## Not verified and must not be asserted as fact
EBU Tech 3363 test definitions (page and PDF both 404), blockiness numeric threshold, freeze-frame default duration, dropped/duplicate-frame tolerance, flash/PSE numeric criteria (Harding FPA named, no figure published), caption/subtitle conformance numbers, TikTok official specs, CapCut export specs, Premiere export numbers, VMAF threshold, still-image chroma subsampling and screen pixel density.

## Vendor findings
None of CapCut, Descript, DaVinci Resolve or Premiere Pro publishes a pre-publish QA checklist. Descript ships presets only, with no advanced bitrate or resolution options and no upscaling. CapCut publishes no official export-quality or QA documentation; only third-party guides exist. DaVinci Resolve's tech specs publish interface formats, not export thresholds. Premiere Pro's export-settings page returned navigation text only; the sole verified Adobe figure is Photoshop's 300 ppi print standard.

## Why this exists
The failure mode is delivering what you think you delivered. Nothing above depends on taste or seniority: every check resolves to a number, a frame, or a published spec, and the assistant either has the evidence or says it does not.
