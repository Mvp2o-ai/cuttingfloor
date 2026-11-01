---
'cuttingfloor': patch
---

media_not_ready errors name the job making the media (the media.import job, or the create.* job that makes it) with its job_id, in the message, the hint and the detail, so the caller waits on the right job with job.get. Before, media made by create.motion was said to wait for "its media.import job".
