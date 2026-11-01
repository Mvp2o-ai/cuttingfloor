---
'cuttingfloor': minor
---

clip.replace now swaps the clip's linked clips too (its sound, or its picture) onto the new media, keeping their offset, so a replaced shot's sound no longer stays on the old file. Default change: pass `linked: false` to swap only the clip named. When the new media lacks that kind (no sound), the linked clip stays and a warning says so; `clip_ids` lists every clip swapped.
