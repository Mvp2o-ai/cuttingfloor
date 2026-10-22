---
'cuttingfloor': minor
---

`job.get` answers at once with where a job stands; its `wait_seconds` hold is gone, and the hints no longer tell the assistant to wait 50 seconds. When to check again is the assistant's call. Clients that still send `wait_seconds` are unaffected: it is ignored.
