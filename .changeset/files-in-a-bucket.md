---
'cuttingfloor': minor
---

Hosted can keep its files in an S3 bucket (`CUTTINGFLOOR_BLOBS=s3`): downloads and playback redirect to the bucket, uploads stream through the server into it and can be sent as numbered parts, several at once. The default (files on disk) is unchanged.
