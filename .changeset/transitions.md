---
"cuttingfloor": minor
---

Transitions: `transition.add`, `transition.set` and `transition.remove` at the cut between two touching clips. 19 kinds (dissolve, dip to black or white, wipes, slides, pushes, zoom in and out, iris, spin), listed at `video://catalog/transitions`; linked audio gets an equal-power crossfade at the same cut. By default the clips overlap by the transition's length and later clips move earlier; `mode: "handles"` uses source past the cut and moves nothing. An edit that breaks a transition removes it and says so in `warnings`.
