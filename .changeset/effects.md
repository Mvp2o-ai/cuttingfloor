---
"cuttingfloor": minor
---

Effects: `filter.add`, `filter.set` and `filter.remove` put registry effects on a clip, every clip on a track, or the whole timeline, and `adjustment.add` adds a clip whose effects change everything below it while it runs. 21 video effects (brightness and contrast, saturation, exposure, temperature, hue, vibrance, curves, LUTs, grayscale, sepia, invert, blur, sharpen, vignette, grain, chromatic aberration, pixelate, glitch, denoise, chroma key) and 12 audio effects (EQ, compressor, noise reduction, de-esser, dialogue enhance, reverb, echo, pitch, high-pass, low-pass, telephone), with their params at `video://catalog/effects`; number params take keyframes. `.cube` LUTs import with `media.import`. `timeline.load` now keeps numbering ids after transitions and effects in the loaded timeline.
