---
'cuttingfloor': patch
---

create.motion and create.still seed `crypto.getRandomValues` (and `crypto.randomUUID` where the page has it) from the same seed as `Math.random`, so a page that draws its randomness from crypto renders the same every time.
