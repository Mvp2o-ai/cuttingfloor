---
"cuttingfloor": minor
---

Export: `export.video` adds the `social_9x16_h264`, `web_1080p_av1`, `gif`, `audio_wav_48k` and `audio_mp3` presets and `overrides` for size, frame rate, bitrate and quality (`video://catalog/presets`). `export.timeline` writes the edit as FCPXML, OTIO or a CMX 3600 EDL, or the captions as SRT or VTT, listing what each format can't carry; `media: "collect"` zips the media alongside. `render.frames {size: "full"}` renders up to four frames at full size from the original media.
