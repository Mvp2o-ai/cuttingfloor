---
'cuttingfloor': minor
---

**Overlap transitions keep other tracks in sync on request.** An overlap transition moves later clips on its own track earlier. `transition.add` now warns which clips on other tracks are left playing late, and `other_tracks: "extract"` takes the same span out of the other tracks (like `range.extract`) so titles, overlays and sound stay in sync with the picture.
