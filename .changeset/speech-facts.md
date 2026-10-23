---
"cuttingfloor": minor
---

Speech and sound facts. `media.analyze` gains `speech` (Silero VAD: speech probability every 32 ms, spans at your `min_probability`) and `loudness` (integrated LUFS, true peak, loudness range, RMS, noise floor), over a range. `speech`, `loudness` and `silence` also measure a timeline's mix (`timeline_id` plus a range, in timeline seconds). English transcript words are now aligned to the sound with wav2vec2 forced alignment (edges within about 0.05 s, with `timing_confidence` per word), so `clip.add {source: {words}}`, captions and voiceover words land on the speech. New `media.correlate` gives the sync offset of one recording against another, with its strength. `qa.check {speech}` lists every cut with the speech either side, the silence each side, and the transcript word each clip edge cuts through. A source or range with no sound fails with the new `no_audio` error naming it.
