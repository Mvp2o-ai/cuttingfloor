---
"cuttingfloor": patch
---

`create.cutout` runs in its own slot, one at a time by default (`CUTTINGFLOOR_HEAVY_JOBS`), at a lower CPU priority. A voiceover, import or export no longer waits minutes behind cut-outs, and a queued cut-out says what it waits for.
