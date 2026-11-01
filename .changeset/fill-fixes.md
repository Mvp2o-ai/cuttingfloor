---
"cuttingfloor": patch
---

Fill fixes. A fill is now a job of its own, shown in job.list with its progress per frame; an export waits for it without being ended as stalled, and a render that needs it names the job. render.frames no longer waits on fills of clips that are not at its frames. A filled item no longer shows through as a ghost: a fill paints over the whole selection, its soft edge included, and grows a little past it. A mask takes several shapes (add), so two regions are shown, hidden or filled in one pass. Refusals of a fill on a nested clip say why.
