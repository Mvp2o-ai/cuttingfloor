---
"cuttingfloor": minor
---

`media.delete` removes a media for good (its file, proxy, mezzanine and analyses), giving its room back to the storage cap. Timelines that used it keep their ids but no longer render, failing with `media_offline` that names it, as for expired media; cached previews of them are refused too.
