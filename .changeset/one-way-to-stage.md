---
'cuttingfloor': minor
---

One way to stage a file: media.upload. media.import no longer takes `{upload}` (it made a second staging link and imported on arrival); it ingests a staged file by its upload_id. The media.upload and media.import descriptions and the upload error hints now state what each does in plain facts, with no commands.
