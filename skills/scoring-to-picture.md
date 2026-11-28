---
name: scoring-to-picture
description: Scoring to picture with cuttingfloor's score tools - music made for a cut, so its beats, build, drop-out and biggest hit land on the picture's moments, built in layers, and seeded from a tune the user hums or taps or a sound they send. Use when someone wants music made for a video and has no song (a highlight reel, montage, promo, trailer, recap), wants the music to hit, build or drop on a moment, or offers to hum, tap or send a sound to build from.
version: 1
type: playbook
source: system
author: Ken Wiltshire
related: nat-pops:related, make-a-highlight-reel:related
---

# Scoring to picture

The picture decides the music: its cuts, its climax and its length are known first, and the music is written to land on them.

## When to use
- Music is to be made for a video, not taken from a song the user has.

## Prerequisites
- The cuttingfloor MCP server is connected.
- The cut planned: the frames of the cuts, the climax and the last frame.

## Steps
1. The assistant should list what the music has to serve, in frames: the cuts that sit on beats, the climax (the one moment the biggest hit lands on), a drop-out just before it, the places a voice will be heard, and the last frame.
2. The assistant should ask the user, once and alongside its other questions, for what only they have: the feel in their words, and whether there is a tune or sound to build from. It offers to record them humming or tapping one over a loop (`score.record`), or to take a sound file (a chant, a product sound, a voice tag). With no answer it chooses, and the choice stays changeable.
3. The assistant should choose a tempo near the feel at which one beat is a whole number of frames: at 24 fps, 144 bpm is 10 frames, 120 is 12 and 96 is 15; at 30 fps, 150 bpm is 12, 120 is 15 and 100 is 18. Every beat then falls on a frame, and the climax is placed on a downbeat.
4. The assistant should shape the sections before writing notes: thin at the start, a build that adds parts and density toward the climax, one beat or bar of near-silence right before it, the hit with everything at once and the low end at its strongest, then an ending that resolves on the last frame (a final chord or ring-out, not a cut-off). It thins the middle range where a voice will be heard.
5. The assistant should build in layers, one part per role: a pulse (drums), the low end, harmony (pads or stabs), a motif, and hits or risers for the climax. The user's hummed tune becomes the motif, written as notes on an instrument so the music stays instrumental; their taps become a part's rhythm; their sound becomes a sampler part (a hit on the climax, a chopped motif, a tag at the end). The build comes from adding parts over time, not from turning one part up.
6. The assistant should render and check by measurement, since nobody can hear it: the notes drawn beside the spectrogram, the strongest onset at the climax frame, no sub-bass so low it crushes the limiter, and peaks under the ceiling. It checks the climax again on the export once the voice is mixed in.
7. The assistant should make every later change ("darker", "less busy", "more bass") to the same score's parts and devices, and say what changed, never by replacing the track.

## Decision table
| Situation | Do |
|---|---|
| The user has a song | Not this skill: cut to the song's beats, with its drop on the climax |
| No clear climax in the picture | The biggest hit on the last frame; the build runs the whole length |
| Under 15 seconds | One build and one hit, no drop-out |
| Talk-heavy footage | Sparse: pulse and pad, no lead under the voice |
| A hum that drifts in pitch | The nearest pitches as notes, played back to the user before building on them |
| The cut changes after the music is made | Move or trim regions of the same score to the new frames; keep the hit on the climax |

## Required behavior
- The tempo comes from the frame rate, so beats fall on frames.
- The biggest hit lands on the climax frame, checked on the export.
- The music is instrumental: no singing, no lyrics, nothing in a named artist's style.
- Changes edit the same score, so every part stays changeable.
