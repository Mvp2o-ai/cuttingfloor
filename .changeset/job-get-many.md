---
'cuttingfloor': minor
---

`job.get` reads many jobs in one call: `{job_ids: [...]}` (up to 100) answers `{jobs, not_found}`, so an assistant following several imports or renders checks them all at once. `{job_id}` still answers that one job, as before.
