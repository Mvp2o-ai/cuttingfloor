---
'cuttingfloor': minor
---

`media.import {source: {upload: {name, bytes}}}` hands back the new media with a signed `upload.url`: PUT the file there (resumable, like `media.upload`) and it imports as soon as the last byte arrives, so a file made elsewhere reaches the server in one call and a PUT, with no base64 in a message. The PUT's answer carries the `media_id` and `job_id`. Size limits and storage caps apply as for any upload.
