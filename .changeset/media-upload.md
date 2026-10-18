---
"cuttingfloor": minor
---

Uploads: `media.upload {name, bytes?}` gives a signed URL to PUT one of the user's files to, so a hosted server can take files it can't read from a path. Uploads resume (HEAD for `Upload-Offset`, then `Content-Range` from there), take browsers (CORS), are capped at `CUTTINGFLOOR_MAX_DOWNLOAD_BYTES` and kept a day; `media.import {source: {upload_id}}` moves the file into the media.
