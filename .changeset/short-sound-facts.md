---
'cuttingfloor': minor
---

media.get gives `sound_seconds` (how long the sound runs), so a sound track that stops before the picture (under `duration_seconds`) shows as a fact. media.analyze silence counts the soundless end as silence and says where the sound stops (`sound_ends`); before, it reported no silence at all where the track simply ended.
