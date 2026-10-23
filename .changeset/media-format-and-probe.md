---
"cuttingfloor": minor
---

Media is kept under the extension its format takes, read from the file (a PNG sent as .svg, or downloaded with no extension, is kept and downloaded as .png). Every media result gives `extension` and `mime_type`, and `media.get` gives `probe`: everything FFprobe read, the format and every stream as it gives them.
