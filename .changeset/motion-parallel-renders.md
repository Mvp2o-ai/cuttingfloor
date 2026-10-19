---
"cuttingfloor": patch
---

Parallel `create.motion` renders on the hosted server no longer fail with `server_busy`. The sandbox's process limit counted gVisor's own host threads, so three browsers at 1080x1920 crossed it and the whole sandbox crashed, failing every job in it. The cap now sits inside the sandbox, where a runaway script fails only its own job. A job waiting its turn hears its place in line every 20 seconds, so a long wait behind other renders no longer drops it after five minutes.
