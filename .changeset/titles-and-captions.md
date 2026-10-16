---
"cuttingfloor": minor
---

Titles and captions: `title.add`, `caption.add` (from segments with word timings, or from SRT/VTT, including WebVTT word timestamps) and `text.set` to retext or restyle many at once. Text renders with libass over the picture: fonts, size, colour, outline, soft shadow, box, karaoke/fill/word/pop highlights driven by word timings, and typewriter and word reveals. Titles and captions are clips, so transforms, masks, animations and transitions apply. A curated set of free fonts ships in the image (`video://catalog/fonts`), and `.ttf`/`.otf` files import with `media.import` for use through `font_media_id`.
