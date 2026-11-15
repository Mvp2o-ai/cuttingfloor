---
"cuttingfloor": minor
---

Long-running tools always answer with a job: `job_id` and `status` are always there. A job already done when the call answers (the same recipe, file or idempotency key again) comes back completed with its result in `result`, instead of the bare result with no `job_id`. Code that polls `job.get` with the returned `job_id` no longer gets a null id. `media.import` with `{upload}` still answers with the media and its upload URL, since its job starts with the PUT.
