---
"cuttingfloor": minor
---

`create.lipsync`: make someone on camera say new words. Give the video, the new speech and the span to change; sync. labs redraws the mouth on your own key (`SYNC_API_KEY` locally, the `X-Cuttingfloor-Key-Sync` header hosted). Only the span is sent, the result imports as new media, and the provider's limits come back as facts in errors. Hosted servers now read provider keys from `X-Cuttingfloor-Key-<Provider>` request headers, never storing them.
