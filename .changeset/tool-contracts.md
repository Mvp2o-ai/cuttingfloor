---
"cuttingfloor": minor
---

**Granular tools with full contracts.** Every tool declares its output schema, and the code.run SDK types every result. Tools no longer make choices for the agent:

- `audio.set_loudness` and `audio.duck` are gone: set the mix with `audio.set_master` and `audio.set_gain` keyframes, and read loudness from audio previews or `qa.check`.
- `qa.check` returns measurements (gaps, frame counts, loudness, true peak, and black or silent stretches with the settings you give), not pass or fail.
- `caption.add {in_clip}` places captions timed in a clip's source seconds, through speed changes; `from_transcript` is gone, so you group the words.
- `media.analyze` gains `silence` and `scenes`, with required settings; import no longer detects them.
- `faces` returns face boxes only.
- Tasks clients get tasks from long-running tools again.
