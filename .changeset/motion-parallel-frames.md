---
'cuttingfloor': minor
---

`create.motion` renders frames in several browsers at once, about one per two CPUs (`CUTTINGFLOOR_MOTION_WORKERS` to set it). Every browser steps through every frame, so output is frame-identical to a single browser; a 5-second graphic renders 1.6–2× faster on six CPUs. The sandbox now gets 4 CPUs locally and 6 CPUs and 6 GB on the hosted server.
