---
"cuttingfloor": minor
---

**`voice_denoise`: clean background noise out of speech.** A new audio effect runs RNNoise (FFmpeg `arnndn`) over an audio clip's source: fans, hum, traffic, keyboards and room noise go, the voice stays (`keep: "voice"` keeps laughs and breaths, `"speech"` words only; `mix` blends the original back). It goes on audio clips, not tracks or the timeline: the first render that plays the clip cleans its whole source once and reuses that after. The models ship in the image, pinned by SHA-256.
