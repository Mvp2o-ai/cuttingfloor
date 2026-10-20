---
"cuttingfloor": patch
---

A job cancelled from another server always stops: the running server's own heartbeat could write over the cancel and keep it running.
