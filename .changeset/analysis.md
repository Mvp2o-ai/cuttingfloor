---
"cuttingfloor": minor
---

Analysis: `media.analyze` finds what is in imported media, as data for edits. `transcript` gives every word with its time (whisper.cpp on the CPU, models tiny/base/small downloaded once and checksummed), `beats` gives tempo, beat and downbeat times, `faces` gives face boxes over time and a smoothed focus point for reframing, and `track` follows a region you give. Results stay with the media (`media.get` with `include`). Transcripts drive edits: `clip.add {source: {words: [i, j]}}` cuts a clip to a range of words, and `caption.add {from_transcript: {clip_id}}` captions a clip from its transcript, timed where its words play (speed changes included).
