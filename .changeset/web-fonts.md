---
'cuttingfloor': patch
---

.woff and .woff2 fonts import: they are unpacked on import to the .ttf or .otf they hold and used as that (kind font, with its family), so font_media_id sets text in them. Before, they failed as "not a readable media file".
