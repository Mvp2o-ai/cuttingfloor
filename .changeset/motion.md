---
"cuttingfloor": minor
---

Create new media: `create.motion` renders animated HTML (HyperFrames with GSAP) to a video with alpha, `create.still` renders an HTML page to a PNG, and `create.matte` makes a solid or gradient picture. Each is a job that returns a `media_id`, and the same recipe returns the same media. HTML runs only in the new `motion` compose service: a sandbox with no route out, no data volume, no capabilities, a read-only filesystem and fixed limits, with Chromium's own sandbox on (seccomp profile in `tools/motion/seccomp.json`). The image now includes Chromium.
