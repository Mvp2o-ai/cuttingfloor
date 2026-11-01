---
'cuttingfloor': patch
---

Frame renders no longer fail on a busy server with "melt rendered 0 of 1 frames" (or hang until the render times out). The cause was a race in MLT 7.30's avformat consumer, which started its encoder thread before marking itself running; the image now carries MLT's avformat module rebuilt from the same release with that fixed.
