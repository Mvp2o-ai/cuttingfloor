---
'cuttingfloor': minor
---

`media.get` reads long analyses in pieces: with `include`, `from_seconds` and `to_seconds` keep what overlaps that stretch of the media (transcript words, beats, face and look frames), `offset` and `limit` page through it, and `pages` says where each piece sits in the whole list (for transcript words, the index `clip.add source {words}` takes) and where the next page starts. A `media.analyze` result too long to return now says how to page it.
