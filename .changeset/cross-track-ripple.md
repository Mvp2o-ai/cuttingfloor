---
"cuttingfloor": minor
---

**Rippling edits keep other tracks in sync on request.** `clip.trim` and `clip.remove` with ripple, `clip.move`, `clip.add` with `mode: "insert"`, `clip.set_speed` and `clip.freeze` moved later clips on the clip's own tracks only, leaving titles, overlays and sound on other tracks early or late with no word. Their results now warn which clips on other tracks no longer line up, and `other_tracks: "sync"` gives the other unlocked tracks the same change: time taken out comes out of them too (like `range.extract`), time added opens the same gap. `range.extract` on named tracks warns about the rest.
