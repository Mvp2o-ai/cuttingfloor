---
"cuttingfloor": patch
---

Watch-page and download links from a finished job work again when the job is read later: `job.get`, `job.list`, `tasks/get` and the job resource sign them afresh instead of handing back the links the job was made with, which stopped working a day after it finished while its file lived on. An expired link now says so and where to get a fresh one.
