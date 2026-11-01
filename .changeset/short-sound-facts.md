---
'cuttingfloor': minor
---

media.get gives `stream_seconds` (how long the picture and the sound each run), so a sound track that stops before the picture shows as a fact. media.analyze silence counts the soundless end as silence and says where the sound stops (`sound_ends`); before, it reported no silence at all where the track simply ended.
