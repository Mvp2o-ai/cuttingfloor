---
"cuttingfloor": minor
---

`create.voiceover` speaks English text in one of 28 natural voices (Kokoro via sherpa-onnx, on the CPU; the model downloads once) and times every word, so `caption.add {from_transcript}` captions it exactly. `create.cutout` removes the background behind people in a video or picture (MODNet), giving ProRes 4444 with alpha and the original sound, or a PNG.
