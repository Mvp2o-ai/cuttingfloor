---
'cuttingfloor': minor
---

Sounds, heard on the CPU with no provider. `media.analyze {kind: "sounds"}` says when each of 447 named sounds (laughter, applause, cough, sneeze, music, speech, door…) can be heard, every 40 ms, at the cut-off the assistant gives; the names are in `video://catalog/sounds`. `media.listen` finds sounds described in plain words ("people laughing", "a door slams") and returns the stretches where each is heard, with every score. `create.stems` separates the sound of any media into vocals, drums, bass, other and no_vocals, each new audio media. Models: PretrainedSED frame_mn10, FlexSED with the CLAP text encoder, and Demucs v4, all MIT or Apache-2.0, exported to ONNX in the image.
