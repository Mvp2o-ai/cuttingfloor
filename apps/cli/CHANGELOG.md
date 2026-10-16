# cuttingfloor

## 0.8.0

### Minor Changes

- 89716cb: Analysis: `media.analyze` finds what is in imported media, as data for edits. `transcript` gives every word with its time (whisper.cpp on the CPU, models tiny/base/small downloaded once and checksummed), `beats` gives tempo, beat and downbeat times, `faces` gives face boxes over time and a smoothed focus point for reframing, and `track` follows a region you give. Results stay with the media (`media.get` with `include`). Transcripts drive edits: `clip.add {source: {words: [i, j]}}` cuts a clip to a range of words, and `caption.add {from_transcript: {clip_id}}` captions a clip from its transcript, timed where its words play (speed changes included).

## 0.7.0

### Minor Changes

- 7ca8a2c: Effects: `filter.add`, `filter.set` and `filter.remove` put registry effects on a clip, every clip on a track, or the whole timeline, and `adjustment.add` adds a clip whose effects change everything below it while it runs. 21 video effects (brightness and contrast, saturation, exposure, temperature, hue, vibrance, curves, LUTs, grayscale, sepia, invert, blur, sharpen, vignette, grain, chromatic aberration, pixelate, glitch, denoise, chroma key) and 12 audio effects (EQ, compressor, noise reduction, de-esser, dialogue enhance, reverb, echo, pitch, high-pass, low-pass, telephone), with their params at `video://catalog/effects`; number params take keyframes. `.cube` LUTs import with `media.import`. `timeline.load` now keeps numbering ids after transitions and effects in the loaded timeline.

## 0.6.0

### Minor Changes

- 45b0065: Audio tools: `audio.set_gain` (dB, with keyframes for rides), `audio.set_pan`, `audio.fade`, `audio.duck` (lowers a music track wherever the other audio tracks have sound, as gain keyframes on its clips), `audio.set_master` (master gain and limiter) and `audio.set_loudness` (measures the mix and sets the master to a loudness target, -14 LUFS by default, with peaks under the true-peak ceiling). Audio edits preview as a waveform image with the measured loudness, also readable at `video://timeline/{id}/waveform/{start}_{end}.webp`.

## 0.5.0

### Minor Changes

- 6cd2dbe: Titles and captions: `title.add`, `caption.add` (from segments with word timings, or from SRT/VTT, including WebVTT word timestamps) and `text.set` to retext or restyle many at once. Text renders with libass over the picture: fonts, size, colour, outline, soft shadow, box, karaoke/fill/word/pop highlights driven by word timings, and typewriter and word reveals. Titles and captions are clips, so transforms, masks, animations and transitions apply. A curated set of free fonts ships in the image (`video://catalog/fonts`), and `.ttf`/`.otf` files import with `media.import` for use through `font_media_id`.

## 0.4.0

### Minor Changes

- f60a602: Transitions: `transition.add`, `transition.set` and `transition.remove` at the cut between two touching clips. 19 kinds (dissolve, dip to black or white, wipes, slides, pushes, zoom in and out, iris, spin), listed at `video://catalog/transitions`; linked audio gets an equal-power crossfade at the same cut. By default the clips overlap by the transition's length and later clips move earlier; `mode: "handles"` uses source past the cut and moves nothing. An edit that breaks a transition removes it and says so in `warnings`.

## 0.3.0

### Minor Changes

- 34a6579: Timing tools: `clip.set_speed` (constant rate, speed-ramp curves and reverse, with pitch kept unless `preserve_pitch: false`), `clip.freeze`, `clip.roll`, `clip.slip`, `clip.slide`, `clip.replace`, and `range.lift` / `range.extract` to cut a span out of every track at once. Nested timelines: `clip.add {nested_timeline_id}` puts a whole timeline in as one clip (a compound clip) that can be trimmed, moved, transformed and masked like any other, and is transparent where it is empty. Keyframes stay on their content through speed changes.

## 0.2.0

### Minor Changes

- 33dd088: Clip compositing for overlays and picture-in-picture: `clip.set_transform` (position, scale, rotation, opacity, crop, flip and fit, each number animatable with keyframes and 34 eases), `clip.set_mask` (rectangle with rounded corners, ellipse, linear, mirror, heart, star and polygon, with feather and invert), `clip.set_blend` (13 blend modes) and `clip.set_animation` (entrance, exit and loop presets). Accepted names are resources at `video://catalog/{name}`. Pictures with an alpha channel keep it through conform and previews. Timeline documents are now version 2; `timeline.load` still accepts version 1 JSON.

## 0.1.0

### Minor Changes

- 5a66d33: Phase 1 editor: media import with conform and proxies, immutable timelines with clip editing and `edit.batch`, image previews on every edit, `render.frames`, exact `qa.check`, H.264 and ProRes export with signed downloads, and long-running work as MCP Tasks or `job.*`.
