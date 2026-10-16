---
"cuttingfloor": minor
---

Audio tools: `audio.set_gain` (dB, with keyframes for rides), `audio.set_pan`, `audio.fade`, `audio.duck` (lowers a music track wherever the other audio tracks have sound, as gain keyframes on its clips), `audio.set_master` (master gain and limiter) and `audio.set_loudness` (measures the mix and sets the master to a loudness target, -14 LUFS by default, with peaks under the true-peak ceiling). Audio edits preview as a waveform image with the measured loudness, also readable at `video://timeline/{id}/waveform/{start}_{end}.webp`.
