---
"cuttingfloor": minor
---

The hosted server renders motion graphics and stills in a fresh sandbox for every render, up to 5 at once on its 8 cores, instead of one shared sandbox rendering one at a time for everyone. A render that crashes its sandbox fails only itself, and nothing one render leaves behind reaches the next. A new `cuttingfloor motion-launcher` starts each gVisor sandbox and removes it after, sized from the machine's cores and memory. Exports, imports and analysis run 5 at once (was 3).
